// GI2 — THE WINDOW STORE (plan §4.1, audits §K.1/K.2, Stage 2.1)
//
// A camera-centred toroidal clipmap. `L` levels of 64³ cells, cell size
// `v_l = v0 · 2^l`. One storage buffer holds every level's `occ` / `face` /
// `pal` / `brickMask` / `brickTab`, at TIER-CONSTANT offsets, so every kernel's
// WGSL is scene-independent (levels, 64, brick 4, region offsets are compiled
// in; origins and counts are uniforms) and the browser's shader cache hits
// across scenes.
//
// ══ WHY ONE BUFFER ═══════════════════════════════════════════════════════════
//
// The portable envelope (PLAN §4.6) is ≤ 6 storage buffers per pass, and the
// trace is the pass every consumer will fold into. One buffer + uniforms keeps
// it at ONE binding, which leaves five for whatever the caller is doing
// (probe atlas, ray list, cache, stats). Two views over the SAME
// StorageInstancedBufferAttribute give the atomic writers and the plain
// readers what each needs without a second allocation or a copy pass — the
// pattern `occupancyField.js` had to pay 1.6 MB for, avoided here because both
// views index one attribute.
//
// ══ TOROIDAL ADDRESSING (K.1) ════════════════════════════════════════════════
//
// A fixed world point always lands in the same slot: `idx = (wc.x & 63) |
// (wc.y & 63) << 6 | (wc.z & 63) << 12`. NOTHING EVER MOVES when the camera
// translates; the slots a scroll re-points at are found by the brick table's
// `stored_wb != wb` test, which is why `scroll` is a stateless compute pass
// over bricks and not a CPU-side slab bookkeeping exercise. Camera ROTATION
// invalidates nothing at all.
//
// ══ THE HYSTERESIS, AND WHERE §K BENDS ═══════════════════════════════════════
//
// K.1 says the window is "recentred on the camera only when the camera leaves
// the central half of the window". Read as "then snap the origin to the
// brick-aligned camera centre", one crossing moves the origin 16 cells — FOUR
// brick rows, 1024 entering bricks, a spike the fixed per-frame voxelization
// budget then pays down over many frames while those bricks read EMPTY (a
// visible hole). So the TRIGGER is K.1's (leaving the central half — a
// 0.1 m walk never scrolls) and the STEP is the MINIMAL brick-aligned shift
// that puts the camera back inside the central half: exactly ONE brick row per
// crossing, 256 entering bricks, and a teleport still re-origins the whole
// window in one call. Same amortised work, no spike.
import * as THREE from "three/webgpu";
import {
  Fn, If, Loop, atomicAdd, atomicAnd, atomicLoad, atomicStore, bitAnd, bitNot, bitOr, float,
  instanceIndex, instancedArray, int, select, shiftLeft, shiftRight, storage, uint, uniform, vec3,
} from "three/tsl";

// ── TIER CONSTANTS ───────────────────────────────────────────────────────────
// Every one of these is baked into the WGSL. None of them is a scene number.
/** Cells per axis per level. */
export const N = 64;
/** Cells per axis per brick. */
export const BRICK = 4;
/** Bricks per axis per level. */
export const BRICKS = N / BRICK; // 16
export const VOXELS_PER_LEVEL = N * N * N; // 262144
export const BRICKS_PER_LEVEL = BRICKS * BRICKS * BRICKS; // 4096

// Region sizes in u32 WORDS, per level slot (K.2).
export const OCC_WORDS = VOXELS_PER_LEVEL / 32; // 8192   — 1 bit / voxel
export const FACE_WORDS = VOXELS_PER_LEVEL / 4; // 65536  — 1 byte / voxel
export const PAL_WORDS = VOXELS_PER_LEVEL / 4; // 65536  — 1 byte / voxel
export const BMASK_WORDS = BRICKS_PER_LEVEL / 32; // 128 — 1 bit / brick
export const BTAB_WORDS = BRICKS_PER_LEVEL * 2; // 8192   — wb + state / brick

