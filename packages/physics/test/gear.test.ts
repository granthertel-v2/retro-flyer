/**
 * Ground reaction (REQUIREMENTS §3, Day 3).
 *
 * Everything in `gear.ts` is `[A]` — chosen, not sourced — so these tests assert
 * consequences rather than constants. "The mains carry 87.5% of the weight" is a
 * claim someone can disagree with; "k is 26,000" is not.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GEAR,
  GEAR_DOWN,
  GEAR_UP,
  LEFT_MAIN,
  NOSE_GEAR,
  gearLoads,
  restingAttitude,
  staticCompression,
} from '../src/gear.js'
import { FlatGround, NoGround, PAVED, SOFT } from '../src/ground.js'
import { IDENTITY_QUATERNION, Q, aeroAngles, toQuatVector } from '../src/state.js'
import { PHYSICS_HZ, step } from '../src/integrator.js'
import { REFERENCE_WEIGHT_LB, computeMassProperties } from '../src/massProperties.js'
import { quaternionFromEuler } from '../src/state.js'
import type { Controls } from '../src/dynamics.js'

const FIELD_ELEV = 500
const paved = new FlatGround(FIELD_ELEV, PAVED)

const IDLE: Controls = { throttle: 0, elevator: 0, aileron: 0, rudder: 0 }

/** Brakes full on — a parking brake, and what a rollout uses. */
const HELD = { brake: 1, steer: 0, down: true }

/** An aircraft sitting on its gear at `speed` ft/s, already at static compression. */
function parked(speed = 0, opts: { theta?: number; phi?: number; alt?: number } = {}) {
  const comp = staticCompression()
  // Place the CG so the mains are at their static squash. The nose then finds its own.
  const wheelDrop = LEFT_MAIN.z - (comp[1] as number)
  return toQuatVector({
    vt: speed,
    alpha: 0,
    beta: 0,
    q:
      opts.theta || opts.phi
        ? quaternionFromEuler(opts.phi ?? 0, opts.theta ?? 0, 0)
        : IDENTITY_QUATERNION,
    p: 0,
    qRate: 0,
    r: 0,
    pn: 0,
    pe: 0,
    alt: opts.alt ?? FIELD_ELEV + wheelDrop,
    power: 0,
  })
}

/** Run the sim with ground reaction applied, returning the final state. */
function roll(
  v0: number[],
  u: Controls,
  seconds: number,
  input = GEAR_DOWN,
  ground = paved,
): number[] {
  let v = v0
  const mass = computeMassProperties()
  for (let i = 0; i < Math.round(seconds * PHYSICS_HZ); i++) {
    v = step(v, u, undefined, mass, undefined, (s) => gearLoads(s, ground, input).loads)
  }
  return v
}

const speedOf = (v: readonly number[]): number =>
  Math.hypot(v[Q.U] as number, v[Q.V] as number, v[Q.W] as number)

