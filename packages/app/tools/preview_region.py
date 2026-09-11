#!/usr/bin/env python3
"""
Render a built region's surface raster as a PNG, so a person can look at it.

    python3 tools/preview_region.py public/regions/new-york.json out.png

Not part of the build, and the output is not committed. It exists because the failure
modes of a coastline fill are visual and nearly invisible in aggregate statistics: a
region reported as 39% land can have the Hudson filled in and the Bronx flooded and
still look entirely reasonable in a histogram. Twenty seconds looking at the picture
finds what an afternoon of point checks might not.

PNG is written by hand — zlib is in the standard library and the format's uncompressed
truecolour form is a header, a palette-free scanline per row, and a CRC.
"""

from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

COLOURS = {
    0: (28, 62, 96),     # water
    1: (72, 96, 46),     # land, unclassified
    2: (110, 106, 100),  # city
    3: (48, 48, 54),     # runway
    4: (34, 60, 30),     # forest
    5: (92, 122, 58),    # grass
    6: (196, 180, 128),  # sand
    7: (104, 100, 78),   # suburb
}


def write_png(path: Path, width: int, height: int, rgb: bytes) -> None:
    raw = b"".join(
        b"\x00" + rgb[y * width * 3 : (y + 1) * width * 3] for y in range(height)
    )

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    manifest_path = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else manifest_path.with_suffix(".png")

    manifest = json.loads(manifest_path.read_text())
    blob = manifest_path.with_suffix(".bin").read_bytes()

    s = manifest["surface"]
    cells = s["cells"]
    data = blob[s["byteOffset"] : s["byteOffset"] + cells * cells]

    pixels = bytearray()
    for value in data:
        pixels.extend(COLOURS.get(value, (255, 0, 255)))

    write_png(out, cells, cells, bytes(pixels))
    print(f"wrote {out} ({cells}x{cells}) — north is up, west is left")


if __name__ == "__main__":
    main()
