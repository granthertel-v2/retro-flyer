/**
 * Landing gear: spring-damper struts, tyre friction, brakes and nosewheel steering.
 *
 * REQUIREMENTS §3 asks for exactly this and labels the whole of it `[A]`. Nothing
 * here is traceable to the F-16 dataset — that dataset is aerodynamic coefficients,
 * and a gear model is not in it. So every constant below is a design choice with its
 * reasoning written next to it, and the tests assert the *consequences* (static
 * compression, weight split, stopping distance) rather than the constants, because
 * the consequences are the part anyone can argue with.
 *
 * ## How this reaches the flight model
 *
 * Not by modifying it. `dynamics.ts` exposes `ExternalLoads` — a body-axis force and
 * moment that defaults to zero and is exactly inert when it is zero. This file
 * computes that struct and the integrator applies it, once per RK4 stage, because a
 * strut's compression is a function of where the aircraft is and holding it constant
 * across a tick would reintroduce the first-order error RK4 exists to remove.
 *
 * The flight model does not know landing gear exists.
 *
 * ## Why this needs body-axis velocity
 *
 * See the note in `state.ts`. Every force here is a body-normal acceleration applied
 * at low airspeed, which is precisely the product the wind-axis formulation
 * multiplied by 1/vt.
 */

import { NO_EXTERNAL_LOADS, type ExternalLoads } from './dynamics.js'
import { Q, rotateBodyToNed, rotateNedToBody, type Quaternion } from './state.js'
import { REFERENCE_WEIGHT_LB, WING_AREA } from './massProperties.js'
import { clamp } from './envelope.js'
import { airData } from './atmosphere.js'
import type { GroundSource } from './ground.js'

/**
 * One strut.
 *
 * Contact point is given at full extension, in body axes from the CG: x forward,
 * y right, z down. So `z` is positive and is how far the wheel hangs below the CG.
 */
export interface Strut {
  name: string
  x: number
  y: number
  z: number
  /** Spring rate, lb/ft. */
  k: number
  /** Damping, lb-s/ft. */
  c: number
  /** Usable stroke before the strut bottoms out, ft. */
  stroke: number
  /** Whether this wheel has a brake. Mains do; the nosewheel does not. */
  braked: boolean
  /** Full steering deflection, radians. Zero for the mains. */
  steerMax: number
  /**
   * True for a contact point that drags rather than rolls.
   *
   * A wheel meets the ground with rolling resistance, a couple of percent of the
   * load. A fuselage meets it with the full sliding friction of the surface, which
   * is thirty times more. That difference is the whole character of a gear-up
   * landing, so it is a property of the contact point rather than of the ground.
   */
  scrapes?: boolean
}

/**
 * Gear geometry. `[A]` throughout.
 *
 * The longitudinal split is the load-bearing choice: the mains sit 2 ft behind the
 * CG and the nose 14 ft ahead of it, so the mains carry 14/16 of the weight and the
 * nose 1/8. A nosewheel aircraft has to be arranged that way round — mains behind
 * the CG or it sits on its tail — and 12.5% on the nose is the usual sort of
 * fraction. Track is +/-4 ft and the wheels hang 7 ft below the CG, both scaled off
 * the 30 ft span and a fuselage of about 49 ft rather than measured from anything.
 *
 * Rates are chosen from the static condition rather than picked. At 20,500 lb the
 * mains carry 8,969 lb each, so 26,000 lb/ft compresses them 0.35 ft — 29% of a
 * 1.2 ft stroke, which leaves most of the travel for the landing rather than the
 * parking. Damping is 0.6 of critical for the sprung mass each strut carries
 * (278.7 slug on a main gives 5,385 lb-s/ft critical, so 3,200), which settles a
 * touchdown in about one oscillation without making the strut feel like a rod.
 *
 * The resulting undamped natural frequency is 1.54 Hz, which at a 120 Hz tick is
 * 78 samples per cycle. Nothing here is numerically stiff.
 */
