/**
 * A real-world region, behind the §8.2 terrain seam.
 *
 * This is the swap `REQUIREMENTS.md` §7 promised: "real elevation data is explicitly
 * out of MVP scope and is a later swap behind the terrain-source interface". It is a
 * new file rather than a rewrite because `authoredMap` is exported *typed as*
 * `TerrainSource`, so the compiler has been forbidding anyone from reaching past the
 * interface since Day 2. Nothing in `mesh.ts`, `scatter.ts`, `city.ts`, `course.ts` or
 * `groundSource.ts` changes to accept one of these.
 *
 * ## What a region is made of
 *
 * A JSON manifest and one binary blob, built offline and committed, the same bargain
 * the physics package makes with its golden fixtures: the generator needs Python, the
 * repository needs only Node, and CI stays hermetic.
 *
 * The split between them is deliberate and is about **review**, not about size:
 *
 * - The manifest holds anything a human should be able to check in a diff — above
 *   all the airfields, whose runway headings, lengths and elevations are `[V]` values
 *   quoted from a source and therefore must be legible in the tree rather than buried
 *   in a blob. It also carries the provenance and attribution, in the data rather
 *   than bolted on beside it, because an OpenStreetMap-derived region carries a
 *   licence obligation wherever it goes.
 * - The blob holds the rasters and the buildings: hundreds of thousands of numbers
 *   nobody will ever read, where a diff is noise and bytes matter.
 *
 * ## Tiers, rather than one grid
 *
 * Elevation arrives as a list of tiers, each a square grid at its own resolution and
 * its own centre, finest first. `height()` answers from the finest tier that contains
 * the point. One tier at a useful resolution across a 111 km region is several
 * million samples; a fine tier over the part being flown plus a coarse one over the
 * rest is a fraction of that for the same picture.
 *
 * The list is open-ended on purpose. Shipping with a single tier and adding a finer
 * one later is a data change, not a format change, which is what keeps the first
 * region from having to guess the right resolution before anyone has seen it.
 *
 * ## What this file must not do
 *
 * No three.js, and no fetching. It takes an `ArrayBuffer` that somebody else loaded,
 * so a region can be built and interrogated in Node — which is what lets the tests
 * below check a projection, a heightfield and a runway without a browser.
 */

import { GeoFrame, type LatLon } from './geo.js'
import {
  Surface,
  onRunway,
  runwayLift,
  type Airfield,
  type BuildingInstance,
  type Bridge,
  type Landmark,
  type Place,
  type TerrainSample,
  type TerrainSource,
} from './source.js'

export type { Bridge, BuildingInstance, Landmark, Place }

/** One elevation grid. Square, axis-aligned, centred anywhere in the region. */
export interface TerrainTier {
  /** Samples along one side. The grid is `cells x cells`. */
  cells: number
  /** Metres between adjacent samples. */
  cellM: number
  /** Centre of the grid in world metres. */
  centreX: number
  centreZ: number
  /** Byte offset of this tier's `Int16` samples within the blob. */
  byteOffset: number
}

/** The surface-class raster: what is land, water and city. Runways come from geometry. */
export interface SurfaceRaster {
  cells: number
  cellM: number
  centreX: number
  centreZ: number
  byteOffset: number
}

/** An airfield as it is written down, in the terms a source quotes it in. */
export interface RegionAirfield {
  name: string
  /** ICAO identifier, where there is one. */
  icao?: string
  /** Runway midpoint. */
  lat: number
  lon: number
  /** Field elevation, metres above mean sea level. `[V]` */
  elevationM: number
  /** Runway heading, degrees TRUE — not magnetic, and not the painted number. `[V]` */
  headingDeg: number
  lengthM: number
  widthM: number
  /** Where these numbers came from. Required: they are all `[V]`. */
  source: string
}

