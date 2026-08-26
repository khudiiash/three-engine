/**
 * Depth-only shadow merging (src/engine/shadowMerge.js).
 *
 *   node scripts/run-shadow-merge-test.mjs
 *
 * This system rewrites `castShadow` across the scene, so its failure mode is
 * MISSING SHADOWS, not a slow frame — the more expensive bug to diagnose. Most
 * of these checks are therefore about what it must NOT absorb and about the
 * routing that decides which camera sees a proxy, not about the draw saving.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
const { SHADOW_PROXY_LAYER, GI_DEPTH_LAYER, EDITOR_LAYER } = await import("../src/engine/editorLayers.js");

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

function makeMesh(x, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material ?? new THREE.MeshStandardMaterial());
  mesh.castShadow = true;
  mesh.position.set(x, 0, 0);
  return mesh;
}

/** A scene of `count` shadow-casting boxes, with the system enabled. */
function makeScene({ count = 4, material } = {}) {
  const engine = new Engine();
  const meshes = [];
  for (let i = 0; i < count; i++) {
    const mesh = makeMesh(i * 2, typeof material === "function" ? material(i) : material);
    engine.scene.add(mesh);
    meshes.push(mesh);
  }
  engine.scene.updateMatrixWorld(true);
  engine.shadowMerge.setEnabled(true);
  return { engine, meshes };
}

/** One tick of the system, matching Engine#tick's ordering. */
function step(engine) {
  engine.scene.updateMatrixWorld(true);
  engine.shadowMerge.invalidate("test");
  // ⚠ -Infinity, NOT 0. Node's `performance.now()` counts from PROCESS START,
  // so `now - 0` is a few hundred ms early in a run — under SETTLE_MS, which
  // means "0" does not skip the debounce, it arms it. The result is a suite
  // that passes or fails on how long the tests before it happened to take:
  // the first build always runs (groups.length is 0, which bypasses the
  // guard) and every REBUILD is silently skipped instead.
  engine.shadowMerge._dirtiedAt = -Infinity; // skip the settle debounce
  engine.shadowMerge._dirtySince = -Infinity;
  engine.shadowMerge.sync();
}

const proxiesOf = (engine) => {
  const found = [];
  engine.scene.traverse((o) => {
    if (o.userData?.shadowProxy) found.push(o);
  });
  return found;
};

// ---- the merge itself -------------------------------------------------------

check("casters sharing a depth key collapse into one proxy", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  const proxies = proxiesOf(engine);
  assert.equal(proxies.length, 1, `expected one proxy, got ${proxies.length}`);
  for (const mesh of meshes) {
    assert.equal(mesh.castShadow, false, "an absorbed original must drop out of the depth pass");
  }
});

check("⭐ materials differing ONLY in colour still merge — the entire point", () => {
  // The colour merge refuses these (different material instances, and in the
  // real scene "142 custom colorNode"); a depth pass reads none of it.
  const { engine } = makeScene({
    count: 4,
    material: (i) => new THREE.MeshStandardMaterial({ color: i * 0x203040 }),
  });
  step(engine);
  assert.equal(
    proxiesOf(engine).length, 1,
    "four distinct materials that a depth pass cannot tell apart must be ONE proxy",
  );
});

check("materials differing in alphaTest do NOT merge together", () => {
  const { engine } = makeScene({
    count: 4,
    material: (i) => Object.assign(new THREE.MeshStandardMaterial(), { alphaTest: i < 2 ? 0 : 0.5 }),
  });
  step(engine);
  assert.equal(
    proxiesOf(engine).length, 2,
    "alphaTest IS copied onto the depth override, so it must split the key",
  );
});

check("the merged buffer carries position + normal, and uv only when sampled", () => {
  const { engine } = makeScene({ count: 4 });
  step(engine);
  const geometry = proxiesOf(engine)[0].geometry;
  assert.ok(geometry.attributes.position, "position is mandatory");
  // §18 G1: no depth override reads normal, but GI's g-buffer prepass draws
  // this same proxy set and writes world normals. See GI_DEPTH_LAYER.
  assert.ok(geometry.attributes.normal, "the g-buffer prepass shades from these");
  assert.equal(geometry.attributes.uv, undefined, "nothing here samples uv");
});

