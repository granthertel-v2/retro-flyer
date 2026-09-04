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
 *
 * ## One force model, two tails
 *
 * The same argument runs one level down, and Day 3 is what forced it. Forces and
 * moments do not care how *velocity* is represented either — they depend on alpha,
 * beta, the body rates and the controls. Velocity representation enters only in the
 * last step, converting body accelerations into whatever the state happens to store.
 *
 * So `forcesAndMoments()` below owns everything up to and including
 * `udot / vdot / wdot`, and two thin tails consume it:
 *
 * - `derivative()` here converts those back into `vt / alpha / beta` rates, which is
 *   the reference's wind-axis form and what the Tier A vectors pin at 1e-12.
 * - `quatDerivative()` in `state.ts` does not convert at all: it integrates
 *   `u, v, w` directly, because the wind-axis conversion divides by airspeed and the
 *   ground cases cannot survive that. See the note on that function.
 *
 * The extraction is arithmetic-order preserving, so the reference path is bit-exact
 * and the golden vectors are the proof of it.
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
 * Forces and moments from something that is not the air, in body axes.
 *
 * This is the seam Day 3's landing gear arrives through (REQUIREMENTS §3 lists gear
 * as spring-damper ground reaction, labelled `[A]`). Forces in lb, moments in ft-lb,
 * both about the CG, both in the body frame — x forward, y right, z down.
 *
 * It defaults to zero and `derivative()` never passes anything else, which is what
 * keeps the reference path exactly the reference path. Adding zero is exact in
 * IEEE 754, so the golden vectors do not merely tolerate this seam, they prove it
 * inert when unused.
 */
export interface ExternalLoads {
  fx: number
  fy: number
  fz: number
  /** Rolling moment, ft-lb. */
  l: number
  /** Pitching moment, ft-lb. */
  m: number
  /** Yawing moment, ft-lb. */
  n: number
}

export const NO_EXTERNAL_LOADS: ExternalLoads = { fx: 0, fy: 0, fz: 0, l: 0, m: 0, n: 0 }

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
 * Everything `forcesAndMoments` needs that is not a control input.
 *
 * Note that `vt` is passed in rather than derived from `uBody/vBody/wBody`. The two
 * callers hold different things exactly: the wind-axis path has `vt` as a state
 * variable and derives the body components from it, while the body-axis path has the
 * components and derives `vt`. Recovering `vt` here with a `hypot` would send the
 * wind-axis path on a round trip through trigonometry and cost it the last few bits
 * — which is precisely the 1e-12 the Tier A vectors are checking.
 */
export interface CoreInputs {
  /** Body-frame velocity, ft/s. x forward, y right, z down. */
  uBody: number
  vBody: number
  wBody: number
  /** Airspeed magnitude, ft/s. See above for why this is not derived. */
  vt: number
  /** Aerodynamic angles for table lookup, DEGREES, already guarded by the caller. */
  alphaDeg: number
  betaDeg: number
  phi: number
  theta: number
  psi: number
  p: number
  q: number
  r: number
  alt: number
  power: number
}

/**
 * The representation-independent half of the derivative.
 *
 * Body accelerations, angular accelerations, the NED velocity and the engine — none
 * of which care whether the caller stores velocity as `(vt, alpha, beta)` or as
 * `(u, v, w)`.
 */
export interface Core {
  /** Body-frame accelerations, ft/s^2. */
  udot: number
  vdot: number
  wdot: number
  /** Body angular accelerations, rad/s^2. */
  pdot: number
  qdot: number
  rdot: number
  powerDot: number
  /** NED velocity, ft/s. `altDot` is positive up, so it is minus the down rate. */
  pnDot: number
  peDot: number
  altDot: number
  accel: LoadFactors
}

/**
 * Forces, moments and the accelerations they produce.
 *
 * Port of the force and moment half of [AEROBENCH] subf16_model.py in Stevens
 * (table) mode, with the hardcoded inertia constants replaced by values computed
 * from the loadout (REQUIREMENTS §8.4). At the default loadout those are numerically
 * identical, which is what lets the golden vectors still apply.
 */
