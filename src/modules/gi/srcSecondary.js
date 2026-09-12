// SPLIT RADIANCE CASCADES — [J] THE SHADING PASS (and the second bounce in it).
//
// One dispatch over the hit list [E] appended this frame. Per entry: shade the
// hit against every light, gather the tile atlas at it for the bounce, and
// atomically add the whole radiance into the bin [E] reserved for it.
//
//     L(H) = Le'(H) + ρ(H)/π · Σ_lights direct(H)
//                      + ρ_loop(H)/π · E_atlas(H, n̂)
//
// docs/GI_SRC_REBUILD_PLAN.md §4.1 [J], §4.4, §12.39, §12.26.9, §12.53.
//
// ══ WHY THE SHADING IS HERE AND NOT IN [E] (§12.53) ═════════════════════════
//
// [E] traced, shaded and scattered in one kernel, and that kernel was 179 kB of
// WGSL — ONE pipeline measured at 49-56 s of a cold boot, which is the user's
// entire "GI takes 30 s to 3 minutes to start" complaint in one number. The
// shading is what made it big: the visibility marcher is a two-nested-loop BVH8
// descent instantiated at two call sites (§13.14.5 priced a call site at ~1.2 s
// of compile), plus four rolled light slots, plus the NEE emitter set and its
// analytic shapes. None of it needs the trace — it needs a point, a normal, an
// albedo, an emission and a ray index, which is a 16-word record.
//
// §13.17's measurement is the argument: two ~75 kB kernels compiling in
// parallel beat one 177 kB monster by MORE than the byte ratio. So [E] traces,
// attributes and appends; [J] shades, gathers and deposits. Same estimator,
// same frame, same bins — the partition is drawn through the DEPOSIT, not
// through the physics:
//
//     below the hit (c < own)   T = 1, no radiance         [E]
//     at the hit    (c == own)  count now, radiance here   [E] + [J]
//     a miss        (own == N)  T = 1 everywhere           [E]
//     the sky                   composited once at [G]     unchanged
//
// It also stops paying for the ~76% of rays that MISS: the un-split kernel
// called `shadeHit` on every ray and let `own == N` throw the answer away.
//
// ══ WHY THE BOUNCE IS A PASS AND NOT A LINE IN `srcShade.js` ════════════════
//
// It was a line in `srcShade.js`, for one session, and the user's editor priced
// it the same hour: `gatherAt` is 16 hash-find loops and 16 filtered tile taps,
// and the hit shader was instantiated INSIDE the deposit's ray loop — the
// fattest kernel in the module. The deposit went 58 kB → 323 kB of WGSL (2 → 3
// loops, 642 ifs) and its pipeline compile went to **48 SECONDS**, the §13.14
// unroll pathology this module has now paid to learn three times.
//
// The plan's own [J] line said the architecture out loud — "steps B–H re-run
// over LAST FRAME'S HIT POINTS" — and that is a compact worklist with the
// gather compiled ONCE, in a small kernel, dispatched over hits instead of over
// (rays × call sites). Same estimator, same frame, same bins.
//
// ══ FOUR STORAGE BINDINGS, AND EACH ONE IS LOAD-BEARING (R7) ════════════════
//
//   1. `scratch` — the hit list AND the bins AND the per-block evidence words.
//      ONE buffer, because [J]'s inputs ride the tail of the accumulators it
//      writes (`srcDeposit.js`'s SEC_* layout). A separate list buffer would
//      have cost [E] its last binding.
//   2. `hashKeys` — the whole corner lookup, keys and the hash→block words
//      together, via `createSrcHashBlockFrame`'s single-buffer `lookup`. BUILT
//      ONLY WHEN THE BOUNCE IS ON: with `__giSrcSecondary = false` there is no
//      gather, so this binding does not exist and [J] compiles with three.
//   3. `stats` — the deposit's counters. [J] owns no buffer, exactly as
//      `createSrcShadeCounters` arranged for the hit shader.
//   4. the occupancy field's `bits` — the visibility marcher, which arrived
//      with the shading in §12.53. ONE buffer for the whole medium: the
//      pyramid, the surface-record pool and the triangle pool are regions of a
//      single allocation (`occupancyField.js` says why, and it is the same R7
//      argument as the hit list riding `scratch`).
//
// [E] was at 8 of 8 before this unit and is still at 8 — it keeps the marcher
// for its primary rays, so nothing was taken off it and nothing was added.
//
// The tile atlas is a TEXTURE and textures are not part of the 8-storage-buffer
// budget, which is the whole reason the atlas exists in that form.
//
// ══ WHY BETWEEN [E] AND [F], AND NOT ANYWHERE ELSE ══════════════════════════
//
// · AFTER [E], necessarily: the list does not exist until [E] writes it.
// · BEFORE [F], necessarily: the resolve turns the accumulators into the
//   payload, and a deposit that lands after it is a frame late — and not merely
//   late, because the bin slot itself expires. [C] re-claims blocks every
//   frame, so an entry's `SEC_SLOT` is only meaningful inside the frame that
//   produced it.
// · `hashBlockFrame.pass` does NOT move for this. It already runs before the
//   first ray (§12.39: the hash LAYOUT is rebuilt every frame with
//   scheduler-dependent contention, so the tail must be republished after
//   compaction), and that placement is exactly what [J] needs as well.
//
// ══ THE ATLAS IS LAST FRAME'S, AND THAT IS THE ESTIMATOR ════════════════════
//
// [H] bakes AFTER the deposit each frame, so at the moment this pass samples a
// tile the atlas holds the PREVIOUS frame's irradiance. That lag is not a
// compromise, it is the fixed-point iteration R4 models: frame k's bounce reads
// frame k−1's field, the in-loop gain is `clampLoopAlbedo`'s ceiling (0.9,
// measured at 0.9000 in the CPU mirror), and the series converges to the full
// multibounce sum at one cache's cost. There is no separate, coarser secondary
// cache — §12.26.9 measured the same-spacing one as the LEAST leaky (coarsening
// BRIGHTENS: the trilinear near-geometry leak scales with probe spacing, and it
// is one-sided inside a feedback loop), so re-reading the primary lattice is
// the accurate choice rather than merely the free one.
//
// ══ THE SPLIT CLAMP IS GONE, AND §12.53 IS WHY ═════════════════════════════
//
// §12.39-§12.49 clamped the primary term in [E] and the secondary term here,
// separately, so a bin could receive up to 2·Lmax where the inline form gave
// Lmax. That was accepted and counted. It is now moot: both terms are computed
// in THIS kernel, so they are summed and clamped ONCE — the inline arithmetic,
// recovered as a side effect of moving the shading rather than as a fix.
//
// `STAT_SEC_CLAMPED` keeps its slot with its real subject: the BOUNCE TERM
// ALONE reaching the ceiling. That is the R4 reading — `ρ/π · E_atlas` with
// ρ ≤ 0.9 saturating on its own means the loop's gain is running away — and it
// costs one compare, because the term is already held separately so that the
// direct half can be handed to the shared `srcShade.js` closure unchanged.
//
// ⛔ THE DISPATCH IS DIRECT AND STAYS DIRECT. An indirect dispatch over the
// count word is the obvious optimization and it has been refuted TWICE on this
// module's own kernels (`srcDeposit.js`'s dispatch note) — the second time it
// shipped an editor where [E] launched zero workgroups with no error at all.
// The trailing threads here return in whole warps off one atomic load, which is
// the same shape the ray worklist made cheap.

