/** Terrain brush previews and committed Architecture floors through real Rapier. */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

// Import editor operations before DOM shims to avoid booting the browser editor.
const { vmSingleton } = await import("../src/editor/singleton.js");
const { commandBus } = await import("../src/editor/commands/CommandBus.js");
const { SetTerrainHeightsCommand } = await import("../src/editor/commands/terrainCommands.js");
const { createArchitectureModel } = await import("../src/editor/architectureModelBuild.js");

const element = () => ({ style: {}, appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} }, parentElement: null });
globalThis.document ??= { body: element(), createElement: element, addEventListener() {}, removeEventListener() {}, hidden: false };
globalThis.window ??= { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, performance: globalThis.performance, crypto: globalThis.crypto };
globalThis.requestAnimationFrame ??= fn => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);

const { Engine, registerBuiltInComponents, applyEngineModules } = await import("../src/engine/index.js");
await import("../src/modules/index.js");
registerBuiltInComponents();

const close = (actual, expected, message, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) < tolerance, `${message}: expected ${expected}, got ${actual}`);

async function fixture(t) {
  const engine = new Engine();
  engine.config.physicsAutoColliders = { startEnabled: false };
  await applyEngineModules(engine, ["physics-rapier", "terrain", "architecture"]);
  await engine.modules.get("physics-rapier").ready;
  vmSingleton("engineInstance", () => ({ instance: null, loader: null })).instance = engine;
  commandBus.clearHistory();
  t.after(async () => {
    engine.setPlaying(false);
    engine.clear({ resetSettings: false });
    await applyEngineModules(engine, []);
    engine.time.clear(); commandBus.clearHistory();
  });

  const ground = engine.createEntity({ name: "Sculpted ground" });
  ground.addComponent("mesh", { geometry: "plane", collision: "none" });
  const terrain = ground.addComponent("terrain", { size: 24, resolution: 96, splatResolution: 16 });
  ground.addComponent("collider", { shape: "heightfield" });
  const forms = [
    { id: "hall", shape: "box", position: [0, 0, 0], size: [6, 4, 6], roof: "hip", windows: false },
    { id: "wing", shape: "box", position: [6, 0, 0], size: [6, 4, 6], roof: "hip", windows: false },
  ];
  const openings = [{ id: "entrance", formId: "hall", position: [0, 1.2, -3], normal: [0, 0, -1], kind: "door", width: 2, height: 2.4 }];
  const { entityId } = createArchitectureModel({ model: { forms, openings }, terrainId: ground.id });
  const root = engine.getEntity(entityId), architecture = root.getComponent("architecture");
  root.addComponent("rigidbody", { bodyType: "fixed" });
  await Promise.resolve();
  const service = engine.architectureTerrain, physics = engine.physics;
  service.update({ force: true });
  engine.setPlaying(true); service.update({ force: true }); physics.sync();
  commandBus.clearHistory();
  return { engine, ground, terrain, root, architecture, service, physics };
}

