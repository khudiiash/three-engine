// SPLIT RADIANCE CASCADES — THE SKY, INTEGRATED PER BIN.
//
// §16 S1 gave every escaping bin the environment "at its own direction":
// the merge's top-cascade close and the tile bake's orphan composite each
// take ONE bilinear tap of the equirect at the bin's centre, level 0. That
// is a point sample standing in for the mean radiance of a bin that spans
// 4.5° (c3) to 36° (c0) of sky, and on a real HDRI it is not an estimator
// of anything: the sun is a few texels wide with a radiance five orders of
// magnitude above the sky around it, and no bin centre lands on it.
//
// Measured on the user's Level (2026-09-05, "Belfast Farmhouse_2k.hdr"):
// the up-facing irradiance of that map is 4.39, of which 3.70 — 84 % — is
// the sun (peak radiance 179 830, elevation 21.7°). The point sample keeps
// the 16 % and deletes the sun. The path tracer importance-samples the same
// map and gets all of it, which is most of the "our GI has a lot less light
// bounce" gap on a level lit through openings.
//
// THE FIX IS EXACT AND CHEAP: integrate the equirect ONCE on the CPU into
// the bin grid the kernels already index (`binDirTable`'s Morton order),
// one mean radiance per bin, and let the two composite sites read the table
// instead of tapping the texture. Every texel lands in exactly one bin with
// its own solid angle, so the sun's energy is preserved and spread over the
// bin that contains it — a 4.5° sun at c3, a 36° one on the c0 orphan path.
// Softer than the tracer's disc, but the energy is right, which is what the
// tracer comparison was missing; the angular sharpness is a separate unit.
//
// The texture tap stays as the fallback, selected on the GPU by a per-table
// `ready` uniform: a source the CPU cannot read (an image-backed equirect,
// a compressed map) keeps today's behaviour bit for bit, and so does every
// gate fixture, none of which passes `tables`.
//
// §11.53 — THE SUN IS NOT SKY (2026-09-05, Bistro, "when sky lighting is
// on we get wrong lighting all over the scene"). The exact table put the
// HDRI's sun INTO the diffuse sky term, and that is the one place it cannot
// go: a 1.6°-wide spot holding 76 % of the map's up-facing irradiance (this
// file's map, as the half-float texture the scene loads) rides a 4.5°–36°
// bin as "mean radiance × transmittance", and the transmittance of that one
// bin is a few rays per probe — so every facade facing the spot lit up in
// shadowless blotches at probe spacing, 5–9× the rest of the sky on that
// facade, beside the scene's REAL sun (a directional light at another
// elevation, with a shadow map). A sun is a delta light; the sky term
// carries the sky. So the integration finds the map's sun — the radiance
// above 8× the solid-angle-weighted p99.9 luma, a ceiling that takes 84 % /
// 77 % of this project's two sunny maps and under 0.4 % of its sunset and
// night maps — and leaves it OUT of the tables when it holds ≥ 2 % of the
// up-facing irradiance, reporting where it was (direction, width, share)
// so the scene's directional light can be aimed to stand in for it. The
// visible sky (env-on-miss, the background) is untouched — a mirror still
// shows the disc. `__giSkySunExtract = false` keeps the sun in the bins.
//
// No `three` import on purpose: the integrator is pure arithmetic over a
// data descriptor, so `npm run test:gi-sky-bins` runs it under bare Node.

import { instancedArray, uniform } from "three/tsl";
import { FloatType, HalfFloatType, RGBFormat } from "three/webgpu";
import { W0 } from "./srcConfig.js";
import { binDir, binMorton, binUnmorton } from "./srcMath.js";

/**
 * The CPU-readable view of an equirect texture, or null when there is none
 * to read: a `DataTexture` with float or half-float texels (RGBE/EXR loads,
 * the engine's 1×1 flat-colour sky) qualifies; an image-backed or compressed
 * map does not and keeps the kernels' texture tap.
 *
 * @returns {SkySource|null}
 */
