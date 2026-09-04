/**
 * Input conditioning (REQUIREMENTS §5, always on).
 *
 * Keyboard is the primary device and a key is a step function: zero to full
 * deflection in one physics tick, 25 degrees of elevator in 8 milliseconds. Fed
 * straight to the model that is a hammer blow, and the aircraft responds like one.
 * The spec is explicit — "bang-bang keyboard input must never reach the model" — and
 * this file is the reason it does not.
 *
 * Three stages, in order:
 *
 * 1. **Deadband**, rescaled so the output stays continuous. A gamepad stick that
 *    rests at 0.02 should read as centred, but an axis that jumps from 0 to 0.05 the
 *    moment you cross the threshold is worse than no deadband at all.
 * 2. **Exponential smoothing**, which rounds the corner off a step.
 * 3. **Rate limiting**, which bounds how fast the command can slew no matter what
 *    the device did.
 *
 * Smoothing before rate limiting rather than after: the smoother turns a step into
 * something the rate limiter can follow, so the limiter only engages on genuinely
 * fast input, and the two do not fight over the same 40 milliseconds.
 *
 * All the numbers here are `[A]`. §3 notes that actuator rate limits are not
 * published with this dataset, which puts them on the assist side of the §4.4
 * boundary — free to tune for feel, and tuning them cannot turn a physics test red.
 */

export interface AxisConfig {
  /** Maximum slew, units per second, while the axis is being commanded. */
  rate: number
  /** Maximum slew while returning to centre. Faster than `rate` — release should feel immediate. */
  centeringRate: number
  /** Smoothing time constant, seconds. */
  tau: number
  /** Fraction of travel treated as centred. */
  deadband: number
}

export const PITCH_AXIS: AxisConfig = { rate: 3.2, centeringRate: 4.5, tau: 0.055, deadband: 0.06 }
export const ROLL_AXIS: AxisConfig = { rate: 4.5, centeringRate: 6.0, tau: 0.045, deadband: 0.06 }
export const YAW_AXIS: AxisConfig = { rate: 3.0, centeringRate: 4.0, tau: 0.08, deadband: 0.10 }

/**
 * Throttle does not self-centre — it stays where it is put — so its centring rate is
 * its normal rate.
 *
 * It used to be much slower than this, at 0.4 per second: two and a half seconds
 * idle to full, on the reasoning that it is roughly what a real throttle quadrant
 * takes and that it makes energy something you manage rather than toggle. The
 * intent was right and the mechanism was wrong, because **the engine already does
 * this job**, with validated physics rather than a taste setting. `pdot` and `rtau`
 * model turbofan spool-up, including afterburner hysteresis at the 50 per cent
 * line, and they are held to 1e-12 against the reference implementation. Slewing
 * the input as well simply lagged a lag.
 *
 * Measured at 5,000 ft and 500 ft/s, slamming to full from trim, the two contributions
 * were not close to equal:
 *
 *     0.00 - 2.13 s    the COMMAND is still slewing        conditioning
 *     2.13 - 3.04 s    the engine spools, AB lights        physics
 *
 * Two thirds of the delay was this file, and it was the two thirds nearest the
 * pilot's hand, so it was all of what a flight test described as "a lag from when I
 * start accelerating to when I start seeing it in the plane".
 *
 * At 1.2 the command is full in 0.71 s and thrust one second after the slam is 6,036
 * lb against 4,107 — half again as much, in the window where it is actually felt.
 * Time to 90 per cent thrust goes 3.04 s to 2.56 s. Raising it further buys nothing:
 * past about 1.2 the smoothing below binds instead, and past that the engine does.
 *
 * What remains is engine spool, and it stays. It is the real aeroplane, it is what
 * makes energy worth managing, and §4.4 puts it firmly out of reach.
 */
export const THROTTLE_AXIS: AxisConfig = {
  rate: 1.2,
  centeringRate: 1.2,
  tau: 0.10,
  deadband: 0,
}

/** Deadband with the remaining travel rescaled to the full range. */
export function applyDeadband(value: number, deadband: number): number {
  if (deadband <= 0) return value

  const magnitude = Math.abs(value)
  if (magnitude <= deadband) return 0

  return Math.sign(value) * ((magnitude - deadband) / (1 - deadband))
}

export class ConditionedAxis {
  /** The conditioned output — what the control laws see. */
  value = 0

  private smoothed = 0

  constructor(private readonly config: AxisConfig, initial = 0) {
    this.value = initial
    this.smoothed = initial
  }

  /** Advance by `dt` toward `target`, the raw device reading. */
  update(target: number, dt: number): number {
    if (dt <= 0) return this.value

    const wanted = applyDeadband(target, this.config.deadband)

    // Exponential smoothing, framed so the time constant means the same thing
    // regardless of step size. `dt/tau` would drift with frame rate; this does not.
    const blend = 1 - Math.exp(-dt / this.config.tau)
    this.smoothed += (wanted - this.smoothed) * blend

    const returning = wanted === 0 && Math.abs(this.value) > Math.abs(this.smoothed)
    const limit = (returning ? this.config.centeringRate : this.config.rate) * dt

    const delta = this.smoothed - this.value
    this.value += Math.max(-limit, Math.min(limit, delta))

    return this.value
  }

  reset(to = 0): void {
    this.value = to
    this.smoothed = to
  }
}
