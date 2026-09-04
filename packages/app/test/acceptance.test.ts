/**
 * The Day 3 acceptance criterion, flown (REQUIREMENTS §9).
 *
 *   "Complete a runway-to-runway flight through the course."
 *
 * This is the milestone itself, executable. It starts the aircraft cold on the
 * Bayside runway, takes off, flies all three course gates inside their altitude
 * bands, flies an approach to Ridgeview, lands, and brakes to a full stop — through
 * the real `Simulation`, the real assist layer, the real gear model and the real
 * authored map. Nothing is teleported and no state is written by hand after the
 * spawn.
 *
 * ## Why it lives here rather than in a browser
 *
 * It was flown by hand in a browser first, and that found things a green suite never
 * would. But a session is not a test: it has to be redone every time, it cannot be
 * bisected, and the run this file replaces was lost twice to the browser extension
 * dropping mid-flight. The renderer still needs a human — see the note at the end —
 * but "does the aeroplane complete the course" is a question a machine should be
 * answering on every commit.
 *
 * ## The autopilot is a test instrument, not a feature
 *
 * `Autopilot` below is not part of the product and is deliberately not exported from
 * `src/`. It exists so the flight is repeatable. It is a plain cascade — bearing to
 * bank, altitude to flight path angle, speed to throttle — and every one of its
 * gains was arrived at by measuring a failure:
 *
 * - Commanding **vertical speed** instead of flight path angle settles at an offset
 *   rather than tracking, and arrived over the threshold 951 ft high.
 * - Tracking the **centreline** rather than a bearing cannot converge from off to
 *   the side; it orbits the field.
 * - Descending onto a glideslope computed from **field elevation** with no terrain
 *   floor flew the aircraft into a hillside 16 km out at 66 g.
 *
 * Those are recorded because they are the ways this instrument breaks, and a broken
 * instrument reporting a broken aeroplane is the worst outcome available here.
 *
 * ## Reading a failure
 *
 * Every assertion below reports the phase and the numbers. If the course does not
 * complete, `summary()` prints a phase-by-phase profile — where it was, how fast,
 * how high, how much g — so the question is "which phase went wrong" rather than
 * "expected complete to be complete".
 */

import { describe, expect, it } from 'vitest'
import { PHYSICS_DT, fpsToKt } from '@retro-flyer/physics'
import { NEUTRAL_INPUT, type RawInput } from '@retro-flyer/control'
import { Simulation } from '../src/loop.js'
import { AuthoredGroundSource } from '../src/terrain/groundSource.js'
import { authoredMap } from '../src/terrain/authored.js'
import { runwayStart } from '../src/spawn.js'
import { buildCourse } from '../src/course.js'
import { speedOf } from '../src/situation.js'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const wrap = (d: number): number => {
  let x = d
  while (x > 180) x -= 360
  while (x < -180) x += 360
  return x
}
const mToFt = (m: number): number => m / 0.3048

/** Control update rate, Hz. The physics still runs at 120 inside `advance`. */
const CONTROL_HZ = 20
const CONTROL_DT = 1 / CONTROL_HZ

/** Target speed on final, knots. `[A]` — a test instrument's number, not the model's. */
const APPROACH_KT = 165

/** Glideslope, radians. Three degrees, as everywhere. */
const SLOPE_RAD = (3 * Math.PI) / 180

type Phase = 'roll' | 'rotate' | 'climb' | 'gate' | 'transit' | 'approach' | 'flare' | 'rollout' | 'stopped'

interface Sample {
  t: number
  phase: Phase
  x: number
  z: number
  altFt: number
  aglFt: number
  /** Height above the terrain directly beneath, ft. */
  clearFt: number
  kt: number
  pitchDeg: number
  gammaDeg: number
  headingDeg: number
  alphaDeg: number
  nz: number
  onGround: boolean
  bottomed: boolean
}

