#!/usr/bin/env node
/**
 * The break-check protocol, applied to the app's pure geometry (REQUIREMENTS §4.3).
 *
 *   "A passing suite proves nothing until each test is confirmed able to fail."
 *
 * The physics break-check stops at its package boundary, and for most of the app that
 * is right: there is no way to mutate a shader and assert that "it looks wrong". Two
 * files are exceptions, and they are exceptions for the same reason.
 *
 * - `hud/symbology.ts` — a pitch ladder at the wrong scale or a flight path marker
 *   mirrored through the centre of the screen looks entirely plausible.
 * - `terrain/geo.ts` — a projection error moves a whole city and does it consistently
 *   enough to look deliberate. A runway 400 m from where it belongs is still a
 *   runway.
 *
 * Both are pure geometry with exact right answers, and both fail in ways a developer
 * who cannot fly has no chance of spotting by looking. So they get the same treatment
 * the flight model does.
 *
 * Same rules as `packages/physics/tools/break_check.mjs`: one surgical edit at a
 * time, run the suite, revert. It refuses to start on a dirty tree, and it validates
 * every anchor up front — checking during the run means one stale anchor hides the
 * state of everything behind it, which is exactly how the physics break-check spent
 * two days silently running 13 of its 25.
 *
 * Run:  node tools/break_check.mjs   (from packages/app)
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
const REPO = resolve(PKG, '../..')

const HUD_MUTATIONS = [
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

const GEO_MUTATIONS = [
  {
    id: 'north-sign',
    breaks: 'North drawn at +Z instead of -Z',
    why: 'Mirrors the world north-south. Everything still looks like a map, and every heading is wrong.',
    find: 'return { x: east, z: -north }',
    replace: 'return { x: east, z: north }',
  },
  {
    id: 'spherical-earth',
    breaks: 'One radius used for both axes',
    why: 'The prime vertical and meridional radii differ by 0.39% at mid latitude. A single radius stretches the region in one axis by about 170 m across 55 km.',
    find: 'const WGS84_E2 = WGS84_F * (2 - WGS84_F)',
    replace: 'const WGS84_E2 = 0',
  },
  {
    id: 'longitude-without-cosine',
    breaks: 'Longitude spacing not shortened by latitude',
    why: 'A degree of longitude is 24% shorter than a degree of latitude at 40 north. Dropping the cosine stretches the city sideways by a quarter.',
    find: '  const n = primeVertical(latRad)\n',
    replace: '  const n = primeVertical(latRad) / Math.max(Math.cos(latRad), 1e-6)\n',
  },
  {
    id: 'flattening-ignored',
    breaks: 'The ellipsoid made a sphere in ECEF',
    why: 'Removes the polar flattening. Latitudes drift by kilometres away from the equator.',
    find: '    (n * (1 - WGS84_E2) + height) * sinLat,',
    replace: '    (n + height) * sinLat,',
  },
  {
    id: 'inverse-single-pass',
    breaks: 'The Newton inverse cut to its seed',
    why: 'The seed is the small-angle approximation. It is good near the origin and 2 m out at the corner of a region, so the round trip stops closing.',
    find: '    for (let i = 0; i < 3; i++) {',
    replace: '    for (let i = 0; i < 0; i++) {',
  },
  {
    id: 'convergence-unscaled',
    breaks: 'Meridian convergence not scaled by sin(latitude)',
    why: 'Convergence is a longitude difference times sin(lat). Unscaled it is wrong everywhere but the pole.',
    find: 'return (lon - this.origin.lon) * Math.sin(lat * DEG)',
    replace: 'return lon - this.origin.lon',
  },
]

const TARGETS = [
  { name: 'HUD symbology', file: 'src/hud/symbology.ts', suite: 'test/hud.test.ts', mutations: HUD_MUTATIONS },
  { name: 'Geodetic projection', file: 'src/terrain/geo.ts', suite: 'test/geo.test.ts', mutations: GEO_MUTATIONS },
]

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
}

const dirty = git('status', '--porcelain', '--', 'packages/app/src/hud', 'packages/app/src/terrain')
if (dirty) {
  console.error('Refusing to run: the files this rewrites have uncommitted changes.')
  console.error(dirty)
  process.exit(1)
}

// Every anchor, before any of them run. See the note at the top.
const stale = []
for (const target of TARGETS) {
  const source = readFileSync(resolve(PKG, target.file), 'utf8')
  for (const m of target.mutations) {
    if (!source.includes(m.find)) stale.push(`${target.file}: ${m.id}`)
  }
}
if (stale.length > 0) {
  console.error(`${stale.length} mutation(s) no longer apply:\n`)
  for (const line of stale) console.error(`  ${line}`)
  console.error('\nThe source has changed since these were written. Update them — a')
  console.error('mutation that silently fails to apply reports a clean bill of health')
  console.error('for a test that was never challenged.')
  process.exit(1)
}

const undetected = []
let total = 0

for (const target of TARGETS) {
  const path = resolve(PKG, target.file)
  const original = readFileSync(path, 'utf8')

  console.log(`\n${target.name} — ${target.mutations.length} mutations\n`)

  for (const m of target.mutations) {
    total++
    writeFileSync(path, original.replace(m.find, m.replace))
    const run = spawnSync('npx', ['vitest', 'run', target.suite], { cwd: PKG, encoding: 'utf8' })
    writeFileSync(path, original)

    const caught = run.status !== 0
    if (!caught) undetected.push({ ...m, file: target.file })
    console.log(`  ${caught ? 'caught    ' : 'UNDETECTED'}  ${m.id.padEnd(24)} ${m.breaks}`)
  }
}

console.log('')

if (undetected.length > 0) {
  console.error(`${undetected.length} mutation(s) went undetected:`)
  for (const m of undetected) console.error(`  ${m.file} ${m.id} — ${m.why}`)
  console.error('\nA test that cannot fail is not a test.')
  process.exit(1)
}

console.log(`All ${total} mutations detected.\n`)
