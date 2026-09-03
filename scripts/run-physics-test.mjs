/**
 * Physics gameplay layer (src/modules/physics-rapier/).
 *
 * Rapier runs headlessly in Node (its wasm is inlined), so this drives the
 * REAL PhysicsSystem against a real world — no stubs, no mocks. What it checks
 * is the layer above Rapier: that a collider lands on the layer you gave it,
 * that the matrix actually stops pairs from colliding, that queries filter the
 * way a gameplay programmer expects (and can exclude the shooter), and that
 * joints hold two bodies together.
 */
import assert from "node:assert/strict";

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
// TRAP, and the reason physics was never testable headlessly in this repo:
// Rapier's wasm-bindgen glue picks a BROWSER code path the moment `window`
// exists, and then calls `window.performance.now()`. A stub `window` without
// `performance` hands it undefined, and the wasm traps with a bare
// "unreachable" — no panic message, no stack into Rust, and every later Rapier
// call then fails with "recursive use of an object detected...", which sends
// you looking for a re-entrancy bug that does not exist. Forward the real
// `performance` (and `crypto`, which the same glue reaches for).
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  performance: globalThis.performance,
  crypto: globalThis.crypto,
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const { Engine, registerBuiltInComponents, applyEngineModules } = await import("../src/engine/index.js");
const { PhysicsLayers } = await import("../src/modules/physics-rapier/layers.js");
const {
  collectCollisionMesh,
  collisionSimplifierReady,
  simplifyCollisionMesh,
} = await import("../src/modules/physics-rapier/collisionGeometry.js");
const THREE = await import("three/webgpu");
await import("../src/modules/index.js"); // registers the module catalog

registerBuiltInComponents();

/**
 * Generated default Colliders attach DISABLED since 2026-09-02 (Project
 * Settings → Physics → "Auto colliders start enabled" restores the old
 * behaviour). The cases below were written against the old default and test
 * the generation machinery itself, so they opt back in explicitly; the
 * shipped default has its own case at the end.
 */
