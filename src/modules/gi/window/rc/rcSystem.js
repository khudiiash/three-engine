// §19 STAGE 5.1 — RADIANCE CASCADES ON THE WINDOW: THE PORT
//
// ⭐⭐⭐ THE ONE-SENTENCE VERSION: this file is `srcSystem.js` with the scene
// -sized transport cut out and GI2's window put in its place. Nothing about the
// cascades is re-derived — the probes, the LOD ladder, Algorithm 3's ray
// budget, the equal-area bins and the deposit are the SHIPPED SRC modules,
// imported and called. Two closures change hands and that is the whole port:
//
//     trace(P, ω, reach, n)  →  `traceWindow` — the two-level bit-DDA over the
//                               toroidal window, with §AG's coverage
//                               throughput T. The old `occupancyField` /
//                               `rayHit/` BVH8 never return.
//     shadeHit(r, ω, n)      →  GI2's hit radiance — the voxel's dominant face,
//                               the radiance cache's running value, a fresh
//                               face shaded on the spot. (5.3 replaces this
//                               with palette albedo × (direct + E_probes)/π.)
//
// ══ WHY A PORT AND NOT THE REWRITE THIS STAGE STARTED AS ═════════════════════
//
// The user, 08-28: "before this rebuild we had quite good looking GI and
// reflections — maybe we could reuse something". He is right, and the audit
// agrees: the SRC path IS the paper (β = 4, γ = 4, W0 = 4 branching ×4 per
// cascade, r0/s0 = 1.6, LOD overlap 0.9, the eight-corner cone merge, Alg. 3's
// R2 ray store), gated by a CPU mirror in `srcRef.js`. It died on SCALE — 491
// MB of occupancy bits over Bistro's AABB, a 155 s pipeline-compile wave, 6 fps
// — and on nothing else. GI2 solved exactly that: a fixed 64³×5 window, a
// bit-DDA that costs the same in any scene, a bounded soup, a bounded cache.
//
// ══ WHAT IS DIFFERENT FROM `srcSystem`, AND IT IS THREE THINGS ══════════════
//
//   1. THE POOLS ARE BOUNDED BY TIER, not by `expectedC0Probes(pixelCount)`.
//      That growth term is the scale trap in one line: a 4 K viewport asked for
//      131 072 c0 slots to hold 1 788 live probes, and every per-probe pass
//      swept the whole allocation every frame. `rcConfig.RC_TIERS` is the
//      envelope now, and the LOD ladder (Chebyshev distance, already in
//      `srcProbes`) is what makes a bounded pool cover an unbounded scene.
//   2. THE RAY CEILING IS THE TIER's, spent through `srcRays`' own stride/phase
//      mechanism — a smaller dispatch, never a skipped one.
//   3. NO SECONDARY, NO ATTRIBUTION SPLIT, NO SURPRISE. 5.1 is probes, rays and
//      the interval deposit; the merge is 5.2 and the second bounce is 5.3, and
//      each of those is a `null` here rather than a stub.
//
// ⚠ THE SHIPPED PATH IS UNTOUCHED. Nothing in this file is constructed unless
// `RC5_PATH` is on; `gi2System` builds it beside the world probes and both
// light independently.
import * as THREE from "three/webgpu";
import { If, bitAnd, ivec2, shiftRight, step, texture, uint, uniform, vec3 } from "three/tsl";
import {
  DEPOSIT_SCALE, createSrcBinStore, createSrcDepositFrame, createSrcShadeCounters,
} from "../../srcDeposit.js";
import { createSrcProbeFrame, createSrcProbeStore } from "../../srcProbes.js";
import { createSrcRayFrame, createSrcRayStore } from "../../srcRays.js";
import { R2_ALPHA1_FX, R2_ALPHA2_FX } from "../../srcMath.js";
import { normalOfFace } from "../radianceCache.js";
import { createSrcSecondaryFrame, formatSrcSecondary } from "../../srcSecondary.js";
import { createRcMerge } from "./rcMerge.js";
import { createRcDirectAt, createRcHitShading } from "./rcHit.js";
import {
  CASCADE_COUNT, MAX_LODS, TEMPORAL_ALPHA, W0, rcHitCapacity, rcHitPathEnabled, rcIntervalCensus,
  rcTierSpec,
} from "./rcConfig.js";

