/**
 * Development readout.
 *
 * **This is not the HUD.** §9.1's HUD — airspeed and altitude tapes, pitch ladder,
 * and the flight path marker that is the whole point of it — is Day 4 work and is
 * deliberately not started here. This is a corner of text that exists so that Day 2
 * can be judged at all: without airspeed and altitude on screen there is no way to
 * say whether 500 knots at 500 feet reads as fast, and no way to tell a control law
 * problem from a rendering one.
 */

import type { AssistLayer } from '@retro-flyer/control'
import type { RenderState } from './seam.js'
import type { CameraMode } from './camera/chase.js'
import type { CourseProgress, Waypoint } from './course.js'

/** Day 3 state the readout needs and the render state does not carry. */
export interface GroundStatus {
  onGround: boolean
  gearDown: boolean
  brakes: boolean
  bottomed: boolean
  slewing: boolean
  course: CourseProgress
  waypoints: readonly Waypoint[]
  /** A transient message — SAVED, RESTORED, NO SAVE. */
  note: string
}

const clock = (seconds: number): string => {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

const ASSIST_LABELS = [
  ['pitchRateCommand', 'PITCH CMD'],
  ['rollRateCommand', 'ROLL CMD'],
  ['autoCoordination', 'COORD'],
  ['aoaLimiter', 'AOA LIM'],
  ['gLimiter', 'G LIM'],
  ['rollAmplification', 'ROLL AMP'],
] as const

export class Overlay {
  private readonly root: HTMLElement
  private readonly left: HTMLElement
  private readonly right: HTMLElement
  private frames = 0
  private fps = 0
  private lastSample = performance.now()

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div')
    this.root.style.cssText = [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#b8f5c8',
      'text-shadow:0 0 6px rgba(0,0,0,.9)',
      'padding:14px',
      'display:flex',
      'justify-content:space-between',
      'align-items:flex-start',
    ].join(';')

    this.left = document.createElement('div')
    this.right = document.createElement('div')
    this.right.style.textAlign = 'right'

    this.root.append(this.left, this.right)
    parent.append(this.root)
  }

  update(
    state: RenderState,
    layer: AssistLayer,
    nz: number,
    mode: CameraMode,
    paused: boolean,
    ticks: number,
    throttle: number,
    ground: GroundStatus,
  ): void {
    this.frames++
    const now = performance.now()
    if (now - this.lastSample > 500) {
      this.fps = (this.frames * 1000) / (now - this.lastSample)
      this.frames = 0
      this.lastSample = now
    }

    const telemetry = layer.lastTelemetry()
    const pad = (label: string, value: string): string =>
      `${label.padEnd(9)}${value.padStart(9)}`

    this.left.innerHTML = [
      pad('IAS', `${state.kt.toFixed(0)} kt`),
      pad('MACH', state.mach.toFixed(2)),
      pad('ALT', `${state.altFt.toFixed(0)} ft`),
      pad('VS', `${(state.climbFpm >= 0 ? '+' : '')}${Math.round(state.climbFpm)} fpm`),
      pad('AOA', `${state.alphaDeg.toFixed(1)}°`),
      // Pitch attitude next to flight path, deliberately adjacent: the gap between
      // them is angle of attack, and seeing the two diverge under a pull is the
      // intuition §9.1's flight path marker exists to build.
      pad('PITCH', `${state.pitchDeg.toFixed(1)}°`),
      // Where it is actually going, as opposed to where it is pointed. This is the
      // gap the §9.1 flight path marker exists to show, and without some form of it
      // a hard pull looks like nothing is happening: the nose reaches sixty degrees
      // nose-up several seconds before the aircraft is meaningfully climbing.
      pad('PATH', `${state.gammaDeg.toFixed(1)}°`),
      pad('BETA', `${state.betaDeg.toFixed(1)}°`),
      pad('HDG', `${state.headingDeg.toFixed(0).padStart(3, '0')}°`),
      pad('G', nz.toFixed(2)),
      pad('ROLL RT', `${state.rates[0].toFixed(0)}°/s`),
      pad('THROTTLE', `${Math.round(throttle * 100)}%`),
      pad('POWER', `${Math.round(state.power)}%`),
      '',
      telemetry?.aoaLimiting ? '<b>AOA LIMIT</b>' : '',
      telemetry?.gLimiting ? '<b>G LIMIT</b>' : '',
      ground.bottomed ? '<b>GEAR BOTTOMED</b>' : '',
      ground.slewing ? '<b>SLEW</b>' : paused ? '<b>PAUSED</b>' : '',
      '',
      // Gear state, always visible: knowing whether the wheels are down and whether
      // they are carrying anything is most of what a takeoff or a landing is about.
      `GEAR ${ground.gearDown ? 'DN' : 'UP'}${ground.onGround ? ' &middot; WOW' : ''}${
        ground.brakes ? ' &middot; BRK' : ''
      }`,
      ground.note ? `<b>${ground.note}</b>` : '',
    ]
      .filter(Boolean)
      .join('<br>')
      .replace(/ /g, '&nbsp;')

    const assists = ASSIST_LABELS.map(([key, label]) => {
      const on = layer.toggles[key]
      return `<span style="opacity:${on ? 1 : 0.32}">${label}</span>`
    }).join('<br>')

    const c = ground.course
    const next = ground.waypoints[c.index]

    const courseLines =
      c.status === 'complete'
        ? [
            '<b>COURSE COMPLETE</b>',
            `time ${clock(c.elapsed)}`,
            ...c.splits.map((t, i) => `${(ground.waypoints[i]?.name ?? '').padEnd(6)} ${clock(t)}`),
          ]
        : c.status === 'ready'
          ? ['<span style="opacity:.55">COURSE &mdash; take off to start</span>']
          : [
              `COURSE ${clock(c.elapsed)}`,
              next
                ? `next ${next.name} &nbsp;${(c.distanceM / 1852).toFixed(1)} nm` +
                  `<br><span style="opacity:${c.altitudeOk ? 1 : 0.45}">` +
                  `${next.minAltFt}-${next.maxAltFt} ft ${c.altitudeOk ? '&check;' : ''}</span>` +
                  `<br><span style="opacity:.55">${next.hint}</span>`
                : 'land at Ridgeview',
              ...c.splits.map((t, i) => `${(ground.waypoints[i]?.name ?? '').padEnd(6)} ${clock(t)}`),
            ]

    this.right.innerHTML = [
      ...courseLines,
      '',
      `${this.fps.toFixed(0)} fps`,
      `${ticks} ticks`,
      `cam ${mode}`,
      `preset ${layer.preset.name}`,
      '',
      assists,
      '',
      '<span style="opacity:.55">X / Z &nbsp;throttle up / down</span>',
      '<span style="opacity:.55">arrows or WASD &nbsp;pitch, roll</span>',
      '<span style="opacity:.55">Q / E &nbsp;rudder &middot; I &nbsp;invert pitch</span>',
      '<span style="opacity:.55">C cam &middot; B preset &middot; P pause &middot; R reset</span>',
      '<span style="opacity:.55">1-6 assists &middot; 0 none &middot; 9 all</span>',
      '<span style="opacity:.55">space brakes &middot; G gear &middot; T next field</span>',
      '<span style="opacity:.55">V slew &middot; F5 save &middot; F9 load &middot; N course</span>',
    ].join('<br>')
  }
}
