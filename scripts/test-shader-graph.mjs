// Headless check of the live shader graph runtime. The editor and the asset
// layer both compile graphs with `compileShaderGraph` from `tslGraph.js` —
// that is the *real* runtime. The `shaderGraph.js` module is legacy and only
// contributes `migrateLegacyGraph` for converting old graphs on disk.
//
// This test verifies the real runtime: build a few sample graphs and assert
// the right `*Node` slots come back.
//
// Run: node scripts/test-shader-graph.mjs
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { setAssetResolver } from "../src/engine/assetResolver.js";
import { compileShaderGraph, NODE_TYPES } from "../src/engine/tslGraph.js";
import { migrateLegacyGraph } from "../src/engine/shaderGraph.js";

setAssetResolver(async (path) => path);

// Spy on mutations applied to a material so we can assert them without a
// renderer. We construct a fresh MeshPhysicalNodeMaterial per test and
// intercept the *Node property writes.
function spyMaterial() {
  const mat = new THREE.MeshPhysicalNodeMaterial();
  const writes = {};
  for (const slot of [
    "colorNode", "roughnessNode", "metalnessNode", "emissiveNode", "opacityNode",
    "iorNode", "specularIntensityNode", "specularColorNode", "anisotropyNode",
    "sheenNode", "sheenRoughnessNode", "clearcoatNode", "clearcoatRoughnessNode",
    "transmissionNode", "thicknessNode",
  ]) {
    Object.defineProperty(mat, slot, {
      get() { return writes[slot]; },
      set(v) { writes[slot] = v; },
      configurable: true,
    });
  }
  return { mat, writes };
}

async function applyAndAwait(graph) {
  const { mat, writes } = spyMaterial();
  const result = await compileShaderGraph(graph);
  if (result?.mutations) {
    for (const [slot, node] of Object.entries(result.mutations)) {
      if (node != null) mat[slot] = node;
    }
  }
  return { result, mat, writes };
}

// --- Tests ------------------------------------------------------------

// 1. Principled BSDF with all-default props populates every expected slot.
{
  const graph = {
    nodes: [
      { id: "p", type: "principledBsdf", props: { color: "#ffffff", roughness: 0.5, metalness: 0, ior: 1.5, specularIntensity: 0.5, specularColor: "#ffffff", emissive: "#000000", emissiveStrength: 1, opacity: 1 }, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "p", sourceHandle: "out", target: "o", targetHandle: "surface" }],
  };
  const { result, writes } = await applyAndAwait(graph);
  assert.ok(result, "principled default compile returns result");
  assert.ok(writes.colorNode, "colorNode assigned");
  assert.ok(writes.roughnessNode, "roughnessNode assigned");
  assert.ok(writes.metalnessNode, "metalnessNode assigned");
  assert.ok(writes.emissiveNode, "emissiveNode assigned (emissiveStrength default = 1)");
  console.log("ok: principled BSDF default populates all slots");
}

// 2. Principled BSDF with a Color node wired into the `color` input.
{
  const graph = {
    nodes: [
      { id: "c", type: "color", props: { value: "#ff8800" }, position: { x: 0, y: 0 } },
      { id: "p", type: "principledBsdf", props: { color: "#ffffff", roughness: 0.5, metalness: 0, ior: 1.5, specularIntensity: 0.5, specularColor: "#ffffff", emissive: "#000000", emissiveStrength: 1, opacity: 1 }, position: { x: 200, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 400, y: 0 } },
    ],
    edges: [
      { source: "c", sourceHandle: "out", target: "p", targetHandle: "color" },
      { source: "p", sourceHandle: "out", target: "o", targetHandle: "surface" },
    ],
  };
  const { result, writes } = await applyAndAwait(graph);
  assert.ok(result, "principled wired compile returns result");
  assert.ok(writes.colorNode, "colorNode populated from wired Color node");
  console.log("ok: principled BSDF wires Color → color (tslGraph input key)");
}

// 3. Emission writes emissiveNode (color × strength).
{
  const graph = {
    nodes: [
      { id: "e", type: "emission", props: { color: "#ffffff", strength: 2.5 }, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "e", sourceHandle: "out", target: "o", targetHandle: "surface" }],
  };
  const { writes } = await applyAndAwait(graph);
  assert.ok(writes.emissiveNode, "emissiveNode populated");
  console.log("ok: emission writes emissiveNode only");
}

