import test from "node:test";
import assert from "node:assert/strict";
import { rewriteComponentAssets, rewriteVfxGraphAssets } from "../src/editor/build/assetRefs.js";
import { createAssetNames } from "../src/editor/build/assetNames.js";

test("built-in Water material remains a runtime identifier without a disk asset claim", () => {
  const component = { type: "mesh", props: { material: "builtin:Water.mat" } };
  const unexpected = () => assert.fail("Built-in material must not be copied from disk");
  rewriteComponentAssets(component, { getSchema: () => [{ key: "material", type: "asset" }], claim: unexpected, claimDoc: unexpected, add: unexpected });
  assert.equal(component.props.material, "builtin:Water.mat");
});

test("shared VFX documents are re-emitted and inline fallback graph assets also ship", () => {
  const names = createAssetNames();
  const docs = [];
  const component = { type: "particles", props: { asset: "C:/project/Fire.vfx", graph: { nodes: [
    { id: "system", type: "system", props: { texture: "C:/project/fire.png", geometry: "sphere", capacity: 2000 } },
  ] } } };
  rewriteComponentAssets(component, {
    getSchema: () => [{ key: "asset", type: "asset" }],
    claim: (p) => names.claim(p), claimDoc: (p) => names.claimGenerated(p), add: (kind, path) => docs.push([kind, path]),
  });
  assert.deepEqual(docs, [["vfx", "C:/project/Fire.vfx"]]);
  assert.equal(component.props.asset, "assets/Fire.vfx");
  assert.equal(component.props.graph.nodes[0].props.texture, "assets/fire.png");
  assert.equal(component.props.graph.nodes[0].props.geometry, "sphere");
});

test("VFX mesh and sprite dependencies get collision-safe exported paths", () => {
  const names = createAssetNames();
  const graph = { nodes: [
    { id: "emitter", type: "emitMesh", props: { path: "C:/project/a/shape.glb" } },
    { id: "sys", type: "system", enabled: false, props: { geometry: "C:/project/b/shape.glb", texture: "C:/project/sprite.png", size: .5 } },
  ], edges: [] };
  rewriteVfxGraphAssets(graph, (p) => names.claim(p));
  assert.notEqual(graph.nodes[0].props.path, graph.nodes[1].props.geometry);
  for (const p of [graph.nodes[0].props.path, graph.nodes[1].props.geometry, graph.nodes[1].props.texture]) assert.ok(p.startsWith("assets/"));
  assert.equal(graph.nodes[1].enabled, false);
  assert.equal(graph.nodes[1].props.size, .5);
  assert.equal(names.copyEntries().length, 3);
});
