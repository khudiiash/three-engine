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

| unit | what | gate |
|---|---|---|
| **0.1 dead-code cut** | delete the census list: retired AO pair (~750 lines), RTAO arm (~440), incumbent per-mesh BLAS reflections (~600), sun split (~250), §12.90 adaptive lattice (~200), gather experiments (world keys / smooth / LOS / normal weights, ~500), non-default light-shadow arms (~350), parked mover occluders (284), skinned capsule arm (~110), CPU refs `srcRef.js` (1720) + `srcVolumeRef.js` (418) + `RayHitPacking` CPU mirrors (~1300) + `lightTree` CPU sampler (~500) + `bvhGpu.js`/`RayHitValidator`/`RayHitDebug` (617), the 19 comment-only flags, the 106 numeric knobs' non-default arms, the 15 ≥ 40-line retired-mechanism banners in GISystem.js. ≈ 7.5-8 k lines. Tests that only exercised deleted arms are deleted with them; `package.json` scripts pruned. | module ≤ 53 k lines; `npm run test:gi-*` battery green minus the deleted gates; Bistro/Level/Cornell render identical (`__giColourProbe` receipts) |
| **0.2 memory** | detach CPU twins after upload (`.array` → 0-length view once flushed; verify the incremental `setGeometry` writes at `occupancyField.js:4859-4894` first); release the static-BVH staging (`dynamicObjects.js:2214`); free `surfScratch`/`attrScratch` after the fit; `releaseComputeNodes` sweep at the resize / pool-grow / geometry-revision swap sites; implement `occupancyField.dispose()`; drop the `voxelizeOnce` geometry copy; compute the `bits` size arithmetically so the `makeField` ladder allocates once | Bistro heap **< 2 GB** settled, no climb over 10 min of orbit (`profile.frameStats.jsHeapMB`); `profile.textures` orphans < 50 MB |
| **0.3 rebuild loops** | R4b drain no longer calls `shadowMerge.invalidate("gi-layer-tags")` (tags are GI-private; give the depth key its own bit); governor resolve-resize re-binds targets without a rebuild (or the governor stays OFF — [[frame-governor]]); the second concurrent compile wave cannot start while one is active | `giRebuilds.runs` = 1 per scene open; `shadows.mergedRebuilds` stops climbing |
| **0.4 mobile safety** | IBL blackout only after a transport tally > 0 (gather/tile counters); `device.lost` → drop one tier and rebuild, never same size; total GPU byte budget per tier BEFORE `createOccupancyField`/bin store, clamping pool ceilings and the prefs hint; `#auditPortableBindings` covers uniform buffers + storage textures and FAILS the build; `wgslLanguageFeatures` check with a TSL fallback for the six `wgslFn` kernels; `addEventListener('uncapturederror')`; `probe:gi-portable` runs under Playwright WebKit | portable arm: 0 kernels over any limit; a scene that cannot fit drops tiers instead of dying; WebKit run reports a non-zero transport tally |
| **0.5 boot triage** | `bvhHitShade` 182 kB → roll its inlined slot loops (the §13.14.5 per-inline law; 110 s is one kernel); uniformize the 50 baked scene constants so cold boots produce byte-identical WGSL (re-diff two cold boots — the gate is the diff, not a code reading); gate reflection-probe capture + BVH reflection kernels on a consumer existing | Bistro warm compile wave < 30 s, cold < 60 s; two-cold-boot WGSL diff = 0 lines |

### Stage 1 — MATERIALS OUT OF THE WAVE (~1-2 sessions; shared by both paths)

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
| **4.3 boot** | Bistro cold boot: time-to-first-light ≤ 3 s after assets ready; ≤ 20 kernels; cross-scene cache hits (second scene's compute compile < 1 s) | `probe:gi-boot` on the real project, 3 interleaved runs, sign test |

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
