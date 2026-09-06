import { test } from "node:test";
import assert from "node:assert/strict";
import { createVfxAsset, parseVfxAsset, serializeVfxAsset, loadVfxAsset, publishVfxAsset, bindVfxAsset, vfxRuntimeGraph } from "../src/engine/vfx/vfxAsset.js";
import { createSimulationGraph } from "../src/engine/vfx/simulationGraph.js";
import { DEFAULT_PARTICLE_GRAPH } from "../src/engine/particleGraph.js";
import { setAssetResolver } from "../src/engine/assetResolver.js";
import { ClothComponent } from "../src/engine/components/ClothComponent.js";
import { ParticleComponent } from "../src/engine/components/ParticleComponent.js";
import { Object3D, Mesh, PlaneGeometry, MeshStandardNodeMaterial } from "three/webgpu";

const doc = (kind = "cloth", width = 4) => createVfxAsset(kind, kind === "particles" ? DEFAULT_PARTICLE_GRAPH : createSimulationGraph(kind, { width }));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const attach = (component) => {
  const callbacks = new Set();
  component.entity = { id: "vfx-test", object3D: new Object3D(), engine: { onUpdate: (cb) => { callbacks.add(cb); return () => callbacks.delete(cb); } } };
  if (component.constructor.type === "cloth") {
    const mesh = new Mesh(new PlaneGeometry(3, 2), new MeshStandardNodeMaterial());
    component.entity.object3D.add(mesh);
    component.entity.getComponent = (type) => type === "mesh" ? { mesh, props: { geometry: "plane" } } : null;
  }
  component.onAttach();
  return callbacks;
};

test("live cloth instances rebuild independent storage on publication and preserve authored fallback", async () => {
  const graph = createSimulationGraph("cloth", { resolution: 4, width: 3 });
  publishVfxAsset("cloth-components.vfx", createVfxAsset("cloth", graph));
  const a = new ClothComponent({ asset: "cloth-components.vfx", graph }), b = new ClothComponent({ asset: "cloth-components.vfx", graph: structuredClone(graph) });
  const ticks = attach(a); attach(b);
  await settle();
  try {
    assert.notEqual(a.simulation, b.simulation);
    assert.notEqual(a.simulation.mesh.geometry, b.simulation.mesh.geometry);
    const original = a.simulation;
    publishVfxAsset("cloth-components.vfx", createVfxAsset("cloth", createSimulationGraph("cloth", { resolution: 8, width: 6 })));
    assert.notEqual(a.simulation, original);
    assert.equal(a.resolvedProps.width, 3, "plane dimensions override linked graph dimensions");
    assert.equal(b.resolvedProps.width, 3);
    assert.equal(a.resolvedProps.resolution, 8);
    assert.equal(a.props.graph.nodes[0].props.width, 3);
    assert.equal(ticks.size, 1);
    publishVfxAsset("cloth-components.vfx", doc("water"));
    assert.equal(a.resolvedProps.width, 3);
    assert.match(a.vfxAssetError, /Expected cloth/);
    a.setProp("asset", "");
    assert.equal(a.resolvedProps.width, 3);
    assert.equal(a.props.resolution, 4);
  } finally { a.onDetach(); b.onDetach(); }
  assert.equal(ticks.size, 0);
});

test("particle linked uniform changes retain buffers and unlink restores inline graph", async () => {
  const graph = structuredClone(DEFAULT_PARTICLE_GRAPH);
  const system = graph.nodes.find((n) => n.type === "system");
  system.props.capacity = 4;
  publishVfxAsset("particle-components.vfx", createVfxAsset("particles", graph));
  const component = new ParticleComponent({ asset: "particle-components.vfx", graph: structuredClone(graph) });
  const ticks = attach(component);
  await settle(); await settle();
  try {
    assert.ok(component.compiled);
    const subsystem = component.subsystems[0];
    const updated = structuredClone(graph);
    updated.nodes.find((n) => n.type === "system").props.lifetime = 6;
    publishVfxAsset("particle-components.vfx", createVfxAsset("particles", updated));
    assert.equal(component.subsystems[0], subsystem);
    assert.equal(component.effectiveGraph.nodes.find((n) => n.type === "system").props.lifetime, 6);
    component.setProp("asset", "");
    await settle();
    assert.equal(component.effectiveGraph, component.props.graph);
    assert.equal(ticks.size, 1);
  } finally { component.onDetach(); }
  assert.equal(ticks.size, 0);
});

