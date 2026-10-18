import { corroborateMeteorEvents } from '../../layers/meteors/corroboration.js';

/**
 * Multi-source Meteor & Fireball intelligence source — fetches in parallel from:
 * - /api/fireballs (NASA/JPL CNEOS satellite bolides)
 * - /api/gmn-meteors (Global Meteor Network multi-camera optical trajectories)
 * - /api/nasa-skyfalls (NASA MSFC ASGARD all-sky camera trajectories + NASA ARES falls)
 *
 * Resilient: any single upstream failing never voids the others. Cross-source
 * matches are flagged non-destructively via corroborateMeteorEvents().
 */
export function createCneosSource({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function fetchJsonEndpoint(url, signal) {
    const response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`fetch_failed_${url}_${response.status}`);
    }
    return response.json();
  }

  return {
    label: 'Fireballs & Meteors',

    async getSnapshot(query = {}, { signal } = {}) {
      const signalToUse = signal || query?.signal;
      const [cneosRes, gmnRes, asgardRes] = await Promise.allSettled([
        fetchJsonEndpoint('/api/fireballs', signalToUse),
        fetchJsonEndpoint('/api/gmn-meteors', signalToUse),
        fetchJsonEndpoint('/api/nasa-skyfalls', signalToUse),
      ]);

      const cneosEvents =
        cneosRes.status === 'fulfilled' &&
        Array.isArray(cneosRes.value?.events)
          ? cneosRes.value.events
          : [];
      const gmnEvents =
        gmnRes.status === 'fulfilled' && Array.isArray(gmnRes.value?.events)
          ? gmnRes.value.events
          : [];
      const asgardEvents =
        asgardRes.status === 'fulfilled' &&
        Array.isArray(asgardRes.value?.events)
          ? asgardRes.value.events
          : [];

      const allUnavailable =
        cneosEvents.length === 0 &&
        gmnEvents.length === 0 &&
        asgardEvents.length === 0;

      if (
        allUnavailable &&
        cneosRes.status === 'rejected' &&
        gmnRes.status === 'rejected' &&
        asgardRes.status === 'rejected'
      ) {
        throw new Error('all_meteor_sources_failed');
      }

      const combined = corroborateMeteorEvents([
        ...cneosEvents,
        ...gmnEvents,
        ...asgardEvents,
      ]).sort((a, b) => Date.parse(b.eventTime) - Date.parse(a.eventTime));

      const latestObservationTime =
        combined.length > 0 ? combined[0].eventTime : null;

      const anyStale =
        (cneosRes.status === 'fulfilled' && Boolean(cneosRes.value?.stale)) ||
        (gmnRes.status === 'fulfilled' && Boolean(gmnRes.value?.stale)) ||
        (asgardRes.status === 'fulfilled' && Boolean(asgardRes.value?.stale));

      return {
        records: combined,
        events: combined,
        source: 'CNEOS · GMN · NASA ASGARD/ARES',
        coverage:
          'Global (CNEOS sensors + GMN ~1,365 cameras + NASA ASGARD/ARES)',
        fetchedAt:
          (cneosRes.status === 'fulfilled' && cneosRes.value?.fetchedAt) ||
          now(),
        latestObservationTime,
        stale: anyStale && !allUnavailable,
        unavailable: allUnavailable,
        reason: allUnavailable ? 'Meteor intelligence feeds unavailable' : null,
        sourcesStatus: {
          cneos:
            cneosRes.status === 'fulfilled' && !cneosRes.value?.unavailable
              ? 'ok'
              : 'degraded',
          gmn:
            gmnRes.status === 'fulfilled' && !gmnRes.value?.unavailable
              ? 'ok'
              : 'degraded',
          asgard:
            asgardRes.status === 'fulfilled' && !asgardRes.value?.unavailable
              ? 'ok'
              : 'degraded',
        },
      };
    },
  };
}
