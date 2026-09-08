"""
Just enough GeoTIFF to read a USGS elevation tile.

Not a TIFF library. It reads exactly the shape the 3DEP ImageServer returns —
little-endian classic TIFF, one band, uncompressed IEEE float32, tiled — and refuses
everything else loudly. That refusal is the point: a partial TIFF reader that
silently mishandles a variant it did not expect produces a heightfield full of
garbage, and garbage elevation looks like interesting terrain.

The alternative was GDAL, which is a hundred megabytes of native code and a build
step, to decode a file format whose entire relevant subset is a table of tags and a
block of floats. `gen_tables.py` made the same trade for the aero tables: parse the
thing directly, then let a test downstream catch a misparse.

The geotransform is read from the file rather than assumed from the request. This is
load-bearing. ArcGIS `exportImage` honours the requested pixel *count* but adjusts
the *extent* to keep pixels square, so a bounding box whose aspect ratio does not
match the requested size comes back covering different ground than was asked for.
Trusting the request would offset the whole region by however much the server
adjusted, with nothing to show for it.
"""

from __future__ import annotations

import array
import struct
from dataclasses import dataclass

# TIFF tags we care about. Everything else is skipped.
_WIDTH = 256
_HEIGHT = 257
_BITS = 258
_COMPRESSION = 259
_STRIP_OFFSETS = 273
_SAMPLES = 277
_ROWS_PER_STRIP = 278
_STRIP_BYTE_COUNTS = 279
_PLANAR = 284
_TILE_WIDTH = 322
_TILE_HEIGHT = 323
_TILE_OFFSETS = 324
_TILE_BYTE_COUNTS = 325
_SAMPLE_FORMAT = 339
_GEO_KEY_DIRECTORY = 34735
_MODEL_PIXEL_SCALE = 33550
_MODEL_TIEPOINT = 33922
_GDAL_NODATA = 42113

# TIFF field types -> (struct code, byte size).
_TYPES = {
    1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8),
    6: ("b", 1), 7: ("B", 1), 8: ("h", 2), 9: ("i", 4), 10: ("ii", 8),
    11: ("f", 4), 12: ("d", 8),
}

_SAMPLE_FORMAT_IEEE_FLOAT = 3
_COMPRESSION_NONE = 1

# GeoKeys, from the GeoTIFF specification. These are checked rather than assumed —
# see `_check_geokeys`.
_GT_MODEL_TYPE = 1024
_GT_RASTER_TYPE = 1025
_GEOGRAPHIC_TYPE = 2048

_MODEL_TYPE_GEOGRAPHIC = 2
_RASTER_PIXEL_IS_AREA = 1
_EPSG_WGS84 = 4326


class TiffError(ValueError):
    """The file is not the narrow shape this reader supports."""


@dataclass
class Raster:
    """A north-up geographic raster: values, and where on the ellipsoid they sit."""

    width: int
    height: int
    #: Row-major, top row first. Length is `width * height`.
    values: array.array
    #: Longitude and latitude of the *outer corner* of the top-left pixel.
    west: float
    north: float
    #: Degrees per pixel. Both positive; latitude decreases down the raster.
    scale_lon: float
    scale_lat: float
    nodata: float | None

    @property
    def east(self) -> float:
        return self.west + self.width * self.scale_lon

    @property
    def south(self) -> float:
        return self.north - self.height * self.scale_lat

    def sample(self, lon: float, lat: float) -> float | None:
        """
        Bilinear sample at a geographic coordinate. `None` outside, or on no-data.

        Pixel *centres* sit half a pixel in from the raster's outer edge — the tie
        point names the corner of the first pixel, not its middle. Getting that
        wrong shifts every elevation by half a cell, which at 10 m posts is a five
        metre bias applied uniformly across a city: invisible, and wrong.
        """
        u = (lon - self.west) / self.scale_lon - 0.5
        v = (self.north - lat) / self.scale_lat - 0.5

        if u < 0 or v < 0 or u > self.width - 1 or v > self.height - 1:
            return None

        u0 = int(u)
        v0 = int(v)
        u1 = min(u0 + 1, self.width - 1)
        v1 = min(v0 + 1, self.height - 1)
        fu = u - u0
        fv = v - v0

        vals = self.values
        w = self.width
        h00 = vals[v0 * w + u0]
        h10 = vals[v0 * w + u1]
        h01 = vals[v1 * w + u0]
        h11 = vals[v1 * w + u1]

        # No-data is not a number to interpolate through. One void corner would drag
        # a -9999 into three neighbouring samples and punch a hole in the terrain.
        nd = self.nodata
        if nd is not None and nd in (h00, h10, h01, h11):
            return None

        a = h00 + (h10 - h00) * fu
        b = h01 + (h11 - h01) * fu
        return a + (b - a) * fv


