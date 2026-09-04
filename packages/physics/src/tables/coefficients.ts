/**
 * The individual aerodynamic coefficient functions.
 *
 * One function per table, each a direct port of the corresponding module in the
 * reference implementation. They are pure: given alpha, beta, and control
 * deflections in DEGREES, they return dimensionless coefficients. No state, no
 * atmosphere, no attitude.
 *
 * That purity is what makes Tier A testing possible at 1e-12 -- see
 * `test/goldenCoefficients.test.ts`. It is also why this file is the safest place
 * in the package and `dynamics.ts` is the least safe.
 *
 * Sign conventions are body-axis, standard: x forward, y right, z down. So `cz` is
 * negative in normal flight (lift acts up, which is -z).
 */

import {
  CL_TABLE,
  CM_TABLE,
  CN_TABLE,
  CX_TABLE,
  CZ_TABLE,
  DAMPP_TABLE,
  DLDA_TABLE,
  DLDR_TABLE,
  DNDA_TABLE,
  DNDR_TABLE,
} from './data.js'
import {
  alphaIndex,
  betaMagnitudeIndex,
  betaSignedIndex,
  elevatorIndex,
  interp1,
  interp2,
  sign,
} from './lookup.js'

/** Axial (x-body) force coefficient. Function of alpha and elevator. */
export function cx(alphaDeg: number, elDeg: number): number {
  return interp2(CX_TABLE, alphaIndex(alphaDeg), elevatorIndex(elDeg))
}

/**
 * Side (y-body) force coefficient.
 *
 * The only coefficient with no table at all -- it is a closed-form linear fit in
 * the source. Sideforce is close enough to linear in sideslip over this range that
 * tabulating it bought nothing.
 */
export function cy(betaDeg: number, ailDeg: number, rdrDeg: number): number {
  return -0.02 * betaDeg + 0.021 * (ailDeg / 20) + 0.086 * (rdrDeg / 30)
}

/**
 * Normal (z-body) force coefficient. This is the one that carries lift.
 *
 * Structure: a 1-D table in alpha, reduced by a `(1 - (beta/57.3)^2)` factor for
 * sideslip, plus a linear elevator term. The 57.3 is degrees-per-radian, so that
 * factor is `1 - beta_rad^2` -- a small-angle cosine, meaning lift falls off with
 * sideslip roughly as you would expect and exactly as the source says.
 */
export function cz(alphaDeg: number, betaDeg: number, elDeg: number): number {
  const base = interp1(CZ_TABLE, alphaIndex(alphaDeg))
  return base * (1 - (betaDeg / 57.3) ** 2) - 0.19 * (elDeg / 25)
}

/**
 * Rolling moment coefficient, from sideslip. Odd in beta.
 *
 * This is dihedral effect: sideslip to the right produces a roll to the left. It is
 * why an uncoordinated turn tends to self-correct, and why the auto-coordination
 * assist (REQUIREMENTS §5) has something to work with.
 */
export function cl(alphaDeg: number, betaDeg: number): number {
  const value = interp2(CL_TABLE, alphaIndex(alphaDeg), betaMagnitudeIndex(betaDeg))
  return value * sign(betaDeg)
}

/**
 * Pitching moment coefficient. Function of alpha and elevator.
 *
 * The single most important table in the model for whether the aircraft is
 * longitudinally stable, and therefore the first thing to corrupt in the §4.3
 * break-check.
 */
export function cm(alphaDeg: number, elDeg: number): number {
  return interp2(CM_TABLE, alphaIndex(alphaDeg), elevatorIndex(elDeg))
}

/** Yawing moment coefficient, from sideslip. Odd in beta -- weathercock stability. */
export function cn(alphaDeg: number, betaDeg: number): number {
  const value = interp2(CN_TABLE, alphaIndex(alphaDeg), betaMagnitudeIndex(betaDeg))
  return value * sign(betaDeg)
}

/** Rolling moment per unit aileron, at full 20 deg deflection. */
export function dlda(alphaDeg: number, betaDeg: number): number {
  return interp2(DLDA_TABLE, alphaIndex(alphaDeg), betaSignedIndex(betaDeg))
}

/** Rolling moment per unit rudder, at full 30 deg deflection. */
export function dldr(alphaDeg: number, betaDeg: number): number {
  return interp2(DLDR_TABLE, alphaIndex(alphaDeg), betaSignedIndex(betaDeg))
}

/** Yawing moment per unit aileron -- adverse yaw. */
export function dnda(alphaDeg: number, betaDeg: number): number {
  return interp2(DNDA_TABLE, alphaIndex(alphaDeg), betaSignedIndex(betaDeg))
}

/** Yawing moment per unit rudder. */
export function dndr(alphaDeg: number, betaDeg: number): number {
  return interp2(DNDR_TABLE, alphaIndex(alphaDeg), betaSignedIndex(betaDeg))
}

/**
 * The nine dynamic (rate) damping derivatives, all interpolated in alpha alone.
 *
 * Order, matching the source: [cxq, cyr, cyp, czq, clr, clp, cmq, cnr, cnp].
 *
 * The last three are worth reading twice. The source consumes them positionally as
 * `cmt += cq * d[6]` and `cnt += b2v * (d[7]*r + d[8]*p)`, so index 6 is the PITCH
 * damping and 7/8 are the yaw pair — not the grouping the surrounding order of the
 * coefficient functions suggests. The table magnitudes confirm it: row 6 runs
 * around -6, which is a pitch-damping figure, while rows 7 and 8 are of order -0.5
 * and +0.1, which are yaw-damping figures.
 *
 * These are what resist rotation. `clp` (roll damping) and `cmq` (pitch damping)
 * most shape how the aircraft feels; `cnr` sets dutch roll damping, which is why
 * REQUIREMENTS §4.2 tests that mode specifically.
 *
 * Tabulated at zero sideslip only ([NASA-TM] p.29), so there is no beta dependence
 * to model here — a property of the data, not a simplification we chose.
 */
export interface DampingDerivatives {
  /** Axial force due to pitch rate. */
  cxq: number
  /** Side force due to yaw rate. */
  cyr: number
  /** Side force due to roll rate. */
  cyp: number
  /** Normal force due to pitch rate. */
  czq: number
  /** Rolling moment due to yaw rate. */
  clr: number
  /** Rolling moment due to roll rate — roll damping. */
  clp: number
  /** Pitching moment due to pitch rate — pitch damping. */
  cmq: number
  /** Yawing moment due to yaw rate — yaw damping. */
  cnr: number
  /** Yawing moment due to roll rate. */
  cnp: number
}

export function damping(alphaDeg: number): DampingDerivatives {
  const d = dampingArray(alphaDeg)

  return {
    cxq: d[0] as number,
    cyr: d[1] as number,
    cyp: d[2] as number,
    czq: d[3] as number,
    clr: d[4] as number,
    clp: d[5] as number,
    cmq: d[6] as number,
    cnr: d[7] as number,
    cnp: d[8] as number,
  }
}

/** The damping derivatives as a plain array, in source order. For golden tests. */
export function dampingArray(alphaDeg: number): number[] {
  const a = alphaIndex(alphaDeg)
  const out: number[] = []
  for (let i = 0; i < 9; i++) {
    out.push(interp1(DAMPP_TABLE[i] as readonly number[], a))
  }
  return out
}
