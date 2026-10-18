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
    if (
      layerState._darkFlightActive &&
      layerState._darkFlightResult?.feasible &&
      layerState._darkFlightResult.eventId === layerState._selectedEventId
    ) {
      const df = layerState._darkFlightResult;
      const sweep = df.massSweep || [];
      if (sweep.length > 0 && layerState._darkFlightMode !== 'montecarlo') {
        const heavy = sweep[0];
        const light = sweep[sweep.length - 1];
        entries.push({
          id: `meteor-df:heavy:${df.eventId}`,
          position: Cesium.Cartesian3.fromDegrees(heavy.lon, heavy.lat, 0),
          variant: 'card',
          cardStyle: 'tactical',
          collisionGroup: 'ambient-card',
          title: `⚡ ${heavy.label} (${heavy.flightTimeSec}s fall)`,
          details: [`Impact ${heavy.impactSpeedMs} m/s · MODEL ESTIMATE`],
          accent: heavy.color,
          selected: false,
          protected: true,
          priority: Number.MAX_SAFE_INTEGER - 10,
          gapPx: 14,
          verticalOnly: true,
          horizonCull: true,
          interactive: false,
        });
        if (light && light !== heavy) {
          entries.push({
            id: `meteor-df:light:${df.eventId}`,
            position: Cesium.Cartesian3.fromDegrees(light.lon, light.lat, 0),
            variant: 'card',
            cardStyle: 'tactical',
            collisionGroup: 'ambient-card',
            title: `⚡ ${light.label} (${light.flightTimeSec}s wind drift)`,
            details: [
              df.regime === 'zone-of-possibility'
                ? 'Wind-advected zone · MODEL ESTIMATE'
                : `Along-track sorting ${df.calibration?.alongTrackKm ?? 0} km`,
            ],
            accent: light.color,
            selected: false,
            protected: true,
            priority: Number.MAX_SAFE_INTEGER - 20,
            gapPx: 14,
            verticalOnly: true,
            horizonCull: true,
            interactive: false,
          });
        }
      }
      const stoneComparisons = df.stoneFit?.comparisons || [];
      for (const comp of stoneComparisons.slice(0, 6)) {
        entries.push({
          id: `meteor-df:stone:${comp.stone.id}`,
          position: Cesium.Cartesian3.fromDegrees(
            comp.stone.lon,
            comp.stone.lat,
            0,
          ),
          variant: 'card',
          cardStyle: 'tactical',
          collisionGroup: 'ambient-card',
          title: `◆ ${comp.stone.label} (${comp.stone.massGrams}g)`,
          details: [`Sim vs Found Δ=${comp.errorM}m (${comp.bearingDeg}°)`],
          accent: '#10b981',
          selected: false,
          protected: true,
          priority: Number.MAX_SAFE_INTEGER - 5,
          gapPx: 14,
          verticalOnly: true,
          horizonCull: true,
          interactive: false,
        });
      }
    }
    overlayHost.setVisible?.(METEORS_OVERLAY_SOURCE_ID, true);
    overlayHost.setEntries?.(METEORS_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: METEORS_OVERLAY_COHORT_LIMIT,
      collisionCapacity: METEORS_OVERLAY_COHORT_LIMIT,
      moving: false,
    });
  }

  function clearDarkFlight() {
    if (
      layerState._dataSource &&
      Array.isArray(layerState._darkFlightEntities)
    ) {
      for (const ent of layerState._darkFlightEntities) {
        layerState._dataSource.entities.remove(ent);
      }
    }
    layerState._darkFlightEntities = [];
  }

  function renderDarkFlight() {
    clearDarkFlight();
    if (
      !layerState._dataSource ||
      !layerState._darkFlightActive ||
      !layerState._darkFlightResult?.feasible
    ) {
      publishOverlayCards();
      requestRender();
      return;
    }

    const df = layerState._darkFlightResult;
    const mode = layerState._darkFlightMode || 'all';
    const isZone = df.regime === 'zone-of-possibility';

    // 1. Render 2σ Outer Ellipse and 1σ Inner Core Ellipse (in 'all' or 'montecarlo' modes)
    if (mode === 'all' || mode === 'montecarlo') {
      const el2 = df.ellipse2Sigma;
      if (el2 && el2.semiMajorM >= el2.semiMinorM) {
        const outerColor = Cesium.Color.fromCssColorString(
          isZone ? '#38bdf8' : '#f97316',
        );
        const ent2 = layerState._dataSource.entities.add({
          id: `df:${df.eventId}:ellipse2`,
          position: Cesium.Cartesian3.fromDegrees(
            el2.center.lon,
            el2.center.lat,
            0,
          ),
          ellipse: {
            semiMajorAxis: el2.semiMajorM,
            semiMinorAxis: el2.semiMinorM,
            rotation: Cesium.Math.toRadians(90 - el2.orientationDeg),
            material: outerColor.withAlpha(isZone ? 0.14 : 0.18),
            outline: true,
            outlineColor: outerColor.withAlpha(0.75),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        });
        layerState._darkFlightEntities.push(ent2);
      }

      const el1 = df.ellipseInnerCore;
      if (el1 && el1.semiMajorM >= el1.semiMinorM) {
        const innerColor = Cesium.Color.fromCssColorString('#ffe19a');
        const ent1 = layerState._dataSource.entities.add({
          id: `df:${df.eventId}:ellipse1`,
          position: Cesium.Cartesian3.fromDegrees(
            el1.center.lon,
            el1.center.lat,
            0,
          ),
          ellipse: {
            semiMajorAxis: el1.semiMajorM,
            semiMinorAxis: el1.semiMinorM,
            rotation: Cesium.Math.toRadians(90 - el1.orientationDeg),
            material: innerColor.withAlpha(0.22),
            outline: true,
            outlineColor: innerColor.withAlpha(0.9),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        });
        layerState._darkFlightEntities.push(ent1);
      }

      // Monte Carlo ensemble impact cloud (capped at 100 points for crisp frame pacing)
      const impacts = (df.monteCarloImpacts || []).slice(0, 100);
      for (let i = 0; i < impacts.length; i++) {
        const imp = impacts[i];
        const ptColor =
          imp.massKg >= 1
            ? '#ef4444'
            : imp.massKg >= 0.1
              ? '#f97316'
              : imp.massKg >= 0.01
                ? '#eab308'
                : '#fef08a';
        const pEnt = layerState._dataSource.entities.add({
          id: `df:${df.eventId}:mc:${i}`,
          position: Cesium.Cartesian3.fromDegrees(imp.lon, imp.lat, 0),
          point: {
            pixelSize: imp.massKg >= 0.5 ? 5 : 3.5,
            color: Cesium.Color.fromCssColorString(ptColor).withAlpha(0.75),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        layerState._darkFlightEntities.push(pEnt);
      }
    }

    // 2. Render Deterministic 5-Mass Spine & 3D Deceleration Curves (in 'all' or 'sweep' modes)
    if (mode === 'all' || mode === 'sweep') {
      for (const band of df.massSweep || []) {
        const bandColor = Cesium.Color.fromCssColorString(band.color);
        if (Array.isArray(band.track) && band.track.length > 1) {
          const positions = band.track.map((pt) =>
            Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.altM),
          );
          const trackEnt = layerState._dataSource.entities.add({
            id: `df:${df.eventId}:track:${band.label}`,
            polyline: {
              positions,
              width: 2.5,
              material: bandColor.withAlpha(0.9),
              arcType: Cesium.ArcType.NONE,
            },
          });
          layerState._darkFlightEntities.push(trackEnt);
        }
        const impactEnt = layerState._dataSource.entities.add({
          id: `df:${df.eventId}:mass:${band.label}`,
          position: Cesium.Cartesian3.fromDegrees(band.lon, band.lat, 0),
          point: {
            pixelSize: 9,
            color: bandColor,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        layerState._darkFlightEntities.push(impactEnt);
      }
    }

    // 3. Render Found Stones & Mass-Matched Residual Error Vectors
    const stoneComparisons = df.stoneFit?.comparisons || [];
    for (const comp of stoneComparisons) {
      const { stone, simulated } = comp;
      const stoneEnt = layerState._dataSource.entities.add({
        id: `df:${df.eventId}:stone:${stone.id}`,
        position: Cesium.Cartesian3.fromDegrees(stone.lon, stone.lat, 0),
        point: {
          pixelSize: 11,
          color: Cesium.Color.fromCssColorString('#10b981'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      layerState._darkFlightEntities.push(stoneEnt);

      if (simulated) {
        const resLine = layerState._dataSource.entities.add({
          id: `df:${df.eventId}:res:${stone.id}`,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([
              simulated.lon,
              simulated.lat,
              stone.lon,
              stone.lat,
            ]),
            width: 2.5,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#f43f5e'),
              dashLength: 12,
            }),
            clampToGround: true,
          },
        });
        layerState._darkFlightEntities.push(resLine);
      }
    }

    publishOverlayCards();
    requestRender();
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

    const focusSphere = Cesium.BoundingSphere.fromPoints(extent);
    focusSphere.radius = Math.max(focusSphere.radius * 1.65, 25_000);
    const horizonSphere = new Cesium.BoundingSphere(
      focusSphere.center,
      Math.max(focusSphere.radius, 350_000),
    );
    horizon.sphere = horizonSphere;
    layerState._spheresByEventId.set(id, focusSphere);
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
    const baseSphere = layerState._spheresByEventId.get(eventId) || null;
    if (
      !baseSphere ||
      !layerState._darkFlightActive ||
      layerState._darkFlightResult?.eventId !== eventId ||
      !layerState._darkFlightResult?.feasible
    ) {
      return baseSphere;
    }
    const df = layerState._darkFlightResult;
    const pts = [];
    for (const band of df.massSweep || []) {
      pts.push(Cesium.Cartesian3.fromDegrees(band.lon, band.lat, 0));
      if (Array.isArray(band.track)) {
        for (const p of band.track) {
          pts.push(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM));
        }
      }
    }
    for (const comp of df.stoneFit?.comparisons || []) {
      pts.push(
        Cesium.Cartesian3.fromDegrees(comp.stone.lon, comp.stone.lat, 0),
      );
    }
    if (!pts.length) return baseSphere;
    const dfSphere = Cesium.BoundingSphere.fromPoints(pts);
    const combined = Cesium.BoundingSphere.union(baseSphere, dfSphere);
    combined.radius = Math.max(combined.radius * 1.45, 18_000);
    return combined;
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
    renderDarkFlight,
    clearDarkFlight,
    installClickHandler,
    removeClickHandler,
    clearEntities,
  };
}
