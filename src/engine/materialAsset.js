import * as THREE from "three/webgpu";
import { fract, interleavedGradientNoise, screenCoordinate, viewportDepthTexture } from "three/tsl";
import { resolveAssetUrl } from "./assetResolver.js";
import { migrateLegacyGraph } from "./shaderGraph.js";
import { compileShaderGraph, migrateGraph } from "./tslGraph.js";
import { loadTextureAsset } from "./textureAsset.js";

export const MATERIAL_DEFAULTS = {
  color: "#ffffff",
  roughness: 0.7,
  metalness: 0,
  map: "",
  shaderGraph: null,
};

let defaultMaterial = null;

/** Shared plain-white physical material used by every mesh without a .mat assigned. */
export function getDefaultMaterial() {
  if (!defaultMaterial) {
    defaultMaterial = new THREE.MeshPhysicalNodeMaterial({
      color: new THREE.Color(MATERIAL_DEFAULTS.color),
      roughness: MATERIAL_DEFAULTS.roughness,
      metalness: MATERIAL_DEFAULTS.metalness,
    });
  }
  return defaultMaterial;
}

// Asset paths arrive from two sources on Windows: paths written into imported
// prefab JSON use forward slashes, while paths returned by the filesystem use
// backslashes. They identify the same file and must share one live material
// instance; otherwise the mesh and Shader Graph editor mutate separate cache
// entries with no error. Keep the original casing (portable projects may be
// opened on a case-sensitive filesystem), but canonicalise separators.
const assetKey = (path) => String(path ?? "").replaceAll("\\", "/");

const cache = new Map(); // canonical path -> { path, material, def, generation, migrated, isVolume, renderable }

// Meshes referencing a .mat subscribe here so they can react when its material
// *instance* is swapped (surface ↔ volume) or its renderable state flips
// (nothing wired → hidden). In-place edits mutate the shared instance and need
// no notification; only identity/visibility changes do.
const subscribers = new Map(); // path -> Set<() => void>

/** Subscribe to material changes for `path`; returns an unsubscribe fn. */
export function subscribeMaterial(path, cb) {
  const key = assetKey(path);
  let set = subscribers.get(key);
  if (!set) subscribers.set(key, (set = new Set()));
  set.add(cb);
  return () => set.delete(cb);
}

function notifyMaterial(path) {
  const set = path && subscribers.get(assetKey(path));
  if (!set) return;
  for (const cb of set) {
    try { cb(); } catch (err) { console.error(`Material subscriber for "${path}": ${err.message}`); }
  }
}

/** A material renders when it has no shader graph (plain scalar material), or
 *  when its graph wires something into the Output's Surface or Volume socket.
 *  A graph whose Output has neither wired is invisible (Blender parity). */
function computeRenderable(graph) {
  const hasOutput = !!graph?.nodes?.some((n) => n.type === "output");
  if (!hasOutput) return true;
  const { hasSurface, hasVolume } = graphOutputState(graph);
  return hasSurface || hasVolume;
}

/** All material `*Node` slots a shader graph may populate on a
 *  MeshPhysicalNodeMaterial. Cleared on every apply. */
const NODE_SLOTS = [
  "colorNode",
  "roughnessNode",
  "metalnessNode",
  "emissiveNode",
  "opacityNode",
  "iorNode",
  "specularIntensityNode",
  "specularColorNode",
  "anisotropyNode",
  "sheenNode",
  "sheenRoughnessNode",
  "clearcoatNode",
  "clearcoatRoughnessNode",
  "transmissionNode",
  "thicknessNode",
  "normalNode",
  "aoNode",
  "positionNode",
];

function clearNodeSlots(material) {
  for (const slot of NODE_SLOTS) material[slot] = null;
}

/** Apply a compiled graph result to a live material — the single source of
 *  truth used by both the asset-load path (`applyMaterialDef`) and the live
 *  ShaderGraph editor. For a volume material the compiled Volume socket yields
 *  a `__volume` bundle that drives the VolumeNodeMaterial's built-in
 *  raymarching lighting model (density scattering, self-emission, step count);
 *  for a surface material the mutations map straight onto the `*Node` slots.
 *
 *  The `positionRay` the model hands the callbacks is world-space; the bundle's
 *  own `scattering`/`emissive` closures transform it back to the local box. */
