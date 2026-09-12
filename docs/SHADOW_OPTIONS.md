# Shadow options, CSM repair and cached clipmap experiment

2026-09-11. Target: crisp direct shadows at a lower total frame cost, especially with **moving lights** as well as camera rotation, moving objects and foliage. The owner explicitly reiterated that cheap moving lights were an initial requirement. Current GI shadows are explicitly rejected as the solution to this request: their cost and reconstructed resolution are already unacceptable to the owner.

## Recommendation

The concrete CSM correctness repairs and an opt-in **world-aligned shadow clipmap prototype with static-caster caching** are now implemented. Clipmaps remove camera-orientation dependence and reuse static depth while moving casters update. Sparse virtual pages remain a later experiment; this implementation uses dense full-level targets.

**Decision after the live trial:** the owner likes the clipmap image but reports greater cost. The fixed-light caching result did not answer the moving-light requirement. Redundant caching overhead is repaired, but dense clipmaps still redraw each level when the sun turns; no moving-light performance advantage over matched CSM has been established. Keep this as an experimental quality option, not the declared replacement. Any next prototype must win under continuously changing light direction, with the same visible detail and geometry.

There is no verified, universally cheaper replacement for CSM on this engine's portable browser WebGPU target. Hardware ray tracing is a credible separate native-renderer direction, but browser hardware ray queries remain an open GPUWeb extension proposal; they are not a portable WebGPU facility we can enable on an RTX adapter. [GPUWeb ray tracing extension](https://github.com/gpuweb/gpuweb/issues/535)

## Options worth distinguishing

| Approach | What it can improve | Cost and limitations | Recommendation here |
|---|---|---|---|
| Correct, stable CSM | Near-camera detail with ordinary raster geometry, including alpha masks and vertex deformation | Multiple caster passes; cascade transitions and finite texel density remain | Repair now; use as the measured baseline |
| World-aligned, cached shadow clipmaps | Fixed light-space texel density and coverage independent of camera orientation; static maps can survive a camera turn | Dense levels cover behind the viewer as well; moving the viewer across an origin cell or changing the sun still costs work | First distinct prototype |
| Sparse virtual shadow maps | Spend fine shadow texels on visible receivers; preserve unchanged pages | Page allocation, caster binning and invalidation require substantial renderer work; moving foliage and the sun can erase savings | Best longer-term raster candidate, conditional on measurements |
| Full-resolution hard software ray shadows | Triangle-defined edges without cascade boundaries | We already trace software BVHs; millions of visibility queries, acceleration updates and alpha handling still cost money | Only a bounded optimization experiment, no claimed replacement win |
| Hardware ray shadows | Geometry-defined hard edges and sampled area-light shadows | A native DXR/Vulkan ray-query path plus acceleration structures; moving/deforming geometry and denoising still have costs | Separate platform decision |
| Short screen-space contact shadows | Fine local contacts using the depth buffer | Cannot see offscreen/hidden casters; view-dependent failures are especially relevant to the reported rotation problem | Optional supplement after the baseline is correct |
| SDF/voxel shadows | Broad, soft distant shadowing | Representation error loses thin features; not a way to get crisp railings and leaves | Does not answer this request |
| Baked visibility/lightmaps | Very low recurring cost for static lighting and static receivers | Limited to authored/static lighting; moving objects require another method | Useful only for scenes that accept the restriction |

Epic's virtual maps use demand-allocated pages and cache unchanged content. Its documentation explicitly warns that moving lights invalidate their pages, deformation invalidates affected regions, and the implementation is designed around Nanite. Our engine has no equivalent cluster rasterizer, so transplanting that headline feature does not establish a performance win. Here “virtual shadow maps” is distinct from Three's `VSMShadowMap`, which means **variance** shadow maps. [Epic virtual shadow maps](https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine)

