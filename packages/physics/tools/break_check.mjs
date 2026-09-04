#!/usr/bin/env node
/**
 * The break-check protocol (REQUIREMENTS §4.3).
 *
 *   "A passing suite proves nothing until each test is confirmed able to fail."
 *
 * This deliberately corrupts the model, one mutation at a time, and records which
 * tests go red. A test that stays green through a mutation it should have caught is
 * aimed at the wrong thing and reports clean forever.
 *
 * ## How it works
 *
 * Each mutation is a surgical text edit to a source file. For every one: apply it,
 * run the whole suite, record which files failed, revert. The working tree is
 * restored before and after, and the script refuses to start if the tree is dirty —
 * a crash mid-run must not be able to leave a corrupted model behind.
 *
 * Run:  node tools/break_check.mjs [--json]
 *
 * Output is a table of mutation vs. which suites caught it, plus a verdict on
 * whether anything went undetected. Results are written up in docs/BREAK_CHECK.md.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '../..')

/**
 * The mutations.
 *
 * Each names the physical thing it breaks and which suites should notice. `expect`
 * is the claim being tested; if reality disagrees, that is the finding.
 */
const MUTATIONS = [
  {
    id: 'invert-lift',
    description: 'Invert the sign of the normal-force (lift) coefficient table',
    rationale:
      'The most basic possible error. Lift now acts downward. If anything survives this, the suite is not testing the model at all.',
    file: 'src/tables/coefficients.ts',
    find: '  const base = interp1(CZ_TABLE, alphaIndex(alphaDeg))',
    replace: '  const base = -interp1(CZ_TABLE, alphaIndex(alphaDeg))',
    expect: ['goldenCoefficients', 'goldenDerivatives', 'trim', 'modes', 'energy'],
  },
  {
    id: 'zero-pitching-moment',
    description: 'Zero the pitching-moment table',
    rationale:
      'Removes all pitch stiffness. Trim becomes degenerate and the short-period mode ceases to exist. Directly named in REQUIREMENTS §4.3.',
    file: 'src/tables/coefficients.ts',
    find: '  return interp2(CM_TABLE, alphaIndex(alphaDeg), elevatorIndex(elDeg))',
    replace: '  return 0 * interp2(CM_TABLE, alphaIndex(alphaDeg), elevatorIndex(elDeg))',
    expect: ['goldenCoefficients', 'goldenDerivatives', 'trim', 'modes'],
  },
  {
    id: 'offset-cg',
    description: 'Offset the reference CG by 0.05 chord',
    rationale:
      'Named in REQUIREMENTS §4.3. Should shift trim and, more tellingly, change longitudinal stability — the CG-sweep assertions in modes.test.ts exist for this.',
    file: 'src/massProperties.ts',
    find: 'export const XCG_REF = 0.35',
    replace: 'export const XCG_REF = 0.40',
    expect: ['massProperties', 'modes'],
  },
  {
    id: 'kill-pitch-damping',
    description: 'Zero the pitch damping derivative (Cmq)',
    rationale:
      'The sharpest test of the modal analysis. Trim is a static condition and should barely notice; short-period damping should change dramatically. If trim catches this but modes does not, the modal test is measuring the wrong thing.',
    file: 'src/aero/buildup.ts',
    find: '  cmt += cq * (d[6] as number) + czt * dxcg',
    replace: '  cmt += 0 * cq * (d[6] as number) + czt * dxcg',
    expect: ['goldenDerivatives', 'modes'],
  },
  {
    id: 'kill-yaw-damping',
    description: 'Zero the yaw damping derivatives (Cnr, Cnp)',
    rationale:
      'Lateral counterpart. Dutch roll damping should collapse toward zero or go negative. Longitudinal tests should be untouched — if they fail too, the axes are coupled somewhere they should not be.',
    file: 'src/aero/buildup.ts',
    find: '    b2v * ((d[7] as number) * r + (d[8] as number) * p) -',
    replace: '    0 * b2v * ((d[7] as number) * r + (d[8] as number) * p) -',
    expect: ['goldenDerivatives', 'modes'],
  },
  {
    id: 'swap-damping-indices',
    description: 'Swap the pitch and yaw damping table indices (d[6] and d[7])',
    rationale:
      'The subtle one, and the reason this mutation is in the list: it is the exact mistake made and caught during development. Every value is a real number from a real table, just in the wrong place. No NaN, no obvious breakage.',
    file: 'src/aero/buildup.ts',
    find: '  cmt += cq * (d[6] as number) + czt * dxcg',
    replace: '  cmt += cq * (d[7] as number) + czt * dxcg',
    expect: ['goldenDerivatives', 'modes'],
  },
  {
    id: 'perturb-one-coefficient',
    description: 'Change one entry of the axial-force table by 10%',
    rationale:
      'The transcription-error simulation, and the entire justification for Tier A. One number out of 852, changed by an amount far below every Tier B tolerance. Tier A must catch it; Tier B almost certainly will not, and that is the point.',
    file: 'src/tables/data.ts',
    find: 'export const CX_TABLE = [\n  [-0.099,',
    replace: 'export const CX_TABLE = [\n  [-0.1089,',
    expect: ['goldenCoefficients'],
  },
  {
    id: 'break-alpha-index',
    description: 'Off-by-one in the alpha table index',
    rationale:
      'Interpolation indexing is where the fix/sign lookup scheme is most fragile. Shifts every alpha lookup by one node.',
    file: 'src/tables/lookup.ts',
    find: '  return { k: k + 2, l: l + 2, w: Math.abs(da) }',
    replace: '  return { k: k + 3, l: l + 3, w: Math.abs(da) }',
    expect: ['goldenCoefficients', 'goldenDerivatives'],
  },
  {
    id: 'wrong-gravity',
    description: 'Change gravity from 32.17 to 9.81 (metres mistaken for feet)',
    rationale:
      'A classic units error. Should be caught broadly — but worth confirming, because a model can be internally consistent in the wrong units and still trim.',
    file: 'src/units.ts',
    find: 'export const G_FT_S2 = 32.17',
    replace: 'export const G_FT_S2 = 9.81',
    expect: ['goldenDerivatives', 'trim', 'energy'],
  },
  {
    id: 'euler-integrator',
    description: 'Replace RK4 with forward Euler',
    rationale:
      'Tests whether the suite can tell integration quality apart from model quality. The fourth-order-accuracy check must fail; the energy test may, since forward Euler pumps energy into oscillatory systems.',
    file: 'src/integrator.ts',
    find: `  const k1 = quatDerivative(v, u, mass, opts).vd
  const k2 = quatDerivative(add(v, k1, dt / 2), u, mass, opts).vd
  const k3 = quatDerivative(add(v, k2, dt / 2), u, mass, opts).vd
  const k4 = quatDerivative(add(v, k3, dt), u, mass, opts).vd`,
    replace: `  const k1 = quatDerivative(v, u, mass, opts).vd
  const k2 = k1
  const k3 = k1
  const k4 = k1`,
    expect: ['quaternion'],
  },
  {
    id: 'skip-quaternion-normalize',
    description: 'Stop renormalizing the quaternion each step',
    rationale:
      'Drift accumulates silently and eventually the quaternion no longer represents a rotation. Slow enough that a short test would miss it — checking whether the long-run test is actually long enough.',
    file: 'src/integrator.ts',
    find: '  renormalizeQuat(out)\n  return out',
    replace: '  return out',
    expect: ['quaternion'],
  },
  {
    id: 'disable-envelope-guard',
    description: 'Make the envelope guard a no-op',
    rationale:
      'Confirms the departure tests genuinely depend on the guard rather than passing for unrelated reasons.',
    file: 'src/envelope.ts',
    find: '  const a = clamp(alphaDeg, ALPHA_MIN_DEG, ALPHA_MAX_DEG)\n  const b = clamp(betaDeg, -BETA_LIMIT_DEG, BETA_LIMIT_DEG)',
    replace: '  const a = alphaDeg\n  const b = betaDeg',
    expect: ['boundary'],
  },
]

