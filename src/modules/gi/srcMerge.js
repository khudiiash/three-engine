// SPLIT RADIANCE CASCADES — [G] THE MERGE. This is what gives GI its RANGE.
//
// Cascade N−1 → 0, Eq. 6/7. Each bin keeps its own interval and lets through
// whatever it did not block from the sparse-trilinear-interpolated, 4→1
// pre-averaged cascade above it:
//
//     L_merged = L_self + T_self · L_parent
//     T_merged = T_self · T_parent
//
// with the TOP cascade merging against the sky, because there is nothing above
// it to interpolate. `srcMath.js`'s `mergeBin` is that one line and
// `srcRef.js`'s `mergeCascades` is the whole ladder; this file is the GPU twin
// of the ladder, and `test:gi-src-merge` diffs the two.
//
// ══ WHY THIS UNIT COMES BEFORE THE SMOOTH GATHER, AND IT IS NOT ORDERING ═══
//
// §12.19.5 argued it and it is worth carrying here, next to the code, because
// the shortcut is genuinely tempting: a position-indexed sparse-trilinear
// gather over cascade 0 alone would remove the visible blockiness a unit
// earlier. It would also be SHORT-RANGE — cascade 0's interval is r₀ ≈ 1.6·s₀,
// about a metre — so the result reads as smooth ambient occlusion rather than
// as global illumination. The merge is what makes a c0 bin's answer stretch to
// the far end of cascade 3, which at `LOD0_REACH = 64` is tens of metres.
//
// ══ WHAT IT CHANGES ON SCREEN TODAY, WHICH IS MORE THAN IT LOOKS ═══════════
//
// Hit shading is still Phase 5, so every deposited `L` is zero and the only
// term that survives is transmittance. Run that through the ladder:
//
//     top:  L = 0 + T_top·sky,     T = 0
//     c2:   L = 0 + T_c2·(sky·T_top),  T = T_c2·0 = 0
//     …
//     c0:   L = sky · Π T_i,       T = 0
//
// The c0-only gather this sits behind computed `sky·T_c0` — sky visibility over
// ONE metre. After the merge it is the product of transmittance along the whole
// cascade chain, i.e. sky visibility over the whole reach. Same estimator, four
// levels of range, and that difference is the entire visible payoff of [G].
//
// ══ `srcGather.js` NEEDS NO CHANGE, AND THE REASON IS WORTH STATING ════════
//
// The gather composites `L + T·sky` per bin. After the merge that expression is
// correct in both of the cases it can now meet, which is why nothing there had
// to learn about this file:
//
//   • a fully merged bin has T = 0, so the sky term vanishes and `L` — which
//     already carries the sky down the chain — stands alone. NO DOUBLE COUNT.
//   • a bin whose parent chain broke (no corner probe existed) keeps its own
//     T, and `L_self + T_self·sky` is exactly the c0-only answer it had before.
//
// So a missing parent degrades to the previous behaviour rather than to black,
// which is R1 (an absence is an absence) falling out of the arithmetic instead
// of being coded for.
//
// ══ THE THREE STRUCTURAL DECISIONS ═════════════════════════════════════════
//
// 1. **IT MERGES IN PLACE.** Cascade c's dispatch reads cascade c+1's region of
//    `payload` — written by the PREVIOUS dispatch — and writes only its own.
//    No thread reads the region it writes, and the dispatch boundary between
//    levels is the barrier that makes the read legal. A second buffer would be
//    another 22 MB at the engine default to hold values that are dead the
//    moment the level below has consumed them.
//
// 2. **THE 8 CORNERS ARE RESOLVED ONCE PER PROBE, NOT ONCE PER BIN.** The
//    trilinear corner set is a property of the probe's POSITION, so hoisting it
//    out turns 8 hash lookups per bin into 8 per probe — a factor of `binCount`
//    (32 at c0, 2048 at c3). The corner records are indexed by BIN BLOCK rather
//    than by probe slot, which is both smaller (a cascade has fewer blocks than
//    slots) and exactly the index the merge kernel already has.
//
// 3. **THE CORNER RECORD STORES THE PARENT'S BLOCK, NOT ITS PROBE INDEX.** One
//    more dereference at resolve time, removed from the inner loop — and it
//    keeps `probeTable` out of the merge kernel entirely, which matters because
//    the portable limit is 8 storage buffers per stage and this kernel wants
//    payload + two corner buffers + stats already.
//
// ══ A STALE CORNER RECORD CANNOT BE READ, AND THAT IS AN ARGUMENT ══════════
//
// The corner pass writes records only for blocks a live probe currently holds.
// A block sitting in the free pool keeps whatever it was told last time it was
// claimed, which would be a dangling parent pointer if anything read it. Then
// nothing does: an unclaimed block took no deposits this frame, the deposit's
// clear zeroed its accumulators, and [F] therefore wrote UNKNOWN into every one
// of its bins — so the merge takes its `selfT < 0` early-out before it ever
// looks at the record. The safety comes from the frame order, not from a clear,
// and that is why the order is stated rather than assumed.
//
// docs/GI_SRC_REBUILD_PLAN.md §4.2, §12.18.4-6, §12.18.7 unit 3, §12.19.5.

