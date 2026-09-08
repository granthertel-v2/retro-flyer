/**
 * The waypoint course (REQUIREMENTS §9 Day 3).
 *
 * The acceptance criterion for the whole milestone is "complete a runway-to-runway
 * flight through the course", so these tests are, in a real sense, the specification
 * of what finishing Day 3 means.
 */

import { describe, expect, it } from 'vitest'
import { COURSE_WAYPOINTS, Course, buildCourse } from '../src/course.js'
import type { Airfield } from '../src/terrain/source.js'
import { authoredMap } from '../src/terrain/authored.js'

const DT = 1 / 60

const course = (): Course => buildCourse(authoredMap.airfields)

const at = (
  x: number,
  z: number,
  altFt: number,
  onGround = false,
  speedFps = 800,
): Parameters<Course['update']>[0] => ({ x, z, altFt, onGround, speedFps })

/** Fly the whole course cleanly, returning the finished progress. */
function flyIt(c: Course) {
  // Sit on the runway for a second — the clock must not have started.
  for (let i = 0; i < 60; i++) c.update(at(c.start.x, c.start.z, 607, true, 0), DT)
  const beforeTakeoff = c.update(at(c.start.x, c.start.z, 607, true, 0), DT)

  // Lift off.
  c.update(at(c.start.x, c.start.z, 650), DT)

  // Take each gate in the middle of its band.
  for (const w of COURSE_WAYPOINTS) {
    const mid = (w.minAltFt + w.maxAltFt) / 2
    for (let i = 0; i < 30; i++) c.update(at(w.x - 8_000, w.z, mid), DT)
    c.update(at(w.x, w.z, mid), DT)
  }

  // Arrive, touch down, roll out, stop.
  const d = c.destination
  c.update(at(d.x, d.z, 1_400), DT)
  c.update(at(d.x, d.z, 1_302, true, 200), DT)
  for (let i = 0; i < 60; i++) c.update(at(d.x, d.z, 1_302, true, 100), DT)

  return { beforeTakeoff, final: c.update(at(d.x, d.z, 1_302, true, 0), DT) }
}

