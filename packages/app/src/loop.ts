/**
 * The simulation loop.
 *
 * Physics runs at a fixed 120 Hz; rendering runs whenever the browser feels like it.
 * `FixedStepClock` from the physics package converts one into the other, running
 * whole ticks and keeping the remainder, and the renderer draws between the last two
 * states using the leftover fraction (§8.3).
 *
 * That interpolation is not optional polish, and it has to blend the last two
 * **ticks**. Blending from the state at the start of the frame instead spans two
 * ticks of motion with a fraction that describes one, and the aircraft shivers
 * against the ground — which is exactly how this was found.
 *
 * The clock calls back for controls **once per tick**, not once per frame, which is
 * exactly the hook the assist layer wants: a control law running at the frame rate
 * is a control law whose gains change when the graphics get busy.
 */

import {
  FixedStepClock,
  PHYSICS_DT,
  Q,
  computeMassProperties,
  fromQuatVector,
  fromStateVector,
  quatDerivative,
  toQuatVector,
  trim,
  type Controls,
  type MassProperties,
} from '@retro-flyer/physics'
import { AssistLayer, BALANCED, type AssistPreset, type RawInput } from '@retro-flyer/control'
import { lerpRenderState, toRenderState, type RenderState } from './seam.js'

export interface SpawnCondition {
  alt: number
  vt: number
  /** Heading, degrees true. */
  headingDeg: number
  /** Start position, world metres (X East, Z South). */
  x: number
  z: number
}

/** Smoothing time constant for the along-path acceleration cue, seconds. */
const AX_TAU = 0.25

export class Simulation {
  readonly layer: AssistLayer
  readonly clock = new FixedStepClock()

  /** Total normal load factor from the last tick, g. */
  nz = 1

  /**
   * Acceleration along the flight path, ft/s^2, smoothed.
   *
   * `d(vt)/dt` — the state derivative the integrator already computes — which is
   * exactly the along-path acceleration a pilot feels in their back, as distinct
   * from `nz`, which is the one that pushes them into the seat.
   *
   * It exists because every other speed cue in this project is a function of SPEED,
   * and a function of speed cannot tell you about acceleration: it only reports the
   * result once the speed has already changed. A flight test put it exactly right —
   * "I don't feel like I've accelerated quickly, I have to intuit it from the Mach
   * number increasing and my waiting." The camera and the FOV read this instead.
   */
  ax = 0

  private readonly mass: MassProperties = computeMassProperties()
  private state: number[]
  private previous: number[]
  private controls: Controls
  private spawn: SpawnCondition

  paused = false

  constructor(spawn: SpawnCondition, preset: AssistPreset = BALANCED) {
    this.spawn = spawn
    this.layer = new AssistLayer(preset)

    const { state, controls } = this.trimAt(spawn)
    this.state = state
    this.previous = [...state]
    this.controls = controls
  }

  private trimAt(spawn: SpawnCondition): { state: number[]; controls: Controls } {
    const solution = trim({ alt: spawn.alt, vt: spawn.vt })

    const aircraft = fromStateVector(solution.state)
    // Place and point it. The trim solver works in the aircraft's own terms and
    // does not know or care where in the world it is.
    const heading = (spawn.headingDeg * Math.PI) / 180
    const half = heading / 2

    const state = toQuatVector({
      ...aircraft,
      // Rotate the trimmed attitude about the vertical (NED down) axis by the
      // heading. The trim quaternion is a pitch-only rotation, so composing on the
      // left with a yaw is exact.
      q: yawThen(aircraft.q, Math.cos(half), Math.sin(half)),
      // World position: `seam.ts` maps North to -Z and East to +X, so invert here.
      pn: -spawn.z / 0.3048,
      pe: spawn.x / 0.3048,
      alt: spawn.alt,
    })

    const controls: Controls = {
      throttle: solution.throttle,
      elevator: solution.elevator,
      aileron: solution.aileron,
      rudder: solution.rudder,
    }

    this.layer.seed(fromQuatVector(state), controls)
    return { state, controls }
  }

  /** Trimmed throttle, so the input reader can start the lever in the right place. */
  get trimThrottle(): number {
    return this.controls.throttle
  }

  /**
   * Advance by one frame's worth of wall-clock time.
   *
   * @param elapsed Seconds since the last frame
   * @param input   Called once per physics tick
   */
  advance(elapsed: number, input: () => RawInput): void {
    if (this.paused) return

    this.state = this.clock.advance(
      this.state,
      (_tick, v) => {
        // `v` is this tick's own starting state, not the frame's. At 60 fps a frame
        // is two ticks, and running both from the frame's state means the control
        // law is really updating at 60 Hz however fast the physics runs.
        const aircraft = fromQuatVector(v)
        this.controls = this.layer.update(aircraft, input(), PHYSICS_DT, this.nz)

        // Load factor for the next tick's G limiter, and for the camera.
        const { accel, vd } = quatDerivative(v, this.controls, this.mass, {
          clampAeroAngles: true,
        })
        this.nz = accel.nz + 1

        // Along-path acceleration, lightly smoothed. Raw d(vt)/dt is clean enough at
        // 120 Hz, but it steps when the afterburner lights and the cue should swell
        // rather than snap.
        const blend = Math.min(1, PHYSICS_DT / AX_TAU)
        this.ax += ((vd[Q.VT] as number) - this.ax) * blend

        return this.controls
      },
      elapsed,
      this.mass,
    )

    this.previous = this.clock.previous
  }

  /** What the renderer should draw: the two most recent ticks, blended. */
  render(): RenderState {
    return lerpRenderState(
      toRenderState(this.previous),
      toRenderState(this.state),
      Math.min(1, this.clock.alpha),
    )
  }

  reset(): void {
    this.ax = 0
    const { state, controls } = this.trimAt(this.spawn)
    this.state = state
    this.previous = [...state]
    this.controls = controls
    this.nz = 1
    this.clock.reset()
  }
}

/**
 * Compose a yaw about the NED down axis onto an existing attitude.
 *
 * Hamilton product `q_yaw * q`, with `q_yaw = [cos, 0, 0, sin]` — a rotation about
 * z, which in NED is down, which is heading.
 */
function yawThen(
  q: readonly [number, number, number, number],
  c: number,
  s: number,
): [number, number, number, number] {
  const [w, x, y, z] = q
  return [c * w - s * z, c * x - s * y, c * y + s * x, c * z + s * w]
}
