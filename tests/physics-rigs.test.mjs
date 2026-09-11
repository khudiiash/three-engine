/**
 * DESTRUCTIBLE, CHAIN AND RAGDOLL against the real Rapier world.
 *
 * Rapier runs headlessly in Node (its wasm is inlined), so these drive the
 * REAL PhysicsSystem the same way `scripts/run-physics-test.mjs` does — no
 * stubs. What is being checked is the layer above Rapier:
 *
 *   · a Destructible really replaces one body with N, weighs them by volume
 *     and can be put back together;
 *   · a Chain's joints actually hold, both over child entities and over
 *     Instancer instances that are not entities at all;
 *   · a Ragdoll builds itself from an arbitrary skeleton, poses the bones from
 *     the bodies, and hands the character back to its animator intact.
 */
import test from "node:test";
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
// See run-physics-test.mjs: Rapier's wasm-bindgen glue takes the browser path
// the moment `window` exists and then calls window.performance.now(); a stub
// without it traps with a bare "unreachable".
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  performance: globalThis.performance,
  crypto: globalThis.crypto,
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const THREE = await import("three/webgpu");
const { Engine, registerBuiltInComponents, applyEngineModules } = await import("../src/engine/index.js");
await import("../src/modules/index.js"); // registers the module catalog
registerBuiltInComponents();

async function world(build = () => {}) {
  const engine = new Engine();
  engine.config.physicsAutoColliders = { startEnabled: false };
  await applyEngineModules(engine, ["physics-rapier"]);
  await engine.modules.get("physics-rapier")?.ready;
  await build(engine);
  engine.setPlaying(true);
  return {
    engine,
    physics: engine.physics,
    step: (n = 1) => {
      for (let i = 0; i < n; i++) engine.physics.update(1 / 60);
    },
  };
}

/** A box entity whose geometry is a plain owned THREE.Mesh, as a GLB's is. */
function boxEntity(engine, name, position = [0, 0, 0], size = [2, 2, 2]) {
  const entity = engine.createEntity({ name });
  entity.object3D.position.set(...position);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial());
  mesh.userData.entityId = entity.id;
  entity.object3D.add(mesh);
  entity.object3D.updateMatrixWorld(true);
  return entity;
}

const cubeEntity = (engine, name, position, size = 2) => boxEntity(engine, name, position, [size, size, size]);

/** A floor whose TOP is y = 0 — anything else quietly buries the test. */
function ground(engine) {
  const floor = boxEntity(engine, "Ground", [0, -0.5, 0], [40, 1, 40]);
  floor.addComponent("collider", { shape: "box", size: [40, 1, 40], autoFit: false });
  return floor;
}

/* -------------------------------------------------------------------------- */
/* Destructible                                                                */
/* -------------------------------------------------------------------------- */

test("breaking swaps the object for one body per piece", async () => {
  const { engine, step } = await world((e) => {
    const crate = cubeEntity(e, "Crate", [0, 5, 0]);
    crate.addComponent("collider", { shape: "box", size: [2, 2, 2] });
    crate.addComponent("rigidbody", { bodyType: "dynamic", mass: 40 });
    crate.addComponent("destructible", { pieces: 8, seed: 4, trigger: "manual", prefracture: false, debrisLifetime: 0 });
  });
  const crate = [...engine.entities.values()].find((entity) => entity.name === "Crate");
  const destructible = crate.getComponent("destructible");

  assert.equal(destructible.broken, false);
  assert.equal(destructible.break(), true);
  assert.ok(destructible.debris.length >= 5, `expected pieces, got ${destructible.debris.length}`);
  assert.equal(destructible.broken, true);

  // The original is out of the world and off screen, but still an entity.
  assert.ok(engine.entities.has(crate.id), "the source entity survives its own break");
  assert.equal(crate.getComponent("collider").enabled, false);
  assert.equal(engine.physics.bodyByEntity.has(crate), false, "the intact body must leave the world");

  // Every piece is a live dynamic body that falls.
  const heights = destructible.debris.map((piece) => piece.object3D.position.y);
  step(20);
  const fell = destructible.debris.filter((piece, i) => piece.object3D.position.y < heights[i]);
  assert.equal(fell.length, destructible.debris.length, "every piece must be simulated");

  // The pieces weigh what the crate weighed.
  const total = destructible.debris.reduce((sum, piece) => sum + (piece.getComponent("rigidbody").body?.mass() ?? 0), 0);
  assert.ok(Math.abs(total - 40) < 4, `pieces weigh ${total.toFixed(1)} kg, the crate weighed 40`);
});

