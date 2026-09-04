/**
 * The Aero -> Renderer seam (REQUIREMENTS §8.3).
 *
 * This is the ONE place where two conversions happen. Both of them are the kind of
 * thing that, done in five places, is done differently in at least one of them.
 *
 * ## 1. Units: imperial -> metric
 *
 * The physics package is imperial throughout, deliberately (see `units.ts` there:
 * every aerodynamic source is imperial, and a conversion inside the
 * validation-critical layer is a chance to introduce an error the tests would then
 * bless). So the conversion lives here, at the edge, once.
 *
 * ## 2. Frames: NED -> three.js
 *
 * These are different worlds and getting it wrong is silent. The physics uses NED:
 * x North, y East, z **Down**, with body axes x forward, y right wing, z down.
 * three.js is Y-up and its objects look down **-Z**.
 *
 * The mapping chosen:
 *
 *     three X = East        three Y = Up (altitude)      three Z = South
 *
 * which is right-handed (East x Up = South), and means an aircraft at the identity
 * attitude — wings level, nose on the horizon, heading north — needs no rotation at
 * all in three.js, because three's -Z (the direction a model faces) is North.
 *
 * That gives two constant basis changes:
 *
 *     C : NED -> three          (v_N, v_E, v_D) -> (v_E, -v_D, -v_N)
 *     B : model -> body         model +X = right wing, +Y = up, -Z = nose
 *
 * and the aircraft's render rotation is `R_three = C . R_nb . B`, where `R_nb` is
 * the body->NED rotation the physics quaternion already carries. Both C and B are
 * proper rotations (det = +1), so the product is one too and converts cleanly back
 * to a quaternion.
 *
 * ## What this file must not do
 *
 * It must not import three.js. Keeping it pure is what lets `test/seam.test.ts`
 * check the frame conversion in Node — and frame conversion is exactly the kind of
 * bug that otherwise gets found by squinting at a screen for an hour.
 *
 * It also never writes to the model. §8.3 is one-directional by contract.
 */

import {
  airData,
  fromQuatVector,
  radToDeg,
  ftToM,
  fpsToKt,
  type AircraftState,
  type Quaternion,
} from '@retro-flyer/physics'

/** A 3x3 matrix in row-major order. */
type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
]

/**
 * NED -> three.js basis change: `(v_N, v_E, v_D) -> (v_E, -v_D, -v_N)`.
 *
 * East becomes +X, Up becomes +Y, South becomes +Z.
 */
export const NED_TO_THREE: Mat3 = [
  0, 1, 0,
  0, 0, -1,
  -1, 0, 0,
]

/**
 * Model -> body basis change.
 *
 * The aircraft model is authored to three.js convention — nose down -Z, up +Y,
 * right wing +X — so that it needs no rotation at the identity attitude. In body
 * axes (x nose, y right, z down) those directions are:
 *
 *     model +X (right) = body  (0, 1, 0)
 *     model +Y (up)    = body  (0, 0, -1)
 *     model +Z (back)  = body  (-1, 0, 0)
 */
export const MODEL_TO_BODY: Mat3 = [
  0, 0, -1,
  1, 0, 0,
  0, -1, 0,
]

/** Rotation matrix from a Hamilton quaternion `[w, x, y, z]`, body -> NED. */
export function rotationFromQuaternion(q: Quaternion): Mat3 {
  const [w, x, y, z] = q

  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ]
}

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9)

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        (a[row * 3] as number) * (b[col] as number) +
        (a[row * 3 + 1] as number) * (b[3 + col] as number) +
        (a[row * 3 + 2] as number) * (b[6 + col] as number)
    }
  }

  return out as unknown as Mat3
}

/** Apply a matrix to a column vector. */
export function applyMat3(m: Mat3, v: readonly [number, number, number]): [number, number, number] {
  return [
    (m[0] as number) * v[0] + (m[1] as number) * v[1] + (m[2] as number) * v[2],
    (m[3] as number) * v[0] + (m[4] as number) * v[1] + (m[5] as number) * v[2],
    (m[6] as number) * v[0] + (m[7] as number) * v[1] + (m[8] as number) * v[2],
  ]
}

/**
 * Quaternion from a rotation matrix, in three.js `[x, y, z, w]` order.
 *
 * Branch selection is not optional here. The naive `w = sqrt(1 + trace) / 2` form
 * divides by something near zero for rotations near 180 degrees and loses most of
 * its precision on the way — which for an aircraft means the attitude goes to
 * garbage precisely when inverted. Picking the largest diagonal term avoids that.
 */
export function quaternionFromMatrix(m: Mat3): [number, number, number, number] {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m as unknown as number[] as [
    number, number, number, number, number, number, number, number, number,
  ]

  const trace = m00 + m11 + m22

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    return [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]
  }

  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  }

  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
  }

  const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
}

/**
 * Everything the renderer is allowed to know about the aircraft.
 *
 * Metres, three.js axes, three.js quaternion order. The imperial readouts that
 * survive (`kt`, `altFt`, `mach`) are here because they are what a pilot reads and
 * what the overlay and, later, the §9.1 HUD display — they are display strings, not
 * simulation state.
 */
