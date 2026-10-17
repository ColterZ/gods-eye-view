import {
  LAYER_ID,
  LAYER_NAME,
  COVERAGE,
  TIME_WINDOWS,
  SEVERITY_COLORS,
  CNEOS_CATALOG_URL,
  REFRESH_INTERVAL_MS,
} from './policy.js';
import {
  resolveTimeWindow,
  filterEventsByWindow,
  severityTier,
  hasVelocityVector,
  formatEnergyKt,
  formatRadiatedJ,
  formatLatLon,
  formatUtcTimestamp,
  formatAgeShort,
  mapAnalystRecord,
} from './model.js';

export function createControls({ layerState, services, components, config }) {
  const openLink =
    config.openLink ||
    ((url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'));

  function selectedEvent() {
    if (!layerState._selectedEventId) return null;
    return (
      layerState._filteredEvents.find(
        (e) => e.id === layerState._selectedEventId,
      ) ||
      layerState._events.find((e) => e.id === layerState._selectedEventId) ||
      null
    );
  }

  function flyToEvent(eventId) {
    const viewer = layerState._viewer;
    const sphere = components.rendering.getFocusSphere(eventId);
    if (!viewer || !sphere) return;
    const generation = ++layerState._navigationGeneration;
    const executeFly = () => {
      if (
        !layerState._enabled ||
        layerState._destroyed ||
        generation !== layerState._navigationGeneration
      )
        return;
      return viewer.camera.flyToBoundingSphere(sphere, {
        duration: 1.4,
      });
    };
    if (typeof layerState._runNavigation === 'function') {
      layerState._runNavigation(executeFly);
    } else {
      executeFly();
    }
  }

  const methods = {
    id: config.id || LAYER_ID,
    name: config.name || LAYER_NAME,
    icon: config.icon || '☄',
    source: config.source || 'NASA/JPL CNEOS',
    updateInterval: REFRESH_INTERVAL_MS,

    attachShellServices(shellServices) {
      layerState._runNavigation =
        typeof shellServices?.runNavigation === 'function'
          ? shellServices.runNavigation
          : null;
      layerState.notify();
    },

    getParams() {
      return {
        timeWindow: layerState._timeWindow,
        eventId: layerState._selectedEventId,
      };
    },

    setParams(params = {}) {
      if (layerState._destroyed) return false;
      let changed = false;

      if (
        typeof params.timeWindow === 'string' &&
        TIME_WINDOWS.some((w) => w.id === params.timeWindow) &&
        params.timeWindow !== layerState._timeWindow
      ) {
        layerState._timeWindow = params.timeWindow;
        const refMs = layerState._latestObservationTime
          ? Math.max(Date.now(), Date.parse(layerState._latestObservationTime))
          : Date.now();
        layerState._filteredEvents = filterEventsByWindow(
          layerState._events,
          layerState._timeWindow,
          refMs,
        );
        if (
          layerState._selectedEventId &&
          !layerState._filteredEvents.some(
            (e) => e.id === layerState._selectedEventId,
          )
        ) {
          layerState._selectedEventId =
            layerState._selectionIntent === 'cleared'
              ? null
              : layerState._filteredEvents[0]?.id || null;
        }
        if (layerState._enabled) {
          components.rendering.update(layerState._filteredEvents);
        }
        changed = true;
      }

      if (params.clear === true || params.eventId === null) {
        layerState._selectionIntent = 'cleared';
        ++layerState._navigationGeneration;
        components.rendering.selectEvent(null);
        changed = true;
      } else if (
        typeof params.eventId === 'string' &&
        layerState._filteredEvents.some((e) => e.id === params.eventId)
      ) {
        layerState._selectionIntent = 'user';
        components.rendering.selectEvent(params.eventId);
        changed = true;
      }

      if (params.focus === true) {
        const targetId = params.eventId || layerState._selectedEventId;
        if (targetId) flyToEvent(targetId);
      }

      if (params.openSource === true) {
        openLink(CNEOS_CATALOG_URL);
      }

      if (changed) layerState.notify();
      return true;
    },

    getSelectedInfo() {
      const event = selectedEvent();
      if (!event) return null;
      return {
        id: event.id,
        label: `Fireball · ${formatEnergyKt(event.energy?.impact)} TNT`,
        latitude: event.location?.lat ?? null,
        longitude: event.location?.lon ?? null,
        altitudeKm: event.location?.altitude ?? null,
        impactEnergyKt: event.energy?.impact ?? null,
        radiatedEnergy10e10J: event.energy?.radiated ?? null,
        velocityKmS: event.trajectory?.entryVelocity ?? null,
        entryAngleDeg: event.trajectory?.entryAngle ?? null,
        azimuthDeg: event.trajectory?.azimuth ?? null,
        observedAt: Date.parse(event.eventTime) || null,
        source: 'NASA/JPL CNEOS',
      };
    },

    getAnalystRecords(maxCount = 500) {
      if (!layerState._enabled || layerState._destroyed) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return layerState._filteredEvents.slice(0, limit).map(mapAnalystRecord);
    },

    getRowControls() {
      const windowSpec = resolveTimeWindow(layerState._timeWindow);
      const filtered = layerState._filteredEvents;
      const selected = selectedEvent();

      const chips = TIME_WINDOWS.map((w) => ({
        id: `window-${w.id}`,
        label: w.label,
        active: layerState._timeWindow === w.id,
        title: `Show CNEOS bolides from the last ${w.days} days`,
        params: { timeWindow: w.id },
      }));

      if (selected) {
        chips.push(
          {
            id: 'focus-selected',
            label: 'FOCUS',
            active: false,
            title: 'Fly camera to selected fireball',
            params: { eventId: selected.id, focus: true },
          },
          {
            id: 'cneos-source',
            label: 'CNEOS ↗',
            active: false,
            title: 'Open official NASA/JPL CNEOS Fireball catalog',
            params: { openSource: true },
          },
          {
            id: 'clear-selected',
            label: 'CLEAR',
            active: false,
            title: 'Clear fireball selection',
            params: { clear: true },
          },
        );
      }

      let majorCount = 0;
      let mediumCount = 0;
      let minorCount = 0;
      let vectorCount = 0;
      for (const ev of filtered) {
        const { tier } = severityTier(ev);
        if (tier === 'major') majorCount++;
        else if (tier === 'medium') mediumCount++;
        else minorCount++;
        if (hasVelocityVector(ev)) vectorCount++;
      }

      const legend = [
        {
          color: SEVERITY_COLORS.major,
          label: '≥5 kt',
          count: majorCount,
          blurb: 'Major bolide airburst (≥ 5 kt TNT equivalent)',
        },
        {
          color: SEVERITY_COLORS.medium,
          label: '0.5–5 kt',
          count: mediumCount,
          blurb: 'Moderate bolide airburst (0.5 to 5 kt TNT equivalent)',
        },
        {
          color: SEVERITY_COLORS.minor,
          label: '<0.5 kt',
          count: minorCount,
          blurb: 'Minor bolide airburst (< 0.5 kt TNT equivalent)',
        },
        {
          color: SEVERITY_COLORS.vector,
          label: '3D vector',
          count: vectorCount,
          blurb:
            '3D atmospheric entry vector from CNEOS pre-impact (vx, vy, vz)',
        },
      ];

      let info = '';
      if (selected) {
        const alt = selected.location?.altitude;
        const vel = selected.trajectory?.entryVelocity;
        const { vx, vy, vz, entryAngle, azimuth, radiantAzimuth } =
          selected.trajectory || {};
        const line1 = `Selected: ${formatUtcTimestamp(selected.eventTime)} · Impact ${formatEnergyKt(selected.energy?.impact)} TNT · Radiated ${formatRadiatedJ(selected.energy?.radiated)}`;
        const line2 = `Location: ${formatLatLon(selected.location?.lat, selected.location?.lon)} · Peak alt ${Number.isFinite(alt) ? `${alt.toFixed(1)} km` : 'n/a'} · Pre-impact vel ${Number.isFinite(vel) ? `${vel.toFixed(1)} km/s` : 'n/a'}`;
        const line3 = hasVelocityVector(selected)
          ? `3D Trajectory: Entry ${entryAngle}° above horizon · Heading ${azimuth}° (radiant ${radiantAzimuth}°) · ECEF (${vx}, ${vy}, ${vz}) km/s`
          : '3D Trajectory: Velocity vector components not reported for this event';
        const line4 = `Confidence: ${(selected.confidence?.level || 'high').toUpperCase()} · Delayed US Gov sensor catalog (not live) · Fireball report ≠ meteorite fall`;
        info = `${line1}\n${line2}\n${line3}\n${line4}`;
      } else {
        const latestObs = layerState._latestObservationTime
          ? formatUtcTimestamp(layerState._latestObservationTime)
          : 'n/a';
        const retrievedAgo = layerState._lastUpdate
          ? formatAgeShort(Date.now() - layerState._lastUpdate)
          : 'never';
        info = `${filtered.length} bolides in ${windowSpec.label} window (${vectorCount} with 3D entry vectors) · Click a marker, card, or list row to inspect\nLatest sensor obs: ${latestObs} · Retrieved ${retrievedAgo} · Delayed catalog (not real-time)`;
      }

      const listItems = filtered.slice(0, 25).map((ev, idx) => {
        const alt = ev.location?.altitude;
        const vel = ev.trajectory?.entryVelocity;
        const datePart =
          typeof ev.eventTime === 'string'
            ? `${ev.eventTime.slice(0, 10)} ${ev.eventTime.slice(11, 16)}`
            : ev.id;
        return {
          id: ev.id,
          ordinal: idx + 1,
          lead: formatEnergyKt(ev.energy?.impact),
          text: `${datePart} UTC · ${formatLatLon(ev.location?.lat, ev.location?.lon)}${Number.isFinite(alt) ? ` · ${alt.toFixed(0)} km` : ''}${Number.isFinite(vel) ? ` · ${vel.toFixed(1)} km/s` : ''}`,
          active: ev.id === layerState._selectedEventId,
          params: { eventId: ev.id, focus: true },
        };
      });

      return {
        chips,
        legend,
        info,
        infoTitle: `${COVERAGE}. Pre-impact velocity is measured at peak brightness; mass is not inferred from velocity, and a fireball observation alone does not confirm a meteorite fall.`,
        list: {
          ariaLabel: `NASA CNEOS fireball events (${windowSpec.label})`,
          items: listItems,
        },
      };
    },

    setRowControlsListener(fn) {
      layerState._listener = typeof fn === 'function' ? fn : null;
    },

    getStats() {
      const windowSpec = resolveTimeWindow(layerState._timeWindow);
      const age = layerState._lastUpdate
        ? formatAgeShort(Date.now() - layerState._lastUpdate)
        : 'never';
      const latestDate = layerState._latestObservationTime
        ? layerState._latestObservationTime.slice(0, 10)
        : null;
      return {
        count: layerState._filteredEvents.length,
        lastUpdate: layerState._lastUpdate,
        source: 'NASA/JPL CNEOS',
        coverage: COVERAGE,
        loading: layerState._loading,
        stale: layerState._stale,
        unavailable: layerState._unavailable,
        status: layerState._loading
          ? 'loading'
          : layerState._error
            ? 'error'
            : layerState._stale
              ? 'stale'
              : 'ok',
        loadingLabel: layerState._loading
          ? 'loading catalog...'
          : layerState._lastUpdate
            ? `DELAYED CATALOG (${windowSpec.label}${latestDate ? ` · latest ${latestDate}` : ''}) · synced ${age}`
            : '',
        error: layerState._error,
      };
    },
  };

  return { methods };
}
