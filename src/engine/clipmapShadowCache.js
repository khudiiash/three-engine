import { Object3D, Material, ShadowNode, VSMShadowMap } from "three/webgpu";

// A retained depth texture exists only while a stable map mixes static and
// moving casters (plus color when transmitted shadows sample it). shadow.map
// remains the native combined map, including its PCF.
const MATERIAL_VALUES = ["version", "visible", "side", "shadowSide", "alphaTest", "alphaHash",
  "opacity", "transparent", "depthWrite", "depthTest", "depthFunc", "displacementScale",
  "displacementBias", "clipShadows", "clipIntersection", "wireframe"];
const NODE_VALUES = ["positionNode", "castShadowPositionNode", "vertexNode", "depthNode",
  "colorNode", "opacityNode", "alphaTestNode", "shadowNode", "castShadowNode", "maskNode", "maskShadowNode"];
const same = (a, b) => !!a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const appendMatrix = (out, matrix) => { if (matrix) out.push(...matrix.elements); };

function appendAttribute(out, attribute) {
  out.push(attribute, attribute?.version, attribute?.count, attribute?.itemSize,
    attribute?.normalized, attribute?.usage, attribute?.data, attribute?.data?.version);
}

function appendTexture(out, texture) {
  out.push(texture, texture?.version, texture?.source, texture?.source?.version,
    texture?.mapping, texture?.channel, texture?.wrapS, texture?.wrapT,
    texture?.minFilter, texture?.magFilter, texture?.flipY);
  if (!texture) return;
  // Texture transforms can change without needsUpdate/version changing.
  out.push(texture.offset?.x, texture.offset?.y, texture.repeat?.x, texture.repeat?.y,
    texture.center?.x, texture.center?.y, texture.rotation, texture.matrixAutoUpdate);
  // With automatic transforms this matrix is derived from the values above
  // during the draw. Its first lazy update must not look like an authored edit.
  if (texture.matrixAutoUpdate === false) appendMatrix(out, texture.matrix);
}

function describeCaster(object) {
  const geometry = object.geometry;
  const motion = [object.count];
  appendMatrix(motion, object.matrixWorld);
  appendAttribute(motion, object.instanceMatrix);
  const vertices = [];
  appendAttribute(vertices, geometry?.attributes?.position);
  const values = [object, object.parent, object.layers.mask, geometry, geometry?.drawRange?.start,
    geometry?.drawRange?.count, object.count, object.frustumCulled, object.renderOrder];
  appendMatrix(values, object.matrixWorld);
  appendAttribute(values, geometry?.index);
  for (const name of Object.keys(geometry?.attributes || {}).sort()) {
    values.push(name);
    appendAttribute(values, geometry.attributes[name]);
  }
  for (const group of geometry?.groups || []) values.push(group.start, group.count, group.materialIndex);
  appendAttribute(values, object.instanceMatrix);
  appendAttribute(values, object.instanceColor);
  let animated = !!(object.isSkinnedMesh || object.morphTargetInfluences?.length
    || object.isBatchedMesh || object.userData?.vfxSimulation);
  // Unknown callbacks may mutate buffers/uniforms only when the shadow draws.
  for (const name of ["onBeforeRender", "onAfterRender", "onBeforeShadow", "onAfterShadow"]) {
    if (object[name] !== Object3D.prototype[name]) animated = true;
  }
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) {
    values.push(material);
    if (!material) continue;
    for (const name of MATERIAL_VALUES) values.push(material[name]);
    // Node graphs can read clocks, storage, or mutable uniforms without a
    // material version bump. Treat them conservatively instead of guessing.
    for (const name of NODE_VALUES) if (material[name]) animated = true;
    if (material.onBeforeRender !== Material.prototype.onBeforeRender) animated = true;
    if (material.onBeforeCompile !== Material.prototype.onBeforeCompile) animated = true;
    for (const name of Object.keys(material).sort()) {
      if (material[name]?.isTexture) {
        values.push(name);
        appendTexture(values, material[name]);
        if (material[name].isVideoTexture || material[name].isRenderTargetTexture) animated = true;
      }
    }
    for (const plane of material.clippingPlanes || []) {
      values.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    }
  }
  return { values, animated, motion, vertices, geometry };
}

/** Shared by all levels; strong references never outlive current casters. */
export class ClipmapShadowCache {
  constructor() {
    this.records = new Map();
    this.staticObjects = new Set();
    this.movingObjects = new Set();
    this.promoted = new WeakSet();
    this.staticRevision = 0;
    this.revision = 0;
    this.generation = 0;
    this._frameId = undefined;
    this._pruneFrameId = undefined;
    this._scene = null;
    this.stats = { walks: 0, staticCasters: 0, movingCasters: 0 };
  }