test("VFX document round trips all kinds and preserves editor metadata without aliasing", () => {
  for (const kind of ["particles", "cloth", "water"]) {
    const asset = doc(kind);
    asset.graph.viewport = { x: 23, y: 42, zoom: .5 };
    asset.graph.nodes[0].selected = true;
    const restored = parseVfxAsset(serializeVfxAsset(asset));
    assert.deepEqual(restored, asset);
    restored.graph.nodes[0].selected = false;
    assert.equal(asset.graph.nodes[0].selected, true);
  }
});
test("particle runtime flattens authored reroutes without discarding saved helpers", () => {
  const asset = doc("particles"), original = asset.graph.edges[0];
  asset.graph.nodes.push({ id: "wire", type: "__reroute", position: { x: 1, y: 2 } });
  asset.graph.edges[0] = { ...original, source: "wire", sourceHandle: "out" };
  asset.graph.edges.push({ source: original.source, sourceHandle: original.sourceHandle, target: "wire", targetHandle: "in" });
  const saved = parseVfxAsset(asset);
  const runtime = vfxRuntimeGraph(saved.graph);
  assert.deepEqual(runtime.edges[0], original);
  assert.equal(runtime.nodes.some((node) => node.type === "__reroute"), false);
  assert.equal(saved.graph.nodes.some((node) => node.type === "__reroute"), true);
});
test("invalid versions, dangling wires, duplicate IDs and cycles fail before compilation", () => {
  assert.throws(() => parseVfxAsset({ ...doc(), version: 2 }), /version/);
  assert.throws(() => parseVfxAsset("{"));
  const dangling = doc(); dangling.graph.edges[0].source = "missing";
  assert.throws(() => parseVfxAsset(dangling), /dangling/);
  const duplicate = doc(); duplicate.graph.nodes.push(duplicate.graph.nodes[0]);
  assert.throws(() => parseVfxAsset(duplicate), /unique/);
  const cyclic = doc("particles"); cyclic.graph.edges.push({ source: cyclic.graph.nodes[0].id, target: cyclic.graph.nodes[0].id, targetHandle: "unused" });
  assert.throws(() => parseVfxAsset(cyclic), /cycle/);
  assert.throws(() => createVfxAsset("particles", { nodes: [], edges: [] }), /System/);
  const badHandle = doc("particles"); badHandle.graph.edges[0].sourceHandle = "missing";
  assert.throws(() => parseVfxAsset(badHandle), /handle/);
});
test("HTTP loader resolves player paths, falls back safely and publish wins in-flight fetch", async () => {
  const originalFetch = globalThis.fetch;
  let release;
  setAssetResolver(async (path) => `https://game.test/${path}`);
  globalThis.fetch = async (url) => {
    assert.ok(url.startsWith("https://game.test/"));
    if (url.endsWith("missing.vfx")) return { ok: false };
    if (url.endsWith("bad.vfx")) return { ok: true, json: async () => ({}) };
    return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => doc("cloth", 1) }); });
  };
  try {
    assert.equal(await loadVfxAsset("missing.vfx"), null);
    assert.equal(await loadVfxAsset("bad.vfx"), null);
    const loading = loadVfxAsset("racing.vfx");
    await settle();
    publishVfxAsset("racing.vfx", doc("cloth", 7));
    release();
    assert.equal((await loading).graph.nodes[0].props.width, 7);
    const copy = await loadVfxAsset("racing.vfx"); copy.graph.nodes[0].props.width = 99;
    assert.equal((await loadVfxAsset("racing.vfx")).graph.nodes[0].props.width, 7);
  } finally { globalThis.fetch = originalFetch; setAssetResolver(async (path) => path); }
});
test("component bindings isolate graphs, retain fallback, cancel stale loads and unsubscribe", async () => {
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => doc("cloth", 1) }); });
  const make = (asset) => ({ constructor: { type: "cloth" }, props: { asset, graph: createSimulationGraph("cloth", { width: 3 }) } });
  const a = make("slow.vfx"), b = make("shared.vfx");
  let changes = 0;
  try {
    bindVfxAsset(a, () => changes++);
    await settle();
    publishVfxAsset("shared.vfx", doc("cloth", 8));
    a.props.asset = "shared.vfx"; bindVfxAsset(a, () => changes++);
    bindVfxAsset(b, () => {});
    await settle(); release(); await settle();
    assert.equal(a._vfxAssetGraph.nodes[0].props.width, 8);
    assert.equal(a.props.graph.nodes[0].props.width, 3);
    assert.notEqual(a._vfxAssetGraph, b._vfxAssetGraph);
    publishVfxAsset("shared.vfx", doc("water"));
    assert.equal(a._vfxAssetGraph, null);
    assert.match(a.vfxAssetError, /Expected cloth/);
    const before = changes; a._unbindVfxAsset(); b._unbindVfxAsset();
    publishVfxAsset("shared.vfx", doc("cloth", 9));
    assert.equal(changes, before);
  } finally { a._unbindVfxAsset?.(); b._unbindVfxAsset?.(); globalThis.fetch = originalFetch; }
});
