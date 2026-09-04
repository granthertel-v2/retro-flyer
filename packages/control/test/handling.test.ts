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
import { degToRad, eulerFromQuaternion, radToDeg } from '@retro-flyer/physics'
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
    // Honest's command is well inside what the ailerons can deliver without hitting
    // the stop, so this is the preset that tests the law rather than the airframe.
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 6,
      preset: HONEST,
      input: hold({ roll: 1, throttle: 0.6 }),
    })

    const commanded = BASE_ROLL_RATE_DEG * HONEST.rollAmplification
    const achieved = settled(flight.samples.map((s) => s.pDeg), 0.3)

    expect(achieved).toBeGreaterThan(commanded * 0.9)
    expect(achieved).toBeLessThan(commanded * 1.15)
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

    // A degree and a half. As with the high-alpha case below, this is what the
    // assist achieves rather than a requirement it was designed to — the claim that
    // matters is the comparative one, not an absolute figure nobody specified.
    expect(peak(flight.samples.map((s) => s.betaDeg))).toBeLessThan(1.5)
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

    expect(without).toBeGreaterThan(withAssist * 1.25)
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

    // The absolute figure moves with the AoA limiter, because the coupling being
    // cancelled is proportional to sin(alpha) and the limiter decides how much
    // alpha there is: relaxing it from holding 16 degrees to holding 20 raised this
    // from 5.7 to 7.5 without the coordination doing anything differently. The
    // ratio is the claim that survives retuning, so it is the one to lean on.
    expect(withAssist).toBeLessThan(10.5)
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

describe('rudder sense', () => {
  it('yaws the nose RIGHT for right pedal', () => {
    // Positive rudder deflection yaws this model's nose LEFT, so `RawInput.yaw`,
    // which is in pilot terms, has to be negated on the way to the surface. This is
    // the assertion that says which way round it ended up — the first version had
    // it backwards and four seconds of right pedal swung the heading 22 degrees
    // the wrong way.
    const heading = (flight: ReturnType<typeof fly>, i: number): number =>
      radToDeg(eulerFromQuaternion(flight.samples[i]!.state.q).psi)

    const right = fly({ alt: 10_000, vt: 500, seconds: 4, input: hold({ yaw: 1, throttle: 0.6 }) })
    const left = fly({ alt: 10_000, vt: 500, seconds: 4, input: hold({ yaw: -1, throttle: 0.6 }) })

    expect(heading(right, right.samples.length - 1)).toBeGreaterThan(heading(right, 0) + 5)
    expect(heading(left, left.samples.length - 1)).toBeLessThan(heading(left, 0) - 5)
  })

  it('still lets auto-coordination hold beta with the pedals centred', () => {
    // Flipping the manual sign must not have flipped the feedback path with it.
    const flight = fly({
      alt: 10_000,
      vt: 650,
      seconds: 6,
      input: (t) => ({ pitch: 0, roll: t < 1.5 ? 1 : 0, yaw: 0, throttle: 0.6 }),
    })

    expect(peak(flight.samples.map((s) => s.betaDeg))).toBeLessThan(1.5)
  })
})

describe('an aeroplane does not fly upside down hands-off', () => {
  /** Roll to a bank angle, centre the stick, and see what the altitude does. */
  function altitudeLost(rollSeconds: number, seconds = 14): number {
    const flight = fly({
      alt: 11_000,
      vt: 640,
      seconds,
      input: (t) => ({ pitch: 0, roll: t < rollSeconds ? 1 : 0, yaw: 0, throttle: 0.7 }),
    })

    const at = (t: number): number => flight.samples.find((s) => s.t >= t)!.state.alt
    return at(2) - at(12)
  }

  it('descends when banked on its side', () => {
    // No vertical component of lift, so it falls while it turns.
    expect(altitudeLost(0.42)).toBeGreaterThan(1_200)
  })

  it('descends FASTER inverted than on its side', () => {
    // Lift and gravity both pointing down beats gravity alone. Under the
    // rate-command law this was the wrong way round by a factor of three — the law
    // held zero pitch rate, the aircraft obligingly trimmed to a slightly negative
    // alpha, and it cruised along upside down losing 712 ft where knife-edge lost
    // 2,150. Correct for what it was asked, and not what an aeroplane does.
    expect(altitudeLost(0.84)).toBeGreaterThan(altitudeLost(0.42))
  })
})
