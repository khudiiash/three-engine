# GI §19 — THE SCALE PLAN (2026-08-26)

**Mandate (user):** GI must run 60+ fps on every device including phones, light
must appear within 2-3 s of scene load, no blockiness / patches / leaks, no fps
drops while the camera moves, fully dynamic, scenes of several hundred metres.
Bistro today: 2+ minute init, 5-10 GB memory, blocky patches on rotation, dies on
mobile, dark and slow on Safari. "We must find what exactly we are doing wrong."

This document is the answer, in four parts: what is measurably wrong (§1-2),
what the field does about it (§3), the target architecture (§4), and the staged
units with gates (§5). The previous plan doc (`GI_SPATIAL_REBUILD_PLAN.md`,
§1-18) is the history; this one supersedes its "next unit" lists.

---

## 0. THE VERDICT IN ONE PARAGRAPH

The current GI builds **the whole scene** before it lights anything — a dense
occupancy grid over the scene AABB, surface-record and exact-triangle pools
sized by scene triangles, a static BVH8 over every triangle, ~320 compute
pipelines and ~100 material variants of 200 kB GI-injected WGSL — all on the
main thread in one synchronous tick, then it lights the frame through a hashed
probe lattice whose per-frame cost is proportional to its *allocated* pool and
whose fresh cells are displayed at 0.35-0.8 m the instant they appear. Every
complaint follows from that shape: init time and memory scale with the scene
(not the view), camera travel re-voxelizes the scene, rotation evicts probes
that come back as blocks, one-bit isotropic voxels cannot stop a wall thinner
than a cell, and a phone dies on allocations sized for a workstation. Tuning
cannot fix a scale law. The field (Lumen, AMD GI-1.0 / Brixelizer GI, Godot
HDDAGI, Tencent SmartGI — the last runs all of its GI in <2 ms on 2023 phones
in <30 MB) converged on one shape: **a camera-centred toroidal clipmap of
sparse occupancy bricks with face bits, a hierarchical bit-DDA for every ray,
screen-space probes as the final gather, a world radiance cache for off-screen
bounce, and fixed per-frame budgets for everything.** That is what we build,
in stages that each pay on their own, while the bleeding in the current system
is stopped first.

---

## 1. BASELINE RECEIPTS (live Bistro, ultra, 1694×996, 2026-08-26)

Measured on the user's running editor (3 assistant sessions attached — magnitudes
inflated, structure valid). Memory: [[gi-bistro-baseline-0826]].

| receipt | value |
|---|---|
| fps / cpuMs / gpuMs | **6 / 197 / 38.4** — CPU-bound 5× |
| CPU phases | renderEncode **107.5 ms** (453 draws → 237 µs/draw; the known floor is 40-50), preRender 69.8 of which **gi.gbufferPrepass 50.4** (54 draws + `#gbufferFingerprint` full traverse) + gi.screenChain 17.6 |
| draws | main 343 (112 materials, `floorIfMerged` 10) + shadow 55 + GI gbuffer 54 |
| JS heap | **6.7 GB** |
| textures | 1104 MB: renderTargets 512 (`giBvhAtlasBlit` 72 MB @3072², 5× 64 MB 4096² shadow maps), 127 orphans 446 MB |
| compile wave | **323 pipelines / 155 s**, plus a SECOND concurrent wave 256 / 168 s; `bvhHitShade` 110 s alone (182 kB WGSL, 331 ifs); 79 kernels = 1468 kB WGSL; materials 27 s |
| occupancy | `bits` **491 MB** (readback skipped); records 1.89 M / 2.1 M; field first pass at **158.7 s**, 678 of 1895 frames BLOCKED |
| BVH | 516 eligible meshes > the 128-mesh cap; 389 dynamic meshes > 8 coverage slots |
| SRC | store 192 MB; c0 6779 / 32768 live (10 %); isolated pass ms: deposit-decay 30, deposit-resolve 24, shade 11, trace 10.7, merge 7.6, gather 6.4 |
| screen | emitterShadowPass 10-20 ms (4 emitters), resolve 5.5, bvhReflect 5.0 |
| churn | 8 governor resolve-resize REBUILDS in 3 min; 29 shadowMerge rebuilds by `gi-layer-tags` (the R4b drain loop) |

Tier tables that produce this: occupancy budget {8e6/16e6/32e6/64e6} cells at
0.1 m over the WHOLE scene AABB, capped by `MAX_AXIS_RES = 128`
(`GISystem.js:1026, 10319-10322`) → Bistro gets a 0.86 m voxel at every tier;
SRC `spacing0` {0.8/0.6/0.45/0.35 m}, 4 cascades, `transportRays`
{32k/65k/131k/393k}, `BIN_BUDGET` 2.8 M (`srcConfig.js:511-514, 861`).

---

## 2. DIAGNOSIS — EACH COMPLAINT, ITS MECHANISM, ITS RECEIPT

Nine read-only audits (5 code, 3 research, 1 dead-code census) were run on
2026-08-26; this section is their synthesis. File:line refs are from those
audits.

### 2.1 "Bistro initializes for over 2 minutes"

1. **The material compile wave.** GI is compiled INTO every lit material's
   fragment shader (`giMonitorNode`, `#markObservedMaterial`
   `GISystem.js:14607-14633`; `giCompileVariantKey` `:465-474`). Bistro = ~100+
   variants × 180-250 kB WGSL, each parsed on the main thread and compiled by
   the driver; `materials 27241 ms` live. A second full wave fires whenever the
   structural signature changes (tag flips → `shadowMerge.invalidate` → rebuild,
   `:14502`, `:1433-1446`) — the console shows two waves running concurrently.
2. **One synchronous `#rebuild` tick does all CPU geometry work**
   (`:10227-11115`): `buildStaticSceneBvhWords` (world-space soup of every
   static triangle + SAH `MeshBVH` + BVH8 repack, `dynamicObjects.js:548-604`,
   ~780 MB transient), up to 128 per-geometry `MeshBVH` builds
   (`bvhScene.js:109`), the per-triangle voxelizer work list
   (`occupancyField.js:4655-4715`), ~700 MB of CPU typed arrays, the full TSL
   graph. No worker exists anywhere in `src/` (`grep "new Worker"` → 0).
3. **Kernels bake scene constants into WGSL**, so the browser's content-keyed
   shader cache never hits across scenes or rebuilds: occupancy `offset/res/
   wordsPerRow` at 29 sites (`occupancyField.js:963-976, 1192-1210`),
   `probeBase/probeCapacity/hashCapacity` at 21 sites (`srcProbes.js:1444,
   1481-1492`), dispatch counts baked by `.compute(N)`. three keys pipelines on
   `computeNode.id`, so a rebuild recompiles byte-identical WGSL (15 of 323
   in the live log). The 182 kB `bvhHitShade` kernel took 110 s.
4. **No coarse-first path.** `_fieldReadyOnce` flips only after the whole
   occupancy chain (clear → voxelize → downsample ×4 → fit) ran unskipped in
   one tick (`:3629, 3695-3736`); any dispatch whose pipeline is still
   compiling is skipped and re-armed. Nothing lights until everything exists.
5. **Post-boot churn re-enters boot:** R4 roughness-floor readbacks drain
   after first light, flip layer tags, `#collectMeshes` →
   `shadowMerge.invalidate("gi-layer-tags")` → another rebuild (`:2401,
   14502`); the governor's resolve-resize re-mints pipelines (8 rebuilds in
   3 min live).

### 2.2 "Memory 5-10 GB"

The occupancy **pyramid is 110 KB**. The 449-491 MB `bits` buffer is a union
(`occupancyField.js:536-616`): surface records (2.16 M × 16 B = 35 MB),
**exact-triangle pool** (3.6 M × 36 B = 129 MB, ceiling 189), `surfScratch`
(86 MB, build-only, never freed), attribution/palette (17 MB), static BVH8
region (188 MB at 1.5× headroom) — and every `instancedArray(new Uint32Array)`
keeps its `.array` on the JS heap forever (`grep "\.array = null"` → 0). Then:
a static-BVH **staging duplicate** never released (`dynamicObjects.js:1874-
1880, 2214`; +125-160 MB GPU and CPU); voxelizer inputs 180-270 MB; the SRC
bin store 171 MB; `voxelizeOnce.js:358-361` copies every geometry (~86 MB);
`buildStaticSceneBvhWords` ~780 MB transient per rebuild, run again on the
UV-drop ladder rung; the `makeField` ladder mints up to 4 fresh 450 MB `bits`
arrays before dropping the previous (`GISystem.js:15361-15390`);
`occupancyField.dispose()` is `{}` (`:5486`); the resize / pool-grow /
geometry-revision swap sites have no `releaseComputeNodes` sweep, so each
orphans its generation in `renderer._bindings`. **Triangle data lives 6×.**
Steady state ≈ 1.4-1.6 GB GPU + 1.2-1.4 GB heap, + 0.8-1.5 GB transients per
rebuild, + orphaned generations → the 6.7 GB heap.

### 2.3 "Blocky patches and lag when the camera moves in Bistro"

1. **Follow-slide re-voxelizes the whole scene.** On any scene > 60 m
   (`DETAIL_TRIGGER`, `:1051`) the detail box follows the camera; every ~6 m
   of travel `#detailFollowTick` (`:15008-15060`) → `#refitInPlace` →
   `occField.refit()` sets `staticDirty` (`occupancyField.js:5261-5266`) → the
   FULL occupancy chain over every static pair next tick (`:5010-5018`), plus
   `#collectMeshes` and a 1.2 s α / ray-budget window that re-equilibrates the
   whole field ("patches updating").
