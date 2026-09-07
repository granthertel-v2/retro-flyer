/**
 * Tier B — trim (REQUIREMENTS §4.2 tests 1 and 2).
 *
 * Trim is where the model stops being "a faithful port" and starts being "an
 * airplane". Tier A already proves the arithmetic matches the reference; nothing in
 * it would notice if the reference described a brick. These tests check that the
 * equilibrium solutions are the ones a real F-16 has.
 *
 * Two mass configurations appear here on purpose:
 *
 * - `REFERENCE_IMPL_MASS` reproduces the reference's rounded constants, so trim
 *   solutions can be checked against the golden fixtures exactly.
 * - The default (`computeMassProperties()`) uses the more accurate [NASA-TM]
 *   Table 1 values, which is what the simulation actually flies. Those are checked
 *   against the same fixtures at the spec's 5% tolerance.
 *
 * Both matter. The first catches a broken solver; the second catches a solver that
 * only works for one specific set of constants.
 */

import { describe, expect, it } from 'vitest'
import golden from '../fixtures/golden-trim.json' with { type: 'json' }
import { S, derivative } from '../src/dynamics.js'
import { REFERENCE_IMPL_MASS, computeMassProperties } from '../src/massProperties.js'
import { trim, trimControls } from '../src/trim.js'
import { PHYSICS_HZ, step } from '../src/integrator.js'
import { aeroAngles, fromStateVector, Q, toQuatVector } from '../src/state.js'

interface TrimCase {
  in: { alt: number; vt: number }
  out: {
    alphaRad: number
    alphaDeg: number
    elevatorDeg: number
    throttle: number
    residual: number
  }
}

const cases = golden.cases as TrimCase[]
const sweep = golden.sweep as {
  alt: number
  points: Array<{ vt: number; alphaDeg: number; elevatorDeg: number; throttle: number }>
}

/**
 * Percentage error, with an absolute floor.
 *
 * Some trim elevator values are near zero (−0.03 deg at 300 ft/s). Pure relative
 * error there is dominated by the last significant digit and reports huge
 * percentages for differences of a thousandth of a degree, which no control surface
 * could resolve and no pilot could feel. The floor keeps the comparison meaningful
 * for the quantities that matter without loosening it where it counts.
 */
const pctErr = (a: number, b: number, floor = 0.05): number =>
  (Math.abs(a - b) / Math.max(floor, Math.abs(b))) * 100

describe('steady level trim reproduces the reference solutions', () => {
  for (const c of cases) {
    it(`${c.in.alt} ft / ${c.in.vt} ft/s`, () => {
      const r = trim({ alt: c.in.alt, vt: c.in.vt }, REFERENCE_IMPL_MASS)

      expect(r.converged, `residual ${r.residual.toExponential(2)}`).toBe(true)

      // Well inside the 5% the spec allows — these agree to the printed digits.
      expect(pctErr(r.alphaDeg, c.out.alphaDeg)).toBeLessThan(0.5)
      expect(pctErr(r.elevator, c.out.elevatorDeg)).toBeLessThan(0.5)
      expect(pctErr(r.throttle, c.out.throttle)).toBeLessThan(0.5)
    })
  }
})

describe('trim with the more accurate NASA mass properties', () => {
  // The production configuration. Should land in the same place to within the 5%
  // REQUIREMENTS §4.2 permits, since the constants differ by only ~0.05%.
  for (const c of cases) {
    it(`${c.in.alt} ft / ${c.in.vt} ft/s within 5%`, () => {
      const r = trim({ alt: c.in.alt, vt: c.in.vt })

      expect(r.converged).toBe(true)
      expect(pctErr(r.alphaDeg, c.out.alphaDeg)).toBeLessThan(5)
      expect(pctErr(r.elevator, c.out.elevatorDeg)).toBeLessThan(5)
      expect(pctErr(r.throttle, c.out.throttle)).toBeLessThan(5)
    })
  }
})

describe('a trim solution is actually an equilibrium', () => {
  // The strongest statement available, and independent of any fixture: put the
  // aircraft at the solution, hold the controls, and confirm it stays there. A
  // solver that converged to the wrong thing fails this immediately.
  it('holds airspeed, altitude and attitude for 10 seconds', () => {
    const r = trim({ alt: 10000, vt: 500 })
    const u = trimControls(r)

    let v = toQuatVector(fromStateVector(r.state))
    const vtOf = (a: number[]): number =>
      aeroAngles(a[Q.U] as number, a[Q.V] as number, a[Q.W] as number).vt
    const alt0 = v[Q.ALT] as number
    const vt0 = vtOf(v)

    for (let i = 0; i < 10 * PHYSICS_HZ; i++) {
      v = step(v, u)
    }

    // Loose bounds because trim is neutrally stable in the phugoid, which drifts
    // slowly by nature. What is being ruled out is a solution that departs.
    expect(Math.abs((v[Q.ALT] as number) - alt0)).toBeLessThan(200)
    expect(Math.abs(vtOf(v) - vt0)).toBeLessThan(20)
  })

  it('has near-zero accelerations at the solution point', () => {
    for (const c of cases) {
      const r = trim({ alt: c.in.alt, vt: c.in.vt })
      const { xd } = derivative(r.state, trimControls(r))

      expect(Math.abs(xd[S.VT] as number)).toBeLessThan(1e-4)
      expect(Math.abs(xd[S.ALPHA] as number)).toBeLessThan(1e-6)
      expect(Math.abs(xd[S.Q] as number)).toBeLessThan(1e-5)
    }
  })
})

