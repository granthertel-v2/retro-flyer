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
import { FOV_BASE, FOV_HIGH_KT, FOV_LOW_KT, FOV_MAX, targetFov } from '../src/camera/fov.js'
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
