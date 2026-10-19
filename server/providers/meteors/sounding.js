import { readResponseTextCapped } from '../common/http.js';

const HIST_FORECAST_URL =
  'https://historical-forecast-api.open-meteo.com/v1/forecast';
const LIVE_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const PRESSURE_LEVELS = [1000, 850, 700, 500, 300, 200, 100, 50, 30];

const HOURLY_VARS = [
  'temperature_2m',
  'pressure_msl',
  'wind_speed_10m',
  'wind_direction_10m',
  ...PRESSURE_LEVELS.flatMap((p) => [
    `wind_speed_${p}hPa`,
    `wind_direction_${p}hPa`,
    `geopotential_height_${p}hPa`,
    `temperature_${p}hPa`,
  ]),
].join(',');

/**
 * Standard barometric altitude approximation (m) for a pressure level (hPa)
 * when geopotential height is absent.
 */
export function pressureToStandardAltitudeM(pressureHpa) {
  if (!Number.isFinite(pressureHpa) || pressureHpa <= 0) return 0;
  if (pressureHpa >= 226.32) {
    return (1 - Math.pow(pressureHpa / 1013.25, 1 / 5.25588)) / 2.25577e-5;
  }
  return 11000 - 6341.62 * Math.log(pressureHpa / 226.32);
}

/**
 * Convert meteorological wind speed (m/s) and direction (degrees FROM which
 * wind blows, 0=N, 90=E) into (u, v) velocity components (+u = East, +v = North).
 */
export function windSpeedDirToUV(speedMs, directionFromDeg) {
  if (!Number.isFinite(speedMs) || !Number.isFinite(directionFromDeg)) {
    return { u: 0, v: 0 };
  }
  const rad = (directionFromDeg * Math.PI) / 180;
  const u = -speedMs * Math.sin(rad);
  const v = -speedMs * Math.cos(rad);
  return {
    u: Object.is(u, -0) ? 0 : Math.round(u * 100) / 100,
    v: Object.is(v, -0) ? 0 : Math.round(v * 100) / 100,
  };
}

/**
 * Parse Open-Meteo hourly response into a sorted vertical WindProfile for the
 * target UTC hour (0..23).
 */
export function parseOpenMeteoSounding(
  payload,
  { lat, lon, targetIso, targetHourUtc = 12 } = {},
) {
  const hourly = payload?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !hourly.time.length) {
    throw new Error('invalid_sounding_payload');
  }
  const idx = Math.max(
    0,
    Math.min(hourly.time.length - 1, Math.floor(targetHourUtc)),
  );

  const samples = [];

  // Surface 10m level
  const spd10 = Number(hourly.wind_speed_10m?.[idx]);
  const dir10 = Number(hourly.wind_direction_10m?.[idx]);
  const temp2mC = Number(hourly.temperature_2m?.[idx]);
  const pMsl = Number(hourly.pressure_msl?.[idx]) || 1013.25;
  if (Number.isFinite(spd10) && Number.isFinite(dir10)) {
    const { u, v } = windSpeedDirToUV(spd10, dir10);
    samples.push({
      altitude: 10,
      pressure: pMsl,
      temperature: Number.isFinite(temp2mC) ? temp2mC + 273.15 : 288.15,
      speedMs: spd10,
      directionFromDeg: dir10,
      u,
      v,
    });
  }

  for (const p of PRESSURE_LEVELS) {
    const spd = Number(hourly[`wind_speed_${p}hPa`]?.[idx]);
    const dir = Number(hourly[`wind_direction_${p}hPa`]?.[idx]);
    if (!Number.isFinite(spd) || !Number.isFinite(dir)) continue;
    const geoH = Number(hourly[`geopotential_height_${p}hPa`]?.[idx]);
    const tempC = Number(hourly[`temperature_${p}hPa`]?.[idx]);
    const altitude =
      Number.isFinite(geoH) && geoH > 0
        ? geoH
        : Math.round(pressureToStandardAltitudeM(p));
    const { u, v } = windSpeedDirToUV(spd, dir);
    samples.push({
      altitude: Math.round(altitude),
      pressure: p,
      temperature: Number.isFinite(tempC) ? tempC + 273.15 : 220,
      speedMs: spd,
      directionFromDeg: dir,
      u,
      v,
    });
  }

  if (!samples.length) throw new Error('empty_sounding_samples');
  samples.sort((a, b) => a.altitude - b.altitude);

  // Compute summary metrics: jet stream peak & density-weighted drift vector
  let maxSpeedMs = 0;
  let maxSpeedAltM = 0;
  let maxSpeedToDeg = 0;
  let sumU = 0;
  let sumV = 0;

  for (const s of samples) {
    const toDeg = Math.round(((s.directionFromDeg + 180) % 360 + 360) % 360);
    if (s.speedMs > maxSpeedMs) {
      maxSpeedMs = s.speedMs;
      maxSpeedAltM = s.altitude;
      maxSpeedToDeg = toDeg;
    }
    sumU += s.u;
    sumV += s.v;
  }

  const meanU = sumU / samples.length;
  const meanV = sumV / samples.length;
  const meanDriftSpeedMs = Math.round(Math.hypot(meanU, meanV) * 10) / 10;
  const rawDriftAz = (Math.atan2(meanU, meanV) * 180) / Math.PI;
  const meanDriftToDeg = Math.round(((rawDriftAz % 360) + 360) % 360);

  const groundElevationM = Number.isFinite(Number(payload?.elevation))
    ? Math.max(0, Math.round(Number(payload.elevation)))
    : 0;

  return {
    schemaVersion: 1,
    source: 'Open-Meteo Upper-Air Reanalysis/Forecast (10m–30hPa)',
    lat,
    lon,
    groundElevationM,
    targetIso,
    soundingTimeUtc: hourly.time[idx] + ':00Z',
    stale: false,
    fallback: false,
    summary: {
      peakWindSpeedMs: Math.round(maxSpeedMs * 10) / 10,
      peakWindAltitudeKm: Math.round((maxSpeedAltM / 1000) * 10) / 10,
      peakWindHeadingToDeg: maxSpeedToDeg,
      meanDriftSpeedMs,
      meanDriftHeadingToDeg: meanDriftToDeg,
      levelsCount: samples.length,
      maxAltitudeKm:
        Math.round((samples[samples.length - 1].altitude / 1000) * 10) / 10,
    },
    samples,
  };
}

