/**
 * HUD geometry (REQUIREMENTS §9.1), with no canvas anywhere in it.
 *
 * A HUD splits cleanly into two halves and they have nothing to do with each other.
 * The **screen-fixed** half — airspeed and altitude tapes, the heading strip, the
 * Mach and G readouts — is a layout problem: pick a scale, emit ticks, draw them at
 * fixed pixel positions. The **conformal** half — pitch ladder, horizon, flight path
 * marker, boresight — is a projection problem: each symbol names a *direction in the
 * world*, and it belongs wherever that direction lands on the screen.
 *
 * Conformality is the whole point and it is not decoration. A flight path marker
 * drawn at "gamma degrees below the middle of the screen" is a number rendered as a
 * picture; it tells you nothing you could not read off the text overlay. A flight
 * path marker projected through the same camera matrix the terrain went through sits
 * **on the piece of ground the aircraft is going to hit**. That is the instrument
 * §9.1 is asking for, and it only works if the projection is real.
 *
 * So everything here is pure and every symbol that lives in the world is expressed
 * as a unit direction, projected as a point at infinity — `w = 0` in homogeneous
 * clip space. Points at infinity are the right model for HUD symbology (the horizon
 * really is infinitely far away, and so, for these purposes, is the ground the
 * velocity vector points at) and they conveniently sidestep the far plane: a symbol
 * can never be clipped for being too distant, only for being behind you.
 *
 * This file must not import three.js. That is what lets `test/hud.test.ts` check the
 * projection in Node, and projection is precisely the sort of thing that otherwise
 * gets debugged by squinting at a screen — the same argument `seam.ts` makes.
 */

export type Vec3 = readonly [number, number, number]

/** A three.js-order quaternion, `[x, y, z, w]`, as it comes off the §8.3 seam. */
export type Quat = readonly [number, number, number, number]

/** Where a world direction landed, in CSS pixels from the top-left of the canvas. */
export interface ScreenPoint {
  x: number
  y: number
}

export function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2])
  if (n === 0) return [0, 0, 0]
  return [v[0] / n, v[1] / n, v[2] / n]
}

/** Rotate a vector by a three.js-order quaternion. */
export function applyQuat(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q
  // t = 2 * (q_vec x v); v' = v + w*t + q_vec x t. Fewer operations than building
  // the matrix, and no chance of transposing it.
  const tx = 2 * (y * v[2] - z * v[1])
  const ty = 2 * (z * v[0] - x * v[2])
  const tz = 2 * (x * v[1] - y * v[0])

  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ]
}

/**
 * Project a world direction to screen pixels, or `null` if it is behind the camera.
 *
 * `viewProj` is projection * viewInverse in **column-major** order, which is what
 * `THREE.Matrix4.elements` hands over — pass it straight through. Getting that
 * backwards produces a HUD that is subtly, plausibly wrong rather than obviously
 * broken, so it is worth naming: element `[4]` is row 0 column 1.
 *
 * The direction is treated as a point at infinity (`w = 0`), so the fourth column of
 * the matrix — the translation — drops out entirely. Which is the correct physics:
 * moving the aircraft does not move the horizon.
 */
export function projectDirection(
  dir: Vec3,
  viewProj: ArrayLike<number>,
  width: number,
  height: number,
): ScreenPoint | null {
  const [x, y, z] = dir

  const cx = viewProj[0]! * x + viewProj[4]! * y + viewProj[8]! * z
  const cy = viewProj[1]! * x + viewProj[5]! * y + viewProj[9]! * z
  const cw = viewProj[3]! * x + viewProj[7]! * y + viewProj[11]! * z

  // Behind the camera. Not "off screen" — a point behind the eye projects to a
  // *mirrored* position in front of it, so drawing it anyway puts the horizon line
  // above the aircraft when you are looking away from it.
  if (cw <= 1e-9) return null

  return {
    x: ((cx / cw) * 0.5 + 0.5) * width,
    y: (0.5 - (cy / cw) * 0.5) * height,
  }
}

/**
 * The horizontal frame the pitch ladder is built in.
 *
 * three.js world axes here, as established by the seam: +X east, +Y up, +Z south.
 * So north — heading zero — is `-Z`.
 *
 * The ladder is referenced to the aircraft's **heading**, not to its nose vector.
 * Those differ whenever the aircraft is not wings-level, and heading is the one that
 * gives rungs which stay horizontal in the world and let the roll angle read off the
 * gap between the rung and the screen. Deriving the azimuth from the nose vector
 * instead would be degenerate pointing straight up, where a real HUD's ladder is
 * degenerate too — but it would also wobble under any bank at all, which a real one
 * does not.
 */
export function ladderBasis(headingDeg: number): { forward: Vec3; right: Vec3; up: Vec3 } {
  const psi = (headingDeg * Math.PI) / 180
  return {
    forward: [Math.sin(psi), 0, -Math.cos(psi)],
    right: [Math.cos(psi), 0, Math.sin(psi)],
    up: [0, 1, 0],
  }
}

/**
 * A direction at pitch `pitchDeg` above the horizon and `lateralDeg` off the nose.
 *
 * Spherical, in the heading frame: this is what makes a rung a piece of a great
 * circle rather than a straight line drawn across the screen, and it is why the
 * ladder curves correctly when the aircraft is banked hard.
 */
