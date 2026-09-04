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

import { G_FT_S2, radToDeg } from '@retro-flyer/physics'
import { RUDDER_LIMIT_DEG } from '../limits.js'
import type { GainSet } from '../gains.js'

/** Angle of attack, degrees, between which pedal authority is reduced. */
const RUDDER_FADE_LOW = 12
const RUDDER_FADE_HIGH = 26
/** Fraction of pedal authority retained at high alpha. */
const RUDDER_HIGH_ALPHA_AUTHORITY = 0.25

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * How much of the pedal the pilot actually gets, 0 to 1.
 *
 * Full rudder at high angle of attack is the classic way to depart a fighter, and
 * with the pedals free it is a way to depart this one too — a full-deflection input
 * on every axis at once left the envelope even with every assist on. Real
 * fly-by-wire reduces rudder authority as alpha rises for exactly this reason. The
 * pedals never go completely dead, because deliberate sideslip should stay
 * available; they just stop being able to break the aircraft.
 */
export function pedalAuthority(alphaRad: number): number {
  const fade = smoothstep(RUDDER_FADE_LOW, RUDDER_FADE_HIGH, radToDeg(alphaRad))
  return 1 - (1 - RUDDER_HIGH_ALPHA_AUTHORITY) * fade
}

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
export function coordinatedYawRate(
  p: number,
  alphaRad: number,
  phi: number,
  theta: number,
  vt: number,
): number {
  // tan blows up approaching 90 degrees of alpha; the aircraft is limited to 25 and
  // the data stops at 45, so clamping well inside that costs nothing real.
  const alpha = Math.min(Math.PI / 4, Math.max(-Math.PI / 4, alphaRad))
  const rolling = p * Math.tan(alpha)

  // The turn term. Once the aircraft is banked, the component of gravity acting
  // sideways along the wing is what generates sideslip, and cancelling it needs a
  // yaw rate of (g/V)*sin(phi)*cos(theta) — the body-axis yaw rate of a coordinated
  // turn at that bank.
  //
  // Leaving this out is why the first version barely helped in a level roll: the
  // roll coupling it did cancel is the smaller of the two terms as soon as any bank
  // develops, which in a full-stick roll is immediately. It showed up as the assist
  // making almost no measurable difference, which is a strange result to get from a
  // term that is individually correct.
  const turning = ((G_FT_S2 / Math.max(vt, 100)) * Math.sin(phi) * Math.cos(theta))

  return rolling + turning
}

/**
 * @param betaRad Current sideslip, radians
 * @param r       Current yaw rate, rad/s
 * @param p       Achieved roll rate, rad/s
 * @param alphaRad Current angle of attack, radians
 * @param phi     Bank angle, radians
 * @param theta   Pitch attitude, radians
 * @param vt      True airspeed, ft/s
 * @param manual  Pilot rudder input, -1 to 1, added on top
 */
export function yawCommand(
  betaRad: number,
  r: number,
  p: number,
  alphaRad: number,
  phi: number,
  theta: number,
  vt: number,
  manual: number,
  gains: GainSet,
  coordinate: boolean,
): number {
  // Negated. In this model a POSITIVE rudder deflection yaws the nose LEFT — flown
  // and measured, not deduced: four seconds of full right pedal swung the heading
  // 22 degrees the wrong way. `manual` is in pilot terms (positive is nose right),
  // so the sign flips here, once, at the boundary. `test/handling.test.ts` pins it.
  let rudder = -manual * RUDDER_LIMIT_DEG * pedalAuthority(alphaRad)

  if (coordinate) {
    const rCmd = coordinatedYawRate(p, alphaRad, phi, theta, vt)
    rudder += -(gains.kBeta * betaRad + gains.kR * (r - rCmd))
  }

  return Math.min(RUDDER_LIMIT_DEG, Math.max(-RUDDER_LIMIT_DEG, rudder))
}
