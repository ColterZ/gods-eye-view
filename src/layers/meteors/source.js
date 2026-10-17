import { API_ENDPOINT, MAX_EVENTS } from './policy.js';

export function createSource({ layerState, services, components, config }) {
  async function fetchEvents(signal) {
    const response = await fetch(API_ENDPOINT, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`fireball_fetch_failed_${response.status}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload.events)) {
      throw new Error('invalid_fireball_payload');
    }
    return payload.events.slice(0, MAX_EVENTS);
  }

  return { fetchEvents };
}
