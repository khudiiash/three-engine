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
// 3. THE ATLAS TEXEL'S ALPHA CARRIES TWO NUMBERS. §L.2 wants `(radiance,
//    hitDistance)` in the texel and §L.3 wants the per-texel sample count in
//    the alpha. There is one channel. It holds `n·1024 + min(dist, 1023)`:
//    n ≤ H = 4 so the integer part is exact in f32, and the distance keeps
//    ~0.3 mm of precision.
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
  Break, Fn, If, Loop, Return, atomicAdd, bitAnd, bitOr, bitXor, dot, exp, exp2, float, globalId,
  instanceIndex, instancedArray, int, ivec2, max, min, mix, normalize, select, shiftLeft,
  shiftRight, sqrt, step, storage, texture, textureStore, uint, uniform, uniformArray, vec2, vec3,
  vec4,
} from "three/tsl";
import { LEVEL_WORDS, N, PAL_OFF } from "./windowStore.js";
import { normalOfFace } from "./radianceCache.js";
import { octahedralUV } from "../srcOctahedral.js";

/**
 * Tier constants. These, and only these, are compiled into the WGSL.
 *
 * `tile` and `rays` are PLAN §4.6's row; `oct` is §L's `O = 8` (64 directions);
 * `history` is §L.3's `H = 4`; `sh` selects the resolve's DIFFUSE integrator.
 *
 * ⚠ `sh` is `true` on every tier since Stage 3.2. §L.5 offered "SH on phone,
 * oct sum on desktop; measure both" — measured, the two agree to 1.5 % on the
 * diffuse crops and the sum costs 4× the whole resolve. A tier row that can
 * only ever hold one value is kept as a row so the A/B stays expressible, not
 * because a tier is expected to differ.
 */
export const GATHER_TIERS = {
  phone: { tile: 16, rays: 8, oct: 8, history: 4, sh: true, hzbSteps: 12 },
  medium: { tile: 16, rays: 8, oct: 8, history: 4, sh: true, hzbSteps: 12 },
  high: { tile: 8, rays: 16, oct: 8, history: 4, sh: true, hzbSteps: 12 },
  ultra: { tile: 8, rays: 16, oct: 8, history: 4, sh: true, hzbSteps: 12 },
};

/** HZB mips and §L.2's step budget — the tier row's DEFAULT, not the value. */
export const HZB_MIPS = 5;
export const HZB_STEPS = 24;
/** §L.2's "relative thickness 0.1", and the bias that keeps a ray off its own pixel. */
export const HZB_THICKNESS = 0.1;
export const HZB_ZBIAS = 0.02;
/** A depth that means "sky" in the pyramid — larger than any scene. */
export const HZB_FAR = 1e6;
/** Palette slots. A material CLASS table, not a scene number; 15 is "no surface". */
export const PAL_ENTRIES = 16;
/** Striped statistics: one counter is 64 words, indexed by lane, summed on read. */
export const STAT_STRIPE = 64;
/**
 * The debug arm's ring: how many EXHAUSTED rays `exhaustProbe` records.
 * Its claim counter is stats slot 15, which no counter uses.
 */
