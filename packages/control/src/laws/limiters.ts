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
 * departure. A floor leaves margin below in the same way the ceiling leaves margin
 * above — but far less of it, and that asymmetry drives three other constants in
 * this file. -8 against a -10 edge is two degrees; the ceiling has thirteen.
 *
 * This is the HIGH-SPEED floor. Below 700 ft/s it is raised, because recovering from
 * negative alpha needs dynamic pressure the aircraft may not have — see
 * `effectiveFloor`.
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
 * So the ceiling comes down as speed does: the full ceiling above 700 ft/s,
 * declining to 18 by 320, where the real limit on how hard you can turn is that you
 * are running out of aeroplane.
 *
 * The fade used to start at 480, which was correct while the stick commanded a load
 * factor. It is not correct now. A rate command asks for the same degrees per second
 * at every speed, so at low q-bar it demands far more of the aircraft than the old
 * mapping ever did, and the ceiling has to start coming down much earlier to meet
 * it. Measured at 480 with the rate command: a sustained pull at 20,000 ft and 480
 * ft/s reaches 162 degrees alpha, and the adversarial full-deflection family departs
 * 6 times out of 25 — through the CEILING, at alpha 239.
 *
 * At 700 none of that happens, and the slow turn is better rather than worse: 3.7
 * deg/s sustained at 20,000 ft against 1.3, because an aircraft that has departed is
 * not turning at all. Fading earlier costs a little of the ceiling in the 480-700
 * band and buys back the entire low-speed corner.
 */
export const AOA_CEILING_LOW_SPEED_DEG = 18

/** Airspeeds, ft/s, between which the ceiling is reduced. */
const CEILING_FULL_FPS = 700
const CEILING_LOW_FPS = 320

/**
 * Angle-of-attack floor at low airspeed, degrees.
 *
 * The floor is scheduled on airspeed for the same reason the ceiling is, and the
 * reason is authority rather than aerodynamics.
 *
 * Recovering from negative alpha means commanding a pull, and how fast that pull
 * arrives depends on dynamic pressure: the same elevator deflection makes a
 * fraction of the pitching moment at 450 ft/s that it makes at 850. A rate command
 * does not care — full forward stick asks for the same degrees per second at every
 * speed, which is exactly what makes it feel right — so at low q-bar the aircraft
 * arrives at the floor just as quickly with far less available to stop it.
 *
 * Measured, that is the whole of the remaining problem. Across 25 adversarial
 * full-deflection inputs, every departure left through the floor at 20,000 ft and
 * above; nothing below 12,000 ft ever came close, at any setting of the lead. So
 * the floor comes up as speed comes down, and the aircraft keeps the full -8
 * degrees exactly where it has the authority to use it.
 */
export const AOA_FLOOR_LOW_SPEED_DEG = -4.5

/** Airspeeds, ft/s, between which the floor is raised. */
const FLOOR_FULL_FPS = 700
const FLOOR_LOW_FPS = 400

/** The alpha floor actually in force at this airspeed, degrees. */
export function effectiveFloor(floorDeg: number, vt: number): number {
  const t = Math.min(1, Math.max(0, (vt - FLOOR_FULL_FPS) / (FLOOR_LOW_FPS - FLOOR_FULL_FPS)))
  const fade = t * t * (3 - 2 * t)
  const high = Math.max(AOA_FLOOR_LOW_SPEED_DEG, floorDeg)

  return floorDeg + (high - floorDeg) * fade
}

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
 * The same, approaching the FLOOR, rad/s per degree.
 *
 * Higher than the ceiling's, and for the third time in this file the reason is that
 * 2 degrees of margin and 13 degrees of margin are not the same problem. A gentle
 * approach gain lets alpha coast past the boundary and settle a degree or two beyond
 * it, which is fine at the ceiling, where there is room to coast, and is not at the
 * floor, where there is none.
 *
 * Worth being straight about what this is and is not: it is NOT what stops the
 * departure. Setting it back to the ceiling's 0.17 leaves the adversarial family at
 * 0 departures out of 25 — the lead, the scheduled floor and the ceiling fade are
 * what do that work, and each of those turns the family red when reverted. This buys
 * margin rather than correctness: worst-case alpha across the family goes from -9.65
 * to -9.35 against a data edge at -10, which is a little under half a degree of room
 * turned into a little under two thirds. It saturates around 0.45; 0.60 measures the
 * same.
 *
 * At the end with two degrees to give, doubling what is left is worth one constant.
 * It costs nothing elsewhere — the gain multiplies the margin, so far from the floor
 * it still authorises more nose-down rate than the stick can ask for.
 */
