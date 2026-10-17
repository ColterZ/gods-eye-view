import { LAYER_ID, LAYER_NAME, COVERAGE } from './policy.js';

export function createControls({ layerState, services, components, config }) {
  const methods = {
    id: LAYER_ID,
    name: LAYER_NAME,

    setParams(params) {
      // No configurable params yet
    },

    getParams() {
      return {};
    },

    getRowControls() {
      return {
        chips: [],
        legend: [
          {
            color: '#ff6600',
            label: 'Fireball event',
          },
          {
            color: '#ffcc00',
            label: 'Selected',
          },
        ],
      };
    },

    setRowControlsListener(fn) {
      // No row controls to listen to
    },

    getStats() {
      return {
        count: layerState._events.length,
        lastUpdate: layerState._lastUpdate,
        status: layerState._loading
          ? 'loading'
          : layerState._error
            ? 'error'
            : layerState._stale
              ? 'stale'
              : 'ok',
        error: layerState._error,
      };
    },
  };

  return { methods };
}
