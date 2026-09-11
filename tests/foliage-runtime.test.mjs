import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { EventEmitter } from "../src/engine/EventEmitter.js";
import { computeEntityBoundingSphere } from "../src/engine/viewFrustum.js";
import { FoliageComponent } from "../src/modules/foliage/FoliageComponent.js";
import { foliageCellSize, foliageDetailDistances, foliageLodLevel, partitionFoliage } from "../src/modules/foliage/foliageLod.js";
import { createFoliageUniforms, installFoliagePassHooks } from "../src/modules/foliage/foliageMaterial.js";
import { updateFoliageInteractions } from "../src/modules/foliage/foliageInteraction.js";
import { foliageModule } from "../src/modules/foliage/index.js";
import { holdFoliageResources } from "../src/modules/foliage/foliageWarmup.js";
import { disableEngineModule, enableEngineModule, registerModuleDefinition } from "../src/engine/modules.js";
import { MissingComponent } from "../src/engine/components/registry.js";
import Attributes from "three/src/renderers/common/Attributes.js";
import { AttributeType } from "three/src/renderers/common/Constants.js";

function engineFixture() {
  const engine = new EventEmitter();
  Object.assign(engine, { scene: new THREE.Scene(), entities: new Map(), rootEntities: [], camera: new THREE.PerspectiveCamera(), playing: false, deltaTime: .016, viewOnlyComponents: new Set() });
  engine.getEntity = id => engine.entities.get(id);
  engine.onPreRender = fn => engine.on("preRender", fn);
  engine.camera.position.set(0, 3, 10);
  return engine;
}

function entityFixture(engine, id, parent = null) {
  const entity = new Entity(engine, { id });
  engine.entities.set(id, entity);
  entity.setParent(parent);
  return entity;
}

function surfaceFixture(engine, id = "surface") {
  const entity = entityFixture(engine, id);
  const geometry = new THREE.PlaneGeometry(12, 12, 3, 3).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardNodeMaterial());
  mesh.userData.entityId = entity.id;
  entity.object3D.add(mesh);
  return { entity, mesh };
}

function scatterFixture(props = {}) {
  const engine = engineFixture();
  const surface = surfaceFixture(engine);
  const entity = entityFixture(engine, "foliage");
  const component = entity.addComponent(new FoliageComponent({ species: "grass", height: .6, width: .5, distribution: "scatter", surface: surface.entity.id, density: 1, maxInstances: 1000, chunkSize: 32, ...props }));
  return { engine, surface, entity, component };
}

test("stationary foliage buffers skip real Three uploads while LOD repacks upload new ranges", () => {
  const {engine, entity, component} = scatterFixture({lodNear:4,lodFar:8});
  component._atlasEntry = {atlas:{center:new THREE.Vector3(0,.3,0),radius:.7,dispose(){}},material:new THREE.MeshStandardNodeMaterial(),refs:1,cache:new Map(),key:"upload fixture"};
  component._buildImpostors(); component.update();
  const buffers = component.renderMeshes.flatMap((mesh,lod)=>lod<2?[mesh.instanceMatrix]:["aCenter","aSize","aAxisX","aAxisY"].map(key=>mesh.geometry.attributes[key]));
  let uploads = 0;
  const attributes = new Attributes({createAttribute(){},updateAttribute(){uploads++;}}, {createAttribute(){}});
  const submit = () => { for(const buffer of buffers) attributes.update(buffer,AttributeType.VERTEX); };
  submit();
  for(let frame=0;frame<30;frame++) { component.update(); submit(); }
  assert.equal(uploads,0,"unchanged matrices and atlas placements must not upload every draw (DynamicDrawUsage forces this in Three)");
  engine.camera.position.set(0,.5,0); component.update(); submit();
  assert.ok(uploads>0,"LOD membership changes still upload through actual attribute versions");
  assert.ok(uploads<=buffers.length,"each changed buffer uploads only once");
  const afterRepack=uploads; submit();
  assert.equal(uploads,afterRepack,"the same repacked data is reused by the next render pass");
  entity.removeComponent("foliage");
});

