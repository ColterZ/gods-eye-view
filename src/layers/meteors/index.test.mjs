import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCneosFireballs,
  computeLocalTrajectoryAngles,
} from '../../../server/providers/meteors/cneos.js';
import {
  parseGmnTrajectorySummary,
  classifyTisserandOrbit,
} from '../../../server/providers/meteors/gmn.js';
import {
  parseAsgardSkyfallMapHtml,
  enrichAsgardEventFromDetailHtml,
  buildAresFallEvents,
} from '../../../server/providers/meteors/asgard.js';
import {
  corroborateMeteorEvents,
  formatShowerLabel,
} from './corroboration.js';
import {
  parseOpenMeteoSounding,
  windSpeedDirToUV,
} from '../../../server/providers/meteors/sounding.js';
import {
  evaluateSurvivalPhysics,
  runMultiModelDarkFlight,
} from './darkFlight.js';
import {
  getFoundStonesForEvent,
  setCustomFoundStones,
} from './foundStones.js';
import {
  cameraPoseLookingAtTarget,
  buildMeteorEventSceneRecipe,
  registerMeteorScenesInDirector,
} from './sceneGenerator.js';
import {
  filterEventsByWindow,
  severityTier,
  buildMeteorCardModel,
  buildMeteorOverlayEntries,
} from './model.js';
import { createMeteorsLayer } from './index.js';

describe('CNEOS Fireball Parsing & Trajectory', () => {
  it('(1) parseCneosFireballs parses CNEOS fields including vel, vx, vy, vz, entryAngle, azimuth, preserves raw fields, and sets mass to null', () => {
    const payload = {
      fields: [
        'date',
        'lat',
        'lat-dir',
        'lon',
        'lon-dir',
        'alt',
        'vel',
        'energy',
        'impact-e',
        'vx',
        'vy',
        'vz',
      ],
      data: [
        [
          '2024-03-15 12:30:00',
          '34.5',
          'N',
          '118.2',
          'W',
          '35.2',
          '17.4',
          '180',
          '3.2',
          '-8.5',
          '13.1',
          '7.2',
        ],
      ],
    };

    const fixedNow = 1710505800000;
    const events = parseCneosFireballs(payload, fixedNow);

    assert.equal(events.length, 1);
    const event = events[0];

    // Source & ID
    assert.equal(event.id, 'cneos:2024-03-15 12:30:00');
    assert.equal(event.source, 'cneos');
    assert.equal(event.eventTime, '2024-03-15T12:30:00.000Z');

    // Location
    assert.equal(event.location.lat, 34.5);
    assert.equal(event.location.lon, -118.2);
    assert.equal(event.location.altitude, 35.2);

    // Energy
    assert.equal(event.energy.radiated, 180);
    assert.equal(event.energy.impact, 3.2);

    // Velocity & Trajectory
    assert.equal(event.trajectory.entryVelocity, 17.4);
    assert.equal(event.trajectory.vx, -8.5);
    assert.equal(event.trajectory.vy, 13.1);
    assert.equal(event.trajectory.vz, 7.2);
    assert.equal(typeof event.trajectory.entryAngle, 'number');
    assert.equal(typeof event.trajectory.azimuth, 'number');
    assert.equal(typeof event.trajectory.radiantAzimuth, 'number');

    // Preserves raw fields
    assert.deepEqual(event.raw, {
      date: '2024-03-15 12:30:00',
      energy: '180',
      'impact-e': '3.2',
      lat: '34.5',
      'lat-dir': 'N',
      lon: '118.2',
      'lon-dir': 'W',
      alt: '35.2',
      vel: '17.4',
      vx: '-8.5',
      vy: '13.1',
      vz: '7.2',
    });

    // Mass must be null (never computed from penetration velocity)
    assert.strictEqual(event.mass, null);

    // Confidence notes should emphasize fireball report does not imply meteorite fall
    assert.match(
      event.confidence.notes,
      /Fireball report alone does not imply a meteorite fall/,
    );
  });

  it('(2) computeLocalTrajectoryAngles computes elevation entryAngle and azimuth', () => {
    // Case 1: Straight downward incoming trajectory at lat=0, lon=0.
    // Earth center is at -X in ECEF, so vx = -20, vy = 0, vz = 0 points straight down.
    const downResult = computeLocalTrajectoryAngles(0, 0, -20, 0, 0);
    assert.equal(downResult.entryAngle, 90);
    assert.equal(downResult.azimuth, 0);
    assert.equal(downResult.radiantAzimuth, 180);

    // Case 2: Horizontal trajectory traveling due North at lat=0, lon=0.
    // In ECEF, vz points towards the North Pole, so vx = 0, vy = 0, vz = 25.
    const northResult = computeLocalTrajectoryAngles(0, 0, 0, 0, 25);
    assert.equal(northResult.entryAngle, 0);
    assert.equal(northResult.azimuth, 0);
    assert.equal(northResult.radiantAzimuth, 180);

    // Case 3: Horizontal trajectory traveling due East at lat=0, lon=0.
    // At lat=0, lon=0: East is +Y in ECEF, so vx = 0, vy = 30, vz = 0.
    const eastResult = computeLocalTrajectoryAngles(0, 0, 0, 30, 0);
    assert.equal(eastResult.entryAngle, 0);
    assert.equal(eastResult.azimuth, 90);
    assert.equal(eastResult.radiantAzimuth, 270);

    // Case 4: 45 degree entry angle traveling North at lat=0, lon=0.
    // vx = -10 (downward), vz = 10 (northward), speed = sqrt(200).
    // clampedSin = 10 / sqrt(200) = 1/sqrt(2) -> 45 degrees.
    const angledResult = computeLocalTrajectoryAngles(0, 0, -10, 0, 10);
    assert.equal(angledResult.entryAngle, 45);
    assert.equal(angledResult.azimuth, 0);
    assert.equal(angledResult.radiantAzimuth, 180);

    // Case 5: Non-finite or zero velocity inputs return nulls
    assert.deepEqual(computeLocalTrajectoryAngles(NaN, 0, 10, 0, 0), {
      entryAngle: null,
      azimuth: null,
      radiantAzimuth: null,
    });
    assert.deepEqual(computeLocalTrajectoryAngles(0, 0, 0, 0, 0), {
      entryAngle: null,
      azimuth: null,
      radiantAzimuth: null,
    });
  });
});

