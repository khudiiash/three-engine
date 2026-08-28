// GI2 — THE GATHER: SCREEN PROBES ON THE WINDOW (audits §L, Stage 3.1)
//
// Kernels, in the order a frame runs them:
//
//   hzbBuild / hzbReduce  closest-depth pyramid over the gbuffer (§L.2's first
//                         ray segment needs it; 5 mips, one storage buffer)
//   probePlace            one probe per T×T tile, Hammersley-jittered anchor,
//                         sky rejected over 4 candidates, reprojected against
//                         last frame's probe grid (§L.1 + §L.3's validation)
//   probeTrace            one thread per (probe, ray): HZB screen segment →
//                         `traceWindow` → radiance-cache read, fresh slot
//                         shaded on the spot, miss = sky. Accumulates into the
//                         probe's octahedral texel (§L.2 + §L.3)
//   probeFilter           3×3 probe-space bilateral + the 2×2 oct mip + SH2
//                         (§L.4, and §L.5's phone path)
//   resolve               4 corner probes, bilinear × plane × normal, cosine
//                         sum over the oct map (desktop) or SH eval (phone) →
//                         the two screen textures (§L.5)
//   composite             albedo × irradiance + glossy × F0 + emissive
//   injectLitFrame        1/16 of pixels write their lit colour into their own
//                         voxel face (§L.6) — the multibounce feed
//
// Everything temporal lives in the probe's oct map, in PROBE SPACE, validated
// against world position and normal. No history of the final image, no AO
// history (the standing user rule).
//
// ══ THE ENVELOPE, PER KERNEL (PLAN §4.6) ═════════════════════════════════════
//
// ≤ 6 storage buffers, no workgroup memory, 2-D 8×8 dispatches for the screen
// passes, scene-free WGSL. The probe atlas and the probe meta are each ONE
// buffer holding BOTH frames (current and previous halves selected by a uniform
// base offset) rather than two ping-ponged buffers — that is what keeps
// `probeTrace`, the widest kernel, inside the envelope: window, cache, meta,
// oct, hzb, stats = 6 exactly. Every dimension that moves with the RESOLUTION
// (probe grid, mip sizes, screen size) is a uniform; every dimension that is a
// TIER choice (tile, rays, oct resolution, history depth, mips, steps) is
// compiled in.
//
// ══ WHERE §L BENDS, AND WHY ══════════════════════════════════════════════════
//
// 1. RAY DIRECTIONS ARE JITTERED INSIDE THEIR TEXEL. §L.2 says "octahedral
//    texel centres". Fixed centres make this estimator BIASED, not noisy: every
//    probe in the scene samples the same 64 directions, so a light that falls
//    between two texel centres is under-counted at EVERY probe and neither the
//    3×3 filter nor the temporal accumulation can remove it — they average
//    estimates that are all wrong the same way. The texel is supposed to hold
//    the MEAN radiance over its solid angle, and a jittered sample estimates
//    that mean without bias. The jitter is what makes §L.5's `Σ L·cos·Δω` an
//    integral rather than a point sample.
//
// 2. A RAY THREAD OWNS A WINDOW OF TEXELS, NOT ONE TEXEL. §L.2's back-
//    hemisphere rule ("those texels store 0 and are skipped") wastes half the
//    launched threads if each is handed one texel index: a WORLD-oriented oct
//    map puts ~32 of its 64 texels behind any given probe. Instead thread k
//    owns the `64/R` consecutive texels from `k·64/R` (rotated per frame and
//    per probe) and takes the FIRST front-facing one. The windows stay
//    disjoint, so there is still no write race, and the yield rises from ~50 %
//    to ~95 % of launched threads at R = 16.
//
// 3. THE ATLAS TEXEL'S ALPHA CARRIES THREE NUMBERS. §L.2 wants `(radiance,
//    hitDistance)` in the texel, §L.3 wants the per-texel sample count, and
//    §19 Stage 3.6's hysteresis wants the texel's own σ. There is one channel.
//    It holds `n·2^18 + distQ·2^10 + sigQ`, three integer fields that fill
//    exactly the 24 bits an f32 is exact over — see `PACK_N` below.
//
// 4. RGBE, NOT R11G11B10, IN THE CACHE — see `radianceCache.js`'s header.
//
// 5. STATISTICS ARE STRIPED AND GATED. §L.7 asks for eleven per-frame counters
//    over a kernel that launches 130 k threads. One `atomicAdd` per ray on one
//    word is a serialization that would show up as the kernel's cost and be
//    reported as if it were the gather's. They are spread over 64 words each
//    AND wrapped in a uniform branch, so the same kernel measures its own
//    shipping cost with `statsOn = 0` and produces the receipts with it on.
import * as THREE from "three/webgpu";
import {
  Break, Fn, If, Loop, Return, atomicAdd, atomicLoad, atomicStore, bitAnd, bitOr, bitXor, dot, exp,
  exp2, float, globalId, instanceIndex, instancedArray, int, ivec2, log2, max, min, mix, normalize,
  select, shiftLeft, shiftRight, smoothstep, sqrt, step, storage, texture, textureStore, uint, uniform,
  uniformArray, vec2, vec3, vec4,
} from "three/tsl";
import { FACE_OFF, LEVEL_WORDS, N, OCC_OFF, PAL_OFF } from "./windowStore.js";
import { FACE_AX_SHIFT } from "./windowTrace.js";
import { normalOfFace } from "./radianceCache.js";
import { octahedralUV } from "../srcOctahedral.js";
import { createWorldProbes, worldCascadeCount } from "./worldProbes.js";

/**
 * ⭐⭐⭐ §19 STAGE 3.13 — THE ONE BUILD CONSTANT (audits §U).
 *
 * `true` puts the diffuse path on the WORLD-ANCHORED lattice
 * (`worldProbes.js`) and stops building the screen-probe placement, trace,
 * filter and SH bilateral altogether; `false` is 3.12 exactly, out of the same
 * source.
 *
 * ⚠ IT FLIPS ONLY WHEN EVERY RECEIPT BEATS 3.12'S — orbit sign flips, Δp50/p95,
 * the §T at-rest trio, the moved panel, the Cornell bracket, the leak gate, the
 * thin-wall interior arm and the chain's own milliseconds. Until then the
 * constant stays `false` and the receipts drive the world path through
 * `globalThis.__gi2WorldProbes`, which is the same "a receipt asks for it
 * BEFORE the build" discipline `__gi2NoiseDump` follows — one binary, one
 * shader cache, both arms expressible from one checkout.
 */
// §19 3.17 (08-28): DEFAULT ON. The architect overruled the row-by-row flip
// gate: the rows still failing (a 9 m light pool on the 60 m corridor rig that
// 8 m probes cannot resolve; +136 MB on one boot; 11 vs 10 phone frames;
// motion flips above one earlier arm) are not the user's complaints, and on
// those (noise under motion, thin-feature blobs, first light) the world path is
// strictly better. `__gi2WorldProbes = false` pre-boot restores screen probes.
//
// 08-28 09:00 (user screenshots): DEFAULT OFF AGAIN. On Bistro the world path
// floods the WHOLE scene red (the neon sign) or green (the seated lamps) —
// admitted emitters over-weighted by orders of magnitude in the world probes'
// emitter path. Screen probes show normal colours. `__gi2WorldProbes = true`
// pre-boot opts back in while the energy bug is fixed.
//
// ⭐⭐ 08-28 10:20: DEFAULT ON AGAIN, AND THE REVERT ABOVE IS SPENT. The flood
// was never a property of the world path: 4.3d found it at its CAUSE — the
// emitter ADMISSION record never ran at boot, so every candidate emissive mesh
// was admitted at full power, and the lattice's own NEE (which the screen path
// does not run — `emitterDirectPass` is skipped under world probes) delivered
// all of it. With the admission fixed the flood receipt measures the world path
// CLEAN at the same pose: pavement chroma 0.027 against the screen path's
// 0.023, where the flood read orders of magnitude. Both reasons the constant
// was ever false are closed, and the reason it should be true is the user's
// standing complaint: under motion a SCREEN probe re-anchors to whatever world
// point its tile happens to cover, and 3.18's flip census puts that path 15-29
// points above its own null floor while the world path sits AT the floor. Light
// that accumulates gradually needs an accumulator that stands still, which is
// what a world lattice is.
//
// ⚠ `__gi2WorldProbes = false` PRE-BOOT IS STILL THE SCREEN PATH, EXACTLY. Both
// arms stay expressible from one checkout and one shader cache — `probe:gi2-
// puddle`, `probe:gi2-motion` and `probe:gi2-flood` are all run both ways off
// this one binary, which is what makes "the world path is better HERE" a
// reading rather than a belief.
export const WORLD_PROBES = (globalThis.__gi2WorldProbes ?? true) !== false;

/**
 * Tier constants. These, and only these, are compiled into the WGSL.
 *
 * `tile` and `rays` are PLAN §4.6's row; `oct` is §L's `O = 8` (64 directions);
 * `history` is §L.3's `H`; `sh` selects the resolve's DIFFUSE integrator.
 *
 * ⭐⭐ H IS 32, NOT 4, AND THAT IS THE WHOLE "GI IS NOISY" REPORT (§19 3.6).
 *
 * §L.3 wrote `H = 4` and the estimator inherited it. `H` is the cap on the
 * per-texel sample count, so `α = 1/min(n+1, H)` settles at `1/H`: at 4 that
 * is a FOUR-FRAME memory — one to four samples per direction — and a single
 * Monte-Carlo ray through a 4π/64 sr texel has a variance an order of
 * magnitude wide inside its own solid angle. Four of them averaged is still
 * noise. The SRC path that this replaces was noiseless because its
 * world-anchored accumulators ran `α ≈ 0.02`, a ~50-frame memory.
 *
 * The reason `H = 4` looked like a ceiling is that a screen-space probe used
 * to be a per-frame object; it is not any more. Since 3.2 the anchor is
 * STICKY and the probe is validated against its own WORLD POSITION and
 * normal, so a long memory cannot smear across a camera move — the validation
 * throws the history away when the surface under the probe changes. What a
 * long memory CAN smear is a change in the WORLD, and that is what the
 * variance-aware hysteresis below is for: it is the only thing in the chain
 * whose job is to shorten the memory, and it must fire on a moved lamp and
 * never on shot noise.
 *
 * ⚠ `sh` is `true` on every tier since Stage 3.2. §L.5 offered "SH on phone,
 * oct sum on desktop; measure both" — measured, the two agree to 1.5 % on the
 * diffuse crops and the sum costs 4× the whole resolve. A tier row that can
 * only ever hold one value is kept as a row so the A/B stays expressible, not
 * because a tier is expected to differ.
 */
/**
 * ⭐⭐⭐ §19 STAGE 3.10 — THE TILE IS 16 AND `rays` IS DEAD, BECAUSE THE
 * ESTIMATOR IS NOT A MONTE-CARLO ONE ANY MORE.
 *
 * THE USER'S RULE: "there must be NO noise at all — that was the initial idea
 * of radiance cascades", and then: "we can use some kind of temporal
 * accumulation, but it must not be noise — in UE5 light just gradually
 * accumulates, smoothly, like light is slower than c."
 *
 * Those two sentences are one contract, and it is a contract about the INPUT,
 * not about a filter on the output:
 *
 *   · NO STOCHASTIC INPUT ANYWHERE ON THE IMAGE PATH. Every probe evaluates
 *     its COMPLETE fixed direction set — all 64 octahedral texels, at their
 *     texel CENTRES — every frame. No jitter inside the texel, no per-frame
 *     rotation, no subset chosen by a hash, no per-probe seed. Two consecutive
 *     frames of a parked camera trace the same rays and get the same answer,
 *     so "temporal noise at rest" is not small — it is ZERO by construction.
 *   · SMOOTHING IS ALLOWED, GRAIN IS NOT. An EMA over noise-free evaluations
 *     can only add LAG (light arriving late, which is what UE5 looks like); it
 *     can never add grain, because there is no grain in what it averages. So
 *     the probe map keeps a FIXED-α blend against the reprojected previous map
 *     (`octAlpha`) and the world cache keeps its own EMA — and every
 *     variance-driven, hash-driven and count-driven rule that used to sit on
 *     top of them is gone. See `probeTracePass`.
 *
 * ⚠ WHAT THIS COSTS, AND WHERE IT IS PAID BACK. Sixty-four directions a frame
 * is 4× the old per-probe budget, so the probe GRID gives 4× back: tile 16 at
 * desktop (was 8), tile 24 on phone (was 16). At 1650×970 that is 104×61 =
 * 6 344 probes × 64 = 406 k rays a frame against 25 254 × 16 = 404 k — the
 * SAME ray budget, spent completely instead of stochastically. About half the
 * texels of a world-oriented oct map face away from the probe and cost one
 * `uniformArray` read and a store, so the traced count is ~200 k.
 *
 * ⛔ `rays`, `mature` AND `history` ARE NOT READ BY THE TRACE ANY MORE. They
 * stay in the row because `probePlace`'s carry arm, `rayBudget` and the
 * harness's lever table still name them, and deleting a row a receipt sets
 * would make the A/B unexpressible rather than unnecessary.
 */
export const GATHER_TIERS = {
  phone: { tile: 24, rays: 8, oct: 8, history: 32, sh: true, hzbSteps: 12, shRadius: 2, mature: 4, shadeProb: 0.03, skyRays: 2 },
  medium: { tile: 24, rays: 8, oct: 8, history: 32, sh: true, hzbSteps: 12, shRadius: 2, mature: 4, shadeProb: 0.03, skyRays: 2 },
  high: { tile: 16, rays: 16, oct: 8, history: 32, sh: true, hzbSteps: 12, shRadius: 2, mature: 8, shadeProb: 0.06, skyRays: 4 },
  ultra: { tile: 16, rays: 16, oct: 8, history: 32, sh: true, hzbSteps: 12, shRadius: 2, mature: 8, shadeProb: 0.06, skyRays: 4 },
};

/**
 * ⭐⭐ §19 STAGE 3.7 P.3 — `rays` ABOVE IS THE FRAME'S BUDGET NOW, NOT A COUNT.
 *
 * Until 3.7 every probe traced `R` directions every frame whatever it already
 * knew: the probe just placed on a wall it has never seen and the probe that
 * has stared at the same flat floor for two hundred frames drew the same 16
 * rays. That single allocation is behind BOTH of the user's 3.7 reports — a
 * probe reprojected onto new world space shows a 16-of-64-direction estimate
 * for several frames ("very noisy on movement") while the settled probe beside
 * it spends 16 rays re-measuring a number it already has to four decimals.
 *
 * So the count follows the probe's own state (`probePlace` classifies, the
 * class rides `probeMeta` slot 2's `.z`):
 *
 *   FRESH    no history at all — the reprojection missed → one thread per oct
 *            texel, i.e. the whole front hemisphere in ONE frame.
 *   FLAGGED  reprojected, but fewer than half its front texels are mature
 *            (`n ≥ H/2`) → 32. This is where a moved lamp lands: the decaying
 *            hysteresis divides `n` on a real change, which un-matures the
 *            texels, which buys the probe rays. §P.4's "change needs rays, not
 *            forgetting" as a consequence of the maturity test rather than as
 *            a second mechanism.
 *   MATURE   everything else → `mature` (8 desktop / 4 phone), scaled DOWN by
 *            `rayBudget` when the fresh and flagged shares would take the frame
 *            past `probes × rays`. Mature bends because mature is converged.
 */
/**
 * ⭐⭐ 32, NOT 64, AND THE MEASUREMENT IS WHY (§19 Stage 3.7).
 *
 * §P.3 says "fresh probes get all 64 directions" and asks for the block form
 * and the prefix-sum form to be MEASURED against each other. Measured, at
 * 960×540 ultra: a 64-wide block dispatches 8160×64 = 522 k threads to do
 * 88 k rays' worth of work, and `probeTrace` cost 1.74 ms — 3.3 ns per THREAD
 * against 3.6's 6.2 ns per thread on a quarter as many. The kernel had become
 * launch-bound, and 83 % of the launches existed only to read one vec4 and
 * return. That is the block form's bill, and §P.3 wanted it on the table.
 *
 * A 32-wide block loses almost nothing, because 64 was never 64 real rays.
 * A world-oriented oct map puts about HALF its texels behind any given probe,
 * so a 64-thread block (one texel each, no window to search) traces ~32 of
 * them and idles the rest. At 32 threads each thread owns a TWO-texel window
 * and takes the first front-facing one — a ~87 % yield, i.e. ~28 distinct
 * directions, against the 64-thread block's ~32. Four directions of coverage
 * for half the launches.
 *
 * The remaining waste — 261 k launches for 88 k rays at rest, where every
 * probe is mature — is the block form's, and the honest next lever is a
 * dispatch whose WIDTH follows the frame (narrow at rest, wide while the
 * camera moves), which needs a mutable `count` rather than a second kernel.
 */
export const RAY_FRESH = 32;
export const RAY_FLAG = 16;
/** The floor under the mature share when the budget is tight. */
export const RAY_MATURE_MIN = 2;
/** Probe classes, as `probePlace` writes them into `probeMeta` slot 2's `.z`. */
export const CLS_MATURE = 0;
export const CLS_FLAG = 1;
export const CLS_FRESH = 2;
/**
 * §P.1's cap on the cache's running mean. Sixteen samples, then an EMA.
 *
 * ⚠ THE RE-SHADE IS A PROBABILITY, NOT §K.6's RELIGHT QUEUE. The rays already
 * visit exactly the faces that matter — a face nothing looks at needs no
 * radiance — so the VISIT DISTRIBUTION is the relight priority, for free, with
 * no list to maintain, no bricks to rank and no second kernel. The cost is
 * bounded by the window-hit count times `shadeProb`, both of which are printed.
 */
export const SHADE_N_CAP = 16;

/** HZB mips and §L.2's step budget — the tier row's DEFAULT, not the value. */
export const HZB_MIPS = 5;
export const HZB_STEPS = 24;
/** §L.2's "relative thickness 0.1", and the bias that keeps a ray off its own pixel. */
export const HZB_THICKNESS = 0.1;
export const HZB_ZBIAS = 0.02;
/** A depth that means "sky" in the pyramid — larger than any scene. */
export const HZB_FAR = 1e6;
/**
 * Palette slots. A material CLASS table, not a scene number; the LAST entry
 * (`PAL_ENTRIES - 1`) is "no surface" and `palAt` clamps a stale/unvoxelized
 * `PAL_NONE = 255` byte onto it.
 *
 * ⭐ §19 STAGE 4.0b — 16 → 64, and it is not a tuning change (audits §O.4).
 * Measured over Bistro's 131 materials / 1532 placements, the fixed 3-level
 * albedo lattice this table was built for carries 0.1113 mean absolute
 * per-channel error; a weighted median cut at 64 classes carries 0.0008 —
 * two orders better, and better than RGB565 PER VOXEL, which would double the
 * voxel store and break `windowVoxelize`'s packed-word MAX merge. The byte
 * allows 255; the cost of a class is 16 B of `palU` + 16 B of `palEmU`, so 64
 * classes is 2 KB of uniform against a 64 KB binding limit, and `palAt` is one
 * indexed uniform read at any N. 255 was declined on purpose: the k = 64
 * residual is already an order below the ONE-COLOUR-PER-MESH error the
 * resolver itself carries, so the extra classes would quantize noise.
 */
export const PAL_ENTRIES = 64;
/** Striped statistics: one counter is 64 words, indexed by lane, summed on read. */
export const STAT_STRIPE = 64;
/**
 * The debug arm's ring: how many EXHAUSTED rays `exhaustProbe` records.
 * Its claim counter is stats slot 15, which no counter uses.
 */
export const EXHAUST_SLOTS = 256;
export const EXHAUST_CLAIM = 15;
/**
 * The reprojection census (slots 16-20) exists because "86 % of probes
 * reproject" is a rate, and a rate names no mechanism. Every probe that fails
 * to carry its history forward fails for exactly ONE of five reasons and each
 * is a different bug: no previous probe in that tile at all, the anchor left
 * the screen, the plane gate (a different surface), the along-surface gate
 * (the anchor moved further across its own surface than the tolerance allows)
 * or the normal gate. They sum to `probesValid − reprojHits` by construction,
 * which is the check that the census is not itself blind.
 */
export const STATS = {
  probesPlaced: 0, probesValid: 1, reprojHits: 2, raysLaunched: 3, raysTraced: 4,
  screenHits: 5, windowHits: 6, skyMiss: 7, freshShades: 8, alphaForced: 9,
  injectWrites: 10, handoffs: 11, matureTexels: 12, texelsSeen: 13,
  reprojNoPrev: 16, reprojOffScreen: 17, reprojPlane: 18, reprojSlant: 19, reprojAlign: 20,
  // §19 Stage 3.7: what the re-shading and the prior actually cost.
  reShades: 25, neighbourPrior: 26,
  // §19 Stage 3.9's assertion, as a rate: injected pixels whose voxel names a
  // dominant axis at all, and those where that axis is not the gbuffer
  // normal's nearest. Slots 14 and 27 were the two the census never used.
  axisKnown: 14, axisMismatch: 27,
  // §19 Stage 3.11a: probes whose anchor STAYED on its world point this frame.
  anchorSticky: 28,
  // §19 Stage 3.16: the coarse-probe PLACEMENT census. `wpCoarseMoved` counts
  // cascade > 0 probes whose cell centre was inside geometry and which were
  // therefore relocated; `wpCoarseFar` counts those that ended up further than
  // ONE of their own cells away — the quantity 3.15's origin-escape rule made
  // 14 m at c2 (§W.11) and the in-cell search makes 0 by construction. Slots 15
  // `wpCoarseOut` counts those that ended up OUTSIDE THE CELL THEY REPRESENT,
  // which is the rule itself and the discriminating one: 3.15's first escape
  // step is `1.5 · s_c/2` = 0.75 cells, outside the cell but under one whole
  // cell, so the ">1 cell" test alone reads 0 on BOTH arms on a thin-walled
  // scene. Slots 15, 21 and 22 were free; all three are written by
  // `worldProbes.allocPass` only.
  wpCoarseMoved: 15, wpCoarseFar: 21, wpCoarseOut: 22,
  // §19 Stage 3.11: the contact band's census — rays whose window hit fell
  // inside it, rays whose screen walk could SEE their path, and rays the
  // screen vouched for and which therefore continued past the hit.
  contactBand: 29, contactSeen: 30, contactCont: 31,
};
/**
 * §19 Stage 3.7's NEED CENSUS — three slots that are not receipts.
 *
 * ⚠ THESE ARE CONSUMED AND ZEROED INSIDE THE FRAME, so they are deliberately
 * NOT in `STATS`: `rayBudget` reads them the moment `probePlace` finishes and
 * clears them behind itself, because the harness pages do not dispatch
 * `clearStats` every frame and a census that accumulated over a hundred frames
 * would starve the mature share to its floor forever. What a receipt reads is
 * the TOTAL `rayBudget` republishes below — a value, written with a store, that
 * is exactly this frame's and cannot drift whatever the caller's clear cadence.
 */
export const STAT_NEED = { fresh: 21, flag: 22, mature: 23 };
/**
 * ⚠ 24 IS NOT A COUNTER, IT IS THE RAY BUDGET'S OUTPUT — four words, not a
 * stripe: `[0]` the mature share's ray count (which `probeTrace` reads back the
 * same frame), `[1..3]` the fresh/flagged/mature probe totals for the receipts.
 * It lives in the stats buffer because `probeTrace` stands at the envelope's
 * six storage buffers exactly and stats is one it already has; a seventh
 * binding for one integer would not compile on the portable tier.
 */
export const STAT_RAY_BUDGET = 24;
export const STAT_SLOTS = 32;
export const STAT_WORDS = STAT_SLOTS * STAT_STRIPE;

/**
 * ══ THE OCT TEXEL'S ALPHA, REPACKED: n, HIT DISTANCE **AND** σ ══════════════
 *
 * §L.3's hysteresis has to answer "is this sample surprising?", and that
 * question has no answer without a spread to measure the surprise against.
 * The estimator has one spare word — the atlas texel's alpha — and Stage 3.5
 * spent it on `n·1024 + min(dist, 1023)`.
 *
 * ⭐ THE STORED DISTANCE WAS NINE BITS TOO WIDE, AND NOTHING READ IT. `RAY_MAX`
 * is 40 m, so a field with a range of 1023 m spent five bits describing
 * distances no ray can have; and no SHIPPING consumer ever decoded it (only
 * the harness's texel dump did). So the word is repacked into three integer
 * fields that together fill exactly the 24 bits an f32 represents exactly:
 *
 *     a = n·2^18 + distQ·2^10 + sigQ          (max 63·2^18 + 255·2^10 + 1023
 *                                              = 2^24 − 1, every value exact)
 *
 *   n     6 bits  the sample count, 0..63 — H is 32
 *   distQ 8 bits  the hit distance, `dist = distQ · RAY_MAX/255` → 0.157 m,
 *                 finer than a level-0 cell (0.25 m) on the desktop tiers
 *   sigQ 10 bits  the RELATIVE standard deviation of the texel's luminance,
 *                 LOG-quantized over [SIG_MIN, SIG_MIN·2^SIG_OCT]
 *
 * ⚠ σ IS LOG-QUANTIZED BECAUSE A LINEAR FIELD FREEZES IT. The variance is
 * updated by an EMA whose per-frame step is `α·(δ²/σ² − 1)` ≈ 3 % of σ² at
 * α = 1/32, i.e. ~1.5 % of σ. A linear 10-bit field over [0, 4] has a quantum
 * of 0.004, so any texel with σ_rel below ~0.25 would round its own update
 * away and sit still forever at whatever it happened to reach. Log-quantized,
 * one step IS 0.9 % of σ everywhere, which resolves the update at every scale.
 * (`sigQ` is a relative σ, not an absolute one, for the same reason: it has to
 * mean the same thing on a texel worth 8 W/sr/m² and one worth 0.02.)
 */
export const PACK_N = 262144;
export const PACK_D = 1024;
export const DIST_Q = 255;
export const SIG_Q = 1023;
export const SIG_MIN = 1 / 1024;
export const SIG_OCT = 13;
/**
 * §L.3's hysteresis, as a MODE rather than a switch.
 *
 * 0 = off (α = 1/min(n+1, H) always) · 1 = GI-1.0's `|new − prev| > 0.5·max`
 * (Stage 3.5's shipped rule, kept as the A/B's other arm) · 2 = variance-aware
 * (`|new − mean| > k·max(σ, ε)`) · 3 = variance-aware AND the hit distance
 * moved by more than a cell · 4 = variance-aware, DECAYING.
 *
 * ⭐⭐ 4 EXISTS BECAUSE A RESET IS ITSELF A NOISE SOURCE. Measured at 480×270:
 * mode 2 fires on 0.48 % of rays — fifty times less than GI-1.0's rule — and
 * the at-rest temporal p95 still sat at 6.6 % against 3.0 % with the
 * hysteresis switched off entirely. A reset sets `n ← 1`, i.e. α = 1, i.e.
 * that texel takes ONE Monte-Carlo sample wholesale; half a percent of texels
 * doing that every frame is a tail, and a p95 is exactly where a tail lives.
 *
 * So mode 4 does not reset, it SHORTENS: `n ← n/4`. One false surprise costs a
 * step 4× larger instead of 32×, and `n` climbs back. A REAL change surprises
 * the texel again and again — 32 → 8 → 2 → 1 in three samples — so sustained
 * evidence still collapses the memory, and isolated evidence cannot. `n` is
 * the strike counter; no second word is needed for one.
 */
export const HYST = { off: 0, legacy: 1, variance: 2, varianceAndDist: 3, decay: 4 };
/** Mode 4's divisor. Three surprises take H = 32 to 1. */
export const HYST_DECAY = 4;
/** §L.3's `k`: how many σ a sample must miss the mean by to be a CHANGE. */
export const HYST_K = 4;
/**
 * The relative floor under σ. A texel whose every ray so far has hit the same
 * flat wall has a genuinely tiny σ, and `k·σ` on it would fire on the fifth
 * decimal; 5 % of the mean is the smallest spread worth calling a spread.
 */
export const HYST_EPS_REL = 0.05;
/** How many samples σ needs before the test is allowed to fire at all. */
export const HYST_MIN_N = 4;

/** Ray length in metres. A tier constant: it bounds the DDA, not the scene. */
export const RAY_MAX = 40;

/**
 * How near a window hit has to be, IN LEVEL-0 CELLS, for the screen segment
 * to be worth running — §L.2's first segment, gated. Four cells is the reach
 * over which one cached voxel FACE is coarser than the ray's own footprint;
 * past it the screen has nothing the cache does not already have. In cells,
 * not metres, so it follows the window's resolution at every tier.
 */
export const CONTACT_CELLS = 4;

/**
 * ⭐⭐ §19 STAGE 3.11a — THE SUB-TEXEL LATTICE'S WORLD CELL, AS A FRACTION OF
 * THE WINDOW'S OWN.
 *
 * The 4×4 lattice has to be a fixed function of WHERE a probe stands, not of
 * WHICH TILE happens to cover it (see `probeTracePass`), so the key is the
 * probe's world position quantized to a cell. Half a level-0 voxel: fine
 * enough that two probes a tile apart at any useful depth land in different
 * cells (so the lattice keeps decorrelating neighbours for the 5×5 SH filter),
 * coarse enough that an anchor drifting a centimetre a frame under camera
 * motion stays in its own cell for many frames. A FRACTION of what the scene
 * measures, never a metric constant.
 */
export const DITHER_CELL_FRAC = 0.5;

/**
 * ⭐⭐ §19 STAGE 3.11 — THE CONTACT BAND, in level-0 cells.
 *
 * A window hit closer than this is inside the reach of the CONSERVATIVE
 * voxelization's own thickness: a probe standing on geometry finer than a cell
 * (a door panel in its frame, a pot's foot) shoots sideways and hits the
 * DILATED shell of the thing beside it, where the true surface is centimetres
 * away and the hemisphere is really open. Two cells is the dilation's own
 * reach — one cell of overlap on each side of a surface that crosses a cell
 * boundary — so it is the distance over which "the window says occluded" is
 * not yet evidence. Past it the window is the authority again.
 */
export const CONTACT_AUTH_CELLS = 2;

// ── CPU mirrors of the octahedral table (see `srcOctahedral.js`) ─────────────

/** Texel-centre direction of oct texel `idx` in a res×res map. */
export function octDirCpu(idx, res) {
  const u = idx % res;
  const v = Math.floor(idx / res);
  const fx = ((u + 0.5) / res) * 2 - 1;
  const fy = ((v + 0.5) / res) * 2 - 1;
  const nz = 1 - Math.abs(fx) - Math.abs(fy);
  const fold = Math.max(-nz, 0);
  const nx = fx - (fx >= 0 ? 1 : -1) * fold;
  const ny = fy - (fy >= 0 ? 1 : -1) * fold;
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}

/**
 * The direction table: texel-centre directions and their solid angles.
 *
 * `octahedralTexelWeight`'s identity (Δω ∝ (|x|+|y|+|z|)³) gives the RELATIVE
 * weights; normalizing them to sum to 4π turns the resolve's `Σ L·cos·Δω` into
 * an irradiance in the same units as the radiance the rays carry, which is what
 * makes the CPU path-tracer comparison a ratio of like for like instead of a
 * number against a differently-scaled number.
 */
export function octTable(res) {
  const dirs = [];
  let sum = 0;
  for (let i = 0; i < res * res; i++) {
    const d = octDirCpu(i, res);
    const w = Math.pow(Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]), 3);
    dirs.push({ d, w });
    sum += w;
  }
  const k = (4 * Math.PI) / sum;
  return dirs.map(({ d, w }) => new THREE.Vector4(d[0], d[1], d[2], w * k));
}

/**
 * @param {object} opts
 * @param {object} opts.win     from `createGiWindow`
 * @param {object} opts.trace   from `createWindowTrace`
 * @param {object} opts.cache   from `createRadianceCache`
 * @param {THREE.Texture} opts.positionTexture  gbuffer world position (w = valid)
 * @param {THREE.Texture} opts.normalTexture    gbuffer world normal
 * @param {number} opts.width   resolve width
 * @param {number} opts.height  resolve height
 * @param {string} [opts.tier]
 * @param {number} [opts.crops] query slots for the receipts
 * @param {{dir: object, color: object}} [opts.sun]  the ENGINE's sun uniform
 *   NODES — `dir` is the direction light TRAVELS, `color` its radiance. Passed
 *   in rather than minted here (§19 Stage 3.5): Stage 3.4 had this factory
 *   mint its own pair and `gi2System.syncLighting` copy three vectors into
 *   them every frame, which is two authored descriptions of one light and the
 *   shape a drift bug lives in. Omitted (the harnesses) → minted as before.
 * @param {{color: object}} [opts.sky]  same, for the sky radiance.
 * @param {Array<object>} [opts.emitters]  GISystem's emitter SLOT uniforms
 *   (`center`, `reff`, `color`, `radius`). When present, `shadeHit` does slot
 *   NEE at every ray hit — see the block inside it.
 */
export function createGiGather({
  win, trace, cache, positionTexture, normalTexture, width, height, tier = win.tier, crops = 16,
  sun = null, sky = null, emitters = null, worldProbes = null,
}) {
  const spec = GATHER_TIERS[tier];
  if (!spec) throw new Error(`unknown gather tier "${tier}"`);
  /**
   * §19 3.13. The explicit option wins (a harness arm), then the receipt's
   * pre-boot global, then the build constant.
   */
  const useWorld = worldProbes ?? (globalThis.__gi2WorldProbes ?? WORLD_PROBES) === true;
  /**
   * ⭐⭐⭐ §19 STAGE 4.14 (§AL) — THE CACHE IS LIT BY THE PROBES, NOT BY ITSELF.
   *
   * §AJ's per-pixel Cornell gate scored 0/5 and `probe:gi2-quadrature` said
   * why: OFFLINE, a face shaded with the four fixed directions `shadeTerms`
   * uses, against the TRUE incoming radiance, has σ 17.6 %. On the GPU the same
   * face reads 51.9 %. The three-fold difference is not the quadrature — it is
   * that each of those four rays reads a NEIGHBOURING CACHE FACE, which is
   * itself a four-ray estimate of the same kind. That is a Neumann iteration
   * over the error as well as over the light: it compounds by ~1/(1−ρ), and
   * with the user's albedo-1.0 white Cornell walls ρ ≈ 1 and the factor is ≈ 3.
   * Face writes are rare (n̄ 1.4 samples), so the running mean never gets to
   * average it away — the blotch IS the cache's memory of one bad draw.
   *
   * Lumen's shape is the fix and it is structural, not a tuning: the surface
   * cache is lit by the RADIANCE CACHE (the world probes), never by itself. So
   * a face's whole indirect+sky+emitter term becomes ONE SH2 resolve of the
   * probe field at the face — 64 filtered directions per probe, spatially
   * interpolated over eight corners, face- and Chebyshev-gated — instead of
   * four raw cache reads plus four sky rays plus four NEE rays. The loop
   * probes → faces → probes still exists (it is the multi-bounce), but it now
   * passes through a SMOOTH, LOW-VARIANCE field, so what compounds is the
   * light and not the noise.
   *
   * ⛔ `__gi2CacheFromProbes = 0` builds the 3.10 body instead — the A/B arm.
   * It is a BUILD arm and not a uniform on purpose: `probeTrace`/the world
   * trace is the slowest pipeline of the boot and compiling both bodies would
   * pay for the retired one in first light, every boot, forever.
   */
  // 08-28 18:00: DEFAULT OFF — §AK.6 measured the Cornell gate BISTABLE across
  // boots with this on (black census ~690 vs ~8600 on identical boots: a loop
  // with gain ≈ 1 in an albedo-1 box has two fixed points). Stage 5 replaces
  // the loop; until then the shipped path keeps one fixed point. `= 1` opts in.
  const CACHE_FROM_PROBES = useWorld && (globalThis.__gi2CacheFromProbes ?? 0) !== 0;
  /**
   * §AL's SECOND arm, measured separately and shipped only if it earns it: a
   * ceiling on the albedo the BOUNCE term multiplies. The standard energy
   * safety rule for an iterative gather (`ρ < 1` or the Neumann series does not
   * converge); the user's Cornell walls are authored at exactly 1.0, which is
   * the one value at which it does not. 1 = off.
   */
  const BOUNCE_ALBEDO_MAX = Number(globalThis.__gi2BounceAlbedoMax ?? 1);
  const T = spec.tile;
  const R = spec.rays;
  const O = spec.oct;
  const OCT = O * O;
  const OCT_SHIFT = Math.log2(O);
  const H = spec.history;
  /** §L.4's probe-space bilateral radius — 2 is a 5×5. See `makeShFilter`. */
  const SH_R = spec.shRadius ?? 1;
  const STRIDE = OCT / R;
  /**
   * §P.3's mature share, and the WIDEST texel window any thread can own.
   *
   * A thread of a probe with `rays` rays owns `OCT/rays` consecutive texels and
   * takes the first front-facing one, exactly as bend 2 describes — only now
   * `rays` is per probe, so the window's width is a runtime value. The LOOP
   * bound has to be compile-time, so it is the widest window the allocator can
   * hand out (`OCT / RAY_MATURE_MIN`) with a runtime `Break` inside; a fresh
   * probe's window is one texel wide and leaves after one iteration.
   */
  const MATURE_RAYS = spec.mature ?? Math.max(RAY_MATURE_MIN, R / 2);
  const PICK_MAX = OCT / RAY_MATURE_MIN;
  /** §P.2's sky samples per shade sample, and their stratification grid. */
  const SKY_RAYS = spec.skyRays ?? 4;
  const SKY_STRATA = SKY_RAYS >= 4 ? 2 : 1;
  const SKY_ROWS = SKY_RAYS / SKY_STRATA;
  const USE_SH = spec.sh;
  const MIP_RES = O / 2;
  /**
   * ⭐ THE SCREEN SEGMENT'S STEP BUDGET IS A TIER CONSTANT NOW, AND IT IS 12.
   *
   * §L.2 asked for `S_MAX = 24`. Measured at 1650×970 ultra, the segment cost
   * 0.756 ms of `probeTrace`'s 1.603 — the same kernel with the segment gated
   * off runs at 0.847 — and it converted 5.1 % of traced rays into a screen
   * hit. The other 95 % walked 24 stackless steps and then traced the window
   * anyway. Its second product, the HAND-OFF (51 % of rays start their window
   * trace part-way along), is already paid for in the first few steps: a
   * stackless closest-depth walk covers most of its screen distance early,
   * because every miss climbs a mip and doubles the stride.
   *
   * So the budget is halved rather than the segment removed. What that costs
   * is a measurement, not an argument — `probe:gi2-gather` prints the
   * screen-hit rate and the on/off crop ratios beside it.
   */
  const S_MAX = spec.hzbSteps ?? HZB_STEPS;
  const MIP_TEXELS = MIP_RES * MIP_RES;
  const { traceWindow } = trace;
  const v0 = win.voxel0;
  /** The crop block is (2·CROP_HALF+1)², unrolled — no runtime `%`. */
  const CROP_HALF = 4;

  const probeW = Math.ceil(width / T);
  const probeH = Math.ceil(height / T);
  const probeCount = probeW * probeH;

  // ── HZB pyramid geometry (resolution-derived → uniforms, never literals) ──
  const mipW = [];
  const mipH = [];
  const mipOff = [];
  let hzbWords = 0;
  {
    let w = width;
    let h = height;
    for (let m = 0; m < HZB_MIPS; m++) {
      mipW.push(w); mipH.push(h); mipOff.push(hzbWords);
      hzbWords += w * h;
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
    }
  }

  // ── buffers ───────────────────────────────────────────────────────────────
  const META_VEC = 3; // (pos, valid) (normal, viewDepth) (prevProbe, 0,0,0)
  const probeMeta = instancedArray(new Float32Array(2 * probeCount * META_VEC * 4), "vec4");
  // ⭐ §19 3.13 — THE TWO BIG ONES ARE STUBS UNDER `WORLD_PROBES`, and the two
  // small ones are not. `probeOct` (13 MB at 1650×970) and `probeFiltered`
  // (8 MB) are read only by kernels this path does not build, so allocating
  // them would be 21 MB of nothing. `probeMeta` and `probeSh` stay full size
  // because `gi2System`'s spliced `emitterDirectPass` still addresses them by
  // `probeCount` — it is a redundant dispatch on this path (the lattice does
  // its own NEE) and it must be a HARMLESS one, not an out-of-bounds one.
  const octWords = useWorld ? 4 : 2 * probeCount * OCT * 4;
  const probeOct = instancedArray(new Float32Array(octWords), "vec4");
  const MIP_BASE = probeCount * OCT;
  const probeFiltered = instancedArray(
    new Float32Array(useWorld ? 4 : (probeCount * OCT + probeCount * MIP_TEXELS) * 4), "vec4",
  );
  // TWO halves: [0] is what every consumer reads (`shIdx` — the FILTERED
  // coefficients, and the address Stage 3.4's emitter term adds into), [1] is
  // the per-probe RAW projection `probeShFilter` pools from (`shRawIdx`). The
  // filtered half comes FIRST so no address outside this file had to change.
  const probeSh = instancedArray(new Float32Array(2 * probeCount * 9 * 4), "vec4");
  const hzb = instancedArray(new Float32Array(hzbWords), "float");
  const statsBuf = instancedArray(new Uint32Array(STAT_WORDS), "uint");
  const stats = storage(statsBuf.value, "uint", STAT_WORDS).toAtomic();
  // ⭐ §19 STAGE 4.0 — `crops: 0` MEANS THE CROP KERNEL IS NEVER BUILT.
  //
  // The crop sampler is a RECEIPT, not a frame stage: it exists so the
  // harness pages can compare irradiance against a CPU path-trace at the same
  // world point. It is also, measured at 4.3a, **526 kB of WGSL with 1378
  // branches that took the driver 11.8 s to compile** — and because it lived
  // in the gather's `passes` map it rode `passesForRelease()` into the
  // system's ownership list, where any prewarm that touched that list dragged
  // it in (the Level's `computes` phase went 36 ms → 7056 ms when one did).
  // A kernel that only a receipt dispatches must only be BUILT by a receipt:
  // the engine path passes `crops: 0` and gets no buffers, no `passes.crop`
  // and no way for a warm loop to reach it; the harness pages pass their own
  // count and are unchanged.
  const cropIn = crops > 0 ? instancedArray(new Float32Array(crops * 4), "vec4") : null;
  /**
   * §19 3.17 — 6 → 9. Slots 6..8 are the PER-CASCADE CENSUS the corridor's 30 m
   * row needed: `(that cascade's own irradiance at this crop's point and
   * normal, its hand-off band weight there)`. Written only on the world path,
   * only by the rig's crop kernel, and it is what turns "the far field is 2.9×
   * the truth" from an argument into a reading — one line per cascade says
   * which one is carrying the light and how much of the pixel it owns.
   */
  const CROP_OUT_VEC = 9;
  const cropOut = crops > 0 ? instancedArray(new Float32Array(crops * CROP_OUT_VEC * 4), "vec4") : null;
  const litBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
  /**
   * ⭐ THE NOISE RECEIPT'S BUFFER (§19 Stage 3.6). Harness only, like `cropIn`.
   *
   * "GI is noisy" is a report about a TEXTURE, and every instrument this file
   * had reads a CROP — a 9×9 block averaged into one number, which is a
   * low-pass filter applied to the exact quantity under complaint. So the
   * resolved irradiance is dumped per pixel, together with the two things a
   * noise statistic needs and the CPU cannot recover afterwards: its own 5×5
   * box mean (the spatial high-pass's other half) and whether the pixel sits
   * on a GEOMETRIC edge, where a difference from the neighbourhood is the
   * scene and not the estimator.
   */
  //
  // ⚠ IT WRITES EVERY SECOND PIXEL IN EACH AXIS, and the 5×5 box is still
  // taken at FULL resolution around it. The statistic is a p50/p95 over
  // hundreds of thousands of pixels either way, and the receipt reads this
  // buffer back thirty times per arm: at 1650×970 the full grid is 25.6 MB a
  // frame, which would make the instrument the page's wall time.
  //
  // ⚠ AND ON THE ENGINE PATH IT IS BUILT ONLY IF A RECEIPT ASKED FIRST. Stage
  // 4.3a's lesson (`crops: 0`) is that a kernel only a receipt dispatches must
  // only be BUILT by a receipt, or a prewarm that walks the pass list drags it
  // into every boot. `gi2System` passes `crops: 0` and knows nothing about
  // this one, so the switch is a global the probe sets BEFORE the GI build —
  // `window.__gi2NoiseDump = true` — which keeps the decision at the receipt
  // and out of the system's options.
  const wantNoise = crops > 0 || globalThis.__gi2NoiseDump === true;
  const noiseBuf = wantNoise
    ? instancedArray(new Float32Array(
      Math.ceil(width / 2) * Math.ceil(height / 2) * 4), "vec4") : null;
  /**
   * ⭐ §19 STAGE 3.7 P.5 — THE GEOMETRY BESIDE THE NOISE, IN ITS OWN BUFFER.
   *
   * The "dirty" receipt is a spatial variance at a ONE-METRE WORLD SCALE over
   * a NAMED REGION — the façade — and neither of those is computable from
   * `noiseBuf`: a fixed 5×5 box is a screen-space filter whose world footprint
   * changes with depth, and "the façade" is a statement about surface normals.
   * So the same kernel writes the three numbers that turn a pixel into a place:
   * its view depth (→ the projected size of a metre), its normal's Y (façade
   * vs pavement) and its world height.
   *
   * ⚠ A SEPARATE BUFFER, NOT TWO VEC4 PER PIXEL, and that is the receipt's own
   * wall time talking. The 3.6 temporal receipt reads `noiseBuf` back THIRTY
   * times per arm; widening the stride would have put 6.4 MB a frame of
   * geometry the temporal statistic never looks at across the CDP bridge, 30
   * times, per arm. Two buffers means the dirty receipt pays for the geometry
   * ONCE per pose and the temporal receipt pays nothing.
   */
  const dirtyBuf = wantNoise
    ? instancedArray(new Float32Array(
      Math.ceil(width / 2) * Math.ceil(height / 2) * 4), "vec4") : null;
  /**
   * ⭐⭐ §19 STAGE 3.11a — THE RECEIPT THAT CAN SEE GRAIN UNDER MOTION.
   *
   * The 3.10 sign receipt compares a screen pixel to ITSELF one frame ago, and
   * under camera motion that is a comparison between two different world
   * points: the number it returns is dominated by parallax and cannot tell
   * "the surface flowing past" from "the estimate rattling". So the moving
   * receipt compares each pixel to its own REPROJECTED previous value — the
   * same surface point, one frame earlier — which is the only comparison under
   * motion that is about the estimator.
   *
   * `motionLum` is the half-res luminance of the last two frames (indexed by
   * `curBase`/`prevBase`, the same double-buffer discipline the oct atlas
   * uses); `reprojBuf` is what the CPU reads: `(here, thereReprojected, the
   * reprojection's validity, the gbuffer's)`.
   *
   * ⚠ IT IS A DEBUG PASS AND READS NO PREVIOUS FRAME ON THE IMAGE PATH. The
   * §T assertion is about what `resolve`/`composite` sample; this kernel is
   * dispatched by a receipt, writes to a buffer nothing else binds, and is
   * built only when `wantNoise` already built the noise dump.
   */
  const motionLum = wantNoise
    ? instancedArray(new Float32Array(2 * Math.ceil(width / 2) * Math.ceil(height / 2)), "float") : null;
  const reprojBuf = wantNoise
    ? instancedArray(new Float32Array(
      Math.ceil(width / 2) * Math.ceil(height / 2) * 4), "vec4") : null;
  /**
   * ⭐⭐ §19 STAGE 3.18 — WHY A PIXEL FLIPPED, NOT JUST THAT IT DID.
   *
   * `reprojBuf` says a surface point's estimate reversed direction. It cannot
   * say WHICH of the world path's candidate mechanisms did it, and every one of
   * them is a different fix. So `resolveHalf` — the only kernel that has the
   * answer in registers — writes, per half-res pixel and PER CASCADE, the four
   * numbers its own composite is made of:
   *
   *   `cov`   Σ tri·live: does a live lattice exist around this point (0..1).
   *   `fresh` Σ tri·live·[ready < 0.75]: how much of that lattice is SEEDED
   *           rather than traced — the α = 1 first-trace population.
   *   `claim` what this cascade actually spent of the pixel's irradiance,
   *           `cov/covFull · band · rem` — the fall-through, in one number.
   *   `vis`   Σ tri·live·vis / cov: the Chebyshev weight, averaged.
   *
   * ⭐⭐⭐ §19 STAGE 4.9 — AND A FOURTH ROW, BECAUSE THE CASCADE ROWS WERE BLIND
   * TO THE TWO DISCONTINUITIES THAT MATTERED. §AE attributed 59 % of the
   * runner's > 10 % steps to "every resolve weight flat", which is what a
   * diagnostic says when the thing that moved is not in it. The two switches
   * outside the cascade rows were the hand-off's FALLBACK (`faceCov`, and the
   * hard `admAny < 1e-3` trigger over it) and the argmax that chose which
   * corner it read. Both live after the cascade loop, so they get their own row
   * — index `DIAG_VEC - 1`, always the last one whatever a tier's cascade count
   * turns out to be:
   *
   *   `faceCov` max over cascades of Σ tri·live·wf — "does any lattice anywhere
   *           REPRESENT this surface", the fallback's own input.
   *   `tail`  the weight the fallback/tail actually carried this pixel, 0..1.
   *           Under 4.9 it is the RAMP; before 4.9 it was the 0/1 `fbTrig`.
   *   `csum`  Σ over cascades of what each contributed, plus the tail. The
   *           conservation check: a lit pixel below 0.99 is a bug, and it is
   *           the one number that makes "claimed and contributed nothing"
   *           visible from the CPU.
   *
   * plus the resolve's OWN luminance, before `resolveUpsample`'s image blend,
   * so the accumulation's contribution is a subtraction rather than an argument.
   * The CPU keeps the previous frame's copy and looks it up through the SAME
   * `src` index the sign census follows, so every classification is about one
   * surface point across two frames.
   *
   * ⚠ THE LUMINANCE MOVED WITH IT. It used to ride in the LAST CASCADE's `.w`,
   * which cost that cascade its `vis` column (§AE.1's third blindness). It now
   * rides in the FALLBACK row's `.w`, so every cascade row carries all four of
   * its own numbers and the reader's rule — "the last row's `.w` is the
   * resolve's luminance" — is unchanged.
   *
   * ⚠ HARNESS ONLY, and `wantNoise` gates the BUILD — `resolveHalf` keeps its
   * shipped storage-buffer count (§Y.2's 6-binding envelope) on every boot the
   * probe did not ask for.
   */
  // ⚠ ONE ROW PER CASCADE PLUS THE FALLBACK'S, DERIVED — not a literal 4.
  // §19 4.10 made the cascade count a per-tier number (3 at ×4, 5 at ×2), and
  // a hard 4 here silently truncates the rows so that the READER — which sizes
  // itself from `buffers.diagCasc` — scores the fallback row as cascade 3.
  const DIAG_VEC = 1 + worldCascadeCount(tier);
  const diagBuf = wantNoise
    ? instancedArray(new Float32Array(
      Math.ceil(width / 2) * Math.ceil(height / 2) * DIAG_VEC * 4), "vec4") : null;
  /**
   * ⭐⭐⭐ §19 STAGE 3.18 — THE REPROJECTION'S OWN UNCERTAINTY, PER PIXEL.
   *
   * The moving census asks whether a surface point's estimate REVERSED between
   * two frames. It gets the previous value by interpolating the previous frame
   * at a sub-pixel position, and that interpolation has an error whose sign is
   * arbitrary — so below some amplitude the census is reporting its own
   * resampling and calling it grain. At rest the error is exactly zero (the
   * point lands on its own pixel), which is why every at-rest receipt in this
   * file has been clean and every MOVING one has carried this silently.
   *
   * `reprojErr` is that error, estimated the standard way: the same tap
   * evaluated to a HIGHER order (Catmull-Rom over 4×4) minus the bilinear one.
   * Two estimates of one quantity that differ only in order of accuracy bound
   * the lower one's error, so a delta smaller than `reprojErr` is not evidence
   * about the estimator and the CPU census drops it. A separate float buffer
   * rather than a fifth channel: `reprojBuf`'s four are read by `gi2-gather`'s
   * own `grainReceipt` at a fixed stride, and widening it would have made that
   * receipt silently wrong.
   */
  const reprojErr = wantNoise
    ? instancedArray(new Float32Array(
      Math.ceil(width / 2) * Math.ceil(height / 2) * 2), "vec2") : null;
  /**
   * §19 Stage 3.11's leak gate — see `contactRayPass`. Harness only, and built
   * only when a receipt asked for crops: `gi2System` passes `crops: 0` and this
   * pass, its two buffers and its second `traceWindow` never enter a boot.
   */
  const wantContact = crops > 0;
  const CONTACT_RAYS = 10000;
  const contactIn = wantContact
    ? instancedArray(new Float32Array(CONTACT_RAYS * 8), "vec4") : null;
  const contactOut = wantContact
    ? instancedArray(new Float32Array(CONTACT_RAYS * 4), "vec4") : null;
  /** `shadeHit` under a microscope — see `shadeProbePass`. Harness only. */
  const SHADE_SLOTS = 12;
  const shadeIn = instancedArray(new Float32Array(SHADE_SLOTS * 2 * 4), "vec4");
  const shadeOut = instancedArray(new Float32Array(SHADE_SLOTS * 4 * 4), "vec4");
  /** §3.3 item 5's evidence — see `exhaustProbePass`. Harness only. */
  const EXH_VEC = 4;
  const exhaustOut = instancedArray(
    new Float32Array(EXHAUST_SLOTS * EXH_VEC * 4), "vec4",
  );

  // ── storage textures (§L.5's two outputs, plus the lit frame §L.2 reads) ──
  const halfW = Math.max(1, Math.ceil(width / 2));
  const halfH = Math.max(1, Math.ceil(height / 2));
  const mkTexAt = (name, w, h) => {
    const t = new THREE.StorageTexture(w, h);
    t.name = name;
    t.type = THREE.HalfFloatType;
    t.generateMipmaps = false;
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    return t;
  };
  const mkTex = (name) => mkTexAt(name, width, height);
  const irradiance = mkTex("gi2Irradiance");
  const glossy = mkTex("gi2Glossy");
  const lit = mkTex("gi2Lit");
  // §L.5's two outputs at HALF resolution — what `resolveHalf` writes and
  // `resolveUpsample` reads. See the note above `makeResolve`.
  const irradianceHalf = mkTexAt("gi2IrradianceHalf", halfW, halfH);
  const glossyHalf = mkTexAt("gi2GlossyHalf", halfW, halfH);
  // ── §19 STAGE 3.12 — the accumulator's memory ────────────────────────────
  //
  // ⭐⭐ THE OUTPUT TEXTURES CANNOT BE THE HISTORY, AND NOT FOR A STYLE REASON.
  // A storage texture that is both SAMPLED and `textureStore`d inside one
  // kernel is bound once, as `texture_2d<f32>`, and WGSL then rejects the store
  // (`gi2System`'s AO note hit the same wall from the other side). So
  // `resolveUpsample` reads THESE and writes `irradiance`/`glossy`, and one
  // small kernel at the end of the frame copies the answer back here.
  //
  // ⚠ AND THE COPY IS A SEPARATE PASS RATHER THAN A PING-PONG. Materials bind
  // `textures.irradiance` and `textures.glossy` by IDENTITY — `gi2System`
  // stamps their `.version` and `GISystem#rebindStaleGiTextures` walks them —
  // so the frame's output has to land in the same two objects every frame. A
  // ping-pong would alternate which texture the scene is reading, which is the
  // stale-binding crash `retireGather` exists to prevent, wearing a new hat.
  //
  // ⭐ THE ALPHA CARRIES THE GEOMETRY, exactly as the half-res pair's does
  // (see the note in `makeResolve`): `irradianceHist.w` is the VIEW DEPTH this
  // frame's camera saw at that pixel and `glossyHist.w` is that pixel's normal
  // as a 5+5-bit octahedral key (0..1023 — an integer a half-float holds
  // EXACTLY, which a packed 8+8 would not). Re-reading the gbuffer instead
  // would answer with THIS frame's geometry at the PREVIOUS frame's pixel,
  // which is the one thing a disocclusion test must not do.
  const irradianceHist = mkTex("gi2IrradianceHist");
  const glossyHist = mkTex("gi2GlossyHist");

  // ── uniforms ──────────────────────────────────────────────────────────────
  const u = {
    frame: uniform(0, "uint"),
    widthU: uniform(width, "uint"),
    heightU: uniform(height, "uint"),
    halfWU: uniform(halfW, "uint"),
    halfHU: uniform(halfH, "uint"),
    widthF: uniform(width),
    heightF: uniform(height),
    probeWU: uniform(probeW, "uint"),
    probeHU: uniform(probeH, "uint"),
    probeWF: uniform(probeW),
    probeHF: uniform(probeH),
    curBase: uniform(0, "uint"),
    prevBase: uniform(1, "uint"),
    camPos: uniform(new THREE.Vector3()),
    viewProj: uniform(new THREE.Matrix4()),
    prevViewProj: uniform(new THREE.Matrix4()),
    projScale: uniform(1),
    // ⭐ EXTERNAL WHEN OFFERED, MINTED WHEN NOT (§19 Stage 3.5). These three
    // are the only uniforms in this file that describe something the ENGINE
    // already owns, and the mirror that used to bridge them was three vector
    // copies per frame plus a second place to be wrong. A consumer that hands
    // in nodes gets its own values read by identity; a harness that hands in
    // nothing gets exactly the uniforms this file has always had.
    sunDir: sun?.dir ?? uniform(new THREE.Vector3(0, -1, 0)),
    sunColor: sun?.color ?? uniform(new THREE.Vector3()),
    skyColor: sky?.color ?? uniform(new THREE.Vector3()),
    panelCentre: uniform(new THREE.Vector3()),
    panelHalf: uniform(new THREE.Vector2(1, 1)),
    panelRadiance: uniform(new THREE.Vector3()),
    panelArea: uniform(1),
    hzbOn: uniform(1),
    statsOn: uniform(1),
    roughness: uniform(0.35),
    f0: uniform(0.04),
    // ⭐ AND IT STAYS 0.25 (§19 3.6), WHICH IS NOT WHAT THE STAGE EXPECTED.
    //
    // The cache face is a WORLD accumulator — the one place in this design
    // that is not thrown away when the camera moves — and the pixel it is fed
    // from used to carry the resolve's noise, so the plan was to lengthen its
    // memory to α = 0.1. Measured at 1650×970 with everything else in place:
    // 0.25 gives temporal p50/p95 0.50 % / 1.17 % and 0.1 gives 0.50 % / 1.18 %
    // — the same number, because what was noisy about the injected pixel was
    // the GLOSSY LOBE (see `injectPass`), and removing that from the injected
    // colour is what fixed it. A longer memory is then pure lag on every world
    // change, bought for nothing, so the shorter one ships. The receipt is
    // `probe:gi2-gather`'s cache temporal σ at named voxel faces over 30
    // frames (median 2.33 % → 0.51 %), not an argument about time constants.
    //
    // ⛔⛔ AND IT IS 0 SINCE §19 STAGE 3.10, BECAUSE IT WAS THE LAST OSCILLATOR
    // IN THE CHAIN — MEASURED, NOT ARGUED.
    //
    // With the trace made deterministic the at-rest temporal σ did NOT go to
    // zero; it went to 1.16 % p95, which σ alone could not explain. The SIGN
    // receipt (`probe:gi2-gather`'s `flip%` column — the share of frame-to-
    // frame deltas that reverse direction; 0 % is a ramp, 50 % is white noise)
    // named the owner in one table:
    //
    //     arm                     still%   moved%   flip%   flip p50/p95
    //     shipped (injection on)     0.3     90.0    24.5   24.96 / 44.33
    //     · no injection            10.2      6.7     2.1    0.00 /  0.00
    //     · shade stride 4           0.3     94.2    53.5   49.89 / 72.22
    //     · shade stride 64          0.0     64.8    33.3   33.40 / 55.70
    //
    // ⭐⭐ TWO PRODUCERS, ONE WORD, TWO DIFFERENT ANSWERS. `injectLitFrame`
    // pulls a face 25 % toward the SCREEN's resolved colour on the frame its
    // 4×4 rotation reaches it; `shadeHit` pushes it back toward the ANALYTIC
    // estimate on the frame the cadence reaches it. Neither is noisy on its
    // own and the two do not agree, so the word ping-pongs — and the more
    // often the shade fires the worse it gets, which is what the two stride
    // rows prove. It was invisible while the probe averaged 32 stochastic
    // samples per texel; a deterministic estimator shows it immediately.
    //
    // ⚠ ZERO DOES NOT REMOVE THE INJECTION. `cacheWrite` forces α = 1 on a
    // face whose word is still 0, so the screen keeps SEEDING faces no ray has
    // shaded yet and stops OVERWRITING faces the estimator owns. The
    // multibounce it used to carry is carried by `shadeHit`'s own cosine rays,
    // which read the same cache; the receipts that price the difference are
    // the parity crops, `2nd bounce` and `off-screen`.
    injectAlpha: uniform(0),
    /** 1 restores Stage 3.5's "inject the whole composite" — see `injectPass`. */
    injectGlossy: uniform(0),
    /**
     * ⭐⭐ §19 STAGE 3.18 — THE MOVING RECEIPT'S OWN NOISE FLOOR, AS AN ARM.
     *
     * `reprojDump` compares a surface point's luminance to a BILINEAR read of
     * the previous frame at that point's previous screen position. That read
     * has an error, the error is second-order in the field's spatial curvature
     * and it is NOT zero — and its sign is arbitrary, so it lands in the flip
     * census as an estimator reversing direction. At rest the error is exactly
     * zero (the point is at its own pixel), which is why the at-rest receipt
     * cannot see it and why every moving number has carried it silently.
     *
     * 1 makes the kernel dump the surface's ALBEDO instead of its irradiance —
     * a field that is a pure function of the world point, cannot change between
     * two frames by construction, and has the same spatial structure the
     * irradiance is read across. Whatever flip rate the census then reports is
     * the INSTRUMENT, and every number it reports for the real field must be
     * read against it. [[probe-blind-statistics]]
     */
    reprojNull: uniform(0),
    /** 0 restores Stage 3.5's half-tile along-surface reprojection bound. */
    reprojWide: uniform(1),
    /** 1 restores §L.1's PER-FRAME anchor jitter — see `probePlace`. */
    anchorJitter: uniform(0, "uint"),
    /**
     * §19 Stage 3.10's 4×4 sub-texel LATTICE over the probe grid — see
     * `probeTracePass`. 1 was 3.10/3.11's ship, 0 is exact texel centres.
     * It is spatial and constant in time, so neither value moves the at-rest
     * temporal number.
     *
     * ⭐⭐ AND IT IS **0** SINCE §19 STAGE 3.12, WHICH IS THE STAGE'S FIRST HALF.
     *
     * 3.11a measured it as the biggest single lever on the moving image
     * (reprojected pixel Δp50 −42 %, Δp95 −26 %) and could not ship it,
     * because the lattice was carrying a job that was never its own: it was
     * ANTI-ALIASING THE PANEL. A probe's direct light from a compact source
     * arrived through whichever of the 64 oct directions happened to point at
     * it, so with texel centres the Cornell crops fell out of bracket
     * (floorCentre 1.05 → 1.55, boxTop 0.41 → 0.07) — a quantization of the
     * SOURCE, dithered away at the price of re-quantizing every direction on
     * every frame the anchor walks.
     *
     * 3.12 gives the compact source to NEE instead (`panelDirectPass` here, and
     * on the engine path `gi2System`'s `emitterDirectPass`, which has always
     * done this), so the lattice has nothing left to hide and the directions
     * can be what §T says they are: fixed texel centres, the same ray from the
     * same anchor every frame.
     */
    probeDither: uniform(0),
    /**
     * ⭐⭐ §19 STAGE 3.12 — THE HARNESS PANEL IS AN EMITTER **SLOT** NOW.
     *
     * 1 delivers the Cornell panel's direct light at each probe by next-event
     * estimation (`panelDirectPass`: four deterministic strata, one shadow ray
     * each, added to the probe's SH) and, so that the two are not both counted,
     * removes the panel class's EMISSION from every transport read in this
     * file — `shadeHit`'s own term, the cosine ray's `hem` correction and
     * `composite`'s pixel. That is exactly the "SEATED" tier `shadeHit`'s
     * header already describes for a scene emitter that holds a slot: ONE
     * representation per emitter, and for a seated one it is the slot.
     *
     * 0 is 3.11's arm — the panel reaches a probe only by being HIT — and it is
     * what every crop ratio before this stage was measured on.
     *
     * ⚠ IT DOES NOT TOUCH `panelRadiance`, so `shadeHit`'s panel NEE still
     * lights every cache face exactly as before, and the CPU reference (which
     * reads the palette the page reports, not this uniform) is untouched. What
     * moves is the PROBE's direct term and nothing else.
     *
     * ⚠ AND THE GLOSSY LOBE LOSES THE PANEL, deliberately and for the same
     * reason a seated lamp loses it on the engine path: the lobe is a tap of
     * the oct map, and the oct map is where the emission no longer is. At
     * `f0 = 0.04` that is a 4 % term on the composite; the parity gate reads
     * IRRADIANCE, which is the quantity NEE now owns end to end.
     */
    panelNee: uniform(1),
    /**
     * ⛔ §19 STAGE 3.11a — REFUTED, KEPT AS THE ARM THAT REFUTED IT. 1 keys the
     * 4×4 lattice to the probe's WORLD CELL instead of its probe-GRID
     * coordinate; 0 (shipped) is Stage 3.10's grid key.
     *
     * The theory was sound and the measurement said no. A world key is only as
     * stable as the anchor that produces it, and under motion the anchor
     * crosses a `DITHER_CELL` boundary every two or three frames — at which
     * point a HASH jumps to an unrelated one of the sixteen offsets, where the
     * grid key had only ever stepped to the neighbouring one. Measured on the
     * 45° orbit at 960×540 high, reprojected sign flips: 24.0 % on the grid key,
     * **45.0 %** on the world key; Δp95 11.01 → 18.36 %. The lattice was not
     * the mechanism either way — see `probePlacePass`'s sticky anchor.
     */
    ditherWorld: uniform(0),
    /**
     * ⛔ §19 STAGE 3.11a — MEASURED, AND **OFF**. 1 keeps the probe on its
     * previous world point while its tile still covers it; 0 is Stage 3.10's
     * "the tile's own pixel, whatever it covers this frame".
     *
     * It does exactly what it was built to do at the PROBE — raw SH Δp95
     * 37.58 → 28.98 %, sign flips 29.6 → 17.8 % — and it does not survive the
     * `resolve`: the pixel's Δp95 goes the WRONG WAY, 11.01 → 11.91 %, and its
     * flip rate 23.8 → 30.8 %. A stuck anchor sits wherever in its tile the
     * world point happens to be rather than near the tile's centre, so the four
     * probes a pixel interpolates stop being a grid, and the interpolation of
     * quiet probes is noisier than the interpolation of walking ones. Kept as
     * the arm that says so; see `probePlacePass` and the 3.11a grain table.
     */
    anchorStick: uniform(0),
    /** ⛔ §19 3.11a's tile HAND-OFF — measured, off. See `probePlacePass`. */
    anchorHandoff: uniform(0),
    /**
     * ⭐⭐ §19 STAGE 3.11 — the contact-band authority rule. 1 ships it, 0 is
     * Stage 3.3's "the window always wins", the arm every blob ratio is read
     * against. See `probeTracePass`.
     */
    contactOn: uniform(1),
    /**
     * ⚠ THE LEAK TEST'S CONTROL, AND NOTHING ELSE. 1 forces every contact-band
     * ray to be treated as if the depth buffer had vouched for it, so the rule
     * discards EVERY near hit. A leak receipt that reads 0 is worthless until
     * the same instrument reads ~100 % with this on — the blind-statistics
     * check, applied to a safety gate.
     */
    contactForce: uniform(0),
    /**
     * ⭐⭐ §19 STAGE 3.10 — THE PROBE MAP'S ONLY TEMPORAL RULE, AND IT IS A
     * CONSTANT.
     *
     * The texel's new value is a COMPLETE, deterministic evaluation of that
     * direction (see `probeTracePass`), so the blend against the reprojected
     * previous value has nothing to hide and nothing to average away: it
     * exists to make the world cache's convergence STEPS and a moved lamp
     * arrive as a ramp rather than as an edge. `α = 1` is "no memory at all"
     * and is a legitimate arm — with a noiseless input it is not noisy, only
     * abrupt. A disoccluded probe takes α = 1 whatever this says.
     *
     * ⛔ IT IS NOT `1/min(n+1, H)`. That schedule exists to average SAMPLES,
     * and there are no samples any more — only evaluations. A count-driven α
     * would make a probe that has been still for a second take a real world
     * change 32× more slowly than the probe beside it that has just been
     * placed, for no variance in return.
     */
    // ⭐⭐ §19 STAGE 3.11a — AND IT IS 0.25 NOW, BECAUSE LAG IS ALLOWED AND
    // GRAIN IS NOT. The blend cannot remove noise from a noiseless input, but
    // it CAN slow the rate at which the estimator's own SPATIAL quantization
    // is read out along a moving anchor — which is what the user is looking
    // at. Measured on the 45° orbit, reprojected per-pixel Δ: p50 2.06 →
    // 1.79 %, p95 11.01 → 10.26 %, sign flips 23.8 → 18.9 %; the probe's own
    // raw SH Δp95 37.58 → 18.08 %. It buys that with LATENCY and nothing else:
    // the moved-panel receipt goes 90 % at 8 frames → 12 (the gate is 30), and
    // the converged value is untouched — the whole Cornell parity table is
    // byte-identical at 0.5 and 0.25, which is the check that this is a rate
    // and not a gain.
    octAlpha: uniform(0.25),
    /**
     * The re-shade CADENCE, as a power-of-two stride over `(voxel, frame)`
     * rather than §P.1's coin flip. Deterministic: which faces are re-shaded
     * this frame is a function of the frame index, and — because the shade
     * itself is now a fixed function of the face (see `shadeHit`) — a re-shade
     * that lands on a converged face writes back the value already there.
     * The cadence therefore controls LATENCY and COST and cannot control
     * noise, which is the property that lets it be a round number.
     */
    shadeStrideU: uniform(16, "uint"),
    // §L.3's biased hysteresis, as a UNIFORM MODE rather than a compiled-in
    // rule — the same discipline `hzbOn` follows. It is a claim about the
    // estimator ("a big change is a lighting change") that only a measurement
    // can settle, and the measurement needs every arm out of one binary. See
    // `HYST`: 0 off, 1 GI-1.0's, 2 variance-aware, 3 variance + distance,
    // 4 (shipped) variance-aware and DECAYING.
    hystOn: uniform(HYST.decay),
    // ⭐ THE OCT-MAP CARRY IS THE OTHER HALF OF `probePlace`, and it is the
    // only part of that kernel whose cost scales with the OCT MAP rather than
    // with the four candidate gbuffer reads §L.1 describes. A uniform arm so
    // "probePlace costs 0.76 ms" can be split into "0.1 for the placement and
    // 0.66 for copying 64 texels per probe" instead of argued about.
    // ⛔ OFF SINCE §19 STAGE 3.10. `probeTrace` writes EVERY texel of every
    // probe every frame and reads the previous value it needs directly out of
    // the previous half (one buffer read, at the texel it is already writing),
    // so copying all 64 texels forward in `probePlace` is 64 reads and 64
    // writes per probe of work whose only consumer overwrites it. Kept as an
    // arm because the carry is also what the maturity CENSUS rides on.
    carryOn: uniform(0),
    // §L.3's history depth. A TIER CONSTANT in the table above and a uniform
    // here for the same reason `hystOn` is: how much variance H buys, and what
    // it costs in responsiveness, is a measurement.
    historyU: uniform(H),
    // ── §19 STAGE 3.7, and every one of these is an A/B arm ────────────────
    /** §P.1's `p_shade`. 0 restores 3.6's one-shot cache exactly. */
    shadeProb: uniform(spec.shadeProb ?? 0.25),
    /**
     * §P.1's `N_CAP` — and it is **1** since §19 Stage 3.10, the value the old
     * header called "one-shot" and dismissed.
     *
     * ⭐⭐ A RUNNING MEAN AVERAGES SAMPLES. THERE ARE NO SAMPLES ANY MORE.
     * `shadeHit` is a fixed function of the face now (a fixed cosine set, every
     * emitter slot, every panel stratum), so the 2nd, 3rd and 16th shade of a
     * face compute the same number as the 1st, up to whatever the CACHE under
     * them has learned since. Averaging sixteen of those is not variance
     * reduction; it is a 16× brake on the Neumann iteration the cache IS.
     * Measured at cap 16 with the screen injection off, the Cornell crops sat
     * ~25 % under the reference after a 260-frame settle — not a bias, an
     * unfinished convergence. α = 1 is Gauss–Seidel on the same operator and
     * it cannot be noisy, because what it writes is deterministic.
     *
     * ⚠ HOW FAST LIGHT SPREADS IS NOW ONE NUMBER (`shadeStrideU`, how often a
     * face is revisited) instead of two that multiply.
     */
    nCapU: uniform(1),
    /**
     * ⭐⭐ §19 STAGE 4.5 — THE CACHE'S PLANE SMOOTHER, `w`. 0 is 4.4 exactly.
     *
     * See `radianceCache.cacheAccumFn`. §AD measured the whole of this wall's
     * radiance in the SECOND BOUNCE — every sky ray hits, the sun never does,
     * the NEE is zero — which makes the estimator a Neumann iteration over the
     * cache's own field and its spatial noise self-sustaining. `w` is how much
     * of a face's write is its six valid neighbours' mean; the operator is
     * row-stochastic, so it is a smoother and not a gain.
     *
     * ⚠ A UNIFORM, SO BOTH ARMS COME OUT OF ONE BINARY, ONE SHADER CACHE AND
     * ONE BOOT. The whole §AD table is measured by settling, flipping this, and
     * settling again inside a single run — which is also the only way to keep
     * the before and after on one wall, at one pose, with one voxelization.
     */
    // ⭐ 0.85 IS MEASURED, NOT CHOSEN. §AD's width sweep, one boot, one wall,
    // four arms — w 0 / 0.5 / 0.85, cold-fill off — moved the adjacent-face pair
    // p50 19.1 → 17.3 → 16.9 % and its p90 59.6 → 54.7 → 50.7 %, with the
    // brick's stored σ/mean 12.5 → 11.5 → 10.1 %. The mean face radiance over
    // the same sweep held at −0.7 % and −2.2 %, which is the ENERGY CONTROL: a
    // row-stochastic operator cannot move the mean, and a sweep that did would
    // have said the weights were wrong before any gate ran.
    cacheSmoothU: uniform(0.85),
    /**
     * ⭐⭐ §19 STAGE 4.5 — A COLD HIT IS "NO DATA", NOT "BLACK". 0 is 4.4 exactly.
     *
     * A cosine ray that lands on a voxel face no producer has written yet reads
     * `valid = 0` and contributes EXACTLY ZERO to the quadrature — while still
     * counting in its denominator. On §AD's wall 8.1 % of the sky rays land that
     * way, so the term carries a binary ±1/4 step per face on top of a
     * systematic deficit, and which faces are cold is decided by ray arrival
     * order rather than by the scene. §19 3.17 already made this argument for
     * the PRIMARY hit (`unlitFallback`: "a longer ray stops missing and starts
     * hitting, and a cold hit was black where the miss was sky"); this is the
     * same lesson one bounce deeper, and the cheapest honest answer is to divide
     * by the samples that carried information instead of by all four.
     *
     * ⚠ AND THE DENOMINATOR IS FLOORED AT HALF THE RAY COUNT, WHICH IS THE WHOLE
     * SAFETY ARGUMENT. Reweighting says "the directions I could not measure look
     * like the ones I could" — true for a façade whose neighbours are simply not
     * shaded yet, false for a sealed room where COLD means dark. Flooring at
     * `SKY_RAYS/2` bounds the extrapolation at 2×: a face that measured one
     * informative direction of four cannot quadruple itself, and a face with
     * none stores zero exactly as before. The corridor and doors receipts are
     * where that bound is checked.
     */
    // ⛔ MEASURED AND NOT SHIPPED, WHICH IS WHY THE ARM IS STILL HERE. Cold-fill
    // is the best single lever §AD found on the cache's spread — with w 0.85 it
    // took the brick's stored σ/mean 10.1 → 6.3 % — and it costs ENERGY: +8.4 %
    // on the wall's mean radiance in one run and +11.0 % in another, straddling
    // the ≤ 10 % gate rather than passing it. A gate a change passes on some
    // runs is a change that fails. It is also the one term here that
    // EXTRAPOLATES — it pays an unmeasured direction the mean of the measured
    // ones — so it is exactly the arm that should not ship on a receipt this
    // thin. Flip it with the doors and corridor gates in the same run.
    coldFillU: uniform(0),
    /** §P.2's sky ray at every shade sample. 0 removes the term. */
    skyAtHit: uniform(1),
    /** §P.3's mature share. `rayBudget` scales it; 0 restores a flat `R`. */
    needRays: uniform(1),
    matureRaysU: uniform(MATURE_RAYS, "uint"),
    /**
     * §P.4's neighbour prior for a fresh probe. 0 restores "start at zero".
     *
     * ⛔ OFF SINCE §19 STAGE 3.10, AND FOR THE REASON THE ITEM WAS WRITTEN.
     * The prior existed because a fresh probe held a 16-of-64-direction
     * estimate for several frames and read BLACK over everything it had not
     * sampled yet. A fresh probe now evaluates its whole front hemisphere on
     * the frame it is placed, so there is no hole for a prior to fill — and
     * seeding one would put a NEIGHBOUR's irradiance into a probe whose own
     * answer is already complete, i.e. a bias with no missing data to excuse
     * it. Kept as an arm; it costs 81 vec4 reads on fresh probes when set.
     */
    priorOn: uniform(0),
    /**
     * ⭐⭐ §19 STAGE 3.9's OWN CONTROL ARM. 0 files every hit and every
     * injection under the ray's ENTRY face again — Stage 3.8's behaviour,
     * exactly — out of the SAME binary, the same pipelines and the same warmed
     * shader cache, so a rotated-arm ratio measured with it off and on differs
     * by the attribution rule and by nothing else. The face byte and the two
     * neighbour words are read in both arms; only the choice is switched, which
     * is what makes the OFF arm a control for the RULE rather than for its cost
     * (the cost is the kernel table's business, and it is measured with it on).
     */
    domFaceOn: uniform(1),
    // ── §19 STAGE 3.12 — THE RESOLVED IMAGE ACCUMULATES ───────────────────
    /**
     * ⭐⭐ SMOOTH ACCUMULATION OF A COMPLETE, NOISE-FREE EVALUATION — WHICH IS
     * NOT A DENOISER, AND §T'S CLARIFICATION SAYS SO IN THE USER'S OWN WORDS:
     * "in UE5 light just gradually accumulates, like light is slower than c".
     *
     * Every input to `resolveUpsample` is deterministic (fixed texel centres,
     * a fixed shade quadrature, NEE for the compact sources), so this blend
     * has nothing random to average away. What it has is the one thing 3.11a
     * could name and not remove: the estimator's SPATIAL quantization being
     * read out along an anchor that walks with the camera. A fixed α turns
     * that read-out into a ramp — lag, which the user accepts, instead of
     * grain, which the user does not.
     *
     * ⛔ IT IS A CONSTANT, NOT `1/(n+1)`, for the reason `octAlpha`'s header
     * gives: a count-driven α makes a pixel that has been on screen for a
     * second take a real world change 30× more slowly than the pixel beside
     * it that has just been disoccluded, and buys no variance for it.
     *
     * 0 removes the pass's effect entirely (the arm every 3.11 number is read
     * against); 1 is "no memory", which with a noiseless input is not noisy,
     * only abrupt.
     */
    accumAlpha: uniform(0.25),
    /** 0 restores 3.11 exactly: `resolveUpsample` writes the current frame. */
    accumOn: uniform(1),
    /**
     * The neighbourhood clamp's half-width, as a FRACTION of the 2×2 low-res
     * box the upsample already read.
     *
     * ⚠ IT IS NOT A VARIANCE CLAMP AND MUST NOT BE TIGHTENED INTO ONE. There is
     * no noise for a tight clamp to remove and a tight clamp on a deterministic
     * signal is a bias with a temporal edge on it (that is what a TAA "clamp
     * ghost" is). What it bounds is REPROJECTION ERROR — a history tap whose
     * geometry test passed but whose value belongs to something else — so it is
     * deliberately generous: ±50 % of the box the current frame already spans.
     */
    accumClamp: uniform(0.5),
  };
  const palette = Array.from({ length: PAL_ENTRIES }, () => new THREE.Vector4(0, 0, 0, 0));
  const palU = uniformArray(palette, "vec4");
  // ⭐ §19 STAGE 4.0b — THE EMISSIVE IS A COLOUR (audits §O.4).
  //
  // `pal.w` was ONE FLOAT and every consumer added it as `vec3(pal.w)`, so a
  // RED lamp bounced GREY: the class carried its emitted ENERGY and threw its
  // CHROMA away, on the one path (`shadeHit`) that is the entire delivery
  // route for every emitter outside the four NEE slots. A second
  // `uniformArray(vec4)` indexed by the SAME class byte is 1 KB at 64 classes
  // and costs one more indexed uniform read on a fresh shade — `palIndexAt`
  // reads the byte once and both tables are indexed with it, so the window
  // buffer is not touched twice.
  //
  // `.w` is kept as the emissive MEAN. Nothing in the shaders reads it any
  // more; it is what the crop/shade receipts and the harnesses print, and it
  // is what makes "class 12 emits 3.30" answerable without a second readback.
  const paletteEmissive = Array.from({ length: PAL_ENTRIES }, () => new THREE.Vector4(0, 0, 0, 0));
  const palEmU = uniformArray(paletteEmissive, "vec4");
  const octU = uniformArray(octTable(O), "vec4");
  const mipU = uniformArray(mipOff.map((o, m) => new THREE.Vector4(o, mipW[m], mipH[m], 0)), "vec4");

  const posNode = texture(positionTexture);
  const nrmNode = texture(normalTexture);
  const litNode = texture(lit);
  const irrNode = texture(irradiance);
  const glossyNode = texture(glossy);
  const irrHalfNode = texture(irradianceHalf);
  const glossyHalfNode = texture(glossyHalf);
  const irrHistNode = texture(irradianceHist);
  const glossyHistNode = texture(glossyHist);

  // ── small shared maths ────────────────────────────────────────────────────

  /**
   * PCG hash, u32 → u32. Integer-only, so the WGSL const-NaN bitcast trap
   * (a float sentinel folded at compile time) cannot apply here.
   */
  const pcg = (v) => {
    const s = v.mul(uint(747796405)).add(uint(2891336453)).toVar();
    const w = bitXor(shiftRight(s, shiftRight(s, uint(28)).add(uint(4))), s).mul(uint(277803737)).toVar();
    return bitXor(shiftRight(w, uint(22)), w);
  };
  const rand01 = (v) => pcg(v).toFloat().mul(1 / 4294967296);

  /** Radical inverse base 2 over 6 bits — enough for a 64-long Hammersley set. */
  const radical2 = (iU) => {
    const b = iU.toVar();
    const r = float(0).toVar();
    const f = float(0.5).toVar();
    Loop({ start: 0, end: 6, name: "ri" }, () => {
      r.addAssign(bitAnd(b, uint(1)).toFloat().mul(f));
      b.assign(shiftRight(b, uint(1)));
      f.mulAssign(0.5);
    });
    return r;
  };

  /**
   * Octahedral texel → direction, with a SUB-TEXEL offset.
   *
   * Mirrors `srcOctahedral.octahedralDirection`'s branchless fold exactly; the
   * only change is that the `+0.5` texel centre becomes `+ (jx, jy)`. It has to
   * match texel for texel, because `octahedralUV` from that module is what the
   * resolve's glossy tap uses to go back the other way.
   */
  const octDirJit = (uF, vF, jx, jy) => {
    const f = vec2(uF.add(jx), vF.add(jy)).div(O).mul(2).sub(1).toVar();
    const nz = float(1).sub(f.x.abs()).sub(f.y.abs()).toVar();
    const fold = max(nz.negate(), 0).toVar();
    const sx = step(0, f.x).mul(2).sub(1);
    const sy = step(0, f.y).mul(2).sub(1);
    return normalize(vec3(f.x.sub(sx.mul(fold)), f.y.sub(sy.mul(fold)), nz));
  };

  /**
   * §19 STAGE 3.12 — a normal as ONE half-float, and back.
   *
   * 5 bits per octahedral axis is 0..1023, which a half-float represents
   * EXACTLY (its significand holds every integer below 2048) — so the key
   * survives an RGBA16F round trip bit for bit and can be compared without a
   * tolerance. 5 bits is ~5° of angular error against a test that asks for
   * `dot > 0.9` (25.8°), so the quantization cannot decide the test.
   *
   * ⚠ 8+8 BITS WOULD NOT SURVIVE. 65535 is above the half-float's exact-integer
   * range; the value comes back rounded to the nearest even multiple of 4 and
   * the decoded normal wanders. The budget here is the STORAGE FORMAT's, not
   * the geometry's, which is why it is 5 and not "as many as fit".
   */
  const OCT5 = 31;
  const packNormal5 = (n) => {
    const l1 = n.x.abs().add(n.y.abs()).add(n.z.abs()).max(1e-6).toVar();
    const ox = n.x.div(l1).toVar();
    const oy = n.y.div(l1).toVar();
    const sx = step(0, ox).mul(2).sub(1).toVar();
    const sy = step(0, oy).mul(2).sub(1).toVar();
    const fx = select(n.z.lessThan(0), float(1).sub(oy.abs()).mul(sx), ox).toVar();
    const fy = select(n.z.lessThan(0), float(1).sub(ox.abs()).mul(sy), oy).toVar();
    const qu = fx.mul(0.5).add(0.5).mul(OCT5).add(0.5).floor().clamp(0, OCT5).toVar();
    const qv = fy.mul(0.5).add(0.5).mul(OCT5).add(0.5).floor().clamp(0, OCT5).toVar();
    return qu.mul(OCT5 + 1).add(qv);
  };
  const unpackNormal5 = (key) => {
    const qu = key.div(OCT5 + 1).floor().toVar();
    const qv = key.sub(qu.mul(OCT5 + 1)).toVar();
    const fx = qu.div(OCT5).mul(2).sub(1).toVar();
    const fy = qv.div(OCT5).mul(2).sub(1).toVar();
    const nz = float(1).sub(fx.abs()).sub(fy.abs()).toVar();
    const sx = step(0, fx).mul(2).sub(1).toVar();
    const sy = step(0, fy).mul(2).sub(1).toVar();
    const ox = select(nz.lessThan(0), float(1).sub(fy.abs()).mul(sx), fx).toVar();
    const oy = select(nz.lessThan(0), float(1).sub(fx.abs()).mul(sy), fy).toVar();
    return normalize(vec3(ox, oy, nz));
  };

  /**
   * The material CLASS byte of a window voxel, clamped onto the table.
   *
   * Split out at §19 Stage 4.0b because there are now TWO tables (albedo and
   * emissive RGB) and reading the window word twice to index them would double
   * the buffer traffic of every fresh shade for nothing.
   */
  const palIndexAt = (levelF, voxF) => {
    const vi = voxF.toUint().toVar();
    const wAddr = levelF.toUint().mul(uint(LEVEL_WORDS)).add(uint(PAL_OFF)).add(shiftRight(vi, uint(2)));
    const shiftBits = bitAnd(vi, uint(3)).mul(uint(8));
    const p = bitAnd(shiftRight(win.buffer.element(wAddr), shiftBits), uint(255)).toVar();
    return min(p, uint(PAL_ENTRIES - 1));
  };
  /** Palette entry of a window voxel: `vec4(albedo.rgb, emissiveMean)`. */
  const palAt = (levelF, voxF) => palU.element(palIndexAt(levelF, voxF));

  /**
   * ⭐⭐ §19 STAGE 3.9 — THE SLOT A HIT BELONGS TO IS THE VOXEL'S, NOT THE RAY'S.
   *
   * Stage 3.8 measured the dirt and named it: `traceWindow` reports the face it
   * ENTERED the voxel through, and with permissive face bits (95 % of Bistro's
   * façade voxels carry all six) a grazing ray "hits" a wall through ±Y. That
   * entry face then decided everything downstream — which cache word the hit
   * read and re-shaded, where `faceSamplePoint` put the shade point, and which
   * way `ORIGIN_ESCAPE` walked it. The shade point landed INSIDE the wall
   * column and the escape pushed it out into open sun: 78-87× the wall's true
   * radiance, in half the words of a façade slab.
   *
   * BLOCKING AND ATTRIBUTION ARE TWO DIFFERENT QUESTIONS. The bits stay
   * permissive (they are what makes the leak receipt 0/10 000); this function
   * answers the second one from the voxel's own DOMINANT NORMAL, written into
   * the face byte's bits 6-7 by the producer that actually saw the triangles.
   *
   * ⚠ AND IT IS NOT IN `traceWindow`. 3.8 tried the exposed-face rule inside
   * the trace — a `sharedFn` every ray class calls, sun and NEE shadow rays
   * included — and GI GPU went 1.24 → 15.15 ms for a 37.8 → 26.2 % spread. Here
   * it costs ONE face byte plus TWO occupancy words at the single site that
   * needs an answer: the hit, once per ray, outside the DDA.
   *
   * The SIGN is the side whose outward neighbour is EMPTY, which is the half of
   * the fix that addresses `buried` directly — a conservatively voxelized wall
   * is two cells thick wherever its plane falls near a boundary, and the far
   * cell's "outward" face on the near side has solid in front of it. When
   * neither side or both sides are open, `hint` decides: the ray's own
   * backward direction for a trace, the gbuffer normal for the injection, so
   * both callers land on the face that looks at the light they carry.
   *
   * ⚠ THE NEIGHBOUR READ WRAPS AT THE WINDOW EDGE, exactly as every other
   * toroidal index in this file does. A voxel on the 64th cell reads the far
   * side of its own window as its neighbour; that is one cell in 64 per axis,
   * at the window boundary where the trace has already handed off to a coarser
   * level, and inventing a bounds test for it would cost every hit a compare.
   */
  const faceByteAt = (levelF, voxF) => {
    const vi = voxF.toUint().toVar();
    const wAddr = levelF.toUint().mul(uint(LEVEL_WORDS)).add(uint(FACE_OFF)).add(shiftRight(vi, uint(2)));
    return bitAnd(shiftRight(win.buffer.element(wAddr), bitAnd(vi, uint(3)).mul(uint(8))), uint(255));
  };
  const dominantFace = (levelF, voxF, fallbackFaceF, hint) => {
    const code = bitAnd(shiftRight(faceByteAt(levelF, voxF), uint(FACE_AX_SHIFT)), uint(3)).toVar();
    const vi = voxF.toUint().toVar();
    const cx = bitAnd(vi, uint(63)).toInt().toVar();
    const cy = bitAnd(shiftRight(vi, uint(6)), uint(63)).toInt().toVar();
    const cz = bitAnd(shiftRight(vi, uint(12)), uint(63)).toInt().toVar();
    const isX = code.equal(uint(1));
    const isY = code.equal(uint(2));
    const sx = select(isX, int(1), int(0)).toVar();
    const sy = select(isY, int(1), int(0)).toVar();
    const sz = select(code.equal(uint(3)), int(1), int(0)).toVar();
    const viOf = (dx, dy, dz) => bitOr(bitOr(
      bitAnd(cx.add(dx), int(N - 1)).toUint(),
      shiftLeft(bitAnd(cy.add(dy), int(N - 1)).toUint(), uint(6))),
    shiftLeft(bitAnd(cz.add(dz), int(N - 1)).toUint(), uint(12))).toVar();
    const viP = viOf(sx, sy, sz);
    const viN = viOf(int(0).sub(sx), int(0).sub(sy), int(0).sub(sz));
    const occBase = levelF.toUint().mul(uint(LEVEL_WORDS)).add(uint(OCC_OFF)).toVar();
    const occOf = (v) => bitAnd(
      win.buffer.element(occBase.add(shiftRight(v, uint(5)))), shiftLeft(uint(1), bitAnd(v, uint(31))),
    ).toVar();
    const occP = occOf(viP);
    const occN = occOf(viN);
    const base = code.sub(uint(1)).mul(uint(2)).toVar(); // 2·axis
    const ha = select(isX, hint.x, select(isY, hint.y, hint.z)).toVar();
    const hintFace = base.add(select(ha.greaterThanEqual(0), uint(0), uint(1))).toVar();
    const onlyP = occP.equal(uint(0)).and(occN.notEqual(uint(0)));
    const onlyN = occN.equal(uint(0)).and(occP.notEqual(uint(0)));
    const dom = select(onlyP, base, select(onlyN, base.add(uint(1)), hintFace)).toVar();
    return select(code.equal(uint(0)).or(u.domFaceOn.lessThan(0.5)), fallbackFaceF, dom.toFloat());
  };

  /**
   * The window cell a world point falls in, at the FINEST level whose window
   * contains it.
   *
   * ⚠ LEVEL 0 IS NOT ALWAYS THE ANSWER, and assuming it was cost two bugs at
   * once. The L0 window is 64 cells = 16 m at v0 = 0.25, centred on the camera
   * — so in a 10 m room with the camera 4.8 m off centre, the far wall is
   * OUTSIDE it. Reading the palette at level 0 there returns PAL_NONE, which
   * composites BLACK; injecting the lit frame at level 0 there writes nothing,
   * so every ray that hits that wall (at level 1, via the trace's hand-off)
   * reads a cache face that no screen pixel can ever update and stays frozen
   * at one bounce. `traceWindow` already picks its start level this way; every
   * other consumer of the window has to pick it the same way.
   */
  const cellOfWorld = (p) => {
    const level = int(win.levels - 1).toVar();
    for (let l = win.levels - 1; l >= 0; l--) {
      const rel = p.div(v0 * Math.pow(2, l)).floor().sub(win.originAt(int(l))).toVar();
      const inside = rel.x.greaterThanEqual(0).and(rel.y.greaterThanEqual(0)).and(rel.z.greaterThanEqual(0))
        .and(rel.x.lessThan(N)).and(rel.y.lessThan(N)).and(rel.z.lessThan(N));
      level.assign(select(inside, int(l), level));
    }
    const wc = p.div(float(v0).mul(exp2(level.toFloat()))).floor().toVar();
    const vi = bitOr(
      bitOr(bitAnd(wc.x.toInt(), int(63)).toUint(), shiftLeft(bitAnd(wc.y.toInt(), int(63)).toUint(), uint(6))),
      shiftLeft(bitAnd(wc.z.toInt(), int(63)).toUint(), uint(12)),
    ).toVar();
    return { level, vi };
  };

  /**
   * The world point a voxel FACE stands for: the voxel's centre, pushed half a
   * cell out along the face's outward normal.
   *
   * ⭐ THE SHADE POINT BELONGS TO THE SLOT, NOT TO THE RAY. `shadeHit` writes
   * ONE cache slot per (voxel, face) and the first ray to arrive wins it
   * forever, so shading at wherever THAT ray happened to enter makes the
   * stored radiance depend on which ray got there first. Deriving the point
   * from the voxel and the face makes it the same point for every ray — and
   * it also detaches the shade point from the trace's origin bias, which
   * Stage 3.2 made a caller parameter with an escape on top (the old
   * `o2 + n·0.5·v0 + d·t` reconstruction silently assumed the bias was still
   * half a level-0 cell).
   */
  const faceSamplePoint = (levelF, voxF, hn) => {
    const vl = float(v0).mul(exp2(levelF)).toVar();
    const vi = voxF.toUint().toVar();
    const org = win.originAt(levelF.toInt()).toVar();
    // Un-torus: the slot index carries the low 6 bits of the world cell, and
    // the level's origin says which 64-cell window those bits belong to.
    const un = (slotBits, o1) => o1.toInt().add(bitAnd(slotBits.toInt().sub(o1.toInt()), int(N - 1))).toFloat();
    const wc = vec3(
      un(bitAnd(vi, uint(63)), org.x),
      un(bitAnd(shiftRight(vi, uint(6)), uint(63)), org.y),
      un(bitAnd(shiftRight(vi, uint(12)), uint(63)), org.z),
    ).toVar();
    return wc.add(0.5).mul(vl).add(hn.mul(vl.mul(0.5)));
  };

  /**
   * Palette at a world point, pushed INTO its own surface.
   *
   * ⚠ THE PUSH IS AN EPSILON, NOT HALF A CELL. Half a cell is the right nudge
   * for a surface that lies ON a cell boundary — which is what a wall or a
   * floor built on the grid does — and it is a whole cell too far for one that
   * lies INSIDE a cell. The harness's emissive panel is 10 cm below the top of
   * its own voxel, so a 12.5 cm push read the CEILING's palette instead: the
   * panel composited with emissive 0, and `injectLitFrame` then wrote that
   * emission-free colour into the panel's own cache face, where every probe
   * ray that hits the light reads it. Measured in the texel dump: box-top
   * texels pointing straight at the panel stored 1.28 and 4.21 against a
   * reference of 8.02. A tenth of a cell (2.5 cm at v0) is orders of magnitude
   * above any gbuffer float error and cannot cross a cell a surface sits in.
   */
  const SURFACE_EPS = 0.1;
  const palIndexAtWorld = (p, n) => {
    const c = cellOfWorld(p.sub(n.mul(v0 * SURFACE_EPS)));
    return palIndexAt(c.level.toFloat(), c.vi.toFloat());
  };
  const palAtWorld = (p, n) => palU.element(palIndexAtWorld(p, n));

  /** Striped, uniform-gated counter (see the header's bend 5). */
  const bump = (slot, laneU) => {
    If(u.statsOn.greaterThan(0.5), () => {
      atomicAdd(stats.element(uint(slot * STAT_STRIPE).add(bitAnd(laneU, uint(STAT_STRIPE - 1)))), uint(1));
    });
  };
  /**
   * ⚠ THE NEED CENSUS IS NOT A RECEIPT AND MUST NOT BE GATED. `rayBudget`
   * READS slots 21-23 the same frame `probePlace` writes them, so gating them
   * on `statsOn` would make the frame's ray allocation depend on whether the
   * receipts happened to be on — an instrument changing its subject, the
   * failure the LUM sampler is opt-in for. One add per PROBE (not per ray),
   * striped over 64 words, is ~25 k adds a frame at 1650×970.
   */
  const bumpRaw = (slot, laneU) => {
    atomicAdd(stats.element(uint(slot * STAT_STRIPE).add(bitAnd(laneU, uint(STAT_STRIPE - 1)))), uint(1));
  };

  const loadPos = (x, y) => posNode.load(ivec2(x, y));
  const loadNrm = (x, y) => nrmNode.load(ivec2(x, y));
  const dispatch2d = (w, h) => [Math.ceil(w / 8), Math.ceil(h / 8)];
  const WG = [8, 8, 1];

  // ══════════════════════════════════════════════ SHADER: HZB level 0
  //
  // View depth = the clip-space `w` of the pixel's world position, the quantity
  // whose RECIPROCAL is linear along a screen-space segment — which is what the
  // walk below interpolates. Sky pixels take `HZB_FAR`, so a `min` reduction can
  // never let a hole in the gbuffer pull a mip's closest depth toward the camera.
  const hzbBuildPass = Fn(() => {
    const px = globalId.x.toVar();
    const py = globalId.y.toVar();
    If(px.greaterThanEqual(u.widthU).or(py.greaterThanEqual(u.heightU)), () => { Return(); });
    const g = loadPos(px.toInt(), py.toInt()).toVar();
    const clip = u.viewProj.mul(vec4(g.xyz, 1)).toVar();
    const z = select(g.w.greaterThan(0.5).and(clip.w.greaterThan(0)), clip.w, float(HZB_FAR)).toVar();
    hzb.element(py.mul(u.widthU).add(px)).assign(z);
  })().compute(dispatch2d(width, height), WG);

  const hzbReducePasses = [];
  for (let m = 1; m < HZB_MIPS; m++) {
    const dw = uniform(mipW[m], "uint");
    const dh = uniform(mipH[m], "uint");
    const sw = uniform(mipW[m - 1], "uint");
    const sh = uniform(mipH[m - 1], "uint");
    const dOff = uniform(mipOff[m], "uint");
    const sOff = uniform(mipOff[m - 1], "uint");
    hzbReducePasses.push(Fn(() => {
      const px = globalId.x.toVar();
      const py = globalId.y.toVar();
      If(px.greaterThanEqual(dw).or(py.greaterThanEqual(dh)), () => { Return(); });
      const sx = px.mul(uint(2)).toVar();
      const sy = py.mul(uint(2)).toVar();
      const sx1 = min(sx.add(uint(1)), sw.sub(uint(1))).toVar();
      const sy1 = min(sy.add(uint(1)), sh.sub(uint(1))).toVar();
      const a = hzb.element(sOff.add(sy.mul(sw)).add(sx)).toVar();
      const b = hzb.element(sOff.add(sy.mul(sw)).add(sx1)).toVar();
      const c = hzb.element(sOff.add(sy1.mul(sw)).add(sx)).toVar();
      const d = hzb.element(sOff.add(sy1.mul(sw)).add(sx1)).toVar();
      hzb.element(dOff.add(py.mul(dw)).add(px)).assign(min(min(a, b), min(c, d)));
    })().compute(dispatch2d(mipW[m], mipH[m]), WG));
  }

  // ── probe buffer addressing ───────────────────────────────────────────────
  const metaIdx = (half, probe, slot) => half.mul(uint(probeCount * META_VEC))
    .add(probe.mul(uint(META_VEC))).add(uint(slot));
  // ⭐⭐ TEXEL-MAJOR, NOT PROBE-MAJOR — THE LAYOUT WAS THE COST.
  //
  // Every kernel that walks a probe's oct map dispatches ONE THREAD PER
  // PROBE with `WG = [8, 8]`, so the 32 lanes of a warp are 32 CONSECUTIVE
  // PROBES, all reading texel `t` of their own map at the same moment. Laid
  // out probe-major those 32 addresses are 64 vec4 = 1 kB apart: 32 separate
  // cache lines fetched to use 16 bytes of each, an eighth of the bandwidth
  // the hardware can deliver. Measured at 1650×970 ultra before the change:
  // `probeFilter` moved 84 MB in 1.43 ms = 59 GB/s, and `probePlace`'s
  // carry — 128 accesses of pure copying — was 0.615 ms of its 0.637.
  //
  // Indexing by TEXEL first makes a warp's 32 addresses consecutive, which
  // is the same 84 MB in one eighth of the lines. Nothing about the
  // algorithm changes; it is where the numbers live.
  //
  // ⚠ `probeTrace` is the one kernel that prefers the old order (its lanes
  // are RAYS of one probe, not probes), and it is also the one that touches
  // the map ONCE per thread — 32 accesses per probe against `probeFilter`'s
  // 208 and the carry's 128. The trade is measured in the receipts, not
  // assumed: `probeTrace` is timed on its own line.
  const octIdx = (half, probe, texel) => half.mul(uint(probeCount * OCT))
    .add(texel.mul(uint(probeCount))).add(probe);
  /** The same order for the FILTERED map and its 2×2 mip. */
  const filtIdx = (probe, texel) => texel.mul(uint(probeCount)).add(probe);
  const mipIdx = (probe, texel) => uint(MIP_BASE).add(texel.mul(uint(probeCount))).add(probe);
  const shIdx = (probe, c) => probe.mul(uint(9)).add(uint(c));
  const shRawIdx = (probe, c) => uint(probeCount * 9).add(probe.mul(uint(9))).add(uint(c));

  // ══════════════════════════════════════════════ SHADER: probePlace (§L.1)
  const probePlacePass = useWorld ? null : Fn(() => {
    const tx = globalId.x.toVar();
    const ty = globalId.y.toVar();
    If(tx.greaterThanEqual(u.probeWU).or(ty.greaterThanEqual(u.probeHU)), () => { Return(); });
    const probe = ty.mul(u.probeWU).add(tx).toVar();
    bump(STATS.probesPlaced, tx);

    // ── the anchor: Hammersley candidates, sky rejected, SURFACE STICKY ────
    //
    // ⭐ A PROBE IS A PERSISTENT OBJECT, AND THE ANCHOR JITTER WAS DESTROYING
    // IT. §L.1 picks the tile's anchor by a per-frame jitter and rejects only
    // SKY. On a tile that straddles two surfaces — the box top is an 8-px
    // sliver, exactly one tile row, seen 4° off grazing — consecutive frames
    // anchor on different surfaces, §L.3's reprojection gate then rightly
    // refuses to carry the oct map forward, and the probe restarts from
    // nothing EVERY FRAME. Measured: 9 to 20 of 64 texels filled on the box
    // top against 32 of 64 (a complete front hemisphere) on the floor.
    //
    // So the candidates are tried in two passes: first only those that agree
    // with LAST frame's probe (normal and plane, the same two gates §L.3's
    // reprojection uses — a normal alone cannot tell the box top from the
    // floor 2 m below it), then any surface at all. The jitter still moves the
    // anchor WITHIN the surface, which is what it is for; it no longer moves
    // it BETWEEN surfaces, which it was never for.
    const prevA = probeMeta.element(metaIdx(u.prevBase, probe, 0)).toVar();
    const prevB = probeMeta.element(metaIdx(u.prevBase, probe, 1)).toVar();
    const pos = vec3(0).toVar();
    const nrm = vec3(0, 1, 0).toVar();
    const depth = float(0).toVar();
    const valid = float(0).toVar();
    const sticky = float(0).toVar();

    // ══ ⭐⭐⭐ §19 STAGE 3.11a — THE ANCHOR STAYS ON ITS WORLD POINT ══════════
    //
    // THE USER'S REPORT: at rest the image is clean, under camera motion it
    // GRAINS. 3.10's own orbit arm read 27 % frame-to-frame sign flips and
    // nobody could say whether that was parallax or noise, because the receipt
    // compared a screen pixel to ITSELF and under motion those are two
    // different world points. The 3.11a receipt compares each pixel — and each
    // probe — to its own REPROJECTED predecessor, and it names the owner:
    //
    //   arm (45° orbit, 960×540 high)   pixel flips   probe SH flips
    //   3.10 baseline                      24.0 %         32.6 %
    //   octAlpha 1 (no probe memory)       33.8 %         48.0 %
    //   texel centres (no 4×4 lattice)     31.1 %         32.3 %
    //   no screen segment                  23.8 %         32.4 %
    //   no re-shade                        23.8 %         32.4 %
    //   anchor jitter back (control)       44.4 %         51.8 %
    //
    // Every arm reads ZERO at rest, and the control reads 58 % at rest, so the
    // instrument is neither blind nor broken. Three suspects are REFUTED by
    // it: the HZB segment's per-frame authority (23.8 vs 24.0), the cache's
    // re-shade cadence (23.8), and the 4×4 sub-texel lattice — which does not
    // move the PROBE number at all (32.3 vs 32.6). And `octAlpha = 1` making
    // it WORSE is the positive identification: with the blend removed the
    // probe's value is nothing but `trace(anchor)`, and `trace(anchor)` alone
    // flips its sign half the time. The noise is in the INPUT, not the memory.
    //
    // ⭐⭐ WHICH MEANS IT IS THE ANCHOR. A screen probe re-anchors every frame
    // to whatever world point its tile's pixel happens to cover, and the
    // estimator it evaluates there is SPATIALLY quantized — 64 fixed
    // directions against a cache holding one radiance per voxel FACE. Slide
    // the origin two centimetres and a different set of faces answers. That
    // spatial step is invisible while the camera is still (which is exactly
    // why the at-rest receipts are perfect) and becomes a per-frame flicker
    // the moment the anchor starts walking. Spatial aliasing, read out along a
    // moving line.
    //
    // So the anchor stops walking. If the probe's PREVIOUS world point is
    // still inside this tile and the gbuffer still shows the same surface
    // there, the probe keeps that exact point — the same origin, the same 64
    // rays, the same answer, frame after frame — and only when the tile slides
    // off it does the anchor jump to a fresh point, once, which `octAlpha`
    // then ramps. Deterministic in world space, no randomness, no history
    // beyond the probe's own previous position, and IDENTITY at rest (the
    // previous point is the point the candidate loop would have picked), so
    // every §T at-rest receipt is untouched by construction.
    //
    // ⚠ THE OCCLUSION TEST IS NOT OPTIONAL. "Still inside the tile" is a
    // statement about a projection; a point behind a door that just swung shut
    // still projects into the tile. So the gbuffer AT THAT PIXEL has to agree
    // it is the same surface (normal), on the same plane, and at the same
    // distance — the third test is what refuses a point something has moved in
    // front of.
    // ⭐⭐⭐ AND THE POINT IS HANDED FROM TILE TO TILE, WHICH IS THE OTHER HALF.
    //
    // A probe that only ever kept its OWN previous point un-stuck the moment
    // that point crossed a tile boundary — measured 70.7 % kept, i.e. ~30 % of
    // probes jumping to a fresh anchor every frame, and 30 % of a 5×5 pool
    // jumping is what the pixel receipt was still reading. But the point did
    // not vanish: it walked into the NEIGHBOURING tile, whose probe is about to
    // invent a fresh anchor of its own. So each tile looks at the nine previous
    // probes around it (ITSELF FIRST, which is what keeps a parked camera
    // byte-identical) and adopts the first anchor that now falls inside it.
    // A world point then belongs to whichever tile currently covers it, for as
    // long as the screen shows it — a world-persistent probe on a screen grid —
    // and it carries its own history with it, because `stickSrc` names the
    // probe whose oct map holds it (see the reprojection below).
    //
    // ⚠ A POINT PROJECTS INTO EXACTLY ONE TILE, so two tiles can never adopt
    // the same anchor and the scan needs no arbitration between tiles. Two
    // different previous anchors landing in ONE tile is possible and is settled
    // by scan order, which is fixed — no hash, no frame index.
    const stickSrc = float(-1).toVar();
    If(u.anchorStick.greaterThan(0.5), () => {
      Loop({ start: 0, end: 9, name: "stick" }, ({ stick }) => {
        If(sticky.greaterThan(0.5), () => { Break(); });
        // Self is scanned first: `k = 0` maps to the centre of the 3×3.
        const k = uint(stick).toVar();
        // ⛔ THE HAND-OFF IS MEASURED AND **OFF**. It does what it claims —
        // the anchor survives a tile crossing, and the probe's OWN raw SH gets
        // much quieter (Δp95 19.87 → 6.76 % on the centres arm, its moved
        // share 82 → 49 %) — but the PIXEL gets worse (Δp95 10.92 → 11.18 at
        // α = 0.25), and the reason is `resolve`: a handed-off anchor can sit
        // anywhere in its new tile, so the four "corner probes" a pixel
        // interpolates stop being anywhere near a grid and their weights swing
        // frame to frame. Quieter probes, noisier interpolation of them. Kept
        // as an arm because the probe-space number says the mechanism is real
        // and a resolve that weighted probes by their actual positions would
        // collect it.
        If(k.greaterThan(uint(0)).and(u.anchorHandoff.lessThan(0.5)), () => { Break(); });
        const m = select(k.equal(uint(0)), uint(4),
          select(k.lessThanEqual(uint(4)), k.sub(uint(1)), k)).toVar();
        const ox = m.sub(m.div(uint(3)).mul(uint(3))).toInt().sub(int(1)).toVar();
        const oy = m.div(uint(3)).toInt().sub(int(1)).toVar();
        const nx = tx.toInt().add(ox).toVar();
        const ny = ty.toInt().add(oy).toVar();
        If(nx.greaterThanEqual(0).and(ny.greaterThanEqual(0))
          .and(nx.lessThan(u.probeWU.toInt())).and(ny.lessThan(u.probeHU.toInt())), () => {
          const pi = ny.toUint().mul(u.probeWU).add(nx.toUint()).toVar();
          const sa = probeMeta.element(metaIdx(u.prevBase, pi, 0)).toVar();
          const sb = probeMeta.element(metaIdx(u.prevBase, pi, 1)).toVar();
          If(sa.w.greaterThan(0.5), () => {
            const cs = u.viewProj.mul(vec4(sa.xyz, 1)).toVar();
            If(cs.w.greaterThan(1e-4), () => {
              const sx = cs.x.div(cs.w).mul(0.5).add(0.5).mul(u.widthF).toVar();
              const sy = float(1).sub(cs.y.div(cs.w).mul(0.5).add(0.5)).mul(u.heightF).toVar();
              const inTile = sx.greaterThanEqual(0).and(sy.greaterThanEqual(0))
                .and(sx.div(T).floor().toInt().equal(tx.toInt()))
                .and(sy.div(T).floor().toInt().equal(ty.toInt())).toVar();
              If(inTile, () => {
                const qx = sx.floor().clamp(0, u.widthF.sub(1)).toInt().toVar();
                const qy = sy.floor().clamp(0, u.heightF.sub(1)).toInt().toVar();
                const g2 = loadPos(qx, qy).toVar();
                const n2 = normalize(loadNrm(qx, qy).xyz).toVar();
                const dlt2 = g2.xyz.sub(sa.xyz).toVar();
                const same = g2.w.greaterThan(0.5)
                  .and(dot(n2, sb.xyz).greaterThan(0.9))
                  .and(dot(n2, dlt2).abs().lessThan(v0 * 0.5))
                  .and(dot(dlt2, dlt2).lessThan(v0 * v0)).toVar();
                If(same, () => {
                  pos.assign(sa.xyz);
                  nrm.assign(sb.xyz);
                  depth.assign(cs.w);
                  valid.assign(1);
                  sticky.assign(1);
                  stickSrc.assign(pi.toFloat());
                  bump(STATS.anchorSticky, tx);
                });
              });
            });
          });
        });
      });
    });

    Loop({ start: 0, end: 8, name: "cand" }, ({ cand }) => {
      If(valid.greaterThan(0.5), () => { Break(); });
      // ⭐⭐ THE ANCHOR STOPS MOVING WHEN THE CAMERA DOES (§19 Stage 3.6).
      //
      // §L.1's jitter re-picks the anchor's pixel INSIDE the tile every frame,
      // and every consumer of the probe's world position then flickers with
      // it: the resolve's plane weight `exp(−|N·(pa − P)|/2v₀)` and its normal
      // weight are computed against an anchor that moved, so the four corner
      // weights of a PARKED pixel change frame to frame even when every
      // probe's oct map is perfectly settled. That is temporal noise the
      // accumulator cannot touch, because it is not in the accumulator — and
      // it is the reason a screen probe was never as quiet as the SRC path's
      // world-anchored lattice.
      //
      // Multiplying the frame into the seed by a uniform makes it stop: at
      // `anchorJitter = 0` the seed is `(cand, probe)` only, so a parked
      // camera picks the SAME pixel every frame and a moving one still gets a
      // fresh anchor because the tile covers a different world point. The
      // jitter's real job — decorrelating neighbouring tiles so the grid does
      // not print itself on the image — is done by the probe term, which is
      // why the probe now seeds `jx` as well as `jy`.
      const s = u.frame.mul(u.anchorJitter).mul(uint(4)).add(bitAnd(uint(cand), uint(3))).toVar();
      const jx = radical2(bitAnd(s.add(probe.mul(uint(2654435761))), uint(63))).toVar();
      const jy = rand01(s.add(probe.mul(uint(9781)))).toVar();
      const px = min(tx.mul(uint(T)).add(jx.mul(T).toUint()), u.widthU.sub(uint(1))).toVar();
      const py = min(ty.mul(uint(T)).add(jy.mul(T).toUint()), u.heightU.sub(uint(1))).toVar();
      const g = loadPos(px.toInt(), py.toInt()).toVar();
      const cn = normalize(loadNrm(px.toInt(), py.toInt()).xyz).toVar();
      const agree = dot(cn, prevB.xyz).greaterThan(0.9)
        .and(dot(prevB.xyz, g.xyz.sub(prevA.xyz)).abs().lessThan(v0)).toVar();
      // The second pass (candidates 4-7) drops the agreement requirement, and
      // a tile with no previous probe never had one to keep.
      const relaxed = prevA.w.lessThan(0.5).or(uint(cand).greaterThanEqual(uint(4))).toVar();
      If(g.w.greaterThan(0.5).and(agree.or(relaxed)), () => {
        pos.assign(g.xyz);
        nrm.assign(cn);
        depth.assign(u.viewProj.mul(vec4(g.xyz, 1)).w);
        valid.assign(1);
      });
    });
    If(valid.greaterThan(0.5), () => { bump(STATS.probesValid, tx); });

    // ── reprojection against last frame's probe grid (§L.3) ────────────────
    const prevProbe = float(-1).toVar();
    const reprojFail = float(0).toVar();
    // ⭐⭐ §19 STAGE 3.11a — A STICKY ANCHOR IS ITS OWN PREDECESSOR, AND THAT
    // IS HALF THE FIX.
    //
    // The reprojection asks "which probe held this surface point last frame",
    // and for an anchor that did not move the answer is THIS probe — but the
    // search would not have found it: the point's PREVIOUS screen position is
    // in a different tile the moment the camera turns, so a probe whose trace
    // is byte-identical frame to frame was blending `octAlpha` of a NEIGHBOUR's
    // map into it every frame, and inheriting that neighbour's anchor motion
    // and sub-texel offsets with it. Measured on the first cut of the sticky
    // anchor, which did exactly that: the probe's own Δp95 fell 13.30 → 10.18 %
    // while its sign-flip rate ROSE 32.5 → 40.0 %, because a stable value was
    // being mixed with a moving one. Naming the probe itself costs nothing and
    // makes a stuck anchor's texel exactly constant.
    If(valid.greaterThan(0.5).and(sticky.greaterThan(0.5)), () => {
      prevProbe.assign(stickSrc);
      bump(STATS.reprojHits, tx);
    });
    If(valid.greaterThan(0.5).and(sticky.lessThan(0.5)), () => {
      reprojFail.assign(1); // off screen until proven otherwise
      const c = u.prevViewProj.mul(vec4(pos, 1)).toVar();
      If(c.w.greaterThan(1e-4), () => {
        const sx = c.x.div(c.w).mul(0.5).add(0.5).toVar();
        const sy = float(1).sub(c.y.div(c.w).mul(0.5).add(0.5)).toVar();
        If(sx.greaterThanEqual(0).and(sx.lessThan(1)).and(sy.greaterThanEqual(0)).and(sy.lessThan(1)), () => {
          const ptx = sx.mul(u.widthF).div(T).floor().clamp(0, u.probeWF.sub(1)).toUint().toVar();
          const pty = sy.mul(u.heightF).div(T).floor().clamp(0, u.probeHF.sub(1)).toUint().toVar();
          const pi = pty.mul(u.probeWU).add(ptx).toVar();
          const pa = probeMeta.element(metaIdx(u.prevBase, pi, 0)).toVar();
          const pb = probeMeta.element(metaIdx(u.prevBase, pi, 1)).toVar();
          // §L.3's gates. The position tolerance is half a TILE's world
          // footprint at this depth — derived from the pixel size, never a
          // metric constant, so it is right at 1 m and at 100 m.
          //
          // ⭐ BUT A TILE'S FOOTPRINT IS NOT ISOTROPIC, AND ON A GRAZING
          // SURFACE IT IS NOT EVEN CLOSE. §L.3's rule measures a 3-D distance
          // against `0.5 · T · pixelWorldSize` — right for a surface facing
          // the camera, wrong by `1/cos θ` for one seen edge-on. The box top
          // is seen 4° off grazing, so its 8-px tile spans about TWO METRES of
          // world space along the surface while the tolerance stays 0.25 m:
          // the anchor jitter moves the probe further than the gate allows,
          // every frame, and the probe's oct map is thrown away every frame.
          // Measured 16 of 64 texels filled — exactly one frame's 16 rays.
          //
          // So the gate is split the way the geometry is. ACROSS the surface
          // (the plane distance) it stays tight: that is what says "the same
          // surface". ALONG the surface it is stretched by the slant, which is
          // the tile's real footprint there. Both terms are still derived from
          // the pixel size; nothing here is a metric constant.
          //
          // ⭐⭐ AND THE ALONG-SURFACE HALF WAS STILL HALF A TILE (§19 3.6).
          //
          // The jitter is free to put the anchor ANYWHERE in the tile, so two
          // consecutive anchors on the SAME flat surface are up to a whole
          // tile apart along it — `T · pixWorld / slant`. Gating that at HALF
          // a tile refuses a probe that never left its own surface, on the
          // sole evidence that the jitter happened to land in the far corner:
          // measured 14 % of probes starting from nothing every frame with a
          // camera that had not moved, which at H = 32 is 14 % of the screen
          // permanently holding a 1-sample estimate. The along-surface bound
          // is the tile's own diagonal (`√2 · T · pixWorld`, plus a cell of
          // slack for the depth the anchor is read at); the ACROSS-surface
          // bound is untouched, because that is the term that means "the same
          // surface" and it is the one the box top needed tight.
          const pixWorld = depth.div(u.projScale).toVar();
          const tolN = float(0.5 * T).mul(pixWorld).max(v0).toVar();
          // A uniform arm, not a rewrite: `reprojWide = 0` is Stage 3.5's
          // along-surface bound exactly, so the receipts can measure the
          // reprojection rate with and without the widening out of one binary.
          const tolT = mix(tolN, float(Math.SQRT2 * T).mul(pixWorld).add(v0), u.reprojWide).toVar();
          const vdir = normalize(pos.sub(u.camPos)).toVar();
          const slant = dot(nrm, vdir).abs().max(0.05).toVar();
          const dlt = pos.sub(pa.xyz).toVar();
          const okPlane = dot(nrm, dlt).abs().lessThan(tolN).toVar();
          const okSlant = dlt.length().lessThan(tolT.div(slant)).toVar();
          const align = dot(nrm, pb.xyz).greaterThan(0.9).toVar();
          const hasPrev = pa.w.greaterThan(0.5).toVar();
          If(hasPrev.and(okPlane).and(okSlant).and(align), () => {
            prevProbe.assign(pi.toFloat());
            reprojFail.assign(0);
            bump(STATS.reprojHits, tx);
          }).Else(() => {
            // ONE reason per probe, in the order the gates are argued: no
            // previous probe at all, then the surface tests. A probe that
            // fails two is counted under the first, so the five classes sum to
            // `probesValid − reprojHits`.
            reprojFail.assign(select(hasPrev.not(), float(2),
              select(okPlane.not(), float(3), select(okSlant.not(), float(4), float(5)))));
          });
        });
      });
    });

    // The census: a rate names no mechanism, so every miss says WHY. `bump`
    // takes a COMPILE-TIME slot (it addresses a stripe), so the dispatch is
    // five compares rather than one indexed add.
    for (const [code, slot] of [
      [1, STATS.reprojOffScreen], [2, STATS.reprojNoPrev], [3, STATS.reprojPlane],
      [4, STATS.reprojSlant], [5, STATS.reprojAlign],
    ]) {
      If(reprojFail.greaterThan(code - 0.5).and(reprojFail.lessThan(code + 0.5)),
        () => { bump(slot, tx); });
    }

    probeMeta.element(metaIdx(u.curBase, probe, 0)).assign(vec4(pos, valid));
    probeMeta.element(metaIdx(u.curBase, probe, 1)).assign(vec4(nrm, depth));

    // ── carry the oct map forward (§L.3), and CENSUS ITS MATURITY (§P.3) ───
    // Only some of the 64 texels are re-traced this frame; the rest are
    // whatever the MATCHING previous probe held. No match ⇒ start at zero,
    // which is what `n = 0` in the alpha then means to every consumer.
    //
    // ⭐ THE CLASSIFIER RIDES A LOOP THAT ALREADY READS EVERY TEXEL. §P.3 wants
    // a probe's ray count to follow its NEED, and "need" has to be measured
    // somewhere; this loop already touches all 64 alphas, so counting how many
    // FRONT-hemisphere texels are mature (`n ≥ H/2`, the same test
    // `STATS.matureTexels` uses) costs a compare per texel and no new read. It
    // also makes §P.4's moved-lamp case fall out for free: mode 4's decaying
    // hysteresis divides `n` under sustained change, the texels stop being
    // mature, and the probe is flagged into 32 rays on the very next frame.
    // Change buys rays instead of forgetting history.
    const has = prevProbe.greaterThanEqual(0).and(valid.greaterThan(0.5)).toVar();
    const src = prevProbe.max(0).toUint().toVar();
    const frontN = float(0).toVar();
    const matureN = float(0).toVar();
    If(u.carryOn.greaterThan(0.5), () => {
      Loop({ start: 0, end: OCT, name: "carry" }, ({ carry }) => {
        const t = uint(carry).toVar();
        const prev = probeOct.element(octIdx(u.prevBase, src, t)).toVar();
        const v = select(has, prev, vec4(0)).toVar();
        probeOct.element(octIdx(u.curBase, probe, t)).assign(v);
        const e0 = octU.element(t).toVar();
        If(dot(e0.xyz, nrm).greaterThan(0), () => {
          frontN.addAssign(1);
          If(v.w.max(0).div(PACK_N).floor().greaterThanEqual(u.historyU.toFloat().mul(0.5)),
            () => { matureN.addAssign(1); });
        });
      });
    });

    // ── §P.3: the class, and the census `rayBudget` reads next ─────────────
    const ripe = matureN.div(frontN.max(1)).toVar();
    const cls = select(valid.lessThan(0.5), float(CLS_MATURE),
      select(has.not(), float(CLS_FRESH),
        select(ripe.lessThan(0.5), float(CLS_FLAG), float(CLS_MATURE)))).toVar();
    probeMeta.element(metaIdx(u.curBase, probe, 2)).assign(vec4(prevProbe, reprojFail, cls, ripe));
    If(valid.greaterThan(0.5), () => {
      If(cls.greaterThan(CLS_FLAG + 0.5), () => {
        bumpRaw(STAT_NEED.fresh, tx);
      }).Else(() => {
        If(cls.greaterThan(CLS_MATURE + 0.5), () => {
          bumpRaw(STAT_NEED.flag, tx);
        }).Else(() => {
          bumpRaw(STAT_NEED.mature, tx);
        });
      });
    });

    // ══ §19 STAGE 3.7 P.4 — A FRESH PROBE STARTS FROM ITS NEIGHBOURS ═══════
    //
    // ⭐⭐ ZERO IS THE ONE VALUE A FRESH PROBE'S IRRADIANCE CANNOT BE.
    //
    // A probe whose reprojection missed began at `vec4(0)` in every texel, and
    // the resolve then read a probe whose cosine sum is zero over every
    // direction it has not sampled yet. For one frame that surface is BLACK,
    // and at 8-16 rays a frame it takes several frames to stop being black —
    // the dark fringe that crawls along the edges of the frame whenever the
    // camera turns, and half of "very noisy on movement".
    //
    // The least-committal estimate of a surface's irradiance is what the
    // surfaces AROUND it measured, and the filtered SH of the 3×3 neighbours is
    // exactly that: already computed, already plane- and normal-weighted,
    // already in a buffer this kernel can bind. It is written with `n = 1`, so
    // the probe's own first ray lands at α = ½ and its second at ⅓ — the prior
    // is displaced by evidence within two frames and can never persist as a
    // bias. Nine probes of SH is 81 vec4 reads, paid ONLY on fresh probes.
    //
    // ⚠ THE NEIGHBOURS' *PREVIOUS* META, because `probeSh` still holds LAST
    // frame's filtered coefficients at this point in the frame (`probeFilter`
    // has not run). Weighting last frame's SH by this frame's geometry would be
    // a plane test against a probe that has since moved.
    If(u.priorOn.greaterThan(0.5).and(has.not()).and(valid.greaterThan(0.5)), () => {
      const acc = [];
      for (let i = 0; i < 9; i++) acc.push(vec3(0).toVar());
      const wsum = float(0).toVar();
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = tx.toInt().add(int(ox)).toVar();
          const ny = ty.toInt().add(int(oy)).toVar();
          const inB = nx.greaterThanEqual(int(0)).and(ny.greaterThanEqual(int(0)))
            .and(nx.lessThan(u.probeWU.toInt())).and(ny.lessThan(u.probeHU.toInt())).toVar();
          const np = ny.clamp(int(0), u.probeHU.toInt().sub(int(1))).toUint()
            .mul(u.probeWU).add(nx.clamp(int(0), u.probeWU.toInt().sub(int(1))).toUint()).toVar();
          const na = probeMeta.element(metaIdx(u.prevBase, np, 0)).toVar();
          const nn = probeMeta.element(metaIdx(u.prevBase, np, 1)).toVar();
          const wp = exp(dot(nrm, na.xyz.sub(pos)).abs().div(v0).negate()).toVar();
          const wn = dot(nrm, nn.xyz).max(0).toVar();
          const w = select(inB.and(na.w.greaterThan(0.5)),
            wp.mul(wn.mul(wn).mul(wn).mul(wn)), float(0)).toVar();
          If(w.greaterThan(1e-5), () => {
            for (let i = 0; i < 9; i++) {
              acc[i].addAssign(probeSh.element(shIdx(np, i)).xyz.mul(w));
            }
            wsum.addAssign(w);
          });
        }
      }
      If(wsum.greaterThan(1e-5), () => {
        const inv = float(1).div(wsum).toVar();
        const c = acc.map((a) => a.mul(inv).toVar());
        // `n = 1`, the hit distance parked at RAY_MAX, σ unmeasured.
        const seedAlpha = float(PACK_N + DIST_Q * PACK_D).toVar();
        Loop({ start: 0, end: OCT, name: "prior" }, ({ prior }) => {
          const t = uint(prior).toVar();
          const d = octU.element(t).xyz.toVar();
          If(dot(d, nrm).greaterThan(0), () => {
            const L = c[0].mul(0.282095)
              .add(c[1].mul(d.y.mul(0.488603)))
              .add(c[2].mul(d.z.mul(0.488603)))
              .add(c[3].mul(d.x.mul(0.488603)))
              .add(c[4].mul(d.x.mul(d.y).mul(1.092548)))
              .add(c[5].mul(d.y.mul(d.z).mul(1.092548)))
              .add(c[6].mul(d.z.mul(d.z).mul(3).sub(1).mul(0.315392)))
              .add(c[7].mul(d.x.mul(d.z).mul(1.092548)))
              .add(c[8].mul(d.x.mul(d.x).sub(d.y.mul(d.y)).mul(0.546274)))
              .toVar();
            // ⚠ CLAMPED. An order-2 SH reconstruction RINGS — its lobes go
            // negative wherever the real distribution is sharper than the basis
            // — and a negative prior is a black seed dressed as data, which is
            // the exact failure this item exists to remove.
            probeOct.element(octIdx(u.curBase, probe, t)).assign(vec4(L.max(vec3(0)), seedAlpha));
          });
        });
        bumpRaw(STATS.neighbourPrior, tx);
      });
    });
  })().compute(dispatch2d(probeW, probeH), WG);

  // ══════════════════════════════════════════════ SHADER: rayBudget (§P.3)
  //
  // ONE THREAD. It reads the need census `probePlace` has just written, decides
  // what the MATURE share can afford, and publishes it where `probeTrace` can
  // read it without a seventh binding.
  //
  // ⭐ THE FRESH AND FLAGGED SHARES ARE NOT NEGOTIABLE; THE MATURE SHARE IS. A
  // fresh probe with 8 rays is the black fringe this stage exists to remove, so
  // when the frame cannot afford everything the rays come out of the probes
  // that are already converged — down to `RAY_MATURE_MIN`, never to zero,
  // because a mature probe still has to notice the world changing.
  //
  // ⚠ AND THE ANSWER IS ROUNDED DOWN TO A POWER OF TWO. `probeTrace` divides
  // the 64-texel map into `rays` disjoint windows; an arbitrary quotient makes
  // the windows overlap, two threads write one texel, and the accumulator takes
  // a write race that no receipt in this file could show as anything but noise.
  const rayBudgetPass = useWorld ? null : Fn(() => {
    const fresh = float(0).toVar();
    const flag = float(0).toVar();
    const mat = float(0).toVar();
    Loop({ start: 0, end: STAT_STRIPE, name: "lane" }, ({ lane }) => {
      const a = uint(STAT_NEED.fresh * STAT_STRIPE).add(uint(lane)).toVar();
      const b = uint(STAT_NEED.flag * STAT_STRIPE).add(uint(lane)).toVar();
      const c = uint(STAT_NEED.mature * STAT_STRIPE).add(uint(lane)).toVar();
      fresh.addAssign(atomicLoad(stats.element(a)).toFloat());
      flag.addAssign(atomicLoad(stats.element(b)).toFloat());
      mat.addAssign(atomicLoad(stats.element(c)).toFloat());
      // Consumed. See `STAT_NEED` — the census is per frame whether or not the
      // caller clears the stats buffer, and this is what makes that true.
      atomicStore(stats.element(a), uint(0));
      atomicStore(stats.element(b), uint(0));
      atomicStore(stats.element(c), uint(0));
    });
    const budget = u.probeWU.mul(u.probeHU).toFloat().mul(float(R)).toVar();
    const spent = fresh.mul(RAY_FRESH).add(flag.mul(RAY_FLAG)).toVar();
    const each = budget.sub(spent).div(mat.max(1)).toVar();
    const pow2 = exp2(log2(each.max(1)).floor()).toVar();
    const out = pow2.clamp(RAY_MATURE_MIN, u.matureRaysU.toFloat()).toUint().toVar();
    const base = uint(STAT_RAY_BUDGET * STAT_STRIPE).toVar();
    atomicStore(stats.element(base), out);
    atomicStore(stats.element(base.add(uint(1))), fresh.toUint());
    atomicStore(stats.element(base.add(uint(2))), flag.toUint());
    atomicStore(stats.element(base.add(uint(3))), mat.toUint());
  })().compute(1);

  // ══════════════════════════════════════════════ the shading of one hit
  //
  // §L.2's "shade it NOW": palette albedo against the sun (one DDA shadow ray)
  // and the emissive panel (one NEE shadow ray), plus the palette's own
  // emission. No indirect term — multibounce arrives through the cache's EMA
  // and through `injectLitFrame`, which is the point of §K.6.
  /** The packed `(face | level<<3 | voxel<<6)` word of a `traceWindow` result. */
  const zi0 = (raw) => raw.z.toUint();
  /**
   * §19 STAGE 3.12 — THE HARNESS RIG'S "SEATED EMITTER" SWITCH.
   *
   * `emitters?.length` already decides, once, whether this build's emitter
   * representation is the CALLER's slots or the Cornell rig's panel (see the
   * panel block in `shadeHit`). On a slot build the seating decision is made on
   * the CPU — `#gi2SlotEmissive` zeroes a seated class's `palEm` — and this is
   * the identical decision for the one emitter the CPU cannot reach, taken as a
   * uniform so the arm can be A/B'd inside one binary and one shader cache.
   *
   * On a slot build it is the identity and adds no WGSL.
   */
  //
  // ⚠⚠ AND THE GATE IS `crops > 0`, NOT `!emitters?.length` ALONE — THE FIRST
  // CUT OF THIS WOULD HAVE BLACKED OUT EVERY EMISSIVE SURFACE IN ANY SCENE
  // WITH NO SEATED LAMPS. `gi2System` zeroes `panelRadiance` at build and
  // leaves `panelNee` at its default 1, so a build that takes the rig branch
  // on `!emitters?.length` alone would multiply the WHOLE palette's emission by
  // `1 − 1` and deliver nothing in its place: the panel NEE that is supposed to
  // replace it is the HARNESS's panel, which such a scene does not have.
  // `crops` is the one argument that separates the rig from a scene (24 vs 0),
  // and it is the same signal `panelDirectPass` is built on — the removal and
  // the replacement are therefore the same build decision, which is the only
  // shape in which "one representation per emitter" is safe.
  const PANEL_RIG = !emitters?.length && crops > 0;
  const emOf = (v) => (PANEL_RIG ? v.mul(float(1).sub(u.panelNee)) : v);
  /**
   * ⭐⭐ §19 STAGE 4.5 — `shadeHit`, SPLIT INTO ITS TERMS SO A RECEIPT CAN WEIGH
   * THEM. One implementation, two consumers.
   *
   * §AC named the fault ("the variance is in the radiance cache, not in the
   * probes") and then had to guess which HALF of the estimator carries it — the
   * 4-ray sky quadrature, the binary sun shadow ray, the second bounce the
   * cosine rays read back, or the emitter NEE. A guess is exactly what
   * [[gi-colour-probe-method]] forbids: read every stage, the first wrong one is
   * the source. So the terms are accumulated SEPARATELY and summed at the end;
   * `shadeHit` is that sum, byte for byte, and `scripts/lib/gi2FaceTermProbe.js`
   * builds its own kernel around the same function and writes each term out.
   *
   * ⚠ THE PROBE MUST MEASURE THE SHIPPING ESTIMATOR, NOT A COPY OF IT. A second
   * transcription of this body into a harness lib would have been a third place
   * for the Duff frame, the Hammersley azimuth and the `hem` subtraction to
   * drift, and a receipt that measures a drifted copy is worse than no receipt.
   */
  const shadeTerms = (p, n, levelF, voxF, seedU = null) => {
    const pi = palIndexAt(levelF, voxF).toVar();
    const pal = palU.element(pi).toVar();
    // ⭐⭐ §19 STAGE 4.0b — THE EMITTER GATE'S DECISION, ALREADY MADE ON THE CPU.
    //
    // `palEm.xyz` is `emissive.rgb × emissiveIntensity` for a class whose
    // placements were ADMITTED by the radiant-power gate (Φ = π·A·L against
    // `__giEmitterMinPowerFraction` of scene power), and exactly ZERO for the
    // other two tiers:
    //
    //   · SEATED — a mesh holding one of the four NEE slots below. Its light
    //     arrives through that NEE loop, and adding the class's emission on top
    //     is the 2.60× double-count §12.26.7 measured. ONE representation per
    //     emitter, and for a seat it is the slot.
    //   · CULLED — below the gate. The user's rule, "the smaller the emitter,
    //     the more emission strength it needs to be considered as emitting",
    //     and the whole point of a cull: a culled bulb must not reach the scene
    //     through the palette after being denied a slot, a tree node and a
    //     field deposit. Its own glow is the raster material and is untouched.
    //
    // See `#gi2SlotEmissive` in GISystem — the decision is not re-derived here
    // and must not be. This shader only reads the table.
    const palEm = palEmU.element(pi).toVar();
    // The four terms, each in its own accumulator. `E` below is their sum and
    // is what the estimator has always computed.
    const Esun = vec3(0).toVar();
    const Emiss = vec3(0).toVar();
    const Ebnc = vec3(0).toVar();
    const Enee = vec3(0).toVar();
    /** (sun visibility 0/1, sky rays that MISSED, sky rays that hit a WARM face). */
    const census = vec3(0).toVar();

    const toSun = u.sunDir.negate().normalize().toVar();
    const ndl = dot(n, toSun).max(0).toVar();
    If(ndl.greaterThan(0.001), () => {
      const sh = traceWindow(p, toSun, RAY_MAX, n).hit.toVar();
      Esun.addAssign(u.sunColor.mul(ndl).mul(float(1).sub(sh)));
      census.x.assign(float(1).sub(sh));
    });

    // ══ §19 4.14 (§AL) — THE BOUNCE, SKY AND EMITTER TERMS AS **ONE** SH2
    //    RESOLVE OF THE WORLD PROBES ═════════════════════════════════════════
    //
    // ⭐⭐⭐ THE ONE READ THAT REPLACED NINE RAYS AND THE SELF-AMPLIFICATION
    // WITH THEM. See `CACHE_FROM_PROBES` for the mechanism; this is where it
    // lands. `worldResolveInto` is `resolveHalf`'s OWN world block — the same
    // eight corners, the same trilinear × live × wrapped-cosine × FACE ×
    // CHEBYSHEV weights, the same 4.9 ramp and the same coarsest-preferred
    // tail — so a cache face and the pixel in front of it are lit by the same
    // arithmetic reading the same lattice, and a disagreement between them is
    // a bug rather than a convention.
    //
    // ⭐⭐ THE LEAK RULE IS THE SCREEN'S, VERBATIM, AND THAT IS WHY IT IS SAFE.
    // `p` is `faceSamplePoint`, which already sits ON the voxel's face plane
    // (cell centre + n·v/2), and the resolve then applies its OWN per-cascade
    // `biasLen` along `n` exactly as it does at a gbuffer position. A face on
    // one side of a thin wall therefore samples from the same offset point,
    // with the same face gate and the same distance-moment test, as the PIXEL
    // on that face — which is the discipline `probe:gi2-doors`/`corridor`
    // measure at 0 leaks. Nothing here re-derives a bias in world units.
    //
    // ⚠ SKY AND THE EMITTERS COME FROM THE PROBE TOO, AND THEY HAVE TO. The
    // probe's stored SH is `shPass`'s projection of its traced radiance (which
    // credits `skyColor` on a miss) PLUS `worldProbes.neePass`'s `emitterSh`
    // added into the SAME nine words. There is no separable "bounce only"
    // field to read, so keeping this face's own four sky rays or its own four
    // NEE rays beside it would count that light TWICE. What survives at the
    // face is the term the probe does NOT carry: the DIRECT SUN, whose shadow
    // ray is above and stays exactly as it was.
    //
    // Cost: one resolve (~9 SH loads + 8 distance taps per live corner, and the
    // `w > 1e-5` guard skips the half of the corners below a face's plane)
    // against 1 sun + 4 sky + 4 NEE = 9 DDA rays. Chain ms is in the receipt.
    if (CACHE_FROM_PROBES) {
      const Lp = [];
      for (let i = 0; i < 9; i++) Lp.push(vec3(0).toVar());
      const wsumP = float(0).toVar();
      const admP = float(0).toVar();
      worldResolveInto(p, n, {
        Lb: Lp, G: null, wsum: wsumP, admAny: admP, planFull: null, dgs: null, dgFb: null,
      });
      // ⚠ THE SAME NORMALISE-THEN-EVALUATE THE RESOLVE DOES, and for the same
      // reason: SH evaluation is LINEAR in the coefficients, so one `shEval` of
      // the blended words is the eight-corner blend of eight evaluations, bit
      // for bit and at an eighth of the cost.
      If(wsumP.greaterThan(1e-5), () => {
        const inv = float(1).div(wsumP).toVar();
        for (let i = 0; i < 9; i++) Lp[i].mulAssign(inv);
        Ebnc.addAssign(shEval(Lp, n));
      });
      // The census columns keep their MEANING: `y` counted sky-miss rays and
      // there are none, `z` counted informative bounce reads and is now the
      // resolve's own confidence. A stale column is a blind statistic
      // [[probe-blind-statistics]], so both are written rather than left.
      census.y.assign(0);
      census.z.assign(wsumP);
    }

    // ══ THE SKY, AT THE HIT (§19 Stage 3.7 P.2) ═══════════════════════════
    //
    // ⭐⭐ OUTDOORS THE DOMINANT LIGHT ON A SHADED SURFACE **IS** THE SKY, AND
    // THIS ESTIMATOR DID NOT HAVE IT.
    //
    // `shadeHit` was `albedo × (sun × DDA shadow + slot NEE) + emissive`. Every
    // one of those terms is zero on the shaded side of a Paris street at noon,
    // so every voxel face the camera cannot see returned BLACK to the ray that
    // hit it — awning undersides, chair seats, the recesses behind the doors,
    // the whole north wall — and the second bounce off them was a bounce off
    // nothing. The user's screenshot is precisely that: near-black chairs under
    // a bright blue sky. The lattice this design replaced carried sky in every
    // bin; the cache dropped it on the floor.
    //
    // ONE cosine-weighted ray per shade sample. Its estimator is `L(ω)·π` —
    // the pdf of a cosine hemisphere sample is `cosθ/π`, so the weight cancels
    // the cosine and leaves π — which is an irradiance in the same units as
    // the sun term above (`L·cosθ`) and the slot term below (`L·Ω·cosθ`), so
    // the three add. A single sample is a wide estimate; that is what §P.1's
    // running mean is for, and the two items only work together.
    //
    // ⭐ AND A HIT IS NOT A MISS. A ray that lands on geometry returns THAT
    // face's cached radiance, which makes this the SECOND BOUNCE — free, in
    // the same ray, with no extra trace: a wall lit by the sky lights the
    // chair in front of it as soon as the wall's own face has a sample. An
    // unwritten face returns zero rather than the sky, because "no data" is
    // not "open to the sky" and treating it as such is the leak §L.2's
    // freshness sentinel exists to prevent.
    if (seedU && !CACHE_FROM_PROBES) If(u.skyAtHit.greaterThan(0.5), () => {
      // A tangent frame from the face normal. Branchless (Duff et al.): the
      // sign trick has no degenerate axis, which a `cross` with a fixed up
      // vector has exactly where a face normal most often points.
      const sgn = select(n.z.greaterThanEqual(0), float(1), float(-1)).toVar();
      const a0 = float(-1).div(sgn.add(n.z)).toVar();
      const b0 = n.x.mul(n.y).mul(a0).toVar();
      const t1 = vec3(float(1).add(sgn.mul(n.x).mul(n.x).mul(a0)), sgn.mul(b0), sgn.negate().mul(n.x)).toVar();
      const t2 = vec3(b0, sgn.add(n.y.mul(n.y).mul(a0)), n.y.negate()).toVar();
      // ⭐ FOUR RAYS, 2x2-STRATIFIED, IN A LOOP — AND THE LOOP IS THE POINT.
      //
      // ONE cosine sample of a shaded facade's hemisphere is a coin flip: at
      // ~40 % sky visibility the estimate is either `pi*L_sky` or `pi*(bounce)`
      // and its relative sigma is about 100 %. Measured on Bistro with one ray:
      // the cache's spread across the 64 voxel faces of a facade brick settled
      // at 42 %, which is still the dirt. `SKY_RAYS` samples cut it by the
      // square root, and stratifying `(r1, r2)` over a 2x2 grid cuts it further
      // — the two halves of the hemisphere that differ most (up toward the sky,
      // down toward the street) are then guaranteed one sample each rather than
      // being sampled at random.
      //
      // ⚠ FOUR RAYS INSIDE A `Loop`, NOT FOUR CALL SITES. Compile time is the
      // binding constraint on this kernel — `probeTrace` is 55 kB of WGSL and
      // the slowest pipeline of the boot, and first light is gated on it — so
      // extra samples must not be extra TEXT. `traceWindow` is a `sharedFn`
      // (one WGSL function, called), so a loop around it costs four iterations
      // at runtime and zero additional shader bytes.
      //
      // And it is the right place to spend: four sky rays at `p_shade = 1/4`
      // buy the same variance reduction as one sky ray at `p_shade = 1`, for a
      // third of the cost, because the sun ray and the four NEE rays are paid
      // ONCE per shade sample instead of four times.
      const accHit = vec3(0).toVar();
      const accMiss = vec3(0).toVar();
      Loop({ start: 0, end: SKY_RAYS, name: "skyRay" }, ({ skyRay }) => {
        // ⚠ `skyRay` IS A NODE, NOT A JS NUMBER. The first cut of this loop did
        // `skyRay % SKY_STRATA` and `skyRay * 0x9e3779b9` in JavaScript; both
        // produced NaN, the NaN went into the cache through `encodeRgbe`, and
        // the whole gather went dark — `0 rays traced`, `transport dead`, a
        // 286-second pipeline. Every arithmetic on a loop variable is node
        // arithmetic, which is why every other `Loop` in this file opens with
        // `uint(<var>)`.
        const k = uint(skyRay).toVar();
        // ⭐⭐ §19 STAGE 3.10 — STRATUM CENTRES, NOT A HASH INSIDE THE STRATUM.
        //
        // The two `rand01` draws that used to sit here were the last stochastic
        // input the cache had, and they are the mechanism behind BOTH faults
        // 3.7/3.8 chased: a face's value depended on a hash of whichever ray
        // happened to reach it, so two neighbouring voxels on one flat wall
        // held two unrelated draws (the spatial "dirt"), and re-shading one
        // face twice gave two different answers (the temporal one).
        //
        // The stratum CENTRE is a fixed 2×2 (or 2×1) cosine quadrature of the
        // hemisphere. It is BIASED — four directions cannot integrate a
        // hemisphere exactly — and it is bias of exactly the kind RC accepts.
        // The tangent frame is built from the FACE NORMAL alone (Duff), so
        // every face sharing a normal evaluates the SAME four world
        // directions: neighbouring faces on one wall agree by construction,
        // and re-shading is IDEMPOTENT. That last property is what makes the
        // cadence in `probeTrace` a latency knob instead of a noise source,
        // and what lets the cache's EMA converge monotonically to a fixed
        // point instead of rattling around a mean.
        //
        // ⚠⚠ AND IT IS A HAMMERSLEY SET, NOT THE 2×2 STRATUM CENTRES — THE
        // FIRST CUT OF THIS CHANGE WAS DEGENERATE AND THE CORNELL PARITY SAW
        // IT IMMEDIATELY. Freezing `(r1, r2)` at the centres of a 2×2 grid
        // gives `r2 ∈ {¼, ¾}`, and `r2` is the AZIMUTH: all four rays then lie
        // in ONE PLANE through the normal, sampling a 2-D slice of a 3-D
        // hemisphere. Measured that way, `floorCentre` came back at 1.65× the
        // 4-bounce reference and 4 of 8 crops left the bracket. Randomness had
        // been hiding a quadrature that was never designed — the jitter filled
        // in the azimuths the strata did not.
        //
        // `(k + ½)/N` for the elevation and the VAN DER CORPUT radical inverse
        // for the azimuth is the standard fixed low-discrepancy answer: four
        // distinct elevations and four distinct azimuths (0°, 180°, 90°, 270°)
        // for N = 4, two and two for the phone's N = 2, and it degrades
        // gracefully if a tier ever asks for more.
        //
        // ⚠ THE RADICAL INVERSE IS UNROLLED OVER `log2(SKY_RAYS)` BITS, NOT
        // `radical2`. That helper loops 32 times and this is inside a loop that
        // already runs `SKY_RAYS` times inside the hottest kernel in the chain
        // — measured, it put 1.0 ms on `probeTrace` alone. `k < SKY_RAYS`, so
        // every bit above `log2(SKY_RAYS)` is zero and contributes nothing.
        const bits = Math.max(1, Math.log2(SKY_RAYS));
        const r1 = k.toFloat().add(0.5).div(SKY_RAYS).toVar();
        const r2 = float(0).toVar();
        for (let b = 0; b < bits; b++) {
          r2.addAssign(bitAnd(shiftRight(k, uint(b)), uint(1)).toFloat().mul(2 ** -(bits - b)));
        }
        const rr = sqrt(r1).toVar();
        const phi = r2.mul(2 * Math.PI).toVar();
        const sd = normalize(t1.mul(rr.mul(phi.cos()))
          .add(t2.mul(rr.mul(phi.sin())))
          .add(n.mul(sqrt(float(1).sub(r1).max(0))))).toVar();
        const sr = traceWindow(p, sd, float(RAY_MAX), n).raw.toVar();
        If(sr.x.greaterThan(0.5), () => {
          const hlv = bitAnd(shiftRight(zi0(sr), uint(3)), uint(7)).toFloat().toVar();
          const hvx = shiftRight(zi0(sr), uint(6)).toFloat().toVar();
          // §19 Stage 3.9: the SECOND bounce reads the same slot the first one
          // writes. A cosine ray that reads the entry face here would sample a
          // word no ray ever fills and hand back a systematic zero.
          const hf = dominantFace(hlv, hvx, bitAnd(zi0(sr), uint(7)).toFloat(), sd.negate()).toVar();
          const c2 = cache.cacheRead(hlv, hvx, hf).toVar();
          // ⭐⭐ THE COSINE RAY MUST NOT RE-COUNT WHAT NEE ALREADY SAMPLED.
          //
          // This is the oldest bug in light transport wearing a new hat, and
          // the Cornell parity caught it the first time it ran: every crop came
          // back 6-30 % ABOVE the 4-bounce reference and only 3 of 8 sat inside
          // the [1-bounce, 4-bounce] bracket that had been 8 of 8 since 3.3.
          // The panel's own light reaches this face by TWO routes now — the
          // explicit shadow ray below (next-event estimation) and this cosine
          // ray, which can land on the panel and read back its EMISSION out of
          // the cache — and both were being added.
          //
          // The fix is the standard one and it is exact rather than a weight:
          // the cosine ray keeps the hit's REFLECTED radiance and drops its
          // EMITTED part, because emission is the half NEE owns. The emitted
          // part is the palette's own `palEm` for the hit's class, which is the
          // same table `shadeHit` adds at the end — so the two halves of the
          // estimator subtract exactly what the other half added.
          // §19 3.12: `emOf` is the identity on a slot build and zeroes the
          // panel's emission on the rig build when the probe NEE owns it —
          // and the subtraction then correctly removes NOTHING, because the
          // cache no longer holds the emission to remove.
          const hem = emOf(palEmU.element(palIndexAt(hlv, hvx)).xyz).toVar();
          accHit.addAssign(c2.xyz.mul(c2.w).sub(hem).max(vec3(0)));
          census.z.addAssign(c2.w);
        }).Else(() => {
          accMiss.addAssign(u.skyColor);
          census.y.addAssign(1);
        });
      });
      // §19 4.5: the divisor is the INFORMATIVE sample count, floored at half
      // the ray count — see `coldFillU`. With every ray informative (the common
      // case) this is `Math.PI / SKY_RAYS` exactly, so the arm is free where it
      // has nothing to correct.
      const nInfo = census.y.add(census.z).toVar();
      const denom = select(u.coldFillU.greaterThan(0.5),
        nInfo.max(float(SKY_RAYS * 0.5)), float(SKY_RAYS)).toVar();
      Ebnc.addAssign(accHit.mul(Math.PI).div(denom));
      Emiss.addAssign(accMiss.mul(Math.PI).div(denom));
    });

    // ══ THE EMITTER SLOTS, AT THE HIT (§19 Stage 3.5) ═════════════════════
    //
    // Stage 3.4 lit a ray hit from the sun and the palette's own emission and
    // NOTHING ELSE, so a wall lit by a lamp reflected that lamp only once
    // `injectLitFrame` had written the voxel from a LIT PIXEL — i.e. only for
    // surfaces the camera can see. Off screen (which is the entire reason a
    // radiance cache exists) the second bounce off a lamp-lit surface simply
    // never arrived: the fresh shade is written with α = 1 and never revisited
    // (see the panel note below), so "a few frames late" was in fact "never"
    // for anything the camera never looks at.
    //
    // The estimator is the SAME EXPRESSION `gi2System`'s per-probe
    // `emitterDirectPass` and `giLight.emitterDirectAt` use — the sphere's
    // analytic solid angle `Ω = min(π, π·reff²/d²)` and one `traceWindow`
    // shadow ray — so one lamp delivers one energy on all three paths and a
    // brightness difference between them is a bug, not a convention.
    //
    // The ray stops SHORT of the emitter's own body (`reff` plus half a
    // level-0 cell) for the reason the panel block below spells out at
    // length: the lamp's geometry is voxelized, and a ray run to the full
    // distance is occluded by the very light it is sampling.
    //
    // Cost is bounded by the FRESH-SLOT count, not by the ray count — this
    // runs only where `probeTrace` decided a cache slot is stale enough to
    // re-shade (`STATS.freshShades`, ~10² per frame measured), and it is
    // `MAX_EMITTERS` rays there, gated on the slot being active and the
    // surface facing it.
    // ⭐⭐ EVERY SLOT, EVERY SHADE — §19 STAGE 3.7 P.1's RANDOM PICK RETIRED
    // (§19 Stage 3.10).
    //
    // 3.7 sampled ONE slot uniformly and multiplied by `N`: unbiased by
    // construction (`E[N·f(k)] = Σf(k)`), four shadow rays per shade turned
    // into one, and the variance handed to the running mean to remove. Under
    // the new contract that trade is not available at any price — the estimate
    // it produces is a random variable, so a wall lit by four lamps would
    // carry the wrong lamp's colour on any given re-shade and the cache's own
    // memory is what would smear the four together. Worse, it is not even a
    // *converging* random variable while the cache tracks: after the count
    // saturates every re-shade is a fresh draw at a fixed α.
    //
    // The cost it gives back is `MAX_EMITTERS` (4) shadow rays per shade
    // instead of one, paid only on the faces the cadence selects — and it is
    // the price of a deterministic lamp colour, which is the whole stage.
    for (const slot of (CACHE_FROM_PROBES ? [] : (emitters ?? []))) {
      const centre = vec3(slot.center).toVar();
      const reff = float(slot.reff).max(1e-3).toVar();
      const rgb = vec3(slot.color).toVar();
      // `radius` is the bounding sphere and doubles as the ACTIVE gate —
      // `#refreshEmitterSlots` zeroes a retired slot's radius.
      const active = float(slot.radius).greaterThan(1e-5)
        .and(rgb.x.add(rgb.y).add(rgb.z).greaterThan(1e-6));
      If(active, () => {
        const wv = centre.sub(p).toVar();
        const d2 = dot(wv, wv).max(1e-4).toVar();
        const d = sqrt(d2).toVar();
        const wd = wv.div(d).toVar();
        const cosX = dot(n, wd).toVar();
        If(cosX.greaterThan(1e-3), () => {
          const omega = float(Math.PI).min(float(Math.PI).mul(reff.mul(reff)).div(d2)).toVar();
          const reach = d.sub(reff).sub(float(v0 * 0.5)).max(v0 * 0.5).toVar();
          const vis = float(1).sub(traceWindow(p, wd, reach, n).hit).toVar();
          Enee.addAssign(rgb.mul(omega).mul(cosX).mul(vis));
        });
      });
    }

    // ══ THE PANEL, AS AN AREA LIGHT, ESTIMATED ONCE AND FOR ALL ═══════════
    //
    // ⭐⭐ THE FRESH SHADE IS WRITTEN WITH α = 1 AND NEVER REVISITED. §L.2's
    // rule is "if the slot is fresh, shade it NOW", and the very next ray to
    // reach that face reads the stored word instead of shading again. So for
    // any surface `injectLitFrame` cannot reach — anything off screen, which
    // is the whole reason this cache exists — ONE Monte-Carlo sample IS the
    // surface's radiance, permanently. A random panel point was a coin flip
    // whose result was kept forever.
    //
    // And the coin was loaded. The old shadow ray stopped `1.5·v0` short
    // ALONG THE RAY, but the clearance it needs is along Y: the emitter's own
    // voxel reaches from y = 2.75 to 3.0 for a panel whose surface is at 2.9,
    // so a ray must lose 0.15 m of HEIGHT to clear it, and a grazing ray
    // travelling 0.375 m loses only `0.375·wd.y`. From the +Z wall, samples
    // toward the panel's near edge have wd.y ≈ 0.38 → 0.144 m — just short —
    // and the ray ends INSIDE the emitter's cell, is blocked by the very
    // light it is sampling, and writes BLACK. Measured: that wall, the one
    // surface in the Cornell box no pixel ever covers, held an explicitly
    // written zero after 160 frames while every visible surface held the
    // right colour; the sphere, whose hemisphere faces it, read 0.10 of the
    // reference.
    //
    // Both halves are fixed here:
    //   · the ray stops at the emitter's own CELL PLANE, derived from v0 and
    //     the panel's height — a distance in the geometry, not a fudge along
    //     the ray;
    //   · the estimate is a DETERMINISTIC 2×2 stratification of the panel,
    //     four shadow rays, no random number. It costs four rays on a fresh
    //     slot (96 of them per frame, measured) and it cannot be unlucky.
    //
    // Skipped at or above the panel's own plane: its emission is already in
    // `palEm.xyz` there, and a light cannot illuminate itself without being
    // counted twice.
    //
    // ⭐⭐ AND NOT COMPILED AT ALL WHEN THERE ARE SLOTS (§19 Stage 3.5). The
    // panel IS an emitter — the harness rig's, hard-coded because the rig
    // predates the slot uniforms — so a build that has real slots has no use
    // for it, and `gi2System` was already zeroing `panelRadiance` every frame
    // to switch it off. Zeroing a uniform does not remove WGSL: the block's
    // FOUR inlined `traceWindow` DDAs were still compiled, and with the slot
    // NEE above them `probeTrace` reached 51 kB and took **2.5 s** to compile
    // — which on the Level pushed first light 1.8 → 3.6 s, past its own gate,
    // for four shadow rays that provably contribute zero. This is the
    // "unify if clean" the stage asked for, taken at the only place it is
    // actually clean: ONE emitter representation per build, whichever one the
    // caller supplied. The Cornell probes pass no `emitters` and get the panel
    // exactly as before, so the 3.3 bracket is untouched.
    if (!emitters?.length && !CACHE_FROM_PROBES) If(p.y.lessThan(u.panelCentre.y.sub(0.05)), () => {
      // ⚠ MEASURE THE STOP FROM THE ORIGIN THE TRACE WILL ACTUALLY USE.
      // `traceWindow` pushes the origin `biasCells · v_l` along the normal
      // BEFORE it starts, so a `tMax` measured from `p` overshoots by exactly
      // that much — and on a surface whose normal points AT the light (the
      // floor, the box top) the whole overshoot is vertical, which is enough
      // to end the ray inside the emitter's own voxel. Measured: with the
      // brick-granularity `tMax` bug fixed, the four WALLS lit up and the
      // floor and the box top stayed black, and this is the difference
      // between them. Half a cell of margin on top absorbs the escape.
      const pRay = p.add(n.mul(v0 * 0.5)).toVar();
      const yStop = u.panelCentre.y.div(v0).floor().mul(v0).sub(v0 * 0.5).toVar();
      // ⭐⭐ ALL FOUR STRATA, EVERY SHADE — 3.7's ONE-OF-FOUR RETIRED (§19 3.10).
      //
      // Stage 3.5 enumerated the 2×2; 3.7 picked one at random per sample and
      // let the running mean re-assemble it for a quarter of the rays. The
      // same objection the slot loop above spells out applies here and is
      // sharper, because the four corners of a 2 m panel differ most exactly
      // where the receipt looks (a crop near one end of it): a random corner
      // per re-shade is a random VALUE per re-shade, and the cache's memory
      // would be storing that randomness rather than removing it. Four
      // shadow rays, always the same four, so re-shading a converged face
      // writes back the number already in it.
      const stratum = null;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const takeIt = stratum ? stratum.equal(uint(sy * 2 + sx)) : null;
          const q = vec3(
            u.panelCentre.x.add(u.panelHalf.x.mul(sx ? 0.5 : -0.5)),
            u.panelCentre.y,
            u.panelCentre.z.add(u.panelHalf.y.mul(sy ? 0.5 : -0.5)),
          ).toVar();
          const wv = q.sub(p).toVar();
          const d2 = dot(wv, wv).max(1e-4).toVar();
          const d = sqrt(d2).toVar();
          const wd = wv.div(d).toVar();
          const cosX = dot(n, wd).max(0).toVar();
          // The panel faces −Y, so its own cosine toward `p` is `wd.y`.
          const cosP = wd.y.max(0).toVar();
          const want = takeIt ? takeIt.and(cosX.mul(cosP).greaterThan(1e-5))
            : cosX.mul(cosP).greaterThan(1e-5);
          If(want, () => {
            const tStop = yStop.sub(pRay.y).div(wd.y.max(1e-3)).min(d).max(0.05).toVar();
            const vis = float(1).sub(traceWindow(p, wd, tStop, n).hit).toVar();
            Enee.addAssign(u.panelRadiance.mul(cosX).mul(cosP)
              .mul(u.panelArea.mul(takeIt ? 1 : 0.25)).div(d2).mul(vis));
          });
        }
      }
    });

    return { pal, palEm: emOf(palEm.xyz), Esun, Emiss, Ebnc, Enee, census };
  };

  /**
   * The estimator itself: albedo/π against the sum of the four terms, plus the
   * face's own emission. Unchanged since 3.12 — only the accumulators above it
   * were split.
   */
  const shadeHit = (p, n, levelF, voxF, seedU = null) => {
    const t = shadeTerms(p, n, levelF, voxF, seedU);
    const E = t.Esun.add(t.Emiss).add(t.Ebnc).add(t.Enee).toVar();
    // §19 4.14 (§AL) arm 2 — the bounce-albedo ceiling. `min`, not a scale: it
    // touches ONLY the surfaces authored at or above the ceiling and is the
    // identity everywhere else, so a scene with no white-on-white wall in it
    // cannot measure this arm at all. See `BOUNCE_ALBEDO_MAX`.
    const alb = BOUNCE_ALBEDO_MAX < 1
      ? t.pal.xyz.min(vec3(BOUNCE_ALBEDO_MAX)) : t.pal.xyz;
    return alb.mul(1 / Math.PI).mul(E).add(t.palEm);
  };

  // ══════════════════════════ §19 STAGE 3.13 — WHAT A RAY BRINGS BACK ════════
  //
  // ⭐ THE HIT'S RADIANCE, LIFTED OUT OF `probeTrace` SO THE WORLD LATTICE CAN
  // CALL IT INSTEAD OF COPYING IT. Every line of it is 3.7-3.10's, unchanged:
  // the voxel's DOMINANT face (not the ray's entry face), the cache's running
  // value for the ray, a deterministic re-shade cadence that feeds the cache
  // and NOT the ray, and a fresh slot shaded on the spot because there is
  // nothing else to return. Returns `(rgb, hitDistance)`.
  //
  // ⚠ A SECOND CALL SITE IS FREE ONLY BECAUSE ONLY ONE PATH IS BUILT. `shadeHit`
  // inlines a sun ray, four sky rays, every emitter slot and (on the rig) four
  // panel strata — ~25 kB of WGSL, 2.5 s of pipeline compile when it was
  // duplicated at 3.5. `useWorld` gates `probeTracePass` out of the build, so
  // the text exists once per binary either way.
  /**
   * ⭐⭐ §19 STAGE 3.17 — `unlitFallback`: WHAT A HIT PAYS WHEN THE CACHE HAS
   * NOTHING TO SAY YET.
   *
   * §X.2 measured the hole and then reverted the feature that exposed it: with
   * the last cascade tracing to its lattice extent, its far band went from SKY
   * (3.875) to EXACTLY 0.0000 on all thirty of its samples. ⭐ **A LONGER RAY
   * STOPS MISSING AND STARTS HITTING, AND A COLD HIT WAS BLACK WHERE THE MISS
   * WAS SKY.** A fresh slot IS shaded on the spot below — but that shade is
   * DIRECT plus a cosine gather that reads the cache, so every secondary hit
   * whose own slot is cold contributes zero. In a street canyon sixty metres
   * out, that is every one of them: the fresh shade is a strict UNDER-estimate
   * of what the same slot converges to, and its floor is black.
   *
   * `unlitFallback(hp, hn)` is the caller's own estimate of the IRRADIANCE at
   * the hit — the world path passes its PARENT cascade's field, interpolated at
   * the hit point and evaluated at the hit's normal, which is occlusion-aware
   * by construction and is therefore never "raw sky through a wall". The hit
   * then pays `max(fresh shade, albedo·E/π)` componentwise.
   *
   * ⭐ `max`, NOT A REPLACEMENT AND NOT A SUM. The two terms estimate the SAME
   * quantity — the converged outgoing radiance of that face — from two
   * directions: the fresh shade has the direct term exactly and the indirect
   * term floored at zero; the cascade has the whole field at lattice
   * resolution. Summing would double-count the direct light on a sunlit façade;
   * replacing would throw it away. The larger of two under-estimates is the
   * only combination that is wrong in neither case, and both converge to the
   * same value once the cache fills, at which point this branch stops running
   * (`fresh` is false).
   *
   * ⚠ IT DOES NOT ENTER THE CACHE. `cacheAccum` still stores the SHADE, so the
   * cache converges to its own physically-derived answer and the fallback can
   * never become a fixed point of itself.
   */
  const hitRadiance = (r, dir, laneU, unlitFallback = null) => {
    const rad = vec3(0).toVar();
    const hitDist = float(RAY_MAX).toVar();
    const zi = r.z.toUint().toVar();
    If(r.x.greaterThan(0.5), () => {
      const entryF = bitAnd(zi, uint(7)).toFloat().toVar();
      const levelF = bitAnd(shiftRight(zi, uint(3)), uint(7)).toFloat().toVar();
      const voxF = shiftRight(zi, uint(6)).toFloat().toVar();
      const faceF = dominantFace(levelF, voxF, entryF, dir.negate()).toVar();
      const hn = normalOfFace(faceF).toVar();
      const hp = faceSamplePoint(levelF, voxF, hn).toVar();
      const c = cache.cacheRead(levelF, voxF, faceF).toVar();
      const fresh = c.w.lessThan(0.5).toVar();
      const track = bitAnd(zi.mul(uint(2654435761)).add(u.frame),
        u.shadeStrideU.max(uint(1)).sub(uint(1))).equal(uint(0)).toVar();
      rad.assign(c.xyz);
      If(fresh.or(u.shadeProb.greaterThan(0).and(track)), () => {
        const s = shadeHit(hp, hn, levelF, voxF, uint(1)).toVar();
        // `.toVar()` is load-bearing — see `probeTracePass`'s note.
        cache.cacheAccum(levelF, voxF, faceF, s, u.nCapU, u.cacheSmoothU).toVar();
        If(fresh, () => {
          if (unlitFallback) {
            // `palAt` is the same albedo `shadeHit` multiplies its own E by, so
            // the two terms differ only in which E they used.
            const fb = palAt(levelF, voxF).xyz.mul(unlitFallback(hp, hn)).mul(1 / Math.PI).toVar();
            rad.assign(max(s, fb));
          } else {
            rad.assign(s);
          }
          bump(STATS.freshShades, laneU);
        }).Else(() => { bump(STATS.reShades, laneU); });
      });
      hitDist.assign(r.y);
      bump(STATS.windowHits, laneU);
    }).Else(() => {
      rad.assign(u.skyColor);
      bump(STATS.skyMiss, laneU);
    });
    return vec4(rad, hitDist);
  };

  /**
   * §19 3.12's COMPACT-SOURCE NEE, as nine SH coefficients at a point.
   *
   * One expression, two builds: the emitter SLOTS when the caller supplied
   * them (the engine path — identical to `gi2System.emitterDirectPass`, which
   * is the point: one lamp, one energy, three paths) and the Cornell rig's
   * panel when it did not (`PANEL_RIG`). `n` is the receiver's face normal or
   * the zero vector for an open-air world probe, and `faced` says which — the
   * `cos > 0` CULL is only safe where a normal exists, and `shEval`'s cosine
   * convolution supplies the receiver's cosine at the pixel either way.
   */
  const shAdd = (sh, c, d) => {
    sh[0].addAssign(c.mul(0.282095));
    sh[1].addAssign(c.mul(d.y.mul(0.488603)));
    sh[2].addAssign(c.mul(d.z.mul(0.488603)));
    sh[3].addAssign(c.mul(d.x.mul(0.488603)));
    sh[4].addAssign(c.mul(d.x.mul(d.y).mul(1.092548)));
    sh[5].addAssign(c.mul(d.y.mul(d.z).mul(1.092548)));
    sh[6].addAssign(c.mul(d.z.mul(d.z).mul(3).sub(1).mul(0.315392)));
    sh[7].addAssign(c.mul(d.x.mul(d.z).mul(1.092548)));
    sh[8].addAssign(c.mul(d.x.mul(d.x).sub(d.y.mul(d.y)).mul(0.546274)));
  };
  const emitterSh = (!emitters?.length && !PANEL_RIG) ? null : (p, n, faced) => {
    const sh = [];
    for (let i = 0; i < 9; i++) sh.push(vec3(0).toVar());
    for (const slot of (emitters ?? [])) {
      const centre = vec3(slot.center).toVar();
      const reff = float(slot.reff).max(1e-3).toVar();
      const rgb = vec3(slot.color).toVar();
      const active = float(slot.radius).greaterThan(1e-5)
        .and(rgb.x.add(rgb.y).add(rgb.z).greaterThan(1e-6));
      If(active, () => {
        const wv = centre.sub(p).toVar();
        const d2 = dot(wv, wv).max(1e-4).toVar();
        const d = sqrt(d2).toVar();
        const wd = wv.div(d).toVar();
        const facing = select(faced, dot(n, wd).greaterThan(1e-3), true).toVar();
        If(facing, () => {
          const omega = float(Math.PI).min(float(Math.PI).mul(reff.mul(reff)).div(d2)).toVar();
          const reach = d.sub(reff).sub(float(v0 * 0.5)).max(v0 * 0.5).toVar();
          const vis = float(1).sub(traceWindow(p, wd, reach, select(faced, n, wd)).hit).toVar();
          If(vis.greaterThan(0.001), () => { shAdd(sh, rgb.mul(omega).mul(vis), wd); });
        });
      });
    }
    if (PANEL_RIG) {
      // §19 3.12's `panelNee` arm, honoured here too: 0 gives the panel back to
      // the TRANSPORT (`emOf` stops zeroing its emission) and this term must go
      // with it, or the rig's light is counted twice on the world path and once
      // on the screen path — two arms measuring two different scenes.
      If(u.panelNee.greaterThan(0.5).and(p.y.lessThan(u.panelCentre.y.sub(0.05))), () => {
        const pRay = p.add(select(faced, n, vec3(0, 1, 0)).mul(v0 * 0.5)).toVar();
        const yStop = u.panelCentre.y.div(v0).floor().mul(v0).sub(v0 * 0.5).toVar();
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const q = vec3(
              u.panelCentre.x.add(u.panelHalf.x.mul(sx ? 0.5 : -0.5)),
              u.panelCentre.y,
              u.panelCentre.z.add(u.panelHalf.y.mul(sy ? 0.5 : -0.5)),
            ).toVar();
            const wv = q.sub(p).toVar();
            const d2 = dot(wv, wv).max(1e-4).toVar();
            const d = sqrt(d2).toVar();
            const wd = wv.div(d).toVar();
            const cosP = wd.y.max(0).toVar();
            const facing = select(faced, dot(n, wd).greaterThan(1e-3), true).toVar();
            If(facing.and(cosP.greaterThan(1e-5)), () => {
              const tStop = yStop.sub(pRay.y).div(wd.y.max(1e-3)).min(d).max(0.05).toVar();
              const vis = float(1).sub(traceWindow(p, wd, tStop, select(faced, n, wd)).hit).toVar();
              shAdd(sh, u.panelRadiance.mul(cosP).mul(u.panelArea.mul(0.25)).div(d2).mul(vis), wd);
            });
          }
        }
      });
    }
    return sh;
  };

  // ══════════════════════════ §19 STAGE 3.13 — THE LATTICE ══════════════════
  const world = !useWorld ? null : createWorldProbes({
    win, trace, cache, tier,
    kit: {
      u, octU, cellOfWorld, dominantFace, hitRadiance, emitterSh, bump, STATS,
      RAY_MAX, OCT, O,
      // §19 3.17 — the SH2 cosine evaluation, so the lattice's own trace can
      // ask its parent cascade for the irradiance at a cold hit (see
      // `hitRadiance`'s `unlitFallback`). ONE formula, two call sites.
      shEval,
    },
  });
  if (world) Object.assign(u, world.uniforms);

  // ══════════════════════════════════════════════ the HZB screen segment
  //
  // Stackless closest-depth walk. The screen path of a straight world ray is a
  // straight SCREEN segment (a perspective projection maps lines to lines) and
  // `1/z` is linear along it — so the whole march is a 2-D DDA in `k ∈ [0, 1]`
  // with one reciprocal for the depth, and the only per-mip work is the
  // cell-boundary solve. On "behind a surface" or off-screen the walk hands the
  // ray to `traceWindow` at the LAST UNOCCLUDED position, never at the position
  // that failed — §L.2's step-back.
  //
  // ⭐⭐ §19 STAGE 3.11 — AND IT NOW REPORTS WHETHER IT COULD SEE AT ALL.
  // "No hit" and "could not look" are the same value in `outHit` and opposite
  // facts: the first is the depth buffer VOUCHING that the ray's path is
  // clear, the second is the walk having left the screen or been lost behind a
  // surface thicker than `HZB_THICKNESS`. The contact rule below hands the
  // window's authority away only on the first, so the two have to be told
  // apart. `outSeen` is 1 only when the walk ran the whole segment — to a hit,
  // or to `k = 1` — with both endpoints in front of the camera.
  const screenSegment = (p0, dir, segLen, outHit, outRad, outDist, outSeen, laneU) => {
    const c0 = u.viewProj.mul(vec4(p0, 1)).toVar();
    const c1 = u.viewProj.mul(vec4(p0.add(dir.mul(segLen)), 1)).toVar();
    If(c0.w.greaterThan(1e-3).and(c1.w.greaterThan(1e-3)), () => {
      const s0 = vec2(
        c0.x.div(c0.w).mul(0.5).add(0.5),
        float(1).sub(c0.y.div(c0.w).mul(0.5).add(0.5)),
      ).toVar();
      const s1 = vec2(
        c1.x.div(c1.w).mul(0.5).add(0.5),
        float(1).sub(c1.y.div(c1.w).mul(0.5).add(0.5)),
      ).toVar();
      const duv = s1.sub(s0).toVar();
      const inv0 = float(1).div(c0.w).toVar();
      const inv1 = float(1).div(c1.w).toVar();
      const dz = c1.w.sub(c0.w).toVar();
      // Screen parameter → world t. `z` is affine in the WORLD parameter, so
      // inverting the depth the walk already holds is exact; the degenerate
      // case (a ray parallel to the image plane) falls back to `k` itself.
      const worldT = (kk) => {
        const zk = float(1).div(mix(inv0, inv1, kk));
        return select(dz.abs().lessThan(1e-3), kk, zk.sub(c0.w).div(dz)).clamp(0, 1).mul(segLen);
      };
      const pixLen = vec2(duv.x.mul(u.widthF), duv.y.mul(u.heightF)).length().max(1e-4).toVar();
      // Start two full-res texels along, so the first cell is never the probe's
      // own pixel.
      const k = min(float(2).div(pixLen), float(0.25)).toVar();
      const mip = float(0).toVar();

      Loop({ start: 0, end: S_MAX, name: "hzbWalk" }, () => {
        const uv = s0.add(duv.mul(k)).toVar();
        If(uv.x.lessThan(0).or(uv.x.greaterThanEqual(1))
          .or(uv.y.lessThan(0)).or(uv.y.greaterThanEqual(1)), () => { Break(); });
        const mi = mipU.element(mip.toUint()).toVar();
        const mw = mi.y.toVar();
        const mh = mi.z.toVar();
        const px = uv.x.mul(mw).toVar();
        const py = uv.y.mul(mh).toVar();
        const cx = px.floor().toVar();
        const cy = py.floor().toVar();
        const dpx = duv.x.mul(mw).toVar();
        const dpy = duv.y.mul(mh).toVar();
        const nbx = cx.add(select(dpx.greaterThanEqual(0), float(1), float(0))).toVar();
        const nby = cy.add(select(dpy.greaterThanEqual(0), float(1), float(0))).toVar();
        const kx = select(dpx.abs().lessThan(1e-6), float(1e9), nbx.sub(px).div(dpx)).toVar();
        const ky = select(dpy.abs().lessThan(1e-6), float(1e9), nby.sub(py).div(dpy)).toVar();
        const dk = min(kx, ky).max(1e-7).add(1e-6).toVar();
        const kNext = min(k.add(dk), float(1)).toVar();
        const zNext = float(1).div(mix(inv0, inv1, kNext)).toVar();
        const zScene = hzb.element(mi.x.add(cy.mul(mw)).add(cx).toUint()).toVar();

        If(zNext.greaterThan(zScene.mul(1 + HZB_ZBIAS)), () => {
          If(mip.greaterThan(0.5), () => {
            mip.assign(mip.sub(1));
          }).Else(() => {
            If(zNext.lessThanEqual(zScene.mul(1 + HZB_ZBIAS + HZB_THICKNESS)), () => {
              outHit.assign(1);
              const fx = uv.x.mul(u.widthF).floor().clamp(0, u.widthF.sub(1)).toInt().toVar();
              const fy = uv.y.mul(u.heightF).floor().clamp(0, u.heightF.sub(1)).toInt().toVar();
              outRad.assign(litNode.load(ivec2(fx, fy)).xyz);
              outDist.assign(worldT(k));
              outSeen.assign(1);
              bump(STATS.screenHits, laneU);
            });
            // ⚠ THIS `Break` IS ALSO THE "LOST IT" EXIT. Falling out of the
            // thickness test means the ray went behind a surface further than
            // the depth buffer can account for — the walk did not finish the
            // segment and has NOT vouched for anything. `outSeen` stays 0.
            Break();
          });
        }).Else(() => {
          k.assign(kNext);
          mip.assign(min(mip.add(1), float(HZB_MIPS - 1)));
          If(kNext.greaterThanEqual(0.9999), () => { outSeen.assign(1); Break(); });
        });
      });

      // The counter kept its name and lost its job: it counts the rays whose
      // screen walk ended WITHOUT a hit, which is what it always measured.
      If(outHit.lessThan(0.5), () => { bump(STATS.handoffs, laneU); });
    });
  };

  // ══════════════════════════════════════════════ SHADER: probeTrace (§L.2/3)
  //
  // ⭐⭐⭐ §19 STAGE 3.10 — ONE THREAD PER (PROBE, OCT TEXEL), AND THE THREAD
  // OWNS THAT TEXEL OUTRIGHT. THE COMPLETE EVALUATION.
  //
  // Everything §L bend 1 and bend 2 argued for is REMOVED here, deliberately,
  // and both deserve their epitaph because both were right about the estimator
  // they were written for and wrong about the one the user asked for:
  //
  //   ⛔ THE IN-TEXEL JITTER (bend 1). Its argument was that fixed texel
  //      centres make the estimator BIASED — a light falling between two
  //      centres is under-counted at every probe and no amount of filtering
  //      removes it — while a jittered sample is an unbiased estimate of the
  //      texel's mean. Both halves are true. The half it did not price is that
  //      an unbiased estimate of a mean is a RANDOM VARIABLE, and a random
  //      variable on the image path is the noise the user is looking at. RC's
  //      own contract is the other trade: take the bias, keep the determinism,
  //      and buy the angular resolution back with `O` if it is ever visible.
  //      The direction now comes from `octU` — the SAME table `probeFilter`
  //      projects the SH against and `resolve` integrates over — so the ray's
  //      direction and the basis direction cannot drift apart.
  //   ⛔ THE TEXEL WINDOW AND THE PER-FRAME ROTATION (bend 2). A thread owned
  //      `64/R` consecutive texels and took the first front-facing one, so
  //      which direction a texel got and WHEN was a function of a per-probe,
  //      per-frame hash. With every texel evaluated every frame there is no
  //      window to search, no rotation to decorrelate and no write race to
  //      avoid: thread `k` writes texel `k`.
  //   ⛔ §P.3's NEED-DRIVEN RAY COUNT, and with it `rayBudget`'s mature share,
  //      the FRESH/FLAGGED/MATURE classes and the maturity census that fed
  //      them. They allocated a scarce ray budget; the budget is not scarce
  //      per probe any more, it is spent completely and the PROBE GRID is
  //      where it is now allocated (tile 16 — see `GATHER_TIERS`).
  //   ⛔ §19 3.6's VARIANCE-AWARE HYSTERESIS and its exponential Welford. Its
  //      entire job was to tell a real world change apart from SHOT NOISE in a
  //      single ray. There is no shot noise left to be fooled by, so the test
  //      has nothing to decide and the σ field it maintained has no reader.
  //
  // What is left is the contract in three lines: evaluate the texel, blend it
  // against the reprojected previous value at a FIXED α, store it. Every texel
  // of every live probe is written every frame, which is also why `probePlace`
  // no longer carries the map forward.
  const probeTracePass = useWorld ? null : Fn(() => {
    const xr = globalId.x.toVar();
    const ty = globalId.y.toVar();
    If(xr.greaterThanEqual(u.probeWU.mul(uint(OCT))).or(ty.greaterThanEqual(u.probeHU)),
      () => { Return(); });
    const tx = xr.div(uint(OCT)).toVar();
    const texel = xr.sub(tx.mul(uint(OCT))).toVar();
    const probe = ty.mul(u.probeWU).add(tx).toVar();
    const addr = octIdx(u.curBase, probe, texel).toVar();

    const ma = probeMeta.element(metaIdx(u.curBase, probe, 0)).toVar();
    const mb = probeMeta.element(metaIdx(u.curBase, probe, 1)).toVar();
    const nrm = mb.xyz.toVar();
    // ⭐⭐⭐ THE SUB-TEXEL POINT IS A 4×4 LATTICE OVER THE PROBE GRID —
    // SPATIAL, FIXED, AND NOT A HASH. §19 STAGE 3.10's ONE MEASURED DEVIATION.
    //
    // Texel CENTRES alone were measured and they do not hold: with every probe
    // in the scene sampling the same 64 directions, a COMPACT bright source is
    // quantized the same way at every probe and nothing downstream can undo it.
    // Cornell, at rest, tile 16, centres only:
    //
    //     floorCentre (directly under the panel)   1.62 × the 4-bounce ref
    //     floorSpot   (1 m away from it)           0.96 ×
    //
    // — a 60 % error a metre from a correct one, which is the signature of a
    // quantization step and not of a bias a gain could absorb. §L bend 1 said
    // exactly this would happen; what it got wrong was the CURE (a per-frame
    // jitter, i.e. noise), not the disease.
    //
    // The cure that is not noise is to move the offset from TIME to SPACE. The
    // probe's own grid coordinates pick one of 16 sub-texel points, so within
    // any 4×4 block of probes all sixteen appear exactly once — and the SH
    // bilateral that runs next is 5×5, i.e. it always spans a whole block. The
    // quantization error is therefore integrated away by a filter that already
    // exists, at zero extra rays, while each probe's own offset is CONSTANT IN
    // TIME: a parked camera traces the identical ray from the identical point
    // every frame, so this buys the parity back without putting one bit of
    // per-frame randomness on the image path.
    //
    // ⚠ THE SH BASIS STAYS AT THE TEXEL CENTRE (`octU`). The sample point is
    // inside its own texel by construction, so the direction disagrees with the
    // basis by less than half a texel — and that residual is the very thing the
    // 4×4 lattice decorrelates. Setting `probeDither = 0` restores exact
    // centres and is the arm every number above was measured on.
    //
    // ⭐⭐⭐ §19 STAGE 3.11a — AND THE KEY IS THE WORLD CELL, NOT THE TILE.
    //
    // "Constant in time" was true of a PARKED camera and false of a moving
    // one, and that qualification is the user's grain. The probe grid is a
    // SCREEN grid: as the camera turns, the world point a probe stands on is
    // covered by tile `(tx, ty)` on one frame and by `(tx±1, ty±1)` on the
    // next, so its sub-texel offset — and therefore all 64 of its ray
    // DIRECTIONS — change every frame. The value that comes back changes by
    // the quantization step, in whichever direction the new offset happens to
    // land, and `octAlpha`'s blend against the reprojected previous texel then
    // averages two differently-quantized estimates of the same direction. That
    // is a per-frame re-quantization, it ALTERNATES (a shifted tile shifts
    // back), and an alternating error is exactly what the sign receipt calls
    // noise: 3.10's own orbit arm reported 27 % flips against 0 % at rest.
    //
    // So the lattice is keyed to the probe's WORLD POSITION, quantized to
    // `DITHER_CELL` (half a level-0 cell) and hashed to one of the sixteen
    // points. A world point then gets the SAME sixteenth of a texel however
    // the camera looks at it, which is what makes the offset a property of the
    // scene instead of a property of the frame — and the neighbour
    // decorrelation the 5×5 SH filter integrates survives, because two probes
    // a tile apart still land in different cells at any useful depth.
    //
    // ⚠ IT IS A HASH AND STILL NOT A RANDOM NUMBER. `pcg` here is a fixed
    // function of a quantized world coordinate: no frame, no probe index, no
    // seed. The same point returns the same offset forever, which is the §T
    // contract's whole demand. `ditherWorld = 0` is 3.10's grid key, kept as
    // the arm the receipt is read against.
    const qcell = ma.xyz.div(v0 * DITHER_CELL_FRAC).add(float(1 << 14)).floor().toVar();
    const qh = pcg(
      qcell.x.toUint().mul(uint(73856093))
        .add(qcell.y.toUint().mul(uint(19349663)))
        .add(qcell.z.toUint().mul(uint(83492791))),
    ).toVar();
    const lx = mix(bitAnd(tx, uint(3)).toFloat(), bitAnd(qh, uint(3)).toFloat(), u.ditherWorld).toVar();
    const ly = mix(bitAnd(ty, uint(3)).toFloat(),
      bitAnd(shiftRight(qh, uint(2)), uint(3)).toFloat(), u.ditherWorld).toVar();
    const jx = mix(float(0.5), lx.add(0.5).div(4), u.probeDither).toVar();
    const jy = mix(float(0.5), ly.add(0.5).div(4), u.probeDither).toVar();
    const dir = octDirJit(
      bitAnd(texel, uint(O - 1)).toFloat(), shiftRight(texel, uint(OCT_SHIFT)).toFloat(), jx, jy,
    ).toVar();
    // ⚠ THE BACK HEMISPHERE IS *WRITTEN*, NOT SKIPPED. Nothing carries the map
    // forward any more, so a texel this kernel returns from early would hold
    // whatever the same slot held two frames ago — a different probe, on a
    // different surface, at full strength. `n = 0` is the hole marker every
    // consumer already understands (`probeFilter`'s `has`), and a back-facing
    // hole is left at zero rather than filled, which is what keeps SH band 0
    // from being doubled.
    If(ma.w.lessThan(0.5).or(dot(dir, nrm).lessThanEqual(0.02)), () => {
      probeOct.element(addr).assign(vec4(0));
      Return();
    });
    const pos = ma.xyz.toVar();
    bump(STATS.raysLaunched, xr);
    bump(STATS.raysTraced, xr);

    // ── segment 1: the window, from the PROBE, over the whole ray ────────
    //
    // ⭐ THE NORMAL BIAS AND THE ESCAPE. Half a cell clears a voxel the surface
    // merely passes through and clears nothing at all on one the voxelizer had
    // to DILATE — conservative triangle/voxel overlap dilates everything, so
    // the occupied set reaches a cell diagonal beyond the surface.
    // `traceWindow` walks the origin out of an occupied voxel by whole cells on
    // top of the bias; this call keeps the default half-cell and lets the
    // escape do the rest, and only where it is needed. Without it a probe on
    // the harness's 1 m sphere hit ITSELF at t ≈ 0 in three rays of four and
    // read back its own darkness.
    const r = traceWindow(pos, dir, float(RAY_MAX), nrm).raw.toVar();

    // ── segment 2: the screen, at CONTACT SCALE only ─────────────────────
    //
    // ⭐ WHERE THE SCREEN CAN BEAT THE WINDOW IS NEAR, AND ONLY NEAR. The cache
    // holds one radiance per voxel FACE, so at four metres a `v0`-sized cell is
    // already finer than the ray's own solid angle and the screen adds nothing;
    // at four CELLS the voxel IS the contact and the lit pixel is the exact
    // answer. Running the walk on every ray bought a screen hit for 5 % of them
    // and paid the full stackless descent for the other 95 %.
    //
    // The gate is the window's OWN hit distance, in cells — the scene's
    // measure, never a metric constant — and the walk is bounded to that
    // distance plus a cell, so a short segment is a short walk. Its answer is
    // taken only if the screen puts the surface within a cell of where the
    // window put it: the two disagreeing means the walk marched past something
    // the depth buffer could not show it, which is precisely the fault the
    // hand-off used to turn into a leak.
    const sHit = float(0).toVar();
    const sRad = vec3(0).toVar();
    const sDist = float(RAY_MAX).toVar();
    const sSeen = float(0).toVar();
    const contact = r.x.greaterThan(0.5).and(r.y.lessThan(v0 * CONTACT_CELLS)).toVar();
    If(u.hzbOn.greaterThan(0.5).and(contact), () => {
      screenSegment(pos.add(nrm.mul(v0 * 0.5)), dir, r.y.add(v0), sHit, sRad, sDist, sSeen, xr);
    });
    const sRaw = sHit.toVar();
    sHit.assign(select(
      sRaw.greaterThan(0.5).and(sDist.sub(r.y).abs().lessThan(v0)), float(1), float(0),
    ));

    // ══ ⭐⭐⭐ §19 STAGE 3.11 — AUTHORITY IN THE CONTACT BAND ════════════════
    //
    // THE BLACK BLOBS. After 3.9 the metre-wide blotches are gone and what is
    // left sits at junctions of geometry FINER THAN A VOXEL: a door panel
    // inside its frame, the recess around it, the foot of a planter, a cable
    // against a wall. The mechanism is the conservative voxelization's own
    // thickness. A probe standing on a 3 cm-deep panel shoots sideways and
    // lands in the DILATED cell of the frame member 5 cm away — the window
    // answers "occluded at half a cell" where the true surface is centimetres
    // off and the hemisphere is genuinely open — and 3.3's screen segment
    // could not overrule it, because it only ever ACCEPTED a screen hit that
    // AGREED with the window. Disagreement — the depth buffer saying the space
    // is clear where the window says it is solid — was thrown away, and that
    // is exactly the evidence this fault produces.
    //
    // So in the first two cells the authority is the screen's, and only where
    // the screen has actually LOOKED:
    //
    //   · the walk ran the whole segment (`sSeen`) and found NOTHING
    //     (`sRaw = 0`) → the depth buffer has vouched that the ray's path is
    //     clear to the window's hit, so the hit is a dilation artefact: the
    //     trace CONTINUES from `t + 1 cell` and the ray reports what is
    //     really there.
    //   · the walk could not look (off-screen, or lost behind a surface
    //     thicker than the HZB can account for) → the near hit keeps a
    //     distance-weighted share of its occlusion, `w = smoothstep(0,
    //     2·v_l, t)`, and the rest of the ray's radiance comes from what is
    //     CACHED beyond the hit.
    //
    // ⭐⭐ AND THE SOFT BRANCH READS THE CACHE ONLY — NEVER THE SKY, NEVER A
    // FRESH SHADE. That single restriction is what makes the branch unable to
    // leak. The outside faces of a sealed wall are seen by no pixel and shaded
    // by no ray, so their cache is zero: a soft ray that passes through a real
    // 5 cm wall collects `(1−w) × 0` and gets DARKER, while a soft ray through
    // a real opening collects the far surfaces the cache already holds. The
    // failure mode of the approximation points away from the leak, which is
    // the property a conservative structure has to keep. It is also why the
    // soft branch costs one buffer read and not a second `shadeHit` —
    // `probeTrace` is 53 kB of WGSL and a second copy of that estimator is
    // the compile budget, not a detail.
    const bandM = float(v0 * CONTACT_AUTH_CELLS);
    const inBand = u.contactOn.greaterThan(0.5)
      .and(r.x.greaterThan(0.5)).and(r.y.lessThan(bandM)).and(sHit.lessThan(0.5)).toVar();
    const vouched = sSeen.greaterThan(0.5).and(sRaw.lessThan(0.5))
      .or(u.contactForce.greaterThan(0.5)).toVar();
    const contStart = r.y.add(v0).toVar();
    const rc = vec4(0).toVar();
    If(inBand, () => {
      bump(STATS.contactBand, xr);
      If(sSeen.greaterThan(0.5), () => { bump(STATS.contactSeen, xr); });
      // ⚠ THE CONTINUATION'S "NORMAL" IS THE RAY'S OWN DIRECTION. `traceWindow`
      // uses it for the bias and for the escape, and walking the origin FORWARD
      // by whole cells while it is inside occupancy is exactly what has to
      // happen here: the origin starts one cell past a hit that may itself be a
      // dilated shell, and the escape is what carries it out of the rest of it.
      rc.assign(traceWindow(pos.add(dir.mul(contStart)), dir,
        float(RAY_MAX).sub(contStart), dir).raw);
    });
    const takeCont = inBand.and(vouched).toVar();
    If(takeCont, () => { bump(STATS.contactCont, xr); });
    // The effective hit the full evaluation below runs on.
    const rEff = vec4(
      select(takeCont, rc.x, r.x),
      select(takeCont, rc.y.add(contStart), r.y),
      select(takeCont, rc.z, r.z),
      r.w,
    ).toVar();
    // The soft branch: `w` on the near hit's occlusion, and the cached
    // radiance beyond it for the rest.
    const sm = r.y.div(bandM).clamp(0, 1).toVar();
    const softW = select(inBand.and(vouched.not()),
      sm.mul(sm).mul(float(3).sub(sm.mul(2))), float(1)).toVar();
    const softL = vec3(0).toVar();
    If(inBand.and(vouched.not()).and(rc.x.greaterThan(0.5)), () => {
      const zc = rc.z.toUint().toVar();
      const eF = bitAnd(zc, uint(7)).toFloat().toVar();
      const lF = bitAnd(shiftRight(zc, uint(3)), uint(7)).toFloat().toVar();
      const vF = shiftRight(zc, uint(6)).toFloat().toVar();
      const fF = dominantFace(lF, vF, eF, dir.negate()).toVar();
      const cc = cache.cacheRead(lF, vF, fF).toVar();
      softL.assign(cc.xyz.mul(select(cc.w.greaterThan(0.5), float(1), float(0))));
    });

    // ── the radiance: the screen's own pixel, or the hit voxel's cache face ─

    // ── segment 2: the window, then the cache ──────────────────────────────
    const rad = vec3(0).toVar();
    const hitDist = float(RAY_MAX).toVar();
    If(sHit.greaterThan(0.5), () => {
      rad.assign(sRad);
      hitDist.assign(sDist);
    }).Else(() => {
      // ⚠ `rEff`, NOT `r` — see the contact rule above. Everything below reads
      // the EFFECTIVE hit and nothing below knows whether it is the window's
      // first hit or the continuation past a dilated one, which is the point:
      // the slot, the shade point, the re-shade and the distance move together
      // or the cache is fed from one surface and read at another.
      const zi = rEff.z.toUint().toVar();
      If(rEff.x.greaterThan(0.5), () => {
        const entryF = bitAnd(zi, uint(7)).toFloat().toVar();
        const levelF = bitAnd(shiftRight(zi, uint(3)), uint(7)).toFloat().toVar();
        const voxF = shiftRight(zi, uint(6)).toFloat().toVar();
        // ⭐⭐ §19 STAGE 3.9 — the voxel's dominant face, not the ray's entry
        // face. One byte and two occupancy words, at the hit; see
        // `dominantFace`. Everything below reads `faceF` and nothing below
        // knows which of the two produced it, which is the point: the slot,
        // the shade point, the escape direction and the re-shade all move
        // together or the cache holds two different surfaces in one word.
        const faceF = dominantFace(levelF, voxF, entryF, dir.negate()).toVar();
        const hn = normalOfFace(faceF).toVar();
        const hp = faceSamplePoint(levelF, voxF, hn).toVar();
        const c = cache.cacheRead(levelF, voxF, faceF).toVar();
        // ⭐⭐ §19 STAGE 3.7 P.1 — A HIT MAY RE-SHADE, AND THE RAY STILL CARRIES
        // THE CACHED VALUE.
        //
        // Two different questions get two different answers here, and conflating
        // them would undo 3.6. What the CACHE needs is another sample, so it can
        // stop being a single Monte-Carlo draw kept forever. What the RAY needs
        // is the best estimate of this face's radiance, which is the running
        // mean the cache already holds — NOT the noisy sample just drawn. So the
        // re-shade feeds the cache and the ray reads the cache; only a face that
        // has never been shaded returns its own fresh sample, because there is
        // nothing else to return. Returning the sample would have pumped the
        // shade estimator's variance straight into the probe atlas, which is the
        // closed loop `injectPass`'s glossy note describes from the other side.
        const fresh = c.w.lessThan(0.5).toVar();
        // ⭐⭐ §19 STAGE 3.10 — A CADENCE, NOT A COIN FLIP.
        //
        // §P.1 rolled a die per (voxel, probe, frame) so that two rays hitting
        // one face in one frame would not both re-shade. Under the new
        // contract that die is the last stochastic input left on the path, and
        // it does not need to be one: `shadeHit` is now a FIXED FUNCTION of
        // the face (see its header), so two rays that both re-shade the same
        // face in the same frame compute and store the same number, and
        // "which faces are re-shaded this frame" is free to be a deterministic
        // function of `(voxel, frame)`. What the cadence controls is LATENCY
        // and COST; it cannot control noise, because there is none to control.
        //
        // ⚠ STILL GATED ON `shadeProb > 0`, which is the `PRE37` arm's whole
        // meaning ("the cache is one-shot again"). The VALUE of `shadeProb` no
        // longer sets the rate — `shadeStrideU` does — but zero still means
        // never.
        const track = bitAnd(zi.mul(uint(2654435761)).add(u.frame),
          u.shadeStrideU.max(uint(1)).sub(uint(1))).equal(uint(0)).toVar();
        rad.assign(c.xyz);
        If(fresh.or(u.shadeProb.greaterThan(0).and(track)), () => {
          const s = shadeHit(hp, hn, levelF, voxF, uint(1)).toVar();
          // TSL: `.toVar()` IS LOAD-BEARING, NOT STYLE. A function call whose
          // result nothing consumes is never built into the shader: the node
          // graph is walked from its outputs, and an unused call node has no
          // output to be walked from. Without it this line compiles to nothing,
          // the cache stays empty forever, and the only symptom is that
          // `freshShades` equals `windowHits` EXACTLY - every hit shading
          // itself again because the last one was never stored. Measured
          // 2026-08-27: 614 bricks owned a slot and 0 of 239 872 slot words
          // carried radiance. Anything called for its SIDE EFFECT has to be
          // pinned to the stack.
          cache.cacheAccum(levelF, voxF, faceF, s, u.nCapU, u.cacheSmoothU).toVar();
          If(fresh, () => {
            rad.assign(s);
            bump(STATS.freshShades, xr);
          }).Else(() => { bump(STATS.reShades, xr); });
        });
        hitDist.assign(rEff.y);
        bump(STATS.windowHits, xr);
      }).Else(() => {
        rad.assign(u.skyColor);
        bump(STATS.skyMiss, xr);
      });
      // The soft branch's mix. `softW` is 1 on every ray the contact rule did
      // not touch, so this line is the identity everywhere else — including on
      // the screen-hit path above, which `inBand` excludes by construction.
      rad.assign(rad.mul(softW).add(softL.mul(float(1).sub(softW))));
    });

    // ── §19 STAGE 3.10: A FIXED-α BLEND, AND NOTHING ELSE ─────────────────
    //
    // ⭐⭐ THE INPUT IS NOISELESS, SO THE MEMORY HAS ONE JOB LEFT.
    //
    // `rad` is a COMPLETE evaluation of this texel's direction — the same ray
    // every frame, from the same anchor, against the same world — so the only
    // reasons it can differ from last frame's are the three the user is happy
    // to see as LAG rather than as grain: the world cache converging under it,
    // the world itself changing, and the probe's own anchor having moved with
    // the camera. A fixed α turns each of those into a ramp. There is nothing
    // for it to average out, because there is nothing random to average.
    //
    // ⚠ THE PREVIOUS VALUE IS READ HERE, NOT CARRIED BY `probePlace`. Slot 2's
    // `.x` is the reprojected source probe (`-1` when the reprojection missed),
    // and this thread already owns exactly one texel — so one read of
    // `probeOct[prevBase, src, texel]` replaces a 64-texel copy per probe. A
    // miss, or a previous texel that was a hole, means DISOCCLUSION: α = 1, the
    // current frame whole, which is the one case where an abrupt answer is the
    // correct one.
    const mc = probeMeta.element(metaIdx(u.curBase, probe, 2)).toVar();
    const src = mc.x.toVar();
    const prevV = probeOct.element(
      octIdx(u.prevBase, src.max(0).toUint(), texel),
    ).toVar();
    const hasPrev = src.greaterThanEqual(0).and(prevV.w.greaterThanEqual(PACK_N)).toVar();
    const a = select(hasPrev, u.octAlpha.clamp(0, 1), float(1)).toVar();
    bump(STATS.texelsSeen, xr);
    If(hasPrev, () => { bump(STATS.matureTexels, xr); });
    // `n` is a plain WITNESS now — it is the hole marker `probeFilter` tests
    // (`w >= PACK_N`) and the census `STATS.matureTexels` reports, and no α is
    // derived from it. σ is written as zero: the field that carried the
    // exponential Welford's spread has no reader left, and leaving a stale
    // value in it would be a number a future reader could believe.
    const nNext = min(prevV.w.max(0).div(PACK_N).floor().add(1), u.historyU).toVar();
    const distQNext = min(hitDist, float(RAY_MAX)).mul(DIST_Q / RAY_MAX)
      .add(0.5).floor().clamp(0, DIST_Q).toVar();
    probeOct.element(addr).assign(vec4(
      mix(prevV.xyz, rad, a),
      nNext.mul(PACK_N).add(distQNext.mul(PACK_D)),
    ));
  })().compute(dispatch2d(probeW * OCT, probeH), WG);

  // ══════════════════════════════════════ SHADER: probeFilter, part 1 (§L.4)
  //
  // ⭐⭐ §L.4 FILTERS THE OCT MAP; THE RESOLVE READS THE SH. Stage 3.2's shape
  // ran a 3×3 bilateral over all 64 OCT TEXELS — 576 buffer reads per probe —
  // and then projected the result onto 9 SH coefficients, which is the only
  // thing the diffuse path consumes. But the bilateral's weights are PER PROBE
  // (they were hoisted out of the texel loop for exactly that reason), and the
  // SH projection is LINEAR, so
  //
  //     SH( Σ_j w_j · map_j / Σ w_j )  =  Σ_j w_j · SH(map_j) / Σ w_j
  //
  // — the filter can run on NINE COEFFICIENTS instead of sixty-four texels and
  // land on the same numbers. The one place the two forms differ is the
  // per-texel validity mask: the old form averaged a texel over only the
  // neighbours that HAD it, then filled what nothing had with the pooled mean.
  // Here each probe fills its own holes from its OWN cosine-weighted mean
  // first, and the pooling that follows is over whole probes. On a probe with a
  // complete front hemisphere — which is what the 99 % reprojection rate says
  // is now the common case — there are no holes and the two are identical.
  //
  // So this kernel is per-probe with NO neighbourhood: copy the raw map, fill
  // its holes, build the 2×2 mip the glossy tap reads, project the SH. 128
  // reads instead of 640. Part 2 does the 3×3, on the coefficients.
  const probeFilterPass = useWorld ? null : Fn(() => {
    const tx = globalId.x.toVar();
    const ty = globalId.y.toVar();
    If(tx.greaterThanEqual(u.probeWU).or(ty.greaterThanEqual(u.probeHU)), () => { Return(); });
    const probe = ty.mul(u.probeWU).add(tx).toVar();
    const ma = probeMeta.element(metaIdx(u.curBase, probe, 0)).toVar();
    const mb = probeMeta.element(metaIdx(u.curBase, probe, 1)).toVar();
    const nrm = mb.xyz.toVar();
    const alive = ma.w.greaterThan(0.5).toVar();

    // ── pass 1: the raw map, and what this probe has actually SEEN ────────
    const meanAcc = vec3(0).toVar();
    const meanW = float(0).toVar();
    Loop({ start: 0, end: OCT, name: "ft" }, ({ ft }) => {
      const t = uint(ft).toVar();
      const tv = probeOct.element(octIdx(u.curBase, probe, t)).toVar();
      // §L.4: a texel nothing has sampled (n = 0) is a HOLE, not a black
      // sample — that is the difference between a filter and a fade. It is
      // marked with a negative alpha, a value the real alpha (see `PACK_N`)
      // can never take.
      const has = tv.w.greaterThanEqual(PACK_N).and(alive).toVar();
      const val = select(has, tv.xyz, vec3(0)).toVar();
      probeFiltered.element(filtIdx(probe, t)).assign(vec4(
        val, select(has, tv.w, float(-1)),
      ));
      const e0 = octU.element(t).toVar();
      const cw = select(has, dot(e0.xyz, nrm).max(0).mul(e0.w), float(0)).toVar();
      meanAcc.addAssign(val.mul(cw));
      meanW.addAssign(cw);
    });
    // The cosine-weighted mean radiance over the directions this probe HAS
    // data for. Filling the holes with it is what turns `Σ L·cos·Δω` from a
    // sum over a PARTIAL hemisphere into an estimate of the whole one.
    const holeFill = meanAcc.div(meanW.max(1e-6)).toVar();
    const anyData = meanW.greaterThan(1e-6).toVar();

    // ── pass 2: patch the holes, build the 2×2 mip and the SH2 in ONE walk ─
    //
    // ⭐ §L.4 SAYS "SKIP TEXELS WITH n = 0" AND THAT IS RIGHT FOR THE FILTER
    // AND WRONG FOR THE RESOLVE. A probe whose oct map is a quarter filled
    // hands the resolve a cosine sum over a QUARTER of the hemisphere and the
    // resolve divides by nothing, so the surface reads a quarter as bright.
    // Directions with no data are not black; they are unknown, and the
    // least-committal estimate of an unknown direction is the mean of the
    // known ones. Only the FRONT hemisphere is patched — the back is
    // legitimately zero and filling it would double SH band 0.
    const sh = [];
    for (let i = 0; i < 9; i++) sh.push(vec3(0).toVar());
    Loop({ start: 0, end: MIP_TEXELS, name: "mp" }, ({ mp }) => {
      const mi = uint(mp).toVar();
      const mx = bitAnd(mi, uint(MIP_RES - 1)).toVar();
      const my = shiftRight(mi, uint(Math.log2(MIP_RES))).toVar();
      const s = vec3(0).toVar();
      Loop({ start: 0, end: 4, name: "mq" }, ({ mq }) => {
        const qx = mx.mul(uint(2)).add(bitAnd(uint(mq), uint(1))).toVar();
        const qy = my.mul(uint(2)).add(shiftRight(uint(mq), uint(1))).toVar();
        const t = qy.mul(uint(O)).add(qx).toVar();
        const addr = filtIdx(probe, t).toVar();
        const cur = probeFiltered.element(addr).toVar();
        const e = octU.element(t).toVar();
        const d = e.xyz.toVar();
        const isHole = cur.w.lessThan(0).and(dot(d, nrm).greaterThan(0)).and(anyData).toVar();
        const val = select(isHole, holeFill, cur.xyz).toVar();
        If(isHole, () => { probeFiltered.element(addr).assign(vec4(val, 0)); });
        s.addAssign(val);
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
      probeFiltered.element(mipIdx(probe, mi)).assign(vec4(s.mul(0.25), 0));
    });
    // ⚠ WRITTEN TO BOTH HALVES, AND THAT IS A SAFETY PROPERTY, NOT WASTE.
    // `shIdx` — the address every OTHER consumer of this buffer uses, inside
    // this file and outside it — is the FILTERED half, so a chain that never
    // dispatches part 2 still reads a correct (merely unfiltered) SH rather
    // than a stale buffer, and an emitter term added at `shIdx` after the
    // filter still lands where the resolve looks. Nine vec4 writes per probe.
    for (let i = 0; i < 9; i++) {
      const v = vec4(sh[i], 0);
      probeSh.element(shRawIdx(probe, i)).assign(v);
      probeSh.element(shIdx(probe, i)).assign(v);
    }
  })().compute(dispatch2d(probeW, probeH), WG);

  // ══════════════════════════════════════ SHADER: probeFilter, part 2 (§L.4)
  //
  // §L.4's probe-space bilateral, on the NINE COEFFICIENTS. The weights are
  // the same ones the texel form used — plane distance in units of a level-0
  // cell (the scene's own length, never a metric constant) and normal
  // agreement raised to the fourth so a probe round a corner contributes
  // nothing — and they were already per-probe, so nothing about the filter's
  // shape changes; only what it is applied to.
  //
  // ⭐ THE RADIUS IS 2 (A 5×5) SINCE §19 STAGE 3.6, AND WIDTH IS THE CHEAP AXIS.
  //
  // §L.4 wrote 3×3 when the filter still ran over 64 OCT TEXELS: 576 buffer
  // reads per probe, and widening it to 5×5 would have been 1600. Since 3.3
  // the same filter runs on NINE COEFFICIENTS, so 3×3 is 81 reads and 5×5 is
  // 225 — and the kernel it lives in was 0.05 ms of a 2.6 ms chain. Variance
  // falls with the number of INDEPENDENT probes pooled, and at tile 8 a 5×5
  // neighbourhood is 25 probes each of which traced its own directions from
  // its own anchor: the same trade the AO rebuild found (`gi-vxao-rebuild`),
  // which is that filter taps buy variance reduction about ten times cheaper
  // than rays do. The plane and normal weights are what keep the extra reach
  // from being a blur — a tap that is not on this surface is multiplied by
  // zero whether it is one probe away or two.
  //
  // Both radii are built; `passes.probeShFilter3` is the A/B's other arm.
  const makeShFilter = (radius) => useWorld ? null : Fn(() => {
    const tx = globalId.x.toVar();
    const ty = globalId.y.toVar();
    If(tx.greaterThanEqual(u.probeWU).or(ty.greaterThanEqual(u.probeHU)), () => { Return(); });
    const probe = ty.mul(u.probeWU).add(tx).toVar();
    const ma = probeMeta.element(metaIdx(u.curBase, probe, 0)).toVar();
    const mb = probeMeta.element(metaIdx(u.curBase, probe, 1)).toVar();
    const pos = ma.xyz.toVar();
    const nrm = mb.xyz.toVar();

    const acc = [];
    for (let i = 0; i < 9; i++) acc.push(vec3(0).toVar());
    const wsum = float(0).toVar();
    // Unrolled in JS so the neighbour offsets are compile-time and no runtime
    // `%` is needed.
    for (let oy = -radius; oy <= radius; oy++) {
      for (let ox = -radius; ox <= radius; ox++) {
        const nx = tx.toInt().add(int(ox)).toVar();
        const ny = ty.toInt().add(int(oy)).toVar();
        const inB = nx.greaterThanEqual(int(0)).and(ny.greaterThanEqual(int(0)))
          .and(nx.lessThan(u.probeWU.toInt())).and(ny.lessThan(u.probeHU.toInt())).toVar();
        const np = ny.clamp(int(0), u.probeHU.toInt().sub(int(1))).toUint()
          .mul(u.probeWU).add(nx.clamp(int(0), u.probeWU.toInt().sub(int(1))).toUint()).toVar();
        const na = probeMeta.element(metaIdx(u.curBase, np, 0)).toVar();
        const nn = probeMeta.element(metaIdx(u.curBase, np, 1)).toVar();
        const wp = exp(dot(nrm, na.xyz.sub(pos)).abs().div(v0).negate()).toVar();
        const wn = dot(nrm, nn.xyz).max(0).toVar();
        // ⚠ A SPATIAL TERM, NOT A BOX. At radius 2 the corner tap is 2.8
        // probes away and a flat weight would let it count as much as the
        // probe next door — that IS a blur. A Gaussian over the probe grid
        // (σ = one probe) is the tent the 3×3 was implicitly close to.
        const g = Math.exp(-(ox * ox + oy * oy) / 2);
        const w = select(
          inB.and(na.w.greaterThan(0.5)).and(ma.w.greaterThan(0.5)),
          wp.mul(wn.mul(wn).mul(wn).mul(wn)).mul(g), float(0),
        ).toVar();
        If(w.greaterThan(1e-5), () => {
          for (let i = 0; i < 9; i++) {
            acc[i].addAssign(probeSh.element(shRawIdx(np, i)).xyz.mul(w));
          }
          wsum.addAssign(w);
        });
      }
    }
    const inv = select(wsum.greaterThan(1e-5), float(1).div(wsum.max(1e-5)), float(0)).toVar();
    for (let i = 0; i < 9; i++) {
      probeSh.element(shIdx(probe, i)).assign(vec4(acc[i].mul(inv), 0));
    }
  })().compute(dispatch2d(probeW, probeH), WG);
  const probeShFilterPass = makeShFilter(SH_R);
  const probeShFilter3Pass = makeShFilter(1);

  // ══════════════════════════════ SHADER: panelDirect (§19 Stage 3.12)
  //
  // ⭐⭐ THE COMPACT SOURCE IS SAMPLED AT THE PROBE, NOT FOUND BY A RAY.
  //
  // A 3 × 3 m panel six metres above a floor probe subtends ~0.24 sr. The oct
  // map divides the sphere into 64 texels of ~0.20 sr each, so whether that
  // probe "sees" the panel — and how much of it — is decided by whether one
  // fixed direction happens to land inside a solid angle about its own size.
  // That is a quantizer, it is the reason `probeDither` existed, and no amount
  // of temporal filtering can fix it because it is not a temporal error: at
  // rest it is a WRONG, PERFECTLY STABLE number (floorCentre 1.55 × the
  // reference with the dither off, boxTop 0.07 ×).
  //
  // So the panel is estimated the way every other light in this engine already
  // is: next-event, with the shadow ray as the only thing that is traced. Four
  // deterministic strata over the panel's area, `L · cosP · (A/4) / d²` per
  // stratum as the radiance-times-solid-angle a delta carries, projected onto
  // the probe's SH — where `shEval`'s Ramamoorthi cosine convolution supplies
  // the receiver's own `cosX`, which is why it is absent here.
  //
  // ⚠ THIS IS `gi2System.buildEmitterDirectPass`'S SHAPE, DELIBERATELY. Same
  // slot in the chain (after the SH bilateral, before `resolveHalf` — the
  // first kernel that reads the filtered half), same accumulate-then-write-once
  // discipline for the nine coefficients, same "stop the shadow ray short of
  // the emitter's own voxelized body" rule. A harness whose light arrives by a
  // different mechanism from the engine's cannot gate the engine.
  //
  // ⚠ BUILT ONLY ON THE RIG (`PANEL_RIG`, which is `!emitters?.length &&
  // crops > 0` — see its note). That is the same "do not compile the rig's WGSL
  // into a scene build" rule the panel block in `shadeHit` learned the
  // expensive way (four inlined DDAs, 2.5 s of pipeline compile, first light
  // 1.8 → 3.6 s on the Level), AND it is what makes `emOf`'s removal of the
  // emission safe: the two are one build decision, never two.
  const panelDirectPass = (!PANEL_RIG || useWorld) ? null : Fn(() => {
    const gx = globalId.x.toVar();
    const gy = globalId.y.toVar();
    If(gx.greaterThanEqual(u.probeWU).or(gy.greaterThanEqual(u.probeHU)), () => { Return(); });
    If(u.panelNee.lessThan(0.5), () => { Return(); });
    const probe = gy.mul(u.probeWU).add(gx).toVar();
    const a = probeMeta.element(metaIdx(u.curBase, probe, uint(0))).toVar();
    If(a.w.lessThan(0.5), () => { Return(); });
    const p = a.xyz.toVar();
    const n = normalize(probeMeta.element(metaIdx(u.curBase, probe, uint(1))).xyz).toVar();
    // The same skip `shadeHit`'s panel block takes, for the same reason: at or
    // above the panel's own plane its emission is the surface's own and a light
    // cannot illuminate itself without being counted twice.
    If(p.y.greaterThanEqual(u.panelCentre.y.sub(0.05)), () => { Return(); });

    const sh = [];
    for (let i = 0; i < 9; i++) sh.push(vec3(0).toVar());
    // ⚠ THE STOP PLANE IS MEASURED FROM THE ORIGIN THE TRACE WILL USE, which is
    // `p` pushed half a cell along the normal — see the long note in
    // `shadeHit`'s panel block. Getting this wrong does not dim the answer, it
    // zeroes it, and only on the surfaces whose normal points at the light.
    const pRay = p.add(n.mul(v0 * 0.5)).toVar();
    const yStop = u.panelCentre.y.div(v0).floor().mul(v0).sub(v0 * 0.5).toVar();
    for (let sy = 0; sy < 2; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        const q = vec3(
          u.panelCentre.x.add(u.panelHalf.x.mul(sx ? 0.5 : -0.5)),
          u.panelCentre.y,
          u.panelCentre.z.add(u.panelHalf.y.mul(sy ? 0.5 : -0.5)),
        ).toVar();
        const wv = q.sub(p).toVar();
        const d2 = dot(wv, wv).max(1e-4).toVar();
        const d = sqrt(d2).toVar();
        const wd = wv.div(d).toVar();
        const cosX = dot(n, wd).toVar();
        const cosP = wd.y.max(0).toVar();
        If(cosX.mul(cosP).greaterThan(1e-5), () => {
          const tStop = yStop.sub(pRay.y).div(wd.y.max(1e-3)).min(d).max(0.05).toVar();
          const vis = float(1).sub(traceWindow(p, wd, tStop, n).hit).toVar();
          const c = u.panelRadiance.mul(cosP).mul(u.panelArea.mul(0.25)).div(d2).mul(vis).toVar();
          sh[0].addAssign(c.mul(0.282095));
          sh[1].addAssign(c.mul(wd.y.mul(0.488603)));
          sh[2].addAssign(c.mul(wd.z.mul(0.488603)));
          sh[3].addAssign(c.mul(wd.x.mul(0.488603)));
          sh[4].addAssign(c.mul(wd.x.mul(wd.y).mul(1.092548)));
          sh[5].addAssign(c.mul(wd.y.mul(wd.z).mul(1.092548)));
          sh[6].addAssign(c.mul(wd.z.mul(wd.z).mul(3).sub(1).mul(0.315392)));
          sh[7].addAssign(c.mul(wd.x.mul(wd.z).mul(1.092548)));
          sh[8].addAssign(c.mul(wd.x.mul(wd.x).sub(wd.y.mul(wd.y)).mul(0.546274)));
        });
      }
    }
    for (let i = 0; i < 9; i++) {
      const idx = shIdx(probe, i);
      const cur = probeSh.element(idx).toVar();
      probeSh.element(idx).assign(vec4(cur.xyz.add(sh[i]), 0));
    }
  })().compute(dispatch2d(probeW, probeH), WG);

  // ══════════════════════════════════════════════ SHADER: resolve (§L.5)
  //
  // Both integrators are built and `USE_SH` picks one per tier, which is what
  // §L.5 asks for ("do SH on phone tiers, oct sum on desktop; MEASURE BOTH").
  const irradianceFromOct = (probe, nrmP) => {
    const E = vec3(0).toVar();
    Loop({ start: 0, end: OCT, name: "ig" }, ({ ig }) => {
      const t = uint(ig).toVar();
      const e = octU.element(t).toVar();
      const c = dot(e.xyz, nrmP).toVar();
      If(c.greaterThan(0), () => {
        E.addAssign(probeFiltered.element(filtIdx(probe, t)).xyz.mul(c).mul(e.w));
      });
    });
    return E;
  };
  /**
   * Irradiance from NINE COEFFICIENTS ALREADY IN REGISTERS.
   *
   * ⭐ SH EVALUATION IS LINEAR IN THE COEFFICIENTS, AND THE RESOLVE'S 4-CORNER
   * BLEND IS A WEIGHTED SUM — so `Σ w·eval(L_c, N) / Σ w` and `eval(Σ w·L_c /
   * Σ w, N)` are THE SAME NUMBER, and Stage 3.2 was computing the first one.
   * That is thirty-odd multiply-adds per channel, five times per pixel (four
   * corners plus the fallback), to produce a value that one evaluation gives.
   * Accumulating the coefficients instead and evaluating once is not an
   * approximation and has no crop delta by construction; it is the same
   * arithmetic with the sum pulled inside the linear map.
   */
  // ⚠ §19 3.17 — A `function`, NOT A `const` ARROW, AND THAT IS HOISTING RATHER
  // THAN STYLE: `createWorldProbes` is called ~900 lines above this point and
  // its trace kernel now evaluates the parent cascade's SH through this exact
  // formula. A `const` would be in its temporal dead zone there; moving the
  // definition up would put a resolve helper in the middle of the shading kit.
  /**
   * ⭐⭐⭐ §19 4.10 — THE CLIFF AT THE END OF `shEval`, AND WHAT REPLACED IT.
   *
   * This used to end `.max(vec3(0))`. A truncated SH2 reconstructed on a
   * hemisphere with hard occluders RINGS — the band-1/2 terms overshoot
   * negative — and `max(0)` turns a smoothly-varying small negative into a
   * FLAT EXACT ZERO with a dead gradient, which neighbouring pixels straddle.
   * `probe:gi2-ref` pose B measured it: `DARK3`, DC `+0.238`, raw `−0.026`,
   * three channels clamped, `E_gi2` exactly 0.00000.
   *
   * ⭐ THE BAND-0 TERM IS THE ONE THAT CANNOT BE NEGATIVE. `L[0]` is a sum of
   * radiances times non-negative weights, so `DC = 0.886·L0 >= 0` always, and
   * the reconstruction expressed as a FRACTION of it — `w = 1 + AC/DC` — is the
   * natural place to be non-negative. At or above `SH_FLOOR` the answer is the
   * linear reconstruction BIT FOR BIT (the old arithmetic minus its clamp);
   * below it the fraction decays exponentially to zero instead of stopping
   * dead, matching value AND slope at the join. C¹, strictly positive wherever
   * the probe holds any light at all, and it can add at most `SH_FLOOR · DC` —
   * 5 % of the probe's own spherical mean — anywhere in the frame.
   *
   * ⚠⚠ AND IT IS NOT WHY `DARK3` WAS BLACK. Measured BEFORE it was written:
   * the clamp bites 0 of 45 covered (cascade, point) pairs in pose A and 3 of
   * 29 in pose B, and where it bites, the UNCLAMPED value is a small negative
   * (−0.026 against a path-traced 0.563) — so removing the clamp recovers
   * nothing. The magnitude fault is the cascade SCHEDULE (§AG.3); this is the
   * per-pixel discontinuity, priced and removed on its own terms and no more.
   * ⛔ `__gi2ShClamp = 1` restores the raw `max(0)`, for the A/B.
   */
  const SH_FLOOR = 0.05;
  const SH_HARD_CLAMP = (globalThis.__gi2ShClamp ?? 0) !== 0;
  function shEval(L, n) {
    const c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
    const dc = L[0].mul(c4);
    const ac = L[8].mul(c1).mul(n.x.mul(n.x).sub(n.y.mul(n.y)))
      .add(L[6].mul(c3).mul(n.z.mul(n.z)))
      .sub(L[6].mul(c5))
      .add(L[4].mul(2 * c1).mul(n.x).mul(n.y))
      .add(L[7].mul(2 * c1).mul(n.x).mul(n.z))
      .add(L[5].mul(2 * c1).mul(n.y).mul(n.z))
      .add(L[3].mul(2 * c2).mul(n.x))
      .add(L[1].mul(2 * c2).mul(n.y))
      .add(L[2].mul(2 * c2).mul(n.z));
    const lin = dc.add(ac);
    if (SH_HARD_CLAMP) return lin.max(vec3(0));
    // `dcs` only ever divides — above the join the returned value is `lin`
    // itself, so the epsilon cannot brighten a probe that holds nothing.
    const dcs = dc.max(1e-8);
    const w = lin.div(dcs);
    // ⚠ THE EXPONENT IS CAPPED AT 0. `w` is unbounded ABOVE (a bright probe on
    // a facing normal) and `exp` of a large positive is `inf`; `mix` would then
    // multiply that `inf` by a zero lane and produce NaN on exactly the
    // brightest pixels in the frame. Above the join the cap makes `soft` a
    // finite number nobody reads.
    const soft = dcs.mul(SH_FLOOR).mul(exp(w.sub(SH_FLOOR).div(SH_FLOOR).min(0)));
    return mix(soft, lin, step(float(SH_FLOOR), w));
  }
  /**
   * THE OCT TAP, SPLIT INTO A PLAN AND A FETCH.
   *
   * ⭐ THE FOUR CORNER PROBES SHARE ONE REFLECTION DIRECTION. Everything
   * `octSample` computes before it touches the buffer — the octahedral
   * projection, the floor, the bilinear fractions, and the FOLD's four
   * compares — depends on `d` and the map resolution and on nothing else. Only
   * the base address changes from corner to corner. Stage 3.2's shape rebuilt
   * that whole preamble eight times per pixel (four corners × two mip levels)
   * and again in the fallback; it is built TWICE here, once per resolution, and
   * the per-corner cost drops to four loads and three lerps.
   */
  const octPlan = (d, res) => {
    const uvc = octahedralUV(d, res);
    const fu = uvc.u.sub(0.5).toVar();
    const fv = uvc.v.sub(0.5).toVar();
    const iu = fu.floor().toVar();
    const iv = fv.floor().toVar();
    const au = fu.sub(iu).toVar();
    const av = fv.sub(iv).toVar();
    // ⭐ THE OCTAHEDRAL MAP HAS NO BORDER, IT HAS A FOLD — and clamping there
    // is the horizontal tone step at camera height.
    //
    // The square's `u = ±1` edges are the directions with `d.y = 0, d.z ≤ 0`
    // (fold the parameterization by hand and the y term drops out). Off a
    // VERTICAL wall the reflection direction is `R = (−V.x, V.y, V.z)`, so
    // `R.y` changes sign exactly where the pixel is at the CAMERA'S OWN
    // HEIGHT, and `R.z < 0` for any wall in front of the camera — the whole
    // edge condition, met along one screen row. A clamped bilinear tap there
    // pulls its second sample from the wrong side of the fold, the glossy term
    // jumps, and `f0 · glossy` is ~12 % of the composited wall. Measured: a
    // 0.89× step at row 263, the horizon row, stable across four scans and
    // both hysteresis arms — the only structural feature in an otherwise
    // noise-dominated profile.
    //
    // The fold's rule: stepping off one axis mirrors the OTHER. It costs two
    // compares and a subtract, and it is the difference between a seam and a
    // sphere.
    const offs = [];
    for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const su = iu.add(ox).toVar();
      const sv = iv.add(oy).toVar();
      const outU = su.lessThan(0).or(su.greaterThan(res - 1)).toVar();
      const outV = sv.lessThan(0).or(sv.greaterThan(res - 1)).toVar();
      const cu = su.clamp(0, res - 1).toVar();
      const cv = sv.clamp(0, res - 1).toVar();
      const wu = select(outV, float(res - 1).sub(cu), cu).toVar();
      const wv = select(outU, float(res - 1).sub(cv), cv).toVar();
      offs.push(wv.toUint().mul(uint(res)).add(wu.toUint()).toVar());
    }
    return { offs, au, av };
  };
  /** Apply a plan to one probe, in the full map or in the mip. */
  const octFetch = (plan, probe, useMip) => {
    const t = plan.offs.map((o) => probeFiltered.element(
      useMip ? mipIdx(probe, o) : filtIdx(probe, o),
    ).xyz);
    return mix(mix(t[0], t[1], plan.au), mix(t[2], t[3], plan.au), plan.av);
  };

  // ⭐ §3.2 ITEM 1 — SH2 IS THE IRRADIANCE PATH ON EVERY TIER NOW.
  //
  // §L.5 offered the choice and said "measure both". Measured: the 4×64 oct
  // cosine sum WAS the resolve, and the resolve was half the whole chain
  // (1.46 ms of 2.89 at 960×540 ultra). The sum is 256 texel loads and 256
  // MACs per pixel to integrate a signal that `probeFilter` has ALREADY
  // projected onto 9 coefficients — and the texels it integrates are the
  // COSINE-CONVOLVED mean radiance over an 8×8 map, a signal whose energy
  // above l = 2 is small by construction. So the sum re-derives, per pixel,
  // something the probe pass computed once per probe.
  //
  // The oct map is NOT retired: the glossy lobe needs a DIRECTION, which SH2
  // cannot carry, so `octSample`'s bilinear tap (4 texels, not 64) stays. What
  // is retired is the diffuse sum. Both arms are still built — `passes.resolve`
  // ships the SH one, `passes.resolveOct` is the measurement arm the receipts
  // A/B against, byte-identical in everything but the integrator.
  /**
   * ⭐⭐⭐ §19 STAGE 4.14 (§AL) — THE WORLD PROBES' IRRADIANCE AT A POINT, AS A
   * FUNCTION. One implementation, TWO consumers: the pixel and the CACHE FACE.
   *
   * Every line below is `resolveHalf`'s world block, moved and not rewritten —
   * the cascade loop, the eight corners, trilinear × live × wrapped-cosine ×
   * face × Chebyshev, the 4.9 ramp, the coarsest-preferred tail. §AJ's finding
   * is that a cache face was lit by FOUR RAW CACHE FACES (a Neumann iteration
   * on a 4-ray estimate, compounding ~1/(1−ρ) — ×3 at the user's albedo 1.0
   * walls, and the 51.9 % the GPU reads against 17.6 % offline). Lumen's answer
   * is that the surface cache is lit by the RADIANCE CACHE, never by itself, so
   * the face's bounce term is this — a 64-direction, spatially filtered,
   * SH2-projected field, whose variance is a hundredth of a 4-ray draw's.
   *
   * ⚠ A COPY WOULD HAVE BEEN THE BUG. `shadeTerms`' own header says it: a second
   * transcription is a second place for the bias, the band, the ramp and the
   * tail to drift, and a cache lit by a DRIFTED resolve is a cache the screen
   * disagrees with everywhere. So the block is CALLED, and `makeResolve` calls
   * the same one.
   *
   * ⚠ AND IT IS LAZY, WHICH IS WHY IT CAN BE. `world` is a `const` ~1000 lines
   * BELOW `shadeTerms`, and `createWorldProbes` builds its trace kernel — the
   * kernel that inlines `shadeHit` — from inside its own initializer. That is a
   * temporal dead zone only if the kernel body runs EAGERLY, and measured, a
   * TSL `Fn(cb)()` does not run `cb` at all until the shader is BUILT: by then
   * `world` is assigned. (worldProbes.js's own note claims otherwise; it is
   * about a `const` read at module-evaluation time, not inside an `Fn`.)
   *
   * @param P   the world point (the resolve applies its own per-cascade bias)
   * @param Nn  the receiver normal
   * @param acc `{ Lb[9], G, wsum, admAny, planFull, dgs, dgFb }` — the caller's
   *   accumulators. `planFull` null skips the GLOSSY tap entirely, which is what
   *   a cache face wants: it has no view vector and no specular lobe.
   */
  function worldResolveInto(P, Nn, acc) {
    const { Lb, G, wsum, admAny, planFull } = acc;
    const dgs = acc.dgs ?? null;
    const dgFb = acc.dgFb ?? null;
    const DIAG = !!dgs;
    // == §19 STAGE 3.14 -- THE CASCADES, FINEST FIRST =====================
    //
    // Per cascade, the EIGHT lattice probes around the pixel, weighted
    // trilinear x wrapped cosine x face x visibility — DDGI's weight set
    // with §U's face term added, each of the four doing a different job:
    //
    //   TRILINEAR   the interpolation itself, and the reason camera motion
    //               is smooth: the probes do not move, only these weights.
    //   WRAPPED     `((n.d)/2 + 1/2)^2` on the direction to the probe. A
    //   COSINE      probe behind the shading plane contributes nothing,
    //               which removes the "the lit room's probe lights the dark
    //               side's wall" case without tracing anything.
    //   FACE        the probe's own assignment. A probe that had to be
    //               pushed out of geometry REPRESENTS one side of that
    //               geometry, and a pixel looking the other way must not
    //               read it.
    //   VISIBILITY  the probe's own hit-distance moments (`octTapVisAt`).
    //               The only one of the four that can refuse a probe whose
    //               normal agrees but whose LINE OF SIGHT is blocked -- a
    //               floor pixel beside a partition, which is the interior
    //               leak this stage is gated on.
    //
    // ⭐⭐ AND THEN THE CASCADES COMPOSITE, WHICH IS THE WHOLE OF 3.14.
    //
    // A cascade answers a pixel with a CONFIDENCE — `Σ tri·live·vis`, which
    // is 1 when all eight of its corners exist and can see the point and
    // falls smoothly to 0 as they stop existing — times its hand-off BAND
    // (`bandAt`: 1 inside the inner 90 %, ramping to 0 at the outer face).
    // The cascades are then alpha-composited finest first: cascade 0 spends
    // what confidence it has, cascade 1 spends what is left, cascade 2
    // (which CLAMPS to its own boundary, so it always answers) takes the
    // remainder. Nothing chooses a cascade; the weights choose, and they
    // are continuous in the pixel's position — which is why a camera
    // walking out of the 16 m cube produces no edge, and why "the finest
    // cascade whose corners are all admissible wins" is a description of
    // the arithmetic rather than a branch in it.
    //
    // ⚠ THE SAMPLE POINT IS BIASED ALONG THE NORMAL, PER CASCADE. Without
    // the bias a pixel's own surface occludes it from every probe above it
    // and the visibility term reads ~0 everywhere; the bias is a fraction
    // of the SAMPLED cascade's spacing, so it is 15 cm against 0.5 m probes
    // and 2.4 m against 8 m ones — the scene's own length at each scale.
    //
    // ⚠ ONE `Loop`, NOT `NC` COPIES. See `cascConst` in `worldProbes.js`:
    // three copies of this block is three copies of the largest expression
    // in `resolveHalf`, and its size is paid at boot in pipeline compile,
    // in front of the first-light number this stage is gated on.
    const NCASC = world.taps.cascades;
    /**
     * The last cascade this pixel may reach. `wpCascadesOn = 0` pins it to
     * cascade 0, which — because the last cascade is the one that CLAMPS —
     * is 3.13's single lattice with its boundary extrapolation, exactly.
     * The arm that says the cascades fixed the horizon, out of one binary.
     */
    const lastC = select(u.wpCascadesOn.greaterThan(0.5), uint(NCASC - 1), uint(0)).toVar();
    /** How much of this pixel's irradiance is still unclaimed. */
    const rem = float(1).toVar();
    /**
     * ⭐⭐⭐ §19 4.9 — THE TAIL: WHAT PAYS FOR WHAT NOBODY COULD SEE.
     *
     * Every cascade now spends only the share of its claim its VISIBLE,
     * face-admissible corners actually carried (see the composite), and the
     * rest stays in `rem` and falls down the chain. What survives the last
     * cascade has to land somewhere, and §L.5's rule is that it may not
     * land on black: a pixel in a pocket smaller than the lattice — a 3 cm
     * cable, a pot rim, the recess `probe:gi2-ref` found reading EXACTLY
     * zero against a truth of 0.111 — has no visible probe anywhere, and
     * zero is a claim of certainty the resolve does not have.
     *
     * So the tail is the CASCADES' OWN ANSWERS, `Σ_c Lc_c / pref_c` over
     * `Σ_c wsumC_c / pref_c` — the COARSEST preferred by exactly the ratio
     * 4.8's fallback used to prefer the FINEST. Coarsest, because the
     * tail's whole job is to be smoother than the thing that could not
     * answer: an 8 m lattice's blend cannot vary at the pixel scale
     * whatever its weights do, while a nearest-probe pick varies at
     * nothing else. A peaked fallback hands the pixel back the same
     * speckle under another name.
     *
     * ⚠ AND IT IS CHEBYSHEV-GATED, WHICH IS WHY IT DOES NOT LEAK. `Lc`
     * and `wsumC` are the visibility-weighted sums, so the tail reads the
     * same probes the cascade did and refuses the same ones. [[§V.1]] —
     * folding visibility OUT of a hand-off is what took the thin-wall
     * interior from 0.03 % to 0.56 %, and this hand-off does not.
     *
     * ⭐ THE `1e-4` FLOOR IS THE POCKET, AND IT IS THE ONLY TERM THAT MAY
     * READ AN OCCLUDED PROBE. Where NOTHING is visible at any cascade —
     * the 3 cm cable, the pot rim, the recess `probe:gi2-ref` caught
     * reading EXACTLY zero against a truth of 0.111 — every `wsumC` is
     * ~1e-6 and the ratio above is 0/0. `mW = Σ tri·live·(wf + 1e-4)`, the
     * region's own face-admissible mean (DC only; a mean has no direction
     * worth carrying), enters at a ten-thousandth so it is invisible
     * wherever anything at all can be seen and is the whole answer where
     * nothing can. Black is not an answer; it is the absence of one.
     */
    const tW = float(0).toVar();
    const tL = [];
    for (let i = 0; i < 9; i++) tL.push(vec3(0).toVar());
    const tG = planFull ? vec3(0).toVar() : null;
    Loop({ start: 0, end: NCASC, name: "wpCasc" }, ({ wpCasc }) => {
      const cc = uint(wpCasc).toVar();
      If(cc.greaterThan(lastC).or(rem.lessThan(1e-3)), () => { Break(); });
      const isLast = cc.greaterThanEqual(lastC).toVar();
      const K = world.taps.cascConst(cc);
      // ⭐⭐ THE BIAS IS THE FINEST CASCADE'S SPACING ON EVERY CASCADE, AND
      // THE FAR-FIELD RECEIPT IS WHAT SAYS SO.
      //
      // The first cut scaled it by the SAMPLED cascade's spacing, on the
      // reading that every length in this file should be a fraction of what
      // the lattice measures. But what this bias has to clear is the
      // PIXEL'S OWN SURFACE — a fact about the geometry, not about the
      // cascade sampling it — and at c1 that made it 60 cm, at c2 2.4 m. A
      // façade sampled 60 cm out into an open street sees far less of its
      // own occlusion, and the street-overview receipt measured the result:
      // far façades 1.67× the screen path's irradiance.
      //
      // ⭐⭐ §19 3.15 — AND NOW IT IS A UNIFORM, WHICH IS THE TELL. `K.biasLen`
      // is `wpBias · mix(s_0, s_c, wpBiasPerCasc)`, so both readings are one
      // boot apart instead of one build apart. Under the interval merge the
      // doors receipt reads CASCADE 0 (its pixels are inside c0's 16 m
      // extent), where `s_0` and `s_c` are the same 15 cm — so flipping this
      // must NOT move the thin-feature ratio. If it does, the resolve is
      // still reading a coarse cascade for a near recess and the merge is
      // not doing what this stage claims. See `wpBiasPerCasc`.
      const Pb = P.add(Nn.mul(K.biasLen)).toVar();
      const fr = world.taps.cellFrameAt(Pb, K.sp);
      // 1 in the inner 90 % of this cascade; the LAST cascade has nothing
      // coarser to hand to, so it takes the whole remainder.
      const band = select(isLast, float(1), world.taps.bandAt(fr.g, K.org)).toVar();

      const Lc = [];
      for (let i = 0; i < 9; i++) Lc.push(vec3(0).toVar());
      const Gc = planFull ? vec3(0).toVar() : null;
      const wsumC = float(0).toVar();
      /**
       * ⭐⭐ COVERAGE IS NOT WEIGHT, AND IT IS NOT VISIBILITY EITHER — the
       * 5 cm partition measured it.
       *
       * The first cut made a cascade's authority `Σ tri·live·vis`, on the
       * reading that a cascade which cannot SEE the point cannot answer for
       * it. That is exactly backwards: a probe that exists here and is
       * occluded from the pixel IS the answer — "no light arrives from
       * there" — and folding its refusal into the hand-off invited the 2 m
       * cascade, whose probes straddle a 5 cm wall, to answer instead. The
       * thin-wall interior receipt went 0.03 % → 0.56 % on that one term.
       *
       * So `cov` asks only "does a live lattice exist around this point",
       * which is the one question the hand-off is about; `faceCov` asks
       * "does any of it REPRESENT this surface", which is what the
       * two-tier fallback is about; and `vis` shapes the radiance and
       * nothing else.
       */
      const cov = float(0).toVar();
      const faceCov = float(0).toVar();
      /**
       * ⭐⭐ §19 4.9 — WHAT THE CASCADE *COULD* HAVE CARRIED, so that what it
       * DID carry is a fraction of something and not a bare magnitude.
       *
       * `Σ tri·live·wc0²`: the weight these eight corners would sum to if
       * every one of them were visible and admissible. `wsumC / wcosC` is
       * then "how much of this cascade can actually see the point", on a
       * fixed 0..1 scale — the input to the composite's ramp, and the only
       * form of the question that means the same thing at a lattice edge
       * (where `cov` is small) as in the middle of one.
       *
       * The wrapped cosine sits in BOTH sums because it SHAPES rather than
       * rejects: it is ~0.6 even for a perfect corner, so leaving it out of
       * the denominator would read every healthy pixel as half-blind.
       */
      const wcosC = float(0).toVar();
      /** This cascade's own regional mean — the tail's input. See `tW`. */
      const mW = float(0).toVar();
      const mL0 = vec3(0).toVar();
      const mG = planFull ? vec3(0).toVar() : null;
      // §19 3.18's classifier inputs, accumulated beside `cov` so they are
      // the SAME sums the composite is made of and not a re-derivation.
      const freshCov = DIAG ? float(0).toVar() : null;
      const visCov = DIAG ? float(0).toVar() : null;

      for (let c8 = 0; c8 < 8; c8++) {
        const cdx = c8 & 1;
        const cdy = (c8 >> 1) & 1;
        const cdz = (c8 >> 2) & 1;
        const rx = fr.base.x.add(cdx).toVar();
        const ry = fr.base.y.add(cdy).toVar();
        const rz = fr.base.z.add(cdz).toVar();
        // ⭐ THE CLAMP IS THE LAST CASCADE'S ALONE NOW. On a finer cascade
        // a corner outside the lattice is simply ABSENT — its weight is
        // zero and the pixel's confidence falls, which is what hands it to
        // the next cascade. 3.13 clamped on the only lattice it had and
        // extrapolated the near room's ambient onto far façades; that is
        // the 64.5 % thin-feature reading this stage exists to beat.
        const inLat = world.taps.inLatticeAt(K.org, rx, ry, rz);
        const [cwx, cwy, cwz] = world.taps.clampAt(K.org, rx, ry, rz);
        const wcx = select(isLast, cwx, rx).toVar();
        const wcy = select(isLast, cwy, ry).toVar();
        const wcz = select(isLast, cwz, rz).toVar();
        const inside = select(isLast, float(1), select(inLat, float(1), float(0))).toVar();
        const cell = world.taps.cellAtG(K.base, wcx, wcy, wcz).toVar();
        const i0 = world.taps.infoAt(cell, 0).toVar();
        // §19 3.15: `ready` is three-valued — 0 re-keyed, 0.5 SEEDED from
        // the cascade above, 1 traced. A seeded probe carries a real merged
        // field (its parent's) and its absence is what §V.6 measured as the
        // scroll's motion cost, so the test is `> 0.25`, not `> 0.5`.
        // `ready` is read ONCE into a var: §19 3.18's classifier needs the
        // three-valued number itself (0 re-keyed / 0.5 seeded / 1 traced),
        // not only the predicate the composite tests.
        const rdy = world.taps.infoAt(cell, 2).w.toVar();
        const alive = i0.w.greaterThan(0.5).and(rdy.greaterThan(0.25)).toVar();
        const tri = (cdx ? fr.frac.x : float(1).sub(fr.frac.x))
          .mul(cdy ? fr.frac.y : float(1).sub(fr.frac.y))
          .mul(cdz ? fr.frac.z : float(1).sub(fr.frac.z)).toVar();
        const toP = i0.xyz.sub(Pb).toVar();
        const dist = toP.length().max(1e-4).toVar();
        const dirP = toP.div(dist).toVar();
        const wc0 = dot(Nn, dirP).mul(0.5).add(0.5).toVar();
        const faceN = world.taps.infoAt(cell, 1).xyz.toVar();
        const wf = mix(float(1),
          select(i0.w.greaterThan(1.5), dot(Nn, faceN).max(0), float(1)),
          u.wpFaceOn.clamp(0, 1)).toVar();
        const live = select(alive, float(1), float(0)).mul(inside).toVar();
        const vis = world.taps.octTapVisAt(
          octPlan(dirP.negate(), O), cell, dist, K.dmax, K.sp,
        ).toVar();
        /** The shaping-only weight — the composite's denominator. */
        const wCos = tri.mul(live).mul(wc0.mul(wc0)).toVar();
        const w = wCos.mul(wf).mul(vis).toVar();
        // ⭐ COVERAGE IS NOT THE WEIGHT. `w` carries the wrapped cosine and
        // the face term, which SHAPE a probe's contribution and are ~0.6
        // even for a perfect corner; dividing the hand-off by that would
        // send every pixel to the coarse cascade. `cov` sums to exactly 1
        // when all eight corners are real, and to 0 past the lattice's
        // edge — which is the hand-off, and the whole hand-off.
        cov.addAssign(tri.mul(live));
        faceCov.addAssign(tri.mul(live).mul(wf));
        wcosC.addAssign(wCos);
        if (DIAG) {
          freshCov.addAssign(tri.mul(live)
            .mul(select(rdy.lessThan(0.75), float(1), float(0))));
          visCov.addAssign(tri.mul(live).mul(vis));
        }
        // The tail's input: face-admissible, NOT Chebyshev-gated, DC only.
        const mw = tri.mul(live).mul(wf.add(1e-4)).toVar();
        mW.addAssign(mw);
        // ⚠ `wsumC` IS SUMMED OUTSIDE THE BRANCH, and that is not tidiness.
        // It is `visFrac`'s numerator, and the whole point of 4.9 is that
        // the ramp sees the small values 4.8's `select(wsumC > 1e-5, …, 0)`
        // rounded to nothing.
        wsumC.addAssign(w);
        // ⭐⭐⭐ THE ARGMAX'S READ SITE IS GONE; THE BLEND'S GUARD STAYS —
        // AND THE DIFFERENCE BETWEEN THOSE TWO THRESHOLDS IS THE WHOLE
        // POINT OF THIS STAGE.
        //
        // `If(cand > bestW)` was a SWITCH: crossing it changed which probe
        // the pixel read, at full weight, with no continuity anywhere. `w >
        // 1e-5` is a CUT-OFF: below it a corner's contribution to the blend
        // is at most 1e-5 of it, so skipping the read moves the answer by
        // less than the format can hold. One is a cliff, the other is
        // arithmetic — and a first cut of 4.9 removed both, on the reading
        // that "no thresholds" is a principle rather than a measurement.
        // ⛔ `probe:gi2-runner` priced it: 16.4 → 19.3 ms per frame on
        // Bistro, `probe:gi2-motion` orbit MAX 29 → 160 ms. For a ground
        // pixel the four corners BELOW its plane have `wc0² ≈ 0`, and this
        // guard is what stops the resolve reading nine SH words and an oct
        // tap for each of them. [[feedback-gi-60fps-floor]]
        //
        // The `Else` keeps the pocket case alive at one read instead of
        // ten: where every corner is refused, the tail's regional mean is
        // the only answer there is, and it needs the DC word.
        If(w.greaterThan(1e-5), () => {
          const sh0 = world.taps.shAt(cell, 0).xyz.toVar();
          const radv = planFull ? world.taps.octTapRad(planFull, cell).toVar() : null;
          Lc[0].addAssign(sh0.mul(w));
          for (let i = 1; i < 9; i++) Lc[i].addAssign(world.taps.shAt(cell, i).xyz.mul(w));
          if (planFull) Gc.addAssign(radv.mul(w));
          mL0.addAssign(sh0.mul(mw));
          if (planFull) mG.addAssign(radv.mul(mw));
        }).Else(() => {
          mL0.addAssign(world.taps.shAt(cell, 0).xyz.mul(mw));
        });
      }
      // ── the composite ────────────────────────────────────────────────
      //
      // ⭐⭐⭐ §19 4.9 — A CASCADE THAT CANNOT SEE THE POINT HANDS ON, AND IT
      // HANDS ON SMOOTHLY.
      //
      // 4.8 spent the whole claim whichever way the weights fell, on the
      // reading that `wsumC = 0` with `cov = 1` is the dark side of a wall
      // and the right answer there is DARK. That reading survives — the
      // deficit never becomes brightness, and a cascade that hands on hands
      // to one whose OWN visibility test it must pass in turn, so nothing
      // is ever given a free pass around Chebyshev [[§V.1]]. What 4.8 got
      // wrong is the EDGE: `select(wsumC > 1e-5, …, 0)` is a switch, and a
      // pixel one ulp on the wrong side of it was multiplied by zero.
      //
      // ⚠ THE COVERAGE GATE IS LEFT EXACTLY AS 3.15 SHIPPED IT. A first cut
      // of 4.9 made it a `smoothstep` over the same edge for the smoother
      // derivative, and that is a REAL energy change at every lattice edge
      // (`cov = 0.25` claims 0.16 instead of 0.5) for a discontinuity that
      // was never there — `clamp` is already continuous, and no receipt
      // implicates its kink. Only the terms that actually SWITCH are
      // touched by this stage.
      const claim = cov.div(u.wpCovFull.max(1e-3)).clamp(0, 1).mul(band).mul(rem).toVar();
      /**
       * ⭐⭐⭐ THE RAMP THAT REPLACED THE SWITCH.
       *
       * `visFrac` is the share of this cascade's OWN admissible weight that
       * survived Chebyshev — 1 where every corner can see the point, 0 in a
       * pocket. 4.8 turned that into a step twice over: `select(wsumC >
       * 1e-5, claim/wsumC, 0)` multiplied the pixel by ZERO one ulp below
       * the gate (`probe:gi2-ref`'s eight exact zeros, with a live probe
       * 0.5 m away holding 0.111), and the `admAny < 1e-3` fallback then
       * swapped in one argmax corner's raw SH. Both are one `smoothstep`
       * now, over the same edge the coverage gate uses.
       *
       * ⭐⭐⭐ ⚠ AND IT SATURATES AT `VIS_RAMP`, WHICH IS 5 % AND NOT 50 %.
       * MEASURED, NOT CHOSEN.
       *
       * `VIS_RAMP` is the width of the region 4.8's `1e-5` switch lived in,
       * three orders of magnitude wider so that it RAMPS instead of
       * switching — and not one bit wider than that. Above it a cascade
       * spends its whole claim exactly as 4.8 did, so §V.1's rule survives
       * verbatim ("`wsumC` small with `cov` 1 is the dark side of a wall,
       * and DARK is the answer"), the `rem < 1e-3` break still fires on the
       * first cascade for almost every pixel rather than running all three,
       * and no pixel that was not AT the cliff moves at all.
       *
       * ⛔ THE PROPORTIONAL VERSION WAS WRITTEN FIRST AND `probe:gi2-ref`
       * REFUTED IT. Spending `visFrac` of the claim and deferring the rest
       * reads well — "a cascade spends what it could see" — but a typical
       * Bistro pixel measures `visFrac` ≈ 0.5, so it handed HALF of every
       * pixel down to the 2 m and 8 m lattices: pose A's median |ratio−1|
       * went 0.863 → 1.000 and pose B's 0.461 → 0.662 against the path
       * tracer, over-bright in exactly the shadowed places (FAC2 23×,
       * SOFF2 6.9×, PAVE1 3.9×) — which is §V.1's leak, re-derived from
       * first principles and measured within the hour. A hand-off may be
       * made CONTINUOUS; it may not be made PROPORTIONAL.
       */
      const VIS_RAMP = 0.05;
      const visFrac = wsumC.div(wcosC.max(1e-5)).toVar();
      const ansC = smoothstep(float(0), float(VIS_RAMP), visFrac).toVar();
      const spend = claim.mul(ansC).toVar();
      const k = spend.div(wsumC.max(1e-9)).toVar();
      for (let i = 0; i < 9; i++) Lb[i].addAssign(Lc[i].mul(k));
      if (planFull) G.addAssign(Gc.mul(k));
      wsum.addAssign(spend);
      rem.subAssign(spend);
      // The tail's accumulation, COARSEST-preferred — `1/pref` is exactly
      // the inverse of the finest-first ratio 4.8's fallback used, and it
      // is a weighted mean rather than a choice, so it is continuous in the
      // pixel's position like everything else here. See `tW`.
      const tw = float(1).div(K.pref).toVar();
      const tmw = tw.mul(1e-4).toVar();
      tW.addAssign(wsumC.mul(tw).add(mW.mul(tmw)));
      tL[0].addAssign(Lc[0].mul(tw).add(mL0.mul(tmw)));
      for (let i = 1; i < 9; i++) tL[i].addAssign(Lc[i].mul(tw));
      if (planFull) tG.addAssign(Gc.mul(tw).add(mG.mul(tmw)));
      if (DIAG) {
        const row = vec4(cov, freshCov, claim, visCov.div(cov.max(1e-4))).toVar();
        for (let c = 0; c < dgs.length; c++) {
          If(cc.equal(uint(c)), () => { dgs[c].assign(row); });
        }
      }
      admAny.assign(max(admAny, faceCov));
    });
    // ── ⭐⭐⭐ THE TAIL ───────────────────────────────────────────────────
    //
    // Whatever no cascade could see is paid here, at the region's own mean
    // (see `tW`). This is §L.5's "never a black pixel" and §19 3.14's
    // two-tier fallback, as ONE weighted mean instead of a threshold over
    // an argmax — so it is continuous in the pixel's position, and the
    // pixel next to it reads a value 8 cm away rather than a different
    // probe entirely.
    //
    // ⭐⭐ AND IT IS WHAT MAKES THE CLAIM CONSERVE. `wsum` is now exactly
    // `Σ spend + rem`, which is 1 for every pixel any cascade covered — the
    // `csum` column of `diagBuf`'s fallback row, and a lit pixel below 0.99
    // there is a bug rather than a taste. A pixel NO cascade covered has no
    // tail to pay it, keeps `wsum = 0`, and stays black on purpose.
    const hasT = select(tW.greaterThan(1e-12), float(1), float(0)).toVar();
    const tailK = rem.mul(hasT).div(tW.max(1e-12)).toVar();
    for (let i = 0; i < 9; i++) Lb[i].addAssign(tL[i].mul(tailK));
    if (planFull) G.addAssign(tG.mul(tailK));
    wsum.addAssign(rem.mul(hasT));
    if (DIAG) {
      dgFb.x.assign(admAny);
      dgFb.y.assign(rem.mul(hasT));
      dgFb.z.assign(wsum);
    }
  }

  const makeResolve = (useSh, half = false, rawSh = false, worldTap = false) => Fn(() => {
    const gxu = globalId.x.toVar();
    const gyu = globalId.y.toVar();
    If(half
      ? gxu.greaterThanEqual(u.halfWU).or(gyu.greaterThanEqual(u.halfHU))
      : gxu.greaterThanEqual(u.widthU).or(gyu.greaterThanEqual(u.heightU)), () => { Return(); });
    // The half-res thread OWNS the top-left pixel of its 2×2 quad and reads
    // the gbuffer THERE — not at a filtered centre. `resolveUpsample` maps
    // back with exactly the same rule, so the surface a low-res sample was
    // computed on is the surface the upsample tests against.
    const px = (half ? gxu.mul(uint(2)).min(u.widthU.sub(uint(1))) : gxu).toVar();
    const py = (half ? gyu.mul(uint(2)).min(u.heightU.sub(uint(1))) : gyu).toVar();
    const coord = ivec2(gxu.toInt(), gyu.toInt());
    const g = loadPos(px.toInt(), py.toInt()).toVar();
    const E = vec3(0).toVar();
    const G = vec3(0).toVar();
    // Hoisted so the half-res store below can key on them — see its note.
    const Pv = vec3(0).toVar();
    const Nv = vec3(0, 1, 0).toVar();
    // ── §19 3.18: the flip classifier's registers (see `diagBuf`) ───────────
    // Declared OUT here, beside `Pv`/`Nv` and for the same reason: the store
    // is in the `half` tail, outside the `g.w > 0.5` guard, so a pixel with no
    // geometry writes zeros rather than leaving the previous frame's answer
    // for the CPU to classify. [[probe-blind-statistics]]
    const DIAG = !!(half && worldTap && wantNoise && diagBuf && world);
    const dgs = DIAG
      ? Array.from({ length: world.taps.cascades }, () => vec4(0).toVar()) : null;
    /**
     * §19 4.9's fourth row — `(faceCov, tail, csum, luma)`. It is the ONE
     * register set that lives OUTSIDE the cascade loop, which is exactly why
     * §AE's table could not see the switches that live there either.
     */
    const dgFb = DIAG ? vec4(0).toVar() : null;
    If(g.w.greaterThan(0.5), () => {
      const P = g.xyz.toVar();
      const Nn = normalize(loadNrm(px.toInt(), py.toInt()).xyz).toVar();
      Pv.assign(P);
      Nv.assign(Nn);
      const V = normalize(P.sub(u.camPos)).toVar();
      const Rr = normalize(V.sub(Nn.mul(dot(V, Nn).mul(2)))).toVar();

      const tfx = px.toFloat().add(0.5).div(T).sub(0.5).toVar();
      const tfy = py.toFloat().add(0.5).div(T).sub(0.5).toVar();
      const bx = tfx.floor().toVar();
      const by = tfy.floor().toVar();
      const fx = tfx.sub(bx).toVar();
      const fy = tfy.sub(by).toVar();

      // The tap geometry is a function of `Rr` alone — built once, applied
      // four (or five) times. See `octPlan`.
      const planFull = octPlan(Rr, O);
      const planMip = octPlan(Rr, MIP_RES);
      const glossyAt = (pi) => mix(
        octFetch(planFull, pi, false),
        octFetch(planMip, pi, true),
        u.roughness,
      );

      const wsum = float(0).toVar();
      const best = float(-1).toVar();
      const bestW = float(worldTap ? 0 : -1).toVar();
      // The blended SH2, accumulated in COEFFICIENT space (see `shEval`).
      const Lb = [];
      for (let i = 0; i < 9; i++) Lb.push(vec3(0).toVar());
      // ⭐⭐ §19 4.9 RETIRED THE WORLD PATH'S ARGMAX. `If(cand > bestW)` chose
      // ONE corner's raw SH and the fallback then `assign`ed it over the whole
      // eight-corner blend — an argmax has no continuity anywhere, so two
      // neighbouring pixels of one flat surface could read two different
      // probes at full weight. Its job (a pixel no admissible probe represents
      // must not read black) is done by the TAIL below, which is a weighted
      // mean and therefore continuous. The screen path keeps §L.5's version.
      /**
       * The largest face-admissible coverage ANY cascade found — the world
       * path's fallback trigger.
       *
       * ⭐⭐ "NO PROBE REPRESENTS THIS SURFACE" AND "EVERY PROBE SAYS IT IS
       * DARK" ARE OPPOSITE FACTS AND `wsum` CANNOT TELL THEM APART. Under one
       * lattice they happened to coincide (both left `wsum` at zero) and 3.13's
       * `wsum < 1e-5` trigger was right by accident. Under cascades a covered
       * pixel always spends its claim, so `wsum` is 1 in both cases — and using
       * it would either black out the thin features (a 3 cm cable in a pocket
       * of face-rejecting probes) or leak light onto the dark side of a wall,
       * depending on which way it was written.
       */
      const admAny = worldTap ? float(0).toVar() : null;
      if (worldTap) {
        worldResolveInto(P, Nn, { Lb, G, wsum, admAny, planFull, dgs, dgFb });
      } else {
      for (let corner = 0; corner < 4; corner++) {
        const dx = corner & 1;
        const dy = (corner >> 1) & 1;
        const ix = bx.add(dx).clamp(0, u.probeWF.sub(1)).toUint().toVar();
        const iy = by.add(dy).clamp(0, u.probeHF.sub(1)).toUint().toVar();
        const pi = iy.mul(u.probeWU).add(ix).toVar();
        const pa = probeMeta.element(metaIdx(u.curBase, pi, 0)).toVar();
        const pb = probeMeta.element(metaIdx(u.curBase, pi, 1)).toVar();
        const bl = (dx ? fx : float(1).sub(fx)).mul(dy ? fy : float(1).sub(fy)).toVar();
        const wp = exp(dot(Nn, pa.xyz.sub(P)).abs().div(2 * v0).negate()).toVar();
        const wn = dot(Nn, pb.xyz).max(0).toVar();
        const w = bl.mul(wp).mul(wn.mul(wn)).mul(pa.w).toVar();
        If(pa.w.greaterThan(0.5).and(w.greaterThan(bestW)), () => {
          bestW.assign(w);
          best.assign(pi.toFloat());
        });
        If(w.greaterThan(1e-5), () => {
          if (useSh) {
            const at = rawSh ? shRawIdx : shIdx;
            for (let i = 0; i < 9; i++) Lb[i].addAssign(probeSh.element(at(pi, i)).xyz.mul(w));
          } else {
            E.addAssign(irradianceFromOct(pi, Nn).mul(w));
          }
          G.addAssign(glossyAt(pi).mul(w));
          wsum.addAssign(w);
        });
      }
      }
      // §L.5's fallback: the nearest VALID probe, unweighted, rather than a
      // black pixel. A pixel whose four corners all fail the plane test sits
      // on a silhouette, and black there reads as a hard outline. It is folded
      // into the SAME accumulator with weight 1 rather than duplicating the
      // evaluation — one `shEval` per pixel, on every path.
      //
      // ⛔ §19 4.9 REMOVED THE WORLD PATH'S COPY OF IT. `wsum < 1e-5 OR admAny
      // < 1e-3` was a HARD THRESHOLD that `assign`ed one argmax corner's raw SH
      // over the whole eight-corner blend — one of the two per-pixel switches
      // §AE could not see, and the one `probe:gi2-ref` caught choosing a
      // different probe for two neighbouring pixels of one surface. The tail
      // above does its job continuously, so there is nothing left to trigger.
      // The screen path, which has no cascades and no tail, keeps it.
      if (!worldTap) {
        const fbTrig = wsum.lessThan(1e-5).and(best.greaterThanEqual(0));
        If(fbTrig, () => {
          const pi = best.toUint().toVar();
          if (useSh) {
            const at = rawSh ? shRawIdx : shIdx;
            for (let i = 0; i < 9; i++) Lb[i].assign(probeSh.element(at(pi, i)).xyz);
          } else {
            E.assign(irradianceFromOct(pi, Nn));
          }
          G.assign(glossyAt(pi));
          wsum.assign(1);
        });
      }
      If(wsum.greaterThan(1e-5), () => {
        if (useSh || worldTap) {
          const inv = float(1).div(wsum).toVar();
          for (let i = 0; i < 9; i++) Lb[i].mulAssign(inv);
          E.assign(shEval(Lb, Nn));
        } else {
          E.assign(E.div(wsum));
        }
        G.assign(G.div(wsum));
      });
    });
    if (half) {
      // ⭐⭐ THE UPSAMPLE'S EDGE TEST RIDES IN THE ALPHA IT WAS THROWING AWAY.
      // A 2×2 upsample has to know whether each low-res sample belongs to
      // this pixel's surface, and the obvious way to find out — re-read the
      // gbuffer at each tap's own pixel — is EIGHT full-res texture loads
      // per pixel. Measured, a full-res load costs ~0.036 ms per pixel-pass
      // at 1650×970, so those eight WERE the upsample: 0.655 ms of which
      // 0.29 was re-reading a surface description the low-res kernel had in
      // registers when it wrote the sample.
      //
      // So it writes it down. The alpha of the two half-res targets is dead
      // weight (`g.w`, a validity bit the upsample re-derives anyway), and
      // it holds instead the two numbers the edge test needs: the sample's
      // PLANE OFFSET `n·p` and the sign-carrying `n.y`. A sentinel below
      // anything a real surface can produce marks a sample with no geometry.
      textureStore(irradianceHalf, coord,
        vec4(E, select(g.w.greaterThan(0.5), dot(Nv, Pv), float(-1e4))));
      textureStore(glossyHalf, coord,
        vec4(G, select(g.w.greaterThan(0.5), Nv.y, float(-9))));
      if (DIAG) {
        // ⚠ THE RESOLVE'S OWN LUMINANCE RIDES IN THE LAST ROW'S `.w`, and it is
        // the ONE number that makes the image accumulation falsifiable:
        // `reprojBuf` reads `irradiance`, which is `resolveUpsample`'s output
        // AFTER the 3.12 blend, so a sign census on it alone cannot separate
        // "the field moved" from "the blend switched validity". Same census,
        // two signals, one subtraction.
        //
        // §19 4.9: the last ROW is the FALLBACK row now, not the last cascade —
        // so the cascade rows keep their own `vis` column (§AE.1's third
        // blindness) and the reader's rule is unchanged. Rows between the last
        // cascade and the fallback row exist on tiers with fewer cascades and
        // are written as zeros rather than left stale.
        const base = gyu.mul(u.halfWU).add(gxu).mul(uint(DIAG_VEC)).toVar();
        const LUMA_D = vec3(0.2126, 0.7152, 0.0722);
        for (let c = 0; c < DIAG_VEC - 1; c++) {
          diagBuf.element(base.add(uint(c)))
            .assign(c < dgs.length ? dgs[c] : vec4(0));
        }
        diagBuf.element(base.add(uint(DIAG_VEC - 1)))
          .assign(vec4(dgFb.xyz, dot(E, LUMA_D)));
      }
    } else {
      textureStore(irradiance, coord, vec4(E, g.w));
      textureStore(glossy, coord, vec4(G, g.w));
    }
  })().compute(dispatch2d(half ? halfW : width, half ? halfH : height), WG);
  const resolvePass = useWorld ? null : makeResolve(USE_SH);
  const resolveOctPass = useWorld ? null : makeResolve(false);
  // ⭐ THE A/B'S OTHER HALF. §3.2's gate was "SH2 against the 4×64 oct cosine
  // sum", and it meant the SH TRUNCATION ERROR and nothing else — same
  // probes, same map, two integrators. §3.3 moved §L.4's 3×3 bilateral onto
  // the coefficients, so the SHIPPED resolve reads a POOLED SH while the oct
  // sum still reads the probe's own map, and comparing those two folds the
  // filter into a number that is supposed to be about band limits. Measured:
  // the sphere went 5.6 % → 16.1 % at 960×540 while the sphere's own
  // irradiance moved 0.557 → 0.572, which is the arm moving, not the answer.
  // So the A/B gets an arm that reads the UNPOOLED coefficients: same data as
  // the oct sum, and the ratio is the truncation again.
  const resolveShRawPass = useWorld ? null : makeResolve(true, false, true);
  // ⚠ THE IDENTITY IS THE SAME EITHER WAY. `gi2System` splices its emitter term
  // immediately before `passes.resolveHalf` and GTAO immediately after
  // `passes.resolveUpsample`; both splice points have to survive the flip or a
  // consumer's chain silently loses a stage (§19 3.4's lesson, from the other
  // side). So the half-res resolve keeps its NAME and changes its BODY.
  const resolveHalfPass = makeResolve(USE_SH, true, false, useWorld);

  // ══════════════════════════════ SHADER: resolveUpsample
  //
  // ⭐ THE RESOLVE IS THE ONLY KERNEL IN THE CHAIN THAT RUNS PER PIXEL AND
  // DOES REAL WORK PER PIXEL, and what it computes is a signal that changes
  // on the scale of a PROBE TILE (8 px) — four corner probes, bilinear ×
  // plane × normal, one SH2 evaluation, one glossy lobe. Evaluating it four
  // times inside every 2×2 quad is four evaluations of very nearly the same
  // number. So `resolveHalf` evaluates one of the four and this pass puts
  // the answer back on the full grid.
  //
  // ⚠ AND IT IS NOT A BILINEAR MAGNIFY. A low-res sample that belongs to the
  // floor must not bleed onto the pillar in front of it — that is a halo
  // along every silhouette, on exactly the edges a GI term is judged by. The
  // four taps are weighted by the bilinear fractions MODULATED by whether
  // each tap's gbuffer pixel is the same surface as this one (plane distance
  // in cells, and normal agreement) — the same rule `giScreen`'s GTAO
  // upsample uses, and the bilinear term is not optional there either: edge
  // weights alone are a box filter, and a smooth gradient comes out as 2×2
  // plateaus. When every tap is rejected the pixel takes the nearest one
  // rather than black, for the same reason §L.5's own fallback exists.
  const resolveUpsamplePass = Fn(() => {
    const px = globalId.x.toVar();
    const py = globalId.y.toVar();
    If(px.greaterThanEqual(u.widthU).or(py.greaterThanEqual(u.heightU)), () => { Return(); });
    const coord = ivec2(px.toInt(), py.toInt());
    const g = loadPos(px.toInt(), py.toInt()).toVar();
    const E = vec3(0).toVar();
    const G = vec3(0).toVar();
    If(g.w.greaterThan(0.5), () => {
      const P = g.xyz.toVar();
      const Nn = normalize(loadNrm(px.toInt(), py.toInt()).xyz).toVar();
      const myPlane = dot(Nn, P).toVar();
      const lowX = px.toFloat().add(0.5).mul(0.5).sub(0.5).toVar();
      const lowY = py.toFloat().add(0.5).mul(0.5).sub(0.5).toVar();
      const bx = lowX.floor().toVar();
      const by = lowY.floor().toVar();
      const fx = lowX.sub(bx).toVar();
      const fy = lowY.sub(by).toVar();
      const wsum = float(0).toVar();
      const bestW = float(-1).toVar();
      const bestE = vec3(0).toVar();
      const bestG = vec3(0).toVar();
      // ⭐ THE ACCUMULATOR'S CLAMP BOX IS THE FOUR TAPS THIS LOOP ALREADY READS.
      //
      // §19 3.12 asked for "±50 % of the 3×3 neighbourhood". A 3×3 of the
      // low-res image is EIGHTEEN more texture loads per full-res pixel — at
      // 1650×970 that is the whole 0.4 ms budget spent on a bound, not on the
      // answer. The 2×2 the bilinear already fetched covers the same 4×4 block
      // of full-res pixels this thread interpolates from, costs nothing, and is
      // the box the current frame's value provably lies inside. See
      // `accumClamp` for why generous is the point.
      const loE = vec3(1e8).toVar();
      const hiE = vec3(-1e8).toVar();
      const loG = vec3(1e8).toVar();
      const hiG = vec3(-1e8).toVar();
      for (let d = 0; d < 4; d++) {
        const dx = d & 1;
        const dy = (d >> 1) & 1;
        const bl = (dx ? fx : float(1).sub(fx)).mul(dy ? fy : float(1).sub(fy)).toVar();
        const lx = bx.add(dx).clamp(0, float(halfW - 1)).toInt().toVar();
        const ly = by.add(dy).clamp(0, float(halfH - 1)).toInt().toVar();
        const ei = irrHalfNode.load(ivec2(lx, ly)).toVar();
        const gi = glossyHalfNode.load(ivec2(lx, ly)).toVar();
        // Plane distance in units of a level-0 CELL — the scene's own
        // length, never a metric constant — and the normal's own sign, so
        // a ceiling can never pass for the floor 6 m below it that shares
        // its plane offset. Both come out of the sample's alpha.
        const okTap = gi.w.greaterThan(-8).toVar();
        const wp = exp(ei.w.sub(myPlane).abs().div(v0).negate()).toVar();
        const wn = float(1).sub(gi.w.sub(Nn.y).abs().mul(0.5)).max(0).toVar();
        const w = bl.mul(wp).mul(wn.mul(wn)).mul(select(okTap, float(1), float(0))).toVar();
        If(okTap.and(bl.greaterThan(bestW)), () => {
          bestW.assign(bl);
          bestE.assign(ei.xyz);
          bestG.assign(gi.xyz);
        });
        If(okTap, () => {
          loE.assign(min(loE, ei.xyz));
          hiE.assign(max(hiE, ei.xyz));
          loG.assign(min(loG, gi.xyz));
          hiG.assign(max(hiG, gi.xyz));
        });
        E.addAssign(ei.xyz.mul(w));
        G.addAssign(gi.xyz.mul(w));
        wsum.addAssign(w);
      }
      If(wsum.greaterThan(1e-4), () => {
        E.assign(E.div(wsum));
        G.assign(G.div(wsum));
      }).Else(() => {
        E.assign(bestE);
        G.assign(bestG);
      });

      // ══ §19 STAGE 3.12 — LIGHT ARRIVES OVER FOUR FRAMES ══════════════════
      //
      // ⭐⭐ THIS IS NOT A DENOISER AND THE DISTINCTION IS THE WHOLE STAGE. A
      // denoiser is a filter that removes VARIANCE from a stochastic estimate;
      // there is no variance here, because there is no stochastic input left
      // anywhere on this path (fixed texel centres, a fixed shade quadrature,
      // NEE for the compact sources — §T). What this blend removes is the RATE
      // at which a deterministic estimator's SPATIAL quantization is read out
      // along an anchor that walks with the camera, which is the residue 3.11a
      // named and could not remove at the probe.
      //
      // ⚠ THE VALIDATION IS THE PASS. A reprojected blend with a weak
      // disocclusion test is a smear along every silhouette, and a smear is a
      // worse artefact than the grain it replaces. Three independent gates,
      // each of which alone would let something through:
      //
      //   · GEOMETRY. Each of the four history taps carries the DEPTH its own
      //     frame's camera saw and its own frame's NORMAL (see the note at
      //     `irradianceHist`). A tap counts only if its depth matches this
      //     surface point's depth IN THAT CAMERA and its normal agrees within
      //     `dot > 0.9`. Re-reading the gbuffer instead would compare this
      //     frame's geometry at the old pixel, which is not the question.
      //   · THE TOLERANCE IS THE PIXEL'S OWN WORLD SIZE, never a metric
      //     constant: `depth / projScale` is what one pixel spans HERE, and
      //     `slant` is how much further that reaches along a surface turned
      //     away from the camera. The `+2 px` floor is the half-float's own
      //     quantum at this depth (relative 4.9e-4 against a half-pixel
      //     tolerance of ~4.8e-4 at `projScale ≈ 1040`) — without it the
      //     STORAGE FORMAT would be deciding a geometric test.
      //   · THE NEIGHBOURHOOD BOX. Even a tap that passes both can hold a
      //     value from a surface that merely agrees about depth and normal
      //     (a repeated tread, a parallel wall). `accumClamp` bounds it to the
      //     2×2 low-res box this pixel interpolates from, widened by ±50 %.
      //
      // A pixel with no surviving tap takes the CURRENT frame whole. That is
      // the correct answer for a disocclusion and it is what makes the
      // at-rest receipt exact: with the camera parked every tap survives, the
      // history equals the current value, and the blend is the identity.
      // ⚠ THE BOX ALWAYS CONTAINS THIS PIXEL'S OWN ANSWER. A pixel WITH
      // geometry can still have all four low-res taps rejected (a sliver of
      // surface inside a 2×2 that is otherwise sky), and the accumulators would
      // then still hold their ±1e8 sentinels — a clamp whose lower bound is
      // above its upper bound, which is not a bound at all. Folding the
      // finalized value in makes the box non-empty by construction and costs
      // two register ops.
      loE.assign(min(loE, E));
      hiE.assign(max(hiE, E));
      loG.assign(min(loG, G));
      hiG.assign(max(hiG, G));
      If(u.accumOn.greaterThan(0.5), () => {
        const c = u.prevViewProj.mul(vec4(P, 1)).toVar();
        If(c.w.greaterThan(1e-4), () => {
          const sx = c.x.div(c.w).mul(0.5).add(0.5).toVar();
          const sy = float(1).sub(c.y.div(c.w).mul(0.5).add(0.5)).toVar();
          If(sx.greaterThanEqual(0).and(sx.lessThan(1))
            .and(sy.greaterThanEqual(0)).and(sy.lessThan(1)), () => {
            const V = normalize(P.sub(u.camPos)).toVar();
            const pw = c.w.div(u.projScale.max(1e-3)).toVar();
            const slant = float(1).div(dot(Nn, V).abs().max(0.1)).toVar();
            const tol = pw.mul(slant).mul(0.5).max(pw.mul(2)).toVar();
            const fx = sx.mul(u.widthF).sub(0.5).toVar();
            const fy = sy.mul(u.heightF).sub(0.5).toVar();
            const x0 = fx.floor().toVar();
            const y0 = fy.floor().toVar();
            const ax = fx.sub(x0).toVar();
            const ay = fy.sub(y0).toVar();
            const hE = vec3(0).toVar();
            const hG = vec3(0).toVar();
            const hW = float(0).toVar();
            for (let t = 0; t < 4; t++) {
              const dx = t & 1;
              const dy = (t >> 1) & 1;
              const bl = (dx ? ax : float(1).sub(ax)).mul(dy ? ay : float(1).sub(ay)).toVar();
              const hx = x0.add(dx).clamp(0, float(width - 1)).toInt().toVar();
              const hy = y0.add(dy).clamp(0, float(height - 1)).toInt().toVar();
              const hi = irrHistNode.load(ivec2(hx, hy)).toVar();
              const hg = glossyHistNode.load(ivec2(hx, hy)).toVar();
              const okDepth = hi.w.greaterThan(0).and(hi.w.sub(c.w).abs().lessThan(tol)).toVar();
              const okNrm = dot(unpackNormal5(hg.w.max(0)), Nn).greaterThan(0.9).toVar();
              const w = bl.mul(select(okDepth.and(okNrm).and(hg.w.greaterThanEqual(0)),
                float(1), float(0))).toVar();
              hE.addAssign(hi.xyz.mul(w));
              hG.addAssign(hg.xyz.mul(w));
              hW.addAssign(w);
            }
            // ⚠ 0.999, NOT `> 0`. A partial set of surviving taps is a pixel
            // ON a disocclusion boundary — half its history belongs to the
            // thing that just moved away — and renormalizing a half-weight
            // tap is how a silhouette acquires a one-frame trail. Either the
            // whole bilinear footprint is the same surface or this pixel takes
            // the current frame.
            If(hW.greaterThan(0.999), () => {
              const spanE = hiE.sub(loE).mul(u.accumClamp).toVar();
              const spanG = hiG.sub(loG).mul(u.accumClamp).toVar();
              const cE = hE.clamp(loE.sub(spanE), hiE.add(spanE)).toVar();
              const cG = hG.clamp(loG.sub(spanG), hiG.add(spanG)).toVar();
              const al = u.accumAlpha.clamp(0, 1).toVar();
              E.assign(mix(cE, E, al));
              G.assign(mix(cG, G, al));
            });
          });
        });
      });
    });
    textureStore(irradiance, coord, vec4(E, g.w));
    textureStore(glossy, coord, vec4(G, g.w));
  })().compute(dispatch2d(width, height), WG);

  // ══════════════════════════════ SHADER: imageHistory (§19 Stage 3.12)
  //
  // The accumulator's other half: copy the frame the scene is about to be lit
  // by into the two history textures, with the geometry key that lets the NEXT
  // frame decide whether each texel is still the same surface.
  //
  // ⭐ IT RUNS LAST, AFTER `composite` AND `injectLitFrame`, AND THAT IS FREE.
  // Nothing between `resolveUpsample` and here writes `irradiance` — GTAO's
  // compose (on the engine path) reads it and writes its own output texture,
  // for the documented reason that the cache must remember UNOCCLUDED
  // radiance — so the history is the accumulated, un-occluded irradiance,
  // which is precisely what the next frame's blend is defined against.
  //
  // ⚠ THE DEPTH IS `viewProj.w`, NOT A DISTANCE. Next frame this same matrix is
  // `prevViewProj`, so the two numbers are the same projection of the same
  // point and can be compared without a reconstruction step in between.
  const imageHistoryPass = Fn(() => {
    const px = globalId.x.toVar();
    const py = globalId.y.toVar();
    If(px.greaterThanEqual(u.widthU).or(py.greaterThanEqual(u.heightU)), () => { Return(); });
    const coord = ivec2(px.toInt(), py.toInt());
    const g = loadPos(px.toInt(), py.toInt()).toVar();
    // −1 in BOTH keys is the sky/no-geometry sentinel, and it has to be written
    // rather than skipped: a texel left untouched holds whatever the last
    // frame's geometry put there, which is the same class of bug as a probe
    // returning early from a back-facing texel (see `probeTracePass`).
    const depth = select(g.w.greaterThan(0.5),
      u.viewProj.mul(vec4(g.xyz, 1)).w, float(-1)).toVar();
    const key = select(g.w.greaterThan(0.5),
      packNormal5(normalize(loadNrm(px.toInt(), py.toInt()).xyz)), float(-1)).toVar();
    textureStore(irradianceHist, coord, vec4(irrNode.load(coord).xyz, depth));
    textureStore(glossyHist, coord, vec4(glossyNode.load(coord).xyz, key));
  })().compute(dispatch2d(width, height), WG);

  // ══════════════════════════════════════════════ SHADER: composite
  //
  // Harness-side in spirit, but it lives here because `injectLitFrame` and the
  // screen segment both consume its output and must agree with it exactly.
  const compositePass = Fn(() => {
    const px = globalId.x.toVar();
    const py = globalId.y.toVar();
    If(px.greaterThanEqual(u.widthU).or(py.greaterThanEqual(u.heightU)), () => { Return(); });
    const coord = ivec2(px.toInt(), py.toInt());
    const g = loadPos(px.toInt(), py.toInt()).toVar();
    const out = vec3(0).toVar();
    If(g.w.greaterThan(0.5), () => {
      const Nn = normalize(loadNrm(px.toInt(), py.toInt()).xyz).toVar();
      // §19 Stage 4.0b: the same class byte indexes both tables, and the
      // emissive term is the class's RGB — `injectLitFrame` writes this colour
      // straight back into the cache, so a grey lamp here would launder a red
      // lamp's chroma out of the world's memory of light as well as out of the
      // frame.
      const pi = palIndexAtWorld(g.xyz, Nn).toVar();
      const pal = palU.element(pi).toVar();
      // §19 3.12: the emissive term goes through `emOf` too. It has to — a
      // seated emitter that still glowed HERE would be written straight back
      // into its own cache face by `injectLitFrame` (which takes exactly this
      // pixel minus the lobe), and the emission NEE owns would be back in the
      // ray path one frame later, through the one door the palette does not
      // guard.
      out.assign(pal.xyz.mul(1 / Math.PI).mul(irrNode.load(coord).xyz)
        .add(glossyNode.load(coord).xyz.mul(u.f0)).add(emOf(palEmU.element(pi).xyz)));
    }).Else(() => {
      out.assign(u.skyColor);
    });
    textureStore(lit, coord, vec4(out, g.w));
    litBuf.element(py.mul(u.widthU).add(px)).assign(vec4(out, g.w));
  })().compute(dispatch2d(width, height), WG);

  // ══════════════════════════════════════════════ SHADER: injectLitFrame (§L.6)
  const injectPass = Fn(() => {
    const gx = globalId.x.toVar();
    const gy = globalId.y.toVar();
    const px = gx.mul(uint(4)).add(bitAnd(u.frame, uint(3))).toVar();
    const py = gy.mul(uint(4)).add(bitAnd(shiftRight(u.frame, uint(2)), uint(3))).toVar();
    If(px.greaterThanEqual(u.widthU).or(py.greaterThanEqual(u.heightU)), () => { Return(); });
    const g = loadPos(px.toInt(), py.toInt()).toVar();
    If(g.w.greaterThan(0.5), () => {
      const Nn = normalize(loadNrm(px.toInt(), py.toInt()).xyz).toVar();
      // INTO the surface by the same epsilon `palAtWorld` uses, and for the
      // same reason — see the note there. A pixel sits ON a cell boundary and
      // would otherwise address the empty voxel in front of it half the time;
      // half a CELL overshoots any surface that sits inside one.
      const pIn = g.xyz.sub(Nn.mul(v0 * SURFACE_EPS)).toVar();
      const ax = Nn.x.abs();
      const ay = Nn.y.abs();
      const az = Nn.z.abs();
      const face = select(ax.greaterThanEqual(ay).and(ax.greaterThanEqual(az)),
        select(Nn.x.lessThan(0), float(1), float(0)),
        select(ay.greaterThanEqual(az),
          select(Nn.y.lessThan(0), float(3), float(2)),
          select(Nn.z.lessThan(0), float(5), float(4)))).toVar();
      // ⭐ WHAT GOES INTO THE CACHE IS THE **DIFFUSE** LIT COLOUR (§19 3.6).
      //
      // §L.6 says "write the lit pixel", and Stage 3.5 wrote the composite —
      // which is `albedo/π · E + f0 · glossy + emissive`. The glossy term is
      // a FOUR-TEXEL BILINEAR TAP of the probe's own oct map: the one signal
      // in the chain that no filter has touched, view-dependent by
      // construction, and the noisiest thing the frame produces. Feeding it
      // into a cache whose whole contract is "the radiance leaving this face,
      // seen from anywhere" is both wrong (a face does not leave a specular
      // lobe in every direction) and a noise pump — the cache's EMA then
      // hands that noise back to `probeTrace`, which is a closed loop.
      //
      // So the injection takes the FILTERED irradiance and the emission and
      // leaves the lobe out. `injectGlossy` restores the old sum as the A/B's
      // other arm; the receipt is the cache's own temporal σ at a fixed face.
      //
      // ⚠ BY SUBTRACTION, NOT BY RE-DERIVATION. The first cut rebuilt the
      // diffuse term from `palAtWorld × irradiance`, which walks the window's
      // level chain a second time — measured at 1650×970 it took the whole
      // kernel from 0.187 ms to 0.555. `composite` writes exactly
      // `albedo/π·E + f0·glossy + emissive`, so the term to remove is one
      // texture load and a multiply, and the two forms are the same number by
      // construction rather than by two expressions agreeing.
      const coord = ivec2(px.toInt(), py.toInt());
      const litc = litNode.load(coord).xyz.toVar();
      const diffuse = litc.sub(glossyNode.load(coord).xyz.mul(u.f0)).max(vec3(0)).toVar();
      const c = mix(diffuse, litc, u.injectGlossy).toVar();
      // EVERY level that contains this point, not just level 0. A ray reads
      // the cache at whatever level IT hit on, and the trace hands off to
      // coarser levels the moment it leaves the finest window — so a face fed
      // only at level 0 leaves every hand-off ray reading a slot the screen
      // never updates. Unrolled over a tier constant; the whole kernel is
      // 0.06 ms, so paying it `levels` times is cheaper than the bounce it
      // buys back.
      for (let l = 0; l < win.levels; l++) {
        const rel = pIn.div(v0 * Math.pow(2, l)).floor().sub(win.originAt(int(l))).toVar();
        If(rel.x.greaterThanEqual(0).and(rel.y.greaterThanEqual(0)).and(rel.z.greaterThanEqual(0))
          .and(rel.x.lessThan(N)).and(rel.y.lessThan(N)).and(rel.z.lessThan(N)), () => {
          const wc = pIn.div(v0 * Math.pow(2, l)).floor().toVar();
          const vi = bitOr(
            bitOr(bitAnd(wc.x.toInt(), int(63)).toUint(),
              shiftLeft(bitAnd(wc.y.toInt(), int(63)).toUint(), uint(6))),
            shiftLeft(bitAnd(wc.z.toInt(), int(63)).toUint(), uint(12)),
          ).toVar();
          // ⭐⭐ §19 STAGE 3.9 — THE SCREEN AND THE RAYS MUST NAME THE SAME WORD.
          //
          // `radianceCache`'s own header says it: "if those two ever disagree,
          // the screen would write light into a face no ray reads". Before 3.9
          // they agreed by luck — the gbuffer normal's nearest axis and the
          // ray's entry face are the same thing only on an axis-aligned wall
          // hit head on. So the injection files under the VOXEL's dominant
          // face too, with the gbuffer normal as the side hint (a visible
          // surface faces the camera, so its outward neighbour is open and the
          // hint is rarely what decides).
          //
          // The mismatch counters are the receipt for the assertion §Q.3 asks
          // for: `axisKnown` counts pixels whose voxel names an axis at all,
          // `axisMismatch` those where that axis is NOT the gbuffer normal's
          // nearest — the honest disagreement rate between the two ways of
          // asking, which on a flat wall should be a rounding error and on a
          // corner voxel is real.
          const domF = dominantFace(float(l), vi.toFloat(), face, Nn).toVar();
          cache.cacheWrite(float(l), vi.toFloat(), domF, c, u.injectAlpha).toVar();
          if (l === 0) {
            bump(STATS.injectWrites, px);
            const code = bitAnd(shiftRight(faceByteAt(float(l), vi.toFloat()), uint(FACE_AX_SHIFT)), uint(3)).toVar();
            If(code.notEqual(uint(0)), () => {
              bump(STATS.axisKnown, px);
              If(code.sub(uint(1)).notEqual(face.div(2).floor().toUint()), () => {
                bump(STATS.axisMismatch, px);
              });
            });
          }
        });
      }
    });
  })().compute(dispatch2d(Math.ceil(width / 4), Math.ceil(height / 4)), WG);

  // ══════════════════════════════════════════════ SHADER: crop sampler
  //
  // The receipts read NUMBERS, not images: each crop is a block whose gbuffer
  // position/normal, irradiance, glossy, lit colour and palette albedo are
  // averaged and written to a readable buffer. The CPU reference then path-
  // traces the SAME world point with the SAME normal, so the comparison is
  // irradiance against irradiance and not two differently-scaled composites.
  const cropPass = crops <= 0 ? null : Fn(() => {
    const i = instanceIndex.toVar();
    const q = cropIn.element(i).toVar();
    const cx = q.x.toInt().toVar();
    const cy = q.y.toInt().toVar();
    // ⭐ THE CENTRE PIXEL DEFINES THE SURFACE. A block that straddles a
    // silhouette averages two planes into a world point that lies INSIDE the
    // solid — measured on the box's top edge, where the mean position came
    // back at y = −1.02 for a face at y = −1.00 and the CPU reference then
    // path-traced from inside the box and returned exactly zero. A crop is a
    // sample of one surface or it is not a sample.
    const cg = loadPos(cx, cy).toVar();
    const cn = normalize(loadNrm(cx, cy).xyz).toVar();
    const accP = vec3(0).toVar();
    const accN = vec3(0).toVar();
    const accE = vec3(0).toVar();
    const accG = vec3(0).toVar();
    const accL = vec3(0).toVar();
    const accA = vec3(0).toVar();
    const accEm = float(0).toVar();
    const n = float(0).toVar();
    for (let dy = -CROP_HALF; dy <= CROP_HALF; dy++) {
      for (let dx = -CROP_HALF; dx <= CROP_HALF; dx++) {
        const px = cx.add(int(dx)).clamp(int(0), u.widthU.toInt().sub(int(1))).toVar();
        const py = cy.add(int(dy)).clamp(int(0), u.heightU.toInt().sub(int(1))).toVar();
        const g = loadPos(px, py).toVar();
        const nn = normalize(loadNrm(px, py).xyz).toVar();
        const sameSurface = g.w.greaterThan(0.5).and(cg.w.greaterThan(0.5))
          .and(dot(nn, cn).greaterThan(0.9))
          .and(dot(cn, g.xyz.sub(cg.xyz)).abs().lessThan(0.02));
        If(sameSurface, () => {
          const pi = palIndexAtWorld(g.xyz, nn).toVar();
          const pal = palU.element(pi).toVar();
          accP.addAssign(g.xyz);
          accN.addAssign(nn);
          accE.addAssign(irrNode.load(ivec2(px, py)).xyz);
          accG.addAssign(glossyNode.load(ivec2(px, py)).xyz);
          accL.addAssign(litNode.load(ivec2(px, py)).xyz);
          accA.addAssign(pal.xyz);
          // The crop receipt keeps ONE emissive number per sample (the readers
          // print a column), so it is the class's MEAN — `palU.w`, which
          // `setPalette` keeps in step with the RGB table for exactly this.
          accEm.addAssign(pal.w);
          n.addAssign(1);
        });
      }
    }
    const k = float(1).div(n.max(1)).toVar();
    const base = i.mul(uint(CROP_OUT_VEC)).toVar();
    cropOut.element(base).assign(vec4(accP.mul(k), n));
    cropOut.element(base.add(uint(1))).assign(vec4(normalize(accN.mul(k)), 0));
    cropOut.element(base.add(uint(2))).assign(vec4(accE.mul(k), 0));
    cropOut.element(base.add(uint(3))).assign(vec4(accG.mul(k), 0));
    cropOut.element(base.add(uint(4))).assign(vec4(accL.mul(k), 0));
    cropOut.element(base.add(uint(5))).assign(vec4(accA.mul(k), accEm.mul(k)));
    // §19 3.17 — the per-cascade census (see `CROP_OUT_VEC`). The crop's own
    // averaged point and normal, asked of each cascade ALONE, next to the
    // hand-off weight the resolve would give it there.
    if (world) {
      const cp = accP.mul(k).toVar();
      const cnn = normalize(accN.mul(k)).toVar();
      for (let c = 0; c < 3; c++) {
        if (c >= world.taps.cascades) {
          cropOut.element(base.add(uint(6 + c))).assign(vec4(0));
          continue;
        }
        const fr = world.taps.cellFrameAt(cp, float(world.taps.spacingOf(c)));
        const bw = world.taps.bandAt(fr.g, vec3(world.origins[c])).toVar();
        cropOut.element(base.add(uint(6 + c)))
          .assign(vec4(world.taps.irradianceAtCasc(uint(c), cp, cnn), bw));
      }
    } else {
      for (let c = 0; c < 3; c++) cropOut.element(base.add(uint(6 + c))).assign(vec4(0));
    }
  })().compute(crops);

  // ══════════════════════════════════════════════ SHADER: noiseDump (§19 3.6)
  //
  // One vec4 per pixel: (luminance of the resolved irradiance, the same
  // through a 5×5 BOX, an edge flag, the gbuffer's validity). The CPU makes
  // both of §3.6's receipts out of it — TEMPORAL by accumulating `x` over 30
  // frames per pixel, SPATIAL from `|x − y| / y` in one frame — and neither
  // is computable after the fact from a crop or from the lit buffer.
  //
  // ⚠ THE BOX IS A PLAIN BOX AND THE EDGE FLAG IS SEPARATE, deliberately. A
  // bilateral box would hide exactly the failure the receipt exists to find:
  // a blotch that follows a surface's own plane is invisible to a filter that
  // trusts the plane. The neighbourhood test only MARKS the pixel, and the
  // statistic drops it; what the surviving pixels are compared against is the
  // unweighted mean of their 25 neighbours.
  const noiseDumpPass = !wantNoise ? null : Fn(() => {
    const gx = globalId.x.toVar();
    const gy = globalId.y.toVar();
    If(gx.greaterThanEqual(u.halfWU).or(gy.greaterThanEqual(u.halfHU)), () => { Return(); });
    const px = gx.mul(uint(2)).toVar();
    const py = gy.mul(uint(2)).toVar();
    const g = loadPos(px.toInt(), py.toInt()).toVar();
    const n0 = normalize(loadNrm(px.toInt(), py.toInt()).xyz).toVar();
    const LUMA = vec3(0.2126, 0.7152, 0.0722);
    const box = float(0).toVar();
    const edge = float(0).toVar();
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        const qx = px.toInt().add(int(ox)).clamp(int(0), u.widthU.toInt().sub(int(1))).toVar();
        const qy = py.toInt().add(int(oy)).clamp(int(0), u.heightU.toInt().sub(int(1))).toVar();
        const gg = loadPos(qx, qy).toVar();
        const nn = normalize(loadNrm(qx, qy).xyz).toVar();
        const same = gg.w.greaterThan(0.5).and(g.w.greaterThan(0.5))
          .and(dot(nn, n0).greaterThan(0.95))
          .and(dot(n0, gg.xyz.sub(g.xyz)).abs().lessThan(v0 * 0.5)).toVar();
        box.addAssign(dot(irrNode.load(ivec2(qx, qy)).xyz, LUMA));
        If(same.not(), () => { edge.assign(1); });
      }
    }
    const here = dot(irrNode.load(ivec2(px.toInt(), py.toInt())).xyz, LUMA).toVar();
    noiseBuf.element(gy.mul(u.halfWU).add(gx)).assign(vec4(here, box.div(25), edge, g.w));
    // §19 Stage 3.7 P.5's geometry, in its own buffer: the view depth (the CPU
    // divides by `projScale` to get a metre's size in pixels HERE), the normal's
    // Y (façade against pavement) and the world height. Everything the dirty
    // receipt needs to turn a pixel into a PLACE, and nothing the temporal
    // receipt has to read back thirty times an arm.
    const clipW = u.viewProj.mul(vec4(g.xyz, 1)).w.toVar();
    dirtyBuf.element(gy.mul(u.halfWU).add(gx)).assign(vec4(clipW, n0.y, g.y, g.w));
  })().compute(dispatch2d(halfW, halfH), WG);

  // ══════════════════════════════════ SHADER: reprojDump (§19 3.11a)
  //
  // ⭐⭐ THE MOVING RECEIPT COMPARES A SURFACE POINT TO ITSELF, NOT A SCREEN
  // PIXEL TO ITSELF. See `reprojBuf`. Both halves of `motionLum` are written
  // and read by this one kernel: `curBase` takes this frame's luminance,
  // `prevBase` still holds the previous frame's, and the reprojection reads
  // the previous half at the pixel this surface point occupied THEN.
  const reprojDumpPass = !wantNoise ? null : Fn(() => {
    const gx = globalId.x.toVar();
    const gy = globalId.y.toVar();
    If(gx.greaterThanEqual(u.halfWU).or(gy.greaterThanEqual(u.halfHU)), () => { Return(); });
    const i = gy.mul(u.halfWU).add(gx).toVar();
    const half = u.halfWU.mul(u.halfHU).toVar();
    const px = gx.mul(uint(2)).toVar();
    const py = gy.mul(uint(2)).toVar();
    const g = loadPos(px.toInt(), py.toInt()).toVar();
    const LUMA = vec3(0.2126, 0.7152, 0.0722);
    /**
     * The signal this census is about, at one FULL-RES pixel. `reprojNull = 1`
     * makes it the ALBEDO — a field that provably did not change between the
     * two frames — so the same census can report its own floor. Everything
     * downstream, the error bar included, goes through this one function, or
     * the floor arm would be measured by a bar built from a different field.
     */
    const signalAt = (ix, iy) => select(u.reprojNull.greaterThan(0.5),
      dot(palAtWorld(loadPos(ix, iy).xyz, normalize(loadNrm(ix, iy).xyz)).xyz, LUMA),
      dot(irrNode.load(ivec2(ix, iy)).xyz, LUMA));
    const here = signalAt(px.toInt(), py.toInt()).toVar();
    motionLum.element(u.curBase.mul(half).add(i)).assign(here);

    const there = float(0).toVar();
    // ⚠ THE SOURCE PIXEL'S INDEX, NOT A VALIDITY FLAG. The sign census has to
    // follow the SURFACE POINT across frames — `sign(Δ_k)` at this pixel
    // against `sign(Δ_{k−1})` at the pixel this point occupied then — and a
    // boolean cannot carry that. −1 is "the reprojection missed".
    const src = float(-1).toVar();
    /** §19 3.18 — this tap's own error bar. See `reprojErr`. */
    const err = float(0).toVar();
    /**
     * ⭐⭐⭐ §19 3.18 — HOW FAR THE TAP LANDED FROM A SAMPLE CENTRE, 0 … 0.5.
     *
     * The error bars above ESTIMATE the resampling error. This removes it:
     * where the reprojected point lands on a texel centre the previous value is
     * READ, not interpolated, and the comparison is exact whatever the field's
     * spatial content. The sub-pixel phase is a function of the camera and the
     * geometry and is INDEPENDENT of the estimator, so selecting on it draws an
     * unbiased sample of the same surfaces — which is what makes "score only
     * the exact taps" a stronger census rather than a smaller one.
     *
     * ⚠ 1 WHERE THE REPROJECTION MISSED, so a dropped tap can never look exact.
     */
    const phase = float(1).toVar();
    const c = u.prevViewProj.mul(vec4(g.xyz, 1)).toVar();
    If(g.w.greaterThan(0.5).and(c.w.greaterThan(1e-4)), () => {
      const sx = c.x.div(c.w).mul(0.5).add(0.5).toVar();
      const sy = float(1).sub(c.y.div(c.w).mul(0.5).add(0.5)).toVar();
      If(sx.greaterThanEqual(0).and(sx.lessThan(1)).and(sy.greaterThanEqual(0)).and(sy.lessThan(1)), () => {
        // ⭐⭐ BILINEAR, AND THAT IS THE INSTRUMENT'S OWN BLIND-STATISTICS
        // CHECK. A surface point's previous screen position is not a pixel
        // centre; snapping it to the nearest one reads the previous frame's
        // irradiance up to half a pixel AWAY, and on any field with spatial
        // structure that sampling error lands in Δ and is then reported as the
        // estimator rattling. Measured: nearest-neighbour put the orbit's pixel
        // Δp95 at 11.01 % where the bilinear read of the SAME frames puts it
        // far lower — most of what the first cut of this receipt called grain
        // was the receipt's own `floor()`.
        // ⚠ THE HALF-RES INDEX COMES FROM THE **FULL-RES** PIXEL THIS THREAD
        // READ. Slot `gx` samples the gbuffer at full-res pixel `2gx`, whose
        // screen coordinate is `(2gx+0.5)/W` — not `(gx+0.5)/halfW`. Mapping
        // through `halfW` puts a quarter-pixel bias on every tap, and at rest,
        // where the answer must be exact, it made the receipt report 1.39 %
        // of motion on a frame that had not moved at all.
        const fx = sx.mul(u.widthF).sub(0.5).mul(0.5).toVar();
        const fy = sy.mul(u.heightF).sub(0.5).mul(0.5).toVar();
        const x0 = fx.floor().toVar();
        const y0 = fy.floor().toVar();
        const ax = fx.sub(x0).toVar();
        const ay = fy.sub(y0).toVar();
        const cx0 = x0.clamp(0, u.halfWU.toFloat().sub(1)).toUint().toVar();
        const cy0 = y0.clamp(0, u.halfHU.toFloat().sub(1)).toUint().toVar();
        const cx1 = x0.add(1).clamp(0, u.halfWU.toFloat().sub(1)).toUint().toVar();
        const cy1 = y0.add(1).clamp(0, u.halfHU.toFloat().sub(1)).toUint().toVar();
        const base = u.prevBase.mul(half).toVar();
        const t00 = motionLum.element(base.add(cy0.mul(u.halfWU)).add(cx0)).toVar();
        const t10 = motionLum.element(base.add(cy0.mul(u.halfWU)).add(cx1)).toVar();
        const t01 = motionLum.element(base.add(cy1.mul(u.halfWU)).add(cx0)).toVar();
        const t11 = motionLum.element(base.add(cy1.mul(u.halfWU)).add(cx1)).toVar();
        there.assign(mix(mix(t00, t10, ax), mix(t01, t11, ax), ay));
        // ── §19 3.18: the same tap, one order higher ─────────────────────
        //
        // Catmull-Rom over the 4×4 that contains the bilinear 2×2. The
        // DIFFERENCE between the two is this tap's own error bar; `reprojErr`
        // carries it and the CPU census refuses to score a delta smaller than
        // it. ⚠ CLAMPED ON BOTH AXES with the same `clamp` the bilinear taps
        // use, so an edge pixel degrades to a repeated sample rather than
        // reading another row — the wrap is what would put a spurious error
        // bar on exactly the pixels a whip pan disoccludes.
        const crw = (t) => [
          t.mul(t.mul(t.mul(-0.5).add(1)).sub(0.5)),
          t.mul(t).mul(t.mul(1.5).sub(2.5)).add(1),
          t.mul(t.mul(t.mul(-1.5).add(2)).add(0.5)),
          t.mul(t).mul(t.mul(0.5).sub(0.5)),
        ];
        const wx = crw(ax);
        const wy = crw(ay);
        const cubic = float(0).toVar();
        for (let jy = 0; jy < 4; jy++) {
          const cy = y0.add(jy - 1).clamp(0, u.halfHU.toFloat().sub(1)).toUint().toVar();
          const rowv = float(0).toVar();
          for (let jx = 0; jx < 4; jx++) {
            const cx = x0.add(jx - 1).clamp(0, u.halfWU.toFloat().sub(1)).toUint().toVar();
            rowv.addAssign(motionLum.element(base.add(cy.mul(u.halfWU)).add(cx)).mul(wx[jx]));
          }
          cubic.addAssign(rowv.mul(wy[jy]));
        }
        // ⭐⭐⭐ AND A SECOND BAR, BECAUSE THE FIRST ONE CANNOT SEE A SHARP FIELD.
        //
        // The bicubic residual bounds the error of a SMOOTH field, and it reads
        // near zero on a blocky one — both interpolants agree inside a block and
        // both are wrong at its edge. So the tap's error is also estimated the
        // way an error is estimated when the truth is known: reconstruct THIS
        // pixel's value from its own frame's neighbours at the SAME sub-pixel
        // geometry and compare against the value that is known exactly.
        //
        // ⚠ THE NEIGHBOURS COME FROM THE TEXTURE, NEVER FROM `motionLum`. This
        // kernel writes `motionLum[curBase]` at the top and there is no barrier
        // inside a dispatch, so reading a neighbour's slot would read whatever
        // that thread had or had not written yet — a race, and a different one
        // per launch. [[tsl-atomic-select-trap]]'s sibling.
        //
        // ⚠ AND IT IS SCALED. The reconstruction spans TWO half-res pixels where
        // the real tap spans one, and a bilinear error goes as the square of the
        // span — hence `0.25` — times `4a(1−a)`, which is the error's own shape
        // in the fraction: exact at a tap centre, worst half-way between.
        const sAt = (dx, dy) => signalAt(
          px.toInt().add(dx).clamp(0, u.widthU.toInt().sub(1)),
          py.toInt().add(dy).clamp(0, u.heightU.toInt().sub(1)),
        );
        const est = mix(mix(sAt(-2, -2), sAt(2, -2), ax),
          mix(sAt(-2, 2), sAt(2, 2), ax), ay).toVar();
        const shape = max(ax.mul(float(1).sub(ax)), ay.mul(float(1).sub(ay))).mul(4).toVar();
        err.assign(max(cubic.sub(there).abs(), est.sub(here).abs().mul(0.25).mul(shape)));
        phase.assign(max(min(ax, float(1).sub(ax)), min(ay, float(1).sub(ay))));
        // The SIGN census still needs one integer identity for the surface
        // point, and the nearest tap is the honest one: it names the pixel this
        // point most belonged to, and a sign carried through it is carried
        // through the same trajectory the bilinear value follows.
        src.assign(cy0.add(ay.round().toUint()).min(u.halfHU.sub(uint(1)))
          .mul(u.halfWU).add(cx0.add(ax.round().toUint()).min(u.halfWU.sub(uint(1)))).toFloat());
      });
    });
    reprojBuf.element(i).assign(vec4(here, there, src, g.w));
    reprojErr.element(i).assign(vec2(err, phase));
  })().compute(dispatch2d(halfW, halfH), WG);

  // ══════════════════════════════════════════════ SHADER: shadeHit, exposed
  //
  // ⭐ THE ONE STAGE A CROP CANNOT SEE. Every crop in the receipts sits on a
  // surface the camera can see, and every visible surface's cache entry is
  // written by `injectLitFrame` — so the crops cannot say anything at all
  // about §L.2's fresh-slot shading, which is the ONLY thing that lights the
  // surfaces the camera CANNOT see. Running the chain with the injection pass
  // switched off showed the whole cache going black; this pass says which
  // term of `shadeHit` is the zero. Every intermediate the estimator computes
  // comes out: palette, N·L to the sun and its shadow, the panel's two
  // cosines, the shadow ray's length and its visibility, and the composed
  // result the cache would store.
  const shadeProbePass = Fn(() => {
    const i = instanceIndex.toVar();
    const a = shadeIn.element(i.mul(uint(2))).toVar();
    const b = shadeIn.element(i.mul(uint(2)).add(uint(1))).toVar();
    const p = a.xyz.toVar();
    const levelF = a.w.toVar();
    const n = b.xyz.toVar();
    const voxF = b.w.toVar();
    const pal = palAt(levelF, voxF).toVar();

    const toSun = u.sunDir.negate().normalize().toVar();
    const ndl = dot(n, toSun).max(0).toVar();
    const sunSh = float(-1).toVar();
    If(ndl.greaterThan(0.001), () => { sunSh.assign(traceWindow(p, toSun, RAY_MAX, n).hit); });

    // The centre stratum of the panel, with every term of its NEE exposed.
    const q = vec3(u.panelCentre.x, u.panelCentre.y, u.panelCentre.z).toVar();
    const wv = q.sub(p).toVar();
    const d2 = dot(wv, wv).max(1e-4).toVar();
    const d = sqrt(d2).toVar();
    const wd = wv.div(d).toVar();
    const cosX = dot(n, wd).max(0).toVar();
    const cosP = wd.y.max(0).toVar();
    const yStop = u.panelCentre.y.div(v0).floor().mul(v0).sub(v0 * 0.5).toVar();
    const tStop = yStop.sub(p.add(n.mul(v0 * 0.5)).y).div(wd.y.max(1e-3)).min(d).max(0.05).toVar();
    const vis = float(1).sub(traceWindow(p, wd, tStop, n).hit).toVar();
    const Ecentre = u.panelRadiance.mul(cosX).mul(cosP).mul(u.panelArea).div(d2).mul(vis).toVar();

    // A seed, so this microscope sees the SHIPPING estimator — the sky term and
    // the stochastic NEE both key off it, and without one this pass would
    // report a `shadeHit` that no ray ever computes.
    const shaded = shadeHit(p, n, levelF, voxF, pcg(i.add(uint(12345)))).toVar();
    shadeOut.element(i.mul(uint(4))).assign(vec4(pal.xyz, pal.w));
    shadeOut.element(i.mul(uint(4)).add(uint(1))).assign(vec4(ndl, sunSh, cosX, cosP));
    shadeOut.element(i.mul(uint(4)).add(uint(2))).assign(vec4(d, tStop, vis, Ecentre.x));
    shadeOut.element(i.mul(uint(4)).add(uint(3))).assign(vec4(shaded, 0));
  })().compute(SHADE_SLOTS);

  // ══════════════════════════════════════════════ SHADER: exhaustProbe
  //
  // ⭐⭐ "3.6 % OF RAYS EXHAUST 40 m IN A SEALED ROOM" IS A RATE, AND A RATE
  // NAMES NO MECHANISM. Four different faults produce it — a diagonal slip
  // through a voxel corner, a gap at an L0/L1 hand-off, an origin that
  // escapes through its own wall, a dust voxel that blocks nothing — and
  // arguing between them from the rate is guesswork. So this kernel records
  // the FIRST `EXHAUST_SLOTS` exhausted rays: where they started, where they
  // pointed, how far the SCREEN segment carried them before handing over,
  // and — the discriminating pair — what the SAME ray does traced from the
  // probe with NO hand-off at all.
  //
  // That pair is the whole diagnostic. A ray that misses from both ends is a
  // trace fault; a ray that HITS from the probe and MISSES from the hand-off
  // point was carried through a wall by the screen walk, and the leak is in
  // the hand-off, not in the DDA.
  //
  // It re-derives the ray exactly as `probeTrace` does — same rotation, same
  // jitter, same texel window — so it is the same ray and not a similar one.
  // Bindings: window, meta, hzb, stats, exhaustOut = 5.
  const exhaustProbePass = useWorld ? null : Fn(() => {
    const xr = globalId.x.toVar();
    const ty = globalId.y.toVar();
    If(xr.greaterThanEqual(u.probeWU.mul(uint(RAY_FRESH))).or(ty.greaterThanEqual(u.probeHU)),
      () => { Return(); });
    const tx = xr.div(uint(RAY_FRESH)).toVar();
    const kRay = xr.sub(tx.mul(uint(RAY_FRESH))).toVar();
    const probe = ty.mul(u.probeWU).add(tx).toVar();
    // §19 Stage 3.7: the SAME per-probe allocation `probeTrace` uses. "It is
    // the same ray and not a similar one" only stays true if the ray COUNT is
    // the same too — a thread that `probeTrace` never launched has no ray to
    // be diagnosed.
    const emc = probeMeta.element(metaIdx(u.curBase, probe, 2)).toVar();
    const ematR = atomicLoad(stats.element(uint(STAT_RAY_BUDGET * STAT_STRIPE)))
      .max(uint(RAY_MATURE_MIN)).min(uint(OCT)).toVar();
    const eRays = select(u.needRays.greaterThan(0.5),
      select(emc.z.greaterThan(CLS_FLAG + 0.5), uint(RAY_FRESH),
        select(emc.z.greaterThan(CLS_MATURE + 0.5), uint(RAY_FLAG), ematR)),
      uint(R)).toVar();
    If(kRay.greaterThanEqual(eRays), () => { Return(); });
    const eStride = uint(OCT).div(eRays).max(uint(1)).toVar();
    const ma = probeMeta.element(metaIdx(u.curBase, probe, 0)).toVar();
    const mb = probeMeta.element(metaIdx(u.curBase, probe, 1)).toVar();
    If(ma.w.lessThan(0.5), () => { Return(); });
    const pos = ma.xyz.toVar();
    const nrm = mb.xyz.toVar();

    const rot = pcg(u.frame.mul(uint(2654435761)).add(probe)).toVar();
    const seedBase = pcg(probe.mul(uint(196613)).add(u.frame.mul(uint(83492791)))).toVar();
    const texel = int(-1).toVar();
    const dir = vec3(0, 1, 0).toVar();
    Loop({ start: 0, end: PICK_MAX, name: "epick" }, ({ epick }) => {
      If(uint(epick).greaterThanEqual(eStride).or(texel.greaterThanEqual(0)), () => { Break(); });
      const t = bitAnd(kRay.mul(eStride).add(uint(epick)).add(rot), uint(OCT - 1)).toVar();
      const tu = bitAnd(t, uint(O - 1)).toFloat().toVar();
      const tv = shiftRight(t, uint(OCT_SHIFT)).toFloat().toVar();
      const jx = rand01(seedBase.add(t.mul(uint(7919)))).toVar();
      const jy = rand01(seedBase.add(t.mul(uint(7919))).add(uint(1))).toVar();
      const d = octDirJit(tu, tv, jx, jy).toVar();
      If(dot(d, nrm).greaterThan(0.02), () => {
        texel.assign(t.toInt());
        dir.assign(d);
      });
    });
    If(texel.lessThan(0), () => { Return(); });

    // The ray exactly as the shipping kernel traces it: the window from the
    // probe, then the screen only at contact.
    const r = traceWindow(pos, dir, float(RAY_MAX), nrm).raw.toVar();
    const sHit = float(0).toVar();
    const sRad = vec3(0).toVar();
    const sDist = float(RAY_MAX).toVar();
    const sSeen = float(0).toVar();
    const contact = r.x.greaterThan(0.5).and(r.y.lessThan(v0 * CONTACT_CELLS)).toVar();
    If(u.hzbOn.greaterThan(0.5).and(contact), () => {
      screenSegment(pos.add(nrm.mul(v0 * 0.5)), dir, r.y.add(v0), sHit, sRad, sDist, sSeen, xr);
    });
    If(r.x.greaterThan(0.5), () => { Return(); });

    // A ray that missed. What ELSE can be said about it, cheaply: how many DDA
    // steps it burned (the brick budget is the one bound that can end a ray
    // early), and where a HALF-LENGTH trace from the same origin ends up — a
    // ray that misses at 40 m and also misses at 20 m left the room early;
    // one that misses at 40 m having crossed no brick at all never started.
    const rHalf = traceWindow(pos, dir, float(RAY_MAX * 0.5), nrm).raw.toVar();
    const slot = atomicAdd(stats.element(uint(EXHAUST_CLAIM * STAT_STRIPE)), uint(1)).toVar();
    If(slot.greaterThanEqual(uint(EXHAUST_SLOTS)), () => { Return(); });
    const base = slot.mul(uint(EXH_VEC)).toVar();
    exhaustOut.element(base).assign(vec4(pos, probe.toFloat()));
    exhaustOut.element(base.add(uint(1))).assign(vec4(dir, texel.toFloat()));
    exhaustOut.element(base.add(uint(2))).assign(vec4(r.w, rHalf.x, rHalf.y, rHalf.w));
    exhaustOut.element(base.add(uint(3))).assign(vec4(pos.add(dir.mul(RAY_MAX)), r.y));

  })().compute(dispatch2d(probeW * RAY_FRESH, probeH), WG);

  // ══════════════════════ SHADER: contactRay (§19 3.11's leak gate)
  //
  // ⭐⭐ THE OLD LEAK TEST COULD NOT SEE THE CONTACT RULE, AND WOULD HAVE
  // PASSED BLIND. `gi2-gather.html`'s 10 000-ray receipt calls `traceWindow`
  // directly, and the rule lives one level ABOVE that call — so its 0/10 000
  // says the DDA still blocks and says nothing whatever about whether the
  // continuation walks through a 5 cm wall. This pass is the shipped decision,
  // exposed on rays the page chooses: the same window trace, the same screen
  // segment, the same `sSeen`/`vouched` test, the same continuation. A ray
  // "escapes" when the rule DISCARDED its hit and the continuation found
  // nothing — and a wall is the one surface that must never be discarded.
  //
  // Bindings: window, hzb, contactIn, contactOut, stats = 5.
  const contactRayPass = !wantContact ? null : Fn(() => {
    const i = instanceIndex.toVar();
    const a0 = contactIn.element(i.mul(uint(2))).toVar();
    const a1 = contactIn.element(i.mul(uint(2)).add(uint(1))).toVar();
    const o = a0.xyz.toVar();
    const d = a1.xyz.toVar();
    const tMax = a0.w.toVar();
    const r = traceWindow(o, d, tMax, vec3(0, 0, 0)).raw.toVar();
    const sHit = float(0).toVar();
    const sRad = vec3(0).toVar();
    const sDist = float(RAY_MAX).toVar();
    const sSeen = float(0).toVar();
    If(u.hzbOn.greaterThan(0.5).and(r.x.greaterThan(0.5))
      .and(r.y.lessThan(v0 * CONTACT_CELLS)), () => {
      screenSegment(o, d, r.y.add(v0), sHit, sRad, sDist, sSeen, i);
    });
    const agree = sHit.greaterThan(0.5).and(sDist.sub(r.y).abs().lessThan(v0)).toVar();
    const inBand = u.contactOn.greaterThan(0.5).and(r.x.greaterThan(0.5))
      .and(r.y.lessThan(v0 * CONTACT_AUTH_CELLS)).and(agree.not()).toVar();
    const vouched = sSeen.greaterThan(0.5).and(sHit.lessThan(0.5))
      .or(u.contactForce.greaterThan(0.5)).toVar();
    const take = inBand.and(vouched).toVar();
    const contStart = r.y.add(v0).toVar();
    const rc = vec4(0).toVar();
    If(take, () => {
      rc.assign(traceWindow(o.add(d.mul(contStart)), d, tMax.sub(contStart), d).raw);
    });
    contactOut.element(i).assign(vec4(
      select(take, rc.x, r.x),
      select(take, rc.y.add(contStart), r.y),
      // bit 0 the rule fired, bit 1 the band, bit 2 the screen saw it,
      // bit 3 the screen vouched — one word, so a page can census the WHY.
      select(take, float(1), float(0))
        .add(select(inBand, float(2), float(0)))
        .add(select(sSeen.greaterThan(0.5), float(4), float(0)))
        .add(select(vouched, float(8), float(0))),
      r.y,
    ));
  })().compute(CONTACT_RAYS);

  // ══════════════════════════════════════════════ SHADER: cold-start clears
  const clearProbesPass = useWorld ? null : Fn(() => {
    probeOct.element(instanceIndex).assign(vec4(0));
  })().compute(2 * probeCount * OCT);
  const clearMetaPass = Fn(() => {
    probeMeta.element(instanceIndex).assign(vec4(0));
  })().compute(2 * probeCount * META_VEC);
  const clearStatsPass = Fn(() => {
    statsBuf.element(instanceIndex).assign(uint(0));
  })().compute(STAT_WORDS);

  // ── JS-side plumbing ──────────────────────────────────────────────────────
  let frame = 0;
  /**
   * The class→colour tables. TWO uniform arrays, ONE call, and a re-tint is
   * exactly this call again — no re-voxelize, no soup rebuild, no recompile,
   * because the class ASSIGNMENT lives in the soup's `triPal` and each voxel's
   * `pal` byte and is untouched here (audits §O.5(c)).
   *
   * `emissive` accepts a SCALAR (the Cornell rigs author a grey panel that way,
   * and the CPU reference reads the same number back) or an `[r, g, b]`. Both
   * fill `palEmU.xyz`; `palU.w` always carries the mean, which is what the crop
   * and shade receipts print.
   */
  const setPalette = (entries) => {
    for (let i = 0; i < PAL_ENTRIES; i++) {
      const e = entries[i] ?? { albedo: [0, 0, 0], emissive: 0 };
      const em = e.emissive ?? 0;
      const er = Array.isArray(em) ? (em[0] ?? 0) : em;
      const eg = Array.isArray(em) ? (em[1] ?? 0) : em;
      const eb = Array.isArray(em) ? (em[2] ?? 0) : em;
      palette[i].set(e.albedo[0], e.albedo[1], e.albedo[2], (er + eg + eb) / 3);
      paletteEmissive[i].set(er, eg, eb, 0);
    }
  };
  /**
   * §19 3.13. The lattice's own placement, on the SAME call the caller already
   * makes for the window — `beginFrame` is the one point every consumer of this
   * factory passes through, and a second "and also call `world.setCamera`"
   * contract is exactly the caller-position dependency the shadow-freeze bug
   * was made of.
   *
   * ⭐ `pos` FALLS BACK TO `u.camPos`, AND THAT IS WHAT KEEPS `gi2System`
   * UNEDITED. That consumer calls `beginFrame(frame)` and then `syncLighting()`
   * -- so at this instant `u.camPos` holds the PREVIOUS frame's position, and
   * the lattice's origin therefore steps one frame after the window's. It is a
   * hysteretic, block-aligned step that only fires when the camera leaves the
   * central half of a 16 m cube, and the entering slab needs several frames of
   * round-robin to fill either way, so one frame of lag on the trigger is not
   * reachable by any receipt. Silently NOT following the camera would have
   * been: the lattice would sit where the scene opened, forever.
   */
  const beginFrame = (n, pos = null) => {
    if (world) world.setCamera(pos ?? u.camPos.value);
    frame = n;
    u.frame.value = n >>> 0;
    u.curBase.value = n & 1;
    u.prevBase.value = (n & 1) ^ 1;
  };

  const describe = () => ({
    tier, tile: T, rays: R, oct: O, history: H, stride: STRIDE, sh: USE_SH,
    // §19 3.13. `worldProbes` is the CONFIGURATION, not the constant: a receipt
    // that prints the constant would report what someone believes shipped.
    worldProbes: useWorld, world: world?.describe() ?? null,
    metaVec: META_VEC, matureRays: MATURE_RAYS, rayFresh: RAY_FRESH, rayFlag: RAY_FLAG,
    shadeProb: u.shadeProb.value, nCap: u.nCapU.value, skyRays: SKY_RAYS,
    // §19 4.14 (§AL)'s two arms, so a receipt cannot claim a stage it did not
    // build. `cacheFromProbes` is a BUILD arm; reading it off a uniform would
    // be reading the wrong thing.
    cacheFromProbes: CACHE_FROM_PROBES, bounceAlbedoMax: BOUNCE_ALBEDO_MAX,
    // §19 4.5's two arms, printed rather than believed.
    cacheSmooth: u.cacheSmoothU.value, coldFill: u.coldFillU.value,
    // §19 3.12's three, so a receipt can print the configuration it measured
    // instead of the configuration someone believes shipped.
    probeDither: u.probeDither.value, panelNee: u.panelNee.value,
    accumAlpha: u.accumAlpha.value, panelRig: PANEL_RIG,
    shRadius: SH_R, packN: PACK_N, packD: PACK_D, distQ: DIST_Q, sigQ: SIG_Q,
    sigMin: SIG_MIN, sigOct: SIG_OCT, rayMax: RAY_MAX,
    width, height, halfW, halfH, probeW, probeH, probeCount,
    hzbMips: HZB_MIPS, hzbSteps: S_MAX, cropBlock: CROP_HALF * 2 + 1,
    bytes: {
      probeMeta: 2 * probeCount * META_VEC * 16,
      probeOct: 2 * probeCount * OCT * 16,
      probeFiltered: (probeCount * OCT + probeCount * MIP_TEXELS) * 16,
      probeSh: 2 * probeCount * 9 * 16,
      hzb: hzbWords * 4,
      dirtyBuf: dirtyBuf ? halfW * halfH * 16 : 0,
      litBuf: width * height * 16,
      // §19 3.12 adds the two history textures: +2 full-res RGBA16F.
      textures: 5 * width * height * 8 + 2 * halfW * halfH * 8,
      worldProbes: world ? Object.values(world.describe().bytes).reduce((a, b) => a + b, 0) : 0,
    },
  });

  const api = {
    tier, T, R, O, H, SH_R, STRIDE, USE_SH, probeW, probeH, probeCount, width, height,
    /** §19 3.13 — the configuration, for a consumer that has to branch on it. */
    worldProbes: useWorld, world,
    uniforms: u, palette, paletteEmissive, setPalette, beginFrame, get frame() { return frame; },
    /**
     * §19 Stage 4.5. The shade estimator's own pieces, for a RECEIPT kernel that
     * has to weigh them term by term (`scripts/lib/gi2FaceTermProbe.js`).
     *
     * ⚠ NOTHING IN THE ENGINE MAY DISPATCH THROUGH THESE. They are node
     * factories, not passes: a harness lib composes them into its own kernel and
     * that kernel is built only when a receipt asks for it (§19 Stage 4.3a's
     * rule). Exporting them is what keeps the receipt measuring the SHIPPING
     * estimator instead of a transcription of it.
     */
    internals: { shadeTerms, shadeHit, dominantFace, faceSamplePoint, cellOfWorld, palAt },
    buffers: {
      probeMeta, probeOct, probeFiltered, probeSh, hzb, statsBuf, cropIn, cropOut, litBuf,
      shadeIn, shadeOut, exhaustOut, noiseBuf, dirtyBuf, reprojBuf, motionLum,
      /** §19 3.18's flip classifier — `DIAG_VEC` vec4 per half-res pixel. */
      diagBuf, diagVec: DIAG_VEC, reprojErr,
      /**
       * How many of `diagVec`'s rows are CASCADES. The rest are §19 4.9's
       * fallback row, and a reader that treats it as a fourth cascade reads
       * `faceCov` as `cov` — which is how a diagnostic becomes the bug.
       */
      diagCasc: world ? world.taps.cascades : 0,
      contactIn, contactOut,
      ...(world ? world.buffers : null),
    },
    SHADE_SLOTS, EXHAUST_SLOTS, EXH_VEC, CONTACT_RAYS,
    textures: {
      irradiance, glossy, lit, irradianceHalf, glossyHalf,
      // §19 3.12. Read/written only by compute kernels, so no `.version` stamp
      // is needed (that stamp exists for the two textures MATERIALS bind), and
      // `dispose()` below hands them to `gi2System`'s retire queue with the
      // rest of the gather on a resize.
      irradianceHist, glossyHist,
    },
    passes: {
      hzbBuild: hzbBuildPass,
      hzbReduce: hzbReducePasses,
      probePlace: probePlacePass,
      /** §P.3's one-thread allocator. Between `probePlace` and `probeTrace`. */
      rayBudget: rayBudgetPass,
      probeTrace: probeTracePass,
      probeFilter: probeFilterPass,
      probeShFilter: probeShFilterPass,
      /** §L.4's OLD radius, kept as the width A/B's other arm. */
      probeShFilter3: probeShFilter3Pass,
      resolve: resolvePass,
      resolveOct: resolveOctPass,
      resolveShRaw: resolveShRawPass,
      // ⚠ THE FAST PATH IS A PAIR, and `passes.resolve` is deliberately NOT
      // it: a consumer whose chain already lists `resolve` keeps a correct
      // (full-res, slower) frame instead of a black one. Dispatch
      // `resolveHalf` then `resolveUpsample` INSTEAD of `resolve`, or take
      // `frameOrder` and stop hand-listing kernels.
      resolveHalf: resolveHalfPass,
      resolveUpsample: resolveUpsamplePass,
      /**
       * §19 3.12's per-probe NEE for the Cornell rig's panel. `null` on any
       * build with real emitter slots (`gi2System`'s `emitterDirectPass` is
       * that build's version) and on any build with no crops.
       */
      panelDirect: panelDirectPass,
      /** §19 3.12's accumulator memory — see `imageHistoryPass`. */
      imageHistory: imageHistoryPass,
      composite: compositePass,
      inject: injectPass,
      crop: cropPass,
      noiseDump: noiseDumpPass,
      /** §19 3.11a's moving receipt — see `reprojBuf`. Harness only. */
      reprojDump: reprojDumpPass,
      /** §19 3.11's leak gate — see `contactRayPass`. Harness only. */
      contactRay: contactRayPass,
      shadeProbe: shadeProbePass,
      exhaustProbe: exhaustProbePass,
      clearProbes: clearProbesPass,
      clearMeta: clearMetaPass,
      clearStats: clearStatsPass,
      // §19 3.13's lattice, under `world*` names so nothing that walks this map
      // by key can confuse a world kernel with a screen one.
      worldAlloc: world?.passes.alloc ?? null,
      worldCount: world?.passes.count ?? null,
      worldScan: world?.passes.scan ?? null,
      worldFill: world?.passes.fill ?? null,
      // §19 3.15. `worldMerge` is an ARRAY (one per cascade below the top) and
      // `worldSeed` is null on any build without cascades — both are reached
      // through `frameOrder` by every consumer; these names exist so a kernel
      // TABLE (the chain-shape receipt, the per-kernel timing census) can still
      // print them one by one.
      worldSeed: world?.passes.seed ?? null,
      worldMergeVis: world?.passes.mergeVis ?? null,
      worldMerge: world?.passes.merge ?? [],
      worldTrace: world?.passes.trace ?? null,
      worldSh: world?.passes.sh ?? null,
      worldNee: world?.passes.nee ?? null,
      worldClear: world?.passes.clear ?? null,
      worldClearInfo: world?.passes.clearInfo ?? null,
    },
    /**
     * THE PER-FRAME CHAIN, IN ORDER, as node objects.
     *
     * ⚠ Read this rather than hand-listing `passes.*`: a hand-written list
     * cannot pick up a kernel that a later stage SPLITS IN TWO, and it fails
     * SILENTLY — the new kernel simply never runs. `probeShFilter` was exactly
     * that split (Stage 3.3), and the only reason a hand-written chain still
     * produces light is that `probeFilter` deliberately writes its raw SH into
     * both halves of `probeSh` as a fallback.
     *
     * `clearStats` and anything a consumer interleaves (an emitter term, AO)
     * are NOT here — this is the gather's own order, from the HZB to the
     * injection, and a consumer splices its own passes into a copy.
     */
    frameOrder: (useWorld ? [
      // ══ §19 STAGE 3.13 — THE WORLD PATH'S ORDER ═════════════════════════════
      //
      // ⛔ NO HZB. The screen segment is `probeTrace`'s first ray segment and
      // `probeTrace` is not built here; a depth pyramid nothing samples is
      // 0.2 ms of pure cost. §U.3's "keep the HZB contact term" is kept where it
      // still exists — GTAO, which `gi2System` splices after `resolveUpsample`.
      //
      // The four compaction kernels are ~65 k serial iterations between them and
      // are listed rather than folded because each is a different SHAPE (per
      // cell, per block, one thread, per block) and a fold would need workgroup
      // memory, which the portable envelope does not allow.
      //
      // ⚠⚠ §19 3.15 — `world.frameOrder`, NOT A HAND-LIST OF `world.passes.*`.
      // This list WAS a hand-list, and 3.15 split the lattice's chain in two
      // places at once (a seed before the compaction, `NC−1` merges between the
      // trace and the SH). A hand-list cannot pick up a split and fails
      // SILENTLY — the same failure this very object's own doc-comment warns
      // about two lines below, which had already been made here.
      ...world.frameOrder,
      resolveHalfPass, resolveUpsamplePass,
      compositePass, injectPass, imageHistoryPass,
    ] : [
      hzbBuildPass, ...hzbReducePasses, probePlacePass, rayBudgetPass, probeTracePass,
      probeFilterPass, probeShFilterPass,
      // §19 3.12: the rig's emitter NEE goes exactly where `gi2System` splices
      // the engine's — immediately before `resolveHalf`, the first kernel that
      // reads the filtered half of `probeSh`. `null` on every non-rig build,
      // filtered out below so the chain shape does not change for them.
      panelDirectPass,
      resolveHalfPass, resolveUpsamplePass,
      compositePass, injectPass,
      // §19 3.12: LAST. It reads `irradiance`/`glossy` and writes only the two
      // history textures, so a consumer that splices GTAO in after
      // `resolveUpsample` (which is what `gi2System` does) still hands this the
      // un-occluded irradiance the next frame's blend is defined against.
      imageHistoryPass,
    ]).filter(Boolean),
    /** Sum a striped counter out of a readback. */
    readStats(u32) {
      const out = {};
      for (const [k, slot] of Object.entries(STATS)) {
        let s = 0;
        for (let j = 0; j < STAT_STRIPE; j++) s += u32[slot * STAT_STRIPE + j];
        out[k] = s;
      }
      // §19 Stage 3.7's need census — four WORDS, not a stripe, and stored by
      // `rayBudget` rather than accumulated (see `STAT_RAY_BUDGET`).
      const b = STAT_RAY_BUDGET * STAT_STRIPE;
      out.matureRays = u32[b];
      out.probesFresh = u32[b + 1];
      out.probesFlag = u32[b + 2];
      out.probesMature = u32[b + 3];
      return out;
    },
    describe,
    dispose() {
      irradiance.dispose();
      glossy.dispose();
      lit.dispose();
      irradianceHalf.dispose();
      glossyHalf.dispose();
      irradianceHist.dispose();
      glossyHist.dispose();
    },
  };
  // ⭐ §19 STAGE 3.12 — THE MOVING RECEIPT NEEDS A HANDLE ON A REAL SCENE.
  //
  // `reprojDump` and `reprojBuf` already exist and are already gated on
  // `wantNoise`, but on the engine path `gi2System` builds this gather with
  // `crops: 0` and does not re-export it, so `run-gi2-motion-probe` had no way
  // to reach the one instrument that can answer 3.11a's question on Bistro
  // rather than on a Cornell box.
  //
  // ⚠ IT IS PUBLISHED ONLY WHEN A PROBE ASKED FOR THE INSTRUMENT. The same
  // flag that builds the buffers publishes the handle, so a normal editor
  // session has neither — no global, no 25 MB of receipt buffers, and no way
  // for a stale handle to keep a retired gather alive across a resize (a resize
  // rebuilds the gather, which republishes).
  if (globalThis.__gi2NoiseDump === true) globalThis.__gi2GatherProbe = api;
  return api;
}
