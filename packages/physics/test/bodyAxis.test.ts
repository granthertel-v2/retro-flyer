/**
 * Body-axis velocity state: equivalence in the air, survival on the ground.
 *
 * `state.ts` integrates `u, v, w` where the reference model integrates
 * `vt, alpha, beta`. That is a change to the thing the simulation actually flies,
 * so it needs the same treatment quaternion attitude got: prove the two agree
 * everywhere the old one worked, and prove the new one works where the old one
 * could not.
 *
 * The Tier A golden vectors do not cover this. They validate `derivative()`, which
 * is untouched and still wind-axis. This file is what covers the tail that replaced
 * it.
 */

import { describe, expect, it } from 'vitest'
import {
  IDENTITY_QUATERNION,
  Q,
  aeroAngles,
  bodyVelocity,
  eulerFromQuaternion,
  fromQuatVector,
  quatDerivative,
  quaternionFromEuler,
  toQuatVector,
  toStateVector,
} from '../src/state.js'
import { S, derivative, forcesAndMoments, type Controls } from '../src/dynamics.js'
import { PHYSICS_DT, PHYSICS_HZ, step } from '../src/integrator.js'
import { computeMassProperties } from '../src/massProperties.js'
import { REFERENCE_WEIGHT_LB } from '../src/massProperties.js'
import { RAD_PER_DEG, G_FT_S2 } from '../src/units.js'
import { trim, trimControls } from '../src/trim.js'

const level = (alt: number, vt: number) => {
  const r = trim({ alt, vt })
  return { v: toQuatVector(fromStateOf(r.state)), u: trimControls(r) }
}

// Local helper so this file does not depend on the order of trim's state layout.
function fromStateOf(x: readonly number[]) {
  return {
    vt: x[S.VT] as number,
    alpha: x[S.ALPHA] as number,
    beta: x[S.BETA] as number,
    q: quaternionFromEuler(x[S.PHI] as number, x[S.THETA] as number, x[S.PSI] as number),
    p: x[S.P] as number,
    qRate: x[S.Q] as number,
    r: x[S.R] as number,
    pn: x[S.PN] as number,
    pe: x[S.PE] as number,
    alt: x[S.ALT] as number,
    power: x[S.POWER] as number,
  }
}

/** RK4 on the reference's Euler wind-axis state, for a like-for-like comparison. */
function rk4Wind(x: number[], u: Controls, dt: number): number[] {
  const f = (s: number[]): number[] => derivative(s, u, undefined, { clampAeroAngles: true }).xd
  const addv = (a: number[], b: number[], sc: number): number[] =>
    a.map((val, i) => val + (b[i] as number) * sc)
  const k1 = f(x)
  const k2 = f(addv(x, k1, dt / 2))
  const k3 = f(addv(x, k2, dt / 2))
  const k4 = f(addv(x, k3, dt))
  return x.map(
    (val, i) =>
      val +
      (dt / 6) *
        ((k1[i] as number) + 2 * (k2[i] as number) + 2 * (k3[i] as number) + (k4[i] as number)),
  )
}

describe('the conversion between velocity representations', () => {
  it('round-trips exactly, over the whole flight envelope', () => {
    for (const vt of [120, 300, 500, 900]) {
      for (const alphaDeg of [-9, 0, 5, 20, 44]) {
        for (const betaDeg of [-29, -5, 0, 12, 29]) {
          const alpha = alphaDeg * RAD_PER_DEG
          const beta = betaDeg * RAD_PER_DEG

          const [u, v, w] = bodyVelocity(vt, alpha, beta)
          const back = aeroAngles(u, v, w)

          expect(back.vt).toBeCloseTo(vt, 9)
          expect(back.alpha).toBeCloseTo(alpha, 12)
          expect(back.beta).toBeCloseTo(beta, 12)
        }
      }
    }
  })

  it('answers zero for both angles at a standstill rather than NaN', () => {
    // A cold start on a runway hits this on tick one. `asin(0/0)` is NaN, and a NaN
    // here reaches every other state within a single step.
    const a = aeroAngles(0, 0, 0)

    expect(a.vt).toBe(0)
    expect(a.alpha).toBe(0)
    expect(a.beta).toBe(0)
    expect(Number.isFinite(a.alpha)).toBe(true)
  })

  it('keeps alpha inside one turn by construction, at any body velocity', () => {
    // The Day 2 tumble bug cannot be reproduced because it cannot be represented.
    for (const u of [-800, -1, 0, 1, 800]) {
      for (const w of [-800, -1, 0, 1, 800]) {
        const a = aeroAngles(u, 0, w)
        expect(Math.abs(a.alpha)).toBeLessThanOrEqual(Math.PI + 1e-12)
      }
    }
  })
})

