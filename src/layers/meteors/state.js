import { DEFAULT_TIME_WINDOW, DEFAULT_SOURCE_FILTER } from './policy.js';

export function createMeteorsState({ services, config }) {
  const layerState = {};

  layerState._viewer = null;
  layerState._dataSource = null;
  layerState._enabled = false;
  layerState._destroyed = false;
  layerState._loading = false;
  layerState._stale = false;
  layerState._unavailable = false;
  layerState._error = null;

  layerState._snapshot = null;
  layerState._events = [];
  layerState._filteredEvents = [];
  layerState._timeWindow = DEFAULT_TIME_WINDOW;
  layerState._sourceFilter = DEFAULT_SOURCE_FILTER;
  layerState._selectedEventId = null;
  layerState._selectionIntent = 'auto';
  layerState._lastUpdate = null;
  layerState._latestObservationTime = null;

  layerState._listener = null;
  layerState._runNavigation = null;
  layerState._navigationGeneration = 0;
  layerState._request = null;

  layerState._clickHandler = null;
  layerState._preRenderRemover = null;

  layerState._entityById = new Map();
  layerState._pickEventIdByEntityId = new Map();
  layerState._spheresByEventId = new Map();
  layerState._horizonItems = [];
  layerState._renderedItems = [];

  layerState._darkFlightActive = false;
  layerState._darkFlightMode = 'all';
  layerState._darkFlightAutoFit = true;
  layerState._customTuning = null;
  layerState._groundLabelsMode = 'compact';
  layerState._darkFlightLoading = false;
  layerState._darkFlightResult = null;
  layerState._darkFlightEntities = [];
  layerState._sceneDirector = null;
  layerState._syncedScenesCount = 0;
  layerState._rightPanel = null;

  layerState.notify = () => {
    layerState._listener?.();
  };

  return layerState;
}
