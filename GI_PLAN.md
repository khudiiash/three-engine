# GI Plan — path to good working GI (2026-07-16)

Goal: stable, good-looking, fully dynamic GI at 60+ fps, reached in the fewest
risky steps. Lessons paid for today are baked in as principles:

- **Direct light = shadow maps.** Exact, per-pixel, includes animated
  characters. No distance-field/voxel representation traces direct shadows —
  they are the highest-frequency signal and punish every approximation.
- **Indirect light = the existing voxel cone GI.** It works and looks good.
- **Rays = coarse proxy triangles, low-frequency consumers only.** Software
  triangle rays failed at per-pixel scale (ReSTIR attempt); they are cheap and
  safe at probe scale (~16k rays/frame vs millions).
- **Every stage ships behind a flag with a one-line revert**, verified
  visually by the user before the next stage starts.

## Stage 0 — Stabilize the baseline (done / verify)

- DF sun shadows OFF by default (`softShadows: false`) — sun and local lights
  on three's shadow maps. ✔ done
- Verify the GI-only look on the Cornell scene + a real scene: bounce colors,
  AO, emissive, sky; camera orbit and play mode.
- Fix GI-only artifacts before adding systems (known: faint cone-trace moiré
  visible on large flat surfaces in shadowed areas).
- **Done when:** scenes look correct and stable with nothing experimental on.

## Stage 1 — Proxy ray scene (done / headless-verified)

- Per-geometry ray proxy: Virtual Geometry's coarsest cluster cut where the
  asset has VG; otherwise meshopt-simplify to ~500–2000 tris at import
  (meshoptimizer is already a dependency), cached via the `.meta` pattern.
  Simplification must be topology-preserving — a hole in a proxy wall is a
  light leak.
- BLAS per proxy using the proven threaded skip-link BVH layout (preorder,
  miss links — the verified part of the deleted ReSTIR module); TLAS over
  instances, refit per frame. Rigid movers included; skinned meshes excluded
  (they are shadow-map + screen-space territory, like every engine).
- Implemented in `src/modules/gi/rayProxy.js`.
- Imported `.geom` assets now carry a content-hashed
  `.geom.meta.giRayProxy` cache; stale caches are rejected and existing assets
  fall back to a runtime build.
- Virtual Geometry exposes its coarsest complete root cut without making the
  ray scene camera-dependent.
- BLAS/TLAS/triangles/inverse instance matrices pack into one vec4-addressed
  buffer, preserving the portable eight-storage-buffer budget for Stage 2.
- Opt-in component flag: `rayProxies`. Debug view: `ray-proxies`.
- `node scripts/test-gi-ray-proxy.mjs` verifies randomized rays against brute
  force, transformed instances, moving-instance refit, import-cache use, and
  Virtual Geometry root cuts. ✔ passed
- **Done when:** BVH rays match brute-force triangle intersection in a node
  script, including transformed/moving instances. ✔ done

## Stage 2 — Probe rays on triangles (done / runtime-verified)

- Replace the world-probe tracer's voxel march with TLAS/BLAS rays
  (probesPerFrame × 64 ≈ 16k rays/frame). Shade hits from the voxel radiance
  cache exactly as today — integration, feedback, cone gather all untouched.
- Keep the voxel march behind a flag for A/B and instant revert.
- Implemented with one packed ray-data storage buffer shared by every
  clipmap. Static topology uploads only when it changes; moving rigid
  instances refit and upload TLAS/instance records.
- Opt-in A/B flag: `triangleProbeRays` (visible when `rayProxies` is enabled).
- Headless WebGPU smoke passed with the triangle path active. Forced
  continuous-update samples at 640×360 measured essentially the same probe
  cost as the voxel fallback (~0.5–0.6 ms in the smoke scene).
- **Done when:** no light leaks through thin walls/closed rooms, stable under
  camera orbit (object-anchored proxies cannot realign), GPU delta < ~0.5 ms.

## Stage 3 — Quality passes (independent, in value order)

1. **Probe visibility** using the same rays — leak-resistant multi-bounce
   feedback (replaces the two heuristic occupancy taps). ✔ implemented;
   visual verification pending.
2. **PCSS** on the sun's shadow map — contact-hardening "area sun" look;
   characters included for free. ✔ implemented as the directional light's
   `PCSSShadowMap` option; `Radius / Light Size` controls source size.
3. Cone-trace moiré cleanup / SSGI composition pass. ✔ deterministic
   depth/normal-aware current-frame cleanup; screen temporal reprojection was
   removed after forward/backward camera motion reproduced diagonal trails.

## Runtime stability pass — bounded Lumen-style updates (implemented)

- Direct-light voxel shadowing is split into eight spatially interleaved
  staging chunks instead of one all-volume invalidation; only a complete
  eight-chunk sweep is published to the radiance cache.
- `Lighting Response (s)` controls gradual direct/radiance convergence;
  default `0.5`.
- Cascade weights are camera-distance based, not grid-origin based.
- A recenter fades the old cascade into its parent, builds direct/radiance
  against a staging origin, atomically publishes, then fades the new cascade
  back in.
- Radiance RGB and voxel opacity accumulate together, so GI and AO share the
  same world-space response without screen history.
- One clipmap volume receives maintenance per frame.
- Global JFA/SDF generation was removed from GI injection. Bounded voxel
  visibility supplies indirect shadowing without two vec4 seed volumes and
  roughly ten extra compute pipelines per cascade.
- Automatic coverage is capped to three useful cascades / 128 m reach; the
  editor camera's 2000 m far plane no longer creates unused GI volumes.