/**
 * The nosewheel.
 *
 * Its rates are sized by the *landing* case, not the parking one, and that
 * distinction was found the hard way. Sized from static load alone — 2,563 lb, which
 * is all a parked nosewheel carries — it came out at 8,500 lb/ft over a 1 ft stroke,
 * and then bottomed on every single arrival, gentle ones included: the aircraft
 * touches down on its mains at about 11 degrees alpha, which leaves the nosewheel
 * 2.8 ft in the air, and it arrives carrying 14,700 lb. A strut whose entire stroke
 * is worth 8,500 lb has nothing left to say about that.
 *
 * Swept against measured arrivals from 1.9 to 18.2 ft/s. 13,000 lb/ft over 1.3 ft is
 * the softest strut that stops bottoming across all of them, and — not obviously —
 * also the one with the lowest peak load, 9,816 lb against 11,692 for a strut half
 * again as stiff. A stiffer strut does not absorb more, it just hits harder.
 *
 * Static compression comes out at 0.20 ft, 15% of stroke, so the parking case is
 * still comfortable.
 */
export const NOSE_GEAR: Strut = {
  name: 'nose',
  x: 14,
  y: 0,
  z: 7,
  k: 13_000,
  c: 1_600,
  stroke: 1.3,
  braked: false,
  // 30 degrees. Enough to turn off a runway without being able to spin the aircraft
  // on the spot, which is what larger authority does at low speed.
  steerMax: (30 * Math.PI) / 180,
}

export const LEFT_MAIN: Strut = {
  name: 'left main',
  x: -2,
  y: -4,
  z: 7,
  k: 26_000,
  c: 3_200,
  stroke: 1.2,
  braked: true,
  steerMax: 0,
}

export const RIGHT_MAIN: Strut = { ...LEFT_MAIN, name: 'right main', y: 4 }

export const DEFAULT_GEAR: readonly Strut[] = [NOSE_GEAR, LEFT_MAIN, RIGHT_MAIN]

/**
 * The parts of the aircraft that are not wheels but can still touch the ground.
 *
 * These exist because the world was intangible without them. Ground reaction was
 * built entirely inside the gear, so retracting the wheels retracted the planet:
 * a flight test flew straight through a runway on a gear-up approach, and would have
 * flown through the ridge just as easily.
 *
 * REQUIREMENTS §1 puts damage out of scope, so hitting the ground is not modelled as
 * a crash — it is modelled as *contact*. The airframe gets contact points with the
 * same spring-damper treatment as a strut, and the differences are the ones that
 * matter: no shock absorber, so an order of magnitude stiffer and almost no travel;
 * no wheel, so `scrapes` is set and it drags at the full friction of the surface
 * instead of rolling; no brake and no steering. A gear-up arrival becomes a belly
 * landing that stops very fast and hurts, which is roughly the truth.
 *
 * Positions are `[A]`, scaled off the airframe: the belly a little under the CG, the
 * tail sixteen feet back where a tail strike happens, and the wingtips at the span.
 * They are deliberately few — this is a ground-contact model, not a collision mesh.
 */
export const BELLY: Strut = {
  name: 'belly',
  x: 0,
  y: 0,
  z: 2.6,
  // Stiff and heavily damped: structure, not an oleo. Short travel before it
  // bottoms, because there is nothing designed to compress.
  k: 90_000,
  c: 14_000,
  stroke: 0.35,
  braked: false,
  steerMax: 0,
  scrapes: true,
}

/**
 * The underside of the nose.
 *
 * Not decoration. Without something forward of the belly, a gear-up arrival has
 * nothing to stop it rotating: the scrape acts two and a half feet below the CG, so
 * it drives the nose down, and with no contact point ahead of the CG the aircraft
 * kept going — measured, past 78 degrees nose-down and into negative forward speed,
 * which is a cartwheel rather than a landing.
 */
