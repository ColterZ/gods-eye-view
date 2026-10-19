import * as Cesium from 'cesium';
import { METEORS_OVERLAY_SOURCE_ID } from './policy.js';
import { filterEventsByWindow } from './model.js';
import { registerMeteorScenesInDirector } from './sceneGenerator.js';

export function createLifecycle({ layerState, services, components, config }) {
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const { clearSelectedEntityContextForLayer } = services.context;
  const { id, overlayHost } = config;

  const methods = {
    init(viewer) {
      if (layerState._destroyed) return;
      layerState._viewer = viewer;
      layerState._dataSource = new Cesium.CustomDataSource(id);
      layerState._dataSource.show = false;
      viewer.dataSources.add(layerState._dataSource);
      overlayHost?.setVisible?.(METEORS_OVERLAY_SOURCE_ID, false);
    },

    async enable(viewer) {
      if (layerState._destroyed) return false;
      layerState._enabled = true;
      layerState._viewer = viewer;
      if (!layerState._dataSource) this.init(viewer);
      if (layerState._dataSource) layerState._dataSource.show = true;
      overlayHost?.setVisible?.(METEORS_OVERLAY_SOURCE_ID, true);
      components.rendering.installClickHandler();
      registerPickOwner(
        id,
        (pickedId) =>
          layerState._enabled &&
          layerState._pickEventIdByEntityId.has(pickedId),
      );
      return true;
    },

    disable() {
      if (layerState._request) {
        layerState._request.abort();
        layerState._request = null;
      }
      layerState._loading = false;
      layerState._enabled = false;
      ++layerState._navigationGeneration;
      if (layerState._dataSource) layerState._dataSource.show = false;
      overlayHost?.clearSource?.(METEORS_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(METEORS_OVERLAY_SOURCE_ID, false);
      clearSelectedEntityContextForLayer(id);
      components.rendering.removeClickHandler();
      unregisterPickOwner(id);
      layerState.notify();
    },

    destroy(viewer = layerState._viewer) {
      if (layerState._request) {
        layerState._request.abort();
        layerState._request = null;
      }
      layerState._loading = false;
      if (layerState._destroyed) return;
      layerState._destroyed = true;
      layerState._enabled = false;
      ++layerState._navigationGeneration;
      components.rendering.removeClickHandler();
      components.rendering.clearEntities();
      unregisterPickOwner(id);
      overlayHost?.clearSource?.(METEORS_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(METEORS_OVERLAY_SOURCE_ID, false);
      if (layerState._dataSource && viewer) {
        viewer.dataSources.remove(layerState._dataSource, true);
      }
      layerState._dataSource = null;
      layerState._snapshot = null;
      layerState._events = [];
      layerState._filteredEvents = [];
      layerState._selectedEventId = null;
      layerState._lastUpdate = null;
      layerState._latestObservationTime = null;
      layerState._error = null;
      layerState._stale = false;
      layerState._unavailable = false;
      clearSelectedEntityContextForLayer(id);
    },

    async update(viewer, { signal } = {}) {
      if (!layerState._enabled || layerState._destroyed) return false;
      if (viewer && !layerState._viewer) layerState._viewer = viewer;
      if (!layerState._dataSource && layerState._viewer) {
        this.init(layerState._viewer);
        layerState._dataSource.show = true;
      }

      layerState._request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      layerState._request = controller;
      const onAbort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });

      layerState._loading = true;
      layerState._error = null;
      layerState.notify();

      try {
        signal?.throwIfAborted();
        const snapshot = await components.source.fetchSnapshot(
          controller.signal,
        );
        if (
          !layerState._enabled ||
          controller.signal.aborted ||
          layerState._request !== controller
        ) {
          return false;
        }

        layerState._snapshot = snapshot;
        layerState._stale = Boolean(snapshot.stale);
        layerState._unavailable = Boolean(snapshot.unavailable);

        if (snapshot.unavailable) {
          components.rendering.clearEntities();
          layerState._events = [];
          layerState._filteredEvents = [];
          layerState._selectedEventId = null;
          layerState._error = snapshot.reason || 'Fireball data unavailable';
          return true;
        }

        layerState._events = snapshot.events;
        layerState._lastUpdate = snapshot.fetchedAt || Date.now();
        layerState._latestObservationTime = snapshot.latestObservationTime;
        layerState._error = null;

        const refMs = snapshot.latestObservationTime
          ? Math.max(Date.now(), Date.parse(snapshot.latestObservationTime))
          : Date.now();
        layerState._filteredEvents = filterEventsByWindow(
          layerState._events,
          layerState._timeWindow,
          refMs,
          layerState._sourceFilter,
        );

        // Auto-select the most recent fireball unless the user explicitly cleared selection
        if (
          !layerState._filteredEvents.some(
            (e) => e.id === layerState._selectedEventId,
          )
        ) {
          layerState._selectedEventId =
            layerState._selectionIntent === 'cleared'
              ? null
              : layerState._filteredEvents[0]?.id || null;
        }

        components.rendering.update(layerState._filteredEvents);
        if (layerState._selectedEventId) {
          components.rendering.selectEvent(layerState._selectedEventId);
          if (layerState._darkFlightActive) {
            components.controls.methods.setParams({ darkFlight: true });
          }
        }
        if (
          layerState._sceneDirector &&
          layerState._syncedScenesCount === 0 &&
          layerState._events.length > 0
        ) {
          const prioritySkyfalls = layerState._events
            .filter(
              (e) =>
                e.source === 'ares' ||
                (Array.isArray(e.possibleMatches) &&
                  e.possibleMatches.length > 0),
            )
            .slice(0, 12);
          const reg = registerMeteorScenesInDirector(
            layerState._sceneDirector,
            prioritySkyfalls,
            layerState._events,
          );
          layerState._syncedScenesCount = reg.length;
        }
        return true;
      } catch (error) {
        if (
          controller.signal.aborted ||
          error?.name === 'AbortError' ||
          layerState._request !== controller
        ) {
          return false;
        }
        layerState._error = error?.message || 'Fireball data unavailable';
        return true;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (layerState._request === controller) {
          layerState._request = null;
          layerState._loading = false;
          layerState.notify();
        }
      }
    },
  };

  return { methods };
}
