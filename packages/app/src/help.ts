/**
 * The controls card.
 *
 * Day 4's acceptance criterion (§9) is "live link, someone else can fly it", and
 * that second half is a real requirement rather than a nicety. Everything up to now
 * has been flown by the person who wrote it, with the key bindings printed in the
 * corner of a debug readout that Day 4 turns off — because a head-up display with a
 * wall of text over it is not a head-up display.
 *
 * So the bindings need somewhere to live that a stranger will find. This is it: up
 * on load, gone on the first keypress, back on `/`.
 *
 * It is plain DOM rather than canvas because it is text in a box, and the browser is
 * already extremely good at text in a box.
 */

interface Group {
  title: string
  rows: readonly (readonly [string, string])[]
}

const GROUPS: readonly Group[] = [
  {
    title: 'Fly',
    rows: [
      // Which key pulls is named, not implied. QA found this was the single most
      // likely way a first flight fails: "pitch — pull to climb" does not tell a
      // newcomer that UP is nose *down*, and pressing the obvious key puts the nose
      // into the ground while the pilot concludes the simulator is broken.
      ['↓ or S', '<b>pull</b> — nose up, and climb'],
      ['↑ or W', 'push — nose down'],
      ['← → / A D', 'roll'],
      ['Q E', 'rudder'],
      ['X Z', 'throttle up / down — afterburner above 50%'],
      ['Space', 'wheel brakes'],
      ['G', 'landing gear'],
      ['K', 'parking brake'],
    ],
  },
  {
    title: 'Where to start',
    rows: [
      ['T', 'next airfield, lined up on the runway'],
      ['N', 'restart the timed course'],
      ['R', 'reset to the opening position'],
      ['F5 / F9', 'save / restore the exact situation'],
      ['V', 'slew — fly the aircraft around with the physics off'],
    ],
  },
  {
    title: 'View',
    rows: [
      ['C', 'camera: chase, cockpit, orbit'],
      ['H', 'head-up display'],
      ['M', 'moving map: zoom in, then off'],
      ['O', 'developer readout'],
      ['P', 'pause'],
      ['/', 'this card'],
    ],
  },
  {
    title: 'Assists',
    rows: [
      ['B', 'preset: Balanced, Authentic, Forgiving'],
      ['1-6', 'individual assists'],
      ['0 / 9', 'all off / all on'],
      ['I', 'invert pitch'],
    ],
  },
]

/**
 * The first flight, in four sentences.
 *
 * Rewritten after QA flew it literally. The previous version described holding the
 * brakes until the engine wound up and then releasing — which cannot be done, because
 * the brakes stop holding at about 59% power and the aircraft accelerates away with
 * them fully applied (measured: 173 kt after twenty seconds, brakes on). It also
 * described a takeoff without mentioning that the opening position is airborne, and
 * said "pull" without saying which key pulls.
 */
const INTRO = `You are in an F-16 with a real aerodynamic model underneath it.
Press <b>T</b> to line up on a runway. Run the throttle to full with <b>X</b> and
give the engine a few seconds — it will start rolling on its own, and the brakes
will not hold it. At the <b>ROTATE</b> cue, pull back: that is <b>↓</b> or <b>S</b>.`

export class HelpCard {
  private readonly root: HTMLElement
  private open = true

  constructor(parent: HTMLElement = document.body) {
    this.root = document.createElement('div')
    this.root.style.cssText = [
      'position:fixed',
      'inset:0',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,.55)',
      'pointer-events:none',
      'z-index:10',
      'font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#cfe9d8',
    ].join(';')

    const panel = document.createElement('div')
    panel.style.cssText = [
      'max-width:min(880px,92vw)',
      'max-height:88vh',
      'overflow:auto',
      'padding:26px 30px',
      'border:1px solid rgba(93,255,155,.35)',
      'background:rgba(6,14,10,.92)',
      'box-shadow:0 0 60px rgba(0,0,0,.6)',
    ].join(';')

    const columns = GROUPS.map(
      (group) =>
        `<div><div style="color:#5dff9b;letter-spacing:.14em;margin-bottom:6px">` +
        `${group.title.toUpperCase()}</div>` +
        group.rows
          .map(
            ([key, what]) =>
              `<div style="display:flex;gap:10px">` +
              `<span style="color:#5dff9b;min-width:76px">${key}</span>` +
              `<span style="opacity:.8">${what}</span></div>`,
          )
          .join('') +
        `</div>`,
    ).join('')

    panel.innerHTML =
      `<div style="color:#5dff9b;font-size:19px;letter-spacing:.2em">RETRO FLYER</div>` +
      `<div style="opacity:.78;margin:10px 0 20px;max-width:60ch">${INTRO}</div>` +
      `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:22px">` +
      `${columns}</div>` +
      `<div style="opacity:.5;margin-top:22px">Press any key to fly. <b>/</b> brings this back.</div>`

    this.root.append(panel)
    parent.append(this.root)

    // Self-dismissing, because the alternative is a card that says "press any key"
    // and then requires the one specific key. `Slash` is excluded so that the toggle
    // in `main` owns it — otherwise opening and dismissing race on the same event.
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.code !== 'Slash') this.dismiss()
    })
    window.addEventListener('pointerdown', () => this.dismiss())
  }

  toggle(): void {
    this.open = !this.open
    this.root.style.display = this.open ? 'flex' : 'none'
  }

  /** Dismiss on the first real input, so nobody has to be told how to start. */
  dismiss(): void {
    if (!this.open) return
    this.open = false
    this.root.style.display = 'none'
  }

  get isOpen(): boolean {
    return this.open
  }
}
