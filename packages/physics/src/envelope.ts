/**
 * Aerodynamic data envelope, and the guard that keeps the simulation inside it.
 *
 * ## The problem this solves
 *
 * The aerodynamic tables cover −10° ≤ α ≤ 45° and −30° ≤ β ≤ 30° ([NASA-TM] p.29).
 * Outside that, the lookup scheme in `tables/lookup.ts` does not clamp — it
 * extrapolates linearly, without bound (see the note there).
 *
 * Measured consequence, not a theoretical worry: hold full-deflection elevator,
 * aileron and rudder from level flight and the aircraft departs, α passes 100° and
 * β passes −50°, the extrapolated coefficients become nonsense, and roughly six
 * seconds in the state diverges to NaN. Airspeed reaches 50,000 ft/s on the way.
 *
 * That is not "departure". Departure is an aircraft out of control, which is a
 * legitimate and desirable thing for this model to produce (REQUIREMENTS §5 wants
 * assists-off flight to be departure-prone). NaN is a simulation that has stopped
 * existing.
 *
 * ## The split
 *
 * The two needs are genuinely different, so they get different code paths:
 *
 * - **The model stays exactly faithful.** `derivative()` defaults to no guard, so
 *   the Tier A golden vectors keep validating the real thing at 1e-12. Clamping
 *   there would mean testing a modified model against unmodified fixtures.
 * - **The simulation stays finite.** The integrator turns the guard ON by default.
 *   Coefficients are evaluated at the nearest point on the envelope boundary rather
 *   than extrapolated into nonsense.
 *
 * Evaluating at the boundary is an approximation `[A]`, and it should be read as
 * one: past 45° α we have no data, so *anything* we do there is invented. Holding
 * the last known value is the least-invented option, and it is bounded. Post-stall
 * forces are relatively flat with α, so it is not a wild guess — but it is a guess.
 *
 * ## What this means for the assist layer
 *
 * The AoA limiter (REQUIREMENTS §5) should keep the aircraft below 45° in normal
 * flight, so the guard never engages with assists on. If the guard is engaging, the
 * aircraft is somewhere the model cannot describe — which is exactly the signal the
 * limiter is supposed to prevent reaching.
 */

/** Lowest tabulated angle of attack, degrees. [NASA-TM] p.29 */
export const ALPHA_MIN_DEG = -10
/** Highest tabulated angle of attack, degrees. [NASA-TM] p.29 */
export const ALPHA_MAX_DEG = 45
/** Sideslip limit, degrees; tables are symmetric. [NASA-TM] p.29 */
export const BETA_LIMIT_DEG = 30

/**
 * Minimum airspeed used in aerodynamic denominators, ft/s.
 *
 * The damping terms divide by airspeed and the alpha/beta rate equations divide by
 * the square of body velocity. At a true standstill both are singular. A floor of
 * 1 ft/s costs nothing anywhere the aircraft is actually flying and removes the
 * singularity from the ground cases Day 3 will introduce.
 */
export const MIN_AIRSPEED_FPS = 1

/** Highest altitude the model's density law stays real, ft. */
export const MAX_MODEL_ALTITUDE_FT = 140000

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

/** Whether a flight condition lies inside the tabulated aerodynamic data. */
export function insideEnvelope(alphaDeg: number, betaDeg: number): boolean {
  return (
    alphaDeg >= ALPHA_MIN_DEG &&
    alphaDeg <= ALPHA_MAX_DEG &&
    Math.abs(betaDeg) <= BETA_LIMIT_DEG
  )
}

export interface GuardedAngles {
  alphaDeg: number
  betaDeg: number
  /** True if either angle had to be clamped — the aircraft is outside the data. */
  clamped: boolean
}

/** Clamp aerodynamic angles onto the envelope boundary. */
export function guardAngles(alphaDeg: number, betaDeg: number): GuardedAngles {
  const a = clamp(alphaDeg, ALPHA_MIN_DEG, ALPHA_MAX_DEG)
  const b = clamp(betaDeg, -BETA_LIMIT_DEG, BETA_LIMIT_DEG)
  return { alphaDeg: a, betaDeg: b, clamped: a !== alphaDeg || b !== betaDeg }
}
