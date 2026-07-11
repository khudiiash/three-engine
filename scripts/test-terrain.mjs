// Headless test of the Terrain module: geometry/heightmap generation, sculpt +
// paint brush strokes, splat normalization, heightfield collider, and a
// serialize/deserialize round trip. Run: node scripts/test-terrain.mjs
//
// The Engine constructor builds an InputManager that reads `document.body`,
// so stub a minimal DOM before importing anything that constructs an Engine.
globalThis.document ??= { body: {} };

import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Engine, enableEngineModule, getComponentClass, registerBuiltInComponents, serializeEntity, instantiateEntity } from "../src/engine/index.js";
import "../src/modules/index.js";

registerBuiltInComponents();
assert.ok(!getComponentClass("terrain"), "terrain is NOT a base built-in (module only)");

const engine = new Engine();
await enableEngineModule(engine, "terrain");
assert.ok(getComponentClass("terrain"), "terrain registered once the module is enabled");

const entity = engine.createEntity({ name: "Terrain" });
entity.addComponent("terrain", {});
const terrain = entity.getComponent("terrain");

// -- geometry built with the default 129x129 grid, flat (all heights 0) --
const resolution = terrain.props.resolution;
assert.equal(resolution, 128, "default resolution is 128");
assert.equal(terrain.heightsArray.length, (resolution + 1) ** 2, "heights array sized to (resolution+1)^2");
assert.ok(terrain.heightsArray.every((h) => h === 0), "starts flat");
assert.ok(terrain.mesh.isMesh, "mesh built");
console.log("[1] OK: default terrain geometry");

// -- sculpt brush raises heights near the stroke point, leaves far verts untouched --
const before = terrain.heightsArray.slice();
terrain.applyHeightBrush(new THREE.Vector3(0, 0, 0), { tool: "raise", radius: 3, strength: 1, hardness: 0.5 });
const centerIdx = Math.floor(terrain.heightsArray.length / 2); // grid center ~ world origin
assert.ok(terrain.heightsArray[centerIdx] > before[centerIdx], "raise brush increased height near center");
assert.equal(terrain.heightsArray[0], before[0], "far corner vertex untouched by a small-radius brush");
console.log("[2] OK: sculpt brush raises near stroke point only");

// -- commitHeights() encodes the live buffer into props.heights --
terrain.commitHeights();
assert.ok(terrain.props.heights.length > 0, "heights committed to a non-empty base64 string");
console.log("[3] OK: commitHeights encodes props.heights");

// -- paint brush shifts splatmap weight toward the painted layer and stays normalized --
entity.getComponent("terrain").setProp("layers", [
  { texture: "", tiling: 20 },
  { texture: "", tiling: 10 },
]);
const splatBefore = terrain.splatData.slice();
terrain.applySplatBrush(new THREE.Vector3(0, 0, 0), { layerIndex: 1, radius: 5, strength: 0.5, hardness: 0.5 });
const splatRes = terrain.splatResolution;
const mid = (Math.floor(splatRes / 2) * splatRes + Math.floor(splatRes / 2)) * 4; // the center texel
assert.ok(terrain.splatData[mid + 1] > splatBefore[mid + 1], "paint brush increased layer-1 weight");
for (let i = 0; i < terrain.splatData.length; i += 4) {
  const sum = terrain.splatData[i] + terrain.splatData[i + 1] + terrain.splatData[i + 2] + terrain.splatData[i + 3];
  assert.ok(sum <= 256 && sum >= 250, `texel ${i / 4} channels stay normalized (sum=${sum})`);
}
console.log("[4] OK: paint brush shifts + renormalizes splat weights");

terrain.commitSplatmap();
assert.ok(terrain.props.splatmap.length > 0, "splatmap committed to a non-empty base64 string");
console.log("[5] OK: commitSplatmap encodes props.splatmap");

// -- serialize / deserialize round trip preserves heights, splatmap, and layers --
const snapshot = serializeEntity(entity);
engine.destroyEntity(entity);
const restored = instantiateEntity(engine, snapshot, null);
const restoredTerrain = restored.getComponent("terrain");
assert.deepEqual(
  Array.from(restoredTerrain.heightsArray),
  Array.from(terrain.heightsArray),
  "heights survive a save/load round trip",
);
assert.deepEqual(
  Array.from(restoredTerrain.splatData),
  Array.from(terrain.splatData),
  "splatmap survives a save/load round trip",
);
assert.equal(restoredTerrain.props.layers.length, 2, "layers array survives a save/load round trip");
console.log("[6] OK: serialize/deserialize round trip");

// -- heightAtLocal bilinear sampling --
{
  const e2 = engine.createEntity({ name: "T2" });
  e2.addComponent("terrain", { resolution: 4, size: 8 }); // 5x5 grid, step = 2
  const t2 = e2.getComponent("terrain");
  const cols = t2.resolution + 1;
  const step = 8 / 4;
  const half = 4;
  t2.heightsArray[2 * cols + 3] = 10; // row 2, col 3

  const x = 3 * step - half, z = 2 * step - half;
  assert.ok(Math.abs(t2.heightAtLocal(x, z) - 10) < 1e-6, "heightAtLocal exact at a grid vertex");
  assert.ok(Math.abs(t2.heightAtLocal(x - step / 2, z) - 5) < 1e-6, "heightAtLocal interpolates linearly between neighbors");
  console.log("[7] OK: heightAtLocal bilinear sampling");
}

