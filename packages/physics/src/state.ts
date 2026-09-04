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
  NO_EXTERNAL_LOADS,
  S,
  STATE_SIZE,
  type Controls,
  type DerivativeOptions,
  type ExternalLoads,
  type LoadFactors,
  forcesAndMoments,
} from './dynamics.js'
import { computeMassProperties, type MassProperties } from './massProperties.js'
import { MIN_AIRSPEED_FPS, guardAngles } from './envelope.js'
import { DEG_PER_RAD_MODEL } from './units.js'

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
 * Layout: `[u, v, w, qw, qx, qy, qz, p, q, r, pn, pe, alt, power]`.
 *
 * ## Why body velocity rather than (vt, alpha, beta)
 *
 * The reference model stores velocity in wind axes and integrates `alpha` as a
 * state. Its derivative, from `dynamics.ts`, is
 *
 * ```
 *   alphaDot = (u * wdot - w * udot) / (u^2 + w^2)   ~=   wdot / vt
 * ```
 *
 * so **any body-normal acceleration is amplified by 1/vt**. In flight that is a
 * division by five hundred and nobody notices. On a runway it is a division by
 * nothing. Measured on this model, from gravity alone and with no gear force at all:
 * 0.4 deg/s of alphaDot at 500 ft/s, 91 deg/s at 20 ft/s, and 1,833 deg/s at 1 ft/s
 * — fifteen degrees of alpha in a single 120 Hz tick.
 *
 * That is not a defect in the reference. At 1 ft/s a falling body really does change
 * incidence that fast; the number is right. It is the *state variable* that is
 * wrong, and only for a regime the reference never enters. Landing gear struts
 * inject body-normal accelerations by construction and a takeoff roll begins at
 * zero airspeed, so REQUIREMENTS §9's Day 3 cannot be built on the wind-axis form.
 *
 * Integrating `u, v, w` removes the term rather than bounding it. There is no
 * division by airspeed anywhere in the body-axis force equations, so standing still
 * is not a special case, and `alpha` becomes `atan2(w, u)` — a derived quantity,
 * always in (-180, 180] by construction.
 *
 * ## What this costs, and what it buys back
 *
 * It costs nothing in fidelity: the conversion between the two is exact both ways
 * (`test/bodyAxis.test.ts` flies them side by side and confirms it), and
 * `dynamics.ts` keeps the reference's wind-axis tail untouched for the Tier A
 * vectors. Both formulations share one force model.
 *
 * It buys back the alpha-wrapping fix from Day 2. That bug — a tumble running alpha
 * to 1,477 degrees while real incidence was 37, pinning the aero table clamp and
 * making departures unrecoverable — existed only because alpha was integrated.
 * Derived from `atan2`, it cannot leave its range, so the guard that corrected it
 * has been deleted rather than kept.
 *
 * `AircraftState` still presents `vt`, `alpha` and `beta`, so the control package,
 * the renderer seam and the app are unaffected by any of this.
 */
export const QUAT_STATE_SIZE = 14

