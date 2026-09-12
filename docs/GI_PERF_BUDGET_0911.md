# GI cost budget — Sponza build, 2026-09-11

Brief: "make GI faster without losing visual quality; Sponza runs 20 fps on the
iPhone and 40 on the PC in the browser; probably the moving sun; what can we
change in the engine and the GI algorithm so it runs 2-3× faster, in general?"

## 1. The frame, measured on the actual build

Method: `node scripts/run-player-fps.mjs <url> --w W --h H [--flags JSON]` —
headless Chrome on the 4070, the live-preview export at
`http://localhost:50845/`, 20 s settle, 10 s capture, one flag arm per boot,
editor paused with `profile.gpuIsolation` so the two never share the adapter.
Receipts: `.gi-shots/player-fps/*.json`. GPU at 2100 of 3105 MHz (thermal
slowdown active) throughout — every ms below carries a ~1.45× ceiling.

Scene as shipped: GI rails bounce 1 / ao 1 / reflections 0.25 (= ULTRA screen
tier, resolve scale 0.71), movable sun rotated by `Rotator.ts` (one turn per
180 s, ~2°/s), 2048² VSM shadow map, 10 cloths + a skinned character = 34
adopted movers, 2 emissive lamps, post off. Build quality preset "high".

| arm (2872×1532, the browser's physical canvas) | fps | GPU ms | render | compute | CPU |
|---|---|---|---|---|---|
| **as shipped** (resolve 1732×924 = 1.6 M) | **42.5** | 22.7 | 5.25 | 17.46 | 6.8 |
| same build at the editor's 1570×962 (resolve 0.75 M) | 75 | 12.8 | 2.27 | 10.57 | 6.6 |
| `__giResolveMaxPixels` 800 k (resolve 1225×653) | 54 | 16.6 | 4.93 | 11.63 | 6.8 |
| `__giSrcWorldHz` 15 | 44.7 | 20.7 | 5.25 | 15.46 | 6.9 |
| `__giSrcWorldHz` 1 (world chain ~off) | 51 | 17.0 | 5.15 | 11.81 | 6.5 |
| `__giSrcTransportRays` 32768 (ray ceiling pinned) | 41 | 22.7 | 5.31 | 17.41 | 7.2 |
| `__giSkinnedProxies` false (no character capsules) | 43.5 | 21.8 | 5.25 | 16.51 | 8.0 |
| **GI component disabled** | **120 (vsync)** | **2.5** | 2.30 | 0.23 | 3.7 |

Reading it:

- **GI is 20.2 of the 22.7 ms (89 %)**; everything else — 4.4 M pixels of MSAA
  4× raster, the 2048² VSM shadow map with its two blur passes, cloth, physics,
  UI — is 2.5 ms and runs at the vsync cap.
- **The per-resolve-pixel screen chain is the largest block, ~9-11 ms.**
  Halving the resolve pixel count took 5.8 ms off. Every screen pass is
  per-resolve-pixel (resolve, GTAO + 2 filters, gather ×2, far field ×2, glossy
  ×3, irradiance temporal + history, and the 8-pass emitter chain at its own
  capped size), and so is the transport's population/ray allocation.
- **The world transport at 30 Hz is ~5.7 ms.** 15 Hz → 3.7, ~1 Hz → 0. Pinning
  its ray ceiling changed nothing: the chain's cost is per-pixel population +
  pool sweeps + 71 dispatches, not rays.
- **The 34 mover proxies are ~2.8 ms**: ~1.0 for the character's capsules
  (`__giSkinnedProxies` false), ~0.45 for the cloth grids on a phone-shaped
  frame (`__giClothGiProxies` false) — the cost is their presence in every
  trace, NOT the ten refit dispatches (`__giGridRefitStride` 2 bought nothing).
- **GI-owned raster is ~2.9 ms**: the g-buffer prepass (33 draws at the resolve
  size) plus the irradiance/AO/reflection taps compiled into every lit
  material's fragment shader at 4.4 M pixels × MSAA.
- **The moving sun is ~25 % of the frame**, not the key reason. Parking it lets
  the world chain idle (editor: compute 10.9 → 8.7 ms) but leaves the screen
  chain, the movers and the raster.

Why the editor is "A LOT faster": its viewport is 1570×962 (1.5 M pixels)
against the browser's 2872×1532 (4.4 M). At the editor's size the build runs
75 fps, and the editor itself 72-99 — the remaining gap is the editor being
CPU-bound (10.7-11.8 ms of CPU, GI's screen chain issue 2.4 ms of it) rather
than GPU-bound, which is also why "changing GI quality does not change fps"
there: the rails move GPU work the frame was not waiting on.

Why the presets did not move the build either: `resolveMaxPixels` was one
1.6 M ceiling for every tier. On the 4.4 M canvas low, medium and high all
resolved 1.1 M pixels and ultra 1.6 M — the preset changed the world pools and
the ray budget, which this frame is not bound by.

The phone: the mobile device tier already clamps every rail to "low", but a
1704×786 phone canvas still resolves 0.33 M GI pixels, and the screen chain
that costs ~2.5 ms at that size on a laptop 4070 is a whole frame on an A17.

## 2. What shipped today (each gated, each a flag away)

1. **The pixel ceiling is a tier property** (`giConfig.js` `BY_TIER`):
   low 0.4 M, medium 0.6 M, high 0.9 M, ultra 1.6 M (unchanged). Nothing
   changes below the ceiling — the editor viewport resolves 0.38 M at
   low-high and 0.75 M at ultra, under every value. On a large canvas the
   presets finally price differently. A portable device (mobile tier ceiling)
   gets 0.25 M under the tier's. `__giResolveMaxPixels` still overrides.
2. **The build's quality preset caps the GI tiers** (`resolveGiConfig`'s
   `qualityCeiling`, passed by `GISystem#config` from `engine.config.quality`):
   a "high" build runs GI at high even when the scene is authored ultra, as
   `applyQualityCeiling` already does for the renderer. "ultra" = as authored.
   The editor passes nothing, so its look is untouched.
3. **The world rate follows the light-motion drive** (`giCadence.js`
   `giWorldRateHz`): rest rate at rest, full 30 Hz only once the drive says
   the light is really moving (≥ 0.6), a smooth step between — a 3-minute
   Sponza day (drive ~0.1-0.35) runs ~16-24 Hz. An α compensation that
   holds the per-second decay (`giRateCompensatedAlpha`, wired through
   `srcSystem`'s `worldRate` getter) exists but is OPT-IN
   (`__giSrcRateAlpha = true`): the flicker pair below showed it doubles the
   p95 one-frame step, and a slow light's extra lag is a few degrees of a
   blurry field while a light step still arms the full rate.
   `__giWorldRateDrive = false` is the A/B arm.
4. **A portable device is held to the "medium" preset** (`sceneSettings.js`
   `deviceQualityCeiling`, applied in `player/main.js`): DPR 1.5, render
   scale 0.85, dynamic resolution on. A phone-shaped run of the build (see
   §4) puts the whole GPU frame at 2.9 ms on this laptop against 4.4 ms at
   the "high" shape. `?quality=high` on the URL overrides it for an A/B on
   the device itself.
5. `scripts/run-player-fps.mjs` — the build probe used for every number here
   (`--flags`, `--gi off`, `--w/--h`, `--label`; receipts in
   `.gi-shots/player-fps/`). ⚠ After `npm run build:player` the live preview
   must be stopped and started (`build.serve`) before it serves the new
   runtime; `curl` the page for the `player-*.js` chunk name to be sure.
6. Dev flags for pricing: `__giGridRefitStride`, `__giClothGiProxies`,
   `__engineTrackTimestamp`.

## 3. Receipts after the change (same canvas, same build settings)

| arm | fps | GPU ms | render | compute | notes |
|---|---|---|---|---|---|
| shipped before | 42.5 | 22.7 | 5.25 | 17.46 | resolve 1.6 M, world 30 Hz |
| **after** (tier high via the build preset, resolve 1299×693 = 0.9 M) | **62.6-64** | **13.8-14.0** | 4.6-4.8 | 8.9-9.4 | world ~16-24 Hz |
| after + `__giGridRefitStride` 2 | 62.3 | 14.5 | 5.17 | 9.37 | **no gain — the cloth refit dispatches are not the cost** |
| after + `__engineTrackTimestamp` false | 66.6 | — | — | — | inside noise; timestamps stay on |
| phone shape 1704×786, tier low, old 0.335 M resolve | 119 | 4.59 | 1.76 | 2.83 | |
| phone shape 1704×786, tier low, 0.25 M resolve | 118 | 4.36 | 1.74 | 2.62 | the pixel cap buys little at low |
| phone shape 1086×501 ("medium" preset), tier low | 113 | 2.86 | 0.85 | 2.01 | CPU 8.1 ms — the phone's wall |
| same, `__giClothGiProxies` false | 91 | 2.63 | 1.07 | 1.56 | cloth GI proxies ≈ 0.45 ms |

Editor gates (ultra rails, 1110×680, same session, sun rotating, camera
still): `profile.flicker` reversals/pixel/frame 0.0017 (rate policy +
α-compensation) vs 0.0018 (30 Hz) with p95 step 0.35× vs 0.20× of mean —
hence the compensation is opt-in; a later pair read 0.0066 (30 Hz) then
0.0089 (policy) but the sun's phase and a surprise window differed, and a
third window before either read 0.0042 — the instrument drifts more between
windows than the arms differ. `profile.lightResponse` with the sun parked
(25° step): t50 1343 ms, t90 4949 ms, monotone 84 % after; before the reload
t50 2035 ms and t90 never reached. A step arms the track window (drive → 1)
so it always gets the full rate.

Two things seen in the editor while measuring, neither caused by this work:
- a GI quality change (bounce 1 → 0.75) is one 2320 ms main-thread block —
  77 compute pipelines and their TSL kernels built synchronously — plus a few
  100 ms blocks and the viewport loop paused for the compile wave. This is
  what "changing GI quality breaks the editor" looks like; the async
  stand-in path (`zero-freeze-gpu-stall-standins-0910`) covers materials,
  not the GI compute kernels.
- a light rebuild left a 4096² RG16F VSM shadow-map texture destroyed while
  the main pass still bound it: ~100 s of "Destroyed texture used in a
  submit" at thousands per second, self-healing when the materials re-minted.
- intermittent (2 of ~15 boots): `TypeError: Cannot read properties of null
  (reading 'matrix')` in three's `updateNode` during the player's boot, then
  every frame — an object node bound before its object exists.

⚠ Editing any GI source while the editor runs hot-swaps the GI module (a
`component-attached` rebuild, the old system leaked, heap +900 MB): every
editor number after an edit is a mixed-module number until a reload.

Tests: `tests/gi-cadence.test.mjs` (+2), `tests/gi-ultra-budget.test.mjs`
(+3). Two pre-existing failures in the same files are unrelated (an ultra
ray-cap assertion and an occupancy-gate regex, both failing against HEAD too).

## 4. What "2-3× in general" takes — the structural list

The measured shape says where the 2-3× lives. In cost order on this frame:

1. **Fixed pixel budgets everywhere** (done for the resolve; GTAO and the
   emitter chain follow it). The remaining per-pixel bill is then a tier
   choice, not a monitor choice.
2. **The g-buffer prepass** (33 draws, ~1.5-2 ms GPU, ~1 ms CPU, ×3 on a
   phone) re-rasterises the scene for position + normal the main pass already
   has. Export depth + normal from the main pass (or a depth prepass with
   normals from depth for the probes) and downsample; the prepass goes away.
3. **Screen-chain pass fusion**: ~21 full-screen dispatches a frame at the
   resolve size (resolve → irradiance temporal → history could be one; the
   emitter chain's 8 passes could be 3; far field ×2 and glossy ×3 could fold
   into the gather). At 1 M pixels each pass is ~0.3-0.5 ms of bandwidth
   before it computes anything, and each is a barrier.
4. **Cloth/character proxies**: their cost is being tested by every ray in
   every trace kernel (~2.8 ms with 34 of them), not their refit dispatches —
   fewer, coarser proxies (one capsule set per limb, one grid per curtain
   pair) or a per-tier mover cap is the lever; the refit kernel is not.
5. **A hit cache for light-only changes**: with static geometry and a moving
   light the ray hits do not change, only their shading. Re-shading cached
   hits (sun shadow-map lookup + emitter NEE) instead of re-tracing would
   make the transport's cost under a moving sun ~[J] + merge + tiles instead
   of the whole chain. Lumen's surface-cache argument; a large unit.
6. **The phone tier**: 0.25 M resolve (shipped), 15 Hz world, emitter shadows
   at quarter res or off, GTAO at half the resolve. Needs the device in hand.

Honest ceiling for the PC build at the shipped rails: the shipped changes take
it to roughly 60 fps at "high"; 2× needs the medium tier or the structural
units above; 3× needs the phone-class budget on a 4K canvas, which is a
visible reduction in AO/emitter-shadow detail, not in the diffuse GI.

## 5. §11.56 grouped compute dispatch — built, correct, and NEUTRAL

Hypothesis: the world kernels sum to ~4.2 ms in isolation but ~5.8 ms per
chain in the frame, so the 71 separate compute passes (each its own encoder,
pass, timestamp pair, bind-group set) must cost ~1.6 ms of boundaries.
Built: `giComputeNodes` now hands consecutive BUILT kernels to three as one
array (one pass), cached by composition with a stable `id`; unbuilt or
pending kernels still dispatch alone. `__giComputeGroups = false` is the A/B;
`profile.frameStats.giHold.computeGroups` counts calls vs nodes. Tests:
`tests/gi-compute-dispatch.test.mjs` (+4). GPU smoke `smoke:gi-gpu` PASS on
both arms at the portable 8-buffer limit.

| arm (rebuilt player) | fps | GPU | render | compute | CPU |
|---|---|---|---|---|---|
| groups on, 2872×1532 | 63.5 | 14.21 | 4.85 | 9.37 | 6.05 |
| groups off, 2872×1532 | 64.0 | 14.40 | 4.87 | 9.53 | 6.15 |
| groups on, 1086×501 tier low | 119.9 | 2.86 | 0.76 | 2.10 | 6.16 |
| groups off, 1086×501 tier low | 119.4 | 2.99 | 0.76 | 2.22 | 6.01 |

**Refuted on the 4070:** ~0.15 ms of GPU and no CPU. Three's per-node passes
were not the gap; the "isolation vs in-frame" difference was thermal drift
between reads minutes apart plus the screen items counted inside the chain's
group. Kept default-on because it is correct, smaller than the code it
replaced in pass count, and pass boundaries are known to cost real time on
tile-based mobile GPUs (a compute pass end is a flush there) — a phone
receipt is owed before that claim is quoted. ⚠ LESSON: an "excess" inferred
by subtracting two reads taken minutes apart on a thermally throttled GPU is
not evidence; only a same-boot flag A/B is.

## 6. The structural programme, re-ranked after §5

What remains is the real list, each a multi-session unit with a design owed
before code:

1. **Screen probes** — the per-pixel gather/resolve/temporal (~2.6 ms at
   0.75 M, ~3 at 0.9 M) becomes an octahedral probe per 8×8 tile gathered
   from the world field, plus one per-pixel normal-weighted interpolation.
   This is what lets the resolve go far below 0.5× without the smear the
   bilateral cannot avoid across normal changes.
2. **Mover TLAS** — every ray tests every adopted mover (34 here, ~2.8 ms);
   a two-level structure over mover AABBs makes it a few. Contained to the
   dynamicObjects trace closures; register pressure is the risk.
3. **Dirty-tile screen chain on movers-only frames** — GTAO (1.2-1.5 ms),
   the 8-pass emitter chain (~1 ms effective) and the resolve re-run over
   every tile when only a character moved; a tile mask from the static
   g-buffer key would confine them to the tiles that changed. Pays on a
   still camera only.
4. **Hit cache for light-only changes** — re-shade stored hits under a
   moving sun instead of re-tracing.
5. **Prepass removal** — export depth+normal from the main pass. Priced
   lower than first thought: an MRT on a 4.4 M-pixel MSAA 4× main pass costs
   attachment bandwidth of its own; needs a measured design, not a guess.

## 7. The boot error burst: a released kernel replayed against a retired buffer

Every reload today logged, ~30-90 s after boot, `Binding size for [Buffer
"arena:posA"] is zero` / `arena:statics` (8-10 each) followed by a cascade of
`Invalid BindGroup "bindGroup_object" … invalid due to a previous error` on
`computeGroup_*` submits — and, on the cloth side, the "[cloth] three is
binding arena:statics with an EMPTY array (a STALE generation)" watchdog the
user pasted. Mechanism: the async compute-pipeline wrapper queues a node whose
pipeline has not landed and REPLAYS it when it does; the cloth arena grows a
generation during the boot wave and `releaseComputeNodes` its old step
kernels; the queued old kernel then replayed against the retired attributes.
Fix: `releaseComputeNodes` marks nodes `__giReleased` (before its cache
early-return, so fixtures see it too), the two replay sites skip them
(`giReplaySkipped`) and the skip path never queues one. Test:
`tests/gi-pipeline-watchdog.test.mjs` (+1). Predates today's dispatch work
(seen at 15:21 on the first reload).

## 8. §11.57 mover clusters — built, correct, a small win

Premise: every ray visits all 34 adopted movers (load the 4×4, transform the
ray, slab-test, self-exclusion) — a two-level structure should cut that to a
few. Built: the CPU buckets the published movers into ≤ 8 spatial groups
each sync (2×2×2 split of their union by centre, union boxes, member list in
the header after the object blocks — `dynClusterWords`), and the trace
kernels slab-test the group boxes (padded by the penumbra band) before
running the unchanged per-object closure on the members. `__giMoverClusters
= false` (build-time) is the flat scan. Tests: `tests/gi-mover-clusters`
(+4, incl. the header table read back), `smoke:gi-gpu` dynamic-object arms
PASS.

| arm (rebuilt player) | fps | GPU | compute |
|---|---|---|---|
| clusters on, 2872×1532 | 68.9 | 12.65 | 8.22 |
| clusters off, 2872×1532 | 67.2 | 13.28 | 8.63 |
| clusters on, 1086×501 tier low | 119.8 | 2.87 | 2.11 |
| clusters off, 1086×501 tier low | 119.9 | 2.88 | 2.12 |

**−0.4 ms at the PC canvas, nothing at the phone shape.** So the ~2.8 ms the
movers cost (`__giSkinnedProxies=false` −1.0, `__giClothGiProxies=false`
−0.45) is NOT the linear scan over them — like the cloth refit dispatches
and the pass boundaries before it, the obvious mechanism was not the cost.
Where it actually goes is unmeasured: candidates are the mover-side work
outside the trace (skinned proxy refresh, the emitter chain's mover-only
cadence and static snapshot, mover hit shading in [J], `moverHits`/
`insideMoverRays` in the deposit) — each needs its own arm before a design.
Kept default-on: correct, small, and the same structure a real TLAS would
grow from.

## 9. Where this leaves the 2-3×

Today's receipts, in order of what actually moved the frame:

| lever | build GPU ms | class |
|---|---|---|
| pixel ceiling by tier + build preset caps GI | −8.9 | budget policy |
| world rate on the light-motion drive | −2.0 | cadence |
| mover clusters | −0.4 | structure |
| grouped compute passes | −0.15 | structure |
| cloth refit stride, ray-ceiling pin, timestamps off | 0 | refuted |

The two structural units that were cheap enough to build in a session were
small because the costs they targeted were inferred, not measured — the
lesson of the day is that this engine's GI has no per-kernel-per-frame
attribution in the BUILD, only the isolated-dispatch profiler in the editor,
and the two disagree. The next structural session should start by adding a
per-pass timestamp ledger to the player (the passes already carry names)
and pricing the screen chain and the mover-side passes there, then build the
screen-probe consumer against those numbers.

## 10. The per-pass ledger IN THE BUILD, and what it changed

`node scripts/run-player-fps.mjs <url> --passes 12 --flags '{"__giComputeGroups":false}'`
maps three's per-dispatch timestamp entries (`c:<n>:<node.id>:f<frame>`,
`r:<n>:<ctx.id>:f<frame>`) to GI pass names and render-target labels and
accumulates ms per PRESENTED frame (groups off so every kernel is its own
pass; the retained backlog is marked seen before the window — the first cut
counted it and read the main pass at 3× per frame). Sponza build,
2872×1532, sun moving, 706 frames, 15.4 ms attributed of a ~15 ms GPU frame:

| pass | ms/frame | per frame |
|---|---|---|
| main pass (2872×1532, MSAA 4, with the in-material GI taps) | 4.31 | 1 |
| resolve | 2.01 | 1 |
| emitterShadowPass (+filter/post/wide ~0.4) | 1.58 | 0.49 |
| **cloth grid refits (10 one-thread kernels)** | **1.46** | 11 |
| src gather | 0.93 | 1 |
| deposit trace | 0.92 | 0.46 |
| shade + bounce [J] | 0.62 | 0.46 |
| GI g-buffer prepass (1299×693) | 0.54 | 1 |
| irradiance temporal + history | 0.53 | 1 |
| GTAO + 2 filters | 0.61 | 1 |
| cloth solver (array dispatches) | 0.39 | 1 |
| populate/rays/merge/tiles/decay (all) | ~0.5 | 0.46 |
| shadow map 2048² VSM + blurs | 0.09 | 1 |

What it overturned: the g-buffer prepass is 0.5 ms, not 2 (drop that unit
to the bottom); the shadow map is free; the movers' cost is the **refit
kernels (1.46) plus ~0.4 in the transport** (`noSkinned`: deposit 0.92 →
0.70, [J] 0.62 → 0.43) — the stride arm that "refuted" the refits was
confounded by a world-rate change; `noClothGi` removes the 1.46 outright
(58 → 69 fps). The single largest GI item is the resolve at 2.0 ms, then the
in-material taps inside the 4.3 ms main pass (~2.5 ms: the gi-off render is
2.3 ms total), then the emitter chain.

**Shipped on that evidence — §11.58 the refit is a workgroup, not a thread**
(`gpuGridBvh.js` `buildParallelRefit`: 128 threads, one per triangle, a
workgroup reduction for the child boxes, thread 0 writes the node; same words,
same conservatism; `__giGridRefitSerial = true` builds the old kernel).
`smoke:gi-grid-bvh` PASS (both arities, moving source, corner table exact),
`smoke:gi-gpu` dynobj arms PASS. Ledger after: the refit row is gone, 14.08
ms attributed (−1.3); phone-shape compute 2.11 → 1.50 ms (−29 %), GPU 2.87 →
2.38.

Also today: the automatic "medium" preset for phones was REVERTED the same
hour — it forced dynamic resolution on and the scene's 120 fps target drove
the canvas to its floor ("pixelated as if pixel ratio was 1 or lower"). It
is now Build settings → **Mobile preset** (`build.mobileQuality`, default
"Same as preset"), exported as `player.mobileQuality`, applied by the player
only on a portable device; `?quality=` still overrides.

## 11. Why the editor hangs (the freeze ledger, 15 min after a reload)

35 s of blocked main thread in 174 blocks: boot's GI compile 8.0 s (kernel
builds + a synchronous BLAS build 666 ms), `module:setup gi` 2.2 s, the
reflection-probe kernels 1.1 s, `vfx:attach cloth` 1.6 s over 11 blocks,
`material:nodeBuild MeshPhysicalNodeMaterial` 2.3 s over 22 blocks — and
**`(unattributed)` 14.6 s over 132 blocks** (~110 ms each, all session). The
node-build causes name two RECURRING waves: `lights+dynHalf` ×10 (1.1 s) and
`environment+dynHalf` ×10 (0.4 s) — every ~90 s something moves three's
`lights` or `environment` cache key and re-mints every lit material. That
periodic re-mint plus the unattributed ~100 ms blocks is the "almost always
hanging"; on top of it, every GI source edit today hot-swapped the module
(a full rebuild + compile wave each). Next: name the `lights`/`environment`
key mover (suspects: emitter seat re-rank, the reflection probes arming,
the IBL latch) and put a mark around whatever the unattributed blocks are.

