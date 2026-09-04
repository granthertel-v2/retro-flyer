/**
 * Six-degree-of-freedom rigid body dynamics.
 *
 * This computes the state derivative: given where the aircraft is and what the
 * controls are doing, how fast is every state changing. The integrator turns that
 * into motion; this file only answers the derivative question.
 *
 * ## The state vector, and one trap in it
 *
 * Indices and units follow the reference implementation exactly:
 *
 * ```
 *  0  vt      true airspeed         ft/s
 *  1  alpha   angle of attack       RADIANS
 *  2  beta    sideslip              RADIANS
 *  3  phi     roll angle            radians
 *  4  theta   pitch angle           radians
 *  5  psi     yaw angle             radians
 *  6  p       roll rate             rad/s
 *  7  q       pitch rate            rad/s
 *  8  r       yaw rate              rad/s
 *  9  pn      north position        ft
 * 10  pe      east position         ft
 * 11  alt     altitude              ft
 * 12  power   engine power level    percent, 0-100
 * ```
 *
 * Controls are `[throttle (0-1), elevator, aileron, rudder]` with the three
 * deflections in **DEGREES** while everything angular in the state is in radians.
 * That mix is inherited from the source and is the single most likely place to
 * introduce a silent 57x error. It is not tidied, because tidying it would put this
 * file out of step with the reference and the golden vectors that check it.
 *
 * ## Why this is Euler-based when REQUIREMENTS §3 mandates quaternions
 *
 * The physics that matters — forces, moments, rotational coupling — is attitude
 * representation agnostic. Attitude only enters through gravity and the kinematic
 * equations. So this file keeps the reference's Euler form, which is what the Tier A
 * golden vectors validate against, and `state.ts` provides the quaternion attitude
 * the simulation actually flies with. `test/quaternion.test.ts` proves the two agree.
 *
 * That split is deliberate: the gimbal-lock argument in §3 is about *integrating*
 * attitude over time, which is `state.ts`'s job. Nothing is lost by validating the
 * derivative in Euler form, and a great deal of confidence is gained.
 */

import { airData } from './atmosphere.js'
import { buildCoefficients } from './aero/buildup.js'
import { pdot, tgear, thrust } from './aero/engine.js'
import {
  ENGINE_ANGULAR_MOMENTUM,
  MEAN_CHORD,
  WING_AREA,
  WING_SPAN,
  computeMassProperties,
  type MassProperties,
} from './massProperties.js'
import { DEG_PER_RAD_MODEL, G_FT_S2 } from './units.js'
import { MIN_AIRSPEED_FPS, guardAngles } from './envelope.js'

/** Number of elements in the state vector. */
export const STATE_SIZE = 13

export const enum S {
  VT = 0,
  ALPHA = 1,
  BETA = 2,
  PHI = 3,
  THETA = 4,
  PSI = 5,
  P = 6,
  Q = 7,
  R = 8,
  PN = 9,
  PE = 10,
  ALT = 11,
  POWER = 12,
}

/** Control input. Deflections in DEGREES; see the note above. */
export interface Controls {
  /** Throttle command, 0 to 1. */
  throttle: number
  /** Elevator / stabilator deflection, degrees. Positive trailing edge down. */
  elevator: number
  /** Aileron deflection, degrees. */
  aileron: number
  /** Rudder deflection, degrees. */
  rudder: number
}

/**
 * Accelerations at the pilot station, in g.
 *
 * Not needed by the integrator, but needed by the HUD (REQUIREMENTS §9.1 asks for a
 * G readout) and by the G-limiter assist (§5), which cannot limit what it cannot
 * measure. Computed here because the intermediate terms are already to hand.
 */
export interface LoadFactors {
  /** Normal load factor, g, zeroed at 1 g so level flight reads 0. */
  nz: number
  /** Lateral load factor, g. */
  ny: number
  /** Normal acceleration at the pilot station, ft/s^2. */
  az: number
  /** Lateral acceleration at the pilot station, ft/s^2. */
  ay: number
}

