/**
 * Closed-loop stability across the envelope.
 *
 * `gains.test.ts` proves the placement is exact **at the anchors**. This proves the
 * schedule between them is not quietly unstable somewhere, which is a different
 * claim and the one that matters when flying: an aircraft spends almost none of its
 * time at a design point.
 *
 * The interpolated gains are not the gains a placement at that condition would
 * produce — they are a linear blend — so nothing guarantees they stabilise anything.
 * Between the two fastest anchors `kAlpha` even changes sign, so there is a
 * condition in there with no angle-of-attack feedback at all. This is the test that
 * says whether that matters.
 *
 * Stability is judged by Routh-Hurwitz on the characteristic polynomial rather than
 * by finding roots: it answers exactly the question asked, and cannot be wrong
 * because an iteration did not converge.
 */

import { describe, expect, it } from 'vitest'
import { S, computeMassProperties, jacobian, trim, type Controls } from '@retro-flyer/physics'
import {
  characteristicPolynomial,
  controlJacobian,
  isHurwitz,
  scheduledGains,
} from '../src/index.js'
import { fly, hold, peak } from './helpers.js'

const mass = computeMassProperties()

/** Conditions across the flyable envelope, deliberately not the anchor points. */
const SWEEP: readonly { alt: number; vt: number }[] = [
  { alt: 0, vt: 400 },
  { alt: 0, vt: 600 },
  { alt: 0, vt: 800 },
  { alt: 5_000, vt: 450 },
  { alt: 5_000, vt: 750 },
  { alt: 10_000, vt: 400 },
  { alt: 10_000, vt: 550 },
  { alt: 10_000, vt: 900 },
  { alt: 15_000, vt: 500 },
  { alt: 20_000, vt: 600 },
  { alt: 25_000, vt: 550 },
  { alt: 25_000, vt: 800 },
  { alt: 30_000, vt: 500 },
  { alt: 35_000, vt: 700 },
  { alt: 40_000, vt: 800 },
]

describe('the scheduled gains stabilise the aircraft', () => {
  it.each(SWEEP)('is Hurwitz at $alt ft, $vt ft/s', ({ alt, vt }) => {
    const solution = trim({ alt, vt })
    const u: Controls = {
      throttle: solution.throttle,
      elevator: solution.elevator,
      aileron: solution.aileron,
      rudder: solution.rudder,
    }

    const gains = scheduledGains(vt, alt)

    const A = jacobian(solution.state, u, [S.ALPHA, S.Q], mass)
    const B = controlJacobian(solution.state, u, 'elevator', [S.ALPHA, S.Q], mass)

    const aAug = [
      [A[0]![0] as number, A[0]![1] as number, 0],
      [A[1]![0] as number, A[1]![1] as number, 0],
      [0, -1, 0],
    ]
    const bAug = [B[0] as number, B[1] as number, 0]
    const K = [gains.kAlpha, gains.kQ, gains.kI]

    const closed = aAug.map((row, i) =>
      row.map((v, j) => v - (bAug[i] as number) * (K[j] as number)),
    )

    expect(isHurwitz(characteristicPolynomial(closed))).toBe(true)
  })

  it('is unstable open loop, which is why any of this is necessary', () => {
    // The premise of the whole assist layer. If the bare airframe were stable, the
    // pitch law would be a nicety and this suite would be measuring nothing.
    //
    // Instability lives in the full longitudinal system rather than in the
    // short-period pair alone, so this looks at all four states.
    const solution = trim({ alt: 30_000, vt: 700 })
    const u: Controls = {
      throttle: solution.throttle,
      elevator: solution.elevator,
      aileron: solution.aileron,
      rudder: solution.rudder,
    }

    const A = jacobian(solution.state, u, [S.VT, S.ALPHA, S.THETA, S.Q], mass)
    expect(isHurwitz(characteristicPolynomial(A))).toBe(false)
  })
})

describe('hands off, the aircraft holds what it was trimmed for', () => {
  it.each([
    { alt: 5_000, vt: 500 },
    { alt: 20_000, vt: 650 },
    { alt: 30_000, vt: 700 },
  ])('stays put for 40 s at $alt ft, $vt ft/s', ({ alt, vt }) => {
    const flight = fly({ alt, vt, seconds: 40 })

    expect(flight.diverged).toBe(false)
    expect(flight.departed).toBe(false)

    // The open-loop aircraft doubles a pitch disturbance in about 2.7 s, so over
    // 40 seconds an unaugmented one is long gone. Closed loop it should barely move.
    expect(peak(flight.samples.map((s) => s.state.qRate))).toBeLessThan(0.05)
    expect(Math.abs(flight.last.alphaDeg - flight.samples[0]!.alphaDeg)).toBeLessThan(2)
    expect(Math.abs(flight.last.state.alt - alt)).toBeLessThan(1_500)
  })

  it('recovers from a pitch disturbance rather than diverging', () => {
    // A one-second nose-up nudge, then hands off. Closed loop this settles; open
    // loop it is the start of a departure.
    const flight = fly({
      alt: 15_000,
      vt: 600,
      seconds: 25,
      input: (t) => ({ pitch: t < 1 ? 0.5 : 0, roll: 0, yaw: 0, throttle: 0.5 }),
    })

    expect(flight.diverged).toBe(false)

    const late = flight.samples.filter((s) => s.t > 15)
    expect(peak(late.map((s) => s.state.qRate))).toBeLessThan(0.06)
  })
})

describe('the roll axis settles', () => {
  it('stops rolling when the stick is released', () => {
    const flight = fly({
      alt: 10_000,
      vt: 600,
      seconds: 12,
      input: (t) => ({ pitch: 0, roll: t < 3 ? 1 : 0, yaw: 0, throttle: 0.5 }),
    })

    const late = flight.samples.filter((s) => s.t > 8)
    expect(peak(late.map((s) => s.pDeg))).toBeLessThan(12)
  })
})
