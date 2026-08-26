/**
 * THE GBUFFER MASK PASS'S CLEAR SEMANTICS (`renderGiGBuffer`, giScreen.js).
 *
 *   node scripts/run-gi-gbuffer-clear-test.mjs
 *
 * ⭐⭐ WHY THIS FILE EXISTS. Masked exact reflections were reverted FOUR times
 * over three sessions on one bug, and every revert lost the diagnosis with it.
 * The mechanism, finally read out of three r185's own source
 * (renderers/common/Background.js):
 *
 *     let forceClear = false;
 *     } else if ( background.isColor === true ) { forceClear = true; }   // :78
 *     if ( renderer.autoClear === true || forceClear === true ) {        // :185
 *         renderContext.clearColor = renderer.autoClearColor === true;   // :209
 *         renderContext.clearDepth = renderer.autoClearDepth === true;
 *
 * It is an **OR**. Pass 2 of the gbuffer sets `renderer.autoClear = false` and
 * assumed that retained pass 1's attachments — but ANY opaque `Color`
 * `scene.background` sets `forceClear`, the branch runs anyway, and the
 * `autoClear*` flags default true. The pass then opens with a clear loadOp on
 * every MRT attachment AND on depth, so only the masked meshes survive as
 * gbuffer geometry and every other pixel reads `position.w == 0` — the
 * user-visible "every diffuse wall PITCH BLACK while the mirror stays lit".
 *
 * So the invariant under test is not "autoClear is false" (that was true the
 * whole time it was broken). It is: **at the moment the mask pass renders,
 * nothing three consults can ask for a clear.**
 */
import assert from "node:assert/strict";

const { renderGiGBuffer } = await import("../src/modules/gi/giScreen.js");

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

/** Minimal stand-ins for the only members `renderGiGBuffer` touches. */
function makeLayers(mask = 1) {
  return {
    mask,
    disable(bit) { this.mask &= ~(1 << bit); },
    set(bit) { this.mask = 1 << bit; },
  };
}

function makeRig({ background = { isColor: true } } = {}) {
  const renders = [];
  const scene = { overrideMaterial: null, background, backgroundNode: null };
  const camera = { layers: makeLayers(0b1011) };
  const gbuffer = {
    rt: { id: "gbufferRT" },
    material: { id: "depthMat" },
    mrtNode: { id: "mrt1" },
    maskMaterial: { id: "maskMat" },
    maskMrtNode: { id: "mrt2" },
    position: { id: "positionTex" },
  };
  const renderer = {
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    transparent: true,
    shadowMap: { enabled: true },
    _target: { id: "mainRT" },
    _mrt: { id: "mainMRT" },
    getRenderTarget() { return this._target; },
    setRenderTarget(t) { this._target = t; },
    getMRT() { return this._mrt; },
    setMRT(m) { this._mrt = m; },
    render() {
      // Snapshot everything three would consult AT DRAW TIME. Reading these
      // after the call returns proves nothing — the `finally` restores them.
      renders.push({
        overrideMaterial: scene.overrideMaterial,
        background: scene.background,
        backgroundNode: scene.backgroundNode,
        autoClear: renderer.autoClear,
        autoClearColor: renderer.autoClearColor,
        autoClearDepth: renderer.autoClearDepth,
        autoClearStencil: renderer.autoClearStencil,
        layerMask: camera.layers.mask,
        mrt: renderer._mrt,
      });
    },
  };
  return { renderer, scene, camera, gbuffer, renders };
}

// ---- the mask pass's clear semantics ----------------------------------------

check("⭐⭐ the mask pass cannot clear COLOUR, whatever forceClear decides", () => {
  const rig = makeRig();
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  const pass2 = rig.renders[1];
  assert.ok(pass2, "the mask pass never rendered");
  assert.equal(
    pass2.autoClearColor, false,
    "autoClearColor was true at mask-pass draw time — Background.update would set " +
      "renderContext.clearColor and wipe pass 1's MRT attachments",
  );
});

check("⭐⭐ the mask pass cannot clear DEPTH — occlusion depends on pass 1's depth", () => {
  const rig = makeRig();
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  assert.equal(rig.renders[1].autoClearDepth, false);
});

check("the mask pass cannot clear STENCIL either", () => {
  const rig = makeRig();
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  assert.equal(rig.renders[1].autoClearStencil, false);
});