// ⛔⛔ THE CHECK THAT USED TO LIVE HERE ASSERTED `proxy.static === true`, AND IT
// WAS GUARDING A BUG.
//
// Its reasoning read well: a proxy is drawn only through `scene.overrideMaterial`
// so `hasNode` is false, `static` is finally reachable, and it saves ~35 µs of
// per-object node/binding work per draw "and nothing about the image would
// change". The last clause is the false one — see the replacement check below.
// A test can pin a defect just as firmly as it pins a feature, and this one made
// the fix look like the regression. Deleted rather than inverted in place so the
// reasoning that was wrong stays readable next to the reasoning that replaced it.

check("⭐ a proxy is g-buffer eligible ONLY when the merge really kept normals", () => {
  // `mergeGeometries` drops an attribute unless EVERY member has it, so the
  // eligibility bit must be read off the BUILT geometry. A member without
  // normals must not be able to produce a proxy the g-buffer shades from
  // nothing — it splits the key instead.
  const { engine } = makeScene({ count: 4 });
  step(engine);
  for (const proxy of proxiesOf(engine)) {
    const eligible = proxy.layers.isEnabled(GI_DEPTH_LAYER);
    assert.equal(
      eligible, !!proxy.geometry.attributes.normal,
      "GI_DEPTH_LAYER must agree with the geometry, not with the request",
    );
    assert.equal(
      proxy.layers.isEnabled(SHADOW_PROXY_LAYER), true,
      "the bit is ADDITIVE — shadow routing is unchanged",
    );
  }
});

check("a normal-less member cannot contaminate a proxy the g-buffer draws", () => {
  const { engine } = makeScene({ count: 6 });
  // TWO of them, so the normal-less bucket clears MIN_GROUP_SIZE and really
  // builds a proxy. Stripping one would leave a bucket of one, which is dropped
  // before it can be merged — and the test would pass without proving anything.
  const stripped = [];
  engine.scene.traverse((o) => {
    if (o.isMesh && o.geometry?.attributes?.normal && stripped.length < 2) {
      o.geometry.deleteAttribute("normal");
      stripped.push(o);
    }
  });
  assert.equal(stripped.length, 2, "the fixture must have given us something to strip");
  engine.shadowMerge.invalidate("test");
  step(engine);
  const bare = proxiesOf(engine).filter((p) => !p.geometry.attributes.normal);
  assert.ok(bare.length > 0, "the normal-less members must still have produced a proxy");
  for (const proxy of bare) {
    assert.equal(
      proxy.layers.isEnabled(GI_DEPTH_LAYER), false,
      "a proxy without normals must never be advertised to the g-buffer",
    );
  }
});

// ---- routing: which camera sees a proxy -------------------------------------

check("⭐ a proxy sits on SHADOW_PROXY_LAYER ALONE — never layer 0", () => {
  const { engine } = makeScene({ count: 4 });
  step(engine);
  const proxy = proxiesOf(engine)[0];
  // The invariant is LAYER 0 IS OFF, not "no other bit is on": §18 G1 adds
  // GI_DEPTH_LAYER to eligible proxies. Layer 0 is the one that would put the
  // proxy in the COLOUR pass, drawing its geometry a second time over the
  // originals it stands in for.
  assert.equal(
    (proxy.layers.mask >>> 0) & 1, 0,
    "enabling instead of setting would leave layer 0 on and draw the proxy in the COLOUR pass",
  );
  const allowed = ((1 << SHADOW_PROXY_LAYER) | (1 << GI_DEPTH_LAYER)) >>> 0;
  assert.equal(
    ((proxy.layers.mask >>> 0) & ~allowed) >>> 0, 0,
    "a proxy may only carry the depth-routing bits",
  );
  assert.equal(proxy.castShadow, true, "the proxy is the caster now");
});

check("a default view camera cannot see a proxy; a shadow camera configured for it can", () => {
  const { engine } = makeScene({ count: 4 });
  step(engine);
  const proxy = proxiesOf(engine)[0];
  // No camera in this engine calls layers.enableAll(); a view camera is layer 0
  // plus a few explicit bits.
  const view = new THREE.PerspectiveCamera();
  view.layers.enable(EDITOR_LAYER);
  assert.equal(view.layers.test(proxy.layers), false, "the colour pass must never draw a proxy");
  const shadowCam = new THREE.OrthographicCamera();
  shadowCam.layers.enable(SHADOW_PROXY_LAYER);
  assert.equal(shadowCam.layers.test(proxy.layers), true, "the depth pass must draw it");
  // And the originals stay visible to the view camera.
  assert.equal(view.layers.test(new THREE.Layers()), true, "layer-0 originals still render");
});

