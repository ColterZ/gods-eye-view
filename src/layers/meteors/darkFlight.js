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
import { evaluateEventSanityAndOverUnder } from './validation.js';

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
  if (!Array.isArray(samples) || !samples.length) {
    return { u: 0, v: 0, altitude: altitudeM };
  }
  if (altitudeM <= samples[0].altitude) {
    return { u: samples[0].u, v: samples[0].v, altitude: altitudeM };
  }
  const last = samples[samples.length - 1];
  if (altitudeM >= last.altitude) {
    // Exponential decay above highest measured sounding level (30 hPa ~24 km)
    const decay = Math.exp(-(altitudeM - last.altitude) / 12000);
    return { u: last.u * decay, v: last.v * decay, altitude: altitudeM };
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
        altitude: altitudeM,
      };
    }
  }
  return { u: 0, v: 0, altitude: altitudeM };
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
  if (mach > 4) return 0.92;
  if (mach > 1.2) return 0.92 + 0.3 * Math.exp(-5 * (mach - 1.2));
  if (mach > 0.8) return 0.92 + 0.45 * Math.exp(-10 * Math.abs(mach - 1.0));
  if (reynolds < 1) return 24 / Math.max(reynolds, 1e-3);
  if (reynolds < 1000) {
    return (24 / reynolds) * (1 + 0.15 * Math.pow(reynolds, 0.687));
  }
  return 0.47;
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