2. **Block starvation + 8-frame eviction.** c0 blocks are capped at
   `BIN_BUDGET/4/32 = 21875` while the hash has 32768 slots
   (`srcConfig.js:861, 875-881`); Bistro sits at that ceiling, so inserts drop
   every frame and `crowdT → 1` collapses retention to 8 frames
   (`srcProbes.js:789-806`). A rotation swaps the visible set; probes behind
   the camera die and return as cold, seed-only blocks.
3. **Fresh cells display immediately at s₀ resolution** — the first frame's
   ~6 rays + parent seed, faded in over 30 frames with a 0.2 floor
   (`srcTiles.js:259-279`), trilinear over 0.35-0.7 m cells
   (`srcScreenGather.js:282-305`). That IS the block.
4. **Two extra full-scene rasters per moving frame** (gbuffer + mirror mask,
   `giScreen.js:287, 315`), held only when the camera is byte-identical, in a
   draw-bound scene.
5. **Capacity-proportional sweeps regardless of visibility**: age / decay /
   seed / resolve / merge / tiles iterate the full pool every frame (`srcDeposit.js:980,
   1474`, `srcMerge.js:480, 618`, `srcTiles.js:297-302`) — the fixed GPU
   floor that does not shrink with the traced-pixel budget.
6. **CPU per frame that scales with the scene**: `#gbufferFingerprint` full
   traverse every frame, `#collectMeshes` every 5 frames, three O(slots)
   transform refreshes, `giMonitorNode` forcing `needsRefresh` on every render
   object every frame (§18 F2), ~60 `queue.submit()` per frame (F4).

### 2.4 "Light leaks through thin walls"

The occupancy cell is **one bit, isotropic, no face / thickness / normal data**
(`occupancyField.js:1-66`); voxelization is conservative SAT so a thin sheet
lands ~2 voxels thick; the ray trace itself was measured sealed (`THICK=0.05
test:gi-sunleak` = 0.00000 leak). The leaks are on the **probe side**:
(1) the gather evaluates 8 trilinear corners at the raw pixel position with no
visibility term — normal-weight exp 0, LOS weight opt-in, normal bias 0
(`srcScreenGather.js:266-273`, `srcMath.js:516-570, 647`); (2) c1/c2 cells
(0.7-1.4 m) straddle interior walls and the merge reads 8 parent corners with
no visibility (`srcMerge.js:340-410`); (3) probes are inserted at the nearest
lattice point with no occupancy check, so a point within s₀/2 of a wall is the
c0 probe for BOTH rooms (`srcProbes.js:1249-1255, 1331`); (4) one surface
record per voxel = one fitted normal + one albedo for both faces of any wall
thinner than 2 cells (85 of 122 meshes on the Level; `:11285-11320`); (5) the
voxel is 0.4-0.8 m at scene scale because of `maxAxis/128`, so the 2-voxel
bulge and the 1-voxel bias band swallow a room's clearance.

### 2.5 "On mobile everything disappears; on Safari GI is dark and slow"

1. **IBL is blacked out the moment the field DISPATCHES**, not when the
   transport is proven alive (`giLive` → `_envIblBlack`, `GISystem.js:2183-
   2224, 3629`). Any kernel a phone or WebKit refuses leaves direct light +
   screen emissive only — exactly "dark" and "everything disappears, only the
   sky remains". WebKit runs a failed-compile pipeline as a **silent no-op**
   with no error (WebKit 319770); `device.onuncapturederror` property never
   fires in WebKit (three uses the property).
2. **Unaudited envelope**: the portable audit counts storage buffers only;
   uniform buffers per stage (baseline 12; the hit-shade kernel needs 16) and
   storage textures (Safari floor 4) are not censused; raw `wgslFn` kernels
   pass `ptr<storage, …>` parameters (`dynamicObjects.js:612, 720, 842, 980`,
   `bvhGpu.js:156`, `bvhScene.js:215`) — the `unrestricted_pointer_parameters`
   language feature — and `navigator.gpu.wgslLanguageFeatures` is never read.
3. **No total memory budget.** Nothing checks the sum against
   `maxBufferSize` / device memory before building; `bits` is ONE binding
   that exceeds the 128 MiB mobile binding limit on real scenes; the SRC bin
   store throws at 128 MiB (`srcDeposit.js:486`). On `device.lost` the engine
   rebuilds GI at the SAME size (`Engine.js:593-605`, `GISystem.js:1354`) — a
   loss loop. Safari's `maxBufferSize` floor is **256 MB**; iOS page memory
   350 MB-1 GB by model.
4. **Wrong shape for a TBDR GPU**: every screen pass is a 1-D `[64,1,1]`
   dispatch; the gather does 8 hash lookups + 8 atlas taps per shell per pixel
   (random storage reads, the worst pattern for Apple/Mali/Adreno caches);
   pools are not tier-keyed so the capacity sweeps run at desktop size.

### 2.6 The CPU truth that GI cannot fix alone

Even with GI at zero, Bistro submits 343 main + 55 shadow draws ≈ 16 ms CPU at
the engine's 40 µs/draw floor. 60 fps on Bistro on desktop needs the raster
side too (§18 F2 shared UBO, F4 submit batching, F5 merge coverage —
`floorIfMerged` says 343 → 10). On phones Bistro (7 M tris) is not a target
scene; the phone target is the Level-class scene.

---

## 3. WHAT THE FIELD DOES (research digest, sources in §7)

| system | world structure | transport | gather | first light | memory | motion | thin walls | mobile |
|---|---|---|---|---|---|---|---|---|
| **Lumen** (UE5 SW) | global SDF = 4 sparse clipmaps of 256³ (8³ bricks, 1 B/voxel), mesh SDFs ≤ 2 m; surface-cache cards (offline) | SDF sphere march; screen HZB trace first with step-back hand-off | screen probes 1/16 res, 8×8 oct, temporal + 3×3 probe filter; world radiance cache 4 clipmaps | fixed 512² card texels/frame — seconds | window-bounded | fixed update cost, variable latency | expand ½ voxel diagonal (over-occludes); walls ≥ 10 cm | Android HWRT only; 30-40 fps on G720 |
| **AMD GI-1.0** | hash-grid world cache keyed by pos+dir, distance LOD | RT | screen probes 1 per 8×8, 4-frame upscale | frames | window | fixed | `(rayLen < cell)` hash bit | – |
| **Brixelizer GI** | cascades of 64³ voxels, 8³ R8 SDF bricks (512 B), toroidal partial updates | sphere march in bricks | screen probes 8×8 + 256³ radiance atlas of 4³ bricks fed from last lit frame | frames | 110-500 MB | k bricks/frame | brick per thin wall | – |
| **Godot HDDAGI** (draft) | cascades of voxel occupancy bitmasks + **6 facing bits/voxel** | hierarchical DDA | probes per cell with 4-bit occlusion ×8 | – | low | local updates | facing bits stop tunnelling | – |
| **Tencent SmartGI** (SIGGRAPH 24) | 0.5 m voxels, 8³ bricks, 4³ brick groups, **64-bit presence masks**, 6 face bits, 512×512×128 m in < 30 MB | 64-bit HDDA | face atlas, n rays/face | k bricks/frame, frustum first — ~1 s | **< 30 MB** | delete out-of-range bricks | face bits | **all GI < 2 ms on 2023 flagships** |
| **DDGI / RTXGI** | probe grid, scrolling volumes | RT, 256 rays/probe | Chebyshev visibility + relocation | – | 1.5 KB/probe | leapfrog planes | leaks when a wall < depth texel | Vulkan RT only |
| **VXGI** | clipmap 3-5 × (64-256)³, 6-dir opacity | cone trace | per-pixel cones | full revoxelize/frame | 12 MB-2.5 GB | toroidal slabs | "make walls thicker" | no |
| **3D radiance cascades** (ours) | lattice / hashed pools | DDA | trilinear over cascades | scene build first | M₀ ∝ scene³ | re-anchor / evict | trilinear leaks | – |

Three facts decide the design:

1. **Leaks are a separability + interpolation problem, not a thickness
   problem.** A 6-separating voxelization with an entry-face bit test makes a
   5 cm wall opaque inside a 50 cm cell by construction (Laine 2013; Godot
   HDDAGI; SmartGI). Anisotropic front-to-back mips (Crassin 2011) keep it
   opaque at coarser levels. Probe-side leaks need a visibility term per
   corner (DDGI Chebyshev / Godot 4-bit occlusion / Unity validity mask) — and
   screen probes sitting ON visible surfaces have no world-space leak path at
   all.
2. **Memory and init must be bounded by the camera window, never the scene.**
   Every shipping large-world system streams a fixed number of bricks per
   frame into a toroidal window; none builds the scene first.
