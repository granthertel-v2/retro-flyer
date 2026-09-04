/**
 * Shaping for the along-path acceleration cues (§6).
 *
 * Shared by the FOV and the chase camera so that the two swell together and are
 * calibrated against the same measured aeroplane rather than against two guesses.
 *
 * The input everywhere is `Simulation.ax` — `d(vt)/dt`, the acceleration a pilot
 * feels in their back. See the note there for why acceleration needs cues of its own
 * at all: every other speed cue in this project is a function of SPEED, and a
 * function of speed reports the result after the fact rather than the change as it
 * happens.
 */

/**
 * Along-path acceleration, ft/s^2, that the cues treat as "everything".
 *
 * Measured rather than chosen. Full afterburner from trim reaches 28.5 ft/s^2 at
 * 5,000 ft and 18.9 at 20,000; chopping to idle from Mach 0.9 reaches -14. A clean
 * fighter accelerates harder than it slows down, so the two directions are
 * normalised separately — otherwise the whole negative half of every cue is spent on
 * nothing, which is what happened when they shared one gain.
 */
export const AX_REFERENCE_ACCEL = 28.5
export const AX_REFERENCE_DECEL = 14

/**
 * Curve exponent, below 1 so the cue arrives early.
 *
 * A linear response makes the cue a report of how hard the aircraft is accelerating,
 * which sounds right and reads wrong: the first seconds of a slam are spent spooling,
 * where the acceleration is genuinely small, so a linear cue shows almost nothing
 * during the exact moment the engine is doing its most obvious work. A flight test
 * asked for the ramp to "start sooner", and this is the half of that which is not
 * about time constants.
 *
 * At 0.65, a third of full acceleration produces half of the full cue. One second
 * into a slam — 6.9 ft/s^2, still spooling — the FOV boost is 3.1 degrees rather
 * than 1.7.
 */
const AX_CURVE = 0.65

/**
 * Shaped response to acceleration, -1 to 1.
 *
 * Saturates at the measured references above, so full deflection of the cue means
 * "as hard as this aeroplane does this" rather than an arbitrary number.
 */
export function accelResponse(axFps2: number): number {
  if (axFps2 === 0) return 0

  const reference = axFps2 > 0 ? AX_REFERENCE_ACCEL : AX_REFERENCE_DECEL
  const normalised = Math.min(1, Math.abs(axFps2) / reference)
  const shaped = Math.pow(normalised, AX_CURVE)

  return axFps2 > 0 ? shaped : -shaped
}

/**
 * How much of the cue is held back for sustained acceleration, 0 to 1.
 *
 * Without this the cue is a function of instantaneous acceleration alone, and
 * instantaneous acceleration is FLAT through an afterburner run: measured from trim
 * at 2,200 ft, it reaches 30.7 ft/s^2 by t=3 and is still 28.3 at t=14, while the
 * aircraft goes from Mach 0.46 to 0.90. So the cue saturated three seconds in and
 * then sat perfectly still for the next thirteen — and a constant offset is not
 * perceived at all. That is why a flight test found the ramp "a bit too short",
 * having already been given a faster one: it was not too fast, it was over.
 *
 * A slow envelope that fills while acceleration is held gives the cue somewhere to
 * keep going. The immediate part still arrives in a tenth of a second, so the onset
 * is not softened; the remainder arrives across the next several seconds, so the
 * sensation of building speed lasts as long as the building does.
 */
const SUSTAIN_SHARE = 0.35

/**
 * Shaped response including the sustain envelope, -1 to 1.
 *
 * @param axFps2  Along-path acceleration, ft/s^2
 * @param sustain How long acceleration has been held, 0 to 1 — `Simulation.sustain`
 */
export function sustainedResponse(axFps2: number, sustain: number): number {
  const held = Math.min(1, Math.max(0, sustain))
  return accelResponse(axFps2) * (1 - SUSTAIN_SHARE + SUSTAIN_SHARE * held)
}
