#!/usr/bin/env node
/**
 * The break-check protocol, applied to the HUD geometry (REQUIREMENTS §4.3).
 *
 *   "A passing suite proves nothing until each test is confirmed able to fail."
 *
 * The physics break-check deliberately stops at the package boundary, and for most
 * of the app that is the right call: there is no way to mutate a shader and assert
 * that "it looks wrong". `hud/symbology.ts` is the exception. It is pure geometry
 * with exact right answers, and it is the one part of the renderer whose defects a
 * person with no flying experience cannot see — a pitch ladder at the wrong scale or
 * a flight path marker mirrored through the centre looks entirely plausible on
 * screen. So it gets the same treatment the flight model does.
 *
 * Same rules as `packages/physics/tools/break_check.mjs`: one surgical edit at a
 * time, run the suite, revert. It refuses to start on a dirty tree, and it refuses
 * to run a mutation whose anchor text has moved — a mutation that silently fails to
 * apply reports a clean bill of health for a test that was never challenged.
 *
 * Run:  node tools/hud_break_check.mjs   (from packages/app)
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '../..')
const TARGET = resolve(PKG, 'src/hud/symbology.ts')

/**
 * The mutations.
 *
 * Each is a way the HUD could be wrong that a screenshot would not settle.
 */
const MUTATIONS = [
  {
    id: 'flip-screen-y',
    breaks: 'Screen Y measured upward instead of downward',
    why: 'Canvas Y grows downward and world Y grows upward. Getting the flip backwards draws a coherent, symmetrical, entirely inverted HUD.',
    find: 'y: (0.5 - (cy / cw) * 0.5) * height,',
    replace: 'y: (0.5 + (cy / cw) * 0.5) * height,',
  },
  {
    id: 'ignore-behind',
    breaks: 'Directions behind the camera projected anyway',
    why: 'A point behind the eye projects to a mirrored position in front of it. The horizon then appears above the aircraft whenever you look away from it.',
    find: 'if (cw <= 1e-9) return null',
    replace: 'if (false) return null',
  },
  {
    id: 'flat-ladder',
    breaks: 'The cosine of pitch dropped from the ladder direction',
    why: 'Rungs stop being pieces of a great circle. The error is zero at the horizon and grows with pitch, so the ladder looks right in exactly the attitude nobody needs it.',
    find: 'const a = cp * Math.cos(l)',
    replace: 'const a = Math.cos(l)',
  },
  {
    id: 'quat-conjugate',
    breaks: 'One sign flipped in the quaternion rotation',
    why: 'Went undetected on the first run of this pass: every quaternion in the suite was a pure pitch rotation, for which the mutated term is identically zero. A yaw case and a general-attitude case were added.',
    find: 'v[0] + w * tx + (y * tz - z * ty),',
    replace: 'v[0] - w * tx + (y * tz - z * ty),',
  },
  {
    id: 'ticks-off-grid',
    breaks: 'Tape graduations start at the current value',
    why: 'The tape then reads 287, 297, 307 instead of 250, 300, 350 — continuous where it has to be round.',
    find: 'const first = Math.ceil(low / o.minorStep) * o.minorStep',
    replace: 'const first = low',
  },
  {
    id: 'no-min-clamp',
    breaks: 'Negative airspeeds emitted on the tape',
    why: 'The floor exists because the takeoff roll spends real time near zero.',
    find: 'if (o.min !== undefined && value < o.min) continue',
    replace: 'if (false) continue',
  },
  {
    id: 'no-wrap',
    breaks: 'Heading strip stops wrapping at north',
    why: 'The strip shows 355, 360, 365 and the compass has no north on it.',
    find: 'const shown = o.wrap === undefined ? value : ((value % o.wrap) + o.wrap) % o.wrap',
    replace: 'const shown = value',
  },
  {
    id: 'no-short-way',
    breaks: 'Steering cue takes the long way round the compass',
    why: 'The diamond leaves the strip whenever the course crosses north, which on this map it does.',
    find: 'let delta = ((targetDeg - headingDeg + 540) % 360) - 180',
    replace: 'let delta = targetDeg - headingDeg',
  },
  {
    id: 'bearing-swap',
    breaks: 'Bearing arguments to atan2 exchanged',
    why: 'Reflects every bearing about 045. Plausible on a map that has waypoints in all directions.',
    find: 'Math.atan2(to.x - from.x, -(to.z - from.z))',
    replace: 'Math.atan2(-(to.z - from.z), to.x - from.x)',
  },
  {
    id: 'never-caged',
    breaks: 'A clamped flight path marker no longer reports that it is clamped',
    why: 'The marker then silently stops meaning "the ground you are going to hit" while continuing to look exactly as authoritative.',
    find: 'return { x, y, clamped: x !== p.x || y !== p.y }',
    replace: 'return { x, y, clamped: false }',
  },
  {
    id: 'ladder-eats-horizon',
    breaks: 'The zero rung drawn as an ordinary rung',
    why: 'The horizon is drawn separately and much wider. Two horizons of different lengths on top of each other is the sort of thing that reads as a rendering glitch rather than a bug.',
    find: 'if (rounded === 0 || rounded > 90 || rounded < -90) continue',
    replace: 'if (rounded > 90 || rounded < -90) continue',
  },
]

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
}

if (git('status', '--porcelain', '--', 'packages/app/src/hud')) {
  console.error('Refusing to run: packages/app/src/hud has uncommitted changes.')
  console.error('This tool rewrites source files and reverts them afterwards.')
  process.exit(1)
}

const original = readFileSync(TARGET, 'utf8')
const undetected = []

console.log(`\nHUD break-check — ${MUTATIONS.length} mutations\n`)

for (const m of MUTATIONS) {
  if (!original.includes(m.find)) {
    console.error(`  ${m.id}: anchor text not found. The mutation would silently`)
    console.error(`  pass without testing anything. Fix the anchor.\n`)
    writeFileSync(TARGET, original)
    process.exit(1)
  }

  writeFileSync(TARGET, original.replace(m.find, m.replace))
  const run = spawnSync('npx', ['vitest', 'run', 'test/hud.test.ts'], {
    cwd: PKG,
    encoding: 'utf8',
  })
  writeFileSync(TARGET, original)

  const caught = run.status !== 0
  if (!caught) undetected.push(m)
  console.log(`  ${caught ? 'caught    ' : 'UNDETECTED'}  ${m.id.padEnd(20)} ${m.breaks}`)
}

console.log('')

if (undetected.length > 0) {
  console.error(`${undetected.length} mutation(s) went undetected:`)
  for (const m of undetected) console.error(`  ${m.id} — ${m.why}`)
  console.error('\nA test that cannot fail is not a test.')
  process.exit(1)
}

console.log(`All ${MUTATIONS.length} mutations detected.\n`)