3. **Fixed per-frame budgets, variable latency** (Lumen's phrase) is the only
   way to promise "no fps drops": k bricks voxelized, k probes traced, k cache
   entries relit — constant cost, and the only thing that varies is how fast
   distant light converges.

The one accepted trade (stated by AMD and Tencent): without offline surface
cards, bounce colour for a surface converges through the probe rays that hit
it, so it appears over frames rather than instantly. Our hit shading (albedo
palette × sun-visibility × emitters via the light tree) already feeds that
cache from rays, not from the screen, so off-screen bounce is covered.

---

## 4. TARGET ARCHITECTURE — "GI2"

Built beside the current path (new files under `src/modules/gi/window/`,
`…/probes/`), cut over when it passes the battery, then the SRC + dense
occupancy + record pools are deleted wholesale (~35 k lines).

### 4.1 The window (world structure)

- **Camera-centred toroidal clipmap** of L levels of 64³ voxels each
  (desktop: 0.25 / 0.5 / 1 / 2 m → 16 / 32 / 64 / 128 m windows; ultra adds
  4 m / 256 m; phone: 3 levels at 48³ or 64³, 0.5 / 1 / 2 m). Toroidal
  addressing: a fixed world point always maps to the same cell; camera
  translation invalidates only the entering slab; rotation invalidates
  nothing.
- **Per voxel: 2 bytes.** Byte 0 = occupancy bit + 6 face bits (a triangle
  crossing that face) + 1 spare (two-sided/foliage). Byte 1 = albedo/emissive
  palette index (the existing per-material average machinery,
  `voxelizeOnce.resolveMaterialSurface`, GPU-resolved for KTX2). 64³ × 2 B =
  512 KB per level; whole window ≤ 2.5 MB.
- **Brick presence masks**: 4³ voxels per brick, 16³ bricks per level, one
  `vec2<u32>` per brick (WebGPU has no u64) → 32 KB per level. The DDA skips
  empty bricks at this level.
- **Static + dynamic layers.** Static voxels persist; movers (`dynamicObjects`
  adoption today) are re-voxelized every frame into a dynamic bitfield of L0-L1
  only (their brick count is small), OR'd at trace time; skinned meshes as
  proxy boxes (existing `skinnedProxy` box arm). Spawns/despawns touch only
  their bricks.
- **Voxelization = the existing 13-axis SAT compute** (`occupancyField.js:983-
  1135`) scoped to (brick, triangle) pairs, **k bricks per frame, frustum
  first then by distance, coarse level first** so the whole window has
  occupancy within the first frames and L0 refines behind it. Triangle
  binning: a coarse uniform grid of triangle ranges (cell = 4 m) built ONCE per
  scene in a **Web Worker** from the packed soup (transferable
  `Uint32Array`); the soup is uploaded per grid cell as cells enter the window
  (phones never hold the whole soup). Sizing at Bistro: soup 108 MB desktop
  (fits one binding); phone budget is enforced by the tier, not by hope.
- **Radiance cache**: an R11G11B10 3D atlas of 4³ bricks (desktop 256³ =
  64 MB, phone 128³ = 8 MB) holding 6-direction radiance per occupied voxel,
  allocated per occupied brick from the presence mask; fed by (a) every probe
  ray hit's shaded radiance (running average) and (b) last frame's lit screen
  pixels injected into their voxels. This is what survives rotation, what
  gives multibounce, and what far rays read.

### 4.2 Transport (every ray in the system)

- **Hierarchical bit-DDA**: brick mask → voxel bits, entry-face test on the
  face bits, one storage buffer, no workgroup memory. Level = the level whose
  voxel matches the ray's distance from the camera (trace L0 until the ray
  leaves its window, continue in L1 …), Brixelizer-style.
