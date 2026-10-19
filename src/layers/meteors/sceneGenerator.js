/**
 * Automatic 4-Shot Cinematic Scene Generator for Meteorite Skyfall Events
 *
 * Procedurally constructs a 4-shot SceneDirector recipe for any fireball,
 * GMN optical trajectory, NASA ASGARD camera skyfall, or NASA ARES confirmed
 * meteorite fall using exact look-at trigonometry (`cameraPoseLookingAtTarget`)
 * so every shot centers the 3D atmospheric track or ground strewn field in the
 * viewport.
 */

import { recipeToScene } from '../../scenes/project.js';
import { getFoundStonesForEvent } from './foundStones.js';
import { runMultiModelDarkFlight } from './darkFlight.js';

const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111320;
const DEFAULT_VERTICAL_FOV_RAD = (60 * Math.PI) / 180;

/**
 * Compute camera `{ lat, lon, alt, heading, pitch, roll }` so that a camera at
 * altitude `cameraAltM` looking along `headingDeg` with downward tilt `pitchDeg`
 * points its optical axis directly through `(targetLat, targetLon, targetAltM)`.
 */
export function cameraPoseLookingAtTarget({
  targetLat,
  targetLon,
  targetAltM = 0,
  cameraAltM = 25000,
  headingDeg = 0,
  pitchDeg = -45,
}) {
  const safePitch = Math.max(-89, Math.min(-15, Number(pitchDeg) || -45));
  const safeHeading = (((Number(headingDeg) || 0) % 360) + 360) % 360;
  const dz = Math.max(500, cameraAltM - Math.max(0, targetAltM));
  const pitchRad = Math.abs(safePitch) * DEG_TO_RAD;
  const horizDistM = dz / Math.tan(pitchRad);

  const headRad = safeHeading * DEG_TO_RAD;
  const cosLat = Math.max(0.05, Math.cos(targetLat * DEG_TO_RAD));

  const dLatDeg = (horizDistM * Math.cos(headRad)) / METERS_PER_DEG_LAT;
  const dLonDeg =
    (horizDistM * Math.sin(headRad)) / (METERS_PER_DEG_LAT * cosLat);

  const camLat = Math.max(-89.5, Math.min(89.5, targetLat - dLatDeg));
  const camLon = ((((targetLon - dLonDeg + 180) % 360) + 360) % 360) - 180;

  return {
    lat: Math.round(camLat * 100000) / 100000,
    lon: Math.round(camLon * 100000) / 100000,
    alt: Math.round(cameraAltM),
    heading: Math.round(safeHeading),
    pitch: Math.round(safePitch),
    roll: 0,
  };
}

/**
 * Compute a camera pose `{ lat, lon, alt, heading, pitch, roll }` that frames
 * an arbitrary 3D point cloud `points = [{ lat, lon, altM }, ...]` inside the
 * unobstructed safe viewport fraction (accounting for side panels and floating
 * worldOverlay cards).
 */
export function frame3DPointCloud(
  points,
  {
    headingDeg = 0,
    pitchDeg = -45,
    occupiedFraction = 0.42,
    minRangeM = 12000,
    maxRangeM = 650000,
  } = {},
) {
  const valid = (points || []).filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
  );
  if (!valid.length) {
    return cameraPoseLookingAtTarget({
      targetLat: 0,
      targetLon: 0,
      targetAltM: 0,
      cameraAltM: minRangeM,
      headingDeg,
      pitchDeg,
    });
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minAltM = Infinity;
  let maxAltM = -Infinity;

  for (const p of valid) {
    const alt = Number.isFinite(p.altM) ? Math.max(0, p.altM) : 0;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (alt < minAltM) minAltM = alt;
    if (alt > maxAltM) maxAltM = alt;
  }

  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  const centerAltM = (minAltM + maxAltM) / 2;
  const cosLat = Math.max(0.05, Math.cos(centerLat * DEG_TO_RAD));

  let maxRadiusM = 0;
  for (const p of valid) {
    const alt = Number.isFinite(p.altM) ? Math.max(0, p.altM) : 0;
    const dx = (p.lon - centerLon) * METERS_PER_DEG_LAT * cosLat;
    const dy = (p.lat - centerLat) * METERS_PER_DEG_LAT;
    const dz = alt - centerAltM;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > maxRadiusM) maxRadiusM = dist;
  }

  // Official cameraFraming math: range = (radius / sin(fov * occupiedFraction / 2)) * padding
  const safeFraction = Math.max(0.2, Math.min(0.65, occupiedFraction));
  const desiredAngularRadius = (DEFAULT_VERTICAL_FOV_RAD * safeFraction) / 2;
  const rawRangeM = (maxRadiusM / Math.sin(desiredAngularRadius)) * 1.22;
  const rangeM = Math.max(minRangeM, Math.min(maxRangeM, rawRangeM));

  const safePitch = Math.max(-88, Math.min(-22, Number(pitchDeg) || -45));
  const pitchRad = Math.abs(safePitch) * DEG_TO_RAD;

  // Ensure camera altitude is always above the highest 3D point in the cloud
  // so high-altitude trajectory starts (e.g. 78 km) are never above the camera!
  const cameraAltM = Math.max(
    maxAltM + 6000,
    centerAltM + rangeM * Math.sin(pitchRad),
  );

  return cameraPoseLookingAtTarget({
    targetLat: centerLat,
    targetLon: centerLon,
    targetAltM: centerAltM,
    cameraAltM,
    headingDeg,
    pitchDeg: safePitch,
  });
}

