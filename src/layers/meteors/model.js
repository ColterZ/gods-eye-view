import * as Cesium from 'cesium';
import {
  TIME_WINDOWS,
  DEFAULT_TIME_WINDOW,
  SEVERITY_COLORS,
  METEORS_OVERLAY_COHORT_LIMIT,
} from './policy.js';

const DAY_MS = 86_400_000;
const ENTRY_TRACK_LENGTH_M = 110_000; // 110 km visible atmospheric entry track

export function resolveTimeWindow(windowId) {
  return (
    TIME_WINDOWS.find((w) => w.id === windowId) ||
    TIME_WINDOWS.find((w) => w.id === DEFAULT_TIME_WINDOW) ||
    TIME_WINDOWS[2]
  );
}

/**
 * Filter events to the active time window relative to the latest observation
 * (or `nowMs` fallback) so delayed catalog snapshots always filter meaningfully.
 */
export function filterEventsByWindow(
  events,
  windowId = DEFAULT_TIME_WINDOW,
  nowMs = Date.now(),
) {
  if (!Array.isArray(events) || !events.length) return [];
  const spec = resolveTimeWindow(windowId);
  const cutoffMs = nowMs - spec.days * DAY_MS;
  return events
    .filter((event) => {
      const t = Date.parse(event?.eventTime);
      return Number.isFinite(t) && t >= cutoffMs;
    })
    .sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime));
}

/**
 * Classify a fireball by impact energy (kt TNT) and compute log-scaled marker size.
 */
export function severityTier(event) {
  const impact = Number(event?.energy?.impact) || 0;
  let tier = 'minor';
  let colorHex = SEVERITY_COLORS.minor;
  if (impact >= 5) {
    tier = 'major';
    colorHex = SEVERITY_COLORS.major;
  } else if (impact >= 0.5) {
    tier = 'medium';
    colorHex = SEVERITY_COLORS.medium;
  }
  const pixelSize = Math.max(
    9,
    Math.min(
      18,
      Math.round(9 + Math.log10(Math.max(0.05, impact) * 20) * 3.5),
    ),
  );
  return {
    tier,
    colorHex,
    pixelSize,
    selectedSize: pixelSize + 5,
  };
}

export function hasVelocityVector(event) {
  const t = event?.trajectory;
  return (
    Number.isFinite(t?.vx) && Number.isFinite(t?.vy) && Number.isFinite(t?.vz)
  );
}

/**
 * Compute 3D ECEF positions for the airburst point, ground plumb point, and
 * upstream atmospheric entry track (when ECEF vx, vy, vz are available).
 */
