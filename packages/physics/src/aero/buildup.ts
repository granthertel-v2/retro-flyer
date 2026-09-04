/**
 * Coefficient buildup: assembling the individual tables into the six total
 * force and moment coefficients.
 *
 * Three things happen here that the individual table functions do not do.
 *
 * 1. **Control derivatives are added in.** Aileron and rudder contribute rolling
 *    and yawing moment on top of the sideslip-driven values.
 * 2. **Damping terms are added.** These depend on body rates non-dimensionalized by
 *    airspeed, so unlike the static tables they are a function of the flight
 *    condition, not just geometry.
 * 3. **The CG correction is applied.** Coefficients are published about 0.35 c-bar;
 *    if the actual CG is elsewhere, normal force generates extra pitching moment
 *    and side force generates extra yawing moment. This is the term that makes
 *    REQUIREMENTS §8.4 load-bearing rather than decorative: move the CG via the
 *    loadout and the moments genuinely change.
 *
 * Angles in, angles out: alpha and beta arrive in DEGREES here (that is what the
 * tables want), while body rates are in rad/s. The conversion happens in
 * `dynamics.ts`, once.
 */

import {
  cl,
  cm,
  cn,
  cx,
  cy,
  cz,
  dampingArray,
  dlda,
  dldr,
  dnda,
  dndr,
} from '../tables/coefficients.js'
import { MEAN_CHORD, WING_SPAN, XCG_REF } from '../massProperties.js'

export interface BuildupInput {
  /** Angle of attack, degrees. */
  alphaDeg: number
  /** Sideslip, degrees. */
  betaDeg: number
  /** Elevator deflection, degrees. */
  elevatorDeg: number
  /** Aileron deflection, degrees. */
  aileronDeg: number
  /** Rudder deflection, degrees. */
  rudderDeg: number
  /** Roll rate, rad/s. */
  p: number
  /** Pitch rate, rad/s. */
  q: number
  /** Yaw rate, rad/s. */
  r: number
  /** True airspeed, ft/s. */
  vt: number
  /** Actual CG, fraction of mean aerodynamic chord. */
  xcg: number
}

/** Total body-axis force and moment coefficients. */
export interface Coefficients {
  /** Axial force (x-body). */
  cxt: number
  /** Side force (y-body). */
  cyt: number
  /** Normal force (z-body). */
  czt: number
  /** Rolling moment. */
  clt: number
  /** Pitching moment. */
  cmt: number
  /** Yawing moment. */
  cnt: number
}

/**
 * Assemble total coefficients. Direct port of the build-up in [AEROBENCH]
 * subf16_model.py, Stevens (table) mode.
 */
export function buildCoefficients(i: BuildupInput): Coefficients {
  const { alphaDeg, betaDeg, elevatorDeg, aileronDeg, rudderDeg, p, q, r, vt, xcg } = i

  // Control deflections are normalized by their reference deflections, not their
  // limits: the tables give moment at 20 deg aileron and 30 deg rudder.
  const dail = aileronDeg / 20
  const drdr = rudderDeg / 30

  let cxt = cx(alphaDeg, elevatorDeg)
  let cyt = cy(betaDeg, aileronDeg, rudderDeg)
  let czt = cz(alphaDeg, betaDeg, elevatorDeg)

  let clt =
    cl(alphaDeg, betaDeg) +
    dlda(alphaDeg, betaDeg) * dail +
    dldr(alphaDeg, betaDeg) * drdr
  let cmt = cm(alphaDeg, elevatorDeg)
  let cnt =
    cn(alphaDeg, betaDeg) +
    dnda(alphaDeg, betaDeg) * dail +
    dndr(alphaDeg, betaDeg) * drdr

  // Non-dimensionalize the rates. Dividing by airspeed is what makes damping a
  // function of how fast you are going: the same pitch rate is a much larger
  // aerodynamic angle change at 300 ft/s than at 900.
  const tvt = 0.5 / vt
  const b2v = WING_SPAN * tvt
  const cq = MEAN_CHORD * q * tvt

  const d = dampingArray(alphaDeg)

  cxt += cq * (d[0] as number)
  cyt += b2v * ((d[1] as number) * r + (d[2] as number) * p)
  czt += cq * (d[3] as number)
  clt += b2v * ((d[4] as number) * r + (d[5] as number) * p)

  // CG correction. Zero when xcg == XCG_REF, which is the default loadout.
  const dxcg = XCG_REF - xcg

  cmt += cq * (d[6] as number) + czt * dxcg
  cnt +=
    b2v * ((d[7] as number) * r + (d[8] as number) * p) -
    (cyt * dxcg * MEAN_CHORD) / WING_SPAN

  return { cxt, cyt, czt, clt, cmt, cnt }
}
