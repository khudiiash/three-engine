// ASYNC RENDER PIPELINES FOR THE MAIN SCENE RENDER — the freeze class named
// by `probe:gi-boot-frames` and `probe:camera-motion` on 2026-09-02.
//
// three creates a render pipeline SYNCHRONOUSLY the first time an object with
// a new (material, geometry layout, render context) is drawn:
// `Pipelines.getForRender(renderObject)` → `_getRenderPipeline(…, promises =
// null)` → `device.createRenderPipeline(desc)`. In Chrome the call returns at
// once, but the GPU process executes it IN ORDER on its command thread, so a
// 170 kB GI-injected material shader parks that thread for its whole compile
// and every later command from this page — including the flow-control ack the
// renderer's main thread is waiting on — queues behind it. The page's main
// thread then blocks for the length of the compile, inside a task the ledger
// reports as `longtask unknown:window` with 0% of it in any wrapped WebGPU
// call. Measured on the user's Level: 28 sync pipelines at first paint =
// 1.1–1.2 s frozen; 29 at the first lit frame = 2.4 s; NINE on a camera drag
// (7 of them lit-material variants first seen when the camera turned) =
// 1.19 s — the "heavy freezes on launch and after I move the camera" report.
//
// three already owns the fix and uses it in `compileAsync`: hand the backend a
// promises array and `createRenderPipelineAsync` compiles on the driver's
// worker threads while `Renderer._renderObjectDirect` SKIPS the draw
// (`Pipelines.isReady` is false until the promise lands). Nothing blocks; the
// object appears the frame its pipeline is ready. This module turns that path
// on for the ENGINE'S MAIN RENDER ONLY, and only for shaders large enough to
// matter:
//
//   · scope — `active` is raised by Engine around the one call that presents
//     the frame (the scene render, or the postprocess override's). A one-shot
//     render outside it (an atlas tile blit, an impostor bake, a texture
//     average readback, the editor's picking/outline passes) keeps the sync
//     path, because a skipped draw there is a black result nobody re-renders
//     — the exact failure class of gi-atlas-blit-cleared-itself.
//   · size — the LARGER of the two programs has to be at least
//     `minFragmentBytes` of WGSL. Shadow-depth materials (~1 kB), the GI
//     gbuffer overrides (~1.5 kB), unlit materials (~4 kB) compile in a few ms
//     and are not worth a frame of absence; lit materials without GI are
//     ~27 kB, with GI 170–250 kB, and those are the stalls.
//
//     ⛔ AND DO NOT ADD A "NESTED RENDERS STAY SYNC" RULE ON RENDER DEPTH.
//     It is the obvious guard and it is wrong here: with a Postprocess
//     component the SCENE render is nested by construction (RenderPipeline →
//     QuadMesh.render → PassNode.updateBefore → renderer.render), so a depth
//     rule would send exactly the heavy lit materials back down the blocking
//     path on the scenes that need this most. The one-shot renders the scope
//     rule protects — atlas blits, impostor bakes, picking, the outline mask —
//     run from preRender/postRender where `active` is already false. A nested
//     pass that DOES ride inside the main render (a planar reflection, a water
//     mirror) re-renders every frame, so a deferred pipeline costs it one
//     frame, not a permanent black.
//
//     ⚠ IT USED TO READ THE FRAGMENT ALONE, and the freeze ledger caught what
//     that misses (2026-09-07, the user's Pool scene): `[freeze] 175 ms —
//     (unattributed) 175 [sync gpu: 17r/0c/2m, 78kB WGSL]` — seventeen render
//     pipelines built synchronously from two ~39 kB programs. A displaced
//     water surface, a skinned mesh and every vertex-animated material carry
//     their weight in the VERTEX stage, where the old gate read a fragment of
//     a few kB and sent them all down the blocking path. The driver compiles
//     both stages either way, so both have to be looked at.
//
// What changes for the user: the first frame of a scene shows objects filling
// in over the driver's compile time instead of the whole editor freezing for
// it; turning the camera onto a never-seen material costs a few frames of
// that object being absent instead of a >1 s hitch. A material edit also goes
// through here (three mints a new pipeline), so the edited object is absent
// for one compile — noted, accepted: no freeze is the standing rule.
//
// `globalThis.__asyncRenderPipelines = false` restores the sync path whole
// (the A/B arm); `__asyncRenderPipelinesMinBytes` moves the size gate.

export const ASYNC_RENDER_PIPELINE_MIN_BYTES = 16 * 1024;

/**
 * Install the interception once per renderer and return its state object.
 * Idempotent; safe to call every frame.
 *
 * @param {import("three/webgpu").WebGPURenderer} renderer
 * @return {{active: boolean, deferred: number, minFragmentBytes: number}|null}
 */
