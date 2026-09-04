/**
 * Tier B — modal analysis (REQUIREMENTS §4.2 tests 3 and 4).
 *
 * These are the sharpest tests in the suite. Trim only checks a static equilibrium;
 * these check the *derivatives* of forces and moments about that point, which is
 * where the damping tables and the moment coupling actually live. A model can trim
 * perfectly with badly wrong pitch damping. It cannot produce the right short-period
 * behavior with badly wrong pitch damping.
 *
 * ## An amendment to §4.2 test 3
 *
 * The spec asks for the short-period "damping ratio and natural frequency" at trim.
 * At this airframe's reference CG of 0.35 c-bar, **it does not have those**, because
 * the short-period mode is not oscillatory there. It has split into two real roots
 * and one of them is divergent.
 *
 * That is not a defect. It is the defining property of the aircraft. The F-16 was
 * built with relaxed longitudinal stability — the source wind tunnel study is
 * literally titled "Simulator Study of Stall/Post-Stall Characteristics of a Fighter
 * Airplane with Relaxed Longitudinal Stability" — and it depends on fly-by-wire to be
 * flyable. REQUIREMENTS §3 already says so, and puts our equivalent in the assist
 * layer.
 *
 * So the test is restated in a form that is stronger, not weaker:
 *
 * 1. At forward CG the short period IS oscillatory, with textbook frequency and
 *    damping for a fighter.
 * 2. Moving the CG aft drives the pair onto the real axis and then into divergence,
 *    monotonically.
 * 3. At the reference CG the aircraft is divergent, with a quantified time to double.
 *
 * A model with the wrong pitch damping or wrong Cm-alpha slope fails all three.
 * The original single-point check would have been easier to pass and would have
 * proven less.
 */

import { describe, expect, it } from 'vitest'
import {
  REFERENCE_LOADOUT,
  REFERENCE_WEIGHT_LB,
  computeMassProperties,
} from '../src/massProperties.js'
import { lateralModes, longitudinalModes } from '../src/linearize.js'
import { trim, trimControls } from '../src/trim.js'

/**
 * Mass properties with the CG at a chosen station.
 *
 * Moves the fuel to shift the CG, which is the physically honest way to do it and
 * exercises the REQUIREMENTS §8.4 loadout seam at the same time.
 */
function atCG(xcg: number) {
  const fuel = 5000
  const shift = ((xcg - 0.35) * REFERENCE_WEIGHT_LB) / fuel + 0.35
  return computeMassProperties({ ...REFERENCE_LOADOUT, fuelStation: shift })
}

const analyze = (alt: number, vt: number, mass = computeMassProperties()) => {
  const t = trim({ alt, vt }, mass)
  expect(t.converged, `trim failed at ${alt} ft / ${vt} ft/s`).toBe(true)
  const u = trimControls(t)
  return { lon: longitudinalModes(t.state, u, mass), lat: lateralModes(t.state, u, mass) }
}

describe('short period at forward CG is a textbook fighter mode', () => {
  // With the CG forward the aircraft is conventionally stable and the short period
  // looks like every flight dynamics textbook: a few rad/s, well damped.
  const { lon } = analyze(10000, 500, atCG(0.25))

  it('is oscillatory', () => {
    expect(lon.staticallyUnstable).toBe(false)
    expect(lon.shortPeriod).toBeDefined()
    expect(lon.shortPeriod?.oscillatory).toBe(true)
  })

  it('has a natural frequency in the expected band', () => {
    // 1-5 rad/s is the range for a fighter at this speed and altitude.
    expect(lon.shortPeriod?.wn as number).toBeGreaterThan(1)
    expect(lon.shortPeriod?.wn as number).toBeLessThan(5)
  })

  it('is well damped', () => {
    // MIL-F-8785C Level 1 handling qualities want short-period damping between
    // roughly 0.35 and 1.3. A value near 0.4-0.6 is normal here.
    expect(lon.shortPeriod?.zeta as number).toBeGreaterThan(0.2)
    expect(lon.shortPeriod?.zeta as number).toBeLessThan(1.0)
  })

  it('has a phugoid an order of magnitude slower', () => {
    // The frequency separation between the two longitudinal modes is what makes
    // them separable at all. If it ever collapsed, the identification logic in
    // linearize.ts would be unreliable.
    expect(lon.phugoid).toBeDefined()
    expect((lon.shortPeriod?.wn as number) / (lon.phugoid?.wn as number)).toBeGreaterThan(10)
  })

  it('has a lightly damped phugoid, as aircraft do', () => {
    expect(lon.phugoid?.zeta as number).toBeGreaterThan(0)
    expect(lon.phugoid?.zeta as number).toBeLessThan(0.3)
  })
})

