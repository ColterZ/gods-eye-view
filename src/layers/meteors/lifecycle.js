import * as Cesium from 'cesium';
import { LAYER_ID, REFRESH_INTERVAL_MS } from './policy.js';

export function createLifecycle({ layerState, services, components, config }) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { clearSelectedEntityContextForLayer } = services.context;
  const { id } = config;

  let refreshTimer = null;

  async function loadEvents() {
    if (layerState._loading) return;
    layerState._loading = true;
    layerState._error = null;
    try {
      const controller = new AbortController();
      layerState._abortController = controller;
      const events = await components.source.fetchEvents(controller.signal);
      layerState._events = events;
      layerState._lastUpdate = new Date().toISOString();
      layerState._stale = false;
      components.rendering.update(events);
    } catch (error) {
      if (error.name !== 'AbortError') {
        layerState._error = error.message;
      }
    } finally {
      layerState._loading = false;
      layerState._abortController = null;
    }
  }

  function startRefreshTimer() {
    stopRefreshTimer();
    refreshTimer = setInterval(() => {
      if (layerState._enabled && !layerState._destroyed) {
        loadEvents();
      }
    }, REFRESH_INTERVAL_MS);
  }

  function stopRefreshTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  const methods = {
    init(viewer) {
      if (layerState._destroyed) return;
      layerState._viewer = viewer;
      layerState._dataSource = new Cesium.CustomDataSource(id);
      layerState._dataSource.show = false;
      viewer.dataSources.add(layerState._dataSource);
    },

    async enable(viewer) {
      if (layerState._destroyed) return;
      layerState._enabled = true;
      layerState._viewer = viewer;
      if (!layerState._dataSource) this.init(viewer);
      if (layerState._dataSource) layerState._dataSource.show = true;
      components.rendering.installClickHandler();
      registerPickOwner(id, (pickedId) =>
        layerState._entityById.has(pickedId),
      );
      if (!layerState._events.length && !layerState._loading)
        await loadEvents();
      startRefreshTimer();
    },

    disable() {
      if (layerState._abortController) {
        layerState._abortController.abort();
        layerState._abortController = null;
      }
      stopRefreshTimer();
      layerState._loading = false;
      layerState._enabled = false;
      if (layerState._dataSource) layerState._dataSource.show = false;
      clearSelectedEntityContextForLayer(id);
      components.rendering.removeClickHandler();
      unregisterPickOwner(id);
    },

    destroy(viewer = layerState._viewer) {
      if (layerState._abortController) {
        layerState._abortController.abort();
        layerState._abortController = null;
      }
      stopRefreshTimer();
      layerState._loading = false;
      if (layerState._destroyed) return;
      layerState._destroyed = true;
      layerState._enabled = false;
      components.rendering.removeClickHandler();
      unregisterPickOwner(id);
      if (layerState._dataSource && viewer) {
        viewer.dataSources.remove(layerState._dataSource, true);
      }
      layerState._dataSource = null;
      layerState._events = [];
      layerState._entityById.clear();
      layerState._selectedEventId = null;
      layerState._lastUpdate = null;
      layerState._error = null;
      layerState._stale = false;
      clearSelectedEntityContextForLayer(id);
    },

    update(viewer, { signal } = {}) {
      if (layerState._enabled && !layerState._destroyed) {
        return loadEvents();
      }
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