/**
 * Was this render object DRAWING when its program was replaced?
 *
 * ⭐ THE RULE: defer a FIRST compile, never a RE-MINT.
 *
 * `Renderer._renderObjectDirect` skips the draw entirely while
 * `_pipelines.isReady()` is false, and `isReady` reads the render object's
 * CURRENT pipeline. So when a material that was already drawing gets a new
 * program, the async path replaces its ready pipeline with a compiling one and
 * the object VANISHES until the driver finishes, then pops back. That is the
 * user's report, verbatim: *"every mesh I select disappears for a moment, and
 * then gets back"* (2026-09-07). Reproduced by selecting one mesh in Sponza:
 * its material rebuilt on `aoNode,colorNode,customProgramCacheKey,emissiveNode`
 * and a new `renderPipeline_MeshPhysicalNodeMaterial_138 [async]` appeared.
 *
 * The two cases are not the same trade:
 *
 * · **First compile** — nothing is on screen. Deferring costs frames of an
 *   object that was never visible and keeps the viewport live through a
 *   compile wave. Keep deferring.
 * · **Re-mint** — the object is on screen NOW. Deferring swaps a visible
 *   object for an invisible one, which is a rendering bug, not a win. Compile
 *   it synchronously: one hitch beats a hole.
 *
 * ⛔ CHECKING THE PREVIOUS PIPELINE INSIDE `_getRenderPipeline` DOES NOT WORK,
 * and measuring is the only reason we know. `Pipelines.getForRender` runs
 * `if (previousPipeline && previousPipeline.usedTimes === 0)
 * this._releasePipeline(previousPipeline)` FIRST — so by the time the inner
 * hook is reached, the evidence that this object was drawing has already been
 * destroyed. The first version of this fix did exactly that, passed its unit
 * tests, and changed nothing live: the re-mint still logged
 * `renderPipeline_MeshPhysicalNodeMaterial_142 [async]`. The readiness has to
 * be captured on the way IN, which is what the `getForRender` wrapper does.
 *
 * ⛔ DRAWING THE OLD PIPELINE INSTEAD was considered and rejected: bind groups
 * are rebuilt for the NEW pipeline's layout, so binding them against the old
 * one is a validation error at best. Pipeline and bindings move together.
 *
 * `__asyncRenderPipelinesRemint = true` restores the old behaviour (defer
 * everything) as the A/B arm for measuring what the hitch costs.
 */
function pipelineIsReady(pipelines, pipeline) {
  try {
    if (pipeline === undefined || pipeline === null) return false;
    const data = pipelines.backend?.get?.(pipeline);
    return data?.pipeline !== undefined && data?.pipeline !== null;
  } catch {
    // An internals shape three changed: fall back to the old behaviour rather
    // than making every pipeline synchronous by accident.
    return false;
  }
}

export function installAsyncRenderPipelines(renderer) {
  const pipelines = renderer?._pipelines;
  if (!pipelines || typeof pipelines._getRenderPipeline !== "function") return null;
  if (pipelines.__asyncRenderPipelines) return pipelines.__asyncRenderPipelines;

  const state = {
    active: false,
    /** pipelines that went through the async path (the ledger's receipt) */
    deferred: 0,
    minFragmentBytes: ASYNC_RENDER_PIPELINE_MIN_BYTES,
  };
  // The backend pushes one promise per pipeline into this. Nobody awaits it
  // (three sets `pipelineData.pipeline` from inside the promise itself), so
  // a sink that keeps nothing is the whole array this path needs — an
  // ever-growing real array would pin every pipeline promise for the session.
  const sink = { push() {} };
  // Set by the `getForRender` wrapper for the duration of ONE synchronous
  // call. `_getRenderPipeline` runs inside it with no await in between, so a
  // single slot is enough and a WeakMap would only add churn per draw.
  let drawingBeforeUpdate = false;
  const originalGetForRender = pipelines.getForRender;
  if (typeof originalGetForRender === "function") {
    pipelines.getForRender = function (renderObject, promises) {
      const previous = drawingBeforeUpdate;
      try {
        drawingBeforeUpdate = pipelineIsReady(this, this.get(renderObject)?.pipeline);
      } catch {
        drawingBeforeUpdate = false;
      }
      try {
        return originalGetForRender.call(this, renderObject, promises);
      } finally {
        drawingBeforeUpdate = previous;
      }
    };
  }

  const original = pipelines._getRenderPipeline;
  pipelines._getRenderPipeline = function (renderObject, stageVertex, stageFragment, cacheKey, promises) {
    if (
      promises == null
      && state.active
      && globalThis.__asyncRenderPipelines !== false
      && Math.max(stageFragment?.code?.length ?? 0, stageVertex?.code?.length ?? 0)
        >= (Number(globalThis.__asyncRenderPipelinesMinBytes) || state.minFragmentBytes)
      && !(drawingBeforeUpdate && globalThis.__asyncRenderPipelinesRemint !== true)
    ) {
      state.deferred += 1;
      return original.call(this, renderObject, stageVertex, stageFragment, cacheKey, sink);
    }
    return original.call(this, renderObject, stageVertex, stageFragment, cacheKey, promises);
  };
  pipelines.__asyncRenderPipelines = state;
  return state;
}
