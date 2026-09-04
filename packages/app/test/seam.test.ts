/**
 * The §8.3 seam: units and frames.
 *
 * Frame conversion bugs are silent. Nothing throws, no number is NaN, the aircraft
 * simply flies sideways or rolls the wrong way and you spend an hour squinting at a
 * screen. So the conversion is pinned here against attitudes whose answer can be
 * worked out on paper, before anything in the renderer depends on it.
 *
 * The convention under test (see `seam.ts`):
 *
 *     three X = East      three Y = Up      three Z = South
 *     a model faces -Z, which is North
 */

import { describe, expect, it } from 'vitest'
import {
  IDENTITY_QUATERNION,
  degToRad,
  ftToM,
  quaternionFromEuler,
  toQuatVector,
  type AircraftState,
} from '@retro-flyer/physics'
import {
  MODEL_TO_BODY,
  NED_TO_THREE,
  applyMat3,
  lerpRenderState,
  multiplyMat3,
  quaternionFromMatrix,
  rotationFromQuaternion,
  slerp,
  toRenderState,
} from '../src/seam.js'

/** A level state at 10,000 ft and 500 ft/s, with whatever attitude is handed in. */
function levelState(overrides: Partial<AircraftState> = {}): number[] {
  const s: AircraftState = {
    vt: 500,
    alpha: 0,
    beta: 0,
    q: IDENTITY_QUATERNION,
    p: 0,
    qRate: 0,
    r: 0,
    pn: 0,
    pe: 0,
    alt: 10000,
    power: 50,
    ...overrides,
  }
  return toQuatVector(s)
}

/** Rotate the model's own axes into three.js world space. */
function modelAxesInWorld(q: readonly [number, number, number, number]): {
  nose: [number, number, number]
  right: [number, number, number]
  up: [number, number, number]
} {
  // Build the three.js rotation matrix back out of the quaternion and apply it to
  // the model axes. Nose is -Z by three.js convention.
  const [x, y, z, w] = q
  const m = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ] as const

  const apply = (v: [number, number, number]): [number, number, number] => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]

  return {
    nose: apply([0, 0, -1]),
    right: apply([1, 0, 0]),
    up: apply([0, 1, 0]),
  }
}

const near = (a: readonly number[], b: readonly number[], tol = 1e-9): void => {
  expect(a.length).toBe(b.length)
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, Math.round(-Math.log10(tol))))
}

describe('basis changes', () => {
  it('NED_TO_THREE sends North to -Z, East to +X and Down to -Y', () => {
    near(applyMat3(NED_TO_THREE, [1, 0, 0]), [0, 0, -1])
    near(applyMat3(NED_TO_THREE, [0, 1, 0]), [1, 0, 0])
    near(applyMat3(NED_TO_THREE, [0, 0, 1]), [0, -1, 0])
  })

  it('MODEL_TO_BODY sends the model nose (-Z) to the body x axis', () => {
    near(applyMat3(MODEL_TO_BODY, [0, 0, -1]), [1, 0, 0])
    near(applyMat3(MODEL_TO_BODY, [1, 0, 0]), [0, 1, 0])
    near(applyMat3(MODEL_TO_BODY, [0, 1, 0]), [0, 0, -1])
  })

  it('both are proper rotations, so their product is one too', () => {
    const det = (m: readonly number[]): number =>
      (m[0] as number) * ((m[4] as number) * (m[8] as number) - (m[5] as number) * (m[7] as number)) -
      (m[1] as number) * ((m[3] as number) * (m[8] as number) - (m[5] as number) * (m[6] as number)) +
      (m[2] as number) * ((m[3] as number) * (m[7] as number) - (m[4] as number) * (m[6] as number))

    expect(det(NED_TO_THREE)).toBeCloseTo(1, 12)
    expect(det(MODEL_TO_BODY)).toBeCloseTo(1, 12)
  })

  it('composes to the identity at the identity attitude', () => {
    // This is the payoff of the chosen convention: level, nose north, wings level
    // needs no rotation in three.js at all.
    const rNb = rotationFromQuaternion(IDENTITY_QUATERNION)
    const rThree = multiplyMat3(multiplyMat3(NED_TO_THREE, rNb), MODEL_TO_BODY)
    near(rThree, [1, 0, 0, 0, 1, 0, 0, 0, 1])
  })
})