describe('the course', () => {
  it('is built from the map, so it moves if the airfields do', () => {
    const c = course()
    expect(c.start.name).toBe('Bayside')
    expect(c.destination.name).toBe('Ridgeview')
    expect(c.waypoints).toHaveLength(3)
  })

  it('does not start the clock until the wheels leave the ground', () => {
    const c = course()
    for (let i = 0; i < 600; i++) c.update(at(c.start.x, c.start.z, 607, true, 0), DT)

    expect(c.status).toBe('ready')
    expect(c.elapsed).toBe(0)
  })

  it('runs a clean runway-to-runway flight to completion', () => {
    const c = course()
    const { beforeTakeoff, final } = flyIt(c)

    expect(beforeTakeoff.status).toBe('ready')
    expect(final.status).toBe('complete')
    expect(final.index).toBe(COURSE_WAYPOINTS.length)
    expect(final.splits).toHaveLength(COURSE_WAYPOINTS.length)
    expect(final.landedAt).not.toBeNull()
    expect(final.elapsed).toBeGreaterThan(0)
  })

  it('records splits in order and increasing', () => {
    const c = course()
    const { final } = flyIt(c)

    for (let i = 1; i < final.splits.length; i++) {
      expect(final.splits[i] as number).toBeGreaterThan(final.splits[i - 1] as number)
    }
    expect(final.landedAt as number).toBeGreaterThanOrEqual(
      final.splits.at(-1) as number,
    )
  })

  it('does not credit a gate flown over above its band', () => {
    // The point of the altitude window. Otherwise the course is flown at 30,000 ft.
    const c = course()
    c.update(at(c.start.x, c.start.z, 607, true, 0), DT)
    c.update(at(c.start.x, c.start.z, 650), DT)

    const gate = COURSE_WAYPOINTS[0] as (typeof COURSE_WAYPOINTS)[number]
    const p = c.update(at(gate.x, gate.z, gate.maxAltFt + 1_000), DT)

    expect(p.index).toBe(0)
    expect(p.altitudeOk).toBe(false)
  })

  it('does not credit a gate flown past outside its radius', () => {
    const c = course()
    c.update(at(c.start.x, c.start.z, 607, true, 0), DT)
    c.update(at(c.start.x, c.start.z, 650), DT)

    const gate = COURSE_WAYPOINTS[0] as (typeof COURSE_WAYPOINTS)[number]
    const mid = (gate.minAltFt + gate.maxAltFt) / 2
    const p = c.update(at(gate.x + gate.radiusM * 2, gate.z, mid), DT)

    expect(p.index).toBe(0)
  })

  it('requires the gates in order', () => {
    const c = course()
    c.update(at(c.start.x, c.start.z, 607, true, 0), DT)
    c.update(at(c.start.x, c.start.z, 650), DT)

    // Fly the last gate first. It should not count for anything.
    const last = COURSE_WAYPOINTS[2] as (typeof COURSE_WAYPOINTS)[number]
    const p = c.update(at(last.x, last.z, (last.minAltFt + last.maxAltFt) / 2), DT)

    expect(p.index).toBe(0)
  })

  it('does not complete by stopping beside the runway', () => {
    // The looseness this replaced: a radius of `lengthM/2 + 300` describes a circle
    // 1.6 km wide at Ridgeview, and the first end-to-end acceptance flight finished
    // 775 m off the side in a field, pointing 64 degrees away from the runway, and
    // was credited with a runway-to-runway flight.
    const c = course()
    c.update(at(c.start.x, c.start.z, 607, true, 0), DT)
    c.update(at(c.start.x, c.start.z, 650), DT)
    for (const w of COURSE_WAYPOINTS) {
      c.update(at(w.x, w.z, (w.minAltFt + w.maxAltFt) / 2), DT)
    }

    const d = c.destination
    const heading = (d.headingDeg * Math.PI) / 180
    // 775 m off the centreline — inside the old radius, outside the runway.
    const offX = d.x + Math.cos(heading) * 775
    const offZ = d.z + Math.sin(heading) * 775

    const p = c.update(at(offX, offZ, d.elevation / 0.3048, true, 0), DT)
    expect(p.status, 'a field beside the runway is not the runway').toBe('running')

    // And on the centreline, it does complete.
    const ok = c.update(at(d.x, d.z, d.elevation / 0.3048, true, 0), DT)
    expect(ok.status).toBe('complete')
  })

  it('allows a scruffy overrun but not an arrival in the next county', () => {
    const build = () => {
      const c = course()
      c.update(at(c.start.x, c.start.z, 607, true, 0), DT)
      c.update(at(c.start.x, c.start.z, 650), DT)
      for (const w of COURSE_WAYPOINTS) c.update(at(w.x, w.z, (w.minAltFt + w.maxAltFt) / 2), DT)
      return c
    }
    const d = course().destination
    const heading = (d.headingDeg * Math.PI) / 180
    const alongAt = (m: number): [number, number] => [
      d.x + Math.sin(heading) * m,
      d.z - Math.cos(heading) * m,
    ]

    const justPast = alongAt(d.lengthM / 2 + 100)
    const wayPast = alongAt(d.lengthM / 2 + 900)

    expect(build().update(at(justPast[0], justPast[1], d.elevation / 0.3048, true, 0), DT).status)
      .toBe('complete')
    expect(build().update(at(wayPast[0], wayPast[1], d.elevation / 0.3048, true, 0), DT).status)
      .toBe('running')
  })

  it('does not complete by landing at the wrong field', () => {
    const c = course()
    c.update(at(c.start.x, c.start.z, 607, true, 0), DT)
    c.update(at(c.start.x, c.start.z, 650), DT)
    for (const w of COURSE_WAYPOINTS) {
      c.update(at(w.x, w.z, (w.minAltFt + w.maxAltFt) / 2), DT)
    }

    const wrong = authoredMap.airfields.find((a) => a.name === 'Southpoint')!
    const p = c.update(at(wrong.x, wrong.z, wrong.elevation / 0.3048, true, 0), DT)

    expect(p.status).toBe('running')
  })

  it('does not complete until the aircraft has actually stopped', () => {
    const c = course()
    c.update(at(c.start.x, c.start.z, 607, true, 0), DT)
    c.update(at(c.start.x, c.start.z, 650), DT)
    for (const w of COURSE_WAYPOINTS) {
      c.update(at(w.x, w.z, (w.minAltFt + w.maxAltFt) / 2), DT)
    }

    const d = c.destination
    const rolling = c.update(at(d.x, d.z, 1_302, true, 120), DT)
    expect(rolling.status).toBe('running')
    expect(rolling.landedAt).not.toBeNull()

    const stopped = c.update(at(d.x, d.z, 1_302, true, 1), DT)
    expect(stopped.status).toBe('complete')
  })

  it('resets to a state that can be flown again', () => {
    const c = course()
    flyIt(c)
    c.reset()

    expect(c.status).toBe('ready')
    expect(c.elapsed).toBe(0)
    expect(c.splits).toHaveLength(0)
    expect(c.landedAt).toBeNull()

    const { final } = flyIt(c)
    expect(final.status).toBe('complete')
  })
})

