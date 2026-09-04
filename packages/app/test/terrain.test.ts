/**
 * The authored map (§7) and the §8.2 source contract.
 *
 * The map is a design artefact, so most of what matters about it is a judgment call
 * you make by looking at it. But a handful of its properties are load-bearing for
 * later days and are cheap to pin now:
 *
 * - Day 3 lands on the airfields, so the pads have to be flat and the spacing has to
 *   be what §7 asked for.
 * - Day 3's waypoint course and situation save/restore assume the world is identical
 *   on every load, so the map has to be deterministic.
 * - Every consumer assumes `height()` returns a number, so it has to — including out
 *   past the edge of the map, where the renderer's outer LOD ring samples.
 */

import { describe, expect, it } from 'vitest'
import {
  MAP_EXTENT,
  authoredMap as map,
  inCity,
  separationNm,
} from '../src/terrain/authored.js'
import { Surface } from '../src/terrain/source.js'

/** Walk a grid over the whole map and hand each sample to a visitor. */
function overMap(step: number, visit: (x: number, z: number) => void): void {
  for (let z = -MAP_EXTENT; z <= MAP_EXTENT; z += step) {
    for (let x = -MAP_EXTENT; x <= MAP_EXTENT; x += step) visit(x, z)
  }
}

describe('the source contract (§8.2)', () => {
  it('returns a finite height everywhere on the map', () => {
    overMap(900, (x, z) => {
      const h = map.height(x, z)
      if (!Number.isFinite(h)) throw new Error(`height(${x}, ${z}) = ${h}`)
    })
  })

  it('returns a finite height well outside the map', () => {
    // The outer LOD ring samples past the edge. Returning NaN there produces a
    // geometry full of NaN vertices, which three.js renders as nothing at all —
    // a black screen with no error, which is a miserable thing to debug.
    for (const d of [MAP_EXTENT * 1.5, MAP_EXTENT * 4, 1e6]) {
      expect(Number.isFinite(map.height(d, d))).toBe(true)
      expect(Number.isFinite(map.height(-d, d))).toBe(true)
      expect(Number.isFinite(map.height(d, -d))).toBe(true)
    }
  })

  it('is deterministic', () => {
    // Day 3's course and save/restore both assume this. If terrain generation ever
    // acquires a Math.random(), this is what says so.
    const probes: [number, number][] = [
      [0, 0], [12_345, -6_789], [-30_000, 40_000], [51_000, -51_000],
    ]

    for (const [x, z] of probes) {
      expect(map.height(x, z)).toBe(map.height(x, z))
      expect(map.sample(x, z).surface).toBe(map.sample(x, z).surface)
    }
  })

  it('is continuous — no cliffs between adjacent samples', () => {
    // A crease in a flat-shaded world is a bright line of wrong-coloured triangles.
    // 60 m over 30 m of ground is a 63 degree slope; steeper than that is a bug in
    // a blend, not terrain.
    let worst = 0

    for (let z = -MAP_EXTENT; z <= MAP_EXTENT; z += 700) {
      for (let x = -MAP_EXTENT; x < MAP_EXTENT; x += 30) {
        const d = Math.abs(map.height(x + 30, z) - map.height(x, z))
        if (d > worst) worst = d
      }
    }

    expect(worst).toBeLessThan(60)
  })
})

describe('the coastline and the bay (§7)', () => {
  it('has open water', () => {
    let water = 0
    let total = 0

    overMap(1_200, (x, z) => {
      total++
      if (map.sample(x, z).surface === Surface.Water) water++
    })

    // Enough sea to fly out over and see a coastline against, but not a map that
    // is mostly ocean.
    expect(water / total).toBeGreaterThan(0.1)
    expect(water / total).toBeLessThan(0.45)
  })

  it('puts water west of the coast and land east of it', () => {
    expect(map.sample(-45_000, 0).surface).toBe(Surface.Water)
    expect(map.height(-45_000, 0)).toBeLessThan(0)

    expect(map.sample(10_000, 0).surface).toBe(Surface.Land)
    expect(map.height(10_000, 0)).toBeGreaterThan(0)
  })

  it('cuts the bay into the land and opens it to the sea', () => {
    // Centre of the bay is water...
    expect(map.height(-14_000, 6_000)).toBeLessThan(0)
    // ...and so is the water between it and the open ocean, or it is a lake.
    expect(map.height(-26_000, 6_000)).toBeLessThan(0)
    // East of the bay head is dry.
    expect(map.height(-1_000, 6_000)).toBeGreaterThan(0)
  })

  it('shelves rather than dropping to depth at the shoreline', () => {
    // Sampling east to west across the shore, depth should increase gradually.
    const depths = [-22_000, -26_000, -32_000, -40_000].map((x) => map.height(x, -30_000))

    for (let i = 1; i < depths.length; i++) {
      expect(depths[i] as number).toBeLessThanOrEqual((depths[i - 1] as number) + 1)
    }
    expect(depths[depths.length - 1] as number).toBeLessThan(-100)
  })
})