- Rebuild teardown now disposes old compute graphs, storage buffers, and
  shared optional buffers instead of relying on delayed garbage collection.
- Viewport aspect changes use stable coverage buckets, avoiding repeated GI
  reallocations during dock resizing.
- Experimental per-mesh DF shadow baking is dormant unless explicitly
  enabled.
- Moving objects stay dynamically voxelized until their settled pose finishes
  baking into every static cascade, eliminating the AO disappear/reappear
  transition. Motion polling is two frames; the settle delay remains about one
  second.
- Sampled surface radiance now receives the required radiance-to-irradiance
  `PI` conversion, and 60-degree diffuse cones cover wall-to-floor/ceiling
  first-bounce transport.
- Incident-light visibility uses conservative voxel DDA instead of fixed
  samples, so thin blockers produce a real first-bounce intensity difference.
  Voxel normals retain FrontSide/BackSide/DoubleSide material orientation so
  GI injection matches the visibly lit surface.
- GI light selection follows effective scene visibility instead of retaining
  a hidden cached directional light. The packed direct cache uses RGBE8 and
  punctual attenuation matches Three, preserving both low reflected energy
  and bright near-field bounce without additional memory.
- Emissive meshes publish a separate shadowed receiver-irradiance cache.
  Visible surfaces sample this world-space cache directly, so area emission
  lights floors/walls and produces voxel-stable occluder shadows without
  double-counting analytic raster lights. The combined deferred shader reads
  one such storage buffer per cascade, staying below WebGPU's portable
  eight-storage-buffer per-stage limit. Receiver values use world-space
  trilinear reconstruction rather than exposing nearest-voxel squares.
- Emissive proxies use one centre-weighted and four stable off-centre samples
  over an oriented rectangular mesh face. The centre ray catches axial
  blockers that a pure 2x2 pattern can miss; the other rays retain soft
  partial-area shadows. Receiver lookup selects normal-aligned occupied
  support rather than the brightest nearby voxel, preserving shadowed black
  cache values. Completed targets feed a separate exponential world-space
  cache so direct emissive lighting never republishes as sudden spatial
  patches.
- Voxel debug reads the live composited GPU occupancy and displays separated,
  uniformly sampled markers. It no longer turns surface shells into apparent
  solid slabs or cuts the visualization at the first 60k linear cells.
- Sky contribution requires a cone to prove that it escaped the clipmap;
  exhausting the trace budget no longer illuminates sealed rooms. Opaque-wall
  extinction is strengthened for the sky lobe, and minimum trace budgets reach
  the default cascade boundary. Emissive shadow rays test non-emissive
  geometry all the way to the source and ignore only the emitter's endpoint
  voxel, preventing nearby ceilings from being skipped.
- GI automatically enables/restores shadow maps for active directional,
  point, and spot lights, preventing Three's raster-direct term from bypassing
  voxel visibility in sealed rooms. The deferred receiver prepass is
  double-sided and explicitly clears its depth/normal target every frame, so
  newly visible or back-facing objects receive GI without requiring camera
  motion.
- Lit material pipelines are invalidated when the custom GI light enters or
  leaves the scene, preventing pre-GI render bundles from remaining solid
  until camera movement. Default-on exact emissive visibility uses one
  triangle-proxy centre ray against the receiver-facing panel surface to gate
  ceilings/backing that share the source voxel; normal area occlusion remains
  on the cheaper five-sample voxel path. Its ray-buffer upload is independent
  of the experimental triangle-probe flags; those flags only select probe
  transport. A `gi-only` full-screen debug view isolates the resolved GI
  contribution.
- Triangle proxy traversal is inner-cascade only. Outer cascades share compact
  32-cubed/four-axis layouts, the ray-proxy cache is bounded, TLAS refits are
  in-place, light discovery is cached, and teardown clears retained scene
  references.
- Empty voxels carry a boundary-connectivity bit in the packed normal buffer.
  Sealed components no longer receive sky on probe/cone misses; opening a wall
  merges the interior with exterior space and enables directional sky through
  the opening without waiting for a cone to reach the clipmap boundary.
  Emissive source signatures also invalidate baked emissive voxels when
  emission is changed or disabled.
- Probe history is validity-gated on first publication, and effective
  hysteresis is capped during finite convergence windows. A configured value
  such as `0.97` therefore remains useful for steady-state stability without
  leaving initial objects black or retaining most of the old lighting after a
  wall/light edit.

## Stage 4 — Screen-probe final gather (gated, not scheduled)

The "Lumen look" stage: half-res screen probes tracing proxy rays, shaded
from the radiance cache. **Hard gate:** only start if GPU timestamps show
≥3 ms headroom at target resolution after Stage 3. Ray budget here is
~1–4M/frame — the scale where the last attempt died — so it must be earned
by measurements, not optimism.

## Parked — do not resume without a decision

- SDF/DF **direct** shadows (code kept, off by default).
- Per-mesh SDFs — only if Stage 4 is committed, then baked offline at import
  with winding-number signing, never runtime shell+chamfer.
- Capsule shadows — superseded by shadow maps for direct light.
- Any real-time SDF of deforming/animated geometry (no engine ships this).
- Per-pixel triangle rays for direct shadows.

## Working agreement

- Verification is the user's, visually, per stage (debug views provided);
  agent verifies by build + headless math checks only, no test suites.
- One stage in flight at a time; a stage that fails visual review gets ONE
  targeted debugging round (with instrumentation, not guesses) before being
  parked.
