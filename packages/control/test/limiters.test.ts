/**
 * The AoA and G limiters (§5), flown rather than unit-tested.
 *
 * Both are asserted the only way that means anything: hold the stick at the stop and
 * check the aircraft never goes past the limit. A limiter that computes the right
 * number and is then overwhelmed by the pitch law's integrator would pass a unit
 * test comfortably.
 *
 * The AoA ceiling is the one that matters most. Past 45 degrees the aerodynamic
 * tables have no data (§2) and the raw model diverges to NaN in about six seconds.
 * The integrator clamps alpha onto the envelope so that cannot literally happen, but
 * a limiter whose only backstop is a clamp downstream is not doing its job.
 */

import { describe, expect, it } from 'vitest'
import { radToDeg } from '@retro-flyer/physics'
import { AOA_CEILING_DEG, BALANCED, G_LIMIT, limitAoA, limitG } from '../src/index.js'
import { ALPHA_DATA_MAX, fly, hold } from './helpers.js'

const deg = (d: number): number => (d * Math.PI) / 180

describe('the AoA limiter, as a function', () => {
  it('passes a nose-up command through well below the ceiling', () => {
    expect(limitAoA(0.5, deg(5), 0)).toBeCloseTo(0.5, 9)
  })

  it('squeezes the command approaching the ceiling', () => {
    const near = limitAoA(0.5, deg(AOA_CEILING_DEG - 2), 0)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(0.5)
  })

  it('commands nose down past the ceiling rather than merely nothing', () => {
    // Allowing zero would leave the aircraft sitting stably at 26 degrees, slowing
    // down, with the limiter reporting success.
    expect(limitAoA(0.5, deg(AOA_CEILING_DEG + 4), 0)).toBeLessThan(0)
  })

  it('leaves a nose-down command alone when alpha is low', () => {
    expect(limitAoA(-0.5, deg(5), 0)).toBe(-0.5)
  })

  it('never trades a nose-down command for a gentler one', () => {
    // Past the ceiling it may command MORE nose-down than asked — that is the
    // recovery. What it must never do is give back less than was requested.
    for (const alphaDeg of [-5, 0, 10, 24, 26, 35]) {
      expect(limitAoA(-0.5, deg(alphaDeg), 0)).toBeLessThanOrEqual(-0.5)
    }
  })

  it('looks ahead, so a fast pull is limited before the ceiling arrives', () => {
    // Same alpha, different pitch rate. Rate matters, because alpha will not stop
    // where it is.
    const settled = limitAoA(0.5, deg(18), 0)
    const climbing = limitAoA(0.5, deg(18), deg(20))

    expect(climbing).toBeLessThan(settled)
  })
})

describe('the G limiter, as a function', () => {
  it('scales the pitch rate cap with airspeed', () => {
    // n = 1 + V*q/g, so the same load factor is a very different pitch rate at
    // each end of the envelope. 9 g is 0.86 rad/s at 300 ft/s and 0.29 at 900.
    expect(limitG(10, 300, 1)).toBeCloseTo((8 * 32.17) / 300, 9)
    expect(limitG(10, 900, 1)).toBeCloseTo((8 * 32.17) / 900, 9)
  })

  it('caps negative g too', () => {
    expect(limitG(-10, 500, 1)).toBeCloseTo((-4 * 32.17) / 500, 9)
  })

  it('does not blow up at very low airspeed', () => {
    expect(Number.isFinite(limitG(10, 0, 1))).toBe(true)
  })

  it('tightens the cap once the aircraft is already past the limit', () => {
    const nominal = limitG(10, 600, 1)
    const overshooting = limitG(10, 600, 10.5)

    expect(overshooting).toBeLessThan(nominal)
  })

  it('never loosens the cap when the aircraft is below the limit', () => {
    // The measured load factor is a protection term, not an authority to exceed
    // the steady-state design point.
    expect(limitG(10, 600, 1)).toBeCloseTo(limitG(10, 600, 4), 12)
  })
})

describe('flown: full aft stick', () => {
  it.each([
    { alt: 5_000, vt: 600 },
    { alt: 10_000, vt: 800 },
    { alt: 20_000, vt: 700 },
  ])('holds alpha below the ceiling at $alt ft, $vt ft/s', ({ alt, vt }) => {
    const flight = fly({
      alt,
      vt,
      seconds: 25,
      input: hold({ pitch: 1, throttle: 1 }),
    })

    expect(flight.diverged).toBe(false)

    const worst = Math.max(...flight.samples.map((s) => s.alphaDeg))

    // A small overshoot is expected — the limiter fades a command, it does not
    // teleport the aircraft — but it must stay far from the data edge.
    expect(worst).toBeLessThan(AOA_CEILING_DEG + 2)
    expect(worst).toBeLessThan(ALPHA_DATA_MAX)
  })

  it('respects the load factor limit', () => {
    const flight = fly({
      alt: 5_000,
      vt: 800,
      seconds: 20,
      input: hold({ pitch: 1, throttle: 1 }),
    })

    const worst = Math.max(...flight.samples.map((s) => s.nz))

    expect(worst).toBeLessThan(G_LIMIT + 0.75)
    // And it should actually get near it, or the test is passing for the wrong
    // reason — a limiter that never engages proves nothing.
    expect(worst).toBeGreaterThan(G_LIMIT - 2.5)
  })

  it('respects the negative limit under full forward stick', () => {
    const flight = fly({
      alt: 10_000,
      vt: 700,
      seconds: 12,
      input: hold({ pitch: -1, throttle: 0.5 }),
    })

    expect(flight.diverged).toBe(false)
    expect(Math.min(...flight.samples.map((s) => s.nz))).toBeGreaterThan(
      BALANCED.gLimitNegative - 0.75,
    )
  })

  it('gives the limits back when the stick is released', () => {
    // The anti-windup case. Hold the stick against the limiter for ten seconds,
    // release, and the aircraft has to respond immediately. Without back-calculation
    // in the pitch law the integrator is wound up and there are several seconds of
    // an aircraft that has stopped listening.
    const flight = fly({
      alt: 10_000,
      vt: 800,
      seconds: 20,
      input: (t) => ({ pitch: t < 10 ? 1 : 0, roll: 0, yaw: 0, throttle: 1 }),
    })

    const atRelease = flight.samples.find((s) => s.t >= 10)!
    const oneSecondLater = flight.samples.find((s) => s.t >= 11)!

    expect(Math.abs(atRelease.state.qRate)).toBeGreaterThan(0.1)
    expect(Math.abs(oneSecondLater.state.qRate)).toBeLessThan(
      Math.abs(atRelease.state.qRate) * 0.4,
    )
  })
})

describe('with the limiters off', () => {
  it('goes past the ceiling, or the limiters were not doing anything', () => {
    // The control case. If full aft stick stays below 25 degrees with the limiters
    // disabled, then every test above passes for a reason that has nothing to do
    // with the limiters.
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 15,
      input: hold({ pitch: 1, throttle: 1 }),
      toggles: { aoaLimiter: false, gLimiter: false },
    })

    const worst = Math.max(...flight.samples.map((s) => s.alphaDeg))
    expect(worst).toBeGreaterThan(AOA_CEILING_DEG)
  })
})
