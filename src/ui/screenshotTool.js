/**
 * Viewport & Ground-Rectangle Screenshot Tool (`src/ui/screenshotTool.js`).
 *
 * Provides two capture modes:
 *  1. `captureViewport()` — captures a full-resolution composite PNG of the
 *     current 3D Cesium canvas (`viewer.scene.canvas`) + 2D tactical overlay
 *     canvas (`#world-overlay-canvas`).
 *  2. `startBoxCapture()` — claims the pointer (`claimPointer`), lets the user
 *     click and drag a geographic rectangle on the ground (rendering both a
 *     3D terrain-draped `ClassificationType.BOTH` polygon/outline and a live
 *     dimension HUD), then generates a cropped image of that ground box with
 *     an option to re-capture from a true nadir (top-down orthographic) camera
 *     framing of the dragged rectangle.
 */
import * as Cesium from 'cesium';
import { pickWorldFromScreen } from '../annotations/annotationResolver.js';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
} from '../data/inputOwnership.js';

export const SCREENSHOT_BOX_POINTER_OWNER = 'screenshot-ground-box';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const METERS_PER_DEG_LAT = 111320;

function formatTimestampSlug(date = new Date()) {
  return date
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
}

function computeBoxDimensionsKm(box) {
  if (!box) return { widthKm: 0, heightKm: 0, areaKm2: 0 };
  const midLatRad = ((box.south + box.north) * 0.5) * DEG_TO_RAD;
  const heightM = Math.abs(box.north - box.south) * METERS_PER_DEG_LAT;
  const widthM =
    Math.abs(box.east - box.west) *
    METERS_PER_DEG_LAT *
    Math.max(0.05, Math.cos(midLatRad));
  const widthKm = widthM / 1000;
  const heightKm = heightM / 1000;
  return {
    widthKm: Number(widthKm.toFixed(2)),
    heightKm: Number(heightKm.toFixed(2)),
    areaKm2: Number((widthKm * heightKm).toFixed(2)),
  };
}

async function waitFreshFrame(viewer, timeoutMs = 450) {
  const scene = viewer?.scene;
  if (!scene) return false;
  return new Promise((resolve) => {
    let settled = false;
    const remove = scene.postRender.addEventListener(() => {
      if (settled) return;
      settled = true;
      remove();
      resolve(true);
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      remove();
      resolve(false);
    }, timeoutMs);
    scene.requestRender?.();
  });
}

function readCameraSummary(viewer, cesium = Cesium) {
  try {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lat: Number((carto.latitude * RAD_TO_DEG).toFixed(5)),
      lon: Number((carto.longitude * RAD_TO_DEG).toFixed(5)),
      altM: Math.round(carto.height || 0),
      headingDeg: Math.round((viewer.camera.heading || 0) * RAD_TO_DEG),
      pitchDeg: Math.round((viewer.camera.pitch || 0) * RAD_TO_DEG),
    };
  } catch {
    return null;
  }
}

