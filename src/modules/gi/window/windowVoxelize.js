// GI2 — THE BUDGETED (brick, triangle) VOXELIZER (plan §5 Stage 2.3, audits §K.3)
//
// Fills the window store's `occ` / `face` / `pal` / `brickMask` from a packed
// world-space triangle soup at a FIXED cost per frame. Seven dispatches do it —
// `reset` ×2, `dirtyList` ×3 (count, prefix, scatter), `binPairs`, `voxelize`,
// `finishBricks` — and every size in their WGSL is a tier constant, so the
// shaders are scene-independent and cache-stable exactly as `windowStore.js`
// and `windowTrace.js` are. Scene numbers live in uniforms or in buffer
// CONTENTS, never in the kernel.
//
// ══ WHY THE WORK UNIT IS A PAIR AND THE BUDGET IS PAIRS ══════════════════════
//
// A brick is not a unit of cost: a 16 m L4 brick in Bistro overlaps thousands
// of triangles and a 1 m L0 brick in open air overlaps none. Budgeting BRICKS
// per frame therefore budgets nothing. `binPairs` converts bricks into (brick,
// triangle) pairs — the actual SAT work items — and the per-frame budget counts
// THOSE. A brick whose pairs do not fit stays DIRTY and is retried next frame,
// which is the whole overflow story and the only reason the cost per frame stays
// flat when the camera teleports into a dense street.
//
// ══ THE PER-BYTE ATOMIC PROBLEM, AND THE DECISION ════════════════════════════
//
// `occ` is a bitfield: `atomicOr` on the containing word is per-bit exact, and
// bits never interact. `face` is a BYTE per voxel, four to a word, and
// `atomicOr` is still exact — OR is bitwise, so lane 0's bits can never reach
// lane 3.
//
// `pal` is a byte per voxel and its merge is MAX, and **max of packed words is
// NOT per-byte max**. Concretely: a word holding lane3 = 0xFF and the rest 0 is
// 0xFF000000; a thread writing pal 5 into lane 0 issues
// `atomicMax(word, 0x00000005)`; 0xFF000000 > 5, the word does not change, and
// lane 0 keeps 0 instead of 5. The same argument kills `atomicMin` (a packed
// comparison is decided by the most significant DIFFERING byte, never by the
// lane you care about), and it kills the "put the identity in the other lanes"
// dodge for the same reason. `atomicAnd` with a byte mask IS per-byte — but AND
// is not MAX: 3 AND 5 is 1, an index no triangle carried.
//
// WGSL's answer is `atomicCompareExchangeWeak`. three's TSL (0.185) does not
// expose it — `AtomicFunctionNode` enumerates load/store/add/sub/max/min/and/
// or/xor and nothing else, and its generator emits a two-argument call — so a
// CAS would need a hand-written WGSL escape hatch inside the one kernel whose
// entire point is portability.
//
// SO: **one u32 per voxel of SCRATCH, `atomicMax` there (a full word per voxel
// makes max trivially per-byte correct), packed into the byte lanes by
// `finishBricks`.** The scratch is bounded — `MAX_BUILD` bricks × 64 voxels,
// 1 MB at ultra — because only bricks ACCEPTED by `binPairs` this frame need
// one, and a brick's own dirty-list index IS its slot. The pack is free: a
// brick's 16 `pal` words are four x-consecutive voxels INSIDE the brick (see
// `windowStore`'s scroll note), so the brick owns them outright and
// `finishBricks` plain-STORES them — no read, no merge, no atomic.
//
// The control arm is a uniform (`palMode`), so `probe:gi2-voxelize` runs the
// naive packed `atomicMax` on the same triangles through the same kernel and
// COUNTS the corrupted bytes instead of taking the paragraph above on trust.
//
// ══ WHY THE RESERVE IS ALL-OR-NOTHING ════════════════════════════════════════
//
// `binPairs` walks a brick's candidate triangles TWICE — once to count, once to
// write — and reserves the exact count with one `atomicAdd`. Appending each
// pair with its own `atomicAdd` and letting a brick be half-done is one walk
// cheaper, and the OCC bits would survive it (voxelization is idempotent); the
// PALETTE would not, because a half-filled scratch slot is packed as if it were
// the whole brick and the missing half lands as 255. All-or-nothing also makes
// `pairsNeeded` an exact receipt rather than an estimate, which is the number
// the overflow gate reads.
//
// ══ WHY A BRICK IS CLEARED AT ACCEPTANCE, NOT ONLY AT SCROLL ═════════════════
//
// `windowStore`'s `scroll` clears a brick when its slot is RE-POINTED. That
// covers the camera walking and nothing else: `markAllDirty()` (scene load,
// geometry edit) re-voxelizes bricks whose slot did NOT change, and an
// `atomicOr` onto stale bits would keep deleted geometry alive forever. So
// `binPairs` clears the 16 occ nibbles, the 16 face words and the brickMask bit
// of every brick it ACCEPTS — and ONLY of those, so an overflowed brick keeps
// last frame's content and never blinks. Clear, voxelize and finish are three
// dispatches of the SAME frame, so nothing outside the voxelizer ever observes
// the cleared state; `brickMask` is re-set at the end for the same reason.
//
// ══ 2.5 §1 — THE PER-LEVEL CULL, AND WHY IT IS NOT A DROP ════════════════════
//
// Stage 2.3's own receipt named the defect: the COARSEST level covers the whole
// scene, sees all 3 M triangles, and therefore finishes LAST — the exact
// inverse of §K.3's "coarse levels first at boot, the whole window has
// occupancy within frames". At L4 a 16 m brick overlaps ~64 of the soup's 4 m
// cells, essentially every triangle in them passes the AABB test, and the brick
// asks for tens of thousands of pairs. The budget then spreads one level's work
// over dozens of frames.
//
// A triangle whose largest AABB extent is under a QUARTER of the cell cannot
// place a face bit reliably at that level anyway: its whole span is one voxel
// (plus the conservative half-cell skirt), and 13 separating axes are being run
// to answer a question a point test answers. But DROPPING those triangles is
// wrong in the one case that matters — foliage, trim, railings, cables are made
// of exactly such triangles, and at a coarse level they are the ONLY thing
// there. Drop them and a tree becomes a hole in the far field.
//
// So sub-voxel triangles are ROUTED, not dropped: `binPairs` marks the voxel
// containing the triangle's CENTROID occupied with ALL SIX face bits — a "dust"
// voxel — inline, during the walk it was already paying, with no SAT, no pair,
// and no budget. Dust is aggregate by construction: a hundred leaf triangles in
// one coarse voxel collapse to one `atomicOr`, which is what "occlude in
// aggregate" means. All six bits because a dust voxel stands for a patch of
// unknown orientation; the alternative (the triangle's own normal) would let a
// ray through a canopy because one leaf happened to lie edge-on.
//
// The centroid — not the AABB — is what de-duplicates it: a triangle's centroid
// lies in exactly ONE brick, so exactly one brick writes it, and no brick has
// to consult the `own` cell rule the pair path needs.
//
// THE PALETTE IS THE AWKWARD HALF. `binPairs` cannot read `triPal`: it already
// binds work + counters + window + cellRange + cellTris + tris = 6, the whole
// portable envelope (PLAN §4.6), and a seventh binding is a real portability
// loss for a byte. So dust writes the TRIANGLE INDEX into the same per-voxel
// pal scratch the SAT path uses, tagged, and `finishBricks` — which binds three
// buffers and has room — resolves it through `triPal`. The tags also fix the
// precedence: an exact SAT palette outranks a dust one in a voxel both reached,
// which a bare `atomicMax` over mixed encodings could not express.
//
// ══ 2.5 §2 — THE RESUMABLE BRICK, AND THE END OF STARVATION ══════════════════
//
// Stage 2.3 named the second defect too: a brick needing more pairs than the
// WHOLE per-frame cap can never complete. It was counted (`CTR_STARVED`) rather
// than solved, because the reserve was all-or-nothing and a half-filled palette
// scratch packed as if it were the whole brick.
//
// Both halves are fixed here. The reserve now takes WHATEVER BUDGET IS LEFT
// (`take = min(remaining, pairLimit - base)`) instead of failing whole, and a
// per-brick `pairCursor` — one persistent u32 per (level, brick), the only
// region of the work buffer the frame's reset does not zero — records how far
// into the brick's own deterministic pair enumeration the last frame got. Next
// frame the brick re-walks (the walk is cheap next to the SAT), skips `cursor`
// accepted triangles, and continues. The brick is cleared ONLY at cursor 0, so
// the partial bits accumulate instead of blinking, and `finishBricks` reads the
// cursor back: 0 means finished (BUILT, brickMask OR'd), non-zero means come
// back next frame (DIRTY, mask still clear — a half-built brick is invisible
// rather than wrong).
//
// The palette pack became a MERGE for the same reason: it now overwrites only
// the bytes the scratch actually claimed, and takes `max(existing, new)` when
// both are real, so a brick built over five frames converges to the SAME byte a
// one-frame build produces. Without that, "resumable" would mean "the last
// instalment's palette wins", and the carry-over receipt's bit-identity would
// have been true of `occ` and quietly false of `pal`.
//
// The cursor's staleness rule is the only subtle part: `scroll` re-points a
// slot and writes STATE_EMPTY_DIRTY without knowing this file exists, so
// `binPairs` treats state 0 as "cursor 0" regardless of what is stored, and
// `markAllDirty` (which writes STATE_DIRTY) zeroes the cursor itself.
import * as THREE from "three/webgpu";
import {
  Break, Fn, If, Loop, Return, atomicAdd, atomicAnd, atomicLoad, atomicMax, atomicOr, atomicStore,
  bitAnd, bitNot, bitOr, exp2, float, instanceIndex, instancedArray, int, select, shiftLeft,
  shiftRight, storage, uint, uniform, vec3, vec4,
} from "three/tsl";
import { sharedFn } from "../giFn.js";
import {
  BMASK_OFF, BRICK, BRICKS_PER_LEVEL, BTAB_OFF, FACE_OFF, LEVEL_WORDS, OCC_OFF, PAL_NONE,
  PAL_NONE_WORD, PAL_OFF, STATE_BUILDING, STATE_BUILT, STATE_DIRTY, STATE_EMPTY_DIRTY, WB_BIAS,
  WB_MASK, WB_VALID,
} from "./windowStore.js";