const SUITES = [
  'massProperties', 'atmosphere', 'goldenCoefficients', 'goldenEngine',
  'goldenDerivatives', 'quaternion', 'trim', 'modes', 'boundary', 'energy',
]

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
}

function assertCleanTree() {
  const status = git('status', '--porcelain', '--', 'packages/physics/src')
  if (status) {
    console.error('Refusing to run: packages/physics/src has uncommitted changes.')
    console.error('The break-check rewrites source files and reverts them afterwards;')
    console.error('running it on a dirty tree risks losing work.\n')
    console.error(status)
    process.exit(1)
  }
}

/** Run the suite; return the set of test files that failed. */
function runSuite() {
  const res = spawnSync('npx', ['vitest', 'run', '--reporter=json', '--outputFile=/dev/stdout'], {
    cwd: PKG,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  const out = `${res.stdout || ''}`
  const start = out.indexOf('{')
  if (start === -1) return { failed: new Set(SUITES), parseError: true }

  let report
  try {
    report = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1))
  } catch {
    // A compile error takes the whole run down; treat that as everything failing.
    return { failed: new Set(SUITES), parseError: true }
  }

  const failed = new Set()
  for (const suite of report.testResults ?? []) {
    const name = (suite.name ?? '').split('/').pop().replace('.test.ts', '')
    const bad =
      suite.status === 'failed' ||
      (suite.assertionResults ?? []).some((a) => a.status === 'failed')
    if (bad) failed.add(name)
  }

  return { failed, parseError: false }
}

