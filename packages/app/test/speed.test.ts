/**
 * Speed sensation (REQUIREMENTS §6).
 *
 * §6 is explicit that this "is authored, not emergent, and belongs in Milestone 2
 * rather than polish", and it was the one section of the spec with no coverage at
 * all — which is how a Mach 0.9 fighter came to feel, in a flight test, "like
 * cruising above the town as a commercial airliner might".
 *
 * None of this measures the feeling. It measures the three quantities the feeling is
 * made of, each of which had drifted somewhere useless.
 */

import { describe, expect, it } from 'vitest'
import {
  FOV_BASE,
  FOV_HIGH_KT,
  FOV_LOW_KT,
  FOV_MAX,
  accelFovBoost,
  targetFov,
} from '../src/camera/fov.js'
import { accelStretch } from '../src/camera/chase.js'
import { PITCH } from '../src/terrain/scatter.js'
import { SPAWN } from '../src/spawn.js'
import { fpsToKt } from '@retro-flyer/physics'

/**
 * Angular rate at which the ground sweeps beneath the aircraft, deg/s.
 *
 * `V / h`, and it is the dominant speed cue by a wide margin. It does not care how
 * fast the aircraft is actually going: 640 ft/s reads as an airliner at 11,000 ft
 * and as alarming at 800.
 */
const groundSweepDegPerSec = (vtFps: number, altFt: number): number =>
  (vtFps / altFt) * (180 / Math.PI)

describe('the spawn is low enough to read as fast', () => {
  it('sweeps the ground fast enough to feel like speed', () => {
    const sweep = groundSweepDegPerSec(SPAWN.vt, SPAWN.alt)

    // At 11,000 ft this was 3.3 deg/s, which is an airliner and was the entire
    // complaint. The flight model was never involved.
    expect(sweep).toBeGreaterThan(10)
  })

  it('is still high enough to have somewhere to descend to', () => {
    // The ridge tops out near 2,320 m — about 7,600 ft — but the spawn is over the
    // bay, and diving at the deck is the point. This only guards against someone
    // "fixing" the feel by spawning at 200 feet.
    expect(SPAWN.alt).toBeGreaterThan(1_200)
    expect(SPAWN.alt).toBeLessThan(6_000)
  })
})

describe('the FOV cue is spent where the aircraft is flown', () => {
  it('widens materially across ordinary speeds', () => {
    // The old band ran to 800 kt and put almost all its travel above anything
    // reached outside a dive: a 640 ft/s cruise sat at 66 degrees against a 58
    // degree base, so the cue was nearly unused.
    const cruise = targetFov(fpsToKt(640))
    const fast = targetFov(fpsToKt(900))

    expect(cruise).toBeGreaterThan(FOV_BASE + 10)
    expect(fast).toBeGreaterThan(cruise + 8)
  })

  it('is monotonic and stays inside its own bounds', () => {
    let previous = -Infinity
    for (let kt = 0; kt <= 1_000; kt += 25) {
      const fov = targetFov(kt)
      expect(fov).toBeGreaterThanOrEqual(FOV_BASE - 1e-9)
      expect(fov).toBeLessThanOrEqual(FOV_MAX + 1e-9)
      expect(fov).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = fov
    }
  })

  it('reaches its stops exactly at the band edges', () => {
    expect(targetFov(FOV_LOW_KT)).toBeCloseTo(FOV_BASE, 9)
    expect(targetFov(FOV_HIGH_KT)).toBeCloseTo(FOV_MAX, 9)
    expect(targetFov(0)).toBeCloseTo(FOV_BASE, 9)
    expect(targetFov(2_000)).toBeCloseTo(FOV_MAX, 9)
  })
})

describe('the near field is dense enough to read as motion', () => {
  it('puts something alongside often enough to be a stream, not a count', () => {
    // §6's "ground detail density and near-field visual reference". What matters is
    // the interval between objects passing, not the count on screen. At 250 m/s a
    // 155 m grid gave 0.62 s — slow enough that the eye counts them individually.
    const metresPerSecond = 250
    const interval = PITCH / metresPerSecond

    expect(interval).toBeLessThan(0.45)
  })
})

/**
 * Measured range of along-path acceleration for this aircraft, ft/s^2.
 *
 * Full afterburner at 5,000 ft, and chopping to idle from Mach 0.9. The asymmetry is
 * real — a clean fighter accelerates harder than it slows down — and it is why the
 * two directions are normalised separately.
 */
const AX_FULL_AB = 28.5
const AX_IDLE_DECEL = -14

