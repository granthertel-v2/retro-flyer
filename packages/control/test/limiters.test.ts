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
import { degToRad, radToDeg } from '@retro-flyer/physics'
import {
  AOA_CEILING_DEG,
  AOA_CEILING_LOW_SPEED_DEG,
  AOA_FLOOR_DEG,
  effectiveCeiling,
  BALANCED,
  G_LIMIT,
  PitchLaw,
  downRateFraction,
  pitchRateCommand,
  effectiveFloor,
  AOA_FLOOR_LOW_SPEED_DEG,
  limitAoA,
  limitG,
  scheduledGains,
} from '../src/index.js'
import { ALPHA_DATA_MAX, ALPHA_DATA_MIN, fly, hold, peak } from './helpers.js'

const deg = (d: number): number => (d * Math.PI) / 180

describe('the AoA limiter, as a function', () => {
  it('passes a nose-up command through well below the ceiling', () => {
    expect(limitAoA(0.5, deg(5), 0, 640)).toBeCloseTo(0.5, 9)
  })

  it('squeezes the command approaching the ceiling', () => {
    const near = limitAoA(0.5, deg(AOA_CEILING_DEG - 2), 0, 640)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(0.5)
  })

  it('commands nose down past the ceiling rather than merely nothing', () => {
    // Allowing zero would leave the aircraft sitting stably at 26 degrees, slowing
    // down, with the limiter reporting success.
    expect(limitAoA(0.5, deg(AOA_CEILING_DEG + 4), 0, 640)).toBeLessThan(0)
  })

  it('leaves a nose-down command alone when alpha is low', () => {
    expect(limitAoA(-0.5, deg(5), 0, 640)).toBe(-0.5)
  })

  it('never trades a nose-down command for a gentler one, above the floor', () => {
    // Past the ceiling it may command MORE nose-down than asked — that is the
    // recovery. What it must never do is give back less than was requested, unless
    // the floor is the thing intervening, which is the whole point of the floor.
    for (const alphaDeg of [0, 10, 24, 26, 35]) {
      expect(limitAoA(-0.5, deg(alphaDeg), 0, 640)).toBeLessThanOrEqual(-0.5)
    }
  })

  it('looks ahead, so a fast pull is limited before the ceiling arrives', () => {
    // Same alpha, different pitch rate. Rate matters, because alpha will not stop
    // where it is.
    // Close enough to the ceiling that the limiter is in play; at 18 degrees with
    // a 30 degree ceiling there is enough margin that neither is limited at all and
    // the comparison says nothing.
    const settled = limitAoA(0.5, deg(26), 0, 640)
    const climbing = limitAoA(0.5, deg(26), deg(20), 640)

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

    // Against the PRESET's limit, not the module default. The flight above is flown
    // by BALANCED, and once a preset raises its own limit above G_LIMIT a test
    // asserting the default is measuring a number nothing in that flight used.
    expect(worst).toBeLessThan(BALANCED.gLimit + 0.75)
    // And it should actually get near it, or the test is passing for the wrong
    // reason — a limiter that never engages proves nothing.
    expect(worst).toBeGreaterThan(BALANCED.gLimit - 2.5)
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

  it('unwinds its integrator instead of storing up a debt', () => {
    // Anti-windup, tested where it actually happens: drive the pitch law hard into
    // the elevator stop and check the integrator does not keep accumulating for as
    // long as the stick is held. Without back-calculation it grows without bound
    // and releasing the stick does nothing until it has wound back down.
    const gains = scheduledGains(700, 10_000)
    const law = new PitchLaw()

    // Command far more pitch rate than the elevator can deliver, from a state that
    // cannot satisfy it, for five seconds.
    let integralAfterOneSecond = 0
    for (let i = 0; i < 600; i++) {
      law.update(3, degToRad(2), 0, gains, 1 / 120)
      if (i === 119) integralAfterOneSecond = law.integral
    }

    expect(Math.abs(law.integral)).toBeLessThan(Math.abs(integralAfterOneSecond) * 1.5 + 0.5)
  })

  it('returns to one g when a sustained pull is released', () => {
    // The contract of a g-command law: centre stick is one g, whatever attitude the
    // aircraft happens to be in. This used to assert that pitch rate crossed zero
    // after release, which was the contract of the rate-command law it replaced —
    // and is wrong now, because ten seconds at full aft stick is a loop and one g
    // at the top of a loop is emphatically not zero pitch rate.
    const flight = fly({
      alt: 10_000,
      vt: 800,
      seconds: 20,
      input: (t) => ({ pitch: t < 10 ? 1 : 0, roll: 0, yaw: 0, throttle: 1 }),
    })

    const settledNz = flight.samples.filter((s) => s.t > 14).map((s) => s.nz)

    expect(Math.min(...settledNz)).toBeGreaterThan(0.7)
    expect(Math.max(...settledNz)).toBeLessThan(1.5)
  })

  it('commands the same rate at every speed, which is the point of it', () => {
    // The reason the command is a rate and not a load factor. Deriving pitch rate
    // from a commanded n makes full stick mean less and less the faster you fly —
    // 23 deg/s at 640 ft/s and 16 at 900 — so speed made the aircraft feel more
    // sluggish. Full stick now asks for the same thing everywhere, and the limiters
    // downstream are what stop you bending it.
    const rate = degToRad(55)
    const level = (vt: number): number => pitchRateCommand(1, rate, rate, vt, 0, 0)

    expect(level(500)).toBeCloseTo(rate, 9)
    expect(level(900)).toBeCloseTo(rate, 9)
  })

  it('asks for a pull when inverted at centre stick, and nothing when level', () => {
    // The whole reason for the gravity term, which survived the change from a load
    // factor command to a rate one. Level, one g needs no pitch rate; inverted, one
    // g toward the aircraft's belly means pulling toward the ground, which is why an
    // aeroplane does not fly upside down hands-off.
    const r = degToRad(55)
    expect(pitchRateCommand(0, r, r, 640, 0, 0)).toBeCloseTo(0, 9)
    expect(pitchRateCommand(0, r, r, 640, Math.PI, 0)).toBeGreaterThan(0.05)

    // And knife-edge is in between: no vertical lift at all, so one g of pull just
    // turns while gravity takes it down.
    const knifeEdge = pitchRateCommand(0, r, r, 640, Math.PI / 2, 0)
    expect(knifeEdge).toBeGreaterThan(0)
    expect(knifeEdge).toBeLessThan(pitchRateCommand(0, r, r, 640, Math.PI, 0))
  })

  it('gives less nose-down authority than nose-up, because the limits are not symmetric', () => {
    // +11 and -4 means less than half as much room to push as to pull. Commanding
    // the same rate both ways just moves the catch from the g limiter to the AoA
    // floor, which is the end with 2 degrees of margin rather than 13.
    expect(downRateFraction(11, -4)).toBeCloseTo(0.5, 9)
    expect(downRateFraction(9, -3)).toBeCloseTo(0.5, 9)
    expect(downRateFraction(4, -9)).toBe(1)
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

describe('the limiter leads on alpha, not on pitch rate', () => {
  it('never commands nose-up while the stick is held fully forward', () => {
    // The bug this asserts against was felt before it was measured: the pushover
    // went mushy. The AoA limiter was predicting alpha from PITCH RATE, and in
    // steady curving flight that is simply the wrong quantity — the aircraft rotates
    // at a constant q while alpha sits still, because the flight path is rotating
    // with it. So the limiter kept forecasting an excursion that was not coming.
    //
    // Measured, holding full forward at 10,000 ft and 700 ft/s: alpha steady at -5.2
    // against a -8 floor, the limiter chattering on and off every few ticks, and the
    // commanded rate swinging between -13.1 and +5.1 deg/s. Commanding +5 deg/s of
    // NOSE UP while the pilot holds full forward stick is indefensible on any
    // account of what a limiter is for.
    const flight = fly({
      alt: 10_000,
      vt: 700,
      seconds: 8,
      input: hold({ pitch: -1, throttle: 0.5 }),
    })

    // Asserted on the flown result rather than the command, because that is what the
    // pilot actually feels — and because a command trace would let a limiter that
    // chatters below the aircraft's response bandwidth pass unnoticed.
    const rates = flight.samples.filter((s) => s.t > 2).map((s) => radToDeg(s.state.qRate))

    // Every sample is nose-down. Any positive pitch rate here is the limiter winning
    // an argument it should not have been having.
    expect(Math.max(...rates)).toBeLessThan(0)
    // And it is a sustained push, not a stalled one — before the fix this settled
    // near -7.8 deg/s.
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length
    expect(mean).toBeLessThan(-9)
  })

  it('reaches its negative load factor limit without blowing through it', () => {
    // Once the AoA limiter stopped throttling every pushover for the wrong reason,
    // the g limiter had to hold the negative limit on its own and turned out to
    // overshoot it: -4.84 g against -4. A push is not opposed by the airframe the
    // way a pull is, so the negative side needs stronger feedback than the positive.
    const flight = fly({
      alt: 10_000,
      vt: 700,
      seconds: 12,
      input: hold({ pitch: -1, throttle: 0.5 }),
    })

    const worst = Math.min(...flight.samples.map((s) => s.nz))

    expect(worst).toBeGreaterThan(BALANCED.gLimitNegative - 0.6)
    // And it must actually get there, or the limiter is untested.
    expect(worst).toBeLessThan(BALANCED.gLimitNegative + 1.5)
  })
})

describe('the angle-of-attack floor', () => {
  it('caps a nose-down command approaching the floor', () => {
    // The data envelope has two ends. The first version of this limiter guarded
    // only the ceiling, and an oscillating full-deflection input walked out of the
    // bottom at -10.4 degrees with every assist switched on.
    expect(limitAoA(-1, deg(AOA_FLOOR_DEG + 1), 0, 640)).toBeGreaterThan(-1)
    expect(limitAoA(-1, deg(AOA_FLOOR_DEG - 2), 0, 640)).toBeGreaterThan(0)
  })

  it('leaves the stick alone in the middle of the envelope', () => {
    for (const alphaDeg of [0, 5, 10, 15]) {
      expect(limitAoA(-0.2, deg(alphaDeg), 0, 640)).toBeCloseTo(-0.2, 9)
    }
  })

  it('holds alpha inside the data envelope under full forward stick', () => {
    const flight = fly({
      alt: 15_000,
      vt: 800,
      seconds: 20,
      input: hold({ pitch: -1, throttle: 1 }),
    })

    expect(flight.departed).toBe(false)
    expect(Math.min(...flight.samples.map((s) => s.alphaDeg))).toBeGreaterThan(ALPHA_DATA_MIN)
  })
})

describe('the floor is scheduled on airspeed too', () => {
  it('gives the full floor where there is authority to recover with', () => {
    expect(effectiveFloor(-8, 700)).toBeCloseTo(-8, 9)
    expect(effectiveFloor(-8, 900)).toBeCloseTo(-8, 9)
  })

  it('raises it where there is not', () => {
    // Recovering from negative alpha means commanding a pull, and how fast that pull
    // arrives depends on dynamic pressure. A rate command asks for the same degrees
    // per second at every speed, so at low q-bar the aircraft reaches the floor just
    // as quickly with far less available to stop it. Every departure in the
    // adversarial family was at 20,000 ft or above before this existed.
    expect(effectiveFloor(-8, 400)).toBeCloseTo(AOA_FLOOR_LOW_SPEED_DEG, 9)
    expect(effectiveFloor(-8, 250)).toBeCloseTo(AOA_FLOOR_LOW_SPEED_DEG, 9)
    expect(effectiveFloor(-8, 550)).toBeGreaterThan(-8)
    expect(effectiveFloor(-8, 550)).toBeLessThan(AOA_FLOOR_LOW_SPEED_DEG)
  })

  it('never lowers a floor that is already above the low-speed one', () => {
    // A preset with a shallow floor should not have it pushed DOWN by flying slowly.
    expect(effectiveFloor(-3, 300)).toBeCloseTo(-3, 9)
  })

  it('stops harder at the floor than at the ceiling, because it has less room', () => {
    // The floor is 2 degrees from the edge of the data where the ceiling is 13. A
    // gentle approach lets alpha coast a degree or two past the boundary, which is
    // fine above and was the entire failure below.
    const nearFloor = limitAoA(-1, deg(AOA_FLOOR_DEG + 1), 0, 800)
    const nearCeiling = limitAoA(1, deg(AOA_CEILING_DEG - 1), 0, 800)

    expect(Math.abs(nearFloor)).toBeGreaterThan(Math.abs(nearCeiling))
  })
})

describe('the ceiling is scheduled on airspeed', () => {
  it('gives the full ceiling at combat speed', () => {
    expect(effectiveCeiling(30, 700)).toBeCloseTo(30, 9)
    expect(effectiveCeiling(30, 900)).toBeCloseTo(30, 9)

    // The fade now starts at 700, not 480. A rate command asks for the same pitch
    // rate at every speed, so it demands far more of the aircraft at low q-bar than
    // the load-factor mapping did, and the ceiling has to start coming down to meet
    // it — at 480 a sustained pull at 20,000 ft reached 162 degrees alpha.
    expect(effectiveCeiling(30, 480)).toBeLessThan(30)
    expect(effectiveCeiling(30, 480)).toBeGreaterThan(AOA_CEILING_LOW_SPEED_DEG)
  })

  it('reduces it when there is not enough speed to recover', () => {
    expect(effectiveCeiling(30, 320)).toBeCloseTo(AOA_CEILING_LOW_SPEED_DEG, 9)
    expect(effectiveCeiling(30, 200)).toBeCloseTo(AOA_CEILING_LOW_SPEED_DEG, 9)
  })

  it('is monotonic in airspeed and never above the preset', () => {
    let previous = 0
    for (let vt = 150; vt <= 900; vt += 25) {
      const c = effectiveCeiling(30, vt)
      expect(c).toBeGreaterThanOrEqual(previous - 1e-9)
      expect(c).toBeLessThanOrEqual(30 + 1e-9)
      previous = c
    }
  })

  it('never raises a preset whose ceiling is already low', () => {
    // Honest sits at 25, below the low-speed figure. The schedule must not hand it
    // more alpha at low speed than it asks for at high.
    expect(effectiveCeiling(15, 200)).toBeLessThanOrEqual(15 + 1e-9)
  })

  it('recovers from a slow-speed pull instead of departing', () => {
    // 25,000 ft, part throttle, sustained pull, then roll. Without the schedule
    // this bled from 420 ft/s to 159 with alpha at 84 degrees and the elevator on
    // its nose-down stop, which nothing recovers from.
    const flight = fly({
      alt: 25_000,
      vt: 420,
      seconds: 25,
      input: (t) => ({ pitch: t > 2 ? 1 : 0, roll: t > 6 ? 1 : 0, yaw: 0, throttle: 0.3 }),
    })

    expect(flight.departed).toBe(false)
    expect(Math.max(...flight.samples.map((s) => s.alphaDeg))).toBeLessThan(ALPHA_DATA_MAX - 10)
    // And it flies out the other side rather than mushing to a stop.
    expect(flight.last.state.vt).toBeGreaterThan(350)
  })
})
