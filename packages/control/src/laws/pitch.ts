/**
 * Pitch rate command law (REQUIREMENTS §5).
 *
 * This is the load-bearing one. At the reference CG the airframe is longitudinally
 * divergent — time to double about 2.7 seconds — so without this the aircraft is not
 * hard to fly, it is impossible. Everything else in the assist layer is a
 * convenience; this is the fly-by-wire the real F-16 has and this model does not.
 *
 * ## Structure
 *
 *     delta_e = delta_e_trim
 *             - kAlpha * (alpha - alpha_trim)      stabilise the short period
 *             - kQ     * q                          damp it
 *             - kI     * integral(q_cmd - q)        track the commanded rate
 *
 * The first two terms come from a pole placement in `gains.ts` and are what make an
 * unstable airframe behave like a well-damped stable one. The third is what makes
 * the stick mean something: at equilibrium the integrator has driven `q` to exactly
 * `q_cmd`, whatever elevator that took.
 *
 * The trim offsets come from the gain schedule, so the integrator starts near zero
 * in level flight rather than having to wind up to the trim elevator before the
 * aircraft will hold altitude.
 */

import { ELEVATOR_LIMIT_DEG } from '../limits.js'
import type { GainSet } from '../gains.js'

export class PitchLaw {
  /** Integrated pitch-rate error. Exposed for tests and the dev overlay. */
  integral = 0

  /**
   * @param qCmd     Commanded pitch rate, rad/s — already limited by §5's AoA and G limiters
   * @param alphaRad Current angle of attack, radians
   * @param q        Current pitch rate, rad/s
   * @returns Elevator deflection, degrees. Positive is trailing edge down, nose down.
   */
  update(qCmd: number, alphaRad: number, q: number, gains: GainSet, dt: number): number {
    const error = qCmd - q
    const integral = this.integral + error * dt

    const raw =
      gains.elevatorTrim -
      gains.kAlpha * (alphaRad - gains.alphaTrim) -
      gains.kQ * q -
      gains.kI * integral

    const clamped = Math.min(ELEVATOR_LIMIT_DEG, Math.max(-ELEVATOR_LIMIT_DEG, raw))

    // Anti-windup by back-calculation: unwind the integrator by exactly the amount
    // the clamp threw away.
    //
    // Without this, holding full aft stick against the elevator limit winds the
    // integrator up for as long as you hold it, and releasing the stick does
    // nothing at all until it has wound back down — several seconds of an aircraft
    // that has stopped listening. It is the single most common way a rate-command
    // law feels broken.
    this.integral =
      Math.abs(gains.kI) > 1e-9 ? integral + (raw - clamped) / gains.kI : integral

    return clamped
  }

  /**
   * Seed the integrator so the law starts in equilibrium.
   *
   * Called when the simulation spawns at a trim condition. Starting from zero means
   * the aircraft pitches while the integrator finds its footing, which looks like a
   * bug in the trim solver and is not.
   */
  seed(elevator: number, alphaRad: number, q: number, gains: GainSet): void {
    if (Math.abs(gains.kI) < 1e-9) return

    const withoutIntegral =
      gains.elevatorTrim - gains.kAlpha * (alphaRad - gains.alphaTrim) - gains.kQ * q

    this.integral = (withoutIntegral - elevator) / gains.kI
  }

  reset(): void {
    this.integral = 0
  }
}
