import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { Component } from "../src/engine/components/Component.js";
import { registerComponent, unregisterComponent } from "../src/engine/components/registry.js";
import { serializeEntity, instantiateEntity } from "../src/engine/serialize.js";
import { vmSingleton } from "../src/editor/singleton.js";

// These tests exercise the production entity tree, serializer and command bus.
// Components are inert here: geometry/physics/GI have separate runtime gates;
// authoring must not depend on a renderer to preserve references and history.
const componentTypes = ["architecture", "architecturepiece", "mesh", "collider", "terrain"];
function registerFixtures() {
  for (const type of componentTypes) registerComponent(class extends Component {
    static type = type;
    static defaults = type === "architecturepiece" ? { openings: [] } : {};
    onPropChanged() {}
  });
}

function fixture() {
  registerFixtures();
  const listeners = new Map();
  const engine = {
    scene: new THREE.Scene(), entities: new Map(), rootEntities: [], waterSurfaces: new Set(),
    viewOnlyComponents: new Set(), playing: false, sceneName: "Architecture test",
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    emit(event, value) { for (const listener of listeners.get(event) ?? []) listener(value); },
    batchHierarchy(fn) { return fn(); },
    createEntity({ id, name, parent = null } = {}) {
      if (id && engine.entities.has(id)) throw new Error(`Duplicate entity id ${id}`);
      const entity = new Entity(engine, { id, name });
      engine.entities.set(entity.id, entity);
      entity.setParent(parent);
      return entity;
    },
    getEntity(id) { return engine.entities.get(id); },
    destroyEntity(entity) {
      for (const child of [...entity.children]) engine.destroyEntity(child);
      entity.dispose();
      const siblings = entity.parent?.children ?? engine.rootEntities;
      siblings.splice(siblings.indexOf(entity), 1);
      entity.object3D.removeFromParent();
      engine.entities.delete(entity.id);
    },
  };
  vmSingleton("engineInstance", () => ({ instance: null, loader: null })).instance = engine;
  return engine;
}

const authoring = await import("../src/editor/architectureBuild.js");
const { commandBus } = await import("../src/editor/commands/CommandBus.js");
const assemblySettings = (width = 4) => ({
  kind: "assembly", collision: true,
  pieces: [
    { name: "Wall", shape: "wall", size: [width, 3, .2], position: [0, 0, 0], role: "wall", props: { openings: [{ offset: 0, width: 1, height: 2, sill: 0 }] } },
    { name: "Deck", shape: "floor", size: [width, .2, 4], position: [0, 3, 0], role: "floor" },
  ],
});
const reset = () => { const engine = fixture(); commandBus.clearHistory(); return engine; };
const rootOf = (engine, result) => engine.getEntity(result.entityId);
const generatedOf = (engine, root) => engine.getEntity(root.getComponent("architecture").props.generatedRootId);
const piecesOf = (entity) => { const pieces = []; entity.traverse((node) => { if (node.getComponent("architecturepiece")) pieces.push(node); }); return pieces; };
const rounded = (numbers) => numbers.map((number) => Math.round(number * 1e8) / 1e8);
const worldElements = (entity) => { entity.object3D.updateWorldMatrix(true, false); return rounded(entity.object3D.matrixWorld.elements); };

test("create is one undo step with stable IDs, ordinary meshes and concave doorway collision", () => {
  const engine = reset();
  const result = authoring.createArchitecture(assemblySettings(), { name: "Bridge kit" });
  assert.equal(result.pieceCount, 2);
  assert.equal(commandBus.undoStack.length, 1);
  const root = rootOf(engine, result);
  const original = serializeEntity(root);
  root.traverse((entity) => {
    assert.equal(entity.getComponent("level"), undefined);
    assert.equal(entity.getComponent("levelfloor"), undefined);
    const piece = entity.getComponent("architecturepiece");
    if (!piece) return;
    assert.ok(entity.getComponent("mesh"));
    assert.equal(entity.getComponent("mesh").props.collision, "none");
    assert.equal(entity.getComponent("collider").props.shape, "concave");
  });
  commandBus.undo();
  assert.equal(engine.entities.size, 0);
  commandBus.redo();
  assert.deepEqual(serializeEntity(rootOf(engine, result)), original);
});

