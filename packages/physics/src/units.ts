/**
 * Units.
 *
 * The physics package is imperial throughout: feet, pounds, slugs, ft/s, radians
 * for angles internally and degrees only where the source model uses them.
 *
 * That is a deliberate choice, not inertia. Every aerodynamic number in this
 * package traces to a source that is imperial (see `docs/SOURCES.md`), and each
 * unit conversion placed inside the validation-critical layer is one more chance
 * to introduce an error that the tests would then bless as correct. So the
 * conversions live at the edge: the Aero -> Renderer seam (REQUIREMENTS §8.3)
 * converts once, in one place.
 *
 * A trap worth naming: the source model's control deflections are in DEGREES
 * while its angular rates are in RADIANS per second, in the same state vector.
 * That is not a mistake in the port. See `state.ts`.
 */

export const FT_PER_M = 3.280839895013123
export const M_PER_FT = 0.3048

export const LB_PER_KG = 2.2046226218487757
export const KG_PER_LB = 0.45359237

/** Knots per ft/s. */
export const KT_PER_FPS = 0.5924838012958964
/** ft/s per knot. */
export const FPS_PER_KT = 1.6878098571011957

/** ft/min per ft/s. */
export const FPM_PER_FPS = 60

export const DEG_PER_RAD = 57.29577951308232
export const RAD_PER_DEG = 0.017453292519943295

/**
 * Gravitational acceleration, ft/s^2.
 *
 * 32.17 exactly, not 32.174. This is the value the reference model uses, and the
 * trim solutions are referenced to it. Do not "correct" it: doing so shifts every
 * trim result and breaks Tier A. [AEROBENCH] subf16_model.py
 */
export const G_FT_S2 = 32.17

export const degToRad = (deg: number): number => deg * RAD_PER_DEG
export const radToDeg = (rad: number): number => rad * DEG_PER_RAD

export const ftToM = (ft: number): number => ft * M_PER_FT
export const mToFt = (m: number): number => m * FT_PER_M

export const fpsToKt = (fps: number): number => fps * KT_PER_FPS
export const ktToFps = (kt: number): number => kt * FPS_PER_KT

/** Slugs from pounds-force at standard gravity. */
export const lbToSlug = (lb: number): number => lb / G_FT_S2
/** Pounds-force from slugs at standard gravity. */
export const slugToLb = (slug: number): number => slug * G_FT_S2

/**
 * Degrees per radian, as the reference model rounds it: 57.29578.
 *
 * The true value is 57.295779513... The source truncates, and that truncation is
 * baked into the aerodynamic model: alpha and beta are converted with this constant
 * before every table lookup, so the tables are, in effect, indexed on it.
 *
 * The difference is 8.5e-9 relative — physically meaningless, and detectable by
 * nothing a pilot could ever feel. It is adopted anyway for the same reason
 * `G_FT_S2` is 32.17 rather than 32.174: it lets the Tier A golden vectors hold the
 * whole model to 1e-12 instead of 1e-7. A 1e-7 tolerance would quietly admit real
 * transcription errors in the low-order digits, which is the exact failure mode
 * Tier A exists to catch.
 *
 * Use `DEG_PER_RAD` for anything a human reads. Use this only where the model's
 * own arithmetic requires it.
 */
export const DEG_PER_RAD_MODEL = 57.29578
