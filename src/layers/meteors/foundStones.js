/**
 * Found Stone Map & Fall Fine-Tuning / Calibration Engine
 *
 * Stores documented recovered meteorite fragments per fall event, accepts
 * user-supplied found stone maps (JSON/CSV/array via control params or
 * global hook), and computes per-stone RK4 mass-matched residual vectors
 * plus automated parameter fine-tuning (windScale, shapeFactor, terminalAltDeltaKm,
 * azimuthDeltaDeg) to troubleshoot and fit dark-flight trajectories against
 * real ground truth.
 */

import { integrateFragmentDarkFlight } from './darkFlight.js';

const METERS_PER_DEG_LAT = 111320;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Curated documented recovered fragments for major NASA ARES / ASGARD / CNEOS falls.
 * Users can also inject or override stones for any event at runtime.
 */
export const DOCUMENTED_FOUND_STONES = Object.freeze({
  'ares:sims-corner-wa': Object.freeze([
    Object.freeze({
      id: 'stone:sims-kidd-81g',
      label: '81g - The Kidd',
      lat: 47.88486,
      lon: -119.35886,
      massGrams: 81.0,
      densityGcm3: 3.35,
      type: 'Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Upper red circle at NE corner of blue radar gate polygon (east of WA-17)',
    }),
    Object.freeze({
      id: 'stone:sims-joseph-48g',
      label: '48.5g - Joseph',
      lat: 47.86534,
      lon: -119.35832,
      massGrams: 48.5,
      densityGcm3: 3.35,
      type: 'Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Lower red circle east of blue radar gate polygon & WA-17',
    }),
    Object.freeze({
      id: 'stone:sims-anton-46g',
      label: '46.6g - Anton',
      lat: 47.87215,
      lon: -119.37122,
      massGrams: 46.6,
      densityGcm3: 3.35,
      type: 'Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Recovered along WA-17 just south of Stacked Rocks & 100g model pin',
    }),
    Object.freeze({
      id: 'stone:sims-roberto-21g',
      label: '21.5g - Roberto',
      lat: 47.85172,
      lon: -119.3619,
      massGrams: 21.5,
      densityGcm3: 3.35,
      type: 'Ordinary Chondrite',
      shape: 'fragment',
      notes: 'Southern WA-17 cluster just north of 30g green model pin',
    }),
    Object.freeze({
      id: 'stone:sims-roberto-16g',
      label: '16.3g - Roberto',
      lat: 47.85381,
      lon: -119.36262,
      massGrams: 16.3,
      densityGcm3: 3.35,
      type: 'Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Southern WA-17 cluster near 10g orange model pin',
    }),
    Object.freeze({
      id: 'stone:sims-anton-10g',
      label: '10.2g - Anton',
      lat: 47.85342,
      lon: -119.36137,
      massGrams: 10.2,
      densityGcm3: 3.35,
      type: 'Ordinary Chondrite',
      shape: 'fragment',
      notes: 'Southern WA-17 bend adjacent to 16.3g - Roberto',
    }),
  ]),
  'ares:hopewell-nj': Object.freeze([
    Object.freeze({
      id: 'stone:hopewell-1',
      label: 'Titusville Structure Hit (984g H6)',
      lat: 40.3834,
      lon: -74.7938,
      massGrams: 984,
      densityGcm3: 3.42,
      type: 'H6 Chondrite',
      shape: 'subrounded',
      notes: 'Documented Hopewell Township recovery (15×10×10 cm)',
    }),
  ]),
  'ares:henry-county-ga': Object.freeze([
    Object.freeze({
      id: 'stone:mcdonough-1',
      label: 'McDonough Main Mass',
      lat: 33.4215,
      lon: -84.1422,
      massGrams: 480,
      densityGcm3: 3.38,
      type: 'Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Daytime bolide recovery',
    }),
    Object.freeze({
      id: 'stone:mcdonough-2',
      label: 'McDonough Fragment #2',
      lat: 33.4148,
      lon: -84.1391,
      massGrams: 62,
      densityGcm3: 3.38,
      type: 'Ordinary Chondrite',
      shape: 'fragment',
      notes: 'Down-track recovery',
    }),
  ]),
  'ares:cranfield-ms': Object.freeze([
    Object.freeze({
      id: 'stone:cranfield-1',
      label: 'Cranfield Recovery #1',
      lat: 31.5642,
      lon: -91.2115,
      massGrams: 215,
      densityGcm3: 3.32,
      type: 'Chondrite',
      shape: 'subangular',
      notes: 'Recovered along radar-derived strewn field',
    }),
  ]),
});

