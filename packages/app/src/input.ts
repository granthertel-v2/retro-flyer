/**
 * Device reading. Keyboard first, gamepad if there is one (§5).
 *
 * This is the only file that knows a keyboard exists. It produces the normalised
 * axes the control package's `RawInput` describes and nothing else — the assist
 * layer on the other side is headless and stays that way, which is what lets the
 * whole of it be tested in Node.
 *
 * Raw here means *raw*: a held key reads exactly 1. All the smoothing, rate limiting
 * and deadband live in `@retro-flyer/control`, because that is where they can be
 * tested. Doing any of it here would be putting the feel of the aircraft somewhere
 * no test can reach.
 */

import type { RawInput } from '@retro-flyer/control'

/** Actions that are events rather than axes. */
export interface InputCommands {
  cycleCamera: boolean
  toggleAssist: number | null
  allAssistsOn: boolean
  allAssistsOff: boolean
  cyclePreset: boolean
  invertPitch: boolean
  togglePause: boolean
  reset: boolean
}

const NO_COMMANDS: InputCommands = {
  cycleCamera: false,
  toggleAssist: null,
  allAssistsOn: false,
  allAssistsOff: false,
  cyclePreset: false,
  invertPitch: false,
  togglePause: false,
  reset: false,
}

/** Keys that mean something, so the browser's own bindings can be suppressed. */
const CLAIMED = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'KeyQ', 'KeyE',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'KeyC', 'KeyI', 'KeyP', 'KeyR', 'KeyB',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit9',
])

export class InputReader {
  private readonly down = new Set<string>()
  private pending: InputCommands = { ...NO_COMMANDS }

  /**
   * Pitch sense. False means stick convention — pushing forward, or pressing up,
   * lowers the nose, which is what every flight sim and Ace Combat itself default
   * to. Toggled with I, because roughly half of everyone expects the other one.
   */
  invertedPitch = false

  private throttle = 0

  constructor(target: Window | HTMLElement = window) {
    target.addEventListener('keydown', this.onKeyDown as EventListener)
    target.addEventListener('keyup', this.onKeyUp as EventListener)
    // A window that loses focus never sees the keyup, so the aircraft would fly
    // away with the stick apparently still held.
    window.addEventListener('blur', this.onBlur)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return
    if (CLAIMED.has(event.code)) event.preventDefault()

    this.down.add(event.code)

    switch (event.code) {
      case 'KeyC': this.pending.cycleCamera = true; break
      case 'KeyI': this.pending.invertPitch = true; break
      case 'KeyP': this.pending.togglePause = true; break
      case 'KeyR': this.pending.reset = true; break
      case 'KeyB': this.pending.cyclePreset = true; break
      case 'Digit0': this.pending.allAssistsOff = true; break
      case 'Digit9': this.pending.allAssistsOn = true; break
      case 'Digit1': this.pending.toggleAssist = 0; break
      case 'Digit2': this.pending.toggleAssist = 1; break
      case 'Digit3': this.pending.toggleAssist = 2; break
      case 'Digit4': this.pending.toggleAssist = 3; break
      case 'Digit5': this.pending.toggleAssist = 4; break
      case 'Digit6': this.pending.toggleAssist = 5; break
      default: break
    }
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code)
  }

  private readonly onBlur = (): void => {
    this.down.clear()
  }

  private held(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c))
  }

  /**
   * Read the axes. `dt` is needed because throttle is an accumulator — the keyboard
   * has no analogue axis, so holding shift ramps it.
   */
  axes(dt: number): RawInput {
    const pad = navigator.getGamepads?.().find((p) => p?.connected) ?? null

    let pitch = 0
    let roll = 0
    let yaw = 0

    if (this.held('ArrowUp', 'KeyW')) pitch -= 1
    if (this.held('ArrowDown', 'KeyS')) pitch += 1
    if (this.held('ArrowRight', 'KeyD')) roll += 1
    if (this.held('ArrowLeft', 'KeyA')) roll -= 1
    if (this.held('KeyE')) yaw += 1
    if (this.held('KeyQ')) yaw -= 1

    if (this.held('ShiftLeft', 'ShiftRight')) this.throttle += dt / 1.5
    if (this.held('ControlLeft', 'ControlRight')) this.throttle -= dt / 1.5

    if (pad) {
      // Standard mapping: left stick roll/pitch, right stick X yaw, triggers
      // throttle. The gamepad wins when it is being moved, so plugging one in does
      // not disable the keyboard.
      const [lx = 0, ly = 0, rx = 0] = pad.axes
      if (Math.abs(lx) > 0.02) roll = lx
      if (Math.abs(ly) > 0.02) pitch = -ly
      if (Math.abs(rx) > 0.02) yaw = rx

      const forward = pad.buttons[7]?.value ?? 0
      const back = pad.buttons[6]?.value ?? 0
      if (forward > 0.02 || back > 0.02) this.throttle += (forward - back) * dt
    }

    this.throttle = Math.min(1, Math.max(0, this.throttle))

    return {
      pitch: this.invertedPitch ? -pitch : pitch,
      roll,
      yaw,
      throttle: this.throttle,
    }
  }

  /** Drain the one-shot commands. Calling this twice in a frame gets them once. */
  commands(): InputCommands {
    const out = this.pending
    this.pending = { ...NO_COMMANDS }

    if (out.invertPitch) this.invertedPitch = !this.invertedPitch
    return out
  }

  /** Seed the throttle when the simulation spawns already trimmed. */
  setThrottle(value: number): void {
    this.throttle = Math.min(1, Math.max(0, value))
  }
}
