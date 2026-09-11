import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { registerComponent } from "../src/engine/components/registry.js";
import { serializeEntity, instantiateEntity } from "../src/engine/serialize.js";
import { TerrainComponent } from "../src/modules/terrain/TerrainComponent.js";
import { ArchitectureComponent } from "../src/modules/architecture/ArchitectureComponent.js";
import { ArchitecturePieceComponent } from "../src/modules/architecture/ArchitecturePieceComponent.js";
import { ArchitectureTerrainSystem } from "../src/modules/architecture/ArchitectureTerrainSystem.js";
import { captureTerrainSurface, sampleTerrainSurface } from "../src/modules/architecture/terrainSurface.js";
import { vmSingleton } from "../src/editor/singleton.js";
import { commandBus } from "../src/editor/commands/CommandBus.js";
import { SetTerrainHeightsCommand } from "../src/editor/commands/terrainCommands.js";
import { createArchitectureModel, updateArchitectureForm } from "../src/editor/architectureModelBuild.js";

function fixture(t) {
  for (const cls of [MeshComponent, TerrainComponent, ArchitectureComponent, ArchitecturePieceComponent]) registerComponent(cls);
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], viewOnlyComponents: new Set(), playing: false, colliderUpdates: 0 });
  engine.physics = { markDirty() { engine.colliderUpdates++; } };
  engine.getEntity = id => engine.entities.get(id);
  engine.onPreRender = fn => engine.on("preRender", fn);
  engine.batchHierarchy = fn => fn();
  engine.createEntity = ({ id, name, parent = null } = {}) => { const entity = new Entity(engine, { id, name }); engine.entities.set(entity.id, entity); entity.setParent(parent); return entity; };
  engine.destroyEntity = entity => {
    for (const child of [...entity.children]) engine.destroyEntity(child);
    entity.dispose(); const siblings = entity.parent?.children ?? engine.rootEntities; siblings.splice(siblings.indexOf(entity), 1);
    entity.object3D.removeFromParent(); engine.entities.delete(entity.id); engine.emit("hierarchy-changed");
  };
  vmSingleton("engineInstance", () => ({ instance: null, loader: null })).instance = engine;
  commandBus.clearHistory();
  engine.architectureTerrain = new ArchitectureTerrainSystem(engine);
  const tick = () => { engine.architectureTerrain.update({ force: true }); assert.deepEqual([...engine.architectureTerrain.errors], []); };
  t.after(() => { engine.architectureTerrain.dispose(); for (const root of [...engine.rootEntities]) engine.destroyEntity(root); commandBus.clearHistory(); });
  return { engine, tick, system: engine.architectureTerrain };
}
function terrain(engine, { parent = null, size = 40, resolution = 40 } = {}) {
  const entity = engine.createEntity({ parent }); entity.addComponent("mesh", { collision: "none" });
  return entity.addComponent("terrain", { size, resolution, splatResolution: 16 });
}
const form = (id, x = 0, y = .4, z = 0, size = [4, 3, 4]) => ({ id, shape: "box", position: [x, y, z], size, roof: "flat", windows: false });
const model = root => root.getComponent("architecture").props.model;
const rootModel = (engine, forms, options = {}) => engine.getEntity(createArchitectureModel({ model: { forms }, ...options }).entityId);
const dab = (ground, x, z, { tool = "raise", strength = .5, radius = 3 } = {}) => ground.applyHeightBrush(new THREE.Vector3(x, 0, z), { tool, radius, strength, hardness: .85 });
const commit = (ground, before) => { ground.commitHeights(); commandBus.execute(new SetTerrainHeightsCommand(ground.entity.id, before, ground.props.heights)); };
const yOf = (root, id) => model(root).forms.find(form => form.id === id).position[1];
const near = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) < epsilon, `${a} should equal ${b}`);

