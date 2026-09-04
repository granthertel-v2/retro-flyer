/**
 * The envelope limiters (REQUIREMENTS §5).
 *
 * Both operate on the *command* — they shape the pitch rate being asked for before
 * the pitch law ever sees it. Limiting the surface deflection instead would fight
 * the control law's own integrator, and the two would argue.
 */

import { G_FT_S2, radToDeg } from '@retro-flyer/physics'

/**
 * Angle-of-attack ceiling, degrees.
 *
 * 30 degrees, against the 45 degree edge of the aerodynamic data (§2). Outside that
 * data the model diverges to NaN in about six seconds — the integrator clamps by
 * default so it cannot actually happen, but a limiter that only works because
 * something downstream is catching it is not a limiter.
 *
 * Raised from 25, which was the real F-16's figure and the wrong one to copy. At 25
 * the AERODYNAMIC limit bound before the STRUCTURAL one at every speed worth
 * flying: full aft stick at 11,000 ft and 640 ft/s reached 6.3 g against a 9 g
 * limit, so the g limiter was decoration and the aircraft simply stopped pulling
 * partway through every turn. At 30 the g limiter is what binds at combat speeds
 * and alpha only takes over down low and slow, where nine g is not available
 * anyway. That ordering is the right one: structure first, aerodynamics second.
 *
 * 34 was tried and is not worth it — a tenth of a g more, alpha touching 44 in a
 * slow-speed pull, and a full-deflection input leaving the envelope.
 */
export const AOA_CEILING_DEG = 32

/**
 * Angle-of-attack floor, degrees.
 *
 * The data envelope is -10 to +45 (§2) and the limiter guarded only the top of it,
 * which is the half everyone thinks about. Full forward stick walks straight out of
 * the bottom: an oscillating full-deflection input left the envelope at -10.4
 * degrees with every assist on, at no point having gone anywhere near a high-alpha
 * departure. A floor at -5 leaves margin below in the same way the ceiling leaves
 * margin above.
 */
export const AOA_FLOOR_DEG = -8

/** Positive load factor limit, g. The F-16's real structural limit. */
export const G_LIMIT = 9
/** Negative load factor limit, g. */
export const G_LIMIT_NEGATIVE = -3

/**
 * Angle-of-attack ceiling at low airspeed, degrees.
 *
 * The ceiling is not a constant, and the reason is energy rather than aerodynamics.
 * High alpha costs induced drag; induced drag costs airspeed; and low airspeed costs
 * the control authority you need to get the alpha back down. That loop has a corner
 * it does not come out of — 25,000 ft, part throttle, a sustained pull, and the
 * aircraft went from 420 ft/s to 159 with the elevator pinned full nose-down and
 * alpha at 84 degrees. Nothing recovers from that, because at 94 knots there is
 * nothing to recover it with.
 *
 * So the ceiling comes down as speed does: the full 30 degrees above 480 ft/s,
 * declining to 18 by 320, where the real limit on how hard you can turn is that you
 * are running out of aeroplane.
 *
 * The window is worth more than it looks. Fading from 550 rather than 480 costs
 * half a degree per second of sustained turn rate, because a hard turn bleeds
 * through it; fading from 400 lets the slow-speed case reach 43 degrees alpha, two
 * off the edge of the data. 480 keeps the whole ceiling available for the pull that
 * matters and still arrests the one that does not end well.
 */
export const AOA_CEILING_LOW_SPEED_DEG = 18

/** Airspeeds, ft/s, between which the ceiling is reduced. */
const CEILING_FULL_FPS = 700
const CEILING_LOW_FPS = 320

/** The alpha ceiling actually in force at this airspeed, degrees. */
export function effectiveCeiling(ceilingDeg: number, vt: number): number {
  const t = Math.min(1, Math.max(0, (vt - CEILING_FULL_FPS) / (CEILING_LOW_FPS - CEILING_FULL_FPS)))
  const fade = t * t * (3 - 2 * t)
  const low = Math.min(AOA_CEILING_LOW_SPEED_DEG, ceilingDeg)

  return ceilingDeg - (ceilingDeg - low) * fade
}

