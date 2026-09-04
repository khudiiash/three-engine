// SPLIT RADIANCE CASCADES — the math kernel, in plain JS.
//
// EVERY function here has a TSL twin in `srcMathTsl.js`. They are two
// expressions of ONE definition and MUST change together — the same contract
// `emitterShapes.js` and its `giLight.js` twins live under, for the same
// earned reason: when the CPU mirror and the GPU kernel disagree, the mirror
// test goes green while the screen is wrong, and the disagreement is invisible
// until someone measures a third thing.
//
// Plain JS deliberately (no `three`, no `three/tsl`): the Phase-0 reference
// suite must run in bare Node with no GPU, no adapter and no headless WebGPU
// shim, because that is the only kind of test that stays trustworthy when the
// GPU path is the thing under suspicion.
//
// docs/GI_SRC_REBUILD_PLAN.md §2 items 2, 3, 5, 7, 8; §4.2.

import {
  COLD_FILL_FRAMES,
  INFLUX_ONE,
  INPAINT_DISCOUNT,
  INPAINT_LOW,
  KEY_MAX_LODS,
  SUM_SCALE,
  SURPRISE_FLOOR,
  SURPRISE_MIN_EVIDENCE,
  SURPRISE_ONE,
  SURPRISE_RATE,
  SURPRISE_SHOT_K,
  SURPRISE_T0,
  SURPRISE_T1,
  confidenceArmed,
  confidenceFullRays,
  confidencePriorRays,
} from "./srcConfig.js";

// ═══════════════════════════════════════════════ EQUAL-AREA CYLINDRICAL BINS
//
// Paper Alg. 2: φ = 2πx, z = 2y − 1. This is the Archimedes / Lambert
// cylindrical equal-area projection, and "equal-area" is the entire point:
// every bin subtends the SAME solid angle, so a bin average is already a
// solid-angle-weighted average and needs no Jacobian correction.
//
// THAT IS THE OPPOSITE OF THE OCTAHEDRAL MAP we use elsewhere, whose texels
// vary 2.73× in solid angle and therefore need `octahedralTexelWeight` on
// every gather (see srcOctahedral below — it survives for the irradiance
// tiles). The paper measured octahedral AND Clarberg bins as WORSE than this
// despite better angular uniformity, which is counterintuitive enough to be
// worth restating: the win here is not uniformity, it is that the 4→1 parent
// mapping is exact integer halving with no resampling.

/** Bin (i, j) on the 2w×w grid → its centre's (x, y) in [0,1)². */
export function binCenterXY(i, j, w) {
  return { x: (i + 0.5) / (2 * w), y: (j + 0.5) / w };
}

/**
 * (x, y) ∈ [0,1)² → unit direction. Equal-area by construction.
 *
 * `r = sqrt((1−z)(1+z))` rather than the textbook `sqrt(1 − z²)`: near the
 * poles `z·z` rounds to within an ulp of 1 and the subtraction cancels nearly
 * every significant bit. The factored form has no cancellation (`1 − z` is
 * exact for z ∈ [0.5, 2] and `1 + z` for the mirror), which matters little in
 * f64 and a great deal in the f32 twin, where the twin gate measured the naive
 * form at 1.3e-5 of absolute error against this one. Both files carry the same
 * expression because they are one definition.
 */
export function decodeDir(x, y) {
  const phi = 2 * Math.PI * x;
  const z = 2 * y - 1;
  const r = Math.sqrt(Math.max(0, (1 - z) * (1 + z)));
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

/** Unit direction → (x, y) ∈ [0,1)². Exact inverse of decodeDir. */
export function encodeDir(dx, dy, dz) {
  let phi = Math.atan2(dy, dx);
  if (phi < 0) phi += 2 * Math.PI;
  let x = phi / (2 * Math.PI);
  // atan2 can return exactly 2π-ε that rounds to 1.0 — a bin index of 2w is
  // out of range, and clamping it silently folds the last azimuth sliver into
  // its neighbour. Wrap instead.
  if (x >= 1) x -= 1;
  return { x, y: Math.min(0.9999999999, Math.max(0, (dz + 1) * 0.5)) };
}

/** Bin (i, j) for a direction on the 2w×w grid at width `w`. */
export function dirToBin(dx, dy, dz, w) {
  const { x, y } = encodeDir(dx, dy, dz);
  const i = Math.min(2 * w - 1, Math.max(0, Math.floor(x * 2 * w)));
  const j = Math.min(w - 1, Math.max(0, Math.floor(y * w)));
  return { i, j };
}

/** Bin centre direction for (i, j) at width `w`. */
export function binDir(i, j, w) {
  const { x, y } = binCenterXY(i, j, w);
  return decodeDir(x, y);
}

// ═══════════════════════════════════════ §11.28 THE RADIANCE CENTROID
//
// A bin's payload carries, in its spare half, the OFFSET of the luminance-
// weighted mean direction of its radiance from the bin's area centroid —
// two signed bytes in the bin's tangent frame. An offset, not a direction,
// for one reason that the first cut learned from the furnace gate: the merge
// averages children with confidence weights, and the weighted mean of four
// unit directions cannot equal any fixed reference — so a UNIFORM field
// carried a spurious few-degree "centroid" that a grazing bin turned into a
// 9× texel. An offset is linear: the weighted mean of zero offsets is zero,
// at every level, for any weights. The resolve writes code 0 (no sub-bin
// information = zero offset); the merge carries the children's offsets down.
// The TSL twins in `srcMathTsl.js` are these functions step for step.

export const CENTROID_NONE = 0;

/**
 * The tangent frame at a bin's area centroid `c`: `e1 = normalize(a × c)`,
 * `e2 = c × e1`, with the helper axis `a` the world axis least aligned with
 * `c` (z unless |c.z| > 0.9, then x) — the same branch in both twins.
 */
export function binFrame(cIn) {
  const cl = Math.hypot(cIn[0], cIn[1], cIn[2]) || 1;
  const c = [cIn[0] / cl, cIn[1] / cl, cIn[2] / cl];
  const useX = Math.abs(c[2]) > 0.9;
  const ax = useX ? 1 : 0;
  const az = useX ? 0 : 1;
  // e1 = a × c
  let e1x = 0 * c[2] - az * c[1];
  let e1y = az * c[0] - ax * c[2];
  let e1z = ax * c[1] - 0 * c[0];
  const l = Math.hypot(e1x, e1y, e1z) || 1;
  e1x /= l; e1y /= l; e1z /= l;
  // e2 = c × e1
  const e2x = c[1] * e1z - c[2] * e1y;
  const e2y = c[2] * e1x - c[0] * e1z;
  const e2z = c[0] * e1y - c[1] * e1x;
  return { e1: [e1x, e1y, e1z], e2: [e2x, e2y, e2z] };
}

/**
 * World offset `o` → 16-bit code in the frame of area centroid `c`: two
 * signed bytes (±127 over ±1), stored +128 so a zero offset is 0x8080 and the
 * resolve's 0 also reads as zero. The component along `c` is dropped.
 */
export function encodeCentroidOffset(o, c) {
  const { e1, e2 } = binFrame(c);
  const a = o[0] * e1[0] + o[1] * e1[1] + o[2] * e1[2];
  const b = o[0] * e2[0] + o[1] * e2[1] + o[2] * e2[2];
  const qa = Math.floor(Math.min(1, Math.max(-1, a)) * 127 + 0.5) + 128;
  const qb = Math.floor(Math.min(1, Math.max(-1, b)) * 127 + 0.5) + 128;
  return (qa | (qb << 8)) >>> 0;
}

/** 16-bit code → world offset (a zero vector for code 0 and for 0x8080). */
export function decodeCentroidOffset(code, c) {
  if (code === 0) return [0, 0, 0];
  const a = ((code & 0xff) - 128) / 127;
  const b = (((code >>> 8) & 0xff) - 128) / 127;
  const { e1, e2 } = binFrame(c);
  return [e1[0] * a + e2[0] * b, e1[1] * a + e2[1] * b, e1[2] * a + e2[2] * b];
}

/** Rec. 709 luminance of an `[r, g, b]` radiance. */
export function luminanceOf(L) {
  return 0.2126 * L[0] + 0.7152 * L[1] + 0.0722 * L[2];
}

const areaCentroidCache = new Map();

/**
 * A bin's AREA CENTROID: the normalised mean direction over the bin's solid
 * angle (8×8 sub-samples of the equal-area cell). This — not `binDir`, the
 * cell's centre — is the direction a bin with NO sub-bin information falls
 * back to, in the merge's moment and in the bake's correction alike, because
 * it is what the merge's luminance-weighted mean of four uniform children
 * converges to: with the centre as the reference, a uniform field carried a
 * spurious few-degree correction that a grazing bin (cosine mass ≪ Ω) turned
 * into a 9× texel. §11.28.
 */
export function binAreaCentroid(i, j, w) {
  const m = binAreaMean(i, j, w);
  const len = Math.hypot(m[0], m[1], m[2]) || 1;
  return [m[0] / len, m[1] / len, m[2] / len];
}

/**
 * A bin's area MEAN VECTOR — the unnormalised mean of the unit directions
 * over its solid angle (length < 1; shorter for a wider bin). This is the
 * quantity the moments are linear in: a parent's mean vector is exactly the
 * mean of its four equal-area children's, which is what makes "uniform
 * radiance → zero offset" exact at every level of the recursion.
 */
export function binAreaMean(i, j, w) {
  const key = `${w}|${i}|${j}`;
  const hit = areaCentroidCache.get(key);
  if (hit) return hit;
  const sub = 8;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let b = 0; b < sub; b++) {
    for (let a = 0; a < sub; a++) {
      const d = decodeDir((i + (a + 0.5) / sub) / (2 * w), (j + (b + 0.5) / sub) / w);
      sx += d[0];
      sy += d[1];
      sz += d[2];
    }
  }
  const inv = 1 / (sub * sub);
  const out = [sx * inv, sy * inv, sz * inv];
  areaCentroidCache.set(key, out);
  return out;
}

/**
 * `binAreaMean` for every bin of width `w`, Morton order, as a vec4 table —
 * the merge's per-child centre and the frame's axis (normalised there).
 */
export function binCentroidTable(w) {
  const nBins = 2 * w * w;
  const table = new Float32Array(nBins * 4);
  for (let m = 0; m < nBins; m++) {
    const { i, j } = binUnmorton(m);
    const d = binAreaMean(i, j, w);
    table[m * 4] = d[0];
    table[m * 4 + 1] = d[1];
    table[m * 4 + 2] = d[2];
  }
  return table;
}

/**
 * The share of the §11.28 correction a bin takes, from its MEAN clamped
 * cosine `cw` (`binCosineWeights` — 0..1, NOT a solid-angle mass): full for
 * a bin facing the texel, fading to nothing as the bin grazes the horizon
 * (`cw < 0.25`), where the linear form is no longer exact and a step of
 * quantisation would otherwise be a multiple of the bin's own weight. One
 * definition for both twins.
 */
export function centroidBlend(cw) {
  return Math.min(1, Math.max(0, cw / 0.25));
}

/**
 * The unit direction of every texel of a BORDERED octahedral tile (border
 * texels carry their wrapped interior texel's direction — the same map
 * `tileCosineWeights` reads), as a vec4 table for the bake. §11.28.
 */
export function tileDirTable(interior, border = 1) {
  const size = interior + 2 * border;
  const map = octahedralBorderMap(interior, border);
  const out = new Float32Array(size * size * 4);
  for (let t = 0; t < size * size; t++) {
    const src = map[t];
    const d = octahedralDirection(src % interior, Math.floor(src / interior), interior);
    out[t * 4] = d[0];
    out[t * 4 + 1] = d[1];
    out[t * 4 + 2] = d[2];
  }
  return out;
}

