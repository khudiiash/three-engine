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
import * as THREE from "three/webgpu";
import {
  Break, Fn, If, Loop, Return, atomicAdd, atomicAnd, atomicLoad, atomicMax, atomicOr, atomicStore,
  bitAnd, bitNot, bitOr, exp2, float, instanceIndex, instancedArray, int, select, shiftLeft,
  shiftRight, storage, uint, uniform, vec3, vec4,
} from "three/tsl";
import { sharedFn } from "../giFn.js";
import {
  BMASK_OFF, BRICK, BRICKS_PER_LEVEL, BTAB_OFF, FACE_OFF, LEVEL_WORDS, OCC_OFF, PAL_NONE,
  PAL_NONE_WORD, PAL_OFF, STATE_BUILT, STATE_DIRTY, WB_BIAS, WB_MASK, WB_VALID,
} from "./windowStore.js";

/**
 * `brickTab` word 1, the state this file adds.
 *
 * BUILDING is not decoration: `finishBricks` has to tell "accepted by
 * `binPairs` this frame, its pairs are in the list" apart from "still DIRTY,
 * nothing written" and from "BUILT earlier, do not touch". With two values it
 * would either re-finish every BUILT brick every frame or promote bricks whose
 * pairs never ran.
 *
 * ▶ STORE CHANGE NEEDED: this belongs beside STATE_EMPTY_DIRTY / STATE_DIRTY /
 * STATE_BUILT in `windowStore.js`. It lives here only because Stage 2.3 may not
 * edit that file. Value 3 is free — the store only ever compares states with
 * `!=` or `<`, and `windowFill`'s `atomicMax(…, STATE_BUILT)` is a harness path
 * that never meets a triangle-voxelized brick.
 */
export const STATE_BUILDING = 3;