test("foliage hierarchy ownership preserves world placement and world bounds under scaled parents", () => {
  const engine = engineFixture();
  const parent = entityFixture(engine, "parent");
  parent.position.set(60, 4, -20);
  parent.scale.set(2, 3, 4);
  const entity = entityFixture(engine, "tree", parent);
  entity.position.set(3, 0, 2);
  const component = entity.addComponent(new FoliageComponent({ species: "pine", height: 5, width: 2 }));
  engine.scene.updateMatrixWorld(true);
  assert.equal(component.root.parent, entity.object3D);
  assert.deepEqual(component.root.matrixWorld.elements, new THREE.Matrix4().elements);
  const actual = new THREE.Matrix4(); component.chunks[0].meshes[0].getMatrixAt(0, actual);
  assert.deepEqual(actual.elements, entity.object3D.matrixWorld.elements);
  const bound = new THREE.Sphere();
  assert.equal(computeEntityBoundingSphere(entity, bound), true);
  assert.ok(bound.center.x > 60 && bound.center.y > 4 && bound.radius > 4, "world-space foliage contributes the actual transformed extent");
  parent.position.x += 10;
  component.update(true);
  assert.equal(component.instances[0].position[0], 76);
  assert.equal(computeEntityBoundingSphere(entity, bound), true);
  assert.ok(bound.center.x > 70);
  component.setProp("height", 10); component.update();
  assert.equal(computeEntityBoundingSphere(entity, bound), true);
  assert.ok(bound.radius > 10);
  entity.removeComponent("foliage");
});

test("sculpt reseats stable barycentric identities, shares matrices across LODs and excludes its own generated geometry", () => {
  const { engine, surface, component, entity } = scatterFixture();
  assert.equal(component.instances.length, 144);
  assert.equal(component.chunks[0].meshes[0].instanceMatrix, component.chunks[0].meshes[1].instanceMatrix);
  const original = component.instances.map(instance => ({ position: [...instance.position], barycentric: [...instance.barycentric], seed: instance.seed }));
  const position = surface.mesh.geometry.attributes.position;
  for (let i = 0; i < position.count; i++) position.setY(i, position.getX(i) * .15 + 2);
  position.needsUpdate = true;
  surface.mesh.geometry.computeVertexNormals();
  component.update(true);
  assert.equal(component.instances.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.deepEqual(component.instances[i].barycentric, original[i].barycentric);
    assert.equal(component.instances[i].seed, original[i].seed);
    assert.ok(Math.abs(component.instances[i].position[0] - original[i].position[0]) < 1e-8);
    assert.ok(Math.abs(component.instances[i].position[1] - (original[i].position[0] * .15 + 2)) < 1e-6);
  }
  entity.setParent(surface.entity);
  component.setProp("surface", "");
  component.update(true);
  assert.equal(component.instances.length, 145, "density sees only the deformed source surface, never the generated grass");
  surface.entity.position.y += 4;
  component.update(true);
  assert.ok(component.instances.every(instance => instance.position[1] > 5));
  entity.removeComponent("foliage");
});

test("async source geometry swap rebuilds, removed source clears, detached subscriptions cannot resurrect foliage", () => {
  const { engine, surface, component, entity } = scatterFixture();
  surface.mesh.geometry = new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2).translate(30, 0, 0);
  engine.emit("component-changed", { entityId: surface.entity.id, componentType: "mesh", key: "geometryAsset" });
  component.update();
  assert.equal(component.instances.length, 16);
  assert.ok(component.instances.every(instance => instance.position[0] >= 28));
  const near = component.chunks[0].meshes[0];
  component.setProp("windSpeed", 3); component.setProp("interaction", true); component.update();
  assert.equal(component.chunks[0].meshes[0], near, "motion edits keep the instance allocation");
  const radius = near.boundingSphere.radius;
  component.setProp("windStrength", 7);
  assert.ok(near.boundingSphere.radius >= radius, "clamped blade rotation stays covered by its full bend envelope");
  engine.entities.delete(surface.entity.id);
  engine.emit("hierarchy-changed"); component.update();
  assert.equal(component.instances.length, 0);
  entity.removeComponent("foliage");
  engine.emit("model-loaded", surface.entity); engine.emit("preRender");
  assert.equal(component.root, null);
  assert.equal(component.stats.instances, 0);
  assert.equal(engine.listenerCount("preRender"), 0);
});