- **Screen-space first segment** for rays that start on visible surfaces:
  closest-HZB stackless walk over the gbuffer depth, relative thickness
  ≈ 0.1, **step back to the last unoccluded point and hand off** to the DDA
  (Lumen's rule — one ray, two segments, no double counting). This is the
  user's "ray-splitting hand-off", and it is what makes contact-scale
  occluders (table legs, door frames) exact.
- **Hit shading** = palette albedo × (sun × DDA shadow ray + emitters via the
  existing light tree NEE + cached irradiance at the hit voxel) + emissive.
  The current `srcShade [J]` maths, minus the record pools.
- **Mip filtering** of the occupancy/face bits for coarser levels is OR along
  the axis (anisotropic), never average.

### 4.3 Final gather: screen probes

- One probe per 8×8 pixel tile at resolve res (desktop ultra 1650×970 →
  ~25 k probes; phone 16×16 tiles at 720p → ~3.6 k), placed on the gbuffer
  depth (Hammersley pick inside the tile, prefer the tile's dominant plane).
- Each probe holds an 8×8 octahedral radiance map (+ hit distance) — 64
  directions; traced **N rays per frame by tier** (low 8 / medium 8 / high 16
  / ultra 16, jittered so the 64 fill over 4-8 frames), accumulated **in probe
  space** with world-position + normal validation and GI-1.0's biased
  hysteresis (drop history hard when the world position moved). This is the
  only temporal term; AO stays GTAO with no history (user rule, 08-26).
- 3×3 probe-space filter; per pixel: 4 nearest probes weighted by plane
  distance + normal agreement, integrated against the pixel normal (cosine
  lobe over the oct map, or SH2 per probe on phones).
- Output = the same two screen textures the materials already consume
  (diffuse irradiance, glossy) — see 4.5.

Ray budget: ultra 25 k × 16 = 400 k rays/frame (today: 393 k transport rays +
60 k shaded hits), phone low 3.6 k × 8 = 29 k. A hierarchical bit-DDA ray is
cheaper than today's record-aware march; SmartGI/HDDAGI receipts put the
whole transport at 1-2 ms.

### 4.4 Reflections, AO, emitters

- **Mirror/sharp reflections** (high/ultra desktop only): keep the one-BVH8
  exact path (`traceStaticBvhSlot`) for the masked mirror pixels; the BVH
  build moves to the Worker (B1) and is skipped below `high`. Rough/glossy and
  all phone tiers: trace the reflection direction in the window and read the
  radiance cache (cone by roughness through the levels).
- **AO**: GTAO as shipped (`#armGtaoPass`), plus the HZB screen segment's
  contact term.
- **Emitters**: direct emissive light stays analytic in materials
  (`emitterDirectAt`) + light tree NEE at ray hits. The `emitterShadowPass`
  (10-20 ms at 4 emitters today) is replaced by NEE at the PROBE with a DDA
  shadow ray (soft at probe resolution) — or kept only at ultra. Decided by
  measurement in Stage 3, not now.

### 4.5 Materials (the boot lever that is independent of everything else)

GI reaches a material as **two screen-texture samples + one small shared
function** (emitter direct term over a UBO of ≤ 4 slots). Everything else
that `giLight.js` injects today (`:1564, 1973`; 180-250 kB per variant) leaves
the material. Consequences: the material wave collapses to cacheable small
variants; `giMonitorNode` (`needsRefresh` on every object every frame, §18
F2) is replaced by a shared per-frame render-group UBO; the variant key stops
depending on GI state.

### 4.6 Budgets and the portable envelope (hard, tier-keyed, no knobs)

| | phone low | medium | high | ultra |
|---|---|---|---|---|
| levels / voxel₀ | 3 / 0.5 m | 3 / 0.5 m | 4 / 0.25 m | 5 / 0.25 m |
| window GPU | ≤ 4 MB | 4 MB | 6 MB | 8 MB |
| radiance atlas | 8 MB | 16 MB | 32 MB | 64 MB |
| probe tile / rays | 16 px / 8 | 16 px / 8 | 8 px / 16 | 8 px / 16 |
| probe buffers | ~4 MB | ~8 MB | ~26 MB | ~26 MB |
| bricks voxelized / frame | 64 | 128 | 256 | 512 |
| **total GI GPU** | **≤ 48 MB** | ≤ 64 MB | ≤ 128 MB | ≤ 192 MB |
| kernels | ~14 | ~14 | ~18 | ~20 |

Envelope every kernel must satisfy (Safari/iOS/compat floors): ≤ 6 storage
buffers and ≤ 3 storage textures per pass, no single buffer > 128 MiB, no
workgroup memory > 8 KB, 2-D 8×8 dispatches for screen passes, no
`unrestricted_pointer_parameters`, no subgroups / f32-filterable / read-write
storage textures, fp16 textures, ONE submit per frame for the GI chain (WebKit
stalls on many small command buffers — 311598). WGSL text contains tier
constants only (never scene numbers) so the browser's shader cache hits across
scenes.

---

## 5. STAGES AND UNITS (each stage pays on its own; gates are receipts)

Order = leverage ÷ risk, with the bleeding stopped first so the user's daily
work is bearable while GI2 is built. Sizes are rough session counts.

### Stage 0 — STOP THE BLEEDING (current path; ~2-3 sessions)

**✅ SHIPPED 2026-08-26/27 on branch `gi19-stage0` (worktree `../engine-gi19`):**
`bbc4734` 0.1 cut (−5155/+791, 0 regressions; CPU oracles + gather
experiments kept until Stage 4) · `1087240` 0.2 memory (25 CPU mirrors
detached = 662-759 MB, sweeps at 3 swap sites, `occupancyField.dispose()`,
allocate-once ladder; per-rebuild climb 3294→1948 MB — residual = 0.2b) ·
`0891a93` + `690eaa2` 0.5 (hitShade scene constants → uniforms; loop roll
11→5 BVH descent sites, compile 2.1×; EVERY screen kernel byte-identical
across resolutions + `setSize` APIs; recapture schedule) · `3a82272` 0.3
loops (GI tag bits out of shadowMerge's key, drain parks, resize settle-gated
5 hops +276 pipelines/+555 MB → 0/0, concurrent waves coalesced) · `222e9e8`
0.4 mobile safety (IBL waits for a proven transport, tier drop on real
device.lost, tier GPU byte budget + refuse-with-IBL, 3-axis census, WGSL
pointer feature check). ▶ 0.3b wiring (resize without re-mint, recapture
at steady, hitShade dispatch deferral) and 0.2b (residual GPU-generation
climb) in flight; then the Bistro boot/heap measurement and merge to main.
⚠ Instrument lessons: a single `test:gi-hit-shade` run has a 6.5% between-
boot spread — quote 3-rep paired means at SETTLE=40000 only; a junctioned
`node_modules` needs a private vite `cacheDir` per server.


| unit | what | gate |
|---|---|---|
| **0.1 dead-code cut** (⚠ scope refined 08-26 evening: the CPU oracles — `srcRef.js`, `srcVolumeRef.js`, `RayHitPacking` mirrors, `lightTree` sampler, `RayHitValidator/Debug` — and the gather experiments STAY until Stage 4; they gate SRC kernels that 0.2 still touches. 0.1 cuts retired ARMS, their hatches, knobs and banners: ≈ 4-5 k lines now, the rest at cutover) | delete the census list: retired AO pair (~750 lines), RTAO arm (~440), incumbent per-mesh BLAS reflections (~600), sun split (~250), §12.90 adaptive lattice (~200), gather experiments (world keys / smooth / LOS / normal weights, ~500), non-default light-shadow arms (~350), parked mover occluders (284), skinned capsule arm (~110), CPU refs `srcRef.js` (1720) + `srcVolumeRef.js` (418) + `RayHitPacking` CPU mirrors (~1300) + `lightTree` CPU sampler (~500) + `bvhGpu.js`/`RayHitValidator`/`RayHitDebug` (617), the 19 comment-only flags, the 106 numeric knobs' non-default arms, the 15 ≥ 40-line retired-mechanism banners in GISystem.js. ≈ 7.5-8 k lines. Tests that only exercised deleted arms are deleted with them; `package.json` scripts pruned. | module ≤ 53 k lines; `npm run test:gi-*` battery green minus the deleted gates; Bistro/Level/Cornell render identical (`__giColourProbe` receipts) |
| **0.2 memory** | detach CPU twins after upload (`.array` → 0-length view once flushed; verify the incremental `setGeometry` writes at `occupancyField.js:4859-4894` first); release the static-BVH staging (`dynamicObjects.js:2214`); free `surfScratch`/`attrScratch` after the fit; `releaseComputeNodes` sweep at the resize / pool-grow / geometry-revision swap sites; implement `occupancyField.dispose()`; drop the `voxelizeOnce` geometry copy; compute the `bits` size arithmetically so the `makeField` ladder allocates once | Bistro heap **< 2 GB** settled, no climb over 10 min of orbit (`profile.frameStats.jsHeapMB`); `profile.textures` orphans < 50 MB |
| **0.3 rebuild loops** | R4b drain no longer calls `shadowMerge.invalidate("gi-layer-tags")` (tags are GI-private; give the depth key its own bit); governor resolve-resize re-binds targets without a rebuild (or the governor stays OFF — [[frame-governor]]); the second concurrent compile wave cannot start while one is active | `giRebuilds.runs` = 1 per scene open; `shadows.mergedRebuilds` stops climbing |
| **0.4 mobile safety** | IBL blackout only after a transport tally > 0 (gather/tile counters); `device.lost` → drop one tier and rebuild, never same size; total GPU byte budget per tier BEFORE `createOccupancyField`/bin store, clamping pool ceilings and the prefs hint; `#auditPortableBindings` covers uniform buffers + storage textures and FAILS the build; `wgslLanguageFeatures` check with a TSL fallback for the six `wgslFn` kernels; `addEventListener('uncapturederror')`; `probe:gi-portable` runs under Playwright WebKit | portable arm: 0 kernels over any limit; a scene that cannot fit drops tiers instead of dying; WebKit run reports a non-zero transport tally |
| **0.5 boot triage** | `bvhHitShade` 182 kB → roll its inlined slot loops (the §13.14.5 per-inline law; 110 s is one kernel); uniformize the 50 baked scene constants so cold boots produce byte-identical WGSL (re-diff two cold boots — the gate is the diff, not a code reading); gate reflection-probe capture + BVH reflection kernels on a consumer existing | Bistro warm compile wave < 30 s, cold < 60 s; two-cold-boot WGSL diff = 0 lines |

### Stage 1 — MATERIALS OUT OF THE WAVE (~1-2 sessions; shared by both paths)

**Corrections from the 08-27 analysis (AUDITS §J is the spec):** a shipping
material's GI text is ~30-45 kB, not 180-250 (that was the pre-`sharedFn`
number); the bulk is two nested `sampleReflectionProbes` expansions + two
bilaterals; `emitterDirectAt` is NOT in a shipping material (deferred arm).
`giMonitorNode` forces `needsRefresh` because GI uniforms default to
`objectGroup` (cloned per render object) — the fix is `.setGroup(renderGroup)`
first, marker deletion second, same commit; the moved-lamp gate has NO
receipt today (add a pixel test before deleting the marker). The "~100+
variants" was a uuid count; the pipeline key multiplies by GI's 4 buckets.

| unit | what | gate |
|---|---|---|
| **1.1 thin material hook** | per §4.5: two texture samples + emitter-direct over a ≤ 4-slot UBO; measure one material's WGSL with GI off / on before and after | GI-on material WGSL ≤ GI-off + 8 kB; Bistro material wave **< 3 s** |
| **1.2 shared frame UBO** | GI's changing uniforms in one per-frame render-group UBO; `giMonitorNode` removed; the moved-lamp harness still passes | renderEncode ≤ 40 µs/draw on Bistro (`profile.cpuFrame`) |
| **1.3 walks** | `#gbufferFingerprint` / `#collectMeshes` / `fingerprintCasters` replaced by one engine content key bumped by the existing events (§18 F3); GI compute nodes submitted as one array when no pipeline is pending (F4) | gi.gbufferPrepass CPU < 3 ms parked, < 6 ms orbiting |

### Stage 2 — THE WINDOW (~3-4 sessions; new files, old path untouched)

| unit | what | gate |
|---|---|---|
| **2.1 clipmap store + toroidal scroll** | levels, 2 B/voxel, brick masks, static/dynamic layers, tier table; instrument `profile.gi2.window` (bricks resident / voxelized this frame / pending, bytes) | memory ≤ table; scroll re-voxelizes only the entering slab (counter) |
| **2.2 worker triangle grid** | `new Worker` infrastructure (Vite dev + Tauri build); packed soup + 4 m cell ranges built off-thread; per-cell upload on window entry | main-thread stall at scene open < 50 ms; Bistro grid built in the worker ≤ 2 s |
| **2.3 budgeted SAT voxelizer** | existing SAT kernel over (brick, tri) pairs, k bricks/frame frustum-first coarse-first, face bits set from the triangle's crossing faces (6-separating), anisotropic OR mips | Bistro: **all levels occupied within 2 s** of assets ready (coarse first), L0 within 5 s; `test:gi-sunleak THICK=0.05` at the 0.25 m level = 0 leak WITH the entry-face test and 100 % leak WITHOUT it (the bit must be load-bearing) |
| **2.4 bit-DDA trace API** | brick → voxel DDA, entry-face test, level hand-off by distance, static|dynamic OR; gate harness with a CPU mirror only for the trace (small) | ray throughput receipt (`probe:gi2-trace` rays/s at 3 tiers); < 6 storage buffers |
| **2.5 movers** | dynamic layer re-voxelized per frame from `dynamicObjects`' adoption list; skinned proxy boxes | `test:gi-spawn` equivalent on the new path: spawn/despawn touch only their bricks (counter) |

### Stage 3 — THE GATHER (~3-4 sessions)

**✅ SHIPPED 08-27 (`72c3e58` 3.1, `bc976ad` 3.2, `7db6078` 3.3, `32effdd`
3.4, `3.5`) — measured by `run-gi2-boot-probe` on the final tree:** Level
first light **1.41 s** after assets, GI GPU **1.05 ms**, heap 335 MB; Bistro
(ultra, 1650×970) first light **5.47 s** (the 4.2 s material wave is the
gate; voxelizer live at 1.4 s, all 5 levels occupied at 3.9 s), GI GPU
**2.17 ms**, heap 1.92 GB, 36 compute pipelines, 0 SRC kernels, 43 fps at
cpu 17.7 / gpu 8.0 (the raster side is the frame now). Harness: Cornell 8/8
crops bracketed, 2nd bounce 1.48, off-screen bounce 0.95, orbit 0.96×,
exhausted rays 0 %, 0/10 000 leaks. Mirror tier OFF under GI2 (measured:
+530 ms boot stall + 2.96 ms/frame). 3.6 (`209de92`): noiseless at rest —
temporal p95 12.8 → 1.17 % (Bistro 2.3 %), resets 26 → 0.44 %, reprojection
100 %, chain 3.2 ms; the trade is world-change lag (a moved lamp 32 % at 30
frames with H=32) → **▶ 3.7 change-driven ray allocation**: texels the
variance test flags get re-traced with extra rays next frame instead of
forgetting their history (Lumen's importance-sampled probes) — the
responsiveness the "things move a lot" mandate needs, without a knob.
3.10-3.13 (08-28 night): the determinism contract (§T: complete fixed
direction sets every frame, no stochastic input; smooth accumulation of
noise-free inputs allowed) → at rest 100 % of pixels still; then the
WORLD-ANCHORED lattice (`worldProbes.js`, §U): orbit Δp95 3.87 → 0.11 %,
chain 0.99 ms, 8/8 bracketed, first light frame 1 — held off-default by its
±8 m horizon → **3.14 cascades** (2 m / 8 m spacing over 64 / 256 m sharing
the ray budget). **The gather is now 3D radiance cascades inside the
window** — world-anchored, complete, interpolated — the user's original
idea, made affordable by §4.1-4.2. 3.14-3.17 (08-28): cascades 0.5/2/8 m → RC PROPER (interval-limited traces,
per-direction merge, two textbook corrections: a clipmap has no cascade 0
over the whole domain; the ray must leave the PROBE, not the interval start)
→ **`WORLD_PROBES` DEFAULT ON at `274ed6d`** (`__gi2WorldProbes = false` =
screen probes). 3.17 also fixed a WINDOW bug that hit both paths: bricks
stranded BUILDING on boot frames (L4 4096/4096 orphaned on every Bistro
boot — the far field was never voxelized). Open rows: the corridor's 9 m
light pool at 8 m probe spacing (extent schedule), Bistro motion flips
35/24/23 %, Level heap +136 MB (one boot), phone panel 11 fr, phone rotated
leaks 3/2 per 10 000, `probe:gi2-motion` orbit MAX ~107 ms on both paths
(a reactive proxy-material warm; §18). ▶ Stage 4 next — HELD until the
user accepts GI2 by eye (`GI2_PATH = false` is the safety net).

| unit | what | gate |
|---|---|---|
| **3.1 screen probes** | placement, oct maps, N rays/frame by tier, HZB first segment + step-back hand-off, hit shading via palette + sun DDA ray + light tree NEE, probe-space accumulation with position/normal validation | Cornell: matches the reference render ([[gi-colour-probe-method]] receipts) within the same tolerance the SRC path met; no temporal term outside probe space |
| **3.2 radiance cache** | brick atlas, ray-hit scatter average + lit-frame injection, read at far hits, multibounce | Cornell 2nd bounce present within 30 frames; a lamp lit in a room the camera never saw lights its corridor (off-screen bounce receipt) |
| **3.3 per-pixel resolve** | 4-probe weights, cosine integration, the two output textures; GTAO composed as today | GI GPU **≤ 4 ms at 1650×970 ultra**, ≤ 2.5 ms on the phone rig at 720p low (`profile.giPasses`, both parked and orbiting — the stillness trap) |
| **3.4 reflections + emitters** | BVH8 mirror path retained at high/ultra via the worker build; window cone trace elsewhere; emitter shadow decision by measurement (NEE at probes vs `emitterShadowPass` at ultra only) | reflections receipt from `probe:gi-reflect-black` (non-black %); emitter cost ≤ 1.5 ms at 4 emitters |
| **3.5 motion** | orbit/whip-pan on Bistro: fixed budgets mean constant ms; receipt = frame-time variance | max frame time during a 10 s orbit ≤ 1.2× parked; no user-visible blocks (their eyes are the gate; the counter is "probes invalidated / frame") |

### Stage 4 — CUTOVER + DEVICES (~2-3 sessions)

| unit | what | gate |
|---|---|---|
| **4.1 cutover** | GI2 default; delete SRC (`src*.js`), `occupancyField.js`, `rayHit/`, record pools, old screen chain; keep `giConfig` (3 props), light tree, emitters, GTAO, BVH8 mirror path, skinned proxies | module ≤ 25 k lines; battery green; `component_types` still shows `quality` + `ao` + `reflections` only |
| **4.2 Safari/iOS/Android** | Playwright WebKit envelope run + a real phone: Level scene 60 fps at low; Safari macOS medium at 60 fps with the same brightness as Chrome (colour probe) | receipts from the device, not the desktop |
| **4.3 boot** | **RE-ANCHORED 08-27 (user measured 31 s scene-open → GI vs our 3.4 s "after assets"):** first light ≤ 3 s from SCENE OPEN on the Level; Bistro ≤ geometry-ready + 3 s; GI2 builds on geometry-ready (not texture-ready), the soup comes from source meshes (merging cannot restart it, `soupBuilds` = 1); ≤ 20 kernels; cross-scene cache hits — AUDITS §R | `run-gi2-boot-probe` from scene open, stage table, 2 boots; then the EDITOR's own `firstLightFromSceneOpenMs` |

**Stage 4 status ledger, 2026-08-28 (quality units, receipts in AUDITS §AA-§AH; every unit fast-forwarded to `main` the hour it landed):**

| unit | verdict | receipt |
|---|---|---|
| 4.3c orbit spike / jump transient | a new merged proxy's never-drawn material minted in-frame → HOLD the swap until warm; seed→own REPLACE → `wpSeedRamp` | orbit MAX 100 → 22 ms; dolly jump 51 → 3.9 % (§AA) |
| 4.3d the red/green FLOOD | the emitter ADMISSION record never ran at boot → power gate failed open, seat-fill `?? 1`; NOT world-path-specific, NOT the GPU blit (refuted by a solid-colour receipt) | pavement chroma 0.155 → 0.023, seat share 177 → 0.3 % |
| 4.4 the puddles | the RADIANCE CACHE's per-face values (adjacent 0.25 m faces of one plane unrelated); world probes default ON again | `probe:gi2-puddle` tile-lag p90 12.1 (screen) vs 7.4 % (world) (§AC) |
| 4.5 debug views on GI2 | window trace views (occupancy/sdf/probes), E/π display; found the palette dying on resize | Bistro receipts per view (§AB) |
| 4.6/4.7 instruments | `probe:gi2-ref` (path-traced truth, pinned 39 pts), `probe:gi2-runner` (the runner's steps) | flatness = cascade hand-off not a term; runner steps = per-pixel bimodality, field steady in time (§AE) |
| 4.8 cache face estimator | a face is 100 % second bounce read out of the cache (Neumann iteration) → write-time plane smoother | face σ 12.5 → 10.1 %, world tile-lag p90 7.5 → 6.4 % (§AD) |
| 4.9 the hand-off | fallback never fires (premise refuted); real: rejected corners renormalised onto survivors + c0 allocPass burrowing into −X walls (the src-probes MOSAIC) | ground steps > 10 % 42 → 3, spread 1.58 → 0.26, mix 0.00 (§AF) |
| 4.10 SH zeros / ×2 schedule | C¹ non-negative SH reconstruction (zeros 2 → 0); the ×2 cascade schedule BUILT and RETRACTED (fall 2.53 → 2.54× on truth 7.2×) — a far cascade owns pixels it never traces the near field for | pinned ref pose B |log ratio| 2.93 → 1.25 (§AH) |
| 4.11 coverage class | a thin voxel is not a wall: 2-bit coverage, rays DIM through thin voxels; the string-light ceiling over the street is gone | 29.9 % of upward rays cross thin geometry; leaks 0/10 000 ×3 tiers (§AG) |
| editor | selection outline draws merge proxies + caches the mask | Bistro root: 850 → 171 draws parked |

**Open after 08-28:** the far cascade's near band (agent in flight); the gather ignoring throughput T; cache DIRECTIONS (4 sky rays/face is the variance floor; ≈ ×1.5 rays); the BVH8 mirror tier (no sharp reflections on GI2 yet); bounce colour fidelity (64-class palette); 4.1 cutover HELD until the user accepts GI2 by eye.

### Stage 5 — RADIANCE CASCADES RESTORED ON THE WINDOW (user decision 2026-08-28: "Do that")

**Why.** Audits §AA-§AJ: every 08-28 fix removed a real bug and exposed the next symptom of one missing foundation. Checked against `docs/SplitRadianceCascadesPaper.txt` §3-§5, the world-probe path has spacing ×4 / interval ×4 / **directions ×1** (64 at every cascade — no angular branching, so Δω ≫ Δs at every band end: the paper's Fig 2 streaks, ours as fixed-direction blotches), a per-same-direction merge (**no cone averaging**, the source of RC's smoothness), rays from **probe centres** (the paper's Fig 7/8 recess bias — every escape/burrow/claim workaround of 08-28 is this), and a 4-ray self-lit face cache instead of a **secondary probe cache**. The old SRC path had the paper (`srcConfig` β = 4, R2, Alg. 3) and failed on scale, not math. Stage 5 keeps GI2's transport (window, bit-DDA, coverage, soup, budgets, boot, material hook, GTAO, movers) and puts the paper's contract back on top.

**The contract (deterministic — §T and the no-noise rule hold: complete fixed direction sets, no stochastic input; the only temporal element is world-space α accumulation and a fixed round-robin cadence).**

| element | rule |
|---|---|
| cascades | n = 0..N−1; N = 4 ultra/high, 3 medium, 2-3 phone. Toroidal camera-centred lattices as now, 32³ cells each |
| spacing | Δs_n = Δs0·2ⁿ (Δs0 0.5 m ultra/high, 1.0 m phone) → extents 16/32/64/128 m |
| directions | Ω_n = 32·4ⁿ (equal-area map, 2Θ×Θ, Θ_n = 4·2ⁿ: 8×4, 16×8, 32×16, 64×32); parent map m_n(ω_{n+1,u,v}) = ω_{n,⌊u/2⌋,⌊v/2⌋} (4→1, Morton-contiguous) |
| intervals | t₀ = 1.6·Δs0, t_n = t₀·4ⁿ; cascade n traces [t_{n−1}, t_n) with t_{−1} = 0; the last cascade to RAY_MAX then sky |
| storage per direction | J (radiance, RGBE/half3), β (transmittance), count; merged I_n pre-averaged for n−1 only. Sparse: live probes only (allocPass liveness), compact index per cascade, budget `traceSlots` per tier; ~constant texels per cascade (live probes ÷4 per cascade × directions ×4) |
| ray origins (ray splitting, deterministic) | a probe stores up to 8 ANCHORS = surface samples (position + normal) of the finer probes mapping to it (c0 anchors = the gbuffer/soup surface samples that allocated the cell); direction ω is traced from the anchor with max(n_a·ω) > 0, interval measured from the anchor; no anchor faces ω → count 0 (unused by construction) |
| schedule | every live probe traces its complete direction set on a fixed cadence: c0 every frame, c1 every 2, c2 every 4, c3 every 8 (~1.1 M rays/frame ultra ≈ 1.1 ms at 1 G rays/s); α accumulation per direction in world space |
| merge (Eq. 7) | back-to-front: I_n(p,ω) = J_n + β_n · mean over the 4 children ω_q of Interp8(I_{n+1})(p, ω_q); Interp8 = sparse trilinear over LIVE parents, liveness-renormalised, with the visibility weights (Chebyshev/face) as the leak guard; children with count 0 skipped (renormalise; all zero → 0) |
| shade | per c0 probe: cosine-weighted irradiance from I_0 (SH2 or a 6×6 oct map); pixels resolve by the existing 8-probe visibility-weighted interpolation (resolveHalf/resolveUpsample stay; screen tiles retired) |
| hit radiance (2nd bounce) | J at a hit = emission + palette albedo × (direct(hit) + E_probes(hit)) / π; direct = sun shadow ray + emitter NEE (seats, power gate) cached per brick face (DIRECT ONLY — the face cache stops lighting itself); E_probes = the covering cascade's merged I_n evaluated against the hit normal (the paper's secondary cache, realised on the same lattices) |
| LOD | the toroidal extents are the LOD; beyond the last extent the last cascade's rays reach RAY_MAX/sky |
| movers | dynamic layer unchanged; c0 re-traces every frame |

**Budget/memory (ultra):** live ≈ 20k/5k/1.2k/0.3k probes × 32/128/512/2048 dirs × 8 B ≈ 5 MB per cascade for J/β/count, same again for I → ~40 MB; rays ~1.1 M/frame; chain target ≤ 3 ms. Phone: Δs0 1 m, N 2-3, `traceSlots` small.

**PORT, DON'T REWRITE (user, 17:00: "we had quite good looking GI and reflections… reuse something").** The old SRC path is still in the tree and is the paper: `srcConfig` (β 4, γ 4, 4 cascades, W0 4 = 32 dirs, r0/s0 1.6, LOD overlap 0.9, irradiance tile 6+1, α 0.1), `srcMath`/`srcMathTsl` (bins, parent/children, Morton, R2, LOD keys), `srcOctahedral`, `srcMerge` (8-corner cone merge, LOS), `srcDeposit` (bin layout), `srcRays` (Alg. 3), `srcProbes` (hashed sparse probes, LOD, age). Stage 5 reuses them and replaces ONLY the transport (`traceWindow` + coverage instead of occupancyField/rayHit/BVH8 hit shading) and the hit radiance (5.3). Rays from on-screen surfaces (Alg. 3, R2, world-space α) as the paper and the old path did — the deterministic-anchor variant above is the fallback arm if the at-rest Δ reads as noise (gate ≤ 1 %). Reflections: the old BVH8 mirror path returns on the worker-built BVH as 5.5.

**Units (one at a time, each gated; ported RC core under `src/modules/gi/window/rc/`, behind `RC5_PATH`; old world probes + radiance-cache bounce stay until 5.4):**

| unit | builds | gate |
|---|---|---|
| **5.1 lattice + anchors + trace** | `rcLattice.js` (liveness, compaction, anchors), `rcTrace.js` (interval trace per cascade via `traceWindow` with coverage T, deposit J/β/count, cadence, α) | interval census (every band owned exactly once, orphans 0); leaks 0/10 000 corridor/doors on the deposited J; rays/frame + ms per tier; anchors: 0 probes tracing from inside geometry |
| **5.2 merge + shade + resolve** | `rcMerge.js` (Eq. 7 cone merge, pre-averaged), irradiance per c0, wiring into resolveHalf/resolveUpsample | Cornell per-pixel gate on the user's Cornel.scene (median |log ratio| < 0.15, black 0, blotch σ < 10 %); pinned Bistro ref medians < 0.15 both poses; Cornell 8/8 |
| **5.3 hit radiance from probes** | `rcHit.js`: direct-only face cache + E_probes at hits | Cornell energy per surface 0.9-1.1; convergence monotone, image still at rest (Δ 0.00 %); `probe:gi2-faceterm` σ < 10 % |
| **5.4 flip + tiers + cut** | `RC5_PATH` default on; phone/medium tiers; delete the old world-probe path and the cache's bounce term | full battery: runner no step > 10 %, motion at the null floor, leaks 0, first light ≤ 3 s, chain ≤ 3 ms ultra, smoke incl. phone, memory envelope; then Bistro by the user's eye |

**Stage 5 status, 2026-08-29 02:00 (receipts in AUDITS and the commit messages; `main` follows every unit):**

| unit | verdict |
|---|---|
| 5.1 port | the old SRC core (the paper) on the window transport; census/leaks 0; RC5 off byte-identical |
| 5.2 merge+shade+resolve | first RC picture: black 671 → 0, blotch σ halved, not bistable |
| 5.3-5.3b hit radiance | direct-only face cache, E_rc from probes; emitters conserved per voxel through coverage; energy 0.30 → 0.88 (old truth) |
| 5.3c-e | at-rest aliased sweep fixed; projected law refuted; cadence ON; LOD hypothesis refuted; the Cornell REFERENCE was self-occluded (fixed) |
| 5.4a-c parallel | seed-parent (ON), old path not built under RC5 (4 → 43 fps), corrected truth: RC 0.44× |
| 5.4d chain | faces already NEE-lit; loop exonerated; single bounce isolated; coarse-face origin escape (FACETRUTH 0.84 → 1.00) |
| 5.5a/b | glossy from the RC probes; worker BVH exact shadow rays (uniform swap, no rebuild; OBB slab exclusion) — Cornell median 0.104 PASSES, gain 0.85 (0.9ᵏ tax on ρ = 1 walls), at rest 1.67 %; BVH arm OFF on main (Bistro 3 fps — cost/gate owed) |

**THE GATE ABOVE EVERY NUMBER (user, 2026-08-29 02:30): "we must never see artifacts. Light must arrive in natural gradients, without hard edges or rapid changes. Like Lumen does."** Spatial: gather weights continuous per pixel (no visibility/coverage/known-fraction switches), a newborn probe fades in by age (weight 0 → 1 over ~10-20 frames), flat-surface second differences at the reference's floor. Temporal: no pixel changes more than ~3 %/frame under motion, on a light change or at boot; arrival is a monotone ramp over ~0.3-0.5 s (world-space α is the sanctioned accumulator; no history on the image path). Receipts: `probe:gi2-runner` per-frame step p90/max, the cold probe's newborn ramp, the Cornell d² lines.

**Stage 6 status, 2026-08-29 05:00 (Bistro at scale; receipts in the commit messages):** 6.1 spots = rays per PIXEL starve far probes (one ray into 32 bins) → newborn fade ON (`d599bda`), per-probe ray floor built, OFF until its coverage arm is reconciled; 6.2 complete compact shadow BVH (Bistro 2.83 M tris, 41.7 MB, 5.4 s off-thread), third binding only where the arm can run, gate held at 250k until the pass cost is measured; the emitter SEAT RACE in every probe fixed (`gi2EmitterWait`); §AM palette emitter band never self-heals (ticket); 6.3/6.4 boot stage table — the compile wave (2.2 s) refuted as the blocker, kernel warm refuted; 6.6 the long frames attributed (GI pack 1.3 s, console tee 1.1-1.4 s, textures 0.9 s); 6.7 chunked pack → Bistro first light 19.4 → 13.7-15.8 s, Level 3.2 s; editor: console tee batched (`7f1ca41`), transform commands refresh only their entities + one undo per API drag (`dc00aa3`); 6.5 the drag freeze = the harness's undo path (10×) + shadowMerge's starvation re-bake (fixed `a72324d`) + a merge rebuild from releasing the mover (in flight) — gizmo drag 42.9 fps median, one 517 ms frame left → 6.5e (`0fc2963`): the 'merging' phase mark spans merging AND shadowMerge; shadowMerge's settle clock started at the drag's first frame and expired mid-drag — now pushed by `engine.content.transforms` while a caster-moved is outstanding: max drag frame 521.9 → 49.2 ms, >50 ms frames 11 → 0; `test:gi-moved-lamp` PASS (Δnew 28.98).

**6.11 the exact reflections are back under GI2 (2026-08-29 10:40, branch `rc5-glossy`, albedo-only first cut):** the user's "there are still no reflections: we had those in the previous version" was the `if (GI2_PATH) return;` at the top of `#syncBvhScene` plus `#rebuild` skipping the call — `state.bvhScene` was never built, so the §17 `bvhReflect` prepass never existed and the only reflection term was `rcMerge`'s glossy cone. Both gates are gone; `exactReflections` is no longer required (`reflections` on at high/ultra + a mirror-bucket consumer IS the request; an explicit `false` still opts out; `__giNoBvhReflections` stays the hatch). What shades a hit: the prepass's own texture-sampled albedo (`buildBvhScene`'s `firstHit`, ≤128 seated meshes — `_dynSet.staticBvh` and the §18.17 `_slotAtlas` are not built under GI2, so the one-BVH bundle is null) lit by the RECEIVER's GI2 irradiance (`bvhReflectShaded = false` path in giLight); `bvhHitShade` stays retired (it reads the lattice RC5 never builds). ⭐ Second bug found by the instrument: the pass is created inside the compile wave and the frame the mirror mask turns on is the only unheld frame, so a deferred first build left a target of CLEAR VALUES held forever on a parked camera (`probe:gi-reflect-black` on Cornel: hitPct 100 at t = 0, albedo 0 %) — the hold now needs `tracedOnce` (hitPct 0.23 % = exactly the masked mirror pixels, albedo max 1). Cornel at the gate pose: the mirror box shows a sharp reflection of the red wall, the emitter, the floor and the green wall. OPEN: the back wall reflects BLACK in the mirror (its hit albedo reads 0 — the seated atlas' tile for that material, or a traced miss with no environment; the §18.17 atlas path is the fix and needs the static BVH under GI2); Bistro's harness census has ONE mirror-bucket material (208 tris) so the Bistro shot shows no visible mirror; hit lighting is the receiver's, not the hit's (sun-at-hit via BVH any-hit + rcHit's face cache is the next unit); prepass cost not measured in the box. Cornell gate A/B on this tree (same server, same hour): reflections ON 2/5 (median 0.323, p90 0.680, black 0) vs `__giNoBvhReflections` 1/5 (median 0.308, p90 0.667, black 10) — parity within run noise, so the gate's current 0.3 median is NOT this unit's (the 5.5b PASS at 0.104 needs the BVH shadow arm, which is OFF on this tree).

