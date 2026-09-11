/** Live Architecture mesh edits through the real engine and Rapier cooker. */
import test from "node:test";
import assert from "node:assert/strict";

// Load editor operations before DOM shims: sceneStore intentionally avoids
// booting the Tauri asset/editor graph when imported by a headless test.
const { vmSingleton } = await import("../src/editor/singleton.js");
const { commandBus } = await import("../src/editor/commands/CommandBus.js");
const build = await import("../src/editor/architectureModelBuild.js");
const { addArchitectureColliders } = await import("../src/editor/architectureBuild.js");

const element = () => ({ style: {}, appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} }, parentElement: null });
globalThis.document ??= { body: element(), createElement: element, addEventListener() {}, removeEventListener() {}, hidden: false };
globalThis.window ??= { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {}, performance: globalThis.performance, crypto: globalThis.crypto };
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const { Engine, registerBuiltInComponents, applyEngineModules } = await import("../src/engine/index.js");
const { serializeEntity, instantiateEntity } = await import("../src/engine/serialize.js");
await import("../src/modules/index.js");
registerBuiltInComponents();

const form = (patch = {}) => ({ id: "house", shape: "box", position: [0, 0, 0], size: [6, 4, 6], roof: "hip", roofHeight: 1.2, windows: false, ...patch });
async function fixture(t, { physicsEnabled = true } = {}) {
  const engine = new Engine();
  engine.config.physicsAutoColliders = { startEnabled: false };
  await applyEngineModules(engine, physicsEnabled ? ["physics-rapier", "architecture"] : ["architecture"]);
  await engine.modules.get("physics-rapier")?.ready;
  vmSingleton("engineInstance", () => ({ instance: null, loader: null })).instance = engine;
  commandBus.clearHistory();
  const physics = engine.physics;
  t.after(async () => {
    // No renderer was initialized. Clear authored resources and module-owned
    // worlds directly; Engine.dispose also stops a renderer animation loop.
    engine.setPlaying(false); engine.clear({ resetSettings: false }); await applyEngineModules(engine, []); engine.time.clear(); commandBus.clearHistory();
  });
  return { engine, physics, sync: () => physics.sync() };
}
const rootOf = (engine, result) => engine.getEntity(result.entityId);
const rayFront = (physics, x = 0) => physics.raycast([x, 1.1, -5], [0, 0, 1], 10);
const walkThrough = (physics, x = 0) => physics.capsulecast([x, 1.1, -5], .3, .55, [0, 0, 1], 10);

test("Rapier passages and windows follow live model edits, preserve walkable floors, and rebuild on undo", async (t) => {
  const { engine, physics, sync } = await fixture(t);
  const root = rootOf(engine, build.createArchitectureModel({ model: { forms: [form()] } }));
  engine.setPlaying(true); sync();
  assert.equal(root.getComponent("collider").props.shape, "concave");
  assert.equal(physics.world.colliders.len(), 1);
  assert.equal(rayFront(physics)?.entity, root); assert.equal(walkThrough(physics)?.entity, root);
  const initialCook = physics.getCookedColliderGeometry(root);
  const path = build.addArchitecturePath(root.id, { points: [[0, -8], [0, 8]], width: 2, elevation: 0 }); sync();
  assert.notEqual(physics.getCookedColliderGeometry(root), initialCook, "generated mesh event invalidates the actual cooked collider");
  assert.equal(rayFront(physics), null, "path opens both exterior walls");
  assert.equal(walkThrough(physics), null, "a standing character capsule fits the full passage");
  const floor = physics.raycast([0, 1, 0], [0, -1, 0], 2);
  assert.equal(floor?.entity, root); assert.ok(Math.abs(floor.point[1]) < .1, "the passage retains a walkable floor");
  assert.equal(physics.raycast([5, 3, 0], [-1, 0, 0], 3)?.entity, root);
  const window = build.addArchitectureOpening(root.id, { formId: "house", position: [3, 3, 0], normal: [1, 0, 0], kind: "window", width: 1.6, height: 1.4 }); sync();
  assert.equal(physics.raycast([5, 3, 0], [-1, 0, 0], 3), null, "manual facade opening reaches cooked collision");
  assert.equal(physics.spherecast([5, 3, 0], .3, [-1, 0, 0], 3), null);
  build.updateArchitectureOpening(root.id, window.openingId, { width: .3 }); sync();
  assert.equal(physics.raycast([5, 3, 0], [-1, 0, 0], 3), null);
  assert.equal(physics.spherecast([5, 3, 0], .3, [-1, 0, 0], 3)?.entity, root, "narrowing the opening blocks an object wider than it");
  build.removeArchitectureOpening(root.id, window.openingId); sync();
  assert.equal(physics.raycast([5, 3, 0], [-1, 0, 0], 3)?.entity, root);
  build.updateArchitecturePath(root.id, path.pathId, { points: [[1.7, -8], [1.7, 8]] }); sync();
  assert.equal(walkThrough(physics)?.entity, root, "old passage closes when moved");
  assert.equal(walkThrough(physics, 1.7), null);
  commandBus.undo(); sync(); assert.equal(walkThrough(physics), null);
  commandBus.redo(); sync(); assert.equal(walkThrough(physics)?.entity, root);
  build.removeArchitecturePath(root.id, path.pathId); sync();
  assert.equal(walkThrough(physics, 1.7)?.entity, root);
  assert.equal(physics.world.colliders.len(), 1, "edits replace the collider without accumulating stale walls");
});