export interface RegionManifest {
  /** Format version. Bumped when the blob layout changes in a way old code misreads. */
  format: 1
  id: string
  name: string
  /** The geodetic origin of the local frame. World (0, 0) is here. */
  origin: LatLon
  /** Half-width of the region, metres. */
  extentM: number
  /**
   * Metres per `Int16` step in the elevation tiers.
   *
   * At 0.25 the representable range is +/- 8,191 m, which covers every landform on
   * Earth, and the quantisation is a quarter of a metre — an order of magnitude below
   * anything the terrain mesh can show.
   */
  heightScaleM: number
  /** Finest first. `height()` relies on this ordering. */
  tiers: TerrainTier[]
  surface: SurfaceRaster
  buildings: { count: number; byteOffset: number }
  airfields: RegionAirfield[]
  /**
   * Named places, for labelling a map. Ranked, most prominent first.
   *
   * In the manifest rather than the blob because they are names: a diff that shows
   * "Newark" moving is worth reading, and two hundred and fifty of them cost less
   * than a tenth of what one elevation tier does.
   */
  places?: { name: string; lat: number; lon: number; rank: number }[]
  /** Notable named features. Points, in the terms a source names them. */
  landmarks?: { name: string; lat: number; lon: number; kind: string; heightM?: number }[]
  /** Bridges, as `[lat, lon]` centrelines. */
  bridges?: { name: string; points: [number, number][]; widthM: number; lengthM: number }[]
  /** Licence and provenance lines, rendered wherever the region is. */
  attribution: string[]
}

/** Floats per building in the blob: x, z, halfLength, halfWidth, heading, height. */
const BUILDING_STRIDE = 6

export class RegionSource implements TerrainSource {
  readonly extent: number
  readonly airfields: readonly Airfield[]
  readonly places: readonly Place[]
  readonly landmarks: readonly Landmark[]
  readonly bridges: readonly Bridge[]
  readonly frame: GeoFrame

  private readonly tiers: { tier: TerrainTier; data: Int16Array; half: number }[]
  private readonly surfaceRaster: { raster: SurfaceRaster; data: Uint8Array; half: number }
  private readonly buildingData: Float32Array

  constructor(
    readonly manifest: RegionManifest,
    blob: ArrayBuffer,
  ) {
    if (manifest.format !== 1) {
      throw new Error(`region "${manifest.id}": unsupported format ${manifest.format}`)
    }

    this.extent = manifest.extentM
    this.frame = new GeoFrame(manifest.origin)

    this.tiers = manifest.tiers.map((tier) => ({
      tier,
      data: new Int16Array(blob, tier.byteOffset, tier.cells * tier.cells),
      half: ((tier.cells - 1) * tier.cellM) / 2,
    }))

    // Finest first is a load-bearing assumption in `height()`, so it is checked here
    // rather than trusted — a manifest written in the wrong order would silently
    // answer every query from the coarsest grid and look merely blurry.
    for (let i = 1; i < this.tiers.length; i++) {
      if ((this.tiers[i]!.tier.cellM) < (this.tiers[i - 1]!.tier.cellM)) {
        throw new Error(`region "${manifest.id}": tiers must be ordered finest first`)
      }
    }

    this.surfaceRaster = {
      raster: manifest.surface,
      data: new Uint8Array(blob, manifest.surface.byteOffset, manifest.surface.cells ** 2),
      half: ((manifest.surface.cells - 1) * manifest.surface.cellM) / 2,
    }

    this.buildingData = new Float32Array(
      blob,
      manifest.buildings.byteOffset,
      manifest.buildings.count * BUILDING_STRIDE,
    )

    // Projected once, here, for the same reason the airfields are: two callers
    // projecting the same coordinate is two chances to do it differently.
    this.places = (manifest.places ?? []).map((p) => {
      const w = this.frame.toWorld(p.lat, p.lon)
      return { name: p.name, x: w.x, z: w.z, rank: p.rank }
    })

    this.landmarks = (manifest.landmarks ?? []).map((m) => {
      const w = this.frame.toWorld(m.lat, m.lon)
      return {
        name: m.name,
        x: w.x,
        z: w.z,
        kind: m.kind,
        ...(m.heightM === undefined ? {} : { heightM: m.heightM }),
      }
    })

    this.bridges = (manifest.bridges ?? []).map((b) => ({
      name: b.name,
      points: b.points.map(([lat, lon]) => this.frame.toWorld(lat, lon)),
      widthM: b.widthM,
      lengthM: b.lengthM,
    }))

    // Airfields are quoted in latitude and longitude and used in metres. Converting
    // once, here, is what stops two callers projecting the same runway differently.
    this.airfields = manifest.airfields.map((f) => {
      const p = this.frame.toWorld(f.lat, f.lon)
      return {
        name: f.name,
        x: p.x,
        z: p.z,
        elevation: f.elevationM,
        // A heading quoted true, drawn in a local frame, differs from it by the
        // meridian convergence. It is a third of a degree at the edge of a region and
        // essentially nothing near the origin, but a runway is a long thin thing and
        // being able to name the correction is better than absorbing it.
        headingDeg: f.headingDeg - this.frame.convergenceDeg(f.lat, f.lon),
        lengthM: f.lengthM,
        widthM: f.widthM,
      }
    })
  }

