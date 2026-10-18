import {
  LAYER_ID,
  LAYER_NAME,
  COVERAGE,
  TIME_WINDOWS,
  SOURCE_FILTERS,
  SEVERITY_COLORS,
  CNEOS_CATALOG_URL,
  GMN_STATUS_URL,
  GMN_FLUX_URL,
  AMS_VIEWER_URL,
  REFRESH_INTERVAL_MS,
} from './policy.js';
import {
  resolveTimeWindow,
  resolveSourceFilter,
  filterEventsByWindow,
  severityTier,
  hasVelocityVector,
  formatEnergyKt,
  formatRadiatedJ,
  formatMass,
  formatLatLon,
  formatUtcTimestamp,
  formatAgeShort,
  mapAnalystRecord,
} from './model.js';
import { formatShowerLabel } from './corroboration.js';

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
    source: config.source || 'CNEOS · GMN · NASA ASGARD/ARES',
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
        sourceFilter: layerState._sourceFilter,
        eventId: layerState._selectedEventId,
      };
    },

    setParams(params = {}) {
      if (layerState._destroyed) return false;
      let changed = false;
      let needsFilterRebuild = false;

      if (
        typeof params.timeWindow === 'string' &&
        TIME_WINDOWS.some((w) => w.id === params.timeWindow) &&
        params.timeWindow !== layerState._timeWindow
      ) {
        layerState._timeWindow = params.timeWindow;
        needsFilterRebuild = true;
      }

      if (
        typeof params.sourceFilter === 'string' &&
        SOURCE_FILTERS.some((s) => s.id === params.sourceFilter) &&
        params.sourceFilter !== layerState._sourceFilter
      ) {
        layerState._sourceFilter = params.sourceFilter;
        needsFilterRebuild = true;
      }

      if (needsFilterRebuild) {
        const refMs = layerState._latestObservationTime
          ? Math.max(Date.now(), Date.parse(layerState._latestObservationTime))
          : Date.now();
        layerState._filteredEvents = filterEventsByWindow(
          layerState._events,
          layerState._timeWindow,
          refMs,
          layerState._sourceFilter,
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
      } else if (typeof params.eventId === 'string') {
        const existsInFiltered = layerState._filteredEvents.some(
          (e) => e.id === params.eventId,
        );
        const existsInAll = layerState._events.some(
          (e) => e.id === params.eventId,
        );
        if (!existsInFiltered && existsInAll) {
          // If jumping to a corroborated partner from another source filter, widen filter to 'all'
          layerState._sourceFilter = 'all';
          const refMs = layerState._latestObservationTime
            ? Math.max(
                Date.now(),
                Date.parse(layerState._latestObservationTime),
              )
            : Date.now();
          layerState._filteredEvents = filterEventsByWindow(
            layerState._events,
            layerState._timeWindow,
            refMs,
            layerState._sourceFilter,
          );
          if (layerState._enabled) {
            components.rendering.update(layerState._filteredEvents);
          }
        }
        if (layerState._filteredEvents.some((e) => e.id === params.eventId)) {
          layerState._selectionIntent = 'user';
          components.rendering.selectEvent(params.eventId);
          changed = true;
        }
      }

      if (params.focus === true) {
        const targetId = params.eventId || layerState._selectedEventId;
        if (targetId) flyToEvent(targetId);
      }

      if (params.openSource === true) {
        const sel = selectedEvent();
        openLink(sel?.sourceUrl || CNEOS_CATALOG_URL);
      }
      if (params.openGmnStatus === true) openLink(GMN_STATUS_URL);
      if (params.openGmnFlux === true) openLink(GMN_FLUX_URL);
      if (params.openAmsViewer === true) openLink(AMS_VIEWER_URL);

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
      const sourceSpec = resolveSourceFilter(layerState._sourceFilter);
      const filtered = layerState._filteredEvents;
      const selected = selectedEvent();

      const chips = [
        ...TIME_WINDOWS.map((w) => ({
          id: `window-${w.id}`,
          label: w.label,
          active: layerState._timeWindow === w.id,
          title: `Show meteor & fireball records from the last ${w.days} days`,
          params: { timeWindow: w.id },
        })),
        ...SOURCE_FILTERS.map((s) => ({
          id: `source-${s.id}`,
          label: s.label,
          active: layerState._sourceFilter === s.id,
          title: s.title,
          params: { sourceFilter: s.id },
        })),
      ];

      if (selected) {
        chips.push(
          {
            id: 'focus-selected',
            label: 'FOCUS',
            active: false,
            title: 'Fly camera to selected event',
            params: { eventId: selected.id, focus: true },
          },
          {
            id: 'cneos-source',
            label: 'SOURCE ↗',
            active: false,
            title: `Open ${selected.attribution?.text || 'official'} catalog`,
            params: { openSource: true },
          },
        );
        if (
          Array.isArray(selected.possibleMatches) &&
          selected.possibleMatches.length > 0
        ) {
          const partner = selected.possibleMatches[0];
          chips.push({
            id: 'jump-match',
            label: `MATCH (${partner.source})`,
            active: false,
            title: `Inspect corroborated ${partner.summary} record`,
            params: { eventId: partner.id, focus: true },
          });
        }
        chips.push({
          id: 'clear-selected',
          label: 'CLEAR',
          active: false,
          title: 'Clear selection',
          params: { clear: true },
        });
      } else {
        chips.push(
          {
            id: 'gmn-status-link',
            label: 'GMN CAMERAS ↗',
            active: false,
            title: 'Open Global Meteor Network live camera status & FOV viewer',
            params: { openGmnStatus: true },
          },
          {
            id: 'gmn-flux-link',
            label: 'GMN FLUX ↗',
            active: false,
            title: 'Open GMN + NASA MEO real-time meteor shower flux monitor',
            params: { openGmnFlux: true },
          },
          {
            id: 'ams-viewer-link',
            label: 'AMS VIEWER ↗',
            active: false,
            title: 'Open American Meteor Society Fireball Event Viewer',
            params: { openAmsViewer: true },
          },
        );
      }

      let cneosCount = 0;
      let gmnCount = 0;
      let asgardCount = 0;
      let aresCount = 0;
      let vectorCount = 0;
      let matchedCount = 0;

      for (const ev of filtered) {
        if (ev.source === 'gmn') gmnCount++;
        else if (ev.source === 'asgard') asgardCount++;
        else if (ev.source === 'ares') aresCount++;
        else cneosCount++;
        if (hasVelocityVector(ev)) vectorCount++;
        if (Array.isArray(ev.possibleMatches) && ev.possibleMatches.length > 0)
          matchedCount++;
      }

      const legend = [
        {
          color: SEVERITY_COLORS.medium,
          label: 'CNEOS bolide',
          count: cneosCount,
          blurb: 'NASA/JPL CNEOS US Government satellite sensor bolides',
        },
        {
          color: SEVERITY_COLORS.gmn,
          label: 'GMN optical',
          count: gmnCount,
          blurb:
            'Global Meteor Network multi-camera 3D trajectories (CC BY 4.0)',
        },
        {
          color: SEVERITY_COLORS.asgard,
          label: 'NASA ASGARD',
          count: asgardCount,
          blurb: 'NASA MSFC All-Sky Fireball Network camera trajectories',
        },
        {
          color: SEVERITY_COLORS.ares,
          label: 'Confirmed fall',
          count: aresCount,
          blurb: 'NASA ARES documented radar-confirmed meteorite falls',
        },
      ];

      let info = '';
      if (selected) {
        const src = selected.source || 'cneos';
        const alt = selected.location?.altitude;
        const vel = selected.trajectory?.entryVelocity;
        const matches = Array.isArray(selected.possibleMatches)
          ? selected.possibleMatches
          : [];
        const matchNote =
          matches.length > 0
            ? `\n★ Corroborated across sources: ${matches.map((m) => m.summary).join(' · ')} (not silently merged)`
            : '';

        if (src === 'gmn') {
          const t = selected.trajectory || {};
          const o = selected.orbit || {};
          const s = selected.stations || {};
          const line1 = `Selected [GMN Optical]: ${formatUtcTimestamp(selected.eventTime)} · Peak Mag ${Number.isFinite(selected.magnitude) ? selected.magnitude.toFixed(2) : 'n/a'} · Mass ${formatMass(selected.mass)} (τ=0.7%)`;
          const line2 = `3D Trajectory: ${formatLatLon(t.startLat, t.startLon)} (${Number.isFinite(t.startAltKm) ? `${t.startAltKm.toFixed(1)} km` : 'n/a'}) → ${formatLatLon(t.endLat, t.endLon)} (${Number.isFinite(t.endAltKm) ? `${t.endAltKm.toFixed(1)} km` : 'n/a'}) · Vel ${Number.isFinite(vel) ? `${vel.toFixed(1)} km/s` : 'n/a'} · Track ${t.groundTrackDistance ?? 'n/a'} km`;
          const line3 = `Shower & Orbit: ${formatShowerLabel(o.showerCode)} · Radiant RA ${t.radiantRa?.toFixed(1) ?? 'n/a'}° Dec ${t.radiantDec?.toFixed(1) ?? 'n/a'}° · ${o.orbitalClass || 'Orbit n/a'} (a=${o.aAu?.toFixed(2) ?? 'n/a'} AU, e=${o.e?.toFixed(2) ?? 'n/a'}, i=${o.iDeg?.toFixed(1) ?? 'n/a'}°)`;
          const line4 = `Triangulation: ${s.count || 2} GMN cameras (${s.codes || 'n/a'}) · Qc ${s.convergenceAngleDeg?.toFixed(1) ?? 'n/a'}° · CC BY 4.0 (Vida et al. 2020, 2021) · Report ≠ meteorite fall`;
          info = `${line1}\n${line2}\n${line3}\n${line4}${matchNote}`;
        } else if (src === 'asgard') {
          const t = selected.trajectory || {};
          const line1 = `Selected [NASA ASGARD]: ${formatUtcTimestamp(selected.eventTime)} · Speed ${Number.isFinite(vel) ? `${vel.toFixed(1)} km/s` : 'n/a'} · Ground track ${t.groundTrackDistance ?? 'n/a'} km`;
          const line2 = `3D Camera Path: ${formatLatLon(t.startLat, t.startLon)} (${t.startAltKm ?? 85} km) → ${formatLatLon(t.endLat, t.endLon)} (${t.endAltKm ?? 48} km) · Heading ${t.azimuth ?? 'n/a'}°`;
          const line3 = `Attribution: NASA MSFC Meteoroid Environment Office / ASGARD · Delayed camera catalog · Report ≠ meteorite fall`;
          info = `${line1}\n${line2}\n${line3}${matchNote}`;
        } else if (src === 'ares') {
          const line1 = `Selected [NASA ARES Confirmed Fall]: ${selected.name} · Date ${selected.eventTime?.slice(0, 10)} · ${formatLatLon(selected.location?.lat, selected.location?.lon)}`;
          const line2 = `Details: ${selected.description}`;
          const line3 = `Source: NASA ARES Astromaterials Research & Exploration Science (NOAA NEXRAD / GOES GLM corroborated)`;
          info = `${line1}\n${line2}\n${line3}${matchNote}`;
        } else {
          const { vx, vy, vz, entryAngle, azimuth, radiantAzimuth } =
            selected.trajectory || {};
          const line1 = `Selected [CNEOS]: ${formatUtcTimestamp(selected.eventTime)} · Impact ${formatEnergyKt(selected.energy?.impact)} TNT · Radiated ${formatRadiatedJ(selected.energy?.radiated)}`;
          const line2 = `Location: ${formatLatLon(selected.location?.lat, selected.location?.lon)} · Peak alt ${Number.isFinite(alt) ? `${alt.toFixed(1)} km` : 'n/a'} · Pre-impact vel ${Number.isFinite(vel) ? `${vel.toFixed(1)} km/s` : 'n/a'}`;
          const line3 = hasVelocityVector(selected)
            ? `3D Trajectory: Entry ${entryAngle}° above horizon · Heading ${azimuth}° (radiant ${radiantAzimuth}°) · ECEF (${vx}, ${vy}, ${vz}) km/s`
            : '3D Trajectory: Velocity vector components not reported for this event';
          const line4 = `Confidence: ${(selected.confidence?.level || 'high').toUpperCase()} · Delayed US Gov sensor catalog (not live) · Fireball report ≠ meteorite fall`;
          info = `${line1}\n${line2}\n${line3}\n${line4}${matchNote}`;
        }
      } else {
        const latestObs = layerState._latestObservationTime
          ? formatUtcTimestamp(layerState._latestObservationTime)
          : 'n/a';
        const retrievedAgo = layerState._lastUpdate
          ? formatAgeShort(Date.now() - layerState._lastUpdate)
          : 'never';
        info = `${filtered.length} events in ${windowSpec.label} [${sourceSpec.label}] (${vectorCount} with 3D trajectories, ${matchedCount} corroborated across sources)\nLatest obs: ${latestObs} · Retrieved ${retrievedAgo} · Delayed sensor/camera catalogs (never labeled live)`;
      }

      const listItems = filtered.slice(0, 25).map((ev, idx) => {
        const alt = ev.location?.altitude;
        const vel = ev.trajectory?.entryVelocity;
        const datePart =
          typeof ev.eventTime === 'string'
            ? `${ev.eventTime.slice(0, 10)} ${ev.eventTime.slice(11, 16)}`
            : ev.id;
        const hasMatch =
          Array.isArray(ev.possibleMatches) && ev.possibleMatches.length > 0;
        let lead = formatEnergyKt(ev.energy?.impact);
        if (ev.source === 'gmn') {
          lead = Number.isFinite(ev.magnitude)
            ? `GMN ${ev.magnitude.toFixed(1)}m`
            : 'GMN';
        } else if (ev.source === 'asgard') {
          lead = 'ASGARD';
        } else if (ev.source === 'ares') {
          lead = 'FALL';
        }
        if (hasMatch) lead = `★ ${lead}`;

        const extra =
          ev.source === 'gmn' && ev.orbit?.showerCode
            ? ` · ${ev.orbit.showerCode}`
            : ev.source === 'ares' && ev.name
              ? ` · ${ev.name}`
              : '';
        return {
          id: ev.id,
          ordinal: idx + 1,
          lead,
          text: `${datePart} UTC · ${formatLatLon(ev.location?.lat, ev.location?.lon)}${Number.isFinite(alt) && alt > 0 ? ` · ${alt.toFixed(0)} km` : ''}${Number.isFinite(vel) ? ` · ${vel.toFixed(1)} km/s` : ''}${extra}`,
          active: ev.id === layerState._selectedEventId,
          params: { eventId: ev.id, focus: true },
        };
      });

      return {
        chips,
        legend,
        info,
        infoTitle: `${COVERAGE}. Sources: NASA/JPL CNEOS (public domain), Global Meteor Network (CC BY 4.0, Vida et al. 2020/2021), NASA MSFC ASGARD & NASA ARES. Cross-source matches are flagged, never silently merged.`,
        list: {
          ariaLabel: `Meteor and fireball events (${windowSpec.label}, ${sourceSpec.label})`,
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
        source: 'CNEOS · GMN · NASA ASGARD/ARES',
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