describe('the ridge (§7)', () => {
  it('rises well above the surrounding terrain', () => {
    let highest = 0
    overMap(600, (x, z) => {
      const h = map.height(x, z)
      if (h > highest) highest = h
    })

    // Design target is a crest around 2,300 to 2,400 m — roughly 7,700 ft, high
    // enough to be a real obstacle at low level and low enough that the aircraft
    // can go over it without a climb worth resenting. `[A]`, like every number in
    // the map.
    expect(highest).toBeGreaterThan(1_800)
    expect(highest).toBeLessThan(2_800)
  })

  it('has a pass low enough to fly through rather than over', () => {
    // §7 asks for "a ridge line worth flying through". That means a gap, and the
    // gap has to be meaningfully below the crest either side of it or it is just a
    // dip. Walk the spine and check the profile has a real notch.
    const spine: [number, number][] = []
    for (let z = -46_000; z <= 38_000; z += 500) {
      // Follow the crest by taking the highest point on an east-west cut.
      let best = -Infinity
      let bestX = 0
      for (let x = 0; x <= 42_000; x += 250) {
        const h = map.height(x, z)
        if (h > best) {
          best = h
          bestX = x
        }
      }
      spine.push([z, best])
      void bestX
    }

    const heights = spine.map(([, h]) => h)
    const peak = Math.max(...heights)

    // Find the deepest interior notch: a local minimum with high ground both sides.
    let deepestNotch = Infinity
    for (let i = 6; i < heights.length - 6; i++) {
      const left = Math.max(...heights.slice(0, i))
      const right = Math.max(...heights.slice(i + 1))
      const h = heights[i] as number
      if (left > 1_500 && right > 1_500 && h < deepestNotch) deepestNotch = h
    }

    expect(peak).toBeGreaterThan(1_800)
    expect(deepestNotch).toBeLessThan(1_300)
    expect(peak - deepestNotch).toBeGreaterThan(700)
  })
})

describe('the river (§7)', () => {
  it('sits below the ground either side of it', () => {
    // Cut across the river near its middle and check the channel is the low point.
    const z = 3_000
    const onRiver = map.height(2_000, z)
    const north = map.height(2_000, z - 4_000)
    const south = map.height(2_000, z + 4_000)

    expect(onRiver).toBeLessThan(north)
    expect(onRiver).toBeLessThan(south)
  })

  it('runs downhill from the ridge to the bay', () => {
    const headwater = map.height(17_000, -2_000)
    const middle = map.height(2_000, 3_000)
    const mouth = map.height(-11_500, 6_500)

    expect(headwater).toBeGreaterThan(middle)
    expect(middle).toBeGreaterThan(mouth)
  })
})

describe('the city (§7)', () => {
  it('is flat enough to extrude blocks onto', () => {
    let min = Infinity
    let max = -Infinity

    for (let z = -12_500; z <= -7_500; z += 100) {
      for (let x = -19_000; x <= -13_000; x += 100) {
        if (!inCity(x, z)) continue
        const h = map.height(x, z)
        if (h < min) min = h
        if (h > max) max = h
      }
    }

    expect(max - min).toBeLessThan(12)
  })

  it('reports the City surface inside and Land outside', () => {
    expect(map.sample(-16_000, -10_000).surface).toBe(Surface.City)
    expect(map.sample(-16_000, -22_000).surface).toBe(Surface.Land)
  })
})

describe('the airfields (§7)', () => {
  it('has four of them', () => {
    expect(map.airfields).toHaveLength(4)
  })

  it('spaces every pair between 20 and 60 nm apart', () => {
    // §7 states this explicitly. It is the kind of constraint that quietly stops
    // holding the moment a field is nudged to get it off a hillside.
    for (let i = 0; i < map.airfields.length; i++) {
      for (let j = i + 1; j < map.airfields.length; j++) {
        const a = map.airfields[i]!
        const b = map.airfields[j]!
        const nm = separationNm(a, b)

        expect(nm, `${a.name} to ${b.name}`).toBeGreaterThanOrEqual(20)
        expect(nm, `${a.name} to ${b.name}`).toBeLessThanOrEqual(60)
      }
    }
  })

  it('gives every field a flat pad at its own elevation', () => {
    // Day 3 lands on these. A runway with a metre of undulation in it will make
    // the gear model look broken when the gear model is fine.
    for (const f of map.airfields) {
      const heading = (f.headingDeg * Math.PI) / 180
      const alongX = Math.sin(heading)
      const alongZ = -Math.cos(heading)

      let min = Infinity
      let max = -Infinity

      for (let s = -f.lengthM / 2; s <= f.lengthM / 2; s += 25) {
        for (let w = -f.widthM / 2; w <= f.widthM / 2; w += 10) {
          // Across-runway axis is 90 degrees right of the heading.
          const x = f.x + alongX * s + Math.cos(heading) * w
          const z = f.z + alongZ * s + Math.sin(heading) * w
          const h = map.height(x, z)
          if (h < min) min = h
          if (h > max) max = h
        }
      }

      expect(max - min, `${f.name} runway flatness`).toBeLessThan(0.5)
      expect(Math.abs(min - f.elevation), `${f.name} elevation`).toBeLessThan(1)
    }
  })

  it('puts every field on dry land', () => {
    for (const f of map.airfields) {
      expect(f.elevation, f.name).toBeGreaterThan(0)
      expect(map.sample(f.x, f.z).surface, f.name).toBe(Surface.Runway)
    }
  })

  it('keeps every field inside the map', () => {
    for (const f of map.airfields) {
      expect(Math.abs(f.x), f.name).toBeLessThan(MAP_EXTENT)
      expect(Math.abs(f.z), f.name).toBeLessThan(MAP_EXTENT)
    }
  })
})
