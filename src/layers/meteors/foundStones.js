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
      label: '81g - Derek',
      lat: 47.861986,
      lon: -119.360967,
      massGrams: 81.0,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'subangular',
      notes: 'Sims Corner find #9: 81g by Derek Fischer (10/11/2026) along Radar1 100g boundary',
    }),
    Object.freeze({
      id: 'stone:sims-derek-55g',
      label: '55.2g - Derek',
      lat: 47.863633,
      lon: -119.360475,
      massGrams: 55.2,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'subangular',
      notes: 'Sims Corner find #7: 55.2g by Derek Fischer (10/4/2026)',
    }),
    Object.freeze({
      id: 'stone:sims-joseph-48g',
      label: '48.5g - Joseph',
      lat: 47.876667,
      lon: -119.369944,
      massGrams: 48.5,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'subangular',
      notes: 'Sims Corner find #8: 48.5g by Joseph Walls (10/8/2026, northernmost 20km-release cluster)',
    }),
    Object.freeze({
      id: 'stone:sims-anton-46g',
      label: '46.6g - Anton',
      lat: 47.870867,
      lon: -119.370783,
      massGrams: 46.6,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'subangular',
      notes: 'Sims Corner first find: 46.6g by Anton Clemens (9/1/2026, just south of Stacked Rocks)',
    }),
    Object.freeze({
      id: 'stone:sims-anton-40g',
      label: '40.3g - Anton',
      lat: 47.857067,
      lon: -119.36235,
      massGrams: 40.3,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'subangular',
      notes: 'Sims Corner find #2: 40.3g by Anton Clemens (9/3/2026)',
    }),
    Object.freeze({
      id: 'stone:sims-derek-25g',
      label: '25g - Derek',
      lat: 47.857694,
      lon: -119.36055,
      massGrams: 25.0,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'subangular',
      notes: 'Sims Corner find #10: 25g by Derek Fischer (10/11/2026)',
    }),
    Object.freeze({
      id: 'stone:sims-roberto-21g',
      label: '21.5g - Roberto',
      lat: 47.855772,
      lon: -119.362419,
      massGrams: 21.5,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'fragment',
      notes: 'Sims Corner find #4: 21.5g by Roberto Vargas (9/14/2026)',
    }),
    Object.freeze({
      id: 'stone:sims-derek-20g',
      label: '20.5g - Derek',
      lat: 47.854047,
      lon: -119.362369,
      massGrams: 20.5,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'fragment',
      notes: 'Sims Corner find #6: 20.5g by Derek Fischer (9/29/2026)',
    }),
    Object.freeze({
      id: 'stone:sims-derek-18g',
      label: '18.6g - Derek',
      lat: 47.876897,
      lon: -119.374121,
      massGrams: 18.6,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'subrounded',
      notes: 'Sims Corner find #11: 18.6g by Derek Fischer (10/17/2026, northernmost 20km-release cluster)',
    }),
    Object.freeze({
      id: 'stone:sims-roberto-16g',
      label: '16.3g - Roberto',
      lat: 47.857458,
      lon: -119.363203,
      massGrams: 16.3,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'subangular',
      notes: 'Sims Corner find #5: 16.3g by Roberto Vargas (9/15/2026)',
    }),
    Object.freeze({
      id: 'stone:sims-anton-9g',
      label: '9.2g - Anton',
      lat: 47.852311,
      lon: -119.359115,
      massGrams: 9.2,
      densityGcm3: 3.65,
      type: 'Ordinary Chondrite (H)',
      shape: 'fragment',
      notes: 'Sims Corner find #3: 9.2g by Anton Clemens (9/3/2026, southernmost find near Red Barn)',
    }),
  ]),
  'ares:hopewell-nj': Object.freeze([
    Object.freeze({
      id: 'stone:hopewell-1',
      label: 'Titusville Structure Hit (984g H6)',
      lat: 40.3935,
      lon: -74.7968,
      massGrams: 984,
      densityGcm3: 3.42,
      type: 'H6 Chondrite',
      shape: 'subrounded',
      notes: 'Documented Hopewell Township roof impact (15×10×10 cm main mass)',
    }),
    Object.freeze({
      id: 'stone:hopewell-2',
      label: 'Hopewell Mid-Field (142g H6)',
      lat: 40.3648,
      lon: -74.7858,
      massGrams: 142,
      densityGcm3: 3.42,
      type: 'H6 Chondrite',
      shape: 'subangular',
      notes: 'Mid-field H6 recovery along 18° NNE track',
    }),
    Object.freeze({
      id: 'stone:hopewell-3',
      label: 'Washington Crossing Up-Track (38g H6)',
      lat: 40.3448,
      lon: -74.7745,
      massGrams: 38,
      densityGcm3: 3.42,
      type: 'H6 Chondrite',
      shape: 'fragment',
      notes: 'Up-track wind-drifted small fragment',
    }),
  ]),
  'ares:mcdonough-ga': Object.freeze([
    Object.freeze({
      id: 'stone:mcdonough-1',
      label: 'McDonough Main Mass (480g L6)',
      lat: 33.4116,
      lon: -84.1225,
      massGrams: 480,
      densityGcm3: 3.38,
      type: 'L6 Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Down-track SE main mass recovery in Henry County, GA',
    }),
    Object.freeze({
      id: 'stone:mcdonough-2',
      label: 'McDonough Fragment #2 (215g L6)',
      lat: 33.4171,
      lon: -84.1326,
      massGrams: 215,
      densityGcm3: 3.38,
      type: 'L6 Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Mid-heavy strewn field recovery',
    }),
    Object.freeze({
      id: 'stone:mcdonough-3',
      label: 'McDonough Fragment #3 (118g L6)',
      lat: 33.4207,
      lon: -84.1402,
      massGrams: 118,
      densityGcm3: 3.38,
      type: 'L6 Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Central KFFC radar centroid recovery',
    }),
    Object.freeze({
      id: 'stone:mcdonough-4',
      label: 'McDonough Fragment #4 (62g L6)',
      lat: 33.4241,
      lon: -84.1483,
      massGrams: 62,
      densityGcm3: 3.38,
      type: 'L6 Ordinary Chondrite',
      shape: 'fragment',
      notes: 'Up-track NW fragment recovery',
    }),
    Object.freeze({
      id: 'stone:mcdonough-5',
      label: 'McDonough Fragment #5 (24g L6)',
      lat: 33.4281,
      lon: -84.1601,
      massGrams: 24,
      densityGcm3: 3.38,
      type: 'L6 Ordinary Chondrite',
      shape: 'fragment',
      notes: 'High-retardation small fragment at NW head of strewn field',
    }),
  ]),
  'ares:henry-county-ga': Object.freeze([
    Object.freeze({
      id: 'stone:mcdonough-1',
      label: 'McDonough Main Mass (480g L6)',
      lat: 33.4116,
      lon: -84.1225,
      massGrams: 480,
      densityGcm3: 3.38,
      type: 'L6 Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Down-track SE main mass recovery in Henry County, GA',
    }),
    Object.freeze({
      id: 'stone:mcdonough-4',
      label: 'McDonough Fragment #4 (62g L6)',
      lat: 33.4241,
      lon: -84.1483,
      massGrams: 62,
      densityGcm3: 3.38,
      type: 'L6 Ordinary Chondrite',
      shape: 'fragment',
      notes: 'Up-track NW fragment recovery',
    }),
  ]),
  'ares:amo-in': Object.freeze([
    Object.freeze({
      id: 'stone:amo-1',
      label: 'Amo Main Mass (188g H5)',
      lat: 39.8061,
      lon: -86.6758,
      massGrams: 188,
      densityGcm3: 3.65,
      type: 'H5 Chondrite',
      shape: 'subangular',
      notes: 'Hendricks County main mass recovery',
    }),
    Object.freeze({
      id: 'stone:amo-2',
      label: 'Amo Fragment #2 (94g H5)',
      lat: 39.8066,
      lon: -86.6749,
      massGrams: 94,
      densityGcm3: 3.65,
      type: 'H5 Chondrite',
      shape: 'subangular',
      notes: 'Mid-field H5 chondrite recovery',
    }),
    Object.freeze({
      id: 'stone:amo-3',
      label: 'Amo Fragment #3 (42g H5)',
      lat: 39.808,
      lon: -86.6711,
      massGrams: 42,
      densityGcm3: 3.65,
      type: 'H5 Chondrite',
      shape: 'fragment',
      notes: 'KIND radar signature core recovery',
    }),
    Object.freeze({
      id: 'stone:amo-4',
      label: 'Amo Fragment #4 (14g H5)',
      lat: 39.8115,
      lon: -86.6608,
      massGrams: 14,
      densityGcm3: 3.65,
      type: 'H5 Chondrite',
      shape: 'fragment',
      notes: 'Wind-drifted light fragment',
    }),
  ]),
  'ares:wadsworth-oh': Object.freeze([
    Object.freeze({
      id: 'stone:wadsworth-1',
      label: 'Wadsworth Main Mass (640g OC)',
      lat: 41.0236,
      lon: -81.7275,
      massGrams: 640,
      densityGcm3: 3.55,
      type: 'Ordinary Chondrite',
      shape: 'subrounded',
      notes: 'Down-track ESE main mass west of Cleveland, OH',
    }),
    Object.freeze({
      id: 'stone:wadsworth-2',
      label: 'Wadsworth Fragment #2 (230g OC)',
      lat: 41.0308,
      lon: -81.735,
      massGrams: 230,
      densityGcm3: 3.55,
      type: 'Ordinary Chondrite',
      shape: 'subangular',
      notes: 'Mid-field Medina County recovery',
    }),
    Object.freeze({
      id: 'stone:wadsworth-3',
      label: 'Wadsworth Fragment #3 (85g OC)',
      lat: 41.0376,
      lon: -81.7392,
      massGrams: 85,
      densityGcm3: 3.55,
      type: 'Ordinary Chondrite',
      shape: 'subangular',
      notes: 'KCLE NEXRAD gate core recovery',
    }),
    Object.freeze({
      id: 'stone:wadsworth-4',
      label: 'Wadsworth Fragment #4 (28g OC)',
      lat: 41.0451,
      lon: -81.7401,
      massGrams: 28,
      densityGcm3: 3.55,
      type: 'Ordinary Chondrite',
      shape: 'fragment',
      notes: 'Up-track small fragment recovery',
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
const STORAGE_PREFIX = 'godsEyeView.v1.foundStones.';

function readStoredStones(ownerId) {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${ownerId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredStones(ownerId, stones) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (stones === null) {
      localStorage.removeItem(`${STORAGE_PREFIX}${ownerId}`);
    } else {
      localStorage.setItem(
        `${STORAGE_PREFIX}${ownerId}`,
        JSON.stringify(stones),
      );
    }
  } catch {
    // Ignore storage quota errors in restricted contexts
  }
}

/**
 * Resolve the canonical event ID that owns found stones for an event or its corroborated partners.
 */
export function resolveCanonicalStoneOwnerId(event) {
  if (!event) return null;
  if (typeof event === 'string') return event;
  if (
    customStonesByEventId.has(event.id) ||
    DOCUMENTED_FOUND_STONES[event.id]
  ) {
    return event.id;
  }
  if (Array.isArray(event.possibleMatches)) {
    for (const m of event.possibleMatches) {
      if (customStonesByEventId.has(m.id) || DOCUMENTED_FOUND_STONES[m.id]) {
        return m.id;
      }
    }
  }
  return event.id;
}

/**
 * Register or replace custom found stones for an eventId (supports fine-tuning
 * from user-provided stone maps).
 */
export function setCustomFoundStones(eventOrId, stones) {
  const eventId = resolveCanonicalStoneOwnerId(eventOrId);
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
        type: s.type || 'Ordinary Chondrite',
        shape: s.shape || 'subangular',
        notes: s.notes || 'User-supplied found stone coordinate',
      };
    })
    .filter(Boolean);
  customStonesByEventId.set(eventId, normalized);
  writeStoredStones(eventId, normalized);
  return normalized;
}

/**
 * Look up found stones for an event or any of its corroborated partner records.
 */
export function getFoundStonesForEvent(event) {
  if (!event) return [];
  const ownerId = resolveCanonicalStoneOwnerId(event);
  if (customStonesByEventId.has(ownerId)) {
    return customStonesByEventId.get(ownerId);
  }
  const stored = readStoredStones(ownerId);
  if (stored) {
    customStonesByEventId.set(ownerId, stored);
    return stored;
  }
  if (DOCUMENTED_FOUND_STONES[ownerId]) {
    return DOCUMENTED_FOUND_STONES[ownerId].map((s) => ({ ...s }));
  }
  return [];
}

/**
 * Add a new found stone to an event's recovery list.
 */
export function addFoundStoneForEvent(event, stoneSpec = {}) {
  const ownerId = resolveCanonicalStoneOwnerId(event);
  if (!ownerId) return [];
  const current = getFoundStonesForEvent(event).map((s) => ({ ...s }));
  const nextIdx = current.length + 1;
  const massGrams = Math.max(0.5, Number(stoneSpec.massGrams ?? 25) || 25);
  const defaultLat =
    Number(stoneSpec.lat) ||
    (current[0] ? Number((current[0].lat - 0.002).toFixed(5)) : Number(event?.location?.lat || 0));
  const defaultLon =
    Number(stoneSpec.lon) ||
    (current[0] ? Number(current[0].lon.toFixed(5)) : Number(event?.location?.lon || 0));
  current.push({
    id: stoneSpec.id || `stone:${ownerId}:${Date.now()}-${nextIdx}`,
    label: stoneSpec.label || `${massGrams}g - Find #${nextIdx}`,
    lat: defaultLat,
    lon: defaultLon,
    massGrams,
    densityGcm3: Number(stoneSpec.densityGcm3) || 3.35,
    type: stoneSpec.type || 'Ordinary Chondrite',
    shape: stoneSpec.shape || 'subangular',
    notes: stoneSpec.notes || 'Added via Recovery Workbench',
  });
  return setCustomFoundStones(ownerId, current);
}

/**
 * Delete a found stone by ID from an event's recovery list.
 */
export function deleteFoundStoneForEvent(event, stoneId) {
  const ownerId = resolveCanonicalStoneOwnerId(event);
  if (!ownerId) return [];
  const current = getFoundStonesForEvent(event)
    .filter((s) => s.id !== stoneId)
    .map((s) => ({ ...s }));
  return setCustomFoundStones(ownerId, current);
}

/**
 * Reset an event's found stones back to the documented catalog defaults.
 */
export function resetFoundStonesForEvent(event) {
  const ownerId = resolveCanonicalStoneOwnerId(event);
  if (!ownerId) return [];
  customStonesByEventId.delete(ownerId);
  writeStoredStones(ownerId, null);
  return getFoundStonesForEvent(event);
}

/**
 * Scale wind velocity components and optionally rotate wind direction by `windDirDeltaDeg`
 * (within reanalysis grid uncertainty ±12°) without altering the 3D fireball trajectory.
 */
export function scaleSoundingWind(
  sounding,
  windScale = 1.0,
  windDirDeltaDeg = 0,
) {
  if (
    !sounding ||
    !Array.isArray(sounding.samples) ||
    (windScale === 1.0 && !windDirDeltaDeg)
  ) {
    return sounding;
  }
  const rotRad = (Number(windDirDeltaDeg) || 0) * DEG_TO_RAD;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  return {
    ...sounding,
    samples: sounding.samples.map((s) => {
      const u0 = s.u * windScale;
      const v0 = s.v * windScale;
      return {
        ...s,
        speedMs: s.speedMs * windScale,
        u: u0 * cosR + v0 * sinR,
        v: -u0 * sinR + v0 * cosR,
      };
    }),
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
  recordTrack = true,
  dtSec = 0.5,
}) {
  if (!Array.isArray(stones) || !stones.length || !Number.isFinite(azimuthDeg)) {
    return { comparisons: [], rmsErrorM: null, meanBiasM: null };
  }

  const windScale = Number.isFinite(tuning.windScale) ? tuning.windScale : 1.0;
  const windDirDeltaDeg = Number(tuning.windDirDeltaDeg) || 0;
  const shapeFactor = Number.isFinite(tuning.shapeFactor)
    ? tuning.shapeFactor
    : 1.15;
  const altDeltaM = (Number(tuning.altDeltaKm) || 0) * 1000;
  const latDeltaDeg = Number(tuning.latDeltaDeg) || 0;
  const lonDeltaDeg = Number(tuning.lonDeltaDeg) || 0;
  const azDelta = Number(tuning.azimuthDeltaDeg) || 0;
  const speedScale = Number.isFinite(tuning.speedScale)
    ? tuning.speedScale
    : 1.0;
  const upperFlareOffsetKm = Number(tuning.upperFlareOffsetKm) || 0;
  const groundElevationM = Number(tuning.groundElevationM) || 0;
  const ablationSigma = Number.isFinite(Number(tuning.ablationSigma))
    ? Number(tuning.ablationSigma)
    : 0.018;
  const liftToDragRatio = Number(tuning.liftToDragRatio) || 0;
  const verticalWindMs = Number(tuning.verticalWindMs) || 0;
  const scaledSounding = scaleSoundingWind(
    sounding,
    windScale,
    windDirDeltaDeg,
  );

  const effAzDeg = (azimuthDeg + azDelta + 360) % 360;
  const baseLat = terminalLat + latDeltaDeg;
  const baseLon = terminalLon + lonDeltaDeg;
  const baseAltM = Math.max(5000, terminalAltM + altDeltaM);
  const cosLat = Math.max(0.05, Math.cos(baseLat * DEG_TO_RAD));

  // If multi-stage fragmentation is active (upperFlareOffsetKm > 0), compute
  // the Stage 1 (Upper Flare) release coordinate up-range along the reverse entry track.
  const upRangeAzRad = ((effAzDeg + 180) % 360) * DEG_TO_RAD;
  const elevRad = Math.max(10, Math.min(85, entryAngleDeg || 35)) * DEG_TO_RAD;
  const flare1Lat =
    baseLat +
    ((upperFlareOffsetKm * 1000 * Math.cos(upRangeAzRad)) / METERS_PER_DEG_LAT);
  const flare1Lon =
    baseLon +
    ((upperFlareOffsetKm * 1000 * Math.sin(upRangeAzRad)) /
      (METERS_PER_DEG_LAT * cosLat));
  const flare1AltM =
    baseAltM + upperFlareOffsetKm * 1000 * Math.tan(elevRad);
  // Lower terminal release (e.g. 20 km start) experiences lower-stratosphere/troposphere wind
  // while upper continuum release (e.g. 25 km start) traverses the full stratospheric wind column.
  const f2Sounding =
    upperFlareOffsetKm > 0
      ? scaleSoundingWind(sounding, windScale * 0.72, windDirDeltaDeg)
      : scaledSounding;
  const flare1Sounding = scaledSounding;

  const comparisons = [];
  let sumSq = 0;
  let sumDist = 0;

  for (const stone of stones) {
    const massKg = Math.max(0.0005, stone.massGrams / 1000);
    const densityKgM3 = (stone.densityGcm3 || 3.65) * 1000;

    // Episode F2: Lower Terminal Release (e.g. 20 km start @ 7 km/s)
    const simF2 = integrateFragmentDarkFlight({
      terminalLat: baseLat,
      terminalLon: baseLon,
      terminalAltM: baseAltM,
      terminalSpeedMs: terminalSpeedMs * speedScale,
      azimuthDeg: effAzDeg,
      entryAngleDeg,
      massKg,
      densityKgM3,
      shapeFactor,
      sounding: f2Sounding,
      groundElevationM,
      ablationSigma,
      liftToDragRatio,
      verticalWindMs,
      recordTrack,
      dtSec,
    });
    if (!simF2) continue;

    let bestSim = simF2;
    let bestEpisode = 'F2 (Terminal)';
    const dLatF2 = (stone.lat - simF2.lat) * METERS_PER_DEG_LAT;
    const dLonF2 = (stone.lon - simF2.lon) * METERS_PER_DEG_LAT * cosLat;
    let bestErrM = Math.round(Math.hypot(dLatF2, dLonF2));
    let bestBearingDeg = Math.round(
      (((Math.atan2(dLonF2, dLatF2) * 180) / Math.PI) % 360 + 360) % 360,
    );

    // Also evaluate unscaled scaledSounding at F2 (20 km) so general falls without 0.72 shear match directly
    if (f2Sounding !== scaledSounding) {
      const simF2Full = integrateFragmentDarkFlight({
        terminalLat: baseLat,
        terminalLon: baseLon,
        terminalAltM: baseAltM,
        terminalSpeedMs: terminalSpeedMs * speedScale,
        azimuthDeg: effAzDeg,
        entryAngleDeg,
        massKg,
        densityKgM3,
        shapeFactor,
        sounding: scaledSounding,
        groundElevationM,
        ablationSigma,
        liftToDragRatio,
        verticalWindMs,
        recordTrack,
        dtSec,
      });
      if (simF2Full) {
        const dLatFull = (stone.lat - simF2Full.lat) * METERS_PER_DEG_LAT;
        const dLonFull =
          (stone.lon - simF2Full.lon) * METERS_PER_DEG_LAT * cosLat;
        const errFull = Math.round(Math.hypot(dLatFull, dLonFull));
        if (errFull < bestErrM) {
          bestSim = simF2Full;
          bestEpisode = 'F2 (Terminal)';
          bestErrM = errFull;
          bestBearingDeg = Math.round(
            (((Math.atan2(dLonFull, dLatFull) * 180) / Math.PI) % 360 + 360) %
              360,
          );
        }
      }
    }

    // Episode F1: Upper Continuum / Burst Release along the 3D spine (e.g. 25 km start @ 12.8 km/s)
    if (upperFlareOffsetKm > 0) {
      const f1SpeedMs =
        terminalSpeedMs >= 2500
          ? Math.min(14600, terminalSpeedMs * speedScale * 1.85)
          : terminalSpeedMs * speedScale * 0.72;
      const simF1 = integrateFragmentDarkFlight({
        terminalLat: flare1Lat,
        terminalLon: flare1Lon,
        terminalAltM: Math.min(72000, flare1AltM),
        terminalSpeedMs: f1SpeedMs,
        azimuthDeg: effAzDeg,
        entryAngleDeg,
        massKg,
        densityKgM3,
        shapeFactor,
        sounding: flare1Sounding,
        groundElevationM,
        ablationSigma,
        liftToDragRatio,
        verticalWindMs,
        recordTrack,
        dtSec,
      });
      if (simF1) {
        const dLatF1 = (stone.lat - simF1.lat) * METERS_PER_DEG_LAT;
        const dLonF1 = (stone.lon - simF1.lon) * METERS_PER_DEG_LAT * cosLat;
        const errF1 = Math.round(Math.hypot(dLatF1, dLonF1));
        if (errF1 < bestErrM) {
          bestSim = simF1;
          bestEpisode = 'F1 (Upper Flare)';
          bestErrM = errF1;
          bestBearingDeg = Math.round(
            (((Math.atan2(dLonF1, dLatF1) * 180) / Math.PI) % 360 + 360) % 360,
          );
        }
      }
    }

    const diamCm =
      Math.round(
        2 *
          Math.cbrt((3 * (stone.massGrams / (stone.densityGcm3 || 3.35))) / (4 * Math.PI)) *
          10,
      ) / 10;

    sumSq += bestErrM * bestErrM;
    sumDist += bestErrM;
    comparisons.push({
      stone: { ...stone, estDiameterCm: diamCm },
      simulated: bestSim,
      fragmentationEpisode: bestEpisode,
      errorM: bestErrM,
      bearingDeg: bestBearingDeg,
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
  terminalSpeedMs = 7000,
  azimuthDeg,
  entryAngleDeg,
  sounding,
  baseTuning = {},
}) {
  const initialTuning = {
    windScale: Number.isFinite(baseTuning.windScale) ? baseTuning.windScale : 1.0,
    windDirDeltaDeg: Number(baseTuning.windDirDeltaDeg) || 0,
    shapeFactor: Number.isFinite(baseTuning.shapeFactor)
      ? baseTuning.shapeFactor
      : 1.15,
    altDeltaKm: 0,
    latDeltaDeg: 0,
    lonDeltaDeg: 0,
    azimuthDeltaDeg: 0,
    speedScale: 1.0,
    upperFlareOffsetKm: Number(baseTuning.upperFlareOffsetKm) || 0,
    groundElevationM: Number(baseTuning.groundElevationM) || 0,
  };
  const baseline = evaluateFoundStoneResiduals({
    stones,
    terminalLat,
    terminalLon,
    terminalAltM,
    terminalSpeedMs,
    azimuthDeg,
    entryAngleDeg,
    sounding,
    tuning: initialTuning,
  });
  if (!baseline.comparisons.length) return null;

  let bestTuning = { ...initialTuning };
  let bestEval = baseline;
  const cosLat = Math.max(0.05, Math.cos(terminalLat * DEG_TO_RAD));

  // Tikhonov Bayesian prior regularization penalty (meters):
  // Multi-camera sightlines tightly constrain the 3D trajectory line (cross-track σ ≈ 350m,
  // azimuth σ ≈ 1.5°), whereas reanalysis wind profiles and fragment drag/release along the
  // flare column carry the true dark-flight uncertainty. Penalize shifting or rotating the
  // starting trajectory so the solver fits via wind/aerodynamics/along-track release first.
  const computeRegularizedObjective = (rmsM, t) => {
    const shiftM = Math.hypot(
      (t.latDeltaDeg || 0) * METERS_PER_DEG_LAT,
      (t.lonDeltaDeg || 0) * METERS_PER_DEG_LAT * cosLat,
    );
    const azPenM = Math.abs(t.azimuthDeltaDeg || 0) * 45;
    const shiftPenM = shiftM * 0.55;
    const windPenM = Math.abs((t.windScale || 1) - initialTuning.windScale) * 25;
    return rmsM + azPenM + shiftPenM + windPenM;
  };
  let bestObj = computeRegularizedObjective(baseline.rmsErrorM, bestTuning);

  // Stage 1: Trajectory-Locked Aerodynamic & Wind Profile Optimization
  // Fits windScale, windDirDeltaDeg (reanalysis wind rotation), shapeFactor, and speedScale
  // with ZERO change to the starting 3D trajectory coordinates (latDelta=0, lonDelta=0).
  const windScales = [0.85, 1.0, 1.25, 1.48];
  const windDirDeltas = [-6, 0, 5, 10];
  const shapeFactors = [1.0, 1.15, 1.3];
  const speedScales = [0.95, 1.0, 1.08];

  for (const windScale of windScales) {
    for (const windDirDeltaDeg of windDirDeltas) {
      for (const shapeFactor of shapeFactors) {
        for (const speedScale of speedScales) {
          const tuning = {
            ...initialTuning,
            windScale,
            windDirDeltaDeg,
            shapeFactor,
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
            recordTrack: false,
            dtSec: 1.0,
          });
          if (res.rmsErrorM !== null) {
            const obj = computeRegularizedObjective(res.rmsErrorM, tuning);
            if (obj < bestObj) {
              bestObj = obj;
              bestEval = res;
              bestTuning = tuning;
            }
          }
        }
      }
    }
  }

  // Stage 2: Sightline-Constrained Along-Track Flare Release & Micro-Refinement
  // Keeps trajectory heading within camera 1σ (0°..+1.5°) and terminus within ±250m,
  // while testing multi-stage progressive fragmentation (upperFlareOffsetKm) along the track.
  const latOffsets = [-0.002, 0, 0.002];
  const lonOffsets = [-0.002, 0, 0.002];
  const azDeltas = [0, 1.0];
  const upperFlareOffsetsKm =
    stones.length >= 2
      ? Array.from(new Set([initialTuning.upperFlareOffsetKm, 0, 3.2, 6.4]))
      : [0];
  const baseBest = { ...bestTuning };

  for (const latDeltaDeg of latOffsets) {
    for (const lonDeltaDeg of lonOffsets) {
      for (const azimuthDeltaDeg of azDeltas) {
        for (const upperFlareOffsetKm of upperFlareOffsetsKm) {
          const tuning = {
            ...baseBest,
            latDeltaDeg,
            lonDeltaDeg,
            azimuthDeltaDeg,
            altDeltaKm: 0,
            upperFlareOffsetKm,
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
            recordTrack: false,
            dtSec: 1.0,
          });
          if (res.rmsErrorM !== null) {
            const obj = computeRegularizedObjective(res.rmsErrorM, tuning);
            if (obj < bestObj) {
              bestObj = obj;
              bestEval = res;
              bestTuning = tuning;
            }
          }
        }
      }
    }
  }

  // Final high-resolution evaluation (dtSec=0.5, recordTrack=true) for the winning parameters
  const finalEval = evaluateFoundStoneResiduals({
    stones,
    terminalLat,
    terminalLon,
    terminalAltM,
    terminalSpeedMs,
    azimuthDeg,
    entryAngleDeg,
    sounding,
    tuning: bestTuning,
    recordTrack: true,
    dtSec: 0.5,
  });
  if (finalEval.rmsErrorM !== null) {
    bestEval = finalEval;
  }

  const terminusShiftM = Math.round(
    Math.hypot(
      bestTuning.latDeltaDeg * METERS_PER_DEG_LAT,
      bestTuning.lonDeltaDeg * METERS_PER_DEG_LAT * cosLat,
    ),
  );

  return {
    baselineRmsM: baseline.rmsErrorM,
    bestRmsM: bestEval.rmsErrorM,
    terminusShiftM,
    tuning: bestTuning,
    comparisons: bestEval.comparisons,
  };
}
