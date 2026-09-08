/**
 * The committed New York region, read back through the seam that will serve it.
 *
 * `region.test.ts` checks the machinery on synthetic data — tier selection, bilinear
 * sampling, the runway lift — using a manifest and blob built in memory. This file
 * checks the opposite thing: that the **real** data, produced by
 * `tools/build_region.py` from USGS, OpenStreetMap and the FAA and committed to the
 * tree, is what it claims to be.
 *
 * It has to exist because every failure the builder had was of a kind no unit test
 * would have caught. Two joined the wrong records and produced a region that parsed
 * perfectly: runways keyed on an identifier the runway layer does not carry, giving
 * a region with no airfields at all; and coastline chains closed one at a time
 * instead of as a set, which reported New York as 99.3% land and drew triangular
 * wedges of sea through Westchester. Both were silent. Both are now assertions here.
 *
 * ## What is safe to assert, and what is not
 *
 * Nothing here compares against a coordinate recalled from memory. Doing that is how
 * a correct region gets "fixed" to match a misremembered landmark, and it happened
 * twice during the build — Bennett Park and the Upper Bay were both checked against
 * coordinates that turned out to be somewhere else, and the data was right each time.
 *
 * So the assertions come from three places that cannot be got wrong by recall:
 * the manifest's own airfields, which are FAA records; geometry that is true by
 * construction, like the region's south-east corner being fifty kilometres out in
 * the Atlantic; and cross-source agreement, where OpenStreetMap says what is water
 * and USGS says how high it is, and the two were assembled independently.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RegionSource, type RegionManifest } from '../src/terrain/region.js'
import { RUNWAY_SURFACE_OFFSET_M, Surface } from '../src/terrain/source.js'
import { GeoFrame } from '../src/terrain/geo.js'

const dir = fileURLToPath(new URL('../public/regions/', import.meta.url))
const manifest = JSON.parse(readFileSync(`${dir}new-york.json`, 'utf8')) as RegionManifest
const bytes = readFileSync(`${dir}new-york.bin`)
const blob = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

const region = new RegionSource(manifest, blob)
const frame = new GeoFrame(manifest.origin)

/** Surface class at a latitude and longitude. */
const classAt = (lat: number, lon: number): Surface => {
  const p = frame.toWorld(lat, lon)
  return region.sample(p.x, p.z).surface
}

describe('the region loads at all', () => {
  it('is New York, at the stated origin and size', () => {
    expect(manifest.id).toBe('new-york')
    expect(region.extent).toBe(55_560)
    // LaGuardia. If the origin moves, every coordinate below means somewhere else.
    expect(manifest.origin.lat).toBeCloseTo(40.7772, 4)
    expect(manifest.origin.lon).toBeCloseTo(-73.8726, 4)
  })

  it('carries the licence obligations it inherited', () => {
    // OpenStreetMap is ODbL: derived data carries the requirement wherever it goes,
    // so this rides in the manifest rather than in a README that can be left behind.
    const all = manifest.attribution.join(' ')
    expect(all).toMatch(/OpenStreetMap/)
    expect(all).toMatch(/ODbL/)
    expect(all).toMatch(/USGS/)
    expect(all).toMatch(/FAA/)
  })

  it('uses only surface classes the enum names', () => {
    const known = new Set([
      Surface.Water, Surface.Land, Surface.City, Surface.Runway,
      Surface.Forest, Surface.Grass, Surface.Sand, Surface.Suburb,
    ])
    const seen = new Set<number>()
    for (let x = -region.extent; x <= region.extent; x += 2_000) {
      for (let z = -region.extent; z <= region.extent; z += 2_000) {
        seen.add(region.sample(x, z).surface)
      }
    }
    for (const value of seen) expect(known).toContain(value)
    // A region that came back as one class everywhere would pass every check above.
    expect(seen.size).toBeGreaterThanOrEqual(6)
  })
})

