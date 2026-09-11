import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import { Component } from "../src/engine/components/Component.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { registerComponent } from "../src/engine/components/registry.js";
import { serializeEntity, instantiateEntity } from "../src/engine/serialize.js";
import { ArchitectureComponent } from "../src/modules/architecture/ArchitectureComponent.js";
import { ArchitectureEnvironment } from "../src/modules/architecture/architectureEnvironment.js";
import { vmSingleton } from "../src/editor/singleton.js";
import { commandBus } from "../src/editor/commands/CommandBus.js";
import * as build from "../src/editor/architectureModelBuild.js";

class TestCollider extends Component {
  static type = "collider";
  onPropChanged() {}
}
function fixture(t) {
  registerComponent(MeshComponent); registerComponent(ArchitectureComponent); registerComponent(TestCollider);
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], viewOnlyComponents: new Set(), playing: false, dirtyColliders: 0 });
  engine.physics = { markDirty() { engine.dirtyColliders++; } };
  engine.onPreRender = (fn) => engine.on("preRender", fn);
  engine.batchHierarchy = (fn) => fn();
  engine.getEntity = (id) => engine.entities.get(id);
  engine.createEntity = ({ id, name, parent = null } = {}) => {
    if (id && engine.entities.has(id)) throw new Error("Duplicate entity");
    const entity = new Entity(engine, { id, name }); engine.entities.set(entity.id, entity); entity.setParent(parent); return entity;
  };
  engine.destroyEntity = (entity) => {
    for (const child of [...entity.children]) engine.destroyEntity(child);
    entity.dispose();
    const siblings = entity.parent?.children ?? engine.rootEntities;
    siblings.splice(siblings.indexOf(entity), 1); entity.object3D.removeFromParent(); engine.entities.delete(entity.id);
    engine.emit("hierarchy-changed");
  };
  engine.architecture = new ArchitectureEnvironment(engine);
  vmSingleton("engineInstance", () => ({ instance: null, loader: null })).instance = engine;
  commandBus.clearHistory();
  t.after(() => {
    if (commandBus.previewing) commandBus.cancelPreview();
    for (const root of [...engine.rootEntities]) engine.destroyEntity(root);
    engine.architecture.dispose(); commandBus.clearHistory();
  });
  return engine;
}
const form = (patch = {}) => ({ id: "house", shape: "box", position: [0, 0, 0], size: [6, 4, 6], rotationY: 0, color: "#ddc7a5", roof: "hip", roofHeight: 1.2, windows: false, ...patch });
const rootOf = (engine, result) => engine.getEntity(result.entityId);
const modelOf = (root) => root.getComponent("architecture").props.model;

test("live models serialize one indexed multi-material mesh, preserve picking IDs, and redo exact documents", async (t) => {
  const engine = fixture(t);
  const result = build.createArchitectureModel({ model: { forms: [form()] }, position: [7, 2, -4] });
  const root = rootOf(engine, result), architecture = root.getComponent("architecture");
  assert.equal(engine.entities.size, 1); assert.equal(root.children.length, 0);
  assert.equal(root.getComponent("architecturepiece"), undefined);
  assert.equal(root.getComponent("collider").props.shape, "concave");
  assert.equal(root.getComponent("mesh").props.collision, "none");
  assert.ok(architecture.geometry.index.count > 0); assert.ok(architecture.geometry.groups.length > 1);
  assert.equal(architecture.mesh.geometry, architecture.geometry);
  assert.equal(architecture.mesh.userData.entityId, root.id);
  assert.equal(architecture.mesh.userData.architectureSurfaces, architecture.surfaces);
  root.object3D.updateWorldMatrix(true, true);
  const ray = new THREE.Raycaster(new THREE.Vector3(7, 4.5, -20), new THREE.Vector3(0, 0, 1));
  const hit = ray.intersectObject(architecture.mesh)[0];
  assert.ok(hit); assert.equal(architecture.surfaceAt(hit.faceIndex).formId, "house");
  assert.equal(architecture.surfaceAt(null), null);
  await Promise.resolve(); assert.equal(architecture.mesh.geometry, architecture.geometry);
  const original = serializeEntity(root), indexCount = architecture.geometry.index.count;
  commandBus.undo(); assert.equal(engine.entities.size, 0);
  commandBus.redo(); assert.deepEqual(serializeEntity(rootOf(engine, result)), original);
  assert.equal(rootOf(engine, result).getComponent("architecture").geometry.index.count, indexCount);
  engine.destroyEntity(rootOf(engine, result));
  const restored = instantiateEntity(engine, JSON.parse(JSON.stringify(original)));
  assert.deepEqual(serializeEntity(restored), original);
  assert.equal(restored.getComponent("architecture").mesh.geometry.index.count, indexCount);
});

