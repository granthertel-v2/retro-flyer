/**
 * Tier B — table boundary behavior (REQUIREMENTS §4.2 test 5).
 *
 * "Model does not produce NaN or unbounded forces at the alpha and beta table edges."
 *
 * The edges are alpha −10°/+45° and beta ±30° — corrected during source verification
 * from the −20°/+90° the spec originally carried, which is the wind tunnel campaign's
 * range rather than the tabulated data's. See `docs/SOURCES.md`.
 *
 * This file tests three regions, and the distinction matters:
 *
 * 1. **On the boundary.** Must be finite and bounded. Non-negotiable.
 * 2. **Just inside.** Must be continuous with the boundary — no cliff at the edge.
 * 3. **Outside.** The raw model extrapolates without limit and eventually diverges
 *    (measured: hold full deflections and it reaches NaN in about six seconds). The
 *    envelope guard exists for exactly this, and is tested here to prove it works.
 */

import { describe, expect, it } from 'vitest'
import {
  ALPHA_MAX_DEG,
  ALPHA_MIN_DEG,
  BETA_LIMIT_DEG,
  guardAngles,
  insideEnvelope,
} from '../src/envelope.js'
import { S, STATE_SIZE, derivative } from '../src/dynamics.js'
import { buildCoefficients } from '../src/aero/buildup.js'
import {
  cl,
  cm,
  cn,
  cx,
  cy,
  cz,
  dampingArray,
  dlda,
  dldr,
  dnda,
  dndr,
} from '../src/tables/coefficients.js'
import { PHYSICS_HZ, step } from '../src/integrator.js'
import { Q, aeroAngles, quaternionFromEuler, toQuatVector } from '../src/state.js'
import { RAD_PER_DEG } from '../src/units.js'

/** Bound above which a dimensionless coefficient is not physical. */
const COEFFICIENT_BOUND = 10

const ELEVATORS = [-25, -12, 0, 12, 25]
const AILERONS = [-21.5, 0, 21.5]
const RUDDERS = [-30, 0, 30]

