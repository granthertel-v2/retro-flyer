/**
 * Terrain geometry: concentric LOD rings around the aircraft.
 *
 * ## The shape of the problem
 *
 * The map is 60 nm across (§7) and the aircraft crosses it in about four minutes.
 * Meshing all of it at a resolution that looks good at 500 ft would be tens of
 * millions of triangles, almost all of them beyond the fog. Meshing only what is
 * near means the ridge vanishes from thirty miles out, which is exactly the view
 * that makes a flight sim feel like one.
 *
 * So: six concentric square rings, each twice the extent and half the resolution of
 * the one inside it. Detail where it is looked at, coverage where it is not. Total
 * cost is about 39,000 triangles, which for a flat-shaded untextured world is
 * nothing.
 *
 * ## Non-indexed on purpose
 *
 * Every triangle gets its own three vertices and one flat colour. Indexed geometry
 * with vertex colours would blend colour across each face and give the smooth,
 * washed look this project is explicitly not going for (§ design thesis: crude on
 * purpose everywhere except the flight model). Non-indexed triples the vertex count
 * and costs nothing at this scale.
 *
 * ## Rebuild budget
 *
 * A ring rebuild is a few thousand `TerrainSource.sample()` calls, and the innermost
 * ring re-snaps every few hundred metres — several times a second at 500 knots.
 * Doing all six in one frame when they happen to coincide is a visible hitch, so
 * `update()` rebuilds at most one ring per frame, finest first. The coarse rings
 * move so rarely that being a frame or two late is invisible.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshLambertMaterial,
  Object3D,
} from 'three'
import { Surface, hash2, type TerrainSource } from './source.js'

/** Cells across each ring. Every ring uses the same count; only the cell size grows. */
const RES = 64

/** Cell size of the innermost ring, metres. */
const BASE_CELL = 60

/** Number of rings. Six doublings from 60 m reaches ~123 km — the whole map. */
const LEVELS = 6

/**
 * Cells of overlap between a ring's hole and the ring inside it.
 *
 * Each ring snaps to its own cell size, so two adjacent rings can be misaligned by
 * up to one coarse cell — and if the hole is cut to the exact size of the inner
 * ring, that misalignment is a **gap**. It shows as a dead-straight line of sea
 * running across the landscape a few kilometres out, which reads convincingly like a
 * river right up until you notice it is at a constant distance and turns when you do.
 *
 * One coarse cell of overlap covers the worst case. Overlap is harmless where a gap
 * is not, so this errs toward it.
 */
const HOLE_OVERLAP = 1

/**
 * Downward bias per LOD level, metres.
 *
 * With the rings overlapping, two different resolutions of the same ground occupy
 * the same depth and z-fight along the seam. Sinking each coarser ring slightly
 * settles it: the finer geometry always wins, and a 0.35 m step three kilometres
 * away is not a thing anyone will see.
 */
const LEVEL_BIAS = 0.35

const SNOW_LINE = 1_850
const ROCK_LINE = 1_150
const TREE_LINE = 520

/** Colour of the ground at a given height and surface type. */
function groundColour(out: Color, height: number, surface: Surface, jitter: number): void {
  switch (surface) {
    case Surface.Runway:
      out.setRGB(0.19, 0.19, 0.21)
      break

    case Surface.City:
      out.setRGB(0.34, 0.33, 0.31)
      break

    // Land cover, for regions built from real data. These are flat colours rather
    // than height ramps on purpose: a real city has a hundred metres of relief
    // across the whole map, so anything driven by altitude collapses to one shade.
    // What separates them is hue, and hue survives being seen from three miles up.
    case Surface.Forest:
      // Darker and bluer than the open-ground green, which is what makes a park
      // read as a park from the pattern rather than as a slightly different field.
      out.setRGB(0.13, 0.22, 0.11)
      break

    case Surface.Grass:
      out.setRGB(0.31, 0.42, 0.19)
      break

    case Surface.Sand:
      out.setRGB(0.72, 0.66, 0.47)
      break

    case Surface.Suburb:
      // Between the city's grey and open ground: enough built surface to read as
      // developed, enough green left to read as not downtown. Most of the land area
      // of a real region is this, so it carries a lot of the map's character.
      out.setRGB(0.35, 0.34, 0.26)
      break

    case Surface.Water: {
      // Shallows read lighter, which is what makes a coastline legible from
      // altitude rather than a flat blue edge.
      const t = Math.min(1, -height / 120)
      out.setRGB(0.06 + 0.05 * (1 - t), 0.20 + 0.22 * (1 - t), 0.34 + 0.20 * (1 - t))
      break
    }

    default: {
      if (height > SNOW_LINE) {
        const t = Math.min(1, (height - SNOW_LINE) / 400)
        out.setRGB(0.62 + 0.32 * t, 0.64 + 0.31 * t, 0.66 + 0.30 * t)
      } else if (height > ROCK_LINE) {
        const t = (height - ROCK_LINE) / (SNOW_LINE - ROCK_LINE)
        out.setRGB(0.33 + 0.27 * t, 0.28 + 0.32 * t, 0.23 + 0.38 * t)
      } else if (height > TREE_LINE) {
        const t = (height - TREE_LINE) / (ROCK_LINE - TREE_LINE)
        out.setRGB(0.27 + 0.07 * t, 0.30 - 0.03 * t, 0.14 + 0.08 * t)
      } else {
        // Low ground is the colour most of the map is, so it carries the most
        // weight. Warm and a little olive rather than a flat green.
        const t = Math.max(0, height) / TREE_LINE
        out.setRGB(0.24 + 0.05 * t, 0.37 - 0.06 * t, 0.15 - 0.01 * t)
      }
    }
  }

  // Per-face jitter. This is most of what sells "faceted" — without it, adjacent
  // triangles at similar heights read as one smooth surface even with flat shading.
  out.r *= jitter
  out.g *= jitter
  out.b *= jitter
}

