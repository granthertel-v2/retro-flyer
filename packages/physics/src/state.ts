/**
 * Aircraft state with quaternion attitude (REQUIREMENTS §3).
 *
 * ## Why quaternions, concretely
 *
 * The Euler kinematic equations in `dynamics.ts` contain `1/cos(theta)`. At 90
 * degrees of pitch that is a division by zero, and near it the yaw rate goes
 * arbitrarily large — the integrator takes a wild step and the attitude is
 * destroyed. This is gimbal lock, and it is not an exotic corner case for this
 * airframe: a vertical climb passes straight through it.
 *
 * A quaternion has no such singularity. Attitude integrates smoothly through
 * vertical, inverted, anywhere.
 *
 * ## The arrangement
 *
 * The forces and moments do not care how attitude is represented — they depend on
 * alpha, beta, body rates, and controls. Attitude enters only through gravity and
 * through the kinematic equations. So:
 *
 * - `dynamics.ts` keeps the reference's Euler form and is validated against the
 *   golden vectors at 1e-12.
 * - This file integrates attitude as a quaternion, converting to Euler only to
 *   evaluate that derivative.
 *
 * The conversion is exact away from the singularity, so nothing is approximated.
 * `test/quaternion.test.ts` flies both representations side by side and confirms
 * they agree — and confirms that the Euler form breaks near vertical while this one
 * does not.
 *
 * ## Convention
 *
 * Hamilton quaternion, `[w, x, y, z]`, rotating body frame to NED (north-east-down).
 * Body axes are x forward, y right, z down.
 */

import {
  S,
  STATE_SIZE,
  type Controls,
  type DerivativeOptions,
  type LoadFactors,
  derivative,
} from './dynamics.js'
import { computeMassProperties, type MassProperties } from './massProperties.js'

/** Hamilton quaternion `[w, x, y, z]`. */
export type Quaternion = readonly [number, number, number, number]

/** The identity rotation: wings level, nose on the horizon, heading north. */
export const IDENTITY_QUATERNION: Quaternion = [1, 0, 0, 0]

export interface AircraftState {
  /** True airspeed, ft/s. */
  vt: number
  /** Angle of attack, radians. */
  alpha: number
  /** Sideslip, radians. */
  beta: number
  /** Attitude, body to NED. */
  q: Quaternion
  /** Roll rate, rad/s. */
  p: number
  /** Pitch rate, rad/s. */
  qRate: number
  /** Yaw rate, rad/s. */
  r: number
  /** North position, ft. */
  pn: number
  /** East position, ft. */
  pe: number
  /** Altitude, ft. */
  alt: number
  /** Engine power level, percent. */
  power: number
}

// ---------------------------------------------------------------------------
// Quaternion arithmetic
// ---------------------------------------------------------------------------

export function normalize(q: Quaternion): Quaternion {
  const n = Math.hypot(q[0], q[1], q[2], q[3])
  if (n === 0) return IDENTITY_QUATERNION
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]
}

/**
 * Quaternion from Euler angles, 3-2-1 (yaw, then pitch, then roll).
 *
 * The ordering matters: aerospace convention rotates about z, then the new y, then
 * the new x. A different order produces a different attitude from the same numbers.
 */
export function quaternionFromEuler(phi: number, theta: number, psi: number): Quaternion {
  const cr = Math.cos(phi / 2)
  const sr = Math.sin(phi / 2)
  const cp = Math.cos(theta / 2)
  const sp = Math.sin(theta / 2)
  const cy = Math.cos(psi / 2)
  const sy = Math.sin(psi / 2)

  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ]
}

export interface EulerAngles {
  /** Roll, radians. */
  phi: number
  /** Pitch, radians. */
  theta: number
  /** Yaw, radians. */
  psi: number
}