describe('attitude conversion', () => {
  it('identity attitude points the nose North, right wing East, up Up', () => {
    const { quaternion } = toRenderState(levelState())
    const axes = modelAxesInWorld(quaternion)

    near(axes.nose, [0, 0, -1]) // North
    near(axes.right, [1, 0, 0]) // East
    near(axes.up, [0, 1, 0]) // Up
  })

  it('90 degrees of yaw points the nose East', () => {
    const q = quaternionFromEuler(0, 0, degToRad(90))
    const axes = modelAxesInWorld(toRenderState(levelState({ q })).quaternion)

    near(axes.nose, [1, 0, 0]) // East
    near(axes.right, [0, 0, 1]) // South
    near(axes.up, [0, 1, 0])
  })

  it('90 degrees nose up points the nose at the sky', () => {
    const q = quaternionFromEuler(0, degToRad(90), 0)
    const axes = modelAxesInWorld(toRenderState(levelState({ q })).quaternion)

    near(axes.nose, [0, 1, 0]) // straight up
    near(axes.right, [1, 0, 0]) // still East
  })

  it('90 degrees of right bank puts the right wing down', () => {
    const q = quaternionFromEuler(degToRad(90), 0, 0)
    const axes = modelAxesInWorld(toRenderState(levelState({ q })).quaternion)

    near(axes.nose, [0, 0, -1]) // still North
    near(axes.right, [0, -1, 0]) // right wing pointing at the ground
    near(axes.up, [1, 0, 0]) // "up" now points East
  })

  it('inverted flight does not lose precision', () => {
    // The naive matrix-to-quaternion form divides by ~0 near 180 degrees. This is
    // the case that catches it.
    const q = quaternionFromEuler(degToRad(180), 0, 0)
    const axes = modelAxesInWorld(toRenderState(levelState({ q })).quaternion)

    near(axes.nose, [0, 0, -1])
    near(axes.up, [0, -1, 0]) // pointing at the ground, as one would hope
  })

  it('round-trips an arbitrary attitude through matrix and quaternion', () => {
    const q = quaternionFromEuler(degToRad(-37), degToRad(62), degToRad(151))
    const m = rotationFromQuaternion(q)
    const back = quaternionFromMatrix(m)

    // Rebuild the matrix from the three.js-order quaternion and compare.
    const [x, y, z, w] = back
    const m2 = [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ]
    near(m2, m, 1e-12)
  })
})

describe('position and velocity', () => {
  it('maps North/East/altitude onto three.js -Z/+X/+Y in metres', () => {
    const { position } = toRenderState(levelState({ pn: 1000, pe: 2000, alt: 30000 }))

    expect(position[0]).toBeCloseTo(ftToM(2000), 9) // East -> +X
    expect(position[1]).toBeCloseTo(ftToM(30000), 9) // altitude -> +Y
    expect(position[2]).toBeCloseTo(-ftToM(1000), 9) // North -> -Z
  })

  it('sends velocity North for level flight on a northerly heading', () => {
    const { velocity } = toRenderState(levelState({ vt: 500 }))

    expect(velocity[0]).toBeCloseTo(0, 9)
    expect(velocity[1]).toBeCloseTo(0, 9)
    expect(velocity[2]).toBeCloseTo(-ftToM(500), 9) // -Z is North
  })

  it('velocity magnitude equals true airspeed regardless of attitude', () => {
    const q = quaternionFromEuler(degToRad(23), degToRad(-14), degToRad(200))
    const { velocity } = toRenderState(
      levelState({ q, vt: 740, alpha: degToRad(6), beta: degToRad(-3) }),
    )

    expect(Math.hypot(...velocity)).toBeCloseTo(ftToM(740), 8)
  })

  it('a positive angle of attack tilts velocity below the nose', () => {
    // The whole point of the §9.1 flight path marker: where it is going is not
    // where it is pointed. At 10 degrees alpha, level attitude, the aircraft
    // descends.
    const { velocity, quaternion } = toRenderState(levelState({ alpha: degToRad(10) }))
    const { nose } = modelAxesInWorld(quaternion)

    expect(nose[1]).toBeCloseTo(0, 9) // nose on the horizon
    expect(velocity[1]).toBeLessThan(0) // but sinking
  })
})

describe('readouts', () => {
  it('converts airspeed to knots and keeps altitude in feet', () => {
    const r = toRenderState(levelState({ vt: 1000, alt: 20000 }))

    expect(r.kt).toBeCloseTo(592.4838, 3)
    expect(r.altFt).toBe(20000)
    expect(r.altM).toBeCloseTo(6096, 6)
    expect(r.mach).toBeGreaterThan(0.9)
    expect(r.mach).toBeLessThan(1.1)
  })

  it('reports angles in degrees', () => {
    const r = toRenderState(levelState({ alpha: degToRad(7.5), beta: degToRad(-2.5) }))

    expect(r.alphaDeg).toBeCloseTo(7.5, 9)
    expect(r.betaDeg).toBeCloseTo(-2.5, 9)
  })
})