describe('Meteor Layer Presentation & Filtering Model', () => {
  const DAY_MS = 86_400_000;
  const baseTime = Date.parse('2024-06-01T00:00:00.000Z');

  const makeEvent = (id, daysAgo, impact = 1.0) => ({
    id,
    eventTime: new Date(baseTime - daysAgo * DAY_MS).toISOString(),
    location: { lat: 10, lon: 20, altitude: 30 },
    energy: { impact, radiated: 50 },
    trajectory: { entryVelocity: 15, vx: -10, vy: 5, vz: 8, entryAngle: 45, azimuth: 60 },
  });

  it('(3) filterEventsByWindow filters by 30d/90d/1y/5y', () => {
    const e15d = makeEvent('e-15d', 15);
    const e60d = makeEvent('e-60d', 60);
    const e180d = makeEvent('e-180d', 180);
    const e700d = makeEvent('e-700d', 700);
    const e2000d = makeEvent('e-2000d', 2000);

    const allEvents = [e2000d, e60d, e700d, e15d, e180d];

    // 30d filter: includes only events <= 30 days old
    const f30d = filterEventsByWindow(allEvents, '30d', baseTime);
    assert.deepEqual(
      f30d.map((e) => e.id),
      ['e-15d'],
    );

    // 90d filter: includes events <= 90 days old (15d and 60d), sorted descending by time
    const f90d = filterEventsByWindow(allEvents, '90d', baseTime);
    assert.deepEqual(
      f90d.map((e) => e.id),
      ['e-15d', 'e-60d'],
    );

    // 1y filter (365 days): includes 15d, 60d, 180d
    const f1y = filterEventsByWindow(allEvents, '1y', baseTime);
    assert.deepEqual(
      f1y.map((e) => e.id),
      ['e-15d', 'e-60d', 'e-180d'],
    );

    // 5y filter (1825 days): includes 15d, 60d, 180d, 700d (excludes 2000d)
    const f5y = filterEventsByWindow(allEvents, '5y', baseTime);
    assert.deepEqual(
      f5y.map((e) => e.id),
      ['e-15d', 'e-60d', 'e-180d', 'e-700d'],
    );

    // Empty or invalid input
    assert.deepEqual(filterEventsByWindow([], '30d', baseTime), []);
    assert.deepEqual(filterEventsByWindow(null, '30d', baseTime), []);
  });

  it('(4) severityTier classifies minor/medium/major by impact energy', () => {
    // minor: impact < 0.5 kt
    const minorEvent0 = { energy: { impact: 0 } };
    const minorEvent1 = { energy: { impact: 0.2 } };
    const minorEvent2 = { energy: { impact: 0.49 } };
    assert.equal(severityTier(minorEvent0).tier, 'minor');
    assert.equal(severityTier(minorEvent1).tier, 'minor');
    assert.equal(severityTier(minorEvent2).tier, 'minor');

    // medium: 0.5 <= impact < 5.0 kt
    const medEvent1 = { energy: { impact: 0.5 } };
    const medEvent2 = { energy: { impact: 2.1 } };
    const medEvent3 = { energy: { impact: 4.99 } };
    assert.equal(severityTier(medEvent1).tier, 'medium');
    assert.equal(severityTier(medEvent2).tier, 'medium');
    assert.equal(severityTier(medEvent3).tier, 'medium');

    // major: impact >= 5.0 kt
    const majorEvent1 = { energy: { impact: 5.0 } };
    const majorEvent2 = { energy: { impact: 12.5 } };
    const majorEvent3 = { energy: { impact: 440 } };
    assert.equal(severityTier(majorEvent1).tier, 'major');
    assert.equal(severityTier(majorEvent2).tier, 'major');
    assert.equal(severityTier(majorEvent3).tier, 'major');

    // Selected size is always pixelSize + 5
    const st = severityTier(majorEvent1);
    assert.equal(st.selectedSize, st.pixelSize + 5);
  });

  it('(5) buildMeteorCardModel and buildMeteorOverlayEntries build ambient and selected tactical cards and never claim a meteorite fall', () => {
    const event = {
      id: 'cneos:2024-01-01 00:00:00',
      eventTime: '2024-01-01T00:00:00.000Z',
      location: { lat: 25.5, lon: -80.1, altitude: 42.0 },
      energy: { impact: 3.5, radiated: 120.0 },
      trajectory: {
        entryVelocity: 16.5,
        vx: -9.0,
        vy: 11.0,
        vz: 7.5,
        entryAngle: 38.5,
        azimuth: 125,
      },
    };

    // Ambient card model
    const ambientCard = buildMeteorCardModel(event, false);
    assert.equal(ambientCard.selected, false);
    assert.match(ambientCard.title, /^☄/);
    assert.ok(ambientCard.details.length > 0);

    // Selected card model
    const selectedCard = buildMeteorCardModel(event, true);
    assert.equal(selectedCard.selected, true);
    assert.match(selectedCard.title, /^☄ FIREBALL/);
    assert.ok(selectedCard.details.length > 1);

    // Verify neither card claims a meteorite fall
    const ambientText = [ambientCard.title, ...ambientCard.details].join(' ');
    const selectedText = [selectedCard.title, ...selectedCard.details].join(' ');

    assert.doesNotMatch(
      ambientText.toLowerCase(),
      /meteorite fall(?!\s*≠)/i,
      'Ambient card must never claim a meteorite fall',
    );
    assert.doesNotMatch(
      selectedText.toLowerCase(),
      /(?:confirms?|discovered|found|proves?)\s+meteorite fall/i,
      'Selected card must never claim a meteorite fall occurred',
    );
    // In fact, selected card explicitly disclaims it:
    assert.ok(
      selectedText.includes('Report ≠ meteorite fall'),
      'Selected card must include the disclaimer that fireball report ≠ meteorite fall',
    );

    // Overlay entries test
    const renderedItems = [
      {
        event,
        burstPosition: { x: 100, y: 200, z: 300 },
        cullPosition: { x: 100, y: 200, z: 301 },
      },
      {
        event: {
          id: 'cneos:2024-01-02 00:00:00',
          eventTime: '2024-01-02T00:00:00.000Z',
          location: { lat: 10, lon: 10, altitude: 20 },
          energy: { impact: 0.1, radiated: 5 },
          trajectory: { entryVelocity: 12 },
        },
        burstPosition: { x: 400, y: 500, z: 600 },
        cullPosition: { x: 400, y: 500, z: 601 },
      },
    ];

    const entries = buildMeteorOverlayEntries(renderedItems, event.id);
    assert.equal(entries.length, 2);

    // All overlay entries must have cardStyle 'tactical'
    for (const entry of entries) {
      assert.equal(entry.cardStyle, 'tactical');
      const allEntryText = [entry.title, ...entry.details].join(' ');
      assert.doesNotMatch(
        allEntryText.toLowerCase(),
        /(?:confirms?|proves?|detected)\s+meteorite fall/i,
        'Overlay entries must never claim a meteorite fall',
      );
    }

    // Selected entry has highest priority and protected flag
    const selectedEntry = entries.find((e) => e.selected);
    assert.ok(selectedEntry);
    assert.equal(selectedEntry.id, `meteor:${event.id}`);
    assert.equal(selectedEntry.variant, 'selected');
    assert.equal(selectedEntry.protected, true);
    assert.equal(selectedEntry.priority, Number.MAX_SAFE_INTEGER);

    // Ambient entry has variant 'card' and lower priority
    const ambientEntry = entries.find((e) => !e.selected);
    assert.ok(ambientEntry);
    assert.equal(ambientEntry.variant, 'card');
    assert.equal(ambientEntry.protected, false);
    assert.ok(ambientEntry.priority < Number.MAX_SAFE_INTEGER);
  });
});

