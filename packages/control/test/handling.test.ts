/**
 * Roll response and auto-coordination (§5).
 *
 * Two claims from the spec's assist table:
 *
 * - "Roll rate amplification — scales roll authority above baseline"
 * - "Auto-coordination — rudder commanded to hold beta about zero during rolls and
 *   turns"
 *
 * Plus the one that is not in the table and matters more than either: stick right
 * has to roll right. Positive aileron rolls this aircraft **left** — a Day 1 finding
 * pinned in the physics package — so the sign passes through the gain design, the
 * command law and the input conditioning before it reaches the surface. Asserting it
 * at the far end is the only way to know all three agree.
 */

import { describe, expect, it } from 'vitest'
import { degToRad, radToDeg } from '@retro-flyer/physics'
import { ACE, BALANCED, BASE_ROLL_RATE_DEG, HONEST } from '../src/index.js'
import { fly, hold, peak, settled } from './helpers.js'

describe('roll direction', () => {
  it('rolls RIGHT when the stick goes right', () => {
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 3,
      input: hold({ roll: 1, throttle: 0.6 }),
    })

    expect(flight.last.pDeg).toBeGreaterThan(50)
  })

  it('rolls LEFT when the stick goes left', () => {
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 3,
      input: hold({ roll: -1, throttle: 0.6 }),
    })

    expect(flight.last.pDeg).toBeLessThan(-50)
  })

  it('commands negative aileron for a right roll', () => {
    // The Day 1 finding, restated at the surface: positive aileron rolls left, so
    // a right roll command has to come out negative.
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 1,
      input: hold({ roll: 1, throttle: 0.6 }),
    })

    expect(flight.samples[30]!.controls.aileron).toBeLessThan(0)
  })
})

describe('roll rate command', () => {
  it('delivers close to the commanded rate', () => {
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 6,
      input: hold({ roll: 1, throttle: 0.6 }),
    })

    const commanded = BASE_ROLL_RATE_DEG * BALANCED.rollAmplification
    const achieved = settled(flight.samples.map((s) => s.pDeg), 0.3)

    expect(achieved).toBeGreaterThan(commanded * 0.75)
    expect(achieved).toBeLessThan(commanded * 1.1)
  })

  it('scales with the preset amplification, up to what the ailerons can give', () => {
    // Monotonic, but not proportional at the top. The ailerons saturate somewhere
    // around 340 deg/s at this condition, so Balanced already spends most of a
    // full-stick roll on the stop and Ace gains only a little over it. That is the
    // airframe, not the law — and it is why Ace's amplification is 1.6 rather than
    // the 2.0 first tried, which asked for 440 deg/s and got a pinned surface.
    const rates = [HONEST, BALANCED, ACE].map((preset) => {
      const flight = fly({
        alt: 10_000,
        vt: 600,
        seconds: 6,
        preset,
        input: hold({ roll: 1, throttle: 0.6 }),
      })
      return settled(flight.samples.map((s) => s.pDeg), 0.3)
    })

    expect(rates[1]!).toBeGreaterThan(rates[0]! * 1.2)
    expect(rates[2]!).toBeGreaterThan(rates[1]!)
  })

  it('tracks the command closely when it is inside the airframe', () => {
    // Honest asks for 220 deg/s, which the ailerons can deliver without hitting the
    // stop, so this is the preset that tests the law rather than the airframe.
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 6,
      preset: HONEST,
      input: hold({ roll: 1, throttle: 0.6 }),
    })

    const achieved = settled(flight.samples.map((s) => s.pDeg), 0.3)
    expect(achieved).toBeGreaterThan(BASE_ROLL_RATE_DEG * 0.9)
    expect(achieved).toBeLessThan(BASE_ROLL_RATE_DEG * 1.15)
  })

  it('rolls no faster than baseline with amplification off', () => {
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 6,
      input: hold({ roll: 1, throttle: 0.6 }),
      toggles: { rollAmplification: false },
    })

    const achieved = settled(flight.samples.map((s) => s.pDeg), 0.3)
    expect(achieved).toBeLessThan(BASE_ROLL_RATE_DEG * 1.1)
  })
})

