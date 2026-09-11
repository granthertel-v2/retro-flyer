/**
 * The launch screen, the pause menu, and the gate a phone gets instead.
 *
 * Everything up to now assumed the page *was* the simulator: `main()` ran on load,
 * the world was chosen by hand-editing `?region=` onto the address, and the controls
 * card was reachable only by pressing a key nobody had been told about. That is the
 * right shape for something you fly yourself and the wrong shape for something you
 * send to somebody. This is the shell that makes the difference.
 *
 * ## Why DOM, and why it looks like the help card
 *
 * `help.ts` already made this call and its reasoning holds: "it is plain DOM rather
 * than canvas because it is text in a box, and the browser is already extremely good
 * at text in a box." The HUD and the minimap are 2D canvases over the WebGL one
 * because they are instruments; a menu is not. So the shell borrows the help card's
 * palette and chrome exactly — phosphor `#5dff9b` on `rgba(6,14,10,.92)`, a hairline
 * green border, monospace, wide tracking — and looks like part of the same object.
 *
 * The one departure is a real stylesheet rather than inline `cssText`. Every existing
 * overlay is `pointer-events:none` and has nothing to click; this has buttons, and
 * buttons need `:hover` and `:focus-visible`, which an inline style cannot express.
 *
 * ## Why the launch screen is also the loading screen
 *
 * A region is about three and a half megabytes, and until now the page showed nothing
 * at all while it arrived — not even a background colour, because `main()` styles the
 * body only after the fetch resolves. The first thing a stranger saw on a shared link
 * was a blank white page for several seconds. Once the world is chosen on a screen
 * that already exists, the download has somewhere to report into, and the fix costs
 * nothing beyond not tearing the screen down too early.
 *
 * ## Why a phone gets a different page rather than a worse one
 *
 * There is no touch control scheme — `input.ts` says "this is the only file that knows
 * a keyboard exists" — so a phone renders a flight simulator in which not one control
 * can be moved. Worse, the help card self-dismisses on the first tap and `/` cannot be
 * typed, so the instructions are gone for good. Loading three megabytes to reach that
 * is not a courtesy to anyone. The gate says what the thing is and where to open it.
 */

import { controlsMarkup } from '../help.js'
import {
  CREDITS,
  MAPS,
  canFly,
  nameOf,
  type LaunchOptions,
  type MapId,
  type SpawnMode,
} from './options.js'

const STYLE_ID = 'rf-shell-style'

const CSS = `
.rf-root {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 24px;
  background: rgba(0,0,0,.55);
  font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #cfe9d8;
  pointer-events: auto;
  z-index: 20;
  -webkit-font-smoothing: antialiased;
}
.rf-panel {
  width: min(880px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 28px 32px 24px;
  border: 1px solid rgba(93,255,155,.35);
  background: rgba(6,14,10,.92);
  box-shadow: 0 0 60px rgba(0,0,0,.6);
}
.rf-title {
  color: #5dff9b;
  font-size: 19px;
  letter-spacing: .2em;
}
.rf-sub {
  opacity: .78;
  margin: 10px 0 24px;
  max-width: 64ch;
}
.rf-label {
  color: #5dff9b;
  letter-spacing: .14em;
  margin: 0 0 8px;
  font-size: 12px;
}
.rf-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(232px, 1fr));
  gap: 10px;
  margin-bottom: 22px;
}
.rf-card {
  display: block;
  width: 100%;
  text-align: left;
  padding: 13px 15px;
  border: 1px solid rgba(93,255,155,.22);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color .12s, background-color .12s;
}
.rf-card:hover { border-color: rgba(93,255,155,.55); }
.rf-card:focus-visible { outline: 1px solid #5dff9b; outline-offset: 2px; }
.rf-card[aria-pressed="true"] {
  border-color: rgba(93,255,155,.85);
  background: rgba(93,255,155,.10);
}
.rf-card-name { color: #5dff9b; }
.rf-card-weight { opacity: .45; float: right; font-size: 12px; }
.rf-card-blurb { opacity: .72; margin-top: 3px; }
.rf-seg { display: flex; gap: 10px; margin-bottom: 24px; flex-wrap: wrap; }
.rf-seg .rf-card { width: auto; flex: 1 1 232px; }
.rf-actions {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.rf-fly {
  padding: 13px 42px;
  border: 1px solid #5dff9b;
  background: rgba(93,255,155,.14);
  color: #5dff9b;
  font: inherit;
  font-size: 15px;
  letter-spacing: .22em;
  cursor: pointer;
  transition: background-color .12s;
}
.rf-fly:hover { background: rgba(93,255,155,.26); }
.rf-fly:focus-visible { outline: 1px solid #5dff9b; outline-offset: 3px; }
.rf-fly[disabled] { opacity: .45; cursor: default; }
.rf-link {
  padding: 4px 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  opacity: .62;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.rf-link:hover { opacity: 1; color: #5dff9b; }
.rf-link:focus-visible { outline: 1px solid #5dff9b; outline-offset: 2px; }
.rf-menu { display: flex; flex-direction: column; gap: 9px; margin: 4px 0 22px; }
.rf-menu .rf-card { text-align: center; letter-spacing: .12em; }
.rf-note { opacity: .5; margin-top: 20px; }
.rf-status { color: #5dff9b; margin-top: 6px; letter-spacing: .12em; }
.rf-error { color: #ffd166; margin-top: 6px; }
.rf-credits {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid rgba(93,255,155,.16);
  opacity: .5;
  font-size: 12px;
  line-height: 1.6;
}
.rf-controls { margin: 4px 0 20px; }
.rf-hidden { display: none !important; }
.rf-mark { display: block; margin: 0 auto 22px; opacity: .8; }
`