import {
  atomicAdd,
  atomicStore,
  cos,
  equirectUV,
  float,
  floor,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  int,
  ivec3,
  Return,
  select,
  sin,
  uint,
  vec3,
} from "three/tsl";
import { CASCADE_COUNT, W0 } from "./srcConfig.js";
import { LOS_OCC_HI, LOS_OCC_LO, LOS_PATH_HI, LOS_PATH_LO, binDirTable, mergeLosWeight, worldKeysEnabled } from "./srcMath.js";
import {
  cellPosition,
  keyCell,
  keyWorldCell,
  keyLod,
  keySecondary,
  latticeOrigin,
  latticeOriginCell,
  packProbeKey,
  probeSpacing,
} from "./srcMathTsl.js";
import { readPayload, readPayloadT, writePayload } from "./srcDeposit.js";
import {
  FLAG_ALIVE,
  PROBE_BLOCK,
  PROBE_FLAGS,
  PROBE_KEY,
  PROBE_WORDS,
  SLOT_EMPTY,
  createProbeLookup,
} from "./srcProbes.js";

/** The trilinear corner count. Named because it is also the record stride. */
export const MERGE_CORNERS = 8;

/**
 * Corner ordering, and it must MATCH `srcMath.js`'s `trilinearCorners`.
 *
 * That function pushes with dz outermost and dx innermost, so corner k is
 * `(dx, dy, dz) = (k&1, (k>>1)&1, k>>2)`. The merge itself is order-independent
 * — it is a weighted sum — but the gate compares corner k against corner k, and
 * a silently permuted record would make that comparison meaningless while every
 * energy check still passed.
 */
const CORNER_OFFSETS = Array.from({ length: MERGE_CORNERS }, (_, k) => [
  k & 1, (k >> 1) & 1, (k >> 2) & 1,
]);

/**
 * Merge telemetry — eight words PER CASCADE.
 *
 * ⛔⛔ IT USED TO BE EIGHT WORDS TOTAL, SHARED BY EVERY [G.1] AND [G.3]
 * DISPATCH, AND THAT MADE THE HEADLINE NUMBER UNATTRIBUTABLE (2026-08-23).
 *
 * The user's Level prints `cascade merge orphaning 26% of 31713 bins` on every
 * boot against a healthy ~1%, and that 26% is a BLEND over the c0, c1 and c2
 * ladder passes — three different lattices, three different populations, three
 * different fixes. `meanCorners` had the same problem across the [G.1] passes.
 * Nobody could tell whether c0 was fine and c2 was starving, or the reverse,
 * so the defect survived every look at it.
 *
 * A cascade's slice is `MERGE_STRIDE * c`; the constants below are offsets
 * WITHIN a slice. `readStats` reports both the per-cascade rates and the
 * aggregate, and the aggregate is byte-for-byte the number the old code
 * printed — so the §12.56 watchdog signature and every recorded reading stay
 * comparable.
 */
export const MERGE_PROBES = 0;   // probes that resolved a corner set (i.e. held a block)
export const MERGE_FOUND = 1;    // parent corners found, out of 8 per probe
export const MERGE_BINS = 2;     // KNOWN self bins the merge visited
export const MERGE_MERGED = 3;   // ...of those, bins that found at least one parent
export const MERGE_ORPHAN = 4;   // ...of those, bins that found none — kept as-is
export const MERGE_OPAQUE = 5;   // merged bins whose T came out exactly 0
export const MERGE_SKY = 6;      // top-cascade bins the sky composited into
export const MERGE_LOS = 7;      // §15 U3b: parent corners the cross-wall march suppressed
/**
 * ⭐ The orphan count, split by whether it COST ANYTHING.
 *
 * `MERGE_ORPHAN_OPAQUE` — the bin's own transmittance was exactly 0, so the
 * merged branch would have written `L_self + L_parent·0` and `T = 0`: the same
 * bytes orphaning leaves. Free. `MERGE_ORPHAN_LIVE` — selfT > 0, so a parent
 * WOULD have shone through and its absence is real lost long-range light.
 * `OPAQUE + LIVE == ORPHAN` by construction, which is also the arithmetic check
 * that the split is wired correctly.
 */
export const MERGE_ORPHAN_OPAQUE = 8;
export const MERGE_ORPHAN_LIVE = 9;
/** Words per cascade slice. */
export const MERGE_STRIDE = 10;
/**
 * ⚠ KEPT AS THE STRIDE, NOT THE BUFFER SIZE. Several call sites still read
 * `MERGE_WORDS` as "the offsets go 0..MERGE_WORDS-1"; the BUFFER is
 * `MERGE_STRIDE * cascadeCount` and is sized from `store.cascadeCount` at
 * build, never from this constant.
 */
export const MERGE_WORDS = MERGE_STRIDE;

/**
 * Build the merge as a dispatch list.
 *
 * Runs AFTER `createSrcDepositFrame`'s passes — it consumes `[F]`'s resolved
 * payload and overwrites it with the merged one. Every consumer downstream (the
 * gather today, [H]'s bake next) therefore reads merged values with no flag to
 * check, which is the point of doing it in place.
 *
 * @param {object} store  from `createSrcProbeStore`
 * @param {object} bins   from `createSrcBinStore`
 * @param {object} options
 * @param {Node|number} options.spacing0  s₀
 * @param {Node} options.anchor  the lattice anchor — the SAME uniform the
 *   population used. A second anchor would place the parent lattice
 *   plausibly and wrongly, and no energy check could see it.
 * @param {Node} options.sky  vec3 uniform: the radiance the top cascade
 *   composites. Deposited nowhere else — a per-cascade sky deposit would
 *   multiply it by the cascade count (`splitDeposits`' header).
 * @param {Node} [options.camera]  world camera position. REQUIRED under
 *   world-absolute keying (S1) and unused without it: a key holds
 *   `worldCell mod 512` and the representative is resolved within ±256 cells of
 *   the viewer, so the merge cannot turn a key back into a position without it.
 * @param {Function} [options.losOccupied]  the occupancy field's one-bit
 *   `occupiedAtWorld` sharedFn — §15 U3b arms the cross-wall corner march on
 *   it (see `mergeLosWeight` in srcMath.js). Null keeps the pre-U3b graph,
 *   which is what makes the CPU-mirror diff safe by construction.
 */
