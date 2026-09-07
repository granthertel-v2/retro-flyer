/**
 * The authored map (REQUIREMENTS §7).
 *
 * Designed rather than random: a coastline and a bay, one ridge line worth flying
 * through, a river running from that ridge to the bay, a city grid for visual
 * reference, and four airfields 20 to 60 nm apart.
 *
 * ## Why it is code and not a painted heightmap
 *
 * Three reasons, in order of how much they mattered:
 *
 * 1. **Determinism.** Day 3 has a timed waypoint course and situation save/restore.
 *    Both assume the world is identical on every load and every machine. This map is
 *    a pure function of position with a fixed integer hash behind it — there is no
 *    seed to lose and no `Math.random()` anywhere in it.
 * 2. **No asset pipeline.** A PNG heightmap means an editor, an import step, a
 *    resolution decision and a file in git that nobody can diff. Moving the ridge
 *    here is editing six coordinates.
 * 3. **It is one implementation of §8.2, not the interface.** Real DEM data is a
 *    later swap. Keeping the authored map behind the same `TerrainSource` is the
 *    thing that makes that swap a new file.
 *
 * ## How it is built
 *
 * Every feature is a distance field with a profile applied to it, composed in a
 * fixed order: rolling base, then the ridge added, then the ocean cut, then the
 * river carved, then the city and the airfields flattened. Flattening happens last
 * because a runway with a hill through it is not a runway.
 *
 * Blends are `smoothstep` throughout. A hard mask leaves a crease, and a crease in a
 * flat-shaded world is a bright line of wrong-coloured triangles visible from ten
 * miles away.
 *
 * Coordinates are three.js world metres: **X is East, Z is South**, so North is -Z.
 */

import {
  RUNWAY_RAMP_M,
  RUNWAY_SURFACE_OFFSET_M,
  clamp,
  distanceToPolyline,
  fbm,
  lerp,
  positionAlongPolyline,
  signedDistanceToRect,
  smoothstep,
  type Airfield,
  type Polyline,
  Surface,
  type TerrainSample,
  type TerrainSource,
} from './source.js'

/** Half-width of the world, metres. 30 nm each way — a 60 nm square map (§7). */
export const MAP_EXTENT = 55_560

const METRES_PER_NM = 1852

// ---------------------------------------------------------------------------
// The coastline
// ---------------------------------------------------------------------------

/**
 * Eastern edge of the ocean, as a function of Z (north-south).
 *
 * The ocean is everything west of this line. Expressing the coast as x(z) rather
 * than as a closed polygon means "am I over water" is a comparison instead of a
 * point-in-polygon test, and the answer is continuous — which is what lets the
 * shoreline blend rather than step.
 */
const COAST_CONTROL: readonly (readonly [number, number])[] = [
  [-55_560, -26_000],
  [-38_000, -23_000],
  [-22_000, -20_000],
  [-6_000, -21_000],
  [10_000, -24_000],
  [30_000, -21_500],
  [55_560, -27_000],
]

function coastlineX(z: number): number {
  const pts = COAST_CONTROL
  const first = pts[0] as readonly [number, number]
  const last = pts[pts.length - 1] as readonly [number, number]

  if (z <= first[0]) return first[1]
  if (z >= last[0]) return last[1]

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i] as readonly [number, number]
    const b = pts[i + 1] as readonly [number, number]
    if (z >= a[0] && z <= b[0]) {
      const t = smoothstep(a[0], b[0], z)
      return lerp(a[1], b[1], t)
    }
  }

  return last[1]
}

/**
 * The bay: an ellipse pushed east into the land, overlapping the coast so it opens
 * to the sea rather than sitting inland as a lake.
 */
const BAY = { x: -14_000, z: 6_000, rx: 11_000, rz: 9_000 } as const

function bayField(x: number, z: number): number {
  const nx = (x - BAY.x) / BAY.rx
  const nz = (z - BAY.z) / BAY.rz
  return Math.hypot(nx, nz)
}

