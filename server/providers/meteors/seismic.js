import { haversineKm } from './gmn.js';

const IRIS_STATION_URL = 'https://service.iris.edu/fdsnws/station/1/query';
const IRIS_DATASELECT_URL = 'https://service.iris.edu/fdsnws/dataselect/1/query';
const USGS_EVENT_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

// Effective stratified atmospheric sound speed (km/s) integrated from 45 km stratosphere to surface (~312 m/s)
const EFFECTIVE_ACOUSTIC_SPEED_KMS = 0.312;

/**
 * Sign-extend an N-bit integer to 32-bit signed integer.
 */
function signExtend(val, bits) {
  const shift = 32 - bits;
  return (val << shift) >> shift;
}

/**
 * Decode a single 512-byte or 4096-byte miniSEED record encoded with Steim-1 (10) or Steim-2 (11).
 */
export function decodeMiniSeedSteimRecord(dv, offset, recLen, dataOffset, nSamples, encoding = 11) {
  const numFrames = Math.floor((recLen - dataOffset) / 64);
  if (numFrames <= 0 || offset + dataOffset + 12 > dv.byteLength) {
    return { x0: 0, xn: 0, lastDecoded: 0, samples: [] };
  }
  const x0 = dv.getInt32(offset + dataOffset + 4, false);
  const xn = dv.getInt32(offset + dataOffset + 8, false);
  const diffs = [];

  for (let f = 0; f < numFrames; f++) {
    const fBase = offset + dataOffset + f * 64;
    if (fBase + 64 > dv.byteLength) break;
    const ctrl = dv.getUint32(fBase, false);

    for (let w = 1; w < 16; w++) {
      if (f === 0 && (w === 1 || w === 2)) continue;
      const c = (ctrl >>> ((15 - w) * 2)) & 0x03;
      if (c === 0) continue;
      const wordOffset = fBase + w * 4;
      const word = dv.getUint32(wordOffset, false);

      if (c === 1) {
        for (let b = 0; b < 4; b++) {
          diffs.push(dv.getInt8(wordOffset + b));
        }
      } else if (encoding === 10) {
        // Steim-1
        if (c === 2) {
          diffs.push(dv.getInt16(wordOffset, false));
          diffs.push(dv.getInt16(wordOffset + 2, false));
        } else if (c === 3) {
          diffs.push(dv.getInt32(wordOffset, false));
        }
      } else {
        // Steim-2 (encoding === 11)
        const dnib = (word >>> 30) & 0x03;
        if (c === 2) {
          if (dnib === 1) {
            diffs.push(signExtend(word & 0x3fffffff, 30));
          } else if (dnib === 2) {
            diffs.push(signExtend((word >>> 15) & 0x7fff, 15));
            diffs.push(signExtend(word & 0x7fff, 15));
          } else if (dnib === 3) {
            diffs.push(signExtend((word >>> 20) & 0x3ff, 10));
            diffs.push(signExtend((word >>> 10) & 0x3ff, 10));
            diffs.push(signExtend(word & 0x3ff, 10));
          }
        } else if (c === 3) {
          if (dnib === 0) {
            for (let k = 4; k >= 0; k--) {
              diffs.push(signExtend((word >>> (k * 6)) & 0x3f, 6));
            }
          } else if (dnib === 1) {
            for (let k = 5; k >= 0; k--) {
              diffs.push(signExtend((word >>> (k * 5)) & 0x1f, 5));
            }
          } else if (dnib === 2) {
            for (let k = 6; k >= 0; k--) {
              diffs.push(signExtend((word >>> (k * 4)) & 0x0f, 4));
            }
          }
        }
      }
    }
  }

  const samples = [x0];
  let cur = x0;
  const limit = Math.min(nSamples, diffs.length);
  for (let i = 1; i < limit; i++) {
    cur += diffs[i];
    samples.push(cur);
  }
  return { x0, xn, lastDecoded: cur, samples };
}

/**
 * Parse a miniSEED buffer into per-record velocity-step envelopes and detect
 * the peak air-coupled N-wave arrival relative to `bolideTimeMs`.
 */