## 12. The evening: the resolve hold, the probe kernels, the phone's burst, and an instrument for the phone

**The editor's "changing GI quality does not change FPS" had a second cause.**
`__giResolveFollowsViewport: false` was persisted in `gi.devFlags.v1` from an
earlier session, and `#syncScreenResolveSize` honoured it as a veto on EVERY
resize — including the one a tier change asks for. Ultra → high changed
`resolveScale` 0.707 → 0.5 and the resolve stayed at 1110×680 ("[gi] resolve
size wants 785x481 but holds 1110x680", once per boot). Fixed twice: the flag
is cleared, and the knobs that define the size are now a key on the screen
state (`#resolveConfigKey`: resolveScale, resolveMaxPixels, the dev override,
the shadow budget); a key change commits through the hatch, the 10 % band and
the settle debounce — only the 4 s driver-hang floor still applies. Editor
after: 785×486 at high, 114-120 fps.

**The reflection-probe re-arm is named and no longer one block.** The ledger
clocked `gi:kernel build reflProbeCapture/Blur/Trace` at 337 ms in one task
on the first arm (151 per re-arm with the blur cached). `#armReflectionProbe
Capture(state, why)` now records WHICH closure went stale on `giRebuilds.log`
(`reflProbe-arm (bvhScene | srcProbes | emitter trace | dynSet | first arm |
sync)`), and the capture path builds ONE unbuilt kernel per frame
(`#warmKernelsOnePerFrame`) — the same probe stays due until all three are
warm. After a reload: trace 84, capture 122, blur 118 ms in three separate
blocks, worst task 229 (was 337). Boot's `gi: build (synchronous)` is still a
single ~2 s block (84 compute pipelines + the src kernel builds).

**The phone (the user: "starts with 55 fps then settles at 30").** Forcing
the phone's tier on the desktop probe (`--flags '{"__giDeviceTier":"low"}'`,
1086×501) prices the low-tier frame at 2.20 ms of RTX 4070: raster 0.83
(main pass 0.65, GI g-buffer 0.20, shadow map 0.08, output 0.13) and GI
compute 1.34 (resolve 0.32, gather 0.15, irradiance temporal 0.08, emitter
chain 0.12, movers 0.04, and the world chain 0.28 per frame = **~1.35 ms per
dispatch** at 15 Hz — deposit 0.55, shade 0.47, the rest 0.3). On a phone
(~9× slower by the observed 30 fps) that chain is about a frame on its own,
landing in ONE frame every 4th frame; every such frame overruns 16.7 ms and
iOS halves requestAnimationFrame — 55 while the chain's pipelines compile,
30 once it runs. At dpr 2 the raster also scales ×2.4 against this probe.
Shipped on the device tier (giConfig `worldUpdateHz` 15 / `worldSplit`
true; `__giWorldUpdateHz` / `__giWorldSplit` override): the chain is capped
at 15 Hz whatever the sun does and split at the deposit's trace across two
frames (§11.45). Probe with the tier forced: world 15.0 Hz, split, chains/s
14.98 (no halving at this cadence), p95 9.2 ms. NOT verified on the phone —
the model above is a desktop ledger scaled by one observed number.