export interface RenderState {
  /** Position in three.js world space, metres. */
  position: [number, number, number]
  /** Attitude as a three.js quaternion, `[x, y, z, w]`. */
  quaternion: [number, number, number, number]
  /** Velocity in three.js world space, metres per second. */
  velocity: [number, number, number]

  /** True airspeed, knots. */
  kt: number
  /** Altitude above sea level, feet. */
  altFt: number
  /** Altitude above sea level, metres — the value that matches `position[1]`. */
  altM: number
  mach: number
  /** Angle of attack, degrees. */
  alphaDeg: number
  /** Sideslip, degrees. */
  betaDeg: number
  /** Roll, pitch and yaw rates, degrees per second. */
  rates: [number, number, number]
  /** Engine power level, percent. */
  power: number
}

/**
 * Convert one physics state vector into everything the renderer needs.
 *
 * Takes the raw 14-element quaternion vector rather than an `AircraftState` because
 * that is what the integrator hands back, and converting it twice per frame is
 * pointless work.
 */
export function toRenderState(v: readonly number[]): RenderState {
  const s: AircraftState = fromQuatVector(v)
  const air = airData(s.vt, s.alt)

  const rNb = rotationFromQuaternion(s.q)

  // Body-frame velocity components. Same relation the dynamics uses internally:
  // u along the nose, v out the right wing, w down.
  const cosBeta = Math.cos(s.beta)
  const bodyVel: [number, number, number] = [
    s.vt * Math.cos(s.alpha) * cosBeta,
    s.vt * Math.sin(s.beta),
    s.vt * Math.sin(s.alpha) * cosBeta,
  ]

  const nedVel = applyMat3(rNb, bodyVel)
  const threeVel = applyMat3(NED_TO_THREE, nedVel)

  const rThree = multiplyMat3(multiplyMat3(NED_TO_THREE, rNb), MODEL_TO_BODY)

  return {
    position: [ftToM(s.pe), ftToM(s.alt), -ftToM(s.pn)],
    quaternion: quaternionFromMatrix(rThree),
    velocity: [ftToM(threeVel[0]), ftToM(threeVel[1]), ftToM(threeVel[2])],

    kt: fpsToKt(s.vt),
    altFt: s.alt,
    altM: ftToM(s.alt),
    mach: air.mach,
    alphaDeg: radToDeg(s.alpha),
    betaDeg: radToDeg(s.beta),
    rates: [radToDeg(s.p), radToDeg(s.qRate), radToDeg(s.r)],
    power: s.power,
  }
}

/**
 * Blend two render states.
 *
 * Physics runs at a fixed 120 Hz and the display does not, so the renderer draws
 * between the last two ticks using `FixedStepClock.alpha` (§8.3). Without this the
 * aircraft visibly stutters at any frame rate that is not a divisor of 120 — which
 * is most of them, including 60 Hz under any load at all.
 *
 * Position and velocity interpolate linearly; attitude has to slerp, because
 * lerping a quaternion and renormalising gives non-uniform angular velocity — a
 * fast roll would visibly speed up and slow down within a single tick.
 */
export function lerpRenderState(a: RenderState, b: RenderState, t: number): RenderState {
  const lerp = (x: number, y: number): number => x + (y - x) * t
  const lerp3 = (
    x: [number, number, number],
    y: [number, number, number],
  ): [number, number, number] => [lerp(x[0], y[0]), lerp(x[1], y[1]), lerp(x[2], y[2])]

  return {
    position: lerp3(a.position, b.position),
    quaternion: slerp(a.quaternion, b.quaternion, t),
    velocity: lerp3(a.velocity, b.velocity),

    kt: lerp(a.kt, b.kt),
    altFt: lerp(a.altFt, b.altFt),
    altM: lerp(a.altM, b.altM),
    mach: lerp(a.mach, b.mach),
    alphaDeg: lerp(a.alphaDeg, b.alphaDeg),
    betaDeg: lerp(a.betaDeg, b.betaDeg),
    rates: lerp3(a.rates, b.rates),
    power: lerp(a.power, b.power),
  }
}

/**
 * Spherical linear interpolation between two three.js-order quaternions.
 *
 * The sign flip matters: `q` and `-q` are the same rotation, so without choosing the
 * shorter arc an interpolation can take the 358-degree route. On a physics tick that
 * shows up as the aircraft snapping through a full barrel roll in 8 milliseconds.
 */
export function slerp(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
  t: number,
): [number, number, number, number] {
  let [bx, by, bz, bw] = b
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw

  if (dot < 0) {
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    dot = -dot
  }

  // Near-parallel: sin(theta) underflows and the general form divides by ~0.
  // Linear interpolation is indistinguishable at this angle anyway.
  if (dot > 0.9995) {
    const out: [number, number, number, number] = [
      a[0] + (bx - a[0]) * t,
      a[1] + (by - a[1]) * t,
      a[2] + (bz - a[2]) * t,
      a[3] + (bw - a[3]) * t,
    ]
    const n = Math.hypot(out[0], out[1], out[2], out[3])
    return [out[0] / n, out[1] / n, out[2] / n, out[3] / n]
  }

  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / sinTheta
  const wb = Math.sin(t * theta) / sinTheta

  return [
    a[0] * wa + bx * wb,
    a[1] * wa + by * wb,
    a[2] * wa + bz * wb,
    a[3] * wa + bw * wb,
  ]
}
