/**
 * A moving map, in the corner.
 *
 * ## Why it exists
 *
 * The authored world is small and has three landmarks, and you learn it in a couple
 * of flights. A real region is 111 km across and looks like everywhere else in it:
 * you can be over Queens or over Nassau County and, at three thousand feet, they are
 * the same beige grid. Without a map you are not navigating, you are wandering, and
 * the airfields might as well not have names.
 *
 * ## Drawn once, then moved
 *
 * The terrain layer is rasterised a single time into an offscreen canvas by asking
 * `TerrainSource.sample` for a grid of points — a few tens of thousands of calls,
 * about as much work as one LOD ring rebuild, and it never has to happen again. Each
 * frame copies that bitmap and draws the moving parts over it. Re-sampling the
 * terrain per frame would cost more than the terrain mesh does.
 *
 * ## North-up, not track-up
 *
 * Track-up is easier to fly to and worse to learn from: the map turns when you do,
 * so nothing is ever where it was a moment ago and the shape of the region never
 * fixes in memory. North-up with a rotating aircraft symbol keeps the coastline
 * still, which is what makes "the bay is south-west of me" a thing you can know.
 *
 * ## What it draws, and what it leaves out
 *
 * Labels are ranked (`Place.rank`) and thinned by how much room there is, so a
 * postcard-sized map shows cities and the zoomed view shows neighbourhoods. Two
 * labels are never allowed to overlap: an unreadable pile of names is worse than
 * three names, and the pile is what you get if you draw all two hundred and fifty.
 *
 * No three.js here. It is a 2D canvas over the scene, which means it costs nothing
 * in the render loop and can be tested without a WebGL context.
 */

import { Surface, type Place, type TerrainSource } from './terrain/source.js'

/** Colours, matching `mesh.ts` closely enough that the map reads as the same world. */
const COLOURS: Record<number, string> = {
  [Surface.Water]: '#16324a',
  [Surface.Land]: '#4a5f36',
  [Surface.City]: '#6e6a64',
  [Surface.Runway]: '#2b2b30',
  [Surface.Forest]: '#22391e',
  [Surface.Grass]: '#5a7638',
  [Surface.Sand]: '#c0b184',
  [Surface.Suburb]: '#6a6650',
}

/**
 * Cells across the offscreen terrain bitmap.
 *
 * 768 over a 111 km region is 145 m a cell, near enough to the 120 m surface raster
 * that the closest zoom stops looking like mosaic. It could match the raster exactly
 * at 927, but the gain is a fifth of a cell and the cost is another 40% of the
 * sampling, all of it on the load path.
 */
const BITMAP = 768

/** Zoom steps, as the half-width of the visible square in metres. */
export const ZOOMS = [4_000, 12_000, 30_000, 60_000] as const

const SIZE = 260
const PADDING = 14

/**
 * The nearest named place, weighted by how much it matters.
 *
 * A free function so it can be tested without a canvas, and because it is the one
 * piece of judgement in this file: everything else is drawing.
 *
 * "Nearest" is not the useful answer on its own. Fly over New York and the closest
 * name is whichever hamlet you happen to be above; what you want to be told is
 * Newark, four miles further on. So distance is scaled by rank, which lets a city
 * win from further out without ever letting it beat a neighbourhood you are directly
 * over — a bias, not a filter, so the answer still changes as you move.
 */
export function nearestPlace(
  places: readonly Place[],
  x: number,
  z: number,
): { place: Place; distanceM: number } | null {
  let best: { place: Place; distanceM: number } | null = null
  let bestScore = Infinity

  for (const place of places) {
    const d = Math.hypot(place.x - x, place.z - z)
    const score = d * (1 + place.rank * 0.55)
    if (score < bestScore) {
      bestScore = score
      best = { place, distanceM: d }
    }
  }

  return best
}

export class Minimap {
  readonly canvas: HTMLCanvasElement

  private readonly context: CanvasRenderingContext2D
  private readonly terrain: HTMLCanvasElement
  private zoom = 2
  private visible = true