**Dynamic resolution aimed at 120 on a 60 Hz phone** — that was the
pixelation behind the reverted "medium" auto-preset: the controller measured
every frame as over budget and sat at its 0.5 floor. `drsBudgetMs(targetFps,
peakCallbackFps)` (engine/dynamicResolution.js, `tests/dynamic-resolution
.test.mjs`) caps the aim at the PEAK callback rate the host has handed the
engine, so a Mobile preset with DRS on now holds the display's rate and buys
resolution back when it can.

**The instrument the phone was missing: `?hud=1`.** `src/player/hud.js` puts
the harness's numbers on the device — fps vs callback rate (fps 30 / cb 30 is
the browser halving; fps 30 / cb 60 is app-paced), frame / cpu / gpu ms,
canvas + dpr + scale + DRS, GI tier (and what it was clamped from), resolve
and emitter sizes, world Hz / split / chains / movers, and the per-pass GPU
ledger (`src/engine/passLedger.js`, the in-page copy of the probe's method;
empty where the adapter has no timestamp queries — Safari). Tap to copy.
`run-player-fps.mjs --hud` prints the same overlay on the desktop build.

Receipts (`.gi-shots/player-fps/`): `build-v3-desktop` 80.1 fps / GPU 10.7
at 2872×1532 (high, resolve 1299×693); `build-v4-desktop` 81.4 fps / 10.6
after the phone-tier changes (desktop unaffected, world 30 Hz under the
moving sun); `build-v3-phone-lowtier` and `build-v4-phone-lowtier` (the
ledgers above). Housekeeping owed: `viewportFreezeWhenUnfocused` was turned
OFF for the measurement runs (localStorage `engine.viewport.freezeWhenUnfocused`)
and the editor was closed before it could be restored — flip it back on in
Project Settings → Editor, or `viewport.setFreezeWhenUnfocused true`.

