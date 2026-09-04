/**
 * Field of view against airspeed (§6).
 *
 * The cheapest and most effective speed cue there is. Widening the FOV pushes the
 * edges of the frame outward faster than the centre, so peripheral motion increases
 * superlinearly with speed — which is exactly what the eye reads as "fast" and what
 * a fixed FOV never gives you no matter what the numbers say.
 *
 * The rate limit matters as much as the curve. FOV that tracks airspeed instantly
 * pumps in and out on every throttle change and every turn, and the world appears to
 * breathe. Lagging it by most of a second turns it into something felt rather than
 * seen.
 */

export const FOV_BASE = 58
export const FOV_MAX = 94

/**
 * Airspeeds, knots, between which the FOV opens up.
 *
 * The old band, 200 to 800 kt, put almost all of its travel above the speeds the
 * aircraft is actually flown at. 640 ft/s — the spawn, and a fast cruise — is 379
 * kt, which sat at 66 degrees: barely wider than the 58 degree base, so the cue was
 * spent on speeds reached only in a dive.
 *
 *     kt     old FOV    new FOV
 *     300      61         65
 *     379      66         73
 *     450      72         81
 *     550      80         91
 *
 * Topping out at 640 kt rather than 800 puts the full widening inside the envelope
 * that gets flown, which is the only place a cue is worth anything.
 */
export const FOV_LOW_KT = 170
export const FOV_HIGH_KT = 640

/** How fast the FOV may change, degrees per second. */
const FOV_RATE = 22

/**
 * Hard ceiling on the combined FOV, degrees.
 *
 * The acceleration term adds ON TOP of the speed band rather than inside it, which
 * is deliberate — the two say different things — but it means they can sum past
 * `FOV_MAX`. Measured, a full afterburner run to Mach 0.9 reached 98 degrees against
 * a band that stops at 94. A few degrees of overshoot is the point of the cue, so
 * the ceiling sits above `FOV_MAX` rather than at it; what it prevents is the
 * unbounded case where both terms saturate together.
 */
const FOV_HARD_MAX = 99

/**
 * Full travel of the acceleration term, degrees.
 *
 * The FOV band above is a function of SPEED, and a function of speed cannot convey
 * acceleration — it reports the result after the fact. That is the whole of why a
 * flight test could say "I don't feel like I've accelerated quickly, I have to
 * intuit it from the Mach number increasing and my waiting": every cue in the
 * renderer was telling the pilot how fast they were, and none was telling them that
 * it was changing.
 *
 * So the FOV punches out while accelerating and draws in while decelerating, on top
 * of whatever the speed band is asking for. Deceleration gets less travel because
 * pulling the frame IN is the more noticeable direction, and an aircraft that is
 * merely coasting should not feel like it is braking.
 *
 * Reaching full travel means "as hard as this aeroplane accelerates", not an
 * arbitrary threshold — `accelResponse` normalises against measured values.
 */
const FOV_ACCEL_TRAVEL = 8
const FOV_DECEL_TRAVEL = 4

/**
 * FOV added by acceleration, degrees.
 *
 * @param axFps2  Along-path acceleration, ft/s^2. Positive is speeding up.
 * @param sustain How long it has been held, 0 to 1 — see `sustainedResponse`
 */
export function accelFovBoost(axFps2: number, sustain = 1): number {
  const response = sustainedResponse(axFps2, sustain)
  return response * (response >= 0 ? FOV_ACCEL_TRAVEL : FOV_DECEL_TRAVEL)
}

import { sustainedResponse } from './accel.js'

const smoothstep = (x: number): number => x * x * (3 - 2 * x)

/** Target FOV for an airspeed, degrees. */
export function targetFov(kt: number): number {
  const t = Math.min(1, Math.max(0, (kt - FOV_LOW_KT) / (FOV_HIGH_KT - FOV_LOW_KT)))
  return FOV_BASE + (FOV_MAX - FOV_BASE) * smoothstep(t)
}

export class FovController {
  current = FOV_BASE

  /**
   * @param axFps2  Along-path acceleration, ft/s^2 — see `accelFovBoost`
   * @param sustain How long it has been held, 0 to 1 — see `sustainedResponse`
   */
  update(kt: number, axFps2: number, sustain: number, dt: number): number {
    const target = Math.min(FOV_HARD_MAX, targetFov(kt) + accelFovBoost(axFps2, sustain))
    const limit = FOV_RATE * Math.min(dt, 0.1)
    const delta = target - this.current

    this.current += Math.max(-limit, Math.min(limit, delta))
    return this.current
  }

  reset(kt: number): void {
    this.current = targetFov(kt)
  }
}
