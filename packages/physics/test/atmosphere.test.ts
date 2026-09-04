/**
 * Tier B — atmosphere.
 *
 * Two jobs. First, ordinary sanity: density and pressure fall with altitude, sea
 * level matches the standard day. Second, and more useful, pinning the *difference*
 * between the flight model's simplified atmosphere and true ISA, so that a known
 * limitation stays known instead of quietly becoming a mystery later.
 *
 * The headline finding, measured here rather than assumed: the model atmosphere
 * tracks ISA to better than 0.25% up to 35,000 ft, then diverges sharply, reaching
 * ~10% too dense by 60,000 ft. It keeps applying the troposphere density power law
 * into the stratosphere instead of switching to exponential decay.
 *
 * That is not a bug to fix. The aero tables and every published trim solution are
 * referenced to this atmosphere, so changing it would invalidate them. It is a
 * bounded inaccuracy, and the boundary is 35,000 ft.
 */

import { describe, expect, it } from 'vitest'
import { airData, isa, isaValid } from '../src/atmosphere.js'

const pctDiff = (a: number, b: number): number => (Math.abs(a - b) / b) * 100

describe('ISA (REQUIREMENTS §2.3, display atmosphere)', () => {
  it('matches the standard day at sea level', () => {
    const sl = isa(0)

    expect(sl.temperature).toBeCloseTo(518.67, 2) // 288.15 K
    expect(sl.pressure).toBeCloseTo(2116.22, 1) // 101325 Pa
    expect(sl.density).toBeCloseTo(2.3769e-3, 6) // 1.225 kg/m^3
    expect(sl.speedOfSound).toBeCloseTo(1116.4, 0) // 340.3 m/s
  })

  it('holds temperature constant through the lower stratosphere', () => {
    // 216.65 K, from the tropopause up. This is what makes speed of sound flat
    // above ~36,089 ft, which in turn is why Mach stops changing with altitude.
    expect(isa(40000).temperature).toBeCloseTo(389.97, 2)
    expect(isa(60000).temperature).toBeCloseTo(389.97, 2)
    expect(isa(40000).speedOfSound).toBeCloseTo(isa(60000).speedOfSound, 6)
  })

  it('decreases monotonically in pressure and density to 60,000 ft', () => {
    let prevP = Infinity
    let prevRho = Infinity

    for (let h = 0; h <= 60000; h += 1000) {
      const a = isa(h)
      expect(a.pressure).toBeLessThan(prevP)
      expect(a.density).toBeLessThan(prevRho)
      prevP = a.pressure
      prevRho = a.density
    }
  })

  it('is continuous across the tropopause', () => {
    const below = isa(36089.24 - 0.01)
    const above = isa(36089.24 + 0.01)

    expect(pctDiff(above.pressure, below.pressure)).toBeLessThan(0.01)
    expect(pctDiff(above.density, below.density)).toBeLessThan(0.01)
  })

  it('reports its stated validity range', () => {
    expect(isaValid(0)).toBe(true)
    expect(isaValid(60000)).toBe(true)
    expect(isaValid(60001)).toBe(false)
    expect(isaValid(-1)).toBe(false)
  })
})

describe('flight model atmosphere', () => {
  it('computes dynamic pressure as 1/2 rho V^2', () => {
    const a = airData(500, 10000)
    expect(a.qbar).toBeCloseTo(0.5 * a.rho * 500 * 500, 12)
  })

  it('computes Mach as V over the local speed of sound', () => {
    const a = airData(700, 20000)
    expect(a.mach).toBeCloseTo(700 / a.speedOfSound, 12)
  })

  it('scales dynamic pressure with the square of airspeed', () => {
    const slow = airData(300, 10000)
    const fast = airData(600, 10000)
    expect(fast.qbar / slow.qbar).toBeCloseTo(4, 9)
  })

  it('has a small speed-of-sound step at the 35,000 ft model boundary', () => {
    // The source switches temperature to a flat 390 R at 35,000 ft while density
    // keeps following the troposphere law. That kink is in the reference model and
    // is kept deliberately. It is under 0.2%, so Mach barely notices.
    const below = airData(500, 34999)
    const above = airData(500, 35001)

    expect(pctDiff(above.speedOfSound, below.speedOfSound)).toBeLessThan(0.2)
    expect(above.speedOfSound).toBeLessThan(below.speedOfSound)
  })
})

describe('model vs ISA — the known-limitation boundary', () => {
  it('agrees with ISA to better than 0.3% below 35,000 ft', () => {
    for (let h = 0; h <= 34000; h += 2000) {
      const m = airData(500, h)
      const i = isa(h)

      expect(pctDiff(m.rho, i.density)).toBeLessThan(0.3)
      expect(pctDiff(m.speedOfSound, i.speedOfSound)).toBeLessThan(0.4)
    }
  })

  it('over-predicts density in the stratosphere, by ~10% at 60,000 ft', () => {
    // Pinned, not tolerated silently. If a future change alters the model
    // atmosphere, this is the test that says so, and says by how much.
    const at40k = pctDiff(airData(500, 40000).rho, isa(40000).density)
    const at50k = pctDiff(airData(500, 50000).rho, isa(50000).density)
    const at60k = pctDiff(airData(500, 60000).rho, isa(60000).density)

    expect(at40k).toBeGreaterThan(3)
    expect(at40k).toBeLessThan(4)
    expect(at50k).toBeGreaterThan(9)
    expect(at50k).toBeLessThan(10)
    expect(at60k).toBeGreaterThan(9)
    expect(at60k).toBeLessThan(11)

    // Always too dense, never too thin. Consequence for flying: the aircraft
    // produces more lift and more drag up high than reality would give it.
    expect(airData(500, 60000).rho).toBeGreaterThan(isa(60000).density)
  })

  it('agrees with ISA on speed of sound above the tropopause', () => {
    // Both settle on the same isothermal value, so Mach is trustworthy up high
    // even where density is not.
    for (const h of [40000, 50000, 60000]) {
      expect(pctDiff(airData(500, h).speedOfSound, isa(h).speedOfSound)).toBeLessThan(0.1)
    }
  })
})
