/**
 * Reference speeds, computed from the aerodynamic tables rather than quoted.
 *
 * ## Why these are derived and not looked up
 *
 * A takeoff needs a rotation speed, and REQUIREMENTS' provenance rules leave two
 * honest options: find a published V-speed for the F-16 and label it `[S]`, or work
 * it out from the model we already have and label the *assumptions* `[A]`. The
 * second is better here, and not only because the first would be a `[V]` value I
 * cannot verify.
 *
 * A quoted V-speed belongs to a particular weight, configuration and field
 * elevation. Ours has to follow a mass model that §8.4 computes from a loadout, and
 * airfields between sea level and 1,300 ft. A number derived from the tables tracks
 * all of that for free; a constant would be silently wrong the moment fuel burn or a
 * different field changed the sums, and it would be wrong in the direction that
 * matters — a rotation cue that fires too early on a hot, heavy day.
 *
 * Everything here is a *cue*, not a limit. Nothing in the flight model reads it.
 */

import { isa } from './atmosphere.js'
import { buildCoefficients } from './aero/buildup.js'
import { WING_AREA, XCG_REF, computeMassProperties, type MassProperties } from './massProperties.js'
import { RAD_PER_DEG } from './units.js'

/**
 * Lift coefficient at an angle of attack, from the tables.
 *
 * The model is written in body axes — an axial force and a normal force — and lift
 * is perpendicular to the *relative wind*, so the two have to be resolved through
 * alpha: `CL = CX sin(a) - CZ cos(a)`. Skipping that rotation is a mistake worth
 * naming, because at the 12-15 degrees a rotation happens at it is a several percent
 * error, and it is invisible unless you know to look.
 *
 * Body rates are zero, so the damping terms drop out and this does not depend on
 * airspeed — which is what makes it usable to *solve* for an airspeed.
 */
export function liftCoefficient(alphaDeg: number, elevatorDeg = 0): number {
  const c = buildCoefficients({
    alphaDeg,
    betaDeg: 0,
    elevatorDeg,
    aileronDeg: 0,
    rudderDeg: 0,
    p: 0,
    q: 0,
    r: 0,
    // Any positive value: with zero rates the damping terms vanish.
    vt: 500,
    xcg: XCG_REF,
  })

  const a = alphaDeg * RAD_PER_DEG
  return c.cxt * Math.sin(a) - c.czt * Math.cos(a)
}

/**
 * The speed at which the wing carries the aircraft's weight at a given alpha, ft/s.
 *
 * `L = q S CL = W`, solved for V. Infinity when the wing makes no lift at that
 * angle, which is the honest answer rather than a NaN.
 */
export function speedForLevelLift(
  alphaDeg: number,
  altFt: number,
  mass: MassProperties = computeMassProperties(),
  elevatorDeg = 0,
): number {
  const cl = liftCoefficient(alphaDeg, elevatorDeg)
  if (cl <= 0) return Infinity

  const { density } = isa(altFt)
  return Math.sqrt((2 * mass.weight) / (density * WING_AREA * cl))
}

/**
 * Angle of attack the rotation cue assumes, degrees. `[A]`
 *
 * The attitude a takeoff is actually flown at, not the one that produces the
 * shortest ground roll. Twelve degrees is what the acceptance flight holds through
 * the initial climb, it is comfortably below the assist layer's AoA ceiling, and it
 * leaves the tail clear of the runway.
 *
 * Rotating at the alpha for *maximum* lift would give a lower and more flattering
 * number and a worse cue: the aircraft would stagger off the ground on the edge of
 * the stall with no margin for the pilot being a little late or a little firm.
 */
export const ROTATION_ALPHA_DEG = 12

/**
 * Margin over the speed where lift first equals weight. `[A]`
 *
 * Rotating at exactly that speed means the aircraft flies only if nothing goes
 * wrong. Ten percent is the usual sort of margin and it is what makes the cue mean
 * "you may rotate now" instead of "you must".
 */
export const ROTATION_MARGIN = 1.1

/**
 * The speed this aeroplane flies at, ft/s.
 *
 * One number with two uses, because they are the same question asked twice. On the
 * roll it is the rotation speed: pull at this and the aircraft flies. On final it is
 * the approach speed: cross the threshold near this and it lands, and the reason
 * both are the same is that "flying" and "about to stop flying" meet at the attitude
 * a takeoff and a landing are both flown at.
 *
 * A function of weight and field elevation, so it differs between Bayside and
 * Ridgeview and rises with the loadout.
 *
 * Measured against it: arriving 30 kt above lands normally, 1.9 g, stopped in 28
 * seconds. Arriving 80 kt above does not land at all — at 250 kt the wing still
 * makes more lift than the aircraft weighs, so at idle it floats, and pushing the
 * nose down instead drives it into the runway at 2,200 fpm for 23 g and a 17 ft
 * bounce. There is nothing wrong with the aeroplane there. It is just that nothing
 * on screen said 169.
 */
export function referenceSpeed(
  altFt: number,
  mass: MassProperties = computeMassProperties(),
): number {
  return speedForLevelLift(ROTATION_ALPHA_DEG, altFt, mass) * ROTATION_MARGIN
}

/** The rotation cue. Same speed, named for the half of the flight it is used in. */
export const rotationSpeed = referenceSpeed
/** The approach cue. See `referenceSpeed`. */
export const approachSpeed = referenceSpeed

/**
 * Lowest speed at which the wing can carry the aircraft at all, ft/s.
 *
 * Searched across the tabulated alpha range rather than assumed to sit at the top of
 * it: where CL peaks is a property of the data, not something to guess. It turns out
 * to be right at the top, 40-45 degrees, which is why this is NOT a stall speed a
 * pilot could use — it is the speed at which the wing could hold the aircraft up if
 * it were flown at an attitude nobody lands at. Measured, 105 kt against a reference
 * speed of 169.
 *
 * It is here to bound the other numbers, not to be displayed.
 */
export function stallSpeed(
  altFt: number,
  mass: MassProperties = computeMassProperties(),
): number {
  let best = Infinity
  for (let alphaDeg = 0; alphaDeg <= 45; alphaDeg += 0.25) {
    const v = speedForLevelLift(alphaDeg, altFt, mass)
    if (v < best) best = v
  }
  return best
}