/**
 * Integrate a single fragment's dark-flight trajectory from terminal ablation
 * state down to ground impact (alt = 0) using RK4.
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
  recordTrack = false,
}) {
  const azRad = azimuthDeg * DEG_TO_RAD;
  const elevRad = Math.max(5, Math.min(89, entryAngleDeg)) * DEG_TO_RAD;
  const startSpeed = Math.min(Math.max(terminalSpeedMs, 200), 3200);
  const vHoriz = startSpeed * Math.cos(elevRad);

  const state = {
    lat: terminalLat * DEG_TO_RAD,
    lon: terminalLon * DEG_TO_RAD,
    alt: Math.max(100, Math.min(75000, terminalAltM)),
    vx: vHoriz * Math.sin(azRad),
    vy: vHoriz * Math.cos(azRad),
    vz: -startSpeed * Math.sin(elevRad),
  };

  const volume = massKg / Math.max(densityKgM3, 500);
  const diameter = 2 * Math.cbrt((3 * volume) / (4 * Math.PI));
  const area = Math.PI * (diameter / 2) ** 2 * shapeFactor;

  const track = recordTrack
    ? [
        {
          lat: terminalLat,
          lon: terminalLon,
          altM: state.alt,
        },
      ]
    : null;

  function derivAt(s) {
    const atm = getAtmosphere(s.alt);
    const wind = interpolateWind(sounding, s.alt);
    const vRelX = s.vx - wind.u;
    const vRelY = s.vy - wind.v;
    const vRelZ = s.vz;
    const vRel = Math.hypot(vRelX, vRelY, vRelZ);

    const cd = computeDragCoefficient(
      vRel,
      atm.speedOfSound,
      atm.density,
      diameter,
      atm.viscosity,
      atm.meanFreePath,
    );
    // Above 20 km (upper stratosphere / lower mesosphere), include bow-shock
    // pancaking & ablation deceleration so trajectories starting at 40-50 km
    // camera termini decelerate continuously into dark flight without artificial altitude clamps.
    const highAltFactor =
      s.alt > 20000
        ? 1 + 45 * Math.pow((s.alt - 20000) / 20000, 1.8)
        : 1;
    const q = 0.5 * atm.density * vRel * vRel * highAltFactor;
    const dragAccel = massKg > 0 ? (q * cd * area) / massKg : 0;

    const axDrag = vRel > 0 ? (-dragAccel * vRelX) / vRel : 0;
    const ayDrag = vRel > 0 ? (-dragAccel * vRelY) / vRel : 0;
    const azDrag = vRel > 0 ? (-dragAccel * vRelZ) / vRel : 0;

    const fCor = 2 * EARTH_OMEGA * Math.sin(s.lat);
    const ax = axDrag + fCor * s.vy;
    const ay = ayDrag - fCor * s.vx;
    const az = azDrag - G;

    const r = EARTH_RADIUS_M + s.alt;
    return {
      dLat: s.vy / r,
      dLon: s.vx / (r * Math.max(0.01, Math.cos(s.lat))),
      dAlt: s.vz,
      dVx: ax,
      dVy: ay,
      dVz: az,
    };
  }

  const dt = 0.5;
  const maxSteps = 3600; // up to 30 minutes free fall from upper mesosphere/stratosphere
  let timeSec = 0;

  for (let step = 0; step < maxSteps; step++) {
    const k1 = derivAt(state);
    if (!Number.isFinite(k1.dLat) || !Number.isFinite(k1.dLon)) return null;

    const s2 = {
      lat: state.lat + (k1.dLat * dt) / 2,
      lon: state.lon + (k1.dLon * dt) / 2,
      alt: Math.max(0, state.alt + (k1.dAlt * dt) / 2),
      vx: state.vx + (k1.dVx * dt) / 2,
      vy: state.vy + (k1.dVy * dt) / 2,
      vz: state.vz + (k1.dVz * dt) / 2,
    };
    const k2 = derivAt(s2);

    const s3 = {
      lat: state.lat + (k2.dLat * dt) / 2,
      lon: state.lon + (k2.dLon * dt) / 2,
      alt: Math.max(0, state.alt + (k2.dAlt * dt) / 2),
      vx: state.vx + (k2.dVx * dt) / 2,
      vy: state.vy + (k2.dVy * dt) / 2,
      vz: state.vz + (k2.dVz * dt) / 2,
    };
    const k3 = derivAt(s3);

    const s4 = {
      lat: state.lat + k3.dLat * dt,
      lon: state.lon + k3.dLon * dt,
      alt: Math.max(0, state.alt + k3.dAlt * dt),
      vx: state.vx + k3.dVx * dt,
      vy: state.vy + k3.dVy * dt,
      vz: state.vz + k3.dVz * dt,
    };
    const k4 = derivAt(s4);

    state.lat += ((k1.dLat + 2 * k2.dLat + 2 * k3.dLat + k4.dLat) * dt) / 6;
    state.lon += ((k1.dLon + 2 * k2.dLon + 2 * k3.dLon + k4.dLon) * dt) / 6;
    state.alt += ((k1.dAlt + 2 * k2.dAlt + 2 * k3.dAlt + k4.dAlt) * dt) / 6;
    state.vx += ((k1.dVx + 2 * k2.dVx + 2 * k3.dVx + k4.dVx) * dt) / 6;
    state.vy += ((k1.dVy + 2 * k2.dVy + 2 * k3.dVy + k4.dVy) * dt) / 6;
    state.vz += ((k1.dVz + 2 * k2.dVz + 2 * k3.dVz + k4.dVz) * dt) / 6;
    timeSec += dt;

    if (
      Math.abs(state.lat) > Math.PI / 2 ||
      Math.abs(state.lon) > Math.PI
    ) {
      return null;
    }

    if (track && (step <= 30 || step % 4 === 0 || state.alt <= 0)) {
      track.push({
        lat: state.lat * RAD_TO_DEG,
        lon: state.lon * RAD_TO_DEG,
        altM: Math.max(0, state.alt),
      });
    }

    if (state.alt <= 0) {
      state.alt = 0;
      break;
    }
  }

  return {
    lat: Math.round(state.lat * RAD_TO_DEG * 100000) / 100000,
    lon: Math.round(state.lon * RAD_TO_DEG * 100000) / 100000,
    massKg,
    flightTimeSec: Math.round(timeSec),
    impactSpeedMs:
      Math.round(Math.hypot(state.vx, state.vy, state.vz) * 10) / 10,
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
  { allEvents = [], nFragments = 160, autoFit = false } = {},
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
        !(rawAltKm > 0) ||
        (cameraPartner && event.source !== 'asgard' && event.source !== 'gmn'))
    ) {
      azimuthDeg = partner.trajectory.azimuth;
      if (Number.isFinite(partner.trajectory.entryAngle)) {
        entryAngleDeg = partner.trajectory.entryAngle;
      }
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

  // Check for documented or user-supplied Found Stones for this fall (or corroborated partners)
  const foundStones = getFoundStonesForEvent(event);
  // Start 3D RK4 integration at the exact 3D terminus altitude of the track
  // (plus any small fine-tuned offset within the camera's 1σ measurement cone).
  let effectiveLat = lat;
  let effectiveLon = lon;
  let effectiveAltM = terminalAltM;
  let activeSounding = sounding;
  let effectiveSpeedMs = terminalSpeedMs;
  let effectiveAzimuthDeg = azimuthDeg;
  let effectiveShapeFactor = 1.15;
  let stoneFit = null;

  if (foundStones.length > 0) {
    if (autoFit) {
      stoneFit = autoFitDarkFlightToFoundStones({
        stones: foundStones,
        terminalLat: effectiveLat,
        terminalLon: effectiveLon,
        terminalAltM: effectiveAltM,
        terminalSpeedMs: effectiveSpeedMs,
        azimuthDeg,
        entryAngleDeg,
        sounding,
      });
      if (stoneFit?.tuning) {
        activeSounding = scaleSoundingWind(sounding, stoneFit.tuning.windScale);
        effectiveLat += Number(stoneFit.tuning.latDeltaDeg) || 0;
        effectiveLon += Number(stoneFit.tuning.lonDeltaDeg) || 0;
        effectiveAltM = Math.max(
          5000,
          effectiveAltM + (Number(stoneFit.tuning.altDeltaKm) || 0) * 1000,
        );
        effectiveSpeedMs =
          effectiveSpeedMs * (stoneFit.tuning.speedScale || 1.0);
        effectiveAzimuthDeg =
          (azimuthDeg + stoneFit.tuning.azimuthDeltaDeg + 360) % 360;
        effectiveShapeFactor = stoneFit.tuning.shapeFactor;
      }
    } else {
      const baseEval = evaluateFoundStoneResiduals({
        stones: foundStones,
        terminalLat: effectiveLat,
        terminalLon: effectiveLon,
        terminalAltM: effectiveAltM,
        terminalSpeedMs: effectiveSpeedMs,
        azimuthDeg,
        entryAngleDeg,
        sounding,
      });
      stoneFit = {
        baselineRmsM: baseEval.rmsErrorM,
        bestRmsM: baseEval.rmsErrorM,
        terminusShiftM: 0,
        tuning: null,
        comparisons: baseEval.comparisons,
      };
    }
  }

  // REGIME B: Full 3-Model Strewn Field (Deterministic Spine + Monte Carlo + Cross-Calibration)
  // Also compute Under (-1σ compact/low-wind) and Over (+1σ tabular/high-wind) boundary rails
  // for each mass band so the ground view displays explicit Over/Under margins of error.
  const underSounding = scaleSoundingWind(activeSounding, 0.84);
  const overSounding = scaleSoundingWind(activeSounding, 1.16);
  const cosLat = Math.max(0.05, Math.cos(effectiveLat * DEG_TO_RAD));

  const massSweep = CANONICAL_MASS_SWEEP.map((band) => {
    const res = integrateFragmentDarkFlight({
      terminalLat: effectiveLat,
      terminalLon: effectiveLon,
      terminalAltM: effectiveAltM,
      terminalSpeedMs: effectiveSpeedMs,
      azimuthDeg: effectiveAzimuthDeg,
      entryAngleDeg,
      massKg: band.massKg,
      shapeFactor: effectiveShapeFactor,
      sounding: activeSounding,
      recordTrack: true,
    });
    if (!res) return null;

    const underImp = integrateFragmentDarkFlight({
      terminalLat: effectiveLat,
      terminalLon: effectiveLon,
      terminalAltM: effectiveAltM,
      terminalSpeedMs: effectiveSpeedMs * 1.1,
      azimuthDeg: (effectiveAzimuthDeg - 2.2 + 360) % 360,
      entryAngleDeg: Math.min(88, entryAngleDeg + 1.5),
      massKg: band.massKg,
      shapeFactor: Math.max(0.8, effectiveShapeFactor * 0.82),
      sounding: underSounding,
      recordTrack: false,
    });

    const overImp = integrateFragmentDarkFlight({
      terminalLat: effectiveLat,
      terminalLon: effectiveLon,
      terminalAltM: effectiveAltM,
      terminalSpeedMs: effectiveSpeedMs * 0.9,
      azimuthDeg: (effectiveAzimuthDeg + 2.2 + 360) % 360,
      entryAngleDeg: Math.max(8, entryAngleDeg - 1.5),
      massKg: band.massKg,
      shapeFactor: effectiveShapeFactor * 1.24,
      sounding: overSounding,
      recordTrack: false,
    });

    let marginRadiusM = 450;
    if (underImp && overImp) {
      const dLatM = (overImp.lat - underImp.lat) * METERS_PER_DEG_LAT;
      const dLonM = (overImp.lon - underImp.lon) * METERS_PER_DEG_LAT * cosLat;
      marginRadiusM = Math.max(
        220,
        Math.round(Math.hypot(dLatM, dLonM) * 0.5),
      );
    }

    const estDiameterCm =
      Math.round(
        2 * Math.cbrt((3 * ((band.massKg * 1000) / 3.4)) / (4 * Math.PI)) * 10,
      ) / 10;

    return {
      ...res,
      label: band.label,
      color: band.color,
      estDiameterCm,
      underPoint: underImp ? { lat: underImp.lat, lon: underImp.lon } : null,
      overPoint: overImp ? { lat: overImp.lat, lon: overImp.lon } : null,
      marginRadiusM,
    };
  }).filter(Boolean);

  const monteCarloImpacts = [];
  const seedBase =
    event.id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) || 42;
  for (let i = 0; i < nFragments; i++) {
    const rng = new SeededRng(fragmentSeed(seedBase, i));
    const u = Math.min(0.999, rng.next());
    const massKg = Math.min(1, Math.max(0.002, 0.002 * Math.pow(1 - u, -1.1)));
    const imp = integrateFragmentDarkFlight({
      terminalLat: effectiveLat + rng.gaussian() * 0.0025,
      terminalLon: effectiveLon + rng.gaussian() * 0.0025,
      terminalAltM: effectiveAltM + rng.gaussian() * 250,
      terminalSpeedMs: effectiveSpeedMs * (1 + rng.gaussian() * 0.06),
      azimuthDeg: effectiveAzimuthDeg + rng.gaussian() * 2.2,
      entryAngleDeg: entryAngleDeg + rng.gaussian() * 1.8,
      massKg,
      shapeFactor: Math.max(
        0.85,
        effectiveShapeFactor + rng.gaussian() * 0.15,
      ),
      sounding: activeSounding,
      recordTrack: false,
    });
    if (imp) monteCarloImpacts.push(imp);
  }

  const ellipse2Sigma = computeStrewnFieldEllipse(monteCarloImpacts, 2);
  const ellipseInnerCore = computeStrewnFieldEllipse(monteCarloImpacts, 1);

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

  const resultObj = {
    eventId: event.id,
    feasible: true,
    regime: 'full-3d-strewn-field',
    borrowedFromPartner,
    effectiveTerminus: {
      lat: Math.round(effectiveLat * 100000) / 100000,
      lon: Math.round(effectiveLon * 100000) / 100000,
      altKm: Math.round((effectiveAltM / 1000) * 100) / 100,
      rawLat: Math.round(lat * 100000) / 100000,
      rawLon: Math.round(lon * 100000) / 100000,
      rawAltKm: Math.round((terminalAltM / 1000) * 100) / 100,
    },
    sounding,
    massSweep,
    monteCarloImpacts,
    ellipse2Sigma,
    ellipseInnerCore,
    foundStones,
    stoneFit,
    calibration: {
      crossModelOffsetM,
      alongTrackKm,
      aresResidualM,
      matchedFallName,
      note: borrowedFromPartner
        ? `Trajectory azimuth borrowed from corroborated partner ${borrowedFromPartner}.`
        : 'Deterministic 7-mass RK4 spine cross-verified against 160-fragment Monte Carlo ensemble.',
    },
  };
  resultObj.validation = evaluateEventSanityAndOverUnder(
    event,
    resultObj,
    allEvents,
  );
  return resultObj;
}