export interface Derivative {
  /** d(state)/dt, same indexing as the state vector. */
  xd: number[]
  accel: LoadFactors
  /**
   * True if the flight condition fell outside the tabulated aerodynamic data and
   * the envelope guard clamped it. Always false when the guard is off.
   */
  outsideEnvelope: boolean
}

export interface DerivativeOptions {
  /**
   * Clamp alpha and beta onto the aerodynamic data envelope before looking up
   * coefficients.
   *
   * Defaults to FALSE here, so this function reproduces the reference model
   * exactly and the Tier A golden vectors stay meaningful. The integrator turns it
   * on, because a running simulation must not diverge to NaN. See `envelope.ts`
   * for why the two needs are separated.
   */
  clampAeroAngles?: boolean
}

/**
 * Distance the accelerometer sits forward of the CG, ft.
 *
 * 15 ft puts it at the pilot, which is what makes the G readout match what a pilot
 * would feel rather than what the CG experiences. Under pitch acceleration those
 * differ noticeably, which is most of why a hard pull feels sharper up front.
 */
const ACCEL_STATION_FT = 15.0

/**
 * State derivative for the 6DOF rigid body.
 *
 * Port of [AEROBENCH] subf16_model.py in Stevens (table) mode, with the hardcoded
 * inertia constants replaced by values computed from the loadout (REQUIREMENTS
 * §8.4). At the default loadout those are numerically identical, which is what lets
 * the golden vectors still apply.
 *
 * @param x     State vector, length 13
 * @param u     Controls
 * @param mass  Mass properties; defaults to the reference loadout
 */
