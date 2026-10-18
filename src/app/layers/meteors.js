import { createMeteorsLayer as createLayer } from '../../layers/meteors/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as focus from '../../worldFocus.js';

export const meteorsServices = {
  render,
  sprites,
  context,
  picking,
  overlays,
  focus,
};

/** Bind a supplied fireball feed to the application scene service owners. */
export function createApplicationMeteors({ surface, ...options }) {
  return createLayer({
    ...options,
    icon: options.icon ?? '☄',
    source: options.source ?? 'CNEOS · GMN · NASA ASGARD/ARES',
    feed: options.feed,
    services: { ...meteorsServices, anchors: surface.anchors },
    overlayHost: options.overlayHost ?? {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
  });
}