/**
 * Format a concise human-readable title for a generated meteor scene.
 */
export function formatMeteorSceneTitle(event) {
  const datePart =
    typeof event?.eventTime === 'string' ? event.eventTime.slice(0, 10) : '';
  if (event?.source === 'ares' && event.name) {
    const shortName = event.name.split('(')[0].trim();
    return `☄ Skyfall: ${shortName} (${datePart})`;
  }
  if (event?.source === 'asgard') {
    return `☄ ASGARD Skyfall ${event.eventId || datePart}`;
  }
  if (event?.source === 'gmn') {
    const shower = event.orbit?.showerCode || 'Optical';
    return `☄ GMN ${shower} (${datePart})`;
  }
  const kt = Number.isFinite(event?.energy?.impact)
    ? `${event.energy.impact.toFixed(2)}kt`
    : 'Bolide';
  return `☄ CNEOS ${kt} (${datePart})`;
}

/**
 * Collect all 3D visual points for an event, its corroborated partners, its
 * dark-flight mass sweep, its 2σ dispersion ellipse, and its found stones.
 */
export function collectEventVisualPoints(event, allEvents = []) {
  const trackPoints = [];
  const darkFlight3DPoints = [];
  const strewnFieldPoints = [];
  const recoveryPoints = [];

  function addEventGeometry(ev) {
    if (!ev?.location) return;
    const lat = Number(ev.location.lat);
    const lon = Number(ev.location.lon);
    const altM = (Number(ev.location.altitude) || 0) * 1000;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      trackPoints.push({ lat, lon, altM: 0 });
      trackPoints.push({ lat, lon, altM });
    }
    const t = ev.trajectory || {};
    if (Number.isFinite(t.startLat) && Number.isFinite(t.startLon)) {
      trackPoints.push({
        lat: Number(t.startLat),
        lon: Number(t.startLon),
        altM: (Number(t.startAltKm) || 85) * 1000,
      });
    }
    if (Number.isFinite(t.endLat) && Number.isFinite(t.endLon)) {
      const endAltM = (Number(t.endAltKm) || ev.location.altitude || 45) * 1000;
      trackPoints.push({
        lat: Number(t.endLat),
        lon: Number(t.endLon),
        altM: endAltM,
      });
      trackPoints.push({
        lat: Number(t.endLat),
        lon: Number(t.endLon),
        altM: 0,
      });
    } else if (
      Number.isFinite(t.azimuth) &&
      Number.isFinite(t.entryAngle) &&
      altM > 0
    ) {
      const radAz = ((t.azimuth + 180) % 360) * DEG_TO_RAD;
      const radEl = Math.max(10, t.entryAngle) * DEG_TO_RAD;
      const horizM = 85000 * Math.cos(radEl);
      const vertM = 85000 * Math.sin(radEl);
      const cosLat = Math.max(0.05, Math.cos(lat * DEG_TO_RAD));
      trackPoints.push({
        lat: lat + (horizM * Math.cos(radAz)) / METERS_PER_DEG_LAT,
        lon: lon + (horizM * Math.sin(radAz)) / (METERS_PER_DEG_LAT * cosLat),
        altM: altM + vertM,
      });
    }
  }

  addEventGeometry(event);
  if (Array.isArray(event?.possibleMatches)) {
    for (const m of event.possibleMatches) {
      const partner = allEvents.find((e) => e.id === m.id);
      if (partner) addEventGeometry(partner);
    }
  }

  const df = runMultiModelDarkFlight(event, null, {
    allEvents,
    nFragments: 16,
    autoFit: false,
  });

  if (df?.feasible) {
    for (const band of df.massSweep || []) {
      strewnFieldPoints.push({ lat: band.lat, lon: band.lon, altM: 0 });
      if (band.massKg <= 0.3) {
        recoveryPoints.push({ lat: band.lat, lon: band.lon, altM: 0 });
      }
      if (Array.isArray(band.track)) {
        for (const pt of band.track) {
          darkFlight3DPoints.push({
            lat: pt.lat,
            lon: pt.lon,
            altM: pt.altM,
          });
        }
      }
    }
    const el = df.ellipse2Sigma;
    if (el?.center) {
      const cosLat = Math.max(0.05, Math.cos(el.center.lat * DEG_TO_RAD));
      const dLat = el.semiMajorM / METERS_PER_DEG_LAT;
      const dLon = el.semiMajorM / (METERS_PER_DEG_LAT * cosLat);
      strewnFieldPoints.push(
        { lat: el.center.lat + dLat, lon: el.center.lon, altM: 0 },
        { lat: el.center.lat - dLat, lon: el.center.lon, altM: 0 },
        { lat: el.center.lat, lon: el.center.lon + dLon, altM: 0 },
        { lat: el.center.lat, lon: el.center.lon - dLon, altM: 0 },
      );
    }
    for (const comp of df.stoneFit?.comparisons || []) {
      const stPt = { lat: comp.stone.lat, lon: comp.stone.lon, altM: 0 };
      strewnFieldPoints.push(stPt);
      recoveryPoints.push(stPt);
      if (comp.simulated) {
        const simPt = {
          lat: comp.simulated.lat,
          lon: comp.simulated.lon,
          altM: 0,
        };
        strewnFieldPoints.push(simPt);
        recoveryPoints.push(simPt);
      }
    }
  }

  const stones = getFoundStonesForEvent(event);
  for (const s of stones) {
    const pt = { lat: s.lat, lon: s.lon, altM: 0 };
    strewnFieldPoints.push(pt);
    recoveryPoints.push(pt);
  }

  if (!strewnFieldPoints.length && event?.location) {
    strewnFieldPoints.push({
      lat: Number(event.location.lat),
      lon: Number(event.location.lon),
      altM: 0,
    });
  }
  if (!recoveryPoints.length) {
    recoveryPoints.push(...strewnFieldPoints);
  }

  return {
    trackPoints,
    darkFlight3DPoints,
    strewnFieldPoints,
    recoveryPoints,
    stones,
    df,
  };
}