function makeEngine({ autoColliders = true } = {}) {
  const engine = new Engine();
  engine.config.physicsAutoColliders = { startEnabled: autoColliders };
  return engine;
}

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error.stack ?? error.message}`);
  }
};

/**
 * A live engine with the physics module enabled and the world built. The
 * module's setup resolves as soon as the JS loads and finishes the wasm init
 * in the background, so wait for `engine.physics` before touching it.
 */
async function world({ layers = null, build = () => {} } = {}) {
  const engine = makeEngine();
  if (layers) engine.config.physicsLayers = layers;
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  build(engine);
  engine.setPlaying(true); // builds the Rapier world from the entity tree
  return {
    engine,
    physics: engine.physics,
    // Physics steps on a fixed 1/60 accumulator, so a "frame" here is one step.
    step: (n = 1) => {
      for (let i = 0; i < n; i++) engine.physics.update(1 / 60);
    },
  };
}

function box(engine, name, position, props = {}) {
  const entity = engine.createEntity({ name });
  entity.object3D.position.set(...position);
  entity.addComponent("collider", { shape: "box", size: [1, 1, 1], ...props.collider });
  if (props.rigidbody !== null) entity.addComponent("rigidbody", { bodyType: "dynamic", ...props.rigidbody });
  return entity;
}

function mesh(engine, name, position, geometry = "torus") {
  const entity = engine.createEntity({ name });
  entity.object3D.position.set(...position);
  entity.addComponent("mesh", { geometry });
  return entity;
}

function meshWithCollider(engine, name, position, collider, geometry = "torus") {
  const entity = engine.createEntity({ name });
  entity.object3D.position.set(...position);
  entity.addComponent("collider", collider);
  entity.addComponent("mesh", { geometry });
  return entity;
}

function separateBoxes(entity) {
  const first = entity.getComponent("mesh").mesh;
  first.position.x = -2;
  const second = first.clone();
  second.geometry = first.geometry.clone();
  second.position.x = 2;
  second.userData.entityId = entity.id;
  entity.object3D.add(second);
  return [first, second];
}

function attachModelBox(entity, { x = 0, skinned = false } = {}) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  const object = skinned
    ? new THREE.SkinnedMesh(geometry, material)
    : new THREE.Mesh(geometry, material);
  object.position.x = x;
  object.userData.entityId = entity.id;
  entity.object3D.add(object);
  return object;
}

async function settlePhysicsBackground(engine, predicate = () => true) {
  const started = performance.now();
  do {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    engine.physics?.sync?.();
    if (predicate()) return;
  } while (performance.now() - started < 1000);
}

function renderedTriangleCount(entity) {
  let triangles = 0;
  entity.object3D.traverse((object) => {
    if (!object.isMesh || object.userData.engineOwned) return;
    const positions = object.geometry?.attributes?.position;
    if (!positions) return;
    triangles += (object.geometry.index?.count ?? positions.count) / 3;
  });
  return triangles;
}

function nativeTriangleCount(entity) {
  const component = entity.getComponent("collider");
  const native = component?.colliders?.length
    ? component.colliders
    : [component?.collider].filter(Boolean);
  return native.reduce((sum, collider) => sum + (collider.indices?.()?.length ?? 0) / 3, 0);
}

function assertDisconnectedTorusSurface(physics, y, entityName) {
  assert.equal(physics.raycast([-2, y, 2], [0, 0, -1], 4), null, "the left torus hole must stay open");
  assert.equal(physics.raycast([2, y, 2], [0, 0, -1], 4), null, "the right torus hole must stay open");
  assert.equal(physics.raycast([0, y, 2], [0, 0, -1], 4), null, "the gap between disconnected pieces must stay open");
  assert.equal(
    physics.raycast([-1.6, y, 2], [0, 0, -1], 4)?.entity?.name,
    entityName,
    "the left ring must still collide",
  );
  assert.equal(
    physics.raycast([2.4, y, 2], [0, 0, -1], 4)?.entity?.name,
    entityName,
    "the right ring must still collide",
  );
}

console.log("physics — layers");

await check("layer matrix is symmetric even when authored lopsided", () => {
  const layers = new PhysicsLayers({ names: ["A", "B", "C"], matrix: [0b011, 0b111, 0b111] });
  // A says it does not hit C, C says it hits A. One of them has to win, and
  // "they do not collide" is the only answer physics can actually express.
  assert.equal(layers.collides("A", "C"), false);
  assert.equal(layers.collides("C", "A"), false);
});

await check("groupsFor packs membership and filter the way Rapier reads them", () => {
  const layers = new PhysicsLayers({ names: ["A", "B"], matrix: [0b01, 0b10] });
  const groups = layers.groupsFor("B");
  assert.equal(groups >>> 16, 0b10, "membership is the layer's own bit");
  assert.equal(groups & 0xffff, 0b10, "filter is the matrix row");
});

await check("unknown layer names fall back to Default rather than throwing", () => {
  const layers = new PhysicsLayers({ names: ["Default", "Player"] });
  assert.equal(layers.indexOf("Nonexistent"), 0);
  assert.equal(layers.has("Nonexistent"), false);
});

await check("maskFor(null) means every layer", () => {
  const layers = new PhysicsLayers({ names: ["A", "B", "C"] });
  assert.equal(layers.maskFor(null), 0xffff);
  assert.equal(layers.maskFor(["B"]), 0b010);
  assert.equal(layers.maskFor(["A", "C"]), 0b101);
});

console.log("physics — world");

await check("a dynamic body falls and a static floor stops it", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Floor", [0, -0.5, 0], { rigidbody: null, collider: { size: [20, 1, 20] } });
      box(engine, "Crate", [0, 5, 0]);
    },
  });
  w.step(180);
  const y = [...w.engine.entities.values()].find((e) => e.name === "Crate")?.object3D.position.y;
  assert.ok(y > 0.4 && y < 0.7, `crate should rest on the floor, got y=${y}`);
});

await check("the layer matrix stops a pair from colliding", async () => {
  // Projectile does NOT collide with Player, but does collide with Ground.
  const names = ["Default", "Player", "Projectile", "Ground"];
  const matrix = [0b1111, 0b1011, 0b1101, 0b1111];
  const w = await world({
    layers: { names, matrix },
    build: (engine) => {
      box(engine, "Player", [0, 0, 0], {
        rigidbody: null,
        collider: { size: [4, 4, 4], layer: "Player" },
      });
      box(engine, "Bullet", [0, 6, 0], {
        collider: { layer: "Projectile" },
        rigidbody: { bodyType: "dynamic", gravityScale: 1 },
      });
    },
  });
  w.step(180);
  const bullet = [...w.engine.entities.values()].find((e) => e.name === "Bullet");
  assert.ok(
    bullet.object3D.position.y < -2,
    `bullet should fall THROUGH the player it cannot hit, got y=${bullet.object3D.position.y}`,
  );
});

await check("...and the same pair collides once the matrix allows it", async () => {
  const names = ["Default", "Player", "Projectile", "Ground"];
  const w = await world({
    layers: { names, matrix: null }, // null = everything collides
    build: (engine) => {
      box(engine, "Player", [0, 0, 0], {
        rigidbody: null,
        collider: { size: [4, 4, 4], layer: "Player" },
      });
      box(engine, "Bullet", [0, 6, 0], { collider: { layer: "Projectile" } });
    },
  });
  w.step(180);
  const bullet = [...w.engine.entities.values()].find((e) => e.name === "Bullet");
  assert.ok(
    bullet.object3D.position.y > 1.5,
    `bullet should land on the player, got y=${bullet.object3D.position.y}`,
  );
});

console.log("physics — mesh colliders");

await check("disabling physics cannot install its background system late", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  const ready = engine.modules.get("physics-rapier")?.ready;
  await applyEngineModules(engine, []);
  await ready;

  assert.equal(engine.modules.has("physics-rapier"), false, "the disabled module must stay absent");
  assert.equal(engine.physics, undefined, "late WASM readiness must dispose instead of publishing physics");
});

await check("enabling physics backfills Collider components onto existing meshes", async () => {
  const engine = makeEngine();
  const entity = mesh(engine, "Existing mesh", [0, 0, 0], "box");
  assert.equal(entity.getComponent("collider"), undefined, "a project without physics stays physics-free");

  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;

  assert.equal(
    entity.getComponent("collider")?.props.shape,
    "convex",
    "turning physics on should expose collision for meshes already in the scene",
  );
});

await check("rendered Model and Spline Mesh sources also receive visible Collider components", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const model = engine.createEntity({ name: "Model source" });
  attachModelBox(model);
  model.addComponent("model", {});
  const spline = engine.createEntity({ name: "Spline source" });
  spline.addComponent("splineMesh", {});
  await Promise.resolve();

  assert.equal(model.getComponent("collider")?.props.shape, "convex");
  assert.equal(spline.getComponent("collider")?.props.shape, "convex");
});

await check("a model made only of skinned meshes gets no generated Collider", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entity = engine.createEntity({ name: "Skinned-only model" });
  attachModelBox(entity, { skinned: true });
  entity.addComponent("model", {});

  await settlePhysicsBackground(engine);
  assert.equal(entity.getComponent("collider"), undefined, "a bind-pose skin must not become an editable default Collider");
  assert.equal(engine.physics.getCookedColliderGeometry(entity), null, "a skinned-only source must cook no collision geometry");

  engine.setPlaying(true);
  assert.equal(engine.physics.world.colliders.len(), 0, "the skinned model must create no native collider in Play");
  assert.equal(engine.physics.raycast([0, 0, 2], [0, 0, -1], 4), null);
});

await check("ordinary static model submeshes still collide beside an ignored skin", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entity = engine.createEntity({ name: "Mixed static and skin" });
  attachModelBox(entity, { x: -2, skinned: true });
  attachModelBox(entity, { x: 2 });
  entity.addComponent("model", {});

  await settlePhysicsBackground(engine, () => !!entity.getComponent("collider"));
  assert.equal(entity.getComponent("collider")?.props.autoGenerated, true, "the ordinary submesh should keep the generated component");

  engine.setPlaying(true);
  assert.equal(engine.physics.world.colliders.len(), 1, "only the ordinary static submesh should become a native hull");
  assert.equal(
    engine.physics.raycast([2, 0, 2], [0, 0, -1], 4)?.entity?.name,
    entity.name,
    "the ordinary submesh must collide",
  );
  assert.equal(
    engine.physics.raycast([-2, 0, 2], [0, 0, -1], 4),
    null,
    "the sibling SkinnedMesh must not contribute its bind-pose geometry",
  );
});

await check("model-loaded removes a stale generated Collider when a model resolves to only skin", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entity = engine.createEntity({ name: "Late skinned model" });
  const placeholder = attachModelBox(entity);
  const model = entity.addComponent("model", {});

  await settlePhysicsBackground(engine, () => !!entity.getComponent("collider"));
  assert.equal(entity.getComponent("collider")?.props.autoGenerated, true, "the static placeholder should initially receive collision");
  engine.setPlaying(true);
  assert.equal(engine.physics.world.colliders.len(), 1, "the placeholder collider should initially be live");

  entity.object3D.remove(placeholder);
  attachModelBox(entity, { skinned: true });
  engine.emit("model-loaded", entity);
  await settlePhysicsBackground(
    engine,
    () => !entity.getComponent("collider") && engine.physics.world.colliders.len() === 0,
  );

  assert.equal(entity.getComponent("collider"), undefined, "late skinned geometry must remove the stale generated component");
  assert.equal(model.props.collision, "auto", "internal cleanup must not persist a user deletion opt-out");
  assert.equal(engine.physics.getCookedColliderGeometry(entity), null, "the placeholder cook must be invalidated");
  assert.equal(engine.physics.world.colliders.len(), 0, "the stale native placeholder collider must be removed in Play");
  assert.equal(engine.physics.raycast([0, 0, 2], [0, 0, -1], 4), null);
});

await check("deleting generated Colliders persists an opt-out on every render source", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["ambientcg", "physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const sources = [
    ["Mesh source", "mesh", { geometry: "box" }],
    ["Model source", "model", {}],
    ["OBJ source", "objModel", {}],
    ["Spline source", "splineMesh", {}],
  ].map(([name, type, props]) => {
    const entity = engine.createEntity({ name });
    entity.addComponent(type, props);
    return { entity, type };
  });
  for (let i = 0; i < 4; i++) await Promise.resolve();

  for (const { entity } of sources) {
    assert.equal(entity.getComponent("collider")?.props.autoGenerated, true, `${entity.name} should get its default Collider`);
    entity.removeComponent("collider");
  }
  for (let i = 0; i < 4; i++) await Promise.resolve();

  for (const { entity, type } of sources) {
    const source = entity.getComponent(type);
    assert.equal(entity.getComponent("collider"), undefined, `${entity.name} must stay deleted`);
    assert.equal(source.props.collision, "none", `${type} should persist the deletion on its source component`);
    assert.equal(source.toJSON().props.collision, "none", `${type}'s serialized data should retain the opt-out`);
    assert.ok(
      source.constructor.schema.some((entry) => entry.key === "collision" && entry.options?.includes("none")),
      `${type} should expose its opt-out in component metadata`,
    );
  }

  // This mirrors RemoveComponentCommand.undo/redo: undo restores the source
  // mode before recreating the generated component; deleting it again opts out.
  const restored = sources[0].entity;
  restored.getComponent("mesh").setProp("collision", "auto");
  restored.addComponent("collider", { shape: "convex", autoGenerated: true });
  for (let i = 0; i < 2; i++) await Promise.resolve();
  assert.ok(restored.getComponent("collider"), "undo should keep the restored generated Collider");
  restored.removeComponent("collider");
  for (let i = 0; i < 2; i++) await Promise.resolve();
  assert.equal(restored.getComponent("mesh").props.collision, "none", "redo should restore the opt-out");
  assert.equal(restored.getComponent("collider"), undefined, "redo should keep the Collider deleted");
});

