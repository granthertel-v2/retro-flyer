/**
 * What the launch screen decides, with none of the screen.
 *
 * The shell has exactly two jobs that are worth testing — working out what the user
 * asked for, and working out whether their device can fly at all — and neither of
 * them needs a DOM. So they live here, as plain functions over plain values, and
 * `screens.ts` does nothing but turn the results into elements.
 *
 * This split is the house pattern rather than a new idea: `speedCue` sits in
 * `overlay.ts` with the note "a pure function so it can be tested — the class around
 * it touches `document` and cannot be", and `nearestPlace` sits the same way in
 * `minimap.ts`. `vitest.config.ts` runs this package in Node with no DOM, so the
 * alternative to splitting is not testing the shell at all.
 *
 * Nothing here imports three.js, the terrain, or the simulation.
 */

import { REGIONS, isRegionId, type RegionId } from '../terrain/load.js'

/**
 * Which world to fly in.
 *
 * `'designed'` is the authored map — the one with no network cost, which every test
 * and the whole of Days 1-4 were flown against. The others are the built regions.
 */
export type MapId = 'designed' | RegionId

/** Where a flight begins. */
export type SpawnMode = 'runway' | 'airborne'

export interface LaunchOptions {
  map: MapId
  spawn: SpawnMode
}

export interface MapChoice {
  id: MapId
  /** Shown on the card. */
  name: string
  /** One line under it. */
  blurb: string
  /** Roughly what it costs to open, for the card. Empty for the authored map. */
  weight: string
  /** The region to fetch, or null for the authored map. */
  region: RegionId | null
}

/**
 * The three worlds, in the order they are offered.
 *
 * The designed map goes first because it is instant and is what the flight model was
 * actually developed against. The regions are opt-in for the reason `chooseMap` gives:
 * three megabytes is something you should have asked for.
 */
export const MAPS: readonly MapChoice[] = [
  {
    id: 'designed',
    name: 'The Designed Map',
    blurb: 'A coastline, a ridge worth flying through, a river, and four airfields.',
    weight: 'instant',
    region: null,
  },
  {
    id: 'new-york',
    name: 'New York',
    blurb: 'Surveyed elevation, 37,517 buildings, the bridges, and Kennedy to start from.',
    weight: '≈3.5 MB',
    region: 'new-york',
  },
  {
    id: 'chicago',
    name: 'Chicago',
    blurb: 'Lake Michigan, 42,312 buildings, the Skyway, and O’Hare to start from.',
    weight: '≈3.8 MB',
    region: 'chicago',
  },
]

/**
 * Data credits, shown in the shell.
 *
 * Every region manifest carries this same list in its `attribution` field, and until
 * now nothing rendered it — the strings were put in the data precisely so they would
 * travel with it, and then never reached a screen. The OpenStreetMap licence is ODbL,
 * which `docs/SOURCES.md` is explicit about: "an obligation, not a courtesy".
 *
 * Held here as a constant rather than read from a manifest because the launch screen
 * has to show it *before* any region is fetched, and both regions carry identical
 * text. `test/options.test.ts` asserts this matches every committed manifest, so it
 * cannot drift from the data it is crediting.
 */
export const CREDITS: readonly string[] = [
  'Map data © OpenStreetMap contributors, ODbL (openstreetmap.org/copyright).',
  'Elevation: USGS 3D Elevation Program (3DEP), public domain.',
  'Airport and runway data: FAA Aeronautical Information Services, public domain.',
  'Some building heights: Wikidata (CC0), property P2048.',
]

/**
 * Default start.
 *
 * Airborne, and that is a considered choice rather than an inherited one. The aircraft
 * is longitudinally unstable by design (see the README), and the single hardest thing
 * for someone who has never flown a simulator is getting it off the ground — a first
 * flight that ends in a departure on the runway teaches nothing and loses the player.
 * Starting trimmed and level at 2,200 ft puts them in the part that is worth feeling.
 *
 * The runway is one click away on the same screen, and `T` still lines up on one.
 */
export const DEFAULT_OPTIONS: LaunchOptions = { map: 'designed', spawn: 'airborne' }

export const isMapId = (value: string): value is MapId =>
  value === 'designed' || isRegionId(value)

const isSpawnMode = (value: string): value is SpawnMode =>
  value === 'runway' || value === 'airborne'

export interface ParsedLaunch {
  options: LaunchOptions
  /** Skip the launch screen and fly immediately. */
  autostart: boolean
  /** Fly even though `canFly` says this device cannot. */
  forceDesktop: boolean
}

