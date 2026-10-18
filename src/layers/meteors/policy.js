import * as Cesium from 'cesium';

export const LAYER_ID = 'meteors';
export const LAYER_NAME = 'Fireballs';
export const API_ENDPOINT = '/api/fireballs';
export const REFRESH_INTERVAL_MS = 600_000; // 10m client poll; 6h server cache TTL
export const MAX_EVENTS = 1000;

export const METEORS_OVERLAY_SOURCE_ID = 'meteors';
export const METEORS_OVERLAY_COHORT_LIMIT = 28;

export const TIME_WINDOWS = Object.freeze([
  Object.freeze({ id: '7d', label: '7D', days: 7 }),
  Object.freeze({ id: '30d', label: '30D', days: 30 }),
  Object.freeze({ id: '90d', label: '90D', days: 90 }),
  Object.freeze({ id: '1y', label: '1Y', days: 365 }),
  Object.freeze({ id: '5y', label: '5Y', days: 1825 }),
]);

export const DEFAULT_TIME_WINDOW = '1y';

export const SOURCE_FILTERS = Object.freeze([
  Object.freeze({
    id: 'all',
    label: 'ALL',
    title: 'All meteor & fireball sources (CNEOS + GMN + ASGARD + ARES)',
  }),
  Object.freeze({
    id: 'cneos',
    label: 'CNEOS',
    title: 'NASA/JPL CNEOS US Government satellite sensor bolides',
  }),
  Object.freeze({
    id: 'gmn',
    label: 'GMN',
    title: 'Global Meteor Network multi-camera optical trajectories (CC BY 4.0)',
  }),
  Object.freeze({
    id: 'asgard',
    label: 'ASGARD',
    title: 'NASA MSFC All-Sky Fireball Network camera trajectories',
  }),
  Object.freeze({
    id: 'ares',
    label: 'FALLS',
    title: 'NASA ARES documented radar-confirmed meteorite falls',
  }),
  Object.freeze({
    id: 'matched',
    label: '★ MATCHED',
    title: 'Cross-source corroborated events only',
  }),
]);

export const DEFAULT_SOURCE_FILTER = 'all';

export const SEVERITY_COLORS = Object.freeze({
  major: '#ef4444', // CNEOS >= 5 kt TNT
  medium: '#f97316', // CNEOS 0.5 - 5 kt TNT
  minor: '#f59e0b', // CNEOS < 0.5 kt TNT
  gmn: '#c084fc', // GMN optical trajectory (violet)
  asgard: '#34d399', // NASA ASGARD camera trajectory (emerald)
  ares: '#a3e635', // NASA ARES confirmed meteorite fall (lime)
  corroborated: '#38bdf8', // Cross-source corroborated highlight
  selected: '#ffe19a', // Selected highlight
  vector: '#38bdf8', // 3D atmospheric entry vector
  tether: '#94a3b8', // Altitude plumb tether
});

export const POINT_COLOR = Cesium.Color.fromCssColorString(
  SEVERITY_COLORS.medium,
);
export const POINT_SIZE = 10;
export const SELECTED_COLOR = Cesium.Color.fromCssColorString(
  SEVERITY_COLORS.selected,
);
export const SELECTED_SIZE = 16;

export const COVERAGE =
  'Global (CNEOS sensors · GMN ~1,365 cameras CC BY 4.0 · NASA ASGARD/ARES)';
export const CNEOS_CATALOG_URL = 'https://cneos.jpl.nasa.gov/fireballs/';
export const GMN_STATUS_URL = 'https://globalmeteornetwork.org/status/';
export const GMN_FLUX_URL = 'https://globalmeteornetwork.org/flux/';
export const AMS_VIEWER_URL = 'https://www.amsmeteors.org/fireballs/viewer/';
