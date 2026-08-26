/**
 * Automatic shadow-map freezing (src/engine/shadowFreeze.js).
 *
 *   node scripts/run-shadow-freeze-test.mjs
 *
 * The optimisation's whole risk is a STALE SHADOW — a map frozen on a pose the
 * scene has since left — so most of these check that it gives up, not that it
 * freezes. A frozen map that should have redrawn looks like a lighting bug and
 * is far more expensive to diagnose than the draw calls it saved.
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
globalThis.window ??= {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const THREE = await import("three/webgpu");
const { Engine, registerBuiltInComponents } = await import("../src/engine/index.js");
const { PHASE } = await import("../src/engine/StatsSystem.js");

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

/** A scene with one shadow-casting sun and `count` casting boxes. */
function makeScene({ count = 3 } = {}) {
  const engine = new Engine();
  const light = new THREE.DirectionalLight(0xffffff, 1);
  light.castShadow = true;
  engine.scene.add(light);
  const meshes = [];
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial(),
    );
    mesh.castShadow = true;
    mesh.position.set(i * 2, 0, 0);
    engine.scene.add(mesh);
    meshes.push(mesh);
  }
  engine.scene.updateMatrixWorld(true);
  primeRenderer(engine);
  return { engine, light, meshes };
}

/**
 * Give a fixture engine a renderer with a render counter.
 *
 * ⚠ MUST BE CALLED AT CONSTRUCTION, not lazily on the first render. The freeze
 * watches `engine.renderer` BY IDENTITY and treats a change as a device loss, so
 * materialising the stub on the first draw reads as "the renderer was rebuilt"
 * and releases every light — which is a real behaviour of the system, correctly
 * defended by its own check, and it silently broke fifteen unrelated fixtures
 * when this helper created the object on demand.
 */
function primeRenderer(engine) {
  engine.renderer ??= {};
  engine.renderer.info ??= { render: { calls: 0 } };
  return engine;
}

function noteRender(engine) {
  primeRenderer(engine).renderer.info.render.calls++;
}

/**
 * One frame of the freeze system, with matrices resolved first as #tick does.
 *
 * ⚠ `drew` IS PART OF WHAT A FRAME IS. The freeze may only take a light over
 * once three has actually rendered its map, and it proves that by watching
 * `renderer.info.render.calls` advance. A fixture that never advances it is
 * modelling an engine whose renderer never runs — which is exactly the state
 * (a suspended GI compile wave) that broke this in the field, so it has to be
 * expressible here rather than assumed away.
 */
function step(engine, { drew = true } = {}) {
  engine.scene.updateMatrixWorld(true);
  engine.shadowFreeze.update();
  // ⚠ AFTER the freeze, because that is the tick's order: `Engine#tick` decides
  // the freeze and THEN calls `renderer.render`. So the count the freeze reads
  // is always "renders completed before this frame", which is exactly the
  // question it needs answered.
  if (drew) noteRender(engine);
}

// ---- the freeze itself ------------------------------------------------------

check("a still scene renders its shadow map once, then freezes", () => {
  const { engine, light } = makeScene();
  step(engine);
  assert.equal(
    light.shadow.autoUpdate, true,
    "a FIRST sight must change nothing — three has not built the shadow map yet",
  );
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "an unchanged scene must stop re-rendering");
});