export function initScreenshotTool({
  viewer,
  cesium = Cesium,
  pickWorld = pickWorldFromScreen,
  documentRef = globalThis.document,
} = {}) {
  if (!viewer?.scene || !documentRef?.createElement) return null;

  let active = false;
  let destroyed = false;
  let anchor = null;
  let corner = null;
  let handler = null;
  let lease = null;
  let savedSingleClick = null;
  let savedDoubleClick = null;
  let savedCameraInputs = null;
  let lastCapture = null;

  const viewportBtn = documentRef.getElementById('screenshot-viewport-btn');
  const boxBtn = documentRef.getElementById('screenshot-box-btn');

  /* ------------------------------------------------------------------ */
  /*  3D ground preview entities (draped on 3D Tiles & terrain)          */
  /* ------------------------------------------------------------------ */
  const dataSource = new cesium.CustomDataSource('gev-screenshot-box-preview');
  let attaching = Promise.resolve(viewer.dataSources.add(dataSource)).catch(
    () => null,
  );
  const stroke = cesium.Color.fromCssColorString('#ff9e3d');

  const currentDragBox = () => {
    if (!anchor || !corner) return null;
    return {
      west: Math.min(anchor.lon, corner.lon),
      south: Math.min(anchor.lat, corner.lat),
      east: Math.max(anchor.lon, corner.lon),
      north: Math.max(anchor.lat, corner.lat),
    };
  };

  const previewHierarchy = () => {
    const box = currentDragBox();
    if (!box) return new cesium.PolygonHierarchy([]);
    return new cesium.PolygonHierarchy(
      cesium.Cartesian3.fromDegreesArray([
        box.west,
        box.south,
        box.east,
        box.south,
        box.east,
        box.north,
        box.west,
        box.north,
      ]),
    );
  };

  const previewOutlinePositions = () => {
    const box = currentDragBox();
    if (!box) return [];
    return cesium.Cartesian3.fromDegreesArray([
      box.west,
      box.south,
      box.east,
      box.south,
      box.east,
      box.north,
      box.west,
      box.north,
      box.west,
      box.south,
    ]);
  };

  const fillEntity = dataSource.entities.add({
    show: false,
    polygon: {
      hierarchy: new cesium.CallbackProperty(previewHierarchy, false),
      material: stroke.withAlpha(0.16),
      classificationType: cesium.ClassificationType.BOTH,
    },
  });

  const outlineEntity = dataSource.entities.add({
    show: false,
    polyline: {
      positions: new cesium.CallbackProperty(previewOutlinePositions, false),
      width: 2.5,
      clampToGround: true,
      classificationType: cesium.ClassificationType.BOTH,
      material: new cesium.PolylineDashMaterialProperty({
        color: stroke.withAlpha(0.96),
        dashLength: 12,
      }),
    },
  });

  /* ------------------------------------------------------------------ */
  /*  Screen-space selection rubberband + status pill + modal           */
  /* ------------------------------------------------------------------ */
  const banner = documentRef.createElement('div');
  banner.id = 'gev-screenshot-banner';
  banner.className = 'gev-screenshot-banner';
  banner.hidden = true;
  documentRef.body.appendChild(banner);

  const rubberband = documentRef.createElement('div');
  rubberband.id = 'gev-screenshot-rubberband';
  rubberband.className = 'gev-screenshot-rubberband';
  rubberband.hidden = true;
  const rubberbandLabel = documentRef.createElement('span');
  rubberbandLabel.className = 'gev-screenshot-rubberband-label';
  rubberband.appendChild(rubberbandLabel);
  documentRef.body.appendChild(rubberband);

  const modal = documentRef.createElement('div');
  modal.id = 'gev-screenshot-modal';
  modal.className = 'gev-screenshot-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="gev-screenshot-dialog" role="dialog" aria-modal="true" aria-label="Screenshot capture preview">
      <div class="gev-screenshot-header">
        <span class="gev-screenshot-title">📷 SCREENSHOT CAPTURE</span>
        <span class="gev-screenshot-meta" id="gev-screenshot-meta"></span>
        <button type="button" class="gev-screenshot-close" data-screenshot-action="close" title="Close preview (Esc)">✕</button>
      </div>
      <div class="gev-screenshot-preview-wrap">
        <img id="gev-screenshot-img" class="gev-screenshot-img" alt="Captured globe screenshot" />
      </div>
      <div class="gev-screenshot-footer">
        <button type="button" class="gev-screenshot-btn primary" data-screenshot-action="download">⬇ Download PNG</button>
        <button type="button" class="gev-screenshot-btn" data-screenshot-action="copy">📋 Copy Image</button>
        <button type="button" class="gev-screenshot-btn" data-screenshot-action="ortho" id="gev-screenshot-ortho-btn" hidden>🎯 Ortho Top-Down Capture</button>
        <button type="button" class="gev-screenshot-btn" data-screenshot-action="box">📐 Drag Ground Box</button>
        <button type="button" class="gev-screenshot-btn" data-screenshot-action="viewport">📷 Full Viewport</button>
        <span class="gev-screenshot-status" id="gev-screenshot-status"></span>
      </div>
    </div>
  `;
  documentRef.body.appendChild(modal);

  const previewImg = modal.querySelector('#gev-screenshot-img');
  const metaEl = modal.querySelector('#gev-screenshot-meta');
  const orthoBtn = modal.querySelector('#gev-screenshot-ortho-btn');
  const statusEl = modal.querySelector('#gev-screenshot-status');

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  function showModal(capture) {
    if (!capture || destroyed) return;
    lastCapture = capture;
    if (previewImg) previewImg.src = capture.dataUrl;
    if (metaEl) metaEl.textContent = capture.summary || '';
    if (orthoBtn) orthoBtn.hidden = !capture.box;
    setStatus('');
    modal.hidden = false;
  }

  function hideModal() {
    modal.hidden = true;
  }

  function downloadCapture(capture = lastCapture) {
    if (!capture?.dataUrl) return false;
    const a = documentRef.createElement('a');
    a.href = capture.dataUrl;
    a.download = capture.filename || `gev-screenshot-${formatTimestampSlug()}.png`;
    documentRef.body.appendChild(a);
    a.click();
    a.remove();
    setStatus(`Saved ${a.download}`);
    return true;
  }

  async function copyCaptureToClipboard(capture = lastCapture) {
    if (!capture?.dataUrl) return false;
    try {
      const res = await fetch(capture.dataUrl);
      const blob = await res.blob();
      if (globalThis.navigator?.clipboard?.write && typeof ClipboardItem === 'function') {
        await globalThis.navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob }),
        ]);
        setStatus('Copied PNG to clipboard');
        return true;
      }
    } catch {
      /* fallback below */
    }
    setStatus('Clipboard unavailable — use Download PNG');
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Composite canvas rendering (Cesium WebGL + World Overlay 2D)      */
  /* ------------------------------------------------------------------ */
  function renderCompositeCanvas({ cropRect = null, caption = '' } = {}) {
    const glCanvas = viewer?.scene?.canvas;
    if (!glCanvas || !glCanvas.width || !glCanvas.height) return null;
    const overlayCanvas = documentRef.getElementById('world-overlay-canvas');

    const cssW = glCanvas.clientWidth || glCanvas.width;
    const cssH = glCanvas.clientHeight || glCanvas.height;
    const scaleX = glCanvas.width / Math.max(1, cssW);
    const scaleY = glCanvas.height / Math.max(1, cssH);

    let sx = 0;
    let sy = 0;
    let sw = glCanvas.width;
    let sh = glCanvas.height;

    if (cropRect) {
      const padCss = 14;
      const x1 = Math.max(0, Math.min(cssW, cropRect.minX - padCss));
      const y1 = Math.max(0, Math.min(cssH, cropRect.minY - padCss));
      const x2 = Math.max(0, Math.min(cssW, cropRect.maxX + padCss));
      const y2 = Math.max(0, Math.min(cssH, cropRect.maxY + padCss));
      if (x2 - x1 >= 16 && y2 - y1 >= 16) {
        sx = Math.round(x1 * scaleX);
        sy = Math.round(y1 * scaleY);
        sw = Math.round((x2 - x1) * scaleX);
        sh = Math.round((y2 - y1) * scaleY);
      }
    }

    const out = documentRef.createElement('canvas');
    out.width = Math.max(1, sw);
    out.height = Math.max(1, sh);
    const ctx = out.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(glCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    if (overlayCanvas && overlayCanvas.width > 0 && overlayCanvas.height > 0) {
      const ovScaleX = overlayCanvas.width / Math.max(1, glCanvas.width);
      const ovScaleY = overlayCanvas.height / Math.max(1, glCanvas.height);
      ctx.drawImage(
        overlayCanvas,
        sx * ovScaleX,
        sy * ovScaleY,
        sw * ovScaleX,
        sh * ovScaleY,
        0,
        0,
        sw,
        sh,
      );
    }

    if (caption) {
      const barH = Math.max(24, Math.round(out.height * 0.038));
      ctx.fillStyle = 'rgba(6, 12, 20, 0.78)';
      ctx.fillRect(0, out.height - barH, out.width, barH);
      ctx.strokeStyle = 'rgba(255, 158, 61, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, out.height - barH);
      ctx.lineTo(out.width, out.height - barH);
      ctx.stroke();
      ctx.fillStyle = '#ffe8d6';
      ctx.font = `${Math.max(11, Math.round(barH * 0.48))}px monospace`;
      ctx.textBaseline = 'middle';
      ctx.fillText(caption, 10, out.height - barH / 2);
    }

    return {
      dataUrl: out.toDataURL('image/png'),
      width: out.width,
      height: out.height,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Public action 1: Full Viewport Screenshot                         */
  /* ------------------------------------------------------------------ */
  async function captureViewport({
    download = false,
    openModal = true,
  } = {}) {
    if (destroyed) return null;
    await waitFreshFrame(viewer);
    const cam = readCameraSummary(viewer, cesium);
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    const caption = cam
      ? `GOD'S EYE VIEW · ${ts} · ${cam.lat.toFixed(4)}°N ${cam.lon.toFixed(4)}°E · ALT ${(cam.altM / 1000).toFixed(1)} km`
      : `GOD'S EYE VIEW · ${ts}`;
    const rendered = renderCompositeCanvas({ caption });
    if (!rendered) return null;

    const capture = {
      mode: 'viewport',
      dataUrl: rendered.dataUrl,
      width: rendered.width,
      height: rendered.height,
      camera: cam,
      box: null,
      timestampUtc: ts,
      filename: `gev-viewport-${formatTimestampSlug()}.png`,
      summary: `${rendered.width}×${rendered.height} px · Viewport${cam ? ` · ${cam.lat.toFixed(3)}°, ${cam.lon.toFixed(3)}°` : ''}`,
    };
    lastCapture = capture;
    if (openModal) showModal(capture);
    if (download) downloadCapture(capture);
    return capture;
  }

  /* ------------------------------------------------------------------ */
  /*  Public action 2: Ground-Rectangle Click-and-Drag Capture          */
  /* ------------------------------------------------------------------ */
  function worldAt(position) {
    if (!position) return null;
    const canvas = viewer.scene.canvas;
    const w = canvas?.clientWidth || canvas?.width || 1;
    const h = canvas?.clientHeight || canvas?.height || 1;
    try {
      const picked = pickWorld(viewer, position.x / w, position.y / h);
      if (
        picked &&
        Number.isFinite(Number(picked.lon)) &&
        Number.isFinite(Number(picked.lat))
      ) {
        return {
          lon: Number(picked.lon),
          lat: Number(picked.lat),
          screenX: position.x,
          screenY: position.y,
        };
      }
    } catch {
      /* fallback to analytical WGS84 ray-ellipsoid intersection */
    }
    try {
      const cartesian = viewer.camera.pickEllipsoid(
        new cesium.Cartesian2(position.x, position.y),
        cesium.Ellipsoid.WGS84,
      );
      if (cartesian) {
        const carto = cesium.Cartographic.fromCartesian(cartesian);
        return {
          lon: carto.longitude * RAD_TO_DEG,
          lat: carto.latitude * RAD_TO_DEG,
          screenX: position.x,
          screenY: position.y,
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function projectBoxToScreenRect(box) {
    const xs = [];
    const ys = [];
    if (anchor && Number.isFinite(anchor.screenX)) {
      xs.push(anchor.screenX);
      ys.push(anchor.screenY);
    }
    if (corner && Number.isFinite(corner.screenX)) {
      xs.push(corner.screenX);
      ys.push(corner.screenY);
    }
    if (box) {
      const corners = [
        [box.west, box.south],
        [box.east, box.south],
        [box.east, box.north],
        [box.west, box.north],
      ];
      for (const [lon, lat] of corners) {
        try {
          const cart = cesium.Cartesian3.fromDegrees(lon, lat, 0);
          const win = cesium.SceneTransforms.worldToWindowCoordinates(
            viewer.scene,
            cart,
          );
          if (win && Number.isFinite(win.x) && Number.isFinite(win.y)) {
            xs.push(win.x);
            ys.push(win.y);
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (xs.length < 2) return null;
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }

  function updateRubberband() {
    if (!anchor || !corner) {
      rubberband.hidden = true;
      return;
    }
    const minX = Math.min(anchor.screenX, corner.screenX);
    const minY = Math.min(anchor.screenY, corner.screenY);
    const width = Math.max(4, Math.abs(corner.screenX - anchor.screenX));
    const height = Math.max(4, Math.abs(corner.screenY - anchor.screenY));
    rubberband.style.left = `${Math.round(minX)}px`;
    rubberband.style.top = `${Math.round(minY)}px`;
    rubberband.style.width = `${Math.round(width)}px`;
    rubberband.style.height = `${Math.round(height)}px`;
    const box = currentDragBox();
    const dims = computeBoxDimensionsKm(box);
    rubberbandLabel.textContent = `${dims.widthKm} × ${dims.heightKm} km (${box.south.toFixed(3)}°N..${box.north.toFixed(3)}°N, ${box.west.toFixed(3)}°E..${box.east.toFixed(3)}°E)`;
    rubberband.hidden = false;
  }

  function freezeCamera() {
    const controller = viewer.scene.screenSpaceCameraController;
    if (!controller || savedCameraInputs !== null) return;
    savedCameraInputs = controller.enableInputs;
    controller.enableInputs = false;
  }

  function thawCamera() {
    const controller = viewer.scene.screenSpaceCameraController;
    if (controller && savedCameraInputs !== null) {
      controller.enableInputs = savedCameraInputs;
    }
    savedCameraInputs = null;
  }

  function setPreviewVisible(visible) {
    fillEntity.show = visible;
    outlineEntity.show = visible;
    if (!visible) rubberband.hidden = true;
    viewer.scene.requestRender?.();
  }

  function endDrag() {
    anchor = null;
    corner = null;
    thawCamera();
    setPreviewVisible(false);
  }

  async function finalizeBoxCapture(box, screenRect, modeLabel = 'Ground Box') {
    const dims = computeBoxDimensionsKm(box);
    await waitFreshFrame(viewer);
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    const caption = `GOD'S EYE VIEW · ${modeLabel.toUpperCase()} ${dims.widthKm}×${dims.heightKm} km (${dims.areaKm2} km²) · [${box.south.toFixed(4)}°..${box.north.toFixed(4)}°N, ${box.west.toFixed(4)}°..${box.east.toFixed(4)}°E] · ${ts}`;
    const rendered = renderCompositeCanvas({
      cropRect: screenRect,
      caption,
    });
    if (!rendered) return null;

    const capture = {
      mode: 'ground-box',
      dataUrl: rendered.dataUrl,
      width: rendered.width,
      height: rendered.height,
      box: { ...box, ...dims },
      timestampUtc: ts,
      filename: `gev-groundbox-${formatTimestampSlug()}.png`,
      summary: `${rendered.width}×${rendered.height} px · ${dims.widthKm}×${dims.heightKm} km (${box.south.toFixed(3)}°..${box.north.toFixed(3)}°N)`,
    };
    showModal(capture);
    return capture;
  }

  async function captureOrthoGroundBox(box = lastCapture?.box) {
    if (!box || destroyed) return null;
    setStatus('Flying to top-down orthographic framing…');
    const rect = cesium.Rectangle.fromDegrees(
      box.west,
      box.south,
      box.east,
      box.north,
    );
    await new Promise((resolve) => {
      viewer.camera.flyTo({
        destination: rect,
        orientation: {
          heading: 0,
          pitch: -Math.PI / 2,
          roll: 0,
        },
        duration: 1.1,
        complete: resolve,
        cancel: resolve,
      });
    });
    await new Promise((r) => setTimeout(r, 450));
    await waitFreshFrame(viewer);
    const screenRect = projectBoxToScreenRect(box);
    return finalizeBoxCapture(box, screenRect, 'Ortho Ground Box');
  }

  const onDown = (event) => {
    if (!active || destroyed || anchor) return;
    const point = worldAt(event.position);
    if (!point) {
      banner.textContent =
        '📐 Click on the globe surface (not empty sky) and drag a rectangle · Esc to cancel';
      return;
    }
    anchor = point;
    corner = point;
    freezeCamera();
    setPreviewVisible(true);
    updateRubberband();
  };

  const onMove = (event) => {
    if (!anchor || destroyed) return;
    const point = worldAt(event.endPosition);
    if (!point) return;
    corner = point;
    updateRubberband();
    viewer.scene.requestRender?.();
  };

  const onUp = async (event) => {
    if (!anchor || destroyed) return;
    corner = worldAt(event.position) || corner;
    const box = currentDragBox();
    const screenRect = projectBoxToScreenRect(box);
    const dxPx = Math.abs((corner?.screenX ?? 0) - (anchor?.screenX ?? 0));
    const dyPx = Math.abs((corner?.screenY ?? 0) - (anchor?.screenY ?? 0));
    endDrag();
    setActive(false);

    if (!box || (dxPx < 8 && dyPx < 8)) {
      return;
    }
    await finalizeBoxCapture(box, screenRect, 'Ground Box');
  };

  const onKey = (event) => {
    if (destroyed) return;
    if (event.key === 'Escape') {
      if (active) {
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        setActive(false);
      } else if (!modal.hidden) {
        event.preventDefault?.();
        hideModal();
      }
    }
  };

  function bindScene() {
    if (handler) return;
    handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onDown, cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(onMove, cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction(onUp, cesium.ScreenSpaceEventType.LEFT_UP);
    const stock = viewer.screenSpaceEventHandler;
    if (stock) {
      savedSingleClick =
        stock.getInputAction(cesium.ScreenSpaceEventType.LEFT_CLICK) || null;
      savedDoubleClick =
        stock.getInputAction(cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
        null;
      stock.removeInputAction(cesium.ScreenSpaceEventType.LEFT_CLICK);
      stock.removeInputAction(cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }
    documentRef.body.classList.add('gev-screenshot-box-active');
  }

  function releaseScene() {
    if (handler) {
      handler.destroy();
      handler = null;
    }
    const stock = viewer.screenSpaceEventHandler;
    if (stock && savedSingleClick) {
      stock.setInputAction(
        savedSingleClick,
        cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
    }
    if (stock && savedDoubleClick) {
      stock.setInputAction(
        savedDoubleClick,
        cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
    }
    savedSingleClick = null;
    savedDoubleClick = null;
    documentRef.body.classList.remove('gev-screenshot-box-active');
  }

  function setActive(next) {
    if (next === active) return active;
    if (next) {
      hideModal();
      lease = claimPointer(SCREENSHOT_BOX_POINTER_OWNER);
      if (!lease) {
        banner.textContent = `${pointerOwner()} is using the pointer — close it first`;
        banner.hidden = false;
        setTimeout(() => {
          if (!active) banner.hidden = true;
        }, 2400);
        return active;
      }
      active = true;
      banner.textContent =
        '📐 Click and drag a rectangle on the ground to generate an image · Press Esc to cancel';
      banner.hidden = false;
      boxBtn?.setAttribute('aria-pressed', 'true');
      boxBtn?.classList.add('active');
      bindScene();
    } else {
      if (anchor) endDrag();
      releaseScene();
      releasePointer(lease);
      lease = null;
      active = false;
      banner.hidden = true;
      boxBtn?.setAttribute('aria-pressed', 'false');
      boxBtn?.classList.remove('active');
    }
    return active;
  }

  function startBoxCapture() {
    if (destroyed) return false;
    return setActive(!active);
  }

  function cancelBoxCapture() {
    if (!active || destroyed) return;
    setActive(false);
  }

  /* ------------------------------------------------------------------ */
  /*  DOM event listeners                                                */
  /* ------------------------------------------------------------------ */
  const onViewportClick = () => {
    captureViewport({ openModal: true });
  };
  const onBoxClick = () => {
    startBoxCapture();
  };
  const onModalClick = (event) => {
    if (event.target === modal) {
      hideModal();
      return;
    }
    const btnEl = event.target?.closest?.('[data-screenshot-action]');
    if (!btnEl) return;
    const action = btnEl.dataset.screenshotAction;
    if (action === 'close') hideModal();
    else if (action === 'download') downloadCapture();
    else if (action === 'copy') copyCaptureToClipboard();
    else if (action === 'ortho') captureOrthoGroundBox();
    else if (action === 'box') {
      hideModal();
      setActive(true);
    } else if (action === 'viewport') {
      captureViewport({ openModal: true });
    }
  };

  viewportBtn?.addEventListener('click', onViewportClick);
  boxBtn?.addEventListener('click', onBoxClick);
  modal.addEventListener('click', onModalClick);
  documentRef.addEventListener('keydown', onKey, true);

  const api = {
    captureViewport,
    startBoxCapture,
    cancelBoxCapture,
    captureOrthoGroundBox,
    downloadCapture,
    isActive: () => active,
    getLastCapture: () => lastCapture,
    destroy() {
      if (destroyed) return attaching;
      if (active) setActive(false);
      destroyed = true;
      viewportBtn?.removeEventListener('click', onViewportClick);
      boxBtn?.removeEventListener('click', onBoxClick);
      modal.removeEventListener('click', onModalClick);
      documentRef.removeEventListener('keydown', onKey, true);
      banner.remove();
      rubberband.remove();
      modal.remove();
      dataSource.entities.removeAll();
      attaching = attaching.then(() => {
        try {
          viewer.dataSources.remove(dataSource, true);
        } catch {
          /* viewer already disposed */
        }
      });
      return attaching;
    },
  };

  if (globalThis.window) {
    globalThis.window.__gevScreenshot = api;
  }

  return api;
}