def _check_geokeys(f: dict[int, tuple]) -> None:
    """
    Refuse a raster whose georeferencing is not what the sampler assumes.

    Three assumptions are baked into `Raster.sample`, and every one of them is a
    silent failure if violated — the numbers still decode, they just describe
    somewhere else:

    - **Geographic, not projected.** A raster requested in Web Mercator by mistake
      decodes fine and then gets sampled as though its metres were degrees.
    - **WGS 84.** `GeoFrame` is WGS 84. A raster on NAD 83 differs by a metre or two
      horizontally in the continental US — small, constant, and untraceable later.
    - **RasterPixelIsArea.** This is what puts pixel centres half a pixel in from the
      tie point. Under the point convention the same arithmetic is off by half a cell
      everywhere.

    The USGS service satisfies all three today. This exists for the day it does not,
    or for the day someone points the builder at a different elevation source.
    """
    raw = f.get(_GEO_KEY_DIRECTORY)
    if not raw or len(raw) < 4:
        raise TiffError("no GeoKeyDirectory: cannot confirm the coordinate system")

    keys: dict[int, int] = {}
    for i in range(raw[3]):
        key_id, location, count, value = raw[4 + i * 4 : 8 + i * 4]
        # Only keys stored inline (location 0) are integers we can read here; the
        # ones we check are all of that kind.
        if location == 0 and count == 1:
            keys[key_id] = value

    model = keys.get(_GT_MODEL_TYPE)
    if model != _MODEL_TYPE_GEOGRAPHIC:
        raise TiffError(
            f"expected a geographic raster (GTModelType {_MODEL_TYPE_GEOGRAPHIC}), got {model}"
        )

    raster_type = keys.get(_GT_RASTER_TYPE)
    if raster_type != _RASTER_PIXEL_IS_AREA:
        raise TiffError(
            f"expected RasterPixelIsArea ({_RASTER_PIXEL_IS_AREA}), got {raster_type}: "
            "pixel centres would be half a cell from where the sampler puts them"
        )

    datum = keys.get(_GEOGRAPHIC_TYPE)
    if datum != _EPSG_WGS84:
        raise TiffError(f"expected WGS 84 (EPSG:{_EPSG_WGS84}), got EPSG:{datum}")


def _read_ifd(buf: bytes) -> tuple[str, dict[int, tuple]]:
    if buf[:2] == b"II":
        endian = "<"
    elif buf[:2] == b"MM":
        endian = ">"
    else:
        raise TiffError(f"not a TIFF: magic {buf[:4]!r}")

    magic, ifd_offset = struct.unpack(endian + "HI", buf[2:8])
    if magic != 42:
        raise TiffError(f"not a classic TIFF (BigTIFF?): version {magic}")

    (count,) = struct.unpack(endian + "H", buf[ifd_offset : ifd_offset + 2])
    fields: dict[int, tuple] = {}

    for i in range(count):
        p = ifd_offset + 2 + i * 12
        tag, typ, n = struct.unpack(endian + "HHI", buf[p : p + 8])
        code, size = _TYPES.get(typ, ("B", 1))
        # Rationals are two longs each, so the struct code is two characters.
        per = len(code) if code != "s" else 1
        total = size * n

        if total <= 4:
            raw = buf[p + 8 : p + 8 + total]
        else:
            (offset,) = struct.unpack(endian + "I", buf[p + 8 : p + 12])
            raw = buf[offset : offset + total]

        if code == "s":
            fields[tag] = (raw.decode("ascii", "replace").rstrip("\x00"),)
        else:
            fields[tag] = struct.unpack(endian + code * n, raw)
        del per

    return endian, fields


