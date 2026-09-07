/**
 * HUD symbology (REQUIREMENTS §9.1).
 *
 * The conformal half of a HUD is the kind of code that looks right on screen while
 * being wrong: a pitch ladder off by a factor, a flight path marker mirrored through
 * the centre, a horizon that hides half a degree of error behind a fat line. None of
 * that shows up as a crash, and a person who has never flown cannot spot it by
 * looking — which is the constraint the whole project is built around.
 *
 * So the geometry is tested numerically here, and the last test in this file is the
 * one that matters most: with the camera at the aircraft's attitude, the angle
 * measured off the screen between the boresight and the flight path marker equals
 * angle of attack. That is §9.1's entire claim, checked rather than asserted.
 */

import { describe, expect, it } from 'vitest'
import {
  applyQuat,
  bearingTo,
  clampToBox,
  headingFrac,
  ladderBasis,
  ladderDirection,
  ladderPitches,
  projectDirection,
  tapeTicks,
  type Quat,
  type Vec3,
} from '../src/hud/symbology.js'

const WIDTH = 1600
const HEIGHT = 900
const FOV = 58
const F = 1 / Math.tan(((FOV / 2) * Math.PI) / 180)
const ASPECT = WIDTH / HEIGHT

const deg = (d: number): number => (d * Math.PI) / 180

/** Column-major perspective matrix, the same convention `THREE.Matrix4` uses. */
function perspective(): number[] {
  const near = 2
  const far = 40_000
  const e = new Array<number>(16).fill(0)
  e[0] = F / ASPECT
  e[5] = F
  e[10] = (far + near) / (near - far)
  e[11] = -1
  e[14] = (2 * far * near) / (near - far)
  return e
}

/** Column-major 4x4 multiply: `out = a . b`. */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!
      out[col * 4 + row] = sum
    }
  }
  return out
}

/**
 * View-projection for a camera at the origin with attitude `q`.
 *
 * The view matrix's rows are the camera's own axes, which for a rotation is just the
 * transpose — no inversion needed, and no translation because every symbol here is a
 * point at infinity and translation cannot reach it.
 */
function viewProjection(q: Quat): number[] {
  const right = applyQuat(q, [1, 0, 0])
  const up = applyQuat(q, [0, 1, 0])
  const back = applyQuat(q, [0, 0, 1])

  const view = [
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    0, 0, 0, 1,
  ]

  return multiply(perspective(), view)
}

/** Attitude for a pure pitch-up of `pitchDeg`, wings level, heading north. */
function pitched(pitchDeg: number): Quat {
  const h = deg(pitchDeg) / 2
  return [Math.sin(h), 0, 0, Math.cos(h)]
}

const LEVEL_NORTH = viewProjection([0, 0, 0, 1])

describe('applyQuat', () => {
  it('leaves a vector alone at the identity', () => {
    expect(applyQuat([0, 0, 0, 1], [1, 2, 3])).toEqual([1, 2, 3])
  })

  it('pitches the nose up', () => {
    const nose = applyQuat(pitched(9), [0, 0, -1])
    expect(nose[0]).toBeCloseTo(0, 12)
    expect(nose[1]).toBeCloseTo(Math.sin(deg(9)), 12)
    expect(nose[2]).toBeCloseTo(-Math.cos(deg(9)), 12)
  })

  it('yaws the nose from north to west', () => {
    // Not redundant with the pitch case, and the break-check is what proved it. The
    // vector form used here computes `2 * (q_vec x v)` and then adds `w * t`; for a
    // pure pitch rotation acting on the nose that cross product is identically zero
    // in x, so half the formula could be deleted and every test above stayed green.
    // A yaw is the smallest rotation that makes the term carry weight.
    const h = deg(90) / 2
    const nose = applyQuat([0, Math.sin(h), 0, Math.cos(h)], [0, 0, -1])
    expect(nose[0]).toBeCloseTo(-1, 12)
    expect(nose[1]).toBeCloseTo(0, 12)
    expect(nose[2]).toBeCloseTo(0, 12)
  })

  it('agrees with the rotation matrix it stands in for, on a general attitude', () => {
    // Pitched, rolled and yawed at once, so no component of the quaternion is zero
    // and no term in the formula can hide.
    const raw = [0.31, -0.52, 0.17, 0.78]
    const n = Math.hypot(...raw)
    const [x, y, z, w] = raw.map((c) => c / n) as [number, number, number, number]

    // Written out independently rather than reusing the helper under test.
    const matrix = (v: Vec3): Vec3 => [
      (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y - w * z) * v[1] + 2 * (x * z + w * y) * v[2],
      2 * (x * y + w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z - w * x) * v[2],
      2 * (x * z - w * y) * v[0] + 2 * (y * z + w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2],
    ]

    for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.8, 0.5]] as Vec3[]) {
      const a = applyQuat([x, y, z, w], v)
      const b = matrix(v)
      for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 12)
    }
  })
})