describe('createMeteorsLayer lifecycle & controls', () => {
  function createHarness(events = []) {
    const overlayState = {
      visible: false,
      entries: [],
      cleared: 0,
    };
    const overlayHost = {
      setVisible(_id, vis) {
        overlayState.visible = vis;
      },
      setEntries(_id, entries) {
        overlayState.entries = entries;
      },
      clearSource() {
        overlayState.entries = [];
        overlayState.cleared++;
      },
      hitTest() {
        return null;
      },
    };
    const contextState = {
      registered: new Map(),
      selected: null,
      cleared: 0,
    };
    const services = {
      picking: {
        registerPickOwner() {},
        unregisterPickOwner() {},
        resolvePickId: (p) => p?.id,
        isOwnedByOtherLayer: () => false,
      },
      context: {
        registerEntityContext(entity, meta) {
          contextState.registered.set(meta.id, { entity, meta });
        },
        selectEntityContext(entity) {
          contextState.selected = entity;
        },
        clearSelectedEntityContextForLayer() {
          contextState.selected = null;
          contextState.cleared++;
        },
      },
      render: {
        requestRender() {},
      },
    };
    const viewer = {
      dataSources: {
        list: [],
        add(ds) {
          this.list.push(ds);
        },
        remove(ds) {
          this.list = this.list.filter((item) => item !== ds);
        },
      },
      scene: {
        requestRender() {},
        preRender: {
          addEventListener() {
            return () => {};
          },
        },
      },
      camera: {
        flyToBoundingSphere() {
          viewer.flewCount = (viewer.flewCount || 0) + 1;
        },
      },
    };
    const feed = {
      async getSnapshot() {
        return {
          records: events,
          events,
          source: 'NASA/JPL CNEOS',
          coverage: 'Global',
          fetchedAt: Date.parse('2026-10-17T00:00:00Z'),
          latestObservationTime: events[0]?.eventTime || null,
          stale: false,
          unavailable: false,
        };
      },
    };
    const layer = createMeteorsLayer({
      id: 'meteors',
      name: 'Fireballs',
      services,
      feed,
      overlayHost,
    });
    return { layer, viewer, overlayState, contextState };
  }

  it('(6) throws without feed.getSnapshot and supports enable, update, timeWindow filter, selection, and disable', async () => {
    assert.throws(
      () => createMeteorsLayer({ services: {} }),
      /Meteors require a snapshot source/,
    );

    const sampleEvents = [
      {
        id: 'cneos:2026-10-04 03:14:45',
        source: 'cneos',
        eventTime: '2026-10-04T03:14:45.000Z',
        location: { lat: -41.8, lon: -173.1, altitude: 26.9 },
        energy: { radiated: 5.4, impact: 0.18 },
        trajectory: {
          entryVelocity: 13.8,
          vx: 14.8,
          vy: 2.9,
          vz: 2.2,
          entryAngle: 24.5,
          azimuth: 110,
          radiantAzimuth: 290,
        },
        confidence: { level: 'high' },
      },
      {
        id: 'cneos:2026-06-10 12:00:00',
        source: 'cneos',
        eventTime: '2026-06-10T12:00:00.000Z',
        location: { lat: 35.0, lon: -110.0, altitude: 38.0 },
        energy: { radiated: 240.0, impact: 6.2 },
        trajectory: {
          entryVelocity: 21.0,
          vx: -12.0,
          vy: 14.0,
          vz: -9.8,
          entryAngle: 41.2,
          azimuth: 140,
          radiantAzimuth: 320,
        },
        confidence: { level: 'high' },
      },
    ];

    const h = createHarness(sampleEvents);
    await h.layer.enable(h.viewer);
    await h.layer.update(h.viewer);

    // Default window is 1y -> both events included
    const stats1y = h.layer.getStats();
    assert.equal(stats1y.count, 2);
    assert.match(stats1y.loadingLabel, /DELAYED CATALOG/);

    // Overlay cards published for both events, newest auto-selected
    assert.equal(h.overlayState.visible, true);
    assert.equal(h.overlayState.entries.length, 2);
    assert.equal(h.layer.getSelectedInfo().id, 'cneos:2026-10-04 03:14:45');

    // Row controls contain 4 time-window chips + 3 selection chips, 4 legend items, list, and info
    const controls = h.layer.getRowControls();
    assert.ok(controls.chips.some((c) => c.id === 'window-30d'));
    assert.ok(controls.chips.some((c) => c.id === 'window-1y' && c.active));
    assert.ok(controls.chips.some((c) => c.id === 'focus-selected'));
    assert.equal(controls.legend.length, 4);
    assert.equal(controls.list.items.length, 2);
    assert.match(controls.info, /Delayed US Gov sensor catalog/);

    // Switch time window to 30d -> only 1 event remains
    h.layer.setParams({ timeWindow: '30d' });
    assert.equal(h.layer.getStats().count, 1);
    assert.equal(h.overlayState.entries.length, 1);

    // Switch back to 1y, select second event with focus
    h.layer.setParams({ timeWindow: '1y' });
    h.layer.setParams({
      eventId: 'cneos:2026-06-10 12:00:00',
      focus: true,
    });
    assert.equal(h.layer.getSelectedInfo().id, 'cneos:2026-06-10 12:00:00');
    assert.equal(h.viewer.flewCount, 1);

    // Clear selection
    h.layer.setParams({ clear: true });
    assert.equal(h.layer.getSelectedInfo(), null);

    // Disable clears overlayHost
    h.layer.disable();
    assert.equal(h.overlayState.visible, false);
    assert.equal(h.overlayState.entries.length, 0);
  });
});

