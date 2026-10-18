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

const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111320;

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
  const safePitch = Math.max(-89, Math.min(-12, Number(pitchDeg) || -45));
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
 * Build a 4-shot SceneDirector recipe for a meteorite skyfall / fireball event.
 *
 * Shots:
 *  1. Regional Atmospheric Entry (high altitude looking along entry trajectory)
 *  2. 3D Luminous Trajectory & Terminus (oblique side-angle with Dark Flight Mass Sweep)
 *  3. Wind-Sorted Strewn Field Corridor (mid-altitude down-track view of All 3 Models)
 *  4. Ground Recovery Target Zone (low-altitude close-up on Found Stones / 100g-50g zone)
 */
export function buildMeteorEventSceneRecipe(event, allEvents = []) {
  if (!event || !event.location) return null;

  // Resolve 3D trajectory geometry (from event or corroborated camera partner)
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

  const t = trajSource.trajectory || {};
  const endLat = Number.isFinite(t.endLat)
    ? Number(t.endLat)
    : Number(trajSource.location?.lat ?? event.location.lat);
  const endLon = Number.isFinite(t.endLon)
    ? Number(t.endLon)
    : Number(trajSource.location?.lon ?? event.location.lon);
  const endAltKm = Number.isFinite(t.endAltKm)
    ? Number(t.endAltKm)
    : Number(trajSource.location?.altitude) || 35;

  const startLat = Number.isFinite(t.startLat) ? Number(t.startLat) : endLat;
  const startLon = Number.isFinite(t.startLon) ? Number(t.startLon) : endLon;
  const startAltKm = Number.isFinite(t.startAltKm)
    ? Number(t.startAltKm)
    : endAltKm + 35;

  const azimuth = Number.isFinite(t.azimuth) ? Number(t.azimuth) : 0;

  // Midpoint of luminous entry track for Shot 1
  const midLat = (startLat + endLat) / 2;
  const midLon = (startLon + endLon) / 2;
  const midAltM = ((startAltKm + endAltKm) / 2) * 1000;

  // Ground strewn-field / recovery target for Shots 3 & 4
  const stones = getFoundStonesForEvent(event);
  let recoveryLat = Number(event.location.lat);
  let recoveryLon = Number(event.location.lon);

  if (stones.length > 0) {
    recoveryLat = stones.reduce((s, st) => s + st.lat, 0) / stones.length;
    recoveryLon = stones.reduce((s, st) => s + st.lon, 0) / stones.length;
  } else {
    // Project ~6 km downrange from terminus along azimuth
    const azRad = azimuth * DEG_TO_RAD;
    recoveryLat = endLat + Math.cos(azRad) * 0.05;
    recoveryLon =
      endLon +
      (Math.sin(azRad) * 0.05) /
        Math.max(0.05, Math.cos(endLat * DEG_TO_RAD));
  }

  const shot1Pose = cameraPoseLookingAtTarget({
    targetLat: midLat,
    targetLon: midLon,
    targetAltM: Math.min(45000, midAltM),
    cameraAltM: 145000,
    headingDeg: azimuth,
    pitchDeg: -48,
  });

  const shot2Pose = cameraPoseLookingAtTarget({
    targetLat: (endLat + recoveryLat) / 2,
    targetLon: (endLon + recoveryLon) / 2,
    targetAltM: Math.min(22000, endAltKm * 500),
    cameraAltM: 56000,
    headingDeg: (azimuth + 62) % 360,
    pitchDeg: -32,
  });

  const shot3Pose = cameraPoseLookingAtTarget({
    targetLat: recoveryLat,
    targetLon: recoveryLon,
    targetAltM: 0,
    cameraAltM: 18500,
    headingDeg: (azimuth + 12) % 360,
    pitchDeg: -44,
  });

  const shot4Pose = cameraPoseLookingAtTarget({
    targetLat: recoveryLat,
    targetLon: recoveryLon,
    targetAltM: 0,
    cameraAltM: stones.length > 0 ? 5200 : 8500,
    headingDeg: (azimuth + 25) % 360,
    pitchDeg: -54,
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
        title: '1. Regional Atmospheric Entry',
        ...shot1Pose,
        duration: 3.2,
        hold: 1.6,
        layers: {
          meteors: {
            enabled: true,
            params: { ...baseLayerParams, darkFlight: false },
          },
        },
      },
      {
        title: '2. 3D Luminous Trajectory & Terminus',
        ...shot2Pose,
        duration: 3.4,
        hold: 2.2,
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
        title: '3. Wind-Sorted Strewn Field Corridor',
        ...shot3Pose,
        duration: 3.4,
        hold: 2.4,
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
            ? `4. Found Stone Map (${stones.length} Recoveries)`
            : '4. Ground Recovery Target Zone',
        ...shot4Pose,
        duration: 3.2,
        hold: 3.2,
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
