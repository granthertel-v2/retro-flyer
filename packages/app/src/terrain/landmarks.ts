/**
 * Landmarks that stand on their own.
 *
 * Most named things in a region are already drawn — a stadium is a building, a
 * skyscraper is a building, a bridge is a bridge. A few are not: the Statue of
 * Liberty, a lighthouse on a reef, an obelisk in a park. Those exist in the world
 * only as a name on the map, which is a thin sort of landmark.
 *
 * ## What this is, and what it is not
 *
 * A tapered column of the right height, in the right place. **Not a model of
 * anything.** There is no Statue of Liberty here; there is a 47 m marker on Liberty
 * Island, which is the honest thing to draw when you know exactly where something is
 * and exactly how tall it is and nothing else about its shape.
 *
 * That restraint is the whole reason landmarks generalise to a second city. Modelling
 * the statue would be hand-work that does Chicago no good; a column driven by a
 * sourced height works in every region and gets Chicago its lighthouses for free.
 *
 * ## Where the heights come from, and what they mean
 *
 * Wikidata, property P2048, via the identifier OpenStreetMap already carries. It is
 * the *structure's* height and not always the height of the thing you would picture:
 * the Statue of Liberty comes back as 46.9 m, which is the statue, not the 93 m to
 * the torch that includes the pedestal it stands on. Drawing the sourced figure and
 * saying so is better than adding an unsourced forty metres to make it look right.
 */

import {
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three'
import type { TerrainSource } from './source.js'

/** Sunk into the ground, so a marker on uneven terrain is buried rather than floating. */
const SINK_M = 2

export function buildLandmarks(source: TerrainSource): Object3D {
  const group = new Object3D()
  const marked = (source.landmarks ?? []).filter((m) => (m.markerM ?? 0) > 0)
  if (marked.length === 0) return group

  // Tapered and six-sided: enough to read as a standing structure rather than a
  // building, and it costs eight triangles.
  const geometry = new CylinderGeometry(0.45, 1, 1, 6)
  geometry.translate(0, 0.5, 0)

  const mesh = new InstancedMesh(
    geometry,
    new MeshLambertMaterial({ color: 0xbdb49c, flatShading: true }),
    marked.length,
  )
  mesh.frustumCulled = false

  const matrix = new Matrix4()
  const position = new Vector3()
  const rotation = new Quaternion()
  const scale = new Vector3()

  marked.forEach((m, i) => {
    const height = m.markerM as number
    // Slim: a monument is tall for its width, and a column as wide as it is tall
    // reads as a silo. Floored so a short marker is still visible from the pattern.
    const radius = Math.max(2.5, height * 0.1)
    position.set(m.x, source.height(m.x, m.z) - SINK_M, m.z)
    scale.set(radius * 2, height + SINK_M, radius * 2)
    mesh.setMatrixAt(i, matrix.compose(position, rotation, scale))
  })

  mesh.instanceMatrix.needsUpdate = true
  group.add(mesh)
  return group
}
