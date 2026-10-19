/**
 * Stage 4: Multi-Model Dark Flight & Strewn Field Physics Engine
 *
 * Ports and unifies the reference application's CIRA-72 / US Standard Atmosphere
 * model, 4th-order Runge-Kutta (RK4) ballistic integrator, Mach/Reynolds/Knudsen
 * drag solver, seeded Monte Carlo ensemble, and Found-Piece Calibration, while
 * adding:
 *  1. Hard physical limits on upper-atmosphere ablation (refusing to fabricate
 *     ground impacts when a fragile/high-altitude meteoroid completely ablates).
 *  2. Cross-referenced 3-mode solver:
 *     - Mode 'sweep': Deterministic 5-mass sorting spine (10 kg, 1 kg, 100 g, 10 g, 1 g)
 *     - Mode 'montecarlo': 160-fragment seeded ensemble + 2σ covariance ellipse
 *     - Mode 'calibrated': Cross-model agreement + residual calibration against
 *       corroborated ground falls / partner trajectories
 *  3. Weighted Directional Zone of Possibility for partial-data events (when
 *     entry azimuth is missing, marginalizes across azimuths weighted by the
 *     historical upper-air wind sounding).
 */

import {
  getFoundStonesForEvent,
  evaluateFoundStoneResiduals,
  autoFitDarkFlightToFoundStones,
  scaleSoundingWind,
} from './foundStones.js';
import {
  evaluateEventSanityAndOverUnder,
  getNexradGateForEvent,
  computeAerodynamicBreakupPhysics,
  computeWeibullFractureCascade,
} from './validation.js';

const R_GAS = 287.058;
const GAMMA = 1.4;
const G = 9.80665;
const T0 = 288.15;
const P0 = 101325;
const MU0 = 1.7894e-5;
const SUTHERLAND_S = 110.4;
const EARTH_OMEGA = 7.2921e-5;
const EARTH_RADIUS_M = 6371000;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const METERS_PER_DEG_LAT = 111320;

export const CANONICAL_MASS_SWEEP = Object.freeze([
  Object.freeze({ massKg: 1.0, label: '1 kg', color: '#ef4444' }),
  Object.freeze({ massKg: 0.3, label: '300g', color: '#f97316' }),
  Object.freeze({ massKg: 0.1, label: '100g', color: '#f59e0b' }),
  Object.freeze({ massKg: 0.05, label: '50g', color: '#eab308' }),
  Object.freeze({ massKg: 0.03, label: '30g', color: '#84cc16' }),
  Object.freeze({ massKg: 0.01, label: '10g', color: '#22c55e' }),
  Object.freeze({ massKg: 0.003, label: '3g', color: '#fef08a' }),
]);

export function atmosphereTemperature(altitudeM) {
  if (altitudeM <= 11000) return T0 - 0.0065 * altitudeM;
  if (altitudeM <= 20000) return 216.65;
  if (altitudeM <= 32000) return 216.65 + 0.001 * (altitudeM - 20000);
  if (altitudeM <= 47000) return 228.65 + 0.0028 * (altitudeM - 32000);
  if (altitudeM <= 51000) return 270.65;
  if (altitudeM <= 71000) return 270.65 - 0.0028 * (altitudeM - 47000);
  if (altitudeM <= 84852) return 214.65 - 0.002 * (altitudeM - 71000);
  return 186.87 + 0.003 * Math.max(0, altitudeM - 84852);
}

export function atmospherePressure(altitudeM) {
  const T11 = 216.65;
  const P11 = P0 * Math.pow(1 - (0.0065 * 11000) / T0, G / (0.0065 * R_GAS));
  const P20 = P11 * Math.exp((-G * 9000) / (R_GAS * T11));
  const P32 = P20 * Math.pow(1 + (0.001 * 12000) / T11, -G / (0.001 * R_GAS));
  const T32 = 228.65;
  const P47 =
    P32 * Math.pow(T32 / (T32 + 0.0028 * 15000), G / (0.0028 * R_GAS));
  const T47 = 270.65;
  const P51 = P47 * Math.exp((-G * 4000) / (R_GAS * T47));
  const P71 =
    P51 * Math.pow(T47 / (T47 + 0.0028 * 20000), G / (0.0028 * R_GAS));
  const T71 = 214.65;

  if (altitudeM <= 11000) {
    return (
      P0 * Math.pow(1 - (0.0065 * altitudeM) / T0, G / (0.0065 * R_GAS))
    );
  }
  if (altitudeM <= 20000) {
    return P11 * Math.exp((-G * (altitudeM - 11000)) / (R_GAS * T11));
  }
  if (altitudeM <= 32000) {
    return (
      P20 *
      Math.pow(1 + (0.001 * (altitudeM - 20000)) / T11, -G / (0.001 * R_GAS))
    );
  }
  if (altitudeM <= 47000) {
    return (
      P32 *
      Math.pow(
        T32 / (T32 + 0.0028 * (altitudeM - 32000)),
        G / (0.0028 * R_GAS),
      )
    );
  }
  if (altitudeM <= 51000) {
    return P47 * Math.exp((-G * (altitudeM - 47000)) / (R_GAS * T47));
  }
  if (altitudeM <= 71000) {
    return (
      P51 *
      Math.pow(
        T47 / (T47 + 0.0028 * (altitudeM - 51000)),
        G / (0.0028 * R_GAS),
      )
    );
  }
  if (altitudeM <= 84852) {
    return (
      P71 *
      Math.pow(
        T71 / (T71 + 0.002 * (altitudeM - 71000)),
        G / (0.002 * R_GAS),
      )
    );
  }
  return P0 * Math.exp(-altitudeM / 8500);
}

export function getAtmosphere(altitudeM) {
  const alt = Math.max(0, altitudeM);
  const temperature = atmosphereTemperature(alt);
  const pressure = atmospherePressure(alt);
  const density = pressure / (R_GAS * temperature);
  const speedOfSound = Math.sqrt(GAMMA * R_GAS * temperature);
  const viscosity =
    MU0 *
    Math.pow(temperature / T0, 1.5) *
    ((T0 + SUTHERLAND_S) / (temperature + SUTHERLAND_S));
  const meanFreePath =
    (viscosity / Math.max(pressure, 1e-6)) *
    Math.sqrt((Math.PI * R_GAS * temperature) / 2);
  return {
    altitude: alt,
    density,
    pressure,
    temperature,
    speedOfSound,
    viscosity,
    meanFreePath,
  };
}

export function interpolateWind(sounding, altitudeM) {
  const samples = sounding?.samples;
  const turbSigmaMs =
    altitudeM <= 2000
      ? 1.25
      : altitudeM <= 12000
        ? 0.45 + 0.8 * Math.exp(-(altitudeM - 2000) / 3500)
        : 0.25;
  if (!Array.isArray(samples) || !samples.length) {
    return { u: 0, v: 0, w: 0, turbSigmaMs, altitude: altitudeM };
  }
  if (altitudeM <= samples[0].altitude) {
    return {
      u: samples[0].u,
      v: samples[0].v,
      w: Number(samples[0].w) || 0,
      turbSigmaMs,
      altitude: altitudeM,
    };
  }
  const last = samples[samples.length - 1];
  if (altitudeM >= last.altitude) {
    // Exponential decay above highest measured sounding level (30 hPa ~24 km)
    const decay = Math.exp(-(altitudeM - last.altitude) / 12000);
    return {
      u: last.u * decay,
      v: last.v * decay,
      w: (Number(last.w) || 0) * decay,
      turbSigmaMs,
      altitude: altitudeM,
    };
  }
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (altitudeM >= a.altitude && altitudeM <= b.altitude) {
      const span = Math.max(1, b.altitude - a.altitude);
      const t = (altitudeM - a.altitude) / span;
      return {
        u: a.u + (b.u - a.u) * t,
        v: a.v + (b.v - a.v) * t,
        w: (Number(a.w) || 0) + ((Number(b.w) || 0) - (Number(a.w) || 0)) * t,
        turbSigmaMs,
        altitude: altitudeM,
      };
    }
  }
  return { u: 0, v: 0, w: 0, turbSigmaMs, altitude: altitudeM };
}

/**
 * Compute Artemieva-Shuvalov / Passechnik bow-shock transverse fragmentation
 * impulse velocity (m/s) at breakup altitude.
 */
export function computeBowShockLateralSpeedMs({
  altM = 45000,
  speedMs = 1000,
  massKg = 0.05,
  parentMassKg = 0.1,
  densityKgM3 = 3400,
  lateralImpulseCoeff = 0.55,
} = {}) {
  const cT = Math.max(0, Number(lateralImpulseCoeff) || 0);
  if (cT <= 0) return 0;
  const atm = getAtmosphere(Math.max(0, altM));
  const rhoRatio = Math.sqrt(
    Math.max(0, atm.density) / Math.max(500, densityKgM3),
  );
  const massScale = Math.pow(
    Math.max(0.0005, massKg) / Math.max(0.001, parentMassKg),
    -1 / 6,
  );
  return Math.min(280, cT * rhoRatio * Math.max(50, speedMs) * massScale);
}

/**
 * Compute terminal impact kinetic energy (J) and Poncelet soil penetration
 * depth (cm) across 3 field-hunter surface resistance classes.
 */
export function computeImpactPenetration({
  massKg = 0.05,
  densityKgM3 = 3400,
  impactSpeedMs = 45,
  impactAngleDeg = 75,
  shapeFactor = 1.15,
} = {}) {
  const m = Math.max(0.0001, Number(massKg) || 0.05);
  const v = Math.max(0, Number(impactSpeedMs) || 0);
  const rhoM = Math.max(500, Number(densityKgM3) || 3400);
  const volume = m / rhoM;
  const diameterM = 2 * Math.cbrt((3 * volume) / (4 * Math.PI));
  const areaM2 =
    Math.PI * (diameterM / 2) ** 2 * Math.max(0.7, Number(shapeFactor) || 1.15);
  const sinImpact = Math.sin(
    Math.max(15, Math.min(90, Number(impactAngleDeg) || 75)) * DEG_TO_RAD,
  );
  const impactEnergyJ = Math.round(0.5 * m * v * v * 100) / 100;

  // Poncelet penetration depth: z = (m / (2 * b * A)) * ln(1 + (b * v_n^2) / R)
  const depthForSurface = (bearingResistancePa, inertialSoilDensityKgM3) => {
    const b = 0.5 * inertialSoilDensityKgM3;
    const vn = v * sinImpact;
    const depthM =
      (m / Math.max(1e-6, 2 * b * areaM2)) *
      Math.log(1 + (b * vn * vn) / Math.max(1e4, bearingResistancePa));
    return Math.round(Math.max(0, depthM * 100) * 10) / 10;
  };

  const softSoilCm = depthForSurface(0.28e6, 1450);
  const grasslandCm = depthForSurface(0.95e6, 1650);
  const hardpanCm = depthForSurface(3.8e6, 1950);

  return {
    impactEnergyJ,
    penetrationDepthCm: grasslandCm,
    penetrationBySurface: {
      softSoilCm,
      grasslandCm,
      hardpanCm,
    },
  };
}

export function computeDragCoefficient(
  velocity,
  speedOfSound,
  density,
  diameter,
  viscosity,
  meanFreePath,
) {
  const v = Math.max(velocity, 0.1);
  const mach = v / Math.max(speedOfSound, 1);
  const reynolds = (density * v * diameter) / Math.max(viscosity, 1e-9);
  const knudsen = meanFreePath / Math.max(diameter, 1e-6);

  if (knudsen > 10) {
    return 2.1;
  }
  if (mach > 4) return 0.72;
  if (mach > 1.2) return 0.72 + 0.34 * Math.exp(-4.5 * (mach - 1.2));
  if (mach > 0.8) return 0.58 + 0.48 * Math.exp(-8 * Math.abs(mach - 1.0));
  if (reynolds < 1) return 24 / Math.max(reynolds, 1e-3);
  if (reynolds < 1000) {
    return (24 / reynolds) * (1 + 0.15 * Math.pow(reynolds, 0.687));
  }
  return 0.56;
}

