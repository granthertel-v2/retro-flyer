#!/usr/bin/env python3
"""
Prove that the builder's projection is the runtime's projection.

`regionlib/geo.py` is a port of `src/terrain/geo.ts`. The builder resamples real
elevation onto the renderer's metric grid through the port; the browser reads that
grid back through the original. A disagreement between the two does not produce an
error — it produces a region that is silently offset from the world it claims to be,
which is the failure mode this project can least afford, because nothing about a
Manhattan shifted forty metres north looks wrong.

So the port is not reviewed, it is tested. This writes pairs computed in Python;
`test/geo.test.ts` recomputes every one through `GeoFrame` and requires agreement to
well under a millimetre — three orders of magnitude below the finest terrain cell.

The points are chosen to exercise what actually differs between a correct
implementation and a plausible one: the ellipsoid's two radii (north-south vs
east-west displacement), the sign of longitude in the western hemisphere, the
renderer's north-at-minus-Z convention, the Newton inverse at a region corner where
the tangent plane has sagged furthest, and meridian convergence away from the origin.

    python3 tools/gen_projection_fixture.py

Output is committed. Node never needs Python.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from regionlib.geo import GeoFrame, LatLon  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "fixtures" / "projection.json"

# Half-width of a region, metres. The corner cases below are placed relative to this
# because it is where the tangent-plane approximation is worst.
EXTENT_M = 55_560

CASES = [
    {
        "name": "new-york",
        "why": "Mid-latitude, western hemisphere, and the first real region.",
        "origin": {"lat": 40.7772, "lon": -73.8726},
        # Offsets in metres from the origin, fed through the inverse and back.
        "offsets": [
            [0, 0],
            [1_000, 0],
            [0, 1_000],
            [-1_000, -1_000],
            [EXTENT_M, 0],
            [0, EXTENT_M],
            [-EXTENT_M, 0],
            [0, -EXTENT_M],
            [EXTENT_M, EXTENT_M],
            [-EXTENT_M, EXTENT_M],
            [EXTENT_M, -EXTENT_M],
            [-EXTENT_M, -EXTENT_M],
        ],
    },
    {
        "name": "chicago",
        "why": "A second origin, three degrees further north and twelve west.",
        "origin": {"lat": 41.9803, "lon": -87.9090},
        "offsets": [[0, 0], [EXTENT_M, EXTENT_M], [-EXTENT_M, -EXTENT_M]],
    },
    {
        "name": "equator-east",
        "why": (
            "Positive longitude and near-zero latitude, where the two radii nearly "
            "coincide and a single-radius implementation would still look right. "
            "Present so the fixture cannot be passed by one."
        ),
        "origin": {"lat": 1.3592, "lon": 103.9894},
        "offsets": [[0, 0], [EXTENT_M, EXTENT_M]],
    },
    {
        "name": "southern",
        "why": "Both coordinates negative: sign errors that cancel in the north do not here.",
        "origin": {"lat": -33.9461, "lon": 151.1772},
        "offsets": [[0, 0], [EXTENT_M, -EXTENT_M]],
    },
]


def main() -> None:
    out = {
        "generatedBy": "tools/gen_projection_fixture.py",
        "purpose": (
            "Agreement between regionlib/geo.py (the offline builder) and "
            "src/terrain/geo.ts (the runtime). Regenerate with the tool; never edit."
        ),
        "cases": [],
    }

    for case in CASES:
        origin = LatLon(case["origin"]["lat"], case["origin"]["lon"])
        frame = GeoFrame(origin)

        points = []
        for x, z in case["offsets"]:
            lat, lon = frame.to_lat_lon(float(x), float(z))
            fx, fz = frame.to_world(lat, lon)
            points.append(
                {
                    # The inverse: what the builder calls for every grid sample.
                    "x": float(x),
                    "z": float(z),
                    "lat": lat,
                    "lon": lon,
                    # The forward map re-applied, so the test checks both directions
                    # against the same pair rather than only the one it was given.
                    "forwardX": fx,
                    "forwardZ": fz,
                    "convergenceDeg": frame.convergence_deg(lat, lon),
                }
            )

        out["cases"].append(
            {
                "name": case["name"],
                "why": case["why"],
                "origin": case["origin"],
                "points": points,
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n")
    n = sum(len(c["points"]) for c in out["cases"])
    print(f"wrote {OUT.relative_to(HERE.parent.parent.parent)}: {len(out['cases'])} cases, {n} points")


if __name__ == "__main__":
    main()
