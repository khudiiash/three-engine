// Hidden LODs and out-of-view chunks still have distinct InstancedMesh programs
// in Three. Prepare them before a camera sweep first asks the driver to draw them.
const queues = new WeakMap();
const holds = new WeakMap();
const nextFrame = () => new Promise(resolve => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
  else setTimeout(resolve, 0);
});

export function deferFoliageDisposal(component, dispose) {
  const hold = holds.get(component);
  if (hold?.active) hold.disposals.push(dispose);
  else dispose();
}

export async function holdFoliageResources(component, compile) {
  let hold = holds.get(component);
  if (!hold) holds.set(component, hold = {active: 0, disposals: []});
  hold.active++;
  try { return await compile(); }
  finally {
    if (--hold.active === 0) {
      holds.delete(component);
      let failure;
      for (const dispose of hold.disposals) {
        try { dispose(); } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    }
  }
}

/** Warm only the ordinary framebuffer variant. Three captures the render list
 * synchronously, but NodeMaterial/NodeBuilder read renderer.getMRT() later while
 * building nodes asynchronously. Temporarily installing a G-buffer MRT here
 * therefore compiles the wrong graph after restoration and can black out GI.
 * GI and post-processing must own compilation of their render-pass variants.
 */
export function compileFoliageMesh(renderer, scene, camera, mesh) {
  if (renderer.getRenderTarget() || renderer.getMRT()) return;
  const saved = {
    override: scene.overrideMaterial, background: scene.background, backgroundNode: scene.backgroundNode,
    visible: mesh.visible, culled: mesh.frustumCulled,
  };
  try {
    mesh.visible = true;
    mesh.frustumCulled = false;
    scene.overrideMaterial = null;
    // There is no reason to precompile the background once for every chunk.
    scene.background = null;
    scene.backgroundNode = null;
    return renderer.compileAsync(mesh, camera, scene);
  } finally {
    mesh.visible = saved.visible;
    mesh.frustumCulled = saved.culled;
    scene.overrideMaterial = saved.override;
    scene.background = saved.background;
    scene.backgroundNode = saved.backgroundNode;
  }
}

function available(engine) {
  const gi = engine.modules?.get?.('gi')?.system;
  return engine.loopActive !== false && !engine.renderSuspended && !engine.simulationSuspended &&
    !engine.impostors?.baking && !engine.renderer?.__foliageAtlasPending && !gi?._compileWaveActive;
}

function signature(component) {
  const engine = component.entity.engine;
  const gi = engine.modules?.get?.('gi')?.system;
  const pass = engine.scenePass;
  const meshes = component.renderMeshes ?? component.chunks[0]?.meshes ?? [];
  return [component._generation, ...meshes.map(mesh => `${mesh?.uuid}:${mesh?.material?.uuid}:${mesh?.material?.version}`),
    component.material?.version, engine.camera?.uuid,
    gi?.state?.light?.uuid, pass?.renderTarget?.uuid, pass?.getMRT?.()?.uuid].join('|');
}

function ownsMainFramebuffer(engine) {
  return !engine.scenePass?.renderTarget && !engine.scenePass?.getMRT?.() &&
    !engine.renderer.getRenderTarget() && !engine.renderer.getMRT();
}

async function drain(renderer, queue) {
  queue.running = true;
  let current;
  try {
    while (queue.entries.length) {
      const {component, key, meshes} = queue.entries.shift();
      current = component;
      const engine = component.entity?.engine;
      const live = () => component._alive && component.root && component._foliageWarmup?.key === key &&
        signature(component) === key && ownsMainFramebuffer(engine);
      for (const mesh of meshes) {
        await nextFrame();
        while (live() && !available(engine)) await nextFrame();
        if (!live()) break;
        const camera = engine.camera;
        await holdFoliageResources(component, () => compileFoliageMesh(renderer, engine.scene, camera, mesh));
        if (live()) component._foliageWarmup.pending--;
      }
    }
  } catch (error) {
    // Rendering remains available on the ordinary compiler path. Expose failure
    // rather than leaking an unhandled async rejection or claiming a warm cache.
    queue.error = error?.message ?? String(error);
    for (const component of [current, ...queue.entries.map(entry => entry.component)]) if (component?._foliageWarmup) {
      Object.assign(component._foliageWarmup, {error: queue.error, pending: 0, retryAfter: Date.now() + 5000});
    }
    queue.entries.length = 0;
  } finally { queue.running = false; }
}

export function updateFoliageWarmup(component) {
  const engine = component.entity?.engine, renderer = engine?.renderer;
  if (!renderer?._initialized || !renderer.compileAsync || !engine.camera || !component._atlasEntry?.atlas || !available(engine)) return;
  if (!ownsMainFramebuffer(engine)) {
    component._foliageWarmup = {key: null, pending: 0, error: null, skipped: 'render pass owns compilation'};
    return;
  }
  const key = signature(component);
  const previous = component._foliageWarmup;
  if (previous?.key === key && (!previous.error || previous.retryAfter > Date.now() || previous.retries >= 2)) return;
  const meshes = (component.renderMeshes ?? component.chunks.flatMap(chunk => chunk.meshes)).filter(Boolean);
  component._foliageWarmup = {key, pending: meshes.length, error: null, retries: previous?.key === key ? previous.retries + 1 : 0};
  let queue = queues.get(renderer);
  if (!queue) queues.set(renderer, queue = {entries: [], running: false, error: null});
  queue.entries.push({component, key, meshes});
  if (!queue.running) void drain(renderer, queue);
}