export const NOSE_UNDERSIDE: Strut = { ...BELLY, name: 'nose underside', x: 18, z: 1.8 }

export const TAIL_SKID: Strut = { ...BELLY, name: 'tail', x: -16, z: 1.4 }
export const LEFT_WINGTIP: Strut = { ...BELLY, name: 'left wingtip', x: -1, y: -15, z: 1.2 }
export const RIGHT_WINGTIP: Strut = { ...LEFT_WINGTIP, name: 'right wingtip', y: 15 }

/** Contact points that are part of the aircraft, so they are never retracted. */
export const AIRFRAME_CONTACTS: readonly Strut[] = [
  NOSE_UNDERSIDE,
  BELLY,
  TAIL_SKID,
  LEFT_WINGTIP,
  RIGHT_WINGTIP,
]

/**
 * Largest force one contact point may produce, as a multiple of the aircraft's
 * weight. `[A]`
 *
 * Past this the real structure fails, and REQUIREMENTS §1 puts damage out of scope —
 * so the honest simplification is to stop the force growing rather than to pretend
 * an airframe can generate three million pounds and stay in one piece. Measured
 * without it: a bottomed contact produced 3e5 lb, the friction that came with it
 * produced half a million ft-lb of pitching moment, and the aircraft cartwheeled.
 *
 * Twelve is chosen to sit well above any survivable landing — the hardest arrival
 * the gear tests fly peaks near 5 g — while low enough to keep the integrator's feet
 * on the ground.
 */
const CONTACT_FORCE_LIMIT_G = 12

/**
 * Stiffness once a strut is out of stroke, as a multiple of its spring rate. `[A]`
 *
 * A bottomed strut is metal on metal. Ten times is firm enough that the aircraft
 * stops rather than sinking through the runway, and soft enough that a hard arrival
 * does not fire a force so large the integrator cannot follow it. It is a
 * deliberately blunt model of a genuinely violent event.
 */
const BOTTOMING_RATIO = 10

/**
 * Stroke over which the damper comes up to full authority, ft. `[A]`
 *
 * Without this the damper is at full strength the instant the wheel touches, when
 * compression is still zero — so the whole contact force is `c * closing speed`,
 * applied as a step. Measured on a 27 ft/s arrival: 173,871 lb in a single tick,
 * 8.5 times the aircraft's weight, from a strut that had not yet moved.
 *
 * That is not what happens. The first thing to touch a runway is a tyre, which is an
 * order of magnitude softer than the oleo behind it, and the oleo's damping orifice
 * only does anything once the piston is actually travelling. Fading the damper in
 * over the first two inches of stroke models both, and turns a step into a ramp.
 *
 * It is deliberately short. Longer, and a firm landing stops being firm.
 */
const DAMPING_FADE_FT = 0.16

/**
 * How much harder the strut damps extension than compression. `[A]`
 *
 * A real oleo has a recoil valve and is markedly stiffer on the way back out, for
 * exactly the reason this needs one: a strut that returns the energy it stored
 * throws the aircraft back off the runway it has just landed on. Measured before
 * this existed — touchdown, then airborne again 0.25 s later climbing at 1,100 fpm.
 *
 * Three times is within the usual range for recoil-to-compression damping, and it is
 * enough that a normal arrival settles instead of bouncing.
 */
const REBOUND_DAMPING_RATIO = 3

/**
 * Slip speed at which tyre friction reaches its full value, ft/s. `[A]`
 *
 * Below this, friction is proportional to slip velocity instead of jumping to full
 * Coulomb force. That ramp is not a fudge: `sign(v)` at v = 0 is a discontinuity a
 * fixed-step integrator answers by chattering between +mu and -mu every tick, which
 * shows up as a parked aircraft buzzing. Making friction linear through zero is the
 * standard fix and it also gives the aircraft something to stand still against.
 *
 * One ft/s is slow enough to be invisible — a rolling aircraft is always well past
 * it — and fast enough that the ramp is many ticks wide at 120 Hz.
 */