describe('coefficients on the exact table boundary', () => {
  const corners: Array<[number, number]> = []
  for (const a of [ALPHA_MIN_DEG, ALPHA_MAX_DEG]) {
    for (const b of [-BETA_LIMIT_DEG, 0, BETA_LIMIT_DEG]) corners.push([a, b])
  }

  it('produces finite, bounded values at every corner', () => {
    for (const [alpha, beta] of corners) {
      for (const el of ELEVATORS) {
        for (const ail of AILERONS) {
          for (const rdr of RUDDERS) {
            const values = {
              cx: cx(alpha, el),
              cy: cy(beta, ail, rdr),
              cz: cz(alpha, beta, el),
              cl: cl(alpha, beta),
              cm: cm(alpha, el),
              cn: cn(alpha, beta),
              dlda: dlda(alpha, beta),
              dldr: dldr(alpha, beta),
              dnda: dnda(alpha, beta),
              dndr: dndr(alpha, beta),
            }

            for (const [name, v] of Object.entries(values)) {
              const where = `${name} at alpha=${alpha} beta=${beta} el=${el} ail=${ail} rdr=${rdr}`
              expect(Number.isFinite(v), `${where} produced ${v}`).toBe(true)
              expect(Math.abs(v), where).toBeLessThan(COEFFICIENT_BOUND)
            }
          }
        }
      }
    }
  })

  it('produces finite damping derivatives at the alpha edges', () => {
    for (const alpha of [ALPHA_MIN_DEG, ALPHA_MAX_DEG]) {
      for (const d of dampingArray(alpha)) {
        expect(Number.isFinite(d)).toBe(true)
        expect(Math.abs(d)).toBeLessThan(100) // czq runs to about -38
      }
    }
  })

  it('has no cliff at any edge — the boundary value matches the interior trend', () => {
    // A discontinuity here would mean the index clamping engages one node early: a
    // classic off-by-one that the golden tests catch only if a fixture happens to
    // land right on it.
    //
    // Comparing adjacent values directly is the wrong instrument — the tables have
    // a real slope, so neighbours legitimately differ. What identifies a cliff is
    // the boundary value departing from the line the interior points establish.
    const h = 0.05

    const noCliff = (
      name: string,
      f: (x: number) => number,
      edge: number,
      inward: 1 | -1,
    ): void => {
      const atEdge = f(edge)
      const near = f(edge + inward * h)
      const far = f(edge + inward * 2 * h)

      // Extrapolate the interior slope back to the edge.
      const predicted = near + (near - far)
      const slope = Math.abs(near - far) / h

      // Allow a generous multiple of one step's worth of change. A genuine cliff is
      // a jump to a different table node, which is orders of magnitude larger.
      const tolerance = Math.max(1e-9, slope * h * 5)

      expect(
        Math.abs(atEdge - predicted),
        `${name}: cliff at edge ${edge} — value ${atEdge}, interior trend predicts ${predicted}`,
      ).toBeLessThan(tolerance)
    }

    noCliff('cz', (a) => cz(a, 0, 0), ALPHA_MIN_DEG, 1)
    noCliff('cz', (a) => cz(a, 0, 0), ALPHA_MAX_DEG, -1)
    noCliff('cm', (a) => cm(a, 0), ALPHA_MIN_DEG, 1)
    noCliff('cm', (a) => cm(a, 0), ALPHA_MAX_DEG, -1)
    noCliff('cx', (a) => cx(a, 0), ALPHA_MIN_DEG, 1)
    noCliff('cx', (a) => cx(a, 0), ALPHA_MAX_DEG, -1)

    noCliff('cl', (b) => cl(10, b), BETA_LIMIT_DEG, -1)
    noCliff('cl', (b) => cl(10, b), -BETA_LIMIT_DEG, 1)
    noCliff('cn', (b) => cn(10, b), BETA_LIMIT_DEG, -1)
    noCliff('cn', (b) => cn(10, b), -BETA_LIMIT_DEG, 1)
  })

  it('has bounded slope everywhere inside the envelope', () => {
    // The other half of "no unbounded forces": not just finite values, but no
    // near-vertical jumps between adjacent flight conditions. A spike would make the
    // integrator take a wild step even though every individual value looked fine.
    const h = 0.25

    for (let alpha = ALPHA_MIN_DEG; alpha < ALPHA_MAX_DEG; alpha += h) {
      const dcz = Math.abs(cz(alpha + h, 0, 0) - cz(alpha, 0, 0)) / h
      const dcm = Math.abs(cm(alpha + h, 0) - cm(alpha, 0)) / h

      expect(dcz, `d(cz)/d(alpha) at ${alpha.toFixed(2)} deg`).toBeLessThan(1)
      expect(dcm, `d(cm)/d(alpha) at ${alpha.toFixed(2)} deg`).toBeLessThan(1)
    }
  })

  it('sweeps the whole valid envelope without a NaN', () => {
    for (let alpha = ALPHA_MIN_DEG; alpha <= ALPHA_MAX_DEG; alpha += 0.5) {
      for (let beta = -BETA_LIMIT_DEG; beta <= BETA_LIMIT_DEG; beta += 1) {
        for (const el of [-25, 0, 25]) {
          const c = buildCoefficients({
            alphaDeg: alpha,
            betaDeg: beta,
            elevatorDeg: el,
            aileronDeg: 0,
            rudderDeg: 0,
            p: 0,
            q: 0,
            r: 0,
            vt: 500,
            xcg: 0.35,
          })

          for (const [name, v] of Object.entries(c)) {
            expect(
              Number.isFinite(v),
              `${name} = ${v} at alpha=${alpha} beta=${beta} el=${el}`,
            ).toBe(true)
            expect(Math.abs(v), `${name} at alpha=${alpha} beta=${beta}`).toBeLessThan(
              COEFFICIENT_BOUND,
            )
          }
        }
      }
    }
  })
})

