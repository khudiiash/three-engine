// GI2 — THE WORLD-ANCHORED PROBE CASCADES (audits §U, Stage 3.13 → 3.14)
//
// RC's cascades, inside the window. `NC` toroidal lattices that follow the
// camera the way `windowStore` does, each four times coarser and four times
// wider than the one below it, one probe per live cell, each tracing its
// COMPLETE fixed 64-direction set on a deterministic round-robin.
//
// ══ WHY THIS EXISTS, IN ONE PARAGRAPH (3.11/3.12's measurement) ══════════════
//
// A SCREEN probe re-anchors every frame to whatever world point its tile
// covers. The estimator it evaluates there is spatially quantized — 64 fixed
// directions against a cache holding one radiance per voxel FACE — so sliding
// the origin two centimetres changes the answer by a quantization step, in
// whichever direction the new anchor happens to land. 3.12's fixed-α image
// accumulation shrank the amplitude of that (Δp50 −90 %) and could not remove
// its SIGN FLIPS (17.2 %), because the input itself changes every frame. A
// world-anchored probe does not move at all: camera motion changes only the
// interpolation WEIGHTS, which are smooth. The term is gone by construction,
// which is the one thing an EMA can never do.
//
// ══ WHY THERE ARE THREE OF THEM (3.13's measurement) ═════════════════════════
//
// 3.13 shipped ONE lattice — 32³ cells at 0.5 m, a 16 m cube — and it won
// almost every receipt it was gated on (orbit Δp95 3.87 → 0.11 %, chain
// 3.48 → 0.99 ms, Cornell 8/8, first light frame 14 → 1). It was still held
// off by default for one structural reason: **a 16 m cube has a horizon and a
// 100 m street does not.** On Bistro's doors pose the picked dark pixels ran
// to a p95 of 15 m and 6.3 % of them had NO live corner at all; a boundary
// clamp took the thin-feature ratio from 55.8 % to 64.5 % and could not reach
// the 70 % gate, because what it extrapolates is the ambient measured at the
// lattice's EDGE and a far façade is not lit like the edge of the near room.
//
// The answer is RC's own and it is not a bigger cube. A cascade's job is to
// carry the light whose ANGULAR frequency it can still resolve: near light
// changes fast in space and needs 0.5 m probes, far light changes slowly and
// an 8 m probe is not merely adequate but CORRECT — its 64 directions cover
// the far field at exactly the resolution the far field has. Four times the
// spacing over four times the extent is the same probe count for sixty-four
// times the volume, and the ray budget splits 70/20/10 because a cascade that
// resolves slow light does not need to be re-traced as often. Three of them
// reach 256 m, which is the window's own outermost level.
//
// ══ THE FOUR THINGS THAT MAKE THIS SIMPLE, AND WHY EACH IS NOT AN ACCIDENT ══
//
// 1. **THE SLOT IS THE CELL, AND THE CASCADE IS THE HIGH BITS.** There is no
//    allocator, no free list and no atomic anywhere in this file. A cell's
//    probe lives at `cascade · CELLS + cell`, so a scroll re-keys a slab of
//    cells and nothing has to be moved, freed or reference-counted; "this slot
//    now holds a different world cell" is `stored_wc != wc`, exactly
//    `windowStore`'s brick-table rule (§K.1). Each cascade carries its own
//    origin, its own live list and its own round-robin phase, and shares every
//    kernel — which is the whole reason a third cascade costs no compile time
//    (see 4).
//
// 2. **THE OCT TEXEL IS TWO WORDS, NOT A `vec4`.** RGBE radiance + a packed
//    (n, meanDist, rmsDist). Sixteen bytes per texel would be 100 MB at the
//    desktop cascades; eight is 50. The second word is not padding — the two
//    distance MOMENTS are what the resolve's visibility test needs (DDGI's
//    Chebyshev), and they were free in the half of the alpha the screen probes
//    spend on σ (which has had no reader since §19 3.10). The moments are
//    quantized against the CASCADE'S OWN spacing, so an 8 m probe stores
//    distances out to 64 m at the same 12-bit precision a 0.5 m probe uses out
//    to 4 m — one more quantity in units of what the lattice measures.
//
// 3. **THE ROUND-ROBIN IS OVER A COMPACTED LIST, AND THE COMPACTION IS A
//    DETERMINISTIC PREFIX SUM.** A lattice is mostly empty — a sealed Cornell
//    room lights ~11 % of its cells — so dispatching (cell × texel) would
//    launch a million threads to do a hundred thousand rays' work, and this
//    file's own history says a launch-bound kernel is 3.3 ns per thread whether
//    it works or not. Three tiny kernels (count per 256-cell block, prefix-sum
//    the blocks in ONE THREAD PER CASCADE, fill) turn each cascade's live set
//    into a dense list whose ORDER is a pure function of the occupancy — no
//    atomics, so two frames with the same world produce byte-identical lists
//    and therefore byte-identical update schedules. That is what makes §T's
//    "at rest, zero flips" hold.
//
// 4. **ONE SET OF KERNELS, `NC` LATTICES.** The obvious build — call this
//    factory three times — would inline `shadeHit` three times, and `shadeHit`
//    alone is ~25 kB of WGSL that measured 2.5 s of pipeline compile at Stage
//    3.5. The cascade index is therefore a THREAD-INDEX BIT, not a JS loop:
//    every kernel dispatches `NC ×` its old width and derives `(cascade, cell)`
//    from `instanceIndex`. Spacings, origins, liveness levels and slot counts
//    are compile-time constants selected by a `select` chain over that index —
//    three constants and two compares, against three copies of the biggest
//    shader in the system.
import * as THREE from "three/webgpu";
import {
  Break, Fn, If, Loop, Return, bitAnd, bitOr, ceil, dot, exp2, float, globalId, instanceIndex,
  instancedArray, int, log2, max, min, mix, select, shiftLeft, shiftRight, sqrt, uint,
  uniform, vec3, vec4,
} from "three/tsl";
import { BMASK_OFF, LEVEL_WORDS, N, OCC_OFF } from "./windowStore.js";
import { normalOfFace } from "./radianceCache.js";

import { rc5PathEnabled } from "../giConfig.js";
/**
 * Tier constants. `cells`, `spacing`, `ratio` and `cascades` are compiled into
 * the WGSL (they are the addressing); `traceSlots` is the frame's ray budget
 * divided by 64, split across the cascades by `share`.
 *
 * `cells` must be a POWER OF TWO — the toroidal mask is `& (cells − 1)`, the
 * same identity `windowStore`'s `& 63` is.
 *
 * Cascade `c` spans `cells · spacing · ratio^c`.
 *
 * ══ ⭐⭐⭐ §19 4.10 — THE SCHEDULE IS ×2 NOW, NOT ×4, AND THAT IS THE FAÇADE ══
 *
 * The 3.14 schedule was 0.5 / 2 / 8 m over 16 / 64 / 256 m — three lattices
 * each four times the last. `probe:gi2-ref` priced what that costs where the
 * picture is: the cascades are CAMERA-CENTRED, so a façade 40 m out is past
 * c1's ±32 m half-extent and is answered by the **8 m** lattice, from a probe
 * standing 3.5–7 m away in open air. Two probes over a sixteen-metre wall
 * cannot carry a sky-visibility profile that falls 3× from roofline to
 * pavement, and they did not: pose B's façade column measured a truth fall of
 * 7.20× against GI2's 2.55×, with the answering probe a MEDIAN 6.18 m from the
 * surface it was speaking for. That is resolution, not tuning.
 *
 * ⭐ ×2 IS FREE IN RAYS AND LINEAR IN MEMORY. Five cascades of 32³ at
 * 0.5/1/2/4/8 m span 16/32/64/128/256 m — the SAME reach as three at ×4, never
 * coarser anywhere, and up to 2× finer in the 10–50 m band that a street scene
 * is mostly made of (40 m out is now the 4 m lattice, 12 m out the 1 m one).
 * The ray budget is unchanged (`traceSlots` is a budget, split by `share`), so
 * the trace's GPU cost is unchanged; what it costs is `wpOct`, which is linear
 * in the cascade count — see `describe().bytes`.
 *
 * ⚠ AND β MOVES WITH IT. `BETA` is the INTERVAL growth, and the reason it was
 * 4 is that the SPACING grew 4× — interval and spacing growing at the same rate
 * is what keeps the angular demand per cascade CONSTANT at 64 directions
 * (`BETA`'s own comment). A ×2 spacing schedule with a ×4 interval schedule
 * would compound the angular deficit 4× per cascade instead of holding it flat.
 * β is `ratio`, per tier, and the two can no longer drift apart.
 *
 * ⭐ THE SHARE IS THE UPDATE CADENCE, AND IT IS GENERATED, NOT TYPED. A cascade
 * with a tenth of the slots and a comparable live count is re-traced a seventh
 * as often as one with 70 %. Hand-typed arrays cannot follow a cascade count
 * that changes per tier, so the split is `1/2^c` normalised — the finest
 * cascade keeps half the budget at every schedule, and the tail cascades, whose
 * live counts fall off with the scene's own extent, keep enough to cycle.
 */
export const WORLD_TIERS = {
  phone: { cells: 16, spacing: 1.0, traceSlots: 1024, block: 64, cascades: 2, ratio: 4, share: [0.75, 0.25] },
  medium: { cells: 16, spacing: 1.0, traceSlots: 1024, block: 64, cascades: 2, ratio: 4, share: [0.75, 0.25] },
  high: { cells: 32, spacing: 0.5, traceSlots: 6144, block: 256, cascades: 3, ratio: 4, share: [0.70, 0.20, 0.10] },
  ultra: { cells: 32, spacing: 0.5, traceSlots: 6144, block: 256, cascades: 3, ratio: 4, share: [0.70, 0.20, 0.10] },
};

/**
 * How many cascades a tier will actually build, INCLUDING the `__gi2Cascades`
 * override — the same arithmetic `createWorldProbes` does, exported because
 * `gatherProbes` has to size `diagBuf`'s rows before it builds the lattice.
 * A reader that scores the fallback row as a cascade reads `faceCov` as `cov`.
 */
export function worldCascadeCount(tier) {
  const spec = WORLD_TIERS[tier] ?? WORLD_TIERS.high;
  return Math.max(1, Math.min(8, globalThis.__gi2Cascades ?? spec.cascades));
}

/**
 * The ray-budget split for `n` cascades: `1/2^c`, normalised. See WORLD_TIERS.
 */
export function cascadeShare(n) {
  const raw = Array.from({ length: n }, (_, c) => 2 ** -c);
  const tot = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => v / tot);
}

/** The distance moments' quantization range, in units of the CASCADE's spacing. */
export const DIST_CELLS = 8;
/** 12 bits each for the two moments, 6 for the sample count, 1 for T. */
export const DQ = 4095;

/**
 * ══ §19 STAGE 3.15 — THE RAY INTERVALS (Sannikov's rule, in this lattice) ════
 *
 * `BETA` is the INTERVAL growth per cascade and `R0_CELLS · s_0` is the finest
 * interval's length, so cascade `i` traces only
 *
 *     t_i     = r0 · (β^i − 1)/(β − 1)      …the interval's START
 *     t_{i+1} = r0 · (β^{i+1} − 1)/(β − 1)  …its END, `RAY_MAX` on the last
 *
 * and stores, per direction, the radiance it found IN THAT BAND plus a
 * TRANSMITTANCE bit: 0 if something stopped the ray inside the band, 1 if
 * nothing did. `mergePass` then adds `T · parent` per direction, so a cascade's
 * stored map is the WHOLE radiance field seen from that probe — its own near
 * band at its own spatial resolution, the far bands at the resolution the
 * cascades that own them can still resolve. Contiguous by construction (a GAP
 * is a distance band no cascade owns, i.e. light silently dropped; an OVERLAP
 * double-counts it — `srcConfig.intervalBoundaries`' own rule, which this
 * engine had and this lattice had lost).
 *
 * ⭐⭐ WHY β = 4 AND NOT 2, AND WHY 64 DIRECTIONS IS ENOUGH HERE.
 *
 * RC's usual branching is spacing ×2 / interval ×4 / DIRECTIONS ×4, and the
 * directions grow because the interval outruns the spacing. This lattice grows
 * spacing ×4 as well (`WORLD_TIERS.ratio`), so β = 4 makes interval and spacing
 * grow at the SAME rate and the angular demand per cascade is CONSTANT rather
 * than compounding. Concretely: 64 texels over the sphere is a 28.6° cone,
 * which at cascade `i`'s interval end subtends `0.5 · t_{i+1}` — 1.0 m at c0
 * (spacing 0.5), 5 m at c1 (spacing 2), 20 m at c2 (spacing 8). The SAME ~2.4×
 * angular deficit at every cascade.
 *
 * ⚠ SO THE CONSEQUENCE OF KEEPING 64 IS NAMED, NOT HIDDEN: every cascade is
 * ~2.4× coarser in angle than in space, uniformly. A 16×16 oct map on c1/c2
 * would close it exactly — and would cost 4× their rays (30 % of the budget →
 * +90 % total) and 4× their `wpOct` (50 → 184 MB, past the portable envelope's
 * ceiling before the window is counted). NOT TAKEN. Because the deficit is
 * uniform it reads as one global softness in the far field rather than as a
 * cascade-boundary artefact, which is the failure mode 3.14 actually had.
 */
export const BETA = 4;
/**
 * §19 4.10 — the interval growth for a tier whose SPACING grows by `ratio`.
 * They must be the same number (see `WORLD_TIERS`); `BETA` survives as the
 * default so a caller that passes nothing gets 3.14's schedule.
 */
export const betaOf = (ratio) => (ratio > 1 ? ratio : BETA);
/**
 * r0, the finest cascade's interval length, in cells of the FINEST spacing.
 *
 * ⭐⭐ 8, AND THE RULE IT COMES FROM IS `t_{i+1} >= 2 * s_{i+1}` — THE PARENT'S
 * INTERVAL MUST START FURTHER OUT THAN THE PARENT'S OWN PROBE SPACING.
 *
 * The merge interpolates the parent's map AT THE CHILD'S POSITION, and the
 * child can be up to `s_{i+1}` from the parent it reads. If the parent's
 * interval starts at `t_{i+1} ~ s_{i+1}`, that offset is comparable to the
 * whole near end of the band and the hand-off loses energy: the child asks
 * "what is beyond 10 m from ME" and is answered "beyond 10 m from somewhere
 * else eight metres away".
 *
 * ⭐ THE CORRIDOR SWEPT IT AND THE ARMS RANK EXACTLY BY `t_{i+1}/s_{i+1}`
 * (wall crops, GPU / 4-bounce path-traced truth, ultra):
 *
 *   r0  t = [t0,t1,t2]   t1/s1  t2/s2 |  5 m    15 m   30 m   50 m
 *    2  [0, 1,  5]        0.5    0.63 | 0.209  0.404  3.064  0.119
 *    4  [0, 2, 10]        1.0    1.25 | 1.227  0.376  2.888  0.119
 *    8  [0, 4, 20]        2.0    2.50 | 1.161  0.458  2.877  0.118
 *   12  [0, 6, 30]        3.0    3.75 | 1.839  0.500  2.875  0.118
 *   16  [0, 8, 40]        4.0    —    | 1.633  0.614  2.872  0.118
 *
 * r0 = 2 is a COLLAPSE — the 5 m crop reads a fifth of the truth — and it is
 * the only arm whose ratios are below 1 on both sides of the hand-off. Past
 * r0 = 8 the far cascade's band is squeezed toward nothing (at 16, `t2 = 40`
 * = `RAY_MAX` and c2 has no band at all, which is 3.14 with extra steps), and
 * the 5 m crop drifts back up as c1 takes work c0 should be doing. 8 is both
 * the best total error and the smallest value that satisfies the rule.
 *
 * ⚠ ASYMPTOTICALLY the ratio is `R0_CELLS / (BETA − 1)`, so anything ≥ 6 keeps
 * `t/s ≥ 2` at every cascade. 8 is that with margin, and it is a power of two.
 */
export const R0_CELLS = 8;
/** `[t_0 … t_{NC−1}]` — cascade i's interval START. `t_0` is always 0. */
export function intervalStarts(spacing0, cascades, r0Cells = R0_CELLS, beta = BETA) {
  const r0 = r0Cells * spacing0;
  return Array.from({ length: cascades }, (_, i) => r0 * ((beta ** i - 1) / (beta - 1)));
}
/**
 * `[t_1 … t_NC]` — cascade i's interval END. The LAST cascade ends at the
 * window's own horizon (`RAY_MAX`): past that there is no occupancy to march
 * and the only honest answer is the sky, which is why the last cascade is also
 * the ONLY one that credits sky on a miss.
 */
export function intervalEnds(spacing0, cascades, rayMax, r0Cells = R0_CELLS, beta = BETA) {
  const s = intervalStarts(spacing0, cascades, r0Cells, beta);
  return s.map((_, i) => (i === cascades - 1 ? rayMax : Math.min(rayMax, s[i + 1])));
}

/**
 * The cascade hand-off band, as a fraction of a cascade's extent.
 *
 * ⭐ A HARD CASCADE BOUNDARY IS A VISIBLE EDGE THAT MOVES WITH THE CAMERA —
 * the one failure mode a world-anchored design can still have, because the
 * lattice bounds are the only thing in it that is camera-relative.
 *
 * ⭐⭐ 0.10 → 0.15, WHICH IS §V.6's OWN ARITHMETIC AND 3.15's MERGE IS WHAT
 * MAKES IT SAFE. `stepLatticeOrigin` moves an origin in blocks of `blk = 4`
 * cells, so the boundary jumps `blk/C = 0.125` of the extent on a scroll — a
 * band NARROWER than that can be crossed entirely in one step, which is a pop
 * by construction and is the mechanism §V.6 named for 3.14's +2.0/+5.5/+3.0
 * points of motion flips. 3.14 could not simply widen it, because a wider band
 * imported more of c1's 1.6×-too-bright far field into the near field. Under
 * the interval merge there is no such import: c0 and c1 now describe the SAME
 * total radiance field and differ only in spatial resolution, so blending them
 * over a wider band costs nothing but a little softness.
 */
export const BAND = 0.15;

/**
 * The hysteretic origin step for one lattice axis, in whole BLOCKS of cells.
 *
 * Same shape as `windowStore.stepOrigin` and for the same reason: the trigger
 * is "the camera left the central half" (so a 10 cm walk never re-keys
 * anything) and the STEP is the minimal aligned shift that puts it back, so a
 * crossing re-keys one slab rather than half the lattice.
 */
export function stepLatticeOrigin(camCell, prev, cells, blk = 4) {
  const floorTo = (c) => Math.floor(c / blk) * blk;
  if (prev === null || prev === undefined) return floorTo(camCell - cells / 2);
  const off = camCell - prev;
  const lo = cells / 4;
  const hi = (3 * cells) / 4;
  if (off >= lo && off < hi) return prev;
  if (off < lo) return prev - Math.ceil((lo - off) / blk) * blk;
  return prev + Math.ceil((off - hi + 1) / blk) * blk;
}

/**
 * @param {object} opts
 * @param {object} opts.win    from `createGiWindow`
 * @param {object} opts.trace  from `createWindowTrace`
 * @param {object} opts.cache  from `createRadianceCache`
 * @param {string} opts.tier
 * @param {object} opts.kit    the SHADING KIT — the closures `gatherProbes`
 *   already owns and this file must not duplicate: `u` (its uniform bag),
 *   `octU` (the direction table), `cellOfWorld`, `dominantFace`,
 *   `hitRadiance`, `emitterSh` … see `createGiGather`.
 *
 *   ⚠ THE KIT IS PASSED, NOT REBUILT. `shadeHit` alone inlines a sun ray, four
 *   sky rays, every emitter slot's NEE and (on the rig) four panel strata; a
 *   second copy of that text is ~25 kB of WGSL and, measured at 3.5, 2.5 s of
 *   pipeline compile. Passing the closure means ONE definition reached from two
 *   kernels — and, because only one of the two probe paths is BUILT per boot
 *   (see `WORLD_PROBES`), in practice one kernel.
 */
