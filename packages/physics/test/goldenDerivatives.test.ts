/**
 * Tier A — full 6DOF state derivative port fidelity.
 *
 * Where the coefficient tests validate the tables in isolation, this validates the
 * assembly: the build-up, the CG correction, the damping non-dimensionalization,
 * the force and moment equations, and the rotational coupling. Every one of those
 * is a place to lose a sign or a factor of 57.3, and none of them would be caught
 * by the coefficient tests.
 *
 * Compared relative rather than absolute, because the derivative components differ
 * by orders of magnitude — position rates run to ~1000 ft/s while alpha-dot is
 * ~0.01 rad/s, and a single absolute tolerance would be simultaneously too tight
 * for one and meaningless for the other.
 */

import { describe, expect, it } from 'vitest'
import golden from '../fixtures/golden-derivatives.json' with { type: 'json' }
import { S, STATE_SIZE, derivative } from '../src/dynamics.js'
import { REFERENCE_IMPL_MASS } from '../src/massProperties.js'

const TOLERANCE = 1e-12

const NAMES = [
  'vt', 'alpha', 'beta', 'phi', 'theta', 'psi',
  'p', 'q', 'r', 'pn', 'pe', 'alt', 'power',
]

interface Case {
  x: number[]
  u: number[]
  xd: number[]
  accel: { nz: number; ny: number; az: number; ay: number }
}

const cases = golden.cases as Case[]

const controlsOf = (c: Case) => ({
  throttle: c.u[0] as number,
  elevator: c.u[1] as number,
  aileron: c.u[2] as number,
  rudder: c.u[3] as number,
})

/** Relative error, with an absolute floor so near-zero components stay meaningful. */
function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.max(1e-6, Math.abs(expected))
}

describe('state derivative matches the reference implementation', () => {
  it('has a substantial fixture to compare against', () => {
    expect(cases.length).toBeGreaterThan(1500)
  })

  for (let i = 0; i < STATE_SIZE; i++) {
    it(`d(${NAMES[i]})/dt`, () => {
      let worst = 0
      let worstCase: Case | null = null
      let worstActual = 0
      let worstExpected = 0

      for (const c of cases) {
        const actual = derivative(c.x, controlsOf(c), REFERENCE_IMPL_MASS).xd[i] as number
        const want = c.xd[i] as number

        expect(
          Number.isFinite(actual),
          `d(${NAMES[i]})/dt produced ${actual} for state ${JSON.stringify(c.x)}`,
        ).toBe(true)

        const err = relErr(actual, want)
        if (err > worst) {
          worst = err
          worstCase = c
          worstActual = actual
          worstExpected = want
        }
      }

      expect(
        worst,
        `d(${NAMES[i]})/dt: worst relative error ${worst.toExponential(3)} ` +
          `(got ${worstActual}, want ${worstExpected}) at state ${JSON.stringify(worstCase?.x)} ` +
          `controls ${JSON.stringify(worstCase?.u)}`,
      ).toBeLessThan(TOLERANCE)
    })
  }
})

describe('load factors match the reference implementation', () => {
  it.each(['nz', 'ny', 'az', 'ay'] as const)('%s', (key) => {
    let worst = 0

    for (const c of cases) {
      const actual = derivative(c.x, controlsOf(c), REFERENCE_IMPL_MASS).accel[key]
      worst = Math.max(worst, relErr(actual, c.accel[key]))
    }

    expect(worst, `${key}: worst relative error ${worst.toExponential(3)}`).toBeLessThan(
      TOLERANCE,
    )
  })
})