import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicLoad,
  atomicMax,
  atomicStore,
  float,
  floor,
  int,
  instanceIndex,
  select,
  uint,
  uintBitsToFloat,
  uniform,
  vec3,
} from "three/tsl";
import {
  MAX_LODS,
  SECONDARY_LOD_OFFSET,
  SUM_SHIFT,
  W0,
  sunBounceChromaGainForCascade,
  sunBounceGainForCascade,
} from "./srcConfig.js";
import {
  BIN_B,
  BIN_G,
  BIN_R,
  BIN_WORDS,
  BIN_SB,
  BIN_SG,
  BIN_SN,
  BIN_SR,
  DEPOSIT_SCALE,
  SEC_EMITTER,
  SEC_HIT_WORDS,
  SEC_LE,
  SEC_N,
  SEC_P,
  SEC_RAY,
  SEC_RHO,
  SEC_SLOT,
  SEC_SUML,
  SEC_DIR,
  STAT_CLAMPED,
  STAT_MAXL,
  STAT_SECONDARY,
  STAT_SEC_CLAMPED,
  STAT_SEC_OVERFLOW,
  STAT_SUN_FACING,
  STAT_SUN_SHADED,
} from "./srcDeposit.js";
import { chebyshev, lodAtDistance, packNormal } from "./srcMathTsl.js";
import { SLOT_EMPTY } from "./srcProbes.js";
import { createSrcScreenGather } from "./srcScreenGather.js";
import { clampLoopAlbedo } from "./srcShade.js";
import { MAX_LOOP_ALBEDO } from "./srcConfig.js";
import { STAT_SEC_LOD_BASE, STAT_SEC_LOD_LEVELS, STAT_SEC_LOD_MOVER_ROW, STAT_SEC_LOD_WORDS } from "./srcDeposit.js";