/**
 * Build a 4-shot SceneDirector recipe for a meteorite skyfall / fireball event
 * where every shot frames 100% of its relevant 3D and ground visual elements.
 */
export function buildMeteorEventSceneRecipe(event, allEvents = []) {
  if (!event || !event.location) return null;

  let trajSource = event;
  if (
    (!Number.isFinite(event.trajectory?.azimuth) ||
      !(event.location?.altitude > 0)) &&
    Array.isArray(event.possibleMatches)
  ) {
    const partners = event.possibleMatches
      .map((m) => allEvents.find((e) => e.id === m.id))
      .filter((p) => Number.isFinite(p?.trajectory?.azimuth))
      .sort((a, b) => {
        const rank = (s) => (s === 'asgard' || s === 'gmn' ? 0 : 1);
        return rank(a.source) - rank(b.source);
      });
    if (partners[0]) trajSource = partners[0];
  }

  const azimuth = Number.isFinite(trajSource.trajectory?.azimuth)
    ? Number(trajSource.trajectory.azimuth)
    : 0;

  const {
    trackPoints,
    darkFlight3DPoints,
    strewnFieldPoints,
    recoveryPoints,
    stones,
  } = collectEventVisualPoints(event, allEvents);

  // Shot 1: Complete 3D Entry Track + Corroborated Footprint Overview
  const shot1Pose = frame3DPointCloud([...trackPoints, ...strewnFieldPoints], {
    headingDeg: azimuth,
    pitchDeg: -50,
    occupiedFraction: 0.56,
    minRangeM: 45000,
  });

  // Shot 2: Full 3D Dark-Flight Fan (Terminus -> Ground) + Strewn Field (Oblique Side View)
  const shot2Pose = frame3DPointCloud(
    [...darkFlight3DPoints, ...strewnFieldPoints],
    {
      headingDeg: (azimuth + 68) % 360,
      pitchDeg: -38,
      occupiedFraction: 0.54,
      minRangeM: 32000,
    },
  );

  // Shot 3: Full Ground Strewn Field (1kg->3g + 2σ Ellipse + Found Stones)
  const shot3Pose = frame3DPointCloud(strewnFieldPoints, {
    headingDeg: (azimuth + 14) % 360,
    pitchDeg: -52,
    occupiedFraction: 0.5,
    minRangeM: 18000,
  });

  // Shot 4: Recovery Corridor & Found Stones + Mass-Matched Simulated Pins
  const shot4Pose = frame3DPointCloud(recoveryPoints, {
    headingDeg: (azimuth + 22) % 360,
    pitchDeg: -60,
    occupiedFraction: 0.44,
    minRangeM: 11000,
  });

  const baseLayerParams = {
    timeWindow: '5y',
    sourceFilter: 'all',
    eventId: event.id,
  };

  return {
    id: `meteor-scene:${event.id}`,
    title: formatMeteorSceneTitle(event),
    style: 'normal',
    ui: { hidePanels: false, hudMode: 'full', safeFrame: '16:9' },
    releaseLayerIds: [],
    post: {
      bloom: 15,
      sharpen: true,
      detectionMode: 'OFF',
      mapStack: 'esri-imagery',
    },
    layers: {
      meteors: {
        enabled: true,
        params: baseLayerParams,
      },
    },
    cameraPath: [
      {
        title: '1. Complete 3D Entry & Regional Overview',
        ...shot1Pose,
        duration: 3.2,
        hold: 1.8,
        layers: {
          meteors: {
            enabled: true,
            params: { ...baseLayerParams, darkFlight: false },
          },
        },
      },
      {
        title: '2. Full 3D Trajectory & Dark Flight Mass Fan',
        ...shot2Pose,
        duration: 3.4,
        hold: 2.4,
        layers: {
          meteors: {
            enabled: true,
            params: {
              ...baseLayerParams,
              darkFlight: true,
              darkFlightMode: 'sweep',
              autoFit: true,
            },
          },
        },
      },
      {
        title: '3. Full Strewn Field & 3D Descent Corridor',
        ...shot3Pose,
        duration: 3.4,
        hold: 2.6,
        layers: {
          meteors: {
            enabled: true,
            params: {
              ...baseLayerParams,
              darkFlight: true,
              darkFlightMode: 'all',
              autoFit: true,
            },
          },
        },
      },
      {
        title:
          stones.length > 0
            ? `4. Full Strewn Field & Found Stones (${stones.length} Recoveries)`
            : '4. Ground Strewn Field & Mass Sorting Spine',
        ...shot4Pose,
        duration: 3.2,
        hold: 3.4,
        layers: {
          meteors: {
            enabled: true,
            params: {
              ...baseLayerParams,
              darkFlight: true,
              darkFlightMode: 'all',
              autoFit: true,
            },
          },
        },
      },
    ],
  };
}

