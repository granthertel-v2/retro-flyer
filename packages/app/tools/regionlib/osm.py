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


def stitch_rings(fragments: list[list[Point]]) -> list[list[Point]]:
    """
    Assemble multipolygon member ways into rings, reversing them as needed.

    This is deliberately *not* `join_ways`. The two look like the same problem and
    are opposite ones:

    - A **coastline** way's direction carries meaning — land is on the left — so a
      way may never be reversed, and two ways only join when one's end is the other's
      start.
    - A **multipolygon member** has no individual direction at all. The ring is
      whatever the fragments form when laid end to end, and roughly half of them will
      need turning round to do it.

    Joining multipolygon members with the coastline's rule looks like it nearly
    works, which is the dangerous part. Lake Michigan's 743 outer members came out as
    44 open chains with gaps of up to three degrees of latitude — the pieces were all
    there, half of them simply pointed the other way.
    """
    ends: dict[Point, list[int]] = {}
    for index, fragment in enumerate(fragments):
        if len(fragment) >= 2:
            ends.setdefault(fragment[0], []).append(index)
            ends.setdefault(fragment[-1], []).append(index)

    used: set[int] = set()
    rings: list[list[Point]] = []

    for seed, fragment in enumerate(fragments):
        if seed in used or len(fragment) < 2:
            continue
        used.add(seed)
        ring = list(fragment)

        # Grow from the end, then from the start, taking whichever fragment touches
        # and flipping it if it touches by its own end.
        for _ in range(2):
            while ring[0] != ring[-1]:
                tip = ring[-1]
                nxt = next((i for i in ends.get(tip, []) if i not in used), None)
                if nxt is None:
                    break
                used.add(nxt)
                piece = fragments[nxt]
                ring.extend((piece if piece[0] == tip else piece[::-1])[1:])
            ring.reverse()

        rings.append(ring)

    return rings


