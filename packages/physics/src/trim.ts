/**
 * Trim solver (REQUIREMENTS §4.1).
 *
 * ## What trim is, and why it is the foundation of everything else
 *
 * Trim is the set of control positions that holds a steady flight condition — the
 * aircraft is not accelerating in any axis, so it stays where it is put. Solving for
 * it means answering: at 500 ft/s and 10,000 ft, what angle of attack, elevator, and
 * throttle produce equilibrium?
 *
 * Nothing else in the validation suite works without it. Modal analysis linearizes
 * *about* a trim point. The energy test glides *from* one. A simulation session
 * starts *at* one. If trim is wrong, every downstream measurement is measuring the
 * wrong aircraft.
 *
 * It is also the only place in this package that verifies the model reproduces a
 * real F-16 rather than merely reproducing the reference implementation faithfully.
 * Tier A proves the port is right; trim proves the thing being ported is an
 * airplane.
 *
 * ## The method
 *
 * Nelder-Mead simplex on a weighted sum of squared equilibrium residuals.
 *
 * Not gradient descent, deliberately. The table lookups are piecewise linear, so
 * the objective has kinks — its derivative is discontinuous at every table node. A
 * gradient method reads those kinks as cliffs and stalls. Nelder-Mead never
 * evaluates a derivative, so it walks straight over them.
 *
 * Multi-started across several initial angles of attack because the objective is
 * not convex: at low speed there can be a second, high-alpha solution (the "back
 * side of the drag curve"), and a single start can land on the wrong one.
 *
 * The residual weights matter and are not cosmetic. `alphaDot` and `qDot` are
 * numerically much smaller than `vtDot` at the same physical significance, so
 * unweighted least squares would optimize airspeed equilibrium and ignore pitch
 * equilibrium entirely — producing a "trim" solution that is quietly pitching.
 */

import { S, STATE_SIZE, derivative } from './dynamics.js'
import { computeMassProperties, type MassProperties } from './massProperties.js'
import { tgear } from './aero/engine.js'
import { DEG_PER_RAD } from './units.js'

export interface TrimCondition {
  /** Altitude, ft. */
  alt: number
  /** True airspeed, ft/s. */
  vt: number
  /**
   * Flight path angle, radians. Zero is level flight; positive climbs.
   * REQUIREMENTS §4.1 asks for level, climbing, and turning conditions.
   */
  gamma?: number
  /** Turn rate, rad/s, for a steady coordinated turn. Zero for straight flight. */
  turnRate?: number
}

export interface TrimResult {
  /** Angle of attack, radians. */
  alpha: number
  /** Angle of attack, degrees — the form published trim tables use. */
  alphaDeg: number
  /** Elevator deflection, degrees. */
  elevator: number
  /** Throttle, 0 to 1. */
  throttle: number
  /** Bank angle, radians. Nonzero only for a turn. */
  phi: number
  /** Aileron deflection, degrees. Nonzero only for a turn. */
  aileron: number
  /** Rudder deflection, degrees. Nonzero only for a turn. */
  rudder: number
  /** Final residual. Should be ~1e-20 or below for a converged solution. */
  residual: number
  /** Whether the solve reached the convergence tolerance. */
  converged: boolean
  /** The trimmed state vector, ready to hand to the integrator. */
  state: number[]
}

/** Residual below which a solve counts as converged. */
const CONVERGENCE_TOLERANCE = 1e-16

/**
 * Weights on the three longitudinal equilibrium residuals.
 *
 * Chosen so that a physically equal error in each contributes comparably. Without
 * them the solver ignores pitch equilibrium; with them all three converge to ~1e-25.
 */
const W_VT_DOT = 1
const W_ALPHA_DOT = 100
const W_Q_DOT = 10

/**
 * Build the state vector for a candidate trim.
 *
 * The key relation is `theta = alpha + gamma`: pitch attitude is angle of attack
 * plus flight path angle. In level flight the nose sits above the horizon by
 * exactly the angle of attack, which is why an aircraft in level cruise is
 * nose-high.
 */
