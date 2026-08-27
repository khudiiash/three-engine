# GI §19 — AUDIT RECEIPTS (2026-08-26)

Companion to `GI_SCALE_PLAN.md`. These are the raw findings the plan was cut
from, kept so implementation sessions can execute from them without re-reading
the module. file:line refs are as of commit 9b17d8c + the 08-26 working tree.

---

## A. DEAD-CODE CENSUS (Stage 0.1 work list)

Module: `src/modules/gi/` — 49 files, 61,037 lines. Comment ratio by line:
GISystem.js 50 % (8,460 / 8,472), giScreen.js 56 %, srcConfig.js 83 %,
srcMath.js 64 %, srcSystem.js 63 %.

### A.1 `__gi*` flags — 309 distinct, 290 read in code
| shape | count | action |
|---|---|---|
| numeric knob (`?? default` / `Number(...)`) | 106 | delete the non-default arm; the default becomes the constant |
| OPT-IN (`=== true` / truthy) | 82 | delete unless in A.3 "live A/B" |
| DEFAULT-ON revert hatch (`!== false`) | 81 | delete the hatch AND the old arm it keeps compiled |
| instrument exposure (assign) | 17 | keep only what `profile.*` reads |
| comment/log-only (zero code reads) | 19 | delete: `__giPassName`(21×), `__giDebug`(8×), `__giDebugTex*`, `__giShaderSource`, `__giDeviceTier`, `__giEmitterFit`, `__giTriClusters`, `__giSkinnedCapsules`, `__giSrcVolumeShadows` … |

### A.2 Retired arms (comment on the gate line says refuted/legacy/superseded)
| flag | site | arm to delete |
|---|---|---|
| `__giAoLegacy === true` | GISystem.js:7400, 7597 | screen spirals + vxao cones: giScreen `createGiAoPass` :1355 (265 lines) + `createGiVxaoPass` :2320 (143); GISystem `#armAoPass` :7283 (83) + `#armLegacyAoPair` :7366 (33) + `#armVxaoPass` :7808 (51) + vxao bundle :5897-5930 (`__giVxao !== false` still BUILDS it by default); occupancyField `traceOccupancyConeAO` :2513 (~150) — **≈ 750** |
| `__giAoRaytraced === true` | GISystem.js:7407, giScreen.js:1822 | RTAO: giScreen `createGiRtaoPass` :1620 (219) + GISystem `#armRtaoPass` :7596 (212) + `__giRtao*` — **≈ 440** |
| `__giOneBvhReflect === false` / `__giBvhV1` / `__giBvhV1Light` | GISystem.js:9133; giLight.js:2250; giScreen.js:4438 | incumbent ≤128-mesh BLAS loop: bvhScene.js `bvhMeshFirstHitFn` :205 (147), `packGeometryBlas` :85 (120), most of `buildBvhScene` :566 (453 — ⚠ still called unconditionally at GISystem.js:9010 and is the fallback when `traceStaticBvhSlot` is absent: removal = commit to the static BVH8 only); giScreen else-branch :4400-4408 + `dynamicBlocked` :4438 — **≈ 600** |
| `__giSrcSunSplit` (+`__giSrcSunSplitKeep`, `__giSunSplitHoldNormal`, `__giSunSplitCos`) | srcSystem.js:1097 | srcDeposit :415-427, 905-945, 1431-1553; srcSystem :1096-1123; srcShade :504-583, 923-928 — **≈ 250** |
| `__giAdaptiveLattice !== true` | GISystem.js:10100 | `#chooseAdaptiveLattice` :10040 (187) + `__giLod0Reach*` — **≈ 200** |
| `__giSrcWorldKeys`, `__giGatherSmoothWeights`, `__giGatherLosWeight`, `__giMergeLosWeight`, `__giGatherNormalWeight` | srcMath.js:407, 537, 648, 679, 565 | srcMath :406-531 (`worldKeysEnabled`, 125) + :536-700 (~165); branches in srcMathTsl :275-401, srcMerge :221-345, srcProbes :1330-1395, srcScreenGather :204-346, srcSeed :190, srcGizmos :127 — **≈ 500** ⚠ LOS weights are the class GI2's probe visibility replaces; delete with SRC, not before, if Stage 2 wants to A/B them |
| `__giShadowStaticBvh !== false`, `__giLightShadowLegacyDda`, `__giLightShadowSphere`, `__giConeShadowDensity`, `__giShadowAnalyticWidth` | GISystem.js:5130-5257, giScreen.js:2595 | non-default arms inside `#buildLightShadow` :5114-5636 (≈ 250 of 522: :5130-5140, 5300-5400, 5486-5530) + giScreen `createGiLightShadowHistoryPass` :3759 (53) + stochastic halves of :2463 / :3248 — **≈ 350**. ⚠ the records marcher is still the SRC ray default (`pickOccTrace`, srcTrace.js:71) — RayHitPacking GPU side is NOT dead |
| `__giSrcSplitShade !== false` | srcSystem.js:724 | one-kernel shade: srcShade `createSrcHitShader` :887 (36) + srcSystem :1133-1160 — **≈ 60** |
| `__giSkinnedProxyShape !== "capsule"` | GISystem.js:16754 | capsule arm: skinnedProxy :165-184, :666-758 — **≈ 110** |
| `__giLegacyEmitterShapes`, `__giSphereEmitters` | emitterShapes.js:702 | :702-730 — **≈ 30** |
| `__giEmitterAreaSample` :6860, `__giFollowDrs` :9405, `__giEmitterRecordShadows` :5637, `__giEmitterTileCut` :6434, `__giEmitterSeatFill` :14218, `__giRayHitValidateLegacy` RayHitConfig.js:143 | | each keeps a "restores the old …" arm |
| parked | GISystem.js:15673 `#moverOccluders` (108, never called) + `#syncMoverOccluders` :15858 (176, early-returns every frame) — **284** | |
| stale banner | GISystem.js:9308-9364 (57 lines say `__giBvhMask` is "STILL OPT-IN"; :9365 returns default-ON) | rewrite to 5 lines |

### A.3 Live A/B hatches — keep until GI2 cutover
`__giBvhMask`, `__giRtaoDynamic`, `__giEmitterAnalyticPenumbra`/`__giLightAnalyticPenumbra`, `__giSrcMotionRoot`, `__giSrcCamCapLift`, `__giSrcCamSettleAlpha`, `__giSrcMaturity*`, `__giSrcProbeRetain*`, `__giSrcRestCadence`, `__giSrcLightSettle*`, `__giIrrTemporal`/`__giShadowTemporal`, `__giReflectHold`/`__giHitShadeHold`, `__giGbufferFreeze`, `__giDiffuseSkipMovers`, `__giShadowBurialGate`, `__giRayHitMode`. Debug instruments to keep: `__giDebugView`, `__giShadowKindDebug`, `__giHitTermMask`, `__giColourProbe*`, `__giMaskCoverageProbe`, `__giFreeze*`, `__giLog*`, `__giPortableAudit`, `__giOff`, `__giKeepIBL`.

