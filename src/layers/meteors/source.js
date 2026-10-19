import { MAX_EVENTS, COVERAGE } from './policy.js';

export function createSource({ layerState, services, components, config, feed }) {
  async function fetchSnapshot(signal) {
    const snapshot = await feed.getSnapshot({}, { signal });
    const records = Array.isArray(snapshot?.records)
      ? snapshot.records
      : Array.isArray(snapshot?.events)
        ? snapshot.events
        : [];
    const events = records.slice(0, MAX_EVENTS);
    return {
      events,
      source: snapshot?.source || 'NASA/JPL CNEOS',
      coverage: snapshot?.coverage || COVERAGE,
      fetchedAt: snapshot?.fetchedAt || Date.now(),
      latestObservationTime:
        snapshot?.latestObservationTime ||
        (events.length > 0 ? events[0].eventTime : null),
      stale: Boolean(snapshot?.stale),
      unavailable: Boolean(snapshot?.unavailable),
      reason: snapshot?.reason || null,
    };
  }

  async function fetchSounding({ lat, lon, timeIso }, signal) {
    try {
      const qs = new URLSearchParams({
        lat: String(lat),
        lon: String(lon),
        time: String(timeIso || ''),
      }).toString();
      const response = await fetch(`/api/meteor-sounding?${qs}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Fallback handled by caller
    }
    return null;
  }

  async function fetchAsgardEventEnrichment(eventId, signal) {
    if (!eventId) return null;
    try {
      const cleanId = String(eventId).replace(/^asgard:/, '');
      const qs = new URLSearchParams({ eventId: cleanId }).toString();
      const response = await fetch(`/api/nasa-skyfalls?${qs}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        const payload = await response.json();
        const events = Array.isArray(payload?.events) ? payload.events : [];
        return (
          events.find(
            (e) => e.eventId === cleanId || e.id === `asgard:${cleanId}`,
          ) || null
        );
      }
    } catch {
      // Optional enrichment
    }
    return null;
  }

  async function fetchSeismic(
    { lat, lon, startLat, startLon, startAltKm, burstAltKm, energyTonsTnt, timeIso },
    signal,
  ) {
    try {
      const qs = new URLSearchParams({
        lat: String(lat),
        lon: String(lon),
        time: String(timeIso || ''),
        burstAltKm: String(burstAltKm ?? 45.5),
        energyTonsTnt: String(energyTonsTnt ?? 10),
        ...(Number.isFinite(startLat) ? { startLat: String(startLat) } : {}),
        ...(Number.isFinite(startLon) ? { startLon: String(startLon) } : {}),
        ...(Number.isFinite(startAltKm) ? { startAltKm: String(startAltKm) } : {}),
      }).toString();
      const response = await fetch(`/api/meteor-seismic?${qs}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Optional seismic corroboration
    }
    return null;
  }

  return { fetchSnapshot, fetchSounding, fetchAsgardEventEnrichment, fetchSeismic };
}