/**
 * Re-exported so Stage 2.3's callers keep compiling: the constant itself moved
 * to `windowStore.js`, where the brick-state vocabulary belongs.
 */
export { STATE_BUILDING };

/** Voxels in a brick — 64, the pal scratch's stride. */
export const BRICK_VOXELS = BRICK * BRICK * BRICK;

/**
 * A triangle is DUST at level l when its largest AABB extent is below
 * `CULL_FRACTION × v_l`. A named algorithm constant, not a knob: a quarter of a
 * cell is the point below which the 13-axis SAT and a centroid point test can
 * only disagree about the conservative skirt.
 */
export const CULL_FRACTION = 0.25;

/** All six face bits — what a dust voxel carries (see the header). */
export const DUST_FACE_MASK = 0b111111;

/**
 * The pal scratch's tag bits. One u32 per voxel holds EITHER an exact palette
 * byte (SAT) or a triangle index (dust), and `atomicMax` has to pick the exact
 * one when a voxel got both — so SAT rides the higher tag.
 *   SAT : 0x8000_0000 | (palByte + 1)      →  ≥ 2³¹, always wins
 *   dust: 0x4000_0000 | (triIndex + 1)     →  ≥ 2³⁰, and among dust the highest
 *                                             triangle index wins (deterministic,
 *                                             order-free — the property the
 *                                             carry-over receipt rests on)
 * `+1` keeps 0 meaning "nothing wrote here", which is what the frame's reset
 * leaves behind and what the merge-pack reads as "leave this byte alone".
 */
export const SCR_TAG_SAT = 0x80000000;
export const SCR_TAG_DUST = 0x40000000;
export const SCR_VALUE_MASK = 0x3fffffff;

/** Priority buckets per level: 2 frustum classes × 8 distance buckets. */
export const FRUSTUM_CLASSES = 2;
export const DIST_BUCKETS = 8;

/**
 * The per-tier budget table (§K.3: "phone 32k, desktop 256k"; high is pinned at
 * 128k by the Stage 2.3 task).
 *
 * `maxBuild` bounds the pal scratch and with it how many bricks that actually
 * CONTAIN triangles can complete in one frame. Bricks with ZERO pairs are not
 * bounded by it — they need no scratch — so an empty window drains at the full
 * dirty list per frame and only occupied bricks ever queue.
 */
export const GI2_VOX_TIERS = {
  phone: { pairsPerFrame: 32 * 1024, maxBuild: 1024 },
  medium: { pairsPerFrame: 32 * 1024, maxBuild: 1024 },
  high: { pairsPerFrame: 128 * 1024, maxBuild: 2048 },
  ultra: { pairsPerFrame: 256 * 1024, maxBuild: 4096 },
};

// ── counters, in their own tiny buffer so `stats()` is a 144-byte readback ────
export const CTR_PAIRS = 0; // the atomic write cursor into the pair list
export const CTR_DIRTY = 1;
export const CTR_BUILT = 2;
export const CTR_OVERFLOW = 3; // rejected: the pair list (or a level budget) is full
export const CTR_STARVED = 4; // a brick the cursor could not advance AT ALL — must stay 0
export const CTR_NEEDED = 5; // Σ pairsNeeded over every dirty brick scanned
export const CTR_WRITTEN = 6; // Σ pairsWritten
export const CTR_SLOTFULL = 7; // rejected: dirty index ≥ maxBuild, no scratch slot
export const CTR_CELLOVF = 8; // a brick's grid-cell span exceeded the tier's loop bound
export const CTR_INVALID = 9; // brickTab slot with no VALID marker (scroll never ran)
export const CTR_VOXELS = 10; // voxels the SAT actually set this frame
export const CTR_MAXNEED = 11; // the largest pairsNeeded any ONE brick asked for
export const CTR_DEFER = 17; // bricks that never walked: the budget was already spent
export const CTR_DUST = 18; // dust voxels written this frame (the cull's own receipt)
export const CTR_RESUMED = 19; // bricks that took PART of their pairs and stayed DIRTY
export const CTR_LEVEL_DIRTY = 12; // + level
export const CTR_LEVEL_PAIRS = 20; // + level
export const CTR_LEVEL_BUILT = 28; // + level
export const CTR_MAXCURSOR = 36; // the deepest pairCursor any brick carried
export const CTR_LEVEL_DUST = 37; // + level
export const CTR_WORDS = 48;

/**
 * Builds the voxelizer for one window.
 *
 * @param {object} win  from `createGiWindow`
 * @param {object} soup the Stage 2.2 triangle-soup contract:
 *   `tris` (storage f32, 9 per triangle, world space), `triPal` (storage u32,
 *   one byte per triangle, four per word, 255 = none), `cellRange` (storage
 *   u32, start+count per cell), `cellTris` (storage u32), plus the grid's
 *   `origin` (vec3), `cell` (float, 4.0 m) and `dim` (vec3) as uniforms or
 *   plain values.
 * @param {string} [tier]  defaults to the window's own tier
 * @param {object} [opts]
 * @param {number} [opts.pairsPerFrame] override the tier cap (allocation size)
 * @param {number} [opts.maxBuild]      override the scratch brick count
 */
