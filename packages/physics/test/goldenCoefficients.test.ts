/**
 * Tier A — aerodynamic coefficient port fidelity.
 *
 * This is the test that justifies its own existence more than any other in the
 * suite. The physics tests in REQUIREMENTS §4.2 all carry 5-10% tolerances, and a
 * single mistyped table coefficient moves results by far less than that. Without
 * this file, the suite could be entirely green while the aerodynamic model was
 * quietly, permanently wrong — and there would be no signal anywhere that said so.
 *
 * Tolerance is 1e-12, which is a few ULP on values of order 1. Anything looser
 * would let a real transcription error through; anything tighter would fail on
 * legitimate floating-point reassociation.
 *
 * The fixtures include out-of-range samples on purpose. The lookup extrapolates
 * past the table edges rather than clamping (see `src/tables/lookup.ts`), and that
 * behavior is part of the model, so it is pinned rather than left to chance.
 */

import { describe, expect, it } from 'vitest'
import golden from '../fixtures/golden-coefficients.json' with { type: 'json' }
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

const TOLERANCE = 1e-12

interface Case {
  in: { alpha: number; beta: number; el: number; ail: number; rdr: number }
  out: {
    cx: number
    cy: number
    cz: number
    cl: number
    cm: number
    cn: number
    dlda: number
    dldr: number
    dnda: number
    dndr: number
    dampp: number[]
  }
}

const cases = golden.cases as Case[]

/**
 * Compare against the reference, reporting the worst offender rather than the first.
 *
 * A failure message naming the single worst case and the operating point that
 * produced it is what turns "something is wrong" into a debuggable lead. Reporting
 * the first mismatch instead tends to point at whichever random sample happened to
 * come first, which says nothing about the size of the problem.
 */
function checkAll(
  label: string,
  compute: (c: Case) => number,
  expected: (c: Case) => number,
): void {
  let worst = 0
  let worstCase: Case | null = null
  let worstActual = 0
  let worstExpected = 0

  for (const c of cases) {
    const actual = compute(c)
    const want = expected(c)

    expect(Number.isFinite(actual), `${label} produced ${actual} at ${JSON.stringify(c.in)}`).toBe(true)

    const err = Math.abs(actual - want)
    if (err > worst) {
      worst = err
      worstCase = c
      worstActual = actual
      worstExpected = want
    }
  }

  expect(
    worst,
    `${label}: worst absolute error ${worst.toExponential(3)} ` +
      `(got ${worstActual}, want ${worstExpected}) at ${JSON.stringify(worstCase?.in)}`,
  ).toBeLessThan(TOLERANCE)
}

describe('static coefficients match the reference implementation', () => {
  it('has a substantial fixture to compare against', () => {
    // Guards against a truncated or mis-generated fixture silently making this
    // whole file vacuous.
    expect(cases.length).toBeGreaterThan(2000)
  })

  it('cx — axial force', () => {
    checkAll('cx', (c) => cx(c.in.alpha, c.in.el), (c) => c.out.cx)
  })

  it('cy — side force', () => {
    checkAll('cy', (c) => cy(c.in.beta, c.in.ail, c.in.rdr), (c) => c.out.cy)
  })

  it('cz — normal force', () => {
    checkAll('cz', (c) => cz(c.in.alpha, c.in.beta, c.in.el), (c) => c.out.cz)
  })

  it('cl — rolling moment', () => {
    checkAll('cl', (c) => cl(c.in.alpha, c.in.beta), (c) => c.out.cl)
  })

  it('cm — pitching moment', () => {
    checkAll('cm', (c) => cm(c.in.alpha, c.in.el), (c) => c.out.cm)
  })

  it('cn — yawing moment', () => {
    checkAll('cn', (c) => cn(c.in.alpha, c.in.beta), (c) => c.out.cn)
  })
})

describe('control derivatives match the reference implementation', () => {
  it('dlda — roll due to aileron', () => {
    checkAll('dlda', (c) => dlda(c.in.alpha, c.in.beta), (c) => c.out.dlda)
  })

  it('dldr — roll due to rudder', () => {
    checkAll('dldr', (c) => dldr(c.in.alpha, c.in.beta), (c) => c.out.dldr)
  })

  it('dnda — yaw due to aileron (adverse yaw)', () => {
    checkAll('dnda', (c) => dnda(c.in.alpha, c.in.beta), (c) => c.out.dnda)
  })

  it('dndr — yaw due to rudder', () => {
    checkAll('dndr', (c) => dndr(c.in.alpha, c.in.beta), (c) => c.out.dndr)
  })
})

describe('damping derivatives match the reference implementation', () => {
  const NAMES = ['cxq', 'cyr', 'cyp', 'czq', 'clr', 'clp', 'cnr', 'cnp', 'cmq']

  for (let i = 0; i < 9; i++) {
    it(`dampp[${i}] — ${NAMES[i]}`, () => {
      checkAll(
        `dampp[${i}] (${NAMES[i]})`,
        (c) => dampingArray(c.in.alpha)[i] as number,
        (c) => c.out.dampp[i] as number,
      )
    })
  }

  it('returns all nine derivatives', () => {
    expect(dampingArray(5)).toHaveLength(9)
  })
})

describe('coverage the fixtures are meant to provide', () => {
  it('includes samples outside the documented alpha range', () => {
    // The point of sampling out of range is to pin extrapolation behavior. If the
    // generator ever stopped doing so, this file would still pass while no longer
    // testing the thing it claims to.
    const outOfRange = cases.filter((c) => c.in.alpha < -10 || c.in.alpha > 45)
    expect(outOfRange.length).toBeGreaterThan(100)
  })

  it('includes samples outside the documented beta range', () => {
    const outOfRange = cases.filter((c) => Math.abs(c.in.beta) > 30)
    expect(outOfRange.length).toBeGreaterThan(100)
  })

  it('includes exact table nodes', () => {
    // Interpolation schemes fail most often exactly ON a node — off-by-one in the
    // index, or the wrong branch of the sign test when the weight is exactly zero.
    // Random sampling essentially never lands there.
    const onNode = cases.filter(
      (c) => Number.isInteger(c.in.alpha / 5) && c.in.alpha >= -10 && c.in.alpha <= 45,
    )
    expect(onNode.length).toBeGreaterThan(100)
  })
})
