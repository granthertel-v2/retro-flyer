/**
 * What the aircraft is rolling on — the physics side of the terrain seam.
 *
 * REQUIREMENTS §8.2 gives the renderer a terrain source it queries for height and
 * surface type. Day 3 gives the *physics* the same need and it must not be answered
 * the same way: the physics package has no rendering dependency by contract (§10),
 * runs headless in CI, and works in feet and NED where the renderer works in metres
 * and three.js world space.
 *
 * So this declares the contract in the physics package's own terms and the app
 * adapts its authored map across, in the same direction `seam.ts` already converts.
 * The alternative — importing the renderer's terrain here — would put three.js world
 * coordinates inside the flight model and make the whole package untestable in Node
 * to save one adapter.
 *
 * Everything in this file is `[A]`. REQUIREMENTS §3 labels ground reaction a design
 * choice, and surface friction coefficients are not part of the F-16 dataset.
 */

/** Ground elevation and what it is made of, at one point. */
export interface GroundSample {
  /** Elevation above sea level, ft. Negative under water. */
  elevation: number
  /**
   * Whether the surface bears weight.
   *
   * Water does not. A wheel over the sea finds no ground to push against, which is
   * the correct answer and also the only one this model can give — a ditching is
   * not in scope (§1).
   */
  solid: boolean
  /**
   * Rolling resistance coefficient — the drag of just rolling along.
   *
   * Dry pavement is famously low; this is the number that decides how far the
   * aircraft coasts with the engine at idle and no brakes.
   */
  rollingResistance: number
  /**
   * Peak friction coefficient available for braking and for resisting side slip.
   *
   * One number for both because a tyre has one friction circle, and splitting it
   * into separate longitudinal and lateral values would be inventing more detail
   * than anything here can justify.
   */
  friction: number
}

export interface GroundSource {
  /** Ground at a position in the model's own frame: north and east of origin, ft. */
  sample(pn: number, pe: number): GroundSample
}

/** Dry concrete or asphalt: a runway, a taxiway, a road. `[A]` */
export const PAVED = { solid: true, rollingResistance: 0.02, friction: 0.65 } as const

/**
 * Open ground: grass, dirt, scrub. `[A]`
 *
 * Rolling resistance four times paved and rather less friction available — enough
 * that leaving the runway is a mistake you can feel, which is the only thing this
 * distinction has to achieve.
 */
export const SOFT = { solid: true, rollingResistance: 0.08, friction: 0.45 } as const

/** Water. Nothing to roll on. `[A]` */
export const WATER = { solid: false, rollingResistance: 0, friction: 0 } as const

/**
 * Ground at a constant elevation, everywhere, made of one thing.
 *
 * The test stub. Every gear test wants a floor rather than a world, and building
 * one from the authored map would drag the renderer's terrain into the physics
 * suite for no gain.
 */
export class FlatGround implements GroundSource {
  constructor(
    private readonly elevation = 0,
    private readonly material: Omit<GroundSample, 'elevation'> = PAVED,
  ) {}

  sample(): GroundSample {
    return { elevation: this.elevation, ...this.material }
  }
}

/** No ground anywhere — the aircraft is over open sea. Used to test the airborne path. */
export class NoGround implements GroundSource {
  sample(): GroundSample {
    return { elevation: -1e9, ...WATER }
  }
}