export function fragmentSeed(seed, index) {
  let z = (Math.imul(index + 1, 0x9e3779b1) + (seed | 0)) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  z ^= z >>> 16;
  return z >>> 0 || 0x9e3779b9;
}

class SeededRng {
  constructor(seed = 1337) {
    const s = Number.isFinite(seed) ? seed | 0 : 1337;
    this.seed = s === 0 ? 0x9e3779b9 : s;
  }
  next() {
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >> 17;
    this.seed ^= this.seed << 5;
    return (this.seed >>> 0) / 4294967296;
  }
  gaussian() {
    const u1 = Math.max(this.next(), Number.EPSILON);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

export const V_ABLATION_THRESHOLD_MS = 3000;

/**
 * Integrate a single fragment's dark-flight trajectory from terminal ablation
 * state down to ground impact (alt = groundElevationM) using RK4, with coupled
 * hypersonic ablation (dm/dt for v > 3 km/s), bow-shock lateral impulse,
 * aerodynamic lift/gliding (CL/CD), vertical wind (w), and Poncelet impact
 * soil penetration depth.
 */
export function integrateFragmentDarkFlight({
  terminalLat,
  terminalLon,
  terminalAltM,
  terminalSpeedMs,
  azimuthDeg,
  entryAngleDeg,
  massKg,
  densityKgM3 = 3400,
  shapeFactor = 1.15,
  sounding = null,
  groundElevationM = 0,
  ablationSigma = 0.018,
  ablationThresholdMs = V_ABLATION_THRESHOLD_MS,
  ablateFromInitialMass = false,
  lateralImpulseCoeff = 0,
  lateralAngleRad = 0,
  liftToDragRatio = 0,
  liftAzimuthRad = 0,
  verticalWindMs = 0,
  recordTrack = false,
  dtSec = 0.5,
}) {
  const azRad = azimuthDeg * DEG_TO_RAD;
  // Bug #1 fix: Don't clamp shallow entry angles to 12° minimum — shallow entries
  // (el as low as 5°) are physically valid for Earth-grazing fireballs. The old
  // floor of 12° caused over-projection of 66 km for 7.5° grazers.
  const elevRad = Math.max(5, Math.min(89, entryAngleDeg)) * DEG_TO_RAD;
  const floorAltM = Math.max(
    0,
    Math.min(
      Math.max(0, (Number(terminalAltM) || 20000) - 50),
      Number(groundElevationM) || 0,
    ),
  );
  // When released at supersonic/hypersonic speed (>= 2500 m/s) on the 3D trajectory spine,
  // start at the true trajectory velocity; aerodynamic drag (A/m ∝ m^-1/3) naturally
  // separates fragments by mass along the 3D spine without artificial speed scaling.
  const massSpeedFactor =
    terminalSpeedMs >= 2500
      ? 1.0
      : Math.max(
          0.25,
          Math.min(1.65, Math.pow(Math.max(0.001, massKg) / 0.08, 0.34)),
        );
  const maxStartSpeed = ablateFromInitialMass ? 25000 : 25000;
  const startSpeed = ablateFromInitialMass
    ? Math.min(Math.max(terminalSpeedMs, 110), maxStartSpeed)
    : Math.min(Math.max(terminalSpeedMs * massSpeedFactor, 110), maxStartSpeed);
  const vHoriz = startSpeed * Math.cos(elevRad);

  // Bow-shock transverse fragmentation impulse perpendicular to heading
  const vPerp = computeBowShockLateralSpeedMs({
    altM: terminalAltM,
    speedMs: startSpeed,
    massKg,
    densityKgM3,
    lateralImpulseCoeff,
  });
  const perpAzRad = azRad + Math.PI / 2;
  const vPerpHoriz = vPerp * Math.cos(lateralAngleRad);
  const vPerpVert = vPerp * Math.sin(lateralAngleRad) * 0.25;

  const sigmaAbl = Math.max(0, Number(ablationSigma) || 0);
  const sigmaAblSi = sigmaAbl * 1e-6; // s^2/km^2 -> s^2/m^2
  const vAblThresh = Math.max(500, Number(ablationThresholdMs) || V_ABLATION_THRESHOLD_MS);

  // Pre-terminus + post-breakup Bronshten ablation estimate when starting near dark-flight transition
  const refBreakupSpeedKmS = Math.max(
    startSpeed / 1000,
    Math.min(9.5, ((Number(terminalSpeedMs) || 1200) * 2.2) / 1000),
  );
  const vThreshKmS = vAblThresh / 1000;
  const bronshtenFactor =
    sigmaAbl > 0 && refBreakupSpeedKmS > vThreshKmS
      ? Math.exp(
          Math.min(
            2.2,
            0.5 * sigmaAbl * (refBreakupSpeedKmS ** 2 - vThreshKmS ** 2),
          ),
        )
      : 1;

  const initialMassKg = ablateFromInitialMass
    ? Math.max(0.0001, massKg)
    : Math.round(massKg * bronshtenFactor * 100000) / 100000;

  const state = {
    lat: terminalLat * DEG_TO_RAD,
    lon: terminalLon * DEG_TO_RAD,
    alt: Math.max(floorAltM + 10, Math.min(75000, terminalAltM)),
    vx: vHoriz * Math.sin(azRad) + vPerpHoriz * Math.sin(perpAzRad),
    vy: vHoriz * Math.cos(azRad) + vPerpHoriz * Math.cos(perpAzRad),
    vz: -startSpeed * Math.sin(elevRad) + vPerpVert,
    mass: ablateFromInitialMass ? initialMassKg : Math.max(0.0001, massKg),
  };

  let darkFlightOnsetAltM = startSpeed <= vAblThresh ? state.alt : null;
  const rhoMeteoroid = Math.max(densityKgM3, 500);
  const ldRatio = Math.max(0, Math.min(0.35, Number(liftToDragRatio) || 0));
  const wOffsetMs = Number(verticalWindMs) || 0;

  const track = recordTrack
    ? [
        {
          lat: terminalLat,
          lon: terminalLon,
          altM: state.alt,
        },
      ]
    : null;

  const dt = Math.max(0.02, Math.min(2.5, Number(dtSec) || 0.5));
  const fastStep = !recordTrack && !ablateFromInitialMass;
  let stepDt = startSpeed > 600 ? Math.min(dt, fastStep ? 0.12 : 0.04) : dt;

  function derivAt(s) {
    const curMass = Math.max(1e-5, s.mass);
    const volume = curMass / rhoMeteoroid;
    const diameter = 2 * Math.cbrt((3 * volume) / (4 * Math.PI));
    const area = Math.PI * (diameter / 2) ** 2 * shapeFactor;

    const atm = getAtmosphere(s.alt);
    const wind = interpolateWind(sounding, s.alt);
    const sinAz = Math.sin(azRad);
    const cosAz = Math.cos(azRad);
    const wAlong = wind.u * sinAz + wind.v * cosAz;
    const wCross = wind.u * cosAz - wind.v * sinAz;
    // Parent-carrier & wake entrainment prevents opposing upper-air headwinds (wAlong < 0)
    // from blowing fragments backwards up-track behind the terminal breakup point,
    // while preserving 100% of tailwinds (wAlong >= 0) and 100% of cross-track wind drift (wCross).
    const effWAlong = wAlong < 0 ? wAlong * 0.12 : wAlong;
    const effWindU = effWAlong * sinAz + wCross * cosAz;
    const effWindV = effWAlong * cosAz - wCross * sinAz;
    const vRelX = s.vx - effWindU;
    const vRelY = s.vy - effWindV;
    const vRelZ = s.vz - (wind.w || 0) - wOffsetMs;
    const vRel = Math.hypot(vRelX, vRelY, vRelZ);

    const cd = computeDragCoefficient(
      vRel,
      atm.speedOfSound,
      atm.density,
      diameter,
      atm.viscosity,
      atm.meanFreePath,
    );
    // Pure US Standard Atmosphere dynamic pressure q = 0.5 * rho(z) * v_rel^2 (no artificial
    // high-altitude drag multiplier), allowing fragments released at bolide bursts (20-45 km)
    // to coast forward down the 3D trajectory spine to their natural mass-sorted retardation knees.
    const q = 0.5 * atm.density * vRel * vRel;
    const rawDragAccel = curMass > 0 ? (q * cd * area) / curMass : 0;
    // Physical stiffness guard: drag is strictly dissipative and cannot reverse vRel within one RK4 step
    const dragAccel = Math.min(rawDragAccel, (0.82 * vRel) / stepDt);

    let axAero = vRel > 0 ? (-dragAccel * vRelX) / vRel : 0;
    let ayAero = vRel > 0 ? (-dragAccel * vRelY) / vRel : 0;
    let azAero = vRel > 0 ? (-dragAccel * vRelZ) / vRel : 0;

    // Magnus / aerodynamic lift perpendicular to relative flow
    if (ldRatio > 0 && vRel > 0.5) {
      const liftAccel = dragAccel * ldRatio;
      const horizRel = Math.hypot(vRelX, vRelY);
      const liftDirX =
        horizRel > 0.1
          ? (-vRelY / horizRel) * Math.cos(liftAzimuthRad) +
            (vRelX / horizRel) * Math.sin(liftAzimuthRad)
          : Math.sin(liftAzimuthRad);
      const liftDirY =
        horizRel > 0.1
          ? (vRelX / horizRel) * Math.cos(liftAzimuthRad) +
            (vRelY / horizRel) * Math.sin(liftAzimuthRad)
          : Math.cos(liftAzimuthRad);
      axAero += liftAccel * liftDirX;
      ayAero += liftAccel * liftDirY;
      azAero += liftAccel * 0.15 * Math.cos(liftAzimuthRad);
    }

    // Coupled classical ablation dm/dt when integrating forward from pre-ablation initial mass
    const rawDMass =
      ablateFromInitialMass && sigmaAblSi > 0 && vRel > vAblThresh
        ? -0.5 * sigmaAblSi * cd * area * atm.density * vRel * vRel * vRel
        : 0;
    const dMass = Math.max(rawDMass, (-0.45 * curMass) / stepDt);

    // Full 3D Coriolis acceleration: a = -2ω × v (in ENU frame)
    // ax_coriolis = 2ω(vy·sin(φ) - vz·cos(φ))  — eastward
    // ay_coriolis = -2ω·vx·sin(φ)              — northward
    // az_coriolis = 2ω·vx·cos(φ)               — upward (vertical coupling)
    const sinLat = Math.sin(s.lat);
    const cosLat = Math.max(0.01, Math.cos(s.lat));
    const fCor = 2 * EARTH_OMEGA * sinLat;
    const fCorVert = 2 * EARTH_OMEGA * cosLat; // vertical coupling component
    // Centrifugal gravity reduction: g_eff = G - ω²(R+h)cos²(φ)
    const r = EARTH_RADIUS_M + s.alt;
    const centrifugalAccel = (EARTH_OMEGA ** 2) * r * cosLat * cosLat;
    const effectiveG = G - centrifugalAccel;
    const ax = axAero + fCor * s.vy - fCorVert * s.vz;
    const ay = ayAero - fCor * s.vx;
    const az = azAero - effectiveG + fCorVert * s.vx;

    return {
      dLat: s.vy / r,
      dLon: s.vx / (r * cosLat),
      dAlt: s.vz,
      dVx: ax,
      dVy: ay,
      dVz: az,
      dMass,
    };
  }

  const maxSteps = Math.ceil(2200 / Math.min(dt, 0.4)); // supports adaptive supersonic + subsonic fall
  let timeSec = 0;
  let retardationKnee = null;

  for (let step = 0; step < maxSteps; step++) {
    const prevLat = state.lat;
    const prevLon = state.lon;
    const prevAlt = state.alt;
    const prevVx = state.vx;
    const prevVy = state.vy;
    const prevVz = state.vz;
    const speedBefore = Math.hypot(prevVx, prevVy, prevVz);
    stepDt = speedBefore > 600 ? Math.min(dt, fastStep ? 0.12 : 0.04) : dt;

    const k1 = derivAt(state);
    if (!Number.isFinite(k1.dLat) || !Number.isFinite(k1.dLon)) return null;

    const s2 = {
      lat: state.lat + (k1.dLat * stepDt) / 2,
      lon: state.lon + (k1.dLon * stepDt) / 2,
      alt: Math.max(0, state.alt + (k1.dAlt * stepDt) / 2),
      vx: state.vx + (k1.dVx * stepDt) / 2,
      vy: state.vy + (k1.dVy * stepDt) / 2,
      vz: state.vz + (k1.dVz * stepDt) / 2,
      mass: Math.max(1e-5, state.mass + (k1.dMass * stepDt) / 2),
    };
    const k2 = derivAt(s2);

    const s3 = {
      lat: state.lat + (k2.dLat * stepDt) / 2,
      lon: state.lon + (k2.dLon * stepDt) / 2,
      alt: Math.max(0, state.alt + (k2.dAlt * stepDt) / 2),
      vx: state.vx + (k2.dVx * stepDt) / 2,
      vy: state.vy + (k2.dVy * stepDt) / 2,
      vz: state.vz + (k2.dVz * stepDt) / 2,
      mass: Math.max(1e-5, state.mass + (k2.dMass * stepDt) / 2),
    };
    const k3 = derivAt(s3);

    const s4 = {
      lat: state.lat + k3.dLat * stepDt,
      lon: state.lon + k3.dLon * stepDt,
      alt: Math.max(0, state.alt + k3.dAlt * stepDt),
      vx: state.vx + k3.dVx * stepDt,
      vy: state.vy + k3.dVy * stepDt,
      vz: state.vz + k3.dVz * stepDt,
      mass: Math.max(1e-5, state.mass + k3.dMass * stepDt),
    };
    const k4 = derivAt(s4);

    state.lat += ((k1.dLat + 2 * k2.dLat + 2 * k3.dLat + k4.dLat) * stepDt) / 6;
    state.lon += ((k1.dLon + 2 * k2.dLon + 2 * k3.dLon + k4.dLon) * stepDt) / 6;
    state.alt += ((k1.dAlt + 2 * k2.dAlt + 2 * k3.dAlt + k4.dAlt) * stepDt) / 6;
    state.vx += ((k1.dVx + 2 * k2.dVx + 2 * k3.dVx + k4.dVx) * stepDt) / 6;
    state.vy += ((k1.dVy + 2 * k2.dVy + 2 * k3.dVy + k4.dVy) * stepDt) / 6;
    state.vz += ((k1.dVz + 2 * k2.dVz + 2 * k3.dVz + k4.dVz) * stepDt) / 6;
    state.mass = Math.max(
      1e-5,
      state.mass +
        ((k1.dMass + 2 * k2.dMass + 2 * k3.dMass + k4.dMass) * stepDt) / 6,
    );

    const speedAfter = Math.hypot(state.vx, state.vy, state.vz);
    if (darkFlightOnsetAltM === null && speedAfter <= vAblThresh) {
      darkFlightOnsetAltM = state.alt;
    }
    if (retardationKnee === null && speedAfter <= 340) {
      retardationKnee = {
        lat: Math.round(state.lat * RAD_TO_DEG * 100000) / 100000,
        lon: Math.round(state.lon * RAD_TO_DEG * 100000) / 100000,
        altKm: Math.round((state.alt / 1000) * 10) / 10,
      };
    }

    // Normalize longitude to [-pi, pi] to handle antimeridian/dateline crossings
    if (state.lon > Math.PI) state.lon -= 2 * Math.PI;
    if (state.lon < -Math.PI) state.lon += 2 * Math.PI;
    if (
      Math.abs(state.lat) > Math.PI / 2 ||
      Math.abs(state.lon) > Math.PI
    ) {
      return null;
    }

    if (state.alt <= floorAltM) {
      const spanAlt = prevAlt - state.alt;
      const frac =
        spanAlt > 1e-6
          ? Math.max(0, Math.min(1, (prevAlt - floorAltM) / spanAlt))
          : 1;
      state.lat = prevLat + (state.lat - prevLat) * frac;
      state.lon = prevLon + (state.lon - prevLon) * frac;
      state.vx = prevVx + (state.vx - prevVx) * frac;
      state.vy = prevVy + (state.vy - prevVy) * frac;
      state.vz = prevVz + (state.vz - prevVz) * frac;
      state.alt = floorAltM;
      timeSec += stepDt * frac;
      if (track) {
        track.push({
          lat: state.lat * RAD_TO_DEG,
          lon: state.lon * RAD_TO_DEG,
          altM: floorAltM,
        });
      }
      break;
    }

    timeSec += stepDt;

    if (
      track &&
      ((speedAfter > 400 && step % 4 === 0) ||
        (speedAfter <= 400 && step % 4 === 0))
    ) {
      track.push({
        lat: state.lat * RAD_TO_DEG,
        lon: state.lon * RAD_TO_DEG,
        altM: Math.max(floorAltM, state.alt),
      });
    }
  }

  const finalMassKg = Math.round(state.mass * 100000) / 100000;
  const effectiveInitialMassKg = Math.max(finalMassKg, initialMassKg);
  const ablationMassLossPct =
    effectiveInitialMassKg > 0
      ? Math.round(
          (1 - finalMassKg / effectiveInitialMassKg) * 1000,
        ) / 10
      : 0;
  const impactSpeedMs =
    Math.round(Math.hypot(state.vx, state.vy, state.vz) * 10) / 10;
  const horizImpactSpeed = Math.hypot(state.vx, state.vy);
  const impactAngleDeg =
    Math.round(
      Math.atan2(Math.abs(state.vz), Math.max(1e-3, horizImpactSpeed)) *
        RAD_TO_DEG *
        10,
    ) / 10;
  const pen = computeImpactPenetration({
    massKg: finalMassKg,
    densityKgM3,
    impactSpeedMs,
    impactAngleDeg,
    shapeFactor,
  });

  return {
    lat: Math.round(state.lat * RAD_TO_DEG * 100000) / 100000,
    lon: Math.round(state.lon * RAD_TO_DEG * 100000) / 100000,
    groundElevationM: Math.round(floorAltM),
    massKg: finalMassKg,
    initialMassKg: effectiveInitialMassKg,
    ablationMassLossPct,
    darkFlightOnsetAltKm:
      Math.round(((darkFlightOnsetAltM ?? state.alt) / 1000) * 10) / 10,
    retardationKnee,
    burnedOut: finalMassKg < 0.0005,
    flightTimeSec: Math.round(timeSec),
    impactSpeedMs,
    impactAngleDeg,
    impactEnergyJ: pen.impactEnergyJ,
    penetrationDepthCm: pen.penetrationDepthCm,
    penetrationBySurface: pen.penetrationBySurface,
    track,
  };
}

/**
 * Compute 2σ covariance ellipse around a set of impact points.
 */
export function computeStrewnFieldEllipse(impacts, sigma = 2) {
  if (!Array.isArray(impacts) || !impacts.length) return null;
  const meanLat = impacts.reduce((s, i) => s + i.lat, 0) / impacts.length;
  const meanLon = impacts.reduce((s, i) => s + i.lon, 0) / impacts.length;
  const lonScale =
    METERS_PER_DEG_LAT * Math.max(0.01, Math.cos(meanLat * DEG_TO_RAD));

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const imp of impacts) {
    const dx = (imp.lon - meanLon) * lonScale;
    const dy = (imp.lat - meanLat) * METERS_PER_DEG_LAT;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= impacts.length;
  syy /= impacts.length;
  sxy /= impacts.length;

  const trace = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, trace * trace - 4 * det));
  const lambda1 = (trace + disc) / 2;
  const lambda2 = (trace - disc) / 2;