export function ladderDirection(
  basis: { forward: Vec3; right: Vec3; up: Vec3 },
  pitchDeg: number,
  lateralDeg: number,
): Vec3 {
  const p = (pitchDeg * Math.PI) / 180
  const l = (lateralDeg * Math.PI) / 180
  const cp = Math.cos(p)

  const a = cp * Math.cos(l)
  const b = cp * Math.sin(l)
  const c = Math.sin(p)

  return [
    a * basis.forward[0] + b * basis.right[0] + c * basis.up[0],
    a * basis.forward[1] + b * basis.right[1] + c * basis.up[1],
    a * basis.forward[2] + b * basis.right[2] + c * basis.up[2],
  ]
}

/**
 * Which rungs to draw.
 *
 * Every `step` degrees within `spanDeg` of where the aircraft is pointed, clamped to
 * the poles and excluding the horizon, which is drawn separately and wider. A ladder
 * that draws all 36 rungs regardless is mostly clutter: at any given moment 30 of
 * them are off screen and the two either side of the nose are the ones being read.
 */
export function ladderPitches(pitchDeg: number, spanDeg: number, step: number): number[] {
  const lowest = Math.ceil((pitchDeg - spanDeg) / step) * step
  const highest = Math.floor((pitchDeg + spanDeg) / step) * step

  const out: number[] = []
  for (let p = lowest; p <= highest + 1e-9; p += step) {
    const rounded = Math.round(p)
    if (rounded === 0 || rounded > 90 || rounded < -90) continue
    out.push(rounded)
  }
  return out
}

/** One graduation on a tape. `frac` is 0 at the start of the tape and 1 at the end. */
export interface Tick {
  value: number
  frac: number
  major: boolean
}

/**
 * Graduations for a moving tape.
 *
 * The tape moves and the pointer does not, which is the opposite of a round dial and
 * much easier to read a *trend* off: the numbers stream past at a rate proportional
 * to the rate of change. `frac` runs from 0 at the low end of the visible span to 1
 * at the high end; the caller decides which screen edge that is, so the same
 * function serves the airspeed tape (up is faster), the altitude tape (up is higher)
 * and the heading strip (right is clockwise).
 *
 * `wrap` handles the heading strip's only real difficulty: 355 and 005 are ten
 * degrees apart, and a tape that does not know that shows a blank gap crossing north
 * — which is where you most want the ticks.
 */
export function tapeTicks(o: {
  value: number
  span: number
  /** Integer, and a divisor of `majorStep`. Every tape here uses 5, 10 or 100. */
  minorStep: number
  majorStep: number
  /** Clamp: ticks below this are not emitted. Altitude has a floor; airspeed has zero. */
  min?: number | undefined
  max?: number | undefined
  /** Modulus for a circular scale. 360 for heading. */
  wrap?: number | undefined
}): Tick[] {
  const half = o.span / 2
  const low = o.value - half
  const high = o.value + half

  const first = Math.ceil(low / o.minorStep) * o.minorStep
  const out: Tick[] = []

  for (let value = first; value <= high + 1e-9; value += o.minorStep) {
    // `first` comes out of `Math.ceil`, so it is an exact integer, and adding an
    // integer step to it stays exact at every airspeed and altitude this aircraft
    // can reach. There was a rounding guard here against accumulated drift; a sweep
    // over the whole envelope at every step size found the drift to be exactly zero,
    // so it was removed rather than left in as a defence against nothing.
    const shown = o.wrap === undefined ? value : ((value % o.wrap) + o.wrap) % o.wrap

    if (o.wrap === undefined) {
      if (o.min !== undefined && value < o.min) continue
      if (o.max !== undefined && value > o.max) continue
    }

    out.push({
      value: shown,
      frac: (value - low) / o.span,
      major: shown % o.majorStep === 0,
    })
  }

  return out
}

/**
 * Where a heading sits on the strip, as a fraction, taking the short way round.
 *
 * Used for the steering diamond: the bearing to the next waypoint is an absolute
 * heading, and without the wrap it flies off the wrong end of the strip whenever the
 * course crosses north. Returns `null` when the target is outside the visible span.
 */
export function headingFrac(headingDeg: number, targetDeg: number, span: number): number | null {
  let delta = ((targetDeg - headingDeg + 540) % 360) - 180
  if (Math.abs(delta) > span / 2) return null
  return delta / span + 0.5
}

/** Bearing from one three.js world position to another, degrees true. */
export function bearingTo(from: { x: number; z: number }, to: { x: number; z: number }): number {
  // North is -Z and east is +X, so the bearing is atan2(east, north).
  const deg = (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI
  return (deg + 360) % 360
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Hold a symbol inside the HUD's field of view.
 *
 * Real HUDs cage the flight path marker rather than let it leave the glass, because
 * a marker that has vanished tells you nothing while a marker pinned to the edge
 * tells you which way it went. At high angle of attack, or in a slip, or on a steep
 * dive from a chase camera, the velocity vector genuinely does leave the frame, and
 * that is exactly when a beginner most needs to see where it is.
 *
 * `clamped` is reported so the caller can draw it differently — a caged marker is
 * not showing you a place on the ground any more, and pretending otherwise would be
 * a lie in the one instrument this project cares most about being honest.
 */
export function clampToBox(p: ScreenPoint, box: Box): { x: number; y: number; clamped: boolean } {
  const x = Math.min(box.right, Math.max(box.left, p.x))
  const y = Math.min(box.bottom, Math.max(box.top, p.y))
  return { x, y, clamped: x !== p.x || y !== p.y }
}
