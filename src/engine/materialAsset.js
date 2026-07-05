import * as THREE from "three/webgpu";
import { resolveAssetUrl, loadAssetMeta } from "./assetResolver.js";
import { compileShaderGraph, migrateLegacyGraph } from "./shaderGraph.js";
import { applyTextureMeta } from "./textureMeta.js";

/**
 * Material assets: a .mat file is JSON ({ color, roughness, metalness, map,
 * shaderGraph }) loaded into ONE shared MeshPhysicalNodeMaterial instance per
 * path — every mesh referencing the same .mat renders with the same instance,
 * so editing it updates all of them at once. Shared materials are never
 * disposed by components.
 *
 * MeshPhysicalNodeMaterial (rather than MeshStandard) so the Principled BSDF
 * can drive clearcoat / sheen / transmission / ior etc. The standard props
 * still work — the `*Node` slots only take effect when populated.
 */
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

const cache = new Map(); // path -> { material, def, generation, migrated }
const textureLoader = new THREE.TextureLoader();

/** All material `*Node` slots a shader graph may populate. Cleared on every apply. */
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
];

function clearNodeSlots(material) {
  for (const slot of NODE_SLOTS) material[slot] = null;
}

export function applyMaterialDef(entry, def) {
  const { material } = entry;
  const generation = (entry.generation = (entry.generation ?? 0) + 1);
  entry.def = def;
  material.color.set(def.color ?? MATERIAL_DEFAULTS.color);
  material.roughness = def.roughness ?? MATERIAL_DEFAULTS.roughness;
  material.metalness = def.metalness ?? MATERIAL_DEFAULTS.metalness;
  if (def.map) {
    Promise.all([
      resolveAssetUrl(def.map).then((url) => textureLoader.loadAsync(url)),
      loadAssetMeta(`${def.map}.meta`),
    ])
      .then(([texture, meta]) => {
        if (generation !== entry.generation) return;
        texture.colorSpace = THREE.SRGBColorSpace;
        applyTextureMeta(texture, meta);
        material.map = texture;
        material.needsUpdate = true;
      })
      .catch((err) => console.error(`Material texture "${def.map}": ${err.message}`));
  } else {
    material.map = null;
  }

  // Start each apply from a clean slate of *Node slots — otherwise an old graph
  // leaving a slot populated would leak into the new graph's compile.
  clearNodeSlots(material);

  if (def.shaderGraph) {
    const graph = entry.migrated ? def.shaderGraph : migrateLegacyGraph(def.shaderGraph, def);
    entry.migrated = true;
    compileShaderGraph(graph)
      .then((result) => {
        if (generation !== entry.generation) return;
        if (!result) return;
        for (const [slot, node] of Object.entries(result.mutations ?? {})) {
          if (node == null) continue;
          material[slot] = node;
        }
        material.needsUpdate = true;
      })
      .catch((err) => console.error(`Material shader graph: ${err.message}`));
  }
  material.needsUpdate = true;
}

/** Returns the shared material for a .mat path, loading its def on first use. */
export async function loadMaterialAsset(path) {
  let entry = cache.get(path);
  if (!entry) {
    entry = { material: new THREE.MeshPhysicalNodeMaterial(), def: { ...MATERIAL_DEFAULTS } };
    cache.set(path, entry);
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

/** Editor hooks: read the cached def / push edits into the live shared material. */
export function getMaterialDef(path) {
  return cache.get(path)?.def ?? null;
}

export function updateMaterialAsset(path, def) {
  const entry = cache.get(path);
  if (entry) applyMaterialDef(entry, def);
}

/** Re-applies materials referencing a texture (after its .meta changed). */
export function refreshMaterialsUsingTexture(texPath) {
  for (const entry of cache.values()) {
    if (entry.def?.map === texPath) applyMaterialDef(entry, entry.def);
  }
}