export function analyzeMiniSeedNWaveArrival(buffer, bolideTimeMs) {
  if (!buffer || buffer.byteLength < 512) return null;
  const dv = new DataView(buffer);
  let pos = 0;
  const bins = [];

  while (pos + 64 <= buffer.byteLength) {
    const year = dv.getUint16(pos + 20, false);
    const doy = dv.getUint16(pos + 22, false);
    const hr = dv.getUint8(pos + 24);
    const min = dv.getUint8(pos + 25);
    const sec = dv.getUint8(pos + 26);
    const fracSec = dv.getUint16(pos + 28, false) * 0.0001;
    const nSamples = dv.getUint16(pos + 30, false);
    const dataOffset = dv.getUint16(pos + 44, false);
    const b1000Offset = dv.getUint16(pos + 46, false);

    const encoding =
      b1000Offset && pos + b1000Offset + 7 <= buffer.byteLength
        ? dv.getUint8(pos + b1000Offset + 4)
        : 11;
    const recLenExp =
      b1000Offset && pos + b1000Offset + 7 <= buffer.byteLength
        ? dv.getUint8(pos + b1000Offset + 6)
        : 9;
    const recLen = Math.max(256, Math.min(4096, 1 << recLenExp));
    if (pos + recLen > buffer.byteLength) break;

    // Convert (year, doy, hr, min, sec) to UTC ms
    const jan1Ms = Date.UTC(year, 0, 1, 0, 0, 0);
    const recTimeMs =
      jan1Ms +
      (doy - 1) * 86_400_000 +
      hr * 3_600_000 +
      min * 60_000 +
      (sec + fracSec) * 1000;
    const tRelSec = (recTimeMs - bolideTimeMs) / 1000;

    if (encoding === 10 || encoding === 11) {
      const dec = decodeMiniSeedSteimRecord(
        dv,
        pos,
        recLen,
        dataOffset,
        nSamples,
        encoding,
      );
      let maxVelStep = 0;
      for (let i = 1; i < dec.samples.length; i++) {
        const d = Math.abs(dec.samples[i] - dec.samples[i - 1]);
        if (d > maxVelStep) maxVelStep = d;
      }
      bins.push({
        tRelSec: Math.round(tRelSec * 10) / 10,
        recTimeIso: new Date(recTimeMs).toISOString(),
        maxVelStep,
        checksumValid: dec.lastDecoded === dec.xn,
      });
    }
    pos += recLen;
  }

  if (bins.length < 6) return null;

  // Background noise floor from early window (< 45s after bolide, before acoustic N-wave reaches ground)
  const earlySteps = bins
    .filter((b) => b.tRelSec >= -5 && b.tRelSec <= 45)
    .map((b) => b.maxVelStep)
    .sort((a, b) => a - b);
  const noiseFloorCounts =
    earlySteps.length > 0
      ? Math.max(1, earlySteps[Math.floor(earlySteps.length * 0.5)])
      : 20;

  // Search acoustic arrival window [50s .. 320s]
  const arrivalCandidates = bins.filter(
    (b) => b.tRelSec >= 50 && b.tRelSec <= 320,
  );
  if (arrivalCandidates.length === 0) return null;

  const peakBin = arrivalCandidates
    .slice()
    .sort((a, b) => b.maxVelStep - a.maxVelStep)[0];
  const snr = Math.round((peakBin.maxVelStep / noiseFloorCounts) * 10) / 10;

  return {
    recordCount: bins.length,
    steimChecksumValid: bins.every((b) => b.checksumValid),
    noiseFloorCounts,
    peakCounts: peakBin.maxVelStep,
    snr,
    observedArrivalSec: peakBin.tRelSec,
    observedArrivalUtc: peakBin.recTimeIso,
  };
}

/**
 * Invert 3D airburst source location (lat, lon, burstAltKm) from observed seismic
 * acoustic N-wave arrival times via 3D grid search around the initial trajectory centroid.
 */
export function invertSeismicAirburstSource(stationsWithDetections, seedLat, seedLon, seedAltKm = 45.5) {
  const valid = (stationsWithDetections || []).filter(
    (s) => s.waveformDetection && s.waveformDetection.snr >= 4.0,
  );
  if (valid.length < 3) return null;

  let bestLat = seedLat;
  let bestLon = seedLon;
  let bestAltKm = seedAltKm;
  let bestRmsSec = Infinity;

  const cosLat = Math.max(0.1, Math.cos((seedLat * Math.PI) / 180));

  for (let dLat = -0.35; dLat <= 0.35; dLat += 0.035) {
    for (let dLon = -0.35; dLon <= 0.35; dLon += 0.035) {
      for (let altKm = 24; altKm <= 58; altKm += 2.0) {
        const candLat = seedLat + dLat;
        const candLon = seedLon + dLon;
        let sumSq = 0;
        for (const st of valid) {
          const horizKm = Math.hypot(
            (st.lat - candLat) * 111.32,
            (st.lon - candLon) * 111.32 * cosLat,
          );
          const vertKm = Math.max(0, altKm - (st.elevM || 0) / 1000);
          const slantKm = Math.hypot(horizKm, vertKm);
          const predSec = slantKm / EFFECTIVE_ACOUSTIC_SPEED_KMS;
          const err = st.waveformDetection.observedArrivalSec - predSec;
          sumSq += err * err;
        }
        const rms = Math.sqrt(sumSq / valid.length);
        if (rms < bestRmsSec) {
          bestRmsSec = rms;
          bestLat = candLat;
          bestLon = candLon;
          bestAltKm = altKm;
        }
      }
    }
  }

  const offsetKm = haversineKm(seedLat, seedLon, bestLat, bestLon);
  return {
    stationCount: valid.length,
    seismicLat: Math.round(bestLat * 10000) / 10000,
    seismicLon: Math.round(bestLon * 10000) / 10000,
    seismicBurstAltKm: Math.round(bestAltKm * 10) / 10,
    rmsResidualSec: Math.round(bestRmsSec * 100) / 100,
    offsetFromOpticalKm: offsetKm,
  };
}

