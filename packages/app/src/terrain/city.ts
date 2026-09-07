/**
 * Buildings and runways — the things standing on the terrain rather than part of it.
 *
 * Both exist for the same reason, which is §6 rather than §7: **near-field visual
 * reference**. Speed at altitude over open ground is invisible; the eye has nothing
 * to measure it against. A city grid at 500 ft is the single best speed cue in the
 * map, and it costs one draw call because every block is an instance of the same
 * box.
 *
 * Runways get geometry of their own because the terrain mesh cannot draw them. The
 * innermost LOD ring has 60 m cells and a runway is 46 m wide — it falls between
 * samples and simply is not there. Day 3 has to land on these, so they need to be
 * visible from the pattern, not just present in `TerrainSource.sample()`.
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
import { CITY, inCity } from './authored.js'
import { RUNWAY_SURFACE_OFFSET_M, hash2, type TerrainSource } from './source.js'

/** Spacing of the street grid, metres. */
const BLOCK_PITCH = 130
/** Footprint of a block, metres. The remainder of the pitch is street. */
const BLOCK_SIZE = 92

/**
 * The city, as a single instanced draw.
 *
 * Blocks are taller toward the centre, which gives the skyline a shape and, more
 * usefully, gives the eye something that changes as you cross it.
 */
export function buildCity(source: TerrainSource): InstancedMesh {
  const placements: { x: number; z: number; base: number; height: number; shade: number }[] = []

  const reach = Math.max(CITY.halfLength, CITY.halfWidth) + BLOCK_PITCH

  for (let gz = -reach; gz <= reach; gz += BLOCK_PITCH) {
    for (let gx = -reach; gx <= reach; gx += BLOCK_PITCH) {
      // Lay the grid out in the city's own rotated frame so the streets line up
      // with the plateau rather than with the world axes.
      const c = Math.cos(CITY.headingRad)
      const s = Math.sin(CITY.headingRad)
      const x = CITY.x + gx * c - gz * s
      const z = CITY.z + gx * s + gz * c

      if (!inCity(x, z)) continue

      const r = hash2(Math.round(gx / BLOCK_PITCH), Math.round(gz / BLOCK_PITCH))
      // A few gaps. A perfectly full grid reads as a texture, not a city.
      if (r > 0.93) continue

      const fromCentre = Math.hypot(gx, gz) / reach
      const downtown = Math.max(0, 1 - fromCentre * 1.35)

      placements.push({
        x,
        z,
        base: source.height(x, z),
        height: 18 + r * 42 + downtown * downtown * 150,
        shade: 0.78 + hash2(Math.round(x), Math.round(z)) * 0.44,
      })
    }
  }

  const geometry = new BoxGeometry(BLOCK_SIZE, 1, BLOCK_SIZE)
  // Anchor the box at its base so scaling grows it upward out of the ground rather
  // than sinking half of it.
  geometry.translate(0, 0.5, 0)

  const material = new MeshLambertMaterial({ flatShading: true })
  const mesh = new InstancedMesh(geometry, material, placements.length)

  const matrix = new Matrix4()
  const position = new Vector3()
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -CITY.headingRad)
  const scale = new Vector3()
  const colour = new Color()

  placements.forEach((b, i) => {
    position.set(b.x, b.base - 4, b.z)
    scale.set(1, b.height, 1)
    matrix.compose(position, rotation, scale)
    mesh.setMatrixAt(i, matrix)

    colour.setRGB(0.40 * b.shade, 0.39 * b.shade, 0.42 * b.shade)
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
