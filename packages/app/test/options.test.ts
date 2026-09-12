/**
 * The launch screen's decisions, without the screen.
 *
 * Two of these matter more than the rest.
 *
 * **The deep links.** `?region=new-york` is in the README and is how the regions have
 * been shared so far. The shell changes what that URL *does* — it now preselects on a
 * launch screen rather than bypassing straight into the cockpit — but it must never
 * change what it *means*. A round-trip test is the only thing standing between a
 * refactor and a pile of links that quietly open the wrong world.
 *
 * **The credits.** `CREDITS` is a constant in the source, and the thing it credits is
 * data in `public/regions/`. Those can drift apart silently, and the OpenStreetMap
 * half of it is ODbL, where being wrong is a licence problem rather than a cosmetic
 * one. So the constant is checked against every committed manifest.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CREDITS,
  DEFAULT_OPTIONS,
  MAPS,
  MAP_IDS,
  MIN_HEIGHT,
  MIN_WIDTH,
  canFly,
  nameOf,
  parseLaunchOptions,
  regionOf,
  toSearch,
  type LaunchOptions,
} from '../src/shell/options.js'
import { REGIONS } from '../src/terrain/load.js'

describe('the maps on offer', () => {
  it('offers the authored map and every committed region, once each', () => {
    expect(MAPS.map((m) => m.id)).toEqual(['designed', ...REGIONS])
    expect(new Set(MAP_IDS).size).toBe(MAP_IDS.length)
  })

  it('asks for a region for the real ones and nothing for the authored map', () => {
    expect(regionOf({ map: 'designed', spawn: 'airborne' })).toBeNull()
    expect(regionOf({ map: 'new-york', spawn: 'runway' })).toBe('new-york')
    expect(regionOf({ map: 'chicago', spawn: 'runway' })).toBe('chicago')
  })

  it('names every one of them', () => {
    for (const id of MAP_IDS) expect(nameOf(id)).not.toBe('')
    expect(nameOf('new-york')).toBe('New York')
  })

  it('says what each one costs to open', () => {
    for (const map of MAPS) {
      expect(map.blurb.length).toBeGreaterThan(0)
      expect(map.weight.length).toBeGreaterThan(0)
    }
  })
})

describe('reading the URL', () => {
  it('defaults to the designed map, airborne, with nothing in the URL', () => {
    expect(parseLaunchOptions('').options).toEqual(DEFAULT_OPTIONS)
  })

  // The links that already exist, and that the README documents.
  it('still understands ?region=', () => {
    expect(parseLaunchOptions('?region=new-york').options.map).toBe('new-york')
    expect(parseLaunchOptions('?region=chicago').options.map).toBe('chicago')
  })

  it('falls back to the designed map for a region that does not exist', () => {
    expect(parseLaunchOptions('?region=atlantis').options.map).toBe('designed')
  })

  it('reads the spawn mode', () => {
    expect(parseLaunchOptions('?start=runway').options.spawn).toBe('runway')
    expect(parseLaunchOptions('?start=airborne').options.spawn).toBe('airborne')
    expect(parseLaunchOptions('?start=underwater').options.spawn).toBe(DEFAULT_OPTIONS.spawn)
  })

  it('reads the automation bypass, which the browser QA workflow depends on', () => {
    expect(parseLaunchOptions('?autostart=1').autostart).toBe(true)
    expect(parseLaunchOptions('').autostart).toBe(false)
    expect(parseLaunchOptions('?autostart=0').autostart).toBe(false)
  })

  it('reads the gate override', () => {
    expect(parseLaunchOptions('?desktop=1').forceDesktop).toBe(true)
    expect(parseLaunchOptions('').forceDesktop).toBe(false)
  })
})

describe('remembering the last choice', () => {
  const stored = JSON.stringify({ map: 'chicago', spawn: 'runway' })

  it('uses it when the URL says nothing', () => {
    expect(parseLaunchOptions('', stored).options).toEqual({ map: 'chicago', spawn: 'runway' })
  })

  // A link someone sent beats what this browser happened to do last.
  it('lets the URL win', () => {
    expect(parseLaunchOptions('?region=new-york', stored).options.map).toBe('new-york')
  })

  it('survives anything at all in storage', () => {
    for (const junk of ['', 'null', '{', '[]', '{"map":7}', '{"map":"atlantis"}', 'undefined']) {
      expect(parseLaunchOptions('', junk).options).toEqual(DEFAULT_OPTIONS)
    }
  })
})

describe('writing the URL back', () => {
  // Changing world is a reload, so these two have to be exact inverses or the reload
  // lands somewhere other than where the menu said it would.
  it('round-trips every combination', () => {
    for (const map of MAP_IDS) {
      for (const spawn of ['runway', 'airborne'] as const) {
        const options: LaunchOptions = { map, spawn }
        expect(parseLaunchOptions(toSearch(options)).options).toEqual(options)
      }
    }
  })

  it('leaves the plain URL plain for the designed map at its default start', () => {
    expect(toSearch(DEFAULT_OPTIONS)).toBe('')
  })

  it('writes a region link that matches the documented form', () => {
    expect(toSearch({ map: 'new-york', spawn: 'airborne' })).toBe('?region=new-york')
  })
})

describe('the desktop gate', () => {
  const desktop = { width: 1440, height: 900, coarsePointer: false }

  it('lets a laptop fly', () => {
    expect(canFly(desktop)).toBe(true)
  })

  // The real test. There is no touch control scheme at all, so a coarse pointer is
  // a device that loads the simulator and then cannot move a single control.
  it('stops a phone, in either orientation', () => {
    expect(canFly({ width: 390, height: 844, coarsePointer: true })).toBe(false)
    expect(canFly({ width: 844, height: 390, coarsePointer: true })).toBe(false)
  })

  it('stops a tablet, which is large enough to look flyable and is not', () => {
    expect(canFly({ width: 1024, height: 768, coarsePointer: true })).toBe(false)
    expect(canFly({ width: 1366, height: 1024, coarsePointer: true })).toBe(false)
  })

  it('stops a desktop window too small for the HUD to lay out in', () => {
    expect(canFly({ ...desktop, width: MIN_WIDTH - 1 })).toBe(false)
    expect(canFly({ ...desktop, height: MIN_HEIGHT - 1 })).toBe(false)
    expect(canFly({ ...desktop, width: MIN_WIDTH })).toBe(true)
    expect(canFly({ ...desktop, height: MIN_HEIGHT })).toBe(true)
  })
})

describe('the data credits', () => {
  const manifestAttribution = (id: string): string[] => {
    const dir = fileURLToPath(new URL('../public/regions/', import.meta.url))
    return (JSON.parse(readFileSync(`${dir}${id}.json`, 'utf8')) as { attribution: string[] })
      .attribution
  }

  // The point of the whole test. `CREDITS` is what a user is shown; the manifests are
  // what the data actually says. If a rebuild changes one, this fails rather than the
  // app quietly crediting the wrong people.
  it('says exactly what every committed region says', () => {
    for (const id of REGIONS) expect(CREDITS).toEqual(manifestAttribution(id))
  })

  it('names OpenStreetMap and its licence, which is the obligation', () => {
    const all = CREDITS.join(' ')
    expect(all).toContain('OpenStreetMap')
    expect(all).toContain('ODbL')
  })
})