const SLIP_REFERENCE_FPS = 1.0

/**
 * Slip speed over which static friction decays to dynamic, ft/s. `[A]`
 *
 * REQUIREMENTS §3 asks for static and dynamic friction as separate things. They are
 * separated here by a Stribeck exponential rather than a mode switch: a wheel that
 * is barely moving grips harder than one that is sliding, and the transition is
 * continuous. A mode switch on `|v| < epsilon` is the other way to write this and it
 * puts a discontinuity exactly where the aircraft spends its whole parked life.
 */
const STRIBECK_FPS = 2.0

/**
 * How much more grip a stationary tyre has than a sliding one. `[A]`
 *
 * Rubber on dry concrete is usually quoted a little higher static than dynamic. 15%
 * is at the modest end, and it is enough to produce the one behaviour that matters:
 * breaking away takes more force than staying broken away.
 */
const STATIC_FRICTION_BONUS = 1.15

/**
 * Extra drag from the gear being down, as a change in drag coefficient referenced
 * to the wing area. `[A]`
 *
 * ## Why this is `[A]` and how it was chosen
 *
 * The NASA dataset behind this model is aerodynamic coefficients for the clean
 * airframe. Gear-down increments are not in it, and there is no honest way to make
 * one up and call it `[S]`. But the alternative that was here before is worse than
 * an assumption: gear down produced *exactly zero* drag, which is not a
 * simplification, it is a false statement about three struts and three wheels
 * hanging in the airstream.
 *
 * So it is estimated from first principles rather than quoted. An exposed strut and
 * wheel is a bluff body with a drag coefficient somewhere around 0.4 on its own
 * frontal area; the three legs together present very roughly 13 sq ft to the wind
 * against a 300 sq ft wing. That gives 0.4 * 13 / 300 ~= 0.017, rounded to 0.02
 * because the last digit of an estimate like this is not real.
 *
 * The number to argue with is the consequence, not the coefficient: it costs about
 * 800 lb of drag at 200 kt, which is close to what the engine makes at idle — so
 * lowering the gear roughly doubles how quickly the aircraft slows down on an
 * approach. That is the behaviour it exists to produce, and it is what a flight test
 * asked for after finding there was no way to lose speed at all.
 */
export const GEAR_DOWN_DELTA_CD = 0.02

/** Brake and steering commands. The assist layer decides what fills these. */
export interface GearInput {
  /** Wheel brakes, 0 to 1. Mains only. */
  brake: number
  /** Nosewheel steering, -1 full left to +1 full right. */
  steer: number
  /** Gear down and locked. Retracted gear touches nothing. */
  down: boolean
}

export const GEAR_UP: GearInput = { brake: 0, steer: 0, down: false }
export const GEAR_DOWN: GearInput = { brake: 0, steer: 0, down: true }

export interface GearState {
  /** Body-axis force and moment for `ExternalLoads`. */
  loads: ExternalLoads
  /** Anything — wheel or airframe — touching solid ground. */
  onGround: boolean
  /**
   * Compression of each **landing gear** strut, ft, in `struts` order.
   *
   * Always the same length and the same order, so `normal[0]` is the nosewheel
   * whatever else is happening. Airframe contact is reported separately rather than
   * appended here, because an array whose indices shift when the gear retracts is a
   * trap for every caller that reads one.
   */
  compression: number[]
  /** Normal force on each landing gear strut, lb. Zero when retracted. */
  normal: number[]
  /** True if any contact point is past the end of its travel. */
  bottomed: boolean
  /** Total vertical force being carried, lb — gear and airframe together. */
  totalNormal: number
  /** True if part of the aircraft that is not a wheel is touching the ground. */
  airframeContact: boolean
  /** Vertical force being carried by the airframe rather than the gear, lb. */
  airframeNormal: number
}