check("a light's shadow camera is taken OUT of three's mask-inheritance branch", () => {
  // three: if ((shadow.camera.layers.mask & 0xFFFFFFFE) === 0)
  //            shadow.camera.layers.mask = camera.layers.mask;
  // A view mask never contains SHADOW_PROXY_LAYER, so inheriting it would hide
  // the proxies from the depth pass — the merged half of the scene would stop
  // casting shadows altogether.
  const engine = new Engine();
  const entity = engine.createEntity("Sun");
  entity.addComponent("light", { kind: "directional", castShadow: true });
  const light = entity.getComponent("light").light;
  assert.ok(light?.shadow?.camera, "precondition: the light has a shadow camera");
  assert.notEqual(
    (light.shadow.camera.layers.mask >>> 0) & 0xfffffffe, 0,
    "the shadow camera must carry a bit above layer 0 or three overwrites its mask",
  );
  assert.equal(
    light.shadow.camera.layers.isEnabled(SHADOW_PROXY_LAYER), true,
    "and that bit has to be the proxy layer",
  );
});

// ---- what it must NOT absorb ------------------------------------------------

check("a SKINNED caster is left alone", () => {
  const { engine } = makeScene({ count: 4 });
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  skinned.castShadow = true;
  engine.scene.add(skinned);
  step(engine);
  assert.equal(
    skinned.castShadow, true,
    "it deforms in the VERTEX SHADER — baking its world-space vertices freezes its silhouette",
  );
  assert.equal(skinned.userData.shadowMergedInto, undefined);
});

check("an INSTANCED caster is left alone", () => {
  const { engine } = makeScene({ count: 4 });
  const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 8);
  instanced.castShadow = true;
  engine.scene.add(instanced);
  step(engine);
  assert.equal(instanced.castShadow, true, "per-instance transforms live in a buffer a merge cannot flatten");
});

check("a TRANSPARENT caster is left alone", () => {
  const { engine } = makeScene({ count: 4 });
  const glass = makeMesh(99, new THREE.MeshStandardMaterial({ transparent: true }));
  engine.scene.add(glass);
  step(engine);
  assert.equal(glass.castShadow, true, "transparent casters take a different path through the shadow render");
});

check("⭐⭐ a cell OVER the triangle cap is DICED, not thrown away (§18 W1)", () => {
  // The cap used to `return null` out of #buildProxy and #rebuild's
  // `if (!group) continue` dropped every member of the cell back to drawing
  // itself — so a cell of 400k triangles merged and a cell of 401k merged
  // NOTHING. On Bistro that was `Paris_Building_*` and `Paris_StringLights_*`,
  // the densest and most mergeable geometry in the scene, all unmerged.
  //
  // 8 spheres of ~130k triangles each = ~1.04M, which is 2.6 caps.
  const { MAX_PROXY_TRIANGLES } = { MAX_PROXY_TRIANGLES: 400_000 };
  const engine = new Engine();
  const meshes = [];
  for (let i = 0; i < 8; i++) {
    // widthSegments*heightSegments*2 triangles; 260x250 ≈ 130k.
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 260, 250), new THREE.MeshStandardMaterial());
    mesh.castShadow = true;
    // ⚠⚠ EXACTLY CO-LOCATED, AND THAT IS THE WHOLE FIXTURE. The first version
    // spread these over `i * 0.001` thinking that was "a tight cluster" — but
    // #splitByLocality normalises by the bounding box of the CENTRES, so any
    // spread at all, however small, dices them into 4 cells of ~260k and the
    // cap is never reached. The negative control passed and the test proved
    // nothing. Identical centres give `size = 0` on every axis, every mesh
    // lands in cell 0, and the triangle cap is the only thing left that can
    // split the group.
    engine.scene.add(mesh);
    meshes.push(mesh);
  }
  engine.scene.updateMatrixWorld(true);
  engine.shadowMerge.setEnabled(true);
  step(engine);

  const proxies = proxiesOf(engine);
  const perMesh = (260 * 250 * 2) / 1; // triangles in one sphere
  assert.ok(perMesh * 8 > MAX_PROXY_TRIANGLES, "fixture must actually exceed the cap");
  assert.ok(proxies.length >= 2, `expected the cell to be diced into >=2 proxies, got ${proxies.length}`);
  // ⚠ THE NEGATIVE CONTROL: before the fix this was 0 proxies and 8 live
  // casters. Assert the members were really absorbed, not merely counted.
  for (const mesh of meshes) {
    assert.equal(mesh.castShadow, false, "every member must be absorbed by some proxy");
    assert.ok(mesh.userData.shadowMergedInto, "every member must be owned");
  }
  for (const proxy of proxies) {
    const tris = proxy.geometry.index
      ? proxy.geometry.index.count / 3
      : proxy.geometry.attributes.position.count / 3;
    assert.ok(tris <= MAX_PROXY_TRIANGLES, `a diced proxy still busts the cap: ${tris}`);
  }
  assert.equal(engine.shadowMerge.stats.replaced, 8, "the receipt must count every absorbed member");
});

