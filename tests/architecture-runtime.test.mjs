import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import { registerComponent } from "../src/engine/components/registry.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { ArchitectureComponent } from "../src/modules/architecture/ArchitectureComponent.js";
import { ArchitecturePieceComponent } from "../src/modules/architecture/ArchitecturePieceComponent.js";
import { ArchitectureEnvironment } from "../src/modules/architecture/architectureEnvironment.js";
import { architectureModule } from "../src/modules/architecture/index.js";
import { FoliageComponent } from "../src/modules/foliage/FoliageComponent.js";
import { buildPolygonSlab } from "../src/modules/architecture/polygonGeometry.js";
import { registerModuleDefinition, enableEngineModule, applyEngineModules, getModuleDefinition } from "../src/engine/modules.js";

registerComponent(MeshComponent);
function fixture() {
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], modules: new Map(), camera: new THREE.PerspectiveCamera(), playing: false, deltaTime: .016, viewOnlyComponents: new Set() });
  engine.getEntity = id => engine.entities.get(id);
  engine.onPreRender = fn => engine.on("preRender", fn);
  const entity = (id, parent = null) => {
    const node = new Entity(engine, { id }); engine.entities.set(id, node); node.setParent(parent); return node;
  };
  engine.architecture = new ArchitectureEnvironment(engine);
  return { engine, entity };
}
const square = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
const hole = [[-1, -1], [-1, 1], [1, 1], [1, -1]];
test("polygon slabs have real courtyard holes, indexed faces and outward closed volume", () => {
  const { geometry } = buildPolygonSlab({ footprint: square, holes: [hole], size: [10, .3, 10] });
  assert.ok(geometry.index);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.updateMatrixWorld();
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, -1, 0));
  assert.equal(ray.intersectObject(mesh).length, 0, "the courtyard remains empty");
  ray.ray.origin.x = 3;
  assert.ok(Math.abs(ray.intersectObject(mesh)[0].point.y) < 1e-6, "the walkable top is y=0");
  ray.ray.origin.set(3, -5, 0); ray.ray.direction.set(0, 1, 0);
  assert.ok(Math.abs(ray.intersectObject(mesh)[0].point.y + .3) < 1e-6);
  let volume = 0; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = geometry.attributes.position;
  for (let i = 0; i < geometry.index.count; i += 3) {
    a.fromBufferAttribute(p, geometry.index.getX(i)); b.fromBufferAttribute(p, geometry.index.getX(i + 1)); c.fromBufferAttribute(p, geometry.index.getX(i + 2));
    volume += a.dot(b.cross(c)) / 6;
  }
  assert.ok(Math.abs(volume - 96 * .3) < .0001, `closed signed volume ${volume}`);
  geometry.dispose(); mesh.material.dispose();
});

test("Architecture pieces stand alone, retain polygon geometry across mesh loads and invalidate colliders", async () => {
  const { engine, entity } = fixture(); let dirties = 0;
  engine.physics = { markDirty() { dirties++; } };
  const pieceEntity = entity("free slab"); pieceEntity.position.y = 18.25;
  const piece = pieceEntity.addComponent(new ArchitecturePieceComponent({ shape: "floor", size: [10, .3, 10], footprint: square, holes: [hole] }));
  const mesh = pieceEntity.getComponent("mesh").mesh;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(mesh.geometry, piece.geometry);
  assert.equal(pieceEntity.parent, null);
  assert.equal(pieceEntity.position.y, 18.25);
  piece.setProp("size", [10, .5, 10]);
  assert.ok(dirties >= 2); assert.ok(Math.abs(piece.geometry.boundingBox.min.y + .5) < 1e-6);
  assert.ok(piece.geometry.index); assert.equal(mesh.userData.entityId, pieceEntity.id);
  pieceEntity.dispose(); engine.architecture.dispose();
});

test("freeform rooms feed GI at arbitrary elevations and have globally distinct keys", () => {
  const { engine, entity } = fixture(); const found = [];
  for (const y of [2.5, 13.2]) {
    const root = entity(`assembly${y}`); root.position.y = y;
    const architecture = root.addComponent(new ArchitectureComponent());
    for (const [i, pos, yaw, size] of [[0, [0, 0, -3], 0, [8, 3, .25]], [1, [0, 0, 3], 0, [8, 3, .25]], [2, [-4, 0, 0], Math.PI / 2, [6, 3, .25]], [3, [4, 0, 0], Math.PI / 2, [6, 3, .25]]]) {
      const wall = entity(`wall${y}:${i}`, root); wall.position.fromArray(pos); wall.rotation.y = yaw;
      wall.addComponent(new ArchitecturePieceComponent({ shape: "wall", size }));
    }
    const rooms = architecture.rooms(); assert.equal(rooms.length, 1);
    assert.ok(Math.abs(rooms[0].center[1] - (y + 1.5)) < 1e-6); found.push(rooms[0]);
  }
  assert.notEqual(found[0].key, found[1].key);
  for (const node of engine.entities.values()) node.dispose(); engine.architecture.dispose();
});