test("regeneration preserves nested authored branches and undo restores exact transforms, ordering and IDs", () => {
  const engine = reset();
  const result = authoring.createArchitecture(assemblySettings());
  const root = rootOf(engine, result);
  root.setTransform({ position: [10, 5, -7], rotation: [.2, .7, -.1], scale: [2, 2, 2] });
  const generated = generatedOf(engine, root);
  const assembly = generated.children[0].children[0];
  assembly.setTransform({ position: [2, 4, -1], rotation: [.1, -.3, .15] });
  const authored = engine.createEntity({ name: "Hand built mezzanine", parent: assembly });
  authored.setTransform({ position: [1, 2, 3], rotation: [.7, -.2, .3], scale: [.8, 1.2, 2] });
  const nested = engine.createEntity({ name: "Script target", parent: authored });
  nested.setTransform({ position: [0, 1, 2] });
  const original = serializeEntity(root);
  const world = worldElements(authored);
  const historyBefore = commandBus.undoStack.length;
  authoring.rebuildArchitecture(root.id, assemblySettings(8));
  assert.equal(commandBus.undoStack.length, historyBefore + 1);
  assert.strictEqual(engine.getEntity(root.id), root, "root remains the same live entity");
  assert.strictEqual(engine.getEntity(authored.id), authored, "authored references remain live");
  assert.strictEqual(engine.getEntity(nested.id), nested);
  assert.equal(authored.parent.id, root.id);
  assert.deepEqual(worldElements(authored), world);
  assert.equal(engine.getEntity(generated.id), undefined);
  const rebuilt = serializeEntity(root);
  commandBus.undo();
  assert.deepEqual(serializeEntity(root), original);
  assert.strictEqual(engine.getEntity(authored.id), authored);
  commandBus.redo();
  assert.deepEqual(serializeEntity(root), rebuilt);
  assert.deepEqual(worldElements(authored), world);
});

test("invalid generator, parent and material inputs mutate neither scene nor history", () => {
  const engine = reset();
  assert.throws(() => authoring.createArchitecturePiece({ shape: "box", size: [1, NaN, 1] }), /finite/);
  assert.throws(() => authoring.createArchitecture({}, { parentId: "missing" }), /No entity/);
  assert.throws(() => authoring.createArchitecture({}, { position: [1, 2] }), /Position/);
  assert.equal(engine.entities.size, 0);
  assert.equal(commandBus.undoStack.length, 0);
  const root = rootOf(engine, authoring.createArchitecture(assemblySettings()));
  const before = serializeEntity(root);
  assert.throws(() => authoring.applyArchitectureMaterials(root.id, { wall: 42 }), /asset path/);
  assert.throws(() => authoring.rebuildArchitecture(root.id, { kind: "building", footprint: "circle", sides: 48, stairs: false, storeys: 1, maxPieces: 32 }), /budget|exceeds/i);
  assert.deepEqual(serializeEntity(root), before);
  assert.equal(commandBus.undoStack.length, 1);
});