check("⭐⭐ a tick that never RENDERED must not count toward the freeze", () => {
  // THE LIVE BUG (user, 2026-08-25): "shadows are broken after each reload,
  // have to change bias to fix them, though I think it is just a shadow map
  // update that fixes it" — and the user's own diagnosis was right.
  //
  // `Engine#tick` called `shadowFreeze.update()` ABOVE its `renderSuspended`
  // early return, so while a GI compile wave held rendering off, the freeze
  // still got a tick per frame. Two of those in a row on a settled scene is the
  // "same key twice" rule satisfied without three ever having rendered the map,
  // and `autoUpdate` goes false on an EMPTY texture. Three's gate is
  // `needsUpdate || autoUpdate`, so nothing ever renders it again — until an
  // edit like the shadow bias sets `needsUpdate` by hand, which is exactly the
  // workaround that was being used.
  //
  // ⚠ THE ASSERTION IS NOT "it does not freeze". It is that the freeze still
  // WORKS afterwards: a system that merely refused would trade a broken shadow
  // for a permanently unfrozen one, which is the 842-draw regression again.
  const { engine, light } = makeScene();
  for (let i = 0; i < 5; i++) step(engine, { drew: false });
  assert.equal(
    light.shadow.autoUpdate, true,
    "five suspended ticks are not five frames — the map has never been rendered",
  );
  step(engine); // the wave ends; this tick draws for the first time
  assert.equal(light.shadow.autoUpdate, true, "the freeze needs a render BEHIND it, not ahead");
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "and once one has happened, it must still freeze");
});

check("⭐ a deforming caster is answered from a CACHE, not a walk per frame", () => {
  // `shadowFreeze` cost 1.147 ms of a 35.6 ms Bistro frame while reporting
  // `frozen: 0` — a full traversal of 1600 meshes, every frame, to re-derive
  // that one skinned character had disabled the whole system. Being skinned is
  // structural, so `hierarchy-changed` is a complete invalidation signal.
  const { engine, light } = makeScene();
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen on a static scene");

  const skinned = new THREE.SkinnedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  );
  skinned.castShadow = true;
  engine.scene.add(skinned);
  engine.emit("hierarchy-changed");
  engine.flushHierarchyChanged();
  step(engine);
  assert.equal(light.shadow.autoUpdate, true, "a deforming caster must hand every light back");
  assert.match(
    engine.shadowFreeze.reason,
    /skinned|morph/i,
    `the receipt must name the cause, got: ${engine.shadowFreeze.reason}`,
  );

  // And it must RECOVER — a cache that never clears would leave the freeze off
  // for the rest of the session once any character had ever existed.
  engine.scene.remove(skinned);
  engine.emit("hierarchy-changed");
  engine.flushHierarchyChanged();
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "removing it must let the freeze engage again");
});

check("a caster that MOVES redraws the map", () => {
  const { engine, light, meshes } = makeScene();
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen");
  meshes[1].position.x += 3;
  step(engine);
  assert.equal(
    light.shadow.autoUpdate, true,
    "THE STALE-SHADOW BUG: a caster moved and the map was left frozen",
  );
});

check("a caster that is HIDDEN redraws the map", () => {
  const { engine, light, meshes } = makeScene();
  step(engine);
  step(engine);
  meshes[0].visible = false;
  step(engine);
  assert.equal(
    light.shadow.autoUpdate, true,
    "a hidden caster must drop out of the map, not linger as a shadow of nothing",
  );
});

check("a NEW caster redraws the map", () => {
  const { engine, light } = makeScene();
  step(engine);
  step(engine);
  const extra = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  extra.castShadow = true;
  extra.position.set(9, 0, 0);
  engine.scene.add(extra);
  step(engine);
  assert.equal(light.shadow.autoUpdate, true, "an added caster must appear in the map");
});

check("moving a RECEIVER does not redraw — the map did not change", () => {
  // The saving depends on this: a scene full of moving non-casters (particles,
  // UI, the player's own receive-only decor) must not defeat the freeze. What a
  // shadow lands on is resolved per pixel at lookup time.
  const { engine, light } = makeScene();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  receiver.castShadow = false;
  receiver.receiveShadow = true;
  engine.scene.add(receiver);
  step(engine);
  step(engine);
  receiver.position.x += 5;
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "a receiver moving cannot change the shadow map");
});

// ---- when it must give up ---------------------------------------------------

check("a SKINNED mesh anywhere disables freezing entirely", () => {
  // ⚠ Skinning deforms in the VERTEX SHADER: the silhouette changes while every
  // property this walk can read stays identical. A transform fingerprint is
  // blind to it, and the artifact is a character's shadow frozen mid-stride.
  const { engine, light } = makeScene();
  const skinned = new THREE.SkinnedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  );
  skinned.castShadow = true;
  engine.scene.add(skinned);
  step(engine);
  step(engine);
  assert.equal(
    light.shadow.autoUpdate, true,
    "THE REGRESSION: a deforming mesh was frozen on one pose",
  );
});

