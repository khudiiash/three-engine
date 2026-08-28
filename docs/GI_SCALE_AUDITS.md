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

---

## K. STAGE 2 DESIGN — THE WINDOW (written 08-27 by the architect; Stage 2.1 builds exactly this)

Everything here is a TIER CONSTANT (levels, 64³, brick 4³, pool sizes) so every
kernel's WGSL is scene-independent and cache-stable. Scene numbers live in
uniforms (origins, counts) or in buffer CONTENTS. No `__gi*` flags.

### K.1 Levels and addressing
- `L` levels of `N = 64` cells per axis; voxel size `v_l = v0 · 2^l`
  (desktop high 4 levels v0 0.25 m → 16/32/64/128 m windows; ultra 5 levels
  adds 256 m; phone/medium 3 levels v0 0.5 m → 32/64/128 m).
- World cell of point p at level l: `wc = floor(p / v_l)` (i32x3). Window
  origin per level `o_l` (i32x3, uniform), snapped to a BRICK (4-cell)
  boundary and recentred on the camera only when the camera leaves the
  central half of the window (hysteresis — no thrash on small moves).
- **Toroidal address** (no data ever moves): `idx = (wc.x & 63) | (wc.y & 63)
  << 6 | (wc.z & 63) << 12`. In-window test: `all(wc - o_l >= 0 && < 64)`.
  A brick's identity = its world brick coord `wb = wc >> 2`; the brick table
  stores `wb` so a slot holding a STALE brick (from before the scroll) is
  detected by `stored_wb != wb` and treated as EMPTY-DIRTY.

### K.2 Per-level storage (one storage buffer for the whole window, offsets are tier constants)
| region | per level | contents |
|---|---|---|
| `occ` | 64³ bits = 8192 u32 = 32 KB | occupancy bit, DDA fast path |
| `face` | 64³ bytes = 65536 u32 = 256 KB | bit0-5 = triangle crosses face +X −X +Y −Y +Z −Z; bit6 two-sided/foliage; bit7 = dynamic-layer mirror (see K.5) |
| `pal` | 64³ bytes = 256 KB | palette index (albedo+emissive class from `resolveMaterialSurface`; 255 = none) |
| `brickMask` | 16³ bits = 128 u32 | brick has ≥ 1 occupied voxel — the DDA's level-1 skip |
| `brickTab` | 16³ × 2 u32 = 32 KB | `wb` (packed i32x3, 10 bits each) + state (EMPTY / DIRTY / BUILT / cache slot id) |
| **total** | **~580 KB** | ×5 levels = 2.9 MB desktop, ×3 = 1.7 MB phone |
Face bits mip: NONE — each level voxelizes from triangles independently (as
Brixelizer/SmartGI), so a thin wall is 6-separating at every level by
construction. `occ` at level l+1 is NOT derived from level l.

### K.3 Voxelizer (the existing 13-axis SAT, re-scoped)
- Triangle source: ONE packed GPU soup built in a Web Worker from
  `serializeMeshForBake` output — fp32 world positions (36 B/tri) + 1 B palette
  index, plus a COARSE GRID (cell 4 m, `gridDim` uniform) of triangle-index
  ranges (counting sort in the worker). Bistro 3 M tris ≈ 120 MB (desktop
  only; phone tiers cap the soup at 1 M tris and fall back to per-mesh boxes
  above it — logged). Uploaded once per scene; per-cell upload is a Stage 4
  refinement if phones need it.
- Work unit = (brick, triangle) PAIR: a `binPairs` kernel walks the DIRTY
  bricks (from a GPU list, k bricks per frame, sorted frustum-first then by
  distance), gathers the grid cells overlapping each brick, AABB-rejects
  triangles, and appends surviving pairs to a bounded pair list (atomic
  counter; cap = tier constant, overflow = brick stays DIRTY for next frame).
  The `voxelize` kernel runs one thread per pair: SAT over the triangle's
  voxel span inside the brick, `atomicOr` occ bit, face bits from the
  triangle plane's sign against each face plane it crosses, palette via
  `atomicMax` (deterministic winner). Then `finishBricks` ORs `occ` into
  `brickMask`, marks BUILT, allocates a cache slot (K.6) if any voxel set.
- Budget is PAIRS per frame (fixed cost), not bricks: `PAIRS_PER_FRAME` by
  tier (phone 32k, desktop 256k). Coarse levels first at boot (L3 has 64×
  fewer bricks per metre — the whole window has occupancy within frames);
  L0 refines behind it. Receipt counters: bricks dirty/built/overflowed,
  pairs/frame, ms.

### K.4 Trace (`traceWindow(o, d, tMax) → {t, face, level, voxelIdx}`)
Two-level DDA per level: step BRICKS (16 per axis) on `brickMask` (a brick
with mask 0 is skipped in one step); inside an occupied brick, step voxels
on `occ`; on an occupied voxel test the ENTRY FACE bit — if set, hit; if clear, the
ray continues. **FACE-BIT RULE (corrected 08-27, commit ee6b4c0 — the
original "faces it crosses" wording was wrong and would let +X rays through
a wall ⊥X):** bit(±a) is set iff the surface inside the voxel is NOT parallel
to axis a (its normal has an `a` component, |n.a| > 1e-3); both bits of a
pair are set together. A wall ⊥X sets ±X only → blocks every X-stepping ray
and passes rays travelling along it; a floor ⊥Y stops vertical rays and does
not thicken horizontal ones. Receipt: 0/10 000 leaks through a 5 cm wall,
100 % leak in the control with the bits withheld. DDA: nested Amanatides–Woo on INTEGER cells (brick loop outside, ≤ 13-step
voxel loop inside, crossing times recomputed from the origin, exactly one
axis per step) — an ε-advance DDA that re-derives the cell from the position
leaked 2/10 000 near cell edges. Level hand-off: start at the finest level whose
window contains `o` (usually L0); when the ray exits that window, continue at
l+1 from the exit point (`t` carried). Measured: ~1 G rays/s (~1 ns/ray,
8.1 steps) on an RTX-class GPU at 400 k rays/dispatch; smaller dispatches
are launch-bound. Bias: ray origin pushed `0.5 · v_0` along
the geometric normal (screen-probe origins are ON surfaces). The dynamic
layer (K.5) is OR'd into both `occ` and the face test at L0/L1. No workgroup
memory, ONE storage buffer + uniforms = ≤ 3 bindings.

### K.5 Dynamic layer
Movers (the `dynamicObjects` adoption set) and skinned proxy boxes are
voxelized EVERY FRAME into a second `occ`+`face`+`pal` set for L0 and L1
only (2 × 544 KB), cleared per frame, from their own (small) triangle lists
via the same pair kernel with a separate budget (`DYN_PAIRS_PER_FRAME`). A
mover's brick in the static layer is NOT touched (its static bits stay; a
mover that stops is re-adopted as static by the existing quiet-frames rule,
which then marks its bricks DIRTY once).

### K.6 Radiance cache (the world's memory of light)
- Pool of brick slots, `CACHE_BRICKS` by tier (phone 8k, desktop 32k), each
  slot = 4³ voxels × 6 face directions × R11G11B10 = 64 × 24 B = 1536 B
  (phone 12 MB, desktop 48 MB). Allocated at `finishBricks`, freed when a
  brick is evicted by scroll (the slot id lives in `brickTab`).
- Written by (a) the screen-probe rays' hit shading (K.7) — every hit
  computes `L_out(face) = pal.albedo × (sun × DDAshadow + NEE(lightTree) +
  cached irradiance from the hit brick's own SH-of-neighbours) + pal.emissive`
  and EMA-writes it into the hit voxel's face slot; and (b) `injectLitFrame`:
  1/16 of screen pixels per frame write their final lit radiance into their
  voxel's face slot (exact shading for what is visible). Read by every ray
  hit as the radiance it returns (cheap path) — so bounce colour is available
  off-screen as soon as ANY ray has shaded that voxel, and multibounce comes
  free from the EMA.
