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
 * `history` is §L.3's `H = 4`; `sh` selects §L.5's phone resolve.
 */
export const GATHER_TIERS = {
  phone: { tile: 16, rays: 8, oct: 8, history: 4, sh: true },
  medium: { tile: 16, rays: 8, oct: 8, history: 4, sh: true },
  high: { tile: 8, rays: 16, oct: 8, history: 4, sh: false },
  ultra: { tile: 8, rays: 16, oct: 8, history: 4, sh: false },
};

/** HZB mips and the stackless walk's step budget (§L.2). */
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
export const STATS = {
  probesPlaced: 0, probesValid: 1, reprojHits: 2, raysLaunched: 3, raysTraced: 4,
  screenHits: 5, windowHits: 6, skyMiss: 7, freshShades: 8, alphaForced: 9,
  injectWrites: 10, handoffs: 11,
};
export const STAT_SLOTS = 16;
export const STAT_WORDS = STAT_SLOTS * STAT_STRIPE;

/** Ray length in metres. A tier constant: it bounds the DDA, not the scene. */
export const RAY_MAX = 40;

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
 */
export function createGiGather({
  win, trace, cache, positionTexture, normalTexture, width, height, tier = win.tier, crops = 16,
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
  const probeSh = instancedArray(new Float32Array(probeCount * 9 * 4), "vec4");
  const hzb = instancedArray(new Float32Array(hzbWords), "float");
  const statsBuf = instancedArray(new Uint32Array(STAT_WORDS), "uint");
  const stats = storage(statsBuf.value, "uint", STAT_WORDS).toAtomic();
  const cropIn = instancedArray(new Float32Array(crops * 4), "vec4");
  const CROP_OUT_VEC = 6;
  const cropOut = instancedArray(new Float32Array(crops * CROP_OUT_VEC * 4), "vec4");
  const litBuf = instancedArray(new Float32Array(width * height * 4), "vec4");

  // ── storage textures (§L.5's two outputs, plus the lit frame §L.2 reads) ──
  const mkTex = (name) => {
    const t = new THREE.StorageTexture(width, height);
    t.name = name;
    t.type = THREE.HalfFloatType;
    t.generateMipmaps = false;
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    return t;
  };
  const irradiance = mkTex("gi2Irradiance");
  const glossy = mkTex("gi2Glossy");
  const lit = mkTex("gi2Lit");

  // ── uniforms ──────────────────────────────────────────────────────────────
  const u = {
    frame: uniform(0, "uint"),
    widthU: uniform(width, "uint"),
    heightU: uniform(height, "uint"),
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
    sunDir: uniform(new THREE.Vector3(0, -1, 0)),
    sunColor: uniform(new THREE.Vector3()),
    skyColor: uniform(new THREE.Vector3()),
    panelCentre: uniform(new THREE.Vector3()),
    panelHalf: uniform(new THREE.Vector2(1, 1)),
    panelRadiance: uniform(new THREE.Vector3()),
    panelArea: uniform(1),
    hzbOn: uniform(1),
    statsOn: uniform(1),
    roughness: uniform(0.35),
    f0: uniform(0.04),
    injectAlpha: uniform(0.25),
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

  /** Palette at a world point, pushed half a cell into its own surface. */
  const palAtWorld = (p, n) => {
    const c = cellOfWorld(p.sub(n.mul(v0 * 0.5)));
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
  const octIdx = (half, probe, texel) => half.mul(uint(probeCount * OCT))
    .add(probe.mul(uint(OCT))).add(texel);
  const shIdx = (probe, c) => probe.mul(uint(9)).add(uint(c));

  // ══════════════════════════════════════════════ SHADER: probePlace (§L.1)
  const probePlacePass = Fn(() => {
    const tx = globalId.x.toVar();
    const ty = globalId.y.toVar();
    If(tx.greaterThanEqual(u.probeWU).or(ty.greaterThanEqual(u.probeHU)), () => { Return(); });
    const probe = ty.mul(u.probeWU).add(tx).toVar();
    bump(STATS.probesPlaced, tx);

    // ── the anchor: 4 Hammersley candidates, sky rejected ──────────────────
    const pos = vec3(0).toVar();
    const nrm = vec3(0, 1, 0).toVar();
    const depth = float(0).toVar();
    const valid = float(0).toVar();
    Loop({ start: 0, end: 4, name: "cand" }, ({ cand }) => {
      If(valid.greaterThan(0.5), () => { Break(); });
      const s = u.frame.mul(uint(4)).add(uint(cand)).toVar();
      const jx = radical2(bitAnd(s, uint(63))).toVar();
      const jy = rand01(s.add(probe.mul(uint(9781)))).toVar();
      const px = min(tx.mul(uint(T)).add(jx.mul(T).toUint()), u.widthU.sub(uint(1))).toVar();
      const py = min(ty.mul(uint(T)).add(jy.mul(T).toUint()), u.heightU.sub(uint(1))).toVar();
      const g = loadPos(px.toInt(), py.toInt()).toVar();
      If(g.w.greaterThan(0.5), () => {
        pos.assign(g.xyz);
        nrm.assign(normalize(loadNrm(px.toInt(), py.toInt()).xyz));
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
          // §L.3's two gates. The position tolerance is half a TILE's world
          // footprint at this depth — derived from the pixel size, never a
          // metric constant, so it is right at 1 m and at 100 m.
          const pixWorld = depth.div(u.projScale).toVar();
          const near = pos.sub(pa.xyz).length().lessThan(float(0.5 * T).mul(pixWorld).max(v0));
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
    Loop({ start: 0, end: OCT, name: "carry" }, ({ carry }) => {
      const t = uint(carry).toVar();
      const prev = probeOct.element(octIdx(u.prevBase, src, t)).toVar();
      probeOct.element(octIdx(u.curBase, probe, t)).assign(select(has, prev, vec4(0)));
    });
  })().compute(dispatch2d(probeW, probeH), WG);

  // ══════════════════════════════════════════════ the shading of one hit
  //
  // §L.2's "shade it NOW": palette albedo against the sun (one DDA shadow ray)
  // and the emissive panel (one NEE shadow ray), plus the palette's own
  // emission. No indirect term — multibounce arrives through the cache's EMA
  // and through `injectLitFrame`, which is the point of §K.6.
  const shadeHit = (p, n, levelF, voxF, seedU) => {
    const pal = palAt(levelF, voxF).toVar();
    const E = vec3(0).toVar();

    const toSun = u.sunDir.negate().normalize().toVar();
    const ndl = dot(n, toSun).max(0).toVar();
    If(ndl.greaterThan(0.001), () => {
      const sh = traceWindow(p, toSun, RAY_MAX, n).hit.toVar();
      E.addAssign(u.sunColor.mul(ndl).mul(float(1).sub(sh)));
    });

    // Panel NEE, skipped at or above the panel's own plane: its emission is
    // already in `pal.w` there, and a light cannot illuminate itself without
    // being counted twice.
    If(p.y.lessThan(u.panelCentre.y.sub(0.05)), () => {
      const r1 = rand01(seedU).sub(0.5).toVar();
      const r2 = rand01(seedU.add(uint(0x9e3779b9))).sub(0.5).toVar();
      const q = vec3(
        u.panelCentre.x.add(r1.mul(2).mul(u.panelHalf.x)),
        u.panelCentre.y,
        u.panelCentre.z.add(r2.mul(2).mul(u.panelHalf.y)),
      ).toVar();
      const wv = q.sub(p).toVar();
      const d2 = dot(wv, wv).max(1e-4).toVar();
      const d = sqrt(d2).toVar();
      const wd = wv.div(d).toVar();
      const cosX = dot(n, wd).max(0).toVar();
      // The panel faces −Y, so its own cosine toward `p` is `wd.y`.
      const cosP = wd.y.max(0).toVar();
      If(cosX.mul(cosP).greaterThan(1e-5), () => {
        // Stop short of the panel's own VOXEL, not of the panel: at v0 the
        // emitter's cell reaches below its surface, and a shadow ray run to the
        // full distance is occluded by the very light it is sampling.
        const vis = float(1).sub(traceWindow(p, wd, d.sub(float(v0 * 1.5)).max(0.05), n).hit).toVar();
        E.addAssign(u.panelRadiance.mul(cosX).mul(cosP).mul(u.panelArea).div(d2).mul(vis));
      });
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
  const screenSegment = (p0, dir, outHit, outRad, outDist, outHandoff, laneU) => {
    const c0 = u.viewProj.mul(vec4(p0, 1)).toVar();
    const c1 = u.viewProj.mul(vec4(p0.add(dir.mul(RAY_MAX)), 1)).toVar();
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
        return select(dz.abs().lessThan(1e-3), kk, zk.sub(c0.w).div(dz)).clamp(0, 1).mul(RAY_MAX);
      };
      const pixLen = vec2(duv.x.mul(u.widthF), duv.y.mul(u.heightF)).length().max(1e-4).toVar();
      // Start two full-res texels along, so the first cell is never the probe's
      // own pixel.
      const k = min(float(2).div(pixLen), float(0.25)).toVar();
      const kPrev = k.toVar();
      const mip = float(0).toVar();

      Loop({ start: 0, end: HZB_STEPS, name: "hzbWalk" }, () => {
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
          kPrev.assign(k);
          k.assign(kNext);
          mip.assign(min(mip.add(1), float(HZB_MIPS - 1)));
          If(kNext.greaterThanEqual(0.9999), () => { Break(); });
        });
      });

      If(outHit.lessThan(0.5), () => {
        outHandoff.assign(worldT(kPrev));
        If(outHandoff.greaterThan(0.01), () => { bump(STATS.handoffs, laneU); });
      });
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

    // ── segment 1: the screen ──────────────────────────────────────────────
    const sHit = float(0).toVar();
    const sRad = vec3(0).toVar();
    const sDist = float(RAY_MAX).toVar();
    const handoff = float(0).toVar();
    If(u.hzbOn.greaterThan(0.5), () => {
      screenSegment(pos.add(nrm.mul(v0 * 0.5)), dir, sHit, sRad, sDist, handoff, xr);
    });

    // ── segment 2: the window, then the cache ──────────────────────────────
    const rad = vec3(0).toVar();
    const hitDist = float(RAY_MAX).toVar();
    If(sHit.greaterThan(0.5), () => {
      rad.assign(sRad);
      hitDist.assign(sDist);
    }).Else(() => {
      const far = handoff.greaterThan(0.01).toVar();
      const o2 = pos.add(dir.mul(handoff)).add(dir.mul(select(far, float(0.01), float(0)))).toVar();
      // ⭐ THE NORMAL BIAS SURVIVES THE HAND-OFF. Dropping it for a "far"
      // origin looks obviously right and is the bug that made the 1 m sphere
      // read 0.08 against a reference of 1.43: the hand-off distance is
      // whatever the screen walk managed before it lost the ray, which for a
      // grazing ray is CENTIMETRES — so the window trace restarted on the
      // probe's own surface, inside its own voxel, and the analytic fill sets
      // all six face bits on a curved surface, so it hit itself at t ≈ 0 and
      // returned its own darkness. 45 % of rays take this path. K.4's bias is
      // half a LEVEL-0 CELL along the geometric normal; at any hand-off
      // distance that is a harmless lateral nudge, and at a short one it is
      // the only thing standing between the ray and its own surface.
      const bn = nrm.toVar();
      const r = traceWindow(o2, dir, float(RAY_MAX).sub(handoff), bn).raw.toVar();
      const zi = r.z.toUint().toVar();
      If(r.x.greaterThan(0.5), () => {
        const faceF = bitAnd(zi, uint(7)).toFloat().toVar();
        const levelF = bitAnd(shiftRight(zi, uint(3)), uint(7)).toFloat().toVar();
        const voxF = shiftRight(zi, uint(6)).toFloat().toVar();
        const hn = normalOfFace(faceF).toVar();
        const hp = o2.add(bn.mul(v0 * 0.5)).add(dir.mul(r.y)).toVar();
        const c = cache.cacheRead(levelF, voxF, faceF).toVar();
        If(c.w.greaterThan(0.5), () => {
          rad.assign(c.xyz);
        }).Else(() => {
          const s = shadeHit(hp, hn, levelF, voxF, seedBase.add(uint(1013))).toVar();
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
        hitDist.assign(handoff.add(r.y));
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
    const alpha = float(1).div(min(nPrev.add(1), float(H))).toVar();
    const lNew = dot(rad, vec3(0.2126, 0.7152, 0.0722)).toVar();
    const lOld = dot(old.xyz, vec3(0.2126, 0.7152, 0.0722)).toVar();
    // GI-1.0's biased hysteresis: a large radiance change drops most of the
    // history at once rather than crawling toward the new value over H frames.
    const big = nPrev.greaterThan(0.5)
      .and(lNew.sub(lOld).abs().greaterThan(max(lNew, lOld).mul(0.5))).toVar();
    If(big, () => { bump(STATS.alphaForced, xr); });
    const a = select(big, float(0.5), alpha).toVar();
    const nNext = min(nPrev.add(1), float(H)).toVar();
    probeOct.element(addr).assign(vec4(
      mix(old.xyz, rad, a),
      nNext.mul(1024).add(min(hitDist, float(1023))),
    ));
  })().compute(dispatch2d(probeW * R, probeH), WG);

  // ══════════════════════════════════════════════ SHADER: probeFilter (§L.4)
  const probeFilterPass = Fn(() => {
    const tx = globalId.x.toVar();
    const ty = globalId.y.toVar();
    If(tx.greaterThanEqual(u.probeWU).or(ty.greaterThanEqual(u.probeHU)), () => { Return(); });
    const probe = ty.mul(u.probeWU).add(tx).toVar();
    const ma = probeMeta.element(metaIdx(u.curBase, probe, 0)).toVar();
    const mb = probeMeta.element(metaIdx(u.curBase, probe, 1)).toVar();
    const pos = ma.xyz.toVar();
    const nrm = mb.xyz.toVar();

    // The 3×3 weights are PER PROBE, not per texel — hoisting them out of the
    // 64-texel loop turns 576 weight evaluations into 9. Unrolled in JS so the
    // neighbour offsets are compile-time and no runtime `%` is needed.
    const nbIdx = [];
    const nbW = [];
    let centreSlot = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) centreSlot = nbIdx.length;
        const nx = tx.toInt().add(int(ox)).toVar();
        const ny = ty.toInt().add(int(oy)).toVar();
        const inB = nx.greaterThanEqual(int(0)).and(ny.greaterThanEqual(int(0)))
          .and(nx.lessThan(u.probeWU.toInt())).and(ny.lessThan(u.probeHU.toInt())).toVar();
        const np = ny.clamp(int(0), u.probeHU.toInt().sub(int(1))).toUint()
          .mul(u.probeWU).add(nx.clamp(int(0), u.probeWU.toInt().sub(int(1))).toUint()).toVar();
        const na = probeMeta.element(metaIdx(u.curBase, np, 0)).toVar();
        const nn = probeMeta.element(metaIdx(u.curBase, np, 1)).toVar();
        // Plane distance in units of a level-0 CELL — the scene's own length,
        // not a metric constant — and a normal agreement raised to the fourth
        // so a probe round a corner contributes nothing.
        const wp = exp(dot(nrm, na.xyz.sub(pos)).abs().div(v0).negate()).toVar();
        const wn = dot(nrm, nn.xyz).max(0).toVar();
        const w = select(
          inB.and(na.w.greaterThan(0.5)).and(ma.w.greaterThan(0.5)),
          wp.mul(wn.mul(wn).mul(wn).mul(wn)), float(0),
        ).toVar();
        nbIdx.push(np);
        nbW.push(w);
      }
    }

    Loop({ start: 0, end: OCT, name: "ft" }, ({ ft }) => {
      const t = uint(ft).toVar();
      const acc = vec3(0).toVar();
      const wsum = float(0).toVar();
      const centreA = float(0).toVar();
      for (let j = 0; j < 9; j++) {
        const tv = probeOct.element(octIdx(u.curBase, nbIdx[j], t)).toVar();
        // §L.4: texels nothing has sampled (n = 0) are skipped, not averaged in
        // as black — that is the difference between a filter and a fade.
        const ww = select(tv.w.greaterThanEqual(1024), nbW[j], float(0)).toVar();
        acc.addAssign(tv.xyz.mul(ww));
        wsum.addAssign(ww);
        if (j === centreSlot) centreA.assign(tv.w);
      }
      probeFiltered.element(probe.mul(uint(OCT)).add(t)).assign(vec4(
        select(wsum.greaterThan(1e-5), acc.div(wsum.max(1e-5)), vec3(0)), centreA,
      ));
    });

    // ── the 2×2 oct mip (§L.5's roughness cone) ────────────────────────────
    Loop({ start: 0, end: MIP_TEXELS, name: "mp" }, ({ mp }) => {
      const mi = uint(mp).toVar();
      const mx = bitAnd(mi, uint(MIP_RES - 1)).toVar();
      const my = shiftRight(mi, uint(Math.log2(MIP_RES))).toVar();
      const s = vec3(0).toVar();
      Loop({ start: 0, end: 4, name: "mq" }, ({ mq }) => {
        const qx = mx.mul(uint(2)).add(bitAnd(uint(mq), uint(1))).toVar();
        const qy = my.mul(uint(2)).add(shiftRight(uint(mq), uint(1))).toVar();
        s.addAssign(probeFiltered.element(probe.mul(uint(OCT)).add(qy.mul(uint(O))).add(qx)).xyz);
      });
      probeFiltered.element(uint(MIP_BASE).add(probe.mul(uint(MIP_TEXELS))).add(mi))
        .assign(vec4(s.mul(0.25), 0));
    });

    // ── SH2 projection (§L.5's phone path) ─────────────────────────────────
    const sh = [];
    for (let i = 0; i < 9; i++) sh.push(vec3(0).toVar());
    Loop({ start: 0, end: OCT, name: "sp" }, ({ sp }) => {
      const t = uint(sp).toVar();
      const e = octU.element(t).toVar();
      const d = e.xyz.toVar();
      const c = probeFiltered.element(probe.mul(uint(OCT)).add(t)).xyz.mul(e.w).toVar();
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
    for (let i = 0; i < 9; i++) probeSh.element(shIdx(probe, i)).assign(vec4(sh[i], 0));
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
        E.addAssign(probeFiltered.element(probe.mul(uint(OCT)).add(t)).xyz.mul(c).mul(e.w));
      });
    });
    return E;
  };
  const irradianceFromSh = (probe, n) => {
    const c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
    const L = [];
    for (let i = 0; i < 9; i++) L.push(probeSh.element(shIdx(probe, i)).xyz.toVar());
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
  /** Bilinear tap of a probe's filtered oct map (or its 2×2 mip) along `d`. */
  const octSample = (probe, d, useMip) => {
    const res = useMip ? MIP_RES : O;
    const base = useMip ? uint(MIP_BASE).add(probe.mul(uint(MIP_TEXELS))) : probe.mul(uint(OCT));
    const uvc = octahedralUV(d, res);
    const fu = uvc.u.sub(0.5).toVar();
    const fv = uvc.v.sub(0.5).toVar();
    const iu = fu.floor().toVar();
    const iv = fv.floor().toVar();
    const au = fu.sub(iu).toVar();
    const av = fv.sub(iv).toVar();
    const tap = (ox, oy) => probeFiltered.element(
      base.add(iv.add(oy).clamp(0, res - 1).toUint().mul(uint(res)))
        .add(iu.add(ox).clamp(0, res - 1).toUint()),
    ).xyz;
    return mix(mix(tap(0, 0), tap(1, 0), au), mix(tap(0, 1), tap(1, 1), au), av);
  };

  const resolvePass = Fn(() => {
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
      const V = normalize(P.sub(u.camPos)).toVar();
      const Rr = normalize(V.sub(Nn.mul(dot(V, Nn).mul(2)))).toVar();

      const tfx = px.toFloat().add(0.5).div(T).sub(0.5).toVar();
      const tfy = py.toFloat().add(0.5).div(T).sub(0.5).toVar();
      const bx = tfx.floor().toVar();
      const by = tfy.floor().toVar();
      const fx = tfx.sub(bx).toVar();
      const fy = tfy.sub(by).toVar();

      const wsum = float(0).toVar();
      const best = float(-1).toVar();
      const bestW = float(-1).toVar();
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
          E.addAssign((USE_SH ? irradianceFromSh(pi, Nn) : irradianceFromOct(pi, Nn)).mul(w));
          G.addAssign(mix(octSample(pi, Rr, false), octSample(pi, Rr, true), u.roughness).mul(w));
          wsum.addAssign(w);
        });
      }
      If(wsum.greaterThan(1e-5), () => {
        E.assign(E.div(wsum));
        G.assign(G.div(wsum));
      }).Else(() => {
        // §L.5's fallback: the nearest VALID probe, unweighted, rather than a
        // black pixel. A pixel whose four corners all fail the plane test sits
        // on a silhouette, and black there reads as a hard outline.
        If(best.greaterThanEqual(0), () => {
          const pi = best.toUint().toVar();
          E.assign(USE_SH ? irradianceFromSh(pi, Nn) : irradianceFromOct(pi, Nn));
          G.assign(mix(octSample(pi, Rr, false), octSample(pi, Rr, true), u.roughness));
        });
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
      // Half a cell INTO the surface: a pixel sits ON the boundary and would
      // otherwise address the empty voxel in front of it half the time.
      const pIn = g.xyz.sub(Nn.mul(v0 * 0.5)).toVar();
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
    width, height, probeW, probeH, probeCount,
    hzbMips: HZB_MIPS, hzbSteps: HZB_STEPS, cropBlock: CROP_HALF * 2 + 1,
    bytes: {
      probeMeta: 2 * probeCount * META_VEC * 16,
      probeOct: 2 * probeCount * OCT * 16,
      probeFiltered: (probeCount * OCT + probeCount * MIP_TEXELS) * 16,
      probeSh: probeCount * 9 * 16,
      hzb: hzbWords * 4,
      litBuf: width * height * 16,
      textures: 3 * width * height * 8,
    },
  });

  return {
    tier, T, R, O, H, STRIDE, USE_SH, probeW, probeH, probeCount, width, height,
    uniforms: u, palette, setPalette, beginFrame, get frame() { return frame; },
    buffers: { probeMeta, probeOct, probeFiltered, probeSh, hzb, statsBuf, cropIn, cropOut, litBuf },
    textures: { irradiance, glossy, lit },
    passes: {
      hzbBuild: hzbBuildPass,
      hzbReduce: hzbReducePasses,
      probePlace: probePlacePass,
      probeTrace: probeTracePass,
      probeFilter: probeFilterPass,
      resolve: resolvePass,
      composite: compositePass,
      inject: injectPass,
      crop: cropPass,
      clearProbes: clearProbesPass,
      clearMeta: clearMetaPass,
      clearStats: clearStatsPass,
    },
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
    },
  };
}
