// GI2 — THE WORLD-ANCHORED PROBE LATTICE (audits §U, Stage 3.13)
//
// RC's cascade 0, inside the window. A toroidal lattice of probes that follows
// the camera the way `windowStore` does, one probe per live cell, each tracing
// its COMPLETE fixed 64-direction set on a deterministic round-robin.
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
// ══ THE THREE THINGS THAT MAKE THIS SIMPLE, AND WHY EACH IS NOT AN ACCIDENT ══
//
// 1. **THE SLOT IS THE CELL.** There is no allocator, no free list and no
//    atomic anywhere in this file. A cell's probe lives at the cell's own
//    toroidal index, so a scroll re-keys a slab of cells and nothing has to be
//    moved, freed or reference-counted; "this slot now holds a different world
//    cell" is `stored_wc != wc`, exactly `windowStore`'s brick-table rule
//    (§K.1). A free list would have bought ~40 % of the memory back and cost a
//    lock-free ring queue in a kernel that runs 32 768 threads a frame — and a
//    racy allocator is a bug that shows up as one wrong probe somewhere in the
//    world, which is the hardest possible thing to see.
//
// 2. **THE OCT TEXEL IS TWO WORDS, NOT A `vec4`.** RGBE radiance + a packed
//    (n, meanDist, rmsDist). Sixteen bytes per texel would be 33.5 MB at the
//    desktop lattice; eight is 16.8. The second word is not padding — the two
//    distance MOMENTS are what the resolve's visibility test needs (DDGI's
//    Chebyshev), and they were free in the half of the alpha the screen probes
//    spend on σ (which has had no reader since §19 3.10).
//
// 3. **THE ROUND-ROBIN IS OVER A COMPACTED LIST, AND THE COMPACTION IS A
//    DETERMINISTIC PREFIX SUM.** A lattice is mostly empty — a sealed Cornell
//    room lights ~11 % of its cells — so dispatching (cell × texel) would
//    launch a million threads to do a hundred thousand rays' work, and this
//    file's own history says a launch-bound kernel is 3.3 ns per thread whether
//    it works or not. Three tiny kernels (count per 256-cell block, prefix-sum
//    128 blocks in one thread, fill) turn the live set into a dense list whose
//    ORDER is a pure function of the occupancy — no atomics, so two frames with
//    the same world produce byte-identical lists and therefore byte-identical
//    update schedules. That is what makes §T's "at rest, zero flips" hold.
//
// ══ WHERE §U BENDS ══════════════════════════════════════════════════════════
//
// §U.1 asks for "two probes for a thin wall's two faces". This ships ONE probe
// per cell and gives the job to the two gates that already had to exist: the
// probe's FACE (a cell whose centre is inside geometry is pushed out along its
// dominant normal and remembers which way it went, so a pixel on the other side
// weights it zero) and the resolve's VISIBILITY test (a probe on the far side
// of a wall is occluded from the pixel by that wall). A second slot per cell
// doubles the largest buffer in the system to defend a case the open-air cells
// on either side of the wall already cover — 0.5 m apart, a 5 cm wall has a
// free cell on each side. The thin-wall interior receipt is what says whether
// that reading was right.
import * as THREE from "three/webgpu";
import {
  Break, Fn, If, Loop, Return, bitAnd, bitOr, ceil, dot, exp2, float, globalId, instanceIndex,
  instancedArray, int, log2, max, min, mix, normalize, select, shiftLeft, shiftRight, sqrt, uint,
  uniform, vec3, vec4,
} from "three/tsl";
import { BMASK_OFF, LEVEL_WORDS, N, OCC_OFF } from "./windowStore.js";
import { normalOfFace } from "./radianceCache.js";