export const enum Q {
  /** Body-frame velocity, ft/s: x forward, y right, z down. */
  U = 0,
  V = 1,
  W = 2,
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

/**
 * Body velocity components from airspeed and the aerodynamic angles.
 *
 * The same three lines `dynamics.ts` uses, and the exact inverse of `aeroAngles`.
 */
export function bodyVelocity(
  vt: number,
  alpha: number,
  beta: number,
): [number, number, number] {
  const cbta = Math.cos(beta)
  return [vt * Math.cos(alpha) * cbta, vt * Math.sin(beta), vt * Math.sin(alpha) * cbta]
}

export interface AeroAngles {
  /** Airspeed, ft/s. */
  vt: number
  /** Angle of attack, radians. Always in (-pi, pi] — it is an `atan2`. */
  alpha: number
  /** Sideslip, radians. */
  beta: number
}

/**
 * Airspeed and the aerodynamic angles from body velocity.
 *
 * At a dead standstill neither angle is defined — there is no relative wind to have
 * an angle to — and `asin(0/0)` is NaN, which would propagate through the entire
 * state within one tick and be thoroughly unpleasant to trace. Zero velocity
 * therefore reports zero for both, which is the value the aircraft will have as soon
 * as it starts moving straight ahead, and is the only defensible answer. A cold
 * start on a runway hits this on tick one.
 */
export function aeroAngles(u: number, v: number, w: number): AeroAngles {
  const vt = Math.hypot(u, v, w)
  if (vt === 0) return { vt: 0, alpha: 0, beta: 0 }

  const s = v / vt
  return {
    vt,
    alpha: Math.atan2(w, u),
    beta: Math.asin(s < -1 ? -1 : s > 1 ? 1 : s),
  }
}

export function toQuatVector(s: AircraftState): number[] {
  const [u, v, w] = bodyVelocity(s.vt, s.alpha, s.beta)
  return [
    u, v, w,
    s.q[0], s.q[1], s.q[2], s.q[3],
    s.p, s.qRate, s.r,
    s.pn, s.pe, s.alt, s.power,
  ]
}

export function fromQuatVector(v: readonly number[]): AircraftState {
  const a = aeroAngles(v[Q.U] as number, v[Q.V] as number, v[Q.W] as number)

  return {
    vt: a.vt,
    alpha: a.alpha,
    beta: a.beta,
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
  /**
   * Acceleration along the flight path, ft/s^2 — `d(vt)/dt`.
   *
   * Not a state any more, but the app's speed cues read it (§6): it is the
   * acceleration a pilot feels in their back, as distinct from `nz`, which is the
   * one that pushes them into the seat. Returned rather than recomputed because the
   * terms are already here.
   */
  vtDot: number
}

/**
 * State derivative in body-axis quaternion form.
 *
 * Shares `forcesAndMoments` with the reference path in `dynamics.ts` and differs
 * only in the tail: where that converts body accelerations back into wind-axis
 * rates, this returns them directly.
 *
 * The airspeed floor is still here, but it now guards only the *lookups* — the
 * damping coefficients nondimensionalise on `b/2V`, and `airData` divides by the
 * speed of sound. It no longer touches a state derivative. That is a much better
 * place for it: below the floor, dynamic pressure is effectively zero, so whatever
 * the damping terms say is multiplied by nothing.
 */
export function quatDerivative(
  v: readonly number[],
  u: Controls,
  mass: MassProperties = computeMassProperties(),
  opts: DerivativeOptions = { clampAeroAngles: true },
  ext: ExternalLoads = NO_EXTERNAL_LOADS,
): QuatDerivative {
  const q: Quaternion = [
    v[Q.QW] as number,
    v[Q.QX] as number,
    v[Q.QY] as number,
    v[Q.QZ] as number,
  ]
  const { phi, theta, psi } = eulerFromQuaternion(q)

  const uBody = v[Q.U] as number
  const vBody = v[Q.V] as number
  const wBody = v[Q.W] as number

  const a = aeroAngles(uBody, vBody, wBody)
  const vtAero = Math.max(a.vt, MIN_AIRSPEED_FPS)

  const rawAlphaDeg = a.alpha * DEG_PER_RAD_MODEL
  const rawBetaDeg = a.beta * DEG_PER_RAD_MODEL

  let alphaDeg = rawAlphaDeg
  let betaDeg = rawBetaDeg
  let outsideEnvelope = false

  if (opts.clampAeroAngles) {
    const g = guardAngles(rawAlphaDeg, rawBetaDeg)
    alphaDeg = g.alphaDeg
    betaDeg = g.betaDeg
    outsideEnvelope = g.clamped
  }

  const core = forcesAndMoments(
    {
      uBody,
      vBody,
      wBody,
      vt: vtAero,
      alphaDeg,
      betaDeg,
      phi,
      theta,
      psi,
      p: v[Q.P] as number,
      q: v[Q.Q_RATE] as number,
      r: v[Q.R] as number,
      alt: v[Q.ALT] as number,
      power: v[Q.POWER] as number,
    },
    u,
    mass,
    ext,
  )

  const qd = quaternionDerivative(
    q,
    v[Q.P] as number,
    v[Q.Q_RATE] as number,
    v[Q.R] as number,
  )

  return {
    vd: [
      core.udot, core.vdot, core.wdot,
      qd[0], qd[1], qd[2], qd[3],
      core.pdot, core.qdot, core.rdot,
      core.pnDot, core.peDot, core.altDot,
      core.powerDot,
    ],
    accel: core.accel,
    outsideEnvelope,
    vtDot:
      (uBody * core.udot + vBody * core.vdot + wBody * core.wdot) / vtAero,
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
