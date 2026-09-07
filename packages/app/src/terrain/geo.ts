/**
 * Geodetic coordinates to the renderer's local metric frame.
 *
 * Everything in this project's world is metres on a flat plane: X east, Z south,
 * Y up (see `seam.ts`). Real terrain arrives as latitude and longitude on an
 * ellipsoid. This file is the one place that gap is crossed, and it is deliberately
 * the *only* place — a second conversion elsewhere is a second chance to get the sign
 * of longitude wrong, which is the kind of error that puts a runway in the sea and
 * still looks plausible.
 *
 * ## Why not just scale degrees
 *
 * The obvious version — `x = (lon - lon0) * k`, `z = -(lat - lat0) * k` — is wrong in
 * two ways that both matter at the scale of a 110 km region:
 *
 * - A degree of longitude shortens with latitude, and by 40 degrees north it is
 *   already 24% shorter than a degree of latitude. Getting that wrong stretches the
 *   whole city sideways.
 * - The Earth is an ellipsoid, not a sphere. The radius that governs east-west
 *   distance is not the one that governs north-south, and they differ by about 0.3%
 *   at mid latitudes — 170 m across a region this size.
 *
 * So this goes through ECEF (earth-centred, earth-fixed) and out to ENU (east, north,
 * up) about a stated origin. That is exact on the ellipsoid rather than approximate,
 * costs a handful of trig calls, and is the standard construction — which matters
 * because it can be checked against published values instead of trusted.
 *
 * ## The flat-earth assumption that remains
 *
 * ENU is a tangent plane. The ground curves away from it, by `d^2 / 2R` — about 24 cm
 * at 5 km, 9.6 m at 35 km, and 48 m at the 78 km corner of a region. That is left in
 * rather than corrected: the terrain is drawn on a flat plane by `mesh.ts` and the
 * flight model's `pn`/`pe` are flat too, so "correcting" it here would put the
 * heightfield and the physics into different worlds. The error is a slow sag at the
 * horizon, which fog is already hiding.
 *
 * Values marked `[S]` are the defining constants of WGS-84 and are exact by
 * definition, not measured.
 */

/** Semi-major axis, metres. Exact by definition. `[S]` */
export const WGS84_A = 6_378_137.0

/** Flattening. Exact by definition. `[S]` */
export const WGS84_F = 1 / 298.257223563

/** First eccentricity squared, derived. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F)

const DEG = Math.PI / 180

export interface LatLon {
  /** Degrees north, positive. */
  lat: number
  /** Degrees east, positive. West longitudes — all of North America — are negative. */
  lon: number
}

/** A point in the renderer's world frame: metres, X east, Z south. */
export interface WorldXZ {
  x: number
  z: number
}

/**
 * Radius of curvature in the prime vertical, metres.
 *
 * The east-west radius. Distinct from the meridional radius, which is what makes the
 * naive single-radius conversion wrong.
 */
function primeVertical(latRad: number): number {
  const s = Math.sin(latRad)
  return WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s)
}

/**
 * Radius of curvature in the meridian, metres.
 *
 * The north-south radius, and a different number from the prime vertical — 0.39%
 * smaller at 40 degrees north. Using one for both is the single most common way to
 * get a local projection subtly wrong.
 */
function meridional(latRad: number): number {
  const s = Math.sin(latRad)
  return (WGS84_A * (1 - WGS84_E2)) / (1 - WGS84_E2 * s * s) ** 1.5
}

/** Geodetic to earth-centred, earth-fixed, metres. Height is above the ellipsoid. */
export function geodeticToEcef(lat: number, lon: number, height = 0): [number, number, number] {
  const latRad = lat * DEG
  const lonRad = lon * DEG
  const n = primeVertical(latRad)

  const cosLat = Math.cos(latRad)
  const sinLat = Math.sin(latRad)

  return [
    (n + height) * cosLat * Math.cos(lonRad),
    (n + height) * cosLat * Math.sin(lonRad),
    (n * (1 - WGS84_E2) + height) * sinLat,
  ]
}

/**
 * Earth-centred, earth-fixed to geodetic.
 *
 * Bowring's method, which converges to well under a millimetre in one pass at every
 * latitude that is not essentially the pole. Written out rather than iterated so the
 * round trip has no tolerance to tune.
 */
