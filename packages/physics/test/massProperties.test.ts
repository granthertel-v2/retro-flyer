/**
 * Tier B — mass properties.
 *
 * The load-bearing test here is the cross-check: our c1..c9, derived from
 * [NASA-TM] Table 1, must reproduce the constants hardcoded in [AEROBENCH]. Those
 * two sources do not cite each other's numbers, so agreement is real evidence
 * rather than a shared transcription error propagating.
 *
 * See `docs/SOURCES.md`.
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_WEIGHT_LB,
  MEAN_CHORD,
  WING_AREA,
  WING_SPAN,
  PUBLISHED_MOMENT_CONSTANTS,
  REFERENCE_FUEL_LB,
  REFERENCE_IXX,
  REFERENCE_IXZ,
  REFERENCE_IYY,
  REFERENCE_IZZ,
  REFERENCE_LOADOUT,
  REFERENCE_WEIGHT_LB,
  XCG_REF,
  computeMassProperties,
  momentConstants,
} from '../src/massProperties.js'
import { G_FT_S2 } from '../src/units.js'

const relativeError = (actual: number, expected: number): number =>
  Math.abs(actual - expected) / Math.abs(expected)

describe('sourced constants match the published values literally', () => {
  // These assert against LITERALS, not against the constants themselves.
  //
  // The break-check (REQUIREMENTS §4.3) found this hole: every other test here
  // compares `mp.xcg` to `XCG_REF`, so changing XCG_REF changes both sides and the
  // test passes regardless. A tautology that reports clean forever is exactly what
  // §4.3 warns about. These are the values traced to [NASA-TM] Table 1 and p.29,
  // written out so that editing a constant has to be a deliberate act.
  it('CG reference is 0.35 c-bar', () => {
    expect(XCG_REF).toBe(0.35)
  })

  it('mass properties match NASA/TM-2003-212145 Table 1', () => {
    expect(REFERENCE_WEIGHT_LB).toBe(20500)
    expect(REFERENCE_IXX).toBe(9496)
    expect(REFERENCE_IYY).toBe(55814)
    expect(REFERENCE_IZZ).toBe(63100)
    expect(REFERENCE_IXZ).toBe(982)
  })

  it('geometry matches the reference implementation', () => {
    expect(WING_AREA).toBe(300)
    expect(WING_SPAN).toBe(30)
    expect(MEAN_CHORD).toBe(11.32)
  })

  it('the default loadout puts the CG at the aero reference station', () => {
    // Also a literal. If the CG reference moved, the aerodynamic coefficients would
    // need a correction term that the default configuration currently gets for free.
    expect(computeMassProperties().xcg).toBeCloseTo(0.35, 12)
  })
})

describe('reference configuration', () => {
  it('reproduces the published weight and CG', () => {
    const mp = computeMassProperties(REFERENCE_LOADOUT)

    expect(mp.weight).toBeCloseTo(REFERENCE_WEIGHT_LB, 9)
    expect(mp.xcg).toBeCloseTo(XCG_REF, 12)
    expect(mp.mass).toBeCloseTo(REFERENCE_WEIGHT_LB / G_FT_S2, 9)
  })

  it('reproduces the published inertia tensor exactly', () => {
    const mp = computeMassProperties(REFERENCE_LOADOUT)

    expect(mp.ixx).toBeCloseTo(REFERENCE_IXX, 9)
    expect(mp.iyy).toBeCloseTo(REFERENCE_IYY, 9)
    expect(mp.izz).toBeCloseTo(REFERENCE_IZZ, 9)
    expect(mp.ixz).toBeCloseTo(REFERENCE_IXZ, 9)
  })

  it('defaults to the reference configuration when given no loadout', () => {
    expect(computeMassProperties()).toEqual(
      computeMassProperties(REFERENCE_LOADOUT),
    )
  })

  it('splits the reference weight into empty plus fuel consistently', () => {
    expect(EMPTY_WEIGHT_LB + REFERENCE_FUEL_LB).toBe(REFERENCE_WEIGHT_LB)
  })
})

describe('c1..c9 cross-check against the independent reference implementation', () => {
  // The published constants carry 3-4 significant figures, which is what sets this
  // tolerance. Agreement is limited by their rounding, not by our algebra.
  const TOLERANCE = 1e-3

  const derived = momentConstants(
    REFERENCE_IXX,
    REFERENCE_IYY,
    REFERENCE_IZZ,
    REFERENCE_IXZ,
  )

  for (const key of Object.keys(PUBLISHED_MOMENT_CONSTANTS) as Array<
    keyof typeof PUBLISHED_MOMENT_CONSTANTS
  >) {
    it(`${key} matches the published value within 0.1%`, () => {
      expect(relativeError(derived[key], PUBLISHED_MOMENT_CONSTANTS[key])).toBeLessThan(
        TOLERANCE,
      )
    })
  }

  it('the reference loadout produces the same constants as the raw tensor', () => {
    expect(computeMassProperties(REFERENCE_LOADOUT).moments).toEqual(derived)
  })
})

describe('inverting c1..c9 recovers the NASA tensor', () => {
  // This is the derivation recorded in docs/SOURCES.md, run as a test. If someone
  // edits the published constants or the tensor without editing the other, this
  // fails.
  const { c3, c5, c6, c7, c9 } = PUBLISHED_MOMENT_CONSTANTS

  const iyy = 1 / c7
  const ixz = c6 * iyy
  const ratio = c3 / c9 // izz / ixx
  const ixx = (c5 * iyy) / (ratio - 1)
  const izz = ratio * ixx

  it.each([
    ['ixx', ixx, REFERENCE_IXX],
    ['iyy', iyy, REFERENCE_IYY],
    ['izz', izz, REFERENCE_IZZ],
    ['ixz', ixz, REFERENCE_IXZ],
  ])('%s agrees with NASA Table 1 within 0.1%%', (_name, recovered, published) => {
    expect(relativeError(recovered, published)).toBeLessThan(1e-3)
  })
})

describe('loadout responds to what is loaded (REQUIREMENTS §8.4)', () => {
  it('burning fuel reduces weight and mass', () => {
    const full = computeMassProperties({ ...REFERENCE_LOADOUT, fuel: 5000 })
    const empty = computeMassProperties({ ...REFERENCE_LOADOUT, fuel: 0 })

    expect(empty.weight).toBe(full.weight - 5000)
    expect(empty.mass).toBeLessThan(full.mass)
  })

  it('fuel forward of the reference station moves the CG forward', () => {
    const aft = computeMassProperties({ ...REFERENCE_LOADOUT, fuelStation: 0.45 })
    const fwd = computeMassProperties({ ...REFERENCE_LOADOUT, fuelStation: 0.25 })

    expect(fwd.xcg).toBeLessThan(XCG_REF)
    expect(aft.xcg).toBeGreaterThan(XCG_REF)
  })

  it('lighter aircraft has lower inertia, and c1..c9 follow automatically', () => {
    const light = computeMassProperties({ ...REFERENCE_LOADOUT, fuel: 0 })

    expect(light.iyy).toBeLessThan(REFERENCE_IYY)
    // c7 = 1/Iyy, so lower inertia must raise it. This is the property that makes
    // the seam worth having: nothing had to be updated by hand.
    expect(light.moments.c7).toBeGreaterThan(PUBLISHED_MOMENT_CONSTANTS.c7)
  })

  it('a wingtip store raises roll inertia by its point-mass contribution', () => {
    // Reserved-but-unused path (REQUIREMENTS §8.4 / §9.2). Exercised now so that it
    // is known to work when weapons arrive, rather than discovered broken then.
    const y = 15 // ft from centerline, roughly a wingtip station
    const weight = 500

    const base = computeMassProperties(REFERENCE_LOADOUT)
    const laden = computeMassProperties({
      ...REFERENCE_LOADOUT,
      stores: [{ name: 'test-store', weight, x: XCG_REF, y }],
    })

    expect(laden.weight).toBe(base.weight + weight)

    // Two effects on Ixx: the airframe tensor scales up with total mass, and the
    // store adds m*y^2 about the roll axis. Check the point-mass term explicitly.
    const massRatio = laden.weight / base.weight
    const scaledAirframe = REFERENCE_IXX * massRatio
    const pointMass = (weight / G_FT_S2) * y * y

    expect(laden.ixx).toBeCloseTo(scaledAirframe + pointMass, 6)
  })

  it('a store offset longitudinally shifts the CG by its moment arm', () => {
    const weight = 1000
    const x = 0.6

    const laden = computeMassProperties({
      ...REFERENCE_LOADOUT,
      stores: [{ name: 'aft-store', weight, x }],
    })

    const expectedXcg =
      (REFERENCE_WEIGHT_LB * XCG_REF + weight * x) / (REFERENCE_WEIGHT_LB + weight)

    expect(laden.xcg).toBeCloseTo(expectedXcg, 12)
    expect(laden.xcg).toBeGreaterThan(XCG_REF)
  })

  it('mean chord is used to convert store station into a real moment arm', () => {
    // Guards a unit slip: stations are in fractions of c-bar, inertia arms in feet.
    const weight = 500
    const x = XCG_REF + 0.5
    const z = 0

    const laden = computeMassProperties({
      ...REFERENCE_LOADOUT,
      stores: [{ name: 'aft-store', weight, x, z }],
    })

    const dxFeet = (x - laden.xcg) * MEAN_CHORD
    const pointMass = (weight / G_FT_S2) * dxFeet * dxFeet
    const scaledAirframe = REFERENCE_IYY * (laden.weight / REFERENCE_WEIGHT_LB)

    expect(laden.iyy).toBeCloseTo(scaledAirframe + pointMass, 6)
  })
})