/**
 * Tier constants. `cells` and `spacing` are compiled into the WGSL (they are
 * the addressing); `traceSlots` is the frame's ray budget divided by 64.
 *
 * `cells` must be a POWER OF TWO — the toroidal mask is `& (cells − 1)`, the
 * same identity `windowStore`'s `& 63` is.
 *
 * The extent is `cells · spacing`: 16 m on every tier, which is L0's own window
 * at the desktop voxel size. A lattice larger than the finest occupancy that
 * feeds it would be allocating probes for cells whose liveness test reads a
 * coarser level than the probe can represent.
 */
export const WORLD_TIERS = {
  phone: { cells: 16, spacing: 1.0, traceSlots: 1024, block: 64 },
  medium: { cells: 16, spacing: 1.0, traceSlots: 1024, block: 64 },
  high: { cells: 32, spacing: 0.5, traceSlots: 6144, block: 256 },
  ultra: { cells: 32, spacing: 0.5, traceSlots: 6144, block: 256 },
};

/** The distance moments' quantization range, in units of the lattice spacing. */
export const DIST_CELLS = 8;
/** 12 bits each for the two moments, 8 for the sample count. */
export const DQ = 4095;

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
 *   `faceSamplePoint`, `shadeHit`, `emitterSh` … see `createGiGather`.
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
  const SP = spec.spacing;
  const TRACE_SLOTS = Math.min(spec.traceSlots, CELLS);
  const BLOCK = spec.block;
  const BLOCKS = CELLS / BLOCK;
  const DMAXW = DIST_CELLS * SP;

  const {
    u, octU, cellOfWorld, dominantFace, hitRadiance, emitterSh, bump, STATS, RAY_MAX, OCT,
  } = kit;
  const { traceWindow } = trace;
  const v0 = win.voxel0;

  // ── buffers ───────────────────────────────────────────────────────────────
  //
  // `wpOct` is the whole cost of this design and it is deliberately the only
  // thing that scales with the lattice: two u32 per (cell, texel).
  //   word 0  RGBE radiance (0 = never written — the same sentinel the cache's
  //           own words use, so "no data" and "black" stay distinguishable)
  //   word 1  n<<24 | rmsQ<<12 | meanQ   — the two distance moments
  const wpOct = instancedArray(new Uint32Array(CELLS * OCT * 2), "uint");
  /** Nine SH2 coefficients per cell. What the resolve reads. */
  const wpSh = instancedArray(new Float32Array(CELLS * 9 * 4), "vec4");
  /**
   * Three vec4 per cell:
   *   0  (probe position, state)   state 0 dead · 1 open-air · 2 faced
   *   1  (face normal, 0)
   *   2  (world cell coord, ready) ready 0 = the map is not trustworthy yet
   */
  const wpInfo = instancedArray(new Float32Array(CELLS * 3 * 4), "vec4");
  /**
   * ONE buffer for the compaction, because the trace stands at the portable
   * envelope's six storage bindings exactly (window, cache, oct, info, list,
   * stats) and a seventh for an integer would not compile on the phone tier.
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
  const wpList = instancedArray(new Uint32Array(LIST_WORDS), "uint");

  // ── uniforms owned here (merged into the gather's bag by the caller) ──────
  const wu = {
    wpOrigin: uniform(new THREE.Vector3()),
    /**
     * §U.2's fixed α between complete updates. It cannot remove noise (there is
     * none: the probe does not move, so its 64 rays are the same rays every
     * time) — it exists so the world cache's convergence STEPS and a moved lamp
     * arrive as a ramp. 1 is a legitimate arm and is not noisy, only abrupt.
     */
    wpAlpha: uniform(0.25),
    /** 0 removes the resolve's visibility term — the LEAK RECEIPT'S CONTROL. */
    wpVisOn: uniform(1),
    /** 0 removes the probe-face gate; the other half of the same control. */
    wpFaceOn: uniform(1),
    /**
     * The surface bias, as a fraction of the lattice spacing. A pixel is
     * sampled at `P + N·bias` so its own surface cannot occlude it from the
     * probes above it. A FRACTION of what the lattice measures, never metres.
     */
    wpBias: uniform(0.3),
    /**
     * The Chebyshev variance floor, as a fraction of the spacing. Without it a
     * probe whose distance map is locally flat (a wall it stares at) has zero
     * variance and the test becomes a hard step at the stored distance, which
     * over-occludes every pixel a few centimetres past it.
     */
    wpVarFloor: uniform(0.5),
  };

  // ── addressing ────────────────────────────────────────────────────────────
  const slotOf = (x, y, z) => bitOr(bitOr(
    bitAnd(x, int(C - 1)).toUint(),
    shiftLeft(bitAnd(y, int(C - 1)).toUint(), uint(CB))),
  shiftLeft(bitAnd(z, int(C - 1)).toUint(), uint(2 * CB)));
  /** Un-torus one axis: the origin says which window the low bits belong to. */
  const unTorus = (bits, o) => o.toInt().add(bitAnd(bits.toInt().sub(o.toInt()), int(C - 1)));
  const infoIdx = (cell, k) => cell.mul(uint(3)).add(uint(k));
  const shIdxW = (cell, k) => cell.mul(uint(9)).add(uint(k));
  const octIdxW = (cell, texel) => cell.mul(uint(OCT * 2)).add(texel.mul(uint(2)));

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
  const quantD = (d) => d.div(DMAXW).clamp(0, 1).mul(DQ).add(0.5).floor().toUint();
  const packMoments = (nU, meanF, rmsF) => bitOr(
    bitOr(shiftLeft(nU.min(uint(255)), uint(24)), shiftLeft(quantD(rmsF), uint(12))),
    quantD(meanF),
  );
  const meanOf = (w) => bitAnd(w, uint(DQ)).toFloat().mul(DMAXW / DQ);
  const rmsOf = (w) => bitAnd(shiftRight(w, uint(12)), uint(DQ)).toFloat().mul(DMAXW / DQ);
  const nOf = (w) => shiftRight(w, uint(24));

  // ══════════════════════════════════════════ SHADER: probeAlloc (§U.1)
  //
  // One thread per LATTICE CELL. Decides, from the window's own occupancy,
  // whether this cell holds a live probe; where that probe stands; and which
  // face (if any) it represents. Everything it writes is a pure function of
  // (cell, origin, occupancy) — run it twice on one frame and it writes the
  // same bytes, which is what lets it run every frame instead of maintaining
  // state nobody can audit.
  const allocPass = Fn(() => {
    const cell = instanceIndex.toVar();
    const cx = bitAnd(cell, uint(C - 1)).toInt().toVar();
    const cy = bitAnd(shiftRight(cell, uint(CB)), uint(C - 1)).toInt().toVar();
    const cz = bitAnd(shiftRight(cell, uint(2 * CB)), uint(C - 1)).toInt().toVar();
    const o = wu.wpOrigin;
    const wc = vec3(
      unTorus(cx, o.x).toFloat(), unTorus(cy, o.y).toFloat(), unTorus(cz, o.z).toFloat(),
    ).toVar();
    const p = wc.add(0.5).mul(SP).toVar();

    // §U.4: a scroll re-keys the entering slab. The slot keeps its memory only
    // while it keeps its identity — `stored != wc` is the whole test, and a
    // fresh probe then takes α = 1 on its first update.
    const prev2 = wpInfo.element(infoIdx(cell, 2)).toVar();
    const same = prev2.x.equal(wc.x).and(prev2.y.equal(wc.y)).and(prev2.z.equal(wc.z)).toVar();
    const ready = select(same, prev2.w, float(0)).toVar();

    const dead = () => {
      wpList.element(uint(FLAG_OFF).add(cell)).assign(uint(0));
      wpInfo.element(infoIdx(cell, 0)).assign(vec4(p, 0));
      wpInfo.element(infoIdx(cell, 1)).assign(vec4(0, 1, 0, 0));
      wpInfo.element(infoIdx(cell, 2)).assign(vec4(wc, 0));
    };

    // The finest level whose window holds this cell. §K's rule, and not
    // optional: at the desktop tier the lattice and L0 are both 16 m but their
    // origins snap differently, so a lattice cell near the edge is L1's.
    const lc = cellOfWorld(p);
    const lvl = lc.level.toVar();
    const lvlU = lvl.toUint().toVar();
    const vl = float(v0).mul(exp2(lvl.toFloat())).toVar();
    // The window cells the probe cell spans, dilated by one (§U.1's "±1 cell").
    const c0 = p.sub(SP * 0.5).div(vl).floor().sub(1).toVar();

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

    wpList.element(uint(FLAG_OFF).add(cell)).assign(uint(1));
    wpInfo.element(infoIdx(cell, 0)).assign(vec4(pos, state));
    wpInfo.element(infoIdx(cell, 1)).assign(vec4(faceN, 0));
    wpInfo.element(infoIdx(cell, 2)).assign(vec4(wc, ready));
  })().compute(CELLS);

  // ══════════════════════════════════ SHADERS: the compaction (count/scan/fill)
  //
  // A deterministic, atomic-free prefix sum. `countPass` is one thread per
  // 256-cell block; `scanPass` is ONE thread over 128 block counts; `fillPass`
  // is one thread per block again, writing its own contiguous run. Nothing
  // races, so the list is a pure function of the flags — which is what makes
  // "which probes update this frame" a pure function of the frame index and
  // therefore makes a parked camera byte-identical (§T).
  const countPass = Fn(() => {
    const b = instanceIndex.toVar();
    const base = b.mul(uint(BLOCK)).toVar();
    const n = uint(0).toVar();
    Loop({ start: 0, end: BLOCK, name: "wpCount" }, ({ wpCount }) => {
      n.addAssign(wpList.element(uint(FLAG_OFF).add(base).add(uint(wpCount))));
    });
    wpList.element(uint(BASE_OFF).add(b)).assign(n);
  })().compute(BLOCKS);

  const scanPass = Fn(() => {
    const run = uint(0).toVar();
    Loop({ start: 0, end: BLOCKS, name: "wpScan" }, ({ wpScan }) => {
      const i = uint(BASE_OFF).add(uint(wpScan)).toVar();
      const c = wpList.element(i).toVar();
      wpList.element(i).assign(run);
      run.addAssign(c);
    });
    wpList.element(uint(CTL_OFF)).assign(run);
  })().compute(1);

  const fillPass = Fn(() => {
    const b = instanceIndex.toVar();
    const base = b.mul(uint(BLOCK)).toVar();
    const w = wpList.element(uint(BASE_OFF).add(b)).toVar();
    Loop({ start: 0, end: BLOCK, name: "wpFill" }, ({ wpFill }) => {
      const cell = base.add(uint(wpFill)).toVar();
      If(wpList.element(uint(FLAG_OFF).add(cell)).greaterThan(uint(0)), () => {
        wpList.element(uint(LIST_OFF).add(w)).assign(cell);
        w.addAssign(uint(1));
      });
    });
  })().compute(BLOCKS);

  // ── the round-robin (§U.2) ────────────────────────────────────────────────
  //
  // Frame `f` updates the `TRACE_SLOTS` list entries starting at
  // `f·TRACE_SLOTS mod live`. Every live probe is therefore updated exactly
  // once every `ceil(live / TRACE_SLOTS)` frames — 1 when the scene is small
  // enough that the budget covers it, 2 on a Bistro-scale lattice — and WHICH
  // probes update on which frame is a function of the frame index alone.
  const umod = (a, b) => a.sub(a.div(b).mul(b));
  const roundRobin = (k) => {
    const live = wpList.element(uint(CTL_OFF)).max(uint(1)).toVar();
    const base = umod(u.frame.mul(uint(TRACE_SLOTS)), live).toVar();
    return { live, idx: umod(base.add(k), live) };
  };

  // ══════════════════════════════════════════ SHADER: worldProbeTrace (§U.2)
  //
  // One thread per (batch slot, oct texel). The direction is `octU`'s texel
  // CENTRE — the same table the SH projection uses, the same 64 directions this
  // probe traced last time and will trace next time. Nothing here is a function
  // of the camera.
  const tracePass = Fn(() => {
    const k = globalId.x.toVar();
    const texel = globalId.y.toVar();
    If(texel.greaterThanEqual(uint(OCT)), () => { Return(); });
    const rr = roundRobin(k);
    If(k.greaterThanEqual(rr.live), () => { Return(); });
    const cell = wpList.element(uint(LIST_OFF).add(rr.idx)).toVar();
    const i0 = wpInfo.element(infoIdx(cell, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });
    const pos = i0.xyz.toVar();
    const faced = i0.w.greaterThan(1.5).toVar();
    const faceN = wpInfo.element(infoIdx(cell, 1)).xyz.toVar();
    const fresh = wpInfo.element(infoIdx(cell, 2)).w.lessThan(0.5).toVar();

    const dir = octU.element(texel).xyz.toVar();
    const addr = octIdxW(cell, texel).toVar();
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
    const r = traceWindow(pos, dir, float(RAY_MAX), select(faced, faceN, dir)).raw.toVar();
    const rd = hitRadiance(r, dir, k).toVar(); // (rgb, hitDistance)

    const prev0 = wpOct.element(addr).toVar();
    const prev1 = wpOct.element(addr.add(uint(1))).toVar();
    const had = nOf(prev1).greaterThan(uint(0)).and(fresh.not()).toVar();
    const a = select(had, wu.wpAlpha.clamp(0, 1), float(1)).toVar();
    const rgb = mix(decodeRgbe(prev0), rd.xyz, a).toVar();
    const d = min(rd.w, float(DMAXW)).toVar();
    const m1 = mix(meanOf(prev1), d, a).toVar();
    const pr = rmsOf(prev1).toVar();
    const m2 = mix(pr.mul(pr), d.mul(d), a).toVar();
    wpOct.element(addr).assign(encodeRgbe(rgb));
    wpOct.element(addr.add(uint(1))).assign(
      packMoments(nOf(prev1).add(uint(1)).min(uint(63)), m1, sqrt(m2.max(0))),
    );
  })().compute([Math.ceil(TRACE_SLOTS / 8), Math.ceil(OCT / 8)], [8, 8, 1]);

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
    If(k.greaterThanEqual(rr.live), () => { Return(); });
    const cell = wpList.element(uint(LIST_OFF).add(rr.idx)).toVar();
    const i0 = wpInfo.element(infoIdx(cell, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });
    const faced = i0.w.greaterThan(1.5).toVar();
    const faceN = wpInfo.element(infoIdx(cell, 1)).xyz.toVar();

    // Pass 1: the cosine-weighted mean over the directions this probe HAS.
    const acc = vec3(0).toVar();
    const wsum = float(0).toVar();
    Loop({ start: 0, end: OCT, name: "wpMean" }, ({ wpMean }) => {
      const t = uint(wpMean).toVar();
      const addr = octIdxW(cell, t).toVar();
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
      const addr = octIdxW(cell, t).toVar();
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
    for (let i = 0; i < 9; i++) wpSh.element(shIdxW(cell, i)).assign(vec4(sh[i], 0));
    const i2 = wpInfo.element(infoIdx(cell, 2)).toVar();
    wpInfo.element(infoIdx(cell, 2)).assign(vec4(i2.xyz, 1));
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
    If(k.greaterThanEqual(rr.live), () => { Return(); });
    const cell = wpList.element(uint(LIST_OFF).add(rr.idx)).toVar();
    const i0 = wpInfo.element(infoIdx(cell, 0)).toVar();
    If(i0.w.lessThan(0.5), () => { Return(); });
    const p = i0.xyz.toVar();
    const faced = i0.w.greaterThan(1.5).toVar();
    const n = wpInfo.element(infoIdx(cell, 1)).xyz.toVar();
    // ⚠ THE RECEIVER'S NORMAL IS THE FACE OR NOTHING. An open-air probe has no
    // normal, and `shEval`'s cosine convolution supplies the receiver's cosine
    // at the PIXEL anyway — so the cull a screen probe can afford (skip the
    // source if it is behind me) is only taken where a face actually exists.
    const sh = emitterSh(p, select(faced, n, vec3(0)), faced);
    for (let i = 0; i < 9; i++) {
      const idx = shIdxW(cell, i);
      const cur = wpSh.element(idx).toVar();
      wpSh.element(idx).assign(vec4(cur.xyz.add(sh[i]), 0));
    }
  })().compute(TRACE_SLOTS);

  // ══════════════════════════════════════════ SHADER: clear (harness only)
  const clearPass = Fn(() => {
    const i = instanceIndex.toVar();
    wpOct.element(i).assign(uint(0));
  })().compute(CELLS * OCT * 2);
  const clearInfoPass = Fn(() => {
    wpInfo.element(instanceIndex).assign(vec4(0));
  })().compute(CELLS * 3);

  // ══════════════════════════════════════════ THE RESOLVE'S TAPS (§U.3)
  //
  // These are the only things `gatherProbes`' resolve needs from this file.
  // They are node closures rather than a second kernel because the resolve has
  // to interpolate EIGHT of them per pixel and a function call per tap is what
  // the octahedral plan/fetch split (see `octPlan`) exists to avoid.

  /** The lattice cell coords a world point falls between, and the fractions. */
  const cellFrame = (p) => {
    const g = p.div(SP).sub(0.5).toVar();
    return { base: g.floor().toVar(), frac: g.sub(g.floor()).toVar() };
  };
  /** Is this world lattice cell inside the current window? */
  const inLattice = (wcx, wcy, wcz) => {
    const o = wu.wpOrigin;
    const rx = wcx.sub(o.x).toVar();
    const ry = wcy.sub(o.y).toVar();
    const rz = wcz.sub(o.z).toVar();
    return rx.greaterThanEqual(0).and(ry.greaterThanEqual(0)).and(rz.greaterThanEqual(0))
      .and(rx.lessThan(C)).and(ry.lessThan(C)).and(rz.lessThan(C));
  };
  /**
   * ⭐⭐ THE LATTICE ENDS AND THE SCENE DOES NOT — MEASURED, NOT ANTICIPATED.
   *
   * The lattice is `C · s_p` across and camera-centred, so it reaches ±8 m at
   * the desktop tier. On Bistro's doors pose the picked dark pixels ran to a
   * p95 of 15 m and 6.3 % of them had NO live corner at all: the resolve's
   * weights all came out zero and the pixel composited BLACK. A screen probe
   * has no such horizon — it is placed wherever the camera looks and the window
   * hands its rays up to a 128 m level — so this is a regression the world path
   * introduces and it has to be answered inside it.
   *
   * The answer here is a CLAMP, not a rejection: a pixel outside reads the
   * nearest boundary cell's probe, which is a continuous extrapolation of the
   * field rather than a hole in it. It is an approximation and it is stated as
   * one — the far façade gets the ambient measured at the lattice's edge — and
   * the honest fix is a second, coarser cascade (RC's own answer), which is a
   * stage of its own. What this rules out is BLACK, which is not an
   * approximation of anything.
   */
  const clampToLattice = (wcx, wcy, wcz) => {
    const o = wu.wpOrigin;
    return [
      wcx.clamp(o.x, o.x.add(C - 1)),
      wcy.clamp(o.y, o.y.add(C - 1)),
      wcz.clamp(o.z, o.z.add(C - 1)),
    ];
  };
  const cellAt = (wcx, wcy, wcz) => slotOf(wcx.toInt(), wcy.toInt(), wcz.toInt());
  const infoAt = (cell, k) => wpInfo.element(infoIdx(cell, k));
  const shAt = (cell, i) => wpSh.element(shIdxW(cell, i));
  /** Bilinear radiance out of an `octPlan`'s four offsets. */
  const octTapRad = (plan, cell) => {
    const t = plan.offs.map((o) => decodeRgbe(wpOct.element(octIdxW(cell, o))));
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
   * lattice spacing — the scene's own length — and it makes the transition a
   * soft band of about half a cell, which is the resolution the map has.
   */
  const octTapVis = (plan, cell, dist) => {
    const w = plan.offs.map((o) => wpOct.element(octIdxW(cell, o).add(uint(1))));
    const m1 = mix(mix(meanOf(w[0]), meanOf(w[1]), plan.au),
      mix(meanOf(w[2]), meanOf(w[3]), plan.au), plan.av).toVar();
    const rm = mix(mix(rmsOf(w[0]), rmsOf(w[1]), plan.au),
      mix(rmsOf(w[2]), rmsOf(w[3]), plan.au), plan.av).toVar();
    const fl = wu.wpVarFloor.mul(SP).toVar();
    const varr = rm.mul(rm).sub(m1.mul(m1)).max(fl.mul(fl)).toVar();
    const dd = dist.sub(m1).toVar();
    const ch = varr.div(varr.add(dd.mul(dd))).toVar();
    const v = select(dist.lessThanEqual(m1), float(1), ch.mul(ch)).toVar();
    return mix(float(1), v, wu.wpVisOn.clamp(0, 1));
  };

  const describe = () => ({
    tier, cells: C, cellCount: CELLS, spacing: SP, extent: C * SP,
    traceSlots: TRACE_SLOTS, block: BLOCK, blocks: BLOCKS, oct: OCT,
    raysPerFrame: TRACE_SLOTS * OCT, distMax: DMAXW,
    bytes: {
      oct: CELLS * OCT * 2 * 4,
      sh: CELLS * 9 * 16,
      info: CELLS * 3 * 16,
      list: LIST_WORDS * 4,
    },
    totalMB: +(((CELLS * OCT * 2 * 4) + (CELLS * 9 * 16) + (CELLS * 3 * 16) + LIST_WORDS * 4)
      / 1048576).toFixed(2),
  });

  // ── the lattice's own placement ───────────────────────────────────────────
  const origin = new Int32Array(3);
  let placed = false;
  const setCamera = (pos) => {
    const p = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    let scrolled = false;
    for (let a = 0; a < 3; a++) {
      const camCell = Math.floor(p[a] / SP);
      const next = stepLatticeOrigin(camCell, placed ? origin[a] : null, C);
      if (!placed || next !== origin[a]) scrolled = true;
      origin[a] = next;
    }
    wu.wpOrigin.value.set(origin[0], origin[1], origin[2]);
    placed = true;
    return { scrolled, origin: [...origin] };
  };
  const reset = () => { placed = false; };

  /** Live probe count, out of a readback of `wpList`. */
  const readLive = (u32) => u32[CTL_OFF];

  return {
    tier, cells: C, cellCount: CELLS, spacing: SP, traceSlots: TRACE_SLOTS,
    uniforms: wu, buffers: { wpOct, wpSh, wpInfo, wpList },
    offsets: { FLAG_OFF, LIST_OFF, BASE_OFF, CTL_OFF },
    passes: {
      alloc: allocPass, count: countPass, scan: scanPass, fill: fillPass,
      trace: tracePass, sh: shPass, nee: neePass,
      clear: clearPass, clearInfo: clearInfoPass,
    },
    /** §U's per-frame order. The caller splices it into `frameOrder`. */
    frameOrder: [allocPass, countPass, scanPass, fillPass, tracePass, shPass, neePass]
      .filter(Boolean),
    taps: { cellFrame, inLattice, clampToLattice, cellAt, infoAt, shAt, octTapRad, octTapVis },
    setCamera, reset, readLive, describe,
    dispose() {
      for (const b of [wpOct, wpSh, wpInfo, wpList]) {
        if (b?.value) { b.value.array = b.value.array.constructor.from([]); b.value.dispose?.(); }
      }
    },
  };
}
