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
  GEAR_DOWN,
  DEFAULT_GEAR,
  PHYSICS_DT,
  Q,
  computeMassProperties,
  fromQuatVector,
  fromStateVector,
  quatDerivative,
  toQuatVector,
  gearLoads,
  quaternionFromEuler,
  restingAttitude,
  trim,
  type Controls,
  type ExternalLoads,
  type GearInput,
  type GearState,
  type GroundSource,
  type Strut,
  type MassProperties,
} from '@retro-flyer/physics'
import {
  AssistLayer,
  BALANCED,
  RUDDER_LIMIT_DEG,
  type AssistPreset,
  type AssistSnapshot,
  type RawInput,
} from '@retro-flyer/control'
import { lerpRenderState, toRenderState, type RenderState } from './seam.js'

/**
 * What the physics finds when no terrain has been supplied.
 *
 * A headless test of the flight loop should not have to build a world. Sea level and
 * water, so the gear finds nothing to push against and the aircraft simply flies —
 * which is Day 2's behaviour exactly, and what keeps those tests meaningful.
 */
const NO_TERRAIN = { elevation: 0, solid: false, rollingResistance: 0, friction: 0 }
import { AX_REFERENCE_ACCEL } from './camera/accel.js'

/** Everything needed to resume a flight exactly. See `Simulation.capture`. */
export interface SimSnapshot {
  state: number[]
  controls: Controls
  nz: number
  layer: AssistSnapshot
}

export interface SpawnCondition {
  alt: number
  vt: number
  /** Heading, degrees true. */
  headingDeg: number
  /** Start position, world metres (X East, Z South). */
  x: number
  z: number
  /**
   * Start sitting on the gear rather than trimmed in flight.
   *
   * A ground start cannot be trimmed: trim solves for the controls that hold steady
   * flight, and there is no steady flight at zero airspeed. `alt` is ignored — the
   * terrain decides where the wheels are.
   */
  onGround?: boolean
}

/**
 * Attack and release time constants for the along-path acceleration cue, seconds.
 *
 * Deliberately asymmetric, which one symmetric constant cannot be. A flight test
 * asked for the ramp to "start sooner and extend out longer", and those are two
 * different edges of the same envelope: how fast the cue arrives when acceleration
 * begins, and how slowly it lets go when acceleration stops.
 *
 * At a shared 0.25 s the cue arrived late — a second into a slam the smoothed value
 * was still only two thirds of the real acceleration, during exactly the moment the
 * engine is doing its most obvious work — and then dropped away as briskly as it
 * came, so easing the throttle back snapped the frame shut.
 *
 * A fast attack and a slow release is the same envelope a compressor uses, and for
 * the same reason: the onset is the information, and the tail is what makes it feel
 * like something rather than a flicker.
 */
const AX_ATTACK_TAU = 0.12
const AX_RELEASE_TAU = 1.3

/**
 * Time constant for the sustained-acceleration envelope, seconds.
 *
 * Long on purpose. This is the part of the cue that keeps building while the
 * afterburner is held, and it is what makes the ramp last as long as the
 * acceleration does rather than saturating three seconds in — see `SUSTAIN_SHARE`.
 * It fills and empties at the same rate, so easing off unwinds it over a few seconds
 * instead of dropping it.
 */
