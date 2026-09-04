/**
 * The assist layer (REQUIREMENTS §5) — the §8.1 Input -> Aero seam.
 *
 * Raw device state goes in, `Controls` comes out. The physics model on the other
 * side knows nothing about keyboards, smoothing, assists or limiters, and this
 * package knows nothing about rendering. That separation is what lets the whole of
 * Day 2's feel be tuned without a single physics test changing colour, which is
 * §4.4's tuning boundary made structural rather than aspirational.
 *
 * ## Both extremes are correct behaviour
 *
 * §5: "All assists on should approximate [Ace Combat]. All assists off should be
 * genuinely difficult and departure-prone. Both are correct behavior."
 *
 * That second sentence is doing real work. With the rate command laws off, the stick
 * drives the surfaces directly and the aircraft is longitudinally divergent, so full
 * aft stick departs in a couple of seconds. That is not a bug to be papered over —
 * it is the airframe, and `test/departure.test.ts` asserts it still happens. If
 * assists-off ever stops departing, every other assist test has quietly become
 * vacuous.
 */

import {
  degToRad,
  eulerFromQuaternion,
  type AircraftState,
  type Controls,
} from '@retro-flyer/physics'
import {
  ConditionedAxis,
  PITCH_AXIS,
  ROLL_AXIS,
  THROTTLE_AXIS,
  YAW_AXIS,
} from './conditioning.js'
import { scheduledGains, type GainSet } from './gains.js'
import { AILERON_LIMIT_DEG, ELEVATOR_LIMIT_DEG, RUDDER_LIMIT_DEG } from './limits.js'
import {
  AOA_FLOOR_DEG,
  downRateFraction,
  limitAoA,
  limitG,
  pitchRateCommand,
  rollAuthority,
} from './laws/limiters.js'
import { PitchLaw } from './laws/pitch.js'
import { BASE_ROLL_RATE_DEG, rollCommand } from './laws/roll.js'
import { yawCommand } from './laws/yaw.js'

/** Raw device state, already normalised. Produced by `input.ts`. */
export interface RawInput {
  /** -1 to 1. Positive is nose up — stick back. */
  pitch: number
  /** -1 to 1. Positive rolls right. */
  roll: number
  /** -1 to 1. Positive is nose right. */
  yaw: number
  /** 0 to 1. */
  throttle: number
}

export const NEUTRAL_INPUT: RawInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0 }

/**
 * §5's toggles, plus one.
 *
 * The spec's table lists roll *amplification* as an assist but takes the roll rate
 * command law itself for granted. They are separable and it is worth being able to
 * separate them: `rollRateCommand` off gives direct aileron, which is what "all
 * assists off" has to mean if it is going to be departure-prone in roll as well as
 * in pitch.
 */
export interface AssistToggles {
  /** Stick commands a pitch rate rather than an elevator deflection. */
  pitchRateCommand: boolean
  /** Stick commands a roll rate rather than an aileron deflection. */
  rollRateCommand: boolean
  /** Rudder is driven to hold beta near zero. */
  autoCoordination: boolean
  /** Nose-up command fades out approaching the alpha ceiling. */
  aoaLimiter: boolean
  /** Commanded pitch rate is capped at the load factor limit. */
  gLimiter: boolean
  /** Commanded roll rate is scaled above baseline. */
  rollAmplification: boolean
}

export const ALL_ASSISTS_ON: AssistToggles = {
  pitchRateCommand: true,
  rollRateCommand: true,
  autoCoordination: true,
  aoaLimiter: true,
  gLimiter: true,
  rollAmplification: true,
}

export const ALL_ASSISTS_OFF: AssistToggles = {
  pitchRateCommand: false,
  rollRateCommand: false,
  autoCoordination: false,
  aoaLimiter: false,
  gLimiter: false,
  rollAmplification: false,
}

/**
 * How hard the assists work. Every number here is `[A]` — our choice, not derived
 * from anything, and squarely inside the §4.4 tuning boundary.
 */
export interface AssistPreset {
  name: string
  /** Positive load factor limit, g. */
  gLimit: number
  /** Negative load factor limit, g. */
  gLimitNegative: number
  /** Angle-of-attack ceiling, degrees. Must sit below the 45 degree data edge (§2). */
  aoaCeilingDeg: number
  /** Multiplier on the baseline roll rate. */
  rollAmplification: number
  /** Commanded pitch rate at full stick, degrees per second, before limiting. */
  maxPitchRateDeg: number
}

/**
 * The default. Responsive and hard to depart, but a bad energy state still bites —
 * the limiters cap what you may ask for, not what the aerodynamics will give you.
 *
 * 9 g is the F-16's real structural limit. The 40 deg/s pitch command is chosen so
 * that at typical combat speeds the G limiter is what binds first, which means full
 * aft stick means "give me everything" at every speed rather than meaning different
 * things at each one.
 */
/**
 * Smoothing time constant for the differenced alpha rate, seconds.
 *
 * 40 ms: about five ticks at 120 Hz. Long enough to stop a single noisy difference
 * moving the limit, short enough that the floor's 0.32 s lead still leads.
 */