check("a mesh bigger than the whole cap is left alone while its neighbours still merge", () => {
  // No split can help the big one, and pretending otherwise would build a proxy
  // that busts the cap the dicing exists to enforce. The three small meshes are
  // here so the test can tell "the cap refused ONE member" apart from "the cap
  // refused the whole cell", which is the bug being fixed — co-located, for the
  // reason the fixture above spells out.
  const engine = new Engine();
  const huge = new THREE.Mesh(new THREE.SphereGeometry(0.5, 600, 500), new THREE.MeshStandardMaterial());
  huge.castShadow = true;
  engine.scene.add(huge);
  const smalls = [];
  for (let i = 0; i < 3; i++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.castShadow = true;
    engine.scene.add(mesh);
    smalls.push(mesh);
  }
  engine.scene.updateMatrixWorld(true);
  engine.shadowMerge.setEnabled(true);
  step(engine);
  assert.equal(huge.castShadow, true, "the oversized mesh must keep casting on its own");
  assert.ok(!huge.userData.shadowMergedInto, "the oversized mesh must not be owned by a proxy");
  for (const mesh of smalls) {
    assert.equal(mesh.castShadow, false, "its neighbours must still merge — one huge member is not a veto");
  }
});

check("⭐ non-casters merge too, into their OWN proxy that does not cast", () => {
  // §18 G1: GI's g-buffer draws every opaque mesh, not just the casting ones,
  // so the merge collects both — but `casts` is in the depth key, so the two
  // kinds can never share a proxy.
  const { engine, meshes } = makeScene({ count: 4 });
  const plain = [];
  for (let i = 0; i < 3; i++) {
    // THREE of them, not one: a single non-caster is below MIN_GROUP_SIZE and
    // would prove only that small groups are dropped. And INTERLEAVED with the
    // casters (they sit at x = 0,2,4,6), not parked far away: `#splitByLocality`
    // separates distant meshes on its own, so a cluster off at x = 50 passes
    // this test even with `casts` removed from the depth key — it proves the
    // spatial split, not the key.
    const mesh = makeMesh(1 + i * 2);
    mesh.castShadow = false;
    engine.scene.add(mesh);
    plain.push(mesh);
  }
  step(engine);
  const owners = new Set(plain.map((m) => m.userData.shadowMergedInto).filter(Boolean));
  assert.equal(owners.size, 1, "the three non-casters share exactly one proxy");
  const proxy = [...owners][0];
  assert.equal(
    proxy.castShadow, false,
    "a non-casting proxy must not put its members' shadows into the map",
  );
  // The mixing hazard stated directly: a proxy carries ONE castShadow, so a
  // group holding both kinds is wrong whichever value it takes.
  for (const caster of meshes) {
    assert.notEqual(
      caster.userData.shadowMergedInto, proxy,
      "a casting mesh must never end up inside the non-casting proxy",
    );
  }
  assert.equal(
    proxy.layers.isEnabled(GI_DEPTH_LAYER), true,
    "it exists for the g-buffer — that is the whole reason it was built",
  );
  for (const mesh of plain) {
    assert.notEqual(
      mesh.userData.shadowMergedInto, undefined,
      "a non-caster is absorbed now",
    );
  }
});

check("⭐ teardown restores a non-caster to FALSE — it must not gain a shadow", () => {
  // The regression this guards: `shadowCastAuthored` used to be hardcoded to
  // `true` at absorb time, which was correct while only casters were collected.
  // Replaying that onto a non-caster switches on a shadow the author disabled,
  // and only on teardown — a change that appears one rebuild after the cause.
  const { engine } = makeScene({ count: 4 });
  const plain = [];
  for (let i = 0; i < 3; i++) {
    const mesh = makeMesh(50 + i * 2);
    mesh.castShadow = false;
    engine.scene.add(mesh);
    plain.push(mesh);
  }
  step(engine);
  assert.ok(plain[0].userData.shadowMergedInto, "must actually have been absorbed first");
  engine.shadowMerge.setEnabled(false);
  for (const mesh of plain) {
    assert.equal(mesh.castShadow, false, "restored to what the author authored");
    assert.equal(mesh.userData.shadowMergedInto, undefined);
  }
});