function trimState(
  cond: TrimCondition,
  alpha: number,
  throttle: number,
  phi: number,
  turnRate: number,
): number[] {
  const gamma = cond.gamma ?? 0
  const theta = alpha + gamma

  const x = new Array<number>(STATE_SIZE).fill(0)
  x[S.VT] = cond.vt
  x[S.ALPHA] = alpha
  x[S.BETA] = 0
  x[S.PHI] = phi
  x[S.THETA] = theta
  x[S.PSI] = 0
  x[S.ALT] = cond.alt
  // Power is set to its steady value for the throttle, bypassing the engine lag —
  // a trim point is by definition where the lag has finished acting.
  x[S.POWER] = tgear(throttle)

  if (turnRate !== 0) {
    // Body rates for a steady turn: the turn rate vector points down in the local
    // horizontal frame, resolved into body axes through the bank and pitch angles.
    x[S.P] = -turnRate * Math.sin(theta)
    x[S.Q] = turnRate * Math.sin(phi) * Math.cos(theta)
    x[S.R] = turnRate * Math.cos(phi) * Math.cos(theta)
  }

  return x
}

/**
 * Nelder-Mead simplex minimization.
 *
 * Written out rather than pulled from a dependency: the physics package deliberately
 * has no runtime dependencies (REQUIREMENTS §10 wants it headless and standalone),
 * and this is 60 lines.
 */
function nelderMead(
  f: (x: number[]) => number,
  start: number[],
  opts: { step?: number; maxIter?: number; tol?: number } = {},
): { x: number[]; fx: number; iterations: number } {
  const step = opts.step ?? 0.1
  const maxIter = opts.maxIter ?? 4000
  const tol = opts.tol ?? 1e-18

  const n = start.length

  // Initial simplex: the start point plus one perturbation along each axis.
  const simplex: number[][] = [start.slice()]
  for (let i = 0; i < n; i++) {
    const p = start.slice()
    p[i] = (p[i] as number) + (p[i] === 0 ? step : (p[i] as number) * 0.1 + step)
    simplex.push(p)
  }

  let values = simplex.map(f)
  let iterations = 0

  for (; iterations < maxIter; iterations++) {
    // Order worst-last.
    const order = values.map((v, i) => i).sort((a, b) => (values[a] as number) - (values[b] as number))
    const sorted = order.map((i) => simplex[i] as number[])
    const sortedVals = order.map((i) => values[i] as number)
    simplex.length = 0
    simplex.push(...sorted)
    values = sortedVals

    const best = values[0] as number
    const worst = values[n] as number

    if (Math.abs(worst - best) < tol && best < tol) break

    // Centroid of everything but the worst point.
    const centroid = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        centroid[j] = (centroid[j] as number) + ((simplex[i] as number[])[j] as number) / n
      }
    }

    const combine = (a: number[], b: number[], t: number): number[] =>
      a.map((v, i) => v + t * (v - (b[i] as number)) * 0 + t * ((b[i] as number) - v)).map(
        (_, i) => (a[i] as number) + t * ((b[i] as number) - (a[i] as number)),
      )

    const reflect = combine(centroid, simplex[n] as number[], -1)
    const fr = f(reflect)

    if (fr < (values[0] as number)) {
      const expand = combine(centroid, simplex[n] as number[], -2)
      const fe = f(expand)
      if (fe < fr) {
        simplex[n] = expand
        values[n] = fe
      } else {
        simplex[n] = reflect
        values[n] = fr
      }
    } else if (fr < (values[n - 1] as number)) {
      simplex[n] = reflect
      values[n] = fr
    } else {
      const contract = combine(centroid, simplex[n] as number[], 0.5)
      const fc = f(contract)
      if (fc < worst) {
        simplex[n] = contract
        values[n] = fc
      } else {
        // Shrink the whole simplex toward the best point.
        for (let i = 1; i <= n; i++) {
          simplex[i] = (simplex[i] as number[]).map(
            (v, j) => ((simplex[0] as number[])[j] as number) + 0.5 * (v - ((simplex[0] as number[])[j] as number)),
          )
          values[i] = f(simplex[i] as number[])
        }
      }
    }
  }

  const bestIdx = values.indexOf(Math.min(...values))
  return {
    x: simplex[bestIdx] as number[],
    fx: values[bestIdx] as number,
    iterations,
  }
}