await check("internal generated-Collider suppression does not become a deletion opt-out", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entity = mesh(engine, "Controller visual", [0, 0, 0]);
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.ok(entity.getComponent("collider"), "the control needs an attached generated Collider");

  entity.addComponent("charactercontroller", {});
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.equal(entity.getComponent("collider"), undefined, "CharacterController should suppress the generated Collider");
  assert.equal(entity.getComponent("mesh").props.collision, "auto", "internal suppression must not persist as deletion");

  entity.removeComponent("charactercontroller");
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.ok(entity.getComponent("collider"), "removing the suppressor should restore automatic collision");
});

await check("skeletal and morphing render sources never receive generated Colliders", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;

  // Reproduce the asynchronous transition from an old placeholder Collider to
  // a loaded skeletal GLB. Pending state removes the placeholder immediately;
  // model-loaded then confirms that it must stay absent.
  const skeletal = engine.createEntity({ name: "Skeletal model" });
  const model = skeletal.addComponent("model", {});
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.ok(skeletal.getComponent("collider")?.props.autoGenerated, "the control starts with a generated placeholder");
  model.assetLoadsPending = true;
  engine.emit("component-changed", { entityId: skeletal.id, componentType: "model", key: "path" });
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.equal(skeletal.getComponent("collider"), undefined, "pending model geometry must remove a generated placeholder");

  const skin = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  skin.userData.entityId = skeletal.id;
  skeletal.object3D.add(skin);
  model.assetLoadsPending = false;
  engine.emit("model-loaded", skeletal);
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.equal(skeletal.getComponent("collider"), undefined, "a loaded SkinnedMesh must not regain automatic collision");
  assert.equal(model.props.collision, "auto", "skeletal suppression is derived state, not a persisted user opt-out");

  skeletal.addComponent("collider", { shape: "capsule", autoFit: false });
  for (let i = 0; i < 2; i++) await Promise.resolve();
  assert.ok(skeletal.getComponent("collider"), "an explicitly authored primitive Collider must remain possible");

  const morphing = mesh(engine, "Morph mesh", [0, 0, 0], "box");
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.ok(morphing.getComponent("collider")?.props.autoGenerated, "the static mesh starts with automatic collision");
  const morphMesh = morphing.getComponent("mesh").mesh;
  morphMesh.geometry.morphAttributes.position = [morphMesh.geometry.attributes.position.clone()];
  morphMesh.updateMorphTargets();
  engine.emit("component-changed", { entityId: morphing.id, componentType: "mesh", key: "geometry" });
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.equal(morphing.getComponent("collider"), undefined, "morph-deforming geometry must lose its generated Collider");

  const customized = mesh(engine, "Authored morph collider", [0, 0, 0], "box");
  for (let i = 0; i < 3; i++) await Promise.resolve();
  const authored = customized.getComponent("collider");
  authored.setProp("shape", "capsule");
  const authoredMesh = customized.getComponent("mesh").mesh;
  authoredMesh.geometry.morphAttributes.position = [authoredMesh.geometry.attributes.position.clone()];
  authoredMesh.updateMorphTargets();
  engine.emit("component-changed", { entityId: customized.id, componentType: "mesh", key: "geometry" });
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.equal(customized.getComponent("collider"), authored, "customizing a generated default makes it authored and preserves it");
});

await check("automatic geometry collection excludes deforming descendants without an owner filter", () => {
  const root = new THREE.Group();
  const fixed = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  skinned.position.x = 5;
  const morphed = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  morphed.position.x = -5;
  morphed.geometry.morphAttributes.position = [morphed.geometry.attributes.position.clone()];
  morphed.updateMorphTargets();
  root.add(fixed, skinned, morphed);

  const automatic = collectCollisionMesh(root, { includeSkinned: false });
  assert.equal(automatic.indices.length / 3, 12, "only the fixed box should contribute triangles");
  const xs = Array.from({ length: automatic.vertices.length / 3 }, (_, index) => automatic.vertices[index * 3]);
  assert.ok(Math.min(...xs) >= -0.5 && Math.max(...xs) <= 0.5, "neither deforming descendant may enter the ancestor cook");

  for (const child of root.children) {
    child.geometry.dispose();
    child.material.dispose();
  }
});

await check("a fixed mesh gets an actual convex Collider component by default", async () => {
  const w = await world({
    build: (engine) => mesh(engine, "Fixed torus", [0, 0, 0]),
  });
  const torus = [...w.engine.entities.values()].find((e) => e.name === "Fixed torus");
  const collider = torus.getComponent("collider");

  assert.ok(collider, "enabling physics should add a real Collider component to every mesh");
  assert.equal(collider.props.shape, "convex", "automatic mesh collision defaults to a solid convex hull");
  const shapeRow = collider.constructor.schema.find((row) => row.key === "shape");
  assert.ok(shapeRow?.options?.includes("concave"), "the Inspector shape dropdown must expose Concave");
  assert.ok(shapeRow?.options?.includes("convex"), "the Inspector shape dropdown must expose Convex");
  assert.ok(shapeRow?.options?.includes("mesh"), "the Inspector shape dropdown must expose exact Mesh collision");
  assert.equal(w.physics.world.colliders.len(), 1, "one mesh should make one native collider");
  assert.equal(w.physics.raycast([0, 0, 2], [0, 0, -1], 4)?.entity?.name, torus.name, "the convex hull fills the torus hole");
  assert.equal(
    w.physics.raycast([0.4, 0, 2], [0, 0, -1], 4)?.entity?.name,
    torus.name,
    "the same ray should hit the torus ring",
  );
});

await check("automatic hull data cooks in the background before Play", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entity = mesh(engine, "Prewarmed torus", [0, 0, 0]);
  entity.addComponent("rigidbody", { bodyType: "dynamic", gravityScale: 0 });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(entity.getComponent("collider")?.props.shape, "convex", "a moving mesh exposes its generated hull in the Inspector");
  const cooked = engine.physics.autoCollisionGeometry.get(entity);
  assert.ok(cooked?.convexParts?.[0]?.vertices?.length, "the idle cook should prepare convex data without entering Play");

  engine.setPlaying(true);
  assert.equal(engine.physics.raycast([0, 0, 2], [0, 0, -1], 4)?.entity?.name, entity.name);
});

await check("an unrelated hierarchy refresh does not recook every cached auto Collider", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entities = Array.from({ length: 24 }, (_, index) => mesh(engine, `Cached collider ${index}`, [index * 2, 0, 0], "box"));
  await settlePhysicsBackground(
    engine,
    () => entities.every((entity) => engine.physics.autoCollisionGeometry.has(entity)),
  );
  engine.setPlaying(true);
  const handles = entities.map((entity) => entity.getComponent("collider")?.collider?.handle);
  let recooked = 0;
  const unsubscribe = engine.on("physics-collider-cooked", () => recooked++);

  engine.emit("hierarchy-changed");
  await new Promise((resolve) => setTimeout(resolve, 40));
  unsubscribe();

  assert.equal(recooked, 0, "cached collision geometry must survive unrelated hierarchy UI refreshes");
  assert.deepEqual(
    entities.map((entity) => entity.getComponent("collider")?.collider?.handle),
    handles,
    "unrelated hierarchy refreshes must not rebuild live Rapier colliders",
  );
});

