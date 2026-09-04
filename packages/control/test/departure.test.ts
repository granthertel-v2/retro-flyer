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
import { radToDeg } from '@retro-flyer/physics'
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

describe('a departure has to be survivable, or it is not a departure', () => {
  it('flies out of a limiter-off departure once the stick is centred', () => {
    // §5 asks for assists-off flight to be "genuinely difficult and departure-prone".
    // Difficult, not arithmetically unrecoverable — and it was the latter, for a
    // reason that had nothing to do with aerodynamics. Alpha is an integrated state
    // and did not wrap, so a tumble ran it to several hundred degrees, pinned the
    // table clamp at +45 permanently, and left the model computing forces for an
    // attitude the aircraft was not in. Centring the stick did nothing, forever.
    //
    // Measured without the wrap: settled alpha 530 degrees, still tumbling at 276
    // ft/s after 30 seconds. With it: 7.5 degrees and flying.
    const flight = fly({
      alt: 20_000,
      vt: 700,
      seconds: 30,
      // Depart it deliberately, then let go and see whether it comes back.
      input: (t) => ({ pitch: t < 6 ? 1 : 0, roll: 0, yaw: 0, throttle: 1 }),
      toggles: { aoaLimiter: false },
    })

    const settled = flight.samples.filter((s) => s.t > 22)
    const worstAlpha = Math.max(...settled.map((s) => Math.abs(s.alphaDeg)))
    const meanRate = settled.reduce((sum, s) => sum + Math.abs(s.state.qRate), 0) / settled.length

    expect(flight.diverged).toBe(false)
    // Back inside the data envelope and no longer tumbling.
    expect(worstAlpha).toBeLessThan(ALPHA_DATA_MAX)
    expect(radToDeg(meanRate)).toBeLessThan(15)
    // And still flying, rather than descending as a brick.
    expect(settled[settled.length - 1]!.state.vt).toBeGreaterThan(400)
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

  it('survives full deflection across a family of inputs, not just one', () => {
    // The single adversarial script above passed once by luck. A fix that made it
    // pass left five of these departing, which is the whole reason this test exists:
    // one stick script finds a number that works for that stick script.
    //
    // Both ends matter and both have been seen to fail. Early versions left through
    // the FLOOR at -12 degrees; a later one, with the ceiling fade starting too
    // late for a rate command, left through the CEILING at 239.
    const conditions = [
      [12_000, 700],
      [5_000, 850],
      [20_000, 600],
      [8_000, 500],
      [25_000, 450],
    ] as const
    const frequencies = [
      [1.7, 1.1, 0.7],
      [2.3, 1.9, 1.3],
      [1.1, 2.7, 0.5],
      [3.1, 0.9, 2.1],
      [0.7, 1.3, 1.7],
    ] as const

    const departures: string[] = []

    for (const [alt, vt] of conditions) {
      for (const f of frequencies) {
        const flight = fly({
          alt,
          vt,
          seconds: 20,
          input: (t) => ({
            pitch: Math.sign(Math.sin(t * f[0])),
            roll: Math.sign(Math.sin(t * f[1])),
            yaw: Math.sign(Math.sin(t * f[2])),
            throttle: 1,
          }),
        })

        if (flight.departed || flight.diverged) {
          const alphas = flight.samples.map((s) => s.alphaDeg)
          departures.push(
            `${alt}ft/${vt}fps/${f.join(',')} ` +
              `alpha ${Math.min(...alphas).toFixed(1)}..${Math.max(...alphas).toFixed(1)}`,
          )
        }
      }
    }

    expect(departures).toEqual([])
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
