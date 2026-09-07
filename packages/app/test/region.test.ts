/**
 * The real-world region source.
 *
 * Everything here is built in memory: a manifest, a blob, a known height function. No
 * file, no browser, no city. What is being checked is the machinery — tier selection,
 * bilinear sampling, the runway lift, the projection of quoted airfield coordinates —
 * because those are the parts that will be wrong silently once real data arrives and
 * nobody can tell a subtly mis-sampled Manhattan from a correct one by looking at it.
 */

import { describe, expect, it } from 'vitest'
import { RegionSource, type RegionManifest } from '../src/terrain/region.js'
import { RUNWAY_RAMP_M, RUNWAY_SURFACE_OFFSET_M, Surface } from '../src/terrain/source.js'
import { GeoFrame } from '../src/terrain/geo.js'

const ORIGIN = { lat: 40.7772, lon: -73.8726 }
const HEIGHT_SCALE = 0.25

/** Align a byte offset up to `n`, which typed-array views require. */
const align = (v: number, n: number): number => Math.ceil(v / n) * n

interface TierSpec {
  cells: number
  cellM: number
  centreX?: number
  centreZ?: number
  /** Metres, sampled at each grid point. */
  height: (x: number, z: number) => number
}

/** Build a manifest and blob the way the offline tool eventually will. */
function buildRegion(o: {
  tiers: TierSpec[]
  surfaceCells?: number
  surfaceCellM?: number
  surfaceAt?: (x: number, z: number) => Surface
  airfields?: RegionManifest['airfields']
  buildings?: number[][]
}): { manifest: RegionManifest; blob: ArrayBuffer } {
  const surfaceCells = o.surfaceCells ?? 8
  const surfaceCellM = o.surfaceCellM ?? 1_000
  const buildings = o.buildings ?? []

  // Lay the sections out, aligned, and record where each landed.
  let cursor = 0
  const tierOffsets: number[] = []
  for (const t of o.tiers) {
    cursor = align(cursor, 4)
    tierOffsets.push(cursor)
    cursor += t.cells * t.cells * 2
  }
  cursor = align(cursor, 4)
  const surfaceOffset = cursor
  cursor += surfaceCells * surfaceCells
  cursor = align(cursor, 4)
  const buildingOffset = cursor
  cursor += buildings.length * 6 * 4

  const blob = new ArrayBuffer(align(cursor, 4))

  o.tiers.forEach((t, i) => {
    const half = ((t.cells - 1) * t.cellM) / 2
    const cx = t.centreX ?? 0
    const cz = t.centreZ ?? 0
    const view = new Int16Array(blob, tierOffsets[i] as number, t.cells * t.cells)
    for (let iv = 0; iv < t.cells; iv++) {
      for (let iu = 0; iu < t.cells; iu++) {
        const x = cx - half + iu * t.cellM
        const z = cz - half + iv * t.cellM
        view[iv * t.cells + iu] = Math.round(t.height(x, z) / HEIGHT_SCALE)
      }
    }
  })

  const surfaceHalf = ((surfaceCells - 1) * surfaceCellM) / 2
  const surfaceView = new Uint8Array(blob, surfaceOffset, surfaceCells * surfaceCells)
  for (let iv = 0; iv < surfaceCells; iv++) {
    for (let iu = 0; iu < surfaceCells; iu++) {
      const x = -surfaceHalf + iu * surfaceCellM
      const z = -surfaceHalf + iv * surfaceCellM
      surfaceView[iv * surfaceCells + iu] = o.surfaceAt ? o.surfaceAt(x, z) : Surface.Land
    }
  }

  const buildingView = new Float32Array(blob, buildingOffset, buildings.length * 6)
  buildings.forEach((b, i) => buildingView.set(b, i * 6))

  const manifest: RegionManifest = {
    format: 1,
    id: 'test',
    name: 'Test Region',
    origin: ORIGIN,
    extentM: 55_560,
    heightScaleM: HEIGHT_SCALE,
    tiers: o.tiers.map((t, i) => ({
      cells: t.cells,
      cellM: t.cellM,
      centreX: t.centreX ?? 0,
      centreZ: t.centreZ ?? 0,
      byteOffset: tierOffsets[i] as number,
    })),
    surface: {
      cells: surfaceCells,
      cellM: surfaceCellM,
      centreX: 0,
      centreZ: 0,
      byteOffset: surfaceOffset,
    },
    buildings: { count: buildings.length, byteOffset: buildingOffset },
    airfields: o.airfields ?? [],
    attribution: ['test'],
  }

  return { manifest, blob }
}

