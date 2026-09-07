/**
 * The geodetic projection.
 *
 * Every coordinate in a real-world region — runway thresholds, coastlines, buildings
 * — comes through `GeoFrame`, so an error here moves an entire city and does it
 * consistently enough to look deliberate. It is also invisible: a runway 400 m from
 * where it should be still looks like a runway.
 *
 * So the checks below never compare against a number this file could have produced.
 * Distances are recomputed from the WGS-84 defining constants with the *standard
 * radius-of-curvature formulae*, which share no code path with the ECEF construction
 * under test — the same tactic `hud.test.ts` uses when it writes out a rotation
 * matrix by hand rather than reusing the helper it is checking.
 */

import { describe, expect, it } from 'vitest'
import { GeoFrame, WGS84_A, WGS84_E2, WGS84_F, ecefToGeodetic, geodeticToEcef } from '../src/terrain/geo.js'

const DEG = Math.PI / 180

/** LaGuardia, near enough. Only used as a mid-latitude origin to exercise. */
const LGA = { lat: 40.7772, lon: -73.8726 }

/** Radius of curvature in the prime vertical — the east-west radius. */
const N = (lat: number): number =>
  WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat * DEG) ** 2)

/** Meridional radius of curvature — the north-south radius. Different, and that is the point. */
const M = (lat: number): number =>
  (WGS84_A * (1 - WGS84_E2)) / (1 - WGS84_E2 * Math.sin(lat * DEG) ** 2) ** 1.5

describe('WGS-84 constants', () => {
  it('are the defining ones, not approximations of them', () => {
    expect(WGS84_A).toBe(6_378_137.0)
    expect(1 / WGS84_F).toBeCloseTo(298.257223563, 9)
    // Derived, and small: the Earth is very nearly a sphere.
    expect(WGS84_E2).toBeCloseTo(0.0066943799901, 12)
  })
})

describe('ECEF round trip', () => {
  it('returns what it was given, at a spread of latitudes', () => {
    for (const [lat, lon] of [[0, 0], [40.7772, -73.8726], [-33.9, 151.2], [71.2, -156.8]] as const) {
      const [x, y, z] = geodeticToEcef(lat, lon, 0)
      const back = ecefToGeodetic(x, y, z)
      expect(back.lat).toBeCloseTo(lat, 9)
      expect(back.lon).toBeCloseTo(lon, 9)
      expect(back.height).toBeCloseTo(0, 6)
    }
  })

  it('puts the equator and prime meridian where they belong', () => {
    const [x, y, z] = geodeticToEcef(0, 0, 0)
    expect(x).toBeCloseTo(WGS84_A, 6)
    expect(y).toBeCloseTo(0, 6)
    expect(z).toBeCloseTo(0, 6)
  })

  it('is flattened at the poles by exactly the defining flattening', () => {
    const [, , z] = geodeticToEcef(90, 0, 0)
    expect(z).toBeCloseTo(WGS84_A * (1 - WGS84_F), 6)
  })
})

describe('GeoFrame', () => {
  const frame = new GeoFrame(LGA)

  it('puts the origin at the origin', () => {
    const p = frame.toWorld(LGA.lat, LGA.lon)
    expect(p.x).toBeCloseTo(0, 6)
    expect(p.z).toBeCloseTo(0, 6)
  })

  it('puts east at +X and north at -Z', () => {
    // The frame convention the whole renderer is built on. Getting this backwards
    // mirrors the world, which is survivable to look at and fatal to navigate.
    const east = frame.toWorld(LGA.lat, LGA.lon + 0.01)
    const north = frame.toWorld(LGA.lat + 0.01, LGA.lon)

    expect(east.x).toBeGreaterThan(0)
    expect(east.z).toBeCloseTo(0, 1)
    expect(north.z).toBeLessThan(0)
    expect(north.x).toBeCloseTo(0, 1)
  })

  it('spaces longitude by the prime-vertical radius, not by a single earth radius', () => {
    const d = 0.001
    const p = frame.toWorld(LGA.lat, LGA.lon + d)
    const expected = N(LGA.lat) * Math.cos(LGA.lat * DEG) * d * DEG
    expect(p.x).toBeCloseTo(expected, 3)
  })

  it('spaces latitude by the meridional radius, which is a different number', () => {
    const d = 0.001
    const p = frame.toWorld(LGA.lat + d, LGA.lon)
    const expected = M(LGA.lat) * d * DEG
    expect(-p.z).toBeCloseTo(expected, 3)
  })

  it('really is on an ellipsoid — a sphere would be measurably wrong here', () => {
    // If the implementation quietly used one radius for both axes, the two tests
    // above could still pass with a well-chosen constant. This pins that the two
    // radii genuinely differ, and by how much: about 0.55% at this latitude.
    // Measured 1.00386 at this latitude. Asserted as a band rather than a constant
    // because the point is that the two radii differ at all, not what the fourth
    // decimal is.
    const ratio = N(LGA.lat) / M(LGA.lat)
    expect(ratio).toBeGreaterThan(1.003)
    expect(ratio).toBeLessThan(1.005)

    const d = 0.001
    const east = frame.toWorld(LGA.lat, LGA.lon + d).x
    const northMetres = -frame.toWorld(LGA.lat + d, LGA.lon).z
    const sphere = WGS84_A * d * DEG

    // East is shortened by cos(latitude) — a quarter shorter at this latitude.
    expect(east / sphere).toBeGreaterThan(0.75)
    expect(east / sphere).toBeLessThan(0.77)

    // North is not shortened by latitude, but it is not the sphere either: the
    // meridional radius is smaller than `a`, by about a quarter of a percent here.
    // Asserted as a ratio so the check does not depend on the baseline chosen.
    expect(northMetres / sphere).toBeGreaterThan(0.996)
    expect(northMetres / sphere).toBeLessThan(0.999)
  })

  it('round-trips across the whole span of a region', () => {
    // 55 km is the half-width the authored map uses, so this is the real working
    // range rather than a comfortable one.
    for (const [dx, dz] of [[0, 0], [55_000, 0], [-55_000, 0], [0, 55_000], [-40_000, 40_000]] as const) {
      const ll = frame.toLatLon(dx, dz)
      const back = frame.toWorld(ll.lat, ll.lon)
      expect(back.x).toBeCloseTo(dx, 3)
      expect(back.z).toBeCloseTo(dz, 3)
    }
  })

  it('reports meridian convergence, zero on the origin meridian', () => {
    expect(frame.convergenceDeg(LGA.lat, LGA.lon)).toBeCloseTo(0, 12)
    // Half a degree of longitude east at this latitude is about a third of a degree
    // of convergence — small, but a runway heading is quoted true and drawn local.
    const c = frame.convergenceDeg(LGA.lat, LGA.lon + 0.5)
    expect(c).toBeGreaterThan(0.3)
    expect(c).toBeLessThan(0.34)
  })
})
