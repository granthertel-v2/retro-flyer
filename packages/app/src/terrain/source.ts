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

  // Land cover, added when the first real region arrived. See the note below.
  Forest = 4,
  Grass = 5,
  Sand = 6,
  Suburb = 7,
}

/**
 * Why the land-cover classes exist, and why they are here rather than in a second raster.
 *
 * `mesh.ts` originally coloured `Land` by altitude — olive below 520 m, green to
 * 1,150, rock, then snow. That works for the authored map, which was built with a
 * ridge in it precisely so there would be something to colour. It fails completely
 * for a real city: Manhattan's highest natural ground is about 60 m and the Palisades
 * top out near 113 m, so every land triangle in the New York region lands in the
 * bottom eighth of the lowest band and the whole map renders as one uniform olive
 * plain. Correct elevation, correct coastline, and unreadable.
 *
 * The fix is to colour real ground by what it *is* rather than how high it is, which
 * means the terrain source has to carry land cover. Adding classes to this enum was
 * chosen over a parallel land-cover raster for one reason: `TerrainSample` is the
 * §8.2 seam, and every consumer already switches on `surface`. A second raster would
 * mean a second lookup, a second thing to keep aligned, and a second thing to forget.
 *
 * These are deliberately *visual* categories, not a land-use taxonomy. The test is
 * "does it read differently from five hundred feet", which is why `Forest` and
 * `Grass` are separate but "school" and "hospital" are not.
 *
 * ## What they mean to the physics
 *
 * Nothing, and that is intentional. `groundSource.ts` maps `Runway` to paved, `Water`
 * to water, and everything else to soft ground. A new class is therefore soft ground
 * automatically, which is the right answer for all four of these — none of them is
 * something you can land on properly, and none is water.
 */

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

/**
 * How much a runway lifts the surface at a point, metres.
 *
 * Shared rather than reimplemented per source. Every `TerrainSource` owes callers the
 * same answer here, because the number it produces is what the landing gear stands on
 * — and the ramp is the reason there is no step at the runway edge for a wheel to hit
 * at 160 kt. Two implementations of this would eventually be two different ramps, and
 * only one of them would have been flown.
 */
/**
 * Per-airfield geometry, computed once.
 *
 * `runwayLift` and `onRunway` are the hottest functions in the renderer: every
 * terrain vertex goes through `sample`, every physics step goes through
 * `surfaceHeight`, and a single LOD ring rebuild is nine thousand of them. Both used
 * to convert a heading to radians and take its sine and cosine *per airfield, per
 * call* — four airfields on the authored map, which nobody noticed, and twenty-two
 * in New York, which cost 5.6 microseconds a sample and turned a ring rebuild into a
 * fifty-millisecond hitch.
 *
 * The cache is keyed on the airfield object itself, so it needs no invalidation: a
 * map builds its airfields once and hands out the same objects forever, and one that
 * did not would simply get a fresh entry.
 */
interface RunwayRect {
  sin: number
  cos: number
  halfLength: number
  halfWidth: number
  /** Radius beyond which no point can be within `RUNWAY_RAMP_M` of the strip. */
  reachSq: number
}

const RUNWAY_RECTS = new WeakMap<Airfield, RunwayRect>()

function rectOf(f: Airfield): RunwayRect {
  let rect = RUNWAY_RECTS.get(f)
  if (!rect) {
    const heading = (f.headingDeg * Math.PI) / 180
    const halfLength = f.lengthM / 2
    const halfWidth = f.widthM / 2
    const reach = Math.hypot(halfLength + RUNWAY_RAMP_M, halfWidth + RUNWAY_RAMP_M)
    rect = {
      sin: Math.sin(heading),
      cos: Math.cos(heading),
      halfLength,
      halfWidth,
      reachSq: reach * reach,
    }
    RUNWAY_RECTS.set(f, rect)
  }
  return rect
}

/** Signed distance to a runway rectangle whose trigonometry is already known. */
function distanceToRunway(x: number, z: number, f: Airfield, rect: RunwayRect): number {
  const dx = x - f.x
  const dz = z - f.z
  const along = dx * rect.sin - dz * rect.cos
  const across = dx * rect.cos + dz * rect.sin
  const ox = Math.abs(along) - rect.halfLength
  const oz = Math.abs(across) - rect.halfWidth
  if (ox > 0 || oz > 0) return Math.hypot(Math.max(ox, 0), Math.max(oz, 0))
  return Math.max(ox, oz)
}

