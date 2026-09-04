/**
 * Situation save/restore and slew (REQUIREMENTS §1, §9 Day 3).
 *
 * The claim being tested is stronger than "it roughly works": a restored situation
 * replays *identically*, because the simulation is a pure function of its state
 * vector and nothing in the world is random. If that ever stops being true, every
 * approach flown from a saved point stops being a repeat of the same approach, and
 * the save is worse than useless because it looks like one.
 */

import { describe, expect, it } from 'vitest'
import { PHYSICS_DT, Q, aeroAngles, eulerFromQuaternion } from '@retro-flyer/physics'
import { NEUTRAL_INPUT, type RawInput } from '@retro-flyer/control'
import { Simulation } from '../src/loop.js'
import { AuthoredGroundSource } from '../src/terrain/groundSource.js'
import { authoredMap } from '../src/terrain/authored.js'
import { SPAWN, runwayStart } from '../src/spawn.js'
import {
  NO_SLEW,
  SITUATION_VERSION,
  SLEW_TURN_DEG,
  applySlew,
  captureSituation,
  parseSituation,
  speedOf,
} from '../src/situation.js'

const ground = new AuthoredGroundSource(authoredMap)
const bayside = authoredMap.airfields.find((a) => a.name === 'Bayside')!

/** A fixed, non-trivial stick input, so the replay has something to disagree about. */
const HELD: RawInput = { ...NEUTRAL_INPUT, pitch: -0.4, roll: 0.25, throttle: 0.8 }

const fly = (sim: Simulation, seconds: number): void => {
  const ticks = Math.round(seconds / PHYSICS_DT)
  for (let i = 0; i < ticks; i++) sim.advance(PHYSICS_DT, () => HELD)
}

describe('situation save and restore', () => {
  it('replays a saved situation exactly', () => {
    const sim = new Simulation(SPAWN, undefined, ground)
    fly(sim, 2)

    const saved = sim.capture()

    fly(sim, 4)
    const flownOn = sim.snapshot()

    // Go back and fly the same four seconds again.
    sim.restore(saved)
    fly(sim, 4)
    const replayed = sim.snapshot()

    for (let i = 0; i < flownOn.length; i++) {
      expect(replayed[i], `state element ${i} diverged on replay`).toBe(flownOn[i])
    }
  })

  it('is not exact if only the physics vector is restored', () => {
    // The negative of the test above, and the reason `capture` exists at all. The
    // assist layer's pitch integrator, alpha filter and stick axes all feed back
    // into the aircraft, so a restore that re-seeds them instead of restoring them
    // flies a measurably different aeroplane. Pinned so that `capture` cannot be
    // quietly simplified back to a state vector.
    const sim = new Simulation(SPAWN, undefined, ground)
    fly(sim, 2)

    const physicsOnly = sim.snapshot()
    fly(sim, 4)
    const flownOn = sim.snapshot()

    sim.setState(physicsOnly)
    fly(sim, 4)
    const reseeded = sim.snapshot()

    const drift = Math.abs((reseeded[Q.U] as number) - (flownOn[Q.U] as number))
    expect(drift, 'a state-vector-only restore should NOT match').toBeGreaterThan(1e-6)
  })

  it('takes a copy, so the caller cannot write into the running state', () => {
    // §8.3 says the renderer never writes to the model. The same has to apply to
    // whatever is holding a saved situation.
    const sim = new Simulation(SPAWN, undefined, ground)
    const snap = sim.snapshot()
    const before = sim.snapshot()

    snap[Q.ALT] = 99_999

    expect(sim.snapshot()[Q.ALT]).toBe(before[Q.ALT])
  })

  it('round-trips through JSON', () => {
    const sim = new Simulation(SPAWN, undefined, ground)
    fly(sim, 1)

    const situation = captureSituation(sim.capture(), { aoaLimiter: true }, 2)
    const parsed = parseSituation(JSON.stringify(situation))

    expect(parsed).not.toBeNull()
    expect(parsed!.sim.state).toEqual(situation.sim.state)
    expect(parsed!.sim.layer.pitchIntegral).toBe(situation.sim.layer.pitchIntegral)
    expect(parsed!.toggles.aoaLimiter).toBe(true)
    expect(parsed!.preset).toBe(2)
  })

  it('survives the whole loop: capture, JSON, parse, restore, replay', () => {
    // What actually happens when the pilot presses save and then load. Nothing in
    // between is allowed to lose a number.
    const sim = new Simulation(SPAWN, undefined, ground)
    fly(sim, 2)

    const json = JSON.stringify(captureSituation(sim.capture(), {}, 0))

    fly(sim, 4)
    const flownOn = sim.snapshot()

    const parsed = parseSituation(json)
    expect(parsed).not.toBeNull()
    sim.restore(parsed!.sim)
    fly(sim, 4)

    expect(sim.snapshot()).toEqual(flownOn)
  })

  it('refuses anything that is not a situation, rather than half-loading it', () => {
    // This reads from localStorage, which is to say from whatever was in the
    // browser. A state vector full of undefined reaching the integrator is a much
    // worse outcome than "no save found".
    const good = captureSituation(new Simulation(SPAWN, undefined, ground).capture(), {}, 0)
    const withSim = (sim: unknown): string =>
      JSON.stringify({ ...good, sim })

    expect(parseSituation(null), 'nothing saved').toBeNull()
    expect(parseSituation(''), 'empty').toBeNull()
    expect(parseSituation('not json'), 'not json').toBeNull()
    expect(parseSituation('{}'), 'empty object').toBeNull()
    expect(
      parseSituation(JSON.stringify({ ...good, version: 999 })),
      'a future format',
    ).toBeNull()
    expect(withSim(undefined) && parseSituation(withSim(undefined)), 'no sim').toBeNull()
    expect(
      parseSituation(withSim({ ...good.sim, state: [1, 2, 3] })),
      'truncated state',
    ).toBeNull()
    expect(
      parseSituation(withSim({ ...good.sim, state: new Array(14).fill(null) })),
      'null state',
    ).toBeNull()
    expect(
      parseSituation(withSim({ ...good.sim, layer: undefined })),
      'no assist state',
    ).toBeNull()
    expect(
      parseSituation(withSim({ ...good.sim, nz: 'x' })),
      'nz not a number',
    ).toBeNull()

    // And the good one still parses, so the guards are not simply refusing everything.
    expect(parseSituation(JSON.stringify(good))).not.toBeNull()
  })
})

