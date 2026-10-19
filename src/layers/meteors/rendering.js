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
import { computeFlightPathUncertaintyCones } from './validation.js';
import { isPointerFree } from '../../data/inputOwnership.js';

function buildOrthonormalBasis(axis) {
  const up =
    Math.abs(axis.z) < 0.9
      ? new Cesium.Cartesian3(0, 0, 1)
      : new Cesium.Cartesian3(1, 0, 0);
  const u = Cesium.Cartesian3.cross(axis, up, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(u, u);
  const v = Cesium.Cartesian3.cross(axis, u, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(v, v);
  return { u, v };
}

function makeCircleRing3D(center, u, v, radiusM, segments = 16) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cos = Math.cos(theta) * radiusM;
    const sin = Math.sin(theta) * radiusM;
    pts.push(
      new Cesium.Cartesian3(
        center.x + u.x * cos + v.x * sin,
        center.y + u.y * cos + v.y * sin,
        center.z + u.z * cos + v.z * sin,
      ),
    );
  }
  return pts;
}

function makeGroundEllipsePositions(
  centerLat,
  centerLon,
  semiMajorM,
  semiMinorM,
  orientationDeg = 0,
  segments = 36,
) {
  const degToRad = Math.PI / 180;
  const metersPerDegLat = 111320;
  const cosLat = Math.max(0.05, Math.cos(centerLat * degToRad));
  const rotRad = (90 - (Number(orientationDeg) || 0)) * degToRad;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const positions = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const xLocal = semiMajorM * Math.cos(theta);
    const yLocal = semiMinorM * Math.sin(theta);
    const eastM = xLocal * cosR - yLocal * sinR;
    const northM = xLocal * sinR + yLocal * cosR;
    const lat = centerLat + northM / metersPerDegLat;
    const lon = centerLon + eastM / (metersPerDegLat * cosLat);
    positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
  }
  return positions;
}

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
    const dfActiveForSelected =
      layerState._darkFlightActive &&
      layerState._darkFlightResult?.feasible &&
      layerState._darkFlightResult.eventId === layerState._selectedEventId;
    const labelsMode = layerState._groundLabelsMode || 'compact';

    // When Dark Flight is active in 'compact' or 'off' label mode, hide the giant
    // multi-line floating HTML cards near the selected strewn field so they never
    // obstruct the ground fall map, mass pins, NEXRAD gate, or found stones.
    const baseItems =
      dfActiveForSelected && labelsMode !== 'cards'
        ? layerState._renderedItems.filter((item) => {
            if (item.event.id === layerState._selectedEventId) return false;
            const selEv = layerState._events.find(
              (e) => e.id === layerState._selectedEventId,
            );
            if (
              selEv?.possibleMatches?.some((m) => m.id === item.event.id)
            ) {
              return false;
            }
            return true;
          })
        : layerState._renderedItems;

    const entries = buildMeteorOverlayEntries(
      baseItems,
      layerState._selectedEventId,
    );
    if (dfActiveForSelected && labelsMode === 'cards') {
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
          title: `◆ ${comp.stone.label} (${comp.stone.massGrams}g${comp.stone.estDiameterCm ? ` · ~${comp.stone.estDiameterCm}cm` : ''})`,
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
      const nexrad = df.validation?.nexrad;
      if (nexrad && Array.isArray(nexrad.polygon) && nexrad.polygon.length > 0) {
        const cLat =
          nexrad.polygon.reduce((s, p) => s + p.lat, 0) / nexrad.polygon.length;
        const cLon =
          nexrad.polygon.reduce((s, p) => s + p.lon, 0) / nexrad.polygon.length;
        entries.push({
          id: `meteor-df:nexrad:${df.eventId}`,
          position: Cesium.Cartesian3.fromDegrees(
            cLon,
            cLat,
            nexrad.gateAltitudeKm * 1000,
          ),
          variant: 'card',
          cardStyle: 'tactical',
          collisionGroup: 'ambient-card',
          title: `📡 NEXRAD GATE ${nexrad.gateTimeUtc.slice(11, 19)} (${nexrad.gateAltitudeKm} km)`,
          details: [
            `Δt +${nexrad.elapsedSec}s post-bolide · ${nexrad.reflectivityDbz} dBZ · 10g–100g swarm`,
          ],
          accent: '#38bdf8',
          selected: false,
          protected: true,
          priority: Number.MAX_SAFE_INTEGER - 8,
          gapPx: 12,
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

    // 1. Render 2σ Outer Ellipse and 1σ Inner Core Ellipse (draped onto 3D Tiles & terrain)
    if (mode === 'all' || mode === 'montecarlo') {
      const el2 = df.ellipse2Sigma;
      if (el2 && el2.semiMajorM >= el2.semiMinorM) {
        const outerColor = Cesium.Color.fromCssColorString(
          isZone ? '#38bdf8' : '#f97316',
        );
        const ring2 = makeGroundEllipsePositions(
          el2.center.lat,
          el2.center.lon,
          el2.semiMajorM,
          el2.semiMinorM,
          el2.orientationDeg,
          40,
        );
        layerState._darkFlightEntities.push(
          layerState._dataSource.entities.add({
            id: `df:${df.eventId}:ellipse2`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(ring2.slice(0, -1)),
              classificationType: Cesium.ClassificationType.BOTH,
              material: outerColor.withAlpha(isZone ? 0.14 : 0.16),
              arcType: Cesium.ArcType.GEODESIC,
            },
          }),
          layerState._dataSource.entities.add({
            id: `df:${df.eventId}:ellipse2:outline`,
            polyline: {
              positions: ring2,
              width: 2.2,
              material: outerColor.withAlpha(0.85),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
          }),
        );
      }

      const el1 = df.ellipseInnerCore;
      if (el1 && el1.semiMajorM >= el1.semiMinorM) {
        const innerColor = Cesium.Color.fromCssColorString('#ffe19a');
        const ring1 = makeGroundEllipsePositions(
          el1.center.lat,
          el1.center.lon,
          el1.semiMajorM,
          el1.semiMinorM,
          el1.orientationDeg,
          36,
        );
        layerState._darkFlightEntities.push(
          layerState._dataSource.entities.add({
            id: `df:${df.eventId}:ellipse1`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(ring1.slice(0, -1)),
              classificationType: Cesium.ClassificationType.BOTH,
              material: innerColor.withAlpha(0.18),
              arcType: Cesium.ArcType.GEODESIC,
            },
          }),
          layerState._dataSource.entities.add({
            id: `df:${df.eventId}:ellipse1:outline`,
            polyline: {
              positions: ring1,
              width: 2.0,
              material: innerColor.withAlpha(0.9),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
          }),
        );
      }

      // Render per-Sub-Bolide 2σ Lobe Ellipses + 3D Sub-Bolide Breakup Origins when multiple fragmentations exist
      if (Array.isArray(df.subBolides) && df.subBolides.length > 0) {
        const showCompact =
          (layerState._groundLabelsMode || 'compact') === 'compact';
        for (const sb of df.subBolides) {
          const sbColor = Cesium.Color.fromCssColorString(
            sb.id === 'F1' ? '#34d399' : '#f59e0b',
          );
          // 3D Sub-Bolide breakup origin marker along the atmospheric trajectory
          const sbOriginEnt = layerState._dataSource.entities.add({
            id: `df:${df.eventId}:subbolide:origin:${sb.id}`,
            position: Cesium.Cartesian3.fromDegrees(
              sb.lon,
              sb.lat,
              sb.altKm * 1000,
            ),
            point: {
              pixelSize: 9,
              color: sbColor,
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: showCompact
              ? {
                  text: `✦ ${sb.label}`,
                  font: '600 10px ui-monospace, SFMono-Regular, Menlo, monospace',
                  fillColor: sbColor,
                  outlineColor: Cesium.Color.BLACK,
                  outlineWidth: 2,
                  style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                  showBackground: true,
                  backgroundColor: new Cesium.Color(0.03, 0.05, 0.09, 0.72),
                  backgroundPadding: new Cesium.Cartesian2(5, 2),
                  horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                  verticalOrigin: Cesium.VerticalOrigin.CENTER,
                  pixelOffset: new Cesium.Cartesian2(10, 0),
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  scaleByDistance: new Cesium.NearFarScalar(5000, 1.0, 140000, 0.5),
                }
              : undefined,
          });
          layerState._darkFlightEntities.push(sbOriginEnt);

          const sbEl = sb.ellipse2Sigma;
          if (sbEl && sbEl.semiMajorM >= sbEl.semiMinorM) {
            const sbRing = makeGroundEllipsePositions(
              sbEl.center.lat,
              sbEl.center.lon,
              sbEl.semiMajorM,
              sbEl.semiMinorM,
              sbEl.orientationDeg,
              32,
            );
            layerState._darkFlightEntities.push(
              layerState._dataSource.entities.add({
                id: `df:${df.eventId}:subbolide:fill:${sb.id}`,
                polygon: {
                  hierarchy: new Cesium.PolygonHierarchy(sbRing.slice(0, -1)),
                  classificationType: Cesium.ClassificationType.BOTH,
                  material: sbColor.withAlpha(0.11),
                  arcType: Cesium.ArcType.GEODESIC,
                },
              }),
              layerState._dataSource.entities.add({
                id: `df:${df.eventId}:subbolide:ring:${sb.id}`,
                polyline: {
                  positions: sbRing,
                  width: 1.8,
                  material: new Cesium.PolylineDashMaterialProperty({
                    color: sbColor.withAlpha(0.85),
                    dashLength: 10,
                  }),
                  clampToGround: true,
                  classificationType: Cesium.ClassificationType.BOTH,
                },
              }),
            );
          }

          // Also render secondary mass-sweep pins & 3D tracks for each Sub-Bolide's
          // complementary masses (e.g. F1's larger 300g/100g/50g pieces and F2's smaller 30g/10g/3g pieces)
          if (
            (mode === 'all' || mode === 'sweep') &&
            Array.isArray(sb.massSweep)
          ) {
            for (const sbBand of sb.massSweep) {
              const isPrimaryBand = (df.massSweep || []).some(
                (m) =>
                  m.label === sbBand.label && m.subBolideId === sbBand.subBolideId,
              );
              if (isPrimaryBand) continue;
              const bColor = Cesium.Color.fromCssColorString(sbBand.color);
              if (Array.isArray(sbBand.track) && sbBand.track.length > 1) {
                layerState._darkFlightEntities.push(
                  layerState._dataSource.entities.add({
                    id: `df:${df.eventId}:subtrack:${sb.id}:${sbBand.label}`,
                    polyline: {
                      positions: sbBand.track.map((pt) =>
                        Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.altM),
                      ),
                      width: 1.5,
                      material: new Cesium.PolylineDashMaterialProperty({
                        color: bColor.withAlpha(0.65),
                        dashLength: 10,
                      }),
                      arcType: Cesium.ArcType.NONE,
                    },
                  }),
                );
              }
              layerState._darkFlightEntities.push(
                layerState._dataSource.entities.add({
                  id: `df:${df.eventId}:submass:${sb.id}:${sbBand.label}`,
                  position: Cesium.Cartesian3.fromDegrees(
                    sbBand.lon,
                    sbBand.lat,
                    0,
                  ),
                  point: {
                    pixelSize: 6.5,
                    color: bColor.withAlpha(0.85),
                    outlineColor: sbColor,
                    outlineWidth: 1.5,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  },
                  label: showCompact
                    ? {
                        text: `${sbBand.label}·${sb.id}`,
                        font: '600 9px ui-monospace, SFMono-Regular, Menlo, monospace',
                        fillColor: bColor.withAlpha(0.9),
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        showBackground: true,
                        backgroundColor: new Cesium.Color(0.03, 0.05, 0.09, 0.6),
                        backgroundPadding: new Cesium.Cartesian2(3, 1.5),
                        horizontalOrigin: Cesium.HorizontalOrigin.RIGHT,
                        verticalOrigin: Cesium.VerticalOrigin.CENTER,
                        pixelOffset: new Cesium.Cartesian2(-8, 0),
                        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        scaleByDistance: new Cesium.NearFarScalar(
                          2500,
                          1.0,
                          70000,
                          0.45,
                        ),
                      }
                    : undefined,
                }),
              );
            }
          }
        }
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

    // 2. Render Deterministic 7-Mass Spine, 3D Deceleration Curves & Ground Over/Under Corridor
    if (mode === 'all' || mode === 'sweep') {
      const spinePositions = [];
      const underRailPositions = [];
      const overRailPositions = [];

      for (const band of df.massSweep || []) {
        const bandColor = Cesium.Color.fromCssColorString(band.color);
        spinePositions.push(Cesium.Cartesian3.fromDegrees(band.lon, band.lat, 0));
        if (band.underPoint) {
          underRailPositions.push(
            Cesium.Cartesian3.fromDegrees(
              band.underPoint.lon,
              band.underPoint.lat,
              0,
            ),
          );
        }
        if (band.overPoint) {
          overRailPositions.push(
            Cesium.Cartesian3.fromDegrees(
              band.overPoint.lon,
              band.overPoint.lat,
              0,
            ),
          );
        }

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

        // Per-mass ground 1σ margin-of-error ring + cross-track error bar
        if (band.marginRadiusM && band.underPoint && band.overPoint) {
          const errBarEnt = layerState._dataSource.entities.add({
            id: `df:${df.eventId}:errbar:${band.label}`,
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray([
                band.underPoint.lon,
                band.underPoint.lat,
                band.lon,
                band.lat,
                band.overPoint.lon,
                band.overPoint.lat,
              ]),
              width: 1.8,
              material: new Cesium.PolylineDashMaterialProperty({
                color: bandColor.withAlpha(0.8),
                dashLength: 8,
              }),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
          });
          layerState._darkFlightEntities.push(errBarEnt);

          const marginRing = makeGroundEllipsePositions(
            band.lat,
            band.lon,
            band.marginRadiusM,
            Math.max(150, Math.round(band.marginRadiusM * 0.65)),
            0,
            24,
          );
          const marginEnt = layerState._dataSource.entities.add({
            id: `df:${df.eventId}:margin:${band.label}`,
            polyline: {
              positions: marginRing,
              width: 1.2,
              material: bandColor.withAlpha(0.55),
              clampToGround: true,
              classificationType: Cesium.ClassificationType.BOTH,
            },
          });
          layerState._darkFlightEntities.push(marginEnt);
        }

        const showCompactLabel =
          (layerState._groundLabelsMode || 'compact') === 'compact';
        const impactEnt = layerState._dataSource.entities.add({
          id: `df:${df.eventId}:mass:${band.label}`,
          position: Cesium.Cartesian3.fromDegrees(band.lon, band.lat, 0),
          point: {
            pixelSize: 8.5,
            color: bandColor,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: showCompactLabel
            ? {
                text: band.label,
                font: '600 10px ui-monospace, SFMono-Regular, Menlo, monospace',
                fillColor: bandColor,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                showBackground: true,
                backgroundColor: new Cesium.Color(0.03, 0.05, 0.09, 0.68),
                backgroundPadding: new Cesium.Cartesian2(4, 2),
                horizontalOrigin: Cesium.HorizontalOrigin.RIGHT,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                pixelOffset: new Cesium.Cartesian2(-10, 0),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scaleByDistance: new Cesium.NearFarScalar(2500, 1.0, 90000, 0.5),
              }
            : undefined,
        });
        layerState._darkFlightEntities.push(impactEnt);
      }

      // Central Mass-Sorting Spine + Under (-1σ) / Over (+1σ) Margin Rails on the ground
      if (spinePositions.length >= 2) {
        const spineLine = layerState._dataSource.entities.add({
          id: `df:${df.eventId}:spine-center`,
          polyline: {
            positions: spinePositions,
            width: 2.5,
            material: Cesium.Color.fromCssColorString('#fde047').withAlpha(0.85),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
        layerState._darkFlightEntities.push(spineLine);
      }
      if (underRailPositions.length >= 2) {
        const underRail = layerState._dataSource.entities.add({
          id: `df:${df.eventId}:spine-under`,
          polyline: {
            positions: underRailPositions,
            width: 1.8,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.8),
              dashLength: 10,
            }),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
        layerState._darkFlightEntities.push(underRail);
      }
      if (overRailPositions.length >= 2) {
        const overRail = layerState._dataSource.entities.add({
          id: `df:${df.eventId}:spine-over`,
          polyline: {
            positions: overRailPositions,
            width: 1.8,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#fb7185').withAlpha(0.8),
              dashLength: 10,
            }),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
        layerState._darkFlightEntities.push(overRail);
      }
    }

    // 2b. Render 3D Double-Ended Cones of Uncertainty (Biconical / Hourglass 3D Error Volume)
    // around the atmospheric entry trajectory + NEXRAD Doppler Radar Gate polygon
    const selEvent = layerState._events.find((e) => e.id === df.eventId);
    const conesSpec =
      df.validation?.pathCones ||
      (selEvent
        ? computeFlightPathUncertaintyCones(selEvent, layerState._events)
        : null);
    if (conesSpec) {
      const trajEvent =
        layerState._events.find((e) => e.id === conesSpec.sourceId) || selEvent;
      const trajGeom = trajEvent ? computeEventGeometry(trajEvent, Cesium) : null;
      if (
        trajGeom?.entryTrackPositions &&
        trajGeom.entryTrackPositions.length >= 2
      ) {
        const startPos = trajGeom.entryTrackPositions[0];
        const endPos = trajGeom.entryTrackPositions[1];
        const axis = Cesium.Cartesian3.subtract(
          endPos,
          startPos,
          new Cesium.Cartesian3(),
        );
        const len = Cesium.Cartesian3.magnitude(axis);
        if (len > 500) {
          Cesium.Cartesian3.normalize(axis, axis);
          const { u, v } = buildOrthonormalBasis(axis);
          const waistPos = new Cesium.Cartesian3(
            startPos.x * 0.52 + endPos.x * 0.48,
            startPos.y * 0.52 + endPos.y * 0.48,
            startPos.z * 0.52 + endPos.z * 0.48,
          );

          // 1σ Inner Double-Ended Cone (solid cyan-amber rings + 8 biconical ribs)
          const ringStart1 = makeCircleRing3D(
            startPos,
            u,
            v,
            conesSpec.entryRadius1SigmaM,
            16,
          );
          const ringWaist1 = makeCircleRing3D(
            waistPos,
            u,
            v,
            conesSpec.waistRadius1SigmaM,
            16,
          );
          const ringEnd1 = makeCircleRing3D(
            endPos,
            u,
            v,
            conesSpec.terminusRadius1SigmaM,
            16,
          );
          const cone1Color =
            Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.75);

          for (const [tag, ringPts] of [
            ['start1', ringStart1],
            ['waist1', ringWaist1],
            ['end1', ringEnd1],
          ]) {
            layerState._darkFlightEntities.push(
              layerState._dataSource.entities.add({
                id: `df:${df.eventId}:cone:${tag}`,
                polyline: {
                  positions: ringPts,
                  width: 2.0,
                  material: cone1Color,
                  arcType: Cesium.ArcType.NONE,
                },
              }),
            );
          }

          // 2σ Outer Double-Ended Cone (dashed outer margin-of-error envelope)
          const ringStart2 = makeCircleRing3D(
            startPos,
            u,
            v,
            conesSpec.entryRadius2SigmaM,
            16,
          );
          const ringWaist2 = makeCircleRing3D(
            waistPos,
            u,
            v,
            conesSpec.waistRadius2SigmaM,
            16,
          );
          const ringEnd2 = makeCircleRing3D(
            endPos,
            u,
            v,
            conesSpec.terminusRadius2SigmaM,
            16,
          );
          const cone2Color =
            Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.55);

          for (const [tag, ringPts] of [
            ['start2', ringStart2],
            ['waist2', ringWaist2],
            ['end2', ringEnd2],
          ]) {
            layerState._darkFlightEntities.push(
              layerState._dataSource.entities.add({
                id: `df:${df.eventId}:cone:${tag}`,
                polyline: {
                  positions: ringPts,
                  width: 1.5,
                  material: new Cesium.PolylineDashMaterialProperty({
                    color: cone2Color,
                    dashLength: 10,
                  }),
                  arcType: Cesium.ArcType.NONE,
                },
              }),
            );
          }

          // 8 longitudinal biconical ribs connecting Entry -> Waist -> Terminus
          for (let k = 0; k < 16; k += 2) {
            layerState._darkFlightEntities.push(
              layerState._dataSource.entities.add({
                id: `df:${df.eventId}:cone:rib1:${k}`,
                polyline: {
                  positions: [ringStart1[k], ringWaist1[k], ringEnd1[k]],
                  width: 1.5,
                  material: cone1Color,
                  arcType: Cesium.ArcType.NONE,
                },
              }),
            );
            layerState._darkFlightEntities.push(
              layerState._dataSource.entities.add({
                id: `df:${df.eventId}:cone:rib2:${k}`,
                polyline: {
                  positions: [ringStart2[k], ringWaist2[k], ringEnd2[k]],
                  width: 1.2,
                  material: new Cesium.PolylineDashMaterialProperty({
                    color: cone2Color,
                    dashLength: 12,
                  }),
                  arcType: Cesium.ArcType.NONE,
                },
              }),
            );
          }
        }
      }
    }

    // 2c. Render NOAA NEXRAD Doppler Weather Radar Gate (3D 10.29km slice + Ground Polygon)
    const nexrad = df.validation?.nexrad;
    if (nexrad && Array.isArray(nexrad.polygon) && nexrad.polygon.length >= 3) {
      const radarColor = Cesium.Color.fromCssColorString('#38bdf8');
      const gateAltM = nexrad.gateAltitudeKm * 1000;
      const groundLoop = [...nexrad.polygon, nexrad.polygon[0]].map((p) =>
        Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
      );
      const airLoop = [...nexrad.polygon, nexrad.polygon[0]].map((p) =>
        Cesium.Cartesian3.fromDegrees(p.lon, p.lat, gateAltM),
      );

      // Ground projection of NEXRAD radar gate
      layerState._darkFlightEntities.push(
        layerState._dataSource.entities.add({
          id: `df:${df.eventId}:nexrad:ground-outline`,
          polyline: {
            positions: groundLoop,
            width: 2.5,
            material: radarColor.withAlpha(0.9),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        }),
      );
      // 3D radar beam slice at gateAltitudeKm (e.g. 10.29 km)
      layerState._darkFlightEntities.push(
        layerState._dataSource.entities.add({
          id: `df:${df.eventId}:nexrad:air-slice`,
          polyline: {
            positions: airLoop,
            width: 2.5,
            material: radarColor.withAlpha(0.95),
            arcType: Cesium.ArcType.NONE,
          },
        }),
      );
      // Vertical corner tethers from 10.29 km radar slice to ground
      for (let idx = 0; idx < nexrad.polygon.length; idx++) {
        const p = nexrad.polygon[idx];
        layerState._darkFlightEntities.push(
          layerState._dataSource.entities.add({
            id: `df:${df.eventId}:nexrad:pillar:${idx}`,
            polyline: {
              positions: [
                Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
                Cesium.Cartesian3.fromDegrees(p.lon, p.lat, gateAltM),
              ],
              width: 1.2,
              material: new Cesium.PolylineDashMaterialProperty({
                color: radarColor.withAlpha(0.55),
                dashLength: 10,
              }),
              arcType: Cesium.ArcType.NONE,
            },
          }),
        );
      }
    }

    // 2d. Render GOES GLM 14km-Ellipsoid Parallax Ghost & Correction Vector (when significant)
    const goesDiag = df.validation?.goesDiag;
    if (
      goesDiag &&
      goesDiag.parallaxShiftKm >= 5 &&
      Number.isFinite(goesDiag.glmGhostLat) &&
      Number.isFinite(goesDiag.glmGhostLon) &&
      df.effectiveTerminus
    ) {
      const glmColor = Cesium.Color.fromCssColorString('#a855f7');
      const ghostPos = Cesium.Cartesian3.fromDegrees(
        goesDiag.glmGhostLon,
        goesDiag.glmGhostLat,
        goesDiag.glmEllipsoidKm * 1000,
      );
      const termPos = Cesium.Cartesian3.fromDegrees(
        df.effectiveTerminus.lon,
        df.effectiveTerminus.lat,
        df.effectiveTerminus.altKm * 1000,
      );
      layerState._darkFlightEntities.push(
        layerState._dataSource.entities.add({
          id: `df:${df.eventId}:goes-glm-ghost`,
          position: ghostPos,
          point: {
            pixelSize: 7,
            color: glmColor.withAlpha(0.85),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
      layerState._darkFlightEntities.push(
        layerState._dataSource.entities.add({
          id: `df:${df.eventId}:goes-glm-parallax`,
          polyline: {
            positions: [ghostPos, termPos],
            width: 1.8,
            material: new Cesium.PolylineDashMaterialProperty({
              color: glmColor.withAlpha(0.7),
              dashLength: 12,
            }),
            arcType: Cesium.ArcType.NONE,
          },
        }),
      );
    }

    // 3. Render Found Stones & Mass-Matched Residual Error Vectors (with compact non-obtrusive pill labels)
    const stoneComparisons = df.stoneFit?.comparisons || [];
    const showCompactStoneLabels =
      (layerState._groundLabelsMode || 'compact') === 'compact';
    const stoneOffsets = [
      new Cesium.Cartesian2(10, -8),
      new Cesium.Cartesian2(10, 8),
      new Cesium.Cartesian2(-10, -8),
      new Cesium.Cartesian2(10, 12),
      new Cesium.Cartesian2(-10, 0),
      new Cesium.Cartesian2(10, -10),
    ];

    for (let sIdx = 0; sIdx < stoneComparisons.length; sIdx++) {
      const comp = stoneComparisons[sIdx];
      const { stone, simulated, fragmentationEpisode } = comp;
      const isF1 =
        typeof fragmentationEpisode === 'string' &&
        fragmentationEpisode.startsWith('F1');
      const epBadge = isF1 ? '·F1' : '·F2';
      const shortName = String(stone.label || '').replace(/\s*-\s*/, ' ');
      const offset = stoneOffsets[sIdx % stoneOffsets.length];
      const alignLeft = offset.x > 0;

      const stoneEnt = layerState._dataSource.entities.add({
        id: `df:${df.eventId}:stone:${stone.id}`,
        position: Cesium.Cartesian3.fromDegrees(stone.lon, stone.lat, 0),
        point: {
          pixelSize: 10,
          color: Cesium.Color.fromCssColorString(isF1 ? '#34d399' : '#10b981'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: showCompactStoneLabels
          ? {
              text: `◆ ${shortName}${epBadge} (Δ${comp.errorM}m)`,
              font: '600 10px ui-monospace, SFMono-Regular, Menlo, monospace',
              fillColor: Cesium.Color.fromCssColorString('#6ee7b7'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              showBackground: true,
              backgroundColor: new Cesium.Color(0.02, 0.08, 0.06, 0.72),
              backgroundPadding: new Cesium.Cartesian2(5, 2),
              horizontalOrigin: alignLeft
                ? Cesium.HorizontalOrigin.LEFT
                : Cesium.HorizontalOrigin.RIGHT,
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              pixelOffset: offset,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              scaleByDistance: new Cesium.NearFarScalar(2500, 1.0, 90000, 0.5),
            }
          : undefined,
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
            width: 2.0,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString(
                isF1 ? '#38bdf8' : '#f43f5e',
              ).withAlpha(0.85),
              dashLength: 10,
            }),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
        layerState._darkFlightEntities.push(resLine);

        // If this stone detached from Episode F1 (Upper Flare), also render its
        // 3D upper-flare dark-flight trajectory curve in dashed cyan-green
        if (
          isF1 &&
          (mode === 'all' || mode === 'sweep') &&
          Array.isArray(simulated.track) &&
          simulated.track.length > 1
        ) {
          const f1TrackEnt = layerState._dataSource.entities.add({
            id: `df:${df.eventId}:f1track:${stone.id}`,
            polyline: {
              positions: simulated.track.map((pt) =>
                Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.altM),
              ),
              width: 1.8,
              material: new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.fromCssColorString('#34d399').withAlpha(0.7),
                dashLength: 12,
              }),
              arcType: Cesium.ArcType.NONE,
            },
          });
          layerState._darkFlightEntities.push(f1TrackEnt);
        }
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

    // 2b. For CNEOS events: render a 3D Airburst / Sensor Quantization Sphere (±5.5 km)
    // plus a ground quantization footprint circle so CNEOS visually represents a
    // satellite airburst fix with uncertainty rather than a camera line track.
    let sphereEntity = null;
    if (geom.cneosSphereRadiusM) {
      const r = geom.cneosSphereRadiusM;
      const sphereId = `${id}:cneos-sphere`;
      sphereEntity = layerState._dataSource.entities.add({
        id: sphereId,
        position: geom.burstPosition,
        ellipsoid: {
          radii: new Cesium.Cartesian3(r, r, r),
          material: pointColor.withAlpha(isSelected ? 0.18 : 0.1),
          outline: true,
          outlineColor: pointColor.withAlpha(isSelected ? 0.8 : 0.45),
          outlineWidth: 1.5,
          stackPartitions: 8,
          slicePartitions: 12,
        },
      });
      horizon.shapes.push(sphereEntity);
      layerState._pickEventIdByEntityId.set(sphereId, id);

      const groundRingId = `${id}:cneos-ground-ring`;
      const cneosRingPts = makeGroundEllipsePositions(
        event.location.lat,
        event.location.lon,
        5500,
        5500,
        0,
        28,
      );
      const groundRingEnt = layerState._dataSource.entities.add({
        id: groundRingId,
        polyline: {
          positions: cneosRingPts,
          width: isSelected ? 2 : 1.2,
          material: pointColor.withAlpha(isSelected ? 0.65 : 0.35),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
      horizon.shapes.push(groundRingEnt);
      layerState._pickEventIdByEntityId.set(groundRingId, id);
    }

    // 3. 3D Atmospheric Entry Trajectory Arrow (precision track for GMN/ASGARD;
    // short rough-directionality cone/stub on the sphere for CNEOS)
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
          width: geom.isRoughDirectionStub
            ? isSelected
              ? 4.5
              : 3
            : isSelected
              ? 6
              : 4,
          material: new Cesium.PolylineArrowMaterialProperty(vecColor),
          arcType: Cesium.ArcType.NONE,
        },
      });
      horizon.shapes.push(vectorEntity);
      layerState._pickEventIdByEntityId.set(vectorId, id);

      // Add a ±18° rough-directionality cone ring + 4 cone ribs on CNEOS spheres
      if (geom.isRoughDirectionStub && geom.entryTrackPositions.length >= 2) {
        const stubStart = geom.entryTrackPositions[0];
        const stubEnd = geom.entryTrackPositions[1];
        const dirAxis = Cesium.Cartesian3.subtract(
          stubEnd,
          stubStart,
          new Cesium.Cartesian3(),
        );
        const dirLen = Cesium.Cartesian3.magnitude(dirAxis);
        if (dirLen > 100) {
          Cesium.Cartesian3.normalize(dirAxis, dirAxis);
          const { u, v } = buildOrthonormalBasis(dirAxis);
          // Cone mouth at stubStart (incoming ±18° uncertainty fan)
          const coneRadiusM = 5200;
          const coneRing = makeCircleRing3D(stubStart, u, v, coneRadiusM, 12);
          const coneMat = new Cesium.PolylineDashMaterialProperty({
            color: vecColor.withAlpha(0.65),
            dashLength: 8,
          });
          const ringEnt = layerState._dataSource.entities.add({
            id: `${id}:cneos-dir-ring`,
            polyline: {
              positions: coneRing,
              width: 1.4,
              material: coneMat,
              arcType: Cesium.ArcType.NONE,
            },
          });
          horizon.shapes.push(ringEnt);
          for (let k = 0; k < 12; k += 3) {
            const ribEnt = layerState._dataSource.entities.add({
              id: `${id}:cneos-dir-rib:${k}`,
              polyline: {
                positions: [coneRing[k], geom.burstPosition],
                width: 1.2,
                material: coneMat,
                arcType: Cesium.ArcType.NONE,
              },
            });
            horizon.shapes.push(ribEnt);
          }
        }
      }
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
    if (
      layerState._darkFlightActive &&
      layerState._darkFlightResult?.feasible
    ) {
      renderDarkFlight();
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
      if (band.underPoint) {
        pts.push(
          Cesium.Cartesian3.fromDegrees(
            band.underPoint.lon,
            band.underPoint.lat,
            0,
          ),
        );
      }
      if (band.overPoint) {
        pts.push(
          Cesium.Cartesian3.fromDegrees(
            band.overPoint.lon,
            band.overPoint.lat,
            0,
          ),
        );
      }
      if (Array.isArray(band.track)) {
        for (const p of band.track) {
          if (p.altM <= 16000) {
            pts.push(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM));
          }
        }
      }
    }
    for (const comp of df.stoneFit?.comparisons || []) {
      pts.push(
        Cesium.Cartesian3.fromDegrees(comp.stone.lon, comp.stone.lat, 0),
      );
      if (comp.simulated) {
        pts.push(
          Cesium.Cartesian3.fromDegrees(
            comp.simulated.lon,
            comp.simulated.lat,
            0,
          ),
        );
      }
    }
    if (!pts.length) return baseSphere;
    const dfSphere = Cesium.BoundingSphere.fromPoints(pts);
    dfSphere.radius = Math.max(dfSphere.radius * 1.45, 8_500);
    return dfSphere;
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