export function describeSkySource(texture) {
  const image = texture?.image;
  const data = image?.data;
  if (!texture?.isTexture || !data || !(image.width > 0) || !(image.height > 0)) return null;
  const half = texture.type === HalfFloatType;
  const isFloat = texture.type === FloatType;
  if (half && !(data instanceof Uint16Array)) return null;
  if (isFloat && !(data instanceof Float32Array)) return null;
  if (!half && !isFloat) return null;
  return {
    data,
    width: image.width,
    height: image.height,
    channels: texture.format === RGBFormat ? 3 : 4,
    half,
    flipY: texture.flipY === true,
  };
}

/** Half-float → float32, as a 65536-entry table built on first use. */
let halfLut = null;
function halfToFloatLut() {
  if (halfLut) return halfLut;
  const lut = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    let v;
    if (e === 0) v = s * m * 2 ** -24;                 // subnormal / zero
    else if (e === 31) v = m ? NaN : s * Infinity;     // inf / nan
    else v = s * (1 + m / 1024) * 2 ** (e - 15);
    lut[h] = v;
  }
  halfLut = lut;
  return lut;
}

/** §11.53 — the rank and factor of the sun ceiling: radiance above `factor × p(percentile)` is the sun. */
export const SUN_CEILING_PERCENTILE = 0.999;
export const SUN_CEILING_FACTOR = 8;
/** A sun is declared — and extracted — only when its excess holds this share of the up-facing irradiance. */
export const SUN_MIN_SHARE = 0.02;

/**
 * The luma ceiling that separates a sun from the sky it sits in: `factor ×`
 * the solid-angle-weighted `percentile` of the map's texel luminance. Rank-
 * based on purpose — the MEAN of a sunny map is 84 % sun and says nothing,
 * while its p99.9 is the brightest cloud, which a sun clears by two to five
 * orders of magnitude. Read over every `stride`-th row and column through a
 * log histogram — a percentile needs no more: on a 2k map strides 1, 2 and 4
 * return the same ceiling to three digits, at 59 / 12 / 3 ms.
 *
 * @param {SkySource} src
 * @returns {{ ceiling: number, percentileLuma: number }}  `Infinity` / 0
 *   for a source with nothing to read
 */
export function skyLumaCeiling(src, { percentile = SUN_CEILING_PERCENTILE, factor = SUN_CEILING_FACTOR, stride = 4 } = {}) {
  const { data, width, height } = src;
  const channels = src.channels === 3 ? 3 : 4;
  if (!data || !(width > 0) || !(height > 0) || data.length < width * height * channels) {
    return { ceiling: Infinity, percentileLuma: 0 };
  }
  const lut = src.half ? halfToFloatLut() : null;
  const NB = 2048;
  const LO = -6;   // log10 range 1e-6 … 1e7 — below it is black, above it is clipped
  const HI = 7;
  const hist = new Float64Array(NB);
  let total = 0;
  const s = Math.max(1, Math.floor(stride));
  for (let r = 0; r < height; r += s) {
    // A rank does not care which way the rows run; the weight is the row's cos(el) either way.
    const el = ((r + 0.5) / height - 0.5) * Math.PI;
    const dw = Math.max(0, Math.cos(el));
    const rowBase = r * width;
    for (let x = 0; x < width; x += s) {
      const o = (rowBase + x) * channels;
      let r0, g0, b0;
      if (lut) { r0 = lut[data[o]]; g0 = lut[data[o + 1]]; b0 = lut[data[o + 2]]; }
      else { r0 = data[o]; g0 = data[o + 1]; b0 = data[o + 2]; }
      const l = 0.2126 * (r0 > 0 ? r0 : 0) + 0.7152 * (g0 > 0 ? g0 : 0) + 0.0722 * (b0 > 0 ? b0 : 0);
      const v = l > 1e-6 ? (l < 1e7 ? l : 1e7) : 1e-6;
      const b = Math.min(NB - 1, Math.max(0, Math.floor(((Math.log10(v) - LO) / (HI - LO)) * NB)));
      hist[b] += dw;
      total += dw;
    }
  }
  if (!(total > 0)) return { ceiling: Infinity, percentileLuma: 0 };
  let acc = 0;
  let p = 1e7;
  for (let b = 0; b < NB; b++) {
    acc += hist[b];
    // The bin's UPPER edge: a uniform map's own value never exceeds its percentile.
    if (acc >= percentile * total) { p = 10 ** (LO + ((b + 1) / NB) * (HI - LO)); break; }
  }
  return { ceiling: factor * p, percentileLuma: p };
}

