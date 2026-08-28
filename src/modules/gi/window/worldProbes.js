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

/**
 * Tier constants. `cells`, `spacing`, `ratio` and `cascades` are compiled into
 * the WGSL (they are the addressing); `traceSlots` is the frame's ray budget
 * divided by 64, split across the cascades by `share`.
 *
 * `cells` must be a POWER OF TWO — the toroidal mask is `& (cells − 1)`, the
 * same identity `windowStore`'s `& 63` is.
 *
 * Cascade `c` spans `cells · spacing · ratio^c`: 16 / 64 / 256 m on desktop,
 * 16 / 64 m on the phone tiers (three window levels, so a third cascade would
 * have no occupancy to read past 128 m — see `LMIN`).
 *
 * ⭐ THE SHARE IS THE UPDATE CADENCE. A cascade with 10 % of the slots and a
 * comparable live count is re-traced a seventh as often as one with 70 %, which
 * is RC's own law expressed in the only currency this file has. Nothing else in
 * the file knows that a cascade is "slow".
 */
export const WORLD_TIERS = {
  phone: { cells: 16, spacing: 1.0, traceSlots: 1024, block: 64, cascades: 2, ratio: 4, share: [0.75, 0.25] },
  medium: { cells: 16, spacing: 1.0, traceSlots: 1024, block: 64, cascades: 2, ratio: 4, share: [0.75, 0.25] },
  high: { cells: 32, spacing: 0.5, traceSlots: 6144, block: 256, cascades: 3, ratio: 4, share: [0.70, 0.20, 0.10] },
  ultra: { cells: 32, spacing: 0.5, traceSlots: 6144, block: 256, cascades: 3, ratio: 4, share: [0.70, 0.20, 0.10] },
};

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
export function intervalStarts(spacing0, cascades, r0Cells = R0_CELLS) {
  const r0 = r0Cells * spacing0;
  return Array.from({ length: cascades }, (_, i) => r0 * ((BETA ** i - 1) / (BETA - 1)));
}
/**
 * `[t_1 … t_NC]` — cascade i's interval END. The LAST cascade ends at the
 * window's own horizon (`RAY_MAX`): past that there is no occupancy to march
 * and the only honest answer is the sky, which is why the last cascade is also
 * the ONLY one that credits sky on a miss.
 */
