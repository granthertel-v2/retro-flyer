/**
 * Roll rate command law (REQUIREMENTS §5).
 *
 * First order, so there is no placement to do beyond one division — see `gains.ts`.
 * A feedforward term sets the steady rate and a proportional loop corrects it.
 *
 * The feedforward is not optional. A proportional loop alone settles where its error
 * term balances the roll damping, which at this airframe works out to about eleven
 * per cent of what was asked for: commanding 308 deg/s delivered 118. That is not a
 * gain that needs raising — it is the wrong structure.
 *
 * ## The sign
 *
 * Positive aileron rolls this aircraft **left**. That is a property of the model,
 * pinned in the physics package's `goldenDerivatives.test.ts`, and it is the sort of
 * thing that costs an afternoon if you assume otherwise.
 *
 * It is not hard-coded here. `kRoll` is derived from the model's own control
 * derivative, so it comes out negative on its own and the law inherits the
 * convention rather than asserting one. If the aero data were ever regenerated with
 * the opposite sign, this file would keep working. `test/rollRate.test.ts` checks
 * stick-right actually rolls right, which is the assertion that matters.
 */

import { AILERON_LIMIT_DEG } from '../limits.js'
import type { GainSet } from '../gains.js'

/**
 * Baseline maximum commanded roll rate, degrees per second, before amplification.
 *
 * The F-16's published maximum is around 324 deg/s. 220 as a baseline leaves room
 * for §5's roll rate amplification to sit on top without the result being silly.
 */
export const BASE_ROLL_RATE_DEG = 220

/**
 * @param pCmd Commanded roll rate, rad/s. Positive rolls right.
 * @param p    Current roll rate, rad/s
 * @returns Aileron deflection, degrees
 */
export function rollCommand(pCmd: number, p: number, gains: GainSet): number {
  const aileron = gains.kRollFF * pCmd + gains.kRoll * (pCmd - p)
  return Math.min(AILERON_LIMIT_DEG, Math.max(-AILERON_LIMIT_DEG, aileron))
}
