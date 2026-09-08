/**
 * The moving map's one piece of judgement.
 *
 * Everything else in `minimap.ts` is drawing and needs a canvas. This does not, and
 * it is the part that can be wrong in a way nobody notices: the caption naming a
 * place is the answer to "where am I", and an answer that is technically nearest but
 * useless — a hamlet while Newark sits four miles off — is worse than none, because
 * it is believed.
 */

import { describe, expect, it } from 'vitest'
import { nearestPlace } from '../src/minimap.js'
import type { Place } from '../src/terrain/source.js'

const place = (name: string, x: number, z: number, rank: number): Place =>
  ({ name, x, z, rank })

describe('naming where you are', () => {
  it('says nothing when there is nothing to say', () => {
    expect(nearestPlace([], 0, 0)).toBeNull()
  })

  it('prefers a city a little further away to a hamlet underfoot-ish', () => {
    const found = nearestPlace(
      [place('Tiny', 3_000, 0, 5), place('Newark', 4_000, 0, 0)],
      0, 0,
    )
    expect(found?.place.name).toBe('Newark')
  })

  it('but not when the small place is genuinely underneath', () => {
    // The bias must not become a filter. Directly over Astoria, "New York" is the
    // less useful answer even though it outranks it.
    const found = nearestPlace(
      [place('Astoria', 200, 0, 5), place('New York', 9_000, 0, 0)],
      0, 0,
    )
    expect(found?.place.name).toBe('Astoria')
  })

  it('reports the true distance, not the weighted one', () => {
    // The caption prints this number. Printing the rank-scaled score would put a
    // city at "6.2 nm" when it is four miles away, which is a navigation error.
    const found = nearestPlace([place('Newark', 3_000, 4_000, 0)], 0, 0)
    expect(found?.distanceM).toBeCloseTo(5_000, 6)
  })

  it('is stable when two places tie', () => {
    const places = [place('First', 1_000, 0, 2), place('Second', 1_000, 0, 2)]
    expect(nearestPlace(places, 0, 0)?.place.name).toBe('First')
  })
})
