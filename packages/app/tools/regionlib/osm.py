"""
OpenStreetMap: what the ground is, and what is standing on it.

Two products come out of here, and they are shaped very differently.

**Land cover** is a handful of thousand polygons — parks, woods, residential areas,
beaches, rivers — that get painted onto the surface-class raster. Coverage matters
more than precision: a park half a cell out of place is invisible, a missing park is
a grey hole in the middle of the map.

**Buildings** are the opposite. There are over a million building footprints in the
New York core alone, and downloading them is out of the question before shipping them
even comes up. What is wanted is the skyline, so the query filters by height on the
server and only tall buildings ever cross the network.

## Licence

OpenStreetMap is ODbL. Derived data carries the obligation with it, which is why the
attribution string below ends up inside the region manifest rather than in a README
somewhere: a region file that gets copied out of this repository takes its licence
with it.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass

from .fetch import fetch

OVERPASS = "https://overpass-api.de/api/interpreter"

ATTRIBUTION = "Map data © OpenStreetMap contributors, ODbL (openstreetmap.org/copyright)."

Point = tuple[float, float]


def query(body: str, label: str) -> dict:
    """Run an Overpass QL query and parse the result."""
    raw = fetch(OVERPASS, post={"data": body}, label=label, timeout=600)
    return json.loads(raw)


def _geometry(element: dict) -> list[list[Point]]:
    """
    Every ring or line an element carries, as `(lon, lat)` lists.

    Handles both shapes Overpass returns under `out geom`: a way has a single
    `geometry`, a relation has `members`, each with its own. Relation members with
    role `inner` are returned reversed, so that a multipolygon's holes are wound
    against its outer ring and cancel under the non-zero rule the rasteriser uses.
    """
    if "geometry" in element:
        return [[(n["lon"], n["lat"]) for n in element["geometry"]]]

    rings: list[list[Point]] = []
    for member in element.get("members", []):
        geom = member.get("geometry")
        if not geom:
            continue
        pts = [(n["lon"], n["lat"]) for n in geom]
        if member.get("role") == "inner":
            pts.reverse()
        rings.append(pts)
    return rings


# ---------------------------------------------------------------------------
# Coastline
# ---------------------------------------------------------------------------

def fetch_coastline(south: float, west: float, north: float, east: float) -> list[list[Point]]:
    """Every `natural=coastline` way crossing the box, as `(lon, lat)` lines."""
    body = f"""[out:json][timeout:600];