export const OCC_OFF = 0;
export const FACE_OFF = OCC_OFF + OCC_WORDS; // 8192
export const PAL_OFF = FACE_OFF + FACE_WORDS; // 73728
export const BMASK_OFF = PAL_OFF + PAL_WORDS; // 139264
export const BTAB_OFF = BMASK_OFF + BMASK_WORDS; // 139392
export const LEVEL_WORDS = BTAB_OFF + BTAB_WORDS; // 147584 = 576.5 KB

/** Scratch tail: receipts only, never read by the trace. */
export const STATS_WORDS = 16;
export const STAT_SCROLL_CLEARED = 0;
export const STAT_FILL_OCCUPIED = 1;

/** `pal` sentinel — no surface. A cleared pal word is four of these. */
export const PAL_NONE = 255;
export const PAL_NONE_WORD = 0xffffffff;

/** `brickTab` word 1. EMPTY-DIRTY is 0 so a zeroed buffer is "nothing built". */
export const STATE_EMPTY_DIRTY = 0;
export const STATE_DIRTY = 1;
export const STATE_BUILT = 2;
/**
 * Accepted by `binPairs` THIS frame: its pairs are in the pair list and
 * `finishBricks` still owes it a brickMask OR, a palette pack and a verdict
 * (BUILT if it finished, back to DIRTY if it only got part of the budget).
 *
 * It belongs HERE and not in `windowVoxelize.js` — where Stage 2.3 had to
 * declare it locally, because that stage could not edit this file — because the
 * state word is the STORE's vocabulary: the voxelizer, the fill and every later
 * consumer have to agree on what 3 means. Sitting above `STATE_BUILT` is safe
 * because every reader compares with `!=` or `<`: `dirtyCount` counts
 * `state < STATE_BUILT`, so a BUILDING brick is deliberately invisible to the
 * next scan until `finishBricks` has decided its fate.
 */
export const STATE_BUILDING = 3;

/**
 * `brickTab` word 0 = the brick's world coord `wb`, 10 bits per axis, biased by
 * +512, PLUS bit 30 as a VALID marker.
 *
 * The marker is not decoration. Without it, `wb = (512, 512, 512)` packs to
 * exactly 0, which is also what a freshly allocated buffer holds — so one brick
 * in every window would read as already-owning its slot and never be cleared or
 * voxelized. A stale-slot detector whose sentinel collides with a legal value
 * fails on exactly one brick, silently, at one place in the world.
 */
export const WB_BIAS = 512;
export const WB_MASK = 1023;
export const WB_VALID = 1 << 30;
export const packWb = (x, y, z) =>
  ((((x + WB_BIAS) & WB_MASK) | (((y + WB_BIAS) & WB_MASK) << 10) | (((z + WB_BIAS) & WB_MASK) << 20) | WB_VALID) >>> 0);

/**
 * The tier table (PLAN §4.6). `levels` and `voxel0` decide the WGSL; nothing
 * else in this file varies per scene.
 *
 * `traceSteps` is the per-ray step budget of the two-level DDA — a tier
 * constant because it is baked into the loop bound. An exhausted ray reports a
 * MISS and the harness counts it separately; it deliberately does not fail
 * closed here, because the first thing Stage 2.4 has to publish is an honest
 * rays/s and hit-rate pair, and a silent clamp would flatter both.
 */
export const GI2_TIERS = {
  phone: { levels: 3, voxel0: 0.5, traceSteps: 96 },
  medium: { levels: 3, voxel0: 0.5, traceSteps: 96 },
  high: { levels: 4, voxel0: 0.25, traceSteps: 128 },
  ultra: { levels: 5, voxel0: 0.25, traceSteps: 160 },
};

/** Dynamic layer (K.5): L0 and L1 only, mirrored as two extra level slots. */
export const DYN_LEVELS = 2;

// ── PURE ADDRESSING (the CPU mirror the node test drives) ────────────────────

/** World cell of `p` at cell size `v`. */
export const worldCell = (p, v) => Math.floor(p / v);

/** Toroidal voxel slot of a world cell. */
export const voxelIndex = (x, y, z) => (x & 63) | ((y & 63) << 6) | ((z & 63) << 12);