export function createWorldProbes({ win, trace, cache, tier = win.tier, kit }) {
  const spec = WORLD_TIERS[tier];
  if (!spec) throw new Error(`unknown world-probe tier "${tier}"`);
  /**
   * ⭐⭐⭐ §19 STAGE 5.4b — UNDER RC5 THE LATTICE IS NOT BUILT AT ALL.
   *
   * 5.2 shipped the cascades BESIDE the world probes and said so in its own
   * message: "the engine currently pays both resolves; the world path dies in
   * 5.4". It did not die, and the user paid for it — Bistro at RC5 boots long
   * and runs 6-25 fps because three lattices still allocate ~70 MB of CPU
   * mirrors, compile ~13 kernels (the world TRACE is the slowest pipeline of
   * the boot) and dispatch every one of them every frame into a field whose
   * only consumer, `resolveHalf`, is overwritten by `rcMerge` a few kernels
   * later.
   *
   * LEAN is not a uniform and not a branch inside a kernel: it is a BUILD arm.
   * Nothing is allocated, no `Fn` is constructed, `frameOrder` is empty and
   * `describe().bytes` reports zeros — so `profile_gi2` says the lattice is
   * gone rather than that it is idle. `__gi2Rc5 = false` pre-boot is the full
   * old path, byte for byte, which is the A/B this stage has to keep.
   *
   * ⚠ THE TAPS STILL EXIST. `gatherProbes`' `resolveHalf` closes over
   * `world.taps.*` at build time; the taps are node FACTORIES over the
   * (now 4-word) buffers and cost nothing to keep, and the pass that uses them
   * is dropped from the chain by `gi2System` under the same gate.
   */
  // `__gi2Rc5Cut = 0` PRE-BOOT IS 5.2 EXACTLY, OUT OF THIS BINARY — the same
  // discipline `__gi2Cascades` and `__gi2Intervals` keep, and for the same
  // reason: an A/B against the previous COMMIT is an A/B across a different
  // shader cache and a different night's driver.
  const LEAN = rc5PathEnabled() && (globalThis.__gi2Rc5Cut ?? 1) !== 0;
  const C = spec.cells;
  const CB = Math.log2(C);
  const CELLS = C * C * C;
  const CELLB = Math.log2(CELLS);
  /**
   * ⭐ `globalThis.__gi2Cascades = 1` IS 3.13, OUT OF 3.14'S BINARY.
   *
   * Every 3.14 receipt is a comparison against the single lattice, and an A/B
   * against a previous COMMIT is an A/B across a different shader cache, a
   * different driver state and a different night. One cascade with the boundary
   * clamp on it (the clamp is the LAST cascade's, and with `NC = 1` the last is
   * the only) is 3.13 exactly — same kernels, same WGSL text apart from the
   * select chains folding to constants, same page. Read BEFORE the build,
   * because it is the addressing.
   */
  // ⭐ `__gi2Cascades` MAY NOW RAISE AS WELL AS LOWER, and `__gi2Ratio` joins
  // it — the two numbers that ARE the schedule, so "is ×2 over five lattices
  // better than ×4 over three" is one page and one battery rather than two
  // commits, two shader caches and two nights' drivers. The ceiling is 8
  // because `CASC_PREF` is `ratio³ ^ (NC−1−c)` and a ninth cascade at ×4 would
  // leave float range. `__gi2Cascades = 1` is still 3.13 exactly.
  const NC = Math.max(1, Math.min(8, globalThis.__gi2Cascades ?? spec.cascades));
  const RATIO = Math.max(2, globalThis.__gi2Ratio ?? spec.ratio);
  const BETA_C = betaOf(RATIO);
  const SP0 = spec.spacing;
  const BLOCK = spec.block;
  const BLOCKS = CELLS / BLOCK;
  const ALL_CELLS = CELLS * NC;

  const {
    u, octU, cellOfWorld, dominantFace, hitRadiance, emitterSh, bump, STATS, RAY_MAX, OCT, shEval,
  } = kit;
  const { traceWindow } = trace;
  const v0 = win.voxel0;

  /** Cascade `c`'s spacing, extent and moment range — all compile-time. */
  const SPC = Array.from({ length: NC }, (_, c) => SP0 * RATIO ** c);
  const EXT = SPC.map((s) => C * s);
  const DMAX = SPC.map((s) => DIST_CELLS * s);
  /**
   * ⭐ `globalThis.__gi2Intervals = 0` IS 3.14, OUT OF 3.15'S BINARY.
   *
   * The same discipline `__gi2Cascades` follows and for the same reason: every
   * 3.15 receipt is a comparison against "each cascade traces to the horizon
   * and the resolve picks the finest that covers you", and an A/B against a
   * previous COMMIT is an A/B across a different shader cache and a different
   * night's driver. Off: `TSTART = 0` and `TEND = RAY_MAX` on every cascade,
   * every miss credits sky, the merge and seed kernels are not built, and
   * `wpAlpha` goes back to 0.25 — 3.14 exactly, on one page.
   *
   * Read BEFORE the build, because it is what the kernels ARE.
   */
  const INTERVALS = (globalThis.__gi2Intervals ?? 1) !== 0;
  /**
   * `globalThis.__gi2R0` overrides `R0_CELLS` — the ONE number the interval
   * geometry has, exposed so "is the chain losing energy at its hops" is an
   * experiment rather than an argument. Longer intervals mean fewer cascades
   * carry a given distance and fewer positional hand-offs; shorter ones mean
   * each cascade works nearer its own probe spacing. Both are defensible and
   * only a receipt can choose.
   */
  const R0C = Math.max(1, globalThis.__gi2R0 ?? R0_CELLS);
  /**
   * ══ §19 STAGE 3.16 — THE THREE FIXES 3.15's VERDICT NAMED, EACH ITS OWN ARM ═
   *
   * All three are read BEFORE the build and all three are BINARIES, for the
   * discipline `__gi2Cascades` and `__gi2Intervals` set: a 3.16-against-3.15
   * comparison across two COMMITS is a comparison across two shader caches and
   * two nights' drivers. `?fix316=0` on the rig pages turns all three off and
   * reproduces 3.15 exactly, out of one binary.
   *
   * 1. `__gi2CoarsePlace` — a coarse probe stays inside its OWN cell.
   * 2. `__gi2Reach`       — the last cascade traces to its LATTICE's extent.
   * 3. `__gi2SplitOwn`    — `own` and `merged` are separate words, so α returns.
   */
  const PLACE_IN_CELL = (globalThis.__gi2CoarsePlace ?? 1) !== 0;
  /**
   * ⛔⛔ §19 3.16 — REACH SHIPS **OFF**, AND THAT IS A MEASUREMENT REVERSING THE
   * SPEC. It was built exactly as `REACH_LAST` describes below, and then
   * refuted by the receipt it was built for. `probe:gi2-farfield`, Bistro
   * street-overview, pose pinned, 3417 paired façade pixels, ONE reference:
   *
   * | far-façade irradiance | screen | reach OFF (40 m) | reach ON (256 m) |
   * |---|---|---|---|
   * | 30–40 m p50 | 1.071 | 2.559 | 2.808 |
   * | 40–55 m p50 | 1.243 | 2.353 | 2.621 |
   * | **55–75 m p50** | **4.212** | **3.875** | **0.000** |
   * | ÷ screen p50 | — | 1.505 | 1.668 |
   * | within ±30 % of screen | — | 33.2 % | 27.1 % |
   *
   * ⭐⭐ **A LONGER RAY STOPS MISSING AND STARTS HITTING, AND A HIT ON A BRICK
   * THE CACHE HAS NOT LIT YET IS BLACK WHERE THE MISS WAS SKY.** That is §W.3's
   * own "a missing parent pays SKY, NOT BLACK" one level down — in the trace
   * rather than in the merge. At `RAY_MAX` the far band was paid a sky it had a
   * right to; at the lattice's extent it is paid the radiance of a far street
   * the cache converges to LAST. The band only the last cascade can answer for
   * went to exactly 0.0000 on all thirty of its samples.
   *
   * And it buys nothing where truth exists: the corridor's 50 m crop reads
   * 0.119 with reach off and 0.116 with it on against a path-traced 1.0,
   * because that row is c1's ±32 m extent and c2's 8 m probes — resolution, not
   * ray length (§W.11's own second item).
   *
   * ⚠ THE IMPLEMENTATION STAYS AS AN ARM (`__gi2Reach = 1`), because the
   * diagnosis is now specific rather than general: reach becomes right the day
   * the last cascade can tell "there is nothing there" from "that is not lit
   * yet". Until then `RAY_MAX` is the honest horizon and sky at it is the
   * honest answer.
   */
  /**
   * ⭐⭐ §19 3.17 — REACH SHIPS **ON**, AND THAT IS THE COLD-HIT FALLBACK'S
   * RECEIPT. 3.16 reverted it because a longer ray started hitting bricks the
   * cache had never lit and paid BLACK for them; `hitRadiance`'s
   * `unlitFallback` (§19 3.17) removes that floor — a cold hit now pays its
   * albedo times the parent cascade's own irradiance at the hit point — so the
   * band only the last cascade can answer for is served rather than blacked.
   * `__gi2Reach = 0` is 3.16's arm, kept for the A/B.
   */
  const REACH_LATTICE = (globalThis.__gi2Reach ?? 1) !== 0;
  const SPLIT_OWN = INTERVALS && NC > 1 && (globalThis.__gi2SplitOwn ?? 1) !== 0;
  /**
   * §19 4.12 — the coverage a FINER cascade must have at a coarse probe before
   * that probe is allowed to defer its near band to it. `0` compiles 3.15's
   * containment-only rule verbatim (see `coveredBelow`); anything above it
   * compiles the cell-margin + liveness test. Build-time, because an arm that
   * only half-restores the stage it is compared against proves nothing.
   */
  const COV_BELOW = Math.max(0, globalThis.__gi2CovBelow ?? 0.5);
  /**
   * §19 4.13 — over how much of the coarse cell the liveness question is asked.
   * `1` (shipped) takes the MIN over the cell's eight corners at `holdsCell`'s
   * own ± spacing margin; `__gi2CovCorners = 0` compiles 4.12's single tap at
   * the probe's own position, which is the only arm that can arbitrate `DARK1`
   * — a pixel six metres from a probe that read its own coverage as 1.000.
   * Build-time, for §AI.3's reason.
   */
  const COV_CORNERS = (globalThis.__gi2CovCorners ?? 1) !== 0;
  /**
   * ⭐⭐ §19 3.16 FIX 2 — `RAY_MAX` IS PER-CASCADE, AND THE LAST CASCADE'S IS
   * ITS OWN LATTICE'S EXTENT.
   *
   * §W.11 named the frame around the corridor's two worst rows: **the cascade
   * LATTICE reaches 256 m while the cascade RAYS reach 40.** A c2 probe stands
   * anywhere in a 256 m cube and can see 40 m of it, so most of that lattice is
   * probes whose every direction misses, is paid SKY, and then reports the sky
   * as the far field. On a 100 m street those are exactly the façades this
   * cascade exists to carry.
   *
   * The honest horizon is the one the OCCUPANCY has. The window's coarsest
   * level is `C · s_{NC−1}` across and `windowTrace` already steps up into it,
   * so the last cascade's interval ends where its own lattice does — 256 m at
   * ultra/high, 64 m on the phone tiers. Every inner cascade is unchanged,
   * because `t_{i+1}` was never `RAY_MAX` there.
   *
   * ⚠ AND THE SKY CREDIT MOVES WITH IT, WHICH IS THE POINT. `hitRadiance` pays
   * `skyColor` on a miss, and that credit is only true at a distance where
   * there is genuinely nothing left to hit. `RAY_MAX = 40` in a 60 m corridor
   * made it a LEAK (§W.5); at the lattice's own extent it is the answer.
   */
  const REACH_LAST = REACH_LATTICE ? EXT[NC - 1] : RAY_MAX;
  const TSTART = INTERVALS ? intervalStarts(SP0, NC, R0C, BETA_C) : SPC.map(() => 0);
  const TEND = INTERVALS
    ? intervalEnds(SP0, NC, REACH_LAST, R0C, BETA_C)
    : SPC.map(() => REACH_LAST);
  /**
   * The window level cascade `c` reads its LIVENESS from.
   *
   * ⭐ THE LIVENESS LEVEL IS THE ONE WHOSE VOXEL IS HALF THE PROBE SPACING, so
   * every cascade's "±1 cell" dilation is the SAME 4³ voxel scan — the loop
   * bound below is a compile-time 64 on every cascade of every tier, and the
   * dilation means the same thing (one voxel out) at 0.5 m and at 8 m. Cascade
   * 0 keeps 3.13's rule (the FINEST level containing the point) because at the
   * desktop tier the lattice and L0 are both 16 m but snap differently, so an
   * edge cell is legitimately L1's.
   *
   * ⚠ CLAMPED TO THE WINDOW'S LAST LEVEL. `high` has four levels (128 m) and
   * `ultra` five (256 m); on `high`, cascade 2's outer cells sit past L3's
   * window and `occAt` would read another cell's bits through the torus. They
   * are DEAD instead — see `levelAtLeast`, the guard 3.13 never needed because
   * one 16 m lattice is inside L0 by construction.
   */
  const LMIN = SPC.map((s, c) => (c === 0
    ? 0
    : Math.min(win.levels - 1, Math.max(0, Math.round(Math.log2(s / v0)) - 1))));

  /**
   * The ray budget, split by `share` and rounded to the trace kernel's 8-wide
   * workgroup so every cascade's slots start on a workgroup boundary and no
   * workgroup straddles two cascades.
   */
  const SLOTS = (() => {
    // Renormalized over the cascades that EXIST, so `__gi2Cascades = 1` hands
    // the whole 6144-slot budget to cascade 0 — 3.13's number exactly, not 70 %
    // of it. An arm that quietly cuts the ray budget is not an arm.
    const sh = (spec.share ?? cascadeShare(NC)).slice(0, NC);
    const tot = sh.reduce((a, b) => a + b, 0);
    const raw = sh.map((f) => Math.max(8, Math.round((spec.traceSlots * (f / tot)) / 8) * 8));
    const drift = spec.traceSlots - raw.reduce((a, b) => a + b, 0);
    raw[0] += drift; // the finest cascade absorbs the rounding, in its own favour
    return raw.map((n) => Math.min(n, CELLS));
  })();
  const SLOT_BASE = SLOTS.map((_, i) => SLOTS.slice(0, i).reduce((a, b) => a + b, 0));
  const TRACE_SLOTS = SLOTS.reduce((a, b) => a + b, 0);

  // ── buffers ───────────────────────────────────────────────────────────────
  //
  // Indexed by the GLOBAL cell `gc = cascade · CELLS + cell`. `wpOct` is the
  // whole cost of this design and it is deliberately the only thing that scales
  // with the lattice: `OCT_W` u32 per (cell, texel).
  //   word 0  MERGED RGBE radiance — what `shPass` and every resolve tap read
  //           (0 = never written, the same sentinel the cache's own words use,
  //           so "no data" and "black" stay distinguishable)
  //   word 1  n<<24 | T<<30 | rmsQ<<12 | meanQ   — the two distance moments
  //   word 2  OWN RGBE radiance, §19 3.16 fix 3 — the probe's own band, the
  //           only thing its 64 rays measure and therefore the only thing an
  //           EMA may be applied to. Built ONLY under `SPLIT_OWN`.
  //
  // ⚠ A THIRD WORD, NOT A FOURTH BUFFER. The trace kernel binds exactly six
  // storage buffers (window, cache, oct, info, list, stats) and the phone tier
  // has exactly six — see `wpList`'s comment, which spent the same coin. A
  // separate `wpOwn` would not compile there; a wider stride costs the same
  // 25 MB and no binding.
  const OCT_W = SPLIT_OWN ? 3 : 2;
  const wpOct = instancedArray(new Uint32Array(LEAN ? 4 : ALL_CELLS * OCT * OCT_W), "uint");
  /**
   * ⭐⭐ §19 3.17 — THE SH LIVES INSIDE `wpInfo`, AND THAT IS THE PORTABLE
   * ENVELOPE, NOT TIDINESS.
   *
   * Twelve vec4 per cell:
   *   0    (probe position, state)   state 0 dead · 1 open-air · 2 faced
   *   1    (face normal, mergeVis bits)
   *   2    (world cell coord, ready) ready 0 = the map is not trustworthy yet
   *   3-11 the NINE SH2 coefficients — what the resolve reads, and (3.17) what
   *        the TRACE reads for a cold hit's fallback (`irradianceAtCasc`).
   *
   * `wpSh` was its own binding until the cold-hit fallback needed the parent
   * cascade's field inside the trace kernel — which already bound its six
   * (window, cache, oct, info, list, stats) and would have compiled to SEVEN.
   * The gather probe caught it on the first run: `worldTrace=7 exceed the
   * portable envelope of 6`. ⭐ **A WIDER STRIDE COSTS NO BINDING**, which is
   * the same coin `wpOct`'s third word spent at 3.16 — and here it costs no
   * BYTES either: 3 + 9 vec4 in one array is exactly what 3 and 9 were in two.
   * Every kernel that reads both (`sh`, `nee`, `seed`, the resolve) also drops
   * a binding.
   */
  const INFO_VEC = 12;
  const wpInfo = instancedArray(new Float32Array(LEAN ? 4 : ALL_CELLS * INFO_VEC * 4), "vec4");
  /**
   * ONE buffer for the compaction, because the trace stands at the portable
   * envelope's six storage bindings exactly (window, cache, oct, info, list,
   * stats) and a seventh for an integer would not compile on the phone tier.
   * Each cascade owns a contiguous `LIST_WORDS` run:
   *   [0, CELLS)                 the per-cell live FLAG
   *   [CELLS, 2·CELLS)           the dense live LIST
   *   [2·CELLS, +BLOCKS)         per-block base (count, then prefix)
   *   [2·CELLS+BLOCKS, +8)       control — [0] is the live count
   */
  const FLAG_OFF = 0;
  const LIST_OFF = CELLS;
  const BASE_OFF = 2 * CELLS;
  const CTL_OFF = BASE_OFF + BLOCKS;
  const LIST_WORDS = CTL_OFF + 8;
  const wpList = instancedArray(new Uint32Array(LEAN ? 4 : LIST_WORDS * NC), "uint");

  // ── uniforms owned here (merged into the gather's bag by the caller) ──────
  const wu = {
    /**
     * §U.2's fixed α between complete updates. It cannot remove noise (there is
     * none: the probe does not move, so its 64 rays are the same rays every
     * time) — it exists so the world cache's convergence STEPS and a moved lamp
     * arrive as a ramp. 1 is a legitimate arm and is not noisy, only abrupt.
     *
     * ⛔⛔ AND UNDER THE INTERVAL MERGE IT MUST BE 1, WHICH IS NOT A TUNING
     * CHOICE BUT AN ALGEBRAIC ONE. `mergePass` writes `own + T·parent` back
     * into the same texel, so the value the next trace would blend against is
     * already MERGED — `mix(merged, own, 0.25)` re-mixes the far field into the
     * near band and the next merge adds it again. The EMA and an in-place merge
     * cannot both be right, and the merge is the one the stage is for. §T is
     * satisfied without it anyway: a world probe's 64 rays are the same 64 rays
     * from the same point every update, so α was never removing noise here.
     *
     * ⭐⭐ §19 3.16 FIX 3 — AND THAT ALGEBRA IS A CONSEQUENCE OF ONE WORD, NOT
     * OF THE MERGE. The forcing clause above is "`mergePass` writes `own +
     * T·parent` back INTO THE SAME TEXEL". 3.15's verdict measured what that
     * cost — cold noise p95 0.723 → 1.576 % and Bistro motion flips 26.9/21.6/
     * 17.6 → 35.1/26.4/23.3 % — and named the fix: hold `own` and `merged` in
     * separate words. `SPLIT_OWN` does exactly that, as a THIRD u32 inside
     * `wpOct` rather than a fourth storage binding (the portable envelope's six
     * are already all spent — see `wpList`'s comment), for +25 MB at ultra.
     *
     * With the split, α is an EMA on `own` — the probe's own band, the thing
     * its 64 rays actually measure — and `mergePass` recomposes `merged` from
     * the accumulated `own` every time it runs. Nothing re-mixes, because the
     * value α blends against is never the merged one. 0.5, which is §U.2's
     * "fixed α between COMPLETE evaluations" (§T allows it: a world probe's 64
     * rays are the same rays from the same point, so this ramps the CACHE's
     * convergence and removes no noise that was ever there).
     */
    /**
     * ⭐ §19 3.17 — 0.25, WHICH IS §U.2's OWN VALUE AND THE ONE 3.16 MEASURED.
     * Cold-noise temporal p95 0.729 % (PASS, gate ≤ 1) against 1.206 % at 0.5,
     * for +2 frames on a moved panel (7 → 9, gate ≤ 10). 3.16 shipped 0.5
     * because that was what the stage specified and recorded the pair as a
     * receipt; this is the stage that spends it. Under the in-place merge
     * (`SPLIT_OWN` off) α is still 1 by algebra, not by taste — see `mergeFor`.
     */
    wpAlpha: uniform(SPLIT_OWN ? 0.25 : (INTERVALS ? 1 : 0.25)),
    /**
     * ⭐⭐⭐ §19 3.19 — HOW MANY UPDATES A RE-KEYED PROBE TAKES TO STOP QUOTING
     * ITS PARENT. `1` is 3.18 verbatim (the first own trace REPLACES the seed),
     * which is what makes it a one-boot A/B arm rather than a commit.
     *
     * THE RECEIPT (`probe:gi2-motion`, Bistro ultra, world, `GRAIN_ARMS`):
     * a park segment that the camera JUMPS into reads, frame by frame,
     *   dolly  — 41.5  56.0  1.5  29.4  13.6  0.3  4.7 … 5.1 … 6.3 … 3.4 …
     *   whip   —  61.0  2.2  19.7  1.0  0.9  0.2  0.6  1.8  1.9  6.1 …
     * against an orbit park that never leaves 0.0-0.4 %. Two things are visible
     * in those rows and neither is in a segment mean: the transient DECAYS over
     * about six frames, and what is left of it BEATS at the round-robin period
     * — a probe re-keyed by the scroll takes its own turn a few frames later,
     * and on that turn the value the resolve reads jumps from its parent's
     * merged answer to its own first trace in ONE step. Eight corners doing
     * that on different frames is a pixel whose delta changes sign every time
     * another corner catches up.
     *
     * So the composed word RAMPS: on update `n` of a seeded probe it moves
     * `min(1, n / wpSeedRamp)` of the way from what it held to what this trace
     * measured, reaching the trace exactly at `n = wpSeedRamp`. Monotone by
     * construction (every step is a positive fraction of the same gap), and
     * `own` — word 2, the probe's own band — is untouched at α = 1, so the
     * merge still cannot double-count the parent's far chain (see `fresh`).
     */
    wpSeedRamp: uniform(4),
    /** 0 removes the resolve's visibility term — the LEAK RECEIPT'S CONTROL. */
    wpVisOn: uniform(1),
    /** 0 removes the probe-face gate; the other half of the same control. */
    wpFaceOn: uniform(1),
    /**
     * The surface bias, as a fraction of the FINEST cascade's spacing — 15 cm
     * on every cascade. A pixel is sampled at `P + N·bias·s_0` so its own
     * surface cannot occlude it from the probes above it.
     *
     * ⭐⭐ AND IT IS `s_0`, NOT `s_c`, BECAUSE OF WHAT IT HAS TO CLEAR. Scaling
     * it by the SAMPLED cascade made it 60 cm at c1 and 2.4 m at c2, and a
     * façade sampled 2.4 m out into an open street is not the same surface:
     * the far-field receipt measured every façade past 55 m composited BLACK
     * (the displaced point's eight corners were all dead) and the 30-55 m band
     * 1.67× too bright. A length that has to clear a SURFACE belongs in the
     * surface's units, not in the sampler's. See audits §V.3.
     */
    wpBias: uniform(0.3),
    /**
     * The Chebyshev variance floor, as a fraction of the spacing. Without it a
     * probe whose distance map is locally flat (a wall it stares at) has zero
     * variance and the test becomes a hard step at the stored distance, which
     * over-occludes every pixel a few centimetres past it.
     */
    wpVarFloor: uniform(0.5),
    /**
     * 1 = the cascades resolve; 0 = cascade 0 alone, which is 3.13 exactly.
     *
     * ⭐ THE RECEIPT THAT SAYS THE CASCADES FIXED THE HORIZON NEEDS THE VERSION
     * WITHOUT THEM, and an A/B against a previous COMMIT is an A/B across a
     * different shader cache and a different night's driver. Both arms out of
     * one binary, like every other lever in this module.
     */
    wpCascadesOn: uniform(1),
    /**
     * ⭐⭐ §19 3.15 — THE BIAS-INDEPENDENCE TELL, AS A UNIFORM.
     *
     * 0 = the bias is `wpBias · s_0` on every cascade (shipped). 1 = it is
     * `wpBias · s_c`, the SAMPLED cascade's spacing — 3.14's first cut, which
     * §V.4 showed moved the doors thin-feature ratio (33.9 ↔ 70.3 %) and the
     * far-field ratio (1.609 ↔ 1.671, with a black band past 55 m) IN THE SAME
     * DIRECTION. One displacement constant with authority over both a 14 cm
     * recess and a 40 m façade is the clearest evidence "pick the finest
     * cascade that covers you" is not RC's merge.
     *
     * Under the interval merge those are DIFFERENT CASCADES' INTERVALS and the
     * coupling has nowhere to live: a doors pixel at 6 m reads c0, whose
     * spacing IS `s_0`, so `s_0` and `s_c` are the same 15 cm there and the
     * ratio cannot move. Flipping this uniform and re-reading the doors receipt
     * is therefore the single cheapest test of whether the merge is real — and
     * it is a UNIFORM, so both arms are one boot and one shader cache.
     */
    // ⚠ SEEDED FROM A GLOBAL so the BISTRO probes can set it. The rig pages
    // take `?perCasc=1`, but `run-gi2-doors-probe` and friends boot the real
    // editor and reach the engine only through `FLAGS={...}` — and the doors
    // receipt is precisely where this tell has to be read.
    wpBiasPerCasc: uniform(globalThis.__gi2BiasPerCasc ?? 0),
    /**
     * ⭐⭐ §19 3.15 — THE COVERAGE AT WHICH A CASCADE CLAIMS THE WHOLE PIXEL.
     *
     * 3.14's hand-off was PROPORTIONAL: a cascade claimed `Σ tri·live`, so a
     * pixel whose c0 corners were 60 % live gave 40 % of itself to c1. That was
     * safe there because every cascade traced to the horizon — c1's answer was
     * complete, merely coarser. Under the interval merge it is NOT: a coarse
     * cascade's map is complete only where a FINER one owns its near band, and
     * near a wall the finer cascade's own corners are exactly what is missing.
     * So the shortfall flowed into a map with a hole in it, and the hole was
     * systematic — the corridor's 15 m crops read 0.35 of the path-traced truth
     * against 3.14's 0.86 on the same geometry.
     *
     * The spec's own words are "the finest cascade that is LIVE at that point",
     * which is a GATE, not a proportion. This is that gate with a soft edge: a
     * cascade with `cov ≥ wpCovFull` takes the pixel outright, below that it
     * ramps. 1.0 is 3.14's proportional hand-off exactly, which is what makes
     * this measurable rather than asserted.
     *
     * ⚠ CONTINUITY IS STILL THE BAND'S JOB, and that is why this is safe: past
     * a lattice's edge `cov` reaches 0 anyway, and `bandAt` has already faded
     * the cascade out over the outer 15 % before it gets there.
     */
    wpCovFull: uniform(0.5),
    /**
     * ⭐⭐⭐ §19 4.12 — THE COVERAGE AT WHICH A CASCADE MAY DEFER ITS NEAR BAND,
     * AND IT IS `wpCovFull`'s TWIN FOR THE SAME REASON. §3.15's ownership rule
     * tested LATTICE CONTAINMENT: a coarse probe whose position falls inside
     * the finer cascade's box hands `[0, t_i)` to it and traces only
     * `[t_i, t_{i+1})`. ⭐⭐ CONTAINMENT IS NOT PAYMENT.
     *
     * ⛔ MEASURED (`probe:gi2-band`, Bistro pose B, HEAD e9ba895): of 697 live
     * c2 probes, 288 are contained by c1's lattice and **166 of those stand
     * where c1's liveness-weighted coverage is below a half** — the deferral is
     * to nobody. At `DARK2` the answering c2 probe (claim 1.00 at the pixel,
     * 2.77 m from it) has a mean first hit at **14.6 m** and **100 % of its
     * directions store radiance exactly zero**, because every one of them hit
     * inside a band it was told it did not own. The pixel reads 0.0028 against
     * a path-traced 0.6377. A wall one metre from that probe is invisible to it.
     *
     * "The finest cascade that is LIVE at that point" is what the spec says
     * about the resolve; the same words decide who owns the near band.
     * `__gi2CovBelow = 0` restores 3.15's containment-only test, which is what
     * makes this an arm rather than a rewrite.
     */
    wpCovBelow: uniform(COV_BELOW),
    /** §19 4.12 — 1 weights a hit by §AG's thin-voxel throughput, 0 is 4.11. */
    wpThinT: uniform(globalThis.__gi2ThinT === 0 ? 0 : 1),
  };
  /** One origin per cascade (i32 cell coords, in that cascade's own spacing). */
  const originsU = Array.from({ length: NC }, () => uniform(new THREE.Vector3()));

  // ── the cascade index, and the compile-time constants it selects ──────────
  const pickF = (cascU, vals) => {
    let node = float(vals[NC - 1]);
    for (let c = NC - 2; c >= 0; c--) node = select(cascU.equal(uint(c)), float(vals[c]), node);
    return node;
  };
  const pickI = (cascU, vals) => {
    let node = int(vals[NC - 1]);
    for (let c = NC - 2; c >= 0; c--) node = select(cascU.equal(uint(c)), int(vals[c]), node);
    return node;
  };
  const pickU = (cascU, vals) => {
    let node = uint(vals[NC - 1]);
    for (let c = NC - 2; c >= 0; c--) node = select(cascU.equal(uint(c)), uint(vals[c]), node);
    return node;
  };
  const pickV = (cascU, nodes) => {
    let node = vec3(nodes[NC - 1]);
    for (let c = NC - 2; c >= 0; c--) node = select(cascU.equal(uint(c)), vec3(nodes[c]), node);
    return node;
  };

  // ── addressing ────────────────────────────────────────────────────────────
  const slotOf = (x, y, z) => bitOr(bitOr(
    bitAnd(x, int(C - 1)).toUint(),
    shiftLeft(bitAnd(y, int(C - 1)).toUint(), uint(CB))),
  shiftLeft(bitAnd(z, int(C - 1)).toUint(), uint(2 * CB)));
  /** Un-torus one axis: the origin says which window the low bits belong to. */
  const unTorus = (bits, o) => o.toInt().add(bitAnd(bits.toInt().sub(o.toInt()), int(C - 1)));
  const infoIdx = (gc, k) => gc.mul(uint(INFO_VEC)).add(uint(k));
  /** SH coefficient `k` — slots 3..11 of the SAME array. See `wpInfo`. */
  const shIdxW = (gc, k) => infoIdx(gc, 3 + k);
  const octIdxW = (gc, texel) => gc.mul(uint(OCT * OCT_W)).add(texel.mul(uint(OCT_W)));
  /**
   * §19 3.16 — the word an EMA is allowed to touch. Under `SPLIT_OWN` it is
   * word 2 (`own`); otherwise it IS word 0, and the merge's in-place algebra
   * (§W.3) is what forces α = 1 there.
   */
  const OWN_W = SPLIT_OWN ? 2 : 0;
  /** The list word `off` inside cascade `casc`'s own run. */
  const listAt = (cascU, off) => wpList.element(cascU.mul(uint(LIST_WORDS)).add(off));
  /**
   * Is this world lattice cell inside that cascade's current window?
   *
   * ⚠ DEFINED HERE, NOT WITH THE RESOLVE'S TAPS, because §19 3.15's merge and
   * seed kernels need it too — a toroidal address that is not first proved to
   * be inside its window aliases onto a cell `C · s_c` metres away, which is up
   * to 256 m at c2 and reads as a perfectly plausible radiance.
   */
  const inLatticeAt = (org, wcx, wcy, wcz) => {
    const rx = wcx.sub(org.x).toVar();
    const ry = wcy.sub(org.y).toVar();
    const rz = wcz.sub(org.z).toVar();
    return rx.greaterThanEqual(0).and(ry.greaterThanEqual(0)).and(rz.greaterThanEqual(0))
      .and(rx.lessThan(C)).and(ry.lessThan(C)).and(rz.lessThan(C));
  };
  /**
   * §19 3.15 — cascade `c`'s PARENT's constants, indexed by `c` so a kernel
   * whose cascade is a runtime value can reach them through the same `pick*`
   * chain everything else uses. The last cascade has no parent and points at
   * itself; every caller checks `c < NC−1` before using these.
   */
  const P_OF = (c) => Math.min(c + 1, NC - 1);
  const SPC_PARENT = Array.from({ length: NC }, (_, c) => SPC[P_OF(c)]);
  const DMAX_PARENT = Array.from({ length: NC }, (_, c) => DMAX[P_OF(c)]);
  const BASE_PARENT = Array.from({ length: NC }, (_, c) => P_OF(c) * CELLS);
  const ORG_PARENT = Array.from({ length: NC }, (_, c) => originsU[P_OF(c)]);
  /** …and its CHILD's, for the interval-start rule (`coveredFromBelow`). */
  const F_OF = (c) => Math.max(c - 1, 0);
  const SPC_FINER = Array.from({ length: NC }, (_, c) => SPC[F_OF(c)]);
  const ORG_FINER = Array.from({ length: NC }, (_, c) => originsU[F_OF(c)]);
  const BASE_FINER = Array.from({ length: NC }, (_, c) => F_OF(c) * CELLS);

  /**
   * §19 4.12 — a lattice's LIVENESS-WEIGHTED TRILINEAR COVERAGE at a world
   * point: `Σ tri · live` over the eight cells around it, which is exactly the
   * number `irradianceAtCasc` normalises by, `parentTap` weights with and the
   * resolve spends as a claim. Isolated here because the trace kernel needs it
   * ~600 lines before either of those exists, and because the ownership rule
   * asking the SAME question as the resolve is the whole point of 4.12.
   *
   * ⚠ EIGHT SCALAR LOADS, NO SH. The coefficients are 9 vec4 per cell and this
   * wants none of them — only `wpInfo[gc].w`, the liveness `allocPass` wrote.
   */
  const latticeCovAt = (base, sp, org, p) => {
    const g = p.div(sp).sub(0.5).toVar();
    const b = g.floor().toVar();
    const fr = g.sub(b).toVar();
    const cov = float(0).toVar();
    for (let c8 = 0; c8 < 8; c8++) {
      const dx = c8 & 1;
      const dy = (c8 >> 1) & 1;
      const dz = (c8 >> 2) & 1;
      const rx = b.x.add(dx).toVar();
      const ry = b.y.add(dy).toVar();
      const rz = b.z.add(dz).toVar();
      const cell = slotOf(rx.toInt(), ry.toInt(), rz.toInt()).add(base).toVar();
      const ok = inLatticeAt(org, rx, ry, rz)
        .and(wpInfo.element(infoIdx(cell, 0)).w.greaterThan(0.5));
      const tri = (dx ? fr.x : float(1).sub(fr.x))
        .mul(dy ? fr.y : float(1).sub(fr.y))
        .mul(dz ? fr.z : float(1).sub(fr.z));
      cov.addAssign(select(ok, tri, float(0)));
    }
    return cov;
  };

  // ── window reads ──────────────────────────────────────────────────────────
  const viOf = (x, y, z) => bitOr(bitOr(
    bitAnd(x, int(N - 1)).toUint(),
    shiftLeft(bitAnd(y, int(N - 1)).toUint(), uint(6))),
  shiftLeft(bitAnd(z, int(N - 1)).toUint(), uint(12)));
  const occAt = (levelU, viU) => bitAnd(
    win.buffer.element(levelU.mul(uint(LEVEL_WORDS)).add(uint(OCC_OFF)).add(shiftRight(viU, uint(5)))),
    shiftLeft(uint(1), bitAnd(viU, uint(31))),
  ).notEqual(uint(0));
  const brickSet = (levelU, bx, by, bz) => {
    const b = bitOr(bitOr(
      bitAnd(bx, int(15)).toUint(),
      shiftLeft(bitAnd(by, int(15)).toUint(), uint(4))),
    shiftLeft(bitAnd(bz, int(15)).toUint(), uint(8))).toVar();
    return bitAnd(
      win.buffer.element(levelU.mul(uint(LEVEL_WORDS)).add(uint(BMASK_OFF)).add(shiftRight(b, uint(5)))),
      shiftLeft(uint(1), bitAnd(b, uint(31))),
    ).notEqual(uint(0));
  };
  /**
   * The finest window level ≥ `lminI` whose 64-cell window contains `p`, and
   * whether ANY level qualified.
   *
   * ⭐⭐ "NO LEVEL CONTAINS IT" IS A DIFFERENT ANSWER FROM "THE LAST LEVEL", and
   * `cellOfWorld` cannot tell them apart — it falls back to `levels − 1` and
   * the toroidal address then aliases onto a cell 128 m away. Cascade 0 lives
   * inside L0 by construction so 3.13 never met the case; cascade 2 reaches
   * 256 m and meets it on every `high` boot. A cell whose occupancy cannot be
   * read holds NO probe, which is the only honest answer and also the cheap one.
   */
  const levelAtLeast = (p, lminI) => {
    const level = int(win.levels - 1).toVar();
    const found = float(0).toVar();
    for (let l = win.levels - 1; l >= 0; l--) {
      const rel = p.div(v0 * 2 ** l).floor().sub(win.originAt(int(l))).toVar();
      const ok = rel.x.greaterThanEqual(0).and(rel.y.greaterThanEqual(0)).and(rel.z.greaterThanEqual(0))
        .and(rel.x.lessThan(N)).and(rel.y.lessThan(N)).and(rel.z.lessThan(N))
        .and(int(l).greaterThanEqual(lminI)).toVar();
      level.assign(select(ok, int(l), level));
      found.assign(select(ok, float(1), found));
    }
    return { level, found };
  };

  // ── the oct texel's two words ─────────────────────────────────────────────
  const encodeRgbe = (rgb) => {
    const m = max(max(rgb.x, rgb.y), rgb.z).max(1e-8).toVar();
    const e = ceil(log2(m)).clamp(-127, 127).toVar();
    const s = float(255).div(exp2(e)).toVar();
    const q = (v) => v.mul(s).add(0.5).floor().clamp(0, 255).toUint();
    return bitOr(
      bitOr(q(rgb.x), shiftLeft(q(rgb.y), uint(8))),
      bitOr(shiftLeft(q(rgb.z), uint(16)), shiftLeft(e.add(128).toUint(), uint(24))),
    );
  };
  const decodeRgbe = (word) => {
    const e = shiftRight(word, uint(24)).toFloat().sub(128).toVar();
    const s = exp2(e).div(255).toVar();
    return vec3(
      bitAnd(word, uint(255)).toFloat().mul(s),
      bitAnd(shiftRight(word, uint(8)), uint(255)).toFloat().mul(s),
      bitAnd(shiftRight(word, uint(16)), uint(255)).toFloat().mul(s),
    );
  };
  // ⭐ THE MOMENTS ARE IN UNITS OF THE CASCADE'S OWN SPACING. `dmax` is
  // `DIST_CELLS · s_c` — a compile-time float on the resolve's side (the
  // cascade is a JS loop index there) and a three-way select on the trace's.
  const quantD = (d, dmax) => d.div(dmax).clamp(0, 1).mul(DQ).add(0.5).floor().toUint();
  /**
   * ⭐⭐ THE TRANSMITTANCE IS ONE BIT AND IT COST NOTHING. `n` was declared 8
   * bits at 24 and then written `.min(uint(63))` — six bits of payload in an
   * eight-bit field, so bits 30 and 31 have been free since 3.13. `T` goes at
   * 30, which is why `nOf` now MASKS instead of shifting: a raw `w >> 24` would
   * have read `n + 64` on every transparent texel and every `n > 0` test in the
   * file would have kept working, silently, while `n` itself became garbage.
   */
  const T_BIT = 1 << 30;
  const packMoments = (nU, meanF, rmsF, dmax, tU = null) => bitOr(
    bitOr(shiftLeft(nU.min(uint(63)), uint(24)), shiftLeft(quantD(rmsF, dmax), uint(12))),
    tU === null ? quantD(meanF, dmax) : bitOr(quantD(meanF, dmax), shiftLeft(tU, uint(30))),
  );
  const meanOf = (w, dmax) => bitAnd(w, uint(DQ)).toFloat().mul(dmax).div(DQ);
  const rmsOf = (w, dmax) => bitAnd(shiftRight(w, uint(12)), uint(DQ)).toFloat().mul(dmax).div(DQ);
  const nOf = (w) => bitAnd(shiftRight(w, uint(24)), uint(63));
  /** 1 = this direction ESCAPED its interval, so the parent's map applies. */
  const tOf = (w) => bitAnd(shiftRight(w, uint(30)), uint(1));
  /**
   * ⭐⭐⭐ §19 4.14 — BIT 31, THE LAST FREE ONE: THIS DIRECTION WAS BLOCKED
   * BEFORE THE PROBE'S OWN BAND EVEN STARTED.
   *
   * `blockedNear` has been computed in the trace since 3.15 and thrown away
   * three lines later. It is the difference between the two ways a texel can
   * hold radiance 0:
   *
   *   · `T = 1`, a CLEAN MISS — "nothing in my band, ask my parent", and the
   *     merge does exactly that, so the texel ends up carrying real light;
   *   · `T = 0` with this bit — OPAQUE BEFORE MY BAND. The parent must not be
   *     asked (that would be the leak one level up) and this cascade has
   *     nothing of its own. The texel is a measured, permanent zero.
   *
   * A probe ALL of whose texels are the second kind has no data at all, and
   * §AJ measured what that costs: in the user's 5 m Cornell box, c2's band is
   * 20–100 m, every one of its rays is blocked at ~2 m, its field is
   * identically zero — and the resolve still hands it 35–38 % of the pixel,
   * dragging 0.49 to 0.003. 667 black pixels, all of them exactly there.
   */
  const bnOf = (w) => bitAnd(shiftRight(w, uint(31)), uint(1));
  /** The same word with `T` cleared — the merge's idempotence (see `mergeFor`). */
  const clearT = (w) => bitAnd(w, uint((~T_BIT) >>> 0));
  /**
   * §19 4.14 — the `ready` ladder's fourth rung, and it sits BELOW every gate.
   *
   * `ready` was three-valued: 0 re-keyed, 0.5 seeded, 1 traced, and everything
   * that asks "is this probe worth reading" asks `> 0.25`. A probe that traced
   * and measured NOTHING IN ITS OWN BAND now writes 0.2 instead of 1, so the
   * resolve's `alive`, `parentTap`'s gate and `seedPass`'s parent test all say
   * no WITHOUT ONE OF THEM BEING EDITED — the claim it forfeits is redistributed
   * to the cascades that did measure the band, which is what makes the fix
   * energy-preserving rather than a subtraction.
   *
   * ⚠ AND IT IS NOT A DEATH. `allocPass` still lists the cell, so the probe
   * traces again on its next turn and `shPass` writes 1 the moment one ray
   * lands inside the band. Nothing here is remembered longer than one round.
   */
  const READY_EMPTY = 0.2;
  /**
   * ⛔ §19 4.14 — BUILT AND **DEFAULT-OFF**, because the only instrument that
   * can see it cannot arbitrate it today. `__gi2CascData = 1` compiles it.
   *
   * `probe:gi2-cornell` on the user's `Cornel.scene`, EIGHT alternating boots
   * on a still tree (`gatherProbes.js` md5 identical before and after all
   * eight), black census:
   *
   *     off  691   685  8566  8598
   *     on   684  4643   691  8598
   *
   * **The scene converges to one of two fixed points and the flag has nothing
   * to do with which.** §AJ's own nine-arm sweep read 621–674 with no collapse
   * at all, so the bimodality is newer than §AJ and is not this unit's: it
   * shows in the OFF arm too. Until the gate is single-valued, every
   * single-boot A/B on it — including the pair that appeared to prove this unit
   * works (8595 → 872) and the pair that appeared to prove it harms
   * (683 → 8597) — is a statement about which mode the boot landed in.
   * [[probe-blind-statistics]]
   */
  const CASC_DATA = (globalThis.__gi2CascData ?? 0) !== 0;

  // ══════════════════════════════════════════ SHADER: probeAlloc (§U.1)
  //
  // One thread per (CASCADE, LATTICE CELL). Decides, from the window's own
  // occupancy, whether this cell holds a live probe; where that probe stands;
  // and which face (if any) it represents. Everything it writes is a pure
  // function of (cascade, cell, origin, occupancy) — run it twice on one frame
  // and it writes the same bytes, which is what lets it run every frame instead
  // of maintaining state nobody can audit.
  const allocPass = LEAN ? null : Fn(() => {
    const gc = instanceIndex.toVar();
    const casc = shiftRight(gc, uint(CELLB)).toVar();
    const cell = bitAnd(gc, uint(CELLS - 1)).toVar();
    const cx = bitAnd(cell, uint(C - 1)).toInt().toVar();
    const cy = bitAnd(shiftRight(cell, uint(CB)), uint(C - 1)).toInt().toVar();
    const cz = bitAnd(shiftRight(cell, uint(2 * CB)), uint(C - 1)).toInt().toVar();
    const sp = pickF(casc, SPC).toVar();
    const lmin = pickI(casc, LMIN).toVar();
    const o = pickV(casc, originsU).toVar();
    const wc = vec3(
      unTorus(cx, o.x).toFloat(), unTorus(cy, o.y).toFloat(), unTorus(cz, o.z).toFloat(),
    ).toVar();
    const p = wc.add(0.5).mul(sp).toVar();

    // §U.4: a scroll re-keys the entering slab. The slot keeps its memory only
    // while it keeps its identity — `stored != wc` is the whole test, and a
    // fresh probe then takes α = 1 on its first update.
    const prev2 = wpInfo.element(infoIdx(gc, 2)).toVar();
    const same = prev2.x.equal(wc.x).and(prev2.y.equal(wc.y)).and(prev2.z.equal(wc.z)).toVar();
    const ready = select(same, prev2.w, float(0)).toVar();

    const dead = () => {
      listAt(casc, uint(FLAG_OFF).add(cell)).assign(uint(0));
      wpInfo.element(infoIdx(gc, 0)).assign(vec4(p, 0));
      wpInfo.element(infoIdx(gc, 1)).assign(vec4(0, 1, 0, 0));
      wpInfo.element(infoIdx(gc, 2)).assign(vec4(wc, 0));
    };

    // The level this cascade reads its occupancy from. A cell no level can
    // answer for is DEAD, not aliased — see `levelAtLeast`.
    const la = levelAtLeast(p, lmin);
    If(la.found.lessThan(0.5), () => { dead(); Return(); });
    const lvl = la.level.toVar();
    const lvlU = lvl.toUint().toVar();
    const vl = float(v0).mul(exp2(lvl.toFloat())).toVar();
    // The window cells the probe cell spans, dilated by one (§U.1's "±1 cell").
    // `s_c / v_l = 2` on every cascade by `LMIN`'s construction, so the span is
    // always 2 cells and the dilated scan is always 4³.
    const c0 = p.sub(sp.mul(0.5)).div(vl).floor().sub(1).toVar();

    // ── the cheap rejection: the 2×2×2 BRICKS around the dilated span ───────
    //
    // A lattice is mostly empty. Eight brickMask bits kill an air cell before
    // the 64-cell occupancy scan is ever entered, and on a sealed Cornell room
    // that is ~89 % of the lattice paying eight reads instead of sixty-four.
    const bb = c0.div(4).floor().toVar();
    const anyBrick = float(0).toVar();
    Loop({ start: 0, end: 8, name: "wpBrick" }, ({ wpBrick }) => {
      const k = uint(wpBrick).toVar();
      const bx = bb.x.toInt().add(bitAnd(k, uint(1)).toInt()).toVar();
      const by = bb.y.toInt().add(bitAnd(shiftRight(k, uint(1)), uint(1)).toInt()).toVar();
      const bz = bb.z.toInt().add(shiftRight(k, uint(2)).toInt()).toVar();
      If(brickSet(lvlU, bx, by, bz), () => { anyBrick.assign(1); Break(); });
    });
    If(anyBrick.lessThan(0.5), () => { dead(); Return(); });

    // ── the real test: any occupied voxel in the dilated span ──────────────
    const live = float(0).toVar();
    Loop({ start: 0, end: 64, name: "wpOcc" }, ({ wpOcc }) => {
      const k = uint(wpOcc).toVar();
      const vi = viOf(
        c0.x.toInt().add(bitAnd(k, uint(3)).toInt()),
        c0.y.toInt().add(bitAnd(shiftRight(k, uint(2)), uint(3)).toInt()),
        c0.z.toInt().add(shiftRight(k, uint(4)).toInt()),
      ).toVar();
      If(occAt(lvlU, vi), () => { live.assign(1); Break(); });
    });
    If(live.lessThan(0.5), () => { dead(); Return(); });

    // ── the probe's own point: the cell centre, escaped out of geometry ─────
    //
    // §U.1's "pushed out by the origin-escape rule along the dominant normal".
    // The face comes from the voxel's own dominant axis (§19 3.9's bits, the
    // producer that actually saw the triangles), the SIDE from whichever
    // neighbour is empty, and the hint — for the case where neither or both are
    // — is a fixed +1 vector, because a probe's escape must not depend on which
    // ray asked.
    const pos = p.toVar();
    const faceN = vec3(0, 1, 0).toVar();
    const state = float(1).toVar();
    const centre = cellOfWorld(p);
    If(occAt(centre.level.toUint(), centre.vi), () => {
      const faceF = dominantFace(
        centre.level.toFloat(), centre.vi.toFloat(), float(0), vec3(1, 1, 1),
      ).toVar();
      const nn = normalOfFace(faceF).toVar();
      faceN.assign(nn);
      state.assign(0);
      // ⭐⭐⭐ §19 3.16 FIX 1 — AN ESCAPE BUDGET IN VOXELS IS A DISPLACEMENT IN
      // METRES, AND AT c2 THAT IS FOURTEEN OF THEM.
      //
      // The rule below it (3.13's, kept verbatim for cascade 0) walks the cell
      // centre along its dominant normal in whole cells OF THE ORIGIN'S OWN
      // WINDOW LEVEL. `LMIN` ties that level to the cascade's spacing, so the
      // step is `v_l = s_c / 2`: 0.125 m at c0, 1 m at c1, **4 m at c2**, and
      // three of them is 14 m. ⛔ MEASURED, not argued: the corridor's 30 m
      // crops read 2.93× a path-traced truth on BOTH world arms (§W.6), and the
      // mechanism is a c2 probe pushed clean through the building's wall into
      // the SUNLIT EXTERIOR, where it measures the exterior and hands it back
      // down the merge as the interior's far field.
      //
      // ⭐⭐ A PROBE IS ITS CELL'S REPRESENTATIVE, SO ITS PLACEMENT MUST STAY
      // INSIDE ITS CELL. That is the whole rule, and it is not a smaller
      // budget — a budget in the same units would be 4 m at c2 and 0.125 m at
      // c0, i.e. the same mistake divided. The search is over the FINER
      // cascade's cells inside this one (`s_c / RATIO`: 0.5 m at c1, 2 m at
      // c2), the 3³ neighbourhood of the centre, nearest first, deterministic:
      // z outer, y, x inner, strict `<` on the squared offset, so ties break by
      // that order and two frames with the same occupancy place the probe at
      // the same point. Max displacement is `√3 · s_c/RATIO = 0.43 · s_c`,
      // inside the cell on every axis and — the receipt — never as much as one
      // whole cell. Nothing free in the 3³ means the cell is BURIED and holds
      // NO probe, which is 3.13's own answer to the same question.
      //
      // ⚠ AND THE FACE FOLLOWS THE MOVE. `faceN` is the hemisphere the probe
      // owns; under the old rule it was the escape direction by construction
      // (the walk WAS along `nn`). A lateral placement keeps that invariant
      // only if the face is re-read from the offset actually taken, or the
      // probe spends its rays on the half it moved away from.
      // Whole cells of the ORIGIN's own level, up to the trace's own escape
      // budget. Beyond that the cell is buried and holds no probe: a probe
      // inside a solid is the classic lattice leak, and refusing to place one
      // is cheaper and safer than any weight that tries to discount it.
      const escapeAlongNormal = (dir, nm) => {
        Loop({ start: 1, end: 4, name: nm }, ({ [nm]: kk }) => {
          const q = p.add(dir.mul(vl.mul(float(kk).add(0.5)))).toVar();
          const qc = cellOfWorld(q);
          If(occAt(qc.level.toUint(), qc.vi).not(), () => {
            pos.assign(q);
            state.assign(2);
            Break();
          });
        });
      };
      const placeInsideCell = (sf) => {
        const best = float(1e9).toVar();
        Loop({ start: 0, end: 3, name: "wpPlaceZ" }, ({ wpPlaceZ }) => {
          const oz = float(wpPlaceZ).sub(1).toVar();
          Loop({ start: 0, end: 3, name: "wpPlaceY" }, ({ wpPlaceY }) => {
            const oy = float(wpPlaceY).sub(1).toVar();
            Loop({ start: 0, end: 3, name: "wpPlaceX" }, ({ wpPlaceX }) => {
              const ox = float(wpPlaceX).sub(1).toVar();
              const off = vec3(ox, oy, oz).toVar();
              const d2 = dot(off, off).toVar();
              // `> 0.5` skips the centre (known occupied); `< best` is both the
              // nearest-first rule and the early-out that keeps this ~8 reads.
              If(d2.greaterThan(0.5).and(d2.lessThan(best)), () => {
                const q = p.add(off.mul(sf)).toVar();
                const qc = cellOfWorld(q);
                If(occAt(qc.level.toUint(), qc.vi).not(), () => {
                  best.assign(d2);
                  pos.assign(q);
                  faceN.assign(off.div(sqrt(d2).max(1e-6)));
                  state.assign(2);
                });
              });
            });
          });
        });
      };
      /**
       * ⭐⭐⭐ §19 4.9 — CASCADE 0's ESCAPE IS THREE RULES NOW, AND THE USER SAW
       * WHY IN ONE SCREENSHOT.
       *
       * The `src-probes` view of a Bistro façade showed c0's 0.5 m cells as a
       * PATCHWORK: scattered light-blue (c0-owned) cells with green (c1-owned)
       * gaps between them on ONE FLAT WALL. A gap is a cell `allocPass` marked
       * DEAD, and the resolve's `cov = Σ tri·live` then hands that pixel to the
       * 2 m cascade while its neighbour keeps the 0.5 m one — two different
       * answers, cell to cell, along a surface that is one plane. That is
       * §AE's per-pixel bimodality (0.028 against 0.725 on a 35 cm patch) seen
       * directly, and it is not a weight problem: the weights are trilinear and
       * smooth. It is a PRESENCE BIT that flips.
       *
       * ⭐⭐ AND THE BIT FLIPS ON A COIN. The rule (3.13's, kept verbatim for c0
       * while 3.16 moved the coarse cascades to an in-cell search) walks the
       * cell centre along `nn` — `dominantFace`'s normal, whose SIDE comes from
       * "whichever neighbour is empty" and, when neither or both are, from a
       * fixed `+1` hint. On a wall facing −X that hint is simply WRONG, the
       * walk goes deeper into the geometry, three steps of `v_l` find nothing,
       * and the cell is buried. Which voxels hit the ambiguous case is a
       * property of the local occupancy — so it alternates along the wall, and
       * so does the lattice.
       *
       * So c0 now tries, in order and STOPPING AT THE FIRST SUCCESS:
       *   1. `+nn`, exactly as before — every cell that placed yesterday places
       *      at the same point today, so this cannot move any probe that
       *      already worked. The receipts of §V..§AD stand.
       *   2. `−nn`, which is the coin landing the other way and costs three
       *      reads on the cells that failed.
       *   3. the 3³ in-cell search at the WINDOW VOXEL step — 3.16's rule, at
       *      c0's own scale, so the displacement bound is `√3·v_l = 0.43·s_0`,
       *      the same "inside its own cell" guarantee the coarse cascades get.
       * A cell that fails all three really is buried deeper than half a cell in
       * every direction, and refusing to place a probe inside a solid is still
       * the right answer.
       */
      const c0Escape = () => {
        escapeAlongNormal(nn, "wpEscape");
        If(state.lessThan(1.5), () => {
          escapeAlongNormal(nn.negate(), "wpEscapeBack");
          If(state.lessThan(1.5), () => { placeInsideCell(vl); });
        });
      };
      if (!PLACE_IN_CELL || NC === 1) c0Escape();
      else If(casc.equal(uint(0)), c0Escape).Else(() => placeInsideCell(pickF(casc, SPC_FINER).toVar()));
      // ⭐ THE RECEIPT, AND IT IS TAKEN AFTER THE BRANCH SO BOTH ARMS ARE
      // MEASURED BY THE SAME INSTRUMENT. `wpCoarseMoved` counts every relocated
      // coarse probe; `wpCoarseFar` counts those that ended up further than ONE
      // OF THEIR OWN CELLS from the centre they represent — 3.15's escape rule
      // could reach 3.5 · s_c/2 = 1.75 cells (14 m at c2), the in-cell search
      // 0.43. A census inside the `else` would only ever have been able to
      // report the arm that cannot fail.
      If(casc.greaterThan(uint(0)).and(state.greaterThan(1.5)), () => {
        const off = pos.sub(p).abs().toVar();
        bump(STATS.wpCoarseMoved, cell);
        If(off.length().greaterThan(sp), () => { bump(STATS.wpCoarseFar, cell); });
        If(max(max(off.x, off.y), off.z).greaterThan(sp.mul(0.5)), () => {
          bump(STATS.wpCoarseOut, cell);
        });
      });
      If(state.lessThan(0.5), () => { dead(); Return(); });
    });

    listAt(casc, uint(FLAG_OFF).add(cell)).assign(uint(1));
    wpInfo.element(infoIdx(gc, 0)).assign(vec4(pos, state));
    wpInfo.element(infoIdx(gc, 1)).assign(vec4(faceN, 0));
    wpInfo.element(infoIdx(gc, 2)).assign(vec4(wc, ready));
  })().compute(ALL_CELLS);

  // ══════════════════════════════════ SHADERS: the compaction (count/scan/fill)
  //
  // A deterministic, atomic-free prefix sum, run once PER CASCADE inside the
  // same three dispatches. `countPass` is one thread per 256-cell block of one
  // cascade; `scanPass` is ONE THREAD PER CASCADE over its own block counts;
  // `fillPass` is one thread per block again, writing its own contiguous run.
  // Nothing races, so each list is a pure function of its flags — which is what
  // makes "which probes update this frame" a pure function of the frame index
  // and therefore makes a parked camera byte-identical (§T).
  const countPass = LEAN ? null : Fn(() => {
    const gb = instanceIndex.toVar();
    const casc = gb.div(uint(BLOCKS)).toVar();
    const b = gb.sub(casc.mul(uint(BLOCKS))).toVar();
    const base = b.mul(uint(BLOCK)).toVar();
    const n = uint(0).toVar();
    Loop({ start: 0, end: BLOCK, name: "wpCount" }, ({ wpCount }) => {
      n.addAssign(listAt(casc, uint(FLAG_OFF).add(base).add(uint(wpCount))));
    });
    listAt(casc, uint(BASE_OFF).add(b)).assign(n);
  })().compute(BLOCKS * NC);

  const scanPass = LEAN ? null : Fn(() => {
    const casc = instanceIndex.toVar();
    const run = uint(0).toVar();
    Loop({ start: 0, end: BLOCKS, name: "wpScan" }, ({ wpScan }) => {
      const i = uint(BASE_OFF).add(uint(wpScan)).toVar();
      const c = listAt(casc, i).toVar();
      listAt(casc, i).assign(run);
      run.addAssign(c);
    });
    listAt(casc, uint(CTL_OFF)).assign(run);
  })().compute(NC);

  const fillPass = LEAN ? null : Fn(() => {
    const gb = instanceIndex.toVar();
    const casc = gb.div(uint(BLOCKS)).toVar();
    const b = gb.sub(casc.mul(uint(BLOCKS))).toVar();
    const base = b.mul(uint(BLOCK)).toVar();
    const w = listAt(casc, uint(BASE_OFF).add(b)).toVar();
    Loop({ start: 0, end: BLOCK, name: "wpFill" }, ({ wpFill }) => {
      const cell = base.add(uint(wpFill)).toVar();
      If(listAt(casc, uint(FLAG_OFF).add(cell)).greaterThan(uint(0)), () => {
        listAt(casc, uint(LIST_OFF).add(w)).assign(cell);
        w.addAssign(uint(1));
      });
    });
  })().compute(BLOCKS * NC);

  // ── the round-robin (§U.2), one phase per cascade ─────────────────────────
  //
  // Trace slot `k` belongs to the cascade whose `[SLOT_BASE, +SLOTS)` range
  // holds it — a compile-time partition, and every `SLOTS[c]` is a multiple of
  // the trace kernel's 8-wide x dimension, so no workgroup straddles two
  // cascades.
  //
  // Frame `f` updates cascade `c`'s `SLOTS[c]` list entries starting at
  // `f·SLOTS[c] mod live_c`. Every live probe of that cascade is therefore
  // updated exactly once every `ceil(live_c / SLOTS[c])` frames, and WHICH
  // probes update on which frame is a function of the frame index alone. The
  // coarse cascades hold a tenth of the slots, so they cycle a seventh as
  // often as the finest — the cadence RC's law asks for, expressed as a budget
  // split rather than as a rule some kernel has to remember.
  const umod = (a, b) => a.sub(a.div(b).mul(b));
  const cascOfSlot = (k) => {
    let node = uint(NC - 1);
    for (let c = NC - 2; c >= 0; c--) {
      node = select(k.lessThan(uint(SLOT_BASE[c] + SLOTS[c])), uint(c), node);
    }
    return node.toVar();
  };
  const roundRobin = (k) => {
    const casc = cascOfSlot(k);
    const kLocal = k.sub(pickU(casc, SLOT_BASE)).toVar();
    const live = listAt(casc, uint(CTL_OFF)).max(uint(1)).toVar();
    const base = umod(u.frame.mul(pickU(casc, SLOTS)), live).toVar();
    return { casc, kLocal, live, idx: umod(base.add(kLocal), live) };
  };
  /** The GLOBAL cell of the probe trace slot `k` is scheduled to update. */
  const slotCell = (rr) => rr.casc.mul(uint(CELLS))
    .add(listAt(rr.casc, uint(LIST_OFF).add(rr.idx)));

  /**
   * ⭐⭐ §19 STAGE 3.17 — CASCADE `ccU`'s IRRADIANCE AT A WORLD POINT, FOR A
   * NORMAL. What a COLD HIT is paid instead of black (`hitRadiance`'s
   * `unlitFallback`, and the whole reason `__gi2Reach` can ship on).
   *
   * interp8 of the cascade's own SH2, weighted by trilinear × LIVENESS and by
   * nothing else — the same rule and the same argument as `parentTap`: this is
   * "what does the field look like around here", not "can you see me". The
   * caller is a RAY that has already established line of sight to the hit, so a
   * second visibility test here would discount the one thing that is known.
   *
   * ⚠ NORMALISED BY `wsum`, unlike the resolve's accumulation: the resolve
   * spends a per-cascade claim and blends cascades against each other, this is
   * a single cascade answering alone, and an unnormalised sum over partly-dead
   * corners would read as darkness at exactly the lattice edges where the far
   * field lives. Zero live corners returns black, which is the honest answer —
   * and where it happens the trace's own `select` has already preferred the
   * fresh shade.
   *
   * ⚠ DEFINED HERE, NOT WITH THE RESOLVE'S TAPS, because the trace kernel is
   * built ~700 lines before them and a `const` arrow would be in its temporal
   * dead zone. It uses only the addressing primitives above.
   */
  const irradianceAtCasc = (ccU, p, n) => {
    const sp = pickF(ccU, SPC).toVar();
    const org = pickV(ccU, originsU).toVar();
    const base = ccU.mul(uint(CELLS)).toVar();
    const g = p.div(sp).sub(0.5).toVar();
    const b = g.floor().toVar();
    const f = g.sub(b).toVar();
    const L = [];
    for (let i = 0; i < 9; i++) L.push(vec3(0).toVar());
    const wsum = float(0).toVar();
    for (let c8 = 0; c8 < 8; c8++) {
      const dx = c8 & 1;
      const dy = (c8 >> 1) & 1;
      const dz = (c8 >> 2) & 1;
      const wcx = b.x.add(dx).toVar();
      const wcy = b.y.add(dy).toVar();
      const wcz = b.z.add(dz).toVar();
      const tri = (dx ? f.x : float(1).sub(f.x))
        .mul(dy ? f.y : float(1).sub(f.y))
        .mul(dz ? f.z : float(1).sub(f.z)).toVar();
      // The address is always in range (`slotOf` masks each axis), so the eight
      // reads are unconditional and the WINDOW test is a weight — the idiom
      // `windowTrace` spells out, and the one that does not branch a buffer
      // read into a dead lane.
      const gc = slotOf(wcx.toInt(), wcy.toInt(), wcz.toInt()).add(base).toVar();
      const ok = inLatticeAt(org, wcx, wcy, wcz)
        .and(wpInfo.element(infoIdx(gc, 0)).w.greaterThan(0.5)).toVar();
      const w = select(ok, tri, float(0)).toVar();
      for (let i = 0; i < 9; i++) L[i].addAssign(wpInfo.element(shIdxW(gc, i)).xyz.mul(w));
      wsum.addAssign(w);
    }
    const inv = float(1).div(wsum.max(1e-5)).toVar();
    for (let i = 0; i < 9; i++) L[i].mulAssign(inv);
    return select(wsum.greaterThan(1e-5), shEval(L, n), vec3(0));
  };
  /** Cascade `c`'s PARENT index as a runtime pick — the last cascade is its own. */
  const P_INDEX = Array.from({ length: NC }, (_, c) => P_OF(c));

  // ══════════════════════════════════════════ SHADER: worldProbeTrace (§U.2)
  //
  // One thread per (batch slot, oct texel). The direction is `octU`'s texel
  // CENTRE — the same table the SH projection uses, the same 64 directions this
  // probe traced last time and will trace next time. Nothing here is a function
  // of the camera.
  //
  // ⭐ K.4's HAND-OFF IS WHY A COARSE PROBE NEEDS NO NEW TRACE CODE. A ray
  // leaving an 8 m probe starts at the finest window level containing its
  // origin and steps UP a level whenever it leaves that level's window, so it
  // is already walking L3/L4's metre-scale voxels by the time it is forty
  // metres out. The cascade decides where probes STAND; the window decides what
  // a ray sees, at the resolution the distance deserves.
  const tracePass = LEAN ? null : Fn(() => {
    const k = globalId.x.toVar();
    const texel = globalId.y.toVar();
    If(texel.greaterThanEqual(uint(OCT)), () => { Return(); });
    If(k.greaterThanEqual(uint(TRACE_SLOTS)), () => { Return(); });
    const rr = roundRobin(k);
    If(rr.kLocal.greaterThanEqual(rr.live), () => { Return(); });
    const gc = slotCell(rr).toVar();
    const dmax = pickF(rr.casc, DMAX).toVar();
    const i0 = wpInfo.element(infoIdx(gc, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });
    const pos = i0.xyz.toVar();
    const faced = i0.w.greaterThan(1.5).toVar();
    const faceN = wpInfo.element(infoIdx(gc, 1)).xyz.toVar();
    // ⚠ `< 0.75`, NOT `< 0.5` — a SEEDED probe (`ready = 0.5`) has never traced.
    // Its map is its parent's MERGED field, so blending a first trace against
    // it would fold the far chain into `own` and the merge would add it again.
    // Under `SPLIT_OWN` that is the one place the split could leak the very
    // double-count it exists to avoid; under the in-place merge α is 1 and this
    // is inert, so it is safe to state once for both.
    const fresh = wpInfo.element(infoIdx(gc, 2)).w.lessThan(0.75).toVar();

    const dir = octU.element(texel).xyz.toVar();
    const addr = octIdxW(gc, texel).toVar();
    // A FACED probe owns one hemisphere; the back half is a HOLE, not a black
    // sample, and it is written rather than skipped for the reason
    // `probeTracePass` gives: a slot this kernel returns from early would hold
    // whatever it held before the cell was re-keyed.
    If(faced.and(dot(dir, faceN).lessThanEqual(0.02)), () => {
      wpOct.element(addr).assign(uint(0));
      wpOct.element(addr.add(uint(1))).assign(uint(0));
      if (SPLIT_OWN) wpOct.element(addr.add(uint(2))).assign(uint(0));
      Return();
    });

    // The bias/escape normal: the face for a faced probe, the ray's own
    // direction for an open-air one (which is what `traceWindow`'s continuation
    // path already does — walk the origin FORWARD out of any dilated shell).
    bump(STATS.raysLaunched, k);
    bump(STATS.raysTraced, k);

    // ══ §19 STAGE 3.15 — THE RAY IS INTERVAL-LIMITED ═════════════════════════
    //
    // `[t_i, t_{i+1})`, with `t_0 = 0` so the finest cascade keeps 3.13's origin
    // escape verbatim and every coarser one starts in the air `t_i` metres out.
    //
    // ⚠ AND THAT ADVANCED ORIGIN IS ALLOWED TO BE INSIDE A WALL. It looks like
    // a leak and it is the opposite: if something blocks this direction before
    // `t_i`, the FINER cascade's own texel recorded `T = 0` there, and the merge
    // multiplies this cascade's whole contribution by it. A coarse ray that
    // starts buried is masked out by construction, so the trace does not have to
    // know — which is exactly the property "pick the finest cascade that covers
    // you" did not have, and why one bias constant could move both ends of the
    // scene in 3.14.
    //
    // ⭐⭐⭐ AND THE START IS `t_i` ONLY WHERE A FINER CASCADE EXISTS TO OWN THE
    // NEAR BAND. THIS IS THE ONE PLACE RC'S RULE CANNOT BE COPIED VERBATIM, AND
    // THE CORRIDOR RECEIPT IS WHAT SAID SO.
    //
    // RC's interval decomposition rests on an assumption this lattice cannot
    // meet: that CASCADE 0 COVERS THE WHOLE DOMAIN. Sannikov's c0 is a grid over
    // the entire scene, so `[0, t_1)` is always somebody's job. Here the
    // cascades are a CLIPMAP — c0 is 16 m of camera-centred lattice — and a
    // surface fifty metres down a corridor has no c0, no c1, and therefore
    // nobody to carry its first ten metres of light. The panel five metres from
    // that surface falls into the gap.
    //
    // ⛔ MEASURED, NOT ARGUED: with the textbook rule, the corridor's 50 m crops
    // read **0.0000** against a path-traced 1.79 — the far field went BLACK, and
    // 3.14's over-bright 0.21 was the better answer. The interval that no
    // cascade owns is light that is silently dropped, which is precisely the gap
    // `srcConfig.intervalBoundaries` was written to make impossible one
    // architecture ago.
    //
    // So: cascade `i` traces `[t_i, t_{i+1})` where cascade `i−1`'s lattice
    // contains its probe, and `[0, t_{i+1})` where it does not. The lattices are
    // camera-centred and each is 4× the last, so containment is monotone in `i`
    // — "c_{i−1} does not have me" means no finer cascade does, and this one
    // must carry the near band itself. Nothing double-counts: a cascade's merge
    // reads parent probes AT ITS OWN PROBE'S POSITION, so a parent read through
    // the merge is by construction covered from below and using `t_{i+1}`.
    //
    // ⚠ THE ONE IMPRECISION IS A SHELL ONE CELL THICK. A c0 probe on the very
    // face of its lattice can interpolate a c1 probe just outside it, which
    // traced from 0 and therefore double-counts `[0, 2)` — at a probe whose
    // `bandAt` weight is already 0. The alternative (dilating the test) moves
    // the same error to pixels in the hand-off band, where c0 dominates. Both
    // are ~zero-weighted; this one is one line shorter.
    //
    // ⭐ AND IT CLOSES THE VISIBILITY HOLE FOR FREE. A probe that traces from 0
    // records a first-hit distance from 0, so `octTapVisAt`'s Chebyshev test has
    // real near-field moments at exactly the probes a fall-through pixel reads.
    // Under the textbook rule c1's smallest storable distance was `t_1 = 2 m`,
    // larger than any pixel-to-probe distance it would ever be asked about, and
    // its visibility term was silently inert.
    //
    // ⭐⭐⭐ §19 4.12 — AND "A FINER CASCADE EXISTS" IS A QUESTION ABOUT LIVE
    // PROBES, NOT ABOUT A BOX. THE BAND PROBE IS WHAT SAID SO.
    //
    // 3.15's test was `inLatticeAt(finer, floor(pos / s_{i−1}))` — pure
    // geometry. A clipmap's lattice is a 64 m cube around the camera; whether
    // anything LIVES in it thirty metres out is a different fact entirely, and
    // `allocPass` decides it from the window's occupancy, cell by cell. Where
    // the two disagree the near band is deferred to nobody and silently lost.
    //
    // ⛔ MEASURED (`probe:gi2-band`, Bistro pose B): 166 of the 288 contained
    // c2 probes stand where c1's coverage is under a half; the c2 probe that
    // answers `DARK2` at claim 1.00 discards **100 %** of its hemisphere's
    // radiance (mean first hit 14.6 m, every texel `own = 0`) and the pixel
    // reads 0.0028 against a path-traced 0.6377. §AH.2 named this from the
    // field's own numbers — "c1's lattice contains the point; c1 has almost no
    // live probe there; nobody pays `[0, 20)`" — and this is the mechanism.
    //
    // TWO CONDITIONS, AND EACH IS A DIFFERENT WAY TO BE UNPAID:
    //
    //   · THE FINER LATTICE MUST HOLD THE WHOLE CELL THIS PROBE SPEAKS FOR,
    //     not merely its centre. A probe answers pixels across its own cell and
    //     one cell beyond it through the trilinear blend, so a c2 probe sitting
    //     one metre inside c1's boundary is read by pixels several metres
    //     OUTSIDE it — where c1 answers nothing at all. The margin is this
    //     cascade's own spacing, which is the reach of its own interpolation,
    //     and it costs no buffer read: the lattice is a box, so its two extreme
    //     corners decide it.
    //   · THE FINER LATTICE MUST ACTUALLY BE LIVE THERE — `latticeCovAt ≥
    //     wpCovBelow`, the same liveness-weighted trilinear coverage the
    //     resolve spends as a claim and `irradianceAtCasc` normalises by.
    //
    // ⚠ AND IT COSTS NOTHING IN RAY LENGTH. The ray already leaves the probe
    // and runs to `t_{i+1}` (see the next block — the interval is applied to
    // the RESULT, not to the origin), so widening a probe's own band to
    // `[0, t_{i+1})` changes only how its hits are CLASSIFIED. The whole spend
    // is the eight liveness loads above.
    //
    // ⚠ THE DOUBLE-COUNT THIS OPENS IS SELF-LIMITING, and the merge's own
    // algebra is why. A child adds its parent's map only where its own texel is
    // TRANSPARENT, and `T = 1` means the child's ray MISSED CLEANLY over the
    // whole of `[0, t_{i+1})` — so the segment the parent would re-credit is a
    // segment the child has just measured to be empty. What is left is the
    // parallax between two probes at most a coarse cell apart, against a near
    // band that was being dropped in full.
    //
    // ⚠ `__gi2CovBelow = 0` IS A BUILD-TIME BRANCH, NOT A UNIFORM SET TO ZERO,
    // and it has to be: a zero threshold still leaves the CELL margin standing,
    // which is 4.12 with one of its two conditions removed rather than 4.11.
    // An arm that is not byte-for-byte the stage it claims to restore cannot
    // arbitrate anything — and this worktree's scene moves under it, so the
    // only honest A/B is two boots minutes apart with one flag between them.
    const fSp = pickF(rr.casc, SPC_FINER).toVar();
    const fOrg = pickV(rr.casc, ORG_FINER).toVar();
    let coveredBelow;
    if (COV_BELOW <= 0) {
      const fc = pos.div(fSp).floor().toVar();
      coveredBelow = rr.casc.greaterThan(uint(0))
        .and(inLatticeAt(fOrg, fc.x, fc.y, fc.z)).toVar();
    } else {
      const fBase = pickU(rr.casc, BASE_FINER).toVar();
      const spOwn = pickF(rr.casc, SPC).toVar();
      const fLo = pos.sub(spOwn).div(fSp).floor().toVar();
      const fHi = pos.add(spOwn).div(fSp).floor().toVar();
      const holdsCell = inLatticeAt(fOrg, fLo.x, fLo.y, fLo.z)
        .and(inLatticeAt(fOrg, fHi.x, fHi.y, fHi.z)).toVar();
      // ⭐⭐⭐ §19 4.13 — THE DEFERRAL WAS DECIDED AT THE PROBE AND READ AT THE
      // PIXEL. `DARK1` is the pin that proves one tap cannot answer it: its c2
      // probe stands where c1's coverage is **1.000** — c1 is fully live THERE
      // — and the pixel that probe answers is **six metres away**, where c1's
      // coverage is **0.27**. Both of 4.12's conditions pass at the point, the
      // near band is deferred, and the cascade it is deferred to has nothing
      // live where the answer is actually read: `DARK1` measured 0.0022 against
      // a path-traced 0.4607 and did not move at 4.12.
      //
      // ⭐ THE EXTENT WAS ALREADY DECIDED, AND IT IS `holdsCell`'s. That test
      // asks its BOX question over `pos ± spOwn` — this cascade's own cell plus
      // the one cell beyond it that the trilinear blend reaches — precisely
      // because a probe is read across that whole span. Asking the LIVENESS
      // question on a SMALLER extent than the CONTAINMENT question was the
      // inconsistency; both are the same volume now, and the deferral takes the
      // WORST corner of it. A cascade defers its near band only where the finer
      // one is live everywhere its own answer will be read.
      //
      // ⚠ EIGHT TAPS WHERE 4.12 HAD ONE, and that is the honest cost: 64 scalar
      // `wpInfo[…].w` loads, the same eight corners for every one of a probe's
      // 64 oct texels, so every texel after the first reads them out of cache.
      // Still no SH, still no branch, still nothing added to the ray itself.
      // ⚠ `min`, NEVER A MEAN — a mean lets a fully live half of the cell pay
      // for a dead half, which is the arithmetic that hid `DARK1` inside a
      // 1.000 in the first place.
      // ⚠ A TSL `Loop`, NOT A JS ONE, AND THE REASON IS THE SAME AS
      // `cascConst`'s. `latticeCovAt` is eight addressed loads and a trilinear
      // product; unrolled eight more times it added **163 kB of WGSL to
      // `worldTrace`** (98 → 261 kB, measured by `smoke:gi-gpu`'s storage
      // audit), and §19 4.3a's receipt says a kernel's WGSL size is paid at
      // BOOT, in pipeline compile, in front of first light. One copy inside a
      // loop costs the same 64 loads and none of the text.
      const fCov = float(1).toVar();
      if (COV_CORNERS) {
        Loop({ start: 0, end: 8, name: "wpCovCorner" }, ({ wpCovCorner }) => {
          const kk = uint(wpCovCorner).toVar();
          const cp = vec3(
            select(bitAnd(kk, uint(1)).equal(uint(0)), pos.x.sub(spOwn), pos.x.add(spOwn)),
            select(bitAnd(kk, uint(2)).equal(uint(0)), pos.y.sub(spOwn), pos.y.add(spOwn)),
            select(bitAnd(kk, uint(4)).equal(uint(0)), pos.z.sub(spOwn), pos.z.add(spOwn)),
          ).toVar();
          fCov.assign(fCov.min(latticeCovAt(fBase, fSp, fOrg, cp)));
        });
      } else {
        fCov.assign(latticeCovAt(fBase, fSp, fOrg, pos));
      }
      coveredBelow = rr.casc.greaterThan(uint(0)).and(holdsCell)
        .and(fCov.greaterThanEqual(wu.wpCovBelow)).toVar();
    }
    const t0 = select(coveredBelow, pickF(rr.casc, TSTART), float(0)).toVar();
    const t1 = pickF(rr.casc, TEND).toVar();
    const isLast = rr.casc.greaterThanEqual(uint(NC - 1)).toVar();

    // ⭐⭐⭐ THE RAY LEAVES THE PROBE, NOT THE INTERVAL START — AND ONLY THE
    // RADIANCE IS INTERVAL-LIMITED. THE SEALED CORNELL ROOM MEASURED WHY.
    //
    // The obvious build advances the origin to `t_i` and traces `t_{i+1} − t_i`.
    // In a room whose free path is smaller than `t_i`, that origin lands INSIDE
    // OR BEYOND A WALL — and `traceWindow`'s escape then does exactly its job,
    // walking the origin forward out of the dilated shell, which puts the ray
    // OUTSIDE THE SEALED ROOM. It flies to the horizon, misses, and the chain
    // pays SKY. In a 10×6×10 m Cornell room c1's band starts at 4 m and c2's at
    // 20 m, so this is not an edge case, it is most of their directions.
    //
    // ⛔ MEASURED: the thin-wall interior receipt — a 5 cm partition with the
    // panel entirely on the far side — read **5.99 % of the lit side against
    // 3.14's 0.05 %**, and the CONTROL (visibility and face both off) read the
    // same 5.99 %. That equality is the whole diagnosis: nothing in the RESOLVE
    // was leaking, and nothing in the merge's parent tap was either (a
    // line-of-sight gate on it, `mergeVisPass`, moved the number by 0.4 points).
    // Sky was already in the field, put there by rays that started outside the
    // room. ⭐ **An escape rule written for a probe's own origin is wrong for an
    // interval start: one is "get me out of the surface I am standing on", the
    // other is "get me past the surface that is blocking me".**
    //
    // So the ray starts AT THE PROBE and runs to `t_{i+1}`, and the interval is
    // applied to the RESULT:
    //   hit before `t_i`  → radiance 0, T = 0.  Blocked before my band; the
    //                       finer cascade owns both the light and the occluder.
    //   hit inside        → the hit's radiance, T = 0.
    //   miss              → sky and T = 0 on the LAST cascade (nothing is
    //                       coarser, and a ray that leaves the window has left
    //                       the scene); radiance 0 and T = 1 on any other.
    //
    // This is RC's decomposition unchanged — cascade `i` still contributes only
    // `[t_i, t_{i+1})` — with the occlusion evaluated from the place the light
    // is actually being gathered. It is strictly MORE correct than the textbook
    // form, which assumes the finer cascade's `T` covers the near segment; that
    // holds only when the finer probe is at the same point, and it never is.
    //
    // ⚠ AND IT IS NOT MORE EXPENSIVE OVERALL. c0 holds 70 % of the slots and its
    // rays got 10× SHORTER (0→4 m against 3.14's 0→40); c1 halves; only c2, at
    // 10 % of the slots, pays 3.14's full length. Receipt: the chain is 2.477 ms
    // against 3.14's 2.544 at the same resolution.
    const r = traceWindow(pos, dir, t1, select(faced, faceN, dir)).raw.toVar();
    const hitAny = r.x.greaterThan(0.5).toVar();
    const inBand = hitAny.and(r.y.greaterThanEqual(t0)).toVar();
    const blockedNear = hitAny.and(r.y.lessThan(t0)).toVar();
    // §19 3.17 — the cold-hit fallback. The PARENT cascade's field, because a
    // cascade's own map is the thing being written this instant; the last
    // cascade is its own parent (`P_OF`) and therefore quotes the field it
    // converged to on previous frames, which is what makes reach payable.
    const rd = hitRadiance(r, dir, k,
      (hp, hn) => irradianceAtCasc(pickU(rr.casc, P_INDEX), hp, hn)).toVar();

    // ⭐⭐ SKY IS CREDITED BY THE LAST CASCADE ALONE, AND THAT IS WHAT KEEPS THE
    // MERGE ENERGY-EXACT. `hitRadiance` returns `skyColor` on any miss, so a
    // non-final cascade would otherwise contribute sky AND then add its parent's
    // sky through `T` — the same photon twice, once per cascade. A non-final
    // miss stores radiance 0 and `T = 1`: "nothing in my band, ask my parent".
    //
    // ⭐⭐ §19 4.12 — AND THE HIT IS WEIGHTED BY WHAT SURVIVED THE THIN VOXELS.
    //
    // §AG made a class-<3 voxel DIM a ray instead of stopping it, and returned
    // the surviving throughput `T_thin` beside the hit. Until this line nothing
    // spent it: a ray that crossed a cable slab and then found a wall credited
    // that wall at FULL radiance, i.e. the cables were treated as perfectly
    // transparent — the opposite of the pre-§AG error and wrong by the same
    // coverage fraction. `T_thin` is a product of per-class constants over the
    // voxels the ray actually met, so it is deterministic (§T) and it is 1 in
    // every scene with no cables, railings or foliage in it: this multiply is a
    // provable no-op there, which is why it needs no separate arm to be safe.
    //
    // ⚠ THE REMAINDER IS CREDITED TO NOTHING, AND THAT IS A DELIBERATE FLOOR.
    // The physical answer is `T·L_hit + (1−T)·L_thin`, and `L_thin` — the
    // cable's own bounce — is not knowable from the DDA's product: the ray
    // remembers HOW MUCH it lost, not WHERE. Every estimate for it is a
    // constant somebody picked ([[gi-one-property]] forbids the knob and
    // [[gi-colour-probe-method]] forbids the world-unit guess), so this credits
    // the term it can prove and under-states by a dark object's own bounce.
    // Monotone, never invents light, and exactly reversible if a receipt asks.
    // `__gi2ThinT = 0` restores the un-weighted hit, so the band rule and this
    // multiply are two arms of ONE boot pair rather than one unarbitrable diff.
    const thinT = mix(float(1), r.w.fract().mul(256 / 255).min(1), wu.wpThinT).toVar();
    const rgbNew = INTERVALS
      ? select(inBand, rd.xyz.mul(thinT),
        select(hitAny.not().and(isLast), u.skyColor.mul(thinT), vec3(0))).toVar()
      : rd.xyz.mul(thinT).toVar();
    // Transparent ONLY on a clean miss by a non-final cascade. A near hit is
    // OPAQUE (`blockedNear`) — the far field does not reach this probe in this
    // direction and asking the parent for it would be the leak, one level up.
    const tNew = INTERVALS
      ? select(hitAny.not().and(isLast.not()).and(blockedNear.not()), uint(1), uint(0)).toVar()
      : uint(0).toVar();
    // The moment is the TRUE first-hit distance from the probe — near hits
    // included — which is what makes `octTapVisAt`'s Chebyshev test meaningful
    // on every cascade a fall-through pixel can read.
    const dGlobal = INTERVALS ? select(hitAny, r.y, t1).toVar() : rd.w.toVar();

    // ⭐⭐ §19 3.16 FIX 3 — THE EMA READS `own`, NOT THE TEXEL EVERYTHING ELSE
    // READS. `OWN_W` is word 2 under the split and word 0 without it, so the
    // `INTERVALS && !SPLIT_OWN` arm is byte-for-byte 3.15 and the pre-interval
    // arm is byte-for-byte 3.14.
    const prevOwn = wpOct.element(addr.add(uint(OWN_W))).toVar();
    // §19 3.19: the COMPOSED word as it stands — the seed's value on a probe
    // that has never traced. Read before anything writes `addr`.
    const prevComposed = wpOct.element(addr).toVar();
    const prev1 = wpOct.element(addr.add(uint(1))).toVar();
    const had = nOf(prev1).greaterThan(uint(0)).and(fresh.not()).toVar();
    // Under the IN-PLACE merge α is 1 by algebra, not by taste — see `wpAlpha`.
    // Under the split it is a real EMA again, on the only value that is the
    // probe's own measurement.
    const emaOn = !INTERVALS || SPLIT_OWN;
    const a = emaOn ? select(had, wu.wpAlpha.clamp(0, 1), float(1)).toVar() : float(1).toVar();
    const rgb = emaOn ? mix(decodeRgbe(prevOwn), rgbNew, a).toVar() : rgbNew;
    const d = min(dGlobal, dmax).toVar();
    const m1 = emaOn ? mix(meanOf(prev1, dmax), d, a).toVar() : d;
    const pr = rmsOf(prev1, dmax).toVar();
    const m2 = emaOn ? mix(pr.mul(pr), d.mul(d), a).toVar() : d.mul(d);
    const packedRgb = encodeRgbe(rgb).toVar();
    // Word 0 gets `own` too: a texel the merge will not touch (opaque, or the
    // last cascade, or `NC = 1`) is already its own final answer, and a texel
    // the merge WILL touch is overwritten this same frame by `mergeFor`, which
    // recomposes it from word 2. Nothing downstream ever sees a half-state.
    // ⭐⭐ §19 3.19 — THE SEED RAMP, AND IT IS ON WORD 0 ONLY.
    //
    // `wpSeedRamp = 1` is 3.18 byte-for-byte (`a0` collapses to 1). Above 1 the
    // composed word — the ONLY word the resolve reads — walks from the seed to
    // this trace's answer over that many of the probe's own updates, while
    // word 2 keeps taking the trace at α = 1.
    // ⚠ A probe with `n = 0` never held a seed: `prevComposed` is whatever the
    // slot held before the cell was re-keyed, so it takes `a0 = 1` and this is
    // inert for it. And a TRANSPARENT texel is recomposed by `mergeFor` in this
    // same frame regardless — the ramp reaches only the opaque ones, which are
    // exactly the texels the merge leaves alone.
    const nPrev = nOf(prev1).toVar();
    const a0 = emaOn
      ? select(nPrev.greaterThan(uint(0)),
        min(float(1), nPrev.toFloat().div(wu.wpSeedRamp.max(1))), float(1)).toVar()
      : float(1).toVar();
    const rgb0 = emaOn ? mix(decodeRgbe(prevComposed), rgb, a0).toVar() : rgb;
    wpOct.element(addr).assign(emaOn ? encodeRgbe(rgb0) : packedRgb);
    if (SPLIT_OWN) wpOct.element(addr.add(uint(2))).assign(packedRgb);
    wpOct.element(addr.add(uint(1))).assign(
      bitOr(
        packMoments(nOf(prev1).add(uint(1)).min(uint(63)), m1, sqrt(m2.max(0)), dmax, tNew),
        // §19 4.14 — bit 31. Written unconditionally (0 when the direction did
        // measure something), so the word is a complete statement every frame
        // and a probe cannot inherit a stale "blocked" from a scene that moved.
        shiftLeft(select(blockedNear, uint(1), uint(0)), uint(31)),
      ),
    );
    // ⚠ AN ARRAY `count` IS A DISPATCH SIZE IN WORKGROUPS, NOT IN THREADS
    // (`ComputeNode.compute`: a number sets `count`, an array sets
    // `dispatchSize`). So this is `TRACE_SLOTS/8 × OCT/8` groups of 8×8 — and
    // because it is `dispatchSize`, three generates NO bounds check, which is
    // why the two guards at the top of this kernel are written by hand.
  })().compute([Math.ceil(TRACE_SLOTS / 8), Math.ceil(OCT / 8)], [8, 8, 1]);

  // ═══════════════════════════════ §19 STAGE 3.15 — THE MERGE ════════════════
  //
  // ⭐⭐ `L_i(ω) = L_i^own(ω) + T_i^own(ω) · L_{i+1}(ω)`, PER DIRECTION, and the
  // parent's `L_{i+1}` is ALREADY MERGED with ITS parent — so one pass per
  // cascade, coarsest-first, composes the whole chain. That single line is what
  // 3.14 did not have. 3.14 had every cascade trace to the horizon and then
  // asked the RESOLVE to choose between three answers that disagreed; RC never
  // chooses, because no two cascades describe the same interval.
  //
  // ── the four decisions in it ──────────────────────────────────────────────
  //
  // 1. **IT IS `NC−1` DISPATCHES, NOT ONE.** Cascade `i`'s merge READS cascade
  //    `i+1`'s texels and WRITES cascade `i`'s. Fold them into one dispatch and
  //    c0's threads read c1's words while c1's threads write them — a
  //    read-write hazard inside a dispatch, which is the one thing §T's
  //    "byte-identical frames" cannot survive. Separate dispatches are the
  //    barrier, and coarsest-first is the order that makes one frame compose
  //    all three levels rather than one level per frame.
  //
  // 2. **IT MERGES IN PLACE, AND THE TRACE IS WHAT MAKES THAT SAFE.** `own` is
  //    read exactly once — by this pass, in the same frame the trace wrote it,
  //    over the same round-robin batch. A probe's next update overwrites `own`
  //    from scratch, so nothing ever needs the pre-merge value again and the
  //    lattice does not pay a second 50 MB to hold it. The cost is the honest
  //    one: a probe's merged map is as stale as its PARENT was at its own last
  //    update — ≤ one round-robin period, 3 frames at c0.
  //
  // 3. **THE T BIT IS CLEARED ON THE WAY OUT.** Run this kernel twice on one
  //    frame and the second run sees `T = 0` and returns — the merge is
  //    idempotent, which is the same property `allocPass` has and for the same
  //    auditing reason. It also means a probe whose parent moved on but which
  //    has not re-traced keeps its last complete answer instead of accumulating.
  //
  // 4. **A MISSING PARENT PAYS SKY, NOT BLACK.** If the parent lattice has no
  //    live probe here (past its extent, or a cascade whose liveness level the
  //    window has not voxelized yet — §V.3's `c2 live 0/32768` boot), then the
  //    chain ENDS at this cascade and a direction that escaped it escapes the
  //    scene. Crediting sky there is what keeps the energy exactly once: the
  //    last cascade credits sky on its own misses, and a truncated chain credits
  //    it at the truncation. Black would have made an intermittently-late
  //    voxelization read as "the far field is unlit", which is precisely the
  //    3.13 boundary-clamp failure wearing a different hat.
  const OCT_GROUPS = Math.ceil(OCT / 8);
  /**
   * The parent's radiance at `pos` for one direction: trilinear over its eight
   * surrounding probes, weighted by liveness alone.
   *
   * ⚠ LIVENESS ALONE — no face gate and no visibility. The parent is being
   * asked "what does the far field look like from around here", not "can you
   * see me": a parent probe representing the other side of a wall is discounted
   * by the CHILD's own `T`, which is 0 in exactly the directions that wall
   * blocks. Adding a second refusal here would be [[§V.1's cov-is-not-vis]]
   * bug one level down, where nothing would measure it.
   */
  const parentTap = (pcBase, pcSp, pcOrg, pos, texel, visBits = null) => {
    const g = pos.div(pcSp).sub(0.5).toVar();
    const b = g.floor().toVar();
    const f = g.sub(b).toVar();
    const acc = vec3(0).toVar();
    const cov = float(0).toVar();
    const accV = vec3(0).toVar();
    const covV = float(0).toVar();
    for (let c8 = 0; c8 < 8; c8++) {
      const dx = c8 & 1;
      const dy = (c8 >> 1) & 1;
      const dz = (c8 >> 2) & 1;
      const rx = b.x.add(dx).toVar();
      const ry = b.y.add(dy).toVar();
      const rz = b.z.add(dz).toVar();
      const inLat = inLatticeAt(pcOrg, rx, ry, rz);
      const cell = slotOf(rx.toInt(), ry.toInt(), rz.toInt()).add(pcBase).toVar();
      const pAddr = octIdxW(cell, texel).toVar();
      const pw1 = wpOct.element(pAddr.add(uint(1))).toVar();
      const okay = wpInfo.element(infoIdx(cell, 0)).w.greaterThan(0.5)
        .and(wpInfo.element(infoIdx(cell, 2)).w.greaterThan(0.25))
        .and(nOf(pw1).greaterThan(uint(0)))
        .and(inLat).toVar();
      const tri = (dx ? f.x : float(1).sub(f.x))
        .mul(dy ? f.y : float(1).sub(f.y))
        .mul(dz ? f.z : float(1).sub(f.z)).toVar();
      const w = select(okay, tri, float(0)).toVar();
      const rad = decodeRgbe(wpOct.element(pAddr)).toVar();
      acc.addAssign(rad.mul(w));
      cov.addAssign(w);
      if (visBits !== null) {
        const seen = bitAnd(shiftRight(visBits, uint(c8)), uint(1)).equal(uint(1));
        const wv = select(seen, w, float(0)).toVar();
        accV.addAssign(rad.mul(wv));
        covV.addAssign(wv);
      }
    }
    if (visBits === null) return { acc, cov };
    // ⭐⭐ THE GATED SUM IF IT HAS ANYTHING, THE UNGATED ONE IF IT DOES NOT.
    // A probe in a pocket whose eight parents are all occluded would otherwise
    // read `cov = 0` and be paid SKY — the truncated chain, on a probe with a
    // perfectly good coarse neighbourhood. Same two-tier shape as the resolve's
    // `wf.max(0.001)` fallback: prefer the admissible answer, never black for
    // want of one.
    return {
      acc: select(covV.greaterThan(1e-4), accV, acc),
      cov: select(covV.greaterThan(1e-4), covV, cov),
    };
  };

  // ═══════════════════ SHADER: worldProbeMergeVis (§19 3.15, the thin-wall fix)
  //
  // ⭐⭐ §V.1's "COVERAGE IS NOT VISIBILITY" IS ABOUT THE RESOLVE'S HAND-OFF.
  // THE MERGE'S PARENT TAP IS THE OPPOSITE CASE AND NEEDS THE OPPOSITE ANSWER.
  //
  // The hand-off asks "which cascade answers for this point", and there an
  // occluded probe IS the answer — folding its refusal in invited the coarse
  // cascade to answer instead, and thin-wall interior went 0.03 % → 0.56 % on
  // that one term. The merge asks something else entirely: it INTERPOLATES a
  // directional radiance field ACROSS SPACE, from probes up to `s_{i+1}` away.
  // That is DDGI's own question, and DDGI's answer has always been that such an
  // interpolation without a line-of-sight weight leaks through thin geometry.
  //
  // ⛔ MEASURED: with an unweighted parent tap the Cornell thin-wall interior
  // read **5.62 % against 3.14's 0.05 %** — a 5 cm partition with the panel
  // entirely on one side, the dark side inheriting the lit side's far field
  // through a c1 parent standing a metre away on the wrong side of it. The
  // CONTROL (visibility and face both off) read 5.63 %, which is the tell: the
  // leak was not passing through any of the RESOLVE's terms, it was already in
  // the field. `wpCovFull = 1` did not move it either. Both refutations in §W.
  //
  // ⚠ ONE THREAD PER PROBE, NOT PER TEXEL, AND THAT IS THE ONLY REASON IT IS
  // AFFORDABLE. Whether parent corner `k` is visible from this probe does not
  // depend on which of the 64 directions is being merged, so it is computed
  // once and packed as EIGHT BITS into `wpInfo[1].w` — a component `allocPass`
  // has always written as 0. Eight short rays per updated probe against the
  // trace's 64 long ones is ~11 % more rays, and they stop at the parent.
  //
  // ⚠ THE BIAS NORMAL IS THE FACE, NOT THE RAY. `traceWindow`'s default origin
  // bias is half a cell of the origin's level — 12.5 cm at L0, more than twice
  // the 5 cm partition this exists to see. Biasing along `dir` would step the
  // ray straight through the wall and the census would read "visible" for
  // exactly the corners that are not.
  const mergeVisPass = (LEAN || !(INTERVALS && NC > 1)) ? null : Fn(() => {
    const k = instanceIndex.toVar();
    const rr = roundRobin(k);
    If(rr.kLocal.greaterThanEqual(rr.live), () => { Return(); });
    If(rr.casc.greaterThanEqual(uint(NC - 1)), () => { Return(); });
    const gc = slotCell(rr).toVar();
    const i0 = wpInfo.element(infoIdx(gc, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });
    const pos = i0.xyz.toVar();
    const faced = i0.w.greaterThan(1.5).toVar();
    const i1 = wpInfo.element(infoIdx(gc, 1)).toVar();
    const faceN = i1.xyz.toVar();
    const pcSp = pickF(rr.casc, SPC_PARENT).toVar();
    const pcBase = pickU(rr.casc, BASE_PARENT).toVar();
    const g = pos.div(pcSp).sub(0.5).toVar();
    const b = g.floor().toVar();
    const bits = uint(0).toVar();
    for (let c8 = 0; c8 < 8; c8++) {
      const rx = b.x.add(c8 & 1).toVar();
      const ry = b.y.add((c8 >> 1) & 1).toVar();
      const rz = b.z.add((c8 >> 2) & 1).toVar();
      const cell = slotOf(rx.toInt(), ry.toInt(), rz.toInt()).add(pcBase).toVar();
      const pp = wpInfo.element(infoIdx(cell, 0)).toVar();
      const d = pp.xyz.sub(pos).toVar();
      const L = d.length().toVar();
      const dir = d.div(L.max(1e-4)).toVar();
      const blocked = traceWindow(
        pos, dir, L.sub(0.02).max(0), select(faced, faceN, dir),
      ).hit.greaterThan(0.5).toVar();
      // A DEAD parent's `pos` is still its cell centre, so `L` is meaningful and
      // the bit is simply ignored downstream — `okay` already rejects it.
      const seen = blocked.not().or(L.lessThan(0.05)).toVar();
      bits.assign(bitOr(bits, select(seen, uint(1 << c8), uint(0))));
    }
    wpInfo.element(infoIdx(gc, 1)).assign(vec4(i1.xyz, bits.toFloat()));
  })().compute(TRACE_SLOTS);
  /** Cascade `ci`'s merge with cascade `ci+1`. One thread per (slot, texel). */
  const mergeFor = (ci) => Fn(() => {
    const kLocal = globalId.x.toVar();
    const texel = globalId.y.toVar();
    If(texel.greaterThanEqual(uint(OCT)), () => { Return(); });
    If(kLocal.greaterThanEqual(uint(SLOTS[ci])), () => { Return(); });
    const rr = roundRobin(kLocal.add(uint(SLOT_BASE[ci])));
    If(rr.kLocal.greaterThanEqual(rr.live), () => { Return(); });
    const gc = slotCell(rr).toVar();
    const i0 = wpInfo.element(infoIdx(gc, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });
    const addr = octIdxW(gc, texel).toVar();
    const w1 = wpOct.element(addr.add(uint(1))).toVar();
    // A back-hemisphere HOLE (n = 0) is not a direction this probe owns, and an
    // OPAQUE direction (T = 0) already has its answer. Both return, and the
    // second is what makes this pass idempotent.
    If(nOf(w1).equal(uint(0)).or(tOf(w1).equal(uint(0))), () => { Return(); });
    // The eight line-of-sight bits `mergeVisPass` packed for this probe.
    const visBits = wpInfo.element(infoIdx(gc, 1)).w.max(0).toUint().toVar();
    const p = parentTap(
      uint((ci + 1) * CELLS), float(SPC[ci + 1]), originsU[ci + 1], i0.xyz, texel, visBits,
    );
    // ⭐ THE MERGE'S OWN CENSUS, IN THREE SLOTS THAT ARE DEAD ON THIS PATH.
    // `handoffs`, `matureTexels` and `texelsSeen` are all written by screen-path
    // kernels that `useWorld` does not build, so they read 0 on every world boot
    // and are free to say something true instead. What they say is the one
    // question a merge can fail silently on: **did the parent answer?** A
    // truncated chain is not an error — the last cascade has no parent by
    // construction — but a chain truncating at c0 or c1 means the coarse lattice
    // has no live probe there and the pixel is getting sky where it should be
    // getting the far field, which is exactly the failure 3.13's boundary clamp
    // turned out to be. It is worth one atomic to know the rate.
    const answered = p.cov.greaterThan(1e-4).toVar();
    bump(STATS.matureTexels, kLocal);
    If(answered, () => { bump(STATS.handoffs, kLocal); })
      .Else(() => { bump(STATS.texelsSeen, kLocal); });
    const parent = select(answered, p.acc.div(p.cov.max(1e-4)), u.skyColor).toVar();
    // `own` is 0 here by construction (a transparent texel found nothing in its
    // band), but the sum is written as the formula rather than as the shortcut:
    // the day a cascade learns to store partial transmittance, this line is
    // already right and the one that says `assign(parent)` is silently wrong.
    // ⭐⭐ §19 3.16 — `own` COMES OUT OF ITS OWN WORD, WHICH IS WHAT MAKES THE
    // MERGE IDEMPOTENT WITHOUT CLEARING `T`. 3.15 read `own` from the texel it
    // was about to overwrite, so the ONLY thing that could stop a second run
    // from accumulating was destroying the transmittance bit on the way out —
    // and that same aliasing is what forced `wpAlpha = 1` (§W.3). With word 2
    // holding `own`, this line recomputes the same value from the same inputs
    // however many times it runs, `T` survives for the next merge, and the
    // trace is free to blend `own` against its own history.
    const own = decodeRgbe(wpOct.element(addr.add(uint(OWN_W)))).toVar();
    wpOct.element(addr).assign(encodeRgbe(own.add(parent)));
    if (!SPLIT_OWN) wpOct.element(addr.add(uint(1))).assign(clearT(w1));
  })().compute([Math.ceil(SLOTS[ci] / 8), OCT_GROUPS], [8, 8, 1]);
  const mergePasses = (!LEAN && INTERVALS && NC > 1)
    // COARSEST FIRST: c1 takes c2's field, then c0 takes the c1 that already
    // has it. One frame, whole chain. Reverse this and light arrives one
    // cascade per frame — correct in the limit, visibly laggy in motion.
    ? Array.from({ length: NC - 1 }, (_, i) => NC - 2 - i).map(mergeFor)
    : [];

  // ══════════════════════ SHADER: worldProbeSeed (§19 3.15, spec item 2) ═════
  //
  // ⭐⭐ "LIGHT ARRIVES COMPLETE" IS THE WHOLE POINT OF RC, AND A RE-KEYED SLAB
  // WAS THE ONE PLACE THIS LATTICE STILL BROKE IT. §V.6 measured the cost: a
  // scroll sets `ready = 0` on the entering cells and they contribute NOTHING
  // until their own round-robin turn — 3 frames at c0, SEVEN at c1 — which is
  // 3.14's +2.0/+5.5/+3.0 points of motion sign-flips against 3.13.
  //
  // A fresh probe is not, however, ignorant: the cascade above it covers 64×
  // the volume, changes 64× more slowly, and has ALREADY MERGED the whole far
  // chain into its map. So a fresh probe takes its parent's answer until its
  // own first trace replaces it. That is not an approximation bolted on — it is
  // what a cascade hierarchy means, applied at the one moment the lattice
  // admits it does not know something.
  //
  // ⚠ THE SEED IS THE NEAREST PARENT PROBE, NOT AN INTERPOLATION OF EIGHT, and
  // the reason is a budget rather than a principle: an interp8 seed is 8 reads
  // × 64 texels in a kernel dispatched over every cell of every cascade. The
  // seed lives at most one round-robin period and is replaced by a complete
  // trace; paying 8× for a value with a 3-frame half-life is the wrong trade.
  // `mergePass`, whose value persists, does pay it.
  //
  // ⚠ AND IT RE-SEEDS EVERY FRAME UNTIL THE PROBE TRACES. Deliberately: a probe
  // waiting seven frames for c1's turn tracks its parent the whole way instead
  // of freezing on the scroll frame's snapshot. It is still a pure function of
  // (occupancy, origins, parent maps) — §T holds — and at rest the set is empty,
  // so a parked camera pays nothing and stays byte-identical.
  const seedPass = (LEAN || !(INTERVALS && NC > 1)) ? null : Fn(() => {
    const gc = instanceIndex.toVar();
    const casc = shiftRight(gc, uint(CELLB)).toVar();
    const i0 = wpInfo.element(infoIdx(gc, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });                       // dead cell
    const i2 = wpInfo.element(infoIdx(gc, 2)).toVar();
    If(i2.w.greaterThan(0.75), () => { Return(); });                   // already traced
    // §19 4.14 — …and a probe that traced and found its whole band blocked is
    // NOT a candidate for a parent seed. Seeding it would hand it the coarser
    // cascade's field and put it straight back on the resolve's books at
    // `ready = 0.5`, which is the claim this stage just took away.
    if (CASC_DATA) {
      If(i2.w.greaterThan(READY_EMPTY * 0.5).and(i2.w.lessThan(0.25)), () => { Return(); });
    }
    // The LAST cascade has no parent to take from; its fresh probes wait for
    // their own trace, which is 2 frames at its slot share.
    If(casc.greaterThanEqual(uint(NC - 1)), () => { Return(); });
    const pcSp = pickF(casc, SPC_PARENT).toVar();
    const pcBase = pickU(casc, BASE_PARENT).toVar();
    const pcOrg = pickV(casc, ORG_PARENT).toVar();
    const dmax = pickF(casc, DMAX).toVar();
    const pDmax = pickF(casc, DMAX_PARENT).toVar();
    // The nearest parent CELL — `round` of the same frame `parentTap` floors.
    const g = i0.xyz.div(pcSp).sub(0.5).toVar();
    const nb = g.add(0.5).floor().toVar();
    If(inLatticeAt(pcOrg, nb.x, nb.y, nb.z).not(), () => { Return(); });
    const pc = slotOf(nb.x.toInt(), nb.y.toInt(), nb.z.toInt()).add(pcBase).toVar();
    If(wpInfo.element(infoIdx(pc, 0)).w.lessThan(0.5), () => { Return(); });
    If(wpInfo.element(infoIdx(pc, 2)).w.lessThan(0.25), () => { Return(); });

    const faced = i0.w.greaterThan(1.5).toVar();
    const faceN = wpInfo.element(infoIdx(gc, 1)).xyz.toVar();
    const sh = [];
    for (let i = 0; i < 9; i++) sh.push(vec3(0).toVar());
    Loop({ start: 0, end: OCT, name: "wpSeed" }, ({ wpSeed }) => {
      const t = uint(wpSeed).toVar();
      const dst = octIdxW(gc, t).toVar();
      const src = octIdxW(pc, t).toVar();
      const e = octU.element(t).toVar();
      const d = e.xyz.toVar();
      // The child's own hemisphere rule still applies — a seeded probe that
      // represents a face must not answer for the half it does not own, or the
      // seed becomes a leak that the trace then has to undo.
      const own = faced.not().or(dot(d, faceN).greaterThan(0.02)).toVar();
      const sw1 = wpOct.element(src.add(uint(1))).toVar();
      const has = nOf(sw1).greaterThan(uint(0)).and(own).toVar();
      const rad = select(has, decodeRgbe(wpOct.element(src)), vec3(0)).toVar();
      // The parent's moments are in the PARENT's units; re-quantize into ours
      // and clamp, so `octTapVisAt` reads a distance and not a scale error.
      const m = min(meanOf(sw1, pDmax), dmax).toVar();
      wpOct.element(dst).assign(select(has, encodeRgbe(rad), uint(0)));
      wpOct.element(dst.add(uint(1))).assign(
        select(has, packMoments(uint(1), m, m, dmax, uint(0)), uint(0)),
      );
      // ⚠ THE SEED IS A `merged` VALUE AND ONLY A `merged` VALUE. `own` stays 0
      // until this probe's first real trace, which `fresh` (`ready < 0.75`)
      // takes at α = 1 — so the parent's far chain is never blended into the
      // band this probe is supposed to measure for itself.
      if (SPLIT_OWN) wpOct.element(dst.add(uint(2))).assign(uint(0));
      const c = rad.mul(e.w).mul(select(has, float(1), float(0))).toVar();
      sh[0].addAssign(c.mul(0.282095));
      sh[1].addAssign(c.mul(d.y.mul(0.488603)));
      sh[2].addAssign(c.mul(d.z.mul(0.488603)));
      sh[3].addAssign(c.mul(d.x.mul(0.488603)));
      sh[4].addAssign(c.mul(d.x.mul(d.y).mul(1.092548)));
      sh[5].addAssign(c.mul(d.y.mul(d.z).mul(1.092548)));
      sh[6].addAssign(c.mul(d.z.mul(d.z).mul(3).sub(1).mul(0.315392)));
      sh[7].addAssign(c.mul(d.x.mul(d.z).mul(1.092548)));
      sh[8].addAssign(c.mul(d.x.mul(d.x).sub(d.y.mul(d.y)).mul(0.546274)));
    });
    for (let i = 0; i < 9; i++) wpInfo.element(shIdxW(gc, i)).assign(vec4(sh[i], 0));
    // ⭐ 0.5, NOT 1. `ready` is now three-valued — 0 re-keyed, 0.5 SEEDED, 1
    // traced — so the resolve can accept a seeded probe (it carries a real
    // field) while `shPass` can still tell "has this probe ever traced" and
    // this kernel can tell "should I keep seeding it".
    wpInfo.element(infoIdx(gc, 2)).assign(vec4(i2.xyz, 0.5));
  })().compute(ALL_CELLS);

  // ══════════════════════════════════════════ SHADER: worldProbeSh (§U.2)
  //
  // One thread per updated probe: fill the holes, project SH2, and — LAST —
  // mark the probe ready. The ready flag is set here rather than in the trace
  // because 64 threads of the trace would be racing to write one word while
  // their neighbours are still reading it; one thread per probe, in the kernel
  // that runs after the barrier, has no such question.
  //
  // ⛔ NO SPATIAL POOL. The screen path's 5×5 SH bilateral exists to integrate
  // away a per-probe sub-texel offset that only ever existed because screen
  // probes are placed on a screen grid. A world probe's neighbours are on the
  // OTHER SIDE of walls as often as not, and pooling across them is the leak
  // this design's visibility test is built to prevent, re-introduced one stage
  // earlier where nothing can see it.
  const shPass = LEAN ? null : Fn(() => {
    const k = instanceIndex.toVar();
    const rr = roundRobin(k);
    If(rr.kLocal.greaterThanEqual(rr.live), () => { Return(); });
    const gc = slotCell(rr).toVar();
    const i0 = wpInfo.element(infoIdx(gc, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });
    const faced = i0.w.greaterThan(1.5).toVar();
    const faceN = wpInfo.element(infoIdx(gc, 1)).xyz.toVar();

    // Pass 1: the cosine-weighted mean over the directions this probe HAS.
    //
    // ⭐⭐⭐ §19 4.14 — AND THE CENSUS THAT DECIDES WHETHER THIS PROBE HAS A
    // BAND AT ALL, taken in the loop that was already reading every moment
    // word. `bnOf` is the trace's own `blockedNear`, per direction: a texel
    // that is opaque BEFORE this cascade's interval starts holds a measured,
    // permanent zero that the merge is forbidden to fill from the parent. When
    // EVERY direction of the probe's own hemisphere is that, the probe has no
    // data, and a cascade with no data must not take a claim (§AJ).
    //
    // ⚠ `nHas`, NOT `OCT` — a texel this probe has never traced is unknown, not
    // empty, and a probe halfway through its first round must not be condemned
    // on the four directions that have landed. And the front-hemisphere test is
    // the SAME one pass 2 projects with: a faced probe does not own the half it
    // cannot see, so directions there are not evidence either way.
    const acc = vec3(0).toVar();
    const wsum = float(0).toVar();
    const nHas = float(0).toVar();
    const nBlocked = float(0).toVar();
    Loop({ start: 0, end: OCT, name: "wpMean" }, ({ wpMean }) => {
      const t = uint(wpMean).toVar();
      const addr = octIdxW(gc, t).toVar();
      const w1 = wpOct.element(addr.add(uint(1))).toVar();
      const e0 = octU.element(t).toVar();
      const own0 = nOf(w1).greaterThan(uint(0))
        .and(select(faced, dot(e0.xyz, faceN).greaterThan(0), true)).toVar();
      nHas.addAssign(select(own0, float(1), float(0)));
      nBlocked.addAssign(select(own0.and(bnOf(w1).equal(uint(1))), float(1), float(0)));
      If(nOf(w1).greaterThan(uint(0)), () => {
        const e = octU.element(t).toVar();
        const cw = select(faced, dot(e.xyz, faceN).max(0), float(1)).mul(e.w).toVar();
        acc.addAssign(decodeRgbe(wpOct.element(addr)).mul(cw));
        wsum.addAssign(cw);
      });
    });
    const fill = acc.div(wsum.max(1e-6)).toVar();
    const anyData = wsum.greaterThan(1e-6).toVar();

    // Pass 2: project. A hole in the FRONT hemisphere takes the mean — an
    // unknown direction is not black, and dividing a partial hemisphere's sum
    // by nothing is what makes a probe read a quarter as bright.
    const sh = [];
    for (let i = 0; i < 9; i++) sh.push(vec3(0).toVar());
    Loop({ start: 0, end: OCT, name: "wpSh" }, ({ wpSh: t0 }) => {
      const t = uint(t0).toVar();
      const addr = octIdxW(gc, t).toVar();
      const w1 = wpOct.element(addr.add(uint(1))).toVar();
      const e = octU.element(t).toVar();
      const d = e.xyz.toVar();
      const has = nOf(w1).greaterThan(uint(0)).toVar();
      const front = select(faced, dot(d, faceN).greaterThan(0), true).toVar();
      const val = select(has, decodeRgbe(wpOct.element(addr)),
        select(front.and(anyData), fill, vec3(0))).toVar();
      const c = val.mul(e.w).toVar();
      sh[0].addAssign(c.mul(0.282095));
      sh[1].addAssign(c.mul(d.y.mul(0.488603)));
      sh[2].addAssign(c.mul(d.z.mul(0.488603)));
      sh[3].addAssign(c.mul(d.x.mul(0.488603)));
      sh[4].addAssign(c.mul(d.x.mul(d.y).mul(1.092548)));
      sh[5].addAssign(c.mul(d.y.mul(d.z).mul(1.092548)));
      sh[6].addAssign(c.mul(d.z.mul(d.z).mul(3).sub(1).mul(0.315392)));
      sh[7].addAssign(c.mul(d.x.mul(d.z).mul(1.092548)));
      sh[8].addAssign(c.mul(d.x.mul(d.x).sub(d.y.mul(d.y)).mul(0.546274)));
    });
    for (let i = 0; i < 9; i++) wpInfo.element(shIdxW(gc, i)).assign(vec4(sh[i], 0));
    const i2 = wpInfo.element(infoIdx(gc, 2)).toVar();
    // §19 4.14 — `READY_EMPTY` instead of 1 when every own direction was
    // blocked before the band. `__gi2CascData = 0` compiles the unconditional
    // 1 that 4.13 wrote, which is the only arm that can arbitrate this.
    const rdyOut = CASC_DATA
      ? select(nHas.greaterThan(0.5).and(nBlocked.greaterThanEqual(nHas)),
        float(READY_EMPTY), float(1)).toVar()
      : float(1);
    wpInfo.element(infoIdx(gc, 2)).assign(vec4(i2.xyz, rdyOut));
    // The two counters every existing receipt prints as "probes" — reused so
    // `profile.gi2` and the boot probe keep meaning what they say, one bump per
    // probe UPDATED this frame rather than per probe placed on a screen tile.
    bump(STATS.probesPlaced, k);
    bump(STATS.probesValid, k);
  })().compute(TRACE_SLOTS);

  // ══════════════════════════════════════════ SHADER: the compact sources, at the probe
  //
  // §19 3.12's rule, moved to the lattice: a compact source is NEXT-EVENT
  // estimated at the probe and removed from the transport, because whether one
  // of 64 fixed directions happens to land inside a 0.2 sr source is a
  // quantizer and no filter can undo it. `emitterSh` is the gather's own
  // expression (`gi2System.emitterDirectPass`'s on a scene build, the Cornell
  // panel's on the rig) so a lamp delivers ONE energy on every path.
  //
  // ⚠ IT RUNS OVER THE SAME BATCH AS `shPass`, immediately after it. The SH a
  // probe carries between its updates has to include this term, so the add and
  // the projection are the same event; adding it every frame to every probe
  // would multiply it by the round-robin period.
  const neePass = (LEAN || !emitterSh) ? null : Fn(() => {
    const k = instanceIndex.toVar();
    const rr = roundRobin(k);
    If(rr.kLocal.greaterThanEqual(rr.live), () => { Return(); });
    const gc = slotCell(rr).toVar();
    const i0 = wpInfo.element(infoIdx(gc, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });
    const p = i0.xyz.toVar();
    const faced = i0.w.greaterThan(1.5).toVar();
    const n = wpInfo.element(infoIdx(gc, 1)).xyz.toVar();
    // ⚠ THE RECEIVER'S NORMAL IS THE FACE OR NOTHING. An open-air probe has no
    // normal, and `shEval`'s cosine convolution supplies the receiver's cosine
    // at the PIXEL anyway — so the cull a screen probe can afford (skip the
    // source if it is behind me) is only taken where a face actually exists.
    const sh = emitterSh(p, select(faced, n, vec3(0)), faced);
    for (let i = 0; i < 9; i++) {
      const idx = shIdxW(gc, i);
      const cur = wpInfo.element(idx).toVar();
      wpInfo.element(idx).assign(vec4(cur.xyz.add(sh[i]), 0));
    }
  })().compute(TRACE_SLOTS);

  // ══════════════════════════════════════════ SHADER: clear (harness only)
  const clearPass = LEAN ? null : Fn(() => {
    const i = instanceIndex.toVar();
    wpOct.element(i).assign(uint(0));
  })().compute(ALL_CELLS * OCT * OCT_W);
  const clearInfoPass = LEAN ? null : Fn(() => {
    wpInfo.element(instanceIndex).assign(vec4(0));
  })().compute(ALL_CELLS * 3);

  // ══════════════════════════════════════════ THE RESOLVE'S TAPS (§U.3)
  //
  // These are the only things `gatherProbes`' resolve needs from this file.
  // They are node closures rather than a second kernel because the resolve has
  // to interpolate EIGHT of them per cascade per pixel and a function call per
  // tap is what the octahedral plan/fetch split (see `octPlan`) exists to avoid.
  //
  // ⭐⭐ THE CASCADE IS A RUNTIME NODE HERE, AND THAT IS A COMPILE-TIME DECISION.
  //
  // The obvious resolve is a JS loop over `NC` — every constant folded, no
  // select chains. It also emits the eight-corner block THREE TIMES, and the
  // eight-corner block is nine SH reads plus eight octahedral taps per corner:
  // measured at 3.13 it is already the largest expression in `resolveHalf`, and
  // Stage 4.3a's own receipt says a kernel's WGSL size is paid at BOOT, in
  // pipeline compile, in front of first light — the number 3.14 is gated on.
  // So the resolve runs ONE corner block inside a TSL `Loop` over the cascades
  // and every per-cascade constant arrives through `cascConst`: five selects
  // evaluated once per cascade, against two extra copies of the biggest
  // expression in the resolve.
  /**
   * Cascade `ccU`'s constants, as nodes. `pref` is the fallback's finest-first
   * preference (see the resolve's two-tier candidate) — a cascade four times
   * coarser is 64 times less preferred, which is the ratio of the volumes its
   * probes stand for.
   */
  // ⚠ `ratio³`, NOT A LITERAL 64. This is "the ratio of the volumes its probes
  // stand for" (below), which is `ratio³` — 64 at ×4 and 8 at ×2. A hard 64
  // under a ×2 schedule would prefer the coarse cascades eight times too
  // strongly in the tail, which is the one place the number is read.
  const CASC_PREF = Array.from({ length: NC }, (_, c) => (RATIO ** 3) ** (NC - 1 - c));
  const cascConst = (ccU) => {
    const sp = pickF(ccU, SPC).toVar();
    return {
      sp,
      dmax: pickF(ccU, DMAX).toVar(),
      org: pickV(ccU, originsU).toVar(),
      base: ccU.mul(uint(CELLS)).toVar(),
      pref: pickF(ccU, CASC_PREF).toVar(),
      /**
       * §19 3.15 — the surface bias AS A LENGTH, so the resolve stops choosing
       * which spacing to multiply by and the choice becomes one uniform the
       * receipts can flip. `wpBiasPerCasc = 0` is `s_0` (shipped, 15 cm
       * everywhere); `1` is `s_c` (3.14's first cut, 15/60/240 cm). See
       * `wpBiasPerCasc` — this is the bias-independence tell's only lever.
       */
      biasLen: wu.wpBias.mul(mix(float(SPC[0]), sp, wu.wpBiasPerCasc.clamp(0, 1))).toVar(),
    };
  };
  /** The lattice cell coords a world point falls between, and the fractions. */
  const cellFrameAt = (p, sp) => {
    const g = p.div(sp).sub(0.5).toVar();
    return { base: g.floor().toVar(), frac: g.sub(g.floor()).toVar(), g };
  };
  /**
   * ⭐⭐ THE HAND-OFF BAND — 3.14's answer to the horizon 3.13 measured.
   *
   * `1` where the point sits inside the inner 90 % of a cascade, ramping to `0`
   * at its outer face, measured in CELLS to the nearest face so it is a
   * continuous function of position and of nothing else. The resolve multiplies
   * a cascade's confidence by it, so a pixel leaving c0's 16 m cube hands over
   * to c1 across 1.6 m instead of falling off a cliff — and 3.13's boundary
   * CLAMP survives only on the LAST cascade, where there is nothing coarser to
   * hand to and an extrapolated ambient still beats the black this whole term
   * exists to rule out.
   */
  const bandAt = (g, org) => {
    const dx = min(g.x.sub(org.x), org.x.add(C - 1).sub(g.x)).toVar();
    const dy = min(g.y.sub(org.y), org.y.add(C - 1).sub(g.y)).toVar();
    const dz = min(g.z.sub(org.z), org.z.add(C - 1).sub(g.z)).toVar();
    return min(min(dx, dy), dz).div(BAND * C).clamp(0, 1);
  };
  const clampAt = (org, wcx, wcy, wcz) => [
    wcx.clamp(org.x, org.x.add(C - 1)),
    wcy.clamp(org.y, org.y.add(C - 1)),
    wcz.clamp(org.z, org.z.add(C - 1)),
  ];
  /** The GLOBAL cell index of a cascade's cell at these world coords. */
  const cellAtG = (base, wcx, wcy, wcz) => slotOf(wcx.toInt(), wcy.toInt(), wcz.toInt()).add(base);
  const infoAt = (gc, k) => wpInfo.element(infoIdx(gc, k));
  const shAt = (gc, i) => wpInfo.element(shIdxW(gc, i));
  /** Bilinear radiance out of an `octPlan`'s four offsets. */
  const octTapRad = (plan, gc) => {
    const t = plan.offs.map((o) => decodeRgbe(wpOct.element(octIdxW(gc, o))));
    return mix(mix(t[0], t[1], plan.au), mix(t[2], t[3], plan.au), plan.av);
  };
  /**
   * DDGI's Chebyshev visibility, out of the two moments this probe stores.
   *
   * ⭐⭐ THIS IS THE ANTI-LEAK, AND IT IS THE ONLY ONE THAT WORKS ON A NORMAL
   * THAT DOES NOT POINT AT THE WALL. A dark-room floor pixel beside a 5 cm
   * partition has a `+Y` normal, so neither the face gate nor the wrapped
   * cosine can tell it apart from the lit room's floor 40 cm away — but the ray
   * from the lit room's probe to that pixel crosses the partition, and the
   * probe's own distance map says so.
   *
   * ⚠ THE VARIANCE FLOOR IS NOT A FUDGE. Without it the test is a hard step at
   * the stored mean, and an 8×8 distance map has ~25° of angular resolution:
   * every pixel a few centimetres beyond where its own probe's nearest texel
   * happens to land would read as occluded. The floor is a FRACTION of the
   * CASCADE'S spacing — the scene's own length at that scale — so the soft band
   * is half a cell everywhere: 25 cm at c0, 4 m at c2.
   */
  const octTapVisAt = (plan, gc, dist, dmax, sp) => {
    const w = plan.offs.map((o) => wpOct.element(octIdxW(gc, o).add(uint(1))));
    const m1 = mix(mix(meanOf(w[0], dmax), meanOf(w[1], dmax), plan.au),
      mix(meanOf(w[2], dmax), meanOf(w[3], dmax), plan.au), plan.av).toVar();
    const rm = mix(mix(rmsOf(w[0], dmax), rmsOf(w[1], dmax), plan.au),
      mix(rmsOf(w[2], dmax), rmsOf(w[3], dmax), plan.au), plan.av).toVar();
    const fl = wu.wpVarFloor.mul(sp).toVar();
    const varr = rm.mul(rm).sub(m1.mul(m1)).max(fl.mul(fl)).toVar();
    const dd = dist.sub(m1).toVar();
    const ch = varr.div(varr.add(dd.mul(dd))).toVar();
    const v = select(dist.lessThanEqual(m1), float(1), ch.mul(ch)).toVar();
    return mix(float(1), v, wu.wpVisOn.clamp(0, 1));
  };

  const describe = () => ({
    tier, cells: C, cellCount: CELLS, cascades: NC, ratio: RATIO,
    spacing: SP0, extent: EXT[0], reach: EXT[NC - 1], band: BAND,
    liveLevel: LMIN.slice(), spacings: SPC.slice(), extents: EXT.slice(),
    slots: SLOTS.slice(), slotBase: SLOT_BASE.slice(),
    traceSlots: TRACE_SLOTS, block: BLOCK, blocks: BLOCKS, oct: OCT,
    raysPerFrame: TRACE_SLOTS * OCT, distMax: DMAX.slice(),
    // §19 3.15 — what every receipt has to print to be about this stage.
    intervals: INTERVALS, beta: BETA_C, r0: R0C * SP0, r0Cells: R0C,
    tStart: TSTART.slice(), tEnd: TEND.slice(),
    mergePasses: mergePasses.length, seeded: !!seedPass,
    // §19 3.16 — the three arms, so a receipt cannot claim a stage it did not
    // build. `reachLast` is the number fix 2 actually moves.
    placeInCell: PLACE_IN_CELL, reachLattice: REACH_LATTICE, splitOwn: SPLIT_OWN,
    reachLast: REACH_LAST, octWords: OCT_W, alpha: SPLIT_OWN ? 0.25 : (INTERVALS ? 1 : 0.25),
    // §19 4.12 — the two arms of the near-band unit, so a receipt cannot claim
    // a stage it did not build. `covBelow = 0` is 3.15's containment-only rule.
    covBelow: COV_BELOW, thinT: globalThis.__gi2ThinT === 0 ? 0 : 1,
    // ⚠ NO FUNCTIONS IN HERE. `describe()` crosses `page.evaluate` in every
    // receipt this module has; a method would be dropped by the structured
    // clone and read as `undefined` at the far end.
    // §19 5.4b — the build arm, so a receipt cannot report a lattice that was
    // not built. `bytes` below are ZERO under it, not "small": nothing is
    // allocated and nothing is dispatched.
    lean: LEAN,
    bytes: LEAN ? { oct: 0, sh: 0, info: 0, infoTotal: 0, list: 0 } : {
      oct: ALL_CELLS * OCT * OCT_W * 4,
      // §19 3.17 — one array; the split is kept in the receipt because the two
      // halves are still two different things to reason about.
      sh: ALL_CELLS * 9 * 16,
      info: ALL_CELLS * 3 * 16,
      infoTotal: ALL_CELLS * INFO_VEC * 16,
      list: LIST_WORDS * NC * 4,
    },
    totalMB: LEAN ? 0 : +(((ALL_CELLS * OCT * OCT_W * 4) + (ALL_CELLS * 9 * 16) + (ALL_CELLS * 3 * 16)
      + LIST_WORDS * NC * 4) / 1048576).toFixed(2),
  });

  // ── the lattices' own placement ───────────────────────────────────────────
  const origins = Array.from({ length: NC }, () => new Int32Array(3));
  let placed = false;
  const setCamera = (pos) => {
    const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    let scrolled = false;
    for (let c = 0; c < NC; c++) {
      for (let a = 0; a < 3; a++) {
        const camCell = Math.floor(p[a] / SPC[c]);
        const next = stepLatticeOrigin(camCell, placed ? origins[c][a] : null, C);
        if (!placed || next !== origins[c][a]) scrolled = true;
        origins[c][a] = next;
      }
      originsU[c].value.set(origins[c][0], origins[c][1], origins[c][2]);
    }
    placed = true;
    return { scrolled, origins: origins.map((o) => [...o]) };
  };
  const reset = () => { placed = false; };

  /** Live probe count PER CASCADE, out of a readback of `wpList`. */
  const readLive = (u32) => Array.from({ length: NC }, (_, c) => u32[c * LIST_WORDS + CTL_OFF]);

  /**
   * §19 3.14 — the four GPU-ONLY buffers, for the caller's mirror detach.
   *
   * ⭐⭐ THE CASCADES TRIPLED THE LATTICE AND THE JS HEAP MUST NOT PAY IT TWICE.
   * Every one of these is written by a kernel and read by a kernel; the only
   * CPU reader is a READBACK (`readLive`), which copies out of the GPU buffer
   * and never touches `attr.array`. So the full-size typed arrays three keeps
   * alive after the first upload are dead weight — 70 MB of it at the desktop
   * cascades — and `detachCpuMirror` can transfer them away the frame after
   * they are bound. See `gi2System`'s drain, which is what actually calls this.
   */
  const cpuMirrors = () => [wpOct.value, wpInfo.value, wpList.value]
    .filter((a) => a?.isBufferAttribute === true);

  return {
    tier, cells: C, cellCount: CELLS, cascades: NC, spacing: SP0, spacings: SPC,
    extents: EXT, traceSlots: TRACE_SLOTS, slots: SLOTS, band: BAND,
    uniforms: { ...wu, ...Object.fromEntries(originsU.map((o, c) => [`wpOrigin${c}`, o])) },
    origins: originsU,
    // §19 3.17 — `wpSh` IS `wpInfo` now; the alias is kept so a caller that
    // named the SH buffer still resolves to the array that holds it.
    buffers: { wpOct, wpSh: wpInfo, wpInfo, wpList },
    offsets: { FLAG_OFF, LIST_OFF, BASE_OFF, CTL_OFF, LIST_WORDS },
    passes: {
      alloc: allocPass, count: countPass, scan: scanPass, fill: fillPass,
      seed: seedPass, trace: tracePass, mergeVis: mergeVisPass, sh: shPass, nee: neePass,
      /** §19 3.15 — coarsest-first, one per cascade below the top. */
      merge: mergePasses.slice(),
      clear: clearPass, clearInfo: clearInfoPass,
    },
    /**
     * §U's per-frame order. The caller splices it into `frameOrder`.
     *
     * ⚠ THE SEED RUNS AFTER `alloc` AND BEFORE THE COMPACTION, and the merges
     * run between `trace` and `sh`. Both positions are the only ones that work:
     * `seedPass` reads the fresh flag `allocPass` writes and must be visible to
     * the resolve on the SAME frame the scroll happens; the merges must see the
     * trace's `own` and must be seen by the SH projection, or a probe's SH is a
     * frame behind its own map — which is the shape of bug §V.6's re-keyed slab
     * already cost this stage once.
     */
    frameOrder: LEAN ? [] : [
      allocPass, seedPass, countPass, scanPass, fillPass,
      // `mergeVis` between the trace and the merges: it needs this frame's own
      // probe placement, and its eight bits are what the merges weight by.
      tracePass, mergeVisPass, ...mergePasses, shPass, neePass,
    ].filter(Boolean),
    taps: {
      cascades: NC, spacingOf: (c) => SPC[c], extentOf: (c) => EXT[c],
      cascConst, cellFrameAt, inLatticeAt, bandAt, clampAt, cellAtG,
      infoAt, shAt, octTapRad, octTapVisAt,
      // §19 3.17 — one cascade's irradiance, alone. Used by the trace's
      // cold-hit fallback and by the corridor rig's per-cascade crop census.
      irradianceAtCasc,
    },
    setCamera, reset, readLive, describe, cpuMirrors,
    dispose() {
      for (const b of [wpOct, wpInfo, wpList]) {
        if (b?.value) { b.value.array = b.value.array.constructor.from([]); b.value.dispose?.(); }
      }
    },
  };
}
