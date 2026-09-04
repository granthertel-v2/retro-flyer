/**
 * Gain design (§5, and §4.4's tuning boundary).
 *
 * The claim being tested is that the gains are *designed*, not guessed: that solving
 * the placement problem actually puts the closed-loop poles where the design targets
 * say. If it does not, the aircraft still might fly — it would just be flying on
 * arbitrary numbers, and Day 2's whole approach to an unflyable airframe would be
 * fiction.
 *
 * Verification is against the **characteristic polynomial**, not against
 * eigenvalues. Two systems have the same poles exactly when they have the same
 * characteristic polynomial, so this tests the same claim, and it cannot fail
 * because a root finder was imprecise. That is not a hypothetical concern here: the
 * physics package's unshifted QR reports these particular closed-loop matrices
 * wrongly, which is why `linalg.ts` carries its own root finder.
 */

import { describe, expect, it } from 'vitest'
import {
  S,
  computeMassProperties,
  jacobian,
  trim,
  type Controls,
} from '@retro-flyer/physics'
import {
  ANCHORS,
  PITCH_INTEGRATOR_POLE,
  PITCH_WN_MAX,
  PITCH_WN_MIN,
  PITCH_ZETA,
  ROLL_TAU,
  anchorGains,
  characteristicPolynomial,
  controlJacobian,
  designGains,
  isHurwitz,
  pitchWn,
  polynomialFromRoots,
  scheduledGains,
  secondOrderRoots,
} from '../src/index.js'

const mass = computeMassProperties()

function trimControls(alt: number, vt: number): { x0: number[]; u: Controls } {
  const s = trim({ alt, vt })
  return {
    x0: s.state,
    u: {
      throttle: s.throttle,
      elevator: s.elevator,
      aileron: s.aileron,
      rudder: s.rudder,
    },
  }
}

describe('pitch axis pole placement', () => {
  it.each(ANCHORS)('places the closed-loop poles exactly at $alt ft, $vt ft/s', ({ alt, vt }) => {
    const gains = designGains(alt, vt)
    const { x0, u } = trimControls(alt, vt)

    const A = jacobian(x0, u, [S.ALPHA, S.Q], mass)
    const B = controlJacobian(x0, u, 'elevator', [S.ALPHA, S.Q], mass)

    // The augmented system the law actually closes: (alpha, q, integrator).
    const aAug = [
      [A[0]![0] as number, A[0]![1] as number, 0],
      [A[1]![0] as number, A[1]![1] as number, 0],
      [0, -1, 0],
    ]
    const bAug = [B[0] as number, B[1] as number, 0]
    const K = [gains.kAlpha, gains.kQ, gains.kI]

    const closed = aAug.map((row, i) => row.map((v, j) => v - (bAug[i] as number) * (K[j] as number)))

    const wn = pitchWn(gains.qbar)
    const target = polynomialFromRoots([
      ...secondOrderRoots(PITCH_ZETA, wn),
      [-wn * PITCH_INTEGRATOR_POLE, 0],
    ])

    const actual = characteristicPolynomial(closed)

    actual.forEach((c, i) => {
      expect(c).toBeCloseTo(target[i] as number, 6)
    })
  })

  it('schedules the target frequency inside its bounds', () => {
    for (const qbar of [1, 40, 71, 159, 300, 431, 963, 4000]) {
      const wn = pitchWn(qbar)
      expect(wn).toBeGreaterThanOrEqual(PITCH_WN_MIN - 1e-12)
      expect(wn).toBeLessThanOrEqual(PITCH_WN_MAX + 1e-12)
    }

    // Monotonic in dynamic pressure: faster aircraft, sharper response.
    expect(pitchWn(500)).toBeGreaterThan(pitchWn(200))
  })
})

describe('roll and yaw', () => {
  it.each(ANCHORS)('places the roll mode no slower than the airframe at $alt ft, $vt ft/s', ({ alt, vt }) => {
    const gains = designGains(alt, vt)
    const { x0, u } = trimControls(alt, vt)

    const lp = jacobian(x0, u, [S.P], mass)[0]![0] as number
    const lda = controlJacobian(x0, u, 'aileron', [S.P], mass)[0] as number

    const closedLoopPole = lp - lda * gains.kRoll

    // Either we hit the target, or the airframe was already faster and the gain
    // stood down. Never slower than both.
    expect(closedLoopPole).toBeLessThanOrEqual(Math.min(lp, -1 / ROLL_TAU) + 1e-6)
  })

  it.each(ANCHORS)('damps the dutch roll without moving it at $alt ft, $vt ft/s', ({ alt, vt }) => {
    const gains = designGains(alt, vt)
    const { x0, u } = trimControls(alt, vt)

    const A = jacobian(x0, u, [S.BETA, S.R], mass)
    const B = controlJacobian(x0, u, 'rudder', [S.BETA, S.R], mass)
    const K = [gains.kBeta, gains.kR]

    const closed = A.map((row, i) => row.map((v, j) => v - (B[i] as number) * (K[j] as number)))
    const poly = characteristicPolynomial(closed)

    // Second order: s^2 + 2*zeta*wn*s + wn^2, so wn = sqrt(c0) and zeta = c1/(2*wn).
    const wn = Math.sqrt(poly[0] as number)
    const zeta = (poly[1] as number) / (2 * wn)

    expect(zeta).toBeCloseTo(0.75, 4)
    expect(isHurwitz(poly)).toBe(true)
  })
})

describe('the schedule', () => {
  it('spans a wide range of dynamic pressure', () => {
    // The anchors exist to be interpolated between. Anchors that all land at the
    // same q-bar give a schedule with nothing to interpolate over — which is what
    // the first four conditions tried here did, at 218, 220 and 228 lb/ft^2.
    const sets = anchorGains()
    const lowest = sets[0]!.qbar
    const highest = sets[sets.length - 1]!.qbar

    expect(highest / lowest).toBeGreaterThan(5)
  })

  it('is ordered by dynamic pressure and interpolates between anchors', () => {
    const sets = anchorGains()
    for (let i = 1; i < sets.length; i++) {
      expect(sets[i]!.qbar).toBeGreaterThan(sets[i - 1]!.qbar)
    }

    const a = sets[1]!
    const b = sets[2]!
    // A condition landing between two anchors should produce gains between theirs.
    const mid = scheduledGains(600, 15_000)
    expect(mid.qbar).toBeGreaterThan(a.qbar)
    expect(mid.qbar).toBeLessThan(b.qbar)
    expect(mid.kQ).toBeGreaterThan(Math.min(a.kQ, b.kQ) - 1e-9)
    expect(mid.kQ).toBeLessThan(Math.max(a.kQ, b.kQ) + 1e-9)
  })

  it('holds the end sets rather than extrapolating past them', () => {
    const sets = anchorGains()
    const slow = scheduledGains(200, 45_000)
    const fast = scheduledGains(1_400, 0)

    expect(slow.kAlpha).toBe(sets[0]!.kAlpha)
    expect(fast.kAlpha).toBe(sets[sets.length - 1]!.kAlpha)
  })
})
