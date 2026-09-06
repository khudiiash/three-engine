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

### 2.7 "Sun bounce is too weak, it must carry the wall albedo" (2026-08-30)

User report, on Bistro with **Sky > Use for lighting OFF** — so the sun and one
bounce are the only light in the scene, and the shadowed street reads black.

**The measurement.** `npm run probe:gi-sun-bounce` (scripts/gi-sun-bounce.html,
truth in scripts/gi-sun-bounce-ref.mjs). Two grey walls (rho 0.216) 3.5 m apart
and a ground slab, sun 10 at 45 degrees; wall A's inner face is lit above
y = 2.555 and shadowed below, so wall B is lit by nothing but bounce off a
source that is half in shadow. The reference is a 4-bounce path trace over the
three boxes, and the probe reads `srcProbes.gather.gatherAt(P, n).irradiance` —
the same closure the resolve calls per pixel — at the points the reference
answers for.

`SETTLE=40 npm run probe:gi-sun-bounce -- base:a0.2 noshadow:a0.2`:

| point | truth | shipping | `__giSrcNoShadow` | its own truth |
|---|---|---|---|---|
| wall B mid | 0.4773 | 0.345 (**0.72x**) | 1.284 (0.95x) | 1.3467 |
| wall B high | 0.6160 | 0.573 (0.93x) | 0.969 (1.04x) | 0.9322 |
| wall B low | 0.2998 | 0.252 (0.84x) | 1.351 (0.94x) | 1.4372 |
| corridor floor | 0.2486 | 0.253 (1.02x) | 0.586 (0.86x) | 0.6795 |
| wall A shadowed low | 0.0609 | 0.043 (0.70x) | 0.786 (1.08x) | 0.7267 |

⚠ **THE PROBES ARE SCREEN-ANCHORED, SO THE CAMERA IS PART OF THE MEASUREMENT.**
An earlier pose looked along the corridor and left wall A mostly out of frame:
the same arms read 0.67x / 0.89x / 0.69x / 0.80x and wall A's own shadowed face
read a clean **0.0000** — no probes, not no light. Widening the pose to hold
both walls raised the ray count 8.5k → 13.4k and every ratio with it. Any
reading of this probe is a reading of one camera; the shipped pose is the one
that covers the geometry it asks about.

**The gather itself is exact.** A flat unoccluded plane under a uniform sky of
radiance L must read `E = pi*L`; the calibration arm
(`probe:gi-sun-bounce -- plane:sky`) reads **0.3141 against 0.31416**, flat from
the 5 s mark. So the deficit is not a gain error and not the debug view — the
absolute scale is right and the shadowed field is what is short. Run that arm
first whenever a number here looks wrong.

**Two leads REFUTED, both with receipts:**

1. **The sun shadow ray is NOT falsely occluding.** The previous session's
   working theory was "~85% falsely occluded" and it is wrong. Scored against
   the closed form on the population that actually shades — hits produced by
   the shipping `createSrcSceneTrace`, verdicts from the shipping
   `createSrcVisibility` — the marcher agrees on **99.3%** of sun-facing hits,
   with **zero** false-lit and the residual false-dark sitting exactly on the
   shadow line (y 2.56-2.63 against a true 2.555, i.e. under one voxel).
   `failopen` (`__giNoFailClosed`) and a 512-step shadow budget both move
   nothing; `traceHybridPlane` ignores `opts.steps` entirely, so
   `__giSrcShadowSteps` was never a live lever on the shipping path.
   ⚠ The first version of that probe read **14.8%** false-dark — every one of
   them a ray BORN INSIDE A WALL, whose hit is the inside of the far face and
   whose shadow ray is then correctly blocked at exactly the wall thickness
   (t 0.514 on a 0.5 m wall). Excluding those origins is the whole difference
   between 14.8% and 0.7%; a probe that samples where no probe can sit measures
   its own sampling.

2. **It is NOT convergence.** `__giSrcAlpha` pinned to 0.2 (a 5-frame time
   constant instead of the shipping still-scene 0.02) reaches its plateau by
   the 5 s mark and then sits there — 0.3463 / 0.3308 / 0.3365 / 0.3451 across
   the 5/10/20/40 s ladder at wall B mid — and it is the SAME plateau the
   shipping alpha climbs to slowly. The rig runs at ~150 fps (the probe prints
   its frame counts), so this is not frame starvation either.

**What is left, and it is where the next unit goes.** The transport delivers
**0.97x** of truth on average over a SMOOTH field (`noshadow`: every sun-facing
surface lit, ratios 0.95/1.04/0.94/0.86/1.08) and **0.84x** once the same field
has a shadow boundary in it. And the shortfall is not spread evenly — it
concentrates exactly where the boundary dominates the hemisphere:

* wall B **mid**, which looks straight at the shadow line across wall A: 0.72x
* wall B **high**, which sees mostly lit wall: 0.93x
* the corridor **floor**, which sees mostly shadowed wall: 1.02x

So the bias is in how a spatially DISCONTINUOUS radiance field survives the
cascade merge and the tile bake, not in the visibility term feeding them — the
visibility term is 99.3% correct and the smooth arm through the same merge and
the same bake is within 3%. Two named suspects, neither yet measured in
isolation:

* **Orphan bins are a pure darkening when there is no sky.** A bin whose parent
  chain broke keeps its own `T` and the tile bake composites `L_self + T*sky`;
  with sky 0 that is `L_self`, and a c0 bin whose ray crossed its own interval
  unblocked has `L_self = 0`. The probe reports ~4.3k orphans of ~48k bins
  (~9%), which is the right ORDER for the smooth arm's own residual — but it
  darkens both arms equally (the `noshadow` arm carries slightly more), so it
  cannot be the boundary-specific term.
* **The tile bake extrapolates the lobe from its known bins.**
  `E = pi * sum(L*W)/sum(W)` over KNOWN bins only, at `meanKnownBins` 10.38 of
  32. Exact for a uniform L at any bin count — which is precisely why the
  calibration plane is perfect and the smooth arm is nearly right — and an
  extrapolation of whichever two thirds of the lobe was sampled once L is not
  uniform. This is the suspect that predicts the observed shape.

**⛔ SPACING IS NOT A RESOLVABLE LEVER, AND A TWO-TIER READ SAID IT WAS.** The
first version of this section reported "sampling density moves it, angular
resolution does not" off `high` vs `ultra` alone (wall B mid 0.72x → 0.80x) and
that conclusion does not survive the full sweep:

| tier | spacing0 | wall B mid | wall B high | wall B low | floor |
|---|---|---|---|---|---|
| low | 0.80 | 0.65x | 0.81x | 0.76x | 0.83x |
| medium | 0.60 | 0.80x | 0.85x | 0.73x | 0.80x |
| high | 0.45 | 0.72x | 0.93x | 0.84x | 1.02x |
| ultra | 0.35 | 0.80x | 0.86x | 0.82x | 0.88x |

**Not monotonic** — medium beats high at the headline point — and the spread
between tiers is the same size as the spread WITHIN one arm across its own
convergence marks (the `low` arm reads 0.368 / 0.362 / 0.366 / 0.308 at
5/10/20/40 s, a 16% swing with alpha pinned). Repeated `base:a0.2` runs, by
contrast, agree to three decimals (0.3451, 0.3443), so the instrument is
repeatable per arm and the TIER differences are not resolvable above the
per-mark noise. `meanKnownBins` also refuses to move (10.5 / 10.41 / 10.38 /
10.32 across the four tiers) even though ultra quadruples the bins per probe.

What survives the sweep is the thing that reproduces at every tier: the
shadowed arm lands **0.65-0.88x** and the smooth arm **0.95-1.05x**, with the
visibility term 99.3% correct and the calibration plane at 1.00x underneath
both. Quantization is out independently (`DEPOSIT_F` is 16, so a 0.486 radiance
is ~1993 quanta).

**The instrument the next unit needs** is bin-level, not point-level: read the
merged c0 payload at wall B's own probe and compare each bin's radiance against
the reference's radiance along that bin's direction. Point-level irradiance can
say the hemisphere integral is 0.72x; only the per-direction comparison can say
which directions lost it.

### 2.7b What Bistro adds on top (2026-08-30, measured on the live editor)

~0.8x of the right answer is a visible deficit, not a black street. Three
Bistro-specific mechanisms were measured on the user's running editor, and each
is larger than the corridor's number:

1. **THE DETAIL BOX FOLLOWS THE ORBIT PIVOT, SO THE VIEWER STANDS IN THE
   FALLBACK.** `#detailFollowTick` anchors on `engine.cameraFocus` in edit mode
   (the §16 anti-metronome change, 2026-08-24), NOT on the camera. Measured:
   volume centre (10.5, 11.5, 8.5), size 47x37x47 — x in [-13, 34] — against a
   viewport camera at (-10.17, 2.84, -0.67) whose orbit target is
   (10.98, 6.29, 7.92). The centre IS the pivot, lattice-snapped. The camera is
   then **2.83 m** from the -x face while the F3 feather is `4 * probeSpacing` =
   **4.0 m**, so `w = 1 - 2.83/4 = 0.29` of the indirect at the viewer's own
   position is already the far-field constant, reaching 1.0 a few metres out.
   That constant is `mix(luma, rgb, 0.35) * 0.6` — 65% of the chroma stripped —
   shaped only by `N.y*0.4 + 0.6`, and it carries **no occlusion term at all**
   (it runs after the AO block by design). Flat, grey, and bright where the
   geometry says dark: exactly "washed out, doesn't carry the wall albedo,
   bright leaks where they should not be". ✅ CONFIRMED by the user — moving the
   orbit pivot next to the camera restored chroma and structure and removed the
   blob.
2. **THE FRAME GOVERNOR RE-MINTS THE FIELD.** `adaptiveQuality` is ON in this
   scene with `targetFps` 60, against a 44 ms GPU frame it can never reach.
   Caught live: `governor level 2, scale 0.52, changes 1` and
   `giRebuilds.log: "resolve-resize 1596x1002→1151x723 (giCostScale 0.52)"`.
   That path recreates every GI target and does
   `screen.srcProbes = screen.srcProbes.setSize(...)` — **the accumulated bounce
   is destroyed with the probes.** Its own comment already warns about "a render
   scale that chases frame time". This is the user's "GI is constantly
   reloading", reported many times; it also keeps the bounce permanently
   un-converged. The setting is supposed to default OFF for exactly this reason
   ([[frame-governor]]).
3. **The volume is 47 m for a 140 m scene** (`detail volume covers 20%`), and
   the auto-fit forces `probe spacing 1.00m` even at "ultra", whose own
   `spacing0` is 0.35. Raising Quality cannot fix it; only the §19 clipmap can.

The corridor stays the half a transport fix can be gated on; these three are
what make the same engine read far worse on the user's actual scene.

### 2.7c The GPU frame, once the look was right (2026-08-30)

With the two fixes below in, the scene reads correctly and matches a reference
path tracer — and the complaint becomes 20-30 fps. Measured live: **cpuMs 16.78,
gpuMs 33.12**, 384 draws. GPU-bound, and GI is essentially the whole of it (the
raster side barely registers, which is a reversal of §1's CPU-bound baseline).

`profile.giPasses` measures each pass in isolation and so over-reports ~2x (its
66.7 ms against a real 33.12); the RANKING is what is solid, and the halved
column sums to the actual frame:

| pass | isolated | ~real | sized by |
|---|---|---|---|
| deposit (decay) | 13.3 | ~6.6 | **the allocated bin pool** |
| emitterShadowPass | 15.5 | ~7.7 | resolve pixels x 2 live emitters |
| deposit (resolve) | 10.1 | ~5.0 | **the allocated bin pool** |
| gather | 6.4 | ~3.2 | resolve pixels |
| merge | 5.4 | ~2.7 | live bins |
| tiles | 4.1 | ~2.0 | live tiles |
| shade + bounce [J] | 3.1 | ~1.5 | hits |

**SHIPPED: the decay skips empty bins.** `BIN_BUDGET` is a tier constant, so the
decay dispatch is sized by the POOL and not by the live set — on this scene
26,431 live probes of 61,440 capacity, i.e. **56% of all bins belong to blocks
no probe has ever claimed**, and the pass was the frame's most expensive single
dispatch. `count == 0` implies every DECAYED word is already zero (each is
incremented only alongside `count` and by at most as much, and the decay
`floor(x*k+0.5)` is monotonic, so `x <= count` survives any number of frames),
and `floor(0*k+0.5) = 0` — so the loop it skips writes 0 over 0. Bit-exact, not
an approximation. ⚠ The guard is "has content OR is being zeroed" (`k <= 0`),
never "has content": `BIN_SN` is never decayed, so a long-dead block can hold a
stale normal after its count has faded, and the ONE event that clears it is the
reclaim arriving as `k = 0`. Skipping that frame is the §12.82 defect that cost
"a quarter to a half of the picture's light".
Gates: `test:gi-src-deposit` PASS (its RETIREMENT arm exercises the reclaim
cycle), `test:gi-src-merge` PASS.

⛔ **`test:gi-src-temporal` IS RED, AND IT WAS RED BEFORE THIS SESSION.** Two
checks: "no reclaimed bin carries a fraction of a ray from its last owner"
(~3.1-3.4 k bins hold a decayed weight) and "the reclaimed blocks hold exactly
the new probes' first frame" (9015 ray-weights vs 1536 deposits). Verified
pre-existing by stashing the change and re-running; the bin count is also NOT
deterministic run to run (3137 / 3418 on two identical baseline runs), so the
3239 measured with the change sits inside the baseline's own spread. It is a
real defect — stale energy surviving a reclaim, which is exactly what the
claim-stamp `k = 0` exists to prevent — and it wants its own unit.

▶ NEXT, same shape, NOT taken: the deposit RESOLVE also dispatches over the
pool. It already early-outs on `count < MIN_WEIGHT` but still writes
`payload[3] = -1` every frame for every dead bin. Skipping that write is only
safe if the payload's T word is INITIALIZED to `PAYLOAD_UNKNOWN` (it is zeroed
today, and 0 reads as KNOWN-and-black) and if the reclaim frame still writes —
a block zeroed by `k = 0` goes from `>= MIN_WEIGHT` straight to 0 without ever
passing through the "below the floor but non-zero" state the skip would rely
on. One write saved against eight read-modify-writes, for materially more risk;
worth doing only with the same bit-exactness argument written out first.

**FIXED 2026-08-30 (1 and 2); 3 is the clipmap's job.**

* **(1) `#detailFollowTick` now clamps the followed point so the camera stays a
  full feather (plus one cell) inside the box.** The EMA is left pure — the
  clamp writes a separate `want` vector — and the band test is OVERRIDDEN when
  the viewer is starved, because the band is a comfort throttle and a viewer
  standing in the fallback is a correctness violation. On the measured Bistro
  pose the clamp moves the target only 2.2 m against a 7.8 m band, so without
  that override the band would have swallowed the entire fix. The slide
  throttle still applies to both paths, so it cannot become the §16 metronome
  the focus-follow was introduced to kill. `4 * probeSpacing` now lives in
  `#farFieldFeatherM` and is read by the three `farField` sites AND the clamp,
  so the margin and the thing it protects against cannot drift apart.
  Gate: `npm run test:gi-detail-follow`, with `__giDetailViewerClamp = false`
  as the negative control. Receipts — a 160 m street, camera at x = -60, orbit
  pivot 30 m ahead:

  | arm | box x | camera x | camInside |
  |---|---|---|---|
  | `clamp=0` (pre-fix) | [-50, -10] | -60 | **-10 m — outside the box entirely** |
  | shipping | [-67, -27] | -60 | **+7 m** (needs >= 4) |

* **(2) `adaptiveQuality` turned OFF on the user's Bistro scene** — the engine
  default is already `false` (`SCENE_SETTINGS_DEFAULTS`), the scene had it on.
  Verified after: `governor enabled false, lastReason "disabled"` and
  `giRebuilds.log` clean of `resolve-resize`. No engine change: the governor's
  own CPU-bound guard (`DROP_OVER_CPU_BOUND` 1.35) was working correctly — it
  simply cannot help a scene whose 44 ms GPU frame can never reach a 13.3 ms
  aim, and every rung it does take costs a full field re-mint.
  ▶ STILL OPEN as engine work: a rung change must stop re-minting the field
  before this setting can be safely defaulted on ([[frame-governor]]).

**Also checked this session:** the sky term. With the flat background colour as
sky (giConfig `sceneSkyRadiance`, 2026-08-30) `base:sky` reads
1.20 / 0.98 / 1.34 / 1.07 / 1.22 of the path-traced sky truth and is still
descending at the last mark — mildly HOT and converging down, the opposite sign
to the sun's deficit, so the two compound in a real scene: sun bounce short and
ambient long is exactly "flat, and the bounce does not read". Not the leak an
earlier lidded-corridor arm suggested, though. That arm was inconclusive by construction: the lid left the tube
open at both z ends, and from wall B those two apertures are worth about half
the open sky.

---

### 2.7d "Reflections look too flashy and unnatural" (2026-08-30)

> ⛔⛔ **THE FIRST CUT FLICKERED AND WAS RETRACTED THE SAME HOUR.** User, on the
> live editor: *"nope, now light flickers, its terrible."* `giLight.js` is
> reverted to HEAD. The derivation below is still believed correct; the DELIVERY
> was not, and the failure is worth more than the analysis:
>
> ⭐⭐ **I TURNED A NOISY PER-PIXEL INPUT INTO A HARD GATE ON A LARGE TERM.**
> `exactFidelity` was driven by `hitT` — the BVH prepass's traced distance. That
> texture is NearestFilter BY DESIGN (this file's own banner: blending two t's
> across a silhouette lands on no real surface), it is written at the prepass
> STRIDE with block replication, and it is 0 on a miss or a masked pixel. So
> `smoothstep(0.25, 1, cap/lobe)` swung between 1 and 0 as `t` moved — and t=0
> reads as "fully faithful", the maximum. A whole share of the specular term
> switched on and off per pixel per frame. That is a step function on a
> discontinuous signal, i.e. the exact thing the standing rule forbids ("light
> must arrive in natural gradients, without hard edges or rapid changes").
>
> The OLD code used the same `t` and was fine, and the contrast is the lesson:
> it spent it inside `distFactor = t/(t+dist)` CLAMPED to [0.25, 1], a bounded
> multiplier on a BLUR RADIUS. Noise there moves a blur slightly. I moved the
> identical signal onto the WEIGHT OF THE TERM, where the same noise is a
> flicker. ⭐ **Where a noisy input is spent decides whether its noise is
> visible — a radius forgives it, a weight does not.**
>
> ⚠⚠⚠ **AND NOT ONE INSTRUMENT IN THIS REPO COULD HAVE SEEN IT — INCLUDING THE
> ONE BUILT FOR FLICKER.** Everything in this section measures CONVERGED
> irradiance at fixed points, and `test:gi-hit-shade` reported "NOISE: drift
> 0.2% PASS" because it holds a POSE. The obvious answer — "we have
> `run-gi-flicker-frame.mjs`, a per-frame GPU accumulator that counts direction
> reversals and step amplitude" — is wrong, and checking rather than assuming is
> the point: it accumulates over `targets.irradiance`, the DIFFUSE resolve.
> **Every reflection term lives in `giLight`, downstream of that texture, so the
> whole specular chain is outside its field of view.** Reflection flicker
> currently has no instrument but the user's eye, which is how this reached
> them. ▶ **OPEN, and now the top infrastructure item for this area**: point the
> same accumulator at the composited frame (or track fixed WORLD points across a
> slow orbit and take the normalised SECOND difference, which separates smooth
> view-dependence from a flipping gate). [[probe-blind-statistics]].
>
> ✅ **RE-SHIPPED with the input replaced, not the idea.** `exactFidelity` is now
> a function of `roughness` and `cameraProjectionMatrix` ALONE — `t` is taken as
> `~dist`, which collapses the radius to `α·P/4`. Both inputs are constant for a
> given surface point across frames, so flicker from this term is impossible by
> CONSTRUCTION rather than by testing, which is the only standard of evidence
> available while the instrument gap above is open. The cost is that a far
> reflection no longer smears more than a near one — second-order, and not worth
> buying with a temporal artifact. Effective band: the traced sharp image now
> fades out over roughness 0.25 → 0.40 instead of 0.15 → 0.45, monotone and
> smooth in roughness, with mirrors (r ≤ 0.15) still bit-identical.


**The report, and what is new about it.** Sponza, side by side with the parallel
session's GPU path tracer: *"could you check our reflections against the path
tracer? ours look too flashy and unnatural"*, and *"AO as well — ours does not
work enough to cover how it covers in path tracer"*. The path-traced frame is
darker, with deep contact darkening in the arcades; ours is flatter and brighter
with white speckle across the ivy and a sheen on the banners.

⭐ **What is new is not the complaint, it is the REFERENCE.** Both of these had
been argued before with no ground truth to argue against, and both arguments
went the wrong way:

- §16 R4 tried to move rough materials off the exact-reflection path and was
  reverted the same night, recording *"the hit-shaded exact radiance is REAL
  LIGHT (at grazing angles Fresnel drives rough-surface specular high) … the
  22.7 ms is real lighting, not waste."* The only evidence was that removing it
  made shadowed walls murky, so the energy was assumed correct.
- The roughness prefilter's reach (`12` texels) was picked when the only
  available judge was "does it still look messy".

Neither is a measurement. Both are now checkable.

**Two structural facts, first, so the rest is not read as tuning.**

- Sponza's 25 materials are all shader-graph materials whose roughness comes
  from an ORM texture's green channel, so `staticRoughnessOf` returns null and
  every one of them is mirror-bucket 3 → `canMirror`. The exact-reflection and
  mirror-trace paths are live across the WHOLE scene, at per-pixel roughness.
- `[gi] reflection albedo atlas: 25 materials (0 textured)` is the STALE
  COUNTER, not a finding: `texturedCount` counts canvas draws only, and all 25
  of these are compressed (KTX2), so they take the `pendingGpuTiles` path and
  land as `reflection atlas gpu-blit: 25 compressed tiles`. Reflections on this
  scene ARE textured. (Memory `gi-emitter-seats-uncorrected` / the R7b line
  flagged this counter as unreliable; this run confirms it.)

**THE PREFILTER IS THE RIGHT SHAPE AT A TENTH OF THE RIGHT SIZE.** The exact arm
traces ONE mirror ray per pixel whatever the roughness, and blurs the result
over `smoothstep(0.02, 0.45, roughness) × 12` shadow-channel texels. Derive what
that radius should be instead of picking it: a GGX lobe of slope `α = r²` covers
a world radius ≈ `α·t` at a hit `t` metres down the reflected ray, and a world
length at view depth `D` projects to `L·P/(2D)` in UV. At 1080p with the shipped
half-res shadow channel the cap is ~2.2% of screen height; the lobe wants

    r 0.15, t/(dist+t) 0.3   ~0.7%    inside the cap — a mirror is a mirror
    r 0.30, t/(dist+t) 0.3   ~2.9%    was ~1%
    r 0.45, t/(dist+t) 0.3   ~6.4%    was ~1.2%

so through the whole gloss band the filter is 3-10x too narrow, and being an
order of magnitude too narrow IS what "flashy" looks like: a glossy wall showing
a near-mirror image of the room where a broad dim sheen belongs. It also
explains the ivy speckle without any noise term — leaf cards have near-random
normals, so the reflected direction (and therefore the traced hit) changes
wildly pixel to pixel, and a delta lobe reports that faithfully where an
integrated one would not.

**Shipped: the radius is derived, and the traced image is never shown sharper
than the lobe it stands for.** `giLight.js`, the exact-blend site.

1. The radius comes from `α` and `cameraProjectionMatrix` — per axis, so a
   non-square viewport blurs a circle. Nothing tunable. ⛔ The hit distance is
   deliberately NOT read here; see the retraction banner above.
2. ⚠ **The old hand-tuned reach survives as the CAP, and that is not a
   compromise — it is what 12 taps can carry.** Two hex rings stretched over a
   6% radius stop being a blur and become twelve copies of the room, which is a
   worse artifact than the sharpness it set out to fix and breaks the standing
   "no noise, no edges, no steps" rule outright.
3. So where the cap binds, `exactFidelity = smoothstep(0.25, 1, cap/lobe)`
   hands those pixels back to the term that is broad BY CONSTRUCTION — the
   cascade radiance lookup the blend already mixes against. All three sharp-image
   consumers carry it, and it has to be all three or the fix is invisible: the
   exact blend, the mirror trace (which composites OVER the exact blend), and
   the env-miss HDRI tap — the worst of them, one equirect sample with no
   prefilter of any kind, on an outdoor map whose brightest feature is a sun
   disc thousands of times the sky around it.

⚠ **This is deliberately NOT §16 R4 again.** R4 compiled the directional chain
OUT of rough materials, so its light vanished and shadowed walls went near-black.
Nothing is compiled out here; both terms stay live and weight only moves BETWEEN
two pictures of the same room, one sharp and one blurry.

Behaviour, derived: at `r ≤ 0.15` fidelity is exactly 1 and a mirror is
unchanged pixel-for-pixel (`test:gi-hit-shade` confirms — mirrorShadow 0.3560 /
mirrorLit 0.3038 against a 0.3584 / 0.3047 stash-baseline). At `r 0.3` a contact
reflection keeps ~0.9 and a far one drops to ~0.01: rough surfaces lose the
distant sharp reflection and keep the near one, which is the physics.
`__giExactPrefilter = false` restores the pre-2026-08-30 build whole.

⛔ **`test:gi-hit-shade`'s SHADOW arm was RED BEFORE THIS CHANGE** (x0.863 vs
x0.849 baseline; x0.853 vs x0.849 after) — proven by stashing giLight.js. ⚠ That
test also produced ONE wild arm (mirrorLit 0.1950 where both the baseline and a
re-run read ~0.304), so a single run of it is not a regression signal either.

### 2.7e "AO does not cover the way the path tracer covers" — IT IS NOT THE AO TERM (2026-08-30)

**The engine splits occlusion in two, and the report is about the OTHER half.**
`createGiResolve`'s AO block states the contract: the cascade carries every
blocker at or above the probe lattice, and the AO term is only the sub-lattice
band left over — which is why it multiplies the GATHER alone and why the `min`
composition exists (charging one occluder twice reads as dirt). GTAO is what
ships (`#armGtaoPass`; `#armRtaoPass` is opt-in behind `__giAoRaytraced`, and
memory `gi-vxao-rebuild` said the opposite — corrected). A metre-deep Sponza
arcade is squarely the CASCADE's half, so if the cascade leaks, no AO setting is
the fix.

**⭐ THE OCCLUSION LADDER — `npm run probe:gi-sun-bounce -- base:sky:occ`.** Same
corridor, same path-traced reference, different question. Under a uniform sky a
point that sees a fraction V of its hemisphere receives V·π·L before
inter-reflection, and `irradianceAt` already returned `escape` — the
cosine-weighted first-bounce sky visibility, i.e. the GROUND-TRUTH AO FACTOR.
The rig runs `ao: false`, so this measures the cascade ALONE. Six points from
open sky to canyon floor; ⭐ the verdict is the SHAPE against V, not any single
ratio, because a gain error is flat in V and cancels there while an occlusion
error is not.

    point                   truth    engine   ratio  V (true AO)
    wallB top (open sky)    0.3142   0.2880   0.92x  1.000
    wallB high (y 5.2)      0.1564   0.1491   0.95x  0.448
    corridor floor centre   0.1094   0.1161   1.06x  0.305
    corridor floor at wall  0.1006   0.1094   1.09x  0.282
    wallB mid (y 2.2)       0.0757   0.0893   1.18x  0.181
    wallB low (y 0.3)       0.0537   0.0769   1.43x  0.110

**Monotone in V, and it reproduces.** open (V≥0.5) 0.92x, enclosed (V<0.25)
1.31x → **the cascade puts 1.4x too much light per unit truth into enclosure**,
before AO runs at all. That is the user's report exactly: our corners start too
bright, and AO is being asked to pay a debt the transport ran up.

**⭐⭐ AND IT IS NOT A BUDGET PROBLEM — the ultra arm settles that.** Ultra
spends 3.4x the rays (35 000 vs 10 312) on a finer lattice (spacing0 0.35 vs
0.45) and the leak does not shrink: open 0.93x, enclosed 1.39x, **1.50x**.
`knownFrac` is 0.5129 at ultra against 0.5165 at high and `meanKnownBins` 10.32
against 10.39 — i.e. **half the cosine lobe is unknown at BOTH tiers**, invariant
to the budget. So the bias is structural, not starved.

**Named suspect, and the code already names it.** `srcTiles.js` bakes
`E = π·Σ(L·W)/Σ(W)` over the KNOWN bins and its own banner says why that is the
problem: *"`E` is renormalised over the KNOWN bins, which is unbiased only if
those bins are a random subset of the lobe; they are not — they are the bins
rays happened to reach."* In an open hemisphere that extrapolation is harmless
(uniform L — hence the 0.92x open anchor and the near-perfect `plane` arm). In an
enclosure the known half is biased toward whatever the rays could reach, and
spreading it over the dark half is a leak whose size scales with enclosure —
which is the measured shape.

⚠ **§12.87's coverage fraction cannot fix this and does not claim to**: its own
banner says *"It cannot darken anything: `acc` and `wsum` in the gather carry the
same factor, so a uniformly-downweighted point renormalises back to the same
mean and only the RATIO between corners moves."* Coverage fixes WHICH neighbour
wins a cell; it does not fix the extrapolation inside one texel.

▶ **THE NEXT UNIT, and it is now specified rather than guessed**: make an
unknown bin cost something instead of inheriting the known mean. The gate is
this ladder — enclosed/open must come to ~1.0 without moving the open anchor off
0.92x, and `test:gi-src-tiles`/`test:gi-src-gather` must stay green because both
twins read the same rule.

⛔ **DO NOT "FIX" THIS BY TURNING AO UP.** GTAO's radius is derived from the
cascade (`s0 · R0_OVER_S0 · 2` ≈ 1.4 m at high) precisely so the two terms do not
overlap. Widening it to cover a metre-deep arcade charges the same occluder in
both halves — the dirt the `min` composition was built to prevent — and would
also break "GI has three properties, no tuning knobs".

⚠⚠ **INSTRUMENT TRAP, PAID FOR THE THIRD TIME THIS SESSION.** The ladder's first
cut put its mid-V sample on the ground OUTSIDE the walls (x 3.2), which wall A
hides from a camera standing in the corridor. Screen-anchored probes answered a
clean `0.0000` at every mark — "no probe", not "no light" — and averaging that in
as data pulled the open mean 0.92x → 0.46x and reported a **3.03x** leak where
the real figure is 1.42x. ⭐ **A zero from a screen-anchored probe is never a
datum.** The runner now excludes zero readings from the trend, names the points,
and FAILS the run rather than quietly averaging them.


### 2.7f "They glow in the dark" — THERE WAS NO SPECULAR OCCLUSION (2026-08-30)

> ⛔ **THE RAW SPECULAR-AO MULTIPLY WAS RETRACTED AFTER THE METAL CONTROL.**
> `createGiResolve` has no material roughness; multiplying its scalar
> cosine-hemisphere AO into the directional glossy lookup therefore applied the
> same visibility to a rough lobe and a perfect mirror. On tiers without the
> exact trace (and on exact-miss/skip pixels), a metal has no diffuse fallback,
> so `metalness = 1` could turn black even while it should reflect a visible
> light or wall. The multiply was removed; diffuse AO and occupancy/world AO
> remain. A future specular-occlusion term must be roughness/direction aware at
> the material composite, not a raw resolve-space reuse. This removes ALU and
> adds no ray, pass, texture, or storage binding.

**Report.** Sponza against the path tracer: the gold embroidery, the metal trim
and the ivy are *"a bit emissive — glowing in the dark for some reason, they must
not be"*, and then the user's own guess, *"maybe they just reflect something they
shouldn't."* That guess was right. A later pair sharpened it to the pattern that
matters: **"our shaded area is much darker overall, and the reflective areas are
much brighter."** One frame, both errors, opposite signs.

**The initial mechanism hypothesis.** In
`createGiResolve` the composed AO factor multiplied `out` — the diffuse gather —
and stopped there. `reflectedOut`, the glossy radiance handed to giLight, was
assigned afterwards and never occluded. The engine had **no specular occlusion
at all**.

Why that lands on these materials and not their neighbours: Sponza's
`Material_13` and `_21` are metalness **1.00 on 100%** of their texels and `_20`
on 87% (read off the ORM maps' blue channel — correctly authored gold thread).
⭐ **A metal has no diffuse term**, so its whole appearance is reflected radiance
× its own colour. The cloth it is stitched into got its corner darkened; the
thread got none, and had no diffuse to dilute the miss.

⚠ **The old comment — "Reflections keep their own visibility" — was HALF right,
which is why it survived.** A TRACED reflection does own its visibility (a real
ray). `reflectedOut` is not one: it is the cascade radiance LOOKUP in the
reflected direction, carrying only the lattice's occlusion, which §2.7e measured
at 1.4x too much light in enclosure. **ATTEMPTED, THEN RETRACTED**:
`aoFactor` × `reflectedOut`. The argument that giLight would always replace it
with the exact trace missed two normal cases: lower tiers have no exact trace,
and traced pixels can miss/skip. In both cases a smooth metal consumed the
hemisphere-darkened lookup whole.

⭐ **Why the attempted term looked self-consistent.** giLight computes
`mix(directional, diffuseLimit, smoothstep(0.22, 0.6, roughness))` where
`diffuseLimit = irradiance/π` — irradiance the resolve has ALREADY multiplied by
AO. The two ends of a single mix carried different visibility, so how much
occlusion a surface received depended on its roughness. Gate: `test:gi-hit-shade`
(ao defaults ON, so the term is live there) mirrorLit 0.3047/0.2991 against a
0.3086/0.3034 baseline — a ~1% move, which is the CORRECT size for that rig: its
subject is a mirror, and a mirror replaces this term rather than occluding it.

**⛔ TWO THEORIES FOR THE DARK HALF, MEASURED AND BOTH REFUTED before anything
was changed for them:**

- ⛔ **NOT a tonemapping mismatch between the two views.** The obvious confound —
  a filmic path-tracer view against a linear frame would clip our highlights AND
  lift their shadows, producing exactly the reported pattern for free. It is not
  happening: `three-gpu-pathtracer`'s `RenderToScreenMaterial` defaults to
  `toneMapping(NoToneMapping, 1.0)` and the integration never sets it, while the
  scene is `toneMapping: "linear"` at exposure 1. Both are identity. **The
  comparison is valid and the energy difference is real.**
- ⛔ **NOT the sky being too dim.** `sceneSkyRadiance` returns a flat neutral
  `(1,1,1) × environmentIntensity` for ANY environment texture — it never reads
  the map. Decoding the scene's actual HDRI ("Industrial Sunset Pure Sky", 2k):
  mean radiance **0.705** (R 0.618 / G 0.712 / B 0.894), peak luminance **472**,
  and the true cosine-weighted irradiance on an up-facing unoccluded surface is
  **2.715** against the **π = 3.14** we transport. **We are 1.16x HOT, not dark.**
  ▶ What IS wrong there is chroma and DIRECTION, not energy: the real sky is
  blue-ish and contains a 472-luminance sun, and we deliver flat grey.

**⭐⭐ THE ATTEMPTED TERM WAS INERT ON THIS SCENE, AND MEASURING WHY NAMES THE REAL
GAP.** User, on the build: *"looks identical to before."* They are right, and the
live scene says exactly why — `debugView: "ao"` on their own Sponza:

    AO: mean 0.905  min 0.271  p05 0.643  p50 0.949  p95 0.996

**Half the screen has AO ≥ 0.95.** Multiplying the reflection by that was a 5%
darkening here: worth nothing on this frame, while the later smooth-metal
control showed that the same raw multiply is incorrect where AO is low. (Same
session, `debugView: "reflections"`: glossy field mean luma 0.022 on
90.3% of texels, exact BVH 0.026 on 34.9%.)

⚠⚠ **AND GTAO CANNOT SIMPLY BE WIDENED TO COVER THE GAP — IT IS STRUCTURALLY A
CONTACT TERM.** Its world radius is derived (`s0 · R0_OVER_S0 · 2` = 1.12 m at
ultra), but its SCREEN reach is capped at `MAX_REACH = 0.25` of frame height, and
that pass's own banner records the measurement: at 1080p a 1.12 m radius already
*"wants 263 px and 0.15 allowed 72"*, and lifting the cap to 0.25 moved the
contact from 0.696 to 0.700 — nothing. A fixed step count over a bounded pixel
reach cannot reach metres.

⭐⭐ **SO THE 1–5 m OCCLUSION BAND HAS NO OWNER.** The design splits occlusion at
the probe lattice: cascade above, AO below. §2.7e measured the cascade delivering
**1.4x too much light** in enclosure and not improving with budget; this measures
AO at **p50 0.949**, and it cannot be widened. Sponza's arcades are several
metres deep — squarely in the band neither half covers. That single fact is the
whole of *"the reflective areas are much brighter"*, and it is why nothing
downstream of it can be fixed first: **specular occlusion, and any other consumer
of the AO factor, stays inert until the cascade's half arrives.**

⛔ **CORRECTION to §2.7e's closing advice.** That section said "do not turn AO up,
the cascade owns that band". The first half stands and the reason is now stronger
(the reach cap makes it impossible, not just wrong). The second half was too
generous: the cascade does not *own* that band, it *fails* it. Nothing owns it.

▶ **OPEN — and it needs the real scene, not the corridor.** The corridor rig says
enclosure is 1.4x too BRIGHT; Sponza's shaded arcade reads far too DARK. Those
cannot both describe the same quantity, and the difference between the rigs is
that Sponza's sky is a directional HDRI reduced to flat grey while the corridor's
was already uniform. The next unit is a term-by-term readback IN SPONZA — gather,
AO factor, glossy radiance at points in the shaded arcade vs the sunlit strip —
i.e. [[gi-colour-probe-method]] applied to the real scene, since the FIRST wrong
stage is the answer and no amount of corridor work can name it.



### 2.7g ⭐⭐⭐ THE REFERENCE WAS RENDERING DIFFERENT MATERIALS (2026-08-30)

**Every comparison in §2.7d–f was made against a path-tracer view that could not
see the scene's roughness or metalness maps.** Found while chasing why Sponza's
ivy renders as silver foil for us and matte green for it.

**The chain, and it is four links of nothing-looks-wrong:**

1. `matchStockPbr` (tslGraph.js) decides whether a `.mat` becomes plain three
   material properties or a compiled node graph. It rejected any graph
   containing a node type outside `texture / normalMap / principledBsdf /
   output`.
2. **Every glTF import writes a `color` + `multiply` pair** — the importer
   multiplies `baseColorTexture` by `baseColorFactor` (`#cacaca` here). So all
   25 Sponza materials were rejected over a two-node factor chain.
3. The graph path drives `roughnessNode` / `metalnessNode` and **never sets the
   stock slots**, so `material.roughnessMap` and `material.metalnessMap` stayed
   NULL — while the stock SCALARS kept what the .mat stored, which on any glTF
   import is `roughness: 1, metalness: 1` (they are the factors the maps
   modulate).
4. `three-gpu-pathtracer` reads material data through exactly those standard
   properties (`getTexture(m, 'metalnessMap')`, else `material.metalness`).

⇒ **The reference rendered all of Sponza as fully-rough, fully-metallic.** It
could not display a glossy reflection at all, which is a large part of why ours
read "too flashy" beside it; and it had no diffuse anywhere, which puts an
uncontrolled variable under the "ours is darker" comparison too.

⭐ The ivy is the clean example. `Material_20` is the alpha-cut foliage and its
ORM map really does say metalness 0.72 / roughness 0.31 on the OPAQUE leaf
texels (re-measured masked by the leaf alpha, because the first read could have
been sampling the cutout background — [[probe-blind-statistics]]). **We honour
the asset and get a glossy metal; the reference used roughness 1 and got matte.**
Whether 0.72 metal is sane authoring for foliage is a separate question — but we
were rendering it faithfully and the thing we were being judged against was not.

✅ **SHIPPED: `matchStockPbr` folds a constant-colour multiply.** Exact rather
than approximate, by the same argument its ORM branch already makes: three
composes `diffuseColor = material.color * texture(map)`, which is precisely what
`tex -> multiply <- color -> bsdf.color` emits. Kept as narrow as the ORM branch
(one multiply, one constant, operands exactly those two, output only to
`bsdf.color`); anything else still falls through to the compile path.

Receipts: 25 of 25 Sponza materials now match, each returning `map` +
`roughnessMap` + `metalnessMap` + `normalMap`. Six negative cases hold (multiply
with no constant, constant with no multiply, multiply of two textures, multiply
into the wrong slot, direct `texture -> color`, unknown node type). `nodegraph`,
`material-pipeline`, `default-material-fork` and the parallel session's
`gi-pathtracer-materials` suites are green. Pixel parity is structural, not
argued: `loadShaderTexture` IS `loadTexture` (one line, `export const
loadShaderTexture = loadTexture`), so both paths bind the same texture instances
with the same per-file colour spaces (diffuse `srgb`, ORM/normal `linear` from
each `.meta`). `__noStockPbr = true` forces the old path for an A/B.

⭐ Two payoffs from one gap: the reference becomes comparable, and 25 materials
that each cost their own codegen now share one program — which is the compile
wave this function was written to collapse (44 s of materials at §2.7c).

⚠ **The GI findings in §2.7d–f are NOT retracted by this** — they were measured
on the corridor rig against a CPU path trace, not against this view. What is
suspended is the reading of the SCREENSHOT comparisons: re-take them.



### 2.7h ⛔ REFUTED: the per-probe ray cap does NOT cost energy (2026-08-30)

**The hypothesis, and it was the user's.** *"When it just appears, it is
brighter, closer to what it should be, and gets darker with time."* Their Sponza
sun runs on a rotating script, and the console shows the light-track window
arming on every change and **lifting the probe ray cap to OFF**, then closing and
dropping it back. If energy tracked ray count, that is exactly the reported
flicker in brightness. `npm run probe:gi-sun-bounce -- base:cap0 base:cap32`
(new `cap<N>` tag) was built to test it.

⛔ **REFUTED, and my own first run is the cautionary tale.** Run 1 read
`wallA shadowed low` at **0.72x capped vs 1.02x uncapped** and, with an older
`base` run at the tier default reading 0.66x, looked like a clean monotone
dose-response over 16 → 32 → uncapped. It was reported as the session's biggest
finding. Run 2, three arms in ONE process over a **7x ray-budget range**
(5 478 / 17 102 / 37 832 rays):

    point                 truth    cap8    cap32   uncapped
    wallB mid             0.4773   0.71x   0.71x   0.70x
    wallB high            0.6160   0.85x   0.86x   0.86x
    wallB low             0.2998   0.78x   0.77x   0.74x
    corridor floor        0.2486   0.78x   0.81x   0.76x
    wallA shadowed low    0.0609   1.02x   0.83x   0.84x   ← FEWEST rays reads HIGHEST

Four of five points are **flat to within 0.02 across 7x the rays** — the bake's
weight normalisation is correct and ray count buys variance, not brightness. The
fifth is the smallest truth in the ladder (0.0609) and swings 0.72–1.02 between
runs of the SAME arm. The "climb then sag" shape was not reproducible either:
cap32 fell back in run 1 and climbed monotonically in run 2.

⭐⭐ **I read a trend off the noisiest point of a five-point ladder, on one run,
having already written the rule that forbids exactly that** (§2.7's own RETRACTED
box: "the tier spread equals the spread WITHIN one arm"). The dose-response was
three numbers from three different processes. ⚠ **A ratio whose denominator is
the smallest value in the ladder is the LAST place to read a trend, not the
first** — put the confirmation run before the claim, not after it.

⚠⚠ **AND A BLIND STATISTIC FELL OUT OF THIS, which touches §2.7e.**
`meanKnownBins` reads **10.39** and `knownFrac` **0.5165** in all three arms —
identical to four significant figures across a 7x ray range. A statistic whose
name means "how much of the lobe rays actually reached" cannot be invariant to
the ray budget; it is measuring something else (a fixed lobe geometry, most
likely). §2.7e cited exactly that invariance as evidence that the corner leak is
structural rather than starved. **That argument is withdrawn** — the leak's
measured SHAPE (monotone in true sky visibility, reproduced across two tiers)
still stands on its own, but "knownFrac is flat, therefore not a budget problem"
does not. [[probe-blind-statistics]]: the instrument could not see its subject.

▶ **The user's observation is still unexplained and still theirs to keep.** The
corridor rig does not reproduce it under any ray budget, so whatever causes it is
absent here — a moving light, LOD cascades, scene scale, the window's own
re-keying. It needs the real scene, not this rig.

**What survives, and it is the same three numbers as before:** sun bounce settles
at **0.70–0.86x** of path-traced truth in every arm of both runs (that
reproducibility is the honest signal), enclosure runs 1.4x hot, AO is p50 0.949.



### 2.7i The bounce deficit: what it is NOT, after six refutations (2026-08-30)

**The one number that reproduces.** Across every arm run today — ray caps 8/32/
uncapped, wall thickness 0.5/1.5 m, two independent sessions — the four stable
points read within 0.02 of each other every time:

    wallB mid 0.71x    wallB high 0.86x    wallB low 0.78x    corridor floor 0.78x

A systematic ~22% loss, and it has a sharp shape. Same rig, same gather:

    uniform field (flat plane, uniform sky)   1.00x   the calibration arm
    smooth field  (`__giSrcNoShadow`)         0.97x
    HALF-LIT field (a shadow boundary)        0.71x
    sky field, inside enclosure               1.4x HOT   (§2.7e)

⚠ **`wallA shadowed low` IS NOISE AND MUST NOT BE READ.** Truth 0.0609, the
smallest in the ladder, and across seven runs of nominally-similar arms it gave
0.66 / 0.72 / 0.80 / 0.83 / 0.84 / 1.02 / 1.03 with no relation to the variable
under test. §2.7h is the record of what reading it once costs.

**⛔ REFUTED THIS SESSION, each with a receipt:**

- ⛔ **The secondary bounce is not missing.** Refuted for free, before any GPU
  arm, by running the reference at `MC_DEPTH=1`: at `wallB mid` one bounce is
  0.4680 of a 0.4773 truth, so bounces 2+ are worth **2%** there and cannot
  explain 29%. And `wallA shadowed low` receives **exactly 0.0000** from a single
  bounce while the engine delivers 0.84x of its multi-bounce truth — the
  secondary demonstrably works. ⭐ The reference's own header claim ("a
  single-bounce reference is ~20% low at this albedo") is true only at the
  corridor FLOOR (0.82); at the wall points it is 0.98-0.99.
- ⛔ **Not thin geometry leaking through coarse cascades.** The best remaining
  theory, and it predicted BOTH signs: a 0.5 m wall is ~1.1 cells at c0 and
  thinner than one cell from c1 out (0.9/1.8/3.6 m), so a transport ray that
  should hit it escapes — contributing zero radiance at full cosine weight with
  the sky off, and full sky radiance with it on. `WALL_T=1.5` grows both walls
  OUTWARD only, so the inner faces, every probe point, the shadow line and the
  light are untouched — the CPU truth is bit-identical (0.4773 / 0.0609) at both
  thicknesses, which is what makes it a single-variable test. Result: **0.71 →
  0.71, 0.87 → 0.86, 0.78 → 0.78.** The change DID reach the field (`mergeSky`
  17 678 → 15 895, ~10% fewer escapes); the escapes were simply not carrying the
  missing energy.
- ⛔ Ray budget (§2.7h), the shadow ray (99.3%), convergence and alpha (§2.7),
  attribution (the no-shadow arm holds it fixed at 0.97x while the shadowed arm
  falls to 0.71x), sky energy (§2.7f), tonemapping (§2.7f).

▶ **ONE SUSPECT LEFT, and the evidence now points at it by elimination rather
than by hunch**: the tile bake's `E = π·Σ(L·W)/Σ(W)` over KNOWN bins.
`Σ(L·W)/Σ(W)` is the cosine-weighted MEAN of the sampled bins — exact for ANY L
if the known bins tile the hemisphere evenly, and biased exactly as far as they
do not. That is the only mechanism left whose error is ZERO on a uniform field
(1.00x), near zero on a smooth one (0.97x), and large on a discontinuous one
(0.71x), with the sign following whether the reachable directions are the bright
or the dark half.

⚠ **The cheap tests are exhausted; this one needs the instrument §2.7 already
specified** — bin-level, not point-level: dump each merged c0 bin's radiance and
known-flag at a probe and compare against the reference's radiance along that
bin's direction. Note that `knownFrac` and `meanKnownBins` CANNOT stand in for it
(§2.7h: invariant to four significant figures across 7x the rays, therefore
measuring something other than what their names say).



### 2.7j ⭐⭐⭐ THE DIRECTION SWEEP: the deficit is a LOW-PASS ON DIRECTION (2026-08-30)

**The instrument §2.7 asked for, built at lobe level.** Point-level probes
integrate the whole hemisphere and report one number, so a bias that cancels
across directions and one that does not look identical. So hold the POINT fixed
and sweep the NORMAL: one position on wall B's inner face, nine orientations
rotating in the x-y plane from −70° (down) through 0° (across) to +70° (up).
Both sides answer the same question, so `irradianceAt(P, n)` is the truth with no
new maths. `npm run probe:gi-sun-bounce -- base:lobe` (and `noshadow:lobe`).

**Shipping arm, sun with its shadow boundary:**

    normal        truth    engine   ratio
    −70° (down)   0.0794   0.0964   1.21x
    −35°          0.2917   0.2250   0.77x
      0° (across) 0.4773   0.3343   0.70x
    +17.5° (up)   0.5189   0.3657   0.70x
    +52.5°        0.4736   0.4123   0.87x
    +70° (up)     0.4122   0.4019   0.97x

⭐⭐ **ENERGY IS CONSERVED AND REDISTRIBUTED, NOT LOST.** 1.21x facing into
shadow pays for 0.70x facing the light. Spread 0.51 — emphatically not the scale
error the point-level 0.84x looked like for two sessions.

**⭐⭐⭐ AND THE CONTROL IS WHERE THE ANSWER IS.** `noshadow:lobe` removes the
boundary and leaves everything else. It is NOT flat: the truth peaks at −17.5°
and falls away both sides, while **the engine's curve is monotone — it has no
peak at all.** Same signature, smaller: under where the truth is high, over where
it is low.

    field                  truth range   engine range   CONTRAST RETAINED
    smooth (no shadow)        2.59x         2.11x            81%
    half-lit (boundary)       6.53x         4.28x            66%

⇒ **The engine loses a FRACTION of whatever directional contrast is asked of it.
The shadow boundary is not the cause — it is an amplifier**, because it demands
more contrast. This one property produces every result in §2.7d–i: a uniform
field asks for no contrast (1.00x), a smooth one asks for little (0.97x), a
boundary asks for a lot (0.70x), and with the sky ON the same smear runs the
other way and reads 1.4x hot (§2.7e).

**⛔ AND IT IS NOT WHERE IT LOOKS LIKE IT SHOULD BE. Both obvious filters are
refuted, each by a single-variable test:**

- ⛔ **NOT the direction-bin width.** c0 bins are ~41° across at high and ~20° at
  ultra (`binCount(0, w0)` = 32 vs 128) — and the lit band of wall A subtends
  ~41° from this probe, i.e. ONE BIN, which made this the obvious answer. 4x the
  bins moved the worst point 0.71 → 0.75 (~6%), and ultra had not converged at
  the last mark. Contrast retention 66% → 68%.
- ⛔ **NOT the irradiance tile.** `IRRADIANCE_TILE_INTERIOR = 6` is a FIXED
  constant at every tier (nothing else in the repo reads `IRRADIANCE_TILE_SIZE`),
  so the baked E(n) lives in a 6×6 octahedral map at ~38°/texel and is bilinearly
  sampled — which also explained the 6% above, since the tile is downstream of
  the bins. Raising it to 12×12 (~19°/texel) as a diagnostic moved the spread
  0.34 → 0.35 and retention 81% → 84%. Reverted.

▶ **SO THE LOW-PASS IS UPSTREAM OF BOTH** — in the deposit's spatial binning or
the cascade merge, the only stages left between a ray's radiance and the tile.
The merge is the stronger prior: it folds coarser cascades, whose probes sit up
to `s0·2^n` away, into c0's bins, and a spatial average of neighbouring probes IS
a directional average because E(n) differs between them.

⭐ **THE NEXT SESSION SHOULD NOT NEED THE GPU FOR THIS.** `srcRef.js` is a CPU
twin of the whole chain (`bakeProbeIrradiance`, `bakeProbeCoverage`,
`gatherPixel`, `makeSecondaryCache`, all taking the same `interior`). If the twin
reproduces the contrast compression — run the same nine normals through
`gatherPixel` — the stage can be bisected in milliseconds instead of 6-minute
browser arms, which is what every refutation above cost.



### 2.7k ✅ `test:gi-src-lobe` — the defect reproduces on the CPU, in milliseconds

**Every refutation in §2.7h–j cost a six-minute browser arm.** That is the wrong
instrument for a bisection, and `srcRef.js` is a CPU twin of the entire chain
(buildProbes → assignRays → traceAndDeposit → resolveProbes → mergeCascades →
bakeProbeIrradiance → gatherPixel) with `brutePointIrradiance` as its own arbiter
over the same analytic trace. **New gate: `npm run test:gi-src-lobe`.**

Fixture: a closed room, one face emitting, five black — the highest directional
contrast a room can have, and no shading in the loop, so a failure can only be
transport. Sweep the NORMAL at a fixed point, as §2.7j does on the GPU.

    FURNACE (all six faces = 1) — the control     1.00x at every normal, spread 0.00
    ONE BRIGHT FACE, normal tilted up/down        0.66 .. 0.80x   (mean 0.70x)
    ONE BRIGHT FACE, normal swung sideways        0.71 .. 1.00x   (mean 0.81x)

⭐⭐ **THE TWIN REPRODUCES THE DEFICIT — 29%, the same size as the GPU's 0.71x.**
So the defect is in the SHARED ALGORITHM, not the GPU port. And the furnace
staying exact to four decimals is what makes it a TRANSPORT result rather than a
scale one: **the normalisation is right, and only a NON-UNIFORM field loses
energy.**

**First bisection, seconds rather than an afternoon:**

    UNIFORM control    spacing0 0.5 / 1 / 2 / 4   ->  1.000x / 1.000x / 1.000x / 1.000x
    ONE BRIGHT FACE    spacing0 0.5 / 1 / 2 / 4   ->  0.705x / 0.746x / 0.603x / 0.824x
    ONE BRIGHT FACE    cascadeCount 1 / 2 / 3 / 4 ->  0.000x / 0.000x / 0.708x / 0.705x

- The uniform control is EXACT at every lattice spacing and cascade count, so
  none of this is the normalisation or the reach.
- cascadeCount 1-2 read 0.000x because their reach (0.8 m, 4.0 m) does not get to
  a wall 4 m away. The moment the chain reaches (3), the deficit is fully present
  — and the 4th cascade changes it by 0.003.
- ▶ **The merge is NOT the sole owner.** At spacing0 4 the c0 interval is 6.4 m
  and c0 alone spans the whole distance, yet it still reads **0.824x**. ⚠ Read
  that one loosely: the pixel shell scales with spacing0 (2058 → 294 pixels), so
  it is a lead, not a receipt. The clean next step is baking from
  `frame.resolved` instead of `frame.merged` in a room small enough for c0.

⚠⚠ **AN INSTRUMENT TRAP, CAUGHT THIS TIME BEFORE THE CLAIM.** The gate's first
run used `raysPerPixel: 4` and reported a **4.62x** up/down asymmetry in a room
symmetric to 1.015x — which was about to be written up as a bug in the octahedral
fold's lower hemisphere. Converging the budget: 4.62x (rpp 4) → 1.63x (16) →
1.20x (64) → 1.20x (256). Most of it was under-sampling; the real residual is
1.20x and belongs to its own unit.

⭐⭐ **AND THE FURNACE STRUCTURALLY CANNOT CATCH THAT.** A uniform enclosure
returns π for ANY distribution of ray directions — it validates the
normalisation and says nothing whatever about directional bias. A passing control
felt like permission to trust the subject, and it was not
([[probe-blind-statistics]]). `RPP=4 npm run test:gi-src-lobe` reproduces the
bad reading; the banner in the gate carries the ladder so nobody re-derives it.



### 2.7l ⭐⭐⭐ LOCATED: `mergeCascades` loses ~17% PER LEVEL on a non-uniform field

**The bisection, on the CPU twin, in seconds.** One deposit, two bakes, so the
only difference between the arms is the merge:

    bake(frame.resolved)   c0 only, unmerged   ->  deposit + resolveBin + bake
    bake(frame.merged)     the shipped path    ->  ... + mergeCascades

Each gets its OWN truth: c0's is the same Monte Carlo with the trace TRUNCATED at
the c0 interval (0.8 m at spacing0 0.5 — `intervalBoundaries` gives 0.8/4/16.8/68),
because past its interval a c0 ray has no radiance of its own and hands over to
c1, which unmerged is sky = 0. The sample sits 0.6 m from the bright wall so c0
can see it alone.

    normal     c0 truth  c0 bake  ratio  | full truth  full bake  ratio
    −52.5°     0.8289    0.8957   1.08x  | 2.2467      2.0337     0.91x
       0°      1.3929    1.3946   1.00x  | 3.0578      2.7765     0.91x
    +52.5°     0.8302    0.8908   1.07x  | 2.2490      2.0735     0.92x
    mean       c0-only 1.027x            | full (merged) 0.909x

⭐⭐ **c0 IS CLEAN — deposit, bin resolve and bake are accurate on a one-face
field. The loss enters with the merge.** And it scales with how much of the
answer has to travel through it:

    sample 0.6 m from the wall   light mostly arrives inside c0    0.91x
    sample 4 m out (room centre) light arrives ENTIRELY via c1/c2  0.70x

c0 carries ~45% of the near sample's total, so the merged remainder loses ~17%.
**0.83² = 0.689 against the far sample's measured 0.705 — the loss COMPOUNDS PER
MERGE LEVEL**, ~17% each time radiance is handed up a cascade. (Consistent with
§2.7k's cascade ladder: cascadeCount 3 → 0.708x and 4 → 0.705x, because the 4th
level carries nothing at this distance.)

▶ **NAMED SITE, and it closes the loop with the GPU sweep.** `mergeCascades` does
two things to a parent bin: `preAverageChildBins` folds four child bins into one
(an ANGULAR average) and a sparse trilinear samples the parent lattice (a SPATIAL
average). ⭐ **Both are EXACT on a uniform field and both smear a non-uniform
one** — which is exactly why the furnace reads 1.000x at every spacing and every
cascade count, why every existing gate is green, and why §2.7j measured a
"low-pass on direction" from the outside. That is now located rather than
inferred.

⚠ Residual, not the story: c0 reads 1.07-1.08x at ±52.5° against 1.00x at the
centre. Small, opposite in sign, and its own unit — do not fold it into this.

▶ **NEXT**: the merge is `paper §6`'s 4→1 pre-average plus interpolation, so the
question is not "is it averaging" (it must) but whether the average is taken in
the right space — a radiance mean over a 4x wider solid angle is not the same
quantity as the parent bin's radiance unless the child set is uniform. Test on
the twin: replace `preAverage` with a cosine/solid-angle-weighted combine and
re-run `test:gi-src-lobe`; the gate's furnace arm keeps the change honest, since
any correct scheme must still read 1.000x there.



### 2.7m ⛔ RETRACTED: `cov(T_self, L_parent)` is NOT the mechanism

> ⛔⛔ **RETRACTED THE SAME HOUR, BY THE FIX ITSELF.** The section below is kept
> because the reasoning is the useful part; the conclusion is wrong.
>
> **The fix was implemented and recovers 1%, not 29%.** Sub-bin transmittance
> (four T buckets per bin, composited per sub-direction — exactly what the
> section proposes) moved the box room from 0.71x to 0.72x and the sideways arm
> from 0.81x to 0.82x. Reverted; it is not worth the complexity for 1%.
>
> ⚠⚠ **AND THE FIXTURE THAT "PROVED" IT HELD TWO VARIABLES, NOT ONE.** The SHELL
> blocks every ray at the same radius, which makes transmittance uniform — but it
> ALSO puts every ray of a bin in the SAME cascade interval, so the chain never
> has to combine rays that stopped in different places. Sweeping the radius
> settles it: **0.973x at R = 0.4 / 0.7 / 0.9 / 1.5 / 2 / 3 / 3.9 / 4.2 / 6 / 10 /
> 20** — dead flat across c0, c1, c2, c3 and across both interval boundaries.
> The shell NEVER reproduces the deficit, at any radius, so its 0.973x was never
> evidence about covariance; it was evidence that a single-interval field is
> nearly lossless.
>
> ⭐⭐ **A two-row table cannot separate two variables that move together.** The
> furnace froze L, the shell froze T *and* the interval spread, and I read the
> pair as isolating T. The missing arm is a fixture where T varies and the
> interval does not — which the box cannot provide either, because in it the hit
> DISTANCE varies continuously with direction.
>
> ▶ **WHAT SURVIVES, AND IT IS THE REAL LEAD**: the one structural difference
> between the shell (0.973x) and the box (0.70x) is that in the box **rays within
> a single bin terminate at DIFFERENT DISTANCES**, so one bin's rays split across
> different cascade intervals. That is a depth-variance story, not a
> direction-variance one — which is also why sub-bucketing by DIRECTION bought
> only 1%. Next fixture: hold direction-variance fixed and vary depth-variance
> alone (e.g. a shell with a per-direction radius jitter of controllable width),
> and watch the deficit appear as a function of that width.

**`mergeCascades` composites a bin as `L_self + T_self · L_parent`** where both
factors are averaged over the bin's solid angle INDEPENDENTLY — `preAverage`
means the four child bins' radiance, `resolveBin` means the self interval's
transmittance. So the shipped expression is

    mean(L_self) + mean(T_self) · mean(L_parent)

and the correct one is

    mean( L_self + T_self · L_parent )

The difference is exactly **cov(T_self, L_parent)** across the bin's
sub-directions — and in any real scene those are strongly POSITIVELY correlated,
because the sub-directions with high transmittance are precisely the ones that
reach whatever is far away and bright. Dropping a positive covariance
UNDERESTIMATES. That is the missing light.

**The argument, and where it fails.** A covariance vanishes if either factor is
constant, so three fixtures looked decisive — ⚠ but see the retraction above:
the SHELL row freezes the interval spread as well as T, and that is what its
1.000x/0.973x is actually reporting.

    fixture                      L_parent    T_self     ratio
    FURNACE (closed box)         constant    varies     1.000x
    SHELL, uniform radiance      constant    constant   1.000x
    SHELL, +x hemisphere bright  VARIES      constant   0.973x
    BOX ROOM, one bright face    VARIES      VARIES     0.70x

A SHELL trace blocks every ray at the same distance (3 m), so the self-interval
transmittance is identical in every sub-direction while the radiance is as
non-uniform as the box room's. **Non-uniform radiance ALONE costs 2.7%; adding
non-uniform transmittance costs 30%.** Nothing else in the pipeline has that
signature.

**This explains every observation in §2.7d–l at once:**

- the furnace is exact at every spacing0 and cascadeCount (L_parent constant)
- ray budget, wall thickness and bounce depth are irrelevant (§2.7h/i) — none of
  them changes a correlation
- finer BINS help only slightly and sub-linearly (§2.7j: 4x bins → 6%) — smaller
  bins mean less within-bin variance, hence a smaller covariance, but the term
  does not disappear
- the TILE is irrelevant (§2.7j) — it is downstream of the composite
- c0 alone is clean at 1.027x (§2.7l) — c0 has no parent to correlate with
- the loss COMPOUNDS per level (0.91x near, 0.70x far, 0.83² ≈ 0.705) — each
  merge applies its own decorrelation
- and from the outside it reads as a "low-pass on direction" (§2.7j), because
  decorrelating T from L is precisely a smear across the bin's solid angle

▶ **THE FIX, and it is cheap because the merge ALREADY reads the parent's four
child bins individually** (`preAverageChildBins` averages them and throws the
detail away). Keep the self interval's transmittance at SUB-BIN resolution — four
8-bit T's pack into one u32 word — and replace

    L_self + T · mean(L_par_sub)      with      L_self + mean( T_sub · L_par_sub )

which is exact for the product term at no change in bin count, tile size or ray
budget. `L_self` can stay averaged: its correlation with the parent is second
order (the SHELL arm measures that residual at 2.7%).

⚠ **The twins must move together** — `srcRef.js` and the GPU deposit/merge are
gate-checked against each other, so this is a two-sided change, and
`test:gi-src-lobe`'s FURNACE arm is what keeps any replacement honest: a correct
scheme must still read exactly 1.000x there.



### 2.7n Parallax is a REAL contributor (~10 of 27 points) — and two more refutations

**⛔ REFUTED: interval splitting within a bin.** §2.7m's retraction proposed that
the deficit needs rays of one bin to terminate in DIFFERENT cascade intervals.
Built the fixture — a shell whose radius is a hash of the quantised direction, so
both the AMPLITUDE of the depth variation and its angular FREQUENCY are knobs
(K=32 → ~6° cells, many per 41° bin, i.e. WITHIN-bin spread; K=2 → ~90° cells,
ACROSS-bin only), at three radii (inside c1, straddling c1|c2, straddling c0|c1).

**Every one of the fifteen cells read 0.973x.** Depth amplitude, angular
frequency and interval straddling change nothing, and the uniform-radiance
control stayed exactly 1.000x.

⚠⚠ **AND THE FLATNESS EXPOSED A FLAW IN EVERY SHELL ARM I HAD RUN.** Those
traces return a hit distance that depends only on the ray DIRECTION, not on where
the ray started — so the radiance field is IDENTICAL AT EVERY POINT IN SPACE.
That is not a scene: the parent cascade's probes, which sit up to `spacing0·2^c`
away, see exactly what the child sees. **The shell has no parallax**, which is
why nothing done to it ever moved the number.

**✅ SO TEST PARALLAX DIRECTLY.** A real sphere in world space, radiance a
property of the HIT POINT, so a probe 1 m to the left sees a different part of
the bright hemisphere. Parallax then falls as the radius grows:

    R        uniform (control)   bright-half
    50       1.000               0.963x
    20       1.000               0.946x
    10       1.000               0.919x
    6        1.000               0.881x
    2        1.000               0.883x
    infinity (the fake shell)    0.973x

**Monotone from R=50 down to R=10 and converging on the no-parallax 0.973x** —
parallax in the merge's parent interpolation is real and worth ~9 points. It also
fits what nothing else did: **c0 alone is clean (1.027x) because c0 has no parent
to interpolate from**, and the loss compounds per level because each parent sits
twice as far away.

⚠ **BUT IT IS NOT THE WHOLE DEFICIT, AND SAYING SO IS THE POINT.** The box reads
**0.70x** — worse than any sphere this fixture can build, and the small-R end
(0.883 / 0.912 / 0.898 / 0.881) is not monotone, so the ~0.88 floor is where this
instrument stops resolving rather than where the effect stops. Parallax accounts
for roughly 10 of the 27 points. **Something else owns the rest.**

▶ Next: what does a BOX have that a sphere does not? Candidates, in order of how
cheaply they can be frozen — a flat surface makes hit distance vary sharply with
direction WITH A DISCONTINUOUS DERIVATIVE at each edge (a sphere's varies
smoothly); the bright region's silhouette as seen from a probe MOVES differently
for a plane than for a distant sphere; and a box has concave corners where three
faces meet. Each is a one-fixture question now that the twin runs in seconds.



### 2.7o ⛔ FIX ATTEMPT 2: the naive parallax re-aim recovers 11% and DIVERGES

**Built the correction §2.7n specified.** A child probe at P asks the parent
cascade for bin `m`; the shipped merge reads the SAME DIRECTION INDEX from parent
probes up to `spacing0·2^c` away, which is asking the wrong probe about the wrong
place. The re-aim asks each parent Q for the direction from Q to the child ray's
handover point `P + dir(m)·r_end` instead — same solid angle, same 4→1
pre-average, only the index arithmetic changes.

**On `test:gi-src-lobe` it works:**

                        OFF (shipped)   ON (re-aimed)
    furnace             1.00x  σ 0.00   1.00x  σ 0.00
    tilt up/down        mean 0.71x      mean 0.79x
    swing sideways      mean 0.81x      mean 0.89x

+11% and +10%, with the furnace still exactly 1.000x — almost exactly the ~10
points §2.7n's sphere sweep predicted parallax was worth.

**⛔ AND `test:gi-src-ref` REJECTS IT, in the way that matters:**

    shaded transport vs the brute-force arbiter
    sample                  shipped   re-aimed
    (0.0, 0.0, 0.0)          11.1%     11.1%
    (-1.0, 0.0, 0.6)          9.1%     22.9%
    (0.6, 0.0, -1.0)          9.2%     25.1%
    FAIL: "refining s0 does not diverge" — 14.4% -> 25.1% over a halving

Exact at the lattice CENTRE, ~3x worse off-centre, and **diverging as the lattice
refines** — which that suite tests for explicitly as the signature of a
structural fault rather than blur. Reverted.

⭐⭐ **WHY IT IS ONLY HALF THE CORRECTION, which is the useful part.** Re-aiming
fixes which DIRECTION the parent is asked about, but not which SEGMENT it
answers with. The parent's interval is `[r_end_child, r_end_parent]` measured
from **Q**, so the ray Q casts toward the handover point covers a different piece
of the world than the child's own continuation does — and that mismatch grows
exactly as |P − Q| does, i.e. off-centre, which is precisely where the suite
fails. A real fix has to correct the interval as well as the aim, or drop the
"parent's bins are indexed by direction" assumption altogether.

⭐ **AND THIS IS WHY `test:gi-src-lobe` CANNOT BE THE ONLY GATE.** It measures
one point at the lattice centre, where the re-aim is harmless; the ref suite
measures off-centre samples across a spacing ladder, which is what caught it. Any
future merge change must pass BOTH — and the lobe gate's furnace arm is
necessary, not sufficient.


### 2.7p Immediate comparison fixes: direct albedo, hybrid AO, black metals (2026-08-30)

**Direct bounce no longer pays the recursive stability tax.** `SEC_RHO` now
stores physical reflectance clamped only to [0,1]. Sun, analytic lights and NEE
use that value; only `[J]`'s atlas-feedback term derives `rho_loop` with R4's 0.9
ceiling. This restores up to 11.1% on white first-bounce surfaces without moving
the loop's spectral-radius bound. `test:gi-src-ref`, `test:gi-src-shade`,
`test:gi-src-deposit` and `test:gi-src-secondary` all pass; the latter still
converges and adds +8.3% in its closed-box fixture.

**GTAO keeps contact AO; a calibrated occupancy residual now ships with it.** One
half-resolution pixel can trace one of the old six cosine-weighted occupancy
cones. A deterministic seven-state pattern gives the axial cone weight 2/7 and
each of five side cones 1/7. The first/X bilateral resolves world visibility
with a uniform seven-tap cycle (while GTAO keeps its radius-2 Gaussian), then
the ordinary Y filter runs and the two channels combine with `min`. This fixes
both estimator traps: `E[min(G,V_i)]` is biased darker than `min(G,E[V_i])`, and
a five-tap Gaussian gives the seven states phase-dependent weights (the axial
coefficient varied 0.245..0.325 instead of 0.286). `test:gi-ao-phase` pins the
complete-cycle and open-visibility invariants. The world arm adds two texture taps
to one existing filter dispatch, one read of the existing occupancy allocation,
and no storage-buffer binding or dispatch.

The first cube-free Sponza comparison measured the shaded floor at 0.035 versus
the path trace's 0.050, already a 30% deficit, while the sunlit floor was nearly
matched (0.548 versus 0.535). That ruled out a full-strength second visibility
term: SRC already transports directional world visibility through `BIN_T` and
`L_self + T_self*L_parent`, and `min` prevents GTAO/cone overlap but not
cone/gather double charging. The later live screenshot, however, showed no
spatial AO cue at all with the weak linear response. The cached voxel reference
names why: the hidden cone returned 0.9555 against exact-ray truth 0.9078, only
half the needed contrast. The shipping response is therefore **V² after the
seven-phase spatial integral**, which maps hidden 0.9555 -> 0.9130 and open
0.9907 -> 0.9815, while exact open 1 remains exactly 1. The normal authored AO
strength then controls the result—no second weakening multiplier, no extra
trace, and no frame-wide darkening term. `__giWorldAo = false` remains the clean
cross-boot A/B whenever a scene's transport already supplies enough enclosure.

**Raw diffuse AO was removed from directional glossy radiance.** A cosine-
hemisphere scalar cannot decide whether one mirror direction is blocked. On a
metalness-1 surface there is no diffuse lobe to hide that category error, so the
old multiply could turn a valid reflection black. The metal/AO same-page gate
now sees only 8.8% drift while the diffuse contact lifts 10.2% against 0.8% in
the open control. This removes ALU and adds no ray, pass, texture or binding.

The residual directional deficit from §2.7o remains deliberately visible:
`test:gi-src-lobe` is still 0.71x/0.81x for a one-bright-face field while its
furnace is exactly 1.00x. A global gain would break the furnace; the honest next
unit is the forked/bilinear interval merge, gated at both lattice-centre and
off-centre receivers.

### 2.7q The exact fork is not the bounded brightness fix (2026-08-30)

**Built on the CPU twin, then rejected before the GPU.** The RC bilinear fix was
implemented literally: for each lower-cascade interval and each of the eight
trilinear parent probes, trace from that interval's usual start to the start of
each associated fine parent cone, merge the fork with that parent's far
interval, then spatially combine. With the correct interval `[t_c,t_{c+1}]`,
the furnace remained 1.00x but the lobe stayed **0.70x / 0.80x** (shipped:
0.71x / 0.81x). It therefore fails the first quality gate and cannot explain
the deep-shadow deficit. An initially encouraging 0.89x / 1.02x result was an
instrument bug: it had shifted the fork one interval outward and traced
`[t_{c+1},t_{c+2}]`; that invalid arm also drove the coarse off-centre shaded
case to 22.3% error.

The cost independently rejects a production port. Osborne/Sannikov's Appendix
A specifies **8x interval rays in 3D**. The shipped merge hoists eight hash/probe
lookups per probe and then reads the already-resolved parent payload; the exact
fix instead needs geometry/occupancy traversal for every spatial fork. This is
not a rearrangement of the existing payload reads, and it cannot meet the
performance-neutral hard gate even though its merge buffers could be arranged
under the portable eight-storage-buffer limit.

**The zero-ray fallback was rejected too.** A solid-angle-weighted spherical
unsharp at the 6x6 irradiance tile, clamped and renormalized per channel to keep
the furnace/mean exact, was swept at `k=0.1, 0.2, 0.35, 0.5`. The vertical lobe
only moved 0.71x -> 0.73/0.75/0.77/0.79x, while its symmetry error worsened from
1.20x to 1.22/1.24/1.27/1.29x (sideways 1.23x -> 1.25--1.30x). This is the same
category error as the cosine-power attempt: it sharpens the octahedral/tile
anisotropy along with the signal. No diffuse production shader changed.

### 2.7r Bounded analytic first-bounce compensation (2026-08-30)

**Landed as a targeted correction, not a global GI gain.** A directional
first-bounce term is attenuated as it crosses cascade hand-offs, while a
uniform furnace is already energy-exact. The owning cascade therefore supplies
only the runtime-named analytic directional-light slot with a conservative
gain: c0 `1.00`, c1 `1.08`, c2 `1.1664`, and c3 `1.20` (capped). Sky,
environment, emissive, and recursively gathered radiance remain unchanged.
The known-lossy cached-normal sun split remains opt-in/off and is not involved.

On the converged CPU lobe fixture this moves the vertical mean from `0.71x` to
`0.83x` (range `0.77x..0.94x`) and the horizontal mean from `0.81x` to `0.94x`
(range `0.83x..1.17x`). The worst measured overshoot is `1.17x`, below the
explicit `1.20x` cap. Three off-centre source/reference errors that were
`24%..26%` fall to `11.4%..15.4%`; the furnace stays `1.000x` with zero spread.
These lobe and off-centre gates are both required so a centre-only improvement
cannot hide the structural error described in §2.7o-q.

The production cost is bounded and does not change the portable binding
budget: no new ray, pass, storage buffer, record word, or texture. The deferred
path derives the owner from the existing destination-bin word address, and the
inline diagnostic path reuses its existing owner. With four cascades the added
shader work is three monotonic selects and one multiply per shaded hit.

**The red-wall follow-up isolates a second, chromatic part of the same loss.**
A mixed fixture puts neutral radiance `0.25` on all six faces and adds red-only
radiance `1.0` to one face. G/B therefore measure the furnace control while
`R-G` measures only the directional, albedo-coloured first bounce. The raw
transport retains `0.707x` of that red excess and the conservative base sun
correction above reaches `0.825x`, while neutral energy stays `1.000x`. A
separately bounded chroma remainder gain (`rho - min(rho)`) of `1.18` per
owning-cascade hand-off, capped at `1.50`, restores `0.985x` mean
(`0.924x..1.118x` by direction); the three off-centre errors are
`1.2% / 6.1% / 1.8%`. This is not a saturation lift: only the already-visible,
runtime-named analytic directional term sees it. White/grey albedo still takes
the conservative base gain above; environment, emissive, punctual and recursive
radiance remain bit-identical.

The GPU keeps the named sun's raw irradiance beside the ordinary direct-light
sum for the duration of hit shading, then applies the base gain to the neutral
albedo component and the chroma gain to the remainder. It stores neither split:
there is no ray, pass, texture, record word, or binding. The additional work is
three owner-cascade selects plus a short per-hit min/subtract/multiply sequence;
the shadow traversal and every memory read are unchanged. `test:gi-src-shade`
gates the bundle, one-light, and rolled multi-light forms and proves the rolled
form does not gain a neighbouring point light.

**The live red-wall readback exposed an off-by-one in what those stages
counted.** Every analytic first-bounce lobe crosses the c0 direction-bin to
cosine-tile reconstruction once, including a hit owned by c0; only then do
owners above c0 pay their additional cascade hand-offs. The first version used
`gain = 1.18^cascade`, so c0 received no chroma correction at all. Counting the
universal reconstruction gives c0/c1/c2/c3 gains `1.18 / 1.3924 / 1.50 / 1.50`
under the same cap. On the mixed red fixture, red-excess is `1.061x` mean
(`0.995x..1.204x`) with `14.3%` worst off-centre error; neutral furnace energy
remains exactly `1.000x`. The exact GAME scene's native-float readback also
showed why this is the last bounded source correction: red hit albedo survives
into `[J]`, the c0 atlas is chromatic, and gather/raw/final preserve R/G. A
larger visual-match multiplier would amplify a spatial/angular interpolation
residual and contradict the source/reference gate rather than repair an
arithmetic loss.


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

## 7. STATIC DERIVED-DATA CACHE (2026-08-31)

The startup cache is a derived-data cache, never authored scene state. The
runtime computes a SHA-256 signature over exact position/index/optional-UV
bytes, placement matrices, slot order, split strategy and packer ABI. A hit
maps the raw `.gbvh` payload directly as a `Uint32Array`; a miss builds normally
and the editor writes `<project>/Library/gi-static-bvh/v1/...` through a native
atomic temp+fsync+replace path. CRC validation runs in a module worker so a
Bistro-sized payload does not freeze the UI. Cache I/O fails open after 12 s.

Only one giant write may be active, and a tiny per-scene manifest selects the
live content-addressed artifact. Game export follows those manifests instead of
copying every stale 158 MB revision. The first native editor load after a static
change repopulates the artifact; later editor/game starts reuse it. Geometry
cache invalidation covers position, index and UV changes/replacements/backing
arrays, not only `position.version`.

The transform-update target is BLAS + TLAS, not a refit of the current baked
world-space soup. Each unique geometry owns one object-local BLAS; each placed
mesh owns a TLAS leaf + inverse transform record. Moving one mesh then uploads
only that record, its leaf and ancestor bounds. The pure TLAS/refit and
randomized trace-equivalence gate are implemented in `staticPlacementTlas.js`;
production packed traversal remains a separate cutover because its file ABI and
WGSL must change together.

Cache candidates, in priority order:

1. **Coupled static occupancy/surface snapshot**: level-0 static bits, pyramid +
   density, hybrid headers, surface records, complex-triangle pool, attribution
   stamps and allocator high-water marks. These must be one artifact because
   atomic surface allocation deliberately permutes record addresses. Exclude
   palettes, scratch, dynamic tails, temporal probes and GPU objects. Expected
   Bistro size: another 150-200 MB; benchmark the GPU build/readback bill first.
2. **Albedo atlas + texture linear averages**: safe and smaller; key on source
   texture bytes, import/color-space settings, material signature and atlas ABI.
3. **Per-geometry emitter clusters**: safe but low value. Do not persist the
   final light tree; it contains live transforms/mesh ids and builds in
   microseconds.

WebGPU exposes no serializable application-owned pipeline binary. Cross-process
pipeline reuse therefore comes from byte-identical WGSL hitting Chrome/Dawn's
driver cache; preserve compute nodes across resize and keep scene numbers out
of shader text rather than inventing a pipeline-blob format.

Gates: artifact miss/write/hit timing on the real Bistro project; startup time
split into signature/read/CRC/upload/field-first-dispatch/pipeline stages; the
portable GPU smoke must still report `storage=8` with no validation errors.

---

---

## 9. THE 2026-09-02 MANDATE — fix the ORIGINAL GI (GI2 dropped 08-30)

User, 2026-09-02: *"we dropped GI2, it wasnt good … we decided to fix original
GI"*. `main` was reset to `6a36841` on 08-30; the `gi19-stage0` line is
history. Asks, in the user's order: (1) boot and update fast, fps higher,
reflections are the slow part; (2) correct lighting under camera motion (no
patches of wrong light); (3) seamless near-precise → far-approximate; (4)
temporal accumulation suspected broken, must converge much faster. Added
mid-session: heavy freezes on editor launch and after moving the camera
("maybe GI, maybe the animator's generation, maybe collider baking").

Method for the whole section: NUMBERS FIRST, from the harness on the user's
own `GAME/scenes/Level.scene` at ultra (`vite.base.config.mjs` on 5201, its
own dep cache), then the live editor over MCP. No screenshots.

### 9.1 `test:gi-src-temporal` was red for a test reason, not a transport one

The gate's reclaim arm ages every probe out with `maxAge: 1` and then reads
back the LIVE probes' blocks expecting only fresh claims. Since §16 D1 (08-24)
armed locality retention on the anchor-relative arm, an invisible probe is
HELD (its block frozen at `keep = 1`, up to 1800 frames) instead of retired —
so the arm was reading the OLD, held probes' decayed history and calling it
inheritance: `2994 bins hold a decayed weight`, `9015 ray-weights vs 1536`.
Same page with `__giSrcProbeRetain = false`: `0 bins hold a decayed weight`,
`1536 vs 1536`, every check green. The claim stamp zeroes a reclaimed block
exactly; the transport's accumulation is sound. The page now sets retention
off for itself (retention has its own gates). Memory
[[gi-sun-bounce-deficit]]'s "real defect, stale energy surviving a reclaim"
is WITHDRAWN.

### 9.2 The launch freezes, named by a per-frame ledger

`probe:gi-boot-frames` (extended: render-pipeline labels per frame, fragment
source size + binding heads for unlabelled ones, `getCurrentTexture` timing,
and `queue.onSubmittedWorkDone` latency per frame — the GPU's own clock).
Level, harness, contended by the editor: lit at 12.6–13.5 s after scene open,
~80 frames over 40 ms, ~12.5 s of stall. `__giOff`: 4.1 s of stall, worst
1.09 s. `__giNoCompileWave`: lit at 49 s. So the wave is what makes first
light arrive, and GI owns ~8 of the 12.5 stalled seconds.

Three stall classes, each with its receipt:

| frame | ms | what the ledger saw | owner |
|---|---|---|---|
| first paint (~4.7 s) | 1100–1170 | 28–30 SYNC `createRenderPipeline`: 12 shadow-depth (~1 kB), 14 lit materials at 27 kB WGSL each | three's sync pipeline path on first draw |
| first lit (~13 s) | 2400–3750 | 29 sync pipelines (5 mirror mask 1.5 kB, 12 one-shot blit quads 1.1 kB, 1 material 174 kB) AND `GPU done 4155 ms after rAF`, `longtask 3643 ms unknown:window`, 0.3 % of it inside any wrapped WebGPU call | the occupancy field's first pass: ~4 s of GPU in ONE submission; the page blocks on the swap chain |
| camera drag | 1190 (worst) | 9 sync pipelines in one frame, 7 of them 169–327 kB lit-material variants; a second 415 ms frame held 7 `createShaderModule` + 7 compute pipelines | variants the wave never compiled (three's `compileAsync` FRUSTUM-CULLS — an object outside the boot view compiles nothing, silently) + GI kernels that compile on first use |

The 1.1 kB blit quads were twelve DISTINCT pipelines for one line of shader:
every `computeCompressedTextureAverage` / `readTexturePixelsGPU` / atlas tile
minted a fresh `NodeMaterial`, three names bindings after node IDs, so each
was new WGSL to the program cache and a fresh sync compile. The atlas tiles
additionally baked their tint as a literal.

Shipped (each measured on the ledger):
- `#compileWave` compiles every variant UNCULLED (`frustumCulled = false`
  around `compileAsync(object, camera, compileTarget)`, restored in `finally`).
- `giScreen.blitMaterialFor(tex, {tint})`: one material per (colour space,
  format, type, tinted?) — the texture is a binding repointed through the
  node's `.value`, the tint a `vec4` uniform, every caller renders through a
  NEW `QuadMesh` so the repointed value reaches a fresh bind group (740c6ce's
  law). First-lit frame: 29 → 18 → 8 sync pipelines.
- `src/engine/asyncRenderPipelines.js`: the engine's MAIN render (Engine.js,
  the one call that presents; the postprocess override's included) routes
  render pipelines whose fragment program is ≥ 16 kB through three's own
  async path (`promises` array → `createRenderPipelineAsync`, draw skipped by
  `Pipelines.isReady` until it lands). Scope is exactly that call so one-shot
  renders (atlas blits, impostor bakes, picking, outline) stay sync — a skipped
  draw there is a black result nobody re-renders. First paint 1169 → 386 ms.
  `__asyncRenderPipelines = false` is the A/B; `__asyncRenderPipelinesMinBytes`
  moves the gate.
- The occupancy chain runs in STEPS (`occupancyField.chunkedPasses` +
  GISystem's step machine): the three pair-list kernels (voxelize, surface
  accumulate, complex write) take a `[offset, count)` window through
  `pairBaseAt` + a bounds guard, the chain becomes one step per frame, the
  consumer gate (`_occupancyChainIncomplete`) holds until the last step, and
  a controller moves the next chain's window toward 24 ms/frame
  (`OCC_SLICE_*`, `__giOccSliceItems`). Unsliced dispatch is bit-identical.
  RECEIPT (9.2a): Sponza (3.78 M work items) in the harness — `occupancy
  chain: 61 steps over 3004 ms (window 200000 items, 9.9 ms/windowed frame)`,
  first field 7.9 s after build with no frame over 100 ms from the chain;
  the Level's first-lit frame 4.8–5.4 s → 1.8–2.0 s. ⚠ The window controller
  read 55 ms/windowed frame while a walk battery shared the GPU and halved
  itself — its numbers are only meaningful on a quiet GPU. The USER'S editor
  picked the change up on a reload the same hour: Sponza `occupancy chain: 19
  steps over 39610 ms` — the steps waited on pipelines (`SLOWEST PIPELINE:
  [src#47] took 126.4 s (162 kB WGSL, 327 ifs)`, 9523 s summed over 402
  pipelines) while two harness Chromes competed for the same compiler
  threads; a clean editor number is owed.

### 9.2a What is left at first light, and what the material wave is made of

With the chain in steps, the lit frame's remaining ~2 s of GPU sits on ONE
submission: the per-submit clock (`onSubmittedWorkDone` after every
`queue.submit`, labelled by `globalThis.__giCurrentComputeName`, which
`giCompute` now publishes — SRC passes carry `src:<group>` names, unnamed
ones take their caller's name) reads `#50 src:deposit (trace + attribute)
2027 ms` as the first slow submit of the frame before the lit one, every
earlier submit fast. The transport's FIRST trace is ~2 s of GPU (steady state
1.07 ms isolated). Ray count vs pool upload is the next A/B
(`__giSrcTransportRays`, `__giSrcBinBudget`).

⭐⭐ THE MATERIAL WAVE IS THE REFLECTION-PROBE SAMPLER. Dumping three's
fragment program cache after a Level boot (`scripts/.tmp-dump-frag.mjs`):

| arm | largest material fragment | texture samples | `var<private>` |
|---|---|---|---|
| shipped | **327 kB** | 100 | 3828 |
| `__giExactPrefilter = false` | 320 kB | 88 | 3796 |
| `__giReflectionProbes = false` | **75 kB** | 36 | 568 |
| both | 68 kB | 24 | 536 |
| `reflections: false` | 171 kB | 52 | 1993 |

`sampleReflectionProbes` was unrolled once per `MAX_REFLECTION_PROBES` slot
(eight `uniform(Vector4)` pairs): eight copies of the box projection, two
depth-parallax refinements and two atlas fetches each, in EVERY mirror- or
dynamic-roughness material — 250 of the 327 kB. That one number is the
13–39 s material wave, the ~100 ms TSL build per material first seen on a
camera turn, and why the driver cache cannot help. SHIPPED: the slots are two
`uniformArray`s plus a `count` uniform (`createReflectionProbeSlots`:
`at(i)`, `syncCount()`, `clear()`), and the sampler is ONE `Loop` over
`count` — same bytes on the GPU, one body in the WGSL, a scene with one probe
pays one iteration. Gate: `test:gi-reflection-probes` (hue split, offset
arm), the dump ladder, `smoke:gi-gpu`.
RECEIPTS: `test:gi-reflection-probes` ALL PASS (hue split 0.62, offset
anchoring 0.23, held-pose drift 0.4 %); the dump ladder after the rewrite —
largest material fragment **327 → 91 kB**, 100 → 44 texture samples, 3828 →
700 private vars, every mirror-capable variant 316–327 → 81–91 kB;
`smoke:gi-gpu` PASS at storage 8 on both arms.

### 9.2b The first trace, the pool sweeps, and the boot ramp

Two more A/B boots on the lit frame's ~2.0 s first-trace submit:
`__giSrcTransportRays = 32768` → 0.74–0.94 s; `__giSrcC0Probes = 4096,
__giSrcBinBudget = 350000` → 1.0–1.1 s. So the frame is roughly half ray
work on a cold field and half pool-sized sweeps, and neither alone is the
floor. Two changes, one each:

- **Live-block words** (`srcProbes.blockLiveBase`, one u32 per block on the
  free stack's tail: compaction writes 1 on claim, the age pass 0 on
  release). The decay, the resolve, the tile bake and merge [G.3] read it
  FIRST and skip dead blocks; a block released THIS frame (its stamp says so)
  still runs that frame, so the decay zeroes it and the resolve writes
  UNKNOWN — the §12.21 phantom fix is preserved. On the Level's 2.3 % load
  that is ~97 % of every sweep's threads exiting on one coherent read
  instead of one distinct word per bin plus the stamp/influx/surprise/held
  words. Gates: `test:gi-src-{deposit,merge,tiles,temporal,gather}`.
- **The boot ramp** (`srcSystem.syncCamera`, `BOOT_RAMP_FRAMES = 8`,
  `__giSrcBootRampFrames`): the rest cadence's boot hold spent the FULL ray
  budget from frame one — the one frame that cannot afford it. The ceiling
  now ramps 1/8 → 1 over the first eight frames; the hold's 3 s still runs
  at full budget after that, so convergence loses ~4 frames of rays out of
  ~180.

RECEIPTS: `test:gi-src-{deposit,merge,tiles,gather}` all PASS unchanged;
`test:gi-src-temporal` PASS once its two arithmetic arms (which seed influx /
surprise words on the WHOLE pool and diff every bin) also mark the pool live
— a probe claim would. ⛔ AND THE FIRST ENGINE BOOT WAS BLACK: the tile bake's
guard used `Return()` in a file that never imported it, the kernel threw at
build, nothing logged it, and the picture read `tiles lit 0 empty 0, gather
EMPTY` (`scripts/.tmp-live-readback.mjs`: live words 1294/392/123/54 ==
claimed blocks, so the WRITERS were right; the bake was the missing import).
⭐ Two rules: (1) the src gate pages pass no `frameStamp`, so every
stamp-gated path (maturity, retention, this guard) is exercised ONLY by the
engine — a gate that is green on a path it does not build is not a gate;
(2) a kernel that fails to BUILD is a silent black frame here — `giCompute`
must log the throw once per node (owed).

Still open on the drag: with pipelines async the worst drag frame is still
~700–870 ms, and the ledger names it as the JS NODE-GRAPH BUILD of 6–8
lit-material variants (169–327 kB of WGSL each, ~80–110 ms of TSL codegen per
material) plus the first-use `createShaderModule` (Tint parse) of ~60 GI
kernels. Those materials are first SEEN on the drag because they were not in
the boot view — the unculled wave should have covered them; whether they are
re-minted later by the §16 R4b roughness-floor drain (`10 floor-low` on this
scene) is the next question (`R:` rows in `probe:camera-motion` now name the
object/material/size). The structural lever behind both numbers is the SIZE
of the GI-injected material fragment (27 kB without GI, 170–330 kB with the
mirror path) — the material wave's 13 s (harness) / 29 s (editor) is the
same number.

### 9.3 "Patches of wrong lighting after moving" — the walk probe's leg 1

`probe:gi-walk` (Level, ultra, scene frozen, pools pinned so the read-only
harness project does not pay the grow-ladder rebuild mid-run):

| leg | err0 | settle95 | maxStep | patch0 | note |
|---|---|---|---|---|---|
| leg 0 (8.9 m) | 0.0010 | 4.0 s | 0.002 | 1.0 | converged on arrival |
| leg 1 (8 m) | **0.267** | 2.1 s | **0.958 @ 2061 ms** | 0.95 | mean luma 0.368 for 2 s, then 0.087 |
| leg 1, `reflections: false` | 0.0032 | 4.0 s | 0.005 | 0.9 | the snap is GONE |

The whole-frame luminance was 4× too bright for two seconds after the camera
stopped and then SNAPPED — but `reflections: false`, `ao: false`,
`__giIrrHistWeight = 0` AND a plain REPEAT of base all read leg 1 at err0
0.002–0.003 / maxStep 0.004–0.007. ⛔ The snap was a ONE-OFF BOOT EVENT
landing during leg 1 (that run shared the GPU with a boot probe; a late
field-ready / IBL suppression is the shape), not a term. ⭐ RULE, again: a
single-run pixel receipt that two unrelated arms both "fix" is a run
artefact — repeat base before blaming anything.

What the Level's walk actually says, five runs agreeing: arrival error ≤
0.3 %, largest tile step ≤ 0.7 %, patch statistic ≈ 1 — on THIS scene the
diffuse field is converged on arrival (28 m house inside LOD 0's 28.8 m reach,
retention holding the rooms behind the camera, seeds inert because nothing is
fresh). The "patches of wrong lighting when I move" report therefore lives on
a scene with LOD transitions and a moving detail box (Bistro/Sponza) or under
a moving sun; the Level cannot show it. Next instrument: the drag/walk on
Sponza (`mainScene`) with the same tallies — the walk's path generator needs
rooms, so a fixed-pose leg list for Sponza has to be added first.

### 9.4 Live editor at rest (Level, ultra, 1548×930): 70 fps, cpu 6 / gpu 12 ms

`profile.giPasses` (isolated ms; halve for the real frame): bvhHitShade 3.17,
resolve 2.7, deposit resolve 2.56, emitterShadowPass 2.1, decay 1.78, gtao
1.26, trace 1.07, [J] 1.0, gather 0.97, tiles 0.93, bvhReflect 1.1. The pool
sweeps (decay + resolve + tiles ≈ 5.3 isolated) run over 2.8 M bins / 21875
tiles for **1531 live c0 probes (2.3 % load)** — the gi-frame-budget law
again; a live-block list is the unit. Reflections (bvhReflect + hitShade +
glossy) ≈ 4.7 isolated are the largest group — the user's "reflections are
the slow part", on the small scene.

### 9.5 "Time to lit" was the reflection kernels' compile; the two inlined
### descents rolled; the light-settle hold lifts the stride root

**⭐⭐ THE MARKER LIED BY 22 SECONDS.** Every boot number in §9.2–9.2b ended
at `field first pass dispatched` (or `field ready:`). That line is printed by
`#maybeLogStats`, which runs only on a tick where `_fieldReadyOnce` survived —
and ANY skipped consumer dispatch (`giSkippedComputes.size > skippedBefore`,
a pipeline still compiling) clears it. So the line waits for the LAST consumer
pipeline, and the last two to land are the exact-reflection hit shade and the
reflection-probe capture. `scripts/.tmp-boot-timeline.mjs` (every `[gi]` line
stamped in ms since `scene.open`, a 1 Hz `readStats` poll of tiles/gather lit,
and three's compute-program sizes at the end) on the Level:

| ms after open | event |
|---|---|
| 1040 | `[gpu] renderer REBUILD (device destroyed…): antialias true→false, samples 16→0` — the harness's own settings diff; one device per boot |
| 5490 | scene assets ready — building |
| **6906** | **tiles lit 77 873, gather lit 80 749** — the diffuse field is on screen |
| 9072 | compile wave: materials 3474 ms |
| 10839 / 11813 | occupancy chains: 31 steps / 4.6 s, then 37 steps / 0.9 s |
| 19715 | WATCHDOG `reflProbeCapture` pending 8.1 s |
| 25886 | WATCHDOG `bvhHitShade` pending 16.9 s (driver quiet 12.3 s) |
| 28478 | `field first pass dispatched 22896 ms after build` ← what every probe called "lit" |

The quiet-GPU boot probe of the same build read "46.6 s to lit" for the same
reason (the harness rebuilt twice under it). ⭐ RULE: a milestone that waits
on a SET of asynchronous things reports the slowest member — name the member
before believing the number. The engine now prints
`[gi] first diffuse gather dispatched Nms after build` (tick end, the screen
gather ran with nothing skipped; reset per build) and `probe:gi-boot-frames`
reports BOTH markers (`DIFFUSE LIT … · full marker …`).

**Why the two kernels took 17–25 s to compile (and 110 s on Bistro):** dumped
via three's node builder (`scripts/.tmp-dump-compute.mjs` +
`scratchpad/wgsl-loops.py`): `bvhHitShade` 206 kB, `main` 97 kB calling
`giStaticPlacementBvh8 ×8, giDynTrace ×8, giEmitterFactor ×8` — `analyticDirectAt`
iterates the 4 light slots in JS and `emitterDirectAt` the 4 emitter seats,
so each slot's shadow trace is INLINED (HLSL inlines every function call:
8 BVH descents in one entry point). `reflProbeCapture` (199 kB) is the same
formula by contract. srcShade.js had already measured this shape at ~1.2 s
of compile PER INLINED DESCENT and rolled its own loop (§13.14.5); the two
hit-shading consumers never got the roll. `src:shade + bounce [J]` is 255 kB
and compiles in < 2 s — size was never the variable, the descent count was.

FIX (giLight.js `analyticDirectAtRolled` / `emitterDirectAtRolled`, opt-in
`{ rolled }` from the two consumers, `__giRolledDirect = false` for the A/B):
the slot's fields are picked by index inside a GPU `Loop` (a `select` chain
over the uniform table), the per-slot maths runs once on the picked slot, and
the trace is called once per iteration. Math-identical (same terms, gates,
slot order); the only change is cost — the unrolled form traced a slot whose
term was zero. RECEIPTS: census `×8 → ×2` for all three helpers, `main`
97 → 79 kB (the ×2 that remains is one light descent + one emitter march);
**full marker 28.5 → 18.0 s after open (22.9 → 12.0 s after build), no
watchdog fire**; diffuse milestone 4.5 s after build (10.5 s after open, the
1 Hz poll agrees at 11.1 s). The 6 s between the chains' end and the full
marker is what the remaining consumer compiles cost; `reflProbeBlur`
(158 kB, 129 texture ops, zero loops — a fully unrolled blur) and
`emitterShadowPass` (100 kB) are the next candidates.

**Convergence after a light step (the user's #4), named by the dials.**
`probe:gi-src-converge` now traces the transport's live dials through the
step (`ARMS=strided` runs one arm; `TRACE=0` silences the trace) and prints a
noise receipt (Δmean reversals, 0.5–2.5 s post-step vs pre-step). Strided arm
(stride 12 = the user's ultra regime), 3× step, BEFORE:

```
 0.0s a 0.100 root 0.70 lift 1.00 surprise 0.0002 boosted 1
 1.1s a 0.050 root 0.38 lift 0.38 surprise 0.0000
 3.1s a 0.031 root 0.00 lift 0.14 surprise 0.0059 boosted 10   ← still alpha from here
15.6s mean 0.0928 (F 0.0910)                                    t90 10.78 s
```

Two findings. (1) The settle hold works as designed (α 0.1 → 0.05 → 0.02
inside 3 s) but the STRIDE ROOT was tied to the MOTION signal only
(`max(tr, sustained)`), which a light step merely brushes — so the settle
alpha was paid at the 4th…8th root per frame and the still alpha at the
12th: 0.22 of the old field remained at 2.5 s, then a 470-frame crawl to
90 %. (2) The surprise detector marked 10 blocks of ~1900 (mean u 0.006):
its shot-noise floor uses THIS FRAME's deposit count, and the CPU twin
(`scratchpad/surprise-sim.mjs`, bit-identical `blockSurpriseUpdate`) shows
a 3× step at 1 deposit/frame peaks at u 0.41 and never trips; at 0.25/frame
never registers; ≥ 2/frame trips within 1–4 frames. At stride 12 most
blocks live below that line, so the detector cannot carry the case, and
re-tuning it toward sensitivity re-buys the §12.42 false-fire flicker.

FIX (srcSystem `syncCamera`): the light-settle hold lifts the root with it —
`rootS = 1 + (S−1)·(1 − max(tr, sustained, lightTerm))`
(`__giSrcLightRootRelax = false` restores). keep = 1−α per frame during the
1.5 s hold → the settle alpha converges in 2.3/0.05 = 46 frames; the fade
hands the root back as the alpha falls. Energy unaffected (count-weighted
means). RECEIPT: the dials confirm it (keep 0.90 → 0.95 → 0.998 as lightTerm
1 → 0) and t90 DID NOT MOVE: 10.09 s (stride 12), 8.44 s (stride 4).

**So the probe now reads EVERY STAGE (the colour-probe method applied to
time):** `irr` (post screen temporal), `raw` (pre), `gather` (the SRC screen
gather target) and `bins` (the BSTAT block means, accL/accW over live
blocks, read every 8th sample). Stride 12, 3× step:

```
per stage: irr t90 10.71 s · raw 10.59 s · gather 10.59 s · bins 10.70 s
hold 12 s (keep 0.95 throughout): irr 8.29 s · raw 7.95 s · gather 7.95 s · bins 6.89 s
```

The BINS lag as much as the image, and with keep held at 0.95 (old energy
gone in ~45 frames) they still take 6.9 s: **the deposits' own luminance
ramps.** A hit's direct term reads the light slot's uniform (instant;
`lightTermsAt`), so the ramp is the BOUNCE — most of the light's energy
reaches a probe through the field-at-hit term of [J], and each round trip
(deposit → bins → tiles → next frame's hit read) costs one bin time constant;
an enclosed room at albedo ~0.6 needs ~6 round trips for 90 %. Neither the
screen temporal (weight 0.9 at rest → 0.4 s) nor the surprise detector nor
the stride root is the axis; the bounce iteration's period is. The lever
inside the design is the bin time constant DURING the light hold (α 0.1 →
10-frame memory → ~2 s at 30 fps); the lever outside it is a cache-side
relight (scale the tiles' known-light contribution by the light's ratio —
Lumen's radiance-cache invalidation), which is a unit, not a knob. ⚠ NOISE
RECEIPT: keeping the root lifted at REST (the 12 s hold arm's pre-step
window) read 37 % Δmean reversals vs 0 % shipped — the root is the noise
floor's reason, and any window must close.

**The scene-switch crash (user report, 09-02 evening).** `Uncaught TypeError:
Cannot read properties of null (reading 'probeSpacing') at #rebuild
(GISystem.js:11628)` — the auto-fit branch read `fit.probeSpacing` when both
AABB sources returned null (the new scene's meshes not yet present, nothing
"pending" by `#readyToRebuild`'s definition, the queued rebuild ran). FIX:
`autoFit && !fit` → log once, stamp the fingerprint for the empty mesh set
(so an empty scene does not re-queue itself every check) and return; the
fingerprint watcher requests the build when meshes land.
`scripts/.tmp-scene-switch.mjs` (Level → Cornel → Sponza → Level, every
page error + GI milestone stamped): no GI error, the diffuse milestone
after every switch (4.1 / 2.9 / 1.8 / 4.1 s after build). The harness did
not reproduce the null-fit timing, so the guard is proven by shape, not by a
red-then-green run.

**⭐ EVERY SCENE SWITCH DESTROYS THE DEVICE.** The same log: Level opens
with `antialias true→false, samples 4→0`, Sponza with `false→true, 0→16`,
Level again with `true→false, 16→0` — each a `[gpu] DEVICE LOST (destroyed)`
plus a full GI rebuild and material recompile, because the renderer block is
PER SCENE and antialias is frozen at `WebGPURenderer` construction. That is
the user's "DEVICE LOST ×3 in a 4-minute Sponza session" (§9.2b): the losses
are scene (or play-stop-through-scene) transitions, not GI. The play-stop
coalescing (Engine.js) is correct and this is a different case. The unit is
a SETTINGS decision, not a renderer one: antialias/samples as a
project-level renderer block (scene overrides warn), so a switch never
re-mints the device — the user's call.

**"Async render pipeline creation failed (selectionOutlineMask:selected_N):
… 'format' … Required member is undefined" (user report, 09-02 evening) —
TWO three.js hazards, one fix.** (1) `RenderContexts.get` keys a context by
ATTACHMENT SHAPE (`count:format:type:samples:depth:stencil` + mrt), not by
target, so the outline's RGBA8/no-depth mask target and GI's RGBA8/no-depth
`giTexPixels` readback target shared ONE RenderContext object; `compileAsync`
holds its context across an await per object; `readTexturePixelsGPU` rendered
through the shared context in that gap and DISPOSED its target; the compile
resumed with `context.textures[0]` dead → no backend format → the error.
Named by a page-side tap on `getCurrentColorFormat`/`getTextureFormatGPU`
(`scripts/.tmp-scene-switch.mjs`, ~1 run in 2). (2) three's async pipeline
branch wraps `createRenderPipelineAsync` in a validation error scope, so ANY
validation error raised meanwhile — "Destroyed texture [giTexPixels] used in
a submit", from a per-use `texture.version` bump re-creating a pooled
texture under an in-flight copy — is attributed to whatever MATERIAL
pipeline is compiling, and that pipeline is marked failed. FIX: the GI
one-shot readback targets are POOLED per shape and never disposed
(`oneShotTargetFor`, versioned once); the outline prewarm additionally calls
`initRenderTarget` before compiling and refuses a target with no stamped
format. ⭐ RULE: a target rendered through `compileAsync`'s shape-shared
context must outlive every compile in flight — never dispose a one-shot
target of a shape something else compiles against.

### 9.6 Bistro live: "30 s until GI, black artifacts, the GI image freezes when the camera moves"

The user's editor console (Bistro opened 15:59:11, read through `console_read`)
names all three:

| Bistro live log | what it is |
|---|---|
| `compile wave: materials 43896ms` | the material wave — still the biggest first-light term on this scene |
| `occupancy chain: 28 steps over 58726 ms (window 3200000 items, 632.5 ms/windowed frame)` | ⛔ the chain's window controller lived on the system instance and DOUBLED per chain: Sponza's last chain left it at 3.2 M items, Bistro's first chain then ran a minute at 1.5 fps |
| `chain to first field: 85692ms` / `field first pass dispatched 59949ms after build` | GI "appeared" at ~60–85 s: the wave + that chain |
| 22 × `auto-fit: refit in place (slide)` + `follow: slide … settle window armed` every ~0.5 s, each followed by `occupancy chain: 55 / 82 / 127 / 241 / 349 steps` | ⛔ the volume (47 m) follows the camera across the 140 m scene; every slide re-mints the FULL chain; the camera crossed the slide band every 0.5 s, so the chain restarted every 0.5 s and the field never landed while the camera moved |
| (the screenshots) | while a chain runs, `_occupancyChainIncomplete` holds the whole SRC block — camera sync, world AND screen passes — so the deferred irradiance texture is never re-resolved: the previous pose's awnings and shadows stay composited over the new view = "the whole deferred GI image remains frozen" |

FIXES (GISystem): (1) the window controller is per FIELD (reset in
`#rebuild`), capped (`OCC_SLICE_ITEMS_MAX` 800 k), prices the SLICE against
the frame's own baseline (EMA of frames that carried no windowed step) and
aims at 8 ms of slice, not 24 ms of frame; (2) `#followCamera` does not
slide under a moving camera (`#cameraMotionEma() > 0.2`) unless the viewer
is starved (about to leave the volume) — so a chain is a ~1 s event AFTER
the camera settles, when a held screen is a still view waiting for light.
Level boot unchanged (31 steps / 4.0 s, diffuse 4.2 s after build);
`probe:gi-walk` leg 0 err0 0.0026 / maxStep 0.0034 (the morning's numbers).

⛔ TRIED AND REVERTED: running the camera sync + screen passes + the
non-record consumers THROUGH the hold (so the image follows the camera
during a chain). `probe:gi-walk` leg 0 read a 0.99 per-tile step: syncCamera
re-anchors and retires the probes while populate/seed/deposit are held, so
the gather reads EMPTY and paints black/white until the chain lands. A stale
still view beats that. The hold stays whole.

**THE STRUCTURAL UNITS (the user asked for them):** (a) a SCROLLING
occupancy grid — a slide shifts the pyramid/records by whole cells and
voxelizes only the exposed slab, so following the camera never re-mints the
chain (this is also ask #3, the seamless far field); (b) mover DEMOTION
without the full chain — `setSlotDynamic(slot,false)` sets `staticDirty`
(occupancyField ~686), i.e. one quiet mover re-voxelizes the whole static
set and holds the screen; a fold path (replay the demoting slot over the
snapshot, re-snapshot, append its records via the sliced surfAccum over the
slot's pair range) makes it a fast-chain event. `[gi] mover demoted …` is
now logged so the next Bistro session can count them. `test:gi-spawn`
"respawn rides the FAST chain (fulls 4 → 5)" is RED and inherited: A/B'd
against every piece of today's chain patch (consumers-through-hold off,
world gate old, slice target 24) — unchanged; the morning's chunked chain is
the suspect.

**9.6a The screen renders THROUGH a chain (shipped after the A/B).** The
user's next console (16:55, after the guard) still showed slides every
0.5–4 s under motion: on a 115 m scene with a 40 m box the camera reaches
the 4 m feather under ordinary motion, so the follow slides as STARVED and
each slide's chain (76 steps, ~1 s at the 800 k window) held the screen. So
the hold is now partial: `syncCamera` runs with `{ holdAnchor: true }` (no
re-anchor → no probe retirement), the world passes that read neither the
pyramid nor the records run (`giSafeDuringChain`: populate, hashBlock,
seed), every screen pass runs, and the consumers that never touch
occupancy run if already built (`giHeldDuringChain` holds only the
emitter-shadow chain + its clear). Deposit/decay/[J]/attribution/merge/tiles
wait for the chain. A/B on the Level with a forced 12 m box
(`__giConfigOverride.detailExtent = 12`, `probe:gi-walk` LEGS=2, FREEZE=1):

```
old whole-block hold   leg0 maxStep 0.968  leg1 0.926   luma 0.105→0.545→0.156→0.14→0.13→0.573→0.14 … (the stale/fresh flip, 17 slides / 18 chains)
screen through chain   leg0 maxStep 0.899  leg1 0.219   luma 0.107→0.545 and STEADY (one transition when the chain lands; 12 slides / 13 chains)
```

`__giChainHoldsScreen = true` restores the whole-block hold. What remains
visible is the arrival dimness itself (0.107 before the box arrives): the
view OUTSIDE the detail box is the far-field constant — the user's "black
patches appearing on surfaces" as the camera moves — which no hold policy
fixes. That is §10.

## 10. THE STRUCTURAL DIRECTION (2026-09-02 evening — the user asked for it)

The user: "we have a ton of structures, each eating hundreds of megabytes —
the pyramid, the BVH — and it can't update fast enough when the camera
moves; black patches on surfaces; optimise in a deeper, structural way."
What the day's receipts say the structures cost on Bistro:

| structure | bytes | rebuild cost | what it is FOR today |
|---|---|---|---|
| dense occupancy pyramid 336³ @ 0.12 m, 5 levels | 274 MB (+ 628 MB CPU mirrors until detached) | 17.7 M SAT work items per chain; a full chain on EVERY slide of the 40 m box; kernels queue 20–26 s behind the material wave | probe-ray visibility (the DDA of "hybrid-exact-complex"), per-cell surface records (bounce albedo attribution), the emitter-shadow record march |
| static BVH8 (2.8 M tris) | 115 MB file, 172 MB resident | 4.9 s build, disk-cached | exact reflections, light shadows at hits, the "exact" half of hybrid hits, movers (OBB + per-mover BVH) |
| SRC probe store (2.8 M bins, 4 cascades) | 164 MB | none (hashed, anchor-relative, unbounded) | the field itself |
| 172 material variants × 91 kB | — | 60.6 s wave; every first-sight variant on a drag | the in-material specular path (probe loop, prefilter, glow, mirror blend) |

**The pyramid is the odd one out.** It bounds the field to a 40 m box on a
115 m scene (everything outside is the far-field constant = the black
patches), it is the only structure that re-minted on camera motion (the
slide chains), it is the largest allocation, and every job it does has a
BVH twin already in the codebase: the reflections trace the BVH8 exactly
(`bvhReflect` 11.8 ms for a full-screen mirror pass — the transport's
131 k–393 k probe rays are a small fraction of that), the sun at hits moved
from the occupancy cone to a BVH any-hit ray this month for quality
reasons (giScreen's hit-shade note), movers already carry OBB + BVH, and
bounce albedo can come from the hit triangle's material (the albedo atlas
exists for reflections). The one job without a BVH twin is the screen
gather's LOS validity (probe↔pixel line of sight), which needs a cheap
proxy (normal-offset + depth test) rather than a ray per pixel.

**Proposal — BVH-only visibility, no dense grid:**
1. Transport trace → BVH8 closest-hit (the reflections' traversal, with the
   albedo atlas per material for the hit's albedo). Hit shading [J] and
   the emitter shadows at hits → BVH any-hit (as the sun already does).
   The occupancy field, its chain, the surface-record pool and the CPU
   mirrors go away: −274 MB, −628 MB transient, no re-voxelize ever, no
   detail box → the hashed probe lattice covers whatever the camera sees,
   far cascades coarser (§ ask #3 falls out of it).
2. Emitter shadow pass (screen side) → BVH any-hit per pixel at the
   emitter-shadow resolution (already sub-res, 0.85 scale).
3. Screen gather LOS → depth/normal proxy; measure leaks against the
   current occupancy check with `test:gi-gather-los`.
4. Movers: keep the dynamic OBB + per-mover BVH set; a TLAS over static +
   movers replaces "promote/demote/full chain" — a moved object is a TLAS
   node update, never a re-voxelize.
5. Materials: deferred specular (the specular GI term resolved per pixel
   in screen space from the gbuffer's normal/roughness/F0, sampled by the
   material like the diffuse resolve is) → materials back to ~27 kB →
   the 60 s wave ≈ 10–15 s, no 91 kB compiles on first sight.
6. BVH memory: quantized BVH8 nodes (16-bit child bounds) and shared index
   buffers → ~40–60 MB for Bistro.

Expected on Bistro: boot = BVH (cached) + a ~15 s wave; camera motion never
re-mints anything; no black patches at a box boundary; ~600 MB less GPU
memory; the transport's per-frame cost moves from "DDA + record fetch" to
"BVH8 traversal" (to be measured — the reflections pass is the reference
point). Risks: leaks where the pyramid's conservative voxels blocked light
that a thin triangle set does not (the BVH is exact — fewer leaks, not
more); the LOS proxy; the per-ray cost on very dense foliage. This is a
multi-day unit and a decision for the user, not a patch.

### 10.1 The field-less build, staged (2026-09-02 evening, user's "go")

**Shipped first (behind `rayHitMode: "bvh"` / `__giSrcBvhTrace = true`):**
`src/modules/gi/srcBvhTrace.js` — the transport's scene trace (static
BVH8 closest-hit `traceStaticBvhSlot` + movers `dyn.trace({objId})`, nearer
wins), its light visibility (`traceStaticBvh({anyHit})`, movers optional),
and hit attribution BY SLOT through the same palette the occupancy
attribution publishes (+ the reflections' albedo atlas for textured hits;
movers via `dyn.surfaceAt`). srcSystem swaps them when `bvhTrace` is given;
the cell-keyed `surfaceAt` never runs for a slot-keyed hit. RECEIPTS (Level,
`scripts/.tmp-live-readback.mjs`): same probes/tiles/gather counts
(1294/392/123/54 live, tiles lit 82 816, gather lit 80 749), tiles meanLum
0.974 → 1.042, gather meanLum 0.989 → 0.890; builds and lights with no
kernel error. Parity gates still owed: `probe:gi-colour-bleed`,
`test:gi-preset-energy`, `probe:gi-sun-bounce`, the walk.

**Shipped second — THE FIELD-LESS BUILD (`rayHitMode: "bvh"`, or
`__giRayHitMode = "bvh"`; `__giFieldless = false` keeps the pyramid beside
the BVH transport).** Three seams, three owners: (1) srcVolume.js —
`createSrcVolume({ occField: null, bounds, minCell })` builds the world
bundle from the bounds and a nominal 0.1 m length scale, `distance` null,
the field-only factories return null (subagent; `tests/gi-src-volume-
fieldless.test.mjs` 7/7, `test:gi-src-volume` unchanged). (2)
srcSlotPalette.js — `createSrcSlotPalette({ bits, wordOffset, slots,
placements, assignments, emitterMeshes })` owns the eight-words-per-slot
palette (sync, audit, pass); `createSrcSurfaceAttribution` delegates to it
with the field's own uniform + pass, byte-identical (subagent;
`tests/gi-slot-palette.test.mjs` 11/11). (3) GISystem — in the field-less
mode `#buildOccupancyField`'s `makeField` mints `#makeSceneHost` instead: ONE
storage buffer (dyn pool, static BVH8 words, palette) duck-typing the few
properties the rest of the build and the tick read (`bits`/`bitsBuffer`,
region offsets, `slotCapacity`, `placements`, `cpuMirrors`,
`surfaceAttribution`'s palette region) and none of the voxel APIs, so every
`occ?.voxel` / `isDirty` / `chunkedPasses` / `readbackStats` gate fails
closed; the host rides `volume.occupancyField` for its tenants (the light
tree's words, the one-BVH palette). The two shadow builders take the exact
static-BVH arm without a field (`voxMax` from `world.cell`), the detail box
/ follow / slides are off (`_fieldless`), the occupancy debug view needs
the field's kernels, and the transport's shading gate accepts the
slot-keyed attribution. RECEIPT (Level, ultra): `[gi] world: BVH-only —
scene host 7.3MB (dyn pool 6.0MB, static BVH 0.9MB, palette 768 slots)` in
place of the 82 MB pyramid + records + mirrors; `occupancy backend: NONE`;
light shadows `static-bvh8 + exact-dynamics + analytic-penumbra`; diffuse
milestone 4.1 s after build; tiles lit 82 816 / gather lit 80 749 (same as
the field); no kernel error. Energy/walk/memory A/B: below.

**Field-less A/B (Level, ultra, harness 1200×700, `.tmp-live-readback` +
`probe:gi-walk` LEGS=2 FREEZE=1):**

```
                      occupancy        field-less       field-less + ε lifts
tiles meanLum         0.977            1.035            1.023
gather meanLum (boot) 1.023            0.892            0.882
walk leg0 luma        0.0037           0.0043           0.0045
walk leg1 luma        0.079            0.121            0.123
walk maxStep          0.0035 / 0.0063  0.012 / 0.005    0.0076 / 0.0052
fps / cpu / gpu       83 / 9.3 / 3.4   82 / 9.7 / 3.7   97 / 7.5 / 2.5
jsHeap MB             547              385              399
```

The walk is clean in both (no pops, no black arrivals). The field-less
build is BRIGHTER at the walk's waypoints (+15 %, +55 %) and darker in the
boot view's gather (−13 %); the ε lifts (4 mm / 2 mm instead of 0.75 /
0.5 cells — a 16 cm lift hops through any wall thinner than that on a
zero-thickness BVH) did not move either, so this is not a leak through the
lift. A conservative pyramid over-blocks (41 of 111 meshes are thinner than
two cells and share one record), so some brightening is expected; the
boot-view darkening is unexplained → the colour-probe method (mask one term
at a time: gather / probe floor / emitter / analytic, `termMask`) is the
next receipt before the mode ships by default.

**The rolled loops, audited by `test:gi-hit-shade` (the mirror's lit crop):**
unrolled 0.215 · analytic roll only 0.221 (fine) · emitter roll only
0.000 (BLACK) · both 0.000. The emitter roll's WGSL is structurally sound
(gates, both traces, the accumulation are all present) — the fault is in a
value; it is OPT-IN now (`__giRolledEmitter = true`). The analytic roll
alone still halves the static descents. The rig's second (flat) arm reads
black in every configuration including unrolled — a rig/second-boot
issue, pre-existing. The emitter GLOW roll in the material (subagent):
largest material fragment 91 → 83 kB (−8.4 %), `test:gi-reflection-probes`
and `smoke:gi-gpu` green; `pickSlotField` now emits a one-line `select`
under `.uniformFlow()` (three 0.185 otherwise emits an if/else block per
pick — the first rolled arm's 11 picks cost more than the 4 bodies).

**The inventory (subagent, read-only, 99 tool uses) — what still needs the
field, in blocking order:**
1. `srcVolume.js:509` `createSrcVolume` THROWS without a field: `world.min /
   size / minCell / cellMax` derive from the grid and every bias uniform
   (`_giNormalOffsetU`, `_giShadowMarginU = max(0.2, cellMax·2.5)`,
   `_giMirrorRangeU`, `_giShadowRangeU`, `dyn.sync(cellMax·1.5)`,
   srcShade's `voxelSize`) reads them. → a world bundle from bounds + a
   nominal length scale (probe spacing / 4).
2. The distance oracle `freeRadiusAtWorld` (`createSrcDistance`): the width
   probe, the soft-shadow trace, the burial gate, the SDF debug view. The
   exact arms (analytic penumbra from the BVH blocker distance, burial gate
   disabled under the static BVH) already supersede all but the debug view.
3. `bits` as the shared HOST: `createDynamicObjectSet({ bits: field.bitsBuffer,
   baseWord: field.dynamicObjectWordOffset })`, the static BVH words at
   `field.staticBvhWordOffset`, the light tree in the tail — `_dynSet`,
   which owns `traceStaticBvh`, cannot exist without the field's buffer.
   → its own storage buffer (dyn pool + static BVH + light tree + the slot
   palette), the field a tenant of NOTHING.
4. Screen-gather LOS validity: `occupiedAtWorld` point-in-solid marched
   probe→pixel. A BVH answers rays, not points → one any-hit ray per pixel
   toward one corner per frame (rotating), or LOS off in the BVH mode and
   `test:gi-gather-los` re-read.
5. Deletable outright once nothing traces occupancy: the chunked chain and
   its gate/tally/window controller, `setSlotDynamic` promote/demote +
   `OCC_DYNAMIC_QUIET_FRAMES`, `composeFieldDynamics`, the entire detail
   volume / follow / refit-in-place / far-field-constant machinery (four
   §13 F3 sites), VXAO + GTAO's `__giWorldAo` cone, `readbackStats` /
   `readbackSurfaceAlloc` / `_surfacePoolHint`, `prewarmComputes`.
   `#applyBounds` survives in reduced form (the probe lattice + bias
   uniforms). Emitter record-march and the resolve-side record march fall
   to the exact arms by construction (they gate on `hasSurfaceRecords`).
6. Tests/probes that are voxel-native: `srcVolumeRef.js` (the CPU pyramid
   twin), `srcRef.js` `makeVisibility(…, voxelSize)` / `makeHitShader({surfaceAt})`,
   `test:gi-occupancy`, `test:gi-spawn`, `test:gi-surface-pool`, the
   Occupancy debug overlay (fragment-side; BVH traversal is compute-only by
   policy) — retire or re-target when the mode flips.

**Bistro double-boot in the user's editor (console, 15:01):** `[gi] static
BVH scene pointer was stale (250a272f → 1163f1c0)` → `requestRebuild(
"static-bvh-manifest-stale")` because no dynamic set was up yet → a SECOND
full build + compile wave (155 s on Bistro). The manifest SHA disagreed with
the preflight's cached signature right after a clean build; the branch that
stages the replacement without a rebuild exists but needs the dyn set. Owed:
a Bistro repro (blocked by the harness crash) and a "stage, never rebuild"
policy when the build has not consumed the BVH yet.

**Also seen on the way.** ⛔ BISTRO KILLS THE HARNESS TAB ~3 s AFTER
`scene.open`, before a single `[gi]` line — three runs (the walk at
2600×1600: "Target closed"; the pass-cost probe: "detached Frame"; the boot
timeline at 1200×700: target closed at 4.7 s, only `[gpu] adapter` logged).
That is the scene LOAD, not GI (the build is deferred until assets land). The
08-26 baseline booted the same scene in the same harness, so something
between then and now — the asset path, the shim's raw-bytes IPC, or headless
Chrome's renderer memory — is new. `scripts/.tmp-boot-timeline.mjs` now taps
puppeteer's page `error` event and Chrome's stderr for the crash reason; the
Bistro receipts for §9.1's reflections cost are owed behind that. The Sponza walk at the big viewport read
`err0 0, rooms 0, gather mean 1.2644 constant` — the camera path did not
resolve there; blind, not clean. The harness's surface pool sizing differed
between two Level boots (922 148 vs 589 824 records → POOL STARVED, 1048
bricks boxed) — the measured-demand cache is not applied on every boot.

### 10.2 The reflect hold held nothing — and "auto" is the BVH build (2026-09-02, late)

**The ask:** "fix the emitter roll and flip auto to bvh." The roll was innocent.

**What the rig had been measuring.** `test:gi-hit-shade` reads the mirror off
the CANVAS after a 20 s settle. A new probe (`scripts/.tmp-hitshade-stages.mjs`:
one boot, the camera pose verified per poll, the hit-shade targets read off the
GPU, every non-SRC dispatch counted, the pipeline ledger and the reflect-hold
state printed every 3 s) put the timeline next to the number:

| t after pose | canvas mirror | what was on it |
|---|---|---|
| 6–19 s | 0.13 → 0.18 | the GLOSSY fallback (`exactHit.a = 0`, the hit-shade pipeline still compiling) |
| hit shade lands (11.5 s unrolled / 3.9 s rolled) | **0.000** | the exact arm at full weight, BLACK |

Every "lit" arm of the evening was the fallback sampled before the hit shade
landed; every "black" arm was the real hit shade. The roll only moved the
landing (11.5 → 3.9 s on the rig — a 3× compile win on this kernel), so a roll
arm reached the black sooner and an unrolled arm sometimes not before the read.

**Why the hit shade was black: the exact-reflection prepass never traced.** The
reflect hold (`reflectHeld = _gbufHeld`) assumed "the previous frame's trace is
still there". Under a parked camera the g-buffer fingerprint is stable from the
FIRST frame and the compile wave skips the prepass, so a view held before the
wave ended never got a first trace — zero `bvhReflect` dispatches over 40 s, the
hit shade landed on a zero-initialised hit buffer (t = 0 reads as a hit at the
surface) and wrote black with `bvhValid = 1`. The user's Bistro boots are exactly
this: the camera parked through a 60 s boot. Fix: the hold now requires a STAMP
from the last EXECUTED trace (built, pipeline landed, not budget-deferred) for
this g-buffer key, target, dyn set and kernel; the hit chain's own holds (idle
list, held-view cadence) wait until it has consumed the current reflect
generation.

**Second half, found by the same probe after the first fix:** the first executed
prepass traced **0 hits** (`hitT 0/0`) and the stamp then held that empty trace.
The static BVH words go to the GPU through `queueRegionUpload` — a copy kernel
whose own pipeline is async — while `attachStaticBvh` points the base uniforms
at the region immediately. The stamp now also requires the upload block
`uploaded`, every queued dyn upload live (`_dynUploadsLive` from
`confirmDispatch`), no deferred attach, no stale scene, no chain owning the
buffer. Receipt (hybrid, unrolled): reflect gen 1 at 13 s with 217 hit texels,
hit shade at 22.8 s → mirror **0.395** (exact) vs 0.18 (fallback), steady through
idle (`quiet 736`, held-view cadence 11 dispatches / 3 s).

**Flipped:** `emitterDirectAt` rolls by default again (`__giRolledEmitter =
false` unrolls); `AUTO_MODE_BY_QUALITY` → `RayHitMode.Bvh` for every tier
(`rayHitMode: "hybrid-exact-complex"` / `__giRayHitMode` is the way back);
`test:gi-occupancy`, `test:gi-spawn`, `test:gi-gather-los` pin the occupancy
mode they measure. Owed: the other voxel-referencing rigs on the new default,
the boot-view colour probe (termMask) for the field-less −13 %. `test:gi-hit-shade`
on the new default: ALIVE 0.396 / 0.395, SHADOW ×1.600 vs the flat arm's ×1.214,
NOISE 0.1 % — all PASS (the "shadow brighter than lit" inversion seen earlier was
the glossy fallback's, not the rig's).

**First live boot on the new default (user's Bistro, 22:14):** `THREE.TSL:
Invalid parameter for the type "vec3"` from `#buildLightShadow`'s `traceDda`
closure — the one unguarded `vec3(occ.voxel)` left (the rig has no analytic
light, so no harness built that kernel). Guarded like its siblings (the
world's nominal cell sizes the lifts; the static-BVH arm traces). Live numbers
before the reload, with the light-shadow kernel dead: 33 fps, CPU 17.6 ms,
GPU 27.1 ms, JS heap **1.39 GB** (the 08-26 baseline: 6 fps, 197 ms, 6.7 GB).
Reload receipts owed: the sun shadow pass alive, `giHold` populated, fps.

**Level boot on the new default, after the guard** (`.tmp-boot-timeline.mjs`, ms
after scene.open): world BVH-only 5358 · light shadows gi-traced ON 5445 ·
**full marker 8695** (3275 ms after build; this morning's number was 28 500) ·
first diffuse gather 8866 · no page errors. `#maybeLogStats` now prints the
marker in the field-less build (it returned on `!occ.readbackStats`, so every
boot probe's end marker was "never").

### 10.3 "Better performance and zero black patches" — the parked-camera ledger (2026-09-02, night)

**Live Bistro, ultra, camera parked, one animated character (27 bone
capsules), read over MCP.** Before: 22–23 fps, GPU 40–41 ms, CPU 17–18 ms.
`profile.giPasses`: world chain 27 ms per dispatch (`shade + bounce` 18.1 +
`deposit trace` 9.3, 41 592 rays, ~650 ns per ray against a 2.83 M-triangle
BVH8 = 4 descents per ray), emitter shadow pass 11.9 ms (466×280, 2 live
seats), bvhReflect 4.3, resolve 3.7, hit shade 1.9. `fieldQuietFrames` 0,
`reflectHeldFrames` 0 — no hold ever engaged.

**Why nothing held: one character.** (1) `#gbufferFingerprint` returned null
for the whole frame the moment a SkinnedMesh existed, so the g-buffer
re-rendered every frame (5.5 ms CPU) and the reflect/hit-shade holds never
armed. (2) The field hash's `dyn` section ticked every frame — the new
`giHold.quietBreakers` counter (per-section change counts over 120 frames)
read `dyn 44/43`: the character's bone capsules move, `dynSet.version++`
each frame, the world never idles.

**Shipped:** (a) the fingerprint hashes bone world matrices and morph
influences instead of bailing, and returns a STATIC key beside the full key;
(b) "movers-only" frames (static key held, full key moved) run the emitter
shadow chain, the exact-reflection prepass and the hit chain every
`GI_MOVER_ONLY_STRIDE` = 2nd frame, each only after it has produced a frame
for the current kernels; (c) the world chain runs at `GI_WORLD_REST_HZ` = 15
when the transport's rest drive is ~0, AND at most every other frame — the
first cut (rate only) measured 23 → 16 fps because the 30 Hz slow-frame rule
had already been alternating frames below 30 fps and a 15 Hz period was due on
nearly every 60 ms frame. **After: 31 fps, GPU 32.6 ms, CPU 17.6 ms**, same
pose, `staticHeldFrames`/`moverOnlyFrames` counting, `worldHz 15`,
`hitShadeGapMax 1`. Level gates: hit-shade rig ALIVE 0.39/0.39 SHADOW ×1.65
PASS, smoke both arms PASS, walk legs maxStep 0.012 / 0.027 (no patches).

**What is left on the GPU at rest (≈ 32 ms):** world 27 ms every other frame
(13.5 avg) · emitter shadow 12 every other frame (6) · reflect 2.2 · resolve
3.7 · hit shade ~1 · AO ~1.5 · scene draw ~5. The 60 fps floor on Bistro needs
the world dispatch under ~8 ms or a quarter rate at rest, and the emitter
shadow under ~3 ms. Next levers, in order of size: a convergence-driven ray
budget at rest (rays per probe scaled by the bin's own surprise/keep, not the
pool), fewer descents per hit (sun via the frozen shadow map, NEE 2 → 1 pick),
and a GI-only simplified transport BVH for the coarse tier.

**Black patches, what is known without a screenshot:** Bistro's environment
has `lighting: false` (sky light 0 — the console's own warning: "every photon
comes from a lamp and ONE bounce … crushed blacks"); tile coverage 0.81 with
30 % of tiles empty (fresh/unknown bins); `unattributedRate 10.6 %`. The
first is a scene setting, the second is deposit starvation on fresh probes
(the seed prior exists; orphan bins 14.8 %, cascade 2 30.9 %). A screenshot
is owed before choosing.

**Rest cap (same night):** at rest the per-probe ray cap halves (32 → 16 at
ultra; `__giSrcRestCap = false` keeps it). Live Bistro: rays 41 592 → 33 196
per dispatch, `shade + bounce` 18.1 → 14.7 ms, `deposit trace` 9.3 → 9.1
(the deposit dispatch is stride-sized; capped threads exit early). Level
convergence probe (`ARMS=strided STRIDE=12`): t90 10.25 s vs 10.1 s baseline,
pre-step noise 3.5 % vs 2.9–3.3 % — unchanged. Frame: 30 fps / 33.5 ms
(the camera had moved between readings; per-pass numbers are the receipt).

**Emitter-shadow checkerboard (same night):** `createGiEmitterShadowPass`
marches half the pixels per dispatch (parity of x+y+frame) when a `frame`
uniform is present (= the temporal chain exists); GISystem zeroes the
`checker` uniform on movers-only frames so nothing stacks with the every-
other-frame cadence. The rebuild path now passes `frame` too (it used to drop
the area jitter after a resize). Gates: smoke both arms PASS, emitter-shadow
probe soft 0.97 / grain 0.030, walk maxStep 0.018 / 0.035 (no patches; the
second leg was 0.027 before). Live receipt under camera motion is OWED — at
rest with the character the pass runs full-pixel every other frame by design.

⛔ **THE HARNESS SHARES THE GPU.** Two live readings taken while a harness
Chrome ran (smoke, then the walk) read GPU 61 and 77 ms with every BVH-heavy
kernel doubled (emitter 25.7, reflect 8.9, shade 19.7) and the resolve flat —
nothing in the editor had changed. GPU alone, same pose, same build:
**30 fps / 34.6 ms / CPU 16.5 ms**, emitter 11.4, reflect 4.8, shade 14.7,
trace 9.0. Every live number in this section was re-read with the harness
idle; the rule is in memory (`dual-gpu-webview2-pin`).

**Ledger for the ask (parked camera, animated character, Bistro ultra):**
23 fps / 41 ms → **30 fps / 34.6 ms** from four cadences (pose-hashed
fingerprint, movers-only stride, world rest rate frame-bounded, rest ray
cap). Still on the table for 60 fps: world 24 ms per dispatch (every other
frame), emitter shadow 11.4 (every other frame; halves again under motion),
resolve 3.7, reflect 4.8, hit shade 1.8, AO 1.3, scene draw ~5.

### 10.4 "Continue, we need better" — never black, and the transport BVH is not the render mesh (2026-09-02, late night)

**Never black (giScreen `createGiResolve` + `createGiFarFieldAvgPass`, GISystem).**
The far-field mean (the screen gather's EMA constant) existed only when the
detail box was armed, i.e. never in the BVH-only build; and the resolve used
it only by DISTANCE to the box. A pixel whose gather found no coverage (fresh
probe, newly revealed column, orphan bin) left the resolve at zero and hoped
the temporal filter found a valid neighbour. Now: the far-field pass runs in
the field-less build too (`[gi] far-field fallback armed` on Bistro), and the
resolve blends toward the constant by the MISSING coverage (`1 − known`),
with validity capped at 0.49 so a real neighbour still wins over the constant
in the filter. Receipt: the walk probe's motion steps fell from 0.018 / 0.035
to **0.009 / 0.010** (smaller transients on the same legs). Gauge: the pass
counts gather-covered geometry pixels at ≤ 0.001 luminance and publishes the
share as `profile.giPasses → srcProbes.farField.darkFrac` (2×1 texture, stats
in texel 1 — the readback blit forces alpha to 1, so it cannot ride in alpha).
Live value on Bistro is owed with the harness idle.

**The transport BVH is not the render mesh (`staticBvhSimplify.js`).** Meshes
that only the diffuse and shadow paths look at are simplified with
meshoptimizer's edge-collapse (already in the tree for virtual geometry):
1 cm ABSOLUTE error, borders LOCKED (adjacent meshes never open a crack — a
crack is a leak), 25 % floor, ≥ 5000 triangles. Kept exact: materials whose
static roughness is below the exact-reflection cut-off (0.45) and any
texture-driven roughness (a per-pixel roughness may be mirror-like
somewhere), plus placements without a mesh. The simplified index references
the original vertices, so UVs survive; the disk cache digests the inputs, so a
simplified build has its own artifact. Bistro receipt: **2 827 910 → 1 618 720
triangles, 146.9 → 84.3 MB, host 226.8 → 132.8 MB**, built in 3.6 s. Only
43 % went because 114 of 120 Bistro materials are texture-driven roughness and
stay exact under the safe rule; a floor-based rule (the §16 R4 roughness-map
floors, once resolved) is the next lever.

**Receipts (harness idle, the user's camera MOVING on a wider view — 396
draws, 61 184 rays, cap lifted by tracking):** `shade + bounce` 20.35 ms =
**333 ns/ray** (was 444 at 33 k rays), `deposit trace` 12.44 ms = **203 ns/ray**
(was 272): −25 % per ray from a 43 % smaller BVH. Emitter shadow 10.95 (full-
pixel measure; the live frame runs the checkerboard under motion), reflect
5.3, resolve 1.4. `farField.darkFrac` **0.000** over 722 k covered pixels —
no gather-covered geometry pixel at or below 0.001 luminance on a moving
view. Merge: orphan rate 5.1 % (was 11–14 %), resolvedRate 0.996 (was
0.73–0.79). Frame under motion: 15 fps / GPU 55 ms — the world runs every
frame at 30 Hz with the cap lifted; that lift (to OFF, unbounded per probe)
is the next measured cut. Gates on the simplified build: smoke both arms,
hit-shade rig ALL PASS (0.388 / 0.389, ×1.675), walk 0.015 / 0.012,
reflection probes ALL PASS.

**Bounded cap lift (same night):** the tracking / light-window lift set the
per-probe cap to OFF (0x3fffffff); it is now 2× the tier cap (64 at ultra;
`__giSrcCapLiftFactor`, Infinity = old). Convergence probe t90 **10.07 s**
(baseline 10.1–10.25), walk 0.010 / 0.019, settle95 ~4.0 s — no regression.
Live under the user's camera motion on an interior view (harness idle):
14 fps / GPU 60 ms: shade 26.0, trace 13.7 (74 k rays, every frame at 30 Hz),
emitter shadow 18.9 (checkerboarded), reflect 15.3, resolve 4.4. The moving
interior frame is the next target: the reflect prepass and the world chain
both run every frame there.

### 10.5 The blue patches were the parent's sky through a wall (2026-09-03, 00:00)

**The user's clue:** sky lighting off made the patches black; on, they turned
BLUE — and they appear on every surface the camera turns onto. Blue = the
sky's radiance, delivered where no sky is visible. The merge skips a bin with
no deposit (`selfT < 0` returns), so this is not missing data; it is a
resolved chain whose parent corners sit OUTDOORS: the merge interpolates a
child probe over its 8 parent-cascade corners with no line-of-sight test in
the BVH build (`losSuppressed 0` in every profile — the §15 U3b cross-wall
march existed only as an opt-in over the occupancy pyramid), and the fresh-
probe seed then copies that parent's merged bins (sky) into every newly
created probe. Indoors that is a wall-crossing light leak with the sky's hue.

**Shipped:** (1) `srcMerge` takes `losSegment` — one any-hit BVH segment from
the child probe to each parent corner — cached in ONE two-word record per
corner (key, visibility) and recomputed only when that corner's parent block
or the child key changes, so it costs rays only for fresh probes; ON by
default in the BVH build (`__giMergeLos = false` reverts). The first cut used
two records and pushed the merge kernels to 9 storage buffers, over the
portable limit of 8 — folded. (2) `srcSeed` applies the same segment to its
parent and to its spatial fallback, and declines a parent behind a wall
(`seed.los` in `readStats`); the probe then converges from its own rays
under the far-field fill. Gates on the merge build: smoke both arms, walk
0.015 / 0.025, gather-LOS suite ALL PASS, convergence t90 10.38 s (baseline
10.1–10.25). Seed-gate build gates running. Live `merge.losRate` and the
user's own capture of the artifact are owed — the MCP screenshot renders a
fresh frame and does not show the transient (three views read clean).

**The user's capture (00:00:46, sky off):** soft, irregular BLACK blobs one to
three metres across, splattered over the facades, the roof and the street the
camera had just turned onto — the shape trilinear interpolation makes when
some probes among lit ones hold ~zero radiance. Two things make them: the
seed prior (the parent's merged bins — sky-dominated for roofs and facades:
blue with the sky on, black with it off) written at `SEED_RAYS` = 6, i.e. six
rays' weight, which at stride 12 (a deposit per bin every ~16 frames) takes
~100 frames of the probe's own hits to outweigh; and the far, stride-bound
fresh probes that get one or two rays a frame. Shipped: `SEED_RAYS` 6 → 1
(the first own hit weighs as much as the prior). The segment test's margins
matter too: 2 cm at both ends cut in-room parent corners whose lattice point
sits inside a wall slab and doubled the convergence rig's rest noise (3.5 →
4.2 % with the merge test, 6.3 % with the seed gate); the segment now samples
the middle 80 % as U3b's march did. Receipts for that build: convergence
rest noise **3.48 %** (baseline 3.5), t90 **10.20 s** (baseline 10.1–10.25), walk
settle95 4.0 s, maxStep 0.017 / 0.044, patch0 1.99 / 1.31.

**The second capture (00:08:48) showed the blobs unchanged, and their
placement named the third mechanism:** they sit on facades and the street at
1–3 m scale. A thin facade puts four of a pixel's eight trilinear corners
INSIDE the building; the gather's back-side probe weight (§14 Q9c, signed
plane distance, lattice-silent) existed but `gatherNormalWeightExp()` returned
0 unless a global armed it — so interior probes, black with the sky off, were
interpolated into the wall at full weight. Now ON by default (exponent 2;
`__giGatherNormalWeight = false` reverts). One opt-in flipped at a time, as
the standing rule says; the two LOS tests are the others this night.
Gates on that build: smoke both arms, walk patch0 1.61 / 1.20, convergence rest
noise 3.15 %, t90 10.33 s. The user's third look: still there.

**The capture that narrows it (00:40):** a batched move-and-shoot through the
editor API (setCamera, setCamera, screenshot in one round trip) returns the
FIRST frame after an in-editor rotation, and it is clean: sharp GI, no blobs,
sky off. Every capture of mine renders at a different size, which resizes the
GI targets and resets the irradiance temporal history; the user's viewport
carries that history across frames. The one path my captures never exercise
is `createGiIrradianceTemporalPass` under rotation: reprojection, and where
the history is invalid, `validityAlpha` neighbour adoption smeared for ~10
frames — a wrong adoption is a blob that returns on every turn. The retention
audit found the cache intact (retained blocks are frozen by the hold stamp;
bins below MIN_WEIGHT only for out-of-reach probes). A/B: `__giIrrTemporal =
false` via the new `profile.giFlag` op once the MCP bridge is back.

**Third capture (00:31:11), read closely:** the dark patches on the SHADED
facade carry the facade's own features — awning and balcony shapes —
displaced and blurred, and the sunlit facade opposite is clean. Sky off, so
that facade is lit by GI alone: the only terms that can darken it are the
resolve's irradiance (temporal filter output) and AO. GTAO has no history
and is exact per frame, so it cannot depend on rotation. A screen-space
history reprojected onto a rotated view and blended at weight ~0.9 produces
exactly displaced, blurred copies of the previous view's dark regions that
persist ~10 frames — and continuous turning keeps regenerating them.
`__giIrrTemporal` is read at screen-chain creation: neither `requestRebuild`
nor a render-scale bounce re-reads it (measured: `irrTemporalPass` still in
the queue after both), so `profile.giFlag` now persists flags in
`gi.devFlags.v1` and GISystem applies them at import (DEV only); the A/B
needs a reload.

### 10.6 The blobs are the coarse shells' ROOM PROBES — the plane weight's tolerance scaled with spacing (2026-09-03, 01:00)

**Excluded by the user's eyes, one at a time:** AO off (still there),
reflections off (still there), the irradiance temporal filter off and
confirmed absent from the frame queue (still there). Then the "indirect"
debug view (00:37): the blobs are IN the gathered irradiance target — soft,
1–3 m, on roofs, facades and the street, anchored to the surfaces. So the
temporal-history theory of 10.5 is dead, and the claim that "a capture
never shows them" was a capture-size artefact: a `viewport_screenshot` at
the viewport's OWN size (1580×836, no resize) shows them plainly (01:49, the
first frame at the user's street pose — grey-blue smudges between the left
facade's upper windows).

**The mechanism, from the gather's own weight:** §14 Q9c's one-sided plane
weight fades a corner probe to its floor once it sits deeper than
`0.35 · spacing` behind the shaded surface's tangent plane. At c0 (0.35 m)
that is 12 cm — a wall. But a facade twenty metres away is gathered from the
c2/c3 shells, and there 0.35·s is 0.5–1 m: the corners in the ROOM behind
the facade vote at ~0.8 weight (pd = −0.2 m at c3: t = 0.8, w = 0.8²). On
the exact BVH transport those probes are honestly black (a closed room, no
sky, the shadow ray blocked by a real wall; the same for the attic under a
roof and the probes under the street), so every coarse cell whose behind-
corners land in a room paints one blob the size of that cell. The field
build never showed them because its probes behind a wall were LIT — by the
leak through the wall this transport closed (srcTrace's quarter-cell self-
bias stepped a buried probe out of its own voxel). Why "when I turn onto a
surface": the probes converge to black over ~1–2 s of their own rays and are
retained; a resize or rebuild re-seeds them bright for a moment.

**Shipped:** `gatherPlaneDepth()` in srcMath — the fade depth is
`min(0.35 · s, 0.15 m)`: unchanged at c0, a wall's thickness at every shell
above it; still a function of the signed plane distance alone, so a flat
wall's corner weights stay constants (Q9c's lattice-silence argument
holds). `__giGatherPlaneDepth` = metres, `false` = uncapped; live pin
`__giGatherPlaneDepthLive` for a one-boot A/B. GPU gather, CPU mirror
(`srcRef`) and both inlined call sites (hit shade, glossy) read the one
reader. Gate: `test:gi-src-gather` ALL PASS (1168 points, worst 0.44 % of
peak, furnace exact, coverage worth 55 %). Live parked at the courtyard
pose: 61 fps, `staticHeldFrames` 85/85.

**What the plane test cannot see (the residual, named so it is not
re-diagnosed):** corners that are on the pixel's side of ITS plane but behind
ANOTHER surface — concave junctions (a wall pixel near the street gathers the
c0 corners under the street; a facade pixel near a courtyard corner gathers
corners inside the neighbouring wing), and probes inside props (a parked car,
a planter) for pixels on the ground beside them. Only line-of-sight answers
those. Per-pixel BVH any-hit ×8 corners at gather resolution is ~8 M rays a
frame — not a candidate. The two designs: (a) DDGI-style per-probe DEPTH
(mean t, t² per octahedral texel; Chebyshev weight at the gather — the
standard answer, one extra tap per corner, but a second atlas and the
deposit/merge/seed/mirror all carry the moments — a day), (b) a per-probe
adjacency mask (which of its 8 surrounding cells' centres the probe can see,
one any-hit each at probe rate, reused by the gather as a per-corner bit —
cheap, but binary per cell, so the boundary quality needs a rig). Decide
with the user's verdict on this build.

### 10.7 The black patches were PROBE STARVATION, and the engine had been logging it (2026-09-03, 02:00)

**The receipt was in the console the whole time**, printed unconditionally by
`#pollSrcPools` because these are "the two failures that are silent on screen":

    [gi] src probes: cascade 0 dropped 10774 inserts (32768/32768 probes,
    load 0.50) - raise the probe capacity or s0; those probes simply do not exist

And `GISystem.js`'s grow ladder already wrote the symptom, on 2026-08-17, in
the user's own words: *"patches appear on surfaces that were not initially in
the camera frustum... A probe whose insert is refused IS NEVER CREATED, so
newly-revealed geometry does not converge slowly, it stays black forever while
probes for the original view hold every slot. Rotating back and forth walks the
artifact around the scene."* That is the 2026-09-03 complaint verbatim, and it
explains the one clue that killed every geometric theory: it lands on walls,
roofs, street and props EQUALLY, because a hash pool has no opinion about
surface orientation.

**Two independent shortages, both live on the user's Bistro:**

| bound | have | want |
|---|---|---|
| c0 hash slots | 32 768 | ~43 500 during a street walk |
| c0 bin blocks | 21 875 | 22 246 live at REST, thousands more moving |

The block bound is structural: `blockCapacities` splits `BIN_BUDGET` (2.8 M
bins, ~101 MB at 9 words/bin, against a 128 MiB single-binding limit) EQUALLY
across four cascades, so c0 gets `2 800 000 / 4 / 32` = 21 875 blocks, full
stop. A probe with a slot but no block holds no accumulators; a probe with
neither does not exist. Either way its corner is ABSENT, and a pixel whose
eight corners are all absent returns `known = false` and falls to the resolve's
far-field constant - black with the sky off, sky-blue with it on, at probe-cell
scale, anchored to the surface. That is the artifact, exactly.

**⛔ RETRACTED: §10.6's diagnosis.** The coarse shells' plane-weight tolerance
(`0.35 x spacing` = ~1 m at c3) IS a real bug and the 0.15 m cap stays - the
CPU/GPU mirror gate passes and it cannot brighten a correct pixel - but it is
NOT what the user was seeing. The user refuted it in one sentence: "it appears
on all surfaces equally, on walls as well."

**Shipped - the coarse-cascade fallback (§10.7).** The screen gather now
carries a SECOND lattice: cascade 1, its own tile atlas
(`createSrcTileAtlas(..., { cascade: 1 })`) and a three-buffer direct block
lookup (`createSrcBlockLookupDirect` - the tail-backed one-buffer form is c0
only by construction and threw). Where c0 coverage is complete the blend is the
IDENTITY, so a healthy frame is byte-unchanged; where c0 is starved the pixel
reads c1 instead of the far-field constant. The blend is `mix(coarse, fine,
covTotal)` on the fine lattice's own measured coverage, so there is no edge
where a starved patch ends (R1). c1 covers the same volume with an eighth of
the probes (4187 live of 16384 slots on the same frame), so it is never the
one that starves, and one c1 probe survives if ANY of its eight child cells got
a slot. `__giGatherCoarseFallback = false` reverts.

Cost, measured live at 1493x919: tiles 0.71 -> 1.06 ms (the c1 bake is ~0.35 ms,
not the ~0.7 ms the equal bin-visit count predicts), gather 1.62 ms, 68 SRC
kernels (was 66), +2.8 MB atlas. Gates: `test:gi-src-gather` ALL PASS with
numbers identical to the pre-change run (the harness builds no coarse arm, so
the CPU twin cannot drift), `smoke:gi-gpu` PASS both arms at 8 storage buffers.

**⭐⭐ AND THE MEASUREMENT THAT REDIRECTS THE WHOLE PERFORMANCE EFFORT.**
`__giLod0ReachScale = 0.6` (LOD 0's reach 22.4 -> 13.4 m) cut c0 live 14 996 ->
10 345, a 31 % smaller lattice - and the SRC chain went UP, 27.1 -> 40.3 ms,
because `shadedHitsPerFrame` rose 41 968 -> 69 492. **The ray budget is GLOBAL
and gets redistributed: fewer probes means more rays each, so shrinking the
lattice buys no time at all.** Reverted.

So the two complaints have DIFFERENT levers and must stop being one project:

* **Probe count is a COVERAGE and MEMORY problem** (the black patches). Fixed
  by making starvation degrade to coarse light (shipped), and properly by
  allocating the bin budget to measured per-cascade demand instead of equal
  quarters - c3 holds 252 probes at 2048 bins each while c0 rations 32.
* **Frame time is a RAY problem.** [J] shade 20.3 ms + deposit trace 11.1 ms is
  ~78 % of the SRC chain and both are rays against a 2.8 M-triangle BVH8, plus
  `emitterShadowPass` at 6.8 ms. Nothing about probe allocation touches it.
  The levers are ray COUNT (cap, stride, maturity-based skipping), ray COST
  (the transport BVH simplification of §10.4), and the emitter shadow chain.

### 10.8 44 % of the biggest allocation was words nothing wrote (2026-09-03, 03:00)

**The user's read of §10.7 was the right one: "i also thought it is the memory
limit... then we need to manage memory smarter."** It is, and the smart move was
not to spend more.

**⛔ FIRST, A DEAD END, RECORDED SO IT IS NOT RE-PROPOSED.** §10.7 closed by
suggesting the bin budget be split by measured per-cascade demand instead of
equal quarters. Worked through against both a parked and a busy reading, it does
not pay and can even hurt. Bin demand per cascade at the parked pose is c0 480 k,
c1 536 k, c2 601 k, c3 703 k - within a few percent of the equal 700 k share,
because population quarters per cascade exactly as bins quadruple. That product
is the Radiance Cascades scaling and the equal split is its correct expression.
Weighting by demand would move budget AWAY from c0, which has the SMALLEST bin
demand of the four. The equal split is right; the BUDGET was the wall.

**⭐⭐⭐ WHAT WAS ACTUALLY IN THE BUFFER.** A bin is nine u32 words. Five carry
rgb + clear weight + total weight, which every build writes. Four -
`BIN_SR/SG/SB` (§12.82's sun transfer) and `BIN_SN` (its packed hit normal) -
exist only for the SUN SPLIT, and the sun split is OPT-IN. Every boot has been
printing it: `src §12.82 sun split: OFF (default - arm with __giSrcSunSplit =
true)`. Both ends are JS build-time guards on that one flag - `srcSecondary`'s
`if (sunTransfer)` writes them, `srcDeposit`'s resolve `if (sunClose)` reads them
- so on the default path four words per bin were allocated, cleared, decayed and
never once carried a value. On Bistro that is **44.8 MB of a 100.8 MB `scratch`
buffer**, in the single allocation that is up against the 128 MiB storage-buffer
binding limit, while cascade 0 refused 10 774 probe inserts a frame for want of
blocks.

**Shipped.** `BIN_WORDS` moved to srcConfig and follows the build:
`sunSplitArmed() ? 9 : 5`. srcConfig owns it because srcConfig owns `BIN_BUDGET`,
which is derived from it - a budget computed from a layout it does not know is
exactly the duplicated-hierarchy-knowledge leak that file's header warns about.
srcDeposit re-exports it so all twelve consumers are unchanged.
`createSrcBinStore` THROWS if a build asks for the sun words against a 5-word
layout, so the layout and its two guards cannot drift apart silently (a
cross-bin read would otherwise be silent corruption).

The freed bytes are spent on probes, not returned: `BIN_BUDGET` is
`sunSplitArmed() ? 2_800_000 : 4_500_000`, deliberately short of the arithmetic
maximum (~5.04 M) so [J]'s hit list, which rides the same buffer at ~25 MB, keeps
its headroom and the existing throw stays a backstop.

**Measured live, before -> after:**

| | before | after |
|---|---|---|
| c0 bin blocks | 21 875 | **35 156** (+61 %) |
| c0 probe slots | 32 768 | 65 536 |
| SRC store | 192.5 MB | 220.2 MB |
| failed inserts, parked | 0 | 0 |

The slot pools doubled on their own: the grow ladder refuses to grow slots past
what the bin pool can back (`Math.min(blockBacked, ...)`), so raising the blocks
released a growth it had been correctly holding. Against a walk demand of
~43 500, 35 156 backed blocks plus §10.7's coarse fallback covers the starvation
from both ends. Parked at the user's street pose afterwards: 30 fps at 2112x1300
(2.75 Mpx, 1.75x the resolution every earlier fps number in this document was
taken at), GPU 20.4 ms, `staticHeldFrames` 1084.

Gates: `test:gi-src-deposit` ALL PASS (bit-exact against the CPU mirror,
including the STARVED and RETIREMENT arms - free stacks still a permutation, no
double-free, no leak), `test:gi-src-gather` ALL PASS, `smoke:gi-gpu` PASS both
arms at 8 storage buffers.

**⛔⛔ AND A HARNESS RULE THAT COST A FALSE ALARM.** Running the harness vite
(port 5201, `vite.base.config.mjs`) while the EDITOR's vite is live on 1420
clobbers the shared `node_modules/.vite` dep cache. The editor then reloaded into
a mixed module graph and threw `TypeError: trace is not a function` at
srcTrace.js:129 plus a spurious `cascade 2 dropped 1272 inserts`, neither of
which had anything to do with the change under test. Killing the leftover vite
and reloading cleared both. `gi19-worktree-setup` recorded the same trap for
concurrent worktrees; it applies to the EDITOR too. One vite at a time, and
`TaskStop` on the npm wrapper does NOT kill the child - check the port.

## 11. PROBE MEMORY: WHERE THE BYTES ARE, WHY THE CAP EXISTS, AND THE PLAN (2026-09-03, morning)

The user: "memory limit causing many dead probes that appear black as we
rotate the camera; our brute force approach to the spatial problem seems to
tank performance anyway; reduce memory usage while keeping quality."

### 11.1 The ledger, read live (Bistro, ultra, 1495x981 resolve, parked)

`profile.giPasses` + `profile.textures` + the boot line, same session:

| what | bytes | how it is sized |
|---|---|---|
| bin store `scratch` (accumulators) | 4.5 M bins x 5 u32 = 90 MB (+ 25 MB [J] hit list + block stats in the same buffer) | `BIN_BUDGET` = 4.5 M, split equally over 4 cascades: c0 35 156 / c1 8 789 / c2 2 197 / c3 549 blocks |
| bin store `payload` (resolved rgb + T) | 4.5 M x 4 f32 = 72 MB | same |
| tile atlases (c0 + c1 coarse fallback) | 17.3 + 4.3 MB rgba16f | per BLOCK capacity |
| hash / probe table / free stack | ~6 MB | slot capacities 65 536 / 32 768 / 16 384 / 8 192 |
| **SRC store total** | **220 MB** | |
| static BVH8 + dyn pool (scene host) | 105 MB | 1.19 M simplified tris, 28-word nodes, 9-word tris + 3-word half UVs |
| GI screen targets at 1495x981 | ~150 MB of 219 MB render targets | screen-proportional (irradiance/raw/hist/gather/radiance ~15 MB each, `giIrradianceHistPos` 30 MB RGBA32F) |

A bin is 36 bytes: five u32 accumulators (R, G, B, clear weight, count —
`atomicAdd` targets, so they must stay u32) and four f32 resolved words. The
accumulators cannot be packed: a steady-state sum is `influx/(1-keep)` and a
near-camera bin under the 32-ray cap reaches ~1600 rays x 1024 fixed point, far
past 16 bits; a 16:16 pack would carry silently into its neighbour.

### 11.2 The cap is a portable-baseline artifact on this machine

`BIN_BUDGET` (4.5 M) and `createSrcBinStore`'s `maxBytes` (128 MiB) exist to
keep ONE storage binding under WebGPU's portable default. This adapter
advertises `maxStorageBuffer 2047MB` and the engine already asks for 1 GiB
(`[engine] webgpu adapter ok — limits ask: maxStorageBufferBindingSize
1073741824`), and `GISystem` already reads `device.limits` for the field
buffer's degrade ladder. The SRC store never looks at either: on desktop the
budget that starves cascade 0 is self-imposed.

What the cap does on a sweep: c0 gets 35 156 blocks against ~43 500 wanted on
a street walk; the retention valve (`createAgePass`, `highWater` 0.85 of
min(slots, blocks)) starts shortening the off-screen hold at 29 900 live and
floors it at 8 frames by 34 100. So on a 360-degree turn the probes behind the
camera are RETIRED while the ones in front are born; turning back re-mints
them cold. In a scene with no sky light (Bistro: "every photon comes from a
lamp and ONE bounce") a cold probe's seed is its parent's answer, which in a
shadowed street is honestly near-black, and its own evidence arrives at the
deposit rate below. That is "dead probes appear black as we rotate": not a
dropped insert (0 failed at rest since §10.8), a VALVE at the block ceiling.

### 11.3 "Brute force spatial" is 3 ms; rays are 29 ms

Per world dispatch (36.1 ms, runs at 15 Hz at rest):

| group | ms |
|---|---|
| shade + bounce [J] | 18.6 |
| deposit trace + attribute | 10.4 |
| gtao | 2.5 |
| gather (8 hash finds + 8 tile taps per pixel, x2 lattices) | 1.7 |
| deposit resolve / decay (whole-pool sweeps, live-word gated) | 0.77 / 0.61 |
| populate (1.47 M per-pixel CAS inserts + 4-cascade ladder, 18 dispatches) | 0.43 |
| tiles / merge / rays / seed / hashBlock | 0.41 / 0.41 / 0.17 / 0.04 / 0.01 |

The hash map, the per-pixel population, the compaction and every pool sweep
together are 2.9 ms. The 52 908 rays are 29 ms — ~550 ns per ray, about four
BVH8 descents each (closest hit, sun any-hit, NEE any-hit, the bounce gather)
against 1.19 M triangles. Separately, `emitterShadowPass` is 16.5 ms per
screen frame (493x323, four seats, any-hit march; every other frame at rest).
Frame: 26 fps / GPU 26.2 ms. The spatial STRUCTURE is not the cost; the
spatial VISIBILITY (full-detail BVH for every interval of every ray) is.

Convergence of a freshly revealed region is deposit-starved by the same
budget: 52.9 k rays per dispatch at 15 Hz over ~1.5 M live bins is one ray
per bin every ~2 s (a c3 probe's 2048 bins need ~20 dispatches for one ray
each). Probe count and frame time are different projects (§10.7); this section
is the probe-count one.

### 11.4 The plan — half the store, full coverage, no valve

**A1. f16 payload.** `PAYLOAD_WORDS` 4 f32 -> 2 u32 of packed halfs
(`pack2x16float` in a `wgslFn` island, the module's own pattern): rgb + T in
8 bytes. 36 -> 28 B/bin (−22 %). The tile atlas is already rgba16f, so the
screen path loses nothing; the merge product of four T's and the 32-bin bake
average round unbiased at ~0.05 % relative, far under the 3 %/pixel/frame gate.
`PAYLOAD_UNKNOWN` (−1) is exact in f16. Sites: srcDeposit resolve (write),
srcMerge (17), srcSeed (8), srcTiles (4), `srcRef`'s twin and the gate
readbacks (`gi-src-deposit/merge/tiles/temporal.html`) unpack on the CPU.

**A2. Device-scaled ceiling.** `BIN_BUDGET` stays the PORTABLE ceiling and
becomes the floor of a function of `min(maxStorageBufferBindingSize,
maxBufferSize)` read from the device at build (the `deviceLimit` GISystem
already computes): scratch at 5 words + the hit list must fit one binding, the
payload at 2 words its own. 128 MiB -> ~5.0 M bins (MORE than today at fewer
bytes, because the payload halved); 1 GiB -> a 16 M ceiling the ladder grows
toward ON DEMAND only (per-scene persistence already skips the climb). The
sweeps dispatch over the pool and are live-word gated: 0.6 ms at 4.5 M ->
~2 ms at 16 M, and a scene only reaches what it asks for.

**A3. Per-cascade PEAK demand, not max x 4.** The ladder today sizes the
budget as `max over cascades of (live + noBlock) x binCount x 4` and
`blockCapacities` splits it equally, so a walk's c0 demand (43.5 k x 32 =
1.39 M) forces 5.6 M bins even though c1..c3 want ~0.5 / 0.9 / 1.0 M. Keep a
per-cascade running PEAK of `(live + noBlock)` across the session (persisted
with the pools), and let `blockCapacities` take an explicit per-cascade block
vector sized from those peaks x 1.3 headroom, falling back to the equal split
where nothing has been measured. This is NOT §10.8's dead end: that
proposal redistributed a FIXED total by a parked SNAPSHOT (which does move
budget away from c0); this sizes each cascade from its own measured peak and
lets the total be the sum. Under equal demand it IS the equal split.

**Expected on Bistro (A1 + A2 + A3), walk demand:** c0 1.39 M + c1 ~0.5 M +
c2 ~0.9 M + c3 ~1.0 M ≈ 3.8 M bins x 28 B ≈ 106 MB + ~25 MB tiles + tables
≈ **135 MB (today 220 MB, still starving)**, c0 backed to ~45 k blocks with
headroom, the valve never trips on a sweep, retention (1800 f) holds the whole
street, and rotating back lands on WARM probes. Scratch at 3.8 M x 5 words +
25 MB = 101 MB, so even a 128 MiB device covers this walk. c1..c3 walk peaks
are estimates from the rest reading; the ladder measures them.

**Gates:** `test:gi-src-deposit` (bit-exact against the mirror, STARVED +
RETIREMENT arms), `test:gi-src-merge`, `test:gi-src-tiles`,
`test:gi-src-gather`, `test:gi-src-temporal`, `smoke:gi-gpu` both arms at 8
storage buffers (portable pin), the walk probe (`run-gi-walk-patches`) for 0
dropped inserts and 0 deposit noBlock across a 360-degree sweep, and the
boot line's MB for the ledger.

**Not in this unit, named so it is not lost:** the screen targets (~150 MB;
`giIrradianceHistPos` RGBA32F alone is 30 MB — several could be rgba16f),
the BVH8 node format (28 words; a quantized 8-wide node is ~80 B and
traverses faster), and the ray levers: a COARSE transport BVH for the c2/c3
intervals (meshopt at 10–20 cm error instead of 1 cm; long rays do not need
centimetres), the sun at hits from the frozen shadow map (one descent of
four), and the 16.5 ms emitter shadow pass. Those are the frame-time project.

### 11.5 Shipped: the packed payload, the device ceiling, the peak-demand ladder (2026-09-03, morning → midday)

**A1, the f16 payload.** `PAYLOAD_WORDS` is 2 (srcConfig owns it beside
`BIN_WORDS`; srcDeposit re-exports it), word 0 = `pack2x16float(r, g)`, word 1
= `pack2x16float(b, T)`. The kernels reach it only through `readPayload` /
`readPayloadT` / `writePayload` / `writePayloadUnknown` (srcDeposit.js); the
CPU side through `decodePayload` / `encodePayload` / `payloadQuantize` /
`payloadUlp`, backed by a pure-JS binary16 codec in srcMath.js
(`floatToHalfBits` RTNE, `halfBitsToFloat`, `packHalf2`, `unpackHalf2`,
`halfUlp`) because the bare-Node mirror may not import three. The bin store
also exposes `decodePayload` so the live-editor probes (`run-gi-darkpocket-
probe`, `run-gi-probe-density`, `run-gi-colour-bleed`) decode without an
import. The buffer is initialized UNKNOWN (T = −1), not zero — a zero word is a
KNOWN black bin, and with the resolve skipping dead blocks (the live word) a
never-claimed block used to read as known black to anything that reached it
(the c3 sky composite counted 5.6 M such bins on Bistro; the f32 layout had the
same hole).

⭐ **MEASURED: this driver's `pack2x16float` rounds TOWARD ZERO.** The
temporal gate read a pass-through transmittance of exactly 1 − 2^-11 where
round-to-nearest-even gives 1. WGSL leaves the narrowing mode to the
implementation, so every gate that diffs a packed GPU word against a CPU value
allows one binary16 ulp (`payloadUlp`), and the merge gate allows one ulp PER
LEVEL CROSSED (`N − c`: the mirror merges the ladder in f64 with no intermediate
rounding, the kernel rounds every level it writes; measured worst 2.34 ulps at
c0 against the 4 allowed). The temporal gate's steady-state arm now measures
the ACCUMULATOR (`R · Lmax / count`, the resolve's own formula) and checks the
payload against it separately (worst 1.000 ulp) — folding a second, larger
quantization into a rounding-interval prediction would have failed the "errors
cancel" check on a constant signal, where every bin rounds the same way.

Gates, all PASS after the change: `test:gi-src-deposit` (bit-exact, STARVED +
RETIREMENT arms, unknown-vs-resolved over the whole buffer), `test:gi-src-merge`
(sky arm to a half-ulp, merged field 2.34/4 ulps, PREAVG, MONOTONE, ORPHANS
byte-identical, FURNACE 0.000 ulp), `test:gi-src-tiles` (unchanged: the atlas was
already rgba16f, k/256 fields are exact halves), `test:gi-src-gather`,
`test:gi-src-temporal`, `smoke:gi-gpu` both arms at storage 8.

**A2, the device ceiling.** `srcBinCeiling({ deviceLimitBytes, reserveBytes })`
in srcConfig: the most bins whose scratch (BIN_WORDS + the hit list + the block
statistics, `reserveBytes`) fits one binding and whose payload fits its own,
capped at `BIN_CEILING_MAX` = 16 M. `createSrcProbeSystem({ deviceLimit })`
takes `min(maxStorageBufferBindingSize, maxBufferSize)` from GISystem
(`#deviceStorageLimit`), sizes `createSrcBinStore({ maxBytes })` with it,
clamps a persisted block vector under it (a uniform scale, logged), and
publishes `poolCeilings()` for the ladder. The boot line now says
`(device ceiling 16.0M bins at 1024MB per binding)`; a portable 128 MiB device
reads ~5.2 M — MORE than the old 4.5 M, because the payload halved.

**A3, the peak-demand ladder.** Pools are `{ c0Probes, binBudget, blocks[4],
peaks[4] }` under the prefs key `gi.srcPools3.<scene>` (the old key held only
a bin budget the equal split then spread over four cascades — on Bistro
exactly the 4.5 M this unit exists to stop paying — so it is not read).
`blockVectorFromPeaks` (srcConfig) sizes each cascade from its own running peak
of `live + noBlock` × headroom (1.5 where the ceiling is ≥ 8 M bins, 1.3 near
it), rounded up to a growth quantum (1024 >> c), floored at the equal split of
the boot floor, capped by its slots, and the sum scaled under the device
ceiling. Two guards that a live read forced the same hour:

* ⛔ **THE LADDER IS MONOTONE**: cascade k's demand is bounded by cascade
  k−1's (every c(k) probe is a c(k−1) probe's parent). Bistro's first read said
  c3 wanted 2147 against c2's 507 — a `noBlock` transient on the 85-block floor
  — and allocated 2816 c3 blocks = 5.8 M of a 6.7 M-bin store for 113 live
  probes (the store read 218 MB). Bounded, the same peaks give 768.
* **A valve-pressed cascade asks for at least double.** `live` under the
  retention valve (≥ 75 % of blocks) UNDER-reads demand — the shed pins it just
  under the pool — so a 1.3×-of-live rung converged in five rebuilds where a
  doubling converges in log₂; the old ladder doubled for the same reason.
  `starvedBlocks` (live > 75 % of blocks) is now a grow trigger beside
  `noBlock`, so the ladder grows BEFORE the valve trips — the valve IS the
  black-on-rotate mechanism (§11.2), waiting for a refused claim was too late.

⭐⭐ **THE POOL-GROW REBUILD LOST THE BVH TRANSPORT.** `setSize`'s re-create
forwarded every construction arg except `bvhTrace` (added in §10 after the
"EVERY create arg forwards" note was written), so on a field-less scene the
rebuilt deposit was built over `volume.occupancyField` (null) and died at
build with `KERNEL BUILD/DISPATCH FAILED for src:deposit … trace is not a
function` — the SAME line the memory files attribute to the harness-vite
mixed-graph trap, which is why the first live sighting (09:11, the user's
Bistro) was misread as HMR. It hid because persisted pools skipped the grow on
every scene that had ever grown; the Level walk on a fresh harness hit it on
the ladder's first rung. Fixed by forwarding `bvhTrace`. Rule: when a
"forward every arg" list exists, a new arg must be added to it in the same
commit that adds the arg.

**Live Bistro after the fix (ultra, 1280×981, same parked pose):** boot at the
floors, one ladder grow 8 s later — `blocks 5468/1367/341/85 →
11264/3072/768/256 (0.70M → 1.67M bins; peaks 4926/1338/507/141)` — store
**89.8 MB** (was 220.2 MB at the equal split of 4.5 M), c0 backed 2.3× over its
live count, no valve pressure, every kernel rebuilt (a §12.56 watchdog re-roll
while the harness walk held the driver, then live). The sweep receipt is §11.6.

### 11.6 The 360° sweep receipt (2026-09-03, 09:20)

Driven over MCP on the user's live Bistro (ultra, 1280×981): the parked
street pose, then eight 45° yaw steps of the look target around the same eye
position, 4 s each, then back. Read through `profile.giPasses` and the
console.

| | before (§10.8 build, parked) | after the sweep |
|---|---|---|
| SRC store | 220.2 MB (4.5 M bins, equal split, c0 35 156 blocks) | **136.2 MB** (3.28 M bins, blocks 16384 / 7168 / 1536 / 512) |
| c0 backing vs peak demand | 35 156 vs ~43 500 on a walk (starved; valve at 29 900) | 16 384 vs 9 498 seen on this sweep (1.7×, no valve pressure) |
| ladder rebuilds during the sweep | — | 2 (`11264/3072/768/256 → 11264/3584/1536/512 → 16384/7168/1536/512`) |
| dropped inserts | 0 parked / 10 774 on the 09-03 walk | **0** (no `dropped … inserts` line, `failedInserts 0` at every cascade) |
| peaks persisted (`gi.srcPools3.Bistro`) | — | c0 9 498 / c1 2 875 / c2 810 / c3 232 |

What the sweep shows: (1) at this pose the whole 360° needs ~9.5 k cascade-0
probes, not the 35 k the equal split was carrying — the old store was paying
for cascades 2 and 3 (`2197 × 512` and `549 × 2048` bins) that the sweep never
filled past 810 and 232 probes; (2) the ladder's rungs now double on valve
pressure, so a sweep costs two rebuilds, and the next boot of this scene
starts at the persisted vector and pays none; (3) the walk demand of ~43.5 k
c0 probes measured in §10.7 will still be reached on a street WALK — the
c0 slot pool (16 384) grows to 32 768 and 65 536 as `live` crosses 75 % of it,
and blocks follow — so the fully-walked Bistro store will land near 5–6 M bins
≈ 170–190 MB at 28 B/bin: the SAME bytes the 4.5 M equal split cost, backing
every probe the walk wants instead of 35 k of them. The §11.4 estimate of
135 MB assumed lower c2/c3 walk peaks than the sweep measured; the ladder is
the instrument now, and the boot line prints the answer per scene.

Cost of a rebuild, for the record: the probe store swaps cold (B2 keeps every
screen history), the SRC kernels recompile in the background (the first
rebuild's `src:gather#1` / `populate` pipelines took a §12.56 watchdog re-roll
because the harness walk held the driver at the same moment; the second
compiled clean), and the irradiance temporal filter carries the picture
across. Persisting the peaks is what makes that a per-scene, not per-boot,
cost.

`probe:gi-walk` on the Level (high, 485×242, TELEM=1): the ladder's first rung
(`5468/1367/341/85 → 5468/1367/512/256`) rebuilt CLEANLY — the deposit kernel
that died with `trace is not a function` before the `bvhTrace` forward now
builds — and both legs ran to the end with the grown store. Verdict mode
(maxStep, the per-tile step between consecutive pinned frames): with the
pools pre-sized (,
the walk script's own recipe for skipping the harness rung) **leg 0 0.0145,
leg 1 0.0225** — the 09-02 baseline read 0.012 / 0.027, so the packed payload
and the new ladder leave the walk clean. Without pre-sizing the ladder's
first rung lands 38 s in, mid-leg, and the cold store swap reads as maxStep
0.97 on that leg — the known harness artifact (the walk script documents the
FLAGS pin for exactly this), not a lighting change; a persisted-pools boot
never pays it.

### 11.7 The rebuild storm, and the picture held across a swap (2026-09-03, midday)

**The user, an hour after §11.6 shipped:** "it takes enormous time to boot,
like 2 minutes until GI shows up. When the camera moves, GI just drops, and
for another minute or two I see just some ambient light, after which another
freeze follows. FPS is good only when we don't move; moving it drops to 15–20.
Importantly, black patches are almost completely gone."

**What the console said, same hour.** The user walked Bistro. The ladder
rebuilt the probe store FOUR times in four minutes — 09:32:50, 09:33:54,
09:34:26, 09:36:28 — one per cascade crossing 75 % of its blocks (c1, then c2,
then c1 again, then c3 on its own at 802 of 1024), ending at
`65536/28672/6144/2048` blocks = 13.1 M bins, 4.2 M of them in 2048 c3 blocks
for 802 live probes. Each rebuild is a cold store plus a recompile of the 68
SRC kernels, and while the new gather has not landed the resolve reads
`known = false` and blends to the far-field constant: that IS the "ambient
light". The boot's material wave in that boot took 59.7 s against 2.9 s in a
quiet one — the harness Chrome (this session's gates and walks) was compiling
on the same driver, which is the memory's "THE HARNESS SHARES THE GPU" rule
arriving as a boot time. Moving at 15–20 fps predates today: at rest the
world dispatch runs at 15 Hz, moving it runs every frame at ~36 ms beside the
16.5 ms emitter shadow pass (§11.3); the probe change did not touch it.

**Shipped, four changes to the ladder and one to the resolve:**

1. **A desktop boot floor.** Where the device ceiling is ≥ 8 M bins the
   pools boot at 2.8 M bins / 32 768 c0 slots (c0 21 875 / 5 468 / 1 367 / 341
   blocks, ~78 MB) instead of the portable 700 k. A Bistro-class scene boots
   without a rung; the portable floor is unchanged.
2. **Per-cascade headroom** (`BLOCK_HEADROOM` = 2.0 / 1.5 / 1.25 / 1.25) in
   place of the uniform doubling: cascade 0 is the visible lattice at 32 bins a
   probe and doubles; cascade 3 is 2 048 bins a probe, bounded by the level
   below, and gets a quarter.
3. **Only cascades 0 and 1 trigger the 75 % early warning** (the lattices the
   screen reads — c1 is the §10.7 coarse fallback). c2/c3 grow on a refused
   claim or ride along with a rebuild, sized from their peaks.
4. **One rebuild a minute at most**, unless the hash is refusing inserts;
   and when the blocks a rebuild wants would sit past 75 % of the slots, the
   slots double in the SAME rebuild (the walk paid one rebuild for blocks up
   to the slot cap and another ten seconds later for the slots).
5. **The picture is held across the swap.** `#rebuildSrcProbesForPools` arms
   `_srcSwapHold`; the irradiance temporal filter's weight is pinned at 0.98
   (reprojected, world-validated history — the right picture to keep) until
   the NEW store's gather has landed 12 unskipped dispatches or 20 s have
   passed (a wedged pipeline must not freeze the frame forever); the release
   is logged. Disoccluded pixels see the cold store; everything else keeps
   yesterday's light while the kernels compile.

Persisted pools moved to `gi.srcPools4.<scene>` (then `srcPools5`, below) so the doubling-inflated
Bistro vector (13.1 M bins) is not restored; the walk re-learns under the
leaner headroom.

**What this cannot change, said plainly.** A fully walked Bistro at ultra
wants ~41 k / 16 k / 3 k / 0.8 k probes — 6.5 M bins with ZERO headroom, 182 MB
at 28 B plus ~30 MB of tiles. That is the same order as the old 220 MB store,
which was starving at 35 k. The per-probe bytes fell 22 %; the coverage the
user asked for costs what it costs, and the honest number for the walked
scene is ~230–260 MB with the headroom above. Smaller or half-walked scenes
land far under it (the parked street pose: 90 MB).

**⭐⭐⭐ AND THE RUNAWAY UNDERNEATH IT (09:50, the first boot with the fixes
above).** One rebuild at boot (c0 16 809 live of 21 875 blocks → 44032/7680/
2048/640, slots 65 536), then 25 s later the console filled with

    [gi] src probes: cascade 0 dropped 16809 inserts (65536/65536 probes, load 0.50)
    [gi] src probes: cascade 1 dropped 4960 inserts (32768/32768 probes …)
    [gi] src probes: cascade 2 dropped 1438 inserts (16384/16384 probes …)

— every slot of every cascade FULL, every visible insert refused, and the
ladder reading that as demand (`peaks … 20901/32768/…`) and doubling the
slots again. The picture hold had released after ZERO gathers (its 20 s
deadline; the rebuilt kernels take ~30 s to land here).

The mechanism is the dispatch path, not the pools. `srcProbes.js`'s header:
"every gap between two passes is a barrier … the order IS the algorithm". A
compute whose pipeline is still compiling is a silent no-op in the async
pipeline path, and the engine skips PER NODE — so for the ~30 s after a
rebuild the population chain ran WITH HOLES: INSERT and COMPACT landed while
the hash CLEAR and the four AGE passes were still pending, nothing cleared,
nothing retired, and every cell the moving camera touched stayed forever.
That is the original §10.7 starvation signature, produced by any rebuild or
boot whose kernels land out of order — and it is why the old ladder's rungs
were followed by "black patches" that the memory files attributed to the
budget.

**Shipped:** the SRC world chain dispatches as ONE UNIT. While any pass in it
is unbuilt or pending, only those nodes are dispatched (which is what kicks
their build and compile); every ready pass is registered as skipped and none
executes. The chain runs its first real frame only when all of it has
landed. The swap hold's deadline is 90 s (it still releases on the 12th
gather). Persisted pools moved once more, to `gi.srcPools5.<scene>`, so the
runaway's peaks (c1 32 768 = every slot) are not restored.

**Receipt, the first boot with all of §11.7 (09:54, harness idle):** material
wave 2.8 s; `field first pass dispatched 2924 ms after build`; `first diffuse
gather dispatched 3012 ms after build`; ONE pool grow 8 s later at a high
street-overview pose (c0 16 809 live of 21 875 → `44032/7680/2048/640`, slots
65 536, 4.75 M bins) with `picture released after 12 gathers of the new store`
1.8 s after the swap; no `dropped … inserts` line; `profile.giPasses` a minute
later: c0 16 809 / c1 4 960 / c2 1 438 / c3 404 live, `failedInserts 0` at every
cascade, tiles lit 1.08 M, store 197.7 MB at that pose (the overview sees
three times the probes the parked street pose did). 43 fps parked.

### 11.8 The swap compiles behind the live store (2026-09-03, 10:20)

**The user, after §11.7:** "it boots faster now, but screen-space GI freezes
at some point as I move the camera — it gets frozen in some camera pose and
stays that way after the camera moves forward — and black patches can still be
seen when moving. And it lags very hard on camera movement: it says 30 fps,
on movement it feels like 5–10."

**The console (10:12–10:14):** two ladder rebuilds during the walk, and in each
the rebuilt kernels took 22–23 s to land (`src:populate#1 pending 22.6s …
driver quiet 22.2s — re-rolling`, then `picture released after 12 gathers`
26 s and 23 s after the swap). The picture hold of §11.7 pinned the
irradiance history at 0.98 for those 23 s: reprojected, so it does not follow
the camera into disoccluded pixels — THAT is "frozen in one pose". After the
release the store was cold (every probe fresh, every bin empty): the black
patches. The two bridges (far-field constant, pinned history) were symptoms of
the same hole — a live screen reading a store nothing could write for as long
as the driver took to compile 63 kernels.

**Shipped: the swap is prepared, then committed.** `setSize(…, { deferDispose:
true })` (srcSystem) builds the next system without disposing the live one;
`#prepareSrcPoolSwap` stores it as `_srcPendingSwap`; every tick
`#stepSrcPoolSwap` dispatches ONLY its unbuilt or pending nodes (the dispatch
that creates a pipeline is a no-op until it lands, and a landed node is never
dispatched again before the commit — the §11.7 runaway's lesson, applied to
the cold store: nothing executes against it early); the live store keeps
updating the picture meanwhile. When every kernel has landed (or at a 120 s
deadline) `#commitSrcPoolSwap` runs the old body — the store, the gather
closures, the resolve and hit-shade rebuild + splice, AO and glossy re-arm —
retires the old system (`retireFor`: dispose + reparent the gizmos), queues
the new store's CPU mirrors for detach (they were never detached on this path:
the JS heap read 1.3 → 2.2 GB across two rebuilds), and holds the history for
a dozen gathers of the now-hot store (5 s cap). The ladder does not grow while
a swap is pending. What remains visible at a commit is the resolve's own
recompile (its texture holds its last frame) and the cold field converging —
seconds, with the seed prior, not tens of seconds with nothing.

**Not addressed here, said plainly:** the movement judder. Moving, the world
dispatch runs every frame at ~36 ms beside the 16.5 ms emitter shadow pass,
and the slow-frame rule alternates the world half on and off below 30 fps —
63 ms / 27 ms frames read as "30 fps that feels like 10". That is the ray
budget (§11.3), the same lever list as before, and a separate unit. The
whole-pool sweeps grew with the pool (decay + resolve over 9.6 M threads,
tiles over 88 k blocks) — live-word gated, but worth a measurement in that
unit. The cold field after a commit is the last piece of "black when I move";
migrating the old store's probes and bins into the new buffers (a per-cascade
copy kernel; ~12 bindings, desktop only) would remove it and is the next unit
if the deferred swap alone does not read clean.

### 11.9 Frame time outranks convergence while the camera moves (2026-09-03, 10:30)

**The user's screenshot (13:26 local): FPS 11, CPU 15.9 ms, GPU 87.1 ms**,
walking the Bistro street. Two things in that number. (1) It was taken while
this session's harness Chrome ran a Level walk on the same GPU — "THE HARNESS
SHARES THE GPU" doubles every BVH kernel in the editor (§10.3 measured 61–77
vs 34 ms for the same pose), so part of the 87 is contention and the harness
was stopped. (2) The uncontended walking frame is still ~50 ms: the world
dispatch runs EVERY frame under motion at ~35 ms (82 k rays × ~420 ns — the
rest cadence's camera term holds the FULL ray budget for 600 ms after every
move so revealed probes fill fast) beside the 17 ms emitter-shadow chain,
which only halves its rate on movers-only frames.

The project's rule is a 60 fps floor above everything (memory: "TOP PRIORITY
under ANY conditions"), and the temporal filters already argue that a moving
image masks the noise the rays average. So, uniform-only, no rebuild:

* **`setMotionRayScale(k)`** on the SRC system multiplies the ray ceiling
  (through the stride) and the per-probe cap; GISystem feeds it
  `1 − (1 − floor) × camEma` from the same camera EMA the temporal filters
  read, `floor` = `__giSrcMotionRayScale` (0.35; `false` or 1 = off). The
  rest cadence's own hold restores the full budget within ~20 frames of the
  camera stopping — exactly when convergence can be seen again.
* **The emitter-shadow and hit chains take the half-rate cadence under
  camera motion** (`camEma > 0.5`, `__giMotionHalfRate = false` reverts), the
  same stride the movers-only frames already use; their history passes
  reproject across the skipped frame; the checkerboard is off while the
  stride is on, as on movers-only frames.

Expected on the walking frame: world ~35 → ~12 ms per dispatch, emitter
shadows 17 → ~8.5 ms average; the rest (reflections, resolve, GTAO, the scene
draw ~10 ms) is untouched. That is not 60 fps on Bistro at ultra; it is the
cheap half. The expensive half is the per-ray cost (a coarse transport BVH for
the c2/c3 intervals, the sun at hits from the shadow map) and the emitter
shadow march itself — the §11.3 list, unchanged.

### 11.10 The sun at hits from the shadow map (2026-09-03, 10:45) — efficiency item 1 of 5

**The user: "let's think how we could make it more efficient — importance
sampling, or some other technique." Then: "do that in order."** The order
(§11.9's list): (1) sun visibility at hits from the shadow map, (2) emitter
shadows one seat per pixel per frame, (3) nearest-probe bounce gather at the
hit, (4) a coarse transport BVH for the far intervals, (5) probe-driven,
need-weighted ray allocation — the real importance sampling, bias-free here
because a bin's value is the conditional mean of the rays that land in it.

**Where a hit's time goes today (Bistro ultra):** trace + deposit 153 ns/ray,
shade + bounce 274 ns/hit = three BVH8 descents (closest hit, one sun any-hit,
one NEE any-hit — the light tree already draws a single importance-weighted
pick) plus an 8-probe gather for the bounce. The emitter-shadow pass fires four
any-hit rays per pixel at 160 k pixels — ~640 k rays a frame, as many as the
transport.

**Shipped (1):** the directional light's rendered shadow map answers the sun
at hits. `LightComponent` publishes `userData.giShadowMaps()` — the CSM
cascades near → far when CSM is on (the parent light's own map is never
rendered under CSM; shadowFreeze.js), else the light's shadow; empty for
lights the GI module traces itself. GISystem builds a `sunShadow` bundle
beside the light slots (up to 4 cascades: matrix, bias, normalBias, map size
as uniforms; texture nodes whose `.value` is swapped per frame from
`shadow.map.depthTexture` — a re-render or a CSM re-split never rebuilds a
kernel; `count` 0 = trace everything) and threads it through
`#buildScreenResolve` → `lighting.sunShadow` → `createSrcHitLighting`. In the
slot loop the mapped slot's visibility is three's own shadow coordinate
replicated exactly — `M × (P + n·normalBias)`, `/w`, y flipped, `z ± bias` by
the depth convention — read with `textureLoad` (a comparison sampler is
fragment-only) and compared with the sampler's own sense (LessEqual, or
GreaterEqual under reversed depth); first containing cascade wins; a hit
outside every cascade traces as before; `shadowRays` counts only rays that
fired. Frozen maps (`shadow.autoUpdate = false`) are exactly what the
transport wants: they re-render when the light moves (ShadowFreeze folds the
light matrix into its key) and hold otherwise. `__giSunShadowMap = false`
restores the any-hit ray for every slot.

What it does not cover: lights flagged Shadow Source "gi" (the module traces
those), point/spot lights (their shadow rays are bounded and few), and the
exact-reflection hit shade (`bvhHitShade`, ~2 ms — its own sun ray stays).

**Receipt (10:44, harness idle, the street overview pose):** the boot prints
`[gi] src sun visibility at hits: SHADOW MAP (1 cascade, 4096px, slot 0)`; no
kernel error; `shade + bounce [J]` **22.6 → 17.3 ms** for the same 83 k hits
(−23 %), trace + deposit unchanged at ~13 ms. The walked-Bistro pools restored
from `srcPools5` (`88064/17408/4352/1152`, peaks 48 784 / 12 711 / 3 371 / 913 —
the user walked further than the sweep) put the store at 313 MB this boot.

### 11.11 Emitter shadows: one seat per pixel per frame (2026-09-03, 11:00) — efficiency item 2 of 5

**The cost:** the emitter-shadow pass marched every one of a pixel's (tile-cut)
seats every frame — four any-hit BVH descents per pixel at 544×288 ≈ 630 k rays
a frame on the user's Bistro, as many as the whole transport, read at
3.7–17 ms by pose (9.85 ms at the street overview). Its raw was DETERMINISTIC
(the §14 Q7 area jitter and the 09-02 pixel checkerboard are both parked
behind `__giEmitterAreaSample`), so the temporal chain behind it — filter
(+history, weight 0.9, variance clip) → accum → history → post filter →
wide₁ → wide₂ — was blending identical values.

**Shipped:** the pass marches ONE seat per pixel per dispatch,
`k = (x + 2·y + phase) mod liveSeats`, on a 2×2-complete lattice: every 2×2
block of the grid carries every live seat every frame, every 3×3 window
carries each of them at least once. A one-lamp tile marches its lamp every
frame (mod the LIVE count, which the cut's by-id sort puts first — an empty
seat never receives the pixel's sample). The seats it did not march are
written as a **−1 sentinel** (raw target promoted to rgba16f; empty seats
keep the load-bearing 1 / width 0). `createGiLightShadowFilterPass` in its
new `sparse` mode reconstructs them: the bilateral's weights are PER
CHANNEL (a tap contributes to a seat only where it carries a sample there),
the variance clip uses the same per-channel moments, and a channel with no
same-frame evidence in the 21-tap diamond holds validated history, else 1.
The analytic width rides the same way — `emitterShadowDist` is sparse, the
filter fills `emitterShadowDistFill` by NEAREST valid same-plane tap (not a
mean: the width channel doubles as the occupancy mask, "lit, 0" vs
"contact, ≥ 1 mm", and a mean would dilute one with the other), and the wide
passes read the filled texture. The phase uniform advances once per
DISPATCH of the pass (in the chain-ran bookkeeping) — per frame it would
pair with the movers-only stride-2 cadence into a lattice that only ever
visits two of the four seats at a pixel. The chain's history then
integrates the lattice across frames exactly as it was built to integrate
the checkerboard. `__giEmitterSeatRotate = false` (build-time) restores the
four-seat march and the dense raw.

**Receipt (11:00, the same street overview pose, 4 seats, 38 tree
emitters):** `emitterShadowPass` **9.85 → 1.56 ms**, the sparse filter
0.23 ms (was ~0.2), the wide passes unchanged at 0.08 ms each; the console
prints the seat line; no kernel error; screen chain 3.3 ms total. More than
the 4× the arithmetic promises because the lattice is reduced mod the LIVE
count and most street tiles see fewer than four lamps.

**What to watch (the §14 Q7 lesson):** where history is invalid — a moving
occluder's silhouette, a disocclusion — the unmarched seats come from the
same-frame 2×2 reconstruction, so a hard shadow edge can wobble by ±1
emitter-grid texel frame to frame there until history returns. That is a
deterministic neighbour, not the jitter's speckle, and the 0.9 history
damps it everywhere else; the flicker probe at a held pose and the user's
walk are the judges. `scripts/run-blackframe-dispatchcensus.mjs` reads the
raw back as rgba8 and now reads a half-float texture — a diagnostic, not a
gate; retarget if it is ever needed again.

**Gate:** `npm run test:gi-emitter-seat-sparse` (scripts/gi-emitter-seat-sparse.html)
runs the SHIPPING filter on a synthetic gbuffer in both modes over the same
field and diffs them: the lattice's 2×2/3×3 completeness (CPU), no sentinel
leak, an empty seat stays exactly 1, smooth channels within 0.04 of the dense
filter, the hard edge exact away from the edge, an ISLAND pixel (no same-plane
neighbour) holds 1 without history and its validated HISTORY with one — the
arm that caught the variance clip crushing an evidence-less channel's history
to 0 (mean 0, σ 0) before it shipped; the clip now applies only where the
neighbourhood spoke — the width fill exactly {0, 0.2} across a half-plane
(nearest, never a mean), and the 0.9 history blend.

### 11.12 Item 3 REFUTED by measurement — the bounce gather is not a lever (2026-09-03, 11:10)

The plan's item 3 was "nearest-probe bounce gather at the hit instead of the
8-corner trilinear" — [J]'s `gather.gatherAt(P, n)` is 16 hash finds + 16
atlas taps per hit (two LOD shells × 8 corners, plus the §10.7 coarse arm when
the fine lattice is starved). Before redesigning it the share was measured
with the build-time hatch, POSE-LOCKED (another session was driving this
editor's camera between readings — the pose is set immediately before each
profile and read back after it; both agreed):

| build | [J] shade + bounce | hits |
|---|---|---|
| bounce ON (default) | 12.85 ms | 70 460 |
| `__giSrcSecondary = false` (single bounce, console confirms) | 13.19 ms | 70 468 |

The gather is inside the noise. 1.1 M scattered 4-byte reads are microseconds
on this GPU; [J]'s time is the BVH8 descents (the NEE any-hit, and the sun
ray for hits outside the shadow map) and the light loop. Nothing to win here;
the kernel stays as it is. The order continues with item 4 (the far-interval
coarse BVH — the deposit trace at 11.7–12.2 ms and [J]'s remaining descents
are the whole SRC cost) and item 5 (need-weighted ray allocation — the only
lever on the RAY COUNT, which every other number is proportional to).

### 11.13 The far duty — need-weighted allocation, the interval half (2026-09-03, 11:30) — items 4 and 5, re-ordered by measurement

**The measurement that re-ordered the list.** Before building item 4's
coarse far-interval BVH, its ceiling was read with a build-time instrument
(`__giSrcReachCascade = k` caps every ray at cascade k's far bound; the
capped intervals read as sky), pose-locked at the street overview:

| rays reach | deposit (trace + attribute) | shade + bounce [J] | shaded hits |
|---|---|---|---|
| cascade 3 (47.6 m at LOD 0, the default) | 12.2 ms | 12.85 ms | 70.5 k |
| cascade 1 (2.8 m at LOD 0) | 5.93 ms | 4.92 ms | (the far ones gone) |

The far intervals (c2 + c3, beyond 2.8 m at the pixel's LOD 0 — the bounds
are `r0·(4^(c+1)−1)/3` with r0 = 0.56 m: 0.56 / 2.8 / 11.8 / 47.6 m) are
**14 of the transport's 25 ms**, and 8 of those 14 are [J] SHADING the far
hits (60 % of the shaded hits land past 2.8 m at this pose). A coarse BVH
only makes the far TRACE cheaper, and "beyond 2.8 m" is no place for 15 cm
geometry; the lever that touches both halves is the RAY COUNT that goes far
— item 5, applied at the interval level. Item 4 is deferred until the far
trace is measured again after this unit (§11.12's note).

**Shipped — the far duty.** In the deposit kernel each ray draws lowbias32
over (its R2 index ⊕ frame stamp · φ⁻¹) → [0, 1); below the `farDuty`
uniform it traces to the ladder's reach as before, otherwise it stops at
cascade `farFrom − 1`'s far bound (farFrom = 2: it traces c0 + c1 only) and
deposits into cascades ≤ farFrom − 1 alone — the far bins it did not sample
receive neither a count nor an all-clear (`ownReach = min(own, reachC)` on
the scatter; a capped miss is a miss through c0..c1 only). The duty is a
LIVE uniform: 0.25 at rest, 0.5 in motion (the camera's sustained-motion
root or an open light window), `__giSrcFarDuty` / `__giSrcFarDutyMotion` /
`__giSrcFarFrom` retune, `__giSrcFarDuty = false` removes the arm
(build-time, kernel byte-identical — the deposit gate's classic arms
prove it).

**Two things the first reading taught (11:27, four minutes at rest):** the
merge's `resolvedRate` slid 0.93 → 0.86 → 0.78 and the orphans rose — the
far bins were LOSING known bins. The §12.40.4 influx compensation could not
hold them: the influx word is written on the RAY side (srcRays.js, the
per-probe cap's own accounting) and never sees the far cut, so the far
cascades decayed at the full rate on a quarter of the inflow. Two fixes,
both shipped: (1) the decay pass gives a far cascade the base keep
`1 − (1−keep)·duty` — the same identity the cap compensation uses, applied
to the BASE so the surprise relax composes on it — which holds the far
bins' effective sample counts exactly; (2) a NEED FLOOR in the ray: the two
far bins in the ray's direction are read (two atomic loads; the bin is a
function of the direction, the block of the pixel's chain) and a count
below `farNeed = 4` rays forces the ray's far intervals whatever the duty —
a fresh far block fills at the full rate, and a bin whose count sags refills
long before the resolve's `MIN_WEIGHT` (1/64 of a ray) can turn it UNKNOWN.
The attribution tally also had to learn the difference between a capped
miss and a miss of the scene (`STAT_CAPPED_MISS`; `unattributedRate` drops
it from both terms — it had jumped 14 → 49 % for no physical reason).

**Receipt (11:24, pose-locked, before the two fixes, 25 % duty):**
deposit **12.2 → 7.87 ms**, [J] **12.85 → 7.36 ms**, SRC total **31.4 →
20.9 ms**; `farRayRate` 25.4 % — exactly the arithmetic (near + 0.25·far).

**The floor's own lesson (11:45):** at `farNeed = 4` the floor never released — `farRayRate` held 60 % three minutes after boot (deposit 10.2 ms, [J] 9.7 ms). The far cascades hold ~1.2 M bins (c2 1107 × 512, c3 317 × 2048) against ~70 k rays a frame, so most far bins cannot accumulate four decayed samples at any window and stay forced for good. At **1 ray** a bin is released the moment it is KNOWN — which is the floor's whole job (MIN_WEIGHT is 1/64 of that). `__giSrcFarNeed` retunes; 0 disables.

**The histogram (12:15, `__giProfileBinHistogram = true` — a new opt-in
readout in `profile.giPasses`; the harness could not boot Bistro for a
standalone probe, its tab died in the build):** bin COUNT in rays over live
blocks, Bistro ultra —

| cascade | bins | = 0 | < 1 | 1–4 | 4–16 | > 16 | mean of sampled |
|---|---|---|---|---|---|---|---|
| c0 | 823 k | 24 % | 12 % | 12 % | 21 % | 30 % | 45.7 |
| c1 | 877 k | 41 % | 25 % | 9 % | 11 % | 15 % | 28.6 |
| c2 | 956 k | 53 % | 14 % | 12 % | 10 % | 10 % | 22.5 |
| c3 | 1.04 M | 71 % | 11 % | 10 % | 5 % | 3 % | 8.9 |

Even c1, which the duty never touches, is 41 % empty and 25 % below one
ray: the lattice's bins outnumber the rays by an order of magnitude and a far
probe fed by a few distant pixels spreads them over 512–2048 directions. A
one-ray floor therefore forced 35 % of ALL rays permanently (60 % far in
total). The floor's job is narrower: fill UNKNOWN bins and keep known ones
above the resolve's MIN_WEIGHT (1/64 ray) — so `farNeed = 1/32` now, a 2×
margin over that line; at the compensated far keep a single sample holds
above it for thousands of frames, and at rest a bin releases at its FIRST
sample.

**NEAR FIRST, THEN FAR — the form that ships (12:40 → 13:00).** Even at 1/32
ray the floor still forced 29 % of all rays, and the histogram said why: a
far bin in a direction the NEAR geometry blocks can never receive a sample —
the forced ray hits at a metre and deposits nothing far — so it stays
unknown and forces its rays for good. The duty is now drawn AFTER the near
trace: every ray traces cascades 0..farFrom−1 as a segment bounded by its
own tMax; only a ray that CLEARED them consults the stratum and the floor,
and traces the far intervals as a second segment [nearBound, reach] of the
same ray. One call site of the descent inside a two-iteration GPU loop
(§13.14.5's law holds; the deposit kernel compiles as before), and the
trace closures gained an optional `tMinWorld` and a declared
`trace.fields` list — a TSL loop body is built at SHADER build, after the
surrounding JS has run, so the result vars must be declared before it from
the closure's declared shape (the first draft captured the shape inside the
body and read null; the gate caught it before the editor did — no, the
editor had it for one reload, spamming a TypeError per frame). `STAT_FAR`
now counts far TRAVERSALS (near-cleared rays that went on), `STAT_FAR_NEED`
those the floor forced, `STAT_CAPPED_MISS` near-cleared rays that stopped.

**Receipt (13:02, the street overview, pose-locked and at rest — the same
13 149 / 3 819 / 1 107 / 317 live probes as the baseline):**

| pass | baseline | far duty, near-first |
|---|---|---|
| deposit (trace + attribute) | 12.2 ms | **7.59 ms** |
| shade + bounce [J] | 12.85 ms | **8.75 ms** |
| SRC total | 31.4 ms | **22.8 ms** |

`farRayRate` 28 % (far traversals over all rays), `farNeedRate` 12.6 %,
`resolvedRate` 0.984, `orphanLive` 847, `unattributedRate` 5.4 % (the
corrected tally). The histogram at rest: c0 21 % empty, c3 66 % empty — the
lattice's inherent angular sparsity, unchanged by the duty.

**Gate:** `test:gi-src-deposit` gained a FAR DUTY arm — the shipping
kernel at duty 0.5 / farFrom 2 / stamp 7 on a fresh bin store against the
CPU mirror (`srcRef.js`'s `farDutyHash` + `traceAndDeposit`'s cap):
every probe's count / T / RGB bit-exact, the same 2109 far rays, the same
1718 capped misses, cascades 0–1 receive every deposit they did without
the duty (4216/3992), cascades 2–3 exactly half (0.501/0.504). The need
floor is pinned to 0 there (a single-frame mirror over empty bins cannot
model live counts); its instrument is the live `resolvedRate`.

### 11.14 "The character is so bright vs the path tracer" — the multibounce loop over-delivers (2026-09-03, 14:40)

**The user's two screen captures (Sponza, the corridor, GI vs the in-editor
path tracer) measured region by region in linear light:** directly sunlit
surfaces agree (the sunlit strip 1.17, the lit curtain 0.99) and every
bounce-lit surface is 1.75–2.7× brighter in the GI (shadowed floor 1.75 /
1.92 / 2.74 — rising with distance from the camera —, blue banner 2.56,
flower pot 2.56, ceiling vault 1.79). The character's material is
`Alpha_Body_MAT`: colour #ffffff, roughness 1, metalness 0, no map — an
albedo of exactly 1.0 — so a 2× indirect excess clips it to white while the
stone at ~0.1 only looks lifted. The character is not the bug; the indirect
field is.

**Ruled out from code and receipts:** the character's material receives the
GI through the light node like every other lit material; three's IBL is
replaced by the black environment node while GI is live; the §11.10 shadow-map
visibility at hits matches three's ShadowNode line for line (frustum test, y
flip, z ± bias, LessEqual/GreaterEqual); the albedo atlas the bounce reads
is GPU-blitted WITH the graph tint (Sponza: 25 tiles, "0 textured" is only
the CPU census — the PNGs are not canvas-drawable in this project); the slot
palette's live mean albedo reads **0.125 / 0.107 / 0.088** (a new
`profile.giPasses` receipt: `paletteMeanAlbedo`, `slotAtlas`); Sponza
has no environment (sky 0 in both renderers); the GI component's intensity is
1 and `bounce: 1`.

**The A/B that found it (with the user's screenshot permission; pose-locked,
60 s settle per arm, the far-field mean = the screen gather's mean colour as
the numeric gauge):**

| arm | far-field mean (rgb8) | atlas mean lum | look |
|---|---|---|---|
| default | 102 / 100 / 96 | 0.371 | the user's bright corridor |
| `__giSrcSecondary = false` (first bounce only) | **34 / 32 / 29** | **0.136** | the path tracer's dark shadows, a grey shaded character |

The second-and-later bounces are **two thirds of the indirect light** in this
scene. With a mean bounce albedo of 0.12 (the floor perhaps 0.4) the loop
should add ~15–25 % over the first bounce, not 200 %. The §4.4 R4 loop
(`ρ_loop/π · E_atlas(H)` at every hit, the atlas being LAST frame's field) is
over-delivering by roughly 3×.

The other two arms, same pose and settle: `__giSunShadowMap = false` (the any-hit
sun ray back at every hit) **107 / 105 / 101**, atlas 0.383 — §11.10 is not a
contributor; `__giSrcFarDuty = false` **93 / 91 / 87**, atlas 0.335 — the far
duty reads ~10 % brighter than full reach, a small bias worth its own look but
not this. The bounce pass's own tallies (new `secondary` receipt in
`profile.giPasses`): 10 293 hits, **0 clamped, 0 overflow** — the loop does not
saturate at Lmax, it over-gains smoothly. ⚠ `viewport_screenshot` re-renders
through its own target and BYPASSES the path tracer's canvas blit — a
"screenshot of the PT view" is the GI frame again, pixel for pixel; the
reference has to be a screen capture.

**Where it most likely comes from (not yet proven):** the bounce gather at a
hit reads the lattice at the hit's CAMERA-DISTANCE LOD — a hit 10 m down the
corridor reads 1.4–2.8 m probes whose tiles average the sunlit strip and the
shadowed floor together, and every loop iteration re-injects that mixed
energy; §12.26.9 already recorded that "coarsening BRIGHTENS a feedback
loop", and the screenshot ratios rise with distance exactly so. The next
instrument: the bounce term's own magnitude at hits vs the rays' first-bounce
irradiance (`STAT_SEC_CLAMPED` is the saturation counter), and a hit-LOD
histogram of the bounce term.

### 11.15 THE SELF-WALL — the character lit itself through its own proxy (2026-09-03, 17:30) — FIXED

**§11.14's suspect (the camera-distance LOD lattice at hits) was wrong, and the
"cavity" idea before it was refuted by a blind instrument.** The per-hit-LOD
ledger showed every secondary hit at LOD 0, so the lattice could not be it.
Splitting the same ledger by *what was hit* (a new "mover" row, flagged in the
hit record as emitter `-2` — the shade only tests `0 ≤ emitter < n`) named
the source in one read, pose-locked, Sponza, the corridor:

| secondary hits | share | mean L_direct | mean L_bounce | mean E gathered | ρ_loop | bounce / direct |
|---|---|---|---|---|---|---|
| static | 96.4 % | 0.035 | 0.004 | 0.14 | 0.13 | 0.11 |
| **mover (the character's boxes)** | 3.6 % | 0.38 | **2.42** | **8.46** | 0.90 | **6.4** |

A hit on the character gathered **60×** the irradiance of a hit on the stone,
and its bounce term was six times its own sunlit direct term — the bounce at
those hits was worth more than the sun. That is a loop with gain ≈ 0.9, not
geometry.

**The mechanism.** The skinned proxies are fat OBBs (`boxMode` default; the
capsule arm is `__giSkinnedProxyShape = "capsule"`), and §14 Q2 already
recorded that "the receiver's true skin sits centimetres INSIDE the shell".
`traceDynBody`'s OBB branch takes `enter = max(tEnter, t0)` and admits the
hit when `tExit ≥ enter`: **a ray born inside the box hits it at `t = tMin`,
with the entry face's normal oriented against the ray** — indistinguishable
from a legitimate front face (the sphere intersector does the same on purpose,
`accept(tMin, -rdL)`, as the conservative shadow-ray semantics). The
transport called `dyn.trace(o, d, tMin, tMax, { objId: true })` with NO
`excludePoint`, unlike every shadow marcher in GISystem. So every transport
ray leaving a pixel on the character "hit" the character at t ≈ 0, [J] shaded
that hit as the mover (albedo #ffffff, R4-clamped 0.9) times the gather AT THE
ORIGIN — the character's own probes — and deposited it straight back into the
same probes with T = 0 below c0. E = E₀ + 0.9·E converges at 10·E₀: measured
8.46 against a first-bounce E₀ of ~0.85. The character then radiated ~sun-level
bounce into the shadowed floor, banners and vault around it — the 1.75–2.7× of
§11.14 — and clipped to white itself. Both §11.14 arms agree with this:
`__giSrcSecondary = false` cuts the loop, `__giSkinnedProxies = false` removes
the wall.

**Why the cavity instrument said 0.** §11.15's first cut carried an `inside`
bit from the raw normal (`nRaw·d > 0`), and `insideMoverRays` read 0 — which
was taken as a refutation. It could not see the case: the OBB entry face and the
sphere's inside branch both hand back a normal that FACES the ray. Blind
statistics (memory rule): a null from an instrument that cannot see its subject
is not a null.

**The fix (physical, no knob):** the transport ray, and the visibility ray from
a hit, pass `excludePoint: origin` — the same signed on-or-inside self-exclusion
(`slack = 0.15·r·scale`, floored at 3 cm) every shadow marcher already uses,
so a proxy that CONTAINS the ray's origin cannot occlude it; the next limb, the
floor under a foot, another rig still do. `srcBvhTrace.js` (both closures) and
`srcTrace.js` (the occupancy-marcher build). The `inside` bit is now honest
(OBB: `tEnter < t0`; analytic: `t ≤ t0` or the raw-normal test) so the
deposit's inside-drop guards the remaining case, a ray born inside a closed
exact-mesh adoptee.

**Receipts after the fix (§11.14's locked pose, ~2 min settle, rest
cadence):** mover hits **407 → 170** per frame (limb-to-limb and
floor-to-character only), mean E at mover hits **8.46 → 1.01**, mover
bounce / direct **6.4 → 0.81**, static hits' bounce / direct 0.11 → 0.29,
atlas peak lum **14–35 → 6.9**, far-field mean (`farField.rgb8`, §11.14's
gauge) **102 → 58 / 56 / 54** against the first-bounce-only arm's 34: the
loop now adds ~70 % over the first bounce in a corridor with a white figure
standing in the sun, not 200 %. At the reload's own camera (no character in
the sun) it read 36 / 34 / 31. The user, live: "looks correct now". Gates:
`test:gi-dynobj` PASS, `test:gi-skinned-proxy` 51 green,
`test:gi-src-temporal` PASS, `test:gi-src-deposit` PASS (the runners need a
vite on 5201 — `npx vite --port 5201 --strictPort` — they do not start one). New standing
receipts in `profile.giPasses`: `secondary.byLod[lod: "mover"]`,
`moverHits`, `moverRecords`, `insideMoverRays`.

**Left open:** the exact-reflection ray (`giScreen.js` `createGiBvhReflect`,
`dyn.trace(origin, R, 0, maxDistance, { objId: true })`) still has no
`excludePoint` — a glossy pixel on a mover reflects its own box; the character
is matte so nothing shows today, but a chrome character would mirror a white
wall at t = 0. Same one-line fix when it matters. The far duty's ~10 % bias
(§11.14) is now measurable without the wall.

### 11.16 "Patches flickering while they converge" on a walk-in / pan — the newborn-probe prior was NOT it; the transient is periodic in a STATIC scene (2026-09-03, evening)

**The user (after §11.15 landed): "whenever we rotate the camera, or enter a
new room, I see patches gradually flickering trying to converge to correct
lighting… too distracting to be used in an actual game."**

**Instrument repairs first (three, each of which had been feeding a wrong
number):**

1. `probe:gi-walk`'s no-blockout fallback path took the SCENE box's minimum
   y + 1.6 m as eye height: on Sponza a stray mesh 3.6 m below the floor put
   the walk at y = −2, under the floor — a null run that read err0 0 /
   maxStep 0.00008 with nothing fresh ever minted. Now the 10th-percentile
   mesh-box floor + 1.6 (`WALKY=` overrides). New arms: `ROTATE=<deg>`
   (a pan in place, `PIVOT=` the path point), `HIDE=<names>` (hide entities
   by name), and a per-pinned-frame SIGNALS trace (α, motion root, far duty,
   the light-track window, the shadow-motion term, the slide hold, the
   irradiance history weight) printed beside a per-frame tile-step trace.
2. srcSystem's `readStats` awaited its GPU readbacks one after another, and
   each await spans frames. The walk probe stops moving while it waits, so
   the population counters came from a moving frame ("fresh 51") and the
   seed's tally, three awaits later, from a parked one ("seed 0 probes"):
   the seed prior looked inert on Sponza for an hour. Every counter copy is
   now submitted in one tick and awaited together.
3. `FREEZE=1` also stops game time, which parks the day cycle at the boot's
   phase — on Sponza a low sun (mean luma 0.010 against 0.17–0.27 live).
   A frozen arm is a different lighting regime, not a control.

**What the seed really does at a walk frontier (one-frame readback, mid-walk):**
c0 fresh 52 / c1 17 / c2 7 / c3 5; seeded 24 probes, **52 cold** (the parent
born the same frame), 6 declined by the wall test, **0 spatial** — the LOD+1
spatial fallback can never fire inside LOD 0's reach (64 cells = 22 m at
s0 0.35: no LOD+1 probe exists there). Two thirds of the frontier converges
from zero in view.

**The far-field prior (built, measured, left OPT-IN — `__giSrcSeedFar = true`):**
a fresh bin with no parent/spatial source starts at the far-field mean
(raw texel (2,0) of the now 4×1 `giFarFieldAvg` texture) at 6 rays' weight;
the top cascade seeded for the first time. srcConfig's SEED_RAYS_FAR doc
carries the numbers: LIVE scene prior off / on maxStep 0.163, 0.232 / 0.164,
0.166 — no effect; FROZEN scene prior off err0 0.00033, maxStep 0.0019,
monotone / prior on err0 0.0108, a slow drift, settled picture 3.5× brighter
(a flat constant in far bins that see a ray every few frames is not handed
over for a minute, and it stands in for unknown far intervals the tiles used
to renormalise away). A same-LOD NEIGHBOUR prior is drafted (six axis
neighbours, alive/not-fresh/blocked/LOS, 1:1 bins) but NOT applied: the
measurements below say the newborn probes are not what the user sees.

**The transient, arm by arm (Sponza corridor walk-in, ultra, pinned pools,
leg 0, two runs each; err0 = mean |arrival − settled|, maxStep = the largest
one-frame tile step, curve = error every ~0.35 s):**

| arm | err0 | maxStep @ ms | curve shape | tail luma |
|---|---|---|---|---|
| live, character animating | 0.0076 / 0.0015 | 0.163 / 0.232 @ 186 / 437 | rises to ~0.024 at 1–1.5 s, dips, second peak at ~3 s | 0.256 / 0.211 |
| live + far prior | 0.0074 / 0.0068 | 0.164 / 0.166 @ 239 / 442 | same | 0.267 / 0.253 |
| **HIDE=Player** (no mover at all) | 0.0024 / 0.0016 | **0.192 / 0.218 @ 199 / 209** | **same ~2 s oscillation** | 0.212 / 0.212 |
| FREEZE (low sun, character pinned) | 0.00033 / 0.00034 | 0.0019 / 0.0018 | monotone | 0.010 |

So: the animated character is NOT the source (hiding it changes nothing);
the newborn probes are NOT the source (the prior changes nothing); the
transient is a **~2 s oscillation of the whole field after the camera stops,
with a ~90 %-of-mean tile pop ~200 ms after arrival, in a static scene with a
live sun** — and it is absent under a low sun. Two GI timers add to exactly
2.0 s: `ALPHA_TRACK_HOLD_MS` 1200 + `ALPHA_TRACK_REARM_MS` 800 (the §12.43
light-track window), and the light-settle envelope 1500 + 800 sits beside
them; the detail-box slide arms the same 1200 ms hold. SIGNALS trace: (see
the run ledger below).

**The first HIDE arm had hidden nothing** (`object3D.visible` is recomputed
every frame from the enabled flags; the heatmap still showed the figure). With
`setEnabledInEditor(false)` the same walk reads **err0 0.00074, maxStep
0.0018, monotone, per-frame tile steps 0** and the field's own signals over
the pinned burst are quiet: light-track window 0, shadow-motion 0, slide 0,
α at the camera-settle floor 0.05 for 0.6 s then 0.020, the irradiance
history weight back at 0.90 within 0.8 s. The pop map (per-tile max
one-frame step, `-steps.png`) with the character present puts every popping
tile — ~50 of 540, in every arm — on the figure at the left edge of the
frame: the statistic was measuring the walk cycle moving bright limbs across
dark background inside a tile, not GI. Arms that could not move it, two runs
each: `__giIrrTemporalClip` 100 (clip off) 0.201 / 0.217, no camera-settle
floor + no motion root 0.141 / 0.207, surprise gain 0 0.212 / 0.181. So on a
static Sponza at ultra with pinned pools, a walk into new surfaces converges
cleanly at arrival — **the harness does not contain the user's complaint**.

**Editor-side, same hour (the user's session, shared with another assistant
session, play mode ON, GI quality "high", sky light 0):** three full GI
rebuilds in five minutes — reasons `component-attached` ×2 and
`structural-props-changed` — each a cold field behind a 27 s compile wave
(`first diffuse gather dispatched 27658 ms after build`). A rebuild is the
biggest "patches converging" event there is, and none of those three was a
camera move. Then, at 15:41, the thing the harness cannot contain: **walking
Sponza grew the probe pools** (`c0Probes 32768→65536, blocks
21875/5468/1367/341 → 31744/6656/1536/384, 2.80M→3.44M bins; peaks
15447/4390/1074/263` — c1–c3 at 77–80 % of their blocks), the grown store's
68 kernels compiled behind the live one for **73 s** with the picture held
(`swapped to the prepared store after 73231 ms — every kernel landed`), and
the cold store took over (`picture released after 12 gathers`) — the whole
field re-converging in view. The content pipeline cache
(giComputePipelineCache) dedupes by WGSL text, so those 68 kernels are
byte-DIFFERENT after a grow: ~31 capacity/base literals (`uint(info.
probeCapacity)`, `binBase`, `hashCapacity`, …) are baked into the code.

**Shipped from this:** the desktop boot floor 2.8 M → 4.2 M bins / c0
65 536 (~115 MB): a Sponza-class walk no longer takes a rung. Bistro still
does. **§11.17 (proposed):** store capacities as uniforms (one geometry
block) so a grow is allocate + copy + rebind with NO recompile, and the live
content migrates instead of restarting cold.

### 11.17 THE STARVED PROBE — "patches of wrong lighting all over the dark corridors that don't resolve until I walk closer" (2026-09-03, late evening)

**The user's second capture (the end of a Sponza aisle, 15–20 m away):**
cell-sized patches of wrong brightness on the vault and the walls that take
too long to resolve, or never do until the camera approaches. Not the
walk-in transient (§11.16, clean), not the character (hidden), not a
rebuild: a probe that the camera sees but barely covers.

**Why, from the design:** rays are born per PIXEL ([D1]: `raysPerPixel`
rays at every pixel of the frame's stride residue, summed into the pixel's
c0 probe), so a probe's ray rate follows its screen footprint. In the
user's editor (878 k pixels, 125 k rays a frame, stride 14) a near probe
covering 400 pixels is capped at 16–25 rays a frame; a far-corridor probe
covering 20 pixels gets ~3 rays a frame across 32 direction bins — a bin
every 11 frames, a running mean of a handful of samples for the first ten
seconds, and at the still keep (0.9977) a steady state it reaches in ~1/α ≈
435 frames. Five times farther is twenty-five times slower. The
cold-frontier priority (§12.52) reserves one packet per frame for a probe
born within COLD_FILL_FRAMES = 4 — four frames — and nothing after that.

**The instrument (shipped, opt-in `__giProfileProbeRays = true`):**
`profile.giPasses` → `srcProbes.probeRays[]`: live c0 probes by LOD with
this frame's mean ray allotment and the share getting 0 / < 2 rays; the
walk probe prints it at MID-WALK / arrival / rest. First editor read (a
near courtyard view, fresh field): LOD 0, 1420 probes, mean 13.7 rays,
3.5 % with none.

**The floor (shipped, default on):** the priority pass now also admits any
VISIBLE c0 probe whose block has SEEN fewer than `STARVE_RAYS` (2000) rays —
the block's decayed `BIN_COUNT` summed over its 32 bins, i.e. the deposit's
own accumulator (≈ 435·r at the still keep for r rays a frame), not its
age — and gives it `STARVE_PACKETS` (2) packets a frame from the same
ceiling tickets: a probe under ~4.6 rays a frame is topped up toward it,
one under ~0.6 permanently, one the camera feeds never. The packet count rides the free upper bits of the
representative word (`PROBE_HASH = rep | packets << 22`; [D1] masks it) and
the representative pass claims one `raysPerPixel` slice per packet, so the
extra rays fire from the same pixel in successive ray slots (distinct
directions). At the still keep the accumulator's steady state is ≈ 1500·r
for r rays a frame, so 800 means "under half a ray a frame": every visible
probe is lifted to ≥ 4 rays a frame until it holds ~256 rays of evidence
(8 per bin), then hands its tickets back. `COUNTER_STARVED` (a new eleventh
counter word) counts the lifted probes; `profile.giPasses`
`cascades[0].starved`. Dials: `__giSrcStarvePackets` (0 = off arm),
`__giSrcStarveDeposits`; `__giSrcStarve = false` at build.

**First A/B (harness, Sponza corridor pose after a 30 s settle, Player
hidden, pinned pools, `STARVE_DEPOSITS` 800):** the ledger over LIVE c0
probes read mean 3.35 rays / 75.0 % zero with the floor off and 3.58 / 74.7 %
with it on, while the (then cumulative) starvation counter said ~700 probes
were lifted every frame. Two lessons: (1) the ledger must count VISIBLE
probes only — at rest most live probes are held off-screen by retention and
get no rays by design; (2) at 800 a lifted probe crosses the line in about
a second and drops out, so its sustained rate stayed ~0.5 rays a frame.
Shipped: visible-only ledger (`visible` beside `probes`), a per-frame
counter, and `STARVE_DEPOSITS` 3000 — a probe whose own pixels bring under
~2 rays a frame stays lifted at 4 (~700 probes × 4 ≈ 2 % of the ceiling at
that pose). Its A/B:

**The visible-only ledger then said the HARNESS is not starved at all**
(686×342, stride 2): 1292 of 4999 live c0 probes visible at rest, mean 13.2
rays a frame, 1.1 % with none. The editor is a different regime by the
STRIDE: the ray ceiling is fixed (131 k a frame) and 878 k pixels put the
stride at 14, so each pixel fires one frame in fourteen and a two-pixel
far-corridor probe goes dark 86 % of frames. `__giSrcTransportRays = 33500`
forces the harness to the same stride; that A/B is the one that counts:

| arm (stride 21 mid-walk / 8 at rest, Player hidden, pinned pools) | visible c0 probes with 0 rays: mid-walk / arrival / rest | mean rays a frame | lifted |
|---|---|---|---|
| floor OFF | **23.8 % / 15.5 % / 9.1 %** | 5.2 / 8.3 / 11.9 | 0 |
| floor ON, run 1 | 0.0 % / 0.1 % / 0.1 % | 7.9 / 10.8 / 13.5 | 1765 / 1284 / 536 |
| floor ON, run 2 | 0.3 % / 0.2 % / 0.0 % | 7.9 / 10.6 / 13.5 | 1777 / 1285 / 525 |

At rest the floor lifts 41 % of the visible probes (the under-fed ones; the
first, per-frame-sum cut lifted all 1292) for ~2.1 k rays ≈ 6 % of that
ceiling, and no visible probe is left without rays. The arrival statistics
(err0 ~0.001, maxStep ~0.003) do not move — the walk-in was never the
problem — and the cost at the harness's own stride is zero (nothing is
starved there). What this buys in the user's corridor is the far probes'
convergence time: a bin every ~8 frames instead of every ~100. The
remaining un-lifted starvation is spatial, not temporal: a probe the camera
never sees at all cannot be fed by any pixel — that is the retention hold,
by design.

**Receipt to watch in the editor:** `profile.giPasses` with
`__giProfileProbeRays = true` → `srcProbes.probeRays[0].zeroRayShare` over
VISIBLE probes (expect ≈ 0) and `cascades[0].starved` (the lifted count).

### 11.18 THE FROZEN GI IS THE BOOT, AND THE BOOT IS THE MATERIAL COMPILE QUEUE; the Cornell fidelity gap, measured (2026-09-03, night)

**"Quite often the frozen GI stuck on the screen" + "on the simplest scene,
Cornell, GI takes more than a minute to boot" — one event.** The Cornell
boot's console: `compile wave: materials warmed safely in 93780 ms` for SIX
material variants, then `first diffuse gather dispatched 94031 ms after
build`, and every compute pipeline landed at the same 93 s — `SLOWEST
PIPELINE #71 [aoFilterX] 93.0 s (13 kB, 0 loops)`, `emitterShadowHistoryPass
92.9 s (2 kB)`. A 2 kB kernel does not take 93 s to compile: it was QUEUED
behind a render pipeline that held the driver's compile queue for ~90 s.
Until the SRC kernels land the field cannot advance and the screen keeps the
last picture, reprojected — the ghost silhouettes of the capture. The wave
issues its pipelines concurrently (the `getForRender` interception collects
the promises), so the serialisation is the driver's. No dev pin was set
(`__giIrrHistWeight` null); the pool-swap hold is bounded to 5 s.

**Shipped: per-render-pipeline compile timing in the wave** — the summary
line `[gi] render pipelines: N compiled, slowest <material> <kB frag> <s>`
and `__giWaveRenderTimings`. The next boot names the 90 s shader; the fix
is its size (the reflection-probe sampler unroll was the last such giant:
327 → 91 kB) or splitting its variants, and capacities-as-uniforms (§11.17's
proposal) so the WGSL is cache-stable across scenes.

**The Cornell fidelity gap (the user's two captures, our GI vs the path
tracer, linear RGB means over 31×31 windows):**

| region | ours rgb / sat | tracer rgb / sat | lum ours/tracer |
|---|---|---|---|
| ceiling near red wall | 0.83/0.77/0.76 · 0.08 | 0.85/0.48/0.44 · 0.48 | 1.41 |
| ceiling near green wall | 0.24/0.22/0.21 · 0.12 | 0.53/0.49/0.27 · 0.50 | 0.46 |
| back wall left of box | 0.99/0.99/0.99 · 0.00 | 0.83/0.47/0.43 · 0.49 | 1.83 |
| back wall right of box | 0.02/0.07/0.01 · 0.90 | 0.05/0.38/0.01 · 0.98 | 0.20 |
| floor near red wall | 0.48/0.42/0.40 · 0.17 | 0.78/0.37/0.31 · 0.61 | 0.95 |
| floor centre | 0.46/0.41/0.39 · 0.15 | 0.69/0.46/0.35 · 0.49 | 0.83 |

Two defects, not one: (a) the whites carry a tenth of the tracer's chroma —
the red wall's bounce, which in a closed room is the room's equilibrium
tint, arrives at 0.07–0.17 saturation against 0.4–0.6; (b) the brightness is
wrong in opposite directions: 1.4–1.8× next to the emitter panel (the
panel's direct term on grazing surfaces) and 0.2–0.5× on the far, green
side (the multibounce that should light it). The indirect debug view shows
the box faces tinted pink/green, so the field does carry colour; the loop's
gain is what is short (`bounceOverDirect` 1.19 at hits where a 0.75-albedo
room converges to ~3×). The emitter is a 0.74×1.92×0.51 m BOX mover
(`Light`, Mirror.mat, giMobility dynamic); a sharp-edged bright rectangle on
the floor in the indirect view (the user's "phantom plane") sits under it —
the resolve's irradiance INCLUDES the emitters' direct term, so that is the
analytic box emitter's footprint, and its hard edge is the shape model's.
The colour-bleed chain gate on its own fixture passes (tile-atlas red blocks
sat 0.51), so the loss is in the loop's gain and the direct term's share, not
in attribution. Next: a harness Cornell rig that screenshots the tracer
through puppeteer (`page.screenshot` sees the tracer's canvas; the MCP
screenshot does not) and A/Bs the loop gain and the emitter shape.

### 11.19 THE CORNELL RIG: the phantom plane was our own debug quad; the tracer stalls unfocused; ours is the tracer's two-bounce picture at half the chroma (2026-09-03, night)

**The rig (`probe:gi-cornell-ref`, scripts/run-gi-cornell-ref.mjs).** A
READ-ONLY copy of the user's own Cornell (project GAME, scenes/Cornel.scene —
the tauri shim refuses writes outside the scratch root), one pose on the
room's axis, our GI settled 30 s, then the debug view flipped to
`path-tracer` and the tracer polled through `getSampleCountsAsync` (the
WebGPU tracer has NO `samples` property) until 64 per pixel. Regions are
WORLD points projected through the pose, so both captures share them
whatever the harness aspect. Env: FLAGS (page globals), SETTLE, PT_SAMPLES,
PT=0, DEBUG_VIEW=indirect,occupancy, PALETTE=1, WALLS=<m>, LIGHT_MOBILITY,
HIDE_LIGHT, ROOT_SHIFT=x,y,z, GI_PROPS=json, DRAG=<entity>,<s>, ENVLIGHT=0.

**Three instrument lessons before any number was real:**
1. `viewport.setFreezeWhenUnfocused(false)` or the tracer never converges:
   headless is never focused, GI's queue pins the loop, and the moment the
   tracer takes over (GI skips its work while the tracer is active) nothing
   pins it — the loop suspended at ~3 frames and every "25 s wait" read 1.3
   samples of dots. With the freeze off: 109 samples in 7 s.
2. The debug-view overlay is a REAL `PlaneGeometry(2, 2)` mesh at the world
   origin (clip-space vertex shader, in the scene graph so `renderer.render`
   draws it). While a debug view is on it is `visible`, and the g-buffer, the
   voxelizer and the material tiers adopted it as world geometry — the user's
   **"phantom plane that always appears in occupancy at the world origin"**,
   and the lighter rectangle on their Cornell floor in the indirect view (the
   quad's top 0.76 m stood above their floor at y 0.24; the g-buffer drew it
   with depthTest off, the resolve shaded it). Proven by `ROOT_SHIFT=5,0,0`:
   the grey square stayed at the origin while the room moved. FIXED: the
   three debug meshes sit on `DEBUG_LAYER` (the g-buffer camera disables it,
   the editor camera sees it, the MCP screenshot keeps it) and the voxelizer's
   `editorOnly` test skips `userData.__giDebug`. Verified: no square in the
   shifted room's indirect view.
3. The pipeline-landed REPLAY re-dispatched skipped compute nodes as
   `renderer.compute(node)` — a node dispatched with an explicit
   `[x, y, z]` has no `count`, so three's backend read `dispatchSize[0]` of
   null the moment the tracer's kernels came through the interception.
   FIXED: `giReplayNodes` is a Map node → size and both replay loops carry it.

**The numbers (linear means, our GI at 30 s vs three-gpu-pathtracer; the
user's scene: whites #ffffff, red (1,0,0), green (0.22,1,0), a 0.74×1.92×0.51
box emitter at strength 10, a mirror Box):**

| region | ours | tracer (10 bounces) | lum ratio |
|---|---|---|---|
| ceiling near red | 0.331/0.289/0.283 sat 0.15 | 0.711/0.290/0.254 sat 0.64 | 0.79 |
| ceiling near green | 0.153/0.145/0.132 sat 0.14 | 0.410/0.402/0.193 sat 0.53 | 0.38 |
| floor centre | 0.473/0.426/0.406 sat 0.14 | 0.647/0.420/0.325 sat 0.50 | 0.94 |
| floor near green | 0.301/0.275/0.248 sat 0.18 | 0.326/0.449/0.139 sat 0.69 | 0.70 |
| red wall | 0.643/0.064/0.064 | 0.777/0.096/0.096 | 0.78 |
| green wall | 0.010/0.233/0.000 | 0.024/0.492/0.004 | 0.47 |
| WHITES mean sat | **0.174** | **0.602** | 0.77 (0.38–1.09) |

**Arms (WHITES sat / lum mean):** base 0.174/0.77 · WALLS=0.5 0.197/0.76 ·
LIGHT_MOBILITY=static 0.175/0.77 · `__giMergeLos=false` 0.175/0.78 ·
`__giSrcSecondary=false` (loop off) 0.080/0.63. The thin-wall shared record,
the mover emitter path and the merge LOS are NOT the cause; the loop is worth
+23 % brightness and doubles the chroma but reaches nowhere near the room.

**The tracer ladder (`__giPathTracerBounces` 1/2/3/10 vs the same ours):**
ceiling near red lum ratio 1.86 / 1.05 / 0.91 / 0.79; floor near green 5.38 /
1.93 / 1.24 / 0.70; WHITES sat tracer 0.004 / 0.320 / 0.390 / 0.602 vs ours
0.174. **Ours is the tracer's TWO-BOUNCE picture in brightness at HALF its
chroma.** At equal brightness (pt2) the ceiling near the red wall reads ours
0.332/0.289/0.283 vs 0.372/0.260/0.255 — less red, more green/blue: the light
is the right amount and the wrong colour. The palette is right (PALETTE=1:
red 1/0/0, green 0.04/1/0, whites 1, fallback 0.84/0.83/0.67), the walls are
lit (red wall 0.78–1.07 of the tracer), and the loop albedo mean is 0.73
(whites clamped at MAX_LOOP_ALBEDO 0.9 — the tracer's whites are albedo 1
with 10 bounces, part of the far-side gap by construction). Open: where the
coloured walls' bounce loses its chroma between the hit shade and the
ceiling's irradiance — the next arm is a per-channel receipt on the bins of
a ceiling probe (R/G/B of the deposits by hit slot), not another whole-image
number.

**THE DRAG FREEZE DID NOT REPRODUCE, AND THE INSTRUMENT WAS THE PROBLEM.**
The DRAG arm (frameStats before/during/after plus every [gi] line the drag
provokes) held 96-97 fps before, 84-85 during, 96-97 after at 1406x567 with
the emitter moved 22 times a second; the live editor held 84 fps under two
nudges and idles at 120. Two lessons: (1) the first drag arm moved 1 cm a
step, which reads 0.15 on the emitter motion metric (dCenter/(0.1 reff),
reff 0.665) and never crossed ALPHA_TRACK_THRESHOLD 0.5 - it measured a drag
that never armed the light-track window (DRAG_STEP=0.07 does); (2) with the
window armed, `__giSrcMotionTrack = false` gave the SAME 84 fps, so the
window's cap lift - already bounded to 2x by 11.9, though its log line still
says "to OFF" - is not the cost. The user's own console during their drags
shows the window arming at 0.5/s and open 26-58% of frames, and one
`auto-fit: refit in place (stretch, no recompile)` - no rebuild, no wave.

**Shipped instead: `profile.spikeWatch` (StatsSystem.beginSpikeWatch).** A
mean cannot see a freeze - profile.cpuFrame would report ~14 ms for a drag
that hitches 300 ms once a second - so the phase profiler now runs for a
window and keeps every frame over a threshold WHOLE, with that frame's
phases and module sub-phases, plus `atSeconds` to line a spike up against
what was being done. A frame's breakdown is the subtraction of two snapshots
of the existing accumulators; the hot path is unchanged. First live read
(idle, their Cornell): 720 frames in 6 s, worst 20.7 ms, zero spikes over
25 ms. The next measurement that means anything is that call running WHILE
the user drags.

**Still open: the mirror Box's reflection** - a doubled image of the
emitter, a black band across the face, and bright fringes along the Box's
silhouette. The black is a reflection ray finding nothing (the room's open
front, sky intensity 0) and is arguably right; the hard seam and the
silhouette fringes are not, and they survive `exactReflections: true`, so
they are not the glossy field alone.

### 11.20 THE MISSING COLOUR BLEED WAS THE FAR-FIELD BOX FEATHER (2026-09-03, night)

**The complaint, twice: "almost no colour bleed".** Measured with
`probe:gi-cornell-ref` at one pose against the in-editor path tracer: our
whites carried **0.16 saturation against the tracer's 0.58**, the red wall
arrived at 0.84x and the green wall at **0.58x** their true brightness, and
the irradiance field itself read pale (indirect view, whites' sat 0.14).

**The cause.** The §13 F3 far-field constant enters the resolve through
`w = max(wBox, 1 - knownF)`. `wBox` exists because a DETAIL box is a small
high-resolution volume inside a larger world and a pixel near its boundary
has no field beyond it. The BVH-only build arms the same term with NO detail
box: the volume is auto-fitted around the whole scene and the BVH answers
everywhere, yet the feather is four probe spacings (~1.4 m) measured inward
from a box that hugs a 5 m room by ~0.5 m. Every wall, the floor and the
ceiling sat inside that band, so **up to ~70 % of their diffuse term was a
flat warm-white scene-average constant** — and a constant carries the room's
MEAN, which is precisely what a red-and-green room is not.

**The fix (shipped, b697017):** `boxFeather` is false unless a detail box is
actually armed. Large scenes are untouched (their box has a real outside);
the never-black coverage fill is untouched everywhere.
`__giFarFieldBoxFeather = true` restores the old behaviour.

| arm (their Cornell, 30 s settle, vs the tracer) | whites' sat | lum ratio | red wall | green wall |
|---|---|---|---|---|
| before | 0.158 | 0.81x | 0.84x | 0.58x |
| **after** | **0.419** | **1.19x** | **1.00x** | **0.95x** |
| tracer | 0.577 | 1.00x | - | - |

**Two refutations worth keeping.** (1) NOT A RAY BUDGET: a three-minute
settle reads 0.170; stride 1 with the per-probe cap off (153 k rays a frame,
10x the default) reads 0.173. Colour bleed was a BIAS, not a rate. (2) NOT
the merge's "an unknown self bin stays unknown" rule:
`__giMergeFillUnknown = true` lifts tile coverage from 57 % to 96 % and
makes the image PALER (0.159 -> 0.141), because the parents it fills from are
dimmer, not more coloured. A third change, `__giFarFieldCoverageRamp` (fill
only where coverage is genuinely low), ships OPT-IN: it measured no
difference either way once the box term was gone.

**Residual, open:** 0.42 against the tracer's 0.58, and our whites 1.19x too
bright. That is the tile's known-bin extrapolation (meanKnownBins 11.4 of a
20.1-bin lobe) plus the loop's own gain (`bounceOverDirect` 1.09 where a
0.73-albedo room converges near 2.7) — a smaller, separate deficit.

**⛔ THE RIG LIED ONCE.** A dev flag persisted in `localStorage`
(`gi.devFlags.v1`) booted one arm straight into the path-tracer view, and
that arm's "GI" capture was the tracer's own noisy image — which "proved"
that a 1.5 M ray ceiling restores the bleed (whites' sat 0.612, a perfect
match to the tracer because it WAS the tracer). The rig now clears the dev
flags on boot and asserts the debug view is off before it shoots. Blind
statistics, one more time: the instrument must be shown to see its subject.

### 11.21 THE FLICKER IS IN PLAY MODE, THE HARNESS COULD NEVER SEE IT, AND THE LIGHT-MOTION SIGNAL WAS NOT A RATE (2026-09-04)

**The user, opening the session: "we need to stabilize gi lighting. It is very
flickery… especially when camera looks at new surfaces or goes to new places,
or when directional light rotates changing the lit areas."** Asked where they
see it, they answered **"both, about equally"** — edit mode and play.

**FIRST: EIGHT ARMS OF NULL, AND WHY.** `probe:gi-walk` gained `PARK=1` (the
camera welded at the pivot — every arm this file ever ran MOVED the camera, so
no run in its history could separate a field reacting badly to a moving LIGHT
from one reacting badly to a moving CAMERA), `SUNROT=<deg/s>` and
`GIVIEW=indirect`. Sponza at high, pools/quality/resolution matched to the
user's live boot line, character hidden:

| arm (parked camera) | maxStep | reversals | mean step on a reversal |
|---|---|---|---|
| sun STILL (control) | 0.0041 | — | 25 of 540 tiles move at all |
| sun 7°/s, composited | 0.659 | 10.7 % | 0.0030 |
| … `irrhist` (screen filter pinned 0.9) | 0.678 | — | — |
| … `notrack` (tracking window off) | 0.667 | — | — |
| … `noroot` / `sunsplit` / `nochecker` | 0.618 / 0.976 / 0.719 | 14.4 / 8.4 / 6.6 % | — |
| sun 7°/s, **indirect buffer only** | 0.119 | **4.0 %** | **0.0009 (0.19 % of mean)** |
| … `noroot` / `nofarduty` / `nosunmap` | 0.091 / 0.068 / 0.080 | 8.0 / 4.2 / 4.5 % | — |

⭐ **TWO INSTRUMENT FAULTS FOUND EN ROUTE.** (1) Sponza's day cycle is
`LightScript.ts`, a **plain `Script`, which only ticks in PLAY mode** — so every
"live sun" arm ever run against Sponza measured a STATIONARY sun (`shadow
0.000` for all 154 pinned frames). The Level's `Rotator.ts` is
`@executeInEditMode` and does turn; the two scenes had silently disagreed about
what "unpinned sun" means. Hence `SUNROT`, which drives the light off the wall
clock at a stated rate. (2) At 7°/s a shadow edge cast by a column 10 m away
sweeps 1.2 m/s ≈ 10 % of a tile per frame — **the composited image is dominated
by real direct light**, which is the 0.15 baseline in every tile-step trace and
buries the estimator. Hence `GIVIEW=indirect`, and hence the new REVERSAL
statistic (share of consecutive signed tile deltas whose sign flips, and the
mean step they carry): a sun setting, a wall being revealed and light arriving
in a room are all MONOTONE; only an estimator reverses.

On the indirect buffer the field tracks a 7°/s sun with **96 % of its change
monotone and the reversing part at 0.19 % of the image mean**, and `checker`
does not move off its static value. **There was nothing there to fix.** Three
sessions have now hit this wall (§11.16 was the second). That is not bad luck.

**SO THE INSTRUMENT MOVED INTO THE ENGINE: `profile.flicker`** (new,
`giFlickerWatch.js` + GISystem's `beginFlickerWatch`/`readFlickerWatch`, op in
`profile.js`, gate `smoke:gi-flicker-watch`). A per-pixel GPU accumulator over
the irradiance target, every rendered frame, counting sign reversals and
one-frame step amplitude, **with the field's own dials sampled on the same
frames** — α, stride root, far duty, the screen history weight, camera-motion
EMA, the light term in the tracking window's own threshold units, and world Hz.
Every previous round of this investigation had the picture and the dials in
separate runs and had to argue across the gap. Two guards it needs and has: a
rebuild that swaps `_giTargets` stops the window and reports `targetSwapped`
(an accumulator on a dead texture reports a flawless absence of flicker), and
`stillOnly` (default) counts ONLY frames where the camera did not move —
because the counter is screen-space and an orbit puts **100 % of pixels over
the churn threshold by parallax alone**, measured, on a field that is behaving.

**THE MEASUREMENT, IN THE USER'S OWN SESSION, SAME SCENE AND CAMERA:**

| window (camera still) | rev/px/frame | pixels reversing 3+ | p95 step / mean |
|---|---|---|---|
| edit mode, parked | 0.0004 | 5.1 % | 0.025 |
| edit mode, after a 12 m teleport | 0.0003 | 3.5 % | 0.023 |
| **PLAY** #1 | **0.0181** | **99.6 %** | **3.70** |
| **PLAY** #2 | 0.0071 | 77.6 % | 0.90 |

**45–150× worse in play mode on identical geometry with the camera welded.**
Edit mode is clean because `LightScript` does not tick there — a 12 m teleport
into unseen geometry settles inside the 30-frame warmup.

⭐⭐⭐ **CAUSE 1, FIXED: THE LIGHT-MOTION SIGNAL WAS A PER-FRAME DELTA, NOT A
RATE.** GISystem measured light motion as the change in a light's matrix
BETWEEN TWO RENDERED FRAMES and four consumers read the result as a velocity:
the §12.38 α ramp, the §12.65 screen history weight (`0.9·(1−mLight)` — the
image's only smoother), the shadow/emitter history weights (`0.94 − m·30`), and
the §12.43 window's 0.5 arm threshold. A per-frame delta is `rate × frameTime`,
and this renderer's frame time is not constant BY DESIGN (the world chain runs
at 30/15 Hz under a renderer at 60–120). Live receipt, on a sun turning at a
smooth sinusoidal rate: **`lightMotion` median 0.337, max 3.451 — an 11×
spread**, straddling a threshold set at 0.5. §12.83 predicted this straddle
exactly, simulated it at ±12 % jitter, priced it at ~1 % of frames and declined
to spend a unit. The live dial says the window is open on **more than half** of
the still frames, and `histWeight` — the only smoother — has **median 0**.

Shipped: (a) the delta is normalised by real frame time and expressed in units
of one 60 fps frame, so every constant keeps its calibration and all of them
become frame-rate independent (`__giLightMotionRate = false` reverts);
(b) peak-held with a 100 ms exponential release, because the matrix is written
by a script whose tick is not the GI tick and the delta ALIASES — an average
would lag a genuine step by its whole time constant, a peak hold only fills the
zeros (`LIGHT_MOTION_RELEASE_MS`); (c) **§12.83's novelty gate, shipped as
designed** — each term keeps a slow baseline and arms only on
`max(threshold, NOVELTY × its own baseline)`, so a steadily rotating sun is
never novel against itself while a sun that starts, a teleport or a toggle
always is, per term so the sun cannot deafen the luminance channel
(`TRACK_BASELINE_MS` 1000, `TRACK_NOVELTY` 2.5, `__giSrcTrackNovelty = false`);
(d) the screen history weight is **slew-limited** (0.15/frame down, 0.06 up,
scaled by real frame time, `__giIrrHistSlew = false`) — nothing that governs
every pixel at once may move by 0.9 in one frame, and this also smooths the
§11.8 swap-hold release that used to expose a cold store in one step.

**RECEIPT.** `lightMotion` spread **0.086–3.451 (40×) → 0.439–1.012 (2.3×)** on
the same sun. Picture, same conditions: rev/px/frame **0.0181 / 0.0071 →
0.0039**, churn **99.6 / 77.6 % → 55.9 %**, p95 step **3.70 / 0.90 → 0.54×** the
image mean. The A/B that isolated it first: `__giSrcMotionTrack = false` live in
play, two matched pairs, **5.1× on reversals and 5.2× on the p95 step**. Gates
`test:gi-src-temporal` and `test:gi-src-deposit` green.

⛔ **AND ONE UNCONTROLLED INPUT CAUGHT ITSELF.** The first "base" repeat read
0 reversals and `lightMotion 0..0` — **play mode had stopped between windows**
(two assistant sessions share this editor and play mode is shared state). Every
arm since is a `batch` of `[play.set, profile.flicker, play.get]` so the arm
carries proof it ran in the regime it claims.

⭐⭐⭐ **CAUSE 2, NAMED AND NOT FIXED: THE SUN IS STORED IN THE BINS.** With the
window neutralised, the signal honest, **α pinned to the still rate (0.02) and
the stride root at 0**, camera welded, play mode: **62.8 % of pixels still
reverse 3+ times and the p95 one-frame step is 0.39× the image mean** — and the
churn is slightly WORSE than at the moving α, not better. That is `srcDeposit`'s
own §12.82 header, verbatim: *"No rate fixes a stored quantity whose TARGET
moves every frame."* `BIN_R/G/B` hold accumulated radiance, radiance is a
function of the sun angle, bins refresh at wildly uneven rates (§11.17: a far
probe sees a bin every 11 frames), so at any instant the field is a patchwork of
different sun angles — and that patchwork rearranges itself as the bins take
turns refreshing. It is the same mechanism for "the camera looks at new
surfaces": the newly visible bins were last refreshed at a different sun angle
than their neighbours.

**NEXT UNIT — THE SUN SPLIT'S DELIVERY.** §12.82 built the answer (`BIN_SR/SG/SB`
cache the sun's TRANSFER, which a rotating sun does not change; `[F]` closes it
against the CURRENT sun every frame; "a rotating sun then invalidates NOTHING")
and it is opt-in because the bin-level delivery is short: it removes 46–57 % of
the picture and returns 5–24 %. Two things have changed since that verdict.
(1) The layout was cramped into 4 words because eleven words was 123 MB against
a **128 MiB** storage-buffer binding limit — §11.4 A2 replaced that with a
device-scaled ceiling, and this machine reports **1024 MB per binding**, so the
six-word form §12.82 called "the obvious form" and rejected is now affordable.
(2) The likely defect is named by its own comment: one packed normal per bin,
last-write-wins, closed as `max(0, n·l)`, where a bin aggregates hits spanning
many normals — the cosine of one representative normal is not the mean of the
cosines, and the clamp makes the error one-sided. Storing the weighted normal
as a VECTOR and closing with `max(0, sum·l)` moves the clamp outside the sum,
which is the aggregation the estimator actually wants.

### 11.22 THE SUN SPLIT SHIPS — THE VERDICT THAT KEPT IT OFF WAS STALE, AND A SPLIT SUN'S ROTATION MUST STOP DRIVING THE FIELD (2026-09-04)

**§11.21 ended with the sun-in-the-bins half open and named the sun split as
the answer, on the record that its delivery returned 11-41 % of what it
removed. THAT RECORD PREDATED ITS OWN FIX.** The defect behind it — the decay
pass round-tripping the packed normal through a `select`, which zeroed the
word every frame — was found and fixed afterwards (srcDeposit's `BIN_SN` note
carries it, and records the normal ratio going 9 % → 52-63 %), and nobody
re-ran the delivery measurement. srcSystem still said "IT MUST STAY OFF UNTIL
THE DELIVERY IS WHOLE".

**RE-MEASURED** (`probe:gi-walk PARK=1 SUNROT=0`, Sponza, sun pinned, camera
welded, character hidden, four arms in ONE run so the pose and the sun angle
are shared):

| arm | tail mean luma | vs base |
|---|---|---|
| `base` | 0.17939 | — |
| `sunsplit` | 0.17308 | **96.5 %** |
| `sunsplitflatcos` (cosine forced to 1) | 0.17408 | 97.0 % |
| `sunsplitkeep` (sun in the bins AND closed) | 0.20360 | 113.5 % |

⇒ the transfer removes 0.0305 and returns 0.0242 — **79 %**, for a picture at
96.5 % of baseline. Ledger: **73.0 % of LIT bins carry a normal** (against the
9 % the old verdict was measured at), 47 % of hits face the sun.

⛔ **AND IT REFUTED THE FIX THIS SESSION WAS ABOUT TO BUILD.** The plan was to
replace the single last-write-wins normal with a weighted normal VECTOR (the
"obvious form" §12.82 rejected for want of binding bytes), on the theory that
one representative normal cannot stand in for a bin aggregating many. But
`sunsplitflatcos` — which forces the cosine to 1 and so removes the cached
normal from the answer entirely — lands within **0.6 %** of the honest close.
The cosine is not where the residual goes; the **27 % of lit bins carrying no
normal at all**, whose sun is simply dropped, is. That is the honest remaining
3.5 %, and it is not worth four more words a bin. Measure before rewriting.

**SHIPPED:**
- `sunSplitArmed()` is now `!== false` (default ON). `srcBinCeiling` already
  divides by `BIN_WORDS`, so the nine-word layout costs a device bins rather
  than failing: on a 1024 MB binding the ceiling stays pinned at
  `BIN_CEILING_MAX` and nothing shrinks, on a portable 128 MiB one it is
  ~6.7 M → ~3.7 M bins and §10.7's `noBlock` is the instrument that would say
  so. Stated, not buried.
- ⭐⭐⭐ **THE COUPLING, WHICH IS WHERE THE WIN ACTUALLY COMES FROM.** A cached
  transfer is sun-independent by construction, so a turning sun stales no
  stored word — and every mechanism that reacts to "the light is moving" by
  FORGETTING FASTER is now spending variance to buy nothing. The light loop
  keeps TWO tracks: `_giShadowLastMotion` (unchanged, all lights, drives the
  shadow and emitter history — **visibility IS still staled by a moving sun**,
  §12.82's own "what stays stale, named so it is not misread as fixed: V") and
  `_giFieldLightMotion` (drops a split sun's ROTATION only; drives the α ramp
  and the screen irradiance weight). Zeroing one number for both would have
  smeared every shadow edge. Guarded to `dirCount === 1`, because the split
  names ONE slot and this loop cannot tell which object owns it.
  `__giSrcSunSplitCalm = false` reverts.

**RECEIPT — `profile.flicker`, the user's live play session, camera still:**

| | base #1 | base #2 | §11.21 signal fix | **+ split** |
|---|---|---|---|---|
| rev/px/frame | 0.0181 | 0.0071 | 0.0039 | **0.0010** |
| pixels reversing 3+ | 99.6 % | 77.6 % | 55.9 % | **13.8 %** |
| p95 one-frame step / mean | 3.70 | 0.90 | 0.54 | **0.317** |
| pixels moving at all | 100 % | 100 % | 99 % | **47 %** |

Dials: `lightMotion` **0.000 flat** while `lightMotionVisibility` reads
0.002-1.041 — the sun is demonstrably turning and no longer stales the field;
α back to 0.02, root 0, `histWeight` **0.9 flat**, the tracking window never
arms. **121 fps in play, GPU 5.95 ms — no frame-rate cost.** Gates
`test:gi-src-deposit/shade/merge/gather/probes/temporal` and
`smoke:gi-flicker-watch` all green on the nine-word layout.

⚠ **AND ONE NEAR-MISS WORTH KEEPING.** The first post-split window read churn
**0.2 %** — a 500× win — at `fps 27.5` against a viewport doing 121. That
number is `dispatched / seconds`, i.e. THE GI TICK'S OWN RATE, and it was low
because the window straddled the tail of the boot's material wave, when the
tick is held. A field that is not advancing is perfectly calm. The honest
repeat, once `pendingMaterials` hit 0, reads 13.8 % at 109.9 fps. **Always read
the watch's `fps` against `profile.frameStats` before believing a good number.**

**WHAT IS LEFT.** Churn 13.8 % and a p95 step of 0.317× the mean are still over
the "few % per frame" gate — but the tile map has changed CHARACTER: it was
uniform across the whole viewport (0.034-0.098 everywhere) and is now flat
0.0000-0.0005 over most of the image with a cluster at 0.0073-0.0132 in the
bottom-left/centre. That is where the animated character stands, and §11.16
already measured that every popping tile in a live Sponza sits on the figure.
The residual is a MOVER problem, not a sun problem, and it is the next thread.

### 11.23 ⛔⛔ §11.21 AND §11.22 ARE REVERTED TO OPT-IN. EVERY MEASUREMENT SCORED STABILITY, AND A FROZEN FIELD IS STABLE (2026-09-04)

**The user, on the shipped build: "i don't know what you did, but it got a lot
worse. Flickers a lot + when light moves, lighting does not update."**

All five behaviour changes are back to opt-in and the working tree behaves
exactly as it did before this session. `__giSrcSunSplit`, `__giSrcSunSplitCalm`,
`__giLightMotionRate`, `__giSrcTrackNovelty`, `__giIrrHistSlew` — each now
requires `=== true`. The instrument (`profile.flicker`) stays; it is the only
thing here that earned its place.

⭐⭐⭐ **THE METHOD FAILURE, WHICH IS THE ONLY PART WORTH KEEPING.** Three
receipts were produced and all three were true:

- delivery: 96.5 % of baseline luma, **sun PINNED**;
- flicker: churn 99.6 % → 13.8 %, p95 one-frame step 3.70× → 0.317×;
- performance: 121 fps in play, GPU 5.95 ms.

Not one of them can tell **converged** from **frozen**. A reversal counter
rewards a picture that never changes. A pinned-sun delivery arm cannot see
tracking, by construction — it holds the sun still on purpose. And the dials
that looked like proof of the mechanism (`lightMotion` 0.000 flat, α 0.02,
root 0, `histWeight` 0.9 flat) are equally the signature of a field that has
stopped responding. **Every instrument this session built or used measured the
absence of change, and the defect shipped was an absence of change.**

⛔ **THE MECHANISM, AND IT WAS IN §12.82's OWN CAVEAT.** The cached transfer is
`ρ/π · V`. §12.82 names `V` explicitly — *"what stays stale, named so it is not
misread as fixed: V"* — and this session read that, quoted it in §11.22, and
then built `sunCalm` as if it did not apply. A rotating sun re-shadows the whole
scene; the split makes the cosine and the irradiance free, it does **not** make
the shadow free. Removing the sun from the radiance-staleness signal set the
refresh of the one genuinely stale half to the STILL rate — so the GI's
shadowing stopped following the sun. That is "when light moves, lighting does
not update", exactly.

⛔ **AND THE GUARD WAS WRONG INDEPENDENTLY.** `sunCalm` tested `sunSplitArmed()`,
which is only the build FLAG. The split actually arms only when a directional
slot was named AND the shading is split; on any build where those fail, the sun
still accumulated into the bins while the field was told not to forget it.
srcSystem now publishes `__giSrcSunSplitLive = !!sunClose` and the (opt-in)
guard reads that.

⚠ **THE OTHER HALF, "FLICKERS A LOT", IS PROBABLY THE RATE NORMALISATION AND IT
IS NOT A BUG.** Making the light signal honest makes it ~1.8× larger at 120 fps
than the per-frame delta it replaced, which drives α and the stride root
HARDER. The measured dials say so: α median 0.05 → 0.078, root 0.367 → 0.700.
More correct, more variance. A fix that makes a signal truthful still has to be
re-tuned against what consumes it, and none of that was done.

**THE GATE THAT MUST EXIST BEFORE ANY OF THIS SHIPS AGAIN:** a LIGHT-RESPONSE
receipt — time for the picture to follow a moving sun, measured on the same
window as the flicker number, so no "stability" win can be bought with lag.
`probe:gi-src-converge` measures t90 for a light STEP; what is missing is the
continuous case (a sun turning at a stated deg/s, and how far behind the GI
runs). **No stability number from this module may be believed without one
beside it.**

### 11.24 THE CORRIDOR REPRO, AND IT IS NOT THE SUN (2026-09-04)

**The user, handing over the reproduction: "move camera from main area to the
side corridor - you will see all the flicker."** Driven from MCP on the
REVERTED build, edit mode, teleport then hold, `profile.flicker` counting only
still frames:

| | main nave | side corridor |
|---|---|---|
| image mean luminance | 1.2958 | **0.0941** (13.8× darker) |
| p95 one-frame step (absolute) | 0.0967 | 0.1201 |
| **p95 step ÷ image mean** | 0.075 | **1.277** (17×) |
| max step ÷ image mean | 5.46 | 8.99 |
| reversals/px/frame | 0.0017 | 0.0008 |

⭐ **THE ABSOLUTE NOISE IS THE SAME IN BOTH PLACES. THE CORRIDOR IS 14× DARKER,
SO THE SAME WOBBLE IS 128 % OF EVERYTHING ON SCREEN.** That is
`TEMPORAL_ALPHA_STILL`'s own note, which predicted this report in as many
words: *"in darker areas it is very flickering AT REST — the dark pixels are
where relative variance is largest, and the still floor is the variance dial"*.
The churn is concentrated top-left (rows 0-2, cols 1-5 of the tile grid) — the
vault and upper walls, the darkest, farthest surfaces in frame.

**The ledger at that pose** (`__giProfileProbeRays`, `profile.giPasses`):
`raysPerFrame` **14 278** against the harness's 124 075 at the same tier (the
rest cadence and `probeRayCap` 8), 2351 VISIBLE c0 probes at **6.07 rays each**,
`zeroRayShare` 0.066, `cascades[0].starved` 40. That is ~0.3 rays per bin per
frame. Cascade 2's `orphanRate` is **0.563** and `losRate` 0.257.
`secondary.byLod[0].meanIrradianceLuma` 0.0848.

**So the corridor is the §11.17 STARVED PROBE, seen in the one place where the
mean is small enough for its variance to be the picture** — not the day cycle,
not the tracking window, not the sun in the bins. The whole of §11.21/§11.22
chased a mechanism that is real and is not what the user is looking at.
⚠ Note also `alphaLive` 0.0205 and `keepLive` 0.99933 at that pose: a single
ray can move a bin by 2 %, so a step of 128 % of the image mean is NOT the bin
blend — it is arriving through the merge (56 % orphans at c2), the gather's
missing corners (`meanCorners` 4.95 of 8) or the tile coverage (12.7 %). That
is the next thing to bisect, and it should be bisected before anything is
changed.

### 11.25 UNIT 1 — NO BIN IS EVER UNKNOWN: confidence replaces the membership switch (2026-09-04)

**The user, after §11.23: "of course it is not a tuning. Start."**

**THE GATE CAME FIRST.** `profile.lightResponse` (new; `giFlickerWatch.js`
`createGiTileMeanRecorder`, GISystem `beginLightResponse/readLightResponse`,
op in `profile.js`, arm 4 of `smoke:gi-flicker-watch`): steps the scene's one
directional light 25° about its parent's x — what the day-cycle script writes
— records the irradiance target as a 16×9 tile grid every frame, and scores
the distance from the SETTLED picture per frame after the step: t50, t90,
monotone share, and `changeOfBaseline` (a step that does not reach the
picture is a blind run, and says so). One readback, no per-frame stall, the
same `targetSwapped` guard as the flicker watch, and the sun is restored on
read. §11.23's rule made concrete: **no stability number from this module is
believed without this beside it.** The first live run crashed reading `.size`
of an unallocated buffer — the kernel had never dispatched because `uint` was
not imported and the async compute is a silent no-op; the readback is now
guarded and reports `pipelinePending` rather than a clean number, and the
smoke's arm 4 is what caught it.

**BASELINE, live, the reverted build (every §11.21/§11.22 hatch opt-in):**

| pose | flicker (still frames) | light response (25°) |
|---|---|---|
| main nave | 0.0058 rev/px/f · 16.1 % churn · p95 step 0.072× mean | change 100 %, **t50 2212 ms, t90 3581 ms**, 99 % monotone |
| side corridor | 0.0008–0.0019 · 9.7–10.5 % · **p95 step 0.77–1.28× mean** | change 110 %, **t50 685 ms, t90 3122 ms**, 96 % monotone |

⭐ **A finding the gate produced on its first honest run:** in the nave the
picture does not move AT ALL for ~2.3 s after the step (the first seven
points of `curve` read exactly 1.000), then converges in ~1.3 s. In the
corridor — where the field was still settling from the camera move — it
responds on the next frame (curve 1.25 → 0.92 → 0.65 …). A converged, IDLE
field takes over two seconds to start responding to a light change; a busy
one responds immediately. That is a pre-existing wake-up latency (the
converged-idle sleep / rest cadence), it is a real part of "when light moves,
lighting does not update", and it is NOT this unit's job — but it is now a
number, and the number must not get worse.

⚠ Ordering lesson from the baseline batch itself: a flicker window taken
right after a `lightResponse` reads the field mid-transition from the sun's
RESTORE (corridor: α 0.038–0.1, root 0.23–0.7, 25 % churn against 10 % in a
clean window). Settle between them, or read the earlier clean windows.

**THE CHANGE.** The resolved payload grows a third word (`PAYLOAD_WORDS` 3:
rgb, T, then CONFIDENCE `c` + a spare half). srcDeposit's resolve writes
`c = N / (N + CONFIDENCE_PRIOR_RAYS)`, N in rays of accumulated weight — the
posterior weight of a bin's own measurement against K = 4 pseudo-rays of the
prior; one ray is worth 1/5 of the answer, four rays half, and there is no
count at which anything switches. Where it is spent:

- **srcMerge [G.3]**: the bin's own interval is shrunk toward "empty near
  interval, look through me" — `L' = c·L`, `T' = 1 − c + c·T` — and the
  parent composited through `own'` exactly as before. The 4→1 pre-average
  weights children by `c`; a corner's weight in the sparse gather carries its
  confidence; the merged bin's confidence is `c + (1−c)·c_parent·0.5`
  (`PARENT_FILL_CONFIDENCE`) so a parent-filled bin is present but never
  dominates a neighbour that measured. An orphan (no parent at all) keeps its
  own value unshrunk — shrinking toward "empty" with nothing to fill it is a
  pure energy loss. The top cascade's sky composite carries `c` through.
- **srcTiles**: each bin votes `cw · c`, so `cover = Σ cw·c / Σ cw` is the
  confidence-weighted fraction of the lobe and a freshly-hit bin FADES into
  the texel instead of flipping it to a one-ray radiance.
- **CPU twins** (`resolveBin`, `preAverage`, `mergeCascades`,
  `bakeProbeIrradiance`, `bakeProbeCoverage`) mirror each step; a fixture
  without a confidence field votes at 1, and `encodePayload` writes 1 for a
  known bin, so every existing gate fixture means what it meant.
- `MIN_WEIGHT`'s retire stays (block reclaim needs it); the step it used to
  produce is gone because a bin just above it now carries c ≈ 0.004.
- `__giSrcConfidence = false` pins c ≡ 1 everywhere — bit-identical to the
  previous estimator; the A/B arm and the hatch.
- `decodePayload` keeps its 4-channel `[r,g,b,T]` (three scripts index it by
  a literal stride of 4); `decodePayloadConfidence` is the new reader.

Cost: one more u32 per bin in the payload (4.2 M bins → +17 MB; `srcBinCeiling`
already divides by `PAYLOAD_WORDS`), one more packed load in the merge and
the tiles.

**THE RECEIPTS — the user's own corridor view** (`(-6, 1.25, 3.18) → (8, 1.25,
3.18)`; "use current editor camera position, it is correctly inside the
corridor" — the z = 5.4 pose this session had been using was not the
corridor), three arms in ONE session, identical protocol per arm: rebuild on
the arm → settle → teleport from the nave → the first 5 s still (`warmupFrames`
2) → 4 s at rest → light step from idle.

| arm | arrival: rev/px/f · churn · p95 step/mean · max | at rest | light step 25° from idle |
|---|---|---|---|
| old estimator (`__giSrcConfidence=false`) | 0.0016 · **12.9 %** · **0.41** · 7.3 | 0.0004 · 0.9 % · 0.135 · 2.17 | change 194 %, **t50 0.74 s, t90 2.8 s**, 96 % mono |
| Unit 1, K = 4 | 0.0069 · **54.3 %** · **0.76** · 3.9 | 0.0004 · 0.7 % · 0.075 · 2.6 | (at z 5.4: t50 2.3 s, t90 4.9 s) |
| **Unit 1, K = 16** | **0.0005 · 0.16 % · 0.12 · 2.7** | **0.000 · 0.0 % · 0.017 · 0.045** | change 52 %, **t50 2.4 s, t90 5.3 s**, 97 % mono |

Energy at the view: old 0.166–0.169, K = 16 0.171–0.177 (+5 %).

**And the nave, K = 16** (bright, well-sampled): at rest 0.0007 rev/px/f ·
3.6 % churn · p95 step 0.070× mean (baseline 0.0017–0.0058 · 12–23 % ·
0.067–0.075; K = 4 read 0.0002 · 0.6 % · 0.036 — calmer still, but K = 4 is what
made the corridor arrival worse); light step from idle **t50 0.42 s / t90
1.68 s**, 97 % monotone, no dead plateau (baseline 2.2 / 3.6 s with the 2.3 s
plateau). Harness smoke on the on-disk build: t50 2.09 s / t90 3.48 s / 98 %
(baseline 2.30 / 3.41 / 97 %) — unchanged there. All seven SRC gates green on
K = 16.

⭐⭐⭐ **K = 4 WAS WORSE AND THE GATE SAID SO ON THE FIRST RUN.** The whole
point of the unit is that a fresh bin fades in instead of popping; at K = 4 a
one-ray estimate is 20 % of the answer and a four-ray one is half, and in a
dark corridor a four-ray mean is a coin toss — 100 % of pixels moving, 54 % of
them reversing three or more times in five seconds. At K = 16 one ray is 6 %,
the parent carries the first dozen frames, and the same arrival reads 0.16 %
churn with a p95 step of 12 % of the image mean. That is "light arrives
gradually" as a number, and it is 80× less churn than the estimator the user
has been looking at. (`__giSrcConfidenceK` is the live dial; the constant is
what ships.)

⚠ **THE TRADE, STATED BEFORE IT IS NOTICED: LIGHT RESPONSE IN SPARSE REGIONS
IS SLOWER.** At the corridor view a 25° step settles in t50 2.4 s / t90 5.3 s
against the old 0.7 / 2.8 s — monotone (97 %), not frozen (the curve falls
from the first sample), and the same step in the well-sampled nave got
FASTER (K = 4: t50 2.2 → 0.5 s, t90 3.6 → 1.7 s, and the 2.3 s dead plateau
gone). The mechanism is an interaction with the machinery Unit 3 exists to
retire: a light change makes the field FORGET (§12.74's root, α to 0.1), the
counts collapse to ~1/(1−keep) ≈ 8 rays, confidence collapses with them to
~0.3, and sparse bins hand their vote to the coarse parent — which is the
smooth branch rather than the fast one. Under the old estimator "forget fast"
meant "the newest rays win", which was fast AND noisy. Confidence should be a
function of evidence, not of the decayed weight the mean happens to use; that
is Unit 3's first line. Until then the corridor is slower to follow the sun by
~2 s and does not flicker; the user asked for exactly that order of priorities.

⚠ Also measured en route: `changeOfBaseline` 194 % → 52 % at the same view —
the settled corridor reacts less to a 25° sun step under Unit 1, i.e. sparse
sun-driven contrast is partly averaged into the parent. Same mechanism, same
owner.

**Instrument notes from this unit:** (1) the bridge's 30 s call limit — a
`batch` longer than that keeps running in the editor after the client gives
up, and its `lightResponse` steps keep stepping the sun; windows go in ≤ 25 s
batches. (2) `lightResponse` normalised by the SETTLED sum reported a 486 %
change when the step turned the sun off the nave floor; it now divides by the
brighter of settled and baseline (t50/t90 never depended on it).
(3) `viewport.setFreezeWhenUnfocused(false)` is needed for any window the
user is not looking at, and is restored after each batch.

### 11.26 UNIT 1b/1c — COLD FIRST SIGHT: the orphan kept its coin toss, and the far-field fill read confidence as absence (2026-09-04)

**The user, on Unit 1: "after it settled once, it seems to be stable on a
revisit. Though the first time I see corridor - it flickers. When even just
stepping back with the camera, the walls around that were not visible before
start flickering a lot."**

**Every "arrival" this project had ever measured was a REVISIT.** Probes are
RETAINED for ≥ 1800 frames after leaving view and yield only under capacity
pressure (65 536 c0 slots against ~4 k live: never), so a teleport back into a
corridor seen earlier lands on warm probes with converged bins. §11.25's A/B
at the user's view was a revisit. The user's complaint is the COLD case — a
freshly minted column whose PARENT probes are just as new — and only a field
that has never seen the place can produce it. Hence **`probe:gi-cold-arrival`**:
the harness boots cold by construction, converges a START view, jumps straight
to POSE, and counts the first five seconds' still frames; then a revisit for
contrast, then `lightResponse`, then an energy ledger (`profile.giPasses`).

**Cold arrival, harness, the user's view, first 5 s:**

| | churn | p95 step / mean | max | at rest | meanLum at rest |
|---|---|---|---|---|---|
| old estimator | **61.7 %** | 2.67 | 13.1 | 0.16 %, still converging | 0.0442 |
| Unit 1 (K = 16) | **2.6 %** | 2.97 | 4.8 | **0.00 %, 0 % of pixels moving** | **0.0043** |

The flicker win is real and large. The second column is the flag: Unit 1's
cold corridor settles **10× darker and perfectly static**, and its converged
START view 32 % darker (0.060 vs 0.088). Live, at the user's far brighter sun
angle, Unit 1 had read +1–5 % — this is a dark-regime effect.

⚠ **AND THE REGIME WAS NOT UNDER CONTROL.** The next cold run, an hour later,
read the START view at meanLum **1.14** and the corridor at 0.15 — the same
scene file, a different sun. The editor autosaves every 10 s, so the user's
own light drags reach the disk the harness reads, and two runs an hour apart
measured two different suns. `probe:gi-cold-arrival` now PINS the sun
(`SUNDEG=`, the parent's `rotation.x` the day-cycle script writes) and prints
the direction it ran under either way; the dark-regime table above is the
authored sun (straight down, corridors bounce-lit only), the bright one is the
user's. Both regimes are real; a fix must hold in both.

**THE BRIGHT REGIME (the user's saved sun, rotation (−92°, −3°, −17°)), cold
arrival at the user's view, first 5 s, three arms in one chain:**

| | churn | p95 step / mean | max | meanLum | then at rest |
|---|---|---|---|---|---|
| old estimator | 19.0 % | 0.70 | 8.3 | 0.138 | 2.2 % · 0.31 · 3.8 |
| Unit 1 alone (`__giSrcFarPrior=false`) — the build the user looked at | **38.6 %** | 1.47 | 10.9 | 0.172 | 0.5 % · 0.13 · 3.5 |
| **Unit 1 + 1b** | **2.6 %** | 0.69 | 8.7 | 0.154 | **0.04 % · 0.07 · 1.1** |

⭐⭐⭐ **THAT MIDDLE ROW IS THE USER'S REPORT AS A NUMBER.** Unit 1 without a
prior of last resort is WORSE than the old estimator on first sight — twice
the churn — because the cold column's orphan bins kept the coin toss and now
voted it at 20 % of a lobe that had nothing else. With the far-field prior the
same arrival is 7× calmer than the old estimator and 50× calmer at rest. The
warm-revisit rows (1.0 % / 5.1 % / 2.5 %) are the "stable on a revisit" the
user reported, on all three arms.

**1b — the cold column's orphan.** Unit 1's merge shrinks a low-confidence bin
toward "look through me" and composites the parent — but a cold column has no
parent corner, and the ORPHAN branch kept the bin's own value unshrunk: the
one-ray coin toss, exactly on first sight, surviving because a warm revisit
always has a parent. Now an orphan shrinks toward the far-field mean
(`L' = c·L + (1−c)·F`, `T' = c·T`; texel 2 of `giFarFieldAvg` ÷ π, the
conversion srcSeed's far prior makes; unprimed → previous behaviour), and the
TOP cascade — which has nothing above it to look through — shrinks its sky
composite the same way, so every level below reads a smooth parent. CPU twins
mirror it via `cfg.farField` (absent in fixtures → identity).
`__giSrcFarPrior = false` reverts.

**1c — THE DARKENING, LOCATED BY READING THE CHAIN.** `srcTiles` stores
`cover = Σ cw·c / Σ cw × maturity` in the atlas alpha; the screen gather's
`covTotal` is that coverage; and giScreen's §13 F3 far-field fill weights the
constant by **`wCov = 1 − knownF`**. `knownF` used to be the SAMPLED FRACTION
(a bin in or out — ~0.58 on a converged lobe); §11.25 made it a CONFIDENCE,
which is legitimately 0.1–0.3 for seconds in any sparse region while the
estimate underneath is already the parent's real, dim light. The linear form
then blended 70–90 % of a cold corridor into the flat far-field constant: dark
(the scene's mean), STATIC (a constant does not move — the "0 % of pixels
moving" reading), and "responding" to a sun step with t50 0.65 s only because
the constant's EMA follows the sun. Same class as §11.20's box feather: a fill
designed for ABSENCE reading a fraction as absence. Fix: the ramp form §11.20
built and left opt-in — full at `knownF` 0, gone by 0.25 (about five rays of
evidence at K = 16) — is now the default (`__giFarFieldCoverageRamp = false`
restores linear). Under the old coverage §11.20 had measured the ramp as "no
measurable difference", which is what makes the flip safe for the
`__giSrcConfidence = false` path too.

**Instrument notes.** (1) The flicker accumulator's readback now reports
`pipelinePending` instead of crashing on `.size` of an unallocated buffer — a
harness Chrome compiling on the same driver held the live editor's compile
queue for the whole window (§11.7's "the harness shares the GPU" again).
(2) A revisit measured right after a `lightResponse` reads the sun's RESTORE
transient (both arms' first "warm revisit" numbers were 62 %/5 % churn against
a real revisit's ~0); the probe now revisits BEFORE the light step. (3) An
`editor.reload` discards unsaved scene changes; one of this session's reloads
reported some and discarded them.

**THE RECEIPT, 1b + 1c together** (`probe:gi-cold-arrival`, sun pinned, two
pins run — (−92, 0, 0) and the user's (−92, −3, −16.9); their directions differ
by 3° and the pictures agree to 5 %, so the earlier "dark regime" was NOT the
parent's rotation and is not reproduced after 1c — kept as a flag, not a
result):

| cold arrival at the user's view, first 5 s | churn | p95 step / mean | max | meanLum | at rest (churn · p95) | warm revisit churn | sun step 25° |
|---|---|---|---|---|---|---|---|
| old estimator | 31.9–38.3 % | 0.66–0.88 | 6.8–9.3 | 0.136–0.138 | 1.1–1.3 % · 0.10–0.36 | 4.2–11.3 % | t50 0.6–0.8 s, t90 3.0–3.3 s, 97 % |
| **Unit 1 + 1b + 1c** | **2.7–3.0 %** | 0.59–0.72 | 4.0–8.2 | **0.148–0.158** | **0.04 % · 0.07** | **0.2–0.6 %** | t50 1.2–1.3 s, t90 3.0–3.1 s, 98–99 % |

Cold-arrival churn 12× lower, rest churn 30× lower, energy +7–16 % (brighter,
not darker — the fill fix holds), t90 unchanged, t50 ~0.5 s slower, the
approach more monotone. `smoke:gi-flicker-watch` green on the build (light
arm t50 1.16 s / t90 3.57 s / 95 %). All five SRC gates green on 1b.

### 11.27 "INSUFFICIENT BOUNCE AND AO" vs THE TRACER — the corner leak is an EXTRAPOLATION, and an unsampled direction now inherits its angular neighbours (2026-09-04)

**The user, two captures of the upper gallery — the path tracer and ours: "I
see insufficient bounce and AO. Can we do something about it?"** What the
eye sees: the tracer is dark under the capitals, where the vault meets the
walls, and at the corridor's far end, and carries a warm halo on the floor
and vault around the sun patches; ours is bright in exactly those crevices,
brighter at the far end, and darker around the patches.

**FACTS FIRST.** (1) Every tier runs `w0 = 4` — 32 direction bins per c0
probe, by design (`w0 = 8` collapsed Bistro's block pool); "ultra" buys
spacing and rays, not directions. (2) The component's `bounce: 0.75` is a
LEVEL label ("High"), not a multiplier — `_giBounceWeightU` is 0 or 1. Not a
lever. (3) **The enclosure-leak ladder on the current build** (`probe:gi-sun-
bounce -- base:sky:occ`, corridor + path-traced truth, `V` = ground-truth
sky visibility):

    open sky   V 1.000  0.89x       wall mid    V 0.181  1.36x
    wall high  V 0.448  0.97x       wall low    V 0.110  1.53x
    floor      V 0.305  1.07x       floor/wall  V 0.282  1.17x
    → open 0.89x, enclosed 1.44x: 1.62x too much light per unit truth in the corners

identical to the 08-30 reading (`gi-cascade-leaks-into-corners`: 0.92x /
1.31–1.50x) with `knownFrac` **0.5126** and `meanKnownBins` 10.32 — the same
four digits as then. Unit 1 changed nothing here, and that is expected: it
changed how much a SAMPLED bin votes, not what an UNSAMPLED direction is
worth, and half of every lobe is unsampled.

**THE MECHANISM, WHICH THE CODE NAMES ITSELF.** `srcTiles`' bake: `E =
π·Σ(L·W)/Σ(W)` over the sampled bins — *"renormalised over the KNOWN bins,
which is unbiased only if those bins are a random subset of the lobe; they
are not — they are the bins rays happened to reach."* An unsampled direction
is worth the lobe's MEAN. In a corner the unsampled directions are the ones
into the crevice, and the mean is the open directions' brightness: the corner
is lit by light no ray measured. Beside a sun patch the same rule dilutes the
patch's bins into the lobe mean: the halo is averaged away. One rule, both
deficits. AO cannot fix it (§2.7d: "do not turn AO up" — GTAO owns the
sub-lattice band; this is the cascade's half, and it is 1.4x bright BEFORE the
AO multiply), and the far-field fill runs AFTER the AO multiply, deliberately
("never re-crush a fallback"), so any share of a crevice pixel that the fill
answers arrives un-occluded as well.

**UNIT 1d — DIRECTIONAL INPAINTING.** The direction bins are a 2w×w equal-area
grid (Morton-stored); every bin has eight angular neighbours (azimuth wraps,
the pole rows clamp). A new pass after the merge ladder, for the two cascades
the tiles bake: a bin with confidence below `INPAINT_LOW` (0.2 — under four
rays at K = 16) takes the confidence-weighted mean of its CONFIDENT neighbours
(diagonals at half weight), blended by `c / INPAINT_LOW`, and carries their
confidence × `INPAINT_DISCOUNT` (0.5). The bake then extrapolates along the
sphere's own structure — dark into a crevice, bright beside a patch — instead
of from the lobe mean. Race-free by construction: a thread WRITES only bins
below the threshold and READS only bins above it, which no thread writes. CPU
twin `srcMath.inpaintBins` (the bake and coverage twins read it), so
`test:gi-src-tiles`/`gather` diff like against like. `__giSrcInpaint = false`
reverts. Cost: one pass over c0 + c1 bins (~280 k at the corridor pose), eight
payload reads each.

**THE GATES:** the ladder (enclosed/open → toward 1.0 with the open anchor
still ~0.9), the five SRC gates, and — because this is a LOOK change —
`profile.lightResponse` + `profile.flicker` at the user's view before it is
called done.

**⛔⛔ REFUTED BY ITS OWN GATE, THE SAME HOUR.** Ladder with 1d armed:

    open sky   V 1.000  0.90x       wall mid    V 0.181  1.43x
    wall high  V 0.448  1.00x       wall low    V 0.110  1.61x
    floor      V 0.305  1.12x       floor/wall  V 0.282  1.19x
    → open 0.90x, enclosed 1.52x (baseline 0.89x / 1.44x): slightly WORSE

and `test:gi-src-merge` (9 875 unknown bins written — the merge gate requires
an unknown bin to stay unknown), `tiles` (12 682/12 960 texels off the
mirror) and `gather` red. Backed out to opt-in (`__giSrcInpaint = true`) the
same hour, gates green again.

⭐⭐ **WHY IT COULD NOT HAVE WORKED, SEEN AFTER THE FACT.** The angular
neighbours of a crevice direction no ray reached are the directions rays DID
reach — the ones that escaped the crevice — so "inherit your neighbours" is
the lobe mean by another road, and the bright side of the blend at that. The
leak is not an extrapolation RULE problem; it is that **an unsampled direction
has no valid stand-in at all.** Half of every lobe (`knownFrac` 0.51, invariant
across a 7x ray range — §2.7d) is unsampled because rays are born at PIXELS:
a probe's directions are the directions its pixels' rays happened to take,
and the directions into a crevice from a probe sitting on the wall beside it
are exactly the ones a pixel-born cosine-ish ray does not take. **The fix is to
sample them** — Unit 2, rays per probe over a full deterministic direction set,
every bin refreshed every K frames — which takes `knownFrac` from 0.51 to ~1.0
and removes the extrapolation entirely. The ladder is its gate: enclosed/open →
~1.0 with the open anchor at ~0.9.

⚠ Also visible in this run's t = 5 s column: every point reads 0.3141 — the
§11.26 far-field prior at a cold boot is a flat constant for the first
seconds, before the sampled bins take over (by 20 s the ladder is converged).
Expected for 1b; noted so it is not read as a bug later.

**Verdict for the user's two captures:** no knob, and not 1d. The corner
brightness and the missing halo are the same unsampled-direction problem, and
Unit 2 is the unit that addresses it. AO stays where §2.7d put it: GTAO owns
the sub-lattice band and is not to be turned up to pay the transport's debt.

## 8. SOURCES

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

### 11.28 THE 45° BIN LIES ABOUT WHERE THE SKY IS — two refutations, a numerical twin, and the radiance centroid (2026-09-04)

**Before building Unit 2 (rays per probe) on §11.27's diagnosis, the
diagnosis was put to two cheap tests on the enclosure ladder, and both
refuted it.**

**Instrument 1 — per-point coverage.** `gatherAt` now returns `coverage`
(the fine lattice's coverage-weighted answer share, `covTotal`), the rig
reads it per point beside the ratio (`cov`), and the runner prints it. This
is the per-point twin of the `knownFrac` statistic §2.7d found blind:

    wallB top (open)   0.91x  cov 0.030 (2/2)     wallB mid   1.36x  cov 0.878 (4/4)
    floor at wall      1.19x  cov 0.896 (5/5)     wallB low   1.58x  cov 0.870 (5/5)
    wallB high         1.03x  cov 0.881 (4/4)     floor ctr   1.07x  cov 0.896 (2/2)

Every corridor point is 87–90 % sampled. A renormalisation over 88 % of the
lobe cannot manufacture 1.44× — `E_k / (0.88·E_k + 0.12·E_m) = 1.44` needs a
NEGATIVE `E_m`. ⛔ "Half the lobe is unsampled" (§2.7d, §11.27) is the
hemisphere FOLD averaged over texels of every orientation (`knownFrac`'s
denominator is the texel's lobe, and a wall probe's lobe texels facing
away from the wall are legitimately empty) — geometry, not starvation, and
not what the wall's own pixels read.

**Instrument 2 — the interval dose-response.** `__giSrcR0OverS0` pins r₀/s₀
at build (`srcConfig.r0OverS0()`, read by the interval ladder, the TSL
boundary and the GTAO band; `?r0=N` / tag `r0N` on the rig). Longer
intervals move the corridor's hits into FINER cells — at 8 the whole 3.5 m
width sits in c0's 0.45 m cells — so a coarse-cascade PARALLAX leak must
shrink with it:

    r0/s0   boundaries (m)          open    enclosed
    1.6     0.72 / 3.6 / 15 / 61    0.90x   1.44x
    4       1.8 / 9 / 38 / 153      0.91x   1.46x
    8       3.6 / 18 / 76 / 306     0.91x   1.47x

It does not move. ⛔ Parallax is refuted. (A tier change cannot test this —
cell and interval both scale with s₀, so the parallax ANGLE is tier-invariant,
which is why §2.7d's "ultra leaks the same" said nothing either way.)

**The sun-bounce ladder, same hour** (`probe:gi-sun-bounce -- base`, no sky):
wallB mid **0.89×**, high 1.00×, low 0.92×, floor 1.01×, wallA shadowed low
0.96× against the 4-bounce truth. ⭐ **Bounce in enclosure is accurate to
~10 %. The 1.4–1.6× leak is the SKY term alone.**

**THE NUMERICAL TWIN.** With sampling and parallax gone, what is left is the
bake's own quadrature: `Σ_bins (L + T·sky)·cw` with ONE `T` per bin and the
bin's WHOLE cosine mass `cw`. A 4 M-direction Monte Carlo of the corridor's
sky visibility, binned exactly as `dirToBin` bins it (2w×w, z-pole), with the
bin-mean `T` applied to the bin's cosine mass, against the exact integral:

    point            V      w=4      w=8      w=16
    wallB top     0.501   1.014x   1.007x   1.003x
    floor at wall 0.288   1.001x   0.999x   1.000x
    wallB high    0.395   1.037x   1.010x   1.001x
    wallB mid     0.160   1.153x   1.054x   1.012x
    wallB low     0.112   1.398x   1.116x   1.019x
    floor centre  0.317   1.010x   1.024x   1.007x

⭐⭐⭐ **THE w=4 COLUMN IS THE LADDER'S SHAPE, ROW FOR ROW** (measured 1.03 /
1.36 / 1.58 for wall high/mid/low; the ~1.1× residual on top is the bounce
share and run-to-run spread, which is ±0.04 on this rig). The mechanism: for a
wall, the sky escapes only at the TOP of a 45° bin — at high elevation,
where the wall's cosine is smallest — and the bin's mean transmittance spends
the whole bin's cosine on it. For a floor the escaping directions carry the
LARGEST cosine, and the same estimator is unbiased (the floor rows). It is
worst exactly where the enclosure is tightest, because that is where the
escape cone is a sliver at the top of a bin. `w0 = 8` would leave 1.12×; the
block pool cannot afford it (§7 of `srcConfig`'s tier table); and the
c1/c2/c3 bins — 22.5° / 11° / 5.6° — already KNOW where the sky is: the merge's
4→1 pre-average throws it away.

**THE UNIT: carry the radiance centroid down the ladder.** The payload's
spare half (word 2, high 16 bits — `readPayload().cen`, `writePayload(…,
cen)`, `decodePayloadCentroid`) carries the OFFSET of a bin's luminance
centroid from its area centroid, two signed bytes in the bin's tangent frame
(`binFrame`, `encodeCentroidOffset`/`decodeCentroidOffset`; code 0 and 0x8080
both read as zero, so the resolve — which has no sub-bin information — writes
nothing new). The merge's corner loop keeps two moments per corner: `pO`, the
luminance-and-vote-weighted sum of each child's AREA MEAN VECTOR plus its own
carried offset (where the radiance sits), and `pR`, the vote-weighted sum of
the centres alone (where a uniform radiance would sit); the merged bin's
offset is `ownT·(ΣpO − Σlum·pR)/lum(outL)`. The bake spends the cosine at the
centroid: `wL = cw + (n̂·o)·s` — `cw` is the bin's MEAN clamped cosine, the
table's units — with `s = clamp(cw / 0.25)` fading the correction out on a
bin grazing the texel's horizon. Cosine is LINEAR in
direction, so for a bin inside the hemisphere this is exact for any
distribution of radiance inside the bin — and the top cascade's 5.6° centres
reach c0 through the recursion. No new buffer, no new binding on [E], no
knob; `__giSrcCentroid = false` reverts to the byte-identical previous bake.

⭐⭐ **TWO CUTS DIED IN THE FURNACE GATE BEFORE THE OFFSET FORM, AND THE
LESSON IS WORTH THE PARAGRAPH.** The first carried a unit DIRECTION (the
centroid itself, octahedral 8+8) and corrected against `binDir`, the cell's
centre: `test:gi-src-ref`'s furnace read `|E − π| = 24.8` — a grazing bin
whose cosine mass is a hundredth of Ω took a correction of a tenth of Ω,
because the merge's mean-of-unit-vectors for a UNIFORM field is not the cell
centre (nor, after confidence weighting, any fixed reference). Swapping the
reference for the area centroid left 4.45. Only an OFFSET is linear: the
weighted mean of zero offsets is zero for any weights, at every level, so a
uniform field is exactly uncorrected by construction — and a third cut that
averaged the children's offsets alone was exactly zero EVERYWHERE (the top
level has no offset to average), which the new merge-gate arm caught as
"0/784128 bins carry a non-zero offset". The sub-bin information is the
children's CENTRES; the offset is the luminance-weighted centre minus the
vote-weighted one.

⭐⭐ **AND A THIRD CUT DELIVERED 40 % OF ITSELF, WHICH THE LADDER CAUGHT AND
THE GATES COULD NOT.** With the offsets carried, the ladder did not move
(1.44× → 1.44×). Two instruments settled where the loss was: the rig's payload
readback showed the merge WRITING offsets (c0: 20 994 of 26 528 bins, mean
|o| 0.067), and a live strength uniform on the bake (`tiles.centroidStrength`,
0/1 on the SAME converged field — no reboot, no run-to-run spread) showed the
correction moving wall-low by only −5 %. A dump of the wall-low probe's chain
(`out.chain`: its eight c0 corners' bins with L, T, c, n̂·o and their four c1
children) re-baked through the mirror's formula reproduced the GPU's 0.95 —
so the twins agreed and were both wrong: `binCosineWeights` stores a bin's
MEAN clamped cosine (0..1), not its cosine MASS, and the correction carried a
spurious `Ω = 4π/32` (0.39). The exact term is `cw + n̂·o`, no solid angle.
The tiles gate passed with offsets in the field because both twins carried
the same factor — a gate that diffs twins cannot see a shared unit error;
only the ladder's truth could.

**Gates:** `test:gi-src-ref` and `-math` (the furnace, the enclosure ladder,
the open-arm furnace: all PASS); `test:gi-src-merge` with a new ARM 4b —
every merged offset within two quanta of `mergeCascades` (worst 0.0079, one
quantum; 97 380 of 784 128 bins carry a non-zero offset, so the arm is not
vacuous); `-tiles`, `-gather`, `-temporal`, `-deposit` all PASS.

**RECEIPTS.** In-situ on/off (the strength uniform, one converged field):

    point            with bounce    without bounce (nosec)
    wallB high         0.943           0.933
    wallB mid          0.913           0.881
    wallB low          0.885           0.835
    floors, open       0.997–1.003     0.997–1.006

The ladder, sky arm (60 s settle): open 0.90×, enclosed **1.44× → 1.33×**
(wall low 1.52 → 1.38, mid 1.36 → 1.28, high 0.97 → 0.93). The `nosec` arm —
the direct term alone, against the 4-bounce truth — reads wall low **1.01×**,
mid 1.03×, floor at wall 1.04× (enclosed/open 1.14×, was 1.60×).

**Where the residual is, by instrument.** A dump of the wall-low probe's
bins (`out.chain`) re-baked against the corridor's exact per-bin sky
visibility: the bins' sky transmittances are right to ~3 % (bins toward the
corridor ENDS +5 % — a c2-cell parallax, the one leak the r₀ sweep could
not see because those hits are 6 m away in every arm); the offsets recover
85–95 % of the true offsets; the direct term lands at ~1.05×. What is left
in the full arm is the HIT radiances — 1.2–1.5× at the most enclosed hit
points (wall A's foot, the floor at the wall), i.e. the leak at those points
compounding through [J]. With a 120 s settle (the bounce
converging under the corrected tiles) the same arm reads open 0.91×, enclosed
**1.24×** (wall low 1.29, mid 1.19, high 0.92, floor at wall 1.16), in-situ
−13 % at wall low — the 60 s column was still descending.

**Sponza receipts at the user's gallery view (env lighting OFF — the sky term
is zero there, so this is a no-regression check, not the fix's arena):
flicker 0.7 % churn, p95 step 0.028× mean, 0.0001 rev/px/frame at 95 fps;
sun step t50 1.7 s, t90 4.0 s, 97 % monotone at 85 fps.**

**Cost:** the merge reads the same four children it always read, plus a
per-child frame (two cross products); the bake reads one more table per bin
and a per-texel direction; no atomics, no bindings on the [E] kernel.

⚠ **THE USER'S SPONZA REPORT IS NOT THIS UNIT.** Their scene has environment
lighting OFF, so the sky term this unit corrects is zero there. The two code
paths that can put light on a shadowed face there: the reflection chain's
env-miss tap, which samples the BACKGROUND HDRI at intensity 1 whether or not
lighting is on (`GISystem` `_giEnvMissIntensityU`: `bg ? 1`), and the
far-field fill on low-coverage faces. Asked the user to toggle `reflections`
off as the one-look split; untested at the time of writing.

### 11.29 THE DIRECT-SKY TERM IS 1.55× IN A TIGHT ENCLOSURE UNDER ANY SKY — the HDRI arm, the direct-sky truth, and where the rest of the leak lives (2026-09-04, later)

**The user, Bistro vs the tracer: "very blurry and flat, and AO is still too
bad", then "even in places where there is normal AO, the final color looks
very flat", then 10 fps (my ray-budget A/B — restored; 25 fps is the pose's
own number).** Region means of their two captures at one pose, display space
(≈ linear^0.45): sunlit cobbles **1.01×**, shadowed cobbles 1.10×, sunlit
facade 1.25×, arch 1.29×, shadowed wall 1.34×, under the awning 1.36× —
every shaded region ~1.9× in linear light, sun calibrated.

**Ruled out at the user's pose by screenshots (permission given):** the
far-field fill (off vs on: identical; `fillFrac` 0), reflections (off:
identical), starvation as the cause of the flatness (ray cap off + 4.4× rays:
`knownFrac` 0.15 → 0.40, picture barely moved), three's IBL (suppressed while
GI is live), the HDRI's sun disc (4° elevation, 0–4 % of E). What the HDRI
DOES have is a bright horizon: a vertical wall receives 0.7–1.1× the ground's
sky irradiance, the zenith is dim.

**Instrument: the corridor rig lit by the user's HDRI** (`?hdri=1` / tag
`hdri`, `scripts/.gi-fixtures/industrial-sunset-2k.hdr` served by vite; the
reference's `irradianceAt` takes `skyL` as a FUNCTION of direction —
`loadHdrSky`, an RGBE decoder using three's `equirectUV` convention; and it
now returns `skyDirect`, the sky seen at depth 0, which is what a `nosec` arm
must reproduce). Analytic open-point E 1.3576 (×0.5), MC 1.368 ✓.

    direct-only (nosec) vs skyDirect        V      flat sky   HDRI   HDRI r0=4  r0=8
    wallB top (open)                      1.000    0.9x      0.95x  0.97x     0.97x
    wallB high                            0.448    —         0.89x  0.94x     0.95x
    floor at wall                         0.282    —         1.20x  1.17x     1.21x
    wallB mid                             0.181    —         1.35x  1.32x     1.37x
    wallB low                             0.110    1.6x*     1.55x  1.71x     1.71x
    floor centre                          0.305    —         1.12x  1.10x     1.09x

⭐⭐ **THE TWO SKIES AGREE.** (*) §11.28's flat-sky `nosec` arm read wall low
**1.01× against the 4-BOUNCE truth** and I called the direct term fixed; read
against its DIRECT truth (V·π·L = 0.0346) it is 0.0542 = **1.57×** — the
"1.01" was a coincidence of a leaked direct term against a truth that
includes bounce. With bounce on, the bounce part reads 1.0–1.15× under both
skies (base − nosec against sky − skyDirect), so the enclosure leak IS the
direct-sky term, and it is 1.55× at V 0.11 after the centroid (1.84× before).

⛔ **Parallax refuted a second time, under the HDRI:** r₀/s₀ 4 and 8 read
1.71× — WORSE, because pushing every hit into c0 puts all the visibility into
one 45° own-transmittance with no sub-bin structure at all.

**Where the residual lives, from the wall-low dump (§11.28's chain dump,
re-baked):** the bins' T̄ are right to ~5 % (bins toward the corridor ends
+5 %); the bake at the +x texel is 1.07× after the units fix; the GATHER reads
~1.12× the single-texel bake (the octahedral seam tap averages texels ±11°
off +x, the corner blend, and the coarse-lattice fallback's 12 % from a 0.9 m
cell that sits higher up the wall); and the merge's own formula carries a
channel I can name: **the confidence look-through `T′ = 1 − c + c·T`** lets
`1 − c` (≈ 5 % at c 0.95) of the parent through a bin that MEASURED T = 0, so
a fully blocked direction leaks ≈ (1−c)·(parent's sky) at every level — at
V 0.11, +10–20 % of the truth, weighted toward the sky's BRIGHT part under a
horizon-lit HDRI (the blocked hemisphere of a wall is the bright one).
**The A/B that named it (`nosec:hdri:noconf`, `__giSrcConfidence = false`, c ≡ 1):**
wall low 1.55× → **1.19×**, mid 1.35× → 1.07×, floor at wall 1.20× → 1.08×,
enclosed/open 1.53× → **1.11×**, and the open point 0.95× → 1.02× (the shrink
was dimming it too). The §11.25 prior is the leak's home.

**THE UNIT (§11.29): the prior must let go.** `c = N/(N+K)` keeps `K/(N+K)` of
the prior forever. Now the prior's share collapses with evidence:
`1 − c = K/(N+K) · e^{−N/F}`, F = `CONFIDENCE_FULL_RAYS` 64
(`srcMath.confidenceOf`, the deposit's resolve is its f32 twin;
`__giSrcConfidenceFull` moves F, 0 restores the plain form). c at 1 / 16 / 64 /
150 / 300 rays: 0.07 / 0.61 / 0.93 / 0.991 / 0.9995 — the first twenty rays
(the cold-arrival win of §11.26) are untouched to the first decimal; a
converged bin is its own measurement. Gates: ref, math, deposit, temporal,
merge all PASS.

    direct-only vs skyDirect     V      §11.28    +§11.29    (noconf)
    wallB top (open)           1.000    0.95x     1.00x      1.02x
    wallB high                 0.448    0.89x     0.89x      0.90x
    floor at wall              0.282    1.20x     1.12x      1.08x
    wallB mid                  0.181    1.35x     1.17x      1.07x
    wallB low                  0.110    1.55x     1.31x      1.19x
    floor centre               0.305    1.12x     1.05x      1.05x
    enclosed / open                     1.53x     1.24x      1.11x

    with bounce (base:hdri) vs sky     §11.28    +§11.29
    wallB mid / low                    1.27/1.40  1.12/1.20
    enclosed / open                    1.40x      1.16x

Coverage rose 0.88 → 0.92 (a fed bin now votes at ~1), the carried centroid
offsets grew (c0 mean |o| 0.068 → 0.108 — less dilution by low-c votes) and
the in-situ centroid correction with it (wall low 0.808). The 60 s column was
still descending at wall low. The gap to `noconf` (1.31 vs 1.19) is what the
prior still holds at 30–100 rays plus the vote weighting; Unit 3 (confidence
from evidence, not a decayed weight) owns it.

**Receipts on the user's Bistro (env lighting ON, their pose):** at rest 0.2 %
churn, p95 step 0.055× mean, 1 % of pixels moving; sun step (9 % of the
picture — a sky-dominated view) t50 2.0 s, t90 4.9 s, 95 % monotone. ⚠ Both at
16–18 fps — the pose's own 25 fps is the next mandate (their words: "after
we settle proper GI look, work on performance"); the 10 fps they saw was my
ray-budget A/B (cap off, 4.4× rays: 115 ms of GI), restored.

**Still open on Bistro, named and not touched:** starvation (`knownFrac`
0.15, every c0 probe starved, 7 rays/probe/frame at rest — Unit 2); the
reflection BVH seats the 128 largest of 487 eligible meshes and 359 props
overflow into a path with 8 coverage slots — the user's "some meshes appear
white in reflections" lives there; GTAO at one c0 interval (0.56 m at ultra)
is a contact term and reads near-white in the `ao` view on this scene.

⚠ Housekeeping from the screenshot session: the GI component's `debugView`
was persisted as "path-tracer" by autosave when the editor dropped mid-run
(the MCP screenshot cannot see the tracer's canvas — only puppeteer's
`page.screenshot` can, per the Cornell rig's note); set back to "off" on
reconnect. All live flags restored (`__giFarField`, `__giSrcProbeRayCap`,
`__giSrcTransportRays` → null; `reflections` 1).

**Bistro is this, amplified**: coverage 0.15 (so the coarse fallback and the
extrapolation carry more of every pixel), a horizon-bright sky, and street
canyons at V 0.2–0.5.

### 11.30 THE RAY DISTRIBUTION, NOT THE TOTAL — cap 8 on every tier, 8 starvation packets (2026-09-04, evening)

**The user, Bistro: "very blurry and flat"; then "10–11 fps … unplayable.
After we settle proper GI look, work on performance."** The look and the
frame turned out to be one dial.

**The receipt that named it** (`profile.giPasses` at their pose, ultra,
12.5 k visible c0 probes): `raysPerFrame` 89 k at the rest cadence, EVERY c0
probe flagged starved, `knownFrac` **0.15** — a texel knew 3 of its 20 lobe
bins, and the picture was those three bins extrapolated over the lobe (§2.7d's
"biased subset", here at its worst). 89 k rays for 12.5 k probes would refresh
every bin every few frames IF they were shared; born per pixel, the near
probes took the ultra cap of 32 and the street took nothing. Lifting the cap
and 4.4× the rays (§11.29's A/B) bought `knownFrac` 0.40 for 115 ms of GI —
the total is not the lever.

**The lever is §11.17's starvation floor.** `__giSrcStarvePackets` 2 → 8
(live): `knownFrac` 0.15 → **0.80**, `meanKnownBins` 3.1 → 16.0, starved
12 569 → 5 837, c0 orphans 11.6 → 3.5 %, LOS-suppressed 33 k → 2.5 k,
unattributed 12 → 4.9 % — at 190 k rays (SRC chain 48 → 66 ms). Then the cap
32 → 8 (`__giSrcProbeRayCap`, live) WITH the packets: `knownFrac` **0.80
held at 30 k rays** — the SRC chain **48 → 19 ms** ([J] 25 → 7, deposit 15 →
4.6), **25 → 35 fps** at the pose, and the shadowed street's gradient and
contact darkening visible in the screenshot for the first time.

    Bistro, user's pose            rays/frame  knownFrac  SRC ms   fps   t50/t90 sun step
    before                            89 k       0.15      48      25    2.0 / 4.9 s
    packets 8                        190 k       0.80      66       —
    packets 8 + cap 8                 30 k       0.80      19      35    0.9 / 2.4 s, 99 % mono

Flicker at rest unchanged (0.2 % churn, p95 0.083× — the user moved the
camera during that window). The corridor rig with the same dials: sun-bounce
ladder 0.99–1.11× (energy-neutral, §12.40.4's verdict again; the rig reads
0.89–1.01 either way), HDRI 4-bounce enclosed/open 1.22× at 60 s with the
column still descending (fewer rays converge slower — not less energy).
`test:gi-src-rays` and `-deposit` PASS.

**Shipped as tier defaults:** `probeRayCap` **8 on every tier** (was
16/16/16/32 — the surplus it denies is the same surplus at any tier) and
`STARVE_PACKETS` **8** (was 2). ⚠ A running editor does NOT pick up
`srcConfig` constants on hot reload — clearing the live flags read the cap
back as 16 on their session — so the user's session runs the same values as
live overrides until their next editor start. ⚠ The starved count reads
HIGHER under the cap (8 842) while coverage holds at 0.78–0.80: the flag
measures evidence weight per probe, which the cap lowers on the fat probes;
coverage is the number that matters.

**What this is not.** Unit 2 (rays born per probe over a deterministic
direction set) is still the design that removes the pixel-footprint skew at
its root; this is that design's cheap 80 %: the floor already fires packets
from a probe's representative pixel in successive ray slots, and the cap
already denies the fat probes. Bistro's remaining look items: the direct-sky
enclosure residual (§11.29, 1.31× at V 0.11), the 128-mesh reflection BVH cap
(the white props), GTAO's contact-only reach.

**Flicker A/B at one pose (the user's second Bistro pose), packets 8 both,
`stillOnly`:** cap 32 — 0.63 % churn, 7 % of pixels moving, p95 step 0.105×
mean, 19 fps; cap 8 — 0.08 % churn, 0.4 % moving, p95 0.12×, 35 fps. The cap
does not cost stability (§12.40.4's α compensation holding), and the p95 band
(0.10–0.12×) is this pose's, not the cap's.

### 11.31 THE FLOOR DEADLOCKED A COLD FIELD — the starvation floor gets its own budget (2026-09-04, evening)

**The user, after an editor restart on Bistro: "this is indirect, half of the
screen is just grey, half is excessively white. Indirect got much worse."**
`profile.giPasses`: 15 681 live c0 probes, **0 rays per frame**, 15 678
starved, the deposit and [J] at 0.1 ms — a populated field with a dead
transport, and the picture was the fallbacks of an empty field (the far
constant's grey below, the sky-facing extrapolation above).

**The mechanism, from `srcRays`' priority pass:** a starved probe claims
`packets × raysPerPixel` tickets with `atomicAdd(rayTotal, want)` and is
ACCEPTED only if `ticket + want ≤ ceiling` — but the add has already
happened. With §11.30's 8 packets on a cold field (every visible probe
starved after a restart), 15.7 k × 16 = 250 k tickets were requested against
a 196 k rest ceiling; the denied claims inflated the counter past the ceiling
and every pixel claim in [D1] behind them was refused. Zero rays → no
evidence → every probe stays starved → zero rays: a fixed point. The old
2 packets (50 k) could never reach it. (The first session's rebuild that
preceded this — a pool grow after a §12.56 watchdog re-roll during the user's
browser-preview build — retired the store and left it cold, which is when the
floor's demand peaked.)

**Fix:** `rayTotal` grows a second word — the floor's OWN dispenser, bounded
to `STARVE_SHARE` (0.5) of the ceiling — and only an ACCEPTED floor claim
touches the shared counter; the walk order rotates with the frame
(`(index + frame·1103) mod capacity`) so the budget's tail is a different
tail each frame. Cold (non-starved) one-packet claims ride the shared counter
as before. `test:gi-src-rays` and `-deposit` PASS. ⚠ A kernel edit does not
reach a running editor reliably (module duplication): the live receipt below
was taken after the user's restart.

### 11.32 STATIC DRAWS — the marker that kept every object on the per-frame path (2026-09-04, evening; OPT-IN, unmeasured)

**The user, after the ray-distribution win: "after we settle proper GI look,
work on performance."** `profile.cpuFrame` at their Bistro pose: **27.3 ms
CPU**, of which `renderEncode` 15.4 ms (56 %) and `gi.gbufferPrepass` 5.8 ms —
draw submission, 457 draws, ~35 µs each (the §bistro-cpu-is-draws finding).
GPU 28 ms. Both halves need work for 60 fps; this unit is the CPU half.

**Why bundles and `object.static` never paid** (memory
`render-bundles-blocked-by-gi-marker`, now acted on): `#markObservedMaterial`
stamps `giMonitorNode` on every lit material so three's
`NodeMaterialObserver.hasNode` is true, which makes `needsRefresh()` return
true for every object every frame BEFORE the static/bundle branch — so the
per-object JS path (updateBefore / geometries / nodes / bindings) runs ~460×
a frame whatever the scene does. Three's build installs no `getShadow`/`getAO`
context (checked), and the GI module has no per-object node updates
(checked), so the marker is the only thing in the way.

**What the marker bought, replaced by construction (`__giStaticDraws = true`):**
- GI's per-frame uniforms are in the shared render group (21 sites already;
  `GICascadeLightNode.intensityUniform` moved there) — the first refreshed
  object of each render uploads the shared buffer, every object reads it.
- A target swap (resize / rebuild re-points the persistent texture nodes)
  calls `#invalidateObservedMaterials`, which bumps every observed material's
  version so its render objects rebuild their bindings ONCE — the event the
  per-frame marker was standing in for.
- `merging.js`' colour proxies declare `static` (they never move: world-space
  vertices, rebuilt on any member change); `shadowMerge` already did.

**To measure after a restart with the flag armed:** `profile.cpuFrame`
`renderEncode` (expect several ms off), `profile.frameStats` fps; then
`performance.renderBundles` on top (the GPU-side encode). **Correctness
receipts required before default-on:** a viewport resize keeps GI lit (the
invalidation), a GI quality change, a debug-view toggle, the flicker and
light-response windows unchanged. ⚠ Uber-material proxies (colorNode of their
own) stay on the refresh path by three's rule; unmerged meshes too (~200
draws on this scene) — the next step there is the same `static` on meshes
whose transform the editor has not touched, cleared by the transform tools.

**The user's two mobility notes, for the record:** `giMobility` is a
TRANSPORT tag (static BVH vs mover proxies) and does nothing for raster
draws; a LIGHT mobility (static / movable) is the GPU-side twin of this
unit — a scene whose lights are declared static never arms the light-track
machinery and can run the transport at a converged cadence (the SRC chain's
14–19 ms is rays that re-measure a field that is not changing). Queued.

**§11.32, first live receipt (the user, moving the camera on the static path):
"screenspace GI gets desynced from the viewport" — the lighting one frame
behind the geometry.** Root cause, from the uniform list: `light.giViewProj`
(the light node's per-frame view-projection for the GI screen lookup),
`_giResolveCamU`, the shadow/emitter texel sizes, the toggles — 42 persistent
GI uniforms — were plain `uniform()` calls, i.e. three's per-OBJECT group,
so each lived in every render object's own buffer, and a `static` object
never re-uploads that buffer: it projected into LAST frame's GI screen.
GI has no per-object uniform at all; every one of them is a per-render
value. All 42 now `.setGroup(renderGroup)` (one shared buffer, uploaded by
the first refreshed object of each render, read by all) — which is also
fewer uploads per frame with the marker on. Re-measure after a restart.

### 11.33 "DESTROYED TEXTURE [output] USED IN A SUBMIT" — the g-buffer was per-build while a material bound it (2026-09-04, afternoon; SHIPPED, user-verified)

**The report (the user):** "we quite often get this error when changing any
scene or gi params: `[gpu] UNCAPTURED DEVICE ERROR: Destroyed texture
[Texture "output"] used in a submit. — While calling Queue.Submit(
CommandBuffer from CommandEncoder "renderContext_0")`."

**Reproduced on demand:** `profile.giFlag` with any rebuild → a burst of the
error on the MAIN pass (renderContext_0), two per frame, for ~13–30 frames,
then silence (two bursts read: 26 and 60 errors). `output` is the GI
G-BUFFER's position attachment (`createGiGBuffer`: `rt.textures[0].name =
"output"`).

**Root cause, three facts that were each true and together a bug:**
1. `#buildScreenResolve` created a NEW g-buffer on every build and `#dispose`
   destroyed the old one on the spot ("the gbuffer is per-build; the resolve
   TARGETS are not — no material is bound to it").
2. `_giShadowPosNode` (the shadowNode's tap validity, giLight's irradiance
   bilateral) is a PERSISTENT texture node whose `.value` is re-pointed at
   each build's g-buffer position — i.e. the g-buffer IS material-bound, and
   has been since that node landed. Fact 1's premise had silently expired.
3. Under §11.32 static draws a `static` object's bind groups are never
   revisited, so after a rebuild they still held the destroyed view. (Under
   the per-frame marker three re-created the disposed texture on the next
   refresh — a garbage upload nobody noticed — which is why this never
   printed before §11.32.) The burst ENDED when the compile wave happened to
   recreate the render objects.

**The fix (`GISystem.js`, `giScreen.js`):**
- The g-buffer is SYSTEM-LIFETIME (`#persistentGbuffer`): created once,
  resized in place, disposed only with the system. The rule it encodes: a
  texture that materials bind is never per-build.
- `gbuffer.setSize` bumps every attachment's `texture.version` from the one
  `targetGeneration` counter. three's `RenderTarget.setSize` disposes the GPU
  textures but leaves the version alone, and `Bindings._update` decides "same
  texture" by version (`binding.generation` vs `textureData.generation`) — an
  unbumped resize keeps the destroyed view in every bind group.
- `#refreshRenderObjectsOnce(reason)` — ONE guaranteed refresh per render
  object after any re-point: it resets every cached NodeBuilderState
  observer's `renderObjects` WeakMap, so `firstInitialization()` (which
  returns true BEFORE the static/bundle short-circuit) fires once per render
  object on the next render. ⛔ `material.needsUpdate = true` (the §11.32
  first cut) does NOT do this: with an unchanged cache key
  `RenderObjects.get` only syncs the version — no binding update. Called at
  every re-point: screen-resolve build, target resize, g-buffer resize, BVH
  reflect target (resize + recreate), env-miss (on change), atlas rebuild,
  the reflections toggle. Retired targets keep their 3-frame TTL, so the swap
  and the refresh never race. `__giLogStaticDraws` prints each reset
  ("172 observers reset (atlas-rebuilt)").

**Receipts:** the same `profile.giFlag` rebuild on the restarted editor → 0
errors (was 26–60 per rebuild); `smoke:gi-flicker-watch` PASS (light step
t90 3.0 s, 95 % monotone); the user: "destroyed texture is fixed".

**§11.32 measured on the same restart (no-marker boot, Bistro, parked):**
`profile.cpuFrame` 18.0 ms total — renderEncode 6.1 ms @ 262 draws (~23
µs/draw; the marker boot read ~15 ms @ 460 draws, ~33 µs/draw), preRender
9.3 ms of which `gi.gbufferPrepass` 6.2 ms (unchanged: that pass is the scene
walk, not the draws), merging 1.9 ms. `bound: "gpu"` — GPU 25.5 ms. So the
CPU is no longer the wall at this pose; the frame is the GPU's. That reframes
"no payoff from mobility / bundles": the only lever left with a payoff is
GPU, and §11.34 is that lever.

### 11.34 LIGHT MOBILITY → CONVERGED IDLE — the GPU payoff the mobility props never had (2026-09-04, afternoon; SHIPPED, default on, opt-out `__giWorldIdle = false`)

**The user:** "I am not sure our gi mobility prop actually helps here anyhow,
though it was added as gi optimization"; "those mobility props should be
added to lights as well (where light changes or not)"; "continue on gi
mobility and render bundles, we still don't have pay off from them".

**Why there was no payoff, structurally.** Mesh `giMobility` decides how a
MOVER is represented in the transport (static BVH vs exact proxies) — a
quality/cost trade only when something moves, never a frame-time lever on a
parked scene. Render bundles / `static` draws (§11.32) are a CPU lever, and on
this restart the CPU is no longer the wall (§11.33: 18 ms CPU vs 25 ms GPU,
`bound: "gpu"`). And the transport already DETECTS stillness on its own: the
rest cadence (§12.61) halves the ray ceiling and runs the world chain at 15 Hz
on alternate frames when the drive is ~0. What no detector can supply is
PERMISSION TO STOP: a rest rate exists because the system cannot know the next
frame will be as still as this one, so it keeps converging a field with
nothing left to learn — measured `profile.giPasses` on the user's Bistro:
the world chain is ~20 ms per dispatch (shade+bounce 9.7, deposit 4.7, tiles
1.4, merge 1.3 …), i.e. ~10 ms of every rested frame.

**The unit.** `LightComponent.mobility` = `"movable"` (default) | `"static"`
(→ `light.userData.giMobility`, inspector select). `GISystem#worldIdleGate`:
when EVERY light is static, the rest drive is < 0.05 and the static field-
hash sections (lights / emitters / sky / knobs — NOT the movers' `dyn`
section: a walking character must not keep the world awake, its GI rides the
mover path) have held still for `GI_WORLD_IDLE_AFTER_MS` (3 s), the world
chain is not dispatched at all. Any drive (a light drag, a camera move, the
`profile.lightResponse` sun step), any static-input change, a rebuild or a
compile wave wakes it on that frame — the wake path IS the ordinary rest →
active transition. Receipts: `profile.frameStats.giHold.worldIdle /
worldIdleFrames / worldIdleReason` ("1 of 1 lights movable", "not rested
(drive 0.32)", "resting 1.2 s of 3", "inputs changed", "compile wave",
"idle"). Harness hatch `__giLightsStatic = true` declares every light static
(`smoke:gi-flicker-watch LIGHTS_STATIC=1`).

**Receipts on the user's Bistro (parked, the user set the sun to static):**

| | fps | gpuMs | worldIdleReason |
|---|---|---|---|
| idle OFF (`__giWorldIdle = false`) | 26 | 51.3 | off |
| idle ON | 27–35 | 40.2–44.7 | idle (1263 frames) |

−10 ms of GPU per rested frame, exactly the world chain's alternate-frame
share. The remaining ~40 ms is the render side (main pass with the GI gather
compiled into every material, the prepass, reflections) — §18's territory.

**The smoke's first run FAILED its idle receipt ("resting 0.0 s of 3" with
`rested true`)**: the hold timer was keyed on `worldRested`, which also
excludes the compile wave, and on the smoke's Sponza the wave toggles for
seconds after boot — the clock restarted every time. Fixed: the timer follows
the DRIVE alone; a wave holds the sleep back ("compile wave") without
resetting the clock. The wake receipt passed on that same run (0 idle frames
after the 25° sun step, t90 3.4 s, 95 % monotone).

**Not in this unit, named:** a static light's SHADOW MAP still re-renders for
movers (UE-style cached static shadows are their own unit); the idle is
parked-camera only — a moving camera through a converged static world still
pays the full transport (the next step is a "converged motion" mode: rays for
starved probes only, no decay, once every light is static).

### 11.35 "THE AO IS BLURRY AND SHIT" — three blurs, and the AO moves to the viewport's resolution (2026-09-04, evening; SHIPPED for ultra/high, `__giAoFullRes = false` opts out)

**The report (the user, Bistro AO debug view, 11 fps pose):** thin faint
creases, everything soft. "fix our ao, it is blurry and shit".

**Instrument first — the native texel dump.** A viewport screenshot resamples
the AO buffer twice (debug view → canvas, capture → its own size) and always
reads soft, so `probe:gi-gtao CAPTURE=1` now also writes `ao-texels-*.png`:
one PNG pixel per AO texel. That picture said it plainly: the AO BUFFER was
429×242 for an 858×484 rig viewport (1140×667 for the user's 1612×943 — the
RESOLVE's resolution, half the viewport per axis on the user's editor because
the frame governor's `giCostScale` halves the resolve's pixel budget), then
filtered ±3 texels, then bilinearly reconstructed 2× inside the half-res
irradiance. Three blurs stacked: ±6 viewport px of filter on a 2× upsample.

**What does NOT work at half resolution (rig arms, all at 429×242):** no
filter → the 4-phase radial strata print as diagonal dashes; 16 fixed steps
without phase and without filter → concentric rings around every contact
(the rings are the tap radii; at full res the reach in pixels doubles and the
rings would need 32+ steps to hide); 8 steps with a ±1 filter → both. "No
noise, no steps" cannot be bought at half resolution; the filter IS the
noise budget, and the resolution is what sets its width in viewport pixels.

**The unit.**
1. The g-buffer prepass renders ONCE, at AO resolution: `gbufferFull` = the
   drawing buffer (DRS divided out, like the resolve) capped at
   `GI_AO_MAX_PIXELS` (2.1 MP, isotropic), on ultra/high only. The prepass's
   CPU (the scene walk) does not depend on pixels; its raster does, mildly.
2. `createGiGBufferDownsample` — a QuadMesh MRT pass that POINT-SAMPLES the
   full g-buffer into the resolve-sized `gbuffer` every other consumer reads
   (25 load sites in giScreen.js, srcSystem's probe population, the shadow
   tap validity node). The chain is untouched and cannot tell the difference;
   the probe's downsample check reads mean |ΔP| 0.000 m at the mapped texel
   (2.8 m at its vertical mirror — the one silent failure mode, excluded).
3. The GTAO pass reads the full g-buffer one-to-one; `projScale` is scaled
   to the source grid (`srcH / height`) — ⚠ derived AFTER `_giAoProjU`'s
   `??=`: `float(undefined)` is not a build error but a silent ZERO, and a
   zero projScale clamps every reach to the STEPS×MIN_STEP floor (first run:
   contact 23 % → 10 %, raw p05 0.83 → 0.95; the ordering fix restored 25 %).
4. The term is applied IN THE MATERIAL: `GICascadeLightNode.giAoNode`, a
   persistent TextureNode (a 1×1 white placeholder while a tier keeps the
   resolve path), sampled bilinearly at the pixel's own GI screen UV and
   multiplied into the deferred irradiance (diffuse indirect + emitter
   direct; the sun's analytic term is untouched, as before);
   `giAoActiveU` (render group) is the live `ao` toggle. `createGiResolve`
   drops a `materialSide` AO slot, so the half-res irradiance no longer
   carries it. Every re-point goes through `#refreshRenderObjectsOnce`
   (§11.33). Medium/low keep the old path (their AO is coarser than the
   resolve and needs the resolve's edge-aware 2×2 reconstruction).
5. Presets: `giGtaoResolutionScale` ultra 1, high 0.75 — relative to the AO
   g-buffer now; medium 0.8 / low 0.5 relative to the resolve, unchanged.

**Receipts (rig, ultra):** AO buffer 606×342 over g-buffer 429×242, contact
25.2 % darker (baseline 23.4 %), raw p05 0.836 (0.833), finite, 0 page
errors, gtao group 0.254 ms (0.176 at half: ×1.44 for ×2 pixels). The
native dump at 606×342 is visibly crisper than the 429×242 one; what blur
remains is the ±3 filter at ONE viewport pixel per texel (was two).

**Open, named:** the filter radius at full resolution (r2 leaves the phase
dashes — a 2×2 phase layout with an exact [1,2,1]² kernel would remove them
at ±1 px; queued); the cost on the user's viewport after a restart
(`profile.giPasses` gtao + the prepass); the AO's REACH (one c0 interval,
0.56 m at s0 0.35 — the tracer's broad darkening under the arches is the
field's corner leak, §11.29's Unit 3, not this term's).

**§11.34 addendum — the smoke's second failure and the final receipts.** With
the timer fixed, `LIGHTS_STATIC=1` still read "inputs changed" on Sponza:
the gate keyed its emitter inputs on the field hash's `emitters` SECTION,
which mixes the SEAT slots — and seats rotate on the module's own cadence
(§11.15), so with more lamps than seats the section ticked every rotation.
The gate now keys on the scene's emissive SET (`_emitterCands`: mesh
radiance + world position), which is what "an emitter changed" means.
Receipts (`smoke:gi-flicker-watch LIGHTS_STATIC=1`, twice): parked →
`worldIdle true` (100 / 151 frames, breakers lights 0 emitters 0 sky 0
knobs 0, dyn ticking as it should); the 25° sun step → 0 idle frames since,
t90 2.7–2.9 s, 95 % monotone. The default smoke (movable light) passes
unchanged (parked 52 fps, t90 3.25 s) — the AO material node did not move
the field. ⚠ Both static runs logged `[gpu] DEVICE LOST (destroyed)` — the
timestamped run puts it at BOOT (13:24:12, twenty seconds before the field
existed, on the hub → project → scene path), not in any arm; the smoke's
summary counts it as a failure and is honest to do so, but it is the boot
path's device rebuild, not this unit's.

**§11.35 addendum — the user's verdict, and the reach.** After the restart
the boot log read `AO … at 1612x943` (was 1140x667), and the user's answer
was "looks the same as before, blurry, low radius" — the resolution was
never the whole complaint. Live on Bistro, `__giGtaoIntervals = 4` (2.24 m)
with `__giAoFilterRadius = 2`: "now its good". Both are the shipped defaults
now (`giGtaoRadiusIntervals` 1 → 4, ultra `filterRadius` 3 → 2), the hatches
are cleared. The one-interval "contact only" rule (2026-08-26) was set
against a detached silhouette measured at HALF resolution with a ±3 texel
filter — a 12-viewport-pixel smear of the contact ring; at the viewport's
resolution with ±2 px the same reach is what the tracer's arches and eaves
look like. Named and not done: a reach that follows the scene's probe
spacing instead of a fixed interval count, and thin-occluder compensation
if a prop grows a halo at four intervals on some other scene.
Receipts on the shipped defaults: rig (ultra) contact 30.2 % darker, raw
p05 0.653, downsample exact, gtao 0.36 ms; the user's Bistro at 1612×943:
gtao group 2.62 ms (was 1.42 at half resolution and one interval) — and at
that pose the frame's GPU is the emitter-shadow pass (8.7–11.4 ms) and the
exact reflections (bvhReflect 10.3 + bvhHitShade 9.3), which is §18's list.

### 11.36 THE MOVING FRAME — a per-frame GPU split, a dispatch tally, and "converged motion" (2026-09-04, evening; instrument SHIPPED, cadence OPT-IN `__giWorldMotionRest = true` pending the walk receipts)

**Why.** Every §11.34 number was a parked number. The user's "10–11 fps,
unplayable" pose is a MOVING camera, and `profile.giPasses` prices passes in
isolation — it cannot say which of them a moving frame dispatches. Two
instruments close that: `profile.frameStats.gpuRenderMs / gpuComputeMs`
(the frame's two timestamp halves, EMA'd like `gpuMs`: render = scene draw,
GI prepass, shadows, post; compute = every GI chain) and
`giHold.dispatchedLastFrame` (the previous frame's GI dispatches counted by
pass name — multiply by the profiler's per-pass ms for the composition).
`giHold.restTerms` publishes the transport's rest-drive terms (mLight,
mLightNoCam, tr, cam, boot, light), so "why is the chain not resting" is one
read. The flicker smoke's swung arm now prints all three.

**What the moving frame is (harness, editor concurrently loading the GPU):**

| scene | swung fps | gpu | render | compute |
|---|---|---|---|---|
| Sponza (858×484) | 38 | 18.9 | 3.7 | 15.2 |
| Level (858×484) | 28.7 | 16.6 | 0.5 | 16.0 |

Under motion the frame is the GI COMPUTE, 80–96 % of it; the raster is
noise on these scenes. On the user's Bistro the same orbit read 47 ms GPU
(unclean — a harness boot shared the GPU; to be re-read after the restart).

**Converged motion (`__giWorldMotionRest = true`, needs every light static):**
the world chain's RATE ignores the camera — a moving camera reveals probes
(the starvation floor of each dispatch feeds them) but does not change what
a known probe must answer — while the ray ceiling still follows the camera
(motionScale, camTerm) and the idle gate keeps the full drive (motion never
sleeps). Two traps on the way, both measured: (1) the cadence keyed on the
transport's published drive, and the camera enters that drive TWICE — as
`camTerm` and, through the α settle floor, as `mLight` (0.38 during the
Level orbit) — so excluding `camTerm` alone changed nothing; the no-camera
drive uses `mLightNoCam` (α floored by the LIGHT settle only). (2) The idle
gate's emitter inputs keyed on the seat slots (§11.34 addendum).

**Receipts (Level, LIGHTS_STATIC=1, same harness, same editor load):**

| arm | swung fps | gpu | compute | motionRest / worldHz | sun step t50 / t90 / monotone |
|---|---|---|---|---|---|
| base2 | 28.7 | 16.6 | 16.0 | false / 30 | 2.2 s / 4.5 s / 83 % |
| rest2 | 33.5 | 14.5 | 14.0 | **true / 15** | 3.0 s / 4.3 s / 78 % |

+17 % fps under motion, −2 ms compute; the sun step still lifts the drive
and wakes the chain (t90 unchanged). Less than the halved world chain
predicts, which is the next question the dispatch tally answers: what else
is in the 14 ms. Default-on waits on the walk-patches arrival receipts
(`run-gi-walk-patches.mjs ARMS=lightsstatic,motionrest`).

**§11.36 walk receipts (`run-gi-walk-patches.mjs`, Level, ultra, 2 legs,
harness at ~15 fps under the editor's load):**

| arm | err0 | settle95 | maxStep | rev | patch0 | ripple |
|---|---|---|---|---|---|---|
| lightsstatic | 0.0284 | 4046 ms | 0.0125 | 1.9 % | 0.80 | 0.025 |
| motionrest | 0.0349 | 4043 ms | 0.0121 | 3.0 % | 0.79 | 0.027 |

Arrival error +23 %, reversals 1.9 → 3.0 %, maxStep / settle / patch0
unchanged. Not free, not large. DECISION: stays OPT-IN. The moving frame's
compute is 14 ms on Level with the world chain at half rate, so the world
chain is not where most of it is — the next read is `dispatchedLastFrame`
under an orbit on the user's Bistro (after the restart that carries the
tally), multiplied by `profile.giPasses`.

**§11.36 on the user's Bistro (1612×943, ultra, after the restart that
carries the instruments).** An MCP-driven orbit (16 camera steps over ~2 s,
read at the end, EMA'd):

| arm | fps | gpu | render | compute | read-frame dispatches |
|---|---|---|---|---|---|
| short burst, hatch on | 26 | 45.8 | 3.6 | 42.1 | 86 (world + emitter + hit chains) |
| 16-step orbit, hatch on | 30 | 37.5 | 4.4 | 33.1 | 14 (a non-world frame) |
| 16-step orbit, hatch off | 32 | 31.2 | 4.3 | 26.8 | 14 |

THE FINDING THAT MATTERS: under motion the GPU frame is 90 % GI COMPUTE
(33–42 ms) and 4 ms of render. The raster is not the problem on this
scene; the world chain (~26 ms per dispatch: deposit 4.9, merge 4.8, shade
4.1, tiles 3.1, deposit-resolve 1.8, decay 1.5, gather 1.3, populate/rays/
seed 1.1) plus the emitter-shadow and reflection chains on their alternate
frames are. THE A/B IS INCONCLUSIVE ON BISTRO: the two arms orbit different
street segments, the EMA window straddles the stop, and a read cannot tell
whether the rest cadence engaged during the motion (`worldMotionRest` is
false by the time the read lands). The protocol needs a sustained orbit
with a per-second world-dispatch counter; the harness Bistro boot does not
fit the smoke's deadline. Hatch left OPT-IN, flag cleared.

**Where the 60 fps has to come from (the arithmetic, not a plan):** 16.7 ms
of GPU against 4 render + 33–42 compute. Halving the world chain's RATE
under motion is worth ~13 ms at best; the remaining ~20 ms is the chains'
per-dispatch cost: the capacity-proportional sweeps (merge / tiles / decay /
deposit-resolve ≈ 11 ms) and the reflection + emitter-shadow chains (~10 ms
per frame at half rate). Those are structural units — indirect dispatch
over live counts (three exposes `dispatchWorkgroupsIndirect` through
`IndirectStorageBufferAttribute`), a motion stride for the reflection
prepass — or the HIGH tier (s0 0.45: ~40 % fewer probes) for scenes of this
size.

**§11.36 correction, before building "indirect dispatch over live counts":
the premise is stale.** The capacity-proportional cost the 2026-08-15 memory
measured predates the early-outs that shipped since — decay skips dead
blocks (its own header: 13.3 → ~1.5 ms), the merge ladder and the orphan
pass read `blockLive` and return, the tile bake reads it too. On Bistro the
block pools are 45–66 % live, and the measured sweeps are LIVE-dominated:
merge 4.8 ms ≈ 3.4 ns per live bin (eight corner reads each), tiles 3.1 ms
over the live c0 texels' 32-bin reads, decay 1.5 ms ≈ the bandwidth of the
live bins' seven words. A dead thread costs a launch and one cached load.
Indirect dispatch over LIVE blocks is therefore worth ~1 ms per dispatch
here (more on Level, where 92 % of the pool is dead — and there the sweeps
are already small). NOT BUILT. The predicate that would pay is DIRTY —
merge and bake only blocks whose bins changed this dispatch (deposit hits +
parent propagation) — and the cheaper experiment before that machinery is a
merge/tile STRIDE under the rest cadence. Both need the moving-frame receipt
first: `profile.orbit` (an in-page orbit with a counted world dispatch rate)
is the instrument, shipped in this commit.

**§11.36 the Bistro receipt (`profile.orbit`, 6 s at 20°/s, the user's
pose, after the restart that carries the op):**

| arm | fps | gpu | render | compute | world dispatches/s | motionRest frames |
|---|---|---|---|---|---|---|
| default (cadence off) | 26 | 27.9 | 2.5 | 25.3 | 18.8 | 0 |
| converged motion | 36 | 22.8 | 2.5 | 20.3 | 13.5 | 312 of 313 |

+38 % fps under motion, −5 ms of compute, the world chain at the rest rate
for the whole orbit. SHIPPED DEFAULT-ON for scenes whose every light is
static (`__giWorldMotionRest = false` opts out); the walk cost stands as
measured on Level (err0 +23 %, reversals 1.9 → 3.0 %, maxStep/settle
unchanged). Note the two fps columns: `fps` counts the op's own rAF ticks,
`fpsStats` the frames the renderer presented — the engine skips rAFs it
cannot pace, so the stats column is the honest one.

### 11.37 THE MERGE/TILE STRIDE — refuted in one gate (2026-09-04, night)

Skipping the merge ladder and the tile bake on odd world dispatches read
well on the orbit (Bistro, converged motion on: compute 23.2 → 19.2 ms,
36 → 37 fps — CPU-bound by then at 23.5 ms) and failed the one gate that
matters: `profile.lightResponse` after the 25° sun step stayed at 1.0 for
the whole window and never reached 90 % (t50/t90 −1, final error 60 %),
where the same boot without the stride reads t50 2.9 s / t90 5.3 s / 95 %
monotone / change 13 %. The ladder and the bake are not a detachable tail
of the chain. The hatch is deleted. What the moving frame is made of after
converged motion: compute ~23 ms, of which the world chain ~13 (at 14
dispatches/s) and the screen chains ~10 (reflect + hit shade at half rate,
emitter shadows at half rate, GTAO 2.6, resolve 1.8, gather 1.3). The
parked-idle frame is ~26 ms of compute for the same screen chains — they
are the next lever at rest AND in motion.

### 11.38 THE EMITTER MARCH IS THE PRIMITIVE (2026-09-04, night; measured, not built)

`__giHitEmitterShadows = false` (unshadowed emitter direct at reflection
hits — the arm that "washed out" every mirror in §14, so never a shipping
default) and `profile.giPasses` on the same boot: **bvhHitShade 9.3 → 0.57
ms**. 94 % of the hit-shade pass is the emitter cone marches at hits. The
emitter-shadow pass is the same primitive on the screen's own pixels — 8.3–
11.4 ms per dispatch at 485×284 with one seat per pixel and the
checkerboard, i.e. ~165 ns per any-hit march through the 1.62 M-triangle
static shadow BVH8. Two dispatches of it per frame pair (half rate) put
~9 ms of every rested AND every moving frame on this one march; nothing
else in the screen chain is above 2.6 ms.

The levers, in the order to measure them:
1. The shadow BVH's SIZE — the emitter rays march the exact 1.62 M-tri
   shadow BVH while the transport already traces a 1.19 M simplified one
   (1 cm error); a shadow-only BVH at ~5 cm error (a few hundred k tris)
   should halve the per-march cost, and penumbra from lamps a metre away
   cannot see 5 cm.
2. At reflection hits: one cheap any-hit ray per hit toward the brightest
   admitted seat instead of the cone march per seat (the hit is already a
   reconstruction the temporal chain smooths), or the hit shade at stride 4
   under motion.
3. The march length: `shadowRange` caps at 48 m on a 130 m scene; a luma-
   scaled cap (a lamp that cannot deliver above the cutoff at distance d
   need not be marched to d) bounds the average ray to a few metres.

**§11.38 lever 1 measured — the coarser BVH does not exist through this
simplifier.** `__giBvhSimplifyError = 0.05`, `__giBvhSimplifyRatio = 0.1`
(live dials, staticBvhSimplify.js), boot build: the simplified set went
1.19 M → 1.01 M triangles (2.40 M source; the 10 % floor was never reached
— meshoptimizer with borders locked stalls at ~42 % on this geometry), and
the shadow BVH 1.62 M → 1.44 M (the 98 mirror-visible meshes it keeps exact
are 0.43 M of it). Per-pass: emitterShadowPass 8.3 → 7.8 ms, i.e. the
march cost follows traversal depth and ray incoherence, not the triangle
count. Flags cleared; a real shadow-only LOD would need decimation without
the border lock, which is a crack, which is a leak. The remaining levers
are the NUMBER of marches — one any-hit ray to the brightest admitted seat
at a reflection hit instead of a cone per seat (hit shade 9.3 ms is 94 %
those marches) — and the shadow buffer's scale under motion.

**§11.38 levers 2–3 measured.** The BVH-arm emitter march is already ONE
`traceStaticBvh` any-hit plus one mover trace per seat (and `emitterDirectAt`
rolls the hit shade to one march per hit), so "one any-hit instead of a
cone" is what runs today. The mover trace is a linear loop over every
adopted object (`traceDynBody`, 27 bone capsules here) — exonerated:
`__giSkinnedProxyCapsules = 2` (adopted movers 27 → 7) left
emitterShadowPass at 8.7–10.2 ms and bvhHitShade at 6.6 ms. What remains
is the static any-hit itself: ~60 ns per pixel-march at the full-pixel
rest dispatch (138 k marches / 8.5 ms) against ~25 ns per transport ray —
the emitter rays are LONG (to a lamp up to `shadowRange` 48 m away through
the whole street), the probe rays mostly stop inside cascade 1. A march
cap on the primary path is a leak through any wall past the cap, so that
lever is closed for the primary emitter shadows (the hit shade's 16 m cap
is the documented "bounded leak, reflections only").

**The rest frame's real owner (parked, 43 fps, compute 26 ms with the
world idle):** the animated character keeps `reflectHeldFrames` at 0 and
every screen chain on the movers-only stride — emitter shadows, the
reflection prepass and the hit shade re-run on the FULL screen every other
frame for a mover that covers a few percent of it. A mover-restricted
dispatch (early-out outside the movers' screen footprints) is the
structural lever for the parked frame, but the footprint is not the
mover's rect: its shadow lands elsewhere and its reflection lands on other
surfaces, so the honest predicate is per pixel — "does this pixel's ray
pass a mover's bounds" — which is the mover trace's own AABB test, hoisted
before the static march. Queued, with that design.

### 11.39 THE WHITE OBJECTS IN THE REFLECTIONS — the merged proxies' palette colour was white (2026-09-04, night; SHIPPED)

**The report:** "some meshes still appear white in the reflections; we tried
to fix it some time ago, but failed." The earlier attempt was
`resolveMaterialAlbedo` (materialNodeBindings.js), written for exactly
"consumers that inspect only the classic fields produced white reflection
holes" — and it is not called by anything in the module.

**The instrument that named them:** `profile.giSurfaces` (new op) walks
`state.entries` and lists every slot whose PALETTE colour — what a
reflection hit and a bounce read for that mesh — is near white, with the
material facts behind it. On Bistro: 515 entries, luma histogram 289 /
201 / 21 / 4, and the four white ones are:

| mesh | material | why |
|---|---|---|
| Merged(3) | Uber(3) | colorNode is a `VarNode` (the per-vertex texture-array read), no `.map`, `.color` white |
| Merged(6) | Uber(6) | same |
| Merged(8) | Uber(8) | same |
| (unnamed) | MeshPhysicalNodeMaterial | compressed map, palette white — the GPU mean never landed (the skinned mesh; not in the BVH, not the visible case) |

The three uber groups are large merged batches, so a reflection landing
on any of them read albedo 1 — and every bounce off them was white, which
is a brightness error in the field as well as the mirror.

**The fix.** `uberMaterial.js` stamps `material.userData.giMembers` (the
member materials, by reference) on every uber it builds;
`resolveMaterialSurface` (voxelizeOnce.js) returns the unweighted mean of
the members' resolved colours and pre-multiplied emissives when that list
is present (unweighted because an uber is cached per material SET and
shared by every group with that set; a member whose compressed map is
still pending re-resolves on the next scan, as before). The reflection
atlas is untouched: an uber has no `.map`, so its slot reads the palette
mean, which is now the members' mean rather than white.

### 11.40 THE STATIC VISIBILITY CACHE — the emitter shadow pass stops re-marching a world that has not moved (2026-09-04, night; SHIPPED, default on; the held march halves)

**The parked frame's owner (§11.38):** with an animated character every
screen chain runs on the movers-only stride — the emitter shadow pass
re-marched every pixel of the screen against the STATIC BVH every other
frame, ~8.5 ms per dispatch on the user's Bistro, for a static answer that
had not changed. The march is one static any-hit plus one mover trace per
seat; the static any-hit is the ~60 ns, the mover trace is cheap (§11.38's
capsule experiment).

**The unit.** Three cache textures beside `emitterShadowRaw`
(`createGiTargets`): per pixel and per seat the static-only visibility, the
static blocker distance (−1 = none), and a stamp `generation·4096 +
emitterId` (a float32 texture, exact). GISystem bumps the generation
whenever the static g-buffer key moves and sets a refresh stride
(`EMITTER_STATIC_STRIDE` 4) only on movers-only frames; a moving camera
keeps stride 1, i.e. the old full march. The seat-rotating emitter pass
hands `emitterSlotShadow` a per-seat cache accessor (`valid` = the stamp
matches this generation AND this lamp; `march` = stride 1 or this pixel's
turn; `store`), and `#buildEmitterRecordTrace`'s BVH arm consults it before
the static any-hit: a valid, non-refresh entry is read back, anything else
marches and stores. The MOVER trace runs every frame either way, so the
character's shadow stays live at full rate — that is the whole point: the
static world is cached, the movers are not. The stride keeps the
area-sampled penumbra integrating (one pixel in four re-samples its jitter
per held frame). `__giEmitterStaticCache = false` marches every pixel;
`__giEmitterStaticStride` pins the stride.

**The first build did not compile, and the harness could not tell.** The
pass loaded the three cache textures through `texture()` nodes and stored
to the same textures with `textureStore` in one kernel; WGSL binds a texture
ONE way per kernel, so the store resolved against a `texture_2d<f32>`
binding: `no matching call to 'textureStore(texture_2d<f32>, vec2<u32>,
vec4<f32>)'`. Three logs it as an async pipeline failure and simply never
dispatches the pass — the smoke that "passed" with it (parked 91 fps) was
measuring a frame with NO emitter shadows at all. The fix is the idiom the
shadow-history snapshots already use: a READ set and a WRITE set
(`emitterStaticVis/T/Stamp` + `…Next`), the marcher loads the read set and
stores the write set, and `createGiEmitterStaticSnapshotPass` copies write
→ read right behind it in the emitter chain (0.01–0.02 ms; it rides every
list the marcher rides: the queue, the idle path, the no-emitter skip set,
the movers-only cadence skip, the cold-shadow set, the resize splice). The
stamp is `(gen+1)·8192 + emitterId + 1` (never the fresh texture's 0; exact
in f32 with `gen` wrapped at 1024).

**Receipt (the user's Bistro, 1612×943, 4 emitters, emitter target 314×184,
`profile.giPasses`):**

| emitter shadow pass | ms / dispatch |
|---|---|
| stride 1 (every pixel marches + stores) | 1.93 |
| movers-only arm: static cache, stride 4 | 1.01 |
| write → read snapshot | 0.01 |

The static any-hit was ~1.2 ms of the 1.9; the held frame keeps a quarter
of it plus the per-pixel fixed cost (g-buffer loads, seat select, cache
rows, penumbra). `profile.giPasses` now carries that arm by name
("emitterShadowPass (movers-only: static cache, stride N)"): it sets the
stride uniform, fills the cache through the snapshot, times the pair and
restores — the frame loop only applies the stride on movers-only frames,
and the cache is invalid all through a boot (the static key moves with
every rebuild). ⚠ The scene's animated character had been removed between
the two reloads (`adoptedMovers 0`, `moverOnlyFrames 0`), so the frame-loop
path itself (a held static key with a live mover) has no receipt yet; with
the character present the MOVER trace (27 bone capsules per seat) stays at
full cost by design — the cache is the static world only. Sponza in the
harness has the character but 0 emitters (the arm reports "NOT dispatched
— 0 emitters"); Bistro in headless Chrome never produced a field in 900 s
(`BOOT_DEADLINE_S` is now an env on the smoke) — the editor is the only
place both exist.

**What it does not cover yet:** the hit shade's emitter marches at
reflection hits (the same closure, a different pixel — the cache accessor
is per pass, and the hit shade does not pass one yet) and the reflection
prepass. Both are the same pattern. The larger number on the same pose is
elsewhere: at the parked pose after this reload the world chain is 33.8 ms
per dispatch (shade + bounce 14.0, deposit trace 11.1 — the sun reads
MOVABLE on this save, so §11.34's idle never engages), bvhReflect 19.5 ms
and bvhHitShade 10.3 ms are held while parked and paid in full under
motion — the under-motion frame at this pose is ~70 ms of compute.

### 11.41 ONE MATRIX WALK PER FRAME — the frame walked the scene three times (2026-09-04, night; SHIPPED, default on; `__engineWalkPerRender = true` restores the old behaviour)

**Where the moving frame's CPU went.** `profile.orbit` grew a `phases`
option (the CPU phase capture armed 0.5 s into the orbit and stopped with
it — a parked `profile.cpuFrame` cannot see what motion adds), and
`merging.sync` grew two sub-marks. On the user's Bistro at the parked pose
after the §11.40 reload, moving (20°/s orbit): CPU 22.4 ms against 17.0 ms
of GPU — a CPU wall — of which `gi.gbufferPrepass` 6.4, `renderEncode` 8.6,
`merging` 2.2. The merging sub-marks said the whole of merging was
`scene.updateMatrixWorld()` (`merging.matrixWorld` 2.107 ms,
`merging.watch` 0.097): three recomposes every `matrixAutoUpdate` object it
visits whether or not anything moved, and the frame paid that walk THREE
times — merging's motion watch, the GI g-buffer prepass render and the main
render (three walks inside every `render()` while
`scene.matrixWorldAutoUpdate` is true).

**The unit (Engine `#tick`, `PHASE.matrixWorld`).** After scripts, physics
and animation have written the frame's transforms and before batching /
merging / the pre-render passes, the tick walks the scene ONCE
(`#walkSceneOnce`) and switches the scene's `matrixWorldAutoUpdate` off; the
renders inside the tick (the prepass, the main pass, a postprocess
override) skip their walks; `#endWalkedFrame` puts the flag back at the
tick's end (and on the suspended early return) so a render outside the
tick — a thumbnail, a probe capture — still walks for itself. Merging's
non-dirty path no longer walks (its rebuild path keeps its own explicit
walk).

**Receipts (user's Bistro, 1612×943, 357 draws, `profile.cpuFrame` /
`profile.orbit phases`):**

| | CPU ms | of which | fps |
|---|---|---|---|
| parked, before | 14.2 | renderEncode 7.5 · merging 2.27 | 38 (GPU-bound, 30 ms) |
| parked, after | 11.8 | renderEncode 5.4 · matrixWorld 1.78 · merging 0.15 | — |
| moving, before | 22.4 (phases 21.0) | prepass 6.4 · renderEncode 8.6 · merging 2.2 | 34.8 |
| moving, after | 16.0 (phases 14.3) | prepass 2.5 · renderEncode 6.3 · matrixWorld 1.8 · merging 0.16 | 39.0 |

−6.4 ms of CPU on the moving frame (three walks became one), −2.5 parked.
Console clean after the reload. The moving frame is still CPU-bound (16.0
vs 12.5 ms GPU); what is left of it, named: `renderEncode` 6.3 (357 draws
plus three's render-list build), `gi.gbufferPrepass` 2.5 (a second
render-list build and ~500 g-buffer draws), `gi.screenChain` 2.3 (84
compute dispatches at ~27 µs each — the per-cascade loops of
populate ×18 / rays ×21 / merge ×8 could be single dispatches), and the one
walk itself at 1.8 (`matrixAutoUpdate = false` on static entities would
skip the recompose, but every transform edit in the editor would then have
to call `updateMatrix()` — not tonight). Parked, the frame is the GPU's:
the world chain at rest (15 Hz, 33.8 ms per dispatch) because this save's
sun reads MOVABLE (`worldIdleReason "1 of 1 lights movable"`) — §11.34's
−10 ms is one inspector click away, and it is the user's click.

### 11.42 WHERE THE MOVING FRAME GOES NOW — two instruments, one attribution, and the next unit sized (2026-09-04, late night; instruments SHIPPED, the unit PROPOSED)

**Instruments.** (1) `render.project@<phase>` / `render.draw@<phase>` —
sub-marks wrapped around three's `_renderScene` and `_renderObjects`
(Engine `#installRenderMarks`, keyed by tick phase so the GI prepass under
`preRender` and the main pass under `renderEncode` read apart). (2)
`profile.orbit` returns `dispatchesPerSec` — every GI pass that actually
dispatched while moving, per second, grouped (populate#k → populate) — so
the moving GPU budget is rates × `profile.giPasses`' per-dispatch ms
instead of a parked guess.

**The moving frame (user's Bistro, 20°/s orbit, after §11.41):** 34.6 fps;
CPU 14.5 ms = main draw loop 4.96 (359 draws, 13.8 µs each) + main
render-list build 1.30 + prepass build 1.20 + prepass draws 1.10 +
`gi.screenChain` 2.48 (84 dispatches) + the one walk 2.04 + ~1.4 other. GPU
17.6 ms compute, and the tally says why: the world chain dispatches 20.6×/s
(every 1.7 frames) at 34 ms per dispatch; the emitter chain, the hit shade
and the reflection pass every other frame (17.3/s); the screen passes every
frame. By share the world chain is ~⅔ of the moving GPU, and inside it
`shade + bounce [J]` 11.9 ms and `deposit (trace + attribute)` 8.6 ms are
the frame.

**The prize, measured.** `__giSrcNoShadow = true` (the shade kernel's
`visibility` closure removed; the light tree still samples, nothing marches)
and a GI rebuild:

| | shade + bounce [J] | world chain / dispatch | parked GPU | parked fps |
|---|---|---|---|---|
| marches on | 11.9 ms | 34.0 ms | 25.4 ms | 36 |
| marches off | 0.48 ms | 18.9 ms | 12.1 ms | 69 |

96 % of the world shade is ONE any-hit march per hit — the light-tree NEE
sample's visibility to its chosen lamp (the sun rides the shadow map,
`__giSunShadowMap`; movers are not in the world visibility,
`__giSrcBvhShadowMovers`). 73 k hits × ~156 ns. It is the §11.40 primitive
again — static surface, static lamp, an answer that does not change — and
the per-frame re-march of it is the moving frame.

**The next unit (proposed, not built): the per-probe direct cache.** The
tiles pass already keeps, per probe, an OCTAHEDRAL map keyed by surface
normal (`sampleTile(block, normal)`, 64 texels) of the outgoing radiance the
hit shader reads for the bounce term [J]. Its sibling: a map of the lamps'
DIRECT irradiance `E_emit(probe, normal octant)` with a sample count. At a
hit on a static surface the shader finds the hit's c0 probe (one hash
lookup, `meanProbeSteps` 1.04), reads the texel; converged (N ≥ K) → `E` is
the texel and NOTHING marches; else it shades as today and folds the sample
into the texel (running mean; a lost update between two hits in one
dispatch only slows convergence). Fill rate: 73 k samples per dispatch over
the visible probes' texels, converged in ~2 s at 20 dispatches/s; a camera
entering new space marches only for the NEW probes. Invalidation is the
lights/emitters field-hash generation, stamped per probe (a light drag
returns the cost to today's for as long as it moves — so the
`profile.lightResponse` gate is unchanged by construction — and the cache
refills after). Resolution = the field's own (probe spacing); the bounce of
lamp light cannot be finer than the probes that carry it. Memory: 16 texels
per probe at RGBA16F (a 4×4 octant map is enough for an irradiance term)
≈ 15 MB at today's pool. Expected: world chain 34 → ~19 ms per dispatch
once converged; moving GPU 17.6 → ~10 ms, parked 25 → ~12 ms — 60 fps in
BOTH states on this pose with the sun still movable, which is the mandate.
The sun click (§11.34) then stacks on top for the parked state.

**Not this unit:** the hit shade's own emitter marches at reflection hits
(bvhHitShade 3.4 ms per dispatch here; §11.38 measured 94 % marches on a
heavier pose) read the same cache at the reflection hit's probe — a second
consumer, once the first ships.

### 11.43 "FREQUENT MINI FREEZES WHILE MOVING" — the heavy chains shared a frame (2026-09-05, small hours; SHIPPED, default on; `__giWorldStagger = false` restores the collision)

**The report (the user, sun now static):** "its 60+ fps when camera is
static, but when moving, it is on 30 fps with frequent mini freezes".

**The instrument had to move the camera itself.** Two manual
`profile.spikeWatch` windows (20 s and 25 s) read 60 fps and 0–2 spikes —
the camera was parked both times. `profile.orbit` grew `spikes: true`
(the spike watch armed 0.5 s into the orbit, closed with it; implies the
CPU phase capture) and the spike watch grew a RAW per-resolve GPU series
(`gpuFrames`: mean, max, over40, under12, the last 80 values) — because a
frame whose marked CPU phases sum to a third of its length is the main
thread waiting on the GPU, and only the unsmoothed series shows what the
GPU did frame by frame.

**What it showed (15 s orbit at 25°/s, the user's Bistro, sun static, world
in converged motion at 14.3 dispatches/s):** 41 frames ≥ 40 ms, worst 94.5,
CPU phases explaining 25–30 ms of each; the GPU series alternating ~65 / ~6
ms. The mechanism: under the motion half-rate the emitter, hit-shade and
reflection chains all dispatch on `_frame % GI_MOVER_ONLY_STRIDE === 0`
frames, and the world chain's due-ness is a wall-clock timer that lands on
either parity — half the world ticks stacked their 34 ms on a frame already
carrying ~30 ms of screen chains, and the next frame carried almost
nothing. Same mean, twice the variance, and the variance is the freeze.

**The unit.** A world tick that comes due on a heavy screen frame waits
ONE frame — the next heavy frame is two away, so it never waits twice —
and keeps its due-ness (`_srcWorldNextAt` put back to now).
`_moverCadenceHalfRate` records whether the half-rate is on this frame;
`frameStats.giHold.worldStaggered` / `profile.orbit.worldStaggered` count
the deferrals.

**A/B on ONE boot, the same orbit (`profile.orbit spikes:true`):**

| | fps | spikes ≥ 40 ms / 15 s | worst frame | raw GPU max | GPU frames ≥ 40 ms | GPU mean |
|---|---|---|---|---|---|---|
| stagger off (`__giWorldStagger=false`) | 35.7 | 70 | 159.6 ms | 72.8 ms | 39 of 160 | 25.4 |
| stagger on | 37.8 | 26 | 54.5 ms | 52.1 ms | 17 of 182 | 20.9 |

**What is left, named.** The frames are now ~40 / ~18 ms instead of
65 / 6: the world frame (34 + 6 of screen) is the heavy one. Two follow-ups:
(a) the per-probe direct cache (§11.42) takes the world dispatch 34 → ~19
ms and with it the heavy frame to ~25 — the mean AND the variance; (b) the
world chain in two segments on consecutive frames (populate / rays /
trace + attribute on one, decay / shade / resolve / merge / tiles on the
next — the split point must keep the gather reading a fully resolved field
in between, so decay moves behind the trace) would balance the two
parities at ~26 / ~26. (a) is the one with a mean in it.

### 11.44 THE WORLD VISIBILITY CACHE — the shade kernel stops re-marching a static lamp over a static surface (2026-09-05, small hours; SHIPPED, default on; `__giSrcVisCache = false` is the old kernel)

**What it is.** §11.42 measured 96 % of `shade + bounce [J]` as ONE any-hit
march per hit: the light-tree sample's visibility to the lamp it picked. The
cache keeps that answer per WORLD CELL and per lamp: an open-addressing hash
of cells (spacing `2·spacing0` = 0.7 m, capacity 2^18, the probe store's
`hashFindWgsl` / `hashInsertWgsl` — exported for it — claim and find) with
16 packed rows per cell of `(lamp << 16 | vis·255 << 8 | samples)`. A pick
whose (cell, lamp) row holds K = 4 samples reads the mean and does NOT
march; otherwise it marches and folds the sample in (running mean, last
writer wins between two hits of one dispatch — a slower fill, never a
wrong one); with 16 rows full, the least-sampled row is replaced. One
sample in eight on a converged row still marches (a pure function of the
ray index — deterministic, no boil) so a row keeps converging past K.
Invalidation: a moving light (GISystem's `trackMotion` window) and a lamp
that moved, appeared or was added (the light-tree refresh's pose rows —
NOT a power change, which rebuilds the tree but cannot change visibility)
arm `visCacheClearU` for the next 8 update ticks; the gated clear rides the
world chain before the shade (`src:vis cache clear`, 0.006 ms when not
armed). Movers are not in the world visibility (`__giSrcBvhShadowMovers`),
so nothing about them is cached. Cell spacing and K are LIVE uniforms
(`__giSrcVisCacheSpacing`, `__giSrcVisCacheK`; a spacing change clears).

**Three things the receipts had to say before it worked.**
1. **v1 keyed on the hit's c0 probe** — the counters said 65 % of samples
   found NO probe under the hit (rays land where the camera has not put
   probes) and 19 % found the 8 rows full. Hence the cell hash.
2. **The per-frame counters are the last WORLD frame's** — under a parked
   idle world they are stale, and `profile.giPasses`' own 40 dispatches do
   not show in them. A readback of the whole row table (`visCacheTable`:
   cells, rows, sample-count histogram) is what said the rows DO
   accumulate (max 35 after 40 shades of one hit set) but 455 k rows against
   192 k samples per dispatch fill one row every few dispatches — K = 8 at
   0.35 m cells took seconds per row, and a moving camera never got there
   (23 % served). 0.7 m cells and K = 4: 56.5 % served at steady state.
3. **A first guess blamed the light-tree refresh** (it invalidates on every
   rebuild) — a tally of its change reasons in `frameStats.giHold.
   lightTreeChanges` read ONE refresh and ONE invalidation for the whole
   boot. The guess was wrong; the tally is what said so.

**Receipts (user's Bistro, sun static, 15 s orbit at 25°/s, `profile.orbit
spikes:true`; the world in converged motion at 12–14 dispatches/s):**

| arm | fps | GPU mean (raw) | frames ≥ 40 ms | spikes / 15 s | served |
|---|---|---|---|---|---|
| no cache, stagger on (§11.43) | 37.8 | 20.9 | 17 / 182 | 26 | — |
| cache K=4, 0.7 m | 41.3 | 19.1 | 18 / 170 | 19 | 56.5 % |
| cache K=2, 0.7 m | 39.3 | 24.0 | 19 / 151 | 24 | — |

`profile.giPasses` after the K=4 orbit: `shade + bounce [J]` 10.25 ms for
96 k hits (107 ns/hit against 175 before); 40 k samples served, 31 k
marched, 11.7 k still filling. The light-response gate with the cache: step
25°, change 18 %, t50 1.48 s, t90 4.3 s, 100 % monotone — the tracking
window opened (`trackWindow max 1`), i.e. the clear fired by design and the
field followed the sun as before. Console clean on every reload.

**⚠ The orbit-to-orbit variance is the FIELD, not the cache.** Each orbit
populates a wider ring: live probes 21 k → 102 k over the night, and the
world chain's other passes grew with it (tiles 1.2 → 5.1 ms, merge 0.9 →
4.2, deposit resolve 0.9 → 3.4, decay 0.7 → 2.3 per dispatch). The K=2 arm
ran on the bigger field. A per-dispatch cost that scales with the live
population is its own unit (retirement / the pool ladder), and it is why
the moving GPU mean did not fall by the whole 11.9 → 0.48 the §11.42 prize
promised — half the shade was won, the other passes grew underneath.

**Left on the shade itself:** the cache path's own per-hit cost (a hash
probe, a 16-row scan and a store, ×2 picks ≈ 50 ns/hit) is now a third of
the kernel; 8 rows with the replacement policy, or a 2-word row (two lamps
per word), would take most of it. And the hit shade's emitter marches at
reflection hits (`bvhHitShade`) read the same table at the reflection hit's
cell — the second consumer, not wired yet.

### 11.45 THE WORLD CHAIN IN TWO HALVES — no frame carries the whole transport (2026-09-05; SHIPPED, default on; `__giWorldSplit = false` restores the single block)

**Why the stagger was not enough.** §11.43 moved the world tick off the
heavy screen frames; the moving frame then alternated ~40 / ~18 ms, because
the world dispatch is ONE block of ~38 ms and a cadence can only make a
block rarer, never smaller. The user's report — "60+ fps when the camera is
static, 30 fps with frequent mini freezes when moving" — is that block.

**The unit.** The chain splits at the deposit's TRACE + ATTRIBUTE
(`#worldSegmentBoundary`, matched on the pass name, so a feature arm
without that pass simply does not split):

| | segment | passes |
|---|---|---|
| A | trace | populate, hashBlock, rays, decay, seed, trace + attribute |
| B | resolve | vis-cache clear, shade + bounce [J], deposit resolve, merge, tiles |

A runs when the chain is due (with §11.43's heavy-frame rule); B runs on
the next frame that is not a heavy screen frame, regardless of the timer,
and outranks starting another A. **The gap between them is safe because
only the BINS are mid-update in it** — the probe payload and the tiles the
gather reads are still last tick's fully resolved state, and nothing
outside the chain reads bins. The split stands down while any pass is
unbuilt or a compile wave is running (§11.7: the chain runs whole, or it
kicks compiles — never with holes).

**⚠ The first build halved the transport's rate.** `dispatchedPreviousFrame`
— the rule that stops two dispatches landing on consecutive frames — counted
segment B as a dispatch, so every pair cost two timer slots: chains 12.5 →
6.3 per second and light-response t50 1.5 → 2.7 s. The rule is about how
often a CHAIN STARTS, so it now reads the last chain start
(`_srcWorldLastChainFrame`). ⛔ A cadence rule written for one dispatch per
tick does not survive a tick becoming two; the light-response gate is what
caught it, not the frame time — the frame time was BETTER while the field
converged half as fast.

**Receipts (user's Bistro, sun static, 15 s orbit at 25°/s,
`profile.orbit spikes:true`; the RAW per-resolve GPU series is the honest
one — an EMA cannot see a freeze):**

| arm | fps | GPU mean | GPU max | frames ≥ 40 ms | spikes / 15 s |
|---|---|---|---|---|---|
| §11.43 stagger only | 37.8 | 20.9 | 52.1 | 17 / 182 | 26 |
| + §11.44 vis cache | 41.3 | 19.1 | 50.2 | 18 / 170 | 19 |
| + split (rate halved) | 43.1 | 15.7 | 37.3 | 0 / 203 | 22 |
| + split, rate restored | 39.9 | 16.8 | 36.3 | **0 / 191** | **8** |

Light response with the split: step 25°, change 34 %, t50 1.11 s, t90 3.42 s,
99.7 % monotone (before the split, on the previous boot: t50 1.48 s, t90
4.32 s, 100 %). `frameStats.giHold.worldSplit` says whether the halves are
live; `profile.orbit` adds `worldChainsPerSec` because with the split a
"world dispatch" is a SEGMENT and two of them are one chain. Console clean.

**Where the moving frame stands now** (this pose, 40 fps): GPU 18.5 ms of
compute against 20 ms of CPU — the CPU is the wall again, and it is
`renderEncode` 8.3 (359 draws + three's render-list build), `preRender` 7.0
(the GI prepass render + `gi.screenChain` 3.3), `matrixWorld` 2.4 and
`shadowFreeze` 1.3. No GI pass owns a frame any more; the next unit is the
draw submission, not the transport.

### 11.46 "LOST ITS COLOUR AND ATMOSPHERE" + "RECTS ON ALL EDGES" — two look regressions, both from a cache answering where it had no right to (2026-09-05; SHIPPED)

**The report (the user, Level scene, play mode):** "our gi lost its color and
atmosphere somewhere along the edits" and, separately, "gtao has quite a huge
radius, i kinda see rects on all edges and near the character's hands ... i
guess we need it a bit smarter and depth corrected".

**A. The colour: §11.44's visibility cache averaged across walls.** The row is
keyed by CELL and lamp. A 0.7 m cell spans both sides of every wall, so the
running mean of a lit face and a shadowed face is a HALF-LIT answer handed
back to both: the lit side loses half its direct light, the shadowed side
gains light it should not have, and the picture flattens and desaturates.
A/B on the user's Level, same pose (`profile.giPasses`):

| | cache on | cache off |
|---|---|---|
| direct luma at hits | 0.0149 | 0.0408 |
| bounce / direct | 6.22 | 1.35 |
| irradiance luma | 0.381 | 0.248 |
| tiles meanLum / minLum | 0.443 / 0.012 | 0.239 / 0.039 |
| far field, raw | 93, 92, 66 | 78, 66, 47 |

Direct light 2.7× down, bounce up, the mean brighter, the floor of the
histogram lifted, and the far field from warm (R−G 12) to neutral (R−G 1).
That IS "flat, bright, no colour".

**The fix: a cache may answer only where its samples AGREE.** The count is
capped at 255, so one dissenting sample moves the stored byte off 255/0 and
every pick in that cell marches for ever after. Cells that straddle a wall
never converge and always pay their ray; open floor and deep shadow still
serve. The saving is smaller and the answer is exact.

⛔ **The lesson.** §11.44's own receipts (56 % served, 41.3 fps, spikes 19,
light-response t90 3.4 s) were all TRUE and all blind to this: a shadow
term averaged over a cell keeps every timing and stability property and
loses the picture. Neither the frame time, the spike count nor the
light-response gate can see a wash-out — `bounceOverDirect` and the far
field's chroma can, and they are now the two numbers to read after any
change to the transport's shadow term.

**B. The rects: 4 taps spread over a quarter of the screen.** `MAX_REACH`
bounded the AO RADIUS; nothing bounded the GAP BETWEEN TAPS. With 4 steps and
a reach of 0.25 × frame height, consecutive taps land ~59 px apart near the
camera — an occlusion estimate sampled every 59 px aliases the occluder's
silhouette into rectangles, worst where geometry is CLOSEST (the character's
hands). Half-resolution AO hid it behind the 2× upsample and the wider
filter; §11.35 moved AO to full resolution, where nothing does.

Two changes, both derived from depth rather than tuned:
1. The reach is also bounded by what the tap count can resolve —
   `STEPS × maxStepPix`, with `maxStepPix` a fraction of the buffer height
   (1 %) so it is resolution-independent like `MAX_REACH`. Near the camera
   this shortens the world radius, correctly: past that spacing the
   estimator had no information there anyway. `__giGtaoMaxStepPx` pins it.
2. The distance falloff now ramps against the radius ACTUALLY marched
   (`Reff`, backed out of the clamped pixel reach) instead of the radius
   that was asked for. Ramping against a radius the taps never reach left
   the last tap at full weight — a hard cutoff at the end of the march,
   which is the second half of the blocky edge.

**C. BOTH SHADOW CACHES ARE NOW OPT-IN.** With the unanimity rule in place
the user still reported "GI is still too flat", so the two units introduced
this night that touch the shadow term — §11.44's world visibility cache
(`__giSrcVisCache = true` to arm) and §11.40's per-pixel emitter static
cache (`__giEmitterStaticCache = true`) — are OFF by default. The code and
both fixes stay; what they lack is a LOOK receipt on the user's own scene,
and the standing rule for this module is that opt-in state is re-flipped
ONE AT A TIME with the user watching. Cost of the revert: ~3 fps of the
orbit gain (41.3 → ~38) and ~1 ms on the emitter pass. The picture is worth
more than either.

**D. The reach clamp, twice.** The first build bounded the tap spacing at
1 % of buffer height (9.4 px, reach 37.7 px), which put the effective radius
at ~0.14 m three metres from the camera: "now there is almost no ao". The
bound is not free to choose — the radial phase gives 4 offsets across
neighbouring pixels, so spacing `s` interleaves to `s/4` of radial
granularity and the ±2 px filter smooths about 5 px of it, i.e. `s ≤ ~20-24`
px. Shipped at 2.5 % of height (23.6 px spacing, 94 px reach, ~0.35 m at
three metres). The pre-§11.46 spacing was 59 px, four times what the filter
can carry — which is why it printed rectangles. ⭐ The spacing and the
filter width move together or not at all.

**Still open, named:** the fine weave visible on flat walls in the user's AO
debug capture is the 4-phase radial stratification showing through a ±2 px
filter at full resolution (at half resolution the ±3 filter covered twice
the screen distance). If it survives the reach fix, the filter's support —
not the estimator — is what needs widening.

### 11.47 THE LOOK REGRESSIONS, AND WHY SIX GREEN RECEIPTS DID NOT CATCH THEM (2026-09-05; EVERYTHING FROM §11.40–§11.45 IS OPT-IN AGAIN)

**The user, in order:** "our gi lost its color and atmosphere somewhere along
the edits" → "now there is almost no ao" → "i mean it looks flatter, colder,
and fps is lower. Why the hack?" → "there are rects on the edges all over the
place".

**Two causes, neither of them in the GI transport.**

1. **Flat and cold = A STALE SUN, from §11.41's single matrix walk.**
   `LightComponent` re-aims the directional light AND rebuilds its CSM
   frustums in an `onPreRender` callback — the phase that runs AFTER the
   tick's one walk. With the scene's `matrixWorldAutoUpdate` switched off for
   the tick's renders, nothing walked those changes, so every frame's shadow
   map was rendered from LAST frame's light pose. Under a moving camera the
   cascades never catch up: sun shadows wash out, the warm bounce that
   depends on them goes with it, and the picture reads flat and cold.
2. **Rects on every silhouette = §11.35's second g-buffer.** Full-resolution
   AO means the resolve-sized g-buffer everything else reads is POINT-SAMPLED
   down from it, at 1612/1140 = 1.41 — not integral. At a silhouette the
   downsampled texel takes the foreground or the background surface in a
   repeating pattern, the GI shades those pixels from the wrong surface, and
   the result is bright dashes marching along every edge. Rendering the
   g-buffer AT the resolve size rasterises the edge instead of resampling it.

**⛔⛔ THE METHOD FAILURE, WHICH IS THE REAL ENTRY.** Six units shipped in one
night, each with green receipts: frame time, spike counts, raw GPU series,
`profile.lightResponse` t50/t90/monotone, `profile.flicker` churn. Every one
of those numbers is blind to a wash-out, a stale sun and an edge artifact —
a transport fed a stale light reports perfect stability, and a shadow term
averaged across a wall keeps every timing property it had. **A perf unit that
touches the shadow term, the light's transform, or the g-buffer's resolution
is a LOOK change and needs a look receipt before it ships, not after.** The
numbers that would have caught these: `secondary.byLod[].bounceOverDirect`
(0.15–0.49 healthy, 6.2 = direct collapsed), `farField.rawRgb8` chroma, and
the user's own eye on their own scene.

**State now — every unit from tonight is OFF by default, arm with `= true`:**

| hatch | what it was worth | why it is off |
|---|---|---|
| `__giSrcVisCache` (§11.44) | +3.5 fps orbit | averaged the shadow term across walls |
| `__giEmitterStaticCache` (§11.40) | ~1 ms emitter pass | same class, unproven on the picture |
| `__engineWalkOnce` (§11.41) | −6.4 ms CPU moving | stale sun (fix: walk the preRender movers too) |
| `__giWorldSplit` (§11.45) | 0 frames ≥ 40 ms | halves the full-chain rate, 12.5 → 7.3/s |
| `__giWorldStagger` (§11.43) | spikes 70 → 26 | defers world ticks; off while the look is judged |
| `__giAoFullRes` (§11.35) | sharper AO | the 1.41 downsample dashes every silhouette |

Kept on: the instrumentation (§11.42's render sub-marks, `profile.orbit`'s
`phases`/`spikes`/`dispatchesPerSec`, the visibility-cache counters) and
§11.46's AO tap-spacing bound, which can only reduce aliasing
(`__giGtaoMaxStepPx = 42` restores the old unbounded reach).

### 11.49 THE PER-PROBE RAY CAP IS A SHARE OF THE BUDGET, NOT A CONSTANT (2026-09-05; SHIPPED)

**The user:** "why there is so little bounce so GI looks so flat and boring?"
… "we need to adjust based on the scene, so we get optimal GI in any scene".

**The constant was tuned on one scene and starved every smaller one.** The
tier cap is 8 rays per probe per dispatch, measured on Bistro where ~14.8 k
live c0 probes fill it and the frame fires ~93 k of its 393 k ray ceiling. The
user's Level runs **2,188** live c0 probes, so 8 each is 16.7 k rays — **4 % of
the ceiling** — while the merge reported **half those probes starved** and
`tiles.knownFrac` sat at 0.55: 45 % of every probe's directions had no measured
radiance and were filled from a neutral prior. A budget was being left unspent
in exactly the scenes that most needed it.

**The unit.** `cap = clamp(share × ceiling / liveC0, tierCap, CAP_MAX)` with
`share = 0.25` and `CAP_MAX = 32`. The share is deliberately a quarter: on
Bistro it evaluates to 6.6, the tier floor keeps the tuned 8, and §11.30's
measured win (SRC 48 → 19 ms) is reproduced exactly; on a small scene it lifts
toward 32 and spends the ceiling that was already paid for. `liveC0` comes from
the `readStats` readback that already runs every 60 frames — the right
timescale for a population that changes as the camera walks. The rest branch
still halves, but it halves THE SCENE'S cap rather than the constant.
`__giSrcCapBudgetShare = 0` restores the constant.

**Receipts (user's Level, same pose, before → after):**

| | before | after |
|---|---|---|
| probe ray cap | 8 | 16 (32 lifted, halved at rest) |
| rays / frame | 16,738 | **29,386** |
| c0 probes starved | 1,122 of 2,224 | **300 of 2,188** |
| bounce / direct | 1.054 | **1.242** |
| far-ray share | 42.5 % | **33 %** |
| merge orphan rate (all) | 8.1 % | **4.5 %** |
| c2 orphan rate | 18.4 % | **9.4 %** |
| SRC chain GPU | 6.14 ms | 6.16 ms |

Starvation down 73 %, rays up 76 %, a fifth more bounce per unit direct, a
third fewer rays wasted on the far field — **at no measurable GPU cost**,
because the extra rays ride passes that were already dispatched.

**⛔ TWO BUGS FOUND ON THE WAY, both of the same shape.**
1. `__giSrcProbeRayCap` was PINNED to 8 in the user's localStorage from an
   earlier debugging session, and a pinned cap disables every lift path by
   design. `__giSrcStarvePackets` was pinned to 4 against a shipped default of
   8 — halving the §11.16 mechanism that fixes exactly this symptom. **A dev
   flag left in localStorage is indistinguishable from a shipped default when
   reading the picture.**
2. The pin test was `Number.isFinite(Number(flag))`, and clearing a flag can
   leave the property present as `null`: `Number(null)` is 0, which is finite,
   so a CLEARED pin still read as pinned. Now requires a finite value > 0.

### 11.51 THE DARK BANDS ON THE WALLS ARE THE GATHER'S PLANE WEIGHT, AND ITS FLOOR IS A DELETION (2026-09-05; SHIPPED, default on; `__giGatherPlaneFloor = 0` restores the old behaviour)

The user, with their own beauty/path-tracer pair at one pose: *"most bounces seem
to get lost, and we still have dark bands on the walls."* Two complaints, two
different causes, and only one of them is fixed here.

#### The bands

`srcScreenGather`'s §13.7d plane weight fades a trilinear corner that sits behind
the shaded surface's tangent plane, `weight *= smootherstep(pd/depth + 1)`, and
floors the result at **1e-3**. That floor is not a weight, it is a DELETION, and
the algebra says every behind-plane corner reaches it: the fade depth is
`min(0.35·s, gatherPlaneDepth())` = **12 cm** at c0 while a cube corner sits up
to `s·sqrt(3)` = **61 cm** behind the plane. So the stencil is never the trilinear
eight; it is whatever subset happens to be in front — and THAT SUBSET CHANGES
where a wall meets a floor or a ceiling. Which is exactly where the stripes are.

- **The depth dial cannot reach this and a sweep of it measures nothing.**
`min(0.35*s, depth)` is already 12 cm, so raising `__giGatherPlaneDepthLive` to
1e6 changes no term. Measured, live, no rebuild, six arms 0.15 / 1e6 / 0.15 /
1e6 / 0.03 / 0.15: top-strip ratio .649 .654 .655 .659 .660 .661 — a monotone
convergence drift and nothing else. An hour went into that null before the
algebra was read. **The floor, not the depth, is the whole knob.**

THE RECEIPT (`scripts/gi-look-ab.mjs`, user's Level, one pinned pose; the metric
is an edge strip's mean irradiance divided by the open wall's, so 1.0 = no stripe
and the scene's ~2x boot spread divides out):

| arm | top | bottom |
|---|---|---|
| plane weight ON, floor 1e-3 (before) | .516 .507 .392 .371 | .412 .420 .323 .297 |
| plane weight OFF entirely | .880 .886 | .873 .880 |
| **floor 0.2 (shipped)** | **.803 .746 .738** | **.748 .705 .702** |

Bimodal, no overlap, four alternating rebuilds per pair. And the cost side is
empty: with the weight fully OFF the frame mean moved < 2 %, the open wall's own
value moved < 2 %, and **no enclosed region brightened** — pillar shadow side
x0.97, pier side x0.99, arcade recess x1.00, ceiling x1.02. The leak this guard
exists to stop did not return, so on this scene its entire measurable effect was
the artifact.

It still has to hold Bistro (§14 Q9's reason for defaulting it on: a facade pixel
interpolating the four corners INSIDE the building, black with the sky off). A
RATIO does that and a deletion is not needed for it — at floor 0.2 a front corner
outvotes a behind one 5:1, which turns a black interior probe from "the answer"
into a 17 % error, and the stencil can no longer collapse at a junction.

- The old note at `gatherNormalWeightExp` predicted this artifact with the sign
reversed — "BRIGHT BANDS at wall edges ... corners brighten, where reality darkens
them" — and prescribed scaling by the kept-weight fraction instead of
renormalizing. On this scene the strips are DARK and the open wall is right, so
that fix would have deepened them. The note was written about the earlier
direction-cosine form; the prescription did not survive the form change.

#### The bounce deficit is ONE NUMBER, and it is not any of the four usual suspects

The user's own pair: mean linear luma **0.0772 vs 0.2226**, i.e. **2.88x short**,
with the sunlit patches matching 1:1 and the ratio growing to 4-5x on the floor
and lower walls — the signature of missing higher-order transport, not of a
missing first bounce or an exposure mismatch.

**THE ROUND-TRIP GAIN.** The transport is a fixed point: hits deposit radiance
`Ld + Lb`, the field integrates it back as irradiance `E`. In an enclosure at
equilibrium `E = pi*(Ld + Lb)`, so
`gain = meanIrradianceLuma / (pi * (meanDirectLuma + meanBounceLuma))`
is what one bounce actually survives — and being a ratio of two numbers **from
the same frame**, it is immune to the boot spread that makes every absolute
reading here useless. Across 26 arms it reads **0.50-0.61**, dead stable. With
`meanLoopAlbedoLuma` 0.687 the multi-bounce series converges to
`1/(1 - 0.687*0.53)` = **1.57x** instead of `1/(1 - 0.687)` = **4.74x**.

**3.0x missing, which is the user's 2.88x to within the measurement.** Every
future energy unit should be scored on `gain`, and nothing that leaves it at 0.53
can close this gap however good its other numbers look.

REFUTED as the cause, each in a paired rebuild:
- **merge orphans** — 24.7 % of bins orphan but `orphanLiveRate` is **0.000**:
  every one is opaque (selfT = 0), byte-identical to a merge. The headline rate
  has been quoted as a deficit before; it is not one.
- **the merge's LOS** — `__giMergeLos = false` drops `losRate` .148 -> 0 and moves
  the gain .533 vs .529 base. Nothing.
- **`knownFrac`** — `__giMergeFillUnknown = true` lifts it .553 -> **.820**, a real
  and large coverage win, and the gain does not move (.528 vs .529). It also
  takes `orphanLiveRate` .000 -> **.321**: a filled bin is no longer "unknown", so
  it enters the merge and can orphan LIVE. Coverage bought with long-range light.
- **the far prior** — `__giSrcFarPrior = false` moves the gain .529 -> **.573**,
  the only lever that moved: worth ~7 %, not 200 %.

OPEN, and where the far prior's 7 % points: `createGiFarFieldAvgPass` publishes
the screen gather's mean **irradiance** E, and its consumers (the merge's orphan
branch, the fresh-probe seed) read `E/pi` as a **radiance**. That is the radiosity
of an albedo-1 surface carrying NO DIRECT LIGHT. Measured here: prior 0.060
against a true mean hit radiance of 0.117 — **the far field is half as bright as
the world it stands for.** The number it should carry, `rho*E/pi` plus the mean
direct radiance, is already tallied every frame by the secondary pass
(`meanDirectLuma + meanBounceLuma`); wiring it GPU-side is the next unit.

#### The rig, and why nothing measured before this session could be trusted

- **A LIVE "PIN" THAT ONLY WRITES WHEN THE FLAG IS SET LATCHES FOR EVER.**
  All four `__giGather*Live` dials read `if (Number.isFinite(pin)) uniform = pin`,
  so DELETING the flag left the last pinned value in place and the arm called
  "restore the default" re-measured the previous arm. This session lost three
  arms to it (LOS pinned to 0, cleared, still 0) before the picture stopped
  making sense. Fixed: a cleared pin now restores the build-time default through
  the same shared reader the mirror uses. **An A/B rig that cannot return to its
  own baseline is worse than none — it produces confident numbers.**
- **The MCP CLI races the broker.** `client.connect` resolves when the stdio
  server is up; the server then dials the broker and the broker then finds the
  editor. A call landing in that gap fails with *"needs the engine editor to be
  running and connected"*, which reads exactly like the editor being down. Every
  spurious arm failure was this. `gi-look-ab.mjs` now polls `editor_status` first.
- **The path-tracer debug view resets its accumulation when the camera is
  touched.** The rig re-pinned the pose every 500 ms to fight pose drift, which
  held the reference at ONE SAMPLE — a bright, band-free, shadowless room that is
  extremely convincing and is not a reference. `--pin once`. (The same flat frame
  appeared mid-rebuild and was briefly read as a 6x brightness win; it was the GI
  being off.)
- **The metric has to be a ratio.** `mid` (the open wall's own irradiance) read
  .0100, .0128, .0134, .0205 across four captures of the SAME configuration — the
  documented ~2x spread. The stripe ratio and the round-trip gain both normalize
  it out and are stable to +-0.02.

### 11.52 THE SKY WAS A POINT SAMPLE PER BIN, AND THE HDRI'S SUN NEVER ENTERED THE TRANSPORT (2026-09-05; SHIPPED, default on; `__giSkyBins = false` restores the per-bin texture tap)

**The report.** The user's Level, their own beauty/path-tracer pair at one
pose: "ours has a lot less light bounces", with a guess that the glossy
floor was cutting the bounce. Measured on the pair (linear luma, regions):

| region | ours | tracer | ratio |
|---|---|---|---|
| sun patches (green wall, left wall) | .544 / .504 | .571 / .642 | 1.05 / 1.27 |
| ceiling (mid, left) | .070 / .089 | .218 / .295 | 3.1 / 3.3 |
| left wall in shadow | .083 | .342 | 4.1 |
| green wall in shadow | .015 | .055 | 3.6 |
| floor mid | .060 | .195 | 3.2 |
| whole frame | .097 | .223 | 2.3 |

Direct matches; every indirect region is 3–4× dark. **The floor is not
it**: its palette entry is albedo 1.0 (the graph's `#ffffff`), the mirror
mask (`giNormal.w`) is never read by the SRC population, and `profile.giPasses`'
per-hit ledger at this pose read gain 1.03 — the bounce loop was at its own
equilibrium. Whatever was missing was INPUT to the loop, not transport.

**The input.** `Belfast Farmhouse_2k.hdr`, environment intensity 1,
lighting on. Read on the CPU (cv2): up-facing irradiance 4.39, of which
**3.70 (84 %) is a sun** — 418 px above 50× the sky median, peak radiance
179 830, elevation 21.7° — while the directional light sits at 61°. The
tracer importance-samples that map; ours composited the sky per bin with
`skyEnv.node.sample(equirectUV(rd)).level(0)`, one bilinear tap at the bin's
centre direction, in BOTH sites (the merge's top-cascade close, srcMerge
[G.2]; the tile bake's orphan/residual `T·sky`, srcTiles). A bin spans 4.5°
(c3) to 36° (c0); a few-texel sun is never under a centre. **The point tap
deleted 84 % of the environment's energy by construction**, and it did it
silently because a uniform-sky furnace reads the same through any tap.

**The unit.** `srcSkyBins.js`: integrate the equirect ONCE on the CPU into
the kernels' own bin grid (`binDirTable`'s Morton order, the yaw baked in as
the inverse of the kernels' `rd = R(rotY)·d`), every texel to exactly one
bin with its solid angle, mean radiance per bin. Both sites read the table
by the bin index they already have and keep the tap as the GPU-selected
fallback (`ready = 0`: an image-backed or compressed source, every gate
fixture, and the live switch). Widths come from one pass at the largest
requested grid and aggregate exactly (a 2w×w cell is a k×k block of the
finer grid). Half-float RGBE decodes through a LUT; texels pre-sum in
blocks to ≤ 1024 columns (exact sums; only a block on a bin border lands
whole in the bin of its centre — 0.35° against ≥ 4.5° bins). 2 M texels ≈
15 ms, keyed on (texture, version, yaw), throttled to one run per 150 ms so
a rotating map cannot pay it per frame.

Gate: `npm run test:gi-sky-bins` (bare Node, 54 checks): the furnace (every
bin reads a uniform map as itself, Σ Δω = 4π), one hot texel landing in ONE
bin whose rotated centre points back at it (flipY both ways, three yaws),
block pre-summing energy-exact, fine→coarse aggregation equal to direct,
half decode, and the table manager's keying/throttle/late-width/fallback.
`test:gi-src-merge` and `test:gi-src-tiles` stay green on the fallback path.

**⛔ Two rig traps this unit paid for.**
- **NO STORAGE BUFFER SURVIVES A GI TEARDOWN, so a kernel-bound buffer is
  PER BUILD.** The dispose site retires the UNION of every storage attribute
  the stale kernels bound (the harvest) and every owner-published list — there
  is no keep set (its own comment: "nothing survives a teardown, so there is
  no diff to take"). The first cut kept one table set for the life of the
  system: unpublished, the first swap destroyed it while the new kernels
  still bound it (`Invalid BindGroup "bindGroup_object" is invalid due to a
  previous error`); published in `srcSystem`'s list — the "fix" — it was
  retired on purpose (`[Buffer] used in submit while destroyed`). Both on
  exactly the three sky-reading kernels, tiles `lit 0`, a white far field.
  Shipped: the manager keeps the CPU integration; `beginBuild()` hands each
  `createSrcProbeSystem` fresh attributes filled from it at once, published
  through the build's own list so its teardown retires them; the last two
  builds stay filled across the retire window.
- **The intermittent dead boot (GI built against 0 placements) threw 400×/s
  from `losSegment`**: `traceStaticBvh` returns null with no static BVH and
  the seed's LOS closure read `.x` of it inside the compile wave. Guarded —
  "no wall crossed" — so a dead boot degrades instead of storming; the race
  itself (`black-boot-investigation`) is untouched.
- **The console ring could not show the previous error.** ~700 identical
  lines a second evicted the one line that named it within a second.
  `consoleStore.push` now folds a repeat into its earlier entry (48-entry
  window) with a count; `console.read` reports `count`, the panel shows ×N.

**Receipt (same boot, same pose `6.107,1.315,−5.593 → 5.864,−0.456,7.305`,
same population of 1 902 c0 probes, ray cap 32, each arm converged ≥ 75 s;
`profile.giPasses` hit ledger, lod 0):**

| arm | Ld | Lb | E at hits | atlas mean lum | atlas max bin | far field raw |
|---|---|---|---|---|---|---|
| tables OFF (`__giSkyBins = false`, the old point tap) | .0256 | .0320 | **.1339** | .182 | 3.2 | 34/42/28 |
| tables ON (shipped) | .0256 | .0360 | **.1488** | .211 | **12.3** | 35/44/30 |

+11 % irradiance at the hits, +16 % on the atlas mean, and the brightest
atlas bin goes 3.2 → 12.3: that is the HDRI's sun reaching a c0 orphan bin
(36° at w=4 — predicted ≈ 9.5 from the map's 3.7 sr·luma over 0.39 sr).
The boot receipt for the map: `[gi] sky: environment integrated per bin —
2048×1024 half equirect → bin widths 4/8/32 in 273 ms [now ~50 ms]; up-facing
irradiance luma 2.842, brightest bin 965.97`. (2.84, not the 4.39 the float
file holds: the loaded texture is HALF and clips the sun at 65 504 — the
tracer samples the same texture, so parity is unaffected.)

**What it is not.** The user's pair is 3–4× on every indirect region; this
unit is worth ~1.1× at this pose. The HDRI sun (elevation 21.7°) evidently
does not reach this room through an opening that faces it, so its energy
arrives only after bounces elsewhere. The remaining gap, from the same ledger:

- **THE ROUND-TRIP GAIN IS A COVERAGE NUMBER.** `gain = E/(π·(Ld+Lb))` read
  **1.03** on the earlier boot of this very pose (7 104 live c0 probes after
  the user had walked the level — retention kept probes on surfaces now
  behind the camera) and **0.74–0.77** on a fresh boot at the same pose
  (1 902 probes, only the visible surfaces). Same code, same scene, same
  camera. A hit on a surface no probe covers reads a poor field (the coarse
  fallback / prior), so light that enters the loop off-screen — most of the
  light in a level lit through openings — is under-returned by ~25 % PER
  BOUNCE, which compounds: series 1/(1−.74·.74) = 2.2× against 1/(1−.74) =
  3.8× for the same albedo. This is the §11.51 memory's "gain 0.53" in
  another costume, and the doc's "36.4 % of secondary hits with no
  fine-probe support" — `srcSecondaryReceivers.js` (opt-in) is the unit
  aimed at it and its last receipt was inconclusive.
- **THE LOOP ALBEDO CEILING** (`MAX_LOOP_ALBEDO` 0.9): every blockout wall
  and the floor here are albedo 1.0 and the hit-weighted ρ_loop reads 0.7375
  (whites capped to 0.9, the green wall, wood). `__giSrcLoopAlbedo` is the
  build-time dial (0 < x ≤ 1); receipt below.

**Loop-albedo receipt (`__giSrcLoopAlbedo`, same boot, same pose, 1 902 c0
probes).** ⚠ The first cut of the dial only reached [E]'s attribution copy
(a counter); `srcSecondary.js` clamps AGAIN and that clamp is the loop's
gain — fixed, the dial now lands in [J] (`maxLoopAlbedo` option).

| arm | ρ_loop (hit-weighted) | Ld | Lb | E at hits | atlas mean | far raw |
|---|---|---|---|---|---|---|
| 0.97 (boot build) | **.789** | .0264 | .0479 | **.187** | .260 | 44/54/37 |
| 0.9 default (flag cleared → REBUILD) | **.743** | .0236 | .0300 | **.122** | .186 | 31/38/25 |

The albedo half is clean (+7 % on ρ_loop, the whites 0.9 → 0.97). The
energy half is NOT a clean pair: the rebuilt state differs from a boot
build in more than the ceiling (c2 orphan rate .12 → .55, merge LOS
suppressed 0 → 3 260, far-ray rate 34 → 45 %), so "+54 % E" overstates the
ceiling — the series predicts ~+30 % at this ρ. Default stays 0.9; the dial
is real now and the next arm must be boot-vs-boot or rebuild-vs-rebuild.
⛔ A flag-triggered rebuild is not the same state as a boot build — read the
merge block beside any two arms before calling them a pair.

**Follow-up: "it looks even darker than before" (02:26 vs 01:20).** Measured
0.72× whole frame, 0.52× ceiling, 0.49× floor, sun patches 0.84–0.92×. Not
this unit: at that state, tables OFF/ON read E at hits .116/.130, atlas mean
.166/.212, and the screen-mean irradiance texel equal within 3 %. The Sun had
moved: the 01:20 boot's `§12.82 sun slot … dir 0.407,0.878,−0.252` is
elevation 61°; every boot since reads `0.940,0.262,−0.220`, elevation 15°,
which is exactly what the Sun entity's rotation `(−2.269, 1.222, 2.082)` gives
— the scene autosaved between 01:19 and 01:29 during the floor experiments.
A 15° sun puts roughly a third of the 61° sun's power through the level's
openings, and its patches land elsewhere. ⛔ Read the sun-slot line and the
camera beside any before/after pair.


### 11.53 THE SUN IS NOT SKY — the HDRI's sun rode the exact bin tables into the probes as shadowless blotches (2026-09-05; SHIPPED, default on; `__giSkySunExtract = false` keeps the sun in the bins)

**The report.** Bistro, `Belfast Farmhouse_2k.hdr`, environment intensity
1: "when sky lighting is on, we get wrong lighting all over the scene …
without sky light, everything looks great", with three screenshots — grey
cloud-shaped patches at probe spacing on every facade, brightest on the
building fronts, an alley reading flat and muddy. The user turned lighting
OFF and saved.

**The cause is §11.52's own success.** The exact per-bin integration did
what it promised: the map's sun reached the transport. The boot line read
`up-facing irradiance luma 2.840, brightest bin 959.84` — one 4.5° bin at
960 against a sky whose p99.9 luma is 2.7. Read on the CPU through the same
half-float texture the scene loads (`scripts` scratch, RGBELoader, exact
Δω):

| map | E_up | of which sun | sun width | elevation / azimuth | facade facing it: sun vs rest |
|---|---|---|---|---|---|
| Belfast Farmhouse (this scene) | 2.86 | **2.15 (75 %)** | 2.4° | 21.5° / 36.2° | **5.5 vs 1.1** |
| Kloofendal 43d Clear | 4.57 | 3.29 (72 %) | 2.0° | 43.0° / 36.2° | 4.5 vs 2.5 |
| Industrial Sunset (pure sky) | 2.73 | 0.007 (0.3 %) | — | — | 0.13 vs 3.0 |
| Dikhololo Night | 0.34 | 0.001 (0.3 %) | — | — | — |

The scene's REAL sun is the directional light: luma 10 at elevation 47°
(`§12.82 sun slot … dir 0.017,0.731,0.682`), 6.8 on a facade that faces
it, delivered with an 8000 px shadow map. The HDRI's sun is a SECOND sun
at 80 % of that strength, at another azimuth, with no shadow map at all:
it is composited as `mean bin radiance × T`, and `T` for that one bin is
the transmittance a probe estimated from a few rays (cap 8/frame,
confidence K = 16). A 2.4° source inside a 4.5°–36° bin is exactly the
thing a bin cannot carry — the bin's radiance is right on average and
wrong everywhere in particular, and the error is the probe lattice itself:
grey patches at 2–3 m on every wall that sees the spot. §11.52's receipt
(+11 % E at hits on the Level) was mostly this sun, delivered this way.

**The unit (srcSkyBins.js §11.53).** A sun is a delta light; the sky term
carries the sky. The integration now finds the map's sun and books it apart:
- **Ceiling**: `8 × the solid-angle-weighted p99.9 luma`
  (`skyLumaCeiling`, a log histogram over every 2nd row/column). Rank-based
  on purpose — the map's MEAN is 84 % sun and says nothing; its p99.9 is the
  brightest cloud, which a sun clears by 2–5 orders of magnitude. Measured
  at 2×…64× p99.9 the extracted share is flat (84.1 → 83.2 % on Belfast,
  76.9 → 75.6 % on Kloofendal) and the sunless maps lose 0.4 → 0.0 %; 8×
  is the middle of that plateau.
- **Per-texel excess** above the ceiling (chroma kept) is summed per bin
  beside the sky (`sun.sum`, `sun.binOmega`), with its energy, up-facing
  irradiance, texel count and energy-weighted direction in the WORLD frame
  (the yaw undone). `sum` stays the whole map, so every §11.52 check holds;
  `aggregateBins` carries the excess exactly; `binMeanTable(bins, out,
  { sun: "extract" })` subtracts it — the bin keeps its full solid angle, a
  clamped texel reads as the CEILING, not as a hole.
- **Decision** (`describeSun`, the manager): extract when the excess is
  ≥ 2 % of the map's up-facing irradiance (`SUN_MIN_SHARE`); below that the
  tables are the whole map bit for bit. The hatch is part of the table key,
  so `profile.giFlag __giSkySunExtract false` re-integrates live, no rebuild.
- **Receipt** (two boot lines): `up-facing irradiance luma 2.863 (sky 0.713
  + sun 2.150), brightest bin 9.21` and `the environment carries a SUN — 75 %
  of its up-facing irradiance in a 2.4°-wide spot at elevation 21.5°,
  azimuth 36.2° … EXTRACTED … the sun is a Sun light's job — yours points
  from elevation 47.0°, azimuth …° (aim it at 21.5°/36.2° to match the
  HDRI's shadows)`; with no active directional light the line says to add
  one from that direction. Brightest fine bin 959.84 → 9.21 (Belfast),
  794.55 → 8.04 (Kloofendal); the sunless maps read the same as before.
- **Cost**: 66 ms for the 2k map on the first integration (30 ms on a
  sunless one; the histogram is a second pass), once per environment change,
  throttled 150 ms. Nothing on the GPU changed — the kernels read the same
  table.

Gate: `npm run test:gi-sky-bins` — 92 checks (54 before): the ceiling sits
between a uniform sky and a hot spot; the excess is exactly the spot's
energy above the ceiling and points back at the texel in the world frame
(three yaws, flipY both ways); the extracted table is the furnace again
except the spot's bin, which reads the ceiling; a 21-row cloud bank at 10×
is sky (nothing extracted, table = whole map); aggregation carries the
excess; the manager extracts by default, keeps on the hatch, and its
receipt's peak is the table's.

**What it does not do, on purpose.**
- It does not DELIVER the HDRI's sun. The sun is the scene's directional
  light (raster direct + shadow map + the SRC's sun slot); a scene with a
  sunny HDRI and no Sun light gets a clean overcast sky and a log line with
  the direction to add one. Auto-creating a light is a scene edit, not a GI
  decision.
- The env-on-miss term and the reflection capture still sample the raw
  map — a mirror shows the disc; that is visibility, not lighting.
- ⚠ The path tracer still importance-samples the RAW map, so a GI-vs-tracer
  pair with lighting ON now differs by the HDRI's sun (sharp in the tracer,
  absent in ours). §11.52's Level gap is partly that sun. The honest pair
  hands the tracer the same clamped environment — a follow-up unit in
  giPathTracer's `updateEnvironment` (swap `scene.environment` for the
  clamped copy around the sync), not done here.

**Live receipt (Bistro, the user's saved pose, `scripts/gi-look-ab.mjs`,
20 s settle per arm, flag flipped live — no rebuild).** Boot lines after
the reload: `up-facing irradiance luma 2.863 (sky 0.713 + sun 2.150),
brightest bin 9.21` and `the environment carries a SUN — 75 % … 2.4°-wide
spot at elevation 21.5°, azimuth 36.2° … EXTRACTED … yours points from
elevation 85.9°, azimuth 76.0°`. Arms `__giSkySunExtract` false → default:

| | sun kept | extracted |
|---|---|---|
| tile atlas maxLum | **85.53** | **2.84** |
| tile atlas meanLum | 0.293 | 0.234 |
| frame mean luma (linear) | 0.1640 | 0.1633 |
| pixels where the arms differ by > 0.02 | 1.0 % | — |
| band-pass std (6–48 px) of the difference, where the sun term landed / elsewhere | 0.0085 / 0.0003 | — |

At this pose (camera at 6 m looking down a street canyon) the 21.5° sun
reaches almost nothing on screen — the user's blotches were on UPPER
facades facing azimuth 36°, which this pose does not frame — so the
frame-mean pair is a null by construction, not evidence either way. What
the pair does show: where the term lands it is PATCHY (28× the band-pass
energy of the rest of the frame at 6–48 px, band/low ratio 1.5 at 12–96
px — the probe lattice, not a gradient), and the atlas's peak is the
extracted sun. Cost after the stride-4 ceiling and its per-texture cache:
~18 + 3 ms warm on a 2k map (55–65 ms on the first, JIT-cold call).
