/**
 * The authored map, seen from the physics package.
 *
 * Two seams meet here and they use different units. `TerrainSource` (§8.2) answers
 * in three.js world space — metres, X east, Z south, Y up — because it exists for
 * the renderer. `GroundSource` in the physics package answers in the flight model's
 * frame — feet, north and east of origin — because a flight model that had to know
 * about three.js would not be headless.
 *
 * This adapter is the whole cost of keeping them apart, and it is thirty lines. The
 * alternative is a three.js import inside the aerodynamics.
 *
 * The axis flip is the same one `loop.ts` does when it places a spawn: the renderer
 * puts north at -Z, so `pn = -z` and `pe = +x`.
 */

import { ftToM, mToFt, type GroundSample, type GroundSource } from '@retro-flyer/physics'
import { PAVED, SOFT, WATER } from '@retro-flyer/physics'
import { Surface, type TerrainSource } from './source.js'

/**
 * Surface type to what it is like to roll on. `[A]`
 *
 * The city maps to open ground rather than pavement on purpose. Its roads are not
 * modelled — the grid is buildings — so an aircraft that finds itself there has not
 * landed on a road, and giving it runway grip would be the wrong kind of generous.
 */
function material(surface: Surface): Omit<GroundSample, 'elevation'> {
  switch (surface) {
    case Surface.Runway:
      return PAVED
    case Surface.Water:
      return WATER
    default:
      return SOFT
  }
}

export class AuthoredGroundSource implements GroundSource {
  constructor(private readonly terrain: TerrainSource) {}

  sample(pn: number, pe: number): GroundSample {
    // Feet and NED in; metres and three.js world space out.
    const x = ftToM(pe)
    const z = -ftToM(pn)

    const t = this.terrain.sample(x, z)

    return { elevation: mToFt(t.height), ...material(t.surface) }
  }
}
