import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARTICLE_GRAPH, compileParticleGraph } from "../src/engine/particleGraph.js";
import { PARTICLE_PRESETS } from "../src/editor/particlePresets.js";
import { VFX_MODULES, addVfxModule, addVfxNode, connectVfxInput, removeVfxNode, vfxBranchIds } from "../src/editor/vfxStack.js";

const recipe = (id) => VFX_MODULES.find((item) => item.id === id);
test("one-click force composes with all preset forces without mutating the other emitter", async () => {
  const original = structuredClone(PARTICLE_PRESETS.Fire);
  const before = structuredClone(original);
  const otherIds = vfxBranchIds(original, "e_sys");
  const result = addVfxModule(original, "sys", recipe("gravity"));
  assert.deepEqual(original, before);
  const branch = vfxBranchIds(result.graph, "sys");
  for (const id of vfxBranchIds(original, "sys")) assert.ok(branch.has(id), id);
  assert.ok(branch.has(result.id));
  assert.deepEqual(vfxBranchIds(result.graph, "e_sys"), otherIds);
  assert.equal((await compileParticleGraph(result.graph)).systems.length, 2);
});
test("appearance and spawn modules replace one input rather than accumulating ambiguous edges", () => {
  let graph = structuredClone(DEFAULT_PARTICLE_GRAPH);
  for (const id of ["gradient", "color", "size", "sizeLife", "opacity", "emitBox", "emitSphere"]) graph = addVfxModule(graph, "sys", recipe(id)).graph;
  for (const input of ["color", "size", "opacity", "position", "velocity"]) assert.equal(graph.edges.filter((edge) => edge.target === "sys" && edge.targetHandle === input).length, 1);
  assert.equal(graph.nodes.find((node) => node.id === graph.edges.find((edge) => edge.target === "sys" && edge.targetHandle === "position").source).type, "emitSphere");
});
test("connection dropdown rejects cycles, nonexistent handles and incompatible vector to scalar", () => {
  let { graph, id } = addVfxNode(structuredClone(DEFAULT_PARTICLE_GRAPH), "add", "sys");
  graph = connectVfxInput(graph, id, "a", "vel");
  assert.throws(() => connectVfxInput(graph, "vel", "a", id), /cycle/);
  assert.throws(() => connectVfxInput(graph, "sys", "missing", id), /input/);
  assert.throws(() => connectVfxInput(graph, "sys", "size", "missing"), /output/);
  assert.throws(() => connectVfxInput(graph, "sys", "size", "emit", "pos"), /incompatible/);
});
test("deleting a module drops dangling wires and keeps at least one simulation", () => {
  const graph = structuredClone(DEFAULT_PARTICLE_GRAPH);
  assert.throws(() => removeVfxNode(graph, "sys"), /at least one/);
  const result = removeVfxNode(graph, "grav");
  assert.ok(!result.nodes.some((node) => node.id === "grav"));
  assert.ok(!result.edges.some((edge) => edge.source === "grav" || edge.target === "grav"));
  assert.ok(graph.nodes.some((node) => node.id === "grav"));
});
test("new modules preserve authoring metadata and unique ids", () => {
  const graph = { ...structuredClone(DEFAULT_PARTICLE_GRAPH), note: "keep me" };
  graph.nodes.push({ id: "frame", type: "__frame", props: { title: "A shared effect" }, position: { x: 5, y: 6 } });
  const a = addVfxModule(graph, "sys", recipe("wind"));
  const b = addVfxModule(a.graph, "sys", recipe("wind"));
  assert.notEqual(a.id, b.id);
  assert.equal(b.graph.note, "keep me");
  assert.deepEqual(b.graph.nodes.find((node) => node.id === "frame"), graph.nodes.at(-1));
});
