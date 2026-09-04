/**
 * Control-law gains, designed rather than guessed.
 *
 * ## Why this file is not a table of tuned numbers
 *
 * At the reference CG this airframe is longitudinally divergent — time to double
 * about 2.7 seconds (measured in the physics package's `modes.test.ts`). That is
 * correct: the F-16 has relaxed static stability and flies on its flight control
 * system. The consequence for us is that the pitch law is not a comfort feature. Get
 * its gains wrong and the aircraft is not sluggish, it is uncontrollable.
 *
 * Hand-tuning that by feel would be tuning the one thing on Day 2 that has a right
 * answer. So instead: linearise the validated model at a trim condition, and solve
 * for the gains that put the closed-loop poles exactly where we want them. The
 * design target is a choice; the gains that achieve it are arithmetic. And
 * `test/gains.test.ts` checks the closed-loop eigenvalues actually land there, so
 * the arithmetic is not taken on trust either.
 *
 * This is entirely inside the §4.4 tuning boundary: nothing here touches an
 * aerodynamic coefficient. Feel changes are made by moving the design targets
 * below, and the aerodynamic model never notices.
 *
 * ## Why the gains are scheduled
 *
 * Dynamic pressure across this envelope varies by more than a factor of ten. A fixed
 * gain set tuned at 10,000 ft and 500 ft/s is mush on the deck and a
 * pilot-induced-oscillation generator at altitude. So gains are designed at four
 * anchor conditions and interpolated on q-bar between them.
 */

import {
  S,
  airData,
  computeMassProperties,
  derivative,
  jacobian,
  trim,
  type Controls,
  type MassProperties,
  type TrimResult,
} from '@retro-flyer/physics'
import { ackermann, eigenvaluesOf, secondOrderRoots, type Vector } from './linalg.js'

// ---------------------------------------------------------------------------
// Design targets — the feel knobs. `[A]` throughout: these are our choices.
// ---------------------------------------------------------------------------

/**
 * Short-period damping ratio and natural frequency of the *closed* loop.
 *
 * zeta 0.7 sits comfortably inside MIL-STD-1797 Level 1 for a Category A flight
 * phase, and is held everywhere.
 *
 * The frequency is **scheduled**, not constant. Holding 3.0 rad/s across the whole
 * envelope was the first thing tried, and at 30,000 ft and 400 ft/s it asks for 667
 * degrees of elevator per radian of alpha — about twelve degrees of surface per
 * degree of alpha, on a surface with twenty-five degrees of travel. The law would
 * spend that whole corner of the envelope saturated, which is not a control law, it
 * is a switch.
 *
 * The airframe's own short period scales as sqrt(q-bar), because the pitch stiffness
 * does, so the target follows it: sharper when fast, gentler when slow. That is also
 * how a real aeroplane feels, so it costs nothing in fidelity to stop fighting it.
 */
export const PITCH_ZETA = 0.7

/** Target short-period frequency at `PITCH_WN_QBAR_REF`, rad/s. */
export const PITCH_WN_REF = 3.0
/** Dynamic pressure at which `PITCH_WN_REF` applies, lb/ft^2 — mid-envelope. */
export const PITCH_WN_QBAR_REF = 300
/** Bounds on the scheduled frequency. Below the first it is mush; above it, twitchy. */
export const PITCH_WN_MIN = 1.6
export const PITCH_WN_MAX = 4.0

/** Target short-period frequency at a given dynamic pressure, rad/s. */
export function pitchWn(qbar: number): number {
  const scaled = PITCH_WN_REF * Math.sqrt(Math.max(qbar, 1) / PITCH_WN_QBAR_REF)
  return Math.min(PITCH_WN_MAX, Math.max(PITCH_WN_MIN, scaled))
}

/**
 * Where the command integrator's pole goes, as a fraction of `PITCH_WN`.
 *
 * Half. Slow enough not to interact with the short period, fast enough that the
 * aircraft settles onto a commanded pitch rate inside about a second.
 */
export const PITCH_INTEGRATOR_POLE = 0.5

/**
 * Closed-loop roll mode time constant, seconds. Snappy — this is an arcade flyer.
 *
 * A **ceiling**, not a target. Down low and fast the airframe's own roll subsidence
 * is already quicker than this, and driving it back down to 0.25 s means commanding
 * aileron that opposes the roll the pilot asked for. Where the aircraft is already
 * better than the target, the gain is zero and the law gets out of the way.
 */
export const ROLL_TAU = 0.25

/**
 * Closed-loop dutch roll damping ratio.
 *
 * Damping only — the frequency is left wherever the airframe puts it. Moving a
 * mode's frequency costs a large gain of whichever sign fights the airframe hardest,
 * and nobody has ever complained that a dutch roll was at the wrong frequency. They
 * complain that it is there at all, which is a damping problem.
 */
