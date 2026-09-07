/**
 * The takeoff and approach speed cue.
 *
 * Written after a flight test flew the aircraft into a runway at 250 kt. The overlay
 * showed IAS the whole way down; a bare number does not tell you whether it is the
 * right one, and the consequences are not gentle — at 80 kt over the reference speed
 * this aircraft will not land at all, and pushing the nose down instead of waiting
 * puts it into the runway at 2,200 fpm.
 *
 * The decision is tested here; the drawing is not, because the drawing needs a DOM
 * and the decision is the part that can be wrong.
 */

import { describe, expect, it } from 'vitest'
import { speedCue } from '../src/overlay.js'
import { fpsToKt, referenceSpeed } from '@retro-flyer/physics'
import { authoredMap } from '../src/terrain/authored.js'

const VREF = fpsToKt(referenceSpeed(0))

describe('the speed cue', () => {
  it('says nothing with the gear up', () => {
    // Cruising is neither a takeoff nor a landing, and a cue that is always on stops
    // being read.
    expect(speedCue({ kt: 400, targetKt: VREF, onGround: false, gearDown: false, rollingOut: false }).kind).toBe('none')
    expect(speedCue({ kt: 0, targetKt: VREF, onGround: true, gearDown: false, rollingOut: false }).kind).toBe('none')
  })

  it('shows the rotation target from the start of the roll', () => {
    const cue = speedCue({ kt: 0, targetKt: VREF, onGround: true, gearDown: true, rollingOut: false })
    expect(cue.kind).toBe('rotate')
    if (cue.kind !== 'rotate') return
    expect(cue.targetKt).toBe(VREF)
    expect(cue.ready, 'should not say rotate at a standstill').toBe(false)
  })

  it('calls the rotation when the speed is there, and not before', () => {
    const at = (kt: number) => speedCue({ kt, targetKt: VREF, onGround: true, gearDown: true, rollingOut: false })

    expect((at(VREF - 1) as { ready: boolean }).ready).toBe(false)
    expect((at(VREF) as { ready: boolean }).ready).toBe(true)
    expect((at(VREF + 40) as { ready: boolean }).ready).toBe(true)
  })

  it('says nothing during the landing rollout', () => {
    // The same aircraft, on the same runway, with the same gear down as a takeoff
    // roll — and the opposite instruction is correct. Before this the HUD told the
    // pilot to ROTATE while they were trying to stop.
    const cue = speedCue({ kt: 140, targetKt: VREF, onGround: true, gearDown: true, rollingOut: true })
    expect(cue.kind).toBe('none')
  })

  it('offers the rotation again once stopped, so a second takeoff needs no reset', () => {
    // `rollingOut` is cleared below walking pace by the caller; this pins the cue's
    // half of that contract.
    const cue = speedCue({ kt: 0, targetKt: VREF, onGround: true, gearDown: true, rollingOut: false })
    expect(cue.kind).toBe('rotate')
  })

  it('switches to an approach cue once airborne', () => {
    const cue = speedCue({ kt: 250, targetKt: VREF, onGround: false, gearDown: true, rollingOut: false })
    expect(cue.kind).toBe('approach')
    if (cue.kind !== 'approach') return
    // The number that matters on final is how far off you are, not how fast you are.
    expect(cue.deltaKt).toBeCloseTo(250 - VREF, 6)
    expect(cue.deltaKt).toBeGreaterThan(30)
  })

  it('reports slow as well as fast', () => {
    const cue = speedCue({ kt: VREF - 25, targetKt: VREF, onGround: false, gearDown: true, rollingOut: false })
    if (cue.kind !== 'approach') throw new Error('expected an approach cue')
    expect(cue.deltaKt).toBeLessThan(0)
  })

  it('is on the right side of the speeds that actually matter', () => {
    // Measured on the model, not asserted from taste: 200 kt over the threshold
    // lands normally (1.9 g, stopped in 28 s); 250 kt does not land at all, because
    // the wing still makes more lift than the aircraft weighs. The cue has to sit
    // below the first and well below the second, or it is pointing at a speed the
    // aircraft cannot land from.
    expect(VREF).toBeLessThan(200)
    expect(VREF).toBeLessThan(250)
    expect(VREF, 'and not so slow it is unflyable').toBeGreaterThan(140)
  })

  it('differs between the map’s airfields, because their elevations do', () => {
    const bayside = authoredMap.airfields.find((a) => a.name === 'Bayside')!
    const ridgeview = authoredMap.airfields.find((a) => a.name === 'Ridgeview')!

    const atBayside = fpsToKt(referenceSpeed(bayside.elevation / 0.3048))
    const atRidgeview = fpsToKt(referenceSpeed(ridgeview.elevation / 0.3048))

    expect(ridgeview.elevation).toBeGreaterThan(bayside.elevation)
    expect(atRidgeview).toBeGreaterThan(atBayside)
  })
})