/** Toroidal brick slot of a world BRICK coord. */
export const brickIndex = (x, y, z) => (x & 15) | ((y & 15) << 4) | ((z & 15) << 8);

/** Is world cell `wc` inside the window whose origin is `o`? */
export const inWindow = (wc, o) =>
  wc[0] - o[0] >= 0 && wc[0] - o[0] < N &&
  wc[1] - o[1] >= 0 && wc[1] - o[1] < N &&
  wc[2] - o[2] >= 0 && wc[2] - o[2] < N;

/** The world brick that owns torus brick slot `b` under brick origin `ob`. */
export const brickWorldCoord = (b, ob) => ob + ((b - ob) & 15);

/** Round `c` DOWN to a brick boundary (works for negatives). */
export const brickFloor = (c) => Math.floor(c / BRICK) * BRICK;

/** The central half of the window, in cells from the origin. */
export const HYST_LO = N / 4; // 16
export const HYST_HI = (3 * N) / 4; // 48

/**
 * The hysteretic, brick-snapped origin step for ONE axis.
 *
 * `prev == null` → first placement, centre the camera and snap down to a brick.
 * Otherwise the origin only moves when the camera leaves [lo, hi), and then by
 * the MINIMAL whole number of bricks that puts it back inside. See the header
 * for why that is not K.1's literal "snap to the camera centre".
 */
export function stepOrigin(camCell, prev) {
  if (prev === null || prev === undefined) return brickFloor(camCell - N / 2);
  const off = camCell - prev;
  if (off >= HYST_LO && off < HYST_HI) return prev;
  if (off < HYST_LO) return prev - Math.ceil((HYST_LO - off) / BRICK) * BRICK;
  return prev + Math.ceil((off - HYST_HI + 1) / BRICK) * BRICK;
}

/**
 * Bricks that ENTER the window when the origin shifts by `shift` cells.
 *
 * The three axis slabs overlap at the corners, so the union is counted by
 * complement — the bricks that stayed — rather than by adding three faces and
 * hoping the double-counting is small. `|shift| ≥ N` means nothing stayed.
 */
export function enteringBricks(shift) {
  const keep = shift.map((s) => Math.max(0, BRICKS - Math.min(BRICKS, Math.abs(s) / BRICK)));
  return BRICKS_PER_LEVEL - keep[0] * keep[1] * keep[2];
}

/** The entering slabs themselves, in WORLD brick coords, for the receipt. */
export function enteringSlabs(shift, newOrigin) {
  const slabs = [];
  for (let a = 0; a < 3; a++) {
    const s = shift[a];
    if (s === 0) continue;
    const rows = Math.min(BRICKS, Math.abs(s) / BRICK);
    const ob = Math.floor(newOrigin[a] / BRICK);
    // A positive shift brings in the FAR rows; a negative shift the near ones.
    const from = s > 0 ? ob + BRICKS - rows : ob;
    slabs.push({ axis: a, sign: Math.sign(s), rows, from, to: from + rows });
  }
  return slabs;
}

/**
 * The window.
 *
 * @param {string} tier  "phone" | "medium" | "high" | "ultra"
 * @param {object} [opts]
 * @param {boolean} [opts.dynamic=true]  allocate the K.5 dynamic mirror slots
 */