test("foliage clearing respects transformed footprints and restores original seeded instances after move/disable", () => {
  const { engine, entity } = fixture();
  const surface = entity("terrain");
  surface.object3D.add(new THREE.Mesh(new THREE.PlaneGeometry(24, 24).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial()));
  const grassEntity = entity("grass");
  const grass = grassEntity.addComponent(new FoliageComponent({ species: "grass", distribution: "scatter", surface: surface.id, density: 2, maxInstances: 2000 }));
  const original = grass.instances.map(instance => [...instance.position]);
  const root = entity("courtyard"); root.rotation.y = .3; root.scale.set(1.2, 1, 1.2);
  const architecture = root.addComponent(new ArchitectureComponent({ settings: { clearFoliage: true, foliagePadding: 0 } }));
  entity("slab", root).addComponent(new ArchitecturePieceComponent({ shape: "floor", size: [10, .3, 10], footprint: square, holes: [hole] }));
  grass.update();
  assert.ok(grass.instances.length < original.length);
  assert.ok(grass.instances.some(instance => Math.hypot(instance.position[0], instance.position[2]) < 1), "courtyard plants survive");
  assert.ok(grass.instances.every(instance => !engine.architecture.excludes(instance.position)));
  root.position.x = 100; engine.emit("hierarchy-changed"); grass.update();
  assert.deepEqual(grass.instances.map(instance => instance.position), original, "moving the structure restores every original plant");
  root.position.x = 0; engine.emit("hierarchy-changed"); grass.update();
  architecture.setProp("settings", { clearFoliage: false }); grass.update();
  assert.deepEqual(grass.instances.map(instance => instance.position), original);
  for (const node of engine.entities.values()) node.dispose(); engine.architecture.dispose();
});

test("legacy module IDs resolve to one canonical Architecture module without duplicate registration", async () => {
  const { engine } = fixture(); engine.architecture.dispose(); delete engine.architecture;
  registerModuleDefinition(architectureModule);
  assert.equal(getModuleDefinition("level-design"), architectureModule);
  await enableEngineModule(engine, "level-design");
  assert.deepEqual([...engine.modules.keys()], ["architecture"]);
  const handle = engine.modules.get("architecture");
  await applyEngineModules(engine, ["architecture", "level-design"]);
  assert.equal(engine.modules.get("architecture"), handle);
  await applyEngineModules(engine, []);
  assert.equal(engine.architecture, undefined);
});

test("tilted, scaled structures clear their rendered footprint and release shared surfaces exactly once", () => {
  const { engine, entity } = fixture();
  const root = entity("tilted root"); root.rotation.set(.65, .2, -.3); root.scale.set(2, 1.4, .7);
  root.addComponent(new ArchitectureComponent({ settings: { clearFoliage: true, foliagePadding: 0 } }));
  const first = entity("beam A", root).addComponent(new ArchitecturePieceComponent({ shape: "box", role: "structure", size: [3, 9, 2] }));
  const second = entity("beam B", root).addComponent(new ArchitecturePieceComponent({ shape: "box", role: "structure", size: [3, 9, 2] }));
  assert.equal(first.mesh.material, second.mesh.material);
  const material = first.mesh.material; let disposed = 0;
  material.addEventListener("dispose", () => disposed++);
  first.refreshMaterial(); first.refreshMaterial();
  const mask = engine.architecture.snapshot();
  first.entity.object3D.updateWorldMatrix(true, false);
  for (const y of [.1, 3, 8.9]) {
    const p = first.entity.object3D.localToWorld(new THREE.Vector3(0, y, 0));
    assert.ok(mask.excludes(p.toArray()), "tilted beam's projected center is excluded at every height");
  }
  first.entity.dispose(); assert.equal(disposed, 0);
  second.entity.dispose(); assert.equal(disposed, 1, "no leaked material references after refresh");
  root.dispose(); engine.architecture.dispose();
});
