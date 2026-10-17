import * as Cesium from 'cesium';
import {
  POINT_COLOR,
  POINT_SIZE,
  SELECTED_COLOR,
  SELECTED_SIZE,
} from './policy.js';

export function createRendering({ layerState, services, components, config }) {
  function clearEntities() {
    if (!layerState._dataSource) return;
    layerState._dataSource.entities.removeAll();
    layerState._entityById.clear();
  }

  function addEntity(event) {
    if (!layerState._dataSource) return;
    const id = event.id;
    if (layerState._entityById.has(id)) return;

    const isSelected = id === layerState._selectedEventId;
    const color = isSelected ? SELECTED_COLOR : POINT_COLOR;
    const pixelSize = isSelected ? SELECTED_SIZE : POINT_SIZE;

    const entity = layerState._dataSource.entities.add({
      id,
      position: Cesium.Cartesian3.fromDegrees(
        event.location.lon,
        event.location.lat,
        (event.location.altitude || 0) * 1000,
      ),
      point: {
        pixelSize,
        color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: {
        eventId: id,
        event: event,
      },
    });

    layerState._entityById.set(id, entity);
  }

  function update(events) {
    if (!layerState._dataSource) return;
    clearEntities();
    for (const event of events) {
      addEntity(event);
    }
  }

  function selectEvent(eventId) {
    layerState._selectedEventId = eventId;
    for (const [id, entity] of layerState._entityById) {
      const isSelected = id === eventId;
      entity.point.color = isSelected ? SELECTED_COLOR : POINT_COLOR;
      entity.point.pixelSize = isSelected ? SELECTED_SIZE : POINT_SIZE;
    }
  }

  function installClickHandler() {
    if (!layerState._viewer || layerState._clickHandler) return;
    const handler = new Cesium.ScreenSpaceEventHandler(layerState._viewer.scene.canvas);
    handler.setInputAction((click) => {
      const picked = layerState._viewer.scene.pick(click.position);
      if (Cesium.defined(picked) && picked.id && picked.id.properties) {
        const eventId = picked.id.properties.eventId?.getValue();
        if (eventId) {
          selectEvent(eventId);
          if (services.context?.setSelectedEntity) {
            services.context.setSelectedEntity('meteors', eventId);
          }
        }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    layerState._clickHandler = handler;
  }

  function removeClickHandler() {
    if (layerState._clickHandler) {
      layerState._clickHandler.destroy();
      layerState._clickHandler = null;
    }
  }

  return {
    update,
    selectEvent,
    installClickHandler,
    removeClickHandler,
    clearEntities,
  };
}
