import { GlobalIlluminationComponent } from "./GlobalIlluminationComponent.js";
import { ReflectionProbeComponent } from "./ReflectionProbeComponent.js";

/**
 * Global Illumination module — 3D Radiance Cascades.
 *
 * Port of the Shadertoy "Radiance Cascades 3D" (X3XfRM) approach to a
 * world-space probe lattice with a same-frame hierarchical merge in WebGPU
 * compute (the temporal merge — and its flicker/lag — was purely a Shadertoy
 * single-buffer limitation). See docs/shadertoy_*.glsl for the reference and
 * scripts/gi-rc-spike.* / gi-rc-voxel.* for the phase harnesses.
 */
export const giModule = {
  id: "gi",
  name: "Global Illumination",
  description: "Real-time GI via 3D radiance cascades over a single-bake voxel grid",
  version: "1.0.0",
  category: "Rendering",
  tags: ["gi", "lighting", "radiance-cascades", "webgpu"],
  components: [GlobalIlluminationComponent, ReflectionProbeComponent],
  async setup(engine) {
    const { GISystem, installAsyncComputePipelines } = await import("./GISystem.js");
    const system = new GISystem(engine);
    // ── INSTALL THE ASYNC COMPUTE PATH AT RENDERER TIME, NOT AT GI'S FIRST
    // TICK (zero-freeze plan unit 2.1) ─────────────────────────────────────
    // `installAsyncComputePipelines` intercepts `backend.createComputePipeline`
    // for the WHOLE renderer, not just for GI: every compute pipeline in the
    // app then compiles on the driver's threads instead of blocking the frame
    // that first dispatches it. It used to be installed from GI's own tick, so
    // on any scene where GI is still waiting for assets — or has no GI
    // component at all — nothing was intercepting, and the water module
    // compiled 41 compute pipelines synchronously inside ONE 667 ms frame
    // (freeze ledger, user's Pool scene, 2026-09-07: 1.0 MB of WGSL in one
    // block, and the water surface arriving 40 s after "Editor ready").
    // ⚠ A dispatch whose pipeline has not landed is SKIPPED and replayed when
    // it does, so a multi-pass chain can run partially for a frame or two
    // while it warms. That is the accepted trade against a multi-second
    // block; `__giAsyncComputeEarly = false` restores the old install point.
    const armAsyncCompute = () => {
      if (globalThis.__giAsyncComputeEarly === false) return;
      if (engine.renderer) installAsyncComputePipelines(engine.renderer);
    };
    armAsyncCompute();
    const offReady = engine.on("renderer-ready", armAsyncCompute);
    return {
      system,
      dispose: () => {
        offReady?.();
        system.dispose();
      },
    };
  },
};

export { GlobalIlluminationComponent };
export { ReflectionProbeComponent };
export { RayHitMode, RAY_HIT_MODE_OPTIONS, normalizeRayHitMode, rayHitModeName } from "./rayHit/RayHitConfig.js";
export { intersectRayTriangle, buildWorldTriangles, traceTrianglesExact, validateRayHits } from "./rayHit/RayHitValidator.js";
export {
  BRICK_RESOLUTION,
  BRICK_VOXEL_COUNT,
  MAX_MACRO_STEPS,
  MAX_BRICK_STEPS,
  MacroCellType,
  packMacroCellMetadata,
  unpackMacroCellMetadata,
  planHybridBrickLayout,
  buildHybridBrickWords,
  traceHybridBrickBoxesCpu,
} from "./rayHit/RayHitPacking.js";
