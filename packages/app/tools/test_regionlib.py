#!/usr/bin/env python3
"""
Self-tests for the region builder's geometry.

    python3 tools/test_regionlib.py

No framework, no dependencies, plain asserts — the same bargain the rest of
`tools/` makes. It runs in under a second and it is the only thing standing between a
subtly inverted coastline and a region where the land is the sea.

The coastline assembly is what this exists for. It is the one piece of the builder
whose output cannot be checked by looking at it: an inside-out fill produces a
perfectly plausible map of somewhere that does not exist, and the failure is a
half-plane, not a crash. So the cases below are all constructed so the right answer
is known by hand before the code runs — a coastline down a meridian, an island, an
island with a lake in it — and the assertions name which side must be land.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from regionlib.coastline import Rect, clip_chain, close_rings, join_ways  # noqa: E402
from regionlib.geo import GeoFrame, LatLon  # noqa: E402
from regionlib.osm import parse_height, stitch_rings  # noqa: E402
from regionlib.raster import Grid  # noqa: E402

PASSED = 0
FAILED: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
    else:
        FAILED.append(f"{name}" + (f" — {detail}" if detail else ""))


def to_xz(ring):
    """Coastline works in (x, north); the grid works in (x, south)."""
    return [(x, -y) for x, y in ring]


E = 100.0
RECT = Rect(-E, -E, E, E)


def land_grid(rings, cells=41, cell_m=5.0):
    """Fill land rings (given in x/north) onto a grid seeded as water."""
    WATER, LAND = 0, 1
    g = Grid(cells, cell_m, 0.0, 0.0, WATER)
    # One call, every ring: non-zero winding only cancels within a single pass.
    g.fill_rings([to_xz(r) for r in rings], LAND)
    return g


# ---------------------------------------------------------------------------
# Joining
# ---------------------------------------------------------------------------

a = [(0.0, 0.0), (1.0, 1.0)]
b = [(1.0, 1.0), (2.0, 3.0)]
c = [(9.0, 9.0), (8.0, 8.0)]
chains = join_ways([a, b, c])
check("join: two ways sharing an endpoint become one chain", len(chains) == 2, f"got {len(chains)}")
check("join: the joined chain keeps every point once",
      any(ch == [(0.0, 0.0), (1.0, 1.0), (2.0, 3.0)] for ch in chains))

ring_ways = [[(0.0, 0.0), (1.0, 0.0)], [(1.0, 0.0), (1.0, 1.0)], [(1.0, 1.0), (0.0, 0.0)]]
closed = join_ways(ring_ways)
check("join: a ring closes rather than looping forever",
      len(closed) == 1 and closed[0][0] == closed[0][-1])

# Order must not matter. A forward-only join leaves the earlier piece dangling in
# the middle of the map whenever the continuation is visited first, and a dangling
# end closed against the boundary is a wedge of sea through a landmass — which is
# exactly what New York looked like.
forward = [(0.0, 0.0), (1.0, 0.0)]
onward = [(1.0, 0.0), (2.0, 0.0)]
for order, label in (([forward, onward], "in order"), ([onward, forward], "reversed")):
    joined = join_ways(order)
    check(f"join: two ways merge whichever order they arrive in ({label})",
          len(joined) == 1 and len(joined[0]) == 3,
          f"got {joined}")

# A chain that stops inside the region cannot be closed, and must not be guessed at.
dangling = [(-E, 0.0), (0.0, 0.0)]
dropped: list = []
rings_d = close_rings(clip_chain(dangling, RECT), RECT, dropped)
check("close: a chain ending inside the region is dropped, not closed",
      rings_d == [] and len(dropped) == 1,
      f"rings={len(rings_d)} dropped={len(dropped)}")

# ---------------------------------------------------------------------------
# A coastline straight up the middle: land is west, because land is on the left
# ---------------------------------------------------------------------------

north_bound = [(0.0, -E), (0.0, E)]          # heading north; left is west
rings = close_rings(clip_chain(north_bound, RECT), RECT)
check("meridian coast: one ring", len(rings) == 1, f"got {len(rings)}")
g = land_grid(rings)
check("meridian coast: west is land", g.at_world(-50.0, 0.0) == 1)
check("meridian coast: east is sea", g.at_world(50.0, 0.0) == 0)

# Reverse it: heading south, left is east. The map must invert.
south_bound = [(0.0, E), (0.0, -E)]
g2 = land_grid(close_rings(clip_chain(south_bound, RECT), RECT))
check("reversed coast: west is now sea", g2.at_world(-50.0, 0.0) == 0)
check("reversed coast: east is now land", g2.at_world(50.0, 0.0) == 1)

# A coastline running east: land on the left is north.
east_bound = [(-E, 0.0), (E, 0.0)]
g3 = land_grid(close_rings(clip_chain(east_bound, RECT), RECT))
check("eastward coast: north is land", g3.at_world(0.0, -50.0) == 1, "north is -z")
check("eastward coast: south is sea", g3.at_world(0.0, 50.0) == 0)

# ---------------------------------------------------------------------------
# An island, and a lake inside it
# ---------------------------------------------------------------------------

def circle(r, ccw=True, n=64, cx=0.0, cy=0.0):
    import math
    pts = []
    for k in range(n):
        t = 2 * math.pi * k / n * (1 if ccw else -1)
        pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    # Closed exactly, the way OSM closes a way: by repeating the same node, not by
    # coming back round to a point that merely computes to the same place.
    return pts + [pts[0]]


island = circle(60.0, ccw=True)
rings = close_rings(clip_chain(island, RECT), RECT)
check("island: stays one closed ring", len(rings) == 1)
g4 = land_grid(rings)
check("island: centre is land", g4.at_world(0.0, 0.0) == 1)
check("island: outside is sea", g4.at_world(90.0, 0.0) == 0)

# A lake is coastline too, but wound the other way — water on the inside.
lake = circle(25.0, ccw=False)
g5 = land_grid(close_rings(clip_chain(island, RECT), RECT) + close_rings(clip_chain(lake, RECT), RECT))
check("island with lake: ring of land survives", g5.at_world(45.0, 0.0) == 1)
check("island with lake: the lake is water, not land",
      g5.at_world(0.0, 0.0) == 0,
      "non-zero winding must cancel the clockwise ring")
check("island with lake: outside still sea", g5.at_world(90.0, 0.0) == 0)

# ---------------------------------------------------------------------------
# Multipolygon stitching — the opposite rule from coastline joining
# ---------------------------------------------------------------------------

# A square split into four members, two of them drawn backwards. Member direction is
# meaningless in a multipolygon, so all four must still make one ring. Lake Michigan
# has 743 outer members and none of them is closed; joining them with the coastline's
# direction-preserving rule left 44 open chains with gaps of three degrees, and
# Chicago came out 2.9% water.
square = [
    [(0.0, 0.0), (10.0, 0.0)],
    [(10.0, 10.0), (10.0, 0.0)],     # backwards
    [(10.0, 10.0), (0.0, 10.0)],
    [(0.0, 0.0), (0.0, 10.0)],       # backwards
]
stitched = stitch_rings(square)
check("stitch: reversed members still form one ring",
      len(stitched) == 1 and stitched[0][0] == stitched[0][-1],
      f"got {len(stitched)} rings, closed={stitched and stitched[0][0] == stitched[0][-1]}")
check("stitch: the ring has every corner",
      len(stitched) == 1 and len(set(stitched[0])) == 4,
      f"got {sorted(set(stitched[0])) if stitched else None}")

# Two separate rings must not be merged into one.
two = square + [
    [(20.0, 20.0), (30.0, 20.0)],
    [(30.0, 20.0), (30.0, 30.0)],
    [(30.0, 30.0), (20.0, 20.0)],
]
check("stitch: disjoint rings stay disjoint", len(stitch_rings(two)) == 2,
      f"got {len(stitch_rings(two))}")

# A coastline must never be reversed — direction is the entire signal there.
check("join: coastline joining does not reverse ways",
      len(join_ways([[(0.0, 0.0), (1.0, 0.0)], [(2.0, 0.0), (1.0, 0.0)]])) == 2,
      "two ways meeting end-to-end are not one coastline chain")

# ---------------------------------------------------------------------------
# Clipping: a chain that leaves and re-enters is two pieces, not one
# ---------------------------------------------------------------------------

excursion = [(-50.0, -50.0), (-50.0, 150.0), (50.0, 150.0), (50.0, -50.0)]
pieces = clip_chain(excursion, RECT)
check("clip: an excursion outside the square splits the chain",
      len(pieces) == 2, f"got {len(pieces)}")
check("clip: every clipped point is inside",
      all(RECT.contains(p) for piece in pieces for p in piece))

# ---------------------------------------------------------------------------
# The grid agrees with region.ts about where cell centres are
# ---------------------------------------------------------------------------

g6 = Grid(9, 10.0, 0.0, 0.0, 0)
check("grid: centre cell sits at the centre", g6.x_of(4) == 0.0 and g6.z_of(4) == 0.0)
check("grid: span is (cells - 1) * cellM", g6.x_of(8) - g6.x_of(0) == 80.0)

# ---------------------------------------------------------------------------
# Projection sanity, so a broken geo.py fails here too and not only in vitest
# ---------------------------------------------------------------------------

frame = GeoFrame(LatLon(40.7772, -73.8726))
x, z = frame.to_world(40.7772, -73.8626)
check("geo: east of the origin is +x", x > 0 and abs(z) < 1.0, f"x={x:.1f} z={z:.1f}")
x, z = frame.to_world(40.7872, -73.8726)
check("geo: north of the origin is -z", z < 0 and abs(x) < 1.0, f"x={x:.1f} z={z:.1f}")

print(f"\n{PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILED else 0)
