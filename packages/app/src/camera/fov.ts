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
 * Extra FOV per ft/s^2 of along-path acceleration, degrees.
 *
 * The FOV band above is a function of SPEED, and a function of speed cannot convey
 * acceleration — it reports the result after the fact. That is the whole of why a
 * flight test could say "I don't feel like I've accelerated quickly, I have to
 * intuit it from the Mach number increasing and my waiting": every cue in the
 * renderer was telling the pilot how fast they were, and none was telling them that
 * it was changing.
 *
 * So the FOV punches out while accelerating and draws in while decelerating, on top
 * of whatever the speed band is asking for. Under full afterburner this aircraft
 * makes about 32 ft/s^2, so the gain puts the boost near 8 degrees at full
 * acceleration — enough to be felt as a shove, well short of a fisheye.
 *
 * Deceleration gets a smaller total allowance but a LARGER gain, which is not a
 * contradiction. Measured, this aircraft accelerates far harder than it slows down
 * in clean configuration: full afterburner reaches 28.5 ft/s^2 at 5,000 ft, while
 * flight idle from a fast cruise only reaches -8.5. One gain across both would have
 * spent the entire negative range on nothing — the -4 clamp was unreachable, and
 * decelerating produced barely two degrees. Separate gains put both ends of the cue
 * within reach of inputs the pilot can actually make.
 */
const FOV_ACCEL_GAIN = 0.25
const FOV_DECEL_GAIN = 0.45
const FOV_ACCEL_MAX = 8
const FOV_ACCEL_MIN = -4

/**
 * FOV added by acceleration, degrees.
 *
 * @param axFps2 Along-path acceleration, ft/s^2. Positive is speeding up.
 */
export function accelFovBoost(axFps2: number): number {
  const gain = axFps2 >= 0 ? FOV_ACCEL_GAIN : FOV_DECEL_GAIN
  return Math.max(FOV_ACCEL_MIN, Math.min(FOV_ACCEL_MAX, axFps2 * gain))
}

const smoothstep = (x: number): number => x * x * (3 - 2 * x)

/** Target FOV for an airspeed, degrees. */
export function targetFov(kt: number): number {
  const t = Math.min(1, Math.max(0, (kt - FOV_LOW_KT) / (FOV_HIGH_KT - FOV_LOW_KT)))
  return FOV_BASE + (FOV_MAX - FOV_BASE) * smoothstep(t)
}

export class FovController {
  current = FOV_BASE

  /**
   * @param axFps2 Along-path acceleration, ft/s^2 — see `accelFovBoost`
   */
  update(kt: number, axFps2: number, dt: number): number {
    const target = targetFov(kt) + accelFovBoost(axFps2)
    const limit = FOV_RATE * Math.min(dt, 0.1)
    const delta = target - this.current

    this.current += Math.max(-limit, Math.min(limit, delta))
    return this.current
  }

  reset(kt: number): void {
    this.current = targetFov(kt)
  }
}