check("an already-hidden mesh (merging absorbed it) is not double-counted", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  meshes[0].visible = false;
  step(engine);
  assert.equal(
    meshes[0].castShadow, true,
    "an invisible mesh is not drawn in the depth pass, so taking its castShadow would be a lie",
  );
});

// ---- lifecycle --------------------------------------------------------------

check("⭐ disabling restores every original's castShadow and removes the proxies", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  assert.equal(proxiesOf(engine).length, 1, "precondition: merged");
  engine.shadowMerge.setEnabled(false);
  assert.equal(proxiesOf(engine).length, 0, "proxies must leave the scene graph");
  for (const mesh of meshes) {
    assert.equal(mesh.castShadow, true, "THE MISSING-SHADOW BUG: an original was left un-restored");
    assert.equal(mesh.userData.shadowMergedInto, undefined);
  }
});

check("a rebuild restores before re-absorbing — castShadow never leaks", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  step(engine);
  step(engine);
  assert.equal(proxiesOf(engine).length, 1, "repeated rebuilds must not accumulate proxies");
  engine.shadowMerge.setEnabled(false);
  for (const mesh of meshes) assert.equal(mesh.castShadow, true);
});

check("dispose() leaves the scene exactly as it found it", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  engine.shadowMerge.dispose();
  assert.equal(proxiesOf(engine).length, 0);
  for (const mesh of meshes) assert.equal(mesh.castShadow, true);
});

check("the system is OFF unless the scene asks for it", () => {
  const engine = new Engine();
  for (let i = 0; i < 4; i++) engine.scene.add(makeMesh(i * 2));
  engine.scene.updateMatrixWorld(true);
  engine.shadowMerge.sync();
  assert.equal(proxiesOf(engine).length, 0, "shadowMerging defaults false — it rewrites castShadow");
});

check("the receipt reports what was actually replaced", () => {
  const { engine } = makeScene({ count: 4 });
  step(engine);
  const stats = engine.shadowMerge.stats;
  assert.equal(stats.proxies, 1);
  assert.equal(stats.replaced, 4, "a receipt that cannot see its own work is how the CSM freeze bug survived");
  assert.ok(stats.triangles > 0);
});

// ---- ownership: the resurrect-and-double-draw class ------------------------
//
// `merging.js` claims members via `visible = false` and every component write to
// `visible` defers to that claim, because a write landing while a proxy holds
// the mesh RESURRECTS it and draws its geometry twice. This system claims via a
// DIFFERENT channel — `castShadow = false` — which had no guard at all.

const { applyCastShadow } = await import("../src/engine/shadowMerge.js");

check("⭐ writing castShadow back ON while a proxy owns the mesh is DEFERRED", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  const mesh = meshes[0];
  assert.equal(mesh.castShadow, false, "precondition: absorbed");
  applyCastShadow(mesh, true, engine);
  assert.equal(
    mesh.castShadow, false,
    "THE DOUBLE-DRAW BUG: the original is back in the depth pass while its " +
    "triangles are also inside the proxy — once per cascade, and invisible in " +
    "the colour pass, so it reads as 'shadows got slower' rather than a bug",
  );
});

check("switching casting OFF applies immediately — it can never resurrect", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  applyCastShadow(meshes[0], false, engine);
  assert.equal(meshes[0].castShadow, false);
});

check("a deferred write is REPLAYED on teardown, not overwritten with true", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  applyCastShadow(meshes[0], false, engine); // author switches casting off
  applyCastShadow(meshes[1], true, engine); // and leaves this one casting
  engine.shadowMerge.setEnabled(false);
  assert.equal(
    meshes[0].castShadow, false,
    "an author who switched casting off must not have it switched back on when the proxy lets go",
  );
  assert.equal(meshes[1].castShadow, true);
});

check("a castShadow change while owned invalidates the merge", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  engine.shadowMerge._dirty = false;
  applyCastShadow(meshes[0], false, engine);
  assert.equal(
    engine.shadowMerge._dirty, true,
    "the proxy now contains a mesh that should no longer cast — it has to be rebuilt",
  );
});

