import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { collectViewCullingStats } from "../src/engine/culling/viewCullingStats.js";

function fixture() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const entities = new Map();
  const scene = new THREE.Scene();
  let id = 0;
  const add = ({ x = 0, z = -5, occluded = false, frustumCulled = true } = {}) => {
    const object3D = new THREE.Object3D();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
    );
    mesh.frustumCulled = frustumCulled;
    object3D.position.set(x, 0, z);
    object3D.add(mesh);
    scene.add(object3D);
    const entity = {
      id: `entity-${++id}`,
      object3D,
      parent: null,
      enabledInEditor: true,
      enabledInGame: true,
      _occluded: occluded,
      components: new Map([["mesh", { mesh }]]),
    };
    entities.set(entity.id, entity);
    return { entity, mesh };
  };

  const engine = {
    camera,
    scene,
    entities,
    playing: false,
    batching: { batches: [] },
    merging: { groups: [] },
    occlusion: {
      testedLastFrame: 0,
      culledLastFrame: 0,
      _hiddenProxies: new Set(),
    },
  };
  return { engine, add, update: () => scene.updateMatrixWorld(true) };
}

test("displayed culling is the union of frustum and occlusion decisions", () => {
  const { engine, add, update } = fixture();
  add();
  add({ x: 100 });
  add({ occluded: true });
  engine.occlusion.testedLastFrame = 2;
  engine.occlusion.culledLastFrame = 1;
  update();

  assert.deepEqual(collectViewCullingStats(engine), {
    tested: 3,
    culled: 2,
    overlap: 0,
    frustum: { tested: 3, culled: 1 },
    occlusion: { tested: 2, culled: 1, reportedCulled: 1 },
  });
});

test("an object rejected by both cullers is counted once", () => {
  const { engine, add, update } = fixture();
  add();
  add({ x: 100, occluded: true });
  engine.occlusion.testedLastFrame = 1;
  engine.occlusion.culledLastFrame = 1;
  update();

  const stats = collectViewCullingStats(engine);
  assert.equal(stats.frustum.culled, 1);
  assert.equal(stats.occlusion.culled, 1);
  assert.equal(stats.overlap, 1);
  assert.equal(stats.culled, 1, "the displayed numerator double-counted one object");
});

test("proxy members are omitted and the independently cullable proxy is counted", () => {
  const { engine, add, update } = fixture();
  const { mesh: member } = add({ x: 100 });
  member.userData.mergedInto = {};

  const proxy = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
  );
  proxy.position.set(100, 0, -5);
  engine.scene.add(proxy);
  engine.merging.groups.push({ mesh: proxy, members: [{ mesh: member }] });
  update();

  const stats = collectViewCullingStats(engine);
  assert.equal(stats.tested, 1);
  assert.equal(stats.frustum.culled, 1);
  assert.equal(stats.culled, 1);
});

test("a forced non-frustum object and authored/LOD-hidden entities are not claimed", () => {
  const { engine, add, update } = fixture();
  add({ x: 100, frustumCulled: false });
  const authored = add({ x: 100 }).entity;
  authored.enabledInEditor = false;
  const lod = add({ x: 100 }).entity;
  lod._lodHidden = true;
  update();

  const stats = collectViewCullingStats(engine);
  assert.equal(stats.tested, 1);
  assert.equal(stats.frustum.culled, 0);
  assert.equal(stats.culled, 0);
});
