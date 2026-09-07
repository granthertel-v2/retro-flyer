/**
 * The head-up display (REQUIREMENTS §9.1).
 *
 * Drawn on a 2D canvas over the WebGL one rather than in the scene. A HUD in the
 * scene would need its own camera pass, its own depth handling and its own text
 * rasterisation, and would buy nothing: the symbology is either screen-fixed (the
 * tapes) or projected by hand anyway (the conformal half — see `symbology.ts` for
 * why the projection has to be real). A 2D context does crisp one-pixel lines and
 * legible text for free, which is most of what an instrument is.
 *
 * ## Why a HUD rather than gauges
 *
 * §9.1's argument, restated because it drives every choice below: a fighter HUD is
 * both cheaper to build than six round dials and better aimed at the problem. The
 * dials would tell a non-pilot the same numbers the dev overlay already prints. The
 * HUD adds the one thing text cannot — **position**. The flight path marker is not a
 * readout of gamma, it sits on the ground the aircraft is going to arrive at, and
 * the gap between it and the boresight is angle of attack drawn to scale. That gap
 * opening under a hard pull, several seconds before the aircraft starts going
 * anywhere, is the intuition this whole project is trying to hand over.
 *
 * ## What is deliberately not here
 *
 * No radar, no weapons, no bearing/range to a target, no ILS. §9.2 parks the navaids
 * and the seam is unchanged. Everything drawn here is something the flight model
 * already knows.
 */

import type { RenderState } from '../seam.js'
import type { SpeedCue } from '../overlay.js'
import {
  applyQuat,
  bearingTo,
  clampToBox,
  headingFrac,
  ladderBasis,
  ladderDirection,
  ladderPitches,
  normalize,
  projectDirection,
  tapeTicks,
  type Box,
  type ScreenPoint,
  type Vec3,
} from './symbology.js'

/** Phosphor green. Bright enough to sit over sunlit terrain and still read. */
const GREEN = '#5dff9b'
// Both of these started three tenths lower and were unreadable over a sunlit sky,
// which is most of the screen most of the time. A HUD that only reads against the
// sea is not a HUD.
const DIM = 'rgba(93,255,155,0.78)'
const FAINT = 'rgba(93,255,155,0.45)'
const WARN = '#ffd166'

/**
 * How far either side of the nose the ladder is drawn, degrees of pitch.
 *
 * Sized by what it collides with rather than by taste. At 34 the outermost rungs
 * reached the heading strip at the top of the glass and the gear and course lines at
 * the bottom, in level flight — so the clutter was worst in the most ordinary case.
 * At 22 the extreme rungs land inside the tape band with room to spare, and nothing
 * is lost: the ladder recentres on the nose, so a steep climb still has rungs either
 * side of the boresight, and the horizon has its own line drawn at any attitude.
 */
const LADDER_SPAN = 22
const LADDER_STEP = 5

/** Lateral half-angles, degrees: the rung bars, and the wider horizon line. */
const RUNG_INNER = 3.4
const RUNG_OUTER = 9.5
const HORIZON_INNER = 5
const HORIZON_OUTER = 34

/** Steering cue to the next waypoint, or `null` when the course is not running. */
export interface SteerCue {
  name: string
  bearingDeg: number
  distanceNm: number
}

export interface HudInputs {
  state: RenderState
  /** projection * viewMatrixInverse, column-major — `THREE.Matrix4.elements`. */
  viewProj: ArrayLike<number>
  /** Normal load factor, g. */
  nz: number
  throttle: number
  onGround: boolean
  gearDown: boolean
  parkingBrake: boolean
  /**
   * Whether the world-referenced half should be drawn.
   *
   * False in the orbit camera. The projection stays correct there — it is the same
   * matrix — but a ladder centred on the aircraft's heading while the camera swings
   * around it is honest and unreadable at once, and a HUD you cannot read is worse
   * than no HUD. The tapes stay, because they never depended on the viewpoint.
   */
  conformal: boolean
  cue: SpeedCue
  steer: SteerCue | null
  /** Lines shouted in amber under the boresight. Limiter states, gear warnings. */
  warnings: readonly string[]
}