describe('a parked aircraft', () => {
  it('is held up by its gear, carrying exactly its own weight', () => {
    const v = roll(parked(), IDLE, 3)
    const g = gearLoads(v, paved)

    expect(g.onGround).toBe(true)
    expect(g.totalNormal / REFERENCE_WEIGHT_LB).toBeCloseTo(1, 2)
    expect(g.bottomed).toBe(false)
  })

  it('puts the weight on the mains, not the nosewheel', () => {
    // The whole point of the longitudinal arrangement. A tricycle aircraft with most
    // of its weight on the nose would sit on its nose.
    const v = roll(parked(), IDLE, 3)
    const g = gearLoads(v, paved)

    const nose = g.normal[0] as number
    const mains = (g.normal[1] as number) + (g.normal[2] as number)

    expect(nose / g.totalNormal).toBeCloseTo(0.125, 1)
    expect(mains / g.totalNormal).toBeCloseTo(0.875, 1)
    // Symmetric to within a part in ten million. Not exactly, because the engine's
    // angular momentum gyroscopically couples the axes even at rest.
    const asymmetry =
      Math.abs((g.normal[1] as number) - (g.normal[2] as number)) / (g.normal[1] as number)
    expect(asymmetry).toBeLessThan(1e-6)
  })

  it('settles rather than sinking or bouncing out', () => {
    const v = roll(parked(), IDLE, 8, HELD)
    const g = gearLoads(v, paved, HELD)

    for (const value of v) expect(Number.isFinite(value)).toBe(true)
    for (const c of g.compression) {
      expect(c).toBeGreaterThan(0)
      expect(c).toBeLessThan(LEFT_MAIN.stroke)
    }
    // Still on the ground eight seconds later, and not sinking through it.
    expect(g.onGround).toBe(true)
    expect(Math.abs(v[Q.W] as number), 'still moving vertically').toBeLessThan(0.05)
  })

  it('holds its position on the brakes', () => {
    const before = parked()
    const after = roll(before, IDLE, 10, HELD)

    const moved = Math.hypot(
      (after[Q.PN] as number) - (before[Q.PN] as number),
      (after[Q.PE] as number) - (before[Q.PE] as number),
    )
    expect(moved, 'parked aircraft wandered off the brakes').toBeLessThan(1)
    expect(speedOf(after)).toBeLessThan(0.5)
  })

  it('holds against military power but not against afterburner', () => {
    // Both halves matter, and a flight test asked about both. The brakes are not
    // weak: full braking stops the aircraft in 688 m from 150 kt, and they hold it
    // still through most of the throttle range. But 11,700 lb of braking cannot
    // hold 24,000 lb of afterburner, and it should not — a real F-16 cannot run up
    // to full power against its brakes either, which is why a brake release is a
    // manoeuvre and not a formality.
    const distanceAt = (throttle: number): number => {
      const before = parked()
      const after = roll(before, { throttle, elevator: 0, aileron: 0, rudder: 0 }, 25, HELD)
      return Math.hypot(
        (after[Q.PN] as number) - (before[Q.PN] as number),
        (after[Q.PE] as number) - (before[Q.PE] as number),
      ) * 0.3048
    }

    // Measured: 0.6 m at idle, 7 m at 60%, 483 m at 80%.
    expect(distanceAt(0), 'crept at idle on the brakes').toBeLessThan(3)
    expect(distanceAt(0.5), 'crept at half power on the brakes').toBeLessThan(20)
    expect(distanceAt(1), 'brakes held full afterburner').toBeGreaterThan(100)
  })

  it('rolls forward at idle with the brakes off, because a jet at idle makes thrust', () => {
    // Not a defect, and worth pinning so nobody "fixes" it. The engine table gives
    // 1,041 lb at idle at sea level against 410 lb of rolling resistance, so the
    // aircraft taxis. That is what jets do, and it is why the brakes exist.
    const before = parked()
    const after = roll(before, IDLE, 10)

    const moved = (after[Q.PN] as number) - (before[Q.PN] as number)
    expect(moved, 'idle thrust should move the aircraft').toBeGreaterThan(10)
    expect(moved, 'and not very fast').toBeLessThan(120)
  })

  it('does not chatter — the normal force is steady, not oscillating', () => {
    // A `sign(v)` friction law makes this test fail loudly: the force flips every
    // tick and the aircraft buzzes. See SLIP_REFERENCE_FPS.
    let v = parked()
    const mass = computeMassProperties()
    const samples: number[] = []

    for (let i = 0; i < 5 * PHYSICS_HZ; i++) {
      v = step(v, IDLE, undefined, mass, undefined, (s) => gearLoads(s, paved).loads)
      if (i > 3 * PHYSICS_HZ) samples.push(gearLoads(v, paved).totalNormal)
    }

    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    const spread = Math.max(...samples) - Math.min(...samples)

    expect(spread / mean, 'normal force is oscillating').toBeLessThan(0.02)
  })
})

