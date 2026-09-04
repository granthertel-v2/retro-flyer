/**
 * Auto-coordination (REQUIREMENTS §5).
 *
 * "Rudder commanded to hold beta about zero during rolls and turns." Two parts, and
 * both are needed:
 *
 * - **Feedback** on sideslip and yaw rate, from the same pole placement the other
 *   axes use, targeting a well damped dutch roll. This is what holds beta at zero
 *   once it has moved.
 * - **Feedforward** on commanded roll rate, which is what stops it moving in the
 *   first place. A feedback loop cannot respond until the sideslip already exists,
 *   so a hard roll with feedback alone visibly skids before it settles. The
 *   feedforward puts the rudder in at the same instant the aileron goes in, and is
 *   derived from the kinematics rather than tuned — see `coordinatedYawRate`.
 */

import { RUDDER_LIMIT_DEG } from '../limits.js'
import type { GainSet } from '../gains.js'

/**
 * Yaw rate that holds sideslip constant during a roll at angle of attack.
 *
 * The sideslip equation carries a term `p*sin(alpha) - r*cos(alpha)`: rolling an
 * aircraft that is flying at any positive alpha *generates* sideslip, purely
 * kinematically, before any aerodynamic moment is involved. Setting the two terms
 * equal gives `r = p*tan(alpha)`, and that is the entire coordination feedforward.
 *
 * This replaced a tuned constant multiplying commanded roll rate, which was both the
 * wrong magnitude and the wrong sign — with it switched on, a full-stick roll reached
 * 4.5 degrees of sideslip against 2.1 with the assist off. The rudder was being aimed
 * at the aileron's yawing moment, which at 300 deg/s and 3 degrees alpha is not the
 * dominant term. Measuring beforehand would have been quicker.
 *
 * `p` is the **achieved** roll rate, not the commanded one, and the difference is not
 * academic. Ask for more roll than the ailerons can deliver and the two diverge; feed
 * the command in and the aircraft tries to coordinate a roll that is not happening.
 * On the Ace preset that meant a demand for 205 deg/s of yaw rate, the rudder pinned
 * at its stop, and 220 knots gone in six seconds. The kinematic coupling is
 * `p*sin(alpha)` with the real `p`; anything else is asking the rudder to fix a
 * problem the aircraft does not have.
 */
export function coordinatedYawRate(p: number, alphaRad: number): number {
  // tan blows up approaching 90 degrees of alpha; the aircraft is limited to 25 and
  // the data stops at 45, so clamping well inside that costs nothing real.
  const alpha = Math.min(Math.PI / 4, Math.max(-Math.PI / 4, alphaRad))
  return p * Math.tan(alpha)
}

/**
 * @param betaRad Current sideslip, radians
 * @param r       Current yaw rate, rad/s
 * @param p       Achieved roll rate, rad/s
 * @param alphaRad Current angle of attack, radians
 * @param manual  Pilot rudder input, -1 to 1, added on top
 */
export function yawCommand(
  betaRad: number,
  r: number,
  p: number,
  alphaRad: number,
  manual: number,
  gains: GainSet,
  coordinate: boolean,
): number {
  let rudder = manual * RUDDER_LIMIT_DEG

  if (coordinate) {
    const rCmd = coordinatedYawRate(p, alphaRad)
    rudder += -(gains.kBeta * betaRad + gains.kR * (r - rCmd))
  }

  return Math.min(RUDDER_LIMIT_DEG, Math.max(-RUDDER_LIMIT_DEG, rudder))
}