/**
 * Fallback zero-wind standard profile when upstream sounding API is unreachable,
 * explicitly flagged with `fallback: true` so it is never mistaken for measured wind.
 */
export function buildStandardFallbackSounding({ lat, lon, targetIso } = {}) {
  return {
    schemaVersion: 1,
    source: 'Zero-Wind Standard Atmosphere (sounding upstream unavailable)',
    lat,
    lon,
    targetIso,
    soundingTimeUtc: targetIso || null,
    stale: true,
    fallback: true,
    summary: {
      peakWindSpeedMs: 0,
      peakWindAltitudeKm: 0,
      peakWindHeadingToDeg: 0,
      meanDriftSpeedMs: 0,
      meanDriftHeadingToDeg: 0,
      levelsCount: 2,
      maxAltitudeKm: 25,
    },
    samples: [
      {
        altitude: 0,
        pressure: 1013.25,
        temperature: 288.15,
        speedMs: 0,
        directionFromDeg: 0,
        u: 0,
        v: 0,
      },
      {
        altitude: 25000,
        pressure: 25,
        temperature: 221.65,
        speedMs: 0,
        directionFromDeg: 0,
        u: 0,
        v: 0,
      },
    ],
  };
}

/**
 * Vite middleware proxy for historical event-time upper-air wind soundings
 * (`/api/meteor-sounding?lat=...&lon=...&time=...`).
 */
export function meteorSoundingProxy({
  fetchImpl = fetch,
  timeoutMs = 12_000,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function fetchSounding({ lat, lon, timeIso }, signal) {
    const parsedDate = new Date(timeIso);
    const validDate = Number.isFinite(parsedDate.getTime())
      ? parsedDate
      : new Date();
    const dateStr = validDate.toISOString().slice(0, 10);
    const hourUtc = validDate.getUTCHours();
    const key = `${lat.toFixed(1)}:${lon.toFixed(1)}:${dateStr}:${hourUtc}`;

    if (cache.has(key)) return cache.get(key);
    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
      const qs = new URLSearchParams({
        latitude: lat.toFixed(2),
        longitude: lon.toFixed(2),
        start_date: dateStr,
        end_date: dateStr,
        hourly: HOURLY_VARS,
        wind_speed_unit: 'ms',
        timezone: 'UTC',
      }).toString();

      const urls = [
        `${HIST_FORECAST_URL}?${qs}`,
        `${LIVE_FORECAST_URL}?${qs}`,
      ];

      for (const url of urls) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const onAbort = () => controller.abort();
          signal?.addEventListener('abort', onAbort, { once: true });
          try {
            const response = await fetchImpl(url, {
              signal: controller.signal,
              headers: {
                Accept: 'application/json',
                'User-Agent': 'Gods Eye View (Dark Flight Atmospheric Sounding)',
              },
            });
            if (!response.ok) {
              await response.body?.cancel();
              continue;
            }
            const text = await readResponseTextCapped(
              response,
              2 * 1024 * 1024,
              controller.signal,
            );
            const payload = JSON.parse(text);
            const sounding = parseOpenMeteoSounding(payload, {
              lat,
              lon,
              targetIso: validDate.toISOString(),
              targetHourUtc: hourUtc,
            });
            if (cache.size >= 128) {
              const oldest = cache.keys().next().value;
              cache.delete(oldest);
            }
            cache.set(key, sounding);
            return sounding;
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          }
        } catch {
          // Try next endpoint
        }
      }

      return buildStandardFallbackSounding({
        lat,
        lon,
        targetIso: validDate.toISOString(),
      });
    })().finally(() => {
      inflight.delete(key);
    });

    inflight.set(key, promise);
    return promise;
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
      const u = new URL(req.url || '/', 'http://localhost');
      const lat = Number(u.searchParams.get('lat'));
      const lon = Number(u.searchParams.get('lon'));
      const timeIso = u.searchParams.get('time') || new Date().toISOString();
      if (
        !Number.isFinite(lat) ||
        lat < -90 ||
        lat > 90 ||
        !Number.isFinite(lon) ||
        lon < -180 ||
        lon > 180
      ) {
        return json(400, { error: 'invalid_coordinates' });
      }
      const result = await fetchSounding(
        { lat, lon, timeIso },
        controller.signal,
      );
      json(200, result);
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'meteor-sounding',
    configureServer({ middlewares }) {
      middlewares.use('/api/meteor-sounding', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/meteor-sounding', handler);
    },
  };
}
