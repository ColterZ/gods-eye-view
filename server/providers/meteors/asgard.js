import { readResponseTextCapped } from '../common/http.js';
import { haversineKm } from './gmn.js';

const SKYFALL_MAP_URL = 'https://fireballs.ndc.nasa.gov/skyfalls/skyfallmap/';
const SKYFALL_LIST_URL = 'https://fireballs.ndc.nasa.gov/skyfalls?page=1';
const SKYFALL_EVENT_BASE = 'https://fireballs.ndc.nasa.gov/skyfalls/events/';
const HOUR = 3600_000;

/**
 * Curated NASA ARES Confirmed Meteorite Falls (https://ares.jsc.nasa.gov/meteorite-falls/).
 * Explicitly distinguishes confirmed recovered meteorite falls from bolide-only reports.
 */
export const NASA_ARES_METEORITE_FALLS = Object.freeze([
  {
    id: 'ares:sims-corner-wa',
    name: 'Sims Corner, WA (Hwy 17 / Malone Ranch)',
    lat: 47.8665,
    lon: -119.3665,
    date: '2026-08-14',
    description:
      'Low-mass meteorite fall along WA-17 near Sims Corner & Malone Ranch (07:50:41 UTC radar gate at 10.29 km; largest pieces ~46.6g–80g recovered by Anton & Roberto).',
  },
  {
    id: 'ares:cockburn-island-on',
    name: 'Cockburn Island, Ontario',
    lat: 45.9167,
    lon: -83.3333,
    date: '2026-06-20',
    description:
      'Daytime bolide and high-mass meteorite fall on Cockburn Island in Lake Huron.',
  },
  {
    id: 'ares:cape-cod-bay-ma',
    name: 'Cape Cod Bay, MA',
    lat: 41.85,
    lon: -70.2833,
    date: '2026-05-30',
    description:
      'Daytime bolide producing Doppler radar-detected meteorite fall into Cape Cod Bay.',
  },
  {
    id: 'ares:houston-tx',
    name: 'Houston, TX',
    lat: 29.7604,
    lon: -95.3698,
    date: '2026-03-21',
    description: 'Strong daytime bolide and radar-confirmed fall signature in Texas.',
  },
  {
    id: 'ares:wadsworth-oh',
    name: 'Wadsworth, OH',
    lat: 41.0253,
    lon: -81.7296,
    date: '2026-03-17',
    description:
      'Strong daytime bolide and NEXRAD-detected meteorite fall west of Cleveland, OH.',
  },
  {
    id: 'ares:pebble-al',
    name: 'Pebble, AL',
    lat: 34.5834,
    lon: -87.2075,
    date: '2025-11-06',
    description: 'Steeply inclined meteor surviving below 14 km altitude.',
  },
  {
    id: 'ares:gateway-ar',
    name: 'Gateway, AR',
    lat: 36.4865,
    lon: -93.451,
    date: '2025-08-17',
    description: 'Long-lasting fireball and NEXRAD fall signature over northern Arkansas.',
  },
  {
    id: 'ares:mcdonough-ga',
    name: 'McDonough, GA',
    lat: 33.4484,
    lon: -84.1516,
    date: '2025-06-26',
    description: 'Bright daytime bolide south of Atlanta with radar-confirmed fall.',
  },
  {
    id: 'ares:la-petite-belgique-qc',
    name: 'La Petite Belgique, Quebec',
    lat: 45.5017,
    lon: -73.5673,
    date: '2025-06-24',
    description: 'Shallow-angle fragmenting fireball with mapped ARES strewn field.',
  },
  {
    id: 'ares:whitefish-lake-ak',
    name: 'Whitefish Lake, AK',
    lat: 61.3686,
    lon: -149.5402,
    date: '2025-04-24',
    description: 'Daytime fireball west of Anchorage detected on NOAA weather radar.',
  },
  {
    id: 'ares:muses-mills-ky',
    name: 'Muses Mills, KY',
    lat: 37.6396,
    lon: -83.4857,
    date: '2025-03-18',
    description: 'Radar-detected meteorite fall signature in eastern Kentucky.',
  },
  {
    id: 'ares:codyville-me',
    name: 'Codyville, ME',
    lat: 45.05,
    lon: -67.15,
    date: '2025-02-21',
    description: 'Low-mass meteorite fall near eastern Maine / New Brunswick border.',
  },
  {
    id: 'ares:amo-in',
    name: 'Amo, IN',
    lat: 39.8065,
    lon: -86.675,
    date: '2024-12-10',
    description: 'Nighttime bolide and radar fall signature west of Indianapolis.',
  },
  {
    id: 'ares:pontiac-ks',
    name: 'Pontiac, KS',
    lat: 38.8506,
    lon: -96.2561,
    date: '2024-12-02',
    description: 'Radar, video, and GLM lightning mapper confirmed fall east of Wichita.',
  },
  {
    id: 'ares:ingalls-nc',
    name: 'Ingalls, NC',
    lat: 35.9604,
    lon: -80.0056,
    date: '2024-08-30',
    description: 'Meteorite fall signature observed simultaneously on four NOAA NEXRAD radars.',
  },
  {
    id: 'ares:hillsborough-nj',
    name: 'Hillsborough, NJ',
    lat: 40.5168,
    lon: -74.6156,
    date: '2024-07-16',
    description: 'Daytime bolide with strewn field centered near Edison, NJ.',
  },
  {
    id: 'ares:clanton-well-az',
    name: 'Clanton Well, AZ',
    lat: 33.5,
    lon: -112.5,
    date: '2024-04-17',
    description: 'Prominent bolide and radar-detected fall over western Arizona.',
  },
  {
    id: 'ares:hopewell-nj',
    name: 'Hopewell, NJ',
    lat: 40.3834,
    lon: -74.7938,
    date: '2023-05-08',
    description: 'Confirmed H6 chondrite meteorite fall recovered in Hopewell, NJ.',
  },
]);