test("first drawing drag creates one root in one undo; later drags and cancellation preserve references", (t) => {
  const engine = fixture(t);
  commandBus.beginPreview("Draw building");
  const result = build.createArchitectureModel();
  const root = rootOf(engine, result);
  assert.equal(root.getComponent("collider").enabled, false, "empty preview roots have no physical placeholder");
  build.setArchitectureModel(root.id, { forms: [form({ size: [2, 4, 2] })] });
  build.setArchitectureModel(root.id, { forms: [form({ size: [8, 4, 7] })] });
  assert.equal(root.getComponent("collider").enabled, true);
  commandBus.endPreview(); assert.equal(commandBus.undoStack.length, 1);
  const original = serializeEntity(root);
  commandBus.undo(); assert.equal(engine.entities.size, 0);
  commandBus.redo(); assert.deepEqual(serializeEntity(rootOf(engine, result)), original);
  const live = rootOf(engine, result), document = structuredClone(modelOf(live));
  commandBus.beginPreview("Raise roof");
  build.updateArchitectureForm(live.id, "house", { size: [8, 6, 7] });
  build.updateArchitectureForm(live.id, "house", { size: [8, 9, 7] });
  commandBus.cancelPreview();
  assert.equal(rootOf(engine, result), live); assert.deepEqual(modelOf(live), document);
  assert.equal(commandBus.undoStack.length, 1);
  commandBus.beginPreview("Cancelled new building");
  build.addArchitectureForm(null, form({ id: "cancelled" }));
  commandBus.cancelPreview(); assert.equal(engine.entities.size, 1);
});

test("form, facade and path CRUD edits the document with undo and guards invalid references", (t) => {
  const engine = fixture(t);
  const first = build.addArchitectureForm(null, form()); const root = rootOf(engine, first);
  const second = build.addArchitectureForm(root.id, form({ id: "tower", shape: "round", position: [3, 0, 0], size: [4, 8, 4] }));
  assert.equal(second.formId, "tower"); assert.equal(engine.entities.size, 1);
  const opening = build.addArchitectureOpening(root.id, { formId: "house", position: [0, 1, -3], normal: [0, 0, -1], kind: "door", width: 1.4, height: 2 });
  build.updateArchitectureOpening(root.id, opening.openingId, { width: 1.8 });
  const path = build.addArchitecturePath(root.id, { points: [[0, -3], [0, -9]], width: 2 });
  build.updateArchitecturePath(root.id, path.pathId, { width: 3 });
  assert.equal(modelOf(root).paths[0].width, 3);
  const before = structuredClone(modelOf(root));
  build.removeArchitectureForm(root.id, "house");
  assert.equal(modelOf(root).forms.length, 1); assert.equal(modelOf(root).openings.length, 0);
  commandBus.undo(); assert.deepEqual(modelOf(root), before);
  const count = commandBus.undoStack.length;
  assert.throws(() => build.addArchitectureForm(root.id, form()), /already exists/);
  assert.throws(() => build.updateArchitectureOpening(root.id, opening.openingId, { formId: "missing" }), /existing building form/);
  assert.throws(() => build.updateArchitecturePath(root.id, path.pathId, { points: [[0, 0]] }), /incomplete/);
  assert.throws(() => build.updateArchitectureForm(root.id, "missing", {}), /does not exist/);
  assert.equal(commandBus.undoStack.length, count); assert.deepEqual(modelOf(root), before);
  build.removeArchitectureOpening(root.id, opening.openingId); assert.equal(modelOf(root).openings.length, 0);
  build.removeArchitecturePath(root.id, path.pathId); assert.equal(modelOf(root).paths.length, 0);
});

test("world placement under transformed parents remains exact and rejects unrepresentable shear", (t) => {
  const engine = fixture(t), parent = engine.createEntity({ name: "Site" });
  parent.setTransform({ position: [10, 4, -8], rotation: [.1, .5, -.2], scale: [2, 2, 2] });
  const result = build.addArchitectureForm(null, form(), { parentId: parent.id, position: [4, 8, 12] });
  const root = rootOf(engine, result); root.object3D.updateWorldMatrix(true, false);
  const wanted = new THREE.Matrix4().makeTranslation(4, 8, 12);
  assert.ok(root.object3D.matrixWorld.elements.every((value, i) => Math.abs(value - wanted.elements[i]) < 1e-7));
  assert.equal(build.getArchitectureModelRoot(root.id), root);
  const attached = engine.createEntity({ parent: root }); assert.equal(build.getArchitectureModelRoot(attached), root);
  parent.setTransform({ scale: [2, 1, 3] });
  const count = commandBus.undoStack.length;
  assert.throws(() => build.createArchitectureModel({ parentId: parent.id }), /shear/);
  assert.equal(commandBus.undoStack.length, count);
});

