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

  return { fetchSnapshot, fetchSounding };
}
