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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
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
    find: `  const k1 = d(v)
  const k2 = d(add(v, k1, dt / 2))
  const k3 = d(add(v, k2, dt / 2))
  const k4 = d(add(v, k3, dt))`,
    replace: `  const k1 = d(v)
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

  // --- Day 3: body-axis velocity, ground reaction -------------------------
  {
    id: 'swap-body-accelerations',
    description: 'Swap the lateral and normal accelerations in the body-axis tail',
    rationale:
      'The body-axis tail replaced the reference wind-axis one, and the golden vectors do not cover it — they validate `derivative`, which is untouched. This is what does. Note which suites are NOT expected to catch it: `modes` linearises the 13-element Euler state through `derivative`, so it cannot see this tail at all, and `trim` holds a level condition where beta is zero and both accelerations are near zero, so swapping them is very nearly a no-op against bounds deliberately loosened for the phugoid.',
    file: 'src/state.ts',
    find: '      core.udot, core.vdot, core.wdot,',
    replace: '      core.udot, core.wdot, core.vdot,',
    expect: ['bodyAxis', 'quaternion', 'energy', 'boundary', 'gear'],
  },
  {
    id: 'integrated-alpha',
    description: 'Recover alpha with atan instead of atan2, losing the quadrant',
    rationale:
      'Alpha is derived from the body velocity rather than integrated, which is what makes the Day 2 tumble bug structurally impossible. Confirms something still checks that.',
    file: 'src/state.ts',
    find: '    alpha: Math.atan2(w, u),',
    replace: '    alpha: Math.atan(w / u),',
    expect: ['bodyAxis'],
  },
  {
    id: 'external-loads-inert',
    description: 'Drop the external force from the body-axis force equations',
    rationale:
      'The seam ground reaction arrives through. If nothing notices it vanishing, the gear is not connected to the flight model at all.',
    file: 'src/dynamics.ts',
    find: '  let az = rmqs * c.czt + rm * ext.fz',
    replace: '  let az = rmqs * c.czt',
    expect: ['bodyAxis', 'gear'],
  },
  {
    id: 'strut-pulls-down',
    description: 'Let a strut pull the aircraft down on rebound',
    rationale:
      'On the rebound the damper term goes strongly negative — measured -151,000 lb for a main leaving the ground at 50 ft/s. Unclamped, it sucks the aircraft back onto the runway.',
    file: 'src/gear.ts',
    find: `    if (N <= 0) {
      compression.push(squash)
      normal.push(0)
      continue
    }`,
    replace: `    if (false) {
      compression.push(squash)
      normal.push(0)
      continue
    }`,
    expect: ['gear'],
  },
  {
    id: 'friction-sign-law',
    description: 'Replace the tyre friction ramp with sign(), the chatter law',
    rationale:
      'A discontinuity at zero slip that a fixed-step integrator answers by flipping the friction force every tick. Shows up as a parked aircraft buzzing.',
    file: 'src/gear.ts',
    find: '      return peak * stribeck * clamp(slip / SLIP_REFERENCE_FPS, -1, 1)',
    replace: '      return peak * stribeck * Math.sign(slip)',
    expect: ['gear'],
  },
  {
    id: 'no-static-friction',
    description: 'Remove the static-to-dynamic friction falloff',
    rationale:
      'REQUIREMENTS §3 asks for static and dynamic friction as separate things. This survived the first break-check run because nothing asserted breakaway grip exceeds sliding grip.',
    file: 'src/gear.ts',
    find: '      const stribeck = 1 + (STATIC_FRICTION_BONUS - 1) * Math.exp(-speed / STRIBECK_FPS)',
    replace: '      const stribeck = 1',
    expect: ['gear'],
  },
  {
    id: 'no-bottoming-stop',
    description: 'Make a bottomed strut keep its linear spring rate',
    rationale:
      'Also survived the first run: bottoming set a flag but no test checked the force went stiff, so the aircraft could sink through the runway while a boolean said otherwise.',
    file: 'src/gear.ts',
    find: '    const spring = s.k * withinStroke + s.k * BOTTOMING_RATIO * overStroke',
    replace: '    const spring = s.k * squash',
    expect: ['gear'],
  },
  {
    id: 'no-damping-fade',
    description: 'Apply full strut damping at first contact',
    rationale:
      'Measured before this existed: 173,871 lb in a single tick on a 27 ft/s arrival, from a strut that had not yet moved. A step force where there should be a ramp.',
    file: 'src/gear.ts',
    find: '    const fade = Math.min(1, squash / DAMPING_FADE_FT)',
    replace: '    const fade = 1',
    expect: ['gear'],
  },
  {
    id: 'symmetric-strut-damping',
    description: 'Damp strut extension as softly as compression',
    rationale:
      'Without a stiffer recoil the strut returns the arrival energy: measured, airborne again 0.25 s after touchdown climbing at 1,100 fpm.',
    file: 'src/gear.ts',
    find: '    const damping = s.c * fade * (extending ? REBOUND_DAMPING_RATIO : 1)',
    replace: '    const damping = s.c * fade',
    expect: ['gear'],
  },
  {
    id: 'gear-without-moments',
    description: 'Let the gear produce forces but no moments about the CG',
    rationale:
      'Removes every r x F term. The aircraft would be held up but could not be pitched or rolled by its own wheels — no derotation, no load transfer under braking.',
    file: 'src/gear.ts',
    find: `    l += s.y * fBody[2] - s.z * fBody[1]
    m += s.z * fBody[0] - s.x * fBody[2]
    n += s.x * fBody[1] - s.y * fBody[0]`,
    replace: `    l += 0
    m += 0
    n += 0`,
    expect: ['gear'],
  },
  {
    id: 'contact-ignores-rotation',
    description: 'Compute contact-point velocity without the rotation about the CG',
    rationale:
      'Drops the omega x r term, so a wing-down landing loads both mains equally and a yaw rate meets no resistance.',
    file: 'src/gear.ts',
    find: `      vb[0] + (qRate * s.z - r * s.y),
      vb[1] + (r * s.x - p * s.z),
      vb[2] + (p * s.y - qRate * s.x),`,
    replace: `      vb[0],
      vb[1],
      vb[2],`,
    expect: ['gear'],
  },
  {
    id: 'level-resting-attitude',
    description: 'Assume the parked aircraft sits level',
    rationale:
      'The struts compress by different amounts, so it rests half a degree nose-up. Assuming level over-compresses the nose strut and starts every runway spawn carrying 109% of the aircraft weight.',
    file: 'src/gear.ts',
    find: '  const pitch = Math.atan2(zNose - zMain, xNose - xMain)',
    replace: '  const pitch = 0',
    expect: ['gear'],
  },
  {
    id: 'supersonic-thrust-clamped',
    description: 'Clamp the thrust interpolation weight at the table edge',
    rationale:
      'Not a defect being introduced — the opposite. `supersonicThrust` records what the reference model actually does above Mach 1, and this confirms those numbers describe the extrapolation rather than being incidental.',
    file: 'src/aero/engine.ts',
    find: '  const dm = rm - m',
    replace: '  const dm = Math.min(rm - m, 1)',
    expect: ['supersonicThrust'],
  },
]

const SUITES = [
  'massProperties', 'atmosphere', 'goldenCoefficients', 'goldenEngine',
  'goldenDerivatives', 'quaternion', 'trim', 'modes', 'boundary', 'energy',
  'bodyAxis', 'gear', 'supersonicThrust',
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

const SCRATCH = mkdtempSync(join(tmpdir(), 'breakcheck-'))
const REPORT_PATH = join(SCRATCH, 'report.json')

/**
 * Run the suite; return the set of test files that failed.
 *
 * The report goes to a real file rather than /dev/stdout. Writing it to stdout
 * interleaves with vitest's own console output, so the JSON arrives corrupted some
 * of the time, the parse fails, and the fallback marks EVERY suite as failed. That
 * silently inflates detection — a mutation looks broadly caught when in fact the
 * run never produced readable results. It is a false negative for suite holes,
 * which is the one error this tool must not make.
 */
function runSuite() {
  rmSync(REPORT_PATH, { force: true })

  const res = spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=json', `--outputFile=${REPORT_PATH}`],
    { cwd: PKG, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )

  let report
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'))
  } catch {
    // No readable report means the run itself failed — a compile error, most
    // likely. Treat that as everything failing, but say so, because it is a
    // different thing from a mutation being detected.
    console.error(
      `\n    [run produced no readable report; exit ${res.status}. ` +
        `Treating as all-suites-failed.]`,
    )
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
      caught = runSuite()
    } finally {
      revert()
    }

    const detected = caught.failed.size > 0
    const missed = m.expect.filter((s) => !caught.failed.has(s))
    const surprises = [...caught.failed].filter((s) => !m.expect.includes(s))

    results.push({
      ...m,
      caughtBy: [...caught.failed].sort(),
      detected,
      buildFailed: caught.parseError,
      missedExpected: missed,
      unexpectedCatches: surprises.sort(),
    })

    const n = caught.failed.size
    console.error(
      detected
        ? `caught by ${n} suite${n === 1 ? '' : 's'}` +
            (caught.parseError ? ' [BUILD FAILED]' : '') +
            (missed.length ? `  (MISSED: ${missed.join(', ')})` : '')
        : 'NOT DETECTED',
    )
  }

  // Restore, belt and braces.
  git('checkout', '--', 'packages/physics/src')
  rmSync(SCRATCH, { recursive: true, force: true })

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