test("disable, global ancestor disable and simulation suspension pause both rendering work and the clamped clock", () => {
  const { engine, component, entity } = scatterFixture();
  engine.deltaTime = 100;
  const before = component._time;
  component.update();
  assert.ok(Math.abs(component._time - before - .1) < 1e-12);
  engine.simulationSuspended = true;
  const paused = component._time;
  component.update(); assert.equal(component._time, paused);
  engine.simulationSuspended = false;
  component.setEnabled(false); component.update();
  assert.equal(component.root.visible, false); assert.equal(component._time, paused);
  component.setEnabled(true); component.update();
  assert.equal(component.root.visible, true);
  const ancestor = entityFixture(engine, "disabled ancestor");
  entity.setParent(ancestor);
  ancestor.enabled = false;
  component.update(); assert.equal(component.root.visible, false);
  entity.removeComponent("foliage");
});

test("LOD has hysteresis, preserves a drawing mesh until atlas ready, and distant chunks become actual two-triangle instances", () => {
  const props = { lodNear: 10, lodFar: 30, maxDistance: 100 };
  assert.equal(foliageLodLevel(10.5, 0, props), 0);
  assert.equal(foliageLodLevel(11, 0, props), 1);
  assert.equal(foliageLodLevel(9.5, 1, props), 1);
  assert.equal(foliageLodLevel(9, 1, props), 0);
  assert.equal(foliageLodLevel(50, 1, props, false), 1);
  assert.equal(foliageLodLevel(50, 1, props, true), 2);
  assert.equal(foliageLodLevel(110, 2, props, false), 3);
  const { engine, component, entity } = scatterFixture(props);
  const atlas = { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} };
  component._atlasEntry = { atlas, material: new THREE.MeshStandardNodeMaterial({alphaTest:.35}), refs: 1, cache: new Map(), key: "fixture" };
  component._buildImpostors();
  assert.equal(component.renderMeshes[2].material.alphaTest,.35,"the cloned living impostor retains real Three alpha testing instead of becoming an opaque brick");
  engine.camera.position.set(0, 2, 65); component.update();
  assert.ok(component.stats.impostorChunks > 0);
  assert.equal(component.stats.triangles, component.instances.length * 2);
  for (const chunk of component.chunks) {
    assert.equal(chunk.meshes[2].geometry.index.count, 6);
    assert.equal(chunk.meshes[2].geometry.instanceCount, chunk.instances.length);
    assert.deepEqual(chunk.meshes.map(mesh => mesh.visible), [false, false, true]);
    assert.equal(chunk.meshes[2].userData.vfxSimulation, "foliage");
  }
  engine.camera.position.z = 300; component.update();
  assert.equal(component.stats.drawCalls, 0);
  entity.removeComponent("foliage");
});

test("100k dense placements have bounded spatial draw groups and never allocate per-plant objects", () => {
  const placements = Array.from({ length: 100000 }, (_, i) => ({ position: [i % 100, 0, Math.floor(i / 100) % 100] }));
  const chunks = partitionFoliage(placements, 24);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.instances.length, 0), placements.length);
  assert.ok(chunks.every(chunk => chunk.instances.length <= 1024));
  assert.ok(chunks.length < 225, "spatial median splits stay bounded by twice the dense capacity plus edge cells");
});

