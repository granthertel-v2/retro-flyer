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
      // Where it is actually going, as opposed to where it is pointed. This is the
      // gap the §9.1 flight path marker exists to show, and without some form of it
      // a hard pull looks like nothing is happening: the nose reaches sixty degrees
      // nose-up several seconds before the aircraft is meaningfully climbing.
      pad('PATH', `${state.gammaDeg.toFixed(1)}°`),
      pad('BETA', `${state.betaDeg.toFixed(1)}°`),
      pad('G', nz.toFixed(2)),
      pad('ROLL RT', `${state.rates[0].toFixed(0)}°/s`),
      pad('THROTTLE', `${Math.round(throttle * 100)}%`),
      pad('POWER', `${Math.round(state.power)}%`),
      '',
      telemetry?.aoaLimiting ? '<b>AOA LIMIT</b>' : '',
      telemetry?.gLimiting ? '<b>G LIMIT</b>' : '',
      paused ? '<b>PAUSED</b>' : '',
    ]
      .filter(Boolean)
      .join('<br>')
      .replace(/ /g, '&nbsp;')

    const assists = ASSIST_LABELS.map(([key, label]) => {
      const on = layer.toggles[key]
      return `<span style="opacity:${on ? 1 : 0.32}">${label}</span>`
    }).join('<br>')

    this.right.innerHTML = [
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
    ].join('<br>')
  }
}
