// Ground-truth comparison for the GI component: three-gpu-pathtracer's
// WebGPU backend (the `webgpu-pathtracer` branch) rendered over the live
// viewport. Reached as debug view `"path-tracer"` — a live switch, not a
// rebuild. First enable lazy-loads the library and builds a BVH; after that
// toggling only pauses/resumes accumulation.
//
// The tracer writes its own target and blits to the canvas in post-render,
// replacing the rasterized GI frame. Camera motion resets samples. Scene
// graph edits rebuild the BVH. GI state is left alone so flipping back is
// the GI image that was already on screen, not a cold start.
import { EDITOR_LAYER, UI_LAYER, SHADOW_PROXY_LAYER } from "../../engine/editorLayers.js";
import { constantColorOf, constantFloatOf, textureValueOf, tintBesideTexture } from "./materialNodeBindings.js";

const NODE_TEXTURE_SLOTS = [
  ["map", "colorNode"],
  ["roughnessMap", "roughnessNode"],
  ["metalnessMap", "metalnessNode"],
  ["normalMap", "normalNode"],
  ["emissiveMap", "emissiveNode"],
];

/** Path tracer reads classic `.map` / `.color` / `.roughness`. Engine .mat
 *  graphs put the real albedo on `colorNode` and leave `.color` at white. */
export function stampClassicFromNodes(material) {
  if (!material) return null;
  const prev = {};
  let changed = false;
  const color = constantColorOf(material.colorNode) ?? tintBesideTexture(material.colorNode);
  if (color && material.color?.setRGB) {
    prev.color = material.color.clone();
    material.color.setRGB(color.r, color.g, color.b);
    changed = true;
  }
  for (const [slot, nodeKey] of NODE_TEXTURE_SLOTS) {
    if (material[slot]) continue;
    const tex = textureValueOf(material[nodeKey]);
    if (!tex) continue;
    prev[slot] = material[slot] ?? null;
    material[slot] = tex;
    changed = true;
  }
  const roughness = constantFloatOf(material.roughnessNode);
  if (roughness != null) {
    prev.roughness = material.roughness;
    material.roughness = roughness;
    changed = true;
  }
  const metalness = constantFloatOf(material.metalnessNode);
  if (metalness != null) {
    prev.metalness = material.metalness;
    material.metalness = metalness;
    changed = true;
  }
  const emissive = constantColorOf(material.emissiveNode);
  if (emissive && material.emissive?.setRGB) {
    prev.emissive = material.emissive.clone();
    material.emissive.setRGB(emissive.r, emissive.g, emissive.b);
    changed = true;
  }
  return changed ? prev : null;
}

function restoreClassicStamp(material, prev) {
  if (!material || !prev) return;
  if (prev.color) material.color.copy(prev.color);
  if (prev.emissive) material.emissive.copy(prev.emissive);
  if ("roughness" in prev) material.roughness = prev.roughness;
  if ("metalness" in prev) material.metalness = prev.metalness;
  for (const [slot] of NODE_TEXTURE_SLOTS) {
    if (slot in prev) material[slot] = prev[slot];
  }
}

function stampSceneMaterials(scene) {
  const stamps = [];
  const seen = new Set();
  scene.traverse((object) => {
    if (!object.isMesh) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      const prev = stampClassicFromNodes(material);
      if (prev) stamps.push({ material, prev });
    }
  });
  return stamps;
}

function restoreSceneMaterials(stamps) {
  for (const { material, prev } of stamps) restoreClassicStamp(material, prev);
}

function hasEditorAncestor(object) {
  for (let node = object; node; node = node.parent) {
    if (node.userData?.editorOnly) return true;
  }
  return false;
}

function shouldPark(object) {
  const geometry = object.geometry;
  // WebGPUPathTracer.setScene runs setCommonAttributes on EVERY BufferGeometry
  // in the graph (LineSegments included), and that helper does
  // `geometry.attributes.position.count` with no guard. The blockout overlay
  // keeps empty LineSegments in the scene while hidden — that is the editor
  // `.count` crash.
  if (geometry?.isBufferGeometry) {
    const position = geometry.attributes?.position;
    if (!position || !(position.count > 0)) return true;
  }
  if (!object.isMesh) return false;
  if (object.isInstancedMesh && !(object.count > 0)) return true;
  if (object.isBatchedMesh && !(object.instanceCount > 0)) return true;
  const data = object.userData ?? {};
  // CPU BVH construction cannot read the GPU-deformed simulation surface.
  if (data.vfxSimulation || data.clothHidden) return true;
  // Merge proxies (especially the uber table) shade from colorNode array
  // textures the path tracer cannot sample. Trace the hidden members instead.
  if (data.__giDebug || data.mergeProxy || data.editorOnly) return true;
  if (hasEditorAncestor(object)) return true;
  if (object.layers.isEnabled(EDITOR_LAYER)) return true;
  if (object.layers.isEnabled(UI_LAYER)) return true;
  if ((object.layers.mask >>> 0) === ((1 << SHADOW_PROXY_LAYER) >>> 0)) return true;
  return false;
}

