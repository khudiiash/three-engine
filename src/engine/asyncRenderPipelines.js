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
//   · size — the fragment program has to be at least `minFragmentBytes` of
//     WGSL. Shadow-depth materials (~1 kB), the GI gbuffer overrides
//     (~1.5 kB), unlit materials (~4 kB) compile in a few ms and are not worth
//     a frame of absence; lit materials without GI are ~27 kB, with GI
//     170–250 kB, and those are the stalls.
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
  const original = pipelines._getRenderPipeline;
  pipelines._getRenderPipeline = function (renderObject, stageVertex, stageFragment, cacheKey, promises) {
    if (
      promises == null
      && state.active
      && globalThis.__asyncRenderPipelines !== false
      && (stageFragment?.code?.length ?? 0) >= (Number(globalThis.__asyncRenderPipelinesMinBytes) || state.minFragmentBytes)
    ) {
      state.deferred += 1;
      return original.call(this, renderObject, stageVertex, stageFragment, cacheKey, sink);
    }
    return original.call(this, renderObject, stageVertex, stageFragment, cacheKey, promises);
  };
  pipelines.__asyncRenderPipelines = state;
  return state;
}
