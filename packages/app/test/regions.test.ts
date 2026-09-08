/**
 * The committed regions, read back through the seam that will serve them.
 *
 * `region.test.ts` checks the machinery on synthetic data — tier selection, bilinear
 * sampling, the runway lift — using a manifest and blob built in memory. This file
 * checks the opposite thing: that the **real** data, produced by
 * `tools/build_region.py` from USGS, OpenStreetMap and the FAA and committed to the
 * tree, is what it claims to be.
 *
 * It has to exist because every failure the builder had was of a kind no unit test
 * would have caught. All five produced files that parsed perfectly:
 *
 * - Runways keyed on an identifier the FAA's runway layer does not carry, giving a
 *   region with no airfields at all.
 * - Coastline chains closed one at a time instead of as a set, reporting New York as
 *   99.3% land with wedges of sea through Westchester.
 * - Chains joined in one direction only, so whether two ways merged depended on
 *   iteration order and ends were left dangling in open country.
 * - Three seaplane lanes admitted as runways, two of them in Jamaica Bay.
 * - Multipolygon members treated as individual rings, which is right for a park and
 *   catastrophic for a lake: Lake Michigan has 743 outer members and not one of them
 *   is closed, so Chicago came out 2.9% water.
 *
 * ## Two regions, on purpose
 *
 * New York and Chicago exercise opposite paths and neither alone is a test of the
 * builder. New York is bounded by `natural=coastline`, which has to be assembled and
 * closed against the region edge. Chicago has **no coastline at all** — the tag is
 * for the sea, and the Great Lakes are ordinary water polygons — so it falls through
 * to land-everywhere and paints Lake Michigan as inland water. The lake bug was
 * invisible in New York and obvious in Chicago.
 *
 * ## What is safe to assert
 *
 * Nothing here compares against a coordinate recalled from memory. That is how a
 * correct region gets "fixed" to match a misremembered landmark, and it nearly
 * happened twice during the build — Bennett Park and the Upper Bay were both checked
 * against coordinates that turned out to be somewhere else, and the data was right
 * both times.
 *
 * So the assertions come from three places that cannot be got wrong by recall: the
 * manifest's own airfields, which are FAA records; geometry true by construction,
 * like a region corner being fifty kilometres out to sea; and cross-source
 * agreement, where OpenStreetMap decides what is water and USGS decides how high it
 * is, from separate downloads through separate code.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RegionSource, type RegionManifest } from '../src/terrain/region.js'
import { RUNWAY_SURFACE_OFFSET_M, Surface } from '../src/terrain/source.js'
import { GeoFrame } from '../src/terrain/geo.js'

const load = (id: string) => {
  const dir = fileURLToPath(new URL('../public/regions/', import.meta.url))
  const manifest = JSON.parse(readFileSync(`${dir}${id}.json`, 'utf8')) as RegionManifest
  const bytes = readFileSync(`${dir}${id}.bin`)
  const blob = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return { manifest, region: new RegionSource(manifest, blob) }
}

const REGIONS = [
  { id: 'new-york', name: 'New York', icaos: ['KJFK', 'KLGA', 'KEWR', 'KTEB'] },
  { id: 'chicago', name: 'Chicago', icaos: ['KORD', 'KMDW'] },
] as const

/** Surface classes at every cell of the surface raster, at its own resolution. */
function surfaceGrid(manifest: RegionManifest, region: RegionSource): Uint8Array {
  const { cells, cellM, centreX, centreZ } = manifest.surface
  const half = ((cells - 1) * cellM) / 2
  const out = new Uint8Array(cells * cells)
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      out[j * cells + i] = region.sample(centreX - half + i * cellM, centreZ - half + j * cellM).surface
    }
  }
  return out
}

