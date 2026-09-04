/**
 * Just enough linear algebra to place poles.
 *
 * Written out rather than imported, for the same reason the physics package writes
 * out its own QR iteration: this is a browser flight sim with no runtime
 * dependencies to spare, and these are textbook routines on matrices of order three.
 */

export type Matrix = number[][]
export type Vector = number[]

export function identity(n: number): Matrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  )
}

export function matmul(a: Matrix, b: Matrix): Matrix {
  const n = a.length
  const m = (b[0] as Vector).length
  const k = b.length

  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => {
      let sum = 0
      for (let t = 0; t < k; t++) sum += (a[i]![t] as number) * (b[t]![j] as number)
      return sum
    }),
  )
}

export function matvec(a: Matrix, v: Vector): Vector {
  return a.map((row) => row.reduce((sum, x, j) => sum + x * (v[j] as number), 0))
}

export function scale(a: Matrix, s: number): Matrix {
  return a.map((row) => row.map((x) => x * s))
}

export function add(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((x, j) => x + (b[i]![j] as number)))
}

/**
 * Matrix inverse by Gauss-Jordan elimination with partial pivoting.
 *
 * Returns null if the matrix is singular to working precision. Callers must check:
 * a singular controllability matrix means the mode cannot be moved with that input,
 * and silently returning garbage gains for an uncontrollable aircraft is worse than
 * refusing.
 */
export function inverse(m: Matrix): Matrix | null {
  const n = m.length
  const a = m.map((row) => [...row])
  const inv = identity(n)

  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row]![col] as number) > Math.abs(a[pivot]![col] as number)) pivot = row
    }

    if (Math.abs(a[pivot]![col] as number) < 1e-12) return null

    if (pivot !== col) {
      ;[a[col], a[pivot]] = [a[pivot] as Vector, a[col] as Vector]
      ;[inv[col], inv[pivot]] = [inv[pivot] as Vector, inv[col] as Vector]
    }

    const d = a[col]![col] as number
    for (let j = 0; j < n; j++) {
      a[col]![j] = (a[col]![j] as number) / d
      inv[col]![j] = (inv[col]![j] as number) / d
    }

    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = a[row]![col] as number
      if (factor === 0) continue
      for (let j = 0; j < n; j++) {
        a[row]![j] = (a[row]![j] as number) - factor * (a[col]![j] as number)
        inv[row]![j] = (inv[row]![j] as number) - factor * (inv[col]![j] as number)
      }
    }
  }

  return inv
}

/**
 * Coefficients of the monic polynomial with the given roots, lowest order first.
 *
 * `roots` are given as `[re, im]` pairs; complex roots must appear as conjugate
 * pairs, which makes the result real.
 */
export function polynomialFromRoots(roots: readonly (readonly [number, number])[]): number[] {
  // Multiply out (s - r) one root at a time, carrying complex coefficients and
  // discarding the imaginary residue at the end (it is zero for conjugate pairs).
  let re = [1]
  let im = [0]

  for (const [rr, ri] of roots) {
    const nextRe = new Array<number>(re.length + 1).fill(0)
    const nextIm = new Array<number>(re.length + 1).fill(0)

    for (let i = 0; i < re.length; i++) {
      // Multiply by s: shift up one order.
      nextRe[i + 1] = (nextRe[i + 1] as number) + (re[i] as number)
      nextIm[i + 1] = (nextIm[i + 1] as number) + (im[i] as number)
      // Multiply by -r.
      nextRe[i] = (nextRe[i] as number) - ((re[i] as number) * rr - (im[i] as number) * ri)
      nextIm[i] = (nextIm[i] as number) - ((re[i] as number) * ri + (im[i] as number) * rr)
    }

    re = nextRe
    im = nextIm
  }

  return re
}

/** Roots of `s^2 + 2*zeta*wn*s + wn^2`, as `[re, im]` pairs. */
export function secondOrderRoots(zeta: number, wn: number): [number, number][] {
  if (zeta >= 1) {
    const d = wn * Math.sqrt(zeta * zeta - 1)
    return [
      [-zeta * wn + d, 0],
      [-zeta * wn - d, 0],
    ]
  }

  const d = wn * Math.sqrt(1 - zeta * zeta)
  return [
    [-zeta * wn, d],
    [-zeta * wn, -d],
  ]
}