Screen-space contact rays only traverse recorded screen depth; longer rays also become noisier at a fixed sample count. They cannot be the sole world-shadow source. [Epic contact shadows](https://dev.epicgames.com/documentation/en-us/unreal-engine/contact-shadows-in-unreal-engine)

Distance-field shadows are explicitly a soft-shadow technique and inherit the representation's limitations. They are relevant to far-distance coverage, not a promise of sharp sub-voxel silhouettes. [Epic distance-field shadows](https://dev.epicgames.com/documentation/en-us/unreal-engine/distance-field-soft-shadows-in-unreal-engine)

## What the engine already does

- `src/engine/components/LightComponent.js`: map and GI ownership, CSM splits, per-cascade bias/filter parameters. Defaults are four 2048² cascades with 1000 units of coverage when CSM is enabled. Each cascade is a real additional raster pass.
- `src/engine/shadowFreeze.js`: freezes unchanged maps, including CSM's lightweight cascade objects. Content invalidation is shared across all cascades. A deforming mesh currently disables freezing globally, including deformation outside a particular cascade. Local invalidation/static separation would be new work.
- `src/engine/shadowMerge.js`: optional shadow-caster merging already exists. “Batch shadow casters” alone is not a new architecture.
- `src/engine/pcssShadowFilter.js`: contact-hardening filtering already exists. PCSS changes the softness model and adds lookups; it does not recover absent shadow-map detail.
- `src/modules/gi/GISystem.js`: GI direct shadows already intersect static triangle BVHs plus dynamic analytic/BVH objects. Calling a proposed feature “software ray-traced shadows” does not make it a different implementation.

The GI screen-size code records a **historical** Sponza measurement of full-resolution shadows at 16.4 ms of a 31.6 ms frame. It sets shadow scale to 0.5 for low/medium/ultra and 0.7071 for high; `giScreen.js` additionally checkerboards tracing. These numbers are repository evidence, not fresh measurements in this session. Geometry-guided upsampling can retain receiver boundaries but cannot reconstruct an unsampled thin shadow crossing a flat floor. Increasing this budget directly revisits the cost the user is rejecting.

GI also simplifies eligible static meshes by default and uses proxies for some animated geometry. Its visibility query does not perform alpha-texture cutout tests. Raising screen resolution alone would not establish raster-equivalent coverage for leaves, fine wires or skinned silhouettes.

## CSM findings and repair scope

The installed Three CSM implementation combines the view camera's world matrix with the source light/target's local positions, then stores computed world-space cascade positions beneath the source light's parent. Our directional lights normally live beneath rotated entities. This applies incompatible coordinate spaces to the cascade fit. An isolated reproduction with installed Three retained all 32 cascade corners under an identity parent, but clipped corners under a normally tilted light entity; a 69-degree camera yaw pushed intended near-cascade coverage to NDC magnitude 1.542, outside the map's [-1, 1] range.

The engine also called `updateFrustums()` every pre-render. That recomputed projection-derived split data even when only the camera pose changed, but did **not** position cascade lights. Three positioned those during rendering, after `ShadowFreezeSystem.update()` had fingerprinted the previous poses. A cache needs the transforms for the frame it is about to render.

The repair is an engine-owned CSM subclass in `src/engine/csmShadowNode.js`: fit with world-space light data, convert output positions to the actual parent space, refresh cascade matrices before the freeze decision, and recompute split/frustum data only when projection/settings change. It retains Three's shading, cascade blending and existing geometry/material paths. Supplied custom/off-axis projection matrices also survive initialization and subsequent preparations.

Validation completed on the installed Three/WebGPU renderer:

| Gate | Result |
|---|---|
| `npm run test:csm` | Seven CPU regressions passed, including 72 view poses, custom projection retention, first-frame invalidation and old-code negative controls |
| Existing light-in-place and shadow-freeze suites | Passed |
| Parented vs equivalent world light, real rendered RGB | Identical: zero differing bytes |
| Stationary cache vs forced redraw | Identical pixels; 0 shadow draws while held vs 12 forced draws across three maps |
| First frame after three camera yaw changes vs forced fresh maps | Identical pixels for all three; 11/12/11 shadow draws occurred immediately |
| GPU `?old=1` negative control | Failed parent equivalence: 142 pixels differed by more than two channel values |
| GI GPU smoke | `GI-SMOKE PASS storage=8`; no validation errors. This smoke arm compiles SRC out and does not measure ray traversal performance |
| Production build | `npm run build` passed; reported browser externalization, mixed-import and large-chunk warnings |

The GPU fixture is `scripts/csm-gpu-smoke.html`, exposed as `npm run smoke:csm` against the existing Vite on `localhost:1420`. The server in this session bound IPv6 loopback, so `localhost` was used rather than `127.0.0.1`. Chrome used a fresh temporary profile outside the workspace. Each run verified the live editor reported `loopActive: false` while isolated and restored it afterward. Detailed local receipts: `.gi-shots/shadow-audit/fixed.log`, `old.log`, and `gi.log`.

The 0-vs-12 result validates that the existing freeze still saves real work after the repair; it is **not** a new 12-draw improvement over the previous stationary implementation. The demonstrated CPU saving is avoiding split/bounds reconstruction during unchanged-projection camera motion. No whole-scene FPS gain is claimed.

This workspace's `.no-hmr` sentinel leaves the running editor on its current code until a reload. Reload the editor to pick up the repair; no scene settings or saved light parameters were changed.

This addresses reproduced defects. It does not eliminate CSM's multiple draws or prove that every reported rotation artifact shares this cause. Cascade selection can still cross a resolution boundary as the camera turns. The installed Three implementation already has rotation-independent XY extents and texel snapping; blindly adding “stable cascades” would duplicate part of its existing behavior. Stable projections are a known quality-versus-coverage tradeoff. [MJP's shadow technique sample](https://mynameismjp.wordpress.com/2013/09/10/shadow-maps/)

## Implemented experiment: world-aligned cached clipmaps

### Trying it in the editor

Reload the editor to load the new code (`.no-hmr` is present in this workspace). Select a directional light, enable Cast Shadow and choose **Shadow Source → clipmap**. Existing scenes keep their authored mode until changed. Switch back to **map** to compare with the repaired CSM path.

Start with three levels, Near Coverage 20, Level Scale 4, and 1024² or 2048² maps. The full square widths are 20, 80 and 320 world units. At 2048², the finest level has about 0.98 cm per texel; at 1024², about 1.95 cm. Near Coverage is a width centered around camera position in light space, not a camera-depth cutoff. Lower Radius / Light Size for harder edges; filtering cannot recover missing texel detail.

**Cache Static Casters** enables the static/moving split. Turning it off provides the same clipmap coverage with whole-scene refreshes when content changes. Both modes still reuse a complete unchanged map during pure camera rotation. Depth Padding extends coverage along the light direction to include offscreen blockers; the shadow camera far distance is extended to at least the largest level width plus twice this padding.

### Cache and resource contract

`clipmapShadowNode.js` owns fixed-width levels and blends visibility by world-space coverage. It skips coarser coordinate/coverage calculations once a finer level covers the pixel. `clipmapShadowCache.js` classifies visible casters once per frame per light only when a level can reuse its projection. Matrices, buffer versions, material/alpha/texture state and hierarchy changes invalidate content. Objects with observed transform/vertex motion stay in the moving set; ordinary asset/material swaps refresh the static capture. Unknown callbacks, shader animation, skinned/morphed meshes and GPU simulations remain conservatively dynamic.

Each level samples one native Three shadow map. A changed projection, including the first render or rotating sun, uses **one native full-scene render**, with no static classification, retained target allocation or texture copies; a cheap membership prune releases removed casters. Static-only scenes also use full-map holds without allocating a split cache. For stable mixed scenes, static depth is retained and restored before overlaying native moving-caster draws without clearing. Color is retained/copied only when transmitted shadows require it. Static and moving geometry render into the same native target/context, preserving alpha masks, deformation and normal depth testing. No extra static/dynamic shadow samples or storage buffers are added to receiving shaders. GI receives the same combined depth maps through the existing `giShadowMaps()` contract.

Only complete native renders become cache receipts. Async pipeline deferral, skipped builds and parked predecessor draws invalidate the receipt, so boot or material recompilation cannot permanently cache missing or obsolete geometry. ShadowFreeze leaves these level maps to their own cache owner.

Stable mixed scenes trade memory and texture-copy bandwidth for raster work: three retained 2048² depth maps add approximately 48 MiB beyond the ordinary combined maps (12 MiB at 1024²), before driver overhead. Transmitted shadows additionally retain RGBA8, doubling those amounts. Stable moving-caster frames can restore that much texture data; each texture copy also submits a command buffer in the installed Three backend. Moving lights release retained caches and pay no such copies. Levels crossing a snapped origin or changing sun direction still rasterize their full contents; scrolling strips, per-page updates and local dirty rectangles are not implemented. Dense coverage also spends texels behind the viewer. Variance shadow maps and non-WebGPU backends use the native full-render fallback; the split-cache experiment is intended for WebGPU PCF/PCSS.

### Verified prototype results

The real GPU fixture uses the production LightComponent and ShadowFreeze with three 1024² maps and a 386×256 output. CSM uses the same casters, camera path, light, filter and map count/size, but its frustum coverage policy differs. This measures reuse and correctness, not matched edge density at every receiver or whole-scene FPS.

| Check | Result |
|---|---|
| Eight pure camera-yaw frames | Clipmaps 0 shadow draws; repaired CSM 124 |
| Stationary/yaw vs forced freshly rasterized clipmaps | Exact RGB parity |
| Second moving-box translation | Cached 2 shadow draws, only the mover; uncached 14; exact RGB parity |
| Camera translation, first caster motion and sun rotation | Immediate refresh, exact fresh-render parity |
| Offscreen blocker | 1,460 visible pixels changed when its casting was disabled |
| Alpha cutout texture mutation/restoration | 1,730 pixels changed; immediate fresh-render parity; exact restoration |
| Uniform-driven GPU vertex deformation | 1,635 shadow pixels changed; exact uncached parity |
| Actual two-bone skeletal deformation | 466 shadow pixels changed; exact uncached parity |
| `?cache=0` negative control | Fails the moving-only draw assertion: 14 instead of 2 draws |
| Four continuously rotating sun frames after the repair | Exactly one actual native shadow render per level, zero texture-copy calls, zero split captures; exact uncached pixel parity |
| Initial render / changed all-static origin | One render per level, zero copies, no retained cache allocation |
| Stable opaque moving-caster frames | Only depth is copied, one copy per level; same exact pixel parity |
| CPU regressions | 35 clipmap tests, 7 CSM tests, 11 light lifecycle tests and ShadowFreeze suite pass |
| Production build | `npm run build` passes after the moving-light repair (1m 56s); existing browser-externalization, mixed-import and large-chunk warnings |

The deliberately disabled static split is a full-scene raster oracle; first-time mover promotion is allowed to rebuild static content once, while subsequent movement must draw only movers. Instrumentation counts actual backend draws and does not attach caster callbacks, which would change the cache classification. GPU timestamp readings in this tiny fixture are diagnostics, not a frame-time speedup claim: texture copies and CPU invalidation cost must also be measured in a representative scene.

Local detailed receipts are under `.gi-shots/clipmap-audit/`. CPU regressions run with `npm run test:clipmap`; GPU uses `npm run smoke:clipmap` with the live engine isolated. No real-scene FPS improvement is claimed yet.

The standard GI smoke separately passes `storage=8` with SRC compiled out. The new `scripts/gi-gpu-smoke.html?clipmap=1` arm defaults to `src=1&mode=hybrid-plane` and **passes on the eight-buffer device**: three completed 512² maps, three native clipmap WGSL modules, four bound GI texture consumers per level, and actual production GI visibility samples `[0, 1, -1]` for shadowed/lit/uncovered points. Explicitly opting that arm out of hit shading is rejected at boot. This is a clipmap integration and composed-binding gate, not a transport-convergence test.

An attempted full SRC numerical run first timed out polling ray counters, then a longer run progressed and failed its tile-accounting assertion: 36,160 baked texels versus 46,336 currently owned. The legacy fixture stops its engine before the later polling loop, so zero counters cannot recover there; population and transport/bake also have independent update cadences and those snapshots can refer to different generations. No SRC transport implementation or legacy numerical assertion was changed for this shadow experiment; the full SRC numerical run is not claimed to pass. The dedicated clipmap arm retains shader/binding validation, completed native/GI map identity checks and a real production visibility query while leaving the convergence suite to `?src=1&mode=hybrid-plane`.

### Live moving-light investigation

The user's live Sponza scene has three 2048² clipmap levels and `Rotator.ts` on the directional light with Run In Editor enabled (180-second cycle). The source rotates every frame: static shadow-map reuse cannot survive even while the camera is parked. Before the repair, all three levels drew 36 casters / 317,611 triangles per level while also doing split-cache work. The retained color/depth caches occupied 96 MiB. This was an implementation penalty on top of the three raster maps, not useful cached work.

The initial live capture reported 12.16 ms CPU per frame, including 5.87 ms render encoding, versus 5.76 ms GPU overall; the render-side GPU reading was about 1.3 ms and GI compute dominated the GPU remainder. Thus CPU submission/traversal deserves priority. Temporarily toggling the original cache did not establish a reliable FPS improvement: both short windows reported 68 fps, and the on-window CPU mean contained a large outlier. Camera position matched, but animated light, cloth/GI state and user selection remain sources of variation. Both settings were restored.

An independent live test of the engine's existing shadow-caster merging reduced shadow draws **108 → 60** (36 → 20 per level), with per-level triangle counts unchanged. The capture reported 96 fps / 9.11 ms CPU, but this is not a controlled same-pose frame-time comparison, and the same batching improvement applies to CSM. The original `performance.shadowMerging: false` was restored afterward. Receipts: `live-current.json`, `live-cache-ab.json`, `live-batching-ab.json` under `.gi-shots/clipmap-audit/`.

Command reuse could reduce moving-light CPU submission further, but the existing color render-bundle switch is not a safe shadow-bundle implementation. Native bundles reuse first-record culling despite changing camera poses, and their replay skips the renderer's per-source shadow override setup; a real Node-level check showed alpha thresholds 0.75/0.20 replaying as 0.20/0.20 through the shared override. A dedicated shadow bundle would need correct membership, per-source alpha/deformation bindings and complete asynchronous recording. This is unimplemented research, not an available fix.

### Design rationale and later work

Use a light-oriented basis and nested square coverage centered on the viewer's **position**, independent of viewing direction. Select the finest level containing the receiver in light space, with overlap at the boundary. Camera yaw/pitch should leave static map data and texel density unchanged. This requires a different coverage/selection policy; it is not just changing the CSM split lambda.

Three 2048² levels spanning 20, 80 and 320 world units correspond to approximately 1, 4 and 16 cm per texel. These are the opt-in prototype's starting coverage parameters and are unsuitable for every scene. A 2048² map cannot represent one-centimeter detail over a kilometer regardless of its name.

The prototype caches static depth separately from animated casters and combines depth before lookup. Updating only affected regions is future work. Preserve offscreen casters that project into visible receivers. Correct invalidation must cover caster movement/removal, alpha/material changes, instance repacking, foliage wind, skinning, cloth, water, sun motion and device replacement. The native deformation path is retained; a generic GPU deformation regression is not an exhaustive foliage/cloth/water validation.

Prototype full-level updates first. Measure whether orientation-independent reuse pays for the extra area covered. Incremental scrolling strips and sparse pages come next only if needed. In WebGPU, virtual pages can be represented by an atlas/page table; this does not require hardware sparse textures, but efficient per-page caster selection/raster submission still needs implementation. A naive draw of the whole scene for each page can be much worse than CSM.

For large moving populations, per-level culling and separate static caching may pay more than finer pages. For a constantly rotating sun, all directional cache strategies must account for frequent invalidation; no stale-map update staggering should be accepted as a free optimization.

## Bounded ray experiment, if pursued later

For an exactly hard light, trace one full-resolution Boolean visibility ray with early exit at the first blocker, bypassing soft-shadow blocker-distance work and temporal reconstruction. The current static traversal accepts an `anyHit` argument but still preserves closest-blocker behavior, including in the SBV2 path. An actual early exit could reduce traversal cost; it is a hypothesis to measure, not an alternative already known to beat CSM.

Keep the existing closest-hit traversal for penumbra estimation and GI transport. AMD's hybrid example demonstrates classification and interval reduction to avoid some ray work, but it uses hardware ray tracing; its performance is not transferable to a WebGPU software traversal. [AMD Hybrid Shadows](https://gpuopen.com/fidelityfx-hybrid-shadows/)

## Acceptance and measurement

Use identical camera paths, output size, source geometry, alpha masks, light direction and softness. Compare complete frame GPU/CPU times, shadow pass draws/triangles, cache hit/invalidated area, memory, and visible edge quality. Do not compare a soft or half-resolution result to crisp full-resolution CSM and label that a speedup.

Required cases: parked scene; pure yaw/pitch; translation through coverage boundaries; offscreen caster; moving caster; animated foliage; skinning/cloth; slowly rotating sun; abrupt camera change. On a static scene under pure camera rotation, inspect shadow edges in world space as well as the image. Reprojection or flat-floor world sample comparisons distinguish changed viewpoint from an actually moving shadow.

Serialize GPU runs and stop the live engine loop with `profile.gpuIsolation`; suspension of simulation alone is insufficient. Use the existing Vite when it can serve the fresh module graph, with an isolated Chrome profile outside the workspace. Any later GI/TSL sampling change must also pass `scripts/gi-gpu-smoke.html` on the portable eight-storage-buffer device limit.