/** One LOD ring: a square grid with, above level 0, its middle quarter left out. */
class Ring {
  readonly mesh: Mesh
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly cell: number
  private readonly hollow: boolean
  private readonly bias: number

  /** Grid origin of the last build, in cell units. `null` until first built. */
  private builtAt: { gx: number; gz: number } | null = null

  private readonly heights = new Float32Array((RES + 1) * (RES + 1))
  private readonly surfaces = new Uint8Array((RES + 1) * (RES + 1))

  constructor(level: number, material: MeshLambertMaterial) {
    this.cell = BASE_CELL * 2 ** level
    this.hollow = level > 0
    this.bias = level * LEVEL_BIAS

    // Cells in a full grid, less the hollow middle for outer rings.
    const hole = this.hollow ? RES / 2 - 2 * HOLE_OVERLAP : 0
    const cells = RES * RES - hole * hole
    const verts = cells * 6

    this.positions = new Float32Array(verts * 3)
    this.colors = new Float32Array(verts * 3)

    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3))
    geometry.setAttribute('color', new BufferAttribute(this.colors, 3))

    this.mesh = new Mesh(geometry, material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -level
  }

  /** Snapped grid origin for a camera at (x, z). Returns null if unchanged. */
  private snapTo(x: number, z: number): { gx: number; gz: number } | null {
    // Snap to two cells, not one. Snapping to one cell makes the hollow centre of
    // this ring land half a cell off the ring inside it every other step, which
    // opens and closes a one-cell gap as the aircraft moves — a seam that flickers.
    const snap = this.cell * 2
    const gx = Math.round(x / snap) * 2
    const gz = Math.round(z / snap) * 2

    if (this.builtAt && this.builtAt.gx === gx && this.builtAt.gz === gz) return null
    return { gx, gz }
  }

  needsRebuild(x: number, z: number): boolean {
    return this.snapTo(x, z) !== null
  }

  build(source: TerrainSource, x: number, z: number): void {
    const at = this.snapTo(x, z)
    if (!at) return
    this.builtAt = at

    const originX = (at.gx - RES / 2) * this.cell
    const originZ = (at.gz - RES / 2) * this.cell

    // Sample the grid once. Each corner is shared by up to four triangles, so
    // sampling per triangle would cost four times as much for the same answer.
    for (let j = 0; j <= RES; j++) {
      for (let i = 0; i <= RES; i++) {
        const s = source.sample(originX + i * this.cell, originZ + j * this.cell)
        const k = j * (RES + 1) + i
        this.heights[k] = s.height
        this.surfaces[k] = s.surface
      }
    }

    const lo = RES / 4 + HOLE_OVERLAP
    const hi = RES - RES / 4 - HOLE_OVERLAP
    const colour = new Color()
    let p = 0
    let c = 0

    const emit = (i: number, j: number, faceColour: Color): void => {
      const k = j * (RES + 1) + i
      this.positions[p++] = originX + i * this.cell
      this.positions[p++] = (this.heights[k] as number) - this.bias
      this.positions[p++] = originZ + j * this.cell
      this.colors[c++] = faceColour.r
      this.colors[c++] = faceColour.g
      this.colors[c++] = faceColour.b
    }

    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        // The hollow centre, where the finer ring sits.
        if (this.hollow && i >= lo && i < hi && j >= lo && j < hi) continue

        const k00 = j * (RES + 1) + i
        const k10 = k00 + 1
        const k01 = k00 + RES + 1
        const k11 = k01 + 1

        const h00 = this.heights[k00] as number
        const h10 = this.heights[k10] as number
        const h01 = this.heights[k01] as number
        const h11 = this.heights[k11] as number

        // Split the quad along whichever diagonal keeps the two triangles closer
        // to coplanar. On a ridge line the other choice leaves a visible dent.
        const flip = Math.abs(h00 - h11) > Math.abs(h10 - h01)

        // One surface and one colour per triangle: the flattest possible read.
        //
        // Keyed to the cell's position in the WORLD, not its index within this
        // ring. Ring indices are relative to an origin that follows the aircraft,
        // so a pattern built from them is pinned to the camera and slides across
        // the landscape — which shows up as bands of shading gliding over the
        // ground at a fixed distance ahead, looking for all the world like a
        // rendering fault in the terrain rather than in its colouring.
        const worldI = at.gx - RES / 2 + i
        const worldJ = at.gz - RES / 2 + j
        const jitter = 0.94 + 0.13 * hash2(worldI, worldJ)

        // Wound counter-clockwise **seen from above**, which is what puts the face
        // normal along +Y. Getting this backwards is completely silent: the
        // geometry is correct, the draw calls happen, the triangle count is right,
        // and back-face culling discards every one of them. The world is simply not
        // there, with nothing in the console to say why.
        const first: [number, number][] = flip
          ? [[i, j], [i, j + 1], [i + 1, j]]
          : [[i, j], [i + 1, j + 1], [i + 1, j]]
        const second: [number, number][] = flip
          ? [[i + 1, j], [i, j + 1], [i + 1, j + 1]]
          : [[i, j], [i, j + 1], [i + 1, j + 1]]

        for (const tri of [first, second]) {
          let sumH = 0
          let surface = Surface.Land
          let sawWater = false

          let allWater = true

          for (const [ti, tj] of tri) {
            const kk = tj * (RES + 1) + ti
            sumH += this.heights[kk] as number
            const s = this.surfaces[kk] as Surface
            if (s === Surface.Water) sawWater = true
            else {
              allWater = false
              if (s !== Surface.Land) surface = s
            }
          }

          // Only a triangle that is water at every corner is drawn as water. One
          // straddling the shoreline is drawn as land and the sea plane covers
          // whatever part of it is actually wet — which gives a clean waterline.
          // Colouring the straddling triangles blue instead leaves a ragged band of
          // sea sitting up on the beach.
          if (allWater && sawWater) surface = Surface.Water

          groundColour(colour, sumH / 3, surface, jitter)

          for (const [ti, tj] of tri) emit(ti, tj, colour)
        }
      }
    }

    const geometry = this.mesh.geometry
    ;(geometry.getAttribute('position') as BufferAttribute).needsUpdate = true
    ;(geometry.getAttribute('color') as BufferAttribute).needsUpdate = true

    // Real normals rather than relying on `flatShading` alone. The geometry is
    // non-indexed, so every vertex belongs to exactly one triangle and this
    // produces exact per-face normals — which is the look wanted anyway. It also
    // means the lighting does not depend on which shading path the material
    // happens to take in a given three.js release.
    geometry.computeVertexNormals()
    geometry.computeBoundingSphere()
  }
}

/**
 * The terrain, as a three.js object you can add to a scene.
 *
 * Call `update(x, z)` once a frame with the camera position.
 */
export class TerrainMesh {
  readonly object = new Object3D()
  private readonly rings: Ring[] = []

  constructor(private readonly source: TerrainSource) {
    const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true })

    for (let level = 0; level < LEVELS; level++) {
      const ring = new Ring(level, material)
      this.rings.push(ring)
      this.object.add(ring.mesh)
    }
  }

  /** Force every ring to build. Called once at startup so frame one is not empty. */
  buildAll(x: number, z: number): void {
    for (const ring of this.rings) ring.build(this.source, x, z)
  }

  /**
   * Rebuild at most one ring. Finest first — it is the one being looked at, and the
   * one whose staleness would actually show.
   */
  update(x: number, z: number): void {
    for (const ring of this.rings) {
      if (ring.needsRebuild(x, z)) {
        ring.build(this.source, x, z)
        return
      }
    }
  }
}

export { RES as TERRAIN_RES, BASE_CELL as TERRAIN_BASE_CELL, LEVELS as TERRAIN_LEVELS }
