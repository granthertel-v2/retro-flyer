/**
 * Where a flight begins.
 *
 * `runwayStart` has been exercised indirectly since Day 3 — `takeoff.test.ts` and
 * `acceptance.test.ts` both fly out of one. `airborneStart` is new and is what a
 * first-time visitor gets, so it is worth testing directly and on its own.
 *
 * The case that matters is the last one. `Simulation.trimAt` treats `alt` as absolute
 * MSL and never consults the ground, which is fine for the authored map, where the
 * spawn was hand-placed over water. Ten kilometres off the end of an arbitrary runway
 * in an arbitrary region is a different proposition: the number that reads as "two
 * thousand feet up" over Jamaica Bay is underground in front of a ridge. So the
 * clearance is asserted against a deliberately hostile height field rather than
 * assumed from the geometry.
 */

import { describe, expect, it } from 'vitest'
import {
  APPROACH_DISTANCE_M,
  MIN_CLEARANCE_FT,
  SPAWN,
  airborneStart,
  runwayStart,
} from '../src/spawn.js'
import type { Airfield } from '../src/terrain/source.js'

const FT = 0.3048

/** A runway pointing due east, at sea level, at the origin. */
const east: Airfield = {
  name: 'East',
  x: 0,
  z: 0,
  elevation: 0,
  headingDeg: 90,
  lengthM: 3_000,
  widthM: 45,
}

/** Due north, and two thousand feet up, so the field elevation has to be carried. */
const highNorth: Airfield = {
  name: 'High North',
  x: 1_000,
  z: -2_000,
  elevation: 2_000 * FT,
  headingDeg: 0,
  lengthM: 2_400,
  widthM: 45,
}

const flat = (metres: number) => ({ height: () => metres })

describe('an airborne start is on the extended centreline', () => {
  it('sits the approach distance back from the field', () => {
    const start = airborneStart(east)
    expect(Math.hypot(start.x - east.x, start.z - east.z)).toBeCloseTo(APPROACH_DISTANCE_M, 6)
  })

  // Renderer axes: +X is east, -Z is north. Ten kilometres back from a runway
  // pointing east is ten kilometres west of it, on the same line.
  it('puts the field ahead, not behind or beside', () => {
    const start = airborneStart(east)
    expect(start.x).toBeCloseTo(-APPROACH_DISTANCE_M, 6)
    expect(start.z).toBeCloseTo(0, 6)
  })

  it('is aligned with the runway, so the field is straight ahead', () => {
    expect(airborneStart(east).headingDeg).toBe(east.headingDeg)
    expect(airborneStart(highNorth).headingDeg).toBe(highNorth.headingDeg)
  })

  it('lines up the same way for a runway pointing north', () => {
    const start = airborneStart(highNorth)
    expect(start.x).toBeCloseTo(highNorth.x, 6)
    expect(start.z).toBeCloseTo(highNorth.z + APPROACH_DISTANCE_M, 6)
  })

  it('is flying, not parked', () => {
    const start = airborneStart(east)
    expect(start.onGround).toBeUndefined()
    expect(start.vt).toBe(SPAWN.vt)
    expect(start.vt).toBeGreaterThan(0)
  })

  // `runwayStart` is the other half of the choice and must stay on the ground.
  it('is the opposite of a runway start, which is parked at the threshold', () => {
    const parked = runwayStart(east)
    expect(parked.onGround).toBe(true)
    expect(parked.vt).toBe(0)
  })
})

