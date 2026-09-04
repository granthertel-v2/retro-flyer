/**
 * The aeroplane, as about forty triangles.
 *
 * Flat-shaded, untextured, built from boxes and tapered prisms — crude on purpose,
 * like everything that is not the flight model. It exists mostly to be seen from
 * behind, so the planform and the tail silhouette are what get the polygons and
 * nothing else does.
 *
 * Authored to three.js convention: nose down -Z, up +Y, right wing +X. That is what
 * lets `seam.ts` hand it the attitude quaternion with no extra rotation — see the
 * note there about the frame mapping.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  Shape,
  ShapeGeometry,
} from 'three'

/** Build a closed shape from an explicit triangle list. Non-indexed, flat shaded. */
function solid(vertices: readonly number[], color: number): Mesh {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3))
  geometry.computeVertexNormals()

  return new Mesh(geometry, new MeshLambertMaterial({ color, flatShading: true }))
}

/**
 * Build a flat polygon from an outline, triangulated properly.
 *
 * "Properly" is doing work here. The first version fanned the outline from its
 * first vertex, which is correct only for a convex polygon — and the wing planform
 * is not convex, because the leading-edge root extension puts a notch in it. Fanning
 * it produced overlapping triangles that from directly astern read as a wing roughly
 * twice the size of the real one. `Shape` triangulates through earcut and handles
 * the notch.
 *
 * Both faces are drawn: these are zero-thickness plates, and a wing that vanishes
 * when seen from below is worse than the cost of not culling.
 */
function polygon(outline: readonly [number, number][], color: number): BufferGeometry {
  const shape = new Shape()
  const first = outline[0] as [number, number]
  shape.moveTo(first[0], first[1])
  for (let i = 1; i < outline.length; i++) {
    const p = outline[i] as [number, number]
    shape.lineTo(p[0], p[1])
  }
  shape.closePath()

  void color
  return new ShapeGeometry(shape)
}

function plateMaterial(color: number): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true, side: DoubleSide })
}

/** A horizontal surface: the outline is given in (x, z) and laid flat at height `y`. */
function plate(outline: readonly [number, number][], y: number, color: number): Mesh {
  const geometry = polygon(outline, color)
  // ShapeGeometry builds in the XY plane; this lays it into XZ.
  geometry.rotateX(Math.PI / 2)
  geometry.translate(0, y, 0)

  return new Mesh(geometry, plateMaterial(color))
}

/** A vertical surface: the outline is given in (z, y) and stood up at `x`. */
function fin(outline: readonly [number, number][], x: number, color: number): Mesh {
  const geometry = polygon(outline, color)
  geometry.rotateY(-Math.PI / 2)
  geometry.translate(x, 0, 0)

  return new Mesh(geometry, plateMaterial(color))
}

const AIRFRAME = 0x9aa2ab
const DARK = 0x4a5058
const CANOPY = 0x2c3d4f

/**
 * @param scale Metres per unit. The F-16 is about 15 m long; the geometry below is
 *   authored in metres directly, so this is 1 unless something wants a toy.
 */
export function buildAircraft(scale = 1): Object3D {
  const group = new Group()

  // Fuselage: a tapered box, nose at -Z.
  const l = 7.4
  const w = 0.72
  const h = 0.82
  const noseZ = -l
  const tailZ = l * 0.85

  const body = solid(
    [
      // Nose cone to forward body, four faces.
      0, 0, noseZ, -w, h * 0.4, -l * 0.45, w, h * 0.4, -l * 0.45,
      0, 0, noseZ, w, h * 0.4, -l * 0.45, w, -h * 0.5, -l * 0.45,
      0, 0, noseZ, w, -h * 0.5, -l * 0.45, -w, -h * 0.5, -l * 0.45,
      0, 0, noseZ, -w, -h * 0.5, -l * 0.45, -w, h * 0.4, -l * 0.45,

      // Mid body, a box.
      -w, h * 0.4, -l * 0.45, w, h * 0.4, -l * 0.45, w, h * 0.4, tailZ,
      -w, h * 0.4, -l * 0.45, w, h * 0.4, tailZ, -w, h * 0.4, tailZ,
      -w, -h * 0.5, -l * 0.45, w, -h * 0.5, tailZ, w, -h * 0.5, -l * 0.45,
      -w, -h * 0.5, -l * 0.45, -w, -h * 0.5, tailZ, w, -h * 0.5, tailZ,
      w, h * 0.4, -l * 0.45, w, -h * 0.5, -l * 0.45, w, -h * 0.5, tailZ,
      w, h * 0.4, -l * 0.45, w, -h * 0.5, tailZ, w, h * 0.4, tailZ,
      -w, h * 0.4, -l * 0.45, -w, -h * 0.5, tailZ, -w, -h * 0.5, -l * 0.45,
      -w, h * 0.4, -l * 0.45, -w, h * 0.4, tailZ, -w, -h * 0.5, tailZ,

      // Exhaust.
      -w * 0.7, h * 0.25, tailZ, w * 0.7, h * 0.25, tailZ, w * 0.7, -h * 0.35, tailZ,
      -w * 0.7, h * 0.25, tailZ, w * 0.7, -h * 0.35, tailZ, -w * 0.7, -h * 0.35, tailZ,
    ],
    AIRFRAME,
  )
  group.add(body)

  // Wing: cropped delta with a leading-edge root extension, in plan.
  group.add(
    plate(
      [
        [0.5, -3.4], [1.4, 0.2], [4.6, 2.4], [4.6, 3.2], [0.6, 3.4],
        [-0.6, 3.4], [-4.6, 3.2], [-4.6, 2.4], [-1.4, 0.2], [-0.5, -3.4],
      ],
      -0.18,
      AIRFRAME,
    ),
  )

  // Stabilators.
  group.add(plate([[0.6, 4.6], [2.9, 5.8], [2.9, 6.4], [0.6, 6.2]], -0.1, DARK))
  group.add(plate([[-0.6, 4.6], [-2.9, 5.8], [-2.9, 6.4], [-0.6, 6.2]], -0.1, DARK))

  // Fin, and two ventral strakes.
  group.add(fin([[2.2, 0.4], [4.4, 2.9], [5.9, 2.9], [5.9, 0.4]], 0, AIRFRAME))
  group.add(fin([[4.6, -0.5], [6.2, -1.4], [6.4, -0.5]], 0.55, DARK))
  group.add(fin([[4.6, -0.5], [6.2, -1.4], [6.4, -0.5]], -0.55, DARK))

  // Canopy.
  group.add(
    solid(
      [
        0, h * 0.4, -3.9, -0.5, h * 0.95, -2.9, 0.5, h * 0.95, -2.9,
        -0.5, h * 0.95, -2.9, 0.5, h * 0.95, -2.9, 0.5, h * 0.95, -1.2,
        -0.5, h * 0.95, -2.9, 0.5, h * 0.95, -1.2, -0.5, h * 0.95, -1.2,
        -0.5, h * 0.95, -1.2, 0.5, h * 0.95, -1.2, 0, h * 0.4, -0.4,
        0, h * 0.4, -3.9, 0.5, h * 0.95, -2.9, 0.5, h * 0.95, -1.2,
        0, h * 0.4, -3.9, 0.5, h * 0.95, -1.2, 0, h * 0.4, -0.4,
        0, h * 0.4, -3.9, -0.5, h * 0.95, -1.2, -0.5, h * 0.95, -2.9,
        0, h * 0.4, -3.9, 0, h * 0.4, -0.4, -0.5, h * 0.95, -1.2,
      ],
      CANOPY,
    ),
  )

  group.scale.setScalar(scale)
  return group
}
