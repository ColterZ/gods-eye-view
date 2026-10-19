import { readResponseTextCapped } from '../common/http.js';

const GMN_LATEST_URL =
  'https://globalmeteornetwork.org/data/traj_summary_data/daily/traj_summary_latest_daily.txt';
const GMN_YESTERDAY_URL =
  'https://globalmeteornetwork.org/data/traj_summary_data/daily/traj_summary_yesterday.txt';
const HOUR = 3600_000;
const EARTH_RADIUS_KM = 6371.0;

function finiteOrNull(value, min = -Infinity, max = Infinity) {
  if (value === null || value === undefined || value === '') return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === '...' || trimmed === 'nan' || trimmed === 'NaN')
    return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  )
    return null;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return (
    Math.round(
      2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10,
    ) / 10
  );
}

/**
 * Classify heliocentric parent body dynamical class from Tisserand's parameter
 * with respect to Jupiter (T_J).
 */
export function classifyTisserandOrbit(tj) {
  if (!Number.isFinite(tj)) return null;
  if (tj > 3.0) return 'Asteroidal (T_J > 3)';
  if (tj > 2.0) return 'Jupiter-Family Comet (2 < T_J ≤ 3)';
  return 'Halley-Type / Long-Period Comet (T_J ≤ 2)';
}

/**
 * Parse GMN trajectory summary semicolon-delimited text into our common event schema.
 * Filters to bright optical events (`peak_absmag <= maxMag`, default -1.5) and
 * returns the top `limit` brightest/newest records.
 */
