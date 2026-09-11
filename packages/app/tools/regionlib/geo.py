"""
`terrain/geo.ts`, in Python.

This is a deliberate second implementation of code that already exists, which is
normally the wrong thing to do. The reason it is right here:

The builder resamples a raster given in latitude and longitude onto a grid defined
in the renderer's local metres. That resampling needs the *inverse* projection, and
it has to be the same inverse the browser will use at runtime — if the two disagree
by 40 m, every height in the region is read from 40 m away, and nothing about the
result looks wrong. It looks like a slightly different Manhattan.

A shared implementation is not available: the browser side is TypeScript in the
bundle and the builder is offline Python, and introducing a JS build step into the
data pipeline to avoid thirty lines of arithmetic would be the larger mistake.

So instead of trusting the port, it is **proved**. `emit_projection_fixture` writes
a set of (lat, lon) -> (x, z) pairs computed here, and `test/geo.test.ts` re-derives
every one of them through `GeoFrame` and requires sub-millimetre agreement. If this
file drifts from `geo.ts`, a TypeScript test fails, which is the only arrangement
that stays true after everyone has forgotten this comment exists.

Symbols and structure track `geo.ts` line for line on purpose; read them side by
side.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Semi-major axis, metres. Exact by definition. [S]
WGS84_A = 6_378_137.0

# Flattening. Exact by definition. [S]
WGS84_F = 1 / 298.257223563

# First eccentricity squared, derived.
WGS84_E2 = WGS84_F * (2 - WGS84_F)

DEG = math.pi / 180


def prime_vertical(lat_rad: float) -> float:
    """Radius of curvature in the prime vertical (east-west), metres."""
    s = math.sin(lat_rad)
    return WGS84_A / math.sqrt(1 - WGS84_E2 * s * s)


def meridional(lat_rad: float) -> float:
    """Radius of curvature in the meridian (north-south), metres."""
    s = math.sin(lat_rad)
    return (WGS84_A * (1 - WGS84_E2)) / (1 - WGS84_E2 * s * s) ** 1.5


def geodetic_to_ecef(lat: float, lon: float, height: float = 0.0) -> tuple[float, float, float]:
    lat_rad = lat * DEG
    lon_rad = lon * DEG
    n = prime_vertical(lat_rad)
    cos_lat = math.cos(lat_rad)
    sin_lat = math.sin(lat_rad)
    return (
        (n + height) * cos_lat * math.cos(lon_rad),
        (n + height) * cos_lat * math.sin(lon_rad),
        (n * (1 - WGS84_E2) + height) * sin_lat,
    )


@dataclass(frozen=True)
class LatLon:
    lat: float
    lon: float


class GeoFrame:
    """A region's local frame: an origin on the ellipsoid, and the conversions about it."""

    def __init__(self, origin: LatLon) -> None:
        self.origin = origin
        self._ecef = geodetic_to_ecef(origin.lat, origin.lon, 0.0)
        self._sin_lat = math.sin(origin.lat * DEG)
        self._cos_lat = math.cos(origin.lat * DEG)
        self._sin_lon = math.sin(origin.lon * DEG)
        self._cos_lon = math.cos(origin.lon * DEG)

    def to_world(self, lat: float, lon: float) -> tuple[float, float]:
        """Latitude and longitude to world metres. `z` is negated: the renderer puts north at -Z."""
        ex, ey, ez = geodetic_to_ecef(lat, lon, 0.0)
        dx = ex - self._ecef[0]
        dy = ey - self._ecef[1]
        dz = ez - self._ecef[2]

        east = -self._sin_lon * dx + self._cos_lon * dy
        north = (
            -self._sin_lat * self._cos_lon * dx
            - self._sin_lat * self._sin_lon * dy
            + self._cos_lat * dz
        )
        return east, -north

    def to_lat_lon(self, x: float, z: float) -> tuple[float, float]:
        """World metres back to latitude and longitude — Newton on the forward map."""
        seed = self.origin.lat * DEG
        lat = self.origin.lat + -z / (meridional(seed) * DEG)
        lon = self.origin.lon + x / (prime_vertical(seed) * math.cos(seed) * DEG)

        for _ in range(3):
            px, pz = self.to_world(lat, lon)
            lat_rad = lat * DEG
            lat += -(z - pz) / (meridional(lat_rad) * DEG)
            lon += (x - px) / (prime_vertical(lat_rad) * math.cos(lat_rad) * DEG)

        return lat, lon

    def convergence_deg(self, lat: float, lon: float) -> float:
        """How far the local frame's north is from true north at a point, degrees."""
        return (lon - self.origin.lon) * math.sin(lat * DEG)