/**
 * How far inland a point is, in metres. Negative offshore.
 *
 * Combines the coastline and the bay, with a noise wobble on the shore so it does
 * not read as an interpolated curve — which, at 500 knots and 500 feet, it very
 * much would.
 */
function inlandDistance(x: number, z: number): number {
  const wobble = (fbm(x / 5_000, z / 5_000, 3) - 0.5) * 2_600
  const fromCoast = x - (coastlineX(z) + wobble)

  // Distance out of the bay ellipse, converted back to something metre-ish by
  // scaling on the smaller radius.
  const fromBay = (bayField(x, z) - 1) * Math.min(BAY.rx, BAY.rz)

  return Math.min(fromCoast, fromBay)
}

// ---------------------------------------------------------------------------
// The ridge
// ---------------------------------------------------------------------------

/**
 * The ridge spine, north to south.
 *
 * §7 asks for "a ridge line worth flying through", which a wall of constant height
 * is not. The height profile below puts a pass in it — a notch down to about 900 m
 * a little under halfway along — so there is a way through as well as a way over,
 * and a reason to fly one rather than the other.
 */
const RIDGE: Polyline = [
  [33_000, -48_000],
  [27_000, -30_000],
  [21_000, -12_000],
  [19_000, 4_000],
  [14_000, 22_000],
  [8_000, 40_000],
]

/** Crest height along the spine, metres, as a function of normalised distance. */
function ridgeCrest(t: number): number {
  // Rises from the north end, notches sharply at the pass, then a second summit.
  const shoulder = smoothstep(0, 0.18, t) * smoothstep(1, 0.86, t)
  const northSummit = 2_320 * Math.exp(-(((t - 0.26) / 0.16) ** 2))
  const southSummit = 2_050 * Math.exp(-(((t - 0.68) / 0.19) ** 2))
  const spine = 1_150 * shoulder

  const crest = Math.max(spine, northSummit, southSummit)

  // The pass. Cut it in explicitly rather than hoping the summit falloff leaves a
  // gap — a gap that appears by accident can disappear by accident.
  const pass = 1 - 0.62 * Math.exp(-(((t - 0.45) / 0.045) ** 2))

  return crest * pass
}

const RIDGE_HALF_WIDTH = 7_400

function ridgeHeight(x: number, z: number): number {
  const d = distanceToPolyline(x, z, RIDGE)
  if (d > RIDGE_HALF_WIDTH) return 0

  const t = positionAlongPolyline(x, z, RIDGE)
  const profile = smoothstep(RIDGE_HALF_WIDTH, 0, d)

  // Roughen the flanks so they read as rock rather than as an extruded curve.
  const rough = 1 + 0.16 * (fbm(x / 2_200, z / 2_200, 4) - 0.5)

  return ridgeCrest(t) * profile * profile * rough
}

// ---------------------------------------------------------------------------
// The river
// ---------------------------------------------------------------------------

/** From the ridge's western flank down to the bay. */
const RIVER: Polyline = [
  [17_000, -2_000],
  [10_000, 1_000],
  [2_000, 3_000],
  [-5_000, 5_500],
  [-11_500, 6_500],
]

const RIVER_CHANNEL = 380
const RIVER_VALLEY = 2_600

function riverCarve(x: number, z: number, h: number): number {
  const d = distanceToPolyline(x, z, RIVER)
  if (d > RIVER_VALLEY) return h

  // A narrow flat channel inside a wider valley. The valley is what makes it
  // flyable; the channel is what makes it visible.
  const valley = smoothstep(RIVER_VALLEY, RIVER_CHANNEL, d)
  const channel = smoothstep(RIVER_CHANNEL, 0, d)

  return h - 90 * valley - 45 * channel
}

// ---------------------------------------------------------------------------
// The city
// ---------------------------------------------------------------------------