test("dense spatial splitting tightens real extents instead of slicing identical random cell bounds", () => {
  const instances = Array.from({ length: 4096 }, (_, i) => ({ position: [((i * 733) % 4096) / 4096 * 24, 0, .5] }));
  const chunks = partitionFoliage(instances, 24);
  assert.equal(chunks.length, 4);
  for (const chunk of chunks) {
    const x = chunk.instances.map(instance => instance.position[0]);
    assert.ok(Math.max(...x) - Math.min(...x) < 6.01, "each child covers a quarter of the source extent");
  }
  assert.equal(new Set(chunks.flatMap(chunk => chunk.instances)).size, instances.length);
});

test("screen detail responds to actual plant pixels and preserves authored cull distance and close geometry", () => {
  const props = { species: "grass", height: .65, chunkSize: 24, lodNear: 12, lodFar: 30, maxDistance: 65 };
  assert.ok(Math.abs(foliageCellSize(props) - 7.8) < 1e-9);
  assert.equal(foliageCellSize({ ...props, chunkSize: 3 }), 3, "an authored smaller cell remains smaller");
  const output = {};
  assert.equal(foliageDetailDistances(props, 600, .8, output), output);
  assert.equal(output.lodNear, 6); assert.ok(output.lodFar < 27); assert.equal(output.maxDistance, 65);
  assert.equal(foliageLodLevel(2, -1, output), 0, "close blades retain full detail");
  assert.equal(foliageLodLevel(8, -1, output), 1);
  assert.equal(foliageLodLevel(29, -1, output), 2);
  foliageDetailDistances(props, 1200, .8, output);
  assert.equal(foliageLodLevel(8, -1, output), 0, "zoom or a larger render target promotes detail");
  assert.equal(foliageLodLevel(64, -1, output), 2, "screen-size decisions do not thin or hide distant density");
});

test("50 m dense grass patch no longer submits full-detail geometry across oversized cells", () => {
  const engine = engineFixture();
  const surface = surfaceFixture(engine);
  surface.mesh.geometry = new THREE.PlaneGeometry(50, 50).rotateX(-Math.PI / 2);
  engine.renderer = { getDrawingBufferSize: target => target.set(1300, 724) };
  engine.rendererReady = false;
  engine.camera.position.set(24, 2, 0);
  const entity = entityFixture(engine, "grass performance");
  const component = entity.addComponent(new FoliageComponent({ species: "grass", height: .65, width: .65, distribution: "scatter", surface: surface.entity.id, density: 3, maxInstances: 10000, lodNear: 12, lodFar: 30, maxDistance: 65 }));
  const authored = structuredClone(component.props);
  component._atlasEntry = { atlas: { center: new THREE.Vector3(0, .3, 0), radius: .7, dispose() {} }, material: new THREE.MeshStandardNodeMaterial(), refs: 1, cache: new Map(), key: "perf fixture" };
  component._buildImpostors(); component.update();
  const fullDetail = component.instances.length * component.geometries[0].index.count / 3;
  assert.equal(component.instances.length, 7500);
  assert.ok(component.stats.triangles < fullDetail * .3, `selected ${component.stats.triangles} vs ${fullDetail} all-near triangles`);
  assert.ok(component.stats.nearChunks > 0, "grass at the camera stays geometry");
  assert.ok(component.stats.impostorChunks > 0, "distant plants use the actual baked atlas");
  assert.equal(component.stats.culledChunks, 0, "all authored density within draw distance survives");
  assert.ok(component.stats.drawCalls <= 3, "small spatial cells share three actual render batches");
  assert.equal(component.root.children.length, 3);
  assert.ok(component.chunks.every(chunk => chunk.meshes.every(mesh => mesh.parent === null)), "chunk templates are never separately submitted");
  assert.equal(component.renderMeshes.reduce((n,mesh,i)=>n+(i===2?mesh.geometry.instanceCount:mesh.count),0),7500);
  assert.deepEqual(component.props, authored, "automatic detail does not rewrite saved properties");
  const meshes = component.chunks.map(chunk => chunk.meshes[0]);
  const actualMeshes=[...component.renderMeshes],versions=actualMeshes.slice(0,2).map(mesh=>mesh.instanceMatrix.version);
  engine.camera.rotation.y += .4; component.update();
  assert.deepEqual(component.chunks.map(chunk => chunk.meshes[0]), meshes, "camera rotation does not allocate instance buffers");
  assert.deepEqual(component.renderMeshes.slice(0,2).map(mesh=>mesh.instanceMatrix.version),versions,"camera rotation and wind do not upload matrices");
  engine.camera.position.set(0,2,0);component.update();
  assert.deepEqual(component.renderMeshes,actualMeshes,"LOD changes retain actual mesh/pipeline identity");
  assert.equal(component.renderMeshes.reduce((n,mesh,i)=>n+(i===2?mesh.geometry.instanceCount:mesh.count),0),7500,"LOD repacking does not duplicate or drop plants");
  for(let lod=0;lod<2;lod++) {
    const expected=component.chunks.filter(chunk=>chunk.level===lod).flatMap(chunk=>chunk.instances);
    const render=component.renderMeshes[lod],matrix=new THREE.Matrix4();
    assert.equal(render.count,expected.length);
    for(let i=0;i<expected.length;i+=97){render.getMatrixAt(i,matrix);assert.ok(new THREE.Vector3().setFromMatrixPosition(matrix).distanceTo(new THREE.Vector3().fromArray(expected[i].position))<1e-5);}
  }
  entity.removeComponent("foliage");
});

