// GI2 — THE RADIANCE CACHE (audits §K.6, Stage 3.1/3.2)
//
// The world's memory of light. A pool of BRICK SLOTS; each slot is the 4³
// voxels of one window brick × 6 face directions × one packed HDR word =
// 64 × 6 × 4 B = 1536 B, exactly §K.6's budget. A slot is allocated to a brick
// the moment that brick is BUILT, freed when the brick leaves the window, and
// written by two producers: probe-ray hit shading (a fresh voxel face is shaded
// once, on demand) and `injectLitFrame` (visible pixels EMA their final lit
// colour into their own voxel face). Every ray hit reads it.
//
// That is what makes bounce light available OFF SCREEN: the cache is indexed by
// the world, not by the frame, so a ray that leaves the frustum still finds the
// radiance some earlier ray or some earlier frame put there.
//
// ══ ONE BUFFER, FIVE REGIONS ═════════════════════════════════════════════════
//
// The portable envelope (PLAN §4.6) is ≤ 6 storage buffers per pass, and the
// pass that needs this — `probeTrace` — already spends one on the window, one
// on the probe atlas, one on probe meta and one on stats. So the pool, the
// brick→slot map, the free queue and the control words live in ONE buffer at
// TIER-CONSTANT offsets, the same discipline `windowStore.js` uses:
//
//   data  [0                      , CACHE_BRICKS·384)   the slots
//   count [CNT_OFF                , +CACHE_BRICKS·96)   the sample count, 4/word
//   map   [MAP_OFF                , +levels·4096)       brick → slot+1, 0 = none
//   free  [FREE_OFF               , +CACHE_BRICKS)      the free queue
//   ctl   [CTL_OFF                , +8)                 cursor / queue / counters
//
// Every offset is derived from `CACHE_BRICKS` and `levels`, both tier
// constants, so the WGSL carries no scene number.
//
// ══ THE SAMPLE COUNT IS A PARALLEL BYTE, NOT A SECOND WORD (§19 3.7 P.1) ═════
//
// §P.1's estimator is `α = 1/min(n+1, N_CAP)` — a running mean over the shade
// samples a face collects — and `n` has to live somewhere. RGBE has no spare
// bit (that is the whole argument for RGBE over R11G11B10 below: the ZERO word
// is the freshness sentinel, and a stolen bit would make it ambiguous), so the
// two candidates §P.1 names were WIDENING the slot to 2 u32 and a PARALLEL
// count. The count wins on budget, on bandwidth and on bindings.
//
//   · BUDGET. Widening doubles the pool — 48 → 96 MB on desktop — to carry six
//     bits of state per 32 bits of payload. A byte per (voxel, face), four to a
//     word, is `SLOT_WORDS/4 = 96` words per slot: 12.58 MB desktop, 3.15 MB
//     phone, a 26 % surcharge on the pool and ~0.4 % of a 3 GB budget.
//   · BANDWIDTH. One extra word per ACCUMULATE, against a doubled slot's every
//     READ — and the cache is read by every one of the ~200 k rays a frame and
//     written by a fraction of them.
//   · BINDINGS, which is the one that actually decides it. `probeTrace` is the
//     kernel that accumulates and it already stands at the envelope's six
//     storage buffers exactly (window, cache, meta, oct, hzb, stats). A
//     separate count BUFFER would be a seventh and the kernel would not
//     compile on the portable tier. A fifth REGION of this buffer is free.
//
// ⚠ THE INCREMENT IS AN `atomicAdd` OF `1 << shift`, WHICH IS EXACT ONLY WHILE
// THE FIELD CANNOT CARRY. Four counts share a word, so incrementing one byte
// carries into its neighbour the moment that byte reaches 255. It is gated on
// `n < nCap` (16), so a byte can only overshoot by the number of rays that
// re-shade the same face in the same dispatch — tens, never 239. Reads clamp
// anyway; the GATE is what protects the neighbour's count, which a clamp
// could not repair.
//
// ══ WHY RGBE AND NOT R11G11B10 (§K.6 BENT, DELIBERATELY) ═════════════════════
//
// §K.6 specifies R11G11B10 per voxel face. Same 32 bits, but it has no spare
// bit — and this cache needs to answer "has anything ever shaded this face?"
// exactly, because §L.2's rule is "fresh slot → shade NOW". Reserving a bit
// out of R11G11B10 costs a mantissa bit in one channel and an asymmetry;
// packing 3 × 8-bit mantissas against a shared 8-bit exponent (RGBE) costs the
// same 32 bits, keeps the three channels symmetric, covers the full HDR range a
// sun-lit surface needs, and makes the freshness test EXACT: a word of 0 is
// unwritten, and a written BLACK still carries a non-zero exponent field. A
// sentinel that can collide with a legal value is the bug `windowStore.js`'s
// `WB_VALID` marker exists to document; this is the same lesson, applied to a
// different word.
//
// ══ ALLOCATION IS RACE-FREE BY OWNERSHIP, NOT BY CAS ═════════════════════════
//
// `allocPass` runs ONE thread per (level, brick). A brick's map entry therefore
// has exactly one writer, so the only contended object is the source of slot
// numbers — a monotone cursor (`atomicAdd`) with a free QUEUE behind it
// (`atomicAdd` on both ends). No compare-exchange, which WebGPU's TSL surface
// does not expose anyway, and no `select` over an atomic pointer (the trap this
// module's memory names): every read here is an `atomicLoad` whose VALUE is
// then compared.
import {
  Fn, If, Loop, atomicAdd, atomicLoad, atomicStore, atomicSub, bitAnd, bitOr, ceil, exp2, float, int,
  instanceIndex, instancedArray, log2, max, mix, select, shiftLeft, shiftRight, storage, uint, vec3,
  vec4,
} from "three/tsl";
import { sharedFn } from "../giFn.js";
import { BMASK_OFF, BRICKS_PER_LEVEL, BTAB_OFF, LEVEL_WORDS, STATE_BUILT } from "./windowStore.js";

