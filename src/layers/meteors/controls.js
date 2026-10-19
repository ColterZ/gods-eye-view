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
import { runMultiModelDarkFlight } from './darkFlight.js';
import {
  getFoundStonesForEvent,
  setCustomFoundStones,
} from './foundStones.js';
import {
  computeAerodynamicBreakupPhysics,
  computeNexradCoverage,
  computeGoesSatelliteDiagnostics,
  computeCneosSensorDiagnostics,
  getNexradGateForEvent,
} from './validation.js';
import {
  buildMeteorEventSceneRecipe,
  registerMeteorScenesInDirector,
} from './sceneGenerator.js';

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

  async function executeDarkFlightForSelected() {
    const ev = selectedEvent();
    if (!ev || !layerState._darkFlightActive) {
      layerState._darkFlightResult = null;
      components.rendering.clearDarkFlight();
      layerState.notify();
      return;
    }
    const targetId = ev.id;
    layerState._darkFlightLoading = true;
    layerState.notify();
    try {
      const sounding = await components.source.fetchSounding({
        lat: ev.location.lat,
        lon: ev.location.lon,
        timeIso: ev.eventTime,
      });
      if (
        layerState._destroyed ||
        !layerState._darkFlightActive ||
        layerState._selectedEventId !== targetId
      ) {
        return;
      }
      layerState._darkFlightResult = runMultiModelDarkFlight(ev, sounding, {
        allEvents: layerState._events,
        autoFit: layerState._darkFlightAutoFit,
      });
      components.rendering.renderDarkFlight();
    } finally {
      if (layerState._selectedEventId === targetId) {
        layerState._darkFlightLoading = false;
        layerState.notify();
      }
    }
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
        layerState._darkFlightActive = false;
        layerState._darkFlightResult = null;
        ++layerState._navigationGeneration;
        components.rendering.clearDarkFlight();
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
          if (layerState._darkFlightActive) {
            executeDarkFlightForSelected();
          }
          changed = true;
        }
      }

      if (params.toggleDarkFlight === true) {
        layerState._darkFlightActive = !layerState._darkFlightActive;
        if (layerState._darkFlightActive) {
          executeDarkFlightForSelected();
        } else {
          layerState._darkFlightResult = null;
          components.rendering.clearDarkFlight();
        }
        changed = true;
      } else if (typeof params.darkFlight === 'boolean') {
        if (layerState._darkFlightActive !== params.darkFlight) {
          layerState._darkFlightActive = params.darkFlight;
          if (layerState._darkFlightActive) {
            executeDarkFlightForSelected();
          } else {
            layerState._darkFlightResult = null;
            components.rendering.clearDarkFlight();
          }
          changed = true;
        }
      }

      if (params.toggleAutoFit === true) {
        layerState._darkFlightAutoFit = !layerState._darkFlightAutoFit;
        layerState._darkFlightActive = true;
        executeDarkFlightForSelected();
        changed = true;
      } else if (typeof params.autoFit === 'boolean') {
        if (layerState._darkFlightAutoFit !== params.autoFit) {
          layerState._darkFlightAutoFit = params.autoFit;
          if (layerState._darkFlightActive) {
            executeDarkFlightForSelected();
          }
          changed = true;
        }
      }

      if (params.cycleGroundLabels === true) {
        const order = ['compact', 'off', 'cards'];
        const cur = layerState._groundLabelsMode || 'compact';
        layerState._groundLabelsMode =
          order[(order.indexOf(cur) + 1) % order.length];
        components.rendering.renderDarkFlight();
        changed = true;
      } else if (
        typeof params.groundLabelsMode === 'string' &&
        ['compact', 'off', 'cards'].includes(params.groundLabelsMode)
      ) {
        layerState._groundLabelsMode = params.groundLabelsMode;
        components.rendering.renderDarkFlight();
        changed = true;
      }

      if (params.playEventScene === true) {
        const sel = selectedEvent();
        if (sel && layerState._sceneDirector) {
          const scenes = registerMeteorScenesInDirector(
            layerState._sceneDirector,
            [sel],
            layerState._events,
            { selectFirst: true },
          );
          if (scenes[0]) {
            layerState._sceneDirector.startScene?.(scenes[0].id, {
              single: true,
              preview: false,
            });
          }
          changed = true;
        }
      }

      if (params.syncSkyfallScenes === true && layerState._sceneDirector) {
        const candidates = layerState._filteredEvents
          .filter(
            (e) =>
              e.source === 'ares' ||
              e.source === 'asgard' ||
              (Array.isArray(e.possibleMatches) &&
                e.possibleMatches.length > 0),
          )
          .slice(0, 18);
        const registered = registerMeteorScenesInDirector(
          layerState._sceneDirector,
          candidates,
          layerState._events,
          { selectFirst: true },
        );
        layerState._syncedScenesCount = registered.length;
        changed = true;
      }

      if (Array.isArray(params.setFoundStones)) {
        const targetId = params.eventId || layerState._selectedEventId;
        if (targetId) {
          setCustomFoundStones(targetId, params.setFoundStones);
          layerState._darkFlightActive = true;
          executeDarkFlightForSelected();
          changed = true;
        }
      }

      if (
        typeof params.darkFlightMode === 'string' &&
        ['all', 'sweep', 'montecarlo'].includes(params.darkFlightMode)
      ) {
        layerState._darkFlightMode = params.darkFlightMode;
        if (!layerState._darkFlightActive) {
          layerState._darkFlightActive = true;
          executeDarkFlightForSelected();
        } else {
          components.rendering.renderDarkFlight();
        }
        changed = true;
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
            id: 'toggle-dark-flight',
            label: layerState._darkFlightLoading
              ? '⚡ SIMULATING…'
              : '⚡ DARK FLIGHT',
            active: layerState._darkFlightActive,
            busy: layerState._darkFlightLoading,
            title:
              'Run historical upper-air wind sounding + 3-model RK4/Monte Carlo dark-flight strewn field analysis',
            params: { toggleDarkFlight: true },
          },
          {
            id: 'play-event-scene',
            label: '🎬 PLAY SCENE',
            active: false,
            title:
              'Auto-generate a 4-shot cinematic Scene in SceneDirector for this event and play it',
            params: { playEventScene: true },
          },
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
        if (layerState._darkFlightActive) {
          chips.push(
            {
              id: 'df-mode-all',
              label: 'DF: ALL 3',
              active: layerState._darkFlightMode === 'all',
              title:
                'Cross-reference deterministic 5-mass spine + 160-fragment Monte Carlo + 2σ footprint',
              params: { darkFlightMode: 'all' },
            },
            {
              id: 'df-mode-sweep',
              label: 'DF: MASS SWEEP',
              active: layerState._darkFlightMode === 'sweep',
              title:
                'Deterministic RK4 5-mass sorting spine (10 kg, 1 kg, 100 g, 10 g, 1 g)',
              params: { darkFlightMode: 'sweep' },
            },
            {
              id: 'df-mode-mc',
              label: 'DF: MONTE CARLO',
              active: layerState._darkFlightMode === 'montecarlo',
              title: '160-fragment seeded Monte Carlo dispersion cloud + 2σ ellipse',
              params: { darkFlightMode: 'montecarlo' },
            },
            {
              id: 'df-ground-labels',
              label: `🏷 LABELS: ${(layerState._groundLabelsMode || 'compact').toUpperCase()}`,
              active: (layerState._groundLabelsMode || 'compact') !== 'off',
              title:
                'Cycle ground object label density: COMPACT (non-obtrusive side pills) → OFF (pure geometry) → CARDS (full floating cards)',
              params: { cycleGroundLabels: true },
            },
          );
          if (getFoundStonesForEvent(selected).length > 0) {
            chips.push({
              id: 'df-auto-fit',
              label: layerState._darkFlightAutoFit
                ? '🔧 FIT: ON'
                : '🔧 AUTO-FIT STONES',
              active: layerState._darkFlightAutoFit,
              title:
                'Fine-tune wind scale, drag shape factor, and altitude/azimuth against documented found stones',
              params: { toggleAutoFit: true },
            });
          }
        }
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
            id: 'sync-skyfall-scenes',
            label:
              layerState._syncedScenesCount > 0
                ? `🎬 SCENES (${layerState._syncedScenesCount})`
                : '🎬 BUILD SKYFALL SCENES',
            active: layerState._syncedScenesCount > 0,
            title:
              'Automatically generate 4-shot cinematic scenes in the SCENES panel for every skyfall & confirmed fall',
            params: { syncSkyfallScenes: true },
          },
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
          const aero = computeAerodynamicBreakupPhysics(selected, selected);
          const nexGate = getNexradGateForEvent(selected);
          const nexCov = computeNexradCoverage(
            selected.location?.lat,
            selected.location?.lon,
          );
          const goes = computeGoesSatelliteDiagnostics(
            selected,
            selected,
            nexGate,
          );
          const line1 = `Selected [NASA ASGARD 3D Camera Skyfall]: ${formatUtcTimestamp(selected.eventTime)} · Speed ${Number.isFinite(vel) ? `${vel.toFixed(1)} km/s` : 'n/a'} · Ground track ${t.groundTrackDistance ?? 'n/a'} km${aero?.slantLengthKm ? ` (3D slant ${aero.slantLengthKm} km · ~${aero.luminousDurationSec ?? 'n/a'}s luminous flight)` : ''}`;
          const line2 = `3D Camera Path: ${formatLatLon(t.startLat, t.startLon)} (${t.startAltKm ?? 85} km) → ${formatLatLon(t.endLat, t.endLon)} (${t.endAltKm ?? 48} km) · Heading ${t.azimuth ?? 'n/a'}° · Elev ${t.entryAngle ?? 'n/a'}°`;
          const line3 = aero
            ? `Aerodynamic Breakup: Peak ram pressure P_dyn = ${aero.ramPressureMpa} MPa at ${aero.endAltKm} km (ρ=${aero.rhoBreakupKgM3} kg/m³) → ${aero.strengthClass} · Sonic boom carpet ±${aero.sonicBoomCarpetRadiusKm} km (surface arrival +${aero.sonicBoomDelaySec}s)`
            : `Attribution: NASA MSFC Meteoroid Environment Office / ASGARD`;
          const line4 = nexGate
            ? `📡 NOAA NEXRAD Gate: ${nexGate.station} · ${nexGate.gateTimeUtc.slice(11, 19)} UTC @ ${nexGate.gateAltitudeKm} km (Δt +${nexGate.elapsedSec}s post-bolide · ${nexGate.reflectivityDbz} dBZ)`
            : nexCov?.primary
              ? `📡 Nearest NOAA NEXRAD: ${nexCov.primary.id} (${nexCov.primary.name}, ${nexCov.primary.distanceKm} km · 0.95° beam width ${nexCov.primary.beamWidthKm} km) · Base tilts 0.5°=${nexCov.primary.tilt05AltKm} km, 1.5°=${nexCov.primary.tilt15AltKm} km, 2.4°=${nexCov.primary.tilt24AltKm} km MSL`
              : `📡 NOAA NEXRAD: Outside primary CONUS WSR-88D 460 km dark-flight range`;
          const line5 = goes
            ? `🛰 ${goes.stereoCoverage}: GLM 14km-ellipsoid parallax shift ${goes.parallaxShiftKm} km →${goes.parallaxBearingDeg}° · ${goes.abiBand7Swir} · ${goes.abiBand13Lwir}`
            : '';
          info = `${line1}\n${line2}\n${line3}\n${line4}${line5 ? `\n${line5}` : ''}${matchNote}`;
        } else if (src === 'ares') {
          const nexGate = getNexradGateForEvent(selected);
          const nexCov = computeNexradCoverage(
            selected.location?.lat,
            selected.location?.lon,
          );
          const goes = computeGoesSatelliteDiagnostics(
            selected,
            selected,
            nexGate,
          );
          const line1 = `Selected [NASA ARES Confirmed Fall]: ${selected.name} · Date ${selected.eventTime?.slice(0, 10)} · ${formatLatLon(selected.location?.lat, selected.location?.lon)}`;
          const line2 = `Details: ${selected.description}`;
          const line3 = nexGate
            ? `📡 NOAA NEXRAD Gate: ${nexGate.station} · ${nexGate.gateTimeUtc.slice(11, 19)} UTC @ ${nexGate.gateAltitudeKm} km (Δt +${nexGate.elapsedSec}s · ${nexGate.reflectivityDbz} dBZ)`
            : nexCov?.primary
              ? `📡 Nearest WSR-88D Radar: ${nexCov.primary.id} (${nexCov.primary.name}, ${nexCov.primary.distanceKm} km) · 0.5°–2.4° beams @ ${nexCov.primary.tilt05AltKm}–${nexCov.primary.tilt24AltKm} km MSL`
              : `Source: NASA ARES Astromaterials Research & Exploration Science`;
          const line4 = goes
            ? `🛰 ${goes.stereoCoverage} · ${goes.abiBand7Swir} · ${goes.abiBand8WaterVapor}`
            : '';
          info = `${line1}\n${line2}\n${line3}${line4 ? `\n${line4}` : ''}${matchNote}`;
        } else {
          const { vx, vy, vz, entryAngle, azimuth, radiantAzimuth } =
            selected.trajectory || {};
          const cDiag = computeCneosSensorDiagnostics(selected);
          const tonsTnt = Number.isFinite(selected.energy?.impact)
            ? `${Math.round(selected.energy.impact * 1000)}t TNT`
            : 'n/a';
          const line1 = `Selected [CNEOS Airburst Sphere]: ${formatUtcTimestamp(selected.eventTime)} · Impact ${formatEnergyKt(selected.energy?.impact)} (${tonsTnt}) · Radiated ${formatRadiatedJ(selected.energy?.radiated)}`;
          const line2 = `3D Airburst Sphere: ${formatLatLon(selected.location?.lat, selected.location?.lon)} (±${cDiag?.quantizationMarginKm ?? 5.5} km 0.1° sensor quantization sphere, radius ${((cDiag?.sphereRadiusM ?? 5500) / 1000).toFixed(1)} km) · Peak alt ${Number.isFinite(alt) ? `${alt.toFixed(1)} km` : 'n/a'}`;
          const velCheckStr = cDiag?.hasVelocityConflict
            ? ` [⚠ Scalar vel=${cDiag.scalarVelKmS} km/s vs ECEF |v|=${cDiag.vectorVelKmS} km/s]`
            : '';
          const line3 = hasVelocityVector(selected)
            ? `Rough Directionality Cone: Heading ${azimuth}° ±${cDiag?.directionalitySpreadDeg ?? 18}° (radiant ${radiantAzimuth}° · elev ${entryAngle}°) · ECEF (${vx}, ${vy}, ${vz}) km/s${velCheckStr}`
            : 'Rough Directionality: Velocity vector components not reported for this event';
          const line4 = `Confidence: ${(selected.confidence?.level || 'high').toUpperCase()} · Delayed US Gov sensor catalog (3D airburst sphere + rough direction stub · Fireball report ≠ meteorite fall)`;
          info = `${line1}\n${line2}\n${line3}\n${line4}${matchNote}`;
        }

        if (layerState._darkFlightActive) {
          if (layerState._darkFlightLoading) {
            info += `\n⚡ Dark Flight: Fetching historical upper-air wind sounding (10m–30hPa) and integrating RK4 + Monte Carlo models…`;
          } else if (
            layerState._darkFlightResult &&
            layerState._darkFlightResult.eventId === selected.id
          ) {
            const df = layerState._darkFlightResult;
            if (!df.feasible) {
              info += `\n⚡ Dark Flight Gate: ${df.summaryText}`;
            } else {
              const snd = df.sounding?.summary || {};
              const cal = df.calibration || {};
              const el = df.ellipse2Sigma;
              const sndLine = df.sounding
                ? `⚡ Historical Wind Sounding (${df.sounding.soundingTimeUtc || 'ISA'}): Peak ${snd.peakWindSpeedMs ?? 0} m/s at ${snd.peakWindAltitudeKm ?? 0} km (→${snd.peakWindHeadingToDeg ?? 0}°) · Mean drift ${snd.meanDriftSpeedMs ?? 0} m/s →${snd.meanDriftHeadingToDeg ?? 0}°`
                : '⚡ Historical Wind Sounding: Standard Atmosphere (0 m/s wind)';
              const regimeLabel =
                df.regime === 'zone-of-possibility'
                  ? 'WEIGHTED ZONE OF POSSIBILITY (azimuth marginalized + wind prior)'
                  : '3-MODEL CROSS-REFERENCED STREWN FIELD';
              const elStr = el
                ? `2σ footprint ${((el.semiMajorM * 2) / 1000).toFixed(1)}×${((el.semiMinorM * 2) / 1000).toFixed(1)} km (axis ${el.orientationDeg}°)`
                : 'footprint n/a';
              const dfLine2 = `⚡ Dark Flight [${regimeLabel}]: 1kg→3g sorting ${cal.alongTrackKm ?? 0} km · ${elStr}`;
              const dfLine3 = `⚡ Cross-Reference: ${Number.isFinite(cal.crossModelOffsetM) ? `Spine↔MC centroid Δ=${cal.crossModelOffsetM} m` : cal.note}${Number.isFinite(cal.aresResidualM) ? ` · Confirmed fall (${cal.matchedFallName}) residual=${cal.aresResidualM} m` : ''} · MODEL ESTIMATE (not confirmed recovery zone)`;
              info += `\n${sndLine}\n${dfLine2}\n${dfLine3}`;
              if (
                df.stoneFit?.comparisons &&
                df.stoneFit.comparisons.length > 0
              ) {
                const sf = df.stoneFit;
                const stoneSummary = sf.comparisons
                  .map(
                    (c) =>
                      `${c.stone.label} (${c.stone.massGrams}g${c.fragmentationEpisode ? ` · ${c.fragmentationEpisode}` : ''}): Δ=${c.errorM}m`,
                  )
                  .join(' · ');
                const flareNote =
                  sf.tuning?.upperFlareOffsetKm > 0
                    ? `, 2-flare breakup (F1 +${sf.tuning.upperFlareOffsetKm} km up-track + F2 terminus)`
                    : '';
                const tuneNote = sf.tuning
                  ? ` [Auto-Fit: wind ${sf.tuning.windScale}×, shape ${sf.tuning.shapeFactor}, vel ${sf.tuning.speedScale ?? 1}×, az ${sf.tuning.azimuthDeltaDeg >= 0 ? '+' : ''}${sf.tuning.azimuthDeltaDeg}°${sf.terminusShiftM ? `, terminus Δ=${sf.terminusShiftM}m` : ''}${flareNote} → RMS ${sf.baselineRmsM}m → ${sf.bestRmsM}m]`
                  : ` [RMS ${sf.bestRmsM}m]`;
                info += `\n◆ Found Stones (${sf.comparisons.length})${tuneNote}: ${stoneSummary}`;
              }
              const val = df.validation;
              if (val) {
                if (val.pathCones) {
                  const pc = val.pathCones;
                  info += `\n📐 3D Flight-Path Uncertainty Cones (${pc.methodLabel}): 1σ Entry ±${(pc.entryRadius1SigmaM / 1000).toFixed(2)} km → Waist ±${(pc.waistRadius1SigmaM / 1000).toFixed(2)} km → Terminus ±${(pc.terminusRadius1SigmaM / 1000).toFixed(2)} km (2σ outer ±${(pc.terminusRadius2SigmaM / 1000).toFixed(2)} km · radiant ±${pc.angularUncertaintyDeg}° · vel ±${pc.velocityUncertaintyPct}%)`;
                }
                if (val.overUnder) {
                  const ou = val.overUnder;
                  const u1 = ou.under1Sigma;
                  const cm = ou.consensusMedian;
                  const o2 = ou.over2Sigma;
                  const floorNote = ou.recoveredFloor
                    ? `Recovered Floor: ${ou.recoveredFloor.totalGrams}g (${ou.recoveredFloor.stoneCount} stones, max ${ou.recoveredFloor.maxStoneGrams}g / ${ou.recoveredFloor.maxStoneDiamCm}cm) · `
                    : '';
                  info += `\n⚖ Ground Yield & Stone Size Over/Under: ${floorNote}UNDER (1σ): ${u1.totalYieldKg} kg (${u1.totalYieldLb} lb, max stone ~${u1.maxStoneGrams}g / ${u1.maxStoneDiamCm}cm) · CONSENSUS: ${cm.totalYieldKg} kg (${cm.totalYieldLb} lb, max stone ~${cm.maxStoneGrams}g / ${cm.maxStoneDiamCm}cm) · OVER (2σ): ${o2.totalYieldKg} kg (${o2.totalYieldLb} lb, max stone ~${o2.maxStoneGrams}g / ${o2.maxStoneDiamCm}cm)`;
                }
                if (val.radarCheck) {
                  const rc = val.radarCheck;
                  info += `\n📡 NEXRAD Doppler Radar Gate (${rc.station} · ${rc.gateTimeUtc.slice(11, 19)} UTC @ ${rc.gateAltitudeKm} km · Δt +${rc.elapsedSec}s · ${rc.reflectivityDbz} dBZ): ${rc.verdict}`;
                }
                if (val.goesDiag) {
                  const gd = val.goesDiag;
                  info += `\n🛰 ${gd.satellite}: GLM 14km-ellipsoid parallax shift ${gd.parallaxShiftKm} km toward ${gd.parallaxBearingDeg}° · ${gd.abiBand7Swir}`;
                }
                if (
                  Array.isArray(val.sanityWarnings) &&
                  val.sanityWarnings.length > 0
                ) {
                  info += `\n🔍 Sanity Checks: ${val.sanityWarnings.join(' | ')}`;
                }
              }
            }
          }
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

    attachSceneController(sceneDirector) {
      layerState._sceneDirector = sceneDirector || null;
      if (layerState._sceneDirector && layerState._events.length > 0) {
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