/**
 * @typedef {object} SkySource
 * @property {ArrayLike<number>} data   texel data, row-major, `channels` per texel
 * @property {number} width
 * @property {number} height
 * @property {number} channels           3 or 4
 * @property {boolean} [half]            data is IEEE half (Uint16Array)
 * @property {boolean} [flipY]           three's `texture.flipY` — true means
 *   row 0 of `data` is the TOP of the panorama as the GPU samples it
 */

/**
 * Integrate an equirect into the 2w×w bin grid, in STORAGE (Morton) order.
 *
 * Returns raw sums so widths can be aggregated exactly (see `aggregateBins`):
 *   `sum[m*3..]` = Σ radiance·Δω over the texels in bin m — the WHOLE map,
 *                  sun included (`binMeanTable` decides what a table keeps),
 *   `omega[m]`   = Σ Δω (≈ 4π / (2w²) — equal-area bins),
 *   `eUp`        = Σ luma·Δω·max(0, y): the map's up-facing irradiance,
 *   `sun`        = §11.53, the part above `ceiling`: per-bin excess sums
 *                  (`sun.sum`) and solid angle (`sun.binOmega`), its energy,
 *                  its up-facing irradiance `eUp`, its texel count, and the
 *                  energy-weighted direction of the excess in the WORLD
 *                  frame (the yaw undone — where the scene sees it).
 *
 * Direction convention is three's `equirectUV` exactly: u = atan2(z, x)/2π +
 * ½, v = asin(y)/π + ½, sampled by the kernels at `rd = R(yaw)·d` for bin
 * direction d, so a texel at direction t belongs to the bin of `R(yaw)⁻¹·t`.
 * `yaw` is the value the kernels' `rotY` uniform carries (already the lookup
 * yaw, i.e. `giEnvironmentLookupYaw` of the authored rotation).
 *
 * @param {SkySource} src
 * @param {object} [options]
 * @param {number} [options.yaw=0]
 * @param {number} [options.w=W0]
 * @param {number} [options.maxColumns=512]  texels are pre-summed in
 *   square blocks so the bin lookup runs on at most this many columns; the
 *   sums are exact, only a block straddling a bin border lands whole in the
 *   bin of its centre (a 0.7° block against 4.5°+ bins).
 * @param {number} [options.ceiling=Infinity]  luma above which a texel's
 *   excess (its chroma kept) is booked to `sun` beside the sky — see
 *   `skyLumaCeiling`; Infinity books nothing.
 */
