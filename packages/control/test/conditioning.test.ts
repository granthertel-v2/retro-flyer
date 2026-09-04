/**
 * Input conditioning (§5).
 *
 * "Bang-bang keyboard input must never reach the model." That is a testable claim
 * and this is the test: press a key and check that no single physics tick sees a
 * step, that the command slews no faster than its rate limit, and that releasing
 * returns to centre.
 */

import { describe, expect, it } from 'vitest'
import {
  ConditionedAxis,
  ELEVATOR_LIMIT_DEG,
  PITCH_AXIS,
  ROLL_AXIS,
  THROTTLE_AXIS,
  applyDeadband,
} from '../src/index.js'
import { PHYSICS_DT } from '@retro-flyer/physics'
import { fly, hold } from './helpers.js'

describe('deadband', () => {
  it('treats small input as centred', () => {
    expect(applyDeadband(0.04, 0.06)).toBe(0)
    expect(applyDeadband(-0.04, 0.06)).toBe(0)
  })

  it('stays continuous at the threshold', () => {
    // A deadband that does not rescale jumps from 0 to 0.06 the moment it is
    // crossed, which is a worse discontinuity than the one it was added to remove.
    const justOver = applyDeadband(0.0601, 0.06)
    expect(Math.abs(justOver)).toBeLessThan(0.002)
  })

  it('still reaches full travel', () => {
    expect(applyDeadband(1, 0.06)).toBeCloseTo(1, 12)
    expect(applyDeadband(-1, 0.06)).toBeCloseTo(-1, 12)
  })

  it('passes everything through when disabled', () => {
    expect(applyDeadband(0.001, 0)).toBe(0.001)
  })
})

describe('a key press never reaches the model as a step', () => {
  it('takes an appreciable fraction of a second to reach full deflection', () => {
    const axis = new ConditionedAxis(PITCH_AXIS)
    let seconds = 0

    while (axis.value < 0.99 && seconds < 10) {
      axis.update(1, PHYSICS_DT)
      seconds += PHYSICS_DT
    }

    // Raw, this is one tick: 8 ms from centred to 25 degrees of elevator. The rate
    // limit sets the floor at 1/rate seconds, and that is what binds here — the
    // smoothing runs ahead of the limiter on a sustained input and only shapes the
    // first few ticks, which is exactly the division of labour intended.
    expect(seconds).toBeGreaterThan(0.25)
    expect(seconds).toBeLessThan(1.5)
  })

  it('never moves faster than its rate limit in a single tick', () => {
    const axis = new ConditionedAxis(ROLL_AXIS)
    const ceiling = ROLL_AXIS.rate * PHYSICS_DT + 1e-12

    let previous = axis.value
    for (let i = 0; i < 400; i++) {
      // Slam the axis from stop to stop, which is what holding two opposite keys
      // and releasing one looks like.
      axis.update(i % 40 < 20 ? 1 : -1, PHYSICS_DT)
      expect(Math.abs(axis.value - previous)).toBeLessThanOrEqual(
        Math.max(ceiling, ROLL_AXIS.centeringRate * PHYSICS_DT + 1e-12),
      )
      previous = axis.value
    }
  })

  it('self-centres when the key is released', () => {
    const axis = new ConditionedAxis(PITCH_AXIS)
    for (let i = 0; i < 200; i++) axis.update(1, PHYSICS_DT)
    expect(axis.value).toBeGreaterThan(0.9)

    for (let i = 0; i < 300; i++) axis.update(0, PHYSICS_DT)
    expect(Math.abs(axis.value)).toBeLessThan(0.01)
  })

  it('is frame-rate independent', () => {
    // The same elapsed time must give the same result whether it arrived as one
    // step or forty. A naive `value += (target - value) * dt / tau` does not.
    const coarse = new ConditionedAxis(PITCH_AXIS)
    const fine = new ConditionedAxis(PITCH_AXIS)

    for (let i = 0; i < 10; i++) coarse.update(1, 0.02)
    for (let i = 0; i < 40; i++) fine.update(1, 0.005)

    expect(coarse.value).toBeCloseTo(fine.value, 2)
  })

  it('does not move the throttle instantly', () => {
    const axis = new ConditionedAxis(THROTTLE_AXIS, 0)
    let seconds = 0

    while (axis.value < 0.99 && seconds < 30) {
      axis.update(1, PHYSICS_DT)
      seconds += PHYSICS_DT
    }

    // §5's requirement is only that bang-bang input never reaches the model. It is
    // NOT this axis's job to make spool-up feel slow — see below, and see the note
    // on THROTTLE_AXIS. This used to demand more than 1.5 seconds, which was this
    // file duplicating a lag the engine already models properly, and it cost two
    // thirds of the throttle response nearest the pilot's hand.
    expect(seconds).toBeGreaterThan(0.4)
    expect(seconds).toBeLessThan(2)
  })
})

