// SPLIT RADIANCE CASCADES — the GISystem entry point.
//
// Plan §7: "GISystem grows one `backend === "split-rc"` branch that early-outs
// into `srcSystem`, not tentacles." This is that early-out. Everything SRC
// needs from the engine arrives through the four arguments below; everything
// GISystem needs from SRC is on the returned object. Neither knows anything
// else about the other, which is the only reason the Phase-2/3 work can grow
// underneath this without turning into a sweep through a 7,000-line file.
//
// ══ ON BY DEFAULT SINCE PHASE 5 LANDED (user decision, 2026-08-11) ═════════
//
// `__giSrcProbes` defaulted OFF through Phases 1–4 because the population
// produced no light — the transport deposited zeros, so on-by-default would
// have cost GPU time for nothing and made every §12 number incomparable. That
// rationale died with Phase 5: hit shading is landed and wired (§12.28–§12.29),
// SRC is the ONLY diffuse-indirect term this module has (§12.8 deleted the
// dense cascades), so off-by-default meant every project shipped with no bounce
// unless someone typed a console flag before boot.
//
// `__giSrcProbes = false` is the EXPLICIT opt-out (R12: the hatch is a flag,
// not a rebuild) — it is what a harness pins to measure the legacy-only screen
// chain, and any comparison against numbers recorded before this flip must pin
// it. `smoke:gi-gpu`'s non-src arms and the emitter-shadow probe do exactly
// that.
//
// ══ THE ANCHOR, WHICH IS THE ONE THING HERE THAT IS NOT OBVIOUS ════════════
//
// Probe keys carry cell coordinates in 9 bits per axis, RELATIVE to a lattice
// anchor. At LOD 0 that window is ±256·s₀ — about ±128 m at the default s₀ —
// so an anchor pinned at the world origin makes every near-camera probe
// unrepresentable the moment the player walks 130 m away. `packProbeKey`
// returns EMPTY there, which is correct and silent: GI simply stops having
// probes, and the symptom is a scene that lights fine at spawn and goes flat
// after a walk.
//
// So the anchor follows the camera — but NOT per frame. Re-anchoring re-keys
// every probe, which retires every probe, which is precisely the binary
// per-frame flip R1 forbids. It happens when the camera has drifted past
// `REANCHOR_CHEBYSHEV` (64·s₀, comfortably inside the 254·s₀ the window
// actually allows) and not before.
//
// One property makes this cheap, and it is worth stating because it is not
// obvious from the code: `latticeOrigin(anchor, s) = round(anchor/s)·s` is
// ALWAYS a multiple of s, so every lattice is world-aligned regardless of where
// the anchor sits. **Re-anchoring never moves a probe.** It only renumbers it.
// The cost is a lost temporal history, not a spatial pop.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.1, §4.2, §7 Phase 1.

import * as THREE from "three/webgpu";
import { Fn, Return, atomicStore, float, floor, If, instanceIndex, instancedArray, int, ivec2, ivec3, step, texture, uint, uniform, vec3 } from "three/tsl";
import {
  ALPHA_TRACK_HOLD_MS, BIN_BUDGET, CAM_SETTLE_ALPHA, CASCADE_COUNT, COLD_GUARD_FRAMES, GOV_HI, GOV_LO, MAX_LODS,
  LIGHT_SETTLE_FADE_MS, LIGHT_SETTLE_HOLD_MS,
  PROBE_RAY_CAP_OFF, REST_BOOT_HOLD_MS, REST_CAM_FADE_MS, REST_CAM_HOLD_MS,
  REST_TRANSPORT_FRACTION,
  SEED_RAYS, SEED_RAYS_FAR, SRC_QUALITY, STARVE_PACKETS, STARVE_RAYS, SUM_SHIFT, SURPRISE_ONE, TEMPORAL_ALPHA,
  TEMPORAL_ALPHA_STILL, W0, binCount, lod0Reach, srcBinCeiling, srcProbeRayCap, srcQualityTier, srcTransportRays,
  sunSplitArmed,
} from "./srcConfig.js";
import { loopAlbedoCeiling } from "./srcConfig.js";
import { createSrcProbeGizmos } from "./srcGizmos.js";
import { R2_ALPHA1_FX, R2_ALPHA2_FX, gatherNormalBias, gatherPlaneDepth, gatherSmoothWeights, unpackProbeKey, worldKeysEnabled } from "./srcMath.js";
import { hashKey, packProbeKey } from "./srcMathTsl.js";
import {
  createSrcBlockLookupDirect,
  createSrcHashBlockFrame,
  createSrcProbeFrame,
  createSrcProbeStore,
  formatSrcProbeStats,
  readSrcProbeStats,
} from "./srcProbes.js";
import {
  DEPOSIT_SCALE, SEC_HIT_WORDS, createSrcBinStore, createSrcDepositFrame, createSrcShadeCounters,
} from "./srcDeposit.js";
// §11.13's instrument: the bin-count histogram behind `__giProfileBinHistogram`
// reads the probe table and the bin words by their layout constants.
import * as SrcProbesNS from "./srcProbes.js";
import * as SrcDepositNS from "./srcDeposit.js";
import { createSrcHitAttribution, createSrcHitLighting, createSrcHitShader, sunTerm } from "./srcShade.js";
import { createLightTreeEmitterEval, createLightTreeSampler } from "./lightTreeGpu.js";
import { createSrcMergeFrame, formatSrcMerge } from "./srcMerge.js";
import { createSrcSeedFrame, formatSrcSeed } from "./srcSeed.js";
import { createSrcSecondaryFrame, formatSrcSecondary } from "./srcSecondary.js";
import { createSrcSecondaryReceivers, SECONDARY_RECEIVER_CAPACITY } from "./srcSecondaryReceivers.js";
import { createSrcGlossyGather, createSrcScreenGather, formatSrcGather } from "./srcScreenGather.js";
import { createSrcTileAtlas, formatSrcTiles } from "./srcTiles.js";
import { createSrcRayFrame, createSrcRayStore } from "./srcRays.js";
import { createSrcSceneTrace, createSrcVisibility, ifMoverHit, moverSurfaceAt } from "./srcTrace.js";
import { createSrcBvhSceneTrace, createSrcBvhVisibility } from "./srcBvhTrace.js";

/**
 * Camera drift, in units of s₀, that triggers a re-anchor — DERIVED from the
 * key window, not chosen.
 *
 * ⭐⭐ THE OLD VALUE WAS 64 AND IT FIRED INSIDE THE USER'S HOUSE. The header
 * above called 64 "comfortably inside the 254·s₀ the window actually allows",
 * which is true and was never the question: 64·s₀ at ultra (s₀ = 0.35) is
 * **22.4 m**, and their Level is **27.6 m** long. Their console, mid-play,
 * 2026-08-24:
 *
 *     00:40:20  [gi] src probes: re-anchored (#2) — every probe re-keys, which retires it
 *     00:40:39  [gi] src probes: re-anchored (#3) — every probe re-keys, which retires it
 *
 * Nineteen seconds apart. A re-anchor RETIRES EVERY PROBE IN THE SCENE, so the
 * whole field goes cold and re-converges from nothing — twice, while walking
 * the length of one house. That is the user's report word for word ("still mud
 * everywhere as I move"), and it is a WHOLE-FIELD reset, not a local artifact.
 *
 * ⚠ AND IT HID BEHIND A TIER. At `high` (s₀ = 0.45) the radius is 28.8 m, just
 * past the 27.6 m scene, so it never fires — which is why every headless probe
 * run at QUALITY=high measured a scene that never re-anchors, and why the note
 * in this project's memory read "cannot fire indoors". The user runs ULTRA. A
 * threshold that lands on one side of the scene at one tier and the other side
 * at the next tier is not a threshold, it is a coin flip.
 *
 * THE DERIVATION. Probe cells are packed as 9-bit signed offsets from the
 * anchor (`KEY_AXIS_RANGE` 512, `KEY_AXIS_OFFSET` 256 in srcMath), so an offset
 * must stay inside ±254 cells to be representable at all — past it
 * `packProbeKey` returns EMPTY and the probe silently does not exist. Probes
 * are placed around the CAMERA and LOD 0 reaches `lod0Reach()` cells past it,
 * so the furthest live cell sits at `drift + reach` from the anchor:
 *
 *     drift + reach ≤ 254        →  drift ≤ 254 − reach
 *
 * minus one `ANCHOR_QUANTUM` for the frame in which the threshold is crossed.
 * At the shipped reach of 64 that is **174 cells** — 60.9 m at ultra, 78.3 m at
 * high, 139 m at low. Every one of those is past any interior, so the re-anchor
 * goes back to being what the header says it is: the thing that saves a player
 * who walks 130 m away, and nothing that happens indoors at any tier.
 *
 * ⚠ It is computed from `lod0Reach()` rather than the constant because §12.90
 * can scale the reach; a bigger reach must SHRINK this, and hard-coding 174
 * would let the two drift apart silently.
 */
const KEY_SAFE_CELLS = 254;
const reanchorChebyshev = () =>
  Math.max(ANCHOR_QUANTUM * 2, KEY_SAFE_CELLS - lod0Reach() - ANCHOR_QUANTUM);
/** The anchor snaps to multiples of this many s₀, so it moves in whole steps. */
const ANCHOR_QUANTUM = 16;
/** Per-frame camera deltas that count as "panning" for the §12.45.2 cap lift:
 *  5 mm translation, 0.1° rotation — above orbit-damping jitter, below any
 *  deliberate pan. */
const CAM_LIFT_POS = 0.005;
const CAM_LIFT_ROT = 0.0017;

/** Is the SRC probe population compiled into this build? ON unless explicitly
 *  opted out — see the header. `__giSrcProbes = false` is the hatch. */
export function srcProbesEnabled() {
  return globalThis.__giSrcProbes !== false;
}

/**
 * Is SRC HIT SHADING on? The single source of truth for it, because the flag is
 * read in two places that must not disagree: here, to build the shader, and in
 * `GISystem`'s field construction, to allocate the surface attribution region
 * the shader reads. A field built without the region and a shader built
 * expecting one is a throw at best and a grey world at worst, and they are
 * separated by a full rebuild — so they read one function.
 *
 * ⚠ **IT FOLLOWS `__giSrcProbes`, AND THAT IS A FIX, NOT A CONVENIENCE.**
 *
 * These were two independent opt-ins, and one of the four combinations —
 * probes ON, shading OFF — RENDERS A BLACK SCENE. Not dimmer: the eye check
 * measures 4.0% of pixels lit against 68.2% with shading on (§12.30.1).
 *
 * It is nobody's bug. `createGiResolve` takes SRC's screen gather as the
 * PRIMARY diffuse term and switches the legacy closure off against it
 * (`if (gather && !screenGather)`, giScreen.js) because since [I] the two are
 * the same integral and running both would add a pixel's irradiance to itself.
 * So turning probes on REPLACES the working diffuse term with SRC's — and
 * before Phase 5, SRC's carried sky only. The renderer is behaving perfectly
 * and the screen is black.
 *
 * That state cost a full day: the black frame was read as a broken transport
 * and chased through `maxL`, step budgets, attribution and the shadow bias,
 * none of which were wrong. A flag combination that is guaranteed-black is not
 * a diagnostic state worth preserving by default, so shading is on whenever
 * probes are. `__giSrcShade = false` stays as the EXPLICIT opt-out the sky-only
 * gates still need — the difference is that you now have to ask for it.
 */
export function srcShadeEnabled() {
  if (globalThis.__giSrcShade === false) return false;
  return globalThis.__giSrcShade === true || srcProbesEnabled();
}

/**
 * Expected live c0 probes, from the gbuffer's pixel count.
 *
 * A c0 probe is a unique visible SURFACE CELL, so the count is bounded by
 * pixels but is nowhere near them — the population gate measures 410 probes for
 * 4,687 pixels on a room-plus-shells set, and the paper's own figure is 30–80k
 * for a 1080p frame. A quarter of the pixel count is comfortably above both and
 * is what the ≤0.5 hash load factor is then derived from; the telemetry prints
 * the real load every frame, so a scene that disagrees says so rather than
 * quietly dropping inserts.
 */
function expectedC0Probes(pixelCount) {
  return Math.min(131072, Math.max(16384, 1 << Math.ceil(Math.log2(Math.max(1, pixelCount / 4)))));
}

/**
 * §12.77 Unit A — the pools START at these floors and GROW ON PRESSURE, they
 * are no longer allocated to the pixel proxy up front. The floors are the
 * §12.77.1 treatment arms, measured on the banner Sponza: capacity-proportional
 * passes 3.61 → 1.19 ms, store 88.2 → 47.7 MB, with failedInserts/noBlock/
 * clamped ZERO and rays/hits/deposits identical to 0.2%. 700k bins ≈ 24 MB also
 * sits under the 4070's L2, which is where the superlinear decay win lives —
 * the sizing target is "under L2", not a ratio. A scene the floors starve says
 * so in the counters (`failed`, `noBlock` — per frame, one tiny readback), and
 * GISystem's pressure check doubles the starved pool toward `srcPoolCeilings`
 * and rebuilds through the same path a resize takes. Growth reacts within
 * ~a second; §12.52.2's record-pool starvation (the enclosed-scene wash) is
 * what an UNGUARDED shrink looks like, which is why the guard ships first,
 * in the same change.
 */
export const SRC_POOL_FLOORS = { c0Probes: 16384, binBudget: 700_000 };

/**
 * Where growth stops: the slot ceiling is the old up-front allocation (now
 * the worst case); the bin ceiling FOLLOWS THE DEVICE (§11.4 A2 — see
 * `srcBinCeiling`), with `BIN_BUDGET` as what a portable 128 MiB binding
 * gets. `reserveBytes` is what else rides the scratch binding ([J]'s hit list
 * and the per-block statistics); a built system passes its own through
 * `poolCeilings()`, which is the form GISystem's ladder should read.
 */
export function srcPoolCeilings(pixelCount, { deviceLimit = 0, reserveBytes = 0 } = {}) {
  return {
    c0Probes: expectedC0Probes(pixelCount),
    binBudget: deviceLimit > 0 ? srcBinCeiling({ deviceLimitBytes: deviceLimit, reserveBytes }) : BIN_BUDGET,
  };
}

/**
 * Build the SRC probe population bound to one gbuffer.
 *
 * @param {object} options
 * @param {object} options.gbuffer  from `createGiGBuffer` — `position` is
 *   `vec4(worldPos, 1)` at full float, and its `w` IS the validity bit the
 *   resolve already keys off. Nothing new is rendered for SRC (plan §7:
 *   "Reuses gbuffer").
 * @param {number} options.width  gbuffer width — the resolve's half-res, not the
 *   viewport's
 * @param {number} options.height
 * @param {object} [options.props]  the component props, for the quality tier
 * @param {object} [options.volume]  `createSrcVolume`'s bundle. OPTIONAL, and
 *   the population is fully functional without it — it buys exactly one thing,
 *   the scaffold ray pass below, which needs `occupancyField` + `world` and is
 *   the only part of SRC that touches the medium so far. The standalone gate
 *   pages have no engine and therefore no volume; they build the frame and
 *   nothing else, which is what keeps them standalone.
 * @param {object} [options.lighting]  `{ sun, emitters }` for hit shading —
 *   `sun` is `{direction, irradiance}` (direction TOWARD the light), `emitters`
 *   is `giLight.js`'s slot array. Phase 5. See `shadeHit` below for why this and
 *   `staticSurfaceAt` are two arguments rather than one switch.
 * @param {object} [options.surfaces]  `srcSurface.js`'s bundle — `{surfaceAt,
 *   passes, sync}`. The whole bundle rather than the read closure alone, because
 *   the attribution owns a compute pass (the palette upload) that must run
 *   BEFORE the deposit reads it, and a `sync` that makes a material recolour a
 *   512-entry buffer write instead of a re-voxelize. Movers need none of it;
 *   they carry their surface in their own object header.
 */