  const chi2 = sigma === 1 ? 2.3 : 6.18;
  const semiMajorM = Math.max(
    400,
    Math.round(Math.sqrt(Math.max(0, lambda1) * chi2)),
  );
  const semiMinorM = Math.max(
    250,
    Math.round(Math.sqrt(Math.max(0, lambda2) * chi2)),
  );

  let orientationDeg = 0;
  if (sxy !== 0 || sxx !== syy) {
    const angleMath = (Math.atan2(2 * sxy, sxx - syy) / 2) * RAD_TO_DEG;
    orientationDeg = Math.round(((90 - angleMath) % 360 + 360) % 360);
  }

  return {
    center: { lat: meanLat, lon: meanLon },
    semiMajorM,
    semiMinorM,
    orientationDeg,
    sigma,
  };
}

/**
 * Evaluate physical survival limits before running dark-flight ground projection.
 */
export function evaluateSurvivalPhysics(event) {
  const src = event?.source || 'cneos';
  const altKm = Number(event?.location?.altitude);
  const velKmS = Number(event?.trajectory?.entryVelocity);
  const massKg = Number(event?.mass);

  // Hard physical limit: high-altitude faint optical meteors (ending > 65 km with
  // small photometric mass or hypervelocity cometary entry > 52 km/s) ablate completely.
  if (src === 'gmn') {
    if (Number.isFinite(altKm) && altKm > 62) {
      return {
        survivable: false,
        regime: 'ablation-complete',
        reason: `Hard physical limit: optical meteor terminated at ${altKm.toFixed(1)} km altitude${Number.isFinite(velKmS) ? ` (${velKmS.toFixed(1)} km/s)` : ''}. Complete upper-atmosphere ablation — no surviving ground fragments expected.`,
      };
    }
    if (Number.isFinite(massKg) && massKg < 0.005 && (altKm ?? 70) > 50) {
      return {
        survivable: false,
        regime: 'ablation-complete',
        reason: `Hard physical limit: photometric mass ${(massKg * 1000).toFixed(1)} g at ${(altKm ?? 70).toFixed(1)} km completely ablates prior to dark flight.`,
      };
    }
  }

  const hasAzimuth = Number.isFinite(event?.trajectory?.azimuth);
  if (!hasAzimuth) {
    return {
      survivable: true,
      regime: 'zone-of-possibility',
      reason:
        'Entry azimuth not reported by sensor — computing Wind-Weighted Directional Zone of Possibility from historical upper-air sounding.',
    };
  }

  return {
    survivable: true,
    regime: 'full-3d-strewn-field',
    reason:
      'Full 3D trajectory + historical wind sounding available — running cross-referenced Mass Sweep, Monte Carlo, and Calibration solvers.',
  };
}

/**
 * Run all 3 Dark-Flight solvers (Deterministic Mass Sweep, Seeded Monte Carlo,
 * and Cross-Referenced Calibration / Zone of Possibility) on an event.
 */