/**
 * 4→1 parent mapping: integer halving. Child (i, j) at width w belongs to
 * parent (i>>1, j>>1) at width w/2 — and because the parent grid is
 * 2(w/2)×(w/2) = w×(w/2), the halved indices land in range with no clamp.
 *
 * The four children of one parent are (2i, 2j), (2i+1, 2j), (2i, 2j+1),
 * (2i+1, 2j+1), which `binMorton` below makes CONTIGUOUS — that adjacency is
 * why the merge can fetch a parent's children as one aligned read.
 */
export function binParent(i, j) {
  return { i: i >> 1, j: j >> 1 };
}

/** The four child bins of parent (i, j). Order matches binMorton's low 2 bits. */
export function binChildren(i, j) {
  return [
    { i: i * 2, j: j * 2 },
    { i: i * 2 + 1, j: j * 2 },
    { i: i * 2, j: j * 2 + 1 },
    { i: i * 2 + 1, j: j * 2 + 1 },
  ];
}

/**
 * Morton (Z-order) index of bin (i, j) — the STORAGE order of the directional
 * payload (paper §6 merge optimization).
 *
 * The property that earns it: morton(2i+dx, 2j+dy) = 4·morton(i, j) + dx +
 * 2·dy. So a parent's four children occupy four CONSECUTIVE slots starting at
 * 4·parentMorton, and the merge's 4→1 pre-average is one contiguous fetch
 * instead of four strided ones. Holds even though the grid is 2w×w rather
 * than square — i simply carries one more bit than j, which rides along at
 * the top of the interleave.
 */
export function binMorton(i, j) {
  let m = 0;
  for (let b = 0; b < 16; b++) {
    m |= ((i >>> b) & 1) << (2 * b);
    m |= ((j >>> b) & 1) << (2 * b + 1);
  }
  return m >>> 0;
}

/** Inverse of `binMorton` — deinterleave a storage index back to (i, j). */
export function binUnmorton(m) {
  let i = 0;
  let j = 0;
  for (let b = 0; b < 16; b++) {
    i |= ((m >>> (2 * b)) & 1) << b;
    j |= ((m >>> (2 * b + 1)) & 1) << b;
  }
  return { i, j };
}

/**
 * §16 S1 — bin-centre DIRECTIONS in STORAGE (Morton) order, as one uploaded
 * table: `[m*4 .. m*4+2]` = the unit direction of bin index m on the 2w×w
 * grid, `.w` unused (vec4 stride keeps the GPU read a single element()).
 *
 * The same tileCosineWeights idea: the mapping is a pure function of `w`, so
 * it is computed ONCE here — the kernels that composite sky per direction
 * (srcMerge's top-cascade close, srcTiles' orphan term) do a table read and
 * an equirect sample, no in-kernel Morton or trig, and there is no twin to
 * drift because there is no second implementation.
 *
 * Morton over the 2w×w grid is DENSE for power-of-two w (i carries one more
 * bit than j and the interleave covers [0, 2w²) exactly), which is also why
 * it can be the payload's storage order in the first place.
 */
export function binDirTable(w) {
  const nBins = 2 * w * w;
  const table = new Float32Array(nBins * 4);
  for (let m = 0; m < nBins; m++) {
    const { i, j } = binUnmorton(m);
    const [dx, dy, dz] = binDir(i, j, w);
    table[m * 4] = dx;
    table[m * 4 + 1] = dy;
    table[m * 4 + 2] = dz;
  }
  return table;
}

/** Inverse of binMorton. */
export function mortonToBin(m) {
  let i = 0;
  let j = 0;
  for (let b = 0; b < 16; b++) {
    i |= ((m >>> (2 * b)) & 1) << b;
    j |= ((m >>> (2 * b + 1)) & 1) << b;
  }
  return { i, j };
}

/** Linear (row-major) bin index — telemetry and debug views only, never storage. */
export function binIndex(i, j, w) {
  return j * (2 * w) + i;
}

// ═════════════════════════════════════════════════════════ R2 LOW-DISCREPANCY
//
// Paper §5: ray directions come from the R2 sequence (Roberts' generalization
// of the golden ratio to 2D) mapped through the equal-area projection, then
// sign-flipped into the surface hemisphere, with a global per-frame jitter.
//
// R2 rather than a hash: consecutive segments of R2 are themselves
// well-distributed, which is exactly what Alg. 3's contiguous-segment
// assignment relies on — probes sharing a parent take adjacent slices of one
// sequence and each slice is individually near-uniform.

/** Plastic number ρ, the 2D analogue of φ. */
export const PLASTIC = 1.32471795724474602596;
export const R2_ALPHA1 = 1 / PLASTIC;
export const R2_ALPHA2 = 1 / (PLASTIC * PLASTIC);

// ══ THE RECURRENCE IS 32-BIT FIXED POINT, AND THAT IS NOT AN OPTIMIZATION ═══
//
// Written the textbook way — `fract(0.5 + α·n)` in floats — this sequence
// DISINTEGRATES on the GPU at the ray counts SRC actually runs. f32 carries 24
// mantissa bits total, so once `α·n` is large the fractional part is what gets
// truncated, and the sequence degenerates to a handful of repeating values:
//
//     n = 1,024        16384 distinct fractional values
//     n = 65,536         256
//     n = 500,000         32
//     n = 2,000,000        8      ← plan §9's ~2M rays/frame
//
// Measured, not estimated. At 2M rays the last cascade's 2048 bins would be
// fed by EIGHT azimuths; a 16×16-cell coverage histogram over that range goes
// from a uniform 13..19 occupancy to 0..66, i.e. empty cells. This is exactly
// the class of failure a CPU mirror in f64 cannot see — the mirror is fine at
// every index, the shader is not, and the symptom on screen (banded, rotating
// directional structure that gets worse the longer a frame's ray list is)
// looks like a merge bug.
//
// So the CANONICAL form is the additive recurrence in u32 fixed point:
// exact on both sides, wraps for free (WGSL u32 arithmetic is mod 2^32,
// `Math.imul` is the same multiply), period 2^32 because both multipliers are
// odd, and — measured against the f64 float form on the same coverage and
// contiguous-segment arms — identical discrepancy. The float pair below is
// DERIVED from it, so `r2Point` keeps its old meaning and every caller is
// unchanged; the fixed-point words are what the GPU twin must match BIT FOR
// BIT, which is why `r2PointFx` is exported separately and gated exactly.

/** round(2^32 / ρ) — the R2 x multiplier in u32 fixed point. */
export const R2_ALPHA1_FX = 3242174889 >>> 0;
/** round(2^32 / ρ²) — the R2 y multiplier in u32 fixed point. */
export const R2_ALPHA2_FX = 2447445414 >>> 0;
/** The sequence's 0.5 start offset, in the same fixed point. */
export const R2_HALF_FX = 0x80000000 >>> 0;
/** u32 → [0,1). Exact in f64; the GPU twin loses the low 8 bits to f32. */
export const R2_FX_TO_UNIT = 1 / 4294967296;

/**
 * The n-th R2 point as RAW u32 fixed point, offset by a per-frame jitter that
 * is itself a u32 phase (not a float — a float jitter would re-import the
 * precision problem at the one place it is cheapest to avoid).
 */
export function r2PointFx(n, jitterX = 0, jitterY = 0) {
  return {
    x: (R2_HALF_FX + Math.imul(R2_ALPHA1_FX, n) + jitterX) >>> 0,
    y: (R2_HALF_FX + Math.imul(R2_ALPHA2_FX, n) + jitterY) >>> 0,
  };
}

/** The n-th R2 point in [0,1)², offset by a per-frame u32 jitter phase. */
export function r2Point(n, jitterX = 0, jitterY = 0) {
  const fx = r2PointFx(n, jitterX, jitterY);
  return { x: fx.x * R2_FX_TO_UNIT, y: fx.y * R2_FX_TO_UNIT };
}

/**
 * Ray direction for R2 index `n` on a surface with normal `n̂`.
 *
 * `ω ← ω·sign(ω·n̂)` — the paper's hemisphere fold (§5). NOT a cosine-weighted
 * sample and not a rejection loop: every R2 point yields exactly one usable
 * direction, so the ray budget is spent, not sampled away. The cosine factor
 * enters at the irradiance bake instead.
 *
 * Rays originate at PIXELS, never at probe positions — do not "offset the
 * probe along its normal" here or anywhere. That heuristic is what produces
 * the recessed-probe self-occlusion bias class the paper's Fig. 7/8 exists to
 * show, and pixel origins remove it by construction.
 */
export function rayDirection(n, nx, ny, nz, jitterX = 0, jitterY = 0) {
  const { x, y } = r2Point(n, jitterX, jitterY);
  const d = decodeDir(x, y);
  const s = d[0] * nx + d[1] * ny + d[2] * nz;
  // Exactly-tangent directions (s === 0) would keep a zero sign and collapse
  // the direction to the origin. Push them into the hemisphere.
  const sign = s < 0 ? -1 : 1;
  return [d[0] * sign, d[1] * sign, d[2] * sign];
}

// ══════════════════════════════════════════════════════ 32-BIT PROBE KEY
//
// The paper packs 64 bits (18b/axis + 10b LOD). WGSL has NO 64-bit atomics,
// so the insert — a single atomicCompareExchangeWeak on the packed key — has
// to fit in 32. The LOD system is what makes that exact rather than lossy:
// within one LOD, spacing scales with camera distance, so the number of
// distinct cells an LOD shell can contain is bounded by a CONSTANT, not by
// world size.
//
//   [ 4b (LOD+1) | 1b secondary | 9b x | 9b y | 9b z ]
//
// LOD is stored BIASED BY ONE so that the packed word can never be zero, and
// zero is the hashmap's EMPTY sentinel. Without the bias, cell (−256,−256,
// −256) at LOD 0 in the primary cache packs to exactly 0 and is
// indistinguishable from an empty slot — a probe that silently never exists,
// at the one position most likely to be the camera's own cell. That costs one
// of 16 LOD codes; MAX_LODS is 10, so nothing is lost.

export const KEY_AXIS_BITS = 9;
export const KEY_AXIS_RANGE = 1 << KEY_AXIS_BITS; // 512
export const KEY_AXIS_OFFSET = KEY_AXIS_RANGE >> 1; // 256
export const KEY_EMPTY = 0;