check("an unowned mesh is written straight through", () => {
  const engine = new Engine();
  const mesh = makeMesh(0);
  applyCastShadow(mesh, false, engine);
  assert.equal(mesh.castShadow, false);
  applyCastShadow(mesh, true, engine);
  assert.equal(mesh.castShadow, true, "no claim, no deferral");
});

// ---- movers: a baked vertex buffer cannot follow -----------------------------

check("⭐ a member that MOVES is caught and the merge invalidates", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  engine.shadowMerge._dirty = false;
  meshes[1].position.x += 5;
  engine.scene.updateMatrixWorld(true);
  // The sweep is amortised over WATCH_WINDOW_FRAMES, so give it a full cycle.
  for (let i = 0; i < 8 && !engine.shadowMerge._dirty; i++) engine.shadowMerge.sync();
  assert.equal(
    engine.shadowMerge._dirty, true,
    "A STALE SHADOW: the merge baked world-space vertices and the caster left them behind",
  );
});

check("a caught mover is left UNMERGED on the next rebuild", () => {
  const { engine, meshes } = makeScene({ count: 4 });
  step(engine);
  meshes[1].position.x += 5;
  engine.scene.updateMatrixWorld(true);
  for (let i = 0; i < 8 && !engine.shadowMerge._dirty; i++) engine.shadowMerge.sync();
  step(engine);
  assert.equal(
    meshes[1].castShadow, true,
    "a mover re-absorbed every frame is worse than never merging it — it must cast for itself",
  );
  assert.equal(meshes[1].userData.shadowMergedInto, undefined);
});

check("⛔⛔ REBUILDING MUST BE A FIXED POINT — a rebuild may not ask for another", () => {
  // THE LIVE BUG (user, 2026-08-25): "gi keeps reloading forever" and "shadows
  // still broken". One cause. GI's `#collectMeshes` invalidates this system
  // whenever a GI layer bit differs from what it saw last scan — and a rebuild
  // DESTROYS ITS PROXIES AND BUILDS NEW MESHES, which GI then tags for the
  // first time, which reads as a change, which invalidates again. Forever. Each
  // turn re-mints the GI field and tears the 576 shadow proxies down mid-frame,
  // which is why the shadow map kept coming back wrong.
  //
  // This asserts the property that makes the cross-module loop impossible from
  // THIS side: with no external change, syncing must stop rebuilding.
  const { engine } = makeScene({ count: 12 });
  for (let i = 0; i < 12; i++) {
    engine.scene.updateMatrixWorld(true);
    engine.shadowMerge.sync();
  }
  const settled = engine.shadowMerge.rebuilds ?? 0;
  assert.ok(settled > 0, "fixture must actually build something");
  for (let i = 0; i < 20; i++) {
    engine.scene.updateMatrixWorld(true);
    engine.shadowMerge.sync();
  }
  assert.equal(
    engine.shadowMerge.rebuilds ?? 0,
    settled,
    "a settled scene must stop rebuilding — anything else is the loop",
  );
});

check("⛔⛔ A MEMBER'S GEOMETRY BEING REPLACED MUST REBUILD THE PROXY", () => {
  // THE DETACHED/MISSING SHADOW BUG (user, 2026-08-25): "shadows are broken
  // after each reload, have to change bias to fix them".
  //
  // A proxy bakes its members' vertices. This project STREAMS geometry (binary
  // `.geom` loads, virtual geometry's in-place cluster swap), so a mesh can be
  // present, positioned and casting while still holding a placeholder — and
  // nothing in `depthKeyOf` or `#watchForMotion` looked at geometry identity,
  // so the placeholder was baked in permanently.
  //
  // MEASURED on Bistro, identical camera, identical 38 proxy draws in the
  // shadow pass: 15 977 triangles per proxy cold vs 52 597 settled — the shadow
  // map was missing 73% of its geometry, so most of the scene stopped casting.
  const { engine, meshes } = makeScene({ count: 6 });
  step(engine);
  assert.ok(proxiesOf(engine).length > 0, "fixture must merge something first");
  assert.equal(engine.shadowMerge._dirty, false, "precondition: settled after the build");

  // The real asset lands: same mesh, same transform, a bigger geometry.
  meshes[2].geometry.dispose();
  meshes[2].geometry = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  engine.scene.updateMatrixWorld(true);
  // ⚠ The watcher is amortised on a round-robin cursor (WATCH_WINDOW_FRAMES),
  // so one sync only inspects a slice of the groups. Give it a full sweep —
  // asserting after a single call would pass or fail on which slice the cursor
  // happened to be on, which is a fixture that tests the cursor, not the watch.
  for (let i = 0; i < 8 && !engine.shadowMerge._dirty; i++) engine.shadowMerge.sync();
  assert.equal(
    engine.shadowMerge._dirty, true,
    "a member whose geometry was replaced must invalidate the merge — otherwise the proxy "
      + "casts the placeholder's silhouette for the rest of the session",
  );

  // ⚠ AND IT MUST NOT BE TREATED AS A MOVER. A swap is a one-time event; parking
  // the mesh permanently unmerged would answer a finished load with a permanent
  // draw-call regression.
  assert.ok(
    !engine.shadowMerge._movers.has(meshes[2]),
    "a geometry swap is not motion — the mesh must still be eligible to merge",
  );
  engine.shadowMerge._dirtiedAt = -Infinity;
  engine.shadowMerge._dirtySince = -Infinity;
  engine.shadowMerge.sync();
  assert.ok(
    proxiesOf(engine).some((p) => p.userData.shadowProxy),
    "and the rebuild must re-absorb it rather than leave it drawing alone",
  );
});