check("morph targets disable freezing entirely", () => {
  const { engine, light } = makeScene();
  const morphed = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  morphed.castShadow = true;
  morphed.morphTargetInfluences = [0.5];
  engine.scene.add(morphed);
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, true, "morph targets deform without moving");
});

check("an InstancedMesh re-uploading its matrices redraws the map", () => {
  // Per-instance transforms live in a buffer the walk cannot see, but three
  // bumps `instanceMatrix.version` on every upload. Bailing on instanced meshes
  // outright would switch the whole optimisation off on any batched scene.
  const { engine, light } = makeScene();
  const instanced = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
    4,
  );
  instanced.castShadow = true;
  engine.scene.add(instanced);
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "a batched scene must still be freezable");
  instanced.instanceMatrix.version++;
  step(engine);
  assert.equal(light.shadow.autoUpdate, true, "an instance transform upload must redraw");
});

// ---- it must never write needsUpdate ----------------------------------------

check("the system writes autoUpdate ONLY — never needsUpdate", () => {
  // ⚠ THE CRASH THIS GUARDS, hit live: `Uncaught TypeError: Cannot read
  // properties of null (reading 'depthTexture')` thrown out of
  // `renderer.render` and killing the tick.
  //
  //   // three/src/nodes/lighting/ShadowNode.js, updateBefore()
  //   let needsUpdate = shadow.needsUpdate || shadow.autoUpdate;
  //   if ( needsUpdate ) {
  //     this.updateShadow( frame );
  //     if ( this.shadowMap.depthTexture.version === ... )   // UNGUARDED
  //
  // Forcing `needsUpdate` drives that branch on a light whose ShadowNode has
  // not built its map yet, and `shadowMap` is still null. Restoring
  // `autoUpdate` asks for the identical render through the path three already
  // owns, with its own initialisation guarantees — so this system has no
  // business touching `needsUpdate` at all, in either direction.
  const { engine, light, meshes } = makeScene();
  let writes = 0;
  let raw = light.shadow.needsUpdate;
  Object.defineProperty(light.shadow, "needsUpdate", {
    configurable: true,
    get: () => raw,
    set: (v) => { writes++; raw = v; },
  });
  step(engine);            // first sight
  step(engine);            // freeze
  meshes[0].position.x += 4;
  step(engine);            // invalidate
  step(engine);            // re-freeze
  engine.shadowFreeze.dispose();  // release
  assert.equal(
    writes, 0,
    `THE CRASH: shadowFreeze wrote shadow.needsUpdate ${writes} time(s) — that can throw inside three's ShadowNode before the shadow map exists`,
  );
});

check("no GI transition leaves a frozen light with needsUpdate set", () => {
  // ⚠⚠ THE `depthTexture` CRASH, REPORTED LIVE TWICE (2026-08-17):
  //
  //   Uncaught TypeError: Cannot read properties of null (reading 'depthTexture')
  //     at ShadowNode.updateShadow ... at WebGPURenderer.render ... at #tick
  //
  // three's `ShadowNode.dispose()` nulls `shadowMap`; its `updateBefore` gates on
  // `shadow.needsUpdate || shadow.autoUpdate` and then dereferences
  // `this.shadowMap.depthTexture` UNGUARDED. So the fatal state is a light that
  // is FROZEN (autoUpdate false, so three does not rebuild through `setup()`
  // first) and carries a sticky `needsUpdate = true` across a `light.dispose()`.
  //
  // GISystem's two shadow-node transition sites used to set exactly that pair.
  // This asserts the invariant from the shadowFreeze side, where it is cheap and
  // GPU-free: whatever else happens, a light this system has frozen must never be
  // left with `needsUpdate` true. It is a grep-proof for the real rule — a GI
  // transition writes `autoUpdate`, which three honours through its own
  // initialisation path.
  const { engine, light } = makeScene();
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen");
  assert.equal(
    light.shadow.needsUpdate, false,
    "a frozen light carrying needsUpdate is the exact state that crashes three's ShadowNode",
  );
  // And the documented safe recovery: autoUpdate alone must un-freeze it.
  light.shadow.autoUpdate = true;
  step(engine);
  assert.equal(
    light.shadow.needsUpdate, false,
    "restoring autoUpdate must not require needsUpdate — that is the whole point",
  );
});