export function parseGmnTrajectorySummary(
  text,
  { now = Date.now(), maxMag = -1.5, limit = 250 } = {},
) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('invalid_gmn_data');
  }

  let publicationTime = null;
  const genMatch = text.match(
    /#\s*Summary generated on\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/i,
  );
  if (genMatch) {
    const parsedGen = new Date(genMatch[1].replace(' ', 'T') + 'Z');
    if (Number.isFinite(parsedGen.getTime())) {
      publicationTime = parsedGen.toISOString();
    }
  }

  const candidates = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(';');
    if (cols.length < 85) continue;

    const trajId = cols[0].trim();
    const utcRaw = cols[2].trim();
    if (!trajId || !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(utcRaw))
      continue;

    const eventDate = new Date(utcRaw.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(eventDate.getTime())) continue;

    const peakAbsMag = finiteOrNull(cols[76], -30, 15);
    if (peakAbsMag !== null && peakAbsMag > maxMag) continue;

    const latBeg = finiteOrNull(cols[63], -90, 90);
    const lonBeg = finiteOrNull(cols[65], -180, 180);
    const htBeg = finiteOrNull(cols[67], 0, 250);
    const latEnd = finiteOrNull(cols[69], -90, 90);
    const lonEnd = finiteOrNull(cols[71], -180, 180);
    const htEnd = finiteOrNull(cols[73], 0, 250);

    if (latEnd === null || lonEnd === null) continue;

    const iauNo = finiteOrNull(cols[3], -1, 10000);
    const rawCode = cols[4].trim();
    const showerCode =
      rawCode && rawCode !== '...' && rawCode !== '-1' ? rawCode : 'SPO';

    const raGeo = finiteOrNull(cols[7], 0, 360);
    const decGeo = finiteOrNull(cols[9], -90, 90);
    const vGeo = finiteOrNull(cols[15], 0, 150);
    const vHel = finiteOrNull(cols[21], 0, 150);
    const semiMajorAxisAu = finiteOrNull(cols[23], -1000, 10000);
    const eccentricity = finiteOrNull(cols[25], 0, 10);
    const inclinationDeg = finiteOrNull(cols[27], 0, 180);
    const perihelionAu = finiteOrNull(cols[37], 0, 100);
    const argPerihelionDeg = finiteOrNull(cols[31], 0, 360);
    const ascendingNodeDeg = finiteOrNull(cols[33], 0, 360);
    const aphelionAu = finiteOrNull(cols[39], 0, 10000);
    const tisserandJ = finiteOrNull(cols[49], -50, 50);

    const raApp = finiteOrNull(cols[51], 0, 360);
    const decApp = finiteOrNull(cols[53], -90, 90);
    const radiantAzimuth = finiteOrNull(cols[55], 0, 360);
    const azimuth =
      radiantAzimuth !== null
        ? Math.round((radiantAzimuth + 180) % 360)
        : null;
    const entryAngle = finiteOrNull(cols[57], 0, 90);
    const vInit = finiteOrNull(cols[59], 0, 150);
    const vAvg = finiteOrNull(cols[61], 0, 150);

    const durationSec = finiteOrNull(cols[75], 0, 600);
    const peakHtKm = finiteOrNull(cols[77], 0, 250);
    const massKg = finiteOrNull(cols[79], 0, 1e6);
    const qcDeg = finiteOrNull(cols[80], 0, 180);
    const medianFitErrArcsec = finiteOrNull(cols[81], 0, 36000);
    const stationCount = finiteOrNull(cols[84], 1, 500);
    const stations = cols[85] ? cols[85].trim() : null;
    const measuredDecelerationKmS2 =
      durationSec !== null &&
      durationSec > 0.05 &&
      vInit !== null &&
      vAvg !== null &&
      vInit >= vAvg
        ? Math.round(((2 * (vInit - vAvg)) / durationSec) * 100) / 100
        : null;

    const groundTrackDistance =
      latBeg !== null && lonBeg !== null
        ? haversineKm(latBeg, lonBeg, latEnd, lonEnd)
        : null;

    // Approximate kinetic energy from photometric mass & initial velocity (1 kt = 4.184e12 J)
    // Only when GMN provides both photometric mass (tau=0.7%) and Vinit:
    const kineticJoules =
      massKg !== null && vInit !== null
        ? 0.5 * massKg * (vInit * 1000) ** 2
        : null;
    const impactKt =
      kineticJoules !== null ? kineticJoules / 4.184e12 : null;

    candidates.push({
      id: `gmn:${trajId}`,
      source: 'gmn',
      sourceUrl: 'https://globalmeteornetwork.org/data/traj_summary_data/',

      eventTime: eventDate.toISOString(),
      publicationTime,
      retrievalTime: new Date(now).toISOString(),

      location: {
        lat: Math.round(latEnd * 10000) / 10000,
        lon: Math.round(lonEnd * 10000) / 10000,
        altitude: htEnd ?? peakHtKm,
        uncertainty:
          medianFitErrArcsec !== null
            ? `Multi-station triangulation (${stationCount || 2} cameras, ±${medianFitErrArcsec.toFixed(1)}" fit)`
            : 'Multi-station optical triangulation',
      },

      trajectory: {
        startLat: latBeg,
        startLon: lonBeg,
        startAltKm: htBeg,
        endLat: latEnd,
        endLon: lonEnd,
        endAltKm: htEnd,
        peakAltKm: peakHtKm,
        radiantRa: raGeo ?? raApp,
        radiantDec: decGeo ?? decApp,
        apparentRadiantRa: raApp,
        apparentRadiantDec: decApp,
        entryVelocity: vInit ?? vAvg,
        avgVelocity: vAvg,
        geocentricVelocity: vGeo,
        heliocentricVelocity: vHel,
        measuredDecelerationKmS2,
        vx: null,
        vy: null,
        vz: null,
        azimuth,
        radiantAzimuth:
          radiantAzimuth !== null ? Math.round(radiantAzimuth) : null,
        entryAngle:
          entryAngle !== null ? Math.round(entryAngle * 10) / 10 : null,
        groundTrackDistance,
        durationSec,
        altitudeEnriched: true,
      },

      orbit: {
        showerCode,
        showerNo: iauNo,
        aAu: semiMajorAxisAu,
        e: eccentricity,
        iDeg: inclinationDeg,
        qAu: perihelionAu,
        aphelionAu,
        argPerihelionDeg,
        ascendingNodeDeg,
        tisserandJ,
        orbitalClass: classifyTisserandOrbit(tisserandJ),
      },

      energy: {
        radiated: null,
        impact: impactKt,
      },
      mass: massKg,
      magnitude: peakAbsMag,

      stations: {
        count: stationCount,
        codes: stations,
        convergenceAngleDeg: qcDeg,
        medianFitErrArcsec,
      },

      confidence: {
        level:
          stationCount !== null && stationCount >= 3 && (qcDeg ?? 20) >= 15
            ? 'high'
            : 'moderate',
        fields: [
          'beginning_utc_time',
          'trajectory_3d',
          'radiant',
          'vinit',
          'orbit',
          'peak_absmag',
          'mass_kg_tau_0_7',
        ],
        notes: `GMN ${stationCount || 2}-station optical triangulation (${stations || 'global network'}). Photometric mass assumes τ=0.7%; optical meteor ≠ confirmed meteorite fall.`,
      },

      possibleMatches: [],

      attribution: {
        text: 'Global Meteor Network (CC BY 4.0 · Vida et al. 2020, 2021 · NASA MEO)',
        license: 'CC BY 4.0',
        url: 'https://globalmeteornetwork.org/',
      },

      freshness: {
        lastUpdated: new Date(now).toISOString(),
        cacheExpires: new Date(now + 6 * HOUR).toISOString(),
        stale: false,
      },
    });
  }

  candidates.sort((a, b) => {
    const magA = a.magnitude ?? 0;
    const magB = b.magnitude ?? 0;
    if (magA !== magB) return magA - magB; // most negative (brightest) first
    return Date.parse(b.eventTime) - Date.parse(a.eventTime);
  });

  return {
    events: candidates.slice(0, limit),
    publicationTime,
    totalParsed: candidates.length,
  };
}