describe('the state derivative at the envelope corners', () => {
  const stateAt = (alphaDeg: number, betaDeg: number): number[] => {
    const x = new Array<number>(STATE_SIZE).fill(0)
    x[S.VT] = 500
    x[S.ALPHA] = alphaDeg * RAD_PER_DEG
    x[S.BETA] = betaDeg * RAD_PER_DEG
    x[S.THETA] = 0.1
    x[S.ALT] = 10000
    x[S.POWER] = 50
    return x
  }

  it('is finite at every corner, with all controls at their limits', () => {
    for (const alpha of [ALPHA_MIN_DEG, ALPHA_MAX_DEG]) {
      for (const beta of [-BETA_LIMIT_DEG, 0, BETA_LIMIT_DEG]) {
        for (const el of [-25, 25]) {
          for (const ail of [-21.5, 21.5]) {
            for (const rdr of [-30, 30]) {
              const d = derivative(stateAt(alpha, beta), {
                throttle: 1,
                elevator: el,
                aileron: ail,
                rudder: rdr,
              })

              expect(
                d.xd.every(Number.isFinite),
                `non-finite at alpha=${alpha} beta=${beta} el=${el} ail=${ail} rdr=${rdr}`,
              ).toBe(true)

              // Bounded, too — "finite" alone would accept 1e300.
              expect(Math.abs(d.xd[S.P] as number)).toBeLessThan(100)
              expect(Math.abs(d.xd[S.Q] as number)).toBeLessThan(100)
              expect(Math.abs(d.xd[S.R] as number)).toBeLessThan(100)
              expect(Math.abs(d.xd[S.VT] as number)).toBeLessThan(1000)
            }
          }
        }
      }
    }
  })

  it('is finite at extreme but plausible airspeeds and altitudes', () => {
    for (const vt of [200, 500, 1200]) {
      for (const alt of [0, 30000, 60000]) {
        const x = stateAt(10, 5)
        x[S.VT] = vt
        x[S.ALT] = alt

        const d = derivative(x, { throttle: 1, elevator: -10, aileron: 5, rudder: 5 })
        expect(d.xd.every(Number.isFinite), `vt=${vt} alt=${alt}`).toBe(true)
      }
    }
  })
})

describe('envelope guard', () => {
  it('reports what is inside and what is not', () => {
    expect(insideEnvelope(0, 0)).toBe(true)
    expect(insideEnvelope(ALPHA_MIN_DEG, -BETA_LIMIT_DEG)).toBe(true)
    expect(insideEnvelope(ALPHA_MAX_DEG, BETA_LIMIT_DEG)).toBe(true)
    expect(insideEnvelope(ALPHA_MAX_DEG + 0.1, 0)).toBe(false)
    expect(insideEnvelope(ALPHA_MIN_DEG - 0.1, 0)).toBe(false)
    expect(insideEnvelope(0, BETA_LIMIT_DEG + 0.1)).toBe(false)
  })

  it('clamps onto the boundary and says that it did', () => {
    const g = guardAngles(90, -50)
    expect(g.alphaDeg).toBe(ALPHA_MAX_DEG)
    expect(g.betaDeg).toBe(-BETA_LIMIT_DEG)
    expect(g.clamped).toBe(true)

    const inside = guardAngles(10, 5)
    expect(inside.clamped).toBe(false)
    expect(inside.alphaDeg).toBe(10)
  })

  it('leaves the unguarded model bit-exact', () => {
    // The guard must not change anything inside the envelope, or Tier A would be
    // testing a different function than the simulation runs.
    const x = new Array<number>(STATE_SIZE).fill(0)
    x[S.VT] = 500
    x[S.ALPHA] = 0.1
    x[S.BETA] = 0.05
    x[S.ALT] = 10000
    x[S.POWER] = 50

    const u = { throttle: 0.5, elevator: -2, aileron: 3, rudder: 1 }
    const plain = derivative(x, u)
    const guarded = derivative(x, u, undefined, { clampAeroAngles: true })

    expect(guarded.outsideEnvelope).toBe(false)
    for (let i = 0; i < STATE_SIZE; i++) {
      expect(guarded.xd[i] as number).toBe(plain.xd[i] as number)
    }
  })

  it('flags a flight condition outside the data', () => {
    const x = new Array<number>(STATE_SIZE).fill(0)
    x[S.VT] = 500
    x[S.ALPHA] = 70 * RAD_PER_DEG
    x[S.ALT] = 10000
    x[S.POWER] = 50

    const d = derivative(x, { throttle: 0.5, elevator: 0, aileron: 0, rudder: 0 }, undefined, {
      clampAeroAngles: true,
    })
    expect(d.outsideEnvelope).toBe(true)
  })
})