### A.4 Whole files
| file | lines | imported by | verdict |
|---|---|---|---|
| srcRef.js | 1720 | nothing in src; 9 scripts (`gi-src-*.html`, run-gi-src-ref-test) | delete with its scripts (SRC oracle — GI2 does not need it) |
| srcVolumeRef.js | 418 | run-gi-src-volume-test only | delete |
| rayHit/RayHitPacking.js CPU mirrors | ≈1300 of 2040 (:239-425, :571-830, :856-2040) | scripts only (`test:gi-rayhit*`, gi-src-surface.html) | delete mirrors + their tests; GPU side stays until cutover |
| lightTree.js CPU sampler | :1178-1674 (≈500) + `triangleClusters` :628 (166) | scripts only (`test:gi-lighttree-*`, `test:gi-emitter-split/power`) | delete; `buildLightTree`/`collectEmitters`/`estimateLightTreeWords` are LIVE |
| bvh/bvhGpu.js | 285 | run-gi-bvh-spike.mjs (no npm script) | delete |
| rayHit/RayHitValidator.js, RayHitDebug.js | 167 + 165 | index.js re-export; `__giRayHitProfiling` | delete |
| srcDebugViews.js, srcGizmos.js | 215 + 214 | debug view / gizmo group (built unconditionally, hidden) | keep debug views; make gizmos lazy |
| primitiveFit.js, voxelizeOnce.js (name stale — no voxelizer left; holds `resolveMaterialSurface`, `noteTextureAverage`, `serializeMeshForBake`) | 228 + 408 | live | keep, rename |
| bootAmbient.js, srcSecondary.js, srcOctahedral.js, lightTreeGpu.js, skinnedProxy.js (box arm), reflectionProbe*.js | | live | keep |

### A.5 Unused exports (src=0, scripts=0)
occupancyField `SURFACE_PALETTE_WORDS`:134, `SURFACE_PALETTE_NO_EMITTER`:136; giConfig `giQualityTier`:110, `giDeviceTierCeiling`:145 (⚠ verify — the tier ceiling must be LIVE for mobile; if unused, that is a bug to fix, not code to delete); giFn `builderFn`:44; reflectionProbes `createReflectionProbeSlots`:81; slotRegistry `geometryContentHash`:77; srcVolume `createSrcWorld`:98, `createSrcDistance`:155, `createSrcWidthProbe`:186, `createSrcSoftShadowTrace`:299; srcTiles `tileAtlasLayout`:140; srcMathTsl `roundHalfUp`:100; srcGizmos `srcGizmoHue`:212; RayHitConfig `resolveAutoRayHitMode`:96; dynamicObjects `buildBvh8Words`:322, `dynBvhArity`:829, `DYN_TYPE`, `OBJ_WORDS`; giLight `GI_MIRROR_ROUGHNESS_MAX`:63, `GI_SPECULAR_ROUGHNESS_MAX`:64, `GI_TIER_SHARP_MAX`:212, `GI_TIER_MEDIUM_MAX`:213, `boxGlowMiss`:609, `emitterExclusion`:1195; ~40 `STAT_*`/`MERGE_*`/`GG_*`/`TS_*`/`SEED_*`/`COUNTER_*` constants read only via GPU layout.

### A.6 Ranked chunks
1 srcRef.js 1720 · 2 RayHitPacking CPU mirrors ≈1300 · 3 legacy AO pair ≈750 · 4 incumbent BLAS reflections ≈600 · 5 lightTree CPU sampler ≈666 · 6 gather experiments ≈500 (defer) · 7 srcVolumeRef 418 · 8 RTAO ≈440 · 9 light-shadow arms ≈350 · 10 mover occluders + validator/debug/bvhGpu ≈900. Plus ≈700 lines of retired-mechanism banners (15 blocks ≥40 lines in GISystem.js: 102-160, 2120-2164, 3082-3131, 3651-3690, 3804-3844, 5596-5635, 6324-6372, 6881-6933, 9308-9364, 10050-10099, 11461-11525, 11667-11708, 11779-11819, 13233-13280, 15732-15780; 12 in giScreen.js: 471-541, 1548-1619, 1771-1838, 4974-5043 …).
**Total ≈ 7,500-8,000 lines without touching the default frame.**

---

## B. MEMORY LEDGER (Stage 0.2 work list)

Sizing inputs: voxel = `min(1.5, max(0.05, maxAxis/128, cbrt(volume/cells)))`
(GISystem.js:10319-10322), res quantized to 16 (occupancyField.js:138, 225).
Bistro (110×36×110 m): 0.86 m → 128×48×128 = 786 k cells at EVERY tier.

| item (all `instancedArray` ⇒ CPU twin retained) | formula | Bistro ultra |
|---|---|---|
| pyramid L0-4 | Σ ceil(x/32)·y·z words (occupancyField.js:176-190) | **0.11 MB** |
| surface records | `totalSurfaceCapacity × 4 words`, cap 2²¹ (:303-316, 340-352) | 34.6 MB |
| exact-triangle pool | `complexTriangleCapacity × 9 words`, hint ≤ 2.5× records (:288-292; GISystem.js:15335) | 129 MB (ceiling 189) |
| `surfScratch` (build-only, never freed, :638) | capacity × 10 words | 86.5 MB |
| attribution + palette + `attrScratch` (:609-624) | 2×capacity + slots×8 | 17.3 MB |
| dynamic-object BVH4 pool (GISystem.js:15234-15237) | tier words | 6.3 MB |
| static BVH8 region (dynamicObjects.js:349, 449-458; GISystem.js:15301) | 1.5 × (nodes×28 + tris×10 (+3 UV)) words | 188 MB (+36 UV) |
| ⚠ static-BVH STAGING duplicate (dynamicObjects.js:1874-1880; spliced :2214, never released) | | +125-160 MB GPU + CPU |
| voxelizer `vdata/idata/pairWork` (:4752-4787) | verts×1.3×16 + tris×1.3×12 + pairs×1.4×12 B | 180-270 MB |
| SRC bin store (srcDeposit.js:544-546) | bins×13 words + hitList transportRays×16 + blocks×5 | 171 MB |
| SRC probe store / per-pixel / tiles / merge | | 4 + 23 + 15 + 1.8 MB |
| screen targets (giScreen.js:4521-4948) | gbuffer RGBA32F+RGBA16F, ~12 full-res 16F, temporal ×3 32F histPos | ≈ 184 full + 63 half |
| albedo atlases | per-slot 1536² canvas 9.4 MB + 19 MB RT; per-mesh 3072² 38 + 75 MB | |
| CPU-only: `voxelizeOnce.js:358-361` geometry copy (~86 MB), `extentsCache` :831 (12 MB), `buildStaticSceneBvhWords` transient (~780 MB per rebuild, dynamicObjects.js:548-597; re-run on the UV-drop rung GISystem.js:15375), `makeField` ladder ×4 (:15361-15390), `readbackBits` :5429 | | |
| `occupancyField.dispose()` = `{}` (:5486); `releaseComputeNodes` called at ONE site (GISystem.js:12714); resize `#syncScreenResolveSize` :7859, pool-grow, geometry-revision swaps have no sweep | | orphaned generations |

**Fix order:** detach `.array` after flush (verify incremental writes :4859-4894) → release staging → free scratch after fit → sweep at the 3 swap sites + real `dispose()` → byte-budget the exact-tri pool per tier → worker BVH / allocate `bits` once from arithmetic → drop the voxelizeOnce copy → trim screen residency (position → depth-reconstruct, fold 3 histPos, size atlases by live).

---

## C. PORTABLE ENVELOPE (Stage 0.4 / GI2 constraint)

| limit | Safari/iOS floor | Android floor | GI today |
|---|---|---|---|
| storage buffers / stage | 8 (Safari never > 9) | 10 | ≤ 8 after 08-23; audited (`#auditPortableBindings` GISystem.js:4205-4240, logs only) |
| uniform buffers / stage | 12 | 12 | **unaudited**; hit-shade needs 16 (giScreen.js:4143-4149) |
| storage textures / stage | 4 | 8 | resolve writes 3 (+1 BVH) — **unaudited** |
| maxBufferSize | **256 MB** | 1 GB | `bits` 321-491 MB is ONE buffer; ladder GISystem.js:15357-15390 |
| storageBufferBindingSize | 128 MB | 128 MB | bin store THROWS at 128 MiB (srcDeposit.js:486) |
| workgroup memory / invocations | 16 KB / 256 (compat 128) | 16 KB / 256 | none used; all `[64,1,1]` 1-D |
| colorAttachmentBytesPerSample | 32 | 32 | gbuffer 24 B ✓ |
| features | no subgroups, float32-filterable 52 % iOS, no rw storage textures, timestamp 85 % | | none required ✓ |
| language features | `unrestricted_pointer_parameters` unchecked | | `wgslFn` ptr params: dynamicObjects.js:612, 720, 842, 980; bvhGpu.js:156; bvhScene.js:215 |
| WebKit behaviours | failed pipeline = silent no-op (319770); OOB `textureLoad` → 0 (305727); `onuncapturederror` property never fires; many command buffers stall (311598) | | IBL blackout on dispatch (GISystem.js:2183-2224); ~60 submits/frame |
| memory ceiling | iPhone ≤14: 350-450 MB page; 15+: ~1 GB | Dawn OOM → device lost, 2 losses/2 min blocks the GPU process | no total budget; `device.lost` → same-size rebuild (Engine.js:593-605) |