describe('Stage 2: GMN, NASA ASGARD, ARES Falls & Cross-Source Corroboration', () => {
  it('(7) parseGmnTrajectorySummary parses 86-col GMN data, classifies TisserandJ orbit, and preserves CC BY 4.0 attribution', () => {
    const row = Array(86).fill('0');
    row[0] = '20261016090346_bfK1u';
    row[2] = '2026-10-16 09:03:46.474813';
    row[3] = '8';
    row[4] = 'ORI';
    row[7] = '95.2';
    row[9] = '15.8';
    row[15] = '66.4';
    row[21] = '41.2';
    row[23] = '15.1';
    row[25] = '0.96';
    row[27] = '163.9';
    row[37] = '0.57';
    row[49] = '-0.62'; // Halley-type comet (T_J <= 2)
    row[55] = '135.0';
    row[57] = '42.3';
    row[59] = '67.5';
    row[61] = '65.8';
    row[63] = '34.9773';
    row[65] = '-112.9604';
    row[67] = '123.9';
    row[69] = '34.9621';
    row[71] = '-113.5536';
    row[73] = '81.9';
    row[75] = '0.88';
    row[76] = '-6.57';
    row[77] = '94.2';
    row[79] = '0.0087';
    row[80] = '34.2';
    row[81] = '28.5';
    row[84] = '4';
    row[85] = 'US0001,US0002,US0003,US0004';

    const sampleText = [
      '# Summary generated on 2026-10-17 14:37:42.488792+00:00 UTC',
      '# header 1',
      row.join('; '),
    ].join('\n');

    const parsed = parseGmnTrajectorySummary(sampleText, {
      now: 1792200000000,
    });
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.publicationTime, '2026-10-17T14:37:42.488Z');
    const ev = parsed.events[0];
    assert.equal(ev.id, 'gmn:20261016090346_bfK1u');
    assert.equal(ev.source, 'gmn');
    assert.equal(ev.magnitude, -6.57);
    assert.equal(ev.mass, 0.0087);
    assert.equal(ev.orbit.showerCode, 'ORI');
    assert.match(ev.orbit.orbitalClass, /Halley-Type/);
    assert.equal(ev.trajectory.startAltKm, 123.9);
    assert.equal(ev.trajectory.endAltKm, 81.9);
    assert.equal(ev.stations.count, 4);
    assert.match(ev.attribution.license, /CC BY 4\.0/);

    assert.match(classifyTisserandOrbit(3.4), /Asteroidal/);
    assert.match(classifyTisserandOrbit(2.5), /Jupiter-Family/);
    assert.equal(formatShowerLabel('ORI'), 'Orionids (ORI)');
  });

  it('(8) parseAsgardSkyfallMapHtml + enrichAsgardEventFromDetailHtml parse camera trajectories and Chicken Little solver fields', () => {
    const mapHtml = `
      var poly_line_abc = L.polyline([[46.265, -117.669], [46.691, -116.643]], {});
      <a href="https://fireballs.ndc.nasa.gov/skyfalls/events/20261015-015610">20261015-015610</a>
    `;
    const events = parseAsgardSkyfallMapHtml(mapHtml, 1792200000000);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.id, 'asgard:20261015-015610');
    assert.equal(ev.trajectory.startLat, 46.265);
    assert.equal(ev.trajectory.endLon, -116.643);

    const detailHtml = `
      <div>Event Data</div>
      <div>Chicken Little Altitude</div>
      <div>79.3 km → 47.3 km (49.3 miles → 29.4 miles)</div>
      <div>Chicken Little Speed</div>
      <div>16.2 km/s (36,200 mph)</div>
    `;
    enrichAsgardEventFromDetailHtml(ev, detailHtml);
    assert.equal(ev.trajectory.startAltKm, 79.3);
    assert.equal(ev.trajectory.endAltKm, 47.3);
    assert.equal(ev.trajectory.entryVelocity, 16.2);
    assert.ok(Number.isFinite(ev.trajectory.entryAngle));
  });

  it('(9) corroborateMeteorEvents flags cross-source matches without silent merging and supports sourceFilter chips', () => {
    const cneosEv = {
      id: 'cneos:2026-08-14 08:10:00',
      source: 'cneos',
      eventTime: '2026-08-14T08:10:00.000Z',
      location: { lat: 47.82, lon: -119.38, altitude: 32 },
      energy: { impact: 0.45, radiated: 12 },
      trajectory: { entryVelocity: 15.2 },
    };
    const gmnEv = {
      id: 'gmn:20260814081002_xyz',
      source: 'gmn',
      eventTime: '2026-08-14T08:10:02.000Z',
      location: { lat: 47.84, lon: -119.4, altitude: 31.5 },
      magnitude: -5.8,
      mass: 0.015,
      orbit: { showerCode: 'PER', orbitalClass: 'Halley-Type' },
      trajectory: {
        startLat: 47.41,
        startLon: -119.41,
        startAltKm: 110,
        endLat: 47.84,
        endLon: -119.4,
        endAltKm: 31.5,
        entryVelocity: 59.1,
      },
    };
    const aresFalls = buildAresFallEvents(1792200000000);
    const simsCorner = aresFalls.find((f) => f.id === 'ares:sims-corner-wa');
    assert.ok(simsCorner);

    const combined = corroborateMeteorEvents([cneosEv, gmnEv, simsCorner]);
    assert.equal(combined.length, 3);
    // All 3 records remain separate (no silent merge) and cross-reference each other
    assert.equal(cneosEv.possibleMatches.length, 2);
    assert.equal(gmnEv.possibleMatches.length, 2);
    assert.equal(simsCorner.possibleMatches.length, 2);

    // Source filtering works for 'gmn', 'ares', and 'matched'
    const refMs = Date.parse('2026-10-17T00:00:00Z');
    assert.equal(
      filterEventsByWindow(combined, '1y', refMs, 'gmn').length,
      1,
    );
    assert.equal(
      filterEventsByWindow(combined, '1y', refMs, 'ares').length,
      1,
    );
    assert.equal(
      filterEventsByWindow(combined, '1y', refMs, 'matched').length,
      3,
    );
  });
});