way["natural"="coastline"]({south},{west},{north},{east});
out geom;"""
    data = query(body, "coastline")
    lines: list[list[Point]] = []
    for element in data.get("elements", []):
        lines.extend(g for g in _geometry(element) if len(g) >= 2)
    return lines


# ---------------------------------------------------------------------------
# Land cover
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Layer:
    """One paint pass: an Overpass selector, and the class it paints."""

    name: str
    #: Surface class, matching the `Surface` enum in `src/terrain/source.ts`.
    surface: int
    #: Overpass selectors, without the bounding box — added when the query is built.
    selectors: tuple[str, ...]


#: Land cover, in painting order: later layers paint over earlier ones.
#:
#: The order is the whole design. Residential goes down first and covers most of the
#: region's land; commercial and industrial overwrite it where the ground is properly
#: built up; then woods, then open green, then sand — each one a thing that should
#: still be visible when it sits inside something else. Central Park is inside
#: Manhattan and has to win, which is why the green layers come after the built ones
#: rather than before.
#:
#: Inland water goes last of all, because a river is the one thing that should never
#: be painted over. `[A]` throughout — these are visual choices, not data.
LAND_COVER: tuple[Layer, ...] = (
    Layer("residential", 7, ('way["landuse"="residential"]', 'rel["landuse"="residential"]')),
    Layer(
        "built-up",
        2,
        (
            'way["landuse"~"^(commercial|retail|industrial|port|railway)$"]',
            'rel["landuse"~"^(commercial|retail|industrial|port|railway)$"]',
            'way["aeroway"="aerodrome"]',
            'rel["aeroway"="aerodrome"]',
        ),
    ),
    Layer(
        "woods",
        4,
        (
            'way["natural"="wood"]',
            'rel["natural"="wood"]',
            'way["landuse"="forest"]',
            'rel["landuse"="forest"]',
        ),
    ),
    Layer(
        "open green",
        5,
        (
            'way["leisure"~"^(park|golf_course|nature_reserve|pitch|garden)$"]',
            'rel["leisure"~"^(park|golf_course|nature_reserve)$"]',
            'way["landuse"~"^(grass|meadow|recreation_ground|cemetery|allotments|farmland|village_green)$"]',
            'rel["landuse"~"^(grass|meadow|recreation_ground|cemetery|farmland)$"]',
            'way["natural"~"^(grassland|scrub|heath)$"]',
        ),
    ),
    Layer(
        "sand",
        6,
        ('way["natural"~"^(beach|sand|shingle)$"]', 'rel["natural"~"^(beach|sand)$"]'),
    ),
    Layer(
        "inland water",
        0,
        (
            'way["natural"="water"]',
            'rel["natural"="water"]',
            'way["waterway"="riverbank"]',
            'way["landuse"~"^(reservoir|basin)$"]',
            'rel["landuse"~"^(reservoir|basin)$"]',
        ),
    ),
)


def fetch_layer(
    layer: Layer, south: float, west: float, north: float, east: float
) -> list[list[Point]]:
    """Every ring belonging to one land-cover layer, as `(lon, lat)`."""
    box = f"({south},{west},{north},{east})"
    selectors = "".join(f"  {s}{box};\n" for s in layer.selectors)
    body = f"""[out:json][timeout:600];
(
{selectors});
out geom;"""
    data = query(body, f"land cover: {layer.name}")

    rings: list[list[Point]] = []
    for element in data.get("elements", []):
        for ring in _geometry(element):
            if len(ring) >= 3:
                # Rings from `out geom` are usually closed already; the ones that are
                # not are areas mapped as unclosed ways, and a fill needs them closed.
                if ring[0] != ring[-1]:
                    ring = ring + [ring[0]]
                rings.append(ring)
    return rings


# ---------------------------------------------------------------------------
# Buildings
# ---------------------------------------------------------------------------

#: Metres per storey when only a floor count is known. `[A]`
#:
#: Three metres is the usual floor-to-floor for housing and a little short for
#: offices; 3.05 is 10 feet, which is what most of the American building stock this
#: will ever see was actually laid out in. The choice moves a twenty-storey tower by
#: one storey, which is below what anyone can judge from an aircraft.
METRES_PER_LEVEL = 3.05

#: Height for a building with neither a height nor a floor count. `[A]`
#:
#: Only reachable for buildings that passed the height filter by having a `height`
#: tag that then failed to parse, so it is close to dead code — but a building drawn
#: at zero height is a flat plate on the ground, and a visible one, so there has to
#: be an answer.
FALLBACK_HEIGHT_M = 12.0

_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def parse_height(tags: dict[str, str]) -> float | None:
    """
    A building's height in metres, from whatever the mapper wrote.

    OSM heights are free text in practice. Metres is the documented unit and the
    common case, but feet appear both as `40'` and as `40 ft`, and a stray unit
    suffix is normal. Anything with no number in it at all returns `None` rather than
    a guess — a building of unknown height is better dropped than invented.
    """
    raw = tags.get("height") or tags.get("building:height")
    if raw:
        text = raw.strip().lower()
        match = _NUMBER.search(text)
        if match:
            value = float(match.group())
            if "'" in text or "ft" in text or "feet" in text:
                value *= 0.3048
            if 0 < value < 1000:
                return value

    levels = tags.get("building:levels")
    if levels:
        match = _NUMBER.search(levels)
        if match:
            value = float(match.group())
            if 0 < value < 250:
                return value * METRES_PER_LEVEL

    return None


def fetch_buildings(
    south: float, west: float, north: float, east: float, min_height_m: float
) -> list[dict]:
    """
    Tall buildings only, filtered on the server.

    The filter is the reason this is possible at all. The New York core holds over a
    million building footprints; at twenty metres — six storeys and up — it holds
    about twenty thousand, which is a skyline rather than a city plan, and that is
    exactly what a flight simulator wants to see from the pattern.

    `building:levels` is converted to a height in the query as well as here, so a
    tower that gave its floor count instead of its height is not silently missed.
    """
    box = f"({south},{west},{north},{east})"
    levels_cut = max(1, int(min_height_m / METRES_PER_LEVEL))
    body = f"""[out:json][timeout:900];