describe('body axes and wind axes agree in flight', () => {
  const HARD: Controls = { throttle: 0.7, elevator: -4, aileron: -8, rudder: 2 }

  const flyBoth = (
    alt: number,
    vt: number,
    u: Controls,
    seconds: number,
  ): { body: number[]; wind: number[] } => {
    const { v: start } = level(alt, vt)
    let body = start
    let wind = toStateVector(fromQuatVector(start))

    for (let i = 0; i < Math.round(seconds * PHYSICS_HZ); i++) {
      body = step(body, u)
      wind = rk4Wind(wind, u, PHYSICS_DT)
    }
    return { body, wind }
  }

  const vtOf = (body: number[]): number =>
    aeroAngles(body[Q.U] as number, body[Q.V] as number, body[Q.W] as number).vt

  it('agrees to machine precision on the very first step', () => {
    // This is the structural claim, and it is the one that can be asserted tightly.
    // If the two tails disagreed about anything — a sign, a term, an ordering — it
    // would be visible here at 1e-3, not at 1e-13. Everything downstream is this
    // agreement plus integration.
    const { body, wind } = flyBoth(10000, 500, HARD, PHYSICS_DT)

    expect(Math.abs(vtOf(body) / (wind[S.VT] as number) - 1)).toBeLessThan(1e-11)
    expect(
      Math.abs(
        aeroAngles(body[Q.U] as number, body[Q.V] as number, body[Q.W] as number).alpha -
          (wind[S.ALPHA] as number),
      ),
    ).toBeLessThan(1e-12)
  })

  it('stays together through 30 seconds of trimmed flight', () => {
    // A long, benign trajectory: no chaos to amplify, so the disagreement stays at
    // the level of floating-point noise for the whole run. Measured 2.9e-14.
    const { v: start, u } = level(10000, 500)
    let body = start
    let wind = toStateVector(fromQuatVector(start))

    for (let i = 0; i < 30 * PHYSICS_HZ; i++) {
      body = step(body, u)
      wind = rk4Wind(wind, u, PHYSICS_DT)
    }

    expect(Math.abs(vtOf(body) / (wind[S.VT] as number) - 1)).toBeLessThan(1e-11)
    expect((body[Q.ALT] as number) - (wind[S.ALT] as number)).toBeCloseTo(0, 6)
    expect((body[Q.PN] as number) / (wind[S.PN] as number)).toBeCloseTo(1, 9)
  })

  it('stays together through three-axis maneuvering inside the data envelope', () => {
    // Rolling and pulling at once, but kept short enough that the aircraft is still
    // an aeroplane rather than a tumbling brick — see the divergence test below for
    // why that distinction is the one that matters.
    const { body, wind } = flyBoth(10000, 500, HARD, 4)

    const a = aeroAngles(body[Q.U] as number, body[Q.V] as number, body[Q.W] as number)
    const att = eulerFromQuaternion([
      body[Q.QW] as number,
      body[Q.QX] as number,
      body[Q.QY] as number,
      body[Q.QZ] as number,
    ])

    expect(Math.abs(a.vt / (wind[S.VT] as number) - 1)).toBeLessThan(1e-8)
    expect(a.alpha - (wind[S.ALPHA] as number)).toBeCloseTo(0, 8)
    expect(a.beta - (wind[S.BETA] as number)).toBeCloseTo(0, 8)
    expect(att.theta - (wind[S.THETA] as number)).toBeCloseTo(0, 8)
    expect(att.phi - (wind[S.PHI] as number)).toBeCloseTo(0, 8)
    expect((body[Q.ALT] as number) - (wind[S.ALT] as number)).toBeCloseTo(0, 4)
  })

  it('agrees at every trim point in the §4.2 table', () => {
    const points: [number, number][] = [
      [0, 500],
      [10000, 500],
      [20000, 600],
      [30000, 700],
      [10000, 300],
      [10000, 900],
    ]

    for (const [alt, vt] of points) {
      const { v: start, u } = level(alt, vt)
      let body = start
      let wind = toStateVector(fromQuatVector(start))

      for (let i = 0; i < 5 * PHYSICS_HZ; i++) {
        body = step(body, u)
        wind = rk4Wind(wind, u, PHYSICS_DT)
      }

      const a = aeroAngles(body[Q.U] as number, body[Q.V] as number, body[Q.W] as number)
      expect(a.vt / (wind[S.VT] as number), `vt at ${alt} ft / ${vt} ft/s`).toBeCloseTo(1, 7)
      expect(a.alpha - (wind[S.ALPHA] as number), `alpha at ${alt} ft`).toBeCloseTo(0, 7)
    }
  })

  it('diverges over a long tumble because the aircraft is chaotic, not because the models are', () => {
    // Recorded deliberately, so that nobody later "fixes" a failing long-run
    // comparison by loosening the tight tests above.
    //
    // Held at full three-axis deflection the aircraft departs: alpha reaches 99
    // degrees by five seconds and -114 by ten, well outside the data envelope, on
    // the clamped guard path. That trajectory has a positive Lyapunov exponent, so
    // a difference of one machine epsilon doubles until it is the whole answer.
    // Measured, on this trajectory:
    //
    //     t = 0.01 s   2.4e-13     t = 10 s   4.9e-3
    //     t = 1 s      8.2e-12     t = 20 s   6.4e-2
    //     t = 5 s      2.2e-10     t = 30 s   3.1e-1
    //
    // The seed is machine precision — which is the proof the formulations agree —
    // and the growth is the aeroplane, not the arithmetic. A formulation error
    // would show at t = 0.01 s, and it does not.
    const early = flyBoth(10000, 500, HARD, 1)
    const late = flyBoth(10000, 500, HARD, 30)

    const errEarly = Math.abs(vtOf(early.body) / (early.wind[S.VT] as number) - 1)
    const errLate = Math.abs(vtOf(late.body) / (late.wind[S.VT] as number) - 1)

    expect(errEarly, 'one second in, the two are the same model').toBeLessThan(1e-9)
    expect(errLate, 'thirty seconds in, the tumble has amplified it').toBeGreaterThan(1e-3)

    // And confirm the premise: this really is outside the envelope, not ordinary
    // flight that happens to disagree.
    const a = aeroAngles(late.body[Q.U] as number, late.body[Q.V] as number, late.body[Q.W] as number)
    expect(Math.abs(a.alpha) / RAD_PER_DEG).toBeGreaterThan(45)
  })
})