def read_geotiff(buf: bytes) -> Raster:
    """Decode a single-band float32 GeoTIFF. Raises `TiffError` on anything else."""
    endian, f = _read_ifd(buf)

    def one(tag: int, default=None):
        v = f.get(tag)
        return default if v is None else v[0]

    width = one(_WIDTH)
    height = one(_HEIGHT)
    if width is None or height is None:
        raise TiffError("no image dimensions")

    if one(_SAMPLES, 1) != 1:
        raise TiffError(f"expected one band, got {one(_SAMPLES)}")
    if one(_BITS) != 32 or one(_SAMPLE_FORMAT) != _SAMPLE_FORMAT_IEEE_FLOAT:
        raise TiffError(f"expected float32, got {one(_BITS)}-bit format {one(_SAMPLE_FORMAT)}")
    if one(_COMPRESSION, _COMPRESSION_NONE) != _COMPRESSION_NONE:
        raise TiffError(f"compressed TIFF (scheme {one(_COMPRESSION)}) is not supported")
    if one(_PLANAR, 1) != 1:
        raise TiffError("planar-separate TIFF is not supported")

    values = array.array("f", bytes(width * height * 4))

    if _TILE_OFFSETS in f:
        tw = one(_TILE_WIDTH)
        th = one(_TILE_HEIGHT)
        offsets = f[_TILE_OFFSETS]
        counts = f[_TILE_BYTE_COUNTS]
        across = (width + tw - 1) // tw

        for i, (off, cnt) in enumerate(zip(offsets, counts)):
            tile = array.array("f")
            tile.frombytes(buf[off : off + cnt])
            if endian == ">":
                tile.byteswap()

            # Tiles are padded out to full size at the right and bottom edges; the
            # padding is real bytes in the file and must not be copied into the image.
            tx = (i % across) * tw
            ty = (i // across) * th
            rows = min(th, height - ty)
            cols = min(tw, width - tx)

            for r in range(rows):
                src = r * tw
                dst = (ty + r) * width + tx
                values[dst : dst + cols] = tile[src : src + cols]
    elif _STRIP_OFFSETS in f:
        rows_per = one(_ROWS_PER_STRIP, height)
        offsets = f[_STRIP_OFFSETS]
        counts = f[_STRIP_BYTE_COUNTS]

        for i, (off, cnt) in enumerate(zip(offsets, counts)):
            strip = array.array("f")
            strip.frombytes(buf[off : off + cnt])
            if endian == ">":
                strip.byteswap()
            dst = i * rows_per * width
            values[dst : dst + len(strip)] = strip
    else:
        raise TiffError("no strip or tile offsets")

    _check_geokeys(f)

    scale = f.get(_MODEL_PIXEL_SCALE)
    tiepoint = f.get(_MODEL_TIEPOINT)
    if not scale or not tiepoint or len(tiepoint) < 6:
        raise TiffError("no georeferencing (ModelPixelScale / ModelTiepoint)")

    # Tiepoint is (rasterI, rasterJ, rasterK, modelX, modelY, modelZ). We require the
    # common form where raster (0, 0) — the top-left corner — is the tied point,
    # because anything else needs an affine we are not equipped to apply.
    if tiepoint[0] != 0.0 or tiepoint[1] != 0.0:
        raise TiffError(f"tiepoint is not at raster origin: {tiepoint[:3]}")

    nodata_raw = f.get(_GDAL_NODATA)
    nodata = None
    if nodata_raw:
        try:
            nodata = float(nodata_raw[0])
        except ValueError:
            nodata = None

    return Raster(
        width=width,
        height=height,
        values=values,
        west=float(tiepoint[3]),
        north=float(tiepoint[4]),
        scale_lon=float(scale[0]),
        scale_lat=float(scale[1]),
        nodata=nodata,
    )
