/**
 * Takeoff and landing through the real stack (REQUIREMENTS §9, Day 3 acceptance).
 *
 * Every other test in this package exercises one piece. This one flies the actual
 * `Simulation` off the actual authored runway with the actual assist layer, because
 * the failure modes Day 3 is most likely to have — a rate command winding up against
 * a strut, a rotation that will not rotate, a nosewheel that will not track — only
 * exist when all of it is connected.
 *
 * ## These assertions are deliberately hard to satisfy
 *
 * The first version of this file was not, and it passed a flight in which the
 * aircraft accelerated to 314 kt still on the runway, departed, and climbed away at
 * a sustained NEGATIVE three g. It passed because it only ever asked "did altitude
 * increase". So the checks here are on the *shape* of the flight — rotation speed,
 * ground roll, load factor, angle of attack, pitch attitude — and any one of them
 * would have caught that.
 *
 * The cause, for the record, was the stick sign: `input.ts` maps arrow-up to
 * `pitch: -1` because pushing forward lowers the nose (§5's stick convention), so
 * positive is BACK. Getting that backwards flies a perfectly self-consistent and
 * completely wrong aeroplane.
 */

import { describe, expect, it } from 'vitest'
import {
  PHYSICS_DT,
  Q,
  S,
  fpsToKt,
  ktToFps,
  quaternionFromEuler,
  toQuatVector,
  trim,
} from '@retro-flyer/physics'
import { NEUTRAL_INPUT, type RawInput } from '@retro-flyer/control'
import { Simulation } from '../src/loop.js'
import { AuthoredGroundSource } from '../src/terrain/groundSource.js'
import { authoredMap } from '../src/terrain/authored.js'
import { runwayStart } from '../src/spawn.js'
import { speedOf } from '../src/situation.js'

const ground = new AuthoredGroundSource(authoredMap)
const bayside = authoredMap.airfields.find((a) => a.name === 'Bayside')!
const FIELD_FT = bayside.elevation / 0.3048

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

interface Frame {
  t: number
  kt: number
  aglFt: number
  onGround: boolean
  pitchDeg: number
  alphaDeg: number
  nz: number
  bottomed: boolean
  crossTrackM: number
}

interface Run {
  frames: Frame[]
  liftoffAt: number | null
  groundRollM: number
}

/**
 * Fly a takeoff and climb out.
 *
 * The profile is what a pilot flies, not what is convenient to write: brakes on
 * while the engine spools, release, accelerate, rotate at a speed, then hold a climb
 * attitude. Holding full back stick instead — the obvious shortcut — loops the
 * aircraft, which is correct behaviour and useless as a test.
 */
function takeoff(seconds = 45, targetPitchDeg = 12): Run {
  const sim = new Simulation(runwayStart(bayside), undefined, ground)
  const frames: Frame[] = []
  const start: [number, number] = [sim.snapshot()[Q.PN] as number, sim.snapshot()[Q.PE] as number]
  const heading = (bayside.headingDeg * Math.PI) / 180

  let rotating = false
  let liftoffAt: number | null = null
  let groundRollM = 0

  for (let i = 0; i < Math.round(seconds / PHYSICS_DT); i++) {
    const t = i * PHYSICS_DT
    const s = sim.render()
    const kt = fpsToKt(speedOf(sim.snapshot()))

    // Gear up once safely climbing, as a takeoff actually is flown. Leaving it down
    // for the whole climb is not a profile anyone flies, and gear-down drag makes it
    // a measurably different one.
    const climbing = liftoffAt !== null && t > liftoffAt + 4
    sim.gearInput = { brake: t < 2 ? 1 : 0, steer: 0, down: !climbing }
    if (kt > 145) rotating = true

    // Proportional on pitch attitude with rate damping — rotate to the target, then
    // hold it. The damping term is not decoration: without it the hold rings after
    // any disturbance, and raising the gear is a disturbance. It overshot into
    // -0.03 g, which looks like the aeroplane bunting and is entirely the
    // instrument. A pilot damps with the same signal.
    const pitch = rotating
      ? clamp((targetPitchDeg - s.pitchDeg) * 0.08 - s.rates[1] * 0.02, -0.5, 0.6)
      : 0

    const input: RawInput = { ...NEUTRAL_INPUT, throttle: 1, pitch }
    sim.advance(PHYSICS_DT, () => input)

    const v = sim.snapshot()
    if (liftoffAt === null && !sim.onGround && t > 2.5) {
      liftoffAt = t
      groundRollM =
        Math.hypot((v[Q.PN] as number) - start[0], (v[Q.PE] as number) - start[1]) * 0.3048
    }

    if (i % 12 === 0) {
      const dn = (v[Q.PN] as number) - start[0]
      const de = (v[Q.PE] as number) - start[1]
      frames.push({
        t,
        kt,
        aglFt: s.altFt - FIELD_FT,
        onGround: sim.onGround,
        pitchDeg: s.pitchDeg,
        alphaDeg: s.alphaDeg,
        nz: sim.nz,
        bottomed: sim.gear.bottomed,
        crossTrackM: (de * Math.cos(heading) - dn * Math.sin(heading)) * 0.3048,
      })
    }
  }

  return { frames, liftoffAt, groundRollM }
}

