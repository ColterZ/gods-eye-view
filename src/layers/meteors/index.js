import { createMeteorsState } from './state.js';
import { createSource } from './source.js';
import { createRendering } from './rendering.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createMeteorPanel } from './panel.js';
import { LAYER_ID } from './policy.js';

/**
 * Compose one meteor fireball layer with explicit source and scene operations.
 * Follows the official layer pattern: state → source → rendering → controls → lifecycle.
 */
export function createMeteorsLayer({ services, feed, ...config }) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Meteors require a snapshot source');

  const layerState = createMeteorsState({ services, config });
  const components = {};
  const context = { layerState, services, config, components, feed };

  components.source = createSource(context);
  components.rendering = createRendering(context);
  components.controls = createControls(context);
  components.lifecycle = createLifecycle(context);

  // Mount the right-rail context panel for meteor/dark-flight controls.
  // Created eagerly (cheap DOM) and hidden/shown via setEnabled; it syncs its
  // content from the layer's row-controls descriptor on every state change.
  if (typeof document !== 'undefined') {
    const container = document.getElementById('meteor-panel');
    const countBadge = document.getElementById('meteor-panel-count');
    const body = document.getElementById('meteor-panel-body');
    if (container) {
      components.panel = createMeteorPanel({
        container,
        countBadge,
        body,
        // The panel is the layer's own presentation surface, so it dispatches
        // straight into this layer's setParams — there is no application-level
        // setLayerParams service to route through.
        setLayerParams: (_id, params) =>
          components.controls.methods.setParams(params),
      });
      // The controls module captured `components` by reference, so a panel
      // created after it still gets published through the same object.
      components.controls.pushPanel?.();
    }
  }

  return Object.assign(
    {},
    components.controls.methods,
    components.lifecycle.methods,
    components.panel ? { panel: components.panel } : {},
  );
}

export { LAYER_ID };
export { createMeteorsState } from './state.js';
export { createSource } from './source.js';
export { createRendering } from './rendering.js';
export { createControls } from './controls.js';
export { createLifecycle } from './lifecycle.js';
export * from './corroboration.js';
export * from './darkFlight.js';
export * from './foundStones.js';
export * from './validation.js';
export * from './sceneGenerator.js';
export * from './model.js';
export * from './policy.js';