test("terrain dabs move connected buildings live once per frame, preserve distant lots, and undo exact poses", t => {
  const { engine, tick, system } = fixture(t), ground = terrain(engine);
  const root = engine.getEntity(createArchitectureModel({ model: { forms: [form("near", -6), form("upper", -6, 3.4, 0, [3, 2.5, 3]), form("far", 9)], openings: [{ id: "window", formId: "near", position: [-6, 1.9, -2], normal: [0, 0, -1], width: 1, height: 1 }] } }).entityId);
  tick(); const component = root.getComponent("architecture"), original = structuredClone(model(root)), geometry = component.geometry;
  const before = ground.props.heights, history = commandBus.undoStack.length; engine.colliderUpdates = 0;
  let applies = 0; const apply = component.applyTerrainModel.bind(component); component.applyTerrainModel = (...args) => { applies++; return apply(...args); };
  dab(ground, -6, 0); dab(ground, -6, 0);
  assert.deepEqual(model(root), original, "dabs queue until pre-render"); tick();
  near(yOf(root, "near"), 1.4); near(yOf(root, "upper"), 4.4); assert.equal(yOf(root, "far"), .4);
  near(model(root).openings[0].position[1], 2.9);
  assert.equal(applies, 1); assert.equal(component.geometry, geometry); assert.equal(engine.colliderUpdates, 0);
  assert.equal(commandBus.undoStack.length, history);
  commit(ground, before); tick();
  assert.notEqual(component.geometry, geometry); assert.ok(engine.colliderUpdates > 0); assert.equal(commandBus.undoStack.length, history + 1);
  const edited = structuredClone(model(root));
  for (let i = 0; i < 3; i++) {
    commandBus.undo(); tick(); assert.deepEqual(model(root), original);
    commandBus.redo(); tick(); assert.deepEqual(model(root), edited);
  }
  const bindings = component.props.terrainBindings, cachedGroups = system.records.get(component).groups;
  let groupRebuilds = 0, samples = 0;
  const groups = system._groups.bind(system), height = system._height.bind(system);
  system._groups = (...args) => { groupRebuilds++; return groups(...args); };
  system._height = (...args) => { samples++; return height(...args); };
  tick(); tick(); tick();
  assert.equal(groupRebuilds, 0); assert.equal(samples, 0); assert.equal(system.records.get(component).groups, cachedGroups);
  assert.equal(component.props.terrainBindings, bindings, "idle polling does not rewrite serialized bindings");
});

test("small off-grid peaks lift foundations while peaks in a courtyard remain uncovered", t => {
  const { engine, tick } = fixture(t), ground = terrain(engine, { resolution: 80 });
  const root = rootModel(engine, [form("foundation")]); tick();
  dab(ground, .5, .5, { radius: .2, strength: 2.5 }); tick(); near(yOf(root, "foundation"), 2.9);
  ground.commitHeights(); tick(); engine.destroyEntity(root);
  ground.heightsArray.fill(0); ground.commitHeights(); tick();
  const courtyard = rootModel(engine, [form("north", 0, .4, -3.5, [8, 3, 1]), form("south", 0, .4, 3.5, [8, 3, 1]), form("east", 3.5, .4, 0, [1, 3, 6]), form("west", -3.5, .4, 0, [1, 3, 6])]); tick();
  const original = structuredClone(model(courtyard));
  dab(ground, 0, 0, { radius: 1.3, strength: 5 }); tick(); assert.deepEqual(model(courtyard), original);
});

test("saved bindings survive scene order, reload and terrain undo without accumulating offsets", t => {
  const { engine, tick } = fixture(t), ground = terrain(engine), root = rootModel(engine, [form("lifted", 0, -1.25)]);
  tick(); const before = ground.props.heights;
  dab(ground, 0, 0, { strength: 2 }); commit(ground, before); tick(); near(yOf(root, "lifted"), .75);
  const rootData = JSON.parse(JSON.stringify(serializeEntity(root))), terrainData = JSON.parse(JSON.stringify(serializeEntity(ground.entity)));
  engine.destroyEntity(root); engine.destroyEntity(ground.entity); tick();
  // Architecture may deserialize before its target terrain.
  const restored = instantiateEntity(engine, rootData); tick(); assert.deepEqual(model(restored), rootData.components.find(component => component.type === "architecture").props.model);
  const restoredGround = instantiateEntity(engine, terrainData).getComponent("terrain"); tick(); near(yOf(restored, "lifted"), .75);
  restoredGround.setProp("heights", before); tick(); assert.equal(yOf(restored, "lifted"), -1.25);
  restoredGround.setProp("heights", ground.props.heights); tick(); near(yOf(restored, "lifted"), .75);
});

test("manual moves recapture clearance, follow-off freezes, and missing or disabled terrain never moves a model", t => {
  const { engine, tick } = fixture(t), root = rootModel(engine, [form("house")]); tick();
  const ground = terrain(engine); tick();
  updateArchitectureForm(root.id, "house", { position: [0, 3.25, 0] }); tick();
  dab(ground, 0, 0, { strength: 1 }); ground.commitHeights(); tick(); near(yOf(root, "house"), 4.25);
  const component = root.getComponent("architecture"); component.setProp("followTerrain", false); tick();
  dab(ground, 0, 0, { strength: 2 }); ground.commitHeights(); tick(); near(yOf(root, "house"), 4.25);
  component.setProp("followTerrain", true); tick();
  dab(ground, 0, 0, { tool: "lower", strength: 1 }); ground.commitHeights(); tick(); near(yOf(root, "house"), 3.25);
  ground.setProp("enabled", false); tick();
  ground.heightsArray.fill(20); ground.commitHeights(); tick(); near(yOf(root, "house"), 3.25);
  engine.destroyEntity(ground.entity); tick(); near(yOf(root, "house"), 3.25);
});