/** Inject the stylesheet once, however many screens get built. */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.append(style)
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}

/**
 * The flight path marker, as a mark.
 *
 * The README calls it "the instrument worth understanding" and the whole reason the
 * HUD exists, so it is the right thing to put at the top of a page about this
 * simulator — and it is eight lines of SVG rather than a screenshot in the repository.
 */
const MARK = `
<svg class="rf-mark" width="76" height="30" viewBox="0 0 76 30" fill="none"
     stroke="#5dff9b" stroke-width="1.6" aria-hidden="true">
  <circle cx="38" cy="15" r="7.5" />
  <path d="M30.5 15 H14 M45.5 15 H62 M38 7.5 V2" />
</svg>`

/** Credit block, shown on every screen of the shell. */
function creditsBlock(): HTMLElement {
  return el(
    'div',
    'rf-credits',
    `${CREDITS.map((line) => `<div>${line}</div>`).join('')}` +
      `<div style="margin-top:6px">Flight model from NASA/TM-2003-212145 and ` +
      `Stevens &amp; Lewis, <i>Aircraft Control and Simulation</i>.</div>`,
  )
}

export interface LaunchScreenHandlers {
  /** The user pressed FLY. */
  onFly(options: LaunchOptions): void
}

/**
 * The first screen: what this is, where to fly it, and how you start.
 *
 * Constructed before anything else exists — before the canvas, before any region is
 * fetched, before `main()` runs at all — so that a visitor on a slow connection has
 * something to read rather than a white page, and so that a phone can be turned away
 * without downloading a world it cannot use.
 */
export class LaunchScreen {
  private readonly root: HTMLElement
  private readonly panel: HTMLElement
  private readonly status: HTMLElement
  private readonly flyButton: HTMLButtonElement
  private options: LaunchOptions
  private readonly mapButtons = new Map<MapId, HTMLButtonElement>()
  private readonly spawnButtons = new Map<SpawnMode, HTMLButtonElement>()