/**
 * Pitch rate allowed per degree of margin to the ceiling, rad/s.
 *
 * This turns the ceiling into a first-order approach: far below it the allowance is
 * larger than anything the stick can ask for and the limiter is invisible; near it
 * the allowance shrinks; past it the allowance is negative and the limiter commands
 * an actual recovery.
 */
const AOA_GAIN_PER_DEG = 0.17

/**
 * How far ahead the limiter looks, seconds.
 *
 * Limiting on present alpha alone does not work, and the first version of this file
 * did exactly that: fading the command out at the ceiling let alpha coast to 43
 * degrees at 20,000 ft — two degrees from the edge of the aerodynamic data. Pitch
 * rate does not stop when the command does, and alpha keeps rising anyway while the
 * aircraft decelerates in the pull. Limiting on where alpha will be in half a second
 * gives the aircraft time to stop.
 */
const AOA_LEAD_SECONDS = 0.12

/** Reduction in the pitch rate cap per g of overshoot, rad/s. */
const NZ_FEEDBACK = 0.035

/**
 * Pitch rate the stick is asking for, in rad/s.
 *
 * Two terms, and they do different jobs:
 *
 *     q = (g/V) * (1 - cos(phi)*cos(theta))     hold one g wherever gravity is
 *       + stick * maxRate                        what the pilot actually asked for
 *
 * The first is gravity compensation. It is what makes centre stick mean "one g
 * toward my own belly" rather than "stop rotating": level it is zero, banked it
 * turns and descends, inverted it pulls toward the ground. An aeroplane, rather than
 * an attitude hold.
 *
 * The second is a plain rate command, and it is deliberately **not** derived from a
 * load factor. Deriving it — `q = (g/V)(n - ...)` for a commanded n — is more
 * elegant and it was the first version, but it ties rotation rate to airspeed by
 * construction: nine g at 640 ft/s is 23 deg/s and at 900 ft/s is 16, so the faster
 * you fly the more sluggish the aircraft feels, which is the opposite of what speed
 * ought to buy. Tying the stick to rate directly means full deflection means the
 * same thing everywhere, and the g limiter downstream is what stops you bending it.
 *
 * That ordering — ask for a rate, cap it with the limits — is also what makes the
 * limits legible. When the aircraft stops pulling, it is because a limiter said so,
 * not because the command mapping quietly ran out.
 *
 * @param stick   Pitch stick, -1 to 1. Positive is nose up.
 * @param maxRate Commanded rate at full deflection, rad/s
 * @param vt      True airspeed, ft/s
 * @param phi     Bank angle, radians
 * @param theta   Pitch attitude, radians
 */
export function pitchRateCommand(
  stick: number,
  maxRateUp: number,
  maxRateDown: number,
  vt: number,
  phi: number,
  theta: number,
): number {
  const holdOneG = (G_FT_S2 / Math.max(vt, 100)) * (1 - Math.cos(phi) * Math.cos(theta))
  const rate = stick >= 0 ? stick * maxRateUp : stick * maxRateDown

  return holdOneG + rate
}

/**
 * Nose-down command rate, as a fraction of the nose-up one.
 *
 * Full forward is not the mirror of full aft, and it should not be: the load factor
 * limits are +11 and -4, so the aircraft has less than half as much room to push as
 * to pull. Commanding the same rate in both directions just means the AoA floor
 * catches the pushover instead of the g limiter — and it catches it *late*, outside
 * the aerodynamic data, because the floor is only two degrees from the edge where
 * the ceiling has thirteen.
 */
export function downRateFraction(positiveG: number, negativeG: number): number {
  return Math.min(1, (1 - negativeG) / Math.max(1e-6, positiveG - 1))
}

/**
 * Commanded load factor for a stick position, -1 to 1.
 *
 * Asymmetric, because the limits are: full aft is the positive limit, full forward
 * the negative one, and centre is one g. The asymmetry belongs to the aircraft, not
 * to a preference — nothing pulls -9 g.
 */
export function commandedLoadFactor(
  stick: number,
  positive = G_LIMIT,
  negative = G_LIMIT_NEGATIVE,
): number {
  return stick >= 0 ? 1 + stick * (positive - 1) : 1 + stick * (1 - negative)
}


