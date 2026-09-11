"""
Bare-earth elevation, from the USGS 3D Elevation Program.

## Why 3DEP

It is the authoritative elevation dataset for the United States, it is public domain
as a work of the US government, and — the part that decided it — it is served as a
**dynamic image service**, so a caller can ask for an arbitrary bounding box at an
arbitrary resolution and get one raster back. The alternative shape, downloading
pre-cut tiles and mosaicking them, means a tile index, a tile cache, seam handling
and a lot of code that exists only to reassemble something the server will assemble
for us.

`bare earth` matters: the DEM is the ground, with buildings and vegetation removed.
That is what a terrain mesh wants, because the buildings arrive separately from
OpenStreetMap and would otherwise be counted twice — once as a bump in the ground and
again as a box standing on it.

## Resolution, and what is worth asking for

The renderer's finest LOD ring uses 60 m cells (`mesh.ts`). Sampling the ground finer
than that cannot show up on screen; it can only make the blob bigger. So the builder
asks 3DEP to do the downsampling — the service resamples from its 1 m and 1/9 arc-
second sources server-side — rather than pulling native resolution and averaging it
here. Same answer, a hundredth of the bytes.

## The one asymmetry

The service returns square pixels *in degrees*, and a degree of longitude at 40°N is
24% shorter than a degree of latitude. So a raster requested at 60 m of latitude
resolution is 45 m in longitude. That is finer than asked for on one axis, which is
harmless — it is never coarser.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .fetch import fetch
from .tiff import Raster, read_geotiff

SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer"

#: `maxImageWidth` / `maxImageHeight` as published by the service.
MAX_PIXELS = 8000

#: Metres per degree of latitude, near enough for choosing a request size. The exact
#: figure varies by half a percent with latitude and is not worth carrying here: this
#: number only decides how many pixels to ask for, and the resulting raster's true
#: geometry is read back from its own geotransform.
M_PER_DEG_LAT = 111_320.0

#: What the licence requires. USGS data is public domain, so this is a courtesy and a
#: provenance record rather than an obligation — but it rides in the region data
#: because a region that travels without its provenance is a region nobody can check.
ATTRIBUTION = "Elevation: USGS 3D Elevation Program (3DEP), public domain."

#: Value the service uses for "no data here".
NODATA = -9999


@dataclass
class Dem:
    """One or more overlapping rasters covering a region. Sampled as if seamless."""

    rasters: list[Raster]

    def sample(self, lon: float, lat: float) -> float | None:
        for raster in self.rasters:
            value = raster.sample(lon, lat)
            if value is not None:
                return value
        return None

    @property
    def pixel_count(self) -> int:
        return sum(r.width * r.height for r in self.rasters)


def _export(west: float, south: float, east: float, north: float, w: int, h: int, label: str) -> Raster:
    query = "&".join(
        [
            f"bbox={west},{south},{east},{north}",
            "bboxSR=4326",
            "imageSR=4326",
            f"size={w},{h}",
            "format=tiff",
            "pixelType=F32",
            f"noData={NODATA}",
            "noDataInterpretation=esriNoDataMatchAny",
            # Bilinear rather than nearest: the service is resampling from a much
            # finer source, and nearest-neighbour downsampling of a 1 m DEM to 60 m
            # throws away 3,599 samples out of every 3,600 and keeps whichever one
            # happened to land on the grid — which is how a smooth hillside acquires
            # a texture of spurious pits and spikes.
            "interpolation=RSP_BilinearInterpolation",
            "f=image",
        ]
    )
    return read_geotiff(fetch(f"{SERVICE}/exportImage?{query}", label=label))


def fetch_dem(
    west: float,
    south: float,
    east: float,
    north: float,
    resolution_m: float,
    *,
    label: str = "elevation",
) -> Dem:
    """
    Elevation over a geographic box, at about `resolution_m` on the ground.

    Split into several requests when one would exceed the service's pixel limit. The
    sub-boxes are grown by a pixel of overlap on every side, because a point landing
    exactly on the boundary between two of them must be inside one of them — and a
    bilinear sample needs a neighbour on each side, so "inside" has to mean inside by
    a pixel, not by an epsilon.
    """
    scale = resolution_m / M_PER_DEG_LAT

    width = max(2, math.ceil((east - west) / scale))
    height = max(2, math.ceil((north - south) / scale))

    across = math.ceil(width / MAX_PIXELS)
    down = math.ceil(height / MAX_PIXELS)

    if across * down == 1:
        # Ask for a box whose aspect ratio matches the pixel count exactly. The
        # service preserves square pixels by *growing* the extent when they disagree,
        # which is harmless but means the raster covers different ground than the
        # request named — and everything downstream would then be reading a
        # geotransform that quietly disagrees with the box it asked for.
        return Dem([_export(west, south, west + width * scale, south + height * scale, width, height, label)])

    rasters: list[Raster] = []
    tile_w = math.ceil(width / across)
    tile_h = math.ceil(height / down)

    for j in range(down):
        for i in range(across):
            w0 = west + (i * tile_w - 1) * scale
            s0 = south + (j * tile_h - 1) * scale
            w_px = tile_w + 2
            h_px = tile_h + 2
            rasters.append(
                _export(
                    w0, s0, w0 + w_px * scale, s0 + h_px * scale, w_px, h_px,
                    f"{label} tile {j * across + i + 1}/{across * down}",
                )
            )

    return Dem(rasters)