Tier ceiling today: mobile UA → `low`, macOS Safari → `medium` (giConfig.js:147-165);
pools, static BVH, exact-tri pool are NOT tier-keyed.

---

## D. PER-FRAME PASS SHAPE (why the GPU floor does not shrink)

Dispatch order (GISystem.js `#tick` 2103-4048): CPU polls (floor drain, follow) →
uniforms + O(slots) transform refreshes → **gbuffer raster** (full scene, +mask
pass) → SRC chain (65 dispatches; capacity-sized: age ×4, cap ladders, decay
`compute(binTotal)`, seed, resolve `compute(binTotal)`, merge `compute(bins ×
blockCapacity)` ×2, tiles over every block; pixel-sized: insert, gather, GTAO) →
bvhReflect → probe capture → occupancy chain only on revision → frameQueue
(emitter shadow chain, resolve, hit shade + temporal, irr temporal + history)
→ `#checkFingerprint` every 5 frames (`#collectMeshes` full traverse).
Follow-slide: `#detailFollowTick` :15008-15060 → `#refitInPlace` →
`occField.refit()` sets `staticDirty` (occupancyField.js:5261-5266) → full chain
(:5010-5018) every ~6 m; arms `_giSlideHeld` 1.2 s (:15088). Pool ceiling: c0
blocks = `BIN_BUDGET/4/32 = 21875` vs 32768 slots (srcConfig.js:861, 875-881);
retention `heldAge = maxAge·(1−crowdT)²` floored 8 frames (srcProbes.js:789-806).

---

## E. BOOT SEQUENCE (what runs before first light)

