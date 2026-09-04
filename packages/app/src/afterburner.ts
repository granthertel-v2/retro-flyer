/**
 * The afterburner plume (REQUIREMENTS §6).
 *
 * The last cue in the acceleration chain and the only one that marks an *event*
 * rather than a quantity. Everything else added so far — FOV, camera stretch, the
 * sustain envelope — is continuous, and continuous cues are good at "how hard" and
 * poor at "now". Lighting the burner is the single most legible moment in a jet's
 * throttle response and it had no representation at all: the engine crossed into
 * afterburner and nothing on screen changed.
 *
 * ## Why 50 per cent, and why it is not a number chosen for looks
 *
 * The threshold is not decorative. `pdot` in the physics package encodes the real
 * afterburner hysteresis at the 50 per cent power line: crossing it upward targets
 * 60 before settling and crossing it downward drops to 40, both at a fast time
 * constant, while within a band the ordinary spool lag applies. So 50 is where the
 * modelled engine actually lights, and drawing the flame there means the picture and
 * the simulation agree about what the engine is doing rather than merely looking
 * plausible together.
 *
 * That also makes the plume genuinely informative. It appears at the moment thrust
 * begins climbing steeply — measured, thrust roughly doubles from 10,500 lb to
 * 20,400 in the second after the light — so the flame is visible confirmation
 * arriving at the front of the acceleration rather than a report on it afterwards.
 */

import {
  AdditiveBlending,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
} from 'three'

/** Power level, per cent, at which the burner lights. See the note above. */
export const BURNER_POWER = 50

/** Power at which the plume is at full length. */
const BURNER_FULL_POWER = 100

/**
 * Plume intensity for a power level, 0 to 1.
 *
 * Zero below the light, then a smooth ramp rather than a step. The engine crosses
 * 50 quickly but not instantly — `pdot` drives it toward 60 at a time constant of 5
 * — so a hard on/off would flicker every time the power level dithered across the
 * line at part throttle. Ramping means the plume grows out of the nozzle instead.
 */
export function burnerIntensity(power: number): number {
  if (power <= BURNER_POWER) return 0

  const t = Math.min(1, (power - BURNER_POWER) / (BURNER_FULL_POWER - BURNER_POWER))
  return t * t * (3 - 2 * t)
}

/**
 * Flicker multiplier at a given time, around 1.
 *
 * Two incommensurable frequencies rather than one, because a single sine reads as a
 * pulsing light bulb — the eye locks onto the period immediately. Summing two that
 * do not share a period gives something that never quite repeats, which is what
 * combustion looks like, at the cost of two more multiplications.
 */
export function burnerFlicker(seconds: number): number {
  return 1 + 0.06 * Math.sin(seconds * 37) + 0.04 * Math.sin(seconds * 61.7)
}

/** Nozzle position, metres aft of the model origin. Matches the exhaust face. */
const NOZZLE_Z = 7.4 * 0.85

/** Plume length at full afterburner, metres. */
const PLUME_LENGTH = 6.2
const PLUME_RADIUS = 0.46

export class Afterburner {
  readonly object: Object3D

  private readonly core: Mesh
  private readonly envelope: Mesh
  private readonly coreMaterial: MeshBasicMaterial
  private readonly envelopeMaterial: MeshBasicMaterial
  private seconds = 0

  constructor() {
    const group = new Group()

    // Two nested cones. One is a flat orange smear; the pale core inside it is what
    // makes it read as hot rather than as a traffic cone.
    this.envelopeMaterial = new MeshBasicMaterial({
      color: 0xff7a2a,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
    this.coreMaterial = new MeshBasicMaterial({
      color: 0xbfe4ff,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    })

    this.envelope = new Mesh(cone(PLUME_RADIUS, PLUME_LENGTH), this.envelopeMaterial)
    this.core = new Mesh(cone(PLUME_RADIUS * 0.52, PLUME_LENGTH * 0.55), this.coreMaterial)

    group.add(this.envelope, this.core)
    group.position.set(0, 0.04, NOZZLE_Z)
    group.visible = false

    this.object = group
  }

  /**
   * @param power   Engine power level, per cent — `RenderState.power`
   * @param dt      Frame time, seconds
   */
  update(power: number, dt: number): void {
    const intensity = burnerIntensity(power)

    if (intensity <= 0) {
      this.object.visible = false
      return
    }

    this.seconds += dt
    const flicker = burnerFlicker(this.seconds)

    this.object.visible = true
    // Length carries most of the reading; the plume grows aft rather than fattening.
    // Z, not Y: the geometry was laid down +Z, and scaling the axis it is no longer
    // built along stretches the plume sideways instead of aft.
    this.envelope.scale.set(1, 1, intensity * flicker)
    this.core.scale.set(1, 1, intensity * flicker)

    this.envelopeMaterial.opacity = 0.5 * intensity
    this.coreMaterial.opacity = 0.62 * intensity
  }
}

/**
 * A cone laid down +Z with its BASE at the origin, so scaling Z grows it aft out of
 * the nozzle rather than in both directions from its middle.
 *
 * Both halves of that matter and both were wrong first time. `ConeGeometry` builds
 * along +Y centred on the origin with the apex at +height/2, so translating by
 * +length/2 puts the base at the origin and the apex at +length; `rotateX(+PI/2)`
 * then maps +Y to +Z. Getting either sign backwards gives a plume that tapers to a
 * point AT the nozzle and flares out behind it, which is a party hat rather than a
 * flame.
 */
function cone(radius: number, length: number): ConeGeometry {
  const geometry = new ConeGeometry(radius, length, 10, 1, true)
  geometry.translate(0, length / 2, 0)
  geometry.rotateX(Math.PI / 2)

  return geometry
}
