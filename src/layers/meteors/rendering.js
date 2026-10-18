import * as Cesium from 'cesium';
import {
  METEORS_OVERLAY_SOURCE_ID,
  METEORS_OVERLAY_COHORT_LIMIT,
  SEVERITY_COLORS,
} from './policy.js';
import {
  severityTier,
  computeEventGeometry,
  buildMeteorCardModel,
  buildMeteorOverlayEntries,
  meteorIdFromOverlayEntryId,
  formatEnergyKt,
  formatLatLon,
} from './model.js';
import { isPointerFree } from '../../data/inputOwnership.js';

export function createRendering({ layerState, services, components, config }) {
  const overlayHost = config.overlayHost;
  const registerEntityContext =
    services.context?.registerEntityContext || (() => {});
  const selectEntityContext =
    services.context?.selectEntityContext || (() => {});
  const clearSelectedEntityContextForLayer =
    services.context?.clearSelectedEntityContextForLayer || (() => {});

  let pointOccluder = null;
  let sphereOccluder = null;

  function requestRender() {
    services.render?.requestRender?.('meteors');
    if (layerState._viewer && !layerState._viewer.isDestroyed?.()) {
      layerState._viewer.scene?.requestRender?.();
    }
  }

  function cullHorizon() {
    const viewer = layerState._viewer;
    if (!viewer || viewer.isDestroyed?.() || !layerState._horizonItems.length)
      return;
    const camPos = viewer.camera?.positionWC;
    if (!camPos) return;
    pointOccluder ||= new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      camPos,
    );
    sphereOccluder ||= new Cesium.Occluder(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.ZERO,
        Cesium.Ellipsoid.WGS84.minimumRadius,
      ),
      camPos,
    );
    pointOccluder.cameraPosition = camPos;
    sphereOccluder.cameraPosition = camPos;

    let changed = false;
    for (let i = 0; i < layerState._horizonItems.length; i++) {
      const item = layerState._horizonItems[i];
      for (let j = 0; j < item.points.length; j++) {
        const { entity, position } = item.points[j];
        const show = pointOccluder.isPointVisible(position) === true;
        if (entity.show !== show) {
          entity.show = show;
          changed = true;
        }
      }
      if (!item.shapes.length || !item.sphere) continue;
      const showShapes =
        sphereOccluder.isBoundingSphereVisible(item.sphere) === true;
      for (let j = 0; j < item.shapes.length; j++) {
        const shapeEntity = item.shapes[j];
        if (shapeEntity.show !== showShapes) {
          shapeEntity.show = showShapes;
          changed = true;
        }
      }
    }
    if (changed) requestRender();
  }

  function syncHorizonListener() {
    const viewer = layerState._viewer;
    if (!layerState._horizonItems.length || !viewer?.scene?.preRender) {
      layerState._preRenderRemover?.();
      layerState._preRenderRemover = null;
      return;
    }
    if (!layerState._preRenderRemover) {
      layerState._preRenderRemover =
        viewer.scene.preRender.addEventListener(cullHorizon);
    }
    cullHorizon();
  }

  function publishOverlayCards() {
    if (!overlayHost) return;
    if (!layerState._enabled || !layerState._renderedItems.length) {
      overlayHost.clearSource?.(METEORS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible?.(METEORS_OVERLAY_SOURCE_ID, false);
      return;
    }
    const entries = buildMeteorOverlayEntries(
      layerState._renderedItems,
      layerState._selectedEventId,
    );
    overlayHost.setVisible?.(METEORS_OVERLAY_SOURCE_ID, true);
    overlayHost.setEntries?.(METEORS_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: METEORS_OVERLAY_COHORT_LIMIT,
      collisionCapacity: METEORS_OVERLAY_COHORT_LIMIT,
      moving: false,
    });
  }

  function clearEntities() {
    layerState._preRenderRemover?.();
    layerState._preRenderRemover = null;
    if (layerState._dataSource) {
      layerState._dataSource.entities.removeAll();
    }
    layerState._entityById.clear();
    layerState._pickEventIdByEntityId.clear();
    layerState._spheresByEventId.clear();
    layerState._horizonItems = [];
    layerState._renderedItems = [];
    overlayHost?.clearSource?.(METEORS_OVERLAY_SOURCE_ID);
  }

  function addEventEntities(event) {
    if (!layerState._dataSource) return;
    const id = event.id;
    if (layerState._entityById.has(id)) return;

    const geom = computeEventGeometry(event, Cesium);
    if (!geom) return;

    const isSelected = id === layerState._selectedEventId;
    const isCorroborated =
      Array.isArray(event.possibleMatches) && event.possibleMatches.length > 0;
    const { colorHex, pixelSize, selectedSize } = severityTier(event);
    const pointColor = Cesium.Color.fromCssColorString(
      isSelected ? SEVERITY_COLORS.selected : colorHex,
    );
    const outlineColor = isSelected
      ? Cesium.Color.BLACK
      : isCorroborated
        ? Cesium.Color.fromCssColorString(SEVERITY_COLORS.corroborated)
        : Cesium.Color.BLACK;
    const size = isSelected ? selectedSize : pixelSize;

    const horizon = { points: [], shapes: [], sphere: null };
    const extent = [geom.burstPosition, geom.groundPosition];

    // 1. Primary airburst/terminus point
    const burstEntity = layerState._dataSource.entities.add({
      id,
      name: `Fireball ${event.eventTime?.slice(0, 10) || id}`,
      position: geom.burstPosition,
      point: {
        pixelSize: size,
        color: pointColor,
        outlineColor,
        outlineWidth: isSelected ? 2.5 : isCorroborated ? 2.5 : 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: {
        eventId: id,
        event,
      },
    });
    burstEntity.gevTrackedId = id;
    burstEntity.gevDisplayPosition = () => geom.burstPosition;
    burstEntity.gevLabelModel = buildMeteorCardModel(event, isSelected);

    horizon.points.push({ entity: burstEntity, position: geom.cullPosition });
    layerState._entityById.set(id, burstEntity);
    layerState._pickEventIdByEntityId.set(id, id);

    // 2. Ground footprint + vertical altitude tether when burst altitude > 0
    if (geom.hasAltitude) {
      const groundId = `${id}:ground`;
      const groundEntity = layerState._dataSource.entities.add({
        id: groundId,
        position: geom.groundPosition,
        point: {
          pixelSize: 4,
          color: pointColor.withAlpha(0.65),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      horizon.points.push({
        entity: groundEntity,
        position: geom.cullPosition,
      });
      layerState._pickEventIdByEntityId.set(groundId, id);

      const tetherId = `${id}:tether`;
      const tetherEntity = layerState._dataSource.entities.add({
        id: tetherId,
        polyline: {
          positions: [geom.groundPosition, geom.burstPosition],
          width: isSelected ? 2 : 1.2,
          material: Cesium.Color.fromCssColorString(
            isSelected ? SEVERITY_COLORS.selected : SEVERITY_COLORS.tether,
          ).withAlpha(isSelected ? 0.85 : 0.45),
          arcType: Cesium.ArcType.NONE,
        },
      });
      horizon.shapes.push(tetherEntity);
      layerState._pickEventIdByEntityId.set(tetherId, id);
    }

    // 3. 3D Atmospheric Entry Trajectory Arrow (CNEOS vector, GMN optical, or ASGARD camera)
    let vectorEntity = null;
    if (geom.entryTrackPositions) {
      extent.push(...geom.entryTrackPositions);
      const vectorId = `${id}:vector`;
      const baseVecHex =
        event.source === 'gmn'
          ? SEVERITY_COLORS.gmn
          : event.source === 'asgard'
            ? SEVERITY_COLORS.asgard
            : SEVERITY_COLORS.vector;
      const vecColor = Cesium.Color.fromCssColorString(
        isSelected ? SEVERITY_COLORS.selected : baseVecHex,
      ).withAlpha(isSelected ? 0.98 : 0.85);
      vectorEntity = layerState._dataSource.entities.add({
        id: vectorId,
        polyline: {
          positions: geom.entryTrackPositions,
          width: isSelected ? 6 : 4,
          material: new Cesium.PolylineArrowMaterialProperty(vecColor),
          arcType: Cesium.ArcType.NONE,
        },
      });
      horizon.shapes.push(vectorEntity);
      layerState._pickEventIdByEntityId.set(vectorId, id);
    }

    const sphere = Cesium.BoundingSphere.fromPoints(extent);
    sphere.radius = Math.max(sphere.radius, 350_000);
    horizon.sphere = sphere;
    layerState._spheresByEventId.set(id, sphere);
    layerState._horizonItems.push(horizon);

    const renderedItem = {
      event,
      burstPosition: geom.burstPosition,
      cullPosition: geom.cullPosition,
      entity: burstEntity,
      vectorEntity,
    };
    layerState._renderedItems.push(renderedItem);

    registerEntityContext(burstEntity, {
      id,
      layerId: config.id || 'meteors',
      layerName: config.name || 'Fireballs',
      source: 'NASA/JPL CNEOS',
      dataSource: layerState._dataSource,
      label: `Fireball · ${formatEnergyKt(event.energy?.impact)} · ${formatLatLon(event.location.lat, event.location.lon)}`,
      latitude: event.location.lat,
      longitude: event.location.lon,
      event,
    });
  }

  function update(events) {
    if (!layerState._dataSource) return;
    clearEntities();
    for (const event of events) {
      addEventEntities(event);
    }
    syncHorizonListener();
    publishOverlayCards();
    requestRender();
  }

  function selectEvent(eventId, { publishContext = true } = {}) {
    layerState._selectedEventId = eventId || null;
    for (const item of layerState._renderedItems) {
      const { event, entity, vectorEntity } = item;
      const isSelected = event.id === layerState._selectedEventId;
      const { colorHex, pixelSize, selectedSize } = severityTier(event);
      entity.point.color = Cesium.Color.fromCssColorString(
        isSelected ? SEVERITY_COLORS.selected : colorHex,
      );
      entity.point.pixelSize = isSelected ? selectedSize : pixelSize;
      entity.point.outlineWidth = isSelected ? 2.5 : 1.5;
      entity.gevLabelModel = buildMeteorCardModel(event, isSelected);
      if (vectorEntity?.polyline) {
        const baseVecHex =
          event.source === 'gmn'
            ? SEVERITY_COLORS.gmn
            : event.source === 'asgard'
              ? SEVERITY_COLORS.asgard
              : SEVERITY_COLORS.vector;
        const vecColor = Cesium.Color.fromCssColorString(
          isSelected ? SEVERITY_COLORS.selected : baseVecHex,
        ).withAlpha(isSelected ? 0.98 : 0.85);
        vectorEntity.polyline.width = isSelected ? 6 : 4;
        vectorEntity.polyline.material =
          new Cesium.PolylineArrowMaterialProperty(vecColor);
      }
    }
    publishOverlayCards();
    if (publishContext) {
      const selectedEntity = layerState._selectedEventId
        ? layerState._entityById.get(layerState._selectedEventId)
        : null;
      if (selectedEntity) {
        selectEntityContext(selectedEntity);
      } else {
        clearSelectedEntityContextForLayer(config.id || 'meteors');
      }
    }
    requestRender();
  }

  function getFocusSphere(eventId) {
    return layerState._spheresByEventId.get(eventId) || null;
  }

  function resolvePickedEventId(picked) {
    if (!picked) return null;
    const rawId =
      services.picking?.resolvePickId?.(picked) ??
      (typeof picked?.id === 'string'
        ? picked.id
        : typeof picked?.id?.id === 'string'
          ? picked.id.id
          : typeof picked?.primitive?.id === 'string'
            ? picked.primitive.id
            : null);
    if (rawId && layerState._pickEventIdByEntityId.has(rawId)) {
      return layerState._pickEventIdByEntityId.get(rawId);
    }
    const propEventId = picked?.id?.properties?.eventId?.getValue?.();
    if (propEventId && layerState._entityById.has(propEventId)) {
      return propEventId;
    }
    return null;
  }

  function installClickHandler() {
    if (!layerState._viewer?.scene?.canvas || layerState._clickHandler) return;
    const handler = new Cesium.ScreenSpaceEventHandler(
      layerState._viewer.scene.canvas,
    );
    handler.setInputAction((click) => {
      if (!layerState._enabled || layerState._destroyed || !isPointerFree())
        return;
      if (!click?.position) return;

      // 1. Check world-overlay card hit first (clicking a fireball card on the globe)
      const cardHit = overlayHost?.hitTest?.(
        click.position.x,
        click.position.y,
        {
          sourceId: METEORS_OVERLAY_SOURCE_ID,
        },
      );
      if (cardHit?.entryId) {
        const hitEventId = meteorIdFromOverlayEntryId(cardHit.entryId);
        if (hitEventId) {
          components.controls.methods.setParams({
            eventId: hitEventId,
            focus: true,
          });
          return;
        }
      }

      // 2. Check 3D scene entity pick (burst point, ground marker, tether, or 3D vector)
      const picked = layerState._viewer.scene.pick(click.position);
      const pickedEventId = resolvePickedEventId(picked);
      if (pickedEventId) {
        components.controls.methods.setParams({ eventId: pickedEventId });
        return;
      }

      // 3. Yield to sibling layers if they own the picked entity
      if (picked) {
        const otherId =
          services.picking?.resolvePickId?.(picked) ??
          picked?.id?.id ??
          picked?.id;
        if (
          otherId &&
          services.picking?.isOwnedByOtherLayer?.(
            config.id || 'meteors',
            otherId,
          )
        ) {
          return;
        }
      }

      // 4. Empty map click clears selection
      if (layerState._selectedEventId) {
        components.controls.methods.setParams({ clear: true });
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
    getFocusSphere,
     publishOverlayCards,
    installClickHandler,
    removeClickHandler,
    clearEntities,
  };
}