// ══════════════════════ WORLD-ABSOLUTE KEYS (the toroidal window)
//
// docs/GI_SPATIAL_REBUILD_PLAN.md Part 2 S1, realized on the KEY rather than on
// the storage. Read this block before touching anything above it.
//
// ══ WHAT S1 ASKED FOR, AND WHY IT CANNOT BE THE STORAGE ════════════════════
//
// The plan proposes a fixed-footprint camera-centred RING: "probe index =
// worldCell mod ringSize", memory sized once, growth deleted as a concept. The
// properties it buys are the right ones — no insert failure, no re-anchor, no
// retirement of survivors, O(strip) on camera motion. The arithmetic of making
// STORAGE dense is what kills it:
//
//   A probe population is a 2-DIMENSIONAL MANIFOLD (visible surfaces) inside a
//   3-dimensional lattice. A dense ring pays for the third dimension and gets
//   nothing back. At s₀ = 0.35 the LOD-0 shell reaches 44.8 m, i.e. 256 cells
//   per axis: 16,777,216 slots to hold the ~16,000 probes this scene actually
//   has. **1,049x waste at cascade 0, LOD 0 alone.** Summed over the real
//   ladder (CASCADE_COUNT 4 x MAX_LODS 10, each level's own shell) it is
//   191,692,800 cells — 5.85 GB of probe records and 338 GB of direction bins.
//
// That is the SAME arithmetic that produced §12.16's finding ("0.24% of
// allocated bins were ever sampled", 604 MB against a 128 MiB binding limit)
// and made the block pool budget-sized in the first place. The plan's own
// rejected-alternatives section names the 604 MB bin wall as the reason to
// abandon growing the hash; a dense ring walks into it from the other side.
//
// ══ SO THE TORUS GOES ON THE KEY, WHERE IT IS FREE ═════════════════════════
//
// Every property S1 wants comes from probe IDENTITY being a pure function of
// the world cell. It does not require storage to be indexed that way — the hash
// can stay sparse, which is what keeps the memory honest.
//
// Today a key holds the cell RELATIVE to a camera-following anchor, biased by
// +256 into the 9-bit field. That relativity is the entire reason `srcSystem`
// re-anchors, and re-anchoring is the plan's "wholesale history loss on long
// moves": the anchor jumps, every cell coordinate changes, every key changes,
// and every probe in the scene is renumbered and retired at once.
//
// Under world-absolute keys the 9 bits hold `worldCell mod 512` — no anchor, no
// bias, no range check, no re-anchor, EVER. A probe's key is a permanent
// property of where it is in the world.
//
// ══ THE ALIAS IS UNREACHABLE BY CONSTRUCTION, AND HERE IS THE PROOF ════════
//
// Two world cells 512 apart on an axis share a key. They can never both be live:
//
//   · LOD L exists only within Chebyshev distance `lodRadius(L+1)` of the
//     camera = s₀·64·2^(L+1), so the widest live span on one axis is
//     2·s₀·64·2^(L+1) = 256·s₀·2^L world units.
//   · The alias period at cascade c, LOD L is 512 cells of size s₀·2^(c+L),
//     i.e. 512·s₀·2^(c+L) world units.
//   · period/extent = 512·2^c / 256 = **2·2^c ≥ 2**.
//
// A factor of two at the worst pair (every cascade 0 LOD), growing by 2^c for
// the coarser cascades. `run-gi-src-worldkeys-test.mjs` sweeps all 40
// (cascade, LOD) pairs and asserts it rather than trusting this comment.
//
// ══ THE ONE COST: RECONSTRUCTION NEEDS THE CAMERA ══════════════════════════
//
// `worldCell mod 512` is not invertible on its own. Recovering the world cell —
// which the cascade ladder, the merge and the gizmos all need, because a probe's
// position comes from its key and never from a stored copy — takes the unique
// representative within ±256 cells of the camera's own cell. That is
// `wrapCellNear` below, and the margin proved above is exactly what makes the
// representative unique.
//
// ⛔⛔ OPT-IN AGAIN — 2026-08-22 late evening, THE USER'S SECOND LIVE VETO.
// The default has now flipped ON twice on rig receipts and been thrown out
// twice by the user's eyes on the real Level ("it was a lot better before we
// moved to world keys. Now it is just trash"). Every rig number below REMAINS
// TRUE AT RIG SCALE — pixel parity, freezeless teleport, 0 re-anchors,
// spin-retention recovery 720→90 ms, the anchor-relative return-to-black —
// and none of it predicted the live look. DO NOT RE-FLIP ON RIG RECEIPTS A
// THIRD TIME: the re-flip precondition is a discriminating LIVE instrument on
// the user's own Level that the user has looked at and accepted, plus the
// steady-state merge-orphan question answered (30-45% mid-play orphaning had
// world-keys/retention on its §12.56 suspect list; an orphaned bin's partial
// answer is exactly a "patch updating" the user can see and no crop-mean rig
// measures).
//
// History for that future instrument:
//  · The flip gate (`test:gi-worldkeys-flip`): pixel parity within the
//    cross-boot envelope, freezeless 100 m teleport (max 17 ms), fixed store
//    over 600 m, 0 re-anchors vs shipped's 15.
//  · First revert's "heavy freezes" were the §12.56 auto-retry false-firing
//    (fixed, two-strike); the Level-scale probe then walked
//    world-keys+retention FASTEST of five arms — that exoneration justified
//    re-flip #2, and the user's eyes still said worse.
//  · Anchor-relative's own documented cost stands: walking a room and
//    returning leaves it BLACK (ceiling −100%, +3 s — §15 front 5). Both
//    defaults have a user-visible failure; the user prefers this one.
// `__giSrcWorldKeys = true` arms world keys + locality retention for A/B.

/** Is world-absolute probe keying armed? OPT-IN; `true` arms it. */
export function worldKeysEnabled() {
  return globalThis.__giSrcWorldKeys === true;
}

/**
 * §13.9 — SMOOTHED TRILINEAR WEIGHTS. Plain trilinear interpolation is only
 * C0: the gradient STEPS at every cell face, and the eye reads a gradient step
 * as a line (Mach banding). On a probe field that is exactly where a crease
 * appears — and it appears strongest where adjacent probes disagree most,
 * which with differently-coloured emitters is the hue boundary between two
 * lights. Replacing `t` with `3t²−2t³` zeroes the derivative at both ends of
 * every cell, so the interpolant is C1 across faces and the creases go.
 *
 * Read through ONE function because `srcRef.js`'s CPU mirror and the GPU
 * gather must agree, or `test:gi-src-gather` diffs a smoothed GPU against an
 * unsmoothed CPU and calls the fix a regression ([[gi-src-rebuild]] §13.7e).
 *
 * ══ §12.86 — DEFAULT-ON, AND THE USER DESCRIBED THIS FUNCTION'S DOCSTRING ══
 *
 * 2026-08-23, the user's report, unprompted and in their own words:
 *
 *   "blockiness ... mostly in darker regions, and mostly in further regions.
 *    As far as I could figure out, this happens when we transite from ONE
 *    VOXEL GRID TO ANOTHER. That must not happen, we must always see smooth
 *    lighting" — and, correcting a wrong lead: "it happens mostly when our
 *    camera moves from one room into the other, or we start looking in the
 *    opposite direction swiftly."
 *
 * "Transiting from one voxel grid to another" IS a cell-face crossing, and the
 * paragraph above says what a C0 interpolant does at one: the gradient steps,
 * and the eye reads the step as a line. Over a 3D lattice those lines close
 * into a cell-shaped grid. It checks out against every constraint they gave:
 *
 *   · SCALE — the crease period is exactly `spacing0` = 0.45 m on their Level,
 *     which is the ~90-110 px block measured in their screenshots at 3-4 m.
 *   · CAMERA-TRIGGERED — the pattern is WORLD-LOCKED, so it is invisible until
 *     you translate across it. Walking into the next room sweeps you through
 *     ~18 cell faces; a swift turn re-projects the whole grid at once. Standing
 *     still, nothing moves and nothing draws the eye to it.
 *   · PERMANENT — it is a deterministic property of the interpolant, not
 *     variance. It cannot converge away, which is why the walk probe reads
 *     `settles 0 ms` and why `checker` RISES over the measuring window instead
 *     of decaying.
 *   · DARK — Mach banding is contrast-relative, and `checker` normalises by the
 *     local mean for the same reason. This scene has `Sky Light 0`, so dark
 *     regions have no fill to swamp the step.
 *   · FAR — the same 0.45 m cell subtends ~110 px at 3.5 m and ~19 px at 20 m,
 *     so the creases pack together and read as a grid rather than as a soft
 *     gradient.
 *
 * The cost is three multiplies and a subtract per axis per corner, on weights
 * that were already being computed — no extra taps, no extra bindings, no
 * temporal state. It reshapes WEIGHTS ONLY: `cell0`, the corner keys, the hash
 * lookups, the coverage renormalisation and the energy are all untouched, and
 * the weights still sum to 1 (`3t²−2t³` maps [0,1]→[0,1] with f(0)=0, f(1)=1),
 * so it cannot move a furnace test.
 *
 * ⚠ It is NOT a variance filter. If a probe's own estimate is noisy, this makes
 * the noise smooth instead of blocky — better, but the amplitude is unchanged.
 * Judge it on creases, not on brightness.
 *
 * ══ ⛔ AND IT IS REFUTED. IT STAYS OPT-IN. (2026-08-23, same night) ═════════
 *
 * Flipped default-on on the reasoning above, then measured properly and put
 * back. `probe:gi-gather-smooth-paired` — ONE boot, ONE pose, ONE converged
 * field, the arm flipped as a live uniform so A and B differ by NOTHING except
 * the interpolant — on the user's Level at three room-threshold poses:
 *
 *   pose                       picture delta      crease p99 C1/C0
 *   west room, long axis        1.55%              1.001
 *   centre → west doorway       0.74%              1.046
 *   centre corridor             1.14%              0.995
 *
 * The dial is LIVE (it moves ~1% of the picture) and it does not reduce
 * cell-face gradient steps at all. Two of three ratios are above 1.
 *
 * ⚠ THE MEASUREMENT HAS A KNOWN WEAKNESS, RECORDED SO THE NEXT ATTEMPT DOES
 * NOT REPEAT IT: `creaseFlat` masks to LOW-first-difference pixels to exclude
 * albedo and geometry edges, and a crease is by definition a place where the
 * gradient on one side is elevated — so the mask may be excluding the very
 * pixels it is meant to score. A better instrument would mask by ALBEDO
 * (gbuffer), not by gradient. Until someone builds that, this is a refutation
 * of "C1 weights visibly help on this scene", not of the Mach-band mechanism.
 *
 * Three prior statistics failed on this same question BEFORE this one worked,
 * and all three failed silently by returning a clean null:
 *   · `checker` (probe:gi-walk) is a mean FIRST difference, and total variation
 *     across a cell is fixed by its endpoints — a linear and a smoothstep ramp
 *     from L0 to L1 have identical Σ|ΔL|. Blind by algebra.
 *   · a whole-frame SECOND difference is dominated by albedo/geometry edges.
 *   · the first paired run captured a BLACK canvas (drawImage outside the rAF
 *     callback; a WebGPU canvas invalidates on present) and reported "INERT".
 *
 * `__giGatherSmoothWeights = true` arms it; `probe:gi-walk`'s `nosmooth` arm
 * and `__giGatherSmoothLive` (the per-frame uniform) are the A/B instruments.
 */
/**
 * §12.88 — NORMAL BIAS ON THE GATHER, IN METRES. Default 0 = today's behaviour.
 *
 * The screen gather evaluates its 8-corner trilinear stencil at the RAW gbuffer
 * position (`srcScreenGather`: `const P = vec3(position)`), so the four corners
 * behind the shaded face sit up to `s0` BEHIND it. On the user's Level that is
 * 0.45 m against 0.25 m partition walls — the stencil spans 0.90 m, 3.6× the
 * wall — and those corners land in the NEXT ROOM, voting at full trilinear
 * weight. There is nothing to stop them: `gatherNormalWeightExp()` is 0 by
 * default, `gatherLosWeight()` is opt-in, `mergeLosWeight()` is opt-in. The
 * corner weight on this scene is bare, unshaped, position-only trilinear.
 *
 * Offsetting the sample point along the surface normal is the standard DDGI
 * answer and it is GEOMETRIC rather than heuristic: the far corner reaches
 * `s0 − β` past the surface, so the leak through a wall of thickness `w` is
 * exactly zero once `β > s0 − w`. At s0 = 0.45 and w = 0.25 that is β > 0.20 m;
 * 0.6·s0 = 0.27 m holds it at every lattice phase.
 *
 * ⚠ THE TRADE, and it is the user's call, not this function's: β metres of
 * contact and concave shading detail move with the sample point. Too large and
 * corners lose their darkening. That is why it ships at 0 and is swept by
 * `probe:gi-gather-smooth-paired` as a LIVE UNIFORM — one boot, one pose, both
 * arms, which is the only kind of A/B this scene supports (its boot-to-boot
 * spread is ~2×).
 *
 * ONE reader, like the two below it, because `srcRef.js`'s CPU mirror and the
 * GPU gather must agree or `test:gi-src-gather` calls an armed default a
 * regression.
 */