**6.11b the consumer census and the black mirror region (2026-08-29 11:00, `rc5-glossy`):** (1) The "0 mirror / 0 specular / 133 diffuse-only / 1 dynamic" line in the boot log is the BUILD-time tally, printed before Bistro's KTX2 roughness maps exist on the materials (GI2 builds on geometry-ready, §R.1) — every mapped material reads `roughness 1` with no map and lands in bucket 2. It is the blind number by construction and it HEALS: the §19 0.3 drain re-derives buckets as the maps land, so at 25 s the live tally is `[0,0,6,129]` and the read-time `reflectTierCensus()` is **3 sharp / 2 medium / 124 coarse** materials (129 consumers; the mask draws sharp+medium). No gate blocks the floors under GI2. What IS wrong: the floor readback sampled a 32 px MIP — one detailed 2048 map read p5 0.176 at 32 px and 0.016 at 256 px (Bistro's 512 maps are flat 0.737 at both, 5 distinct floors over 128 textures) — a floor that reads high can push a smooth-region material past the 0.45 sharp gate and OUT of the mirror mask. Readback is 128 px now. Bistro café pose (SETTLE 90): NO visible reflections — the harness renders Bistro as clay (no albedo maps) and the sharp-tier meshes in view show no mirror image; the glass fronts are `transparent` and never enter the GI tally at all. (2) The black region in the Cornel mirror is NOT a black hit: `run-gi2-backwall.mjs` reads the prepass at the gate pose — 24 927 hits, ALL lit (hitBlack 0, hasAlbedo 1), 9 362 traced MISSES. The mirror faces +z and reflects the OPEN front of the Cornell box; with no environment a miss paints nothing where the old cone blurred the room, and the jagged edge is the half-res hit/miss boundary. The seated BVH holds all 7 meshes / 74 tris. OPEN: a traced miss should keep the glossy field (the blend weight IS 0 on a miss — find why `directional` is black there for the bucket-0 material under GI2) and the hit/miss edge needs the resolve-res prefilter.

