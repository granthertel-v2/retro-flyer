/**
 * The Terrain source -> Renderer seam (REQUIREMENTS §8.2).
 *
 * The renderer asks for height and surface type at a world coordinate. It does not
 * know, and must never need to know, whether the answer came from the authored map
 * or from a DEM tile. That is the entire point of this file: §7 says real elevation
 * data is a later swap, and this is what makes it a new file rather than a rewrite.
 *
 * Coordinates are three.js world space, metres — X East, Z South, Y up — matching
 * what `seam.ts` produces. Terrain is a rendering concern, so it lives in renderer
 * units and never sees a foot.
 *
 * Nothing here imports three.js, so the map can be tested in Node.
 */

/**
 * What is under the aircraft.
 *
 * Day 3's ground reaction reads this to decide what it is rolling on; Day 2 uses it
 * to colour the world. Kept deliberately small — this is not a material system.
 */
export const enum Surface {
  Water = 0,
  Land = 1,
  City = 2,
  Runway = 3,
}

export interface TerrainSample {
  /** Ground elevation, metres above sea level. Negative under water. */
  height: number
  surface: Surface
}

/** An airfield, in the terms Day 3 will need to put an aircraft on one. */
export interface Airfield {
  name: string
  /** Runway midpoint, world metres. */
  x: number
  z: number
  /** Field elevation, metres. */
  elevation: number
  /** Runway heading, degrees true. */
  headingDeg: number
  lengthM: number
  widthM: number
}

/**
 * How far the drawn runway sits above the terrain under it, metres.
 *
 * The pad is flattened but only to within half a metre (asserted in
 * `test/terrain.test.ts`), and the runway strip is a single flat quad — so it has to
 * be lifted clear or the terrain pokes through it in a scatter of z-fighting
 * triangles.
 *
 * It lives here, rather than in the renderer that draws the strip, because Day 3
 * gave it a second consumer. The physics has to stand the aircraft on the surface
 * people can see: with the strip lifted 0.6 m and the gear standing on the raw
 * terrain, the wheels sit 0.595 m under the tarmac, which is exactly what happened
 * and exactly what a green test suite will never mention. Day 2's note here guessed
 * "low enough that Day 3's gear will not notice it". It noticed.
 */
export const RUNWAY_SURFACE_OFFSET_M = 0.6

export interface TerrainSource {
  /** Half-width of the map, metres. The world spans [-extent, +extent] on X and Z. */
  readonly extent: number
  /** Ground elevation at a world coordinate, metres. */
  height(x: number, z: number): number
  /** Elevation and surface type at a world coordinate. */
  sample(x: number, z: number): TerrainSample
  readonly airfields: readonly Airfield[]
}

// ---------------------------------------------------------------------------
// Field primitives — the vocabulary the authored map is written in
// ---------------------------------------------------------------------------

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

/** Hermite ease between two edges. Zero below `a`, one above `b`, smooth throughout. */
export function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Distance from a point to a line segment.
 *
 * Every feature in the authored map — coastline, ridge, river — is a polyline with
 * a profile applied to its distance field. This is the whole geometry engine.
 */
export function distanceToSegment(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const dx = bx - ax
  const dz = bz - az
  const lenSq = dx * dx + dz * dz

  if (lenSq === 0) return Math.hypot(px - ax, pz - az)

  const t = clamp(((px - ax) * dx + (pz - az) * dz) / lenSq, 0, 1)
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz))
}

export type Polyline = readonly (readonly [number, number])[]

/** Shortest distance from a point to a polyline. */
export function distanceToPolyline(px: number, pz: number, line: Polyline): number {
  let best = Infinity

  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i] as readonly [number, number]
    const b = line[i + 1] as readonly [number, number]
    const d = distanceToSegment(px, pz, a[0], a[1], b[0], b[1])
    if (d < best) best = d
  }

  return best
}

/**
 * Distance along a polyline to the closest point on it, normalised to 0..1.
 *
 * The ridge needs this: a ridge of constant height is a wall, and a wall is not
 * worth flying through. Height varies along the spine, which means knowing how far
 * along the spine you are.
 */
export function positionAlongPolyline(px: number, pz: number, line: Polyline): number {
  const lengths: number[] = []
  let total = 0

  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i] as readonly [number, number]
    const b = line[i + 1] as readonly [number, number]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    lengths.push(len)
    total += len
  }

  let best = Infinity
  let bestDistanceAlong = 0
  let travelled = 0

  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i] as readonly [number, number]
    const b = line[i + 1] as readonly [number, number]
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const lenSq = dx * dx + dz * dz
    const t = lenSq === 0 ? 0 : clamp(((px - a[0]) * dx + (pz - a[1]) * dz) / lenSq, 0, 1)
    const d = Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz))

    if (d < best) {
      best = d
      bestDistanceAlong = travelled + t * (lengths[i] as number)
    }

    travelled += lengths[i] as number
  }

  return total === 0 ? 0 : bestDistanceAlong / total
}

/**
 * Signed distance to an axis-aligned rectangle, rotated by `headingRad`.
 *
 * Negative inside. Runways and the city grid are rectangles, and both need a
 * distance field rather than a boolean so their edges can be blended into the
 * surrounding terrain instead of stamped onto it.
 */
export function signedDistanceToRect(
  px: number, pz: number,
  cx: number, cz: number,
  halfLength: number, halfWidth: number,
  headingRad: number,
): number {
  // Rotate the query point into the rectangle's own frame. Heading is measured
  // clockwise from North (-Z), which is what a runway number means.
  const dx = px - cx
  const dz = pz - cz
  const c = Math.cos(headingRad)
  const s = Math.sin(headingRad)

  // Along-runway axis points along the heading; across is 90 degrees right of it.
  const along = dx * s - dz * c
  const across = dx * c + dz * s

  const qx = Math.abs(along) - halfLength
  const qz = Math.abs(across) - halfWidth

  const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0))
  const inside = Math.min(Math.max(qx, qz), 0)

  return outside + inside
}

// ---------------------------------------------------------------------------
// Deterministic value noise
// ---------------------------------------------------------------------------

/**
 * Integer hash to [0, 1). Deterministic, no seeding state, no dependency.
 *
 * The map has to be identical on every machine and every reload — Day 3's waypoint
 * course and situation save/restore both assume the world does not move. A
 * `Math.random()` anywhere in terrain generation would quietly break both.
 */
export function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2545f491)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** Bilinear value noise on a unit grid, smoothstep-interpolated. */
export function valueNoise(x: number, z: number): number {
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const fx = x - x0
  const fz = z - z0

  const u = fx * fx * (3 - 2 * fx)
  const v = fz * fz * (3 - 2 * fz)

  const n00 = hash2(x0, z0)
  const n10 = hash2(x0 + 1, z0)
  const n01 = hash2(x0, z0 + 1)
  const n11 = hash2(x0 + 1, z0 + 1)

  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v)
}

/** Summed octaves of value noise, returned in [0, 1]. */
export function fbm(x: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let sum = 0
  let amplitude = 1
  let total = 0
  let freq = 1

  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise(x * freq, z * freq)
    total += amplitude
    amplitude *= gain
    freq *= lacunarity
  }

  return sum / total
}