// -- sculpt tool variety: smooth reduces a spike, sharpen amplifies it,
// erode carves toward the local minimum --
{
  const e3 = engine.createEntity({ name: "T3" });
  e3.addComponent("terrain", { resolution: 16, size: 16 });
  const t = e3.getComponent("terrain");
  const cols = t.resolution + 1;
  const centerIdx = 8 * cols + 8; // near local origin
  const center = new THREE.Vector3(0, 0, 0);

  const spike = () => { t.heightsArray.fill(0); t.heightsArray[centerIdx] = 10; };
  const opts = { radius: 4, strength: 1, hardness: 0.5 };

  spike();
  t.applyHeightBrush(center, { ...opts, tool: "smooth" });
  assert.ok(t.heightsArray[centerIdx] < 10, "smooth lowers an isolated spike");

  spike();
  t.applyHeightBrush(center, { ...opts, tool: "sharpen" });
  assert.ok(t.heightsArray[centerIdx] > 10, "sharpen amplifies an isolated spike");

  spike();
  t.applyHeightBrush(center, { ...opts, tool: "erode" });
  assert.ok(t.heightsArray[centerIdx] < 10, "erode carves a spike toward the local minimum");

  // Noise perturbs a flat region; flatten pulls back toward the start height.
  t.heightsArray.fill(0);
  t.applyHeightBrush(center, { ...opts, tool: "noise", seed: 1 });
  assert.ok(t.heightsArray.some((h) => Math.abs(h) > 1e-4), "noise perturbs a flat region");
  t.applyHeightBrush(center, { ...opts, tool: "flatten", flattenHeight: 0 });
  assert.ok(Math.abs(t.heightsArray[centerIdx]) < 1, "flatten pulls back toward the target height");
  console.log("[8] OK: sculpt tools (smooth/sharpen/erode/noise/flatten)");
}

// -- material: valid MeshStandardNodeMaterial; per-layer PBR channels blend by
// the splatmap. A layer's scalar tint/roughness apply even without maps, so a
// layer produces channel nodes; zero layers falls back to the flat base color.
// (Full shader compilation needs a GPU context, out of scope for headless.) --
{
  const t0 = engine.createEntity({ name: "T4a" });
  t0.addComponent("terrain", { resolution: 4, size: 8, layers: [] });
  const m0 = t0.getComponent("terrain").material;
  assert.ok(m0?.isMeshStandardNodeMaterial, "terrain uses a MeshStandardNodeMaterial");
  assert.equal(m0.colorNode, null, "zero layers -> flat base color, no blend nodes");

  const t1 = engine.createEntity({ name: "T4b" });
  t1.addComponent("terrain", { resolution: 4, size: 8, layers: [{ tint: "#804020", roughness: 0.3 }] });
  const m1 = t1.getComponent("terrain").material;
  assert.ok(m1.colorNode, "a layer (even mapless) drives colorNode from its tint");
  assert.ok(m1.roughnessNode, "a layer drives roughnessNode from its scalar roughness");
  assert.equal(m1.normalNode, null, "no normal maps -> normalNode stays default (null)");
  console.log("[9] OK: per-layer PBR material blend wiring");
}

// -- heightfield collider: physics raycasts land on the terrain surface,
// and the transpose in toColumnMajor() maps rows/cols to the right axes --
{
  const physEngine = new Engine();
  await enableEngineModule(physEngine, "terrain");
  await enableEngineModule(physEngine, "physics-rapier");
  await physEngine.modules.get("physics-rapier")?.ready;

  const ramp = physEngine.createEntity({ name: "Ramp" });
  ramp.addComponent("terrain", { resolution: 8, size: 16 }); // 9x9 grid, step = 2
  const ramp_terrain = ramp.getComponent("terrain");
  const rcols = ramp_terrain.resolution + 1;
  // Height increases with column (x) index only, flat along rows (z) — a
  // wrong row/col transpose would make height vary with z instead of x.
  for (let r = 0; r < rcols; r++) {
    for (let c = 0; c < rcols; c++) ramp_terrain.heightsArray[r * rcols + c] = c;
  }
  ramp.addComponent("collider", { shape: "heightfield" });
  const rampCollider = ramp.getComponent("collider");
  assert.ok(rampCollider.gizmo?.isLineSegments, "heightfield collider builds a wireframe gizmo from the terrain");

  physEngine.setPlaying(true);
  // Rapier's query pipeline only indexes colliders after a world step —
  // raycasting immediately after enabling play finds nothing.
  for (const fn of physEngine.updateCallbacks) fn(1 / 60);
  const rayAt = (x, z) => physEngine.physics.raycast([x, 20, z], [0, -1, 0], 100);

  const hitA = rayAt(-6, 0); // x=-6 -> column 1 -> expected height ~1
  const hitB = rayAt(2, 0); // x=2 -> column 5 -> expected height ~5
  const hitC = rayAt(2, 6); // same x, different z -> should match hitB's height
  assert.ok(hitA && hitB && hitC, "raycasts hit the heightfield collider");
  assert.ok(Math.abs(hitA.point[1] - ramp_terrain.heightAtLocal(-6, 0)) < 0.05, `hitA lands near the terrain surface (got ${hitA.point[1]})`);
  assert.ok(Math.abs(hitB.point[1] - ramp_terrain.heightAtLocal(2, 0)) < 0.05, `hitB lands near the terrain surface (got ${hitB.point[1]})`);
  assert.ok(Math.abs(hitB.point[1] - hitC.point[1]) < 0.05, "height is constant along z for a fixed x (row/col axes not swapped)");
  assert.ok(hitB.point[1] > hitA.point[1] + 2, "height increases along x as expected");
  console.log("[10] OK: heightfield collider matches the terrain surface, axes not swapped");
}

console.log("All terrain tests passed.");