## 13. "Reflective materials ignore the lighting around them and look way too bright"

Two mechanisms, one per reflections tier, and the scene was on the wrong one
for the desktop after §12's rail change.

**Field-only reflections (rail ≤ medium, and EVERY phone by the device
tier).** The material's `directional` term is the lattice's bin radiance in
the reflected direction — a 4.5-36° cone average at a probe that floats
0.45-0.8 m off the surface. Facing an arcade, that bin sees the sky over the
atrium rather than the opposite wall: bright, and blind to the walls, exactly
as reported. The sun is already out of those bins (§11.53). This is the tier's
known limit (the R-B receipt: "the field lookup is a bin average"), not a bug
to fix in place; the fix is the tier.

**Exact reflections (rail high/ultra).** Per-pixel BVH hits paint the walls.
A ray that leaves the scene through the open roof fell through to the
env-on-miss tap — ONE equirect sample of the RAW HDRI, sun disc included,
thousands of times the sky around it, on every glossy patch the sky can
reach. The code comment had already named it "the worst-offending sharp-image
consumer". Shipped §11.53b: the sky poll publishes the sun ceiling (8 × p99.9,
the number §11.53 books) as `_giEnvMissCeilingU`; giLight's mirror tap and the
reflection-probe capture's miss scale their sample so its luma never exceeds
it (same chroma; 1e30 = no clamp when no sun was found or extraction is off;
`__giMirrorSunCeiling = false` keeps the sun in the mirror). Compiles clean
in the build (`build-v5-desktop-refl075`, 0 console errors).