/** Voxels per brick slot (4³) and face directions per voxel (§K.2's bit order). */
export const SLOT_VOXELS = 64;
export const SLOT_FACES = 6;
/** u32 words per slot, and the byte figure §K.6 budgets. */
export const SLOT_WORDS = SLOT_VOXELS * SLOT_FACES; // 384
export const SLOT_BYTES = SLOT_WORDS * 4; // 1536
/** One BYTE of sample count per (voxel, face), four to a word (§P.1). */
export const SLOT_CNT_WORDS = SLOT_WORDS / 4; // 96
/**
 * §P.1's `α = 1/min(n+1, N_CAP)`. Sixteen shade samples is a running mean whose
 * standard error is a quarter of one sample's — enough to take a 4-sample sun/
 * NEE/sky estimate from "the dirt" to a surface — and it is short enough that a
 * world change is followed at 1/16 per sample rather than forgotten. The cap is
 * what makes this an EMA rather than an unbounded average, i.e. what lets the
 * cache still track a moved lamp.
 */
export const CACHE_N_CAP = 16;

/**
 * §19 Stage 4.5's plane smoother steps one cell at a time through the TOROIDAL
 * voxel index (64 cells per axis), with the same wrap rule every other
 * neighbour read in this chain uses.
 */
const N_MASK = 63;

/** Pool size by tier (PLAN §4.6: phone 8 MB-class, desktop 32 k bricks). */
export const CACHE_TIERS = {
  phone: { bricks: 8192 },
  medium: { bricks: 8192 },
  high: { bricks: 32768 },
  ultra: { bricks: 32768 },
};

/** Control words. */
export const CTL_CURSOR = 0;
export const CTL_PUSH = 1;
export const CTL_POP = 2;
export const CTL_ALLOC = 3;
export const CTL_FREED = 4;
export const CTL_OVERFLOW = 5;
export const CTL_WORDS = 8;

/**
 * Face index of a world-space normal: 0 +X, 1 −X, 2 +Y, 3 −Y, 4 +Z, 5 −Z.
 *
 * This is the SAME numbering `windowTrace.js` returns as `faceId`, and the rule
 * that has to hold is that a hit and an injected pixel on one surface address
 * the same slot word — if those two ever disagree, the screen writes light into
 * a face no ray reads.
 *
 * ⚠⚠ §19 STAGE 3.9 — "THE ENTRY FACE IS THE SURFACE'S OWN FACE" WAS THE CLAIM,
 * AND IT WAS FALSE. It holds only for a wall that agrees with the voxel grid and
 * is hit head on. Bistro's façades do neither: 95 % of their wall voxels carry
 * all six face bits, so a grazing ray files its hit under ±Y, reads a slot no
 * pixel injects, and shades it from a point `ORIGIN_ESCAPE` walked into open
 * sun — 78-87× the wall's radiance, in half the words of a slab. BOTH producers
 * now go through `gatherProbes`' `dominantFace`, which reads the voxel's own
 * dominant normal out of the face byte's bits 6-7; this function is what the
 * fallback (and `injectLitFrame`'s side hint) is built from, not the rule.
 */
export const faceOfNormal = (n) => {
  const ax = n.x.abs();
  const ay = n.y.abs();
  const az = n.z.abs();
  const isX = ax.greaterThanEqual(ay).and(ax.greaterThanEqual(az));
  const isY = ay.greaterThanEqual(az);
  const fx = select(n.x.lessThan(0), float(1), float(0));
  const fy = select(n.y.lessThan(0), float(3), float(2));
  const fz = select(n.z.lessThan(0), float(5), float(4));
  return select(isX, fx, select(isY, fy, fz));
};

/** Outward normal of a face id (a FLOAT node). The inverse of `faceOfNormal`. */
export const normalOfFace = (fId) => vec3(
  select(fId.lessThan(0.5), float(1), select(fId.lessThan(1.5), float(-1), float(0))),
  select(fId.greaterThan(1.5).and(fId.lessThan(2.5)), float(1),
    select(fId.greaterThan(2.5).and(fId.lessThan(3.5)), float(-1), float(0))),
  select(fId.greaterThan(3.5).and(fId.lessThan(4.5)), float(1),
    select(fId.greaterThan(4.5), float(-1), float(0))),
);

// ── RGBE, the CPU mirror (the probe decodes readbacks with it) ───────────────