const AIRBORNE: GearState = {
  loads: NO_EXTERNAL_LOADS,
  onGround: false,
  compression: [0, 0, 0],
  normal: [0, 0, 0],
  bottomed: false,
  totalNormal: 0,
  airframeContact: false,
  airframeNormal: 0,
}

/**
 * Ground reaction for the current state.
 *
 * Pure: it reads the state and the world and returns a force. It holds nothing
 * between calls, which is what lets the integrator call it four times per tick at
 * four different states without any of them contaminating the others.
 */
export function gearLoads(
  v: readonly number[],
  ground: GroundSource,
  input: GearInput = GEAR_DOWN,
  struts: readonly Strut[] = DEFAULT_GEAR,
  airframe: readonly Strut[] = AIRFRAME_CONTACTS,
): GearState {
  // The gear retracts; the aeroplane does not. Everything that can touch the ground
  // is considered every tick, and only the wheels come and go.
  const contacts: { strut: Strut; gearIndex: number }[] = [
    ...(input.down ? struts.map((strut, gearIndex) => ({ strut, gearIndex })) : []),
    ...airframe.map((strut) => ({ strut, gearIndex: -1 })),
  ]

  const q: Quaternion = [
    v[Q.QW] as number,
    v[Q.QX] as number,
    v[Q.QY] as number,
    v[Q.QZ] as number,
  ]
  const vb: [number, number, number] = [v[Q.U] as number, v[Q.V] as number, v[Q.W] as number]
  const p = v[Q.P] as number
  const qRate = v[Q.Q_RATE] as number
  const r = v[Q.R] as number
  const alt = v[Q.ALT] as number
  const pn = v[Q.PN] as number
  const pe = v[Q.PE] as number

  // Where the nose is pointing, flattened into the horizontal plane. Wheels roll
  // along the ground, not along the longitudinal axis — at 12 degrees nose-up on
  // rotation those are noticeably different directions.
  const fwd = rotateBodyToNed(q, [1, 0, 0])
  const heading = Math.atan2(fwd[1], fwd[0])

  let fx = 0
  let fy = 0
  let fz = 0
  let l = 0
  let m = 0
  let n = 0
  let onGround = false
  let bottomed = false
  let totalNormal = 0

  // Fixed length, fixed order: one slot per landing gear strut, zero when retracted
  // or out of contact.
  const compression: number[] = struts.map(() => 0)
  const normal: number[] = struts.map(() => 0)
  let airframeNormal = 0
  let airframeContact = false

  // --- Drag from having the gear out ---------------------------------------
  // Applied whether or not a wheel is touching anything: this is the air, not the
  // runway. It acts along the relative wind, and at the wheels rather than at the
  // CG, so it also pitches the nose down slightly — which is what a real aircraft
  // does when the gear comes out.
  const vt = Math.hypot(vb[0], vb[1], vb[2])
  if (input.down && vt > 1) {
    const { qbar } = airData(vt, alt)
    const dragLb = qbar * WING_AREA * GEAR_DOWN_DELTA_CD

    // Opposite the velocity vector, in body axes.
    fx -= (dragLb * vb[0]) / vt
    fy -= (dragLb * vb[1]) / vt
    fz -= (dragLb * vb[2]) / vt

    // At the mean strut position, so the moment arm is real rather than assumed zero.
    let mx = 0
    let my = 0
    let mz = 0
    for (const s of struts) {
      mx += s.x / struts.length
      my += s.y / struts.length
      mz += s.z / struts.length
    }
    const dx = -(dragLb * vb[0]) / vt
    const dy = -(dragLb * vb[1]) / vt
    const dz = -(dragLb * vb[2]) / vt

    l += my * dz - mz * dy
    m += mz * dx - mx * dz
    n += mx * dy - my * dx
  }

  for (const { strut: s, gearIndex } of contacts) {
    const rBody: [number, number, number] = [s.x, s.y, s.z]
    const rNed = rotateBodyToNed(q, rBody)

    // rNed[2] is the DOWN component, so the contact point sits that far below the CG.
    const contactAlt = alt - rNed[2]
    const g = ground.sample(pn + rNed[0], pe + rNed[1])

    if (!g.solid) continue

    const squash = g.elevation - contactAlt
    if (squash <= 0) continue

    // Velocity of this contact point: the CG's velocity plus the rotation about it.
    // The cross-product term is what makes a wing-down landing put the load on one
    // main, and what lets the mains resist a yaw rate.
    const vcBody: [number, number, number] = [
      vb[0] + (qRate * s.z - r * s.y),
      vb[1] + (r * s.x - p * s.z),
      vb[2] + (p * s.y - qRate * s.x),
    ]
    const vcNed = rotateBodyToNed(q, vcBody)

    // Closing speed on the ground. Down is positive, so descending compresses.
    const squashRate = vcNed[2]

    // Spring: linear through the stroke, then very stiff.
    const withinStroke = Math.min(squash, s.stroke)
    const overStroke = Math.max(0, squash - s.stroke)
    if (overStroke > 0) bottomed = true

    const spring = s.k * withinStroke + s.k * BOTTOMING_RATIO * overStroke

    // Damping fades in over the first inches of stroke and is stiffer on the way
    // back out. See DAMPING_FADE_FT and REBOUND_DAMPING_RATIO — between them they
    // are the difference between landing and being thrown off the runway.
    const fade = Math.min(1, squash / DAMPING_FADE_FT)
    const extending = squashRate < 0
    const damping = s.c * fade * (extending ? REBOUND_DAMPING_RATIO : 1)

    // Saturated: see CONTACT_FORCE_LIMIT_G. Structure that would be failing is
    // modelled as structure that stops pushing harder.
    const N = Math.min(
      spring + damping * squashRate,
      CONTACT_FORCE_LIMIT_G * REFERENCE_WEIGHT_LB,
    )

    // A strut pushes; it never pulls. On the rebound the damper term goes strongly
    // negative — a main leaving the ground at 50 ft/s computes -151,000 lb — and
    // left alone that would suck the aircraft back onto a runway it is trying to
    // leave. This is the only guard: do not add a second `max(0, ...)` above, which
    // would make this branch unreachable and untestable.
    if (gearIndex >= 0) compression[gearIndex] = squash

    if (N <= 0) continue

    onGround = true
    totalNormal += N
    if (gearIndex >= 0) {
      normal[gearIndex] = N
    } else {
      airframeNormal += N
      airframeContact = true
    }

    // --- Friction ---------------------------------------------------------
    // The wheel rolls along its own heading, which for the nosewheel is steered.
    const steer = s.steerMax * clamp(input.steer, -1, 1)
    const wheel = heading + steer
    const cw = Math.cos(wheel)
    const sw = Math.sin(wheel)

    // Ground-relative velocity of the contact patch, split into roll and side.
    const vRoll = vcNed[0] * cw + vcNed[1] * sw
    const vSide = -vcNed[0] * sw + vcNed[1] * cw

    const mu = (slip: number, peak: number): number => {
      const speed = Math.abs(slip)
      // Static grip decays to dynamic as the tyre starts to slide.
      const stribeck = 1 + (STATIC_FRICTION_BONUS - 1) * Math.exp(-speed / STRIBECK_FPS)
      // ...and the whole thing ramps linearly through zero so a parked aircraft has
      // something to stand against rather than a sign flip to chatter on.
      return peak * stribeck * clamp(slip / SLIP_REFERENCE_FPS, -1, 1)
    }

    const brakeMu = s.braked ? clamp(input.brake, 0, 1) * g.friction : 0
    // A wheel rolls; a fuselage drags.
    const alongMu = s.scrapes ? g.friction : g.rollingResistance + brakeMu
    const rollForce = -N * mu(vRoll, alongMu)
    const sideForce = -N * mu(vSide, g.friction)

    // Assemble in NED: normal is up (negative down), friction is horizontal.
    const fNed: [number, number, number] = [
      rollForce * cw - sideForce * sw,
      rollForce * sw + sideForce * cw,
      -N,
    ]

    const fBody = rotateNedToBody(q, fNed)

    fx += fBody[0]
    fy += fBody[1]
    fz += fBody[2]

    // Moment about the CG, r x F.
    l += s.y * fBody[2] - s.z * fBody[1]
    m += s.z * fBody[0] - s.x * fBody[2]
    n += s.x * fBody[1] - s.y * fBody[0]
  }

  return {
    loads: { fx, fy, fz, l, m, n },
    onGround,
    compression,
    normal,
    bottomed,
    totalNormal,
    airframeContact,
    airframeNormal,
  }
}

