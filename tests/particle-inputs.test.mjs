import test from "node:test";
import assert from "node:assert/strict";
import { compileParticleGraph, particleGraphSignature, particleInputDescriptor, P_NODE_TYPES } from "../src/engine/particleGraph.js";

const graph = (props = {}, wired = false) => ({ nodes: [
  { id: "system", type: "system", props },
  { id: "constant", type: "float", props: { value: 7 } },
], edges: wired ? [{ source: "constant", sourceHandle: "out", target: "system", targetHandle: "size" }] : [] });
const context = () => ({ cache: new Map() });
test("socket constants render and update hot; a connected node takes precedence", async () => {
  const compiled = await compileParticleGraph(graph({ __input_size: 2 }));
  const size = compiled.systems[0].size(context());
  assert.equal(size.value, 2);
  compiled.updateParams(graph({ __input_size: 4 }));
  assert.equal(size.value, 4);
  const wired = await compileParticleGraph(graph({ __input_size: 2 }, true));
  assert.equal(wired.systems[0].size(context()).value, 7);
});
test("vec3 constants and optional force preserve automatic defaults until overridden", async () => {
  const original = await compileParticleGraph(graph());
  assert.equal(original.systems[0].force, null);
  const compiled = await compileParticleGraph(graph({ __input_force: [0, -5, 0], __input_position: [1, 2, 3] }));
  assert.deepEqual(compiled.systems[0].force(context()).value.toArray(), [0, -5, 0]);
  assert.deepEqual(compiled.systems[0].spawnPosition(context()).value.toArray(), [1, 2, 3]);
});
test("presence and type change pipelines, numeric drags only change uniforms", () => {
  assert.notEqual(particleGraphSignature(graph()), particleGraphSignature(graph({ __input_size: 2 })));
  assert.equal(particleGraphSignature(graph({ __input_size: 2 })), particleGraphSignature(graph({ __input_size: 3 })));
  assert.notEqual(particleGraphSignature(graph({ __input_size: 2 })), particleGraphSignature(graph({ __input_size: [2, 2, 2] })));
  const input = particleInputDescriptor("noise", P_NODE_TYPES.noise.inputs[0]);
  assert.equal(input.autoLabel, "Particle position");
  assert.equal(input.propKey, "__input_p");
});