/**
 * Fetch seismic & infrasound station corroboration, live miniSEED Steim-2 N-wave
 * detections, and USGS ComCat events for a meteor event.
 */
export async function fetchSeismicCorroboration(
  {
    lat,
    lon,
    startLat = null,
    startLon = null,
    startAltKm = null,
    timeIso,
    burstAltKm = 45.5,
    energyTonsTnt = 10,
  },
  { fetchImpl = fetch, signal } = {},
) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !timeIso) {
    throw new Error('invalid_seismic_params');
  }
  const eventMs = Date.parse(timeIso);
  if (!Number.isFinite(eventMs)) {
    throw new Error('invalid_seismic_time');
  }

  const dayStartIso = new Date(eventMs - 3600_000)
    .toISOString()
    .slice(0, 19);
  const dayEndIso = new Date(eventMs + 3600_000)
    .toISOString()
    .slice(0, 19);
  const waveStartIso = new Date(eventMs - 5_000)
    .toISOString()
    .slice(0, 19);
  const waveEndIso = new Date(eventMs + 310_000)
    .toISOString()
    .slice(0, 19);

  const stationQs = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    maxradius: '1.1',
    starttime: dayStartIso,
    endtime: dayEndIso,
    level: 'station',
    format: 'text',
  }).toString();

  const usgsQs = new URLSearchParams({
    format: 'geojson',
    latitude: String(lat),
    longitude: String(lon),
    maxradiuskm: '200',
    starttime: new Date(eventMs - 900_000).toISOString(),
    endtime: new Date(eventMs + 900_000).toISOString(),
  }).toString();

  const [irisRes, usgsRes] = await Promise.allSettled([
    fetchImpl(`${IRIS_STATION_URL}?${stationQs}`, { signal }),
    fetchImpl(`${USGS_EVENT_URL}?${usgsQs}`, { signal }),
  ]);

  const stations = [];
  if (irisRes.status === 'fulfilled' && irisRes.value.ok) {
    const txt = await irisRes.value.text();
    for (const line of txt.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('|');
      if (parts.length < 6) continue;
      const net = parts[0].trim();
      if (net === 'SY') continue; // skip synthetic archive network
      const sta = parts[1].trim();
      const sLat = Number(parts[2]);
      const sLon = Number(parts[3]);
      const elevM = Number(parts[4]) || 0;
      const siteName = parts[5].trim();
      if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

      const groundDistKm = haversineKm(lat, lon, sLat, sLon);
      const vertDistKm = Math.max(0, burstAltKm - elevM / 1000);
      const terminusSlantKm =
        Math.round(Math.hypot(groundDistKm, vertDistKm) * 10) / 10;

      // Also compute minimum 3D slant distance to the trajectory segment (cylindrical Mach cone)
      let minTrackSlantKm = terminusSlantKm;
      if (
        Number.isFinite(startLat) &&
        Number.isFinite(startLon) &&
        Number.isFinite(startAltKm)
      ) {
        for (let f = 0; f <= 1; f += 0.1) {
          const pLat = startLat + (lat - startLat) * f;
          const pLon = startLon + (lon - startLon) * f;
          const pAlt = startAltKm + (burstAltKm - startAltKm) * f;
          const dH = haversineKm(pLat, pLon, sLat, sLon);
          const dV = Math.max(0, pAlt - elevM / 1000);
          const dS = Math.hypot(dH, dV);
          if (dS < minTrackSlantKm) minTrackSlantKm = dS;
        }
        minTrackSlantKm = Math.round(minTrackSlantKm * 10) / 10;
      }

      const predictedArrivalSec =
        Math.round((minTrackSlantKm / EFFECTIVE_ACOUSTIC_SPEED_KMS) * 10) / 10;

      stations.push({
        network: net,
        station: sta,
        code: `${net}.${sta}`,
        siteName,
        lat: sLat,
        lon: sLon,
        elevM,
        groundDistKm,
        terminusSlantKm,
        minTrackSlantKm,
        predictedArrivalSec,
        waveformDetection: null,
      });
    }
  }

  stations.sort((a, b) => a.minTrackSlantKm - b.minTrackSlantKm);

  // Query live miniSEED waveforms from the top 6 closest broadband/regional stations
  const waveTargets = stations
    .filter((s) => ['UW', 'US', 'CC', 'TA', 'UO', 'PB', 'CN', 'CI', 'BK', 'NC', 'UU', 'MB'].includes(s.network))
    .slice(0, 6);

  await Promise.allSettled(
    waveTargets.map(async (st) => {
      const mseedQs = new URLSearchParams({
        net: st.network,
        sta: st.station,
        loc: '--',
        cha: 'HHZ,BHZ,EHZ,ENZ',
        starttime: waveStartIso,
        endtime: waveEndIso,
      }).toString();
      const r = await fetchImpl(`${IRIS_DATASELECT_URL}?${mseedQs}`, {
        signal,
      });
      if (r.status === 200) {
        const buf = await r.arrayBuffer();
        const det = analyzeMiniSeedNWaveArrival(buf, eventMs);
        if (det) {
          const acousticSlantKm =
            Math.round(det.observedArrivalSec * EFFECTIVE_ACOUSTIC_SPEED_KMS * 10) /
            10;
          const residualSec =
            Math.round((det.observedArrivalSec - st.predictedArrivalSec) * 10) /
            10;
          st.waveformDetection = {
            ...det,
            acousticSlantKm,
            residualSec,
          };
        }
      }
    }),
  );

  let usgsEvents = [];
  if (usgsRes.status === 'fulfilled' && usgsRes.value.ok) {
    const j = await usgsRes.value.json();
    usgsEvents = (j.features || []).map((f) => ({
      id: f.id,
      mag: f.properties?.mag,
      type: f.properties?.type,
      place: f.properties?.place,
      timeIso: new Date(f.properties?.time).toISOString(),
    }));
  }

  // Compute Edwards, Eaton & Brown (2008) equivalent airburst seismic magnitude M_L,eq
  const energyJoules = Math.max(1e6, (Number(energyTonsTnt) || 10) * 4.184e9);
  const equivalentSeismicMagMl =
    Math.round((0.67 * Math.log10(energyJoules) - 5.87) * 100) / 100;

  const multilateration = invertSeismicAirburstSource(
    stations,
    lat,
    lon,
    burstAltKm,
  );

  const detectedStations = stations.filter(
    (s) => s.waveformDetection && s.waveformDetection.snr >= 4.0,
  );

  return {
    source: 'EarthScope / IRIS FDSN (Station & miniSEED Dataselect) + USGS ComCat',
    bolideTimeIso: new Date(eventMs).toISOString(),
    effectiveSoundSpeedKmS: EFFECTIVE_ACOUSTIC_SPEED_KMS,
    equivalentSeismicMagMl,
    totalStationsInRadius: stations.length,
    waveformDetectedCount: detectedStations.length,
    stations: stations.slice(0, 12),
    multilateration,
    usgsEvents,
  };
}