export function gatherNormalBias() {
  const v = Number(globalThis.__giGatherNormalBias);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function gatherSmoothWeights() {
  return globalThis.__giGatherSmoothWeights === true;
}

/**
 * §13.7d / §14 Q9 — the gather's normal-plane weight exponent; 0 = off.
 *
 * ⚠ OPT-IN AGAIN since 2026-08-20 late (`__giGatherNormalWeight`: `true` = 2,
 * a number = exponent). It shipped default-on for a few hours and produced
 * THREE artifacts in a row on the user's Level, each a lesson:
 *   1. the DDGI direction wrap → grid DOTS (modulates front probes);
 *   2. one-sided direction cosine → soft SQUARES (cos varies with lateral
 *      offset — still lattice-periodic);
 *   3. one-sided signed PLANE DISTANCE (the current, correct form —
 *      lattice-silent by construction) → BRIGHT BANDS at wall edges and
 *      corners, because suppressing the dark behind-the-wall probes and
 *      RENORMALIZING redistributes their share onto the bright front
 *      probes: corners brighten, where reality darkens them.
 * The formula stays (it is finally geometry-sound); what is missing is the
 * energy story: a suppressed probe should DARKEN like occlusion, not
 * redistribute — i.e. scale the gather by the kept-weight fraction instead
 * of renormalizing (an AO-like term needing its own pricing rig). Until that
 * ships, the thin-wall bleed lever stays a hatch.
 *
 * ONE reader for the same reason as `gatherSmoothWeights` above — the CPU
 * mirror and the GPU gather must agree or `test:gi-src-gather` calls an
 * armed default a regression.
 */
export function gatherNormalWeightExp() {
  const h = globalThis.__giGatherNormalWeight;
  if (h === false) return 0;
  if (h === true) return 2;
  if (Number.isFinite(h)) return h > 0 ? h : 0;
  // ON by default since 2026-09-03 (it shipped opt-in). Without it a pixel on
  // a facade interpolates the four trilinear corners INSIDE the building at
  // full weight; with the sky off those probes are black, and the user's
  // capture shows exactly that: soft probe-scale blobs over every facade and
  // the street. `__giGatherNormalWeight = false` restores the flat trilinear.
  return 2;
}

/**
 * §10.6 (2026-09-03) — THE BEHIND-PLANE TOLERANCE IS A DEPTH IN METRES, NOT A
 * FRACTION OF THE SPACING.
 *
 * The plane weight above fades a corner to its floor once it sits deeper than
 * `0.35 · spacing` behind the shaded surface's tangent plane. At c0 that is
 * 12 cm — a wall's thickness, the right scale. But the gather reads the
 * COARSE shells at distance, and there the same fraction is 0.5 m at c2 and
 * ~1 m at c3: deeper than any facade, so a pixel on a wall twenty metres
 * away took the probes in the ROOM behind it at nearly full weight. On the
 * exact BVH transport those probes are honestly dark (the room IS dark — no
 * sky, no sun, the wall is real), and the user's captures show the result:
 * soft blobs, 1–3 m across (the c2/c3 cell), black with the sky off and
 * blue with it on, anchored to the surfaces the camera turns onto, on every
 * facade, roof (attic probes) and the street (probes under the ground).
 * The field build never showed them because its probes behind a wall were
 * LIT — by the leak through the wall this transport closed.
 *
 * So the fade depth is `min(0.35 · spacing, this)`: unchanged at c0, a wall's
 * thickness at every shell above it. Still a function of the signed plane
 * distance alone, so a flat wall's corner weights stay constants (Q9c's
 * lattice-silence argument is untouched). `__giGatherPlaneDepth` = metres;
 * `false` = no cap (the 2026-09-02 behaviour). ONE reader, the CPU mirror
 * reads it too.
 */
export function gatherPlaneDepth() {
  const h = globalThis.__giGatherPlaneDepth;
  if (h === false) return 1e6;
  const v = Number(h);
  return Number.isFinite(v) && v > 0 ? v : 0.15;
}

/**
 * §11.51 (2026-09-05) — THE PLANE WEIGHT'S FLOOR, i.e. what a corner BEHIND
 * the shaded surface still gets to say. Default 0.2; 0 is the pre-§11.51
 * deletion (1e-3), which is what the user's "dark bands on the walls" was.
 *
 * ⚠ THE DEPTH DIAL CANNOT REACH THIS. `gatherPlaneDepth` enters as
 * `min(0.35·s, depth)` — at c0 that is 12 cm no matter how large the dial is
 * — while a cube corner sits up to `s·√3` = 61 cm behind the plane. So every
 * behind-plane corner lands ON the floor, and the floor alone decides whether
 * the weight is a preference or a deletion. Sweeping the depth measured
 * nothing (0.15 / 1e6 / 0.03 / 0.15, live, no rebuild: top-strip ratio
 * .649 → .661, a convergence drift) which is exactly what that algebra
 * predicts; sweeping the FLOOR is the experiment that moves.
 *
 * ONE reader for both twins — `srcRef.js`'s CPU mirror and the GPU gather must
 * agree or `test:gi-src-gather` calls an armed default a regression.
 */
export function gatherPlaneFloor() {
  const v = Number(globalThis.__giGatherPlaneFloor);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.2;
}

/**
 * THE OCCUPANCY SHOULDER both LOS marches read through (2026-08-23).
 *
 * `occupancyAtWorld` returns TRILINEARLY FILTERED coverage, which is what
 * makes the suppression continuous and therefore shippable — the binary read
 * drew stair-stepped light boundaries at voxel granularity and cost U3 its
 * default. But a filtered field is non-zero for a whole voxel AROUND geometry,
 * so feeding it in raw makes "near a wall" mean "partially blocked": measured
 * on the leak rig, legitimate in-room light fell to 0.624 of the unsuppressed
 * arm, against the one-bit arm's 0.89–0.92.
 *
 * So the march thresholds it with a SOFT SHOULDER instead of using it raw. A
 * sample must be substantially INSIDE geometry to occlude (a planar wall reads
 * ~0.5 exactly at its surface, 1.0 a voxel in, 0.0 a voxel out), while the
 * ramp between the two bounds keeps the position-continuity the whole change
 * exists for. Free space stays free; the staircase stays gone.
 *
 * One definition, both call sites (screen gather + cascade merge) — they must
 * agree or the field's own tiles and the screen's read of them disagree about
 * which side of a wall a probe is on.
 */
// ⚠ LO IS 0.5 FOR A GEOMETRIC REASON, NOT A TUNED ONE. Trilinear filtering of
// a binary field puts the value 0.5 exactly ON the surface, above it INSIDE
// the solid and below it in the one-voxel skirt OUTSIDE. A lower bound below
// 0.5 therefore makes the skirt occlude, i.e. makes "near a wall" mean
// "partially blocked" — measured on the leak rig at LO 0.35, that cost ~28%
// of LEGITIMATE in-room light on top of the leak it removed (control ratio
// 0.647 where the leak alone accounts for ~0.90). At 0.5 the skirt is free by
// construction and only the ramp from surface to solid interior is soft.
export const LOS_OCC_LO = 0.5;
export const LOS_OCC_HI = 0.85;

/**
 * How much of the marched path has to be inside geometry before the corner is
 * called blocked — the second half of the same argument.
 *
 * A PRODUCT over per-sample occlusion convicts a path on ONE sample, which is
 * right for a wall and wrong for a graze: indoors, most legitimate probe→point
 * paths run close to a floor or a wall, and a single sample dipping into that
 * surface was enough to suppress the corner. Measured, that cost ~35% of the
 * in-room light the leak fix was not supposed to touch, and moving the
 * per-sample shoulder did not shift it (0.647 → 0.616 → 0.616).
 *
 * A WALL is a RUN of blocked samples; a graze is one. So the march averages
 * the per-sample shoulder and ramps on that mean: at four samples one blocked
 * sample reads 0.25 and barely dims, two read 0.5 and fully block. Same
 * continuity, same leak, far less collateral.
 */
export const LOS_PATH_LO = 0.18;
export const LOS_PATH_HI = 0.5;

/**
 * §15 U3 — LOS GATHER VALIDITY. `__giGatherLosWeight = true` arms a short
 * probe→pixel visibility march through the occupancy field inside the screen
 * gather's corner weights: a probe the point cannot SEE (the next room's, a
 * thin wall's far side) is suppressed by measured occupancy instead of by the
 * §13.7d tangent-plane heuristic it supersedes. This is the honest density
 * multiplier — behind-wall probes stop diluting gathers — and the §14 4b
 * through-wall-bounce killer on the gather side.
 *
 * ⛔ REVERTED TO OPT-IN 2026-08-22 (later that night) after the user's live
 * look: the BINARY one-bit suppression paints stair-stepped light boundaries
 * on walls at occupancy-voxel granularity (the Q9c lattice-artifact family,
 * live screenshots), and the hit-shade gather goes BLACK in mirrors where
 * every corner is floored (starved wsum). The rig's gate measured crops, not
 * boundaries — a mean over a crop cannot see a stair-step. Before any
 * re-flip: (a) SMOOTH suppression (fractional occupancy or a 2-tap filtered
 * read — the hard 0/1 per corner is the artifact), (b) the all-suppressed →
 * starved-black interaction must clamp to the blocked mean, (c) a gate that
 * asserts BOUNDARY smoothness, not crop means. `test:gi-gather-los` receipts
 * (complete leak removal pre-heal, U3b ladder finding) remain valid.
 * ⚠ The CPU mirror (`srcRef.js`) has no occupancy field — mirror-diff pages
 * are safe by CONSTRUCTION: an instance built without the `losOccupied`
 * closure cannot arm and keeps the pre-U3 graph.
 */
export function gatherLosWeight() {
  return globalThis.__giGatherLosWeight === true;
}

/**
 * §15 U3b — LADDER CROSS-WALL VALIDITY. The through-wall leak's endgame on a
 * HEALTHY field: c1/c2 parent cells (0.7–1.4 m) span interior walls, so the
 * cascade merge mixes the far room's radiance into parents the near room's c0
 * bins inherit — the leak sits in the probes' OWN TILES, where no gather-side
 * weight (U3's march included) can reach it. Proven by the los-gate's
 * bimodality: pre-heal (broken ladder) the gather march removed 100% of the
 * leak; post-heal it removed ~nothing (§15 U3 block, ⭐⭐ entry).
 *
 * The fix rides the MERGE's corner weights ([G.1] in srcMerge.js): the same
 * one-bit occupancy march U3 built, child probe → parent corner, at MERGE
 * rate — thousands of probes, not megapixels, so the ×18 pricing cliff the
 * gather's first march hit cannot recur. Suppression is RELATIVE (floor,
 * never zero): with any same-room corner alive it dominates 1000:1; with all
 * corners blocked the renormalization returns the blocked mean — the pre-U3b
 * answer, never a dark vote (R1) and never a new orphan cliff. Because the
 * weight lives at PROBE granularity and reaches the screen only through the
 * merge average + the gather's own trilinear smoothing, the per-pixel
 * stair-step family that reverted U3's screen march does not apply here.
 *
 * ⚠ The CPU mirror (`srcRef.js` mergeCascades) has no occupancy field —
 * merge-diff pages are safe by CONSTRUCTION: an instance built without the
 * `losOccupied` closure cannot arm and keeps the pre-U3b graph.
 */
export function mergeLosWeight() {
  // ⛔ OPT-IN since the 2026-08-22 full-revert: part of the arc the user's
  // "undo all the GI work" covered. The build and its gates stand; it
  // returns only with the user's explicit go-ahead, alone.
  return globalThis.__giMergeLosWeight === true;
}

/**
 * The unique integer congruent to `packed` mod 512 that lies within ±256 of
 * `ref` — the inverse of `worldCell & 511`.
 *
 * `ref` is the camera's own cell on the same lattice. Correct for every live
 * probe because the live span is at most half the period (see the proof above),
 * so exactly one representative falls in the window.
 */
export function wrapCellNear(packed, ref) {
  const d = (packed - ref + KEY_AXIS_OFFSET) & (KEY_AXIS_RANGE - 1);
  return ref + d - KEY_AXIS_OFFSET;
}

/**
 * Pack a probe key. `cx/cy/cz` are cell coords RELATIVE to the LOD's
 * camera-anchored origin (so they straddle zero); the +256 bias maps them into
 * [0,512). Returns 0 — never a valid key — when anything is out of range, so a
 * caller that forgets to check writes EMPTY rather than a wrong probe.
 */
export function packProbeKey(lod, secondary, cx, cy, cz) {
  if (!(lod >= 0) || lod >= KEY_MAX_LODS) return KEY_EMPTY;
  if (worldKeysEnabled()) {
    // WORLD-ABSOLUTE: `cx/cy/cz` are WORLD cells, wrapped into the 9-bit field.
    // No bias and NO RANGE CHECK — the window is toroidal now, so there is no
    // such thing as an unrepresentable cell and therefore no silent absence.
    // (The LOD test above stays: `lod` really can be out of range, and the +1
    // bias on it is what keeps a packed word from colliding with KEY_EMPTY.)
    return (
      (((lod + 1) & 0xf) << 28) |
      ((secondary ? 1 : 0) << 27) |
      ((cx & (KEY_AXIS_RANGE - 1)) << 18) |
      ((cy & (KEY_AXIS_RANGE - 1)) << 9) |
      (cz & (KEY_AXIS_RANGE - 1))
    ) >>> 0;
  }
  const x = cx + KEY_AXIS_OFFSET;
  const y = cy + KEY_AXIS_OFFSET;
  const z = cz + KEY_AXIS_OFFSET;
  if (x < 0 || y < 0 || z < 0) return KEY_EMPTY;
  if (x >= KEY_AXIS_RANGE || y >= KEY_AXIS_RANGE || z >= KEY_AXIS_RANGE) return KEY_EMPTY;
  return (
    (((lod + 1) & 0xf) << 28) |
    ((secondary ? 1 : 0) << 27) |
    (x << 18) |
    (y << 9) |
    z
  ) >>> 0;
}

/**
 * Unpack a probe key, or null for EMPTY.
 *
 * Under world-absolute keying the cell fields are RAW `[0,512)` residues, not
 * signed offsets — recovering the world cell needs a reference, so it is
 * `keyWorldCell` below and never this. Returning the un-biased signed value
 * here would hand every existing caller a plausible cell that is wrong by a
 * multiple of 512, which is the failure mode this whole block exists to make
 * impossible; so it returns the residue and says so in the field names.
 */
export function unpackProbeKey(key) {
  const k = key >>> 0;
  if (k === KEY_EMPTY) return null;
  const lodBiased = (k >>> 28) & 0xf;
  if (lodBiased === 0) return null;
  const bias = worldKeysEnabled() ? 0 : KEY_AXIS_OFFSET;
  return {
    lod: lodBiased - 1,
    secondary: ((k >>> 27) & 1) === 1,
    cx: ((k >>> 18) & (KEY_AXIS_RANGE - 1)) - bias,
    cy: ((k >>> 9) & (KEY_AXIS_RANGE - 1)) - bias,
    cz: (k & (KEY_AXIS_RANGE - 1)) - bias,
    /** True when cx/cy/cz are residues awaiting `keyWorldCell`. */
    residue: bias === 0,
  };
}

/**
 * The WORLD cell a key names, given the camera's own cell on the same lattice.
 *
 * The one inverse under world-absolute keying, and the reason every consumer
 * derives a probe's position from its key plus the camera rather than from a
 * stored position: a stored position is a second source of truth, and the
 * §12.70 W5a gate already caught what happens when two sources disagree.
 */
export function keyWorldCell(key, refCx, refCy, refCz) {
  const u = unpackProbeKey(key);
  if (!u) return null;
  if (!u.residue) return { lod: u.lod, secondary: u.secondary, cx: u.cx, cy: u.cy, cz: u.cz };
  return {
    lod: u.lod,
    secondary: u.secondary,
    cx: wrapCellNear(u.cx, refCx),
    cy: wrapCellNear(u.cy, refCy),
    cz: wrapCellNear(u.cz, refCz),
  };
}

/**
 * True when a cell is representable at all. LOD selection clamps such that
 * out-of-window cells cannot occur, and the Phase-0 property test proves that
 * claim rather than trusting it — an unrepresentable cell is a probe that
 * silently does not exist, which reads as a dark patch that moves with the
 * camera.
 */
export function probeKeyInWindow(cx, cy, cz) {
  // Under world-absolute keying EVERY cell is representable — the window wrapped
  // instead of clipping — so this is vacuously true. Kept as a call rather than
  // deleted at the call sites: the checks it guards are the ones that would have
  // to come BACK if the keying were ever reverted, and a `true` here keeps that
  // reversion a one-line change instead of a re-derivation.
  if (worldKeysEnabled()) return true;
  return (
    cx + KEY_AXIS_OFFSET >= 0 &&
    cy + KEY_AXIS_OFFSET >= 0 &&
    cz + KEY_AXIS_OFFSET >= 0 &&
    cx + KEY_AXIS_OFFSET < KEY_AXIS_RANGE &&
    cy + KEY_AXIS_OFFSET < KEY_AXIS_RANGE &&
    cz + KEY_AXIS_OFFSET < KEY_AXIS_RANGE
  );
}

/**
 * PCG-family finalizer, used as the hashmap slot function. Avalanches well
 * enough that the LOW bits of adjacent probe keys — which differ by 1 in z and
 * are therefore maximally correlated — land in unrelated slots. A weaker mix
 * (or a modulo of the raw key) clusters every probe row into one cache line
 * and turns lockless linear probing into a linear scan.
 */
export function hashKey(key) {
  let x = (key >>> 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
  return (x ^ (x >>> 15)) >>> 0;
}

// ═══════════════════════════════════════════════════════ SPLIT ASSIGNMENT
//
// Paper §5. A ray from pixel P hitting at distance d with r_{k−1} < d ≤ r_k
// deposits:
//    cascade k       ← (radiance = L_hit, T = 0)
//    cascades j < k  ← (0, T = 1)
//    cascades > k    ← NOTHING
//
// The last line is the one the companion guide gets WRONG. "Extend the ray and
// deposit occlusion upward" was tested by the authors and REJECTED for bias:
// a cascade above k has not traced that far, and telling it the ray was
// blocked at d asserts occlusion over an interval the ray never sampled.

/**
 * The cascade owning hit distance `d`, or `cascadeCount` for an escape (which
 * means every cascade takes (0, T=1) and the sky composites at the top).
 * `bounds` is `intervalBoundaries(lod, spacing0)`.
 */
export function splitCascade(d, bounds) {
  for (let k = 0; k < bounds.length; k++) {
    if (d <= bounds[k]) return k;
  }
  return bounds.length;
}

/**
 * The full deposit list for one ray — the CPU mirror of the GPU's atomic
 * scatter. Returns `[{ cascade, radiance:[r,g,b], transmittance }]`, always
 * with `count` implicitly 1 per entry.
 *
 * `d < 0` (or ≥ reach) is a miss: transparent everywhere, no radiance. The sky
 * is NOT deposited here — it composites once at the top of the merge, because
 * depositing it per-cascade would multiply it by the cascade count.
 */
export function splitDeposits(d, radiance, bounds) {
  const k = d >= 0 ? splitCascade(d, bounds) : bounds.length;
  const out = [];
  for (let j = 0; j < Math.min(k, bounds.length); j++) {
    out.push({ cascade: j, radiance: [0, 0, 0], transmittance: 1 });
  }
  if (k < bounds.length) {
    out.push({ cascade: k, radiance: [radiance[0], radiance[1], radiance[2]], transmittance: 0 });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════ MERGE
//
// Paper Eq. 6/7, cascade N−1 → 0. A bin's merged value takes its own interval
// first and lets whatever it did not block through from the parent:
//
//     L_merged = L_self + T_self · L_parent
//     T_merged = T_self · T_parent
//
// `L_parent` is the sparse-trilinear, 4→1 pre-averaged parent value.

/** One bin's merge step. Radiance arrays are [r,g,b]; returns a new pair. */
export function mergeBin(selfL, selfT, parentL, parentT) {
  return {
    radiance: [
      selfL[0] + selfT * parentL[0],
      selfL[1] + selfT * parentL[1],
      selfL[2] + selfT * parentL[2],
    ],
    transmittance: selfT * parentT,
  };
}

/**
 * One frame of temporal decay on one fixed-point accumulator word.
 *
 * The whole of the temporal blend is this line, applied to every word of every
 * bin before the frame's deposits land on top. Radiance, transmittance and
 * count all decay by the same factor, so `ΣL/Σcount` comes out an
 * exponentially-weighted mean over RAYS — every ray carrying the weight of the
 * frame it was cast in. `srcDeposit.js`'s decay pass is the TSL twin.
 *
 * ══ IT ROUNDS, AND THE FIRST VERSION TRUNCATED — WHICH ATE DIM LIGHT ════════
 *
 * A decaying integer accumulator does not settle on a point but inside an
 * INTERVAL: `x = decay(x) + r` holds for a range of `x`, and which value a bin
 * lands on depends on its own history. The intervals are what separate the two
 * operators, in width and in placement:
 *
 *     truncation   x ∈ ( r/α − 1/α ,  r/α ]          entirely BELOW the truth
 *     rounding     x ∈ [ r/α − 0.5/α, r/α + 0.5/α )  half as wide, STRADDLING it
 *
 * Either way the error is a fixed number of QUANTA, which makes it a RELATIVE
 * error inversely proportional to the signal. But a gather averages many bins,
 * so a two-sided error cancels there and a one-sided one accumulates into a
 * systematic darkening of the whole image. `test:gi-src-temporal` measures both
 * — converging from zero, as a fresh bin does, lands at the bottom of each
 * interval, and the shape is the point:
 *
 *      influx r/frame     6      65     650    6500   65536
 *      truncated     -15.0%   -1.39%  -0.14%  -0.014%  -0.001%
 *      rounded        -6.7%   -0.62%  -0.06%  -0.006%  -0.001%
 *
 * `r` is `(L/Lmax)·2^F` per deposit, so truncation is a systematic DARKENING
 * that grows as the light gets dimmer — the worst possible direction for a
 * global illumination term, where dim and indirect is the whole subject.
 * Rounding halves the magnitude and, more usefully, makes what is left cancel. The rest of the lever is `Lmax`: it is the exposure the
 * fixed point is measured against, and §12.13.4 left clamp-versus-auto-exposure
 * open pending a measurement. This is a second reason to close it, and it does
 * not bind yet — hit shading is Phase 5, so every radiance word is currently
 * zero and only `T` and `count` accumulate, both at full scale and both under
 * 0.002%.
 *
 * ══ ROUNDING HAS A FIXED POINT, AND `MIN_WEIGHT` ALREADY COVERS IT ══════════
 *
 * `round(x·keep) = x` for every `x ≤ 0.5/(1−keep)` — five, at keep = 0.9 — so a
 * rounded accumulator decays into single digits and STOPS. Truncation has no
 * such fixed point, and that was the whole argument for it. It stops mattering
 * once the resolve tests a WEIGHT FLOOR rather than zero, which `srcDeposit.js`
 * needs for an unrelated reason (its resolve header: the radiance word retires
 * before the count does, so an unfloored tail votes black). `MIN_WEIGHT` is 1024
 * against a residue of 5 — a 200× margin, asserted rather than assumed.
 *
 * ══ f32, EXPLICITLY, BECAUSE THE GPU'S `keep` IS AN f32 UNIFORM ═════════════
 *
 * `Math.fround` at every step, so the mirror computes what the kernel computes
 * rather than what the same expression means in f64. It happens to be
 * unnecessary at keep = 0.9 — the f32 product's half-ulp is wider than the gap
 * between the two constants, so both land on the same integer — but that is a
 * property of one α, and a twin that agrees for a reason nobody wrote down is a
 * twin that stops agreeing when somebody changes the number.
 */
export function decayFixed(x, keep) {
  const p = Math.fround(Math.fround(x) * Math.fround(keep));
  return Math.floor(Math.fround(p + 0.5));
}

/**
 * The per-block α compensation's `keep′` (§12.40.4) — mirror of the branch in
 * `srcDeposit.js`'s decay pass, `Math.fround` at every step that rounds on the
 * GPU. `influxWord` is the fixed-point capped/natural ratio the transport
 * published for the block (`INFLUX_ONE` = uncapped); `lift` suspends the
 * compensation (1 = fully — the exact pre-compensation `keep`, bit for bit,
 * because the kernel SKIPS the branch rather than computing through it).
 *
 * `keep′ = 1 − (1−keep)·(ratio·(1−lift) + lift)`: the effective sample count
 * `influx/(1−keep′)` is held at its uncapped value at lift 0, and interpolates
 * back to the plain decay as the motion lift rises.
 */
export function keepCompensated(keep, influxWord, lift, surpriseWord = 0, surpriseF = 1) {
  const l = Math.fround(lift);
  const compensated = influxWord < INFLUX_ONE && l < 1;
  // The ratio the compensation branch multiplied by — 1 when the branch is
  // skipped, which is what the kernel's `lifted` var holds there. The surprise
  // mix interpolates FROM this, so the two mechanisms compose instead of the
  // later one discarding the earlier one's answer.
  let lifted = 1;
  let k = keep;
  if (compensated) {
    const ratio = Math.fround(influxWord / INFLUX_ONE);
    lifted = Math.fround(Math.fround(ratio * Math.fround(1 - l)) + l);
    k = Math.fround(1 - Math.fround(Math.fround(1 - Math.fround(keep)) * lifted));
  }
  // `u == 0` returns the compensated keep UNTOUCHED rather than computing
  // `mix(lifted, F, 0)`: the kernel skips the branch, so this is the same
  // skip and not an arithmetic identity that happens to agree.
  if (!(surpriseWord > 0)) return k;
  const t = Math.fround(surpriseWord / SURPRISE_ONE);
  // WGSL's `mix(a, b, t)` is `a·(1−t) + b·t`. Written out rather than as
  // `a + (b−a)·t`, which is a different rounding and would drift from the
  // kernel by an ulp at exactly the values a gate would call equal.
  const f = Math.fround(
    Math.fround(lifted * Math.fround(1 - t)) + Math.fround(Math.fround(surpriseF) * t),
  );
  return Math.fround(1 - Math.fround(Math.fround(1 - Math.fround(keep)) * f));
}

/**
 * One block's surprise state advance — the mirror of the [D1''] publish's
 * per-block leg (`srcRays.js`), `Math.fround` at every step the GPU rounds at.
 *
 * ══ WHAT IS BEING MEASURED, AND WHY IT IS A DRIFT AND NOT A DIFFERENCE ══════
 *
 * `I` is THIS frame's mean luma per unit weight; `M` is the accumulator's mean
 * BEFORE this frame lands. Their difference is one noisy sample of "the block's
 * truth moved", and comparing it against a threshold directly would fire on
 * shot noise every time a sparse block happened to draw a bright ray. So the
 * difference feeds a SIGNED EMA (`drift`): noise cancels across frames because
 * its sign is symmetric, while a real change is one-signed and accumulates.
 * That is the entire reason surprise is not `|I − M| > k·σ`.
 *
 * `noise` is the shot-noise scale of `M` at `n` deposits, floored so a block
 * whose mean is zero does not have zero σ. `u` is where `|drift|/noise` sits on
 * the T0→T1 σ ramp, zeroed while the block has too little evidence to have a
 * mean at all, and finally scaled by the governor's gain — ONCE, here, because
 * both consumers read the word this writes (srcConfig's one-switch rule).
 *
 * @param {{accL: number, accW: number, drift: number}} state  the block's f32 words
 * @param {{sumL: number, sumW: number}} sums  LAST frame's [E] deposits, in
 *   `SUM_SCALE` fixed point
 * @param {number} keepPrev  the block's own `keepCompensated` from the influx
 *   word it published LAST frame — the accumulators decayed at that rate, so
 *   this must too, or the mean drifts against its own history
 * @param {object} [opts]
 * @param {number} [opts.gain]  the governor's `surpriseGain`
 * @param {number} [opts.age]  frames since the block was claimed
 * @param {number} [opts.rayWeight]  what one deposit adds to `sumW`
 *   (`DEPOSIT_SCALE / SUM_SCALE`) — passed in rather than imported, because
 *   `DEPOSIT_SCALE` lives in a module that imports `three` and this one may not
 * @param {boolean} [opts.reclaimed]  the block was claimed THIS frame, so the
 *   state belongs to a DEAD probe and is discarded rather than decayed
 */
export function blockSurpriseUpdate(state, sums, keepPrev, opts = {}) {
  const { gain = 1, age = Infinity, rayWeight = 64, reclaimed = false } = opts;
  const k = Math.fround(keepPrev);
  const sL = Math.fround(sums?.sumL ?? 0);
  const sW = Math.fround(sums?.sumW ?? 0);
  let accL = reclaimed ? 0 : Math.fround(state?.accL ?? 0);
  let accW = reclaimed ? 0 : Math.fround(state?.accW ?? 0);
  let drift = reclaimed ? 0 : Math.fround(state?.drift ?? 0);
  // PRE-update mean. Taken before the new sums land, because the question is
  // whether THIS frame surprised the history — folding it in first would make
  // every frame partly its own baseline and mute exactly the step being
  // looked for.
  const M = accW > 0 ? Math.fround(accL / accW) : 0;
  accL = Math.fround(Math.fround(accL * k) + Math.fround(sL / SUM_SCALE));
  accW = Math.fround(Math.fround(accW * k) + Math.fround(sW / SUM_SCALE));
  const n = Math.fround(sW / rayWeight);
  const I = sW > 0 ? Math.fround(sL / sW) : M;
  drift = Math.fround(drift + Math.fround(SURPRISE_RATE * Math.fround(Math.fround(I - M) - drift)));
  const noise = Math.fround(
    Math.fround(M * Math.fround(Math.sqrt(Math.fround(SURPRISE_SHOT_K / Math.max(n, 1)))))
    + SURPRISE_FLOOR,
  );
  const z = Math.fround(Math.abs(drift) / noise);
  let u = Math.fround(Math.fround(z - SURPRISE_T0) / (SURPRISE_T1 - SURPRISE_T0));
  u = Math.min(1, Math.max(0, u));
  if (accW < SURPRISE_MIN_EVIDENCE || !(n > 0) || age < COLD_FILL_FRAMES) u = 0;
  u = Math.fround(u * Math.fround(gain));
  return { accL, accW, drift, u, word: Math.floor(Math.fround(u * SURPRISE_ONE + 0.5)) };
}

/**
 * The transport's influx word for one probe (`srcRays.js` [D1'']):
 * `floor(fl32(capped/natural)·65536 + 0.5)`, `INFLUX_ONE` when nothing was
 * demanded. The `·65536 + 0.5` is exact in f64 given an f32 quotient, which is
 * why only the divide is frounded.
 */
export function influxWordFor(capped, natural) {
  if (!(natural > 0)) return INFLUX_ONE;
  return Math.floor(Math.fround(capped / natural) * INFLUX_ONE + 0.5);
}

/**
 * Resolve a fixed-point deposit accumulator into a filterable value.
 *
 * ZERO-COUNT BINS ARE NOT ZERO — they are UNKNOWN, and the difference is the
 * whole of R1. A bin no ray happened to land in must be excluded from the
 * merge's weighting, not fed in as black; feeding it in as black is a hard
 * cliff at the edge of every sparsely-sampled region. Returns null for
 * unknown so callers cannot accidentally treat it as data.
 */
/**
 * The confidence of a bin fed `n` rays of (decayed) evidence — ONE definition
 * for both twins (srcDeposit's resolve is this, step for step, in f32):
 * `c = N/(N+K)` (§11.25), its prior share collapsing as `e^{−N/F}` (§11.29).
 */
export function confidenceOf(n) {
  const K = confidencePriorRays();
  const F = confidenceFullRays();
  const base = n / (n + K);
  return F > 0 ? 1 - (1 - base) * Math.exp(-n / F) : base;
}

export function resolveBin(sumR, sumG, sumB, sumT, count) {
  if (!(count > 0)) return null;
  const inv = 1 / count;
  // §11.25 — CONFIDENCE, the CPU twin of srcDeposit's resolve: `count` here
  // is in RAYS (one per deposit), the GPU's is `rays × DEPOSIT_SCALE`; both
  // give `confidenceOf(N)`. `__giSrcConfidence = false` pins 1 — the old estimator.
  const confidence = confidenceArmed() ? confidenceOf(count) : 1;
  return { radiance: [sumR * inv, sumG * inv, sumB * inv], transmittance: sumT * inv, confidence };
}

/**
 * Pre-average four child bins into the value their parent level will consume
 * (paper §6). Storing the ALREADY-AVERAGED cone rather than raw per-bin cones
 * is what lets the next level up read one value instead of four.
 *
 * Unknown children are SKIPPED and the average renormalizes over what was
 * found — the same "rejection weights are epsilons, never zeros" rule the
 * sparse-trilinear gather runs under. All four unknown → unknown.
 */
/**
 * §11.27 — the CPU twin of srcMerge's inpaint pass, on one probe's merged bin
 * array (`values[m]` = `{ radiance, transmittance, confidence }` or null, in
 * Morton order at grid width `w`). Returns a NEW array; sources are read from
 * the input only, exactly as the GPU reads only bins no thread writes.
 */
export function inpaintBins(values, w, low = INPAINT_LOW, discount = INPAINT_DISCOUNT) {
  const n = values.length;
  const out = values.slice();
  const confOf = (v) => (v ? (v.confidence ?? 1) : 0);
  for (let m = 0; m < n; m++) {
    const own = values[m];
    const c = confOf(own);
    if (c >= low) continue;
    const { i, j } = binUnmorton(m);
    let r = 0, g = 0, b = 0, t = 0, cs = 0, ws = 0;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= w) continue;
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ii = (i + di + 2 * w) % (2 * w);
        const nb = values[binMorton(ii, jj)];
        const cn = confOf(nb);
        if (!nb || cn < low) continue;
        const wt = cn * (di !== 0 && dj !== 0 ? 0.5 : 1);
        r += nb.radiance[0] * wt; g += nb.radiance[1] * wt; b += nb.radiance[2] * wt;
        t += nb.transmittance * wt; cs += cn * wt; ws += wt;
      }
    }
    if (!(ws > 0)) continue;
    const nr = r / ws, ng = g / ws, nbv = b / ws, nt = t / ws, nc = cs / ws;
    const k = own ? c / low : 0;
    out[m] = {
      radiance: own ? [own.radiance[0] * k + nr * (1 - k), own.radiance[1] * k + ng * (1 - k), own.radiance[2] * k + nbv * (1 - k)] : [nr, ng, nbv],
      transmittance: own ? own.transmittance * k + nt * (1 - k) : nt,
      confidence: Math.max(c, nc * discount),
      offset: own?.offset,
    };
  }
  return out;
}

export function preAverage(children, centres = null) {
  let n = 0;
  let wsum = 0;
  let csum = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  let t = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  let rx = 0;
  let ry = 0;
  let rz = 0;
  let lumSum = 0;
  // §11.25: children vote by CONFIDENCE (a fixture without one votes at 1).
  // Mirrors srcMerge's 4→1 exactly: weight `max(c, 1e-4)`, corner confidence
  // = mean `c` over the children that exist.
  const armed = confidenceArmed();
  for (let k = 0; k < children.length; k++) {
    const c = children[k];
    if (!c) continue;
    const cj = armed ? Math.max(c.confidence ?? 1, 1e-4) : 1;
    r += c.radiance[0] * cj;
    g += c.radiance[1] * cj;
    b += c.radiance[2] * cj;
    t += c.transmittance * cj;
    wsum += cj;
    csum += armed ? (c.confidence ?? 1) : 1;
    n++;
    // §11.28: the two moments srcMerge's corner loop keeps — `pO`, the
    // luminance-and-vote-weighted sum of each child's centre-plus-offset
    // (where the radiance sits), and `pR`, the vote-weighted sum of the
    // centres alone (where a uniform radiance would sit). `centres` are the
    // children's area MEAN vectors (unnormalised — linear in area).
    if (centres) {
      const o = c.offset ?? [0, 0, 0];
      const lum = Math.max(0, luminanceOf(c.radiance));
      const lw = lum * cj;
      lumSum += lw;
      mx += (centres[k][0] + o[0]) * lw;
      my += (centres[k][1] + o[1]) * lw;
      mz += (centres[k][2] + o[2]) * lw;
      rx += centres[k][0] * cj;
      ry += centres[k][1] * cj;
      rz += centres[k][2] * cj;
    }
  }
  if (n === 0) return null;
  const inv = 1 / wsum;
  const out = { radiance: [r * inv, g * inv, b * inv], transmittance: t * inv, confidence: csum / n };
  // The corner's luminance-weighted OFFSET: `pO·inv − lum·(pR·inv)`, i.e.
  // where the radiance sits minus where a uniform radiance of the same
  // (confidence-averaged) luminance would sit — exactly zero for a uniform
  // field under any weights, which the furnace gate enforces.
  if (centres) {
    const lumMean = lumSum * inv;
    out.o = [mx * inv - lumMean * rx * inv, my * inv - lumMean * ry * inv, mz * inv - lumMean * rz * inv];
  }
  return out;
}

// ══════════════════════════════════════════════════ SPARSE TRILINEAR GATHER
//
// Paper §4. Probes are inserted for the NEAREST cell only — deliberately NOT
// the 8 trilinear corners, which the authors measured as 2× the probes for
// little quality gain. So an interpolation's corners are frequently MISSING,
// and the rule is: sum the probes that exist times their weights, then
// renormalize by the total weight FOUND.
//
// Renormalizing (rather than treating a missing corner as black) is the same
// earned rule as the octahedral gather's: a missing sample is an absence of
// information, and absence must not be spent as a dark vote.

/** The 8 corner cells and trilinear weights for `p` on a lattice of `spacing`. */
export function trilinearCorners(px, py, pz, originX, originY, originZ, spacing, smooth = false) {
  const fx = (px - originX) / spacing;
  const fy = (py - originY) / spacing;
  const fz = (pz - originZ) / spacing;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  const fade = smooth ? (t) => t * t * (3 - 2 * t) : (t) => t;
  const tx = fade(fx - x0);
  const ty = fade(fy - y0);
  const tz = fade(fz - z0);
  const out = [];
  for (let dz = 0; dz < 2; dz++) {
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const w =
          (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
        out.push({ cx: x0 + dx, cy: y0 + dy, cz: z0 + dz, weight: w });
      }
    }
  }
  return out;
}