/**
 * State-feedback gains placing the closed-loop poles of `(A, B)` at `roots`.
 *
 * Ackermann's formula: `K = e_n^T C^-1 phi(A)`, with `C` the controllability matrix
 * and `phi` the desired characteristic polynomial evaluated at `A`. The result
 * satisfies `eig(A - B K) = roots`.
 *
 * Returns null when `(A, B)` is uncontrollable — the caller has to decide what to do
 * about an aircraft whose pitch mode cannot be moved by its elevator, and it is not
 * this function's place to invent a number.
 */
export function ackermann(
  A: Matrix,
  B: Vector,
  roots: readonly (readonly [number, number])[],
): Vector | null {
  const n = A.length

  // Controllability matrix C = [B, AB, ..., A^(n-1) B], as columns.
  const columns: Vector[] = []
  let v = [...B]
  for (let i = 0; i < n; i++) {
    columns.push([...v])
    v = matvec(A, v)
  }

  const C: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (columns[j] as Vector)[i] as number),
  )

  const Cinv = inverse(C)
  if (!Cinv) return null

  // phi(A) = A^n + a_{n-1} A^(n-1) + ... + a_0 I
  const coeffs = polynomialFromRoots(roots)
  let power = identity(n)
  let phi: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0))

  for (let i = 0; i <= n; i++) {
    phi = add(phi, scale(power, coeffs[i] as number))
    power = matmul(power, A)
  }

  // Last row of C^-1, times phi(A).
  const lastRow = Cinv[n - 1] as Vector
  return Array.from({ length: n }, (_, j) => {
    let sum = 0
    for (let i = 0; i < n; i++) sum += (lastRow[i] as number) * (phi[i]![j] as number)
    return sum
  })
}

// ---------------------------------------------------------------------------
// Characteristic polynomials and roots
// ---------------------------------------------------------------------------

/**
 * Characteristic polynomial of `A`, lowest order first, monic.
 *
 * Faddeev-LeVerrier. Exact arithmetic on the matrix entries, no iteration, no
 * convergence to worry about — which is why gain verification is done against these
 * coefficients rather than against eigenvalues. Two systems have the same poles if
 * and only if they have the same characteristic polynomial, so comparing
 * coefficients tests exactly what comparing eigenvalues would, and cannot be fooled
 * by a root finder having a bad day.
 */
export function characteristicPolynomial(A: Matrix): number[] {
  const n = A.length
  const coeffs = new Array<number>(n + 1).fill(0)
  coeffs[n] = 1

  let M = identity(n)

  for (let k = 1; k <= n; k++) {
    const AM = k === 1 ? A.map((r) => [...r]) : matmul(A, M)
    let trace = 0
    for (let i = 0; i < n; i++) trace += AM[i]![i] as number

    const c = -trace / k
    coeffs[n - k] = c

    M = add(AM, scale(identity(n), c))
  }

  return coeffs
}

export interface Complex {
  re: number
  im: number
}

/**
 * All roots of a real polynomial, by Durand-Kerner.
 *
 * Every root is refined simultaneously against the others, so a complex conjugate
 * pair separates cleanly rather than stalling an iteration that relies on
 * successive eigenvalue magnitudes differing.
 *
 * This exists rather than reusing the physics package's `eigenvalues()` because that
 * routine is an unshifted QR, and it stalls on the augmented closed-loop matrices
 * `gains.ts` builds. Concretely: the designed sea-level pitch system has poles at
 * -2.1 +/- 2.14i and -1.5, and the unshifted QR reports three real numbers whose sum
 * is right and whose product is off by a factor of two. (The open-loop 4x4
 * longitudinal and lateral systems it was written for it handles correctly — this is
 * a limitation on a matrix shape it was never asked to take, not a Day 1 defect.)
 *
 * `coeffs` are lowest order first, as `characteristicPolynomial` returns them.
 */