export const YAW_ZETA = 0.75

// ---------------------------------------------------------------------------
// Anchor conditions
// ---------------------------------------------------------------------------

/**
 * Where gains are designed.
 *
 * Chosen to span **dynamic pressure**, which is the scheduling variable, not to span
 * altitude and airspeed. That distinction cost an hour: the obvious four conditions
 * are the ones the physics package trims against in `test/trim.test.ts`, and three
 * of those land at q-bar 218, 220 and 228 — a schedule with no room to interpolate
 * in, sitting between gain sets that differ by a factor of two. These four run from
 * 71 to 963 lb/ft^2, which is most of what this aircraft will ever see.
 */
export const ANCHORS: readonly { alt: number; vt: number }[] = [
  { alt: 30_000, vt: 400 },
  { alt: 20_000, vt: 500 },
  { alt: 10_000, vt: 700 },
  { alt: 0, vt: 900 },
]

export interface GainSet {
  /** Dynamic pressure at the design point, lb/ft^2 — the scheduling variable. */
  qbar: number
  alt: number
  vt: number

  /** Elevator per radian of angle-of-attack error, degrees. */
  kAlpha: number
  /** Elevator per rad/s of pitch rate, degrees. */
  kQ: number
  /** Elevator per unit of integrated pitch-rate error, degrees. */
  kI: number

  /** Aileron per rad/s of roll-rate error, degrees. */
  kRoll: number
  /** Aileron per rad/s of *commanded* roll rate, degrees — the feedforward. */
  kRollFF: number

  /** Rudder per radian of sideslip, degrees. */
  kBeta: number
  /** Rudder per rad/s of yaw rate, degrees. */
  kR: number

  /** Trim state at this anchor — the operating point the gains linearise about. */
  alphaTrim: number
  elevatorTrim: number
  throttleTrim: number
}

/**
 * Control-derivative column: how the state derivative responds to one surface.
 *
 * `jacobian` in the physics package differentiates with respect to states only, so
 * the B matrix has to be built here. Central difference, same as it uses, and in
 * degrees because that is the unit `Controls` carries.
 */
export function controlJacobian(
  x0: readonly number[],
  u: Controls,
  surface: 'elevator' | 'aileron' | 'rudder',
  states: readonly number[],
  mass: MassProperties,
): Vector {
  const h = 0.05 // degrees

  const plus: Controls = { ...u, [surface]: (u[surface] as number) + h }
  const minus: Controls = { ...u, [surface]: (u[surface] as number) - h }

  const dPlus = derivative(x0, plus, mass).xd
  const dMinus = derivative(x0, minus, mass).xd

  return states.map(
    (row) => ((dPlus[row] as number) - (dMinus[row] as number)) / (2 * h),
  )
}

