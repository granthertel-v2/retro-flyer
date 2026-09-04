/**
 * @retro-flyer/control — input conditioning and the assist layer.
 *
 * This is the §8.1 Input -> Aero seam. Raw normalised device axes go in, control
 * surface deflections come out, and the physics model on the far side knows nothing
 * about any of it.
 *
 * **Headless by contract.** Nothing here imports three.js or touches the DOM — the
 * device reading itself lives in the app package, because a keyboard is a browser
 * concern and a control law is not. That separation is what lets the whole assist
 * layer be tested in Node, which matters more here than usual: the physics model has
 * published trim solutions to check against, and the assist layer has nothing but
 * its own test suite.
 *
 * **Everything here is tunable; nothing here is sourced.** REQUIREMENTS §4.4 draws
 * the line: when the aircraft feels wrong, the fix belongs in this package. If a
 * change improves feel and turns a physics test red, the change is wrong.
 */

export {
  ACE,
  ALL_ASSISTS_OFF,
  ALL_ASSISTS_ON,
  AssistLayer,
  BALANCED,
  HONEST,
  NEUTRAL_INPUT,
  PRESETS,
  type AssistPreset,
  type AssistTelemetry,
  type AssistToggles,
  type RawInput,
} from './assists.js'

export {
  ConditionedAxis,
  PITCH_AXIS,
  ROLL_AXIS,
  THROTTLE_AXIS,
  YAW_AXIS,
  applyDeadband,
  type AxisConfig,
} from './conditioning.js'

export {
  AILERON_LIMIT_DEG,
  ELEVATOR_LIMIT_DEG,
  RUDDER_LIMIT_DEG,
} from './limits.js'

export {
  ANCHORS,
  PITCH_INTEGRATOR_POLE,
  PITCH_WN_MAX,
  PITCH_WN_MIN,
  PITCH_WN_QBAR_REF,
  PITCH_WN_REF,
  PITCH_ZETA,
  ROLL_TAU,
  YAW_ZETA,
  anchorGains,
  controlJacobian,
  designGains,
  pitchWn,
  resetGains,
  scheduledGains,
  type GainSet,
} from './gains.js'

export {
  AOA_CEILING_DEG,
  AOA_CEILING_LOW_SPEED_DEG,
  AOA_FLOOR_DEG,
  effectiveCeiling,
  G_LIMIT,
  G_LIMIT_NEGATIVE,
  commandedLoadFactor,
  limitAoA,
  limitG,
  pitchRateForLoadFactor,
  rollAuthority,
} from './laws/limiters.js'

export { PitchLaw } from './laws/pitch.js'
export { BASE_ROLL_RATE_DEG, rollCommand } from './laws/roll.js'
export { coordinatedYawRate, pedalAuthority, yawCommand } from './laws/yaw.js'

export {
  ackermann,
  characteristicPolynomial,
  eigenvaluesOf,
  isHurwitz,
  polynomialFromRoots,
  polynomialRoots,
  secondOrderRoots,
  type Complex,
  type Matrix,
  type Vector,
} from './linalg.js'