**Where the rails stand.** §12 set the scene's reflections rail to 0.25 for
fps, which put the desktop on the field-only path too. Measured at 2872×1532
on the same build:

| reflections rail | exact path | fps | GPU ms |
|---|---|---|---|
| 0.25 (low) | off | 72-81 | 10.6-12.4 |
| 0.75 (high) | on | 63.9 | 14.2 |

The high rail costs ~2 ms of compute and still clears the 60 floor on this
canvas. It is the rail to ship for the desktop look (mirrors see walls; the
sun is capped now); the phone ignores it (device tier → low). The scene
change needs the editor: GI component `reflections` 0.75, then save.

## 14. The phone's own ledger (`?hud=1` on an iPhone, LAN preview, 21:40)

Safari DOES resolve timestamp queries. The overlay read, at canvas 780×1398
(dpr 3 capped to 2), GI low (from high), resolve 373×669, emitter 159×285:

```
fps 30  cb 31  frame 38.0 ms  cpu 7.4  gpu 44.8 (r 16.5 c …)
gpu ledger 44.49 ms/frame
   9.127 × 0.47  compute group      ← the GI world chain: ~19 ms PER DISPATCH
   8.754 × 1.00  "(ctx undefined)"  ← the cloth arena's compute chain (see below)
   6.375 × 1.00  main pass 780×1398
   5.953 × 1.00  canvas 780×1398    ← the post composite (volumetric fog) at full res
   2.974 × 0.27  compute group      ← world chain, second segment
   2.671 × 0.28  compute group      ← world chain, second segment
   2.425 × 1.00  ShadowMap 2048²
   2.312 × 0.53  compute group      ← movers-only half-rate screen chain (emitter shadows)
   1.952 × 1.00  output 373×669     ← the fog's half-res pass
   1.651 × 1.00  compute group      ← the per-frame screen chain (resolve, gather, AO)
```

`cb 31` is iOS having halved requestAnimationFrame. The ledger over-counts
on a tile GPU (passes overlap; 44.5 attributed against a 38 ms frame) but
the shares hold: **GI world chain ~33 %, cloth ~20 %, raster 14 + 5 %, post
composite + fog ~18 %, GI screen chain ~9 %.** The desktop model in §12 had
the world chain at 13 % — ray tracing is relatively far slower on the phone.