export function integrateEquirectBins(src, { yaw = 0, w = W0, maxColumns = 512, ceiling = Infinity } = {}) {
  const { data, width, height } = src;
  const channels = src.channels === 3 ? 3 : 4;
  const nBins = 2 * w * w;
  const sum = new Float64Array(nBins * 3);
  const omega = new Float64Array(nBins);
  const sunSum = new Float64Array(nBins * 3);
  const sunOmega = new Float64Array(nBins);
  const sun = { ceiling, energy: 0, eUp: 0, omega: 0, texels: 0, dir: [0, 0, 0] };
  let eUp = 0;
  const pack = () => ({
    sum: Float32Array.from(sum),
    omega: Float32Array.from(omega),
    w,
    eUp,
    sun: { ...sun, sum: Float32Array.from(sunSum), binOmega: Float32Array.from(sunOmega) },
  });
  if (!data || !(width > 0) || !(height > 0) || data.length < width * height * channels) return pack();
  const lut = src.half ? halfToFloatLut() : null;
  const bs = Math.max(1, Math.floor(width / maxColumns));
  const cr = Math.cos(yaw);
  const sr = Math.sin(yaw);
  const dPhi = (2 * Math.PI) / width;
  const dTheta = Math.PI / height;
  const flipY = src.flipY === true;
  // Per-row solid angle in GPU row space (row 0 = v ≈ 0 = nadir).
  const rowOmega = new Float64Array(height);
  for (let r = 0; r < height; r++) {
    const el = ((r + 0.5) / height - 0.5) * Math.PI;
    rowOmega[r] = dPhi * dTheta * Math.max(0, Math.cos(el));
  }
  // Block-centre trig, once per block row/column rather than per block —
  // the first cut spent 270 ms on a 2k map in per-block cos/sin/atan2 and
  // two object allocations; this loop allocates nothing.
  const nbx = Math.ceil(width / bs);
  const nby = Math.ceil(height / bs);
  const cosEl = new Float64Array(nby);
  const sinEl = new Float64Array(nby);
  for (let b = 0; b < nby; b++) {
    const y0 = b * bs;
    const y1 = Math.min(height, y0 + bs);
    const el = ((y0 + y1) / 2 / height - 0.5) * Math.PI;
    cosEl[b] = Math.cos(el);
    sinEl[b] = Math.sin(el);
  }
  const cosAz = new Float64Array(nbx);
  const sinAz = new Float64Array(nbx);
  for (let b = 0; b < nbx; b++) {
    const x0 = b * bs;
    const x1 = Math.min(width, x0 + bs);
    const az = ((x0 + x1) / 2 / width - 0.5) * 2 * Math.PI;
    cosAz[b] = Math.cos(az);
    sinAz[b] = Math.sin(az);
  }
  const twoW = 2 * w;
  const invTwoPi = 1 / (2 * Math.PI);
  const clamp = ceiling < Infinity;
  let sx = 0, sy = 0, sz = 0;   // the excess's energy-weighted direction
  for (let by = 0, bRow = 0; by < height; by += bs, bRow++) {
    const yEnd = Math.min(height, by + bs);
    const ce = cosEl[bRow];
    const ty = sinEl[bRow];
    const upW = ty > 0 ? ty : 0;
    for (let bx = 0, bCol = 0; bx < width; bx += bs, bCol++) {
      const xEnd = Math.min(width, bx + bs);
      let ar = 0, ag = 0, ab = 0, om = 0;
      let xr = 0, xg = 0, xb = 0, xl = 0, xom = 0, xn = 0;
      for (let gy = by; gy < yEnd; gy++) {
        // GPU row gy ← file row (flipY ? height-1-gy : gy)
        const rowBase = (flipY ? height - 1 - gy : gy) * width;
        const dw = rowOmega[gy];
        let o = (rowBase + bx) * channels;
        for (let gx = bx; gx < xEnd; gx++, o += channels) {
          let r0, g0, b0;
          if (lut) { r0 = lut[data[o]]; g0 = lut[data[o + 1]]; b0 = lut[data[o + 2]]; }
          else { r0 = data[o]; g0 = data[o + 1]; b0 = data[o + 2]; }
          // A negative or non-finite texel (a bad RGBE run, a half inf) carries nothing.
          if (!(r0 > 0 && r0 < Infinity)) r0 = 0;
          if (!(g0 > 0 && g0 < Infinity)) g0 = 0;
          if (!(b0 > 0 && b0 < Infinity)) b0 = 0;
          if (clamp) {
            const l = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
            if (l > ceiling) {
              // §11.53: the excess above the ceiling is the sun — same chroma, booked apart.
              const f = (1 - ceiling / l) * dw;
              xr += r0 * f; xg += g0 * f; xb += b0 * f;
              xl += (l - ceiling) * dw;
              xom += dw;
              xn++;
            }
          }
          ar += r0 * dw; ag += g0 * dw; ab += b0 * dw;
          om += dw;
        }
      }
      if (om <= 0) continue;
      // three's equirectUV inverse: x = cos(el)·cos(az), y = sin(el), z = cos(el)·sin(az)
      const tx = ce * cosAz[bCol];
      const tz = ce * sinAz[bCol];
      // Undo the kernels' rotation rd = (d.x·cr + d.z·sr, d.y, d.z·cr − d.x·sr).
      const dx = tx * cr - tz * sr;
      const dz = tx * sr + tz * cr;
      // `dirToBin` / `encodeDir` inlined (srcMath.js): the bin grid is
      // parameterised around +Z, phi about it from +X.
      let phi = Math.atan2(ty, dx);
      if (phi < 0) phi += 2 * Math.PI;
      let x = phi * invTwoPi;
      if (x >= 1) x -= 1;
      const yy = Math.min(0.9999999999, Math.max(0, (dz + 1) * 0.5));
      const i = Math.min(twoW - 1, Math.max(0, Math.floor(x * twoW)));
      const j = Math.min(w - 1, Math.max(0, Math.floor(yy * w)));
      const m = binMorton(i, j);
      sum[m * 3] += ar;
      sum[m * 3 + 1] += ag;
      sum[m * 3 + 2] += ab;
      omega[m] += om;
      eUp += (0.2126 * ar + 0.7152 * ag + 0.0722 * ab) * upW;
      if (xom > 0) {
        sunSum[m * 3] += xr;
        sunSum[m * 3 + 1] += xg;
        sunSum[m * 3 + 2] += xb;
        sunOmega[m] += xom;
        sun.energy += xl;
        sun.eUp += xl * upW;
        sun.omega += xom;
        sun.texels += xn;
        sx += xl * dx; sy += xl * ty; sz += xl * dz;
      }
    }
  }
  const n = Math.hypot(sx, sy, sz);
  if (n > 0) sun.dir = [sx / n, sy / n, sz / n];
  return pack();
}