export function buildAresFallEvents(now = Date.now()) {
  return NASA_ARES_METEORITE_FALLS.map((fall) => ({
    id: fall.id,
    source: 'ares',
    sourceUrl: 'https://ares.jsc.nasa.gov/meteorite-falls/events/',
    name: fall.name,
    eventTime: `${fall.date}T12:00:00.000Z`,
    publicationTime: null,
    retrievalTime: new Date(now).toISOString(),
    location: {
      lat: fall.lat,
      lon: fall.lon,
      altitude: 0,
      uncertainty: 'NASA ARES radar-derived strewn field center',
    },
    trajectory: {
      radiantRa: null,
      radiantDec: null,
      entryVelocity: null,
      vx: null,
      vy: null,
      vz: null,
      azimuth: null,
      radiantAzimuth: null,
      entryAngle: null,
      groundTrackDistance: null,
    },
    energy: {
      radiated: null,
      impact: null,
    },
    mass: null,
    magnitude: null,
    description: fall.description,
    confidence: {
      level: 'high',
      fields: ['date', 'location', 'nexrad_doppler_signature'],
      notes: `NASA ARES documented meteorite fall (${fall.name}). ${fall.description}`,
    },
    possibleMatches: [],
    attribution: {
      text: 'NASA ARES Astromaterials Research & Exploration Science',
      license: 'Public domain',
      url: 'https://ares.jsc.nasa.gov/meteorite-falls/',
    },
    freshness: {
      lastUpdated: new Date(now).toISOString(),
      cacheExpires: new Date(now + 6 * HOUR).toISOString(),
      stale: false,
    },
  }));
}

function parseEventIdToIso(eventId) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(
    String(eventId || '').trim(),
  );
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function computeCompassAzimuth(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180) / Math.PI;
  return Math.round(((brng % 360) + 360) % 360);
}

/**
 * Parse NASA MSFC ASGARD Folium skyfallmap HTML (`L.polyline` + event popup links)
 * into structured camera-triangulated fireball trajectory events.
 */
