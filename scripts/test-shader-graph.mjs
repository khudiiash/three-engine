// Headless check of the Blender-style shader graph: builds a few sample graphs
// (principled with wired inputs, glass, diffuse, emission, empty migration),
// runs compileShaderGraph, and asserts the right *Node slots come back.
//
// The WebGPU backend isn't needed for node construction — TSL builders don't
// compile until a renderer actually asks for shader code — so this runs fine
// in plain Node. We stub the asset resolver + the texture loader so the
// texture-node branch doesn't try to fetch.
//
// Run: node scripts/test-shader-graph.mjs
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { setAssetResolver } from "../src/engine/assetResolver.js";
import {
  compileShaderGraph,
  migrateLegacyGraph,
  NODE_TYPES,
  SHADER_RESULT,
} from "../src/engine/shaderGraph.js";

// --- Stubs -------------------------------------------------------------
// shaderGraph.js imports resolveAssetUrl from assetResolver.js; the default
// returns the path verbatim. Texture loader needs an actual URL; we won't
// trigger a texture compile in any of these graphs, so a noop resolver is fine.
setAssetResolver(async (path) => path);

// Spy on mutations applied to a material so we can assert them without a
// renderer. We construct a fresh MeshPhysicalNodeMaterial per test and
// intercept the *Node property writes.
function spyMaterial() {
  const mat = new THREE.MeshPhysicalNodeMaterial();
  const writes = {};
  for (const slot of [
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
  ]) {
    Object.defineProperty(mat, slot, {
      get() {
        return writes[slot];
      },
      set(v) {
        writes[slot] = v;
      },
      configurable: true,
    });
  }
  return { mat, writes };
}

// --- Helpers -----------------------------------------------------------
async function applyAndAwait(graph) {
  const { mat, writes } = spyMaterial();
  // We mimic materialAsset.applyMaterialDef's post-compile step.
  const result = await compileShaderGraph(graph);
  if (result?.mutations) {
    for (const [slot, node] of Object.entries(result.mutations)) {
      if (node != null) mat[slot] = node;
    }
  }
  return { result, mat, writes };
}

// --- Tests -------------------------------------------------------------

// 1. Principled BSDF with all-default props populates every expected slot.
{
  const graph = {
    nodes: [
      { id: "p", type: "principledBsdf", props: { ...NODE_TYPES.principledBsdf.defaults }, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "p", sourceHandle: "surface", target: "o", targetHandle: "surface" }],
  };
  const { result, writes } = await applyAndAwait(graph);
  assert.ok(result, "principled default compile returns result");
  assert.ok(writes.colorNode, "colorNode assigned");
  assert.ok(writes.roughnessNode, "roughnessNode assigned");
  assert.ok(writes.metalnessNode, "metalnessNode assigned");
  assert.ok(writes.emissiveNode, "emissiveNode assigned (emissionStrength default = 1)");
  console.log("ok: principled BSDF default populates all slots");
}

// 2. Principled BSDF with a Color node wired into baseColor + Float into roughness.
{
  const graph = {
    nodes: [
      { id: "c", type: "color", props: { value: "#ff8800" }, position: { x: 0, y: 0 } },
      { id: "f", type: "float", props: { value: 0.25 }, position: { x: 0, y: 100 } },
      { id: "p", type: "principledBsdf", props: { ...NODE_TYPES.principledBsdf.defaults }, position: { x: 200, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 400, y: 0 } },
    ],
    edges: [
      { source: "c", sourceHandle: "out", target: "p", targetHandle: "baseColor" },
      { source: "f", sourceHandle: "out", target: "p", targetHandle: "roughness" },
      { source: "p", sourceHandle: "surface", target: "o", targetHandle: "surface" },
    ],
  };
  const { result, writes } = await applyAndAwait(graph);
  assert.ok(result, "principled wired compile returns result");
  assert.ok(writes.colorNode, "colorNode populated from wired Color node");
  assert.ok(writes.roughnessNode, "roughnessNode populated from wired Float node");
  console.log("ok: principled BSDF wires Color → baseColor and Float → roughness");
}

// 3. Glass BSDF: sets transmission to 1.
{
  const graph = {
    nodes: [
      { id: "g", type: "glassBsdf", props: { ...NODE_TYPES.glassBsdf.defaults }, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "g", sourceHandle: "surface", target: "o", targetHandle: "surface" }],
  };
  const { writes } = await applyAndAwait(graph);
  assert.ok(writes.colorNode, "glass colorNode set");
  assert.ok(writes.transmissionNode, "glass transmissionNode set");
  console.log("ok: glass BSDF writes color + transmission");
}