/** The nearest lattice cell to `p` — the ONE cell a pixel inserts. */
export function nearestCell(px, py, pz, originX, originY, originZ, spacing) {
  return {
    cx: Math.round((px - originX) / spacing),
    cy: Math.round((py - originY) / spacing),
    cz: Math.round((pz - originZ) / spacing),
  };
}

/**
 * The lattice origin for a spacing — the anchor snapped onto that lattice.
 *
 * Lives here rather than in `srcRef.js` (which wrapped it as `latticeOrigin(cfg,
 * cascade, lod)`) so that the reference, the GPU twin and the twin gate all
 * round the same way. `Math.round` is ties-toward-+∞ and WGSL's `round` is
 * ties-to-EVEN, so this is exactly the function where two implementations
 * quietly disagree about which cell a probe belongs to.
 */
export function latticeOriginFor(anchorX, anchorY, anchorZ, spacing) {
  return [
    Math.round(anchorX / spacing) * spacing,
    Math.round(anchorY / spacing) * spacing,
    Math.round(anchorZ / spacing) * spacing,
  ];
}

/**
 * The lattice origin as an INTEGER CELL INDEX. Mirror of
 * `srcMathTsl.latticeOriginCell`.
 */
export function latticeOriginCellFor(anchorX, anchorY, anchorZ, spacing) {
  return [
    Math.round(anchorX / spacing),
    Math.round(anchorY / spacing),
    Math.round(anchorZ / spacing),
  ];
}