export function parseAsgardSkyfallMapHtml(html, now = Date.now()) {
  if (typeof html !== 'string' || !html.trim()) return [];
  const blocks = html.split(/var\s+poly_line_/);
  const eventsById = new Map();

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const polyMatch = block.match(
      /L\.polyline\(\s*\[\s*\[\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\]\s*,\s*\[\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\]\s*\]/,
    );
    const idMatch = block.match(/\/skyfalls\/events\/(\d{8}-\d{6})/);
    if (!polyMatch || !idMatch) continue;

    const eventId = idMatch[1];
    if (eventsById.has(eventId)) continue;

    const startLat = Number(polyMatch[1]);
    const startLon = Number(polyMatch[2]);
    const endLat = Number(polyMatch[3]);
    const endLon = Number(polyMatch[4]);
    const eventTime = parseEventIdToIso(eventId);
    if (
      !eventTime ||
      !Number.isFinite(startLat) ||
      !Number.isFinite(startLon) ||
      !Number.isFinite(endLat) ||
      !Number.isFinite(endLon)
    )
      continue;

    const groundTrackDistance = haversineKm(startLat, startLon, endLat, endLon);
    const azimuth = computeCompassAzimuth(startLat, startLon, endLat, endLon);
    const defaultStartAltKm = 85;
    const defaultEndAltKm = 48;
    const defaultEntryAngle =
      groundTrackDistance > 0
        ? Math.round(
            ((Math.atan2(
              defaultStartAltKm - defaultEndAltKm,
              groundTrackDistance,
            ) *
              180) /
              Math.PI) *
              10,
          ) / 10
        : 38;

    eventsById.set(eventId, {
      id: `asgard:${eventId}`,
      eventId,
      source: 'asgard',
      sourceUrl: `${SKYFALL_EVENT_BASE}${eventId}`,
      eventTime,
      publicationTime: null,
      retrievalTime: new Date(now).toISOString(),
      location: {
        lat: Math.round(endLat * 10000) / 10000,
        lon: Math.round(endLon * 10000) / 10000,
        altitude: 48, // Default camera terminus altitude until detail page overrides
        uncertainty: 'NASA MSFC ASGARD all-sky camera triangulation',
      },
      trajectory: {
        startLat: Math.round(startLat * 10000) / 10000,
        startLon: Math.round(startLon * 10000) / 10000,
        startAltKm: 85,
        endLat: Math.round(endLat * 10000) / 10000,
        endLon: Math.round(endLon * 10000) / 10000,
        endAltKm: 48,
        radiantRa: null,
        radiantDec: null,
        entryVelocity: null,
        vx: null,
        vy: null,
        vz: null,
        azimuth,
        radiantAzimuth: (azimuth + 180) % 360,
        entryAngle: defaultEntryAngle,
        groundTrackDistance,
      },
      energy: {
        radiated: null,
        impact: null,
      },
      mass: null,
      magnitude: null,
      confidence: {
        level: 'high',
        fields: ['date', 'trajectory_start_end', 'camera_triangulation'],
        notes:
          'NASA MSFC ASGARD All-Sky Fireball Network triangulation. Fireball report alone does not imply a meteorite fall.',
      },
      possibleMatches: [],
      attribution: {
        text: 'NASA MSFC Meteoroid Environment Office / ASGARD',
        license: 'Public domain',
        url: 'https://fireballs.ndc.nasa.gov/skyfalls',
      },
      freshness: {
        lastUpdated: new Date(now).toISOString(),
        cacheExpires: new Date(now + 6 * HOUR).toISOString(),
        stale: false,
      },
    });
  }

  return [...eventsById.values()].sort(
    (a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime),
  );
}

/**
 * Enrich an ASGARD event object from its individual `/skyfalls/events/{id}` detail HTML.
 * Supports both "NASA Camera ..." and "Chicken Little ..." solver field labels.
 */
export function enrichAsgardEventFromDetailHtml(event, detailHtml) {
  if (!event || typeof detailHtml !== 'string') return event;
  const cleaned = detailHtml
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00a0/g, ' ');

  const altMatch = cleaned.match(
    /(?:NASA Camera|Chicken Little)\s+Altitude[\s\S]{0,80}?([\d.]+)\s*km\s*(?:\u2192|->|to)\s*([\d.]+)\s*km/i,
  );
  const speedMatch = cleaned.match(
    /(?:NASA Camera|Chicken Little)\s+Speed[\s\S]{0,80}?([\d.]+)\s*km\/s/i,
  );
  const amsMatch = cleaned.match(/AMS Event[\s\S]{0,60}?(\d+-\d{4})/i);

  if (altMatch) {
    const startAlt = Number(altMatch[1]);
    const endAlt = Number(altMatch[2]);
    if (Number.isFinite(startAlt) && Number.isFinite(endAlt)) {
      event.trajectory.startAltKm = startAlt;
      event.trajectory.endAltKm = endAlt;
      event.location.altitude = endAlt;
      if (
        Number.isFinite(event.trajectory.groundTrackDistance) &&
        event.trajectory.groundTrackDistance > 0
      ) {
        const dz = Math.max(0, startAlt - endAlt);
        event.trajectory.entryAngle =
          Math.round(
            ((Math.atan2(dz, event.trajectory.groundTrackDistance) * 180) /
              Math.PI) *
              10,
          ) / 10;
      }
    }
  }
  if (speedMatch) {
    const vel = Number(speedMatch[1]);
    if (Number.isFinite(vel) && vel > 0) {
      event.trajectory.entryVelocity = vel;
      if (!event.confidence.fields.includes('vel')) {
        event.confidence.fields.push('vel');
      }
    }
  }
  if (amsMatch) {
    event.amsEventId = amsMatch[1];
  }
  return event;
}

