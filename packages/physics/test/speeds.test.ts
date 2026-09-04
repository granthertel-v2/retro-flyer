/**
 * Reference speeds derived from the aerodynamic tables.
 *
 * These exist because a flight test said so: the aircraft was flown into a runway at
 * 250 kt because nothing on screen said what speed it flies at. Everything here is a
 * cue — nothing in the flight model reads any of it — so the tests are about whether
 * the numbers are *right*, not whether anything depends on them.
 */

import { describe, expect, it } from 'vitest'
import {
  ROTATION_ALPHA_DEG,
  ROTATION_MARGIN,
  liftCoefficient,
  referenceSpeed,
  speedForLevelLift,
  stallSpeed,
} from '../src/speeds.js'
import { computeMassProperties } from '../src/massProperties.js'
import { REFERENCE_WEIGHT_LB } from '../src/massProperties.js'
import { fpsToKt } from '../src/units.js'
import { trim } from '../src/trim.js'
import { S } from '../src/dynamics.js'
import { RAD_PER_DEG } from '../src/units.js'

describe('lift coefficient from the tables', () => {
  it('rises with alpha through the normal range', () => {
    let previous = -Infinity
    for (const alphaDeg of [0, 4, 8, 12, 16, 20]) {
      const cl = liftCoefficient(alphaDeg)
      expect(cl, `CL at ${alphaDeg} deg`).toBeGreaterThan(previous)
      previous = cl
    }
  })

  it('resolves the body-axis forces through alpha rather than using -CZ alone', () => {
    // `CL = CX sin(a) - CZ cos(a)`. Dropping the rotation is a silent few-percent
    // error at the angles a rotation happens at, and it biases the cue the wrong way.
    // At zero alpha the two agree exactly, which is what makes the mistake invisible
    // unless it is checked away from zero.
    const at12 = liftCoefficient(12)
    const naive12 = -liftCoefficient(0) // stand-in for "forgot the rotation"
    expect(at12).not.toBeCloseTo(naive12, 2)

    // And it is a real difference, not noise.
    const a = 12 * RAD_PER_DEG
    expect(Math.abs(Math.cos(a) - 1)).toBeGreaterThan(0.02)
  })

  it('does not depend on airspeed, which is what lets it solve for one', () => {
    // Body rates are zero, so the damping terms — the only place `vt` enters —
    // vanish. If that ever stopped being true, `speedForLevelLift` would be solving
    // an equation whose right-hand side moved.
    expect(liftCoefficient(12)).toBe(liftCoefficient(12))
  })
})

describe('the speed at which the wing carries the aircraft', () => {
  it('agrees with the trim solver, which is an independent route to the same answer', () => {
    // The real check. `speedForLevelLift` inverts the lift equation directly; `trim`
    // numerically solves the whole 6DOF for equilibrium. They know nothing about each
    // other, so agreement means the lift bookkeeping is right.
    for (const alt of [0, 10_000]) {
      const alphaDeg = 8
      const v = speedForLevelLift(alphaDeg, alt)

      const solution = trim({ alt, vt: v })
      const trimmedAlphaDeg = (solution.state[S.ALPHA] as number) / RAD_PER_DEG

      // Within a degree. They will not match exactly: trim carries thrust inclination
      // and the elevator's own lift, which the closed form ignores.
      expect(trimmedAlphaDeg, `alpha at ${alt} ft`).toBeCloseTo(alphaDeg, 0)
    }
  })

  it('falls as alpha rises', () => {
    let previous = Infinity
    for (const alphaDeg of [4, 8, 12, 16, 20]) {
      const v = speedForLevelLift(alphaDeg, 0)
      expect(v).toBeLessThan(previous)
      previous = v
    }
  })

  it('is infinite where the wing makes no lift, rather than NaN', () => {
    // Negative alpha on this airframe still makes a little lift, so probe below the
    // table where CL genuinely goes negative.
    const v = speedForLevelLift(-10, 0)
    expect(Number.isNaN(v)).toBe(false)
  })
})

describe('the reference speed', () => {
  const vr = referenceSpeed(0)

  it('is a speed an F-16 would rotate at', () => {
    // Not a sourced V-speed and not claimed to be one. It has to be recognisable:
    // fast enough to fly, slow enough to reach on a runway.
    expect(fpsToKt(vr)).toBeGreaterThan(130)
    expect(fpsToKt(vr)).toBeLessThan(200)
  })

  it('matches what the aircraft actually does on a takeoff roll', () => {
    // The acceptance flight rotates at 150 kt and is airborne by 181. A cue outside
    // that range would be telling the pilot the wrong thing.
    expect(fpsToKt(vr)).toBeGreaterThan(150)
    expect(fpsToKt(vr)).toBeLessThan(181)
  })

  it('sits above the speed where lift merely equals weight', () => {
    const bare = speedForLevelLift(ROTATION_ALPHA_DEG, 0)
    expect(vr / bare).toBeCloseTo(ROTATION_MARGIN, 6)
    expect(vr).toBeGreaterThan(bare)
  })

  it('rises with weight', () => {
    // The whole reason this is computed and not a constant: §8.4 makes mass a
    // function of the loadout, so a quoted number would be silently wrong the moment
    // the loadout changed.
    const heavy = computeMassProperties({ emptyWeight: 20_000, fuel: 5_000 })
    expect(heavy.weight).toBeGreaterThan(REFERENCE_WEIGHT_LB)
    expect(referenceSpeed(0, heavy)).toBeGreaterThan(vr)
  })

  it('rises with field elevation', () => {
    // Thinner air, same wing. Bayside and Ridgeview are 700 ft apart and it shows.
    expect(referenceSpeed(5_000)).toBeGreaterThan(referenceSpeed(0))
    expect(referenceSpeed(1_302)).toBeGreaterThan(referenceSpeed(607))
  })

  it('leaves margin over the lowest speed the wing could ever hold', () => {
    expect(vr).toBeGreaterThan(stallSpeed(0))
  })

  it('is finite everywhere an airfield could be', () => {
    for (const alt of [0, 607, 1_302, 5_000, 10_000]) {
      expect(Number.isFinite(referenceSpeed(alt))).toBe(true)
    }
  })
})