test("species material changes rebuild the tree-specific shader without changing authored scatter", () => {
  const { component, entity } = scatterFixture();
  const grass = component.material;
  component.setProp("species", "oak"); component.update();
  assert.notEqual(component.material, grass);
  assert.ok(component.material.opacityNode, "tree coverage is present after a grass-to-tree edit");
  const oak = component.material;
  component.setProp("windSpeed", 3); component.update();
  assert.equal(component.material, oak);
  component.setProp("species", "grass"); component.update();
  assert.notEqual(component.material, oak);
  entity.removeComponent("foliage");
});

test("tree joint wind bounds follow prototype length and nonuniform world scale even in calm weather", () => {
  const engine = engineFixture(), entity = entityFixture(engine, "scaled tree");
  entity.object3D.scale.set(2,3,4);
  const component = entity.addComponent(new FoliageComponent({species:"oak",distribution:"single",height:12,width:8,windStrength:0}));
  component.update();
  const expected = 1 + .35 * component._prototypeSize * 4;
  assert.equal(component._motionMargin(), expected);
  const chunk = component.chunks[0];
  assert.ok(chunk.bounds.min.x <= chunk.detailBounds.min.x - expected + 1e-5, "culling already covers the full possible branch sweep");
  component.setProp("windStrength", 50);component.update();
  assert.equal(component._motionMargin(), expected, "clamped joint angles stay inside the envelope when wind increases");
  component.setProp("height", 24);component.update();
  assert.ok(component._motionMargin() > expected, "a taller tree reserves a longer tip sweep");
  entity.removeComponent("foliage");
});

test("new layers join the shared gust clock while detached and suspended layers stop updating", () => {
  const engine = engineFixture();engine.elapsedTime=20;
  const firstEntity=entityFixture(engine,"old grass"),secondEntity=entityFixture(engine,"new grass");
  const first=firstEntity.addComponent(new FoliageComponent({species:"grass"}));
  engine.elapsedTime=35;first.update();
  const second=secondEntity.addComponent(new FoliageComponent({species:"grass"}));
  assert.equal(first.uniforms.time.value,35);assert.equal(second.uniforms.time.value,35);
  assert.notEqual(first._time,second._time,"different component ages do not change gust phase");
  engine.simulationSuspended=true;engine.elapsedTime=36;first.update();second.update();
  assert.equal(first.uniforms.time.value,35);assert.equal(second.uniforms.time.value,35);
  firstEntity.removeComponent("foliage");secondEntity.removeComponent("foliage");
});

