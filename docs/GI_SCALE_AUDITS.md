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