/** Pack a linear RGB triple into one RGBE word. 0 means "never written". */
export function packRgbe(r, g, b) {
  const m = Math.max(r, g, b, 1e-8);
  let e = Math.ceil(Math.log2(m));
  e = Math.max(-127, Math.min(127, e));
  const s = 255 / Math.pow(2, e);
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * s)));
  return ((q(r) | (q(g) << 8) | (q(b) << 16) | ((e + 128) << 24)) >>> 0);
}

/** Unpack an RGBE word. A word of 0 decodes to null — nothing has written it. */
export function unpackRgbe(word) {
  if ((word >>> 0) === 0) return null;
  const e = ((word >>> 24) & 255) - 128;
  const s = Math.pow(2, e) / 255;
  return [(word & 255) * s, ((word >>> 8) & 255) * s, ((word >>> 16) & 255) * s];
}

/**
 * The cache.
 *
 * @param {object} win  from `createGiWindow`
 * @param {object} [opts]
 * @param {string} [opts.tier]    defaults to the window's
 * @param {number} [opts.bricks]  override the pool size (harness only)
 * @param {boolean} [opts.erc]  build the §19 5.3b PER-FACE IRRADIANCE region.
 *
 * ⭐⭐⭐ §19 STAGE 5.3b — WHY `E_rc` LIVES IN **THIS** BUFFER AND NOT A SECOND
 * ONE. [J] already binds the cache, and the portable tier allows EIGHT storage
 * buffers per kernel; a ninth binding is not a cost, it is a kernel that does
 * not compile. A second REGION of the same `instancedArray` is therefore not an
 * optimisation — it is the only shape in which a secondary cache can exist at
 * all on the phone tier.
 *
 * The region is a PARALLEL array with the SAME addressing as the direct one
 * (`slot × SLOT_WORDS + lv × 6 + face`, one RGBE word), so `ercRead` and
 * `cacheRead` cannot disagree about which face they are on; appending it AFTER
 * `CTL` leaves every existing offset — and every harness that prints them —
 * numerically unchanged.
 *
 * OFF by default: the shipped GI2 chain allocates not one word of it, so 5.3's
 * memory receipt (`describe().totalMB`) is the same number it was.
 */