/**
 * Exact aggregation of a fine bin grid onto a coarser one (`fine.w` must be
 * a multiple of `w`): a coarse cell on the 2w×w grid is exactly a k×k block
 * of fine cells, k = fine.w / w, so sums add with no resampling. The sun's
 * per-bin sums ride along the same way; its scalars are the map's.
 */
export function aggregateBins(fine, w) {
  const k = fine.w / w;
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`aggregateBins: fine width ${fine.w} is not a multiple of ${w}`);
  }
  const nBins = 2 * w * w;
  const sum = new Float32Array(nBins * 3);
  const omega = new Float32Array(nBins);
  const fs = fine.sun;
  const sunSum = fs ? new Float32Array(nBins * 3) : null;
  const sunOmega = fs ? new Float32Array(nBins) : null;
  const nFine = 2 * fine.w * fine.w;
  for (let mf = 0; mf < nFine; mf++) {
    const { i, j } = binUnmorton(mf);
    const m = binMorton(Math.floor(i / k), Math.floor(j / k));
    sum[m * 3] += fine.sum[mf * 3];
    sum[m * 3 + 1] += fine.sum[mf * 3 + 1];
    sum[m * 3 + 2] += fine.sum[mf * 3 + 2];
    omega[m] += fine.omega[mf];
    if (fs) {
      sunSum[m * 3] += fs.sum[mf * 3];
      sunSum[m * 3 + 1] += fs.sum[mf * 3 + 1];
      sunSum[m * 3 + 2] += fs.sum[mf * 3 + 2];
      sunOmega[m] += fs.binOmega[mf];
    }
  }
  return { sum, omega, w, eUp: fine.eUp, sun: fs ? { ...fs, sum: sunSum, binOmega: sunOmega } : undefined };
}