describe('slew', () => {
  it('moves the aircraft without flying it', () => {
    const sim = new Simulation(SPAWN, undefined, ground)
    const before = sim.snapshot()

    let v = sim.snapshot()
    for (let i = 0; i < 60; i++) {
      v = applySlew(v, { forward: 1, right: 0, up: 0.5, turn: 0 }, 1 / 60)
    }

    expect(v[Q.ALT] as number).toBeGreaterThan(before[Q.ALT] as number)
    // Moved somewhere, and stopped dead there.
    const moved = Math.hypot(
      (v[Q.PN] as number) - (before[Q.PN] as number),
      (v[Q.PE] as number) - (before[Q.PE] as number),
    )
    expect(moved).toBeGreaterThan(1_000)
    expect(speedOf(v)).toBe(0)
  })

  it('leaves the aircraft wings level, whatever it was doing before', () => {
    // Releasing slew from a 60-degree bank drops the aircraft into a spiral at
    // exactly the moment the pilot is not expecting to have to fly.
    const sim = new Simulation(SPAWN, undefined, ground)
    fly(sim, 3) // roll input above puts it into a bank

    const banked = sim.snapshot()
    const slewed = applySlew(banked, NO_SLEW, 1 / 60)

    // A wings-level attitude has no roll: qx and qy vanish for a pure yaw.
    expect(slewed[Q.QX] as number).toBeCloseTo(0, 12)
    expect(slewed[Q.QY] as number).toBeCloseTo(0, 12)
    expect(slewed[Q.P] as number).toBe(0)
    expect(slewed[Q.R] as number).toBe(0)
  })

  it('holds heading when not turning, and changes it when turning', () => {
    // Asserted on heading rather than on the quaternion, because slew deliberately
    // flattens pitch and roll: the spawn attitude is trimmed nose-up, so `qz`
    // legitimately changes even when the heading does not.
    const sim = new Simulation(SPAWN, undefined, ground)
    const v0 = sim.snapshot()
    const headingOf = (v: readonly number[]): number =>
      eulerFromQuaternion([
        v[Q.QW] as number,
        v[Q.QX] as number,
        v[Q.QY] as number,
        v[Q.QZ] as number,
      ]).psi

    const straight = applySlew(v0, { forward: 1, right: 0, up: 0, turn: 0 }, 1)
    const turned = applySlew(v0, { forward: 0, right: 0, up: 0, turn: 1 }, 1)

    expect(headingOf(straight)).toBeCloseTo(headingOf(v0), 9)
    expect(headingOf(turned) - headingOf(v0)).toBeCloseTo(
      (SLEW_TURN_DEG * Math.PI) / 180,
      6,
    )
  })

  it('can be flown out of, from a state the simulation accepts', () => {
    const sim = new Simulation(SPAWN, undefined, ground)
    const slewed = applySlew(sim.snapshot(), { forward: 1, right: 0, up: 1, turn: 0.2 }, 2)

    sim.setState(slewed)
    fly(sim, 3)

    const after = sim.snapshot()
    for (const value of after) expect(Number.isFinite(value)).toBe(true)
    // It was dropped from rest, so it is falling and picking up speed. That is the
    // documented behaviour of leaving slew, not a bug.
    expect(aeroAngles(after[Q.U] as number, after[Q.V] as number, after[Q.W] as number).vt)
      .toBeGreaterThan(0)
  })
})

describe('a runway start', () => {
  it('puts the aircraft on its wheels at the field, not in the air', () => {
    const sim = new Simulation(runwayStart(bayside), undefined, ground)

    expect(sim.onGround, 'should be on the ground at t=0').toBe(true)
    expect(speedOf(sim.snapshot())).toBe(0)
    // Carrying exactly its own weight, not 109% of it — the aircraft is placed at
    // the attitude it rests at, which is not level. See `restingAttitude`.
    expect(sim.gear.totalNormal / 20_500).toBeCloseTo(1, 2)
  })

  it('starts at the threshold with the runway ahead of it', () => {
    const spawn = runwayStart(bayside)
    const fromCentre = Math.hypot(spawn.x - bayside.x, spawn.z - bayside.z)

    // Most of the way back from the midpoint, but not off the end.
    expect(fromCentre).toBeGreaterThan(bayside.lengthM * 0.3)
    expect(fromCentre).toBeLessThan(bayside.lengthM / 2)
  })

  it('is already settled — the first frame is not a bounce', () => {
    const sim = new Simulation(runwayStart(bayside), undefined, ground)
    const first = sim.gear.totalNormal

    sim.gearInput = { brake: 1, steer: 0, down: true }
    fly(sim, 2)

    expect(sim.gear.totalNormal / first).toBeCloseTo(1, 2)
    expect(sim.onGround).toBe(true)
  })
})
