import { createMeteorsState } from './state.js';
import { createSource } from './source.js';
import { createRendering } from './rendering.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
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

  return Object.assign(
    {},
    components.controls.methods,
    components.lifecycle.methods,
  );
}

export { LAYER_ID };
export { createMeteorsState } from './state.js';
export { createSource } from './source.js';
export { createRendering } from './rendering.js';
export { createControls } from './controls.js';
export { createLifecycle } from './lifecycle.js';
export * from './model.js';
export * from './policy.js';