describe('interpolation', () => {
  it('blends position linearly', () => {
    const a = toRenderState(levelState({ pn: 0 }))
    const b = toRenderState(levelState({ pn: 1000 }))
    const mid = lerpRenderState(a, b, 0.5)

    expect(mid.position[2]).toBeCloseTo(-ftToM(500), 9)
  })

  it('slerp takes the short way round', () => {
    // q and -q are the same rotation. Interpolating naively between them travels
    // 358 degrees; on a 1/120 s tick that reads as a snap barrel roll.
    const q = quaternionFromEuler(0, 0, degToRad(10))
    const a: [number, number, number, number] = [q[1], q[2], q[3], q[0]]
    const b: [number, number, number, number] = [-a[0], -a[1], -a[2], -a[3]]

    const mid = slerp(a, b, 0.5)
    const dot = Math.abs(mid[0] * a[0] + mid[1] * a[1] + mid[2] * a[2] + mid[3] * a[3])

    expect(dot).toBeCloseTo(1, 9) // did not move
  })

  it('slerp stays unit length across the range', () => {
    const a = toRenderState(levelState({ q: quaternionFromEuler(0, 0, 0) })).quaternion
    const b = toRenderState(
      levelState({ q: quaternionFromEuler(degToRad(80), degToRad(40), degToRad(120)) }),
    ).quaternion

    for (let t = 0; t <= 1.0001; t += 0.1) {
      expect(Math.hypot(...slerp(a, b, t))).toBeCloseTo(1, 12)
    }
  })
})

describe('attitude angles (Day 3)', () => {
  const build = (phi: number, theta: number, psi: number): number[] =>
    toQuatVector({
      vt: 500,
      alpha: 0.05,
      beta: 0.01,
      q: quaternionFromEuler(phi, theta, psi),
      p: 0,
      qRate: 0,
      r: 0,
      pn: 0,
      pe: 0,
      alt: 5_000,
      power: 60,
    })

  const CASES: [string, number, number, number][] = [
    ['level, north', 0, 0, 0],
    ['nose up', 0, 0.35, 0],
    ['nose down', 0, -0.4, 0],
    ['banked right', 0.7, 0.1, 0],
    ['banked left', -0.9, -0.05, 0],
    ['heading east', 0, 0.1, Math.PI / 2],
    ['heading west', 0.3, -0.2, -Math.PI / 2],
    ['heading south', -0.4, 0.25, Math.PI * 0.98],
    ['steep and rolled', 1.2, 1.1, 2.4],
  ]

  it('reports the attitude the physics actually has', () => {
    for (const [label, phi, theta, psi] of CASES) {
      const r = toRenderState(build(phi, theta, psi))

      expect(r.pitchDeg, `${label} pitch`).toBeCloseTo((theta * 180) / Math.PI, 6)
      expect(r.rollDeg, `${label} roll`).toBeCloseTo((phi * 180) / Math.PI, 6)
      expect(r.headingDeg, `${label} heading`).toBeCloseTo(
        (((psi * 180) / Math.PI) + 360) % 360,
        6,
      )
    }
  })

  it('survives the round trip out of the render frame and back', () => {
    // `lerpRenderState` recovers these from the blended three.js quaternion, which
    // means undoing two frame changes. At t=0 and t=1 the blend is the identity, so
    // anything the round trip gets wrong shows up here as a mismatch with the
    // endpoint it was handed.
    for (const [label, phi, theta, psi] of CASES) {
      const a = toRenderState(build(phi, theta, psi))
      const b = toRenderState(build(0, 0, 0))

      const atA = lerpRenderState(a, b, 0)
      const atB = lerpRenderState(a, b, 1)

      expect(atA.pitchDeg, `${label} pitch at t=0`).toBeCloseTo(a.pitchDeg, 6)
      expect(atA.rollDeg, `${label} roll at t=0`).toBeCloseTo(a.rollDeg, 6)
      expect(atA.headingDeg, `${label} heading at t=0`).toBeCloseTo(a.headingDeg, 6)

      expect(atB.pitchDeg, `${label} pitch at t=1`).toBeCloseTo(b.pitchDeg, 6)
      expect(atB.headingDeg, `${label} heading at t=1`).toBeCloseTo(b.headingDeg, 6)
    }
  })

  it('does not flick through south when heading crosses north', () => {
    // The reason these are recomputed from the slerp instead of lerped as numbers.
    // Blending 359 and 1 as scalars gives 180: the heading readout swings through
    // due south for one frame every time the aircraft passes north.
    const a = toRenderState(build(0, 0, (-2 * Math.PI) / 180)) // 358 deg
    const b = toRenderState(build(0, 0, (2 * Math.PI) / 180)) // 002 deg

    const mid = lerpRenderState(a, b, 0.5)
    const fromNorth = Math.min(mid.headingDeg, 360 - mid.headingDeg)

    expect(fromNorth, 'heading flicked away from north mid-blend').toBeLessThan(1)
  })

  it('keeps pitch and flight path apart — the gap is angle of attack', () => {
    // §9.1's whole intuition. In a climb at positive alpha the nose is pointed above
    // the flight path, and the difference is what the flight path marker shows.
    const r = toRenderState(build(0, 0.35, 0))

    expect(r.pitchDeg).toBeGreaterThan(r.gammaDeg)
    expect(r.pitchDeg - r.gammaDeg).toBeCloseTo(r.alphaDeg, 1)
  })
})