test("actual component rebuild and detach withdraw old draws but preserve resources borrowed by async warmup", async () => {
  const {component,entity}=scatterFixture();
  const oldGeometry=component.geometries[0],oldMaterial=component.material,oldMesh=component.renderMeshes[0];
  let geometryDisposals=0,materialDisposals=0,meshDisposals=0,finish;
  oldGeometry.addEventListener("dispose",()=>geometryDisposals++);
  oldMaterial.addEventListener("dispose",()=>materialDisposals++);
  oldMesh.addEventListener("dispose",()=>meshDisposals++);
  const pending=holdFoliageResources(component,()=>new Promise(resolve=>{finish=resolve;}));
  component.setProp("species","oak");component.update();
  assert.equal(oldMesh.parent,null);assert.notEqual(component.material,oldMaterial);
  assert.equal(geometryDisposals+materialDisposals+meshDisposals,0,"the compiler still owns its captured old resources");
  entity.removeComponent("foliage");assert.equal(component.root,null);
  assert.equal(geometryDisposals+materialDisposals+meshDisposals,0);
  finish();await pending;
  assert.equal(geometryDisposals,1);assert.equal(materialDisposals,1);assert.equal(meshDisposals,1);
});

test("bounded collider uniforms respect sensors, characters, removed components/entities and disabled ancestors", () => {
  const engine = engineFixture();
  const uniforms = createFoliageUniforms(), camera = new THREE.Vector3();
  const actors = [];
  for (let i = 0; i < 12; i++) {
    const entity = entityFixture(engine, `actor${i}`);
    entity.position.x = i;
    const collider = { enabled: true, props: { shape: "box", size: [1, 2, 1], autoFit: false, autoCenter: false } };
    entity.components.set("collider", collider);
    actors.push(entity);
  }
  assert.equal(updateFoliageInteractions(engine, uniforms, camera, 0, true), 8);
  assert.equal(uniforms.colliders[7].center.value.x, 7);
  actors[0].getComponent("collider").props.isSensor = true;
  actors[1].enabled = false;
  actors[2].components.delete("collider");
  engine.entities.delete(actors[3].id);
  actors[4].components.delete("collider");
  actors[4].components.set("charactercontroller", { enabled: true, props: { radius: .4, height: 1.2 } });
  assert.equal(updateFoliageInteractions(engine, uniforms, camera, .01, true), 8);
  assert.equal(uniforms.colliders[0].center.value.x, 4);
  assert.equal(uniforms.colliders[0].center.value.w, 2, "character capsule uses the documented enclosing sphere");
  assert.ok(Math.abs(uniforms.colliders[0].x.value.w - 1) < 1e-6);
  const parent = entityFixture(engine, "hidden parent");
  actors[4].setParent(parent); parent.enabled = false;
  assert.equal(updateFoliageInteractions(engine, uniforms, camera, .02, true), 7);
  assert.equal(uniforms.colliders[0].center.value.x, 5);
  assert.equal(updateFoliageInteractions(engine, uniforms, camera, .03, false), 0);
  assert.ok(uniforms.colliders.every(row => row.center.value.w === 0));
});