/**
 * [J] as a single dispatch.
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} bins   from `createSrcBinStore`, built with a
 *   `secondaryCapacity` — this pass reads the hit list out of its `scratch`
 *   tail and deposits into its bins.
 * @param {object} options
 * @param {(P, n, rho, emissive, emitter, rayIndex) => Node} options.shade  the
 *   DIRECT half of §4.4's expression, from `srcShade.js`'s
 *   `createSrcHitLighting`. Required: [J] is the shading pass since §12.53, and
 *   a [J] without it would deposit a bounce on top of a hit nobody lit.
 * @param {boolean} [options.bounce]  include the `E_atlas` term. FALSE is the
 *   single-bounce build (`low` tier, or the `__giSrcSecondary = false` hatch) —
 *   the hit is still SHADED here, only the gather is not built, which is why the
 *   flag costs this kernel its `hashKeys` binding and costs the frame nothing
 *   else. ⚠ The flag must never gate the whole pass: primary shading lives here
 *   now, and a build that skipped [J] would render black.
 * @param {object} [options.tiles]   `createSrcTileAtlas`'s bundle — the atlas is
 *   sampled as a texture, so it costs no storage binding. Required with `bounce`.
 * @param {(key) => Node} [options.lookup]  `createSrcHashBlockFrame`'s
 *   single-buffer key → block closure. Required with `bounce`.
 * @param {Node|number} options.spacing0
 * @param {Node} options.camera  the LOD metric's centre — the SAME uniform the
 *   population and the screen gather read, or [J] would gather over a lattice
 *   placed differently from the one [E] filled.
 * @param {Node} options.anchor
 * @param {Node} options.lmax  the fixed point's saturation radiance, the same
 *   uniform [F] resolves with. A second value here would make the radiance and
 *   the count in one bin carry different units.
 * @param {Node} [options.lodBias]  an EXPLICIT bias node, for a gate that wants
 *   to pin one. Omitted, this pass owns a polled uniform seeded from srcConfig's
 *   `SECONDARY_LOD_OFFSET` — see `poll` below.
 * @param {{statBase: number}} [options.surprise]  §12.52's per-block evidence.
 *   Supplied, [J] adds each deposit's LUMA into the block's `BSTAT_SUM_L` at the
 *   address the record's word 15 carries — [E] keeps the WEIGHT half, which is
 *   the same partition the bins take. Omitted, not one node of it is built.
 * @param {object} [options.count]  the shade counters (`createSrcShadeCounters`),
 *   for the tallies that moved here with the lighting.
 * @param {number} options.capacity  hit-list entries — the dispatch width.
 */
// ── §11.59 THE COUNTERS ARE OPT-OUT (2026-09-11) ────────────────────────────
// Every ray (and every shaded hit, in srcSecondary.js) bumps eight to twelve
// GLOBAL atomics on the same few words — the receipts `profile.giPasses`
// prints (rays, hits, clamped, tsum/tmax, far, movers…). Same-address atomics
// serialise at the L2 whatever the GPU; on the phone they are paid by every
// frame's transport whether anyone reads them or not. `__giSrcStats = false`
// (build-time) compiles them out; the receipt fields then read 0.
const srcStatsOn = () => globalThis.__giSrcStats !== false;