/**
 * The city plateau, on the coast north of the bay.
 *
 * §7 wants it "for visual reference" and §6 wants near-field detail that makes low
 * altitude read fast. A city does both jobs at once, which is why it is worth its
 * own feature rather than being scattered buildings.
 */
export const CITY = {
  x: -16_000,
  z: -10_000,
  halfLength: 3_600,
  halfWidth: 3_100,
  headingRad: 0.14,
  elevation: 46,
} as const

function cityFlatten(x: number, z: number, h: number): number {
  const d = signedDistanceToRect(
    x, z,
    CITY.x, CITY.z,
    CITY.halfLength, CITY.halfWidth,
    CITY.headingRad,
  )

  if (d > 2_400) return h

  const t = smoothstep(2_400, -200, d)
  return lerp(h, CITY.elevation, t)
}

/** True inside the built-up area — what `city.ts` extrudes blocks over. */
export function inCity(x: number, z: number): boolean {
  return (
    signedDistanceToRect(
      x, z,
      CITY.x, CITY.z,
      CITY.halfLength, CITY.halfWidth,
      CITY.headingRad,
    ) < 0
  )
}

// ---------------------------------------------------------------------------
// The airfields
// ---------------------------------------------------------------------------

/**
 * Four fields, sited so every pair is between 20 and 60 nm apart (§7). The spacing
 * is asserted in `test/terrain.test.ts` rather than trusted — it is the kind of
 * constraint that quietly stops holding the moment someone nudges a field to get it
 * off a hillside.
 *
 * Elevations are computed from the terrain at construction, not written here, so a
 * field cannot end up floating above or buried under its own ground.
 */
const AIRFIELD_SITES = [
  { name: 'Bayside', x: -6_000, z: -4_000, headingDeg: 88, lengthM: 2_900, widthM: 46 },
  { name: 'Ridgeview', x: 34_000, z: 8_000, headingDeg: 12, lengthM: 2_600, widthM: 46 },
  { name: 'Northfield', x: 6_000, z: -42_000, headingDeg: 340, lengthM: 3_100, widthM: 46 },
  { name: 'Southpoint', x: -2_000, z: 40_000, headingDeg: 68, lengthM: 2_700, widthM: 46 },
] as const

/** Distance over which a field's pad blends out into the surrounding terrain. */
const PAD_APRON = 900

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Distance inland over which the land rises from sea level. */
const SHORE_RUN = 5_000
/** Distance offshore over which the seabed reaches full depth. */
const SHELF_RUN = 9_000
/** Depth of the open sea floor, metres. Deep enough to read as sea, not a puddle. */
const SEABED_DEPTH = 175

/** Rolling hills. Two scales: broad relief, and something to catch the light. */
function baseTerrain(x: number, z: number): number {
  const broad = fbm(x / 21_000, z / 21_000, 3)
  const medium = fbm(x / 5_200, z / 5_200, 4)

  return 130 + broad * 430 + medium * 95
}

/** Everything except the airfields — what a pad's elevation is measured against. */
function landformHeight(x: number, z: number): number {
  const ridge = ridgeHeight(x, z)

  // The ridge subsumes the rolling terrain where it dominates rather than stacking
  // on top of it. Summing the two puts the crest wherever the broad noise happened
  // to be high, which makes the peak height an accident instead of a decision.
  const base = baseTerrain(x, z) * (1 - 0.78 * smoothstep(0, 900, ridge))
  let h = base + ridge

  // The ocean.
  //
  // The land is scaled to zero AT the shoreline and the seabed grows from zero
  // going out, so the two meet at zero by construction. Interpolating the land
  // height toward a fixed depth instead leaves the shore at whatever fraction of
  // the inland height the blend happens to reach there — which was a 300 m cliff
  // standing in the water, and it made the bay a landlocked lake.
  const inland = inlandDistance(x, z)
  if (inland < SHORE_RUN) {
    const land = smoothstep(0, SHORE_RUN, inland)
    const sea = smoothstep(0, -SHELF_RUN, inland)
    h = h * land - SEABED_DEPTH * sea
  }

  h = riverCarve(x, z, h)
  h = cityFlatten(x, z, h)

  return h
}

