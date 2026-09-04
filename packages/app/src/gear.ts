/**
 * Landing gear, drawn.
 *
 * REQUIREMENTS §8.3 lists gear position among the things the renderer consumes, and
 * until Day 3 there was nothing to consume — so the aircraft sat on a runway resting
 * on its belly, which is the sort of thing a green test suite will never mention.
 *
 * ## Positions come from the physics, not from the artist
 *
 * The struts are placed by converting `NOSE_GEAR`, `LEFT_MAIN` and `RIGHT_MAIN`
 * straight out of the flight model. Eyeballing them into place would mean two sets
 * of gear geometry that agree today and drift the first time either is touched — and
 * the failure would be an aircraft whose drawn wheels are not where the wheels it
 * lands on are.
 *
 * The conversion is `MODEL_TO_BODY` run backwards, plus feet to metres. Body axes are
 * x forward, y right, z down; the model is authored to three.js convention with the
 * nose down -Z and up +Y, so `model = (y_body, -z_body, -x_body)`.
 *
 * ## What is not modelled
 *
 * Retraction is a visibility toggle, not an animation. The doors, the sequence and
 * the transit time are all §1 "out for MVP" territory, and a half-retracted strut
 * that snaps rather than swings would look worse than one that simply goes away.
 */

import { CylinderGeometry, Group, Mesh, MeshLambertMaterial, Object3D } from 'three'
import { LEFT_MAIN, NOSE_GEAR, RIGHT_MAIN, ftToM, type Strut } from '@retro-flyer/physics'

const STRUT_COLOR = 0x8d949c
const TYRE_COLOR = 0x22262b

/** Wheel radius, metres. `[A]` Sized by eye against the fuselage, not sourced. */
const WHEEL_RADIUS = 0.32
const NOSE_WHEEL_RADIUS = 0.26
const LEG_RADIUS = 0.055

interface Leg {
  pivot: Object3D
  /** Distance from the CG to the contact point at full extension, metres. */
  reach: number
}

export class GearModel {
  readonly object = new Group()
  private readonly legs: Leg[] = []

  constructor(struts: readonly Strut[] = [NOSE_GEAR, LEFT_MAIN, RIGHT_MAIN]) {
    const strutMaterial = new MeshLambertMaterial({ color: STRUT_COLOR, flatShading: true })
    const tyreMaterial = new MeshLambertMaterial({ color: TYRE_COLOR, flatShading: true })

    for (const s of struts) {
      const radius = s.x > 0 ? NOSE_WHEEL_RADIUS : WHEEL_RADIUS
      const reach = ftToM(s.z)

      // The pivot sits at the strut's attachment in the model frame; everything
      // below hangs from it so compression only has to move one object.
      const pivot = new Object3D()
      pivot.position.set(ftToM(s.y), 0, -ftToM(s.x))

      // Leg: from the fuselage down to the wheel centre.
      const legLength = Math.max(0.1, reach - radius)
      const leg = new Mesh(
        new CylinderGeometry(LEG_RADIUS, LEG_RADIUS, legLength, 6),
        strutMaterial,
      )
      leg.position.y = -legLength / 2
      pivot.add(leg)

      // Wheel: axis across the aircraft, so it is rotated onto X.
      const wheel = new Mesh(
        new CylinderGeometry(radius, radius, radius * 0.75, 10),
        tyreMaterial,
      )
      wheel.rotation.z = Math.PI / 2
      wheel.position.y = -legLength
      pivot.add(wheel)

      this.object.add(pivot)
      this.legs.push({ pivot, reach })
    }
  }

  /**
   * Show the gear where the physics says it is.
   *
   * Compression raises the contact point toward the aircraft, so each leg simply
   * moves up by the amount its strut is squashed. That is a simplification — a real
   * oleo shortens rather than translating, and a trailing-link would swing — but at
   * this scale the visible result is the same and it costs one number.
   */
  update(down: boolean, compression: readonly number[] = []): void {
    this.object.visible = down
    if (!down) return

    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i] as Leg
      leg.pivot.position.y = ftToM(compression[i] ?? 0)
    }
  }
}