describe('the gates sit where the map says they should', () => {
  it('puts every gate band above the ground under it', () => {
    for (const w of COURSE_WAYPOINTS) {
      const groundFt = authoredMap.height(w.x, w.z) / 0.3048
      expect(w.minAltFt, `${w.name} band starts underground`).toBeGreaterThan(groundFt)
      expect(w.maxAltFt).toBeGreaterThan(w.minAltFt)
    }
  })

  it('makes the pass a gap to fly through, not a mountain to fly over', () => {
    // The whole reason the course goes that way. If the ridge beside the pass ever
    // stops being much higher than the gate's ceiling, the gate stops meaning
    // anything and this says so.
    const pass = COURSE_WAYPOINTS.find((w) => w.name === 'PASS')!
    const gapFt = authoredMap.height(pass.x, pass.z) / 0.3048
    const ridgeFt = authoredMap.height(24_000, -21_000) / 0.3048

    expect(gapFt).toBeLessThan(pass.maxAltFt)
    expect(ridgeFt, 'the ridge is no longer a wall').toBeGreaterThan(pass.maxAltFt + 1_500)
  })
})

/**
 * A course for a map that has never heard of Bayside.
 *
 * The designed course names two of the authored map's airfields and puts three gates
 * at world coordinates that mean something only in that terrain — the pass exists
 * because the course needed a place the ridge had to be flown through. Handed a real
 * region's airfields, `buildCourse` threw, and because it is called during bootstrap
 * it took the whole page down: New York loaded, built its terrain, and then showed a
 * black screen.
 */
describe('a course on a map without the authored airfields', () => {
  const field = (name: string, x: number, z: number, lengthM: number): Airfield => ({
    name, x, z, lengthM, elevation: 10, headingDeg: 90, widthM: 45,
  })

  it('runs from the longest runway to the field furthest from it', () => {
    const course = buildCourse([
      field('Short strip', 0, 0, 1_000),
      field('Long, and near', 500, 0, 4_000),
      field('Far away', 40_000, 0, 2_000),
    ])

    expect(course.start.name).toBe('Long, and near')
    expect(course.destination.name).toBe('Far away')
  })

  it('has no gates, because inventing them would be inventing terrain', () => {
    const course = buildCourse([field('A', 0, 0, 3_000), field('B', 20_000, 0, 2_000)])
    expect(course.waypoints).toHaveLength(0)

    // An empty gate list must still complete: `Course` should fall straight through
    // to the landing condition rather than waiting for a gate that never comes.
    const sample = { x: 20_000, z: 0, altFt: 10, onGround: true, speedFps: 0 }
    course.update({ ...sample, onGround: false }, 0.1)
    const progress = course.update(sample, 0.1)
    expect(progress.status).toBe('complete')
  })

  it('still gives the authored map its designed course', () => {
    const authored = buildCourse(authoredMap.airfields)
    expect(authored.waypoints).toEqual(COURSE_WAYPOINTS)
    expect(authored.start.name).toBe('Bayside')
  })
})