interface Flight {
  samples: Sample[]
  events: string[]
  liftoffAt: number | null
  liftoffKt: number
  groundRollM: number
  gatesTaken: number
  splits: number[]
  courseStatus: string
  courseElapsed: number
  touchdownAt: number | null
  touchdownSinkFps: number
  peakTouchdownG: number
  rolloutM: number
  stoppedAt: number | null
  maxRolloutCrossM: number
  /** Distance from the destination field's centre when the run ended, metres. */
  finalDistToFieldM: number
  /** True if the wheels ended on pavement rather than grass. */
  finishedOnPavement: boolean
  finite: boolean
  summary(): string
}

// ---------------------------------------------------------------------------
// The flight
// ---------------------------------------------------------------------------

function flyAcceptanceRun(): Flight {
  const ground = new AuthoredGroundSource(authoredMap)
  const bayside = authoredMap.airfields.find((a) => a.name === 'Bayside')!
  const ridgeview = authoredMap.airfields.find((a) => a.name === 'Ridgeview')!

  const sim = new Simulation(runwayStart(bayside), undefined, ground)
  const course = buildCourse(authoredMap.airfields)

  const fieldFt = mToFt(ridgeview.elevation)

  // Land the RECIPROCAL. The course arrives from the north-west, and the far
  // threshold puts the whole 14 km final over terrain no higher than the field —
  // measured — where the published direction would need a 150-degree turn on final
  // and a descent across the ridge.
  const hdgRad = (ridgeview.headingDeg * Math.PI) / 180
  const dir: [number, number] = [Math.sin(hdgRad), -Math.cos(hdgRad)]
  const landingHeading = (ridgeview.headingDeg + 180) % 360
  const threshold: [number, number] = [
    ridgeview.x + dir[0] * (ridgeview.lengthM / 2),
    ridgeview.z + dir[1] * (ridgeview.lengthM / 2),
  ]
  // Inbound travel is the reciprocal of the runway vector.
  const inbound: [number, number] = [-dir[0], -dir[1]]
  // The approach fix sits a long way out on purpose. Twelve kilometres was not
  // enough: the course arrives from the north-west, so the aircraft reached the fix
  // 89 degrees off the runway heading and 2.5 km off the centreline, and was still
  // turning as it went past the field — measured, touchdown 26 km beyond the
  // threshold with the centreline tracked to within 1 m. Alignment needs distance,
  // and 24 km is about eight turn radii at approach speed.
  const FINAL_M = 24_000
  const faf: [number, number] = [
    threshold[0] - inbound[0] * FINAL_M,
    threshold[1] - inbound[1] * FINAL_M,
  ]

  const samples: Sample[] = []
  const events: string[] = []
  let phase: Phase = 'roll'
  let t = 0

  let brake = 0
  let gearDown = true
  const input: RawInput = { ...NEUTRAL_INPUT }

  const startPos: [number, number] = [sim.snapshot()[10] as number, sim.snapshot()[11] as number]
  let liftoffAt: number | null = null
  let liftoffKt = 0
  let groundRollM = 0
  let touchdownAt: number | null = null
  let touchdownSinkFps = 0
  let lastSinkFps = 0
  let peakTouchdownG = 0
  let touchdownPoint: [number, number] = [0, 0]
  let rolloutM = 0
  let stoppedAt: number | null = null
  let maxRolloutCross = 0
  let noseDown = false
  let finite = true

  /** Highest terrain within `look` metres along the current track, ft. */
  const terrainAhead = (x: number, z: number, headingDeg: number, look: number): number => {
    const h = (headingDeg * Math.PI) / 180
    const dx = Math.sin(h)
    const dz = -Math.cos(h)
    let hi = -Infinity
    for (let d = 0; d <= look; d += 750) {
      hi = Math.max(hi, authoredMap.height(x + dx * d, z + dz * d))
    }
    return mToFt(hi)
  }

  /**
   * One navigation update: steer toward a point, hold an altitude and a speed.
   *
   * Bank comes from the bearing, which converges from anywhere. Pitch commands a
   * flight path angle rather than a vertical speed, because a climb or a glideslope
   * *is* a flight path angle and the render state reports it — the vertical-speed
   * cascade this replaced never captured a slope, it only chased one.
   */
  const navigate = (
    targetX: number,
    targetZ: number,
    targetAltFt: number,
    targetKt: number,
    opts: { minThrottle?: number } = {},
  ): void => {
    const s = sim.render()
    const bearing = (Math.atan2(targetX - s.position[0], -(targetZ - s.position[2])) * 180) / Math.PI
    const headingError = wrap(bearing - s.headingDeg)

    const bank = clamp(headingError * 2.2, -55, 55)
    input.roll = clamp((bank - s.rollDeg) * 0.05, -1, 1)

    const targetGamma = clamp((targetAltFt - s.altFt) * 0.004, -9, 12)
    input.pitch = clamp((targetGamma - s.gammaDeg) * 0.05, -0.45, 0.55)

    input.yaw = 0
    input.throttle = clamp(0.5 + (targetKt - s.kt) * 0.015, opts.minThrottle ?? 0, 1)
  }

  const record = (): void => {
    const s = sim.render()
    const clearFt = s.altFt - mToFt(authoredMap.height(s.position[0], s.position[2]))
    if (!sim.snapshot().every(Number.isFinite)) finite = false
    samples.push({
      t,
      phase,
      x: s.position[0],
      z: s.position[2],
      altFt: s.altFt,
      aglFt: s.altFt - fieldFt,
      clearFt,
      kt: s.kt,
      pitchDeg: s.pitchDeg,
      gammaDeg: s.gammaDeg,
      headingDeg: s.headingDeg,
      alphaDeg: s.alphaDeg,
      nz: sim.nz,
      onGround: sim.onGround,
      bottomed: sim.gear.bottomed,
    })
  }

  const MAX_SECONDS = 900

  while (t < MAX_SECONDS && phase !== 'stopped') {
    const s = sim.render()
    const v = sim.snapshot()
    const aglField = s.altFt - fieldFt

    // ---- Guidance -------------------------------------------------------
    if (phase === 'roll') {
      // Brakes on while the engine spools, then release and accelerate.
      brake = t < 2.5 ? 1 : 0
      input.throttle = 1
      input.pitch = 0
      input.roll = 0
      input.yaw = 0
      if (s.kt > 150) {
        phase = 'rotate'
        events.push(`rotate at ${s.kt.toFixed(0)} kt, t=${t.toFixed(1)}s`)
      }
    } else if (phase === 'rotate') {
      // Hold a climb attitude. Positive pitch is BACK — `input.ts` maps arrow-up to
      // -1 because pushing forward lowers the nose.
      brake = 0
      input.throttle = 1
      input.pitch = clamp((12 - s.pitchDeg) * 0.09, -0.3, 0.6)
      input.roll = 0
      input.yaw = 0
      if (liftoffAt !== null && s.altFt - mToFt(bayside.elevation) > 800) {
        phase = 'gate'
        gearDown = false
        events.push(`gear up at ${(s.altFt - mToFt(bayside.elevation)).toFixed(0)} ft AGL, ${s.kt.toFixed(0)} kt`)
      }
    } else if (phase === 'gate') {
      const w = course.waypoints[course.index]
      if (!w) {
        phase = 'transit'
        events.push(`all gates taken at t=${t.toFixed(1)}s, turning for Ridgeview`)
      } else {
        const band = (w.minAltFt + w.maxAltFt) / 2
        const dist = Math.hypot(w.x - s.position[0], w.z - s.position[2])
        // Fly the band only when close enough for it to matter; stay above the
        // terrain in between. CITY's band bottom is 300 ft and the ridge on the way
        // to it peaks at 1,062 — the band is not a safe cruise altitude.
        const floor = terrainAhead(s.position[0], s.position[2], s.headingDeg, 6_000) + 1_200
        const target = dist < 5_000 ? band : Math.max(band, Math.min(floor, w.maxAltFt - 100))
        // Slow down as the gate approaches. At 396 kt a 55-degree bank turns with a
        // 3 km radius against a 900 m capture radius, so an overshoot becomes an
        // orbit the aircraft can never close — measured, three times round CITY.
        navigate(w.x, w.z, target, dist < 9_000 ? 260 : 360)
      }
    } else if (phase === 'transit') {
      const dist = Math.hypot(faf[0] - s.position[0], faf[1] - s.position[2])
      const floor = terrainAhead(s.position[0], s.position[2], s.headingDeg, 8_000) + 1_500
      // Arrive at the fix already ON the 3-degree slope and already slow. There are
      // no speedbrakes in this model, so an F-16 that starts a descent fast stays
      // fast: measured, 280 kt at idle all the way down a 3-degree slope, which put
      // it over the threshold high and flying. Deceleration has to happen level.
      const onSlope = fieldFt + 25 + (FINAL_M * Math.tan((3 * Math.PI) / 180)) / 0.3048
      navigate(faf[0], faf[1], Math.max(onSlope, floor), dist < 12_000 ? 200 : 300)
      if (dist < 2_500) {
        phase = 'approach'
        gearDown = true
        const alongNow =
          (threshold[0] - s.position[0]) * inbound[0] + (threshold[1] - s.position[2]) * inbound[1]
        const slopeNow =
          fieldFt + 25 + (Math.max(0, alongNow) * Math.tan((3 * Math.PI) / 180)) / 0.3048
        const offNow =
          (s.position[0] - threshold[0]) * -inbound[1] + (s.position[2] - threshold[1]) * inbound[0]
        events.push(
          `final approach at t=${t.toFixed(1)}s: ${(alongNow / 1000).toFixed(1)} km out, ` +
            `${s.kt.toFixed(0)} kt, ${(s.altFt - slopeNow).toFixed(0)} ft above the slope, ` +
            `${offNow.toFixed(0)} m off centreline, hdg ${s.headingDeg.toFixed(0)} vs ${landingHeading}`,
        )
      }
    } else if (phase === 'approach') {
      // A localizer, not a bearing to a point. Steering at the threshold is what the
      // gate legs do and it is wrong here: as the aircraft closes, the bearing to a
      // point swings faster and faster, so it arrives pointing anywhere. Measured,
      // it crossed the threshold on heading 227 with the runway at 192 and put the
      // aircraft in a field 775 m off the side.
      //
      // Tracking the centreline instead converges on the runway heading by
      // construction: fly a heading offset from the runway's own, proportional to how
      // far off the extended centreline you are, and the offset goes to zero as you
      // get there.
      const alongTrack =
        (threshold[0] - s.position[0]) * inbound[0] + (threshold[1] - s.position[2]) * inbound[1]
      // Positive is right of the centreline, so the correction turns left.
      const offCentre =
        (s.position[0] - threshold[0]) * -inbound[1] + (s.position[2] - threshold[1]) * inbound[0]

      const desiredHeading = landingHeading - clamp(offCentre * 0.06, -40, 40)
      const headingError = wrap(desiredHeading - s.headingDeg)
      const bank = clamp(headingError * 2.0, -35, 35)
      input.roll = clamp((bank - s.rollDeg) * 0.05, -1, 1)

      // Pitch holds the slope, throttle holds the speed — the same way round as the
      // cruise controller, and stable.
      //
      // The other way round (attitude on speed, thrust on path) is how a real jet
      // flies an approach and it was tried here first, because without speedbrakes
      // this aircraft accelerates down a 3-degree slope at idle. It oscillates: with
      // no damping term it drove a limit cycle of 169-208 kt and -2 to +16 degrees of
      // pitch, touching down at 45 ft/s. Backside control needs rate damping this
      // instrument does not have, so the speed is simply accepted as high and the
      // flare below is what deals with it.
      const gs = Math.min(
        fieldFt + 25 + (Math.max(0, alongTrack) * Math.tan(SLOPE_RAD)) / 0.3048,
        fieldFt + 4_500,
      )

      // Fly the slope, then correct onto it — not the other way round.
      //
      // This one line was the cause of every "arrives high" failure above. A
      // glideslope is a RAMP, and a purely proportional controller tracking a ramp
      // lags it forever: on the slope the altitude error is zero, so it commands
      // level flight, immediately goes high, and settles at whatever offset makes
      // the correction match the slope. Measured, it flew a 2.1-degree path when
      // asked for 3 and crossed the field 1,477 ft high.
      //
      // Commanding the slope as a feedforward and using the altitude error only to
      // correct removes the lag by construction.
      const slopeFeedforward = alongTrack > 0 ? -(SLOPE_RAD * 180) / Math.PI : 0
      const targetGamma = clamp(slopeFeedforward + (gs - s.altFt) * 0.006, -8, 6)
      // A firmer inner loop than the cruise one. At 0.05 the aircraft tracked the
      // feedforward but could not add the correction on top of it, and sat 700 ft
      // high all the way down.
      input.pitch = clamp((targetGamma - s.gammaDeg) * 0.14, -0.45, 0.55)
      input.throttle = clamp(0.5 + (APPROACH_KT - s.kt) * 0.015, 0, 1)

      input.yaw = 0

      if (aglField < 60) {
        phase = 'flare'
        events.push(`flare at ${aglField.toFixed(0)} ft AGL, ${s.kt.toFixed(0)} kt, sink ${(-s.climbFpm / 60).toFixed(1)} ft/s`)
      }
    } else if (phase === 'flare') {
      const headingError = wrap(landingHeading - s.headingDeg)
      input.throttle = 0
      // Hold a small sink rate rather than a fixed attitude. Commanding 7 degrees
      // nose-up at approach speed does not flare, it balloons — the aircraft has
      // plenty of lift left and simply stops descending.
      const targetGamma = -0.6
      input.pitch = clamp((targetGamma - s.gammaDeg) * 0.09, -0.25, 0.45)
      input.roll = clamp((clamp(headingError * 1.5, -8, 8) - s.rollDeg) * 0.05, -0.4, 0.4)
      input.yaw = clamp(headingError * 0.05, -0.5, 0.5)
    } else if (phase === 'rollout') {
      const headingError = wrap(landingHeading - s.headingDeg)
      const cross =
        (s.position[0] - threshold[0]) * -inbound[1] + (s.position[2] - threshold[1]) * inbound[0]
      maxRolloutCross = Math.max(maxRolloutCross, Math.abs(cross))
      noseDown = noseDown || (sim.gear.normal[0] ?? 0) > 500
      brake = noseDown ? 1 : 0
      input.throttle = 0
      // Hold the nose off, then let it down — dropping it from touchdown attitude
      // is what bottomed the nose strut before it was sized for landing loads.
      input.pitch = clamp((6 - s.pitchDeg) * 0.05, -0.1, 0.3)
      input.roll = 0
      // Fade the steering out as the aircraft stops. Tyre friction here ramps
      // linearly through zero, so at a standstill there is nothing resisting a
      // steering moment and a held command slowly rotates the aircraft on the spot
      // — measured at 0.1 deg/s. Centring the nosewheel is what a pilot does anyway.
      const steerAuthority = clamp((s.kt - 3) / 15, 0, 1)
      input.yaw = clamp((headingError * 0.06 - cross * 0.004) * steerAuthority, -1, 1)
    }

    if (phase !== 'rollout') lastSinkFps = -s.climbFpm / 60

    // ---- Step -----------------------------------------------------------
    sim.gearInput = { brake, steer: sim.steerCommand, down: gearDown }
    sim.advance(CONTROL_DT, () => input)
    t += CONTROL_DT

    const after = sim.render()
    course.update(
      {
        x: after.position[0],
        z: after.position[2],
        altFt: after.altFt,
        onGround: sim.onGround,
        speedFps: speedOf(sim.snapshot()),
      },
      CONTROL_DT,
    )

    // ---- Transitions driven by what happened ----------------------------
    if (liftoffAt === null && !sim.onGround && t > 3) {
      liftoffAt = t
      liftoffKt = after.kt
      const now = sim.snapshot()
      groundRollM =
        Math.hypot((now[10] as number) - startPos[0], (now[11] as number) - startPos[1]) * 0.3048
      events.push(`liftoff at t=${t.toFixed(1)}s, ${liftoffKt.toFixed(0)} kt, ${groundRollM.toFixed(0)} m of roll`)
    }

    if (touchdownAt === null && sim.onGround && (phase === 'flare' || phase === 'approach')) {
      touchdownAt = t
      touchdownSinkFps = lastSinkFps
      const now = sim.snapshot()
      touchdownPoint = [now[10] as number, now[11] as number]
      phase = 'rollout'
      events.push(`touchdown at t=${t.toFixed(1)}s, ${after.kt.toFixed(0)} kt, sink ${touchdownSinkFps.toFixed(1)} ft/s`)
    }

    if (touchdownAt !== null) {
      peakTouchdownG = Math.max(peakTouchdownG, sim.nz)
      const now = sim.snapshot()
      rolloutM =
        Math.hypot((now[10] as number) - touchdownPoint[0], (now[11] as number) - touchdownPoint[1]) *
        0.3048
    }

    if (course.status === 'complete') {
      stoppedAt = t
      phase = 'stopped'
      events.push(`stopped at t=${t.toFixed(1)}s — COURSE COMPLETE in ${course.elapsed.toFixed(1)}s`)
    }

    if (Math.round(t * CONTROL_HZ) % Math.round(CONTROL_HZ * 2) === 0) record()
    void v
  }

  const flight: Flight = {
    samples,
    events,
    liftoffAt,
    liftoffKt,
    groundRollM,
    gatesTaken: course.index,
    splits: course.splits,
    courseStatus: course.status,
    courseElapsed: course.elapsed,
    touchdownAt,
    touchdownSinkFps,
    peakTouchdownG,
    rolloutM,
    stoppedAt,
    maxRolloutCrossM: maxRolloutCross,
    finalDistToFieldM: (() => {
      const s = sim.render()
      return Math.hypot(s.position[0] - ridgeview.x, s.position[2] - ridgeview.z)
    })(),
    finishedOnPavement: (() => {
      const now = sim.snapshot()
      return ground.sample(now[10] as number, now[11] as number).friction > 0.5
    })(),
    finite,
    summary() {
      const lines: string[] = []
      const end = sim.render()
      const dField = Math.hypot(end.position[0] - ridgeview.x, end.position[2] - ridgeview.z)
      lines.push(`status=${course.status} gates=${course.index}/3 elapsed=${course.elapsed.toFixed(1)}s`)
      const along = (end.position[0] - threshold[0]) * inbound[0] + (end.position[2] - threshold[1]) * inbound[1]
      const across = (end.position[0] - threshold[0]) * -inbound[1] + (end.position[2] - threshold[1]) * inbound[0]
      const now = sim.snapshot()
      lines.push(
        `ended ${dField.toFixed(0)} m from ${ridgeview.name} centre ` +
          `(completion needs <= ${(ridgeview.lengthM / 2 + 300).toFixed(0)} m), ` +
          `${end.kt.toFixed(1)} kt, onGround=${sim.onGround}`,
      )
      lines.push(
        `  relative to the landing threshold: ${along.toFixed(0)} m along, ` +
          `${across.toFixed(0)} m across (runway is ${ridgeview.lengthM} x ${ridgeview.widthM} m), ` +
          `pavement=${ground.sample(now[10] as number, now[11] as number).friction > 0.5}`,
      )
      lines.push(`events:`)
      for (const e of events) lines.push(`  ${e}`)
      lines.push(`profile (every ~20 s):`)
      let last = -99
      for (const p of samples) {
        if (p.t - last < 20) continue
        last = p.t
        lines.push(
          `  t=${p.t.toFixed(0).padStart(3)}s ${p.phase.padEnd(8)} ` +
            `alt=${p.altFt.toFixed(0).padStart(5)} clear=${p.clearFt.toFixed(0).padStart(5)} ` +
            `${p.kt.toFixed(0).padStart(3)}kt hdg=${p.headingDeg.toFixed(0).padStart(3)} ` +
            `pitch=${p.pitchDeg.toFixed(1).padStart(5)} path=${p.gammaDeg.toFixed(1).padStart(5)} ` +
            `aoa=${p.alphaDeg.toFixed(1).padStart(5)} ` +
            `g=${p.nz.toFixed(2)}${p.onGround ? ' WOW' : ''}`,
        )
      }
      return lines.join('\n')
    },
  }

  return flight
}