describe('a takeoff from Bayside', () => {
  const run = takeoff()
  const { frames } = run
  const airborne = frames.filter((f) => !f.onGround && f.t > 3)
  const rolling = frames.filter((f) => f.onGround && f.t > 2.2)

  it('holds still on the brakes while the engine spools', () => {
    const held = frames.filter((f) => f.t < 2)
    expect(held.every((f) => f.kt < 5), 'rolled through the brakes').toBe(true)
    expect(held.every((f) => f.onGround)).toBe(true)
  })

  it('gets airborne at a plausible rotation speed', () => {
    expect(run.liftoffAt, 'never left the ground').not.toBeNull()

    const at = frames.find((f) => !f.onGround && f.t > 3)!
    expect(at.kt, 'rotated far too slowly').toBeGreaterThan(130)
    expect(at.kt, 'never rotated — ran off the end instead').toBeLessThan(230)
  })

  it('uses a length of runway an F-16 would use, and one Bayside has', () => {
    expect(run.groundRollM).toBeGreaterThan(250)
    expect(run.groundRollM).toBeLessThan(1_500)
    expect(run.groundRollM, 'longer than the runway').toBeLessThan(bayside.lengthM)
  })

  it('keeps the nose down until it is time to rotate', () => {
    // The wind-up failure: a pitch law fighting the nose strut, then releasing. It
    // shows as pitch attitude building during the roll rather than at the end of it.
    const early = rolling.filter((f) => f.kt < 120)
    for (const f of early) {
      expect(Math.abs(f.pitchDeg), `pitching at ${f.kt.toFixed(0)} kt`).toBeLessThan(3)
    }
  })

  it('rotates rather than leaping', () => {
    const at = frames.findIndex((f) => !f.onGround && f.t > 3)
    for (const f of frames.slice(at, at + 30)) {
      expect(Math.abs(f.pitchDeg), `pitch ran away at t=${f.t.toFixed(1)}`).toBeLessThan(25)
    }
  })

  it('never pulls more than a gentle g, and never pushes negative', () => {
    // The check the first version of this file was missing. A departure shows here
    // long before it shows in the altitude.
    //
    // The floor is not tighter than this on purpose. Raising the gear removes its
    // drag and the nose-down moment that came with it, so the aircraft unloads for a
    // moment while the attitude hold catches up — measured, 0.19 g about two seconds
    // after retraction. That is a configuration change, not a departure, and a bound
    // that called it one would be measuring the test's autopilot.
    for (const f of frames.filter((f) => f.t > 3)) {
      expect(f.nz, `${f.nz.toFixed(2)} g at t=${f.t.toFixed(1)}`).toBeGreaterThan(0.05)
      expect(f.nz, `${f.nz.toFixed(2)} g at t=${f.t.toFixed(1)}`).toBeLessThan(2.5)
    }
  })

  it('bleeds angle of attack as it accelerates, which is what a climb does', () => {
    const early = airborne.find((f) => f.t > (run.liftoffAt as number) + 2)!
    const late = airborne.at(-1)!

    expect(early.alphaDeg, 'no incidence just after rotation').toBeGreaterThan(2)
    expect(late.alphaDeg, 'alpha did not fall off as speed built').toBeLessThan(early.alphaDeg)
    // And never anywhere near the data envelope edge.
    for (const f of airborne) expect(f.alphaDeg).toBeLessThan(25)
  })

  it('climbs away and keeps climbing', () => {
    const last = frames.at(-1)!
    expect(last.onGround, 'came back down').toBe(false)
    expect(last.aglFt, 'not climbing').toBeGreaterThan(2_000)
    expect(last.kt, 'lost airspeed in the climb').toBeGreaterThan(250)
  })

  it('tracks the centreline instead of wandering off the side', () => {
    for (const f of rolling) {
      expect(Math.abs(f.crossTrackM), `off centreline at t=${f.t.toFixed(1)}`).toBeLessThan(
        bayside.widthM,
      )
    }
  })

  it('never bottoms a strut on a normal takeoff', () => {
    expect(frames.some((f) => f.bottomed)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

/**
 * Fly an arrival at a chosen sink rate and roll to a stop.
 *
 * ## Why the arrival is constructed rather than flown down from altitude
 *
 * What Day 3 added is the *contact* — strut, friction, rollout. Two earlier versions
 * of this helper tried to fly a real approach and both measured the approach
 * controller instead of the gear:
 *
 * - Setting a flight path angle and letting go: the aircraft was not trimmed for the
 *   condition, accelerated downward, and arrived at 27 ft/s while the test called it
 *   8 ft/s.
 * - A proportional controller on sink rate: sink feeds a pitch *rate* command, so the
 *   loop is a double integrator and it porpoised between -5 and +28 ft/s.
 *
 * So the aircraft is placed close in, at the alpha the **trim solver** returns for
 * the approach speed at field elevation — lift therefore balances weight — with the
 * whole aircraft pitched down by the flight path angle that produces the wanted
 * sink. Nothing has to be held, so nothing can oscillate, and the height is scaled
 * with the sink rate so every arrival gets about three seconds in the air. The rate
 * is then *measured* at the wheels rather than assumed.
 *
 * ## The technique matters too
 *
 * Touching down at 11 degrees alpha leaves the nosewheel nearly three feet up. Simply
 * releasing the stick drops it, so the profile below eases the nose down with back
 * pressure and brakes only once it is on — which is both what a pilot does and the
 * difference between a landing and an arrival in two parts.
 */
function land(targetSinkFps: number, kt = 160): Arrival {
  const heading = (bayside.headingDeg * Math.PI) / 180
  const vt = ktToFps(kt)

  const solution = trim({ alt: FIELD_FT + 40, vt })
  const alpha = solution.state[S.ALPHA] as number
  const gamma = Math.asin(clamp(-targetSinkFps / vt, -1, 1))
  const aglFt = targetSinkFps * 3 + 8

  const sim = new Simulation(runwayStart(bayside), undefined, ground)
  sim.setState(
    toQuatVector({
      vt,
      alpha,
      beta: 0,
      q: quaternionFromEuler(0, alpha + gamma, heading),
      p: 0,
      qRate: 0,
      r: 0,
      pn: -(bayside.z + Math.cos(heading) * (bayside.lengthM / 2 + 220)) / 0.3048,
      pe: (bayside.x - Math.sin(heading) * (bayside.lengthM / 2 + 220)) / 0.3048,
      alt: FIELD_FT + aglFt,
      power: solution.throttle * 100,
    }),
  )

  let touchdownAt: number | null = null
  let touchdownSinkFps = 0
  let noseDownAt: number | null = null
  let stoppedAt: number | null = null
  let peakNz = 0
  let peakNormalLb = 0
  let bottomed = false
  let wentAirborneAgain = false
  let touchdownPoint: [number, number] = [0, 0]
  let rolloutM = 0
  let lastSink = 0

  for (let i = 0; i < Math.round(60 / PHYSICS_DT); i++) {
    const t = i * PHYSICS_DT
    const s = sim.render()
    const v = sim.snapshot()
    const down = touchdownAt !== null

    const noseOn = (sim.gear.normal[0] ?? 0) > 500
    if (down && noseOn && noseDownAt === null) noseDownAt = t

    sim.gearInput = { brake: noseDownAt !== null ? 1 : 0, steer: 0, down: true }

    // Ease the nose down rather than dropping it, then hold it there.
    const pitch = down ? clamp((8 - s.pitchDeg) * 0.06, -0.1, 0.35) : 0
    if (!down) lastSink = -s.climbFpm / 60

    // Hold the approach speed rather than a fixed throttle. The trim solution is for
    // the clean aircraft, and this approach is flown gear-down — which now costs
    // real drag — so a fixed throttle would quietly decelerate and steepen the
    // descent, and the sink rate under test would no longer be the one commanded.
    const throttle = down
      ? 0
      : clamp(solution.throttle + (kt - s.kt) * 0.02, 0, 1)

    sim.advance(PHYSICS_DT, () => ({ ...NEUTRAL_INPUT, throttle, pitch }))

    if (touchdownAt === null && sim.onGround) {
      touchdownAt = t
      touchdownSinkFps = lastSink
      touchdownPoint = [v[Q.PN] as number, v[Q.PE] as number]
    }

    if (touchdownAt !== null) {
      if (t > touchdownAt + 0.4 && !sim.onGround) wentAirborneAgain = true
      peakNz = Math.max(peakNz, sim.nz)
      peakNormalLb = Math.max(peakNormalLb, sim.gear.totalNormal)
      bottomed = bottomed || sim.gear.bottomed
      rolloutM =
        Math.hypot(
          (v[Q.PN] as number) - touchdownPoint[0],
          (v[Q.PE] as number) - touchdownPoint[1],
        ) * 0.3048
      if (stoppedAt === null && fpsToKt(speedOf(v)) < 3) stoppedAt = t
    }
  }

  return {
    touchdownAt,
    touchdownSinkFps,
    stoppedAt,
    peakNz,
    peakNormalLb,
    bottomed,
    wentAirborneAgain,
    rolloutM,
    finite: sim.snapshot().every((n) => Number.isFinite(n)),
  }
}

interface Arrival {
  touchdownAt: number | null
  /** Sink rate in the instant before the wheels touched, ft/s. Measured, not assumed. */
  touchdownSinkFps: number
  stoppedAt: number | null
  peakNz: number
  peakNormalLb: number
  bottomed: boolean
  wentAirborneAgain: boolean
  rolloutM: number
  finite: boolean
}

describe('a landing at Bayside', () => {
  // Six feet per second. A firm-ish runway arrival, and deliberately not the 8 it
  // used to be: with the approach now holding its speed rather than a fixed
  // throttle, the commanded rate is the rate that actually arrives, and 8.6 ft/s is
  // a firm landing rather than a normal one.
  const normal = land(6)

  it('arrives at the sink rate it was asked for', () => {
    // The test's own instrument, checked first. Without this the numbers below are
    // labels rather than measurements — which is exactly how an earlier version of
    // this file called a 27 ft/s arrival "8 ft/s". It now tracks closely: measured
    // 4.7 / 6.6 / 8.6 / 12.5 for commanded 4 / 6 / 8 / 12.
    expect(normal.touchdownSinkFps).toBeGreaterThan(4)
    expect(normal.touchdownSinkFps).toBeLessThan(9)
  })

  it('touches down and rolls to a full stop', () => {
    expect(normal.touchdownAt, 'never touched down').not.toBeNull()
    expect(normal.stoppedAt, 'never stopped').not.toBeNull()
    expect(normal.finite).toBe(true)
  })

  it('stops inside the runway', () => {
    expect(normal.rolloutM).toBeLessThan(bayside.lengthM)
    expect(normal.rolloutM, 'stopped implausibly short').toBeGreaterThan(200)
  })

  it('does not bounce back into the air on a normal arrival', () => {
    // The classic ground-reaction failure, and one this model really had: the strut
    // stored the arrival energy and gave it straight back, putting the aircraft
    // airborne again a quarter of a second after touchdown, climbing at 1,100 fpm.
    // Fixed by damping extension harder than compression, which is what a real
    // oleo's recoil valve is for.
    expect(normal.wentAirborneAgain, 'bounced back off the runway').toBe(false)
    expect(normal.bottomed, 'bottomed a strut on a gentle arrival').toBe(false)
  })

  it('does not answer a gentle arrival with an enormous force', () => {
    // The other half of the same defect: full damping applied at first contact,
    // when the strut has not yet moved, produced 8.5 times the aircraft's weight in
    // one tick. A landing should be a few g, not an impact.
    //
    // The relationship is close to linear at about a quarter of a g per ft/s of
    // sink: 2.22 / 2.69 / 3.23 / 4.12 for 4.7 / 6.6 / 8.6 / 12.5 ft/s.
    expect(normal.peakNz, 'far too firm for a normal landing').toBeLessThan(3)
    expect(normal.peakNormalLb / 20_500, 'peak gear load, in aircraft weights')
      .toBeLessThan(4)
  })

  it('lands more firmly the harder it arrives', () => {
    const gentle = land(4)
    const firm = land(12)

    expect(firm.touchdownSinkFps).toBeGreaterThan(gentle.touchdownSinkFps)
    expect(firm.peakNz).toBeGreaterThan(gentle.peakNz)
  })

  it('takes a hard arrival without coming apart', () => {
    // 20 ft/s is a genuinely bad landing. It is allowed to hurt — measured 5.4 g —
    // and it is allowed to bottom a strut. It is not allowed to produce a NaN or to
    // launch the aircraft back into the sky.
    const r = land(20)

    expect(r.finite, 'hard landing produced a non-finite state').toBe(true)
    expect(r.touchdownAt).not.toBeNull()
    expect(r.peakNz, 'a hard arrival should register as one').toBeGreaterThan(normal.peakNz)
    expect(r.wentAirborneAgain, 'a hard arrival threw it back into the air').toBe(false)
  })

  it('does not bottom the nosewheel on any survivable arrival', () => {
    // The nose gear was originally sized from its parking load and bottomed on
    // every landing including the gentlest, because touching down at 11 degrees
    // alpha leaves it three feet in the air. See NOSE_GEAR.
    for (const sink of [4, 8, 12, 18]) {
      expect(land(sink).bottomed, `bottomed at ${sink} ft/s`).toBe(false)
    }
  })
})