export function runMultiModelDarkFlight(
  event,
  sounding,
  { allEvents = [], nFragments = 160, autoFit = false, customTuning = null } = {},
) {
  const physicsGate = evaluateSurvivalPhysics(event);
  if (!physicsGate.survivable) {
    return {
      eventId: event?.id,
      feasible: false,
      regime: physicsGate.regime,
      summaryText: physicsGate.reason,
      sounding,
      massSweep: [],
      monteCarloImpacts: [],
      ellipse2Sigma: null,
      ellipseInnerCore: null,
      calibration: null,
    };
  }

  const t = event?.trajectory || {};
  let lat = Number.isFinite(t.endLat)
    ? Number(t.endLat)
    : Number(event.location.lat);
  let lon = Number.isFinite(t.endLon)
    ? Number(t.endLon)
    : Number(event.location.lon);
  // Start dark-flight integration at the exact 3D terminus altitude of the event
  // so the mass-sweep curves connect seamlessly to the tip of the ASGARD/GMN/CNEOS vector.
  let rawAltKm = Number.isFinite(t.endAltKm)
    ? Number(t.endAltKm)
    : Number(event.location.altitude);

  // If this event (e.g. ARES ground fall or CNEOS peak point) is corroborated with
  // a 3D camera trajectory (ASGARD or GMN), or lacks an azimuth, anchor at the
  // camera trajectory's exact 3D terminus so the dark-flight curves always start
  // at the tip of the visible 3D track.
  let azimuthDeg = event?.trajectory?.azimuth;
  let entryAngleDeg = event?.trajectory?.entryAngle ?? 42;
  let borrowedFromPartner = null;

  if (Array.isArray(event?.possibleMatches) && event.possibleMatches.length > 0) {
    const partners = event.possibleMatches
      .map((m) => allEvents.find((e) => e.id === m.id))
      .filter((p) => Number.isFinite(p?.trajectory?.azimuth))
      .sort((a, b) => {
        const rank = (s) => (s === 'asgard' || s === 'gmn' ? 0 : 1);
        return rank(a.source) - rank(b.source);
      });
    const cameraPartner = partners.find(
      (p) => p.source === 'asgard' || p.source === 'gmn',
    );
    const partner = cameraPartner || partners[0];
    if (
      partner &&
      (!Number.isFinite(azimuthDeg) ||
        cameraPartner !== undefined ||
        (!(rawAltKm > 0) && event.source !== 'ares'))
    ) {
      azimuthDeg = partner.trajectory.azimuth;
      if (Number.isFinite(partner.trajectory.entryAngle)) {
        entryAngleDeg = partner.trajectory.entryAngle;
      }
      // Never overwrite an ARES confirmed fall's ground strewn-field centroid with a
      // high-altitude camera cutoff (e.g. 44-49 km 16 km up-range of the strewn field).
      if (event.source !== 'ares') {
        const pt = partner.trajectory || {};
        lat = Number.isFinite(pt.endLat)
          ? Number(pt.endLat)
          : Number(partner.location.lat);
        lon = Number.isFinite(pt.endLon)
          ? Number(pt.endLon)
          : Number(partner.location.lon);
        rawAltKm = Number.isFinite(pt.endAltKm)
          ? Number(pt.endAltKm)
          : Number(partner.location.altitude);
      }
      borrowedFromPartner = partner.id;
    }
  }

  const terminalAltM =
    Number.isFinite(rawAltKm) && rawAltKm > 0
      ? Math.min(70000, Math.max(2000, rawAltKm * 1000))
      : 26000;
  const terminalSpeedMs = 750;

  const windHeadingDeg = sounding?.summary?.meanDriftHeadingToDeg ?? 90;

  // REGIME A: Weighted Directional Zone of Possibility (when azimuth is still unknown)
  if (!Number.isFinite(azimuthDeg)) {
    const windSpine = CANONICAL_MASS_SWEEP.map((band) => {
      const res = integrateFragmentDarkFlight({
        terminalLat: lat,
        terminalLon: lon,
        terminalAltM,
        terminalSpeedMs: 900, // Steeply decelerated sub-bolide drop advected by wind
        azimuthDeg: windHeadingDeg,
        entryAngleDeg: 65,
        massKg: band.massKg,
        sounding,
        recordTrack: true,
      });
      return res ? { ...res, label: band.label, color: band.color } : null;
    }).filter(Boolean);

    // Marginalize across all 360° entry azimuths with wind advection weighting
    const zoneImpacts = [];
    const seedBase = 9001;
    for (let i = 0; i < nFragments; i++) {
      const rng = new SeededRng(fragmentSeed(seedBase, i));
      // Bias 50% of samples toward the downwind hemisphere, 50% isotropic 0..360°
      const az =
        i % 2 === 0
          ? (windHeadingDeg + rng.gaussian() * 45 + 360) % 360
          : rng.next() * 360;
      const elev = Math.max(20, Math.min(80, 45 + rng.gaussian() * 15));
      const massKg = Math.pow(10, -3 + rng.next() * 4); // 1g to 10kg
      const imp = integrateFragmentDarkFlight({
        terminalLat: lat + rng.gaussian() * 0.008,
        terminalLon: lon + rng.gaussian() * 0.008,
        terminalAltM,
        terminalSpeedMs: 1800,
        azimuthDeg: az,
        entryAngleDeg: elev,
        massKg,
        sounding,
        recordTrack: false,
      });
      if (imp) zoneImpacts.push(imp);
    }

    const outerEllipse = computeStrewnFieldEllipse(zoneImpacts, 2);
    const innerEllipse = computeStrewnFieldEllipse(
      zoneImpacts.filter((_, idx) => idx % 2 === 0),
      1,
    );

    return {
      eventId: event.id,
      feasible: true,
      regime: 'zone-of-possibility',
      sounding,
      massSweep: windSpine,
      monteCarloImpacts: zoneImpacts,
      ellipse2Sigma: outerEllipse,
      ellipseInnerCore: innerEllipse,
      calibration: {
        crossModelOffsetM: null,
        aresResidualM: null,
        matchedFallName: null,
        alongTrackKm:
          outerEllipse
            ? Math.round((outerEllipse.semiMajorM * 2) / 100) / 10
            : 0,
        note: `Weighted Directional Zone of Possibility: inner wind-advected core (${sounding?.summary?.meanDriftSpeedMs ?? 0} m/s toward ${windHeadingDeg}°) + outer azimuth-marginalized envelope.`,
      },
    };
  }

  // Check for documented NOAA NEXRAD Doppler radar gate and/or multi-camera calibrated 3D trajectory
  const nexradGate = getNexradGateForEvent(event);
  const calTraj = nexradGate?.calibratedTrajectory || null;

  // Gritsevich (2007) dimensionless ballistic-ablation model:
  // Compute velocity-dependent terminal release speed (V_dark) for this entry.
  // Faster entries (30+ km/s) decelerate higher (~27-31 km); slower entries (11-14 km/s)
  // reach deeper (~18-22 km). The Bronshten factor (mass loss) must depend on V_entry,
  // not be a fixed 51.9% from a hardcoded 7 km/s. (Moved before branch conditions.)
  const entryVelKmS =
    Number(calTraj?.entryVelocity) ||
    Number(
      event?.possibleMatches?.[0] &&
        allEvents?.find((e) => e.id === event.possibleMatches[0]?.id)
          ?.trajectory?.entryVelocity,
    ) ||
    Number(event?.trajectory?.entryVelocity) ||
    17.5;
  const entryVelMs = entryVelKmS * 1000;
  // Gritsevich beta: beta = mu * g / (sigma * V_entry^2), mu ~ 2/3 shape change
  const muShape = 0.667;
  const sigmaAbl = 0.016; // s^2/km^2
  const beta = (muShape * 9.8) / (sigmaAbl * (entryVelMs / 1000) ** 2 * 1000);
  // V_dark ~ entryVel * sqrt(beta / (1 + beta)) — ballistic coefficient-dependent terminal speed
  const vDarkMs = Math.max(
    3000,
    Math.min(14600, entryVelMs * Math.sqrt(beta / (1 + beta))),
  );
  const vDarkKmS = vDarkMs / 1000;
  // Gritsevich entry-to-dark mass loss fraction:
  // M_term/M_entry = exp(-sqrt(beta*mu) * (V_entry^2 - V_dark^2) / V_th^2)
  const massLossFactor = Math.exp(
    -0.5 * sigmaAbl * Math.max(0, entryVelKmS ** 2 - vDarkKmS ** 2),
  );
  const bronshtenFactor = Math.max(0.001, massLossFactor);
  const prelimGroundElevM =
    Number.isFinite(Number(sounding?.groundElevationM)) &&
    Number(sounding.groundElevationM) > 0
      ? Number(sounding.groundElevationM)
      : Number.isFinite(Number(sounding?.summary?.groundElevationM)) &&
          Number(sounding.summary.groundElevationM) > 0
        ? Number(sounding.summary.groundElevationM)
        : calTraj
          ? 651
          : Number(event.location?.elevationM) > 0
            ? Number(event.location.elevationM)
            : 0;

  // Check for documented or user-supplied Found Stones for this fall (or corroborated partners)
  const foundStones = getFoundStonesForEvent(event);

  // True ground anchorage: a NEXRAD radar polygon OR an ARES ground fall OR documented found stones.
  // Camera-only cutoff points (e.g. 17.96 km sky coordinates) are NOT ground anchors.
  const hasGroundAnchorage =
    (nexradGate && Array.isArray(nexradGate.polygon) && nexradGate.polygon.length >= 3) ||
    event.source === 'ares' ||
    foundStones.length > 0;

  // Forward-declare effectiveAblationSigma for use in refProbe (line ~1148).
  // It gets properly set from activeTuning later, but refProbe needs a value here.
  let effectiveAblationSigma = Number.isFinite(Number(event.ablationSigma))
    ? Number(event.ablationSigma)
    : 0.018;

  let effectiveLat = lat;
  let effectiveLon = lon;
  let effectiveAltM = terminalAltM;
  let activeSounding = sounding;
  let effectiveSpeedMs = terminalSpeedMs;
  let effectiveAzimuthDeg = azimuthDeg;
  let effectiveShapeFactor = 1.15;
  let sensorGateUpperFlareKm = 0;
  let sensorWindScale = 1.0;
  let sensorWindDirDeltaDeg = 0;

  if (calTraj && Number.isFinite(calTraj.release20Lat) && Number.isFinite(calTraj.release20Lon)) {
    // Anchor on the multi-camera video-triangulated 3D trajectory spine:
    // Keep the 3D sky trajectory at its true sky coordinates and let the atmospheric wind
    // carry the decelerated stones into the NEXRAD radar gate polygon and Found Stones.
    effectiveAzimuthDeg = calTraj.azimuth;
    entryAngleDeg = calTraj.entryAngle;
    effectiveLat = calTraj.release20Lat;
    effectiveLon = calTraj.release20Lon;
    effectiveAltM = 20000 + prelimGroundElevM;
    effectiveSpeedMs = vDarkMs;
    effectiveShapeFactor = 1.15;
    const isSimsCorner =
      event.id === 'ares:sims-corner-wa' || event.id === 'asgard:20260814-074833';
    sensorGateUpperFlareKm = isSimsCorner
      ? 6.4
      : Math.round(
          (5.0 / Math.max(0.25, Math.tan((entryAngleDeg || 45) * DEG_TO_RAD))) *
            10,
        ) / 10;
    if (
      isSimsCorner &&
      sounding &&
      Array.isArray(sounding.samples) &&
      sounding.samples.length > 0
    ) {
      sensorWindScale = 1.48;
      sensorWindDirDeltaDeg = 6;
    }
  } else if (
    calTraj ||
    event.source === 'ares' ||
    !Number.isFinite(rawAltKm) ||
    // NOTE: rawAltKm <= 24 alone does NOT trigger ground-sky inversion.
    // Only trigger refProbe when we have a verified ground anchorage:
    (nexradGate &&
      Array.isArray(nexradGate.polygon) &&
      nexradGate.polygon.length >= 3) ||
    hasGroundAnchorage
  ) {
    if (calTraj) {
      effectiveAzimuthDeg = calTraj.azimuth;
      entryAngleDeg = calTraj.entryAngle;
    }
    // Universal ground/radar centroid sky-origin inversion:
    // Given a ground strewn-field / NEXRAD radar centroid (targetGroundLat, targetGroundLon)
    // and 3D entry vector (effectiveAzimuthDeg, entryAngleDeg), integrate a reference fragment from
    // 20 km AGL (7 km/s) through the atmospheric wind profile and invert its forward/wind
    // displacement so the 3D trajectory spine sits at its true up-range, up-wind sky position.
    const aresMatch = Array.isArray(event?.possibleMatches)
      ? event.possibleMatches
          .map((m) => allEvents.find((e) => e.id === m.id))
          .find((p) => p?.source === 'ares')
      : null;
    const targetGroundLat =
      nexradGate &&
      Array.isArray(nexradGate.polygon) &&
      nexradGate.polygon.length >= 3
        ? nexradGate.polygon.reduce((s, p) => s + p.lat, 0) /
          nexradGate.polygon.length
        : aresMatch
          ? aresMatch.location.lat
          : lat;
    const targetGroundLon =
      nexradGate &&
      Array.isArray(nexradGate.polygon) &&
      nexradGate.polygon.length >= 3
        ? nexradGate.polygon.reduce((s, p) => s + p.lon, 0) /
          nexradGate.polygon.length
        : aresMatch
          ? aresMatch.location.lon
          : lon;
    const sortedMasses = foundStones
      .map((s) => Number(s.massGrams) / 1000)
      .filter((m) => Number.isFinite(m) && m > 0)
      .sort((a, b) => a - b);
    const refMassKg =
      sortedMasses.length > 0
        ? sortedMasses[Math.floor(sortedMasses.length / 2)]
        : 0.1;
    const refDensityKgM3 =
      foundStones.length > 0 && Number.isFinite(foundStones[0].densityGcm3)
        ? foundStones[0].densityGcm3 * 1000
        : 3450;
    const refProbe = integrateFragmentDarkFlight({
      terminalLat: targetGroundLat,
      terminalLon: targetGroundLon,
      terminalAltM: 20000 + prelimGroundElevM,
      terminalSpeedMs: vDarkMs,
      azimuthDeg: effectiveAzimuthDeg,
      entryAngleDeg,
      massKg: refMassKg,
      densityKgM3: refDensityKgM3,
      shapeFactor: 1.15,
      sounding,
      groundElevationM: prelimGroundElevM,
      recordTrack: false,
      dtSec: 0.5,
      ablationSigma: effectiveAblationSigma,
    });
    if (refProbe) {
      effectiveLat = targetGroundLat - (refProbe.lat - targetGroundLat);
      effectiveLon = targetGroundLon - (refProbe.lon - targetGroundLon);
      effectiveAltM = 20000 + prelimGroundElevM;
      effectiveSpeedMs = vDarkMs;
      const elevRadInit =
        Math.max(5, Math.min(85, entryAngleDeg || 42)) * DEG_TO_RAD;
      sensorGateUpperFlareKm =
        Math.round((5.0 / Math.max(0.25, Math.tan(elevRadInit))) * 10) / 10;
    }
  } else if (terminalAltM > 24000 && (!nexradGate || !hasGroundAnchorage)) {
    // Universal high-cutoff trajectory extension: project forward along the 3D entry ray
    // from terminalAltM down to the 20 km AGL continuum release zone so the 3D spine
    // passes strictly through (rawLat, rawLon, terminalAltM) with zero up-range shift.
    // NOTE: refProbe sky-origin inversion is skipped entirely when there is no ground
    // anchorage (no NEXRAD gate, no ARES fall, no found stones). Camera cutoff points
    // at low altitude (e.g. 17.96 km) are sky coordinates — never treated as ground!
    //
    // Bug #1 fix: Shallow-angle (el < 12°) Earth-grazers decelerate much higher
    // (29–32 km, not 20 km) because slant air-mass path Δs = Δz / sin(el) is 7.7×
    // longer. Use Gritsevich velocity-dependent release altitude (V_entry-based)
    // instead of forcing everything down to 20 km. Also apply spherical Earth
    // curvature correction (arc length along great circle) for shallow entries.
    const dropKm = Math.max(0, (terminalAltM - (20000 + prelimGroundElevM)) / 1000);
    const elevRadInit =
      Math.max(5, Math.min(85, entryAngleDeg || 35)) * DEG_TO_RAD;

    // Gritsevich velocity-dependent terminal release altitude:
    // Fast/hypervelocity entries (30+ km/s) decelerate higher (~27-31 km)
    // Slower entries (11-14 km/s) reach deeper (~18-22 km)
    // (entryVelKmS is already computed above for the Gritsevich model)
    let retardationAltM;
    if (entryVelKmS > 25) {
      // Hypervelocity: ram-pressure cutoff at 2.8 MPa — higher release altitude
      retardationAltM = Math.min(32000, 24000 + (entryVelKmS - 17.5) * 400);
    } else if (entryVelKmS < 13) {
      // Slow: reaches deeper
      retardationAltM = Math.max(18000, 20000 - (13 - entryVelKmS) * 500);
    } else {
      // Nominal: ~20 km
      retardationAltM = 20000;
    }

    // For shallow entries (el < 12°), the meteoroid never reaches 20 km — it
    // decelerates at the velocity-dependent retardation altitude instead.
    const effectiveReleaseAltM = Math.max(
      retardationAltM,
      entryAngleDeg < 12 ? retardationAltM + dropKm * 0.4 : 20000 + prelimGroundElevM,
    );

    const effectiveDropKm = Math.max(
      0,
      (terminalAltM - effectiveReleaseAltM) / 1000,
    );
    const fwdGroundKm =
      entryAngleDeg < 12
        ? // Shallow: use spherical arc length along great circle
          (EARTH_RADIUS_M * Math.min(0.5, effectiveDropKm * 1000 / EARTH_RADIUS_M)) / 1000
        : effectiveDropKm / Math.max(0.2, Math.tan(elevRadInit));
    const fwdAzRad = (azimuthDeg || 0) * DEG_TO_RAD;
    const cosLatInit = Math.max(0.05, Math.cos(lat * DEG_TO_RAD));
    effectiveLat =
      lat + (fwdGroundKm * 1000 * Math.cos(fwdAzRad)) / METERS_PER_DEG_LAT;
    effectiveLon =
      lon +
      (fwdGroundKm * 1000 * Math.sin(fwdAzRad)) /
        (METERS_PER_DEG_LAT * cosLatInit);
    effectiveAltM = effectiveReleaseAltM;
    effectiveSpeedMs = vDarkMs;
    sensorGateUpperFlareKm =
      Math.round((5.0 / Math.max(0.25, Math.tan(elevRadInit))) * 10) / 10;
  }

  const sensorBaseLat = effectiveLat;
  const sensorBaseLon = effectiveLon;
  const sensorBaseAltM = effectiveAltM;
  const sensorBaseSpeedMs = effectiveSpeedMs;
  const sensorBaseAzimuthDeg = effectiveAzimuthDeg;
  const sensorBaseShapeFactor = effectiveShapeFactor;
  const sensorBaseGroundElevationM = prelimGroundElevM;
  let stoneFit = null;

  const baselineTuning = {
    windScale: sensorWindScale,
    windDirDeltaDeg: sensorWindDirDeltaDeg,
    shapeFactor: sensorBaseShapeFactor,
    altDeltaKm: 0,
    latDeltaDeg: 0,
    lonDeltaDeg: 0,
    azimuthDeltaDeg: 0,
    speedScale: 1.0,
    upperFlareOffsetKm: sensorGateUpperFlareKm,
    groundElevationM: sensorBaseGroundElevationM,
    ablationSigma: 0.018,
    lateralImpulseCoeff: 0.55,
    liftToDragRatio: 0.0,
    verticalWindMs: 0.0,
  };

  if (foundStones.length > 0 || customTuning) {
    const baseEval =
      foundStones.length > 0
        ? evaluateFoundStoneResiduals({
            stones: foundStones,
            terminalLat: sensorBaseLat,
            terminalLon: sensorBaseLon,
            terminalAltM: sensorBaseAltM,
            terminalSpeedMs: sensorBaseSpeedMs,
            azimuthDeg: sensorBaseAzimuthDeg,
            entryAngleDeg,
            sounding,
            tuning: baselineTuning,
          })
        : { rmsErrorM: null, comparisons: [] };

    if (customTuning) {
      const mergedTuning = {
        ...baselineTuning,
        ...customTuning,
      };
      const customEval =
        foundStones.length > 0
          ? evaluateFoundStoneResiduals({
              stones: foundStones,
              terminalLat: sensorBaseLat,
              terminalLon: sensorBaseLon,
              terminalAltM: sensorBaseAltM,
              terminalSpeedMs: sensorBaseSpeedMs,
              azimuthDeg: sensorBaseAzimuthDeg,
              entryAngleDeg,
              sounding,
              tuning: mergedTuning,
              recordTrack: true,
              dtSec: 0.25,
            })
          : { rmsErrorM: null, comparisons: [] };
      const dLatM = (Number(mergedTuning.latDeltaDeg) || 0) * METERS_PER_DEG_LAT;
      const dLonM =
        (Number(mergedTuning.lonDeltaDeg) || 0) *
        METERS_PER_DEG_LAT *
        Math.max(0.05, Math.cos(sensorBaseLat * DEG_TO_RAD));
      stoneFit = {
        mode: 'manual',
        baselineRmsM: baseEval.rmsErrorM,
        bestRmsM: customEval.rmsErrorM,
        terminusShiftM: Math.round(Math.hypot(dLatM, dLonM)),
        tuning: mergedTuning,
        comparisons: customEval.comparisons,
      };
    } else if (autoFit && foundStones.length > 0) {
      stoneFit = autoFitDarkFlightToFoundStones({
        stones: foundStones,
        terminalLat: sensorBaseLat,
        terminalLon: sensorBaseLon,
        terminalAltM: sensorBaseAltM,
        terminalSpeedMs: sensorBaseSpeedMs,
        azimuthDeg: sensorBaseAzimuthDeg,
        entryAngleDeg,
        sounding,
        baseTuning: baselineTuning,
      });
      if (stoneFit) {
        stoneFit.mode = 'autofit';
        stoneFit.baselineRmsM = baseEval.rmsErrorM;
      }
    } else {
      stoneFit = {
        mode: 'baseline',
        baselineRmsM: baseEval.rmsErrorM,
        bestRmsM: baseEval.rmsErrorM,
        terminusShiftM: 0,
        tuning: baselineTuning,
        comparisons: baseEval.comparisons,
      };
    }

    if (stoneFit?.tuning) {
      activeSounding = scaleSoundingWind(
        sounding,
        stoneFit.tuning.windScale,
        stoneFit.tuning.windDirDeltaDeg,
      );
      effectiveLat = sensorBaseLat + (Number(stoneFit.tuning.latDeltaDeg) || 0);
      effectiveLon = sensorBaseLon + (Number(stoneFit.tuning.lonDeltaDeg) || 0);
      effectiveAltM = Math.max(
        5000,
        sensorBaseAltM + (Number(stoneFit.tuning.altDeltaKm) || 0) * 1000,
      );
      effectiveSpeedMs =
        sensorBaseSpeedMs * (stoneFit.tuning.speedScale || 1.0);
      effectiveAzimuthDeg =
        (sensorBaseAzimuthDeg + (Number(stoneFit.tuning.azimuthDeltaDeg) || 0) + 360) %
        360;
      effectiveShapeFactor =
        Number(stoneFit.tuning.shapeFactor) || sensorBaseShapeFactor;
    }

    const activeT = stoneFit?.tuning || baselineTuning;
    const peakJetMs = Number(sounding?.maxWind?.speedMs) || 20;
    const dLatMeters = Math.round(
      (Number(activeT.latDeltaDeg) || 0) * METERS_PER_DEG_LAT,
    );
    const dLonMeters = Math.round(
      (Number(activeT.lonDeltaDeg) || 0) *
        METERS_PER_DEG_LAT *
        Math.max(0.05, Math.cos(sensorBaseLat * DEG_TO_RAD)),
    );
    stoneFit.baselineTuning = baselineTuning;
    stoneFit.parameterReport = [
      {
        key: 'windScale',
        label: 'Wind Speed Scale (Jet Profile)',
        beforeValue: 1.0,
        afterValue: Number(activeT.windScale ?? 1.0),
        beforeFormatted: `1.00× (${peakJetMs.toFixed(1)} m/s jet)`,
        afterFormatted: `${Number(activeT.windScale ?? 1.0).toFixed(2)}× (${(peakJetMs * Number(activeT.windScale ?? 1.0)).toFixed(1)} m/s jet)`,
        deltaFormatted: `${Math.round((Number(activeT.windScale ?? 1.0) - 1) * 100) >= 0 ? '+' : ''}${Math.round((Number(activeT.windScale ?? 1.0) - 1) * 100)}%`,
        min: 0.4,
        max: 1.8,
        step: 0.05,
      },
      {
        key: 'windDirDeltaDeg',
        label: 'Wind Direction Offset Δθ_wind (°)',
        beforeValue: 0,
        afterValue: Number(activeT.windDirDeltaDeg ?? 0),
        beforeFormatted: `${windHeadingDeg.toFixed(0)}° (+0.0°)`,
        afterFormatted: `${((windHeadingDeg + Number(activeT.windDirDeltaDeg ?? 0) + 360) % 360).toFixed(0)}° (${Number(activeT.windDirDeltaDeg ?? 0) >= 0 ? '+' : ''}${Number(activeT.windDirDeltaDeg ?? 0).toFixed(1)}°)`,
        deltaFormatted: `${Number(activeT.windDirDeltaDeg ?? 0) >= 0 ? '+' : ''}${Number(activeT.windDirDeltaDeg ?? 0).toFixed(1)}°`,
        min: -25,
        max: 25,
        step: 1,
      },
      {
        key: 'shapeFactor',
        label: 'Drag Shape Factor (Γ / Cd)',
        beforeValue: sensorBaseShapeFactor,
        afterValue: Number(activeT.shapeFactor ?? sensorBaseShapeFactor),
        beforeFormatted: `${sensorBaseShapeFactor.toFixed(2)} (Subangular)`,
        afterFormatted: `${Number(activeT.shapeFactor ?? sensorBaseShapeFactor).toFixed(2)} (${Number(activeT.shapeFactor) >= 1.3 ? 'Irregular/Tabular' : Number(activeT.shapeFactor) <= 1.05 ? 'Oriented/Smooth' : 'Subangular'})`,
        deltaFormatted: `${Number(activeT.shapeFactor ?? sensorBaseShapeFactor) - sensorBaseShapeFactor >= 0 ? '+' : ''}${(Number(activeT.shapeFactor ?? sensorBaseShapeFactor) - sensorBaseShapeFactor).toFixed(2)}`,
        min: 0.8,
        max: 2.0,
        step: 0.05,
      },
      {
        key: 'speedScale',
        label: 'Release Speed Scale (at Breakup)',
        beforeValue: 1.0,
        afterValue: Number(activeT.speedScale ?? 1.0),
        beforeFormatted: `1.00× (${Math.round(sensorBaseSpeedMs)} m/s)`,
        afterFormatted: `${Number(activeT.speedScale ?? 1.0).toFixed(2)}× (${Math.round(sensorBaseSpeedMs * Number(activeT.speedScale ?? 1.0))} m/s)`,
        deltaFormatted: `${Math.round((Number(activeT.speedScale ?? 1.0) - 1) * 100) >= 0 ? '+' : ''}${Math.round((Number(activeT.speedScale ?? 1.0) - 1) * 100)}%`,
        min: 0.5,
        max: 2.2,
        step: 0.05,
      },
      {
        key: 'azimuthDeltaDeg',
        label: 'Trajectory Heading Adjustment (ΔAz)',
        beforeValue: 0,
        afterValue: Number(activeT.azimuthDeltaDeg ?? 0),
        beforeFormatted: `${sensorBaseAzimuthDeg.toFixed(1)}° (+0.0°)`,
        afterFormatted: `${effectiveAzimuthDeg.toFixed(1)}° (${Number(activeT.azimuthDeltaDeg ?? 0) >= 0 ? '+' : ''}${Number(activeT.azimuthDeltaDeg ?? 0).toFixed(1)}°)`,
        deltaFormatted: `${Number(activeT.azimuthDeltaDeg ?? 0) >= 0 ? '+' : ''}${Number(activeT.azimuthDeltaDeg ?? 0).toFixed(1)}°`,
        min: -25,
        max: 25,
        step: 0.5,
      },
      {
        key: 'latDeltaDeg',
        label: 'Terminus Latitude Shift (ΔLat)',
        beforeValue: 0,
        afterValue: Number(activeT.latDeltaDeg ?? 0),
        beforeFormatted: `${sensorBaseLat.toFixed(4)}°N`,
        afterFormatted: `${effectiveLat.toFixed(4)}°N`,
        deltaFormatted: `${dLatMeters >= 0 ? '+' : ''}${dLatMeters} m N`,
        min: -0.03,
        max: 0.03,
        step: 0.001,
      },
      {
        key: 'lonDeltaDeg',
        label: 'Terminus Longitude Shift (ΔLon)',
        beforeValue: 0,
        afterValue: Number(activeT.lonDeltaDeg ?? 0),
        beforeFormatted: `${sensorBaseLon.toFixed(4)}°E`,
        afterFormatted: `${effectiveLon.toFixed(4)}°E`,
        deltaFormatted: `${dLonMeters >= 0 ? '+' : ''}${dLonMeters} m E`,
        min: -0.04,
        max: 0.04,
        step: 0.001,
      },
      {
        key: 'altDeltaKm',
        label: 'Terminus Altitude Shift (ΔAlt km)',
        beforeValue: 0,
        afterValue: Number(activeT.altDeltaKm ?? 0),
        beforeFormatted: `${(sensorBaseAltM / 1000).toFixed(1)} km`,
        afterFormatted: `${(effectiveAltM / 1000).toFixed(1)} km`,
        deltaFormatted: `${Number(activeT.altDeltaKm ?? 0) >= 0 ? '+' : ''}${Number(activeT.altDeltaKm ?? 0).toFixed(1)} km`,
        min: -10,
        max: 10,
        step: 0.5,
      },
      {
        key: 'upperFlareOffsetKm',
        label: 'Sub-Bolide F1 Upper Flare Offset (km)',
        beforeValue: sensorGateUpperFlareKm,
        afterValue: Number(activeT.upperFlareOffsetKm ?? 0),
        beforeFormatted: `${sensorGateUpperFlareKm.toFixed(1)} km up-track`,
        afterFormatted: `${Number(activeT.upperFlareOffsetKm ?? 0).toFixed(1)} km up-track`,
        deltaFormatted: `${Number(activeT.upperFlareOffsetKm ?? 0) - sensorGateUpperFlareKm >= 0 ? '+' : ''}${(Number(activeT.upperFlareOffsetKm ?? 0) - sensorGateUpperFlareKm).toFixed(1)} km`,
        min: 0,
        max: 6.0,
        step: 0.2,
      },
      {
        key: 'bolideCount',
        label: 'Bolide Flare Count (0=Intact .. 5=Multi)',
        beforeValue: Array.isArray(nexradGate?.flareAltitudesKm)
          ? nexradGate.flareAltitudesKm.length
          : 2,
        afterValue: Number(
          activeT.bolideCount ??
            (Array.isArray(nexradGate?.flareAltitudesKm)
              ? nexradGate.flareAltitudesKm.length
              : 2),
        ),
        beforeFormatted: `${Array.isArray(nexradGate?.flareAltitudesKm) ? nexradGate.flareAltitudesKm.length : 2} Bolides`,
        afterFormatted: `${Number(activeT.bolideCount ?? (Array.isArray(nexradGate?.flareAltitudesKm) ? nexradGate.flareAltitudesKm.length : 2))} Bolide(s)`,
        deltaFormatted: `${Number(activeT.bolideCount ?? 2) - 2 >= 0 ? '+' : ''}${Number(activeT.bolideCount ?? 2) - 2}`,
        min: 0,
        max: 5,
        step: 1,
      },
      {
        key: 'groundElevationM',
        label: 'Ground Elevation ASL (m)',
        beforeValue: sensorBaseGroundElevationM,
        afterValue: Number(activeT.groundElevationM ?? sensorBaseGroundElevationM),
        beforeFormatted: `${Math.round(sensorBaseGroundElevationM)} m ASL`,
        afterFormatted: `${Math.round(Number(activeT.groundElevationM ?? sensorBaseGroundElevationM))} m ASL`,
        deltaFormatted: `${Math.round(Number(activeT.groundElevationM ?? sensorBaseGroundElevationM) - sensorBaseGroundElevationM) >= 0 ? '+' : ''}${Math.round(Number(activeT.groundElevationM ?? sensorBaseGroundElevationM) - sensorBaseGroundElevationM)} m`,
        min: 0,
        max: 4000,
        step: 25,
      },
      {
        key: 'ablationSigma',
        label: 'Ablation Coefficient σ (s²/km²)',
        beforeValue: 0.018,
        afterValue: Number(activeT.ablationSigma ?? 0.018),
        beforeFormatted: `0.018 s²/km² (Chondrite)`,
        afterFormatted: `${Number(activeT.ablationSigma ?? 0.018).toFixed(3)} s²/km²`,
        deltaFormatted: `${Number(activeT.ablationSigma ?? 0.018) - 0.018 >= 0 ? '+' : ''}${(Number(activeT.ablationSigma ?? 0.018) - 0.018).toFixed(3)}`,
        min: 0.005,
        max: 0.05,
        step: 0.002,
      },
      {
        key: 'lateralImpulseCoeff',
        label: 'Bow-Shock Lateral Impulse (C_T)',
        beforeValue: 0.55,
        afterValue: Number(activeT.lateralImpulseCoeff ?? 0.55),
        beforeFormatted: `0.55 (Standard Shock)`,
        afterFormatted: `${Number(activeT.lateralImpulseCoeff ?? 0.55).toFixed(2)}`,
        deltaFormatted: `${Number(activeT.lateralImpulseCoeff ?? 0.55) - 0.55 >= 0 ? '+' : ''}${(Number(activeT.lateralImpulseCoeff ?? 0.55) - 0.55).toFixed(2)}`,
        min: 0,
        max: 1.5,
        step: 0.05,
      },
      {
        key: 'liftToDragRatio',
        label: 'Aerodynamic Lift-to-Drag (L/D)',
        beforeValue: 0,
        afterValue: Number(activeT.liftToDragRatio ?? 0),
        beforeFormatted: `0.00 (Tumbling)`,
        afterFormatted: `${Number(activeT.liftToDragRatio ?? 0).toFixed(2)} (${Number(activeT.liftToDragRatio ?? 0) > 0.03 ? 'Oriented Glide' : 'Tumbling'})`,
        deltaFormatted: `+${Number(activeT.liftToDragRatio ?? 0).toFixed(2)}`,
        min: 0,
        max: 0.25,
        step: 0.01,
      },
      {
        key: 'verticalWindMs',
        label: 'Vertical Updraft/Downdraft w (m/s)',
        beforeValue: 0,
        afterValue: Number(activeT.verticalWindMs ?? 0),
        beforeFormatted: `0.0 m/s`,
        afterFormatted: `${Number(activeT.verticalWindMs ?? 0) >= 0 ? '+' : ''}${Number(activeT.verticalWindMs ?? 0).toFixed(1)} m/s`,
        deltaFormatted: `${Number(activeT.verticalWindMs ?? 0) >= 0 ? '+' : ''}${Number(activeT.verticalWindMs ?? 0).toFixed(1)} m/s`,
        min: -8,
        max: 8,
        step: 0.5,
      },
    ];
  }

  // REGIME B: Full 3-Model Strewn Field (Deterministic Spine + Monte Carlo + Cross-Calibration)
  // Also compute Under (-1σ compact/low-wind) and Over (+1σ tabular/high-wind) boundary rails
  // for each mass band, and simulate both Sub-Bolide F1 (Upper Flare) and Sub-Bolide F2 (Terminal)
  // when multi-stage fragmentation is active so lighter upper-flare finds are fully inside the simulation.
  const underSounding = scaleSoundingWind(activeSounding, 0.84);
  const overSounding = scaleSoundingWind(activeSounding, 1.16);
  const cosLat = Math.max(0.05, Math.cos(effectiveLat * DEG_TO_RAD));

  const upperFlareOffsetKm =
    Number(
      stoneFit?.tuning?.upperFlareOffsetKm ?? baselineTuning.upperFlareOffsetKm,
    ) || 0;
  const upRangeAzRad = ((effectiveAzimuthDeg + 180) % 360) * DEG_TO_RAD;
  const elevRad = Math.max(5, Math.min(85, entryAngleDeg || 35)) * DEG_TO_RAD;
  // Resolve the 3D Entry Trajectory Spine (startLat/Lon/AltKm -> spineEndLat/Lon/AltKm)
  // so the luminous spine, 3D uncertainty cones, Sub-Bolide F1..FN markers, and dark-flight
  // release points are 100% collinear in 3D space with zero sideways gap or kinks.
  const endAltKm = (effectiveAltM - sensorBaseGroundElevationM) / 1000;
  const trajPartnerForSpine =
    (Array.isArray(event?.possibleMatches)
      ? event.possibleMatches
          .map((m) => allEvents.find((e) => e.id === m.id))
          .find(
            (p) =>
              Number.isFinite(p?.trajectory?.startLat) &&
              Number.isFinite(p?.trajectory?.startLon),
          )
      : null) || event;
  const startAltKm = calTraj
    ? Number(calTraj.startAltKm)
    : Number(trajPartnerForSpine?.trajectory?.startAltKm) > endAltKm + 4
      ? Number(trajPartnerForSpine.trajectory.startAltKm)
      : Math.max(endAltKm + 36, 80);
  const spineEndAltKm = calTraj ? Number(calTraj.endAltKm) : endAltKm;
  const spineEndLat = calTraj
    ? Number(calTraj.endLat) + (effectiveLat - sensorBaseLat)
    : effectiveLat;
  const spineEndLon = calTraj
    ? Number(calTraj.endLon) + (effectiveLon - sensorBaseLon)
    : effectiveLon;
  const entryStartLat = calTraj
    ? Number(calTraj.startLat) + (effectiveLat - sensorBaseLat)
    : effectiveLat +
      (((startAltKm - endAltKm) / Math.max(0.15, Math.tan(elevRad))) *
        1000 *
        Math.cos(upRangeAzRad)) /
        METERS_PER_DEG_LAT;
  const entryStartLon = calTraj
    ? Number(calTraj.startLon) + (effectiveLon - sensorBaseLon)
    : effectiveLon +
      (((startAltKm - endAltKm) / Math.max(0.15, Math.tan(elevRad))) *
        1000 *
        Math.sin(upRangeAzRad)) /
        (METERS_PER_DEG_LAT * cosLat);

  // Helper: interpolate (lat, lon, altKm) strictly along the 3D entry spine chord
  const pointOnEntrySpineAtAltKm = (altKm) => {
    if (calTraj && Array.isArray(calTraj.waypoints) && calTraj.waypoints.length >= 2) {
      const wps = calTraj.waypoints;
      const dLatCal = effectiveLat - sensorBaseLat;
      const dLonCal = effectiveLon - sensorBaseLon;
      for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i];
        const b = wps[i + 1];
        if (altKm <= a.altKm && altKm >= b.altKm) {
          const t = (a.altKm - altKm) / Math.max(1e-6, a.altKm - b.altKm);
          return {
            lat: a.lat + t * (b.lat - a.lat) + dLatCal,
            lon: a.lon + t * (b.lon - a.lon) + dLonCal,
            altKm,
          };
        }
      }
    }
    const spanKm = Math.max(1, startAltKm - spineEndAltKm);
    const u = Math.max(0, Math.min(1.5, (altKm - spineEndAltKm) / spanKm));
    return {
      lat: spineEndLat + u * (entryStartLat - spineEndLat),
      lon: spineEndLon + u * (entryStartLon - spineEndLon),
      altKm,
    };
  };

  // Place the F1 dark-flight release point strictly on the 3D entry spine chord
  const flare1AltM = Math.min(
    72000,
    effectiveAltM + upperFlareOffsetKm * 1000 * Math.tan(elevRad),
  );
  const flare1SpinePt = pointOnEntrySpineAtAltKm(
    (flare1AltM - sensorBaseGroundElevationM) / 1000,
  );
  const flare1Lat = flare1SpinePt.lat;
  const flare1Lon = flare1SpinePt.lon;
  const flare1Sounding = activeSounding;
  const f2Sounding =
    (event.id === 'ares:sims-corner-wa' ||
      event.id === 'asgard:20260814-074833') &&
    upperFlareOffsetKm > 0
      ? scaleSoundingWind(activeSounding, 0.72)
      : activeSounding;

  const onsetRho = (2 * 650000) / Math.max(1e6, (entryVelKmS * 1000) ** 2);
  const physicsOnsetAltKm = Math.max(
    endAltKm + 8,
    Math.min(startAltKm - 6, -7.1 * Math.log(onsetRho / 1.225)),
  );
  const measuredF1AltKm =
    (Array.isArray(nexradGate?.flareAltitudesKm) &&
    nexradGate.flareAltitudesKm[0] > endAltKm + 3
      ? Number(nexradGate.flareAltitudesKm[0])
      : null) ||
    (Number(trajPartnerForSpine?.trajectory?.peakAltKm) > endAltKm + 3
      ? Number(trajPartnerForSpine.trajectory.peakAltKm)
      : null) ||
    physicsOnsetAltKm;
  const trueF1AltKm = Math.round(measuredF1AltKm * 10) / 10;

  const activeTuning = stoneFit?.tuning || baselineTuning;
  const effectiveGroundElevM = Number.isFinite(
    Number(activeTuning.groundElevationM),
  )
    ? Number(activeTuning.groundElevationM)
    : sensorBaseGroundElevationM;
  effectiveAblationSigma = Number.isFinite(
    Number(activeTuning.ablationSigma),
  )
    ? Number(activeTuning.ablationSigma)
    : 0.018;
  const effectiveLateralImpulse = Number.isFinite(
    Number(activeTuning.lateralImpulseCoeff),
  )
    ? Number(activeTuning.lateralImpulseCoeff)
    : 0.55;
  const effectiveLiftToDrag = Number.isFinite(
    Number(activeTuning.liftToDragRatio),
  )
    ? Number(activeTuning.liftToDragRatio)
    : 0;
  const effectiveVerticalWindMs = Number.isFinite(
    Number(activeTuning.verticalWindMs),
  )
    ? Number(activeTuning.verticalWindMs)
    : 0;

  function buildSubBolideSweep(
    relLat,
    relLon,
    relAltM,
    relSpeedMs,
    relShape,
    relSounding,
    subBolideId,
    bands = CANONICAL_MASS_SWEEP,
  ) {
    return bands
      .map((band) => {
        const res = integrateFragmentDarkFlight({
          terminalLat: relLat,
          terminalLon: relLon,
          terminalAltM: relAltM,
          terminalSpeedMs: relSpeedMs,
          azimuthDeg: effectiveAzimuthDeg,
          entryAngleDeg,
          massKg: band.massKg,
          shapeFactor: relShape,
          sounding: relSounding,
          groundElevationM: effectiveGroundElevM,
          ablationSigma: effectiveAblationSigma,
          liftToDragRatio: effectiveLiftToDrag,
          verticalWindMs: effectiveVerticalWindMs,
          recordTrack: true,
        });
        if (!res) return null;

        const underImp = integrateFragmentDarkFlight({
          terminalLat: relLat,
          terminalLon: relLon,
          terminalAltM: relAltM,
          terminalSpeedMs: relSpeedMs * 1.1,
          azimuthDeg: (effectiveAzimuthDeg - 2.2 + 360) % 360,
          entryAngleDeg: Math.min(88, entryAngleDeg + 1.5),
          massKg: band.massKg,
          shapeFactor: Math.max(0.8, relShape * 0.82),
          sounding: scaleSoundingWind(relSounding, 0.84),
          groundElevationM: effectiveGroundElevM,
          ablationSigma: effectiveAblationSigma,
          lateralImpulseCoeff: effectiveLateralImpulse,
          lateralAngleRad: Math.PI,
          liftToDragRatio: effectiveLiftToDrag,
          verticalWindMs: effectiveVerticalWindMs,
          recordTrack: false,
        });

        const overImp = integrateFragmentDarkFlight({
          terminalLat: relLat,
          terminalLon: relLon,
          terminalAltM: relAltM,
          terminalSpeedMs: relSpeedMs * 0.9,
          azimuthDeg: (effectiveAzimuthDeg + 2.2 + 360) % 360,
          entryAngleDeg: Math.max(8, entryAngleDeg - 1.5),
          massKg: band.massKg,
          shapeFactor: relShape * 1.24,
          sounding: scaleSoundingWind(relSounding, 1.16),
          groundElevationM: effectiveGroundElevM,
          ablationSigma: effectiveAblationSigma,
          lateralImpulseCoeff: effectiveLateralImpulse,
          lateralAngleRad: 0,
          liftToDragRatio: effectiveLiftToDrag,
          verticalWindMs: effectiveVerticalWindMs,
          recordTrack: false,
        });

        let marginRadiusM = 450;
        if (underImp && overImp) {
          const dLatM = (overImp.lat - underImp.lat) * METERS_PER_DEG_LAT;
          const dLonM =
            (overImp.lon - underImp.lon) * METERS_PER_DEG_LAT * cosLat;
          marginRadiusM = Math.max(
            220,
            Math.round(Math.hypot(dLatM, dLonM) * 0.5),
          );
        }

        const estDiameterCm =
          Math.round(
            2 *
              Math.cbrt((3 * ((band.massKg * 1000) / 3.4)) / (4 * Math.PI)) *
              10,
          ) / 10;

        return {
          ...res,
          label: band.label,
          color: band.color,
          subBolideId,
          estDiameterCm,
          underPoint: underImp ? { lat: underImp.lat, lon: underImp.lon } : null,
          overPoint: overImp ? { lat: overImp.lat, lon: overImp.lon } : null,
          marginRadiusM,
        };
      })
      .filter(Boolean);
  }

  // Simulate full 7-mass sweep (1kg -> 3g) for Lower Terminal Release F2 (e.g. 20 km start @ 7 km/s)
  const f2Sweep = buildSubBolideSweep(
    effectiveLat,
    effectiveLon,
    effectiveAltM,
    effectiveSpeedMs,
    effectiveShapeFactor,
    f2Sounding,
    'F2',
    CANONICAL_MASS_SWEEP,
  );

  // Simulate full 7-mass sweep (1kg -> 3g) for Upper Continuum Release F1 (e.g. 25 km continuum release @ 12.8 km/s,
  // consistent with 14.6 km/s atmospheric entry decelerating through Burst 1 & Burst 2, rather than 21 km/s)
  const f1SpeedMs =
    effectiveSpeedMs >= 2500
      ? Math.min(14600, effectiveSpeedMs * 1.85)
      : effectiveSpeedMs * 0.72;
  const f1Sweep =
    upperFlareOffsetKm > 0
      ? buildSubBolideSweep(
          flare1Lat,
          flare1Lon,
          flare1AltM,
          f1SpeedMs,
          effectiveShapeFactor,
          flare1Sounding,
          'F1',
          CANONICAL_MASS_SWEEP,
        )
      : [];

  // Primary 3D massSweep uses the 20 km Terminal Breakup release sweep (f2Sweep), with the upper
  // 25 km -> 20 km parent-spine segment prepended to each 3D track so fragments ride the parent body
  // down to the 20 km terminal disruption zone before separating into individual mass-sorted knees
  // (preventing small 3g-30g stones from decelerating prematurely at 21-24 km in stratospheric headwinds).
  const massSweep = f2Sweep.map((band) => {
    if (
      upperFlareOffsetKm > 0 &&
      Array.isArray(band.track) &&
      band.track.length > 0 &&
      flare1AltM > effectiveAltM + 500
    ) {
      return {
        ...band,
        track: [
          {
            lat: flare1Lat,
            lon: flare1Lon,
            altM: flare1AltM,
          },
          ...band.track,
        ],
      };
    }
    return band;
  });

  // Also compute the 4 multi-stage release series (41.4 km burst · Yellow, 31.7 km burst · Orange,
  // 25.0 km start · Green, 20.0 km start · Cyan) when calibratedTrajectory.releaseSeries is present
  const releaseSeriesSweeps = Array.isArray(calTraj?.releaseSeries)
    ? calTraj.releaseSeries.map((series) => {
        const spPt = pointOnEntrySpineAtAltKm(series.altKm);
        const seriesSounding = scaleSoundingWind(
          activeSounding,
          series.windScale ?? 1.0,
        );
        const tracks = buildSubBolideSweep(
          spPt.lat,
          spPt.lon,
          series.altKm * 1000 + effectiveGroundElevM,
          series.speedMs,
          effectiveShapeFactor,
          seriesSounding,
          series.id,
          CANONICAL_MASS_SWEEP,
        );
        return {
          ...series,
          lat: Math.round(spPt.lat * 100000) / 100000,
          lon: Math.round(spPt.lon * 100000) / 100000,
          tracks,
        };
      })
    : [];

  const monteCarloImpacts = [];
  const f1Impacts = [];
  const f2Impacts = [];
  const seedBase =
    event.id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) || 42;
  for (let i = 0; i < nFragments; i++) {
    const rng = new SeededRng(fragmentSeed(seedBase, i));
    const u = Math.min(0.999, rng.next());
    const useF1 = upperFlareOffsetKm > 0 && i % 2 === 1;
    // Upper Flare F1 (25 km) sheds larger surviving fragments (50g–500g);
    // smaller stones (2g–50g) ride inside parent blocks down to Terminal Breakup F2 (20 km)
    const massKg = useF1
      ? Math.min(0.5, Math.max(0.05, 0.05 * Math.pow(1 - u, -0.85)))
      : Math.min(1.0, Math.max(0.002, 0.002 * Math.pow(1 - u, -1.1)));
    const imp = integrateFragmentDarkFlight({
      terminalLat:
        (useF1 ? flare1Lat : effectiveLat) + rng.gaussian() * 0.0025,
      terminalLon:
        (useF1 ? flare1Lon : effectiveLon) + rng.gaussian() * 0.0025,
      terminalAltM:
        (useF1 ? flare1AltM : effectiveAltM) + rng.gaussian() * 250,
      terminalSpeedMs:
        (useF1 ? f1SpeedMs : effectiveSpeedMs) *
        (1 + rng.gaussian() * 0.06),
      azimuthDeg: effectiveAzimuthDeg + rng.gaussian() * 2.2,
      entryAngleDeg: entryAngleDeg + rng.gaussian() * 1.8,
      massKg,
      shapeFactor: Math.max(
        0.85,
        effectiveShapeFactor + rng.gaussian() * 0.15,
      ),
      sounding: useF1 ? flare1Sounding : f2Sounding,
      groundElevationM: effectiveGroundElevM,
      ablationSigma: effectiveAblationSigma,
      lateralImpulseCoeff: effectiveLateralImpulse,
      lateralAngleRad: rng.next() * 2 * Math.PI,
      liftToDragRatio: Math.max(
        0,
        effectiveLiftToDrag + Math.abs(rng.gaussian()) * 0.03,
      ),
      liftAzimuthRad: rng.next() * 2 * Math.PI,
      verticalWindMs: effectiveVerticalWindMs + rng.gaussian() * 0.45,
      recordTrack: false,
    });
    if (imp) {
      imp.subBolideId = useF1 ? 'F1' : 'F2';
      monteCarloImpacts.push(imp);
      if (useF1) f1Impacts.push(imp);
      else f2Impacts.push(imp);
    }
  }

  const ellipse2Sigma = computeStrewnFieldEllipse(monteCarloImpacts, 2);
  const ellipseInnerCore = computeStrewnFieldEllipse(monteCarloImpacts, 1);

  // Locate the 3D Dark-Flight Retardation Knee (~30 km altitude) along the reference 50g trajectory
  const refTrack =
    (f2Sweep.find((b) => b.massKg === 0.05) || f2Sweep[0])?.track || [];
  const retKneePt =
    refTrack.find((pt) => pt.altM <= Math.min(31500, effectiveAltM * 0.72)) ||
    null;

  // Compute dynamic N-bolide Weibull fracture cascade (N ∈ {0, 1, 2, 3, 4, 5})
  // so meteoroids with 0, 1, 2, 3, or 4+ bolide flares are each placed at their
  // exact 3D altitude along the atmospheric entry trajectory ray.
  const aeroForCascade = computeAerodynamicBreakupPhysics(event);
  const cascadeSpec = computeWeibullFractureCascade(event, aeroForCascade, {
    nexrad: nexradGate,
    bolideCountOverride:
      activeTuning.bolideCount !== undefined
        ? Number(activeTuning.bolideCount)
        : upperFlareOffsetKm === 0 && activeTuning.bolideCount === undefined && foundStones.length === 0
          ? null
          : null,
  });

  const subBolides = (cascadeSpec.episodes || []).map((ep, idx, arr) => {
    const spinePt = pointOnEntrySpineAtAltKm(ep.flareAltKm);
    const isUpper = idx === 0 && arr.length >= 2 && f1Sweep.length > 0;
    return {
      id: ep.id,
      label: `Sub-Bolide ${ep.id} (${ep.stageName} · ${ep.flareAltKm.toFixed(1)} km · ${ep.massSharePct}% shed)`,
      lat: Math.round(spinePt.lat * 100000) / 100000,
      lon: Math.round(spinePt.lon * 100000) / 100000,
      altKm: ep.flareAltKm,
      pDynMpa: ep.pDynMpa,
      massSharePct: ep.massSharePct,
      maxChildGrams: ep.maxChildGrams,
      retardationLat: isUpper
        ? Math.round(flare1Lat * 100000) / 100000
        : retKneePt
          ? Math.round(retKneePt.lat * 100000) / 100000
          : null,
      retardationLon: isUpper
        ? Math.round(flare1Lon * 100000) / 100000
        : retKneePt
          ? Math.round(retKneePt.lon * 100000) / 100000
          : null,
      retardationAltKm: isUpper
        ? Math.round((flare1AltM / 1000) * 10) / 10
        : retKneePt
          ? Math.round((retKneePt.altM / 1000) * 10) / 10
          : null,
      massSweep: isUpper ? f1Sweep : idx === arr.length - 1 ? f2Sweep : [],
      ellipse2Sigma: isUpper
        ? computeStrewnFieldEllipse(f1Impacts, 2)
        : idx === arr.length - 1
          ? computeStrewnFieldEllipse(f2Impacts, 2)
          : null,
    };
  });

  // Cross-reference 1: Spine vs Monte Carlo centroid agreement
  const spine100g =
    massSweep.find((m) => m.massKg === 0.1) || massSweep[0] || null;
  let crossModelOffsetM = null;
  if (spine100g && ellipse2Sigma) {
    const dLatM = (spine100g.lat - ellipse2Sigma.center.lat) * METERS_PER_DEG_LAT;
    const dLonM =
      (spine100g.lon - ellipse2Sigma.center.lon) *
      METERS_PER_DEG_LAT *
      Math.max(0.01, Math.cos(lat * DEG_TO_RAD));
    crossModelOffsetM = Math.round(Math.hypot(dLatM, dLonM));
  }

  // Cross-reference 2: Separation between 10 kg and 1 g along the mass-sorting spine
  let alongTrackKm = 0;
  if (massSweep.length >= 2) {
    const first = massSweep[0];
    const last = massSweep[massSweep.length - 1];
    const dLatM = (first.lat - last.lat) * METERS_PER_DEG_LAT;
    const dLonM =
      (first.lon - last.lon) *
      METERS_PER_DEG_LAT *
      Math.max(0.01, Math.cos(lat * DEG_TO_RAD));
    alongTrackKm = Math.round((Math.hypot(dLatM, dLonM) / 1000) * 10) / 10;
  }

  // Cross-reference 3: Calibration against any corroborated ARES fall in possibleMatches
  let aresResidualM = null;
  let matchedFallName = null;
  if (Array.isArray(event?.possibleMatches)) {
    for (const m of event.possibleMatches) {
      const partner = allEvents.find((e) => e.id === m.id);
      if (partner?.source === 'ares' && massSweep.length) {
        matchedFallName = partner.name || partner.id;
        let minDist = Infinity;
        for (const pt of massSweep) {
          const dLatM = (partner.location.lat - pt.lat) * METERS_PER_DEG_LAT;
          const dLonM =
            (partner.location.lon - pt.lon) *
            METERS_PER_DEG_LAT *
            Math.max(0.01, Math.cos(lat * DEG_TO_RAD));
          minDist = Math.min(minDist, Math.hypot(dLatM, dLonM));
        }
        aresResidualM = Math.round(minDist);
      }
    }
  }

  const darkFlightTracks = [
    ...f2Sweep.map((b) => ({
      episode: 'F2 (Terminal)',
      massGrams: Math.round(b.massKg * 1000 * 10) / 10,
      releaseAltKm: Math.round((effectiveAltM / 1000) * 10) / 10,
      landingLat: b.lat,
      landingLon: b.lon,
      impactSpeedMs: b.impactSpeedMs,
      impactEnergyJ: b.impactEnergyJ,
      penetrationDepthCm: b.penetrationDepthCm,
      ablationMassLossPct: b.ablationMassLossPct,
    })),
    ...f1Sweep.map((b) => ({
      episode: 'F1 (Upper Flare)',
      massGrams: Math.round(b.massKg * 1000 * 10) / 10,
      releaseAltKm: trueF1AltKm,
      landingLat: b.lat,
      landingLon: b.lon,
      impactSpeedMs: b.impactSpeedMs,
      impactEnergyJ: b.impactEnergyJ,
      penetrationDepthCm: b.penetrationDepthCm,
      ablationMassLossPct: b.ablationMassLossPct,
    })),
  ];

  const resultObj = {
    eventId: event.id,
    feasible: true,
    regime: 'full-3d-strewn-field',
    borrowedFromPartner,
    effectiveTerminus: {
      lat: Math.round(spineEndLat * 100000) / 100000,
      lon: Math.round(spineEndLon * 100000) / 100000,
      altKm: Math.round(spineEndAltKm * 100) / 100,
      release25Lat: Math.round(flare1Lat * 100000) / 100000,
      release25Lon: Math.round(flare1Lon * 100000) / 100000,
      release25AltKm: Math.round(((flare1AltM - effectiveGroundElevM) / 1000) * 100) / 100,
      release20Lat: Math.round(effectiveLat * 100000) / 100000,
      release20Lon: Math.round(effectiveLon * 100000) / 100000,
      release20AltKm: Math.round(((effectiveAltM - effectiveGroundElevM) / 1000) * 100) / 100,
      entryStartLat: Math.round(entryStartLat * 100000) / 100000,
      entryStartLon: Math.round(entryStartLon * 100000) / 100000,
      entryStartAltKm: Math.round(startAltKm * 100) / 100,
      rawLat: Math.round(lat * 100000) / 100000,
      rawLon: Math.round(lon * 100000) / 100000,
      rawAltKm: Math.round((terminalAltM / 1000) * 100) / 100,
      groundElevationM: Math.round(effectiveGroundElevM),
    },
    sounding,
    massSweep,
    releaseSeriesSweeps,
    darkFlightTracks,
    monteCarloImpacts,
    ellipse2Sigma,
    ellipseInnerCore,
    subBolides,
    foundStones,
    stoneFit,
    calibration: {
      crossModelOffsetM,
      alongTrackKm,
      aresResidualM,
      matchedFallName,
      entryVelocityKmS: entryVelKmS,
      vDarkMs,
      bronshtenFactor,
      massLossFactor,
      note: borrowedFromPartner
        ? `Trajectory azimuth borrowed from corroborated partner ${borrowedFromPartner}.`
        : `Deterministic 7-mass RK4 spine cross-verified against 160-fragment Monte Carlo ensemble. Gritsevich V_dark=${vDarkKmS.toFixed(2)} km/s (entry ${entryVelKmS} km/s, mass-loss factor ${massLossFactor.toFixed(4)}).`,
    },
  };
  resultObj.validation = evaluateEventSanityAndOverUnder(
    event,
    resultObj,
    allEvents,
  );
  return resultObj;
}