export function createSrcProbeSystem({
  gbuffer, width, height, props = null, volume = null, sky = null,
  // §16 S1 — the DIRECTIONAL sky bundle ({ node, intensity, rotY }), threaded
  // to the merge's top-cascade close and the tiles' residual composite. Null
  // (every fixture) keeps the flat `sky` path bit-identical.
  skyEnv = null,
  // §11.16: `{ node }` — GISystem's far-field texture, the fresh-probe seed's
  // prior of last resort (srcSeed's header). Null in every fixture.
  farField = null,
  lighting = null, surfaces = null, sceneMotion = null, trackMotion = null,
  // §10: `{ dyn }` — the dynamic-object set that owns the static BVH8. When
  // given, the transport traces the BVH (srcBvhTrace.js) instead of the
  // occupancy pyramid, and hits are attributed by slot (`surfaces.surfaceAtHit`).
  bvhTrace = null,
  pools = null,
  // §11.4 A2 — the device's storage limit in BYTES (`min(maxStorageBuffer-
  // BindingSize, maxBufferSize)`), which bounds the bin store's single scratch
  // binding and therefore the pool ceiling. The portable default is what every
  // fixture gets; GISystem passes the real device's.
  deviceLimit = 128 * 1024 * 1024,
  // §12.90 — the SCENE-DERIVED gather lattice, or undefined to keep the tier's.
  // GISystem's separator census picks it; see its ledger for why a tier
  // constant was the wrong shape (it made the gather's stencil reach 1.8× the
  // user's 0.25 m walls, and no corner weighting can undo that).
  spacing0: spacing0Override = undefined,
} = {}) {
  const tier = SRC_QUALITY[srcQualityTier(props)];
  // Precedence: the instrument hatch outranks the scene rule outranks the tier.
  // `__giSrcSpacing0` stays first so every probe that pins it still means what
  // the arm that set it meant.
  const spacing0 = Number(globalThis.__giSrcSpacing0)
    || (Number.isFinite(spacing0Override) && spacing0Override > 0 ? spacing0Override : 0)
    || tier.spacing0;
  // §11.52 — THIS BUILD'S sky tables. `skyEnv.tables` is the shared manager
  // (GISystem owns it, one integration per environment change); a build must
  // bind its OWN attributes because the teardown retires everything the
  // stale state published or bound (srcSkyBins.js's header). `skyEnv` itself
  // stays the shared bundle for the resize path, which begins its own build.
  const skyEnvBuild = skyEnv?.tables?.beginBuild
    ? { ...skyEnv, tables: skyEnv.tables.beginBuild() }
    : skyEnv;
  const pixelCount = width * height;
  // Opt-in while the unseen-surface continuation is measured against the
  // tracer. This tail shares the existing ray ceiling, not an extra budget.
  const secondaryReceiversOn = globalThis.__giSrcSecondaryReceivers === true
    && !!volume?.occupancyField && srcShadeEnabled() && !!lighting
    && !!(surfaces?.surfaceAt || surfaces?.surfaceAtHit)
    && globalThis.__giSrcSplitShade !== false && tier.secondary !== false
    && globalThis.__giSrcSecondary !== false;
  const receiverCapacity = secondaryReceiversOn
    ? Math.max(1, Math.min(SECONDARY_RECEIVER_CAPACITY,
        Math.floor(Number(globalThis.__giSrcSecondaryReceiverCapacity) || SECONDARY_RECEIVER_CAPACITY)))
    : 0;
  const secondaryReceivers = receiverCapacity
    ? createSrcSecondaryReceivers({ capacity: receiverCapacity }) : null;
  let activePixelCount = pixelCount + receiverCapacity;
  // Screen-local lookup/ray buffers are capacity-sized once. A viewport
  // resize then changes active dispatch counts and uniforms, while the world
  // probe/bin store (and its converged lighting) stays alive. The default
  // matches GISystem's portable resolve-pixel ceiling; an explicit larger
  // first build still wins.
  const pixelCapacity = Math.max(
    pixelCount,
    Math.ceil(Number(globalThis.__giSrcPixelCapacity)
      || Number(props?.resolveMaxPixels)
      || pixelCount),
  ) + receiverCapacity;

  // Resolved pool sizes, floors-first (§12.77 Unit A). Precedence: the FIXED
  // hatches (`__giSrcC0Probes`/`__giSrcBinBudget` — freeze the pool for a
  // deterministic A/B arm; GISystem also suspends growth while either is set)
  // > `pools` (GISystem's grown state, carried across rebuilds) >
  // `__giSrcPoolInit` (growth-PERMITTED initial sizes, for exercising the
  // grow path in a harness) > the floors.
  const initHatch = globalThis.__giSrcPoolInit ?? null;
  // §11.7 — THE FLOOR FOLLOWS THE DEVICE TOO. Every pool grow is a probe-
  // store rebuild: a cold field and a recompile of the 68 SRC kernels, which
  // the user reads as "GI drops to ambient for a minute, then a freeze". On
  // a desktop-class ceiling (≥ 8 M bins) the boot floor was 2.8 M bins /
  // 32 768 c0 slots — 78 MB, an amount this adapter does not notice — so a
  // Bistro-class scene boots without a rung and a full walk costs at most
  // one; the portable floor stays the measured-clean 700 k.
  //
  // §11.16 (2026-09-03 evening): 2.8 M was one rung too low for a SPONZA
  // walk. The user's editor logged `src pool grow: c0Probes 32768→65536,
  // blocks 21875/5468/1367/341 → 31744/6656/1536/384 (2.80M→3.44M bins;
  // peaks 15447/4390/1074/263)` — the c1–c3 peaks sat at 77–80 % of their
  // blocks, the ladder's early-warning line — and the grown store's kernels
  // compiled BEHIND the live one for 73 s with the picture held, after which
  // the cold store took over and the whole field re-converged in view: the
  // largest "patches converging when I enter a new room" event there is,
  // and the pinned-pool harness could never show it. 4.2 M bins / 65 536 c0
  // slots (~115 MB) covers a Sponza-class walk without a rung; Bistro still
  // takes one. The deeper fix — capacities as uniforms so a grow is an
  // allocate-and-copy instead of a 68-kernel recompile — is §11.17's.
  const deviceFloors = srcBinCeiling({ deviceLimitBytes: deviceLimit }) >= 8_000_000
    ? { c0Probes: 65_536, binBudget: 4_200_000 }
    : SRC_POOL_FLOORS;
  const poolConfig = {
    c0Probes: Number(globalThis.__giSrcC0Probes)
      || Number(pools?.c0Probes)
      || Number(initHatch?.c0Probes)
      || deviceFloors.c0Probes,
    binBudget: Number(globalThis.__giSrcBinBudget)
      || Number(pools?.binBudget)
      || Number(initHatch?.binBudget)
      || deviceFloors.binBudget,
    /** The floor the ladder never sizes a cascade below (its equal split). */
    floorBudget: deviceFloors.binBudget,
    // §11.4 A3 — an explicit per-cascade BLOCK vector (from GISystem's
    // peak-demand ladder, or a scene's persisted pools), or null for the
    // equal split of `binBudget`. A FIXED bin-budget hatch overrides it, so a
    // pinned A/B arm still means what the arm that set it meant.
    blocks: !Number(globalThis.__giSrcBinBudget)
      && Array.isArray(pools?.blocks) && pools.blocks.length === CASCADE_COUNT
      && pools.blocks.every((b) => Number.isFinite(b) && b > 0)
      ? pools.blocks.map((b) => Math.floor(b))
      : null,
  };
  // The scratch binding also carries [J]'s hit list and the per-block
  // statistics; reserve them (the hit list at the tier's ray ceiling, the
  // statistics at 8 MiB — generous for any pool this ceiling admits) so the
  // ceiling is what `createSrcBinStore` can actually allocate.
  const scratchReserveBytes = (1 + srcTransportRays(srcQualityTier(props)) * SEC_HIT_WORDS) * 4
    + 8 * 1024 * 1024;
  const binCeiling = srcBinCeiling({ deviceLimitBytes: deviceLimit, reserveBytes: scratchReserveBytes });
  if (poolConfig.blocks) {
    // A persisted vector may come from a bigger device (or a bigger window);
    // scale it under THIS device's ceiling rather than let the constructor
    // throw — the equal-bins-per-cascade shape is preserved by a uniform scale.
    const total = poolConfig.blocks.reduce((n, b, c) => n + b * binCount(c, W0), 0);
    if (total > binCeiling) {
      const k = binCeiling / total;
      poolConfig.blocks = poolConfig.blocks.map((b) => Math.max(1, Math.floor(b * k)));
      console.warn(
        `[gi] src pools: the requested block vector (${(total / 1e6).toFixed(2)}M bins) exceeds this ` +
        `device's ${(binCeiling / 1e6).toFixed(2)}M-bin ceiling — scaled to ${poolConfig.blocks.join("/")}`,
      );
    }
  } else if (poolConfig.binBudget > binCeiling) {
    poolConfig.binBudget = binCeiling;
  }

  const store = createSrcProbeStore({
    // ── SIZED FROM THE FLOORS, GROWN ON PRESSURE (§12.77 Unit A) ────────────
    //
    // `expectedC0Probes` (a quarter of the pixel count) used to be allocated up
    // front, and it is a PROXY for a quantity this system counts every frame
    // (`live`, `failedInserts`, `COUNTER_NOBLOCK`). On the user's Sponza the
    // proxy asked for 131,072 c0 slots with 1,788 live — 1.4% — and because
    // `.compute()` bakes its thread count, `populate`, `rays`, `seed` and
    // `hashBlock` sweep the whole allocation every frame regardless. The proxy
    // is now the growth CEILING (`srcPoolCeilings`) instead of the allocation;
    // the counters are the demand signal (see SRC_POOL_FLOORS above).
    c0Probes: poolConfig.c0Probes,
    cascadeCount: CASCADE_COUNT,
    w0: W0,
    // The bin block pool is sized from here, so the A/B dial for GI's largest
    // allocation lives next to the other two (`__giSrcSpacing0`, `__giSrcLmax`).
    // In bins, not bytes — the byte count is srcDeposit's layout to know.
    binBudget: poolConfig.binBudget,
    // §11.4 A3 — explicit blocks win over the equal split when present.
    blockCapacity: poolConfig.blocks,
  });
  // What was ACTUALLY built, so the ladder and `setSize` compare against the
  // real vector whichever path sized it (equal split or explicit).
  poolConfig.blocks = store.cascades.map((c) => c.blockCapacity);
  poolConfig.binBudget = poolConfig.blocks.reduce((n, b, c) => n + b * binCount(c, W0), 0);

  const cameraU = uniform(new THREE.Vector3());
  const anchorU = uniform(new THREE.Vector3());
  // Size in a uniform so a resize is a uniform write for the texel decode. The
  // DISPATCH counts are baked into the compute nodes, so a resize still rebuilds
  // the frame — see `setSize` on the returned object.
  const widthU = uniform(width, "uint");
  const heightU = uniform(height, "uint");
  const pixelCountU = uniform(activePixelCount, "uint");
  const screenPixelCountU = uniform(pixelCount, "uint");
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);

  /** Texel coords for a linear pixel index — the one decode both readers use. */
  const texelOf = (i) => ivec2(i.mod(widthU).toInt(), i.div(widthU).toInt());
  // ── THE GATHER'S OWN GRID ─────────────────────────────────────────────────
  //
  // `SRC_GATHER_SCALE` is a divisor on the gather's resolution only — see the
  // call site for why this is not `resolveScale`. Its thread `i` indexes a
  // gatherWidth × gatherHeight grid, so it needs a map into the FULL-res
  // gbuffer; `readPixel` decodes against `widthU` and would otherwise read a
  // pixel `SRC_GATHER_SCALE`× too far left on a row `SRC_GATHER_SCALE`× too far
  // up — a plausible image, subtly sheared, of a scene that is not there.
  //
  // The multipliers are JS constants, not uniforms, and that is safe for the
  // reason `setSize` already documents: the dispatch counts are baked into the
  // compute nodes, so a resolution change rebuilds this whole frame anyway.
  // ⚠ **1, NOT 2, AND THE 2 WAS MEASURED BEFORE IT WAS BACKED OUT.**
  //
  // At 2 this is worth ~5.6 ms on the user's editor (gather 7.55 → ~1.9 ms) and
  // it works — no validation errors, no page errors, the chain drops. What it
  // also does is bleed irradiance ACROSS SILHOUETTES, and that is visible on a
  // real object rather than theoretical: a box in the Sponza nave renders pure
  // black with sharp edges at 1:1 and soft mid-grey at 2:1, having picked up its
  // neighbours' light. The control that settles it is a shot taken BEFORE this
  // code existed — `resolveScale 0.5`, full-res gather — which shows the SAME
  // grey box. So the artifact belongs to a coarse irradiance carrier in
  // general, this change reproduces it faithfully, and it is not a mapping bug.
  //
  // The engine already knows the answer: `giConfig.js` says the resolve→screen
  // step upsamples through "the position-validated bilateral", which is exactly
  // the filter this gather→resolve step lacks. Shipping 2 without it would be
  // trading a measured 5.6 ms for light leaking onto every silhouette — the
  // same class of artifact ultra's `resolveScale: 1` is chosen to avoid, which
  // would make it a strange thing to introduce while defending that flag
  // (§12.34).
  //
  // So the plumbing lands and the scale does not. At 1 the UV sample in
  // giScreen returns exactly what `load(coord)` did (texel centres, 1:1), the
  // gather grid equals the resolve grid, and nothing about the image moves.
  // Raising this to 2 is a one-token change once the bilateral exists, and the
  // 5.6 ms is already priced.
  const SRC_GATHER_SCALE = 1;
  const gatherWidth = Math.max(1, Math.ceil(width / SRC_GATHER_SCALE));
  const gatherHeight = Math.max(1, Math.ceil(height / SRC_GATHER_SCALE));
  const gatherReadPixel = (i) => {
    const gx = i.mod(uint(gatherWidth)).toVar();
    const gy = i.div(uint(gatherWidth)).toVar();
    const sx = gx.mul(widthU).div(uint(gatherWidth)).toVar();
    const sy = gy.mul(heightU).div(uint(gatherHeight)).toVar();
    return readScreenPixel(sy.mul(widthU).add(sx));
  };
  // The GLOSSY gather's grid (§12.71b v2) — its own quality-scaled map into
  // the full-res gbuffer for exactly the shear reason above. Downsampling is safe
  // where the diffuse gather's backed-out 2 was not: giLight blends the
  // exact-BVH hit over this term on mirror pixels, and a glossy lobe is an
  // angular blur before it is a spatial one (the pass header has the full
  // argument).
  const GLOSSY_SCALE_BY_QUALITY = {
    low: 4,
    medium: 3,
    high: 2,
    ultra: 1.5,
  };
  const GLOSSY_SCALE = GLOSSY_SCALE_BY_QUALITY[props?.reflectionsQuality] ?? 2;
  const glossyWidth = Math.max(1, Math.ceil(width / GLOSSY_SCALE));
  const glossyHeight = Math.max(1, Math.ceil(height / GLOSSY_SCALE));
  const glossyReadPixel = (i) => {
    const gx = i.mod(uint(glossyWidth)).toVar();
    const gy = i.div(uint(glossyWidth)).toVar();
    const sx = gx.mul(widthU).div(uint(glossyWidth)).toVar();
    const sy = gy.mul(heightU).div(uint(glossyHeight)).toVar();
    return readScreenPixel(sy.mul(widthU).add(sx));
  };
  const readScreenPixel = (i) => {
    const t = texelOf(i);
    const g0 = positionNode.load(t).toVar();
    // ══ `position.w > 0.5` IS NOT SUFFICIENT, MEASURED ═══════════════════════
    //
    // It is the gbuffer's own "geometry here" mark and it is what
    // `createGiResolve` tests, so the first version of this used it alone. On
    // the smoke scene that admitted **8,809 of 19,200 pixels (46%)** which have
    // no geometry at all: their position is the origin and their NORMAL IS
    // ZERO. Every one of them inserted a probe at the world origin, was handed
    // a ray budget, fired a hemisphere of rays around `normalize(0)` = NaN, and
    // then gathered nothing — the failure presented as "GI is patchy" and took
    // three wrong hypotheses (probe density, back-facing normals, hemisphere
    // coverage) before a bad-normal counter named it in one run.
    //
    // A pixel with no normal cannot be shaded and cannot define a hemisphere,
    // so it is not a pixel GI covers. Testing BOTH channels here rather than in
    // each consumer is the point: one definition of "this pixel is real", which
    // the population, the ray budget, the deposit and the gather all inherit.
    const nrm = normalNode.load(t).xyz.toVar();
    // ── FACE FORWARD TOWARD THE CAMERA, HERE AND NOWHERE ELSE ─────────────
    //
    // The same flip `createGiResolve` and `giLight` apply: a double-sided wall
    // seen from inside a room has a normal pointing OUT, and firing a
    // hemisphere of rays into that direction samples the outside of the room.
    //
    // It lives at the ENGINE BOUNDARY rather than in the kernels, and that
    // placement is the point. It is a gbuffer fact, not an algorithm property —
    // `srcRef.js`'s `traceAndDeposit` takes the normal it is handed. Putting it
    // in the deposit kernel made the GPU and the mirror disagree about 28% of
    // bins in one run of `test:gi-src-deposit`, which is exactly the kind of
    // divergence a second definition produces. Here, the deposit's ray
    // hemisphere and the gather's query hemisphere are the same vector by
    // construction — and a flip on one side only would have each read the half
    // of the bin sphere the other never filled.
    const facing = step(0, nrm.dot(vec3(cameraU).sub(g0.xyz))).mul(2).sub(1).toVar();
    return {
      position: g0.xyz,
      valid: g0.w.greaterThan(0.5).and(nrm.dot(nrm).greaterThan(0.25)),
      normal: nrm.mul(facing),
    };
  };
  const readPixel = secondaryReceivers
    ? secondaryReceivers.composeReadPixel(readScreenPixel, screenPixelCountU)
    : readScreenPixel;
  // `normal.w` is the MIRROR MASK, not a validity bit (giScreen's second pass
  // writes 1 there for reflective pixels) — read `.xyz` and let `position.w`
  // stay the single validity test.
  const readNormal = (i) => readPixel(i).normal;

  // ── THE TEMPORAL BLEND (plan §4.6) ────────────────────────────────────────
  //
  // `keep` is 1 − α, applied to every deposit accumulator before this frame's
  // rays land on top; `srcDeposit.js`'s header argues the placement. The frame
  // stamp goes to the probe frame AND the deposit frame as ONE node, because
  // its whole job is to let the decay recognize a block the compaction claimed
  // moments earlier — two counters that agreed most of the time would be worse
  // than none, since the disagreement shows up as a new probe wearing a dead
  // one's light rather than as anything that looks like a bug.
  //
  // `__giSrcAlpha` is the harness override, and `1` is single-frame mode. It is
  // POLLED PER FRAME (`syncCamera`), not read once at build, for a reason the
  // flicker instrument makes concrete: `run-gi-flicker-frame.mjs`'s own header
  // records that the SAME baseline config read 1.404 and 5.194 reversals/px in
  // two processes — a 3.7x spread, larger than any effect anyone has tried to
  // measure with it — so its numbers are only comparable WITHIN one page. An α
  // read at build time can only be A/B'd by reloading, which is exactly the
  // comparison that instrument forbids. Polling costs a global read per frame
  // and is the same convention `__giDebugView` runs under.
  // ── MOTION-ADAPTIVE α (§12.38) ────────────────────────────────────────────
  //
  // A still scene settles to TEMPORAL_ALPHA_STILL (the ALPHA_SWEEP measured
  // 3.75× fewer still-scene reversals there — srcConfig's table); any scene
  // motion ramps continuously back to TEMPORAL_ALPHA, so a moving light,
  // emitter or occluder gets exactly the adaptation every §12 measurement ran
  // at. `sceneMotion` is a NORMALIZED [0,1] getter supplied by GISystem (null
  // in every standalone gate, which therefore keep the flat TEMPORAL_ALPHA
  // they were written against). The hatch outranks the ramp: a forced
  // `__giSrcAlpha` is a forced α, else the flicker instrument could not pin
  // its arms.
  const readAlpha = () => {
    if (Number.isFinite(Number(globalThis.__giSrcAlpha))) {
      return Math.min(1, Math.max(0, Number(globalThis.__giSrcAlpha)));
    }
    if (!sceneMotion) return TEMPORAL_ALPHA;
    const m = Math.min(1, Math.max(0, Number(sceneMotion()) || 0));
    return TEMPORAL_ALPHA_STILL + m * (TEMPORAL_ALPHA - TEMPORAL_ALPHA_STILL);
  };
  const keepU = uniform(1 - readAlpha());
  // ── THE α COMPENSATION'S LIFT (§12.40.4) ──────────────────────────────────
  //
  // How much of the per-block influx compensation is SUSPENDED, derived from
  // the same α the motion signal produces: at the still floor the lift is 0
  // (full compensation — capped blocks keep proportionally more history and
  // the ray cap is variance-neutral), at the moving α it is 1 (no
  // compensation — the fast decay wins, which is both the responsiveness the
  // user asked for and the mechanism that retires stale bins; the deposit's
  // `influxLift` doc carries the rounding-fixed-point argument). Deriving
  // from α rather than from `sceneMotion` directly means a pinned
  // `__giSrcAlpha` pins the lift too — 0.05 IS "still", 0.1 IS "moving",
  // whoever says so — and gates with no motion getter (flat TEMPORAL_ALPHA)
  // get lift 1 = the exact pre-compensation decay they were written against.
  // `__giSrcAlphaComp = false` is the explicit opt-out, polled per frame like
  // every other hatch here.
  // Where α sits on the still→moving ramp, in [0,1]. Two consumers with
  // DIFFERENT opt-outs, so it is its own function: the compensation lift
  // (opted out by `__giSrcAlphaComp = false`) and the tracking root below
  // (opted out by `__giSrcMotionTrack = false`) — coupling them through one
  // switch would make "disable compensation" silently mean "always decay at
  // the tracking rate".
  const motionOf = (alpha) => {
    const span = TEMPORAL_ALPHA - TEMPORAL_ALPHA_STILL;
    if (!(span > 0)) return 1;
    return Math.min(1, Math.max(0, (alpha - TEMPORAL_ALPHA_STILL) / span));
  };
  const liftFor = (alpha) => (globalThis.__giSrcAlphaComp === false ? 1 : motionOf(alpha));
  const influxLiftU = uniform(liftFor(readAlpha()));
  // ── SURPRISE (srcConfig's SURPRISE block) ─────────────────────────────────
  //
  // Read ONCE, at build, unlike every other hatch here — because it decides
  // whether the bundles are PASSED, and a bundle is a set of nodes in a kernel
  // rather than a uniform. `false` builds the pre-surprise kernels byte for
  // byte, which is the only form of "off" that can back a bit-exactness claim.
  // The two live dials (`__giSrcSurpriseGain`, `__giSrcColdFill`) are polled
  // per frame like the rest, and gain 0 is the in-page A/B.
  const surpriseOn = globalThis.__giSrcSurprise !== false;
  // How much faster a fully surprised block decays: `keepFast = 1 − α_moving`
  // expressed as a multiplier on THIS frame's `1 − keep`. Never below 1 — the
  // mechanism may only ever forget faster, never slower, so a pinned α (where
  // `keep` is already the fast one) makes this exactly 1 and the mix a no-op.
  const surpriseFU = uniform(1);
  // The governor. One multiply, applied in the publish, reaching both consumers
  // through the word it writes — srcConfig's one-switch rule.
  const surpriseGainU = uniform(1);
  // [D1']'s exemption master switch, 0 for the COLD_GUARD_FRAMES after a build
  // or a re-anchor (when EVERY block is cold at once) and whenever the cap is
  // pinned by an instrument.
  const boostEnableU = uniform(0, "uint");
  let coldGuard = COLD_GUARD_FRAMES;
  // Starts at 1, not 0: an unclaimed block's stamp is 0, and a frame counter
  // that also started there would call every block in the pool fresh on frame
  // zero. Harmless in fact (an unclaimed block holds zeros, which zero to
  // zeros) and not worth relying on.
  const frameStampU = uniform(1, "uint");
  // Anchor-relative retention's re-anchor kill (see srcProbes' retention
  // bundle): nonzero for the re-anchor frame (+1 for ordering safety), driven
  // by `syncCamera` below through a JS countdown so pass order can't leak a
  // stale-keyed probe past the renumbering.
  const retainKillU = uniform(0, "uint");
  let retainKillFrames = 0;

  // The gizmos share the SAME anchor uniform, not a copy. A gizmo lattice
  // drawn from a second anchor would look perfectly plausible and be in the
  // wrong place, which is the most misleading failure a debug view can have.
  const gizmos = createSrcProbeGizmos(store, { spacing0, anchor: vec3(anchorU) });

  // ── ALGORITHM 3 (plan §12.13.5 unit 2) ────────────────────────────────────
  //
  // Built UNCONDITIONALLY, unlike the scaffold trace below, because the budget
  // is not a diagnostic — it is the numbering every later phase's deposit is
  // addressed by, and unit 3 needs it whether or not a scaffold exists. It also
  // costs nothing to look at: `srcRays.js`'s passes are eight tiny dispatches
  // over the probe table, no marching.
  // ── THE RAY CEILING (srcConfig's `transportRays`) ─────────────────────────
  //
  // Uniforms, not build-time constants, so the ceiling is an A/B and a resize
  // is a uniform write rather than a rebuild (R11). `natural` is what this
  // resolution would fire unstrided — the number that was 3,146,400 on the
  // user's editor and 94% of a 260 ms SRC chain.
  const strideU = uniform(1, "uint");
  const phaseU = uniform(0, "uint");
  let naturalRays = activePixelCount * tier.raysPerPixel;
  // ── THE CEILING IS POLLED PER FRAME, NOT READ AT BUILD ────────────────────
  //
  // Same rule `__giSrcAlpha` follows two dozen lines up, and for the reason
  // §12.23 wrote down: a build-time value can only be A/B'd by RELOADING, and a
  // reload is the comparison this module has repeatedly got wrong. The first
  // attempt to price this ceiling used one page per arm and the arms came back
  // at 315,952 and 499,720 transport pixels — the editor's viewport panel
  // settles to different sizes across loads, so the "hold the resolve, move
  // only the ceiling" sweep moved both. Polling makes the whole A/B happen
  // inside ONE page, one build, one viewport, which is the only version of it
  // that means anything.
  //
  // It is also free: `readCeiling` is a global read and a divide on the CPU,
  // once per frame, and the kernels see a uniform. Nothing rebuilds (R11).
  const readCeiling = () => srcTransportRays(srcQualityTier(props));
  // ── THE DISPATCH SIZE IS BAKED; THE STRIDE INSIDE IT IS NOT ───────────────
  //
  // three bakes `.compute(n)`, so the thread count cannot be a uniform. It is
  // therefore derived from the TIER's ceiling — a build-time constant — and NOT
  // from the resolution or from the live hatch. Two consequences, both wanted:
  // the transport's dispatch size is resolution-INDEPENDENT (a viewport resize
  // stops rebuilding these three passes), and `__giSrcTransportRays` can still
  // move the ceiling at runtime *within* that budget by changing the stride.
  //
  // A hatch set ABOVE the tier's ceiling therefore cannot buy more rays than
  // the baked thread count allows — it clamps. Said out loud because a probe
  // that raises the hatch and sees no change would otherwise read that as "the
  // ceiling does nothing".
  const transportThreads = Math.max(
    1,
    Math.ceil(SRC_QUALITY[srcQualityTier(props)].transportRays / Math.max(1, tier.raysPerPixel)),
  );
  const rayStore = createSrcRayStore(store, { pixelCount: pixelCapacity });
  const coldPriority = globalThis.__giSrcColdPriority !== false && (
    transportThreads < pixelCapacity || globalThis.__giSrcColdPriorityForce === true
  );
  // ── §11.44 THE VISIBILITY CACHE (per c0 block × lamp) ───────────────────
  // `profile.giPasses` with `__giSrcNoShadow`: 96 % of `shade + bounce [J]`
  // (11.9 → 0.48 ms per dispatch on the user's Bistro) was ONE any-hit march
  // per hit — the light-tree sample's visibility to its lamp. A static lamp
  // over a static surface does not change, so the answer is kept per c0
  // block (the field's own resolution; the bounce of lamp light cannot be
  // finer than the probes that carry it) and per lamp: VIS_CACHE_ROWS packed
  // words of (lamp << 16 | vis·255 << 8 | samples). K samples converge a
  // row; a converged row answers without a march. The store owns the buffer
  // so the age pass can zero a retiring probe's row (a recycled block must
  // not answer for another position); `visCacheClearU` zeroes everything
  // while a light moves (GISystem's `trackMotion` window) or after the light
  // tree is rebuilt (lamp indices renumber). `__giSrcVisCache = false` is
  // the pre-§11.44 kernel.
  // v2 (the first receipt): keyed on the hit's c0 PROBE, 65 % of the samples
  // found no probe under the hit (rays land where the camera has not put
  // probes) and 19 % found the 8 lamp rows full. So the cache is its OWN
  // open-addressing hash of WORLD CELLS at spacing0 — camera-independent, so
  // a walk keeps what it learned — with 16 lamp rows per cell; the probe
  // store's hash helpers (`hashFindWgsl` / `hashInsertWgsl`) do the lookup
  // and the claim. A converged row is still re-marched by one sample in
  // eight (a pure function of the ray index — deterministic, no boil), so
  // the mean keeps converging past K and a row stays honest.
  // The first table readback (Bistro, 40 back-to-back shades of one hit
  // set): 455 k rows against 192 k samples per dispatch — a row sees a
  // sample every few dispatches, so K = 8 at spacing0 cells took seconds and
  // a moving camera never got there (23 % served). Coarser cells and a lower
  // K are LIVE uniforms (`__giSrcVisCacheSpacing`, `__giSrcVisCacheK`) so an
  // A/B needs no reload; a spacing change clears the table.
  const VIS_CACHE_ROWS = 16;
  const VIS_CACHE_K = 4;
  const VIS_CACHE_SPACING_MUL = 2;
  const VIS_CACHE_CAP = 1 << 18;
  const visCacheKU = uniform(VIS_CACHE_K, "uint");
  const visCacheSpacingU = uniform(spacing0 * VIS_CACHE_SPACING_MUL);
  // ⛔ OPT-IN, NOT DEFAULT (§11.46). This cache changed the PICTURE — the
  // user's "lost its colour and atmosphere" — and every perf and stability
  // receipt it had was blind to that. The unanimity rule below should make
  // it exact, but "should" is not a receipt: it goes back on only after a
  // look check on the user's own scene. `__giSrcVisCache = true` arms it.
  const visCacheOn = globalThis.__giSrcVisCache === true;
  const visKeys = visCacheOn ? instancedArray(new Uint32Array(VIS_CACHE_CAP), "uint").toAtomic() : null;
  const visRows = visCacheOn ? instancedArray(new Uint32Array(VIS_CACHE_CAP * VIS_CACHE_ROWS), "uint") : null;
  let visCacheClearFrames = 0;
  const visCacheClearU = uniform(0, "uint");
  const frame = createSrcProbeFrame(store, {
    spacing0,
    camera: vec3(cameraU),
    anchor: vec3(anchorU),
    pixelCount: activePixelCount,
    pixelCapacity,
    maxLods: MAX_LODS,
    readPixel,
    frameStamp: frameStampU,
    retainKill: retainKillU,
    representative: coldPriority ? rayStore.rayCursor : null,
  });
  // Two terms, and the `max` is what makes both directions of the hatch work.
  //
  //  `fill`  = floor(pixelCount / threads) — the stride that spreads the baked
  //            thread count across the WHOLE screen. `floor`, not `ceil`: the
  //            largest pixel touched is `(threads-1)·stride + phase`, which must
  //            stay under `pixelCount` for every `phase < stride`.
  //  `want`  = ceil(naturalRays / ceiling) — the stride the live ceiling asks
  //            for. TIGHTER than the tier's: threads run off the end and skip,
  //            which is how a runtime A/B buys fewer rays without a rebuild.
  //
  // Taking the max clamps a LOOSER hatch to the baked budget. Without it, a
  // ceiling above the tier's would produce a stride too small to reach the far
  // side of the screen and the transport would quietly sample a CROP — the top
  // strip lit, the rest dark, which reads as a GI bug rather than as a budget.
  const strideFor = (ceiling) => Math.max(
    1,
    Math.floor(activePixelCount / transportThreads),
    Math.ceil(naturalRays / Math.max(1, ceiling)),
  );
  let rayCeiling = readCeiling();
  const rayCeilingU = uniform(rayCeiling, "uint");
  let rayStride = strideFor(rayCeiling);
  strideU.value = rayStride;
  // The §12.61 rest cadence's current scale on the tier ceiling, captured for
  // publishTransport — a derived number nothing prints is a number probes will
  // guess (§12.42). Declared HERE, above publishTransport's construction-time
  // call: the first draft declared it beside the camera state 500 lines down
  // and the TDZ ReferenceError silently cost the whole SRC build (the cost
  // probe read "1 kernels", 4.7% lit — a black scene wearing a probe failure).
  let restFactor = 1;
  // ── §11.9 THE MOTION SCALE — FRAME TIME OUTRANKS CONVERGENCE WHILE THE
  //    CAMERA MOVES (2026-09-03) ──────────────────────────────────────────
  //
  // The rest cadence above LIFTS the budget under camera motion (`camTerm`
  // holds the full ceiling for 600 ms after every move) so that revealed
  // probes fill fast. On the user's Bistro that is 82 k rays × ~420 ns =
  // 35 ms of world dispatch EVERY frame while walking, beside a 17 ms
  // emitter-shadow pass — 87 ms frames, 11 fps. The project's standing rule
  // is a 60 fps floor above everything, and a moving image masks the noise
  // this budget exists to average (the temporal filters already make that
  // argument for themselves), so GISystem hands in a scale from its camera
  // EMA: 1 at rest, `__giSrcMotionRayScale` (0.35) at full motion, applied to
  // the ceiling (stride) AND the per-probe cap. Uniform writes, no rebuild;
  // the rest cadence's own hold restores the full budget within ~20 frames of
  // the camera stopping, which is when convergence can be seen again.
  let motionScale = 1;
  /** §12.74: when the α-ramp motion signal last STARTED being continuously
   *  significant. 0 = not currently sustained. See the root-relax block. */
  let motionSustainSince = 0;
  /** When this system was built — the rest cadence's boot hold reads it. */
  const buildAt = performance.now();
  // Frames since this system was built — the boot ramp's clock (syncCamera).
  let framesSinceBuild = 0;
  const BOOT_RAMP_FRAMES = 8;
  // ── THE PER-PROBE RAY CAP (srcConfig's `probeRayCap`, §12.32.1 option 1) ──
  //
  // The ceiling bounds the FRAME and prices rays by screen coverage; the cap
  // bounds each PROBE, which is the thing actually being estimated. Measured
  // before building (SWEEP=histo, Sponza, high): the median c0 probe fires 8
  // rays/frame while the fattest fires 1,794 — so capping at the tier's B cuts
  // the traced set to 0.10–0.26× with every capped probe still receiving B
  // fresh rays EVERY frame. Same polling rule as the ceiling and α: a build
  // value can only be A/B'd by reloading, so `__giSrcProbeRayCap` is read per
  // frame and the kernels see a uniform.
  const readCap = () => srcProbeRayCap(srcQualityTier(props), tier.raysPerPixel);
  /**
   * ⭐⭐ §11.49 — THE CAP IS A SHARE OF THE BUDGET, NOT A CONSTANT.
   *
   * The tier cap (8) was measured on Bistro, where ~14.8 k c0 probes fill it
   * and the frame fires ~93 k of its 393 k ray ceiling. In a SMALL scene the
   * same constant starves the field: the user's Level runs 2,224 live c0
   * probes, so 8 rays each is 16.7 k rays — 4 % of the ceiling — while the
   * merge reports HALF those probes starved and `tiles.knownFrac` sits at
   * 0.55, i.e. 45 % of every probe's directions have no measured radiance and
   * are filled from a neutral prior. That is the "so little bounce, GI looks
   * flat and boring" report, and it is a budget left unspent.
   *
   * So the cap is now `share x ceiling / liveProbes`, floored at the tier cap
   * and ceilinged at CAP_MAX. The share is deliberately a QUARTER: on the
   * scene the constant was tuned for it evaluates to 6.6 and the floor keeps
   * the tuned 8, so §11.30's measured Bistro win (SRC 48 -> 19 ms) is
   * reproduced exactly; on a small scene it lifts toward CAP_MAX and spends
   * the ceiling that was already paid for. `liveProbes` comes from the
   * periodic `readStats` (every 60 frames), which is the right timescale for
   * a population that changes as the camera walks.
   * `__giSrcCapBudgetShare = 0` restores the constant cap.
   */
  const CAP_BUDGET_SHARE = 0.25;
  const CAP_MAX = 32;
  let liveC0ForCap = 0;
  /**
   * ⭐⭐ §11.50 — THE CAP IS A CLOSED LOOP ON RAYS ACTUALLY FIRED, NOT AN
   * ESTIMATE FROM THE PROBE COUNT (2026-09-04).
   *
   * §11.49 divided the frame's ray budget by the LIVE c0 population. But rays
   * are born per PIXEL (§11.17's own header says so), so the probes that
   * receive any are the ones a strided screen pass claims THIS frame — about
   * 1,300 of them on the user's Level. `live` counts every probe RETAINED
   * from everywhere the camera has ever walked, and that number grows without
   * bound as the scene is toured. Measured on the user's Level, same pose,
   * camera parked, the ONLY difference being how much of the house had been
   * visited:
   *
   *   live c0 | cap | rays/frame | knownFrac | c0 orphan rate
   *     2,025 |  16 |    27,234  |   0.555   |    0.2 %
   *    11,692 |   4 |     4,874  |   0.464   |   33.8 %
   *
   * 4,874 rays is 1.2 % of the ray ceiling this tier already pays for, and
   * over half of every probe's directions never got a sample — they are
   * filled from a neutral prior. That is the user's "why is there so little
   * bounce", and it is the SAME unspent budget §11.49 set out to spend: the
   * fix worked on the field it was measured on and un-fixed itself the moment
   * the field grew.
   *
   * ⛔ AND A SHARE OF THE BUDGET IS THE WRONG INVARIANT, WHICH IS THE ACTUAL
   * LESSON. §11.49's quarter was reverse-engineered from Bistro, where the
   * frame fires ~24 % of its ceiling — so "spend a quarter" reproduces the
   * scene it was fitted to and, on a scene with a FIFTH of the probes, tells a
   * field that could afford 32 rays each to stop at 8. A constant divisor and
   * a constant share fail the same way for the same reason: both describe the
   * BUDGET, and the thing that decides whether a probe needs another ray is
   * the FIELD.
   *
   * So the loop closes on the field's own completeness, from the same readback:
   *
   *   · `tiles.knownFrac` — the share of every probe's directions carrying
   *     MEASURED radiance. §11.30's shipped Bistro receipt is 0.80; below
   *     `KNOWN_TARGET` the rest is filled from a neutral prior, which is
   *     exactly what "flat, no bounce" looks like on screen.
   *   · `cascades[0].starved` — probes with too little evidence to answer.
   *
   * While either says the field is incomplete the cap climbs; when both are
   * satisfied it decays back toward the tier value, so a converged scene pays
   * the tuned cost and nothing more. The one thing that can stop the climb
   * early is the budget itself: once the frame already traces `SPEND_MAX` of
   * the rays its stride can reach, raising the cap buys nothing and the loop
   * holds. The ceiling and the stride still bound the frame either way — this
   * only decides how the rays that ARE traced get distributed over probes.
   *
   * `__giSrcCapBudgetShare = 0` restores the tier constant; a pinned
   * `__giSrcProbeRayCap` bypasses the whole path as it always has.
   */
  let capLoop = 0;
  /** §11.30's shipped Bistro receipt was 0.80; aim just past it and let the budget stop the climb. */
  const KNOWN_TARGET = 0.85;
  /** Starved c0 probes, as a share of live c0, that still counts as converged. */
  const STARVED_TARGET = 0.02;
  /** Stop climbing once the frame already traces this much of what its stride can reach. */
  const SPEND_MAX = 0.9;
  /** Published for `profile.giPasses` — a derived number nothing prints is a number probes guess (§12.42). */
  const capLoopState = { fired: 0, budget: 0, knownFrac: 0, starvedFrac: 0, cap: 0, why: "seed" };
  const budgetCap = () => {
    const shareRaw = Number(globalThis.__giSrcCapBudgetShare);
    const share = Number.isFinite(shareRaw) ? shareRaw : CAP_BUDGET_SHARE;
    if (!(share > 0)) return readCap();
    if (capLoop > 0) return Math.max(readCap(), Math.min(CAP_MAX, capLoop));
    // Before the first readback lands there is nothing measured to loop on, so
    // §11.49's open-loop estimate seeds it. It is wrong in the direction this
    // unit fixes, which is why it only ever survives one readback.
    if (!(liveC0ForCap > 0)) return readCap();
    const want = Math.round((share * transportThreads * Math.max(1, tier.raysPerPixel)) / liveC0ForCap);
    return Math.max(readCap(), Math.min(CAP_MAX, want));
  };
  /**
   * One step of the loop. Called from `readStats`, the only place the fired
   * total and the field's completeness exist in the same tick.
   *
   * `budget` is what THIS frame's stride can reach — `naturalRays / rayStride`,
   * i.e. after the rest cadence and the motion scale have already moved the
   * ceiling. Measuring the spend against the tier's unscaled ceiling instead
   * would fight §12.61 every time the camera parks.
   */
  const stepBudgetCap = ({ fired, knownFrac, starvedFrac }) => {
    const shareRaw = Number(globalThis.__giSrcCapBudgetShare);
    const share = Number.isFinite(shareRaw) ? shareRaw : CAP_BUDGET_SHARE;
    if (!(share > 0)) return;
    const budget = Math.ceil(naturalRays / Math.max(1, rayStride));
    const from = capLoop > 0 ? capLoop : Math.max(1, probeRayCap);
    const incomplete = (Number.isFinite(knownFrac) && knownFrac < KNOWN_TARGET)
      || (Number.isFinite(starvedFrac) && starvedFrac > STARVED_TARGET);
    const spent = budget > 0 && Number.isFinite(fired) ? fired / budget : 0;
    let why;
    let next = from;
    if (incomplete && spent < SPEND_MAX) {
      // 1.5x, not 2x: the fired total responds sub-linearly (probes already
      // under the cap do not move), so a doubling overshoots into a decay it
      // then has to walk back — and every walk-back is a visible change in the
      // evidence rate on a still image.
      next = Math.ceil(from * 1.5);
      why = "climb";
    } else if (incomplete) {
      why = "budget-bound";
    } else {
      // Converged: give the rays back, slowly. A converged field that decays
      // below completeness simply re-enters the climb on the next readback,
      // which is a 1.5x step a second later — not a visible event.
      next = Math.max(readCap(), Math.floor(from * 0.85));
      why = "converged";
    }
    capLoop = Math.max(readCap(), Math.min(CAP_MAX, next));
    // The one outcome a reader must be able to tell apart: still climbing vs
    // pinned at CAP_MAX with the field STILL incomplete. The first is a loop
    // working; the second says the ceiling — not the distribution — is what
    // the scene is short of, and no cap can fix that.
    if (why === "climb" && capLoop >= CAP_MAX && next > CAP_MAX) why = "cap-max";
    capLoopState.fired = Number.isFinite(fired) ? fired : 0;
    capLoopState.budget = budget;
    capLoopState.knownFrac = Number.isFinite(knownFrac) ? +knownFrac.toFixed(3) : 0;
    capLoopState.starvedFrac = Number.isFinite(starvedFrac) ? +starvedFrac.toFixed(4) : 0;
    capLoopState.cap = capLoop;
    capLoopState.why = why;
  };
  let probeRayCap = readCap();
  const capU = uniform(probeRayCap, "uint");
  // ⚠ A DERIVED NUMBER THAT NOTHING PRINTS IS A NUMBER PROBES WILL GUESS.
  // The ceiling A/B measured two arms 5.0x apart in flicker and the only way to
  // tell "5x more stable" from "refreshed 5x less often" was the stride ratio —
  // which no probe could read, because the boot line is emitted once at build
  // and the runtime hatch moves the stride silently afterwards. So publish it.
  const publishTransport = () => {
    globalThis.__giSrcTransport = {
      pixelCount: activePixelCount,
      threads: transportThreads,
      naturalRays,
      ceiling: rayCeiling,
      stride: rayStride,
      // With a cap this is an UPPER BOUND, not the fired count — the real
      // total is per-probe-capped on the GPU and only `readStats().totalRays`
      // knows it. Kept under its old name because probes ratio it against the
      // ceiling; the cap field beside it says when it is a bound.
      tracedRays: Math.ceil(naturalRays / rayStride),
      probeRayCap,
      // §11.50's loop, so a probe can read WHY the cap is where it is: the
      // fired total it last saw, the share of the frame's budget it was
      // aiming at, and the cap that came out.
      capLoop: { ...capLoopState },
      // §12.61: the rest cadence's current scale on the tier ceiling. 1 =
      // full budget (motion/window/camera); REST_TRANSPORT_FRACTION = parked.
      restFactor,
    };
  };
  publishTransport();
  // ⚠ `createSrcRayFrame` IS CALLED BELOW THE BIN STORE, not here where the ray
  // store is built. The surprise publish reads the per-block statistics, and
  // those live in the bin store's `scratch` tail (R7 — [E] is at the portable
  // 8-buffer ceiling, so they could not have a buffer of their own). Order of
  // CONSTRUCTION only; the dispatch order in `passes` is unchanged.

  // ── [E] + [F]: THE SPLIT SCATTER AND THE RESOLVE (plan §12.13.5 unit 3) ──
  //
  // This replaced unit 1's scaffold ray pass, which existed only to give
  // `srcTrace.js` a caller and feed the ray-hit counters. It traces the same
  // rays through the same closure and additionally does something with the
  // answer; the scaffold's tallies live on inside the deposit's own `stats`,
  // because they were the only instrument on the traversal's step budgets.
  //
  // The R2 PHASE advances by the two plastic-constant increments each frame, so
  // frame f traces the sequence shifted by f points — which under temporal
  // accumulation is the coverage a single frame's R2 run cannot give on its own.
  // What it must NOT be is a float — §12.11.1.
  const jitterXU = uniform(0, "uint");
  const jitterYU = uniform(0, "uint");
  // The radiance the fixed-point accumulator saturates at. Live, because
  // §12.13.4 deliberately left clamp-vs-auto-exposure open, and the deposit
  // COUNTS its own clamps so the decision gets made from a measurement.
  const lmaxU = uniform(Number(globalThis.__giSrcLmax) || 16);

  // ── [E']: HIT SHADING (plan §7 Phase 5, §12.26) ───────────────────────────
  //
  // Gated on having something to shade WITH as well as a flag. `__giSrcShade`
  // off, or no `lighting`, or no `staticSurfaceAt`, and `shadeHit` stays null —
  // which keeps this build byte-identical and keeps every gate written before
  // Phase 5 comparable, exactly as `__giSrcProbes` does for the population.
  //
  // **THE TWO ARGUMENTS ARE NOT ONE SWITCH.** `staticSurfaceAt` is the other
  // half of Phase 5 and lives in `srcSurface.js`: §12.9 deleted the coarse
  // surface-attribution grid, so there is currently no path on the GPU from a
  // static hit to its material. Shading with `lighting` alone would light the
  // whole static world at one default albedo — a grey-box bounce that looks
  // plausible, is wrong everywhere, and would be read as a shader bug rather
  // than a missing input. `STAT_UNATTRIBUTED` counts it if it ever happens.
  //
  // DECIDED HERE, ABOVE THE BIN STORE, because [J]'s hit list is a REGION of
  // the store's `scratch` buffer (R7) and the store therefore has to be built
  // knowing whether anything will shade.
  const staticSurfaceAt = surfaces?.surfaceAt ?? null;
  // §10: the field-less bundle attributes by SLOT (`surfaceAtHit`) and has no
  // cell-keyed `surfaceAt`; either one is an attribution source.
  const shadeEnabled = srcShadeEnabled() && !!lighting && !!(staticSurfaceAt || surfaces?.surfaceAtHit);
  // ── [J] IS THE SHADING PASS NOW, AND THE HIT LIST IS ITS INPUT (§12.53) ───
  //
  // The list used to exist only for the SECOND BOUNCE, so it was gated on the
  // multibounce flag. Since the whole of `shadeHit` moved out of [E] the list
  // is how ANY hit gets shaded, so it is gated on `shadeEnabled` — and the
  // bounce flag now gates one TERM inside [J] (`bounceOn` below), not the pass.
  //
  // ⚠ Getting this wrong is a black frame, not a dim one: gate the pass on the
  // multibounce flag and the low tier renders with no direct light at any hit.
  //
  // `volume?.occupancyField` stands in for `tiles && gather && binStore` — each
  // of those is built if and only if the one before it was, and this decision
  // has to be made before the first of them exists.
  //
  // ── `__giSrcSplitShade = false` IS THE R12 HATCH FOR THE SPLIT ITSELF ─────
  //
  // It rebuilds the ONE-KERNEL deposit (`createSrcHitShader` inline in [E], no
  // [J], single bounce) — the shape every measurement before §12.53 was taken
  // on. The unit's whole claim is a COMPILE claim, and a compile claim across
  // two processes is worthless in this module (§13.14: the same kernel has read
  // 47 s and 238 s in different runs because the driver serializes). So the
  // arms have to exist in one page, which means the old shape has to still be
  // buildable, which is what this flag is for. `smoke:gi-gpu` A/Bs on it.
  const splitShade = globalThis.__giSrcSplitShade !== false;
  const shadingPass = !!(volume?.occupancyField && shadeEnabled && splitShade);
  // ── THE MULTIBOUNCE GATE — DEFAULT ON, FROM THE TIER (§12.39) ─────────────
  //
  // It was opt-in (`__giSrcSecondary === true`) for exactly as long as [J] was
  // a LINE INSIDE THE DEPOSIT: inlining `gatherAt` into the hit shader took
  // that kernel from 58 kB to 323 kB of WGSL and its pipeline compile to 48
  // seconds, so multibounce cost every boot half a minute whether or not the
  // scene needed it. Now that [J] is its own dispatch (`srcSecondary.js`) the
  // reason for the opt-in is gone and the flag is an OPT-OUT: `tier.secondary`
  // is the low-tier one (low ships single-bounce) and `__giSrcSecondary = false`
  // is the R12 hatch that reproduces every pre-[J] gate result. Off, [J] still
  // SHADES — it just does not build the gather, which also costs it the
  // `hashKeys` binding.
  const bounceOn = !!(shadingPass && tier.secondary !== false
    && globalThis.__giSrcSecondary !== false);
  // EXACTLY the rays this dispatch can fire, so the list can never overflow:
  // [E] runs `transportThreads` threads at `raysPerPixel` rays each, and one
  // ray produces at most one entry. `STAT_SEC_OVERFLOW` counts the bound being
  // wrong rather than trusting it.
  const secondaryCapacity = shadingPass ? transportThreads * tier.raysPerPixel : 0;
  const binStore = volume?.occupancyField
    ? createSrcBinStore(store, { w0: W0, secondaryCapacity, maxBytes: deviceLimit })
    : null;
  const receiverSnapshot = secondaryReceivers
    ? secondaryReceivers.createSnapshot(binStore, frameStampU) : null;

  // ── ALGORITHM 3'S FRAME, now that the statistics have somewhere to live ───
  //
  // The surprise bundle needs the bin store, so this sits below it (see the
  // note at `publishTransport`). Both bundles are `null` without a bin store or
  // with `__giSrcSurprise = false`, and that is the byte-identical build.
  const surpriseBundle = surpriseOn && binStore
    ? {
        scratch: binStore.scratch,
        statBase: binStore.blockStatBase,
        keep: keepU,
        lift: influxLiftU,
        gain: surpriseGainU,
        frameStamp: frameStampU,
        // What ONE deposit adds to a block's weight sum. [E] shifts each
        // deposit by SUM_SHIFT before summing, so this is `DEPOSIT_SCALE`
        // through the same shift — the divisor that turns the weight sum back
        // into a deposit COUNT for the shot-noise term.
        rayWeight: DEPOSIT_SCALE >> SUM_SHIFT,
      }
    : null;
  // §11.17: the starvation floor's dials (srcConfig's STARVE block). The
  // threshold is in BSTAT_SUM_W units: deposits × the per-deposit weight.
  const starvePacketsU = uniform(STARVE_PACKETS);
  // The threshold is in BIN_COUNT units: rays × DEPOSIT_SCALE.
  const starveThresholdU = uniform(STARVE_RAYS * DEPOSIT_SCALE);
  const rayFrame = createSrcRayFrame(store, rayStore, {
    pixelProbe: frame.pixelProbe,
    raysPerPixel: tier.raysPerPixel,
    stride: strideU,
    phase: phaseU,
    threads: transportThreads,
    cap: capU,
    capBoost: surpriseBundle
      ? { frameStamp: frameStampU, boostEnable: boostEnableU, counters: store.counters }
      : null,
    surprise: surpriseBundle,
    priority: coldPriority
      ? {
          frameStamp: frameStampU,
          ceiling: rayCeilingU,
          // §11.17: the starvation floor rides the cold-frontier priority and
          // reads the surprise bundle's per-block evidence (srcRays derives
          // the c0 stat base from `surprise`). Off without the bundle or at
          // build with `__giSrcStarve = false`.
          starve: surpriseBundle && binStore && globalThis.__giSrcStarve !== false
            ? {
                packets: starvePacketsU,
                threshold: starveThresholdU,
                counters: store.counters,
                // The c0 bin block layout, for the evidence sum (srcRays).
                binBase: binStore.cascades[0].binBase,
                bins: binStore.cascades[0].bins,
                binWords: SrcDepositNS.BIN_WORDS,
                binCount: SrcDepositNS.BIN_COUNT,
              }
            : null,
        }
      : null,
    activePixels: pixelCountU,
  });

  // ── [H]: THE IRRADIANCE TILES (plan §12.18.7 unit 4) ─────────────────────
  //
  // c0 only, and only because [G] runs before the bake each frame: a merged c0
  // bin carries the whole cascade chain's answer at the finest spacing the
  // hierarchy has, so tiles for cascades 1-3 would bake the same light more
  // coarsely and nothing would read them.
  //
  // CONSTRUCTED HERE — above the hit shader — since §12.39: [J] gathers this
  // atlas, and it is built between the shader and the deposit. Dispatch order
  // is the `passes` list below and is unchanged; at the moment [J] samples a
  // tile the atlas holds LAST frame's bake, which is exactly the temporal
  // feedback R4 models (§12.26.9).
  const tiles = binStore
    ? createSrcTileAtlas(store, binStore, {
        w0: W0,
        // The scene's own Sky Light, composited against a bin's RESIDUAL
        // transmittance — zero for every merged bin, so it only ever fires for
        // the orphans. Zero when a project never set it, which means this build
        // still renders exactly as it did.
        sky: sky ? vec3(sky) : vec3(0),
        // §16 D3 — the probe-maturity fade rides the claim stamps against
        // this frame counter (srcTiles' header carries the design).
        frameStamp: frameStampU,
        // §16 S1 — directional residual sky (this build's tables).
        skyEnv: skyEnvBuild,
      })
    : null;

  // ── [I]: THE SCREEN GATHER (plan §12.18.7 unit 5) ────────────────────────
  //
  // Sparse-trilinear over the ≤8 nearest c0 probes, one filtered tile tap each,
  // blended across the LOD overlap. This is what removes the ~0.6 m rectangles
  // that every frame since §12.17 has had: `srcGather.js` (deleted with this
  // unit) assigned ONE probe per pixel with no interpolation, so the blocks
  // were the probe cells at the correct spacing and no probe density was ever
  // going to remove them.
  //
  // `hashBlockFrame` is what makes the closure affordable inside the resolve —
  // and since §12.39 its words ride `hashKeys`' TAIL, so the lookup is ONE
  // storage buffer: the price at which the deposit kernel (7 of 8 bindings)
  // can afford it too.
  // §15 U3 — ONE LOS occupancy test for BOTH gather instances. The screen
  // gather [I] cleans the direct corner read; the secondary [J] instance is
  // the one that matters MORE: it shades ray hits, and a validity-blind
  // gather there DEPOSITS the wrong room's light into this room's bins — the
  // leak then lives in the field itself where no screen-side weight can
  // reach it (the los-leak gate measured exactly that: control-crop redness
  // 0.36 across all of room B). The ONE-BIT test, not the distance oracle:
  // the oracle's near-field scan at the march's call count priced the
  // gather ×18 (los-gate run 9).
  //
  // ⚠ FILTERED, NOT ONE-BIT (2026-08-23). The one-bit reader made the corner
  // weight a STEP function of position, so the lit/unlit boundary it drew on
  // a wall was stair-stepped at voxel granularity — the artifact that sent
  // U3 back to opt-in the night it shipped, with the leak fix along with it.
  // `occupancyAtWorld` is the same eight-times-cheaper-than-the-oracle test
  // trilinearly interpolated, i.e. continuous in the sample position, so the
  // boundary is a gradient instead of a lattice of squares. See its header.
  // `__giLosFiltered = false` restores the one-bit reader — the arm the
  // filtered/binary comparison needs, and the escape hatch if a scene ever
  // prefers the step. The shoulder above it is a no-op on 0/1 input, so the
  // two arms differ ONLY in the smoothness of the read.
  const losOccupied = (globalThis.__giLosFiltered === false
    ? volume?.occupancyField?.occupiedAtWorld
    : volume?.occupancyField?.occupancyAtWorld ?? volume?.occupancyField?.occupiedAtWorld) ?? null;
  const losWorld = volume?.world ?? null;
  // Section 10: the BVH-only build answers the merge's cross-wall test with one
  // any-hit segment between two lattice points (static geometry; movers do
  // not carry walls). Null in the field build, where the point-in-solid march
  // stays the opt-in arm.
  const losSegment = bvhTrace?.dyn?.traceStaticBvh && globalThis.__giMergeLos !== false
    ? (from, to) => {
        const a = vec3(from).toVar();
        const d = vec3(to).sub(a).toVar();
        const len = d.length().max(1e-4).toVar();
        const dir = d.div(len).toVar();
        const v = float(1).toVar();
        // The MIDDLE 80 % of the segment, as U3b's march sampled it: a parent
        // corner whose lattice point sits inside a wall's slab is still a
        // parent (its bins are the room's), and the child's own vicinity is
        // its own business. Only a wall CROSSING the path cuts the corner.
        // Measured: 2 cm margins cut in-room corners on the convergence rig
        // and doubled the rest noise (3.5 → 6.3 %).
        const st = bvhTrace.dyn.traceStaticBvh(a, dir, len.mul(0.1).max(0.02), len.mul(0.9).max(0.04), { anyHit: true });
        // An EMPTY static BVH (the intermittent dead boot builds against a
        // scene with 0 placements) has no segment to trace and returns null;
        // "no wall crossed" is the honest answer, and it keeps the seed's
        // build from throwing 400 times a second inside the compile wave.
        if (st) If(st.x.greaterThanEqual(0), () => { v.assign(0); });
        return v;
      }
    : null;
  // ── §10.7: THE COARSE FALLBACK LATTICE (2026-09-03) ─────────────────────
  //
  // A c1 tile atlas and its hash lookup, for the screen gather to fall back
  // to where the c0 lattice is STARVED. The header above says c1-3 tiles
  // would "bake the same light more coarsely and nothing would read them" —
  // true until this: on the user's Bistro c0 drops thousands of inserts
  // during a walk (`dropped 10774 inserts (32768/32768)`), and a refused
  // insert is a probe that does not exist, so its pixels had NOTHING to
  // gather and fell to the far-field constant. c1 holds the farther intervals
  // at 2x spacing with fewer probes. It omits the near c0 interval, so it is
  // only an approximation for missing spatial corners, never for partial
  // angular confidence on existing c0 probes.
  //
  // Cost: 5468 more tiles (~2.8 MB) and one more bake dispatch (~0.18 ms by
  // proportion to c0's 0.71 ms at 21875 tiles). `__giGatherCoarseFallback
  // = false` builds without it and restores the c0-only gather.
  const coarseFallbackOn = !!binStore && globalThis.__giGatherCoarseFallback !== false;
  const tilesCoarse = coarseFallbackOn
    ? createSrcTileAtlas(store, binStore, {
        w0: W0,
        cascade: 1,
        sky: sky ? vec3(sky) : vec3(0),
        frameStamp: frameStampU,
        skyEnv: skyEnvBuild,
      })
    : null;
  const hashBlockFrame = tiles ? createSrcHashBlockFrame(store, 0) : null;
  const visCache = visKeys && bounceOn
    ? {
        rowsBuf: visRows,
        rows: VIS_CACHE_ROWS,
        KU: visCacheKU,
        /** The cell's row-table slot for a world position: found, or claimed; −1 when the table refused the claim. */
        slotAt: (P, count = null) => {
          const cell = ivec3(floor(vec3(P).div(float(visCacheSpacingU))));
          const key = uint(packProbeKey(int(0), uint(0), cell)).toVar();
          const h = hashKey(key).toVar();
          const found = SrcProbesNS.hashFindWgsl(
            key, h, uint(0), uint(VIS_CACHE_CAP), uint(SrcProbesNS.MAX_PROBE_STEPS), visKeys,
          ).toVar();
          const slot = int(-1).toVar();
          If(found.x.greaterThanEqual(0), () => {
            slot.assign(int(found.x));
          }).Else(() => {
            const claimed = SrcProbesNS.hashInsertWgsl(
              key, h, uint(0), uint(VIS_CACHE_CAP), uint(SrcProbesNS.MAX_PROBE_STEPS), visKeys,
            ).toVar();
            If(claimed.x.greaterThanEqual(0), () => {
              slot.assign(int(claimed.x));
            }).Else(() => {
              if (count) count.visFull(1);
            });
          });
          return slot;
        },
        clearU: visCacheClearU,
        clear: Fn(() => {
          If(uint(visCacheClearU).equal(uint(0)), () => { Return(); });
          atomicStore(visKeys.element(instanceIndex), uint(0));
          const base = instanceIndex.mul(uint(VIS_CACHE_ROWS)).toVar();
          for (let j = 0; j < VIS_CACHE_ROWS; j++) visRows.element(base.add(uint(j))).assign(uint(0));
        })().compute(VIS_CACHE_CAP),
      }
    : null;
  if (visCache) visCache.clear.__giPassName = "src:vis cache clear";
  // Not `createSrcHashBlockFrame`: its one-buffer tail is sized for c0 alone
  // and throws for any other cascade. The gather has bindings to spare.
  const coarseLookup = tilesCoarse ? createSrcBlockLookupDirect(store, 1) : null;
  const gather = tiles
    ? createSrcScreenGather(store, tiles, {
        lookup: hashBlockFrame.lookup,
        spacing0,
        camera: vec3(cameraU),
        // The SAME anchor the population, the gizmos and the merge use. A
        // gather that interpolates over a lattice placed from a second anchor
        // reads plausible light from the wrong probes.
        anchor: vec3(anchorU),
        // ── THE GATHER RUNS COARSER THAN THE RESOLVE ─────────────────────
        //
        // It is per-OUTPUT-pixel work — one probe-lattice interpolation per
        // screen pixel — and it measured **7.55 ms of a 34 ms SRC chain** on
        // the user's editor at 1,599,840 px, second only to the deposit. Unlike
        // the deposit it cannot be strided, because every output pixel needs a
        // value this frame; the only lever is producing fewer of them and
        // letting the resolve's UV sample upsample (giScreen).
        //
        // This is NOT `resolveScale`. Dropping that would take the AO/shadow
        // composite down with it, and its silhouette edges are the thing ultra
        // pays for. Irradiance is the smooth term — it is already a trilinear
        // interpolation over a ~0.35 m probe lattice, so a half-resolution
        // carrier is far below the frequency it can represent. Halving the
        // resolve is a visible change; halving THIS should not be, and
        // `probe:gi-src-cost` measures whether that holds rather than assuming.
        readPixel: gatherReadPixel,
        width: gatherWidth,
        height: gatherHeight,
        maxLods: MAX_LODS,
        w0: W0,
        // §10.7 — the coarse lattice this gather falls back to on starved
        // pixels. SCREEN INSTANCE ONLY: [J] and the glossy gather shade a hit
        // list rather than the image, and doubling an INLINED gather body at
        // those call sites is the compile-time law this module has already
        // learned twice (§12.39, §10.2).
        coarse: coarseLookup
          ? { lookup: coarseLookup, tiles: tilesCoarse, cascade: 1 }
          : null,
        // §15 U3 — inert until `__giGatherLosWeight` arms it (the reader in
        // srcMath); see the closure's construction above.
        losOccupied,
        losWorld,
      })
    : null;

  // ── [I']: THE GLOSSY GATHER (§12.71b v2) ─────────────────────────────────
  //
  // The same integral as [I], fed the reflection vector, at the reflection
  // rail's selected resolution — the
  // resolve samples it into the radiance target that giLight's specular slot
  // reads. Default ON; `__giGlossyRadiance = false` is the kill switch (the
  // OFF arm must reproduce the dark-but-stable metals the opt-in era shipped).
  // GISystem appends the radiance temporal filter behind it — see
  // #armGlossyTemporal for why the filter is built there and not here (it
  // needs the gbuffer-side history uniforms).
  const glossy = gather && props?.reflections !== false && globalThis.__giGlossyRadiance !== false
    ? createSrcGlossyGather(gather.gatherAt, {
        readPixel: glossyReadPixel,
        width: glossyWidth,
        height: glossyHeight,
        camera: vec3(cameraU),
      })
    : null;

  // ── [E']: THE ATTRIBUTION HALF, WHICH STAYS IN [E] ────────────────────────
  //
  // surfaceAt + the face-forward flip + R4's albedo ceiling. It needs the trace's
  // hit record, so it cannot leave the deposit; it is also cheap to compile,
  // which is why leaving it there costs nothing (§12.53).
  //
  // `shadeEnabled` is decided above the bin store (the hit list is a region of
  // it); this is only the construction.
  //
  // ONE counter bundle for BOTH halves. They write different words of the same
  // `stats` buffer from two kernels — the surface tallies from [E], the light
  // tallies from [J] — and both kernels already bind it, so the split costs no
  // binding on either side (R7, exactly what `createSrcShadeCounters` exists
  // for). A second bundle would be a second buffer.
  const shadeCounters = binStore ? createSrcShadeCounters(binStore) : null;
  // Provenance lives HERE and nowhere else — `srcShade.js` never asks whether a
  // hit moved. A mover-shaped `if` inside the shader is the shape of the bug
  // where a moving crate lights the room differently from the identical static
  // one beside it (§12.26.1).
  //
  // ONE definition, handed to whichever arrangement is built — the split's
  // attribution half or the one-kernel `createSrcHitShader` behind the R12
  // hatch. Two copies would be two `surfaceAt`s to keep in step, which is the
  // §12.9 crossed-numbering shape.
  const srcSurfaceAt = shadeEnabled && binStore
    ? (hit, dir) => {
          // ⚠ `srcSurface.js`'s signature is `(voxel, worldPos, normal)`, NOT
          // `(hit, dir)`. The first version of this call passed the hit record
          // straight through, and `vec3(hitRecord)` is a TSL type error a long
          // way from its cause — "Invalid parameter for the type vec3" pointing
          // at srcSurface, in a file that is correct.
          //
          // `voxel` is the level-0 cell the MARCHER found, which is why
          // `createSrcSceneTrace` passes it through rather than letting a
          // consumer re-derive it: `position` is lifted half a coarse cell along
          // the normal, so flooring it lands on the shell cell instead.
          //
          // The normal here is the RAW record normal, deliberately NOT the
          // face-forwarded one. The face retry steps INWARD along it to find the
          // cell the surface belongs to, so it needs the normal that points out
          // of the GEOMETRY — a normal flipped to oppose the ray would step the
          // wrong way on every back-face hit and silently attribute the cell
          // behind the wall.
          // §10: a BVH hit carries its SLOT; the attribution is by slot, and
          // the cell-keyed path below never runs for it.
          if (surfaces?.surfaceAtHit && hit.slot != null) return surfaces.surfaceAtHit(hit, dir);
          // §10 BVH-only bundle: `staticSurfaceAt` (the cell-keyed grid) is null
          // by design, and a BVH hit is attributed by SLOT above. A hit that
          // reaches here WITHOUT a slot only happens transiently while the
          // static BVH is still landing — the GISystem `bvhTrace` gate routes
          // to the voxel path meanwhile, and those hits have no slot. Emitting
          // an unattributed sample (valid 0) keeps the kernel BUILD from calling
          // a null (`staticSurfaceAt is not a function` → the deposit pass fails
          // to build and GI stays dark); the next rebuild, with the BVH ready,
          // attributes it by slot. In steady state every BVH hit has a slot, so
          // this branch never fires and shading is unchanged.
          if (staticSurfaceAt == null) {
            return { position: hit.exactPosition, normal: hit.normal, albedo: vec3(0), emissive: vec3(0), emitter: float(0), valid: float(0) };
          }
          if (hit.voxel == null) {
            throw new Error(
              "srcSystem: the scene trace produced no `voxel`, so static hits have no " +
              "attribution key. `createSrcSceneTrace` passes it through from the marcher — " +
              "a trace built without it cannot shade a static surface",
            );
          }
          const s = staticSurfaceAt(hit.voxel, hit.exactPosition, hit.normal);
          const albedo = vec3(s.albedo).toVar();
          const emissive = vec3(s.emissive).toVar();
          const emitter = float(s.emitter).toVar();
          const valid = float(s.valid ?? 1).toVar();
          // A mover overwrites all four. Its emissive is ALREADY zeroed at bake
          // time when it was promoted to an analytic emitter slot
          // (`dynamicObjects`' `writeSurface`, `promoted ? 0 : k`), so it wants
          // no flag: the promotion set is the NEE set, and the surface it
          // publishes is the half of the handoff the ray path is meant to carry.
          ifMoverHit(hit.dynObj, () => {
            const m = moverSurfaceAt(volume.occupancyField, hit.dynObj);
            if (m) {
              albedo.assign(m.surface.albedo);
              emissive.assign(m.surface.emissive);
              emitter.assign(float(-1));
              valid.assign(float(1));
            }
          });
          return { position: hit.exactPosition, normal: hit.normal, albedo, emissive, emitter, valid };
        }
    : null;

  // ── THE LIGHTING HALF'S ARGUMENTS, ONCE ───────────────────────────────────
  //
  // The same object feeds `createSrcHitLighting` (split, in [J]) and
  // `createSrcHitShader` (one-kernel, behind the R12 hatch). Built here rather
  // than spelled twice so the two arrangements can never disagree about what
  // "the lighting" is — the whole point of the hatch is that they differ only
  // in WHICH KERNEL compiles it.
  const lightingOptions = srcSurfaceAt
    ? {
        // §11.54 — the engine's water slots. Stable, engine-owned bindings
        // (`waterSlots.js`), so water appearing, changing resolution or being
        // deleted moves uniforms and never rebuilds this kernel.
        caustics: lighting.caustics ?? [],
        // Stage 3b: what a water surface mirrors — the sun-extracted sky bin
        // tables (srcSkyBins.js), read by bin as the merge reads them.
        skyEnv: skyEnvBuild,
        skyBinWidth: binStore?.cascades?.[0]?.bins ? Math.round(Math.sqrt(binStore.cascades[0].bins / 2)) : 0,
        sun: lighting.sun ?? null,
        lights: lighting.lights ?? [],
        emitters: lighting.emitters ?? [],
        maxRay: lighting.maxRay ?? null,
        // §11.10: the sun's shadow map at hits — one BVH descent fewer per ray.
        sunShadow: lighting.sunShadow ?? null,
        // ── THE ISOLATION HATCH (R12/R14) ────────────────────────────────
        //
        // `__giSrcNoShadow` drops the visibility ray entirely, which separates
        // the two causes of a black frame that the tallies cannot tell apart:
        // "no light reaches the hit" (the lighting term is zero) from "every
        // hit is occluded" (the ray says so). With it on, `maxL` still zero
        // means the lighting; `maxL` nonzero means the visibility.
        visibility: globalThis.__giSrcNoShadow === true
          ? null
          : bvhTrace
            ? createSrcBvhVisibility(bvhTrace.dyn, volume.world, {
              // DEFAULT ON (2026-09-11). Off, a hit's shadow ray toward a lamp
              // ignored every mover: in the ball pool the probes saw the floor
              // under 350 balls as fully lit, and that white flood was the whole
              // bounce — 1.4× the path tracer's floor, walls washed out, no tint
              // from the balls at all. Movers are analytic (~10 ALU each) in
              // that scene; measured 65→76 fps at rest either way, so the ray
              // is affordable. `__giSrcBvhShadowMovers = false` is the A/B.
              movers: globalThis.__giSrcBvhShadowMovers !== false,
            })
            : createSrcVisibility(volume.occupancyField, volume.world, {
          rayHitMode: volume.rayHitMode,
          // A shadow ray is SHORTER than a diffuse one by construction — it
          // stops at its source — so it does not inherit the 192 the primary
          // budget was measured to need. Its own number is owed a measurement
          // on a real scene; until then this is the marcher's own default.
          steps: Number(globalThis.__giSrcShadowSteps) || 64,
        }),
        voxelSize: volume.world.minCell,
        // One NEE sample, and it is not a quality dial yet. With importance =
        // contribution the one-sample estimator IS the exact sum (§12.26.5), so
        // every extra sample buys only visibility variance — and the tiers have
        // no measurement to set it from. `__giSrcNeeSamples` is the A/B until
        // one exists; stratification means 1 → 4 cuts the standard error 2.61×
        // where independent draws would give 2.00×.
        neeSamples: Math.max(1, Number(globalThis.__giSrcNeeSamples) || 1),
        // ── §12.62 W3: THE TREE NEE — [J] SAMPLES EVERY EMITTER ──────────
        //
        // One descent of the W1 block replaces the slot NEE (`lighting
        // .lightTree` carries the region GISystem uploaded — the region
        // exists BEFORE this build, §12.62 W1, so the base word is a
        // compile-time constant; a rebuild recompiles the whole chain and
        // re-bakes it). The block rides the occupancy `bits` tail, which the
        // visibility marcher already binds — zero new storage bindings in
        // [J], the entire reason W1 staged it there.
        //
        // **DEFAULT ON since 2026-08-15 (§12.70), together with
        // `__giEmitterTileCut` — the two are one feature (W5b): this gives
        // every emitter a TRANSPORT sampler, the cut gives it a SCREEN one,
        // and R5's zeroing keys on THIS hatch. Armed apart they double-deliver
        // or under-deliver; the measurement is in the plan.** Gated on the W3
        // fixture (19/19), the live ABBA parity rig (energy 1.008, noise
        // 0.96×) and §12.70's storm + Sponza ledgers.
        // `__giSrcLightTree = false` restores the four promoted slots.
        lightTree: (() => {
          if (globalThis.__giSrcLightTree === false) return null;
          const info = lighting.lightTree ?? null;
          const words = volume.occupancyField?.bits ?? null;
          if (!info || !words || !(info.baseWord >= 0)) return null;
          const base = uint(info.baseWord);
          const sampler = createLightTreeSampler(words, {
            // The per-branch loop bound; the tree's real depth bounds the
            // iterations actually run, so tight is free and loose is safe.
            maxDescent: Math.max(4, (info.maxDepth ?? 8) + 2),
          });
          // §13.7: sub-cell emitters damp their FIELD contribution against
          // the c0 lattice pitch (screen direct is untouched — see the eval's
          // comment). `__giSubCellEmitterDamp = false` restores full-strength
          // transport. NOTE the asymmetry: the `__giSrcLightTree = false`
          // fallback arm (promoted-slot NEE) is NOT damped — it predates
          // §13.7 and stays byte-identical for A/B.
          // §13.7 — DEFAULT OFF until measured. It shipped default-on on a
          // hypothesis and the artifact it targeted survived it; the flip
          // discipline says the OFF arm is the default until a rig says
          // otherwise. Arm with `__giSubCellEmitterDamp = true`.
          const evalAt = createLightTreeEmitterEval(words, {
            subCellRef: globalThis.__giSubCellEmitterDamp === true ? spacing0 * 0.5 : 0,
          });
          // The §12.42 rule — a number nothing prints does not exist. The W3
          // gate asserts this line to prove the arm actually compiled.
          console.log(
            `[gi] src [J] NEE: light tree (base ${info.baseWord}, ` +
            `${info.emitterCount ?? "?"} emitters, depth ${info.maxDepth ?? "?"}) — slot NEE replaced`,
          );
          return {
            sample: (P, n, seed) => sampler(P, n, float(1), base, seed),
            evalAt: (P, n, idx) => evalAt(P, n, base, idx),
          };
        })(),
        // ── §12.82: TAKE THE SUN OUT OF THE TEMPORAL STORE ────────────────
        //
        // The user's Level runs a day cycle and the sun never stops turning, so
        // every stored radiance is stale by however long ago its bin was last
        // refreshed — and neighbouring bins are stale by DIFFERENT amounts,
        // which is the bright/dark patchwork they report. `srcDeposit.js`'s
        // `BIN_SR` note carries the measurement and why no blend rate fixes it.
        //
        // The slot INDEX is the interface, not the light: `kind` is a uniform
        // (R11), so which slot is directional is a runtime fact and a build-time
        // pick would be wrong the moment a light is added. `< 0` means the scene
        // has no directional light and the split arms nothing — the shader is
        // still emitted, the comparison simply never matches, so adding a sun to
        // a scene that had none does not recompile.
        //
        // ⭐⭐⭐ **DEFAULT ON since 2026-09-04 (§11.21), AND THE VERDICT THAT KEPT
        // IT OFF WAS STALE.** This block used to read "it must stay off until
        // the delivery is whole", on a measurement of the user's Level that had
        // the transfer returning 11-41 % of what it removed. The defect behind
        // that number was found and fixed afterwards — the decay pass was
        // round-tripping the packed normal through a `select` and zeroing it
        // every frame (srcDeposit's BIN_SN note) — and the delivery was never
        // re-measured. It is now, on Sponza, sun pinned, camera parked,
        // character hidden, four arms in one run:
        //
        //   base                       tail mean luma 0.17939
        //   sunsplit                                  0.17308   96.5 % of base
        //   sunsplitflatcos (cos = 1)                 0.17408   +0.6 %
        //   sunsplitkeep (double)                     0.20360
        //   ⇒ removes 0.0305, returns 0.0242 — 79 %, not 11-41 %
        //
        // and 73.0 % of LIT bins carry a normal against the 9 % that verdict was
        // measured at. `sunsplitflatcos` landing within 0.6 % of the honest
        // close also says the cached NORMAL is not where the residual goes: the
        // 27 % of lit bins carrying no normal at all is, and their sun is simply
        // dropped. That is the honest remaining 3.5 %.
        //
        // WHY IT IS WORTH FOUR WORDS A BIN: §11.21 measured the user's live play
        // session with `profile.flicker` and found that with the tracking window
        // neutralised, the light signal made honest, α pinned to the still rate
        // and the stride root at zero, 62.8 % of pixels still reversed 3+ times.
        // That is this file's own §12.82 line — "no rate fixes a stored quantity
        // whose TARGET moves every frame" — and the split is the only thing that
        // makes the sun stop being one. `__giSrcSunSplit = false` reverts.
        sunSplit: !sunSplitArmed() || lighting.sunSlot == null
          ? null
          // `__giSrcSunSplitKeep` DOUBLE-DELIVERS the sun on purpose — see
          // `createSrcHitLighting`'s `splitKeep`. It is the only way to weigh
          // the removed half against the delivered half; never a shipping arm.
          : { slot: lighting.sunSlot, keep: globalThis.__giSrcSunSplitKeep === true },
        // A bounded first-bounce correction, independent of the cached-normal
        // sun split above (which remains opt-in and known-lossy). The owning
        // cascade supplies the gain transiently in [J]; only this runtime-named
        // directional slot receives it.
        sunCompensation: sunSplitArmed() || lighting?.sunSlot == null
          ? null
          : { slot: lighting.sunSlot },
        count: shadeCounters,
        visCache,
      }
    : null;

  // What `[F]` closes the cached transfer against — the SAME pair the shading
  // was built from, resolved through `srcShade.js` so the deposit side and the
  // resolve side cannot drift apart. A thunk: the nodes belong to whichever
  // kernel body calls it.
  const sunClose = lightingOptions && splitShade ? sunTerm(lightingOptions) : null;
  // ⭐ WHAT ACTUALLY ARMED, not what the flag asked for. `sunSplitArmed()` is
  // the build hatch; the split only exists when a directional SLOT was named
  // AND the shading is split, and a consumer that reads the flag instead can
  // calm the field on a build where the sun is still accumulating into the
  // bins (GISystem's `sunCalm` did exactly that).
  globalThis.__giSrcSunSplitLive = !!sunClose;
  // §12.42's rule — a number nothing prints does not exist, and this one has
  // three ways to be silently absent (no surface attribution, the one-kernel
  // arm, no directional slot to name). The walk probe reads this line to know
  // which arm it measured.
  if (lightingOptions) {
    console.log(
      sunClose
        ? "[gi] src §12.82 sun split: ARMED (default since §11.21) — the sun's TRANSFER is cached and " +
          "re-closed against the current sun every frame at [F], so a rotating sun stales no stored word. " +
          "Delivery re-measured 2026-09-04: 96.5% of the un-split picture (79% of what it removes comes back). " +
          "`__giSrcSunSplit = false` restores the 5-word layout"
        : `[gi] src §12.82 sun split: OFF (${
          !sunSplitArmed() ? "__giSrcSunSplit = false is set"
            : !splitShade ? "one-kernel shading (__giSrcSplitShade = false) — [J] is where the split deposits"
              : "no directional light slot to name"
        }) — the sun accumulates into the bins and stales with the day cycle`,
    );
  }

  // THE SPLIT FORM: [E] gets attribution only.
  const attribute = srcSurfaceAt && splitShade
    ? createSrcHitAttribution({ surfaceAt: srcSurfaceAt, count: shadeCounters, maxLoopAlbedo: loopAlbedoCeiling() })
    : null;
  // THE ONE-KERNEL FORM, behind `__giSrcSplitShade = false` — the pre-§12.53
  // deposit, every measurement before the split was taken on it, and it is
  // single-bounce because [J] (which carried the gather) does not exist on this
  // arm at all.
  const shadeHit = srcSurfaceAt && !splitShade
    ? createSrcHitShader({ surfaceAt: srcSurfaceAt, ...lightingOptions, maxLoopAlbedo: loopAlbedoCeiling() })
    : null;

  // ── [J]: THE SHADING PASS, AND THE SECOND BOUNCE INSIDE IT ────────────────
  //
  // Its own dispatch over the hit list [E] appends: the lighting half of §4.4
  // (visibility marcher, four rolled light slots, the NEE emitter set and its
  // analytic shapes) plus, when `bounceOn`, the SAME tile atlas the screen
  // gathers. See `srcSecondary.js`'s header for why the shading moved here from
  // [E], what it costs in bindings, and why it must run between [E] and [F].
  //
  // Built here because it needs the gather's inputs (`tiles`, the hash→block
  // lookup) and the deposit needs to know it exists.
  const secondary = shadingPass && binStore
    ? createSrcSecondaryFrame(store, binStore, {
        // THE MOVED HALF. Every one of `lightingOptions`' entries used to be an
        // argument to `createSrcHitShader` inside the deposit's ray loop.
        shade: createSrcHitLighting(lightingOptions),
        // The multibounce TERM. False keeps the shading and drops the gather —
        // see `bounceOn` above for why that is not the same switch as the pass.
        bounce: bounceOn,
        // The loop's albedo ceiling — the dial has to reach [J], not only [E].
        maxLoopAlbedo: loopAlbedoCeiling(),
        tiles: bounceOn ? tiles : null,
        lookup: bounceOn ? hashBlockFrame.lookup : null,
        spacing0,
        // The same three uniforms the screen gather reads. A second camera or
        // anchor here would gather over a lattice placed differently from the
        // one [E] filled — plausible light from the wrong probes.
        camera: vec3(cameraU),
        anchor: vec3(anchorU),
        lmax: lmaxU,
        maxLods: MAX_LODS,
        w0: W0,
        // §15 U3 — the hit gather is where a validity-blind corner poisons
        // the DEPOSIT; same closure as the screen instance above.
        losOccupied,
        losWorld,
        // §12.52's LUMA half, at the address [E] put in the record. Null with
        // the bundle off, and then not one node of it is built.
        surprise: surpriseBundle ? { statBase: binStore.blockStatBase } : null,
        sunBounceCompensation: !sunSplitArmed() && lighting?.sunSlot != null,
        capacity: secondaryCapacity,
      })
    : null;
  // §11.13 THE FAR DUTY — the fraction of rays that trace beyond cascade
  // `farFrom − 1` (see createSrcDepositFrame's note). A live uniform: at rest
  // the far field is static and its blocks' windows lengthen to hold their
  // sample counts; in motion it rises so the far field follows. Numbers are
  // dev hatches until the flicker probe and the user's walk have judged them.
  // `__giSrcFarDuty = false` removes the arm (build-time, kernel byte-identical).
  const farDutyOn = globalThis.__giSrcFarDuty !== false;
  const farDutyU = uniform(1);
  const farDutyRest = () => {
    const v = Number(globalThis.__giSrcFarDuty);
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.25;
  };
  const farDutyMotion = () => {
    const v = Number(globalThis.__giSrcFarDutyMotion);
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.5;
  };
  const farFrom = Number.isInteger(Number(globalThis.__giSrcFarFrom))
    ? Math.min(CASCADE_COUNT - 1, Math.max(1, Number(globalThis.__giSrcFarFrom)))
    : 2;
  if (farDutyOn && binStore) {
    console.info(`[gi] src far duty: ${Math.round(farDutyRest() * 100)} % of rays trace beyond cascade ${farFrom - 1} at rest (${Math.round(farDutyMotion() * 100)} % in motion); the far bins hold their sample counts through the influx compensation — __giSrcFarDuty = false restores full reach`);
  }
  const deposit = binStore
    ? createSrcDepositFrame(store, binStore, {
        pixelProbe: frame.pixelProbe,
        farDuty: farDutyOn ? farDutyU : null,
        farFrom,
        // `__giSrcFarNeed` (rays, build-time): the need floor; 0 disables it.
        farNeed: Number.isFinite(Number(globalThis.__giSrcFarNeed)) ? Math.max(0, Number(globalThis.__giSrcFarNeed)) : 1 / 32,
        pixelRayBase: rayStore.pixelRayBase,
        // [D5]'s winner worklist — [E] traces densely from it (§12.44); the
        // stride/phase uniforms below stay because the dispatch SIZE is still
        // the transport's and a live ceiling change must keep moving it.
        rayWork: rayStore.rayWork,
        rayWorkPacked: coldPriority,
        pixelCount: activePixelCount,
        raysPerPixel: tier.raysPerPixel,
        stride: strideU,
        phase: phaseU,
        threads: transportThreads,
        lmax: lmaxU,
        // ── THE SPLIT FORM (§12.53) ─────────────────────────────────────────
        //
        // Null unless [E'] above was built. With no attribution the deposit
        // shades nothing at all and what survives the resolve is transmittance
        // — a receiver lit by transmittance alone against the sky is ambient
        // occlusion, which is §7's "AO-like short-range bounce" and not a
        // placeholder. Exactly one of these is ever non-null — the constructor
        // refuses both, because a kernel that shades inline AND appends would
        // have [J] shade the same hit again.
        attribute,
        shadeHit,
        // §12.82: what `[F]` re-evaluates the cached sun transfer against.
        sunClose,
        sunBounceCompensation: !sunSplitArmed() && lighting?.sunSlot != null,
        // [J]'s hit list. Passed ONLY when [J] exists, and that is what keeps
        // the un-split kernel byte-identical to the pre-[J] one: with this
        // null, not a node of the record or the append is built.
        secondary: secondary
          ? { base: binStore.hitListBase, capacity: secondaryCapacity }
          : null,
        trace: bvhTrace
          ? createSrcBvhSceneTrace(bvhTrace.dyn, volume.world)
          : createSrcSceneTrace(volume.occupancyField, volume.world, {
          rayHitMode: volume.rayHitMode,
          // ── THE STEP BUDGET, MEASURED RATHER THAN INHERITED ──────────────
          //
          // `createSrcSceneTrace`'s 96 is the dense backend's number, and
          // srcTrace's own header warns that SRC's rays are LONGER than the
          // interval rays it was tuned for. It is: on the smoke scene the
          // legacy occupancy rung exhausts 274 times out of 19,200 rays at 96,
          // once at 128, and never at 192 or 256. The HIT RATE converges on the
          // same schedule (77.2% → 77.0% → 77.0%), which is the confirmation
          // that matters — an exhausted ray fails CLOSED from detail, so those
          // 274 were counting as hits.
          //
          // 192 rather than "as low as passes" because the budget is a LOOP
          // CEILING, not a cost: a ray that resolves in twenty steps pays twenty
          // whatever the bound is. The only thing a higher ceiling buys is that
          // the rays which would have given up finish instead. The plane rung
          // clears 96 on its own (0 exhaustions) — this is sized for the rung
          // that does not.
          //
          // Measured on an 8 m scene; `?raysteps=N` is the A/B, and a real scene
          // still owes a re-measurement.
          steps: Number(globalThis.__giSrcRaySteps) || 192,
          // Movers are IN. They are hit geometry for every other ray class in
          // this module (`composeFieldDynamics`), and a budget measured with
          // them excluded would be a budget for a medium nothing else traces.
          skipMovers: false,
          // The packed mover id costs the marcher its dynamic-object bookkeeping
          // on every ray, so it is asked for only when something reads it — and
          // the only reader is the hit shader's `surfaceAt`.
          wantDynObj: shadeEnabled,
        }),
        readPixel,
        readNormal,
        camera: vec3(cameraU),
        spacing0,
        jitterX: jitterXU,
        jitterY: jitterYU,
        keep: keepU,
        frameStamp: frameStampU,
        influxLift: influxLiftU,
        // The other half of the same bundle: [E] fills the per-block sums and
        // the decay reads the `u` word the publish wrote from them. Null and
        // neither node exists — see `createSrcDepositFrame`'s `surprise` doc.
        surprise: surpriseBundle
          ? { statBase: binStore.blockStatBase, surpriseF: surpriseFU }
          : null,
        maxLods: MAX_LODS,
      })
    : null;

  // ── THE FRESH-PROBE SEED (§12.59.2) ──────────────────────────────────────
  //
  // A newborn probe's bins start at its PARENT's last-frame merged answer
  // instead of at zero — §12.59.1's pan bisect pinned camera-motion flicker on
  // exactly that from-zero convergence. `srcSeed.js`'s header carries the
  // design; the two wiring facts that live HERE are (1) its passes MUST sit
  // between `deposit.decay` (which zeroes freshly claimed blocks — a seed
  // before it is silently wiped) and `deposit.resolve`, which the `passes`
  // list below enforces, and (2) `__giSrcSeed = false` is a BUILD-time hatch
  // like `__giSrcSurprise` — off builds no passes at all, the only "off" that
  // backs a bit-exactness claim. The live dial is `__giSrcSeedRays` (0 = the
  // in-page A/B arm), polled in `syncCamera` under the same §12.23 rule as α.
  const seedOn = globalThis.__giSrcSeed !== false;
  // ⚠ §12.82 AND THE SEED, WORKED THROUGH — IT COMPOSES, AND THE REASON IS THE
  // COUNT. The seed copies a parent's RESOLVED payload into `BIN_R/G/B`, which
  // under the split is the SUN-FREE channel, and that payload has already had
  // the sun closed into it at `[F]`. That reads like a double delivery. It is
  // not, because the seed also adds its weight `W` to `BIN_COUNT`, and the
  // resolve divides BOTH sums by it:
  //
  //     ΣR/Σcount            = w_seed·L_parent(full) + w_ray·L(sun-free)
  //     (ΣS/Σcount)·E·cos    = w_ray·sun(now)          — ΣS has no seeded term
  //     total                = w_seed·L_parent(full) + w_ray·L(full, now)
  //
  // a convex blend of the parent's answer and this frame's, which is exactly
  // what the seed is for. What the seeded fraction carries is a STALE sun (the
  // parent's, at seed time), decaying out at the ordinary rate — i.e. the
  // pre-split behaviour, confined to a shrinking fraction of one bin's weight,
  // instead of the whole store. Nothing to guard; worth writing down, because
  // the shape invites the wrong conclusion and a "fix" would break the blend.
  const seedRaysU = uniform(SEED_RAYS);
  const seedFarRaysU = uniform(SEED_RAYS_FAR);
  const seed = seedOn && deposit
    ? createSrcSeedFrame(store, binStore, {
        losSegment,
        lmax: lmaxU,
        seedRays: seedRaysU,
        farField,
        seedFarRays: seedFarRaysU,
        // §12.59.2's spatial fallback (cold-column rescue) — §16 D2b: armed
        // on both key arms; the anchor is what the default arm re-keys by.
        camera: vec3(cameraU),
        spacing0,
        maxLods: MAX_LODS,
        anchor: vec3(anchorU),
      })
    : null;

  // ── [G]: THE MERGE (plan §12.18.7 unit 3) ────────────────────────────────
  //
  // Cascade 3 → 0, in place over the resolved payload. This is what turns a
  // one-metre answer into a whole-reach one: before it, a c0 bin knew only
  // about cascade 0's interval; after it, the same bin carries the product of
  // transmittance and the sum of radiance along the entire cascade chain.
  //
  // The SKY IS ITS PARENT AT THE TOP and nowhere else — a per-cascade sky
  // deposit would multiply it by the cascade count.
  const merge = binStore
    ? createSrcMergeFrame(store, binStore, {
        farField,
        spacing0,
        // The SAME anchor uniform the population and the gizmos use. A merge
        // that interpolates over a lattice placed from a second anchor produces
        // plausible light in the wrong place, and no energy check can see it.
        anchor: vec3(anchorU),
        // S1: the merge resolves a key's world cell against the viewer under
        // world-absolute keying. Same uniform the population's LOD metric uses.
        camera: vec3(cameraU),
        sky: sky ? vec3(sky) : vec3(0),
        // §16 S1 — the top-cascade close samples the environment per bin
        // direction when this is armed (this build's tables).
        skyEnv: skyEnvBuild,
        w0: W0,
        losSegment,
        // §15 U3b — the same one-bit closure the gather instances take; the
        // merge marches child probe → parent corner with it so cross-wall
        // parents stop poisoning this room's own tiles (the leak the
        // gather-side march measurably cannot reach on a healthy ladder).
        losOccupied,
      })
    : null;

  // ([H]'s tile atlas, [I]'s gather and the hash→block frame are CONSTRUCTED
  // above the hit shader now — [J] needs the atlas and the lookup at build
  // time. Their DISPATCH position is unchanged; the `passes` list below is the
  // frame order, and construction order never was.)

  let anchored = false;
  let reanchors = 0;
  const scratch = new THREE.Vector3();
  // Camera-pan lift state (§12.45.2). Thresholds are per-FRAME deltas chosen
  // above orbit-damping jitter and below any deliberate pan: 5 mm translation,
  // 0.1° rotation. Frame-rate dependence only widens the margin (slower frames
  // → larger deltas).
  const camPrevPos = new THREE.Vector3();
  const camPrevQ = new THREE.Quaternion();
  const camScratchQ = new THREE.Quaternion();
  let camSeen = false;
  let camHoldUntil = 0;
  // When the camera last moved past the pan thresholds — the §12.61 rest
  // cadence's third drive term. 0 = "long ago"; a cold boot overwrites it on
  // frame one (no-history counts as movement).
  let camMovedAt = 0;
  // §12.67: the last frame the §12.43 light-event window was OPEN (tr > 0).
  // The light-settle envelope holds+fades from here, so a departed light's
  // ghost keeps full evidence + a floored α until it has re-converged instead
  // of decaying at the still rate on rest-cadence rays. -Infinity = never.
  let trOpenAt = -Infinity;

  const system = {
    store,
    frame,
    gizmos,
    /**
     * Every SRC storage buffer that is GPU-ONLY once uploaded, gathered from
     * the stores that own them so no list here can go stale when a store gains
     * a buffer. GISystem queues these for `detachCpuMirror` and drains the
     * queue once an SRC frame has dispatched unskipped.
     */
    get cpuMirrors() {
      return [
        ...(store.cpuMirrors ?? []),
        ...(frame.cpuMirrors ?? []),
        ...(rayStore.cpuMirrors ?? []),
        ...(binStore?.cpuMirrors ?? []),
        ...(merge?.cpuMirrors ?? []),
      ];
    },
    /**
     * Every SRC storage buffer that dies with this system, a strict SUPERSET
     * of `cpuMirrors`: the bundles below own buffers that are GPU-only but
     * never CPU-written again (tile LUTs, the seed's and the gather's stat
     * blocks), and a teardown has to destroy those too. Walked by
     * releaseCompute's `collectStateStorageAttributes`.
     */
    get storageAttributes() {
      const seen = new Set();
      for (const list of [
        this.cpuMirrors,
        store.storageAttributes, frame.storageAttributes,
        rayStore.storageAttributes, binStore?.storageAttributes,
        merge?.storageAttributes, tiles?.storageAttributes,
        seed?.storageAttributes, gather?.storageAttributes,
        glossy?.storageAttributes, secondary?.storageAttributes,
        deposit?.storageAttributes, hashBlockFrame?.storageAttributes,
        // §11.52 — the per-bin sky tables outlive this build (GISystem owns
        // them); publishing them here puts them in the swap's KEEP set, or
        // the teardown destroys buffers the next build's kernels still bind.
        skyEnvBuild?.tables?.storageAttributes,
      ]) {
        if (!Array.isArray(list)) continue;
        for (const attr of list) if (attr) seen.add(attr);
      }
      return [...seen];
    },
    rayStore,
    rayFrame,
    binStore,
    deposit,
    /** The fresh-probe seed (§12.59.2), or null when `__giSrcSeed = false`. */
    seed,
    /** [J], or null when the tier or the hatch turned the second bounce off. */
    secondary,
    secondaryReceivers,
    merge,
    tiles,
    hashBlockFrame,
    gather,
    /** [I'] — the half-res reflection-direction gather, or null when off. */
    glossy,
    spacing0,
    raysPerPixel: tier.raysPerPixel,
    // ONE dispatch list, in dependency order: population → budget → trace and
    // scatter → resolve → merge → gather. Each stage reads what the previous one
    // wrote (`pixelProbe`, then `pixelRayBase`, then the bin accumulators, then
    // the resolved payload), and every gap between two entries is the barrier
    // that makes that legal. A different order would spend this frame's rays
    // against last frame's membership, which is the kind of one-frame skew that
    // reads as noise rather than as a bug.
    //
    // THE MERGE'S OWN INTERNAL ORDER IS ALSO LOAD-BEARING and lives inside its
    // pass list: cascade c reads the region cascade c+1 wrote one dispatch ago,
    // so the ladder is only correct top-down and only because these are separate
    // dispatches (srcMerge.js's header).
    passes: deposit
      ? [
          // The attribution palette FIRST: the deposit's `shadeHit` reads it, and
          // a palette written after the rays that sample it is a frame of stale
          // colour on every material edit.
          ...(shadeEnabled ? surfaces?.passes ?? [] : []),
          ...frame.passes,
          // ⚠ `hashBlock` MOVED UP for [J] (§12.39), and the move is
          // correctness, not taste. The hash slot LAYOUT is rebuilt every
          // frame by [K] with scheduler-dependent contention, so a key's slot
          // index does not survive the rebuild — a tail written at the END of
          // last frame is misaligned with THIS frame's keys the moment the
          // population runs. The deposit's secondary term looks keys up
          // per hit, so the words must be republished after compaction and
          // BEFORE the first ray. Both inputs are settled by then (`hashSlot`
          // and `PROBE_BLOCK` are compaction's outputs), and neither changes
          // again within the frame, so the gather far below reads the same
          // truth it always did.
          hashBlockFrame.pass,
          ...rayFrame.passes,
          // ── [J] SITS BETWEEN [E] AND [F], AND BOTH SIDES ARE FORCED ───────
          //
          // AFTER [E]: the hit list does not exist until the scatter writes it.
          // BEFORE [F]: the resolve reads the accumulators once, so a bounce
          // deposited after it is a frame late — and worse than late, because
          // an entry's bin slot expires with the frame ([C] re-claims blocks
          // every frame, so the slot is only valid inside the frame that
          // produced it). The atlas [J] samples is still LAST frame's bake
          // ([H] runs below), which is the temporal fixed point R4 models.
          //
          // `hashBlockFrame.pass` does NOT move for this: it already runs
          // before the first ray, for the reason above it, and that is exactly
          // where [J]'s corner lookups need it.
          // The SEED rides inside the deposit's window — after the decay (a
          // seed before it is zeroed with the fresh block it targets), before
          // the resolve (which reads the accumulators once). It commutes with
          // [E] and [J] (pure atomicAdds), so decay-adjacent is a choice for
          // readability, not a constraint tighter than the window.
          ...(secondary
            ? [deposit.decay, ...(seed?.passes ?? []),
               deposit.scatter, ...(visCache ? [visCache.clear] : []), secondary.pass, deposit.resolve]
            : seed
              ? [deposit.decay, ...seed.passes, deposit.scatter, deposit.resolve]
              : deposit.passes),
          ...merge.passes, ...tiles.passes, ...(tilesCoarse?.passes ?? []),
          // Last transport operation: all rays have finished consuming the
          // previous snapshot. Keep before screenPassStart so gather-only
          // cadence frames do not overwrite it from the same stale hit list.
          ...(receiverSnapshot ? [receiverSnapshot] : []),
          gather.reset, gather.compute,
          // The glossy gather reads the SAME atlas bake the diffuse gather
          // does, so anywhere after `tiles.passes` is correct; after the
          // diffuse keeps the two half-frames adjacent for the profiler.
          ...(glossy ? [glossy.compute] : []),
        ]
      : [...frame.passes, ...rayFrame.passes],
    // ── WHO OWNS THE FRAME ──────────────────────────────────────────────────
    //
    // Group boundaries, in the SAME order as `passes`, so `profile.giPasses`
    // can attribute the chain instead of reporting one sum. It reported one
    // sum on the grounds that "the interesting question is what the chain
    // costs, not which of two clears is slower" — true when this was fourteen
    // tiny dispatches, and false at 44 dispatches costing 91ms on the user's
    // Sponza, which is ~50x the entire screen-pass total. A cost with no owner
    // is a cost nobody can act on.
    //
    // Counts are derived from the same arrays spread above, so the two cannot
    // drift without the assert in `profile.giPasses` firing.
    passGroups: deposit
      ? [
          { label: "surfaces (attribution palette)", count: (shadeEnabled ? surfaces?.passes ?? [] : []).length },
          { label: "populate", count: frame.passes.length },
          { label: "hashBlock", count: 1 },
          { label: "rays", count: rayFrame.passes.length },
          // SPLIT AROUND [J] when it runs, because "the deposit" is no longer
          // three contiguous dispatches — and `profile.giPasses` asserts these
          // counts sum to `passes.length`, so a group list that did not split
          // would withhold every per-group number rather than mislabel one.
          // The SEED splits the decay off again when it runs, for the same
          // assert: its passes sit between decay and trace in `passes` above.
          ...(secondary
            ? seed
              ? [
                  { label: "deposit (decay)", count: 1 },
                  { label: "seed (fresh-probe prior)", count: seed.passes.length },
                  { label: "deposit (trace + attribute)", count: 1 },
                  ...(visCache ? [{ label: "vis cache clear", count: 1 }] : []),
                  { label: "shade + bounce [J]", count: 1 },
                  { label: "deposit (resolve)", count: 1 },
                ]
              : [
                  { label: "deposit (decay + trace + attribute)", count: 2 },
                  ...(visCache ? [{ label: "vis cache clear", count: 1 }] : []),
                  { label: "shade + bounce [J]", count: 1 },
                  { label: "deposit (resolve)", count: 1 },
                ]
            : seed
              ? [
                  { label: "deposit (decay)", count: 1 },
                  { label: "seed (fresh-probe prior)", count: seed.passes.length },
                  { label: "deposit (trace + shade)", count: 2 },
                ]
              : [{ label: "deposit (trace + shade)", count: deposit.passes.length }]),
          { label: "merge", count: merge.passes.length },
          { label: "tiles", count: tiles.passes.length + (tilesCoarse?.passes.length ?? 0) },
          { label: "secondary receivers", count: receiverSnapshot ? 1 : 0 },
          { label: "gather", count: 2 },
          { label: "glossy gather", count: glossy ? 1 : 0 },
        ].filter((g) => g.count > 0)
      : [
          { label: "populate", count: frame.passes.length },
          { label: "rays", count: rayFrame.passes.length },
        ],
    /**
     * First view-dependent pass. Everything before this index advances the
     * world-keyed transport (population through tile bake); gather and every
     * pass appended after it consume that persistent world result for the
     * current camera. GISystem may therefore cadence the expensive world half
     * without ever presenting a stale screen-space AO/gather coordinate.
     */
    get screenPassStart() {
      let at = 0;
      for (const group of this.passGroups ?? []) {
        if (group.label === "gather") return at;
        at += group.count;
      }
      return this.passes?.length ?? 0;
    },
    pixelProbe: frame.pixelProbe,
    /** Non-null only when the hit shading was actually built — see `describeSrcProbeSystem`. */
    shading: (attribute && secondary) || shadeHit
      ? {
          lights: (lighting?.lights ?? []).length,
          emitters: (lighting?.emitters ?? []).length,
          attributed: !!surfaces,
          // WHICH ARRANGEMENT COMPILED, so the boot line cannot claim the split
          // on a build running the hatch.
          split: !!attribute,
          // THE BUILT TERM, not the gate that asked for it — a boot line that
          // disagrees with the built kernel is the §12.30 failure this file
          // keeps re-finding. ⚠ `!!secondary` stopped being this answer at
          // §12.53: [J] is built whenever anything shades, so the multibounce
          // question is `secondary.bounce` and nothing else.
          secondary: !!secondary?.bounce,
        }
      : null,
    width,
    height,
    pixelCount,
    // What the pools were actually built at (post-precedence), so GISystem's
    // pressure check can compare its grown target against reality and setSize
    // can tell a pool grow from a no-op.
    poolConfig,
    /** §11.4 A2: the device storage limit this store was sized under (bytes). */
    deviceLimit,
    /** §11.9: GISystem's camera-motion scale on the ray ceiling and cap, [0.1, 1]. */
    setMotionRayScale(k) {
      const v = Number.isFinite(k) ? Math.min(1, Math.max(0.1, k)) : 1;
      motionScale = v;
    },
    get motionRayScale() { return motionScale; },
    /** §11.44: zero the visibility cache on the next world dispatches (lamp indices renumbered, lights edited). */
    invalidateVisCache() { visCacheClearFrames = 8; },
    get visCacheOn() { return !!visCache; },
    /** §11.4 A2: where the ladder stops on THIS device — slots and bins. */
    poolCeilings: () => srcPoolCeilings(pixelCount, { deviceLimit, reserveBytes: scratchReserveBytes }),
    /**
     * The pressure probe — TWO small readbacks. The per-cascade counter block
     * (live, failed, noBlock at PROBE BIRTH) alone is NOT the bin signal:
     * birth-time claims go quiet once the population stabilizes, while every
     * standing blockless probe keeps failing its DEPOSIT each frame — the
     * growth harness measured 38k deposit noBlock/frame with birth noBlock 0
     * and a visibly darkened image (the §12.52.2 wash). So the deposit's own
     * counter rides along. Async, off the hot path, ~1 s cadence; unlike
     * `readStats` (seven readbacks) this stays cheap.
     */
    readPressure: async (renderer) => ({
      cascades: await readSrcProbeStats(renderer, store),
      depositNoBlock: deposit ? ((await deposit.readStats(renderer))?.noBlock ?? 0) : 0,
    }),
    // The ray ceiling, published so the boot line and `profile.giPasses` report
    // what the transport ACTUALLY fires rather than what the resolution implies.
    // `natural` is the pre-ceiling number: reading only `rays/px` off the log
    // was how a 3,146,400-ray frame looked like "2 rays/px" for a whole phase.
    // GETTERS, because the ceiling is polled per frame — a snapshot taken here
    // would report the value the system was BUILT with and go stale the moment
    // a probe moved it, which is the reading error this whole section keeps
    // paying for in a different costume.
    get rayStride() { return rayStride; },
    get rayCeiling() { return rayCeiling; },
    get naturalRays() { return naturalRays; },
    get tracedRays() { return Math.ceil(naturalRays / rayStride); },
    get probeRayCap() { return probeRayCap; },
    get reanchorCount() { return reanchors; },
    /**
     * The live lattice anchor, as a plain triple.
     *
     * ⚠ A PROBE'S WORLD POSITION IS NOT RECOVERABLE WITHOUT THIS. A packed key
     * carries a CELL, and the cell is relative to `latticeOriginFor(anchor, s)`
     * under anchor-relative keys — so any tool that wants to ask "where is this
     * probe, and what is near it" has to either read the anchor or reconstruct
     * it from the camera and the hysteresis quantum, which is exactly the kind
     * of re-derivation §12.42 forbids ("a derived number nothing prints is a
     * number probes will guess"). Added when a colour-bleed rig needed to bucket
     * probes by distance to the nearest red surface and had no way to place them.
     *
     * A copy, not the uniform's vector: handing out the live object lets a
     * reader move the lattice by accident.
     */
    get anchor() {
      const a = anchorU.value;
      return [a.x, a.y, a.z];
    },

    /**
     * Per-frame camera sync, and the re-anchor decision. Call BEFORE dispatching
     * `passes` — the whole frame's geometry is derived from these two uniforms,
     * so a stale camera puts every probe one frame behind its own gbuffer.
     */
    /**
     * @param {object} [opts]
     * @param {boolean} [opts.holdAnchor]  do not re-anchor on drift this frame
     *   (the occupancy chain is mid-rebuild and the world passes are held: a
     *   re-anchor would retire every probe with nothing able to refill them).
     */
    syncCamera(camera, { holdAnchor = false } = {}) {
      camera.getWorldPosition(cameraU.value);
      // ── THE CAMERA-PAN LIFT WINDOW — NOW OPT-IN (§12.47) ─────────────────
      // The camera is DELIBERATELY absent from the α signal (§12.38) and from
      // the tracking window (§12.43's refutation) — probe evidence is world-
      // anchored, so a pan stales nothing and must not buy fast decay. But a
      // pan CREATES probes: newly revealed surfaces allocate cold blocks, and
      // §12.45.2 lifted the CAP for them on the argument that adding evidence
      // is variance-reducing by construction.
      //
      // ⚠⚠ THAT ARGUMENT IGNORED THE PRICE, AND THE PRICE IS HALF THE FRAME
      // RATE. This arming is LEVEL-triggered — every moving frame re-pushes
      // the 1200 ms hold — so the cap is lifted for the WHOLE of any camera
      // movement, not for a window after it. Uncapped deposit is ~2× capped
      // (§12.42: the cap is ~14 ms of a 21 ms deposit), and the user reported
      // exactly that shape: "60 fps when still, 30 fps when moving camera."
      // It is §12.46's pathology in the camera path — sustained motion held
      // an emergency window open — and it survived that fix because §12.46
      // only re-armed the LIGHT side.
      //
      // Rising-edge arming does not rescue this one the way it rescued the
      // light window: a pan reveals cold blocks CONTINUOUSLY, so a one-shot
      // burst at the start of the movement would buy a 1.2 s hitch and then
      // stop helping exactly when the pan is still revealing geometry. So the
      // honest choice is on-or-off, and the measurement decides it: §12.45.2
      // priced the benefit at 2.89 vs 3.40 rev/px on pan-holds — marginal
      // against its own round spread — against a halved frame rate during the
      // single most common interaction in the editor. OFF by default;
      // `__giSrcCamCapLift = true` opts back in (the rig's lift-on arm).
      // The per-block form (lift the cap for NEWLY ALLOCATED blocks only,
      // rather than globally) is the version worth building — it is the same
      // targeting §12.42's per-block α compensation already does — and it
      // needs the cap to stop being one global uniform first.
      camera.getWorldQuaternion(camScratchQ);
      // Deltas are computed UNCONDITIONALLY now — the §12.61 rest cadence
      // needs camera recency whatever the opt-in cap lift is set to. A frame
      // with no history counts as movement, so a cold boot starts at the full
      // ray budget rather than discovering the scene at half rate.
      const camPosDelta = camSeen ? camPrevPos.distanceTo(cameraU.value) : Infinity;
      const camRotDelta = camSeen
        ? 2 * Math.acos(Math.min(1, Math.abs(camScratchQ.dot(camPrevQ))))
        : Infinity;
      if (camPosDelta > CAM_LIFT_POS || camRotDelta > CAM_LIFT_ROT) {
        camMovedAt = performance.now();
        if (camSeen && globalThis.__giSrcCamCapLift === true) {
          camHoldUntil = performance.now() + ALPHA_TRACK_HOLD_MS;
        }
      }
      camPrevPos.copy(cameraU.value);
      camPrevQ.copy(camScratchQ);
      camSeen = true;
      // Advance the R2 phase before the re-anchor early-out below, not after —
      // a still camera is exactly the case where every frame takes that return,
      // and it is also the only case where a frozen ray set would be invisible
      // (the picture would simply stop improving).
      jitterXU.value = (jitterXU.value + R2_ALPHA1_FX) >>> 0;
      jitterYU.value = (jitterYU.value + R2_ALPHA2_FX) >>> 0;
      // α is live — see `readAlpha`. Assigning unconditionally would dirty the
      // uniform every frame; the compare keeps a still scene's upload count at
      // zero, which the frame-pacing work cares about.
      // Cheap when `SlotRegistry.revision` is unchanged, which is every frame
      // that is not a material edit.
      if (shadeEnabled) surfaces?.sync?.();
      // ══ THE DECAY MUST FOLLOW THE REFRESH RATE, NOT THE FRAME RATE ═══════
      //
      // α is "how much of a probe's estimate is replaced by new evidence", and
      // §12.23 measured the whole temporal design at α = 0.1 PER REFRESH, back
      // when every pixel fired every frame so refresh rate == frame rate.
      //
      // The ray ceiling broke that identity and I did not notice: with a stride
      // of S a probe receives rays every S-th frame, while the decay pass still
      // runs over every allocated bin EVERY frame. At the user's resolution
      // S ≈ 12, so between two refreshes a bin's sums are multiplied by
      // 0.9^12 = 0.28 — **72% of the accumulated evidence destroyed before
      // anything arrives to replace it.** Bins sink under `MIN_WEIGHT`, retire,
      // and return a frame later, and §12.24 already named what that looks
      // like: the step floor is bin-level MEMBERSHIP, because a bin leaving the
      // readable set changes the renormalization denominator the gather divides
      // by. On screen it is flicker, and the user reported exactly that.
      //
      // So decay per FRAME becomes the S-th root of the intended decay per
      // REFRESH: over S frames the product is exactly `1 − α` again, which is
      // the number every §12.23 measurement was taken at. At S = 1 this is
      // identically `1 − α` and nothing changes, which is where all the gates
      // run.
      //
      // ⚠ It is a root, not a division. `keep/S` or `1 − α/S` both look
      // plausible and neither composes: decay is MULTIPLICATIVE across frames,
      // so the only function whose S-fold product is `1 − α` is its S-th root.
      // ── THE CAMERA-SETTLE α FLOOR (§12.63) ───────────────────────────────
      // Hoisted camera-recency envelope — the SAME hold+fade the rest cadence
      // reads below. The transport is screen-driven, so a pan shifts every
      // probe's estimator equilibrium; at the bare still floor the field then
      // crawls to the new equilibrium over ~50 frames in full view (Sponza
      // post-pan holds: 2.4 rev/px/s vs 0.155 parked, churn heatmap UNIFORM
      // over lit content — CAM_SETTLE_ALPHA's doc carries the numbers). α is
      // floored on the envelope so the re-equilibration compresses into the
      // window the cadence keeps at full rays. Parked: camTerm 0, floor is
      // ALPHA_STILL exactly. A pinned `__giSrcAlpha` outranks the floor (it
      // returns from readAlpha before the max — instrument rule); the settle
      // hatch `__giSrcCamSettleAlpha` is the A/B arm (false = off, number =
      // custom floor).
      const nowMs = performance.now();
      const sinceCam = nowMs - camMovedAt;
      const camTerm = sinceCam <= REST_CAM_HOLD_MS
        ? 1
        : Math.max(0, 1 - (sinceCam - REST_CAM_HOLD_MS) / REST_CAM_FADE_MS);
      // ── THE LIGHT-SETTLE ENVELOPE (§12.67) ──────────────────────────────
      // `tr` is read HERE (the §12.43 root block below re-uses it) because
      // the envelope must be in hand before α is computed: it feeds the same
      // floor camTerm does. Stamped from the last OPEN frame, so the window
      // closing starts the hold — the exact moment the old behaviour dropped
      // every responsiveness signal at once while the departed light's ghost
      // still held the field (the user's "continues color bleeding and
      // flickering for quite some time"). While the window is open the term
      // is 1, which only widens what tr already grants.
      const tr = trackMotion ? Math.min(1, Math.max(0, Number(trackMotion()) || 0)) : 0;
      // §11.44: a moving light invalidates every cached visibility; the
      // clear rides the next world dispatches (8 frames covers the rest
      // cadence's widest gap) and every dispatch while the light moves.
      if (visCache) {
        const kPin = Number(globalThis.__giSrcVisCacheK);
        visCacheKU.value = Number.isFinite(kPin) && kPin >= 1 ? Math.round(kPin) : VIS_CACHE_K;
        const sPin = Number(globalThis.__giSrcVisCacheSpacing);
        const sWant = Number.isFinite(sPin) && sPin > 0 ? sPin : spacing0 * VIS_CACHE_SPACING_MUL;
        if (Math.abs(visCacheSpacingU.value - sWant) > 1e-6) { visCacheSpacingU.value = sWant; visCacheClearFrames = 8; }
        if (tr > 0) visCacheClearFrames = 8;
        visCacheClearU.value = visCacheClearFrames > 0 ? 1 : 0;
        if (visCacheClearFrames > 0) visCacheClearFrames--;
      }
      if (tr > 0) trOpenAt = nowMs;
      const lightSettleOn = globalThis.__giSrcLightSettle !== false;
      const holdPin = Number(globalThis.__giSrcLightSettleHoldMs);
      const fadePin = Number(globalThis.__giSrcLightSettleFadeMs);
      const lightHoldMs = Number.isFinite(holdPin) ? Math.max(0, holdPin) : LIGHT_SETTLE_HOLD_MS;
      const lightFadeMs = Number.isFinite(fadePin) ? Math.max(1, fadePin) : LIGHT_SETTLE_FADE_MS;
      const sinceTr = nowMs - trOpenAt;
      const lightTerm = lightSettleOn
        ? (sinceTr <= lightHoldMs
            ? 1
            : Math.max(0, 1 - (sinceTr - lightHoldMs) / lightFadeMs))
        : 0;
      const settleHatch = globalThis.__giSrcCamSettleAlpha;
      const alphaPinned = Number.isFinite(Number(globalThis.__giSrcAlpha));
      const settleFloor = Number.isFinite(Number(settleHatch)) && Number(settleHatch) > 0
        ? Number(settleHatch)
        : CAM_SETTLE_ALPHA;
      // One floor, two envelopes: re-equilibration is re-equilibration
      // whether the camera moved it or a light left it behind.
      const settleTerm = Math.max(camTerm, lightTerm);
      const alpha = settleHatch !== false && !alphaPinned
        ? Math.max(
            readAlpha(),
            TEMPORAL_ALPHA_STILL + settleTerm * (settleFloor - TEMPORAL_ALPHA_STILL),
          )
        : readAlpha();
      // Published every frame for probes — a plain number write. The α ramp
      // was UNGATEABLE end-to-end before this: `keepU` folds the stride root
      // in, so no page could read back what α the motion signal actually
      // produced, and the intensity-delta fix would have shipped on faith.
      globalThis.__giSrcAlphaLive = alpha;
      // §13.9's C0↔C1 gather-weight dial, pushed live so a probe can render
      // both arms in one boot at one pose (see `smoothU` in srcScreenGather).
      // Unset leaves the uniform at the shared reader's build-time value, so
      // an ordinary boot and every gate are untouched.
      //
      // ⛔⛔ AND A CLEARED PIN MUST RESTORE THE DEFAULT (2026-09-05). These four
      // blocks used to write the uniform only while the pin was finite, so
      // DELETING the flag left the last pinned value in place FOR EVER — the
      // arm "restore the default" measured the previous arm again, and every
      // A/B built on it was a comparison of one arm with itself. It cost this
      // session three arms before the picture stopped making sense (LOS pinned
      // to 0, cleared, and still off). An A/B rig that cannot return to its
      // own baseline is worse than no rig: it produces confident numbers.
      // `pinned(flag, dflt, lo, hi)` is the one shape all four now share.
      const pinned = (raw, dflt, lo, hi) => {
        const v = Number(raw);
        return raw != null && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
      };
      if (gather?.smoothWeights) {
        const v = pinned(globalThis.__giGatherSmoothLive, gatherSmoothWeights() ? 1 : 0, 0, 1);
        if (gather.smoothWeights.value !== v) gather.smoothWeights.value = v;
      }
      // §12.88's normal bias, same idiom and the same reason: the only A/B this
      // scene supports is one boot sweeping a uniform at one fixed pose.
      if (gather?.normalBias) {
        const v = pinned(globalThis.__giGatherNormalBiasLive, gatherNormalBias(), 0, 2);
        if (gather.normalBias.value !== v) gather.normalBias.value = v;
      }
      // §12.89's LOS suppression strength. Only has an effect when the march
      // was compiled in (`__giGatherLosWeight === true` at BUILD time) — the
      // probe arms the build and then sweeps this live.
      if (gather?.losStrength) {
        const v = pinned(globalThis.__giGatherLosLive, 1, 0, 1);
        if (gather.losStrength.value !== v) gather.losStrength.value = v;
      }
      // §10.6's behind-plane depth cap, live, so one boot can A/B the blobs
      // at one pose: `__giGatherPlaneDepthLive` in metres (1e6 = uncapped).
      if (gather?.planeDepth) {
        const v = pinned(globalThis.__giGatherPlaneDepthLive, gatherPlaneDepth(), 1e-4, 1e6);
        if (gather.planeDepth.value !== v) gather.planeDepth.value = v;
      }
      // ── THE ROOT RELAXES WITH MOTION (§12.43) ────────────────────────────
      // At m = 0 this is §12.32's root exactly — preserve evidence across
      // sparse refreshes, the still scene's variance shield. At m = 1 it is
      // no root at all: history is KNOWN-WRONG the moment the scene changes,
      // and preserving it multiplied a light step's convergence time by the
      // stride (measured 7.42 s at stride 12, `probe:gi-src-converge`).
      // GISystem's peak-hold keeps m up for the window the field needs.
      // `trackMotion` is nonzero ONLY while GISystem's light-event window is
      // open (a light matrix/luminance/emitter peak armed it — never mover
      // churn, never sub-threshold jitter; the gating lives THERE, one
      // definition). Standalone gates pass no getter and keep §12.32's root
      // identically. The first draft derived this from α itself and TRACK_AB
      // refuted it: any spurious motion spike became a 1.2 s burst of
      // relaxed-root fast decay, and the rig's still controls read 21.2 vs
      // 0.92 rev/px — the user saw it as water caustics on a parked floor.
      // (`tr` is hoisted above with the §12.67 light-settle envelope — the α
      // floor needs it before α is computed.)
      const mLight = motionOf(alpha);
      // §11.36: the same term WITHOUT the camera's settle envelope. `alpha`
      // above is floored by max(camTerm, lightTerm), so a moving camera
      // reads as "light motion" here (0.38 on the Level harness swung arm)
      // and the no-camera drive published below would never rest under
      // motion. Only the light-settle envelope survives in this copy.
      const mLightNoCam = motionOf(
        settleHatch !== false && !alphaPinned
          ? Math.max(readAlpha(), TEMPORAL_ALPHA_STILL + lightTerm * (settleFloor - TEMPORAL_ALPHA_STILL))
          : readAlpha(),
      );
      // ── THE REST CADENCE (§12.61) ────────────────────────────────────────
      // The cost-probe fit: deposit ≈ 3.7 ms floor + 42.2 ns/ray — rays are
      // 71% of the chain at ultra, and §12.60's α 0.02 means a parked scene
      // reaches the same steady state on half the evidence rate. So at rest
      // the ceiling scales by REST_TRANSPORT_FRACTION, and ANY of the three
      // responsiveness signals restores it continuously: the α motion ramp
      // (mLight), an open tracking window (tr — a light just changed), or a
      // recent camera move (held REST_CAM_HOLD_MS, then FADED over
      // REST_CAM_FADE_MS — a budget step on the frame a pan ends is R1's
      // cliff in miniature). The decay's stride root below reads the stride
      // this produces, so evidence preservation follows the real refresh rate
      // with no extra wiring. A pinned `__giSrcTransportRays` is an
      // instrument and is never scaled (readCeiling returns the pin; the
      // factor is forced to 1 so the pin means what the arm that set it
      // meant).
      // (`camTerm` is computed with the settle-α floor above — one envelope,
      // two consumers: the α floor and this budget restore.)
      // The boot hold: the fill-from-black is the one convergence the seed
      // cannot prior (no parents exist yet), so the first seconds run at the
      // full budget whatever the camera does. Same hold+fade shape as camTerm.
      const sinceBuild = nowMs - buildAt;
      const bootTerm = sinceBuild <= REST_BOOT_HOLD_MS
        ? 1
        : Math.max(0, 1 - (sinceBuild - REST_BOOT_HOLD_MS) / REST_CAM_FADE_MS);
      const ceilingPinned = Number.isFinite(Number(globalThis.__giSrcTransportRays));
      const restOn = globalThis.__giSrcRestCadence !== false && !ceilingPinned;
      const forcedFraction = Number(globalThis.__giSrcRestFraction);
      const restFraction = Number.isFinite(forcedFraction)
        ? Math.min(1, Math.max(0.1, forcedFraction))
        : REST_TRANSPORT_FRACTION;
      // §12.67: `lightTerm` keeps the budget up after the window CLOSES —
      // the departed light's ghost needs evidence to drain without blotches.
      const restDrive = Math.max(mLight, tr, camTerm, bootTerm, lightTerm);
      // §18/§11.36: the drive WITHOUT the camera term, for GISystem's world
      // cadence under "converged motion" (every light declared static): a
      // moving camera reveals probes, it does not change what a known probe
      // must answer, so the chain's RATE can stay at rest while the ray
      // ceiling above still follows the camera (motionScale, camTerm).
      globalThis.__giSrcRestDriveNoCamLive = Math.max(mLightNoCam, tr, bootTerm, lightTerm);
      // The terms themselves, for `profile.frameStats.giHold.restTerms`: when
      // the chain will not rest, this names WHICH input is holding it up.
      globalThis.__giSrcRestTermsLive = { mLight, mLightNoCam, tr, cam: camTerm, boot: bootTerm, light: lightTerm };
      restFactor = restOn ? restFraction + (1 - restFraction) * restDrive : 1;
      // ── THE BOOT RAMP (2026-09-02, the lit-frame stall) ─────────────────
      // The transport's FIRST trace is ~2 s of GPU on the user's Level
      // (`probe:gi-boot-frames`, per-submit clock: `src:deposit (trace +
      // attribute)` the first slow submit, 393 k rays; 32 k rays → 0.8 s, a
      // 4× smaller pool → 1.0 s — half the frame is ray work on a cold
      // field, half is pool-sized sweeps). The boot hold above spends the
      // FULL budget from frame one, which is the one frame that cannot
      // afford it: the page blocks on the swap chain behind that submit.
      // Ramp the ceiling over the first BOOT_RAMP_FRAMES frames instead
      // (1/8 → 1); the hold still lasts its 3 s, so convergence loses ~4
      // frames' worth of rays out of ~180. `__giSrcBootRampFrames` pins the
      // length (0 = off).
      const rampPin = Number(globalThis.__giSrcBootRampFrames);
      const rampFrames = Number.isFinite(rampPin) ? Math.max(0, rampPin) : BOOT_RAMP_FRAMES;
      framesSinceBuild += 1;
      const bootRamp = rampFrames > 0 && !ceilingPinned
        ? Math.min(1, framesSinceBuild / rampFrames)
        : 1;
      restFactor *= bootRamp;
      globalThis.__giSrcRestFactorLive = restFactor;
      // The ceiling is live (see `readCeiling`) and the rest factor rides it.
      // Re-derived HERE, before the stride root, so `rootS` reads the stride
      // this frame actually refreshes at — the old order computed the root
      // from last frame's stride, harmless when the ceiling moved once per
      // probe run and wrong every frame near a rest transition.
      const nextCeiling = Math.max(1, Math.round(readCeiling() * restFactor * motionScale));
      if (nextCeiling !== rayCeiling) {
        rayCeiling = nextCeiling;
        rayCeilingU.value = rayCeiling;
        rayStride = strideFor(rayCeiling);
        strideU.value = rayStride;
        publishTransport();
      }
      // ── §12.74: A LIGHT THAT KEEPS MOVING RELAXES THE ROOT TOO ───────────
      //
      // The root above relaxes only while `tr > 0` — GISystem's light-event
      // window, which §12.46 made RISING-EDGE precisely so a continuously
      // moving light could not hold it open. That was the right call for what
      // the window ALSO does (an open window lifts the per-probe ray cap to
      // OFF: a 3.8× deposit swing, the "gpu time constantly ballooning"
      // report), but the two effects were bundled onto one signal, so the
      // CHEAP half went with the expensive one. The consequence is the user's
      // 2026-08-15 report — "any light that moves, temporal is just too slow
      // to keep up, it feels very unresponsive": with the window shut, α is
      // spread over a whole refresh interval by the stride root, so at stride
      // ~9 and 30 fps a moving light's field settles with t90 ≈ 7 s.
      //
      // So the ROOT (free — one uniform, no extra rays) now also relaxes with
      // SUSTAINED motion, while the CAP (expensive) keeps reading `tr` alone
      // and stays capped. History that is being continuously invalidated is
      // not evidence worth preserving.
      //
      // ⚠ SUSTAINED, not instantaneous, and this is the whole safety argument:
      // §12.43's first draft derived the root from α directly and TRACK_AB
      // refuted it — a spurious one-frame spike became a burst of relaxed-root
      // fast decay and the still controls read 21.2 vs 0.92 rev/px ("water
      // caustics on a parked floor"). A spike cannot survive MOTION_SUSTAIN_MS
      // of continuous above-threshold motion, and a light that genuinely keeps
      // moving trivially can. `__giSrcMotionRoot = false` is the A/B arm.
      // ⚠ AND IT IS CAPPED BELOW 1 (2026-08-15, the same evening's second
      // report: "now it seems we have our flicker back"). Relaxing the root
      // ALL the way spends the stride's evidence preservation entirely, and at
      // a capped ray budget that is variance — the noise the root existed to
      // shield. 0.7 keeps a third of the preservation: at stride 9 the field's
      // t90 goes ~7 s → ~2.5 s rather than 0.8 s, and §12.65's screen filter
      // (whose weight now has a floor under exactly this state, GISystem) eats
      // what is left. `__giSrcMotionRoot` takes a NUMBER to pin the relax
      // itself — the live dial for this trade — or `false` to opt out.
      const MOTION_SUSTAIN_MS = 250;
      const MOTION_ROOT_ON = 0.15;
      const MOTION_ROOT_MAX = 0.7;
      if (mLight >= MOTION_ROOT_ON) {
        if (!motionSustainSince) motionSustainSince = nowMs;
      } else {
        motionSustainSince = 0;
      }
      const rootPin = Number(globalThis.__giSrcMotionRoot);
      const sustained = globalThis.__giSrcMotionRoot === false || !motionSustainSince
        || nowMs - motionSustainSince < MOTION_SUSTAIN_MS
        ? 0
        : (Number.isFinite(rootPin)
          ? Math.min(1, Math.max(0, rootPin))
          : Math.min(MOTION_ROOT_MAX, mLight));
      globalThis.__giSrcMotionRootLive = sustained;
      // ── THE LIGHT-SETTLE HOLD LIFTS THE STRIDE ROOT TOO (2026-09-02) ────
      //
      // `probe:gi-src-converge`, strided arm (stride 12 = the user's ultra
      // regime), with the transport's dials traced through a 3× light step:
      // α ran 0.1 → 0.05 → 0.02 inside 3 s, exactly as the settle hold
      // intends, but the ROOT went 0.70 → 0.38 → 0 with `sustained` — the
      // motion signal, which a light step only brushes — so the settle
      // alpha was being paid at the 4th…8th root per frame and the still
      // alpha at the 12th: 0.22 of the old field left at 2.5 s, then a
      // 470-frame crawl to 90 % (t90 10.8 s; every frame of it at the
      // shipped 2 %-per-visit blend). The surprise detector cannot carry
      // this case either — its shot-noise floor is blind below ~2 deposits
      // per frame per block (`scratchpad/surprise-sim.mjs` on the CPU twin:
      // a 3× step at 1 deposit/frame peaks at u 0.41, never trips), and at
      // stride 12 that is most of the pool.
      //
      // The hold already KNOWS a light changed (`lightTerm`). While it is
      // open the root is lifted with it: keep = (1−α) per frame, so the
      // settle alpha converges in 2.3/α = 46 frames — inside the 1.5 s hold
      // — and the fade hands the root back as the alpha falls. Energy is
      // unaffected (the bins are count-weighted means; the decay scales sum
      // and count alike). `__giSrcLightRootRelax = false` restores the
      // motion-only root for an A/B.
      const lightRootRelax = globalThis.__giSrcLightRootRelax !== false ? lightTerm : 0;
      const rootS = 1 + (Math.max(1, rayStride) - 1) * (1 - Math.max(tr, sustained, lightRootRelax));
      const keep = (1 - alpha) ** (1 / rootS);
      if (keepU.value !== keep) keepU.value = keep;
      // §11.13: the far duty follows motion — the camera's sustained motion
      // or an open light window — between its rest and motion values.
      if (farDutyOn) {
        const m = Math.min(1, Math.max(0, Math.max(sustained, mLight)));
        const rest = farDutyRest();
        const duty = rest + (farDutyMotion() - rest) * m;
        if (farDutyU.value !== duty) farDutyU.value = duty;
        globalThis.__giSrcFarDutyLive = duty;
      }
      // Live dials for the convergence probe (read-only receipts, same reason
      // `__giSrcAlphaLive` exists): the effective per-frame keep, the root it
      // came through, and the light-settle term that may have lifted it.
      globalThis.__giSrcKeepLive = keep;
      globalThis.__giSrcRootSLive = rootS;
      globalThis.__giSrcLightTermLive = lightTerm;
      // The compensation lift rides the same α, published for the same
      // reason α is: the rig's CAP arms need to SEE that compensation was
      // active, not assume it. Compare-then-assign, still scene uploads
      // nothing.
      const lift = liftFor(alpha);
      globalThis.__giSrcCompLiftLive = lift;
      if (influxLiftU.value !== lift) influxLiftU.value = lift;
      // ── SURPRISE'S TWO CPU DIALS ─────────────────────────────────────────
      //
      // `surpriseF` is the fast-α decay expressed against THIS frame's own
      // `keep` — the stride root is already folded into `keep`, so a surprised
      // block reaches the rate the moving scene would have used at stride 1
      // rather than a rate that happens to be faster. Floored at 1: surprise
      // may only accelerate forgetting. With α pinned to the moving value the
      // ratio IS 1 and the mix becomes a no-op, which is the instrument rule
      // (a pin must not be quietly overridden by a scene-derived term).
      const decayNow = Math.max(1e-6, 1 - keep);
      const surpriseF = Math.max(1, TEMPORAL_ALPHA / decayNow);
      if (surpriseFU.value !== surpriseF) surpriseFU.value = surpriseF;
      // THE GOVERNOR. Surprise and §12.45's scene-wide light window solve the
      // same problem, and both at once pays for uncapped evidence twice while
      // the window's relaxed root already decays fast. So the per-block term
      // fades out across [GOV_LO, GOV_HI] of the same motion signal the α ramp
      // rides. Smoothstep rather than a threshold for R1's reason: a binary
      // handover would step the ray budget on the frame it crossed.
      // `mLight` is hoisted above (the rest cadence reads it too).
      const govT = Math.min(1, Math.max(0, (mLight - GOV_LO) / Math.max(1e-6, GOV_HI - GOV_LO)));
      const forcedGain = Number(globalThis.__giSrcSurpriseGain);
      const gain = Number.isFinite(forcedGain)
        ? Math.min(1, Math.max(0, forcedGain))
        : 1 - govT * govT * (3 - 2 * govT);
      if (surpriseGainU.value !== gain) surpriseGainU.value = gain;
      // The stamp advances with the jitter and for the same reason: both are
      // "which frame is this", and the decay pass compares against it exactly.
      // It wraps at 2^32 — 2.2 years at 60 fps, and the only consequence of a
      // wrap is that a block untouched since the last lap gets zeroed instead
      // of decayed, which is what a block untouched for 2.2 years deserves.
      frameStampU.value = (frameStampU.value + 1) >>> 0;
      // The re-anchor kill's countdown (see syncCamera): armed for two
      // frames so pass ordering inside the re-anchor frame cannot leak a
      // stale-keyed probe, then off.
      const killOn = retainKillFrames > 0 ? 1 : 0;
      if (retainKillU.value !== killOn) retainKillU.value = killOn;
      if (retainKillFrames > 0) retainKillFrames--;
      // The ray ceiling's residue class, rotated by the same counter. Over
      // `stride` frames every pixel is sampled exactly once, which is what
      // makes this a temporal subsample rather than a permanent crop — and the
      // accumulator it feeds is the one §12.23 built to weight by evidence.
      // Read from `frameStampU` rather than a second counter so there is one
      // definition of "which frame is this" (the decay pass compares against it
      // exactly, and two counters that drift would silently decorrelate the
      // stride from the decay).
      // (The ceiling poll moved ABOVE the stride root — see the rest-cadence
      // block. `publishTransport` still fires only on change.)
      // The cap polls on the same schedule and for the same reason as the
      // ceiling. Compare-then-assign: a still scene uploads nothing.
      // ── AND IT LIFTS INSIDE THE TRACKING WINDOW (§12.45) ─────────────────
      // Measured before built (rig LIGHT_STEP, interleaved ×2): post-step
      // churn 24.1 rev/px shipped vs 15.3 with the cap off vs 3.7 window-off
      // — the cap owns 36% of the light-update flicker, because the window's
      // fast decay needs evidence at exactly the rate the cap denies. So
      // while GISystem's light-event window is open (`tr` above — never mover
      // churn, never camera pans), the tier cap lifts to OFF and the fat
      // probes feed the fast α; it re-engages when the window closes. The
      // deposit pays uncapped cost for the window's 1.2 s, which is the point.
      // A cap PINNED via `__giSrcProbeRayCap` NEVER lifts — pins belong to
      // instruments (§12.42: non-cap sweeps pin the cap off), and a pin that
      // drifted with scene state would un-A/B every arm that set it.
      // `__giSrcCapWindowLift = false` opts out (the rig's no-lift arm).
      // The CAMERA window is OPT-IN as of §12.47 — `camHoldUntil` only ever
      // advances when `__giSrcCamCapLift === true`, so this term is false in
      // the shipping config and the test below costs one clock read. See the
      // block at the top of this function for why it cost half the frame rate.
      // ⚠ `!= null` FIRST: clearing a dev flag can leave the property present
      // as `null`, and `Number(null)` is 0 — a finite value, so the pin test
      // read "pinned" and silently disabled every lift path (measured: the
      // cap stayed at 8 with the flag "cleared").
      const capPinRaw = globalThis.__giSrcProbeRayCap;
      const capPinned = capPinRaw != null && Number.isFinite(Number(capPinRaw)) && Number(capPinRaw) > 0;
      const capLifted = !capPinned && (
        (tr > 0 && globalThis.__giSrcCapWindowLift !== false)
        || performance.now() < camHoldUntil
      );
      // REST CAP (2026-09-02): at rest (the same drive the rest cadence reads:
      // no light motion, no tracking, camera parked, no light surprise) the
      // per-probe cap halves. Measured on the user's Bistro: the cap is what
      // bounds the fired count NEAR the camera (41 592 rays of a 180 k stride
      // want, 27 ms per world dispatch at ~650 ns per ray against a 2.8 M-tri
      // BVH8), so halving it halves the dispatch while the far, stride-bound
      // probes keep every ray they had. Surprised blocks still get their
      // `cap << shift` lift, and tracking/camera motion lifts the cap entirely
      // as before. `__giSrcRestCap = false` keeps the tier cap at rest.
      const restDriveNow = (restFactor - REST_TRANSPORT_FRACTION) / Math.max(1e-6, 1 - REST_TRANSPORT_FRACTION);
      const restCapOn = !capPinned && globalThis.__giSrcRestCap !== false && restDriveNow < 0.05;
      // BOUNDED LIFT (2026-09-02): the tracking / light-window lift used to
      // set the cap to OFF (0x3fffffff = unbounded per probe). Measured on the
      // user's Bistro under camera motion: 61 184 rays per dispatch against
      // 33 k at rest, the world chain at 33 ms EVERY frame, 15 fps. The near
      // probes were taking hundreds of rays a frame while the far ones stayed
      // stride-bound. Two times the tier cap (64 at ultra = 2 rays per bin per
      // frame) is the lift now; `__giSrcCapLiftFactor` sets it (Infinity =
      // the old unbounded lift).
      const liftFactor = Number(globalThis.__giSrcCapLiftFactor);
      const liftedCap = Number.isFinite(liftFactor) && liftFactor > 0
        ? Math.min(PROBE_RAY_CAP_OFF, Math.max(1, Math.round(readCap() * liftFactor)))
        : (liftFactor === Infinity ? PROBE_RAY_CAP_OFF : Math.min(PROBE_RAY_CAP_OFF, readCap() * 2));
      // The rest branch halves THE SCENE'S cap — at rest the camera is parked
      // and convergence is the only thing left to buy.
      //
      // ⭐ §11.50: EXCEPT WHILE THE LOOP IS RUNNING. The halving is one more
      // open-loop guess stacked on the number the loop exists to measure, and
      // it is guessing in the wrong direction: at rest the loop's own budget
      // term is ALREADY the rest-scaled `naturalRays / rayStride`, so it
      // cannot overspend a parked frame — the ceiling and the stride bound it
      // whatever the cap says. Halving on top only re-imposes the starvation
      // this unit removed, at exactly the moment (a parked camera on an
      // incomplete field) when convergence is the only thing left to buy.
      // The MOTION scale below is untouched: that one is about frame time
      // outranking convergence while the camera moves (§11.9), which the
      // loop's budget term cannot see.
      const loopOwnsCap = capLoop > 0;
      const unscaledCap = capLifted
        ? liftedCap
        : (restCapOn && !loopOwnsCap ? Math.max(readCap(), budgetCap() >> 1) : budgetCap());
      // §11.9: the motion scale rides the cap too — the near probes are where
      // the rays concentrate under motion (the bounded-lift note above).
      const nextCap = unscaledCap >= PROBE_RAY_CAP_OFF
        ? unscaledCap
        : Math.max(4, Math.round(unscaledCap * motionScale));
      if (nextCap !== probeRayCap) {
        probeRayCap = nextCap;
        capU.value = nextCap;
        publishTransport();
      }
      // ── [D1']'s EXEMPTION SWITCH ─────────────────────────────────────────
      //
      // Off for COLD_GUARD_FRAMES after a build or a re-anchor: a re-anchor
      // re-keys every probe, so EVERY block is claimed on one frame and the
      // cold fill would multiply the whole frame's ray budget by four on
      // exactly the frame that already rebuilt the lattice.
      //
      // A PINNED CAP NEVER LIFTS, the same instrument rule §12.45 states for
      // the window lift: pins belong to instruments, and a pin that drifted
      // with scene state would un-A/B every arm that set it.
      //
      // `__giSrcColdFill = false` turns off BOTH legs — one uniform gates the
      // whole exemption path in [D1'], and splitting it would cost a second
      // uniform to disable a leg no measurement has separated yet.
      if (coldGuard > 0) coldGuard--;
      const boostOn = surpriseOn && globalThis.__giSrcColdFill !== false
        && !capPinned && coldGuard === 0 ? 1 : 0;
      if (boostEnableU.value !== boostOn) boostEnableU.value = boostOn;
      // [J]'s LOD-bias hatch, polled beside the others for the same §12.23
      // reason: a build-time read can only be A/B'd by reloading.
      secondary?.poll();
      // The seed's live dial, same rule. 0 zeroes every seeded word and is the
      // flicker instrument's in-page off arm; the build hatch is `__giSrcSeed`.
      if (seed) {
        const forcedSeed = Number(globalThis.__giSrcSeedRays);
        const nextSeed = Number.isFinite(forcedSeed) ? Math.max(0, forcedSeed) : SEED_RAYS;
        if (seedRaysU.value !== nextSeed) seedRaysU.value = nextSeed;
        // §11.16: the far-field prior's dial, same rule (0 = the off arm).
        const forcedStarve = Number(globalThis.__giSrcStarvePackets);
        const nextStarve = Number.isFinite(forcedStarve) ? Math.max(0, Math.floor(forcedStarve)) : STARVE_PACKETS;
        if (starvePacketsU.value !== nextStarve) starvePacketsU.value = nextStarve;
        const forcedRays = Number(globalThis.__giSrcStarveRays);
        const nextThreshold = (Number.isFinite(forcedRays) ? Math.max(0, forcedRays) : STARVE_RAYS) * DEPOSIT_SCALE;
        if (starveThresholdU.value !== nextThreshold) starveThresholdU.value = nextThreshold;
        const forcedFar = Number(globalThis.__giSrcSeedFarRays);
        const nextFar = Number.isFinite(forcedFar) ? Math.max(0, forcedFar) : SEED_RAYS_FAR;
        if (seedFarRaysU.value !== nextFar) seedFarRaysU.value = nextFar;
      }
      phaseU.value = rayStride > 1 ? frameStampU.value % rayStride : 0;
      const a = anchorU.value;
      const drift = Math.max(
        Math.abs(cameraU.value.x - a.x),
        Math.abs(cameraU.value.y - a.y),
        Math.abs(cameraU.value.z - a.z),
      );
      // ══ S1: UNDER WORLD-ABSOLUTE KEYS THE ANCHOR STOPS BEING IDENTITY ═════
      //
      // `worldCellAt` is `round(anchor/s) + round((p − round(anchor/s)·s)/s)`,
      // which is identically `round(p/s)` for ANY integer origin cell. So a
      // probe's key does not depend on where the anchor is, and moving the
      // anchor cannot renumber anything. The anchor's only remaining job is the
      // one trap 4 in `srcMathTsl` names: keeping the f32 division
      // camera-relative so it stays exact far from the world origin.
      //
      // Which means it should follow the camera CONTINUOUSLY, and the whole
      // re-anchor apparatus below — the 64·s₀ drift threshold, the 16·s₀
      // hysteresis quantum, the cold-guard re-arm, the `reanchors` counter the
      // telemetry prints — exists only to make a re-keying event RARE. There is
      // no re-keying event any more.
      //
      // The plan calls the old behaviour "wholesale history loss on long moves"
      // and it is exactly that: past the threshold every probe in the scene got
      // a new key, retired, and came back cold on one frame. This returns FALSE
      // — no re-anchor happened, because there is nothing to re-anchor — while
      // still tracking the camera, so `syncCamera`'s callers see a scene that
      // never re-anchors instead of one that does it silently.
      if (worldKeysEnabled()) {
        // Quantized, not raw: `latticeOriginCell` is `round(anchor/s)` per level,
        // so a jittering anchor would recompute every level's origin cell every
        // frame for no benefit. The quantum keeps the uniform still while the
        // camera walks, which keeps the uploads at zero on a static view.
        const q = ANCHOR_QUANTUM * spacing0;
        scratch.copy(cameraU.value).divideScalar(q).round().multiplyScalar(q);
        if (!anchored || !a.equals(scratch)) {
          a.copy(scratch);
          anchored = true;
        }
        return false;
      }
      // The radius is DERIVED from the key window — see `reanchorChebyshev`'s
      // header for why the old constant fired inside the user's house at ultra
      // and not at high. Cells of the ACTUAL lattice, because the key window is
      // in those cells; an earlier version pinned this to the TIER's nominal
      // spacing to stop the radius shrinking with a refined s0, which the
      // derived value makes unnecessary — 174 cells is past any interior at
      // every tier, so there is nothing left to protect against.
      const reanchorMetres = reanchorChebyshev() * spacing0;
      if (anchored && drift <= reanchorMetres) return false;
      if (anchored && holdAnchor) return false;
      // Snap to a whole number of quanta rather than to the camera itself, so a
      // player pacing back and forth across the threshold does not re-anchor on
      // alternate frames. The quantum is the hysteresis.
      const q = ANCHOR_QUANTUM * spacing0;
      scratch.copy(cameraU.value).divideScalar(q).round().multiplyScalar(q);
      a.copy(scratch);
      anchored = true;
      reanchors++;
      // Every probe is about to be re-keyed, so every block will be claimed on
      // one frame and every one of them COLD. Re-arm the guard — see the switch
      // above for what the unguarded version costs.
      coldGuard = COLD_GUARD_FRAMES;
      // Retire EVERYTHING this frame (and the next, for ordering safety) —
      // the anchor-relative retention's jump guard, and the fix for the
      // pre-existing 60-frame stale-key adoption window (srcProbes' age
      // pass carries the argument).
      retainKillFrames = 2;
      return true;
    },

    /** Telemetry for `profile.giPasses` and the boot log. Async — off the hot path. */
    async readStats(renderer) {
      const readBinHistogram = async (r) => {
        const P = SrcProbesNS;
        const D = SrcDepositNS;
        const table = new Uint32Array(await r.getArrayBufferAsync(store.probeTable.value));
        const scratch = new Uint32Array(await r.getArrayBufferAsync(binStore.scratch.value));
        const out = [];
        for (let c = 0; c < store.cascades.length; c++) {
          const pc = store.cascades[c];
          const info = binStore.cascades.find((b) => b.cascade === c);
          if (!info) continue;
          const h = { zero: 0, below1: 0, one4: 0, four16: 0, above16: 0, total: 0, probes: 0 };
          let sumAll = 0;
          let sumSampled = 0;
          for (let k = 0; k < pc.probeCapacity; k++) {
            const w = (pc.probeBase + k) * P.PROBE_WORDS;
            if ((table[w + P.PROBE_FLAGS] & P.FLAG_ALIVE) === 0) continue;
            const block = table[w + P.PROBE_BLOCK] >>> 0;
            if (block === P.SLOT_EMPTY) continue;
            h.probes++;
            const base = (info.binBase + block * info.bins) * D.BIN_WORDS;
            for (let m = 0; m < info.bins; m++) {
              const cnt = scratch[base + m * D.BIN_WORDS + D.BIN_COUNT] >>> 0;
              const rays = cnt / D.DEPOSIT_SCALE;
              h.total++;
              sumAll += rays;
              if (cnt === 0) h.zero++;
              else {
                sumSampled += rays;
                if (rays < 1) h.below1++;
                else if (rays < 4) h.one4++;
                else if (rays < 16) h.four16++;
                else h.above16++;
              }
            }
          }
          const pct = (n) => +(100 * n / Math.max(1, h.total)).toFixed(1);
          out.push({
            cascade: c, probes: h.probes, bins: h.total,
            zeroPct: pct(h.zero), below1Pct: pct(h.below1), one4Pct: pct(h.one4),
            four16Pct: pct(h.four16), above16Pct: pct(h.above16),
            meanRaysAll: +(sumAll / Math.max(1, h.total)).toFixed(3),
            meanRaysSampled: +(sumSampled / Math.max(1, h.total - h.zero)).toFixed(3),
          });
        }
        return out;
      };
      // ⚠ ONE FRAME FOR EVERY COUNTER (2026-09-03). These readbacks used to be
      // awaited one after another, and each await spans frames — so a walk
      // probe that stops moving while it waits read the population counters
      // from a moving frame ("fresh 51") and the seed's tally from a parked
      // one three awaits later ("seed 0 probes"): the seed looked inert on
      // Sponza when only the instrument was. Every buffer copy is now
      // SUBMITTED in this tick (each readStats issues its getArrayBufferAsync
      // before its first await) and awaited together, so the whole receipt
      // describes one frame.
      const pending = {
        stats: readSrcProbeStats(renderer, store),
        totalRays: rayFrame.readTotal(renderer),
        rays: deposit ? deposit.readStats(renderer) : null,
        // §11.44: the visibility cache's row table, read back whole — which
        // rows exist and how many samples they carry. The per-frame counters
        // are the last WORLD frame's (stale under a parked idle world); this
        // is the table as it is now.
        visCache: visCache
          ? (async () => {
              const v = new Uint32Array(await renderer.getArrayBufferAsync(visRows.value));
              const hist = { c1: 0, c2to7: 0, c8to63: 0, c64plus: 0 };
              let rows = 0, maxCnt = 0, cells = 0;
              for (let i = 0; i < v.length; i++) {
                const cnt = v[i] & 0xff;
                if (cnt === 0) continue;
                rows++;
                if (cnt > maxCnt) maxCnt = cnt;
                if (cnt === 1) hist.c1++;
                else if (cnt < 8) hist.c2to7++;
                else if (cnt < 64) hist.c8to63++;
                else hist.c64plus++;
              }
              for (let c = 0; c < VIS_CACHE_CAP; c++) {
                const base = c * VIS_CACHE_ROWS;
                for (let j = 0; j < VIS_CACHE_ROWS; j++) if ((v[base + j] & 0xff) !== 0) { cells++; break; }
              }
              return { capacity: VIS_CACHE_CAP, rowsPerCell: VIS_CACHE_ROWS, K: visCacheKU.value, spacing: +visCacheSpacingU.value.toFixed(3), cells, rows, maxCnt, hist };
            })()
          : null,
        seed: seed ? seed.readStats(renderer) : null,
        secondary: secondary ? secondary.readStats(renderer) : null,
        merge: merge ? merge.readStats(renderer) : null,
        tiles: tiles ? tiles.readStats(renderer) : null,
        gather: gather ? gather.readStats(renderer) : null,
      };
      const stats = await pending.stats;
      // §11.49: the live c0 population is what the per-probe cap divides the
      // frame's ray ceiling by. This readback already runs every 60 frames,
      // which is the right timescale — the population changes as the camera
      // walks, not within a frame.
      // ⚠ `readSrcProbeStats` resolves to an ARRAY of cascade rows, not `{cascades}`.
      liveC0ForCap = stats?.[0]?.live ?? liveC0ForCap;
      // §11.50: the numbers that actually drive the cap — what the frame FIRED
      // and how complete the field it fired into is. Awaited here rather than
      // at the return so the loop steps once per readback whoever called it;
      // every caller is rate-limited by the 60-frame periodic reader, and an
      // extra profile call only converges it sooner.
      {
        const liveC0 = stats?.[0]?.live ?? 0;
        const starved = stats?.[0]?.starved ?? 0;
        stepBudgetCap({
          fired: await pending.totalRays,
          knownFrac: (await pending.tiles)?.knownFrac,
          starvedFrac: liveC0 > 0 ? starved / liveC0 : 0,
        });
      }
      // ── §11.17 THE STARVATION LEDGER (opt-in: `__giProfileProbeRays = true`) ──
      // Rays are born per PIXEL, so a probe's ray rate follows its screen
      // footprint: a far, dark corridor feeds its probes almost nothing and
      // their 32 bins take minutes — the user's "patches that don't resolve
      // until I walk closer". This reads the c0 probe table back (a few MB,
      // profile-time only) and histograms THIS frame's allotment
      // (PROBE_RAYS, after the cap) by the probe's LOD: how many live probes
      // per LOD, their mean rays/frame, and the share that got 0 or < 2.
      const probeRays = globalThis.__giProfileProbeRays === true
        ? await (async () => {
            const c0 = store.cascades[0];
            const words = new Uint32Array(await renderer.getArrayBufferAsync(store.probeTable.value));
            const rows = new Map();
            for (let p = 0; p < c0.probeCapacity; p++) {
              const w = (c0.probeBase + p) * SrcProbesNS.PROBE_WORDS;
              if ((words[w + SrcProbesNS.PROBE_FLAGS] & SrcProbesNS.FLAG_ALIVE) === 0) continue;
              const key = unpackProbeKey(words[w + SrcProbesNS.PROBE_KEY]);
              const lod = key ? key.lod : -1;
              const rays = words[w + SrcProbesNS.PROBE_RAYS] >>> 0;
              const row = rows.get(lod) ?? { lod, probes: 0, visible: 0, rays: 0, zero: 0, under2: 0, fresh: 0 };
              row.probes++;
              // VISIBLE = seen this frame (age 0). Held probes (retention,
              // behind the camera) get no rays by design and must not count
              // as starved.
              if ((words[w + SrcProbesNS.PROBE_AGE] >>> 0) !== 0) { rows.set(lod, row); continue; }
              row.visible++;
              row.rays += rays;
              if (rays === 0) row.zero++;
              if (rays < 2) row.under2++;
              if (words[w + SrcProbesNS.PROBE_FLAGS] & SrcProbesNS.FLAG_FRESH) row.fresh++;
              rows.set(lod, row);
            }
            return [...rows.values()].sort((a, b) => a.lod - b.lod).map((r) => ({
              lod: r.lod, probes: r.probes, visible: r.visible, fresh: r.fresh,
              // Over VISIBLE probes only.
              meanRays: +(r.rays / Math.max(1, r.visible)).toFixed(3),
              zeroRayShare: +(r.zero / Math.max(1, r.visible)).toFixed(3),
              under2RayShare: +(r.under2 / Math.max(1, r.visible)).toFixed(3),
            }));
          })()
        : null;
      // ── SURPRISE'S TWO INSTRUMENTS, PUBLISHED HERE AND NOT PER FRAME ─────
      //
      // Both are GPU readbacks, and §13's startup work priced what a readback
      // on the frame path costs (the `field ready` diagnostic was 1.0–1.8 s of
      // every startup number this project ever recorded). `readStats` is
      // already async and already off the hot path, so a probe polls the
      // instrument rather than the renderer paying for it every frame.
      //
      // They separate the three ways this mechanism renders identically to
      // being absent: never armed (`boosted` 0 with a nonzero mean u — the
      // guard or the pin), never surprised (mean u 0 — the governor or the
      // evidence floor), or working.
      if (surpriseBundle) {
        globalThis.__giSrcBoostedLive = stats.reduce((a, s) => a + (s.boosted ?? 0), 0);
        const free = new Uint32Array(await renderer.getArrayBufferAsync(store.freeStack.value));
        let sum = 0;
        for (let b = 0; b < store.blockTotal; b++) sum += free[store.blockSurpriseBase + b] >>> 0;
        globalThis.__giSrcSurpriseLive = store.blockTotal > 0
          ? sum / store.blockTotal / SURPRISE_ONE
          : 0;
      }
      return {
        cascades: stats,
        reanchors,
        bytes: store.bytes + rayStore.bytes + (binStore?.bytes ?? 0)
          + (merge?.bytes ?? 0) + (tiles?.bytes ?? 0) + (hashBlockFrame?.bytes ?? 0),
        spacing0,
        pixelCount: activePixelCount,
        raysPerPixel: tier.raysPerPixel,
        totalRays: await pending.totalRays,
        rays: await pending.rays,
        visCache: await pending.visCache,
        seed: await pending.seed,
        probeRays,
        secondary: await pending.secondary,
        merge: await pending.merge,
        tiles: await pending.tiles,
        gather: await pending.gather,
        // §11.13: per-cascade histogram of the bins' COUNT words (in rays),
        // over live blocks. Opt-in (`__giProfileBinHistogram = true`) — it
        // reads the whole scratch buffer back (~200 MB on Bistro).
        binHistogram: globalThis.__giProfileBinHistogram === true && binStore
          ? await readBinHistogram(renderer)
          : null,
      };
    },

    /**
     * A viewport resize normally updates this system in place. The pixel
     * buffers are capacity-sized, Three r185 reads ComputeNode.count through a
     * dispatch uniform, and the gather carriers resample the live gbuffer by
     * normalized coordinates. Only capacity/pool growth creates a new system.
     */
    // §11.8: `deferDispose` returns the NEXT system without disposing this
    // one or moving the gizmos — GISystem compiles the new store's kernels
    // behind the live one and commits the swap (dispose + reparent) itself
    // once they have landed. Without it a pool grow is a 20–30 s hole.
    setSize(nextWidth, nextHeight, nextPools = null, { deferDispose = false } = {}) {
      // A pool grow rides THIS path (§12.77 Unit A): same dims + changed pools
      // is a real rebuild, not a no-op — the dispatch counts baked from the
      // capacities are exactly as compile-time as the ones baked from the
      // resolution. `nextPools` values already resolved through the hatch
      // precedence land in `poolConfig`, so comparing against it is exact.
      const poolsChanged = nextPools && (
        (Number(nextPools.c0Probes) || 0) > system.poolConfig.c0Probes ||
        (Number(nextPools.binBudget) || 0) > system.poolConfig.binBudget ||
        // §11.4 A3: a per-cascade block grow is a rebuild for the same reason
        // a budget grow is — the capacities are baked into the kernels.
        (Array.isArray(nextPools.blocks) && nextPools.blocks.some(
          (b, c) => (Number(b) || 0) > (system.poolConfig.blocks?.[c] ?? 0),
        ))
      );
      if (nextWidth === system.width && nextHeight === system.height && !poolsChanged) return system;
      const nextPixelCount = nextWidth * nextHeight;
      if (!poolsChanged && nextPixelCount + receiverCapacity <= pixelCapacity) {
        activePixelCount = nextPixelCount + receiverCapacity;
        widthU.value = nextWidth;
        heightU.value = nextHeight;
        pixelCountU.value = activePixelCount;
        screenPixelCountU.value = nextPixelCount;
        frame.setPixelCount(activePixelCount);
        naturalRays = activePixelCount * tier.raysPerPixel;
        rayStride = strideFor(rayCeiling);
        strideU.value = rayStride;
        phaseU.value = rayStride > 1 ? frameStampU.value % rayStride : 0;
        system.width = nextWidth;
        system.height = nextHeight;
        system.pixelCount = nextPixelCount;
        publishTransport();
        return system;
      }
      // EVERY create arg forwards. The first version passed only the six it
      // could see, so `lighting`/`surfaces`/`sceneMotion`/`trackMotion`
      // defaulted to null and the FIRST viewport resize silently rebuilt the
      // deposit without hit shading (radiance degraded to sky-only, and the
      // reshaped kernel was a fresh compile on top). Found 2026-08-12 while
      // tracing the dynamic-resolution rebuild churn.
      const next = createSrcProbeSystem({
        gbuffer, width: nextWidth, height: nextHeight, props, volume, sky,
        // §16 S1 + §12.90: two more args the warning above exists for — the
        // directional sky bundle and the census's spacing override both
        // silently reverted on the first viewport resize before this line.
        skyEnv,
        spacing0: spacing0Override,
        lighting, surfaces, sceneMotion, trackMotion,
        pools: nextPools ?? pools,
        // §11.4 A2 — the device limit is a construction arg like the rest;
        // dropping it here would rebuild every grown pool under the portable
        // ceiling and throw at the first grow past it.
        deviceLimit,
        // ⭐ §11.4 (2026-09-03): THE BVH TRANSPORT WAS NOT FORWARDED. The §10
        // field-less build hands the trace in through `bvhTrace`, and this
        // re-create silently dropped it — so every pool-grow rebuild on a
        // field-less scene rebuilt the deposit over `volume.occupancyField`
        // (null there) and the kernel died at build with `trace is not a
        // function`. It hid because the persisted pools skipped the grow on
        // every scene that had ever grown; the Level walk (`probe:gi-walk`)
        // caught it the first time the ladder fired on a fresh harness.
        bvhTrace,
      });
      // Carry the debug view's on/off state across the rebuild. Losing it means
      // a viewport resize silently turns the gizmos off mid-inspection, which
      // reads as "the probes vanished when I dragged the panel".
      next.gizmos.setVisible(gizmos.group.visible);
      if (deferDispose) return next;
      const parent = gizmos.group.parent;
      system.dispose();
      parent?.add(next.gizmos.group);
      return next;
    },
    /** §11.8: the commit half of a deferred `setSize` — reparent the gizmos and dispose this system. */
    retireFor(next) {
      const parent = gizmos.group.parent;
      system.dispose();
      parent?.add(next.gizmos.group);
    },

    dispose() {
      gizmos.dispose();
      seed?.dispose();
      secondary?.dispose();
      secondaryReceivers?.dispose();
      glossy?.dispose();
      gather?.dispose();
      hashBlockFrame?.dispose();
      tiles?.dispose();
      tilesCoarse?.dispose();
      merge?.dispose();
      binStore?.dispose();
      rayStore.dispose();
      frame.dispose();
      store.dispose();
    },
  };
  return system;
}