/**
 * @param {object} opts
 * @param {object} opts.win       from `createGiWindow`
 * @param {object} opts.trace     from `createWindowTrace` — CALLED, never rebuilt
 * @param {object} opts.cache     from `createRadianceCache`
 * @param {{position: THREE.Texture, normal: THREE.Texture}} opts.gbuffer
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {string} [opts.tier]
 * @param {object} opts.kit  the gather's published closures — `u` (its uniform
 *   bag), `dominantFace`, `faceSamplePoint`, `shadeHit`. ⚠ PASSED, NOT REBUILT:
 *   `shadeHit` alone inlines a sun ray, four sky rays and every emitter slot's
 *   NEE — ~25 kB of WGSL and, measured at Stage 3.5, 2.5 s of pipeline compile
 *   when it was duplicated.
 */
export function createRcCascades({
  win, trace, cache, gbuffer, width, height, tier = win.tier, kit,
  // §19 5.3 — GISystem's emitter SLOT uniforms, the same four `shadeTerms`
  // does NEE against at a hit. Absent, the seated-emitter term is not built.
  emitters = null,
  // §19 STAGE 5.2 — `gather.textures.irradianceHalf`, the texture
  // `resolveUpsample` reads. Absent (5.1's own harness page, `scripts/gi2-rc.
  // html`), the merge/bake/resolve trio is not built at all and this object is
  // exactly what 5.1 shipped — the population, the rays and the deposit.
  irradianceHalf = null,
}) {
  const spec = rcTierSpec(tier);
  const { u, dominantFace, faceSamplePoint, shadeHit } = kit;
  const { traceWindow } = trace;
  const spacing0 = Number(globalThis.__gi2RcSpacing0) || spec.spacing0;
  const maxLods = Math.max(1, Math.min(MAX_LODS, spec.lods));
  const pixelCount = Math.max(1, width * height);

  // ── the pools, bounded by the tier and by nothing else ───────────────────
  const store = createSrcProbeStore({
    c0Probes: spec.c0Probes,
    cascadeCount: CASCADE_COUNT,
    w0: W0,
    binBudget: spec.binBudget,
  });

  // ── uniforms ──────────────────────────────────────────────────────────────
  const cameraU = uniform(new THREE.Vector3());
  const anchorU = uniform(new THREE.Vector3());
  const widthU = uniform(width, "uint");
  const frameStampU = uniform(1, "uint");
  const jitterXU = uniform(0, "uint");
  const jitterYU = uniform(0, "uint");
  const strideU = uniform(1, "uint");
  const phaseU = uniform(0, "uint");
  const lmaxU = uniform(spec.lmax);
  /**
   * ⭐⭐⭐ §19 STAGE 5.3c — THE CADENCE, AS ONE INTEGER PER FRAME.
   *
   * The plan's schedule row is "c0 every frame, c1 every 2, c2 every 4, c3
   * every 8". On the SPLIT cascades a ray is not owned by a cascade — it is
   * traced once to the full reach and deposits into every cascade up to the one
   * that owns its hit distance — so the schedule is not a set of dispatches, it
   * is the HIGHEST CASCADE this frame may write. `srcDeposit`'s `cascadeDue`
   * spends it three ways at once (reach, scatter gate, decay freeze); its
   * docstring carries the argument.
   *
   * DETERMINISTIC BY FRAME INDEX and by nothing else: `due(f)` is the largest
   * `c` with `f mod 2^c == 0`, so the pattern is 3,0,1,0,2,0,1,0 and repeats —
   * no counter, no state, nothing to get out of step after a resize or a pause.
   *
   * `__gi2RcCadence = 0` traces every cascade every frame (5.1-5.3b's arm, and
   * the one every chain-ms figure before this was taken on).
   */
  const cadenceOn = (globalThis.__gi2RcCadence ?? 1) !== 0;
  const cascadeDueU = uniform(CASCADE_COUNT - 1, "int");
  /** The largest `c` with `f mod 2^c == 0`, capped at the top cascade. */
  const cascadeDueAt = (f) => {
    let c = 0;
    while (c < CASCADE_COUNT - 1 && (f % (1 << (c + 1))) === 0) c++;
    return c;
  };
  /**
   * The temporal blend. `keep = 1 − α` multiplies every accumulator before this
   * frame's rays land on it — `srcConfig.TEMPORAL_ALPHA` (0.1), the value the
   * old path shipped and the user liked the look of.
   *
   * ⚠ AND IT IS THE ONE THING IN THIS STAGE THE NO-NOISE RULE HAS TO BE
   * MEASURED AGAINST, not argued about. R2 + jitter is a STOCHASTIC direction
   * set; at rest it converges, and whether the residual reads as shimmer is a
   * number (`probe:gi2-rc`'s at-rest Δ), not a taste. `__gi2RcJitter = 0`
   * freezes the sequence, which makes a parked camera byte-identical by
   * construction and is the fallback arm if the measurement says so.
   */
  const keepU = uniform(1 - TEMPORAL_ALPHA);
  const influxLiftU = uniform(1);
  /**
   * ⭐⭐ §19 STAGE 5.3b — THE SECONDARY CACHE'S BUDGET, AS ONE POWER-OF-TWO.
   *
   * A hit face re-gathers the merged field on the frame whose stamp matches its
   * own low address bits, so the cost is `1/period` of the hits and the set that
   * refreshes rotates over the whole cache deterministically. A face that has
   * NEVER been gathered ignores the budget entirely — "no data" must not read as
   * "no light" for a whole period — so the budget only ever rate-limits the
   * REFRESH, never the first value, and convergence is unaffected at the front.
   *
   * `1` is "every hit face, every frame" and is the arm to compare against.
   */
  const ercPeriod = (() => {
    const raw = Number(globalThis.__gi2RcErcPeriod);
    const p = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
    return 1 << Math.max(0, Math.min(10, Math.round(Math.log2(p))));
  })();
  const ercMaskU = uniform(ercPeriod - 1, "uint");
  /**
   * The blend a refresh applies. SHIPPED AT 1, and that is a correctness
   * property rather than a taste: at α = 1 every ray that reaches a face writes
   * the same number, so the word does not depend on how many rays arrived or in
   * which order (§T). Anything below 1 buys temporal smoothing the cascade bins
   * already provide through `TEMPORAL_ALPHA` and pays for it in both latency and
   * order-dependence.
   */
  const ercAlpha = (() => {
    const raw = Number(globalThis.__gi2RcErcAlpha);
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1;
  })();

  // ── the gbuffer, read exactly as `srcSystem` reads it ─────────────────────
  const positionNode = texture(gbuffer.position);
  const normalNode = texture(gbuffer.normal);
  const texelOf = (i) => ivec2(i.mod(widthU).toInt(), i.div(widthU).toInt());
  /**
   * ⚠ BOTH CHANNELS, AND THE FACE-FORWARD FLIP. `position.w > 0.5` alone
   * admitted 46 % of the smoke scene's pixels — void pixels whose position is
   * the origin and whose normal is ZERO — each of which inserted a probe at the
   * world origin and fired a hemisphere around `normalize(0)`. And the flip
   * toward the camera lives HERE, at the engine boundary, because it is a
   * gbuffer fact: a double-sided wall seen from inside a room has its normal
   * pointing out, and a hemisphere around it samples the outside of the room.
   */
  const readPixel = (i) => {
    const t = texelOf(i);
    const g0 = positionNode.load(t).toVar();
    const nrm = normalNode.load(t).xyz.toVar();
    const facing = step(0, nrm.dot(vec3(cameraU).sub(g0.xyz))).mul(2).sub(1).toVar();
    return {
      position: g0.xyz,
      valid: g0.w.greaterThan(0.5).and(nrm.dot(nrm).greaterThan(0.25)),
      normal: nrm.mul(facing),
    };
  };
  const readNormal = (i) => readPixel(i).normal;

  // ══ THE TWO CLOSURES THAT ARE THE WHOLE PORT ═══════════════════════════════
  //
  // `srcDeposit` calls `trace(P, ω, reach, n)` and reads `.hit` and `.t`; the
  // raw vec4 rides along for the shade, which needs the packed (level, voxel,
  // face) the DDA found.
  //
  // ⭐⭐ AND THE ORIGIN NORMAL IS THE FIFTH ARGUMENT, WHICH IS THE WHOLE ANCHOR
  // STORY. `srcDeposit` fires from the RAW gbuffer point (`gatherNormalBias`
  // ships at 0 and belongs to the gather, not to this ray), and conservative
  // voxelization means that point's own voxel is OCCUPIED — measured, 15.1 % of
  // a sealed room's pixels. Handing `traceWindow` the normal spends its
  // half-cell bias and its origin escape on exactly that: the ray leaves the
  // surface it is standing on instead of being born inside it, which is the
  // paper's Fig 7 recess bias and Stage 5.1's anchor census.
  const rcTrace = (P, dir, reach, n = null, nrm = null) => {
    const w = nrm ? traceWindow(P, dir, reach, nrm) : traceWindow(P, dir, reach);
    return { hit: w.hit, t: w.t, raw: w.raw, throughput: w.throughput };
  };

  /**
   * What a ray brings back — `gatherProbes.hitRadiance`'s body, reached through
   * the gather's own closures so the two paths' fields are comparable texel for
   * texel: the voxel's DOMINANT face (not the ray's entry face), the cache's
   * running value, and a fresh face shaded on the spot because there is nothing
   * else to return.
   *
   * ⚠ NO TRACKED RE-SHADE. The world path owns the cache's refresh cadence
   * (`u.shadeProb` / `u.shadeStrideU`); a second source firing it would double
   * every boot's shading work for a value only the cache reads. A FRESH face is
   * still shaded here — it has no other answer — and that shade is accumulated,
   * so both paths converge to one cache.
   *
   * ⭐ AND THE HIT IS WEIGHTED BY WHAT SURVIVED THE THIN VOXELS (§AG). `T` is a
   * product of per-class constants over the voxels the ray actually met, so it
   * is deterministic and it is exactly 1 in every scene with no cables,
   * railings or foliage in it — this multiply is a provable no-op there.
   */
  // ⚠ ASSIGNED BELOW, WHERE THE BIN STORE EXISTS. `rcShade` is a closure the
  // deposit calls while IT is being constructed, which is after the bins — so
  // the late binding is the construction order, not laziness.
  let shadeCounters = null;
  /**
   * §19 5.3c — `shadeHit` no longer adds `palEm` under the projected-area arm
   * (`gatherProbes`' `RC5_EMIT_PROJ`), because the emission a ray carries away
   * depends on the ray. The split arm puts it in the record; the INLINE arm has
   * no record, so it adds it here — same closure, same face, same direction.
   */
  const rayEmission = typeof kit.hitEmissionRay === "function" ? kit.hitEmissionRay : null;
  const rcShade = (r, dir) => {
    const raw = r.raw;
    const rad = vec3(0).toVar();
    const zi = raw.z.toUint().toVar();
    If(raw.x.greaterThan(0.5), () => {
      const entryF = bitAnd(zi, uint(7)).toFloat().toVar();
      const levelF = bitAnd(shiftRight(zi, uint(3)), uint(7)).toFloat().toVar();
      const voxF = shiftRight(zi, uint(6)).toFloat().toVar();
      const faceF = dominantFace(levelF, voxF, entryF, dir.negate()).toVar();
      const hn = normalOfFace(faceF).toVar();
      const hp = faceSamplePoint(levelF, voxF, hn).toVar();
      const c = cache.cacheRead(levelF, voxF, faceF).toVar();
      // The deposit's `shaded` tally is `srcShade`'s counter, and this path is
      // not `srcShade` — without this line every receipt reads "NO HIT SHADING"
      // on a frame whose shader is running, which is the blind-instrument
      // failure the counter's own docstring warns about.
      shadeCounters?.shaded(1);
      rad.assign(c.xyz);
      If(c.w.lessThan(0.5), () => {
        const s = shadeHit(hp, hn, levelF, voxF, uint(1)).toVar();
        // `.toVar()` is load-bearing — a call for side effect alone is DCE'd.
        cache.cacheAccum(levelF, voxF, faceF, s, u.nCapU, u.cacheSmoothU).toVar();
        rad.assign(s);
      });
      if (rayEmission) rad.addAssign(rayEmission(levelF, voxF, faceF, dir));
    }).Else(() => {
      rad.assign(u.skyColor);
    });
    return rad.mul(r.throughput);
  };

  // ── the frames, in the order `srcSystem` builds them ─────────────────────
  const frame = createSrcProbeFrame(store, {
    spacing0,
    camera: vec3(cameraU),
    anchor: vec3(anchorU),
    pixelCount,
    maxLods,
    readPixel,
    frameStamp: frameStampU,
  });

  const rayStore = createSrcRayStore(store, { pixelCount });
  // The dispatch size is baked (three bakes `.compute(n)`), so it comes from the
  // TIER's ceiling and is resolution-INDEPENDENT: a viewport resize is a
  // uniform write to `stride`/`phase`, never a rebuild.
  const threads = Math.max(1, Math.min(pixelCount, spec.rays));
  const rayFrame = createSrcRayFrame(store, rayStore, {
    pixelProbe: frame.pixelProbe,
    raysPerPixel: 1,
    stride: strideU,
    phase: phaseU,
    threads,
  });

  // ⭐⭐ §19 STAGE 5.3 — THE HIT LIST IS ALLOCATED WHENEVER [J] CAN BE BUILT.
  // 5.1/5.2's own harness page (`scripts/gi2-rc.html`) hands in no destination
  // texture, so it gets no merge, no tiles and therefore no field to gather at
  // a hit — that build keeps the INLINE arm and its tail is not allocated, so
  // every 5.1 byte figure stays comparable.
  const hitCapacity = (irradianceHalf && rcHitPathEnabled()) ? rcHitCapacity(spec, threads) : 0;
  const bins = createSrcBinStore(store, { w0: W0, secondaryCapacity: hitCapacity });
  shadeCounters = createSrcShadeCounters(bins);

  /**
   * §19 5.3's two closures — see `rcHit.js`. Built only on the split arm: with
   * `attribute` the deposit does NOT bind the radiance cache at all, which is
   * the eighth binding `gatherAt` needs and the reason the split exists.
   */
  const hitShading = hitCapacity > 0
    ? createRcHitShading({
      cache,
      kit,
      counters: shadeCounters,
      // ⭐⭐⭐ §19 STAGE 5.3b — THE MERGED FIELD, REACHED THROUGH A THUNK.
      //
      // `resolve` is constructed BELOW (it needs the bins this line's deposit is
      // about to fill), and [J]'s kernel body is not walked until `hit` is built
      // AFTER it — so the indirection is a build-order fact, not an abstraction.
      // The alternative was two `createRcHitShading` calls, which is two places
      // for the shade point and the face normal to drift apart.
      gatherAt: (P, n) => resolve.gather.gatherAt(P, n),
      ercAlpha,
      ercPhase: frameStampU,
      // ⚠ PASSED EVEN AT PERIOD 1, where the mask is 0 and `addr & 0 == stamp & 0`
      // is the constant TRUE — i.e. "every hit face, every frame", which is the
      // no-budget arm this has to be A/B'd against. Omitting the node there
      // would silently mean the opposite (refresh only on the first ever hit).
      ercPeriodMask: ercMaskU,
      // §19 5.3b — nine `atomicStore`s per hit dropped from the deposit; [J]
      // recovers P/N from the address and never wanted `Le`. See `rcHit`.
      compact: true,
    })
    : null;

  const deposit = createSrcDepositFrame(store, bins, {
    pixelProbe: frame.pixelProbe,
    pixelRayBase: rayStore.pixelRayBase,
    rayWork: rayStore.rayWork,
    pixelCount,
    pixelCountNode: rayStore.pixelCountU,
    raysPerPixel: 1,
    stride: strideU,
    phase: phaseU,
    threads,
    lmax: lmaxU,
    // ⭐⭐⭐ §19 STAGE 5.3 — WHICH KERNEL SHADES, AND IT IS EXACTLY ONE OF THEM.
    //
    // Split arm: this kernel TRACES, ATTRIBUTES and APPENDS; `rcHit`'s [J]
    // below shades the record and deposits the radiance. The deposit sheds the
    // radiance cache binding (7 of 8) and stops paying `shadeHit` for the ~76 %
    // of rays that miss. Inline arm (no destination texture): 5.1's form,
    // unchanged, because there is no merged field to read at a hit.
    //
    // ⚠ `srcDeposit` REFUSES BOTH — supplying `shadeHit` and `attribute`
    // together would shade every hit twice and deposit it twice, with no tally
    // that says so.
    attribute: hitShading ? hitShading.attribute : null,
    secondary: hitCapacity > 0
      ? { base: bins.hitListBase, capacity: hitCapacity }
      : null,
    // §19 5.3b/5.3c — P and N are functions of the address word the record
    // already carries, so the append stops writing them; `Le` comes BACK under
    // the projected-area arm because it is a function of the RAY. One source of
    // truth (`rcHit`'s `hitFields`), read by the writer here and by [J] below.
    hitFields: hitShading ? hitShading.hitFields : null,
    surprise: null,
    trace: rcTrace,
    shadeHit: hitShading ? null : ((r, dir) => rcShade(r, dir)),
    readPixel,
    readNormal,
    camera: vec3(cameraU),
    spacing0,
    jitterX: jitterXU,
    jitterY: jitterYU,
    keep: keepU,
    frameStamp: frameStampU,
    influxLift: influxLiftU,
    maxLods,
    // §19 5.3c — the schedule. `null` on the off arm builds the pre-5.3c WGSL.
    cascadeDue: cadenceOn ? cascadeDueU : null,
  });

  // ══ §19 STAGE 5.2 — [G] THE MERGE, [H] THE TILES, [I] THE PIXEL ═══════════
  //
  // Three shipped modules and one kernel — see `rcMerge.js`. Built only when a
  // destination texture was handed in, so 5.1's own gate page keeps a build
  // with no merge in it and every 5.1 number stays comparable.
  const resolve = irradianceHalf
    ? createRcMerge({
      store,
      bins,
      spacing0,
      // ⭐ THE SAME `anchorU` THE POPULATION USED, not a second one. Probe keys
      // are anchor-relative; a merge or a gather that places the lattice from a
      // different anchor reads plausible light from the wrong probes, and no
      // energy check in this repository can see that.
      anchor: vec3(anchorU),
      camera: vec3(cameraU),
      // The gather's OWN sky uniform — the same node `rcShade` returns on a
      // miss, so the two ends of the transport cannot disagree about what an
      // escaping ray found. It enters the field ONCE: a miss lands past every
      // cascade (`own = N` in `srcDeposit`), which deposits `(0, T = 1)` and no
      // radiance, so the top cascade's composite below is the only sky term.
      sky: u.skyColor,
      frameStamp: frameStampU,
      gbuffer,
      irradianceHalf,
      width,
      height,
      maxLods,
      directAt: createRcDirectAt({ trace, voxel0: win.voxel0, emitters }),
    })
    : null;

  // ══ §19 STAGE 5.3 — [J], THE HIT RADIANCE ═════════════════════════════════
  //
  // `srcSecondary.js` verbatim — the shipped [J], which has read this exact hit
  // list and deposited into these exact bins since §12.53. Two closures change
  // hands and that is the whole of 5.3's transport work:
  //
  //   shade(P, n, ρ, Le, T, addr) → the DIRECT-ONLY face cache (`rcHit.js`)
  //   gatherAt(P, n)              → the merged cascade field, unchanged
  //
  // ⭐⭐⭐ §19 STAGE 5.3b — `bounce: "cached"`, NOT `true`. 5.3 asked this pass
  // to build its own `srcScreenGather` and fire it once per RECORD; the shade
  // closure now owns that term and pays it once per FACE, out of the cache's
  // secondary region (`rcHit.shade`). Same integral, same anchor, same eight
  // corners — the only thing that changed is how many times a frame evaluates
  // it, which on the 5.1 gate at ultra was 3.03 ms of a 9.58 ms chain.
  //
  // ⚠ BETWEEN THE SCATTER AND THE RESOLVE, NECESSARILY. The list does not exist
  // until the scatter writes it, and [F] turns the accumulators into the
  // payload — a deposit landing after it is not merely a frame late, it is
  // ADDRESSED WRONG, because [C] re-claims blocks every frame and an entry's
  // `SEC_SLOT` is only meaningful inside the frame that produced it.
  const hit = (hitShading && resolve)
    ? createSrcSecondaryFrame(store, bins, {
      shade: hitShading.shade,
      bounce: "cached",
      hitFields: hitShading.hitFields,
      spacing0,
      // The SAME camera and anchor the population, the merge and the pixel
      // gather use. A gather placed from a second anchor reads plausible light
      // from the wrong probes and no energy check in this repository sees it.
      camera: vec3(cameraU),
      anchor: vec3(anchorU),
      lmax: lmaxU,
      maxLods,
      w0: W0,
      surprise: null,
      capacity: hitCapacity,
    })
    : null;

  // ── the per-frame drivers ────────────────────────────────────────────────
  /**
   * ⭐⭐ §19 5.2 — THE DEFAULT IS THE DETERMINISTIC ARM NOW, AND IT IS A
   * MEASUREMENT, NOT A PREFERENCE.
   *
   * 5.1 shipped R2 jitter on and owed the at-rest Δ. Taken (the user's
   * `Cornel.scene`, `probe:gi2-cornell`, camera parked, 180 gather frames apart
   * after a 20 s settle):
   *
   *     jitter on (R2)   |ΔE|/E  p50 0.60 %   p90 2.20 %   max 26.8 %
   *     jitter FROZEN    |ΔE|/E  p50 0.36 %   p90 1.29 %   max 10.2 %
   *
   * and the picture is the same one either way (median |log ratio| 0.472 vs
   * 0.478, per-surface blotch σ within a point of each other, black census 0 on
   * both). So the jitter buys nothing the gate can see and costs a factor of
   * ~2 in residual shimmer, which is the one thing the no-noise rule spends its
   * budget on: complete fixed direction sets per probe every frame, never a
   * stochastic sequence averaged over time.
   *
   * ⚠ THE REMAINING 1.29 % IS NOT THIS DIAL. Both arms share it; it is the
   * radiance cache's own refresh cadence arriving through `shadeHit`, which 5.3
   * replaces with the direct-only face cache + E_probes. `__gi2RcJitter = 1`
   * restores the paper's R2 arm.
   */
  const jitterOn = (globalThis.__gi2RcJitter ?? 0) !== 0;
  let frameIndex = 0;
  const setCamera = (pos) => {
    const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    cameraU.value.set(p[0], p[1], p[2]);
    // ⭐ THE ANCHOR IS THE CAMERA, ROUNDED TO THE COARSEST LATTICE. Probe keys
    // are anchor-relative, so an anchor that moved every frame would rename
    // every probe every frame; snapping it to the top cascade's spacing means a
    // walk re-keys nothing until the camera crosses one coarse cell.
    const top = spacing0 * (1 << (CASCADE_COUNT - 1));
    anchorU.value.set(
      Math.floor(p[0] / top) * top, Math.floor(p[1] / top) * top, Math.floor(p[2] / top) * top,
    );
    return { anchor: [anchorU.value.x, anchorU.value.y, anchorU.value.z] };
  };
  const beginFrame = (n = null) => {
    frameIndex = n == null ? frameIndex + 1 : n;
    frameStampU.value = (frameIndex + 1) >>> 0;
    if (jitterOn) {
      jitterXU.value = (jitterXU.value + R2_ALPHA1_FX) >>> 0;
      jitterYU.value = (jitterYU.value + R2_ALPHA2_FX) >>> 0;
    }
    const stride = Math.max(1, Math.ceil(pixelCount / threads));
    strideU.value = stride;
    phaseU.value = stride > 1 ? frameStampU.value % stride : 0;
    // §19 5.3c — the cadence, from the frame index and nothing else.
    cascadeDueU.value = cadenceOn ? cascadeDueAt(frameIndex) : CASCADE_COUNT - 1;
    return frameIndex;
  };
  const setSize = (w, h) => {
    const nw = Math.max(1, Math.round(w));
    const nh = Math.max(1, Math.round(h));
    if (nw * nh > pixelCount) return false; // the pools are sized for this frame
    widthU.value = nw;
    if (rayStore.pixelCountU) rayStore.pixelCountU.value = nw * nh;
    if (resolve && !resolve.setSize(nw, nh)) return false;
    return true;
  };

  const census = rcIntervalCensus(spacing0, maxLods, CASCADE_COUNT);
  const describe = () => ({
    tier,
    spacing0,
    cascades: CASCADE_COUNT,
    w0: W0,
    maxLods,
    pixelCount,
    threads,
    rays: threads,
    depositScale: DEPOSIT_SCALE,
    alpha: TEMPORAL_ALPHA,
    jitter: jitterOn,
    pools: {
      c0Probes: spec.c0Probes, binBudget: spec.binBudget, binTotal: bins.binTotal,
      // §19 5.3 — 0 on the inline arm, which is how a receipt tells the two
      // builds apart without reading a flag.
      hitList: hitCapacity,
    },
    hitRadiance: hit ? "probes" : "cache",
    /**
     * §19 5.3c — the schedule, published so a cost reading names the frame it
     * was taken on. `reach` is what a ray of each phase actually marches, which
     * is the quantity the window DDA charges for.
     */
    cadence: cadenceOn
      ? {
        on: true,
        period: Array.from({ length: CASCADE_COUNT }, (_, c) => 1 << c),
        pattern: Array.from({ length: 8 }, (_, f) => cascadeDueAt(f)),
        due: cascadeDueU.value,
        reach: census.rows[0].bands.map((b) => +b.t1.toFixed(2)),
        // Mean marched reach over one 8-frame cycle, against the un-cadenced
        // constant — the DDA's own units.
        meanReach: +(Array.from({ length: 8 }, (_, fr) =>
          census.rows[0].bands[cascadeDueAt(fr)].t1).reduce((a, b) => a + b, 0) / 8).toFixed(2),
        fullReach: +census.rows[0].bands[CASCADE_COUNT - 1].t1.toFixed(2),
      }
      : { on: false },
    // §19 5.3b — the secondary cache's budget, published so a cost reading and
    // a convergence reading can be attributed to the same number.
    erc: hit
      ? {
        period: ercPeriod,
        alpha: ercAlpha,
        mb: +(((cache.describe?.().ercBytes ?? 0) / 1048576).toFixed(2)),
      }
      : null,
    intervals: census.rows.map((r) => ({
      lod: r.lod, reach: r.reach, gaps: r.gaps, overlaps: r.overlaps,
      bands: r.bands.map((b) => [b.t0, b.t1]),
    })),
    gaps: census.gaps,
    overlaps: census.overlaps,
    resolve: resolve
      ? { half: [resolve.halfW, resolve.halfH], tiles: resolve.tiles.layout, tileSize: resolve.tiles.tileSize }
      : null,
    bytes: {
      // Every storage attribute the three stores own, counted from the arrays
      // themselves so a layout change cannot make this number a fiction.
      probes: byteSum(store),
      bins: byteSum(bins),
      rays: byteSum(rayStore),
    },
    get totalMB() {
      return +(((byteSum(store) + byteSum(bins) + byteSum(rayStore)) / 1048576).toFixed(2));
    },
  });

  return {
    tier, spacing0, store, bins, rayStore, frame, rayFrame, deposit, census,
    uniforms: {
      rcCamera: cameraU, rcAnchor: anchorU, rcWidth: widthU, rcFrameStamp: frameStampU,
      rcJitterX: jitterXU, rcJitterY: jitterYU, rcStride: strideU, rcPhase: phaseU,
      rcLmax: lmaxU, rcKeep: keepU, rcInfluxLift: influxLiftU, rcErcMask: ercMaskU,
      rcCascadeDue: cascadeDueU,
      ...(resolve?.uniforms ?? {}),
    },
    passes: {
      populate: frame.passes,
      rays: rayFrame.passes,
      deposit: deposit.passes,
      /** §19 5.3 — [J]. `null` on the inline arm. */
      hit: hit ? [hit.pass] : [],
      merge: resolve?.merge.passes ?? [],
      tiles: resolve?.tiles.passes ?? [],
      resolve: resolve ? [resolve.resolvePass] : [],
    },
    resolve,
    /**
     * The one order that works: probes, the c0 key→block tail, Algorithm 3's
     * budget, the deposit, then 5.2's merge → bake → pixel.
     *
     * ⚠ `hashPass` SITS ABOVE THE RAYS, and that is correctness rather than
     * taste (`srcSystem`'s own note): the hash slot LAYOUT is rebuilt every
     * frame by the compaction with scheduler-dependent contention, so a key's
     * slot index does not survive the rebuild and a tail written at the END of
     * a frame is misaligned with the next frame's keys. Both of its inputs
     * (`hashSlot`, `PROBE_BLOCK`) are settled by compaction and neither changes
     * again inside the frame.
     */
    frameOrder: [
      ...frame.passes,
      ...(resolve ? [resolve.hashPass] : []),
      ...rayFrame.passes,
      // §19 5.3 — [E] decay, [E] scatter, [J], [F] resolve. `deposit.passes` is
      // that list minus [J], and slicing it by index at the call site would put
      // the frame order at the mercy of its length (`srcDeposit`'s own note is
      // why `decay`/`scatter`/`resolve` are published by name).
      ...(hit
        ? [deposit.decay, deposit.scatter, hit.pass, deposit.resolve]
        : deposit.passes),
      ...(resolve ? resolve.passes : []),
    ],
    setCamera, beginFrame, setSize, describe,
    readStats: (renderer) => deposit.readStats(renderer),
    /** §19 5.3 — [J]'s own line: entries shaded, and whether the bound held. */
    readHitStats: (renderer) => (hit ? hit.readStats(renderer) : Promise.resolve(null)),
    formatHitStats: formatSrcSecondary,
    /** 5.2's own receipt: the merge's orphan/corner census and the bake's coverage. */
    readMergeStats: (renderer) => (resolve ? resolve.readStats(renderer) : Promise.resolve(null)),
    /** Every GPU-only storage attribute, for the caller's retire queue. */
    storageAttributes: () => [
      ...attrsOf(store), ...attrsOf(bins), ...attrsOf(rayStore), ...attrsOf(frame),
      ...(resolve?.storageAttributes() ?? []),
    ],
    /**
     * ⚠ THE ARRAY IS EMPTIED BEFORE `dispose()`. Under three's WebGPU backend
     * that is what actually releases the buffer; dropping the reference alone
     * leaves it alive until GC, and `gi2System`'s retire queue is the only
     * place this may be called from.
     */
    dispose() {
      hit?.dispose();
      resolve?.dispose();
      for (const a of [...attrsOf(store), ...attrsOf(bins), ...attrsOf(rayStore), ...attrsOf(frame),
        ...(resolve?.storageAttributes() ?? [])]) {
        a.array = a.array?.constructor ? new a.array.constructor(0) : new Uint32Array(0);
        a.dispose?.();
      }
    },
  };
}

/** Every storage attribute hanging off a store object, without naming its keys. */
function attrsOf(obj) {
  const out = [];
  for (const v of Object.values(obj ?? {})) {
    const a = v?.value;
    if (a?.isBufferAttribute === true && !out.includes(a)) out.push(a);
  }
  return out;
}
function byteSum(obj) {
  return attrsOf(obj).reduce((a, x) => a + (x.array?.byteLength ?? 0), 0);
}