/** Voxels in a brick — 64, the pal scratch's stride. */
export const BRICK_VOXELS = BRICK * BRICK * BRICK;

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
export const CTR_STARVED = 4; // rejected: needs more pairs than the WHOLE cap
export const CTR_NEEDED = 5; // Σ pairsNeeded over every dirty brick scanned
export const CTR_WRITTEN = 6; // Σ pairsWritten
export const CTR_SLOTFULL = 7; // rejected: dirty index ≥ maxBuild, no scratch slot
export const CTR_CELLOVF = 8; // a brick's grid-cell span exceeded the tier's loop bound
export const CTR_INVALID = 9; // brickTab slot with no VALID marker (scroll never ran)
export const CTR_VOXELS = 10; // voxels the SAT actually set this frame
export const CTR_MAXNEED = 11; // the largest pairsNeeded any ONE brick asked for
export const CTR_DEFER = 17; // bricks that never walked: the budget was already spent
export const CTR_LEVEL_DIRTY = 12; // + level
export const CTR_LEVEL_PAIRS = 20; // + level
export const CTR_LEVEL_BUILT = 28; // + level
export const CTR_WORDS = 36;

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

  // ── the work buffer: buckets + pal scratch + dirty list + pair list ────────
  // ONE binding at tier-constant offsets — the same argument `windowStore.js`
  // makes for the window, and the reason `binPairs` fits the portable envelope
  // with four soup buffers alongside it.
  const BKT_OFF = 0;
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

  const resetWorkPass = Fn(() => {
    atomicStore(wk.element(instanceIndex), uint(0));
  })().compute(WORK_WORDS);

  // ═════════════════════════════════════════════════════ PASS: markAllDirty
  // One thread per (level, brick): state ← DIRTY, `wb` untouched. Scene load,
  // geometry edit and the harness's "do it all again" all land here.
  const markAllDirtyPass = Fn(() => {
    const level = shiftRight(instanceIndex, uint(12)).toVar();
    const b = bitAnd(instanceIndex, uint(BRICKS_PER_LEVEL - 1)).toVar();
    atomicStore(winAtomics.element(tabBaseOf(level, b).add(uint(1))), uint(STATE_DIRTY));
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
    // could drift apart under a later edit.
    const need = uint(0).toVar();
    const base = uint(0).toVar();
    const written = uint(0).toVar();
    const slotOk = float(0).toVar();

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
          const take = aabbHitFn(tlo, thi, bmin, bmax).greaterThan(0.5)
            .and(own.x.toUint().equal(gx)).and(own.y.toUint().equal(gy)).and(own.z.toUint().equal(gz));
          If(take, () => {
            if (mode === 0) {
              need.addAssign(1);
            } else {
              If(cursor.lessThan(need), () => {
                const w = uint(PAIR_OFF).add(base.add(cursor).mul(uint(2))).toVar();
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
    // The largest single-brick demand in the frame. A cap below THIS number can
    // never finish that brick, and the overflow arm has to pick its artificial
    // cap above it or it is measuring starvation, not carry-over.
    atomicMax(ct.element(uint(CTR_MAXNEED)), need);

    // ── the reserve ──────────────────────────────────────────────────────
    const accept = float(0).toVar();
    If(need.equal(uint(0)), () => {
      // No triangles at all: no scratch slot, no budget, always accepted. This
      // is what lets an empty window drain in a couple of frames instead of
      // queueing 16 384 nothings behind MAX_BUILD.
      accept.assign(1);
    }).Else(() => {
      If(i.greaterThanEqual(uint(MAX_BUILD)), () => {
        atomicAdd(ct.element(uint(CTR_SLOTFULL)), uint(1));
      }).Else(() => {
        If(need.toFloat().greaterThan(float(pairLimitU)), () => {
          // Cannot fit even with the whole frame to itself — it would spin
          // forever, so it is NAMED rather than silently retried.
          atomicAdd(ct.element(uint(CTR_STARVED)), uint(1));
        }).Else(() => {
          const lvBase = atomicAdd(ct.element(uint(CTR_LEVEL_PAIRS).add(level)), need).toVar();
          If(lvBase.add(need).toFloat().greaterThan(levelBudgetAt(level)), () => {
            atomicAdd(ct.element(uint(CTR_OVERFLOW)), uint(1));
          }).Else(() => {
            base.assign(atomicAdd(ct.element(uint(CTR_PAIRS)), need));
            If(base.add(need).toFloat().greaterThan(float(pairLimitU)), () => {
              atomicAdd(ct.element(uint(CTR_OVERFLOW)), uint(1));
            }).Else(() => {
              accept.assign(1);
              slotOk.assign(1);
            });
          });
        });
      });
    });

    If(accept.greaterThan(0.5), () => {
      // CLEAR the brick's own voxels before anything re-writes them. 16 rows of
      // four x-consecutive voxels: `face` words are owned outright and stored;
      // the `occ` nibble and the brickMask bit share a word with neighbours and
      // are merged with atomicAnd.
      const levelBase = levelBaseOf(level).toVar();
      atomicAnd(
        winAtomics.element(levelBase.add(uint(BMASK_OFF)).add(shiftRight(b, uint(5)))),
        bitNot(shiftLeft(uint(1), bitAnd(b, uint(31)))),
      );
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
        // overwrites it from the scratch, so this only matters if the brick
        // ends up empty) and to 0 on the CONTROL path, because the naive packed
        // `atomicMax` can never lower a byte and would otherwise leave every
        // voxel reading 255 — a control arm that fails for the wrong reason
        // proves nothing about the arm it is controlling.
        atomicStore(
          winAtomics.element(levelBase.add(uint(PAL_OFF)).add(shiftRight(vi, uint(2)))),
          select(float(palModeU).greaterThan(0.5), uint(PAL_NONE_WORD), uint(0)),
        );
      });
      If(slotOk.greaterThan(0.5), () => {
        walk(1);
        atomicAdd(ct.element(uint(CTR_WRITTEN)), written);
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
            // `+1` keeps 0 as "nothing wrote here" for the pack.
            atomicMax(
              wk.element(uint(SCR_OFF).add(slot.mul(uint(BRICK_VOXELS)))
                .add(lx.add(ly.mul(uint(4))).add(lz.mul(uint(16))))),
              palByte.add(uint(1)),
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
  // One thread per dirty-list entry. A BUILDING brick ORs its 64 occ bits into
  // `brickMask`, packs its palette out of the scratch, and becomes BUILT.
  // Bindings: work, window, counters = 3.
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
    const hasSlot = i.lessThan(uint(MAX_BUILD)).and(float(palModeU).greaterThan(0.5));
    const any = uint(0).toVar();
    const setCount = uint(0).toVar();

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
      // The four pal bytes of this row, straight out of the scratch. The brick
      // owns this word (four x-consecutive voxels inside it), so this is a
      // plain store: no read, no merge, no atomic contention.
      If(hasSlot, () => {
        const sbase = uint(SCR_OFF).add(slotOfRow(i, ly, lz)).toVar();
        const word = uint(0).toVar();
        for (let k = 0; k < 4; k++) {
          const s = atomicLoad(wk.element(sbase.add(uint(k)))).toVar();
          word.assign(bitOr(word, shiftLeft(select(s.greaterThan(uint(0)), s.sub(uint(1)), uint(PAL_NONE)),
            uint(k * 8))));
        }
        atomicStore(winAtomics.element(levelBase.add(uint(PAL_OFF)).add(shiftRight(vi, uint(2)))), word);
      });
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
    STATE_BUILDING,

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

    /** The per-frame receipt (§K.8). A 144-byte readback, not the work buffer. */
    async stats(renderer) {
      const a = new Uint32Array(await renderer.getArrayBufferAsync(ctrAttr));
      const perLevel = [];
      for (let l = 0; l < levels; l++) {
        perLevel.push({
          level: l,
          dirty: a[CTR_LEVEL_DIRTY + l],
          built: a[CTR_LEVEL_BUILT + l],
          pairs: a[CTR_LEVEL_PAIRS + l],
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
        perLevel,
      };
    },

    describe: () => ({
      tier, levels, pairsPerFrame: PAIRS_CAP, maxBuild: MAX_BUILD, maxDirty: MAX_DIRTY,
      buckets: NBUCKETS, maxCells: MAX_CELLS, cellsAxis: CELLS_AXIS,
      coarseBrickMetres: COARSE_BRICK_M,
      workMB: +((WORK_WORDS * 4) / 1048576).toFixed(3),
      scratchMB: +((SCR_WORDS * 4) / 1048576).toFixed(3),
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
