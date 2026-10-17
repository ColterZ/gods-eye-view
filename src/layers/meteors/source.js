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

  return { fetchSnapshot };
}