/**
 * Static compression of each strut at rest, ft.
 *
 * Not used by the simulation — it is what a test asserts against and what a runway
 * spawn uses to place the aircraft on its gear rather than dropping it there.
 */
export function staticCompression(
  struts: readonly Strut[] = DEFAULT_GEAR,
  weight = REFERENCE_WEIGHT_LB,
): number[] {
  // Longitudinal balance about the CG: each strut's share is proportional to the
  // opposite arm. With the nose 14 ft ahead and the mains 2 ft behind, the mains
  // take 14/16 and the nose 2/16.
  const nose = struts.filter((s) => s.x > 0)
  const main = struts.filter((s) => s.x <= 0)

  const noseArm = nose.length > 0 ? Math.abs(nose[0]!.x) : 0
  const mainArm = main.length > 0 ? Math.abs(main[0]!.x) : 0
  const base = noseArm + mainArm

  return struts.map((s) => {
    const share =
      base === 0
        ? 1 / struts.length
        : s.x > 0
          ? mainArm / base / Math.max(1, nose.length)
          : noseArm / base / Math.max(1, main.length)
    return (share * weight) / s.k
  })
}

export interface RestingAttitude {
  /** Pitch the aircraft settles at, radians. Positive is nose up. */
  pitch: number
  /** Height of the CG above the ground when it is settled, ft. */
  cgHeight: number
}

