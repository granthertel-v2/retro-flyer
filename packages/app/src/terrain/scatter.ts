/**
 * Near-field ground detail (§6).
 *
 * The highest-leverage item in the whole speed-sensation list, and the least
 * obvious. At 500 knots and 30,000 ft nothing appears to move, because there is
 * nothing close enough to move against. At 500 knots and 500 ft over an empty
 * hillside the situation is exactly the same — the hillside is smooth, and smooth
 * terrain at any speed reads as a photograph. What creates the sensation of speed is
 * objects passing *close by*, and there is no substitute for them.
 *
 * So: a few hundred small solids, on a grid that follows the aircraft, existing only
 * within about a mile and a half. From altitude you never see them. Down low they
 * are the whole effect.
 *
 * They are rebuilt when the aircraft crosses a grid cell rather than every frame,
 * and the grid is coarse enough that this is a few hundred terrain samples a couple
 * of times a second.
 */

import {
  Color,
  ConeGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { Surface, hash2, smoothstep, type TerrainSource } from './source.js'

/**
 * Grid pitch, metres.
 *
 * This is §6's "ground detail density and near-field visual reference so
 * low-altitude speed reads", and the number that matters is how often something
 * passes you. At 250 m/s a 155 m grid put one object alongside every 0.62 seconds,
 * which is not a stream, it is a series of events. 95 m makes it 0.38 — dense enough
 * that the near field reads as continuous motion rather than as individual objects
 * being counted.
 */
export const PITCH = 95

/** Cells each way from the aircraft. 26 gives a radius of about 2.5 km. */
export const REACH = 26

/**
 * Cells over which an object grows to full size at the edge of the field, and the
 * reason the field is round rather than square.
 *
 * Without this, objects switch on at full size 2.5 km away, in clear air — fog does
 * not start until twenty kilometres, so there is nothing to hide it. Over the flat
 * ground of a real region that edge is a visible line of things appearing, and it
 * follows you, which is worse than the pop itself.
 *
 * Scaling them up over the outer few cells costs nothing — the instances are already
 * being written every time the grid moves — and it also rounds the field off, which
 * matters because the square's corners reach 1.4 times further than its sides and
 * were the most conspicuous part of the edge.
 */
const FADE_CELLS = 7

const COUNT = (REACH * 2 + 1) ** 2

export class Scatter {
  readonly mesh: InstancedMesh

  private cellX = Number.NaN
  private cellZ = Number.NaN

  private readonly matrix = new Matrix4()
  private readonly position = new Vector3()
  private readonly rotation = new Quaternion()
  private readonly scale = new Vector3()
  private readonly colour = new Color()

  constructor(private readonly source: TerrainSource) {
    // A four-sided cone: a tree, a rock, a mast, whatever the eye decides. Three
    // triangles of silhouette is all that is needed for something seen for a fifth
    // of a second at 250 m/s.
    const geometry = new ConeGeometry(1, 1, 4, 1)
    geometry.translate(0, 0.5, 0)

    this.mesh = new InstancedMesh(
      geometry,
      new MeshLambertMaterial({ flatShading: true }),
      COUNT,
    )
    this.mesh.frustumCulled = false
  }

  update(x: number, z: number): void {
    const cx = Math.round(x / PITCH)
    const cz = Math.round(z / PITCH)
    if (cx === this.cellX && cz === this.cellZ) return

    this.cellX = cx
    this.cellZ = cz

    let i = 0

    for (let gz = cz - REACH; gz <= cz + REACH; gz++) {
      for (let gx = cx - REACH; gx <= cx + REACH; gx++) {
        const jitterX = (hash2(gx, gz) - 0.5) * PITCH * 0.8
        const jitterZ = (hash2(gx + 9_311, gz - 4_177) - 0.5) * PITCH * 0.8

        const wx = gx * PITCH + jitterX
        const wz = gz * PITCH + jitterZ
        const sample = this.source.sample(wx, wz)

        const roll = hash2(gx * 31, gz * 17)

        // Distance from the aircraft in cells, and the size it implies. Measured on
        // the grid rather than in metres so it does not change as the jitter moves
        // an object about within its cell.
        const cells = Math.hypot(gx - cx, gz - cz)
        const grown = smoothstep(REACH, REACH - FADE_CELLS, cells)

        // Nothing grows on water, sand or a runway, the city has its own blocks, and
        // nothing at all is drawn beyond the fade — see `FADE_CELLS`.
        const bare =
          sample.surface === Surface.Water ||
          sample.surface === Surface.Runway ||
          sample.surface === Surface.City ||
          sample.surface === Surface.Sand ||
          roll > 0.72

        if (bare || grown <= 0) {
          // Park the unused instances underground rather than shrinking them to
          // zero — a degenerate matrix still costs a vertex shader invocation and
          // can produce NaN normals.
          this.position.set(0, -10_000, 0)
          this.scale.setScalar(1)
          this.matrix.compose(this.position, this.rotation, this.scale)
          this.mesh.setMatrixAt(i, this.matrix)
          i++
          continue
        }

        const alpine = sample.height > 1_150
        const height = alpine ? 5 + roll * 9 : 8 + roll * 17
        const radius = height * (0.22 + roll * 0.14)

        this.position.set(wx, sample.height - 1, wz)
        this.scale.set(radius * grown, height * grown, radius * grown)
        this.matrix.compose(this.position, this.rotation, this.scale)
        this.mesh.setMatrixAt(i, this.matrix)

        const shade = 0.72 + roll * 0.5
        if (alpine) this.colour.setRGB(0.26 * shade, 0.27 * shade, 0.24 * shade)
        else this.colour.setRGB(0.15 * shade, 0.30 * shade, 0.14 * shade)
        this.mesh.setColorAt(i, this.colour)

        i++
      }
    }

    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}
