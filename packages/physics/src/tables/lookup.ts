/**
 * Table lookup.
 *
 * This is a literal port of the indexing scheme in the reference implementation,
 * and it is deliberately not "cleaned up" into ordinary bilinear interpolation,
 * because it is not ordinary bilinear interpolation.
 *
 * Two behaviors in particular are load-bearing and would be lost by tidying:
 *
 * 1. **It extrapolates past the table edges rather than clamping.** The index is
 *    clamped, but the interpolation weight `|da|` is not, so below -10 deg alpha
 *    the scheme keeps running the straight line through the first two nodes. At
 *    alpha = -20 deg the weight reaches 2.0 -- a full extra node beyond the data.
 *    That is what the source does, so it is what the model does, and the golden
 *    vectors pin it.
 *
 * 2. **The neighbor is chosen by sign, not by floor.** `l = k + sign(da)` steps
 *    toward whichever side the sample falls on, and the weight is `|da|`. For
 *    positive `da` this is the same as standard interpolation. For negative `da`
 *    it is a reflection of it, and the two differ.
 *
 * Getting either wrong produces a model that is subtly, permanently, invisibly
 * wrong. `test/goldenCoefficients.test.ts` holds this to 1e-12 for exactly that
 * reason.
 */

/**
 * Round toward zero. Python's `fix` / MATLAB's `fix`.
 *
 * Not `Math.floor` -- they differ for negative arguments, and every alpha below
 * zero takes that branch.
 */
export const fix = (v: number): number => Math.trunc(v)

/** Sign of a number: -1, 0, or +1. Note `sign(0) === 0`, which the scheme relies on. */
export const sign = (v: number): number => (v < 0 ? -1 : v > 0 ? 1 : 0)

/**
 * The neighbor step, written as the source writes it: `fix(1.1 * sign(d))`.
 *
 * Algebraically this is just `sign(d)` -- `sign` only ever returns -1, 0 or 1, and
 * truncating 1.1x those gives back -1, 0, 1. It is kept in the source's form so
 * that a reader comparing the two files side by side sees the same expression.
 */
const neighborStep = (d: number): number => fix(1.1 * sign(d))

/**
 * A resolved pair of table indices plus the interpolation weight between them.
 *
 * Indices are 0-based here; the source is 1-based with a `+3` offset folded in.
 * The conversion is done once, inside each index function, rather than scattered.
 */
export interface AxisIndex {
  /** Base node index, 0-based. */
  k: number
  /** Neighbor node index, 0-based. */
  l: number
  /** Interpolation weight. NOT clamped to [0, 1] -- see the note above. */
  w: number
}

/**
 * Alpha axis: 12 nodes, -10 deg to +45 deg in 5 deg steps.
 *
 * Shared by every aerodynamic table.
 */
export function alphaIndex(alphaDeg: number): AxisIndex {
  const s = 0.2 * alphaDeg
  let k = fix(s)

  if (k <= -2) k = -1
  if (k >= 9) k = 8

  const da = s - k
  const l = k + neighborStep(da)

  // Source adds 3 to reach 1-based indices; we subtract 1 more for 0-based.
  return { k: k + 2, l: l + 2, w: Math.abs(da) }
}

/**
 * Elevator axis: 5 nodes, -24 deg to +24 deg in 12 deg steps. Used by cx and cm.
 */
export function elevatorIndex(elDeg: number): AxisIndex {
  const s = elDeg / 12
  let m = fix(s)

  if (m <= -2) m = -1
  if (m >= 2) m = 1

  const de = s - m
  const n = m + neighborStep(de)

  return { k: m + 2, l: n + 2, w: Math.abs(de) }
}

/**
 * Sideslip axis, magnitude form: 7 nodes, 0 to 30 deg in 5 deg steps.
 *
 * Used by cl and cn, whose tables are defined for |beta| and whose results are then
 * multiplied by `sign(beta)` -- these coefficients are odd functions of sideslip.
 *
 * Note `if (m === 0) m = 1`: the first row of both tables is all zeros (zero rolling
 * and yawing moment at zero sideslip), so the scheme skips it and interpolates
 * between rows 1 and 2 instead, which for small beta means extrapolating backward
 * toward that zero row. Again: source behavior, kept.
 */
export function betaMagnitudeIndex(betaDeg: number): AxisIndex {
  const s = 0.2 * Math.abs(betaDeg)
  let m = fix(s)

  if (m === 0) m = 1
  if (m >= 6) m = 5

  const db = s - m
  const n = m + neighborStep(db)

  // Source adds 1 to reach 1-based indices; we subtract 1 more for 0-based.
  return { k: m, l: n, w: Math.abs(db) }
}

/**
 * Sideslip axis, signed form: 7 nodes, -30 deg to +30 deg in 10 deg steps.
 *
 * Used by the control-derivative tables (dlda, dldr, dnda, dndr), which are not odd
 * in beta and so are tabulated across the full range at coarser spacing.
 */
export function betaSignedIndex(betaDeg: number): AxisIndex {
  const s = 0.1 * betaDeg
  let m = fix(s)

  if (m <= -3) m = -2
  if (m >= 3) m = 2

  const db = s - m
  const n = m + neighborStep(db)

  return { k: m + 3, l: n + 3, w: Math.abs(db) }
}

/** Read a 1-D table at a resolved axis index. */
export function interp1(table: readonly number[], a: AxisIndex): number {
  const base = table[a.k] as number
  const neighbor = table[a.l] as number
  return base + a.w * (neighbor - base)
}

/**
 * Read a 2-D table at resolved indices on both axes.
 *
 * `table` is stored pre-transpose as `table[column][alphaIndex]`, matching the
 * source's array literals directly (see `data.ts`). Alpha is interpolated first,
 * then the second axis -- the same order as the source, which matters because the
 * scheme is not symmetric once weights exceed 1.
 */
export function interp2(
  table: readonly (readonly number[])[],
  alpha: AxisIndex,
  other: AxisIndex,
): number {
  const colK = table[other.k] as readonly number[]
  const colL = table[other.l] as readonly number[]

  const t = colK[alpha.k] as number
  const u = colL[alpha.k] as number

  const v = t + alpha.w * ((colK[alpha.l] as number) - t)
  const w = u + alpha.w * ((colL[alpha.l] as number) - u)

  return v + (w - v) * other.w
}
