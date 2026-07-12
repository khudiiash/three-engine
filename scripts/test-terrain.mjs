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
import { makeTerrainScatterLayer } from "../src/modules/terrain/TerrainComponent.js";
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

// -- eraser removes the active layer's weight (revealing what's underneath) and
// stays normalized; erasing a texel down to nothing falls back to base layer 0 --
{
  const painted = terrain.splatData[mid + 1];
  assert.ok(painted > 0, "layer-1 has weight to erase at the center texel");
  terrain.applySplatBrush(new THREE.Vector3(0, 0, 0), { layerIndex: 1, radius: 5, strength: 0.5, hardness: 0.5, erase: true });
  assert.ok(terrain.splatData[mid + 1] < painted, "eraser reduced layer-1 weight");
  for (let i = 0; i < terrain.splatData.length; i += 4) {
    const sum = terrain.splatData[i] + terrain.splatData[i + 1] + terrain.splatData[i + 2] + terrain.splatData[i + 3];
    assert.ok(sum <= 256 && sum >= 250, `texel ${i / 4} stays normalized after erase (sum=${sum})`);
  }

  // Fully erasing the only weighted layer must not leave a black/void texel:
  // the center texel (where the brush is strongest) falls back to base layer 0.
  // Reuse `terrain` (no new node-material entity) to keep headless memory low.
  const res = terrain.splatResolution;
  for (let i = 0; i < terrain.splatData.length; i += 4) {
    terrain.splatData[i] = 0; terrain.splatData[i + 1] = 255;
    terrain.splatData[i + 2] = 0; terrain.splatData[i + 3] = 0;
  }
  // Over-strength (2) so the falloff never leaves a sub-texel remainder.
  terrain.applySplatBrush(new THREE.Vector3(0, 0, 0), { layerIndex: 1, radius: 20, strength: 2, hardness: 0, erase: true });
  const cen = (Math.floor(res / 2) * res + Math.floor(res / 2)) * 4; // center texel
  assert.equal(terrain.splatData[cen + 1], 0, "eraser drives the strongly-hit layer weight to zero");
  assert.equal(terrain.splatData[cen], 255, "a fully-erased texel falls back to base layer 0, never an unweighted void");
  // No texel anywhere may end up unweighted (would render black).
  for (let i = 0; i < terrain.splatData.length; i += 4) {
    const sum = terrain.splatData[i] + terrain.splatData[i + 1] + terrain.splatData[i + 2] + terrain.splatData[i + 3];
    assert.ok(sum >= 250, `texel ${i / 4} never becomes an unweighted void (sum=${sum})`);
  }
  // Re-commit so props.splatmap matches the live buffer we just mutated —
  // otherwise the round-trip test below would deep-diff two 256K-element
  // arrays and blow the heap.
  terrain.commitSplatmap();
  console.log("[5b] OK: eraser removes weight, renormalizes, and falls back to base layer");
}

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

