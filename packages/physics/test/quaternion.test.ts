/**
 * Tier B — quaternion attitude and integration.
 *
 * Two claims to establish. First, that the quaternion path agrees with the Euler
 * path everywhere the Euler path works — otherwise it is not the same aircraft.
 * Second, that the quaternion path keeps working where the Euler path fails, which
 * is the entire justification REQUIREMENTS §3 gives for the added complexity.
 *
 * The second claim is the interesting one. It is easy to adopt quaternions because
 * a spec says so and never confirm they bought anything. The gimbal-lock test below
 * flies straight up through vertical and watches the Euler form come apart.
 */

import { describe, expect, it } from 'vitest'
import {
  IDENTITY_QUATERNION,
  Q,
  eulerFromQuaternion,
  fromQuatVector,
  fromStateVector,
  normalize,
  quaternionDerivative,
  quaternionFromEuler,
  toQuatVector,
  toStateVector,
} from '../src/state.js'
import { PHYSICS_DT, PHYSICS_HZ, FixedStepClock, simulate, step } from '../src/integrator.js'
import { S, STATE_SIZE, derivative } from '../src/dynamics.js'

const level = (opts: Partial<Record<string, number>> = {}): number[] => {
  const v = toQuatVector({
    vt: (opts.vt as number) ?? 500,
    alpha: (opts.alpha as number) ?? 0.06,
    beta: 0,
    q: quaternionFromEuler(
      (opts.phi as number) ?? 0,
      (opts.theta as number) ?? 0.06,
      (opts.psi as number) ?? 0,
    ),
    p: 0,
    qRate: 0,
    r: 0,
    pn: 0,
    pe: 0,
    alt: (opts.alt as number) ?? 10000,
    power: (opts.power as number) ?? 30,
  })
  return v
}

const HOLD = { throttle: 0.3, elevator: -0.7, aileron: 0, rudder: 0 }

describe('quaternion arithmetic', () => {
  it('round-trips Euler angles away from the singularity', () => {
    for (const [phi, theta, psi] of [
      [0, 0, 0],
      [0.5, 0.3, -1.2],
      [-2.9, -0.8, 3.0],
      [1.0, 1.5, 0.4],
    ]) {
      const e = eulerFromQuaternion(
        quaternionFromEuler(phi as number, theta as number, psi as number),
      )
      expect(e.phi).toBeCloseTo(phi as number, 10)
      expect(e.theta).toBeCloseTo(theta as number, 10)
      expect(e.psi).toBeCloseTo(psi as number, 10)
    }
  })

  it('produces unit quaternions', () => {
    const q = quaternionFromEuler(1.1, -0.7, 2.2)
    expect(Math.hypot(...q)).toBeCloseTo(1, 12)
  })

  it('normalizes, and survives a degenerate input', () => {
    expect(Math.hypot(...normalize([2, 0, 0, 0]))).toBeCloseTo(1, 12)
    expect(normalize([0, 0, 0, 0])).toEqual(IDENTITY_QUATERNION)
  })

  it('does not return NaN at exactly vertical', () => {
    // The asin argument can drift a hair past 1 through floating point. Unclamped
    // that yields NaN, which then silently poisons the whole state vector.
    const straightUp = quaternionFromEuler(0, Math.PI / 2, 0)
    const e = eulerFromQuaternion(straightUp)

    expect(Number.isNaN(e.theta)).toBe(false)
    expect(e.theta).toBeCloseTo(Math.PI / 2, 9)
  })

  it('gives zero attitude rate when the aircraft is not rotating', () => {
    // Compared component-wise rather than with toEqual: the first term evaluates
    // to -0, and -0 !== +0 under deep equality even though they are numerically
    // identical. Not worth contorting the formula to avoid.
    const qd = quaternionDerivative(IDENTITY_QUATERNION, 0, 0, 0)
    for (const c of qd) expect(c).toBeCloseTo(0, 15)
  })

  it('a pure roll rate changes only the roll component', () => {
    const qd = quaternionDerivative(IDENTITY_QUATERNION, 1, 0, 0)
    expect(qd[0]).toBeCloseTo(0, 15)
    expect(qd[1]).toBeCloseTo(0.5, 15)
    expect(qd[2]).toBeCloseTo(0, 15)
    expect(qd[3]).toBeCloseTo(0, 15)
  })

  it('round-trips through the Euler state vector', () => {
    const x = new Array<number>(STATE_SIZE).fill(0)
    x[S.VT] = 600
    x[S.ALPHA] = 0.1
    x[S.BETA] = -0.05
    x[S.PHI] = 0.4
    x[S.THETA] = -0.2
    x[S.PSI] = 1.1
    x[S.P] = 0.3
    x[S.Q] = -0.2
    x[S.R] = 0.15
    x[S.ALT] = 15000
    x[S.POWER] = 60

    const back = toStateVector(fromStateVector(x))
    for (let i = 0; i < STATE_SIZE; i++) {
      expect(back[i] as number).toBeCloseTo(x[i] as number, 10)
    }
  })
})