check("⛔⛔ THE BAKE LANDS WHERE THE MEMBERS ARE — proxy bounds == union of member bounds", () => {
  // The user's symptom was shadows in the WRONG PLACE, and a proxy's position is
  // not a transform at render time — it is baked into the vertices at build
  // time by `mergeGeometries`, which reads `member.mesh.matrixWorld`. If that
  // matrix is stale (or identity, before the scene's first
  // `updateMatrixWorld`), every vertex lands somewhere the member is not, and
  // NOTHING downstream can tell: the proxy renders happily, just in the wrong
  // place, and only the shadow it casts gives it away.
  //
  // Geometry is checkable without a GPU or a viewport, so this asserts the thing
  // the eye was being asked to judge: the merged geometry must occupy exactly
  // the space its members occupy.
  const engine = new Engine();
  const meshes = [];
  for (let i = 0; i < 6; i++) {
    const mesh = makeMesh(0);
    // ⚠ NON-TRIVIAL, NON-UNIFORM TRANSFORMS, and nested one level deep. A
    // fixture whose members sit at the origin with identity matrices cannot
    // distinguish "baked correctly" from "baked from an identity matrix" —
    // the same trap as the co-located-cell fixture in this file's history.
    const parent = new THREE.Group();
    parent.position.set(i * 7 - 20, 3, i * 2);
    parent.rotation.set(0.3, i * 0.4, 0.15);
    parent.scale.set(1.4, 0.8, 1.1);
    parent.add(mesh);
    mesh.position.set(i, -i * 0.5, 2);
    engine.scene.add(parent);
    meshes.push(mesh);
  }
  engine.scene.updateMatrixWorld(true);
  engine.shadowMerge.setEnabled(true);
  step(engine);

  const proxies = proxiesOf(engine);
  assert.ok(proxies.length > 0, "the fixture must actually merge something");

  const expected = new THREE.Box3();
  for (const mesh of meshes) expected.expandByObject(mesh);

  const actual = new THREE.Box3();
  for (const proxy of proxies) {
    proxy.geometry.computeBoundingBox();
    // The proxy's own matrix is identity and its vertices are world-space, so
    // the geometry box IS the world box. Asserting that is also asserting the
    // proxy is not silently relying on a transform it does not have.
    actual.union(proxy.geometry.boundingBox);
  }

  const tol = 1e-3;
  for (const axis of ["x", "y", "z"]) {
    assert.ok(
      Math.abs(actual.min[axis] - expected.min[axis]) < tol
        && Math.abs(actual.max[axis] - expected.max[axis]) < tol,
      `${axis}: proxy occupies [${actual.min[axis].toFixed(3)}, ${actual.max[axis].toFixed(3)}] `
        + `but its members occupy [${expected.min[axis].toFixed(3)}, ${expected.max[axis].toFixed(3)}] `
        + "— the bake used the wrong matrix, so the shadow lands somewhere the object is not",
    );
  }
});