  constructor(
    initial: LaunchOptions,
    private readonly handlers: LaunchScreenHandlers,
    parent: HTMLElement = document.body,
  ) {
    ensureStyle()
    this.options = { ...initial }

    this.root = el('div', 'rf-root')
    this.panel = el('div', 'rf-panel')
    this.root.append(this.panel)

    this.panel.append(el('div', 'rf-title', 'RETRO FLYER'))
    this.panel.append(
      el(
        'div',
        'rf-sub',
        'An F-16 with a real aerodynamic model underneath it, over a deliberately crude ' +
          'world. Pick somewhere to fly.',
      ),
    )

    // --- world ---------------------------------------------------------
    this.panel.append(el('div', 'rf-label', 'WHERE'))
    const cards = el('div', 'rf-cards')
    for (const map of MAPS) {
      const card = el('button', 'rf-card') as HTMLButtonElement
      card.type = 'button'
      card.innerHTML =
        `<span class="rf-card-weight">${map.weight}</span>` +
        `<div class="rf-card-name">${map.name}</div>` +
        `<div class="rf-card-blurb">${map.blurb}</div>`
      card.addEventListener('click', () => {
        this.options.map = map.id
        this.refresh()
      })
      this.mapButtons.set(map.id, card)
      cards.append(card)
    }
    this.panel.append(cards)

    // --- spawn ---------------------------------------------------------
    this.panel.append(el('div', 'rf-label', 'HOW YOU START'))
    const seg = el('div', 'rf-seg')
    const spawnChoices: readonly [SpawnMode, string, string][] = [
      [
        'airborne',
        'Already flying',
        'Trimmed and level at 2,200 ft, lined up on a runway ten kilometres ahead.',
      ],
      [
        'runway',
        'On the runway',
        'Parked at the threshold, engine idling. Takeoff is the hard part.',
      ],
    ]
    for (const [mode, name, blurb] of spawnChoices) {
      const button = el('button', 'rf-card') as HTMLButtonElement
      button.type = 'button'
      button.innerHTML =
        `<div class="rf-card-name">${name}</div>` + `<div class="rf-card-blurb">${blurb}</div>`
      button.addEventListener('click', () => {
        this.options.spawn = mode
        this.refresh()
      })
      this.spawnButtons.set(mode, button)
      seg.append(button)
    }
    this.panel.append(seg)

    // --- controls, folded away ------------------------------------------
    const controls = el('div', 'rf-controls rf-hidden', controlsMarkup())
    const controlsLink = el('button', 'rf-link', 'Controls') as HTMLButtonElement
    controlsLink.type = 'button'
    controlsLink.addEventListener('click', () => {
      const hidden = controls.classList.toggle('rf-hidden')
      controlsLink.textContent = hidden ? 'Controls' : 'Hide controls'
    })

    // --- go -------------------------------------------------------------
    this.flyButton = el('button', 'rf-fly', 'FLY') as HTMLButtonElement
    this.flyButton.type = 'button'
    this.flyButton.addEventListener('click', () => this.fly())

    const actions = el('div', 'rf-actions')
    actions.append(this.flyButton, controlsLink)
    this.panel.append(actions)
    this.panel.append(controls)

    this.status = el('div', 'rf-status rf-hidden')
    this.panel.append(this.status)

    this.panel.append(
      el('div', 'rf-note', 'A keyboard is required. Press <b>/</b> in flight for the controls.'),
    )
    this.panel.append(creditsBlock())

    parent.append(this.root)
    this.refresh()

    // Enter flies, so the whole screen can be cleared without reaching for the mouse.
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === this.root) this.fly()
    })
    this.flyButton.focus()
  }

  /** Paint the current selection onto the cards. */
  private refresh(): void {
    for (const [id, button] of this.mapButtons) {
      button.setAttribute('aria-pressed', String(id === this.options.map))
    }
    for (const [mode, button] of this.spawnButtons) {
      button.setAttribute('aria-pressed', String(mode === this.options.spawn))
    }
  }

  private fly(): void {
    if (this.flyButton.disabled) return
    this.flyButton.disabled = true
    this.handlers.onFly({ ...this.options })
  }

  /**
   * Hold the screen up and say what is happening.
   *
   * The panel stays exactly where it is. Swapping it for a different loading screen
   * would be a flash of one layout replaced by another for something that takes two
   * seconds; this just tells the user what they are waiting for.
   */
  loading(what: string): void {
    this.status.classList.remove('rf-hidden')
    this.status.classList.remove('rf-error')
    this.status.classList.add('rf-status')
    this.status.textContent = `LOADING ${what.toUpperCase()}…`
  }

  /**
   * Say that it did not work, and let them try again.
   *
   * Previously a failed region load wrote to the console and dropped the pilot into
   * the authored map without a word. That was the right call when the region was
   * something you opted into by typing a query parameter; having just promised a
   * city on a screen, silently delivering a different world is not.
   */
  failed(message: string): void {
    this.status.classList.remove('rf-hidden')
    this.status.classList.remove('rf-status')
    this.status.classList.add('rf-error')
    this.status.textContent = message
    this.flyButton.disabled = false
  }

  hide(): void {
    this.root.classList.add('rf-hidden')
  }

  /**
   * Replace the whole screen with the one a phone or tablet should see.
   *
   * No canvas is made, no region is fetched, and `main()` is never called — so this
   * costs a visitor on a phone a few kilobytes rather than three and a half megabytes
   * of a world they cannot fly in.
   */
  gate(): void {
    this.panel.replaceChildren()
    this.panel.insertAdjacentHTML('beforeend', MARK)
    this.panel.append(el('div', 'rf-title', 'RETRO FLYER'))
    this.panel.append(
      el(
        'div',
        'rf-sub',
        'A browser flight simulator: an F-16 with a validated six-degree-of-freedom ' +
          'aerodynamic model, flown over surveyed terrain and real buildings in a ' +
          'deliberately crude polygon world.',
      ),
    )
    this.panel.append(el('div', 'rf-label', 'IT NEEDS A KEYBOARD'))
    this.panel.append(
      el(
        'div',
        'rf-sub',
        'Pitch, roll, rudder, throttle and brakes are all keys, and there is no touch ' +
          'control scheme — so this will not fly on a phone or a tablet. Open the same ' +
          'link on a laptop or desktop and it will.',
      ),
    )

    const anyway = el('button', 'rf-link', 'I have a keyboard attached — open it anyway')
    ;(anyway as HTMLButtonElement).type = 'button'
    anyway.addEventListener('click', () => {
      const params = new URLSearchParams(location.search)
      params.set('desktop', '1')
      location.search = params.toString()
    })
    this.panel.append(anyway)
    this.panel.append(creditsBlock())
  }
}