**6.11c a miss carries no weight; glass is a consumer (2026-08-29 11:05, `rc5-glossy`):** the Cornel mirror's black region was NOT the exact prepass at all — a shot with `__giNoBvhReflections` hatched showed the SAME red/black/white image. It is the §14 R-B REFLECTION PROBE: its capture paints a traced miss with the env or nothing and its sampler blended that at full box weight over the glossy field ("dim beats ghost" — black beat both). `sampleReflectionProbes` now gates each probe's weight on the level-0 hit depth at the final direction (`step(0.05, t)`, `__giProbeMissWeight = false` reverts): the open-front pixels read (172,113,110) instead of (0,0,0) and grade continuously into the hits; a thin stair-step outline survives at the probe/exact boundary (the prepass's block replication at half res — resolve-res prefilter owed). Glass: `renderGiGBuffer` runs opaque-only (an occluder rule), so a transparent pane never had P/N in the gbuffer and the prepass never traced a ray for it — the mask pass now re-enables the transparent queue for the SHARP-TIER layer only (`__giMaskTransparent = false` reverts; volume materials never earn the tag; pixels behind a pane resolve diffuse GI at the pane's depth — a second consumer layer if that shows). Read-time Bistro census 3/2/124 → **4 sharp / 2 medium / 124 coarse** (34 sharp meshes, 37 k sharp triangles); the café pose still shows NO mirror image on the windows (the harness renders Bistro as clay, and the panes stay dark), so the glass path is wired but not yet SEEN.