test("Rapier model colliders follow empty previews, disable/delete, scene reload and repeated Play", async (t) => {
  const { engine, physics, sync } = await fixture(t);
  const result = build.createArchitectureModel(), root = rootOf(engine, result);
  engine.setPlaying(true); sync();
  assert.equal(physics.world.colliders.len(), 0, "empty preview has no placeholder box collider");
  build.setArchitectureModel(root.id, { forms: [form()] }); sync();
  assert.equal(physics.world.colliders.len(), 1); assert.equal(rayFront(physics)?.entity, root);
  root.getComponent("architecture").setProp("enabled", false); sync();
  assert.equal(physics.world.colliders.len(), 0); assert.equal(rayFront(physics), null);
  root.getComponent("architecture").setProp("enabled", true); sync();
  assert.equal(physics.world.colliders.len(), 1);
  const document = JSON.parse(JSON.stringify(serializeEntity(root)));
  engine.destroyEntity(root); sync();
  assert.equal(physics.world.colliders.len(), 0); assert.equal(rayFront(physics), null);
  const restored = instantiateEntity(engine, document); sync();
  assert.equal(restored.id, result.entityId); assert.equal(rayFront(physics)?.entity, restored);
  assert.equal(physics.world.colliders.len(), 1);
  engine.setPlaying(false); assert.equal(physics.world, null);
  engine.setPlaying(true); sync();
  assert.equal(physics.world.colliders.len(), 1); assert.equal(rayFront(physics)?.entity, restored);
  build.removeArchitectureForm(restored.id, "house"); sync();
  assert.equal(physics.world.colliders.len(), 0); assert.equal(rayFront(physics), null);
  commandBus.undo(); sync();
  assert.equal(physics.world.colliders.len(), 1); assert.equal(rayFront(physics)?.entity, restored);
});

test("enabling Physics later adds concave model-root collision once and honors collision opt-outs", async (t) => {
  const { engine } = await fixture(t, { physicsEnabled: false });
  const root = rootOf(engine, build.createArchitectureModel({ model: { forms: [form()] } }));
  const decoration = rootOf(engine, build.createArchitectureModel({ model: { forms: [form()] }, position: [20, 0, 0], collision: false }));
  assert.equal(root.getComponent("collider"), undefined); assert.equal(decoration.getComponent("collider"), undefined);
  await applyEngineModules(engine, ["architecture", "physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  assert.equal(root.getComponent("collider"), undefined, "mesh collision none prevents an automatic convex placeholder");
  const history = commandBus.undoStack.length;
  assert.equal(addArchitectureColliders(root.id).added, 1);
  assert.equal(root.getComponent("collider").props.shape, "concave");
  assert.equal(addArchitectureColliders(root.id).added, 0);
  assert.equal(addArchitectureColliders(decoration.id).added, 0);
  assert.equal(commandBus.undoStack.length, history + 1);
  engine.setPlaying(true); engine.physics.sync();
  assert.equal(rayFront(engine.physics)?.entity, root); assert.equal(rayFront(engine.physics, 20), null);
  commandBus.undo(); engine.physics.sync();
  assert.equal(root.getComponent("collider"), undefined); assert.equal(rayFront(engine.physics), null);
  commandBus.redo(); engine.physics.sync();
  assert.equal(rayFront(engine.physics)?.entity, root); assert.equal(engine.physics.world.colliders.len(), 1);
});