/**
 * Upsert one or more generated meteor event scenes into the application's
 * `SceneDirector` instance and refresh its UI dropdown.
 */
export function registerMeteorScenesInDirector(
  sceneDirector,
  events,
  allEvents = [],
  { selectFirst = false } = {},
) {
  if (!sceneDirector || !sceneDirector._project || !Array.isArray(events)) {
    return [];
  }
  const registered = [];
  for (const ev of events) {
    const recipe = buildMeteorEventSceneRecipe(ev, allEvents);
    if (!recipe) continue;
    const sceneObj = recipeToScene(recipe);
    sceneObj.id = recipe.id;
    const existingIdx = sceneDirector._project.scenes.findIndex(
      (s) => s.id === sceneObj.id || s.title === sceneObj.title,
    );
    if (existingIdx >= 0) {
      sceneDirector._project.scenes[existingIdx] = sceneObj;
    } else {
      sceneDirector._project.scenes.push(sceneObj);
    }
    registered.push(sceneObj);
  }

  if (registered.length > 0) {
    if (selectFirst) {
      sceneDirector._selectedSceneId = registered[0].id;
      sceneDirector._selectedShotId = registered[0].shots[0]?.id || null;
    }
    sceneDirector._saveProject?.();
    sceneDirector._renderSceneSelect?.();
    sceneDirector._renderShotList?.();
  }
  return registered;
}