test("reset puts the object back and breaking twice is refused", async () => {
  const { engine } = await world((e) => {
    const crate = cubeEntity(e, "Crate", [0, 2, 0]);
    crate.addComponent("collider", { shape: "box", size: [2, 2, 2] });
    crate.addComponent("destructible", { pieces: 6, trigger: "manual", prefracture: false, debrisLifetime: 0 });
  });
  const crate = [...engine.entities.values()].find((entity) => entity.name === "Crate");
  const destructible = crate.getComponent("destructible");
  destructible.break();
  assert.equal(destructible.break(), false, "a broken object must not break again");
  const pieceIds = destructible.debris.map((piece) => piece.id);

  assert.equal(destructible.reset(), true);
  assert.equal(destructible.broken, false);
  assert.equal(destructible.debris.length, 0);
  for (const id of pieceIds) assert.equal(engine.entities.has(id), false, "the debris must be gone");
  assert.equal(crate.getComponent("collider").enabled, true, "the original collides again");
  assert.ok(engine.physics.bodyByEntity.has(crate), "the original is back in the world");
});

test("a named event breaks every wall listening for it", async () => {
  const { engine } = await world((e) => {
    for (const name of ["Wall A", "Wall B"]) {
      const wall = cubeEntity(e, name, [name === "Wall A" ? -4 : 4, 1, 0]);
      wall.addComponent("destructible", {
        pieces: 5, trigger: "event", breakEvent: "explode", prefracture: false, debrisLifetime: 0,
      });
    }
  });
  const walls = [...engine.entities.values()].filter((entity) => entity.name.startsWith("Wall"));
  engine.emit("explode");
  for (const wall of walls) {
    assert.equal(wall.getComponent("destructible").broken, true, `${wall.name} should have broken`);
  }
});

test("an impact breaks the wall only above its strength", async () => {
  const { engine, physics, step } = await world((e) => {
    ground(e);

    const wall = cubeEntity(e, "Wall", [0, 0.5, 0], 1);
    wall.addComponent("collider", { shape: "box", size: [1, 1, 1] });
    wall.addComponent("destructible", { pieces: 6, strength: 200, prefracture: false, debrisLifetime: 0 });

    const hammer = cubeEntity(e, "Hammer", [0, 6, 0], 1);
    hammer.addComponent("collider", { shape: "box", size: [1, 1, 1] });
    hammer.addComponent("rigidbody", { bodyType: "dynamic", mass: 400 });
  });
  const wall = [...engine.entities.values()].find((entity) => entity.name === "Wall");
  const destructible = wall.getComponent("destructible");

  // The wall's collider carries Rapier's contact-force flag only because the
  // component asked for it — that opt-in is the whole mechanism.
  assert.equal(physics.contactForceEntities.get(wall), 200);

  step(10);
  assert.equal(destructible.broken, false, "nothing has hit it yet");
  step(120);
  assert.equal(destructible.broken, true, "a 400 kg hammer from 5 m must break a 200 N wall");
});

/* -------------------------------------------------------------------------- */
/* Chain                                                                       */
/* -------------------------------------------------------------------------- */

function chainOfChildren(engine, { links = 5, spacing = 0.5, props = {} } = {}) {
  const root = engine.createEntity({ name: "Chain" });
  root.object3D.position.set(0, 5, 0);
  for (let i = 0; i < links; i++) {
    const link = engine.createEntity({ name: `Link ${i}`, parent: root });
    link.object3D.position.set(0, -spacing * i, 0);
    link.addComponent("collider", { shape: "sphere", radius: 0.15, autoFit: false });
  }
  root.object3D.updateMatrixWorld(true);
  root.addComponent("chain", { source: "children", ...props });
  return root;
}