`#readyToRebuild` asset gate (GISystem.js:4059-4148; KTX2 tail "legitimately 2+
min" on Bistro :4113) → ONE sync `#rebuild` tick (:10227-11115): `#collectMeshes`
+ per-material `giMonitorNode`/`customProgramCacheKey`/`needsUpdate` (:14607-
14633) + roughness readbacks → lattice/probe/AABB fits → `#buildOccupancyField`
(:15143-15478): `serializeMeshForBake` per geometry, `buildStaticSceneBvhWords`
(SAH MeshBVH over the world soup + BVH8 repack), `createOccupancyField` (bits +
atomicBits + scratch + ~20 compute nodes), `setGeometry` (per-tri extents +
pair list), slot albedo atlas (canvas), dynamic set → `createSrcVolume`,
entries, light tree → `#buildScreenResolve` + `createSrcProbeSystem` (whole
TSL graph; bin payload) → `#syncBvhScene` (≤128 `MeshBVH` builds) + reflection
capture → `#compileWave` (:4242-4890): prewarm occupancy + SRC, `compileAsync`
per material variant (180-250 kB each), `Promise.all`, prewarm queue, await
`giPendingComputePipelines`, `#warmOverridePass` → first lit tick gated on
the whole occupancy chain running unskipped (:3660-3730). 84 `.compute(` sites
(occupancyField 17, giScreen 18, srcRays 10, srcProbes 8 …), per-cascade ×4,
per-level ×4. Baked scene constants: occupancy 29 sites (:963-976, 1192-1210),
srcProbes 21 (:1444, 1481-1492), every `.compute(N)`.

---

## F. STAGE 0.2 EXECUTION SPEC (written 08-26 evening from the sites above)

**Mechanism.** Every `instancedArray(new TypedArray(N))` is a
`StorageInstancedBufferAttribute` whose `.array` is copied into the GPU buffer
the FIRST time the attribute is bound (`WebGPUAttributeUtils.createAttribute`,
`mappedAtCreation`). After that the JS array is dead weight unless the code
writes it CPU-side again (`addUpdateRange` + `needsUpdate`). So:

1. **`detachCpuMirror(renderer, attr)` helper** (new, `releaseCompute.js`):
   if `renderer.backend.get(attr)?.buffer` exists (uploaded) → `attr.array =
   new attr.array.constructor(0)`; return true. Else return false (caller
   retries next tick). Never call it on an attribute that is written CPU-side
   later. Record `attr.__giBytes = byteLength` BEFORE detaching so size checks
   keep working.
2. **Detach set — GPU-only after build** (occupancyField.js:613-670): `bits`,
   `atomicBits`, `staticBits`, `attrScratch`, `surfScratch`, `surfAlloc`;
   srcDeposit.js:544-546 `scratch`, `payload`, `stats`; srcProbes.js:472-588
   probe/hash/freeStack stores; srcProbes.js:1304-1306 + srcRays.js:123,143
   per-pixel buffers; srcMerge.js:267-268 corners; the tile atlas is a
   texture (no mirror). Poll a `pendingDetach` list in `GISystem#tick` after
   `_fieldReadyOnce` / after the first unskipped SRC frame.
   **KEEP mirrors** (CPU-written incrementally): `vertexBuffer`, `indexBuffer`,
   `pairWork` (:4859-4894 `addUpdateRange`), `slotDynamic`, `slotMatrices`,
   `localToWorld` (:4752), light-tree/emitter uniform arrays.
3. **Size reads that touch `.array.byteLength` must switch to `__giBytes`:**
   occupancyField.js:5246 (`readbackBits` cap), GISystem.js:15367-15385 (the
   ladder, 3 sites). `readbackBits` uses `getArrayBufferAsync` (fresh buffer)
   — unaffected otherwise.
4. **Static-BVH staging** (dynamicObjects.js `queueRegionUpload` :1871-1880):
   keep `staging` + `copy` on the block; in `confirmDispatch` (:2205-2215)
   when `p.block.uploaded` flips true → `releaseComputeNodes(renderer,[copy])`
   and drop the `staging` reference (needs `renderer` — pass it from the
   caller that already has it, or stash it on the set at creation).
5. **Build-only scratch** (`surfScratch`, `attrScratch`): after the fit ran
   unskipped (the occupancy chain's `confirmDispatch` equivalent), detach
   (step 2 covers it) — freeing the GPU side too requires the scratch to be
   rebuilt per refit; defer GPU release to the ladder-allocate-once unit.
6. **Sweeps at the three swap sites**: `#syncScreenResolveSize` (GISystem.js
   ~:7859), `#rebuildSrcProbesForPools` (pool grow), the geometry-revision
   chain re-mint — each must `collectStateComputeNodes(oldGen)` +
   `releaseComputeNodes(renderer, …)` exactly as `#dispose` does at :12713.
   Implement `occupancyField.dispose()` (:5486) to release its own nodes and
   null its closures.
7. **Allocate once**: compute `bitsBytes(dynWords, staticBvhWords, uv)` from
   the region arithmetic BEFORE `makeField`; walk the ladder on the NUMBER
   (GISystem.js:15361-15390) and call `makeField` exactly once.
8. **`voxelizeOnce.js:358-361` copies**: keep only for non-Float32 /
   interleaved attributes; otherwise reference three's arrays.

**Gate:** Bistro settled heap < 2 GB and flat over 10 min orbit
(`profile.frameStats.jsHeapMB`); `profile.textures` orphans < 50 MB; battery
green; `probe:gi-heap-retainer` POKE=quality shows no per-rebuild climb.

---

## G. STAGE 0.5 EXECUTION SPEC — bvhHitShade diet (analysis 08-27 00:30)

`createGiBvhHitShade` (`giScreen.js:831-1170`) carries TWO JS loops that unroll
x4 each, every iteration inlining a BVH descent + PCSS: `emitterDirectAt`
(`giLight.js:1269`, `for … of params.emitterSlots.entries()`, MAX_EMITTERS = 4,
inlines `emitterSlotShadow` :1337-1560 -> `recordShadowTrace` GISystem :5200-5335)
and `analyticDirectAt` (`giLight.js:1564`, `for … of lightSlots`, MAX_GI_LIGHTS = 4,
inlines `lightShadowFn` giScreen :1076-1105 -> staticOcclude + dynOcclude);
plus `sampleReflectionProbes` x8 (`reflectionProbes.js:133`) when probes exist.
= 12 shadow-ray call sites where 3 would do. Share estimate of 182 kB: emitter
loop 65-70, light loop 30-40, probes 20-25, shared fn bodies 35, rest 10.
Dump: `DUMP_ALL=<dir> npm run probe:gi-boot` then
`REPS=3 node scripts/run-wgsl-compile-probe.mjs <dir>/k*.wgsl`.

**D1** roll the emitter loop (`giLight.js:1269`) into `Loop({start:int(0),
end:int(4)})` with a select-built virtual slot — copy `createGiEmitterShadowPass`
(`giScreen.js:2066-2082`: slotKeys intersection, `shadowVars[k].assign(select(...))`).
Expect -50 kB / -120 ifs. Gates: test:gi-emitter-tsl, test:gi-hit-shade.
**D2** roll the light loop (`giLight.js:1564`) — precedent `srcShade.js:600-640`
(measured: ~1.2 s compile per inlined descent). Expect -25 kB / -80 ifs.
Gates: test:gi-lighttree-nee, probe:gi-reflect-black.
**D3** uniformize the baked numbers: `normalOffset` (giScreen :914/:933/:1085),
`emitterCutoff x traceCutoffScale` + `maxTraceDistance` (:1014-1023),
`uint(baseWord + STATIC_MASK_WORD_BASE)` (dynamicObjects.js:1918/:1937 — moves
with grid resolution = cross-scene cache miss).
**D4** defer: the kernel is already out of the prewarm (GISystem :4246-4253) but
sits in `state.queue` (:7152) so it compiles on frame 1; skip its dispatch until
the mask pass reports a non-zero mirror-pixel count (the emitter chain's shape at
:4231). Not created below `high` (`#bvhReflectionsEnabled` :7549-7580).
Target: 182 -> ~75 kB, 331 -> ~120 ifs, 12 -> 3 descent sites. Only
`probe:wgsl-compile` RATIOS count (the same kernel measured 47-238 s across runs).

---

## H. STAGE 0.4 EXECUTION SPEC — mobile/Safari safety (written 08-27 01:10)

1. **IBL blackout only after the transport is proven alive.** `GISystem.js`
   ~:2013 `const giLive = … && this._fieldReadyOnce === true` → add
   `&& this._transportAlive === true`. Set `_transportAlive` from the EXISTING
   post-wave readback at ~:4637 (`src.readStats(renderer)`, srcSystem.js:1970 —
   counters for rays/deposits) or srcTiles `readStats` (:629, `lit` texels):
   alive = rays > 0 && (deposits > 0 || tiles.lit > 0). Reset on every rebuild.
   If not alive 10 s after the wave → `console.error("[gi] transport never
   produced light — IBL left on; GI is effectively off on this device")` and
   publish `profile.frameStats.giTransport = "dead"`. This alone turns
   "everything disappears" into "no GI" on any failing device.
2. **`device.lost` → drop a tier, never rebuild the same size.** Engine.js:593
   emits `renderer-rebuilt` → GISystem:1188 `requestRebuild`. Count losses per
   session; on a loss while GI was built, set `globalThis.__giDeviceTier` to
   the next lower tier than the RESOLVED one (giConfig `giDeviceTierCeiling`
   reads it), log `[gi] device lost with GI at <tier> — rebuilding at <tier-1>`;
   at `low` already → do not rebuild GI (leave IBL) and console.error.
3. **Tier byte budget before allocation.** Interim budgets for the CURRENT
   architecture (GI2 replaces them): low 192 MB, medium 384, high 768, ultra
   1536 (GPU bytes of bits + SRC store + screen targets). Compute with 0.2's
   `bitsBytesFor` + the srcDeposit size arithmetic (:520-543) + target sizes
   BEFORE `makeField`/`createSrcBinStore`; if over → walk the SAME ladder the
   device-limit code walks (drop UV region → static BVH → exact tris → dyn
   pool → halve BIN_BUDGET → halve resolve) until it fits, logging each rung.
   The prefs hint (GISystem ~:11751 "re-seats a scene at its previously
   measured demand") is clamped by the same budget. srcDeposit's `throw` at
   :530 becomes unreachable (the budget ran first) but stays as the assert.
4. **Envelope census = uniform buffers + storage textures too.**
   `#auditPortableBindings` (:3854) counts only `var<storage`; add
   `var<uniform` (baseline 12) and `texture_storage_` (baseline 4). Compare
   against BOTH the baseline (warn) and `device.limits` (error + name the
   kernel + mark `_transportAlive=false` candidates). Keep it logging-only on
   desktop; the IBL gate (1) is what protects the image.
5. **`unrestricted_pointer_parameters`.** At GI init:
   `navigator.gpu?.wgslLanguageFeatures?.has("unrestricted_pointer_parameters")`;
   if false → console.error naming the six raw-WGSL kernels (dynamicObjects.js
   `ptr<storage…>` params ×4, bvhScene.js:215, and any left in bvh/) and
   force `dynamicObjects` + the static BVH8 OFF for the session (they would
   fail to compile and dead-end the chain). Verify by grepping `ptr<storage`
   across src/modules/gi after 0.1.
6. **`probe:gi-portable` under WebKit** is Stage 4.2; for now add the uniform
   + storage-texture census to its report (scripts/run-gi-portable-envelope.mjs).

Gate: `npm run probe:gi-portable` portable arm → 0 kernels over any counted
limit; a forced `__giDeviceTier="low"` boot on Bistro must either fit the
192 MB budget via the ladder or refuse GI with IBL intact (never a black
scene); `test:gi-occupancy`, `smoke:gi-gpu` green.

---

## I. STAGE 0.2b EXECUTION SPEC — WHAT SURVIVES A REBUILD (measured 08-27 03:12-03:33)

### I.0 The measurement

`scripts/run-gi-heap-retainer.mjs`, unmodified in the repo, run from a
scratchpad copy that adds four columns the shipped probe lacks: GPU **texture**
bytes (estimated from the descriptor), live buffer/texture buckets keyed by
`label|size` so a survivor can be NAMED, every map-like cache on
`renderer._nodes` / `_pipelines` / `_bindings` / `_attributes` / `backend`, and
`renderer.info.memory`. Bistro, `POKE=quality` (ultra↔high), `REBUILDS=3`,
gi19-stage0 @222e9e8, worktree server on 5202.

| census | JS heap | Δ | gpuBuf live | gpuBuf MB | Δ | gpuTex live | gpuTex MB | `info.memoryMap` | Δ | nbCache | pipes | progV/F/C |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline  | 3900 |       | 10758 | 3236 |       | 435 | 1212 | 11428 |      | 60 | 209 | 61/73/114 |
| rebuild-1 | 5373 | +1473 | 11488 | 4619 | +1382 | 431 | 1169 | 12161 | +733 | 69 | 221 | 64/76/114 |
| rebuild-2 | 7231 | +1858 | 12251 | 6473 | +1854 | 433 | 1251 | 12951 | +790 | 52 | 235 | 76/88/115 |
| rebuild-3 | 9129 | +1899 | 13178 | 8325 | +1852 | 437 | 1305 | 13885 | +934 | 42 | 237 | 76/88/118 |

**Per-rebuild JS heap +1878 MB. Per-rebuild GPU storage-buffer bytes +1853 MB.
They are the same number.** Textures move +68 MB/rebuild — 3.6 % — and every
JS-side cache the 08-17 work was built around is flat or shrinking. The
`idle-30s` row read all zeros because at 9.1 GB the page died, which is itself
the receipt that this is still the session-killer the probe's header describes.

**The one line that names it: in the live-bucket table every storage buffer
reads `gone 0`.**

    1620.9 MB  live 4 (made 4 gone 0)  |405232884      <- one per build (the largest single GI buffer)
     975.7 MB  live 2 (made 2 gone 0)  |487874560
     932.3 MB  live 3 (made 3 gone 0)  |310771200
     921.7 MB  live 2 (made 2 gone 0)  |460873728
     827.5 MB  live 5 (made 5 gone 0)  |165492344
     435.3 MB  live 7 (made 7 gone 0)  |62186720
     432.5 MB  live 5 (made 5 gone 0)  |86507520       <- `surfScratch`: 86.5 MB is §B's own figure, exactly
     360.1 MB  live 3 (made 3 gone 0)  |120045732      <- exact-triangle pool (9 words/tri)
       8.4 MB  live 2 (made 6 gone 4)  |4197324        <- three's own readback staging

The ONLY buckets with a non-zero `gone` are the readback buffers three destroys
itself. In three GI rebuilds on Bistro, GI destroyed exactly **zero** storage
buffers.

⚠ Measurement caveat: another session was editing GI sources during the run and
vite pushed a page reload at 03:18:56 and 03:33:39. The three rebuild rows are
monotone and internally consistent (a reload resets every counter to 0, which is
exactly what the discarded `idle-30s` row shows), so the reloads landed outside
them. Two repeat runs (03:34, 03:41) were destroyed by the same storm and by a
working tree mid-edit: both reached `bistro open, gi built: false` — **no
`[gi] built` at all within 300 s** — so GI was not building in that tree at
03:42-03:48. Schedule this probe against a quiet tree, and treat
`gi built: false` as "discard the run", never as a datum.

### I.1 Ranked retention paths

**#1 — GI never destroys a storage buffer, and `renderer.info.memoryMap` pins
every one it ever made. ≈1,853 MB per rebuild — 99 % of the GPU half, and the
JS heap tracks it 1:1.**

Three receipts, all in three's own source:

* `Bindings._destroyBindings` (`renderers/common/Bindings.js:248-289`) destroys
  UNIFORM buffers and samplers. There is **no `isStorageBuffer` branch.** So
  `releaseComputeNodes` — this module's entire eviction story since 08-17 —
  provably cannot free a storage buffer. It frees the bind group and the
  pipeline, which are bytes of nothing next to the buffer they bound.
* The only path to `GPUBuffer.destroy()` for a storage attribute is
  `renderer._attributes.delete(attr)` → `Attributes.delete`
  (`renderers/common/Attributes.js:46-56`) → `backend.destroyAttribute` →
  `WebGPUAttributeUtils.destroyAttribute` (`:361-370`, `data.buffer.destroy()`).
  `grep -rn "_attributes" src/modules/gi` returns **0 hits**.
* `Info.memoryMap` (`renderers/common/Info.js:145`) is a plain **`Map`**, and
  `_createAttribute` (`:264-273`) `set`s every storage attribute into it at
  first bind (`Bindings._createBindings:215-219` → `Attributes.update` →
  `info.createStorageAttribute`). Its only `delete` is `info.destroyAttribute`
  (`:324`), reached only from the call above. So the ATTRIBUTE is strongly
  reachable from the renderer forever; the backend's `WeakMap` entry keyed by
  that attribute therefore never dies either, and the GPU buffer is not even
  GC-reclaimable.

Receipt in the table: `info.memoryMap` grows **+733 / +790 / +934** entries per
rebuild against live GPU buffers **+730 / +763 / +927**. Same number, both
monotone, neither ever shrinks.

**#2 — `detachCpuMirror` frees nothing while the generation is live: the bind
group captured the ORIGINAL array. ≈700-760 MB per generation.**

`NodeStorageBuffer`'s constructor
(`renderers/common/nodes/NodeStorageBuffer.js:23`) calls
`super('StorageBuffer_' + id, nodeUniform.value)` → `StorageBuffer`
(`StorageBuffer.js:17-27`) calls `super(name, attribute.array)` and keeps
`this._attribute = attribute` → `Buffer` (`Buffer.js:44`) stores
`this._buffer = buffer`. `NodeStorageBuffer` overrides the `buffer` and
`attribute` GETTERS, so releaseCompute.js's safety argument is right that
nothing ever READS `_buffer` — but the field still holds a strong reference to
the full typed array, and it was captured at first bind, which is strictly
before `#drainCpuMirrors` can run. `attr.array = new ctor(0)` therefore frees
nothing until `_destroyBindings` drops that BindGroup — i.e. until the dispose
that would have dropped it anyway. `[gi] detached 25 CPU mirrors (709.4 MB)` is
a bookkeeping line about the LIVE generation, not a free — it buys nothing back
until that generation dies, which is the moment the array became collectable
anyway. Nulling `_buffer` (and `_attribute`) at detach time is what makes 0.2's
detach actually pay while a build is running.

**#2b — ▶ OPEN, ~740 MB/rebuild unaccounted. Do NOT close 0.2b without it.**
The arithmetic: a generation is 1,853 MB, of which 709-759 MB are detached (a
0-length `attr.array`, so `info.memoryMap`'s strong reference to the attribute
retains nothing) — predicted JS retention ≈1,100 MB/rebuild against a MEASURED
1,878. The ~740 MB gap is not the GPU side (separately accounted) and not the
caches (§I.2). Candidates in order: build-time CPU transients that never become
a GPU buffer and may be closure-pinned — `buildStaticSceneBvhWords`
(`dynamicObjects.js:544`; 188 MB of words on Bistro, and built a SECOND time at
`GISystem.js:14778` when the budget ladder drops UV), `voxelizeOnce.js:358-361`'s
attribute copies / `serializeMeshForBake`, the occupancy build's pair and
scratch arrays, and `items` in `#syncBvhScene`. **Measure before fixing:** patch
`Uint32Array`/`Float32Array` in the page to record a `new Error().stack` plus a
`WeakRef` for every allocation ≥ 2 MB, then after three `gc()`s report live
bytes grouped by allocation site. That names the closure; reading code will not.

**#3 — 30 of ~55 `instancedArray` sites have no `cpuMirrors` entry at all.**
`occupancyField.js:4938` publishes 6 of its 13 sites
(`[bits, atomicBits, staticBits, attrScratch, surfScratch, surfAlloc]`);
`srcSystem.js:1271`'s getter aggregates 19 more. Everything else —
`bvh/bvhScene.js` (5), `giScreen.js` (5), `srcTiles.js` (3),
`dynamicObjects.js` (3 staging), `srcSeed.js`, `srcScreenGather.js`, and
occupancyField's geometry/slot buffers — keeps a full JS twin for the process's
life, retained by #1. Fixing #2 without extending this list leaves that half in
place.

**#4 — one 4096² `ShadowDepthTexture` per rebuild, +67 MB.** Bucket:
`ShadowDepthTexture|4096x4096x1|depth24plus` made 3 → 6 across three rebuilds,
`gone 0`, while `ShadowMap|4096x4096x1|rgba8unorm` stayed at 1 — the depth
attachment alone. `ShadowNode.setupRenderTarget`
(`nodes/lighting/ShadowNode.js:395-404`) mints a fresh `DepthTexture` every time
the node is set up, and a GI rebuild forces exactly that by handing lights back
and forth (`#releaseLightShadowNode` / `#acquireLightShadowNode`). Accounts for
the whole +68 MB/rebuild texture column.

### I.2 Refuted here, with receipts

* **Not the textures / render targets.** gpuTex live 435 → 437 across three
  rebuilds. `giBvhAtlasBlit` reads `made 3 gone 2`, so `StorageTexture.dispose()`
  DOES reach `backend.destroyTexture` and `#retireTargets` does fire.
  `profile.textures.notReferencedByOpenScene` went 118.1 MB → 43.6 MB DURING the
  run. §B's "127 orphans / 446 MB" is a standing-state figure, not a per-rebuild
  one — it is not what is climbing.
* **Not the material node graphs.** `nodeBuilderCache` 60 → 69 → 52 → 42:
  `purgeNodeBuilderCache` works. `programs.vertex/fragment` 61/73 → 76/88 over
  three rebuilds — three releases them itself on recompile
  (`Pipelines.getForRender:166-172` decrements `usedTimes`, `:190/:204` release
  at zero). `_pipelines.caches` 209 → 237. All three together are far under 1 %
  of the climb. **The 08-17 diagnosis ("the bulk is 116 materials' node graphs")
  no longer holds after 0.2 — the bulk is buffers.**
* **Not a `collectStateComputeNodes` gap.** `[gi] dispose: released 83/83
  compute nodes` on every single rebuild, and the pipeline cache is flat. The
  walk's depth-4 limit is real (a `{compute}` wrapper reached through
  `state.screen.<x>.passes[i]` sits at depth 5) but it is not what costs memory:
  a compute NODE is nothing; its BUFFER is everything.
* **Not `callHashCache` / `groupsData`.** Three's `ChainMap` is all `WeakMap`s
  (`ChainMap.js:21`), so `NodeManager.dispose()` not clearing them is harmless.

### I.3 The fix — exact anchors

1. **`releaseCompute.js` — new `releaseStorageAttributes(renderer, attrs)`.**

   ```js
   export function releaseStorageAttributes(renderer, attrs) {
     const attributes = renderer?._attributes;
     const backend = renderer?.backend;
     if (!attributes || !attrs) return 0;
     let n = 0;
     for (const attr of attrs) {
       if (!attr) continue;
       try {
         // `has` BEFORE `delete`, and on BOTH maps. DataMap.get CREATES an
         // entry, so a seeded-but-empty record makes Attributes.delete return
         // truthy and walk into `data.buffer.destroy()` on undefined.
         if (attributes.has?.(attr) !== true || backend?.has?.(attr) !== true) {
           renderer.info?.memoryMap?.delete(attr); // never bound: only the Map entry exists
           continue;
         }
         attributes.delete(attr); // -> destroyAttribute -> GPUBuffer.destroy + info.destroyAttribute
         n++;
       } catch { /* a three rename must degrade to "leaks as before" */ }
     }
     return n;
   }
   ```

2. **`releaseCompute.js` — `releaseComputeNodes` (`:51`) HARVESTS the attributes
   before it evicts, and nulls #2's capture.** This is the only enumeration that
   cannot go stale, because it reads what the kernels actually bound rather than
   a hand-written list:

   ```js
   const st = nodeCache?.has?.(node) ? nodeCache.get(node).nodeBuilderState : null;
   for (const group of st?.bindings ?? [])
     for (const b of group.bindings ?? []) {
       if (b.isStorageBuffer && b.attribute) attrs.add(b.attribute);
       b._buffer = null;   // #2, one line: nothing reads it back on a NodeStorageBuffer
     }
   ```

   ⚠ NEVER `nodes.getForCompute(node)` here — it REBUILDS the state it cannot
   find, which is the state we are discarding (this file's own banner prices
   that at a 16-27 s recompile). Return the set to the caller; the delete must
   be TTL-deferred (4).

3. **`GISystem.js #dispose()` (`:11634`) and `#sweepOrphanedComputes` (`:10906`)
   retire the harvested set.** The sweep already computes the exact set
   difference that makes this safe: an attribute bound by a node that SURVIVED
   the swap must never be destroyed, so harvest from the orphans only and
   subtract the survivors' attributes.

4. **TTL, never on the spot.** `#retireTargets` (`:8288`) /
   `#drainRetiredTargets` (`:8292`) already price this exact hazard for textures
   — "Destroyed texture used in a submit" — and a storage buffer is identical: a
   material's bind group re-points while the following frame is being encoded.
   Add `_retiredAttributes` beside `_retiredTargets` (`:1200`), same
   `RETIRED_TARGET_FRAMES` (`:105`), drained at the same site (`:2058`).

5. **Owners outside `state` publish `ownedAttributes`** — a SUPERSET of
   `cpuMirrors`, because at teardown the CPU-written buffers die too:
   * `occupancyField.js` — beside `cpuMirrors` (`:4938`), list all 13
     `instancedArray` sites, and call `releaseStorageAttributes` from
     `dispose()` (`:5085`, which today releases nodes only).
   * `srcSystem.js dispose()` (`:2055`) — releases NOTHING today, not even
     compute nodes; it survives only because `state.screen.srcProbes.passes` is
     a flat array at exactly depth 4. Add
     `releaseComputeNodes(renderer, system.passes)` +
     `releaseStorageAttributes(renderer, ownedAttributes)`, stashing the
     renderer at create time the way `occupancyField.setRenderer` does.
   * `dynamicObjects.js confirmDispatch` (`:2227`) — `p.staging = null`
     (`:2247`) drops the JS reference and leaves the GPU buffer; the static
     BVH's one-shot staging alone is 125-160 MB on Bistro (this file's own
     `:1427`). Push `p.staging.value` onto the same TTL retire list beside
     `staleUploads` (`:2232`).
   * `bvh/bvhScene.js dispose()` — 5 `instancedArray` sites, same treatment.

6. **Publish the receipt so it cannot regress silently.**
   `profile.frameStats.giStorageAttributes = renderer.info.memory.storageAttributes`
   and `giStorageAttributesMB = renderer.info.memory.storageAttributesSize / 1e6`
   — counters three already maintains, and exactly the quantity that must be
   FLAT across rebuilds. Log them on the `[gi] dispose:` line.

7. **Secondary (#4).** Dispose the shadow render target the previous ShadowNode
   setup minted when GI takes a light (`#acquireLightShadowNode`) or hands it
   back (`#releaseLightShadowNode`, `:11559`). Measure which side allocates
   with the bucket table first — `ShadowDepthTexture|4096x4096x1|depth24plus`
   must stay at its boot count.

### I.4 Gate

* `probe:gi-heap-retainer` `POKE=quality REBUILDS=3` on Bistro: JS heap flat
  across the three rebuild rows within **±150 MB**, and `bufferLiveMB` flat
  within **±150 MB** (today: +1878 / +1853 per rebuild).
* `renderer.info.memory.storageAttributes` returns to within ±20 of its
  post-first-build value after each rebuild; `info.memoryMap` grows by **< 50**
  entries per rebuild (today +733 / +790 / +934).
* `profile.textures.notReferencedByOpenScene.mb` **< 50 MB**.
* `test:gi-compute-release` extended: `releaseStorageAttributes` (a) no-ops on
  an attribute the backend never bound and still drops its `info.memoryMap`
  entry, (b) calls `attributes.delete` exactly once per attribute, (c) never
  touches an attribute a surviving node still binds, (d) `releaseComputeNodes`
  never calls `getForCompute`.
* Battery: `smoke:gi-gpu`, `test:gi-occupancy`, `test:gi-src-deposit`,
  `test:gi-src-gather` green, and **no "Destroyed buffer used in a submit"** in
  the console across 3 rebuilds + a viewport resize + an SRC pool grow (the
  three swap sites 0.2 already enumerated).

---

## J. STAGE 1 EXECUTION SPEC — MATERIALS OUT OF THE WAVE (analysis 08-27, HEAD 0868955)

For `GI_SCALE_PLAN.md` §4.5 / Stage 1.1-1.2. Read J.0 before believing §2.1's
sizes: **the plan's line numbers and its 180-250 kB are both stale.**
`#markObservedMaterial` is `GISystem.js:13960` (plan says `:14607`);
`giCompileVariantKey` is `:440` (plan says `:465`); 180-250 kB is the
**pre-roll** figure recorded at `giFn.js:12-13`, superseded by `sharedFn`.

### J.0 What GI injects into a material TODAY (deferred path, bucket 3, ao+reflections on)

GI is not a material property — it is a light. `registerGILight`
(`giLight.js:2646-2650`) does `renderer.library.addLight(GICascadeLightNode,
GICascadeLight)`, so `GICascadeLightNode.setup` (`:1858`) runs inside **every
lit material's** `lightsNode` and contributes exactly two things:
`context.irradiance.addAssign` (`:2070`) and `context.radiance.addAssign`
(`:2645`). Terms, in emission order:

| # | term | anchor `giLight.js` | binds | tex samples/px | text scale |
|---|---|---|---|---|---|
| 1 | face-forward N, samplePoint | :1883-1886 | `normalOffset` | 0 | ~8 stmts |
| 2 | `giUV` = resolve VP × P | :1904-1917 | mat4 `_giResolveVPU` (`GISystem.js:6937`) | 0 | ~12 |
| 3 | bilateral(irradiance), 4 taps | :1929-2046 | `giIrradianceNode`, `giPositionNode`, `giScreenTexel`, `giNestedView` | **8** | ~40 |
| 4 | probe nested fallback | :2051-2059 → `reflectionProbes.js:107-190` | 8 slots × 2 vec4 + atlas | **16** | ~120 |
| 5 | bilateral(emitter shadow) | :2082-2091 | `giEmitterShadowNode`, `giEmitterShadowTexel` | **8** | ~40 |
| 6 | 4 emitter slot geometries | :2093-2108 | 4 × 11 uniforms | 0 | ~20 |
| 7 | glossy cascade read | :2172-2175 | `giRadianceNode` | 1 | ~2 |
| 8 | probes (directional) | :2213-2216 | same bundle, 2nd expansion | **16** | ~120 |
| 9 | exact prefilter, 2 hex rings | :2262-2317 | `bvhReflectColorTexture`, `bvhReflectTexture` | **14** | ~70 |
| 10 | exact blend | :2318-2331 | — | 1 | ~10 |
| 11 | ~~mirror trace + per-hit shading~~ | :2333-2531 | **COMPILED OUT** — `mirrorSampleFn=null` (`GISystem.js:9912`) | 0 | 0 |
| 12 | emitter specular glow | :2534-2578 | slots + `boxGlowMiss`/`shapeGlowMiss` (rolled) | 0 | ~75 + 2 fn |
| 13 | roughness collapse | :2581-2590 | `intensityUniform` | 0 | ~6 |
| 14 | sky/env miss | :2599-2626 | `giEnvMiss.node/intensity/rotY` | 1 | ~24 |

≈ **65 texture fetches per reflective pixel**, ~550 emitted statements. At
50-70 B/stmt that is **~30-45 kB estimated**, not 200 — *estimate only, the
gate is a dump (J.5)*. **Not present on the shipping path**: `emitterDirectAt`
(`:1266`, the 65-70 kB share in §G) — only the non-deferred arm calls it
(`:2113`); emitter DIRECT diffuse + shadows are already in the irradiance
texture (`:2083`). The two `sampleReflectionProbes` expansions (32 fetches) and
the 12-tap prefilter are the real text, not the emitter loop.

### J.1 The variant key

* Pipeline key = `RenderObject.getMaterialCacheKey()` (`RenderObject.js:730+`):
  `customProgramCacheKey()` + a walk of **every own material property** —
  numbers reduced to on/off (except `side`), textures contributing `mapping` +
  sampler data. So two same-shading Bistro materials still differ by which maps
  are non-null and by **sampler settings**. That is the base variant count.
* `NodeMaterial.customProgramCacheKey` (`NodeMaterial.js:426-438`) hashes every
  own `*Node` child's `getCacheKey()`. `giMonitorNode` ends in `Node` → **it is
  in the key**; the ONE shared `float(0)` (`GISystem.js:13973-13975`) is what
  keeps it from minting a unique key per material.
* GI then multiplies the count by up to **4**: `:13984-13985` appends
  `"|gi" + giRoughnessBucketOf(material)`. On an import `material.roughnessMap`
  ⇒ bucket 3 unconditionally (`giLight.js:143`), i.e. ~all of Bistro lands in
  the heaviest arm (`canMirror` true) — the R4 floor demotion is OPT-IN and
  REFUTED (`giLight.js:100-111`).
* `giCompileVariantKey` (`:440-449`) = `material.uuid|attrs|skin|morph`. It is
  **only the warm-list dedupe** at `:4364` — 112 uuids ⇒ the log's
  `[gi] compile wave: N unique material variants` (`:4370-4373`) and the plan's
  "~100+ variants". It is NOT the pipeline count. The honest count is
  `probe:gi-boot`'s `N render pipelines over M distinct fragment shaders`
  (`run-gi-boot-probe.mjs:727`).
* Why `matchStockPbr`'s 26→3 does not hold here: it lives in
  `src/engine/tslGraph.js:590` and is applied only from
  `materialAsset.js:556/615` — i.e. to `.mat` **assets** (the GAME/Sponza 32/46,
  `GI_SRC_REBUILD_PLAN.md:6386`). Bistro's materials come from glTF import and
  never pass through it; they have no custom node slots to merge in the first
  place, so their spread is maps+samplers+`side` × GI bucket.

### J.2 `giMonitorNode` — mechanism and the exact replacement

* `NodeMaterialObserver.containsNode` (`NodeMaterialObserver.js:268-284`) scans
  **every enumerable own material property** for `.isNode` → `hasNode = true`
  (`:112`). `needsRefresh` returns true immediately on `hasNode` (`:719-720`),
  so `Renderer._renderObjectDirect` (`Renderer.js:3708-3718`) runs
  `updateBefore` + `geometries/nodes/bindings.updateForRender` for **every
  object every frame** = the 237 µs/draw at 453 draws (`GI_SCALE_PLAN.md:48`).
* **Why it is load-bearing.** `UniformNode.groupNode` defaults to `objectGroup`
  (`UniformNode.js:55`), and non-shared groups are **cloned per render object**
  (`NodeBuilderState.js:133-150`). A per-object clone only re-uploads inside
  that `needsRefresh` branch, so without the marker GI's uniforms freeze at
  compile-time values — the moved lamp. The repo already states the same law at
  `GISystem.js:6558-6559` ("the default object group's buffer does not
  re-upload on a quiet scene"). Three's own lights avoid it:
  `AnalyticLightNode.js:54` is `uniform(this.color).setGroup(renderGroup)`.
* **The replacement is a group move, not a marker swap.** With `hasNode` false
  the observer still returns true **once per render per material**
  (`NodeMaterialObserver.js:724-730`, the `renderId` bump). A `renderGroup`
  uniform is shared (not cloned), and `NodeManager.updateGroup`
  (`NodeManager.js:114-142`) version-checks it, so one refresh per render is
  exactly enough to upload it once and skip the other 452 draws. A per-object
  clone would still be stale on 452 draws — **therefore the uniforms must move
  first and the marker be deleted second, in that order, in one commit.**
* Precedent already in-tree: `_giNestedViewU` at `GISystem.js:6945-6947`.

### J.3 The thin hook (Stage 1.1)

1. **STAYS**: the two reads and the BSDF weighting —
   `context.irradiance += giIrr.sample(giUV).rgb` and
   `context.radiance += giGlossy.sample(giUV).rgb`. Fresnel/roughness weighting
   is `PhysicalLightingModel`'s, already free.
2. **STAYS**: `giUV` (item 2). It is what makes nested/planar views correct
   (`giLight.js:1892-1903`); a screen-space constant reintroduces the ghost.
3. **MOVES** — bilateral ×2 (items 3+5, 16 fetches). The resolve owns the
   half-res gbuffer position already; do the position-validated upsample ONCE
   at resolve res and publish a full-res `irradiance`. Cost: one target. Saves
   15 of 16 fetches per lit pixel.
4. **MOVES** — both `sampleReflectionProbes` expansions (items 4+8, 32 fetches,
   ~240 stmts). Largest single text term. The resolve and `bvhReflect` already
   hold the probe bundle; the nested-view fallback becomes a resolve output.
5. **MOVES, with a stated trade** — the 12-tap prefilter (item 9).
   `giLight.js:2237-2247` argues it must stay because roughness is per-pixel and
   the gbuffer mirror channel is ONE BIT. The counter is to widen that channel
   to a roughness byte; do not move it silently — this is the one item that
   changes an image, and `:2244` names the exact user report it fixed.
6. **MOVES** — emitter specular glow (item 12). Reads only slot uniforms +
   `reflected` + roughness, all reconstructible at resolve res. Precedent and
   buffer both exist (`emitterShadowPass` runs at `emitterShadowScale × shadow`).
   Trade: half-res glow silhouettes on ≤ 4 lamps.
7. **ALREADY DONE — do not redo**: emitter direct diffuse + shadows
   (`giLight.js:2083`), the mirror hit-shade block (`:2333-2531`, dead via
   `GISystem.js:9910-9914`), and the `sharedFn` roll (`giFn.js:36-56`).
8. **TARGET SHAPE**: 2 samples + `giEmitterGlow(slotUBO, R, roughness)` if 6 is
   deferred. Gate: **GI-on fragment WGSL ≤ GI-off + 8 kB**.

### J.4 Wiring the shared UBO (Stage 1.2) — exact anchors

`renderGroup` is already imported in `GISystem.js`. Add `.setGroup(renderGroup)`
at: `:6937` `_giResolveVPU`; `:5825`/`:11589` `_giLightShadowTexel`; `:6952`
`_giEmitterShadowTexel`; `:9765-9791` all 11 emitter-slot uniforms ×4; `:7873-7874`
probe `posFeather`/`halfActive` ×8; `:5963-5964` + `:6910-6911` `_giEnvMissIntensityU`
/`_giEnvMissRotU`; `:1136-1160` `makeLightSlots` (×4, unused on today's path —
do it so R11 stays true); `giLight.js:1825` `intensityUniform`. THEN delete
`GISystem.js:13973-13976` (marker + `needsUpdate`).

⚠ **Keep** `:13984-13985` (the roughness-bucket key) — it is unrelated to the
observer — but its guard is the marker: `:13961` early-returns on
`giMonitorNode?.isNode`. Replace it with an explicit sentinel
(`material.__giKeyPatched`) or `#collectMeshes` re-wraps `customProgramCacheKey`
on every scan (growing closure chain, drifting key).

Expect **3-4** GI UBOs, not 1: `NodeBuilder._getBindGroup` (`NodeBuilder.js:672-714`)
keys the shared group on the exact uniform-node-id SET, so each compiled bucket
gets its own — and the cache is per render context, so the nested planar pass
gets its own copy. Both correct; do not force dead reads to "fix" it.

### J.5 Measuring it (the instrument exists)

`probe:gi-boot` (`package.json:164`) with **`DUMP_RENDER=<dir>`**
(`run-gi-boot-probe.mjs:539-563`) writes one `.wgsl` per **distinct fragment
shader**, named `m00-<kB>kB-x<count>-<sig>.wgsl`, and prints
`N render pipelines over M distinct fragment shaders` (`:727`). It patches
`GPUDevice.prototype.createShaderModule` and deliberately prefers the FRAGMENT
module (`:136-140` — taking the vertex one "made every material look like a
2kB shader"). Run it GI-off vs GI-on, before and after. In-engine, only compute
is instrumented (`GISystem.js:504-511` `device.__giShaderSource`, kB retained,
text discarded); if a live number is wanted, three interns every distinct
fragment string at `Pipelines.js:200` — `renderer._pipelines.programs.fragment`
is `Map<wgsl, ProgrammableStage>`, and per object it is
`renderObject.getNodeBuilderState().fragmentShader` (`RenderObject.js:403`,
`NodeBuilderState.js:43`).

### J.6 Risks

* **R1 — boot order.** `#markObservedMaterial` sets `needsUpdate = true` on
  every material (`:13976`); deleting it removes one whole recompile of all 112.
  But the bucket key must be installed **before** first compile or same-bucket
  variants collide (`:13977-13983` names the mirror bug). Install it at the same
  `#collectMeshes` pass (`:13725`), sentinel-guarded (see J.4).
* **R2 — the MRT override.** `#warmOverridePass` (`:4157-4172`) awaits
  `override.scenePass.compileAsync` — the postprocess PassNode context, which
  re-warms every material in the MRT attachment set. It adds no variants but it
  **doubles the wave's exposure to any per-material size**, so measure J.5
  after the postprocess warm, not before (`:4903`, `:4911-4913`).
* **R3 — `hasNode` will NOT go false everywhere.** Uber/shader-graph materials
  carry `colorNode`/`normalNode`/`roughnessNode` of their own
  (`shadowMerge.js:704-708`), so they keep the per-object refresh regardless.
  The win is the stock-PBR import population; on those, `object.static`
  (`NodeMaterialObserver.js:732-736`) also becomes reachable for the first time.
  Skinned/morph keep refreshing via `hasAnimation` (`:719`) — correct.
* **R4 — the env black-out.** `scene.environmentNode = this._envIblBlack`
  (`GISystem.js:2157-2159`, gated on `_transportAlive`, `:2153-2156`) is a SCENE
  node — `containsNode` scans the MATERIAL (`:272`), so it is unaffected. But
  item 14 (`light.giEnvMiss.node`, `giLight.js:2618`) IS a per-material env
  texture. Moving it to `bvhReflect` (which already writes the −1 miss marker it
  keys on) is the clean Stage 1.1 move; **do not** replace it with anything that
  samples the environment unoccluded — that is the §12.64 leak.
* **R5 — the moved-lamp gate has no receipt.** `__noSharedGiMarker` has **zero**
  references outside its own definition, and the "95k-pixel" claim at
  `:13955-13958` appears in no script or test. The nearest real harness is
  `scripts/run-gi-move-cost.mjs` (no npm script; `node scripts/run-gi-move-cost.mjs`,
  pass = `:238` `old-side > shadow-centre + 15`) plus `test:gi-lighttree-mover`
  (`package.json:153`) which checks records, not pixels. **Stage 1.2 must add a
  pixel-level moved-lamp test before it removes the marker** — otherwise the one
  thing the marker protects is untested at the moment it is deleted.

### J.7 Gate

* `probe:gi-boot DUMP_RENDER=…` on Bistro: largest fragment shader **GI-on ≤
  GI-off + 8 kB**; `distinct fragment shaders` recorded before/after.
* `[gi] compile wave: materials …ms` (`GISystem.js:4911-4913`) **< 3000 ms**
  (today 27241; `BISTRO_PERF.md:747-749` shows 68866/77381 under contention).
* `profile.cpuFrame` renderEncode ÷ draws **≤ 40 µs** on Bistro (today 237).
* The new pixel-level moved-lamp test green with the marker deleted, and RED
  with the `.setGroup(renderGroup)` calls reverted — the group move must be
  provably load-bearing, not merely present.
* Battery: `smoke:gi-gpu`, `test:gi-lighttree-mover`, `run-gi-move-cost.mjs`.
