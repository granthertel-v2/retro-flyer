/**
 * Mass properties — REQUIREMENTS §8.4.
 *
 * Mass, CG, and the inertia tensor are *computed from a loadout description*, never
 * stored as constants. For MVP the loadout is empty and fuel is the only variable,
 * so this looks like ceremony. It is not: the alternative is inertia constants
 * sprinkled through the dynamics, and adding stores later becomes a rewrite of the
 * mass model rather than a change to one function.
 *
 * The other job this file does is convert the tensor into the nine moment-equation
 * constants c1..c9 that the body-axis rotational equations actually consume. The
 * reference implementation hardcodes those nine numbers. We derive them, which
 * means a changed loadout automatically produces correct moment equations — and it
 * gives us a genuine cross-check, because our derived values must reproduce the
 * published ones. See `docs/SOURCES.md`.
 */

import { G_FT_S2 } from './units.js'

// ---------------------------------------------------------------------------
// Reference values. [NASA-TM] Table 1, "Mass Properties of the Simulated F-16".
// Verified 2026-09-03 before entering code, per REQUIREMENTS §2.1.
// ---------------------------------------------------------------------------

/** Reference weight, lb. [NASA-TM] Table 1 */
export const REFERENCE_WEIGHT_LB = 20500
/** Roll inertia about the body x axis, slug-ft^2. [NASA-TM] Table 1 */
export const REFERENCE_IXX = 9496
/** Pitch inertia about the body y axis, slug-ft^2. [NASA-TM] Table 1 */
export const REFERENCE_IYY = 55814
/** Yaw inertia about the body z axis, slug-ft^2. [NASA-TM] Table 1 */
export const REFERENCE_IZZ = 63100
/** Roll-yaw product of inertia, slug-ft^2. [NASA-TM] Table 1 */
export const REFERENCE_IXZ = 982

/** CG location the aerodynamic coefficients are referenced to, fraction of c-bar. */
export const XCG_REF = 0.35

/**
 * Engine angular momentum, slug-ft^2/s. [AEROBENCH] subf16_model.py (`he`)
 *
 * The compressor spool is a spinning mass; yawing or pitching the aircraft
 * gyroscopically couples into the other axis. Small, but it is in the source model
 * and therefore in the golden vectors.
 */
export const ENGINE_ANGULAR_MOMENTUM = 160.0

// ---------------------------------------------------------------------------
// Geometry. [AEROBENCH] subf16_model.py
// ---------------------------------------------------------------------------

/** Reference wing area, ft^2. */
export const WING_AREA = 300
/** Wingspan, ft. */
export const WING_SPAN = 30
/** Mean aerodynamic chord, ft. */
export const MEAN_CHORD = 11.32

// ---------------------------------------------------------------------------
// Loadout
// ---------------------------------------------------------------------------

/**
 * A single carried item — fuel tank, pylon, store.
 *
 * `x` is measured in fractions of mean aerodynamic chord, positive aft, on the same
 * datum as `xcg`, so it composes directly with the CG bookkeeping. `y` and `z` are
 * feet from the centerline and waterline. For MVP nothing populates `stores`, but
 * the moment arms are here so that when something does, it works.
 */
export interface Store {
  name: string
  /** Weight, lb. */
  weight: number
  /** Longitudinal station, fraction of mean aerodynamic chord, positive aft. */
  x: number
  /** Lateral station, ft, positive right. */
  y?: number
  /** Vertical station, ft, positive down. */
  z?: number
}

/**
 * Everything the aircraft is carrying.
 *
 * `fuel` is the only thing that varies during an MVP flight. `stores` stays empty
 * until weapons arrive (REQUIREMENTS §9.2).
 */
export interface Loadout {
  /**
   * Weight with zero fuel and no stores, lb.
   *
   * Defaults so that empty + full internal fuel reproduces the reference
   * 20,500 lb exactly, which is what keeps the default configuration on the
   * published trim solutions.
   */
  emptyWeight?: number
  /** Internal fuel currently aboard, lb. */
  fuel?: number
  /** Longitudinal station of the fuel centroid, fraction of c-bar. */
  fuelStation?: number
  stores?: readonly Store[]
}

/** Internal fuel at the reference condition, lb. */
export const REFERENCE_FUEL_LB = 5000
/** Empty weight implied by the reference condition, lb. */
export const EMPTY_WEIGHT_LB = REFERENCE_WEIGHT_LB - REFERENCE_FUEL_LB

/** The default configuration: the exact reference condition. */
export const REFERENCE_LOADOUT: Loadout = {
  emptyWeight: EMPTY_WEIGHT_LB,
  fuel: REFERENCE_FUEL_LB,
  fuelStation: XCG_REF,
  stores: [],
}

// ---------------------------------------------------------------------------
// Computed properties
// ---------------------------------------------------------------------------

/**
 * The nine constants of the body-axis rotational equations (Stevens & Lewis).
 *
 * These absorb the inertia tensor so the moment equations stay in a fixed algebraic
 * form. They are a function of the tensor alone; nothing else in the model may set
 * them directly.
 */
export interface MomentConstants {
  c1: number
  c2: number
  c3: number
  c4: number
  c5: number
  c6: number
  c7: number
  c8: number
  c9: number
}

export interface MassProperties {
  /** Total weight, lb. */
  weight: number
  /** Total mass, slug. */
  mass: number
  /** Longitudinal CG, fraction of mean aerodynamic chord, positive aft. */
  xcg: number
  ixx: number
  iyy: number
  izz: number
  ixz: number
  /** Moment-equation constants derived from the tensor above. */
  moments: MomentConstants
}

