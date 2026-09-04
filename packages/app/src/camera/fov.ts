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

const smoothstep = (x: number): number => x * x * (3 - 2 * x)

/** Target FOV for an airspeed, degrees. */
export function targetFov(kt: number): number {
  const t = Math.min(1, Math.max(0, (kt - FOV_LOW_KT) / (FOV_HIGH_KT - FOV_LOW_KT)))
  return FOV_BASE + (FOV_MAX - FOV_BASE) * smoothstep(t)
}

export class FovController {
  current = FOV_BASE

  update(kt: number, dt: number): number {
    const target = targetFov(kt)
    const limit = FOV_RATE * Math.min(dt, 0.1)
    const delta = target - this.current

    this.current += Math.max(-limit, Math.min(limit, delta))
    return this.current
  }

  reset(kt: number): void {
    this.current = targetFov(kt)
  }
}