describe('auto-coordination', () => {
  it('holds sideslip near zero rolling in and settling', () => {
    // Roll to bank, then centre the stick — what §5 means by "during rolls and
    // turns". Not a six-second continuous roll, which is an aerobatic manoeuvre
    // where some sideslip is simply what happens.
    const flight = fly({
      alt: 10_000,
      vt: 650,
      seconds: 6,
      input: (t) => ({ pitch: 0, roll: t < 1.5 ? 1 : 0, yaw: 0, throttle: 0.6 }),
    })

    expect(peak(flight.samples.map((s) => s.betaDeg))).toBeLessThan(2)
  })

  it('holds sideslip near zero in a sustained banked turn', () => {
    const flight = fly({
      alt: 15_000,
      vt: 700,
      seconds: 20,
      input: (t) => ({
        // Roll in, then hold bank and pull.
        roll: t < 1.2 ? 1 : 0,
        pitch: t > 1.2 ? 0.55 : 0,
        yaw: 0,
        throttle: 1,
      }),
    })

    const turning = flight.samples.filter((s) => s.t > 3)
    expect(peak(turning.map((s) => s.betaDeg))).toBeLessThan(2.5)
  })

  it('measurably beats having no coordination at all', () => {
    // The control case: if turning the assist off changed nothing, every assertion
    // above would be passing for reasons that have nothing to do with the rudder.
    //
    // This aircraft has little adverse yaw to begin with — the differential
    // stabilator sees to that, and the measured aileron yawing moment is actually
    // proverse — so the assist has less to do than on most airframes. It still
    // roughly halves the peak.
    const roll = (t: number) => ({ pitch: 0, roll: t < 1.5 ? 1 : 0, yaw: 0, throttle: 0.6 })

    const withAssist = peak(
      fly({ alt: 10_000, vt: 650, seconds: 6, input: roll }).samples.map((s) => s.betaDeg),
    )
    const without = peak(
      fly({
        alt: 10_000,
        vt: 650,
        seconds: 6,
        input: roll,
        toggles: { autoCoordination: false },
      }).samples.map((s) => s.betaDeg),
    )

    expect(without).toBeGreaterThan(withAssist * 1.4)
  })

  it('earns its keep most at high angle of attack', () => {
    // Where the kinematic coupling `p*sin(alpha)` dominates — a hard rolling pull.
    // This is the case the coordination term is actually derived for, and the
    // difference is correspondingly larger.
    const rollingPull = (t: number) => ({
      pitch: t > 0.5 ? 0.9 : 0,
      roll: t > 3 ? 1 : 0,
      yaw: 0,
      throttle: 1,
    })

    const measure = (coordinate: boolean): number => {
      const flight = fly({
        alt: 15_000,
        vt: 700,
        seconds: 9,
        input: rollingPull,
        toggles: { autoCoordination: coordinate },
      })
      expect(flight.departed).toBe(false)
      return peak(flight.samples.filter((s) => s.t > 3).map((s) => s.betaDeg))
    }

    const withAssist = measure(true)
    const without = measure(false)

    expect(withAssist).toBeLessThan(7)
    expect(without).toBeGreaterThan(withAssist * 1.3)
  })

  it('still lets the pilot command deliberate sideslip', () => {
    // Coordination must not mean the rudder pedals are dead. A boot full of rudder
    // should produce sideslip even with the assist on.
    const flight = fly({
      alt: 10_000,
      vt: 500,
      seconds: 8,
      input: hold({ yaw: 1, throttle: 0.6 }),
    })

    expect(peak(flight.samples.map((s) => s.betaDeg))).toBeGreaterThan(2)
  })
})
