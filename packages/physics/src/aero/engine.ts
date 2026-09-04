/**
 * Engine model: thrust, throttle gearing, and power-level dynamics.
 *
 * Ported from the reference implementation ([AEROBENCH] thrust.py, tgear.py,
 * pdot.py, rtau.py). Held to 1e-12 by `test/goldenEngine.test.ts`.
 *
 * Note that the thrust tables use ordinary bilinear interpolation, unlike the
 * aerodynamic tables, which use the sign-stepping scheme in `tables/lookup.ts`.
 * Two different schemes in one model is not an inconsistency we introduced; it is
 * how the source is written.
 */

import { fix } from '../tables/lookup.js'
import {
  THRUST_IDLE_TABLE,
  THRUST_MAX_TABLE,
  THRUST_MIL_TABLE,
} from '../tables/data.js'

/** Highest tabulated altitude, ft. [NASA-TM] p.29 */
export const THRUST_TABLE_MAX_ALT = 50000
/** Highest tabulated Mach number. [NASA-TM] p.29 */
export const THRUST_TABLE_MAX_MACH = 1.0

/**
 * Whether a thrust lookup falls outside the tabulated data.
 *
 * This matters and is easy to miss. The reference implementation does **not** clamp
 * outside the table — it clamps the *index* but lets the interpolation weight run
 * past 1, which linearly extrapolates. Beyond roughly 65,000 ft that produces
 * negative thrust at high power settings, which is not a thing engines do.
 *
 * We keep the extrapolation, because it is the model and because Tier A pins it.
 * But callers get told, so a decision to fly above 50,000 ft is a decision rather
 * than an accident. REQUIREMENTS §2.3 sets the atmosphere ceiling at 60,000 ft;
 * thrust is already unreliable well before that.
 */
export function thrustOutsideTable(alt: number, mach: number): boolean {
  return alt > THRUST_TABLE_MAX_ALT || mach > THRUST_TABLE_MAX_MACH || alt < 0
}

/**
 * Thrust, lb, from power level (0-100), altitude (ft), and Mach.
 *
 * Three 6x6 tables on (altitude, Mach) for idle, military and maximum power.
 * Below power 50 the result interpolates idle->military; above it,
 * military->maximum. That 50 is the afterburner threshold in power-level terms.
 *
 * Tables are stored as `table[machIndex][altIndex]`, matching the source's
 * pre-transpose literals.
 */
export function thrust(power: number, alt: number, mach: number): number {
  // The source substitutes 0.01 rather than 0 for negative altitude. Keeping it:
  // it makes no numerical difference at this scale, but diverging here would show
  // up as a Tier A failure and cost someone an afternoon.
  const altitude = alt < 0 ? 0.01 : alt

  const h = 0.0001 * altitude
  let i = fix(h)
  if (i >= 5) i = 4
  const dh = h - i

  const rm = 5 * mach
  let m = fix(rm)
  if (m >= 5) m = 4
  else if (m <= 0) m = 0
  const dm = rm - m

  const cdh = 1 - dh

  const at = (table: readonly (readonly number[])[], machIdx: number, altIdx: number): number =>
    (table[machIdx] as readonly number[])[altIdx] as number

  const bilinear = (table: readonly (readonly number[])[]): number => {
    const s = at(table, m, i) * cdh + at(table, m, i + 1) * dh
    const t = at(table, m + 1, i) * cdh + at(table, m + 1, i + 1) * dh
    return s + (t - s) * dm
  }

  const tmil = bilinear(THRUST_MIL_TABLE)

  if (power < 50) {
    const tidl = bilinear(THRUST_IDLE_TABLE)
    return tidl + (tmil - tidl) * power * 0.02
  }

  const tmax = bilinear(THRUST_MAX_TABLE)
  return tmil + (tmax - tmil) * (power - 50) * 0.02
}

/**
 * Throttle gearing: commanded power level (0-100) from throttle position (0-1).
 *
 * Piecewise linear with a knee at 0.77, which is the afterburner detent. Below it,
 * throttle maps into the idle-to-military band; above it, the curve steepens
 * sharply to cover military-to-maximum in the remaining 23% of travel.
 *
 * This is what REQUIREMENTS §2.2 means by "afterburner engaged above a detent" —
 * the detent is already in the source model, at 0.77.
 */
export function tgear(throttle: number): number {
  return throttle <= 0.77 ? 64.94 * throttle : 217.38 * throttle - 117.38
}

/**
 * Inverse of the power-level lag time constant, 1/s, as a function of the power
 * error `dp`.
 *
 * Large commanded changes respond slower (0.1) than small ones (1.0). That is
 * spool-up physics: a turbofan asked for a big change takes proportionally longer.
 */
export function rtau(dp: number): number {
  if (dp <= 25) return 1.0
  if (dp >= 50) return 0.1
  return 1.9 - 0.036 * dp
}

/**
 * Power level derivative, %/s. `p3` is actual power, `p1` is commanded.
 *
 * The branching encodes afterburner hysteresis. Crossing the 50% line in either
 * direction is not symmetric with staying on one side of it: lighting the burner
 * targets 60 before settling, and cancelling it drops to 40, both at a fixed fast
 * time constant of 5. Within a band, the ordinary `rtau` lag applies.
 *
 * This is why throttle response is not a simple first-order lag and why the assist
 * layer should not try to model it as one.
 */
export function pdot(p3: number, p1: number): number {
  let t: number
  let p2: number

  if (p1 >= 50) {
    if (p3 >= 50) {
      t = 5
      p2 = p1
    } else {
      p2 = 60
      t = rtau(p2 - p3)
    }
  } else {
    if (p3 >= 50) {
      t = 5
      p2 = 40
    } else {
      p2 = p1
      t = rtau(p2 - p3)
    }
  }

  return t * (p2 - p3)
}