export function ecefToGeodetic(x: number, y: number, z: number): { lat: number; lon: number; height: number } {
  const b = WGS84_A * (1 - WGS84_F)
  const ep2 = (WGS84_A * WGS84_A - b * b) / (b * b)
  const p = Math.hypot(x, y)

  // Degenerate on the axis: longitude is undefined and latitude is a pole.
  if (p < 1e-9) {
    return { lat: z >= 0 ? 90 : -90, lon: 0, height: Math.abs(z) - b }
  }

  const theta = Math.atan2(z * WGS84_A, p * b)
  const sinTheta = Math.sin(theta)
  const cosTheta = Math.cos(theta)

  const lat = Math.atan2(
    z + ep2 * b * sinTheta * sinTheta * sinTheta,
    p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta,
  )
  const lon = Math.atan2(y, x)
  const height = p / Math.cos(lat) - primeVertical(lat)

  return { lat: lat / DEG, lon: lon / DEG, height }
}

/**
 * A region's local frame: an origin on the ellipsoid, and the conversions about it.
 *
 * One instance per region. The origin is stated in the region's data rather than
 * inferred, because "where is (0, 0)" is exactly the sort of thing that must not be
 * recomputed differently by two pieces of code.
 */
export class GeoFrame {
  private readonly originEcef: [number, number, number]
  private readonly sinLat: number
  private readonly cosLat: number
  private readonly sinLon: number
  private readonly cosLon: number

  constructor(readonly origin: LatLon) {
    this.originEcef = geodeticToEcef(origin.lat, origin.lon, 0)
    this.sinLat = Math.sin(origin.lat * DEG)
    this.cosLat = Math.cos(origin.lat * DEG)
    this.sinLon = Math.sin(origin.lon * DEG)
    this.cosLon = Math.cos(origin.lon * DEG)
  }

  /**
   * Latitude and longitude to world metres.
   *
   * `z` is negated on the way out because the renderer puts north at -Z. That single
   * minus sign is the frame convention the whole project is built on; it is asserted
   * in the tests rather than left to be discovered by flying east and ending up west.
   */
  toWorld(lat: number, lon: number): WorldXZ {
    const [ex, ey, ez] = geodeticToEcef(lat, lon, 0)
    const dx = ex - this.originEcef[0]
    const dy = ey - this.originEcef[1]
    const dz = ez - this.originEcef[2]

    const east = -this.sinLon * dx + this.cosLon * dy
    const north =
      -this.sinLat * this.cosLon * dx - this.sinLat * this.sinLon * dy + this.cosLat * dz

    return { x: east, z: -north }
  }

  /**
   * World metres back to latitude and longitude — the exact inverse of `toWorld`.
   *
   * Not an ECEF inverse. `toWorld` projects a point on the ellipsoid onto the tangent
   * plane and drops the up component, so simply reading the plane point back out
   * through ECEF answers a slightly different question: a point 55 km out on the
   * plane stands about 237 m *above* the ellipsoid, and converting it back lands 2 m
   * from where it started. Small, but a projection whose round trip does not close is
   * a projection that will be blamed for something else later.
   *
   * Newton on the forward map instead, seeded with the local radii. `toWorld` is
   * smooth and nearly linear at this scale, so it closes to well under a millimetre
   * in two passes; the third is there for the corners.
   */
  toLatLon(x: number, z: number): LatLon {
    const seedLatRad = this.origin.lat * DEG
    let lat = this.origin.lat + -z / (meridional(seedLatRad) * DEG)
    let lon =
      this.origin.lon + x / (primeVertical(seedLatRad) * Math.cos(seedLatRad) * DEG)

    for (let i = 0; i < 3; i++) {
      const p = this.toWorld(lat, lon)
      const latRad = lat * DEG
      lat += -(z - p.z) / (meridional(latRad) * DEG)
      lon += (x - p.x) / (primeVertical(latRad) * Math.cos(latRad) * DEG)
    }

    return { lat, lon }
  }

  /**
   * How far the local frame's north is from true north at a point, degrees.
   *
   * Meridian convergence. Zero at the origin and growing with east-west distance —
   * about 0.3 degrees at the edge of a 110 km region at mid latitude. It is small,
   * but a runway heading is quoted in degrees true and drawn in the local frame, so
   * the two disagree by exactly this and the disagreement is worth being able to
   * name rather than absorb silently.
   */
  convergenceDeg(lat: number, lon: number): number {
    return (lon - this.origin.lon) * Math.sin(lat * DEG)
  }
}
