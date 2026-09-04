/**
 * Control surface travel (REQUIREMENTS §2.1.1).
 *
 * Sourced values, from NASA/TM-2003-212145 p.29. These are the physical limits of
 * the surfaces and are not tuning knobs — unlike everything else in this package.
 * They live here rather than in the physics package because the physics model takes
 * whatever deflection it is handed; enforcing the limit is the control layer's job.
 */

export const ELEVATOR_LIMIT_DEG = 25
export const AILERON_LIMIT_DEG = 21.5
export const RUDDER_LIMIT_DEG = 30