await check("many automatic Colliders stay cooked and native-stable through idle and fixed-step catch-up", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;

  // Enough separate shapes to make an accidental full-world rebuild visible,
  // while keeping them apart so contact solving is not the thing measured.
  const count = 96;
  const entities = Array.from({ length: count }, (_, index) => mesh(
    engine,
    `Stable auto collider ${index}`,
    [(index % 12) * 2, Math.floor(index / 12) * 2, 0],
    "box",
  ));
  await settlePhysicsBackground(
    engine,
    () => entities.every((entity) => {
      const component = entity.getComponent("collider");
      return component?.props.autoGenerated && engine.physics.autoCollisionGeometry.get(entity)?.convexParts?.length;
    }),
  );
  assert.equal(engine.physics.autoCookQueue.size, 0, "all background cooks must finish before the stability measurement");
  assert.ok(
    entities.every((entity) => engine.physics.autoCollisionGeometry.get(entity)?.convexParts?.length),
    "every automatic box should have cached convex data",
  );

  engine.setPlaying(true);
  const physics = engine.physics;
  const nativeCount = physics.world.colliders.len();
  assert.equal(nativeCount, count, "every generated Collider should have one live native shape");
  const nativeBefore = entities.map((entity) => entity.getComponent("collider").colliders.map((collider) => ({
    collider,
    handle: collider.handle,
  })));
  const cookedBefore = entities.map((entity) => physics.autoCollisionGeometry.get(entity));

  let cookedEvents = 0;
  let created = 0;
  let removed = 0;
  let stepCalls = 0;
  const unsubscribe = engine.on("physics-collider-cooked", () => cookedEvents++);
  const rapierWorld = physics.world;
  const originalCreateCollider = rapierWorld.createCollider;
  const originalRemoveCollider = rapierWorld.removeCollider;
  const originalStep = rapierWorld.step;
  rapierWorld.createCollider = function (...args) {
    created++;
    return originalCreateCollider.apply(this, args);
  };
  rapierWorld.removeCollider = function (...args) {
    removed++;
    return originalRemoveCollider.apply(this, args);
  };
  rapierWorld.step = function (...args) {
    stepCalls++;
    return originalStep.apply(this, args);
  };

  const ordinaryMs = [];
  const catchUpMs = [];
  try {
    physics.accumulator = 0;
    for (let frame = 1; frame <= 240; frame++) {
      // Simulate a periodic long frame. Physics must catch up by at most four
      // fixed steps; it must not mistake the hitch for a reason to rebuild.
      const catchUp = frame % 30 === 0;
      const callsBefore = stepCalls;
      const started = performance.now();
      physics.update(catchUp ? 0.25 : 1 / 60);
      (catchUp ? catchUpMs : ordinaryMs).push(performance.now() - started);
      assert.equal(
        stepCalls - callsBefore,
        catchUp ? 4 : 1,
        catchUp ? "a long frame must be capped at four substeps" : "an ordinary frame must take one fixed step",
      );
    }
  } finally {
    rapierWorld.createCollider = originalCreateCollider;
    rapierWorld.removeCollider = originalRemoveCollider;
    rapierWorld.step = originalStep;
    unsubscribe();
  }

  assert.equal(created, 0, "idle and catch-up frames must not recreate native colliders");
  assert.equal(removed, 0, "idle and catch-up frames must not remove native colliders");
  assert.equal(cookedEvents, 0, "idle and catch-up frames must not recook automatic geometry");
  assert.equal(physics.dirty.size, 0, "idle stepping must leave the rebuild queue empty");
  assert.equal(physics.world.colliders.len(), nativeCount, "native collider count must remain stable");
  entities.forEach((entity, entityIndex) => {
    assert.strictEqual(
      physics.autoCollisionGeometry.get(entity),
      cookedBefore[entityIndex],
      `${entity.name} must keep the same cooked buffer object`,
    );
    const current = entity.getComponent("collider").colliders;
    assert.equal(current.length, nativeBefore[entityIndex].length, `${entity.name} must keep its native shape count`);
    current.forEach((collider, colliderIndex) => {
      assert.strictEqual(
        collider,
        nativeBefore[entityIndex][colliderIndex].collider,
        `${entity.name} must keep the same native collider object`,
      );
      assert.equal(
        collider.handle,
        nativeBefore[entityIndex][colliderIndex].handle,
        `${entity.name} must keep the same native collider handle`,
      );
    });
  });

  const percentile = (samples, fraction) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  };
  const ordinaryMedian = percentile(ordinaryMs, 0.5);
  const ordinaryP95 = percentile(ordinaryMs, 0.95);
  const catchUpMedian = percentile(catchUpMs, 0.5);
  console.log(
    `       perf ${count} auto colliders: one-step median ${ordinaryMedian.toFixed(3)} ms, `
      + `p95 ${ordinaryP95.toFixed(3)} ms; four-step catch-up median ${catchUpMedian.toFixed(3)} ms`,
  );
});

await check("dynamic, kinematic and compound-child meshes use convex hulls", async () => {
  const w = await world({
    build: (engine) => {
      const dynamic = mesh(engine, "Dynamic torus", [-3, 0, 0]);
      dynamic.addComponent("rigidbody", { bodyType: "dynamic", gravityScale: 0 });

      const kinematic = mesh(engine, "Kinematic torus", [0, 0, 0]);
      kinematic.addComponent("rigidbody", { bodyType: "kinematic" });

      const parent = engine.createEntity({ name: "Compound body" });
      parent.object3D.position.set(3, 0, 0);
      parent.addComponent("rigidbody", { bodyType: "fixed" });
      const child = engine.createEntity({ name: "Compound child torus", parent });
      child.addComponent("mesh", { geometry: "torus" });
    },
  });

  for (const [x, name] of [[-3, "Dynamic torus"], [0, "Kinematic torus"], [3, "Compound child torus"]]) {
    const entity = [...w.engine.entities.values()].find((candidate) => candidate.name === name);
    assert.equal(entity.getComponent("collider")?.props.shape, "convex", `${name} should own a generated convex Collider`);
    const hit = w.physics.raycast([x, 0, 2], [0, 0, -1], 4);
    assert.ok(hit, `the convex hull should fill the torus hole at x=${x}`);
  }
  assert.equal(w.physics.world.colliders.len(), 3, "each rendered mesh contributes exactly one hull");
});