check("⛔⛔ THE FIRST BUILD MUST NOT TRUST SOMEONE ELSE TO HAVE UPDATED THE MATRICES", () => {
  // `Engine#tick` runs `shadowMerge.sync()` BEFORE `renderer.render()`, and
  // `renderer.render()` is what calls `scene.updateMatrixWorld()`. On the very
  // first tick nothing has updated them yet — and the settle debounce is
  // deliberately bypassed for the first build (`this.groups.length > 0` is
  // false), so that first build is exactly the one most likely to run against
  // identity matrices.
  //
  // `mergeGeometries` bakes `member.mesh.matrixWorld` into the vertices, so a
  // proxy built then is permanently wrong — parked at the origin — and nothing
  // rebuilds it until something unrelated invalidates the merge. Which is
  // precisely why touching the shadow bias "fixed" the user's shadows: that
  // path invalidates, and the rebuild finally sees real matrices.
  const engine = new Engine();
  const meshes = [];
  for (let i = 0; i < 6; i++) {
    const mesh = makeMesh(0);
    mesh.position.set(i * 9 - 25, 4, i * 3);
    mesh.rotation.set(0.2, i * 0.5, 0.1);
    engine.scene.add(mesh);
    meshes.push(mesh);
  }
  // ⚠ DELIBERATELY NO `engine.scene.updateMatrixWorld(true)` HERE. That call is
  // the fixture doing the engine's job for it, and it is what hid this.
  engine.shadowMerge.setEnabled(true);
  engine.shadowMerge._dirtiedAt = -Infinity;
  engine.shadowMerge._dirtySince = -Infinity;
  engine.shadowMerge.sync();

  const proxies = proxiesOf(engine);
  assert.ok(proxies.length > 0, "the fixture must actually merge something");

  // Now resolve the truth the way the renderer would, and compare.
  engine.scene.updateMatrixWorld(true);
  const expected = new THREE.Box3();
  for (const mesh of meshes) expected.expandByObject(mesh);
  const actual = new THREE.Box3();
  for (const proxy of proxies) {
    proxy.geometry.computeBoundingBox();
    actual.union(proxy.geometry.boundingBox);
  }
  const off = Math.max(
    Math.abs(actual.min.x - expected.min.x), Math.abs(actual.max.x - expected.max.x),
    Math.abs(actual.min.z - expected.min.z), Math.abs(actual.max.z - expected.max.z),
  );
  assert.ok(
    off < 1e-3,
    `the proxy is baked ${off.toFixed(2)} units from its members — it was built before anything `
      + "updated the world matrices, so every shadow it casts lands in the wrong place",
  );
});

check("⭐ a proxy is marked `static` — the per-object refresh opt-out", () => {
  // three checks `renderObject.object.static` inside NodeMaterialObserver
  // .needsRefresh(), but only AFTER `hasNode`. A proxy reaches it because it is
  // drawn solely through `scene.overrideMaterial`, whose material carries no
  // node slots. Losing this flag costs ~35 µs of per-object node/binding work
  // per draw, per pass, and nothing about the image would change.
  //
  // ⛔ I DELETED THIS CHECK ONCE, on the theory that `static` left a stale
  // MODEL-VIEW when the shadow camera moved and explained the user's detached
  // shadows. Refuted: model-view is only CPU-computed under
  // `renderer.highPrecision`, which this engine never enables, so it is
  // composed in the shader from a camera-group uniform. Restored, with the
  // refutation recorded at the write site. ⚠ The lesson is not "the check was
  // right" — it is that I inverted a guard to match a hypothesis instead of
  // testing the hypothesis first.
  const { engine } = makeScene({ count: 4 });
  step(engine);
  const proxies = proxiesOf(engine);
  assert.ok(proxies.length > 0, "the fixture must actually merge something");
  for (const proxy of proxies) {
    assert.equal(proxy.static, true, "a proxy never mutates in place — it is rebuilt");
    assert.equal(
      proxy.matrixAutoUpdate, false,
      "and its baked world-space vertices must never take a transform",
    );
  }
});

check("⛔ GI's tag invalidation still ignores a FIRST tagging", () => {
  // A source guard, deliberately, because the loop spans two modules: the
  // trigger lives in GISystem#collectMeshes and the damage lands here, and
  // nothing this fixture can construct exercises the GPU-side roughness drain
  // that flips those tags. What it pins is the one token that separates "this
  // tag CHANGED" from "this mesh is new" — deleting it restores the loop.
  const source = readFileSync(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
  assert.ok(
    source.includes("if (taggedBefore && object.layers.mask !== maskBefore)"),
    "GISystem must not treat a first tagging as a depth-key flip",
  );
  assert.ok(
    source.includes("this._giTaggedMeshes ??= new WeakSet();"),
    "the set that distinguishes a new mesh from a changed one is gone",
  );
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