**Open:** Bistro at scale — probe spots/checkerboards on motion (population + seeding), the BVH arm's cost and 2 M-triangle cap, boot 17 s from scene open, the pinned Bistro truth re-read; blotch σ 10-16 % on the box (fixed-direction structure); at-rest Δ 1.7-2.8 % (target 1 %); Box·+Z (a seated emitter's own face lit only by bounce); the user's scene authoring (albedo 1.0 walls; sky:sun 3:1; AO off).


**6.8-6.13 the six-lane morning (2026-08-29 09:50-12:30; user: "we are so far from finished" + two screenshots; all lanes 30-min boxes in parallel worktrees, merged to `gi19-stage0` f454b8d, gate on the merged chain median 0.098 PASS / black 0 / p90 0.413 / blotch 6 / second-difference 2 = 2/5):**
- **6.8 crash on any GI prop flip** (`rc5-cold` 1d4d86d): `Binding size ... is zero, entries[7]` was the exact-shadow BVH SLOT outliving the gi2System generation — a flip retires the generation (soup `tris` zeroed, tree buffers harvested off the orphaned rcDirect kernel) while the slot still said `ready = 1`, so the next generation bound empty arrays. The slot keeps CPU arrays and MINTS attributes per generation (`retarget(soupTris)` after `uploadSoup`). `probe:gi2-param-change`: Cornel 6148 → 0 errors over 8 flips, Bistro 142 → 0, first light re-arrives after every flip.
- **6.9 Bistro black tiles** (`rc5-cut` 153876e): NOT reproduced in the harness (0/9600 black tiles at 4 poses incl. a 3 m/s slide and a 180° turn). The only path that can write a black square — `srcScreenGather.js gatherAt` returning E = 0 when every corner of both LOD shells is unclaimed/alpha-0, stored into `irradianceHalf` with no validity bit — now falls back to the coarser LOD shells (`__gi2GatherUnknownFallback = 0` restores); `rcMerge.readStats().resolve.unknownOwnLodPct` is the live receipt (`profile.gi2`). ▶ ask the user whether the white screenshot was a debug view.
- **6.10 Cornell corner patches** (`rc5-energy` 313f3aa): the photo's patches sit on the WHITE strips next to the red wall; `MAPS=` per-pixel error maps at the user's framing show a 0.3-0.5 m band along every concave corner missing ~half its energy (strip −0.44 log, Δgreen +0.032 vs floor centre −0.21) — NOT the shadow arms (0 px lit where truth is dark). Trace-side arms (origin bias/escape → 0, spacing) moved nothing; the owner is c0 probe FEEDING: with `cornerSpread` OFF a pixel's ray fed only its nearest corner, so probes in a corner cell were fed by nobody and inherited the parent's wide cone. Spread ON: strip −0.435 → −0.305, Δgreen +0.035 → +0.018, gate at that pose 4/5 median 0.130. Orbit flash: the 4 %/frame step is the instrument's own 1° slide (all five hatch arms identical) — no GI term owns a flash at rest-parked Cornell.
- **6.12 emissives cast no shadow** (`rc5-faces` 4b887d2): visA read EXACTLY 1.000 everywhere. Tree, traversal, data and uniform all proven right on the GPU (a kernel built after `fill()` hits; brute force agrees) — a kernel compiled BEFORE `fill()` kept the placeholder (`nodes[3]` 0 vs 22): the `.value` swap does not re-mint a compiled kernel's bind group. Slot `attach()`/`detachAll()`, `fill()`/`retarget()`/`reset()` bump `needsUpdate` on every attached kernel (WGSL identical → pipeline cache). Then every ray hit the lamp's own front face at t = maxT − 1e-4 (slab exit IS the face) → reach = d − min(slab, clear) − max(2 mm, 0.1 % d); voxel arm reach = d − min(slab, clear) − 2·v0 (lit rays were stopping inside the lamp's dilated bits). After: visA shadow/lit 0 / 1 on BOTH arms, direct 0 / 0.53. ⚠ the shadow edge is now HARDER than the path-traced penumbra (second-difference fails on Mesh·+Z, Red·+Z) — soft shadow = next unit. ⭐ trap: a fresh compute node's first dispatches are DROPPED while its pipeline compiles off-frame — probes dispatch, wait, dispatch again.
- **6.13 AO grain** (`rc5-marker` bc189d6): the 4x4 rotation tile was NOT it (phase profile 0.1 %). Grain-only oracle (8-slice reference, `run-gi-ao-oracle.mjs`): estimator grain p90 floor 3.05 / foliage 3.26 %, but the COMPOSE UPSAMPLE's `factor = 1` fallback (leaf normals failing all four taps) was 10.6 % on foliage — a bright speck per pixel. 3x3 joint bilateral that blends to a spatial mean instead of 1 (foliage 10.6 → 5.75 %), phase-complete 5-tap filter, 3/4x3/4x4 slices on medium/high/ultra; `probe:gi-gtao` open floor 0.988. p99 5-6 % remains (starvation-flagged second pass owed).
- ⭐⭐ **every lane's Cornell gate read median 0.3 while six harnesses shared the 4070; the same trees read 0.093-0.098 on 5202 alone** — contention starves the settle window (gain 0.7 = unconverged), so a lane's gate number is only a PARITY check; the ff decision is taken on the integration server alone.

**6.17 the rotation checkerboard is BIN-POOL EXHAUSTION (rc5-cut, 2026-08-29 13:00, 35-min box):** the user's white "indirect" screenshots while rotating at 45-52 fps, 1657x966. Receipt = `scripts/run-gi2-rotation-receipt.mjs` (indirect debug view, in-page rAF yaw 30°/s, composited-canvas shots every ~10 frames, 16x16-block black/bright fractions + `rcMerge.readStats()` every 5 frames). Chrome at 1526x562 street pose: black 0.06-5 % (all legitimate shadow, LOOKED at), `unknownFinalPct` 0; but at the DEFAULT pose mid-rotation `unknownFinalPct` **7.02 %** (180 552 px with no information at ANY LOD → resolve black) with `merge.perCascade[].probes` = **5468 / 1367 / 341 — exactly `blockCapacity`** for c0/c1/c2 (700 000 bins ÷ 4 cascades = 174 976 bins each = 5468 c0 blocks); at 1706x817 c0 sat at 5468 at rest and during the whole turn. A demand equal to a capacity is exhaustion: every uncovered region claims a probe slot (16 384 c0 slots) and NO BLOCK (`COUNTER_NOBLOCK` path, srcProbes.js:1187) → blockless probe → UNKNOWN tile → the 6.9 LOD walk finds c1/c2 blockless too → black; retention frees blocks a few per frame → "tries to resolve, never completely". Screen-aligned because the population inserts per screen tile. Edge (iGPU) showed the same smooth field, no backend difference. **Fix (`rcSystem.js` §19 6.17): the bin budget scales with `pixelCount / (960·640)`, floor = the tier's, ceiling 4x (36 B/bin: 1657x966 → 1.82 M bins ≈ 66 MB)** — `setSize` already declared "the pools are sized for this frame"; the bins were not. After, 1706x817 same turn: c0 population 10 317 (was capped 5468), c1 2662 (was 1367), `unknownFinalPct` 0 throughout, isoBlack 0.09-0.26 % after stop (before 0.28-0.96 %), black during the turn 0.00 %. ▶ OPEN: `[merging] 2 rebuilds in the last 10s` fired mid-receipt on the before arm (population 5468 → 3205, the GI↔shadowMerge loop, other lane); cascade 3 holds a quarter of the bin budget with 0 probes in every receipt (`blockCapacities` splits equally over CASCADE_COUNT=4) — reclaiming it is another 33 % for c0-c2; the cadence's due-frame rebuild (rc-energy lane) is not what this receipt measured. Cornell parity (`probe:gi2-cornell`): health 24336/24336 valid, p50 1.753; per-pixel gate median 0.107 / p90 0.468 / black 0 / blotch 6 / second-difference 1 = 2/5, i.e. the merged chain's own 0.098 / 0.413 / 0 / 6 / 2 = 2/5 within the contention noise (the rotation receipt shared the GPU) — Cornell's harness frame is under the 960x640 reference, so binScale = 1 there and the change is a no-op by construction.

**6.14-6.18 the second wave (2026-08-29 12:30-15:00; user: screenshots of the mirror, the emitter self-shadow, the Bistro indirect view during rotation, plus "inside the box 20-30 fps" and "empty space must sample the background/sky"; merged to `gi19-stage0` 30dca6a):**
- **6.14 emitter self-shadow + penumbra** (`rc5-faces` e40c1c2): the dark quads above/below the lamp were the world-axis slab measuring the wrong box for a rotated lamp — the seat ray now stops at the emitter's OBB entry in the emitter's OWN frame (both arms). Penumbra by construction: `gi2BvhNearestT` (first-hit t, generated from the any-hit) / `traceWindow().t`, PCSS half-width `lampHalf·t_occ/(d−t_occ)` in metres into `rcEmitterPen`, separable blocker-search dilate (R_MAX 24 px), 13 Gaussian taps over `clamp(r/footprint,1,12)` texels. One ray per texel, nothing stochastic. Ceiling above the lamp visA min 0.9995; gate median 0.103 PASS, black 0, second-difference 0 surfaces PASS (was 2).
- **6.15/b/c mirror muddy + stair-step; miss = background** (`rc5-glossy` 1e704ac, 8341f72, 33b04cd, 9840c25): the serration and mud were the §14 R-B PROBE cube painting every traced miss and being mixed BEFORE the exact term (`__giNoBvhReflections` showed the same image; `__giReflectionProbes=false` was clean). Traced pixels now outrank the probe by `smoothstep(0.45,0.15,roughness)`; the sparse prepass traces the mask at stride 1 (the mask IS the sharp set). User rule: a traced miss samples `scene.background` (Color/texture) else the env along R at weight 1 — `#envMissBundle()` feeds the prepass, the probe capture and `light.giEnvMiss`; the "borrow hit neighbours" rule of 6.15 is retracted. ⭐⭐ leak: a Color `scene.background` cleared the GI gbuffer at alpha 1, so every SKY pixel was valid geometry carrying the mirror bit — 404 196 rays for a 953-px mirror on Cornell, the whole sky on Bistro; the gbuffer renders with the background nulled at clear alpha 0 → traced 953 = masked 953 (`probe:gi2-tracecount`).
- **6.16 the orbit flash is the ANCHOR JUMP** (`rc5-energy` c6773d1, 13e3020): per-frame composed-frame instrument (`run-gi2-orbit-probe.mjs FLASH=1`, camera moved every rAF, un-awaited capture) — flagged frames uniform across cadence phases; cadence-off and newborn-fade-off arms byte-similar → NOT the cadence. `rcSystem.setCamera` snaps the anchor to the coarsest cell (spacing0·8) and keys are anchor-relative: crossing a coarse cell re-keys everything → whole population orphaned + reborn beside itself → one empty frame ("flashes black every few frames while rotating"). Fix: `anchorPrevU`; `createAgePass` rewrites each live key by `latticeOriginCell(prev)−latticeOriginCell(cur)` per LOD in place before re-insert (`COUNTER_REKEYED`, `__gi2RcRekey=0`). Cornell jump frame Δmean −17.0 → +1.0 %, px>50 % 6.9 → 1.2 %; Bistro street jump −30.2 → −1.0 %, px>50 % 24.8 → 2.0 %, flagged 7 → 2, orbit max 30.2 → 8.7 %. Zombie population from past jumps gone (Bistro 2845→7533 growth over 30 frames before). Residual: Bistro period-2 alternation −1..−3 % (the cadence, small now); the 66-76° Cornell swing is the lamp leaving/entering the frame.
- **6.18 inside the box 20-30 fps** (`rc5-marker` 2a18ec2): live receipt — inside gpu 20.9 ms with GI2 compute 11.9 (LESS than outside 13.5): the growth was the SCENE DRAW. WGSL of the wall material: 7600 lines, 80 `textureSampleLevel` of the reflection-probe atlas — the planar-mirror nested-view irradiance stand-in combined with `select(giNestedView>0.5, …)`, which keeps both operands live: every lit pixel of every material ran 80 probe taps against a uniform that is 0. Now a thunk inside `If(...)` (4750 lines). Inside 18.8-20.5 → 16.0-16.9 ms. Hatches `__giHookOff/FlatIrradiance/NoGlow/NoGlossy/NoExact/NoEnvMiss` compile terms out. Remaining inside/outside gap (hook off 15-16 vs 10 ms) = GI2 compute scaling with lit pixels → 6.19.


### What is deliberately NOT in this plan
- Any new tuning property on the component (three properties stay three).
- Temporal AO (killed 08-26; GTAO has no history).
- Reprojection of the *final* GI image (only probe-space accumulation with
  world validation — the same class the world-anchored SRC accumulators are).
- Offline surface cards / baking. First-light latency for off-screen bounce
  is accepted and bounded by the ray budget.
- Raster (VXGI-style) voxelization: 3 axes × L levels × 450 draws per update is
  a draw-bound engine's worst case; the compute SAT is exact and exists.

---

## 6. RISKS AND OPEN QUESTIONS

1. **Ray cost on phones is a projection**, not a measurement — SmartGI/HDDAGI
   receipts are for their kernels. Unit 2.4's `probe:gi2-trace` throughput
   receipt is the first thing Stage 2 produces; the tier ray budgets bend to
   it.
2. **Bounce colour latency.** Without cards, a surface's bounce converges as
   rays hit it (plus lit-frame injection). If a scene reads flat for the first
   second, the lever is coarse-level-first voxelization + higher ray budget on
   the frames after a scroll, not a new structure.
3. **Emissive area lights.** The current analytic emitter path is the sharp
   term the user likes; replacing `emitterShadowPass` is decided by the 3.4
   measurement, and the plan keeps it at ultra if NEE-at-probes reads soft.
4. **Bistro's CPU** (§2.6) is a raster problem; 60 fps there also needs §18
   F2/F4/F5. The GI plan removes GI's share (gbuffer walks, monitor node,
   second submission), not the main pass's 343 draws.