describe('relaxed longitudinal stability (REQUIREMENTS §3)', () => {
  it('is divergent in pitch at the reference CG of 0.35 c-bar', () => {
    // The headline result. This confirms the model reproduces the actual F-16
    // characteristic rather than a generically stable aeroplane.
    const { lon } = analyze(10000, 500)

    expect(lon.staticallyUnstable).toBe(true)
    expect(lon.timeToDouble).toBeDefined()
  })

  it('diverges on a timescale a human could not fly unaided', () => {
    // Time to double around 2-3 seconds at this condition. A pilot can react to
    // that, but not indefinitely and not while doing anything else — which is
    // precisely why the real aircraft has fly-by-wire and why REQUIREMENTS §5 puts
    // pitch-rate command in the assist layer.
    const { lon } = analyze(10000, 500)

    expect(lon.timeToDouble as number).toBeGreaterThan(0.5)
    expect(lon.timeToDouble as number).toBeLessThan(10)
  })

  it('is unstable at the reference CG across the whole envelope', () => {
    for (const [alt, vt] of [
      [0, 500], [10000, 500], [20000, 600], [30000, 700], [10000, 900],
    ] as const) {
      const { lon } = analyze(alt, vt)
      expect(lon.staticallyUnstable, `stable at ${alt} ft / ${vt} ft/s`).toBe(true)
    }
  })

  it('becomes stable when the CG moves forward', () => {
    // The falsifiable half. If the pitching-moment table or the CG correction were
    // wrong, stability would not respond to CG in the right direction — or at all.
    expect(analyze(10000, 500, atCG(0.2)).lon.staticallyUnstable).toBe(false)
    expect(analyze(10000, 500, atCG(0.25)).lon.staticallyUnstable).toBe(false)
    expect(analyze(10000, 500, atCG(0.3)).lon.staticallyUnstable).toBe(false)
  })

  it('gets progressively worse as the CG moves aft', () => {
    // Monotonic degradation. The short-period frequency falls toward zero, the pair
    // meets the real axis, and one root heads right. Textbook, and hard to produce
    // by accident.
    const forward = analyze(10000, 500, atCG(0.25)).lon
    const mid = analyze(10000, 500, atCG(0.3)).lon
    const reference = analyze(10000, 500).lon
    const aft = analyze(10000, 500, atCG(0.4)).lon

    // Frequency collapses as the neutral point is approached.
    expect(mid.shortPeriod?.wn as number).toBeLessThan(forward.shortPeriod?.wn as number)

    // Then divergence, worsening.
    expect(reference.staticallyUnstable).toBe(true)
    expect(aft.staticallyUnstable).toBe(true)
    expect(aft.timeToDouble as number).toBeLessThan(reference.timeToDouble as number)
  })

  it('crosses the neutral point between 0.33 and 0.35 c-bar', () => {
    // Locating the neutral point is a real, quotable property of the airframe, and
    // pins the transition rather than merely asserting it exists somewhere.
    expect(analyze(10000, 500, atCG(0.33)).lon.staticallyUnstable).toBe(false)
    expect(analyze(10000, 500, atCG(0.35)).lon.staticallyUnstable).toBe(true)
  })
})

