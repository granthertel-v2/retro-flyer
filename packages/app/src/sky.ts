/**
 * Sun and clouds.
 *
 * Neither is in the requirements, and both earn their place for the same reason the
 * ground scatter does (§6): they give the eye something to measure against. An empty
 * gradient sky has no scale and no direction — you cannot tell a gentle climb from
 * level flight by looking at it. Clouds passing gives climb rate; a sun that stays
 * put while the world rotates around it gives attitude.
 *
 * Both are as crude as everything else that is not the flight model. The clouds are
 * flat-shaded blobs and the sun is a disc.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import { hash2 } from './terrain/source.js'

/** Direction to the sun, matching the scene's directional light. */
export const SUN_DIRECTION = new Vector3(-0.45, 0.78, -0.44).normalize()

/**
 * The sun: a disc plus a soft halo, held at a fixed distance from the camera.
 *
 * Kept out of the fog and out of the depth test so it always reads as being beyond
 * everything else — because it is, and because a sun that gets hazier as you climb
 * toward it looks wrong in a way that is hard to place.
 */
export function buildSun(): Object3D {
  const group = new Object3D()

  const disc = new Mesh(
    new SphereGeometry(1, 16, 12),
    new MeshBasicMaterial({ color: 0xfff6e2, fog: false, depthWrite: false }),
  )
  disc.scale.setScalar(340)

  const halo = new Mesh(
    new SphereGeometry(1, 16, 12),
    new MeshBasicMaterial({
      color: 0xffd9a0,
      fog: false,
      transparent: true,
      opacity: 0.22,
      blending: AdditiveBlending,
      side: BackSide,
      depthWrite: false,
    }),
  )
  halo.scale.setScalar(1_500)

  group.add(disc, halo)
  group.renderOrder = -20
  return group
}

/** Distance from the camera the sun is parked at, metres. */
const SUN_DISTANCE = 26_000

export function positionSun(sun: Object3D, cameraPosition: Vector3): void {
  sun.position.copy(SUN_DIRECTION).multiplyScalar(SUN_DISTANCE).add(cameraPosition)
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

/** Grid pitch, metres. */
const CLOUD_PITCH = 2_600
/** Cells each way. Seven gives a bit over 22 km of cloud in every direction. */
const CLOUD_REACH = 7
/** Blobs per cloud. Four overlapping lumps read as a cloud; one reads as a rock. */
const BLOBS = 4

const CLOUD_BASE_M = 2_450
const CLOUD_SPREAD_M = 2_100

const CLOUD_COUNT = (CLOUD_REACH * 2 + 1) ** 2 * BLOBS

/**
 * A deck of low-poly cumulus on a grid that follows the aircraft.
 *
 * Same trick as the ground scatter: the grid is rebuilt only when the aircraft
 * crosses a cell, and cell contents are a pure function of the cell index, so the
 * cloud you flew past is in the same place when you come back.
 */
export class Clouds {
  readonly mesh: InstancedMesh

  private cellX = Number.NaN
  private cellZ = Number.NaN

  private readonly matrix = new Matrix4()
  private readonly position = new Vector3()
  private readonly rotation = new Quaternion()
  private readonly scale = new Vector3()
  private readonly colour = new Color()

  constructor() {
    // Detail 1 is an 80-face icosahedron: still obviously faceted, but round enough
    // that a squashed one reads as cloud rather than as a boulder that has got
    // above itself.
    const geometry = new IcosahedronGeometry(1, 1)

    this.mesh = new InstancedMesh(
      geometry,
      // Heavy emissive. A cloud lit only from above goes dark underneath and
      // immediately looks like rock, because rock is the only thing the eye knows
      // that behaves that way. Real cloud scatters light through itself, and
      // faking that with a flat emissive floor costs one property.
      new MeshLambertMaterial({
        flatShading: true,
        emissive: new Color(0x8e9dad),
        emissiveIntensity: 1,
        transparent: true,
        opacity: 0.95,
      }),
      CLOUD_COUNT,
    )
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 5
  }

  update(x: number, z: number): void {
    const cx = Math.round(x / CLOUD_PITCH)
    const cz = Math.round(z / CLOUD_PITCH)
    if (cx === this.cellX && cz === this.cellZ) return

    this.cellX = cx
    this.cellZ = cz

    let i = 0

    for (let gz = cz - CLOUD_REACH; gz <= cz + CLOUD_REACH; gz++) {
      for (let gx = cx - CLOUD_REACH; gx <= cx + CLOUD_REACH; gx++) {
        const present = hash2(gx * 7, gz * 13)
        const height = CLOUD_BASE_M + hash2(gx + 5_501, gz - 3_307) * CLOUD_SPREAD_M
        const size = 170 + hash2(gx * 3, gz * 5) * 300

        for (let b = 0; b < BLOBS; b++) {
          // Roughly half the cells are empty sky. A full grid of clouds is a
          // ceiling, not weather.
          if (present > 0.55) {
            this.position.set(0, -20_000, 0)
            this.scale.setScalar(1)
            this.matrix.compose(this.position, this.rotation, this.scale)
            this.mesh.setMatrixAt(i, this.matrix)
            i++
            continue
          }

          const jx = (hash2(gx * 11 + b, gz * 17) - 0.5) * size * 1.7
          const jz = (hash2(gx * 19, gz * 23 + b) - 0.5) * size * 1.7
          const jy = (hash2(gx + b * 97, gz - b * 61) - 0.5) * size * 0.35
          const lump = 0.6 + hash2(gx * 29 + b, gz * 31) * 0.7

          this.position.set(
            gx * CLOUD_PITCH + jx,
            height + jy,
            gz * CLOUD_PITCH + jz,
          )
          // Wide and flat: cumulus are much broader than they are tall, and a
          // spherical cloud reads as a balloon.
          this.scale.set(size * lump, size * 0.5 * lump, size * lump)
          this.matrix.compose(this.position, this.rotation, this.scale)
          this.mesh.setMatrixAt(i, this.matrix)

          const shade = 0.9 + hash2(gx * 37 + b, gz * 41) * 0.12
          this.colour.setRGB(shade, shade, Math.min(1, shade * 1.02))
          this.mesh.setColorAt(i, this.colour)

          i++
        }
      }
    }

    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}