describe('Stage 4: Historical Upper-Air Wind Sounding, 3-Model Dark Flight & Zone of Possibility', () => {
  const sampleSounding = parseOpenMeteoSounding(
    {
      hourly: {
        time: ['2026-08-14T00:00', '2026-08-14T08:00'],
        temperature_2m: [18, 21],
        pressure_msl: [1012, 1013],
        wind_speed_10m: [3, 4],
        wind_direction_10m: [270, 270], // blowing from West -> East (+u)
        wind_speed_850hPa: [8, 10],
        wind_direction_850hPa: [260, 260],
        geopotential_height_850hPa: [1500, 1520],
        temperature_850hPa: [10, 11],
        wind_speed_500hPa: [15, 18],
        wind_direction_500hPa: [250, 250],
        geopotential_height_500hPa: [5600, 5620],
        temperature_500hPa: [-15, -14],
        wind_speed_300hPa: [32, 38],
        wind_direction_300hPa: [270, 270],
        geopotential_height_300hPa: [9200, 9250],
        temperature_300hPa: [-42, -41],
        wind_speed_50hPa: [12, 14],
        wind_direction_50hPa: [280, 280],
        geopotential_height_50hPa: [20600, 20650],
        temperature_50hPa: [-55, -54],
      },
    },
    {
      lat: 47.04,
      lon: -119.35,
      targetIso: '2026-08-14T08:00:00Z',
      targetHourUtc: 1,
    },
  );

  it('(10) parseOpenMeteoSounding converts meteorological wind directions into East/North UV and summarizes jet stream peak', () => {
    const uvWest = windSpeedDirToUV(10, 270); // From West (270°) blows East (+u = +10)
    assert.equal(uvWest.u, 10);
    assert.equal(uvWest.v, 0);

    assert.equal(sampleSounding.summary.peakWindSpeedMs, 38);
    assert.equal(sampleSounding.summary.peakWindHeadingToDeg, 90);
    assert.ok(sampleSounding.samples.length >= 5);
  });

  it('(11) evaluateSurvivalPhysics enforces hard limits on high-altitude complete ablation', () => {
    const highAltGmn = {
      id: 'gmn:high',
      source: 'gmn',
      location: { lat: 35, lon: -110, altitude: 88.4 },
      mass: 0.0004,
      trajectory: { entryVelocity: 66.2, azimuth: 140, entryAngle: 42 },
    };
    const gate = evaluateSurvivalPhysics(highAltGmn);
    assert.equal(gate.survivable, false);
    assert.equal(gate.regime, 'ablation-complete');

    const df = runMultiModelDarkFlight(highAltGmn, sampleSounding);
    assert.equal(df.feasible, false);
    assert.equal(df.massSweep.length, 0);
  });

  it('(12) runMultiModelDarkFlight runs 3-model strewn field (5-mass spine + Monte Carlo + ARES cross-calibration) and Weighted Zone of Possibility', () => {
    const aresFall = {
      id: 'ares:sims-corner-wa',
      source: 'ares',
      name: 'Sims Corner, WA',
      location: { lat: 47.04, lon: -119.35, altitude: 0 },
    };
    const fullVectorEvent = {
      id: 'cneos:2026-08-14 07:48:00',
      source: 'cneos',
      location: { lat: 47.06, lon: -119.42, altitude: 28 },
      trajectory: {
        entryVelocity: 14.2,
        azimuth: 95,
        entryAngle: 45,
        vx: -8,
        vy: -9,
        vz: -7,
      },
      possibleMatches: [{ id: 'ares:sims-corner-wa', source: 'ARES' }],
    };

    const fullResult = runMultiModelDarkFlight(fullVectorEvent, sampleSounding, {
      allEvents: [fullVectorEvent, aresFall],
      nFragments: 80,
    });
    assert.equal(fullResult.feasible, true);
    assert.equal(fullResult.regime, 'full-3d-strewn-field');
    assert.equal(fullResult.massSweep.length, 7);
    assert.equal(fullResult.monteCarloImpacts.length, 80);
    assert.ok(fullResult.ellipse2Sigma.semiMajorM > 0);
    assert.ok(Number.isFinite(fullResult.calibration.crossModelOffsetM));
    assert.ok(Number.isFinite(fullResult.calibration.aresResidualM));
    assert.ok(fullResult.calibration.alongTrackKm > 0);

    // Partial-data event without entry azimuth -> Weighted Directional Zone of Possibility
    const noVectorEvent = {
      id: 'cneos:no-vector',
      source: 'cneos',
      location: { lat: 47.04, lon: -119.35, altitude: 27 },
      trajectory: { entryVelocity: 15.0, azimuth: null, entryAngle: null },
    };
    const zoneResult = runMultiModelDarkFlight(noVectorEvent, sampleSounding, {
      nFragments: 80,
    });
    assert.equal(zoneResult.feasible, true);
    assert.equal(zoneResult.regime, 'zone-of-possibility');
    assert.equal(zoneResult.massSweep.length, 7);
    assert.ok(zoneResult.ellipse2Sigma.semiMajorM > 0);
    assert.ok(zoneResult.ellipseInnerCore.semiMajorM > 0);
  });

  it('(13) getFoundStonesForEvent, setCustomFoundStones, and autoFitDarkFlightToFoundStones compute per-stone mass residuals and fine-tune parameters', () => {
    const simsEvent = {
      id: 'cneos:2026-08-14 07:48:00',
      source: 'cneos',
      location: { lat: 47.8501, lon: -119.4084, altitude: 45.5 },
      trajectory: {
        entryVelocity: 14.6,
        azimuth: 0,
        entryAngle: 33.6,
        vx: 5.2,
        vy: 22.3,
        vz: 0.2,
      },
      possibleMatches: [{ id: 'ares:sims-corner-wa', source: 'ARES' }],
    };

    const stones = getFoundStonesForEvent(simsEvent);
    assert.equal(stones.length, 6);

    const baselineDf = runMultiModelDarkFlight(simsEvent, sampleSounding, {
      nFragments: 40,
      autoFit: false,
    });
    assert.equal(baselineDf.stoneFit.comparisons.length, 6);
    assert.ok(Number.isFinite(baselineDf.stoneFit.baselineRmsM));

    const fittedDf = runMultiModelDarkFlight(simsEvent, sampleSounding, {
      nFragments: 40,
      autoFit: true,
    });
    assert.ok(fittedDf.stoneFit.tuning);
    assert.ok(
      fittedDf.stoneFit.bestRmsM <= baselineDf.stoneFit.baselineRmsM,
      'autoFit should reduce or match baseline RMS error',
    );

    const custom = setCustomFoundStones('custom:event', [
      { lat: 35.1, lon: -106.5, massGrams: 250, label: 'Test Stone A' },
    ]);
    assert.equal(custom.length, 1);
    assert.equal(getFoundStonesForEvent({ id: 'custom:event' }).length, 1);
  });

  it('(14) buildMeteorEventSceneRecipe and registerMeteorScenesInDirector auto-generate 4-shot cinematic scenes for skyfall events', () => {
    const pose = cameraPoseLookingAtTarget({
      targetLat: 47.87,
      targetLon: -119.37,
      targetAltM: 0,
      cameraAltM: 10000,
      headingDeg: 0,
      pitchDeg: -45,
    });
    // Looking due North (0°) at pitch -45° from 10km altitude places camera 10km South of target
    assert.ok(pose.lat < 47.87);
    assert.equal(pose.lon, -119.37);

    const aresFalls = buildAresFallEvents(1792200000000);
    const sims = aresFalls.find((f) => f.id === 'ares:sims-corner-wa');
    const recipe = buildMeteorEventSceneRecipe(sims, aresFalls);
    assert.ok(recipe);
    assert.equal(recipe.cameraPath.length, 4);
    assert.match(recipe.cameraPath[3].title, /Found Stones/);

    const mockDirector = {
      _project: { scenes: [] },
      _selectedSceneId: null,
      _selectedShotId: null,
      _saveProject() {},
      _renderSceneSelect() {},
      _renderShotList() {},
    };
    const registered = registerMeteorScenesInDirector(
      mockDirector,
      aresFalls.slice(0, 3),
      aresFalls,
      { selectFirst: true },
    );
    assert.equal(registered.length, 3);
    assert.equal(mockDirector._project.scenes.length, 3);
    assert.equal(mockDirector._project.scenes[0].shots.length, 4);
  });

  it('15. computes 3D double-ended uncertainty cones, NEXRAD radar gate checks, GOES GLM/IR diagnostics, and Over/Under ground yield', async () => {
    const {
      computeFlightPathUncertaintyCones,
      computeGoesSatelliteDiagnostics,
    } = await import('./validation.js');
    const aresFalls = buildAresFallEvents(1792200000000);
    const sims = aresFalls.find((f) => f.id === 'ares:sims-corner-wa');
    const asgardPartner = {
      id: 'asgard:20260814-074833',
      source: 'asgard',
      eventTime: '2026-08-14T07:48:33.000Z',
      location: { lat: 47.8501, lon: -119.4084, altitude: 45.5 },
      trajectory: {
        startLat: 47.4117,
        startLon: -119.4122,
        startAltKm: 77.9,
        endLat: 47.8501,
        endLon: -119.4084,
        endAltKm: 45.5,
        azimuth: 0.4,
        entryAngle: 33.7,
        entryVelocity: 14.6,
      },
      possibleMatches: [{ id: 'ares:sims-corner-wa', source: 'ARES' }],
    };
    sims.possibleMatches = [{ id: 'asgard:20260814-074833', source: 'ASGARD' }];

    const cones = computeFlightPathUncertaintyCones(sims, [sims, asgardPartner]);
    assert.ok(cones);
    assert.equal(cones.sourceType, 'asgard');
    assert.ok(cones.waistRadius1SigmaM < cones.entryRadius1SigmaM);
    assert.ok(cones.waistRadius1SigmaM < cones.terminusRadius1SigmaM);

    const goes = computeGoesSatelliteDiagnostics(sims, asgardPartner);
    assert.ok(goes);
    assert.match(goes.satellite, /GOES-18/);
    assert.ok(goes.parallaxShiftKm > 15);

    const df = runMultiModelDarkFlight(sims, null, {
      allEvents: [sims, asgardPartner],
      nFragments: 32,
      autoFit: true,
    });
    assert.ok(df.validation);
    assert.ok(df.validation.overUnder);
    assert.equal(df.validation.overUnder.recoveredFloor.stoneCount, 6);
    assert.ok(
      df.validation.overUnder.under1Sigma.totalYieldKg <
        df.validation.overUnder.consensusMedian.totalYieldKg,
    );
    assert.ok(
      df.validation.overUnder.consensusMedian.totalYieldKg <
        df.validation.overUnder.over2Sigma.totalYieldKg,
    );
    assert.ok(df.validation.radarCheck);
    assert.equal(df.validation.radarCheck.elapsedSec, 125);
    assert.ok(df.massSweep[0].underPoint && df.massSweep[0].overPoint);
  });

  it('16. executes Stage 5 7-phase physics upgrades: groundElevationM cutoff, coupled ablation dm/dt, bow-shock lateral impulse, aerodynamic lift, vertical wind w, Poncelet burial depth, and Weibull fracture cascade', async () => {
    const {
      integrateFragmentDarkFlight,
      computeBowShockLateralSpeedMs,
      computeImpactPenetration,
    } = await import('./darkFlight.js');
    const { computeWeibullFractureCascade } = await import('./validation.js');

    // Phase 1: Terrain Elevation Intersection (groundElevationM = 690m vs 0m)
    const seaLevelImp = integrateFragmentDarkFlight({
      terminalLat: 47.85,
      terminalLon: -119.37,
      terminalAltM: 28000,
      terminalSpeedMs: 1200,
      azimuthDeg: 0,
      entryAngleDeg: 35,
      massKg: 0.025,
      sounding: sampleSounding,
      groundElevationM: 0,
      recordTrack: true,
    });
    const plateauImp = integrateFragmentDarkFlight({
      terminalLat: 47.85,
      terminalLon: -119.37,
      terminalAltM: 28000,
      terminalSpeedMs: 1200,
      azimuthDeg: 0,
      entryAngleDeg: 35,
      massKg: 0.025,
      sounding: sampleSounding,
      groundElevationM: 690,
      recordTrack: true,
    });
    assert.equal(plateauImp.groundElevationM, 690);
    assert.equal(plateauImp.track.at(-1).altM, 690);
    assert.ok(
      plateauImp.flightTimeSec < seaLevelImp.flightTimeSec,
      '690m plateau elevation terminates flight earlier than sea level',
    );

    // Phase 2: Coupled Hypersonic Ablation (dm/dt for v > 3 km/s)
    const hyperAblated = integrateFragmentDarkFlight({
      terminalLat: 47.85,
      terminalLon: -119.37,
      terminalAltM: 42000,
      terminalSpeedMs: 5200,
      azimuthDeg: 0,
      entryAngleDeg: 35,
      massKg: 0.1,
      ablationSigma: 0.024,
      ablateFromInitialMass: true,
      sounding: sampleSounding,
    });
    assert.ok(hyperAblated.massKg < 0.1, 'hypersonic fragment loses mass via dm/dt');
    assert.ok(hyperAblated.ablationMassLossPct > 0);
    assert.ok(Number.isFinite(hyperAblated.darkFlightOnsetAltKm));

    // Phase 3: Bow-Shock Transverse Fragmentation Impulse (v_perp scales with m^-1/6)
    const vPerpSmall = computeBowShockLateralSpeedMs({
      altM: 45500,
      speedMs: 1200,
      massKg: 0.01,
      lateralImpulseCoeff: 0.55,
    });
    const vPerpLarge = computeBowShockLateralSpeedMs({
      altM: 45500,
      speedMs: 1200,
      massKg: 1.0,
      lateralImpulseCoeff: 0.55,
    });
    assert.ok(vPerpSmall > vPerpLarge, 'smaller fragments receive higher lateral impulse');

    // Phase 4: Magnus / Aerodynamic Lift & Gliding (L/D > 0 shifts landing point)
    const glidingImp = integrateFragmentDarkFlight({
      terminalLat: 47.85,
      terminalLon: -119.37,
      terminalAltM: 28000,
      terminalSpeedMs: 1200,
      azimuthDeg: 0,
      entryAngleDeg: 35,
      massKg: 0.05,
      liftToDragRatio: 0.12,
      liftAzimuthRad: 0,
      sounding: sampleSounding,
    });
    const noLiftImp = integrateFragmentDarkFlight({
      terminalLat: 47.85,
      terminalLon: -119.37,
      terminalAltM: 28000,
      terminalSpeedMs: 1200,
      azimuthDeg: 0,
      entryAngleDeg: 35,
      massKg: 0.05,
      liftToDragRatio: 0,
      sounding: sampleSounding,
    });
    assert.notEqual(glidingImp.lon, noLiftImp.lon, 'non-zero liftToDragRatio displaces landing coordinate');

    // Phase 5: Vertical Wind Updraft (w > 0 lengthens fall time and downwind drift)
    const updraftImp = integrateFragmentDarkFlight({
      terminalLat: 47.85,
      terminalLon: -119.37,
      terminalAltM: 20000,
      terminalSpeedMs: 800,
      azimuthDeg: 0,
      entryAngleDeg: 45,
      massKg: 0.01,
      verticalWindMs: 2.5,
      sounding: sampleSounding,
    });
    const zeroVertImp = integrateFragmentDarkFlight({
      terminalLat: 47.85,
      terminalLon: -119.37,
      terminalAltM: 20000,
      terminalSpeedMs: 800,
      azimuthDeg: 0,
      entryAngleDeg: 45,
      massKg: 0.01,
      verticalWindMs: 0,
      sounding: sampleSounding,
    });
    assert.ok(updraftImp.flightTimeSec > zeroVertImp.flightTimeSec);

    // Phase 6: Impact Terminal Velocity, Kinetic Energy & Poncelet Soil Penetration
    const pen10g = computeImpactPenetration({
      massKg: 0.01,
      impactSpeedMs: 22,
      impactAngleDeg: 78,
    });
    const pen1kg = computeImpactPenetration({
      massKg: 1.0,
      impactSpeedMs: 78,
      impactAngleDeg: 82,
    });
    assert.ok(pen1kg.impactEnergyJ > pen10g.impactEnergyJ);
    assert.ok(pen1kg.penetrationDepthCm > pen10g.penetrationDepthCm);
    assert.ok(
      pen1kg.penetrationBySurface.softSoilCm >
        pen1kg.penetrationBySurface.hardpanCm,
    );

    // Phase 7: Weibull Progressive Fracture Cascade
    const weibull = computeWeibullFractureCascade(
      { mass: 77.1 },
      { ramPressureMpa: 1.04, endAltKm: 45.5 },
    );
    assert.equal(weibull.flare1SharePct + weibull.flare2SharePct, 100);
    assert.ok(weibull.powerLawExponent > 1.6);
    assert.match(weibull.summary, /Weibull Cascade/);
  });
});