// ---------------------------------------------------------------------------

const flight = flyAcceptanceRun()

describe('Day 3 acceptance: a runway-to-runway flight through the course', () => {
  it('reports the flight', () => {
    // Printed on every run, pass or fail. This is the milestone; what it did is
    // worth a line of output, and when it breaks the profile is already on screen.
    // eslint-disable-next-line no-console
    console.log(`\n${flight.summary()}\n`)
    expect(flight.samples.length).toBeGreaterThan(10)
  })

  it('completes the course', () => {
    // The milestone. Everything below exists to say WHY, when this line fails.
    expect(flight.courseStatus, `did not complete\n${flight.summary()}`).toBe('complete')
  })

  it('takes off from Bayside', () => {
    expect(flight.liftoffAt, `never got airborne\n${flight.summary()}`).not.toBeNull()
    expect(flight.liftoffKt, 'rotated at an implausible speed').toBeGreaterThan(130)
    expect(flight.liftoffKt, 'rotated at an implausible speed').toBeLessThan(230)
    expect(flight.groundRollM, 'ground roll is not an F-16 ground roll').toBeGreaterThan(250)
    expect(flight.groundRollM, 'ground roll is longer than the runway').toBeLessThan(2_000)
  })

  it('takes all three gates, in their altitude bands', () => {
    expect(flight.gatesTaken, `only took ${flight.gatesTaken} gates\n${flight.summary()}`).toBe(3)
    expect(flight.splits).toHaveLength(3)
    for (let i = 1; i < flight.splits.length; i++) {
      expect(flight.splits[i] as number).toBeGreaterThan(flight.splits[i - 1] as number)
    }
  })

  it('never flies into the ground', () => {
    // The single most useful diagnostic here. Terrain clearance going negative while
    // airborne means the aircraft is inside a hill, and it is how a bad approach
    // announces itself long before the course status does.
    const airborne = flight.samples.filter((p) => !p.onGround && p.t > 5)
    const worst = airborne.reduce((a, b) => (a.clearFt < b.clearFt ? a : b), airborne[0]!)
    expect(
      worst.clearFt,
      `flew into terrain at t=${worst.t.toFixed(0)}s in phase ${worst.phase}\n${flight.summary()}`,
    ).toBeGreaterThan(0)
  })

  it('stays inside the flight envelope the whole way', () => {
    for (const p of flight.samples) {
      if (p.onGround || p.t < 5) continue
      expect(p.alphaDeg, `alpha ${p.alphaDeg.toFixed(1)} at t=${p.t.toFixed(0)}s (${p.phase})`).toBeLessThan(30)
      expect(p.nz, `${p.nz.toFixed(2)} g at t=${p.t.toFixed(0)}s (${p.phase})`).toBeGreaterThan(-1)
      expect(p.nz, `${p.nz.toFixed(2)} g at t=${p.t.toFixed(0)}s (${p.phase})`).toBeLessThan(6)
    }
  })

  it('lands rather than arrives', () => {
    expect(flight.touchdownAt, `never touched down\n${flight.summary()}`).not.toBeNull()
    expect(flight.touchdownSinkFps, `came down far too hard\n${flight.summary()}`).toBeLessThan(15)
    expect(flight.peakTouchdownG, 'touchdown was an impact, not a landing').toBeLessThan(4)
    expect(flight.samples.some((p) => p.bottomed), 'bottomed a strut').toBe(false)
  })

  it('stops on the runway it landed on', () => {
    expect(flight.stoppedAt, `never came to a stop\n${flight.summary()}`).not.toBeNull()
    expect(flight.rolloutM, 'rollout is longer than the runway').toBeLessThan(3_500)
    expect(flight.maxRolloutCrossM, 'wandered off the side during rollout').toBeLessThan(60)
  })

  it('never produces a non-finite state', () => {
    expect(flight.finite, `state went non-finite\n${flight.summary()}`).toBe(true)
  })
})