test("geometry swaps release resources once, retain shared material programs and invalidate collision", (t) => {
  const engine = fixture(t);
  const a = rootOf(engine, build.addArchitectureForm(null, form()));
  const b = rootOf(engine, build.addArchitectureForm(null, form()));
  const architecture = a.getComponent("architecture"), geometry = architecture.geometry;
  const material = architecture.mesh.material[0];
  assert.equal(material, b.getComponent("architecture").mesh.material[0]);
  let disposedGeometry = 0, disposedMaterial = 0;
  geometry.addEventListener("dispose", () => disposedGeometry++);
  material.addEventListener("dispose", () => disposedMaterial++);
  const dirty = engine.dirtyColliders;
  build.updateArchitectureForm(a.id, "house", { size: [7, 6, 8] });
  assert.equal(disposedGeometry, 1); assert.equal(disposedMaterial, 0);
  assert.equal(architecture.mesh.material[0], material); assert.ok(engine.dirtyColliders > dirty);
  let lastGeometryDisposals = 0;
  architecture.geometry.addEventListener("dispose", () => lastGeometryDisposals++);
  engine.destroyEntity(a); assert.equal(lastGeometryDisposals, 1); assert.equal(disposedMaterial, 0);
  engine.destroyEntity(b); assert.equal(disposedMaterial, 1);
});

test("live forms and paths provide reversible foliage exclusions and enclosed GI capture rooms", (t) => {
  const engine = fixture(t);
  const root = rootOf(engine, build.createArchitectureModel({ model: { forms: [form()], paths: [{ id: "walk", points: [[0, -3], [0, -9]], width: 2 }] }, foliagePadding: 0 }));
  const architecture = root.getComponent("architecture");
  let mask = engine.architecture.snapshot();
  assert.ok(mask.excludes([0, 0, 0])); assert.ok(mask.excludes([0, 0, -8])); assert.equal(mask.excludes([8, 0, 8]), false);
  const rooms = architecture.rooms(); assert.equal(rooms.length, 1);
  assert.ok(rooms[0].size.every((value) => value > 1));
  root.setTransform({ position: [20, 3, 10] }); engine.emit("transform-changed", { entityId: root.id }); mask = engine.architecture.snapshot();
  assert.equal(mask.excludes([0, 0, 0]), false); assert.ok(mask.excludes([20, 0, 10]));
  assert.ok(architecture.rooms()[0].capture[1] > 3 && architecture.rooms()[0].capture[1] < 7);
  architecture.setProp("enabled", false); mask = engine.architecture.snapshot();
  assert.equal(mask.excludes([20, 0, 10]), false); assert.equal(architecture.mesh.visible, false);
  architecture.setProp("enabled", true); mask = engine.architecture.snapshot();
  assert.ok(mask.excludes([20, 0, 10])); assert.equal(architecture.mesh.visible, true);
  build.updateArchitectureForm(root.id, "house", { roof: "none" }); assert.equal(architecture.rooms().length, 0);
});

test("a model attached to a bare entity restores mesh dependencies in serialization order", (t) => {
  const engine = fixture(t), root = engine.createEntity();
  const architecture = root.addComponent("architecture", { model: { forms: [form()] } });
  const original = serializeEntity(root);
  assert.deepEqual(original.components.map((component) => component.type), ["mesh", "architecture"]);
  assert.ok(architecture.geometry.index.count);
  engine.destroyEntity(root);
  const restored = instantiateEntity(engine, original);
  assert.equal(restored.components.size, 2); assert.equal(restored.getComponent("architecture").mesh, restored.getComponent("mesh").mesh);
});

test("form transforms keep facade anchors on their form and remap normals exactly once", (t) => {
  const engine = fixture(t), root = rootOf(engine, build.addArchitectureForm(null, form()));
  const added = build.addArchitectureOpening(root.id, { formId: "house", position: [1, 1.5, -3], normal: [0, 0, -1], kind: "window", width: 1, height: 1 });
  const original = structuredClone(modelOf(root));
  build.updateArchitectureForm(root.id, "house", { position: [10, 2, -5], size: [12, 8, 6], rotationY: Math.PI / 2 });
  const opening = modelOf(root).openings.find(row => row.id === added.openingId);
  assert.ok(new THREE.Vector3(...opening.position).distanceTo(new THREE.Vector3(7, 5, -7)) < 1e-8);
  assert.ok(new THREE.Vector3(...opening.normal).distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-8);
  assert.equal(opening.width, 1); assert.equal(opening.height, 1);
  const edited = structuredClone(modelOf(root));
  commandBus.undo(); assert.deepEqual(modelOf(root), original);
  commandBus.redo(); assert.deepEqual(modelOf(root), edited);
  build.setArchitectureModel(root.id, edited); assert.deepEqual(modelOf(root), edited, "raw documents do not apply a second anchor transform");
});