export function derivative(
  x: readonly number[],
  u: Controls,
  mass: MassProperties = computeMassProperties(),
  opts: DerivativeOptions = {},
): Derivative {
  const rawVt = x[S.VT] as number
  const rawAlphaDeg = (x[S.ALPHA] as number) * DEG_PER_RAD_MODEL
  const rawBetaDeg = (x[S.BETA] as number) * DEG_PER_RAD_MODEL

  let alphaDeg = rawAlphaDeg
  let betaDeg = rawBetaDeg
  let outsideEnvelope = false

  if (opts.clampAeroAngles) {
    const g = guardAngles(rawAlphaDeg, rawBetaDeg)
    alphaDeg = g.alphaDeg
    betaDeg = g.betaDeg
    outsideEnvelope = g.clamped
  }

  // Airspeed floor only when guarding; the unguarded path stays bit-exact.
  const vt = opts.clampAeroAngles ? Math.max(rawVt, MIN_AIRSPEED_FPS) : rawVt
  const phi = x[S.PHI] as number
  const theta = x[S.THETA] as number
  const psi = x[S.PSI] as number
  const p = x[S.P] as number
  const q = x[S.Q] as number
  const r = x[S.R] as number
  const alt = x[S.ALT] as number
  const power = x[S.POWER] as number

  const { mach, qbar } = airData(vt, alt)

  // Engine: commanded power from throttle, then first-order lag toward it.
  const commandedPower = tgear(u.throttle)
  const powerDot = pdot(power, commandedPower)
  const thrustLb = thrust(power, alt, mach)

  const c = buildCoefficients({
    alphaDeg,
    betaDeg,
    elevatorDeg: u.elevator,
    aileronDeg: u.aileron,
    rudderDeg: u.rudder,
    p,
    q,
    r,
    vt,
    xcg: mass.xcg,
  })

  // Wind axes to body axes. u/v/w are body-frame velocity components.
  const alphaRad = x[S.ALPHA] as number
  const betaRad = x[S.BETA] as number
  const cbta = Math.cos(betaRad)
  const uBody = vt * Math.cos(alphaRad) * cbta
  const vBody = vt * Math.sin(betaRad)
  const wBody = vt * Math.sin(alphaRad) * cbta

  const sth = Math.sin(theta)
  const cth = Math.cos(theta)
  const sph = Math.sin(phi)
  const cph = Math.cos(phi)
  const spsi = Math.sin(psi)
  const cpsi = Math.cos(psi)

  const qs = qbar * WING_AREA
  const qsb = qs * WING_SPAN
  const rm = 1 / mass.mass // inverse mass, slug^-1
  const rmqs = rm * qs
  const gcth = G_FT_S2 * cth
  const qsph = q * sph

  const ay = rmqs * c.cyt
  let az = rmqs * c.czt

  // --- Force equations, body axes -----------------------------------------
  // Each is: rotational coupling (the r*v - q*w terms), plus gravity resolved
  // into that axis, plus aerodynamic and propulsive force over mass.
  const udot = r * vBody - q * wBody - G_FT_S2 * sth + rm * (qs * c.cxt + thrustLb)
  const vdot = p * wBody - r * uBody + gcth * sph + ay
  const wdot = q * uBody - p * vBody + gcth * cph + az

  const dum = uBody * uBody + wBody * wBody

  const xd = new Array<number>(STATE_SIZE).fill(0)

  // Airspeed, alpha and beta rates, expressed back in wind axes.
  xd[S.VT] = (uBody * udot + vBody * vdot + wBody * wdot) / vt
  xd[S.ALPHA] = (uBody * wdot - wBody * udot) / dum
  xd[S.BETA] = ((vt * vdot - vBody * (xd[S.VT] as number)) * cbta) / dum

  // --- Attitude kinematics -------------------------------------------------
  // The 1/cos(theta) here is the gimbal lock REQUIREMENTS §3 is worried about: it
  // blows up at theta = +/-90 deg. `state.ts` avoids it with quaternions; this form
  // exists to match the reference.
  xd[S.PHI] = p + (sth / cth) * (qsph + r * cph)
  xd[S.THETA] = q * cph - r * sph
  xd[S.PSI] = (qsph + r * cph) / cth

  // --- Moment equations ----------------------------------------------------
  // The c-constants come from the loadout-derived inertia tensor (§8.4). `he` is
  // engine angular momentum: the spinning compressor gyroscopically couples pitch
  // and yaw.
  const { c1, c2, c3, c4, c5, c6, c7, c8, c9 } = mass.moments
  const he = ENGINE_ANGULAR_MOMENTUM

  xd[S.P] = (c2 * p + c1 * r + c4 * he) * q + qsb * (c3 * c.clt + c4 * c.cnt)
  xd[S.Q] =
    (c5 * p - c7 * he) * r + c6 * (r * r - p * p) + qs * MEAN_CHORD * c7 * c.cmt
  xd[S.R] = (c8 * p - c2 * r + c9 * he) * q + qsb * (c4 * c.clt + c9 * c.cnt)

  // --- Navigation ----------------------------------------------------------
  // Body velocity rotated into the local NED frame.
  const t1 = sph * cpsi
  const t2 = cph * sth
  const t3 = sph * spsi
  const s1 = cth * cpsi
  const s2 = cth * spsi
  const s3 = t1 * sth - cph * spsi
  const s4 = t3 * sth + cph * cpsi
  const s5 = sph * cth
  const s6 = t2 * cpsi + t3
  const s7 = t2 * spsi - t1
  const s8 = cph * cth

  xd[S.PN] = uBody * s1 + vBody * s3 + wBody * s6
  xd[S.PE] = uBody * s2 + vBody * s4 + wBody * s7
  xd[S.ALT] = uBody * sth - vBody * s5 - wBody * s8

  xd[S.POWER] = powerDot

  // --- Load factors at the pilot station -----------------------------------
  // Shift the accelerometer forward of the CG. The pitch and yaw acceleration terms
  // are what make a hard pull feel sharper in the seat than at the CG.
  az = az - ACCEL_STATION_FT * (xd[S.Q] as number)
  const ayStation = ay + ACCEL_STATION_FT * (xd[S.R] as number)

  return {
    xd,
    accel: {
      nz: -az / G_FT_S2 - 1,
      ny: ayStation / G_FT_S2,
      az,
      ay: ayStation,
    },
    outsideEnvelope,
  }
}

/** Convenience: just the derivative array. */
export const stateDerivative = (
  x: readonly number[],
  u: Controls,
  mass?: MassProperties,
  opts?: DerivativeOptions,
): number[] => derivative(x, u, mass, opts).xd