export const EXHAUST_SLOTS = 256;
export const EXHAUST_CLAIM = 15;
export const STATS = {
  probesPlaced: 0, probesValid: 1, reprojHits: 2, raysLaunched: 3, raysTraced: 4,
  screenHits: 5, windowHits: 6, skyMiss: 7, freshShades: 8, alphaForced: 9,
  injectWrites: 10, handoffs: 11,
};
export const STAT_SLOTS = 16;
export const STAT_WORDS = STAT_SLOTS * STAT_STRIPE;

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
  sun = null, sky = null, emitters = null,
}) {
  const spec = GATHER_TIERS[tier];
  if (!spec) throw new Error(`unknown gather tier "${tier}"`);
  const T = spec.tile;
  const R = spec.rays;
  const O = spec.oct;
  const OCT = O * O;
  const OCT_SHIFT = Math.log2(O);
  const H = spec.history;
  const STRIDE = OCT / R;
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
  const probeOct = instancedArray(new Float32Array(2 * probeCount * OCT * 4), "vec4");
  const MIP_BASE = probeCount * OCT;
  const probeFiltered = instancedArray(
    new Float32Array((probeCount * OCT + probeCount * MIP_TEXELS) * 4), "vec4",
  );
  // TWO halves: [0] is what every consumer reads (`shIdx` — the FILTERED
  // coefficients, and the address Stage 3.4's emitter term adds into), [1] is
  // the per-probe RAW projection `probeShFilter` pools from (`shRawIdx`). The
  // filtered half comes FIRST so no address outside this file had to change.
  const probeSh = instancedArray(new Float32Array(2 * probeCount * 9 * 4), "vec4");
  const hzb = instancedArray(new Float32Array(hzbWords), "float");
  const statsBuf = instancedArray(new Uint32Array(STAT_WORDS), "uint");
  const stats = storage(statsBuf.value, "uint", STAT_WORDS).toAtomic();
  const cropIn = instancedArray(new Float32Array(crops * 4), "vec4");
  const CROP_OUT_VEC = 6;
  const cropOut = instancedArray(new Float32Array(crops * CROP_OUT_VEC * 4), "vec4");
  const litBuf = instancedArray(new Float32Array(width * height * 4), "vec4");
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
    injectAlpha: uniform(0.25),
    // §L.3's biased hysteresis, as a UNIFORM arm rather than a compiled-in
    // rule — the same discipline `hzbOn` follows. It is a claim about the
    // estimator ("a big change is a lighting change") that only a measurement
    // can settle, and the measurement needs both arms out of one binary.
    hystOn: uniform(1),
    // ⭐ THE OCT-MAP CARRY IS THE OTHER HALF OF `probePlace`, and it is the
    // only part of that kernel whose cost scales with the OCT MAP rather than
    // with the four candidate gbuffer reads §L.1 describes. A uniform arm so
    // "probePlace costs 0.76 ms" can be split into "0.1 for the placement and
    // 0.66 for copying 64 texels per probe" instead of argued about.
    carryOn: uniform(1),
    // §L.3's history depth. A TIER CONSTANT in the table above and a uniform
    // here for the same reason `hystOn` is: how much variance H buys, and what
    // it costs in responsiveness, is a measurement.
    historyU: uniform(H),
  };
  const palette = Array.from({ length: PAL_ENTRIES }, () => new THREE.Vector4(0, 0, 0, 0));
  const palU = uniformArray(palette, "vec4");
  const octU = uniformArray(octTable(O), "vec4");
  const mipU = uniformArray(mipOff.map((o, m) => new THREE.Vector4(o, mipW[m], mipH[m], 0)), "vec4");

  const posNode = texture(positionTexture);
  const nrmNode = texture(normalTexture);
  const litNode = texture(lit);
  const irrNode = texture(irradiance);
  const glossyNode = texture(glossy);
  const irrHalfNode = texture(irradianceHalf);
  const glossyHalfNode = texture(glossyHalf);

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

  /** Palette entry of a window voxel: `vec4(albedo.rgb, emissive)`. */
  const palAt = (levelF, voxF) => {
    const vi = voxF.toUint().toVar();
    const wAddr = levelF.toUint().mul(uint(LEVEL_WORDS)).add(uint(PAL_OFF)).add(shiftRight(vi, uint(2)));
    const shiftBits = bitAnd(vi, uint(3)).mul(uint(8));
    const p = bitAnd(shiftRight(win.buffer.element(wAddr), shiftBits), uint(255)).toVar();
    return palU.element(min(p, uint(PAL_ENTRIES - 1)));
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
  const palAtWorld = (p, n) => {
    const c = cellOfWorld(p.sub(n.mul(v0 * SURFACE_EPS)));
    return palAt(c.level.toFloat(), c.vi.toFloat());
  };

  /** Striped, uniform-gated counter (see the header's bend 5). */
  const bump = (slot, laneU) => {
    If(u.statsOn.greaterThan(0.5), () => {
      atomicAdd(stats.element(uint(slot * STAT_STRIPE).add(bitAnd(laneU, uint(STAT_STRIPE - 1)))), uint(1));
    });
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
  const probePlacePass = Fn(() => {
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
    Loop({ start: 0, end: 8, name: "cand" }, ({ cand }) => {
      If(valid.greaterThan(0.5), () => { Break(); });
      const s = u.frame.mul(uint(4)).add(bitAnd(uint(cand), uint(3))).toVar();
      const jx = radical2(bitAnd(s, uint(63))).toVar();
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
    If(valid.greaterThan(0.5), () => {
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
          const pixWorld = depth.div(u.projScale).toVar();
          const tolN = float(0.5 * T).mul(pixWorld).max(v0).toVar();
          const vdir = normalize(pos.sub(u.camPos)).toVar();
          const slant = dot(nrm, vdir).abs().max(0.05).toVar();
          const dlt = pos.sub(pa.xyz).toVar();
          const near = dot(nrm, dlt).abs().lessThan(tolN)
            .and(dlt.length().lessThan(tolN.div(slant)));
          const align = dot(nrm, pb.xyz).greaterThan(0.9);
          If(pa.w.greaterThan(0.5).and(near).and(align), () => {
            prevProbe.assign(pi.toFloat());
            bump(STATS.reprojHits, tx);
          });
        });
      });
    });

    probeMeta.element(metaIdx(u.curBase, probe, 0)).assign(vec4(pos, valid));
    probeMeta.element(metaIdx(u.curBase, probe, 1)).assign(vec4(nrm, depth));
    probeMeta.element(metaIdx(u.curBase, probe, 2)).assign(vec4(prevProbe, 0, 0, 0));

    // ── carry the oct map forward (§L.3) ───────────────────────────────────
    // Only R of the 64 texels are re-traced this frame; the other 56-59 are
    // whatever the MATCHING previous probe held. No match ⇒ start at zero,
    // which is what `n = 0` in the alpha then means to every consumer.
    const has = prevProbe.greaterThanEqual(0).and(valid.greaterThan(0.5)).toVar();
    const src = prevProbe.max(0).toUint().toVar();
    If(u.carryOn.greaterThan(0.5), () => {
      Loop({ start: 0, end: OCT, name: "carry" }, ({ carry }) => {
        const t = uint(carry).toVar();
        const prev = probeOct.element(octIdx(u.prevBase, src, t)).toVar();
        probeOct.element(octIdx(u.curBase, probe, t)).assign(select(has, prev, vec4(0)));
      });
    });
  })().compute(dispatch2d(probeW, probeH), WG);

  // ══════════════════════════════════════════════ the shading of one hit
  //
  // §L.2's "shade it NOW": palette albedo against the sun (one DDA shadow ray)
  // and the emissive panel (one NEE shadow ray), plus the palette's own
  // emission. No indirect term — multibounce arrives through the cache's EMA
  // and through `injectLitFrame`, which is the point of §K.6.
  const shadeHit = (p, n, levelF, voxF) => {
    const pal = palAt(levelF, voxF).toVar();
    const E = vec3(0).toVar();

    const toSun = u.sunDir.negate().normalize().toVar();
    const ndl = dot(n, toSun).max(0).toVar();
    If(ndl.greaterThan(0.001), () => {
      const sh = traceWindow(p, toSun, RAY_MAX, n).hit.toVar();
      E.addAssign(u.sunColor.mul(ndl).mul(float(1).sub(sh)));
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
    for (const slot of emitters ?? []) {
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
          E.addAssign(rgb.mul(omega).mul(cosX).mul(vis));
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
    // `pal.w` there, and a light cannot illuminate itself without being
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
    if (!emitters?.length) If(p.y.lessThan(u.panelCentre.y.sub(0.05)), () => {
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
          const cosX = dot(n, wd).max(0).toVar();
          // The panel faces −Y, so its own cosine toward `p` is `wd.y`.
          const cosP = wd.y.max(0).toVar();
          If(cosX.mul(cosP).greaterThan(1e-5), () => {
            const tStop = yStop.sub(pRay.y).div(wd.y.max(1e-3)).min(d).max(0.05).toVar();
            const vis = float(1).sub(traceWindow(p, wd, tStop, n).hit).toVar();
            E.addAssign(u.panelRadiance.mul(cosX).mul(cosP)
              .mul(u.panelArea.mul(0.25)).div(d2).mul(vis));
          });
        }
      }
    });

    return pal.xyz.mul(1 / Math.PI).mul(E).add(vec3(pal.w));
  };

  // ══════════════════════════════════════════════ the HZB screen segment
  //
  // Stackless closest-depth walk. The screen path of a straight world ray is a
  // straight SCREEN segment (a perspective projection maps lines to lines) and
  // `1/z` is linear along it — so the whole march is a 2-D DDA in `k ∈ [0, 1]`
  // with one reciprocal for the depth, and the only per-mip work is the
  // cell-boundary solve. On "behind a surface" or off-screen the walk hands the
  // ray to `traceWindow` at the LAST UNOCCLUDED position, never at the position
  // that failed — §L.2's step-back.
  const screenSegment = (p0, dir, segLen, outHit, outRad, outDist, laneU) => {
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
              bump(STATS.screenHits, laneU);
            });
            Break();
          });
        }).Else(() => {
          k.assign(kNext);
          mip.assign(min(mip.add(1), float(HZB_MIPS - 1)));
          If(kNext.greaterThanEqual(0.9999), () => { Break(); });
        });
      });

      // The counter kept its name and lost its job: it counts the rays whose
      // screen walk ended WITHOUT a hit, which is what it always measured.
      If(outHit.lessThan(0.5), () => { bump(STATS.handoffs, laneU); });
    });
  };

  // ══════════════════════════════════════════════ SHADER: probeTrace (§L.2/3)
  const probeTracePass = Fn(() => {
    const xr = globalId.x.toVar();
    const ty = globalId.y.toVar();
    If(xr.greaterThanEqual(u.probeWU.mul(uint(R))).or(ty.greaterThanEqual(u.probeHU)), () => { Return(); });
    const tx = xr.div(uint(R)).toVar();
    const kRay = xr.sub(tx.mul(uint(R))).toVar();
    const probe = ty.mul(u.probeWU).add(tx).toVar();
    bump(STATS.raysLaunched, xr);

    const ma = probeMeta.element(metaIdx(u.curBase, probe, 0)).toVar();
    const mb = probeMeta.element(metaIdx(u.curBase, probe, 1)).toVar();
    If(ma.w.lessThan(0.5), () => { Return(); });
    const pos = ma.xyz.toVar();
    const nrm = mb.xyz.toVar();

    // ── the thread's texel window (§L bend 2) ──────────────────────────────
    const rot = pcg(u.frame.mul(uint(2654435761)).add(probe)).toVar();
    const seedBase = pcg(probe.mul(uint(196613)).add(u.frame.mul(uint(83492791)))).toVar();
    const texel = int(-1).toVar();
    const dir = vec3(0, 1, 0).toVar();
    Loop({ start: 0, end: STRIDE, name: "pick" }, ({ pick }) => {
      If(texel.greaterThanEqual(0), () => { Break(); });
      const t = bitAnd(kRay.mul(uint(STRIDE)).add(uint(pick)).add(rot), uint(OCT - 1)).toVar();
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
    const contact = r.x.greaterThan(0.5).and(r.y.lessThan(v0 * CONTACT_CELLS)).toVar();
    If(u.hzbOn.greaterThan(0.5).and(contact), () => {
      screenSegment(pos.add(nrm.mul(v0 * 0.5)), dir, r.y.add(v0), sHit, sRad, sDist, xr);
    });
    sHit.assign(select(
      sHit.greaterThan(0.5).and(sDist.sub(r.y).abs().lessThan(v0)), float(1), float(0),
    ));

    // ── the radiance: the screen's own pixel, or the hit voxel's cache face ─

    // ── segment 2: the window, then the cache ──────────────────────────────
    const rad = vec3(0).toVar();
    const hitDist = float(RAY_MAX).toVar();
    If(sHit.greaterThan(0.5), () => {
      rad.assign(sRad);
      hitDist.assign(sDist);
    }).Else(() => {
      const zi = r.z.toUint().toVar();
      If(r.x.greaterThan(0.5), () => {
        const faceF = bitAnd(zi, uint(7)).toFloat().toVar();
        const levelF = bitAnd(shiftRight(zi, uint(3)), uint(7)).toFloat().toVar();
        const voxF = shiftRight(zi, uint(6)).toFloat().toVar();
        const hn = normalOfFace(faceF).toVar();
        const hp = faceSamplePoint(levelF, voxF, hn).toVar();
        const c = cache.cacheRead(levelF, voxF, faceF).toVar();
        If(c.w.greaterThan(0.5), () => {
          rad.assign(c.xyz);
        }).Else(() => {
          const s = shadeHit(hp, hn, levelF, voxF).toVar();
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
          cache.cacheWrite(levelF, voxF, faceF, s, 1).toVar();
          rad.assign(s);
          bump(STATS.freshShades, xr);
        });
        hitDist.assign(r.y);
        bump(STATS.windowHits, xr);
      }).Else(() => {
        rad.assign(u.skyColor);
        bump(STATS.skyMiss, xr);
      });
    });

    // ── §L.3 accumulation, in probe space ──────────────────────────────────
    const addr = octIdx(u.curBase, probe, texel.toUint()).toVar();
    const old = probeOct.element(addr).toVar();
    const nPrev = old.w.div(1024).floor().toVar();
    const alpha = float(1).div(min(nPrev.add(1), u.historyU)).toVar();
    const lNew = dot(rad, vec3(0.2126, 0.7152, 0.0722)).toVar();
    const lOld = dot(old.xyz, vec3(0.2126, 0.7152, 0.0722)).toVar();
    // GI-1.0's biased hysteresis: a large radiance change drops most of the
    // history at once rather than crawling toward the new value over H frames.
    // ⚠ ONE SAMPLE CANNOT EVIDENCE A CHANGE. `lNew` is a SINGLE ray through a
    // texel that spans 4π/64 sr; `lOld` is a mean of up to H of them. In a
    // Cornell box a texel's radiance ranges over an order of magnitude inside
    // its own solid angle, so "differs by more than 50 %" is the NOISE, not a
    // change — and forcing α = 0.5 on it discards the history that was
    // suppressing exactly that noise. Kept behind a uniform so the wall's
    // mottling can be measured with it and without it.
    const big = u.hystOn.greaterThan(0.5).and(nPrev.greaterThan(0.5))
      .and(lNew.sub(lOld).abs().greaterThan(max(lNew, lOld).mul(0.5))).toVar();
    If(big, () => { bump(STATS.alphaForced, xr); });
    const a = select(big, float(0.5), alpha).toVar();
    const nNext = min(nPrev.add(1), u.historyU).toVar();
    probeOct.element(addr).assign(vec4(
      mix(old.xyz, rad, a),
      nNext.mul(1024).add(min(hitDist, float(1023))),
    ));
  })().compute(dispatch2d(probeW * R, probeH), WG);

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
  const probeFilterPass = Fn(() => {
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
      // marked with a negative alpha, a value the real alpha (n·1024 +
      // distance) can never take.
      const has = tv.w.greaterThanEqual(1024).and(alive).toVar();
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
  // §L.4's 3×3 probe-space bilateral, on the NINE COEFFICIENTS. The weights
  // are the same ones the texel form used — plane distance in units of a
  // level-0 cell (the scene's own length, never a metric constant) and normal
  // agreement raised to the fourth so a probe round a corner contributes
  // nothing — and they were already per-probe, so nothing about the filter's
  // shape changes; only what it is applied to.
  const probeShFilterPass = Fn(() => {
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
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
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
        const w = select(
          inB.and(na.w.greaterThan(0.5)).and(ma.w.greaterThan(0.5)),
          wp.mul(wn.mul(wn).mul(wn).mul(wn)), float(0),
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
  const shEval = (L, n) => {
    const c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
    return L[8].mul(c1).mul(n.x.mul(n.x).sub(n.y.mul(n.y)))
      .add(L[6].mul(c3).mul(n.z.mul(n.z)))
      .add(L[0].mul(c4))
      .sub(L[6].mul(c5))
      .add(L[4].mul(2 * c1).mul(n.x).mul(n.y))
      .add(L[7].mul(2 * c1).mul(n.x).mul(n.z))
      .add(L[5].mul(2 * c1).mul(n.y).mul(n.z))
      .add(L[3].mul(2 * c2).mul(n.x))
      .add(L[1].mul(2 * c2).mul(n.y))
      .add(L[2].mul(2 * c2).mul(n.z))
      .max(vec3(0));
  };
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
  const makeResolve = (useSh, half = false, rawSh = false) => Fn(() => {
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
      const bestW = float(-1).toVar();
      // The blended SH2, accumulated in COEFFICIENT space (see `shEval`).
      const Lb = [];
      for (let i = 0; i < 9; i++) Lb.push(vec3(0).toVar());
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
      // §L.5's fallback: the nearest VALID probe, unweighted, rather than a
      // black pixel. A pixel whose four corners all fail the plane test sits
      // on a silhouette, and black there reads as a hard outline. It is folded
      // into the SAME accumulator with weight 1 rather than duplicating the
      // evaluation — one `shEval` per pixel, on every path.
      If(wsum.lessThan(1e-5).and(best.greaterThanEqual(0)), () => {
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
      If(wsum.greaterThan(1e-5), () => {
        if (useSh) {
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
    } else {
      textureStore(irradiance, coord, vec4(E, g.w));
      textureStore(glossy, coord, vec4(G, g.w));
    }
  })().compute(dispatch2d(half ? halfW : width, half ? halfH : height), WG);
  const resolvePass = makeResolve(USE_SH);
  const resolveOctPass = makeResolve(false);
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
  const resolveShRawPass = makeResolve(true, false, true);
  const resolveHalfPass = makeResolve(USE_SH, true);

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
    });
    textureStore(irradiance, coord, vec4(E, g.w));
    textureStore(glossy, coord, vec4(G, g.w));
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
      const pal = palAtWorld(g.xyz, Nn).toVar();
      out.assign(pal.xyz.mul(1 / Math.PI).mul(irrNode.load(coord).xyz)
        .add(glossyNode.load(coord).xyz.mul(u.f0)).add(vec3(pal.w)));
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
      const c = litNode.load(ivec2(px.toInt(), py.toInt())).xyz.toVar();
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
          // `.toVar()` for the same reason as in `probeTrace` - see the note there.
          cache.cacheWrite(float(l), vi.toFloat(), face, c, u.injectAlpha).toVar();
          if (l === 0) bump(STATS.injectWrites, px);
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
  const cropPass = Fn(() => {
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
          const pal = palAtWorld(g.xyz, nn).toVar();
          accP.addAssign(g.xyz);
          accN.addAssign(nn);
          accE.addAssign(irrNode.load(ivec2(px, py)).xyz);
          accG.addAssign(glossyNode.load(ivec2(px, py)).xyz);
          accL.addAssign(litNode.load(ivec2(px, py)).xyz);
          accA.addAssign(pal.xyz);
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
  })().compute(crops);

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

    const shaded = shadeHit(p, n, levelF, voxF).toVar();
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
  const exhaustProbePass = Fn(() => {
    const xr = globalId.x.toVar();
    const ty = globalId.y.toVar();
    If(xr.greaterThanEqual(u.probeWU.mul(uint(R))).or(ty.greaterThanEqual(u.probeHU)), () => { Return(); });
    const tx = xr.div(uint(R)).toVar();
    const kRay = xr.sub(tx.mul(uint(R))).toVar();
    const probe = ty.mul(u.probeWU).add(tx).toVar();
    const ma = probeMeta.element(metaIdx(u.curBase, probe, 0)).toVar();
    const mb = probeMeta.element(metaIdx(u.curBase, probe, 1)).toVar();
    If(ma.w.lessThan(0.5), () => { Return(); });
    const pos = ma.xyz.toVar();
    const nrm = mb.xyz.toVar();

    const rot = pcg(u.frame.mul(uint(2654435761)).add(probe)).toVar();
    const seedBase = pcg(probe.mul(uint(196613)).add(u.frame.mul(uint(83492791)))).toVar();
    const texel = int(-1).toVar();
    const dir = vec3(0, 1, 0).toVar();
    Loop({ start: 0, end: STRIDE, name: "epick" }, ({ epick }) => {
      If(texel.greaterThanEqual(0), () => { Break(); });
      const t = bitAnd(kRay.mul(uint(STRIDE)).add(uint(epick)).add(rot), uint(OCT - 1)).toVar();
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
    const contact = r.x.greaterThan(0.5).and(r.y.lessThan(v0 * CONTACT_CELLS)).toVar();
    If(u.hzbOn.greaterThan(0.5).and(contact), () => {
      screenSegment(pos.add(nrm.mul(v0 * 0.5)), dir, r.y.add(v0), sHit, sRad, sDist, xr);
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

  })().compute(dispatch2d(probeW * R, probeH), WG);

  // ══════════════════════════════════════════════ SHADER: cold-start clears
  const clearProbesPass = Fn(() => {
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
  const setPalette = (entries) => {
    for (let i = 0; i < PAL_ENTRIES; i++) {
      const e = entries[i] ?? { albedo: [0, 0, 0], emissive: 0 };
      palette[i].set(e.albedo[0], e.albedo[1], e.albedo[2], e.emissive ?? 0);
    }
  };
  const beginFrame = (n) => {
    frame = n;
    u.frame.value = n >>> 0;
    u.curBase.value = n & 1;
    u.prevBase.value = (n & 1) ^ 1;
  };

  const describe = () => ({
    tier, tile: T, rays: R, oct: O, history: H, stride: STRIDE, sh: USE_SH,
    width, height, halfW, halfH, probeW, probeH, probeCount,
    hzbMips: HZB_MIPS, hzbSteps: S_MAX, cropBlock: CROP_HALF * 2 + 1,
    bytes: {
      probeMeta: 2 * probeCount * META_VEC * 16,
      probeOct: 2 * probeCount * OCT * 16,
      probeFiltered: (probeCount * OCT + probeCount * MIP_TEXELS) * 16,
      probeSh: 2 * probeCount * 9 * 16,
      hzb: hzbWords * 4,
      litBuf: width * height * 16,
      textures: 3 * width * height * 8 + 2 * halfW * halfH * 8,
    },
  });

  return {
    tier, T, R, O, H, STRIDE, USE_SH, probeW, probeH, probeCount, width, height,
    uniforms: u, palette, setPalette, beginFrame, get frame() { return frame; },
    buffers: {
      probeMeta, probeOct, probeFiltered, probeSh, hzb, statsBuf, cropIn, cropOut, litBuf,
      shadeIn, shadeOut, exhaustOut,
    },
    SHADE_SLOTS, EXHAUST_SLOTS, EXH_VEC,
    textures: { irradiance, glossy, lit, irradianceHalf, glossyHalf },
    passes: {
      hzbBuild: hzbBuildPass,
      hzbReduce: hzbReducePasses,
      probePlace: probePlacePass,
      probeTrace: probeTracePass,
      probeFilter: probeFilterPass,
      probeShFilter: probeShFilterPass,
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
      composite: compositePass,
      inject: injectPass,
      crop: cropPass,
      shadeProbe: shadeProbePass,
      exhaustProbe: exhaustProbePass,
      clearProbes: clearProbesPass,
      clearMeta: clearMetaPass,
      clearStats: clearStatsPass,
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
    frameOrder: [
      hzbBuildPass, ...hzbReducePasses, probePlacePass, probeTracePass,
      probeFilterPass, probeShFilterPass, resolveHalfPass, resolveUpsamplePass,
      compositePass, injectPass,
    ],
    /** Sum a striped counter out of a readback. */
    readStats(u32) {
      const out = {};
      for (const [k, slot] of Object.entries(STATS)) {
        let s = 0;
        for (let j = 0; j < STAT_STRIPE; j++) s += u32[slot * STAT_STRIPE + j];
        out[k] = s;
      }
      return out;
    },
    describe,
    dispose() {
      irradiance.dispose();
      glossy.dispose();
      lit.dispose();
      irradianceHalf.dispose();
      glossyHalf.dispose();
    },
  };
}
