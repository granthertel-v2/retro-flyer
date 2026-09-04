/**
 * Tier B — energy sanity (REQUIREMENTS §4.2 test 6).
 *
 * "In an unpowered glide from trim, total energy decreases monotonically."
 *
 * ## Why this test is worth more than it looks
 *
 * It is the only test in the suite that checks a conservation law rather than a
 * number. Everything else compares against a reference or a published value; this
 * asks whether the model obeys thermodynamics.
 *
 * With the engine off, the only forces are gravity and aerodynamics. Gravity is
 * conservative — it moves energy between altitude and speed without creating any.
 * Drag is strictly dissipative. So total specific energy `h + V²/2g` can only fall.
 *
 * If it rises, something is generating energy from nothing, and the candidates are
 * all serious: a sign error on a force, a drag term pointing the wrong way, or an
 * unstable integrator pumping energy in. None of those would necessarily show up in
 * a trim test, and a plausible-looking wrong model can easily pass every other test
 * here while failing this one.
 *
 * ## Two things this test had to get right to mean anything
 *
 * **The aircraft must glide, not tumble.** The elevator is held at its trim value
 * throughout. With the elevator centred instead, this airframe — which is
 * longitudinally unstable at its reference CG, see `modes.test.ts` — departs within
 * about ten seconds and reaches angles of attack past −800°. That is far outside the
 * aerodynamic data, where the envelope guard is clamping and the coefficients are no
 * longer energy-consistent, so energy conservation is not a meaningful thing to
 * assert there. Measured, before the fix: a 13 ft energy gain in a single 1/120 s
 * step at t = 12.1 s. Holding trim elevator, the largest single-step gain over 40
 * seconds is exactly 0.
 *
 * **"Unpowered" means idle, not zero.** The model has no engine-off state; minimum
 * power is the idle table. Conveniently this barely matters: idle thrust at 20,000 ft
 * is about −230 lb, i.e. net drag from a windmilling engine, so idle at altitude is a
 * good approximation of unpowered. Near sea level idle is positive (~1,060 lb) and
 * would genuinely add energy, which is why these tests glide from altitude.
 */

import { describe, expect, it } from 'vitest'
import { PHYSICS_HZ, simulate, specificEnergy, step } from '../src/integrator.js'
import { aeroAngles, fromStateVector, Q, toQuatVector } from '../src/state.js'
import { trim } from '../src/trim.js'
import { G_FT_S2 } from '../src/units.js'

/**
 * A trimmed state with the engine already spooled down to idle, plus the elevator
 * setting that holds the glide.
 *
 * Power starts at 0 rather than its trim value so there is no spool-down transient
 * adding energy during the first seconds.
 */
function glideStart(alt: number, vt: number): { v: number[]; elevator: number } {
  const t = trim({ alt, vt })
  expect(t.converged, `trim failed at ${alt} ft / ${vt} ft/s`).toBe(true)

  const v = toQuatVector(fromStateVector(t.state))
  v[Q.POWER] = 0
  return { v, elevator: t.elevator }
}

/**
 * Idle throttle with the elevator held at trim.
 *
 * The elevator value is what makes this a glide rather than a departure. See the
 * file header.
 */
const glideControls = (elevator: number) => ({
  throttle: 0,
  elevator,
  aileron: 0,
  rudder: 0,
})

describe('specific energy', () => {
  it('is altitude plus the height the airspeed could buy', () => {
    const v = toQuatVector({
      vt: 500,
      alpha: 0,
      beta: 0,
      q: [1, 0, 0, 0],
      p: 0,
      qRate: 0,
      r: 0,
      pn: 0,
      pe: 0,
      alt: 10000,
      power: 0,
    })

    expect(specificEnergy(v)).toBeCloseTo(10000 + (500 * 500) / (2 * G_FT_S2), 6)
  })

  it('is unchanged by a pure trade of altitude for speed', () => {
    // The defining property. Two states with the same total energy, one high and
    // slow, one low and fast.
    const make = (alt: number, vt: number) =>
      toQuatVector({
        vt, alpha: 0, beta: 0, q: [1, 0, 0, 0] as const,
        p: 0, qRate: 0, r: 0, pn: 0, pe: 0, alt, power: 0,
      })

    const high = make(20000, 400)
    const e = specificEnergy(high)
    // Convert the 10,000 ft of altitude difference into speed.
    const vFast = Math.sqrt(2 * G_FT_S2 * (e - 10000))
    const low = make(10000, vFast)

    expect(specificEnergy(low)).toBeCloseTo(e, 6)
  })
})