export class Hud {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  visible = true

  private width = 0
  private height = 0
  private unit = 1
  private font = 13

  constructor(parent: HTMLElement = document.body) {
    this.canvas = document.createElement('canvas')
    this.canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;display:block;pointer-events:none'
    parent.append(this.canvas)

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('HUD needs a 2D context')
    this.ctx = ctx

    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  private resize(): void {
    // Cap the pixel ratio for the same reason the renderer does: a 3x display draws
    // nine times the pixels for a display made of one-pixel lines.
    const dpr = Math.min(devicePixelRatio || 1, 2)
    this.width = window.innerWidth
    this.height = window.innerHeight
    this.canvas.width = Math.round(this.width * dpr)
    this.canvas.height = Math.round(this.height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // One scale factor for every dimension below, so the HUD stays proportioned on a
    // laptop and on a large monitor rather than becoming a postage stamp on one.
    this.unit = Math.max(0.62, Math.min(1.5, Math.min(this.width / 1600, this.height / 900)))
    this.font = Math.round(13 * this.unit)
  }

  draw(input: HudInputs): void {
    const { ctx } = this
    ctx.clearRect(0, 0, this.width, this.height)
    if (!this.visible) return

    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'
    ctx.font = `${this.font}px ui-monospace, SFMono-Regular, Menlo, monospace`
    ctx.textBaseline = 'middle'
    // No canvas shadow. It was the obvious way to keep the symbology legible against
    // a bright sky and it cost a third of the frame rate: a HUD frame is roughly 140
    // separate draw calls, and `shadowBlur` makes every one of them a separate blur
    // pass. Measured on the production bundle, 120 fps became 80 with the HUD on and
    // went straight back to 120 with the shadow removed and nothing else changed —
    // the entire cost of the instrument was the drop shadow.
    //
    // The lines never needed it; they read fine over sky, terrain and sea at every
    // attitude flown in QA. Only the text was marginal, and text gets a stroked
    // outline instead (see `label`), which is both cheaper and sharper than a blur.

    if (input.conformal) {
      this.drawConformal(input)
    }
    this.drawTapes(input)
    this.drawHeading(input)
    this.drawReadouts(input)

  }

  /**
   * Text with a dark outline, in place of a drop shadow.
   *
   * Two draws instead of one blurred draw. A blur is a full offscreen pass per call;
   * an outline is a second glyph rasterisation, which is cheap enough that it does
   * not register against the WebGL scene at all.
   *
   * Stroke state is saved and restored because every caller is in the middle of
   * drawing lines in some other colour, and a helper that quietly changed
   * `strokeStyle` underneath them would be a genuinely nasty bug to find.
   */
  private label(text: string, x: number, y: number): void {
    const { ctx } = this
    const stroke = ctx.strokeStyle
    const width = ctx.lineWidth
    const join = ctx.lineJoin

    ctx.strokeStyle = 'rgba(0,0,0,0.78)'
    ctx.lineWidth = 3 * this.unit
    // Round, or the outline grows spikes off the corners of glyphs at this width.
    ctx.lineJoin = 'round'
    ctx.strokeText(text, x, y)

    ctx.fillText(text, x, y)

    ctx.strokeStyle = stroke
    ctx.lineWidth = width
    ctx.lineJoin = join
  }

  // --- the world-referenced half ----------------------------------------------

  private drawConformal(input: HudInputs): void {
    const { state } = input
    const basis = ladderBasis(state.headingDeg)

    const project = (d: Vec3): ScreenPoint | null =>
      projectDirection(d, input.viewProj, this.width, this.height)

    this.drawHorizon(basis, project)
    this.drawLadder(basis, project, state.pitchDeg)
    this.drawBoresight(state, project)
    this.drawFlightPath(input, project)
  }

  /**
   * The horizon, as a great circle sampled every few degrees rather than a straight
   * line between two endpoints.
   *
   * Straight would be wrong in exactly the case where the horizon matters most: a
   * wide field of view flattens a curve near the centre of the screen but not at the
   * edges, so a two-point line visibly parts company with the terrain horizon out at
   * the wingtips. Sampling costs nothing and the seam is gone.
   */
  private drawHorizon(
    basis: ReturnType<typeof ladderBasis>,
    project: (d: Vec3) => ScreenPoint | null,
  ): void {
    const { ctx } = this
    ctx.strokeStyle = GREEN
    ctx.lineWidth = 1.6 * this.unit
    ctx.setLineDash([])

    for (const sign of [-1, 1]) {
      this.strokeArc(basis, project, 0, sign * HORIZON_INNER, sign * HORIZON_OUTER, 2)
    }
  }

  private drawLadder(
    basis: ReturnType<typeof ladderBasis>,
    project: (d: Vec3) => ScreenPoint | null,
    pitchDeg: number,
  ): void {
    const { ctx } = this

    for (const pitch of ladderPitches(pitchDeg, LADDER_SPAN, LADDER_STEP)) {
      const climbing = pitch > 0
      ctx.strokeStyle = climbing ? GREEN : DIM
      ctx.lineWidth = 1.4 * this.unit
      // Dashed below the horizon. The convention is worth keeping even though the
      // numbers are signed: in a dive the ladder is what you read, and reading a
      // minus sign at 500 knots is slower than noticing the line is broken.
      ctx.setLineDash(climbing ? [] : [6 * this.unit, 5 * this.unit])

      for (const sign of [-1, 1]) {
        this.strokeArc(basis, project, pitch, sign * RUNG_INNER, sign * RUNG_OUTER, 2)

        // A tick at the inner end, pointing back toward the horizon. This is what
        // makes an upside-down ladder readable: the ticks always point the short way
        // home, so which way is up is visible without reading a number.
        const inner = project(ladderDirection(basis, pitch, sign * RUNG_INNER))
        const towards = project(
          ladderDirection(basis, pitch - Math.sign(pitch) * 1.6, sign * RUNG_INNER),
        )
        if (inner && towards) {
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.moveTo(inner.x, inner.y)
          ctx.lineTo(towards.x, towards.y)
          ctx.stroke()
          ctx.setLineDash(climbing ? [] : [6 * this.unit, 5 * this.unit])
        }
      }

      ctx.setLineDash([])
      this.drawRungLabel(basis, project, pitch, climbing)
    }

    ctx.setLineDash([])
  }

  /**
   * The pitch number at the outer end of a rung, rotated to lie along it.
   *
   * Rotating the text is not styling. Inverted, an unrotated "+30" reads as "+30"
   * while the ladder it belongs to is upside down, and the two disagree about which
   * way the world is. Rotated, the number turns over with the rung and the whole
   * ladder stays one object.
   */
  private drawRungLabel(
    basis: ReturnType<typeof ladderBasis>,
    project: (d: Vec3) => ScreenPoint | null,
    pitch: number,
    climbing: boolean,
  ): void {
    const { ctx } = this
    const outer = project(ladderDirection(basis, pitch, -RUNG_OUTER))
    const reference = project(ladderDirection(basis, pitch, -RUNG_OUTER + 2))
    if (!outer || !reference) return

    const angle = Math.atan2(reference.y - outer.y, reference.x - outer.x)

    ctx.save()
    ctx.translate(outer.x, outer.y)
    ctx.rotate(angle)
    ctx.fillStyle = climbing ? GREEN : DIM
    ctx.textAlign = 'right'
    this.label(`${pitch > 0 ? '' : '-'}${Math.abs(pitch)}`, -6 * this.unit, 0)
    ctx.restore()
  }

  /** Stroke a constant-pitch arc between two lateral angles, skipping what is behind. */
  private strokeArc(
    basis: ReturnType<typeof ladderBasis>,
    project: (d: Vec3) => ScreenPoint | null,
    pitch: number,
    fromDeg: number,
    toDeg: number,
    stepDeg: number,
  ): void {
    const { ctx } = this
    const steps = Math.max(1, Math.ceil(Math.abs(toDeg - fromDeg) / stepDeg))
    let drawing = false

    ctx.beginPath()
    for (let i = 0; i <= steps; i++) {
      const lateral = fromDeg + ((toDeg - fromDeg) * i) / steps
      const p = project(ladderDirection(basis, pitch, lateral))

      if (!p) {
        // A break in the run, not the end of it: the far end of the horizon can come
        // back into view on the other side.
        drawing = false
        continue
      }
      if (drawing) ctx.lineTo(p.x, p.y)
      else {
        ctx.moveTo(p.x, p.y)
        drawing = true
      }
    }
    ctx.stroke()
  }

  /**
   * The boresight: where the nose is pointed.
   *
   * Drawn at the actual nose vector rather than pinned to the middle of the screen,
   * which is what makes the distance to the flight path marker mean something. On a
   * real F-16 the equivalent symbol is a fixed cross, because the HUD is bolted to
   * the airframe and the two amount to the same thing in the cockpit view; here the
   * chase camera exists, so the nose has to be projected like everything else.
   */
  private drawBoresight(state: RenderState, project: (d: Vec3) => ScreenPoint | null): void {
    const nose = applyQuat(state.quaternion, [0, 0, -1])
    const p = project(nose)
    if (!p) return

    const { ctx } = this
    const w = 17 * this.unit
    // Full brightness. At the dim level it disappeared into the ladder exactly when
    // the ladder was busiest, which is when the boresight is the thing worth finding.
    ctx.strokeStyle = GREEN
    ctx.lineWidth = 1.9 * this.unit
    ctx.beginPath()
    ctx.moveTo(p.x - w, p.y)
    ctx.lineTo(p.x - w * 0.3, p.y)
    ctx.moveTo(p.x + w * 0.3, p.y)
    ctx.lineTo(p.x + w, p.y)
    // The upright was a third of this and read as the digit 1 sitting between two
    // dashes rather than as a cross.
    ctx.moveTo(p.x, p.y - w * 0.85)
    ctx.lineTo(p.x, p.y - w * 0.15)
    ctx.stroke()
  }

  /**
   * The flight path marker — the instrument §9.1 is built around.
   *
   * Projected from the velocity vector, so it sits on whatever the aircraft is
   * currently going to reach. Level at 9 degrees alpha it sits on the horizon while
   * the boresight sits 9 degrees above it, and that gap is angle of attack, drawn
   * rather than tabulated.
   *
   * Hidden below a walking pace, where the velocity direction is numerical noise and
   * a marker whipping around the screen while parked is worse than nothing.
   */
  private drawFlightPath(input: HudInputs, project: (d: Vec3) => ScreenPoint | null): void {
    const { state } = input
    if (state.kt < 15) return

    const dir = normalize(state.velocity as unknown as Vec3)
    const raw = project(dir)

    const margin = 34 * this.unit
    const box: Box = {
      left: margin,
      top: margin + this.height * 0.08,
      right: this.width - margin,
      bottom: this.height - margin - this.height * 0.08,
    }

    // Behind the camera has no sensible clamp target — that only happens in the
    // chase view looking at an aircraft flying at the eye — so drop it rather than
    // pin it to an arbitrary edge.
    if (!raw) return
    const { x, y, clamped } = clampToBox(raw, box)

    const { ctx } = this
    const r = 9 * this.unit
    ctx.strokeStyle = clamped ? WARN : GREEN
    ctx.lineWidth = 2 * this.unit
    ctx.setLineDash(clamped ? [4 * this.unit, 3 * this.unit] : [])

    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.moveTo(x - r, y)
    ctx.lineTo(x - r * 2.6, y)
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + r * 2.6, y)
    ctx.moveTo(x, y - r)
    ctx.lineTo(x, y - r * 2.1)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // --- the screen-fixed half ---------------------------------------------------

  /** Half the distance between the two tapes. Clamped so a wide monitor is not empty. */
  private get half(): number {
    return Math.min(this.width * 0.33, 430 * this.unit)
  }

  private drawTapes(input: HudInputs): void {
    const cx = this.width / 2
    const cy = this.height / 2
    const h = Math.min(this.height * 0.46, 420 * this.unit)

    this.drawTape({
      x: cx - this.half,
      y: cy,
      height: h,
      side: 'left',
      value: input.state.kt,
      // 140 knots across the tape: fine enough that the approach speed window is a
      // visible distance rather than a number, coarse enough that the takeoff roll
      // does not blur.
      span: 140,
      minorStep: 10,
      majorStep: 50,
      min: 0,
      digits: 0,
      label: 'KT',
    })

    this.drawTape({
      x: cx + this.half,
      y: cy,
      height: h,
      side: 'right',
      value: input.state.altFt,
      span: 2000,
      minorStep: 100,
      majorStep: 500,
      digits: 0,
      label: 'FT',
    })

    this.drawVerticalSpeed(cx + this.half, cy, h, input.state.climbFpm)
  }

  private drawTape(o: {
    x: number
    y: number
    height: number
    side: 'left' | 'right'
    value: number
    span: number
    minorStep: number
    majorStep: number
    min?: number | undefined
    digits: number
    label: string
  }): void {
    const { ctx } = this
    const top = o.y - o.height / 2
    const dir = o.side === 'left' ? -1 : 1

    ctx.strokeStyle = DIM
    ctx.lineWidth = 1.2 * this.unit
    ctx.beginPath()
    ctx.moveTo(o.x, top)
    ctx.lineTo(o.x, top + o.height)
    ctx.stroke()

    ctx.textAlign = o.side === 'left' ? 'right' : 'left'

    for (const tick of tapeTicks({
      value: o.value,
      span: o.span,
      minorStep: o.minorStep,
      majorStep: o.majorStep,
      min: o.min,
    })) {
      // frac 0 is the bottom of the visible span — low numbers below, which is how
      // both a speed tape and an altimeter read.
      const y = top + o.height * (1 - tick.frac)
      const length = (tick.major ? 12 : 6) * this.unit

      ctx.strokeStyle = tick.major ? GREEN : FAINT
      ctx.beginPath()
      ctx.moveTo(o.x, y)
      ctx.lineTo(o.x + dir * length, y)
      ctx.stroke()

      if (tick.major) {
        ctx.fillStyle = DIM
        this.label(tick.value.toFixed(0), o.x + dir * (length + 5 * this.unit), y)
      }
    }

    // The unit, at the top of the tape. It sat next to the value box first and drew
    // straight through the graduations, which made both unreadable.
    ctx.fillStyle = FAINT
    ctx.textAlign = 'center'
    this.label(o.label, o.x, top - 12 * this.unit)

    this.drawValueBox(o.x, o.y, dir, o.value.toFixed(o.digits))
  }

  /** The boxed current value, with the pointer that stays put while the tape moves. */
  private drawValueBox(x: number, y: number, dir: number, text: string): void {
    const { ctx } = this
    const padding = 7 * this.unit
    const w = Math.max(66 * this.unit, ctx.measureText(text).width + padding * 3)
    const h = 24 * this.unit
    const nose = 7 * this.unit

    const near = x + dir * nose
    const far = x + dir * (nose + w)

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.strokeStyle = GREEN
    ctx.lineWidth = 1.5 * this.unit
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(near, y - h / 2)
    ctx.lineTo(far, y - h / 2)
    ctx.lineTo(far, y + h / 2)
    ctx.lineTo(near, y + h / 2)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    ctx.fillStyle = GREEN
    ctx.textAlign = dir < 0 ? 'left' : 'right'
    this.label(text, far - dir * padding, y)
  }

  /**
   * Vertical speed, as a caret beside the altitude tape.
   *
   * Logarithmic travel. Linear would spend the whole scale on the 6,000 fpm climb
   * this aircraft can do at full burner and leave the 300 fpm that separates a
   * landing from an arrival indistinguishable from zero.
   */
  private drawVerticalSpeed(x: number, y: number, height: number, fpm: number): void {
    const { ctx } = this
    const magnitude = Math.min(1, Math.log10(1 + Math.abs(fpm) / 100) / Math.log10(101))
    const offset = -Math.sign(fpm) * magnitude * (height / 2)
    // Far enough out to clear the altitude box, which is 66 units wide before its
    // pointer. At 96 the caret read as part of the box.
    const px = x + 138 * this.unit

    ctx.strokeStyle = FAINT
    ctx.lineWidth = 1 * this.unit
    ctx.beginPath()
    ctx.moveTo(px, y - height / 2)
    ctx.lineTo(px, y + height / 2)
    ctx.stroke()

    ctx.fillStyle = GREEN
    ctx.beginPath()
    ctx.moveTo(px - 7 * this.unit, y + offset)
    ctx.lineTo(px, y + offset - 5 * this.unit)
    ctx.lineTo(px, y + offset + 5 * this.unit)
    ctx.closePath()
    ctx.fill()
  }

  private drawHeading(input: HudInputs): void {
    const { ctx } = this
    const cx = this.width / 2
    const y = Math.max(46 * this.unit, this.height * 0.09)
    const w = Math.min(this.width * 0.5, 560 * this.unit)
    const span = 60

    ctx.strokeStyle = DIM
    ctx.lineWidth = 1.2 * this.unit
    ctx.beginPath()
    ctx.moveTo(cx - w / 2, y)
    ctx.lineTo(cx + w / 2, y)
    ctx.stroke()

    ctx.textAlign = 'center'

    for (const tick of tapeTicks({
      value: input.state.headingDeg,
      span,
      minorStep: 5,
      majorStep: 10,
      wrap: 360,
    })) {
      const x = cx - w / 2 + w * tick.frac
      const length = (tick.major ? 9 : 5) * this.unit

      ctx.strokeStyle = tick.major ? GREEN : FAINT
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x, y - length)
      ctx.stroke()

      if (tick.major && tick.value % 30 === 0) {
        ctx.fillStyle = DIM
        // Below the line, not above it. Above is where the boxed heading lives, and
        // the two were drawing through each other at every multiple of thirty.
        //
        // The tens digit only, the way a compass rose is marked: 240 becomes 24.
        // Three digits every thirty degrees is more ink than the strip can carry.
        this.label((tick.value / 10).toFixed(0).padStart(2, '0'), x, y + 15 * this.unit)
      }
    }

    // The steering diamond. The course knows the bearing; without this the only way
    // to fly it is to read a name and a distance off the corner of the screen and
    // guess which way to turn.
    if (input.steer) {
      const frac = headingFrac(input.state.headingDeg, input.steer.bearingDeg, span)
      if (frac !== null) {
        const x = cx - w / 2 + w * frac
        const d = 6 * this.unit
        // Under the numbers, so the diamond and a label never sit on each other.
        const top = y + 26 * this.unit
        ctx.strokeStyle = GREEN
        ctx.lineWidth = 1.6 * this.unit
        ctx.beginPath()
        ctx.moveTo(x, top)
        ctx.lineTo(x + d, top + d)
        ctx.lineTo(x, top + d * 2)
        ctx.lineTo(x - d, top + d)
        ctx.closePath()
        ctx.stroke()
      }
    }

    // Lubber line and the boxed heading under it.
    ctx.strokeStyle = GREEN
    ctx.lineWidth = 1.8 * this.unit
    ctx.beginPath()
    ctx.moveTo(cx, y - 12 * this.unit)
    ctx.lineTo(cx, y + 10 * this.unit)
    ctx.stroke()

    const text = input.state.headingDeg.toFixed(0).padStart(3, '0')
    const boxW = 52 * this.unit
    const boxH = 21 * this.unit
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.strokeStyle = GREEN
    ctx.lineWidth = 1.4 * this.unit
    ctx.beginPath()
    ctx.rect(cx - boxW / 2, y - 14 * this.unit - boxH, boxW, boxH)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = GREEN
    ctx.textAlign = 'center'
    this.label(text, cx, y - 14 * this.unit - boxH / 2)
  }

  private drawReadouts(input: HudInputs): void {
    const { ctx } = this
    const cx = this.width / 2
    const cy = this.height / 2
    const tapeBottom = cy + Math.min(this.height * 0.46, 420 * this.unit) / 2
    const line = 18 * this.unit

    // Mach and G, under the airspeed tape, in the F-16's own arrangement.
    ctx.textAlign = 'left'
    ctx.fillStyle = GREEN
    const leftX = cx - this.half
    this.label(`M ${input.state.mach.toFixed(2)}`, leftX, tapeBottom + line)
    this.label(`G ${input.nz.toFixed(1)}`, leftX, tapeBottom + line * 2)
    ctx.fillStyle = DIM
    this.label(`A ${input.state.alphaDeg.toFixed(1)}`, leftX, tapeBottom + line * 3)

    // Throttle and power. Power is what the engine is actually making; the gap
    // between the two is spool time, and it is several seconds at low speed.
    ctx.textAlign = 'right'
    const rightX = cx + this.half
    ctx.fillStyle = GREEN
    this.label(`THR ${Math.round(input.throttle * 100)}`, rightX, tapeBottom + line)
    this.label(`PWR ${Math.round(input.state.power)}`, rightX, tapeBottom + line * 2)
    // The burner lights at fifty per cent and is worth its own word — it is most of
    // the aircraft's acceleration and all of its fuel flow.
    if (input.state.power > 50) {
      ctx.fillStyle = WARN
      this.label('AB', rightX, tapeBottom + line * 3)
    }

    // Everything that is a sentence rather than a symbol goes in one stack at the
    // bottom left, under the Mach and G column, drawn upward from the last line.
    //
    // Not the middle. The middle of the glass belongs to the conformal symbology,
    // and a caption at a fixed screen position eventually lands on a rung, on the
    // boresight, or on the flight path marker. Centred, it did: in a forty-degree
    // climb at twenty-two degrees alpha the marker sits near the bottom of the
    // glass, which is precisely the attitude that lights AOA LIMIT — so the caution
    // and the instrument it is about were drawn on top of each other, every time.
    //
    // Bottom left is not arbitrary either. It is the corner the marker reaches only
    // in a left-banked climb, and it continues the column that already answers "how
    // hard is this aeroplane working".
    const stack: { text: string; color: string }[] = []

    for (const warning of input.warnings) stack.push({ text: warning, color: WARN })

    if (input.steer) {
      stack.push({
        text:
          `${input.steer.name}  ${input.steer.distanceNm.toFixed(1)} NM  ` +
          `${input.steer.bearingDeg.toFixed(0).padStart(3, '0')}`,
        color: DIM,
      })
    }

    const cue = input.cue
    if (cue.kind === 'rotate') {
      stack.push({
        text: cue.ready ? '\u25b2 ROTATE \u25b2' : `ROTATE ${cue.targetKt.toFixed(0)}`,
        color: cue.ready ? WARN : DIM,
      })
    } else if (cue.kind === 'approach') {
      const sign = cue.deltaKt >= 0 ? '+' : '\u2212'
      stack.push({
        text: `APPROACH ${cue.targetKt.toFixed(0)}  ${sign}${Math.abs(cue.deltaKt).toFixed(0)}`,
        // Above about thirty knots over, this aircraft floats rather than lands.
        color: cue.deltaKt > 30 ? WARN : DIM,
      })
    }

    stack.push({
      text:
        `GEAR ${input.gearDown ? 'DN' : 'UP'}${input.onGround ? '  WOW' : ''}` +
        `${input.parkingBrake ? '  PARK' : ''}`,
      color: input.gearDown ? GREEN : FAINT,
    })

    ctx.textAlign = 'left'
    let y = this.height - 46 * this.unit - (stack.length - 1) * line
    for (const row of stack) {
      ctx.fillStyle = row.color
      this.label(row.text, leftX, y)
      y += line
    }
  }
}
