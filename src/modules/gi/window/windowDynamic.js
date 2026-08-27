// GI2 — THE DYNAMIC LAYER (plan §5 Stage 2.5, audits §K.5)
//
// Movers — the `dynamicObjects` adoption set and `skinnedProxy`'s bone boxes —
// are voxelized EVERY FRAME into the window's two mirror slots (L0 and L1), from
// their own small LOCAL-space triangle soups transformed by their per-frame
// matrix. `windowTrace` already ORs those slots into both the occupancy test and
// the entry-face test at L0/L1 (commit ee6b4c0), so nothing downstream changes:
// a ray simply stops on a mover the same way it stops on a wall.
//
// ══ WHY A MOVER GETS NO HISTORY, AND WHY THAT IS THE POINT ═══════════════════
//
// The static layer is incremental: a brick is voxelized once and kept until
// something invalidates it. A mover cannot be. Its bits are not "slightly out of
// date" between frames, they are IN THE WRONG PLACE — the classic re-voxelized-
// mover artefact is a solid trailing its own ghost. So the dynamic slots are
// CLEARED WHOLE every frame and rebuilt from the current matrices, and the face
// bits are recomputed from the TRANSFORMED normals rather than carried: a
// rotating panel changes which axes it blocks, and a cached face byte would keep
// blocking the axis it faced last frame.
//
// That is also why the layer is SEPARATE from the static one rather than being
// written into it. §K.5's rule is that a mover's brick in the static layer is
// never touched: the wall behind a walking character keeps its bits, the
// character's own bits vanish the instant it moves, and when the mover goes
// quiet the existing adoption rule hands it back to the static path, which
// marks those bricks DIRTY exactly once.
//
// ══ WHY THE BUDGET IS ENFORCED AT SET-UP AND NOT PER FRAME ═══════════════════
//
// Everywhere else in §19 a budget means "do part of the work this frame and the
// rest next frame". Here that would be a bug, not a budget: half a mover is a
// mover with a hole in it, every frame, forever — there is no later frame in
// which it completes, because the next frame clears it and starts again.
//
// So `DYN_PAIRS_PER_FRAME` is spent by `setMovers`, not by the kernel. The
// dispatch is a TIER CONSTANT (`dynLevels × MAX_DYN_TRIS`) and the set of movers
// is cut to fit it: over budget, the LARGEST movers are demoted to their box
// proxy (12 triangles — the same shape `skinnedProxy` already hands GI for a
// rigged character), largest first, and only if that is still not enough are
// they dropped. Both counts are receipts, so "the mover set did not fit" is a
// number rather than a silently missing object.
//
// ══ THE PALETTE, AND THE 2 MB THIS FILE SPENDS ON IT ═════════════════════════
//
// `pal` is one byte per voxel and its merge is MAX, and `windowVoxelize.js`'s
// header proves at length that `atomicMax` on the PACKED word is not per-byte
// max (a high lane's value masks a low lane's, and TSL has no compare-exchange).
// The static path solves it with a per-BRICK scratch, sized by how many bricks
// can complete in one frame. The dynamic path has no such bound — it rebuilds
// two whole levels every frame — so its scratch is one u32 per voxel of the two
// mirror levels: 2 MB, the honest price of a correct palette on movers.
//
// It costs no extra dispatch: `dynPack` reads each scratch word, packs the four
// bytes, and ZEROES the word it just read, so the scratch is already clean when
// the next frame's voxelize runs. A separate clear pass would have been 2 MB of
// writes for nothing.
//
// ══ ONE SAT, NOT TWO ═════════════════════════════════════════════════════════
//
// The 13-axis triangle/box test comes from the voxelizer's own `triBoxOverlapFn`
// handle, not from a copy: `sharedFn` keys its per-builder instances on the
// closure, so calling that handle here emits the SAME `gi2TriBox` WGSL function
// the static path uses. A second implementation of the SAT is exactly the kind
// of duplicate that drifts — one gets the conservative epsilon fixed and the
// other does not, and the difference shows up as movers that are half a voxel
// thinner than walls.
import {
  Break, Fn, If, Loop, Return, atomicAdd, atomicLoad, atomicMax, atomicOr, atomicStore, bitAnd,
  bitOr, exp2, float, instanceIndex, instancedArray, int, select, shiftLeft, shiftRight, storage,
  uint, uniform, vec3,
} from "three/tsl";
import {
  BMASK_OFF, BRICK, FACE_OFF, LEVEL_WORDS, N, OCC_OFF, PAL_NONE, PAL_OFF, PAL_WORDS,
  VOXELS_PER_LEVEL,
} from "./windowStore.js";
import { buildTriangleSoup } from "./triangleSoup.worker.js";