function applyMutation(m) {
  const path = resolve(PKG, m.file)
  const original = readFileSync(path, 'utf8')

  if (!original.includes(m.find)) {
    throw new Error(
      `mutation "${m.id}": anchor not found in ${m.file}.\n` +
        `The source has changed since this mutation was written. Update it — a ` +
        `mutation that silently fails to apply reports a false clean bill of health.`,
    )
  }

  writeFileSync(path, original.replace(m.find, m.replace))
  return () => writeFileSync(path, original)
}

async function main() {
  const asJson = process.argv.includes('--json')

  assertCleanTree()

  console.error('Baseline: running the suite unmutated...')
  const baseline = runSuite()
  if (baseline.failed.size > 0) {
    console.error(`\nBaseline is not green: ${[...baseline.failed].join(', ')}`)
    console.error('Fix the suite before running the break-check — otherwise there is')
    console.error('no way to attribute a failure to a mutation.')
    process.exit(1)
  }
  console.error('Baseline green.\n')

  const results = []

  for (const m of MUTATIONS) {
    process.stderr.write(`  ${m.id.padEnd(26)} `)
    const revert = applyMutation(m)

    let caught
    try {
      caught = runSuite().failed
    } finally {
      revert()
    }

    const detected = caught.size > 0
    const missed = m.expect.filter((s) => !caught.has(s))
    const surprises = [...caught].filter((s) => !m.expect.includes(s))

    results.push({
      ...m,
      caughtBy: [...caught].sort(),
      detected,
      missedExpected: missed,
      unexpectedCatches: surprises.sort(),
    })

    console.error(
      detected
        ? `caught by ${caught.size} suite${caught.size === 1 ? '' : 's'}${missed.length ? `  (MISSED: ${missed.join(', ')})` : ''}`
        : 'NOT DETECTED',
    )
  }

  // Restore, belt and braces.
  git('checkout', '--', 'packages/physics/src')

  const undetected = results.filter((r) => !r.detected)

  if (asJson) {
    console.log(JSON.stringify({ results, undetected: undetected.map((r) => r.id) }, null, 2))
  } else {
    console.error('')
    console.error(`${results.length - undetected.length}/${results.length} mutations detected.`)
    if (undetected.length) {
      console.error(`UNDETECTED: ${undetected.map((r) => r.id).join(', ')}`)
      console.error('Each of these is a hole in the suite.')
    }
  }

  process.exit(undetected.length === 0 ? 0 : 2)
}

main().catch((err) => {
  console.error(err)
  try {
    git('checkout', '--', 'packages/physics/src')
    console.error('\n(source tree restored)')
  } catch {
    console.error('\nWARNING: could not restore the source tree. Run:')
    console.error('  git checkout -- packages/physics/src')
  }
  process.exit(1)
})
