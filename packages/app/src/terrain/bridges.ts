/**
 * Bridges.
 *
 * The first thing anyone looks for flying into a real city, and the thing whose
 * absence is most obvious: a coastline with a city on both sides and nothing joining
 * them reads as a mistake, not as missing detail.
 *
 * ## What arrives, and what has to be invented
 *
 * The builder supplies a centreline and a width. It cannot supply a deck height,
 * because OpenStreetMap does not record one — `layer` says what crosses what, not how
 * far above the water anything is. So the height is constructed here, and the rule is
 * the honest one: **the deck is flat and level with its ends, except where it crosses
 * water, where it arches up to clear it.**
 *
 * Both halves matter. Taking the terrain under the whole span puts the roadway
 * underwater in the middle. Holding one height for the whole span leaves the
 * approaches floating hundreds of metres above the shore, which from the air is far
 * worse — a bridge that does not meet the ground at either end.
 *
 * ## Towers
 *
 * Every long crossing here is a suspension or cable-stayed bridge, and towers are
 * most of what makes one recognisable from above: the deck alone is a grey line on
 * grey water. They are placed at the ends of the water span rather than at fractions
 * of the total, because that is where a real tower stands — on the bank of the thing
 * being crossed — and it costs nothing to put them in the right place given the
 * builder already measured where the water is.
 *
 * Crude on purpose, like everything else outside the flight model: a box deck and two
 * box towers. At three hundred knots that is a bridge.
 */

import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three'
import { Surface, type Bridge, type TerrainSource } from './source.js'

/** Deck thickness, metres. */
const DECK_M = 3

/**
 * Clearance above the water at mid-span, metres. `[A]`
 *
 * Scaled by the length of the water crossing, capped at sixty. The Verrazzano gives
 * 69 m of clearance and the George Washington 65; a bascule over the Chicago River
 * gives about five. One number cannot serve both, and the span length is the only
 * signal available that separates them.
 */
const clearanceFor = (waterSpanM: number): number =>
  Math.min(60, Math.max(6, waterSpanM * 0.055))

/** A tower is worth drawing above this much open water. `[A]` */
const TOWER_SPAN_M = 250

export function buildBridges(source: TerrainSource): Object3D {
  const group = new Object3D()
  const bridges = source.bridges ?? []
  if (bridges.length === 0) return group

  const decks: Matrix4[] = []
  const towers: Matrix4[] = []

  const matrix = new Matrix4()
  const position = new Vector3()
  const rotation = new Quaternion()
  const scale = new Vector3()
  const up = new Vector3(0, 1, 0)

  for (const bridge of bridges) {
    const profile = deckProfile(source, bridge)

    for (let i = 0; i < profile.length - 1; i++) {
      const a = profile[i]!
      const b = profile[i + 1]!
      const dx = b.x - a.x
      const dz = b.z - a.z
      const run = Math.hypot(dx, dz)
      if (run < 0.5) continue

      // One box per segment, laid along it and tilted to meet the next. The deck is
      // a chain of short flat pieces rather than a curve, which is exactly the
      // faceted look the rest of the world is drawn in.
      const rise = b.y - a.y
      const length = Math.hypot(run, rise)

      position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
      rotation.setFromAxisAngle(up, Math.atan2(dx, -dz))
      const pitch = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.atan2(rise, run))
      rotation.multiply(pitch)
      scale.set(bridge.widthM, DECK_M, length)
      decks.push(matrix.compose(position, rotation, scale).clone())
    }

    for (const tower of towerSites(profile, bridge)) {
      position.set(tower.x, tower.base + tower.height / 2, tower.z)
      rotation.identity()
      scale.set(bridge.widthM * 0.45, tower.height, bridge.widthM * 0.45)
      towers.push(matrix.compose(position, rotation, scale).clone())
    }
  }

  group.add(instanced(decks, 0x8a8a90))
  if (towers.length > 0) group.add(instanced(towers, 0x9a9088))
  return group
}

function instanced(matrices: Matrix4[], colour: number): InstancedMesh {
  const geometry = new BoxGeometry(1, 1, 1)
  const mesh = new InstancedMesh(
    geometry,
    new MeshLambertMaterial({ color: colour, flatShading: true }),
    Math.max(1, matrices.length),
  )
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
  mesh.count = matrices.length
  mesh.instanceMatrix.needsUpdate = true
  mesh.frustumCulled = false
  return mesh
}