/**
 * Euler angles from a quaternion.
 *
 * The `asin` argument is clamped to [-1, 1]. Without that clamp, accumulated
 * floating-point error at exactly vertical yields an argument like 1.0000000002 and
 * `asin` returns NaN, which then propagates through the entire state and is
 * extremely annoying to trace back to its origin.
 *
 * At |pitch| = 90 degrees roll and yaw are not separately defined — that is the
 * gimbal singularity, and it is a property of Euler angles, not of the attitude.
 * The quaternion is still perfectly well defined there; only this *view* of it
 * degenerates.
 */
export function eulerFromQuaternion(q: Quaternion): EulerAngles {
  const [w, x, y, z] = q

  const sinp = 2 * (w * y - z * x)
  const clamped = Math.min(1, Math.max(-1, sinp))

  return {
    phi: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    theta: Math.asin(clamped),
    psi: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  }
}

/**
 * Quaternion rate from body angular rates.
 *
 * `q_dot = 0.5 * q * omega`, with omega the pure quaternion `[0, p, q, r]`. No
 * trigonometry, no division, no singularity — which is the entire point.
 */
export function quaternionDerivative(
  q: Quaternion,
  p: number,
  qRate: number,
  r: number,
): [number, number, number, number] {
  const [w, x, y, z] = q

  return [
    0.5 * (-x * p - y * qRate - z * r),
    0.5 * (w * p + y * r - z * qRate),
    0.5 * (w * qRate - x * r + z * p),
    0.5 * (w * r + x * qRate - y * p),
  ]
}

// ---------------------------------------------------------------------------
// Conversion to and from the Euler state vector the dynamics uses
// ---------------------------------------------------------------------------

/** Pack an `AircraftState` into the 13-element vector `dynamics.derivative` wants. */
export function toStateVector(s: AircraftState): number[] {
  const { phi, theta, psi } = eulerFromQuaternion(s.q)
  const x = new Array<number>(STATE_SIZE).fill(0)

  x[S.VT] = s.vt
  x[S.ALPHA] = s.alpha
  x[S.BETA] = s.beta
  x[S.PHI] = phi
  x[S.THETA] = theta
  x[S.PSI] = psi
  x[S.P] = s.p
  x[S.Q] = s.qRate
  x[S.R] = s.r
  x[S.PN] = s.pn
  x[S.PE] = s.pe
  x[S.ALT] = s.alt
  x[S.POWER] = s.power

  return x
}

/** Build an `AircraftState` from a 13-element Euler state vector. */
export function fromStateVector(x: readonly number[]): AircraftState {
  return {
    vt: x[S.VT] as number,
    alpha: x[S.ALPHA] as number,
    beta: x[S.BETA] as number,
    q: quaternionFromEuler(x[S.PHI] as number, x[S.THETA] as number, x[S.PSI] as number),
    p: x[S.P] as number,
    qRate: x[S.Q] as number,
    r: x[S.R] as number,
    pn: x[S.PN] as number,
    pe: x[S.PE] as number,
    alt: x[S.ALT] as number,
    power: x[S.POWER] as number,
  }
}

/**
 * The quaternion state as a flat array, for the integrator.
 *
 * Layout: `[vt, alpha, beta, qw, qx, qy, qz, p, q, r, pn, pe, alt, power]`.
 * Fourteen elements — one more than the Euler form, since a quaternion carries four
 * numbers where Euler angles carry three. That redundancy is what buys the
 * singularity-free behavior.
 */
export const QUAT_STATE_SIZE = 14

export const enum Q {
  VT = 0,
  ALPHA = 1,
  BETA = 2,
  QW = 3,
  QX = 4,
  QY = 5,
  QZ = 6,
  P = 7,
  Q_RATE = 8,
  R = 9,
  PN = 10,
  PE = 11,
  ALT = 12,
  POWER = 13,
}

export function toQuatVector(s: AircraftState): number[] {
  return [
    s.vt, s.alpha, s.beta,
    s.q[0], s.q[1], s.q[2], s.q[3],
    s.p, s.qRate, s.r,
    s.pn, s.pe, s.alt, s.power,
  ]
}