test("a hanging chain holds together and stays up", async () => {
  const { engine, step } = await world((e) => chainOfChildren(e, { links: 6 }));
  const root = [...engine.entities.values()].find((entity) => entity.name === "Chain");
  const chain = root.getComponent("chain");
  assert.equal(chain.links.length, 6, "every child became a link");

  const top = root.children[0];
  const bottom = root.children[5];
  const startTop = top.object3D.getWorldPosition(new THREE.Vector3());
  step(120);

  const endTop = top.object3D.getWorldPosition(new THREE.Vector3());
  assert.ok(endTop.distanceTo(startTop) < 0.2, `the pinned link drifted ${endTop.distanceTo(startTop).toFixed(2)} m`);
  const endBottom = bottom.object3D.getWorldPosition(new THREE.Vector3());
  assert.ok(endBottom.y < endTop.y, "the free end hangs below the pinned one");
  // Held by joints, not floating: a broken chain's last link keeps falling.
  assert.ok(endTop.y - endBottom.y < 5 * 0.5 + 1, `the chain stretched to ${(endTop.y - endBottom.y).toFixed(2)} m`);
});

test("an unpinned chain falls as one piece", async () => {
  const { engine, step } = await world((e) => chainOfChildren(e, { links: 4, props: { pinFirst: false } }));
  const root = [...engine.entities.values()].find((entity) => entity.name === "Chain");
  const spacingBefore = root.children[0].object3D.position.distanceTo(root.children[3].object3D.position);
  step(60);
  const first = root.children[0].object3D.getWorldPosition(new THREE.Vector3());
  const last = root.children[3].object3D.getWorldPosition(new THREE.Vector3());
  assert.ok(first.y < 4, "with nothing pinned the whole chain falls");
  assert.ok(
    Math.abs(first.distanceTo(last) - spacingBefore) < 0.5,
    "falling freely, the links keep their spacing",
  );
});

test("the chain gives its links bodies, and takes them back", async () => {
  const { engine } = await world((e) => chainOfChildren(e, { links: 3 }));
  const root = [...engine.entities.values()].find((entity) => entity.name === "Chain");
  for (const child of root.children) {
    assert.ok(child.getComponent("rigidbody"), `${child.name} was given a body`);
  }
  engine.setPlaying(false);
  for (const child of root.children) {
    assert.equal(child.getComponent("rigidbody"), undefined, `${child.name} kept a body it never had`);
  }
});

test("an instancer's instances become chain links without becoming entities", async () => {
  const { engine, step } = await world((e) => {
    const entity = e.createEntity({ name: "Rope" });
    entity.object3D.position.set(0, 6, 0);
    entity.addComponent("mesh", { geometry: "sphere" });
    entity.addComponent("instancer", {
      mode: "array",
      count: 8,
      arrayOffsetPosition: [0, -0.4, 0],
    });
    entity.object3D.updateMatrixWorld(true);
    entity.addComponent("chain", { source: "instances", linkMass: 0.5, linkShape: "sphere" });
    return entity;
  });
  const rope = [...engine.entities.values()].find((entity) => entity.name === "Rope");
  const chain = rope.getComponent("chain");
  const instanced = rope.getComponent("instancer").instancedMesh;

  assert.equal(chain.links.length, 8, "one body per instance");
  assert.equal(engine.entities.size, 1, "and not one entity per instance");
  // Every link is registered against the chain's entity, so a raycast that
  // hits one reports the rope rather than nothing.
  for (const link of chain.links) {
    const collider = link.body.collider(0);
    assert.equal(engine.physics.colliderEntity.get(collider.handle), rope);
  }

  const before = new THREE.Matrix4();
  instanced.getMatrixAt(7, before);
  step(60);
  const after = new THREE.Matrix4();
  instanced.getMatrixAt(7, after);
  assert.notDeepEqual([...after.elements], [...before.elements], "the simulated pose must reach the instance matrix");

  const first = new THREE.Vector3().setFromMatrixPosition(instanced.getMatrixAt(0, new THREE.Matrix4()));
  const last = new THREE.Vector3().setFromMatrixPosition(after);
  assert.ok(last.y < first.y, "the rope hangs downward");
  assert.ok(first.distanceTo(last) < 8 * 0.4 + 1.5, "and it has not come apart");
});