const customStonesByEventId = new Map();

/**
 * Register or replace custom found stones for an eventId (supports fine-tuning
 * from user-provided stone maps).
 */
export function setCustomFoundStones(eventId, stones) {
  if (!eventId || !Array.isArray(stones)) return [];
  const normalized = stones
    .map((s, idx) => {
      const lat = Number(s.lat ?? s.latitude);
      const lon = Number(s.lon ?? s.longitude);
      const massGrams = Number(s.massGrams ?? s.mass ?? 100);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(massGrams > 0)) {
        return null;
      }
      return {
        id: s.id || `custom:${eventId}:${idx + 1}`,
        label: s.label || s.name || `Found Stone #${idx + 1} (${massGrams}g)`,
        lat,
        lon,
        massGrams,
        densityGcm3: Number(s.densityGcm3 ?? s.density) || 3.35,
        type: s.type || 'Chondrite',
        shape: s.shape || 'subangular',
        notes: s.notes || 'User-supplied found stone coordinate',
      };
    })
    .filter(Boolean);
  customStonesByEventId.set(eventId, normalized);
  return normalized;
}

/**
 * Look up found stones for an event or any of its corroborated partner records.
 */
export function getFoundStonesForEvent(event) {
  if (!event) return [];
  if (customStonesByEventId.has(event.id)) {
    return customStonesByEventId.get(event.id);
  }
  if (DOCUMENTED_FOUND_STONES[event.id]) {
    return DOCUMENTED_FOUND_STONES[event.id];
  }
  if (Array.isArray(event.possibleMatches)) {
    for (const m of event.possibleMatches) {
      if (customStonesByEventId.has(m.id)) {
        return customStonesByEventId.get(m.id);
      }
      if (DOCUMENTED_FOUND_STONES[m.id]) {
        return DOCUMENTED_FOUND_STONES[m.id];
      }
    }
  }
  return [];
}

/**
 * Scale wind velocity components in a sounding by `windScale`.
 */
export function scaleSoundingWind(sounding, windScale = 1.0) {
  if (!sounding || !Array.isArray(sounding.samples) || windScale === 1.0) {
    return sounding;
  }
  return {
    ...sounding,
    samples: sounding.samples.map((s) => ({
      ...s,
      speedMs: s.speedMs * windScale,
      u: s.u * windScale,
      v: s.v * windScale,
    })),
  };
}

/**
 * Evaluate per-stone mass-matched RK4 simulated impacts against actual found stone
 * coordinates and compute spatial residuals (meters and bearing).
 */