describe('projectDirection', () => {
  it('puts the direction the camera faces in the middle of the screen', () => {
    const p = projectDirection([0, 0, -1], LEVEL_NORTH, WIDTH, HEIGHT)
    expect(p).not.toBeNull()
    expect(p!.x).toBeCloseTo(WIDTH / 2, 9)
    expect(p!.y).toBeCloseTo(HEIGHT / 2, 9)
  })

  it('puts right to the right and up above, in screen coordinates', () => {
    const right = projectDirection([Math.sin(deg(10)), 0, -Math.cos(deg(10))], LEVEL_NORTH, WIDTH, HEIGHT)!
    const up = projectDirection([0, Math.sin(deg(10)), -Math.cos(deg(10))], LEVEL_NORTH, WIDTH, HEIGHT)!

    expect(right.x).toBeGreaterThan(WIDTH / 2)
    expect(right.y).toBeCloseTo(HEIGHT / 2, 9)
    // Canvas y grows downward, so "above" is a smaller number. Getting this backwards
    // is the classic HUD bug: everything works and the ladder is upside down.
    expect(up.y).toBeLessThan(HEIGHT / 2)
    expect(up.x).toBeCloseTo(WIDTH / 2, 9)
  })

  it('drops a direction behind the camera rather than mirroring it', () => {
    expect(projectDirection([0, 0, 1], LEVEL_NORTH, WIDTH, HEIGHT)).toBeNull()
  })

  it('scales with the field of view exactly as the projection does', () => {
    const p = projectDirection([0, Math.sin(deg(10)), -Math.cos(deg(10))], LEVEL_NORTH, WIDTH, HEIGHT)!
    const expected = (0.5 - 0.5 * F * Math.tan(deg(10))) * HEIGHT
    expect(p.y).toBeCloseTo(expected, 9)
  })
})

describe('ladderBasis', () => {
  it('points north on heading zero', () => {
    const b = ladderBasis(0)
    expect(b.forward[0]).toBeCloseTo(0, 12)
    // North is -Z in the renderer's frame (see seam.ts).
    expect(b.forward[2]).toBeCloseTo(-1, 12)
    expect(b.right[0]).toBeCloseTo(1, 12)
  })

  it('points east on heading ninety', () => {
    const b = ladderBasis(90)
    expect(b.forward[0]).toBeCloseTo(1, 12)
    expect(b.forward[2]).toBeCloseTo(0, 12)
  })

  it('is horizontal on every heading', () => {
    for (const heading of [0, 37, 90, 180, 271, 359]) {
      const b = ladderBasis(heading)
      expect(b.forward[1]).toBe(0)
      expect(Math.hypot(b.forward[0], b.forward[2])).toBeCloseTo(1, 12)
    }
  })
})