/**
 * Where the aircraft sits when it is parked.
 *
 * Not level. Each strut compresses by its own static load over its own spring rate,
 * and those differ — the nosewheel carries an eighth of the weight on a strut sized
 * for landing loads, so it squashes 0.20 ft where a main squashes 0.35. The aircraft
 * therefore rests very slightly nose-up, half a degree of it.
 *
 * That half degree is not cosmetic. Placing the aircraft level instead and calling
 * it settled over-compresses the nose strut, and it starts the simulation carrying
 * 109% of its own weight and visibly shuffling for the first two seconds. A runway
 * spawn is supposed to be already still.
 *
 * Solved rather than guessed: for two struts to touch the same flat ground, their
 * contact points must sit at equal depth below the CG, which gives
 * `tan(pitch) = (z_nose - z_main) / (x_nose - x_main)` with each `z` reduced by that
 * strut's own static compression.
 */
export function restingAttitude(
  struts: readonly Strut[] = DEFAULT_GEAR,
  weight = REFERENCE_WEIGHT_LB,
): RestingAttitude {
  const squash = staticCompression(struts, weight)

  const nose = struts.findIndex((s) => s.x > 0)
  const main = struts.findIndex((s) => s.x <= 0)

  if (nose < 0 || main < 0) {
    const only = struts[0]
    return { pitch: 0, cgHeight: only ? only.z - (squash[0] as number) : 0 }
  }

  const zNose = (struts[nose] as Strut).z - (squash[nose] as number)
  const zMain = (struts[main] as Strut).z - (squash[main] as number)
  const xNose = (struts[nose] as Strut).x
  const xMain = (struts[main] as Strut).x

  const pitch = Math.atan2(zNose - zMain, xNose - xMain)

  return {
    pitch,
    cgHeight: -xMain * Math.sin(pitch) + zMain * Math.cos(pitch),
  }
}