/** GI's async pipeline wrap skips the first dispatch and replays without a size.
 *  Path-tracer kernels pass an explicit dispatchSize and reuse one ComputeNode
 *  for several targets — they have to compile synchronously. */
function withGiSyncCompute(renderer, fn) {
  const backend = renderer?.backend;
  if (!backend) return fn();
  const prev = backend.__giSyncCompute;
  backend.__giSyncCompute = true;
  try {
    return fn();
  } finally {
    backend.__giSyncCompute = prev;
  }
}

function parkNonWorldMeshes(scene) {
  const list = [];
  scene.traverse((object) => {
    if (shouldPark(object)) list.push(object);
  });
  const parked = [];
  for (const object of list) {
    if (!object.parent) continue;
    parked.push({ object, parent: object.parent });
    object.parent.remove(object);
  }
  return parked;
}

function restoreParked(parked) {
  for (const { object, parent } of parked) {
    if (object.parent !== parent) parent.add(object);
  }
}

function revealHiddenWorldMeshes(scene) {
  const revealed = [];
  scene.traverse((object) => {
    if (object.visible !== false) return;
    const data = object.userData ?? {};
    if (data.cameraHidden || data.mergedInto || data.batchedInto) {
      object.visible = true;
      revealed.push(object);
    }
  });
  return revealed;
}

function cameraSignature(camera) {
  if (!camera) return "";
  const m = camera.matrixWorld.elements;
  const p = camera.projectionMatrix.elements;
  return `${m[12].toFixed(4)},${m[13].toFixed(4)},${m[14].toFixed(4)},${m[0].toFixed(5)},${m[5].toFixed(5)},${m[10].toFixed(5)}:${p[0].toFixed(5)},${p[5].toFixed(5)},${p[10].toFixed(5)}`;
}

function sceneSignature(scene) {
  let count = 0;
  let hash = 0;
  scene.traverse((object) => {
    if (!object.isMesh || shouldPark(object)) return;
    count += 1;
    hash = (hash * 31 + (object.id | 0)) | 0;
    const geometry = object.geometry;
    if (geometry) {
      hash = (hash * 31 + (geometry.id | 0)) | 0;
      hash = (hash * 31 + (geometry.attributes?.position?.version | 0)) | 0;
    }
  });
  return `${count}:${hash}`;
}

function lightsSignature(scene) {
  let out = "";
  scene.traverse((object) => {
    if (
      object.isRectAreaLight ||
      object.isSpotLight ||
      object.isPointLight ||
      object.isDirectionalLight
    ) {
      out += `${object.id}:${object.intensity}:${object.color?.getHex?.() ?? 0}:`;
      out += `${object.position.x.toFixed(3)},${object.position.y.toFixed(3)},${object.position.z.toFixed(3)};`;
    }
  });
  return out;
}

function environmentSignature(scene) {
  const env = scene.environment;
  const background = scene.background;
  const bg = background?.isColor
    ? background.getHex()
    : (background?.uuid ?? "");
  return `${env?.uuid ?? ""}:${scene.environmentIntensity ?? 1}:${bg}:${scene.backgroundIntensity ?? 1}:${scene.backgroundBlurriness ?? 0}`;
}

/** Keep the ground-truth debug blit on the same display transform as the
 * raster viewport. WebGPUPathTracer owns a tone-mapping node on its blit
 * material; leaving its NoToneMapping default in place makes identical linear
 * radiance look brighter and more saturated than the GI frame. */
export function syncPathTracerDisplayTransform(tracer, renderer) {
  const material = tracer?._blitQuad?.material;
  if (!material || !renderer) return false;
  let changed = false;
  if (material.toneMapping !== renderer.toneMapping) {
    material.toneMapping = renderer.toneMapping;
    changed = true;
  }
  const exposure = Number(renderer.toneMappingExposure);
  if (Number.isFinite(exposure) && material.exposure !== exposure) {
    material.exposure = exposure;
    changed = true;
  }
  return changed;
}

export class GiPathTracerView {
  constructor(engine) {
    this.engine = engine;
    this.wanted = false;
    this._tracer = null;
    this._importing = null;
    this._failed = false;
    this._lastError = null;
    this._enabledLogged = false;
    this._sceneSig = "";
    this._cameraSig = "";
    this._lightsSig = "";
    this._envSig = "";
    this._camera = null;
    this._dirtyScene = true;
    this._syncing = false;
  }

  get active() {
    return this.wanted && !!this._tracer;
  }

  markSceneDirty() {
    if (this._syncing) return;
    this._dirtyScene = true;
  }

  setActive(on) {
    const next = on === true;
    // A failed dynamic import (stale Vite dep hash) must not lock the view
    // forever — toggling off and on is the retry.
    if (next && !this.wanted) {
      this._failed = false;
      this._lastError = null;
    }
    this.wanted = next;
    if (!this.wanted) {
      if (this._tracer) this._tracer.pause = true;
      return;
    }
    if (this._failed) return;
    if (!this._tracer) this.#ensure();
    else this._tracer.pause = false;
  }

