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

/** How far back down the extended centreline an airborne start begins, metres. */
export const APPROACH_DISTANCE_M = 10_000

/** Least height above the ground underneath, feet. */
export const MIN_CLEARANCE_FT = 1_500

/**
 * What an airborne start needs to know about the world around it.
 *
 * A structural type rather than `TerrainSource` so a test can hand over four lines of
 * object instead of a region.
 */
export interface StartContext {
  height(x: number, z: number): number
  /** Named places, most prominent first — the same order `TerrainSource` promises. */
  readonly places?: readonly { x: number; z: number }[]
}

/** Retained name for the height-only half of the context. */
export type HeightField = StartContext

/** A point `distance` back down the approach for a given runway direction. */
function approachPoint(
  field: Airfield,
  headingDeg: number,
  distance: number,
): { x: number; z: number } {
  const heading = (headingDeg * Math.PI) / 180
  return {
    x: field.x - Math.sin(heading) * distance,
    z: field.z + Math.cos(heading) * distance,
  }
}

/**
 * Which end of the runway to arrive on.
 *
 * A runway has two directions and the data names only one of them. For a takeoff that
 * is the whole story — you depart on the heading the FAA published. For an arrival it
 * is a coin toss that decides what the pilot is looking at, and in New York the two
 * answers are not equally good: Kennedy's published 120.7 degrees puts the start
 * northwest of the field, which is to say over Brooklyn with Manhattan *behind* the
 * aircraft and Long Island ahead. The first thing a stranger sees of New York should
 * not be the part of it that looks like a field.
 *
 * The rule is one comparison and it is made from the region's own data: start from the
 * end that is *further* from the most prominent named place, so that flying toward the
 * field is also flying toward the city. `places` is ordered most prominent first —
 * "New York" at 19.7 km from Kennedy, "Chicago" from O'Hare — so the anchor costs
 * nothing to find and nothing is hand-placed.
 *
 * With no places to go on it returns the published heading, which is what the authored
 * map and any region without them get.
 */
function approachHeadingDeg(field: Airfield, anchor?: { x: number; z: number }): number {
  if (!anchor) return field.headingDeg

  const reciprocal = (field.headingDeg + 180) % 360
  const published = approachPoint(field, field.headingDeg, APPROACH_DISTANCE_M)
  const other = approachPoint(field, reciprocal, APPROACH_DISTANCE_M)

  const fromPublished = Math.hypot(anchor.x - published.x, anchor.z - published.z)
  const fromOther = Math.hypot(anchor.x - other.x, anchor.z - other.z)

  return fromOther > fromPublished ? reciprocal : field.headingDeg
}

/**
 * Start already flying, lined up on a runway from ten kilometres out.
 *
 * The counterpart to `runwayStart`, and the one a newcomer should get. The aircraft
 * is longitudinally unstable — the short-period mode has split into two real roots,
 * one of them divergent with a time to double of about 2.7 seconds — and the
 * practical consequence is that a takeoff is the hardest thing in the simulator, not
 * the easiest. A first flight that ends in a departure at the far end of a runway
 * teaches nothing. This begins in the part worth feeling.
 *
 * Why the extended centreline rather than anywhere: it costs nothing and buys two
 * things. The field is ahead, so there is somewhere obvious to go and something to
 * look at, which is the same reason the authored map's spawn points at the ridge. And
 * the geometry lands close to a real approach — 2,200 ft over ten kilometres is about
 * 3.8 degrees, against a 3-degree glideslope — so anyone who wants to try a landing
 * is already most of the way set up for one.
 *
 * The altitude is *above the field*, not above sea level. `SPAWN.alt` is 2,200 ft over
 * a map whose airfields are at sea level, and the number is a speed-sensation decision
 * (see above) that only means what it means as a height above the ground. Copied as an
 * MSL figure into a region it would be something else entirely — and for a field high
 * enough, underground.
 *
 * Terrain is then sampled and the start raised if it has to be, because `trimAt` takes
 * `alt` as absolute MSL and never asks the ground where it is — unlike `parkAt`, which
 * does. Ten kilometres off the end of a runway is exactly where a hill is likely to be.
 */
export function airborneStart(field: Airfield, context?: StartContext): SpawnCondition {
  const headingDeg = approachHeadingDeg(field, context?.places?.[0])
  const { x, z } = approachPoint(field, headingDeg, APPROACH_DISTANCE_M)

  const fieldFt = field.elevation / 0.3048
  const groundFt = context ? context.height(x, z) / 0.3048 : fieldFt

  return {
    alt: Math.max(fieldFt + SPAWN.alt, groundFt + MIN_CLEARANCE_FT),
    vt: SPAWN.vt,
    headingDeg,
    x,
    z,
  }
}