  constructor(private readonly source: TerrainSource) {
    this.canvas = document.createElement('canvas')
    const scale = Math.min(2, window.devicePixelRatio || 1)
    this.canvas.width = SIZE * scale
    this.canvas.height = SIZE * scale
    this.canvas.style.cssText =
      `position:fixed;right:${PADDING}px;bottom:${PADDING}px;` +
      `width:${SIZE}px;height:${SIZE}px;pointer-events:none;` +
      'border:1px solid rgba(120,200,140,0.45)'

    const context = this.canvas.getContext('2d')
    if (!context) throw new Error('minimap needs a 2D canvas context')
    this.context = context
    this.context.scale(scale, scale)

    this.terrain = this.rasterise()
  }

  /**
   * The whole region, once, into an offscreen bitmap.
   *
   * One sample per bitmap cell — no filtering. The surface raster it comes from is a
   * class, not a value, and averaging classes is meaningless: the mean of water and
   * city is not a coastline, it is nothing.
   */
  private rasterise(): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = BITMAP
    canvas.height = BITMAP
    const context = canvas.getContext('2d')
    if (!context) throw new Error('minimap needs a 2D canvas context')

    const image = context.createImageData(BITMAP, BITMAP)
    const extent = this.source.extent
    const step = (extent * 2) / BITMAP

    for (let j = 0; j < BITMAP; j++) {
      const z = -extent + (j + 0.5) * step
      for (let i = 0; i < BITMAP; i++) {
        const x = -extent + (i + 0.5) * step
        const colour = COLOURS[this.source.sample(x, z).surface] ?? '#4a5f36'
        const o = (j * BITMAP + i) * 4
        image.data[o] = parseInt(colour.slice(1, 3), 16)
        image.data[o + 1] = parseInt(colour.slice(3, 5), 16)
        image.data[o + 2] = parseInt(colour.slice(5, 7), 16)
        image.data[o + 3] = 255
      }
    }