/**
 * Cap the commanded pitch rate at what keeps alpha below its ceiling.
 *
 * One expression with no branches, which is worth more than it looks: a limiter
 * built out of cases has a discontinuity at every case boundary, and the pilot feels
 * each one. Nose-down commands pass through untouched wherever alpha is low, because
 * the allowance is then far larger than anything the stick produces.
 *
 * @param qCmd     Commanded pitch rate, rad/s
 * @param alphaRad Current angle of attack, radians
 * @param q        Current pitch rate, rad/s — the lead term
 */
export function limitAoA(
  qCmd: number,
  alphaRad: number,
  q: number,
  vt: number,
  ceilingDeg = AOA_CEILING_DEG,
  floorDeg = AOA_FLOOR_DEG,
): number {
  const ceiling = effectiveCeiling(ceilingDeg, vt)
  const predicted = radToDeg(alphaRad) + radToDeg(q) * AOA_LEAD_SECONDS

  // Symmetric: the ceiling caps how much nose-up may be commanded, the floor caps
  // how much nose-down. Both are one-line approaches to a boundary, and between
  // them the stick is untouched.
  const upper = (ceiling - predicted) * AOA_GAIN_PER_DEG
  const lower = (floorDeg - predicted) * AOA_GAIN_PER_DEG

  return Math.max(lower, Math.min(qCmd, upper))
}

export function limitG(
  qCmd: number,
  vt: number,
  nz: number,
  positive = G_LIMIT,
  negative = G_LIMIT_NEGATIVE,
): number {
  // Below about 100 ft/s the division blows up and the aircraft is not flying
  // anyway. Guard rather than emit an infinite command.
  const speed = Math.max(vt, 100)

  const qMaxSteady = ((positive - 1) * G_FT_S2) / speed
  const qMinSteady = ((negative - 1) * G_FT_S2) / speed

  // The steady relation is a feedforward, and on its own it undershoots: during a
  // fast push-over the load factor tracks alpha, not pitch rate, and the two are
  // briefly a long way apart. Commanding the steady-state pitch rate for -3 g
  // reached -4.3 g on the way there. So the measured load factor trims the cap,
  // but only ever downward — the feedforward is what sets the target, and this
  // only takes authority away when the aircraft is already past the limit.
  const qMax = Math.min(qMaxSteady, qMaxSteady + (positive - nz) * NZ_FEEDBACK)
  const qMin = Math.max(qMinSteady, qMinSteady + (negative - nz) * NZ_FEEDBACK)

  return Math.min(qMax, Math.max(qMin, qCmd))
}

/** Fraction of roll authority retained when hard against an envelope limit. */
const ROLL_MIN_AUTHORITY = 0.28

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * How much of the commanded roll rate the pilot gets, 0 to 1.
 *
 * Rolling hard while pulling or pushing hard is how fighters depart, and it is not
 * something the pitch axis can save you from: an oscillating full-deflection input
 * put this aircraft at -6 g and -12 degrees alpha with the elevator **at its stop**,
 * commanding full nose-up and losing. There was no authority left to take. The only
 * thing that helps is not rolling that fast in the first place, which is why real
 * fly-by-wire reduces roll rate near the limits rather than trying to catch the
 * result.
 *
 * Authority is never taken away entirely — being unable to roll is its own kind of
 * emergency — it just stops being enough to break the aeroplane.
 */
export function rollAuthority(
  alphaRad: number,
  nz: number,
  ceilingDeg = AOA_CEILING_DEG,
  floorDeg = AOA_FLOOR_DEG,
  positiveG = G_LIMIT,
  negativeG = G_LIMIT_NEGATIVE,
): number {
  const alphaDeg = radToDeg(alphaRad)

  const closeness = Math.max(
    smoothstep(ceilingDeg - 9, ceilingDeg, alphaDeg),
    smoothstep(floorDeg + 7, floorDeg, alphaDeg),
    smoothstep(positiveG - 2.5, positiveG, nz),
    smoothstep(negativeG + 2, negativeG, nz),
  )

  return 1 - (1 - ROLL_MIN_AUTHORITY) * closeness
}
