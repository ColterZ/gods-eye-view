export function createMeteorsState({ services, config }) {
  const layerState = {};

  layerState._viewer = null;
  layerState._dataSource = null;
  layerState._enabled = false;
  layerState._destroyed = false;
  layerState._loading = false;
  layerState._stale = false;
  layerState._error = null;

  layerState._events = [];
  layerState._selectedEventId = null;
  layerState._lastUpdate = null;

  layerState._clickHandler = null;
  layerState._preRenderRemover = null;

  layerState._entityById = new Map();

  return layerState;
}