/**
 * How much a runway lifts the surface at a point, metres.
 *
 * Shared rather than reimplemented per source. Every `TerrainSource` owes callers the
 * same answer here, because the number it produces is what the landing gear stands on
 * — and the ramp is the reason there is no step at the runway edge for a wheel to hit
 * at 160 kt. Two implementations of this would eventually be two different ramps, and
 * only one of them would have been flown.
 */
export function runwayLift(
  x: number,
  z: number,
  airfields: readonly Airfield[],
): number {
  let lift = 0

  for (const f of airfields) {
    // Almost every point in a region is nowhere near a runway, so reject on a
    // squared distance before doing any rotation at all. This is the whole
    // optimisation; the rest is bookkeeping.
    const dx = x - f.x
    const dz = z - f.z
    const rect = rectOf(f)
    if (dx * dx + dz * dz > rect.reachSq) continue

    const d = distanceToRunway(x, z, f, rect)
    if (d >= RUNWAY_RAMP_M) continue
    // Full lift on the strip (d <= 0), fading to nothing over the apron.
    lift = Math.max(lift, RUNWAY_SURFACE_OFFSET_M * smoothstep(RUNWAY_RAMP_M, 0, d))
  }

  return lift
}

/** Whether a point is on a runway strip. The same rectangle `runwayLift` uses. */
export function onRunway(x: number, z: number, airfields: readonly Airfield[]): boolean {
  for (const f of airfields) {
    const dx = x - f.x
    const dz = z - f.z
    const rect = rectOf(f)
    if (dx * dx + dz * dz > rect.reachSq) continue
    if (distanceToRunway(x, z, f, rect) < 0) return true
  }
  return false
}

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
  /**
   * Everything standing on the terrain, as boxes. Read once, never per frame.
   *
   * Optional because a map is allowed not to have any, and because making it
   * optional is what let the real regions arrive without every existing caller
   * being touched.
   *
   * It belongs on the seam rather than in the renderer for the reason §8.2 exists
   * at all: `city.ts` used to reach past the interface and import the authored
   * map's own `CITY` rectangle, so it could only ever draw one city. Asking the
   * source instead means the authored map hands over its procedural grid, a real
   * region hands over twenty-four thousand surveyed footprints, and the renderer
   * cannot tell the difference — which is precisely the promise the terrain seam
   * was written to keep.
   */
  buildings?(): BuildingInstance[]
  /**
   * Named places, for labelling a map. Most prominent first.
   *
   * Optional for the same reason `buildings` is: a map is allowed to have none, and
   * optional is what let real regions arrive without touching every caller.
   */
  readonly places?: readonly Place[]
  /** Notable named features, for labelling. */
  readonly landmarks?: readonly Landmark[]
  /** Bridges, as centrelines in world metres. */
  readonly bridges?: readonly Bridge[]
}

/**
 * Something worth naming that is not a town: a bridge, a stadium, a statue, a tower.
 *
 * `kind` is OpenStreetMap's word for it, kept rather than mapped to an enum, because
 * the renderer only uses it to pick a symbol and a new kind appearing is not an
 * error. `heightM` is present only where the landmark was matched to a building the
 * region already draws, and is that building's height.
 */
export interface Landmark {
  name: string
  x: number
  z: number
  kind: string
  heightM?: number
}

/**
 * A bridge, as a centreline and a width.
 *
 * Not a footprint. The renderer lays a deck along the line and arches it over the
 * water, which is all a bridge needs to be from an aeroplane — and it means a
 * structure mapped as a polygon and one mapped as a way arrive in the same shape.
 */
export interface Bridge {
  name: string
  /** World metres, in order along the span. */
  points: readonly { x: number; z: number }[]
  widthM: number
  lengthM: number
}

/**
 * A named place, in world metres.
 *
 * `rank` is 0 for a city and rises through borough, town, suburb, village and
 * neighbourhood — a drawing priority rather than a fact about the world. It exists
 * because a map the size of a postcard cannot show two hundred and fifty labels and
 * has to have an opinion about which fifteen matter.
 */
export interface Place {
  name: string
  x: number
  z: number
  rank: number
}

/**
 * One building, as the renderer wants it: a box on the ground.
 *
 * Deliberately not a footprint. The renderer draws boxes, so the fitting of an
 * outline to a rectangle happens once, offline, rather than on every load — and a
 * map that has no outlines to fit can still describe its buildings this way.
 *
 * No colour. Shade is derived from position by the renderer, which keeps it out of
 * the region blob where it would cost four bytes times twenty-four thousand to say
 * something a hash can say for nothing.
 */
export interface BuildingInstance {
  x: number
  z: number
  halfLengthM: number
  halfWidthM: number
  /** Degrees, in the same convention as `Airfield.headingDeg`. */
  headingDeg: number
  heightM: number
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