await check("an authored Collider wins over mesh defaults without duplication", async () => {
  const w = await world({
    build: (engine) => meshWithCollider(
      engine,
      "Authored collider",
      [0, 0, 0],
      { shape: "sphere", radius: 0.1, autoFit: false },
    ),
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Authored collider");

  assert.equal(entity.getComponent("collider")?.props.shape, "sphere", "mesh attachment must preserve the authored shape");
  assert.equal(w.physics.world.colliders.len(), 1, "the mesh must not add a second native collider");
  assert.equal(
    w.physics.raycast([0.4, 0, 2], [0, 0, -1], 4),
    null,
    "the torus surface must not collide when the authored sphere overrides it",
  );
  assert.equal(w.physics.raycast([0, 0, 2], [0, 0, -1], 4)?.entity?.name, entity.name);
});

await check("a disabled Collider stays visible as a component without implicit fallback", async () => {
  const w = await world({
    build: (engine) => {
      const entity = meshWithCollider(engine, "Disabled collision", [0, 0, 0], { shape: "convex" });
      entity.getComponent("collider").setEnabled(false);
    },
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Disabled collision");

  assert.ok(entity.getComponent("collider"), "disabling must not remove the authored component");
  assert.equal(w.physics.world.colliders.len(), 0, "disabled authored collision must not be replaced by an automatic hull");
  assert.equal(w.physics.raycast([0, 0, 2], [0, 0, -1], 4), null);
});

await check("a mesh can opt out of automatic collision", async () => {
  const w = await world({
    build: (engine) => {
      const entity = mesh(engine, "Decoration", [0, 0, 0]);
      entity.getComponent("mesh").setProp("collision", "none");
    },
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Decoration");
  assert.equal(entity.getComponent("collider"), undefined, "opting out removes the generated Collider component");
  assert.equal(w.physics.world.colliders.len(), 0);
  assert.equal(w.physics.raycast([0.4, 0, 2], [0, 0, -1], 4), null);
});

await check("a CharacterController suppresses the visual mesh collider", async () => {
  const w = await world({
    build: (engine) => {
      const entity = mesh(engine, "Character visual", [0, 0, 0]);
      entity.addComponent("charactercontroller", {
        radius: 0.1,
        height: 1,
        applyGravity: false,
        snapToGround: false,
      });
    },
  });

  const entity = [...w.engine.entities.values()].find((e) => e.name === "Character visual");
  assert.equal(entity.getComponent("collider"), undefined, "the controller removes the generated Collider component");
  assert.equal(w.physics.world.colliders.len(), 1, "the controller should own the entity's only collider");
  assert.equal(
    w.physics.raycast([0.4, 0, 2], [0, 0, -1], 4),
    null,
    "the torus visual must not add collision around the narrow controller capsule",
  );
});

await check("an explicit convex collider fills a concave mesh's hole", async () => {
  const w = await world({
    build: (engine) => meshWithCollider(engine, "Convex torus", [0, 0, 0], { shape: "convex" }),
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Convex torus");

  assert.equal(w.physics.world.colliders.len(), 1, "the explicit hull should suppress another generated collider");
  assert.equal(w.physics.raycast([0, 0, 2], [0, 0, -1], 4)?.entity?.name, entity.name);
});

await check("dynamic Concave and Mesh requests use convex runtime collision", async () => {
  const authoredShapes = [[-1, "Dynamic Concave", "concave"], [1, "Dynamic Mesh", "mesh"]];
  const w = await world({
    build: (engine) => {
      for (const [x, name, shape] of authoredShapes) {
        const entity = meshWithCollider(engine, name, [x, 0, 0], { shape });
        entity.addComponent("rigidbody", { bodyType: "dynamic", gravityScale: 0, mass: 4 });
      }
    },
  });

  for (const [x, name, shape] of authoredShapes) {
    const entity = [...w.engine.entities.values()].find((candidate) => candidate.name === name);
    assert.equal(entity.getComponent("collider").props.shape, shape, "the runtime fallback must not rewrite authored data");
    assert.equal(
      w.physics.raycast([x, 0, 2], [0, 0, -1], 4)?.entity?.name,
      name,
      `${shape} must use a solid convex fallback on a dynamic body`,
    );
    assert.ok(
      Math.abs(entity.getComponent("collider").collider.mass() - 4) < 1e-3,
      `${shape} fallback should preserve the Rigidbody mass`,
    );
  }
});

await check("Concave welds render seams on its private simplification copy", async () => {
  await collisionSimplifierReady;
  const engine = makeEngine();
  const entity = mesh(engine, "Seamed torus", [0, 0, 0]);
  const geometry = entity.getComponent("mesh").mesh.geometry.toNonIndexed();
  const vertices = new Float32Array(geometry.attributes.position.array);
  const indices = Uint32Array.from({ length: vertices.length / 3 }, (_, index) => index);
  const originalVertices = new Float32Array(vertices);
  const reduced = simplifyCollisionMesh({ vertices, indices });

  const positions = new Set();
  for (let i = 0; i < reduced.vertices.length; i += 3) {
    positions.add(`${reduced.vertices[i]},${reduced.vertices[i + 1]},${reduced.vertices[i + 2]}`);
  }
  assert.equal(positions.size, reduced.vertices.length / 3, "the collision copy should contain no duplicate seam positions");
  assert.ok(reduced.indices.length < indices.length, "the welded surface should reduce below its rendered triangle count");
  assert.deepEqual(vertices, originalVertices, "collision welding must not mutate render geometry");
  geometry.dispose();
});

await check("Mesh collision preserves every rendered triangle and disconnected hole", async () => {
  const w = await world({
    build: (engine) => {
      const entity = meshWithCollider(engine, "Exact mesh rings", [0, 0, 0], { shape: "mesh" });
      separateBoxes(entity);
    },
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Exact mesh rings");
  const sourceTriangles = renderedTriangleCount(entity);
  const colliderTriangles = nativeTriangleCount(entity);

  assert.equal(entity.getComponent("collider").props.shape, "mesh", "Mesh must stay a distinct exact shape");
  assert.ok(sourceTriangles > 1000, `the reduction control needs a detailed source, got ${sourceTriangles} triangles`);
  assert.equal(
    colliderTriangles,
    sourceTriangles,
    `Mesh must keep the full rendered surface (${sourceTriangles} source vs ${colliderTriangles} collider triangles)`,
  );
  assertDisconnectedTorusSurface(w.physics, 0, entity.name);
});

await check("Concave collision reduces triangles without sealing holes or joining pieces", async () => {
  const w = await world({
    build: (engine) => {
      const entity = meshWithCollider(engine, "Reduced concave rings", [0, 0, 0], { shape: "concave" });
      separateBoxes(entity);
    },
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Reduced concave rings");
  const sourceTriangles = renderedTriangleCount(entity);
  const colliderTriangles = nativeTriangleCount(entity);

  assert.ok(colliderTriangles > 0, "Concave must still build a triangle surface");
  assert.ok(
    colliderTriangles < sourceTriangles,
    `Concave must reduce the rendered surface (${sourceTriangles} source vs ${colliderTriangles} collider triangles)`,
  );
  assertDisconnectedTorusSurface(w.physics, 0, entity.name);
});

await check("the generated Collider can be changed to Concave in place", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entity = mesh(engine, "Edited generated torus", [0, 0, 0]);
  await Promise.resolve();
  const collider = entity.getComponent("collider");
  collider.setProp("shape", "concave");
  engine.setPlaying(true);

  assert.equal(collider.props.shape, "concave");
  assert.equal(collider.props.autoGenerated, true, "editing keeps per-entity geometry ownership");
  assert.equal(collider.props.autoCustomized, true, "the edited default now persists as authored collision");
  assert.equal(engine.physics.raycast([0, 0, 2], [0, 0, -1], 4), null);
});

await check("one visible convex Collider preserves disconnected mesh pieces", async () => {
  const w = await world({
    build: (engine) => {
      const convex = mesh(engine, "Convex pieces", [0, 0, 0], "box");
      separateBoxes(convex);
      const concave = meshWithCollider(engine, "Concave pieces", [0, 3, 0], { shape: "concave" }, "box");
      separateBoxes(concave);
    },
  });

  const convex = [...w.engine.entities.values()].find((entity) => entity.name === "Convex pieces");
  assert.equal(
    [...convex.components.values()].filter((component) => component.type === "collider").length,
    1,
    "the Inspector should show one Collider component even when it owns several native hulls",
  );
  assert.equal(w.physics.world.colliders.len(), 3, "two convex pieces plus one concave mesh make three native colliders");
  assert.equal(w.physics.raycast([0, 0, 2], [0, 0, -1], 4), null, "convex cooking must not bridge the empty gap");
  assert.equal(w.physics.raycast([-2, 0, 2], [0, 0, -1], 4)?.entity?.name, "Convex pieces", "the left convex piece collides");
  assert.equal(w.physics.raycast([2, 0, 2], [0, 0, -1], 4)?.entity?.name, "Convex pieces", "the right convex piece collides");
  assert.equal(w.physics.raycast([0, 3, 2], [0, 0, -1], 4), null, "the concave collider preserves the gap between pieces");
  assert.equal(w.physics.raycast([2, 3, 2], [0, 0, -1], 4)?.entity?.name, "Concave pieces", "the second geometry is included");
});

await check("disconnected hulls disable and rebuild as one Collider component", async () => {
  const w = await world({
    build: (engine) => {
      const entity = mesh(engine, "Rebuilt pieces", [0, 0, 0], "box");
      separateBoxes(entity);
    },
  });
  const entity = [...w.engine.entities.values()].find((candidate) => candidate.name === "Rebuilt pieces");
  const collider = entity.getComponent("collider");
  assert.equal(collider.colliders.length, 2);
  assert.equal(collider.collider, collider.colliders[0], "the compatibility handle points at the first hull");

  collider.setEnabled(false);
  assert.equal(w.physics.world.colliders.len(), 0, "disabling removes every native hull");
  collider.setEnabled(true);
  w.physics.sync();
  assert.equal(collider.colliders.length, 2, "re-enabling rebuilds every disconnected hull");
  assert.equal(w.physics.world.colliders.len(), 2);
});

await check("dynamic mass is distributed by disconnected hull volume", async () => {
  const w = await world({
    build: (engine) => {
      const entity = mesh(engine, "Unequal pieces", [0, 0, 0], "box");
      const [, large] = separateBoxes(entity);
      large.scale.setScalar(2);
      entity.addComponent("rigidbody", { bodyType: "dynamic", gravityScale: 0, mass: 9 });
    },
  });
  const entity = [...w.engine.entities.values()].find((candidate) => candidate.name === "Unequal pieces");
  const masses = entity.getComponent("collider").colliders.map((collider) => collider.mass()).sort((a, b) => a - b);
  assert.ok(Math.abs(masses[0] + masses[1] - 9) < 1e-3, `compound mass should stay 9, got ${masses}`);
  assert.ok(Math.abs(masses[1] / masses[0] - 8) < 0.1, `2x box should receive 8x mass, got ${masses}`);
});

await check("the convex preview draws every cooked disconnected hull", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entity = mesh(engine, "Preview pieces", [0, 0, 0], "box");
  separateBoxes(entity);
  engine.physics.invalidateAutoCollider(entity);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const collider = entity.getComponent("collider");
  collider.setOutlineVisible(true);
  const parts = engine.physics.getCookedColliderGeometry(entity)?.convexParts;
  assert.ok(collider.outline && parts?.length === 2, "selection should build both cooked convex outlines");
  const hullPoints = new Set();
  for (const part of parts) {
    for (let i = 0; i < part.vertices.length; i += 3) {
      hullPoints.add(`${part.vertices[i].toFixed(5)},${part.vertices[i + 1].toFixed(5)},${part.vertices[i + 2].toFixed(5)}`);
    }
  }
  const preview = collider.outline.geometry.attributes.position.array;
  assert.ok(
    Array.from({ length: preview.length / 3 }, (_, i) => i * 3).every((i) =>
      hullPoints.has(`${preview[i].toFixed(5)},${preview[i + 1].toFixed(5)},${preview[i + 2].toFixed(5)}`)),
    "every preview edge endpoint should come from one of the cooked hull parts",
  );
  const previewX = Array.from({ length: preview.length / 3 }, (_, i) => preview[i * 3]);
  assert.ok(Math.min(...previewX) < -2.4, "the preview includes the left cooked hull");
  assert.ok(Math.max(...previewX) > 2.4, "the preview includes the right cooked hull");
});

await check("a disabled geometry collider remembers its requested preview", async () => {
  const engine = makeEngine();
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entity = mesh(engine, "Disabled preview", [0, 0, 0], "box");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const collider = entity.getComponent("collider");
  collider.setEnabled(false);
  collider.setDebugVisible(true, true);
  assert.equal(collider.outline ?? null, null, "a disabled component should not allocate an invisible outline");

  collider.setEnabled(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(collider.outline?.visible, "re-enabling should restore the Colliders layer request after cooking");

  collider.setDebugVisible(false, false);
  assert.equal(collider.outline, null, "turning Colliders off should dispose the on-demand outline");
});

await check("legacy mesh collider values remain exact Mesh collision", async () => {
  const w = await world({
    build: (engine) => meshWithCollider(engine, "Legacy mesh torus", [0, 0, 0], { shape: "mesh" }),
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Legacy mesh torus");

  assert.equal(entity.getComponent("collider")?.props.shape, "mesh", "old mesh values must keep their exact collision contract");
  assert.equal(w.physics.world.colliders.len(), 1);
  assert.equal(
    nativeTriangleCount(entity),
    renderedTriangleCount(entity),
    "legacy Mesh must keep all rendered triangles rather than entering the reduced Concave path",
  );
  assert.equal(w.physics.raycast([0, 0, 2], [0, 0, -1], 4), null, "legacy Mesh keeps the torus hole open");
  assert.equal(w.physics.raycast([0.4, 0, 2], [0, 0, -1], 4)?.entity?.name, entity.name);
});

await check("autoCenter places an explicit primitive collider at the mesh geometry", async () => {
  const w = await world({
    build: (engine) => {
      const entity = meshWithCollider(
        engine,
        "Offset mesh",
        [0, 0, 0],
        { shape: "box", size: [1, 1, 1], autoFit: false, autoCenter: true },
        "box",
      );
      entity.getComponent("mesh").mesh.position.set(3, 0, 0);
    },
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Offset mesh");

  assert.equal(w.physics.raycast([3, 0, 2], [0, 0, -1], 4)?.entity?.name, entity.name, "the collider follows the local geometry centre");
  assert.equal(w.physics.raycast([0, 0, 2], [0, 0, -1], 4), null, "it must not remain at the entity origin");
});

await check("primitive colliders fit the mesh AABB by default", async () => {
  const w = await world({
    build: (engine) => {
      const entity = meshWithCollider(engine, "Wide mesh", [0, 0, 0], { shape: "box" }, "box");
      entity.getComponent("mesh").mesh.scale.set(4, 2, 1);
    },
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Wide mesh");

  assert.equal(
    w.physics.raycast([1.5, 0, 2], [0, 0, -1], 4)?.entity?.name,
    entity.name,
    "the default box must use the rendered width instead of 1 metre",
  );
  assert.equal(
    w.physics.raycast([2.1, 0, 2], [0, 0, -1], 4),
    null,
    "the fitted box should end at the mesh AABB",
  );
});

await check("primitive collider rotation is authored in degrees", async () => {
  const w = await world({
    build: (engine) => {
      const entity = engine.createEntity({ name: "Rotated thin box" });
      entity.addComponent("collider", {
        shape: "box",
        size: [4, 0.2, 0.2],
        rotation: [0, 0, 90],
      });
    },
  });
  const entity = [...w.engine.entities.values()].find((e) => e.name === "Rotated thin box");

  assert.equal(
    w.physics.raycast([0, 1.5, 2], [0, 0, -1], 4)?.entity?.name,
    entity.name,
    "90° around Z turns the long X axis onto Y",
  );
  assert.equal(
    w.physics.raycast([1.5, 0, 2], [0, 0, -1], 4),
    null,
    "the long axis must no longer lie on X",
  );
});

console.log("physics — queries");

await check("raycast reports the entity, point, normal and distance", async () => {
  const w = await world({
    build: (engine) => box(engine, "Target", [0, 0, 0], { rigidbody: null }),
  });
  const hit = w.physics.raycast([0, 5, 0], [0, -1, 0], 20);
  assert.ok(hit, "expected a hit");
  assert.equal(hit.entity?.name, "Target");
  assert.ok(Math.abs(hit.distance - 4.5) < 0.05, `distance ${hit.distance}`);
  assert.ok(hit.normal[1] > 0.9, `normal should point up, got ${hit.normal}`);
});

await check("raycast layer filter ignores everything else", async () => {
  const w = await world({
    layers: { names: ["Default", "Player", "Enemy"] },
    build: (engine) => {
      box(engine, "Near", [0, 2, 0], { rigidbody: null, collider: { layer: "Player" } });
      box(engine, "Far", [0, 0, 0], { rigidbody: null, collider: { layer: "Enemy" } });
    },
  });
  assert.equal(w.physics.raycast([0, 6, 0], [0, -1, 0], 20)?.entity?.name, "Near", "unfiltered hits the nearest");
  assert.equal(
    w.physics.raycast([0, 6, 0], [0, -1, 0], 20, { layers: ["Enemy"] })?.entity?.name,
    "Far",
    "filtered skips the Player-layer collider in front",
  );
});

await check("a layer that collides with nothing is still raycastable", async () => {
  // The reason queries do not reuse the collision matrix. A trigger volume
  // that collides with nothing must still answer "what is under the cursor".
  const names = ["Default", "Ghost"];
  const matrix = [0b01, 0b00];
  const w = await world({
    layers: { names, matrix },
    build: (engine) => box(engine, "Ghost", [0, 0, 0], { rigidbody: null, collider: { layer: "Ghost" } }),
  });
  const hit = w.physics.raycast([0, 6, 0], [0, -1, 0], 20, { layers: ["Ghost"] });
  assert.equal(hit?.entity?.name, "Ghost");
});

await check("exclude ignores the shooter's own colliders", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Shooter", [0, 5, 0], { rigidbody: null });
      box(engine, "Target", [0, 0, 0], { rigidbody: null });
    },
  });
  const shooter = [...w.engine.entities.values()].find((e) => e.name === "Shooter");
  // Firing from inside your own collider is the normal case for a muzzle.
  assert.equal(w.physics.raycast([0, 5, 0], [0, -1, 0], 20)?.entity?.name, "Shooter", "hits itself without exclude");
  assert.equal(
    w.physics.raycast([0, 5, 0], [0, -1, 0], 20, { exclude: shooter })?.entity?.name,
    "Target",
    "excluded, so it reaches the target",
  );
});

await check("exclude covers the entity's whole subtree", async () => {
  const w = await world({
    build: (engine) => {
      const player = engine.createEntity({ name: "Player" });
      player.object3D.position.set(0, 5, 0);
      const weapon = engine.createEntity({ name: "Weapon", parent: player });
      weapon.addComponent("collider", { shape: "box", size: [1, 1, 1] });
      box(engine, "Target", [0, 0, 0], { rigidbody: null });
    },
  });
  const player = [...w.engine.entities.values()].find((e) => e.name === "Player");
  const hit = w.physics.raycast([0, 5, 0], [0, -1, 0], 20, { exclude: player });
  assert.equal(hit?.entity?.name, "Target", "the child weapon collider was excluded too");
});

await check("raycastAll returns every hit, nearest first", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "A", [0, 3, 0], { rigidbody: null });
      box(engine, "B", [0, 1, 0], { rigidbody: null });
      box(engine, "C", [0, -1, 0], { rigidbody: null });
    },
  });
  const hits = w.physics.raycastAll([0, 8, 0], [0, -1, 0], 30);
  assert.deepEqual(hits.map((h) => h.entity.name), ["A", "B", "C"]);
});

await check("spherecast has thickness a ray does not", async () => {
  // Two boxes with a 0.4-wide gap between them. A ray straight down the gap
  // misses; a 0.5-radius sphere cannot fit and must hit.
  const w = await world({
    build: (engine) => {
      box(engine, "Left", [-0.7, 0, 0], { rigidbody: null });
      box(engine, "Right", [0.7, 0, 0], { rigidbody: null });
    },
  });
  assert.equal(w.physics.raycast([0, 6, 0], [0, -1, 0], 20), null, "the ray slips through the gap");
  const hit = w.physics.spherecast([0, 6, 0], 0.5, [0, -1, 0], 20);
  assert.ok(hit, "the sphere is too fat to fit and hits");
  assert.ok(["Left", "Right"].includes(hit.entity?.name), hit.entity?.name);
});

await check("overlapSphere finds everything inside it, once per entity", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Near", [1, 0, 0], { rigidbody: null });
      box(engine, "Also", [-1, 0, 0], { rigidbody: null });
      box(engine, "Far", [50, 0, 0], { rigidbody: null });
    },
  });
  const found = w.physics.overlapSphere([0, 0, 0], 3).map((e) => e.name).sort();
  assert.deepEqual(found, ["Also", "Near"]);
});

await check("overlapBox respects the layer filter", async () => {
  const w = await world({
    layers: { names: ["Default", "Pickup"] },
    build: (engine) => {
      box(engine, "Coin", [0, 0, 0], { rigidbody: null, collider: { layer: "Pickup" } });
      box(engine, "Wall", [0.5, 0, 0], { rigidbody: null });
    },
  });
  const found = w.physics.overlapBox([0, 0, 0], [2, 2, 2], { layers: ["Pickup"] });
  assert.deepEqual(found.map((e) => e.name), ["Coin"]);
});

console.log("physics — joints");

await check("a hinge holds a body to the world instead of letting it fall", async () => {
  const w = await world({
    build: (engine) => {
      const door = box(engine, "Door", [0, 3, 0]);
      // With no connected entity the world anchor is created AT the door's
      // pose, so both anchors are the same local offset — the hinge line runs
      // down the door's left edge.
      door.addComponent("joint", { kind: "hinge", anchor: [-0.5, 0, 0], connectedAnchor: [-0.5, 0, 0], axis: [0, 1, 0] });
    },
  });
  w.step(180);
  const door = [...w.engine.entities.values()].find((e) => e.name === "Door");
  assert.ok(
    Math.abs(door.object3D.position.y - 3) < 0.3,
    `a hinged door should stay at its pivot height, got y=${door.object3D.position.y}`,
  );
});

await check("a fixed joint carries one body along with another", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Anchor", [0, 3, 0], { rigidbody: { bodyType: "kinematic" } });
      const hung = box(engine, "Hung", [0, 1, 0]);
      hung.addComponent("joint", {
        kind: "fixed",
        connectedEntity: [...engine.entities.values()].find((e) => e.name === "Anchor").id,
        anchor: [0, 0, 0],
        connectedAnchor: [0, -2, 0],
      });
    },
  });
  w.step(120);
  const hung = [...w.engine.entities.values()].find((e) => e.name === "Hung");
  assert.ok(
    hung.object3D.position.y > 0.5,
    `a fixed joint to a kinematic anchor should hold it up, got y=${hung.object3D.position.y}`,
  );
});