test("module disable disposes existing components and callbacks; re-enable restores authored foliage once", async () => {
  const engine = engineFixture(); engine.modules = new Map();
  registerModuleDefinition(foliageModule);
  await enableEngineModule(engine, "foliage");
  const entity = entityFixture(engine, "module tree");
  const component = entity.addComponent("foliage", { seed: 734 });
  const oldRoot = component.root;
  assert.equal(engine.listenerCount("preRender"), 1);
  await disableEngineModule(engine, "foliage");
  assert.equal(component.root, null); assert.equal(oldRoot.parent, null);
  assert.equal(engine.listenerCount("preRender"), 0);
  component.setProp("height", 12);
  component.onAttach();
  assert.equal(component.root, null, "a direct attach cannot wake a disabled module");
  await enableEngineModule(engine, "foliage");
  assert.ok(component.root);
  assert.equal(component.props.seed, 734); assert.equal(component.props.height, 12);
  assert.equal(engine.listenerCount("preRender"), 1);
  await disableEngineModule(engine, "foliage");
  const missingEntity = entityFixture(engine, "saved disabled foliage");
  missingEntity.addComponent(new MissingComponent({ species: "birch", height: 9, seed: 919 }, "foliage"));
  await enableEngineModule(engine, "foliage");
  const restored = missingEntity.getComponent("foliage");
  assert.ok(restored instanceof FoliageComponent);
  assert.equal(restored.props.species, "birch"); assert.equal(restored.props.seed, 919);
  assert.ok(restored.root);
  await disableEngineModule(engine, "foliage");
  entity.removeComponent("foliage");
  missingEntity.removeComponent("foliage");
});

test("layers with different animation ages share one collider registry and actor packing per rendered frame", () => {
  const engine = engineFixture(); engine.renderer = { info: { frame: 5 } };
  const entity = entityFixture(engine, "shared actor");
  entity.components.set("collider", { enabled: true, props: { shape: "sphere", radius: 1 } });
  let reads = 0;
  const originalValues = engine.entities.values.bind(engine.entities);
  engine.entities.values = () => { reads++; return originalValues(); };
  const a = createFoliageUniforms(), b = createFoliageUniforms(), camera = new THREE.Vector3();
  updateFoliageInteractions(engine, a, camera, 200, true);
  updateFoliageInteractions(engine, b, camera, 1, true);
  updateFoliageInteractions(engine, a, camera, 200.016, true);
  updateFoliageInteractions(engine, b, camera, 1.016, true);
  assert.equal(reads, 1);
  assert.deepEqual(a.colliders[0].center.value, b.colliders[0].center.value);
  entity.position.x = 8; engine.renderer.info.frame++;
  updateFoliageInteractions(engine, a, camera, 200.032, true);
  assert.equal(a.colliders[0].center.value.x, 8);
});

test("GI override borrows foliage coverage, normals and sidedness without changing any following object's pass", () => {
  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  const normal = material.normalNode = { marker: "baked normal" };
  const opacity = material.opacityNode = { marker: "silhouette" };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
  installFoliagePassHooks(mesh);
  const override = new THREE.MeshBasicNodeMaterial(); override.name = "GI gbuffer";
  const scene = { overrideMaterial: override };
  mesh.onBeforeRender(null, scene);
  const specialized = scene.overrideMaterial;
  assert.notEqual(specialized, override);
  assert.equal(specialized.side, THREE.DoubleSide);
  assert.equal(specialized.normalNode, normal); assert.equal(specialized.opacityNode, opacity);
  assert.equal(specialized.setupNormal, THREE.NodeMaterial.prototype.setupNormal);
  mesh.onAfterRender();
  assert.equal(scene.overrideMaterial, override);
  assert.equal(override.side, THREE.FrontSide);
  assert.equal(override.normalNode, null); assert.equal(override.opacityNode, null);
  mesh.onBeforeRender(null, scene);
  assert.equal(scene.overrideMaterial, specialized, "unchanged source/pass reuses the same material and graph");
  mesh.onAfterRender();
  const changedOpacity = material.opacityNode = { marker: "new silhouette" };
  const version = specialized.version;
  mesh.onBeforeRender(null, scene);
  assert.equal(scene.overrideMaterial, specialized);
  assert.equal(specialized.opacityNode, changedOpacity); assert.ok(specialized.version > version);
  mesh.onAfterRender();
  override.name = "Unrelated override";
  mesh.onBeforeRender(null, scene);
  assert.equal(override.normalNode, null); assert.equal(override.opacityNode, null);
  mesh.onAfterRender(); mesh.geometry.dispose(); material.dispose(); override.dispose();
});