  prepare(scene, renderer, frameId) {
    if (frameId !== undefined && this._frameId === frameId && this._scene === scene) return this;
    this._frameId = frameId;
    this._scene = scene;
    this.stats.walks++;
    const seen = new Set();
    let staticChanged = false;
    let changed = false;
    scene.traverseVisible((object) => {
      if (!object.isMesh || object.castShadow !== true) return;
      seen.add(object);
      const description = describeCaster(object);
      const previous = this.records.get(object);
      const differs = !previous || !same(previous.values, description.values);
      // A mover leaves the static map on its first changed frame. It remains
      // moving, so subsequent frames do not re-render the static environment.
      const moved = previous && (!same(previous.motion, description.motion)
        || (previous.geometry === description.geometry && !same(previous.vertices, description.vertices)));
      if (moved) this.promoted.add(object);
      const moving = description.animated || this.promoted.has(object);
      if (!previous || previous.moving !== moving || (!moving && differs)) staticChanged = true;
      if (differs || description.animated || previous?.moving !== moving) changed = true;
      this.records.set(object, { ...description, moving });
      (moving ? this.movingObjects : this.staticObjects).add(object);
      (moving ? this.staticObjects : this.movingObjects).delete(object);
    });
    for (const [object, record] of this.records) {
      if (seen.has(object)) continue;
      this.records.delete(object);
      this.staticObjects.delete(object);
      this.movingObjects.delete(object);
      if (!record.moving) staticChanged = true;
      changed = true;
    }
    if (staticChanged) this.staticRevision++;
    if (changed) this.revision++;
    this.stats.staticCasters = this.staticObjects.size;
    this.stats.movingCasters = this.movingObjects.size;
    return this;
  }

  /** Release removed casters while a moving light bypasses full descriptions. */
  prune(scene, frameId) {
    if (frameId !== undefined && this._pruneFrameId === frameId && this._scene === scene) return;
    this._pruneFrameId = frameId;
    let changed = false;
    let staticChanged = false;
    for (const [object, record] of this.records) {
      let parent = object;
      while (parent && parent !== scene && parent.visible !== false) parent = parent.parent;
      if (object.castShadow === true && object.isMesh && parent === scene && scene.visible !== false) continue;
      this.records.delete(object);
      this.staticObjects.delete(object);
      this.movingObjects.delete(object);
      staticChanged ||= !record.moving;
      changed = true;
    }
    if (staticChanged) this.staticRevision++;
    if (changed) this.revision++;
    this.stats.staticCasters = this.staticObjects.size;
    this.stats.movingCasters = this.movingObjects.size;
  }

  invalidate() {
    this.generation++;
    this.staticRevision++;
    this.revision++;
    this._frameId = undefined;
  }

  dispose() {
    this.records.clear();
    this.staticObjects.clear();
    this.movingObjects.clear();
    this.promoted = new WeakSet();
    this._scene = null;
    this.invalidate();
  }
}

function mapKey(node, renderer) {
  const { shadow, shadowMap } = node;
  const key = [shadowMap, shadowMap.depthTexture, shadowMap.depthTexture.version,
    shadow.mapSize.x, shadow.mapSize.y, shadow.camera.layers.mask, renderer.shadowMap.type,
    renderer.shadowMap.transmitted, renderer.reversedDepthBuffer];
  appendMatrix(key, shadow.camera.matrixWorld);
  appendMatrix(key, shadow.camera.projectionMatrix);
  for (const plane of renderer.clippingPlanes || []) key.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  return key;
}

/** Only successful native draws may become a receipt, including async warm-up. */
function renderWithReceipt(renderer, render) {
  const pipelines = renderer._pipelines;
  const original = pipelines?.isReady;
  const state = pipelines?.__asyncRenderPipelines;
  const deferred = state?.deferred;
  const buildsDeferred = state?.buildsDeferred;
  const parkedDraws = state?.parkedDraws;
  let complete = true;
  if (original) {
    pipelines.isReady = function (object) {
      const ready = original.call(this, object);
      const data = this.get?.(object);
      // A stand-in preserves the picture while recompiling, but must never be
      // committed as the new material's permanently cached shadow.
      if (!ready || object.__previousDraw || data?.__standIn) complete = false;
      return ready;
    };
  }
  try {
    render();
  } finally {
    if (original) pipelines.isReady = original;
  }
  return complete && deferred === state?.deferred && buildsDeferred === state?.buildsDeferred
    && parkedDraws === state?.parkedDraws;
}

export class ClipmapLevelShadowNode extends ShadowNode {
  constructor(light, shadow, index, { cache, enabled = true } = {}) {
    super(light, shadow);
    this.cache = cache || new ClipmapShadowCache();
    this._ownsCache = !cache;
    this.cacheEnabled = enabled;
    this.levelIndex = index;
    this.shadow.clipmapCacheOwned = true;
    this._staticMap = null;
    this._staticReceipt = null;
    this._combinedReceipt = null;
    this._lastMapKey = null;
    this._staticColor = false;
    this.stats = { staticRenders: 0, movingRenders: 0, fullRenders: 0, holds: 0, copies: 0,
      incomplete: 0, bypasses: 0, mapChanges: 0, allStaticRenders: 0 };
  }

  invalidateCache() {
    this._staticReceipt = null;
    this._combinedReceipt = null;
  }