/**
 * Per-tier dynamic budget (§K.5 + the Stage 2.5 task).
 *
 * `dynPairsPerFrame` counts (level, triangle) work items — the dynamic layer's
 * unit of SAT work, the same thing a static (brick, triangle) pair is. It is the
 * DISPATCH SIZE, so it is a tier constant baked into the WGSL exactly like every
 * other size in §19.
 */
export const GI2_DYN_TIERS = {
  phone: { maxMovers: 16, dynPairsPerFrame: 8 * 1024 },
  medium: { maxMovers: 16, dynPairsPerFrame: 8 * 1024 },
  high: { maxMovers: 64, dynPairsPerFrame: 32 * 1024 },
  ultra: { maxMovers: 64, dynPairsPerFrame: 32 * 1024 },
};

/**
 * The most triangles ONE mover contributes. Above it the mover is represented by
 * its box — which is what `skinnedProxy` already does for a rigged character,
 * and what a 200 k-triangle vehicle should do too: a mover's job in the window
 * is to OCCLUDE, and past a few thousand triangles the extra ones land in voxels
 * their neighbours already set.
 */
export const MAX_MOVER_TRIS = 4096;

/**
 * The per-triangle voxel-span bound. A mover triangle bigger than this at L0 is
 * a moving building, and it gets clipped rather than allowed to make one thread
 * unbounded; `spanOverflow` counts every time it happens so the constant can be
 * argued with from data instead of taste.
 */
export const DYN_SPAN_MAX = 1024;

// ── counters, in the head of the scratch buffer (see the header) ─────────────
export const DYN_CTR_TRIS = 0; // (level, triangle) items that ran the SAT
export const DYN_CTR_VOXELS = 1; // voxels the SAT set
export const DYN_CTR_SPANOVF = 2; // triangles whose span hit DYN_SPAN_MAX
export const DYN_CTR_OUTSIDE = 3; // triangles wholly outside this level's window
export const DYN_CTR_DEGEN = 4; // zero-area after transform
export const DYN_CTR_WORDS = 8;

/** 12 triangles of an axis-aligned box shell, in the order `windowFill` uses. */
export function boxTriangles(min, max, out = new Float32Array(12 * 9)) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [
    [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
    [1, 5, 6, 2], [4, 5, 1, 0], [3, 2, 6, 7],
  ];
  let o = 0;
  const put = (p) => { out[o++] = p[0]; out[o++] = p[1]; out[o++] = p[2]; };
  for (const q of quads) {
    put(v[q[0]]); put(v[q[1]]); put(v[q[2]]);
    put(v[q[0]]); put(v[q[2]]); put(v[q[3]]);
  }
  return out;
}

/**
 * A mover's LOCAL-space soup, built ONCE.
 *
 * The grid `buildTriangleSoup` also produces is deliberately thrown away: a
 * mover is small enough that the dynamic kernel walks all of its triangles, and
 * a 4 m cell grid over a 2 m character is one cell that indexes nothing. What is
 * wanted from the 2.2 function is its LARGEST-FIRST cap rule and its degenerate
 * rejection — re-implementing either here is how two code paths start
 * disagreeing about what a triangle is.
 *
 * @param {object} input `{geometries, placements}` exactly as `buildTriangleSoup`
 *   takes them, but with LOCAL matrices (identity for a single-geometry mover).
 * @param {number[][]} [box] `[min, max]` local-space fallback proxy.
 * @param {number} [pal] palette byte for the box fallback.
 */