check("⭐ an opaque Color background is REMOVED for the mask pass", () => {
  // Two reasons, and both matter: it is what sets `forceClear` in the first
  // place, and `Background.update` would otherwise add a background MESH to
  // this pass's render list — which under `scene.overrideMaterial` rasterises
  // a skybox INTO the gbuffer as world geometry sitting on the camera.
  const rig = makeRig({ background: { isColor: true } });
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  assert.equal(rig.renders[1].background, null);
  assert.equal(rig.renders[1].backgroundNode, null);
});

check("autoClear itself is still false during the mask pass", () => {
  const rig = makeRig();
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  assert.equal(rig.renders[1].autoClear, false);
});

// ---- the first pass must be UNAFFECTED --------------------------------------

check("⭐ pass 1 still clears — it is the pass that establishes the buffer", () => {
  // Suppressing the clear on pass 1 would leave LAST frame's positions behind
  // wherever this frame has no geometry, which is a stale-world bug, not a
  // wipe. Only pass 2 retains.
  const rig = makeRig();
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  const pass1 = rig.renders[0];
  assert.equal(pass1.autoClear, true, "pass 1 must keep the renderer's own autoClear");
  assert.equal(pass1.autoClearColor, true);
  assert.equal(pass1.autoClearDepth, true);
});

check("pass 1 draws the depth override, pass 2 the mask material", () => {
  const rig = makeRig();
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  assert.equal(rig.renders[0].overrideMaterial, rig.gbuffer.material);
  assert.equal(rig.renders[1].overrideMaterial, rig.gbuffer.maskMaterial);
  assert.equal(rig.renders[0].mrt, rig.gbuffer.mrtNode);
  assert.equal(rig.renders[1].mrt, rig.gbuffer.maskMrtNode);
});

// ---- nothing may leak, or the MAIN pass stops clearing forever --------------

check("⭐⭐ every stomped renderer flag is restored", () => {
  // A leaked `autoClearColor = false` would stop the main scene pass clearing
  // for the rest of the session — a far worse bug than the one being fixed,
  // and one that would present as smearing rather than as black.
  const rig = makeRig();
  const before = {
    autoClear: rig.renderer.autoClear,
    autoClearColor: rig.renderer.autoClearColor,
    autoClearDepth: rig.renderer.autoClearDepth,
    autoClearStencil: rig.renderer.autoClearStencil,
    transparent: rig.renderer.transparent,
    shadows: rig.renderer.shadowMap.enabled,
  };
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  assert.deepEqual({
    autoClear: rig.renderer.autoClear,
    autoClearColor: rig.renderer.autoClearColor,
    autoClearDepth: rig.renderer.autoClearDepth,
    autoClearStencil: rig.renderer.autoClearStencil,
    transparent: rig.renderer.transparent,
    shadows: rig.renderer.shadowMap.enabled,
  }, before);
});

check("⭐⭐ the scene's background is restored — it is the USER'S sky", () => {
  const background = { isColor: true, tag: "the user's sky" };
  const backgroundNode = { tag: "the user's env node" };
  const rig = makeRig({ background });
  rig.scene.backgroundNode = backgroundNode;
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  assert.equal(rig.scene.background, background);
  assert.equal(rig.scene.backgroundNode, backgroundNode);
});

check("the render target, MRT, override and camera layers are restored", () => {
  const rig = makeRig();
  const mask = rig.camera.layers.mask;
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: true });
  assert.equal(rig.renderer._target.id, "mainRT");
  assert.equal(rig.renderer._mrt.id, "mainMRT");
  assert.equal(rig.scene.overrideMaterial, null);
  assert.equal(rig.camera.layers.mask, mask);
});

check("restoration survives a THROWING render (the finally is real)", () => {
  const rig = makeRig();
  rig.renderer.render = () => { throw new Error("pipeline died mid-pass"); };
  assert.throws(() => renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, {
    mirrorMask: true,
  }));
  assert.equal(rig.renderer.autoClearColor, true, "a thrown pass leaked autoClearColor");
  assert.ok(rig.scene.background, "a thrown pass leaked the nulled background");
  assert.equal(rig.renderer.shadowMap.enabled, true);
});

// ---- the unmasked path is untouched -----------------------------------------

check("without the mask there is exactly ONE pass and nothing is stomped", () => {
  const rig = makeRig();
  renderGiGBuffer(rig.renderer, rig.scene, rig.camera, rig.gbuffer, { mirrorMask: false });
  assert.equal(rig.renders.length, 1);
  assert.equal(rig.renders[0].autoClearColor, true);
  assert.ok(rig.renders[0].background, "the unmasked path must not touch the background");
});

console.log(failures ? `\n${failures} failing` : "\nall ok");
process.exit(failures ? 1 : 0);