export function createGiWindow(tier = "high", { dynamic = true } = {}) {
  const spec = GI2_TIERS[tier];
  if (!spec) throw new Error(`unknown GI2 tier "${tier}" (have ${Object.keys(GI2_TIERS).join(", ")})`);
  const levels = spec.levels;
  const voxel0 = spec.voxel0;
  const dynLevels = dynamic ? Math.min(DYN_LEVELS, levels) : 0;
  // Slot layout: [0 … levels-1] static, [levels … levels+dynLevels-1] dynamic
  // mirrors of levels 0 and 1. Giving the dynamic layer FULL level slots (it
  // only needs occ/face/pal) costs 1.1 MB and buys one addressing rule for both
  // layers — the trace's dynamic read is the same expression with a different
  // slot number, and the dynamic brickMask gives movers the same empty-brick
  // skip the static layer gets.
  const slots = levels + dynLevels;
  const words = slots * LEVEL_WORDS + STATS_WORDS;

  const buffer = instancedArray(new Uint32Array(words), "uint");
  const attribute = buffer.value;
  // The SAME attribute, seen as atomics. Writers bind this, readers bind
  // `buffer`; the GPU allocation is one.
  const atomics = storage(attribute, "uint", words).toAtomic();

  const statsBase = slots * LEVEL_WORDS;

  // Origins are integer-VALUED float uniforms, not ivec3: every consumer either
  // compares them (exact for |cell| < 2^24 — ±4 M cells, ±1000 km at 0.25 m) or
  // divides them by the brick size (exact, they are brick-aligned). An ivec3
  // uniform array would add a padding rule and a dynamic-index question for no
  // reachable precision.
  const originsU = [];
  for (let s = 0; s < slots; s++) originsU.push(uniform(new THREE.Vector3(0, 0, 0)));
  const origins = new Int32Array(slots * 3);
  let placed = false;

  /** Cell size of a level. */
  const levelVoxel = (l) => voxel0 * Math.pow(2, l);
  /** World extent of a level's window, metres. */
  const levelExtent = (l) => N * levelVoxel(l);

  // ── the level → origin select chain (levels is a tier constant) ────────────
  const originAt = (levelNode) => {
    let node = vec3(originsU[levels - 1]);
    for (let l = levels - 2; l >= 0; l--) node = select(levelNode.equal(int(l)), vec3(originsU[l]), node);
    return node;
  };

  // ══════════════════════════════════════════════════════════ SHADER: scroll
  //
  // One thread per (static level, brick). Compares the slot's stored `wb`
  // against the `wb` the slot NOW addresses; a mismatch means the camera moved
  // and this slot has been re-pointed at a brick nobody has voxelized, so its
  // voxels are cleared and it is marked EMPTY-DIRTY. That single rule covers
  // every case — one-brick walks, teleports, and the very first placement (a
  // zeroed table carries no VALID bit, so every brick is stale) — without a
  // CPU-side slab list ever being right about anything.
  //
  // ONE storage binding. `occ` and `brickMask` are cleared with atomicAnd
  // because a word of either is shared with seven neighbouring bricks along x;
  // `face` and `pal` words are four x-consecutive voxels INSIDE this brick, so
  // they are owned outright and are stored, not merged.
  const scrollPass = Fn(() => {
    const idx = instanceIndex.toVar();
    const slot = shiftRight(idx, uint(12)).toVar(); // 4096 bricks per level
    const b = bitAnd(idx, uint(BRICKS_PER_LEVEL - 1)).toVar();
    const bx = bitAnd(b, uint(15)).toInt().toVar();
    const by = bitAnd(shiftRight(b, uint(4)), uint(15)).toInt().toVar();
    const bz = bitAnd(shiftRight(b, uint(8)), uint(15)).toInt().toVar();

    // Brick origin: the cell origin is brick-aligned, so this division is exact.
    const o = originAt(slot.toInt()).toVar();
    const obx = o.x.div(float(BRICK)).toInt().toVar();
    const oby = o.y.div(float(BRICK)).toInt().toVar();
    const obz = o.z.div(float(BRICK)).toInt().toVar();

    const wbx = obx.add(bitAnd(bx.sub(obx), int(15))).toVar();
    const wby = oby.add(bitAnd(by.sub(oby), int(15))).toVar();
    const wbz = obz.add(bitAnd(bz.sub(obz), int(15))).toVar();

    const packed = bitOr(
      bitOr(
        bitAnd(wbx.add(int(WB_BIAS)), int(WB_MASK)).toUint(),
        shiftLeft(bitAnd(wby.add(int(WB_BIAS)), int(WB_MASK)).toUint(), uint(10)),
      ),
      bitOr(
        shiftLeft(bitAnd(wbz.add(int(WB_BIAS)), int(WB_MASK)).toUint(), uint(20)),
        uint(WB_VALID),
      ),
    ).toVar();

    const levelBase = slot.mul(uint(LEVEL_WORDS)).toVar();
    const tabBase = levelBase.add(uint(BTAB_OFF)).add(b.mul(uint(2))).toVar();
    const stored = atomicLoad(atomics.element(tabBase)).toVar();

    If(stored.notEqual(packed), () => {
      atomicStore(atomics.element(tabBase), packed);
      atomicStore(atomics.element(tabBase.add(uint(1))), uint(STATE_EMPTY_DIRTY));
      // brickMask bit
      atomicAnd(
        atomics.element(levelBase.add(uint(BMASK_OFF)).add(shiftRight(b, uint(5)))),
        bitNot(shiftLeft(uint(1), bitAnd(b, uint(31)))),
      );
      // 16 (y, z) rows of 4 x-consecutive voxels each.
      const vx0 = bx.mul(int(BRICK)).toUint().toVar();
      Loop({ start: 0, end: BRICK * BRICK, name: "scrollRow" }, ({ scrollRow }) => {
        const ly = bitAnd(scrollRow.toUint(), uint(3)).toVar();
        const lz = shiftRight(scrollRow.toUint(), uint(2)).toVar();
        const vy = by.toUint().mul(uint(BRICK)).add(ly).toVar();
        const vz = bz.toUint().mul(uint(BRICK)).add(lz).toVar();
        const vi = bitOr(bitOr(vx0, shiftLeft(vy, uint(6))), shiftLeft(vz, uint(12))).toVar();
        atomicAnd(
          atomics.element(levelBase.add(uint(OCC_OFF)).add(shiftRight(vi, uint(5)))),
          bitNot(shiftLeft(uint(0xf), bitAnd(vi, uint(31)))),
        );
        const byteWord = shiftRight(vi, uint(2)).toVar();
        atomicStore(atomics.element(levelBase.add(uint(FACE_OFF)).add(byteWord)), uint(0));
        atomicStore(atomics.element(levelBase.add(uint(PAL_OFF)).add(byteWord)), uint(PAL_NONE_WORD));
      });
      atomicAdd(atomics.element(uint(statsBase + STAT_SCROLL_CLEARED)), uint(1));
    });
  })().compute(levels * BRICKS_PER_LEVEL);

  // ═══════════════════════════════════════════════════════ SHADER: stats reset
  const statsResetPass = Fn(() => {
    atomicStore(atomics.element(instanceIndex.add(uint(statsBase))), uint(0));
  })().compute(STATS_WORDS);

  // ═════════════════════════════════════════════ SHADER: clear a slot's content
  //
  // occ + face + pal + brickMask for a contiguous run of slots, brickTab left
  // alone (the slots keep their identity; only their contents go). The dynamic
  // layer runs this every frame (K.5); the harness runs it to re-fill.
  const makeClearPass = (firstSlot, slotCount) => {
    const CONTENT_WORDS = OCC_WORDS + FACE_WORDS + PAL_WORDS + BMASK_WORDS;
    return Fn(() => {
      const idx = instanceIndex.toVar();
      const s = idx.div(uint(CONTENT_WORDS)).toVar();
      const w = idx.sub(s.mul(uint(CONTENT_WORDS))).toVar();
      const base = s.add(uint(firstSlot)).mul(uint(LEVEL_WORDS)).toVar();
      // occ | face | brickMask → 0, pal → 255. The four content regions are
      // CONTIGUOUS from word 0 (K.2's table is the layout, not a description of
      // it), so the word offset is the thread's own and only `pal` needs a
      // different value — two compares against tier constants, one write.
      const inPal = w.greaterThanEqual(uint(PAL_OFF)).and(w.lessThan(uint(PAL_OFF + PAL_WORDS)));
      atomicStore(atomics.element(base.add(w)), select(inPal, uint(PAL_NONE_WORD), uint(0)));
    })().compute(slotCount * CONTENT_WORDS);
  };

  const clearStaticPass = makeClearPass(0, levels);
  const clearDynamicPass = dynLevels > 0 ? makeClearPass(levels, dynLevels) : null;

  /**
   * Place the window on the camera.
   *
   * Returns the per-level receipt: the brick-aligned shift, the entering slab
   * list, and the brick count that shift invalidates — the number the Stage 2.1
   * gate ("scroll re-voxelizes only the entering slab") compares against the
   * `scroll` pass's own cleared-brick counter.
   */
  const setCamera = (pos) => {
    const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    const perLevel = [];
    let scrolled = false;
    for (let l = 0; l < levels; l++) {
      const v = levelVoxel(l);
      const shift = [0, 0, 0];
      const next = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const camCell = worldCell(p[a], v);
        const prev = placed ? origins[l * 3 + a] : null;
        next[a] = stepOrigin(camCell, prev);
        shift[a] = placed ? next[a] - origins[l * 3 + a] : 0;
      }
      const moved = !placed || shift.some((s) => s !== 0);
      for (let a = 0; a < 3; a++) origins[l * 3 + a] = next[a];
      originsU[l].value.set(next[0], next[1], next[2]);
      // The dynamic mirror of a level shares its origin — a mover is voxelized
      // into the same cells its static neighbours occupy, or the OR at trace
      // time would be reading two different grids.
      if (l < dynLevels) {
        originsU[levels + l].value.set(next[0], next[1], next[2]);
        origins[(levels + l) * 3 + 0] = next[0];
        origins[(levels + l) * 3 + 1] = next[1];
        origins[(levels + l) * 3 + 2] = next[2];
      }
      if (moved) scrolled = true;
      perLevel.push({
        level: l,
        voxel: v,
        origin: next.slice(),
        shift: shift.slice(),
        // First placement invalidates the whole window, and the shift is 0 —
        // report what the scroll pass will actually do, not what the shift says.
        enteringBricks: placed ? enteringBricks(shift) : BRICKS_PER_LEVEL,
        slabs: placed ? enteringSlabs(shift, next) : [{ axis: -1, sign: 0, rows: BRICKS, from: 0, to: BRICKS }],
      });
    }
    placed = true;
    return { scrolled, perLevel, totalEntering: perLevel.reduce((n, r) => n + r.enteringBricks, 0) };
  };

  /**
   * Forget where the camera was, so the next `setCamera` places the window
   * CENTRED rather than nudging it by the minimal brick step.
   *
   * The hysteresis is a walking rule: after any move the camera sits somewhere
   * in [N/4, 3N/4) of the window, not at its middle, and a caller that needs a
   * window it can predict — a scene load, a teleport a level away, a harness
   * that must know which level owns a given wall — has to be able to ask for a
   * fresh placement instead of inferring the offset. Costs a full re-voxelize,
   * which is what a scene change costs anyway.
   */
  const reset = () => { placed = false; };

  const perLevelBytes = {
    occ: OCC_WORDS * 4,
    face: FACE_WORDS * 4,
    pal: PAL_WORDS * 4,
    brickMask: BMASK_WORDS * 4,
    brickTab: BTAB_WORDS * 4,
    total: LEVEL_WORDS * 4,
  };

  const describe = () => ({
    tier,
    levels,
    dynLevels,
    slots,
    voxel0,
    cellsPerAxis: N,
    brick: BRICK,
    traceSteps: spec.traceSteps,
    perLevelBytes,
    staticBytes: levels * LEVEL_WORDS * 4,
    dynamicBytes: dynLevels * LEVEL_WORDS * 4,
    statsBytes: STATS_WORDS * 4,
    totalBytes: words * 4,
    totalMB: +((words * 4) / (1024 * 1024)).toFixed(3),
    extents: Array.from({ length: levels }, (_, l) => ({
      level: l,
      voxel: levelVoxel(l),
      extent: levelExtent(l),
    })),
  });

  return {
    tier, levels, dynLevels, slots, voxel0, spec,
    words, statsBase,
    buffer, atomics, attribute,
    originsU, origins, originAt,
    levelVoxel, levelExtent,
    setCamera, reset,
    scrollPass, statsResetPass, clearStaticPass, clearDynamicPass,
    describe,
    dispose() {
      attribute.array = new Uint32Array(0);
      attribute.dispose?.();
    },
  };
}