export function buildMoverSoup(input, box = null, pal = PAL_NONE) {
  const soup = buildTriangleSoup({ ...input, triCap: MAX_MOVER_TRIS });
  // TRUNCATED means the mover did not fit its own cap, so what came back is a
  // PREFIX of it — a character with no legs rather than a smaller character.
  // The box is the honest answer there, and it is the skinned-proxy case
  // arriving by a different road.
  if (soup.triCount > 0 && !soup.truncated) {
    return { triCount: soup.triCount, tris: soup.tris, triPal: soup.triPal, boxed: false };
  }
  if (!box) return { triCount: 0, tris: new Float32Array(0), triPal: new Uint32Array(1), boxed: false };
  return moverBoxSoup(box[0], box[1], pal);
}

/** The 12-triangle box proxy as a mover soup. */
export function moverBoxSoup(min, max, pal = PAL_NONE) {
  const tris = boxTriangles(min, max);
  const triPal = new Uint32Array(3); // 12 triangles = 3 words of 4 bytes
  const byte = pal & 255;
  triPal.fill((byte | (byte << 8) | (byte << 16) | (byte << 24)) >>> 0);
  return { triCount: 12, tris, triPal, boxed: true };
}

/**
 * Builds the dynamic layer for one window.
 *
 * @param {object} win from `createGiWindow` (needs `dynLevels > 0`)
 * @param {object} voxelizer from `createWindowVoxelizer` — used for its SAT
 *   handle, so both layers compile ONE `gi2TriBox`
 * @param {string} [tier] defaults to the window's own tier
 * @param {object} [opts]
 * @param {number} [opts.maxMovers]
 * @param {number} [opts.dynPairsPerFrame]
 */