describe('trim continuity across an airspeed sweep (§4.2 test 2)', () => {
  // A discontinuity here would mean a table interpolation error — the lookup
  // stepping to the wrong node somewhere, producing a jump in the solution that
  // physics does not justify.
  const solved = sweep.points.map((p) => ({
    vt: p.vt,
    ...trim({ alt: sweep.alt, vt: p.vt }, REFERENCE_IMPL_MASS),
  }))

  it('every point on the sweep converges', () => {
    for (const s of solved) {
      expect(s.converged, `${s.vt} ft/s: residual ${s.residual.toExponential(2)}`).toBe(true)
    }
  })

  it('matches the reference sweep', () => {
    for (let i = 0; i < sweep.points.length; i++) {
      const want = sweep.points[i] as (typeof sweep.points)[number]
      const got = solved[i] as (typeof solved)[number]

      expect(pctErr(got.alphaDeg, want.alphaDeg), `at ${want.vt} ft/s`).toBeLessThan(5)
      expect(pctErr(got.throttle, want.throttle), `at ${want.vt} ft/s`).toBeLessThan(5)
    }
  })

  it('angle of attack falls monotonically as speed rises', () => {
    // Physics, not preference: at higher dynamic pressure less lift coefficient is
    // needed to hold the same weight, so less alpha.
    for (let i = 1; i < solved.length; i++) {
      const prev = solved[i - 1] as (typeof solved)[number]
      const cur = solved[i] as (typeof solved)[number]
      expect(cur.alphaDeg, `${prev.vt} -> ${cur.vt} ft/s`).toBeLessThan(prev.alphaDeg)
    }
  })

  it('has no jumps — every step is small relative to its neighbours', () => {
    // The actual discontinuity check. Compare each step against the local trend;
    // a table indexing error shows up as one step far larger than its neighbours.
    const steps = solved.slice(1).map((s, i) => Math.abs(s.alphaDeg - (solved[i] as (typeof solved)[number]).alphaDeg))
    const median = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)] as number

    for (let i = 0; i < steps.length; i++) {
      expect(
        steps[i] as number,
        `step ${i} (${(solved[i] as (typeof solved)[number]).vt} -> ${(solved[i + 1] as (typeof solved)[number]).vt} ft/s) is ${((steps[i] as number) / median).toFixed(1)}x the median`,
      ).toBeLessThan(median * 12)
    }
  })

  it('throttle rises with airspeed above the drag bucket', () => {
    // The drag curve has a minimum: below it, going slower needs MORE thrust
    // (induced drag from the high alpha dominates). Above it, faster needs more.
    // Checking only the high-speed branch, where the relationship is monotonic.
    const fast = solved.filter((s) => s.vt >= 500)
    for (let i = 1; i < fast.length; i++) {
      expect((fast[i] as (typeof solved)[number]).throttle).toBeGreaterThan(
        (fast[i - 1] as (typeof solved)[number]).throttle,
      )
    }
  })

  it('shows the back side of the drag curve at low speed', () => {
    // A real and counterintuitive property of aircraft: below the minimum-drag
    // speed, flying slower requires more power. It falls out of the model rather
    // than being put in, which is a decent sign the model is behaving.
    const slow = solved.filter((s) => s.vt <= 400)
    const throttles = slow.map((s) => s.throttle)

    expect(throttles.length).toBeGreaterThan(2)
    expect(throttles[0] as number).toBeGreaterThan(throttles[throttles.length - 1] as number)
  })
})

describe('non-level trim conditions (§4.1)', () => {
  it('solves a steady climb, needing more throttle than level flight', () => {
    const level = trim({ alt: 10000, vt: 500 })
    const climb = trim({ alt: 10000, vt: 500, gamma: 0.1 }) // ~5.7 deg

    expect(climb.converged).toBe(true)
    // Climbing means continuously adding potential energy, which has to be paid for.
    expect(climb.throttle).toBeGreaterThan(level.throttle)
  })

  it('solves a steady descent, needing less throttle', () => {
    // Shallow, deliberately. A 5.7-degree descent at 500 ft/s would require less
    // than idle thrust — no equilibrium exists, and the solver correctly reports
    // that rather than inventing one. Level trim here needs only 16% throttle, so
    // there is very little room below it.
    const level = trim({ alt: 10000, vt: 500 })
    const descent = trim({ alt: 10000, vt: 500, gamma: -0.02 })

    expect(descent.converged).toBe(true)
    expect(descent.throttle).toBeLessThan(level.throttle)
  })

  it('reports non-convergence when no equilibrium exists', () => {
    // Worth testing explicitly: a solver that silently returns its best guess is
    // far more dangerous than one that says it failed. A steep descent at this
    // speed needs negative thrust.
    const impossible = trim({ alt: 10000, vt: 500, gamma: -0.3 })
    expect(impossible.converged).toBe(false)
  })

  it('solves a coordinated turn with a sensible bank angle', () => {
    const turnRate = 0.1 // rad/s, about 5.7 deg/s
    const vt = 500
    const t = trim({ alt: 10000, vt, turnRate })

    expect(t.converged).toBe(true)

    // tan(phi) = omega*V/g is the standard level-turn relation. The solver should
    // land near it without being told to.
    const expectedPhi = Math.atan((turnRate * vt) / 32.17)
    expect(Math.abs(t.phi)).toBeCloseTo(Math.abs(expectedPhi), 1)

    // A turn is a maneuver: it needs more lift, so more alpha, than level flight.
    expect(t.alphaDeg).toBeGreaterThan(trim({ alt: 10000, vt }).alphaDeg)
  })
})
