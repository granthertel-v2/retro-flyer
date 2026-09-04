/**
 * The chase camera's bank following.
 *
 * One function, one property, and the property is the entire reason the function
 * exists: it has to be continuous where bank wraps. Copying a fixed fraction of the
 * bank angle is not, and the discontinuity lands at exactly 180 degrees — the middle
 * of a barrel roll, where it is most visible and least welcome.
 */

import { describe, expect, it } from 'vitest'
import { followedBank } from '../src/camera/chase.js'

const deg = (d: number): number => (d * Math.PI) / 180

describe('followedBank', () => {
  it('is level when the aircraft is level', () => {
    expect(followedBank(0)).toBeCloseTo(0, 12)
  })

  it('follows only partly at moderate bank', () => {
    // The point of not following fully: the horizon should tilt, not spin.
    const banked = followedBank(deg(60))
    expect(banked).toBeGreaterThan(0)
    expect(banked).toBeLessThan(deg(60))
  })

  it('follows fully at inverted, so the wrap is seamless', () => {
    // +180 and -180 are the same attitude. If the camera does not agree, rolling
    // through inverted snaps it round.
    expect(followedBank(Math.PI)).toBeCloseTo(Math.PI, 9)
    expect(followedBank(-Math.PI)).toBeCloseTo(-Math.PI, 9)
  })

  it('has no jump anywhere in a full roll, including through inverted', () => {
    // Walk the whole circle and out the other side, treating +pi and -pi as
    // adjacent, and check no single step moves the camera more than the aircraft.
    const steps = 2_000
    let previous = followedBank(-Math.PI)

    for (let i = 1; i <= steps; i++) {
      const bank = -Math.PI + (2 * Math.PI * i) / steps
      const current = followedBank(bank)
      expect(Math.abs(current - previous)).toBeLessThan(0.02)
      previous = current
    }

    // And closing the loop: the far end must meet the near end.
    expect(followedBank(Math.PI) - 2 * Math.PI).toBeCloseTo(followedBank(-Math.PI), 9)
  })

  it('is odd, so a left bank mirrors a right one', () => {
    for (const d of [15, 45, 90, 135, 179]) {
      expect(followedBank(deg(d))).toBeCloseTo(-followedBank(deg(-d)), 12)
    }
  })
})