await check("a joint naming a missing entity warns instead of crashing the build", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(String(args[0]));
  try {
    const w = await world({
      build: (engine) => {
        const e = box(engine, "Lonely", [0, 3, 0]);
        e.addComponent("joint", { kind: "hinge", connectedEntity: "does-not-exist" });
      },
    });
    w.step(10);
    assert.ok(warnings.some((m) => m.includes("connected entity not found")), warnings.join(" | "));
  } finally {
    console.warn = original;
  }
});

console.log("physics — events");

await check("a body that spawns already inside a trigger still reports entering it", async () => {
  // The world is primed with a zero-length step so queries work before the
  // first frame; if that step drained the event queue, this overlap would be
  // swallowed and the trigger would never fire.
  const w = await world({
    build: (engine) => {
      box(engine, "Zone", [0, 0, 0], { rigidbody: null, collider: { size: [4, 4, 4], isSensor: true } });
      box(engine, "Spawned", [0, 0, 0], { rigidbody: { bodyType: "dynamic", gravityScale: 0 } });
    },
  });
  const triggers = [];
  w.engine.on("trigger", ({ a, b, started }) => triggers.push(`${a.name}->${b.name}:${started}`));
  w.step(3);
  assert.ok(triggers.length > 0, "expected a trigger event on the first tick");
  assert.ok(triggers[0].includes("true"), triggers.join(", "));
});

