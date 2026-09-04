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
 * 25 degrees, well below the 45 degree edge of the aerodynamic data (§2). Outside
 * that data the model diverges to NaN in about six seconds — the integrator clamps
 * by default so it cannot actually happen, but a limiter that only works because
 * something downstream is catching it is not a limiter.
 *
 * It is also roughly where the real F-16's limiter sits, which is a coincidence
 * worth having.
 */
export const AOA_CEILING_DEG = 25

/** Positive load factor limit, g. The F-16's real structural limit. */
export const G_LIMIT = 9
/** Negative load factor limit, g. */
export const G_LIMIT_NEGATIVE = -3

/**
 * Pitch rate allowed per degree of margin to the ceiling, rad/s.
 *
 * This turns the ceiling into a first-order approach: far below it the allowance is
 * larger than anything the stick can ask for and the limiter is invisible; near it
 * the allowance shrinks; past it the allowance is negative and the limiter commands
 * an actual recovery.
 */
const AOA_GAIN_PER_DEG = 0.11

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
const AOA_LEAD_SECONDS = 0.55

/** Reduction in the pitch rate cap per g of overshoot, rad/s. */
const NZ_FEEDBACK = 0.035

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
  ceilingDeg = AOA_CEILING_DEG,
): number {
  const predicted = radToDeg(alphaRad) + radToDeg(q) * AOA_LEAD_SECONDS
  return Math.min(qCmd, (ceilingDeg - predicted) * AOA_GAIN_PER_DEG)
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