describe('elevation', () => {
  it('reads back a plane it was given, between the samples as well as on them', () => {
    // A tilted plane is the one surface bilinear interpolation must reproduce exactly,
    // so any error is the sampler's rather than the data's.
    const plane = (x: number, z: number): number => 100 + x * 0.01 + z * 0.02
    const { manifest, blob } = buildRegion({
      tiers: [{ cells: 65, cellM: 500, height: plane }],
    })
    const region = new RegionSource(manifest, blob)

    for (const [x, z] of [[0, 0], [250, 250], [-1_337, 940], [7_000, -3_000]] as const) {
      // Tolerance is the Int16 quantum, not an arbitrary epsilon.
      expect(region.height(x, z)).toBeCloseTo(plane(x, z), 1)
    }
  })

  it('prefers the finest tier that contains the point', () => {
    const { manifest, blob } = buildRegion({
      tiers: [
        { cells: 33, cellM: 100, height: () => 500 },
        { cells: 33, cellM: 2_000, height: () => 10 },
      ],
    })
    const region = new RegionSource(manifest, blob)

    // Inside the fine tier (half-width 1,600 m) the fine answer wins.
    expect(region.height(0, 0)).toBeCloseTo(500, 1)
    // Outside it, the coarse tier answers.
    expect(region.height(20_000, 0)).toBeCloseTo(10, 1)
  })

  it('answers beyond the coarsest tier rather than failing', () => {
    // The outermost LOD ring reaches past the map every frame, so this is the normal
    // case and not an error one.
    const { manifest, blob } = buildRegion({ tiers: [{ cells: 9, cellM: 1_000, height: () => 42 }] })
    const region = new RegionSource(manifest, blob)
    expect(region.height(500_000, -500_000)).toBeCloseTo(42, 1)
  })

  it('refuses a manifest whose tiers are not finest first', () => {
    const { manifest, blob } = buildRegion({
      tiers: [
        { cells: 9, cellM: 2_000, height: () => 1 },
        { cells: 9, cellM: 100, height: () => 2 },
      ],
    })
    // Silently answering everything from the coarsest grid would look merely blurry.
    expect(() => new RegionSource(manifest, blob)).toThrow(/finest first/)
  })

  it('refuses a format it does not understand', () => {
    const { manifest, blob } = buildRegion({ tiers: [{ cells: 9, cellM: 1_000, height: () => 0 }] })
    expect(() => new RegionSource({ ...manifest, format: 2 as 1 }, blob)).toThrow(/format/)
  })
})