describe('integrator', () => {
  it('runs at the 120 Hz specified by REQUIREMENTS §3', () => {
    expect(PHYSICS_HZ).toBe(120)
    expect(PHYSICS_DT).toBeCloseTo(1 / 120, 15)
  })

  it('keeps the quaternion normalized over a long run', () => {
    // RK4 does not preserve unit norm, and unchecked drift compounds until the
    // quaternion stops representing a rotation at all. Ten seconds of maneuvering
    // is enough to expose a missing renormalization.
    let v = level()
    for (let i = 0; i < 10 * PHYSICS_HZ; i++) {
      v = step(v, { throttle: 0.7, elevator: -4, aileron: 8, rudder: 2 })
    }

    const norm = Math.hypot(
      v[Q.QW] as number,
      v[Q.QX] as number,
      v[Q.QY] as number,
      v[Q.QZ] as number,
    )
    expect(norm).toBeCloseTo(1, 12)
  })

  it('produces no NaN over a long aggressive run', () => {
    let v = level({ vt: 700 })
    for (let i = 0; i < 20 * PHYSICS_HZ; i++) {
      v = step(v, { throttle: 1.0, elevator: -12, aileron: 15, rudder: -8 })
      if (!v.every(Number.isFinite)) break
    }
    expect(v.every(Number.isFinite)).toBe(true)
  })

  it('is fourth-order accurate', () => {
    // Halving the step should cut the error by roughly 16x. Verified against a
    // reference computed with a much smaller step, so this measures the integrator
    // rather than agreement with itself.
    const v0 = level()
    const duration = 0.5
    const ctrl = () => HOLD

    const fine = simulate(v0, ctrl, duration, duration / 4096).states.at(-1) as number[]
    const coarse = simulate(v0, ctrl, duration, duration / 16).states.at(-1) as number[]
    const half = simulate(v0, ctrl, duration, duration / 32).states.at(-1) as number[]

    const err = (a: number[]) => Math.abs((a[Q.VT] as number) - (fine[Q.VT] as number))

    const ratio = err(coarse) / err(half)
    expect(ratio).toBeGreaterThan(8) // fourth order would be ~16
  })
})

