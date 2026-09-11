/**
 * Situation save and restore, and slew (REQUIREMENTS §1, §9 Day 3).
 *
 * These are listed as features, and they are, but they were built before the landing
 * work because they are its test harness. Flying forty nautical miles to try an
 * approach, getting it wrong, and flying it again is how an afternoon disappears.
 * Saving on short final and restoring costs nothing.
 *
 * Both rest on the same property: the simulation is a pure function of its state
 * vector. Physics is deterministic, the map is hash-based with no `Math.random()`
 * anywhere in it, and the assist layer is re-seeded from the state it is given. So a
 * restored situation is not an approximation of the saved one — it is the same one,
 * and `test/situation.test.ts` asserts exactly that.
 *
 * No three.js here, so it tests in Node.
 */

import { Q, aeroAngles, eulerFromQuaternion, quaternionFromEuler } from '@retro-flyer/physics'
import type { SimSnapshot } from './loop.js'

/**
 * Format version, so a saved situation from an older build is rejected, not misread.
 *
 * Bumped to 2 when the region was added. A version 1 save carries a state vector but
 * no record of which world it was taken in, and there is no way to guess: restoring a
 * set of New York coordinates onto the designed map does not fail, it silently
 * teleports the aircraft to a position that means something else entirely. Rejecting
 * those saves costs a stale slot once and is the only honest option.
 */
export const SITUATION_VERSION = 2

export interface Situation {
  version: number
  /**
   * The simulation's full inter-tick state — physics, controls, load factor and the
   * assist layer's filters. Not just the state vector; see `Simulation.capture`.
   */
  sim: SimSnapshot
  /** Assist toggles at the time of saving. */
  toggles: Record<string, boolean>
  /** Which preset was selected. */
  preset: number
  /**
   * Which world it was saved in — a `MapId`, so `'designed'`, `'new-york'` or
   * `'chicago'`.
   *
   * A state vector is only meaningful against the map it was recorded on. Position is
   * world metres from that map's origin, and the two regions and the authored map put
   * entirely different things at the same coordinates. Without this the restore is a
   * teleport into the wrong world, which looks like a bug in the physics rather than
   * what it is.
   */
  region: string
  /** Wall-clock label, for a human choosing between slots. */
  savedAt: string
}

export function captureSituation(
  sim: SimSnapshot,
  toggles: Record<string, boolean>,
  preset: number,
  region: string,
): Situation {
  return {
    version: SITUATION_VERSION,
    sim,
    toggles: { ...toggles },
    preset,
    region,
    savedAt: new Date().toISOString(),
  }
}

/**
 * Parse a stored situation, returning null for anything that is not one.
 *
 * Deliberately suspicious. This reads from `localStorage`, which is to say from
 * whatever was in the browser — an older format, a half-written string, a different
 * project on the same origin. A malformed save should mean "no save", never a state
 * vector full of `undefined` fed straight into the integrator.
 */
export function parseSituation(raw: string | null): Situation | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<Situation>

    if (parsed.version !== SITUATION_VERSION) return null

    const sim = parsed.sim
    if (!sim || typeof sim !== 'object') return null
    if (!Array.isArray(sim.state) || sim.state.length !== 14) return null
    if (!sim.state.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
    if (!sim.layer || typeof sim.layer !== 'object') return null
    if (!sim.controls || typeof sim.controls !== 'object') return null
    if (typeof sim.nz !== 'number' || !Number.isFinite(sim.nz)) return null
    if (!sim.gear || typeof sim.gear !== 'object') return null

    // A save with no region is a save that cannot be placed. There is no sensible
    // default: guessing the authored map would drop a region save into the wrong
    // world, which is the failure this field exists to prevent.
    if (typeof parsed.region !== 'string' || parsed.region === '') return null

    return {
      version: SITUATION_VERSION,
      sim: sim as SimSnapshot,
      toggles: (parsed.toggles ?? {}) as Record<string, boolean>,
      preset: typeof parsed.preset === 'number' ? parsed.preset : 0,
      region: parsed.region,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Slew
// ---------------------------------------------------------------------------

/** How fast slew moves, ft/s, and turns, deg/s. `[A]` */
export const SLEW_SPEED_FPS = 3_000
export const SLEW_VERTICAL_FPS = 800
export const SLEW_TURN_DEG = 60

export interface SlewCommand {
  /** Forward along the current heading, -1 to 1. */
  forward: number
  /** Right of the current heading, -1 to 1. */
  right: number
  /** Up, -1 to 1. */
  up: number
  /** Yaw, -1 to 1. */
  turn: number
}

export const NO_SLEW: SlewCommand = { forward: 0, right: 0, up: 0, turn: 0 }

/**
 * Move the aircraft without flying it.
 *
 * Slew is a teleport per frame, not a force: it writes position and heading directly
 * and holds velocity at zero. Attitude is flattened to wings-level at the current
 * heading, because a slew that preserved a 60-degree bank would drop the aircraft
 * into a spiral the moment it was released — which is exactly the moment the pilot
 * is not expecting to have to fly.
 *
 * Airspeed is left at zero rather than preserved. Coming out of slew is therefore a
 * fall, not a flight, which is honest: slew is for positioning, and the situation
 * restore above is the tool for arriving somewhere already flying.
 */
export function applySlew(
  state: readonly number[],
  command: SlewCommand,
  dt: number,
): number[] {
  const out = [...state]

  const q: [number, number, number, number] = [
    state[Q.QW] as number,
    state[Q.QX] as number,
    state[Q.QY] as number,
    state[Q.QZ] as number,
  ]
  const { psi } = eulerFromQuaternion(q)

  const heading = psi + (command.turn * SLEW_TURN_DEG * Math.PI) / 180 * dt

  const c = Math.cos(heading)
  const s = Math.sin(heading)

  // Forward is along the heading; right is ninety degrees clockwise from it.
  const north = command.forward * c - command.right * s
  const east = command.forward * s + command.right * c

  out[Q.PN] = (state[Q.PN] as number) + north * SLEW_SPEED_FPS * dt
  out[Q.PE] = (state[Q.PE] as number) + east * SLEW_SPEED_FPS * dt
  out[Q.ALT] = (state[Q.ALT] as number) + command.up * SLEW_VERTICAL_FPS * dt

  const level = quaternionFromEuler(0, 0, heading)
  out[Q.QW] = level[0]
  out[Q.QX] = level[1]
  out[Q.QY] = level[2]
  out[Q.QZ] = level[3]

  // Frozen: no velocity, no rotation. Slew is not flight.
  out[Q.U] = 0
  out[Q.V] = 0
  out[Q.W] = 0
  out[Q.P] = 0
  out[Q.Q_RATE] = 0
  out[Q.R] = 0

  return out
}

/** Airspeed of a state, ft/s — for the overlay, which has no other way to ask. */
export const speedOf = (state: readonly number[]): number =>
  aeroAngles(state[Q.U] as number, state[Q.V] as number, state[Q.W] as number).vt
