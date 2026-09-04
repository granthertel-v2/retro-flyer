/**
 * §5's other half: "All assists off should be genuinely difficult and
 * departure-prone. Both are correct behavior."
 *
 * This is Day 2's break-check in miniature, and it is the most important file in the
 * package. Every other assist test asserts that something bad does not happen. None
 * of them is worth anything unless the bad thing can happen — a limiter test on an
 * aircraft that was never going to exceed the limit passes forever and tests
 * nothing.
 *
 * So: the same input, flown twice. With the assists off it must leave the
 * aerodynamic envelope. With them on it must not. If the first assertion ever starts
 * failing, the suite has quietly stopped measuring anything and needs looking at
 * before the second assertion is believed.
 */

import { describe, expect, it } from 'vitest'
import { ALL_ASSISTS_OFF } from '../src/index.js'
import { ALPHA_DATA_MAX, fly, hold, peak } from './helpers.js'

/** Full aft stick — the crudest possible way to break an unstable aircraft. */
const FULL_AFT = hold({ pitch: 1, throttle: 1 })

/** A rolling pull: the classic way to depart a fighter. */
const ROLLING_PULL = (t: number) => ({
  pitch: t > 0.4 ? 1 : 0,
  roll: t > 1.2 ? 1 : 0,
  yaw: 0,
  throttle: 1,
})

describe('assists off', () => {
  it('departs under full aft stick', () => {
    const flight = fly({
      alt: 15_000,
      vt: 600,
      seconds: 15,
      input: FULL_AFT,
      toggles: ALL_ASSISTS_OFF,
    })

    expect(flight.departed).toBe(true)
  })

  it('departs in a rolling pull', () => {
    const flight = fly({
      alt: 15_000,
      vt: 700,
      seconds: 15,
      input: ROLLING_PULL,
      toggles: ALL_ASSISTS_OFF,
    })

    expect(flight.departed).toBe(true)
  })

  it('diverges in pitch with the stick centred, given a nudge', () => {
    // The airframe is longitudinally divergent at the reference CG — time to double
    // about 2.7 s. Hands off after a brief disturbance, it should run away. This is
    // the fact the entire assist layer exists to deal with; if it stopped being
    // true, the pitch law would be decoration.
    const flight = fly({
      alt: 20_000,
      vt: 650,
      seconds: 30,
      input: (t) => ({ pitch: t < 0.5 ? 0.3 : 0, roll: 0, yaw: 0, throttle: 0.6 }),
      toggles: ALL_ASSISTS_OFF,
    })

    const late = flight.samples.filter((s) => s.t > 10)
    const excursion = peak(late.map((s) => s.state.qRate))

    expect(excursion).toBeGreaterThan(0.15)
  })
})

describe('assists on, same inputs', () => {
  it('survives full aft stick', () => {
    const flight = fly({ alt: 15_000, vt: 600, seconds: 15, input: FULL_AFT })

    expect(flight.departed).toBe(false)
    expect(flight.diverged).toBe(false)
    expect(Math.max(...flight.samples.map((s) => s.alphaDeg))).toBeLessThan(ALPHA_DATA_MAX)
  })

  it('survives a rolling pull', () => {
    const flight = fly({ alt: 15_000, vt: 700, seconds: 15, input: ROLLING_PULL })

    expect(flight.departed).toBe(false)
    expect(flight.diverged).toBe(false)
  })

  it('survives full deflection on every axis at once', () => {
    // Nothing about this is a sensible way to fly. It is the input a player
    // produces in the first thirty seconds of sitting down.
    const flight = fly({
      alt: 12_000,
      vt: 700,
      seconds: 20,
      input: (t) => ({
        pitch: Math.sign(Math.sin(t * 1.7)),
        roll: Math.sign(Math.sin(t * 1.1)),
        yaw: Math.sign(Math.sin(t * 0.7)),
        throttle: 1,
      }),
    })

    expect(flight.departed).toBe(false)
    expect(flight.diverged).toBe(false)
  })

  it('survives being flown slowly, where there is least authority to work with', () => {
    const flight = fly({
      alt: 25_000,
      vt: 420,
      seconds: 25,
      input: (t) => ({
        pitch: t > 2 ? 1 : 0,
        roll: t > 6 ? 1 : 0,
        yaw: 0,
        throttle: 0.3,
      }),
    })

    expect(flight.diverged).toBe(false)
    expect(Math.max(...flight.samples.map((s) => s.alphaDeg))).toBeLessThan(ALPHA_DATA_MAX)
  })
})