export function createRadianceCache(win, { tier = win.tier, bricks = null, erc = false } = {}) {
  const spec = CACHE_TIERS[tier];
  if (!spec) throw new Error(`unknown cache tier "${tier}"`);
  const CACHE_BRICKS = bricks ?? spec.bricks;
  const levels = win.levels;

  const DATA_OFF = 0;
  const DATA_WORDS = CACHE_BRICKS * SLOT_WORDS;
  const CNT_OFF = DATA_OFF + DATA_WORDS;
  const CNT_WORDS = CACHE_BRICKS * SLOT_CNT_WORDS;
  const MAP_OFF = CNT_OFF + CNT_WORDS;
  const MAP_WORDS = levels * BRICKS_PER_LEVEL;
  const FREE_OFF = MAP_OFF + MAP_WORDS;
  const FREE_WORDS = CACHE_BRICKS;
  const CTL_OFF = FREE_OFF + FREE_WORDS;
  const ERC_OFF = CTL_OFF + CTL_WORDS;
  const ERC_WORDS = erc ? CACHE_BRICKS * SLOT_WORDS : 0;
  const words = ERC_OFF + ERC_WORDS;

  const buffer = instancedArray(new Uint32Array(words), "uint");
  const attribute = buffer.value;
  const atomics = storage(attribute, "uint", words).toAtomic();

  // ── the packing, TSL side ──────────────────────────────────────────────────
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

  /**
   * Word address of one (level, voxel, face) — the whole addressing rule.
   *
   * `voxelIdx` is the window's TOROIDAL index (`cx | cy<<6 | cz<<12`), so the
   * brick is its top 4 bits per axis and the in-brick voxel its bottom 2. Both
   * fall out of the same word with shifts; nothing here needs the world coord,
   * which is exactly why the cache scrolls for free with the window.
   */
  const addressOf = (levelU, voxelIdxU, faceU) => {
    const cx = bitAnd(voxelIdxU, uint(63)).toVar();
    const cy = bitAnd(shiftRight(voxelIdxU, uint(6)), uint(63)).toVar();
    const cz = bitAnd(shiftRight(voxelIdxU, uint(12)), uint(63)).toVar();
    const b = bitOr(
      bitOr(shiftRight(cx, uint(2)), shiftLeft(shiftRight(cy, uint(2)), uint(4))),
      shiftLeft(shiftRight(cz, uint(2)), uint(8)),
    ).toVar();
    const lv = bitOr(
      bitOr(bitAnd(cx, uint(3)), shiftLeft(bitAnd(cy, uint(3)), uint(2))),
      shiftLeft(bitAnd(cz, uint(3)), uint(4)),
    ).toVar();
    const mapIdx = uint(MAP_OFF).add(levelU.mul(uint(BRICKS_PER_LEVEL))).add(b).toVar();
    return { mapIdx, lv, faceU };
  };

  // ══════════════════════════════════════════════════════ READ (a `sharedFn`)
  //
  // Returns `vec4(rgb, valid)`. `valid` is 0 when the brick owns no slot OR the
  // face has never been written — the caller's cue to shade it now (§L.2).
  //
  // Every argument is a float: three's function LAYOUTS are the mechanism that
  // makes this one WGSL function per shader instead of an inlined body at every
  // call site (see `giFn.js`), and floats keep the signature portable across the
  // three call sites (probe trace, injection, relight) without a cast rule.
  /**
   * The read, INLINE — the body `cacheReadFn` wraps, as a plain JS composer so
   * that a caller which is ITSELF a `sharedFn` can use it.
   *
   * The plane smoother needs a neighbour's word from inside `cacheAccumFn`,
   * which is itself a `sharedFn`. Splitting the body out is the conservative
   * shape for that: nothing else in this chain calls one layout'd function from
   * inside another (`shadeHit` and `hitRadiance` call `traceWindow` and
   * `cacheRead`, but those callers are plain JS inlined into the kernel), and
   * `giFn.js`'s header is a long account of how this class of codegen fails.
   *
   * ⛔ NESTING IS NOT WHAT KILLED THE SMOOTHER'S FIRST BUILD, and the refuted
   * theory is recorded here because it cost a battery. That build came back
   * `[Invalid ShaderModule "compute"]` with the watchdog re-rolling four times
   * and no first light; nesting was the leading suspect and the split was made
   * on it. The module's own message — once the console was READ instead of
   * filtered for the patterns someone expected — said `error: 'smooth' is a
   * reserved keyword`, which is the layout input name three lines below.
   * [[gi-colour-probe-method]]: read the stage that failed and take the FIRST
   * thing it says, rather than the most interesting thing it might have meant.
   * The split is kept because it is cheaper, not because it fixed anything.
   */
  const readInlineAt = (regionOff, levelU, voxelU, faceU0) => {
    const { mapIdx, lv, faceU } = addressOf(levelU, voxelU, faceU0);
    const m = atomicLoad(atomics.element(mapIdx)).toVar();
    // Index with a CLAMPED slot even when there is none: a read of slot 0 is
    // harmless and gated below, while an `If()` around a buffer read is the
    // idiom that rendered the BVH mirror pass black (windowTrace's note).
    const slot = m.max(uint(1)).sub(uint(1)).toVar();
    const addr = uint(regionOff).add(slot.mul(uint(SLOT_WORDS))).add(lv.mul(uint(SLOT_FACES))).add(faceU).toVar();
    const word = atomicLoad(atomics.element(addr)).toVar();
    const ok = m.notEqual(uint(0)).and(word.notEqual(uint(0)));
    return vec4(decodeRgbe(word), select(ok, float(1), float(0)));
  };
  const readInline = (levelU, voxelU, faceU0) => readInlineAt(DATA_OFF, levelU, voxelU, faceU0);
  const cacheReadFn = sharedFn({
    name: "gi2CacheRead",
    type: "vec4",
    inputs: [
      { name: "level", type: "float" },
      { name: "voxelIdx", type: "float" },
      { name: "face", type: "float" },
    ],
    body: (levelF, voxelF, faceF) =>
      readInline(levelF.toUint(), voxelF.toUint(), faceF.toUint()),
  });

  // ═════════════════════════════════════════════════════ WRITE (a `sharedFn`)
  //
  // EMA in place. `alpha` is the blend toward the new value; a face that has
  // never been written takes the new value whole (α = 1) whatever the caller
  // asked for, so the first shade is not diluted by a black that means "no
  // data" rather than "no light".
  //
  // ⚠ LAST WRITER WINS. Two rays hitting the same voxel face in one dispatch
  // race on the read-modify-write. An atomic RMW cannot express an EMA on a
  // packed word without a CAS loop, which this surface has no primitive for.
  // The consequence is a slightly noisier EMA, never a corrupt word — the
  // store is atomic, so the word is always ONE of the candidate values.
  const cacheWriteFn = sharedFn({
    name: "gi2CacheWrite",
    type: "float",
    inputs: [
      { name: "level", type: "float" },
      { name: "voxelIdx", type: "float" },
      { name: "face", type: "float" },
      { name: "rgb", type: "vec3" },
      { name: "alpha", type: "float" },
    ],
    body: (levelF, voxelF, faceF, rgb, alpha) => {
      const { mapIdx, lv, faceU } = addressOf(levelF.toUint(), voxelF.toUint(), faceF.toUint());
      const m = atomicLoad(atomics.element(mapIdx)).toVar();
      const done = float(0).toVar();
      If(m.notEqual(uint(0)), () => {
        const slot = m.sub(uint(1)).toVar();
        const addr = uint(DATA_OFF).add(slot.mul(uint(SLOT_WORDS)))
          .add(lv.mul(uint(SLOT_FACES))).add(faceU).toVar();
        const old = atomicLoad(atomics.element(addr)).toVar();
        const a = select(old.equal(uint(0)), float(1), alpha).toVar();
        const blended = mix(decodeRgbe(old), rgb.max(vec3(0)), a).toVar();
        atomicStore(atomics.element(addr), encodeRgbe(blended));
        done.assign(1);
      });
      return done;
    },
  });

  // ═══════════════ §19 STAGE 5.3b — THE SECONDARY (IRRADIANCE) CACHE ════════
  //
  // ⭐⭐⭐ WHAT THIS REGION HOLDS, AND WHY IT IS NOT THE SAME QUANTITY AS THE
  // ONE ABOVE. `DATA` is a face's outgoing RADIANCE from the DIRECT lights —
  // `Le + ρ/π·(sun + NEE)`, a fixed function of the geometry and the lights.
  // `ERC` is the face's incoming IRRADIANCE from the MERGED CASCADES, i.e. the
  // paper's secondary cache: everything the field carries at that face, sky and
  // bounce alike. [J] adds `ρ·E_rc/π` to the direct word and deposits the sum,
  // so the two regions are the two halves of one hit's radiance and MUST share
  // an address, which is why this is a parallel array and not a second table.
  //
  // ⚠ IT IS DELIBERATELY **NOT** ACCUMULATED WITH THE COUNT-CAPPED α THE DIRECT
  // TERM USES. That α (`1/(n+1)` up to `nCap`) converges a NOISY estimator onto
  // its mean; `gatherAt` is not noisy — it is a deterministic eight-probe
  // interpolation of a field that already carries `TEMPORAL_ALPHA` — so
  // averaging it again would only add latency, and the user's rule is that
  // nothing on this path may buy quality with history. The blend here is a
  // caller's α whose SHIPPED VALUE IS 1: the refresh writes what the field says
  // now, which makes the write ORDER-FREE (every ray that reaches a face in one
  // frame computes the same value from the same point and normal, so which of
  // them lands last cannot change the word) and keeps §T.
  const ercReadFn = erc ? sharedFn({
    name: "gi2ErcRead",
    type: "vec4",
    inputs: [
      { name: "level", type: "float" },
      { name: "voxelIdx", type: "float" },
      { name: "face", type: "float" },
    ],
    body: (levelF, voxelF, faceF) =>
      readInlineAt(ERC_OFF, levelF.toUint(), voxelF.toUint(), faceF.toUint()),
  }) : null;

  const ercWriteFn = erc ? sharedFn({
    name: "gi2ErcWrite",
    type: "float",
    inputs: [
      { name: "level", type: "float" },
      { name: "voxelIdx", type: "float" },
      { name: "face", type: "float" },
      { name: "rgb", type: "vec3" },
      { name: "alpha", type: "float" },
    ],
    body: (levelF, voxelF, faceF, rgb, alpha) => {
      const { mapIdx, lv, faceU } = addressOf(levelF.toUint(), voxelF.toUint(), faceF.toUint());
      const m = atomicLoad(atomics.element(mapIdx)).toVar();
      const done = float(0).toVar();
      If(m.notEqual(uint(0)), () => {
        const slot = m.sub(uint(1)).toVar();
        const addr = uint(ERC_OFF).add(slot.mul(uint(SLOT_WORDS)))
          .add(lv.mul(uint(SLOT_FACES))).add(faceU).toVar();
        const old = atomicLoad(atomics.element(addr)).toVar();
        const a = select(old.equal(uint(0)), float(1), alpha).toVar();
        atomicStore(
          atomics.element(addr),
          encodeRgbe(mix(decodeRgbe(old), rgb.max(vec3(0)), a)),
        );
        done.assign(1);
      });
      return done;
    },
  }) : null;

  // ═══════════════════════════════════════════════ ACCUMULATE (a `sharedFn`)
  //
  // ⭐⭐ §19 STAGE 3.7 P.1 — THE CACHE WAS ONE-SHOT, AND THAT WAS THE DIRT.
  //
  // Until 3.7 a voxel face was shaded ONCE, on the first ray that reached it,
  // with `α = 1` and a 2×2-stratified estimate of the panel plus one sun shadow
  // ray — and then never again, because the next ray read the stored word.
  // Four samples of a hemisphere is not an estimate of that hemisphere; it is
  // one draw from a distribution an order of magnitude wide, kept FOREVER. Two
  // neighbouring voxels on one flat wall therefore hold two unrelated draws,
  // and the probe filter smears the pair into a blob 0.3–1 m across that does
  // not move, does not fade and does not average out — which is exactly the
  // "very dirty" the user photographed. Measured on Bistro's shaded façade
  // before this function existed: the σ/mean ACROSS the 64 voxel faces of one
  // 1 m brick had a median of 110 %, on a wall whose real radiance varies by a
  // few percent across it.
  //
  // So a hit may now RE-shade (§P.1's `p_shade`), and the estimator becomes a
  // running mean: `α = 1/min(n+1, nCap)`, `n` the byte in the parallel count
  // region. The first sample still lands whole (`old == 0` ⇒ α = 1), so nothing
  // about first light changes; sample 2 lands at ½, sample 16 at 1/16, and from
  // there the face is an EMA that still follows a moved lamp.
  //
  // ⚠ THE α IS DERIVED FROM `n`, NEVER PASSED IN. `cacheWrite` below keeps its
  // caller-supplied α because `injectLitFrame` is not a sampler — it writes an
  // EXACT lit colour for a surface the camera can see and has its own time
  // constant. Two producers, two rules, one word; the count belongs to the one
  // that is estimating.
  //
  // ⭐⭐ §19 STAGE 4.5 — AND THE SURFACE IS SMOOTH, SO THE CACHE OF IT MUST BE.
  //
  // §AD's face-term census settles what §AC could only bound. On the terrace
  // wall NOT ONE of the four sky rays ever misses (a Paris street is a canyon),
  // the sun is invisible from every face, the emitter NEE is zero, and **100 %
  // of a face's radiance is the SECOND BOUNCE it reads back out of this cache**.
  // The estimator is therefore a Neumann iteration whose input is the cache's
  // own field: a face's value is the mean of four other faces' values, so any
  // spread the cache carries is re-injected into every face that looks at it.
  // Measured on that wall: adjacent faces 21.6 % apart at p50, 77.0 % at p90.
  //
  // The cheapest place to break the loop is the WRITE. `mix(estimate,
  // neighbourhood mean, w)` is one Jacobi sweep of a screened-Poisson smoother
  // over the surface, taken where a face is already being written — six
  // neighbour reads per SHADE (~10⁴ a frame), not per ray HIT (~10⁵ a frame).
  // And because a sweep runs every time the face is revisited it is an IIR, not
  // a 7-tap box: the converged kernel is ~√(w/(1−w)) cells wide, which is
  // [[gi-vxao-rebuild]]'s "width is the cheap axis" applied to a cache instead
  // of to an AO filter — variance bought with taps, not with rays.
  //
  // ⚠ ENERGY IS PRESERVED BY CONSTRUCTION, and that is why this shape and not a
  // blur. The weights — `1−w` on self, `w/k` on each of the k VALID neighbours —
  // sum to exactly 1, so the operator is row-stochastic: it moves light ALONG a
  // surface and can neither create nor destroy it. Presets and fixes trade rays,
  // never energy.
  //
  // ⚠ AND IT IS THE SIX AXIS NEIGHBOURS, NOT A TANGENTIAL 3×3. §AD's wall runs
  // at 45° to both horizontal axes, so its conservative voxelization is a
  // STAIRCASE: consecutive cells of one wall differ along the face's own normal
  // axis as often as along a tangential one. A filter that walked only the
  // tangential plane would have found two valid taps of eight on the very wall
  // the complaint is about. Six axis neighbours catch the flat wall and the
  // diagonal one with the same six reads.
  //
  // ⚠ AN INVALID TAP IS DROPPED, NEVER AVERAGED IN AS BLACK. A neighbour that is
  // air, that belongs to an unallocated brick, or that no producer has reached
  // yet is NO DATA — counting a zero for it would darken every silhouette on the
  // surface by the open fraction of its neighbourhood, which is a bias in the
  // shape of an outline. The weight goes back to self, so a face with no valid
  // neighbours stores its own estimate exactly as before.
  const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const cacheAccumFn = sharedFn({
    name: "gi2CacheAccum",
    type: "float",
    inputs: [
      { name: "level", type: "float" },
      { name: "voxelIdx", type: "float" },
      { name: "face", type: "float" },
      { name: "rgb", type: "vec3" },
      { name: "nCap", type: "float" },
      // ⚠⚠ `smoothW`, NOT `smooth` — THE LAYOUT'S INPUT NAME *IS* THE WGSL
      // PARAMETER NAME, AND `smooth` IS A RESERVED KEYWORD. A whole battery died
      // on this: the module failed with "error: 'smooth' is a reserved keyword",
      // the §12.56 watchdog re-rolled the pipeline four times, "transport never
      // produced light", and first light NEVER arrived. Nothing about this name
      // reaches JS, so it reads as a free choice and is not one.
      { name: "smoothW", type: "float" },
    ],
    body: (levelF, voxelF, faceF, rgb0, nCapF, smoothF) => {
      const { mapIdx, lv, faceU } = addressOf(levelF.toUint(), voxelF.toUint(), faceF.toUint());
      const m = atomicLoad(atomics.element(mapIdx)).toVar();
      const alpha = float(0).toVar();
      // ── the plane smoother, evaluated before the store ────────────────────
      const rgb = vec3(rgb0).toVar();
      If(smoothF.greaterThan(0.001), () => {
        const vi = voxelF.toUint().toVar();
        const cx = bitAnd(vi, uint(63)).toInt().toVar();
        const cy = bitAnd(shiftRight(vi, uint(6)), uint(63)).toInt().toVar();
        const cz = bitAnd(shiftRight(vi, uint(12)), uint(63)).toInt().toVar();
        const acc = vec3(0).toVar();
        const cnt = float(0).toVar();
        for (const [dx, dy, dz] of NB) {
          // Toroidal, exactly as `gatherProbes.dominantFace`'s neighbour read
          // is: a voxel on the 64th cell reads the far side of its own window.
          // One cell in 64 per axis, at the boundary the trace has already
          // handed off to a coarser level.
          const nvi = bitOr(
            bitOr(bitAnd(cx.add(int(dx)), int(N_MASK)).toUint(),
              shiftLeft(bitAnd(cy.add(int(dy)), int(N_MASK)).toUint(), uint(6))),
            shiftLeft(bitAnd(cz.add(int(dz)), int(N_MASK)).toUint(), uint(12)),
          ).toVar();
          const c = readInline(levelF.toUint(), nvi, faceF.toUint()).toVar();
          acc.addAssign(c.xyz.mul(c.w));
          cnt.addAssign(c.w);
        }
        If(cnt.greaterThan(0.5), () => {
          rgb.assign(mix(rgb0, acc.div(cnt), smoothF));
        });
      });
      If(m.notEqual(uint(0)), () => {
        const slot = m.sub(uint(1)).toVar();
        const sub = lv.mul(uint(SLOT_FACES)).add(faceU).toVar(); // 0..383
        const addr = uint(DATA_OFF).add(slot.mul(uint(SLOT_WORDS))).add(sub).toVar();
        const cAddr = uint(CNT_OFF).add(slot.mul(uint(SLOT_CNT_WORDS)))
          .add(shiftRight(sub, uint(2))).toVar();
        const shiftB = bitAnd(sub, uint(3)).mul(uint(8)).toVar();
        const n = bitAnd(shiftRight(atomicLoad(atomics.element(cAddr)), shiftB), uint(255)).toVar();
        const old = atomicLoad(atomics.element(addr)).toVar();
        const cap = nCapF.max(1).toVar();
        const a = select(old.equal(uint(0)), float(1),
          float(1).div(n.toFloat().add(1).min(cap))).toVar();
        atomicStore(atomics.element(addr), encodeRgbe(mix(decodeRgbe(old), rgb.max(vec3(0)), a)));
        // Only while the byte cannot carry — see the header's note.
        If(n.toFloat().lessThan(cap), () => {
          atomicAdd(atomics.element(cAddr), shiftLeft(uint(1), shiftB));
        });
        alpha.assign(a);
      });
      return alpha;
    },
  });

  // ══════════════════════════════════════════════════════════ SHADER: alloc
  //
  // One thread per (static level, brick). Owns that brick's map entry outright.
  const allocPass = Fn(() => {
    const idx = instanceIndex.toVar();
    const level = idx.div(uint(BRICKS_PER_LEVEL)).toVar();
    const b = idx.sub(level.mul(uint(BRICKS_PER_LEVEL))).toVar();

    const levelBase = level.mul(uint(LEVEL_WORDS)).toVar();
    const state = win.buffer.element(levelBase.add(uint(BTAB_OFF)).add(b.mul(uint(2))).add(uint(1))).toVar();
    // §K.6 says "allocated at finishBricks"; the analytic fill marks BUILT with
    // an atomicMax, and the task's fallback ("any brick with mask ≠ 0") is kept
    // as a second witness so a filler that forgets the state word still gets a
    // slot rather than silently caching nothing.
    const maskWord = win.buffer.element(levelBase.add(uint(BMASK_OFF)).add(shiftRight(b, uint(5)))).toVar();
    const occupied = bitAnd(maskWord, shiftLeft(uint(1), bitAnd(b, uint(31)))).notEqual(uint(0));
    const built = state.equal(uint(STATE_BUILT)).or(occupied);

    const mapIdx = uint(MAP_OFF).add(level.mul(uint(BRICKS_PER_LEVEL))).add(b).toVar();
    const cur = atomicLoad(atomics.element(mapIdx)).toVar();

    If(built, () => {
      If(cur.equal(uint(0)), () => {
      // Cursor first (the pool is fresh), free queue behind it (the pool has
      // wrapped and scroll has handed slots back).
      const slot = uint(0xffffffff).toVar();
      const c = atomicAdd(atomics.element(uint(CTL_OFF + CTL_CURSOR)), uint(1)).toVar();
      If(c.lessThan(uint(CACHE_BRICKS)), () => {
        slot.assign(c);
      }).Else(() => {
        const p = atomicAdd(atomics.element(uint(CTL_OFF + CTL_POP)), uint(1)).toVar();
        const pushed = atomicLoad(atomics.element(uint(CTL_OFF + CTL_PUSH))).toVar();
        If(p.lessThan(pushed), () => {
          slot.assign(atomicLoad(atomics.element(uint(FREE_OFF).add(bitAnd(p, uint(CACHE_BRICKS - 1))))));
        }).Else(() => {
          // Over-popped an empty queue: give the index back and record it. The
          // brick simply has no cache this frame and its hits shade every time.
          atomicSub(atomics.element(uint(CTL_OFF + CTL_POP)), uint(1));
          atomicAdd(atomics.element(uint(CTL_OFF + CTL_OVERFLOW)), uint(1));
        });
      });
      If(slot.notEqual(uint(0xffffffff)), () => {
        const base = uint(DATA_OFF).add(slot.mul(uint(SLOT_WORDS))).toVar();
        Loop({ start: 0, end: SLOT_WORDS, name: "cacheZero" }, ({ cacheZero }) => {
          atomicStore(atomics.element(base.add(uint(cacheZero))), uint(0));
        });
        // ⚠ AND THE COUNTS WITH THEM. A recycled slot that kept a previous
        // brick's `n = 16` would give its FIRST sample α = 1/17 — the new
        // face would inherit the old face's convergence and take a hundred
        // samples to forget a wall it never was. The radiance word's zero is
        // the freshness sentinel; the count has no sentinel and must be
        // cleared with the data it describes.
        const cbase = uint(CNT_OFF).add(slot.mul(uint(SLOT_CNT_WORDS))).toVar();
        Loop({ start: 0, end: SLOT_CNT_WORDS, name: "cntZero" }, ({ cntZero }) => {
          atomicStore(atomics.element(cbase.add(uint(cntZero))), uint(0));
        });
        // §19 5.3b — AND THE IRRADIANCE REGION, FOR THE SAME REASON. A recycled
        // slot that kept a previous brick's `E_rc` would hand [J] a valid-
        // looking word for a face that has never been gathered, and the refresh
        // budget would then leave a stranger's bounce in place for `period`
        // frames — the freshness sentinel is the zero word, so it has to be
        // written at exactly the same moment the direct one is.
        if (erc) {
          const ebase = uint(ERC_OFF).add(slot.mul(uint(SLOT_WORDS))).toVar();
          Loop({ start: 0, end: SLOT_WORDS, name: "ercZero" }, ({ ercZero }) => {
            atomicStore(atomics.element(ebase.add(uint(ercZero))), uint(0));
          });
        }
        atomicStore(atomics.element(mapIdx), slot.add(uint(1)));
        atomicAdd(atomics.element(uint(CTL_OFF + CTL_ALLOC)), uint(1));
      });
      });
    }).Else(() => {
      If(cur.notEqual(uint(0)), () => {
        const p = atomicAdd(atomics.element(uint(CTL_OFF + CTL_PUSH)), uint(1)).toVar();
        atomicStore(atomics.element(uint(FREE_OFF).add(bitAnd(p, uint(CACHE_BRICKS - 1)))), cur.sub(uint(1)));
        atomicStore(atomics.element(mapIdx), uint(0));
        atomicAdd(atomics.element(uint(CTL_OFF + CTL_FREED)), uint(1));
      });
    });
  })().compute(levels * BRICKS_PER_LEVEL);

  // ═══════════════════════════════════════════════════════════ SHADER: clear
  const clearPass = Fn(() => {
    atomicStore(atomics.element(instanceIndex), uint(0));
  })().compute(words);

  const describe = () => ({
    tier,
    bricks: CACHE_BRICKS,
    slotBytes: SLOT_BYTES,
    dataBytes: DATA_WORDS * 4,
    countBytes: CNT_WORDS * 4,
    mapBytes: MAP_WORDS * 4,
    freeBytes: FREE_WORDS * 4,
    ercBytes: ERC_WORDS * 4,
    totalBytes: words * 4,
    totalMB: +((words * 4) / (1024 * 1024)).toFixed(2),
    offsets: { DATA_OFF, CNT_OFF, MAP_OFF, FREE_OFF, CTL_OFF, ERC_OFF },
  });

  return {
    tier, bricks: CACHE_BRICKS, words, erc: !!erc,
    buffer, atomics, attribute,
    DATA_OFF, CNT_OFF, MAP_OFF, FREE_OFF, CTL_OFF, ERC_OFF,
    allocPass, clearPass,
    /**
     * §19 5.3b — the SECONDARY cache: `(level, voxelIdx, face) → vec4(E, valid)`
     * and its α-blended write. Both are `null` unless the cache was built with
     * `erc`, so a caller that forgot the flag fails at build with a TypeError
     * on the closure rather than by silently reading the direct region.
     */
    ercRead: ercReadFn
      ? ((levelF, voxelF, faceF) => ercReadFn(float(levelF), float(voxelF), float(faceF)))
      : null,
    ercWrite: ercWriteFn
      ? ((levelF, voxelF, faceF, rgb, alphaF) =>
        ercWriteFn(float(levelF), float(voxelF), float(faceF), vec3(rgb), float(alphaF)))
      : null,
    /** `(level, voxelIdx, face) → vec4(rgb, valid)`; all args float nodes. */
    cacheRead: (levelF, voxelF, faceF) => cacheReadFn(float(levelF), float(voxelF), float(faceF)),
    /** `(level, voxelIdx, face, rgb, alpha) → float`; 1 if the brick had a slot. */
    cacheWrite: (levelF, voxelF, faceF, rgb, alphaF) =>
      cacheWriteFn(float(levelF), float(voxelF), float(faceF), vec3(rgb), float(alphaF)),
    /**
     * §P.1's running mean: `(level, voxelIdx, face, rgb, nCap) → α used`.
     * The α comes from the face's own sample count; the caller supplies only
     * the cap. Returns 0 when the brick owns no slot.
     */
    cacheAccum: (levelF, voxelF, faceF, rgb, nCapF = CACHE_N_CAP, smoothF = 0) =>
      cacheAccumFn(float(levelF), float(voxelF), float(faceF), vec3(rgb), float(nCapF),
        float(smoothF)),
    /** The sample count of one (slot, voxel, face), out of a CPU readback. */
    readCount(u32, slot, lv, face) {
      const sub = lv * SLOT_FACES + face;
      return (u32[CNT_OFF + slot * SLOT_CNT_WORDS + (sub >> 2)] >>> ((sub & 3) * 8)) & 255;
    },
    faceOfNormal, normalOfFace,
    /** Readback helper: the control words, decoded. */
    readControl(u32) {
      return {
        cursor: u32[CTL_OFF + CTL_CURSOR],
        pushed: u32[CTL_OFF + CTL_PUSH],
        popped: u32[CTL_OFF + CTL_POP],
        allocated: u32[CTL_OFF + CTL_ALLOC],
        freed: u32[CTL_OFF + CTL_FREED],
        overflow: u32[CTL_OFF + CTL_OVERFLOW],
      };
    },
    describe,
    dispose() {
      attribute.array = new Uint32Array(0);
      attribute.dispose?.();
    },
  };
}