export function fromQuatVector(v: readonly number[]): AircraftState {
  return {
    vt: v[Q.VT] as number,
    alpha: v[Q.ALPHA] as number,
    beta: v[Q.BETA] as number,
    q: [v[Q.QW] as number, v[Q.QX] as number, v[Q.QY] as number, v[Q.QZ] as number],
    p: v[Q.P] as number,
    qRate: v[Q.Q_RATE] as number,
    r: v[Q.R] as number,
    pn: v[Q.PN] as number,
    pe: v[Q.PE] as number,
    alt: v[Q.ALT] as number,
    power: v[Q.POWER] as number,
  }
}

export interface QuatDerivative {
  /** d(state)/dt in quaternion layout. */
  vd: number[]
  accel: LoadFactors
  /** True if the aerodynamic envelope guard engaged this step. */
  outsideEnvelope: boolean
}

/**
 * State derivative in quaternion form.
 *
 * Converts to Euler purely to evaluate the aerodynamics — which do not depend on
 * attitude representation — then discards the Euler *rates* and substitutes the
 * quaternion rate. So the singular `1/cos(theta)` term is computed and thrown away
 * rather than integrated, which is what keeps it from ever mattering.
 */
export function quatDerivative(
  v: readonly number[],
  u: Controls,
  mass: MassProperties = computeMassProperties(),
  opts: DerivativeOptions = { clampAeroAngles: true },
): QuatDerivative {
  const q: Quaternion = [
    v[Q.QW] as number,
    v[Q.QX] as number,
    v[Q.QY] as number,
    v[Q.QZ] as number,
  ]
  const { phi, theta, psi } = eulerFromQuaternion(q)

  const x = new Array<number>(STATE_SIZE).fill(0)
  x[S.VT] = v[Q.VT] as number
  x[S.ALPHA] = v[Q.ALPHA] as number
  x[S.BETA] = v[Q.BETA] as number
  x[S.PHI] = phi
  x[S.THETA] = theta
  x[S.PSI] = psi
  x[S.P] = v[Q.P] as number
  x[S.Q] = v[Q.Q_RATE] as number
  x[S.R] = v[Q.R] as number
  x[S.PN] = v[Q.PN] as number
  x[S.PE] = v[Q.PE] as number
  x[S.ALT] = v[Q.ALT] as number
  x[S.POWER] = v[Q.POWER] as number

  const d = derivative(x, u, mass, opts)

  const qd = quaternionDerivative(
    q,
    v[Q.P] as number,
    v[Q.Q_RATE] as number,
    v[Q.R] as number,
  )

  return {
    vd: [
      d.xd[S.VT] as number,
      d.xd[S.ALPHA] as number,
      d.xd[S.BETA] as number,
      qd[0], qd[1], qd[2], qd[3],
      d.xd[S.P] as number,
      d.xd[S.Q] as number,
      d.xd[S.R] as number,
      d.xd[S.PN] as number,
      d.xd[S.PE] as number,
      d.xd[S.ALT] as number,
      d.xd[S.POWER] as number,
    ],
    accel: d.accel,
    outsideEnvelope: d.outsideEnvelope,
  }
}

/** Renormalize the quaternion in a state vector, in place-safe fashion. */
export function renormalizeQuat(v: number[]): void {
  const n = Math.hypot(
    v[Q.QW] as number,
    v[Q.QX] as number,
    v[Q.QY] as number,
    v[Q.QZ] as number,
  )
  if (n === 0) {
    v[Q.QW] = 1
    v[Q.QX] = 0
    v[Q.QY] = 0
    v[Q.QZ] = 0
    return
  }
  v[Q.QW] = (v[Q.QW] as number) / n
  v[Q.QX] = (v[Q.QX] as number) / n
  v[Q.QY] = (v[Q.QY] as number) / n
  v[Q.QZ] = (v[Q.QZ] as number) / n
}