export function forcesAndMoments(
  k: CoreInputs,
  u: Controls,
  mass: MassProperties = computeMassProperties(),
  ext: ExternalLoads = NO_EXTERNAL_LOADS,
): Core {
  const { mach, qbar } = airData(k.vt, k.alt)

  // Engine: commanded power from throttle, then first-order lag toward it.
  const commandedPower = tgear(u.throttle)
  const powerDot = pdot(k.power, commandedPower)
  const thrustLb = thrust(k.power, k.alt, mach)

  const c = buildCoefficients({
    alphaDeg: k.alphaDeg,
    betaDeg: k.betaDeg,
    elevatorDeg: u.elevator,
    aileronDeg: u.aileron,
    rudderDeg: u.rudder,
    p: k.p,
    q: k.q,
    r: k.r,
    vt: k.vt,
    xcg: mass.xcg,
  })

  const uBody = k.uBody
  const vBody = k.vBody
  const wBody = k.wBody
  const p = k.p
  const q = k.q
  const r = k.r

  const sth = Math.sin(k.theta)
  const cth = Math.cos(k.theta)
  const sph = Math.sin(k.phi)
  const cph = Math.cos(k.phi)
  const spsi = Math.sin(k.psi)
  const cpsi = Math.cos(k.psi)

  const qs = qbar * WING_AREA
  const qsb = qs * WING_SPAN
  const rm = 1 / mass.mass // inverse mass, slug^-1
  const rmqs = rm * qs
  const gcth = G_FT_S2 * cth

  // External loads join the aerodynamic specific forces here rather than being
  // added afterwards, so that the accelerometer below reads them too. That is not a
  // detail: an accelerometer sitting on a runway reads 1 g, and the only thing
  // holding the aircraft up is the gear.
  const ay = rmqs * c.cyt + rm * ext.fy
  let az = rmqs * c.czt + rm * ext.fz

  // --- Force equations, body axes -----------------------------------------
  // Each is: rotational coupling (the r*v - q*w terms), plus gravity resolved
  // into that axis, plus aerodynamic and propulsive force over mass.
  const udot = r * vBody - q * wBody - G_FT_S2 * sth + rm * (qs * c.cxt + thrustLb + ext.fx)
  const vdot = p * wBody - r * uBody + gcth * sph + ay
  const wdot = q * uBody - p * vBody + gcth * cph + az

  // --- Moment equations ----------------------------------------------------
  // The c-constants come from the loadout-derived inertia tensor (§8.4). `he` is
  // engine angular momentum: the spinning compressor gyroscopically couples pitch
  // and yaw. The same constants carry the inertia inverse for the external moments,
  // which is why those enter dimensionally rather than as coefficients.
  const { c1, c2, c3, c4, c5, c6, c7, c8, c9 } = mass.moments
  const he = ENGINE_ANGULAR_MOMENTUM

  const pdotBody =
    (c2 * p + c1 * r + c4 * he) * q + qsb * (c3 * c.clt + c4 * c.cnt) + (c3 * ext.l + c4 * ext.n)
  const qdotBody =
    (c5 * p - c7 * he) * r + c6 * (r * r - p * p) + qs * MEAN_CHORD * c7 * c.cmt + c7 * ext.m
  const rdotBody =
    (c8 * p - c2 * r + c9 * he) * q + qsb * (c4 * c.clt + c9 * c.cnt) + (c4 * ext.l + c9 * ext.n)

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

  // --- Load factors at the pilot station -----------------------------------
  // Shift the accelerometer forward of the CG. The pitch and yaw acceleration terms
  // are what make a hard pull feel sharper in the seat than at the CG.
  az = az - ACCEL_STATION_FT * qdotBody
  const ayStation = ay + ACCEL_STATION_FT * rdotBody

  return {
    udot,
    vdot,
    wdot,
    pdot: pdotBody,
    qdot: qdotBody,
    rdot: rdotBody,
    powerDot,
    pnDot: uBody * s1 + vBody * s3 + wBody * s6,
    peDot: uBody * s2 + vBody * s4 + wBody * s7,
    altDot: uBody * sth - vBody * s5 - wBody * s8,
    accel: {
      nz: -az / G_FT_S2 - 1,
      ny: ayStation / G_FT_S2,
      az,
      ay: ayStation,
    },
  }
}

/**
 * State derivative for the 6DOF rigid body, in the reference's wind-axis form.
 *
 * This is the function the Tier A golden vectors validate. It takes no external
 * loads, because the reference model has none and a path that could carry them is a
 * path that could differ from the reference.
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

  // Wind axes to body axes. u/v/w are body-frame velocity components.
  const alphaRad = x[S.ALPHA] as number
  const betaRad = x[S.BETA] as number
  const cbta = Math.cos(betaRad)
  const uBody = vt * Math.cos(alphaRad) * cbta
  const vBody = vt * Math.sin(betaRad)
  const wBody = vt * Math.sin(alphaRad) * cbta

  const core = forcesAndMoments(
    {
      uBody,
      vBody,
      wBody,
      vt,
      alphaDeg,
      betaDeg,
      phi,
      theta,
      psi,
      p,
      q,
      r,
      alt: x[S.ALT] as number,
      power: x[S.POWER] as number,
    },
    u,
    mass,
  )

  const { udot, vdot, wdot } = core
  const dum = uBody * uBody + wBody * wBody

  const xd = new Array<number>(STATE_SIZE).fill(0)

  // Airspeed, alpha and beta rates, expressed back in wind axes. Both divisions are
  // the reason `state.ts` does not use this tail — see the note there.
  xd[S.VT] = (uBody * udot + vBody * vdot + wBody * wdot) / vt
  xd[S.ALPHA] = (uBody * wdot - wBody * udot) / dum
  xd[S.BETA] = ((vt * vdot - vBody * (xd[S.VT] as number)) * cbta) / dum

  // --- Attitude kinematics -------------------------------------------------
  // The 1/cos(theta) here is the gimbal lock REQUIREMENTS §3 is worried about: it
  // blows up at theta = +/-90 deg. `state.ts` avoids it with quaternions; this form
  // exists to match the reference.
  const sth = Math.sin(theta)
  const cth = Math.cos(theta)
  const sph = Math.sin(phi)
  const cph = Math.cos(phi)
  const qsph = q * sph

  xd[S.PHI] = p + (sth / cth) * (qsph + r * cph)
  xd[S.THETA] = q * cph - r * sph
  xd[S.PSI] = (qsph + r * cph) / cth

  xd[S.P] = core.pdot
  xd[S.Q] = core.qdot
  xd[S.R] = core.rdot

  xd[S.PN] = core.pnDot
  xd[S.PE] = core.peDot
  xd[S.ALT] = core.altDot

  xd[S.POWER] = core.powerDot

  return { xd, accel: core.accel, outsideEnvelope }
}

/** Convenience: just the derivative array. */
export const stateDerivative = (
  x: readonly number[],
  u: Controls,
  mass?: MassProperties,
  opts?: DerivativeOptions,
): number[] => derivative(x, u, mass, opts).xd
