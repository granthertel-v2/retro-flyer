/**
 * The timed waypoint course (REQUIREMENTS §1, §9 Day 3).
 *
 * Day 3's acceptance is "complete a runway-to-runway flight through the course", so
 * the course is not decoration on top of the milestone — it *is* the milestone,
 * written down in a form that can say whether it happened. It therefore starts on
 * the ground at one field and ends stopped on another, with the flying in between.
 *
 * No three.js import, so this tests in Node — the same discipline as `spawn.ts`.
 * Rendering the gates is a separate concern and does not belong in the thing that
 * decides whether one was passed.
 *
 * ## Why altitude windows and not just rings
 *
 * A ring you can pass at any height is a ring you fly over at 20,000 ft. The window
 * is what makes the pass gate mean "through the gap" rather than "somewhere above
 * the mountain", and it is the only thing making the course a flying task rather
 * than a navigation one.
 */

import type { Airfield } from './terrain/source.js'

export interface Waypoint {
  name: string
  /** World metres, X east and Z south — the renderer's frame, as the map uses. */
  x: number
  z: number
  /** Altitude band that counts, ft MSL. */
  minAltFt: number
  maxAltFt: number
  /** Horizontal capture radius, metres. */
  radiusM: number
  /** One line for the overlay, explaining what the gate is for. */
  hint: string
}

export type CourseStatus = 'ready' | 'running' | 'complete'

export interface CourseProgress {
  status: CourseStatus
  /** Index of the waypoint being flown to. Equals `waypoints.length` when all done. */
  index: number
  /** Seconds since liftoff. */
  elapsed: number
  /** Time at which each waypoint was taken, seconds since liftoff. */
  splits: number[]
  /** Horizontal distance to the next gate, metres. Zero when there is none. */
  distanceM: number
  /** Whether the aircraft is inside the next gate's altitude band right now. */
  altitudeOk: boolean
  /** Time of touchdown at the destination, or null. */
  landedAt: number | null
}

export interface CourseSample {
  /** World metres. */
  x: number
  z: number
  altFt: number
  onGround: boolean
  /** Airspeed, ft/s — used to decide whether the aircraft has actually stopped. */
  speedFps: number
}

/** Below this the aircraft counts as stopped, ft/s. About 3 kt. `[A]` */
const STOPPED_FPS = 5

/**
 * How far past either end of the runway still counts as finishing on it, metres. `[A]`
 *
 * A modest overrun. Stopping just past the far end is a scruffy landing, not a
 * different outcome; stopping half a mile beyond it is.
 */
const OVERRUN_MARGIN_M = 150

/**
 * How far either side of the runway edge still counts, metres. `[A]`
 *
 * Enough that a wheel on the shoulder does not fail the run, and not enough that
 * landing in the field beside the runway passes as landing on it.
 */
const LATERAL_MARGIN_M = 25

/**
 * Is the aircraft stopped on the destination runway?
 *
 * Measured in the runway's own frame — along it and across it — rather than as a
 * distance from its midpoint. A radius is the obvious test and it is wrong: at
 * Ridgeview `lengthM / 2 + 300` describes a circle 1.6 km wide, and the first
 * end-to-end acceptance flight finished 775 m off the side of the runway, in a
 * field, pointing 64 degrees away from it — and was credited with completing a
 * "runway-to-runway" flight.
 *
 * §9 asks for runway to runway. This is what that means.
 */
function stoppedOnRunway(field: Airfield, x: number, z: number): boolean {
  const heading = (field.headingDeg * Math.PI) / 180
  const along = Math.sin(heading)
  const across = -Math.cos(heading)

  const dx = x - field.x
  const dz = z - field.z

  const downRunway = dx * along + dz * across
  const offCentreline = dx * -across + dz * along

  return (
    Math.abs(downRunway) <= field.lengthM / 2 + OVERRUN_MARGIN_M &&
    Math.abs(offCentreline) <= field.widthM / 2 + LATERAL_MARGIN_M
  )
}

