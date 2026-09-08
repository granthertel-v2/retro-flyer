#!/usr/bin/env python3
"""
Build a real-world region: a manifest, a blob, and the provenance for both.

    python3 tools/build_region.py regions/new-york.json

Outputs land in `public/regions/`, and are **committed**. This is the same bargain
`packages/physics/tools/` makes with its golden fixtures: the generator needs Python
and a network, the repository needs only Node, and CI stays hermetic. A clean
checkout builds and flies without ever running this file.

## What it does, in order

1. **Airfields first.** They come from the FAA, and everything else has to be built
   around them — the elevation tiers get flattened to the published field elevation,
   so the runways have to be known before the terrain is written.
2. **Elevation**, one USGS request per tier, resampled onto the tier's metric grid
   through the projection proved in `test/geo.test.ts`.
3. **Land**, assembled from OpenStreetMap coastline. The sea is not an object in OSM,
   so the raster starts as water and land is filled in — see `coastline.py`.
4. **Land cover** painted over the land, then **dense city** derived from where the
   tall buildings actually stand.
5. **Buildings**, filtered to a skyline on the server.

## Why the airfields are flattened

The elevation model and the FAA disagree, and not slightly. USGS puts LaGuardia's
13/31 midpoint at 1.96 m, the other runway at 4.38 m and the terminal apron at
**minus 1.62 m**; the FAA publishes the field at 6.31 m. Both were checked against the
USGS point service independently, so this is the data and not a decoding error — the
airport is landfill in Flushing Bay and the bare-earth model over it is poor.

Shipping that as terrain means a runway laid across eight metres of slope, which is a
hill you land on. So the tiers are flattened to the published elevation across the
runway and a pad around it, then ramped out to the real terrain — exactly what
`authored.ts` does for the same reason ("a runway with a hill through it is not a
runway"), and what the 150 m flat pad in `source.ts` already promises the physics.
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from regionlib import dem as dem_mod  # noqa: E402
from regionlib import faa as faa_mod  # noqa: E402
from regionlib import osm as osm_mod  # noqa: E402
from regionlib import wikidata as wikidata_mod  # noqa: E402
from regionlib.coastline import Rect, clip_chain, close_rings, join_ways  # noqa: E402
from regionlib.geo import GeoFrame, LatLon  # noqa: E402
from regionlib.raster import Grid  # noqa: E402

OUT_DIR = HERE.parent / "public" / "regions"

#: Metres per Int16 step. Matches `heightScaleM` in the manifest and gives +/- 8,191 m
#: of range at a quarter-metre step.
HEIGHT_SCALE_M = 0.25

# Surface classes. These mirror `Surface` in `src/terrain/source.ts`; the enum is a
# `const enum` and therefore has no runtime representation to import, so the two are
# kept in step by `test/region.test.ts`, which asserts the committed manifest's
# classes are the ones the enum names.
WATER, LAND, CITY, RUNWAY, FOREST, GRASS, SAND, SUBURB = range(8)

#: Land classes, for `only_over`: what land cover is allowed to paint onto. Water is
#: excluded so a sloppy park boundary cannot colour the harbour.
LAND_CLASSES = {LAND, CITY, FOREST, GRASS, SAND, SUBURB}

#: Continuous water a bridge must span before it counts as one. `[A]`
#:
#: A hundred metres of open water under it. Short enough for the Chicago River
#: bascules, long enough that a road running along an embankment is not a bridge.
MIN_WATER_SPAN_M = 100.0

#: Most bridges to keep, longest first. `[A]` Fifty is every crossing anyone could
#: name in either region and about 25 KB of manifest.
MAX_BRIDGES = 50

#: How many landmarks to keep of each kind. `[A]`
#:
#: Generous, and deliberately so. A tighter set was tried first and it was the wrong
#: instinct: the map thins labels by collision when it draws them, so extra entries
#: cost nothing on screen, and the only real budget is manifest bytes — which at
#: these numbers is about 25 KB. Squeezing the quotas produced a steady trickle of
#: absurd near-misses instead, most memorably a New York with no Statue of Liberty
#: because it is five kilometres from downtown and lost a tie-break to Manhattan.
#:
#: The cap exists to stop 146 museums and 506 memorial plaques, not to curate.
LANDMARK_QUOTAS = {
    "stadium": 25, "tower": 70, "bridge": 12, "monument": 25, "obelisk": 6,
    "lighthouse": 14, "attraction": 60, "museum": 25, "artwork": 30, "memorial": 8,
    # Notable buildings with no height tag, so never drawn. Their own quota rather
    # than competing with `tower`, where a missing height sorts them last by
    # construction and they would never survive.
    "building": 80,
}
LANDMARK_DEFAULT_QUOTA = 4

#: Tall buildings in a three-by-three neighbourhood of surface cells before the
#: ground under them counts as dense city rather than whatever the land-use tags
#: said. `[A]`
#:
#: The neighbourhood is 360 m square, about 13 hectares — three or four Manhattan
#: blocks. Three towers in that is a downtown; one or two is a tower, which happens
#: in the middle of low-rise suburbs and should not turn the neighbourhood grey.
DENSE_BUILDINGS_PER_NEIGHBOURHOOD = 3

#: Flat pad beyond the runway rectangle, metres. `[A]`
#:
#: `source.ts` states that the apron is dead flat for 150 m beyond every runway and
#: relies on it: the 12 cm runway lift is ramped out over 60 m and needs to finish
#: well inside flat ground. This is that promise, kept for real terrain.
PAD_M = 150.0

#: Distance over which the flattened pad blends back into the elevation model. `[A]`
#:
#: Long enough that the worst case here — eight metres at LaGuardia — becomes a 2.3%
#: slope, which is a shallow rise rather than a wall, and far enough outside the pad
#: that the physics never meets it on a landing roll.
FLATTEN_RAMP_M = 350.0


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge0 == edge1:
        return 0.0 if x < edge0 else 1.0
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def signed_distance_to_rect(
    x: float, z: float, cx: float, cz: float, half_len: float, half_wid: float, heading_rad: float
) -> float:
    """
    Distance outside a rotated rectangle; negative inside. Mirrors `source.ts`.

    The runway rectangle used here has to be the same rectangle the runtime uses for
    `runwayLift` and `onRunway`, or the terrain is flattened somewhere other than
    where the strip is drawn and the lift is applied.
    """
    s = math.sin(heading_rad)
    c = math.cos(heading_rad)
    dx = x - cx
    dz = z - cz
    # Along the runway, and across it.
    along = dx * s - dz * c
    across = dx * c + dz * s
    ox = abs(along) - half_len
    oz = abs(across) - half_wid
    if ox > 0 or oz > 0:
        return math.hypot(max(ox, 0.0), max(oz, 0.0))
    return max(ox, oz)


def build(spec_path: Path) -> None:
    spec = json.loads(spec_path.read_text())
    origin = LatLon(spec["origin"]["lat"], spec["origin"]["lon"])
    frame = GeoFrame(origin)
    extent = float(spec["extentM"])

    print(f'building region "{spec["id"]}" ({spec["name"]})')
    print(f"  origin {origin.lat}, {origin.lon}   half-width {extent / 1000:.1f} km")

    # The geographic box that contains the region square. Computed from the corners
    # rather than from a metres-per-degree estimate, because the square's corners are
    # its extreme points in latitude and longitude and an estimate would clip them.
    corners = [
        frame.to_lat_lon(sx * extent, sz * extent) for sx in (-1, 1) for sz in (-1, 1)
    ]
    lats = [c[0] for c in corners]
    lons = [c[1] for c in corners]
    # A margin, so polygons that straddle the edge are complete enough to clip.
    margin = 0.05
    south, north = min(lats) - margin, max(lats) + margin
    west, east = min(lons) - margin, max(lons) + margin
    print(f"  geographic box {south:.4f}..{north:.4f} N, {west:.4f}..{east:.4f} E")

    # -----------------------------------------------------------------------
    # 1. Airfields
    # -----------------------------------------------------------------------
    print("\nairfields")
    airfields = faa_mod.fetch_airfields(frame, west, south, east, north)
    inside = []
    for f in airfields:
        x, z = frame.to_world(f.lat, f.lon)
        if abs(x) <= extent and abs(z) <= extent:
            inside.append((f, x, z))
    print(f"  {len(inside)} runways inside the region")
    for f, x, z in inside[:12]:
        print(
            f"    {f.name:44} {f.length_m:7.1f} x {f.width_m:5.1f} m  "
            f"{f.heading_deg:6.1f} deg true  {f.elevation_m:6.2f} m"
        )
    if len(inside) > 12:
        print(f"    ... and {len(inside) - 12} more")

    runway_rects = [
        (x, z, f.length_m / 2, f.width_m / 2, math.radians(f.heading_deg - frame.convergence_deg(f.lat, f.lon)), f.elevation_m)
        for f, x, z in inside
    ]

    def flattened(x: float, z: float, ground: float) -> float:
        """Terrain height with the airfields flattened into it."""
        best = ground
        weight = 0.0
        for cx, cz, hl, hw, heading, elevation in runway_rects:
            d = signed_distance_to_rect(x, z, cx, cz, hl + PAD_M, hw + PAD_M, heading)
            if d >= FLATTEN_RAMP_M:
                continue
            w = smoothstep(FLATTEN_RAMP_M, 0.0, max(d, 0.0))
            if w > weight:
                weight = w
                best = elevation
        return ground + (best - ground) * weight

    # -----------------------------------------------------------------------
    # 2. Elevation tiers
    # -----------------------------------------------------------------------
    #
    # The spec's own tiers cover the region and the ground it is flown over. They do
    # not necessarily cover the outlying airfields, and a runway resolved only by the
    # coarse tier is a problem rather than a cosmetic loss: at 240 m cells, the flat
    # pad around Westchester's runway is 346 m across — one and a half cells — so the
    # flattening cannot resolve and the runway ends up laid over lumpy ground at an
    # airport that sits at 134 m in hilly country.
    #
    # So a fine tier is added around every airfield the spec's tiers do not already
    # reach. This is what `region.ts` means by keeping the tier list open-ended: a few
    # kilometres of 60 m ground around an airfield costs about twenty kilobytes, and
    # it is a data decision rather than a change to the format.
    extra = spec.get("airfieldTier")
    if extra and inside:
        cell_m = float(extra["cellM"])
        span_m = float(extra["spanM"])
        covered = []
        for tier_spec in spec["tiers"]:
            if float(tier_spec["cellM"]) > cell_m:
                continue
            if "centre" in tier_spec:
                tx, tz = frame.to_world(tier_spec["centre"]["lat"], tier_spec["centre"]["lon"])
            else:
                tx = tz = 0.0
            covered.append((tx, tz, float(tier_spec["spanM"]) / 2))

        clusters: list[list[tuple[float, float]]] = []
        for _f, fx, fz in inside:
            if any(abs(fx - cx) <= h and abs(fz - cz) <= h for cx, cz, h in covered):
                continue
            for cluster in clusters:
                if any(math.hypot(fx - px, fz - pz) < span_m / 2 for px, pz in cluster):
                    cluster.append((fx, fz))
                    break
            else:
                clusters.append([(fx, fz)])

        for cluster in clusters:
            cx = sum(p[0] for p in cluster) / len(cluster)
            cz = sum(p[1] for p in cluster) / len(cluster)
            lat, lon = frame.to_lat_lon(cx, cz)
            spec["tiers"].append(
                {"cellM": cell_m, "spanM": span_m, "centre": {"lat": lat, "lon": lon}}
            )
        if clusters:
            print(f"\n  {len(clusters)} outlying airfield clusters get their own {cell_m:g} m tier")

    print("\nelevation")
    tiers: list[dict] = []
    for index, tier_spec in enumerate(spec["tiers"]):
        cell_m = float(tier_spec["cellM"])
        span_m = float(tier_spec["spanM"])
        cells = int(round(span_m / cell_m)) + 1

        if "centre" in tier_spec:
            cx, cz = frame.to_world(tier_spec["centre"]["lat"], tier_spec["centre"]["lon"])
        else:
            cx = cz = 0.0

        half = (cells - 1) * cell_m / 2
        tier_corners = [
            frame.to_lat_lon(cx + sx * half, cz + sz * half) for sx in (-1, 1) for sz in (-1, 1)
        ]
        t_south = min(c[0] for c in tier_corners) - 0.01
        t_north = max(c[0] for c in tier_corners) + 0.01
        t_west = min(c[1] for c in tier_corners) - 0.01
        t_east = max(c[1] for c in tier_corners) + 0.01

        print(f"  tier {index}: {cells}x{cells} at {cell_m:g} m ({cells * cells / 1e3:.0f}k samples)")
        elevation = dem_mod.fetch_dem(
            t_west, t_south, t_east, t_north, cell_m, label=f"tier {index} elevation"
        )

        samples = [0] * (cells * cells)
        voids = 0
        origin_x = cx - half
        origin_z = cz - half

        for j in range(cells):
            z = origin_z + j * cell_m
            row = j * cells
            for i in range(cells):
                x = origin_x + i * cell_m
                lat, lon = frame.to_lat_lon(x, z)
                value = elevation.sample(lon, lat)
                if value is None:
                    voids += 1
                    value = 0.0
                samples[row + i] = int(round(flattened(x, z, value) / HEIGHT_SCALE_M))

        if voids:
            print(f"    {voids} samples had no elevation data and were set to sea level")

        highs = [s * HEIGHT_SCALE_M for s in samples]
        print(f"    {min(highs):.1f} .. {max(highs):.1f} m")

        tiers.append(
            {"cells": cells, "cellM": cell_m, "centreX": cx, "centreZ": cz, "samples": samples}
        )

    # Finest first — `region.ts` checks this, but failing here is a better error.
    tiers.sort(key=lambda t: t["cellM"])

    # -----------------------------------------------------------------------
    # 3. Land, from the coastline
    # -----------------------------------------------------------------------
    print("\nsurface")
    surface_cell = float(spec["surface"]["cellM"])
    surface_cells = int(round(2 * extent / surface_cell)) + 1
    grid = Grid(surface_cells, surface_cell, 0.0, 0.0, WATER)
    print(f"  {surface_cells}x{surface_cells} at {surface_cell:g} m, seeded as water")

    lines = osm_mod.fetch_coastline(south, west, north, east)
    print(f"  {len(lines)} coastline ways")

    # Into the region frame, as (x, north): every orientation rule in coastline.py is
    # stated in a right-handed frame and is false in one where north is negative.
    chains_xy = []
    for line in join_ways([[p for p in ln] for ln in lines]):
        pts = []
        for lon, lat in line:
            x, z = frame.to_world(lat, lon)
            pts.append((x, -z))
        chains_xy.append(pts)
    print(f"  joined into {len(chains_xy)} chains")

    # Every clipped piece from every chain, closed as one set. Closing chain by chain
    # is wrong and looks nearly right: a chain that leaves the region rejoins the
    # *next* chain along the boundary, not itself, so per-chain closing wraps the
    # whole rest of the map into each ring. It reported New York as 99.3% land.
    rect = Rect(-extent, -extent, extent, extent)
    pieces: list[list[tuple[float, float]]] = []
    for chain in chains_xy:
        pieces.extend(clip_chain(chain, rect))
    rings_xy = close_rings(pieces, rect)
    print(f"  {len(pieces)} pieces inside the region, closed into {len(rings_xy)} land rings")

    if rings_xy:
        painted = grid.fill_rings([[(x, -y) for x, y in r] for r in rings_xy], LAND)
        print(f"  land: {painted} cells ({100 * painted / len(grid.data):.1f}% of the region)")
    else:
        print("  no coastline in this region: treating all of it as land")
        grid.data = bytearray([LAND]) * len(grid.data)

    # -----------------------------------------------------------------------
    # 4. Land cover
    # -----------------------------------------------------------------------
    for layer in osm_mod.LAND_COVER:
        rings = osm_mod.fetch_layer(layer, south, west, north, east)
        world = []
        for ring in rings:
            pts = []
            for lon, lat in ring:
                x, z = frame.to_world(lat, lon)
                pts.append((x, z))
            world.append(pts)
        # Every layer paints only onto land, the sea included in what it must not
        # touch: a park or a river polygon whose edge overhangs the shoreline should
        # colour the land part and leave the harbour alone.
        painted = grid.fill_rings(world, layer.surface, only_over=LAND_CLASSES) if world else 0
        print(f"  {layer.name:14} {len(rings):6} rings -> {painted:7} cells")

    # -----------------------------------------------------------------------
    # 5. Buildings, and the dense city they imply
    # -----------------------------------------------------------------------
    print("\nbuildings")
    min_height = float(spec["buildings"]["minHeightM"])
    raw = osm_mod.fetch_buildings(south, west, north, east, min_height)
    print(f"  {len(raw)} footprints returned")

    instances: list[tuple[float, float, float, float, float, float]] = []
    footprints: list[list[tuple[float, float]]] = []

    for element in raw:
        height = osm_mod.parse_height(element.get("tags", {}))
        if height is None:
            height = osm_mod.FALLBACK_HEIGHT_M
        if height < min_height:
            continue

        pts = []
        for node in element["geometry"]:
            x, z = frame.to_world(node["lat"], node["lon"])
            pts.append((x, z))
        if len(pts) < 3:
            continue
        if max(abs(p[0]) for p in pts) > extent or max(abs(p[1]) for p in pts) > extent:
            continue

        # (east, north) for the box fit, so the angle it returns is a real bearing.
        cx, cy, half_a, half_b, angle = osm_mod.oriented_box([(x, -z) for x, z in pts])
        heading = (90.0 - math.degrees(angle)) % 360.0
        instances.append((cx, -cy, half_a, half_b, heading, height))
        footprints.append(pts)

    # Buildings OpenStreetMap knows the name of but not the height of. Willis Tower
    # is one, so is Trump International, so is the Chrysler Building — the tallest
    # things in their cities, absent from the skyline because a tag was never filled
    # in. Their heights come from Wikidata, which the OSM object already points at.
    untagged = osm_mod.fetch_untagged_notable_buildings(south, west, north, east)
    qids = [e["tags"]["wikidata"] for e in untagged if e.get("tags", {}).get("wikidata")]
    heights = wikidata_mod.heights_for(qids)

    recovered = 0
    for element in untagged:
        qid = element.get("tags", {}).get("wikidata")
        height = heights.get(qid or "")
        if height is None or height < min_height:
            continue

        pts = [frame.to_world(n["lat"], n["lon"]) for n in element["geometry"]]
        if len(pts) < 3:
            continue
        if max(abs(p[0]) for p in pts) > extent or max(abs(p[1]) for p in pts) > extent:
            continue

        cx, cy, half_a, half_b, angle = osm_mod.oriented_box([(x, -z) for x, z in pts])
        instances.append(
            (cx, -cy, half_a, half_b, (90.0 - math.degrees(angle)) % 360.0, height)
        )
        footprints.append(pts)
        recovered += 1

    print(f"  {recovered} more recovered from Wikidata heights")
    print(f"  {len(instances)} kept above {min_height:g} m")
    if instances:
        tall = sorted(i[5] for i in instances)
        print(
            f"  heights: median {tall[len(tall) // 2]:.0f} m, "
            f"90th {tall[int(len(tall) * 0.9)]:.0f} m, tallest {tall[-1]:.0f} m"
        )

    # Dense ground is where the tall buildings are. Manhattan is largely tagged
    # `landuse=residential` in OSM and would otherwise be painted as suburb; the
    # buildings themselves are the honest evidence of what is downtown.
    #
    # Counted per cell rather than filled as polygons. Filling was the obvious thing
    # and it barely worked: a cell is painted when its *centre* falls inside a
    # polygon, and a 40 by 60 metre footprint almost never contains the centre of a
    # 120 metre cell, so twenty-four thousand towers marked fifteen hundred cells.
    # Counting also says something truer — one tower over a low-rise district is not
    # a downtown, and two in the same 1.4 hectares is.
    counts: dict[int, int] = {}
    for cx, cz, *_ in instances:
        i = round((cx - grid.origin_x) / grid.cell_m)
        j = round((cz - grid.origin_z) / grid.cell_m)
        if 0 <= i < grid.cells and 0 <= j < grid.cells:
            counts[j * grid.cells + i] = counts.get(j * grid.cells + i, 0) + 1

    # Counted over a three-by-three neighbourhood, not a single cell. Per-cell
    # counting left Manhattan speckled: a block whose towers happened to land in the
    # neighbouring cell stayed unclassified, and downtown came out as grey dots on
    # green rather than as a downtown. A city block is contiguous with the next one,
    # and the neighbourhood is what says so.
    dense = 0
    for index in list(counts):
        j, i = divmod(index, grid.cells)
        around = 0
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                nj, ni = j + dj, i + di
                if 0 <= ni < grid.cells and 0 <= nj < grid.cells:
                    around += counts.get(nj * grid.cells + ni, 0)
        if around >= DENSE_BUILDINGS_PER_NEIGHBOURHOOD and grid.data[index] in LAND_CLASSES:
            if grid.data[index] != CITY:
                dense += 1
            grid.data[index] = CITY

    print(
        f"  {len(counts)} cells hold a tall building; "
        f"{dense} became dense city"
    )

    histogram = grid.histogram()
    names = {WATER: "water", LAND: "land", CITY: "city", RUNWAY: "runway",
             FOREST: "forest", GRASS: "grass", SAND: "sand", SUBURB: "suburb"}
    total = len(grid.data)
    print("\n  surface mix:")
    for value, count in sorted(histogram.items(), key=lambda kv: -kv[1]):
        print(f"    {names.get(value, value):8} {100 * count / total:5.1f}%")

    # -----------------------------------------------------------------------
    # 6. Landmarks and bridges
    # -----------------------------------------------------------------------
    print("\nlandmarks")
    raw_landmarks = osm_mod.fetch_landmarks(south, west, north, east)

    # Name the buildings already being drawn, rather than keeping every named
    # building there is. Wikidata alone admits 1,287 named office blocks in New York;
    # matching against the tallest hundred footprints gives the skyline instead —
    # Willis Tower and the Chrysler Building carry no height tag at all and would be
    # missed by any threshold, but they are unmistakable in the geometry.
    named_buildings = osm_mod.fetch_named_buildings(south, west, north, east)
    matched_names: set[str] = set()
    tallest = sorted(range(len(instances)), key=lambda i: -instances[i][5])[:150]

    for index in tallest:
        bx, bz, _, _, _, height = instances[index]
        nearest = None
        nearest_d = 70.0  # metres: a centroid this close is the same building
        for candidate in named_buildings:
            cx, cz = frame.to_world(candidate["lat"], candidate["lon"])
            d = math.hypot(cx - bx, cz - bz)
            if d < nearest_d:
                nearest_d = d
                nearest = candidate
        if nearest is not None:
            raw_landmarks.append(
                {"name": nearest["name"], "lat": nearest["lat"], "lon": nearest["lon"],
                 "kind": "tower", "heightM": round(height, 1),
                 "notable": nearest.get("notable", False)}
            )
            matched_names.add(nearest["name"])

    # Notable buildings that were never drawn, because OpenStreetMap has no height for
    # them. Ninety of the 392 named buildings in the Loop are in this position,
    # **Willis Tower among them** — the tallest building in the region, absent from
    # the skyline because nobody filled in a tag. A height cannot be invented, so it
    # stays undrawn; but it can still be named on the map, which is the difference
    # between a gap and a lie.
    for candidate in named_buildings:
        if candidate["name"] in matched_names or not candidate.get("notable"):
            continue
        raw_landmarks.append(
            {"name": candidate["name"], "lat": candidate["lat"], "lon": candidate["lon"],
             "kind": "building", "notable": True}
        )

    # Notability first, then how central it is.
    #
    # Notability alone is not enough to order by: 71 of Chicago's 81 mapped artworks
    # have a Wikipedia article, so the quota kept whichever twelve happened to sort
    # first and Cloud Gate was not among them. What separates a famous landmark from
    # a merely documented one, given no other signal, is *where it is* — the ones
    # people can name cluster in the middle of the city, and the middle of the city
    # is already known here as the centre of mass of the tall buildings.
    if instances:
        core = sorted(instances, key=lambda b: -b[5])[:50]
        core_x = sum(b[0] for b in core) / len(core)
        core_z = sum(b[1] for b in core) / len(core)
    else:
        core_x = core_z = 0.0

    def centrality(mark: dict) -> float:
        x, z = frame.to_world(mark["lat"], mark["lon"])
        return math.hypot(x - core_x, z - core_z)

    raw_landmarks.sort(key=lambda m: (not m.get("notable", False), centrality(m)))

    seen: set[str] = set()
    taken: dict[str, int] = {}
    landmarks = []
    for mark in raw_landmarks:
        x, z = frame.to_world(mark["lat"], mark["lon"])
        if abs(x) > extent or abs(z) > extent:
            continue
        if mark["name"] in seen:
            continue
        quota = LANDMARK_QUOTAS.get(mark["kind"], LANDMARK_DEFAULT_QUOTA)
        if taken.get(mark["kind"], 0) >= quota:
            continue
        taken[mark["kind"]] = taken.get(mark["kind"], 0) + 1
        seen.add(mark["name"])
        landmarks.append(mark)

    kinds: dict[str, int] = {}
    for mark in landmarks:
        kinds[mark["kind"]] = kinds.get(mark["kind"], 0) + 1
    print(f"  {len(landmarks)} landmarks: " + ", ".join(f"{v} {k}" for k, v in sorted(kinds.items())))

    print("\nbridges")
    raw_bridges = osm_mod.fetch_bridges(south, west, north, east)

    # Keep the ones that cross water, and let the region's own raster decide. Length
    # alone does not work: New York's longest named "bridges" are elevated subway
    # viaducts four kilometres long, and Chicago's are the L. A bridge over water is
    # the kind anyone means by the word, and the surface grid already knows which is
    # which — no extra query, and it agrees with the coastline by construction.
    bridges = []
    for bridge in raw_bridges:
        world = [frame.to_world(lat, lon) for lon, lat in bridge["points"]]
        if any(abs(x) > extent or abs(z) > extent for x, z in world):
            continue

        # Does it span water — not "is it mostly over water". The distinction is the
        # Brooklyn Bridge, whose longest way is 2,165 m of which only the 490 m main
        # span crosses the East River; a fraction-of-total test threw it away while
        # keeping viaducts that happened to run along a shoreline. What makes a
        # bridge a bridge is a continuous stretch of water underneath it, so that is
        # what gets measured. The surface grid already knows where the water is, and
        # agrees with the coastline by construction.
        step = 20.0
        total = sum(
            math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(world, world[1:])
        )
        probes = max(4, int(total / step))
        run = 0.0
        longest_wet = 0.0
        for k in range(probes + 1):
            t = (k / probes) * (len(world) - 1)
            i = min(len(world) - 2, int(t))
            f = t - i
            x = world[i][0] + (world[i + 1][0] - world[i][0]) * f
            z = world[i][1] + (world[i + 1][1] - world[i][1]) * f
            if grid.at_world(x, z) == WATER:
                run += total / probes
                longest_wet = max(longest_wet, run)
            else:
                run = 0.0

        if longest_wet < MIN_WATER_SPAN_M:
            continue

        lanes = bridge["lanes"]
        width = 12.0 if bridge["rail"] and not lanes else max(16.0, lanes * 3.65 + 4)
        bridges.append(
            {
                "name": bridge["name"],
                "points": [[round(lat, 6), round(lon, 6)] for lon, lat in bridge["points"]],
                "widthM": round(width, 1),
                "lengthM": round(bridge["lengthM"], 1),
                "waterSpanM": round(longest_wet, 1),
            }
        )

    bridges = bridges[:MAX_BRIDGES]
    print(f"  {len(bridges)} of {len(raw_bridges)} named bridges span water")
    for bridge in bridges[:8]:
        print(f"    {bridge['name'][:42]:44} {bridge['lengthM']:7.0f} m, {bridge['waterSpanM']:6.0f} m over water")

    # -----------------------------------------------------------------------
    # 7. Places, for labelling
    # -----------------------------------------------------------------------
    print("\nplaces")
    places = [
        p for p in osm_mod.fetch_places(south, west, north, east)
        if abs(frame.to_world(p["lat"], p["lon"])[0]) <= extent
        and abs(frame.to_world(p["lat"], p["lon"])[1]) <= extent
    ]
    kinds: dict[int, int] = {}
    for p in places:
        kinds[p["rank"]] = kinds.get(p["rank"], 0) + 1
    print(
        "  "
        + ", ".join(
            f"{kinds.get(i, 0)} {name}" for i, name in enumerate(osm_mod.PLACE_RANKS)
        )
    )

    # -----------------------------------------------------------------------
    # 8. Write
    # -----------------------------------------------------------------------
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    blob = bytearray()

    def align() -> None:
        while len(blob) % 4:
            blob.append(0)

    manifest_tiers = []
    for tier in tiers:
        align()
        manifest_tiers.append(
            {
                "cells": tier["cells"],
                "cellM": tier["cellM"],
                "centreX": tier["centreX"],
                "centreZ": tier["centreZ"],
                "byteOffset": len(blob),
            }
        )
        blob.extend(struct.pack(f"<{len(tier['samples'])}h", *tier["samples"]))

    align()
    surface_offset = len(blob)
    blob.extend(grid.data)

    align()
    buildings_offset = len(blob)
    for cx, cz, half_a, half_b, heading, height in instances:
        blob.extend(struct.pack("<6f", cx, cz, half_a, half_b, heading, height))
    align()

    manifest = {
        "format": 1,
        "id": spec["id"],
        "name": spec["name"],
        "origin": {"lat": origin.lat, "lon": origin.lon},
        "extentM": extent,
        "heightScaleM": HEIGHT_SCALE_M,
        "tiers": manifest_tiers,
        "surface": {
            "cells": surface_cells,
            "cellM": surface_cell,
            "centreX": 0.0,
            "centreZ": 0.0,
            "byteOffset": surface_offset,
        },
        "buildings": {"count": len(instances), "byteOffset": buildings_offset},
        "airfields": [
            {
                "name": f.name,
                **({"icao": f.icao} if f.icao else {}),
                "lat": round(f.lat, 7),
                "lon": round(f.lon, 7),
                "elevationM": round(f.elevation_m, 3),
                "headingDeg": round(f.heading_deg, 3),
                "lengthM": round(f.length_m, 2),
                "widthM": round(f.width_m, 2),
                "source": f.source,
            }
            for f, _, _ in inside
        ],
        "landmarks": [
            {
                "name": m["name"],
                "lat": round(m["lat"], 6),
                "lon": round(m["lon"], 6),
                "kind": m["kind"],
                **({"heightM": m["heightM"]} if "heightM" in m else {}),
            }
            for m in landmarks
        ],
        "bridges": bridges,
        "places": [
            {
                "name": p["name"],
                "lat": round(p["lat"], 5),
                "lon": round(p["lon"], 5),
                "rank": p["rank"],
            }
            for p in places
        ],
        "attribution": [
            osm_mod.ATTRIBUTION,
            dem_mod.ATTRIBUTION,
            faa_mod.ATTRIBUTION,
            wikidata_mod.ATTRIBUTION,
        ],
    }

    manifest_path = OUT_DIR / f"{spec['id']}.json"
    blob_path = OUT_DIR / f"{spec['id']}.bin"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    blob_path.write_bytes(bytes(blob))

    print(f"\nwrote {manifest_path.name}  {manifest_path.stat().st_size / 1024:.0f} KB")
    print(f"wrote {blob_path.name}  {len(blob) / 1e6:.2f} MB")
    for tier, m in zip(tiers, manifest_tiers):
        print(f"   tier {m['cellM']:>4.0f} m  {tier['cells'] ** 2 * 2 / 1e6:5.2f} MB")
    print(f"   surface     {len(grid.data) / 1e6:5.2f} MB")
    print(f"   buildings   {len(instances) * 24 / 1e6:5.2f} MB")


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    build(Path(sys.argv[1]) if Path(sys.argv[1]).exists() else HERE / sys.argv[1])


if __name__ == "__main__":
    main()