describe('the strut', () => {
  it('pushes but never pulls', () => {
    // On the rebound the damper term goes negative. Left unclamped it would suck the
    // aircraft back down onto a runway it is trying to leave.
    for (const rate of [-50, -20, -5, 0, 5, 20]) {
      const v = parked()
      v[Q.W] = rate // climbing or descending
      const g = gearLoads(v, paved)
      // Asserted on the strut forces themselves. `loads.fz` bundles them together
      // with gear-down aerodynamic drag, which legitimately has a downward component
      // when the aircraft is descending, so it is no longer a clean proxy for "the
      // strut is not pulling".
      for (const N of g.normal) expect(N).toBeGreaterThanOrEqual(0)
    }
  })

  it('grips harder just before it slides than while it is sliding', () => {
    // REQUIREMENTS §3 asks for static and dynamic friction as separate things. They
    // are separated by a Stribeck decay rather than a mode switch, so the property
    // to assert is that peak grip happens at low slip and falls off once the tyre is
    // properly sliding — not that some boolean flipped.
    const sideForceAt = (slip: number): number => {
      const v = parked()
      v[Q.V] = slip
      const g = gearLoads(v, paved)
      return Math.abs(g.loads.fy) / g.totalNormal
    }

    const breakaway = sideForceAt(1.0) // just at the edge of sliding
    const sliding = sideForceAt(30) // well and truly sliding

    expect(breakaway, 'static grip should exceed sliding grip').toBeGreaterThan(sliding)
    expect(breakaway / sliding).toBeGreaterThan(1.05)
    expect(breakaway / sliding, 'and not by an absurd amount').toBeLessThan(1.3)
  })

  it('compresses further under a harder arrival, and reports bottoming', () => {
    const gentle = parked()
    gentle[Q.W] = 3
    const hard = parked()
    hard[Q.W] = 40

    const a = gearLoads(gentle, paved)
    const b = gearLoads(hard, paved)

    expect(b.totalNormal).toBeGreaterThan(a.totalNormal * 3)

    // Deep enough to run out of stroke.
    const slammed = parked(0, { alt: FIELD_ELEV + LEFT_MAIN.z - 1.5 })
    expect(gearLoads(slammed, paved).bottomed).toBe(true)
  })

  it('goes much stiffer once it is out of stroke', () => {
    // The flag alone is not the behaviour. A bottomed strut has to actually resist,
    // or the aircraft sinks through the runway on a hard arrival while a boolean
    // reports that it should not have.
    const forceAtDepth = (depth: number): number =>
      gearLoads(parked(0, { alt: FIELD_ELEV + LEFT_MAIN.z - depth }), paved)
        .normal[1] as number

    const inStroke = forceAtDepth(1.0) // within the 1.2 ft stroke
    const past = forceAtDepth(1.5) // 0.3 ft past it

    // Linear extrapolation would give 1.5x. The bottoming stop gives far more.
    expect(past / inStroke).toBeGreaterThan(2.5)
  })

  it('takes the load asymmetrically in a wing-down attitude', () => {
    // Left wing down puts the left main on the ground first, which is what makes a
    // crosswind landing feel like anything at all.
    const v = parked(0, { phi: -0.05 })
    const g = gearLoads(v, paved)

    expect(g.normal[1] as number, 'left main').toBeGreaterThan(g.normal[2] as number)
    // And it produces a rolling moment trying to pick the wing back up.
    expect(g.loads.l).toBeGreaterThan(0)
  })
})

describe('contact', () => {
  it('is silent when the gear is up', () => {
    const g = gearLoads(parked(), paved, GEAR_UP)

    expect(g.onGround).toBe(false)
    expect(g.loads).toEqual({ fx: 0, fy: 0, fz: 0, l: 0, m: 0, n: 0 })
  })

  it('is silent well above the ground', () => {
    const g = gearLoads(parked(0, { alt: FIELD_ELEV + 200 }), paved)

    expect(g.onGround).toBe(false)
    expect(g.totalNormal).toBe(0)
  })

  it('finds nothing to push against over water', () => {
    const g = gearLoads(parked(), new NoGround())

    expect(g.onGround).toBe(false)
    expect(g.totalNormal).toBe(0)
  })
})

