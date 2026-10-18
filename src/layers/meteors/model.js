import * as Cesium from 'cesium';
import {
  TIME_WINDOWS,
  DEFAULT_TIME_WINDOW,
  SOURCE_FILTERS,
  DEFAULT_SOURCE_FILTER,
  SEVERITY_COLORS,
} from './policy.js';
import { formatShowerLabel } from './corroboration.js';
import {
  computeAerodynamicBreakupPhysics,
  computeNexradCoverage,
  computeGoesSatelliteDiagnostics,
  computeCneosSensorDiagnostics,
  getNexradGateForEvent,
} from './validation.js';

const DAY_MS = 86_400_000;
const CNEOS_ROUGH_STUB_IN_M = 16_000; // 16 km incoming rough-directionality stub on CNEOS sphere
const CNEOS_ROUGH_STUB_OUT_M = 6_500; // 6.5 km outgoing cone tip on CNEOS sphere

export function resolveTimeWindow(windowId) {
  return (
    TIME_WINDOWS.find((w) => w.id === windowId) ||
    TIME_WINDOWS.find((w) => w.id === DEFAULT_TIME_WINDOW) ||
    TIME_WINDOWS[3]
  );
}

export function resolveSourceFilter(sourceId) {
  return (
    SOURCE_FILTERS.find((s) => s.id === sourceId) ||
    SOURCE_FILTERS.find((s) => s.id === DEFAULT_SOURCE_FILTER) ||
    SOURCE_FILTERS[0]
  );
}

/**
 * Filter events to the active time window and source filter relative to the
 * latest observation (or `nowMs` fallback).
 */
export function filterEventsByWindow(
  events,
  windowId = DEFAULT_TIME_WINDOW,
  nowMs = Date.now(),
  sourceFilter = DEFAULT_SOURCE_FILTER,
) {
  if (!Array.isArray(events) || !events.length) return [];
  const spec = resolveTimeWindow(windowId);
  const cutoffMs = nowMs - spec.days * DAY_MS;
  const activeSource = resolveSourceFilter(sourceFilter).id;

  return events
    .filter((event) => {
      const t = Date.parse(event?.eventTime);
      if (!Number.isFinite(t) || t < cutoffMs) return false;
      if (activeSource === 'all') return true;
      if (activeSource === 'matched') {
        return (
          Array.isArray(event?.possibleMatches) &&
          event.possibleMatches.length > 0
        );
      }
      return event?.source === activeSource;
    })
    .sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime));
}

/**
 * Classify a fireball/meteor by source and impact energy or magnitude,
 * and compute marker color and pixel size.
 */
