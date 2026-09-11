/**
 * Fetching a built region at runtime.
 *
 * `region.ts` deliberately takes an `ArrayBuffer` somebody else loaded and knows
 * nothing about the network — which is what lets a region be built and interrogated
 * in Node, and what lets `regions.test.ts` check the committed data through the same
 * class the browser uses. This file is the somebody else, and it is the only part of
 * the region path that cannot run headless.
 *
 * The manifest and blob are fetched together rather than in sequence. They are
 * useless apart, and a region is three megabytes: a serial fetch spends a whole
 * round trip discovering the name of a file it was always going to ask for.
 *
 * Paths are relative to the document. Vite is configured with `base: './'`, so the
 * built site works both at the root of a dev server and under the `/retro-flyer/`
 * prefix GitHub Pages serves it from, without either being written down here.
 */

import { RegionSource, type RegionManifest } from './region.js'

/** Regions committed under `public/regions/`. */
export const REGIONS = ['new-york', 'chicago'] as const

export type RegionId = (typeof REGIONS)[number]

export const isRegionId = (value: string): value is RegionId =>
  (REGIONS as readonly string[]).includes(value)

export async function loadRegion(id: RegionId): Promise<RegionSource> {
  const [manifestResponse, blobResponse] = await Promise.all([
    fetch(`regions/${id}.json`),
    fetch(`regions/${id}.bin`),
  ])

  // A 404 here returns the index page with a 200 in some static hosts, so the status
  // is checked rather than assumed, and the parse below would otherwise fail with a
  // syntax error pointing at HTML.
  if (!manifestResponse.ok || !blobResponse.ok) {
    throw new Error(
      `region "${id}": manifest ${manifestResponse.status}, blob ${blobResponse.status}`,
    )
  }

  const [manifest, blob] = await Promise.all([
    manifestResponse.json() as Promise<RegionManifest>,
    blobResponse.arrayBuffer(),
  ])

  return new RegionSource(manifest, blob)
}