// -- terrain-owned model scatter data: deterministic candidates, spacing,
// add/remove strokes, and serialization without requiring a GLB in headless --
{
  restoredTerrain.setProp("scatterLayers", [makeTerrainScatterLayer({ name: "Rocks", model: "" })]);
  const opts = { layerIndex: 0, radius: 6, strength: 1, spacing: 1.5, jitter: 0.7, seed: 42 };
  const previewA = restoredTerrain.getScatterPreviewPlacements(new THREE.Vector3(0, 0, 0), opts);
  const previewB = restoredTerrain.getScatterPreviewPlacements(new THREE.Vector3(0, 0, 0), opts);
  assert.deepEqual(previewA, previewB, "scatter preview is stable for a seed");
  assert.ok(previewA.length > 0, "scatter preview proposes instances");
  restoredTerrain.applyScatterBrush(new THREE.Vector3(0, 0, 0), opts);
  const placed = restoredTerrain.getScatterInstances(0);
  assert.ok(placed.length > 0, "scatter stroke adds instances");

  // Instances store raw random draws, not a baked transform — that's what lets
  // the layer's placement settings stay editable after painting.
  assert.ok(placed.every((item) => item.r?.length === 6 && !item.quaternion), "instances store random draws, not a baked transform");

  const scaleOf = (layerIndex, item) => {
    const m = restoredTerrain.scatterPlacementMatrix(layerIndex, item, new THREE.Matrix4());
    return new THREE.Vector3().setFromMatrixScale(m);
  };
  assert.ok(placed.every((item) => { const s = scaleOf(0, item).x; return s >= 0.8 - 1e-6 && s <= 1.2 + 1e-6; }), "scatter scale range is respected");
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    assert.ok(Math.hypot(placed[i].position[0] - placed[j].position[0], placed[i].position[2] - placed[j].position[2]) >= 1.5 - 1e-6, "scatter spacing is respected");
  }
  // Painted instances live on the component until a stroke is committed, so the
  // live layer (not props) is what a settings edit must be built from — exactly
  // what the editor does via commitScatterLayers().
  const liveLayer = () => JSON.parse(restoredTerrain.commitScatterLayers())[0];
  const tweak = (patch) => restoredTerrain.setProp("scatterLayers", [{ ...liveLayer(), ...patch }]);

  // Widening the layer's scale range must grow the instances ALREADY painted —
  // the whole point of storing draws instead of resolved values.
  const beforeWiden = placed.map((item) => scaleOf(0, item).x);
  tweak({ scaleMin: 4, scaleMax: 5 });
  const afterWiden = restoredTerrain.getScatterInstances(0).map((item) => scaleOf(0, item).x);
  assert.ok(afterWiden.length === placed.length, "the instances survive a settings edit");
  assert.ok(afterWiden.every((s) => s >= 4 - 1e-6 && s <= 5 + 1e-6), "editing the layer's scale range re-resolves instances already painted");
  assert.ok(beforeWiden.every((s) => s < 2), "…and they really were smaller before");

  // Stretch scales the up axis only (squat / lanky variants of one model).
  tweak({ scaleMin: 1, scaleMax: 1, stretchMin: 3, stretchMax: 3 });
  const stretched = scaleOf(0, restoredTerrain.getScatterInstances(0)[0]);
  assert.ok(Math.abs(stretched.y - 3) < 1e-5 && Math.abs(stretched.x - 1) < 1e-5, "stretch scales the up axis only");

  // Alignment: the up axis the instance ends up standing on.
  const upOf = (patch) => {
    tweak({ ...patch, yawMin: 0, yawMax: 0, tiltJitter: 0 });
    const item = restoredTerrain.getScatterInstances(0)[0];
    const m = restoredTerrain.scatterPlacementMatrix(0, item, new THREE.Matrix4());
    return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(m));
  };
  const upSurface = upOf({ align: "surface", alignAxis: "+y", alignBlend: 1 });
  assert.ok(upSurface.y > 0.99, "on flat ground a surface-aligned instance stands straight up");
  const upX = upOf({ align: "axis", alignAxis: "+x" });
  assert.ok(upX.x > 0.99, "a +X axis-aligned instance points along +X");
  const upDown = upOf({ align: "axis", alignAxis: "-y" });
  assert.ok(upDown.y < -0.99, "a -Y axis-aligned instance points straight down");

  // Slope + altitude filters. Raise a hill, then brush across its flank — the
  // dab straddles flat ground AND steep ground, so the contract isn't "places
  // nothing", it's "every instance it places satisfies the layer's window".
  restoredTerrain.applyHeightBrush(new THREE.Vector3(20, 0, 20), { tool: "raise", radius: 6, strength: 12, hardness: 1 });
  const slopeAt = (item) => {
    const n = restoredTerrain.normalAtLocal(item.position[0], item.position[2]);
    return THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, n.y))));
  };
  const heightAt = (item) => restoredTerrain.heightAtLocal(item.position[0], item.position[2]);

  restoredTerrain.setProp("scatterLayers", [
    makeTerrainScatterLayer({ name: "Grass", slopeMin: 0, slopeMax: 5 }),
    makeTerrainScatterLayer({ name: "Vines", slopeMin: 30, slopeMax: 90 }),
    makeTerrainScatterLayer({ name: "Anything" }),
  ]);
  const flankOpts = { radius: 6, strength: 1, spacing: 1, jitter: 0.7, seed: 7 };
  const onFlank = new THREE.Vector3(18, 0, 18);
  const flats = restoredTerrain.getScatterPreviewPlacements(onFlank, { ...flankOpts, layerIndex: 0 });
  const cliffs = restoredTerrain.getScatterPreviewPlacements(onFlank, { ...flankOpts, layerIndex: 1 });
  const anywhere = restoredTerrain.getScatterPreviewPlacements(onFlank, { ...flankOpts, layerIndex: 2 });
  assert.ok(flats.every((i) => slopeAt(i) <= 5 + 1e-6), "a flats-only layer never lands on a slope steeper than its limit");
  assert.ok(cliffs.length > 0 && cliffs.every((i) => slopeAt(i) >= 30 - 1e-6), "a steep-slope layer only lands on steep ground");
  assert.ok(anywhere.length > flats.length && anywhere.length > cliffs.length, "…and an unfiltered layer places more than either");

  const peak = restoredTerrain.heightAtLocal(20, 20);
  assert.ok(peak > 1, "the hill actually got raised");
  restoredTerrain.setProp("scatterLayers", [makeTerrainScatterLayer({ name: "Kelp", altitudeMax: 0.5 })]);
  const lowlands = restoredTerrain.getScatterPreviewPlacements(onFlank, { ...flankOpts, layerIndex: 0 });
  assert.ok(lowlands.every((i) => heightAt(i) <= 0.5 + 1e-6), "an altitude-capped layer never lands above its ceiling");

  restoredTerrain.setProp("scatterLayers", [makeTerrainScatterLayer({ name: "Rocks", instances: placed })]);
  const committed = restoredTerrain.commitScatterLayers();
  assert.equal(JSON.parse(committed)[0].instances.length, placed.length, "scatter instances commit to serializable props");
  restoredTerrain.applyScatterBrush(new THREE.Vector3(0, 0, 0), { ...opts, erase: true });
  assert.ok(restoredTerrain.getScatterInstances(0).length < placed.length, "Ctrl-style erase stroke removes instances");

  const source = engine.createEntity({ name: "Rock source" });
  restoredTerrain.setProp("scatterLayers", [{
    name: "Entity rocks", sourceType: "entity", sourceEntity: source.id, instances: previewA.slice(0, 2),
  }]);
  await Promise.resolve();
  assert.equal(restoredTerrain.getScatterPreviewSources(0).length, 0, "entity source can initially be unresolved during scene restore");
  source.addComponent("mesh", {});
  const sourceMesh = source.getComponent("mesh").mesh;
  engine.emit("hierarchy-changed");
  await Promise.resolve();
  assert.equal(restoredTerrain.getScatterPreviewSources(0)[0]?.geometry, sourceMesh.geometry, "entity scatter reuses MeshComponent geometry");
  assert.equal(sourceMesh.parent, source.object3D, "reading an entity source never reparents its mesh");
  const persistedScatter = serializeEntity(restored).components.find((component) => component.type === "terrain").props.scatterLayers;
  assert.equal(persistedScatter[0].instances.length, 2, "scatter placements persist in serialized terrain data");
  restoredTerrain.setProp("scatterLayers", [{ ...persistedScatter[0], visible: false }]);
  assert.equal(restoredTerrain.getScatterPreviewSources(0)[0].mesh.visible, false, "scatter layer visibility hides instances without deleting them");
  console.log("[6b] OK: scatter preview/add/remove/commit");
}

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
  assert.ok(t2.normalAtLocal(x, z).isVector3, "normalAtLocal exposes a live surface normal for aligned scatter");
  const predicted = t2.previewHeightAtLocal(0, 0, new THREE.Vector3(0, 0, 0), { tool: "raise", radius: 2, strength: 1, hardness: 0.5 });
  assert.ok(predicted > t2.heightAtLocal(0, 0), "raise outcome preview predicts a higher surface without mutating it");
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
  t1.getComponent("terrain").setProp("layers", [{ tint: "#804020", roughness: 0.3, visible: false }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(t1.getComponent("terrain").material.colorNode === null, "hidden texture layers are excluded from the material blend");
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

// -- scatter tracks its source's material when that material arrives LATE.
// MeshComponent resolves its `.mat` asynchronously and swaps `mesh.material`
// after attach. The scatter used to snapshot the material reference at load
// time, so on every scene load / Play it captured the placeholder default and
// rendered the instances white forever. It must re-read the live source.
{
  const src = engine.createEntity({ name: "Rock source" });
  src.addComponent("mesh", { geometry: "box" });
  const srcMesh = src.getComponent("mesh").mesh;
  const placeholder = srcMesh.material;

  const host = engine.createEntity({ name: "Scatter host" });
  host.addComponent("terrain", {
    scatterLayers: [makeTerrainScatterLayer({
      name: "Rocks",
      sourceType: "entity",
      sourceEntity: src.id,
      instances: [{ position: [0, 0, 0], r: [0, 0, 0, 0.5, 0.5, 0.5] }],
    })],
  });
  const host_t = host.getComponent("terrain");
  await Promise.resolve(); // #loadScatterLayers is async
  await Promise.resolve();

  const sources = host_t.getScatterPreviewSources(0);
  assert.equal(sources.length, 1, "entity-backed scatter resolved its source mesh");
  assert.equal(sources[0].mesh.material, placeholder, "instances start on whatever material the source had");

  // The .mat resolves — MeshComponent replaces mesh.material with a new object.
  const real = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
  srcMesh.material = real;
  // Any refresh (a settings tweak, a sculpt stroke, the component-changed event
  // MeshComponent now fires) must pick the new material up.
  host_t.setProp("scatterLayers", JSON.parse(host_t.commitScatterLayers()));

  assert.equal(
    host_t.getScatterPreviewSources(0)[0].mesh.material,
    real,
    "scatter re-reads the source's material — instances don't stay stuck on the placeholder",
  );
  console.log("[11] OK: scatter follows a source material that resolves after load");
}

// -- legacy instances (baked quaternion + scale, painted before placement
// settings existed) must become live-editable, or every knob on the layer would
// appear to do nothing to the scatter already in the scene. The migration has to
// be deterministic: it re-runs on every setProp (props keep the old shape until
// the next commit), so drawing fresh randoms would reshuffle the layer on each
// keystroke.
{
  const host = engine.createEntity({ name: "Legacy scatter" });
  const legacyInstances = [
    { position: [1, 0, 2], quaternion: [0, 0, 0, 1], scale: 1.0 },
    { position: [-3, 0, 4], quaternion: [0, 0, 0, 1], scale: 1.2 },
  ];
  host.addComponent("terrain", {
    scatterLayers: [{ name: "Old rocks", model: "", instances: legacyInstances }],
  });
  const t = host.getComponent("terrain");

  const live = () => t.getScatterInstances(0);
  assert.ok(live().every((i) => i.r && !i.quaternion), "legacy instances are migrated to random draws on load");

  // Scale is preserved exactly through the migration (the draw is inverted out
  // of the baked value against the layer's range).
  const scaleOf2 = (item) => new THREE.Vector3().setFromMatrixScale(t.scatterPlacementMatrix(0, item, new THREE.Matrix4())).x;
  assert.ok(Math.abs(scaleOf2(live()[0]) - 1.0) < 1e-5, "migration preserves an instance's existing scale");
  assert.ok(Math.abs(scaleOf2(live()[1]) - 1.2) < 1e-5, "…including one at the top of the range");

  // Now the settings actually bite.
  const drawsBefore = live().map((i) => [...i.r]);
  t.setProp("scatterLayers", [{ ...JSON.parse(t.commitScatterLayers())[0], scaleMin: 10, scaleMax: 10 }]);
  assert.ok(live().every((i) => Math.abs(scaleOf2(i) - 10) < 1e-5), "a settings change now affects instances painted before the settings existed");

  // Re-running the migration (which setProp does) must not re-roll anything.
  t.setProp("scatterLayers", [{ name: "Old rocks", model: "", instances: legacyInstances }]);
  assert.deepEqual(live().map((i) => [...i.r]), drawsBefore, "migration is deterministic — repeated setProps don't reshuffle the layer");

  // Clearing a layer drops its instances but keeps the layer and its settings.
  t.setProp("scatterLayers", [{ ...JSON.parse(t.commitScatterLayers())[0], scaleMin: 3, scaleMax: 3 }]);
  const removed = t.clearScatterLayer(0);
  assert.equal(removed, 2, "clear reports how many instances it removed");
  assert.equal(live().length, 0, "clear empties the layer");
  const kept = JSON.parse(t.commitScatterLayers())[0];
  assert.equal(kept.name, "Old rocks", "clear keeps the layer itself");
  assert.equal(kept.scaleMin, 3, "…and its placement settings");
  console.log("[12] OK: legacy instances migrate deterministically; clear empties a layer");
}

console.log("All terrain tests passed.");