  /** Bilinear sample of a grid, clamped at the edges. */
  private sampleGrid(
    data: Int16Array | Uint8Array,
    cells: number,
    cellM: number,
    centreX: number,
    centreZ: number,
    half: number,
    x: number,
    z: number,
    nearest: boolean,
  ): number {
    const u = (x - (centreX - half)) / cellM
    const v = (z - (centreZ - half)) / cellM

    if (nearest) {
      const iu = Math.min(cells - 1, Math.max(0, Math.round(u)))
      const iv = Math.min(cells - 1, Math.max(0, Math.round(v)))
      return data[iv * cells + iu] as number
    }

    const cu = Math.min(cells - 1.0001, Math.max(0, u))
    const cv = Math.min(cells - 1.0001, Math.max(0, v))
    const u0 = Math.floor(cu)
    const v0 = Math.floor(cv)
    const fu = cu - u0
    const fv = cv - v0

    const i00 = v0 * cells + u0
    const h00 = data[i00] as number
    const h10 = data[i00 + 1] as number
    const h01 = data[i00 + cells] as number
    const h11 = data[i00 + cells + 1] as number

    const a = h00 + (h10 - h00) * fu
    const b = h01 + (h11 - h01) * fu
    return a + (b - a) * fv
  }

  height(x: number, z: number): number {
    for (const { tier, data, half } of this.tiers) {
      if (
        x >= tier.centreX - half &&
        x <= tier.centreX + half &&
        z >= tier.centreZ - half &&
        z <= tier.centreZ + half
      ) {
        return (
          this.sampleGrid(
            data, tier.cells, tier.cellM, tier.centreX, tier.centreZ, half, x, z, false,
          ) * this.manifest.heightScaleM
        )
      }
    }

    // Outside every tier: clamp against the coarsest, which covers the region. The
    // mesh's outermost LOD ring reaches beyond the map on purpose, so this is asked
    // for on every frame rather than being an error case.
    const last = this.tiers[this.tiers.length - 1]
    if (!last) return 0
    return (
      this.sampleGrid(
        last.data, last.tier.cells, last.tier.cellM,
        last.tier.centreX, last.tier.centreZ, last.half, x, z, false,
      ) * this.manifest.heightScaleM
    )
  }

  surfaceHeight(x: number, z: number): number {
    return this.height(x, z) + runwayLift(x, z, this.airfields)
  }

  sample(x: number, z: number): TerrainSample {
    const height = this.height(x, z)

    // Runways come from the airfield rectangles rather than from the raster, so that
    // what the wheels roll on and what `surfaceHeight` lifts are the same shape. A
    // rasterised runway would disagree with the lift at its edge by up to a cell.
    if (onRunway(x, z, this.airfields)) return { height, surface: Surface.Runway }

    const { raster, data, half } = this.surfaceRaster
    const cls = this.sampleGrid(
      data, raster.cells, raster.cellM, raster.centreX, raster.centreZ, half, x, z, true,
    )
    return { height, surface: cls as Surface }
  }

  /** Every building in the region. Read once by the renderer, never per frame. */
  buildings(): BuildingInstance[] {
    const out: BuildingInstance[] = []
    for (let i = 0; i < this.manifest.buildings.count; i++) {
      const o = i * BUILDING_STRIDE
      out.push({
        x: this.buildingData[o] as number,
        z: this.buildingData[o + 1] as number,
        halfLengthM: this.buildingData[o + 2] as number,
        halfWidthM: this.buildingData[o + 3] as number,
        headingDeg: this.buildingData[o + 4] as number,
        heightM: this.buildingData[o + 5] as number,
      })
    }
    return out
  }
}