/**
 * Mean radiance per bin as the vec4 table the kernels read: rgb = Σ L·Δω /
 * Σ Δω, w = 1 for a bin that received texels (0 = empty, which only a
 * degenerate source can produce — every bin of a ≥ 2w×w map is covered).
 *
 * `sun: "extract"` (§11.53) leaves the part above the integration's ceiling
 * out. The bin keeps its full solid angle, so a clamped texel reads as the
 * ceiling, not as a hole; `"keep"` (the default) is the whole map.
 */
export function binMeanTable(bins, out = null, { sun = "keep" } = {}) {
  const nBins = 2 * bins.w * bins.w;
  const table = out ?? new Float32Array(nBins * 4);
  const xs = sun === "extract" ? bins.sun?.sum ?? null : null;
  for (let m = 0; m < nBins; m++) {
    const om = bins.omega[m];
    const inv = om > 0 ? 1 / om : 0;
    let r = bins.sum[m * 3];
    let g = bins.sum[m * 3 + 1];
    let b = bins.sum[m * 3 + 2];
    if (xs) {
      r = Math.max(0, r - xs[m * 3]);
      g = Math.max(0, g - xs[m * 3 + 1]);
      b = Math.max(0, b - xs[m * 3 + 2]);
    }
    table[m * 4] = r * inv;
    table[m * 4 + 1] = g * inv;
    table[m * 4 + 2] = b * inv;
    table[m * 4 + 3] = om > 0 ? 1 : 0;
  }
  return table;
}

/** Bin centre for a storage index — the direction the kernels' LUT holds. */
export function binCentreOf(m, w) {
  const { i, j } = binUnmorton(m);
  return binDir(i, j, w);
}

/**
 * What the integration booked above its ceiling (§11.53), as the receipt
 * the boot log prints and the manager decides on: the excess's share of the
 * map's up-facing irradiance, its direction (world frame, TOWARD the sun —
 * elevation and azimuth on three's equirect convention, x = cos el·cos az,
 * y = sin el, z = cos el·sin az) and the angular radius of the texels above
 * the ceiling. `present` is the share against `SUN_MIN_SHARE`.
 */
