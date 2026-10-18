const EARTH_RADIUS_KM = 6371.0;

/**
 * Common IAU meteor shower codes -> human-readable names.
 */
export const IAU_SHOWER_NAMES = Object.freeze({
  SPO: 'Sporadic',
  PER: 'Perseids',
  ORI: 'Orionids',
  GEM: 'Geminids',
  QUA: 'Quadrantids',
  LYR: 'Lyrids',
  ETA: 'Eta Aquariids',
  SDA: 'S. Delta Aquariids',
  CAP: 'Alpha Capricornids',
  STA: 'S. Taurids',
  NTA: 'N. Taurids',
  LEO: 'Leonids',
  URS: 'Ursids',
  DRA: 'Draconids',
  HYD: 'Sigma Hydrids',
  MON: 'December Monocerotids',
  COM: 'Comae Berenicids',
  LMI: 'Leonis Minorids',
  AUR: 'Aurigids',
  SPE: 'September E. Perseids',
  OCT: 'October Camelopardalids',
  CRN: 'Corona-Australids',
  OCU: 'October Cetids',
  SFD: 'September phi Draconids',
  EPU: 'Epsilon Puppids',
});

export function formatShowerLabel(showerCode) {
  if (!showerCode || showerCode === '...' || showerCode === 'SPO') {
    return 'Sporadic (non-shower)';
  }
  const code = String(showerCode).trim().toUpperCase();
  const name = IAU_SHOWER_NAMES[code];
  return name ? `${name} (${code})` : `IAU Shower ${code}`;
}

export function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  )
    return Infinity;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Non-destructive cross-source corroboration matcher.
 * Flags candidate matches between distinct sources (cneos, gmn, asgard, ares)
 * without silently merging or overwriting any source's native measurements.
 *
 * Matching rules:
 * - Sensor/Camera bolides (cneos, gmn, asgard): within 2 hours and 400 km
 * - Documented ARES meteorite falls (ares, which carry date-only timestamps):
 *   within 24 hours (same UTC calendar day) and 350 km
 */
export function corroborateMeteorEvents(events) {
  if (!Array.isArray(events) || events.length < 2) return events || [];

  // Reset possibleMatches cleanly
  for (const ev of events) {
    ev.possibleMatches = [];
  }

  const n = events.length;
  for (let i = 0; i < n; i++) {
    const a = events[i];
    const tA = Date.parse(a?.eventTime);
    const latA = a?.location?.lat;
    const lonA = a?.location?.lon;
    if (!Number.isFinite(tA) || !Number.isFinite(latA) || !Number.isFinite(lonA))
      continue;

    for (let j = i + 1; j < n; j++) {
      const b = events[j];
      if (!b || a.source === b.source) continue;

      const tB = Date.parse(b?.eventTime);
      const latB = b?.location?.lat;
      const lonB = b?.location?.lon;
      if (
        !Number.isFinite(tB) ||
        !Number.isFinite(latB) ||
        !Number.isFinite(lonB)
      )
        continue;

      const involvesAres = a.source === 'ares' || b.source === 'ares';
      const maxTimeDeltaMs = involvesAres ? 24 * 3600_000 : 2 * 3600_000;
      const maxDistKm = involvesAres ? 350 : 400;

      const dtMs = Math.abs(tA - tB);
      if (dtMs > maxTimeDeltaMs) continue;

      const distKm = haversineDistanceKm(latA, lonA, latB, lonB);
      if (distKm > maxDistKm) continue;

      const roundedKm = Math.round(distKm * 10) / 10;
      const dtSec = Math.round(dtMs / 1000);

      a.possibleMatches.push({
        id: b.id,
        source: b.source.toUpperCase(),
        distanceKm: roundedKm,
        timeDeltaSec: dtSec,
        summary: `${b.source.toUpperCase()} (${roundedKm} km${involvesAres ? ', same day' : `, Δt ${dtSec}s`})`,
      });

      b.possibleMatches.push({
        id: a.id,
        source: a.source.toUpperCase(),
        distanceKm: roundedKm,
        timeDeltaSec: dtSec,
        summary: `${a.source.toUpperCase()} (${roundedKm} km${involvesAres ? ', same day' : `, Δt ${dtSec}s`})`,
      });
    }
  }

  return events;
}
