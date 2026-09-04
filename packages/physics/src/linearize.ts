/**
 * Linearization and modal analysis (REQUIREMENTS §4.2 tests 3 and 4).
 *
 * ## What a "mode" is, for a reader without a flight dynamics background
 *
 * Disturb a trimmed aircraft — a gust, a stick rap — and it does not just return
 * smoothly to where it was. It oscillates in characteristic patterns, each with its
 * own frequency and its own rate of decay. Those patterns are the *modes*, and they
 * are properties of the airframe, not of the disturbance. Every aircraft has the
 * same small set:
 *
 * - **Short period.** Fast pitch oscillation, typically 1-4 rad/s, heavily damped.
 *   The aircraft bobs its nose and settles within a couple of seconds. This is the
 *   single mode that most determines whether an aircraft feels crisp or sloppy in
 *   pitch — it is what a pilot experiences as "response".
 * - **Phugoid.** Slow trade of airspeed against altitude, period tens of seconds,
 *   barely damped. Nose down, speed up, climb, slow down, repeat. Gentle enough to
 *   fly through without noticing.
 * - **Dutch roll.** Coupled yaw-and-roll wallow. The tail swings one way while the
 *   aircraft rolls the other. Poorly damped dutch roll is what makes an aircraft
 *   feel unpleasant in the lateral axis.
 * - **Roll subsidence** and **spiral**, both non-oscillatory.
 *
 * Two numbers describe each oscillatory mode. Natural frequency `wn` is how fast it
 * oscillates; damping ratio `zeta` is how quickly it dies out, where 0 oscillates
 * forever and 1 returns without overshooting at all.
 *
 * ## Why this is the sharpest test in the suite
 *
 * Trim only checks a static equilibrium — one point, no motion. Modal analysis
 * checks the *derivatives* of the forces and moments around that point, which is
 * where the damping tables and moment coupling live. A model can trim perfectly with
 * completely wrong pitch damping; it cannot produce the right short-period damping
 * ratio with wrong pitch damping. That makes these the tests most likely to catch a
 * subtly wrong table.
 *
 * ## Method
 *
 * Central finite differences to build the Jacobian at trim, then eigenvalues of the
 * relevant sub-block. Each complex conjugate pair is one oscillatory mode:
 * `lambda = -zeta*wn +/- i*wn*sqrt(1-zeta^2)`, so `wn = |lambda|` and
 * `zeta = -Re(lambda)/|lambda|`.
 *
 * Central differences rather than forward: the error is O(h^2) instead of O(h), and
 * with piecewise-linear tables underneath, the extra accuracy matters.
 */

import { S, STATE_SIZE, type Controls, derivative } from './dynamics.js'
import { computeMassProperties, type MassProperties } from './massProperties.js'

/** A complex number. */
export interface Complex {
  re: number
  im: number
}

/** An oscillatory or real mode extracted from the system eigenvalues. */
export interface Mode {
  eigenvalue: Complex
  /** Undamped natural frequency, rad/s. */
  wn: number
  /** Damping ratio; 0 oscillates forever, 1 returns without overshoot. */
  zeta: number
  /** Whether this mode oscillates (has a nonzero imaginary part). */
  oscillatory: boolean
  /** Period, seconds. Infinite for non-oscillatory modes. */
  period: number
  /**
   * Time to halve the disturbance amplitude, seconds. Negative means the mode is
   * DIVERGENT — the disturbance grows. That is not necessarily a bug: this airframe
   * is deliberately unstable in some configurations.
   */
  timeToHalf: number
}

/**
 * State indices making up the longitudinal sub-system.
 *
 * Airspeed, angle of attack, pitch rate, pitch attitude. In straight and level
 * flight the longitudinal and lateral dynamics decouple almost completely, so
 * analyzing them separately gives cleaner modes than one 13x13 eigen-decomposition
 * with position states cluttering it.
 */
export const LONGITUDINAL_STATES = [S.VT, S.ALPHA, S.Q, S.THETA] as const

/** Sideslip, roll rate, yaw rate, bank angle. */
export const LATERAL_STATES = [S.BETA, S.P, S.R, S.PHI] as const

/**
 * Jacobian of the state derivative with respect to a chosen subset of states.
 *
 * Perturbation size is 1% of the trim value, floored at 0.01 — the convention the
 * reference NASA tooling uses ([NASA-TM] p.12). Too small and floating-point noise
 * dominates; too large and the linear approximation stops being linear.
 */
export function jacobian(
  x0: readonly number[],
  u: Controls,
  states: readonly number[],
  mass: MassProperties = computeMassProperties(),
): number[][] {
  const n = states.length
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))

  for (let j = 0; j < n; j++) {
    const idx = states[j] as number
    const nominal = x0[idx] as number
    const h = Math.max(Math.abs(nominal) * 0.01, 0.01)

    const plus = x0.slice() as number[]
    const minus = x0.slice() as number[]
    plus[idx] = nominal + h
    minus[idx] = nominal - h

    const dPlus = derivative(plus, u, mass).xd
    const dMinus = derivative(minus, u, mass).xd

    for (let i = 0; i < n; i++) {
      const row = states[i] as number
      A[i]![j] = ((dPlus[row] as number) - (dMinus[row] as number)) / (2 * h)
    }
  }

  return A
}

