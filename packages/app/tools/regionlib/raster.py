"""
Polygon fill onto the surface-class grid.

Scanline, with a **non-zero winding** rule rather than even-odd. That choice is not
stylistic: the coastline scheme in `coastline.py` encodes land as counter-clockwise
and enclosed water as clockwise, so a lake inside an island has to *cancel* rather
than toggle. Even-odd would fill it as land again the moment a third ring appeared.

Filling is per-polygon and bounded by the polygon's own rows, so cost is proportional
to the area actually painted rather than to grid size times polygon count. A region
grid is a few hundred thousand cells and there are tens of thousands of polygons; the
naive nested loop is a hundred times slower for the same picture.

Grids here match the layout `region.ts` reads: row-major, `cells * cells`, with cell
`(i, j)` centred at `centre + (i - (cells - 1) / 2) * cellM`. Sample *centres*, not
corners — the runtime samples the same way, and a half-cell disagreement between the
builder and the reader shifts every coastline by half a cell.
"""

from __future__ import annotations

Point = tuple[float, float]


class Grid:
    """A square, axis-aligned, centred class raster in world metres."""

    def __init__(self, cells: int, cell_m: float, centre_x: float, centre_z: float, fill: int):
        self.cells = cells
        self.cell_m = cell_m
        self.centre_x = centre_x
        self.centre_z = centre_z
        self.data = bytearray([fill]) * (cells * cells)
        self.half = (cells - 1) * cell_m / 2
        self.origin_x = centre_x - self.half
        self.origin_z = centre_z - self.half

    def x_of(self, i: int) -> float:
        return self.origin_x + i * self.cell_m

    def z_of(self, j: int) -> float:
        return self.origin_z + j * self.cell_m

    def get(self, i: int, j: int) -> int:
        return self.data[j * self.cells + i]

    def at_world(self, x: float, z: float) -> int:
        i = round((x - self.origin_x) / self.cell_m)
        j = round((z - self.origin_z) / self.cell_m)
        i = min(self.cells - 1, max(0, i))
        j = min(self.cells - 1, max(0, j))
        return self.get(i, j)

    def fill_rings(
        self,
        rings: list[list[Point]],
        value: int,
        *,
        only_over: set[int] | None = None,
    ) -> int:
        """
        Paint a set of rings as **one** polygon, in world `(x, z)`.

        Taking a list rather than a ring at a time is not a convenience — it is
        required for correctness. Non-zero winding cancels a clockwise ring against
        the counter-clockwise one containing it, and cancellation only happens if
        both are in the same winding sum. Filled one at a time, an island fills, and
        then the lake inside it fills again on its own account: the hole disappears
        and nothing anywhere reports a problem. The whole coastline of a region is
        one polygon with a great many rings, and this is what says so.

        `only_over` restricts painting to cells currently holding one of those
        classes. That is how land cover is kept out of the sea: a park polygon whose
        edge overhangs the shoreline colours the land part and leaves the water,
        without clipping every polygon against the coast.

        Returns the number of cells changed, which is what lets the caller notice a
        layer it believed in painting nothing.
        """
        # Edges, bucketed by the rows they cross. Built once and reused for every
        # scanline: a coastline has tens of thousands of segments and a grid has
        # hundreds of rows, and testing every segment against every row is the
        # difference between a second and a minute.
        buckets: dict[int, list[tuple[float, float, float, float, int]]] = {}
        j_min, j_max = self.cells, -1

        for ring in rings:
            if len(ring) < 3:
                continue
            for k in range(len(ring) - 1):
                xa, za = ring[k]
                xb, zb = ring[k + 1]
                if za == zb:
                    continue
                winding = 1 if za < zb else -1
                lo, hi = (za, zb) if za < zb else (zb, za)

                # Half-open in z: a row exactly on the lower end counts, the upper
                # end does not. This is what stops a vertex sitting on a scanline
                # from being counted twice and inverting everything to its right.
                r0 = max(0, self._row_at_or_after(lo))
                r1 = min(self.cells - 1, self._row_before(hi))
                if r1 < r0:
                    continue

                edge = (xa, za, xb, zb, winding)
                for j in range(r0, r1 + 1):
                    buckets.setdefault(j, []).append(edge)
                j_min = min(j_min, r0)
                j_max = max(j_max, r1)

        if j_max < j_min:
            return 0

        painted = 0

        for j in range(j_min, j_max + 1):
            edges = buckets.get(j)
            if not edges:
                continue
            z = self.z_of(j)

            crossings = [
                (xa + (z - za) * (xb - xa) / (zb - za), w) for xa, za, xb, zb, w in edges
            ]
            crossings.sort()

            wind = 0
            base = j * self.cells
            for idx in range(len(crossings) - 1):
                wind += crossings[idx][1]
                if wind == 0:
                    continue

                # Cell centres strictly inside the span. Rounding outward here would
                # grow every landmass by half a cell on each side and close narrow
                # channels that are really there.
                i0 = max(0, self._col_at_or_after(crossings[idx][0]))
                i1 = min(self.cells - 1, self._col_at_or_before(crossings[idx + 1][0]))
                if i1 < i0:
                    continue

                if only_over is None:
                    for i in range(i0, i1 + 1):
                        if self.data[base + i] != value:
                            painted += 1
                            self.data[base + i] = value
                else:
                    for i in range(i0, i1 + 1):
                        if self.data[base + i] in only_over and self.data[base + i] != value:
                            painted += 1
                            self.data[base + i] = value

        return painted

    def fill_polygon(self, ring: list[Point], value: int, *, only_over: set[int] | None = None) -> int:
        """One ring, as its own polygon. See `fill_rings` for why that is the unusual case."""
        return self.fill_rings([ring], value, only_over=only_over)

    # Row and column indices bracketing a world coordinate. Written out rather than
    # inlined because an off-by-one here is a half-cell shift of every coastline in
    # the region, and this way there is one place to check it.
    def _row_at_or_after(self, z: float) -> int:
        import math

        return math.ceil((z - self.origin_z) / self.cell_m)

    def _row_before(self, z: float) -> int:
        import math

        j = math.ceil((z - self.origin_z) / self.cell_m) - 1
        return j

    def _col_at_or_after(self, x: float) -> int:
        import math

        return math.ceil((x - self.origin_x) / self.cell_m)

    def _col_at_or_before(self, x: float) -> int:
        import math

        return math.floor((x - self.origin_x) / self.cell_m)

    def histogram(self) -> dict[int, int]:
        out: dict[int, int] = {}
        for v in self.data:
            out[v] = out.get(v, 0) + 1
        return out