describe('ladderDirection', () => {
  it('sits at the requested elevation whatever the lateral offset', () => {
    const basis = ladderBasis(213)
    for (const lateral of [-34, -9, 0, 9, 34]) {
      const d = ladderDirection(basis, 20, lateral)
      // Unit vector, so the vertical component IS the sine of the elevation.
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12)
      expect(Math.asin(d[1]) * (180 / Math.PI)).toBeCloseTo(20, 9)
    }
  })

  it('projects to a level line when the camera is level', () => {
    const basis = ladderBasis(0)
    const left = projectDirection(ladderDirection(basis, 10, -9), LEVEL_NORTH, WIDTH, HEIGHT)!
    const right = projectDirection(ladderDirection(basis, 10, 9), LEVEL_NORTH, WIDTH, HEIGHT)!
    expect(left.y).toBeCloseTo(right.y, 6)
    expect(left.x).toBeLessThan(right.x)
  })
})

describe('ladderPitches', () => {
  it('skips the horizon, which is drawn separately and wider', () => {
    expect(ladderPitches(0, 20, 5)).not.toContain(0)
  })

  it('brackets the current pitch', () => {
    expect(ladderPitches(0, 12, 5)).toEqual([-10, -5, 5, 10])
  })

  it('never runs past the poles', () => {
    for (const p of ladderPitches(85, 34, 5)) expect(Math.abs(p)).toBeLessThanOrEqual(90)
    for (const p of ladderPitches(-85, 34, 5)) expect(Math.abs(p)).toBeLessThanOrEqual(90)
  })
})

describe('tapeTicks', () => {
  it('centres the current value', () => {
    const ticks = tapeTicks({ value: 300, span: 140, minorStep: 10, majorStep: 50 })
    const middle = ticks.find((t) => t.value === 300)
    expect(middle?.frac).toBeCloseTo(0.5, 12)
  })

  it('flags the labelled graduations and only those', () => {
    const ticks = tapeTicks({ value: 300, span: 140, minorStep: 10, majorStep: 50 })
    expect(ticks.filter((t) => t.major).map((t) => t.value)).toEqual([250, 300, 350])
  })

  it('does not emit airspeeds below zero', () => {
    const ticks = tapeTicks({ value: 20, span: 140, minorStep: 10, majorStep: 50, min: 0 })
    expect(Math.min(...ticks.map((t) => t.value))).toBe(0)
  })

  it('crosses north without a gap', () => {
    const ticks = tapeTicks({ value: 358, span: 60, minorStep: 5, majorStep: 10, wrap: 360 })
    const values = ticks.map((t) => t.value)
    // 350, 355, 0, 5 and 10 are all within thirty degrees of 358 and must all appear.
    for (const v of [350, 355, 0, 5, 10]) expect(values).toContain(v)
    // And they must still march left to right in order, which is the thing a naive
    // modulo breaks: sorting by the wrapped value would put 355 to the right of 5.
    const fracs = ticks.map((t) => t.frac)
    expect([...fracs].sort((a, b) => a - b)).toEqual(fracs)
  })

  it('graduates in round numbers even though the airspeed is not one', () => {
    // The value the aircraft is at is continuous; the numbers printed beside it must
    // not be. A tape that starts its ticks at the current value shows 287, 297, 307
    // and is unreadable.
    const ticks = tapeTicks({ value: 287.3, span: 140, minorStep: 10, majorStep: 50 })
    for (const tick of ticks) expect(tick.value % 10).toBe(0)
    expect(ticks.filter((t) => t.major).map((t) => t.value)).toEqual([250, 300, 350])
  })
})

describe('headingFrac', () => {
  it('puts the current heading under the lubber line', () => {
    expect(headingFrac(123, 123, 60)).toBeCloseTo(0.5, 12)
  })

  it('takes the short way round the compass', () => {
    // Ten degrees right of 355 is 005, not 350 degrees of left turn.
    expect(headingFrac(355, 5, 60)).toBeCloseTo(0.5 + 10 / 60, 12)
  })

  it('hides a target that is off the strip', () => {
    expect(headingFrac(0, 180, 60)).toBeNull()
  })
})