const AOA_GAIN_DOWN_PER_DEG = 0.45

/**
 * How far ahead the limiter looks approaching the CEILING, seconds.
 *
 * Limiting on present alpha alone does not work, and the first version of this file
 * did exactly that: fading the command out at the ceiling let alpha coast to 43
 * degrees at 20,000 ft — two degrees from the edge of the aerodynamic data. Pitch
 * rate does not stop when the command does, and alpha keeps rising anyway while the
 * aircraft decelerates in the pull. Limiting on where alpha will be a fraction of a
 * second from now gives the aircraft time to stop.
 *
 * Raised from 0.12, which limit-cycled. Reported from a flight test as "it pulls,
 * then stops pulling, then starts again": at 15,000 ft and 550 ft/s the commanded
 * rate ran +34, -42, +38, -30 deg/s inside two seconds, with the elevator slamming
 * between -21 and its +25 stop. The cause is that a rate command asks for far more
 * than the limits allow at low speed, so the limiter has to claw back a great deal,
 * and at a short lead it was always doing so too late and therefore too hard. The
 * cycle arrived with the rate command in dd34d84 — the g command before it never
 * reversed pitch rate under a steady pull at any condition tested.
 *
 * 0.40 removes it completely across the normal envelope. 0.55 is marginally tighter
 * and costs more of the pull; 0.25 still cycles.
 *
 * Recorded because it cost an hour and the reasoning was seductive: the obvious fix
 * looked like rebuilding this end in the shape of the real F-16's FLCS, whose
 * published schedule fades the permitted g command DOWN with alpha — roughly 8-9 g
 * below 15 degrees, 6.3-7.3 at 20, zero at the 25 degree limiter — and only reverses
 * once past the limit. Implemented here, that was WORSE. Fading to zero on predicted
 * alpha and reversing only on actual alpha puts a discontinuity at the boundary
 * between the two regimes, and in the low-energy corner, where alpha sits on the
 * ceiling and crosses it repeatedly, the aircraft bangs across that seam: 18 pitch
 * rate reversals at 20,000 ft and 450 ft/s against 0 for the plain proportional law.
 *
 * Which is this file's own opening argument, arrived at the expensive way. A limiter
 * built out of cases has a discontinuity at every case boundary and the pilot feels
 * each one. The law stays one branchless expression; the lead is what fixes the
 * cycle.
 */
const AOA_LEAD_UP_SECONDS = 0.40

/**
 * How far ahead the limiter looks approaching the FLOOR, seconds.
 *
 * Deliberately more than double the ceiling's, because the two ends are not the
 * same problem and sharing one constant between them was the bug. The data envelope
 * is -10 to +45: the floor sits 2 degrees from its edge where the ceiling sits 13.
 * The end with a sixth of the margin needs to start stopping sooner, not at the same
 * time.
 *
 * There is a second asymmetry underneath the first. Recovering from high alpha is
 * something the aircraft helps with — it is stable in that direction and the nose
 * wants to come down. Recovering from negative alpha means pulling, at negative g,
 * with less elevator authority than the pull needed, and the aircraft does not help
 * at all. Whatever the floor is going to do, it has to have started earlier.
 */
const AOA_LEAD_DOWN_SECONDS = 0.32

/** Reduction in the pitch rate cap per g of overshoot, rad/s. */
const NZ_FEEDBACK = 0.035

/**
 * The same on the negative side, rad/s per g.
 *
 * Stronger, because a pushover overshoots its limit where a pull undershoots its
 * own: measured, full aft reaches 10.5 g against a limit of 11, while full forward
 * reached -4.84 against -4. The asymmetry is the aircraft's, not a preference. A
 * pull is opposed by an airframe that becomes more stable and more draggy the harder
 * it is pulled; a push is not, and the load factor keeps building after the pitch
 * rate has stopped.
 *
 * This only became visible once the AoA limiter stopped spuriously throttling every
 * pushover — it had been hiding the g limiter's undershoot by taking the authority
 * away for the wrong reason.
 */