describe('airfields', () => {
  const frame = new GeoFrame(ORIGIN)
  const airfield: RegionManifest['airfields'][number] = {
    name: 'Test Field',
    icao: 'TEST',
    // A little north-east of the origin, so both axes are exercised.
    lat: ORIGIN.lat + 0.02,
    lon: ORIGIN.lon + 0.03,
    elevationM: 6.4,
    headingDeg: 40,
    lengthM: 2_100,
    widthM: 45,
    source: 'test',
  }

  const { manifest, blob } = buildRegion({
    tiers: [{ cells: 65, cellM: 500, height: () => 6.4 }],
    airfields: [airfield],
  })
  const region = new RegionSource(manifest, blob)

  it('projects quoted coordinates into the world exactly once', () => {
    const expected = frame.toWorld(airfield.lat, airfield.lon)
    expect(region.airfields[0]!.x).toBeCloseTo(expected.x, 6)
    expect(region.airfields[0]!.z).toBeCloseTo(expected.z, 6)
    expect(region.airfields[0]!.z).toBeLessThan(0) // north of the origin
    expect(region.airfields[0]!.x).toBeGreaterThan(0) // east of it
  })

  it('corrects a true heading into the local frame', () => {
    const convergence = frame.convergenceDeg(airfield.lat, airfield.lon)
    expect(region.airfields[0]!.headingDeg).toBeCloseTo(40 - convergence, 9)
    // Small, but real, and in the direction that makes local north lag true north
    // east of the origin.
    expect(Math.abs(convergence)).toBeGreaterThan(0.0001)
    expect(Math.abs(convergence)).toBeLessThan(0.05)
  })

  it('lifts the strip and ramps the lift away, with no step at the edge', () => {
    const f = region.airfields[0]!
    const base = region.height(f.x, f.z)

    // On the strip: the full lift.
    expect(region.surfaceHeight(f.x, f.z) - base).toBeCloseTo(RUNWAY_SURFACE_OFFSET_M, 9)

    // Well outside the apron: none of it.
    const farX = f.x + 2_000
    expect(region.surfaceHeight(farX, f.z) - region.height(farX, f.z)).toBeCloseTo(0, 9)

    // And across the edge, no step: the largest jump over a 1 m walk stays far below
    // the 0.6 m kerb that once cost 12 g on a gentle landing.
    let worst = 0
    const walkZ = (d: number): number => region.surfaceHeight(f.x, f.z + f.widthM / 2 + d)
    let previous = walkZ(-RUNWAY_RAMP_M - 5)
    for (let d = -RUNWAY_RAMP_M - 4; d <= RUNWAY_RAMP_M + 5; d += 1) {
      const here = walkZ(d)
      worst = Math.max(worst, Math.abs(here - previous))
      previous = here
    }
    expect(worst).toBeLessThan(0.02)
  })

  it('reports the strip as runway, and elsewhere from the raster', () => {
    const f = region.airfields[0]!
    expect(region.sample(f.x, f.z).surface).toBe(Surface.Runway)
    expect(region.sample(f.x + 20_000, f.z).surface).toBe(Surface.Land)
  })
})

describe('surface classes and buildings', () => {
  it('reads the raster without smearing one class into another', () => {
    // Nearest-neighbour, not bilinear: averaging Water(0) and City(2) would produce
    // Land(1) along every shoreline in the region.
    const { manifest, blob } = buildRegion({
      tiers: [{ cells: 9, cellM: 1_000, height: () => 0 }],
      surfaceCells: 8,
      surfaceCellM: 1_000,
      surfaceAt: (x) => (x < 0 ? Surface.Water : Surface.City),
    })
    const region = new RegionSource(manifest, blob)

    expect(region.sample(-2_000, 0).surface).toBe(Surface.Water)
    expect(region.sample(2_000, 0).surface).toBe(Surface.City)
    for (let x = -3_000; x <= 3_000; x += 100) {
      expect([Surface.Water, Surface.City]).toContain(region.sample(x, 0).surface)
    }
  })

  it('round-trips building instances', () => {
    const { manifest, blob } = buildRegion({
      tiers: [{ cells: 9, cellM: 1_000, height: () => 0 }],
      buildings: [
        [100, -200, 15, 12, 33, 120],
        [-4_000, 900, 40, 40, 0, 381],
      ],
    })
    const region = new RegionSource(manifest, blob)
    const b = region.buildings()

    expect(b).toHaveLength(2)
    expect(b[0]!.x).toBeCloseTo(100, 3)
    expect(b[0]!.heightM).toBeCloseTo(120, 3)
    expect(b[1]!.halfLengthM).toBeCloseTo(40, 3)
    expect(b[1]!.heightM).toBeCloseTo(381, 3)
  })
})