  /** Blit one sample over the just-drawn GI frame. No-op while inactive. */
  tick() {
    if (!this.wanted || this._failed) return;
    const tracer = this._tracer;
    if (!tracer) return;
    const engine = this.engine;
    const renderer = engine?.renderer;
    const scene = engine?.scene;
    const camera = engine?.camera;
    if (!renderer || !scene || !camera) return;
    try {
      withGiSyncCompute(renderer, () => {
        this.#sync(tracer, scene, camera);
        syncPathTracerDisplayTransform(tracer, renderer);
        tracer.pause = false;
        tracer.renderSample();
      });
    } catch (error) {
      this.#fail(error);
    }
  }

  invalidate() {
    this._tracer?.dispose?.();
    this._tracer = null;
    this._importing = null;
    this._sceneSig = "";
    this._cameraSig = "";
    this._lightsSig = "";
    this._envSig = "";
    this._camera = null;
    this._dirtyScene = true;
    this._syncing = false;
  }

  dispose() {
    this.wanted = false;
    this.invalidate();
  }

  #ensure() {
    if (this._importing || this._tracer || this._failed) return;
    this._importing = import("./pathtracerEntry.js")
      .then(({ WebGPUPathTracer }) => {
        this._importing = null;
        if (!this.wanted || this._failed) return;
        const renderer = this.engine?.renderer;
        if (!renderer) return;
        const tracer = withGiSyncCompute(renderer, () => new WebGPUPathTracer(renderer));
        syncPathTracerDisplayTransform(tracer, renderer);
        // Off: setCommonAttributes walks Line/LineSegments too and crashes on
        // empty BufferGeometry. World meshes already carry normals/uvs.
        tracer.generateMissingAttributes = false;
        // An unfinished fade is a transparent blit over the raster GI frame —
        // the "diagonal of bright untraced materials" the debug view showed.
        tracer.synchronizeRenderSize = true;
        tracer.dynamicLowRes = false;
        tracer.minSamples = 0;
        tracer.renderDelay = 0;
        tracer.fadeDuration = 0;
        tracer.pause = false;
        const scale = Number(globalThis.__giPathTracerScale);
        if (Number.isFinite(scale) && scale > 0) tracer.renderScale = scale;
        const bounces = Number(globalThis.__giPathTracerBounces);
        if (Number.isFinite(bounces) && bounces >= 1) tracer.bounces = bounces;
        this._tracer = tracer;
        this._dirtyScene = true;
        globalThis.__giPathTracer = tracer;
        if (!this._enabledLogged) {
          this._enabledLogged = true;
          console.log(
            "[gi] debug view \"path-tracer\": three-gpu-pathtracer (WebGPU). " +
            "The viewport is the path-traced image; toggle Debug View off to return to GI. " +
            "Orbiting the camera resets accumulation. " +
            "`__giPathTracerScale` / `__giPathTracerBounces` override resolution and bounce count.",
          );
        }
      })
      .catch((error) => {
        this._importing = null;
        this.#fail(error);
      });
  }

  #sync(tracer, scene, camera) {
    if (this._dirtyScene || this._camera !== camera) {
      this.#setScene(tracer, scene, camera);
      return;
    }
    const nextScene = sceneSignature(scene);
    if (nextScene !== this._sceneSig) {
      this.#setScene(tracer, scene, camera);
      return;
    }
    const nextCamera = cameraSignature(camera);
    if (nextCamera !== this._cameraSig) {
      camera.updateMatrixWorld();
      tracer.updateCamera();
      this._cameraSig = nextCamera;
    }
    const nextLights = lightsSignature(scene);
    if (nextLights !== this._lightsSig) {
      tracer.updateLights();
      this._lightsSig = nextLights;
    }
    const nextEnv = environmentSignature(scene);
    if (nextEnv !== this._envSig) {
      tracer.updateEnvironment();
      this._envSig = nextEnv;
    }
  }

  #setScene(tracer, scene, camera) {
    this._syncing = true;
    const parked = parkNonWorldMeshes(scene);
    const revealed = revealHiddenWorldMeshes(scene);
    const stamps = stampSceneMaterials(scene);
    try {
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      withGiSyncCompute(this.engine?.renderer, () => tracer.setScene(scene, camera));
      this._sceneSig = sceneSignature(scene);
      this._cameraSig = cameraSignature(camera);
      this._lightsSig = lightsSignature(scene);
      this._envSig = environmentSignature(scene);
      this._camera = camera;
      this._dirtyScene = false;
    } finally {
      restoreSceneMaterials(stamps);
      for (const object of revealed) object.visible = false;
      restoreParked(parked);
      this._syncing = false;
    }
  }

  #fail(error) {
    if (this._failed) return;
    this._failed = true;
    this._lastError = error?.message ?? String(error);
    this.invalidate();
    console.warn(
      `[gi] debug view "path-tracer" failed: ${error?.message ?? error}. ` +
      "The rasterized GI frame is left on screen.",
    );
  }
}