const SUSTAIN_TAU = 4.5

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

  /**
   * How long acceleration has been sustained, 0 to 1.
   *
   * `ax` alone is flat through an afterburner run — it reaches its maximum in about
   * three seconds and stays there — so a cue driven by it alone saturates and then
   * says nothing for the rest of the acceleration. This fills slowly while `ax` is
   * high and gives the cue somewhere to keep going. See `sustainedResponse`.
   */
  sustain = 0

  /**
   * Ground reaction from the last tick.
   *
   * Read by the assist layer (which flies a different aircraft on the ground), the
   * overlay, and the course. Recomputed rather than cached from inside the
   * integrator because the integrator evaluates it four times per tick at four
   * different states, and none of those is the one that ended up being the answer.
   */
  gear: GearState

  /** Brakes, steering and gear position. Written by the app each frame. */
  gearInput: GearInput = { ...GEAR_DOWN }

  /** Strut set. Overridable so gear geometry can be swept in a test. */
  gearStruts: readonly Strut[] = DEFAULT_GEAR

  private readonly mass: MassProperties = computeMassProperties()
  private state: number[]
  private previous: number[]
  private controls: Controls
  private spawn: SpawnCondition

  paused = false

  constructor(
    spawn: SpawnCondition,
    preset: AssistPreset = BALANCED,
    private readonly ground: GroundSource = { sample: () => NO_TERRAIN },
  ) {
    this.spawn = spawn
    this.layer = new AssistLayer(preset)

    const { state, controls } = this.place(spawn)
    this.state = state
    this.previous = [...state]
    this.controls = controls
    this.gear = gearLoads(this.state, this.ground, this.gearInput, this.gearStruts)
  }

  /** Whether any wheel is on the ground. The assist layer's regime switch. */
  get onGround(): boolean {
    return this.gear.onGround
  }

  /**
   * Nosewheel steering command, -1 to 1.
   *
   * Taken from the rudder deflection the assist layer just produced rather than from
   * the raw pedal, so the nosewheel inherits the same conditioning the pedals have —
   * deadband, smoothing, rate limit. Bang-bang keyboard input must never reach the
   * model directly (§5), and a nosewheel is no different from a control surface in
   * that respect even though it is not one.
   *
   * On the ground `yawCommand` runs with auto-coordination off, so this is the
   * pilot's pedal and nothing else.
   */
  get steerCommand(): number {
    return this.controls.rudder / RUDDER_LIMIT_DEG
  }

  private place(spawn: SpawnCondition): { state: number[]; controls: Controls } {
    return spawn.onGround ? this.parkAt(spawn) : this.trimAt(spawn)
  }

  /**
   * Put the aircraft on its wheels at a field.
   *
   * There is no trim solution here to find — trim solves for steady flight and there
   * is no steady flight at rest — so the state is constructed directly: level, at
   * rest, engine off, and at exactly the altitude that puts the mains at the static
   * compression `staticCompression` predicts. Placing it there rather than dropping
   * it means the first frame is already settled instead of showing a bounce.
   */
  private parkAt(spawn: SpawnCondition): { state: number[]; controls: Controls } {
    const pn = -spawn.z / 0.3048
    const pe = spawn.x / 0.3048
    const elevation = this.ground.sample(pn, pe).elevation
    const rest = restingAttitude(this.gearStruts)

    const heading = (spawn.headingDeg * Math.PI) / 180

    const state = toQuatVector({
      vt: 0,
      alpha: 0,
      beta: 0,
      // Settled, which is not level: see `restingAttitude`.
      q: quaternionFromEuler(0, rest.pitch, heading),
      p: 0,
      qRate: 0,
      r: 0,
      pn,
      pe,
      alt: elevation + rest.cgHeight,
      power: 0,
    })

    const controls: Controls = { throttle: 0, elevator: 0, aileron: 0, rudder: 0 }
    this.layer.seed(fromQuatVector(state), controls)

    return { state, controls }
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

    const loads = (v: readonly number[]): ExternalLoads =>
      gearLoads(v, this.ground, this.gearInput, this.gearStruts).loads

    this.state = this.clock.advance(
      this.state,
      (_tick, v) => {
        // `v` is this tick's own starting state, not the frame's. At 60 fps a frame
        // is two ticks, and running both from the frame's state means the control
        // law is really updating at 60 Hz however fast the physics runs.
        const aircraft = fromQuatVector(v)
        this.gear = gearLoads(v, this.ground, this.gearInput, this.gearStruts)
        this.controls = this.layer.update(
          aircraft,
          input(),
          PHYSICS_DT,
          this.nz,
          this.gear.onGround,
        )

        // Load factor for the next tick's G limiter, and for the camera. The gear
        // loads go in: an accelerometer sitting on a runway reads 1 g, and it reads
        // it because of the gear. Leaving them out would show 0 g while parked and
        // would hand the G limiter a number that has nothing to do with the seat.
        const { accel, vtDot } = quatDerivative(
          v,
          this.controls,
          this.mass,
          { clampAeroAngles: true },
          this.gear.loads,
        )
        this.nz = accel.nz + 1

        // Along-path acceleration, with a fast attack and a slow release. Raw
        // d(vt)/dt is clean enough at 120 Hz, but it steps when the afterburner
        // lights, and the cue should swell rather than snap — and having swelled,
        // should not vanish the instant the throttle moves.
        //
        // `vtDot` is returned by the derivative rather than read out of it: airspeed
        // is no longer a state (see `state.ts` on body-axis velocity), so there is
        // no `vd[VT]` to index. The quantity is identical.
        const raw = vtDot
        const tau = Math.abs(raw) > Math.abs(this.ax) ? AX_ATTACK_TAU : AX_RELEASE_TAU
        this.ax += (raw - this.ax) * Math.min(1, PHYSICS_DT / tau)

        // And the slow envelope underneath it, which is what keeps the cue building
        // for as long as the acceleration is held.
        const saturation = Math.min(1, Math.abs(this.ax) / AX_REFERENCE_ACCEL)
        this.sustain += (saturation - this.sustain) * Math.min(1, PHYSICS_DT / SUSTAIN_TAU)

        return this.controls
      },
      elapsed,
      this.mass,
      loads,
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

  reset(spawn: SpawnCondition = this.spawn): void {
    this.spawn = spawn
    this.ax = 0
    this.sustain = 0
    this.gearInput = { ...GEAR_DOWN }
    const { state, controls } = this.place(spawn)
    this.state = state
    this.previous = [...state]
    this.controls = controls
    this.nz = 1
    this.gear = gearLoads(this.state, this.ground, this.gearInput, this.gearStruts)
    this.clock.reset()
  }

  /**
   * The raw state vector, for slew and for anything that wants to read a position.
   *
   * A copy, because the caller must not be able to write to the state the integrator
   * is holding — §8.3 says the renderer never writes to the model, and the same
   * applies to anything else that asks.
   *
   * This is NOT enough to save a situation with. See `capture`.
   */
  snapshot(): number[] {
    return [...this.state]
  }

  /**
   * Everything needed to resume this flight exactly.
   *
   * More than the state vector, and the difference is not academic. The assist layer
   * holds a pitch integrator, a filtered alpha rate and four rate-limited stick
   * axes, all of which feed the aircraft on the next tick; `nz` from the last tick
   * closes the G limiter's loop. Restoring the physics alone and re-seeding the law
   * produces an aircraft that flies on differently from the one that was saved —
   * measured at 5.6e-4 of airspeed after four seconds, and growing.
   */
  capture(): SimSnapshot {
    return {
      state: [...this.state],
      controls: { ...this.controls },
      nz: this.nz,
      layer: this.layer.capture(),
    }
  }

  /** Resume a captured situation. Exact: the replay is the same flight. */
  restore(s: SimSnapshot): void {
    this.state = [...s.state]
    this.previous = [...s.state]
    this.controls = { ...s.controls }
    this.nz = s.nz
    this.layer.restore(s.layer)
    this.ax = 0
    this.sustain = 0
    this.gear = gearLoads(this.state, this.ground, this.gearInput, this.gearStruts)
    this.clock.reset()
  }

  /**
   * Replace the state outright.
   *
   * Slew and situation restore both need this, and both are teleports: no
   * integration connects the old state to the new one. `previous` is set to the same
   * value so the renderer's interpolation has nothing to blend across — otherwise
   * the aircraft is drawn streaking between the two positions for one frame.
   */
  setState(v: readonly number[]): void {
    this.state = [...v]
    this.previous = [...v]
    this.ax = 0
    this.sustain = 0
    this.nz = 1
    this.gear = gearLoads(this.state, this.ground, this.gearInput, this.gearStruts)
    this.layer.seed(fromQuatVector(this.state), this.controls)
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