def _rings_of(element: dict) -> list[list[Point]]:
    """
    Every closed ring an element describes, as `(lon, lat)`.

    A **way** is one ring, closed if it is not already.

    A **relation** is a multipolygon, and this is where the obvious implementation is
    wrong in a way that only shows up on big features. A multipolygon's outer
    boundary is not one member — it is an arbitrary number of open fragments, in
    arbitrary directions, that have to be stitched (see `stitch_rings`). Lake
    Michigan's relation has 743 outer members and **not one of them is individually
    closed**. Treating each member as its own ring turns the lake into 743 slivers,
    which rasterise to almost nothing: the first Chicago build reported the region as
    2.9% water.

    Small multipolygons hide this completely. A park with one hole usually has a
    single closed way for its outer ring and another for the hole, so member-per-ring
    gives the right answer and keeps giving it until a feature is big enough to have
    been split up.

    Inner rings are reversed so they wind against their outer ring and cancel under
    the non-zero rule the rasteriser uses, which is what makes a hole a hole.
    """
    if "geometry" in element:
        ring = [(n["lon"], n["lat"]) for n in element["geometry"]]
        if len(ring) < 3:
            return []
        if ring[0] != ring[-1]:
            ring = ring + [ring[0]]
        return [ring]

    by_role: dict[str, list[list[Point]]] = {"outer": [], "inner": []}
    for member in element.get("members", []):
        geom = member.get("geometry")
        if not geom or len(geom) < 2:
            continue
        role = "inner" if member.get("role") == "inner" else "outer"
        by_role[role].append([(n["lon"], n["lat"]) for n in geom])

    rings: list[list[Point]] = []
    for role, fragments in by_role.items():
        if not fragments:
            continue
        for chain in stitch_rings(fragments):
            if len(chain) < 3:
                continue
            # A chain that does not meet itself is a boundary whose remaining pieces
            # were not returned. Closing it straight across is the standard repair
            # and is what every renderer of OSM data does; the alternative is to drop
            # a lake because one pier is missing from the extract.
            if chain[0] != chain[-1]:
                chain = chain + [chain[0]]
            if role == "inner":
                chain = chain[::-1]
            rings.append(chain)

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
        geom = element.get("geometry")
        if geom and len(geom) >= 2:
            # Raw, unclosed, and in the order the way was drawn: the direction is the
            # entire signal here, and closing a coastline way would destroy it.
            lines.append([(n["lon"], n["lat"]) for n in geom])
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
    # Aerodromes go down after the green layers, not with the other built-up land,
    # and the order is the whole point. Airports contain large mapped grass polygons;
    # painted in tag order the grass wins, the airfield reads as parkland, and
    # `scatter.ts` — which spares water, runway, city and sand, but not grass — grows
    # a forest across the infield at Kennedy. Painting the aerodrome last means an
    # airport stays an airport.
    Layer(
        "aerodromes",
        2,
        ('way["aeroway"="aerodrome"]', 'rel["aeroway"="aerodrome"]'),
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
        rings.extend(_rings_of(element))
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


def fetch_untagged_notable_buildings(
    south: float, west: float, north: float, east: float
) -> list[dict]:
    """
    Buildings with a Wikidata entity but no height OpenStreetMap can offer.

    Deliberately narrow: a Wikidata tag *and* no `height` *and* no `building:levels`.
    That is a few hundred per region rather than the tens of thousands an untagged
    building query would return, and it is exactly the set whose heights are worth
    going somewhere else for.
    """
    box = f"({south},{west},{north},{east})"
    body = f"""[out:json][timeout:900];
(
  way["building"]["wikidata"]["name"][!"height"][!"building:levels"]{box};
);
out geom;"""
    data = query(body, "notable buildings without heights")
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


# ---------------------------------------------------------------------------
# Places
# ---------------------------------------------------------------------------

#: Place kinds worth a label, most prominent first. The index is the rank stored in
#: the manifest, and it is what the minimap uses to decide what to draw as it zooms.
#:
#: `neighbourhood` is included, and is the one that earns its place least obviously.
#: Over open country the towns are what orient you; over a city they are useless,
#: because the whole view is one town. Flying across New York it is Astoria, Flatbush
#: and Red Hook that tell you where you are.
PLACE_RANKS = ("city", "borough", "town", "suburb", "village", "neighbourhood")

#: How many of each kind to keep, by rank. `[A]`
#:
#: A quota per kind rather than one cap over the ranked list, and the difference is
#: not subtle. New York's box holds 20 cities and 314 towns, so a flat cut at 250
#: filled up on towns and kept **no neighbourhoods at all** — which are exactly the
#: labels that matter over a city, where every name for fifty kilometres is "New
#: York" and what you actually want to know is that you are over Astoria.
#:
#: Each kind is taken by population, so the quota keeps the largest rather than the
#: alphabetically luckiest. The total is about 350 names, which is 30 KB of manifest
#: and more than the map will ever draw at once — thinning at draw time needs
#: material at every zoom, and this is what supplies it.
PLACE_QUOTAS = {
    "city": 40,
    "borough": 20,
    "town": 90,
    "suburb": 50,
    "village": 40,
    "neighbourhood": 120,
}


def fetch_places(
    south: float, west: float, north: float, east: float
) -> list[dict]:
    """Named places, ranked, for labelling a map."""
    kinds = "|".join(PLACE_RANKS)
    body = f"""[out:json][timeout:300];
node["place"~"^({kinds})$"]["name"]({south},{west},{north},{east});
out;"""   # `out tags` omits coordinates; a place without a position is not a place.
    data = query(body, "places")

    out: list[dict] = []
    for element in data.get("elements", []):
        tags = element.get("tags", {})
        kind = tags.get("place")
        if kind not in PLACE_RANKS:
            continue

        population = 0
        raw = tags.get("population")
        if raw:
            match = _NUMBER.search(raw)
            if match:
                population = int(float(match.group()))

        out.append(
            {
                "name": tags["name"],
                "lat": element["lat"],
                "lon": element["lon"],
                "rank": PLACE_RANKS.index(kind),
                "population": population,
            }
        )

    # Largest first within each kind, then the quota applied per kind. A city with no
    # population tag still outranks a neighbourhood with one, which is what keeps
    # Newark on the map and a named cul-de-sac off it.
    out.sort(key=lambda p: (p["rank"], -p["population"], p["name"]))

    kept: list[dict] = []
    taken: dict[int, int] = {}
    for place in out:
        rank = place["rank"]
        quota = PLACE_QUOTAS[PLACE_RANKS[rank]]
        if taken.get(rank, 0) >= quota:
            continue
        taken[rank] = taken.get(rank, 0) + 1
        kept.append(place)

    return kept


# ---------------------------------------------------------------------------
# Landmarks and bridges
# ---------------------------------------------------------------------------

#: What counts as a landmark, and how it is labelled.
#:
#: The filter is `wikidata`, not the tag itself, and that is the whole trick. New
#: York has 969 things tagged as attractions, monuments or memorials, and 506 of them
#: are plaques screwed to walls. Requiring a Wikidata entity cuts it to a couple of
#: hundred and keeps the ones a person would name — because somebody wrote an
#: encyclopaedia article about them, which is a better test of fame than any tag.
#:
#: Stadiums are exempt: they are enormous, unmistakable from the air, and a stadium
#: nobody has written about is still the thing you are looking at.
LANDMARK_SELECTORS = (
    'node["tourism"~"^(attraction|artwork|museum)$"]["name"]["wikidata"]',
    'way["tourism"~"^(attraction|artwork|museum)$"]["name"]["wikidata"]',
    'rel["tourism"~"^(attraction|artwork|museum)$"]["name"]["wikidata"]',
    'node["historic"="monument"]["name"]["wikidata"]',
    'way["historic"="monument"]["name"]["wikidata"]',
    'way["leisure"="stadium"]["name"]',
    'rel["leisure"="stadium"]["name"]',
    'node["man_made"~"^(lighthouse|obelisk|tower)$"]["name"]["wikidata"]',
    'way["man_made"~"^(lighthouse|obelisk|tower)$"]["name"]["wikidata"]',
)

#: Named buildings with an encyclopaedia entry. Matched against the tall buildings the
#: region already draws rather than kept wholesale — see `build_region.py`. Wikidata
#: alone would admit 1,287 named office blocks in New York; the tallest hundred of
#: them are the skyline, and the skyline is what wants labelling.
NAMED_BUILDING_SELECTORS = (
    'way["building"]["name"]["wikidata"]',
    'rel["building"]["name"]["wikidata"]',
)


def fetch_landmarks(south: float, west: float, north: float, east: float) -> list[dict]:
    """Notable named features, as points."""
    box = f"({south},{west},{north},{east})"
    selectors = "".join(f"  {sel}{box};\n" for sel in LANDMARK_SELECTORS)
    data = query(f"[out:json][timeout:600];\n(\n{selectors});\nout center tags;", "landmarks")

    out: list[dict] = []
    for element in data.get("elements", []):
        tags = element.get("tags", {})
        centre = element.get("center") or (
            {"lat": element.get("lat"), "lon": element.get("lon")}
        )
        if centre.get("lat") is None or centre.get("lon") is None:
            continue
        kind = (
            "stadium" if tags.get("leisure") == "stadium"
            else tags.get("man_made") or tags.get("historic") or tags.get("tourism") or "landmark"
        )
        out.append(
            {
                "name": tags["name"],
                "lat": centre["lat"],
                "lon": centre["lon"],
                "kind": kind,
                # A Wikipedia *article*, not just a Wikidata item. It is the sharper
                # of the two signals — 12 of Chicago's 42 mapped stadiums have one,
                # and they are the twelve anyone could name.
                "notable": bool(tags.get("wikipedia")),
            }
        )
    return out


def fetch_named_buildings(south: float, west: float, north: float, east: float) -> list[dict]:
    """Named buildings with a Wikidata entity, for matching against tall footprints."""
    box = f"({south},{west},{north},{east})"
    selectors = "".join(f"  {sel}{box};\n" for sel in NAMED_BUILDING_SELECTORS)
    data = query(
        f"[out:json][timeout:600];\n(\n{selectors});\nout center tags;", "named buildings"
    )

    out: list[dict] = []
    for element in data.get("elements", []):
        tags = element.get("tags", {})
        centre = element.get("center") or {"lat": element.get("lat"), "lon": element.get("lon")}
        if centre.get("lat") is None or centre.get("lon") is None:
            continue
        # `name:en` because Willis Tower carries its name only there.
        name = tags.get("name:en") or tags.get("name")
        if name:
            out.append(
                {
                    "name": name,
                    "lat": centre["lat"],
                    "lon": centre["lon"],
                    "notable": bool(tags.get("wikipedia")),
                }
            )
    return out


#: Shortest bridge worth drawing, metres. `[A]`
#:
#: Below this a bridge is a road over a road. Low enough to keep the Chicago River
#: bascules, which are about seventy metres and are the character of that riverfront.
MIN_BRIDGE_M = 60.0

#: Spacing along a bridge centreline, metres. Anything finer is detail the renderer
#: cannot show and manifest bytes nobody reads.
BRIDGE_STEP_M = 25.0

#: Highway kinds that are not the bridge. A big crossing has a footpath and a cycle
#: path alongside it, each a separate way with its own name — "Brooklyn Bridge
#: Bicycle Path", "Manhattan Bridge Pedestrian Path" — and they beat the roadway on
#: length, so the first pass produced a map of bike paths.
PATH_HIGHWAYS = {"footway", "cycleway", "path", "steps", "pedestrian", "corridor"}


def _metres_between(a: Point, b: Point) -> float:
    mid = math.radians((a[1] + b[1]) / 2)
    return math.hypot((b[0] - a[0]) * 111_320 * math.cos(mid), (b[1] - a[1]) * 111_320)


def _polyline_length(points: list[Point]) -> float:
    return sum(_metres_between(a, b) for a, b in zip(points, points[1:]))


def _simplify(points: list[Point], step: float = BRIDGE_STEP_M) -> list[Point]:
    """Thin a polyline to roughly `step` spacing, always keeping both ends."""
    if len(points) < 3:
        return points
    out = [points[0]]
    for p in points[1:-1]:
        if _metres_between(out[-1], p) >= step:
            out.append(p)
    out.append(points[-1])
    return out


def fetch_bridges(south: float, west: float, north: float, east: float) -> list[dict]:
    """
    Named bridges, as centrelines.

    Two sources, because neither alone finds the bridges anyone means:

    - **`man_made=bridge` areas** are the structure, and carry the structure's name.
      This is the only place the George Washington Bridge is called that — its
      carriageways are named after the road they carry, which is Interstate 95. The
      polygon's long axis is the centreline; bridges are straight, so a box fit
      through it is not an approximation worth apologising for.
    - **`bridge=yes` ways** catch the ones with no mapped structure, which is most of
      the smaller ones, including every bascule on the Chicago River.

    Merged by name, longest kept. Paths are excluded outright — see `PATH_HIGHWAYS`.
    """
    box = f"({south},{west},{north},{east})"
    best: dict[str, dict] = {}

    def offer(name: str, points: list[Point], rail: bool, lanes: int) -> None:
        if len(points) < 2:
            return
        length = _polyline_length(points)
        if length < MIN_BRIDGE_M:
            return
        if name in best and best[name]["lengthM"] >= length:
            return
        best[name] = {
            "name": name,
            "points": _simplify(points),
            "lengthM": length,
            "lanes": lanes,
            "rail": rail,
        }

    areas = query(
        f'[out:json][timeout:900];(way["man_made"="bridge"]["name"]{box};'
        f'rel["man_made"="bridge"]["name"]{box};);out geom;',
        "bridge structures",
    )
    for element in areas.get("elements", []):
        rings = _rings_of(element)
        if not rings:
            continue
        outline = max(rings, key=len)
        # Long axis of the structure, as a two-point centreline.
        lat0 = sum(p[1] for p in outline) / len(outline)
        k = 111_320 * math.cos(math.radians(lat0))
        flat = [((p[0] - outline[0][0]) * k, (p[1] - outline[0][1]) * 111_320) for p in outline]
        cx, cy, half_a, half_b, angle = oriented_box(flat)
        if max(half_a, half_b) * 2 < MIN_BRIDGE_M:
            continue
        if half_b > half_a:
            angle += math.pi / 2
            half_a = half_b
        ends = [
            (cx - math.cos(angle) * half_a, cy - math.sin(angle) * half_a),
            (cx + math.cos(angle) * half_a, cy + math.sin(angle) * half_a),
        ]
        points = [(outline[0][0] + ex / k, outline[0][1] + ey / 111_320) for ex, ey in ends]
        tags = element.get("tags", {})
        offer(tags["name"], points, "railway" in tags, 0)

    ways = query(
        f'[out:json][timeout:900];way["bridge"]["name"]{box};out geom;', "bridge ways"
    )
    for element in ways.get("elements", []):
        geometry = element.get("geometry") or []
        tags = element.get("tags", {})
        if tags.get("highway") in PATH_HIGHWAYS:
            continue
        lanes = 0
        raw = tags.get("lanes")
        if raw:
            match = _NUMBER.search(raw)
            if match:
                lanes = int(float(match.group()))
        offer(
            tags["name"],
            [(n["lon"], n["lat"]) for n in geometry],
            "railway" in tags,
            lanes,
        )

    return sorted(best.values(), key=lambda b: -b["lengthM"])