const ALPHA_RATE_TAU = 0.04

export const BALANCED: AssistPreset = {
  name: 'Balanced',
  gLimit: 11,
  gLimitNegative: -4,
  aoaCeilingDeg: 32,
  // Down from 1.4. At 308 deg/s the roll was quicker than anyone could aim with,
  // and it spent most of a full-stick input against the aileron stops — which means
  // the extra command was buying nothing anyway. 220 deg/s is still a fast roll.
  rollAmplification: 1.0,
  maxPitchRateDeg: 55,
}

/**
 * Maximum assists over a loose model — §5's reading of what Ace Combat is.
 *
 * The roll amplification is 1.6 rather than the 2.0 first tried, because 2.0 asks
 * for 440 deg/s and this airframe's ailerons deliver about 330 at combat speeds. A
 * command the aircraft cannot fill is not extra performance; it is just a saturated
 * surface and a control law working from a number that never comes true.
 */
export const ACE: AssistPreset = {
  name: 'Ace',
  gLimit: 12,
  gLimitNegative: -4,
  aoaCeilingDeg: 34,
  rollAmplification: 1.6,
  maxPitchRateDeg: 55,
}

/** Assists that only make the divergent airframe controllable, and nothing more. */
export const HONEST: AssistPreset = {
  name: 'Honest',
  gLimit: 9,
  gLimitNegative: -3,
  aoaCeilingDeg: 25,
  rollAmplification: 0.75,
  maxPitchRateDeg: 30,
}

export const PRESETS = [BALANCED, ACE, HONEST] as const

/** What the assist layer did this tick — for the dev overlay and for the tests. */
export interface AssistTelemetry {
  /** Commanded pitch rate after limiting, rad/s. */
  qCmd: number
  /** Commanded pitch rate before limiting, rad/s. */
  qCmdRaw: number
  /** Commanded roll rate, rad/s. */
  pCmd: number
  /** True while the AoA limiter is reducing the command. */
  aoaLimiting: boolean
  /** True while the G limiter is reducing the command. */
  gLimiting: boolean
  /** Conditioned stick positions, -1 to 1. */
  stick: { pitch: number; roll: number; yaw: number }
  gains: GainSet
}

export class AssistLayer {
  readonly toggles: AssistToggles
  preset: AssistPreset

  private readonly pitchAxis = new ConditionedAxis(PITCH_AXIS)
  private readonly rollAxis = new ConditionedAxis(ROLL_AXIS)
  private readonly yawAxis = new ConditionedAxis(YAW_AXIS)
  private readonly throttleAxis: ConditionedAxis
  private readonly pitch = new PitchLaw()

  private telemetry: AssistTelemetry | null = null

  /**
   * Angle of attack on the previous tick, radians, and its smoothed rate.
   *
   * The AoA limiter needs to know where alpha is *going*, and the obvious stand-in
   * for that is pitch rate. It is wrong, and wrong in exactly the case that matters
   * most. In steady curving flight — a bunt, a loop, any sustained pull or push —
   * the aircraft rotates at a constant q and alpha does not move at all, because the
   * flight path is rotating with it. Leading on q there predicts an alpha excursion
   * that is never going to happen, and the limiter throttles a command it had no
   * business touching.
   *
   * Measured, holding full forward stick in a steady pushover: alpha sat at -5.2
   * degrees against a -8 floor, and the limiter engaged anyway, chattering on and off
   * every few ticks and intermittently commanding nose UP against full forward stick.
   * That is the pushover feeling unresponsive, and it is not the aircraft — it is the
   * limiter arguing with the pitch law over a prediction neither of them needed.
   *
   * So the lead runs on alpha's own rate, differenced across the tick. Differencing
   * is noisy at 120 Hz, hence the filter; the time constant is short enough to keep
   * the anticipation the floor depends on and long enough that a single tick of
   * numerical grit does not move the limit.
   */
  private previousAlpha: number | null = null
  private alphaRate = 0

  constructor(preset: AssistPreset = BALANCED, initialThrottle = 0) {
    this.preset = preset
    this.toggles = { ...ALL_ASSISTS_ON }
    this.throttleAxis = new ConditionedAxis(THROTTLE_AXIS, initialThrottle)
  }

  /**
   * Start the law in equilibrium at a trimmed state.
   *
   * Without this the integrator begins at zero and has to wind up to the trim
   * elevator before the aircraft holds altitude, so the first two seconds of every
   * flight are a pitch excursion that looks like the trim solver is wrong.
   */
  seed(state: AircraftState, controls: Controls): void {
    this.throttleAxis.reset(controls.throttle)
    this.previousAlpha = state.alpha
    this.alphaRate = 0
    this.pitch.seed(
      controls.elevator,
      state.alpha,
      state.qRate,
      scheduledGains(state.vt, state.alt),
    )
  }