/** One boot line describing what was allocated. */
export function describeSrcProbeSystem(system) {
  const c = system.store.cascades
    .map((x) => `c${x.cascade} ${x.probeCapacity}/${x.hashCapacity}`)
    .join(" ");
  // S1: WHICH KEYING AND WHETHER RETENTION BUILT. Both are build-time globals,
  // and a boot line that does not name them leaves the world-key arm looking
  // exactly like the shipped one — the §12.30 failure this file keeps re-finding
  // in a new costume. `retain` is the BUILT bundle, not the flag that asked for
  // it, so a build where the two disagree says so.
  const retainNote = system.frame?.retain
    ? `, retention (hold >${system.frame.retain.maxAge}f, yields at ${Math.round(system.frame.retain.highWater * 100)}% capacity)`
    : ", retention OFF";
  const keying = worldKeysEnabled()
    ? `WORLD-ABSOLUTE keys (no re-anchor)${retainNote}`
    : `anchor-relative keys (re-anchors on drift, kill-on-jump)${retainNote}`;
  const bytes = system.store.bytes + system.rayStore.bytes + (system.binStore?.bytes ?? 0);
  // `passes/groups` is not decoration: `profile.giPasses` attributes the chain
  // by walking `passGroups`, and when that came back absent there was no way to
  // tell a system that never published it from an editor running a stale
  // module. The boot line now carries both counts, so the answer is in the log
  // that is already being read rather than in another instrumented run.
  const groups = Array.isArray(system.passGroups) ? system.passGroups.length : "ABSENT";
  return `[gi] src probes: ${system.pixelCount} gbuffer pixels, ${system.passes.length} passes / ` +
    `${groups} groups, s0=${system.spacing0}, ${keying}, ` +
    `${c}, ${system.raysPerPixel} rays/px, ` +
    // ⚠ SAY THE RAY COUNT, NOT JUST THE RATE. "2 rays/px" read as a small
    // number for a whole phase while it meant 3,146,400 rays a frame and 94% of
    // the GI cost; the rate is only a cost once multiplied by a resolution the
    // reader has to find elsewhere in the same line. Both now, plus the stride
    // that separates them, so a ceiling that is or is not biting is visible.
    (system.rayStride > 1
      ? `${system.tracedRays} rays/frame (ceiling ${system.rayCeiling}, stride ${system.rayStride} of ${system.naturalRays}), `
      : `${system.tracedRays} rays/frame (under the ${system.rayCeiling} ceiling), `) +
    // The cap makes `rays/frame` above an UPPER BOUND — the fired total is
    // per-probe-capped on the GPU (`readStats().totalRays` has it). Printed
    // with the bound so nobody divides a deposit time by the wrong count,
    // which is the exact instrument mistake the traced/natural split fixed.
    (system.probeRayCap && system.probeRayCap < PROBE_RAY_CAP_OFF
      ? `probe cap ${system.probeRayCap} (rays/frame is a bound; readStats has the fired total), `
      : "") +
    `${(bytes / 1048576).toFixed(2)}MB` +
    // The BLOCK counts are named, not the probe capacities, because they are
    // what the memory is a function of since the claim landed — and because a
    // pool short for the scene shows up as `NOBLOCK` in the frame line, which
    // only makes sense next to the capacity it fell short of.
    // "SRC is populating but tracing nothing" and "SRC is depositing" are two
    // builds with identical probe telemetry, so the log says which one this is.
    (system.binStore
      ? `, ${(system.binStore.binTotal / 1e6).toFixed(2)}M bins in ` +
        `${system.store.cascades.map((x) => x.blockCapacity).join("/")} blocks ` +
        // §11.4 A2: the ceiling this device allows, so a starved scene and a
        // capped scene read differently in the log that is already being read.
        `(device ceiling ${(system.poolCeilings?.().binBudget / 1e6).toFixed(1)}M bins at ` +
        `${(system.deviceLimit / 1048576).toFixed(0)}MB per binding), ` +
        // "depositing" and "depositing + merging" are two builds with identical
        // probe telemetry and a range difference of four cascades, so the boot
        // line names which one this is.
        (system.merge ? "depositing + merging" : "depositing") +
        // ── WHETHER HIT SHADING IS ON, SAID OUT LOUD ────────────────────────
        //
        // Added after an eye check could not tell. `shadeHit` needs THREE things
        // to line up — the flag, the lighting bundle and the surface attribution
        // — and any one of them missing leaves a system that populates, deposits
        // and merges exactly as before while shading black. That is
        // indistinguishable from "Phase 5 is not written yet" in every log line
        // this module prints, so the log now names it.
        (system.shading
          ? `, SHADING (${system.shading.lights} lights, ${system.shading.emitters} emitters` +
            `${system.shading.attributed ? ", static surfaces attributed" : ""}` +
            // WHICH KERNEL SHADES. `__giSrcSplitShade = false` rebuilds the
            // pre-§12.53 one-kernel deposit, and a boot line that did not say
            // so would leave a 179 kB kernel looking like an 88 kB one.
            `${system.shading.split ? ", shaded in [J]" : ", SHADED INLINE IN [E] (pre-split hatch)"}` +
            `${system.shading.secondary ? ", MULTIBOUNCE via the tile atlas" : ", single bounce"})`
          : ", NO hit shading (radiance is sky-only)") +
        (system.tiles
          ? `, ${system.tiles.layout.width}x${system.tiles.layout.height} tile atlas ` +
            `(${system.tiles.blocks} x ${system.tiles.tileSize}²)`
          : "")
      : ", no volume — no deposit");
}