test("terrain sculpt moves joined Architecture previews without recooking, then commits and undoes real walkable floors and doors", async t => {
  const { ground, terrain, root, architecture, service, physics } = await fixture(t);
  const options = { exclude: ground };
  const floorRay = () => physics.raycast([6, 3.5, 0], [0, -1, 0], 5, options);
  const floorCapsule = () => physics.capsulecast([6, 3.6, 0], .3, .55, [0, -1, 0], 5, options);
  const doorRay = y => physics.raycast([0, y, -5], [0, 0, 1], 3, options);
  const doorCapsule = y => physics.capsulecast([0, y, -5], .3, .55, [0, 0, 1], 3, options);
  // Rapier can miss a heightfield ray exactly on a shared grid vertex; probe
  // inside the adjacent triangle and compare against the rendered triangles.
  const groundOrigin = [.251, 3, .251];
  const groundRay = () => physics.raycast(groundOrigin, [0, -1, 0], 5, { exclude: root });
  const visibleRay = (origin, direction, distance) => {
    root.object3D.updateWorldMatrix(true, true);
    const ray = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...direction), 0, distance);
    return ray.intersectObject(architecture.mesh, false)[0] ?? null;
  };
  const assertCounts = () => {
    assert.equal(physics.world.colliders.len(), 2, "one terrain collider and one current Architecture shell");
    assert.equal(physics.world.bodies.len(), 2, "one ground body and one current Architecture body");
    assert.equal(root.getComponent("collider").colliders.length, 1);
    assert.equal(service.errors.size, 0);
  };
  const assertFloor = height => {
    const ray = floorRay(), capsule = floorCapsule();
    assert.equal(ray?.entity, root); close(ray.point[1], height, "floor ray height");
    assert.equal(capsule?.entity, root); close(capsule.distance, 3.6 - .85 - height, "standing capsule floor distance", .002);
  };
  const assertGroundMatchesMesh = () => {
    terrain.mesh.updateWorldMatrix(true, true);
    const ray = new THREE.Raycaster(new THREE.Vector3(...groundOrigin), new THREE.Vector3(0, -1, 0), 0, 5);
    const visible = ray.intersectObject(terrain.mesh, false)[0], physical = groundRay();
    assert.ok(visible, "the rendered terrain is queryable");
    assert.equal(physical?.entity, ground, "the heightfield remains queryable after a terrain mutation");
    close(physical.point[1], visible.point.y, "committed ground collision matches the rendered terrain triangles");
  };

  assertCounts(); assertFloor(0);
  close(groundRay()?.point[1], 0, "initial terrain heightfield is queryable");
  assert.equal(doorRay(1.2), null); assert.equal(doorCapsule(1.2), null);
  assert.equal(doorRay(3.2)?.entity, root, "wall above the original door is solid");
  const originalModel = structuredClone(architecture.props.model);
  const originalGeometry = architecture.geometry;
  const originalPositions = originalGeometry.attributes.position.array.slice();
  const originalCook = physics.getCookedColliderGeometry(root);
  const originalHandle = root.getComponent("collider").collider.handle;
  const before = terrain.props.heights;
  assert.equal(physics.dirty.size, 0);

  // A narrow off-center dab catches terrain vertex peaks between the group's
  // coarse samples. Both touching halls follow the highest ground as one body.
  terrain.applyHeightBrush(new THREE.Vector3(.25, 0, .25), { tool: "raise", radius: .3, strength: 2, hardness: .5 });
  service.update({ force: true });
  close(terrain.heightAtLocal(.25, .25), 2, "live brush height");
  assert.deepEqual(architecture.props.model.forms.map(form => form.position), [[0, 2, 0], [6, 2, 0]]);
  assert.deepEqual(architecture.props.model.openings[0].position, [0, 3.2, -3]);
  assert.equal(architecture.geometry, originalGeometry, "a dab updates the existing shell buffer");
  for (let i = 1; i < originalPositions.length; i += 3) close(architecture.geometry.attributes.position.array[i], originalPositions[i] + 2, "joined preview vertex follows ground");
  close(visibleRay([6, 3.5, 0], [0, -1, 0], 5)?.point.y, 2, "visible floor follows during the stroke");
  assert.equal(visibleRay([0, 3.2, -5], [0, 0, 1], 3), null, "visible doorway moves with its facade");
  assert.equal(physics.dirty.size, 0, "live terrain events do not dirty any physics body");
  physics.sync();
  assert.equal(physics.getCookedColliderGeometry(root), originalCook);
  assert.equal(root.getComponent("collider").collider.handle, originalHandle);
  assertFloor(0);
  close(groundRay()?.point[1], 0, "preview defers terrain heightfield rebuilding too");
  assert.equal(doorRay(3.2)?.entity, root, "the old physical shell remains until stroke completion");
  assert.equal(commandBus.undoStack.length, 0, "following adds no per-dab undo commands");

  terrain.commitHeights();
  const after = terrain.props.heights;
  commandBus.execute(new SetTerrainHeightsCommand(ground.id, before, after));
  service.update({ force: true }); physics.sync();
  assert.notEqual(architecture.geometry, originalGeometry, "commit regenerates supports and the complete shell");
  assert.notEqual(physics.getCookedColliderGeometry(root), originalCook, "commit invalidates the cooked collision geometry");
  assertFloor(2); assertCounts();
  assertGroundMatchesMesh();
  assert.equal(doorRay(3.2), null); assert.equal(doorCapsule(3.2), null);
  assert.equal(physics.raycast([1.8, 3.2, -5], [0, 0, 1], 3, options)?.entity, root, "walls beside the raised doorway still collide");
  assert.equal(physics.raycast([6, 1, 0], [0, -1, 0], 2, options), null, "the previous floor does not leave an invisible collider");
  assert.equal(commandBus.undoStack.length, 1, "one terrain stroke owns the complete undo");

  for (let cycle = 0; cycle < 3; cycle++) {
    commandBus.undo(); service.update({ force: true }); physics.sync();
    assert.deepEqual(architecture.props.model, originalModel, "terrain undo restores exact authored form and opening coordinates");
    assertFloor(0); assertCounts();
    assertGroundMatchesMesh();
    assert.equal(doorRay(1.2), null); assert.equal(doorCapsule(1.2), null);
    assert.equal(doorRay(3.2)?.entity, root, "undo restores the solid wall above the lowered doorway");
    close(visibleRay([6, 3.5, 0], [0, -1, 0], 5)?.point.y, 0, "undo restores the rendered floor too");

    commandBus.redo(); service.update({ force: true }); physics.sync();
    assertFloor(2); assertCounts();
    assertGroundMatchesMesh();
    assert.equal(doorRay(3.2), null); assert.equal(doorCapsule(3.2), null);
    assert.deepEqual(architecture.props.model.openings[0].position, [0, 3.2, -3]);
    assert.equal(commandBus.undoStack.length, 1, "terrain following does not manufacture history on redo");
  }
});
