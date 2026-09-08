"""
Turning OpenStreetMap's coastline into land.

## The problem, which is not the one you expect

The obvious way to find water is to ask for it. That fails: in OpenStreetMap the
open sea is not an object. Probing the New York region for water *areas* finds
nothing at all under the Upper Bay, the Hudson, Jamaica Bay or the Atlantic — only
Long Island Sound and Lower New York Bay happen to carry a `natural=bay` relation,
and those are labels, not shorelines. What actually exists is `natural=coastline`:
open ways, thousands of kilometres long, that are never closed because a coastline
has no end.

So water cannot be filled in. **Land has to be built, and everything else is sea.**

## The rule that makes it possible

A coastline way is directed, and the convention is absolute: **land is on the left.**
That single fact turns a pile of disconnected line segments into an orientation, and
an orientation is enough to fill.

## The algorithm

1. **Join.** Ways meeting end-to-start are one chain. OSM splits a coastline into
   arbitrary pieces; the pieces are meaningless and the chain is the object.
2. **Clip** each chain to the region square. What survives is either a closed ring
   entirely inside — an island, or a lake in an island — or an open chain whose two
   ends sit on the region boundary.
3. **Close** the open chains along that boundary. Walking a land polygon with land on
   the left means walking it counter-clockwise, so from where a chain leaves the
   boundary, follow the boundary counter-clockwise to where the next chain rejoins
   it, picking up the corners in between. This is the step that turns "a coastline
   crosses my map" into "this half of my map is land".
4. **Fill** by non-zero winding, which respects the orientation the whole scheme
   rests on: an island is counter-clockwise and fills, a lake cut into it is
   clockwise and cancels back out to water.

Coordinates here are `(x, y)` with **y north** — not the renderer's `(x, z)` with z
south. Every left/right and clockwise/counter-clockwise statement above is only true
in a right-handed frame, and doing the arithmetic in a frame where north is negative
is how a coastline ends up inside out. The conversion happens once, on the way out.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

Point = tuple[float, float]

#: How far a clipped endpoint may sit from the boundary and still count as on it.
#: Clipping is exact arithmetic, so this only absorbs rounding — anything further out
#: is a chain that genuinely ends in open country, which cannot be closed.
BOUNDARY_TOLERANCE_M = 1.0


class NotOnBoundary(ValueError):
    """A point that was expected to lie on the region boundary does not."""


@dataclass
class Rect:
    """The region square, in metres. Half-open in the sense that edges belong to it."""

    min_x: float
    min_y: float
    max_x: float
    max_y: float

    def contains(self, p: Point) -> bool:
        return self.min_x <= p[0] <= self.max_x and self.min_y <= p[1] <= self.max_y

    @property
    def corners(self) -> list[Point]:
        """The four corners, counter-clockwise from the south-west."""
        return [
            (self.min_x, self.min_y),
            (self.max_x, self.min_y),
            (self.max_x, self.max_y),
            (self.min_x, self.max_y),
        ]

    def perimeter_t(self, p: Point) -> float:
        """
        Position of a boundary point around the rectangle, in [0, 4).

        Counter-clockwise from the south-west corner, one unit per side. This is the
        ordering the closing walk uses, so it has to agree with `corners`.
        """
        x, y = p
        w = self.max_x - self.min_x
        h = self.max_y - self.min_y

        d = [
            (abs(y - self.min_y), 0),  # south, heading east
            (abs(x - self.max_x), 1),  # east, heading north
            (abs(y - self.max_y), 2),  # north, heading west
            (abs(x - self.min_x), 3),  # west, heading south
        ]
        distance, side = min(d)

        # A point that is not on the boundary has no position on it. Snapping one
        # anyway is what turns a dangling chain into a wedge of sea across the map,
        # so this refuses instead and lets the caller drop the piece.
        if distance > BOUNDARY_TOLERANCE_M:
            raise NotOnBoundary(f"{p} is {distance:.1f} m from the region boundary")

        if side == 0:
            return 0.0 + (x - self.min_x) / w
        if side == 1:
            return 1.0 + (y - self.min_y) / h
        if side == 2:
            return 2.0 + (self.max_x - x) / w
        return 3.0 + (self.max_y - y) / h


def join_ways(ways: list[list[Point]]) -> list[list[Point]]:
    """
    Stitch ways that share an endpoint into chains.

    Extends in **both** directions from each seed, and that is not a refinement — a
    forward-only version is order-dependent and silently wrong. If the continuation
    of a coastline happens to be visited before the piece that leads into it, the
    continuation is consumed first and the earlier piece is left as a chain ending in
    the middle of the map. Those dangling ends then get closed against the region
    boundary as though they were shoreline, and the result is a huge triangular wedge
    of sea driven through the middle of a landmass. It looked like a winding bug for
    a while; it was this.

    Matching is by exact coordinate, which is safe because a shared node is one node
    in the OSM database and both ways carry bit-identical coordinates for it.
    Tolerance-based matching would be slower and would risk joining two genuinely
    separate landmasses that happen to pass close by.
    """
    by_start: dict[Point, list[int]] = {}
    by_end: dict[Point, list[int]] = {}
    for index, way in enumerate(ways):
        if len(way) >= 2:
            by_start.setdefault(way[0], []).append(index)
            by_end.setdefault(way[-1], []).append(index)

    used: set[int] = set()
    chains: list[list[Point]] = []

    for seed, way in enumerate(ways):
        if seed in used or len(way) < 2:
            continue
        used.add(seed)
        chain = list(way)

        # Forward: whatever starts where this chain ends.
        while chain[0] != chain[-1]:
            nxt = next((i for i in by_start.get(chain[-1], []) if i not in used), None)
            if nxt is None:
                break
            used.add(nxt)
            chain.extend(ways[nxt][1:])

        # Backward: whatever ends where this chain begins.
        while chain[0] != chain[-1]:
            prev = next((i for i in by_end.get(chain[0], []) if i not in used), None)
            if prev is None:
                break
            used.add(prev)
            chain[:0] = ways[prev][:-1]

        chains.append(chain)

    return chains


def _clip_segment(a: Point, b: Point, rect: Rect) -> list[Point] | None:
    """Liang-Barsky: the part of segment a->b inside the rectangle, or None."""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    t0, t1 = 0.0, 1.0

    for p, q in (
        (-dx, a[0] - rect.min_x),
        (dx, rect.max_x - a[0]),
        (-dy, a[1] - rect.min_y),
        (dy, rect.max_y - a[1]),
    ):
        if p == 0:
            if q < 0:
                return None
        else:
            r = q / p
            if p < 0:
                if r > t1:
                    return None
                t0 = max(t0, r)
            else:
                if r < t0:
                    return None
                t1 = min(t1, r)

    return [(a[0] + t0 * dx, a[1] + t0 * dy), (a[0] + t1 * dx, a[1] + t1 * dy)]


def clip_chain(chain: list[Point], rect: Rect) -> list[list[Point]]:
    """
    The pieces of a chain that lie inside the rectangle, in order.

    A chain can enter and leave several times — a coastline running along the edge of
    the map does it constantly — so this returns a list, not one piece. Direction is
    preserved, which is the whole point: the pieces are still land-on-the-left.
    """
    pieces: list[list[Point]] = []
    current: list[Point] = []

    for a, b in zip(chain, chain[1:]):
        clipped = _clip_segment(a, b, rect)
        if clipped is None:
            if len(current) >= 2:
                pieces.append(current)
            current = []
            continue

        p, q = clipped
        if not current:
            current = [p, q]
        else:
            # Continuing only if this segment starts where the last one ended;
            # otherwise the chain left the rectangle and came back.
            if abs(current[-1][0] - p[0]) > 1e-6 or abs(current[-1][1] - p[1]) > 1e-6:
                if len(current) >= 2:
                    pieces.append(current)
                current = [p, q]
            else:
                current.append(q)

    if len(current) >= 2:
        pieces.append(current)

    return pieces


def close_rings(
    pieces: list[list[Point]], rect: Rect, dropped: list | None = None
) -> list[list[Point]]:
    """
    Close open chains along the rectangle boundary into land rings.

    Each open piece starts and ends on the boundary. Walking counter-clockwise from
    where one piece ends, the next piece to *start* is the one it joins to, and the
    boundary corners passed on the way belong to the ring.

    Why counter-clockwise: the ring encloses land, coastline keeps land on the left,
    and a polygon traversed with its interior on the left is counter-clockwise. The
    boundary stretches of the ring are traversed the same way as the rest of it.
    """
    if dropped is None:
        dropped = []

    # "Closed" within a millimetre rather than bit-exact. OSM's own closed ways do
    # repeat the identical node, but a ring that has been through a projection and a
    # clip can come back a rounding error short of meeting itself, and a ring treated
    # as open gets dragged out to the region boundary and back.
    def is_closed(piece: list[Point]) -> bool:
        return math.dist(piece[0], piece[-1]) <= BOUNDARY_TOLERANCE_M

    closed = [p if p[0] == p[-1] else p + [p[0]] for p in pieces if is_closed(p)]
    candidates = [p for p in pieces if not is_closed(p)]

    # Every open piece must begin and end on the boundary; one that does not is a
    # coastline that stops in the middle of the map, which means the data is missing
    # its continuation. Such a piece is dropped, loudly, because closing it produces
    # a plausible-looking landmass that is not there.
    opens: list[list[Point]] = []
    for piece in candidates:
        try:
            rect.perimeter_t(piece[0])
            rect.perimeter_t(piece[-1])
        except NotOnBoundary:
            dropped.append(piece)
            continue
        opens.append(piece)

    if not opens:
        return closed

    # Where each open piece begins, around the boundary. Sorted, so "the next start
    # counter-clockwise from here" is a lookup rather than a scan.
    starts = sorted((rect.perimeter_t(p[0]), i) for i, p in enumerate(opens))

    def next_start_after(t: float) -> tuple[float, int]:
        for st, i in starts:
            # Strictly after, with a nudge: a piece that ends exactly where another
            # begins must join to that one, not to itself a lap later.
            if st > t + 1e-9:
                return st, i
        return starts[0]

    used: set[int] = set()

    for seed in range(len(opens)):
        if seed in used:
            continue

        ring: list[Point] = []
        index = seed

        while index not in used:
            used.add(index)
            piece = opens[index]
            ring.extend(piece)

            t_end = rect.perimeter_t(piece[-1])
            t_next, index = next_start_after(t_end)

            # Pick up every corner strictly between here and there, walking CCW.
            corners = rect.corners
            span = (t_next - t_end) % 4.0
            for k in range(4):
                t_corner = float((int(t_end) + 1 + k) % 4)
                if (t_corner - t_end) % 4.0 < span:
                    ring.append(corners[int(t_corner)])
                else:
                    break

        if len(ring) >= 3:
            ring.append(ring[0])
            closed.append(ring)

    return closed