describe('airfields', () => {
  // The join between the FAA's runway layer and its airport layer is on a GUID, not
  // on an identifier. Getting it wrong produced a region with zero airfields, and
  // every other assertion in this file still passed.
  it('found the airports that are actually there', () => {
    expect(region.airfields.length).toBeGreaterThanOrEqual(15)
    const icaos = new Set(manifest.airfields.map((f) => f.icao))
    for (const expected of ['KJFK', 'KLGA', 'KEWR', 'KTEB']) {
      expect(icaos).toContain(expected)
    }
  })

  it('quotes a source for every runway, because they are all [V] values', () => {
    for (const f of manifest.airfields) {
      expect(f.source).toMatch(/FAA/)
      expect(f.elevationM).toBeGreaterThan(-10)
      expect(f.lengthM).toBeGreaterThan(900)
      expect(f.widthM).toBeGreaterThan(15)
    }
  })

  it('agrees with the FAA on the runways whose numbers are published', () => {
    const byName = new Map(manifest.airfields.map((f) => [f.name, f]))

    // LaGuardia 13/31: 7,002 ft by 150 ft.
    const lga = byName.get('Laguardia 13/31')!
    expect(lga.lengthM).toBeCloseTo(7002 * 0.3048, 1)
    expect(lga.widthM).toBeCloseTo(150 * 0.3048, 1)
    // Heading is measured from the FAA runway polygon, not read off the designator.
    // 122.1 degrees true is about 135 magnetic here, which would be painted "14" —
    // the number on the asphalt is rounded and was assigned under a different
    // magnetic variation, which is exactly why it is not the source.
    expect(lga.headingDeg).toBeCloseTo(122.1, 0)

    // Kennedy 13R/31L is the longest runway in the region: 14,511 ft.
    const jfk = byName.get('John F Kennedy Intl 13R/31L')!
    expect(jfk.lengthM).toBeCloseTo(14511 * 0.3048, 1)
  })

  it('puts every runway on land, not in the water', () => {
    // Three seaplane lanes reached this list once, two of them in Jamaica Bay. The
    // builder flattens terrain to a runway's elevation and the physics gives a
    // runway paved grip, so a water lane is a square kilometre of bay you can land
    // a fighter on.
    for (const f of manifest.airfields) {
      expect(classAt(f.lat, f.lon)).not.toBe(Surface.Water)
    }
  })

  it('flattens the ground under each runway to its published elevation', () => {
    // The elevation model and the FAA disagree, and not slightly: USGS puts
    // LaGuardia's apron at -1.62 m against a published field elevation of 6.31 m.
    // Shipping that unflattened is a runway laid across eight metres of slope.
    for (const f of manifest.airfields) {
      const p = frame.toWorld(f.lat, f.lon)
      expect(region.height(p.x, p.z)).toBeCloseTo(f.elevationM, 0)
    }
  })

  it('leaves no step at the runway edge for a wheel to hit', () => {
    // The lesson of Day 3, kept: a 60 cm lip cost 12 g on a gentle landing. The
    // strip is lifted 12 cm and ramped out, and the ground it ramps onto has to be
    // flat for that to work.
    const f = manifest.airfields.find((a) => a.icao === 'KJFK')!
    const p = frame.toWorld(f.lat, f.lon)
    const heading = (f.headingDeg - frame.convergenceDeg(f.lat, f.lon)) * (Math.PI / 180)

    // Step across the runway edge, in one-metre increments through the threshold.
    const across = (d: number) => {
      const x = p.x + d * Math.cos(heading)
      const z = p.z + d * Math.sin(heading)
      return region.surfaceHeight(x, z)
    }
    let worst = 0
    for (let d = 0; d < 200; d++) worst = Math.max(worst, Math.abs(across(d + 1) - across(d)))
    expect(worst).toBeLessThan(0.02)

    // And the strip itself stands exactly the documented amount above the ground.
    expect(region.surfaceHeight(p.x, p.z) - region.height(p.x, p.z)).toBeCloseTo(
      RUNWAY_SURFACE_OFFSET_M, 6,
    )
  })
})

describe('land and water', () => {
  it('is water out in the Atlantic', () => {
    // True by construction rather than by recall: the region's south-east corner is
    // 55 km east and 55 km south of LaGuardia, which is open ocean well south of
    // Long Island's shore. No landmark, and nothing to misremember.
    expect(region.sample(region.extent - 500, region.extent - 500).surface).toBe(Surface.Water)
    expect(region.sample(0, region.extent - 500).surface).toBe(Surface.Water)
  })

  it('is not one class everywhere, in either direction', () => {
    // The two coastline bugs both showed up here first: one made the region 99.3%
    // land, the other flooded Westchester. A real coastal region is neither.
    let water = 0
    let total = 0
    for (let x = -region.extent; x <= region.extent; x += 1_000) {
      for (let z = -region.extent; z <= region.extent; z += 1_000) {
        if (region.sample(x, z).surface === Surface.Water) water++
        total++
      }
    }
    const fraction = water / total
    expect(fraction).toBeGreaterThan(0.2)
    expect(fraction).toBeLessThan(0.55)
  })

  it('agrees with USGS about which parts are wet', () => {
    // Cross-source, and the strongest check here. OpenStreetMap decided what is
    // water; USGS decided how high the ground is; the two were assembled from
    // different downloads by different code. If the coastline were inverted or
    // offset, water would sit on hillsides — so this is a real test of the fill,
    // not a restatement of it.
    const heights: number[] = []
    for (let x = -region.extent; x <= region.extent; x += 1_000) {
      for (let z = -region.extent; z <= region.extent; z += 1_000) {
        if (region.sample(x, z).surface === Surface.Water) heights.push(region.height(x, z))
      }
    }
    heights.sort((a, b) => a - b)
    const median = heights[Math.floor(heights.length / 2)]!
    expect(median).toBeGreaterThan(-2)
    expect(median).toBeLessThan(2)

    // Reservoirs in the New Jersey and Westchester highlands are genuinely high, so
    // this allows a tail rather than requiring every water cell to be at sea level.
    const high = heights.filter((h) => h > 30).length
    expect(high / heights.length).toBeLessThan(0.1)
  })
})

describe('the city', () => {
  it('has a skyline rather than a city plan', () => {
    const buildings = region.buildings()
    expect(buildings.length).toBeGreaterThan(5_000)
    // Over a million footprints exist in this box. Shipping them is not the goal.
    expect(buildings.length).toBeLessThan(60_000)

    for (const b of buildings) {
      expect(Math.abs(b.x)).toBeLessThanOrEqual(region.extent)
      expect(Math.abs(b.z)).toBeLessThanOrEqual(region.extent)
      expect(b.heightM).toBeGreaterThanOrEqual(20)
      // Taller than any building on earth means a mis-parsed height tag.
      expect(b.heightM).toBeLessThan(900)
      expect(b.halfLengthM).toBeGreaterThan(0)
      expect(b.halfWidthM).toBeGreaterThan(0)
    }
  })

  it('keeps the tallest buildings where the dense ground is', () => {
    const tallest = region.buildings()
      .slice()
      .sort((a, b) => b.heightM - a.heightM)
      .slice(0, 100)

    const inCity = tallest.filter((b) => region.sample(b.x, b.z).surface === Surface.City)
    expect(inCity.length).toBeGreaterThan(80)
  })

  it('does not build on the water', () => {
    const wet = region.buildings().filter((b) => region.sample(b.x, b.z).surface === Surface.Water)
    expect(wet.length / region.buildings().length).toBeLessThan(0.01)
  })
})
