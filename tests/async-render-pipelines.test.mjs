/**
 * DEFER A FIRST COMPILE. NEVER DEFER A RE-MINT.
 *
 * `installAsyncRenderPipelines` routes big pipelines through
 * `createRenderPipelineAsync` so the driver compiles them off the main thread.
 * three skips the draw entirely while `_pipelines.isReady()` is false, and
 * `isReady` reads the render object's CURRENT pipeline — so the async path
 * replaces a ready pipeline with a compiling one, and the object disappears
 * until the driver is done.
 *
 * ⛔ THE REPORT (2026-09-07): *"every mesh I select disappears for a moment,
 * and then gets back"*. Reproduced by selecting a single mesh in Sponza: its
 * material rebuilt on `aoNode,colorNode,customProgramCacheKey,emissiveNode`
 * and a new `renderPipeline_MeshPhysicalNodeMaterial_138 [async]` was created,
 * so for the length of that compile there was a hole where the mesh had been.
 *
 * The two cases are opposite trades, which is the whole of the fix:
 *
 *   · a FIRST compile has nothing on screen — deferring costs invisible
 *     frames and keeps the viewport live through a compile wave;
 *   · a RE-MINT is on screen NOW — deferring swaps a visible object for an
 *     invisible one, which is a rendering bug, not a performance win.
 *
 * These drive the real installer against a fake `Pipelines` shaped like
 * three's — including the part that made the FIRST version of the fix useless:
 * `getForRender` RELEASES the previous pipeline before it reaches
 * `_getRenderPipeline`, so a check made there finds no evidence the object was
 * ever drawing. That version passed a simpler test and changed nothing live.
 * The fake reproduces the release for exactly that reason.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { installAsyncRenderPipelines } from "../src/engine/asyncRenderPipelines.js";

/** WGSL long enough to clear the size gate the installer applies. */
const BIG = { code: "x".repeat(300_000) };
const SMALL = { code: "x".repeat(16) };

/** Which stage size a given render object should report. */
const stageSizes = new Map();
const stageFor = (renderObject) => stageSizes.get(renderObject) ?? BIG;

/**
 * A stand-in for three's `Pipelines` + backend. `ready` names the render
 * objects whose existing pipeline has finished compiling.
 */
function makePipelines({ ready = new Set() } = {}) {
  const backendData = new Map();
  const objectData = new Map();
  const calls = [];
  const pipelines = {
    backend: { get: (pipeline) => backendData.get(pipeline) ?? {} },
    get: (renderObject) => objectData.get(renderObject) ?? {},
    _getRenderPipeline(renderObject, stageVertex, stageFragment, cacheKey, promises) {
      // `promises == null` is three's own signal for "compile synchronously".
      calls.push({ renderObject, deferred: promises != null });
      return { id: cacheKey };
    },
    /**
     * three's real shape, and the part that made the FIRST version of this fix
     * useless: `getForRender` RELEASES the previous pipeline before reaching
     * `_getRenderPipeline`, so an inner check finds nothing. The readiness has
     * to be captured on the way in, and only a fake that reproduces the
     * release can prove it is.
     */
    getForRender(renderObject, promises = null) {
      const previous = objectData.get(renderObject)?.pipeline;
      if (previous) { backendData.delete(previous); objectData.delete(renderObject); }
      return this._getRenderPipeline(renderObject, SMALL, stageFor(renderObject), "cache", promises);
    },
    // Test helpers.
    __calls: calls,
    __give(renderObject, { compiled }) {
      const pipeline = { tag: renderObject };
      objectData.set(renderObject, { pipeline });
      backendData.set(pipeline, { pipeline: compiled ? {} : null });
    },
  };
  for (const renderObject of ready) pipelines.__give(renderObject, { compiled: true });
  return pipelines;
}

function install(pipelines) {
  const state = installAsyncRenderPipelines({ _pipelines: pipelines });
  state.active = true;
  return state;
}

test("a FIRST compile of a big pipeline is deferred", () => {
  const pipelines = makePipelines();
  const state = install(pipelines);

  pipelines.getForRender("newObject", null);

  assert.equal(pipelines.__calls[0].deferred, true, "nothing is on screen yet, so the driver can take its time");
  assert.equal(state.deferred, 1);
});

test("⛔ a RE-MINT of a drawing object is NOT deferred", () => {
  // THE REGRESSION. This object already has a compiled pipeline on screen.
  // Handing its replacement to the async path is what makes it vanish.
  const pipelines = makePipelines({ ready: new Set(["visibleObject"]) });
  const state = install(pipelines);

  pipelines.getForRender("visibleObject", null);

  assert.equal(
    pipelines.__calls[0].deferred, false,
    "a visible object must not be traded for an invisible one while its new program compiles",
  );
  assert.equal(state.deferred, 0, "and it is not counted as a deferral either");
});

test("an object whose existing pipeline is STILL COMPILING is treated as a first compile", () => {
  // It is not on screen — there is nothing to protect — so the async path is
  // still the right trade. This is the case a naive "has a pipeline object"
  // check would get wrong.
  const pipelines = makePipelines();
  pipelines.__give("pendingObject", { compiled: false });
  install(pipelines);

  pipelines.getForRender("pendingObject", null);
  assert.equal(pipelines.__calls[0].deferred, true);
});

test("small pipelines are never deferred, re-mint or not", () => {
  const pipelines = makePipelines();
  install(pipelines);
  stageSizes.set("tinyObject", SMALL);
  pipelines.getForRender("tinyObject", null);
  assert.equal(pipelines.__calls[0].deferred, false, "the size gate still comes first");
});

test("the hatch restores deferring every pipeline", () => {
  globalThis.__asyncRenderPipelinesRemint = true;
  try {
    const pipelines = makePipelines({ ready: new Set(["visibleObject"]) });
    install(pipelines);
    pipelines.getForRender("visibleObject", null);
    assert.equal(pipelines.__calls[0].deferred, true, "the A/B arm for measuring what the hitch costs");
  } finally {
    delete globalThis.__asyncRenderPipelinesRemint;
  }
});

test("a caller that already passed a promises array is left alone", () => {
  // That is the compile wave collecting its own promises. Overriding it there
  // would serialise the wave against itself.
  const pipelines = makePipelines();
  install(pipelines);
  const collected = [];
  pipelines.getForRender("waveObject", collected);
  assert.equal(pipelines.__calls[0].deferred, true, "the caller's own array is passed through");
});

test("internals that do not match three's shape fall back to deferring", () => {
  // A three upgrade that renames `backend.get` must not silently make EVERY
  // pipeline synchronous — that would turn a compile wave back into the 30 s
  // freeze the async path exists to prevent.
  const pipelines = makePipelines({ ready: new Set(["visibleObject"]) });
  pipelines.get = () => { throw new Error("three moved this"); };
  const state = install(pipelines);

  pipelines.getForRender("visibleObject", null);
  assert.equal(pipelines.__calls[0].deferred, true);
  assert.equal(state.deferred, 1);
});