/**
 * THE WORLD CELL of a point, without ever dividing an absolute world coordinate.
 * Mirror of `srcMathTsl.worldCellAt` — that function's header carries the whole
 * argument (f32 precision, and why this is what deletes the re-anchor).
 */
export function worldCellAt(px, py, pz, anchorX, anchorY, anchorZ, spacing) {
  const o = latticeOriginCellFor(anchorX, anchorY, anchorZ, spacing);
  const local = nearestCell(px, py, pz, o[0] * spacing, o[1] * spacing, o[2] * spacing, spacing);
  return { cx: o[0] + local.cx, cy: o[1] + local.cy, cz: o[2] + local.cz };
}

/** World position of lattice cell (cx, cy, cz). */
export function cellPosition(cx, cy, cz, originX, originY, originZ, spacing) {
  return [originX + cx * spacing, originY + cy * spacing, originZ + cz * spacing];
}

/**
 * Renormalized sparse gather. `lookup(cx, cy, cz)` returns a value or null.
 * `combine(acc, value, weight)` accumulates. Returns null when NO corner
 * existed — the caller then falls back to temporal fill, never to a
 * fixed-radius guess (R1).
 */
export function sparseGather(corners, lookup, combine, zero) {
  let total = 0;
  let acc = zero();
  for (const c of corners) {
    if (!(c.weight > 0)) continue;
    const v = lookup(c.cx, c.cy, c.cz);
    if (v == null) continue;
    acc = combine(acc, v, c.weight);
    total += c.weight;
  }
  return total > 0 ? { value: acc, weight: total } : null;
}