export class Course {
  status: CourseStatus = 'ready'
  index = 0
  elapsed = 0
  splits: number[] = []
  landedAt: number | null = null

  private wasOnGround = true

  constructor(
    readonly waypoints: readonly Waypoint[],
    readonly start: Airfield,
    readonly destination: Airfield,
  ) {}

  reset(): void {
    this.status = 'ready'
    this.index = 0
    this.elapsed = 0
    this.splits = []
    this.landedAt = null
    this.wasOnGround = true
  }

  update(s: CourseSample, dt: number): CourseProgress {
    // The clock starts at liftoff, not at spawn. Sitting on the runway deciding
    // whether to go should not cost anything.
    if (this.status === 'ready' && this.wasOnGround && !s.onGround) {
      this.status = 'running'
    }
    this.wasOnGround = s.onGround

    if (this.status === 'running') {
      this.elapsed += dt

      const next = this.waypoints[this.index]
      if (next) {
        const within = Math.hypot(s.x - next.x, s.z - next.z) <= next.radiusM
        const band = s.altFt >= next.minAltFt && s.altFt <= next.maxAltFt

        if (within && band) {
          this.splits.push(this.elapsed)
          this.index++
        }
      } else if (s.onGround) {
        // All gates taken. Now it has to be stopped, on the destination field.
        if (this.landedAt === null) this.landedAt = this.elapsed

        if (stoppedOnRunway(this.destination, s.x, s.z) && s.speedFps < STOPPED_FPS) {
          this.status = 'complete'
        }
      }
    }

    const next = this.waypoints[this.index]

    return {
      status: this.status,
      index: this.index,
      elapsed: this.elapsed,
      splits: [...this.splits],
      distanceM: next ? Math.hypot(s.x - next.x, s.z - next.z) : 0,
      altitudeOk: next ? s.altFt >= next.minAltFt && s.altFt <= next.maxAltFt : true,
      landedAt: this.landedAt,
    }
  }
}

/**
 * The MVP course: Bayside to Ridgeview, the long way round.
 *
 * Altitude bands are set from the map's own elevations rather than picked — probed
 * at each point, then a band chosen around it:
 *
 * | gate       | ground | band            |
 * |------------|--------|-----------------|
 * | City       | 151 ft | 300 - 2,500 ft  |
 * | River Bend | 219 ft | 300 - 2,000 ft  |
 * | The Pass   | 2,267  | 2,600 - 5,000   |
 *
 * The Pass is the gate the course exists for. The ridge crest four miles north of it
 * is 7,208 ft; the gap is 2,267. A 5,000 ft ceiling is above the gap and well below
 * the ridge, so the only way through is through — which is what §7 meant by "a ridge
 * line worth flying through".
 */
export const COURSE_WAYPOINTS: readonly Waypoint[] = [
  {
    name: 'CITY',
    x: -16_000,
    z: -10_000,
    minAltFt: 300,
    maxAltFt: 2_500,
    radiusM: 900,
    hint: 'low over the grid',
  },
  {
    name: 'RIVER',
    x: 2_000,
    z: 3_000,
    minAltFt: 300,
    maxAltFt: 2_000,
    radiusM: 900,
    hint: 'follow the valley',
  },
  {
    name: 'PASS',
    x: 20_600,
    z: -8_700,
    minAltFt: 2_600,
    maxAltFt: 5_000,
    radiusM: 1_200,
    hint: 'through the gap, not over the ridge',
  },
]

/** Build the course from the map's own airfields, so it moves if they do. */
export function buildCourse(airfields: readonly Airfield[]): Course {
  const find = (name: string): Airfield => {
    const f = airfields.find((a) => a.name === name)
    if (!f) throw new Error(`course needs an airfield named ${name}`)
    return f
  }

  return new Course(COURSE_WAYPOINTS, find('Bayside'), find('Ridgeview'))
}