export function createSrcMergeFrame(store, bins, {
  spacing0,
  anchor,
  camera = null,
  sky,
  // §16 S1 (2026-08-24): the DIRECTIONAL sky — `{ node, intensity, rotY }`,
  // the persistent env-miss bundle shape. When present, the top-cascade
  // close samples the scene's environment PER BIN DIRECTION instead of
  // compositing the flat mean; absent (every gate fixture), the flat `sky`
  // path compiles bit-identically to the pre-S1 build.
  skyEnv = null,
  w0 = W0,
  losOccupied = null,
  losSegment = null,
} = {}) {
  if (worldKeysEnabled() && !camera) {
    // Loud, at build, rather than a merge that silently interpolates over the
    // wrong lattice — see the `anchor` note above for why that class of bug is
    // invisible to every energy check this module has.
    throw new Error("createSrcMergeFrame: world-absolute keying needs `camera`");
  }
  const { probeTable } = store;
  const { payload } = bins;
  const N = store.cascadeCount ?? CASCADE_COUNT;
  const top = N - 1;
  // §15 U3b — build-time arm, same idiom as the gather's losArmed: the flag is
  // structural (it changes the WGSL), and an instance built without the
  // closure (every mirror-diff page) cannot arm regardless of the global.
  // Section 10 (2026-09-02): in the BVH-only build the cross-wall test is one
  // any-hit SEGMENT from the child probe to the parent corner (losSegment),
  // cached per corner and recomputed only when that corner's parent block or
  // the child key changes, so it costs rays only for fresh probes. It is ON
  // by default there (the point-in-solid march stays the opt-in field arm).
  // Measured need: with no test at all, an indoor child merged an outdoor
  // parent through the wall and the top cascade composited the SKY into it
  // (blue patches with the sky on, black with it off).
  const losSegmentArmed = !!losSegment && globalThis.__giMergeLos !== false;
  const losArmed = losSegmentArmed || (mergeLosWeight() && !!losOccupied);
  if (losSegmentArmed) console.info("[gi] merge: cross-wall LOS validity ARMED (BVH segment, cached per corner)");
  else if (losArmed) console.info("[gi] merge: cross-wall LOS validity ARMED (U3b)");

  // ── the corner records, indexed by BIN BLOCK ──────────────────────────────
  // Only cascades 0..N−2 have a parent to interpolate over, so the top cascade
  // gets no record at all rather than an empty one.
  const cornerCascades = [];
  let cornerTotal = 0;
  for (let c = 0; c < top; c++) {
    cornerCascades.push({ cascade: c, base: cornerTotal });
    cornerTotal += store.cascades[c].blockCapacity * MERGE_CORNERS;
  }
  const cornerSize = Math.max(1, cornerTotal);
  // Seeded EMPTY rather than zero, for the same reason `PROBE_BLOCK` is: block 0
  // is a real block somebody owns, so a zero-filled record would make every
  // never-written probe look like it interpolates over block 0 eight times.
  const cornerBlock = instancedArray(new Uint32Array(cornerSize).fill(SLOT_EMPTY), "uint");
  const cornerWeight = instancedArray(new Float32Array(cornerSize), "float");
  // Per-corner cached visibility (-1 = not computed) and the child key it was
  // computed for, so a reused slot never inherits a previous owner's answer.
  // ONE buffer (the merge kernels sit at the 8-storage-buffer portable
  // limit): two words per corner — [0] the child key the answer was computed
  // for, [1] visibility as 0 / 1 / 0xffffffff (= not computed).
  const cornerLosRec = losSegmentArmed ? instancedArray(new Uint32Array(cornerSize * 2).fill(0xffffffff), "uint") : null;
  // One slice per cascade — see MERGE_STRIDE's header for why the shared
  // buffer made the headline unattributable.
  const statWords = MERGE_STRIDE * N;
  const stats = instancedArray(new Uint32Array(statWords), "uint").toAtomic();
  /** Offset of cascade `c`'s word `w`. JS-side constant — folded at build. */
  const sw = (c, w) => uint(c * MERGE_STRIDE + w);

  const passes = [];

  // ── clear the telemetry ───────────────────────────────────────────────────
  // `atomicStore`, not `.assign` — WGSL will not implicitly convert `u32` to
  // `atomic<u32>` and the module fails to compile, which surfaces as a
  // validation error rather than as wrong numbers. The first version of this
  // pass got it wrong and the counters still LOOKED right, because a fresh
  // buffer is already zero and this gate reads them after a single frame; the
  // bug's real shape is telemetry that doubles on frame two. Same trap
  // `srcDeposit.js` records from the other side (`atomicLoad` on a read).
  passes.push(Fn(() => {
    const i = instanceIndex.toVar();
    If(i.lessThan(uint(statWords)), () => {
      atomicStore(stats.element(i), uint(0));
    });
  })().compute(statWords));

  // ── [G.1] resolve each probe's 8 parent corners ───────────────────────────
  //
  // Reads nothing the merge writes, so all N−1 of these can run before any
  // merging starts — they depend only on this frame's probe population.
  for (let c = 0; c < top; c++) {
    const info = store.cascades[c];
    const recordBase = cornerCascades[c].base;
    // The PARENT cascade's map. Lookup only: the merge must never create a
    // probe, because a probe created here would have no bins this frame and
    // would have consumed a block that a real receiver needed.
    const lookup = createProbeLookup(store, c + 1);

    passes.push(Fn(() => {
      const i = instanceIndex.toVar();
      const p = uint(info.probeBase).add(i).toVar();
      const w = p.mul(uint(PROBE_WORDS)).toVar();
      If(probeTable.element(w.add(uint(PROBE_FLAGS))).bitAnd(uint(FLAG_ALIVE)).equal(uint(0)),
        () => { Return(); });
      const block = probeTable.element(w.add(uint(PROBE_BLOCK))).toVar();
      // No block means no bins, which means nothing to merge INTO. The record
      // is indexed by block, so there is not even an address to write to.
      If(block.equal(uint(SLOT_EMPTY)), () => { Return(); });
      atomicAdd(stats.element(sw(c, MERGE_PROBES)), uint(1));

      // WORLD POSITION FROM THE KEY, never from a stored position — same rule
      // the population ladder runs under (`childPosition` in srcProbes). A
      // cached position is a second source of truth that a re-anchor can
      // desynchronize from the key, and the merge is precisely where that
      // desynchronization would put light in the wrong place.
      const key = probeTable.element(w.add(uint(PROBE_KEY))).toVar();
      const lodI = keyLod(key).toVar();
      const lod = float(lodI).toVar();
      const secondary = keySecondary(key).toVar();
      const s = probeSpacing(c, lod, spacing0).toVar();
      // S1: under world-absolute keying the key holds a residue, so the world
      // cell is resolved against the CAMERA (srcMathTsl.keyWorldCell) rather
      // than added to a lattice origin. Same rule, one call.
      const position = (worldKeysEnabled()
        ? vec3(keyWorldCell(key, camera, s)).mul(s)
        : cellPosition(keyCell(key), latticeOrigin(anchor, s), s)).toVar();

      // THE PARENT LATTICE: same LOD, next cascade — so exactly 2× the spacing.
      // The ladder climbs in cascade index and NEVER in LOD (§4.5, no cross-LOD
      // interaction anywhere), which is why `lodI` is carried through unchanged
      // into the parent key below.
      const sp = probeSpacing(c + 1, lod, spacing0).toVar();
      const originP = latticeOrigin(anchor, sp).toVar();
      const f = position.sub(originP).div(sp).toVar();
      const cell0 = floor(f).toVar();
      const t = f.sub(cell0).toVar();
      // Same coordinate-system shift the screen gather documents: the
      // interpolation stays local to `originP`, the KEY goes world-absolute.
      const parentShift = worldKeysEnabled() ? latticeOriginCell(anchor, sp).toVar() : null;
      const baseCell = ivec3(int(cell0.x), int(cell0.y), int(cell0.z)).toVar();
      if (parentShift) baseCell.assign(baseCell.add(parentShift));
      const record = uint(recordBase).add(block.mul(uint(MERGE_CORNERS))).toVar();

      // ── §15 U3b: THE PARENT MUST SEE THE CHILD ──────────────────────────
      //
      // A parent corner across an interior wall carries the FAR room's
      // radiance; interpolating it into this probe's bins is how the
      // through-wall leak gets into the field's own tiles (the los-gate's
      // bimodality finding — the leak the gather-side march cannot reach).
      // March child probe → corner through the one-bit occupancy field and
      // suppress blocked corners' trilinear weight. Sample fractions stay off
      // both ends so neither probe is convicted by its own voxel, and the
      // count grows with the cascade because the segment does (parent spacing
      // doubles per level; a 0.2 m wall + the conservative voxel bulge must
      // stay denser than the sample stride).
      //
      // The floor keeps R1: [G.3] divides by the weight FOUND, so a probe
      // whose every corner is blocked renormalizes to the blocked mean — the
      // pre-U3b answer — instead of orphaning (which would composite T·sky
      // through walls) or darkening. One visible corner outvotes blocked
      // ones 1000:1, which is the whole fix.
      const losFractions = losArmed
        ? (() => {
            const n = c === 0 ? 4 : c === 1 ? 6 : 8;
            return Array.from({ length: n }, (_, i) => 0.1 + (0.8 * (i + 0.5)) / n);
          })()
        : null;

      for (let k = 0; k < MERGE_CORNERS; k++) {
        const [dx, dy, dz] = CORNER_OFFSETS[k];
        const weight = (dx ? t.x : float(1).sub(t.x))
          .mul(dy ? t.y : float(1).sub(t.y))
          .mul(dz ? t.z : float(1).sub(t.z))
          .toVar();
        // `packProbeKey` returns KEY_EMPTY for a cell outside the ±256 key
        // window, and the WGSL find returns "absent" for key 0 by its first
        // line — so an out-of-window corner is a missing corner, with no extra
        // guard and no chance of matching some other probe's key.
        const parent = lookup(
          packProbeKey(lodI, secondary, baseCell.add(ivec3(dx, dy, dz))),
        ).toVar();
        const parentBlock = uint(SLOT_EMPTY).toVar();
        If(parent.notEqual(uint(SLOT_EMPTY)), () => {
          // A parent that EXISTS but holds no block is treated as absent, and
          // that is the right reading rather than a corner case: it has no bins,
          // so it has no radiance to contribute. It is also the one place this
          // kernel can diverge from `srcRef.js`, whose CPU probes always have
          // bins — `NOBLOCK` in the probe telemetry is the number that says
          // whether the divergence is live, and on a healthy pool it is zero.
          parentBlock.assign(
            probeTable.element(parent.mul(uint(PROBE_WORDS)).add(uint(PROBE_BLOCK))),
          );
        });
        If(parentBlock.notEqual(uint(SLOT_EMPTY)), () => {
          atomicAdd(stats.element(sw(c, MERGE_FOUND)), uint(1));
        });
        if (losSegmentArmed) {
          // One any-hit segment child -> corner, cached: a corner whose parent
          // block and child key match the cache reuses its answer.
          const cornerPos = originP.add(cell0.add(vec3(dx, dy, dz)).mul(sp)).toVar();
          const slotIdx = record.add(uint(k)).toVar();
          const recIdx = slotIdx.mul(uint(2)).toVar();
          const prevBlock = cornerBlock.element(slotIdx).toVar();
          const cachedKey = cornerLosRec.element(recIdx).toVar();
          const cachedVis = cornerLosRec.element(recIdx.add(uint(1))).toVar();
          const vis = float(1).toVar();
          If(parentBlock.notEqual(uint(SLOT_EMPTY)), () => {
            If(cachedVis.equal(uint(0xffffffff)).or(prevBlock.notEqual(parentBlock)).or(cachedKey.notEqual(key)), () => {
              vis.assign(float(losSegment(position, cornerPos)));
              cornerLosRec.element(recIdx).assign(key);
              cornerLosRec.element(recIdx.add(uint(1))).assign(select(vis.greaterThan(0.5), uint(1), uint(0)));
            }).Else(() => {
              vis.assign(select(cachedVis.equal(uint(1)), float(1), float(0)));
            });
            If(vis.lessThan(0.5), () => {
              atomicAdd(stats.element(sw(c, MERGE_LOS)), uint(1));
            });
            weight.mulAssign(vis.max(1e-3));
          });
        } else if (losArmed) {
          const cornerPos = originP.add(cell0.add(vec3(dx, dy, dz)).mul(sp)).toVar();
          const seg = cornerPos.sub(position).toVar();
          // Same two shoulders as the screen gather (srcMath's LOS_OCC_* and
          // LOS_PATH_*) — if the two disagreed, the field's own tiles and the
          // screen's read of them would disagree about which side of a wall a
          // probe sits on, which is the exact confusion this unit removes.
          const blocked = float(0).toVar();
          for (const tf of losFractions) {
            const x = position.add(seg.mul(tf));
            const t = float(losOccupied(x)).sub(LOS_OCC_LO)
              .div(LOS_OCC_HI - LOS_OCC_LO).clamp(0, 1).toVar();
            blocked.addAssign(t.mul(t).mul(float(3).sub(t.mul(2))));
          }
          const bp = blocked.div(losFractions.length).sub(LOS_PATH_LO)
            .div(LOS_PATH_HI - LOS_PATH_LO).clamp(0, 1).toVar();
          const vis = float(1).sub(bp.mul(bp).mul(float(3).sub(bp.mul(2)))).toVar();
          If(vis.lessThan(0.5), () => {
            atomicAdd(stats.element(sw(c, MERGE_LOS)), uint(1));
          });
          weight.mulAssign(vis.max(1e-3));
        }
        cornerBlock.element(record.add(uint(k))).assign(parentBlock);
        cornerWeight.element(record.add(uint(k))).assign(weight);
      }
    })().compute(info.probeCapacity));
  }

  // ── [G.2] the top cascade composites the sky ──────────────────────────────
  //
  // Dispatched over the top cascade's whole bin region, claimed blocks and
  // free ones alike: a free block's bins are all UNKNOWN (see the header's
  // staleness argument), so the early-out below covers them and the kernel
  // needs no block→probe map.
  //
  // TRANSMITTANCE IS CONSUMED HERE, not left standing. Nothing above the last
  // cascade can still occlude, so a non-zero T at the top would let every level
  // below composite the sky a second time — the mirror sets it to 0 for exactly
  // this reason and says so.
  {
    const info = bins.cascades[top];
    // §16 S1 — the top cascade's bin-direction LUT (Morton order, the
    // storage order — binDirTable's header). Built only when the
    // directional sky is armed, so an unarmed build binds nothing new.
    const wTop = Math.round(Math.sqrt(info.bins / 2));
    const skyDirTable = skyEnv ? instancedArray(binDirTable(wTop), "vec4") : null;
    passes.push(Fn(() => {
      const i = instanceIndex.toVar();
      const bin = uint(info.binBase).add(i).toVar();
      const T = readPayloadT(payload, bin);
      If(T.lessThan(0), () => { Return(); });
      const S = vec3(sky).toVar();
      // §16 S1 — DIRECTIONAL SKY (2026-08-24, the user's "sky hdri acts
      // like ambient" report). The flat `sky` is sceneSkyRadiance's NEUTRAL
      // GREY of the env intensity — the HDRI's chroma, luminance
      // distribution and directionality never reached the transport, so an
      // escaping ray brought back the same colour in every direction =
      // ambient. Now each bin composites the environment sampled at ITS OWN
      // direction (same rotation math as the env-on-miss/capture read).
      // Occlusion is untouched — T is still the ladder's transmittance.
      if (skyEnv) {
        const m = i.mod(uint(info.bins)).toVar();
        const d = vec3(skyDirTable.element(m).xyz).toVar();
        const cr = cos(skyEnv.rotY).toVar();
        const sr = sin(skyEnv.rotY).toVar();
        const rd = vec3(
          d.x.mul(cr).add(d.z.mul(sr)),
          d.y,
          d.z.mul(cr).sub(d.x.mul(sr)),
        ).toVar();
        S.assign(vec3(skyEnv.node.sample(equirectUV(rd)).level(0).xyz).mul(skyEnv.intensity));
      }
      const self = readPayload(payload, bin);
      writePayload(payload, bin, self.L.add(S.mul(T)), float(0));
      atomicAdd(stats.element(sw(top, MERGE_SKY)), uint(1));
    })().compute(info.bins * info.blockCapacity));
  }

  // ── [G.3] the ladder, cascade N−2 → 0 ─────────────────────────────────────
  for (let c = top - 1; c >= 0; c--) {
    const info = bins.cascades[c];
    const parentInfo = bins.cascades[c + 1];
    const nBins = info.bins;
    const recordBase = cornerCascades[c].base;

    passes.push(Fn(() => {
      // One thread per (block, bin). `nBins` is a power of two at every
      // cascade (2·w₀²·4^c), so both of these are shifts.
      const i = instanceIndex.toVar();
      const block = i.div(uint(nBins)).toVar();
      const m = i.mod(uint(nBins)).toVar();
      // Dead block (srcProbes' live word): unowned, unread — skip before the
      // payload fetch. Released-this-frame blocks resolved to UNKNOWN and
      // fall out on `selfT < 0` below as they always did.
      if (Number.isInteger(store?.blockLiveBase) && store?.freeStack) {
        const live = store.freeStack.element(uint(store.blockLiveBase + info.blockBase).add(block));
        If(live.equal(uint(0)), () => { Return(); });
      }
      const selfBin = uint(info.binBase).add(block.mul(uint(nBins))).add(m).toVar();

      // AN UNKNOWN SELF BIN STAYS UNKNOWN. It is not "no light" — no ray
      // sampled this direction, so there is nothing for the parent to shine
      // through. Merging a parent into it would invent an interval estimate
      // this probe never made, and at 0.78 rays per bin (§12.13.4) that
      // invention would be most of the buffer.
      //
      // ⭐⭐ §11.20 — AND REFUSING TO MERGE IS ALSO AN INVENTION, A WORSE ONE
      // (2026-09-03, "almost no colour bleed" on their Cornell).
      //
      // The paragraph above is right that a parent merged into an unsampled
      // bin invents `T_self = 1`. What it misses is that the bin does not then
      // stay out of the answer: `srcTiles`' bake EXCLUDES unknown bins and
      // renormalizes over the known ones (`E = π·ΣL·W/ΣW`), which hands the
      // unsampled direction the MEAN OF THE SAMPLED ONES. So the choice was
      // never "invent vs abstain", it was "the parent's own radiance in this
      // direction" vs "the average of the other directions".
      //
      // And the unknown bins are NOT missing at random. Rays are born at
      // gbuffer pixels and distributed by cosine, so a texel's grazing
      // directions are the least visited — and a grazing direction from a
      // ceiling or floor texel is exactly where the coloured WALLS are. The
      // measured consequence on their Cornell (probe:gi-cornell-ref, one pose,
      // 30 s settle): meanKnownBins 11.2 of a 20.1-bin lobe (55 %), whites at
      // 0.17 saturation against the path tracer's 0.60 — the room's red/green
      // equilibrium tint replaced by the near field's white average. It is a
      // BIAS, not a budget: a three-minute settle reads 0.170, and stride 1
      // with the per-probe cap off (153 k rays a frame, 10× the default) reads
      // 0.173.
      //
      // `__giMergeFillUnknown = true` fills an unsampled bin from the parent
      // as if its own near interval were empty — `L_self = 0, T_self = 1` —
      // which is the honest reading of "no evidence of a near occluder here".
      // OPT-IN while it is measured: the risk is the mirror image of the
      // paragraph above (light leaking through near geometry no ray probed),
      // and this file's own rule is that a fill of last resort must earn its
      // default against a fixture.
      const selfT = readPayloadT(payload, selfBin);
      const fillUnknown = globalThis.__giMergeFillUnknown === true;
      const unknown = selfT.lessThan(0).toVar();
      if (fillUnknown) {
        atomicAdd(stats.element(sw(c, MERGE_BINS)), uint(1));
      } else {
        If(unknown, () => { Return(); });
        atomicAdd(stats.element(sw(c, MERGE_BINS)), uint(1));
      }
      // The interval this bin contributes of its own: its measurement, or the
      // empty-near-segment stand-in when the fill is armed.
      const ownT = fillUnknown ? select(unknown, float(1), selfT).toVar() : selfT;

      const record = uint(recordBase).add(block.mul(uint(MERGE_CORNERS))).toVar();
      const acc = vec3(0).toVar();
      const accT = float(0).toVar();
      const wsum = float(0).toVar();

      for (let k = 0; k < MERGE_CORNERS; k++) {
        const parentBlock = cornerBlock.element(record.add(uint(k))).toVar();
        const weight = cornerWeight.element(record.add(uint(k))).toVar();
        If(parentBlock.notEqual(uint(SLOT_EMPTY)).and(weight.greaterThan(0)), () => {
          // ── THE 4→1 PRE-AVERAGE, AND ITS DIRECTION ────────────────────────
          //
          // Bins get FINER as the cascade index rises (|D_i| = 2·w₀²·4^i), so
          // the level ABOVE has four bins for every one of ours and what this
          // level consumes is their average. Morton order is what makes those
          // four CONTIGUOUS — they are exactly `4m … 4m+3`, proved in the
          // Phase-0 suite's Morton-contiguity arm — so this is one aligned run
          // of four rather than four strided fetches.
          //
          // Getting it backwards (halving our own index to address the level
          // above) reads a bin pointing somewhere else entirely. It costs no
          // energy and throws no error; it delivers the wrong DIRECTION's
          // radiance, which reads as a hue rotation that survives every energy
          // check. The gate's pre-average arm exists for exactly this.
          const pBase = uint(parentInfo.binBase)
            .add(parentBlock.mul(uint(parentInfo.bins)))
            .add(m.mul(uint(4)))
            .toVar();
          const pL = vec3(0).toVar();
          const pT = float(0).toVar();
          const known = float(0).toVar();
          for (let j = 0; j < 4; j++) {
            const parent = readPayload(payload, pBase.add(uint(j)));
            // UNKNOWN CHILDREN ARE SKIPPED and the average renormalizes over
            // what was found — the same "rejection weights are epsilons, never
            // zeros" rule the sparse gather below runs under. All four unknown
            // makes the whole corner absent, not black.
            If(parent.T.greaterThanEqual(0), () => {
              pL.addAssign(parent.L);
              pT.addAssign(parent.T);
              known.addAssign(1);
            });
          }
          If(known.greaterThan(0), () => {
            const inv = float(1).div(known).toVar();
            acc.addAssign(pL.mul(inv).mul(weight));
            accT.addAssign(pT.mul(inv).mul(weight));
            wsum.addAssign(weight);
          });
        });
      }

      // ── the renormalized sparse gather ──────────────────────────────────
      // Sum what exists times its weight, divide by the weight FOUND. A missing
      // corner must not be spent as a dark vote (R1); dividing by the full
      // weight instead would dim every probe near the edge of the parent
      // population, which is a cliff exactly where the population is thinnest.
      If(wsum.greaterThan(0), () => {
        const invW = float(1).div(wsum).toVar();
        const parentL = acc.mul(invW).toVar();
        const parentT = accT.mul(invW).toVar();
        const ownL = fillUnknown
          ? select(unknown, vec3(0), readPayload(payload, selfBin).L).toVar()
          : readPayload(payload, selfBin).L;
        const outL = vec3(ownL).add(parentL.mul(ownT)).toVar();
        const outT = ownT.mul(parentT).toVar();
        writePayload(payload, selfBin, outL, outT);
        atomicAdd(stats.element(sw(c, MERGE_MERGED)), uint(1));
        If(outT.equal(0), () => { atomicAdd(stats.element(sw(c, MERGE_OPAQUE)), uint(1)); });
      }).Else(() => {
        // NO PARENT CONTRIBUTED. The bin keeps its own interval and stays
        // transparent above it — NOT a black vote — so temporal accumulation
        // can fill it in on a later frame and `srcGather`'s `L + T·sky` still
        // gives it the c0-only answer meanwhile. A fixed-radius fallback here
        // is precisely the cliff R1 forbids.
        atomicAdd(stats.element(sw(c, MERGE_ORPHAN)), uint(1));
        // ⭐⭐ AND SPLIT IT BY WHETHER IT COST A PHOTON (2026-08-23).
        //
        // The headline "26% orphaning" says nothing about lost light on its own,
        // because the merged branch above computes `L_self + L_parent·selfT`
        // and `T_self·parentT`. At **selfT == 0** those are `L_self` and `0` —
        // byte-identical to what orphaning leaves behind. An opaque bin's own
        // interval already blocked everything, so there is nothing for a parent
        // to shine through and NO parent could have changed the answer.
        //
        // That is not a corner case here: an orphan means no corner had a KNOWN
        // parent bin in this direction, and the most common reason for a parent
        // bin to be unknown is that no ray in that direction ever reached the
        // parent's interval — i.e. it was stopped inside this bin's own, which
        // is precisely the selfT == 0 case. So the two counters are expected to
        // be strongly correlated, and the LIVE one is the only one that can
        // cost the user visible long-range light.
        //
        // Redirects an atomic that was already being issued — no new atomics,
        // no new reads, zero frame cost. Nothing should be BUILT on the orphan
        // rate until this readout says how much of it is live.
        If(selfT.equal(0), () => {
          atomicAdd(stats.element(sw(c, MERGE_ORPHAN_OPAQUE)), uint(1));
        }).Else(() => {
          atomicAdd(stats.element(sw(c, MERGE_ORPHAN_LIVE)), uint(1));
        });
      });
    })().compute(info.blockCapacity * nBins));
  }

  return {
    passes,
    cornerBlock,
    cornerWeight,
    cornerCascades,
    stats,
    /**
     * GPU-only after the first bind; `detachCpuMirror` drops the JS twin three
     * already copied into the GPU buffer. Nothing here is ever written CPU-side
     * again (readbacks go through `getArrayBufferAsync`, which sizes itself
     * from `bufferGPU.size`).
     */
    cpuMirrors: [cornerBlock, cornerWeight, stats].map((n) => n?.value).filter(Boolean),
    bytes: (cornerSize * 2 + statWords) * 4,
    w0,
    cascadeCount: N,

    /**
     * One frame's merge telemetry, PER CASCADE and aggregated.
     *
     * `orphanRate` is the one to watch: the fraction of known bins whose parent
     * lattice had no probe at all, i.e. how much of the frame is getting the
     * short-interval answer with the long-range cascades missing.
     *
     * ⭐ READ `perCascade` FIRST. The aggregate is a bin-count-weighted blend of
     * three lattices, and c0 has ~64× the bins of c2, so a catastrophic c2 can
     * hide inside a healthy-looking total and vice versa. `cascade[c].orphanRate`
     * is the number that names the level; `orphanRate` is kept only so the
     * §12.56 watchdog signature and every historical reading stay comparable.
     */
    async readStats(renderer) {
      const allocated = !!renderer?.backend?.get?.(stats.value)?.buffer;
      if (!allocated) return { dispatched: false, bins: 0, merged: 0, perCascade: [] };
      const v = new Uint32Array(await renderer.getArrayBufferAsync(stats.value));
      const at = (c, w) => v[c * MERGE_STRIDE + w] >>> 0;
      const perCascade = [];
      let probes = 0, visited = 0, merged = 0, orphans = 0, opaque = 0, sky = 0, los = 0, found = 0;
      let orphanLive = 0, orphanOpaque = 0;
      for (let c = 0; c < N; c++) {
        const p = at(c, MERGE_PROBES);
        const b = at(c, MERGE_BINS);
        const mg = at(c, MERGE_MERGED);
        const or = at(c, MERGE_ORPHAN);
        const fd = at(c, MERGE_FOUND);
        probes += p; visited += b; merged += mg; orphans += or; found += fd;
        opaque += at(c, MERGE_OPAQUE); sky += at(c, MERGE_SKY); los += at(c, MERGE_LOS);
        orphanLive += at(c, MERGE_ORPHAN_LIVE); orphanOpaque += at(c, MERGE_ORPHAN_OPAQUE);
        perCascade.push({
          cascade: c,
          probes: p,
          bins: b,
          merged: mg,
          orphans: or,
          // The two numbers that separate "no parent existed" from "the parent
          // existed and had nothing to say": orphanRate counts bins that found
          // NO corner at all, meanCorners counts corners found per probe. A
          // high orphanRate with a high meanCorners means the population is
          // fine and the parents' BINS are unknown — a completely different fix.
          orphanRate: b > 0 ? or / b : 0,
          // ⭐ Of those orphans, how many COST a photon. See MERGE_ORPHAN_LIVE:
          // an opaque orphan (selfT == 0) is byte-identical to a merge, so only
          // `orphanLiveRate` can explain missing long-range light.
          orphanOpaque: at(c, MERGE_ORPHAN_OPAQUE),
          orphanLive: at(c, MERGE_ORPHAN_LIVE),
          orphanLiveRate: b > 0 ? at(c, MERGE_ORPHAN_LIVE) / b : 0,
          meanCorners: p > 0 ? fd / p : 0,
          sky: at(c, MERGE_SKY),
          losSuppressed: at(c, MERGE_LOS),
        });
      }
      return {
        dispatched: true,
        perCascade,
        probes,
        // Mean parent corners found per probe, out of 8. Below ~4 means the
        // parent cascade is sparser than the trilinear stencil wants, and the
        // renormalization is carrying the result.
        meanCorners: probes > 0 ? found / probes : 0,
        bins: visited,
        merged,
        orphans,
        opaque,
        sky,
        // §15 U3b: corners the cross-wall march suppressed. Nonzero says the
        // march is armed AND finding walls; the RATE (per resolved corner
        // set) is scene-shaped — a one-room rig reads ~0, the user's Level
        // reads whatever fraction of parent cells straddle its walls.
        losSuppressed: los,
        losRate: probes > 0 ? los / (probes * MERGE_CORNERS) : 0,
        orphanRate: visited > 0 ? orphans / visited : 0,
        // ⭐ THE NUMBER THAT MATTERS. `orphanRate` counts bins that found no
        // parent; this counts the ones where that absence actually changed the
        // answer. See MERGE_ORPHAN_LIVE.
        orphanLive,
        orphanOpaque,
        orphanLiveRate: visited > 0 ? orphanLive / visited : 0,
        // Merged bins that reached T = 0, i.e. whose parent chain resolved all
        // the way to the sky. With hit shading absent this is also the fraction
        // of the frame that gets the FULL-RANGE answer rather than a partial
        // one, so it is the number that says the ladder is connected.
        resolvedRate: merged > 0 ? opaque / merged : 0,
      };
    },

    dispose() {
      for (const b of [cornerBlock, cornerWeight, stats]) b?.value?.dispose?.();
    },
  };
}