describe('departure does not become divergence', () => {
  // The measured problem this guard was built for. Held full-deflection controls
  // depart the aircraft — which is correct and wanted (REQUIREMENTS §5 asks for
  // assists-off flight to be departure-prone). What is NOT wanted is the state
  // vector reaching NaN, which the unguarded model does in about six seconds.
  const departed = (u: { throttle: number; elevator: number; aileron: number; rudder: number }) => {
    let v = toQuatVector({
      vt: 500,
      alpha: 0.06,
      beta: 0,
      q: quaternionFromEuler(0, 0.06, 0),
      p: 0,
      qRate: 0,
      r: 0,
      pn: 0,
      pe: 0,
      alt: 20000,
      power: 50,
    })
    for (let i = 0; i < 30 * PHYSICS_HZ; i++) {
      v = step(v, u)
      if (!v.every(Number.isFinite)) return { v, failedAt: i }
    }
    return { v, failedAt: -1 }
  }

  it('survives 30 seconds of full deflection in every axis', () => {
    const { v, failedAt } = departed({ throttle: 1, elevator: -25, aileron: 21.5, rudder: 30 })

    expect(failedAt, `went non-finite at tick ${failedAt}`).toBe(-1)
    expect(v.every(Number.isFinite)).toBe(true)
  })

  it('survives full deflection in the opposite direction too', () => {
    const { failedAt } = departed({ throttle: 1, elevator: 25, aileron: -21.5, rudder: -30 })
    expect(failedAt).toBe(-1)
  })

  it('keeps airspeed and rates within physically plausible bounds while departed', () => {
    // Not "correct" — nothing outside the data envelope is correct. Just bounded,
    // so the simulation stays a simulation.
    const { v } = departed({ throttle: 1, elevator: -25, aileron: 21.5, rudder: 30 })

    expect(Math.abs(aeroAngles(v[Q.U] as number, v[Q.V] as number, v[Q.W] as number).vt))
      .toBeLessThan(5000)
    expect(Math.abs(v[Q.P] as number)).toBeLessThan(50)
    expect(Math.abs(v[Q.Q_RATE] as number)).toBeLessThan(50)
    expect(Math.abs(v[Q.R] as number)).toBeLessThan(50)
  })

  it('reports the incidence the aircraft actually has, however long the tumble runs', () => {
    // This test survives a change of formulation, and it is worth saying why rather
    // than deleting it.
    //
    // Alpha used to be an integrated state, so nothing stopped it accumulating. A
    // tumble made it: held at full aft stick with the AoA limiter off, alpha reached
    // 1,477 degrees in 25 seconds and was still climbing, when the aircraft's actual
    // incidence was 37. That is not a cosmetic complaint — the tables clamp alpha to
    // their +45 edge, and once alpha is four turns past that the clamp never
    // releases, so the model computes forces for an aeroplane at 45 degrees that is
    // really at 37, forever. The aircraft stops being able to recover from a
    // departure it should only have found difficult.
    //
    // Alpha is now derived from the body velocity (`state.ts`), so the divergence
    // is structurally impossible rather than corrected. The assertion is therefore
    // no longer about a wrapping guard; it is the property that guard was protecting:
    // the incidence the model uses is the incidence the aircraft has. Reintroducing
    // an integrated alpha would turn this red again, which is the point of keeping it.
    const { v } = departed({ throttle: 1, elevator: -25, aileron: 0, rudder: 0 })

    const u = v[Q.U] as number
    const w = v[Q.W] as number
    const reported = aeroAngles(u, v[Q.V] as number, w).alpha / RAD_PER_DEG
    const truth = Math.atan2(w, u) / RAD_PER_DEG

    expect(Math.abs(reported), 'alpha left (-180, 180]').toBeLessThanOrEqual(180.000001)
    expect(reported, 'model incidence differs from actual incidence').toBeCloseTo(truth, 9)
  })

  it('still departs — the guard bounds the model, it does not stabilize it', () => {
    // Important negative check. If clamping had accidentally made the aircraft
    // docile, assists-off flight would stop being difficult and REQUIREMENTS §5
    // would be quietly unsatisfiable.
    const { v } = departed({ throttle: 1, elevator: -25, aileron: 21.5, rudder: 30 })

    const totalRate = Math.hypot(v[Q.P] as number, v[Q.Q_RATE] as number, v[Q.R] as number)
    expect(totalRate, 'aircraft did not depart under full deflection').toBeGreaterThan(0.5)
  })
})