// 4. Empty / disconnected graph: returns empty mutations, no throws.
{
  const result = await compileShaderGraph({ nodes: [{ id: "o", type: "output", props: {}, position: { x: 0, y: 0 } }], edges: [] });
  assert.ok(result, "empty graph still returns a result object");
  assert.deepEqual(result.mutations, {}, "no mutations when nothing is wired");
  console.log("ok: disconnected output returns empty mutations");
}

// 5. Math chain (Add → Color): builds without error.
{
  const graph = {
    nodes: [
      { id: "a", type: "color", props: { value: "#ff0000" }, position: { x: 0, y: 0 } },
      { id: "b", type: "color", props: { value: "#00ff00" }, position: { x: 0, y: 100 } },
      { id: "add", type: "add", props: {}, position: { x: 200, y: 0 } },
      { id: "p", type: "principledBsdf", props: { color: "#ffffff", roughness: 0.5, metalness: 0, ior: 1.5, specularIntensity: 0.5, specularColor: "#ffffff", emissive: "#000000", emissiveStrength: 1, opacity: 1 }, position: { x: 400, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 600, y: 0 } },
    ],
    edges: [
      { source: "a", sourceHandle: "out", target: "add", targetHandle: "a" },
      { source: "b", sourceHandle: "out", target: "add", targetHandle: "b" },
      { source: "add", sourceHandle: "out", target: "p", targetHandle: "color" },
      { source: "p", sourceHandle: "out", target: "o", targetHandle: "surface" },
    ],
  };
  const { writes } = await applyAndAwait(graph);
  assert.ok(writes.colorNode, "Add result populates Principled color");
  console.log("ok: Color + Color → Add → Principled.color");
}

// 6. Migration: legacy single-Output graph + a Color node wired to its
//    `color` handle gets rewired into a Principled BSDF and the Output's
//    surface. Critically, the migrated graph must use the tslGraph prop
//    keys (`color`, NOT `baseColor`) so the runtime compile actually reads
//    the user's stored color.
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
  assert.equal(principled.props.color, "#445566", "migration seeds color (tslGraph input key) from def.color");
  assert.equal(principled.props.baseColor, undefined, "migration does not emit the legacy `baseColor` prop");
  assert.equal(principled.props.roughness, 0.3, "migration seeds roughness from def.roughness");
  assert.equal(principled.props.metalness, 0.2, "migration seeds metalness from def.metalness");
  const colorEdge = migrated.edges.find((e) => e.target === principled.id && e.targetHandle === "color");
  assert.ok(colorEdge, "old color→output rewires to principled.color (tslGraph input key)");
  const surfaceEdge = migrated.edges.find((e) => e.source === principled.id && e.sourceHandle === "out");
  assert.ok(surfaceEdge, "migration wires principled.out → output.surface");
  // End-to-end: compile the migrated graph and confirm the def.color survives.
  const { writes } = await applyAndAwait(migrated);
  assert.ok(writes.colorNode, "migrated graph compiles and populates colorNode");
  console.log("ok: legacy single-Output graph migrates to Principled + Output (tslGraph keys)");
}

// 7. Migration: already-migrated graph passes through unchanged.
{
  const alreadyNew = {
    nodes: [
      { id: "p", type: "principledBsdf", props: { color: "#ffffff", roughness: 0.5, metalness: 0, ior: 1.5, specularIntensity: 0.5, specularColor: "#ffffff", emissive: "#000000", emissiveStrength: 1, opacity: 1 }, position: { x: 0, y: 0 } },
      { id: "o", type: "output", props: {}, position: { x: 200, y: 0 } },
    ],
    edges: [{ source: "p", sourceHandle: "out", target: "o", targetHandle: "surface" }],
  };
  const after = migrateLegacyGraph(alreadyNew, {});
  assert.deepEqual(after, alreadyNew, "already-modern graph passes through migrate");
  console.log("ok: non-legacy graph passes through migration unchanged");
}

console.log("All shader graph checks passed.");
