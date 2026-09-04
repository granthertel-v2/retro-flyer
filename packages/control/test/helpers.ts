/**
 * Closed-loop flight, for the assist tests.
 *
 * Every test in this package works the same way: trim the aircraft, hand the assist
 * layer a scripted stick input, integrate at the real physics rate, and assert
 * something about what came out. That is deliberately the same shape as flying it —
 * these are not unit tests of a control law in isolation, they are the aircraft
 * actually being flown by the actual assist layer against the actual validated
 * model. A gain that places poles beautifully and still departs the aircraft would
 * pass a unit test and fail here.
 */

import {
  PHYSICS_DT,
  computeMassProperties,
  fromQuatVector,
  fromStateVector,
  quatDerivative,
  radToDeg,
  step,
  toQuatVector,
  trim,
  type AircraftState,
  type Controls,
  type LoadFactors,
  type MassProperties,
} from '@retro-flyer/physics'
import {
  ALL_ASSISTS_ON,
  AssistLayer,
  BALANCED,
  NEUTRAL_INPUT,
  type AssistPreset,
  type AssistToggles,
  type RawInput,
} from '../src/index.js'

export interface FlightOptions {
  alt: number
  vt: number
  /**
   * Stick input as a function of elapsed seconds.
   *
   * Defaults to genuinely hands off: stick centred and throttle **left at the trim
   * setting**. Defaulting the throttle to zero instead means every "hands off" test
   * is actually a flight-idle deceleration, and the aircraft correctly raises alpha
   * to hold one g as it slows — which reads as the control law drifting when it is
   * the engine doing exactly what it was told.
   */
  input?: (t: number) => RawInput
  seconds: number
  preset?: AssistPreset
  toggles?: Partial<AssistToggles>
  mass?: MassProperties
}

export interface FlightSample {
  t: number
  state: AircraftState
  controls: Controls
  accel: LoadFactors
  /** Total normal load factor, g. `LoadFactors.nz` is zeroed at 1 g; this is not. */
  nz: number
  alphaDeg: number
  betaDeg: number
  /** Roll rate, degrees per second. */
  pDeg: number
}

export interface Flight {
  samples: FlightSample[]
  layer: AssistLayer
  /** True if the aircraft left the aerodynamic data envelope at any point. */
  departed: boolean
  /** True if any state went non-finite — a departure that ran away completely. */
  diverged: boolean
  last: FlightSample
}

/**
 * The alpha and beta bounds of the aerodynamic tables (§2), which is what
 * "departed" means here: the aircraft is somewhere the model has no data for.
 */
export const ALPHA_DATA_MAX = 45
export const ALPHA_DATA_MIN = -10
export const BETA_DATA_LIMIT = 30

export function fly(options: FlightOptions): Flight {
  const {
    alt,
    vt,
    input,
    seconds,
    preset = BALANCED,
    toggles,
    mass = computeMassProperties(),
  } = options

  const solution = trim({ alt, vt })
  const initial: Controls = {
    throttle: solution.throttle,
    elevator: solution.elevator,
    aileron: solution.aileron,
    rudder: solution.rudder,
  }

  const stick = input ?? (() => ({ ...NEUTRAL_INPUT, throttle: solution.throttle }))

  const layer = new AssistLayer(preset, solution.throttle)
  Object.assign(layer.toggles, ALL_ASSISTS_ON, toggles ?? {})

  // `trim` returns the 13-element Euler state vector; the integrator wants the
  // 14-element quaternion one. `fromStateVector` is the physics package's own
  // adapter between them.
  let v = toQuatVector(fromStateVector(solution.state))

  layer.seed(fromQuatVector(v), initial)

  const samples: FlightSample[] = []
  const ticks = Math.round(seconds / PHYSICS_DT)

  let departed = false
  let diverged = false
  // The G limiter closes a loop on measured load factor, one tick behind. Level
  // flight is one g, which is where every one of these flights starts.
  let previousNz = 1

  for (let i = 0; i <= ticks; i++) {
    const t = i * PHYSICS_DT
    const state = fromQuatVector(v)

    if (!v.every(Number.isFinite)) {
      diverged = true
      departed = true
      break
    }

    const controls = layer.update(state, stick(t), PHYSICS_DT, previousNz)
    const { accel } = quatDerivative(v, controls, mass, { clampAeroAngles: true })

    const alphaDeg = radToDeg(state.alpha)
    const betaDeg = radToDeg(state.beta)

    if (
      alphaDeg > ALPHA_DATA_MAX ||
      alphaDeg < ALPHA_DATA_MIN ||
      Math.abs(betaDeg) > BETA_DATA_LIMIT
    ) {
      departed = true
    }

    samples.push({
      t,
      state,
      controls,
      accel,
      nz: accel.nz + 1,
      alphaDeg,
      betaDeg,
      pDeg: radToDeg(state.p),
    })

    previousNz = accel.nz + 1
    v = step(v, controls, PHYSICS_DT, mass)
  }

  return {
    samples,
    layer,
    departed,
    diverged,
    last: samples[samples.length - 1] as FlightSample,
  }
}

/** Constant stick input, for the many tests that just hold something. */
export const hold = (input: Partial<RawInput>): ((t: number) => RawInput) => {
  const full: RawInput = { ...NEUTRAL_INPUT, ...input }
  return () => full
}

/** Peak absolute value of a series. */
export const peak = (values: readonly number[]): number =>
  values.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

/** Mean of the last `fraction` of a series — a settled value. */
export function settled(values: readonly number[], fraction = 0.2): number {
  const from = Math.floor(values.length * (1 - fraction))
  const tail = values.slice(from)
  return tail.reduce((s, v) => s + v, 0) / tail.length
}