describe('unpowered glide from trim (§4.2 test 6)', () => {
  const conditions = [
    [10000, 500],
    [20000, 600],
    [30000, 700],
  ] as const

  for (const [alt, vt] of conditions) {
    it(`loses energy monotonically from ${alt} ft / ${vt} ft/s`, () => {
      const { v, elevator } = glideStart(alt, vt)
      const { states } = simulate(v, () => glideControls(elevator), 30)

      let prev = specificEnergy(states[0] as number[])
      let worstGain = 0
      let worstAt = 0

      for (let i = 1; i < states.length; i++) {
        const e = specificEnergy(states[i] as number[])
        const gain = e - prev

        if (gain > worstGain) {
          worstGain = gain
          worstAt = i / PHYSICS_HZ
        }
        prev = e
      }

      // Zero tolerance on the sign. Any gain at all means energy came from nowhere.
      expect(
        worstGain,
        `energy rose by ${worstGain.toFixed(6)} ft at t=${worstAt.toFixed(2)}s`,
      ).toBeLessThanOrEqual(0)
    })
  }

  it('loses a substantial amount over the glide', () => {
    // Guards against the trivial pass: a model producing no motion at all would
    // satisfy "never increases" while proving nothing.
    const { v, elevator } = glideStart(20000, 600)
    const { states } = simulate(v, () => glideControls(elevator), 30)

    const start = specificEnergy(states[0] as number[])
    const end = specificEnergy(states.at(-1) as number[])

    expect(start - end).toBeGreaterThan(1000)
  })

  it('bleeds airspeed as it glides', () => {
    // Checking speed rather than altitude on purpose. Held at trim elevator the
    // aircraft actually zoom-climbs slightly as it decelerates — altitude rises
    // while total energy falls, which is precisely the distinction this test exists
    // to make. Energy is the conserved-ish quantity; altitude alone is not.
    const { v, elevator } = glideStart(20000, 600)
    const { states } = simulate(v, () => glideControls(elevator), 30)

    const last = states.at(-1) as number[]
    const vt = aeroAngles(last[Q.U] as number, last[Q.V] as number, last[Q.W] as number).vt
    expect(vt).toBeLessThan(600)
  })

  it('loses energy faster at high speed than at low', () => {
    // Drag grows with the square of airspeed, so the energy bleed rate should too.
    // Another way of asking whether drag is actually connected to anything.
    const rate = (vt: number): number => {
      const { v, elevator } = glideStart(20000, vt)
      const { states } = simulate(v, () => glideControls(elevator), 10)
      return (
        (specificEnergy(states[0] as number[]) -
          specificEnergy(states.at(-1) as number[])) / 10
      )
    }

    expect(rate(800)).toBeGreaterThan(rate(400))
  })
})

describe('energy under power', () => {
  it('can increase with the engine running', () => {
    // The complement, and a check that the previous tests are not passing because
    // energy simply never rises under any circumstances. A climbing aircraft on
    // full power gains total energy — that is what the engine is for.
    const t = trim({ alt: 10000, vt: 500 })
    let v = toQuatVector(fromStateVector(t.state))
    v[Q.POWER] = 100

    const start = specificEnergy(v)
    // Ten seconds, holding trim elevator. Long enough for the engine to spool and
    // the energy to climb; short enough that the pitch instability has not yet
    // taken the aircraft somewhere the model cannot describe.
    for (let i = 0; i < 10 * PHYSICS_HZ; i++) {
      v = step(v, { throttle: 1, elevator: t.elevator, aileron: 0, rudder: 0 })
    }

    expect(specificEnergy(v)).toBeGreaterThan(start)
  })

  it('holds energy nearly constant in trimmed level flight', () => {
    // At trim, thrust balances drag exactly, so specific energy should sit still.
    // Drift here would mean the trim solution is not really an equilibrium.
    const t = trim({ alt: 10000, vt: 500 })
    let v = toQuatVector(fromStateVector(t.state))

    const start = specificEnergy(v)
    for (let i = 0; i < 30 * PHYSICS_HZ; i++) {
      v = step(v, { throttle: t.throttle, elevator: t.elevator, aileron: 0, rudder: 0 })
    }

    // A few hundred feet of specific energy over 30 seconds is phugoid wander, not
    // a leak: the mode is very lightly damped and moves energy between altitude and
    // speed on a ~75 second period.
    expect(Math.abs(specificEnergy(v) - start)).toBeLessThan(300)
  })
})

describe('the integrator does not manufacture energy', () => {
  it('gives the same energy loss at half the timestep', () => {
    // If the integrator were adding or removing energy numerically, the amount
    // would depend on step size. Agreement across a 4x change in dt says the loss
    // is physical drag, not integration error.
    const { v: v0, elevator } = glideStart(20000, 600)

    const loss = (dt: number): number => {
      const { states } = simulate(v0, () => glideControls(elevator), 20, dt)
      return specificEnergy(states[0] as number[]) - specificEnergy(states.at(-1) as number[])
    }

    const coarse = loss(1 / 60)
    const fine = loss(1 / 240)

    expect(Math.abs(coarse - fine) / fine).toBeLessThan(0.01)
  })
})