export function intervalEnds(spacing0, cascades, rayMax, r0Cells = R0_CELLS) {
  const s = intervalStarts(spacing0, cascades, r0Cells);
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
  const NC = Math.max(1, Math.min(spec.cascades, globalThis.__gi2Cascades ?? spec.cascades));
  const RATIO = spec.ratio;
  const SP0 = spec.spacing;
  const BLOCK = spec.block;
  const BLOCKS = CELLS / BLOCK;
  const ALL_CELLS = CELLS * NC;

  const {
    u, octU, cellOfWorld, dominantFace, hitRadiance, emitterSh, bump, STATS, RAY_MAX, OCT,
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
  const TSTART = INTERVALS ? intervalStarts(SP0, NC, R0C) : SPC.map(() => 0);
  const TEND = INTERVALS ? intervalEnds(SP0, NC, RAY_MAX, R0C) : SPC.map(() => RAY_MAX);
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
    const sh = spec.share.slice(0, NC);
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
  // with the lattice: two u32 per (cell, texel).
  //   word 0  RGBE radiance (0 = never written — the same sentinel the cache's
  //           own words use, so "no data" and "black" stay distinguishable)
  //   word 1  n<<24 | rmsQ<<12 | meanQ   — the two distance moments
  const wpOct = instancedArray(new Uint32Array(ALL_CELLS * OCT * 2), "uint");
  /** Nine SH2 coefficients per cell. What the resolve reads. */
  const wpSh = instancedArray(new Float32Array(ALL_CELLS * 9 * 4), "vec4");
  /**
   * Three vec4 per cell:
   *   0  (probe position, state)   state 0 dead · 1 open-air · 2 faced
   *   1  (face normal, 0)
   *   2  (world cell coord, ready) ready 0 = the map is not trustworthy yet
   */
  const wpInfo = instancedArray(new Float32Array(ALL_CELLS * 3 * 4), "vec4");
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
  const wpList = instancedArray(new Uint32Array(LIST_WORDS * NC), "uint");

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
     */
    wpAlpha: uniform(INTERVALS ? 1 : 0.25),
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
  const infoIdx = (gc, k) => gc.mul(uint(3)).add(uint(k));
  const shIdxW = (gc, k) => gc.mul(uint(9)).add(uint(k));
  const octIdxW = (gc, texel) => gc.mul(uint(OCT * 2)).add(texel.mul(uint(2)));
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
  /** The same word with `T` cleared — the merge's idempotence (see `mergeFor`). */
  const clearT = (w) => bitAnd(w, uint((~T_BIT) >>> 0));

  // ══════════════════════════════════════════ SHADER: probeAlloc (§U.1)
  //
  // One thread per (CASCADE, LATTICE CELL). Decides, from the window's own
  // occupancy, whether this cell holds a live probe; where that probe stands;
  // and which face (if any) it represents. Everything it writes is a pure
  // function of (cascade, cell, origin, occupancy) — run it twice on one frame
  // and it writes the same bytes, which is what lets it run every frame instead
  // of maintaining state nobody can audit.
  const allocPass = Fn(() => {
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
      // Whole cells of the ORIGIN's own level, up to the trace's own escape
      // budget. Beyond that the cell is buried and holds no probe: a probe
      // inside a solid is the classic lattice leak, and refusing to place one
      // is cheaper and safer than any weight that tries to discount it.
      Loop({ start: 1, end: 4, name: "wpEscape" }, ({ wpEscape }) => {
        const q = p.add(nn.mul(vl.mul(float(wpEscape).add(0.5)))).toVar();
        const qc = cellOfWorld(q);
        If(occAt(qc.level.toUint(), qc.vi).not(), () => {
          pos.assign(q);
          state.assign(2);
          Break();
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
  const countPass = Fn(() => {
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

  const scanPass = Fn(() => {
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

  const fillPass = Fn(() => {
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
  const tracePass = Fn(() => {
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
    const fresh = wpInfo.element(infoIdx(gc, 2)).w.lessThan(0.5).toVar();

    const dir = octU.element(texel).xyz.toVar();
    const addr = octIdxW(gc, texel).toVar();
    // A FACED probe owns one hemisphere; the back half is a HOLE, not a black
    // sample, and it is written rather than skipped for the reason
    // `probeTracePass` gives: a slot this kernel returns from early would hold
    // whatever it held before the cell was re-keyed.
    If(faced.and(dot(dir, faceN).lessThanEqual(0.02)), () => {
      wpOct.element(addr).assign(uint(0));
      wpOct.element(addr.add(uint(1))).assign(uint(0));
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
    const fSp = pickF(rr.casc, SPC_FINER).toVar();
    const fOrg = pickV(rr.casc, ORG_FINER).toVar();
    const fc = pos.div(fSp).floor().toVar();
    const coveredBelow = rr.casc.greaterThan(uint(0))
      .and(inLatticeAt(fOrg, fc.x, fc.y, fc.z)).toVar();
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
    const rd = hitRadiance(r, dir, k).toVar(); // (rgb, hitDistance); sky on a miss

    // ⭐⭐ SKY IS CREDITED BY THE LAST CASCADE ALONE, AND THAT IS WHAT KEEPS THE
    // MERGE ENERGY-EXACT. `hitRadiance` returns `skyColor` on any miss, so a
    // non-final cascade would otherwise contribute sky AND then add its parent's
    // sky through `T` — the same photon twice, once per cascade. A non-final
    // miss stores radiance 0 and `T = 1`: "nothing in my band, ask my parent".
    const rgbNew = INTERVALS
      ? select(inBand, rd.xyz,
        select(hitAny.not().and(isLast), u.skyColor, vec3(0))).toVar()
      : rd.xyz.toVar();
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

    const prev0 = wpOct.element(addr).toVar();
    const prev1 = wpOct.element(addr.add(uint(1))).toVar();
    const had = nOf(prev1).greaterThan(uint(0)).and(fresh.not()).toVar();
    // Under the merge α is 1 by algebra, not by taste — see `wpAlpha`.
    const a = INTERVALS ? float(1).toVar() : select(had, wu.wpAlpha.clamp(0, 1), float(1)).toVar();
    const rgb = INTERVALS ? rgbNew : mix(decodeRgbe(prev0), rgbNew, a).toVar();
    const d = min(dGlobal, dmax).toVar();
    const m1 = INTERVALS ? d : mix(meanOf(prev1, dmax), d, a).toVar();
    const pr = rmsOf(prev1, dmax).toVar();
    const m2 = INTERVALS ? d.mul(d) : mix(pr.mul(pr), d.mul(d), a).toVar();
    wpOct.element(addr).assign(encodeRgbe(rgb));
    wpOct.element(addr.add(uint(1))).assign(
      packMoments(nOf(prev1).add(uint(1)).min(uint(63)), m1, sqrt(m2.max(0)), dmax, tNew),
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
  const mergeVisPass = !(INTERVALS && NC > 1) ? null : Fn(() => {
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
    const own = decodeRgbe(wpOct.element(addr)).toVar();
    wpOct.element(addr).assign(encodeRgbe(own.add(parent)));
    wpOct.element(addr.add(uint(1))).assign(clearT(w1));
  })().compute([Math.ceil(SLOTS[ci] / 8), OCT_GROUPS], [8, 8, 1]);
  const mergePasses = (INTERVALS && NC > 1)
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
  const seedPass = !(INTERVALS && NC > 1) ? null : Fn(() => {
    const gc = instanceIndex.toVar();
    const casc = shiftRight(gc, uint(CELLB)).toVar();
    const i0 = wpInfo.element(infoIdx(gc, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });                       // dead cell
    const i2 = wpInfo.element(infoIdx(gc, 2)).toVar();
    If(i2.w.greaterThan(0.75), () => { Return(); });                   // already traced
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
    for (let i = 0; i < 9; i++) wpSh.element(shIdxW(gc, i)).assign(vec4(sh[i], 0));
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
  const shPass = Fn(() => {
    const k = instanceIndex.toVar();
    const rr = roundRobin(k);
    If(rr.kLocal.greaterThanEqual(rr.live), () => { Return(); });
    const gc = slotCell(rr).toVar();
    const i0 = wpInfo.element(infoIdx(gc, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });
    const faced = i0.w.greaterThan(1.5).toVar();
    const faceN = wpInfo.element(infoIdx(gc, 1)).xyz.toVar();

    // Pass 1: the cosine-weighted mean over the directions this probe HAS.
    const acc = vec3(0).toVar();
    const wsum = float(0).toVar();
    Loop({ start: 0, end: OCT, name: "wpMean" }, ({ wpMean }) => {
      const t = uint(wpMean).toVar();
      const addr = octIdxW(gc, t).toVar();
      const w1 = wpOct.element(addr.add(uint(1))).toVar();
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
    for (let i = 0; i < 9; i++) wpSh.element(shIdxW(gc, i)).assign(vec4(sh[i], 0));
    const i2 = wpInfo.element(infoIdx(gc, 2)).toVar();
    wpInfo.element(infoIdx(gc, 2)).assign(vec4(i2.xyz, 1));
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
  const neePass = !emitterSh ? null : Fn(() => {
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
      const cur = wpSh.element(idx).toVar();
      wpSh.element(idx).assign(vec4(cur.xyz.add(sh[i]), 0));
    }
  })().compute(TRACE_SLOTS);

  // ══════════════════════════════════════════ SHADER: clear (harness only)
  const clearPass = Fn(() => {
    const i = instanceIndex.toVar();
    wpOct.element(i).assign(uint(0));
  })().compute(ALL_CELLS * OCT * 2);
  const clearInfoPass = Fn(() => {
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
  const CASC_PREF = Array.from({ length: NC }, (_, c) => 64 ** (NC - 1 - c));
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
  const shAt = (gc, i) => wpSh.element(shIdxW(gc, i));
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
    intervals: INTERVALS, beta: BETA, r0: R0C * SP0, r0Cells: R0C,
    tStart: TSTART.slice(), tEnd: TEND.slice(),
    mergePasses: mergePasses.length, seeded: !!seedPass,
    // ⚠ NO FUNCTIONS IN HERE. `describe()` crosses `page.evaluate` in every
    // receipt this module has; a method would be dropped by the structured
    // clone and read as `undefined` at the far end.
    bytes: {
      oct: ALL_CELLS * OCT * 2 * 4,
      sh: ALL_CELLS * 9 * 16,
      info: ALL_CELLS * 3 * 16,
      list: LIST_WORDS * NC * 4,
    },
    totalMB: +(((ALL_CELLS * OCT * 2 * 4) + (ALL_CELLS * 9 * 16) + (ALL_CELLS * 3 * 16)
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
  const cpuMirrors = () => [wpOct.value, wpSh.value, wpInfo.value, wpList.value]
    .filter((a) => a?.isBufferAttribute === true);

  return {
    tier, cells: C, cellCount: CELLS, cascades: NC, spacing: SP0, spacings: SPC,
    extents: EXT, traceSlots: TRACE_SLOTS, slots: SLOTS, band: BAND,
    uniforms: { ...wu, ...Object.fromEntries(originsU.map((o, c) => [`wpOrigin${c}`, o])) },
    origins: originsU,
    buffers: { wpOct, wpSh, wpInfo, wpList },
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
    frameOrder: [
      allocPass, seedPass, countPass, scanPass, fillPass,
      // `mergeVis` between the trace and the merges: it needs this frame's own
      // probe placement, and its eight bits are what the merges weight by.
      tracePass, mergeVisPass, ...mergePasses, shPass, neePass,
    ].filter(Boolean),
    taps: {
      cascades: NC, spacingOf: (c) => SPC[c], extentOf: (c) => EXT[c],
      cascConst, cellFrameAt, inLatticeAt, bandAt, clampAt, cellAtG,
      infoAt, shAt, octTapRad, octTapVisAt,
    },
    setCamera, reset, readLive, describe, cpuMirrors,
    dispose() {
      for (const b of [wpOct, wpSh, wpInfo, wpList]) {
        if (b?.value) { b.value.array = b.value.array.constructor.from([]); b.value.dispose?.(); }
      }
    },
  };
}