await check("collision events reach every script on both entities", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Ground", [0, -0.5, 0], { rigidbody: null, collider: { size: [10, 1, 10] } });
      box(engine, "Faller", [0, 3, 0]);
    },
  });
  const collisions = [];
  w.engine.on("collision", ({ a, b, started }) => collisions.push(`${a.name}/${b.name}:${started}`));
  w.step(120);
  assert.ok(collisions.some((c) => c.includes("true")), `expected a collision, got ${collisions.join(", ")}`);
});

await check("compound hull contacts emit one logical enter and exit", async () => {
  const w = await world({
    build: (engine) => {
      box(engine, "Wide trigger", [0, 0, 0], {
        rigidbody: null,
        collider: { size: [8, 3, 3], isSensor: true },
      });
      const entity = mesh(engine, "Compound visitor", [0, 0, 0], "box");
      separateBoxes(entity);
      entity.addComponent("rigidbody", { bodyType: "dynamic", gravityScale: 0 });
    },
  });
  const events = [];
  w.engine.on("trigger", ({ a, b, started }) => {
    if ([a.name, b.name].includes("Compound visitor")) events.push(started);
  });
  w.step(2);
  const visitor = [...w.engine.entities.values()].find((entity) => entity.name === "Compound visitor");
  visitor.getComponent("rigidbody").teleport([20, 0, 0]);
  w.step(2);
  assert.deepEqual(events, [true, false], `native hull pairs must collapse to one logical contact: ${events}`);
});