describe('dutch roll (§4.2 test 4)', () => {
  // The lateral axis is conventionally stable at all CGs — relaxed stability was
  // applied longitudinally only. So this mode looks like the textbook throughout.
  const conditions = [
    [0, 500], [10000, 500], [20000, 600], [30000, 700], [10000, 300], [10000, 900],
  ] as const

  it('exists as an oscillatory mode everywhere in the envelope', () => {
    for (const [alt, vt] of conditions) {
      const { lat } = analyze(alt, vt)
      expect(lat.dutchRoll, `no dutch roll at ${alt} ft / ${vt} ft/s`).toBeDefined()
      expect(lat.dutchRoll?.oscillatory).toBe(true)
    }
  })

  it('is stable but lightly damped, as fighters are', () => {
    // Damping ratio around 0.09-0.16. Low enough to be noticeable as a wallow,
    // which is a real handling characteristic of this class of aircraft and part of
    // why REQUIREMENTS §5 wants an auto-coordination assist.
    //
    // The lower bound was 0.02 until the break-check (REQUIREMENTS §4.3) showed that
    // zeroing the yaw damping derivatives roughly HALVES this ratio and the test
    // still passed. A band loose enough to accept a model with no yaw damping is not
    // testing yaw damping. Tightened to the physically justified range for this
    // class of aircraft.
    for (const [alt, vt] of conditions) {
      const { lat } = analyze(alt, vt)
      const zeta = lat.dutchRoll?.zeta as number

      expect(zeta, `${alt} ft / ${vt} ft/s`).toBeGreaterThan(0.08)
      expect(zeta, `${alt} ft / ${vt} ft/s`).toBeLessThan(0.4)
    }
  })

  it('has the damping the converged model produces, within §4.2 tolerance', () => {
    // Regression pins, and labelled as such rather than dressed up as validation.
    // No published modal values for this model were available, so these come from
    // our own converged model at the point the suite was first trusted (after the
    // break-check passed). They cannot prove the model is right — the band checks
    // above and the CG-sweep tests do that work. What they add is SENSITIVITY: any
    // change shifting a damping ratio by more than the 10% REQUIREMENTS §4.2 allows
    // has to be a deliberate, visible act.
    const expected: Array<[number, number, number, number]> = [
      //  alt,    vt,   zeta,     wn
      [0, 500, 0.1371, 3.084],
      [10000, 500, 0.1237, 2.765],
      [20000, 600, 0.1063, 2.806],
      [30000, 700, 0.0911, 2.769],
      [10000, 300, 0.1585, 2.248],
      [10000, 900, 0.1121, 4.505],
    ]

    for (const [alt, vt, zeta, wn] of expected) {
      const { lat } = analyze(alt, vt)
      const at = `${alt} ft / ${vt} ft/s`

      expect(Math.abs((lat.dutchRoll?.zeta as number) - zeta) / zeta, `zeta at ${at}`).toBeLessThan(0.1)
      expect(Math.abs((lat.dutchRoll?.wn as number) - wn) / wn, `wn at ${at}`).toBeLessThan(0.1)
    }
  })

  it('has a natural frequency in the expected band', () => {
    for (const [alt, vt] of conditions) {
      const { lat } = analyze(alt, vt)
      const wn = lat.dutchRoll?.wn as number

      expect(wn, `${alt} ft / ${vt} ft/s`).toBeGreaterThan(1)
      expect(wn, `${alt} ft / ${vt} ft/s`).toBeLessThan(8)
    }
  })

  it('has a period of a couple of seconds', () => {
    const { lat } = analyze(10000, 500)
    expect(lat.dutchRoll?.period as number).toBeGreaterThan(1)
    expect(lat.dutchRoll?.period as number).toBeLessThan(5)
  })

  it('rises in frequency with airspeed', () => {
    // Directional stiffness scales with dynamic pressure, so the mode gets faster
    // as the aircraft goes faster.
    const slow = analyze(10000, 300).lat.dutchRoll?.wn as number
    const fast = analyze(10000, 900).lat.dutchRoll?.wn as number
    expect(fast).toBeGreaterThan(slow)
  })
})

describe('the other two lateral modes', () => {
  it('has strong roll subsidence', () => {
    // A fast real root: roll rate decays quickly when aileron is released. This is
    // roll damping (Clp) showing up directly, and it is what stops a held aileron
    // input from accelerating in roll without bound.
    const { lat } = analyze(10000, 500)

    expect(lat.rollSubsidence?.oscillatory).toBe(false)
    expect(lat.rollSubsidence?.eigenvalue.re as number).toBeLessThan(-1)
  })

  it('has a slow, near-neutral spiral mode', () => {
    // Spiral is always slow and close to neutral. Slightly stable here, meaning a
    // small bank left alone gradually rolls back level rather than tightening.
    const { lat } = analyze(10000, 500)

    expect(lat.spiral?.oscillatory).toBe(false)
    expect(Math.abs(lat.spiral?.eigenvalue.re as number)).toBeLessThan(0.1)
  })

  it('separates roll subsidence from spiral by at least a decade', () => {
    const { lat } = analyze(10000, 500)
    const fast = Math.abs(lat.rollSubsidence?.eigenvalue.re as number)
    const slow = Math.abs(lat.spiral?.eigenvalue.re as number)

    expect(fast / slow).toBeGreaterThan(10)
  })
})

describe('linearization machinery itself', () => {
  it('finds all four eigenvalues of each sub-system', () => {
    const { lon, lat } = analyze(10000, 500)
    expect(lon.all).toHaveLength(4)
    expect(lat.all).toHaveLength(4)
  })

  it('produces no NaN anywhere in the envelope', () => {
    for (const [alt, vt] of [[0, 500], [30000, 700], [10000, 300]] as const) {
      const { lon, lat } = analyze(alt, vt)
      for (const m of [...lon.all, ...lat.all]) {
        expect(Number.isFinite(m.eigenvalue.re)).toBe(true)
        expect(Number.isFinite(m.eigenvalue.im)).toBe(true)
        expect(Number.isFinite(m.wn)).toBe(true)
      }
    }
  })

  it('returns complex roots in conjugate pairs', () => {
    // A property of the eigenvalues of a real matrix. If it ever failed, the QR
    // implementation would be wrong in a way the damping numbers might not reveal.
    const { lat } = analyze(10000, 500)
    const complex = lat.all.filter((m) => m.oscillatory)

    expect(complex).toHaveLength(2)
    expect((complex[0] as (typeof complex)[number]).eigenvalue.re).toBeCloseTo(
      (complex[1] as (typeof complex)[number]).eigenvalue.re,
      9,
    )
    expect((complex[0] as (typeof complex)[number]).eigenvalue.im).toBeCloseTo(
      -((complex[1] as (typeof complex)[number]).eigenvalue.im),
      9,
    )
  })
})