for (const spec of REGIONS) {
  describe(spec.name, () => {
    const { manifest, region } = load(spec.id)
    const frame = new GeoFrame(manifest.origin)

    it('loads, and is the region it says it is', () => {
      expect(manifest.format).toBe(1)
      expect(manifest.id).toBe(spec.id)
      expect(region.extent).toBe(55_560)
      expect(manifest.tiers.length).toBeGreaterThan(1)
    })

    it('carries the licence obligations it inherited', () => {
      // OpenStreetMap is ODbL and the requirement travels with derived data, which
      // is why it rides in the manifest rather than in a README a copied file leaves
      // behind.
      const all = manifest.attribution.join(' ')
      expect(all).toMatch(/OpenStreetMap/)
      expect(all).toMatch(/ODbL/)
      expect(all).toMatch(/USGS/)
      expect(all).toMatch(/FAA/)
    })

    it('uses only surface classes the enum names, and more than one of them', () => {
      const known = new Set<number>([
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
      // A region that came back one class everywhere would pass everything above.
      expect(seen.size).toBeGreaterThanOrEqual(5)
    })

    describe('airfields', () => {
      it('found the airports that are actually there', () => {
        // The FAA's runway layer joins to its airport layer on a GUID, not on an
        // identifier. Getting that wrong produced a region with zero airfields and
        // no error anywhere.
        expect(manifest.airfields.length).toBeGreaterThanOrEqual(10)
        const icaos = new Set(manifest.airfields.map((f) => f.icao))
        for (const expected of spec.icaos) expect(icaos).toContain(expected)
      })

      it('quotes a source for every runway, because they are all [V] values', () => {
        for (const f of manifest.airfields) {
          expect(f.source).toMatch(/FAA/)
          expect(f.lengthM).toBeGreaterThan(900)
          // Ten metres, not fifty: the small fields around Chicago include real
          // published 40-foot strips — Meadow Creek is 3,400 by 40 — and a bound set
          // from the majors would reject them as malformed. Below ten metres is not
          // a runway.
          expect(f.widthM).toBeGreaterThan(10)
          expect(f.headingDeg).toBeGreaterThanOrEqual(0)
          expect(f.headingDeg).toBeLessThan(360)
        }
      })

      it('puts every runway on land, not in the water', () => {
        // Three seaplane lanes reached this list once, two in Jamaica Bay. The
        // builder flattens terrain to a runway's elevation and `groundSource.ts`
        // gives runways paved grip, so a water lane is a square kilometre of bay you
        // can land a fighter on.
        for (const f of manifest.airfields) {
          const p = frame.toWorld(f.lat, f.lon)
          expect(region.sample(p.x, p.z).surface).not.toBe(Surface.Water)
        }
      })

      it('flattens the ground under each runway to its published elevation', () => {
        // The elevation model and the FAA disagree, and not slightly: USGS puts
        // LaGuardia's apron at -1.62 m against a published field elevation of
        // 6.31 m. Unflattened, that is a runway laid across eight metres of slope.
        for (const f of manifest.airfields) {
          const p = frame.toWorld(f.lat, f.lon)
          expect(region.height(p.x, p.z)).toBeCloseTo(f.elevationM, 0)
        }
      })

      it('leaves no step at a runway edge for a wheel to hit', () => {
        // The lesson of Day 3, kept: a 60 cm lip cost 12 g on a gentle landing.
        const f = manifest.airfields[0]!
        const p = frame.toWorld(f.lat, f.lon)
        const heading = (f.headingDeg - frame.convergenceDeg(f.lat, f.lon)) * (Math.PI / 180)

        let worst = 0
        const across = (d: number) =>
          region.surfaceHeight(p.x + d * Math.cos(heading), p.z + d * Math.sin(heading))
        for (let d = 0; d < 300; d++) worst = Math.max(worst, Math.abs(across(d + 1) - across(d)))
        expect(worst).toBeLessThan(0.02)

        // And the strip stands exactly the documented amount above the ground.
        expect(region.surfaceHeight(p.x, p.z) - region.height(p.x, p.z)).toBeCloseTo(
          RUNWAY_SURFACE_OFFSET_M, 6,
        )
      })
    })

    describe('land and water', () => {
      const grid = surfaceGrid(manifest, region)
      const { cells, cellM } = manifest.surface
      const half = ((cells - 1) * cellM) / 2

      it('is neither all land nor all sea', () => {
        // Both coastline bugs showed up here first: one made New York 99.3% land,
        // the other flooded Westchester. A real region is neither.
        let water = 0
        for (const value of grid) if (value === Surface.Water) water++
        const fraction = water / grid.length
        expect(fraction).toBeGreaterThan(0.15)
        expect(fraction).toBeLessThan(0.55)
      })

      it('has a coherent water surface, and it sits below the land', () => {
        // Cross-source, and the strongest check here. OpenStreetMap decided what is
        // water; USGS decided how high the ground is; they came from separate
        // downloads through separate code. Water is flat and water is low — if the
        // fill were inverted or offset, neither would hold.
        //
        // Deliberately *not* "water is near sea level". That is true of New York and
        // false of Chicago, whose water is Lake Michigan at 176 m — which is the
        // lake's real surface elevation, arrived at from the elevation model while
        // OpenStreetMap decided independently which cells were lake.
        const wet: number[] = []
        const dry: number[] = []
        for (let j = 0; j < cells; j += 3) {
          for (let i = 0; i < cells; i += 3) {
            const h = region.height(-half + i * cellM, -half + j * cellM)
            ;(grid[j * cells + i] === Surface.Water ? wet : dry).push(h)
          }
        }
        wet.sort((a, b) => a - b)
        dry.sort((a, b) => a - b)

        const at = (a: number[], q: number) => a[Math.floor(a.length * q)]!
        // Flat: a body of water has one surface level.
        expect(at(wet, 0.9) - at(wet, 0.1)).toBeLessThan(5)
        // Low: water does not sit above the land around it.
        expect(at(wet, 0.5)).toBeLessThanOrEqual(at(dry, 0.5))
      })

      it('is not speckled with stray water cells', () => {
        // A small number of land cells are missed by the coastline fill and stay
        // water — 0.4% of New York, 0.8% of Chicago, isolated and inland. They are
        // cosmetic at 120 m, but the bound exists so a regression that scatters the
        // map cannot pass as normal.
        let isolated = 0
        for (let j = 1; j < cells - 1; j++) {
          for (let i = 1; i < cells - 1; i++) {
            if (grid[j * cells + i] !== Surface.Water) continue
            let neighbours = 0
            for (let dj = -1; dj <= 1; dj++) {
              for (let di = -1; di <= 1; di++) {
                if ((di || dj) && grid[(j + dj) * cells + i + di] === Surface.Water) neighbours++
              }
            }
            if (neighbours <= 1) isolated++
          }
        }
        expect(isolated / grid.length).toBeLessThan(0.02)
      })
    })

    describe('places', () => {
      it('knows what things are called', () => {
        // The map is unusable without them: a real region is 111 km of ground that
        // all looks alike, and the airfields are the only other labelled thing in it.
        expect(manifest.places?.length ?? 0).toBeGreaterThan(150)
      })

      it('keeps a spread of kinds, not just the biggest', () => {
        // A flat cap on a rank-sorted list filled up on towns and kept no
        // neighbourhoods at all — which are the labels that matter over a city,
        // where every name for fifty kilometres is the same one.
        const ranks = new Set((manifest.places ?? []).map((p) => p.rank))
        expect(ranks.size).toBeGreaterThanOrEqual(4)
        expect(Math.min(...ranks)).toBe(0)
      })

      it('puts every place inside the region, with a name', () => {
        for (const p of region.places) {
          expect(p.name.length).toBeGreaterThan(0)
          expect(Math.abs(p.x)).toBeLessThanOrEqual(region.extent)
          expect(Math.abs(p.z)).toBeLessThanOrEqual(region.extent)
          expect(p.rank).toBeGreaterThanOrEqual(0)
        }
      })

      it('projects them the same way it projects everything else', () => {
        // One projection, used once, in the constructor. Two callers projecting the
        // same coordinate is two chances to do it differently.
        const first = manifest.places?.[0]
        expect(first).toBeDefined()
        const w = frame.toWorld(first!.lat, first!.lon)
        expect(region.places[0]!.x).toBeCloseTo(w.x, 6)
        expect(region.places[0]!.z).toBeCloseTo(w.z, 6)
      })
    })

    describe('buildings', () => {
      const buildings = region.buildings()

      it('is a skyline rather than a city plan', () => {
        expect(buildings.length).toBeGreaterThan(1_000)
        // Over a million footprints exist in the New York box alone.
        expect(buildings.length).toBeLessThan(60_000)

        for (const b of buildings) {
          expect(Math.abs(b.x)).toBeLessThanOrEqual(region.extent)
          expect(Math.abs(b.z)).toBeLessThanOrEqual(region.extent)
          expect(b.heightM).toBeGreaterThanOrEqual(20)
          // Taller than anything on earth means a mis-parsed height tag.
          expect(b.heightM).toBeLessThan(900)
          expect(b.halfLengthM).toBeGreaterThan(0)
          expect(b.halfWidthM).toBeGreaterThan(0)
        }
      })

      it('keeps the tallest buildings where the dense ground is', () => {
        const tallest = [...buildings].sort((a, b) => b.heightM - a.heightM).slice(0, 100)
        const inCity = tallest.filter((b) => region.sample(b.x, b.z).surface === Surface.City)
        expect(inCity.length).toBeGreaterThan(75)
      })

      it('does not build on the water', () => {
        const wet = buildings.filter((b) => region.sample(b.x, b.z).surface === Surface.Water)
        expect(wet.length / buildings.length).toBeLessThan(0.02)
      })
    })
  })
}

describe('New York, specifically', () => {
  const { manifest, region } = load('new-york')
  const byName = new Map(manifest.airfields.map((f) => [f.name, f]))

  it('agrees with the FAA on runways whose numbers are published', () => {
    // LaGuardia 13/31: 7,002 ft by 150 ft.
    const lga = byName.get('Laguardia 13/31')!
    expect(lga.lengthM).toBeCloseTo(7002 * 0.3048, 1)
    expect(lga.widthM).toBeCloseTo(150 * 0.3048, 1)

    // Heading measured from the FAA runway polygon, not read off the designator.
    // 122.1 true is about 135 magnetic here, which would be painted "14" — the
    // number on the asphalt is rounded to ten degrees and was assigned under a
    // different magnetic variation, which is exactly why it is not the source.
    expect(lga.headingDeg).toBeCloseTo(122.1, 0)

    // Kennedy 13R/31L, the longest runway in the region: 14,511 ft.
    expect(byName.get('John F Kennedy Intl 13R/31L')!.lengthM).toBeCloseTo(14511 * 0.3048, 1)
  })

  it('is open ocean at the south-east corner', () => {
    // True by construction, not by recall: 55 km east and 55 km south of LaGuardia
    // is well south of Long Island's shore.
    expect(region.sample(region.extent - 500, region.extent - 500).surface).toBe(Surface.Water)
    expect(region.sample(0, region.extent - 500).surface).toBe(Surface.Water)
  })
})

describe('Chicago, specifically', () => {
  const { manifest, region } = load('chicago')

  it('agrees with the FAA on Midway 13L/31R', () => {
    const mdw = manifest.airfields.find((f) => f.name === 'Chicago Midway Intl 13L/31R')
      ?? manifest.airfields.find((f) => f.icao === 'KMDW' && f.name.includes('13L'))
    expect(mdw).toBeDefined()
    expect(mdw!.lengthM).toBeCloseTo(6522 * 0.3048, 1)
  })

  it('has Lake Michigan to the east', () => {
    // The region's east edge is 55 km east of Midway, which is open lake. This is
    // the assertion the multipolygon bug failed: with members treated as individual
    // rings the lake rasterised to almost nothing and this was dry land.
    expect(region.sample(region.extent - 500, 0).surface).toBe(Surface.Water)
    expect(region.sample(region.extent - 500, -region.extent + 500).surface).toBe(Surface.Water)
  })

  it('puts the lake surface at its real elevation', () => {
    // Lake Michigan's surface is about 176 m above sea level. Nothing in the builder
    // knows that: OpenStreetMap said which cells are lake and USGS said how high
    // they are. The two agreeing on a number neither was told is the strongest
    // evidence available that the coastline and the elevation are in the same place.
    const heights: number[] = []
    for (let z = -20_000; z <= 20_000; z += 500) {
      const x = region.extent - 2_000
      if (region.sample(x, z).surface === Surface.Water) heights.push(region.height(x, z))
    }
    expect(heights.length).toBeGreaterThan(50)
    const mean = heights.reduce((a, b) => a + b, 0) / heights.length
    expect(mean).toBeGreaterThan(170)
    expect(mean).toBeLessThan(182)
  })
})