/**
 * Eigenvalues of a real square matrix, via the unshifted QR algorithm.
 *
 * Written out rather than imported, for the same reason as the trim solver: the
 * physics package carries no runtime dependencies (REQUIREMENTS §10).
 *
 * The approach: repeated QR decomposition drives the matrix toward
 * quasi-upper-triangular form, where 1x1 diagonal blocks are real eigenvalues and
 * 2x2 blocks are complex conjugate pairs — which is exactly what the oscillatory
 * modes are. Adequate for the well-conditioned 4x4 systems here.
 */
export function eigenvalues(matrix: readonly (readonly number[])[]): Complex[] {
  const n = matrix.length
  let A = matrix.map((row) => [...row])

  for (let iter = 0; iter < 5000; iter++) {
    const { Q, R } = qrDecompose(A)
    A = matMul(R, Q)

    // Converged when everything below the first sub-diagonal is negligible.
    let offDiagonal = 0
    for (let i = 2; i < n; i++) {
      for (let j = 0; j < i - 1; j++) offDiagonal += Math.abs(A[i]![j] as number)
    }
    if (offDiagonal < 1e-14) break
  }

  // Read eigenvalues off the quasi-triangular result.
  const out: Complex[] = []
  let i = 0
  while (i < n) {
    const sub = i + 1 < n ? Math.abs(A[i + 1]![i] as number) : 0
    const scale = Math.abs(A[i]![i] as number) + (i + 1 < n ? Math.abs(A[i + 1]![i + 1] as number) : 0)

    if (i + 1 < n && sub > 1e-10 * Math.max(1, scale)) {
      // 2x2 block: a complex conjugate pair, i.e. an oscillatory mode.
      const a = A[i]![i] as number
      const b = A[i]![i + 1] as number
      const c = A[i + 1]![i] as number
      const d = A[i + 1]![i + 1] as number

      const tr = a + d
      const det = a * d - b * c
      const disc = tr * tr - 4 * det

      if (disc < 0) {
        const re = tr / 2
        const im = Math.sqrt(-disc) / 2
        out.push({ re, im }, { re, im: -im })
      } else {
        const root = Math.sqrt(disc)
        out.push({ re: (tr + root) / 2, im: 0 }, { re: (tr - root) / 2, im: 0 })
      }
      i += 2
    } else {
      out.push({ re: A[i]![i] as number, im: 0 })
      i += 1
    }
  }

  return out
}

/** Gram-Schmidt QR decomposition. */
function qrDecompose(A: readonly (readonly number[])[]): { Q: number[][]; R: number[][] } {
  const n = A.length
  const Q: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const R: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))

  for (let j = 0; j < n; j++) {
    let v = A.map((row) => row[j] as number)

    for (let i = 0; i < j; i++) {
      let dot = 0
      for (let k = 0; k < n; k++) dot += (Q[k]![i] as number) * (A[k]![j] as number)
      R[i]![j] = dot
      v = v.map((val, k) => val - dot * (Q[k]![i] as number))
    }

    const norm = Math.hypot(...v)
    R[j]![j] = norm

    if (norm > 1e-300) {
      for (let k = 0; k < n; k++) Q[k]![j] = (v[k] as number) / norm
    }
  }

  return { Q, R }
}

function matMul(A: readonly (readonly number[])[], B: readonly (readonly number[])[]): number[][] {
  const n = A.length
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = 0
      for (let k = 0; k < n; k++) sum += (A[i]![k] as number) * (B[k]![j] as number)
      out[i]![j] = sum
    }
  }

  return out
}

/** Convert an eigenvalue into the modal characteristics engineers quote. */
export function toMode(lambda: Complex): Mode {
  const wn = Math.hypot(lambda.re, lambda.im)
  const zeta = wn === 0 ? 0 : -lambda.re / wn
  const oscillatory = Math.abs(lambda.im) > 1e-9

  return {
    eigenvalue: lambda,
    wn,
    zeta,
    oscillatory,
    period: oscillatory ? (2 * Math.PI) / Math.abs(lambda.im) : Infinity,
    timeToHalf: lambda.re === 0 ? Infinity : Math.log(2) / -lambda.re,
  }
}