/** Design one gain set at one flight condition. Throws if the aircraft is uncontrollable there. */
export function designGains(
  alt: number,
  vt: number,
  mass: MassProperties = computeMassProperties(),
): GainSet {
  const solution: TrimResult = trim({ alt, vt })
  const x0 = solution.state
  const u: Controls = {
    throttle: solution.throttle,
    elevator: solution.elevator,
    aileron: solution.aileron,
    rudder: solution.rudder,
  }

  // --- Longitudinal: place the short period, plus the integrator pole ------
  //
  // States (alpha, q) augmented with the command integrator xi, where
  // xi_dot = q_cmd - q. Feeding the integrator into the elevator is what gives
  // the law steady-state tracking: at equilibrium q equals q_cmd exactly, whatever
  // the trim offset happens to be.
  const aLon = jacobian(x0, u, [S.ALPHA, S.Q], mass)
  const bLon = controlJacobian(x0, u, 'elevator', [S.ALPHA, S.Q], mass)

  const aAug = [
    [aLon[0]![0] as number, aLon[0]![1] as number, 0],
    [aLon[1]![0] as number, aLon[1]![1] as number, 0],
    [0, -1, 0],
  ]
  const bAug = [bLon[0] as number, bLon[1] as number, 0]

  const qbar = airData(vt, alt).qbar
  const wn = pitchWn(qbar)

  const lonRoots = [
    ...secondOrderRoots(PITCH_ZETA, wn),
    [-wn * PITCH_INTEGRATOR_POLE, 0] as [number, number],
  ]

  const kLon = ackermann(aAug, bAug, lonRoots)
  if (!kLon) {
    throw new Error(`pitch axis uncontrollable at ${alt} ft, ${vt} ft/s`)
  }

  // --- Roll: first order, so the "placement" is one division ---------------
  //
  // p_dot = Lp*p + Ldelta_a*delta_a. Closing delta_a = K*(p_cmd - p) gives a
  // closed-loop pole at Lp - Ldelta_a*K, and we want that at -1/tau.
  //
  // Note this comes out NEGATIVE, because positive aileron rolls this aircraft
  // LEFT (pinned in the physics package's goldenDerivatives test). The sign is not
  // asserted here — it falls out of the model, which is the right way round.
  const aRoll = jacobian(x0, u, [S.P], mass)
  const bRoll = controlJacobian(x0, u, 'aileron', [S.P], mass)
  const lp = aRoll[0]![0] as number
  const lda = bRoll[0] as number

  if (Math.abs(lda) < 1e-9) throw new Error(`roll axis uncontrollable at ${alt} ft, ${vt} ft/s`)

  // Whichever pole is further left: the airframe's own, or the one we asked for.
  const rollPole = Math.min(lp, -1 / ROLL_TAU)
  const kRoll = (lp - rollPole) / lda

  // Feedforward: the aileron that *holds* the commanded rate once it is reached,
  // from 0 = Lp*p + Ldelta_a*delta_a.
  //
  // Without this the law cannot reach its own command. A proportional loop settles
  // where the error term balances the damping, which works out to (Lp*tau + 1)
  // times the commanded rate — at this airframe's roll damping, about eleven per
  // cent of it. Commanding 308 deg/s delivered 118. The feedforward sets the
  // steady state and the proportional term becomes what it should have been all
  // along: a correction, not the whole law.
  const kRollFF = -lp / lda

  // --- Yaw: place the dutch roll ------------------------------------------
  const aLat = jacobian(x0, u, [S.BETA, S.R], mass)
  const bLat = controlJacobian(x0, u, 'rudder', [S.BETA, S.R], mass)

  // Keep the airframe's own dutch roll frequency; change only its damping.
  const naturalWn = Math.max(
    ...eigenvaluesOf(aLat).map((e) => Math.hypot(e.re, e.im)),
    0.2,
  )

  const kLat = ackermann(aLat, bLat, secondOrderRoots(YAW_ZETA, naturalWn))
  if (!kLat) throw new Error(`yaw axis uncontrollable at ${alt} ft, ${vt} ft/s`)

  return {
    qbar,
    alt,
    vt,

    kAlpha: kLon[0] as number,
    kQ: kLon[1] as number,
    kI: kLon[2] as number,

    kRoll,
    kRollFF,

    kBeta: kLat[0] as number,
    kR: kLat[1] as number,

    alphaTrim: solution.alpha,
    elevatorTrim: solution.elevator,
    throttleTrim: solution.throttle,
  }
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

let cached: GainSet[] | null = null

/**
 * The designed gain sets, ordered by dynamic pressure.
 *
 * Memoised: each anchor runs a full trim solve plus several linearisations, which
 * costs a few hundred milliseconds all told. Once, at startup, is fine; once per
 * physics tick would not be.
 */
export function anchorGains(): readonly GainSet[] {
  if (!cached) {
    cached = ANCHORS.map((a) => designGains(a.alt, a.vt)).sort((x, y) => x.qbar - y.qbar)
  }
  return cached
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Gains for the current flight condition, interpolated on dynamic pressure.
 *
 * Outside the anchor range the nearest set is held rather than extrapolated.
 * Extrapolating a gain schedule off the end of its design points is how control
 * laws produce enormous numbers in exactly the corners of the envelope nobody
 * tested.
 */
export function scheduledGains(vt: number, alt: number): GainSet {
  const sets = anchorGains()
  const qbar = airData(vt, alt).qbar

  const first = sets[0] as GainSet
  const last = sets[sets.length - 1] as GainSet

  if (qbar <= first.qbar) return first
  if (qbar >= last.qbar) return last

  for (let i = 0; i < sets.length - 1; i++) {
    const a = sets[i] as GainSet
    const b = sets[i + 1] as GainSet
    if (qbar < a.qbar || qbar > b.qbar) continue

    const t = (qbar - a.qbar) / (b.qbar - a.qbar)

    return {
      qbar,
      alt,
      vt,
      kAlpha: lerp(a.kAlpha, b.kAlpha, t),
      kQ: lerp(a.kQ, b.kQ, t),
      kI: lerp(a.kI, b.kI, t),
      kRoll: lerp(a.kRoll, b.kRoll, t),
      kRollFF: lerp(a.kRollFF, b.kRollFF, t),
      kBeta: lerp(a.kBeta, b.kBeta, t),
      kR: lerp(a.kR, b.kR, t),
      alphaTrim: lerp(a.alphaTrim, b.alphaTrim, t),
      elevatorTrim: lerp(a.elevatorTrim, b.elevatorTrim, t),
      throttleTrim: lerp(a.throttleTrim, b.throttleTrim, t),
    }
  }

  return last
}

/** Drop the memoised design. Tests that change design targets need this. */
export function resetGains(): void {
  cached = null
}
