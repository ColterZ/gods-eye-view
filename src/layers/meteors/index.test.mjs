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
      location: { lat: 47.05, lon: -119.3, altitude: 32 },
      energy: { impact: 0.45, radiated: 12 },
      trajectory: { entryVelocity: 15.2 },
    };
    const gmnEv = {
      id: 'gmn:20260814081002_xyz',
      source: 'gmn',
      eventTime: '2026-08-14T08:10:02.000Z',
      location: { lat: 47.04, lon: -119.34, altitude: 31.5 },
      magnitude: -5.8,
      mass: 0.015,
      orbit: { showerCode: 'PER', orbitalClass: 'Halley-Type' },
      trajectory: {
        startLat: 47.3,
        startLon: -119.0,
        startAltKm: 110,
        endLat: 47.04,
        endLon: -119.34,
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
