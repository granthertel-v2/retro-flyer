/**
 * Where a Day 2 flight begins.
 *
 * Its own module because it is three.js-free and therefore testable, and because the
 * altitude in it is the single largest speed-sensation decision in the renderer —
 * see below. `main.ts` cannot be imported from a test; this can.
 */

import type { SpawnCondition } from './loop.js'
import type { Airfield } from './terrain/source.js'

/**
 * Spawn state.
 *
 * The altitude is a speed-sensation decision, not a safety one, and it is the single
 * largest one in the renderer (§6).
 *
 * The dominant cue for speed is the angular rate at which the ground sweeps beneath
 * you, and that is just `V / h`. It does not care how fast you are actually going.
 * At 640 ft/s the same aeroplane gives:
 *
 *     11,000 ft      3.3 deg/s      an airliner
 *      2,200 ft     16.7 deg/s      fast
 *        800 ft     45.8 deg/s      alarming
 *
 * Spawning at 11,000 ft therefore made a Mach 0.9 fighter feel like a cruise, which
 * is exactly what it should feel like from two miles up — the flight model was
 * never the problem. 2,200 ft over the bay is low enough that the coast, the city
 * and the ridge all read at speed, and high enough to leave room to look around
 * before descending.
 *
 * Note that there is no ground collision until Day 3 (§9), so flying below the
 * ridge line passes through it rather than ending the flight.
 */
export const SPAWN: SpawnCondition = {
  alt: 2_200,
  vt: 640,
  // Pointed east-south-east, at the ridge, from over the bay.
  headingDeg: 104,
  x: -26_000,
  z: -6_000,
}

/**
 * Start on a runway, at the threshold, pointed down it.
 *
 * The threshold rather than the midpoint: `Airfield.x/z` is the runway's centre, so
 * backing up half its length is what puts the whole runway ahead of the aircraft
 * instead of half of it. An F-16 does not need 1,300 m to get airborne, but starting
 * halfway down a runway is the sort of thing that is only ever noticed by someone
 * who has to abort.
 *
 * `alt` is a placeholder. `Simulation.parkAt` ignores it and asks the terrain where
 * the wheels go, because the field elevation is the map's business and not this
 * file's.
 */
export function runwayStart(field: Airfield): SpawnCondition {
  const heading = (field.headingDeg * Math.PI) / 180

  // Back up half the runway from the centre, along the reciprocal of the heading.
  // Renderer axes: +X is east and -Z is north, so a heading of 0 is -Z.
  const back = field.lengthM / 2 - 120

  return {
    onGround: true,
    alt: field.elevation / 0.3048,
    vt: 0,
    headingDeg: field.headingDeg,
    x: field.x - Math.sin(heading) * back,
    z: field.z + Math.cos(heading) * back,
  }
}