// ═══════════════════════════════════════ OCTAHEDRAL — IRRADIANCE TILES ONLY
//
// The ONE place octahedral survives (paper §6): the per-probe 6×6 irradiance
// texture pixels sample for final shading. Bins are equal-area cylindrical;
// these tiles are octahedral because they are SAMPLED BY A NORMAL with
// hardware bilinear filtering, which the octahedral layout supports with a
// 1-texel border and the cylindrical one does not (its azimuth seam and pole
// rows have no consistent border).
//
// Mirrors cascadeTrace.js's `octahedralUV` / `octahedralDirection` /
// `octahedralTexelWeight` exactly — that math was earned (the texel solid
// angle varies 2.73×, and ignoring it put a 1.95× position-dependent error in
// every gather) and is reused verbatim rather than re-derived.

/** Direction → continuous octahedral texel coords in [0, res). */
export function octahedralUV(dx, dy, dz, res) {
  const inv = 1 / (Math.abs(dx) + Math.abs(dy) + Math.abs(dz));
  const px = dx * inv;
  const py = dy * inv;
  let fx = px;
  let fy = py;
  if (dz <= 0) {
    const sx = px >= 0 ? 1 : -1;
    const sy = py >= 0 ? 1 : -1;
    fx = (1 - Math.abs(py)) * sx;
    fy = (1 - Math.abs(px)) * sy;
  }
  return { u: (fx * 0.5 + 0.5) * res, v: (fy * 0.5 + 0.5) * res };
}

