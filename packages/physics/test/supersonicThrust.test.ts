/**
 * What the engine model does above Mach 1, characterised (REQUIREMENTS §4.4).
 *
 * ## Why this file exists
 *
 * A Day 2 flight test reached Mach 1.40 and 870 KIAS at 4,000 ft. The real F-16 is
 * limited near 800 KIAS, so either the drag is too low or the thrust is too high,
 * and `aero/engine.ts` already documents a candidate: the thrust tables stop at
 * Mach 1.0 and the reference implementation does not clamp there — it clamps the
 * *index* and lets the interpolation weight run past one, which extrapolates
 * linearly and without bound.
 *
 * ## This changes nothing, deliberately
 *
 * §4.4 puts the engine tables off-limits for tuning, and there is a stronger reason
 * than the rule: above Mach 1.0 we have no data, so any "correction" would be a
 * number we invented, labelled `[A]`, sitting in the middle of a model whose entire
 * value is that it is `[S]`. Trading a known extrapolation for an unknown invention
 * is not an improvement.
 *
 * So this measures and records. The numbers below are what the model does, not what
 * it should do, and deciding whether to act on them is Day 4's problem — made with
 * evidence rather than suspicion, which is the whole point of writing it down.
 */

import { describe, expect, it } from 'vitest'
import {
  THRUST_TABLE_MAX_ALT,
  THRUST_TABLE_MAX_MACH,
  thrust,
  thrustOutsideTable,
} from '../src/aero/engine.js'

/** Maximum power: the afterburner table. */
const MAX_POWER = 100
/** Military power: the dry table. */
const MIL_POWER = 50

describe('the edge of the thrust data', () => {
  it('is where the model says it is', () => {
    expect(THRUST_TABLE_MAX_MACH).toBe(1.0)
    expect(thrustOutsideTable(0, 1.0)).toBe(false)
    expect(thrustOutsideTable(0, 1.01)).toBe(true)
    expect(thrustOutsideTable(THRUST_TABLE_MAX_ALT + 1, 0.5)).toBe(true)
  })

  it('flags the condition the Day 2 flight test actually reached', () => {
    // Mach 1.40 at 4,000 ft. The guard is the only thing that makes this a decision
    // rather than an accident, so it had better fire.
    expect(thrustOutsideTable(4_000, 1.4)).toBe(true)
  })
})

describe('military power behaves sensibly past the table edge', () => {
  it('falls off with Mach, which is the right direction', () => {
    // Ram drag rises with speed, so dry thrust should decline. The extrapolation
    // happens to continue that trend, so the dry case is not the problem.
    for (const alt of [0, 4_000]) {
      let previous = Infinity
      for (const mach of [0.6, 0.8, 1.0, 1.2, 1.4, 1.6]) {
        const value = thrust(MIL_POWER, alt, mach)
        expect(value, `MIL at ${alt} ft, M${mach}`).toBeLessThan(previous)
        expect(value, `MIL at ${alt} ft, M${mach}`).toBeGreaterThan(0)
        previous = value
      }
    }
  })
})

describe('maximum power keeps growing past the table edge — the finding', () => {
  it('gains thrust with Mach above 1.0, without bound', () => {
    // Measured, sea level, maximum power:
    //
    //   M1.0   28,886 lb   <- last tabulated value
    //   M1.2   31,702 lb   +10%
    //   M1.4   34,518 lb   +19%
    //   M1.6   37,334 lb   +29%
    //   M2.0   42,966 lb   +49%
    //
    // Perfectly straight, because it is a straight line: the interpolation weight is
    // simply allowed to exceed one. A real afterburning turbofan is roughly flat and
    // then declining through this range at low altitude.
    const atOne = thrust(MAX_POWER, 0, 1.0)
    const atFour = thrust(MAX_POWER, 0, 1.4)
    const atTwo = thrust(MAX_POWER, 0, 2.0)

    expect(atFour).toBeGreaterThan(atOne)
    expect(atFour / atOne).toBeCloseTo(1.19, 2)
    expect(atTwo / atOne).toBeCloseTo(1.49, 2)

    // And it is linear, which is the signature of an unclamped interpolation weight
    // rather than of any physics.
    const stepA = thrust(MAX_POWER, 0, 1.2) - atOne
    const stepB = thrust(MAX_POWER, 0, 1.4) - thrust(MAX_POWER, 0, 1.2)
    expect(stepB / stepA).toBeCloseTo(1, 6)
  })

  it('over-thrusts by about a fifth at the condition Day 2 flew', () => {
    // 4,000 ft, Mach 1.4: 31,834 lb where the last real datum is 26,659. If the
    // aircraft is holding 870 KIAS where the real one is limited near 800, this is
    // the most likely reason, and it is worth ~5,000 lb.
    const real = thrust(MAX_POWER, 4_000, 1.0)
    const extrapolated = thrust(MAX_POWER, 4_000, 1.4)

    expect(extrapolated - real).toBeGreaterThan(4_000)
    expect(extrapolated / real).toBeCloseTo(1.19, 2)
  })

  it('is at least finite everywhere the aircraft can reach', () => {
    // The bound that actually matters for the simulation staying a simulation. The
    // extrapolation is wrong, but it is not NaN and it stays bounded well past
    // anything this airframe will see — see `thrustOutsideTable` on the 65,000 ft
    // case for where it finally does go wrong.
    for (const alt of [0, 4_000, 20_000, 40_000, 50_000]) {
      for (const mach of [0, 0.5, 1.0, 1.4, 2.0]) {
        for (const power of [0, 50, 100]) {
          const value = thrust(power, alt, mach)
          expect(Number.isFinite(value), `${power}% at ${alt} ft, M${mach}`).toBe(true)
          expect(Math.abs(value), `${power}% at ${alt} ft, M${mach}`).toBeLessThan(80_000)
        }
      }
    }
  })

  it('keeps military and maximum power positive throughout', () => {
    for (const alt of [0, 4_000, 20_000, 40_000, 50_000]) {
      for (const mach of [0, 0.5, 1.0, 1.4, 2.0]) {
        expect(thrust(MIL_POWER, alt, mach), `MIL at ${alt} ft, M${mach}`).toBeGreaterThan(0)
        expect(thrust(MAX_POWER, alt, mach), `MAX at ${alt} ft, M${mach}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('idle thrust goes negative with speed, and should', () => {
  it('produces net drag in flight but net thrust standing still', () => {
    // Not a defect and not an extrapolation artifact — this is inside the table.
    // At idle the engine's ram drag exceeds its gross thrust as soon as the aircraft
    // is moving, which is why an idle descent works at all.
    //
    // It is also the two halves of a Day 3 finding. Standing on a runway at Mach 0
    // the same table gives +1,041 lb against 410 lb of rolling resistance, so the
    // aircraft taxis forward on its own and needs brakes to hold position; in the
    // air at Mach 0.5 it gives -480 lb and the aircraft slows down. Both are the
    // same curve.
    expect(thrust(0, 0, 0), 'idle, standing still').toBeGreaterThan(900)
    expect(thrust(0, 0, 0.5), 'idle, at speed').toBeLessThan(0)

    // The crossing is somewhere below Mach 0.4 at sea level.
    expect(thrust(0, 0, 0.2)).toBeGreaterThan(thrust(0, 0, 0.5))
  })
})