describe('an airborne start arrives from the side that looks at something', () => {
  // A runway has two directions and the data names one. For an arrival the unnamed one
  // is often the better answer: Kennedy's published heading puts the start over
  // Brooklyn with Manhattan behind the aircraft.
  const city = (x: number, z: number) => ({ height: () => 0, places: [{ x, z }] })

  it('keeps the published heading when there is nothing to aim at', () => {
    expect(airborneStart(east, flat(0)).headingDeg).toBe(east.headingDeg)
    expect(airborneStart(east).headingDeg).toBe(east.headingDeg)
    expect(airborneStart(east, { height: () => 0, places: [] }).headingDeg).toBe(east.headingDeg)
  })

  // The runway points east, so the published approach starts to the west. A city in
  // the west is one the aircraft would be flying away from: come the other way.
  it('turns around rather than fly away from the city', () => {
    const start = airborneStart(east, city(-30_000, 0))
    expect(start.headingDeg).toBe(270)
    expect(start.x).toBeCloseTo(APPROACH_DISTANCE_M, 6)
  })

  it('keeps the published heading when the city is already ahead', () => {
    const start = airborneStart(east, city(30_000, 0))
    expect(start.headingDeg).toBe(east.headingDeg)
    expect(start.x).toBeCloseTo(-APPROACH_DISTANCE_M, 6)
  })

  // Whichever end it picks, the field is still directly ahead — that is the invariant
  // the choice must not break.
  it('always leaves the field straight ahead', () => {
    for (const [cx, cz] of [
      [30_000, 0],
      [-30_000, 0],
      [0, 30_000],
      [0, -30_000],
    ] as const) {
      const start = airborneStart(east, city(cx, cz))
      const heading = (start.headingDeg * Math.PI) / 180
      const ahead = {
        x: start.x + Math.sin(heading) * APPROACH_DISTANCE_M,
        z: start.z - Math.cos(heading) * APPROACH_DISTANCE_M,
      }
      expect(Math.hypot(ahead.x - east.x, ahead.z - east.z)).toBeLessThan(1)
    }
  })

  it('only ever picks one of the two runway directions', () => {
    for (const field of [east, highNorth]) {
      for (const [cx, cz] of [
        [40_000, 10_000],
        [-40_000, -10_000],
      ] as const) {
        const picked = airborneStart(field, city(cx, cz)).headingDeg
        expect([field.headingDeg, (field.headingDeg + 180) % 360]).toContain(picked)
      }
    }
  })
})

describe('an airborne start clears the ground', () => {
  it('holds the spawn height above the field, not above the sea', () => {
    // The whole point: 2,200 ft is a height above the ground, and the ground here is
    // already 2,000 ft up. An MSL reading would put this 2,000 ft lower than intended.
    expect(airborneStart(highNorth, flat(highNorth.elevation)).alt).toBeCloseTo(
      2_000 + SPAWN.alt,
      6,
    )
    expect(airborneStart(east, flat(0)).alt).toBeCloseTo(SPAWN.alt, 6)
  })

  it('climbs over terrain that is higher than the field', () => {
    // A ridge on the approach path, six thousand feet up and well above the field.
    const start = airborneStart(east, flat(6_000 * FT))
    expect(start.alt).toBeGreaterThanOrEqual(6_000 + MIN_CLEARANCE_FT)
  })

  it('keeps the clearance for any ground at all', () => {
    // The epsilon is the feet→metres→feet round trip in the fixture, not slack in the
    // clearance: 9_000 * 0.3048 / 0.3048 is 8999.999999999998.
    for (const groundFt of [0, 500, 2_200, 5_000, 9_000, 14_000]) {
      const start = airborneStart(east, flat(groundFt * FT))
      expect(start.alt - groundFt).toBeGreaterThan(MIN_CLEARANCE_FT - 1e-6)
    }
  })

  it('does not sink below the field height just because the ground is low', () => {
    // Ten kilometres out over a valley floor at sea level, from a field on a plateau:
    // the approach should still be flown from above the field, not from above the valley.
    const start = airborneStart(highNorth, flat(0))
    expect(start.alt).toBeGreaterThanOrEqual(2_000 + SPAWN.alt)
  })

  it('falls back to the field elevation when nothing can be asked about terrain', () => {
    expect(airborneStart(highNorth).alt).toBeCloseTo(2_000 + SPAWN.alt, 6)
  })
})
