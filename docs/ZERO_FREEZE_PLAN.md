# ZERO-FREEZE DEVELOPMENT FLOW — the audit and the plan (2026-09-07)

The user's mandate: *"each editor boot is a 10–120 s freeze… I don't
understand what we're doing wrong that our materials compile for such an
enormous time… GI is super long to boot… clicking an entity can be a 10 s
freeze… changing a param freezes again. I spend more time waiting than
developing. Audit, then fix performance in all ways possible: nearly
instant load, zero freezes."*

§1–§3 are the audit (what freezes, why, with receipts and file:line). §4–§6
are the plan (stages, units, gates). §7 is the ledger; receipts land there
as units ship, the way `GI_SCALE_PLAN.md` does it.

---

## 0. THE VERDICT IN ONE PARAGRAPH

The editor freezes because **work that belongs off the frame runs
synchronously inside the render frame or on the click's own stack**, and
because **the engine rebuilds where it should update**. Four mechanisms
account for nearly all of it. (1) Every lit material carries the whole GI
consumer (irradiance bilateral, reflection cascades, probe loop, prefilter,
mirror trace, per-hit direct lighting, emitter glow) — and on a water scene
the whole water medium — compiled INTO its fragment program, so a material
is 91 kB of WGSL (27 kB without GI; 327 kB before the probe loop was rolled;
362 kB with the water medium before its loop) that costs ~100 ms of
main-thread TSL codegen and seconds of driver compile, and a Bistro-class
scene walks 164–172 such variants per wave, twice when postprocessing is on.
(2) A GI build is ONE synchronous call inside a preRender callback (scene
walk, SAH BVH over every static triangle, graph construction for ~70
kernels) and it is triggered by things that should not rebuild anything (a
GI toggle, a pool grow, a resize rung, a renderer setting, a scene switch);
when the material-light "shape" moves, the whole node-graph cache is purged
and every material rebuilds. (3) A single property edit emits
`hierarchy-changed` — for EVERY prop of EVERY component — to ~20 listeners
that each walk the scene, and a number-field drag does that per pointer
event. (4) Selection walks the scene twice, builds a synchronous
edge-geometry over every triangle under an entity with an enabled
surface-derived collider, re-renders whole hierarchy subtrees with prefab
diffs, and compiles mask pipelines inside the frame on first sight.
Underneath all four: the browser's pipeline cache is small and our shader
text is not stable across boots, so most boots are cold; and **nothing in
the editor records a freeze** — every one so far was reconstructed after
the fact.

The plan, ordered by yield per unit of work: **Stage 0** an always-on
freeze ledger so every freeze the user feels has a row with an owner;
**Stage 1** stop the storms (edits become writes, listeners subscribe to
what they need); **Stage 2** no synchronous shader/pipeline work inside a
frame, ever, and the GI consumer out of the material (deferred specular →
materials back to ~27–40 kB); **Stage 3** cache, don't rebuild (kernel text
stable so the existing content-keyed cache hits, rebuilds that keep what is
unchanged, no device loss for settings, shader text stable across boots so
the browser cache serves it); **Stage 4** boot off the main thread (BVH in a
worker, one parse, time-sliced instantiation, a rebuild that yields);
**Stage 5** selection made O(selection). Targets in §5.

---

## 1. WHAT "FREEZE" MEANS HERE — three classes, told apart by their receipts