(
  way["building"]["height"](if: number(t["height"]) >= {min_height_m}){box};
  way["building"]["building:levels"](if: number(t["building:levels"]) >= {levels_cut}){box};
);
out geom;"""
    data = query(body, f"buildings >= {min_height_m:g} m")
    return [e for e in data.get("elements", []) if e.get("geometry")]


def _convex_hull(points: list[Point]) -> list[Point]:
    """Andrew's monotone chain. Returns the hull counter-clockwise."""
    pts = sorted(set(points))
    if len(pts) < 3:
        return pts

    def half(seq):
        out: list[Point] = []
        for p in seq:
            while len(out) >= 2:
                (x1, y1), (x2, y2) = out[-2], out[-1]
                if (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1) > 0:
                    break
                out.pop()
            out.append(p)
        return out

    return half(pts)[:-1] + half(reversed(pts))[:-1]


def oriented_box(points: list[Point]) -> tuple[float, float, float, float, float]:
    """
    Smallest-area rectangle around a footprint: `(cx, cy, half_a, half_b, angle)`.

    The renderer draws every building as a box, so a footprint has to become one. An
    axis-aligned bounding box would do it, and would turn every building that is not
    aligned with north into a fat blob — which in Manhattan is all of them, since the
    street grid runs 29 degrees off north. Rotating the box to the footprint keeps the
    grid's diagonal sweep, and that sweep is most of what makes the city recognisable
    from the air.

    A minimum-area rectangle always has a side flush with an edge of the convex hull,
    so testing each hull edge as the orientation finds it exactly. Hulls here have a
    handful of vertices, so exact is also cheap.
    """
    hull = _convex_hull(points)
    if len(hull) < 3:
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        cx = (min(xs) + max(xs)) / 2
        cy = (min(ys) + max(ys)) / 2
        return cx, cy, max(1.0, (max(xs) - min(xs)) / 2), max(1.0, (max(ys) - min(ys)) / 2), 0.0

    best = None
    for k in range(len(hull)):
        ax, ay = hull[k]
        bx, by = hull[(k + 1) % len(hull)]
        edge = math.hypot(bx - ax, by - ay)
        if edge < 1e-9:
            continue
        ux, uy = (bx - ax) / edge, (by - ay) / edge

        us = [(p[0] - ax) * ux + (p[1] - ay) * uy for p in hull]
        vs = [-(p[0] - ax) * uy + (p[1] - ay) * ux for p in hull]
        area = (max(us) - min(us)) * (max(vs) - min(vs))

        if best is None or area < best[0]:
            um = (max(us) + min(us)) / 2
            vm = (max(vs) + min(vs)) / 2
            best = (
                area,
                ax + um * ux - vm * uy,
                ay + um * uy + vm * ux,
                (max(us) - min(us)) / 2,
                (max(vs) - min(vs)) / 2,
                math.atan2(uy, ux),
            )

    _, cx, cy, ha, hb, angle = best
    return cx, cy, max(0.5, ha), max(0.5, hb), angle