export function describeSun(bins) {
  const s = bins?.sun;
  const none = {
    present: false, share: 0, upIrradiance: 0, energy: 0, ceiling: s?.ceiling ?? Infinity,
    dir: [0, 0, 0], elevationDeg: 0, azimuthDeg: 0, radiusDeg: 0, omega: 0, texels: 0,
  };
  if (!s || !(s.energy > 0)) return none;
  const share = bins.eUp > 0 ? s.eUp / bins.eUp : 0;
  const [x, y, z] = s.dir;
  return {
    present: share >= SUN_MIN_SHARE,
    share,
    upIrradiance: s.eUp,
    energy: s.energy,
    ceiling: s.ceiling,
    dir: s.dir,
    elevationDeg: (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI,
    azimuthDeg: (Math.atan2(z, x) * 180) / Math.PI,
    radiusDeg: (Math.sqrt(s.omega / Math.PI) * 180) / Math.PI,
    omega: s.omega,
    texels: s.texels,
  };
}

/**
 * The GPU side: one `instancedArray` of vec4 per bin width PER BUILD.
 *
 * ⚠ PER BUILD, NOT PERSISTENT — and this is the trap the first cut fell
 * into twice. A GI teardown retires EVERY storage attribute the stale state
 * bound or published ("nothing survives a teardown" — GISystem's dispose,
 * releaseCompute.js): an attribute shared with the next build is destroyed
 * a few frames after the swap while the new kernels still bind it
 * (`[Buffer] used in submit while destroyed` on exactly the sky-reading
 * kernels; before the list was published, `Invalid BindGroup … previous
 * error` on the same three). So each `createSrcProbeSystem` takes its own
 * view via `beginBuild()`: fresh attributes, filled at once from the cached
 * integration, published through the view's `storageAttributes` so the
 * teardown that retires that build retires them too. The INTEGRATION is
 * what persists (one CPU pass per environment change, shared by every
 * build); the last two builds' tables are kept filled across the swap's
 * retire window and older ones are forgotten.
 *
 * Integration is throttled to one run per `minIntervalMs` — a rotating
 * environment changes the yaw every frame — and the last requested state
 * always wins.
 */
export function createSkyBinTables({ minIntervalMs = 150, maxColumns = 512, now = () => performance.now() } = {}) {
  const builds = [];          // [{ tables: Map<w, entry> }], newest last
  const KEEP_BUILDS = 2;
  let key = null;             // the (source, version, yaw, widths) the fills came from
  let lastRun = -Infinity;
  let pending = null;         // { src, yaw } waiting on the throttle
  let fine = null;            // the last integration at the largest width
  let fineKey = null;
  let runs = 0;
  let last = null;            // receipt of the last integration, for the boot log
  let generation = 0;
  // §11.53: what the tables carry — "extract" when the last integration
  // found a sun and extraction was armed by the caller, else "keep".
  let mode = "keep";
  let extractArmed = true;
  // The ceiling is a property of the TEXTURE (a rank over its texels), not of
  // the yaw — cached per (id, shape) so a rotating environment re-integrates
  // without re-ranking. An anonymous source (no id) is never cached.
  let ceilingCache = null;

  const allEntries = function* () {
    for (const build of builds) yield* build.tables.values();
  };
  const widths = () => {
    const set = new Set();
    for (const entry of allEntries()) set.add(entry.w);
    return [...set].sort((a, b) => a - b);
  };
  const wMax = () => {
    let m = W0;
    for (const entry of allEntries()) m = Math.max(m, entry.w);
    return m;
  };

  const fill = (entry) => {
    if (!fine || fine.w % entry.w !== 0) {
      entry.ready.value = 0;
      return;
    }
    const bins = fine.w === entry.w ? fine : aggregateBins(fine, entry.w);
    binMeanTable(bins, entry.array, { sun: mode });
    entry.node.value.needsUpdate = true;
    entry.ready.value = 1;
  };

  const integrate = (src, yaw, id = null) => {
    lastRun = now();
    runs++;
    if (!src) {
      fine = null;
      fineKey = null;
      last = null;
      mode = "keep";
      for (const entry of allEntries()) entry.ready.value = 0;
      return;
    }
    const t0 = now();
    // §11.53: the ceiling first (a rank over a strided sample), then the one
    // pass books everything above it beside the sky. The tables are filled
    // WITHOUT that part when it is a sun (≥ SUN_MIN_SHARE of the up-facing
    // irradiance) and extraction is armed; a sunless map is the whole map,
    // bit for bit.
    const cSig = id == null ? null : `${id}:${src.width}x${src.height}:${src.channels}:${src.half ? "h" : "f"}`;
    if (cSig == null || ceilingCache?.sig !== cSig) ceilingCache = { sig: cSig, ...skyLumaCeiling(src) };
    const { ceiling, percentileLuma } = ceilingCache;
    fine = integrateEquirectBins(src, { yaw, w: wMax(), maxColumns, ceiling });
    fineKey = key;
    const sun = describeSun(fine);
    mode = extractArmed && sun.present ? "extract" : "keep";
    for (const entry of allEntries()) fill(entry);
    // The brightest bin's mean luma OF THE TABLE IN USE and the sky's up-
    // facing irradiance — the numbers that say whether a sun was in the map,
    // whether it reached the bins, and what the sky term now carries.
    let peak = 0;
    const nBins = 2 * fine.w * fine.w;
    const xs = mode === "extract" ? fine.sun.sum : null;
    for (let m = 0; m < nBins; m++) {
      const om = fine.omega[m];
      if (om <= 0) continue;
      let r = fine.sum[m * 3];
      let g = fine.sum[m * 3 + 1];
      let b = fine.sum[m * 3 + 2];
      if (xs) { r -= xs[m * 3]; g -= xs[m * 3 + 1]; b -= xs[m * 3 + 2]; }
      peak = Math.max(peak, (0.2126 * r + 0.7152 * g + 0.0722 * b) / om);
    }
    last = {
      ms: now() - t0,
      width: src.width,
      height: src.height,
      half: !!src.half,
      widths: widths(),
      peakBinLuma: peak,
      // The whole map's up-facing irradiance, and what the tables carry.
      upIrradianceLuma: fine.eUp,
      skyUpIrradianceLuma: fine.eUp - (mode === "extract" ? fine.sun.eUp : 0),
      sun: { ...sun, extracted: mode === "extract", percentileLuma },
    };
  };

  const makeEntry = (w) => {
    const nBins = 2 * w * w;
    const node = instancedArray(new Float32Array(nBins * 4), "vec4");
    // Write through the attribute's OWN array (it keeps the view it was
    // handed today, but the upload path keys on the attribute, not on ours).
    const entry = { w, array: node.value.array, node, ready: uniform(0) };
    if (fine && fine.w % w === 0) fill(entry);
    else if (fine) key = null;   // a wider grid: re-integrate on the next update
    return entry;
  };

  const manager = {
    /**
     * A build's own view. Call once per `createSrcProbeSystem`; hand the
     * view to the kernels (as `skyEnv.tables`) and publish its
     * `storageAttributes` from that system's getter.
     */
    beginBuild() {
      const build = { id: ++generation, tables: new Map() };
      builds.push(build);
      while (builds.length > KEEP_BUILDS) builds.shift();
      return {
        id: build.id,
        tableFor(w) {
          let entry = build.tables.get(w);
          if (!entry) {
            entry = makeEntry(w);
            build.tables.set(w, entry);
          }
          return entry;
        },
        get storageAttributes() {
          return [...build.tables.values()].map((entry) => entry.node.value);
        },
      };
    },
    /**
     * @param {SkySource|null} src  null = unreadable/absent source → the
     *   kernels fall back to the texture tap
     * @param {number} yaw  the kernels' `rotY` uniform value
     * @param {string} [id]  identity of the source (uuid:version); omitted →
     *   an anonymous key, which re-integrates only on a size/yaw change
     * @param {object} [options]
     * @param {boolean} [options.extractSun=true]  §11.53 — leave a detected
     *   sun out of the tables (part of the key: flipping it re-integrates)
     */
    update(src, yaw, id = null, { extractSun = true } = {}) {
      const sig = src
        ? `${id ?? "anon"}:${src.width}x${src.height}:${src.channels}:${src.half ? "h" : "f"}:${src.flipY ? 1 : 0}:${(Number(yaw) || 0).toFixed(5)}:${extractSun === false ? "k" : "x"}:${widths().join(",")}`
        : `none:${widths().join(",")}`;
      if (sig === key && !pending) return false;
      if (now() - lastRun < minIntervalMs) {
        pending = { src, yaw, sig };
        return false;
      }
      key = sig;
      pending = null;
      extractArmed = extractSun !== false;
      integrate(src, Number(yaw) || 0, id);
      return true;
    },
    /** Receipt of the last integration (null after an unreadable source). */
    get last() { return last; },
    /** "extract" | "keep" — what the filled tables carry (§11.53). */
    get mode() { return mode; },
    /** Test/instrument hooks. */
    get runs() { return runs; },
    get key() { return key; },
    get fineKey() { return fineKey; },
    get builds() { return builds.length; },
    widths,
    dispose() {
      for (const entry of allEntries()) entry.node.value?.dispose?.();
      builds.length = 0;
      fine = null;
      key = null;
      ceilingCache = null;
    },
  };
  return manager;
}