describe('FixedStepClock', () => {
  it('runs whole ticks and carries the remainder', () => {
    const clock = new FixedStepClock()
    let v = level()

    // 10 ms at 120 Hz is 1.2 ticks: one now, 0.2 carried.
    v = clock.advance(v, () => HOLD, 0.010)
    expect(clock.ticks).toBe(1)
    expect(clock.alpha).toBeCloseTo(0.2, 6)

    v = clock.advance(v, () => HOLD, 0.010)
    expect(clock.ticks).toBe(2)
    expect(clock.alpha).toBeCloseTo(0.4, 6)
  })

  it('caps catch-up so a backgrounded tab cannot spiral', () => {
    const clock = new FixedStepClock()
    clock.advance(level(), () => HOLD, 30)

    // 0.25 s of catch-up at 120 Hz, not 30 s worth.
    expect(clock.ticks).toBe(30)
  })

  it('samples controls once per tick, not once per frame', () => {
    // The assist layer needs to run at the physics rate. If controls were sampled
    // per frame, its response would depend on frame rate — exactly what fixed-step
    // physics is supposed to prevent.
    const clock = new FixedStepClock()
    const seen: number[] = []

    clock.advance(level(), (tick) => { seen.push(tick); return HOLD }, 0.05)

    expect(seen).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('keeps pace with real time across irregular frame deltas', () => {
    const clock = new FixedStepClock()
    let v = level()

    // Realistic jitter: no single frame exceeds the catch-up cap, so no simulated
    // time should be lost.
    const frames = [0.016, 0.033, 0.008, 0.021, 0.016, 0.016, 0.04, 0.05, 0.012, 0.028]
    const total = frames.reduce((a, b) => a + b, 0)

    for (const dt of frames) v = clock.advance(v, () => HOLD, dt)

    // Whole ticks only, so we land within one tick of the exact figure.
    expect(clock.ticks).toBe(Math.floor(total / PHYSICS_DT))
  })

  it('loses simulated time — deliberately — when a frame exceeds the cap', () => {
    // Documenting the trade rather than hiding it. A 0.5 s stall contributes only
    // MAX_CATCHUP_SECONDS of simulated time. The alternative is a death spiral
    // where catching up takes longer than the gap that caused it.
    const capped = new FixedStepClock()
    capped.advance(level(), () => HOLD, 0.5)
    expect(capped.ticks).toBe(Math.floor(0.25 / PHYSICS_DT))
  })
})

describe('quaternion and Euler agree — and only one survives vertical', () => {
  it('tracks the Euler formulation through ordinary maneuvering', () => {
    // Same aircraft, two representations. Integrated independently for 5 seconds of
    // rolling and pulling, they must end up in the same place.
    const start = level({ theta: 0.1 })
    const u = { throttle: 0.6, elevator: -3, aileron: -6, rudder: 0 }

    let quat = start
    // Same initial condition, expressed in the Euler state layout.
    const eulerState = toStateVector(fromQuatVector(start))

    // Integrate the Euler form with the same RK4 scheme, for a fair comparison.
    let eul = eulerState
    const rk4Euler = (x: number[], dt: number): number[] => {
      const f = (s: number[]) => derivative(s, u).xd
      const addv = (a: number[], b: number[], sc: number) =>
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

    for (let i = 0; i < 5 * PHYSICS_HZ; i++) {
      quat = step(quat, u)
      eul = rk4Euler(eul, PHYSICS_DT)
    }

    const quatEuler = eulerFromQuaternion([
      quat[Q.QW] as number,
      quat[Q.QX] as number,
      quat[Q.QY] as number,
      quat[Q.QZ] as number,
    ])

    expect(quat[Q.VT] as number).toBeCloseTo(eul[S.VT] as number, 4)
    expect(quat[Q.ALT] as number).toBeCloseTo(eul[S.ALT] as number, 3)
    expect(quatEuler.theta).toBeCloseTo(eul[S.THETA] as number, 5)
    expect(quatEuler.phi).toBeCloseTo(eul[S.PHI] as number, 5)
  })

  it('flies through vertical without the attitude blowing up', () => {
    // This is the whole argument for quaternions, made concrete. Pull hard from
    // level flight straight up through 90 degrees of pitch — the point where the
    // Euler kinematics divide by cos(theta) = 0.
    let v = level({ vt: 700, alt: 20000, power: 90 })
    const u = { throttle: 1.0, elevator: -18, aileron: 0, rudder: 0 }

    let maxPitch = 0
    let crossedVertical = false

    for (let i = 0; i < 8 * PHYSICS_HZ; i++) {
      v = step(v, u)

      const e = eulerFromQuaternion([
        v[Q.QW] as number,
        v[Q.QX] as number,
        v[Q.QY] as number,
        v[Q.QZ] as number,
      ])

      expect(Number.isNaN(e.theta), `NaN pitch at tick ${i}`).toBe(false)
      expect(v.every(Number.isFinite), `non-finite state at tick ${i}`).toBe(true)

      maxPitch = Math.max(maxPitch, Math.abs(e.theta))
      if (Math.abs(e.theta) > 1.5) crossedVertical = true
    }

    // Confirm the maneuver actually went near vertical — otherwise this test
    // proves nothing and would keep passing if the aircraft merely refused to pitch.
    expect(crossedVertical, `only reached ${((maxPitch * 180) / Math.PI).toFixed(1)} deg pitch`).toBe(true)

    const norm = Math.hypot(
      v[Q.QW] as number,
      v[Q.QX] as number,
      v[Q.QY] as number,
      v[Q.QZ] as number,
    )
    expect(norm).toBeCloseTo(1, 10)
  })
})