console.log("physics — character controller");

await check("the character capsule honours its layer", async () => {
  // Player does not collide with Debris, so the character walks through it.
  const names = ["Default", "Player", "Debris"];
  const matrix = [0b111, 0b011, 0b101];
  const w = await world({
    layers: { names, matrix },
    build: (engine) => {
      box(engine, "Floor", [0, -0.5, 0], { rigidbody: null, collider: { size: [40, 1, 40] } });
      box(engine, "Rubble", [1.5, 0.5, 0], { rigidbody: null, collider: { size: [1, 1, 1], layer: "Debris" } });
      const player = engine.createEntity({ name: "Player" });
      player.object3D.position.set(0, 1, 0);
      player.addComponent("charactercontroller", { radius: 0.3, height: 1, layer: "Player" });
    },
  });
  const player = [...w.engine.entities.values()].find((e) => e.name === "Player");
  player.getComponent("charactercontroller").move([4, 0, 0]);
  w.step(60);
  assert.ok(
    player.object3D.position.x > 1.9,
    `the player should pass through debris it cannot collide with, x=${player.object3D.position.x.toFixed(2)}`,
  );
});

await check("a character is carried by the moving platform it stands on", async () => {
  const w = await world({
    build: (engine) => {
      const platform = engine.createEntity({ name: "Platform" });
      platform.object3D.position.set(0, 0, 0);
      platform.addComponent("rigidbody", { bodyType: "kinematic" });
      platform.addComponent("collider", { shape: "box", size: [6, 1, 6] });

      const player = engine.createEntity({ name: "Player" });
      player.object3D.position.set(0, 1.2, 0);
      player.addComponent("charactercontroller", { radius: 0.3, height: 1 });
    },
  });
  const platform = [...w.engine.entities.values()].find((e) => e.name === "Platform");
  const player = [...w.engine.entities.values()].find((e) => e.name === "Player");
  w.step(30); // settle onto the platform
  const startX = player.object3D.position.x;

  // Drive the platform sideways, the way a script or animation would.
  for (let i = 0; i < 60; i++) {
    platform.object3D.position.x += 0.05;
    w.step(1);
  }
  const carried = player.object3D.position.x - startX;
  assert.ok(carried > 1.5, `the player should ride the platform (~3 units), moved ${carried.toFixed(2)}`);
  assert.equal(player.getComponent("charactercontroller").getPlatform()?.name, "Platform");
});

await check("generated default colliders attach DISABLED and cook nothing until enabled (the shipped default)", async () => {
  const engine = makeEngine({ autoColliders: false });
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  let cooked = 0;
  engine.on?.("physics-collider-cooked", () => { cooked++; });
  const entity = mesh(engine, "Big static mesh", [0, 0, 0], "box");

  await settlePhysicsBackground(engine, () => !!entity.getComponent("collider"));
  const collider = entity.getComponent("collider");
  assert.equal(collider?.props.autoGenerated, true, "the generated component must still be attached (visible, switchable)");
  assert.equal(collider.enabled, false, "the generated component must start disabled");
  assert.equal(collider.props.autoCustomized, false, "an untouched default is not authored");
  assert.equal(engine.physics.getCookedColliderGeometry(entity), null, "a disabled default must cook no collision geometry");
  assert.equal(cooked, 0, "no cook event while every default is disabled");

  engine.setPlaying(true);
  assert.equal(engine.physics.world.colliders.len(), 0, "a disabled default must create no native shape in Play");
  assert.equal(engine.physics.raycast([0, 0, 2], [0, 0, -1], 4), null, "nothing to hit while disabled");
  engine.setPlaying(false);

  // Switching it on is authoring it: the shape appears, and the automatic
  // removal pass may never reap it as an untouched default again.
  collider.setProp("enabled", true);
  assert.equal(collider.props.autoCustomized, true, "enabling a generated default marks it authored");
  await settlePhysicsBackground(engine, () => !!engine.physics.getCookedColliderGeometry(entity));
  assert.ok(engine.physics.getCookedColliderGeometry(entity), "an enabled default cooks its geometry");
  engine.setPlaying(true);
  assert.equal(engine.physics.world.colliders.len(), 1, "an enabled default becomes a native shape in Play");
  assert.equal(engine.physics.raycast([0, 0, 2], [0, 0, -1], 4)?.entity?.name, entity.name, "and it collides");
});

await check("the project setting restores generated colliders that start enabled", async () => {
  const engine = makeEngine({ autoColliders: true });
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  const entity = mesh(engine, "Legacy default", [0, 0, 0], "box");
  await settlePhysicsBackground(engine, () => !!entity.getComponent("collider"));
  assert.equal(entity.getComponent("collider")?.enabled, true, "with the setting on, the default attaches enabled");
  engine.setPlaying(true);
  assert.equal(engine.physics.world.colliders.len(), 1, "and builds its native shape");
});

console.log(failures ? `\n${failures} failing` : "\nall physics checks passed");
process.exit(failures ? 1 : 0);
