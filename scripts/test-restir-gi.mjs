globalThis.document ??= { body: {} };

import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Engine, enableEngineModule, disableEngineModule, getComponentClass, registerBuiltInComponents } from "../src/engine/index.js";
import {
  UNIFORM_HEMISPHERE_PDF,
  clampReservoirM,
  updateReservoir,
  finalizeReservoir,
  spiralOffsets,
  sanitizeRestirConfig,
  createRestirNodes,
} from "../src/modules/restir-gi/index.js";
import "../src/modules/index.js";

registerBuiltInComponents();

{
  assert.equal(UNIFORM_HEMISPHERE_PDF, 1 / (2 * Math.PI));
  assert.equal(clampReservoirM(40, 10), 10);
  assert.equal(clampReservoirM(-1, 10), 0);
  const r = { sample: null, weightSum: 0, M: 0, W: 0 };
  updateReservoir(r, { sample: "a", M: 1 }, 2, 0);
  updateReservoir(r, { sample: "b", M: 3 }, 6, 0.99);
  assert.equal(r.sample, "a", "weighted update keeps sample when random misses replacement interval");
  finalizeReservoir(r, 0.5);
  assert.equal(r.W, 4);
  assert.equal(spiralOffsets(8, 24).length, 8);
  assert.deepEqual(sanitizeRestirConfig({ resolutionScale: 9, voxelRes: 2 }).resolutionScale, 1);
  console.log("[1] OK: reservoir reference math + configuration");
}

{
  const width = 16;
  const height = 12;
  const count = width * height;
  const dims = { x: 8, y: 8, z: 8 };
  const set = () => new THREE.StorageBufferAttribute(new Float32Array(count * 16), 4);
  const bvh = {
    nodes: new THREE.StorageBufferAttribute(new Float32Array(64 * 8), 4),
    triPositions: new THREE.StorageBufferAttribute(new Float32Array(32 * 12), 4),
    triData: new THREE.StorageBufferAttribute(new Uint32Array(32 * 4), 1),
    nodeCapacity: 64,
    triCapacity: 32,
  };
  const cache = { radiance: new THREE.StorageBufferAttribute(new Float32Array(512 * 4), 4) };
  const gbuffer = () => {
    const depth = new THREE.DepthTexture(width, height);
    const target = new THREE.RenderTarget(width, height, { depthTexture: depth });
    return { target, depth, normal: target.texture };
  };
  const a = gbuffer();
  const b = gbuffer();
  const raw = new THREE.StorageTexture(width, height);
  const scratch = new THREE.StorageTexture(width, height);
  const history = new THREE.StorageTexture(width, height);
  const output = new THREE.StorageTexture(width, height);
  const nodes = createRestirNodes({
    width, height, dims, traceSteps: 24, spatialPasses: 2, spatialSamples: 8, spatialRadius: 12,
    bvh,
    cache,
    reservoirs: { initial: set(), previous: set(), temporal: set(), spatialA: set(), spatialB: set() },
    gbuffer: { depth: a.depth, normal: a.normal },
    previousGbuffer: { depth: b.depth, normal: b.normal },
    rawTexture: raw,
    scratchTexture: scratch,
    historyTexture: history,
    outputTexture: output,
  });
  for (const key of ["candidateNode", "temporalNode", "spatialNodeA", "spatialNodeB", "resolveNode", "atrousNode", "denoiseNode"]) {
    assert.ok(nodes[key]?.isNode, `${key} built`);
  }
  assert.equal(nodes.count, count);
  assert.ok(nodes.uniforms.prevViewProj.value.isMatrix4);
  a.target.dispose(); b.target.dispose(); raw.dispose(); scratch.dispose(); history.dispose(); output.dispose();
  console.log("[2] OK: complete ReSTIR TSL pass graph construction");
}

{
  const engine = new Engine();
  assert.ok(!getComponentClass("restir-gi"), "component starts module-gated");
  const handle = await enableEngineModule(engine, "restir-gi");
  assert.ok(getComponentClass("restir-gi"));
  const entity = engine.createEntity({ name: "ReSTIR GI" });
  entity.addComponent("restir-gi", {});
  const component = entity.getComponent("restir-gi");
  assert.equal(handle.system.component, component);
  assert.equal(handle.system._rebuildQueued, true);
  component.setProp("voxelRes", 96);
  assert.equal(handle.system._rebuildQueued, true);
  component.setProp("enabled", false);
  assert.equal(handle.system.component, null);
  component.setProp("enabled", true);
  assert.equal(handle.system.component, component);
  engine.destroyEntity(entity);
  await disableEngineModule(engine, "restir-gi");
  assert.ok(!getComponentClass("restir-gi"));
  console.log("[3] OK: module/component lifecycle");
}

console.log("\nAll ReSTIR GI module tests passed.");