/* -------------------------------------------------------------------------- */
/* Ragdoll                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A three-limb rig: root → spine → head, plus an arm off the spine. Built by
 * hand rather than loaded, because the point of the component is that it needs
 * no naming convention — this rig has none.
 */
function skeletonEntity(engine, name = "Actor") {
  const entity = engine.createEntity({ name });
  entity.object3D.position.set(0, 3, 0);
  const armature = new THREE.Object3D();
  armature.userData.entityId = entity.id;

  const hips = new THREE.Bone();
  hips.name = "hips";
  const spine = new THREE.Bone();
  spine.name = "spine";
  spine.position.set(0, 0.6, 0);
  const head = new THREE.Bone();
  head.name = "head";
  head.position.set(0, 0.5, 0);
  const arm = new THREE.Bone();
  arm.name = "arm";
  arm.position.set(0.4, 0.3, 0);
  const hand = new THREE.Bone();
  hand.name = "hand";
  hand.position.set(0.5, 0, 0);

  arm.add(hand);
  spine.add(head, arm);
  hips.add(spine);
  armature.add(hips);
  entity.object3D.add(armature);
  entity.object3D.updateMatrixWorld(true);
  return { entity, bones: { hips, spine, head, arm, hand } };
}

test("a ragdoll builds itself from the skeleton's own shape", async () => {
  let rig;
  const { engine, step } = await world((e) => {
    ground(e);
    rig = skeletonEntity(e);
    rig.entity.addComponent("ragdoll", { mass: 60, minBoneLength: 0.05 });
  });
  const ragdoll = rig.entity.getComponent("ragdoll");
  assert.equal(ragdoll.simulating, false, "it starts animated, not limp");

  assert.ok(ragdoll.activate() >= 3, `expected a body per real bone, got ${ragdoll.getBones().join()}`);
  // hips → spine, spine → head, spine → arm, arm → hand. The leaf bones (head,
  // hand) have no children of their own and so get no body.
  assert.deepEqual(ragdoll.getBones().sort(), ["arm", "hips", "spine"]);

  const masses = ragdoll.parts.map((part) => part.body.mass());
  assert.ok(Math.abs(masses.reduce((a, b) => a + b, 0) - 60) < 1, `the parts weigh ${masses.reduce((a, b) => a + b, 0)}`);

  const before = rig.bones.spine.quaternion.clone();
  step(90);
  assert.notDeepEqual(rig.bones.spine.quaternion.toArray(), before.toArray(), "the simulation must pose the bones");
  assert.ok(rig.entity.object3D.position.y < 3, "and the entity follows the body down");
});

test("a ragdoll suspends the animator and gives it back untouched", async () => {
  let rig;
  const { engine } = await world((e) => {
    rig = skeletonEntity(e);
    rig.entity.addComponent("animation", {});
    rig.entity.addComponent("ragdoll", {});
  });
  const animation = rig.entity.getComponent("animation");
  const ragdoll = rig.entity.getComponent("ragdoll");
  assert.equal(animation.enabled, true);

  ragdoll.activate();
  assert.equal(animation.enabled, false, "the animator must not fight the simulation");
  assert.equal(animation.props.enabled, true, "and its authored value must be untouched");

  ragdoll.deactivate();
  assert.equal(animation.enabled, true, "the animator gets the skeleton back");
  assert.equal(ragdoll.simulating, false);
});

test("an impulse reaches the bone it names", async () => {
  let rig;
  const { engine, step } = await world((e) => {
    rig = skeletonEntity(e);
    rig.entity.addComponent("ragdoll", { mass: 20, followRoot: false });
  });
  const ragdoll = rig.entity.getComponent("ragdoll");
  ragdoll.activate({ impulse: [40, 0, 0], bone: "arm" });
  const arm = ragdoll.parts.find((part) => part.bone.name === "arm");
  assert.ok(arm.body.linvel().x > 1, `the arm should have been kicked, vx = ${arm.body.linvel().x}`);
  step(5);
  assert.equal(ragdoll.applyImpulse([0, 1, 0], "no-such-bone"), false);
});