test("freeform pieces and assemblies honor world transforms under rotated, scaled parents", () => {
  const engine = reset();
  const parent = engine.createEntity({ name: "Tilted support" });
  parent.setTransform({ position: [10, 4, 3], rotation: [.1, 1, -.2], scale: [2, 2, 2] });
  const assembly = rootOf(engine, authoring.createArchitectureAssembly({ name: "Sky bridge", parentId: parent.id, position: [-1, 12, 8], rotationY: -.5 }));
  assert.deepEqual(rounded(assembly.object3D.getWorldPosition(new THREE.Vector3()).toArray()), [-1, 12, 8]);
  const piece = rootOf(engine, authoring.createArchitecturePiece({ shape: "ramp", size: [4, 8, 12], parentId: assembly.id, position: [8, 9, 10], rotationY: .8, props: { role: "structure" } }));
  assert.deepEqual(rounded(piece.object3D.getWorldPosition(new THREE.Vector3()).toArray()), [8, 9, 10]);
  assert.ok(!piece.getComponent("levelfloor"));
  assert.equal(piece.getComponent("architecturepiece").props.role, "structure");
  const rotation = new THREE.Euler().setFromQuaternion(piece.object3D.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(Math.abs(rotation.y - .8) < 1e-8);
});

test("role materials survive regeneration and material undo restores settings and every mesh", () => {
  const engine = reset();
  const root = rootOf(engine, authoring.createArchitecture(assemblySettings()));
  const before = serializeEntity(root);
  const result = authoring.applyArchitectureMaterials(root.id, { wall: "materials/Brick.mat", default: "materials/Concrete.mat" });
  assert.equal(result.updated, 2);
  assert.deepEqual(piecesOf(root).map((piece) => piece.getComponent("mesh").props.material), ["materials/Brick.mat", "materials/Concrete.mat"]);
  commandBus.undo();
  assert.deepEqual(serializeEntity(root), before);
  commandBus.redo();
  authoring.rebuildArchitecture(root.id, {});
  assert.deepEqual(piecesOf(root).map((piece) => piece.getComponent("mesh").props.material), ["materials/Brick.mat", "materials/Concrete.mat"]);
});

test("duplicate pins descendant IDs, remaps generated ownership and survives serialized reload", () => {
  const engine = reset();
  const root = rootOf(engine, authoring.createArchitecture(assemblySettings()));
  const copy = rootOf(engine, authoring.duplicateArchitectureAssembly(root.id, { name: "Second span", position: [20, 7, 0] }));
  assert.notEqual(copy.id, root.id);
  const sourceIds = new Set(); root.traverse((entity) => sourceIds.add(entity.id));
  copy.traverse((entity) => assert.ok(!sourceIds.has(entity.id)));
  assert.equal(generatedOf(engine, copy).parent.id, copy.id);
  const copied = serializeEntity(copy);
  commandBus.undo();
  commandBus.redo();
  assert.deepEqual(serializeEntity(engine.getEntity(copy.id)), copied);
  engine.destroyEntity(engine.getEntity(copy.id));
  const restored = instantiateEntity(engine, JSON.parse(JSON.stringify(copied)), null);
  authoring.rebuildArchitecture(restored.id, assemblySettings(6));
  assert.equal(piecesOf(restored).length, 2, "copied generated content must be replaced, not retained as manual content");
  assert.deepEqual(restored.object3D.position.toArray(), [20, 7, 0]);
});

test("terrain fitting reads live mesh transforms and water clearance uses only actual bodies", () => {
  const engine = reset();
  const terrainParent = engine.createEntity({ name: "Terrain parent" });
  terrainParent.setTransform({ position: [20, 3, -8], rotation: [0, Math.PI / 3, 0], scale: [2, 2, 2] });
  const terrainEntity = engine.createEntity({ name: "Terrain", parent: terrainParent });
  const terrain = terrainEntity.addComponent("terrain");
  terrain.mesh = new THREE.Mesh(new THREE.PlaneGeometry(40, 40, 1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  terrainEntity.object3D.add(terrain.mesh);
  terrain.heightAtLocal = () => 4;
  engine.waterSurfaces.add({ enabled: true, getSurfaceHeight: (x, z) => Math.abs(x - 20) < 5 && Math.abs(z + 8) < 5 ? 14 : null });
  const result = authoring.createArchitecture({ ...assemblySettings(), terrainFit: "highest", terrainId: terrainEntity.id, avoidWater: true, waterClearance: 1.5 }, { position: [20, 0, -8], rotationY: Math.PI / 4 });
  const building = generatedOf(engine, rootOf(engine, result)).children[0];
  assert.equal(building.object3D.getWorldPosition(new THREE.Vector3()).y, 15.5);
  const preview = authoring.previewArchitecture({ ...assemblySettings(), terrainFit: "highest", terrainId: terrainEntity.id }, { position: [20, 0, -8] });
  assert.equal(preview.buildings[0].position[1], 11, "terrain local height is transformed by parent scale and translation");
  const count = engine.entities.size;
  const historyCount = commandBus.undoStack.length;
  authoring.previewArchitecture(assemblySettings(), { position: [1000, 0, 1000] });
  assert.equal(engine.entities.size, count);
  assert.equal(commandBus.undoStack.length, historyCount);
  terrain.mesh.geometry.dispose(); terrain.mesh.material.dispose();
});

test("tilted Terrain is raycast against its real geometry and missing physics is reported", () => {
  const engine = reset();
  unregisterComponent("collider");
  const terrainEntity = engine.createEntity({ name: "Tilted terrain" });
  terrainEntity.setTransform({ position: [0, 8, 0], rotation: [Math.PI / 8, 0, 0] });
  const terrain = terrainEntity.addComponent("terrain");
  terrain.mesh = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  terrainEntity.object3D.add(terrain.mesh);
  terrain.heightAtLocal = () => { throw new Error("Tilted terrain must use the mesh raycast"); };
  const result = authoring.createArchitecture({ ...assemblySettings(), terrainFit: "highest", terrainId: terrainEntity.id });
  const building = generatedOf(engine, rootOf(engine, result)).children[0];
  assert.ok(building.object3D.position.y > 8.5 && building.object3D.position.y < 9.5);
  assert.ok(result.warnings.some((warning) => /Physics is disabled/.test(warning)));
  assert.ok(piecesOf(rootOf(engine, result)).every((piece) => !piece.getComponent("collider")));
  terrain.mesh.geometry.dispose(); terrain.mesh.material.dispose();
});

test("viewport wall gestures create only Architecture, support openings and erase, and undo the first assembly together", async () => {
  const engine = reset();
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const { setupBlockoutTool } = await import("../src/editor/blockoutTool.js");
  const { armArchitectureTool, disarmArchitectureTool, getArchitectureDrawContext, setArchitectureDrawShape } = await import("../src/editor/architectureTool.js");
  const { buildBlockoutGeometry } = await import("../src/modules/level-design/blockoutGeometry.js");
  const canvas = new EventTarget();
  canvas.style = {};
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100);
  camera.position.set(0, 20, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const viewport = { camera, orbit: { enabled: true, mouseButtons: { MIDDLE: THREE.MOUSE.DOLLY } } };
  const teardown = setupBlockoutTool(canvas, viewport);
  const pointer = (target, type, x, y) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, button: 0, ctrlKey: false, altKey: false });
    target.dispatchEvent(event);
  };
  let mesh;
  try {
    armArchitectureTool({ shape: "wall", elevation: 2, height: 4, thickness: .3, grid: 1, color: "#aabbcc" });
    assert.ok(getArchitectureDrawContext());
    assert.equal(commandBus.undoStack.length, 0, "arming a gesture does not mutate the scene");
    pointer(canvas, "pointerdown", 80, 100);
    pointer(canvas, "pointermove", 120, 100);
    pointer(window, "pointerup", 120, 100);
    assert.equal(commandBus.undoStack.length, 1);
    assert.equal(engine.rootEntities.length, 1);
    const root = engine.rootEntities[0];
    assert.ok(root.getComponent("architecture"));
    const wall = piecesOf(root)[0];
    assert.deepEqual(wall.getComponent("architecturepiece").props.size, [4, 4, .3]);
    assert.equal(wall.getComponent("architecturepiece").props.color, "#aabbcc");
    assert.deepEqual(wall.object3D.position.toArray().map((number) => number || 0), [0, 2, 0]);
    assert.ok([...engine.entities.values()].every((entity) => !entity.getComponent("level") && !entity.getComponent("levelfloor")));
    const original = serializeEntity(root);
    // Raycast the production geometry while keeping the authoring component
    // fixture GPU-independent. Hit the top of the wall from the plan camera.
    const { geometry } = buildBlockoutGeometry("wall", wall.getComponent("architecturepiece").props);
    mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData.entityId = wall.id; wall.object3D.add(mesh); engine.scene.updateMatrixWorld(true);
    setArchitectureDrawShape("opening");
    pointer(canvas, "pointerdown", 100, 100);
    assert.equal(wall.getComponent("architecturepiece").props.openings.length, 1);
    commandBus.undo();
    assert.deepEqual(serializeEntity(root), original);
    setArchitectureDrawShape("erase");
    pointer(canvas, "pointerdown", 100, 100);
    assert.equal(engine.getEntity(wall.id), undefined);
    commandBus.undo();
    assert.equal(engine.getEntity(wall.id).id, wall.id);
    commandBus.undo();
    assert.equal(engine.entities.size, 0, "first stroke removes its otherwise empty assembly too");
    assert.equal(getArchitectureDrawContext(), null, "undo of the target disarms drawing safely");
    commandBus.redo();
    assert.deepEqual(serializeEntity(engine.getEntity(root.id)), original);
  } finally {
    disarmArchitectureTool(); teardown(); mesh?.geometry.dispose(); mesh?.material.dispose();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});

test("Escape cancels an in-progress architecture stroke and restores camera controls", async () => {
  const engine = reset();
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const { setupBlockoutTool } = await import("../src/editor/blockoutTool.js");
  const { armArchitectureTool, disarmArchitectureTool } = await import("../src/editor/architectureTool.js");
  const { dispatchLevelToolKey } = await import("../src/editor/levelTool.js");
  const canvas = new EventTarget(); canvas.style = {};
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100);
  camera.position.set(0, 20, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const viewport = { camera, orbit: { enabled: true, mouseButtons: { MIDDLE: THREE.MOUSE.DOLLY } } };
  const teardown = setupBlockoutTool(canvas, viewport);
  try {
    armArchitectureTool({ shape: "wall" });
    const event = new Event("pointerdown", { cancelable: true });
    Object.assign(event, { clientX: 80, clientY: 100, button: 0, ctrlKey: false, altKey: false });
    canvas.dispatchEvent(event);
    assert.equal(viewport.orbit.enabled, false);
    assert.equal(dispatchLevelToolKey({ key: "Escape" }), true);
    assert.equal(viewport.orbit.enabled, true);
    window.dispatchEvent(new Event("pointerup"));
    assert.equal(engine.entities.size, 0);
    assert.equal(commandBus.undoStack.length, 0);
  } finally {
    disarmArchitectureTool(); teardown();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});

test("preset stamping previews without entities, repeats clicks with independent undo, rotates and unsnaps", async () => {
  const engine = reset();
  const previousWindow = globalThis.window; globalThis.window = new EventTarget();
  const placement = await import("../src/editor/architecturePlacementTool.js");
  const canvas = new EventTarget(); canvas.style = {};
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100);
  camera.position.set(0, 20, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const viewport = { camera, orbit: { enabled: true, mouseButtons: { MIDDLE: THREE.MOUSE.DOLLY } } };
  const teardown = placement.setupArchitecturePlacementTool(canvas, viewport);
  const pointer = (target, type, x, y, modifiers = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, button: 0, ctrlKey: false, altKey: false, ...modifiers });
    target.dispatchEvent(event);
    return event;
  };
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(50, 50).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
  surface.position.y = 2;
  try {
    placement.armArchitecturePlacement({ settings: assemblySettings(), grid: 2, elevation: 5 });
    assert.equal(engine.entities.size, 0);
    assert.equal(commandBus.undoStack.length, 0);
    const ghost = engine.scene.children.find((object) => object.userData.architecturePlacementPreview);
    assert.ok(ghost);
    assert.equal(ghost.visible, false);
    let disposed = 0;
    ghost.children[0].geometry.addEventListener("dispose", () => disposed++);
    pointer(canvas, "pointermove", 83, 100);
    assert.equal(ghost.visible, true);
    assert.equal(placement.getArchitecturePlacementState().position[0], -2);
    assert.equal(placement.getArchitecturePlacementState().position[1], 5, "empty space uses the fallback plane elevation");
    engine.scene.add(surface); engine.emit("hierarchy-changed");
    pointer(canvas, "pointermove", 83, 100);
    assert.ok(Math.abs(placement.getArchitecturePlacementState().position[1] - 7) < 1e-8, "Elevation is added above a mesh hit");
    assert.equal(placement.dispatchArchitecturePlacementKey({ key: "r" }), true);
    assert.equal(ghost.rotation.y, Math.PI / 2);
    assert.equal(placement.dispatchArchitecturePlacementKey({ key: "r", shiftKey: true }), true);
    assert.equal(ghost.rotation.y, 0);
    pointer(canvas, "pointermove", 83, 100, { ctrlKey: true });
    assert.ok(Math.abs(placement.getArchitecturePlacementState().position[0] + 1.7) < 1e-8);
    const overlay = new EventTarget();
    pointer(overlay, "pointerdown", 80, 100); pointer(window, "pointerup", 80, 100);
    assert.equal(engine.entities.size, 0, "overlay controls cannot stamp through the canvas");
    pointer(canvas, "pointerdown", 60, 100, { altKey: true }); pointer(window, "pointerup", 60, 100, { altKey: true });
    assert.equal(engine.entities.size, 0, "Alt belongs to orbit");
    assert.equal(viewport.orbit.enabled, true);
    for (const x of [60, 140]) {
      pointer(canvas, "pointermove", x, 100);
      pointer(canvas, "pointerdown", x, 100);
      assert.equal(viewport.orbit.enabled, false);
      pointer(window, "pointerup", x, 100);
    }
    assert.equal(engine.rootEntities.length, 2);
    assert.equal(commandBus.undoStack.length, 2);
    assert.deepEqual(engine.rootEntities.map((root) => rounded(root.object3D.position.toArray()).map((n) => n || 0)), [[-4, 7, 0], [4, 7, 0]]);
    assert.equal(placement.getArchitecturePlacementState().active, true);
    const second = serializeEntity(engine.rootEntities[1]);
    commandBus.undo();
    assert.equal(engine.rootEntities.length, 1);
    commandBus.redo();
    assert.deepEqual(serializeEntity(engine.getEntity(second.id)), second);
    placement.dispatchArchitecturePlacementKey({ key: "Escape" });
    assert.equal(placement.getArchitecturePlacementState().active, false);
    assert.ok(!engine.scene.children.includes(ghost));
    assert.equal(disposed, 1, "ghost buffers are disposed when placement exits");
    assert.equal(viewport.orbit.mouseButtons.MIDDLE, THREE.MOUSE.DOLLY);
  } finally {
    placement.disarmArchitecturePlacement(); teardown();
    surface.geometry.dispose(); surface.material.dispose();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});

test("stamp ghost uses the same live terrain fitting as creation and is mutually exclusive with drawing", async () => {
  const engine = reset();
  const previousWindow = globalThis.window; globalThis.window = new EventTarget();
  const placement = await import("../src/editor/architecturePlacementTool.js");
  const draw = await import("../src/editor/architectureTool.js");
  const terrainEntity = engine.createEntity({ name: "Transformed Terrain" });
  terrainEntity.setTransform({ position: [0, 3, 0], scale: [2, 2, 2], rotation: [0, .4, 0] });
  const terrain = terrainEntity.addComponent("terrain");
  terrain.mesh = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
  terrain.heightAtLocal = () => 4;
  terrainEntity.object3D.add(terrain.mesh);
  const canvas = new EventTarget(); canvas.style = {};
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 });
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100);
  camera.position.set(0, 20, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const viewport = { camera, orbit: { enabled: true, mouseButtons: { MIDDLE: THREE.MOUSE.DOLLY } } };
  const teardown = placement.setupArchitecturePlacementTool(canvas, viewport);
  const pointer = (target, type) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: 100, clientY: 100, button: 0, ctrlKey: false, altKey: false });
    target.dispatchEvent(event);
  };
  try {
    draw.armArchitectureTool({ shape: "wall" });
    placement.armArchitecturePlacement({ settings: { ...assemblySettings(), terrainFit: "highest", terrainId: terrainEntity.id } });
    assert.equal(draw.getArchitectureDrawContext(), null);
    pointer(canvas, "pointermove");
    const ghost = engine.scene.children.find((object) => object.userData.architecturePlacementPreview);
    const previewY = ghost.children[0].getWorldPosition(new THREE.Vector3()).y;
    assert.equal(previewY, 11);
    pointer(canvas, "pointerdown"); pointer(window, "pointerup");
    const root = engine.getEntity(placement.getArchitecturePlacementState().lastEntityId);
    const building = generatedOf(engine, root).children[0];
    assert.equal(building.object3D.getWorldPosition(new THREE.Vector3()).y, previewY);
    engine.playing = true; engine.emit("play-changed", true);
    assert.ok(!engine.scene.children.some((object) => object.userData.architecturePlacementPreview), "Play disposes the editor ghost");
    engine.playing = false; engine.emit("play-changed", false);
    draw.armArchitectureTool({ shape: "floor" });
    assert.equal(placement.getArchitecturePlacementState().active, false);
    assert.ok(!engine.scene.children.includes(ghost));
    assert.ok(draw.getArchitectureDrawContext());
    placement.armArchitecturePlacement({ settings: assemblySettings() });
    pointer(canvas, "pointermove");
    commandBus.clearHistory();
    assert.equal(placement.getArchitecturePlacementState().active, false, "scene-swap history reset cancels placement");
    assert.ok(!engine.scene.children.some((object) => object.userData.architecturePlacementPreview));
    placement.armArchitecturePlacement({ settings: assemblySettings() });
    pointer(canvas, "pointermove");
    engine.emit("scene-load-start", {});
    assert.equal(placement.getArchitecturePlacementState().active, false, "runtime scene load cancels placement");
  } finally {
    placement.disarmArchitecturePlacement(); draw.disarmArchitectureTool(); teardown();
    terrain.mesh.geometry.dispose(); terrain.mesh.material.dispose();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
});