export function applyGraphMutations(material, result, wantVolume) {
  const mutations = result?.mutations ?? {};
  if (wantVolume) {
    const v = mutations.__volume ?? null;
    material.scatteringNode = v?.scattering ? ({ positionRay }) => v.scattering(positionRay) : null;
    material.scatteringEmissiveNode = v?.emissive ? ({ positionRay }) => v.emissive(positionRay) : null;
    if (v?.steps != null) material.steps = v.steps;
    // `scatteringNode`/`scatteringEmissiveNode` are plain functions the lighting
    // model consumes — they are NOT part of three's material cache key (an
    // arrow's source text is identical every recompile, only its captured
    // closure differs). So `needsUpdate` alone re-uses the stale compiled
    // program until the render context changes on its own (which is why edits
    // only appeared after entering Play — the camera swap forced a rebuild).
    // Disposing evicts the cached node program so the next render rebuilds it
    // with the new closures, making graph edits show immediately.
    if (material.isVolumeNodeMaterial) material.dispose();
  } else {
    for (const slot of NODE_SLOTS) material[slot] = null;
    for (const [slot, node] of Object.entries(mutations)) {
      if (node == null || slot === "__volume") continue;
      material[slot] = node;
    }
  }
  material.needsUpdate = true;
}

/** Inspect the graph and return the wiring state of the Material Output. */
function graphOutputState(graph) {
  if (!graph?.nodes) return { hasSurface: false, hasVolume: false };
  const output = graph.nodes.find((n) => n.type === "output");
  if (!output) return { hasSurface: false, hasVolume: false };
  const edges = graph.edges ?? [];
  let hasSurface = false;
  let hasVolume = false;
  for (const e of edges) {
    if (e.target !== output.id) continue;
    if (e.targetHandle === "volume") hasVolume = true;
    else hasSurface = true;
  }
  return { hasSurface, hasVolume };
}

/** True when the graph wires anything into the Output's `Volume` socket —
 *  in that case the material is a `VolumeNodeMaterial` and only the
 *  `scatteringNode` slot is populated. */
function graphHasVolume(graph) {
  return graphOutputState(graph).hasVolume;
}

/** Create a fresh material instance sized for the def's intent. The caller
 *  must attach it to `entry.material` so the cache stays consistent. */
function createMaterialFor(def) {
  if (graphHasVolume(def.shaderGraph)) {
    const mat = new THREE.VolumeNodeMaterial();
    mat.userData.isVolumeMaterial = true;
    // Additive so light scattering / emission reads as glow (matches three's
    // volume-lighting example); the model already applies transmittance.
    mat.blending = THREE.AdditiveBlending;
    // Dither the ray start per pixel to hide banding at low step counts.
    mat.offsetNode = fract(interleavedGradientNoise(screenCoordinate));
    // Depth occlusion: the lighting model clips scattering behind opaque
    // geometry using `depthNode`. `viewportDepthTexture()` snapshots the
    // already-rendered opaque depth into its own texture right before this
    // (transparent) material draws — no extra scene render, so it doesn't
    // fight the main pass over shadow maps / the depth attachment the way a
    // standalone depthPass does in a plain (non-PostProcessing) render loop.
    mat.depthNode = viewportDepthTexture();
    return mat;
  }
  return new THREE.MeshPhysicalNodeMaterial();
}