- Relight queue: `RELIGHT_BRICKS_PER_FRAME` bricks (most recently hit, then
  nearest) re-shade all 64×6 faces per frame so a moved lamp updates the
  cache in bounded latency (Lumen's "fixed cost, variable latency").

### K.7 Kernel list (fixed; ~12 GI2 kernels + GTAO 3 + mirror tier)
`scroll` (per level, per brick) · `binPairs` · `voxelize` · `finishBricks` ·
`dynVoxelize` · `probePlace` (per 8×8 tile: pick the surface, jitter) ·
`probeTrace` (N rays/probe, HZB first segment → `traceWindow`, hit shade →
cache write + oct map accumulate) · `probeFilter` (3×3 probe space) ·
`resolve` (per pixel: 4 probes × plane+normal weights → irradiance, glossy)
· `injectLitFrame` · `relightBricks` · `cacheEvict`. Every dispatch count is
a uniform or a tier constant; every WGSL is scene-independent.

### K.8 Budgets (from PLAN §4.6) and receipts
`profile.gi2`: window MB, bricks resident/dirty/built/overflow per level,
pairs/frame + ms, cache slots used, probes traced, rays, hits/misses, cache
hit ratio, time-to-first-occupancy per level, time-to-first-light. Gates in
PLAN Stage 2 rows. First receipt to produce: `probe:gi2-trace` rays/s at 3
tiers (K.4 alone, synthetic scene) — every ray budget bends to it.

---

## L. STAGE 3 DESIGN — THE GATHER (screen probes + resolve), written 08-27 by the architect

Runs on the window (§K). Tier constants: tile size `T` (8 px desktop, 16 px
phone), oct map `O = 8` (64 directions), rays/probe/frame `R` (8 low/medium,
16 high/ultra), history frames `H = 4`. All dims are uniforms; WGSL scene-free.

### L.1 Probe placement (`probePlace`, 2-D dispatch over tiles)
One probe per `T×T` tile of the RESOLVE-res gbuffer. Pick the tile's anchor
pixel by a per-frame Hammersley jitter (frame index uniform), reject sky/
background pixels (try up to 4 candidates; a tile with no surface holds no
probe → weight 0 in the resolve). Store per probe: world position, geometric
normal (from the gbuffer), depth, `valid` bit, tileId. Anchor is pushed
`0.5 · v0` along the normal (K.4 bias) before tracing.

### L.2 Probe trace (`probeTrace`, one thread per (probe, ray))
Ray directions: octahedral texel centres of the `O×O` map, cosine-weighted by
the probe normal (hemisphere; the back hemisphere's texels store 0 and are
skipped), `R` of the 64 per frame chosen by a per-frame stratified index so
64 fill in `64/R` frames. Per ray: (1) HZB screen segment — closest-HZB
stackless walk over the resolve-res depth for at most `S_MAX = 24` steps,
relative thickness 0.1; on a screen hit, radiance = last frame's lit colour
at that pixel (the `injectLitFrame` source), done; on "went behind a surface"
or off-screen: step BACK to the last unoccluded position and hand off; (2)
`traceWindow` (K.4) from the hand-off point; hit → read the hit voxel's face
radiance from the cache (K.6) — if the slot is fresh (never shaded), shade it
NOW (albedo × (sun × DDA shadow ray + NEE light tree) + emissive) and write
it; miss → sky (the scene environment along `d`, times the S1 intensity).
Write `(radiance, hitDistance)` into the probe's oct texel for this frame.
Cost per frame = `probes × R` rays, constant by tier: ultra 25k×16 = 400k.

### L.3 Probe accumulation (in the same kernel, per texel written)
Reproject the probe's PREVIOUS oct map: find last frame's probe whose world
position is within `0.5 · T · pixelWorldSize` and whose normal agrees
(`dot > 0.9`); if found, `texel = lerp(prev, new, α)` with `α = 1/min(n+1,
H)` per texel (n = that texel's sample count, stored in the texel's alpha) —
GI-1.0's biased hysteresis: on a large radiance change (`|new−prev| >
0.5·max`) force `α = 0.5`. If no matching previous probe: fresh (n = 0).
This is the ONLY temporal term: probe-space, world-validated, no history of
the final image, no AO history (user rule).

### L.4 Probe filter (`probeFilter`, 2-D over tiles)
3×3 probe-space bilateral: neighbours weighted by plane distance to this
probe's plane (`exp(−|n·(p_i−p)|/v0)`) and normal agreement; per texel
average of valid neighbours' texels (skip texels with n = 0). Output the
filtered oct map (separate buffer; the raw map stays for accumulation).

### L.5 Resolve (`resolve`, 2-D over resolve-res pixels)
For pixel P with normal N: the 4 surrounding probes (tile corners) weighted
by bilinear × plane distance × normal agreement (Lumen's weights), fall back
to the nearest valid probe if all 4 are invalid; irradiance = Σ over the
probe's oct texels of `L(ω) · max(0, N·ω) · solidAngle(ω)` (a 64-term sum
per probe × 4 probes = 256 MACs; or precompute per probe a 9-coefficient SH
in `probeFilter` and evaluate SH at N — do SH on phone tiers, oct sum on
desktop; measure both). Glossy: the reflection direction's oct texel (bilinear
in oct space) from the same 4 probes, cone-widened by roughness (mip of the
oct map = the 2×2 average stored beside it). Output: full-res `irradiance`
(RGBA16F) and `glossy` (RGBA16F) — the two textures Stage 1.1's thin hook
already consumes. GTAO composes as today.

### L.6 Lit-frame injection (`injectLitFrame`, 1/16 of pixels per frame)
For a stratified subset of pixels: final lit colour (the frame's output before
post) → the pixel's voxel face slot in the cache (EMA α 0.25), faceId from
the pixel normal's dominant axis + sign. This is what makes VISIBLE surfaces'
bounce colour exact within a frame; off-screen surfaces converge through L.2's
fresh-slot shading.

### L.7 Budgets and receipts
`profile.gi2.gather`: probes placed/valid, rays traced, screen-hit %, window-
hit %, sky %, fresh-slot shades, reprojection hit %, α forced count, ms per
kernel. Gates (PLAN Stage 3 rows): Cornell colour-probe parity; 2nd bounce
present within 30 frames; off-screen lamp lights its corridor; GI ≤ 4 ms at
1650×970 ultra, ≤ 2.5 ms on the phone rig; max frame time during a 10 s
orbit ≤ 1.2× parked; no user-visible blocks.

---

## M. STAGE 3.4/4.0 INTEGRATION SPEC — GI2 AS THE LIT PATH (written 08-27 by the architect)

Goal: `GISystem` builds and runs GI2 (window + soup + voxelizer + dynamic +
gather + cache) INSTEAD of the SRC chain and the dense occupancy field, behind
ONE module-private build constant `GI2_PATH = true` in `giConfig.js` (not a
component property, not a `__gi*` flag; it exists only until Stage 4 deletes
the old path). Materials keep consuming exactly what Stage 1.1 left them:
two screen textures (`giIrradiance`, `giGlossy`) at resolve res + the
emitter/light slot uniforms in the render group. AO stays GTAO. The BVH8
mirror path stays at high/ultra (its own unit later; off in the first cut).

### M.1 Build (`#rebuild` when GI2_PATH)
1. Skip: `#buildOccupancyField`, `createSrcVolume`, `createSrcProbeSystem`,
   the static shadow BVH (`buildStaticSceneBvhWords`), `buildBvhScene`,
   reflection-probe capture, `#buildEntries`' record/attribution machinery.
   Keep: `#collectMeshes` (tags, palette via `resolveMaterialSurface`),
   light slots / emitter slots / light tree (the NEE source), the gbuffer
   prepass (`renderGiGBuffer` — GI2 needs position/normal/depth at resolve
   res), GTAO, the screen targets that the thin hook reads.
2. `createTriangleSoupBuilder().build({geometries: serializeMeshForBake per
   geometry, placements: static placements with pal from
   resolveMaterialSurface})` — async, off-thread; GI2's window is created
   immediately (tier from `resolveGiConfig`), the voxelizer waits for the
   soup promise (log `[gi2] soup N tris, M MB, built in X ms off-thread`).
   Movers (the `dynamicObjects` adoption list + skinned proxy boxes) →
   `windowDynamic.setMovers` with per-mover local soups.
3. Kernels are created once per build; NOTHING scene-sized is allocated on
   the CPU (the soup lives in the worker; its transfer is the only copy).
   All storage attributes go through 0.2b's `storageAttributes` publication;
   all CPU mirrors detach.

### M.2 Frame (`#tick` when GI2_PATH), in order
`window.setCamera(cam)` (scroll) → `voxelizer.passes(cam, frustum)` (budget)
→ `dynamic.passes(cam)` → gbuffer prepass (existing, content-key held) →
`gather.passes()`: hzb, probePlace, probeTrace(+accumulate), probeFilter,
resolve → GTAO (existing) → `injectLitFrame` (reads the frame's final colour
from the previous frame's output target) → `relightBricks` budget. Sun
direction/colour + emitter slots + sky intensity come from the existing
uniforms (already in the render group). All passes ride `giCompute` (1.3's
batched submit). Publish `profile.gi2` (K.8 + L.7) and set
`_transportAlive` from the gather's `probesValid > 0 && windowHits > 0`.

### M.3 Materials
`giLight.js` `GICascadeLightNode.setup` is unchanged — it samples
`giIrradianceNode`/`giRadianceNode`; GI2's resolve writes those two textures
(full-res irradiance already, so the bilaterals (J.0 items 3+5) become a
single sample when GI2_PATH — do that in the same commit: −8.4 kB, clears
the J.7 gate). Emitter direct diffuse: today it arrives through the SRC
irradiance texture (`giLight.js:2083`); GI2's gather must include emitter
NEE at probe hits AND at the probe position itself (direct emitter light on
the probe's surface via one shadow ray per emitter slot per probe per frame)
so the texture carries the same term. The `emitterShadowPass` chain is NOT
dispatched under GI2_PATH (its 10-20 ms was the price of per-pixel analytic
emitter shadows; the probe-res term replaces it — the quality trade PLAN
§4.4 names; measure on the Level's lamps).

### M.4 Gates (run the OLD battery where it applies + the GI2 probes)
Cornell colour probe (`__giColourProbe` receipts) within the 3.2 bracket;
`test:gi-sunleak` (the harness must PASS on GI2 — 0 leak); the Level: first
light ≤ 3 s after assets ready; Bistro: first light ≤ 3 s, GI GPU ≤ 4 ms at
1650×970 ultra, heap ≤ 1.2 GB, zero SRC kernels compiled; `test:gi-moved-lamp`
PASS (the glow term is material-side, unaffected); `test:gi-lighttree-mover`
(mover bounce through the dynamic layer); orbit paired medians ≤ 1.2×.
Everything old-path-only (`test:gi-src-*`, `test:gi-occupancy`) keeps running
with `GI2_PATH=false` until Stage 4 deletes it.

---

## N. STAGE 4.1 CUTOVER WORK LIST (read-only census 08-27, `gi19-stage0` @ `c67bc41`)

Method: `GI2_PATH = true`, follow every `import` in `GISystem.js` / `giLight.js` / `giScreen.js` /
`gi2System.js` and the call graph from `#rebuild` / `#tick` / `#dispose`. Baseline
`src/modules/gi/**/*.js` = **68,099 lines / 59 files** (0.1 landed at 56,767; Stage 2-3 added the 10
`window/` files). Build check after each step: `npx esbuild --bundle src/modules/gi/GISystem.js
--format=esm --external:three --external:three/webgpu --external:three/tsl --outfile=/dev/null` (today
1.6 MB, 57 ms).

### N.1 KEEP — reachable under GI2 (30 files, 17,725 lines, untouched)

`window/` (10 files, 7,055): gatherProbes 1981, windowVoxelize 1314, gi2System 984, windowDynamic 527,
windowTrace 508, windowStore 471, radianceCache 383, triangleSoup.worker 373, windowFill 272, triangleSoup 242.

Outside `window/` (10,670): giLight 2799, lightTree 1674 (**see R1**), bvh/bvhScene 1048 (mirror tier),
emitterShapes 845, skinnedProxy 782 (**R3**), giConfig 587, releaseCompute 542, reflectionProbeCapture 446
(mirror tier), voxelizeOnce 438 (`resolveMaterialSurface` / `serializeMeshForBake` are `#startGi2Build`'s
inputs — rename, do not delete), slotRegistry 284 (**R7**), primitiveFit 228, reflectionProbes 225
(`giLight.js:45` `sampleReflectionProbes` is in every shipping material), GlobalIlluminationComponent 157,
lightTreeStore 141, giFn 106, bootAmbient 103, ReflectionProbeComponent 86, index 46 — plus two files whose
names lie: **`srcOctahedral.js` 99 — the gather DOES import it** (`gatherProbes.js` -> `../srcOctahedral.js`,
also reflectionProbes + reflectionProbeCapture) -> rename `giOctahedral.js`; **`rayHit/rayHitTSL.js` 34 —
imported by `giScreen.js:68` and `dynamicObjects.js`** -> fold `octDecodeTSL` into `giFn.js` first.

### N.2 DELETE — reachable only under `GI2_PATH = false` (24 files, 24,102 lines)

occupancyField 5212, srcSystem 2361, rayHit/RayHitPacking 2040, srcRef 1720, srcProbes 1678, srcMath
1472, srcDeposit 1450, srcScreenGather 764, srcMerge 763, srcRays 752, srcShade 750, srcMathTsl 727,
srcTiles 703, **lightTreeGpu 689**, srcSurface 521, srcSeed 459, srcSecondary 434, srcVolumeRef 418,
srcTrace 283, srcDebugViews 215, srcGizmos 214, rayHit/RayHitValidator 167, rayHit/RayHitDebug 165,
rayHit/RayHitConfig 145.

`lightTreeGpu.js` is a full delete, not a trim: its only consumers are `GISystem.js:6664/6718`
(`createLightTreeEmitterImportance` / `createLightTreeRecordSlot`, both fed `volume.occupancyField.bits`
-> null under GI2) and `srcSystem.js:73`; `gatherProbes.js` does its NEE from the emitter slots directly.

**Ordered sequence (esbuild-green after each step):** 1 `GISystem.js` — cut the 25 SRC-only methods
(N.3) and every `!GI2_PATH` arm; drop imports at lines 38-48 except `srcConfig`'s ALPHA_*. · 2
`giScreen.js` — cut the 10 now-uncalled pass factories (N.3). · 3 `index.js:33-46` — the 18
`rayHit/*` re-exports (**zero consumers**). · 4 delete `srcSystem.js` + its 13 leaves (srcGizmos,
srcMerge, srcRays, srcSeed, srcShade, srcSecondary, srcTiles, srcTrace, srcScreenGather, srcDeposit,
srcProbes, srcMathTsl, srcMath) as one closed cluster. · 5 delete `lightTreeGpu.js` (now zero
consumers). · 6 delete `srcRef.js`, `srcVolumeRef.js`, `srcDebugViews.js`, `srcSurface.js`. · 7 move
`createSrcWorld` (`srcVolume.js:98-141`, 44 lines) into `window/windowStore.js`, repoint
`gi2System.js:69`, delete `srcVolume.js` (-540). · 8 delete `occupancyField.js`. · 9 move
`octDecodeTSL` into `giFn.js`, repoint `giScreen.js:68` + `dynamicObjects.js`, delete `rayHit/`. ·
10 fold ALPHA_MOTION_SAT / ALPHA_TRACK_{HOLD,REARM,THRESHOLD} / R0_OVER_S0 into `giConfig.js`, delete
`srcConfig.js` (1095 -> ~45). · 11 rename `srcOctahedral.js` -> `giOctahedral.js` (3 importers). ·
12 `dynamicObjects.js` — delete `createDynamicObjectSet` (1327-2541) + `composeFieldDynamics`
(2541-2587) = -1,260; **do R3/R4 first** or the adoption and skinned-proxy machinery loses its home.

### N.3 REWIRE — reachable under both; the GI2 use is a thin spine

**GISystem.js SRC-only methods, cut outright (2,453 lines), as `line/len`:** `#buildOccupancyField`
15303/465, `#buildLightShadow` 5424/437 (returns null at 5430, `!occ?.voxel`), `#acquireLightShadowNode`
12237/243, `#buildEmitterRecordTrace` 5861/177 (null at 5863), `#syncSrcPoolPressure` 11771/175,
`#rebuildSrcProbesForPools` 11557/160, `#refreshOccupancyTransforms` 16143/125, `#syncLightShadowNodes`
12134/103 (`live` false), `#refreshOccupancyContent` 16027/91, `#maybeLogSrcProbeStats` 9453/71,
`#clearEmitterShadowTargets` 9148/54, `#lightShadowSize` 9034/46, `#releaseLightShadowNode` 12497/46,
`#emitterShadowScale` 9106/42, `#estimateSrcStoreBytes` 8903/34, `#lightShadowScale` 9080/26,
`#srcPoolsForBuild` 11453/24, `#buildOccupancyView` 17228/21, `#srcPoolsRestored` 11484/21,
`#surfacePoolHintForBuild` 11520/20, `#retireShadowDepth` 12480/17, `#persistSurfacePoolHint` 11540/17,
`#poolPrefsKey` 11437/16, `#persistSrcPools` 11505/15, `#srcBinBudgetCap` 11477/7.

**SRC arms inside shared methods** (measured SRC-token line density, x~2.5 for the comment blocks that
go with them): `#buildScreenResolve` 6038/1325 @14% = -500; `#syncScreenResolveSize` 7684/431 @23% =
-250; `#rebuild` 9737/1374 @6% = -250; `#tick` 2167/2114 @3% = -200;
`#refreshDynamicObjects`+`#tryAdoptDynamic` 16268/382 @10% = -150. **GISystem total ~ -4,850 -> ~12,400.**

**giScreen.js (-2,400 -> ~2,360).** DELETE, all uncalled once the GISystem arms go: `createGiResolve`
590/410 (null at GISystem:6768), `createGiIrradianceTemporalPass` 3358/363 (`irrTemporalOn` false at
6595), `createGiLightShadowPass` 1922/353, `createGiEmitterTileCutPass` 2486/292,
`createGiLightShadowWidePass` 3029/267, `createGiLightShadowFilterPass` 2778/251,
`createGiEmitterShadowPass` 2275/211 (`!GI2_PATH` at 7030), `createGiFarFieldAvgPass` 503/87 (gated on
`srcProbes?.gather` at 6528), `createGiLightShadowHistoryPass` 3296/62, `createGiShadowClearPass` 4351/58.
KEEP `createGiGBuffer`, `renderGiGBuffer`, `createGiGtaoPass`, `createGiAoFilterPass`,
`createGiBvhHitShade`/`Reflect`/`Target`, `giBvhReflectStride`, `blitBvhAtlasTiles`,
`readTexturePixelsGPU`, `computeCompressedTextureAverage`. TRIM `createGiTargets` 4046/305
(GISystem:6053-6062 says its emitterShadow + irradiance channels are allocated and never written under GI2).

**Named rewires (anchors):**
- **R1 — the light tree feeds nothing.** `gi2System.js:206` destructures `lightTree` and the identifier
  never appears again in the file (2 hits total, both signature/JSDoc). `GISystem.js:6088` passes
  `this._lightTreeRegion`; `#refreshLightTree` (13925/147) still runs under GI2 (9988:
  `(this._dynSet || GI2_PATH)`). Either wire the W1 region into `gatherProbes`' NEE, or `lightTree.js`
  (1674) + `lightTreeStore.js` + `#refreshLightTree` are dead weight.
- **R2 — the volume spine.** `createGi2Volume` (`gi2System.js:104`) is 38 lines whose only content is
  `createSrcWorld` (`srcVolume.js:98`). Move it; the other 540 lines of `srcVolume.js`
  (`createSrcDistance` 155, `createSrcWidthProbe` 186, `createSrcSoftShadowTrace` 299, `createSrcVolume`
  501) all require an occupancy field.
- **R3 — skinned proxies are already unreachable.** `#refreshSkinnedProxies` (16800/159) is called only
  from `#refreshDynamicObjects` (16268), which returns at 16270 (`this._dynSet` is null — it is created
  inside `#buildOccupancyField` at 15708). The plan keeps skinned proxies -> rewire onto `#gi2Movers`
  (15900), which today only emits world boxes for `mesh.isSkinnedMesh`.
- **R4 — adoption.** `#tryAdoptDynamic` (16530/120), `#evictRestingMover` (17003/61),
  `#maybeRebuildStaticBvh` (16417/81) likewise unreachable; `#gi2Movers`:15908 reads `"auto"` as STATIC
  by design. Rewire to `windowDynamic.setMovers` before N.2 step 12.
- **R5 — portable audit.** `#auditPortableBindings` (4442/982) collects at 4456
  (`state.volume.occupancyField.prewarmComputes()`) and 4463 (`state.screen.srcProbes.passes`) ->
  `state.screen.gi2.computeNodes`. ~5 lines.
- **R6 — content walk.** `#occupancyContentOf` (15941/86) **is** GI2's content walk
  (`#startGi2Build`:15843) — rename `#gi2Content`, keep.
- **R7 — slot registry.** `new SlotRegistry` (9891), `#syncSlots` (13772/99), `#buildEntries`
  (13096/245) serve SRC's attribution palette (comment at 10441); under GI2 the only surviving consumer
  is `#ensureSlotAlbedoAtlas` (8759), i.e. the mirror tier. Gate the entries/slots walk on it.
- **R8 — reflection probes.** `#armReflectionProbeCapture` (8295) returns at 8298 (`!state.bvhScene`);
  keep with the mirror tier — `reflectionProbes.js` itself is unconditional (material-side).
  **R9 — giLight** has only two `GI2_PATH` branches (`:2036` `gi2Sample`, `:2224`) — collapse both.
- **R10 — dynamicObjects survivors.** `giMobilityOf`/`giTraceOf` (171/179) feed `#gi2Movers` and
  `#skinnedProxyGroups`; `buildBvhWords`/`buildStaticSceneBvhWords` (330-1318) stay for the mirror tier.

### N.4 TEST / SCRIPT CENSUS

| group | npm scripts | runner lines | `scripts/*.html` | html lines |
|---|---|---|---|---|
| **DELETE** | 36 | 11,241 | 14 | 9,803 |
| **REWRITE** | 26 | 10,931 | 1 (`gi-gpu-smoke.html`) | 1,671 |
| **KEEP** | 35 | 12,290 | 6 | 4,379 |

**DELETE (SRC-only oracles):** the 7 `test:gi-rayhit*` (2,858); the 20 `test:gi-src-*` / `probe:gi-src-*` /
`eyecheck:gi-src` (5,201; largest `run-gi-src-ref-test.mjs` 2,623, `run-gi-src-cost-probe.mjs` 650);
`test:gi-occupancy` 330; `test:gi-surface-pool` 206; `test:gi-src-worldkeys` + `test:gi-worldkeys-flip` +
`test:gi-spin-retention` 938; `probe:gi-gtao` 221 (reads `state.screen.vxaoPass.target`, a vxao remnant);
`probe:gi-debug-views` 291 (built entirely on the three global-only SRC views); `probe:gi-boot` 1,098 (its
own header says `probe:gi2-boot` supersedes it). Plus **31 orphaned SRC runners with no `package.json`
entry (8,820 lines)** — largest `run-gi-flicker-frame.mjs` 1924, `run-gi-lightshadow.mjs` 716,
`run-gi-real-shadow-probe.mjs` 702, six `run-blackframe-*`.

**REWRITE** (asserts something GI2 must still satisfy, but reads an SRC internal):

| script | reads today | must read instead |
|---|---|---|
| `test:gi-spawn` | `state.volume.occupancyField` | `windowDynamic` + `profile.gi2.dynamic` |
| `test:gi-lighttree-nee` | `__giSrcLightTree`, the `srcSystem` boot line | drop the gate (tree unconditional); `lightTree.js` + `gi2.freshShades` |
| `test:gi-lighttree-mover` | `volume.occupancyField.bitsBuffer` | `gi._lightTreeStore.bitsBuffer` (already the fallback arm) |
| `test:gi-compute-release` | `screen.srcProbes.{passes,cpuMirrors}` | `screen.gi2.{computeNodes,storageAttributes}` |
| `probe:gi-portable` | `occupancyField.passes()`, `srcProbes.passes[]` | `screen.gi2.computeNodes` + `gi2.occupancyMs` |
| `probe:gi-walk` (1,424) | 21 `__giSrc*`, `srcRef`, `srcScreenGather` | `gatherProbes` + `radianceCache`; `gi2.{probesValid,reprojHits,freshShades}` |
| `probe:gi-emitter-shadow` (982), `probe:gi-shadow-viewdist` | `occupancyField` + the `srcVolume` shadow trace | **both estimators die at step 7** — re-aim at GI2's probe-res emitter term, or delete |
| `probe:gi-attribution` | `giPasses.srcProbes.{unattributedRate,shadedHitsPerFrame}` | `gi2.{windowHits,screenHits,skyMiss,freshShades}` |
| `smoke:gi-gpu` | `result.srcProbes.*` | `result.gi2` — the branch comment already exists at `run-gi-gpu-smoke.mjs:90-92` |
| `test:gi-src-volume` (698) | L83-562 is a `srcVolumeRef` CPU oracle; L563-698 is the `createSrcWorld` spine | **split the file**, keep the spine only |

Also REWRITE, same shape: `test:gi-instanced`, `test:gi-sparse`, `test:gi-coverage`, `test:gi-colour-bleed`,
`probe:gi-colour-seam`, `probe:gi-flat-walls`, `probe:gi-lowsun-blocky`, `probe:gi-ao-glossy`,
`test:gi-probe-density`, `test:gi-gather-los`, `probe:gi-emissive-cost`, `test:gi-lighttree-sponza`,
`test:gi-shadowed-bulb`, `test:gi-seat-churn`, `test:gi-emitter-size`. `test:gi-sunleak` (`__giEntity`
only) and `test:gi-lightvis` (`cascade` in a comment) need **no** change — M.4 already names sunleak the
GI2 gate. `scripts/lib/*` = 12 files / 2,861 lines, **all KEEP**, no SRC import anywhere.

### N.5 PROFILE + DEBUG VIEWS

`profile.giPasses` (`src/editor/api/ops/profile.js`): the `srcProbes` block (L186-318) goes `null` at
its own L187 guard — no throw, but 17 fields vanish. Map: `totalMs`->`gi2TotalMs` (341);
`dispatches`->`keys(gi2Ms)` (340); `megabytes`->`windowMB+cacheMB+soupMB`; `reanchors`->`scrolls`;
`cascades[].live`->`probesValid`; `.capacity`->`probes`; `shadedHitsPerFrame`->`freshShades`+`windowHits`;
`raysPerFrame`->`raysTraced`; `marcher` (324)->`describe().voxelizer`. **No equivalent yet:** `groupMs`
(GI2 has no `passGroups`, only per-pass `__giPassName`), `loadFactor`, `meanProbeSteps`, `probeRayCap`,
`unattributedRate`, `merge`/`seed`/`tiles`. Delete `SCREEN_PASSES` (L34-42 — all 8 keys name deleted
passes) and the L349-351 note. In `profile.frameStats` only `giHold.fieldQuietFrames` (646) loses meaning;
the `gi2` block (681-745, 23 fields) is already complete. **`profile.gi2` exists in source (L936-948) but
is NOT registered in the live MCP tool list** — register it, or the "every feature drivable by an agent"
rule fails exactly at the cutover.

Debug views: the 5 enumerated `GI_DEBUG_VIEWS` (`giConfig.js:72-86` — `off`, `indirect`, `ao`,
`reflections`, `reflections-exact`) **all survive**; verify the GI2 resolve writes `targets.irradiance` for
`indirect` (GISystem:13016). The three global-only `__giDebugView` modes die with their backing files:
`"sdf"` (GISystem:12971 -> `srcDebugViews.js:154`), `"occupancy"` (12972 -> `:62`), `"src-probes"` (7332 +
12977-12986 -> `srcGizmos.js`). GI2 successors (a window occupancy slice off `windowStore`, probe gizmos
off `gatherProbes`' probe buffer) are **not in scope for 4.1** — delete the modes and the stale comments
at `giConfig.js:36-38, 67-70, 88-93`.

### N.6 RISKS

1. **The 25 k gate is not reachable by deletion.** 68,099 - 24,102 (N.2) - 10,115 (N.3) = **~33,900**. The
   rest exists only as prose: `GISystem.js` is 8,891 comment / 8,114 code lines (51.5 %), `giScreen.js`
   2,423 / 2,270. Either re-gate 4.1 at **<= 34 k**, or budget an archaeology amnesty that moves the
   retired-mechanism banners into this document.
2. **A shipped user-facing feature is already inert under GI2.** `LightComponent.js:107` `{key:"shadowMode",
   label:"Shadow Source", options:["map","gi"]}` hides 13 inspector rows when set to `"gi"`;
   `#publishGIShadowContract` (:367) writes `userData.giShadowMode`; `shadowFreeze.js:194` branches on it.
   Under `GI2_PATH=true` `#buildLightShadow` returns null at 5430, so such a light silently falls back to
   three's tiny map — a live regression on `c67bc41`, not merely a cutover risk. Decide: GI2 sun shadows
   through the window trace, or retire the prop (a `LightComponent` schema change, which the GI
   three-property rule does not cover).
3. **Per-pixel analytic emitter shadows go with `createGiEmitterShadowPass` + the tile cut** (~1,200 lines
   of giScreen) — the PLAN 4.4 trade, but the Level's lamps are the user's stated favourite term. Measure
   before deleting; `emitterTileKeyed` (GISystem:7252) and `__giTileCutLive` die with it.
4. **`lightTree` is plumbed into GI2 and never read** (R1) — do not bank `lightTree.js`'s 1,674 lines
   as "kept" until `gatherProbes` consumes the region.
5. **No non-GI module is at risk.** A repo-wide grep outside `src/modules/gi/` finds **zero** imports of
   `src*.js`, `occupancyField.js` or `rayHit/`. `shadowMerge.js`, `merging.js`, `MeshComponent*`,
   `frameGovernor.js`, `sceneSettings.js` and every `src/editor` file are clean; the entire editor
   exposure is one file, `src/editor/api/ops/profile.js`. Likewise `index.js:33-46` — 18 `rayHit/*`
   re-exports with **zero consumers** (the two scripts that use them import the files directly).
6. **~60 `__gi*` flags become dead** — every `__giSrc*` (36), `__giRayHit*` (4), `__giNoOccupancy` /
   `__giOccBudget` / `__giSparseField` / `__giNoDirtyBrick` / `__giNoHiResSdf`, `__giCascadeBranch`,
   `__giC0DirRes`, the 5 `__giTileCut*` and the 6 `__giMerge*`/`__giParallax*`. The editor **sets** none
   of them (read-only tests at `profile.js:106,110`); every setter is in `scripts/`. Sweep them with
   N.4's DELETE group or they become 60 silent no-ops.

---

## O. THE PALETTE'S EMISSIVE INPUT — DIAGNOSIS + FIX SPEC (read-only analysis 08-27, `gi19-stage0` @ `70ea975`)

Written for the finding in 4.0's commit body: *"Bistro's palette has 16 classes
and ZERO with emission … while the emitter-seat resolver finds 95 lamps"*.
⚠ `gatherProbes.js` is under concurrent edit (Stage 3.6, `history: 4 → 32`), so
every anchor into that file below is by SYMBOL, never by line.

### O.1 The divergence — it is a POPULATION cap, not a resolver difference

**Both resolvers are the same function.** `#buildEntries` (`GISystem.js:13367`)
and `#startGi2Build` (`:16113`) both call `resolveMaterialSurface`
(`voxelizeOnce.js:193`) on the same `#collectMeshes()` list, and reduce it the
same way (`emissive.rgb × emissiveIntensity`; peak vs mean). There is no second
resolver to diverge from.

**What differs is the MESH POPULATION each one is fed.**

| path | source | cap |
|---|---|---|
| emitter seats | `#buildEntries` → `#placementsOf` (`:13344`) | none (only `MAX_INSTANCES_PER_MESH` per InstancedMesh) |
| GI2 palette / soup / voxels | `#startGi2Build` → `#occupancyContentOf` (`:16459-16460`) | **`if (placements.length >= MAX_INSTANCE_SLOTS) break;`** |

`MAX_INSTANCE_SLOTS = 768` (`slotRegistry.js:60`). **Bistro has 1532 mesh
placements** — the constant's own header already records the symptom at the
previous value: *"The 512 it shipped at cost Bistro two thirds of its geometry:
`1020 of 1532 placements could not seat (slots 512)` … Overflow seating is
first-come by collect order (GISystem breaks at this constant), so WHICH two
thirds vanished was an accident of hierarchy order on top of it."*

**And hierarchy order puts every lamp past the cut.** Counted directly from
`C:/Users/Khudiiash/Documents/GAME/Sketchfab/Bistro_Godot/Bistro_Godot.prefab`
(1532 `mesh` components, one material each, no material overrides in
`Bistro.scene`), the emissive materials sit at these traversal indices:

| material | emissive (graph prop) | strength | placements | traversal index |
|---|---|---|---|---|
| `Bistro_Sign_Letters` | `#ff0000` | 10 | 1 | **145** — inside 768 |
| `MASTER_Focus_Glass` | `#ffffff` | 10 | 10 | **383-539** — inside, but `transparent` (see below) |
| `Lantern` | `#ffffff` | 1 | 5 | 1156-1160 — CUT |
| `Shopsign_Pharmacy` | `#00ff00` | 1 | 1 | 1240 — CUT |
| `Paris_StringLights_01_White_Color` | `#ffffff` | 1 | 36 | 1299-1391, 1445+ — CUT |
| `…_Red/Blue/Green/Pink_Color` | pure R/B/G/M | 1, 1, 10, 1 | 8 each | 1447+ — CUT |
| `…_Orange_Color` | `#ffff00` (sic) | 1 | 5 | 1451+ — CUT |
| `Spotlight_Emissive` / `Spotlight_Glass` | `#ffffff` | 1 | 5 + 5 | CUT |

So the palette's input list contains **at most one** emissive placement
(`Bistro_Sign_Letters`), and glass is excluded from `meshes` altogether —
`#collectMeshes` keeps a mesh only `if (position && material &&
!material.transparent && …)` (the `meshes.push(object)` guard).
`0 of 15 classes with emission` follows without any resolver failing.

⚠ **The cap is not a palette bug — it truncates GI2's whole world.** The same
768 list feeds the triangle soup, the voxelizer and the static BVH, i.e. 764 of
Bistro's placements have no occupancy, no bounce and no shadow under GI2. It is
also the source of `GI_SPATIAL_REBUILD_PLAN.md:1554`'s *"no mesh/tri caps, 768
placements"* — a blind statistic: 768 IS the cap, read as the scene's count.

### O.2 Refuted, with the receipt for each

* **(i) "the palette reads `material.emissive` and ignores maps/intensity"** —
  REFUTED. Bistro's emissive is authored as `principledBsdf` graph props
  (`emissive` + `emissiveStrength`), which `tslGraph.js:475` + `:105-108` turn
  into `m.emissiveNode = mul(color, strength)`, which `constantColorOf`
  (`voxelizeOnce.js:23-39`) folds. No `.mat` in the Bistro set has a top-level
  `emissive`/`emissiveIntensity`/`emissiveMap` key at all.
* **(ii) "the GPU texture average lands after the palette is built"** —
  REFUTED *as the cause here*: 11 of Bistro's 12 emissive materials have **no
  emissive texture**, so nothing waits on `pendingTextureAverages`. ⚠ but the
  MECHANISM IS REAL and will bite the moment a compressed emissive map is
  authored: `setPalette` is called from exactly one place
  (`gi2System.js:503`, inside `build`), `build` is called from exactly one place
  (`GISystem.js:10924`, inside `#rebuild`), and `#checkFingerprint`'s content
  path (`:15219-15225`) re-runs `#buildEntries` / `#syncSlots` /
  `#refreshOccupancyContent` and **never touches the palette**. The old path
  re-tinted through `atlas.setSlotSurface`; GI2 has no equivalent. Fix it in
  O.5(c) anyway.
* **(iii) "node-graph emissive is unreadable"** — REFUTED, see (i). The one
  textured emissive (`Lantern`, a `.basis` map) would take the
  `textureScaleOf` path, which works.
* **(iv) "the quantizer merged the lamp class away"** — NOT the cause today.
  The commit's "16 classes" is `PAL_ENTRIES` (the array length the harness
  prints), not the occupied count; the occupied count is the
  `[gi2] soup … palette N of 15 classes` line. Measured over all 131 materials
  / 1532 placements, Bistro's albedos occupy only **7 of the 27** buckets the
  3-level lattice can produce, so the `slice(0, GI2_PAL_CLASSES)` cut
  (`gi2System.js:165`) evicts **0 placements**. ⚠ It becomes a REAL risk the
  moment O.5(a) admits the lamps: ranking is by **placement count**, and
  `Bistro_Sign_Letters` is `n = 1` against walls at `n` in the hundreds.
* **(v) something else** — yes: the population cap, O.1.

### O.3 The design rule this fix must encode (from the user)

*"The smaller the emitter, the more emission strength it needs to be considered
as something emitting light to the scene."* The engine already implements this
as the radiant-power gate `Φ = π·A·L` against `GI_EMITTER_MIN_POWER_FRACTION =
0.002` (`GISystem.js:158`, `#emitterMinPowerFraction :13899`,
`#belowEmitterPowerGate :13959`, admission recorded by
`#recordEmitterAdmission :13924` from `collectEmitters`). **So the palette must
not make every emissive map bounce.** Its emissive must follow the SAME
admission decision the emitter resolver makes — which is already a single
written function:

```js
#slotSurface(entry)                                   // GISystem.js:13820
  const zeroed = entry.promoted || this.#isNeeEmitterMesh(entry.mesh)
                                || this.#belowEmitterPowerGate(entry);
```

⚠⚠ **BUT `#isNeeEmitterMesh` IS WRONG UNDER GI2 AND WOULD RE-ZERO EVERYTHING.**
It returns true for *every tree candidate* when `#lightTreeIsNeeSet()`
(`:13777`) is true, and that is true under GI2 because `#rebuild` builds the
tree region on this path (`:10249`, `(this._dynSet || GI2_PATH)`). But GI2 does
**not** sample the tree at hits — 4.0's decision was "keep the plumbing, no tree
NEE yet", and `gatherProbes`' `shadeHit` does NEE over `emitters ?? []`, i.e.
the `MAX_EMITTERS = 4` slot uniforms only. Under GI2 the NEE set is the four
seats. Reusing `#slotSurface` verbatim would zero all 95 and reproduce today's
symptom through a different door.

Therefore the three tiers the palette must produce on Bistro:

| tier | count (Bistro) | palette emissive |
|---|---|---|
| seated in one of the 4 gather slots (`entry.promoted`) | 4 | **0** — `shadeHit`'s NEE already delivers them; non-zero is the 2.60× double-count of §12.26.7 |
| admitted by the Φ gate, not seated | ~78 | **`emissive.rgb × emissiveIntensity`**, sub-cell damp applied |
| culled below the Φ gate (`#belowEmitterPowerGate`) | 13 | **0** — the user's rule, and the whole point of the cull |

### O.4 The class count — 16 is not the problem, the LATTICE is

`PAL_ENTRIES = 16` (`gatherProbes.js`, `GI2_PAL_CLASSES = PAL_ENTRIES - 1`,
last entry reserved black for `PAL_NONE`). The byte allows 255 and the storage
is a `uniformArray(vec4)` of 16 = **256 bytes**; 64 classes = 1 KB, 255 = 4 KB,
all far under the 64 KB binding limit, and `palAt`'s cost is one indexed
uniform read at any N. There was never a reason for 16 beyond "a fixed table
keeps scene numbers out of the WGSL", which holds at any fixed N.

Placement-weighted per-channel albedo error, 131 Bistro materials / 1532
placements (albedo = alpha-masked linear mean of each material's decoded
diffuse map, since `.mat color` is `#ffffff` on 1447 of 1532 placements; a
per-material mean, so these are a FLOOR on the true error):

| scheme | mean abs err | p95 abs err |
|---|---|---|
| **3-level lattice (today)** | **0.1113** | **0.2306** |
| 3-level + top-16 eviction | 0.1113 | 0.2306 (eviction never fires) |
| 5-level lattice + top-64 | 0.0507 | 0.1012 |
| RGB565 per voxel (2 B/voxel) | 0.0059 | 0.0097 |
| weighted k-means, k=16 | 0.0120 | 0.0403 |
| weighted k-means, k=64 | **0.0008** | **0.0041** |
| weighted k-means, k=255 | 0.0000 | 0.0000 |

**Read it as: k-means at the CURRENT 16 classes is 9x better than the lattice,
and k-means at 64 is 140x better and beats per-voxel RGB565** — which would
double the voxel store (256 KB → 512 KB per window level) and break
`windowVoxelize`'s packed-word MAX merge (`windowVoxelize.js:28-30`, "max of
packed words is max of fields"). So:

> **RECOMMENDATION: keep one byte per voxel. Raise `PAL_ENTRIES` 16 → 64
> (63 real classes + `PAL_NONE`), replace the fixed 3-level lattice with a
> deterministic weighted median-cut/k-means over ~1500 placements
> (microseconds, CPU, once per build), rank by AREA not placement count, and
> RESERVE a band of 8 classes for admitted emitters.** Do NOT go to 255 (the
> k=64 residual 0.0008 is already an order below the per-mesh-mean error the
> resolver itself carries) and do NOT go RGB565.

Also: `pal.w` is ONE FLOAT and `shadeHit` adds it as `vec3(pal.w)`, so a red
lamp bounces GREY. A second `uniformArray(vec4)` for emissive RGB is 1 KB at 64
classes; this file's own audit already budgeted "palette uniforms (N×2 vec4s)".

### O.5 THE FIX — exact anchors

**(a) Uncap the GI2 content walk — this is the precondition, do it first.**
`GISystem.js:16460`, inside `#occupancyContentOf`:

```js
for (const instanceId of this.#placementsOf(mesh)) {
  if (placements.length >= MAX_INSTANCE_SLOTS) break;      // <- the cut
```

The 768 exists for the SRC atlas's `localToWorld` uniform array
(`slotRegistry.js:27-58`) — **which is not built under GI2**: `#rebuild`'s
`const occField = GI2_PATH ? null : this.#buildOccupancyField(…)` (`:10159`).
GI2's consumers are the soup (`triPal`, a storage buffer) and the voxel `pal`
byte; neither has a slot ceiling. Take the cap from a parameter:
`#occupancyContentOf(meshes, { cap = MAX_INSTANCE_SLOTS } = {})`, pass
`{ cap: Infinity }` from `#startGi2Build` (`:16107`), leave `:15641` / `:16504`
(SRC/BVH) on the default. Expected: Bistro `[gi2] soup requested:` goes
768 → ~1500 static placements. Also fix the loop while there — `break` exits
the INNER loop only, so today every mesh past the cut still pays
`serializeMeshForBake` and still appends to `geometries` for zero placements.

**(b) Make the palette's emissive the admission decision.**
`GISystem.js:16110-16120`, `#startGi2Build`'s `enriched` map, replaces the raw
resolve:

```js
emissive: (raw.emissive.r + raw.emissive.g + raw.emissive.b) / 3 * (raw.emissiveIntensity ?? 1),
```

`#buildEntries` has already run in the same `#rebuild` (`:10203`, well before
`:10924`), so `state.entries` and `_emitterAdmittedMeshes` are live. Build
`const entryOf = new Map(state.entries.map(e => [e.key, e]))` — `entry.key` and
the placement key are both `slotKeyOf(mesh, instanceId)` — and take the
emissive from a **new GI2 sibling of `#slotSurface`**:

```js
#gi2SlotEmissive(entry) {                    // next to #slotSurface :13820
  if (!entry) return 0;                       // no entry => no emission
  if (entry.promoted) return 0;               // the 4 gather NEE slots
  if (this.#belowEmitterPowerGate(entry)) return 0;   // the user's cull
  // NOT #isNeeEmitterMesh — see O.3; GI2 does not sample the tree at hits.
  let r = entry.surface.emissive.r * entry.surface.emissiveIntensity;
  let g = entry.surface.emissive.g * entry.surface.emissiveIntensity;
  let b = entry.surface.emissive.b * entry.surface.emissiveIntensity;
  const damp = this.#subCellEmissiveDamp(entry);      // :13998, default OFF
  // …identical chroma-then-energy ramp as #slotSurface…
  return (r + g + b) / 3;   // or the vec3, once (d)'s second uniformArray lands
}
```

⚠ `#belowEmitterPowerGate` FAILS OPEN when no admission record exists — and at
the FIRST build `collectEmitters` may not have run yet on a cold scene. That is
the correct direction (keep emitting) but it means the first palette can be
over-inclusive until the first `#refreshLightTree`; (c) is what corrects it.

**(c) The re-tint path — the TABLE changes, the ASSIGNMENT must not.**
The class→colour table is a `uniformArray(vec4)` (`gatherProbes.js`, `palette`
/ `palU`, written by `setPalette`), so **re-tinting is a uniform write: no
re-voxelize, no soup rebuild, no recompile.** The class ASSIGNMENT is not — it
is baked into the worker's `triPal` (`triangleSoup.js:229`, `pal: (p.pal ??
PAL_NONE) & 255`) and stamped into each voxel's `pal` byte
(`windowVoxelize.js`). So:

1. **Make the bucket key value-independent for emitters.** `gi2System.js:155`
   keys on the emissive VALUE (`e > 1e-4`), so a lamp that resolves 0 at build
   and 3.3 later CHANGES CLASS and needs a re-voxelize. Key instead on a static
   fact: `emissivePending` — a new third field on `resolveMaterialSurface`'s
   return, true where `emissiveTexture && !emissiveTexAvg`
   (`voxelizeOnce.js:288` already computes exactly this) — OR'd with
   `e > 1e-4`. Assignment is then stable from the first build.
2. Stash the palette input on the system: `this._gi2PaletteInputs = { keys,
   placementEntryKeys }` at `gi2System.js:500`, exposed through the returned
   object.
3. Add `#retintGi2Palette()` — re-resolve, recompute per-class means with the
   SAME keys, `gi2.gather.setPalette(next)`. Call it from two places:
   * `GISystem.js:3919`, the `--this._texAvgCount === 0 &&
     pendingTextureAverages.size === 0` branch (the line that already promises
     *"the palette re-tints on the next scan"*);
   * `#checkFingerprint`'s content path, `:15221`, next to
     `this.#syncSlots(entries)` — the old path's `atlas.setSlotSurface`
     equivalent, so live material edits and seat/admission flips re-tint
     without a rebuild.
4. ⚠ `soupKey` (`:16155`) has NO material term, so a rebuild that changed only
   materials reuses `store.soup` and its OLD `triPal`. That is CORRECT under
   (c.1) and MUST STAY correct — if anyone later makes the class key depend on a
   value that can change, the soup key has to gain that term or the palette
   silently desynchronises from the voxels.
5. ⚠ Stage 3.6 raises `history` 4 → 32, so alpha settles at `1/32`: a re-tint is
   ~32 frames from fully visible. Expect the gate's A/B to need a longer settle
   than the current `SETTLE=8000`.

**(d) Class count.** `PAL_ENTRIES` 16 → 64 in `gatherProbes.js` (it is exported
and `GI2_PAL_CLASSES = PAL_ENTRIES - 1` follows); replace `gi2System.js:143`'s
lattice+count-rank with weighted median-cut ranked by an AREA proxy
(placement count × the placement's world bounding-box area — available at
build from `geometry.boundingBox` and the matrix, no soup needed) and reserve
classes 56-62 for admitted emitters so a 1-placement lamp cannot be outvoted by
a 400-placement wall. Add a second `uniformArray(vec4)` for emissive RGB and
change `shadeHit`'s `.add(vec3(pal.w))` to the RGB read. Publish
`palEmissiveClasses` next to `palClasses` in `profile.gi2`
(`src/editor/api/ops/profile.js:695`) — the receipt this whole section exists
because nobody had.

### O.6 Gate

1. `[gi2] soup requested:` on Bistro reads **~1500 static placements, not 768**
   (O.5(a)), and `[gi2] soup … palette N of 63 classes` reports N > 7.
2. `node scripts/run-gi2-lighttree-decide.mjs` on Bistro, with the subject
   picker narrowed to **ADMITTED** out-of-slot candidates
   (`outs = cands.filter(c => !seated.has(c.mesh) && sys._emitterAdmittedMeshes?.has(c.mesh))`):
   * `palette: 64 classes, N with emission` with **N ≥ 1**, and the subject
     lamp's own class among them;
   * the receiver crop 1.2 m below that lamp **drops ≥ 10 %** when only that
     class's `w` is zeroed, and is reversible within 25 % (the harness's own
     existing check);
   * **and the negative half**: assert the class of a lamp reported CULLED by
     `[gi] emitter delivery: 13 placement(s) CULLED…` has `e == 0`, and that
     each of the 4 seated meshes' class has `e == 0` (double-count guard).
3. The Level's `run-gi2-lighttree-decide` is UNCHANGED: `emissive-at-hits`
   still carries ~29 % ± noise, and `profile.gi2.palClasses` does not fall.
4. `test:gi2-lightshadow`, `probe:gi2-voxelize`, `test:gi-emitter-tsl`,
   `test:mcp-coverage` unchanged. ⚠ 4.0's warning stands: do NOT run GPU
   batteries in parallel.

---

## P. STAGE 3.7 SPEC — THE CACHE CONVERGES, RAYS GO WHERE NEEDED (from the user's 08-27 screenshots)

**Symptoms (user's eyes, Bistro):** (1) "very dirty" — a spatially FIXED,
temporally STABLE blotch pattern 0.3-1 m in world size on the shaded façade,
near-black chairs and wall panels under a bright blue sky; (2) "very noisy on
movement". The 3.6 receipts were green because they measure temporal noise
and 5-px spatial noise; neither sees a stable 1 m blotch.

**Mechanisms:**
- P.1 **The cache is one-shot.** A voxel face is shaded ONCE on first hit
  (`shadeHit`, α=1, a 2×2-stratified sun/NEE estimate) and never again —
  `relightBricks` (K.6/K.7) was never implemented. Every bounce path reads a
  permanently baked 4-sample error; the probe filter smears per-voxel errors
  into blobs. This is the dirt.
- P.2 **No sky irradiance at hits.** `shadeHit` = albedo × (sun × DDA shadow
  + slot NEE + neighbour irradiance) + emissive. Outdoors the dominant
  incident light on a shaded surface IS the sky; a hit voxel's outgoing
  radiance omits it, so everything seen by bounce (awning undersides, chairs,
  recesses, the whole shade side) is starved. The old lattice carried sky in
  every bin.
- P.3 **Fresh probes start from zero with 16 of 64 directions.** Camera
  motion re-places tiles on new world positions; those probes show a 1-frame
  16-ray estimate until history builds. With a converged cache the variance
  is direction-sampling only (Cornell: 50 % in 1 frame); with a dirty cache
  it is the dirt sampled at random.
- P.4 The moved-lamp lag from 3.6 (H trades variance for lag) is the same
  allocation problem: change needs rays, not forgetting.

**The unit (gatherProbes.js + radianceCache.js; fixed per-frame budgets, no knobs):**
1. **Cache accumulation.** Every window hit may contribute a shade sample:
   with probability `p_shade` (tier: 1/4 desktop, 1/8 phone) the hit is
   re-shaded (sun shadow ray + slot NEE + sky ray, see 2) and EMA'd into the
   face slot with `α = 1/min(n+1, 16)` (a per-slot sample count `n` in the
   slot's spare bits — RGBE has none: widen the slot to 2 u32 (RGBE + n·2^24
   | flags) or keep a parallel u8 count buffer; say which, budget it). The
   first shade stays α=1. Receipt: cache σ/mean over the named faces (3.6's
   receipt) AND a NEW spatial receipt: variance of the cache across the 64
   voxels of one flat-wall brick after 300 frames (< 3 %), on Cornell and on
   a Bistro façade brick (pick by world coordinate).
2. **Sky at hits.** Each shade sample traces ONE cosine-weighted ray from the
   hit (biased by the origin-escape rule) into the window: miss → the scene
   sky radiance along that direction (the same `sky` node the probes use, ×
   the S1 intensity); hit → the cached radiance of what it hit (one indirect
   bounce for free). Accumulated by (1), this converges to sky irradiance ×
   visibility. Receipt: Cornell's b4 parity on the wall crops must not move
   > 3 % (the Cornell sky is black); a new "open box" arm (the Cornell room
   with the ceiling removed under a constant sky) where the CPU reference
   with sky must be matched within 15 % on the floor and the shaded wall.
3. **Need-driven ray allocation.** Per frame, per probe, `rays_i` ∝ need:
   fresh (n=0) → all 64 directions this frame; flagged by the variance test →
   32; mature → 8 (desktop) / 4 (phone); total clamped to the tier budget by
   scaling the mature share first. Implement as a per-probe ray count in
   probeMeta + a prefix-sum dispatch (or a fixed 64-thread block per probe
   that early-outs — measure both; the block form needs no prefix pass).
   Receipt: temporal p95 DURING a 90° orbit over 60 frames on Bistro
   (the 3.3 paired instrument) — target ≤ 3 %; the moved-panel reconvergence
   from 3.6 → ≥ 80 % at 30 frames.
4. **Neighbour prior.** A fresh probe initialises its SH from the 3×3
   neighbours' filtered SH (plane/normal-weighted; skip if none valid) with
   n=1 so its own rays take over immediately. Receipt: first-frame irradiance
   error of freshly placed probes vs their converged value (a harness arm
   that hides then reveals a probe row) — median < 25 %.
5. **The "dirty" receipt** (add to the boot probe): on Bistro, from the
   user's three camera poses (store them in the probe: façade wide, doors
   close-up, street overview — read the poses from the screenshots' gizmo /
   ask the operator for `viewport_getCamera` values), the spatial variance of
   the irradiance texture at a 1 m WORLD scale (box-blur radius = 1 m
   projected, minus 4 m) over the façade region ÷ mean — report before/after;
   target < 5 %. And the façade's mean irradiance vs the sunlit pavement's:
   a shaded wall under a clear sky should read 15-30 % of the sunlit ground,
   not < 5 %.

Cost ceiling: the chain stays ≤ 4 ms at 1650×970 ultra (3.6: 3.21); the
shade-sample budget is what bends. Gates: all 3.6 gates + the receipts above
+ `test:gi-moved-lamp` (+RED) + `test:gi-sunleak`.

---

## Q. STAGE 3.9 SPEC — FACE ATTRIBUTION BY DOMINANT NORMAL (from 3.8's diagnosis)

**Mechanism (measured, 3.8):** the voxelizer sets face bit(±a) when |n.a| >
1e-3, so 95 % of Bistro's façade voxels carry ALL SIX bits; the DDA files a
hit under the ENTRY face; a grazing ray therefore "hits" a wall through ±Y,
`faceSamplePoint` for that slot sits inside the wall column, `ORIGIN_ESCAPE`
pushes the shade point out into open sun → that slot stores 78-87× the true
wall radiance; half the words of a façade slab. Cornell hides it (axis-aligned
walls). A fix inside `traceWindow` costs 15 ms (shared by every ray class).

**Design:**
1. **Blocking and attribution are two different questions.** Keep the
   permissive bits for BLOCKING (0/10 000 leaks) — but decide WHICH slot a hit
   reads/writes by the voxel's DOMINANT NORMAL, not by the entry face. Store
   the dominant axis in the face byte's spare bits 6-7 (00 x, 01 y, 10 z; the
   sign = the side of the pair whose outward neighbour is empty, else the
   entry side); the two-sided/dyn-mirror flags move to `brickTab` or are
   dropped (verify who reads bit 6/7 today). The voxelizer computes it as the
   area-weighted |n| argmax over the triangles it SATs into the voxel
   (`atomicMax` on a packed (weight, axis) word in the pal scratch, packed by
   `finishBricks`) — no new buffer.