**Why two rows were unnamed.** three prefixes a timestamp uid `c:` only for
a bare ComputeNode; every ARRAY dispatch — GI's grouped batches and the cloth
arena's chains — is stamped `r:` and an array without an `id` stamps
`undefined`. The ledger (engine/passLedger.js and the probe's copy) now
labels by POOL and gives anonymous arrays an id in their own range, so the
next phone paste names the cloth rows.

**Shipped for the phone tier: the ray budget.** Three quarters of a chain
dispatch is the trace + shade, which are per-ray. giConfig `worldRayScale`
0.35 on the device tier rides the §11.9 motion-scale uniform (ceiling + cap,
no rebuild; `__giMobileRayScale` pins) — the same budget the temporal
accumulation already averages without visible noise under camera motion.
Expected: the 19 ms burst → ~9 ms, ~15 → ~7 ms/frame of the 45. Not yet
measured on the phone.

**Still on the table for 60 on the phone, in order of size:** the cloth
chain (~300 small dispatches a frame; dispatch overhead, not math — a
device-tier step or pass count is the cloth module's call, and its Jacobi
solver is not step-invariant), the volumetric-fog composite at full canvas
res (a mobile preset could run it at the fog's half res), dpr 1.5 for the
two raster passes, and the shadow map at 2048².

## 15. "Viewport still does not pause when unfocused" — the catch-up loop

`viewportFreezeWhenUnfocused` was OFF from the measurement runs (restored
via `viewport.setFreezeWhenUnfocused`), but the mechanism had a second hole:
`catchingUp` (a change still settling, 500 ms after any wake event) kept the
loop alive at the 20 fps catch-up rate regardless of window focus, and
Sponza's Rotator (run-in-editor) moves the sun EVERY frame — so `catchingUp`
never lapsed and the viewport drew forever behind the browser. Now a window
in the background (`freeze && !appFocused`) ignores catch-up; holds (a
detached profiler) and pins (a boot) still win. `profile.frameStats` reports
`viewportPacing` — every input the pacer read and the decision — so the next
"still drawing" report names its cause.

## 16. "Is the GI algorithm perfect?" — no; the evening's nulls and the ranked list

**The ray-budget null.** §14's device-tier `worldRayScale` 0.35 landed
(editor A/B with `__giMobileRayScale` 0.35: rays/frame 13 154 → 5 214) but
the deposit kernel went 1.671 → 1.415 ms (−15 %) and the shade 0.991 → 0.635
(−36 %) for −60 % rays; on the phone-shaped desktop rehearsal the per-dispatch
cost did not move at all (deposit 0.91, shade 0.79 ms per call). Cloth
proxies off (34 → 24 movers): deposit 1.371, shade 0.607 — not the movers
either. `srcDeposit.js` already records the same shape (`SWEEP=cap`: flat
below cap 32) and a twice-refuted indirect dispatch. So the transport's cost
has a FLOOR that is neither the ray count nor the mover set: candidates are
the two-segment far-field trace (41 % of rays trace twice), the per-ray
attribution atomics + `need` bin reads, and the per-worklist-entry setup
(cascade chain + block lookups before the ray loop). On the phone that
floor is ~19 ms per dispatch — the single largest item. Finding it needs the
`probe:gi-src-cost` harness with those three arms, not another cadence knob.

**What the frame says is structurally unoptimal, ranked by phone cost:**
1. The world transport's per-dispatch floor above (33 % of the phone frame).
2. The cloth arena: 10 members, 23 828 particles, 3 steps × 10 dispatches a
   frame at 360 Hz step rate, every frame, whatever is on screen (20 %).
   The solver is not step-invariant, so the lever is a per-member LOD
   (fewer steps for cloths far from the camera or out of view), not a rate.
3. The GI g-buffer prepass renders the full 954 k-triangle scene a second
   time at resolve resolution — on a phone that is vertex work, not fill.
4. The emitter-shadow chain on the desktop: 2.2 ms of a 3.1 ms screen chain
   at 785×486 for two emissive lights (per-pixel marched, movers every
   frame). A cheaper shape is a per-emitter shadow map for the static world
   with the march reserved for movers.
5. 71 dispatches per world tick (populate ×18, rays ×21, merge ×8, tiles ×4)
   — dispatch overhead that a phone pays in full; §11.56 grouping measured
   neutral on the desktop and was never measured on the phone.
6. The screen chain resolves every pixel every frame even on movers-only
   frames where the g-buffer is held.

**Shipped this pass, for the phone:** a portable-device shadow-map cap
(`MOBILE_SHADOW_MAP_MAX` 1024 per axis in LightComponent, `__engineShadowMapCap`
pins; `tests/device-quality-ceiling.test.mjs`) — the 2048² sun map read 2.4
ms on the phone; and the volumetric fog's joint-bilateral upsample runs the
3×3 kernel on portable devices instead of 5×5 (`__postJbuRadius` pins) — the
full-res composite read 6 ms. Neither is measured on the phone yet.

**Viewport freeze receipt.** `viewportPacing` read `held: true` in the
user's editor: the docked Performance Monitor holds the viewport awake by
design ("an instrument must not change what it measures"), and a hold wins
over an unfocused window. That is the remaining reason the viewport keeps
drawing behind the browser with the profiler panel open.

## 17. On-device A/Bs, and the glowing curtain hems

**`?flags=<json>` on a build's URL** sets dev globals before any module
loads — the phone's equivalent of `run-player-fps.mjs --flags`. With it come
runtime pins on the three GI rails (`__giBounceLevel` / `__giAoLevel` /
`__giReflectionsLevel`, read exactly like the authored value; `tests/gi-ultra-
budget.test.mjs`). The ledger also names unnamed render targets by shape and
camera now (`rt2x4+D@ortho:…`) instead of a minified class name ("Xi").

**"Reflectives are still too bright on mobile" (22:20 screenshot).** What
glows is the gold fringe along every curtain hem, uniformly warm-white, in a
corridor the sun cannot reach from below. On the phone tier the only
reflection source is the glossy gather (`createSrcGlossyGather`): per pixel,
`gatherAt(P, N, R).irradiance / π` — the lattice's radiance around the
reflected direction at the SHADING POINT'S PROBE, capped at luma 6. For a hem
on the corridor wall, R points back across the corridor toward the arcade and
the sunlit atrium; the probe that answers is the one whose cell holds the
hem — at 5-10 m that is cascade 1-2, a 0.9-1.8 m cell that straddles the
arcade — so the "reflection" is the atrium's radiance, at a metal's Fresnel,
next to cloth lit at albedo 0.3 under AO. Physically a gold fringe reflecting
a sunlit courtyard IS bright; what reads as wrong is that it reflects the
courtyard from inside a corridor that does not see it, which is the field
lookup's parallax limit (the R-B receipt: "the field lookup is a bin
average"), not a bug in any one term. The alternative hypothesis — sun
leaking under the hem through the (now 1024²) shadow map — is what the two
URLs below separate:

- `?hud=1&flags={"__giReflectionsLevel":0}` — hems go dark ⇒ the glossy term.
- `?hud=1&flags={"__engineShadowMapCap":0}` — hems go dark ⇒ shadow leak.

If it is the glossy term, the honest fixes are (a) an occlusion test on the
glossy gather (a short LOS march along R from P before trusting a bin that
lives across a wall — the gather already has the §15 U3 LOS machinery for
its diffuse taps), (b) a per-pixel cap tied to the local irradiance rather
than the fixed 6, or (c) reflection probes in the corridors (per-room
captures are parallax-anchored). (a) is the structural one.

**Also found:** the Camera's postprocess component is DISABLED
(`enabled: false`, 0 effects), so the volumetric fog was never part of the
phone frame and the two full-resolution passes on the phone (6.4 + 6.0 ms)
are the main pass plus one more full-res render nobody has named yet — the
new ledger labels will. The UI system does not render separately (it did
once; that was removed).

## 18. The second full-res pass was three's own, and the transport floor is a tail

**Named.** With the ledger labelling targets by shape and camera, the phone's
second full-resolution pass is `rt1` drawn by the perspective camera plus a
`canvas@ortho` quad: three's WebGPU renderer, whenever tone mapping is not
"none" or the output colour space is not the working space, renders the
scene into an offscreen half-float frame buffer and draws one full-screen
`outputColorTransform` quad onto the canvas (`Renderer.needsFrameBufferTarget`).
On the phone that was 6.4 + 6.0 ms; the postprocess component was disabled
and had nothing to do with it.

**Shipped: the inline output transform** (`src/engine/outputTransform.js`,
`tests/output-transform.test.mjs`). The renderer is told none/working, and
three's own `renderer.contextNode.value` gains a `getOutput` hook that
NodeMaterial calls at the end of every fragment flow — it wraps the colour in
`renderOutput(tone mapping, colour space)` only when the material is built for
the output target (`renderer.isOutputTarget`), so every offscreen render (GI
g-buffer, probe captures, the postprocess PassNode) stays linear. A render
override gets the real values back around its render (`withRealOutput`);
a tone-mapping change bumps the context node's version (one re-mint).
Installed after EVERY renderer construction — `init()` builds the first
renderer itself, the rebuild path builds the rest; the first draft only
covered the rebuild path and installed nothing. The player turns it on
(`config.directOutput`), `?flags={"__engineDirectOutput":false}` compares.

Desktop A/B at phone shape (throttled GPU, same run): on = one
`canvas:1086x501` pass, 5.11 ms GPU; off = `rt1` + `canvas@ortho`, 5.92 ms
(−14 %). The phone's own number is the one that matters — the saved pass is
a full-resolution tile load/store there.

**Transport floor, third arm.** `__giSrcFarDuty = false` (far-field arm
removed, far rays 0 %): deposit 1.403 ms — flat again. Rays (−60 %), movers
(−10), far field (gone) all leave the deposit dispatch at ~1.4 ms; only the
shade moves with rays. A dispatch's duration is its slowest workgroup, and
the trace is a binary BVH closest-hit with a 64-deep stack over 214 k
triangles: the floor is the TAIL — the longest ray in the batch — not the
throughput. That is what a ray budget cannot touch and what `SWEEP=cap`
saw flat below 32. Next arms: cap the traversal (a node-visit budget with
an early miss), a BVH8/wide node layout for the transport, or split the
batch by ray length class so short rays finish early.

**Shadow cap reverted.** The 1024² portable cap was rejected on sight
("1k shadows look extremely awful"); `MOBILE_SHADOW_MAP_MAX` is 0 and only
`__engineShadowMapCap` pins.

## 19. The algorithm, not the knobs: what the phone is actually paying for

Every arm run tonight changed the WORK inside the transport's kernels and
the cost did not follow:

| arm (editor, high, 785×486) | rays/frame | deposit ms | shade ms |
|---|---|---|---|
| baseline | 13 154 | 1.671 | 0.991 |
| ray scale 0.35 | 5 214 | 1.415 | 0.635 |
| cloth movers off (34 → 24) | 5 304 | 1.371 | 0.607 |
| far-field arm compiled out | 16 834 | 1.403 | 1.070 |
| reach capped at cascade 0 | 19 116 | 1.346 | 0.796 |
| counters compiled out, ceiling pinned 16 384 | (0 read) | 1.521 | 0.736 |
| counters on, same pin | 10 944-14 566 | 1.582-1.681 | 0.767-0.771 |

The deposit dispatch is ~1.4-1.6 ms whatever is inside it. On the phone the
same dispatch is ~19 ms. What DID scale on the phone's HUD is the number of
dispatches: the emitter chain (8 kernels over 45 k pixels) 4.4 ms per call,
the cloth arena (30 dispatches over 24 k particles) 8.75 ms, the world chain
(71 dispatches) 19 ms — all near 0.2-0.3 ms PER DISPATCH regardless of the
work inside. A tile GPU drains its pipeline at every compute dispatch
boundary (WebGPU puts a full barrier between dependent dispatches); on the
4070 that boundary is ~5 µs, which is why §11.56's grouped dispatch
"measured neutral" on the desktop — grouping shares a command buffer, it
does not remove boundaries. The desktop simply cannot see the phone's cost
model; only per-kernel rows on the device can, hence the one paste asked for:
`?hud=1&flags={"__giComputeGroups":false}` — if `src:populate#k` (a 2 µs
kernel on the desktop) reads ~0.2 ms each there, the model is confirmed.

**What follows for the algorithm, in order:**

1. **Fuse the chain's dispatches (71 → ~25-30).** Most of the 71 are the
   same kernel per cascade or per phase: populate = hash clear + age ×4 +
   pixel insert/compact/resolve + (insert/compact/resolve) ×3 cascades; rays =
   21 per-cascade allocation/prefix passes; merge 8; tiles 4; seed 4. Passes
   that are independent across cascades become ONE dispatch with the cascade
   derived from the thread index (threads partitioned by capacity offsets);
   only true dependencies (insert → compact → resolve) keep a boundary. On
   the phone that is ~−8 ms per tick at 0.2 ms a boundary; on the desktop it
   is neutral, so the gates (`test:gi-src-*`, `probe:gi-walk`) are the
   correctness check and the phone is the receipt.
2. **Separate placement from transport, and budget the transport per
   frame.** Today a tick is pixel-driven end to end: populate walks every
   resolve pixel, rays are allotted per pixel, then the world work runs —
   all of it in one burst at 15-30 Hz, which is the burst iOS halves its
   frame rate on. Placement (which probes exist) can stay pixel-driven at a
   low rate; the TRANSPORT (which probes get rays) should be probe-driven
   and steady: every frame, K probes by age/importance, R rays each from the
   probe centre, shade, bins — a constant ~5-dispatch cost per frame with no
   pixel-count term and no burst. That is the radiance-cache pattern
   (DDGI / Lumen's cache) and it is what the worklist machinery ([D5],
   `rayWork`) is already halfway to.
3. **Cloth: 30 dispatches → 3.** The arena is one buffer; three step
   dispatches over ALL members (member id per particle) replace 3 × 10.
4. **Screen chain on held frames.** When the g-buffer is held (movers-only
   frames) the gather/resolve outputs are also valid; only the movers'
   shadow term needs a dispatch. Static views on the phone drop ~4 ms.
5. **The g-buffer prepass** (a second full-scene raster, ~2 ms on the
   phone): write GI's position/normal from the main pass (MRT) and consume
   them one frame late with reprojection.
6. **Emitter shadows** (desktop's largest screen pass, 2.2 of 3.1 ms):
   cube shadow maps for the static world per emitter, the per-pixel march
   only for movers.

Items 1 and 3 are mechanical and gate-checked; 2 is the redesign that
removes the phone's burst for good. The transport-floor question of §18
(what makes one dispatch 1.5 ms on the desktop) stays open — it is a
profiler question, and it is a small number next to the dispatch count.

### 19b. Correction, same evening: it is traversal, not dispatch count

Re-reading the phone HUD against the desktop ledger by GROUP, the phone/4070
ratio is not uniform per dispatch — it tracks what the kernels DO:

| group (same build, same tier) | 4070 | iPhone | ratio |
|---|---|---|---|
| per-frame screen chain (resolve, gather, AO, temporal — ~10 kernels) | 0.62 ms | 1.65 ms | 2.7× |
| main pass (raster) | 0.65 | 6.4 | 10× |
| GI g-buffer prepass (raster at resolve res) | 0.13 | 1.95 | 15× |
| world chain per dispatch (BVH trace + NEE rays) | 2.2 | 19.4 | 9× |
| emitter shadow chain per call (per-pixel march, 8 kernels) | 0.25 | 4.4 | 18× |

Ten small screen kernels are the CHEAPEST group on the phone, so a fixed
per-dispatch cost is not the model — §19's first paragraph is withdrawn. The
expensive groups are the ones that TRAVERSE (BVH closest-hit, mover tests,
the emitter march) and the ones that rasterise the whole scene. Also
corrected: the cloth is not 30 dispatches — it is 3 arena-wide step
dispatches per 1/120 s of real time (12 per frame at 30 fps, a fixed
1/360 s step) plus one surface kernel per visible member; its 8.75 ms is
solver work that grows as the frame rate falls.

**The plan, re-ranked on that evidence (phone cost in brackets):**
1. Emitter shadows without a per-pixel march [2.3 ms/frame]: the static
   world is already cached at stride 4; the remaining march is the movers.
   Replace it with a small per-emitter shadow map of the movers only (34
   objects, two emitters) sampled per pixel — a texture read where a mover
   traversal was.
2. Transport traversal work [~5 ms/frame avg, 19 ms bursts]: the opt-in
   probe→light visibility cache (§11.44, `visMarchedPerFrame` 11 k per tick
   on desktop) once it passes the look check; any-hit for NEE rays where
   closest-hit is used; the far-field second segment at a lower duty.
3. The g-buffer prepass [1.95 ms]: MRT from the main pass, consumed one frame
   late.
4. Cloth [8.75 ms at 30 fps]: the step count is real time ÷ 1/360 s; at 30
   fps that is 12 steps a frame, each a full collision pass. Cheaper contact
   (broadphase per particle, or contact every other step) rather than a
   larger step — the solver is not step-invariant.
5. dpr 1.5 via the Mobile preset [~3 ms of raster]: the user's call on look.
Dispatch fusion stays a desktop-neutral tidy-up, not a phone lever.

### 19c. First traversal lever: the §11.44 visibility cache, armed for a look check

`__giSrcVisCache = true` (editor, high, 785×486, sun rotating):

| | hits/frame | shade ms | ns per hit | vis served from cache |
|---|---|---|---|---|
| cache off (baseline, two reads) | 13 154 / 16 834 | 0.991 / 1.070 | 75 / 64 | 0 % |
| cache on, ~40 s after arm | 22 508 / 29 800 | 0.931 / 1.004 | 41 / 34 | 34 % / 38 % |

The shade's cost per hit roughly halves at a third served; the cache is
still converging (K = 4 samples per cell × lamp row, 1-in-8 re-marched for
honesty). It is a pure traversal saving — exactly the class the phone pays
18× for. It stays OPT-IN until the user's look check passes (§11.46: it once
"lost its colour and atmosphere"); it is armed in the editor now for that
look. `profile.giFlag __giSrcVisCache null` disarms.

## 20. The phone's second-largest item was the sun's VSM chain — and the instrument that found it

**Per-kernel phone paste (landscape, `__giComputeGroups:false`), 45 ms:**
main pass 12.0 · two RG16F 2048² ortho passes 8.5 · seventeen separate
GI compute passes (mover refits, split apart by the A/B flag) 7.3 · cloth
4.8 · sun shadow depth 1.9 · GI g-buffer 1.8 · deposit 1.9 (4.9 per dispatch)
· shade 1.5 · gather 0.9 · decay 0.85 (2.1 per dispatch).

Two corrections to §19b from it: (1) the per-PASS cost is real — the same
17 refit kernels cost ~1 ms as one grouped pass and 7.3 ms as seventeen
passes (~0.4 ms per compute pass on this iPhone); the default build groups
them, so nothing to fix there, but every separate `renderer.compute` call on
a phone is 0.4 ms before it does anything. (2) The direct output (§18) bought
~0.3 ms on the phone, not 6: the earlier "canvas quad" was the main pass's
tile flush attributed to the last pass.

**The two 2048² passes.** Reproduced on the desktop by giving the probe an
iPhone user agent (`run-player-fps.mjs --mobile`, which takes every
portable branch on the 4070) and labelling unnamed targets by format:
`rt1:1030/1016@ortho` = RG / HalfFloat with an orthographic quad camera —
three's VSM vertical + horizontal blur. The exported scene now carries
`shadow.type: VSMShadowMap` (switched this evening; the light's retired
per-light prop says the same), so every platform renders the 2048² depth map
plus two full-size blur passes each frame: 0.4 ms on the desktop, 10.4 ms on
the phone (23 %).

**Shipped: a shadow update stride on portable devices** (`src/engine/
shadowUpdateStride.js`, applied by the shadow-freeze walker exactly where it
cannot freeze — a scene with a deforming caster — and only to lights it does
not own; `tests/shadow-update-stride.test.mjs`). Phones render their maps
every second frame; three's `needsUpdate || autoUpdate` gate carries the VSM
blur with it. Probe with the iPhone UA: `ShadowMap × 0.5` per frame, the
blur pair at half its cost, no errors. Expected on the phone: −5 ms of 45.
`__engineShadowUpdateStride` pins (1 = every frame).

**Open from the same paste:** the transport's decay pass walks the whole bin
capacity each tick (2.1 ms per dispatch on the phone for ~2 % live) — a
live-block worklist is the fix; and the main pass at 12 ms is the largest
item and belongs to raster + the GI material sampling, where dpr is the
lever.

## 21. Shipped: the visibility cache; and the hem is not the reflected-lattice lookup

**Vis cache default ON (2026-09-12).** The look check §11.46 asked for was
run on Sponza with the cache off then on ("looks fine to me after rearm");
`srcSystem.js` now arms it unless `__giSrcVisCache = false`. Receipt in
§19c: shade 75 → 41 ns per hit at a third served. The persisted editor flag
was cleared; the build carries the default.

**The hems, measured.** `profile.giGlossyStats` (new; a 64×64 readback of
the glossy target against the irradiance target — 8-bit units, HDR clips at
255) read the reflected-lattice lookup at p95 ≈ 0.05 luma, max 0.11, against
the diffuse target's p95 ≈ 0.65 — the lookup is DIM everywhere, and moving
it one cell along R (§17's offset, now a live uniform `__giGlossyRayOffset`)
changed nothing on the phone ("glowing"). So the hem's light is the other
half of the material's reflection term: `spec = mix(directional + glow,
irradiance/π, smoothstep(0.22, 0.6, roughness))` — for a rough gold fringe
that is the diffuse irradiance at a metal's Fresnel (≈ 0.9 × E/π against the
cloth's 0.3 × E/π × AO) — or the emitter-shape glow highlight. The user's
next URL (`?hud=1&flags={"__giGlossyCap":0.001}`) separates the two; the
fix lives in giLight's composite either way, not in the gather.

## 22. The glowing hems were VSM light bleeding — not GI

Isolation on the editor, one variable at a time, each with the user looking:
reflection rail 0 → dark (so: the reflection term carries it); reflected-
lattice lookup capped to 0.001 → still glowing (not the lookup); sky lighting
0 → still glowing (not the sky); §12.88 normal bias 0.4 m → still glowing
(not a trilinear straddle); sun intensity 0 → **correct** (it is the sun);
scene shadow type VSM → PCF soft → **correct in the editor**, while the phone
on the previous export (still VSM) kept glowing.

Mechanism: variance shadow maps light-bleed wherever a thin occluder sits a
short distance in front of a farther receiver inside the blur kernel — a
curtain hem hanging above the floor is the textbook case. The bleed puts the
sun's direct term on the hem's shadowed side; the gold fringe (metal, F0 ≈
0.9) shows it at full strength, the dark cloth beside it barely, and linear
tone mapping clips the result to white. The scene had been switched to VSM
this evening (§20); with it went 10.4 ms of the phone frame.

Shipped: the scene's shadow type is PCF soft again (saved); the glossy
lookup offset (§17/§21) is back to 0 by default — it was chasing the wrong
cause. `profile.giGlossyStats` stays as a receipt. Soft sun shadows without
bleeding are the PCSS filter, if wanted.

## 23. Phone receipts after PCF: 45 fps; the dispatch floor is real after all; the shadow map rendered twice

**45 fps** (frame 21-26 ms, GPU 23-26) from 28-30 at the start of the
evening: VSM → PCF soft (−10 ms), the shadow stride, the vis cache, the
direct output. The phone's GI targets read the same as the desktop's
(irradiance mean 30 vs 29, glossy 8.7 vs 8.5) and the materials decode the
same (colour maps sRGB, metal-roughness linear; only the compressed formats
differ — ETC2/ASTC there, BC7 here).

**§19b withdrawn in its turn.** The cloth GI proxies' eleven refit kernels
— 128 threads each, 0.004 ms each on the 4070 — read **5.3 ms per frame on
the phone as ONE grouped pass** (`c:gi:unnamed ×11` at 1.49 calls): ~0.3 ms
per dispatch of trivial work. That is the per-dispatch floor §19 proposed
and §19b argued away with the "cheapest group" ratio — which was the floor
too (ten small screen kernels at ~0.16 ms each). The model that fits every
row: **cost ≈ 0.15-0.3 ms per dispatch + the kernel's work at 9-18× the
desktop**. Fusion therefore matters on the phone exactly where the kernels
are small and many: the refits (11 → 1), the world chain's per-cascade
passes (71 → ~25), the screen chain (10 → ~4). §19's plan stands.

**`ShadowMap@ortho × 2.00`** is not a double render: the user switched the
sun to CSM with two cascades for shadow quality, and is willing to pay for
it (3.5 ms on the phone). What the row does show is that the stride did not
reach the cascade lights (2.00 per frame, not 1.00); the stride now writes
the flag both ways (`needsUpdate = due`) and is being extended to cascades.

**Hems**: still glowing on the phone with PCF, identical GI and materials,
and cleared of every player-only path. Remaining variable: the viewpoint.
The HUD now prints the camera pose so the editor can be placed exactly
there for a same-view comparison.

## 24. The phone's glowing hems — what the desktop can and cannot say (09-12)

A numbers-only probe (`scratch/hem-probe.mjs`: headless Chrome, camera world
matrix pinned to the phone's pose, the sun sweep frozen at fixed phases, one
frame reduced to luma percentiles + warm-white pixel counts + 8x8 grids) ran
the exported build under: the desktop UA; the iPhone UA (device tier low,
world 15 Hz split, ray scale 0.35, platform variants); the desktop UA with
`__giDeviceTier:"low"`; `__giKeepIBL:true`; `__giProbeShadows:false`. None
reproduced a warm-white hem at the phone's pose (phases 0.25/0.5/0.75 give
0 warm-white pixels on every clean arm). Contaminated arms — four Chromes on
one GPU, or a capture during a GI rebuild's stand-in frames — DID show bright
clusters; every one traced to a transient, not a config. The remaining
variables are the device itself: Apple GPU/Safari WebGPU, ETC2/ASTC
textures, the in-browser static BVH build. Receipts shipped for the phone:
HUD lines `env …` (IBL blackout state) and `probes N … atlas(8-bit) …`
(reflection-probe rounds + atlas readback; the atlas readback reads 0 on the
desktop even with rounds advancing — treat it as blind until proven). Pins
for on-device arms: `__giReflectionProbes:false`, `__giProbeShadows:false`,
`__giKeepIBL:true`, `__giDeviceTier:null`.

## 25. The glowing hems were the scene-AABB fallback probe (09-12)

`?flags={"__giReflectionProbes":false}` on the phone went dark: the carrier
was the reflection-probe term. With no authored rooms and no hand probes the
GI synthesizes ONE box-projected probe over the whole content AABB when its
XZ span is under a Bistro-derived 48 m; Sponza (30 x 18 m, courtyard ringed
by arcades) qualified, its capture point is the sunlit atrium centre, and box
projection handed every arcade metal the courtyard through the walls. The
editor never creates the fallback; the desktop build creates it but its
capture reads black after 8-9 rounds (open), which is why only the phone
showed it. Shipped: `AUTO_PROBE_MAX_SPAN_M = 20` (`autoProbeSpanOk`,
`tests/gi-auto-probe-span.test.mjs`); Sponza logs "fallback declined -
content spans 30m". Follow-up: a capture-depth fidelity test instead of a
span bound. Also in the HUD now: `backend` (webgpu vs WebGL fallback,
adapter, f16/timestamp features, browser) for the iOS Chrome vs Safari fps
question.