  /**
   * The §8.1 seam: raw input plus current state in, control deflections out.
   *
   * @param nz Measured total load factor from the **previous** tick, g. The G
   *   limiter closes a loop on it, and running one tick behind is the cheapest way
   *   to get it: computing it here would mean evaluating the aerodynamics twice per
   *   step. At 120 Hz that lag is eight milliseconds.
   */
  update(state: AircraftState, input: RawInput, dt: number, nz = 1): Controls {
    const gains = scheduledGains(state.vt, state.alt)
    const { phi, theta } = eulerFromQuaternion(state.q)

    // Alpha's rate, for the AoA limiter's lead. See `previousAlpha`.
    if (this.previousAlpha !== null && dt > 0) {
      const raw = (state.alpha - this.previousAlpha) / dt
      const blend = Math.min(1, dt / ALPHA_RATE_TAU)
      this.alphaRate += (raw - this.alphaRate) * blend
    }
    this.previousAlpha = state.alpha

    const pitchStick = this.pitchAxis.update(input.pitch, dt)
    const rollStick = this.rollAxis.update(input.roll, dt)
    const yawStick = this.yawAxis.update(input.yaw, dt)
    const throttle = this.throttleAxis.update(input.throttle, dt)

    // --- Roll -------------------------------------------------------------
    const amplification = this.toggles.rollAmplification ? this.preset.rollAmplification : 1

    // Roll authority is reduced near the envelope edges when the limiters are on.
    // A hard roll while hard against the pitch limit is what actually departs this
    // aircraft, and no amount of elevator recovers it once the surface is on its
    // stop — see `rollAuthority`.
    const authority =
      this.toggles.aoaLimiter || this.toggles.gLimiter
        ? rollAuthority(
            state.alpha,
            nz,
            this.preset.aoaCeilingDeg,
            AOA_FLOOR_DEG,
            this.preset.gLimit,
            this.preset.gLimitNegative,
          )
        : 1

    const pCmd = rollStick * degToRad(BASE_ROLL_RATE_DEG * amplification) * authority

    const aileron = this.toggles.rollRateCommand
      ? rollCommand(pCmd, state.p, gains)
      : rollStick * AILERON_LIMIT_DEG * Math.sign(gains.kRoll || -1)

    // --- Pitch ------------------------------------------------------------
    let elevator: number
    let qCmd = 0
    let qCmdRaw = 0
    let aoaLimiting = false
    let gLimiting = false

    if (this.toggles.pitchRateCommand) {
      // The stick commands a pitch RATE, plus enough to hold one g against gravity
      // wherever the aircraft currently is. See `pitchRateCommand`.
      const maxRate = degToRad(this.preset.maxPitchRateDeg)
      qCmdRaw = pitchRateCommand(
        pitchStick,
        maxRate,
        maxRate * downRateFraction(this.preset.gLimit, this.preset.gLimitNegative),
        state.vt,
        phi,
        theta,
      )
      qCmd = qCmdRaw

      if (this.toggles.gLimiter) {
        const limited = limitG(
          qCmd,
          state.vt,
          nz,
          this.preset.gLimit,
          this.preset.gLimitNegative,
        )
        gLimiting = Math.abs(limited - qCmd) > 1e-9
        qCmd = limited
      }

      // AoA last: it is the limit that must not be overridden. A G limit exceeded
      // bends the aircraft; an AoA limit exceeded leaves the aerodynamic data
      // entirely, and past the data edge the model has nothing to say.
      if (this.toggles.aoaLimiter) {
        const limited = limitAoA(
          qCmd,
          state.alpha,
          this.alphaRate,
          state.vt,
          this.preset.aoaCeilingDeg,
        )
        aoaLimiting = Math.abs(limited - qCmd) > 1e-9
        qCmd = limited
      }

      elevator = this.pitch.update(qCmd, state.alpha, state.qRate, gains, dt)
    } else {
      // Direct law. Stick back is nose up, and nose up is negative elevator.
      elevator = -pitchStick * ELEVATOR_LIMIT_DEG
      this.pitch.reset()
    }

    // --- Yaw --------------------------------------------------------------
    const rudder = yawCommand(
      state.beta,
      state.r,
      state.p,
      state.alpha,
      phi,
      theta,
      state.vt,
      yawStick,
      gains,
      this.toggles.autoCoordination,
    )

    this.telemetry = {
      qCmd,
      qCmdRaw,
      pCmd,
      aoaLimiting,
      gLimiting,
      stick: { pitch: pitchStick, roll: rollStick, yaw: yawStick },
      gains,
    }

    return {
      throttle: Math.min(1, Math.max(0, throttle)),
      elevator: Math.min(ELEVATOR_LIMIT_DEG, Math.max(-ELEVATOR_LIMIT_DEG, elevator)),
      aileron: Math.min(AILERON_LIMIT_DEG, Math.max(-AILERON_LIMIT_DEG, aileron)),
      rudder: Math.min(RUDDER_LIMIT_DEG, Math.max(-RUDDER_LIMIT_DEG, rudder)),
    }
  }

  /** What the layer did on the last `update`. Null before the first one. */
  lastTelemetry(): AssistTelemetry | null {
    return this.telemetry
  }

  setAll(on: boolean): void {
    Object.assign(this.toggles, on ? ALL_ASSISTS_ON : ALL_ASSISTS_OFF)
  }
}