2. **Shade point = the outward face plane along the dominant normal** (the
   centre of that face, pushed by the bias along the dominant normal), so
   the sky/sun/NEE rays start on the surface's real side; the origin escape
   walks only along the dominant normal.
3. **Inject** files under the same dominant face (gbuffer normal → nearest
   axis; assert agreement with the voxel's stored axis and count mismatches).
4. **Reads**: a probe ray hitting via any entry face reads the dominant-face
   slot (one read, same cost); the 6-slot layout stays (a two-sided wall's
   two dominant faces are ±a of one axis).

**The instrument first — a ROTATED Cornell arm** in `gi2-gather.html`: the
same room rotated 20° about Y (and a second arm 20° about X for floors),
CPU reference = the same path tracer on the rotated analytic scene. Gate:
the rotated arms' crops must sit in the SAME bracket as the axis-aligned
room (8/8 bracketed, |Δ| ≤ 5 % vs the unrotated ratios), and the façade-
brick spread on it (§3.8 SPLIT line) < 20 % with BURIED ≈ 0 words. Then
Bistro: the §3.8 SPLIT's BURIED share → ~0 and the three-pose dirt metric
(with the 3.8 blindness guard) before/after, 3 runs each, medians.

Cost ceiling unchanged (chain ≤ 4 ms; `traceWindow` untouched in cost —
the attribution read is one extra byte fetch at the hit). Gates: all 3.6/
3.7 + leak tests (0/10 000, control 100 %) + moved-lamp PASS/RED + sunleak.

---

## R. STAGE 4.3b SPEC — BOOT AS THE USER MEASURES IT (08-27 evening)

**The user's number:** 31 s from opening the Bistro scene to GI appearing.
**Ours:** 3.4 s — measured from `[gi] scene assets ready`, the moment the OLD
asset gate releases the build. Live editor counters split the 31 s as:
scene open → GI build start **~24 s** (asset load incl. the KTX2 transcode
tail, merging settling, `#readyToRebuild`'s 250 ms-stable gate), then build →
soup 1.1 s → occupancy 4.3 s → first light **7.4 s** (harness 3.4 s: the
editor's material wave + attached sessions contend). The plan's Stage 4.3
gate is re-anchored: **≤ 3 s from SCENE OPEN on the Level; Bistro ≤ (time to
geometry ready) + 3 s**, printed as a stage table from scene open.

**Mechanisms to remove (none is asset loading itself):**
1. **GI2 waits for textures it does not need.** `#readyToRebuild` (GISystem,
   grep) waits for `textureLoadsInFlight()` = every KTX2 transcode, and for
   `merging.settling`. GI2 needs GEOMETRY (positions/index per geometry +
   placements) and material IDENTITY for the palette; texture averages land
   later through `#retintGi2Palette` (4.0b) — already designed for exactly
   this. Under GI2_PATH: build on geometry-ready (models loaded, meshes
   present), not texture-ready; keep the texture gate for the OLD path.
2. **Merging restarts GI2.** The soup is keyed on placements; static merging
   replaces meshes with proxies after boot → a new placement set → a second
   soup build (0.9-1.4 s + a 20-35 ms stall) and re-voxelization. The soup
   must be built from the SOURCE meshes (the ones merging consumes — read
   `merging.js`'s member list / `shadowMerge`'s member handling; GI2's own
   placement enumeration from 4.0b can take `mesh.userData.__mergeSource` or
   whatever marks a merge member) and must IGNORE merge proxies, so a merge
   rebuild is a no-op for the window. Receipt: `soupBuilds` per scene open = 1
   with merging on.
3. **Contention in the live editor** (7.4 vs 3.4 s): the voxelizer's serial
   binPairs (4.1b) is the occupancy half; the gather kernels are already
   non-deferrable (4.3a). After 4.1b, re-measure in the EDITOR, not the
   harness: add `firstLightFromSceneOpenMs` to `profile.gi2` (anchor =
   `scene_open` op / the editor's scene-load start).
4. **The instrument**: `run-gi2-boot-probe` reports from SCENE OPEN (the
   tauri shim's project-open timestamp), with stages: editor ready, geometry
   ready, textures ready, merging settled, GI build start, soup, occupancy per
   level, first light. The harness must stop quoting "after assets ready" as
   the headline.

Gate (PLAN Stage 4.3, re-anchored): Level first light ≤ 3 s from scene open
(2 boots); Bistro first light ≤ geometry-ready + 3 s, and GI must not be the
last thing to appear after textures land; `soupBuilds` = 1 per scene open;
no regression of the battery.

---

## S. STAGE 3.11 SPEC — CONTACT SCALE: black blobs at sub-voxel geometry (user screenshot 5, 08-27 23:24)

**Symptom:** after 3.9 the 1 m blotches are gone; what remains are BLACK BLOBS
at geometry junctions — door panels and frame recesses, under the planter,
along the lamp cable — plus "flatter, less GI overall".

**Mechanism (to verify with a receipt, then fix):** a probe on a surface finer
than the 25 cm voxel (a door panel inside a frame, the pot's foot) shoots
sideways rays that hit the CONSERVATIVELY DILATED voxels of the adjacent
frame/wall/pot — the window says "occluded at 0-2 cells" where the true
surface is 5 cm away and the hemisphere is really open. 3.3 restricted the
screen (HZB) segment to rays whose window hit is < 4 cells and takes its
answer only if it AGREES within a cell — so a dilated near-hit wins even when
the depth buffer can see the space is clear. Lumen never traces its coarse
structure in the first metres for this reason (screen trace + fine mesh
SDFs); Brixelizer biases by cascade.

**The unit (gatherProbes.js):**
1. **Authority in the contact band** (hits with t < `CONTACT_CELLS` = 2 · v_l):
   if the screen segment could see the ray's path (start and end on-screen,
   depth valid) and says CLEAR up to the window's hit distance, the ray
   continues past the window hit (re-enter `traceWindow` from t_hit + 1 cell)
   — the screen is the fine geometry there. If the screen cannot see it
   (off-screen / behind), the near hit counts with a distance weight
   `w = smoothstep(0, CONTACT_CELLS, t)` on its OCCLUSION (the returned
   radiance is blended with the continuation ray's) — a half-occluded
   contact, not a wall.
2. **Instrument — a Cornell "trim" arm** in the gather harness: the analytic
   room with sub-voxel features — a 5 cm ledge along one wall at 1.2 m, a
   door frame (10 cm × 5 cm recess) and a 30 cm pot on the floor — voxelized
   by the analytic filler with the real rule (conservative), CPU reference =
   the path tracer on the analytic trim scene. Crops: the panel INSIDE the
   frame, the wall 10 cm above the ledge, the floor 5 cm from the pot. Gate:
   each crop within the same bracket as the flat crops (today they are the
   black blobs: report their ratio on HEAD first — expect 0.2-0.5 of b4).
3. **Directionality receipt on Bistro** ("flatter"): façade-vs-sunlit-
   pavement ratio (3.7's, currently 61-78 %) and a NEW wall-vs-recess
   contrast (the door panel vs the flat wall beside it, each a 32-px crop
   from the user's doors-close pose): after 3.9 the buried-slot over-light is
   gone (78× energy removed), so "less GI" is partly CORRECT energy; the
   receipt says whether the recess is now too dark (< 0.5 of the wall = the
   blob) or the wall too flat. Report before/after.
4. Cost: the continuation ray is only taken in the contact band (measure the
   % of rays) — chain stays ≤ 4 ms.

Gates: the trim-arm crops in bracket; flat Cornell 8/8 unchanged; leaks
0/10 000 (the continuation must not pass a real wall — a wall is ≥ 2 cells
of dilation only for dust; test the 5 cm wall arm explicitly); all 3.9/3.10
gates; Bistro doors-close contrast before/after (single run, quoted as such).

---

## T. THE DETERMINISM CONTRACT (user rule, 08-27 night — supersedes §L.2/L.3's sampling and 3.6's hysteresis)

"There must be no noise at all — that was the initial idea of radiance
cascades." Noiseless BY CONSTRUCTION: every screen probe traces ALL 64 oct
directions every frame at deterministic texel centres (no subset, no in-texel
jitter, no per-probe hash, no hysteresis); the oct map is REPLACED each frame
(a complete evaluation, like an RC cascade); the resolve reads no previous-
frame image; the only temporal state is the world radiance cache's
convergence, whose shade sampling is a fixed pattern indexed by the slot's
sample count. Budget is held by probe SPACING per tier (16 px at ultra/high ≈
6.3k probes × 64 = 406k rays/frame; 24-32 px phone), never by rays per probe.
Receipts: temporal p95 at rest ≈ 0 % (byte-identical frames apart from cache
convergence); orbit temporal p95 ≤ 2 % (reinterpolation only); a moved panel
responds within 1-2 frames; no previous-frame texture bound on the image
path (asserted). The 3.10 temporal denoiser was withdrawn on this rule.

---

## U. STAGE 3.13 SPEC — WORLD-ANCHORED PROBES (RC's cascade 0 inside the window)

**Why:** 3.11/3.12 measured the last motion residual: screen probes WALK with
the camera, so each frame reads the world cache's (voxel-quantized) light at
a slightly different world point; an EMA shrinks the amplitude (dp50 −90 %)
but cannot remove the sign flips (~17 %) because the input itself changes.
Radiance cascades are noiseless under motion because their probes are
WORLD-anchored: the interpolation weights change smoothly, the probes do not.

**Design (deterministic, window-bounded, fixed budget):**
1. A world-space probe lattice L_p that follows the camera TOROIDALLY like
   the window (K.1): spacing s_p = 0.5 m (ultra/high) / 1 m (phone) over a
   16-24 m cube = 32³-48³ candidate cells; only cells whose voxel column is
   near a surface (occ within ±1 cell, from the window's L0/L1) hold a live
   probe — Bistro-scale ≈ 6-10k live probes, the same order as today's
   screen probes. Probe position = the cell centre pushed out of geometry by
   the origin-escape rule (deterministic); a probe carries the face it
   represents (dominant normal from 3.9's bits) so a thin wall gets two.
2. Each live probe traces its COMPLETE fixed direction set (64, texel
   centres) every N frames by a deterministic round-robin over cells (e.g.
   1/4 of probes per frame → the 406k-ray budget), hits read the cache /
   NEE / sky exactly as screen probes do; the oct map is REPLACED on update
   and smoothed with a fixed α between complete updates (§T allows it).
3. Screen resolve: per pixel, the 8 lattice probes around the surface point,
   weighted trilinear × normal agreement × visibility (the window's
   occupancy between pixel and probe — one short DDA per corner, or the
   probe's own hit-distance map as in DDGI's Chebyshev test, deterministic),
   evaluate SH2 at the pixel normal. No screen probes on the diffuse path
   (keep the HZB contact term for the first cells and GTAO); glossy stays
   on the window trace from the pixel.
4. Motion: camera motion changes only the weights (smooth); a scroll of the
   lattice re-keys the entering slab of probes (fresh probes get a full
   trace on their first update — bounded by the round-robin budget, so
   light "arrives" over ≤ N frames, never grain).
5. Receipts: reprojected sign flips during the 45° orbit ≈ 0 % (the walking-
   anchor term is gone by construction — this is the number 3.12 could not
   reach); at rest unchanged; moved panel monotone; Cornell bracket ≥ 7/8;
   leaks 0/10 000; chain ≤ 4 ms (the probe update is the same ray budget;
   the resolve reads 8 probes instead of 4).
6. Memory: 10k probes × (64 texels RGBA16 + SH2 + meta) ≈ 6 MB desktop.

This is the RC contract in full: world-anchored, complete, interpolated. It
replaces the screen-probe diffuse path once its receipts beat 3.12's; the
screen-probe code stays until then (one build constant).

---

## V. STAGE 3.14 — THE PROBE CASCADES (RC's answer to 3.13's horizon)

**Why:** 3.13's world-anchored lattice won almost every receipt it was gated on
and shipped OFF for one structural reason: it is ONE 16 m cube, and on a 100 m
street most visible surfaces are beyond its ±8 m horizon. Its answer there was a
boundary CLAMP, which is not black but is also not light — what it extrapolates
is the ambient measured at the edge of the near room. The doors receipt named
the cost: 6.3 % of the picked dark pixels had NO live corner, pixel distance p95
15 m, thin-feature ratio 64.5 % against a 70 % gate.

### V.1 What was built

| | c0 | c1 | c2 |
|---|---|---|---|
| cells | 32³ | 32³ | 32³ |
| spacing | 0.5 m | 2 m | 8 m |
| extent | 16 m | 64 m | 256 m (128 m on `high` — see below) |
| liveness level | finest containing (`cellOfWorld`) | L2 | L4 (`ultra`) / L3 (`high`) |
| trace slots / frame | 4296 | 1232 | 616 |
| share of the 6144-slot budget | 69.9 % | 20.1 % | 10.0 % |

Phone/medium tiers get TWO cascades (16³ at 1 m and 4 m → 16 / 64 m), because a
three-level window has no occupancy to read past 128 m.

Five things carry the design, and each is a decision:

1. **ONE set of kernels, `NC` lattices.** The cascade is a bit of
   `instanceIndex`, not a JS loop: `allocPass` dispatches `NC × 32³`, the
   compaction runs one prefix-sum thread per cascade, and `tracePass`'s slot
   index falls into a compile-time `[SLOT_BASE, +SLOTS)` partition. Calling
   `createWorldProbes` three times would have inlined `shadeHit` three times —
   ~25 kB of WGSL each and, measured at Stage 3.5, 2.5 s of pipeline compile.
2. **The resolve runs ONE eight-corner block inside a TSL `Loop` over the
   cascades**, with every per-cascade constant arriving through `cascConst`
   (five `select` chains, evaluated once per cascade). Receipt: `resolveHalf`
   is **161.3 kB** of WGSL with three cascades against **160.0 kB** with one —
   +0.8 %, against the +200 % an unrolled loop would have cost, in the one
   currency (boot-time compile) 3.14 is gated on.
3. **The hand-off is a composite, not a choice.** Each cascade answers with a
   COVERAGE — `Σ tri·live`, exactly 1 when all eight corners exist, 0 past the
   lattice edge — times a BAND (1 inside the inner 90 %, ramping to 0 at the
   outer face). Finest first, alpha-composited: c0 spends what it has, c1 spends
   the remainder, c2 (which clamps, so it always answers) takes the rest.
   Nothing branches on a cascade index; the weights are continuous in the
   pixel's position, so walking out of the 16 m cube produces no edge.
4. **⭐⭐ COVERAGE IS NOT VISIBILITY, AND THE 5 cm PARTITION MEASURED IT.** The
   first cut made the hand-off `Σ tri·live·vis`, reading "a cascade that cannot
   SEE the point cannot answer for it". That is backwards: an occluded probe IS
   the answer — *no light arrives from there* — and folding its refusal into the
   hand-off invited the 2 m cascade, whose probes straddle a 5 cm wall, to
   answer instead. **Thin-wall interior went 0.03 % → 0.56 % on that one term,
   and back to 0.05 % (the control's own floor) when `vis` came out of `cov`.**
   The corollary: a cascade that covers a point SPENDS its claim even when its
   weights sum to zero, or the dark side of a wall is handed to the 8 m cascade.
5. **The two-tier fallback needed a third key.** 3.13 triggered it on
   `wsum < 1e-5`, which conflated "no probe represents this surface" (a 3 cm
   cable in a pocket of face-rejecting probes — the thin-feature case the tier
   exists for) with "every probe says dark". Under one lattice both left `wsum`
   at zero and the trigger was right by accident; under cascades a covered pixel
   always spends its claim, so the trigger is now `admAny` — the largest
   face-admissible coverage any cascade found.

`globalThis.__gi2Cascades = 1` collapses the lattice to one cascade with the
clamp on it — 3.13 exactly, out of 3.14's binary, on one shader cache. Every
comparison below is that arm, not a previous commit.

### V.2 THE HEAP AND THE FIRST-LIGHT REGRESSIONS DID NOT REPRODUCE

3.13 reported Bistro JS heap +297 MB and Level first light +585 ms against the
screen path. Neither survives a same-session A/B, and the reason is that both
statistics have a run-to-run spread wider than the effect they were reporting.
Two boots of each arm, one machine, one afternoon, `NOISE=0 DIRTY=0`:

| Bistro | 3.12 screen | 3.13 (`__gi2Cascades=1`) | 3.14 cascades |
|---|---|---|---|
| JS heap (MB) | 1975 / 1918 | 1647 | 1723 / 2115 |
| first light from scene open (ms) | 11144 / 11686 | 11308 | 11799 / 10872 |
| GI GPU total (ms) | 1.454 / 1.918 | 2.125 | 2.624 / 1.722 |

| Level | 3.12 screen | 3.13 | 3.14 |
|---|---|---|---|
| JS heap (MB) | 374 / 410 | 421 | 460 / 356 |
| first light from scene open (ms) | 4967 / 5478 | 5140 | 5022 / 4871 |
| GI GPU total (ms) | 1.258 / 1.180 | 0.977 | 1.309 / 1.670 |

⭐⭐ **`performance.memory.usedJSHeapSize` on Bistro moves ±200 MB between boots
of the SAME binary, and Level first light ±500 ms.** 3.13's +297 and +585 are
both inside that. This is [[probe-blind-statistics]] in its other direction: not
"can the instrument see its subject" but "is the effect larger than the
instrument's own spread". A single boot per arm cannot answer either question.

**What IS nameable, and was fixed anyway:** `instancedArray` keeps the full CPU
typed array alive for the life of the attribute (§I.1 — three uploads it once,
`Buffer._buffer` captured it at first bind, `info.memoryMap` pins the attribute
forever). One lattice was 22 MB of that; three cascades are **66 MB**. All four
lattice buffers are GPU-only — every reader is a kernel, and `readLive` reads a
readback copy, never `attr.array` — so `gi2System` now drains them through
`detachCpuMirror` (an `ArrayBuffer.transfer(0)`, a real free) from `passes()`.

⚠ **From `passes()`, not from `notePassesRan()`,** which is where it first went:
that call only fires when the PRE-GBUFFER batch lands, so on a boot where the
voxelizer's pipelines keep the batch deferred it never fires and the queue would
stay full for the session — silently. Same shape as the shadow-freeze bug: a
caller-position dependency. `passes()` runs every frame and the real precondition
("has this buffer been uploaded?") is checked inside `detachCpuMirror`.

Receipt, from the Bistro motion run's own console census:
`[gi2] detached 4 lattice CPU mirror(s) — 66.8 MB of JS heap the GPU buffers do
not need`. One line, once, when the queue empties — §19 4.1 measured a per-frame
`console.log` on a CDP-attached page at 21 ms of frame time.

**And the first-light suspect was refuted with its own receipt.** The boot's
compile census: the world path sums **14.7 s over 39 pipelines** (Level) against
the screen path's **15.8 s over 43** — the world path compiles LESS. Its two
biggest are `gi2.worldTrace` 1.1 s (50 kB WGSL) and `gi2.resolveHalf` 0.8 s
(162 kB); the screen path's biggest is `gi2.probeTrace` 1.0 s (62 kB). The
cascades add **1.3 kB** to `resolveHalf` and no measurable compile time, because
of the `Loop`.

### V.3 THE FAR-FIELD RECEIPT — a new instrument, because nothing could see it

3.13's horizon is a claim about surfaces forty metres away, and **not one
existing instrument samples one.** The Cornell rig is a 5 m box entirely inside
cascade 0. The doors pose stands 2 m from a wall. The motion probe measures
FLIPS, and a stable wrong answer flips as little as a stable right one. §3.7's
dirt receipt band-passes one pose at one spatial scale. So `probe:gi2-farfield`
(`scripts/run-gi2-farfield-probe.mjs`) was written for it:

* the **street-overview** pose — the third of the boot probe's three DERIVED
  Bistro poses (22 m back along the open street, found by a 24-ray horizontal
  ring through the live window, at 4 m up looking down it);
* the **far façades**: dump samples ≥ 30 m from the camera with `|n.y| ≤ 0.5`.
  Vertical surfaces, not the road — a road is a floor and a floor's irradiance
  is dominated by the sky, which every path gets right. A wall forty metres out
  is lit by the street's bounce, and that is precisely what a lattice with a
  horizon cannot know;
* ⭐⭐ the comparison is **per pixel, then summarised** — never two population
  medians. A far façade lit by a boundary CLAMP is UNIFORM, and a uniform field
  can have the right mean. The arms are two boots (the path is a build-time
  constant), so `OUT=` writes this boot's pixel indices, world depths and
  irradiances and `REF=` reads them back, pins the POSE from that file (a
  derived pose landed 11 cm apart on two boots of the doors probe — at 22 m
  that is a different wall), and reports the distribution of
  `E_this / E_reference` at the same index and depth.

**The result, Bistro street-overview, 3417 far-façade pixels, three arms, one
pinned pose (eye [20.55, 4.36, −0.64] → [0.55, 3.36, −0.64]):**

| irradiance luminance | 3.12 screen | 3.13 (one lattice + clamp) | 3.14 cascades |
|---|---|---|---|
| p05 / p50 / p95 | 0.047 / 1.173 / 5.082 | **0.000 / 0.000 / 0.000** | 0.452 / 2.671 / 7.723 |
| 30–40 m (n 2617) p50 | 1.080 | 0.000 | 2.743 |
| 40–55 m (n 770) p50 | 1.287 | 0.000 | 2.595 |
| 55–75 m (n 30) p50 | 4.208 | 0.000 | 0.000 |
| ratio to screen, p50 | — | **0.000** | 1.671 |
| within ±15 % of screen | — | 0.0 % | 18.9 % |

⛔⛔ **3.13's BOUNDARY CLAMP IS BLACK, NOT "THE AMBIENT AT THE EDGE" — and its
own commit message says otherwise.** Every far façade on the street-overview
pose reads exactly 0.0000 under one lattice. The clamp's premise was that a
pixel outside reads its nearest boundary probe, "a continuous extrapolation of
the field rather than a hole in it"; what it actually reads is a boundary cell
that holds NO PROBE, because the cells at ±8 m in the direction of an open
street are air, and an air cell is dead by the liveness rule. `live = 0` on all
eight corners → `cov = 0` → nothing claimed → black. The doors receipt saw the
edge of this (6.3 % of the picked dark pixels had no live corner) and read it as
a fringe; on a wide shot it is the entire far field. **A clamp into a sparse
lattice is not an extrapolation — it is the same hole, relocated.**

▶ **The cascades light the far field: 0.000 → 2.671, from nothing to more than
the screen path.** That is the structural blocker removed, and it is the one
thing 3.14 was built to do.

▶ **OPEN, AND THE FLIP'S BLOCKER: they light it 1.67× too bright.** The gate is
±15 % of the screen path and the measurement is p50 1.671, 18.9 % of pixels
within 15 %. Two mechanisms are named and neither is refuted yet:
* **the surface bias is scaled by the SAMPLED cascade's spacing** — 0.3 × 2 m =
  60 cm at c1 and 0.3 × 8 m = 2.4 m at c2, so the pixel is sampled that far off
  its own wall, in the open, where far less of the sky is occluded. What the
  bias has to clear is the SURFACE, which is the window's voxel — not the
  cascade's spacing. It should be a fraction of the FINEST cascade's spacing on
  every cascade (15 cm, which is 3.13's own value and what won 3.13's receipts).
* **a coarse probe stands where its own escape put it** — up to 4 × its liveness
  voxel out of geometry, which is 3.5 m at c1 and 14 m at c2 — and a probe 14 m
  off a façade in an open street measures the street, not the façade.
* ⚠ And the deeper one, which is a DESIGN statement rather than a bug: at 30-55 m
  from the camera, cascade 0 cannot reach and c1 does ALL the work, including the
  near-surface detail that needs 0.5 m probes. A "pick the finest cascade that
  covers you" resolve is not RC's merge — RC has cascade N carry only its own
  ray INTERVAL, with the near intervals coming from finer cascades. That is a
  stage of its own, and this receipt is what would justify it.

▶ **AND THE 55-75 m BAND IS STILL BLACK (30 px, p50 0.000).** Cascade 2 reads
its liveness from L4 on `ultra`, and the world-path boots never print
`[gi2] first occupancy L4` while the screen-path boot prints it at 4140 ms —
so c2 is dead on Bistro and everything past c1's ±32 m has no cascade at all.
Whether L4 is genuinely unvoxelized or merely late is the next thing to
measure; either way c2 is not yet carrying the band it was built for.

### V.4 THE DOORS RECEIPT — the horizon hole is closed

Bistro doors pose, PINNED (eye [1.24, 2.07, −1.70] → [−0.57, 1.62, −0.84]), the
screen arm's own darkest-1 % population (1124 px) measured on all three arms —
a shared pick, so it is the same 1124 pixels every time.

| | 3.12 screen | 3.13 one lattice | 3.14 cascades |
|---|---|---|---|
| darkest-1 % ÷ wall, irradiance | 10.4 % | 57.4 % | **70.3 %** (gate ≥ 70) |
| darkest-1 % ÷ frame | 9.2 % | 55.4 % | 67.9 % |
| this arm's OWN worst 1 % ÷ own wall | — | 4.5 % | 44.2 % |
| its `irrP05` | 0.0139 | **0.0000** | 0.2011 |
| **NO live corner in ANY cascade** | — | **8.8 %** | **0 %** |

Live probes and round-robin period per cascade on Bistro (32768 candidate cells
each): **c0 8776 live / 4296 slots → every 3 frames · c1 7590 / 1232 → every 7 ·
c2 696 / 616 → every 2.** Of the eight corners at the picked pixels: c0 6.37
alive / 4.87 admissible, c1 7.75 / 6.85, c2 8 / 7.94 — the cascade that cannot
reach hands to one that can, per corner, exactly as designed.

The 8.8 % of dark pixels with no live corner — 3.13's named blocker — is **0 %**,
and 3.13's `irrP05 = 0.0000` (its darkest 5 % were literally black) becomes
0.2011. The 70 % gate is met at 70.3 %.

⛔⛔ **AND THE 70.3 % WAS THE BIAS BUG, NOT THE CASCADES — RE-MEASURED WITH THE
SHIPPED BIAS IT IS 33.9 %.** The picked pixels sit at p50 6.11 m / p95 16.71 m,
so most of them are past c0's ±8 m and read cascade 1, where the bias went
60 cm → 15 cm. A sample point 60 cm out of a 14 cm recess is not in the recess.

| doors, same 1124 pixels | 3.12 screen | 3.13 | 3.14 @ 0.3·s_c | 3.14 @ 0.3·s_0 (shipped) |
|---|---|---|---|---|
| darkest-1 % ÷ wall | 10.4 % | 57.4 % | 70.3 % | **33.9 %** |
| `irrP05` of the picked set | 0.0139 | **0.0000** | 0.2011 | **0.0550** |

⭐⭐ **THE TWO GATES ARE COUPLED THROUGH ONE CONSTANT AND IT CANNOT SATISFY
BOTH.** At 0.3·s_c the doors gate passes (70.3 %) and the far field is 1.67× too
bright with a black band past 55 m; at 0.3·s_0 the far field is honest and the
doors gate fails at 33.9 %. The same 60 cm was inflating both receipts in the
same direction — one of them called it a pass and the other called it a fault.
That coupling is the clearest evidence this stage has that **"pick the finest
cascade that covers you" is not RC's merge**: a single displacement constant
should not be able to trade a recess against a façade, and in a real interval
merge it could not, because the recess would be c0's ray interval and the façade
c1's.

⚠ AND THE 70 % GATE IS A MEAN, WHICH CANNOT SEE A BLACK TAIL. 3.13 reads 57.4 %
with `irrP05 = 0.0000` — its darkest 5 % are literally black and its mean is
lifted by the clamp. 3.14 at the shipped bias reads 33.9 % with `irrP05` 0.0550,
four times the screen path's floor and the first arm with no black tail at all.
When this gate is re-run it should be `irrP05 > 0` AND a mean, not a mean.

⚠ `c2 live 0/32768` on this boot against 696 on the one an hour earlier — cascade
2's liveness level (L4 on ultra) is populated late and intermittently, which is
the same open question §V.3's 55-75 m band raised.

**⭐⭐ AND THE BIAS WAS HALF OF IT — MEASURED, NOT ARGUED.** With the surface
bias put back to a fraction of the FINEST cascade's spacing (15 cm on every
cascade, which is 3.13's own value) rather than the sampled cascade's:

| far-field, 3.14 | bias = 0.3·s_c (60 cm at c1, 2.4 m at c2) | bias = 0.3·s_0 (15 cm everywhere) |
|---|---|---|
| 30–40 m p50 ratio | 1.750 | 1.681 |
| 40–55 m p50 ratio | 1.561 | 1.566 |
| **55–75 m p50 ratio** | **0.000 (black)** | **0.926** |
| p05 ratio | 0.190 | 0.532 |
| overall p50 ratio | 1.671 | 1.609 |

The black band at 55-75 m was the bias itself: at c2 it moved the sample point
**2.4 m off its own wall**, past the live cells around that wall and into air
whose eight corners are all dead. One term, one length in the wrong units, and
a whole distance band composited black. ⭐ **A length that has to clear a
SURFACE belongs in the surface's units, not in the sampler's** — the same
mistake shape as [[gi-colour-probe-method]]'s retracted world-unit constants,
inverted.

What the bias does NOT explain is the residual **1.6× at 30-55 m**, which is
cascade 1's own band. Two candidates remain unmeasured: a coarse probe's ESCAPE
(up to 4 × its liveness voxel = 3.5 m at c1) standing it off the façade in the
open street, and the plain fact that a 2 m probe lattice cannot resolve a
façade's own occlusion. ⚠ And the screen path is not ground truth here — on the
doors pose it is the arm that reads dark places at 10.4 % of the wall while the
world path reads 70.3 %, so "1.6× brighter than the screen path" may be the same
correction the thin-feature gate rewards. Neither reading is settled by this
receipt; a CPU path-traced reference at the street-overview pose is what would
settle it, and that is the instrument to build next.

### V.5 THE RECEIPT TABLE (3.12 / 3.13 / 3.14)

All three arms out of ONE binary and one shader cache: 3.12 is `WORLD_PROBES`
off, 3.13 is `__gi2Cascades = 1`, 3.14 is the shipped cascade set.
Cornell rig at 960×540 (`probe:gi2-gather`, high + ultra); Bistro at 1650×970.

| receipt | 3.12 screen | 3.13 one lattice | 3.14 cascades |
|---|---|---|---|
| Cornell bracketed, high / ultra | 8/8 | 8/8 | **8/8 / 8/8** |
| 5 cm-wall leak (control) | 0/10 000 (92.1 %) | 0/10 000 (92.1 %) | 0/10 000 (92.1 %) |
| thin-wall interior, worst | — | 0.04 % | 0.05 % (control 0.05 %) |
| at rest: still % / sign flips / temporal p95 | — | 100 / 0 / 0.001 % | 100 / 0 / 0.001 % |
| orbit Δp50 / Δp95 / moved % | 0.17 / 3.87 / 63.4 (3.13's log) | 0.02 / 0.12 / 5.3 | **0.02 / 0.10 / 4.9** |
| orbit sign-flip rate | — | 5.8 % | 6.3 % |
| panel move re-converges | 12 fr | 18 fr | 18 fr |
| chain @1650×970, high / ultra | — | 1.552 | **2.567 / 2.090** (budget 4) |
| `resolveHalf` WGSL | — | 160.0 kB | 161.3 kB |
| lattice bytes (GPU) | 0 (+21 MB screen probes) | 22.25 MB | **66.75 MB**, CPU mirrors detached |
| **Bistro doors: darkest-1 % ÷ wall** | **10.4 %** | 57.4 % | **33.9 %** (gate ≥ 70) |
| Bistro doors: `irrP05` of that set | 0.0139 | **0.0000** | **0.0550** |
| Bistro doors: no live corner anywhere | — | 8.8 % | **0 %** |
| **Bistro far field p50 ÷ screen** | 1.000 | **0.000 (black)** | **1.609** (gate ±15 %) |
| Bistro GI GPU (2 boots) | 1.454 / 1.918 | 2.125 | 2.624 / 1.722 |
| Bistro JS heap (2 boots) | 1975 / 1918 | 1647 | 1723 / 2115 |
| Bistro first light (2 boots) | 11144 / 11686 | 11308 | 11799 / 10872 |
| Level first light (2 boots) | 4967 / 5478 | 5140 | **5022 / 4871** |

Per-kernel at the Cornell rig, ultra (ms / WGSL): `worldAlloc` 0.019 / 29.2 kB ·
`worldCount` 0.005 · `worldScan` 0.006 · `worldFill` 0.030 · `worldTrace`
0.125 / 49.3 kB · `worldSh` 0.015 · `worldNee` 0.014 / 34.0 kB · `resolveHalf`
0.252 / 161.3 kB · `resolveUpsample` 0.072. The trace is ONE dispatch over all
three cascades' slots, so it cannot be split per cascade by timing; the split is
the slot budget (4296 / 1232 / 616) and the live counts.

Two gates read FAIL on both world arms and are **structurally blind, not
failing**: `reprojection at rest ≥ 99 %` reads 0/0 because nothing reprojects on
a path where nothing moves (the harness prints "THE CENSUS IS BLIND" itself),
and §3.9's `delta` gate fails identically on 3.13 (−23.28 %) and 3.14
(−23.76 %) — a rotated-room attribution result that predates this stage.

### V.6 BISTRO MOTION — the one place the cascades COST something

`probe:gi2-motion`, Bistro, same session, `__gi2Cascades` as the arm:

| reprojected sign flips | 3.12 (3.13's log) | 3.13 one lattice | 3.14 cascades |
|---|---|---|---|
| orbit | — | 25.2 % | **27.2 %** |
| dolly | 41.3 % | 17.2 % | **22.7 %** |
| whip | 47.6 % | 15.8 % | **18.8 %** |
| orbit MAX frame ms | — | 118.0 | 107.5 |
| voxelize chain GPU MAX, orbit / dolly | — | 4.09 / 3.65 | 4.35 / 4.70 |

▶ **OPEN — 3.14 flips MORE than 3.13 on all three arms (+2.0 / +5.5 / +3.0
points), and the mechanism is the scroll, not the estimator.** Two terms, both
introduced by having three lattices instead of one:

1. **The hand-off band is narrower than the origin step.** `stepLatticeOrigin`
   moves an origin in blocks of 4 cells; the band is `BAND · C` = 3.2 cells. So
   on the frame a lattice scrolls, a pixel inside the band can have its
   cascade split jump by more than the band's whole width — a pop, by
   construction. The band must be at least the step: `BAND ≥ blk/C = 0.125`, or
   the step must be halved (`blk = 2`, which re-keys half as much per scroll and
   twice as often). ⚠ Widening the band also imports more of c1's over-bright
   far field into the near field, so it must be measured against §V.3's ratio,
   not chosen.
2. **A re-keyed slab is dark for a whole round-robin period, and c1's is 7
   frames.** A scroll sets `ready = 0` on the entering cells; they contribute
   nothing until `shPass` has run for them. Under one lattice that was 3 frames
   (c0, 4296 slots against 8776 live); c1 holds 1232 slots against 7590 live.
   A fresh-first round-robin would fix it and would still satisfy §T — "which
   probes update this frame" would remain a pure function of the occupancy and
   the frame index — but it is a schedule change, not a constant.

The frame-time gates that FAIL (orbit MAX 107.5 ms, the voxelize chain over
3 ms) fail on BOTH world arms and on §19 4.1's own record: they are the
`binPairs` scroll burst, which this stage does not touch. 3.14's orbit MAX is
in fact 10 ms below 3.13's.

### V.7 THE FLIP VERDICT — `WORLD_PROBES` STAYS `false`

Two of the gates fail, and both are gates 3.14 itself created the instrument for.

**PASS** — Cornell 8/8 on high AND ultra · 5 cm leak 0/10 000 with its 92.1 %
control · thin-wall interior 0.05 % at the control's own floor · §T at rest
(100 % still, 0 sign flips, temporal p95 0.001 %) · orbit Δp50/Δp95/moved
0.02 / 0.10 / 4.9 % (3.13: 0.02 / 0.12 / 5.3) · panel move 18 frames · chain
2.567 / 2.090 ms against a 4 ms budget · JS heap indistinguishable from the
screen path (2-boot means 1919 vs 1947 MB) · Level first light 4947 ms mean
against the screen path's 5223 · **"no live corner anywhere" 0 % against 3.13's
8.8 %, and the picked dark set's `irrP05` 0.0550 against 3.13's 0.0000 — the
first arm on this pose with no black tail at all.**

**FAIL** — **the far-field ratio, p50 1.609 against a ±15 % gate.** The cascades
do what they were built to do: 3.13's far field is literally 0.000 and 3.14's is
lit. But they light it 1.6× brighter than the screen path at 30-55 m, which is
cascade 1's own band, and neither arm is a reference. ⚠ **This gate cannot be
closed by tuning — it needs a CPU path-traced reference at the street-overview
pose**, because "1.6× the screen path" is not the same claim as "1.6× the
truth", and on the doors pose the screen path is the arm that reads dark places
at 10.4 % of a wall while the world path reads 70.3 %.

**FAIL** — **the doors thin-feature ratio, 33.9 % against a ≥ 70 % gate** — and
the 70.3 % that looked like a pass was the bias bug (§V.4). The mean is BELOW
3.13's 57.4 % while the floor is above it (0.0550 vs 0.0000): 3.14 trades a
lifted mean for a lifted tail, which the gate as written cannot express.

**FAIL** — **Bistro motion flips are above 3.13's on all three arms** (§V.6),
from the scroll transient of three lattices rather than from the estimator.

⭐⭐ **AND THE TWO CONTENT GATES ARE THE SAME GATE.** One constant — the surface
bias — moves the doors ratio 33.9 ↔ 70.3 % and the far-field ratio 1.609 ↔ 1.671
(with a black band) in the SAME direction. A "finest cascade that covers you"
resolve gives one displacement constant authority over both a 14 cm recess and a
40 m façade; RC's interval merge does not, because those are different cascades'
ray intervals. That is the verdict's real content: not "the numbers missed",
but "this resolve cannot hold both ends at once".

▶ **NEXT, IN ORDER.** (1) A path-traced far-field reference — the gate above is
unanswerable without it and every tuning decision downstream inherits the
ambiguity. (2) The band/step relation and a fresh-first round-robin (§V.6),
which are the two named motion terms. (3) RC's actual merge — cascade N carries
only its own ray INTERVAL, with the near intervals coming from finer cascades —
which is the structural answer to a 2 m probe lattice lighting a façade, and
which this stage's "finest cascade that covers you" resolve is not.

### V.8 THE ENGINE GATES (shipping path, `WORLD_PROBES = false`)

`test:gi-sunleak` **PASS** — sealed interior worst leak 0.00000 against a 0.002
threshold, GI on and off identical at all four probes.
`test:gi-moved-lamp` **PASS** — the new spot gains 29.06 lum (gate > 12), the old
loses 29.05, separation 58.11.
`smoke:gi-gpu` **PASS** (exit 0) — gi2 transport 280 rays/frame over 35 probes,
probesValid 35/35, first light 274 ms, cache 15.08 MB / window 2.815 MB.
`run-gi-resize-probe` **ALL PASS** — **uncaptured device errors 0 / createBindGroup
throws 0** across every hop (the 0/0 the flip is gated on); a fast round trip
costs 0 pipelines and 0 shader modules; textures live and transport alive after
the last hop.

⚠ These four run the SHIPPING path, because the flip did not happen and none of
them has a pre-boot arm hatch. They say the tree is green, not that the world
path is: adding a `FLAGS` hatch to the three that lack one is a prerequisite for
the flip receipt these are supposed to be.

---

## W. STAGE 3.15 — RADIANCE CASCADES PROPER: INTERVAL-LIMITED PROBES AND THE PER-DIRECTION MERGE

**Why:** 3.14's verdict named its own successor. Three world-anchored cascades
each traced their COMPLETE 64-direction set TO THE HORIZON, and the resolve
picked "the finest cascade that covers you" — so three estimators answered the
same question from three different places and disagreed. The tell was a single
constant: the surface bias moved the doors thin-feature ratio (33.9 to 70.3 %)
and the far-field ratio (1.609 to 1.671) in the SAME direction. ⭐⭐ **A
displacement constant should not have authority over both a 14 cm recess and a
40 m façade, and in a real interval merge it cannot, because those are
different cascades' ray intervals.**

### W.1 THE INTERVALS AS BUILT

`t_i = r0·(β^i − 1)/(β − 1)`, β = 4, `r0 = R0_CELLS · s_0`; the last cascade
ends at the window's own horizon `RAY_MAX = 40 m`.

| tier | c0 | c1 | c2 |
|---|---|---|---|
| ultra / high (s = 0.5 / 2 / 8 m) | **[0, 4) m** | **[4, 20) m** | **[20, 40] m** |
| phone / medium (s = 1 / 4 m) | **[0, 8) m** | **[8, 40] m** | — |

Each direction stores radiance **and a TRANSMITTANCE BIT** — 1 if the ray
escaped its band, 0 if something stopped it. The bit cost nothing: `n` was
declared eight bits at 24 and then written `.min(63)`, so bits 30-31 have been
free since 3.13. (`nOf` now MASKS rather than shifts — a raw `w >> 24` would
have read `n + 64` on every transparent texel, and every `n > 0` test in the
file would have kept working while `n` itself became garbage.)

**β = 4 AND 64 DIRECTIONS, AND THE CONSEQUENCE STATED.** RC's usual branching is
spacing ×2 / interval ×4 / **directions ×4**, and the directions grow because
the interval outruns the spacing. This lattice grows spacing ×4 as well, so β = 4
makes interval and spacing grow at the SAME rate and the angular demand is
CONSTANT rather than compounding: 64 texels over the sphere is a 28.6° cone,
which at cascade `i`'s interval end subtends `0.5 · t_{i+1}` — 2 m at c0
(spacing 0.5), 10 m at c1 (spacing 2), 20 m at c2 (spacing 8). **The same ~2.4×
angular deficit at every cascade, not a growing one.** A 16×16 map on c1/c2
would close it exactly and would cost 4× their rays (+90 % of the total budget)
and 4× their `wpOct` (50 to 184 MB, past the portable envelope before the window
is counted). **NOT TAKEN.** Because the deficit is uniform it reads as one
global softness in the far field rather than as a cascade-boundary artefact —
which is the failure mode 3.14 actually had.

### W.2 ⭐⭐⭐ RC's RULE CANNOT BE COPIED VERBATIM INTO A CLIPMAP, AND THE CORRIDOR MEASURED IT

The textbook rule — cascade `i` traces `[t_i, t_{i+1})` — rests on an assumption
this lattice cannot meet: **that cascade 0 covers the whole domain.** Sannikov's
c0 is a grid over the entire scene, so `[0, t_1)` is always somebody's job. Here
the cascades are a CLIPMAP: c0 is 16 m of camera-centred lattice, c1 is 64 m,
c2 is 256 m. A surface fifty metres down a corridor has no c0 and no c1, and
therefore **nobody to carry its first twenty metres of light** — including the
emissive panel five metres from it.

⛔ **Measured, not argued: with the textbook rule the corridor's 50 m crops read
0.0000 against a path-traced 1.79.** The far field went BLACK, and 3.14's
over-bright 0.21 was the better answer. An interval that no cascade owns is
light silently dropped — exactly the gap `srcConfig.intervalBoundaries` was
written to make impossible one architecture ago.

**The rule as shipped:** cascade `i` CONTRIBUTES `[t_i, t_{i+1})` where cascade
`i−1`'s lattice contains its probe, and `[0, t_{i+1})` where it does not. The
lattices are camera-centred and each is 4× the last, so containment is monotone
in `i` — "c_{i−1} does not have me" means no finer cascade does. Nothing
double-counts, because a cascade's merge reads parent probes AT ITS OWN PROBE'S
POSITION, so any parent reached through the merge is by construction covered
from below. The one imprecision is a shell one cell thick at each lattice face,
where `bandAt` has already faded that cascade's weight to zero.

⭐ **And it closes the visibility hole for free.** A probe that traces from 0
records a first-hit distance from 0, so `octTapVisAt`'s Chebyshev test has real
near-field moments at exactly the probes a fall-through pixel reads. Under the
textbook rule c1's smallest storable distance was `t_1`, larger than any
pixel-to-probe distance it would ever be asked about, and its visibility term
was silently inert.

### W.3 THE MERGE PASS

`L_i(ω) = L_i^own(ω) + T_i^own(ω) · interp8(L_{i+1} at this probe, ω)`, and the
parent is already merged with ITS parent, so one pass per cascade composes the
whole chain in one frame. Four decisions:

1. **`NC−1` DISPATCHES, COARSEST FIRST — not one.** c0's merge READS c1's texels
   and WRITES c0's; folded into one dispatch that is a read-write hazard inside
   a dispatch, which is the one thing §T's byte-identical frames cannot survive.
   Separate dispatches are the barrier.
2. **IT MERGES IN PLACE, AND THE TRACE IS WHAT MAKES THAT SAFE.** `own` is read
   exactly once, by this pass, in the frame the trace wrote it, over the same
   round-robin batch. A probe's next update rewrites `own` from scratch. The
   lattice does not pay a second 50 MB to hold it; the cost is that a probe's
   merged map is as stale as its parent was at its own last update (at most one
   round-robin period).
3. **THE T BIT IS CLEARED ON THE WAY OUT** — run the kernel twice on one frame
   and the second run returns. The merge is idempotent, like `allocPass`.
4. **A MISSING PARENT PAYS SKY, NOT BLACK.** If the parent lattice has no live
   probe here, the chain ENDS and a direction that escaped this cascade escaped
   the scene. Black would make an intermittently-late voxelization read as "the
   far field is unlit" — the 3.13 boundary-clamp failure in a different hat.
   Census, in three stat slots that are dead on the world path (`handoffs`,
   `matureTexels`, `texelsSeen`): on the corridor, **the parent answered 91.1 %
   of transparent texels; 8.9 % truncated.**

**α MUST BE 1, AND THAT IS ALGEBRA RATHER THAN TASTE.** The merge writes
`own + T·parent` back into the same texel, so the value the next trace would
blend against is already merged: `mix(merged, own, 0.25)` re-mixes the far field
into the near band and the next merge adds it again. §T is satisfied without the
EMA anyway — a world probe traces the same 64 rays from the same point every
update, so α was never removing noise here.

**THE SEED.** A re-keyed slab was the one place this lattice still broke "light
arrives complete": §V.6 measured it as 3.14's +2.0/+5.5/+3.0 points of motion
sign-flips. A fresh probe now takes its nearest parent probe's merged map (and
its moments, re-quantized into its own units) until its own first trace, and
`ready` becomes three-valued — 0 re-keyed, 0.5 SEEDED, 1 traced. It re-seeds
every frame until the probe traces, so a probe waiting seven frames for c1's
turn tracks its parent the whole way. At rest the set is empty and a parked
camera pays nothing.

### W.4 ⭐⭐ `t_{i+1} >= 2·s_{i+1}` — THE RULE THE SWEEP FOUND

The merge interpolates the parent's map AT THE CHILD'S POSITION, and the child
can be up to `s_{i+1}` from the parent it reads. If the parent's interval starts
at `t_{i+1}` comparable to `s_{i+1}`, that offset is comparable to the whole
near end of the band and the hand-off loses energy — the child asks "what is
beyond 10 m from ME" and is answered "beyond 10 m from somewhere else eight
metres away".

Corridor, wall crops, GPU divided by the 4-bounce path-traced truth, ultra.
**The arms rank exactly by `t_{i+1}/s_{i+1}`:**

| `R0_CELLS` | t = [t0,t1,t2] | t1/s1 | t2/s2 | 5 m | 15 m | 30 m | 50 m |
|---|---|---|---|---|---|---|---|
| 2 | [0, 1, 5] | 0.50 | 0.63 | **0.209** | 0.404 | 3.064 | 0.119 |
| 4 | [0, 2, 10] | 1.00 | 1.25 | 1.227 | 0.376 | 2.888 | 0.119 |
| **8 (shipped)** | **[0, 4, 20]** | **2.00** | **2.50** | **1.161** | **0.458** | **2.877** | **0.118** |
| 12 | [0, 6, 30] | 3.00 | 3.75 | 1.839 | 0.500 | 2.875 | 0.118 |
| 16 | [0, 8, 40] | 4.00 | — | 1.633 | 0.614 | 2.872 | 0.118 |

`r0 = 2` is a COLLAPSE — the 5 m crop reads a fifth of the truth. Past `r0 = 8`
the far cascade's band is squeezed toward nothing (at 16, `t2 = RAY_MAX` and c2
has no band at all, which is 3.14 with extra steps) and the 5 m crop drifts back
up as c1 takes work c0 should be doing. Asymptotically the ratio is
`R0_CELLS/(β−1)`, so anything at or above 6 keeps `t/s >= 2` at every cascade.
**8 is the smallest power of two that satisfies the rule, and it is the best
total error.**

### W.5 THE CORRIDOR — A FAR-FIELD RECEIPT WITH TRUTH IN IT

`probe:gi2-corridor` (`scripts/gi2-corridor.html` + `run-gi2-corridor-probe.mjs`)
is the instrument 3.14's verdict said was missing. The Cornell rig HAS truth and
no far field (a 5 m box entirely inside cascade 0); Bistro HAS a far field and no
truth. This is the missing quadrant: the analytic room stretched to 60 m along Z,
the emissive panel on the ceiling at the far end, a sun through a side window at
the NEAR end, and the SAME `makeReference` CPU path tracer — now lifted into
`scripts/lib/gi2Reference.mjs` so the two probes cannot drift — evaluated at
5 / 15 / 30 / 50 m from the camera, at 1, 2 and 4 bounces, 150 000 spp.

**The gate is the flat room's own bracket, not a new number**: GPU irradiance at
least the 1-bounce reference and at most 1.15× the 4-bounce one, exactly what
Cornell parity asks. This replaces "within ±15 % of the screen path", which had
no truth in it.

⭐⭐ **THE SKY IS BLACK IN THIS SCENE, AND FINDING OUT WHY IS ITSELF A RECEIPT.**
`hitRadiance` credits `skyColor` to any ray that reaches `RAY_MAX` without
hitting, and **`RAY_MAX` is 40 m while the corridor is 60**. A probe at z = 8
fires down +Z, marches 40 m of empty corridor, hits nothing, and is paid a skyful
of light. With a 0.32-luminance sky that one policy put 0.14 of irradiance on the
near crops against a path-traced 0.009 — fifteen times over, and none of it about
the merge. **The cascade LATTICE reaches 256 m and the cascade RAYS reach 40; the
last cascade's sky credit is the seam between them, and in an interior it is a
leak.** Black is what the two paths can agree on, so the residual is transport.

### W.6 WHAT THE CORRIDOR SAYS ABOUT 3.14 vs 3.15 (ultra, 700 frames, wall crops)

| ÷ 4-bounce truth | 5 m | 15 m | 30 m | 50 m | bracketed | Σ\|ln ratio\| |
|---|---|---|---|---|---|---|
| 3.12 screen path | 1.887 | 0.741 | 0.156 | **0.002** | 2/8 | 9.01 |
| 3.14 cascades to the horizon | 1.953 | 0.607 | 3.295 | 0.119 | 3/8 | 4.49 |
| **3.15 interval merge** | **1.166** | 0.460 | **2.930** | 0.119 | 3/8 | **4.14** |

▶ 3.15 is the closest arm overall and much the closest at 5 m; it is DARKER at
15 m (0.460 vs 0.607), and that row is a measured regression with an un-isolated
mechanism. Two candidates were REFUTED cheaply and are recorded so nobody
re-proposes them:
* **the fall-through's coverage proportion** — `wpCovFull` makes the hand-off a
  saturating gate rather than a proportion (`1.0` reproduces 3.14's behaviour);
  the 15 m row moved 0.348 to 0.378 and nothing else moved. Coverage is ~1 at
  these crops.
* **cache convergence** — 160 frames vs 700 frames moved 15 m by 0.03. It is
  converged, not warming up.

▶ **AND THE TWO BIGGEST ERRORS BELONG TO NEITHER ARM'S ESTIMATOR.** At 30 m both
arms are ~3× too bright and at 50 m both are ~8× too dark, and the two numbers
are within 1 % of each other across the arms — so the merge is not the variable
there. 30 m is §V.3's own unmeasured candidate, now measured: **a coarse probe
stands where its own escape put it, up to 4× its liveness voxel (14 m at c2),
and a probe pushed outside the building measures the sunlit EXTERIOR.** 50 m is
resolution: past c1's ±32 m only c2 exists, and 8 m probes cannot resolve an area
light five metres away. Both are cascade-schedule problems (16 / 64 / 256 m
extents against a 40 m ray reach), not interval-merge problems.

### W.7 ⭐⭐⭐ THE SEALED ROOM: AN ESCAPE RULE WRITTEN FOR A PROBE IS WRONG FOR AN INTERVAL START

The first build did the obvious thing — advance the origin to `t_i`, trace
`t_{i+1} − t_i`. In a room whose free path is smaller than `t_i`, that origin
lands INSIDE OR BEYOND A WALL, and `traceWindow`'s escape then does exactly its
job: it walks the origin forward out of the dilated shell, which puts the ray
**outside the sealed room**. It flies to the horizon, misses, and the chain pays
SKY. In a 10x6x10 m Cornell room c1's band starts at 4 m and c2's at 20 m, so
this is not an edge case — it is most of their directions.

⛔ **The thin-wall interior receipt read 5.99 % of the lit side against 3.14's
0.05 %, and the CONTROL (visibility and face both off) read the same 5.99 %.**
That equality is the whole diagnosis: nothing in the RESOLVE was leaking. Two
candidate fixes were built and both were REFUTED by that same number:

* **the fall-through's coverage proportion** (`wpCovFull = 1` reproduces 3.14's
  proportional hand-off) — thin-wall unchanged at 5.62 %;
* **a line-of-sight gate on the merge's parent tap** (`mergeVisPass`, eight
  short rays per updated probe packed as eight bits into `wpInfo[1].w`) —
  thin-wall 5.62 to 5.99 %, i.e. nothing.

Sky was already in the field, put there by rays that started outside the room.
⭐⭐ **An escape rule written for a probe's own origin is wrong for an interval
start: one says "get me out of the surface I am standing on", the other would
have to say "get me past the surface that is blocking me", and those are
opposite instructions.**

**THE FIX — the ray leaves the PROBE and only the RADIANCE is interval-limited:**

| the ray | stored |
|---|---|
| hit before `t_i` | radiance 0, **T = 0** — blocked before my band; the finer cascade owns both the light and the occluder |
| hit inside `[t_i, t_{i+1})` | the hit's radiance, T = 0 |
| miss, last cascade | sky, T = 0 |
| miss, any other cascade | radiance 0, **T = 1** |

This is RC's decomposition unchanged — cascade `i` still contributes only its own
band — with the occlusion evaluated from the place the light is actually being
gathered. It is strictly MORE correct than the textbook form, which assumes the
finer cascade's `T` covers the near segment; that holds only when the finer probe
is at the same point, and it never is.

▶ **thin-wall interior 5.99 % → 0.39 %, against a control of 0.82 %.** Note the
shape of that pair: 3.14 reads 0.05 % with a control of 0.05 %, so its visibility
term is doing NOTHING there (both sit on the instrument's floor); 3.15 reads half
its own control, which is the first arm on this receipt where the term is
measurably working.

⚠ **AND IT IS CHEAPER, NOT DEARER.** c0 holds 70 % of the slots and its rays got
ten times SHORTER (0→4 m against 3.14's 0→40); c1 halves; only c2, at 10 % of the
slots, pays 3.14's full length. Chain **2.396 ms against 3.14's 2.544** at
1650x970, both against a 4 ms budget.

`mergeVisPass` was KEPT even though it did not fix what it was built for: the
merge does interpolate a directional field across space from probes up to
`s_{i+1}` away, DDGI's argument for a visibility weight there is sound, and it
costs eight short rays per updated probe (~11 % more rays, measured inside the
chain number above).

### W.8 ⭐⭐ THE BIAS-INDEPENDENCE TELL — 28.7 POINTS BECOMES 2.2

3.14's verdict rested on one observation: **a single displacement constant moved
the doors thin-feature ratio and the far-field ratio together**, which no correct
interval decomposition can allow, because a 14 cm recess and a 40 m façade are
different cascades' bands. `wpBiasPerCasc` makes both readings ONE BOOT apart
(0 = `wpBias·s_0`, 15 cm everywhere; 1 = `wpBias·s_c`, 15/60/240 cm).

Bistro doors pose, PINNED (eye [1.26, 1.96, −1.66] → [−0.55, 1.51, −0.81]), the
SCREEN arm's own darkest-1 % population (1124 px) measured on every arm — a
shared pick, so it is the same 1124 pixels every time. AO off.

| arm | darkest-1 % ÷ wall (irradiance) | `irrP05` | no live corner |
|---|---|---|---|
| 3.12 screen path | 23.0 % | 0.1156 | — |
| 3.14, bias `s_0` | 55.5 % | 0.1456 | 0 % |
| 3.14, bias `s_c` | **26.8 %** | — | 0 % |
| **3.15, bias `s_0`** | **54.8 %** | 0.1207 | 0 % |
| **3.15, bias `s_c`** | **57.0 %** | 0.1176 | 0 % |

▶ ⭐⭐ **THE TELL PASSES, AND ON THE SAME POSE AND THE SAME 1124 PIXELS RATHER
THAN AGAINST §V.4's OLDER BOOT. One constant moves 3.14's ratio 28.7 points
(55.5 to 26.8 %, 52 % relative) and 3.15's 2.2 points (54.8 to 57.0 %, 4 %
relative) — THIRTEEN TIMES LESS SENSITIVE.** (§V.4 measured 3.14's coupling as
36.4 points on a different boot; the same effect, larger, because that boot's
populations were darker.) The picked pixels sit at p50 6.08 m / p95 6.49 m, entirely
inside c0's 16 m extent where `s_0` and `s_c` are the same 15 cm, so the residual
2.2 points is c1's share inside the hand-off BAND and nothing else. The coupling
that condemned "pick the finest cascade that covers you" has nowhere left to
live.

⚠ **AND THE GATE ITSELF IS STILL NOT MET: 54.8 % against ≥ 70 %.** It is 2.4x
the screen path on the same pixels, `irrP05` is non-zero on every arm here, and
"no live corner in ANY cascade" is 0 % — but the mean is where 3.14 left it.
This gate is not what 3.15 moved.

### W.9 THE RECEIPT TABLE (3.12 / 3.14 / 3.15, ONE BINARY)

`?world=0` is 3.12, `?intervals=0` is 3.14, default is 3.15. Cornell rig at
960x540 (`probe:gi2-gather`, ultra); Bistro doors at the pinned pose.

| receipt | 3.14 (intervals off) | **3.15** | gate |
|---|---|---|---|
| Cornell bracketed | 8/8 | **8/8** | 8/8 |
| Cornell within 15 % of the 2-bounce ref | 7/8 | **8/8** | — |
| 5 cm-wall leak | 0/10 000 (control 92.1 %) | **0/10 000 (control 92.1 %)** | 0 |
| leak, all four rotations | 0/10 000, control 100 % | **0/10 000, control 100 %** | 0 |
| thin-wall interior, worst | 0.05 % (control 0.05 %) | **0.39 % (control 0.82 %)** | ≤ 5 % |
| trim: sub-voxel crops in the flat bracket | 5/6 | **5/6** | 6/6 |
| at rest: still % / sign flips / temporal p95 | 100 / 0 / 0.001 % | **100 / 0 / 0.001 %** | 95 / — / 0.3 % |
| orbit ÷ parked (paired) | 1.000 | **1.019** | — |
| orbit sign-flip rate | 6.411 % | **6.062 %** | ≤ 35 % |
| panel move re-converges | 18 fr | **5 fr** | ≤ 30 |
| chain ms @1650x970 | 2.544 | **2.396** | ≤ 4.0 |
| storage buffers, worst kernel | 6 | **6** | ≤ 6 |
| cold noise: temporal p95 | 0.723 % | **1.576 %** | ≤ 1 % ⛔ |
| lattice bytes (GPU) | 66.75 MB | **66.75 MB** | — |
| **Bistro doors: darkest-1 % ÷ wall** | 55.5 % | **54.8 %** | ≥ 70 % ⛔ |
| Bistro doors: `irrP05` of that set | 0.1456 | **0.1207** | > 0 |
| Bistro doors: no live corner anywhere | 0 % | **0 %** | 0 % |
| **corridor 5 m ÷ path-traced truth** | 1.953 | **1.166** | bracket |
| corridor 15 m | 0.607 | **0.460** | bracket |
| corridor 30 m | 3.295 | **2.930** | bracket |
| corridor 50 m | 0.119 | **0.119** | bracket |
| corridor bracketed | 3/8 | **3/8** | — |

**The one gate 3.15 loses is `cold noise: temporal p95`, 0.723 → 1.576 %, and it
is `wpAlpha = 1`.** That arm measures 30 frames FROM COLD while the radiance
cache is still converging; with the EMA gone a probe's map STEPS to each new
cache value instead of ramping to it. §U.2 predicted exactly this ("1 is a
legitimate arm and is not noisy, only abrupt") and the settled receipt is
untouched at 0.001 % with 100 % still pixels and zero sign flips. The same
constant is why the panel move re-converges in 5 frames instead of 18. It cannot
be turned down without breaking the merge's algebra (§W.3).

**THE PHONE TIER (two cascades, `[0, 8)` and `[8, 40]`) BUILDS AND PASSES**, and
that matters because it is the portable envelope's arm: Cornell 8/8 · thin-wall
interior **0.19 % against a 0.31 % control** · storage buffers 6 of 6 · no
workgroup memory · chain 2.183 ms · panel move 6 frames · at rest 100 % still,
0 sign flips, temporal p95 0.001 %. The same two structurally-blind FAILs and the
same cold-noise row (1.859 %).

⚠ Two gates read FAIL on every world arm and are **structurally blind, not
failing**, exactly as §V.5 recorded: `reprojection at rest ≥ 99 %` reads 0/0
because nothing reprojects on a path where nothing moves, and §3.9's rotated-room
`delta` predates this stage.

### W.10 THE ENGINE GATES (shipping path, `WORLD_PROBES = false`)

`test:gi-sunleak` **PASS** — sealed interior worst leak 0.00000 against 0.002.
`test:gi-moved-lamp` **PASS** — the new spot gains 29.06 lum (gate > 12), the old
loses 29.05, separation 58.11.
`smoke:gi-gpu` **PASS** (exit 0) — gi2 transport 280 rays/frame over 35 probes,
probesValid 35/35, first light 339 ms, cache 15.08 MB / window 2.815 MB.
`run-gi-resize-probe` **ALL PASS** — uncaptured device errors 0 / createBindGroup
throws 0 across every hop, textures live and transport alive after the last.

⚠ Same caveat §V.8 records: these four run the SHIPPING path because the flip did
not happen, so they say the tree is green, not that the world path is.

### W.11 THE FLIP VERDICT — `WORLD_PROBES` STAYS `false`

**WHAT 3.15 SET OUT TO DO, IT DID.** ⭐⭐ The bias-independence tell — the one
thing 3.14's verdict named as the proof that its resolve was not RC's merge — is
now measured on one pose, one pick, one binary: **one constant moves 3.14's doors
ratio 28.7 points and 3.15's 2.2.** The far field has a REFERENCE for the first
time (`probe:gi2-corridor`, a 60 m room and a CPU path tracer), and against it
3.15 is the closest of the three arms. The chain got CHEAPER (2.396 vs 2.544 ms)
because c0's rays are ten times shorter. A moved panel re-converges in 5 frames
instead of 18. §T is untouched: 100 % still, zero sign flips, temporal p95
0.001 %.

**PASS** — Cornell 8/8 · Cornell within 15 % of the 2-bounce reference 8/8
(3.14: 7/8) · 5 cm leak 0/10 000 with its 92.1 % control, and 0/10 000 on all
four rotated rooms · thin-wall interior 0.39 % against a 0.82 % control (the
first arm where that term measurably works) · §T at rest · orbit ÷ parked 1.019,
orbit sign-flips 6.062 % (3.14: 6.411) · panel move 5 frames · chain 2.396 ms ·
storage buffers 6 of 6 · lattice unchanged at 66.75 MB · doors "no live corner in
any cascade" 0 % · corridor total error the lowest of the three arms · all four
engine gates.

**FAIL — the doors thin-feature ratio, 54.8 % against ≥ 70 %.** It is 2.4x the
screen path on the same 1124 pixels and level with 3.14's 55.5 %, so the gate is
not something the interval merge moved in either direction. What 3.15 removed
was its DEPENDENCE on a constant that has no business setting it.

**FAIL — the corridor's 30 m and 50 m rows, and NEITHER IS THE MERGE.** Both
arms read 30 m ~3x too bright and 50 m ~8x too dark, agreeing with each other to
within 1 %, so the variable is not the interval decomposition. ⭐ Both are
CASCADE-SCHEDULE problems and they are now named with numbers:
1. **30 m — the coarse probe's ESCAPE.** §V.3 listed it as an unmeasured
   candidate; the corridor measures it. A probe is pushed out of geometry by up
   to 4x its liveness voxel — 14 m at c2 — and a probe 14 m outside a building
   measures the SUNLIT EXTERIOR. 3.15 2.930, 3.14 3.295, truth 1.0.
2. **50 m — resolution.** Past c1's ±32 m only c2 exists, and 8 m probes cannot
   resolve an area light five metres away. Both arms 0.119.
3. And the frame around both: **the cascade LATTICE reaches 256 m while the
   cascade RAYS reach `RAY_MAX = 40 m`.** A 256 m lattice of probes that can see
   40 m is mostly unreachable, while the 16 → 64 m gap is where all the error
   is. The extents (16/64/256) were chosen against the window's levels, not
   against the ray budget.

**FAIL — cold-noise temporal p95, 0.723 → 1.576 %** — `wpAlpha = 1`, which the
merge's algebra requires (§W.3) and which is the same constant that took the
panel move from 18 frames to 5. It is a convergence RAMP, not steady-state noise:
the settled gate is 0.001 %.

**FAIL — Bistro motion sign-flips, above 3.14's on all three arms**
(`probe:gi2-motion`, world lattice arm, same session, `FLAGS` as the arm):

| reprojected sign flips | §V.6's 3.13 | 3.14 | **3.15** |
|---|---|---|---|
| orbit | 25.2 % | 26.9 % | **35.1 %** |
| dolly | 17.2 % | 21.6 % | **26.4 %** |
| whip | 15.8 % | 17.6 % | **23.3 %** |
| orbit MAX frame ms | 118.0 | 143.3 | **113.4** |
| PARKED median frame ms | — | 18.3 | **15.5** |

▶ **This is `wpAlpha = 1` again, and it is the same trade the cold-noise row
records.** With the probe-map EMA gone — which the merge's algebra forbids
(§W.3) — a probe steps to each new value instead of ramping to it, and a
reprojected comparison under motion counts every step as a sign change. The
`accum` arms in the same table say the image-space accumulator is still doing its
work on both arms (3.15 orbit 35.1 % with it, 40.9 % without; 3.14 26.9 / 39.3),
so the remaining lever for this row is at the image, not at the probe. ⚠ Note
that 3.15 is FASTER on the same runs — parked median 15.5 ms against 18.3, orbit
MAX 113.4 against 143.3 — so this is not a cost of doing more work.

The frame-time and voxelize-chain gates fail on BOTH world arms and on §19 4.1's
own record; §V.6 already attributes them to the `binPairs` scroll burst, which
this stage does not touch.

**NOT RUN, and therefore not claimed:** `probe:gi2-farfield` (superseded for this
stage by the corridor, which has truth in it) and `probe:gi2-boot` (Level/Bistro
first light and JS heap).

▶ ⭐⭐ **AND THE TWO REMAINING FAILURES 3.15 OWNS ARE THE SAME ONE.** Cold-noise
p95 and Bistro motion flips are both `wpAlpha = 1`, and α cannot come back while
the merge writes `own + T·parent` into the texel the next trace would blend
against. The way to have both is to keep `own` and `merged` in separate words —
+25 MB of `wpOct` (66.75 → 92 MB) for an EMA on the merged value. That is a
measurable trade and it is the first thing to try if this row blocks the flip
again.

▶ **NEXT, IN ORDER.** (1) The coarse-probe escape budget — it is the largest
single error in the far field and it is one constant. (2) The cascade extent
schedule against `RAY_MAX`, which currently disagree by 6x. (3) The 15 m corridor
row, the one place the merge itself is behind 3.14.