    context.putImageData(image, 0, 0)
    return canvas
  }

  /**
   * Zoom in, then off, then back to the widest — all on one key.
   *
   * Four zooms and a hidden state on a single binding rather than a toggle plus two
   * zoom keys. The keyboard is nearly full, and a map that cannot be dismissed in
   * the same place it is zoomed is a map people leave in the wrong scale.
   */
  cycle(): void {
    if (!this.visible) {
      this.visible = true
      this.zoom = 0
    } else if (this.zoom + 1 < ZOOMS.length) {
      this.zoom += 1
    } else {
      this.visible = false
    }
    this.canvas.style.display = this.visible ? 'block' : 'none'
  }

  get shown(): boolean {
    return this.visible
  }

  /** Metres visible across half the map, at the current zoom. */
  get halfWidthM(): number {
    return ZOOMS[this.zoom]!
  }

  /** The nearest named place. See `nearestPlace` for what "nearest" means here. */
  nearestPlace(x: number, z: number): { place: Place; distanceM: number } | null {
    return nearestPlace(this.source.places ?? [], x, z)
  }

  draw(x: number, z: number, headingDeg: number): void {
    if (!this.visible) return

    const ctx = this.context
    const half = this.halfWidthM
    const extent = this.source.extent
    const scale = SIZE / (half * 2)

    // Painted opaque rather than left to a translucent CSS background. The region
    // bitmap does not fill the frame at the widest zoom, or anywhere near the map's
    // edge, and a see-through map lets the scene show through the gap — which reads
    // as trees growing inside the instrument.
    ctx.fillStyle = '#0a1410'
    ctx.fillRect(0, 0, SIZE, SIZE)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, SIZE, SIZE)
    ctx.clip()

    // World metres to map pixels, north up.
    const px = (wx: number): number => (wx - x) * scale + SIZE / 2
    const py = (wz: number): number => (wz - z) * scale + SIZE / 2

    // The terrain bitmap, scaled and offset. `drawImage` does the sampling, which
    // keeps the per-frame cost to one blit however far out the zoom goes.
    const bitmapScale = (extent * 2) * scale
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(this.terrain, px(-extent), py(-extent), bitmapScale, bitmapScale)

    // Runways, as short bars. At the closest zoom they are the thing being aimed at.
    ctx.strokeStyle = '#e8e4d8'
    ctx.lineWidth = 1.5
    for (const f of this.source.airfields) {
      const h = (f.headingDeg * Math.PI) / 180
      const dx = (Math.sin(h) * f.lengthM) / 2
      const dz = (-Math.cos(h) * f.lengthM) / 2
      ctx.beginPath()
      ctx.moveTo(px(f.x - dx), py(f.z - dz))
      ctx.lineTo(px(f.x + dx), py(f.z + dz))
      ctx.stroke()
    }

    this.drawLabels(ctx, px, py, half)

    // The aircraft, always at the centre, pointing where it is pointing.
    ctx.save()
    ctx.translate(SIZE / 2, SIZE / 2)
    ctx.rotate((headingDeg * Math.PI) / 180)
    ctx.fillStyle = '#f2b134'
    ctx.beginPath()
    ctx.moveTo(0, -8)
    ctx.lineTo(5.5, 7)
    ctx.lineTo(0, 4)
    ctx.lineTo(-5.5, 7)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    // The nearest named place, spelled out. The labels answer "what is around me";
    // this answers "where am I", which is the question actually being asked, and it
    // is legible at a glance in a way that hunting for the label under the aircraft
    // symbol is not.
    const near = this.nearestPlace(x, z)
    if (near) {
      ctx.fillStyle = 'rgba(4,10,8,0.8)'
      ctx.fillRect(0, 0, SIZE, 17)
      ctx.fillStyle = '#f2e6b8'
      ctx.font = '11px ui-monospace, monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(near.place.name.toUpperCase(), 6, 9)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#b9cbb4'
      ctx.fillText(`${(near.distanceM / 1852).toFixed(1)} nm`, SIZE - 6, 9)
    }

    // Scale bar, because a map without one is a picture.
    const barM = half >= 30_000 ? 20_000 : half >= 12_000 ? 10_000 : 2_000
    const barPx = barM * scale
    ctx.strokeStyle = 'rgba(220,240,225,0.85)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(10, SIZE - 12)
    ctx.lineTo(10 + barPx, SIZE - 12)
    ctx.stroke()
    ctx.fillStyle = 'rgba(220,240,225,0.85)'
    ctx.font = '10px ui-monospace, monospace'
    ctx.textAlign = 'left'
    ctx.fillText(`${(barM / 1852).toFixed(0)} nm`, 10, SIZE - 16)

    ctx.restore()
  }

  /**
   * Place names, thinned by rank and then by collision.
   *
   * Two passes, and the order matters: rank decides who is *eligible* at this zoom,
   * collision decides who actually fits. Doing it the other way round fills the map
   * with whichever neighbourhood happened to be drawn first and leaves no room for
   * the city it is in.
   */
  private drawLabels(
    ctx: CanvasRenderingContext2D,
    px: (x: number) => number,
    py: (z: number) => number,
    half: number,
  ): void {
    const places = this.source.places
    if (!places || places.length === 0) return

    // Zoomed out, only cities and towns; zoomed in, everything down to a
    // neighbourhood. Half-widths come from `ZOOMS`.
    const maxRank = half >= 40_000 ? 0 : half >= 20_000 ? 2 : half >= 8_000 ? 4 : 5

    ctx.font = '10px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const taken: { x: number; y: number; w: number }[] = []

    // Keep out of the caption strip at the top and the scale bar at the bottom.
    const TOP = 22
    const BOTTOM = SIZE - 24

    for (const place of places) {
      if (place.rank > maxRank) continue

      const cx = px(place.x)
      const cy = py(place.z) - 7
      const width = ctx.measureText(place.name).width

      // The whole label, not just its anchor. Testing the centre let "Perth Amboy"
      // and "Valley Stream" hang off the edge as "bridge Township" and "eville" —
      // a name cut in half is worse than no name, because it reads as a place.
      if (cx - width / 2 < 3 || cx + width / 2 > SIZE - 3) continue
      if (cy < TOP || cy > BOTTOM) continue

      const clash = taken.some(
        (t) => Math.abs(t.x - cx) < (t.w + width) / 2 + 4 && Math.abs(t.y - cy) < 11,
      )
      if (clash) continue
      taken.push({ x: cx, y: cy, w: width })

      // A dot at the place, the name above it. Drawing the name *on* the position
      // hides the thing it is naming, which matters once a runway is under it.
      ctx.fillStyle = 'rgba(240,233,200,0.9)'
      ctx.fillRect(px(place.x) - 1, py(place.z) - 1, 2, 2)

      ctx.fillStyle = 'rgba(4,10,8,0.75)'
      ctx.fillRect(cx - width / 2 - 2, cy - 6, width + 4, 12)
      ctx.fillStyle = place.rank <= 1 ? '#f0e9c8' : '#c6d8c2'
      ctx.fillText(place.name, cx, cy)
    }
  }
}