export function polynomialRoots(coeffs: readonly number[], iterations = 500): Complex[] {
  // Strip leading (highest-order) zeros so the degree is honest.
  let degree = coeffs.length - 1
  while (degree > 0 && Math.abs(coeffs[degree] as number) < 1e-14) degree--
  if (degree < 1) return []

  const lead = coeffs[degree] as number
  const a = coeffs.slice(0, degree + 1).map((c) => c / lead)

  const evaluate = (z: Complex): Complex => {
    let re = 0
    let im = 0
    for (let i = degree; i >= 0; i--) {
      const nextRe = re * z.re - im * z.im + (a[i] as number)
      im = re * z.im + im * z.re
      re = nextRe
    }
    return { re, im }
  }

  // Spread the initial guesses around a circle, off the real axis, so that a
  // symmetric polynomial does not start with every guess at the same point.
  const roots: Complex[] = Array.from({ length: degree }, (_, i) => {
    const angle = (2 * Math.PI * i) / degree + 0.35
    const r = 0.4 + 0.9 * Math.pow(Math.abs(a[0] as number) + 1, 1 / degree)
    return { re: r * Math.cos(angle), im: r * Math.sin(angle) }
  })

  for (let iter = 0; iter < iterations; iter++) {
    let moved = 0

    for (let i = 0; i < degree; i++) {
      const zi = roots[i] as Complex
      let denRe = 1
      let denIm = 0

      for (let j = 0; j < degree; j++) {
        if (i === j) continue
        const zj = roots[j] as Complex
        const dr = zi.re - zj.re
        const di = zi.im - zj.im
        const nextRe = denRe * dr - denIm * di
        denIm = denRe * di + denIm * dr
        denRe = nextRe
      }

      const num = evaluate(zi)
      const mag = denRe * denRe + denIm * denIm
      if (mag < 1e-300) continue

      const dRe = (num.re * denRe + num.im * denIm) / mag
      const dIm = (num.im * denRe - num.re * denIm) / mag

      roots[i] = { re: zi.re - dRe, im: zi.im - dIm }
      moved = Math.max(moved, Math.hypot(dRe, dIm))
    }

    if (moved < 1e-14) break
  }

  // Tidy: a conjugate pair's imaginary parts should be exact negatives, and a real
  // root's should be zero rather than 1e-16.
  return roots.map((r) => ({ re: r.re, im: Math.abs(r.im) < 1e-9 ? 0 : r.im }))
}

/** Eigenvalues of a small real matrix, via its characteristic polynomial. */
export function eigenvaluesOf(A: Matrix): Complex[] {
  return polynomialRoots(characteristicPolynomial(A))
}

/**
 * Routh-Hurwitz stability test on a monic-ish polynomial, lowest order first.
 *
 * True when every root has a strictly negative real part. Answers "is this stable"
 * without finding a single root, so a stability assertion cannot fail because a root
 * finder was imprecise.
 */
export function isHurwitz(coeffs: readonly number[]): boolean {
  const n = coeffs.length - 1
  if (n < 1) return false

  // Normalise so the leading coefficient is positive; a necessary condition is then
  // that every coefficient is positive.
  const lead = coeffs[n] as number
  if (lead === 0) return false
  const a = coeffs.map((c) => c / lead)

  for (const c of a) if (c <= 0) return false

  // Build the Routh array. Any non-positive entry in the first column means at
  // least one root in the closed right half plane.
  const rows = n + 1
  const cols = Math.floor(n / 2) + 1
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))

  for (let i = 0; i <= n; i++) {
    const row = i % 2
    const col = Math.floor(i / 2)
    if (col < cols) table[row]![col] = a[n - i] as number
  }

  for (let i = 2; i < rows; i++) {
    const above = table[i - 2] as number[]
    const prev = table[i - 1] as number[]
    const pivot = prev[0] as number

    if (Math.abs(pivot) < 1e-15) return false

    for (let j = 0; j + 1 < cols; j++) {
      table[i]![j] =
        ((pivot * (above[j + 1] as number)) - ((prev[j + 1] as number) * (above[0] as number))) /
        pivot
    }
  }

  for (let i = 0; i < rows; i++) {
    if ((table[i]![0] as number) <= 0) return false
  }

  return true
}