export function computeEventGeometry(event, cesium = Cesium) {
  const lat = Number(event?.location?.lat);
  const lon = Number(event?.location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const altKm = Number.isFinite(event?.location?.altitude)
    ? Math.max(0, event.location.altitude)
    : null;
  const burstHeightM = (altKm ?? 0) * 1000;
  const groundPosition = cesium.Cartesian3.fromDegrees(lon, lat, 0);
  const burstPosition = cesium.Cartesian3.fromDegrees(lon, lat, burstHeightM);
  // Lifted occlusion test point so height-0 points never fail ellipsoid horizon test
  const cullPosition =
    burstHeightM >= 100
      ? burstPosition
      : cesium.Cartesian3.fromDegrees(lon, lat, 100);

  let entryTrackPositions = null;
  if (hasVelocityVector(event)) {
    const { vx, vy, vz } = event.trajectory;
    const speed = Math.hypot(vx, vy, vz);
    if (speed > 0) {
      // CNEOS (vx, vy, vz) is in ECEF km/s pointing along the meteor's travel
      // direction toward the airburst. Stepping along -V traces back up the entry path.
      const anchor =
        altKm !== null
          ? burstPosition
          : cesium.Cartesian3.fromDegrees(lon, lat, 32_000);
      const entryStart = new cesium.Cartesian3(
        anchor.x - (vx / speed) * ENTRY_TRACK_LENGTH_M,
        anchor.y - (vy / speed) * ENTRY_TRACK_LENGTH_M,
        anchor.z - (vz / speed) * ENTRY_TRACK_LENGTH_M,
      );
      entryTrackPositions = [entryStart, anchor];
    }
  }

  return {
    groundPosition,
    burstPosition,
    cullPosition,
    hasAltitude: altKm !== null && altKm > 0,
    entryTrackPositions,
  };
}

export function formatEnergyKt(impact) {
  if (!Number.isFinite(impact)) return 'energy n/a';
  if (impact >= 10) return `${impact.toFixed(1)} kt`;
  if (impact >= 1) return `${impact.toFixed(2)} kt`;
  return `${impact.toFixed(2)} kt`;
}

export function formatRadiatedJ(radiated) {
  if (!Number.isFinite(radiated)) return 'n/a';
  return `${radiated.toFixed(1)}×10¹⁰ J`;
}

export function formatLatLon(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'coords n/a';
  const latStr = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${latStr} ${lonStr}`;
}

export function formatUtcTimestamp(iso) {
  if (typeof iso !== 'string' || !iso) return 'time n/a';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function formatAgeShort(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return '<1m ago';
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function markerClearance(markerPx) {
  const gapPx = Math.max(12, markerPx + 8);
  return {
    gapPx,
    leaderOffsetPx: Math.max(2, gapPx - 6),
    verticalOnly: true,
    viewportMargin: 4,
  };
}

const SHARED_CARD_POLICY = Object.freeze({
  cardStyle: 'tactical',
  collisionGroup: 'ambient-card',
  edgeFade: 'keyhole',
  horizonCull: true,
  terrainOcclusion: false,
  interactive: true,
});

/**
 * Build the presentation model for an individual fireball card (used by both
 * the worldOverlay host and entity.gevLabelModel).
 */
export function buildMeteorCardModel(event, selected = false) {
  const { colorHex, pixelSize, selectedSize } = severityTier(event);
  const impactStr = formatEnergyKt(event?.energy?.impact);
  const radiatedStr = formatRadiatedJ(event?.energy?.radiated);
  const coordsStr = formatLatLon(event?.location?.lat, event?.location?.lon);
  const alt = event?.location?.altitude;
  const altStr = Number.isFinite(alt) ? `Alt ${alt.toFixed(1)} km` : 'Alt n/a';
  const vel = event?.trajectory?.entryVelocity;
  const velStr = Number.isFinite(vel)
    ? `Vel ${vel.toFixed(1)} km/s`
    : 'Vel n/a';
  const utcStr = formatUtcTimestamp(event?.eventTime);
  const dateOnly =
    typeof event?.eventTime === 'string' ? event.eventTime.slice(0, 10) : '';

  if (selected) {
    const details = [`${coordsStr} · ${altStr} · ${velStr}`];
    if (hasVelocityVector(event)) {
      const { vx, vy, vz, entryAngle, azimuth } = event.trajectory;
      const anglePart =
        entryAngle !== null && azimuth !== null
          ? `Entry ${entryAngle}° elev · Az ${azimuth}°`
          : `ECEF (${vx}, ${vy}, ${vz}) km/s`;
      details.push(`Radiated ${radiatedStr} · ${anglePart}`);
    } else {
      details.push(`Radiated ${radiatedStr} · 3D vector unavailable`);
    }
    details.push(
      'NASA/JPL CNEOS (delayed sensor catalog) · Report ≠ meteorite fall',
    );
    return {
      title: `☄ FIREBALL · ${impactStr} TNT · ${utcStr}`,
      details,
      accent: SEVERITY_COLORS.selected,
      selected: true,
      markerPx: selectedSize,
    };
  }

  return {
    title: `☄ ${impactStr} · ${dateOnly}`,
    details: [
      `${coordsStr} · ${Number.isFinite(alt) ? `${alt.toFixed(0)} km` : 'alt n/a'}${Number.isFinite(vel) ? ` · ${vel.toFixed(1)} km/s` : ''}`,
    ],
    accent: colorHex,
    selected: false,
    markerPx: pixelSize,
  };
}

/**
 * Build world-overlay host entries for all rendered fireballs.
 * Selected fireball is protected at max priority; ambient cards are ranked by
 * impact energy and capped by METEORS_OVERLAY_COHORT_LIMIT.
 */
export function buildMeteorOverlayEntries(
  renderedItems,
  selectedEventId = null,
) {
  const entries = [];
  for (const item of renderedItems) {
    const { event, burstPosition, cullPosition } = item;
    const selected = event.id === selectedEventId;
    const model = buildMeteorCardModel(event, selected);
    const impact = Number(event?.energy?.impact) || 0;
    entries.push({
      ...SHARED_CARD_POLICY,
      ...markerClearance(model.markerPx),
      id: `meteor:${event.id}`,
      position: burstPosition,
      cullPosition,
      variant: selected ? 'selected' : 'card',
      title: model.title,
      details: model.details,
      accent: model.accent,
      selected,
      protected: selected,
      priority: selected
        ? Number.MAX_SAFE_INTEGER
        : Math.round(impact * 1000) + 100,
      maxDistance: Number.POSITIVE_INFINITY,
    });
  }
  return entries.sort((a, b) => b.priority - a.priority);
}

export function meteorIdFromOverlayEntryId(entryId) {
  const raw = String(entryId ?? '');
  return raw.startsWith('meteor:') ? raw.slice('meteor:'.length) : null;
}

/**
 * Plain JSON-safe record for the analyst query engine.
 */
export function mapAnalystRecord(event) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    id: event?.id || null,
    source: 'NASA/JPL CNEOS',
    eventTime: event?.eventTime || null,
    lat: num(event?.location?.lat),
    lon: num(event?.location?.lon),
    altitudeKm: num(event?.location?.altitude),
    impactEnergyKt: num(event?.energy?.impact),
    radiatedEnergy10e10J: num(event?.energy?.radiated),
    velocityKmS: num(event?.trajectory?.entryVelocity),
    entryAngleDeg: num(event?.trajectory?.entryAngle),
    azimuthDeg: num(event?.trajectory?.azimuth),
    has3dVector: hasVelocityVector(event),
  };
}