class AuthoredMap implements TerrainSource {
  readonly extent = MAP_EXTENT
  readonly airfields: readonly Airfield[]

  constructor() {
    this.airfields = AIRFIELD_SITES.map((site) => ({
      name: site.name,
      x: site.x,
      z: site.z,
      headingDeg: site.headingDeg,
      lengthM: site.lengthM,
      widthM: site.widthM,
      // Measured, not asserted. See the note on AIRFIELD_SITES.
      elevation: Math.round(landformHeight(site.x, site.z)),
    }))
  }

  /** Signed distance to the nearest runway rectangle, and that runway's elevation. */
  private nearestPad(x: number, z: number): { distance: number; elevation: number } {
    let best = Infinity
    let elevation = 0

    for (const f of this.airfields) {
      // Pads are wider than the runway itself — a strip of tarmac with a cliff on
      // both sides is not somewhere anyone is landing on Day 3.
      const d = signedDistanceToRect(
        x, z,
        f.x, f.z,
        f.lengthM / 2 + 260,
        f.widthM / 2 + 220,
        (f.headingDeg * Math.PI) / 180,
      )

      if (d < best) {
        best = d
        elevation = f.elevation
      }
    }

    return { distance: best, elevation }
  }

  height(x: number, z: number): number {
    const h = landformHeight(x, z)
    const pad = this.nearestPad(x, z)

    if (pad.distance > PAD_APRON) return h

    return lerp(h, pad.elevation, smoothstep(PAD_APRON, 0, pad.distance))
  }

  /**
   * The surface the wheels stand on: the landform, plus the runway strip's lift
   * ramped smoothly away outside the strip.
   *
   * The ramp is the whole point. The lift has to exist because the strip z-fights
   * with the flat ground it sits on and the logarithmic depth buffer makes
   * `polygonOffset` useless; the ramp is what stops the lift becoming a step for the
   * gear to hit at landing speed. See `RUNWAY_SURFACE_OFFSET_M`.
   */
  surfaceHeight(x: number, z: number): number {
    const base = this.height(x, z)
    let lift = 0

    for (const f of this.airfields) {
      const d = signedDistanceToRect(
        x, z,
        f.x, f.z,
        f.lengthM / 2,
        f.widthM / 2,
        (f.headingDeg * Math.PI) / 180,
      )
      if (d >= RUNWAY_RAMP_M) continue
      // Full lift on the strip (d <= 0), fading to nothing over the apron.
      lift = Math.max(lift, RUNWAY_SURFACE_OFFSET_M * smoothstep(RUNWAY_RAMP_M, 0, d))
    }

    return base + lift
  }

  sample(x: number, z: number): TerrainSample {
    const height = this.height(x, z)

    for (const f of this.airfields) {
      const d = signedDistanceToRect(
        x, z,
        f.x, f.z,
        f.lengthM / 2,
        f.widthM / 2,
        (f.headingDeg * Math.PI) / 180,
      )
      if (d < 0) return { height, surface: Surface.Runway }
    }

    if (height < 0) return { height, surface: Surface.Water }
    if (inCity(x, z)) return { height, surface: Surface.City }

    return { height, surface: Surface.Land }
  }
}

/**
 * The map. One instance — there is one world (§8).
 */
export const authoredMap: TerrainSource = new AuthoredMap()

/** Separation between two airfields, nautical miles. Used by the tests and Day 3. */
export function separationNm(a: Airfield, b: Airfield): number {
  return Math.hypot(a.x - b.x, a.z - b.z) / METRES_PER_NM
}

export { Surface, type Airfield, type TerrainSample, type TerrainSource }
export { clamp, smoothstep, lerp }