describe('only the body-axis form survives ground speeds', () => {
  it('measures the 1/vt blow-up in the wind-axis alpha rate', () => {
    // The reason for the whole change, as a number rather than an argument. This is
    // gravity alone — no gear force at all — and it is the term the struts will be
    // multiplied by.
    const alphaDotAt = (vt: number): number => {
      const x = new Array<number>(13).fill(0)
      x[S.VT] = vt
      x[S.ALPHA] = 0.03
      x[S.ALT] = 100
      x[S.POWER] = 10
      return derivative(x, { throttle: 0.2, elevator: 0, aileron: 0, rudder: 0 }, undefined, {
        clampAeroAngles: true,
      }).xd[S.ALPHA] as number
    }

    const fast = Math.abs(alphaDotAt(500))
    const slow = Math.abs(alphaDotAt(1))

    // Inverse in airspeed: 500x slower means ~500x the rate.
    expect(slow / fast).toBeGreaterThan(400)
    // And in absolute terms it is past any rate a 120 Hz tick can integrate: more
    // than 10 degrees of alpha in one step.
    expect(slow / RAD_PER_DEG / PHYSICS_HZ).toBeGreaterThan(10)
  })

  it('keeps the body-axis accelerations bounded at the same conditions', () => {
    // Same flight conditions, same forces, different state variable. The body
    // accelerations are a few g at every speed, because they are just F/m.
    for (const vt of [500, 100, 20, 5, 1, 0]) {
      const v = toQuatVector({
        vt,
        alpha: 0.03,
        beta: 0,
        q: IDENTITY_QUATERNION,
        p: 0,
        qRate: 0,
        r: 0,
        pn: 0,
        pe: 0,
        alt: 100,
        power: 10,
      })

      const d = quatDerivative(v, { throttle: 0.2, elevator: 0, aileron: 0, rudder: 0 })

      for (const value of d.vd) expect(Number.isFinite(value)).toBe(true)
      expect(Math.abs(d.vd[Q.W] as number) / G_FT_S2, `wdot at ${vt} ft/s`).toBeLessThan(4)
      expect(Math.abs(d.vd[Q.U] as number) / G_FT_S2, `udot at ${vt} ft/s`).toBeLessThan(4)
    }
  })

  it('integrates from a dead standstill without producing a NaN', () => {
    // Not a realistic flight condition — it is the runway, on tick one, before the
    // gear exists. The old formulation cannot take this step at all.
    let v = toQuatVector({
      vt: 0,
      alpha: 0,
      beta: 0,
      q: IDENTITY_QUATERNION,
      p: 0,
      qRate: 0,
      r: 0,
      pn: 0,
      pe: 0,
      alt: 500,
      power: 0,
    })

    for (let i = 0; i < PHYSICS_HZ; i++) {
      v = step(v, { throttle: 0, elevator: 0, aileron: 0, rudder: 0 })
    }

    for (const value of v) expect(Number.isFinite(value)).toBe(true)

    // One second of free fall from rest: it should be doing about 32 ft/s downward
    // and have lost about 16 ft. Falling, not flying — but arithmetically sound.
    const a = aeroAngles(v[Q.U] as number, v[Q.V] as number, v[Q.W] as number)
    expect(a.vt).toBeGreaterThan(25)
    expect(a.vt).toBeLessThan(35)
    expect(500 - (v[Q.ALT] as number)).toBeGreaterThan(10)
  })
})

