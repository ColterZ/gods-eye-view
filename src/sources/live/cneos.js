/**
 * CNEOS Fireball source — fetches from /api/fireballs and returns
 * a snapshot conforming to the source contract.
 */
export function createCneosSource({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  return {
    label: 'Fireballs',

    async getSnapshot(query = {}, { signal } = {}) {
      const signalToUse = signal || query?.signal;
      const response = await fetchImpl('/api/fireballs', {
        signal: signalToUse,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`cneos_fetch_failed_${response.status}`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload.events)) {
        throw new Error('invalid_cneos_payload');
      }
      return {
        records: payload.events,
        events: payload.events,
        source: payload.attribution || 'NASA/JPL CNEOS',
        coverage:
          payload.coverage ||
          'Global (US Government sensors; delayed catalog, 1988–present)',
        fetchedAt: payload.fetchedAt || now(),
        latestObservationTime: payload.latestObservationTime || null,
        stale: payload.stale || false,
        unavailable: payload.unavailable || false,
        reason: payload.reason || null,
      };
    },
  };
}