/**
 * Work out what to offer, from the URL and from what was chosen last time.
 *
 * Precedence is URL, then storage, then the default. The URL wins because a link is
 * something someone deliberately sent — `?region=chicago` means Chicago even if this
 * browser last flew New York.
 *
 * `?region=` keeps working exactly as it always has, which matters: it is in the
 * README, and it is how the regions have been shared so far. The difference is that
 * it now *preselects* on the launch screen rather than bypassing it, so a link that
 * says "fly Chicago" lands on a screen that already says Chicago.
 */
export function parseLaunchOptions(search: string, stored?: string | null): ParsedLaunch {
  const params = new URLSearchParams(search)
  const remembered = readStored(stored)

  const requested = params.get('region')
  const map: MapId = requested && isMapId(requested) ? requested : remembered.map

  const requestedSpawn = params.get('start')
  const spawn: SpawnMode =
    requestedSpawn && isSpawnMode(requestedSpawn) ? requestedSpawn : remembered.spawn

  return {
    options: { map, spawn },
    autostart: params.get('autostart') === '1',
    forceDesktop: params.get('desktop') === '1',
  }
}

/** Parse a remembered choice, falling back to the default for anything unexpected. */
function readStored(stored?: string | null): LaunchOptions {
  if (!stored) return DEFAULT_OPTIONS

  try {
    const parsed = JSON.parse(stored) as Partial<LaunchOptions>
    return {
      map: typeof parsed.map === 'string' && isMapId(parsed.map) ? parsed.map : DEFAULT_OPTIONS.map,
      spawn:
        typeof parsed.spawn === 'string' && isSpawnMode(parsed.spawn)
          ? parsed.spawn
          : DEFAULT_OPTIONS.spawn,
    }
  } catch {
    return DEFAULT_OPTIONS
  }
}

/**
 * The query string for a set of options.
 *
 * Used to rewrite the address before a reload, because changing world is a reload —
 * nothing in this codebase disposes of a terrain mesh, and four of the objects that
 * own the map take it as a `private readonly` constructor argument.
 *
 * The designed map produces no `region` parameter, so the plain URL keeps meaning
 * what it has always meant.
 */
export function toSearch(options: LaunchOptions): string {
  const params = new URLSearchParams()
  if (options.map !== 'designed') params.set('region', options.map)
  if (options.spawn !== DEFAULT_OPTIONS.spawn) params.set('start', options.spawn)

  const query = params.toString()
  return query ? `?${query}` : ''
}

/** What a device would have to be for flying to be possible. */
export interface Viewport {
  width: number
  height: number
  /** `matchMedia('(pointer: coarse)').matches` — true on phones and tablets. */
  coarsePointer: boolean
}

/** Smallest window the HUD was laid out for. */
export const MIN_WIDTH = 820
export const MIN_HEIGHT = 480

/**
 * Whether this device can fly the simulator.
 *
 * There is exactly one input device — `input.ts` opens with "this is the only file
 * that knows a keyboard exists" — and there is no touch scheme. A phone therefore
 * loads a flight simulator it cannot control, and worse, loses the controls card to
 * its own first tap and has no way to ask for it back.
 *
 * A coarse pointer is the test, not the screen size. It is the closest thing the
 * platform offers to "there is no keyboard here", and it is right about phones and
 * tablets, which is who this is for. It is wrong about a tablet with a keyboard case
 * attached — hence `?desktop=1`, which the gate itself offers as a way through.
 *
 * The size floor catches the other case: a desktop browser in a very small window,
 * where the HUD's landscape layout stops fitting.
 */
export function canFly(viewport: Viewport): boolean {
  if (viewport.coarsePointer) return false
  return viewport.width >= MIN_WIDTH && viewport.height >= MIN_HEIGHT
}

/** The region a set of options asks to be fetched, or null for the authored map. */
export function regionOf(options: LaunchOptions): RegionId | null {
  return options.map === 'designed' ? null : options.map
}

/**
 * Display name for a map id.
 *
 * Takes a plain string rather than a `MapId` because one caller has one that came out
 * of `localStorage` — a saved situation records the world it was taken in, and that
 * world may no longer be one we offer. Falling back to the id is better than nothing,
 * and better than asserting the type away at the call site.
 */
export function nameOf(map: string): string {
  return MAPS.find((m) => m.id === map)?.name ?? map
}

/** Every map id, for tests and for anything that needs to enumerate them. */
export const MAP_IDS: readonly MapId[] = ['designed', ...REGIONS]
