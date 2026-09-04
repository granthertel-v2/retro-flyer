/**
 * Atmosphere.
 *
 * There are two atmospheres in here, and the distinction matters enough to be the
 * first thing you read.
 *
 * `airData()` is the one the flight model uses. It is the simplified atmosphere the
 * reference implementation carries ([AEROBENCH] adc.py, itself from Stevens & Lewis
 * pp. 63-65). The aerodynamic tables and every published trim solution are
 * referenced to *this* atmosphere. Swapping in a more accurate one would shift every
 * result and break the Tier A golden vectors. It is not an approximation to be
 * improved; it is part of the model's definition.
 *
 * `isa()` is proper ISA, per REQUIREMENTS §2.3, for everything that is not the
 * flight model: HUD readouts, display altitude, anything a human reads. It is
 * accurate to 60,000 ft.
 *
 * The two agree closely at low altitude and diverge in the stratosphere — see
 * `atmosphere.test.ts`, which pins the difference rather than leaving it implicit.
 */

/** Sea-level density, slug/ft^3. [AEROBENCH] adc.py */
const RHO_SL = 2.377e-3
/** Ratio of specific heats for air. */
const GAMMA = 1.4
/** Specific gas constant for air, ft-lb/(slug-degR). */
const R_AIR = 1716.3

export interface AirData {
  /** Mach number. */
  mach: number
  /** Dynamic pressure, lb/ft^2. */
  qbar: number
  /** Density, slug/ft^3. */
  rho: number
  /** Temperature, degrees Rankine. */
  temperature: number
  /** Speed of sound, ft/s. */
  speedOfSound: number
}

/**
 * The flight model's atmosphere. Port of [AEROBENCH] adc.py, kept literal.
 *
 * Note the discontinuity at 35,000 ft: temperature is held at a flat 390 R in the
 * stratosphere while density keeps following the troposphere power law. That is a
 * kink, and it is in the source. Keeping it means speed of sound (and therefore
 * Mach) has a small step at 35,000 ft. Smoothing it would be a change to the model,
 * so it stays, and `isaVsModel` in the tests quantifies what it costs.
 *
 * @param vt   True airspeed, ft/s
 * @param alt  Altitude, ft
 */
export function airData(vt: number, alt: number): AirData {
  const tfac = 1 - 0.703e-5 * alt

  // 3 degrees Rankine per 1000 ft in the troposphere; isothermal above.
  const temperature = alt >= 35000 ? 390 : 519 * tfac

  const rho = RHO_SL * Math.pow(tfac, 4.14)
  const speedOfSound = Math.sqrt(GAMMA * R_AIR * temperature)

  return {
    mach: vt / speedOfSound,
    qbar: 0.5 * rho * vt * vt,
    rho,
    temperature,
    speedOfSound,
  }
}

export interface IsaConditions {
  /** Temperature, degrees Rankine. */
  temperature: number
  /** Pressure, lb/ft^2. */
  pressure: number
  /** Density, slug/ft^3. */
  density: number
  /** Speed of sound, ft/s. */
  speedOfSound: number
}

/** ISA sea-level temperature, degrees Rankine (288.15 K). */
const ISA_T0_R = 518.67
/** ISA sea-level pressure, lb/ft^2 (101325 Pa). */
const ISA_P0_PSF = 2116.22
/** ISA tropospheric lapse rate, degrees Rankine per ft (6.5 K/km). */
const ISA_LAPSE_R_PER_FT = 0.00356616
/** Geopotential altitude of the tropopause, ft. */
const TROPOPAUSE_FT = 36089.24
/** ISA temperature in the lower stratosphere, degrees Rankine (216.65 K). */
const ISA_T_TROPOPAUSE_R = 389.97
/** Scale height exponent term for the isothermal layer, per ft. */
const STRATOSPHERE_DECAY_PER_FT = 4.80637e-5

/**
 * International Standard Atmosphere, sea level to 60,000 ft (REQUIREMENTS §2.3).
 *
 * Two layers, which is all that is needed below 65,617 ft: a linear-lapse
 * troposphere and an isothermal lower stratosphere.
 *
 * This is the display atmosphere. The flight model does not call it. Above
 * 60,000 ft the values are extrapolation and `isaValid` returns false.
 */
export function isa(alt: number): IsaConditions {
  let temperature: number
  let pressure: number

  if (alt < TROPOPAUSE_FT) {
    temperature = ISA_T0_R - ISA_LAPSE_R_PER_FT * alt
    // p/p0 = (T/T0)^(g/(L*R))
    pressure = ISA_P0_PSF * Math.pow(temperature / ISA_T0_R, 5.255876)
  } else {
    temperature = ISA_T_TROPOPAUSE_R
    const pTropopause =
      ISA_P0_PSF * Math.pow(ISA_T_TROPOPAUSE_R / ISA_T0_R, 5.255876)
    pressure =
      pTropopause * Math.exp(-STRATOSPHERE_DECAY_PER_FT * (alt - TROPOPAUSE_FT))
  }

  const density = pressure / (R_AIR * temperature)
  const speedOfSound = Math.sqrt(GAMMA * R_AIR * temperature)

  return { temperature, pressure, density, speedOfSound }
}

/** Whether `isa()` is inside its stated validity range (REQUIREMENTS §2.3). */
export const isaValid = (alt: number): boolean => alt >= 0 && alt <= 60000
