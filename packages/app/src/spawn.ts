/**
 * Where a Day 2 flight begins.
 *
 * Its own module because it is three.js-free and therefore testable, and because the
 * altitude in it is the single largest speed-sensation decision in the renderer —
 * see below. `main.ts` cannot be imported from a test; this can.
 */

import type { SpawnCondition } from './loop.js'

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