test("surface sampling matches actual triangles under yaw, scale and tilted terrain parents", t => {
  const { engine } = fixture(t), parent = engine.createEntity();
  parent.setTransform({ position: [8, 3, -4], rotation: [0, .45, 0], scale: [2, 1.5, .8] });
  const ground = terrain(engine, { parent, size: 4, resolution: 2 });
  ground.heightsArray.set([0, 0, 0, 0, 3, 0, 0, 0, 0]); ground.commitHeights();
  const ray = new THREE.Raycaster(), local = new THREE.Vector3(.4, 0, .4), world = ground.mesh.localToWorld(local.clone());
  let surface = captureTerrainSurface(ground);
  // Bilinear interpolation would give 1.92 here; the actual triangle is 1.8.
  near(sampleTerrainSurface(surface, world.x, world.z), 3 + 1.8 * 1.5);
  assert.equal(sampleTerrainSurface(surface, 100, 100), null);
  parent.rotation.x = .3; parent.rotation.z = -.15; surface = captureTerrainSurface(ground);
  for (const [x, z] of [[8, -4], [7.5, -4.3], [9, -3.4]]) {
    ray.set(new THREE.Vector3(x, 30, z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(ground.mesh, false)[0];
    const height = sampleTerrainSurface(surface, x, z);
    if (hit) near(height, hit.point.y); else assert.equal(height, null);
  }
});

test("tilted architecture under transformed parents moves only world-vertically", t => {
  const { engine, tick } = fixture(t), parent = engine.createEntity();
  parent.setTransform({ position: [5, 2, -3], rotation: [.1, .4, -.2], scale: [2, 2, 2] });
  const ground = terrain(engine);
  const root = rootModel(engine, [form("house")], { parentId: parent.id, position: [2, 1, 3], rotation: [.2, -.3, .15] }); tick();
  const position = () => root.object3D.localToWorld(new THREE.Vector3(...model(root).forms[0].position));
  const before = position(); ground.heightsArray.fill(2); ground.commitHeights(); tick();
  const after = position(); near(after.x, before.x); near(after.z, before.z); near(after.y - before.y, 2);
});

test("legacy generated buildings follow independently and keep exact child transforms through terrain undo", t => {
  const { engine, tick } = fixture(t), ground = terrain(engine), root = engine.createEntity(), generated = engine.createEntity({ parent: root });
  const component = root.addComponent("architecture", { generatedRootId: generated.id });
  const first = engine.createEntity({ parent: generated }), second = engine.createEntity({ parent: generated });
  first.setTransform({ position: [-6, .4, 0] }); second.setTransform({ position: [9, .4, 0] });
  for (const building of [first, second]) engine.createEntity({ parent: building }).addComponent("architecturepiece", { shape: "box", size: [4, 3, 4] });
  tick(); const before = ground.props.heights, original = first.getTransform(); engine.colliderUpdates = 0;
  dab(ground, -6, 0); tick(); near(first.position.y, .9); assert.equal(second.position.y, .4); assert.equal(engine.colliderUpdates, 0);
  commit(ground, before); tick(); assert.ok(engine.colliderUpdates > 0);
  commandBus.undo(); tick(); assert.deepEqual(first.getTransform(), original);
  assert.ok(component.props.terrainBindings[`entity:${first.id}`]);
});

test("disposing the follower during a deleted preview never resurrects detached geometry", t => {
  const { engine, tick, system } = fixture(t), ground = terrain(engine), root = rootModel(engine, [form("house")]);
  tick(); dab(ground, 0, 0); tick();
  const component = root.getComponent("architecture"); assert.equal(component._terrainPreviewDirty, true);
  engine.destroyEntity(root); system.dispose();
  assert.equal(root.components.size, 0); assert.equal(component.mesh, null); assert.equal(engine.getEntity(root.id), undefined);
});

test("removing Architecture during a preview preserves the ordinary mesh through follower disposal", t => {
  const { engine, tick, system } = fixture(t), ground = terrain(engine), root = rootModel(engine, [form("house")]);
  tick(); dab(ground, 0, 0); tick();
  const component = root.getComponent("architecture");
  root.removeComponent("architecture");
  const mesh = root.getComponent("mesh").mesh, geometry = mesh.geometry;
  system.dispose();
  assert.equal(root.getComponent("architecture"), undefined); assert.equal(component.mesh, null);
  assert.equal(root.getComponent("mesh").mesh, mesh); assert.equal(mesh.geometry, geometry);
});
