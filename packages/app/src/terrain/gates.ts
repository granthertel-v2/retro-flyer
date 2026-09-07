/**
 * The course gates, drawn.
 *
 * Separate from `course.ts` on purpose: that file decides whether a gate was passed
 * and must run in Node, this one imports three.js and cannot. The split is the same
 * one everywhere else in this package — the rule is testable, the picture is not.
 *
 * A gate is drawn as a pair of pylons with a bar across the top, sized to its
 * altitude window. That shape says more than a floating ring does: the bar is the
 * ceiling you have to stay under and the ground between the pylons is the floor, so
 * the window is legible from a distance rather than being a number in the corner.
 */

import {
  BoxGeometry,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  type ColorRepresentation,
} from 'three'
import { COURSE_WAYPOINTS, type Waypoint } from '../course.js'
import { ftToM } from '@retro-flyer/physics'

const PYLON = 26
const LIVE: ColorRepresentation = 0xd85a30
const BAR: ColorRepresentation = 0xf0c040

export function buildGates(waypoints: readonly Waypoint[] = COURSE_WAYPOINTS): Object3D {
  const group = new Object3D()

  const pylonMaterial = new MeshLambertMaterial({ color: LIVE, flatShading: true })
  const barMaterial = new MeshLambertMaterial({ color: BAR, flatShading: true })

  for (const w of waypoints) {
    const floor = ftToM(w.minAltFt)
    const ceiling = ftToM(w.maxAltFt)
    const height = ceiling - floor
    const halfWidth = w.radiusM

    for (const side of [-1, 1]) {
      const pylon = new Mesh(new BoxGeometry(PYLON, height, PYLON), pylonMaterial)
      pylon.position.set(w.x + side * halfWidth, floor + height / 2, w.z)
      group.add(pylon)
    }

    // The bar sits at the ceiling: fly under it.
    const bar = new Mesh(new BoxGeometry(halfWidth * 2, PYLON, PYLON), barMaterial)
    bar.position.set(w.x, ceiling, w.z)
    group.add(bar)
  }

  return group
}