/**
 * Derive c1..c9 from an inertia tensor.
 *
 * Definitions from Stevens & Lewis. `gamma` is the determinant of the roll-yaw
 * sub-block, which is what makes the coupled roll/yaw equations invertible.
 *
 * Inverting these is also how we recovered the tensor from the reference code's
 * hardcoded constants as an independent check on [NASA-TM] Table 1
 * (see `docs/SOURCES.md`), which is why the algebra is spelled out rather than
 * folded into the caller.
 */
export function momentConstants(
  ixx: number,
  iyy: number,
  izz: number,
  ixz: number,
): MomentConstants {
  const gamma = ixx * izz - ixz * ixz

  return {
    c1: ((iyy - izz) * izz - ixz * ixz) / gamma,
    c2: ((ixx - iyy + izz) * ixz) / gamma,
    c3: izz / gamma,
    c4: ixz / gamma,
    c5: (izz - ixx) / iyy,
    c6: ixz / iyy,
    c7: 1 / iyy,
    c8: (ixx * (ixx - iyy) + ixz * ixz) / gamma,
    c9: ixx / gamma,
  }
}

/**
 * Compute mass properties from a loadout.
 *
 * Inertia scaling: the reference tensor is published only at the reference weight,
 * so there is no sourced way to compute inertia for an arbitrary loadout. We scale
 * the airframe tensor linearly with mass ratio and add point-mass contributions for
 * stores. That is an engineering approximation (`[A]`, not `[S]`) — but it is an
 * approximation in *one place*, behind an interface, which is exactly what §8.4 asks
 * for. At the reference loadout it is exact by construction, so the published trim
 * solutions are unaffected.
 */
export function computeMassProperties(
  loadout: Loadout = REFERENCE_LOADOUT,
): MassProperties {
  const emptyWeight = loadout.emptyWeight ?? EMPTY_WEIGHT_LB
  const fuel = loadout.fuel ?? REFERENCE_FUEL_LB
  const fuelStation = loadout.fuelStation ?? XCG_REF
  const stores = loadout.stores ?? []

  // Airframe and fuel, then stores. Moments taken about the aero reference datum.
  let weight = emptyWeight + fuel
  let moment = emptyWeight * XCG_REF + fuel * fuelStation

  for (const s of stores) {
    weight += s.weight
    moment += s.weight * s.x
  }

  const xcg = weight > 0 ? moment / weight : XCG_REF
  const mass = weight / G_FT_S2

  // Airframe tensor scaled by mass ratio.
  const ratio = weight / REFERENCE_WEIGHT_LB
  let ixx = REFERENCE_IXX * ratio
  let iyy = REFERENCE_IYY * ratio
  let izz = REFERENCE_IZZ * ratio
  let ixz = REFERENCE_IXZ * ratio

  // Point-mass contribution of each store about the aircraft CG.
  for (const s of stores) {
    const m = s.weight / G_FT_S2
    const dx = (s.x - xcg) * MEAN_CHORD
    const dy = s.y ?? 0
    const dz = s.z ?? 0

    ixx += m * (dy * dy + dz * dz)
    iyy += m * (dx * dx + dz * dz)
    izz += m * (dx * dx + dy * dy)
    ixz += m * dx * dz
  }

  return {
    weight,
    mass,
    xcg,
    ixx,
    iyy,
    izz,
    ixz,
    moments: momentConstants(ixx, iyy, izz, ixz),
  }
}

/**
 * The nine constants exactly as they appear hardcoded in [AEROBENCH]
 * subf16_model.py.
 *
 * Present only so the tests can assert that our derived values reproduce them.
 * Nothing in the model may read these — the model reads `computeMassProperties`.
 * They are rounded to 3-4 significant figures in the source, which sets the 0.1%
 * tolerance the cross-check test uses.
 */
export const PUBLISHED_MOMENT_CONSTANTS: MomentConstants = {
  c1: -0.77,
  c2: 0.02755,
  c3: 1.055e-4,
  c4: 1.642e-6,
  c5: 0.9604,
  c6: 1.759e-2,
  c7: 1.792e-5,
  c8: -0.7336,
  c9: 1.587e-5,
}

/**
 * Inverse mass as hardcoded in [AEROBENCH] subf16_model.py (`rm`), slug^-1.
 *
 * Note this is NOT 1/(20500/32.17) = 1.5693e-3. The reference carries 1.57e-3,
 * which implies 636.94 slug, or 20,490 lb — [NASA-TM] Table 1's 20,500 lb rounded
 * to three significant figures.
 */
export const REFERENCE_IMPL_INVERSE_MASS = 1.57e-3

/**
 * Mass properties matching the reference implementation's hardcoded constants
 * exactly, rounding included.
 *
 * **For tests only.** Nothing in the model may use this.
 *
 * It exists so the Tier A derivative tests can isolate what they are actually
 * trying to measure. Our production values come from [NASA-TM] Table 1 and are
 * strictly more accurate than the reference's rounded constants; running the golden
 * comparison against the production values would therefore fail at ~1e-2 relative
 * for reasons that have nothing to do with whether the equations are ported
 * correctly. Feeding the reference's own constants back in lets Tier A hold the
 * *equations* to 1e-12, and leaves the constants question where it belongs — in
 * `massProperties.test.ts`, which checks the two agree to 0.1%.
 */
export const REFERENCE_IMPL_MASS: MassProperties = {
  weight: G_FT_S2 / REFERENCE_IMPL_INVERSE_MASS,
  mass: 1 / REFERENCE_IMPL_INVERSE_MASS,
  xcg: XCG_REF,
  ixx: REFERENCE_IXX,
  iyy: REFERENCE_IYY,
  izz: REFERENCE_IZZ,
  ixz: REFERENCE_IXZ,
  moments: PUBLISHED_MOMENT_CONSTANTS,
}