/**
 * GMN Trajectory Summary proxy middleware (/api/gmn-meteors).
 */
export function gmnProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 20_000,
} = {}) {
  let cache = null;
  let operation = null;
  let attemptedAt = -Infinity;

  async function fetchSummaryText(url, signal) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'text/plain, */*',
        'User-Agent': 'Gods Eye View (GMN CC BY 4.0 meteor trajectory data)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`gmn_upstream_${response.status}`);
    }
    return readResponseTextCapped(response, 10 * 1024 * 1024, signal);
  }

  async function refresh(signal) {
    signal.throwIfAborted();
    let text;
    try {
      text = await fetchSummaryText(GMN_LATEST_URL, signal);
    } catch {
      text = await fetchSummaryText(GMN_YESTERDAY_URL, signal);
    }
    const parsed = parseGmnTrajectorySummary(text, { now: now() });
    signal.throwIfAborted();
    cache = {
      events: parsed.events,
      publicationTime: parsed.publicationTime,
      fetchedAt: now(),
    };
    return cache;
  }

  async function acquire(signal) {
    signal.throwIfAborted();
    if (cache && now() - cache.fetchedAt < 6 * HOUR) return cache;
    if (operation?.controller.signal.aborted) operation = null;
    if (!operation) {
      if (now() - attemptedAt < 60_000) throw new Error('gmn_retry_later');
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
      throw Object.assign(new Error('gmn_busy'), { status: 429 });
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
    const events = value?.events ?? [];
    let latestObservationTime = null;
    for (const ev of events) {
      if (!latestObservationTime || ev.eventTime > latestObservationTime) {
        latestObservationTime = ev.eventTime;
      }
    }
    return {
      schemaVersion: 1,
      source: 'Global Meteor Network',
      attribution:
        'Global Meteor Network (CC BY 4.0 · Vida et al. 2020, 2021 · NASA MEO)',
      coverage: 'Global (~1,365 optical cameras across 50+ countries; 6h batch)',
      fetchedAt: value?.fetchedAt ?? null,
      publicationTime: value?.publicationTime ?? null,
      latestObservationTime,
      stale: stale || !value,
      unavailable: !value,
      reason: !value
        ? 'GMN trajectory data unavailable'
        : stale
          ? 'Cached GMN trajectory data; upstream unavailable'
          : null,
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
        ...(status === 429 ? { 'Retry-After': '2' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      if (req.url !== '/' && req.url !== '')
        return json(400, { error: 'invalid_gmn_query' });
      try {
        json(200, describe(await acquire(controller.signal)));
      } catch (error) {
        if (error.status === 429) return json(429, { error: 'gmn_busy' });
        const usable = cache && now() - cache.fetchedAt <= 24 * HOUR;
        json(200, describe(usable ? cache : null, true));
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'gmn-meteors',
    configureServer({ middlewares }) {
      middlewares.use('/api/gmn-meteors', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/gmn-meteors', handler);
    },
  };
}