export function severityTier(event) {
  const src = event?.source || 'cneos';
  if (src === 'gmn') {
    const mag = Number(event?.magnitude);
    const brightBonus = Number.isFinite(mag)
      ? Math.max(0, Math.min(6, Math.round((-mag - 1.5) * 1.1)))
      : 0;
    const pixelSize = 8 + brightBonus;
    return {
      tier: 'gmn',
      colorHex: SEVERITY_COLORS.gmn,
      pixelSize,
      selectedSize: pixelSize + 5,
    };
  }
  if (src === 'asgard') {
    return {
      tier: 'asgard',
      colorHex: SEVERITY_COLORS.asgard,
      pixelSize: 11,
      selectedSize: 16,
    };
  }
  if (src === 'ares') {
    return {
      tier: 'ares',
      colorHex: SEVERITY_COLORS.ares,
      pixelSize: 12,
      selectedSize: 17,
    };
  }

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

export function hasMeasuredEndpoints(event) {
  const t = event?.trajectory;
  return (
    Number.isFinite(t?.startLat) &&
    Number.isFinite(t?.startLon) &&
    Number.isFinite(t?.endLat) &&
    Number.isFinite(t?.endLon)
  );
}

export function hasVelocityVector(event) {
  const t = event?.trajectory;
  return (
    (Number.isFinite(t?.vx) &&
      Number.isFinite(t?.vy) &&
      Number.isFinite(t?.vz)) ||
    hasMeasuredEndpoints(event)
  );
}

/**
 * Compute 3D ECEF positions for the airburst/terminus point, ground plumb point,
 * and 3D atmospheric trajectory (either measured start->end camera endpoints
 * for GMN/ASGARD, or upstream ECEF velocity vector for CNEOS).
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
  const cullPosition =
    burstHeightM >= 100
      ? burstPosition
      : cesium.Cartesian3.fromDegrees(lon, lat, 100);

  let entryTrackPositions = null;
  let isRoughDirectionStub = false;
  let cneosSphereRadiusM = null;
  const t = event?.trajectory;
  const isCneos = (event?.source || 'cneos') === 'cneos';

  if (isCneos) {
    const cDiag = computeCneosSensorDiagnostics(event);
    cneosSphereRadiusM = cDiag?.sphereRadiusM ?? 5500;
  }

  if (hasMeasuredEndpoints(event)) {
    const startAltM =
      (Number.isFinite(t.startAltKm) ? Math.max(0, t.startAltKm) : 90) * 1000;
    const endAltM =
      (Number.isFinite(t.endAltKm)
        ? Math.max(0, t.endAltKm)
        : (altKm ?? 45)) * 1000;
    const entryStart = cesium.Cartesian3.fromDegrees(
      t.startLon,
      t.startLat,
      startAltM,
    );
    const entryEnd = cesium.Cartesian3.fromDegrees(
      t.endLon,
      t.endLat,
      endAltM,
    );
    entryTrackPositions = [entryStart, entryEnd];
  } else if (
    Number.isFinite(t?.vx) &&
    Number.isFinite(t?.vy) &&
    Number.isFinite(t?.vz)
  ) {
    const { vx, vy, vz } = t;
    const speed = Math.hypot(vx, vy, vz);
    if (speed > 0) {
      const anchor =
        altKm !== null
          ? burstPosition
          : cesium.Cartesian3.fromDegrees(lon, lat, 32_000);
      const entryStart = new cesium.Cartesian3(
        anchor.x - (vx / speed) * CNEOS_ROUGH_STUB_IN_M,
        anchor.y - (vy / speed) * CNEOS_ROUGH_STUB_IN_M,
        anchor.z - (vz / speed) * CNEOS_ROUGH_STUB_IN_M,
      );
      const entryEnd = new cesium.Cartesian3(
        anchor.x + (vx / speed) * CNEOS_ROUGH_STUB_OUT_M,
        anchor.y + (vy / speed) * CNEOS_ROUGH_STUB_OUT_M,
        anchor.z + (vz / speed) * CNEOS_ROUGH_STUB_OUT_M,
      );
      entryTrackPositions = [entryStart, entryEnd];
      isRoughDirectionStub = true;
    }
  }

  return {
    groundPosition,
    burstPosition,
    cullPosition,
    hasAltitude: altKm !== null && altKm > 0,
    entryTrackPositions,
    isRoughDirectionStub,
    cneosSphereRadiusM,
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

export function formatMass(massKg) {
  if (!Number.isFinite(massKg) || massKg <= 0) return 'n/a';
  if (massKg >= 1) return `${massKg.toFixed(2)} kg`;
  return `${(massKg * 1000).toFixed(1)} g`;
}

export function sourceShortBadge(event) {
  const src = String(event?.source || 'cneos').toUpperCase();
  const hasMatches =
    Array.isArray(event?.possibleMatches) && event.possibleMatches.length > 0;
  return hasMatches ? `★ ${src}` : src;
}

/**
 * Build the presentation model for an individual fireball/meteor card (used by
 * both the worldOverlay host and entity.gevLabelModel).
 */
export function buildMeteorCardModel(event, selected = false) {
  const src = event?.source || 'cneos';
  const { colorHex, pixelSize, selectedSize } = severityTier(event);
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
  const matches = Array.isArray(event?.possibleMatches)
    ? event.possibleMatches
    : [];
  const matchLine =
    matches.length > 0
      ? `★ Corroborated: ${matches.map((m) => m.summary).join('; ')}`
      : null;

  if (src === 'gmn') {
    const magStr = Number.isFinite(event?.magnitude)
      ? `Mag ${event.magnitude.toFixed(1)}`
      : 'Optical';
    const shower = formatShowerLabel(event?.orbit?.showerCode);
    const t = event?.trajectory || {};
    const altSpan =
      Number.isFinite(t.startAltKm) && Number.isFinite(t.endAltKm)
        ? `${t.startAltKm.toFixed(1)}→${t.endAltKm.toFixed(1)} km`
        : altStr;
    if (selected) {
      const details = [
        `${coordsStr} · ${altSpan} · ${velStr} · Mass ${formatMass(event.mass)}`,
        `Shower: ${shower}${event.orbit?.orbitalClass ? ` · ${event.orbit.orbitalClass}` : ''}`,
      ];
      if (matchLine) details.push(matchLine);
      details.push(
        `GMN (${event.stations?.count || 2} cameras, CC BY 4.0) · Report ≠ meteorite fall`,
      );
      return {
        title: `☄ GMN TRAJECTORY · ${magStr} · ${utcStr}`,
        details,
        accent: SEVERITY_COLORS.selected,
        selected: true,
        markerPx: selectedSize,
      };
    }
    return {
      title: `☄ [GMN] ${magStr} · ${event.orbit?.showerCode || 'SPO'}`,
      details: [
        `${coordsStr} · ${altSpan}${Number.isFinite(vel) ? ` · ${vel.toFixed(1)} km/s` : ''}`,
      ],
      accent: matches.length > 0 ? SEVERITY_COLORS.corroborated : colorHex,
      selected: false,
      markerPx: pixelSize,
    };
  }

  if (src === 'asgard') {
    const t = event?.trajectory || {};
    const altSpan =
      Number.isFinite(t.startAltKm) && Number.isFinite(t.endAltKm)
        ? `${t.startAltKm.toFixed(0)}→${t.endAltKm.toFixed(0)} km`
        : altStr;
    const trackStr = Number.isFinite(t.groundTrackDistance)
      ? `Track ${t.groundTrackDistance} km`
      : '';
    if (selected) {
      const aero = computeAerodynamicBreakupPhysics(event, event);
      const nexCov = computeNexradCoverage(
        event.location?.lat,
        event.location?.lon,
      );
      const nexGate = getNexradGateForEvent(event);
      const goes = computeGoesSatelliteDiagnostics(event, event, nexGate);
      const details = [
        `${coordsStr} · ${altSpan} · ${velStr}${trackStr ? ` · ${trackStr}` : ''} · Az ${t.azimuth ?? 'n/a'}°`,
      ];
      if (aero) {
        details.push(
          `Breakup P_dyn ${aero.ramPressureMpa} MPa (${aero.strengthClass}) · Boom carpet ±${aero.sonicBoomCarpetRadiusKm} km (+${aero.sonicBoomDelaySec}s)`,
        );
      }
      if (nexGate) {
        details.push(
          `📡 NEXRAD Gate: ${nexGate.station} @ ${nexGate.gateAltitudeKm} km (Δt +${nexGate.elapsedSec}s · ${nexGate.reflectivityDbz} dBZ)`,
        );
      } else if (nexCov?.primary) {
        const p = nexCov.primary;
        details.push(
          `📡 Nearest NEXRAD: ${p.id} (${p.name}, ${p.distanceKm} km) · 0.5°–2.4° beams @ ${p.tilt05AltKm}–${p.tilt24AltKm} km`,
        );
      }
      if (goes) {
        details.push(
          `🛰 ${goes.stereoCoverage} · GLM parallax ${goes.parallaxShiftKm} km →${goes.parallaxBearingDeg}° · ${goes.abiBand7Swir.split(':')[0]}`,
        );
      }
      if (matchLine) details.push(matchLine);
      return {
        title: `☄ ASGARD 3D CAMERA SKYFALL · ${utcStr}`,
        details,
        accent: SEVERITY_COLORS.selected,
        selected: true,
        markerPx: selectedSize,
      };
    }
    return {
      title: `☄ [ASGARD] ${dateOnly}`,
      details: [
        `${coordsStr} · ${altSpan}${Number.isFinite(vel) ? ` · ${vel.toFixed(1)} km/s` : ''}`,
      ],
      accent: matches.length > 0 ? SEVERITY_COLORS.corroborated : colorHex,
      selected: false,
      markerPx: pixelSize,
    };
  }

  if (src === 'ares') {
    const fallName = event?.name || event?.id;
    if (selected) {
      const nexGate = getNexradGateForEvent(event);
      const nexCov = computeNexradCoverage(
        event.location?.lat,
        event.location?.lon,
      );
      const details = [
        `${coordsStr} · Documented fall date ${dateOnly}`,
        event?.description || 'NASA ARES radar-confirmed meteorite fall',
      ];
      if (nexGate) {
        details.push(
          `📡 NEXRAD Gate: ${nexGate.station} · ${nexGate.gateTimeUtc.slice(11, 19)} UTC @ ${nexGate.gateAltitudeKm} km (Δt +${nexGate.elapsedSec}s · ${nexGate.reflectivityDbz} dBZ)`,
        );
      } else if (nexCov?.primary) {
        const p = nexCov.primary;
        details.push(
          `📡 WSR-88D Radar: ${p.id} (${p.name}, ${p.distanceKm} km) · Beams ${p.tilt05AltKm}–${p.tilt24AltKm} km`,
        );
      }
      if (matchLine) details.push(matchLine);
      return {
        title: `◆ METEORITE FALL · ${fallName}`,
        details,
        accent: SEVERITY_COLORS.selected,
        selected: true,
        markerPx: selectedSize,
      };
    }
    return {
      title: `◆ [FALL] ${fallName}`,
      details: [`${dateOnly} · ${coordsStr}`],
      accent: colorHex,
      selected: false,
      markerPx: pixelSize,
    };
  }

  // Default: NASA/JPL CNEOS (3D Airburst Sphere + Rough Directionality)
  const impactStr = formatEnergyKt(event?.energy?.impact);
  const radiatedStr = formatRadiatedJ(event?.energy?.radiated);
  const cDiag = computeCneosSensorDiagnostics(event);

  if (selected) {
    const tonsTnt = Number.isFinite(event?.energy?.impact)
      ? `${Math.round(event.energy.impact * 1000)}t TNT`
      : '';
    const details = [
      `${coordsStr} (±5.5 km 0.1° sphere) · ${altStr} · ${velStr}${cDiag?.hasVelocityConflict ? ` (|v|=${cDiag.vectorVelKmS} km/s)` : ''}`,
    ];
    if (hasVelocityVector(event)) {
      const { vx, vy, vz, entryAngle, azimuth } = event.trajectory;
      const anglePart =
        entryAngle !== null && azimuth !== null
          ? `Rough Dir Az ${azimuth}° (±18°) · Elev ${entryAngle}°`
          : `ECEF (${vx}, ${vy}, ${vz}) km/s`;
      details.push(
        `Radiated ${radiatedStr}${tonsTnt ? ` (${tonsTnt})` : ''} · ${anglePart}`,
      );
    } else {
      details.push(
        `Radiated ${radiatedStr}${tonsTnt ? ` (${tonsTnt})` : ''} · 3D vector unavailable`,
      );
    }
    if (matchLine) details.push(matchLine);
    details.push(
      'NASA/JPL CNEOS US Gov Sensor Sphere (single-point peak fix · rough directionality)',
    );
    return {
      title: `☄ FIREBALL (CNEOS SPHERE) · ${impactStr} TNT · ${utcStr}`,
      details,
      accent: SEVERITY_COLORS.selected,
      selected: true,
      markerPx: selectedSize,
    };
  }

  return {
    title: `☄ ${matches.length > 0 ? '★ ' : ''}${impactStr} · ${dateOnly}`,
    details: [
      `${coordsStr} · ${Number.isFinite(alt) ? `${alt.toFixed(0)} km` : 'alt n/a'}${Number.isFinite(vel) ? ` · ${vel.toFixed(1)} km/s` : ''}`,
    ],
    accent: matches.length > 0 ? SEVERITY_COLORS.corroborated : colorHex,
    selected: false,
    markerPx: pixelSize,
  };
}

/**
 * Build world-overlay host entries for all rendered fireballs/meteors.
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
    const magPriority = Number.isFinite(event?.magnitude)
      ? Math.round(-event.magnitude * 100)
      : 0;
    const matchBonus =
      Array.isArray(event?.possibleMatches) && event.possibleMatches.length > 0
        ? 5000
        : 0;
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
        : matchBonus + Math.round(impact * 1000) + magPriority + 100,
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
