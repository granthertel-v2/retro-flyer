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
 * How far the drawn runway sits above the terrain, metres.
 *
 * Small, and matched by the physics with a ramp — both halves matter, and each was
 * learned by getting it wrong.
 *
 * The strip is a flat quad laid on flat ground at exactly the same height, so it
 * z-fights badly. `polygonOffset` is the textbook answer and does nothing here: the
 * renderer uses a **logarithmic depth buffer**, which writes depth from the fragment
 * shader, and polygon offset only biases fixed-function depth. So a real geometric
 * lift is needed.
 *
 * But a lift creates a step at the runway edge, and the step is what the gear hits.
 * At 0.6 m that was a two-foot kerb taken at 160 kt — it showed up as a 4 ft/s
 * landing bottoming the struts at 12 g while an 8 ft/s landing was fine, purely
 * because the gentle one touched down short of the threshold and rolled onto it.
 *
 * So: 12 cm rather than 60, and `surfaceHeight` below ramps it out over the apron
 * so the physics sees a 0.24% slope instead of a wall. The pad is dead flat for 150 m
 * beyond every runway — measured at exactly zero spread — so there is room to ramp.
 */
export const RUNWAY_SURFACE_OFFSET_M = 0.12

/**
 * Distance over which the runway lift ramps away outside the strip, metres. `[A]`
 *
 * Long enough that 12 cm is spread across a slope nothing can feel, short enough to
 * stay well inside the flattened apron.
 *
 */
export const RUNWAY_RAMP_M = 60

export interface TerrainSource {
  /** Half-width of the map, metres. The world spans [-extent, +extent] on X and Z. */
  readonly extent: number
  /** Landform elevation at a world coordinate, metres. What the terrain mesh draws. */
  height(x: number, z: number): number
  /**
   * Elevation of the surface you would stand on, metres.
   *
   * The same as `height` everywhere except on and around a runway, where it includes
   * the strip's small lift, ramped out so there is no step to drive off. This is what
   * the gear must use — see `RUNWAY_SURFACE_OFFSET_M`.
   */
  surfaceHeight(x: number, z: number): number
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