// ---- it must not override the author ---------------------------------------

check("a project that froze shadows itself is left alone", () => {
  // `settings.shadow.autoUpdate === false` is an explicit authored choice, and
  // this system re-enabling it would be overriding a setting rather than
  // implementing one.
  const { engine, light } = makeScene();
  engine.settings.shadow = { ...(engine.settings.shadow ?? {}), autoUpdate: false };
  step(engine);
  assert.equal(
    engine.shadowFreeze.frozenLights, 0,
    "the system must take no lights when the project already froze them",
  );
});

check("the freeze phase runs AFTER preRender — the shadow camera is not final before it", () => {
  // ⚠ THE ORDERING BUG THIS GUARDS, caught on the live scene by a screenshot.
  // `LightComponent` recentres a directional light's shadow camera from an
  // `onPreRender` callback, so a fingerprint taken before that phase reads LAST
  // frame's shadow camera. The map then froze against a stale camera while the
  // real one kept moving underneath it — the matrix the shadow lookups use went
  // on changing after the map stopped being redrawn, which renders as hard
  // stair-stepped shadow edges in the wrong place.
  //
  // The phase table is the only place this ordering is written down, so assert
  // on it directly: a reorder is silent otherwise, and the symptom looks like a
  // GI bug rather than a scheduling one.
  assert.ok(
    PHASE.shadowFreeze > PHASE.preRender,
    "shadowFreeze must be ordered after preRender in the PHASES table",
  );
  assert.ok(
    PHASE.shadowFreeze > PHASE.merging && PHASE.shadowFreeze > PHASE.batching,
    "and after the systems that move casters",
  );
  assert.ok(
    PHASE.shadowFreeze < PHASE.renderEncode,
    "but before the render that would draw the map",
  );
});

check("moving the shadow camera redraws the map", () => {
  const { engine, light } = makeScene();
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen");
  // What LightComponent's recentring does every frame the view camera moves.
  light.shadow.camera.position.set(12, 20, 12);
  light.shadow.camera.updateMatrixWorld(true);
  step(engine);
  assert.equal(
    light.shadow.autoUpdate, true,
    "a moved shadow camera changes what the map must contain",
  );
});

// ---- the feedback loop ------------------------------------------------------

check("ROTATING the light redraws the map", () => {
  // ⚠⚠ THE PERMANENT-FREEZE BUG (2026-08-17, user: "shadow map from dir light
  // does not update when I rotate the light, though auto update is on").
  //
  // The key used to be built from `shadow.camera.matrixWorldInverse`, which
  // three only recomputes inside `updateShadow()` — gated on
  // `needsUpdate || autoUpdate`, the flag THIS SYSTEM WRITES. So a frozen
  // light's shadow camera stops moving, the key can never change again, and
  // nothing short of a caster moving ever unfreezes it. Rotating the sun
  // produced no key change at all and the map stayed on the old pose forever.
  //
  // This rig deliberately does NOT touch the shadow camera: it rotates the
  // light exactly the way the gizmo does and asserts on the outcome. The
  // shadow camera is left frozen ON PURPOSE, because that is the real
  // post-freeze state — three is not calling `updateMatrices` for it.
  const { engine, light } = makeScene();
  const target = new THREE.Object3D();
  engine.scene.add(target);
  light.target = target;
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen");
  light.rotation.y += 0.4;
  light.position.set(3, 10, 3);
  step(engine);
  assert.equal(
    light.shadow.autoUpdate, true,
    "THE PERMANENT FREEZE: the light moved and the map was left on the old pose",
  );
});

