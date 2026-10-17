import * as Cesium from 'cesium';

export const LAYER_ID = 'meteors';
export const LAYER_NAME = 'Fireballs';
export const API_ENDPOINT = '/api/fireballs';
export const REFRESH_INTERVAL_MS = 600_000; // 10m client poll; 6h server cache TTL
export const MAX_EVENTS = 500;

export const METEORS_OVERLAY_SOURCE_ID = 'meteors';
export const METEORS_OVERLAY_COHORT_LIMIT = 24;

export const TIME_WINDOWS = Object.freeze([
  Object.freeze({ id: '30d', label: '30D', days: 30 }),
  Object.freeze({ id: '90d', label: '90D', days: 90 }),
  Object.freeze({ id: '1y', label: '1Y', days: 365 }),
  Object.freeze({ id: '5y', label: '5Y', days: 1825 }),
]);

export const DEFAULT_TIME_WINDOW = '1y';

export const SEVERITY_COLORS = Object.freeze({
  major: '#ef4444', // >= 5 kt TNT
  medium: '#f97316', // 0.5 - 5 kt TNT
  minor: '#f59e0b', // < 0.5 kt TNT
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
  'Global (US Government sensors; delayed catalog, 1988–present)';
export const CNEOS_CATALOG_URL = 'https://cneos.jpl.nasa.gov/fireballs/';
