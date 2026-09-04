/**
 * Cameras (§6): chase, cockpit, external orbit.
 *
 * The chase camera is not a fixed offset behind the aircraft, and the difference is
 * most of what §6 means by speed sensation. A rigidly attached camera gives a world
 * that rotates around a stationary aeroplane, which reads as slow no matter how fast
 * the numbers say you are going. A camera that lags, overshoots and settles gives an
 * aeroplane that is *going somewhere*, and the eye reads the lag as speed.
 *
 * So it is a spring-damper chasing a point behind the aircraft, and the trail
 * lengthens under load so a hard pull throws the camera wide before it catches up.
 *
 * The damping term works on velocity **relative to the aircraft**, not absolute
 * velocity, and that detail is the whole thing. Damping absolute velocity gives a
 * camera whose steady-state lag is `damping * speed / stiffness` — it trails further
 * the faster you go, which sounds like exactly what a speed cue should do and is in
 * fact a disaster: at Mach 0.88 the camera sat 168 m back and the aeroplane was two
 * per cent of the screen. Damping relative velocity gives zero lag in steady flight
 * and lag only when the aircraft *changes* what it is doing, which is when lag
 * actually reads as speed rather than as distance.
 */

import { Camera, Quaternion, Vector3 } from 'three'
import type { RenderState } from '../seam.js'

export type CameraMode = 'chase' | 'cockpit' | 'orbit'

export const CAMERA_MODES: readonly CameraMode[] = ['chase', 'cockpit', 'orbit']

/** Chase offset in the aircraft's own frame, metres: behind, above. */
const CHASE_BACK = 34
const CHASE_UP = 7.6

/**
 * Extra trail per g above one, metres. The "throws it wide" term.
 *
 * Deliberately small. At 3.4 a hard pull pushed the aircraft most of the way out of
 * frame, which does not read as weight — it reads as losing your aeroplane.
 */
const CHASE_G_STRETCH = 1.1

/**
 * Spring stiffness and damping. Slightly under critical (`2*sqrt(SPRING)` would be
 * 11.7), so a hard manoeuvre overshoots a little before settling — the overshoot is
 * the part that reads as weight.
 */
const SPRING = 34
const DAMPING = 9.4

/**
 * How much of the aircraft's bank the camera copies, 0 to 1.
 *
 * Not the full amount: a chase camera that rolls all the way with the aircraft is a
 * cockpit camera with extra steps, and a horizon spinning through 360 degrees is
 * where motion sickness comes from.
 */
const CHASE_BANK_FOLLOW = 0.45

/** Where the pilot's eye sits, metres forward of the reference point. */
const EYE_FORWARD = 6.2
const EYE_UP = 0.9

export class ChaseCamera {
  private readonly position = new Vector3()
  private readonly velocity = new Vector3()
  private readonly desired = new Vector3()
  private readonly up = new Vector3()
  private readonly right = new Vector3()
  private readonly aim = new Vector3()
  private readonly quaternion = new Quaternion()
  private started = false

  /** Orbit angle, radians. Advanced only in orbit mode. */
  private orbit = 0

  update(camera: Camera, state: RenderState, mode: CameraMode, nz: number, dt: number): void {
    this.quaternion.set(
      state.quaternion[0],
      state.quaternion[1],
      state.quaternion[2],
      state.quaternion[3],
    )

    const origin = new Vector3(state.position[0], state.position[1], state.position[2])

    if (mode === 'cockpit') {
      // Rigid. In the cockpit the lag would be a moving head, not a moving camera.
      const eye = new Vector3(0, EYE_UP, -EYE_FORWARD).applyQuaternion(this.quaternion)
      camera.position.copy(origin).add(eye)
      camera.quaternion.copy(this.quaternion)
      this.started = false
      return
    }

    if (mode === 'orbit') {
      this.orbit += dt * 0.35
      const radius = 62
      camera.position.set(
        origin.x + Math.cos(this.orbit) * radius,
        origin.y + 16,
        origin.z + Math.sin(this.orbit) * radius,
      )
      camera.lookAt(origin)
      this.started = false
      return
    }

    // Chase.
    const trail = CHASE_BACK + Math.max(0, nz - 1) * CHASE_G_STRETCH
    this.desired
      .set(0, CHASE_UP, trail)
      .applyQuaternion(this.quaternion)
      .add(origin)

    if (!this.started) {
      this.position.copy(this.desired)
      this.velocity.set(state.velocity[0], state.velocity[1], state.velocity[2])
      this.started = true
    }

    // Spring-damper toward the desired point. Integrated semi-implicitly, which is
    // stable at large dt where explicit Euler would oscillate — and dt spikes every
    // time the tab is backgrounded.
    // Sub-step rather than clamp. The spring is stable up to about 0.05 s at this
    // stiffness, but simply clamping the step means that on a long frame the camera
    // integrates 50 ms while the aircraft integrates the whole 250 — and the camera
    // is left 60 m behind for every hitch. Which is a slow leak that only shows up
    // when the frame rate is already bad, i.e. exactly when it is most annoying.
    const substeps = Math.max(1, Math.ceil(dt / 0.05))
    const step = dt / substeps

    for (let n = 0; n < substeps; n++) {
      // Damp the velocity difference, not the velocity. See the note at the top.
      const rvx = this.velocity.x - state.velocity[0]
      const rvy = this.velocity.y - state.velocity[1]
      const rvz = this.velocity.z - state.velocity[2]

      const ax = (this.desired.x - this.position.x) * SPRING - rvx * DAMPING
      const ay = (this.desired.y - this.position.y) * SPRING - rvy * DAMPING
      const az = (this.desired.z - this.position.z) * SPRING - rvz * DAMPING

      this.velocity.x += ax * step
      this.velocity.y += ay * step
      this.velocity.z += az * step

      this.position.x += this.velocity.x * step
      this.position.y += this.velocity.y * step
      this.position.z += this.velocity.z * step
    }

    camera.position.copy(this.position)

    // Aim ahead of and slightly above the aircraft, so it sits low in frame with
    // the horizon near the middle and most of the picture is where you are going.
    this.aim.set(0, 4.2, -58).applyQuaternion(this.quaternion).add(origin)

    // Level the camera first, then roll it about its own view axis by a fraction of
    // the aircraft's bank.
    //
    // The obvious approach — lerp the camera's `up` toward the aircraft's and hand
    // that to `lookAt` — has a singularity in it. As the aircraft passes through
    // inverted, the blended `up` sweeps through being parallel to the view
    // direction; `lookAt` cannot build a basis from two parallel vectors, and the
    // camera snaps a half turn. Rolling about the view axis has no such case: it is
    // one angle, continuous through inverted and out the other side.
    camera.up.set(0, 1, 0)
    camera.lookAt(this.aim)

    this.up.set(0, 1, 0).applyQuaternion(this.quaternion)
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion)

    // Bank from the aircraft's own axes rather than from an Euler angle, because
    // Euler roll is undefined at vertical and this is not.
    const bank = Math.atan2(-this.right.y, this.up.y)
    camera.rotateZ(-bank * CHASE_BANK_FOLLOW)
  }

  reset(): void {
    this.started = false
  }
}
