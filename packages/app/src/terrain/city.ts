/**
 * Buildings and runways — the things standing on the terrain rather than part of it.
 *
 * Both exist for the same reason, which is §6 rather than §7: **near-field visual
 * reference**. Speed at altitude is invisible; the eye has nothing to measure it
 * against. A city at 500 ft is the single best speed cue in the map, and it costs one
 * draw call because every building is an instance of the same box.
 *
 * Runways get geometry of their own because the terrain mesh cannot draw them. The
 * innermost LOD ring has 60 m cells and a runway is 46 m wide — it falls between
 * samples and simply is not there. It has to be visible from the pattern, not just
 * present in `TerrainSource.sample()`.
 *
 * ## This file no longer knows what city it is drawing
 *
 * It used to import `CITY` and `inCity` from `authored.ts` and lay out a street grid
 * from them, which meant it could draw exactly one city: the authored one. That was a
 * hole straight through the §8.2 seam, and it only became visible when a real region
 * turned up with twenty-four thousand surveyed footprints and nowhere to put them.
 *
 * Now the source is asked. The authored map generates its grid, a region reads its
 * blob, and everything below is the same code either way.
 */

import {
  BoxGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three'
import { RUNWAY_SURFACE_OFFSET_M, hash2, type TerrainSource } from './source.js'

/**
 * How far a building's base is sunk into the ground, metres.
 *
 * Buildings are boxes standing on a heightfield sampled somewhere near their middle,
 * and real ground is not level under a 90 m footprint. Sinking the base a little
 * means a block on a slope is buried on the high side rather than hovering on the
 * low side, and a hovering building is far more obvious than a slightly short one.
 */
const BASE_SINK_M = 4

/**
 * Every building the source knows about, as a single instanced draw.
 *
 * Colour is derived here from position rather than carried in the data. A shade per
 * building would cost four bytes times twenty-four thousand in a region blob to say
 * something a hash says for nothing, and the hash is stable across loads.
 */
export function buildCity(source: TerrainSource): InstancedMesh {
  const buildings = source.buildings?.() ?? []

  // A unit box, anchored at its base so scaling grows it upward out of the ground
  // rather than sinking half of it. One geometry, scaled per instance — which is what
  // lets a hundred-metre tower and a two-storey block share a draw call.
  const geometry = new BoxGeometry(1, 1, 1)
  geometry.translate(0, 0.5, 0)

  const material = new MeshLambertMaterial({ flatShading: true })
  const mesh = new InstancedMesh(geometry, material, buildings.length)

  const matrix = new Matrix4()
  const position = new Vector3()
  const rotation = new Quaternion()
  const axis = new Vector3(0, 1, 0)
  const scale = new Vector3()
  const colour = new Color()

  buildings.forEach((b, i) => {
    // The same sign convention the runways use: a heading in degrees becomes a
    // rotation of minus that about Y. Getting it wrong turns Manhattan's grid
    // twenty-nine degrees the wrong way, which is subtle and completely wrong.
    rotation.setFromAxisAngle(axis, (-b.headingDeg * Math.PI) / 180)

    position.set(b.x, source.height(b.x, b.z) - BASE_SINK_M, b.z)
    scale.set(b.halfWidthM * 2, b.heightM + BASE_SINK_M, b.halfLengthM * 2)
    matrix.compose(position, rotation, scale)
    mesh.setMatrixAt(i, matrix)

    const shade = 0.78 + hash2(Math.round(b.x), Math.round(b.z)) * 0.44
    colour.setRGB(0.4 * shade, 0.39 * shade, 0.42 * shade)
    mesh.setColorAt(i, colour)
  })

  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  mesh.frustumCulled = false

  return mesh
}

/**
 * Runway strips, one flat quad each, laid just above the pad so they do not fight
 * the terrain mesh for depth.
 */
export function buildRunways(source: TerrainSource): Object3D {
  const group = new Object3D()

  const surface = new MeshLambertMaterial({
    color: 0x2a2a2e,
    flatShading: true,
    side: DoubleSide,
  })
  const stripe = new MeshLambertMaterial({ color: 0xd8d8d0, side: DoubleSide })

  for (const f of source.airfields) {
    const heading = (f.headingDeg * Math.PI) / 180

    const strip = new Mesh(new PlaneGeometry(f.widthM, f.lengthM), surface)
    strip.rotation.set(-Math.PI / 2, 0, -heading)
    // Lifted by RUNWAY_SURFACE_OFFSET_M, which `surfaceHeight` matches and ramps out
    // beyond the strip so the gear never meets it as a step.
    strip.position.set(f.x, f.elevation + RUNWAY_SURFACE_OFFSET_M, f.z)
    group.add(strip)

    // A centreline, in dashes. Cheap, and it is what makes a runway read as a
    // runway rather than as a dark rectangle.
    const dashes = Math.floor(f.lengthM / 90)
    for (let i = 0; i < dashes; i++) {
      const along = -f.lengthM / 2 + 45 + i * 90
      const dash = new Mesh(new PlaneGeometry(1.6, 40), stripe)
      dash.rotation.set(-Math.PI / 2, 0, -heading)
      dash.position.set(
        f.x + Math.sin(heading) * along,
        f.elevation + RUNWAY_SURFACE_OFFSET_M + 0.04,
        f.z - Math.cos(heading) * along,
      )
      group.add(dash)
    }
  }

  return group
}