interface DeckPoint {
  x: number
  z: number
  y: number
  wet: boolean
}

/**
 * The height of the deck along the span.
 *
 * Land points sit just above the ground. Water points rise to a clearance, eased in
 * from the banks so the roadway leaves the shore on a ramp rather than a step.
 */
function deckProfile(source: TerrainSource, bridge: Bridge): DeckPoint[] {
  // Resample evenly: the builder's points are spaced by geometry, and an arch drawn
  // on uneven spacing kinks wherever the spacing changes.
  const spacing = 20
  const steps = Math.max(2, Math.round(bridge.lengthM / spacing))
  const raw: DeckPoint[] = []

  for (let k = 0; k <= steps; k++) {
    const t = (k / steps) * (bridge.points.length - 1)
    const i = Math.min(bridge.points.length - 2, Math.floor(t))
    const f = t - i
    const a = bridge.points[i]!
    const b = bridge.points[i + 1]!
    const x = a.x + (b.x - a.x) * f
    const z = a.z + (b.z - a.z) * f
    const sample = source.sample(x, z)
    raw.push({ x, z, y: sample.height, wet: sample.surface === Surface.Water })
  }

  // How far each point is from the nearest dry land, in steps. That distance is what
  // the arch is built on — it peaks in the middle of the water and falls to nothing
  // at both banks, with no need to know where "the middle" is.
  const toLand = raw.map(() => Infinity)
  let run = Infinity
  for (let i = 0; i < raw.length; i++) {
    run = raw[i]!.wet ? run + 1 : 0
    toLand[i] = run
  }
  run = Infinity
  for (let i = raw.length - 1; i >= 0; i--) {
    run = raw[i]!.wet ? run + 1 : 0
    toLand[i] = Math.min(toLand[i]!, run)
  }

  const widest = Math.max(0, ...toLand.filter((d) => Number.isFinite(d)))
  const waterSpan = widest * 2 * (bridge.lengthM / steps)
  const clearance = clearanceFor(waterSpan)

  // Water level under the span, from the span itself rather than assumed to be zero:
  // Chicago's river is 176 m above the sea, and a bridge built to clear sea level
  // there would be buried.
  const wetHeights = raw.filter((p) => p.wet).map((p) => p.y)
  const water = wetHeights.length > 0 ? Math.max(...wetHeights) : 0

  // A straight line between the two ends. Not the higher of them: the George
  // Washington Bridge leaves the Palisades at 84 m and reaches Manhattan at 33, and
  // holding the whole deck at 84 left it floating fifty metres above the far
  // abutment and arching to a hundred and forty over the river. It read as a ski
  // jump, which is the correct reaction to a road that never comes down.
  const west = raw[0]!.y
  const east = raw[raw.length - 1]!.y

  return raw.map((p, i) => {
    const along = i / Math.max(1, raw.length - 1)
    const ground = west + (east - west) * along

    const d = toLand[i]!
    const t = widest > 0 && Number.isFinite(d) ? Math.min(1, d / widest) : 0
    const eased = t * t * (3 - 2 * t)

    // On land the deck follows the ground it is leaving; over water it rises to a
    // clearance above the water. Blended by how far from a bank the point is, so
    // both ends touch down and the middle is high.
    const overWater = water + clearance
    return { ...p, y: ground + (overWater - ground) * eased + DECK_M }
  })
}

function towerSites(
  profile: DeckPoint[],
  bridge: Bridge,
): { x: number; z: number; base: number; height: number }[] {
  const wet = profile.map((p) => p.wet)
  const first = wet.indexOf(true)
  const last = wet.lastIndexOf(true)
  if (first < 0 || last <= first) return []

  const spanM = ((last - first) / Math.max(1, profile.length - 1)) * bridge.lengthM
  if (spanM < TOWER_SPAN_M) return []

  // On the banks of the water, which is where the real ones stand.
  return [profile[first]!, profile[last]!].map((p) => ({
    x: p.x,
    z: p.z,
    base: p.y - 6,
    height: Math.min(90, Math.max(24, spanM * 0.11)),
  }))
}