describe('acceleration has its own cues, because speed cues cannot carry it', () => {
  // The gap a flight test found: "I don't feel like I've accelerated quickly, I have
  // to intuit it from the Mach number increasing and my waiting." Every cue in the
  // renderer was a function of SPEED, and a function of speed reports the result
  // after the fact rather than the change as it happens.

  it('does nothing at all in steady flight', () => {
    // The cue must be invisible when it has nothing to say, or it is just a wobble.
    expect(accelFovBoost(0)).toBe(0)
    expect(accelStretch(0)).toBe(0)
  })

  it('is clearly felt under full afterburner', () => {
    expect(accelFovBoost(AX_FULL_AB)).toBeGreaterThan(5)
    expect(accelStretch(AX_FULL_AB)).toBeGreaterThan(4)
  })

  it('is clearly felt decelerating, which needs its own gain to be reachable at all', () => {
    // This is the assertion that matters most of the pair. Deceleration tops out far
    // lower than acceleration, so a single shared gain spent the whole negative range
    // on nothing: the clamps were unreachable and a deceleration produced under two
    // degrees of FOV. Both directions have to be reachable by inputs a pilot can
    // actually make.
    expect(accelFovBoost(AX_IDLE_DECEL)).toBeLessThan(-3)
    expect(accelStretch(AX_IDLE_DECEL)).toBeLessThan(-2)
  })

  it('is monotonic and bounded, so it cannot run away', () => {
    let previousFov = -Infinity
    let previousTrail = -Infinity

    for (let ax = -60; ax <= 60; ax += 2) {
      const fov = accelFovBoost(ax)
      const trail = accelStretch(ax)

      expect(fov).toBeGreaterThanOrEqual(previousFov - 1e-9)
      expect(trail).toBeGreaterThanOrEqual(previousTrail - 1e-9)
      expect(Math.abs(fov)).toBeLessThanOrEqual(8)
      expect(Math.abs(trail)).toBeLessThanOrEqual(6)

      previousFov = fov
      previousTrail = trail
    }
  })

  it('accelerating and decelerating point opposite ways', () => {
    // Sign errors here are silent and read as the world breathing at random.
    expect(accelFovBoost(AX_FULL_AB)).toBeGreaterThan(0)
    expect(accelFovBoost(AX_IDLE_DECEL)).toBeLessThan(0)
    expect(accelStretch(AX_FULL_AB)).toBeGreaterThan(0)
    expect(accelStretch(AX_IDLE_DECEL)).toBeLessThan(0)
  })
})

describe('the ramp lasts as long as the acceleration does', () => {
  // `ax` is FLAT through an afterburner run — it reaches its maximum about three
  // seconds in and is still within 8% of it fourteen seconds later, while the
  // aircraft goes from Mach 0.46 to 0.90. A cue driven by `ax` alone therefore
  // saturated at t=3 and then sat perfectly still, and a constant offset is not
  // perceived. Reported as the ramp being "a bit too short", which it was: not too
  // fast, just over.

  it('keeps building while acceleration is held', () => {
    const early = accelFovBoost(AX_FULL_AB, 0)
    const late = accelFovBoost(AX_FULL_AB, 1)

    expect(late).toBeGreaterThan(early * 1.3)
  })

  it('still arrives immediately, so the onset is not softened', () => {
    // The sustain envelope must not be bought by making the cue slow to start. Even
    // with the envelope empty, a hard acceleration is plainly visible at once.
    expect(accelFovBoost(AX_FULL_AB, 0)).toBeGreaterThan(4)
    expect(accelStretch(AX_FULL_AB, 0)).toBeGreaterThan(3)
  })

  it('is still nothing at all in steady flight, however long it is held', () => {
    expect(accelFovBoost(0, 1)).toBe(0)
    expect(accelStretch(0, 1)).toBe(0)
  })

  it('gives disproportionate cue early, so it starts while the engine is spooling', () => {
    // The other half of "start sooner", and the half that is not about time
    // constants. A linear response spends the first seconds of a slam showing almost
    // nothing, because the acceleration genuinely IS small while the engine spools —
    // which is exactly the moment the pilot is looking for confirmation.
    //
    // The curve is sub-linear, so a third of full acceleration gives appreciably
    // more than a third of the cue.
    const third = accelFovBoost(AX_FULL_AB / 3, 1)
    const full = accelFovBoost(AX_FULL_AB, 1)

    expect(third).toBeGreaterThan(full * 0.4)
  })

  it('reaches full travel only with both a hard and a held acceleration', () => {
    expect(accelFovBoost(AX_FULL_AB, 1)).toBeCloseTo(8, 6)
    expect(accelStretch(AX_FULL_AB, 1)).toBeCloseTo(6, 6)
  })
})
