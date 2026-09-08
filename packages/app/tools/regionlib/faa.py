"""
Airfields, from the FAA.

Runways are the one part of a region where being approximately right is not good
enough. Everything else in the map is scenery; a runway is a thing the aircraft
touches at 140 knots, and Day 3 already paid for getting the surface under the wheels
wrong once, at twelve g. So these values are `[V]` — quoted from the FAA's own
published data, with the source recorded in the manifest beside them.

## Where each number comes from

- **Length and width** are the FAA's published dimensions for the runway, not
  measured off the geometry. They agree to a tenth of a metre at LaGuardia, which is
  a reassuring cross-check, but the published figure is the authority.
- **Heading** is measured from the FAA's runway *polygon*, because the FAA does not
  publish a true bearing in this dataset and the painted designator cannot supply
  one. LaGuardia's 13/31 runs 122.1 degrees true; with about 13 degrees of westerly
  variation that is 135 magnetic, which would be painted "14". The designator is
  rounded to ten degrees and was assigned when the variation was different, so a
  heading taken from the number on the asphalt is wrong by up to eight degrees
  before anyone makes a mistake. Geometry does not drift.
- **Elevation** is the FAA's field elevation, and it is used to *flatten the terrain*
  rather than merely to record a fact. See `flatten_airfields` below, which exists
  because the elevation model and the FAA disagree about LaGuardia by eight metres.

## What is filtered out, and why

The runway layer contains more than runways. Alongside 04/22 and 13/31, LaGuardia
returns three enormous rectangles designated `N/S`, `NE/SW` and `NW/SE`, all sharing
one centre — airspace analysis surfaces, not pavement — and `H1`, a 45-foot helipad.
Real runway designators are numeric with an optional L/R/C, so that is the filter.
A helipad admitted by accident becomes a 14 m square runway that the terrain gets
flattened around.
"""

from __future__ import annotations

import math
import re
import urllib.parse
from dataclasses import dataclass

from .fetch import fetch
from .geo import GeoFrame
from .osm import oriented_box

SERVICE = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services"

ATTRIBUTION = "Airport and runway data: FAA Aeronautical Information Services, public domain."

#: `13/31`, `04L/22R`, `9/27`. Not `N/S`, `NE/SW`, `H1` — and not `08W/26W`.
#:
#: The `W` suffix means a *water* runway: a seaplane landing area. New York has three,
#: two of them in Jamaica Bay. Admitting one is not a cosmetic error — the builder
#: flattens the terrain to a runway's field elevation and `groundSource.ts` gives a
#: runway paved grip, so a seaplane lane would turn a square kilometre of Jamaica Bay
#: into hard, level ground you could land a fighter on.
RUNWAY_DESIGNATOR = re.compile(r"^\d{1,2}[LRC]?/\d{1,2}[LRC]?$")

#: `US_Airport.TYPE_CODE` for a landplane airport. The region's box also contains 119
#: heliports and 7 seaplane bases, and neither is a runway. Filtering on the FAA's own
#: classification is better than inferring it from the designator, so both are done:
#: this is the rule, and the designator pattern above is the backstop.
AIRPORT_TYPE_LANDPLANE = "AD"

FT_TO_M = 0.3048

#: Ignore anything shorter than this. `[A]` A 600 m strip is not somewhere an F-16
#: operates from, and admitting one costs a flattened pad in the middle of a city.
MIN_RUNWAY_LENGTH_M = 900.0


@dataclass
class Airfield:
    name: str
    icao: str | None
    lat: float
    lon: float
    elevation_m: float
    #: Degrees TRUE, of the lower-numbered runway end.
    heading_deg: float
    length_m: float
    width_m: float
    source: str


def _normalise_guid(value: str | None) -> str:
    """GUIDs appear with and without braces and in either case. One form, here."""
    return (value or "").strip().strip("{}").upper()


def _query(service: str, bbox: tuple[float, float, float, float], label: str) -> dict:
    import json

    params = {
        "where": "1=1",
        "geometry": ",".join(str(v) for v in bbox),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*",
        "outSR": "4326",
        "returnGeometry": "true",
        "f": "json",
        "resultRecordCount": "4000",
    }
    url = f"{SERVICE}/{service}/FeatureServer/0/query?{urllib.parse.urlencode(params)}"
    return json.loads(fetch(url, label=label))