describe('the external loads seam', () => {
  const flight = () => {
    const { v, u } = level(10000, 500)
    return { v, u }
  }

  it('is exactly inert when the loads are zero', () => {
    // The claim that lets `derivative()` stay the reference model. Adding zero is
    // exact in IEEE 754, and this asserts it rather than assuming it.
    const { v, u } = flight()

    const without = quatDerivative(v, u)
    const withZero = quatDerivative(v, u, undefined, { clampAeroAngles: true }, {
      fx: 0, fy: 0, fz: 0, l: 0, m: 0, n: 0,
    })

    for (let i = 0; i < without.vd.length; i++) {
      expect(withZero.vd[i]).toBe(without.vd[i])
    }
    expect(withZero.accel.nz).toBe(without.accel.nz)
  })

  it('supports the aircraft against gravity when given the weight as an up force', () => {
    // Body z is down, so "up" is negative. This is what a settled landing gear does,
    // and it is the shape of the force the strut model has to produce.
    const v = toQuatVector({
      vt: 0, alpha: 0, beta: 0, q: IDENTITY_QUATERNION,
      p: 0, qRate: 0, r: 0, pn: 0, pe: 0, alt: 500, power: 0,
    })
    const u: Controls = { throttle: 0, elevator: 0, aileron: 0, rudder: 0 }

    const free = quatDerivative(v, u)
    const held = quatDerivative(v, u, undefined, { clampAeroAngles: true }, {
      fx: 0, fy: 0, fz: -REFERENCE_WEIGHT_LB, l: 0, m: 0, n: 0,
    })

    // Unsupported it accelerates downward at one g; supported it does not move.
    //
    // Not to the last bit, and the residual is worth naming: at a standstill the
    // aero lookup runs at the 1 ft/s airspeed floor, where dynamic pressure is
    // 0.0012 psf and the whole aeroplane generates about 0.035 lb of lift — 1.7e-6
    // of a g on a 20,500 lb aircraft. That is the floor's docstring claim ("below
    // the floor, dynamic pressure is effectively zero") as a measured number.
    expect((free.vd[Q.W] as number) / G_FT_S2).toBeCloseTo(1, 4)
    expect(Math.abs(held.vd[Q.W] as number) / G_FT_S2).toBeLessThan(1e-5)

    // And the accelerometer reads what a pilot parked on a runway reads: 1 g.
    expect(held.accel.nz + 1).toBeCloseTo(1, 4)
    expect(free.accel.nz + 1).toBeCloseTo(0, 4)
  })

  it('turns an external pitching moment into pitch acceleration', () => {
    const { v, u } = flight()
    const mass = computeMassProperties()

    const before = quatDerivative(v, u, mass)
    const applied = 20000 // ft-lb, nose up
    const after = quatDerivative(v, u, mass, { clampAeroAngles: true }, {
      fx: 0, fy: 0, fz: 0, l: 0, m: applied, n: 0,
    })

    const delta = (after.vd[Q.Q_RATE] as number) - (before.vd[Q.Q_RATE] as number)
    expect(delta).toBeCloseTo(mass.moments.c7 * applied, 12)
    expect(delta).toBeGreaterThan(0)
  })

  it('routes roll and yaw moments through the same inertia coupling as the aero ones', () => {
    const { v, u } = flight()
    const mass = computeMassProperties()
    const { c3, c4, c9 } = mass.moments

    const before = quatDerivative(v, u, mass)
    const l = 15000
    const n = -9000
    const after = quatDerivative(v, u, mass, { clampAeroAngles: true }, {
      fx: 0, fy: 0, fz: 0, l, m: 0, n,
    })

    expect((after.vd[Q.P] as number) - (before.vd[Q.P] as number)).toBeCloseTo(c3 * l + c4 * n, 12)
    expect((after.vd[Q.R] as number) - (before.vd[Q.R] as number)).toBeCloseTo(c4 * l + c9 * n, 12)
  })

  it('leaves the shared force model reachable directly, for the gear model to test against', () => {
    // `forcesAndMoments` is the seam gear forces arrive through; this pins its shape.
    const core = forcesAndMoments(
      {
        uBody: 500, vBody: 0, wBody: 15, vt: 500.2,
        alphaDeg: 1.7, betaDeg: 0,
        phi: 0, theta: 0.03, psi: 0,
        p: 0, q: 0, r: 0,
        alt: 10000, power: 40,
      },
      { throttle: 0.5, elevator: -1, aileron: 0, rudder: 0 },
    )

    for (const value of Object.values(core)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true)
    }
    expect(Number.isFinite(core.accel.nz)).toBe(true)
  })
})
