/**
 * @retro-flyer/physics — headless 6DOF F-16 flight model.
 *
 * No rendering dependency, by contract (REQUIREMENTS §10). Everything here runs in
 * Node with nothing installed.
 *
 * The three seams that matter to a consumer:
 *
 * - **Input → Aero (§8.1).** `Controls` is the boundary. The model knows nothing
 *   about keyboards, smoothing, or assists.
 * - **Aero → Renderer (§8.3).** Read `AircraftState`. Never write to it. Physics
 *   runs at a fixed 120 Hz; interpolate for rendering using `FixedStepClock.alpha`.
 * - **Mass properties → Aero (§8.4).** `computeMassProperties(loadout)` — mass, CG
 *   and inertia are computed, never constants.
 *
 * A note before touching anything in `tables/`: those are aerodynamic coefficients
 * traced to published sources (`docs/SOURCES.md`). REQUIREMENTS §4.4 puts them
 * off-limits for tuning. If the aircraft feels wrong, the fix belongs in the assist
 * layer, which is not in this package.
 */

export {
  airData,
  isa,
  isaValid,
  type AirData,
  type IsaConditions,
} from './atmosphere.js'

export {
  ALPHA_MAX_DEG,
  ALPHA_MIN_DEG,
  BETA_LIMIT_DEG,
  MIN_AIRSPEED_FPS,
  clamp,
  guardAngles,
  insideEnvelope,
  type GuardedAngles,
} from './envelope.js'

export {
  EMPTY_WEIGHT_LB,
  ENGINE_ANGULAR_MOMENTUM,
  MEAN_CHORD,
  REFERENCE_FUEL_LB,
  REFERENCE_IXX,
  REFERENCE_IXZ,
  REFERENCE_IYY,
  REFERENCE_IZZ,
  REFERENCE_LOADOUT,
  REFERENCE_WEIGHT_LB,
  WING_AREA,
  WING_SPAN,
  XCG_REF,
  computeMassProperties,
  momentConstants,
  type Loadout,
  type MassProperties,
  type MomentConstants,
  type Store,
} from './massProperties.js'

export {
  NO_EXTERNAL_LOADS,
  S,
  STATE_SIZE,
  derivative,
  forcesAndMoments,
  stateDerivative,
  type Controls,
  type Core,
  type CoreInputs,
  type Derivative,
  type DerivativeOptions,
  type ExternalLoads,
  type LoadFactors,
} from './dynamics.js'

export {
  IDENTITY_QUATERNION,
  Q,
  QUAT_STATE_SIZE,
  aeroAngles,
  bodyVelocity,
  eulerFromQuaternion,
  fromQuatVector,
  fromStateVector,
  normalize,
  quatDerivative,
  quaternionDerivative,
  quaternionFromEuler,
  renormalizeQuat,
  rotateBodyToNed,
  rotateNedToBody,
  toQuatVector,
  toStateVector,
  type AeroAngles,
  type AircraftState,
  type EulerAngles,
  type Quaternion,
  type QuatDerivative,
} from './state.js'

export {
  FixedStepClock,
  MAX_CATCHUP_SECONDS,
  PHYSICS_DT,
  PHYSICS_HZ,
  simulate,
  specificEnergy,
  step,
  type LoadsFn,
} from './integrator.js'

export {
  DEFAULT_GEAR,
  GEAR_DOWN,
  GEAR_UP,
  LEFT_MAIN,
  NOSE_GEAR,
  RIGHT_MAIN,
  gearLoads,
  restingAttitude,
  staticCompression,
  type GearInput,
  type GearState,
  type RestingAttitude,
  type Strut,
} from './gear.js'

export {
  FlatGround,
  NoGround,
  PAVED,
  SOFT,
  WATER,
  type GroundSample,
  type GroundSource,
} from './ground.js'

export { trim, trimControls, type TrimCondition, type TrimResult } from './trim.js'

export {
  eigenvalues,
  jacobian,
  lateralModes,
  longitudinalModes,
  toMode,
  type LateralModes,
  type LongitudinalModes,
  type Mode,
} from './linearize.js'

export {
  THRUST_TABLE_MAX_ALT,
  THRUST_TABLE_MAX_MACH,
  pdot,
  rtau,
  tgear,
  thrust,
  thrustOutsideTable,
} from './aero/engine.js'

export { buildCoefficients, type Coefficients } from './aero/buildup.js'

export {
  DEG_PER_RAD,
  G_FT_S2,
  RAD_PER_DEG,
  degToRad,
  fpsToKt,
  ftToM,
  ktToFps,
  mToFt,
  radToDeg,
} from './units.js'