export function createSrcSecondaryFrame(store, bins, {
  shade = null,
  bounce = true,
  // R4's in-loop albedo ceiling (srcShade's `clampLoopAlbedo`); the build
  // passes `loopAlbedoCeiling()` so the `__giSrcLoopAlbedo` dial reaches the
  // one clamp that governs the fixed point.
  maxLoopAlbedo = MAX_LOOP_ALBEDO,
  tiles = null,
  lookup = null,
  spacing0,
  camera,
  anchor,
  lmax,
  lodBias = null,
  maxLods = MAX_LODS,
  w0 = W0,
  // §15 U3 — the LOS validity closure, threaded to the hit gather below. A
  // validity-blind gather HERE is the through-wall leak's main artery: it
  // shades ray hits, and what it mis-gathers is DEPOSITED into the room's
  // own bins where no screen-side weight can reach it.
  losOccupied = null,
  losWorld = null,
  surprise = null,
  sunBounceCompensation = false,
  capacity = 0,
} = {}) {
  const { scratch, stats, hitListBase, hitCapacity } = bins;
  if (!(capacity > 0) || capacity > hitCapacity) {
    throw new Error(
      `createSrcSecondaryFrame: capacity ${capacity} is outside the bin store's hit ` +
      `list (${hitCapacity}) — the store must be built with \`secondaryCapacity\``,
    );
  }
  if (typeof shade !== "function") {
    throw new Error(
      "createSrcSecondaryFrame: `shade` is required — [J] has owned the hit shading since " +
      "§12.53, and a pass without it deposits a second bounce onto an unlit hit",
    );
  }
  if (bounce && typeof lookup !== "function") {
    throw new Error("createSrcSecondaryFrame: `lookup` is required with `bounce` — the gather resolves probe corners per hit");
  }
  if (surprise && surprise.statBase !== bins.blockStatBase) {
    throw new Error(
      `createSrcSecondaryFrame: the surprise bundle's statBase ${surprise.statBase} does not ` +
      `match the bin store's ${bins.blockStatBase}`,
    );
  }

  // ── THE LOD BIAS IS A POLLED UNIFORM, NOT A BUILD CONSTANT ────────────────
  //
  // §12.23's rule, which this module keeps re-learning: a build-time value can
  // only be A/B'd by RELOADING, and a reload changes the viewport, the compile
  // wave and the settle state along with the thing under test. So the bias is a
  // uniform read per frame from `__giSrcSecondaryLodBias`, and the shipped
  // default is srcConfig's `SECONDARY_LOD_OFFSET` — 0, because [B] only inserts
  // probe keys at the camera-derived LOD, so a positive bias buys eight hash
  // finds that are guaranteed to miss (that constant's doc carries the whole
  // argument).
  const readLodBias = () => {
    const forced = Number(globalThis.__giSrcSecondaryLodBias);
    return Number.isFinite(forced) ? forced : SECONDARY_LOD_OFFSET;
  };
  const lodBiasU = lodBias ?? uniform(readLodBias());

  // THE GATHER, CLOSURE ONLY. Same integral as [I] and as the exact-reflection
  // hit — one definition, three call sites — but with no screen pass attached:
  // this one is evaluated at a hit list, and building the screen half would
  // allocate a storage texture nothing samples. The bias node is the only thing
  // that differs from the screen instance, and the screen instance passes none,
  // which keeps its graph byte-identical to every pre-[J] measurement.
  //
  // NOT BUILT WITHOUT `bounce`: that is what makes the single-bounce build cost
  // this kernel one storage binding and ~zero WGSL rather than a runtime branch
  // nobody can see the size of.
  const gather = bounce
    ? createSrcScreenGather(store, tiles, {
        lookup, spacing0, camera, anchor, maxLods, w0, lodBias: lodBiasU,
        losOccupied, losWorld,
      })
    : null;

  const base = hitListBase;
  const pass = Fn(() => {
    const i = instanceIndex.toVar();
    // One atomic load, then whole warps of trailing threads return. See the
    // header on why this is not an indirect dispatch.
    If(i.greaterThanEqual(atomicLoad(scratch.element(uint(base)))), () => { Return(); });

    const e = uint(base + 1).add(i.mul(uint(SEC_HIT_WORDS))).toVar();
    // `atomicLoad`, not a plain read: `scratch` is declared atomic and WGSL
    // will not implicitly convert `atomic<u32>` to `u32` — it fails at
    // CreateShaderModule rather than producing a wrong picture.
    const raw = (w) => atomicLoad(scratch.element(e.add(uint(w))));
    const word = (w) => uintBitsToFloat(raw(w));
    const P = vec3(word(SEC_P + 0), word(SEC_P + 1), word(SEC_P + 2)).toVar();
    const rayDir = vec3(word(SEC_DIR + 0), word(SEC_DIR + 1), word(SEC_DIR + 2)).toVar();
    const n = vec3(word(SEC_N + 0), word(SEC_N + 1), word(SEC_N + 2)).toVar();
    const rho = vec3(word(SEC_RHO + 0), word(SEC_RHO + 1), word(SEC_RHO + 2)).toVar();
    // SEC_RHO keeps physical direct reflectance. Only feedback needs R4's
    // strict <1 spectral-radius bound. THIS is the clamp that sets the loop's
    // gain — [E]'s copy only feeds a counter — so the ceiling dial
    // (`__giSrcLoopAlbedo`, srcConfig's `loopAlbedoCeiling`) must land here.
    const rhoLoop = clampLoopAlbedo(rho, maxLoopAlbedo).albedo;
    const slot = raw(SEC_SLOT).toVar();
    const Le = vec3(word(SEC_LE + 0), word(SEC_LE + 1), word(SEC_LE + 2)).toVar();
    const emitter = word(SEC_EMITTER).toVar();
    // A u32 all the way through — `hashKey` is `Math.imul`-exact on the ray
    // index and a float round-trip past 2^24 would move NEE's pick.
    const rayIndex = raw(SEC_RAY).toVar();

    // ── THE DIRECT HALF, in the shared `srcShade.js` closure ────────────────
    //
    // Le' + ρ/π · Σ_lights, with the visibility marcher, the rolled light slots
    // and the NEE emitter set — the whole of what used to be inlined into [E]'s
    // ray loop, compiled ONCE here.
    // §12.82 split the return in two: `L` is everything EXCEPT the sun, and
    // `sunTransfer` is the sun's `ρ/π · V` with the cosine and the irradiance
    // deliberately left out for `[F]` to supply from the CURRENT angle.
    // The measured directional loss enters only when radiance crosses cascade
    // hand-offs. Recover a conservative 8% per hand-off for the neutral part
    // and the separately measured 18% for albedo chroma; both are capped and
    // only the named analytic sun slot sees them. `slot` is already the
    // destination bin's WORD address, so this needs no record word or binding.
    const sunGain = sunBounceCompensation ? float(1).toVar() : null;
    const sunChromaGain = sunBounceCompensation
      ? float(sunBounceChromaGainForCascade(0)).toVar()
      : null;
    if (sunGain) {
      for (let c = 1; c < bins.cascades.length; c++) {
        const startWord = bins.cascades[c].binBase * BIN_WORDS;
        const ownsCascade = slot.greaterThanEqual(uint(startWord));
        sunGain.assign(select(
          ownsCascade,
          float(sunBounceGainForCascade(c)),
          sunGain,
        ));
        sunChromaGain.assign(select(
          ownsCascade,
          float(sunBounceChromaGainForCascade(c)),
          sunChromaGain,
        ));
      }
    }
    const shaded = shade(P, n, rho, Le, emitter, rayIndex, sunGain, sunChromaGain, rayDir);
    const Ld = vec3(shaded.L).toVar();
    const sunTransfer = shaded.sunTransfer;
    const sunFacing = shaded.sunFacing;

    // ── THE BOUNCE ─────────────────────────────────────────────────────────
    //
    // ρ_loop/π · E_atlas, against LAST frame's bake ([H] runs after the deposit), the
    // temporal fixed point R4 models. Held separately from `Ld` so that
    // `SEC_CLAMPED` can report the loop's own saturation.
    const gatheredE = gather ? vec3(gather.gatherAt(P, n).irradiance).toVar() : null;
    const Lb = gatheredE
      ? rhoLoop.mul(gatheredE).mul(1 / Math.PI).toVar()
      : null;
    const L = (Lb ? Ld.add(Lb) : Ld).toVar();
    // ── §11.14 THE PER-LOD ENERGY LEDGER (see STAT_SEC_LOD_BASE) ───────────
    if (Lb) {
      const luma = (c) => c.x.mul(0.2126).add(c.y.mul(0.7152)).add(c.z.mul(0.0722));
      // Mover hits (emitter flag -2, see the deposit) take the last row.
      const lod = select(
        emitter.lessThan(-1.5),
        int(STAT_SEC_LOD_MOVER_ROW),
        floor(lodAtDistance(chebyshev(P, camera), spacing0, maxLods)).toInt().clamp(0, STAT_SEC_LOD_MOVER_ROW - 1),
      ).toVar();
      const dFx = luma(Ld).max(0).mul(1024).toUint().toVar();
      const bFx = luma(Lb).max(0).mul(1024).toUint().toVar();
      const eFx = luma(gatheredE).max(0).mul(1024).toUint().toVar();
      const rFx = luma(rhoLoop).max(0).mul(1024).toUint().toVar();
      for (let j = 0; j < STAT_SEC_LOD_LEVELS; j++) {
        const base = STAT_SEC_LOD_BASE + j * STAT_SEC_LOD_WORDS;
        If(lod.equal(int(j)), () => {
          if (srcStatsOn()) atomicAdd(stats.element(uint(base)), dFx);
          if (srcStatsOn()) atomicAdd(stats.element(uint(base + 1)), bFx);
          if (srcStatsOn()) atomicAdd(stats.element(uint(base + 2)), eFx);
          if (srcStatsOn()) atomicAdd(stats.element(uint(base + 3)), uint(1));
          if (srcStatsOn()) atomicAdd(stats.element(uint(base + 4)), rFx);
        });
      }
    }

    // The fixed point conversion, IDENTICAL to the one [E] used to do — same
    // `lmax`, same rounding, same clamp — because [F] resolves `ΣR/Σcount` and
    // the count [E] deposited is in the same units.
    const unit = L.div(float(lmax).max(1e-6)).toVar();
    const clamped = unit.x.max(unit.y).max(unit.z).greaterThan(1).toVar();
    const fx = [
      unit.x.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
      unit.y.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
      unit.z.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint().toVar(),
    ];

    // ⚠ **`BIN_COUNT` IS NOT TOUCHED, AND THAT IS THE WHOLE NORMALIZATION.**
    // [E] already counted this ray when it deposited the transmittance and the
    // weight into this same slot, and the resolve computes `L = ΣR/Σcount`.
    // Adding a second count here would halve the bin instead of filling it.
    atomicAdd(scratch.element(slot.add(uint(BIN_R))), fx[0]);
    atomicAdd(scratch.element(slot.add(uint(BIN_G))), fx[1]);
    atomicAdd(scratch.element(slot.add(uint(BIN_B))), fx[2]);

    // ── §12.82: THE SUN'S CACHE, BESIDE THE RADIANCE IT WAS TAKEN OUT OF ────
    //
    // Same slot, same frame, same `BIN_COUNT` — the transfer is normalized by
    // the identical weight, so `ΣS/Σcount` is an exponentially-weighted mean
    // over RAYS exactly as `ΣR/Σcount` is, and a bin whose transfer and
    // radiance came from different numbers of samples cannot arise.
    //
    // ⚠ THE SCALE IS NOT `lmax`. `ρ/π · V` is a REFLECTANCE, bounded by 1/π,
    // and dividing it by a radiance ceiling would throw away five bits of it
    // for nothing. `DEPOSIT_SCALE` per unit, `count` in the same units, scales
    // cancel — the same argument the resolve's `toL` note makes, one term over.
    //
    // ⚠ AND THE NORMAL IS **STORED**, NOT ADDED. Three threads scattering into
    // one bin race here and the last writer wins, which is the intended
    // semantics: a normal is a representative direction, not a measurement to
    // be averaged, and `atomicAdd` on a packed pair of bit-fields would carry
    // between the fields and produce a direction no surface in the scene has.
    if (sunTransfer) {
      const st = vec3(sunTransfer).toVar();
      // The HIT-side rate — see `STAT_SUN_FACING`. Counted for every shaded
      // hit, facing or not, so the ratio has a denominator that means something.
      if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_SUN_SHADED)), uint(1));
      if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_SUN_FACING)), select(float(sunFacing).greaterThan(0), uint(1), uint(0)));
      atomicAdd(
        scratch.element(slot.add(uint(BIN_SR))),
        st.x.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint(),
      );
      atomicAdd(
        scratch.element(slot.add(uint(BIN_SG))),
        st.y.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint(),
      );
      atomicAdd(
        scratch.element(slot.add(uint(BIN_SB))),
        st.z.clamp(0, 1).mul(DEPOSIT_SCALE).add(0.5).floor().toUint(),
      );
      // ⚠⚠ **ONLY A SUN-FACING HIT MAY WRITE THE NORMAL, AND THIS COST 44% OF
      // THE PICTURE TO LEARN.** One word holds one normal for a whole bin, last
      // write wins — so an AVERTED hit's normal landing here makes `[F]`'s
      // `max(0, n̂·l)` zero and silences the transfer that the bin's sun-facing
      // hits accumulated over many frames. Measured on the user's Level: leg0
      // tail luma 0.039 → 0.022, leg1 0.245 → 0.193, and `checker` got WORSE
      // (leg1 0.0305 → 0.0557, rising rather than settling) because which
      // normal won flipped frame to frame.
      //
      // Gated, the split is unbiased across the two populations: an averted hit
      // deposits a ZERO transfer and still counts in `BIN_COUNT`, so a bin that
      // is half averted delivers half the sun — the right answer — while the
      // normal describes the half that actually transfers.
      //
      // The FACE-FORWARDED normal — `[E]`'s `createSrcHitAttribution` already
      // flipped it against the ray (§12.26.4) and wrote that one to `SEC_N`, so
      // this is the same normal the shading used and the cosine `[F]` computes
      // is the cosine the deposit would have computed. Reading the unflipped
      // record normal here would light the far face of every wall.
      If(float(sunFacing).greaterThan(0), () => {
        atomicStore(scratch.element(slot.add(uint(BIN_SN))), packNormal(n));
      });
    }

    // ── §12.52's per-block evidence, the LUMA half ──────────────────────────
    //
    // The address is [E]'s (it owns `own`, the chain and the claim); the value
    // is this kernel's, for the same reason the radiance is. `SLOT_EMPTY` is
    // the "no block / no bundle" sentinel, and the guard is what keeps a
    // build without the bundle from scattering an atomic into the bins.
    if (surprise) {
      const sumL = raw(SEC_SUML).toVar();
      If(sumL.notEqual(uint(SLOT_EMPTY)), () => {
        const lumaFx = float(fx[0]).mul(0.2126).add(float(fx[1]).mul(0.7152))
          .add(float(fx[2]).mul(0.0722)).toUint().shiftRight(uint(SUM_SHIFT)).toVar();
        atomicAdd(scratch.element(sumL), lumaFx);
      });
    }

    // ── the `Lmax` decision's instruments, which followed the conversion ────
    if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_CLAMPED)), select(clamped, uint(1), uint(0)));
    if (srcStatsOn()) atomicMax(stats.element(uint(STAT_MAXL)), fx[0].max(fx[1]).max(fx[2]));
    if (srcStatsOn()) atomicAdd(stats.element(uint(STAT_SECONDARY)), uint(1));
    // The BOUNCE TERM ALONE at the ceiling — R4's loop gain running away. Not
    // the same event as `STAT_CLAMPED` above, which is the whole radiance.
    if (Lb) {
      const ub = Lb.div(float(lmax).max(1e-6)).toVar();
      atomicAdd(
        stats.element(uint(STAT_SEC_CLAMPED)),
        select(ub.x.max(ub.y).max(ub.z).greaterThan(1), uint(1), uint(0)),
      );
    }
  })().compute(capacity);

  return {
    pass,
    capacity,
    lodBias: lodBiasU,
    /**
     * Whether the MULTIBOUNCE term is built — NOT whether the pass exists.
     * Since §12.53 [J] is the shading pass and is built whenever hit shading
     * is, so `!!system.secondary` no longer answers "is this multibounce?".
     * Every telemetry line, boot log and gate that used to read the pass's
     * existence reads this instead.
     */
    bounce: !!gather,
    /** The tail and the counters both ride buffers this pass does not own. */
    bytes: 0,

    /**
     * Per-frame hatch poll, called from `syncCamera` beside the α, ceiling and
     * cap polls. A no-op when the caller pinned an explicit bias node.
     */
    poll() {
      if (lodBias) return;
      const v = readLodBias();
      if (v !== lodBiasU.value) lodBiasU.value = v;
    },

    /**
     * [J]'s own tallies, out of the deposit's stats buffer.
     *
     * `hits` is the instrument the gate asserts on: a pipeline that fails to
     * create dispatches nothing and renders a frame that looks single-bounce,
     * which no image statistic can separate from "the loop adds little in this
     * scene". `overflow` is [E]'s counter, read here because the two are only
     * meaningful together — hits at the capacity with overflow nonzero means
     * the list is short, not that the bounce is bright.
     */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) {
        return { dispatched: false, bounce: !!gather, hits: 0, clamped: 0, overflow: 0, capacity };
      }
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      // §11.14: per hit-LOD energy — mean luma of the direct term, the bounce
      // term and the gathered irradiance, and the bounce/direct ratio.
      const byLod = [];
      for (let j = 0; j < STAT_SEC_LOD_LEVELS; j++) {
        const base = STAT_SEC_LOD_BASE + j * STAT_SEC_LOD_WORDS;
        const hits = v[base + 3] >>> 0;
        if (!hits) continue;
        const direct = (v[base] >>> 0) / 1024 / hits;
        const bounce = (v[base + 1] >>> 0) / 1024 / hits;
        const irradiance = (v[base + 2] >>> 0) / 1024 / hits;
        const albedo = (v[base + 4] >>> 0) / 1024 / hits;
        byLod.push({
          lod: j === STAT_SEC_LOD_MOVER_ROW ? "mover" : j, hits,
          meanDirectLuma: +direct.toFixed(4),
          meanBounceLuma: +bounce.toFixed(4),
          meanIrradianceLuma: +irradiance.toFixed(4),
          meanLoopAlbedoLuma: +albedo.toFixed(4),
          bounceOverDirect: direct > 0 ? +(bounce / direct).toFixed(3) : null,
        });
      }
      return {
        dispatched: true,
        bounce: !!gather,
        hits: v[STAT_SECONDARY] >>> 0,
        clamped: v[STAT_SEC_CLAMPED] >>> 0,
        overflow: v[STAT_SEC_OVERFLOW] >>> 0,
        capacity,
        byLod,
      };
    },

    dispose() {
      gather?.dispose?.();
    },
  };
}

/** The per-frame [J] line, for the telemetry log. */
export function formatSrcSecondary(s) {
  if (!s?.dispatched) return "";
  // `shaded` and not `bounce`, because that is what the counter measures since
  // §12.53: every entry [J] shaded, whether or not the atlas term was built.
  return `[J] ${s.hits}/${s.capacity} shaded` +
    (s.bounce ? " +bounce" : " (single)") +
    (s.clamped ? ` (${s.clamped} BOUNCE-CLAMPED)` : "") +
    (s.overflow ? `  SEC-OVERFLOW ${s.overflow}` : "");
}