| class | what the user feels | the receipt that names it | what it is NOT |
|---|---|---|---|
| **A. main-thread block** | the whole app stops: no cursor feedback in panels, no typing, no frame | a `longtask` entry (PerformanceObserver) with a JS attribution; `profile.spikeWatch` frames whose CPU phases explain the frame | the GPU |
| **B. swap-chain block** | the frame stops but panels still respond a little; a JS profile reads "(idle)" | `queue.onSubmittedWorkDone` latency per submit (`probe:gi-boot-frames`' GPU-done column); a longtask with ~0 % inside any wrapped WebGPU call | JS |
| **C. absence / ghost** | meshes blink out and come back; GI holds an old picture that slides with the camera | `drawCalls` dips in `profile.frameStats`; `SLOWEST PIPELINE` lines; `giRebuilds.log`; `first diffuse gather dispatched N ms after build` | a freeze at all — the frame runs, the content is late |

The four complaints map as: boot = A (+ B at the first lit frame + C for
the wave); clicking an entity = A; changing a param = A (the fan-out) and C
(a rebuild's compile flood); "materials compile for an enormous time" = A
(TSL codegen per material) + C (the driver's single compile queue).

Rules inherited from the GI ledgers and kept here: read the GPU-done column
before blaming JS; a milestone that gates on a SET of async things is named
by its slowest member; no boot number beside another compiling WebGPU
process is comparable; a perf unit that touches the shadow term, the light
transform or the g-buffer resolution needs a LOOK receipt before it ships
(scale plan §11.47); clear `gi.devFlags.v1` before judging anything
(`__giStaticDraws=true`, `__giWorldIdle=false`, `__giGatherNormalBiasLive=0`,
`__giGatherSmoothLive=0` are armed in this editor right now).

---

## 2. THE AUDIT — receipts

### 2.1 Live editor today (Pool scene: 181 entities, 92 materials, 248 draws, GI medium + water)

Two boots read from the editor's own console, 12 minutes apart:

| boot | bridge up | "Editor ready" | first water material bound (its compile landed) | water body / physical variants | physics storm |
|---|---|---|---|---|---|
| 12:36 | 0 s | +6.6 s | +44 s | +47 s | — |
| 12:48 | 0 s | +6.5 s | +40.6 s | +58 s | +65 s: `[engine] hierarchy-changed storm: 30 flushes within a second` from `PhysicsSystem #flushDefaultColliders` |

On a **small** scene the editor is usable at ~6.5 s and the water surface
appears at ~40–60 s. The interval is a material wave: the water medium is
armed on `scene.fogNode` (`[water] medium armed on scene.fogNode — 92 scene
materials`), so every material in the scene is re-minted (WATER_PLAN trap
20: a floor material read 362 kB of fragment WGSL, "10–15 s freezes on every
minted material", cut to ~50 kB by a GPU loop + `compileShape`, still one
program per material). No `[gi] built` line appears in either boot although
the Pool entity carries an enabled GI component (quality medium) — the GI
build never ran on this scene in this session (Stage 0 gate 3 owns the
explanation).

Parked frame (`profile.cpuFrame`, 120 frames): CPU 9.9 ms (renderEncode 8.1
= draw 6.2 + project 1.9), GPU 3.6 ms, 98 fps, heap 0.98 GB.

Selecting one Box (`profile.spikeWatch` 10 s, threshold 30 ms, viewport
unfrozen for the read): **46 of 499 frames ≥ 30 ms, worst 53.5 ms**, all in
`renderEncode` (draw 26–30 ms against 6 ms parked) for the ~2 s after the
click, GPU steady at 4.6 ms → the selection outline's mask pass and the
panel re-renders, not the GPU. A stutter here; on a heavy scene the same
mechanisms are the seconds (§2.3).

Harness note: `run-boot-diag.mjs` against the GAME project died at project
open ("Attempted to use detached Frame"), the same failure the Bistro walk
hit; the harness cannot open the user's project today (Stage 0.4).

### 2.2 Boot — where a boot's time goes (code map + history)

The path (file:line from the boot audit):

1. **App entry → project open** (`src/main.jsx`, `startupReopen.js`,
   `projectStore.js:95-127`): cheap.
2. **Engine import + construction** (`engineInstance.js:50-66`): one
   main-thread evaluation of `three/webgpu` and every component module.
3. **Renderer** (`ViewportPanel.jsx:296-300` → `Engine.js:845-892`):
   `peekBootRendererSettings` parses `project.json` AND the scene file just
   to read `settings.renderer` (`sceneIO.js:137-167`), because
   `antialias/samples` are frozen at construction; the scene is parsed AGAIN
   at `sceneIO.js:212`.
4. **Frames start before the scene exists** (`engine.start()`,
   `ViewportPanel.jsx:509`).
5. **Scene open** (`sceneIO.js:186-232` → `serialize.js:272-321`): the bulk
   asset read is adopted on the main thread (`assetLoader.js:487`); `.geom`
   decode on the main thread (`geometryAsset.js:377-441`);
   `for … instantiateEntity` **with no yield** (`serialize.js:299-301`);
   await every mesh/model; `waitForTextureAssets()` (16 ms poll, 15 s cap)
   before the one `hierarchy-changed`.
6. **GI build** (`GISystem.js:13106-14210`, called from `#tick` inside a
   preRender callback): **fully synchronous, zero yields** —
   `#dispose(preserveMaterialLight)`, `#collectMeshes` (per material
   `#markObservedMaterial` + `#refreshMirrorBucket`), auto-fit (another
   `updateMatrixWorld(true)`), `#buildOccupancyField` → `#staticBvhItems`
   (meshoptimizer simplify per placement, WASM, main thread) →
   `#buildStaticBvhPacked` (SAH BVH8 over every static triangle on the main
   thread unless the session WeakRef cache or the disk artifact hits),
   `makeField` allocations, albedo atlas (canvas), `createDynamicObjectSet`,
   `#buildEntries`, light tree, `#buildLightShadow` + `#buildScreenResolve`
   (TSL graph construction for the whole screen chain and the SRC probe
   store, ~70 kernels as nodes), `#syncSlots`, `#syncBvhScene` (one
   `MeshBVH` per unique geometry), then `#compileWave` (not awaited).
   `[gi] built … setup N ms` measures only from step "field" on.
7. **Compile wave** (`GISystem.js:5785-6620`): (a) `traverseVisible` +
   `giCompileVariantKey` — keyed on **`material.uuid`**, not the program key,
   so two stock materials that share one program are walked twice (this is
   the "164–167 unique material variants" line); (b) per variant
   `renderer.compileAsync(object …)` — the per-object cost is the TSL
   node-graph build + WGSL codegen (~80–110 ms per lit variant, `B:` rows of
   `probe:camera-motion`), plus `createShaderModule` of 180–250 kB, not
   interruptible; the loop yields only BETWEEN objects (40 ms budget); one
   3 282 ms task was measured inside a wave whose log said "viewport
   remained live" (`GISystem.js:6022-6025`); (c) the prewarm loop builds
   ~50–80 compute kernels (sync TSL build each, 8 ms budget); (d) the driver
   compiles everything in ONE serialized queue — a Cornell boot read
   `materials warmed safely in 93 780 ms` for SIX variants and every 2 kB
   kernel behind them "took" 93 s (§11.18).
8. **First lit frame**: the transport's first trace is ~2 s of GPU in one
   submit; `occ.readbackStats` maps a buffer (1 077 ms on Sponza,
   `GISystem.js:12716`) to print a voxel count.

Historical receipts (memory/ledgers, quoted for scale):

| scene | number | source |
|---|---|---|
| Level (harness, ultra) | lit at 12.6–13.5 s after open, ~80 frames > 40 ms, **~12.5 s of stall**; `__giOff` still 4.1 s of stall | scale plan §9.2 |
| Level | first paint 1.1–1.2 s = 28 SYNC `createRenderPipeline` → 386 ms with `asyncRenderPipelines` (≥ 16 kB only) | §9.2 |
| Level | material fragment **27 kB without GI, 91 kB with** (327 kB before the probe loop); wave 13 s harness / 29 s editor | [[gi-boot-freeze-ledger-0902]] |
| Bistro | **323 pipelines / 155 s wave** + a concurrent second wave 256 / 168 s; bvhHitShade 110 s; 79 kernels = 1 468 kB WGSL; materials 27 s; heap 6.7 GB | [[gi-bistro-baseline-0826]] |
| Bistro | material wave **44–60 s on its own** (172 variants × 91 kB); a GI rebuild re-walks all of them | scale plan §10 |
| Bistro | a rebuild's screen kernels landed **35–51 s** behind the flood (a clean boot compiles the same kernels in 3.4 s) | [[gi-ghost-held-picture-and-async-pipeline-absence]] |
| Sponza | a pool grow = **68-kernel recompile, 73 s** behind the live store; every rebuild = a cold field | [[gi-probe-memory-ledger-0903]] |
| any | a GI resize = ~56 fresh pipelines + all temporal history; **427 pipelines in one session vs 79 on a clean boot** | `GISystem.js:12251` |
| warm vs cold | with byte-stable text the compute compile read **19 082 → 9 ms** (harness, persistent profile); the deposit kernel's text moved between boots by three baked offsets and never hit | [[gi-startup-budget]], `occupancyField.js:561-569` |
| scene switch | the renderer block is per scene, antialias frozen at construction → `DEVICE LOST` + full GI rebuild + every material recompiled (~40 s) | `Engine.js:527-536` |

Workers in `src/`: KTX2 transcode (three's pool), Draco (three's pool), the
static-BVH artifact CRC. **Nothing else** — scene parse, geometry decode,
entity instantiation, merge geometry, texture-array rasterisation, the SAH
BVH, the meshoptimizer simplify, all TSL codegen: main thread.

### 2.3 Clicking an entity — the chain

There is no selection event; the zustand store fans out synchronously. Per
click, in order:

| step | cost | proportional to |
|---|---|---|
| `raycaster.intersectObjects(scene.children, true)` (`ViewportPanel.jsx:1989`) — stock `Mesh.raycast`, **no BVH**, full sorted hit list | 🔴 | objects + triangles of every mesh whose bounds the ray crosses |
| `attachSingleSelection`: `object3D.updateMatrixWorld(true)` over the selected subtree; gizmo attach | 🟡 | nodes under the selection |
| `applyLayerVisibility()` + `setCollidersVisible()` (`:1318-1379`, again at `:658`) — walk `engine.entities` | 🟡 | scene entities |
| **`ColliderComponent.#buildOutline()`** (`ColliderComponent.js:244-325`, via `setDebugVisible` → `setOutlineVisible`): synchronous `EdgesGeometry` over the cooked surface or every mesh under the entity, per-vertex `Array.push` ×3; rebuilt on EVERY selection, no cache; only for an ENABLED surface-derived collider (convex/concave/mesh); the Colliders layer is ON in this project | 🔴 | **triangles under the selected entity** |
| Hierarchy: the two rows that flipped re-render **their whole expanded subtree** (`EntityRow` is not memoized); `usePrefabRowInfo → diffInstance → liveTree` serialises the prefab instance subtree per prefab row per render; the new `activeInHierarchy` ancestor walk per row; 0↔1 / 1↔2 selection re-renders the whole panel | 🔴 | expanded descendants × components × props |
| Inspector: `PrefabSection` `diffInstance` (full subtree serialise); one `read_text_file` IPC per material thumb, uncached; `EntityRefField` sorts every entity per render; the uncommitted `useModulesStore` subscription per field | 🟡 | selected subtree; material slots |
| every mounted panel re-renders (dockview never unmounts hidden tabs); `selectionStore.select` allocates a fresh `assetPaths: []` so asset panels re-render too | 🟡 | open panels |
| **first frame: `updateSelectionOutlineMask`** — 1–2 `renderer.render(scene, camera)` with an override material into an RGBA8 target; a mesh's mask pipeline (material × geometry layout × context) **compiles synchronously inside the frame on first sight**; each render is an O(scene) projection walk; `precompileSelectionOutlineMasks` warms at boot + 1 s after `hierarchy-changed` but **frustum-culls** and silently skips before the backend stamps formats | 🔴 | new geometry layouts; scene objects |
| per frame after: `gizmos.drawFrame` `selected.includes(id)` per host | 🟡 | hosts × selection |

History: first selection ≈ 90 ms hitch (mask pipeline) → 30–36 ms after the
prewarm ([[selection-outline]]); Bistro ROOT selected = 865 depth-only draws
per frame until merge proxies stood in. The "10 s" on a heavy scene is one
of: the collider outline (an enabled concave/mesh collider on a big model),
the hierarchy subtree re-render with prefab diffs, or a first-sight mask
compile flood behind a busy driver queue — Stage 0's ledger names which,
per click.

### 2.4 Changing a parameter — the fan-out

One inspector commit (`InspectorPanel.jsx:2083` → `SetComponentPropCommand`
→ `Component.setProp`, `Component.js:295`):

1. `engine.emit("component-changed")` — synchronous, uncoalesced.
2. **`engine.emit("hierarchy-changed")` — for EVERY prop of EVERY component
   type** (`Component.js:351`; `:308` on `enabled`). A boolean on a light
   and a re-parent of 5 000 entities deliver the same signal.
3. `CommandBus.#afterMutation` → `sceneStore.refresh()` (rebuilds the
   mirror of every entity with fresh object identities → every Hierarchy
   row re-renders), `markDirty`, `selection.prune` (O(scene)).
4. The coalesced flush → ~20 listeners, each O(scene): a SECOND
   `sceneStore.refresh`; `merging.invalidate` (full re-merge after 400 ms;
   `_urgent` bypasses settle AND throttle on a moved member); `shadowMerge`
   (full rebuild after 400 ms, and AGAIN whenever merging's count moves);
   `batching.invalidate` (**full regroup next frame, no settle, no
   throttle** — batching is ON by default); `OcclusionSystem`; GI
   `#queueRebakeCheck` (forces `#collectMeshes` + `#markObservedMaterial` +
   `#refreshMirrorBucket` per material on the next tick, floored 250 ms);
   `shadowFreeze` deform scan; `PhysicsSystem.prewarmAutoColliders` (walks
   all entities, queues cooks); `SceneSettingsPanel` scan; `ViewportPanel`
   outline invalidate + `setCollidersVisible` walk + 1 s mask re-warm;
   `browserPreview.schedule` → **a full `exportGame()`** 250 ms later when
   live preview is on.
5. A **NumberField drag commits on every `pointermove`**
   (`fields/NumberField.jsx:100`), each in its own task, so the microtask
   coalescer never merges any of it.

| edit | immediate | downstream | class |
|---|---|---|---|
| light intensity / colour | in-place write | the full fan-out above | uniform + O(scene) storm |
| light `kind`, `castShadow`, `shadowMode`, `csm*` | **new `THREE.Light`** (`LightComponent.js:190-203`) | three recomposes the lighting graph → **material recompile wave**; shadowMerge rebuild | recompile |
| mesh `enabled` / `castShadow` | flag | full fan-out; shadowMerge caster set | storm |
| mesh material swap | material load | `component-changed:mesh` → merging re-merge; GI fingerprint content path | merge + GI content |
| mesh geometry | reload | merge + shadowMerge + batching + GI content | rebuilds |
| mesh transform (gizmo) | nothing emitted | merging motion watch → **urgent unthrottled re-merge**; shadowMerge `caster-moved`; GI mover promote → later demote → **full static chain re-voxelize** (`GISystem.js:20083-20091`) | rebuilds |
| material colour / roughness / map (.mat) | `needsUpdate` (`materialAsset.js:671`) | non-stock graph → **new program: TSL build + pipeline**; `notifyMaterial` → every mesh re-adopts → `component-changed`; merging `material-edit` → **uber re-mint** (a compile wave on a GI scene); GI fingerprint (colour/emissive) → content rebuild; `#refreshMirrorBucket` recompiles across a roughness gate | recompile + merge + GI |
| GI `bounce` / `reflections` (non-zero) | — | `structural-props-changed` → **full GI rebuild**; the material-light SHAPE moves → `purgeNodeBuilderCache` → **every material's node graph rebuilt** (164 × ~100 ms of main-thread codegen) + the driver flood; the ghost for 35–51 s | rebuild + recompile |
| GI `ao` | — | `#refreshAoQuality` (1–3 kernels) | partial |
| renderer `antialias / samples / transparent` | — | `renderer.dispose()` → `DEVICE LOST` → GI rebuild + **every material recompiled** | everything |
| `performance.renderScale` / DPR / governor rung | swap-chain realloc | GI `resolve-resize`: SRC probe system replaced (dispatch counts baked), every GI target recreated (temporal history lost), ~56 pipelines | partial rebuild |
| `staticMerging` / `shadowMerging` / `autoBatching` toggles | — | full merge / shadowMerge / batching rebuild | rebuild |
| exposure / tone mapping / ambient / fog | direct writes | still walks `collectFreezableCasters(scene)` per settings commit | O(scene) |

GI rebuild reasons (`profile.frameStats.giRebuilds.log`): `renderer-rebuilt`,
`component-attached`, `structural-props-changed` (signature:
emissiveShadows, autoFit, quality, bounce, reflections, reflectionsQuality,
backend, rayHitMode, rayHitProfiling, rayHitSkipDistance, probe existence),
`reflection-probe-set-changed`, `dead-field-auto-retry` (opt-in),
`static-bvh-manifest-stale`, `surface-pool-resize`, `atlas-overflow-grow`,
`reflective-material-appeared`, `auto-fit-bounds-drifted`,
`manual-volume-recenter` (unreachable), `occupancy-slot-capacity`,
`skinned-mover-cap`, `dev-flag:<name>`; plus `resolve-resize` which
bypasses the gate and does the partial rebuild in place.

### 2.5 Materials — why they compile "for an enormous time"

The pipeline (from the material audit):

1. A `.mat` becomes ONE shared `MeshPhysicalNodeMaterial` per path
   (`materialAsset.js:685`). If `matchStockPbr` recognises the graph
   (`tslGraph.js:608-840`: one principledBsdf + output, ≤ 1 normal map, the
   colour-factor chain) it is expressed as PLAIN properties (`applyStockPbr`,
   `:433-513`) and shares three's stock program. Anything else goes through
   `compileShaderGraph` (`tslGraph.js:848`), which **mints fresh
   uniform/texture nodes per material**; three keys programs on node
   IDENTITY (`Node.customCacheKey() → this.id`), so structurally identical
   graph-path materials compile one program EACH.
2. GI is injected as a LIGHT: `renderer.library.addLight(GICascadeLightNode)`
   (`giLight.js:2814`). `GICascadeLightNode.setup` runs once per
   NodeBuilder, i.e. once per distinct material cache key, and generates
   the whole consumer into that material's fragment program: the 4-tap
   position-validated bilateral (emitted 2–3× per material), irradiance +
   probe fallback, AO, emitter-shadow unpack, the roughness-bucket switch,
   cascade lookups, `sampleReflectionProbes`, the 13-tap prefilter, the
   mirror trace/hit reconstruction, per-hit direct lighting (4 emitter
   traces + 4 light loops, ultra), emitter glow, sky miss. In-code size
   attribution: the probe sampler WAS 250 of 327 kB (now a `uniformArray`
   loop); the emitter glow 17 kB (now rolled); **the mirror trace + hit
   lighting block ≈ 70 % of a material's GI compile cost** (a 26-material
   wave 24 s → 7.6 s without it, `giLight.js:56-66`). The water medium adds
   its own per-material block through `scene.fogNode`.
3. Variants multiply the cost (from three's `getMaterialCacheKey`
   and ours): the GI roughness bucket ×4 (inherent — the code differs);
   `side`, blending/depth/stencil, alphaTest, attribute set, morph
   attribute IDS, skeleton bone count (inherent); **every `InstancedMesh`
   gets its own program** (three appends `object.uuid` — upstream
   accident; Instancer/Terrain hit it); **the postprocess override is a
   second render context, so every program compiles twice** ("disabling
   the Post Processing module halved startup", `GISystem.js:5992-5999`);
   `#refreshMirrorBucket` flips arrive from an ASYNC roughness readback and
   recompile late; `giCompileVariantKey` walks by `material.uuid`.
4. Per variant: `Nodes.getForRender` miss → `nodeBuilder.build()` = the
   ~100 ms of main-thread JS (no in-engine instrument — only the harness
   `probe-gi-wave.mjs` / `probe:camera-motion` `B:` rows measure it);
   `createShaderModule` of 180–250 kB; a `createRenderPipeline(Async)` in
   the driver's ONE queue, where a single 90 s material holds every kernel
   behind it.
5. In-process caches: `nodeBuilderCache` (a Map keyed by
   `initialCacheKey`, never pruned — and **purged wholesale** by a GI
   rebuild whose shape moved, and on `renderer-rebuilt`); `programs.
   vertex/fragment` interned by WGSL text (byte-identical WGSL shares the
   `GPUShaderModule`); the pipeline cache keyed on stage ids + the render
   key. No render-side content cache beyond that; nothing on disk.
6. `asyncRenderPipelines` (`≥ 16 kB`, main render only): a pending
   pipeline SKIPS the draw (the object is absent) rather than drawing the
   previous pipeline; one-shot renders (atlas blits, impostor bakes,
   picking, outline mask) stay synchronous by design.

So "what are we doing wrong" has a precise answer: **the material IS the
GI renderer.** Every lit material carries the full consumer for its bucket,
generated per variant by a JS builder on the main thread, compiled per
variant by a driver that serialises, doubled by the postprocess context,
walked again on every shape change, and discarded from the browser cache
between boots. None of the four multiplicands is inherent to the look.

### 2.6 GI build and rebuild — what is thrown away, what is kept

What a rebuild discards (`#dispose`, `GISystem.js:15953`): the state, the
occupancy field/`bits`, the reflection BVH scene, the AO/VXAO passes, **the
whole probe store and its ~68 SRC kernels (cold field)**, gizmos, every
compute node's builder state (`releaseComputeNodes` → `nodeCache.delete`,
so **TSL analyze + WGSL codegen runs again for every kernel**), every
storage attribute (retired on a TTL). What it keeps: the persistent
g-buffer and `_giTargets` (never recompiles materials on a re-point —
§11.33), the GI light and material-facing node identities, the observed-
material marks, the slot atlas object, adoption keys, pools, the static-BVH
session cache, the simplifier cache, and — via `giComputePipelineCache.js`
— **the compiled compute pipelines for byte-identical WGSL**: the cache key
is `gi-wgsl:<stage id>` over three's WGSL-interned ProgrammableStage, so a
rebuild whose kernel text is unchanged skips the driver compile (the
`M of them recompiled UNCHANGED WGSL` counter measures module reuse).

What still makes a rebuild expensive: (a) kernel TEXT changes whenever a
capacity/pool/resolution/slot count moves (baked `uint(c.blockCapacity)`,
`uint(info.binBase)`, dispatch counts, `BIN_WORDS` at module load —
`srcProbes.js:1094…`, `srcDeposit.js:1531…`, `srcSystem.js:3108`), so pool
grows and resizes recompile 56–68 kernels; (b) the per-kernel TSL build is
redone regardless; (c) the material-light shape check
(`giMaterialLightShapeMatches`, 15 node refs + 4 flags) — when it moves,
`purgeNodeBuilderCache` drops EVERY material graph (including
postprocessing's) and the full variant walk runs; (d) the probe store is
never migrated, so every rebuild re-converges from black; (e) `#rebuild`
has no yield point, and the build gate `#readyToRebuild` walks
`engine.entities` every tick. The §11.8 two-phase swap already exists for
pool grows (prepare → step → commit, picture held) and is the shape a
general rebuild should take.

### 2.7 The pipeline cache across boots

WebGPU exposes no application-owned pipeline blob; cross-boot reuse comes
only from Chromium/Dawn's disk cache keyed on WGSL text. Measured today on
the editor's WebView2 profile (`%LOCALAPPDATA%\com.khudiiash.threeengine\
EBWebView\Default`): `DawnWebGPUCache` **13–15 MB (65 external entries,
median 43 kB, data_3 8 MB)**, last written at 12:36; `GPUCache` 6.3 MB;
`GrShaderCache` 10.1 MB. A Level boot creates ~250 pipelines, Bistro 323 +
256; the harness measured 19 082 → 9 ms warm ONLY with byte-stable text.
No Chromium flag in `tauri.conf.json` touches the cache (the args are
`--disable-features=…`, autoplay, `--enable-unsafe-webgpu`,
`--force-high-performance-gpu`). Two hypotheses, both testable in a day
(unit 3.6): the cache is capped near Chromium's default program-cache size
and evicts most of a scene's pipelines every boot; and the text still moves
between boots (capacities, offsets, slot counts as literals) so the key
misses even when the entry survives. WebView2 runtime 152.0.4191.66.

### 2.8 Physics

`PhysicsSystem #flushDefaultColliders` attaches an auto collider per entity
and emits `hierarchy-changed` per flush; the storm detector fired at boot
today (30 flushes/s). Each flush re-runs the §2.4 listener set. The
2026-09-07 ping-pong guard bounds the loop, not the per-flush fan-out.

---

## 3. THE ROOT CAUSES, RANKED

**R1 — Synchronous work inside the frame / on the click stack.**
`#rebuild` (no yields), the SAH BVH and the simplifier, `compileAsync`'s
per-object codegen, the prewarm loop's per-kernel builds, JSON parse ×2,
entity instantiation, geometry decode, merge geometry + canvas
rasterisation, collider outline builds, mask-pass pipeline compiles, prefab
subtree diffs in render bodies. None of it is inherently main-thread work;
all of it is scheduled as if it were free.

**R2 — The material is the GI renderer** (§2.5). 27 → 91 kB per variant,
~100 ms of codegen and a serialized driver compile each, ×164–172 variants,
×2 contexts, re-walked on every shape change, cold most boots.

**R3 — Rebuild where an update would do.** One `hierarchy-changed` for
every prop; batching/merging/shadowMerge rebuilding whole populations on
any signal; GI disposing the probe store and re-running every kernel's
codegen on a toggle, a pool grow, a resize rung, a device swap, a scene
switch; kernel text that changes with capacities so the content cache
cannot hit; materials purged wholesale on a shape change.

**R4 — Cold boots by construction.** Small browser cache + unstable shader
text (§2.7).

**R5 — No instrument where the user is.** The harness cannot open the
user's project; `profile.spikeWatch` needs a focused viewport and a human
to time it; no `PerformanceObserver`, no `performance.mark`, no timing of
`Nodes.getForRender` anywhere in `src/`. Every freeze so far was diagnosed
from memory, days later.

---

## 4. THE PLAN — stages, units, gates

Each unit ships behind a hatch with a Stage 0 receipt before/after. Units
inside a stage are independent; stages are ordered by yield ÷ risk. A unit
that touches the shadow term, the light transform or the g-buffer
resolution carries a LOOK receipt (scale plan §11.47). "Days" are working
estimates for one person; parallel tracks are marked.

### Stage 0 — THE FREEZE LEDGER (instrument first; ~2 days)

- **0.1 `profile.freezes`**: an always-on `PerformanceObserver('longtask')`
  in the ENGINE (dev + editor builds), each entry joined to what the engine
  was doing: the tick phase/sub-phase marks; the current GI stage
  (`__giCurrentComputeName`, rebuild reason, wave / prewarm / material
  loop); the current command (`CommandBus` label); the material being
  built (wrap `Nodes.getForRender` → name + WGSL kB + ms); the current
  event flush and its emitter stack; the sync
  `createRenderPipeline` / `createComputePipeline` / `createShaderModule`
  calls inside the task (the device wrapper of `probe:gi-boot-frames`,
  moved into the engine). Ring of 200; one console line per task > 100 ms:
  `[freeze] 1 284 ms — gi:rebuild (#buildStaticBvhPacked 812, #buildScreenResolve 301)`.
- **0.2 `profile.boot`**: the boot as stages with ms — project open,
  engine import, renderer init, scene parse, assets, instantiate, textures,
  GI gate wait, GI build (each sub-stage), wave (materials: count, build
  ms, compile ms; kernels: count, build ms, compile ms; slowest of each),
  first paint, first lit, first gather — stamped from `performance.now()`,
  printed once as a table at "Editor ready" and at first lit. The same
  table for every rebuild (`giRebuilds.log[].stages`) and every resize.
- **0.3 `profile.edit`**: per command, ms in each listener of the flush it
  caused (wrap every `engine.on` handler with a mark), so "changing X cost
  Y ms in merging / sceneStore / GI fingerprint / physics" is one read.
- **0.4 `probe:editor-freezes`** (harness): fix the detached-frame project
  open (it is what `run-boot-diag` and the Bistro walk die on), then a
  script that boots a project, runs a fixed select / edit / orbit / GI-
  toggle sequence and prints the ledger — the regression gate for every
  later unit.
- Gates: (1) a freeze the user reports has a `[freeze]` line with an
  owner; (2) every number in §2 has a ledger equivalent; (3) the Pool
  scene's missing `[gi] built` is explained by the boot table.

### Stage 1 — STOP THE STORMS (editor track; ~4 days)

- **1.1 Classify `setProp`.** `Component.setProp` emits `component-changed`
  only; `hierarchy-changed` fires for STRUCTURE (add / remove / reparent /
  enable of a component or entity; geometry or material asset swap) via a
  per-schema `structural: true` flag, default false. Every listener that
  rides `hierarchy-changed` today is re-pointed at what it needs: merging /
  shadowMerge / batching on mesh|model geometry, material and shadow-flag
  changes and structure; GI's fingerprint on structure + material content;
  physics on collider / rigidbody / geometry; the mirror on everything,
  incrementally (1.2).
- **1.2 `sceneStore.refresh` once and incremental.** The mirror updates the
  one entity that changed (the `updateTransform` shape exists) and keeps
  object identities for untouched entities so Hierarchy rows don't
  re-render; the `CommandBus.#afterMutation` refresh and the flush refresh
  become one.
- **1.3 Drag = preview, release = commit.** NumberField / sliders / colour
  pickers / the gizmo write the live value through a non-undoable preview
  path (no events, no mirror) at most once per rAF; the command and its
  fan-out run on release.
- **1.4 Physics flush without a storm.** `#flushDefaultColliders` batches
  under `engine.batchHierarchy`, never emits for disabled auto colliders at
  boot, and keeps cooking in idle callbacks.
- **1.5 Throttles that hold.** `batching.sync` gets a settle; merging's
  `_urgent` skips the settle but never the interval; shadowMerge follows
  merging once per merge rebuild; a merge rebuild on a GI scene waits for
  the wave.
- **1.6 Live-preview export off the edit path** (2 s debounce, export in a
  worker / Tauri side).
- Gates (Bistro + Level, `profile.edit`): light intensity edit < 2 ms of
  listeners; a transform drag causes zero merge / shadowMerge / GI rebuilds
  until release; the storm detector never fires at boot; a NumberField drag
  holds 60 fps with ONE command in the undo stack.

### Stage 2 — NO SYNCHRONOUS SHADER WORK INSIDE A FRAME, AND THE GI OUT OF THE MATERIAL (engine track; ~2–3 weeks)

- **2.1 Async for every pipeline; the previous pipeline until the new one
  lands.** `asyncRenderPipelines` drops the 16 kB gate for the main render
  and learns the ONE-SHOT contexts (outline mask, atlas blits, impostor
  bakes, picking): a one-shot render whose pipeline is pending is deferred
  a frame (the caller re-renders), never drawn black. A render object whose
  pipeline is re-minted keeps drawing its PREVIOUS pipeline until the new
  one lands (the interception owns `_getRenderPipeline`), which also ends
  "meshes disappear and come back" on a rebuild.
- **2.2 A material-build scheduler.** The compile wave and every runtime
  `needsUpdate` go through one queue that builds in idle time
  (`scheduler.postTask` background / `requestIdleCallback`) under a frame
  budget (≤ 8 ms of build per frame while the user interacts, the whole
  frame when idle), with Stage 0 attribution. A material whose program is
  not ready draws its previous program (2.1) or, for a NEW material, a
  placeholder (the stock 27 kB PBR without injection, compiled once at
  boot) until its own lands.
- **2.3 Deferred specular — the GI consumer out of the material.** The
  specular GI term (cascades, probes, prefilter, mirror trace, hit
  lighting, glow) resolves per pixel in ONE compute/quad program like the
  diffuse resolve already does, into a radiance target the material
  samples with the same 4-tap bilateral it already uses for irradiance;
  the light node shrinks to two texture taps + AO + emitter-shadow unpack.
  Scale plan §10 item 5 priced it: materials back to ~27–40 kB, "the 60 s
  wave ≈ 10–15 s, no 91 kB compiles on first sight". Same shape for the
  water medium: the per-pixel path length is already computed on
  `scene.fogNode`; the caustic light and the shafts move to the post chain
  so a material's water block is a fog tap. Gate: one lit material's WGSL
  with GI on ≤ GI off + 8 kB; Bistro's wave: build sum < 3 s, compile sum
  < 10 s warm; the four bucket variants collapse to one program family.
- **2.4 Fewer variants.** The wave keys on the PROGRAM key
  (`renderObject.initialCacheKey`), not `material.uuid`; graph-path
  materials that are structurally stock get the stock path (widen
  `matchStockPbr` for the common bails — AO ≠ 1, non-opaque opacity — with
  factor uniforms instead of minted nodes); a light prop rebuilds the
  light IN PLACE instead of `new THREE.Light`; `#refreshMirrorBucket` flips
  only `needsUpdate` when the program family changes (after 2.3 it never
  does); InstancedMesh programs shared by geometry (patch three's
  `object.uuid` key locally); the postprocess context compiles its
  variants from the SAME stage modules (three interns by WGSL text — verify
  the fragment text is identical across the two contexts; if not, make it
  so). Gate: Bistro ≤ 40 distinct programs per context.
- **2.5 The TSL build itself.** Instrument one 91 kB build (0.1): node
  traversal vs WGSL string building vs `customProgramCacheKey` hashing
  (21 % of drag-time JS was cache-key hashing, [[camera-motion-perf]]);
  cache the per-material hash; build the shared GI subgraph once per
  program family.
- Gates: no `[freeze]` row attributed to a shader/pipeline call during
  editing; first camera turn after boot: 0 sync pipelines; a material edit
  shows on screen < 300 ms with the previous look meanwhile.

### Stage 3 — CACHE, DON'T REBUILD (engine track; ~1–2 weeks)

- **3.1 Kernel text stable across rebuilds, so the existing content cache
  hits.** Capacities, bin bases, dispatch counts and slot counts become
  uniforms / indirect dispatch (§11.17's ~31 literals; `BIN_WORDS` read at
  build not module load); the dumped-WGSL diff of two rebuilds is the
  gate (0 differing lines); the `M recompiled UNCHANGED WGSL` counter and
  the boot table's kernel compile sum read 0 on a `structural-props-
  changed` rebuild. Keep the per-kernel builder state for unchanged kernels
  (`releaseComputeNodes` keeps `nodeCache` entries whose text is unchanged)
  so the TSL build is not redone either.
- **3.2 Rebuild keeps the materials.** A GI rebuild never purges
  `nodeBuilderCache` wholesale; a shape change re-walks ONLY the variants
  whose program family the change touches (after 2.3, none), and target
  re-points stay `#refreshRenderObjectsOnce`. Gate: `giRebuilds.log`
  stages show 0 material builds on `structural-props-changed`.
- **3.3 GI props are updates; rebuilds migrate.** `bounce` / `reflections`
  toggles gate passes and uniforms (as `ao` → off already does); pool
  grows are allocate + copy (3.1); `resolve-resize` resizes targets in
  place and keeps temporal history (the persistent g-buffer pattern); a
  rebuild that IS needed takes the §11.8 prepare → step → commit shape and
  MIGRATES probes + bins into the new store so the field is never cold.
- **3.4 No device loss for settings.** `antialias / samples / transparent`
  move to the project renderer block (one device per session; a scene
  switch never rebuilds the renderer); a renderer rebuild is an explicit,
  confirmed action; `#scheduleRendererResize` no longer awaits
  `onSubmittedWorkDone` on the main thread.
- **3.5 Static derived data on disk** (§7 of the scale plan exists for the
  BVH): the albedo atlas + texture averages, the transport's simplified
  indices, and merged geometry / uber texture arrays cached by content
  signature so the second boot reads them.
- **3.6 The browser cache, measured then fixed** (1 day, can go first):
  (a) the boot table on two consecutive editor boots: warm compile ms per
  kernel / material; (b) diff two boots' dumped WGSL
  (`scripts/.tmp-dump-compute.mjs` + the material dump) → every differing
  literal becomes a uniform or is padded (the `LAYOUT_GRANULE` precedent);
  (c) test the cap: relaunch WebView2 with `--gpu-program-cache-size-kb=
  <big>` via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (no rebuild needed) —
  receipt: the `DawnWebGPUCache` entry bytes grow past 13 MB and the second
  boot's compile sum drops; if the switch does not govern Dawn's cache in
  this Chromium, read the installed version's `gpu_disk_cache.cc` for the
  Dawn type's cap and file the WebView2 request.
- Gates: a GI `bounce` toggle < 1 s to a correct picture, no ghost; a pool
  grow with no visible change; a scene switch with no `DEVICE LOST`; the
  second boot of Bistro: kernel compile sum < 5 s.

### Stage 4 — BOOT OFF THE MAIN THREAD (engine track; ~1–2 weeks)

- **4.1 One parse.** The scene JSON is parsed once and handed to the
  deserializer; `settings.renderer` is read from that parse (3.4 makes the
  construction-freeze moot).
- **4.2 Assets without copies.** `adoptBinaryPackage` hands out views over
  the IPC buffer; `.geom` v2 is decoded as views (verify no
  `JSON.parse(TextDecoder…)` path remains for v2; migrate v1 files on first
  open); KTX2 and Draco stay on their pools.
- **4.3 Instantiate in slices.** `deserializeScene` instantiates in time-
  sliced batches (≤ 8 ms/frame) under `batchHierarchy`, the scene visible
  as it grows, each slice stamped in the boot table;
  `waitForTextureAssets` becomes an event.
- **4.4 The BVH in a worker; a rebuild that yields.**
  `buildStaticPlacementBvhWords` and the meshoptimizer simplify run in a
  module worker on transferable typed arrays (the input is already one
  packed `Uint32Array`; sizing couples through `staticBvhWords` and the
  1.5× headroom path); the disk-artifact decode moves to the same worker.
  `#rebuild` becomes a state machine (collect → BVH (await) → entries →
  graphs (one chain per step) → wave) with a yield between steps and Stage
  0 stamps; `#readyToRebuild` stops walking `engine.entities` per tick.
- **4.5 Kernels in dependency order, screen chain first, a boot rung.** The
  wave compiles the passes that light the FIRST frame before the rest
  (resolve / gather before exact reflections and emitter chains); a coarse
  boot rung (fewer cascades / rays) lights the scene in seconds and the
  full tier compiles behind it (SRC plan §13.14.6).
- **4.6 The first-lit submit.** The transport's first ~2 s trace is
  windowed like the occupancy chain was; the 1 s `readbackStats` map is
  debug-only.
- Gates (boot table, Level / Bistro, warm): "Editor ready" < 3 s; the scene
  visible (unlit) < 5 s; lit < 10 s; no `[freeze]` row > 100 ms after
  "Editor ready".

### Stage 5 — SELECTION IS O(SELECTION) (editor track; ~4 days)

- **5.1 Picking with a BVH**: `three-mesh-bvh` `acceleratedRaycast` on
  scene meshes (bounds trees built lazily off the frame, or reused from
  the GI `bvhScene`), `firstHitOnly` for a click.
- **5.2 Collider outlines cached and lazy**: `#buildOutline` keyed by
  (geometry, shape, transform revision), built off the click stack (a
  frame later, or from the cooked shape's edge list in a worker); the
  outline for the SELECTED entity only.
- **5.3 Hierarchy rows memoized**: `EntityRow` memo on (mirror identity,
  selected, prefab info); `diffInstance` cached per instance revision and
  computed outside the render body; `activeInHierarchy` on the mirror;
  whole-panel re-render only on structure.
- **5.4 Inspector**: `PrefabSection` reads the 5.3 cache; material thumbs
  through the asset cache (no per-mount IPC); `EntityRefField` options from
  a sorted cache invalidated on structure.
- **5.5 Mask pass**: prewarm without frustum culling (the wave's trick),
  after the backend is ready; one mask render for both channels; the
  Background material excluded from the mask context; pending mask
  pipelines defer the outline a frame (2.1) instead of compiling in it.
- **5.6 `setCollidersVisible` / `applyLayerVisibility` once per change,
  over the delta; `assetPaths` identity preserved in the store.
- Gates: on Bistro, select a root with 1 500 meshes: no frame > 16 ms after
  the mask lands; select a model with an enabled concave collider: no
  `[freeze]` row; Hierarchy click-to-click at 60 fps.

### Stage 6 — THE NORTH STAR (decide after Stage 4)

Run the engine in a worker with `OffscreenCanvas`, so the editor UI can
never freeze on engine work. It is the only construction that makes the
"zero" structural rather than a budget, and WebView2 152 supports WebGPU in
workers. The cost is every synchronous editor→engine read (inspector reads,
picking, gizmos, the mirror) — the same seams Stages 1 and 5 clean up. Not
started until Stages 0–4 have paid, and only against a measured residual
that budgets cannot reach.

---

## 5. TARGETS AND ORDER

| what | today (measured / ledger) | after Stages 0–2 | after 3–4 | after 5 |
|---|---|---|---|---|
| Pool: editor usable | 6.5 s | 3 s | < 3 s | — |
| Pool: water visible | 40–60 s | < 10 s | < 5 s | — |
| Level: lit, warm | 12.6–28 s; ~12.5 s of stall | ≤ 10 s, no stall > 100 ms | ≤ 6 s | — |
| Bistro: lit, warm | 60–155 s, minutes of stall | ≤ 30 s, no stall > 100 ms | ≤ 15 s | — |
| param edit (light intensity) | O(scene) storm + rebuilds queued | < 2 ms | — | — |
| GI bounce toggle | full rebuild, 35–51 s ghost, every material rebuilt | no material rebuild | < 1 s, no ghost | — |
| scene switch | DEVICE LOST + rebuild + recompile | — | no device loss | — |
| select an entity | 2 s of 50 ms frames (Pool); seconds on heavy scenes | — | — | ≤ 1 frame > 16 ms |

Order: **0 → 1 ∥ 5 (editor track) and 0 → 2.1 → 2.4 → 2.3 → 3.1–3.3 → 4
(engine track)**; 3.4–3.6 in the gaps (3.6 is a day and goes first if the
boot table shows cold compiles on every boot). Stage 2.3 (deferred
specular) is the single largest unit and the one that needs the user's
explicit go — it changes how reflections are composed (a look receipt
against the path tracer on Cornell / Level / Bistro before it ships).

---

## 6. METHOD RULES FOR THIS PLAN

1. Every unit ships with a Stage 0 receipt before and after; interleaved
   A/B where the number is noisy (boots: 3 pairs, sign test).
2. A freeze is a `longtask` with an owner. No unit claims a freeze fixed
   without the ledger row gone.
3. Perf units that can change the picture carry a look receipt (§11.47).
4. Dev flags are cleared before any receipt (`gi.devFlags.v1`).
5. No live perf number while a harness Chrome runs on the same GPU.
6. Frame time stays a RAY project; this plan is about STALLS and BOOT, not
   fps — a unit that trades a stall for a permanent per-frame cost is
   rejected.
7. Editor-side units never write scene state on read paths (the Inspector
   already honours this — keep it).

---

## 7. LEDGER (receipts as units ship)

### 2026-09-07 — STAGE 0 SHIPPED: the editor records its own freezes

`src/engine/freezeLedger.js` + `src/engine/scheduling.js`, three ops
(`profile.freezes`, `profile.boot`, `profile.edit`), one gate
(`npm run test:freeze-ledger`, 9 checks) and one harness
(`npm run probe:freezes`).

**What it is.** A `PerformanceObserver('longtask')` — the browser's own "the
main thread stopped for N ms" — joined to a ring of activity spans the engine
writes as it works, attributed by SELF time so a block reads as one name plus
its callers. Spans are marked at: the tick's `preRender` and `renderEncode`,
the coalesced `hierarchy-changed` flush, the GI rebuild and each of its stages
(mesh collect, occupancy field, the meshoptimizer simplify, the SAH BVH build,
entries, the screen/light-shadow graph construction, the BVH scene), each
material the compile wave warms BY NAME, each GI kernel's first build BY PASS
NAME, every synchronous `createShaderModule` / `createRenderPipeline` /
`createComputePipeline`, three's per-material node-graph build BY MATERIAL
NAME, the per-material TSL graph compile, scene parse / asset adopt / geometry
decode / entity instantiation, and prefab loading. `profile.boot` prints the
same stages as a table at "Editor ready".

**⭐ WHAT IT FOUND IN THE FIRST HOUR** (user's Pool scene: 181 entities,
92 materials, GI + water + postprocessing):

| finding | receipt |
|---|---|
| **41 compute pipelines compiled SYNCHRONOUSLY in one 667 ms frame**, 1.0 MB of WGSL | the async compute path was installed by GI's FIRST TICK, and on a scene where GI is still waiting for assets it was never installed at all — so the water module compiled every kernel on the frame that dispatched it |
| **prefab loading was 2 217 ms of the boot** and nobody knew | 21 prefabs read one at a time, ~105 ms each, almost all of it IPC latency |
| **the async render-pipeline gate reads only the FRAGMENT program** | `[freeze] 175 ms — (unattributed) 175 [sync gpu: 17r/0c/2m, 78kB WGSL]` — 17 pipelines from two ~39 kB programs whose weight is in the VERTEX stage (a displaced water surface) |
| **the scene file is parsed TWICE per boot** | `peekBootRendererSettings` parses it for `settings.renderer`, `restoreLastScene` parses it again |
| **"materials compile for an enormous time" is NOT the driver** | In one 500 ms block: `material:nodeBuild MeshPhysicalNodeMaterial 209 ms` + `Water 156 ms` against **3.1 ms** of actual `createShaderModule` + `createRenderPipeline`. The cost is three's `nodeBuilder.build()` — the TSL graph walk and WGSL codegen — running synchronously inside whatever frame first needs the program. ⚠ SEE THE CORRECTION BELOW for the per-build figure: those block totals are SUMS, not single builds. |
| **the water medium re-mints every material once per pool claim** | `scene.fogNode` is in every material's graph, so replacing it invalidates all 92 programs; the `[water] … fragment binds …` census printed 4-6 times in one boot |

### 2026-09-07 — UNITS SHIPPED (engine track)

| unit | change | receipt / hatch |
|---|---|---|
| **0.1-0.3** | the ledger + `profile.freezes` / `profile.boot` / `profile.edit`; `EventEmitter._invoke` is the seam that times one listener | 9/9 gate checks; every number below comes from it |
| **0.4** | `npm run probe:freezes` — boots a real project and prints the boot table, the blocks by owner, and every synchronously-compiled pipeline by name. ⚠ CORRECTED after it failed to boot once: the reason `run-boot-diag` died with "Attempted to use detached Frame" is not that it CLICKED the hub — every working harness here clicks — it is that it ALSO left `engine.projectRoot.v1` armed, so `startupReopen` opened the project too and the second open navigated. The flag for this already exists: `globalThis.__editorNoAutoOpen = true` keeps the hub up for the click. ONE opener, not two. | replaces the probe that could not open the user's project |
| **2.1** | `installAsyncComputePipelines` moved from GI's first tick to a new engine `renderer-ready` event, so EVERY compute pipeline in the app compiles on the driver's threads whether or not GI ever builds | **41 → 0** sync compute pipelines; `__giAsyncComputeEarly = false` |
| **2.1** | the async render-pipeline size gate reads `max(vertex, fragment)` | the 17-pipeline block's programs now qualify |
| **2.4** | the compile wave's variant key was `material.uuid` — the ONE field three's program key ignores. It now mirrors `RenderObject.getMaterialCacheKey`: `customProgramCacheKey()` (where node identity and GI's roughness bucket enter), the same property walk with the same normalisation, the geometry attribute/morph/index key, bone count, instancing, `receiveShadow`. The wave logs `N variants of M drawable objects` | `__giWaveVariantKey = "uuid"` |
| **3.6** | `--gpu-program-cache-size-kb=262144 --gpu-disk-cache-size-mb=1024` in the editor's WebView2 args, the inspector build, and every shipped game. SIZED from the measurement: 13 MB held ~65 entries ≈ 200 kB each, so a 320-pipeline boot is ~64 MB and 256 MB is four boots of headroom. Exonerated as a crash cause by a `CACHE_ARGS=0` arm | the editor's `DawnWebGPUCache` held 13 MB in ~65 entries against a boot creating 250-320 pipelines |
| **4.1** | one scene parse instead of two: the boot peek keeps what it parsed and the restore takes it | `scene: parse JSON` **0 ms** in the boot table |
| **4.3** | entity instantiation is time-sliced (`sliceLoop`, 8 ms budget) instead of one unbroken loop | the boot table reports the yields taken |
| **(found by 0.2)** | prefabs load in parallel (16 in flight), registration order preserved | **2 217 ms → 655 ms** |
| **(found by 0.1)** | the water medium's growth rebuild is settled (250 ms) so a scene load's burst of pool claims re-mints the material set ONCE | `__waterMediumSettleMs = 0` |
| **3.2 (receipt only)** | `giMaterialLightShapeDiff` names the field that forces a material re-warm, and the rebuild logs it | a `false` there costs ~200 ms × every material |

**Boot on the user's Pool scene, before → after:**

| | before | after |
|---|---|---|
| "Editor ready" | 6 550 ms | **6 183 ms** |
| prefabs | 2 217 ms | **85 ms** (quiet machine; 655 ms was measured with subagents running) |
| scene JSON parse | 2 parses | **1, 0 ms** |
| main thread blocked to "Editor ready" | not measurable | **651 ms in 5 tasks, worst 240 ms** |
| sync compute pipelines in one frame | **41** | **0** |
| water surface visible | 40-60 s | **~22 s**, and the `[water] … fragment binds …` census prints ONCE per material instead of 4-6 times |
| prefabs (quiet machine, re-measured twice) | 2 217 ms | **134 ms**, then **85 ms** |

### 2026-09-07 — SECOND PASS (engine track)

| unit | change | receipt / hatch |
|---|---|---|
| **robustness (found by the device loss above)** | a renderer rebuild after a device loss now RETRIES with backoff (0 / 250 / 750 / 2000 ms) and REFUSES a WebGL fallback on a canvas that was WebGPU — a canvas that has handed out a WebGPU context cannot hand out a WebGL one, which is exactly how the observed rebuild died on `getSupportedExtensions` of `null`. A failed attempt no longer leaves a half-built renderer in `engine.renderer`, and the final failure logs what to do and emits `renderer-rebuild-failed` instead of one silent `console.error`. A SETTINGS-driven rebuild still gets one attempt — its failures are not transient. | `npm run test:renderer-rebuild` all ok |
| **0.1 (instrument)** | `freeze.clear()` now empties `nodeBuilds`, `syncPipelines` and the per-task GPU counters too. It cleared only the blocks before, so a before/after A/B would have shown the "after" arm still carrying the whole session's builds — plausible numbers, wrong conclusion. Pinned by a 10th check. | `npm run test:freeze-ledger` 10/10 |
| **0.1 (attribution)** | spans added for each engine module's `setup` (`module:setup <id>`), the postprocess pipeline build, and the scene-load sub-steps (`scene:clear`, `scene:applySettings`, `scene:awaitMeshAssets`, `scene:awaitTextures`) — the four places the boot's `(unattributed)` blocks were sitting | |
| **0.4** | `probe:freezes` takes `SCENE=` so a heavy scene can be measured without touching the user's editor | |

**⚠ NOT OURS, but seen and worth writing down:** with the sea-spray work in
flight, the editor logs
`Binding size for [Buffer (unlabeled)] is zero … entries[5] … ShaderStage::Vertex …
BufferBindingType::ReadOnlyStorage` and, three seconds later, an
`Async render pipeline creation failed (renderPipeline_MeshPhysicalNodeMaterial_144)`
carrying the same text. Two separate things:

1. The root error is a zero-sized storage buffer bound by the spray material's
   `positionNode` (`waterSpectrum.js`, the `sea spray` mesh) before its particle
   pool has been allocated. `CreateBindGroup` runs at DRAW time, not during
   pipeline creation, so this is independent of how the pipeline was compiled —
   raising the async gate to read the vertex stage did not cause it.
2. The pipeline "failure" is the misattribution
   [[three-rendercontext-shared-by-shape]] already records: three wraps
   `createRenderPipelineAsync` in a validation error scope and pops it after the
   await, so ANY validation error raised in between is reported against whatever
   material happened to be compiling. A failed pipeline for a scene material is
   not necessarily that material's fault.

### 2026-09-07 — CORRECTION: the per-build cost, once the counter existed

The first reading of this said "~150-210 ms per lit material". That was the
SUM of the builds inside one long task, read as if it were one build — the
same class of error as reading a slowest-pipeline latency as a compile time.
`profile.freezes` now carries a per-material `nodeBuilds` count, and the honest
numbers on the user's Pool scene are:

| material | builds | total | mean | worst |
|---|---|---|---|---|
| `MeshPhysicalNodeMaterial` | 14 | 482 ms | **34 ms** | 49 ms |
| `Water` | 5 | 438 ms | **88 ms** | 194 ms |
| `MeshBasicNodeMaterial` | 11 | 109 ms | 10 ms | 26 ms |
| everything else | 18 | 90 ms | 5 ms | 30 ms |

**48 node builds, ~1.1 s in total.** So the fix is NOT "one build is enormous"
— it is **count × size**, and the two have different owners: the count is
variant/context multiplication (unit 2.4, and the postprocess MRT context
building each program a second time), the size is what the GI consumer and the
water medium add to every graph (unit 2.3). The `Water` material is the one
that is genuinely large per build at 88 ms mean.

⭐ THE METHOD POINT, which is why this correction is in the ledger rather than
quietly edited over: a block's attribution is a SUM over everything that ran
inside it. An owner's ms in `profile.freezes` answers "how much of this freeze
was that", never "how expensive is one of those". `nodeBuilds` /
`syncPipelines` carry the counts for exactly that reason — read them before
turning an owner into a per-item cost.

### 2026-09-07 — ⚠ ONE DEVICE LOSS, UNATTRIBUTED

After several hours of reloads with three sessions attached, the editor lost
its device with `ID3D12Device::CreateDescriptorHeap failed with E_OUTOFMEMORY`,
and the automatic renderer rebuild then failed on top of it
(`Cannot read properties of null (reading 'getSupportedExtensions')` — the
rebuild fell through to the WebGL backend with no context, so the editor was
dead until a page reload). A full reload recovered it cleanly, no errors.

Not attributed to anything in this session's work, and stated as unattributed
rather than guessed at: `700f1fc` ("water: mips without allocations — the
descriptor-heap device loss") records the same failure class in the water
module before any of this. Two things are worth doing regardless, and neither
is done: find out why descriptor heaps run out after a long editing session
(a leak across reloads is the obvious candidate), and fix the REBUILD path so a
lost device does not leave the editor in a state only a manual reload escapes.

### 2026-09-07 — UNIT 3.4: OPENING A SCENE NO LONGER DESTROYS THE GPU DEVICE

The renderer block (`antialias`, `samples`, `transparent`) is authored PER
SCENE and is frozen when `WebGPURenderer` is constructed, so opening a scene
whose block differed from the running renderer's tore the device down — and a
destroyed device means GI rebuilds from nothing and every material is compiled
again, which `Engine.js` itself prices at ~40 s. That is the whole of
"switching scenes freezes the editor", and nobody asked for it: the user opened
a scene, they did not change a setting.

`Engine.applySettings(patch, { fromSceneLoad: true })` now applies the value and
DEFERS the rebuild, saying so once:

```
[gpu] this scene asks for antialias false→true, which is fixed when the renderer
is created. Keeping the current renderer: rebuilding it here would destroy the
GPU device, and GI would rebuild and recompile every material (~40 s). Reload
the editor (Ctrl+R) to open this scene with its own renderer options.
```

The difference the user sees is multisampling on the scene they just opened;
the difference they no longer see is a forty-second stall. A deliberate EDIT
still rebuilds immediately — that path does not pass the flag, and a setting
you just changed has to take effect or the control is broken.
`__engineSceneSwitchRebuildsRenderer = true` restores the old behaviour.
Gates: two new checks in `npm run test:renderer-rebuild` (a scene load destroys
no device AND still adopts the value; the hatch brings the rebuild back).

### 2026-09-07 — ⚠ OWED: A MEASUREMENT ON A GI-HEAVY SCENE

Everything measured today is the user's Pool scene, where **GI never builds**
(`giRebuilds.runs 0, asks 0` while `giTiers` is populated). The units aimed at
heavy scenes — the wave's variant key, the async compute install, the material
node-build count — therefore have no receipt on Bistro or Sponza, and the plan's
targets for those scenes are still the pre-work numbers.

Three attempts to get one through `probe:freezes` failed, and the failure is
worth recording because it is not the probe:

- Booting the project works (~20 s under the Tauri shim).
- `scene.open` on Sponza reliably **detaches the frame** — the renderer process
  is gone, i.e. the tab crashed, not a navigation. It survived the unit 3.4 fix,
  so it is not the device swap.
- ⛔ IT IS NOT THE SIZE. Switching to **Cornell** — a nine-mesh room — detaches
  the frame at exactly the same point. Any scene switch does.
- ⛔ AND IT IS NOT THE RAISED PIPELINE CACHE (unit 3.6). Re-run with
  `CACHE_ARGS=0`, which drops `--gpu-program-cache-size-kb` and
  `--gpu-disk-cache-size-mb` entirely: identical crash. Worth stating because
  those flags now ship in the editor and in every exported game, and "the new
  flag destabilised the GPU process" was the obvious suspicion to clear.
- `openScenePath` navigates nothing (read it: load, parse, preload, deserialize,
  remember, `afterSceneSwap`), so the frame detaching means the RENDERER PROCESS
  DIED. This is the same undiagnosed failure the GI ledger already records —
  "Bistro on the headless harness walk closed its target immediately twice
  (`ARM THREW … Target closed`)" — now reproduced by a minimal case: one scene
  switch, any scene, with or without the cache flags.

Whoever picks this up: the reproduction is now cheap (`SCENE=scenes/Cornel.scene
npm run probe:freezes` against a fresh vite), so bisect the switch itself —
`engine.clear()`, the GI dispose, `preloadAssetBinaries` over the CDP shim — and
consider booting straight into the heavy scene (the `stashReopenTarget`
sessionStorage handoff that `editor.reload` uses) rather than switching after
boot.

### 2026-09-07 — THE LAST READING (Pool scene, everything in)

| owner | builds | total | mean | worst |
|---|---|---|---|---|
| `material:nodeBuild Water` | 4 | 444 ms | **111 ms** | 220 ms |
| `material:nodeBuild MeshPhysicalNodeMaterial` | 11 | 317 ms | 29 ms | 45 ms |
| `material:nodeBuild MeshBasicNodeMaterial` | 11 | 94 ms | 9 ms | 17 ms |
| everything else | 12 | 76 ms | 6 ms | 27 ms |
| `(unattributed)` | — | 586 ms in 3 blocks | — | 247 ms |

38 node builds, ~930 ms. Synchronously-created pipelines are now all trivial
(0.1 ms each, tiny materials); no compute pipeline is created synchronously at
all. **The single most expensive material in the editor is now the water
surface at 111 ms a build** — that is the concrete target the water module
owns, and it is a SIZE problem, not a count one.

`(unattributed)` is the largest remaining owner and it is three blocks: one at
777 ms into the boot (before any scene work — the React/dockview mount), and
two around 4.9-5.2 s (inside the scene load, after the entity instantiation
span ends). Marking those is the cheapest remaining win and it is pure
instrumentation.

### 2026-09-07 — THE EDITOR STOPS WHILE THE GEOMETRY EDITOR IS OPEN

User, after the first pass: *"still freezing a lot. When entering geometry
editing mode, all the components currently ticking in the editor viewport must
be stopped: because they must be causing freezes and lags in the geometry
editor. Still many freezing, and we don't even have the GI enabled yet."*

They were right about the mechanism, and it is worse than "some components
tick". Entering Edit Mode mounts `.scene-geometry-editor-overlay` — `inset: 0`
over the viewport panel with an opaque background, so the main canvas is
COVERED for the whole session — and the geometry editor draws through its **own
`WebGPURenderer` and its own `requestAnimationFrame` loop**, needing nothing
from the engine's. Nothing was suspended: the engine kept ticking AND rendering
that hidden canvas at full rate, so for the entire session the water solver
dispatched its FFT chain every frame (water does not even take the
`isInView()` gate), GI ran its g-buffer prepass — a whole extra scene render —
batching/merging/shadowMerge/impostors/occlusion kept re-grouping, and the
selection outline kept compositing. All of it into pixels nobody can see, on
the one main thread the geometry editor needs for drawing and picking.

**Shipped:**
- `Engine.suspendSimulation(reason)` / `resumeSimulation(reason)` — ref-counted
  by reason so two modal holders cannot resume each other, with
  `simulation-suspended` / `simulation-resumed` events and a `simulationHolds`
  read. It is NOT play mode, NOT `paused`, and deliberately NOT
  `renderSuspended`.
- `Engine.#tick` holds batching, merging, shadowMerge, impostors and occlusion
  while it is set; `GridSimulationComponent` (water/cloth), `VfxComponent`,
  `ParticleComponent`, `AnimationComponent`, `TimelineComponent`,
  `VirtualGeometrySystem` and GI's `onPreRender` all return early.
- `editorFramePacing` treats an OPEN GEOMETRY SESSION (not merely a drag in
  one, which was the only case it handled) as a reason to `host.stop()` the
  engine loop outright, and subscribes to the store so entering and leaving
  both take effect immediately rather than at the next 250 ms sample.

**⚠ TWO THINGS THIS DELIBERATELY DOES NOT DO, both from the map:**
- It does not touch `engine.renderSuspended`. That flag is GI's — it owns it
  for the compile wave, and `profile.*` saves and restores it precisely because
  it has one owner. Worse, suspending the DRAW while still running preRender
  re-creates the ShadowFreeze latch documented in `Engine.#tick`:
  `shadowFreeze.update()` must never run on a tick that does not draw, or a
  light's shadow map switches off for the rest of the session. `host.stop()`
  produces no half-frames and cannot hit it.
- It does not detach anything. `Entity.reconcileActivity` / `_attached` is the
  genuine per-component stop, but it is authored, serialised, undoable state
  that tears down GPU resources — far too destructive for a transient mode, and
  the geometry editor BORROWS the entity's real materials and shares its
  geometries.

Gate: `npm run test:simulation-suspend` (6 checks).

### 2026-09-07 — THE ~57 ms HITCH EVERY ~10 SECONDS WAS THE AUTOSAVE

The ledger showed a block landing on a RHYTHM for a whole session — the worst
kind of stutter, because it never stops. `saveScene` walks the whole engine,
pretty-prints a 326 kB `JSON.stringify`, and then called
`useSceneStore.refresh()` — a full mirror rebuild with fresh object identities,
so every Hierarchy row re-rendered, once per autosave, for a save that changes
no entity.

Shipped: the redundant refresh is gone (`markDirty(false)` is all a save has to
publish; `__editorSaveRefreshesMirror = true` reverts), the walk and the
stringify are spanned separately so the next reading says which dominates, and
autosave now waits for ~600 ms of no pointer/key activity instead of firing on
the interval regardless of what the user's hands are doing.

**⚠ AND THE DEFERRAL IS BOUNDED, because deferring a save widens the window of
loss.** It never waits more than `AUTOSAVE_MAX_DEFER_MS` (4 s) past the
interval, and the scene is also written on window `blur` and on
`visibilitychange` to hidden — the two moments a person expects their work to
be safe. This was written after I reloaded the editor without saving first and
the reload discarded unsaved changes: the standing rule is SAVE BEFORE EVERY
`editor.reload`, and a feature that defers saving makes breaking that rule more
expensive, not less.

### 2026-09-07 — EVERY POSTPROCESS PIPELINE REBUILD NOW NAMES ITS REASON

The ledger caught the post pipeline rebuilding twice in a two-minute editing
session, and each rebuild was followed within milliseconds by a ~600 ms block
of `material:nodeBuild` — re-minting the pass materials invalidates the
programs every lit material shares with them. So a rebuild here is not a 150 ms
event, it is a 750 ms one, and `#ensurePipeline` has SIX call sites. Each now
passes a reason (`renderer-rebuilt`, `graph-prop-changed`, `applyGraph`,
`asset-loaded`, `no-pipeline-yet`, `render-camera-changed`), the span carries
it, and a rebuild over 40 ms logs it. The next session reads the reason instead
of guessing between six.

### 2026-09-07 — A VIEW SNAP COST ~750 ms, FOUR TIMES A MINUTE

The reason string added above paid for itself within one editing session. The
ledger read, four times in sixty seconds:

```
[freeze] 336 ms — postprocess:buildPipeline (render-camera-changed) 325.3 …
[freeze] 567 ms — material:nodeBuild MeshPhysicalNodeMaterial 274.1, … Water 29.2
```

— a pipeline rebuild, and a material re-mint wave landing in the same
millisecond. **Cause:** snapping to a front/top/side view swaps the editor's
PERSPECTIVE camera for an ORTHOGRAPHIC one (`ViewportPanel.useEditorCamera`),
and coming back swaps it again. `PostprocessComponent.#syncRenderCamera`
disposed the whole pipeline and built a new one on each swap — and a new
PassNode means a new render target, a new RenderContext, and therefore a new
program cache key for **every material the scene draws through it**. So a view
snap was not a 300 ms event, it was a ~750 ms one, and a session of framing
shots is seconds of frozen editor.

**Shipped: the pipeline is CACHED PER CAMERA rather than rebuilt.** The editor
only ever alternates between two cameras, so the second visit to each is free.
The recompile is not avoidable across a projection change — three's PassNode
bakes perspective-vs-orthographic depth (its own TODO says so) and the post
effects capture `ctx.camera` when they are built — so this does not try to
repoint anything; it keeps whole bundles and swaps them.

⚠ The bundle is exactly the field set `#disposePipeline` clears, declared once
as `PIPELINE_BUNDLE_FIELDS` and read by both. If a field is added there it must
be added here, or a swap restores a HALF pipeline — the failure mode that
file's comments already record twice (a PassNode's render targets outliving
their reference; SSGI coming up invalid against a stale target). Anything that
invalidates the live pipeline (graph edit, asset reload, renderer rebuild)
drops every stashed bundle too.

**Receipt (live, play/stop as the camera swap):**
```
[postprocessing] pipeline rebuilt in 163 ms — reason: render-camera-changed (cache miss)
[postprocessing] reused the pipeline already compiled for this camera — no rebuild, no material re-mint
```
`__ppCameraPipelineCache = false` restores dispose-and-rebuild.

▶ OPEN, seen in the same receipt: LEAVING PLAY MODE still re-mints materials
(a 569 ms `material:nodeBuild` block right after the cache hit). That is the
play-stop path (`reconcileScene`), not the camera swap — a separate owner.

### 2026-09-07 — ⚠ NOT OURS: A COMPUTE PASS BINDS A ZERO-SIZED STORAGE BUFFER

Recurring in the live editor while the sea-foam/spray work is in flight:

```
Binding size for [Buffer (unlabeled)] is zero.
 - While validating entries[0] against { binding: 0, visibility: ShaderStage::Compute,
   buffer: {type: BufferBindingType::Storage, minBindingSize: 0 } }
 - While encoding [ComputePassEncoder "computeGroup_…"].SetBindGroup(0, …)
```

Two separate things, and they are easy to confuse:

1. The ROOT fault is a compute dispatch whose binding 0 is a zero-length
   storage buffer. `CreateBindGroup` runs at dispatch time, so it is
   independent of how any pipeline was compiled. Checked and NOT the cause:
   `particleCount = (foamSize*foamSize)>>3` (foamSize is 256/512/1024 by tier,
   never 0), `splashCount = max(1024, …)`, `sprayCells` (constants), and the
   batching proxies (`members.length >= MIN_GROUP_SIZE`). The remaining
   candidates are the per-slot return buffers and anything sized from a live
   count.
2. It is REPORTED as `Async render pipeline creation failed
   (renderPipeline_MeshBasicNodeMaterial_…)`, which is the misattribution
   [[three-rendercontext-shared-by-shape]] records: three wraps
   `createRenderPipelineAsync` in a validation error scope and pops it after
   the await, so any validation error raised in between lands on whatever
   material happened to be compiling. **The named material is not the fault.**

### 2026-09-07 — "VIEWPORT STILL LAGS IN THE GEOMETRY EDITOR": THREE MORE CAUSES

The first fix (stop the engine loop for the session) was necessary and not
sufficient. Three things were still wrong, and the first one is why the fix
could look like it did nothing at all.

**1. THE SUSPENSION MISSED AN ENTIRE ENTRY PATH.** There are THREE ways into the
geometry editor and only two set `geometryEditStore.entityId`: Tab in the
viewport and the Inspector's Edit button. The DOCKED `geometryEditor` panel
(from the Assets panel, or the Inspector's open-as-panel) renders the same
component in its own dock tab and sets nothing — so a user who opened it that
way got no suspension whatsoever. The store now carries two facts with two
meanings, documented in its header: `entityId` = THE VIEWPORT IS COVERED (the
overlay is `inset: 0` over the canvas, so the loop can stop outright), and
`sessions` = an editor is open by ANY path (the panel itself counts itself in
and out). The docked case suspends simulation, GI and the rebuild systems but
only CAPS the viewport's frame rate, because there the viewport may still be
visible and still needs to draw.

**2. THE GEOMETRY EDITOR IS A SECOND RENDERER, AND IT WAS INVISIBLE TO THE
LEDGER.** Edit Mode builds its own `WebGPURenderer` (with `antialias: true`) on
its own canvas, with its own device and therefore its own pipeline cache —
every material in it compiles again. None of it appeared in `profile.freezes`,
because the ledger's wrappers were installed on `engine.renderer`'s device
only, so "the geometry editor lags" had no owner to point at. It is now
instrumented like the main renderer (`installGpuCallLedger` +
`installNodeBuildLedger`) and its draw is a `geomEditor:render` span.

**3. IT RENDERED A CLONE OF THE WHOLE LEVEL, FLAT OUT, FOREVER.** The session's
scene contains a clone of every visible mesh (`showSceneContext`, on by default
in the embedded path) — translucent, so depth-sorted — plus the edited mesh and
its overlays, and the loop drew all of it every animation frame for as long as
the editor stayed open. Two fixes, neither of which changes what is on screen:
- **one shared material for the whole context** instead of `new
  MeshStandardMaterial` per clone (~85 instances on the user's scene, all
  identical by construction). Marked `userData.sharedMaterial` so the teardown's
  per-object dispose sweep does not dispose the same material 85 times.
- **an idle throttle**: full rate while anything is happening (camera move,
  pointer, wheel, key), `IDLE_INTERVAL_MS` after that. Deliberately a HEARTBEAT
  rather than an on-demand renderer: a missed change signal then appears a fifth
  of a second late instead of never. `__geomEditorIdleThrottle = false` reverts.

**And the suspension now says so.** `[editor] geometry edit mode: engine loop
STOPPED …` / `… ended: engine loop resumed` / `[editor] geometry editor open:
simulation, GI and the rebuild systems are held …`. "Did the suspension
actually engage?" is the first question when someone reports this still
lagging, and from the outside a stopped loop and a busy one look identical.

### OPEN, ranked by what the ledger now says

1. **`material:nodeBuild` — 48 builds and ~1.1 s of a boot** is the largest
   remaining block class, and it is main-thread TSL codegen, not the driver.
   Three reductions, in order: unit 2.3 (the GI consumer out of the material)
   and the same shape for the water medium; unit 2.4's second half (widen
   `matchStockPbr` so structurally-stock materials stop minting per-material
   uniform nodes); unit 3.2 (a GI rebuild that does not purge every material's
   node-builder cache).
2. **`(unattributed)` is still ~570 ms of the boot**, in blocks that carry
   sync render pipelines and shader modules — the React/dockview mount and the
   postprocess pipeline build are the unmarked suspects. Mark them.
3. **Nothing warms materials when GI does not build.** The compile wave is a
   GI feature, so on a scene without a GI build every material's graph builds
   inside the frame that first draws it. Unit 2.2 wants that queue at engine
   level.
4. Unit 4.4 (the SAH BVH and the meshoptimizer simplify into a worker, and
   `#rebuild` as a state machine that yields) is untouched, and is the boot's
   biggest CPU stage on a Bistro-sized scene.

---

### 2026-09-07 — UNIT 0.5: THE LEDGER NOW SAYS **WHY** A MATERIAL REBUILT

`profile.freezes` counted node-graph builds but could not say what caused one,
and the count alone points at the wrong fix: many cheap builds is a variant
problem, a few expensive ones is a graph-size problem, and a *wave* is neither.
`installNodeBuildLedger` now samples the same inputs three keys its
node-builder cache on and reports which one **moved** since that material's
last build, as `nodeBuildCauses`.

The mechanism, from three r185 (`RenderObject.getCacheKey` =
`getMaterialCacheKey()` + `getDynamicCacheKey()`, and
`Nodes.getCacheKey(scene, lightsNode)` inside the second):

| input | what moves it here |
|---|---|
| `lights` | `lightsNode.getCacheKey(true)` — a light added, removed, toggled |
| `environment` | the scene's environment node |
| `fog` | **`scene.fogNode`** — the water medium arming its underwater term |
| `shadowMap` | `renderer.shadowMap.enabled` / `.type` |
| `context` | `renderer.contextNode` id/version — a new target or pass |

Anything on that list re-mints **every material in the scene at once**; that is
the shape of the user's 760 ms blocks. `first compile` is the unavoidable
one-per-material build, and `material key: <fields>` is that material's own key
forking, with the changed property named.

**⚠ TWO MEASUREMENT ERRORS THIS INSTRUMENT MADE FIRST, both of which read as
findings.** They are recorded because the shape recurs:

1. **Keyed on the previous build, globally.** Two different materials
   compiling back to back reported the second as an invalidation whenever the
   scene state happened to be identical. The fix is per-material state.
2. **Keyed on the material's LABEL** (`name || type`). All 28 unnamed
   `MeshPhysicalNodeMaterial`s in the scene share one label, so 27 ordinary
   first builds reported as re-mints of one material — and that fabricated row
   was the largest in the table. Now keyed on `material.id`. A cause table that
   cannot separate "never built" from "invalidated" is worse than none,
   because it looks like an answer.

### 2026-09-07 — THE POOL SCENE'S BOOT, MEASURED WITH IT

Four consecutive clean boots of the user's Pool scene (182 entities), read from
the live editor. The 760 ms class the user pasted is now accounted for:

| cause | builds | ms | materials |
|---|---|---|---|
| `material key: side` | 40 | 499 | ShadowMaterial, Water, MeshPhysicalNodeMaterial, MeshBasicNodeMaterial |
| `first compile` | 27 | 442 | 14 distinct materials |
| `material key: ?` | 36 | 154 | same material, different geometry/object key |
| `environment` | 6 | 79 | |
| `lights` / `lights+fog` / `fog` | 11 | 91 | |

**The invalidation waves are now small — ~170 ms of a ~1.2 s material cost.**
The earlier units (the wave's variant key, the water medium's growth settle,
the per-camera postprocess cache) did their job. What is left is structural:

**⭐ `material key: side` IS THREE DRAWING EVERY DOUBLE-SIDED TRANSPARENT
MATERIAL TWICE.** `three.webgpu.js:62801`:

```js
if ( material.transparent === true && material.side === DoubleSide && material.forceSinglePass === false ) {
    material.side = BackSide;  this._handleObjectFunction( ..., 'backSide' );
    material.side = FrontSide; this._handleObjectFunction( ..., passId );
    material.side = DoubleSide;
}
```

Two draws, and two full node graphs, per such material — 22.7 ms each for
MeshPhysical. It is three's intended behaviour for sorted transparency, so
`forceSinglePass` is a **LOOK change** and is not flipped here (method rule,
§11.47). `compileAsync` routes through the same `renderObject`, so the GI
compile wave DOES warm both passes; this cost lands unwarmed only because —

**▶ NEXT UNIT (2.5): THE EDITOR HAS NO COMPILE WAVE WHEN GI IS NOT
REBUILDING.** The one-object-per-variant warm walk lives inside
`GISystem.#rebuild`, and on this scene `giRebuilds.runs` is 0 — so every
material compiles in whatever frame first draws it, which is the 724 ms block
at boot+9.4 s. The walk (`giCompileVariantKey` + `traverseVisible` +
the yield-budget slicing) is already written and already correct about three's
program identity; the unit is to lift it out of GI so a scene load warms its
own variants whether or not GI rebuilds. ⚠ This is the machinery that once
cost a 30 s init — the yield budget, the concurrent pipeline hand-off and
`renderSuspended` all have to come with it, or it regresses to that.

### 2026-09-07 — UNIT 4.5: THE PREFAB SEARCH WAS 575 IPC ROUND TRIPS

`prefabs: load` was the largest stage of the boot (3.0-3.3 s) and the whole
editor waits on it — a scene's prefab instances cannot expand without their
defs. The sub-step marks say where it went:

| sub-step | before | after |
|---|---|---|
| `prefabs: list files` (22 found) | **2 453 ms** | **886 ms** |
| `prefabs: read files` | 99 ms | 230 ms |
| `prefabs: register` | 3 ms | 4 ms |

**⛔ THE OBVIOUS FIX WAS MEASURED AND IT DID NOTHING.** `listProjectAssets`
walked the tree with `for (const e of entries) { … await walk(e.path) }` — one
`list_dir` per directory, depth first — which is exactly the fault the prefab
READS had (fixed the same day: 2 217 → 85 ms). Making the walk breadth-first
with 16 concurrent `list_dir` calls moved it from 2 418 ms to **2 453 ms**.
Nothing. Two facts explain it and both were checked rather than assumed:

- the filesystem is not the problem — the same 575-directory, 4 233-file tree
  walks in **43 ms** from Python;
- Tauri's IPC does not parallelise, so 575 directories cost 575 serialized
  round trips (~4 ms each) however they are issued.

So the walk moved into Rust: one `list_dir_recursive` command, one round trip,
with `exts` filtering files natively. The JS walk survives as the fallback —
not out of caution, but because the frontend hot-reloads in milliseconds while
a Rust change takes minutes to rebuild, and callers must work in that window.
886 ms is a `tauri dev` DEBUG build doing 4 233 `metadata()` calls; a release
build will be well under that.

### 2026-09-07 — THE DEVICE LOSS THAT COULD NOT BE RECOVERED (user-reported)

```
ID3D12Device::CreateDescriptorHeap failed with E_OUTOFMEMORY (0x8007000E)
[gpu] renderer rebuild attempt 1..4 failed: Cannot read properties of null (reading 'getSupportedExtensions')
```

Two separate faults, and the second hid the first for the whole investigation:

1. **three's WebGL fallback masks every WebGPU error.** `WebGPURenderer`
   installs `getFallback` in its own constructor, overwriting anything the
   caller passes, so ANY failure inside `init()` — here `requestDevice`
   running out of GPU memory — is retried as `new WebGLBackend(...)`. A canvas
   that has already handed out a WebGPU context returns null for
   `getContext('webgl2')` by spec, so that retry dies on
   `getSupportedExtensions` of null, and that is the message the operator
   gets. `refuseWebGLFallback(renderer, wasWebGPU)` clears the hook, so
   `init()` rejects with the truth. Gated by a check in
   `test:renderer-rebuild` that was verified to FAIL with the line removed.
2. **The backoff was three seconds** (0/250/750/2000). A descriptor-heap OOM
   needs the driver to reclaim the lost device's heaps, which does not happen
   that fast while other GPU clients hold memory. Now 0/500/2000/5000/12000,
   and an OOM signature gets its own guidance: close other GPU clients before
   reloading, or the reload hits the same wall.

⚠ CONTRIBUTING CAUSE, worth stating: this happened during a session that
reloaded the editor six times in fifteen minutes while a `cargo` build and a
harness Chrome shared the GPU. Repeated device creation is itself a way to
exhaust a descriptor heap — a measurement loop on a live editor is not free.

### 2026-09-07 — UNIT 0.6: A BLOCK NAMES ITS OWN CAUSES

`nodeBuildCauses` ranks the whole session, and that is the wrong number for a
freeze. On the Pool scene the session total puts `material key: side` on top —
40 builds spread across a nine-second boot — while what the user feels is ONE
724 ms task. Offering only the session total invites reading the largest row as
the cause of the worst block, which is a different claim.

Each recorded long task now carries `causes`: the node builds that fired inside
that window, largest first, and the `[freeze]` console line prints them as
`[rebuilt: fog x31, first compile x4]`. A block with no node build in it
carries `null` rather than an empty array — an empty array reads as "nothing
rebuilt, and we checked", which is false in a session where the ledger is not
wrapped at all. Two checks in `test:freeze-ledger` (now 13).

### 2026-09-07 — UNIT 0.7: EVERY BOOT PHASE MARKS ITS OWN WALL TIME

Two stages were measured large with almost nothing named inside them:

| stage | measured | named inside it |
|---|---|---|
| `prefabs: load` | 3 032 ms | 1 120 ms (list + read + register) |
| `scene: deserialize` | 1 937 ms | 111 ms (instantiate entities) |

An unnamed second is an unfixable one, and this is exactly how unit 4.5 found
the 2 453 ms directory walk. So every phase now marks its wall time:
`prefabs: import module` (a dynamic import under the dev server is a fetch per
module in the graph, not free), and inside deserialize —
`scene: clear previous`, `scene: apply settings`, `scene: embedded prefabs`,
`scene: await mesh assets`, `scene: await textures`,
`scene: publish hierarchy`.

⚠ Wall time, marked separately from the freeze SPANS that already wrap these
phases: a span only surfaces when its phase lands inside a long task, which an
await-heavy phase never does. The two instruments answer different questions —
"was the editor frozen" and "was the user waiting" — and the boot needs both.

▶ Next boot on a full scene reads the split. Nothing is fixed by this unit; it
is the measurement that says which of the two stages to open next.

### 2026-09-07 — UNIT 0.8: THE ASYNC PIPELINE CALLS WERE NEVER MEASURED

`(unattributed)` was the largest owner of every boot measured today — roughly
1.1 s across ~11 blocks — and several of those blocks look like this:

```
[freeze] 171 ms — (unattributed) 171 [sync gpu: 7r/0c/58m, 381kB WGSL]
[freeze] 163 ms — (unattributed) 161.6 … [sync gpu: 21r/0c/89m, 977kB WGSL]
```

Real pipeline creation over hundreds of kilobytes of WGSL, and the *wrapped*
calls inside them account for 1.5-5 ms. The gap is that
`createRenderPipelineAsync` and `createComputePipelineAsync` were not wrapped
at all — because they return a promise, which reads as "this does not block".

**The promise covers only the DRIVER's compile.** WGSL parsing, reflection and
layout validation run synchronously on the calling thread inside the call,
before it returns. Both are now spanned as
`gpu:renderPipeline(async call)` / `gpu:computePipeline(async call)`, and they
appear in the offender table by pipeline name.

⚠ The span ends when the CALL returns, never when its promise settles.
Charging a block for the driver's own threads is the opposite error and this
project has made it before (a boot probe that timestamped console lines at
receipt time turned a 7 s boot into a reported 21.7 s). `test:freeze-ledger`
pins both halves — that the synchronous ~25 ms is attributed AND that the
driver's 120 ms is not — and was verified to fail with the wrapper removed.

The device-level wrapper sits below `installAsyncRenderPipelines`, which wraps
`pipelines._getRenderPipeline`, so the two compose.

⛔ NOT DONE, and deliberately: a React `<Profiler>` feeding the ledger was the
other candidate for `(unattributed)`. The data rules it out for these blocks —
they create shader modules, and React commits do not — so it was not added.
An instrument with real overhead does not go in on a hunch.

### 2026-09-07 — UNIT 0.9: WHICH MODULE COSTS THE BOOT

`modules: import + enable` measured 183-1118 ms across boots with 19 modules
enabled, and `module:setup <id>` spans existed but stayed invisible: a freeze
span only surfaces when its work lands inside a long TASK, and an await-heavy
dynamic import mostly waits. Each setup over 30 ms now marks its wall time in
the boot table. The threshold is there because nineteen rows would bury every
other stage, and a 4 ms module is not a lead.

### 2026-09-07 — ⛔ REGRESSION FIXED: THE INSTRUMENT KILLED GI

`giCompute` threw `ReferenceError: kernelSpan is not defined` on **every**
dispatch. The per-kernel span added by unit 0.1 declared its token with `const`
INSIDE the `try` and read it in the `finally` — a sibling scope, not an
enclosing one.

Three things made this much worse than an ordinary bug, and they are the
reason it now has its own test:

- **A `finally` that throws replaces the real error.** `[gi] KERNEL
  BUILD/DISPATCH FAILED for …`, the one line that names a broken kernel, could
  never reach the console.
- **It fired per dispatch.** `#refreshDynamicObjects` calls `giCompute` every
  tick and `#compileWave` calls it throughout a rebuild, so the user saw
  hundreds of identical stacks, `[gi] emitter shadow clear failed`, and
  `async compile wave failed; GI was not committed` — GI never ran at all.
- **Nothing static catches it.** `node --check` passes; a brace-depth scan
  passes too, because a `try` block and its `finally` sit at the SAME depth.
  A heuristic scanner was written for this and thrown away after it failed to
  flag the bug with it deliberately reintroduced.

So `giCompute` is exported and driven directly by `npm run test:gi-compute`
(5 checks, all five verified to fail with the bug back in). The lesson is
narrower than "be careful": **instrumentation on a hot path must not be able
to break the thing it measures**, and a span closed in a `finally` is exactly
where that risk lives.

### 2026-09-07 — FIRST READING FROM PER-BLOCK CAUSES (user's own log)

The unit 0.6 attribution paid off immediately:

```
[freeze] 239 ms — … [rebuilt: first compile x27, material key: ? x21, material key: side x2, …]
[freeze] 164 ms — … [rebuilt: material key: customProgramCacheKey x24, material key: ? x6, first compile x3]
```

▶ **LEAD: `customProgramCacheKey x24` in one 164 ms block.** That field is where
GI appends its roughness bucket (`|gi<bucket>`, `GISystem.js:18303`), and
`giRoughnessBucketOf` is *designed* to change: a material with a roughness map
sits conservatively in bucket 3 until its texture statistics resolve
asynchronously, and `#refreshMirrorBucket` then heals it — which re-mints the
program. So this block is the healing pass, and it is already batched (24 in
one block, ~7 ms each). Not called a bug: what is not yet known is whether it
happens ONCE per scene or repeats across rebuilds. Read `nodeBuildCauses` over
a whole session before touching it.

### 2026-09-07 — ⭐⭐⭐ "GI TAKES A MINUTE TO INIT" = IT WAS RESTARTING, NOT STARTING

User report: *"our GI is still very slow to boot, it takes more than a minute
to init"* and *"no GI still"*. Measured on their Level scene (344 entities,
content 28.2 x 502.5 x 38.2 m), and the boot is not where the time goes:

| | |
|---|---|
| editor ready | **4.9 s** (1.28 s of it blocked) |
| whole-session main-thread block | **4.4 s in 28 tasks**, worst 1 559 ms |
| GI rebuilds | 1 run, 1 ask |

Nothing is blocked for a minute. `profile.frameStats` says what is:

```
lightTreeChanges: { refreshes: 2554, invalidations: 2554, matrix: 2609, count: 1 }
camMotionEma: 1.4e-72,  worldRested: true,  reflectHeldFrames: 1016
```

**The light tree refreshed 2 554 times and invalidated GI's world visibility
cache 2 554 times, with the camera perfectly still and the world at rest.**
Every one of those calls `srcProbes.invalidateVisCache()`, so GI threw away the
cache it needs in order to converge, sixty times a second. It was never
initialising slowly — it was restarting.

**⛔ ONE CONFIRMED CAUSE: AN ABSOLUTE EPSILON AT SCENE SCALE.**
`#refreshLightTree` caches each emissive mesh's world matrix in a
**Float32Array** and compared it against `Matrix4.elements` (doubles) with
`Math.abs(row[k] - e[k]) > 1e-5`. Float32 carries ~7 significant digits, so
above ~256 m the representable quantum is already wider than that gate — and
the round-trip error is CONSTANT for a lamp that never moves, so once it
exceeds the gate it exceeds it on every frame, forever. Measured over 200 000
random coordinates in 256-768 m: **50.8 % trip it**, worst error 3.05e-5.

The tolerance is relative now (`giLightTreePoseMoved`, exported and gated by
`npm run test:gi-light-tree`, 6 checks verified to fail with the absolute
epsilon restored). `__giLightTreePoseEps` is the A/B arm.

⚠ **NOT YET PROVEN TO BE THE WHOLE STORY on this scene.** The tally shows ~1.02
matrix hits per refresh against 56 emissive meshes, i.e. ONE mesh moving — and
if that lamp sits inside the 31 m room rather than out at 500 m, float32 is not
its explanation and something is genuinely moving it. `lightTreeChanges` now
carries `firstMover`, the name of the first mesh that reports motion, so the
next boot answers this instead of inviting another guess.

**▶ WATER IS NOT IMPLICATED HERE.** The user suspected the water work. On this
scene `nodeBuildCauses` carries no `fog` row at all — the medium is not armed —
and materials still cost 33.9 ms mean to build. The GI-heavy cost is GI's own
injection, not the water medium. (Pool, where water IS armed, is a separate
measurement and is not evidence for Level.)

### 2026-09-07 — ⭐⭐ "EVERY MESH I SELECT DISAPPEARS FOR A MOMENT" — FIXED

Reproduced and cured, with a before/after receipt on the same action.

**The mechanism.** `Renderer._renderObjectDirect` skips the draw entirely while
`_pipelines.isReady()` is false, and `isReady` reads the render object's
CURRENT pipeline. `installAsyncRenderPipelines` routes any pipeline over the
size gate through `createRenderPipelineAsync` — so when an already-drawing
material gets a NEW program, its ready pipeline is replaced by a compiling one
and the object is invisible until the driver finishes. Then it pops back.

**What selection changes.** Selecting one mesh in Sponza re-mints its own
material. The per-block cause attribution named the fields:

```
material key: aoNode,colorNode,customProgramCacheKey,emissiveNode — 1 build, 22 ms
syncPipelines: renderPipeline_MeshPhysicalNodeMaterial_138 [async]
```

**The fix: defer a FIRST compile, never a RE-MINT.** They are opposite trades.
A first compile has nothing on screen — deferring costs frames of an invisible
object and keeps the viewport live through a compile wave. A re-mint is on
screen now — deferring swaps a visible object for an invisible one, which is
not a performance win, it is a rendering bug. Receipt, same select-away-and-back
on the same mesh:

| | before | after |
|---|---|---|
| cause | `material key: customProgramCacheKey` x2, 21 ms | identical |
| render pipeline | `MeshPhysicalNodeMaterial_142 **[async]**` | none deferred |

**⛔ THE FIRST VERSION OF THIS FIX WAS WRONG AND ITS TESTS PASSED.** It checked
the previous pipeline inside `_getRenderPipeline` — but `Pipelines.getForRender`
runs `if (previousPipeline && previousPipeline.usedTimes === 0)
this._releasePipeline(previousPipeline)` FIRST, so by then the evidence that
the object was drawing is already destroyed. It passed a unit test that did not
model the release, and changed nothing live: the re-mint still logged
`[async]`. Readiness is captured in a `getForRender` wrapper now, and the test's
fake reproduces the release-then-create order on purpose.

⛔ Drawing the OLD pipeline while the new one compiles was considered and
rejected: bind groups are rebuilt for the new pipeline's layout, so binding them
against the old one is a validation error at best.

`__asyncRenderPipelinesRemint = true` restores the old behaviour, as the A/B arm
for measuring the hitch this trades in.

▶ STILL OPEN: **what rewires `aoNode`/`colorNode`/`emissiveNode` on select.**
The disappearance is cured, but the 20-27 ms rebuild per selection remains and
is pure waste. Merging is not the writer (it is inactive on this scene) and
`loadMaterialAsset` is cached and does not re-apply. The next step is a setter
trap on those three slots, not more reading.

### 2026-09-10 — ⭐⭐⭐ THE 21.5-SECOND BLOCK WAS THE GPU PROCESS, AND EVERY SYNC PIPELINE IS ONE OF THEM

User: *"our editor, and especially GI component, take enormous time to boot,
huge freezes. Even when I simply enable shadow map on the light, it freezes
again. Terrain sculpting is freezing … main thread hanging all the time after
any changes made."*

**The receipt that named it.** The user's own Foliage scene, the live ledger:
`blocked 36 087 ms in 72 tasks, worst 21 528 ms` — and the worst one read
`(unattributed) 21528`, `gpu: null`: no engine span, no wrapped GPU call
inside it. Two more of the same shape on the next boot (14 731 ms, 6 016 ms,
5 367 ms). What the same session's `syncPipelines` table showed beside them:
`renderPipeline_Foliage · living surface_226` ×10, `ShadowMaterial_238` ×14,
`Background.material_179` ×9 — **without** the `[async]` suffix. Those are
the RE-MINTS, and the 2026-09-07 rule made them synchronous on purpose ("defer
a first compile, never a re-mint", to stop meshes vanishing). A sync
`createRenderPipeline` returns at once, but the GPU process executes it in
order on its command thread, so a 70 kB foliage program parks that thread for
its compile and the page's main thread blocks — later, in a task of its own —
the next time the WebGPU wire needs the GPU process to catch up.
`asyncRenderPipelines.js`'s own header had described this mechanism on
2026-09-02; the 09-07 rule re-introduced it for exactly the class of edit the
user was making (a light's `castShadow` = a `lights` wave = every material
re-minted = ten sync compiles).

**Shipped (all gated, all hatched):**

| unit | change | receipt / hatch |
|---|---|---|
| **2.1** the stand-in | `asyncRenderPipelines.js`: a re-mint is deferred AND the object keeps drawing what it drew. three re-mints in two shapes: SAME render object + new pipeline from the same programs (a render-state change) → `renderObject.pipeline` stays on the previous pipeline (same programs = same bind group layout; the 09-07 "bind groups are rebuilt for the new layout" objection is true only of the other shape); NEW render object (a cache-key change — `lights`, `environment`, `fog`, `shadowMap`, a material slot) → the disposed predecessor is PARKED (chain entry removed so `get` can create the replacement, the three resource deletes deferred) and `Pipelines.isReady` draws it — `_geometries`/`_nodes`/`_bindings.updateForRender` + `backend.draw`, deliberately NOT `updateBefore` (a `ShadowNode` re-renders its map there) — until the replacement lands; dropped if a bound texture/storage buffer is gone (the old light's disposed shadow map), on material/geometry dispose, or after a 30 s TTL; a chain of re-mints hands the parked object down | `test:async-pipelines` 23 checks (fakes reproduce `getForRender`'s release-then-create and `RenderObjects.get`'s dispose-then-recreate). `__asyncRenderPipelinesStandIn = false` → the 09-07 rule; `__asyncRenderPipelinesRemint = true` → the 09-02 rule |
| **2.2** the build budget | the main render builds at most `BUILD_BUDGET_MS` (8) of node graphs per frame (`_renderObjectDirect` wrapper: an object whose graph is not built and not in `nodeBuilderCache` waits, its parked predecessor holding the picture); at least one build per frame so a wave never stalls; a one-shot pass (outside `active`) is never budgeted | a nine-material `lights` wave: one 362 ms block → frames of one build each (`Foliage · living surface` 12 builds / 409 ms spread, no block over 60 ms). `__asyncRenderPipelinesBuildBudgetMs` (0 disables) |
| **0.x** the ledger names the stall | `freezeLedger.js`: sync pipeline creations are kept 90 s past their task (`syncCompileLog`), async ones counted in flight; a block that is ≥ 50 % unattributed carries `gpuLoad` — `[GPU process busy? 12 sync pipeline(s) / 56kB WGSL in the last 1s: mipmap-rgba16float-2d-array, renderPipeline_Background.material_136, …; 8 async / 362kB still compiling]`; `profile.freezes.stalls` splits the session's unattributed ms into `waitingOnGpuMs` / `unmarkedMs`. Spans on `queue.submit/writeBuffer/writeTexture`, `createBindGroup/Buffer/Texture`; bytes written per block (`writeBytes`, honouring three's `dataOffset/size`); `installRenderSpans`: `render:scene→canvas` / `render:scene→ShadowMap:2048x2048` / `render:createBindings` / `render:updateTexture` / `render:geometry` / `render:updateBefore` | `test:freeze-ledger` 17 checks. The next spanless block reads as a cause, not a mystery |
| **3.6** byte-stable WGSL | `wgslStable.js`: three names unnamed storage buffers `NodeBuffer_<node.id>` — a process-wide counter — so the same graph produced different text every boot and Chromium's compiled-shader disk cache (keyed on the text) compiled the 80 s GI kernels from scratch each boot (`[gi] SLOWEST PIPELINE: #126 [bvhHitShade] took 80.3s … binds NodeBuffer_55143,…`). Renamed to per-module ordinals at `createShaderModule` (bindings are by `@group/@binding` index; three never reflects a name); `WgslRegistry` scores each boot against the previous one in localStorage — `profile.freezes.wgsl` + `profile.wgsl` (dump a module to diff two boots) | `test:wgsl-stable` 5 checks. Foliage scene, boot 2 vs boot 1: **79 of 84 modules byte-identical, 12 rescued by the rename**; boot 3: 84/100, 15 rescued. `__wgslCanonical = false` |
| **1.x** light in place | `LightComponent`: `castShadow` no longer `onDetach()` + `#buildLight()` (a new `light.id`, a second re-mint wave, a disposed and reallocated shadow map, and a `hierarchy-changed` fan-out to ~20 scene walkers). `#castShadowInPlace` keeps the light/camera/target/GI contract; `castShadow` left `STRUCTURAL_PROPS`; the rare swap fallback emits `hierarchy-changed` itself. `shadowMapType`/`shadowMode`/`csm*` keep the swap — three has no hash bit for them | `test:light-inplace` 11, `test:edit-fanout`. `__lightCastShadowInPlace = false` |
| **(found)** the ambient glow's second context | `ambientGlow.js` rendered the WHOLE SCENE into a 32×21 target 2.5×/s — a second `RenderContext`, so every material carried a second graph and every wave re-minted twice, the second half SYNC (outside `active`). Now `frameCopy.js`: `copyTextureToTexture` from the swapchain in a post-render hook (waits for a PRESENTED frame — `getCurrentTexture()` on an undrawn tick hands out black) + one 4×4-tap quad into the sample target | `test:editor-prefs` (ambient-glow-sample 9). `__ambientGlowFrameCopy = false`. The `renderContext (… → rt:32x20)` cause rows are gone |
| **(found)** the scene thumbnail's third context | `sceneThumbs.captureSceneThumb` rendered the scene into 320×200 on every save (autosave 10 s, throttled 20 s) — `material key: renderContext (… → rt:320x200#8)` ×400 ms waves plus sync 70 kB compiles, twice a minute while editing. Now the same frame copy, centre-cropped | same test file; falls back to the render when no frame is presented within 1.5 s |
| **(found)** terrain sculpt was O(terrain) per dab | `TerrainComponent.applyHeightBrush` re-set every vertex, `computeVertexNormals()` over the whole grid, `computeBoundingSphere()`, a full upload and a re-seat of EVERY scatter layer on every pointermove. Now `#applyHeightsRect`: the box only, exact analytic six-triangle normals for box+1 ring, conservative sphere growth, `addUpdateRange` rows; the O(terrain) tail once in `commitHeights()`; spans `terrain:brush` / `terrain:stroke-commit` / `terrain:scatter`; `terrain.sculpt` (MCP) drives a stroke | `test:terrain-sculpt` 5. On the user's 128-res terrain: 12 dabs **2.9 ms**, commit **5.9 ms**, one 91 ms reaction block (`frame:preRender` — foliage re-layout) |

**Receipts, user's Foliage scene, live editor:**

| | before (09-09 code) | after |
|---|---|---|
| boot, main thread blocked | **19 838 ms in 16 tasks, worst 14 731** | **3 549-5 400 ms in 24-29 tasks, worst 725-939** |
| a light `castShadow` off+on cycle | 5 blocks / **1 322 ms**, worst 366 (loop half asleep) · 13 / 2 943 ms, worst 475 (stand-ins only) | **9 blocks / 764 ms, worst 198**, no node-build block over 60 ms |
| `(unattributed)` blocks with a cause | none | every one ≥ 50 % unattributed names the sync pipelines / async in flight / bytes written before it |
| shader modules byte-stable across boots | unknown (never measured) | **79 / 84 → 84 / 100** |
| a sculpt stroke (12 dabs + commit) | O(terrain) × 12, un-measurable (no op) | 2.9 + 5.9 ms |

**What the receipts say is LEFT (next session, in order):**
1. **The remaining spanless stalls are small first-compiles and big writes.**
   `stalls.waitingOnGpuMs` 700-1 700 ms per boot in 8-13 blocks of 50-200 ms,
   each naming sub-16 kB sync pipelines (`LineBasicMaterial`, `MeshBasicMaterial`,
   `frameCopy:downsample`, `mipmap-rgba16float-2d-array`, `ShadowMaterial_209`
   at 15 kB — just under the gate) plus 7 async in flight, and `writeBytes` of
   10-100 MB per block (texture/instance uploads). Two levers: (a) the size
   gate is a trade of absence for a stall — with parking, a first compile
   OUTSIDE `active` in a REPEATING context (the shadow pass, GI's prepass)
   could go async too, but "repeating" needs a whitelist (a bake target must
   never defer); (b) chunk large `writeTexture`/`writeBuffer` uploads.
2. **`module:setup foliage` 437-497 ms** and a 231 ms `first compile x7` block
   from the foliage warmup's `compileAsync` (builds all of a mesh's programs in
   one task; not on the budgeted `_renderObjectDirect` path) — the foliage
   module's own, and it is another session's WIP.
3. **The GI reflection BVH resync** (`#maybeResyncBvhScene` → `buildBvhScene`
   → `packGeometryBlas`'s `MeshBVH`, synchronous, 200 ms-2 s) after any
   geometry edit — in flight as a worker prewarm (see below).
4. **The 80 s GI kernel compiles themselves** on a GI-heavy scene: the disk
   cache now has a stable key to hit; the first boot after any kernel-text
   change still pays. Unit 3.1 (capacities as uniforms) is what makes the text
   stable across SCENES, not just boots.
5. Unit 4.4 (`#rebuild` as a yielding state machine) is untouched: a rebuild
   is still ~2.3 s of blocks (kernel TSL builds ~100 ms each, `screenGraphs`,
   `bvhScene`).

⚠ **Measurement traps met today:** `profile.frameStats` reports `fps 0 /
loop stopped` whenever the frame pacer has idled the viewport — the edit's
frames still ran (blocks were recorded) — so an fps of 0 during an A/B is not
evidence the edit did nothing. The first `writeBytes` read `10 GB` in a 60 ms
task because three hands the WHOLE attribute array to `writeBuffer` and bounds
the write with `dataOffset`/`size` (elements); the count honours them now, and
carries `writes`/`largestWrite` so a real 100 MB upload and a thousand small
ones read differently. And `profile.freezes {clear:true}` returns the ledger
BEFORE clearing — a batch that clears and edits in one round trip can lose the
edit's blocks; clear first, act next.

### 2026-09-10 — ⭐⭐⭐ THE GI RECEIPT: SPONZA LIT IN 18 s, NOT 93 s — the disk cache serves the kernels now

Two consecutive boots of the user's Sponza scene through the live editor,
same machine, nothing changed between them but the reload:

| | first boot after the rename (cold: every kernel's text had just changed) | second boot |
|---|---|---|
| `[gi] compile wave: materials warmed` | **93 216 ms** to the first field pass | **17 662 ms** (field first pass at 18 181 ms) |
| `[gi] SLOWEST PIPELINE` | `bvhHitShade` **80.3 s** (272 kB) | `resolve` **14.4 s** (52 kB); 250 s summed over 134 pipelines |
| `profile.freezes.wgsl` | 291 modules, 145 renamed; 89 canonical hits (the Foliage boot before it had no GI kernels) | 212 modules, **193 canonical hits, 63 raw hits — 130 rescued by the rename** |
| still unstable | — | 8 `fragment` modules of 17-75 kB (GI-injected MeshPhysical fragments: their text still moves between boots — dump two boots with `profile.wgsl` and diff; the next stability unit) |

The 09-09 memory had this scene lighting at 73 s and called the 80 s
`bvhHitShade` compile the wall; the wall was the cache never being asked
the same question twice. What is left on a GI scene is the REBUILD block
itself — `[freeze] 2997 ms — gi:kernel build src:glossy gather 422,
gi:rebuild/staticBvhBuild(SAH) 305, src:shade + bounce [J] 193,
src:merge#7 191 …` — one synchronous `#rebuild` plus the first frame's
kernel graph builds in the same task: unit 4.4, untouched, now the largest
single block on any GI scene.

**Also shipped in this entry (agent, gated):** the GI reflection BVH's
per-geometry `MeshBVH` pack is keyed on content revision (it served a STALE
BVH after an in-place edit — terrain sculpting — before) and is built in a
thin in-repo worker (`src/modules/gi/bvh/bvhBlasWorker.js`; three-mesh-bvh's
own `GenerateMeshBVHWorker` transfers the live geometry's arrays away for the
build, so it cannot be used on a drawing mesh); `#maybeResyncBvhScene` waits
for the prewarm before its synchronous `#syncBvhScene`. `test:gi-bvh-worker`
6 checks, the cache test verified to fail against the identity-only cache;
`__giBvhWorker=false` / `__giBvhPrewarm=false`. ⚠ Not yet observed live on a
sculpt of a GI-enabled terrain (the user's Foliage terrain has GI disabled).
