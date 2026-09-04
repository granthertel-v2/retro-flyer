/**
 * The afterburner plume (§6).
 *
 * The only cue in the acceleration chain that marks an EVENT rather than a quantity,
 * and the reason its threshold is tested rather than eyeballed: it has to agree with
 * the engine model about when the burner lights, or the picture and the simulation
 * are telling the pilot different things.
 */

import { describe, expect, it } from 'vitest'
import { BURNER_POWER, burnerFlicker, burnerIntensity } from '../src/afterburner.js'
import { pdot } from '@retro-flyer/physics'

describe('the plume lights where the engine does', () => {
  it('agrees with the engine model about the afterburner line', () => {
    // Not a number picked to look right. `pdot` encodes the real hysteresis at the
    // 50 per cent power line — crossing it upward targets 60 at a fast time constant
    // — so this asserts the two files share a threshold rather than happening to.
    //
    // Below the line the engine spools at the ordinary lag; above it, it does not.
    const below = pdot(40, 45)
    const lighting = pdot(40, 55)

    expect(BURNER_POWER).toBe(50)
    expect(Math.abs(lighting)).toBeGreaterThan(Math.abs(below))
  })

  it('shows nothing at all in dry thrust', () => {
    for (const power of [0, 10, 30, 49, 50]) {
      expect(burnerIntensity(power), `power ${power}`).toBe(0)
    }
  })

  it('grows out of the nozzle rather than switching on', () => {
    // A hard step would flicker every time the power level dithered across the line
    // at part throttle, and the engine does sit near it: `pdot` drives toward 60
    // after the light, so 50 gets crossed slowly enough to matter.
    const just = burnerIntensity(52)
    const some = burnerIntensity(70)
    const full = burnerIntensity(100)

    expect(just).toBeGreaterThan(0)
    expect(just).toBeLessThan(0.1)
    expect(some).toBeGreaterThan(just)
    expect(full).toBeGreaterThan(some)
    expect(full).toBeCloseTo(1, 9)
  })

  it('is monotonic and bounded', () => {
    let previous = -Infinity
    for (let power = 0; power <= 120; power += 2) {
      const intensity = burnerIntensity(power)
      expect(intensity).toBeGreaterThanOrEqual(previous - 1e-9)
      expect(intensity).toBeGreaterThanOrEqual(0)
      expect(intensity).toBeLessThanOrEqual(1)
      previous = intensity
    }
  })
})

describe('the flicker', () => {
  it('stays close to unity, so it modulates rather than pulses', () => {
    for (let t = 0; t < 20; t += 0.013) {
      expect(burnerFlicker(t)).toBeGreaterThan(0.85)
      expect(burnerFlicker(t)).toBeLessThan(1.15)
    }
  })

  it('does not repeat on a period the eye can lock onto', () => {
    // One sine reads as a pulsing bulb. Two that do not share a period never quite
    // repeat — so a sample one full cycle of the slower component later should not
    // land back on the same value.
    const period = (2 * Math.PI) / 37
    expect(burnerFlicker(1)).not.toBeCloseTo(burnerFlicker(1 + period), 3)
  })
})