5. **Worker infrastructure is new** to the engine (Vite dev + Tauri build +
   the browser preview build). Unit 2.2 lands it once; every later CPU
   geometry pass rides it.
6. **The SRC gate battery is SRC-shaped.** GI2 needs its own small oracles
   (a CPU DDA mirror, the Cornell colour probe, sunleak). Deleting 3.9 k lines
   of CPU reference code in 0.1 is deliberate — those oracles test the code
   being retired.

---

## 7. SOURCES

Lumen SIGGRAPH 2022 (Wright et al.) · Lumen technical details / performance
guide (Epic docs) · AMD GI-1.0 (GPUOpen 2022) · FidelityFX Brixelizer GDC 2023,
Brixelizer GI GDC 2024 · Godot SDFGI docs, HDDAGI PR #86267 / #119869 ·
Tencent SmartGI, SIGGRAPH 2024 Mobile Graphics (Arm community PDF) · DDGI
JCGT 2019 / 2021, RTXGI SDK sources · Laine, "A Topological Approach to Voxelization"
EGSR 2013 · Schwarz & Seidel 2010 · Crassin et al. 2011 (anisotropic voxels) ·
Panteleev, VXGI GTC 2014 / 2015 · Sannikov, Radiance Cascades (paper source) ·
Split Radiance Cascades (arXiv 2607.20384) · Unity APV docs · web3dsurvey
WebGPU limits/features · WebKit bugs 319770, 305727, 311598, 293626 ·
three.js issues #28921, #29852, #30571, #32735 · toji.dev WebGPU device-loss
best practices. Extracted texts: this session's scratchpad `pdf/*.txt`.