def fetch_airfields(
    frame: GeoFrame,
    west: float,
    south: float,
    east: float,
    north: float,
    *,
    effective: str = "",
) -> list[Airfield]:
    """Every real runway in the box, as the manifest wants it written down."""
    bbox = (west, south, east, north)

    # The two layers join on a GUID, not on an identifier: a runway's `AIRPORT_ID`
    # is the airport's `GLOBAL_ID`, and the airport's own `IDENT` ("LGA") appears
    # nowhere on the runway. Normalised for case and for the braces some ArcGIS
    # layers wrap GUIDs in, because a join that silently matches nothing produces a
    # region with no airfields and no error.
    airports = _query("US_Airport", bbox, "FAA airports")
    by_guid: dict[str, dict] = {}
    for feature in airports.get("features", []):
        a = feature["attributes"]
        if (a.get("TYPE_CODE") or "").strip().upper() != AIRPORT_TYPE_LANDPLANE:
            continue
        guid = _normalise_guid(a.get("GLOBAL_ID"))
        if guid:
            by_guid[guid] = a

    runways = _query("Runways", bbox, "FAA runways")
    out: list[Airfield] = []

    for feature in runways.get("features", []):
        a = feature["attributes"]
        designator = (a.get("DESIGNATOR") or "").strip()
        if not RUNWAY_DESIGNATOR.match(designator):
            continue

        rings = feature.get("geometry", {}).get("rings")
        if not rings:
            continue

        # Measure in the region's own frame, so the heading that comes out is a
        # heading in the frame the region is drawn in — then converted to true at the
        # end. Doing it the other way round means projecting a bearing, which is the
        # kind of thing that is off by a third of a degree at the edge of the map and
        # impossible to find later.
        points = []
        for lon, lat in rings[0]:
            x, z = frame.to_world(lat, lon)
            points.append((x, -z))  # (east, north)

        cx, cy, half_a, half_b, angle = oriented_box(points)

        if half_a >= half_b:
            long_axis, local_length, local_width = angle, 2 * half_a, 2 * half_b
        else:
            long_axis, local_length, local_width = angle + math.pi / 2, 2 * half_b, 2 * half_a

        if local_length < MIN_RUNWAY_LENGTH_M:
            continue

        lat, lon = frame.to_lat_lon(cx, -cy)

        # Bearing of the long axis in the local frame, then to true. `region.ts`
        # subtracts the convergence back off when it reads the manifest, so this is
        # the exact inverse of what the runtime does and the pair round-trips.
        local_heading = (90.0 - math.degrees(long_axis)) % 180.0
        heading_true = (local_heading + frame.convergence_deg(lat, lon)) % 360.0

        # Published dimensions win over measured ones. `DIM_UOM` is feet in this
        # dataset but is not assumed to be.
        uom = (a.get("DIM_UOM") or "FT").upper()
        scale = FT_TO_M if uom.startswith("F") else 1.0
        length_m = float(a["LENGTH"]) * scale if a.get("LENGTH") else local_length
        width_m = float(a["WIDTH"]) * scale if a.get("WIDTH") else local_width

        airport = by_guid.get(_normalise_guid(a.get("AIRPORT_ID")))
        if airport is None or airport.get("ELEVATION") is None:
            continue
        ident = airport.get("IDENT") or ""

        out.append(
            Airfield(
                name=f"{str(airport.get('NAME') or ident).strip()} {designator}".strip(),
                icao=airport.get("ICAO_ID") or None,
                lat=lat,
                lon=lon,
                elevation_m=float(airport["ELEVATION"]) * FT_TO_M,
                heading_deg=heading_true,
                length_m=length_m,
                width_m=width_m,
                source=(
                    f"FAA Aeronautical Information Services, Runways and US_Airport layers"
                    + (f" ({effective})" if effective else "")
                    + f"; airport {ident}, runway {designator}. "
                    "Length and width as published; heading measured from the FAA runway polygon; "
                    "elevation is the published field elevation."
                ),
            )
        )

    out.sort(key=lambda f: -f.length_m)
    return out