test("stopping play frees every rig body", async () => {
  let rig;
  const { engine } = await world((e) => {
    rig = skeletonEntity(e);
    rig.entity.addComponent("ragdoll", { active: true });
    chainOfChildren(e, { links: 4 });
  });
  const ragdoll = rig.entity.getComponent("ragdoll");
  assert.ok(ragdoll.simulating, "an authored-active ragdoll starts limp");
  const bodiesWhilePlaying = engine.physics.world.bodies.len();

  engine.setPlaying(false);
  assert.equal(ragdoll.simulating, false);
  assert.equal(engine.physics.world, null, "the world is freed on stop");

  engine.setPlaying(true);
  // Rebuilt, not doubled: a rig that failed to free itself would show up here
  // as twice the bodies.
  assert.equal(engine.physics.world.bodies.len(), bodiesWhilePlaying);
});

test("toggling a destructible off and on subscribes once, not once per toggle", async () => {
  const { engine } = await world((e) => {
    const wall = cubeEntity(e, "Wall", [0, 1, 0]);
    wall.addComponent("destructible", {
      pieces: 4, trigger: "event", breakEvent: "explode", prefracture: false, debrisLifetime: 0,
    });
  });
  const wall = [...engine.entities.values()].find((entity) => entity.name === "Wall");
  const destructible = wall.getComponent("destructible");
  const armed = engine.listenerCount("explode");
  assert.equal(armed, 1);

  for (let i = 0; i < 3; i++) {
    destructible.setProp("enabled", false);
    // A disabled component must hold NO subscription — the handler's own
    // `enabled` check is a second line of defence, not the mechanism.
    assert.equal(engine.listenerCount("explode"), 0, "a disabled destructible stays subscribed");
    destructible.setProp("enabled", true);
    assert.equal(engine.listenerCount("explode"), armed, `${i + 1} toggles left ${engine.listenerCount("explode")} listeners`);
  }

  engine.emit("explode");
  assert.equal(destructible.broken, true, "and it still breaks after the round trip");
});

test("changing the mesh throws the baked pieces away", async () => {
  const { engine } = await world((e) => {
    const crate = e.createEntity({ name: "Crate" });
    crate.addComponent("mesh", { geometry: "box" });
    crate.addComponent("destructible", { pieces: 6, trigger: "manual", debrisLifetime: 0 });
  });
  const crate = [...engine.entities.values()].find((entity) => entity.name === "Crate");
  const destructible = crate.getComponent("destructible");
  await destructible.prefracture();
  assert.equal(destructible.isBaked(), true);

  // The cache is keyed by entity + settings, neither of which mentions the
  // geometry — without the invalidation the sphere would break into the box's
  // pieces.
  crate.getComponent("mesh").setProp("geometry", "sphere");
  assert.equal(destructible.isBaked(), false, "a new mesh must invalidate the bake");
});

test("a wall broken during play comes back whole when play stops", async () => {
  const { engine } = await world((e) => {
    const wall = cubeEntity(e, "Wall", [0, 1, 0]);
    wall.addComponent("mesh", { geometry: "box" });
    wall.addComponent("collider", { shape: "box", size: [2, 2, 2] });
    wall.addComponent("destructible", { pieces: 5, trigger: "manual", prefracture: false, debrisLifetime: 0 });
  });
  const wall = [...engine.entities.values()].find((entity) => entity.name === "Wall");
  wall.getComponent("destructible").break();
  assert.equal(wall.getComponent("mesh").enabled, false, "the intact wall is hidden while broken");

  engine.setPlaying(false);
  // Hiding uses setEnabledOverride, which is transient and NOT part of the
  // props snapshot Stop restores — so if the component does not undo it
  // itself, the wall stays invisible in the editor forever.
  assert.equal(wall.getComponent("mesh").enabled, true, "the wall must be visible again after Stop");
  assert.equal(wall.getComponent("collider").enabled, true);
  const rubble = [...engine.entities.values()].filter((entity) => entity.name.includes("Piece"));
  assert.equal(rubble.length, 0, "and the debris must not survive the session that made it");
});