/** Octahedral texel centre (u, v) in a res×res tile → unit direction. */
export function octahedralDirection(u, v, res) {
  const fx = ((u + 0.5) / res) * 2 - 1;
  const fy = ((v + 0.5) / res) * 2 - 1;
  const nz = 1 - Math.abs(fx) - Math.abs(fy);
  const fold = Math.max(-nz, 0);
  const sx = fx >= 0 ? 1 : -1;
  const sy = fy >= 0 ? 1 : -1;
  const nx = fx - sx * fold;
  const ny = fy - sy * fold;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/**
 * RELATIVE solid angle of the octahedral texel a normalized direction came
 * from: Δω ∝ (|dx| + |dy| + |dz|)³. Only ratios matter (every consumer divides
 * by its own Σ), so the (2/res)² constant is deliberately omitted — exactly as
 * in the TSL original.
 */
export function octahedralTexelWeight(dx, dy, dz) {
  const s = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
  return s * s * s;
}

// ══════════════════════════════════ §12.82 — A HIT NORMAL IN ONE WORD
//
// Mirror of `srcMathTsl.js`'s pair; that side's header carries the argument
// (why one word, and why the present bit cannot be inferred from the decoded
// direction — (0,0) decodes to −Z, so a zeroed word would claim to be a real
// surface facing away).

/** Octahedral grid resolution per axis — 15 bits, leaving room for the flag. */
export const NORMAL_OCT_RES = 32768;
/** Bit 30: "this bin has a normal". */
export const NORMAL_OCT_PRESENT = 1 << 30;

/** Unit normal → one packed word. Twin of `srcMathTsl.js`'s `packNormal`. */
export function packNormal(dx, dy, dz) {
  const { u, v } = octahedralUV(dx, dy, dz, NORMAL_OCT_RES);
  // `Math.floor`, and CLAMPED — `octahedralUV` returns [0, res] closed at the
  // far edge (an axial direction lands exactly on it), and res would set a
  // sixteenth bit and walk into the flag.
  const iu = Math.min(NORMAL_OCT_RES - 1, Math.max(0, Math.floor(u)));
  const iv = Math.min(NORMAL_OCT_RES - 1, Math.max(0, Math.floor(v)));
  return (iu + iv * NORMAL_OCT_RES + NORMAL_OCT_PRESENT) >>> 0;
}

/** Packed word → unit normal. Test `normalPresent` FIRST. */
export function unpackNormal(word) {
  const w = word >>> 0;
  const u = w & (NORMAL_OCT_RES - 1);
  const v = (w >>> 15) & (NORMAL_OCT_RES - 1);
  return octahedralDirection(u, v, NORMAL_OCT_RES);
}

/** Whether a bin has ever been given a normal. */
export function normalPresent(word) {
  return ((word >>> 0) & NORMAL_OCT_PRESENT) !== 0;
}

/**
 * Octahedral texel index in a res×res tile — nearest texel, clamped.
 */
export function octahedralTexelIndex(dx, dy, dz, res) {
  const { u, v } = octahedralUV(dx, dy, dz, res);
  const ui = Math.min(res - 1, Math.max(0, Math.floor(u)));
  const vi = Math.min(res - 1, Math.max(0, Math.floor(v)));
  return vi * res + ui;
}

// ══════════════════════════════════════════ [H] IRRADIANCE-TILE LAYOUT
//
// The two scene-independent tables the tile bake needs. Both live here rather
// than beside the bake because they are pure LAYOUT — functions of (w,
// interior, sub) and nothing else — and because putting them here is what
// lets the GPU bake and the CPU mirror share ONE definition instead of
// growing a twin each.

/**
 * For every texel of a BORDERED tile, the INTERIOR texel index whose value it
 * carries. The one definition of the octahedral wrap rule.
 *
 * ══ THE WRAP RULE ══════════════════════════════════════════════════════════
 *
 * Crossing an edge of the octahedral square continues onto the sphere at the
 * mirrored position on the SAME edge with the other axis negated. In texel
 * terms: an edge's border row is that edge's own texels in REVERSE order, and
 * each corner border texel is the DIAGONALLY OPPOSITE interior corner.
 *
 * Interior texels map to themselves, which is what makes the returned array a
 * complete description of the tile: **every texel, border or not, is the
 * irradiance integral evaluated at exactly one interior direction.** The GPU
 * bake spends that: it dispatches one thread per tile texel and each thread
 * runs the integral for `map[texel]`, so the border needs no copy pass, no
 * read-after-write on the atlas, and no wrap logic in WGSL at all.
 *
 * @param {number} interior  payload resolution (6)
 * @param {number} [border]  border width (1)
 * @returns {Int32Array} length `(interior + 2·border)²`
 */
export function octahedralBorderMap(interior, border = 1) {
  const N = interior;
  const size = N + 2 * border;
  const map = new Int32Array(size * size);
  const inner = (x, y) => y * N + x;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px - border;
      const y = py - border;
      const insideX = x >= 0 && x < N;
      const insideY = y >= 0 && y < N;
      let src;
      if (insideX && insideY) src = inner(x, y);
      // Left/right borders mirror their own edge vertically; top/bottom mirror
      // theirs horizontally.
      else if (insideY) src = inner(px === 0 ? 0 : N - 1, N - 1 - y);
      else if (insideX) src = inner(N - 1 - x, py === 0 ? 0 : N - 1);
      // All four corners are the −Z pole, which is exactly why this line
      // matters more than it looks — see `fillOctahedralBorder`'s header for
      // the 32% it is worth on a −Z receiver.
      else src = inner(px === 0 ? N - 1 : 0, py === 0 ? N - 1 : 0);
      map[py * size + px] = src;
    }
  }
  return map;
}

/**
 * The per-(bin, tile-texel) cosine weight table:
 *
 *     W(bin, n̂) = ⟨max(0, ω·n̂)⟩ over the bin's solid angle
 *
 * NOT `max(0, ω_centre·n̂)`, and that distinction is worth an essay because it
 * is a bias the convergence sweep caught red-handed.
 *
 * A c0 bin is 4π/32 ≈ 0.39 sr — about 40° across. Evaluating the cosine at its
 * CENTRE and calling that the bin's contribution is a one-point quadrature over
 * a 40° cone, and the error it leaves is ANGULAR: refining probe spacing cannot
 * reduce it, because s0 buys spatial resolution and this is a directional
 * integral. The Phase-0 sweep showed exactly that fingerprint — 32.2% → 30.0%
 * → 28.6% across two halvings of s0, i.e. flat. A blur shrinks; a bias sits
 * there, and telling them apart is the entire reason that arm measures
 * convergence instead of comparing against a tolerance.
 *
 * (This is the same class as the "frozen texel-centre cosine" the plan's §1
 * table blames for the dense backend's settled-panel residual. It survived the
 * architecture change because it was never in the transport — it was in the
 * bake.)
 *
 * The fix is a proper quadrature: sub-sample each bin. Because the bins are
 * EQUAL-AREA in (x, y), uniform sub-sampling in (x, y) is uniform in solid
 * angle, so a plain mean over sub-samples IS the solid-angle average — no
 * Jacobian, no weights. The table depends only on (w, tileRes, sub), never on
 * the scene, so it is computed once and shared by every probe.
 *
 * Layout is `[bin·texels + texel]`. `tileCosineWeights` below transposes it
 * into the bordered layout the GPU wants.
 */
const cosWeightCache = new Map();
export function binCosineWeights(w, tileRes, sub = 4) {
  const key = `${w}|${tileRes}|${sub}`;
  const hit = cosWeightCache.get(key);
  if (hit) return hit;
  const nBins = 2 * w * w;
  const texels = tileRes * tileRes;
  const table = new Float64Array(nBins * texels);
  // Texel normals, hoisted.
  const normals = new Array(texels);
  for (let v = 0; v < tileRes; v++) {
    for (let u = 0; u < tileRes; u++) normals[v * tileRes + u] = octahedralDirection(u, v, tileRes);
  }
  const invSub = 1 / (sub * sub);
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < 2 * w; i++) {
      const m = binMorton(i, j);
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const x = (i + (sx + 0.5) / sub) / (2 * w);
          const y = (j + (sy + 0.5) / sub) / w;
          const d = decodeDir(x, y);
          for (let t = 0; t < texels; t++) {
            const n = normals[t];
            const cos = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
            if (cos > 0) table[m * texels + t] += cos * invSub;
          }
        }
      }
    }
  }
  cosWeightCache.set(key, table);
  return table;
}

/**
 * `binCosineWeights`, transposed into the BORDERED tile layout and indexed
 * `[texel·nBins + bin]` — the exact table the GPU bake reads.
 *
 * Two changes from the interior table, and both remove work from WGSL:
 *
 * - **Border rows are the mirrored interior rows.** A border texel's weights
 *   are its wrapped interior texel's weights, so a thread that owns a border
 *   texel computes the same integral and stores it in the border position.
 *   The wrap therefore lives in a CPU-built table rather than in shader
 *   control flow, which is why the bake kernel has no octahedral math in it at
 *   all.
 * - **Bin-major within a texel**, so the kernel's inner loop over bins walks
 *   contiguous memory.
 *
 * f32 rather than f64 because it is uploaded — and it is the same value the
 * mirror uses, rounded once, in one place.
 */
export function tileCosineWeights(w, interior, sub = 4, border = 1) {
  const nBins = 2 * w * w;
  const size = interior + 2 * border;
  const inner = binCosineWeights(w, interior, sub);
  const map = octahedralBorderMap(interior, border);
  const texels = interior * interior;
  const out = new Float32Array(size * size * nBins);
  for (let t = 0; t < size * size; t++) {
    const src = map[t];
    for (let m = 0; m < nBins; m++) out[t * nBins + m] = inner[m * texels + src];
  }
  return out;
}

// ═══════════════════════════════════════════════ THE HALF-FLOAT PAYLOAD CODEC
//
// Plan §11.4 A1 (2026-09-03): the resolved payload — rgb + transmittance per
// bin — is stored as four IEEE binary16 halves in two u32 words instead of
// four f32 words. It is the second-largest allocation in the module (72 MB of
// a 220 MB store on Bistro) and every screen-side consumer already reads it
// through an rgba16f tile atlas, so nothing on the image path had more than
// half precision to begin with. The kernels pack with WGSL's `pack2x16float`;
// THIS is the CPU twin of that conversion, in pure JS because this file is the
// bare-Node mirror and may not import `three` (DataUtils has the same tables).
//
// Round-to-nearest-even. WGSL leaves the narrowing rounding mode to the
// implementation (RTNE or RTZ), so a gate that diffs a packed GPU word against
// this encoder must allow ONE ulp of disagreement rather than assert the bit —
// `halfUlp` below is that allowance, and it is deliberately the SAME function
// every gate reaches for so the tolerance has one definition. MEASURED: the
// NVIDIA/Dawn path rounds TOWARD ZERO (`test:gi-src-temporal` read a
// pass-through transmittance of exactly 1 − 2^-11 where RTNE gives 1), so
// the GPU's halves sit at or one ulp BELOW this encoder's, never above.

const HALF_F32 = new Float32Array(1);
const HALF_U32 = new Uint32Array(HALF_F32.buffer);

/** f32 → binary16 bits (u16), round-to-nearest-even; overflow → ±inf. */
export function floatToHalfBits(x) {
  HALF_F32[0] = x;
  const u = HALF_U32[0];
  const sign = (u >>> 16) & 0x8000;
  const exp = (u >>> 23) & 0xff;
  let mant = u & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    // Subnormal half (or underflow to zero): the value is `1.mant × 2^(e−15)`
    // and the half's mantissa unit is 2^−24, so shift the 24-bit significand
    // down by `14 − e` places with round-half-even on the dropped bits.
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && (h & 1))) h++;
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
  return h;
}

/** binary16 bits (u16) → f32. */
export function halfBitsToFloat(h) {
  const sign = (h & 0x8000) << 16;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) {
    if (mant === 0) { HALF_U32[0] = sign; return HALF_F32[0]; }
    return (sign ? -1 : 1) * mant * 5.960464477539063e-8;
  }
  if (exp === 0x1f) { HALF_U32[0] = sign | 0x7f800000 | (mant << 13); return HALF_F32[0]; }
  HALF_U32[0] = sign | ((exp - 15 + 127) << 23) | (mant << 13);
  return HALF_F32[0];
}

/** `x` rounded through binary16 — what the GPU's packed word decodes back to. */
export function halfRound(x) {
  return halfBitsToFloat(floatToHalfBits(x));
}

/** Two halves in one u32, `a` in the low 16 bits — WGSL `pack2x16float` order. */
export function packHalf2(a, b) {
  return (floatToHalfBits(a) | (floatToHalfBits(b) << 16)) >>> 0;
}

/** The inverse of `packHalf2` — `[low, high]`. */
export function unpackHalf2(w) {
  return [halfBitsToFloat(w & 0xffff), halfBitsToFloat(w >>> 16)];
}

/**
 * One unit in the last place of binary16 at `x` — the gate tolerance for a
 * value that crossed the packed payload. Normal halves carry a 10-bit
 * mantissa, so an ulp is `2^(⌊log2|x|⌋ − 10)`; below the normal range it is the
 * subnormal quantum 2^−24. Callers that compare a GPU word against a CPU value
 * computed in f64 should allow `halfUlp(x)` (one ulp), which covers both the
 * implementation-defined rounding direction and the f32-vs-f64 arithmetic
 * that can move a value across a rounding boundary.
 */
export function halfUlp(x) {
  const a = Math.abs(x);
  if (!(a >= 6.103515625e-5)) return 5.960464477539063e-8;
  return Math.pow(2, Math.floor(Math.log2(a)) - 10);
}
