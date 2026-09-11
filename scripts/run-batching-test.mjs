/**
 * Automatic static batching (src/engine/batching.js).
 *
 * Runs the real Engine headlessly — no renderer is created, which is fine
 * because batching is pure scene-graph bookkeeping. What matters here is not
 * that it draws, but that it never breaks the invariants the editor depends on:
 * clicking still hits the entity, hidden things stay hidden, and turning it off
 * puts the scene back exactly as it was.
 */
import assert from "node:assert/strict";

// The Engine wires an InputManager (and a stats sampler) to the document at
// construction. Batching touches none of that, so a stub DOM is enough to get
// a real Engine instance in Node without a browser or a GPU.
const stubElement = () => ({
  style: {},
  appendChild() {},
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  classList: { add() {}, remove() {} },
  parentElement: null,
});
globalThis.document ??= {
  body: stubElement(),
  createElement: stubElement,
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const THREE = await import("three/webgpu");
const { Engine, registerBuiltInComponents } = await import("../src/engine/index.js");

registerBuiltInComponents();

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

const engine = new Engine();
const proxies = () => engine.scene.children.filter((o) => o.userData.batchProxy);

/** Adds `count` mesh entities that all share `geometry` and `material`. */
function addMeshes(count, geometry, material, label) {
  const made = [];
  for (let i = 0; i < count; i++) {
    const entity = engine.createEntity({ name: `${label}${i}` });
    entity.position = [i, 0, 0];
    const component = entity.addComponent("mesh", {});
    component.mesh.geometry = geometry;
    component.mesh.material = material;
    made.push(entity);
  }
  return made;
}

const sharedGeometry = new THREE.BoxGeometry(1, 1, 1);
const sharedMaterial = new THREE.MeshBasicMaterial();
const otherGeometry = new THREE.SphereGeometry(0.5, 8, 8);

console.log("automatic static batching");

const crates = addMeshes(10, sharedGeometry, sharedMaterial, "Crate");
const loners = addMeshes(2, otherGeometry, sharedMaterial, "Loner");
engine.batching.sync();

check("merges a repeated (geometry, material) pair into one proxy", () => {
  const batches = proxies();
  assert.equal(batches.length, 1, `expected 1 batch, got ${batches.length}`);
  assert.equal(batches[0].count, 10);
  assert.equal(batches[0].isInstancedMesh, true);
});

check("leaves groups below the threshold alone", () => {
  for (const entity of loners) {
    assert.equal(entity.getComponent("mesh").mesh.visible, true, "loner was hidden");
  }
});

check("hides the members it took over", () => {
  for (const entity of crates) {
    assert.equal(entity.getComponent("mesh").mesh.visible, false);
  }
});

check("reports the draw calls it saved", () => {
  assert.equal(engine.batching.savedDrawCalls, 9);
});

check("instance matrices match the member world matrices", () => {
  const batch = proxies()[0];
  const actual = new THREE.Matrix4();
  const member = crates[3].getComponent("mesh").mesh;
  // Find this member's slot — order follows entity iteration, not creation.
  let found = false;
  for (let i = 0; i < batch.count; i++) {
    batch.getMatrixAt(i, actual);
    if (actual.equals(member.matrixWorld)) found = true;
  }
  assert.ok(found, "no instance carried the member's world matrix");
});

check("a hidden member's mesh is still raycastable (editor picking)", () => {
  // three's Raycaster tests layers, never `visible` — the property batching
  // relies on so selection keeps resolving to real entities.
  const raycaster = new THREE.Raycaster();
  raycaster.set(new THREE.Vector3(3, 0, 5), new THREE.Vector3(0, 0, -1));
  engine.scene.updateMatrixWorld(true);
  const hits = raycaster.intersectObjects(engine.scene.children, true);
  assert.ok(hits.length > 0, "raycast found nothing");
  assert.equal(hits[0].object.userData.entityId, crates[3].id);
});

check("the proxy itself is never a pick target", () => {
  const raycaster = new THREE.Raycaster();
  raycaster.set(new THREE.Vector3(3, 0, 5), new THREE.Vector3(0, 0, -1));
  const hits = raycaster.intersectObjects(engine.scene.children, true);
  assert.ok(
    hits.every((hit) => !hit.object.userData.batchProxy),
    "a batch proxy was hit by the picking ray",
  );
});

check("a moved member updates its instance in place, without a rebuild", () => {
  const batch = proxies()[0];
  crates[2].position = [0, 25, 0];
  engine.batching.sync();
  assert.equal(proxies()[0], batch, "the batch was rebuilt instead of updated");
  const moved = crates[2].getComponent("mesh").mesh;
  const actual = new THREE.Matrix4();
  let found = false;
  for (let i = 0; i < batch.count; i++) {
    batch.getMatrixAt(i, actual);
    if (actual.equals(moved.matrixWorld)) found = true;
  }
  assert.ok(found, "the moved member's instance matrix was not updated");
});

check("a disabled entity is dropped from its batch and stays hidden", () => {
  crates[0].setEnabledInEditor(false);
  engine.flushHierarchyChanged();
  engine.batching.sync();
  const batch = proxies()[0];
  assert.equal(batch.count, 9, `expected 9 instances, got ${batch.count}`);
  assert.equal(crates[0].enabledInEditor, false);
  // What matters is that the batch stopped drawing it — a batch proxy lives at
  // the scene root and would otherwise keep rendering an instance for a
  // disabled entity. That is the count above.
  //
  // ⚠ THIS USED TO READ `component.mesh.userData.batchedInto` AND THREW ON
  // NULL. Since 17d4b44 ("a disabled entity detaches its components, not just
  // its Object3D") disabling an entity runs `Entity.reconcileActivity`, which
  // calls `MeshComponent.onDetach` — and that removes the mesh from the entity
  // and NULLS it (MeshComponent.js). So there is no longer a mesh object to
  // carry a batch claim, which is a stronger guarantee than the claim being
  // cleared, not a weaker one: nothing in the scene can draw it at all.
  const component = crates[0].getComponent("mesh");
  assert.equal(component._attached, false, "a disabled entity must detach its mesh component");
  assert.equal(component.mesh, null, "a detached mesh component owns no mesh to be claimed");
  assert.equal(crates[0].object3D.children.length, 0, "and nothing is left in the entity to draw");
});

check("a disabled COMPONENT stays hidden after leaving its batch", () => {
  const component = crates[1].getComponent("mesh");
  component.setProp("enabled", false);
  engine.flushHierarchyChanged();
  engine.batching.sync();
  assert.equal(component.mesh.visible, false, "a disabled mesh component was un-hidden");
});

check("turning batching off restores every member", () => {
  engine.batching.setEnabled(false);
  assert.equal(proxies().length, 0, "a proxy survived teardown");
  for (const entity of crates.slice(2)) {
    assert.equal(entity.getComponent("mesh").mesh.visible, true);
  }
  // ...but not the ones that are legitimately off.
  assert.equal(crates[1].getComponent("mesh").mesh.visible, false);
});

check("re-enabling rebuilds the grouping", () => {
  engine.batching.setEnabled(true);
  engine.batching.sync();
  assert.equal(proxies().length, 1);
});

check("destroying members below the threshold dissolves the batch", () => {
  for (const entity of crates.slice(2, 9)) engine.destroyEntity(entity);
  engine.flushHierarchyChanged();
  engine.batching.sync();
  assert.equal(proxies().length, 0, "batch survived with too few members");
  assert.equal(crates[9].getComponent("mesh").mesh.visible, true);
});

// ── Primitives share one geometry per kind, so they batch out of the box ─────
//
// A mesh that shows a built-in primitive used to own a private
// `SphereGeometry`, so 350 primitive balls were 350 geometries the batcher
// could never group. `acquirePrimitiveGeometry` (geometryAsset.js) hands every
// mesh the same instance per kind — nothing below assigns a geometry by hand.
console.log("shared primitive geometry");

const balls = [];
for (let i = 0; i < 6; i++) {
  const entity = engine.createEntity({ name: `Ball${i}` });
  // Deliberately NOT float32-exact: the resting-member check below depends on
  // world matrices that a Float32 cache cannot hold bit-for-bit.
  entity.position = [i * 0.1 + 0.3, 1.7676540613174438, 3.6010959148406982];
  entity.rotation = [0.9581721088110908, -0.07692816000681808, -2.3986441433977745];
  entity.scale = [0.8, 0.8, 0.8];
  entity.addComponent("mesh", { geometry: "sphere" });
  balls.push(entity);
}
engine.flushHierarchyChanged();
engine.batching.sync();

check("every primitive mesh of one kind renders the SAME BufferGeometry", () => {
  const first = balls[0].getComponent("mesh").mesh.geometry;
  assert.ok(first?.isBufferGeometry, "no geometry on the primitive mesh");
  // GI's mover classifier switches on `geometry.type` to trace a ball as an
  // analytic sphere — sharing must not degrade the instance to a bare
  // BufferGeometry.
  assert.equal(first.type, "SphereGeometry");
  for (const entity of balls) assert.equal(entity.getComponent("mesh").mesh.geometry, first);
});

check("a different primitive is a different shared instance", () => {
  const box = engine.createEntity({ name: "Box" }).addComponent("mesh", { geometry: "box" });
  const sphere = balls[0].getComponent("mesh").mesh.geometry;
  assert.notEqual(box.mesh.geometry, sphere);
  assert.equal(box.mesh.geometry.type, "BoxGeometry");
});

check("primitive meshes therefore batch without any asset", () => {
  const batch = proxies().find((proxy) => proxy.count === 6);
  assert.ok(batch, "no 6-instance proxy for the six primitive spheres");
});

check("a resting member is NOT re-uploaded every frame", () => {
  // The batcher caches member matrices in a Float32Array and compared them to
  // three's Float64 elements with `!==`, so anything float32 cannot hold read
  // as motion every frame: a permanent re-upload, and (because GI keys its
  // g-buffer hold on `instanceMatrix.version`) a depth prepass that never froze.
  const batch = proxies().find((proxy) => proxy.count === 6);
  const version = batch.instanceMatrix.version;
  engine.batching.sync();
  engine.batching.sync();
  assert.equal(batch.instanceMatrix.version, version, "instance matrices were re-uploaded with nothing moving");
  balls[1].position = [5, 5, 5];
  engine.batching.sync();
  assert.equal(batch.instanceMatrix.version, version + 1, "a real move must still upload");
});

check("letting go of a primitive releases the shared instance, never disposes it", () => {
  const shared = balls[0].getComponent("mesh").mesh.geometry;
  let disposed = false;
  shared.addEventListener("dispose", () => { disposed = true; });
  engine.destroyEntity(balls[0]);
  engine.flushHierarchyChanged();
  engine.batching.sync();
  assert.equal(disposed, false, "a shared primitive was disposed while other meshes still render it");
  assert.equal(balls[1].getComponent("mesh").mesh.geometry, shared);
});

check("clearing a geometry asset hands the mesh back the shared primitive", () => {
  const component = balls[2].getComponent("mesh");
  const shared = component.mesh.geometry;
  // Simulate the asset path: a private geometry stands in for a loaded .geom,
  // then the asset reference is cleared and the primitive must return.
  component.mesh.geometry = new THREE.BoxGeometry(2, 2, 2);
  component.setProp("geometryAsset", "");
  assert.equal(component.mesh.geometry, shared);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall batching checks passed");
process.exit(0);