describe('bearingTo', () => {
  const origin = { x: 0, z: 0 }

  it('reads north, east, south and west', () => {
    expect(bearingTo(origin, { x: 0, z: -100 })).toBeCloseTo(0, 9)
    expect(bearingTo(origin, { x: 100, z: 0 })).toBeCloseTo(90, 9)
    expect(bearingTo(origin, { x: 0, z: 100 })).toBeCloseTo(180, 9)
    expect(bearingTo(origin, { x: -100, z: 0 })).toBeCloseTo(270, 9)
  })
})

describe('clampToBox', () => {
  const box = { left: 10, top: 20, right: 90, bottom: 80 }

  it('leaves a symbol inside the glass alone', () => {
    expect(clampToBox({ x: 50, y: 50 }, box)).toEqual({ x: 50, y: 50, clamped: false })
  })

  it('cages one that has left it, and says so', () => {
    expect(clampToBox({ x: 500, y: 50 }, box)).toEqual({ x: 90, y: 50, clamped: true })
  })
})

/**
 * The §9.1 claim, measured.
 *
 * "The gap between those two symbols is the entire intuition this project is trying
 * to build" — so the gap had better be angle of attack, in degrees, and not merely
 * something that grows when alpha does.
 */
describe('the boresight-to-flight-path gap', () => {
  const angleBetween = (a: Vec3, b: Vec3, viewProj: number[]): number => {
    const pa = projectDirection(a, viewProj, WIDTH, HEIGHT)!
    const pb = projectDirection(b, viewProj, WIDTH, HEIGHT)!
    // Undo the projection: ndc = f * tan(angle), so angle = atan(ndc / f).
    const ndc = (2 * (pb.y - pa.y)) / HEIGHT
    return (Math.atan(ndc / F) * 180) / Math.PI
  }

  it('is zero when the aircraft goes exactly where it points', () => {
    const q = pitched(0)
    const nose = applyQuat(q, [0, 0, -1])
    expect(angleBetween(nose, [0, 0, -1], viewProjection(q))).toBeCloseTo(0, 9)
  })

  it('is angle of attack in level flight', () => {
    // Nine degrees nose up, going dead level: the classic slow-approach picture.
    const q = pitched(9)
    const nose = applyQuat(q, [0, 0, -1])
    const velocity: Vec3 = [0, 0, -1]

    // Positive means the marker is BELOW the boresight on screen, which is where a
    // positive angle of attack puts it.
    expect(angleBetween(nose, velocity, viewProjection(q))).toBeCloseTo(9, 6)
  })

  it('holds at a large alpha, where the small-angle version would drift', () => {
    const q = pitched(25)
    const nose = applyQuat(q, [0, 0, -1])
    expect(angleBetween(nose, [0, 0, -1], viewProjection(q))).toBeCloseTo(25, 6)
  })

  it('reverses sign in a dive with the nose above the flight path', () => {
    // Pointed level, going down: the marker sits above nothing — it sits below the
    // boresight by the dive angle, and the ladder rung it lands on reads negative.
    const q = pitched(0)
    const nose = applyQuat(q, [0, 0, -1])
    const velocity: Vec3 = [0, -Math.sin(deg(12)), -Math.cos(deg(12))]
    expect(angleBetween(nose, velocity, viewProjection(q))).toBeCloseTo(12, 6)
  })

  it('lands the marker on the ladder rung that names its flight path angle', () => {
    // The real test of conformality: a 15-degree climb must put the flight path
    // marker on the "15" rung, not near it.
    const q = pitched(22)
    const basis = ladderBasis(0)
    const viewProj = viewProjection(q)

    const velocity: Vec3 = [0, Math.sin(deg(15)), -Math.cos(deg(15))]
    const marker = projectDirection(velocity, viewProj, WIDTH, HEIGHT)!
    const rung = projectDirection(ladderDirection(basis, 15, 0), viewProj, WIDTH, HEIGHT)!

    expect(marker.y).toBeCloseTo(rung.y, 6)
    expect(marker.x).toBeCloseTo(rung.x, 6)
  })
})