check("RE-AIMING the light via its target redraws the map", () => {
  // A directional light's direction is position -> target, and
  // `LightComponent#syncDirectionalTransform` re-aims it by writing the
  // TARGET's position, leaving `light.position` on the camera-recentred spot.
  // A key that watched only the light itself would miss the whole rotation.
  const { engine, light } = makeScene();
  const target = new THREE.Object3D();
  engine.scene.add(target);
  light.target = target;
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen");
  target.position.set(-6, -2, 4);
  step(engine);
  assert.equal(
    light.shadow.autoUpdate, true,
    "re-aiming through the target must redraw — that is how the sun is rotated",
  );
});

check("changing the shadow map RESOLUTION redraws the map", () => {
  const { engine, light } = makeScene();
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen");
  light.shadow.mapSize.width = 4096;
  step(engine);
  assert.equal(light.shadow.autoUpdate, true, "a resized map has no valid contents to keep");
});

check("a GI-traced light is not touched — its map is a stub that never renders", () => {
  const { engine, light } = makeScene();
  light.userData.giShadowMode = "gi";
  light.shadow.autoUpdate = false;
  light.shadow.needsUpdate = false;
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "a gi-mode light must be left exactly as found");
  assert.equal(
    light.shadow.needsUpdate, false,
    "raising needsUpdate on a gi-mode light would make its stub map render",
  );
});

// ---- shadowCamSnap: does the prop actually hold the map? --------------------
//
// `shadowCamSnap` exists ONLY so that ShadowFreeze can stay engaged while the
// view camera moves, so a snap that fails to hold the freeze is a silent
// no-op — and it was one. The lateral snap was applied to the two axes the
// shadow map rasterizes across, and the component along the LIGHT DIRECTION was
// left continuous, so `light.position` moved on every frame the camera
// translated at all and the fingerprint changed every frame no matter how large
// the snap. Measured on the real project before the fix: raising the snap 0.5 →
// 8 moved a camera drag from 23.1 to 23.7 fps (noise) with the shadow pass still
// submitting 559 draws; with the depth axis snapped too, the same drag runs at
// 33.7 fps and the pass disappears. `run-gi-camera-motion.mjs` is that harness.

/** A LightComponent sun plus a camera, stepped the way Engine.#tick does. */
function makeComponentScene({ snap = 8 } = {}) {
  const engine = new Engine();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  engine.camera = camera;
  const entity = engine.createEntity("Sun");
  const light = entity.addComponent("light", {
    kind: "directional", castShadow: true, shadowCamSnap: snap, shadowCamSize: 60,
  });
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  box.castShadow = true;
  engine.scene.add(box);
  // ⚠ The sync runs from an `onPreRender` callback and the freeze runs AFTER
  // it (see the phase-order note in Engine.#tick), so a step that skipped the
  // callbacks would fingerprint LAST frame's light pose and pass for the wrong
  // reason.
  const stepFrame = () => {
    engine.scene.updateMatrixWorld(true);
    for (const fn of engine.preRenderCallbacks) fn();
    engine.scene.updateMatrixWorld(true);
    engine.shadowFreeze.update();
    noteRender(engine);
  };
  primeRenderer(engine);
  return { engine, camera, light: light.light, stepFrame };
}

check("shadowCamSnap holds the freeze when the camera moves INSIDE a snap cell", () => {
  const { camera, light, stepFrame } = makeComponentScene({ snap: 8 });
  stepFrame();
  stepFrame();
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen with the camera parked");
  // 1 m in every axis at once — comfortably inside an 8 m cell on all three,
  // including the one along the light direction that used to be unsnapped.
  camera.position.set(1, 1, 1);
  stepFrame();
  assert.equal(
    light.shadow.autoUpdate, false,
    "THE BUG: moving inside the snap cell re-posed the light and redrew the whole shadow map",
  );
});

check("shadowCamSnap still redraws once the camera LEAVES the snap cell", () => {
  // The other half, and the one that keeps the fix honest: a snap that never
  // gives up is just a permanently stale shadow.
  const { camera, light, stepFrame } = makeComponentScene({ snap: 8 });
  stepFrame();
  stepFrame();
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen");
  camera.position.set(40, 40, 40);
  stepFrame();
  assert.equal(
    light.shadow.autoUpdate, true,
    "the camera left the covered region and the map must follow it",
  );
});

