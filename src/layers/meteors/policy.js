import * as Cesium from 'cesium';

export const LAYER_ID = 'meteors';
export const LAYER_NAME = 'Fireballs';
export const API_ENDPOINT = '/api/fireballs';
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MAX_EVENTS = 1000;

export const POINT_COLOR = Cesium.Color.fromCssColorString('#ff6600');
export const POINT_SIZE = 8;
export const SELECTED_COLOR = Cesium.Color.fromCssColorString('#ffcc00');
export const SELECTED_SIZE = 12;

export const COVERAGE = 'Global (US Government sensors); 1988-present';