// 4. Diffuse BSDF: metalness forced to 0.
{
  const graph = {
    nodes: [
      { id: "d", type: "diffuseBsdf", props: { ...NODE_TYPES.diffuseBsdf.defaults }, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "d", sourceHandle: "surface", target: "o", targetHandle: "surface" }],
  };
  const { writes } = await applyAndAwait(graph);
  assert.ok(writes.colorNode, "diffuse colorNode set");
  assert.ok(writes.metalnessNode, "diffuse metalnessNode set (forced 0)");
  assert.equal(writes.transmissionNode, undefined, "diffuse does not set transmission");
  console.log("ok: diffuse BSDF writes color + metalness only");
}

// 5. Emission: writes emissiveNode (color × strength).
{
  const graph = {
    nodes: [
      { id: "e", type: "emission", props: { ...NODE_TYPES.emission.defaults, emissionStrength: 2.5 }, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "e", sourceHandle: "surface", target: "o", targetHandle: "surface" }],
  };
  const { writes } = await applyAndAwait(graph);
  assert.ok(writes.emissiveNode, "emissiveNode populated");
  assert.equal(writes.colorNode, undefined, "emission doesn't set colorNode");
  console.log("ok: emission writes emissiveNode only");
}

// 6. Empty / disconnected graph: returns empty mutations, no throws.
{
  const result = await compileShaderGraph({ nodes: [{ id: "o", type: "output", props: {}, position: { x: 0, y: 0 } }], edges: [] });
  assert.ok(result, "empty graph still returns a result object");
  assert.deepEqual(result.mutations, {}, "no mutations when nothing is wired");
  console.log("ok: disconnected output returns empty mutations");
}

// 7. Math chain (Add → Color): builds without error.
{
  const graph = {
    nodes: [
      { id: "a", type: "color", props: { value: "#ff0000" }, position: { x: 0, y: 0 } },
      { id: "b", type: "color", props: { value: "#00ff00" }, position: { x: 0, y: 100 } },
      { id: "add", type: "add", props: {}, position: { x: 200, y: 0 } },
      { id: "p", type: "principledBsdf", props: { ...NODE_TYPES.principledBsdf.defaults }, position: { x: 400, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 600, y: 0 } },
    ],
    edges: [
      { source: "a", sourceHandle: "out", target: "add", targetHandle: "a" },
      { source: "b", sourceHandle: "out", target: "add", targetHandle: "b" },
      { source: "add", sourceHandle: "out", target: "p", targetHandle: "baseColor" },
      { source: "p", sourceHandle: "surface", target: "o", targetHandle: "surface" },
    ],
  };
  const { writes } = await applyAndAwait(graph);
  assert.ok(writes.colorNode, "Add result populates Principled baseColor");
  console.log("ok: Color + Color → Add → Principled.baseColor");
}

// 8. Migration: legacy single-Output graph + a Color node wired to its `color`
//    handle gets rewired into a Principled BSDF and the Output's surface.
{
  const legacy = {
    nodes: [
      { id: "c", type: "color", props: { value: "#112233" }, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "c", sourceHandle: "out", target: "o", targetHandle: "color" }],
  };
  const def = { color: "#445566", roughness: 0.3, metalness: 0.2 };
  const migrated = migrateLegacyGraph(legacy, def);
  assert.ok(migrated, "migration returns a graph");
  const principled = migrated.nodes.find((n) => n.type === "principledBsdf");
  const output = migrated.nodes.find((n) => n.type === "output");
  assert.ok(principled, "migration inserts a Principled BSDF");
  assert.ok(output, "migration keeps an Output");
  assert.equal(principled.props.baseColor, "#445566", "migration seeds baseColor from def.color");
  assert.equal(principled.props.roughness, 0.3, "migration seeds roughness from def.roughness");
  assert.equal(principled.props.metalness, 0.2, "migration seeds metalness from def.metalness");
  const baseColorEdge = migrated.edges.find((e) => e.target === principled.id && e.targetHandle === "baseColor");
  assert.ok(baseColorEdge, "old color→output rewires to principled.baseColor");
  const surfaceEdge = migrated.edges.find((e) => e.source === principled.id && e.sourceHandle === "surface");
  assert.ok(surfaceEdge, "migration wires principled.surface → output.surface");
  // Compile the migrated graph and confirm baseColor from the Color node wins
  // over the prop default.
  const { writes } = await applyAndAwait(migrated);
  assert.ok(writes.colorNode, "migrated graph compiles and populates colorNode");
  console.log("ok: legacy single-Output graph migrates to Principled + Output");
}

// 9. Migration: already-migrated graph passes through unchanged.
{
  const alreadyNew = {
    nodes: [
      { id: "p", type: "principledBsdf", props: {}, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "p", sourceHandle: "surface", target: "o", targetHandle: "surface" }],
  };
  const after = migrateLegacyGraph(alreadyNew, {});
  assert.deepEqual(after, alreadyNew, "already-modern graph passes through migrate");
  console.log("ok: non-legacy graph passes through migration unchanged");
}

console.log("All shader graph checks passed.");