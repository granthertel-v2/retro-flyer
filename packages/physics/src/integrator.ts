/**
 * Fixed-step RK4 integration (REQUIREMENTS §3).
 *
 * ## Why fixed step, and why decoupled from rendering
 *
 * Tying the physics step to the render frame rate makes the aircraft behave
 * differently on different hardware — a machine dropping to 30 fps flies a
 * measurably different airplane than one at 144 fps. Worse, it makes bugs
 * unreproducible: the same inputs give different results depending on what the
 * browser was doing.
 *
 * So physics runs at a fixed 120 Hz regardless of frame rate. `step()` advances
 * exactly one tick. `advance()` runs as many whole ticks as the elapsed wall time
 * calls for and carries the remainder forward, so the simulation stays in step with
 * real time without ever varying `dt`.
 *
 * ## Why RK4 rather than Euler
 *
 * The short-period mode of this airframe has a natural frequency around 2-3 rad/s.
 * Forward Euler at 120 Hz would add noticeable artificial damping to it — the
 * aircraft would feel sluggish, and worse, the §4.2 modal test would measure the
 * integrator's damping rather than the aircraft's. RK4 costs four derivative
 * evaluations per tick and removes that error to fourth order.
 *
 * This matters for honesty, not just accuracy: a test that measures integration
 * error and reports it as a damping ratio is exactly the kind of thing REQUIREMENTS
 * §4.3 exists to catch.
 */

import type { Controls, DerivativeOptions } from './dynamics.js'
import { computeMassProperties, type MassProperties } from './massProperties.js'
import { Q, quatDerivative, renormalizeQuat } from './state.js'

/** Physics tick rate, Hz (REQUIREMENTS §3). */
export const PHYSICS_HZ = 120
/** Physics timestep, seconds. */
export const PHYSICS_DT = 1 / PHYSICS_HZ

/**
 * Largest wall-clock interval `advance` will consume in one call, seconds.
 *
 * Without this, a tab backgrounded for thirty seconds returns and asks for 3,600
 * physics ticks at once — the sim freezes trying to catch up, which produces an
 * even bigger gap next frame. Capping it means we lose simulated time after a long
 * stall, which is the right trade: the alternative is an unrecoverable spiral.
 */
export const MAX_CATCHUP_SECONDS = 0.25

/**
 * One RK4 step of the quaternion state.
 *
 * Controls are held constant across the step. That is standard — inputs are sampled
 * once per tick — and at 120 Hz the error from it is far below anything else here.
 *
 * The quaternion is renormalized at the end. RK4 does not preserve unit norm
 * exactly, and the drift compounds: left alone over a long flight the quaternion
 * slowly stops representing a rotation at all, and attitude quietly skews. The
 * correction is tiny per step and free.
 */
export function step(
  v: readonly number[],
  u: Controls,
  dt: number = PHYSICS_DT,
  mass: MassProperties = computeMassProperties(),
  opts: DerivativeOptions = { clampAeroAngles: true },
): number[] {
  const n = v.length

  const add = (base: readonly number[], k: readonly number[], scale: number): number[] => {
    const out = new Array<number>(n)
    for (let i = 0; i < n; i++) out[i] = (base[i] as number) + (k[i] as number) * scale
    return out
  }

  const k1 = quatDerivative(v, u, mass, opts).vd
  const k2 = quatDerivative(add(v, k1, dt / 2), u, mass, opts).vd
  const k3 = quatDerivative(add(v, k2, dt / 2), u, mass, opts).vd
  const k4 = quatDerivative(add(v, k3, dt), u, mass, opts).vd

  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    out[i] =
      (v[i] as number) +
      (dt / 6) *
        ((k1[i] as number) + 2 * (k2[i] as number) + 2 * (k3[i] as number) + (k4[i] as number))
  }

  renormalizeQuat(out)
  return out
}

/**
 * Integration clock. Converts variable wall-clock time into whole fixed ticks.
 *
 * Hold one of these per simulation and feed it the frame delta. It runs whole ticks
 * and keeps the leftover for next time, so `dt` inside the physics is always
 * exactly `PHYSICS_DT`.
 */
export class FixedStepClock {
  private accumulator = 0
  /** Total physics ticks run since construction. */
  public ticks = 0

  /**
   * State as it was *before* the most recent tick.
   *
   * This is what the renderer interpolates from, together with the returned state
   * and `alpha` (REQUIREMENTS §8.3). It has to be the previous **tick**, not the
   * state at the start of the frame: at 60 fps a frame runs two ticks, so
   * interpolating from the frame's starting state blends across 16 ms of motion
   * with a fraction that only describes the last 8 — and the aircraft visibly
   * shivers, worst at high speed and low altitude where there is most to compare it
   * against.
   */
  public previous: number[] = []

  constructor(
    public readonly dt: number = PHYSICS_DT,
    public readonly maxCatchup: number = MAX_CATCHUP_SECONDS,
  ) {}

  /**
   * Advance the state by however many whole ticks `elapsed` allows.
   *
   * @param v        Current quaternion state vector
   * @param controls Called once per tick, with the tick number and the state that
   *                 tick is starting from — so an assist layer can respond at the
   *                 physics rate rather than the frame rate. Passing the state is
   *                 what makes that actually possible: without it a caller can only
   *                 see the state from the start of the frame, so every tick within
   *                 a frame is computed from identical inputs and the control law
   *                 is effectively running at the frame rate after all.
   * @param elapsed  Wall-clock seconds since the last call
   */
  advance(
    v: readonly number[],
    controls: (tick: number, state: readonly number[]) => Controls,
    elapsed: number,
    mass: MassProperties = computeMassProperties(),
  ): number[] {
    this.accumulator += Math.min(elapsed, this.maxCatchup)

    let state = v as number[]
    this.previous = state

    while (this.accumulator >= this.dt) {
      this.previous = state
      state = step(state, controls(this.ticks, state), this.dt, mass)
      this.accumulator -= this.dt
      this.ticks++
    }

    return state
  }

  /**
   * Fraction of a tick left over, 0 to 1.
   *
   * The renderer interpolates by this between the last two physics states, so
   * motion looks smooth at frame rates that are not multiples of 120 Hz
   * (REQUIREMENTS §8.3).
   */
  get alpha(): number {
    return this.accumulator / this.dt
  }

  reset(): void {
    this.accumulator = 0
    this.ticks = 0
    this.previous = []
  }
}

/**
 * Integrate for a fixed duration, collecting the trajectory.
 *
 * Used by the validation suite — modal analysis and the energy test both need a
 * time history rather than a single step. Not used by the running simulation.
 */
export function simulate(
  v0: readonly number[],
  controls: (t: number, v: readonly number[]) => Controls,
  duration: number,
  dt: number = PHYSICS_DT,
  mass: MassProperties = computeMassProperties(),
): { t: number[]; states: number[][] } {
  const steps = Math.round(duration / dt)
  const t: number[] = [0]
  const states: number[][] = [v0 as number[]]

  let v = v0 as number[]
  for (let i = 0; i < steps; i++) {
    const time = i * dt
    v = step(v, controls(time, v), dt, mass)
    t.push(time + dt)
    states.push(v)
  }

  return { t, states }
}

/** Total specific energy, ft — the §4.2 energy test's quantity. */
export function specificEnergy(v: readonly number[]): number {
  const vt = v[Q.VT] as number
  const alt = v[Q.ALT] as number
  // E/(mg) = h + V^2/(2g). Height plus the altitude the speed could buy.
  return alt + (vt * vt) / (2 * 32.17)
}