/** The per-frame merge line, for the telemetry log. */
export function formatSrcMerge(m) {
  if (!m?.dispatched) return "";
  // Per-cascade breakdown appended: the aggregate is bin-count-weighted and c0
  // has ~64× the bins of c2, so the total cannot name the level that is
  // starving. Only cascades that actually ran a ladder pass (0..N−2) are
  // printed — the top cascade merges against the sky and can never orphan.
  const by = (m.perCascade ?? [])
    .filter((c) => c.bins > 0)
    .map((c) => `c${c.cascade} ${(c.orphanRate * 100).toFixed(0)}%(${(c.orphanLiveRate * 100).toFixed(0)}live)/${c.meanCorners.toFixed(1)}`)
    .join(" ");
  return `merge ${m.merged}/${m.bins} bins (${(m.resolvedRate * 100).toFixed(0)}% to sky, ` +
    `${(m.orphanRate * 100).toFixed(1)}% orphan (${((m.orphanLiveRate ?? 0) * 100).toFixed(1)}% LIVE — the rest cost nothing, selfT was 0), ` +
    `${m.meanCorners.toFixed(1)}/8 corners` +
    (m.losSuppressed > 0 ? `, ${(m.losRate * 100).toFixed(1)}% los-cut` : "") + `)` +
    (by ? ` — orphan/corners by cascade: ${by}` : "");
}