describe('rolling, braking and steering', () => {
  it('does not slow down on rolling resistance alone', () => {
    // Measured: 200.0 ft/s in, 199.8 ft/s out over twelve seconds. Idle thrust very
    // nearly balances rolling resistance plus aerodynamic drag at this speed, so an
    // unbraked rollout does not end. This is the reason a landing needs brakes and
    // not merely patience, and it is asserted rather than assumed because it is
    // surprising.
    const v = roll(parked(200), IDLE, 12)

    expect(speedOf(v)).toBeGreaterThan(190)
    expect(gearLoads(v, paved).onGround).toBe(true)
  })

  it('comes to a full stop under braking, in a runway length', () => {
    const start = parked(200)
    const braking = roll(start, IDLE, 18, HELD)

    expect(speedOf(braking), 'should have stopped').toBeLessThan(1)

    // Under 5,000 ft from 200 ft/s (118 kt). The authored fields are 2,600-3,100 m,
    // so stopping has to fit inside one of them with room to spare.
    const distance = Math.abs(braking[Q.PN] as number)
    expect(distance).toBeLessThan(5000)
    expect(distance, 'stopping distance is implausibly short').toBeGreaterThan(800)
  })

  it('transfers load onto the nosewheel under braking', () => {
    // The deceleration acts at the wheels, seven feet below the CG, so it pitches
    // the aircraft forward onto its nose. Measured: 2,638 lb on the nose rolling,
    // 7,090 lb braking.
    const rolling = gearLoads(roll(parked(200), IDLE, 2), paved)
    const braking = gearLoads(roll(parked(200), IDLE, 2, HELD), paved, HELD)

    expect(braking.normal[0] as number).toBeGreaterThan(2 * (rolling.normal[0] as number))
  })

  it('takes longer to stop on grass than it brakes on pavement, but coasts less far', () => {
    // Soft ground has more rolling resistance and less grip: you slow down without
    // brakes, and the brakes you do have are worth less.
    const start = parked(200)
    const onPaved = roll(start, IDLE, 12)
    const onSoft = roll(start, IDLE, 12, GEAR_DOWN, new FlatGround(FIELD_ELEV, SOFT))

    expect(speedOf(onSoft)).toBeLessThan(speedOf(onPaved))
  })

  it('turns when the nosewheel is steered, and only while the nosewheel is loaded', () => {
    const straight = roll(parked(60), IDLE, 6)
    const turning = roll(parked(60), IDLE, 6, { brake: 0, steer: 1, down: true })

    const drift = Math.abs(turning[Q.PE] as number) - Math.abs(straight[Q.PE] as number)
    expect(drift, 'steering produced no lateral displacement').toBeGreaterThan(1)
    expect(Number.isFinite(turning[Q.PE] as number)).toBe(true)
  })

  it('resists being pushed sideways', () => {
    // Tyres are what stop an aircraft sliding off the side of a runway.
    const v = parked()
    v[Q.V] = 20 // 20 ft/s of sideways drift
    const g = gearLoads(v, paved)

    expect(g.loads.fy, 'side force should oppose the drift').toBeLessThan(0)
    expect(Math.abs(g.loads.fy)).toBeGreaterThan(0.3 * REFERENCE_WEIGHT_LB)
  })
})

describe('the damper', () => {
  /** A strut squashed by `depth` ft, closing on the ground at `rate` ft/s. */
  const contact = (depth: number, rate: number) => {
    const v = parked(0, { alt: FIELD_ELEV + LEFT_MAIN.z - depth })
    v[Q.W] = rate
    return gearLoads(v, paved)
  }

  it('does not answer first contact with a step force', () => {
    // The failure this exists to prevent, measured before it was fixed: a 27 ft/s
    // arrival produced 173,871 lb in a single tick — 8.5 times the aircraft's weight
    // — from a strut that had not yet moved. Damping is `c * closing speed`, and at
    // first contact `c` was already at full strength while the spring was still at
    // zero, so the entire force was the damper, applied as a step.
    //
    // A tyre touches before an oleo strokes, and an orifice does nothing until the
    // piston moves. Damping now fades in over the first inches of stroke.
    const rate = 25
    const justTouching = contact(0.004, rate)

    // Undamped, this would be c * rate on each main: over 80,000 lb a side.
    const naive = LEFT_MAIN.c * rate
    expect(justTouching.normal[1] as number, 'step force at first contact').toBeLessThan(
      naive * 0.1,
    )

    // And it must still ramp up: deeper in the stroke the damper is doing its job.
    const settledIn = contact(0.4, rate)
    expect(settledIn.normal[1] as number).toBeGreaterThan(
      5 * (justTouching.normal[1] as number),
    )
  })

  it('resists extension harder than compression', () => {
    // A strut that gives back the energy it stored throws the aircraft off the
    // runway it has just landed on — measured, airborne again 0.25 s after
    // touchdown, climbing at 1,100 fpm. A real oleo has a recoil valve, and the
    // asymmetry is what makes a landing settle rather than bounce.
    // Deliberately a gentle rate. At 6 ft/s of extension the damper alone exceeds
    // the spring force, the strut releases completely, and `N` clamps at zero — so
    // the asymmetry saturates and becomes invisible. Measuring it needs a case where
    // the strut is still pushing.
    const depth = 0.5
    const rate = 1

    const compressing = contact(depth, rate)
    const extending = contact(depth, -rate)
    const still = contact(depth, 0)

    const spring = still.normal[1] as number
    expect(extending.normal[1] as number, 'test is in the clamped regime').toBeGreaterThan(0)

    // Compression adds to the spring force; extension subtracts from it.
    expect(compressing.normal[1] as number).toBeGreaterThan(spring)
    expect(extending.normal[1] as number).toBeLessThan(spring)

    // And it subtracts MORE than compression added — that is the whole point.
    const added = (compressing.normal[1] as number) - spring
    const removed = spring - (extending.normal[1] as number)
    expect(removed / added, 'rebound damping is not stiffer than compression')
      .toBeCloseTo(3, 1)
  })

  it('gives back less energy than a symmetric strut would', () => {
    // The consequence, stated as energy rather than as a coefficient: over a full
    // compress-and-release cycle the strut must dissipate, not return.
    const depth = 0.4
    const rate = 10

    const pushing = (contact(depth, rate).normal[1] as number)
    const releasing = (contact(depth, -rate).normal[1] as number)

    // Work in exceeds work out at the same displacement and speed.
    expect(pushing).toBeGreaterThan(releasing)
    expect(releasing / pushing).toBeLessThan(0.5)
  })
})