  renderShadow(frame) {
    const { renderer, scene } = frame;
    const { shadow, shadowMap, cache } = this;
    shadow.updateMatrices(this.light);
    shadowMap.setSize(shadow.mapSize.width, shadow.mapSize.height, shadowMap.depth);
    const key = mapKey(this, renderer);
    const mapChanged = !same(this._lastMapKey, key);
    // A moving sun or snapped volume cannot reuse the previous raster. Do not
    // traverse the scene to classify it, allocate a cache, or copy a map that
    // will immediately be obsolete; ordinary native shadow rendering suffices.
    if (mapChanged) cache.prune(scene, frame.frameId);
    else cache.prepare(scene, renderer, frame.frameId);
    const combinedKey = [...key, cache.revision, cache.generation];
    if (!mapChanged && renderer.shadowMap.type !== VSMShadowMap && same(this._combinedReceipt, combinedKey)) {
      this.stats.holds++;
      return;
    }
    const originalFunction = renderer.getRenderObjectFunction();
    const originalClear = renderer.autoClear;
    const originalName = scene.name;
    scene.name = `Shadow Clipmap ${this.levelIndex + 1} [ ${this.light.name || this.light.id} ]`;
    const draw = (objects, clear) => {
      renderer.autoClear = clear;
      renderer.setRenderObjectFunction(objects
        ? (object, ...args) => { if (objects.has(object)) originalFunction(object, ...args); }
        : originalFunction);
      return renderWithReceipt(renderer, () => renderer.render(scene, shadow.camera));
    };
    this._combinedReceipt = null;
    try {
      // VSM receives additional non-casters and performs a blur after this
      // hook; keep its full native path. WebGL has different depth-copy rules.
      const split = !mapChanged && this.cacheEnabled && renderer.backend?.isWebGPUBackend === true
        && renderer.shadowMap.type !== VSMShadowMap && cache.staticObjects.size > 0
        && cache.movingObjects.size > 0;
      let complete;
      if (!split) {
        this._disposeStaticMap();
        this.stats.bypasses++;
        if (mapChanged) this.stats.mapChanges++;
        else if (cache.movingObjects.size === 0) this.stats.allStaticRenders++;
        this.stats.fullRenders++;
        complete = draw(null, true);
      } else {
        const staticKey = [...key, cache.staticRevision, cache.generation];
        if (!same(this._staticReceipt, staticKey)) {
          this._staticReceipt = null;
          this.stats.staticRenders++;
          complete = draw(cache.staticObjects, true);
          if (complete) {
            this._ensureStaticMap(renderer);
            this._copy(renderer, shadowMap, this._staticMap);
            this._staticReceipt = [...mapKey(this, renderer), cache.staticRevision, cache.generation];
          }
        } else {
          this._copy(renderer, this._staticMap, shadowMap);
          complete = true;
        }
        if (cache.movingObjects.size > 0) {
          this.stats.movingRenders++;
          complete = draw(cache.movingObjects, false) && complete;
        }
      }
      if (complete) {
        this._lastMapKey = mapKey(this, renderer);
        this._combinedReceipt = [...this._lastMapKey, cache.revision, cache.generation];
      } else this.stats.incomplete++;
    } finally {
      renderer.autoClear = originalClear;
      renderer.setRenderObjectFunction(originalFunction);
      scene.name = originalName;
    }
  }

  _ensureStaticMap(renderer) {
    const { shadowMap } = this;
    const color = renderer.shadowMap.transmitted === true;
    if (this._staticMap && (this._staticColor !== color
      || this._staticMap.width !== shadowMap.width || this._staticMap.height !== shadowMap.height)) {
      this._disposeStaticMap();
    }
    if (this._staticMap) return;
    const target = this._staticMap = shadowMap.clone();
    this._staticColor = color;
    target.depthTexture.name = `ClipmapStaticDepth${this.levelIndex}`;
    if (color) {
      target.texture.name = `ClipmapStaticColor${this.levelIndex}`;
      renderer.initRenderTarget(target);
    } else {
      // Three's initRenderTarget requires a color attachment. This cache is
      // only copied, never rendered into, so initialize the depth texture on
      // its own and allocate no color texture or framebuffer attachment.
      target.textures.length = 0;
      renderer.initTexture(target.depthTexture);
    }
  }

  _disposeStaticMap() {
    if (this._staticMap) {
      // initTexture owns a texture disposal listener; initRenderTarget owns
      // both attachments via the target listener. Do not destroy either twice.
      if (!this._staticColor) this._staticMap.depthTexture.dispose();
      this._staticMap.dispose();
    }
    this._staticMap = null;
    this._staticReceipt = null;
  }

  _copy(renderer, source, destination) {
    if (this._staticColor) {
      renderer.copyTextureToTexture(source.texture, destination.texture);
      this.stats.copies++;
    }
    renderer.copyTextureToTexture(source.depthTexture, destination.depthTexture);
    this.stats.copies++;
  }

  _reset() {
    this._disposeStaticMap();
    this._lastMapKey = null;
    this.invalidateCache();
    super._reset();
  }

  dispose() {
    if (this._ownsCache) this.cache.dispose();
    super.dispose();
  }
}

export const createClipmapLevelShadowNode = (light, shadow, index, options) =>
  new ClipmapLevelShadowNode(light, shadow, index, options);