check("the depth axis is snapped, not merely ignored", () => {
  // Ignoring the along-direction component entirely would also hold the freeze,
  // and would silently pin the ortho near/far slab at the world origin —-a
  // camera far along the light direction would then clip its own casters. The
  // light must still TRACK the camera in depth, just in steps.
  const { camera, light, stepFrame } = makeComponentScene({ snap: 8 });
  stepFrame();
  const near = light.position.clone();
  camera.position.set(0, 0, 200);
  stepFrame();
  assert.ok(
    light.position.distanceTo(near) > 8,
    "a 200 m move must still re-pose the light; it tracks in steps, it does not stop tracking",
  );
});

// ---- resource lifetime: the maps can vanish without the scene changing -------

check("⭐ a NEW DEVICE un-freezes every light — its maps are gone", () => {
  const { engine, light } = makeScene();
  engine.renderer = { backend: { device: { id: "A" } } };
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen");
  // A device loss + restore. The SCENE is byte-for-byte identical, so the
  // content fingerprint cannot possibly notice — but every shadow map is now
  // an empty texture on a fresh device.
  engine.renderer = { backend: { device: { id: "B" } } };
  step(engine);
  assert.equal(
    light.shadow.autoUpdate, true,
    "THE PERMANENTLY-BLANK-SHADOW BUG: the map is empty and frozen, and nothing " +
    "in the scene can ever invalidate it — the whole scene loses its shadows for good",
  );
});

check("a new RENDERER un-freezes every light", () => {
  const { engine, light } = makeScene();
  engine.renderer = { backend: { device: { id: "A" } } };
  step(engine);
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "precondition: frozen");
  engine.renderer = { backend: { device: { id: "A" } } }; // rebuilt wrapper
  step(engine);
  assert.equal(light.shadow.autoUpdate, true, "a renderer rebuild re-mints the maps too");
});

check("after a device change the light needs TWO sightings to re-freeze", () => {
  // Not merely unfrozen — a FIRST sighting again. Otherwise the very next
  // update matches the pre-loss key and re-freezes the empty map one frame on.
  const { engine, light } = makeScene();
  engine.renderer = { backend: { device: { id: "A" } } };
  step(engine);
  step(engine);
  engine.renderer = { backend: { device: { id: "B" } } };
  step(engine);
  assert.equal(light.shadow.autoUpdate, true, "sighting 1 after the loss: rendering");
  step(engine);
  assert.equal(light.shadow.autoUpdate, true, "sighting 2 re-records the key, still rendering");
  step(engine);
  assert.equal(light.shadow.autoUpdate, false, "and only then may it freeze again");
});

// ---- CSM: the case that made the whole system inert -------------------------
//
// These use the REAL `CSMShadowNode`, not a stand-in, because the bug was
// entirely about three's actual object shapes: a hand-rolled mock would have
// been built from the same wrong assumption the code was.
//
// What shipped broken: `update()` filtered casters with `object.isLight`, and a
// CSM cascade is `class LwLight extends Object3D` — no `isLight` — while the
// only real Light in the scene is the CSM parent, whose `autoUpdate` three
// never reads because `shadow.shadowNode` is set. So every map in the frame was
// either invisible to the freeze or immune to it, and the system reported
// itself as working. Measured on Bistro: 842 of 1144 draws re-rendered every
// frame on a parked camera.

const { CSMShadowNode } = await import("three/addons/csm/CSMShadowNode.js");