/** The per-frame telemetry line (plan §8: permanent, MCP-readable). */
export function formatSrcProbeFrame(stats) {
  const r = stats.rays;
  return `[gi] src probes — ${formatSrcProbeStats(stats.cascades)}` +
    (stats.reanchors > 1 ? `  reanchors ${stats.reanchors}` : "") +
    `  |  budget ${stats.totalRays} rays` +
    (r?.dispatched
      // `traced` vs `budget`: these must be EQUAL, and printing both rather than
      // one is what makes a divergence visible at a glance. They come from
      // opposite ends — the budget from Alg. 3's global cursor, the traced count
      // from an atomic in the deposit kernel itself.
      ? ` traced ${r.rays} hit ${(r.hitRate * 100).toFixed(1)}% ` +
        `t̄ ${r.meanT.toFixed(2)}m max ${r.maxT.toFixed(2)}m` +
        `  |  ${r.deposits} deposits (${r.perRay.toFixed(2)}/ray)` +
        // Clamps are the open `Lmax` decision's evidence (§12.13.4). Printed
        // always, including at zero — "the clamp never fired" is the finding.
        (r.clamped ? `  CLAMPED ${r.clamped}` : "") +
        // Deposits the block pool refused. The probe-side twin (`NOBLOCK n/cap`
        // in the cascade line) says how many probes; this says what it cost.
        (r.noBlock ? `  DROPPED ${r.noBlock}` : "") +
        // ── WHY THE FRAME IS THE BRIGHTNESS IT IS ─────────────────────────
        //
        // `maxL` is the most diagnostic number this module has and it was
        // computed and never printed: the brightest radiance any hit produced,
        // as a fraction of `Lmax`. **Zero means no hit shaded to anything**,
        // which separates "the transport is broken" from "the lighting is" in
        // one glance — and on screen those two are the same black frame.
        //
        // Printed at zero on purpose, with the shade tallies beside it, so a
        // black frame names its own cause: `NO HIT SHADING` = the shader was
        // never built; `UNATTRIBUTED` high = the palette is not answering;
        // shadow rays ≈ shaded with `maxL 0` = every hit is occluded from every
        // light.
        (r.shaded
          ? `  |  shaded ${r.shaded}` +
            (r.unattributedRate > 0.001 ? ` (${(r.unattributedRate * 100).toFixed(1)}% UNATTRIBUTED)` : "") +
            `, ${r.shadowRays} shadow rays, maxL ${r.maxRadianceFraction.toFixed(4)}` +
            (r.maxRadianceFraction === 0 ? " ← NO HIT PRODUCED ANY RADIANCE" : "") +
            (r.emissiveHits ? `, ${r.emissiveHits} emissive` : "") +
            (r.emitZeroed ? `, ${r.emitZeroed} R5-ZEROED` : "") +
            (r.albedoClamped ? `, ${r.albedoClamped} albedo-clamped` : "") +
            (r.importanceFloored ? `, ${r.importanceFloored} IMPORTANCE-FLOORED` : "")
          : "  |  NO HIT SHADING")
      : "") +
    // [J]'s own line. `bounce 0/N` with the boot line claiming MULTIBOUNCE is
    // the reading that separates "the second bounce is dim here" from "the
    // pass did not dispatch", which are the same picture.
    // The seed's instrument: `probes` says newborns are inheriting a prior at
    // all, `cold` says how many the ladder could not reach (the deferred
    // spatial-neighbour fallback's demand signal).
    (stats.seed?.dispatched && stats.seed.probes ? `  |  ${formatSrcSeed(stats.seed)}` : "") +
    (stats.secondary?.dispatched ? `  |  ${formatSrcSecondary(stats.secondary)}` : "") +
    // The merge's range instrument. `to sky` is the fraction of merged bins
    // whose parent chain reached the top — i.e. how much of the frame is
    // getting the full-reach answer rather than a partial one.
    (stats.merge?.dispatched ? `  |  ${formatSrcMerge(stats.merge)}` : "") +
    (stats.tiles?.dispatched
      ? `  |  ${formatSrcTiles(stats.tiles, stats.cascades[0]?.live ?? 0)}`
      : "") +
    // [I]'s instrument. `corners` is the one that says whether the picture is
    // INTERPOLATED: at 1 per pixel this is the old one-probe-per-pixel gather
    // wearing a new name, and the blocks are still there.
    (stats.gather?.dispatched ? `  |  ${formatSrcGather(stats.gather)}` : "");
}