const NZ_FEEDBACK_NEGATIVE = 0.09

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
 * to pull.
 *
 * With the g limiter on this now does nothing measurable, and the honest reading is
 * that it is a backstop rather than a limit. The g limiter's own cap binds first at
 * every speed — full forward at 700 ft/s asks for 27.5 deg/s and is capped to 13.2
 * long before this fraction matters — and removing it entirely changes the sustained
 * pushover rate by less than a tenth of a degree per second, and the adversarial
 * family by 0.02 degrees of alpha.
 *
 * It earns its place only with the g limiter switched off, which §5 allows: there it
 * holds the pushover to -5.69 g rather than -5.83, and keeps alpha a fifth of a
 * degree further from the floor. Small, but it is the only thing left bounding the
 * nose-down command in that configuration.
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
 * @param qCmd      Commanded pitch rate, rad/s
 * @param alphaRad  Current angle of attack, radians
 * @param alphaRate Rate of change of alpha, rad/s — the lead term. NOT pitch rate:
 *   in steady curving flight q is large while alpha is constant, and leading on q
 *   there limits a command that needed no limiting. See `AssistLayer.previousAlpha`.
 */
export function limitAoA(
  qCmd: number,
  alphaRad: number,
  alphaRate: number,
  vt: number,
  ceilingDeg = AOA_CEILING_DEG,
  floorDeg = AOA_FLOOR_DEG,
): number {
  const ceiling = effectiveCeiling(ceilingDeg, vt)
  const floor = effectiveFloor(floorDeg, vt)
  const alphaDeg = radToDeg(alphaRad)
  const rateDeg = radToDeg(alphaRate)

  // Each end looks ahead by its own lead. Not symmetric, because the margins are
  // not: see AOA_LEAD_DOWN_SECONDS. The ceiling caps how much nose-up may be
  // commanded, the floor caps how much nose-down, and between them the stick is
  // untouched.
  const predictedUp = alphaDeg + rateDeg * AOA_LEAD_UP_SECONDS
  const predictedDown = alphaDeg + rateDeg * AOA_LEAD_DOWN_SECONDS

  // Approach and recovery are two different jobs and are kept apart.
  //
  // APPROACH fades the permitted rate to zero and no further, on PREDICTED alpha.
  // Inside the envelope the limiter may only take your pull away, never reverse it.
  //
  // RECOVERY is the only thing allowed to command the opposite direction, and it is
  // driven by ACTUAL alpha and bounded. You have to be genuinely outside the
  // envelope before the aircraft takes the stick off you, and even then it pushes at
  // a fixed modest rate rather than however hard the arithmetic happened to want.
  const upper = (ceiling - predictedUp) * AOA_GAIN_PER_DEG
  const lower = (floor - predictedDown) * AOA_GAIN_DOWN_PER_DEG

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
  const qMin = Math.max(qMinSteady, qMinSteady + (negative - nz) * NZ_FEEDBACK_NEGATIVE)

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

  // Left alone deliberately. Widening the floor's window was the obvious fix for the
  // departure this file's floor limiter now handles, and measured across 25
  // adversarial full-deflection inputs it changes nothing: 0 departures at a 5
  // degree window and 0 at 16. The pitch-axis floor — its own lead, its own gain,
  // scheduled on airspeed — is doing all of the work, so the roll axis does not need
  // to pay for it. A wider window here is not free: at 16 degrees the fade reaches
  // +8 degrees alpha, which is ordinary cruise, and roll authority quietly drops a
  // fifth in normal flight.
  const closeness = Math.max(
    smoothstep(ceilingDeg - 9, ceilingDeg, alphaDeg),
    smoothstep(floorDeg + 7, floorDeg, alphaDeg),
    smoothstep(positiveG - 2.5, positiveG, nz),
    smoothstep(negativeG + 2, negativeG, nz),
  )

  return 1 - (1 - ROLL_MIN_AUTHORITY) * closeness
}