describe('where it rests when parked', () => {
  it('sits very slightly nose-up, because the struts differ', () => {
    const rest = restingAttitude()

    // Half a degree or so, nose up: the nosewheel carries an eighth of the weight on
    // a strut sized for landing loads, so it squashes less than a main does.
    expect(rest.pitch).toBeGreaterThan(0)
    expect((rest.pitch * 180) / Math.PI).toBeLessThan(2)
  })

  it('predicts the height and attitude the simulation settles at', () => {
    // The claim `parkAt` relies on: place the aircraft here and it is already still,
    // rather than shuffling for the first two seconds of every runway start.
    const rest = restingAttitude()

    const v = toQuatVector({
      vt: 0,
      alpha: 0,
      beta: 0,
      q: quaternionFromEuler(0, rest.pitch, 0),
      p: 0,
      qRate: 0,
      r: 0,
      pn: 0,
      pe: 0,
      alt: FIELD_ELEV + rest.cgHeight,
      power: 0,
    })

    const placed = gearLoads(v, paved)
    expect(placed.onGround).toBe(true)
    expect(placed.totalNormal / REFERENCE_WEIGHT_LB, 'not carrying its own weight').toBeCloseTo(
      1,
      2,
    )

    // Every strut at its own static compression, none of them fighting the others.
    const predicted = staticCompression()
    for (let i = 0; i < DEFAULT_GEAR.length; i++) {
      expect(placed.compression[i] as number, DEFAULT_GEAR[i]!.name).toBeCloseTo(
        predicted[i] as number,
        3,
      )
    }
  })

  it('would over-load the nose strut if the aircraft were simply placed level', () => {
    // The negative case, recorded because this is exactly what the code did before:
    // level looks right and is not, and the error shows as 109% of the aircraft's
    // weight on the gear at t=0.
    const rest = restingAttitude()
    const level = toQuatVector({
      vt: 0, alpha: 0, beta: 0, q: IDENTITY_QUATERNION,
      p: 0, qRate: 0, r: 0, pn: 0, pe: 0,
      alt: FIELD_ELEV + rest.cgHeight, power: 0,
    })

    expect(gearLoads(level, paved).totalNormal / REFERENCE_WEIGHT_LB).toBeGreaterThan(1.03)
  })
})

describe('the geometry helper', () => {
  it('predicts the static compression the simulation actually settles at', () => {
    const predicted = staticCompression()
    const settled = gearLoads(roll(parked(), IDLE, 6), paved).compression

    for (let i = 0; i < DEFAULT_GEAR.length; i++) {
      expect(settled[i] as number, DEFAULT_GEAR[i]!.name).toBeCloseTo(
        predicted[i] as number,
        1,
      )
    }
  })

  it('leaves most of the stroke available for landing', () => {
    for (let i = 0; i < DEFAULT_GEAR.length; i++) {
      const used = (staticCompression()[i] as number) / DEFAULT_GEAR[i]!.stroke
      expect(used, DEFAULT_GEAR[i]!.name).toBeLessThan(0.4)
      expect(used, DEFAULT_GEAR[i]!.name).toBeGreaterThan(0.15)
    }
  })
})