/**
 * NASA ASGARD Skyfalls + NASA ARES Meteorite Falls proxy middleware (/api/nasa-skyfalls).
 */
export function asgardProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 20_000,
} = {}) {
  let cache = null;
  let operation = null;
  let attemptedAt = -Infinity;

  async function refresh(signal) {
    signal.throwIfAborted();
    const aresFalls = buildAresFallEvents(now());
    let asgardEvents = [];

    try {
      const response = await fetchImpl(SKYFALL_MAP_URL, {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'text/html, */*',
          'User-Agent': 'Gods Eye View (NASA MSFC ASGARD fireball data)',
        },
      });
      if (response.ok) {
        const html = await readResponseTextCapped(
          response,
          5 * 1024 * 1024,
          signal,
        );
        asgardEvents = parseAsgardSkyfallMapHtml(html, now());

        // Enrich the 8 most recent events with exact camera altitudes & speeds
        const topRecent = asgardEvents.slice(0, 8);
        await Promise.allSettled(
          topRecent.map(async (ev) => {
            const r = await fetchImpl(`${SKYFALL_EVENT_BASE}${ev.eventId}`, {
              signal,
              headers: { 'User-Agent': 'Gods Eye View' },
            });
            if (r.ok) {
              const detailTxt = await readResponseTextCapped(
                r,
                512 * 1024,
                signal,
              );
              enrichAsgardEventFromDetailHtml(ev, detailTxt);
            }
          }),
        );
      }
    } catch {
      // If ASGARD HTML is unreachable, still serve the NASA ARES falls
    }

    const events = [...asgardEvents, ...aresFalls].sort(
      (a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime),
    );
    cache = { events, fetchedAt: now() };
    return cache;
  }

  async function acquire(signal) {
    signal.throwIfAborted();
    if (cache && now() - cache.fetchedAt < 6 * HOUR) return cache;
    if (operation?.controller.signal.aborted) operation = null;
    if (!operation) {
      if (now() - attemptedAt < 60_000) throw new Error('asgard_retry_later');
      attemptedAt = now();
      const controller = new AbortController();
      const owned = { controller, waiters: 0 };
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      owned.promise = refresh(controller.signal).finally(() => {
        clearTimeout(timer);
        if (operation === owned) operation = null;
      });
      operation = owned;
    }
    const owned = operation;
    if (owned.waiters >= 32)
      throw Object.assign(new Error('asgard_busy'), { status: 429 });
    owned.waiters++;
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([owned.promise, cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
      if (--owned.waiters === 0 && operation === owned) {
        owned.controller.abort();
        if (signal.aborted) attemptedAt = -Infinity;
      }
    }
  }

  function describe(value, stale = false) {
    const events = value?.events ?? buildAresFallEvents(now());
    const latestObservationTime =
      events.length > 0 ? events[0].eventTime : null;
    return {
      schemaVersion: 1,
      source: 'NASA MSFC ASGARD & ARES',
      attribution: 'NASA MSFC Meteoroid Environment Office / NASA ARES',
      coverage: 'North America all-sky cameras & NEXRAD-confirmed falls',
      fetchedAt: value?.fetchedAt ?? now(),
      latestObservationTime,
      stale: stale || !value,
      unavailable: false,
      reason: null,
      events,
    };
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      try {
        json(200, describe(await acquire(controller.signal)));
      } catch {
        const usable = cache && now() - cache.fetchedAt <= 24 * HOUR;
        json(200, describe(usable ? cache : null, true));
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'nasa-skyfalls',
    configureServer({ middlewares }) {
      middlewares.use('/api/nasa-skyfalls', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/nasa-skyfalls', handler);
    },
  };
}