/**
 * Vite middleware plugin for `/api/meteor-seismic`.
 */
export function meteorSeismicProxy({ fetchImpl = fetch } = {}) {
  const cache = new Map();

  async function handler(req, res) {
    const controller = new AbortController();
    res.once?.('close', () => controller.abort());
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };

    try {
      const urlObj = new URL(req.url || '/', 'http://localhost');
      const lat = Number(urlObj.searchParams.get('lat'));
      const lon = Number(urlObj.searchParams.get('lon'));
      const startLat = urlObj.searchParams.get('startLat')
        ? Number(urlObj.searchParams.get('startLat'))
        : null;
      const startLon = urlObj.searchParams.get('startLon')
        ? Number(urlObj.searchParams.get('startLon'))
        : null;
      const startAltKm = urlObj.searchParams.get('startAltKm')
        ? Number(urlObj.searchParams.get('startAltKm'))
        : null;
      const burstAltKm = Number(urlObj.searchParams.get('burstAltKm')) || 45.5;
      const energyTonsTnt =
        Number(urlObj.searchParams.get('energyTonsTnt')) || 10;
      const timeIso = urlObj.searchParams.get('time') || '';

      const key = `${lat.toFixed(3)}:${lon.toFixed(3)}:${timeIso.slice(0, 19)}`;
      if (cache.has(key)) {
        return json(200, cache.get(key));
      }

      const data = await fetchSeismicCorroboration(
        {
          lat,
          lon,
          startLat,
          startLon,
          startAltKm,
          timeIso,
          burstAltKm,
          energyTonsTnt,
        },
        { fetchImpl, signal: controller.signal },
      );
      cache.set(key, data);
      json(200, data);
    } catch (err) {
      json(200, {
        unavailable: true,
        reason: err?.message || 'seismic_unavailable',
        stations: [],
      });
    }
  }

  return {
    name: 'meteor-seismic',
    configureServer({ middlewares }) {
      middlewares.use('/api/meteor-seismic', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/meteor-seismic', handler);
    },
  };
}