describe('physical sanity of the assembled model', () => {
  // Independent of the fixtures. If the golden data were somehow regenerated wrong,
  // these would still catch a model that had stopped making sense.
  const level = (vt: number, alt: number, alphaRad: number): number[] => {
    const x = new Array<number>(STATE_SIZE).fill(0)
    x[S.VT] = vt
    x[S.ALPHA] = alphaRad
    x[S.THETA] = alphaRad // gamma = 0
    x[S.ALT] = alt
    x[S.POWER] = 50
    return x
  }

  const noControls = { throttle: 0.5, elevator: 0, aileron: 0, rudder: 0 }

  it('throttle drives the power state, and power drives thrust', () => {
    // Deliberately two steps. Thrust is a function of the POWER state, not of the
    // throttle command — throttle only sets where power is heading. So at a fixed
    // power state, moving the throttle changes nothing about acceleration this
    // instant; it changes how power is evolving.
    //
    // This is spool-up lag, and it is the reason a jet does not accelerate the
    // moment you push the throttle up.
    const x = level(500, 10000, 0.05)
    const idle = derivative(x, { ...noControls, throttle: 0.2, elevator: -1 })
    const mil = derivative(x, { ...noControls, throttle: 0.9, elevator: -1 })

    // Same instantaneous acceleration...
    expect(mil.xd[S.VT] as number).toBeCloseTo(idle.xd[S.VT] as number, 12)
    // ...but power is spooling up in one case and down in the other.
    expect(mil.xd[S.POWER] as number).toBeGreaterThan(0)
    expect(idle.xd[S.POWER] as number).toBeLessThan(0)

    // And once power has actually risen, acceleration follows.
    const spooled = level(500, 10000, 0.05)
    spooled[S.POWER] = 90
    expect(
      derivative(spooled, { ...noControls, throttle: 0.9, elevator: -1 }).xd[S.VT] as number,
    ).toBeGreaterThan(idle.xd[S.VT] as number)
  })

  it('nose-up elevator produces nose-up pitch acceleration', () => {
    // Elevator is positive trailing-edge-down, which pitches the nose DOWN, so a
    // nose-up command is a negative deflection. Getting this sign backwards makes
    // the aircraft uncontrollable in a way that is obvious in flight and completely
    // invisible to a trim test.
    const x = level(500, 10000, 0.05)
    const noseUp = derivative(x, { ...noControls, elevator: -10 })
    const noseDown = derivative(x, { ...noControls, elevator: 10 })

    expect(noseUp.xd[S.Q] as number).toBeGreaterThan(noseDown.xd[S.Q] as number)
  })

  it('positive aileron rolls LEFT in this model', () => {
    // Sign convention, pinned because it is counterintuitive and because the assist
    // layer (REQUIREMENTS §5) has to map stick input onto it. Every entry in the
    // dlda table is negative, so positive aileron deflection produces a negative
    // rolling moment. Stick-right will therefore command NEGATIVE aileron.
    //
    // Writing this down here means the mapping gets made deliberately once, rather
    // than discovered by flying inverted into a hillside.
    const x = level(500, 10000, 0.05)
    const positive = derivative(x, { ...noControls, elevator: -1, aileron: 10 })
    const negative = derivative(x, { ...noControls, elevator: -1, aileron: -10 })

    expect(positive.xd[S.P] as number).toBeLessThan(0)
    expect(negative.xd[S.P] as number).toBeGreaterThan(0)
    expect(positive.xd[S.P] as number).toBeLessThan(negative.xd[S.P] as number)
  })

  it('roll damping opposes an established roll rate', () => {
    // Clp is negative, so rolling produces a moment resisting the roll. Without
    // this the aircraft would accelerate in roll indefinitely under held aileron.
    const rolling = level(500, 10000, 0.05)
    rolling[S.P] = 2.0

    const still = level(500, 10000, 0.05)

    expect(derivative(rolling, { ...noControls, elevator: -1 }).xd[S.P] as number).toBeLessThan(
      derivative(still, { ...noControls, elevator: -1 }).xd[S.P] as number,
    )
  })

  it('climbs when the nose is up and descends when it is down', () => {
    const up = level(500, 10000, 0.05)
    up[S.THETA] = 0.3
    const down = level(500, 10000, 0.05)
    down[S.THETA] = -0.3

    expect(derivative(up, noControls).xd[S.ALT] as number).toBeGreaterThan(0)
    expect(derivative(down, noControls).xd[S.ALT] as number).toBeLessThan(0)
  })

  it('sideslip produces a restoring yawing moment (weathercock stability)', () => {
    // Positive beta means the velocity vector lies to the RIGHT of the nose. To
    // remove the sideslip the nose must swing right, which is positive yaw rate. So
    // a directionally stable aircraft answers positive beta with positive r-dot.
    //
    // Pinned independently of the dutch roll test, which would silently assume it.
    const right = level(500, 10000, 0.05)
    right[S.BETA] = 0.1
    const left = level(500, 10000, 0.05)
    left[S.BETA] = -0.1

    expect(derivative(right, { ...noControls, elevator: -1 }).xd[S.R] as number).toBeGreaterThan(0)
    expect(derivative(left, { ...noControls, elevator: -1 }).xd[S.R] as number).toBeLessThan(0)
  })

  it('sideslip produces a rolling moment away from the sideslip (dihedral effect)', () => {
    // The other half of what couples roll and yaw into the dutch roll mode.
    // Sideslip right rolls left, which is what makes an uncoordinated turn tend to
    // self-correct — and what the auto-coordination assist has to work with.
    const x = level(500, 10000, 0.05)
    x[S.BETA] = 0.1

    expect(derivative(x, { ...noControls, elevator: -1 }).xd[S.P] as number).toBeLessThan(0)
  })

  it('pulling produces positive normal load factor', () => {
    const x = level(500, 10000, 0.05)
    expect(derivative(x, { ...noControls, elevator: -15 }).accel.nz).toBeGreaterThan(0)
  })
})