export function evaluateFoundStoneResiduals({
  stones,
  terminalLat,
  terminalLon,
  terminalAltM,
  terminalSpeedMs = 2400,
  azimuthDeg,
  entryAngleDeg,
  sounding,
  tuning = {},
}) {
  if (!Array.isArray(stones) || !stones.length || !Number.isFinite(azimuthDeg)) {
    return { comparisons: [], rmsErrorM: null, meanBiasM: null };
  }

  const windScale = Number.isFinite(tuning.windScale) ? tuning.windScale : 1.0;
  const shapeFactor = Number.isFinite(tuning.shapeFactor)
    ? tuning.shapeFactor
    : 1.15;
  const altDeltaM = (Number(tuning.altDeltaKm) || 0) * 1000;
  const azDelta = Number(tuning.azimuthDeltaDeg) || 0;
  const speedScale = Number.isFinite(tuning.speedScale)
    ? tuning.speedScale
    : 1.0;
  const scaledSounding = scaleSoundingWind(sounding, windScale);

  const comparisons = [];
  let sumSq = 0;
  let sumDist = 0;

  for (const stone of stones) {
    const massKg = Math.max(0.0005, stone.massGrams / 1000);
    const densityKgM3 = (stone.densityGcm3 || 3.35) * 1000;
    const sim = integrateFragmentDarkFlight({
      terminalLat,
      terminalLon,
      terminalAltM: Math.max(5000, terminalAltM + altDeltaM),
      terminalSpeedMs: terminalSpeedMs * speedScale,
      azimuthDeg: (azimuthDeg + azDelta + 360) % 360,
      entryAngleDeg,
      massKg,
      densityKgM3,
      shapeFactor,
      sounding: scaledSounding,
      recordTrack: true,
    });
    if (!sim) continue;

    const dLatM = (stone.lat - sim.lat) * METERS_PER_DEG_LAT;
    const dLonM =
      (stone.lon - sim.lon) *
      METERS_PER_DEG_LAT *
      Math.max(0.01, Math.cos(stone.lat * DEG_TO_RAD));
    const errorM = Math.round(Math.hypot(dLatM, dLonM));
    const bearingDeg = Math.round(
      (((Math.atan2(dLonM, dLatM) * 180) / Math.PI) % 360 + 360) % 360,
    );

    sumSq += errorM * errorM;
    sumDist += errorM;
    comparisons.push({
      stone,
      simulated: sim,
      errorM,
      bearingDeg,
    });
  }

  const n = comparisons.length;
  return {
    comparisons,
    rmsErrorM: n > 0 ? Math.round(Math.sqrt(sumSq / n)) : null,
    meanBiasM: n > 0 ? Math.round(sumDist / n) : null,
  };
}

/**
 * Grid-search fine-tuning solver: finds (windScale, shapeFactor, altDeltaKm, azimuthDeltaDeg)
 * that minimizes the RMS spatial residual between simulated mass-matched impacts and
 * actual recovered stones.
 */
export function autoFitDarkFlightToFoundStones({
  stones,
  terminalLat,
  terminalLon,
  terminalAltM,
  terminalSpeedMs = 2400,
  azimuthDeg,
  entryAngleDeg,
  sounding,
}) {
  const baseline = evaluateFoundStoneResiduals({
    stones,
    terminalLat,
    terminalLon,
    terminalAltM,
    terminalSpeedMs,
    azimuthDeg,
    entryAngleDeg,
    sounding,
    tuning: { windScale: 1.0, shapeFactor: 1.15, altDeltaKm: 0, azimuthDeltaDeg: 0 },
  });
  if (!baseline.comparisons.length) return null;

  let bestTuning = {
    windScale: 1.0,
    shapeFactor: 1.15,
    altDeltaKm: 0,
    azimuthDeltaDeg: 0,
  };
  let bestEval = baseline;

  const windScales = [0.7, 1.0, 1.4];
  const shapeFactors = [0.9, 1.15, 1.45];
  const altDeltas = [0]; // Keep 3D start anchored at exact camera/sensor terminus altitude
  const azDeltas = [-8, -4, 0, 4, 8];
  const speedScales = [0.35, 0.55, 0.8, 1.0, 1.25];

  for (const windScale of windScales) {
    for (const shapeFactor of shapeFactors) {
      for (const altDeltaKm of altDeltas) {
        for (const azimuthDeltaDeg of azDeltas) {
          for (const speedScale of speedScales) {
            const tuning = {
              windScale,
              shapeFactor,
              altDeltaKm,
              azimuthDeltaDeg,
              speedScale,
            };
            const res = evaluateFoundStoneResiduals({
              stones,
              terminalLat,
              terminalLon,
              terminalAltM,
              terminalSpeedMs,
              azimuthDeg,
              entryAngleDeg,
              sounding,
              tuning,
            });
            if (
              res.rmsErrorM !== null &&
              (bestEval.rmsErrorM === null ||
                res.rmsErrorM < bestEval.rmsErrorM)
            ) {
              bestEval = res;
              bestTuning = tuning;
            }
          }
        }
      }
    }
  }

  return {
    baselineRmsM: baseline.rmsErrorM,
    bestRmsM: bestEval.rmsErrorM,
    tuning: bestTuning,
    comparisons: bestEval.comparisons,
  };
}