/** A scene whose sun uses CSM, wired the way LightComponent#syncCSM wires it. */
function makeCSMScene({ cascades = 2, count = 3 } = {}) {
  const { engine, light, meshes } = makeScene({ count });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  engine.scene.add(camera);
  const csm = new CSMShadowNode(light, { cascades, maxFar: 150 });
  csm._init({
    camera,
    renderer: {
      coordinateSystem: THREE.WebGPUCoordinateSystem,
      reversedDepthBuffer: false,
    },
  });
  // The one line that makes three skip its own ShadowNode for this light.
  light.shadow.shadowNode = csm;
  // One engine frame: the freeze decides BEFORE the render, and the render is
  // what re-poses the cascades (`CSMShadowNode.updateBefore`). Keeping that
  // order is the point — reversing it would test a system that cannot exist.
  const frame = () => {
    engine.scene.updateMatrixWorld(true);
    engine.shadowFreeze.update();
    noteRender(engine);
    csm.updateBefore();
    engine.scene.updateMatrixWorld(true);
  };
  return { engine, light, meshes, csm, camera, frame };
}

check("a CSM cascade is an Object3D, not a Light — three's shape, pinned", () => {
  const { csm } = makeCSMScene();
  const cascade = csm.lights[0];
  assert.equal(
    cascade.isLight, undefined,
    "if three ever makes LwLight a real Light this test should be revisited, " +
    "not deleted — the freeze must keep finding cascades either way",
  );
  assert.equal(cascade.castShadow, true, "a cascade owns a real map");
  assert.ok(cascade.shadow?.camera, "and therefore a shadow camera");
  assert.equal(
    !!cascade.shadow.shadowNode, false,
    "a cascade's map IS rendered by a plain ShadowNode, so autoUpdate is real there",
  );
});

check("CSM cascades freeze on a still scene — the 842-draw regression", () => {
  const { csm, frame } = makeCSMScene();
  frame();
  frame();
  frame();
  const frozen = csm.lights.filter((c) => c.shadow.autoUpdate === false).length;
  assert.equal(
    frozen, csm.lights.length,
    `THE REGRESSION: ${csm.lights.length - frozen} of ${csm.lights.length} cascades ` +
    "still re-render every frame on a scene that has not moved",
  );
});

check("a caster that moves redraws EVERY cascade", () => {
  const { csm, meshes, frame } = makeCSMScene();
  frame();
  frame();
  frame();
  assert.ok(
    csm.lights.every((c) => c.shadow.autoUpdate === false),
    "precondition: all cascades frozen",
  );
  meshes[1].position.x += 5;
  frame();
  assert.ok(
    csm.lights.every((c) => c.shadow.autoUpdate === true),
    "THE STALE-SHADOW BUG, per cascade: a caster moved and a map stayed frozen",
  );
});

check("the CSM parent light is never managed — its autoUpdate is inert", () => {
  const { engine, light, frame } = makeCSMScene();
  frame();
  frame();
  frame();
  assert.equal(
    light.shadow.autoUpdate, true,
    "three skips ShadowNode for a light with a custom shadowNode, so freezing " +
    "this light saves NOTHING and only produces a false receipt",
  );
  assert.equal(
    engine.shadowFreeze.managedLights, 2,
    "the two cascades are the freezable casters; the parent is not one of them",
  );
});

check("moving the view camera redraws the cascades it re-poses", () => {
  const { csm, camera, frame } = makeCSMScene();
  frame();
  frame();
  frame();
  assert.ok(
    csm.lights.every((c) => c.shadow.autoUpdate === false),
    "precondition: all cascades frozen",
  );
  // Cascades track the view camera, so this genuinely changes what each map
  // must contain — and the cascade centre is texel-snapped upstream, so the
  // move has to be big enough to cross a texel. That snapping is what lets the
  // freeze survive ordinary sub-texel drift.
  camera.position.set(120, 60, 120);
  frame();
  frame();
  assert.ok(
    csm.lights.some((c) => c.shadow.autoUpdate === true),
    "the cascades moved with the camera and their maps must follow",
  );
});

check("a skinned mesh still disables CSM freezing entirely", () => {
  const { engine, csm, frame } = makeCSMScene();
  frame();
  frame();
  frame();
  const skinned = new THREE.SkinnedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial(),
  );
  skinned.castShadow = true;
  engine.scene.add(skinned);
  frame();
  assert.ok(
    csm.lights.every((c) => c.shadow.autoUpdate === true),
    "deforming geometry is invisible to a transform fingerprint — the " +
    "conservative bail must cover cascades too",
  );
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