export interface PauseMenuHandlers {
  onResume(): void
  /** Put the aircraft back where this flight started. */
  onRestart(): void
  /** Leave for the launch screen, which means a reload. */
  onChangeWorld(): void
}

/**
 * The menu behind Escape.
 *
 * Deliberately not built on `Simulation.paused`. That flag exists and does the right
 * thing to the physics, but slew also writes it — leaving slew sets it back to false
 * unconditionally — so a menu that used it could be un-paused out from under itself by
 * a keystroke it never saw. The menu owns its own state and `main` gates the step on
 * both.
 */
export class PauseMenu {
  private readonly root: HTMLElement
  private open = false

  constructor(
    private readonly handlers: PauseMenuHandlers,
    parent: HTMLElement = document.body,
  ) {
    ensureStyle()

    this.root = el('div', 'rf-root rf-hidden')
    const panel = el('div', 'rf-panel')
    this.root.append(panel)

    panel.append(el('div', 'rf-title', 'PAUSED'))

    const controls = el('div', 'rf-controls rf-hidden', controlsMarkup())

    const menu = el('div', 'rf-menu')
    const entries: readonly [string, () => void][] = [
      ['RESUME', () => this.handlers.onResume()],
      ['RESTART THIS FLIGHT', () => this.handlers.onRestart()],
      [
        'CONTROLS',
        () => {
          controls.classList.toggle('rf-hidden')
        },
      ],
      ['CHANGE WORLD', () => this.handlers.onChangeWorld()],
    ]
    for (const [label, action] of entries) {
      const button = el('button', 'rf-card', label) as HTMLButtonElement
      button.type = 'button'
      button.addEventListener('click', action)
      menu.append(button)
    }

    panel.append(menu)
    panel.append(controls)
    panel.append(
      el('div', 'rf-note', '<b>Esc</b> resumes. Nothing moves while this is up.'),
    )
    panel.append(creditsBlock())

    parent.append(this.root)
  }

  get isOpen(): boolean {
    return this.open
  }

  show(): void {
    this.open = true
    this.root.classList.remove('rf-hidden')
  }

  hide(): void {
    this.open = false
    this.root.classList.add('rf-hidden')
  }

  toggle(): void {
    if (this.open) this.hide()
    else this.show()
  }
}

/** The current window, in the terms `canFly` wants. */
export function viewport(): { width: number; height: number; coarsePointer: boolean } {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
  }
}

/** Whether this browser, right now, can fly it. */
export const deviceCanFly = (): boolean => canFly(viewport())

/** Name for the screen to say while a world loads. */
export const loadingName = (map: MapId): string => nameOf(map)