test("mesh dependency rebuilds and disabled scene reloads retain the live model ownership", async (t) => {
  const engine = fixture(t), root = rootOf(engine, build.addArchitectureForm(null, form()));
  const architecture = root.getComponent("architecture"), meshComponent = root.getComponent("mesh");
  const previousGeometry = architecture.geometry, material = architecture.mesh.material[0];
  let disposals = 0; previousGeometry.addEventListener("dispose", () => disposals++);
  meshComponent.setProp("geometry", "sphere");
  assert.equal(disposals, 1); assert.notEqual(architecture.geometry, previousGeometry);
  assert.equal(architecture.mesh, meshComponent.mesh); assert.equal(architecture.mesh.geometry, architecture.geometry);
  assert.equal(architecture.mesh.material[0], material);
  await Promise.resolve(); assert.equal(architecture.mesh.material[0], material);
  architecture.setProp("enabled", false);
  const document = serializeEntity(root);
  engine.destroyEntity(root);
  const restored = instantiateEntity(engine, document), component = restored.getComponent("architecture");
  assert.equal(component.mesh.visible, false); assert.equal(restored.getComponent("collider").enabled, false);
  component.setProp("collision", false); component.setProp("collision", true);
  assert.equal(restored.getComponent("collider").enabled, false, "collision toggles cannot enable a disabled architecture");
  component.setProp("enabled", true);
  assert.equal(component.mesh.visible, true); assert.equal(restored.getComponent("collider").enabled, true);
});

test("terrain preview translates the existing indexed shell and commits collision only once", (t) => {
  const engine = fixture(t);
  const root = rootOf(engine, build.createArchitectureModel({ model: { forms: [form(), form({ id: "remote", position: [20, 0, 0] })] } }));
  const architecture = root.getComponent("architecture"), source = structuredClone(modelOf(root));
  const geometry = architecture.geometry, position = geometry.attributes.position;
  const material = architecture.mesh.material, before = Array.from(position.array);
  const colliders = engine.dirtyColliders, depth = commandBus.undoStack.length;
  const events = []; engine.on("component-changed", info => events.push(info));
  const moved = structuredClone(source); moved.forms[0].position[1] += 2;
  architecture.applyTerrainModel(moved, { preview: true });
  assert.equal(architecture.geometry, geometry, "a dab reuses the live geometry");
  assert.equal(architecture.mesh.material, material, "preview retains pooled render materials");
  assert.equal(engine.dirtyColliders, colliders, "no physics recook during preview");
  assert.equal(events.length, 0, "no expensive geometry fanout during the dab");
  assert.equal(commandBus.undoStack.length, depth);
  assert.deepEqual(source.forms[0].position, [0, 0, 0], "input snapshots remain unchanged");
  for (const surface of architecture.surfaces) for (let i = surface.start; i < surface.start + surface.count; i++) {
    const index = geometry.index.getX(i);
    assert.ok(Math.abs(position.getY(index) - before[index * 3 + 1] - (surface.formId === "house" ? 2 : 0)) < 1e-5);
  }
  assert.equal(architecture.footprintPieces()[0].entity.object3D.position.y, 2);
  root.object3D.updateWorldMatrix(true, true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 4.5, -20), new THREE.Vector3(0, 0, 1));
  const hit = ray.intersectObject(architecture.mesh)[0];
  assert.equal(architecture.surfaceAt(hit.faceIndex).formId, "house", "picking follows the moved facade");
  architecture.applyTerrainModel(source, { preview: true });
  for (let i = 0; i < before.length; i++) assert.ok(Math.abs(position.array[i] - before[i]) < 1e-5);
  architecture.applyTerrainModel(source, { preview: false });
  assert.notEqual(architecture.geometry, geometry, "commit rebuilds clipped paths and supports even after a zero final displacement");
  assert.equal(engine.dirtyColliders, colliders + 1);
  assert.equal(events.filter(info => info.componentType === "mesh").length, 1);
  assert.equal(events.filter(info => info.terrainFollowing).length, 1);
  assert.equal(commandBus.undoStack.length, depth);
});