export function createWindowDynamic(win, voxelizer, tier = win.tier, opts = {}) {
  const spec = GI2_DYN_TIERS[tier] ?? GI2_DYN_TIERS.high;
  const MAX_MOVERS = opts.maxMovers ?? spec.maxMovers;
  const DYN_PAIRS_PER_FRAME = opts.dynPairsPerFrame ?? spec.dynPairsPerFrame;

  const { levels, dynLevels, voxel0, atomics: winAtomics, originAt } = win;
  if (dynLevels < 1) throw new Error("createWindowDynamic: the window has no dynamic slots");
  if (!voxelizer?.triBoxOverlapFn) {
    throw new Error("createWindowDynamic: the voxelizer must expose triBoxOverlapFn (Stage 2.5)");
  }
  const triBoxOverlapFn = voxelizer.triBoxOverlapFn;

  /** Triangles per level slot — the dispatch is `dynLevels × this`. */
  const MAX_DYN_TRIS = Math.max(64, Math.floor(DYN_PAIRS_PER_FRAME / dynLevels));

  // ── buffers ───────────────────────────────────────────────────────────────
  const trisArr = new Float32Array(MAX_DYN_TRIS * 9);
  const dynTris = instancedArray(trisArr, "float");
  // `slot | pal << 8` — one word per triangle rather than two buffers, because
  // the voxelize kernel's binding count is the scarce thing here.
  const metaArr = new Uint32Array(MAX_DYN_TRIS);
  const dynMeta = instancedArray(metaArr, "uint");
  const xformArr = new Float32Array(MAX_MOVERS * 16);
  const dynXform = instancedArray(xformArr, "float");

  const SCR_OFF = DYN_CTR_WORDS;
  const SCR_WORDS = dynLevels * VOXELS_PER_LEVEL;
  const SCRATCH_WORDS = SCR_OFF + SCR_WORDS;
  const scratchBuf = instancedArray(new Uint32Array(SCRATCH_WORDS), "uint");
  const scratchAttr = scratchBuf.value;
  const sc = storage(scratchAttr, "uint", SCRATCH_WORDS).toAtomic();

  const triCountU = uniform(0);

  // ── addressing (mirrors `windowStore`'s CPU helpers, bit for bit) ──────────
  const dynSlotBase = (levelNode) => levelNode.add(uint(levels)).mul(uint(LEVEL_WORDS));
  const torusVoxel = (cx, cy, cz) => bitOr(
    bitOr(bitAnd(cx.toInt(), int(N - 1)).toUint(), shiftLeft(bitAnd(cy.toInt(), int(N - 1)).toUint(), uint(6))),
    shiftLeft(bitAnd(cz.toInt(), int(N - 1)).toUint(), uint(12)),
  );
  const torusBrick = (cx, cy, cz) => {
    const bx = bitAnd(cx.div(float(BRICK)).floor().toInt(), int(15)).toUint();
    const by = bitAnd(cy.div(float(BRICK)).floor().toInt(), int(15)).toUint();
    const bz = bitAnd(cz.div(float(BRICK)).floor().toInt(), int(15)).toUint();
    return bitOr(bitOr(bx, shiftLeft(by, uint(4))), shiftLeft(bz, uint(8)));
  };

  // ═════════════════════════════════════════════════════ PASS: reset counters
  const resetCtrPass = Fn(() => {
    atomicStore(sc.element(instanceIndex), uint(0));
  })().compute(DYN_CTR_WORDS);

  // ══════════════════════════════════════════════════════ PASS: dynVoxelize
  //
  // One thread per (mirror level, packed triangle). The triangle is LOCAL, so
  // unlike the static path it IS transformed — by the matrix its mover slot owns
  // this frame — and the face bits fall out of the TRANSFORMED normal, which is
  // the whole reason a rotating mover blocks the right axes.
  //
  // Bindings: window, tris, meta, xform, scratch = 5.
  const voxelizePass = Fn(() => {
    const i = instanceIndex.toVar();
    const level = i.div(uint(MAX_DYN_TRIS)).toVar();
    const t = i.sub(level.mul(uint(MAX_DYN_TRIS))).toVar();
    If(t.toFloat().greaterThanEqual(float(triCountU)), () => { Return(); });

    const meta = dynMeta.element(t).toVar();
    const moverSlot = bitAnd(meta, uint(255)).toVar();
    const palByte = bitAnd(shiftRight(meta, uint(8)), uint(255)).toVar();

    // The mover's matrix, column-major exactly as `THREE.Matrix4.elements`.
    const mb = moverSlot.mul(uint(16)).toVar();
    const m = [];
    for (let k = 0; k < 12; k++) m.push(dynXform.element(mb.add(uint(k))).toVar());
    const xf = (p) => vec3(
      m[0].mul(p.x).add(m[4].mul(p.y)).add(m[8].mul(p.z)).add(dynXform.element(mb.add(uint(12)))),
      m[1].mul(p.x).add(m[5].mul(p.y)).add(m[9].mul(p.z)).add(dynXform.element(mb.add(uint(13)))),
      m[2].mul(p.x).add(m[6].mul(p.y)).add(m[10].mul(p.z)).add(dynXform.element(mb.add(uint(14)))),
    );

    const tb = t.mul(uint(9)).toVar();
    const a0 = vec3(dynTris.element(tb), dynTris.element(tb.add(uint(1))), dynTris.element(tb.add(uint(2)))).toVar();
    const a1 = vec3(dynTris.element(tb.add(uint(3))), dynTris.element(tb.add(uint(4))),
      dynTris.element(tb.add(uint(5)))).toVar();
    const a2 = vec3(dynTris.element(tb.add(uint(6))), dynTris.element(tb.add(uint(7))),
      dynTris.element(tb.add(uint(8)))).toVar();
    const w0 = xf(a0).toVar();
    const w1 = xf(a1).toVar();
    const w2 = xf(a2).toVar();

    // VOXEL SPACE at this level: the SAT's box becomes a unit cube, exactly as
    // in the static kernel.
    const v = float(voxel0).mul(exp2(level.toFloat())).toVar();
    const q0 = w0.div(v).toVar();
    const q1 = w1.div(v).toVar();
    const q2 = w2.div(v).toVar();

    const nrm = q1.sub(q0).cross(q2.sub(q0)).toVar();
    const nlen = nrm.length().toVar();
    If(nlen.lessThan(1e-12), () => {
      atomicAdd(sc.element(uint(DYN_CTR_DEGEN)), uint(1));
      Return();
    });
    const nn = nrm.div(nlen).toVar();
    // `windowTrace`'s corrected face rule: bit(±a) iff the surface is NOT
    // parallel to axis a. RECOMPUTED, never carried — see the header.
    const faceMask = bitOr(
      bitOr(
        select(nn.x.abs().greaterThan(1e-3), uint(0b000011), uint(0)),
        select(nn.y.abs().greaterThan(1e-3), uint(0b001100), uint(0)),
      ),
      select(nn.z.abs().greaterThan(1e-3), uint(0b110000), uint(0)),
    ).toVar();

    // The conservative span, clipped to THIS LEVEL'S WINDOW (the static path
    // clips to a brick because a brick is its work unit; here the work unit is
    // the triangle, so the window is the only bound there is).
    const o = originAt(level.toInt()).toVar();
    const lo = q0.min(q1).min(q2).sub(0.5).floor().max(o).toVar();
    const hi = q0.max(q1).max(q2).add(0.5).floor().min(o.add(float(N - 1))).toVar();
    If(hi.x.lessThan(lo.x).or(hi.y.lessThan(lo.y)).or(hi.z.lessThan(lo.z)), () => {
      atomicAdd(sc.element(uint(DYN_CTR_OUTSIDE)), uint(1));
      Return();
    });

    atomicAdd(sc.element(uint(DYN_CTR_TRIS)), uint(1));

    const sx = hi.x.sub(lo.x).add(1).toUint().toVar();
    const sy = hi.y.sub(lo.y).add(1).toUint().toVar();
    const sz = hi.z.sub(lo.z).add(1).toUint().toVar();
    const sxy = sx.mul(sy).toVar();
    const total = sxy.mul(sz).toVar();
    If(total.greaterThan(uint(DYN_SPAN_MAX)), () => {
      atomicAdd(sc.element(uint(DYN_CTR_SPANOVF)), uint(1));
    });
    // Half extent plus a hair — `occupancyField`'s conservativeEps, and the same
    // number the static kernel uses, so a mover and a wall are thickened alike.
    const h = vec3(0.5 + 1e-4).toVar();
    const slotBase = dynSlotBase(level).toVar();
    const scrBase = uint(SCR_OFF).add(level.mul(uint(VOXELS_PER_LEVEL))).toVar();
    const set = uint(0).toVar();

    Loop({ start: 0, end: DYN_SPAN_MAX, name: "dynK" }, ({ dynK }) => {
      const k = uint(dynK).toVar();
      If(k.greaterThanEqual(total), () => { Break(); });
      const kz = k.div(sxy).toVar();
      const r = k.sub(kz.mul(sxy)).toVar();
      const ky = r.div(sx).toVar();
      const kx = r.sub(ky.mul(sx)).toVar();
      const cx = lo.x.add(kx.toFloat()).toVar();
      const cy = lo.y.add(ky.toFloat()).toVar();
      const cz = lo.z.add(kz.toFloat()).toVar();
      If(triBoxOverlapFn(vec3(cx.add(0.5), cy.add(0.5), cz.add(0.5)), h, q0, q1, q2).greaterThan(0.5), () => {
        const vi = torusVoxel(cx, cy, cz).toVar();
        atomicOr(
          winAtomics.element(slotBase.add(uint(OCC_OFF)).add(shiftRight(vi, uint(5)))),
          shiftLeft(uint(1), bitAnd(vi, uint(31))),
        );
        atomicOr(
          winAtomics.element(slotBase.add(uint(FACE_OFF)).add(shiftRight(vi, uint(2)))),
          shiftLeft(faceMask, bitAnd(vi, uint(3)).mul(uint(8))),
        );
        const b = torusBrick(cx, cy, cz).toVar();
        atomicOr(
          winAtomics.element(slotBase.add(uint(BMASK_OFF)).add(shiftRight(b, uint(5)))),
          shiftLeft(uint(1), bitAnd(b, uint(31))),
        );
        If(palByte.notEqual(uint(PAL_NONE)), () => {
          atomicMax(sc.element(scrBase.add(vi)), palByte.add(uint(1)));
        });
        set.addAssign(1);
      });
    });
    atomicAdd(sc.element(uint(DYN_CTR_VOXELS)), set);
  })().compute(dynLevels * MAX_DYN_TRIS);

  // ═════════════════════════════════════════════════════════ PASS: dynPack
  //
  // One thread per `pal` WORD of the mirror levels: four voxels out of the
  // per-voxel scratch into one packed word, and the scratch entries zeroed on
  // the way past so the next frame starts clean without a separate 2 MB clear.
  //
  // Bindings: window, scratch = 2.
  const packPass = Fn(() => {
    const i = instanceIndex.toVar();
    const level = i.div(uint(PAL_WORDS)).toVar();
    const w = i.sub(level.mul(uint(PAL_WORDS))).toVar();
    const scrBase = uint(SCR_OFF).add(level.mul(uint(VOXELS_PER_LEVEL))).add(w.mul(uint(4))).toVar();
    const word = uint(0).toVar();
    for (let k = 0; k < 4; k++) {
      const s = atomicLoad(sc.element(scrBase.add(uint(k)))).toVar();
      word.assign(bitOr(word, shiftLeft(
        select(s.greaterThan(uint(0)), s.sub(uint(1)), uint(PAL_NONE)), uint(k * 8),
      )));
      atomicStore(sc.element(scrBase.add(uint(k))), uint(0));
    }
    atomicStore(winAtomics.element(dynSlotBase(level).add(uint(PAL_OFF)).add(w)), word);
  })().compute(dynLevels * PAL_WORDS);

  // ── the CPU side ──────────────────────────────────────────────────────────
  let packedTris = 0;
  let shapeKey = "";
  const receipt = { movers: 0, full: 0, boxed: 0, dropped: 0, triangles: 0, items: 0 };

  /**
   * Declares the mover set. The SOUPS are re-packed only when the set's shape
   * changes; the MATRICES are refreshed every call, which is the per-frame path.
   *
   * @param {Array<{slot: number, soup: {triCount, tris, triPal}, matrix: ArrayLike<number>,
   *   box?: [number[], number[]], pal?: number}>} movers
   */
  const setMovers = (movers) => {
    const list = (movers ?? []).filter((m) => m && m.soup && m.matrix).slice(0, MAX_MOVERS);
    const key = list.map((m) => `${m.slot}:${m.soup.triCount}:${m.soup.tris?.length ?? 0}`).join("|");

    if (key !== shapeKey) {
      shapeKey = key;
      // THE BUDGET, SPENT HERE (see the header). Demote the largest movers to
      // their box proxy first — they are what the budget is going on — and only
      // drop when even the boxes do not fit.
      const entries = list.map((m, idx) => ({
        idx, m, n: Math.max(0, m.soup.triCount | 0), box: m.box ?? null, useBox: false, drop: false,
      }));
      let total = entries.reduce((n, e) => n + e.n, 0);
      const largestFirst = entries.slice().sort((a, b) => (b.n - a.n) || (a.idx - b.idx));
      for (const e of largestFirst) {
        if (total <= MAX_DYN_TRIS) break;
        if (e.box && e.n > 12) { total -= e.n - 12; e.useBox = true; }
      }
      for (const e of largestFirst) {
        if (total <= MAX_DYN_TRIS) break;
        total -= e.useBox ? 12 : e.n;
        e.drop = true;
      }

      packedTris = 0;
      receipt.movers = entries.length;
      receipt.full = 0;
      receipt.boxed = 0;
      receipt.dropped = 0;
      for (const e of entries) {
        if (e.drop) { receipt.dropped++; continue; }
        const soup = e.useBox
          ? moverBoxSoup(e.box[0], e.box[1], e.m.pal ?? PAL_NONE)
          : e.m.soup;
        const n = Math.min(soup.triCount | 0, MAX_DYN_TRIS - packedTris);
        if (n < 1) { receipt.dropped++; continue; }
        trisArr.set(soup.tris.subarray(0, n * 9), packedTris * 9);
        const slot = e.m.slot & 255;
        for (let t = 0; t < n; t++) {
          const pw = soup.triPal ? soup.triPal[t >> 2] : 0xffffffff;
          const pal = (pw >>> ((t & 3) * 8)) & 255;
          metaArr[packedTris + t] = (slot | (pal << 8)) >>> 0;
        }
        packedTris += n;
        if (e.useBox) receipt.boxed++; else receipt.full++;
      }
      trisArr.fill(0, packedTris * 9);
      metaArr.fill(0, packedTris);
      dynTris.value.needsUpdate = true;
      dynMeta.value.needsUpdate = true;
      triCountU.value = packedTris;
      receipt.triangles = packedTris;
      receipt.items = packedTris * dynLevels;
    }

    for (const m of list) {
      const s = (m.slot & 255) % MAX_MOVERS;
      const e = m.matrix.elements ?? m.matrix;
      for (let k = 0; k < 16; k++) xformArr[s * 16 + k] = e[k];
    }
    dynXform.value.needsUpdate = true;
    return { ...receipt };
  };

  return {
    tier, MAX_MOVERS, MAX_DYN_TRIS, MAX_MOVER_TRIS, DYN_PAIRS_PER_FRAME, DYN_SPAN_MAX,
    dynLevels,
    trisBuffer: dynTris, metaBuffer: dynMeta, xformBuffer: dynXform,
    scratchBuffer: scratchBuf, scratchAttribute: scratchAttr,

    setMovers,

    /** Just the matrices — the per-frame path when the set has not changed. */
    setMatrix(slot, matrix) {
      const s = (slot & 255) % MAX_MOVERS;
      const e = matrix.elements ?? matrix;
      for (let k = 0; k < 16; k++) xformArr[s * 16 + k] = e[k];
      dynXform.value.needsUpdate = true;
    },

    /**
     * The frame's compute nodes, in order: reset the receipts, CLEAR the mirror
     * slots whole, voxelize every mover from its current matrix, pack the
     * palette. `camPos` is accepted for symmetry with the static voxelizer's
     * `passes` — the dynamic layer's origins are the window's own, synced by
     * `setCamera`, so it has nothing of its own to place.
     */
    passes(camPos = null) {
      void camPos;
      const list = [resetCtrPass];
      if (win.clearDynamicPass) list.push(win.clearDynamicPass);
      list.push(voxelizePass, packPass);
      return list;
    },

    /** The per-frame receipt. A 32-byte readback of the scratch head. */
    async stats(renderer) {
      const a = new Uint32Array(await renderer.getArrayBufferAsync(scratchAttr), 0, DYN_CTR_WORDS);
      return {
        trianglesPacked: packedTris,
        items: packedTris * dynLevels,
        satItems: a[DYN_CTR_TRIS],
        voxelsSet: a[DYN_CTR_VOXELS],
        spanOverflow: a[DYN_CTR_SPANOVF],
        outside: a[DYN_CTR_OUTSIDE],
        degenerate: a[DYN_CTR_DEGEN],
        movers: { ...receipt },
      };
    },

    describe: () => ({
      tier, dynLevels, maxMovers: MAX_MOVERS, maxMoverTris: MAX_MOVER_TRIS,
      dynPairsPerFrame: DYN_PAIRS_PER_FRAME, maxDynTris: MAX_DYN_TRIS, spanMax: DYN_SPAN_MAX,
      dispatch: dynLevels * MAX_DYN_TRIS,
      soupMB: +((trisArr.byteLength + metaArr.byteLength + xformArr.byteLength) / 1048576).toFixed(3),
      scratchMB: +((SCRATCH_WORDS * 4) / 1048576).toFixed(3),
    }),

    dispose() {
      scratchAttr.array = new Uint32Array(0);
      scratchAttr.dispose?.();
      dynTris.value.array = new Float32Array(0);
      dynTris.value.dispose?.();
      dynMeta.value.array = new Uint32Array(0);
      dynMeta.value.dispose?.();
      dynXform.value.array = new Float32Array(0);
      dynXform.value.dispose?.();
    },
  };
}