export function createWindowVoxelizer(win, soup, tier = win.tier, opts = {}) {
  const spec = GI2_VOX_TIERS[tier] ?? GI2_VOX_TIERS.high;
  const PAIRS_CAP = opts.pairsPerFrame ?? spec.pairsPerFrame;
  const MAX_BUILD = opts.maxBuild ?? spec.maxBuild;

  const { levels, voxel0, atomics: winAtomics } = win;
  const MAX_DIRTY = levels * BRICKS_PER_LEVEL;
  const NBUCKETS = levels * FRUSTUM_CLASSES * DIST_BUCKETS;

  // The COARSEST brick, in metres, decides how many 4 m grid cells one brick can
  // straddle. Both halves are tier constants, so the loop bound is one too.
  const COARSE_BRICK_M = BRICK * voxel0 * Math.pow(2, levels - 1);
  const CELL_M_MIN = 4.0; // the soup contract's cell size
  const CELLS_AXIS = Math.floor(COARSE_BRICK_M / CELL_M_MIN) + 2;
  const MAX_CELLS = CELLS_AXIS * CELLS_AXIS * CELLS_AXIS;

  // ── the work buffer: cursors + buckets + pal scratch + dirty list + pairs ──
  // ONE binding at tier-constant offsets — the same argument `windowStore.js`
  // makes for the window, and the reason `binPairs` fits the portable envelope
  // with four soup buffers alongside it.
  //
  // THE PAIR CURSOR REGION IS FIRST AND IS NOT PART OF THE FRAME'S RESET. It is
  // the one piece of voxelizer state that has to SURVIVE a frame (a brick too
  // big for one budget resumes from it), and putting it at word 0 makes "reset
  // everything after the cursors" a single dispatch offset rather than a hole in
  // the middle of a linear clear. It is indexed by (level, brick) — the brick's
  // stable identity — and NOT by its dirty-list index, which is re-sorted by
  // camera distance every frame and would hand a resuming brick somebody else's
  // progress.
  const CUR_OFF = 0;
  const CUR_WORDS = levels * BRICKS_PER_LEVEL;
  const BKT_OFF = CUR_OFF + CUR_WORDS;
  const BKT_WORDS = NBUCKETS * 2; // [counts | cursors]
  const SCR_OFF = BKT_OFF + BKT_WORDS;
  const SCR_WORDS = MAX_BUILD * BRICK_VOXELS;
  const DIR_OFF = SCR_OFF + SCR_WORDS;
  const DIR_WORDS = MAX_DIRTY;
  const PAIR_OFF = DIR_OFF + DIR_WORDS;
  const PAIR_WORDS = PAIRS_CAP * 2;
  const WORK_WORDS = PAIR_OFF + PAIR_WORDS;

  const work = instancedArray(new Uint32Array(WORK_WORDS), "uint");
  const workAttr = work.value;
  const wk = storage(workAttr, "uint", WORK_WORDS).toAtomic();

  const ctrBuf = instancedArray(new Uint32Array(CTR_WORDS), "uint");
  const ctrAttr = ctrBuf.value;
  const ct = storage(ctrAttr, "uint", CTR_WORDS).toAtomic();

  // ── uniforms ──────────────────────────────────────────────────────────────
  const camPosU = uniform(new THREE.Vector3(0, 0, 0));
  const planesU = Array.from({ length: 6 }, () => uniform(new THREE.Vector4(0, 0, 0, 1)));
  const frustumOnU = uniform(0);
  const coarseFirstU = uniform(1);
  const palModeU = uniform(1);
  // THE CULL'S OWN CONTROL ARM. 0 sends the dust threshold to zero, which no
  // triangle's extent can be below, so every triangle takes the pair path and
  // the voxelizer is Stage 2.3's exactly. It is a uniform and not a rebuild
  // because a before/after frames table measured in two SESSIONS is not a
  // measurement — GPU clocks, another agent's dispatches and pipeline-cache
  // state all move between runs, and the whole claim here is a ratio.
  const cullOnU = uniform(1);
  // The blind-statistics control for the entry-face test, on the DATA and not
  // on the tracer — the same uniform `windowFill` carries, for the same reason:
  // "0 leaks" only means something next to an arm where the bits are withheld
  // and the identical rays pour straight through.
  const faceBitsU = uniform(1);
  const pairLimitU = uniform(PAIRS_CAP);
  const levelBudgetU = Array.from({ length: levels }, () => uniform(PAIRS_CAP));

  const asNode = (v, make) => (v && v.isNode ? v : make(v));
  const gridOriginU = asNode(soup.origin ?? soup.gridOrigin, (v) =>
    uniform(new THREE.Vector3(v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0)));
  const gridCellU = asNode(soup.cell ?? soup.gridCell ?? CELL_M_MIN, (v) => uniform(v));
  const gridDimU = asNode(soup.dim ?? soup.gridDim, (v) =>
    uniform(new THREE.Vector3(v?.[0] ?? 1, v?.[1] ?? 1, v?.[2] ?? 1)));

  const { tris, triPal, cellRange, cellTris } = soup;

  // ── addressing helpers (JS-level; each emits ~3 ops, no function call) ─────
  const levelBaseOf = (level) => level.mul(uint(LEVEL_WORDS));
  const tabBaseOf = (level, b) => levelBaseOf(level).add(uint(BTAB_OFF)).add(b.mul(uint(2)));
  /** Torus voxel index of local voxel (lx, ly, lz) inside torus brick `b`. */
  const voxIndexIn = (b, lx, ly, lz) => bitOr(
    bitOr(
      bitAnd(b, uint(15)).mul(uint(BRICK)).add(lx),
      shiftLeft(bitAnd(shiftRight(b, uint(4)), uint(15)).mul(uint(BRICK)).add(ly), uint(6)),
    ),
    shiftLeft(bitAnd(shiftRight(b, uint(8)), uint(15)).mul(uint(BRICK)).add(lz), uint(12)),
  );
  /** World brick coord packed in `brickTab` word 0 → vec3 of floats. */
  const unpackWb = (stored) => vec3(
    bitAnd(stored, uint(WB_MASK)).toInt().sub(int(WB_BIAS)).toFloat(),
    bitAnd(shiftRight(stored, uint(10)), uint(WB_MASK)).toInt().sub(int(WB_BIAS)).toFloat(),
    bitAnd(shiftRight(stored, uint(20)), uint(WB_MASK)).toInt().sub(int(WB_BIAS)).toFloat(),
  );
  /** The 9 floats of triangle `t`, as three vec3 vars. */
  const readTri = (t) => {
    const b = t.mul(uint(9)).toVar();
    return [
      vec3(tris.element(b), tris.element(b.add(uint(1))), tris.element(b.add(uint(2)))).toVar(),
      vec3(tris.element(b.add(uint(3))), tris.element(b.add(uint(4))), tris.element(b.add(uint(5)))).toVar(),
      vec3(tris.element(b.add(uint(6))), tris.element(b.add(uint(7))), tris.element(b.add(uint(8)))).toVar(),
    ];
  };
  /** The level budget select chain, unrolled over the TIER's level count. */
  const levelBudgetAt = (levelNode) => {
    let node = float(levelBudgetU[levels - 1]);
    for (let l = levels - 2; l >= 0; l--) node = select(levelNode.equal(uint(l)), float(levelBudgetU[l]), node);
    return node;
  };

  // ═══════════════════════════════════════════════════════ SHARED FN: the SAT
  //
  // Akenine-Möller's 13-axis triangle/AABB separating-axis test, ported VERBATIM
  // from `occupancyField.js`'s `triBoxOverlap` and expressed in VOXEL SPACE,
  // where the box is a unit cube and every axis test is a bare dot product.
  // A `sharedFn` rather than an inline: 13 axes stamped out at each call site is
  // exactly what made GI's fragment shaders 200 kB, and Stage 2.5's dynamic
  // voxelizer is a second call site by construction.
  const triBoxOverlapFn = sharedFn({
    name: "gi2TriBox",
    type: "float",
    inputs: [
      { name: "c", type: "vec3" }, { name: "h", type: "vec3" },
      { name: "a0", type: "vec3" }, { name: "a1", type: "vec3" }, { name: "a2", type: "vec3" },
    ],
    body: (c, h, a0, a1, a2) => {
      const v0 = a0.sub(c).toVar();
      const v1 = a1.sub(c).toVar();
      const v2 = a2.sub(c).toVar();
      const e0 = v1.sub(v0).toVar();
      const e1 = v2.sub(v1).toVar();
      const e2 = v0.sub(v2).toVar();
      const ok = float(1).toVar();
      const span = (pa, pb, rad) => {
        ok.assign(select(pa.min(pb).greaterThan(rad).or(pa.max(pb).lessThan(rad.negate())), float(0), ok));
      };
      const f0 = e0.abs().toVar();
      const f1 = e1.abs().toVar();
      const f2 = e2.abs().toVar();
      const testX = (e, f, pa, pb) =>
        span(e.z.mul(pa.y).sub(e.y.mul(pa.z)), e.z.mul(pb.y).sub(e.y.mul(pb.z)), f.z.mul(h.y).add(f.y.mul(h.z)));
      const testY = (e, f, pa, pb) =>
        span(e.z.mul(pa.x).negate().add(e.x.mul(pa.z)), e.z.mul(pb.x).negate().add(e.x.mul(pb.z)),
          f.z.mul(h.x).add(f.x.mul(h.z)));
      const testZ = (e, f, pa, pb) =>
        span(e.y.mul(pa.x).sub(e.x.mul(pa.y)), e.y.mul(pb.x).sub(e.x.mul(pb.y)), f.y.mul(h.x).add(f.x.mul(h.y)));
      testX(e0, f0, v0, v2); testY(e0, f0, v0, v2); testZ(e0, f0, v1, v2);
      testX(e1, f1, v0, v2); testY(e1, f1, v0, v2); testZ(e1, f1, v0, v1);
      testX(e2, f2, v0, v1); testY(e2, f2, v0, v1); testZ(e2, f2, v1, v2);
      const tmin = v0.min(v1).min(v2).toVar();
      const tmax = v0.max(v1).max(v2).toVar();
      ok.assign(select(tmin.x.greaterThan(h.x).or(tmax.x.lessThan(h.x.negate())), float(0), ok));
      ok.assign(select(tmin.y.greaterThan(h.y).or(tmax.y.lessThan(h.y.negate())), float(0), ok));
      ok.assign(select(tmin.z.greaterThan(h.z).or(tmax.z.lessThan(h.z.negate())), float(0), ok));
      const n = e0.cross(e1).toVar();
      const rad = h.x.mul(n.x.abs()).add(h.y.mul(n.y.abs())).add(h.z.mul(n.z.abs()));
      ok.assign(select(n.dot(v0).abs().greaterThan(rad), float(0), ok));
      return ok;
    },
  });

  // ═════════════════════════════════════════ SHARED FN: triangle AABB vs brick
  const aabbHitFn = sharedFn({
    name: "gi2AabbHit",
    type: "float",
    inputs: [
      { name: "alo", type: "vec3" }, { name: "ahi", type: "vec3" },
      { name: "blo", type: "vec3" }, { name: "bhi", type: "vec3" },
    ],
    body: (alo, ahi, blo, bhi) => select(
      alo.x.greaterThan(bhi.x).or(ahi.x.lessThan(blo.x))
        .or(alo.y.greaterThan(bhi.y)).or(ahi.y.lessThan(blo.y))
        .or(alo.z.greaterThan(bhi.z)).or(ahi.z.lessThan(blo.z)),
      float(0), float(1),
    ),
  });

  // ═══════════════════════════════════════════════ SHARED FN: the priority key
  //
  // (in-frustum ? 0 : 1, distance bucket), with the LEVEL as the OUTERMOST key
  // so "coarse levels first at boot" is a sort order rather than a scheduler.
  // `coarseFirst` flips it for the steady state, where the camera's own level
  // matters more than the horizon's.
  const bucketFn = sharedFn({
    name: "gi2Bucket",
    type: "float",
    inputs: [{ name: "levelF", type: "float" }, { name: "wb", type: "vec3" }],
    body: (levelF, wb) => {
      const bl = float(voxel0 * BRICK).mul(exp2(levelF)).toVar();
      const bmin = wb.mul(bl).toVar();
      const bmax = bmin.add(bl).toVar();
      const dist = bmin.add(bmax).mul(0.5).sub(vec3(camPosU)).length().toVar();
      // Distance in units of TWO bricks OF THIS LEVEL — a scale that shrinks
      // with the level, so L0's buckets describe the room and L4's the horizon.
      const db = dist.div(bl.mul(2)).floor().clamp(float(0), float(DIST_BUCKETS - 1)).toVar();
      const inside = float(1).toVar();
      for (let i = 0; i < 6; i++) {
        const pl = vec4(planesU[i]).toVar();
        // The "positive vertex": the box corner furthest along the plane
        // normal. If IT is behind the plane the whole box is.
        const pv = vec3(
          select(pl.x.greaterThan(0), bmax.x, bmin.x),
          select(pl.y.greaterThan(0), bmax.y, bmin.y),
          select(pl.z.greaterThan(0), bmax.z, bmin.z),
        ).toVar();
        inside.assign(select(pl.xyz.dot(pv).add(pl.w).lessThan(0), float(0), inside));
      }
      inside.assign(select(float(frustumOnU).lessThan(0.5), float(1), inside));
      const rank = select(float(coarseFirstU).greaterThan(0.5), float(levels - 1).sub(levelF), levelF).toVar();
      return rank.mul(float(FRUSTUM_CLASSES)).add(float(1).sub(inside)).mul(float(DIST_BUCKETS)).add(db);
    },
  });

  // ══════════════════════════════════════════════════════════ PASS: reset
  // Counters and the WHOLE work buffer, zeroed. The pair list is included on
  // purpose: a brick whose reserve FAILS has already advanced the cursor, so
  // the list has holes, and a hole read as a pair would voxelize triangle 0
  // into brick 0. Pairs store `tri + 1`, so a zeroed hole is self-identifying —
  // and that only holds if the region really is zero at the top of the frame.
  const resetCtrPass = Fn(() => {
    atomicStore(ct.element(instanceIndex), uint(0));
  })().compute(CTR_WORDS);

  // Everything EXCEPT the pair cursors, which are the frame-crossing state the
  // resumable brick is made of. The offset is a tier constant, so the kernel is
  // still one store and still scene-free.
  const resetWorkPass = Fn(() => {
    atomicStore(wk.element(instanceIndex.add(uint(CUR_WORDS))), uint(0));
  })().compute(WORK_WORDS - CUR_WORDS);

  // ═════════════════════════════════════════════════════ PASS: markAllDirty
  // One thread per (level, brick): state ← DIRTY, `wb` untouched. Scene load,
  // geometry edit and the harness's "do it all again" all land here.
  //
  // It ZEROES THE PAIR CURSOR as well, and that is not tidiness: the cursor
  // means "this many of the brick's pairs are already voxelized", a claim that
  // stops being true the moment the soup or the brick's contents change. A
  // stale cursor would make the brick skip its first N triangles forever.
  const markAllDirtyPass = Fn(() => {
    const level = shiftRight(instanceIndex, uint(12)).toVar();
    const b = bitAnd(instanceIndex, uint(BRICKS_PER_LEVEL - 1)).toVar();
    atomicStore(winAtomics.element(tabBaseOf(level, b).add(uint(1))), uint(STATE_DIRTY));
    atomicStore(wk.element(uint(CUR_OFF).add(instanceIndex)), uint(0));
  })().compute(levels * BRICKS_PER_LEVEL);

  // ═══════════════════════════════════════════════════ PASS: dirtyList (count)
  const dirtyCountPass = Fn(() => {
    const level = shiftRight(instanceIndex, uint(12)).toVar();
    const b = bitAnd(instanceIndex, uint(BRICKS_PER_LEVEL - 1)).toVar();
    const tab = tabBaseOf(level, b).toVar();
    const stored = atomicLoad(winAtomics.element(tab)).toVar();
    const state = atomicLoad(winAtomics.element(tab.add(uint(1)))).toVar();
    If(state.lessThan(uint(STATE_BUILT)), () => {
      If(bitAnd(stored, uint(WB_VALID)).equal(uint(0)), () => {
        atomicAdd(ct.element(uint(CTR_INVALID)), uint(1));
      }).Else(() => {
        const bucket = bucketFn(level.toFloat(), unpackWb(stored)).toUint().min(uint(NBUCKETS - 1)).toVar();
        atomicAdd(wk.element(uint(BKT_OFF).add(bucket)), uint(1));
        atomicAdd(ct.element(uint(CTR_DIRTY)), uint(1));
        atomicAdd(ct.element(uint(CTR_LEVEL_DIRTY).add(level)), uint(1));
      });
    });
  })().compute(levels * BRICKS_PER_LEVEL);

  // ══════════════════════════════════════════════════ PASS: dirtyList (prefix)
  // ONE thread walking NBUCKETS (≤ 80) counters. A parallel scan of eighty words
  // costs more in dispatch than it saves in arithmetic.
  const dirtyPrefixPass = Fn(() => {
    const run = uint(0).toVar();
    Loop({ start: 0, end: NBUCKETS, name: "bkt" }, ({ bkt }) => {
      const c = atomicLoad(wk.element(uint(BKT_OFF).add(uint(bkt)))).toVar();
      atomicStore(wk.element(uint(BKT_OFF + NBUCKETS).add(uint(bkt))), run);
      run.addAssign(c);
    });
  })().compute(1);

  // ═════════════════════════════════════════════════ PASS: dirtyList (scatter)
  const dirtyScatterPass = Fn(() => {
    const level = shiftRight(instanceIndex, uint(12)).toVar();
    const b = bitAnd(instanceIndex, uint(BRICKS_PER_LEVEL - 1)).toVar();
    const tab = tabBaseOf(level, b).toVar();
    const stored = atomicLoad(winAtomics.element(tab)).toVar();
    const state = atomicLoad(winAtomics.element(tab.add(uint(1)))).toVar();
    If(state.lessThan(uint(STATE_BUILT)).and(bitAnd(stored, uint(WB_VALID)).notEqual(uint(0))), () => {
      const bucket = bucketFn(level.toFloat(), unpackWb(stored)).toUint().min(uint(NBUCKETS - 1)).toVar();
      const slot = atomicAdd(wk.element(uint(BKT_OFF + NBUCKETS).add(bucket)), uint(1)).toVar();
      If(slot.lessThan(uint(MAX_DIRTY)), () => {
        atomicStore(wk.element(uint(DIR_OFF).add(slot)), bitOr(shiftLeft(level, uint(12)), b));
      });
    });
  })().compute(levels * BRICKS_PER_LEVEL);

  // ═══════════════════════════════════════════════════════════ PASS: binPairs
  //
  // One thread per DIRTY BRICK, in priority order (thread i owns dirty-list
  // entry i, and the list is bucket-sorted). Walks the ≤ MAX_CELLS grid cells
  // the brick overlaps, AABB-rejects each triangle, counts, reserves, writes.
  //
  // Bindings: work, counters, window, cellRange, cellTris, tris = 6 — the
  // portable envelope exactly, which is why the buckets, the scratch, the dirty
  // list and the pair list all share ONE buffer.
  const binPairsPass = Fn(() => {
    const i = instanceIndex.toVar();
    const dirty = atomicLoad(ct.element(uint(CTR_DIRTY))).toVar();
    If(i.greaterThanEqual(dirty.min(uint(MAX_DIRTY))), () => { Return(); });

    // EARLY OUT ON A SPENT BUDGET — A BOUND, NOT AN OPTIMISATION.
    //
    // The idea was that a brick the budget already rejected should not pay a
    // full COUNT walk again, since that walk (not the SAT) is what a dense
    // scene costs — 23 000-97 000 brick rejections over a Bistro-scale build,
    // each re-reading thousands of triangles to learn again that it cannot have
    // them. MEASURED, IT NEVER FIRES: `deferred` is 0 at every tier, because a
    // 20 480-thread dispatch launches essentially all at once and every thread
    // reads the cursor before any of them has filled it. It is kept because it
    // still BOUNDS a pathological dirty list (one whose threads genuinely do
    // start late), and it costs one atomic load — but the per-frame cost in the
    // receipts is the cost WITH it, so nothing here is paid for by this line.
    If(atomicLoad(ct.element(uint(CTR_PAIRS))).toFloat().greaterThanEqual(float(pairLimitU)), () => {
      atomicAdd(ct.element(uint(CTR_DEFER)), uint(1));
      Return();
    });

    const id = atomicLoad(wk.element(uint(DIR_OFF).add(i))).toVar();
    const level = shiftRight(id, uint(12)).toVar();
    const b = bitAnd(id, uint(BRICKS_PER_LEVEL - 1)).toVar();
    const tab = tabBaseOf(level, b).toVar();
    const stored = atomicLoad(winAtomics.element(tab)).toVar();
    const wb = unpackWb(stored).toVar();

    const bl = float(voxel0 * BRICK).mul(exp2(level.toFloat())).toVar();
    const bmin = wb.mul(bl).toVar();
    const bmax = bmin.add(bl).toVar();

    // ── the grid cells this brick overlaps ────────────────────────────────
    const dim = vec3(gridDimU).toVar();
    const cell = float(gridCellU).toVar();
    const g0 = bmin.sub(vec3(gridOriginU)).div(cell).floor().clamp(vec3(0), dim.sub(1)).toVar();
    const g1 = bmax.sub(vec3(gridOriginU)).div(cell).floor().clamp(vec3(0), dim.sub(1)).toVar();
    const nx = g1.x.sub(g0.x).add(1).min(float(CELLS_AXIS)).toUint().toVar();
    const ny = g1.y.sub(g0.y).add(1).min(float(CELLS_AXIS)).toUint().toVar();
    const nz = g1.z.sub(g0.z).add(1).min(float(CELLS_AXIS)).toUint().toVar();
    If(g1.x.sub(g0.x).add(1).greaterThan(float(CELLS_AXIS))
      .or(g1.y.sub(g0.y).add(1).greaterThan(float(CELLS_AXIS)))
      .or(g1.z.sub(g0.z).add(1).greaterThan(float(CELLS_AXIS))), () => {
      atomicAdd(ct.element(uint(CTR_CELLOVF)), uint(1));
    });
    const nxy = nx.mul(ny).toVar();
    const nCells = nxy.mul(nz).toVar();
    const dimX = dim.x.toUint().toVar();
    const dimY = dim.y.toUint().toVar();

    // ── THE WALK, run twice: `mode` 0 counts, `mode` 1 writes ─────────────
    // The two passes must enumerate the same pairs in the same order, so they
    // are the same code with one branch at the tail rather than two loops that
    // could drift apart under a later edit. That identical order is also what
    // makes the pair CURSOR meaningful: "the first `skip` accepted triangles are
    // already done" is only a resumption point if both walks agree on which
    // triangle is first.
    const need = uint(0).toVar(); // pairs this brick wants IN TOTAL
    const dust = uint(0).toVar(); // sub-voxel triangles that skip the SAT
    const base = uint(0).toVar(); // this frame's slice of the pair list
    const take = uint(0).toVar(); // how many of `need` this frame can afford
    const skip = uint(0).toVar(); // pairs earlier frames already voxelized
    const written = uint(0).toVar();
    const dustWritten = uint(0).toVar();
    const slotOk = float(0).toVar();

    // THE CULL THRESHOLD, in world metres AT THIS LEVEL — derived from the
    // brick length the thread already holds, so nothing scene-shaped enters the
    // WGSL and the same kernel culls differently at every level, which is the
    // whole point of a PER-LEVEL cull.
    const vLevel = bl.div(float(BRICK)).toVar();
    const dustLimit = vLevel.mul(float(CULL_FRACTION)).mul(float(cullOnU)).toVar();
    const levelBase = levelBaseOf(level).toVar();
    const bcell0 = wb.mul(float(BRICK)).toVar(); // the brick's first world cell
    const hasScratch = i.lessThan(uint(MAX_BUILD));

    /**
     * THE DUST WRITE. One voxel, all six face bits, no SAT, no pair.
     *
     * De-duplication is the CENTROID's job: it lies in exactly one brick, so
     * exactly one brick writes this triangle and the pair path's `own` cell rule
     * is not needed (and would be wrong — the owning cell and the centroid's
     * brick are different questions).
     */
    const writeDust = (t, p) => {
      const c = p[0].add(p[1]).add(p[2]).div(float(3)).toVar();
      const wc = c.div(vLevel).floor().toVar();
      const l3 = wc.sub(bcell0).toVar();
      If(l3.x.greaterThanEqual(0).and(l3.y.greaterThanEqual(0)).and(l3.z.greaterThanEqual(0))
        .and(l3.x.lessThan(float(BRICK))).and(l3.y.lessThan(float(BRICK)))
        .and(l3.z.lessThan(float(BRICK))), () => {
        const lx = l3.x.toUint().toVar();
        const ly = l3.y.toUint().toVar();
        const lz = l3.z.toUint().toVar();
        const vi = voxIndexIn(b, lx, ly, lz).toVar();
        atomicOr(
          winAtomics.element(levelBase.add(uint(OCC_OFF)).add(shiftRight(vi, uint(5)))),
          shiftLeft(uint(1), bitAnd(vi, uint(31))),
        );
        // Gated on `faceBits` exactly as the SAT path is. The control arm's
        // claim is "withhold the entry-face bit and the identical rays pour
        // through"; dust writing all six bits regardless would leave a residue
        // of blocked rays that has nothing to do with the bit under test —
        // measured at phone, where the sphere IS dust at L0, as a control that
        // leaked 98.87 % instead of 100 %.
        atomicOr(
          winAtomics.element(levelBase.add(uint(FACE_OFF)).add(shiftRight(vi, uint(2)))),
          shiftLeft(
            select(float(faceBitsU).greaterThan(0.5), uint(DUST_FACE_MASK), uint(0)),
            bitAnd(vi, uint(3)).mul(uint(8)),
          ),
        );
        // The palette rides as a TRIANGLE INDEX because `binPairs` has no
        // `triPal` binding to spend (see the file header); `finishBricks`
        // resolves the tag.
        If(hasScratch, () => {
          atomicMax(
            wk.element(uint(SCR_OFF).add(i.mul(uint(BRICK_VOXELS)))
              .add(lx.add(ly.mul(uint(4))).add(lz.mul(uint(16))))),
            bitOr(uint(SCR_TAG_DUST), t.add(uint(1))),
          );
        });
        dustWritten.addAssign(1);
      });
    };

    // `Return()` is NOT usable to skip one triangle: in WGSL it kills the whole
    // invocation, and this thread still owes its brick a state write. Every skip
    // below is therefore a POSITIVE `If`, not an early exit — the same reason
    // `occupancyField`'s voxelize guards its whole body instead of breaking.
    const walk = (mode) => {
      const cellName = `cellK${mode}`;
      const triName = `triJ${mode}`;
      const cursor = uint(0).toVar();
      Loop({ start: 0, end: MAX_CELLS, name: cellName }, (params) => {
        const k = uint(params[cellName]).toVar();
        If(k.greaterThanEqual(nCells), () => { Break(); });
        const kz = k.div(nxy).toVar();
        const r = k.sub(kz.mul(nxy)).toVar();
        const ky = r.div(nx).toVar();
        const kx = r.sub(ky.mul(nx)).toVar();
        const gx = g0.x.toUint().add(kx).toVar();
        const gy = g0.y.toUint().add(ky).toVar();
        const gz = g0.z.toUint().add(kz).toVar();
        const ci = gx.add(dimX.mul(gy.add(dimY.mul(gz)))).toVar();
        const start = cellRange.element(ci.mul(uint(2))).toVar();
        const count = cellRange.element(ci.mul(uint(2)).add(uint(1))).toVar();
        Loop({ start: 0, end: count, type: "uint", name: triName }, (inner) => {
          const t = cellTris.element(start.add(uint(inner[triName]))).toVar();
          const p = readTri(t);
          const tlo = p[0].min(p[1]).min(p[2]).toVar();
          const thi = p[0].max(p[1]).max(p[2]).toVar();
          // DE-DUPLICATION. A triangle is listed in EVERY cell it touches, so
          // without this a 10 m wall triangle pairs with the same brick nine
          // times and nine SAT runs re-write the same bits out of the same
          // budget. Accept it only from the min corner of (its cell range ∩
          // this brick's cell range) — a cell this loop is guaranteed to visit,
          // and to visit exactly once.
          const tc0 = tlo.sub(vec3(gridOriginU)).div(cell).floor().clamp(vec3(0), dim.sub(1)).toVar();
          const own = tc0.max(g0).toVar();
          const near = aabbHitFn(tlo, thi, bmin, bmax).greaterThan(0.5);
          // THE PER-LEVEL CULL. Largest AABB extent against a quarter of THIS
          // level's cell. Both directions are written as explicit compares
          // rather than one negated node, so the dust and pair paths are
          // provably disjoint at every level and no triangle can fall through
          // both or neither.
          const emax = thi.x.sub(tlo.x).max(thi.y.sub(tlo.y)).max(thi.z.sub(tlo.z)).toVar();
          const isDust = emax.lessThan(dustLimit);
          const isFat = emax.greaterThanEqual(dustLimit);
          If(near.and(isDust), () => {
            if (mode === 0) dust.addAssign(1);
            else writeDust(t, p);
          });
          const takeIt = near.and(isFat)
            .and(own.x.toUint().equal(gx)).and(own.y.toUint().equal(gy)).and(own.z.toUint().equal(gz));
          If(takeIt, () => {
            if (mode === 0) {
              need.addAssign(1);
            } else {
              // The RESUMPTION WINDOW: [skip, skip + take) of this brick's own
              // deterministic pair enumeration. Earlier frames voxelized
              // everything below `skip`; later frames pick up above.
              If(cursor.greaterThanEqual(skip).and(cursor.lessThan(skip.add(take))), () => {
                const w = uint(PAIR_OFF).add(base.add(cursor).sub(skip).mul(uint(2))).toVar();
                // slot (13) | level (3) | torus brick (12) — 28 bits; the
                // triangle is stored +1 so a zeroed hole in the list can never
                // read as a legal pair.
                atomicStore(wk.element(w), bitOr(bitOr(i, shiftLeft(level, uint(13))), shiftLeft(b, uint(16))));
                atomicStore(wk.element(w.add(uint(1))), t.add(uint(1)));
                written.addAssign(1);
              });
              cursor.addAssign(1);
            }
          });
        });
      });
    };

    walk(0);
    atomicAdd(ct.element(uint(CTR_NEEDED)), need);
    // The largest single-brick demand in the frame. It used to be the floor a
    // test cap had to clear; with the resumable cursor it is a receipt only —
    // a cap BELOW it now converges instead of starving, which is precisely the
    // property the cursor arm exists to prove.
    atomicMax(ct.element(uint(CTR_MAXNEED)), need);

    // ── the resumable reserve ────────────────────────────────────────────
    //
    // `skip` is where the last frame stopped. `windowStore`'s `scroll` re-points
    // a slot and writes EMPTY_DIRTY without knowing this file exists, so a
    // cursor stored by the brick that USED to own the slot is stale exactly
    // then — state 0 forces a restart, and `markAllDirty` zeroes the word
    // itself for the case where the slot did NOT move but its contents did.
    const curWord = uint(CUR_OFF).add(level.mul(uint(BRICKS_PER_LEVEL))).add(b).toVar();
    const stateNow = atomicLoad(winAtomics.element(tab.add(uint(1)))).toVar();
    skip.assign(select(
      stateNow.equal(uint(STATE_EMPTY_DIRTY)),
      uint(0),
      atomicLoad(wk.element(curWord)).min(need),
    ));
    const remaining = need.sub(skip).toVar();

    const accept = float(0).toVar();
    If(remaining.equal(uint(0)), () => {
      // Nothing left to pair — an empty brick, a DUST-ONLY brick, or the frame
      // that closes a resumed one. No scratch slot, no budget, always accepted:
      // this is what lets an empty window drain in a couple of frames instead of
      // queueing 16 384 nothings behind MAX_BUILD.
      accept.assign(1);
    }).Else(() => {
      If(i.greaterThanEqual(uint(MAX_BUILD)), () => {
        atomicAdd(ct.element(uint(CTR_SLOTFULL)), uint(1));
      }).Else(() => {
        const lvBase = atomicAdd(ct.element(uint(CTR_LEVEL_PAIRS).add(level)), remaining).toVar();
        const lvRoom = levelBudgetAt(level).sub(lvBase.toFloat()).toVar();
        If(lvRoom.lessThan(1), () => {
          atomicAdd(ct.element(uint(CTR_OVERFLOW)), uint(1));
        }).Else(() => {
          base.assign(atomicAdd(ct.element(uint(CTR_PAIRS)), remaining));
          const room = float(pairLimitU).sub(base.toFloat()).min(lvRoom).toVar();
          If(room.lessThan(1), () => {
            atomicAdd(ct.element(uint(CTR_OVERFLOW)), uint(1));
          }).Else(() => {
            // THE PARTIAL RESERVE. Stage 2.3 failed the whole brick when its
            // demand did not fit, which is what made a brick bigger than the cap
            // unbuildable; it now takes WHATEVER IS LEFT and the cursor carries
            // the rest to the next frame. Safe because the palette pack became a
            // merge (see `finishBricks`) — the original all-or-nothing rule
            // existed only because a half-filled scratch packed its missing half
            // as 255.
            take.assign(remaining.min(room.toUint()));
            accept.assign(1);
            slotOk.assign(1);
          });
        });
      });
    });

    If(accept.greaterThan(0.5), () => {
      const newCursor = skip.add(take).toVar();
      const done = newCursor.greaterThanEqual(need);
      // CLEAR the brick's own voxels before anything re-writes them — but ONLY
      // on the first instalment. A resumed brick must accumulate onto what its
      // earlier instalments wrote, or every frame would erase the last one and
      // the brick would converge to its final slice instead of its union.
      If(skip.equal(uint(0)), () => {
        atomicAnd(
          winAtomics.element(levelBase.add(uint(BMASK_OFF)).add(shiftRight(b, uint(5)))),
          bitNot(shiftLeft(uint(1), bitAnd(b, uint(31)))),
        );
        // 16 rows of four x-consecutive voxels: `face` words are owned outright
        // and stored; the `occ` nibble and the brickMask bit share a word with
        // neighbours and are merged with atomicAnd.
        Loop({ start: 0, end: BRICK * BRICK, name: "clrRow" }, ({ clrRow }) => {
          const ly = bitAnd(uint(clrRow), uint(3)).toVar();
          const lz = shiftRight(uint(clrRow), uint(2)).toVar();
          const vi = voxIndexIn(b, uint(0), ly, lz).toVar();
          atomicAnd(
            winAtomics.element(levelBase.add(uint(OCC_OFF)).add(shiftRight(vi, uint(5)))),
            bitNot(shiftLeft(uint(0xf), bitAnd(vi, uint(31)))),
          );
          atomicStore(winAtomics.element(levelBase.add(uint(FACE_OFF)).add(shiftRight(vi, uint(2)))), uint(0));
          // `pal` goes to 255-per-byte on the shipping path (`finishBricks`
          // merges the scratch over it, so this only matters if the brick ends
          // up empty) and to 0 on the CONTROL path, because the naive packed
          // `atomicMax` can never lower a byte and would otherwise leave every
          // voxel reading 255 — a control arm that fails for the wrong reason
          // proves nothing about the arm it is controlling.
          atomicStore(
            winAtomics.element(levelBase.add(uint(PAL_OFF)).add(shiftRight(vi, uint(2)))),
            select(float(palModeU).greaterThan(0.5), uint(PAL_NONE_WORD), uint(0)),
          );
        });
      });
      // A brick with nothing but dust never reserves a pair, so the write walk
      // has to be reachable without `slotOk` — and a brick with NEITHER must
      // still skip it, or an empty window would pay two walks per brick per
      // frame for nothing.
      If(slotOk.greaterThan(0.5).or(dust.greaterThan(uint(0))), () => {
        walk(1);
        atomicAdd(ct.element(uint(CTR_WRITTEN)), written);
        atomicAdd(ct.element(uint(CTR_DUST)), dustWritten);
        atomicAdd(ct.element(uint(CTR_LEVEL_DUST).add(level)), dustWritten);
      });
      // A finished brick stores 0 so the next scroll/dirty cycle starts clean,
      // and `finishBricks` reads exactly this word to decide BUILT vs one-more-
      // frame — the cursor IS the completion flag, so there is no second piece
      // of state that could disagree with it.
      atomicStore(wk.element(curWord), select(done, uint(0), newCursor));
      atomicMax(ct.element(uint(CTR_MAXCURSOR)), newCursor);
      If(newCursor.lessThan(need), () => { atomicAdd(ct.element(uint(CTR_RESUMED)), uint(1)); });
      // STRUCTURALLY UNREACHABLE, and counted anyway: `accept` implies either
      // `remaining == 0` or `take >= 1`, so a brick can never be accepted and
      // make no progress. `starved` is now an INVARIANT the probe asserts, not
      // a failure mode the design tolerates.
      If(take.equal(uint(0)).and(remaining.greaterThan(uint(0))), () => {
        atomicAdd(ct.element(uint(CTR_STARVED)), uint(1));
      });
      atomicStore(winAtomics.element(tab.add(uint(1))), uint(STATE_BUILDING));
    });
  })().compute(MAX_DIRTY);

  // ═══════════════════════════════════════════════════════════ PASS: voxelize
  //
  // One thread per PAIR. The soup is world-space, so nothing is transformed:
  // the triangle is divided by the level's cell size into VOXEL SPACE, where
  // the SAT's box is a unit cube, and the span is clipped to the brick's own
  // 4³ — a triangle straddling two bricks is two pairs, each responsible for
  // its own half, which is what keeps the write set disjoint per brick.
  //
  // Bindings: work, window, tris, triPal = 4.
  const voxelizePass = Fn(() => {
    const i = instanceIndex.toVar();
    const w = uint(PAIR_OFF).add(i.mul(uint(2))).toVar();
    const p1 = atomicLoad(wk.element(w.add(uint(1)))).toVar();
    If(p1.equal(uint(0)), () => { Return(); }); // a hole, or beyond the cursor
    const p0 = atomicLoad(wk.element(w)).toVar();
    const slot = bitAnd(p0, uint(0x1fff)).toVar();
    const level = bitAnd(shiftRight(p0, uint(13)), uint(7)).toVar();
    const b = bitAnd(shiftRight(p0, uint(16)), uint(0xfff)).toVar();
    const t = p1.sub(uint(1)).toVar();

    const tab = tabBaseOf(level, b).toVar();
    const wb = unpackWb(atomicLoad(winAtomics.element(tab))).toVar();

    const v = float(voxel0).mul(exp2(level.toFloat())).toVar();
    const p = readTri(t);
    // VOXEL SPACE: divide by the cell size and the box becomes a unit cube.
    const q0 = p[0].div(v).toVar();
    const q1 = p[1].div(v).toVar();
    const q2 = p[2].div(v).toVar();

    // FACE BITS. `windowTrace`'s corrected rule: bit(±a) is set iff the surface
    // is NOT parallel to axis a, i.e. its normal has an `a` component — and
    // both bits of a pair go together, because occlusion along a line is
    // reciprocal. The normal is normalized first so the 1e-3 threshold is an
    // ANGLE and not a function of the triangle's size.
    const nrm = q1.sub(q0).cross(q2.sub(q0)).toVar();
    const nlen = nrm.length().toVar();
    If(nlen.lessThan(1e-12), () => { Return(); }); // degenerate: no area, no surface
    const nn = nrm.div(nlen).toVar();
    const faceMask = bitOr(
      bitOr(
        select(nn.x.abs().greaterThan(1e-3), uint(0b000011), uint(0)),
        select(nn.y.abs().greaterThan(1e-3), uint(0b001100), uint(0)),
      ),
      select(nn.z.abs().greaterThan(1e-3), uint(0b110000), uint(0)),
    ).toVar();
    faceMask.assign(select(float(faceBitsU).greaterThan(0.5), faceMask, uint(0)));

    // Palette byte of this triangle: 4 per word, 255 = none.
    const palByte = bitAnd(shiftRight(triPal.element(shiftRight(t, uint(2))), bitAnd(t, uint(3)).mul(uint(8))),
      uint(255)).toVar();

    // The voxel span, conservative by half a cell, clipped to the brick.
    const bc = wb.mul(float(BRICK)).toVar(); // the brick's first world cell
    const lo = q0.min(q1).min(q2).sub(0.5).floor().max(bc).toVar();
    const hi = q0.max(q1).max(q2).add(0.5).floor().min(bc.add(float(BRICK - 1))).toVar();
    If(hi.x.lessThan(lo.x).or(hi.y.lessThan(lo.y)).or(hi.z.lessThan(lo.z)), () => { Return(); });

    const sx = hi.x.sub(lo.x).add(1).toUint().toVar();
    const sy = hi.y.sub(lo.y).add(1).toUint().toVar();
    const sz = hi.z.sub(lo.z).add(1).toUint().toVar();
    const sxy = sx.mul(sy).toVar();
    const total = sxy.mul(sz).toVar();
    // Half extent plus a hair, exactly as `occupancyField`'s conservativeEps: a
    // triangle lying ON a voxel face is counted rather than lost to a float tie.
    const h = vec3(0.5 + 1e-4).toVar();
    const levelBase = levelBaseOf(level).toVar();

    Loop({ start: 0, end: BRICK_VOXELS, name: "voxK" }, ({ voxK }) => {
      const k = uint(voxK).toVar();
      If(k.greaterThanEqual(total), () => { Break(); });
      const kz = k.div(sxy).toVar();
      const r = k.sub(kz.mul(sxy)).toVar();
      const ky = r.div(sx).toVar();
      const kx = r.sub(ky.mul(sx)).toVar();
      const cx = lo.x.add(kx.toFloat()).toVar();
      const cy = lo.y.add(ky.toFloat()).toVar();
      const cz = lo.z.add(kz.toFloat()).toVar();
      If(triBoxOverlapFn(vec3(cx.add(0.5), cy.add(0.5), cz.add(0.5)), h, q0, q1, q2).greaterThan(0.5), () => {
        const lx = cx.sub(bc.x).toUint().toVar();
        const ly = cy.sub(bc.y).toUint().toVar();
        const lz = cz.sub(bc.z).toUint().toVar();
        const vi = voxIndexIn(b, lx, ly, lz).toVar();
        atomicOr(
          winAtomics.element(levelBase.add(uint(OCC_OFF)).add(shiftRight(vi, uint(5)))),
          shiftLeft(uint(1), bitAnd(vi, uint(31))),
        );
        const byteShift = bitAnd(vi, uint(3)).mul(uint(8)).toVar();
        atomicOr(
          winAtomics.element(levelBase.add(uint(FACE_OFF)).add(shiftRight(vi, uint(2)))),
          shiftLeft(faceMask, byteShift),
        );
        If(palByte.notEqual(uint(PAL_NONE)), () => {
          If(float(palModeU).greaterThan(0.5), () => {
            // THE SHIPPING PATH: one u32 per voxel of scratch, where `max` is
            // per-byte correct because there is only one byte in the word.
            // `+1` keeps 0 as "nothing wrote here" for the pack; the SAT tag
            // puts an exact palette above any dust index the same voxel
            // collected, so `max` expresses "prefer the measured surface".
            atomicMax(
              wk.element(uint(SCR_OFF).add(slot.mul(uint(BRICK_VOXELS)))
                .add(lx.add(ly.mul(uint(4))).add(lz.mul(uint(16))))),
              bitOr(uint(SCR_TAG_SAT), palByte.add(uint(1))),
            );
          }).Else(() => {
            // THE CONTROL ARM: the naive packed atomicMax §K.3 reads as if it
            // worked. The probe counts the bytes it corrupts.
            atomicMax(
              winAtomics.element(levelBase.add(uint(PAL_OFF)).add(shiftRight(vi, uint(2)))),
              shiftLeft(palByte, byteShift),
            );
          });
        });
      });
    });
  })().compute(PAIRS_CAP);

  // ══════════════════════════════════════════════════════ PASS: finishBricks
  //
  // One thread per dirty-list entry. A BUILDING brick merges its palette out of
  // the scratch and then gets its VERDICT from the pair cursor: 0 means it
  // enumerated everything, so it ORs its 64 occ bits into `brickMask` and
  // becomes BUILT; anything else means the budget ran out mid-brick, so it goes
  // back to DIRTY with its mask still clear and resumes next frame.
  //
  // THE PACK IS A MERGE, AND THAT IS WHAT MAKES RESUMING SAFE. It reads the
  // brick's four-voxel `pal` word, overwrites only the bytes the scratch
  // actually claimed, and takes `max(existing, new)` when both are real —
  // exactly the rule `voxelize`'s `atomicMax` applies inside one frame, so a
  // brick built over five frames lands on the SAME byte a one-frame build
  // produces. Anything less than that would make the carry-over receipt's
  // "bit-identical" true of `occ` and quietly false of `pal`.
  //
  // The brick owns the word outright (four x-consecutive voxels inside it) and
  // `voxelize` has finished, so the read-modify-write needs no atomic.
  //
  // Bindings: work, window, counters, triPal = 4 — `triPal` is here rather than
  // in `binPairs` because THIS pass has room in the portable envelope and that
  // one does not; it is the whole reason dust rides as a triangle index.
  const finishBricksPass = Fn(() => {
    const i = instanceIndex.toVar();
    const dirty = atomicLoad(ct.element(uint(CTR_DIRTY))).toVar();
    If(i.greaterThanEqual(dirty.min(uint(MAX_DIRTY))), () => { Return(); });
    const id = atomicLoad(wk.element(uint(DIR_OFF).add(i))).toVar();
    const level = shiftRight(id, uint(12)).toVar();
    const b = bitAnd(id, uint(BRICKS_PER_LEVEL - 1)).toVar();
    const tab = tabBaseOf(level, b).toVar();
    If(atomicLoad(winAtomics.element(tab.add(uint(1)))).notEqual(uint(STATE_BUILDING)), () => { Return(); });

    const levelBase = levelBaseOf(level).toVar();
    // NOT gated on `palMode` any more. The control arm withholds the SCRATCH
    // from the SAT path only; dust always goes through the scratch (it has no
    // other way home), so the pack has to run in both arms or the control would
    // report dust voxels as corrupt and "fail" for a reason that has nothing to
    // do with the packed atomicMax it exists to indict.
    const hasSlot = i.lessThan(uint(MAX_BUILD));
    const any = uint(0).toVar();
    const setCount = uint(0).toVar();

    // ⭐⭐ THE SAT-OVER-DUST PRECEDENCE LIVES IN THE SCRATCH, AND THE SCRATCH
    // IS PER-FRAME. `SCR_TAG_SAT > SCR_TAG_DUST` decides the winner inside one
    // frame's `atomicMax`; the moment the pack writes the winner into `pal` the
    // tag is gone, and the byte is just a number. So a brick split across
    // instalments could pack a DUST palette first (in a frame whose slice held
    // no SAT triangle for that voxel) and then meet the exact SAT palette in a
    // later frame, where `max(existing, new)` is a comparison of two indices
    // with no notion of which is exact — and the dust index wins whenever it is
    // numerically larger. Measured at ultra: level 3 voxels (0,62,0) and
    // (1,62,0), which the FLOOR (SAT, palette 1) and the SPHERE (dust at a 2 m
    // cell, palette 8) both reach, came out 8 in the resumed build and 1 in the
    // one-frame build. It fires at 4 of 6 pair caps and at none of the others,
    // which is why one run of the probe could pass and the next fail.
    //
    // The rule that restores the precedence WITHOUT a provenance bit in the
    // byte: a SAT scratch entry merges on every instalment (SAT-over-SAT is a
    // `max` in both builds, so the order cannot matter), and a DUST entry is
    // held back until the brick's LAST instalment, where it fills only a byte
    // nothing has claimed. That is exactly what the scratch's tag says, spread
    // over frames: dust never overwrites a measured surface, and a voxel no SAT
    // triangle ever reached still gets its dust palette. A half-built brick's
    // `brickMask` bit is clear, so the byte being provisionally empty for a
    // frame or two is invisible to the trace.
    const curWord = uint(CUR_OFF).add(level.mul(uint(BRICKS_PER_LEVEL))).add(b).toVar();
    const cursorNow = atomicLoad(wk.element(curWord)).toVar();
    const done = cursorNow.equal(uint(0)).toVar();
    // "Nothing has claimed this byte" is the sentinel `binPairs` cleared to,
    // and the two arms clear to different ones (see the clear's own note).
    const noneByte = select(float(palModeU).greaterThan(0.5), uint(PAL_NONE), uint(0)).toVar();

    Loop({ start: 0, end: BRICK * BRICK, name: "finRow" }, ({ finRow }) => {
      const ly = bitAnd(uint(finRow), uint(3)).toVar();
      const lz = shiftRight(uint(finRow), uint(2)).toVar();
      const vi = voxIndexIn(b, uint(0), ly, lz).toVar();
      const nib = bitAnd(
        shiftRight(atomicLoad(winAtomics.element(levelBase.add(uint(OCC_OFF)).add(shiftRight(vi, uint(5))))),
          bitAnd(vi, uint(31))),
        uint(0xf),
      ).toVar();
      any.assign(bitOr(any, nib));
      setCount.addAssign(bitAnd(nib, uint(1)));
      setCount.addAssign(bitAnd(shiftRight(nib, uint(1)), uint(1)));
      setCount.addAssign(bitAnd(shiftRight(nib, uint(2)), uint(1)));
      setCount.addAssign(bitAnd(shiftRight(nib, uint(3)), uint(1)));
      // The four pal bytes of this row, MERGED out of the scratch (see the
      // header): untouched bytes keep what is there, a byte the scratch claimed
      // takes `max(existing, new)` unless the existing byte is the PAL_NONE
      // sentinel, which is 255 and would win a bare max against every real
      // palette index.
      If(hasSlot, () => {
        const palWord = levelBase.add(uint(PAL_OFF)).add(shiftRight(vi, uint(2))).toVar();
        const sbase = uint(SCR_OFF).add(slotOfRow(i, ly, lz)).toVar();
        const word = atomicLoad(winAtomics.element(palWord)).toVar();
        for (let k = 0; k < 4; k++) {
          const s = atomicLoad(wk.element(sbase.add(uint(k)))).toVar();
          If(s.notEqual(uint(0)), () => {
            const payload = bitAnd(s, uint(SCR_VALUE_MASK)).sub(uint(1)).toVar();
            // DUST resolves its palette HERE, through `triPal`, because
            // `binPairs` had no binding left to read it with.
            const dustPal = bitAnd(
              shiftRight(triPal.element(shiftRight(payload, uint(2))), bitAnd(payload, uint(3)).mul(uint(8))),
              uint(255),
            ).toVar();
            const isSat = bitAnd(s, uint(SCR_TAG_SAT)).notEqual(uint(0)).toVar();
            const fresh = select(isSat, payload, dustPal).toVar();
            const cur = bitAnd(shiftRight(word, uint(k * 8)), uint(255)).toVar();
            // PAL_NONE is 255 and would win a bare `max` against every real
            // index, in BOTH directions: a material-less dust triangle must not
            // erase a real palette, and a real palette must not lose to the
            // sentinel the clear left behind. `voxelize` can guard its own side
            // (it holds the byte); dust cannot, so the guard lives here.
            //
            // …and DUST waits for the closing instalment, into an unclaimed
            // byte only — see the note above `curWord`.
            const takeIt = fresh.notEqual(uint(PAL_NONE))
              .and(isSat.or(done.and(cur.equal(noneByte)))).toVar();
            const merged = select(
              takeIt,
              select(cur.equal(uint(PAL_NONE)), fresh, cur.max(fresh)),
              cur,
            ).toVar();
            word.assign(bitOr(bitAnd(word, uint(~(255 << (k * 8)) >>> 0)), shiftLeft(merged, uint(k * 8))));
          });
        }
        atomicStore(winAtomics.element(palWord), word);
      });
    });

    // THE VERDICT. `binPairs` stores 0 in the pair cursor when the brick
    // enumerated everything it owed and the running count otherwise, so this one
    // word is the whole completion test — no second flag that could disagree.
    // It is read ONCE, above, because the palette merge needs the same answer.
    If(cursorNow.notEqual(uint(0)), () => {
      // Mid-brick: back to DIRTY, mask left CLEAR. A half-built brick is
      // invisible to the trace for a frame or two, which is what the budget
      // buys; showing half of it would be a wrong answer rather than a late one.
      atomicStore(winAtomics.element(tab.add(uint(1))), uint(STATE_DIRTY));
      Return();
    });

    If(any.notEqual(uint(0)), () => {
      atomicOr(
        winAtomics.element(levelBase.add(uint(BMASK_OFF)).add(shiftRight(b, uint(5)))),
        shiftLeft(uint(1), bitAnd(b, uint(31))),
      );
    });
    atomicStore(winAtomics.element(tab.add(uint(1))), uint(STATE_BUILT));
    atomicAdd(ct.element(uint(CTR_BUILT)), uint(1));
    atomicAdd(ct.element(uint(CTR_LEVEL_BUILT).add(level)), uint(1));
    atomicAdd(ct.element(uint(CTR_VOXELS)), setCount);
  })().compute(MAX_DIRTY);

  /** Scratch word offset of the four voxels of row (ly, lz) in brick slot `i`. */
  function slotOfRow(i, ly, lz) {
    return i.mul(uint(BRICK_VOXELS)).add(ly.mul(uint(4))).add(lz.mul(uint(16)));
  }

  // ── the public surface ────────────────────────────────────────────────────
  const tmpV = new THREE.Vector3();

  const setLevelBudget = (level, pairs) => {
    if (level >= 0 && level < levels) levelBudgetU[level].value = Math.max(0, Math.min(PAIRS_CAP, pairs));
  };

  return {
    tier, PAIRS_CAP, MAX_BUILD, MAX_DIRTY, MAX_CELLS, CELLS_AXIS, NBUCKETS,
    workWords: WORK_WORDS, workBytes: WORK_WORDS * 4,
    ctrBuffer: ctrBuf, ctrAttribute: ctrAttr, workBuffer: work, workAttribute: workAttr,
    STATE_BUILDING, CULL_FRACTION,
    // The 13-axis SAT ITSELF, not a copy of it. `sharedFn` keys its per-builder
    // instances on the closure returned at construction, so Stage 2.5's dynamic
    // voxelizer calling THIS handle emits the same `gi2TriBox` function — the
    // "second call site by construction" the SAT's own comment anticipated.
    triBoxOverlapFn,

    /** Every brick of every static level becomes DIRTY. Scene load / edit. */
    markAllDirty: () => markAllDirtyPass,

    /**
     * The frame's compute nodes, in order. The caller dispatches them itself
     * (`renderer.compute(node)` per entry) so the voxelizer can be folded into
     * whatever batch GISystem already submits.
     *
     * @param {Array|THREE.Vector3} camPos
     * @param {Array<Array<number>>|null} frustum  6 planes [a,b,c,d], inside is
     *   `dot(n,p) + d >= 0`; null disables the frustum term (everything counts
     *   as visible, which is what a boot fill wants).
     */
    passes(camPos, frustum = null) {
      if (camPos) {
        const p = Array.isArray(camPos) ? tmpV.set(camPos[0], camPos[1], camPos[2]) : camPos;
        camPosU.value.copy(p);
      }
      if (frustum && frustum.length === 6) {
        frustumOnU.value = 1;
        for (let i = 0; i < 6; i++) planesU[i].value.set(frustum[i][0], frustum[i][1], frustum[i][2], frustum[i][3]);
      } else {
        frustumOnU.value = 0;
      }
      return [
        resetCtrPass, resetWorkPass,
        dirtyCountPass, dirtyPrefixPass, dirtyScatterPass,
        binPairsPass, voxelizePass, finishBricksPass,
      ];
    },

    /** Order coarse levels first (boot) or fine levels first (steady state). */
    setCoarseFirst(on) { coarseFirstU.value = on ? 1 : 0; },
    /** Per-level pair budget, in pairs. Stage 2.5's dynamic split lives here. */
    setLevelBudget,
    /** Lower the per-frame pair cap WITHOUT re-allocating — the overflow gate. */
    setPairLimit(n) { pairLimitU.value = Math.max(1, Math.min(PAIRS_CAP, n)); },
    /** 1 = the scratch+pack palette (shipping), 0 = the naive packed atomicMax. */
    setPalMode(mode) { palModeU.value = mode ? 1 : 0; },
    /** Harness-only: withhold the face bits so the entry-face test finds nothing. */
    setFaceBits(on) { faceBitsU.value = on ? 1 : 0; },
    /**
     * The per-level cull, on (shipping) or off (Stage 2.3's behaviour). Off
     * sends the dust threshold to 0, which no extent is below, so every triangle
     * takes the pair path — the control arm the before/after frames table needs
     * in the SAME session.
     */
    setCull(on) { cullOnU.value = on ? 1 : 0; },

    /** The per-frame receipt (§K.8). A 144-byte readback, not the work buffer. */
    async stats(renderer) {
      const a = new Uint32Array(await renderer.getArrayBufferAsync(ctrAttr));
      const perLevel = [];
      for (let l = 0; l < levels; l++) {
        perLevel.push({
          level: l,
          dirty: a[CTR_LEVEL_DIRTY + l],
          built: a[CTR_LEVEL_BUILT + l],
          // RESERVED, not written: the reserve advances this by a brick's whole
          // remaining demand and then takes only what the budget had room for,
          // so the honest per-frame work number is `pairsWritten`.
          pairs: a[CTR_LEVEL_PAIRS + l],
          dust: a[CTR_LEVEL_DUST + l],
        });
      }
      return {
        dirty: a[CTR_DIRTY],
        built: a[CTR_BUILT],
        pairs: Math.min(a[CTR_PAIRS], PAIRS_CAP),
        pairsCursor: a[CTR_PAIRS],
        pairsNeeded: a[CTR_NEEDED],
        pairsWritten: a[CTR_WRITTEN],
        maxBrickPairs: a[CTR_MAXNEED],
        deferred: a[CTR_DEFER],
        overflowed: a[CTR_OVERFLOW],
        starved: a[CTR_STARVED],
        slotFull: a[CTR_SLOTFULL],
        cellOverflow: a[CTR_CELLOVF],
        invalid: a[CTR_INVALID],
        voxelsSet: a[CTR_VOXELS],
        dustVoxels: a[CTR_DUST],
        resumed: a[CTR_RESUMED],
        maxCursor: a[CTR_MAXCURSOR],
        perLevel,
      };
    },

    describe: () => ({
      tier, levels, pairsPerFrame: PAIRS_CAP, maxBuild: MAX_BUILD, maxDirty: MAX_DIRTY,
      buckets: NBUCKETS, maxCells: MAX_CELLS, cellsAxis: CELLS_AXIS,
      coarseBrickMetres: COARSE_BRICK_M,
      cullFraction: CULL_FRACTION,
      dustLimits: Array.from({ length: levels }, (_, l) => +(voxel0 * Math.pow(2, l) * CULL_FRACTION).toFixed(4)),
      workMB: +((WORK_WORDS * 4) / 1048576).toFixed(3),
      scratchMB: +((SCR_WORDS * 4) / 1048576).toFixed(3),
      cursorKB: +((CUR_WORDS * 4) / 1024).toFixed(1),
      pairListMB: +((PAIR_WORDS * 4) / 1048576).toFixed(3),
    }),

    dispose() {
      workAttr.array = new Uint32Array(0);
      workAttr.dispose?.();
      ctrAttr.array = new Uint32Array(0);
      ctrAttr.dispose?.();
    },
  };
}