describe('energy is still managed rather than toggled', () => {
  it('takes seconds to spool up, and that comes from the engine', () => {
    // The property the throttle axis used to assert, tested where it actually lives.
    // `pdot` and `rtau` model turbofan spool-up including afterburner hysteresis at
    // the 50 per cent line, and they are validated to 1e-12 against the reference
    // implementation — so this is the real aeroplane rather than a taste setting,
    // and §4.4 puts it out of reach of feel tuning.
    //
    // Which is why speeding the INPUT up is safe: slamming the throttle still does
    // not slam the engine.
    const flight = fly({
      alt: 5_000,
      vt: 500,
      seconds: 8,
      input: hold({ pitch: 0, throttle: 1 }),
    })

    const spooled = flight.samples.find((s) => s.state.power > 90)

    expect(spooled, 'never reached 90% power').toBeDefined()
    expect(spooled!.t).toBeGreaterThan(1.5)
    expect(spooled!.t).toBeLessThan(6)
  })

  it('still gets there faster than it used to, in the window that is felt', () => {
    // Reported from a flight test as "a lag from when I start accelerating to when I
    // start seeing it in the plane". One second after the slam, thrust was 4,107 lb;
    // it is now 6,036. The engine is unchanged — the command reaching it is not.
    const flight = fly({
      alt: 5_000,
      vt: 500,
      seconds: 4,
      input: hold({ pitch: 0, throttle: 1 }),
    })

    const atOneSecond = flight.samples.find((s) => s.t >= 1)

    expect(atOneSecond!.state.power).toBeGreaterThan(24)
  })
})

describe('flown', () => {
  it('produces no elevator step on the first tick of a key press', () => {
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 1,
      input: hold({ pitch: 1, throttle: 0.6 }),
    })

    const first = flight.samples[0]!.controls.elevator
    const second = flight.samples[1]!.controls.elevator

    // Direct bang-bang would be the full 25 degrees immediately.
    expect(Math.abs(second - first)).toBeLessThan(ELEVATOR_LIMIT_DEG * 0.1)
  })

  it('keeps the surfaces inside their sourced travel limits at all times', () => {
    // §2.1.1 values, and the one thing in this package that is not a tuning knob.
    const flight = fly({
      alt: 8_000,
      vt: 700,
      seconds: 20,
      input: (t) => ({
        pitch: Math.sign(Math.sin(t * 3.1)),
        roll: Math.sign(Math.sin(t * 2.3)),
        yaw: Math.sign(Math.sin(t * 1.3)),
        throttle: t % 2 < 1 ? 1 : 0,
      }),
    })

    for (const s of flight.samples) {
      expect(Math.abs(s.controls.elevator)).toBeLessThanOrEqual(25 + 1e-9)
      expect(Math.abs(s.controls.aileron)).toBeLessThanOrEqual(21.5 + 1e-9)
      expect(Math.abs(s.controls.rudder)).toBeLessThanOrEqual(30 + 1e-9)
      expect(s.controls.throttle).toBeGreaterThanOrEqual(0)
      expect(s.controls.throttle).toBeLessThanOrEqual(1)
    }
  })
})