/**
 * Solve for trim at a flight condition.
 *
 * Free variables are angle of attack, elevator, and throttle. For a turn, bank angle
 * is added and the residual gains the lateral equations.
 *
 * @param cond  Altitude, airspeed, and optionally flight path angle and turn rate
 * @param mass  Mass properties; defaults to the reference loadout
 */
export function trim(
  cond: TrimCondition,
  mass: MassProperties = computeMassProperties(),
): TrimResult {
  const turnRate = cond.turnRate ?? 0
  const turning = turnRate !== 0

  // Bank angle for a coordinated turn: tan(phi) = omega * V / g. A first guess for
  // the solver, and the exact answer in the small-gamma limit.
  const phiGuess = turning ? Math.atan((turnRate * cond.vt) / 32.17) : 0

  const cost = (z: number[]): number => {
    const alpha = z[0] as number
    const elevator = z[1] as number
    const throttle = z[2] as number
    const phi = turning ? (z[3] as number) : 0
    // A coordinated turn needs lateral controls too. Rolling into a bank and
    // holding it against the roll-yaw coupling takes aileron; keeping sideslip at
    // zero takes rudder. Without both free, the six turn residuals are being asked
    // of four unknowns and nothing converges.
    const aileron = turning ? (z[4] as number) : 0
    const rudder = turning ? (z[5] as number) : 0

    // Throttle outside [0, 1] is not a flight condition. Penalize rather than
    // hard-clamp: clamping creates a flat region the simplex can get lost on.
    let penalty = 0
    if (throttle < 0) penalty += 1e6 * throttle * throttle
    if (throttle > 1) penalty += 1e6 * (throttle - 1) * (throttle - 1)

    const clamped = Math.min(1, Math.max(0, throttle))
    const x = trimState(cond, alpha, clamped, phi, turnRate)

    // Unguarded: trim must be solved against the true model, not a clamped one, or
    // a "solution" could sit outside the data envelope and look converged.
    const { xd } = derivative(x, { throttle: clamped, elevator, aileron, rudder }, mass)

    let residual =
      (W_VT_DOT * (xd[S.VT] as number)) ** 2 +
      (W_ALPHA_DOT * (xd[S.ALPHA] as number)) ** 2 +
      (W_Q_DOT * (xd[S.Q] as number)) ** 2

    if (turning) {
      // A coordinated turn also needs zero sideslip rate and zero roll/yaw
      // acceleration; otherwise the "turn" is slowly departing.
      residual +=
        (W_ALPHA_DOT * (xd[S.BETA] as number)) ** 2 +
        (W_Q_DOT * (xd[S.P] as number)) ** 2 +
        (W_Q_DOT * (xd[S.R] as number)) ** 2
    }

    return residual + penalty
  }

  // Multi-start over angle of attack. The objective is not convex — at low speed a
  // second high-alpha solution exists — so a single start can converge to the wrong
  // branch or to nothing.
  const starts = [0.02, 0.05, 0.1, 0.2, 0.35]
  let best: { x: number[]; fx: number } | null = null

  for (const a0 of starts) {
    const z0 = turning ? [a0, -2, 0.3, phiGuess, 0, 0] : [a0, -2, 0.3]
    const r = nelderMead(cost, z0, { step: 0.05, maxIter: 12000, tol: 1e-20 })
    if (best === null || r.fx < best.fx) best = r
  }

  const z = (best as { x: number[]; fx: number }).x
  const residual = (best as { x: number[]; fx: number }).fx

  const alpha = z[0] as number
  const elevator = z[1] as number
  const throttle = Math.min(1, Math.max(0, z[2] as number))
  const phi = turning ? (z[3] as number) : 0
  const aileron = turning ? (z[4] as number) : 0
  const rudder = turning ? (z[5] as number) : 0

  return {
    alpha,
    alphaDeg: alpha * DEG_PER_RAD,
    elevator,
    throttle,
    phi,
    aileron,
    rudder,
    residual,
    converged: residual < CONVERGENCE_TOLERANCE,
    state: trimState(cond, alpha, throttle, phi, turnRate),
  }
}

/** Controls that hold a trim solution. */
export const trimControls = (t: TrimResult) => ({
  throttle: t.throttle,
  elevator: t.elevator,
  aileron: t.aileron,
  rudder: t.rudder,
})