export interface LongitudinalModes {
  /**
   * Fast pitch oscillation — present only when the aircraft is longitudinally
   * STABLE. Undefined at aft CG, where the mode has split into two real roots.
   * See `shortPeriodRoots` and `staticallyUnstable`.
   */
  shortPeriod?: Mode
  /**
   * The two fast longitudinal roots, whatever form they take.
   *
   * With the CG forward these are a complex conjugate pair — the familiar
   * oscillatory short period. As the CG moves aft the pair migrates toward the real
   * axis, meets it, and splits into two real roots, one of which crosses into the
   * right half plane. At that point the aircraft is statically unstable in pitch and
   * "damping ratio" is no longer a meaningful description of it.
   */
  shortPeriodRoots: Mode[]
  /** Slow speed-altitude exchange. */
  phugoid?: Mode
  /**
   * True if any longitudinal root has a positive real part — the aircraft diverges
   * in pitch when disturbed, rather than returning.
   *
   * For this airframe at its reference CG of 0.35 c-bar, this is EXPECTED and
   * correct. The F-16 is deliberately built with relaxed longitudinal stability
   * (NASA TR-1538 is titled for it) and depends on fly-by-wire to fly at all.
   * REQUIREMENTS §3 places our equivalent in the assist layer.
   */
  staticallyUnstable: boolean
  /**
   * Time for a pitch disturbance to double in amplitude, seconds. Undefined when
   * stable. This is the number that says how much authority the pitch-rate assist
   * needs: at the reference CG it is a few seconds.
   */
  timeToDouble?: number
  all: Mode[]
}

/** Frequency below which a longitudinal mode is the phugoid rather than short period. */
const PHUGOID_MAX_WN = 0.5

export interface LateralModes {
  /** Coupled yaw-roll oscillation. */
  dutchRoll?: Mode
  /** Non-oscillatory roll damping. */
  rollSubsidence?: Mode
  /** Slow non-oscillatory bank divergence or convergence. */
  spiral?: Mode
  all: Mode[]
}

/**
 * Longitudinal modes at a trim point.
 *
 * Identification is by frequency, which is how these modes are actually
 * distinguished: the short period is fast (order 1 rad/s) and the phugoid is slow
 * (order 0.1 rad/s), separated by more than an order of magnitude. Sorting by
 * frequency and taking the fastest oscillatory pair is robust precisely because that
 * separation is so wide.
 */
export function longitudinalModes(
  x0: readonly number[],
  u: Controls,
  mass: MassProperties = computeMassProperties(),
): LongitudinalModes {
  const A = jacobian(x0, u, LONGITUDINAL_STATES, mass)
  const all = eigenvalues(A).map(toMode)

  // Separate by frequency, not by oscillatory-ness. The phugoid is always slow
  // (order 0.1 rad/s); the short-period pair is always fast, whether or not it is
  // still complex. Classifying by "is it a complex pair" instead would silently
  // mislabel the phugoid as the short period once the aircraft goes unstable —
  // which is exactly what happens at this airframe's reference CG.
  const slow = all.filter((m) => m.wn < PHUGOID_MAX_WN)
  const fast = all.filter((m) => m.wn >= PHUGOID_MAX_WN)

  const phugoid = slow
    .filter((m) => m.oscillatory && m.eigenvalue.im > 0)
    .sort((a, b) => b.wn - a.wn)[0]

  const shortPeriod = fast
    .filter((m) => m.oscillatory && m.eigenvalue.im > 0)
    .sort((a, b) => b.wn - a.wn)[0]

  const maxRealPart = Math.max(...all.map((m) => m.eigenvalue.re))
  const staticallyUnstable = maxRealPart > 1e-6

  const result: LongitudinalModes = {
    shortPeriodRoots: fast,
    staticallyUnstable,
    all,
  }

  if (shortPeriod) result.shortPeriod = shortPeriod
  if (phugoid) result.phugoid = phugoid
  if (staticallyUnstable) result.timeToDouble = Math.log(2) / maxRealPart

  return result
}

/**
 * Lateral-directional modes at a trim point.
 *
 * Dutch roll is the oscillatory pair. The two real roots are roll subsidence (fast,
 * strongly negative — this is roll damping) and spiral (slow, near zero and often
 * slightly positive, meaning a gradually steepening bank if left alone).
 */
export function lateralModes(
  x0: readonly number[],
  u: Controls,
  mass: MassProperties = computeMassProperties(),
): LateralModes {
  const A = jacobian(x0, u, LATERAL_STATES, mass)
  const all = eigenvalues(A).map(toMode)

  const result: LateralModes = { all }

  const dutch = all
    .filter((m) => m.oscillatory && m.eigenvalue.im > 0)
    .sort((a, b) => b.wn - a.wn)[0]
  if (dutch) result.dutchRoll = dutch

  // Sorted most-negative first: roll subsidence is the fast one, spiral the slow.
  const reals = all.filter((m) => !m.oscillatory).sort((a, b) => a.eigenvalue.re - b.eigenvalue.re)
  const fastest = reals[0]
  const slowest = reals[reals.length - 1]
  if (fastest) result.rollSubsidence = fastest
  if (slowest && reals.length > 1) result.spiral = slowest

  return result
}