export function applyMaterialDef(entry, def) {
  // If the new def switches the material kind (surface ↔ volume), swap the
  // underlying instance so the new type's slots are clean.
  const wantVolume = graphHasVolume(def.shaderGraph);
  if (entry.material && !!entry.isVolume !== wantVolume) {
    entry.material = createMaterialFor(def);
    entry.migrated = false;
  } else if (!entry.material) {
    entry.material = createMaterialFor(def);
  }
  entry.isVolume = wantVolume;
  entry.renderable = computeRenderable(def.shaderGraph);
  const { material } = entry;
  const generation = (entry.generation = (entry.generation ?? 0) + 1);
  entry.def = def;

  if (!wantVolume) {
    material.color.set(def.color ?? MATERIAL_DEFAULTS.color);
    material.roughness = def.roughness ?? MATERIAL_DEFAULTS.roughness;
    material.metalness = def.metalness ?? MATERIAL_DEFAULTS.metalness;
    if (def.map) {
      loadTextureAsset(def.map, { colorSpace: THREE.SRGBColorSpace })
        .then((texture) => {
          if (generation !== entry.generation) return;
          material.map = texture;
          material.needsUpdate = true;
        })
        .catch((err) => console.error(`Material texture "${def.map}": ${err.message}`));
    } else {
      material.map = null;
    }
  }

  // Start each apply from a clean slate of *Node slots — otherwise an old
  // graph leaving a slot populated would leak into the new graph's compile.
  clearNodeSlots(material);

  if (def.shaderGraph) {
    // Two-step migration: v0 color-output → BSDF (legacy), then BSDF → slot Output.
    const graph = entry.migrated ? def.shaderGraph : migrateGraph(migrateLegacyGraph(def.shaderGraph, def));
    entry.migrated = true;
    compileShaderGraph(graph)
      .then((result) => {
        if (generation !== entry.generation) return;
        if (!result) return;
        applyGraphMutations(material, result, wantVolume);
      })
      .catch((err) => console.error(`Material shader graph: ${err.message}`));
  }
  material.needsUpdate = true;
  // Instance identity and renderable state are known synchronously — tell
  // subscribed meshes to (re)adopt the instance and update visibility.
  notifyMaterial(entry.path);
}

/** Returns the shared material for a .mat path, loading its def on first use. */
export async function loadMaterialAsset(path) {
  const key = assetKey(path);
  let entry = cache.get(key);
  if (!entry) {
    // Provisional def (surface). `applyMaterialDef` will swap to a volume
    // material once the file is fetched and parsed.
    entry = { path: key, material: new THREE.MeshPhysicalNodeMaterial(), def: { ...MATERIAL_DEFAULTS }, isVolume: false, renderable: true, migrated: false };
    cache.set(key, entry);
    try {
      const url = await resolveAssetUrl(path);
      const def = await (await fetch(url)).json();
      applyMaterialDef(entry, { ...MATERIAL_DEFAULTS, ...def });
    } catch (err) {
      console.error(`Failed to load material "${path}": ${err.message}`);
    }
  }
  return entry.material;
}

/** True if the .mat asset at `path` resolves to a `VolumeNodeMaterial`. The
 *  editor uses this to flag / convert meshes that point at a volume .mat. */
export function isVolumeMaterial(path) {
  return cache.get(assetKey(path))?.isVolume === true;
}

/** The current shared material instance for `path` (may change on surface ↔
 *  volume swaps — subscribers re-read it via `subscribeMaterial`). */
export function getMaterialInstance(path) {
  return cache.get(assetKey(path))?.material ?? null;
}

/** False when the .mat's graph has an Output with nothing wired to Surface or
 *  Volume — such a mesh must not render (Blender parity). Defaults to true. */
export function isMaterialRenderable(path) {
  const entry = cache.get(assetKey(path));
  return entry ? entry.renderable !== false : true;
}

/** In-place graph edit (no class change): refresh renderable state from the
 *  new graph and notify meshes so visibility tracks Surface/Volume wiring
 *  without a full recompile. The ShaderGraphPanel calls this after applying a
 *  live edit to the shared instance. */
export function syncMaterialRenderState(path, graph) {
  const entry = cache.get(assetKey(path));
  if (!entry) return;
  if (entry.def) entry.def.shaderGraph = graph;
  entry.renderable = computeRenderable(graph);
  notifyMaterial(path);
}

/** Editor hooks: read the cached def / push edits into the live shared material. */
export function getMaterialDef(path) {
  return cache.get(assetKey(path))?.def ?? null;
}

export function updateMaterialAsset(path, def) {
  const entry = cache.get(assetKey(path));
  if (entry) applyMaterialDef(entry, def);
}

/** Re-applies materials referencing a texture (after its .meta changed). */
export function refreshMaterialsUsingTexture(texPath) {
  const key = assetKey(texPath);
  for (const entry of cache.values()) {
    if (assetKey(entry.def?.map) === key) applyMaterialDef(entry, entry.def);
  }
}

/** Re-resolves texture variants after the Basis module is toggled. */
export function refreshAllMaterials() {
  for (const entry of cache.values()) applyMaterialDef(entry, entry.def);
}
