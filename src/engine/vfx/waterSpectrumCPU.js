/**
 * ══ THE SPECTRAL SEA, ON THE CPU — THE SPECIFICATION THE GPU FOLLOWS ═══════
 *
 * A wind sea is a spectrum, not a sum of a few sines. This file is the whole
 * model in plain JavaScript: the wavenumber grid, the JONSWAP/TMA spectrum with
 * a directional spread, the Gaussian realization `h0(k)`, its evolution in
 * time under the deep/shallow-water dispersion relation, the inverse FFT that
 * turns it back into DISPLACEMENT (x, y, z — horizontal as well as vertical,
 * which is what makes crests sharp and troughs broad), the slope DERIVATIVES
 * the normal is built from, and the JACOBIAN of the horizontal displacement —
 * the quantity that goes negative exactly where the surface folds over itself,
 * i.e. where foam is made.
 *
 * Ported formula for formula from Popov72/OceanDemo (Babylon, MIT):
 * `initialSpectrum.wgsl`, `timeDependentSpectrum.wgsl`, `wavesTexturesMerger.wgsl`
 * and `buoyancy.ts`. The GPU (`waterSpectrum.js`) runs the same arithmetic in
 * TSL; `scripts/water-spectrum-smoke.html` reads its textures back and diffs
 * them against this file, so the two can never quietly drift apart.
 *
 * ⚠ CONVENTIONS, because the GPU and this file must agree to the bit:
 *  · texel (i, j) of an N² map is wavenumber k = ((i, j) − N/2) · 2π/L;
 *  · the inverse transform is UNNORMALIZED with a POSITIVE exponent, followed
 *    by the (−1)^(x+y) sign that moves k = 0 to the centre of the grid — so a
 *    height comes out in metres straight from `h0`, with no 1/N² anywhere;
 *  · two real fields ride in one complex one (Dx + i·Dz etc.), which is why
 *    four complex maps carry eight real quantities and the pair unpacks after
 *    the transform.
 */
export const GRAVITY = 9.81;

/**
 * ══ SEA STATES — ONE SYSTEM, A POOL OR AN OCEAN ════════════════════════════
 *
 * "We don't do solely an ocean or solely a small smooth pool. We need to be
 * able to configure both" (user, 2026-09-06). Both ARE the same spectrum at
 * different settings, and these are the settings. A preset writes the wave
 * fields and nothing else; the fields stay editable, and editing one turns
 * the preset back to `custom`. `waveHeight: 0` is a perfectly smooth pool
 * with nothing but the interactive ripples on it.
 */
export const SEA_STATE_FIELDS = ["waveHeight", "waveLength", "choppiness", "rippleStrength", "waveOctaves", "waveGain", "waveSpeed",
  "surfaceDetail", "foam", "foamThreshold", "roughness", "color", "deepColor", "saturation", "transmission"];
export const SEA_STATES = Object.freeze({
  pool:  { waveHeight: .02, waveLength: 1.5, choppiness: .2, rippleStrength: .5, waveOctaves: 5, waveGain: .5, waveSpeed: 1 },
  pond:  { waveHeight: .06, waveLength: 3,   choppiness: .3, rippleStrength: .7, waveOctaves: 6, waveGain: .5, waveSpeed: 1 },
  lake:  { waveHeight: .25, waveLength: 8,   choppiness: .5, rippleStrength: 1,  waveOctaves: 7, waveGain: .5, waveSpeed: 1 },
  // ⚠ THE OCEAN IS A DIFFERENT WATER, NOT A BIGGER POOL (2026-09-07). A 60 m
  // swell at 1.2 m is a lagoon: too gentle to fold, so no whitecaps, and the
  // pool's clear cyan under a sky is a white sheet. The reference sea
  // (Popov72/OceanDemo) is a WIND SEA — a 20-odd-metre peak, steep enough
  // that its crests fold — over water that is dark: deep blue in-scatter,
  // extinction that swallows any floor. So this preset alone also writes
  // the look; pool/pond/lake leave colour and clarity to the author.
  // The user's own tuning of it (2026-09-07: "look at my current water
  // params, make them default for ocean preset"): a slower, rougher, greyer
  // sea than the first draft.
  ocean: { waveHeight: 1, waveLength: 24, choppiness: 1, rippleStrength: 1, waveOctaves: 8, waveGain: .4, waveSpeed: .5,
    surfaceDetail: 1, foam: .3, foamThreshold: 1, roughness: .5,
    color: "#77aca6", deepColor: "#04213a", saturation: .75, transmission: 1 },
});

// ── SEA STATE FROM THE COMPONENT'S FIELDS ────────────────────────────────────
//
// No new knobs. The fields the component has always had are re-mapped onto the
// spectrum, and the table is the contract:
//   waveHeight   RMS height σ = H/2 (significant height Hs = 2H), enforced by
//                normalizing the discrete spectrum's expected variance
//   waveLength   the PEAK wavelength λp: ω_p = √(g·2π/λp)
//   waveDirection the wind; a weaker swell spectrum rides at +50° so the two
//                trains interfere instead of one flat train marching by
//   choppiness   λ, the horizontal displacement (Babylon's Lambda)
//   rippleStrength energy of the cascades above the swell's own
//   waveOctaves  the short-wave cutoff: the finest wavelength kept is λp/2^n
//   waveGain     the spectral tilt above the peak: (k/kp)^(4·(gain − .5))
//   waveSpeed    a multiplier on time; dispersion stays physical
const finite = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
export function seaSettings(props = {}, depthMetres = 20) {
  const waveHeight = finite(props.waveHeight, .15, 0, 20);
  const waveLength = finite(props.waveLength, 4, .1, 1000);
  const direction = finite(props.waveDirection, 0, -180, 180) * Math.PI / 180;
  // ── A CONTAINER HAS NO DOWNWIND ────────────────────────────────────────
  //
  // "Why do the caustics shift so fast to the side as if water was flowing,
  // yet it is a static pool" (user, 2026-09-06). A wind spectrum's every wave
  // TRAVELS downwind at its phase speed (a 5 m wave at 2.8 m/s), so the lens
  // it makes translates with it. In a pool the ripples reflect off the walls
  // and opposite-going waves superpose into patterns that shimmer in place.
  // `enclosed` (1 for a box or primitive source, 0 for a plane) blends the
  // directional distribution toward isotropic — a little wind bias is kept.
  const enclosed = finite(props.enclosed, 0, 0, 1);
  const spreadBlend = 1 - .85 * enclosed;
  const octaves = finite(props.waveOctaves, 4, 1, 8);
  const gain = finite(props.waveGain, .5, .2, .9);
  const kp = 2 * Math.PI / waveLength;
  return {
    // ⚠ CAPPED AT THE BREAKING LIMIT. A wave steeper than about Hs/λ = 0.1
    // does not exist — it breaks — and a heightfield asked for one folds into
    // spikes (the property sweep's `waveHeight .35` on a 2 m peak was a
    // mountain range). The spectrum's height is bounded by its wavelength.
    sigma: Math.min(waveHeight / 2, .05 * waveLength),
    waveLength,
    peakOmega: Math.sqrt(GRAVITY * kp),
    kPeak: kp,
    kMax: kp * 2 ** octaves,
    tilt: 4 * (gain - .5),
    lambda: finite(props.choppiness, .35, 0, 1),
    ripple: finite(props.rippleStrength, .6, 0, 2),
    timeScale: finite(props.waveSpeed, 2, 0, 100),
    depth: Math.max(.05, Number(depthMetres) || 20),
    spectra: [
      { scale: 1, angle: direction, spreadBlend, swell: .3, gamma: 3.3 },
      { scale: .3, angle: direction + 50 * Math.PI / 180, spreadBlend, swell: 1, gamma: 3.3 },
    ],
  };
}

/** Cascade length scales, in Babylon's 250 : 17 : 5 proportion, hung from the
 *  peak wavelength so the swell always lives in the coarse cascade. */
export function cascadeScales(waveLength, count = 3) {
  const L0 = Math.min(1024, Math.max(8, 12 * finite(waveLength, 4, .1, 1000)));
  return [L0, L0 / 15, L0 / 15 / 3.4].slice(0, count);
}
/**
 * The wavenumber band each cascade owns — Babylon's `initializeCascades`.
 *
 * ⚠ 6.5 TEXELS, NOT 6. Babylon cuts at `2π/L_{i+1}·6`, which on the finer
 * cascade's own grid is EXACTLY the lattice point six texels from the centre —
 * so whether those four texels belong to the band came down to the last bit
 * of `sqrt(kx²+kz²)`, and f32 on the GPU and f64 on the CPU decided it
 * differently. They are the band's most energetic texels: the fine cascade
 * disagreed by 15 % of its peak from four texels. A half-texel offset is
 * never a lattice radius (6.5² is not an integer, nor is any ratio of these
 * scales times it), so membership no longer depends on rounding.
 */
export function cascadeBands(scales) {
  const bands = [];
  let low = 1e-4;
  for (let i = 0; i < scales.length; i++) {
    const high = i < scales.length - 1 ? 2 * Math.PI / scales[i + 1] * 6.5 : 9999;
    bands.push({ L: scales[i], cutLow: low, cutHigh: high });
    low = high;
  }
  return bands;
}

// ── THE SPECTRUM ─────────────────────────────────────────────────────────────
export function frequency(k, g, depth) { return Math.sqrt(g * k * Math.tanh(Math.min(k * depth, 20))); }
export function frequencyDerivative(k, g, depth) {
  const th = Math.tanh(Math.min(k * depth, 20)), ch = Math.cosh(Math.min(k * depth, 20));
  return g * (depth * k / ch / ch + th) / frequency(k, g, depth) / 2;
}
function normalisationFactor(s) {
  const s2 = s * s, s3 = s2 * s, s4 = s3 * s;
  if (s < 5) return -.000564 * s4 + .00776 * s3 - .044 * s2 + .192 * s + .163;
  return -4.8e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 5.9e-2 * s + 3.93e-1;
}
function cosine2s(theta, s) { return normalisationFactor(s) * Math.pow(Math.abs(Math.cos(.5 * theta)), 2 * s); }
function spreadPower(omega, peakOmega) {
  return omega > peakOmega ? 9.77 * Math.pow(Math.abs(omega / peakOmega), -2.5) : 6.97 * Math.pow(Math.abs(omega / peakOmega), 5);
}
export function directionSpectrum(theta, omega, peakOmega, pars) {
  const s = spreadPower(omega, peakOmega) + 16 * Math.tanh(Math.min(omega / peakOmega, 20)) * pars.swell * pars.swell;
  const iso = 2 / Math.PI * Math.cos(theta) * Math.cos(theta);
  return iso + (cosine2s(theta - pars.angle, s) - iso) * pars.spreadBlend;
}
export function tmaCorrection(omega, g, depth) {
  const omegaH = omega * Math.sqrt(depth / g);
  if (omegaH <= 1) return .5 * omegaH * omegaH;
  if (omegaH < 2) return 1 - .5 * (2 - omegaH) * (2 - omegaH);
  return 1;
}
/** JONSWAP with α = 1: the absolute level is set by the normalization below. */
export function jonswap(omega, g, depth, peakOmega, pars) {
  const sigma = omega <= peakOmega ? .07 : .09;
  const r = Math.exp(-(omega - peakOmega) * (omega - peakOmega) / 2 / sigma / sigma / peakOmega / peakOmega);
  const oneOverOmega = 1 / omega, peakOverOmega = peakOmega / omega;
  return pars.scale * tmaCorrection(omega, g, depth) * g * g
    * oneOverOmega ** 5 * Math.exp(-1.25 * peakOverOmega ** 4) * Math.pow(Math.abs(pars.gamma), r);
}
/** The one-sided spectral density at k, all terms of the mapping applied.
 *  Returns S(k, θ) · |dω/dk| / k — the variance density per Δk² cell. */
export function spectrumAt(kx, kz, settings) {
  const k = Math.hypot(kx, kz);
  if (!(k > 0)) return 0;
  const { depth, peakOmega, kPeak, kMax, tilt, ripple } = settings;
  const omega = frequency(k, GRAVITY, depth);
  const theta = Math.atan2(kz, kx);
  let s = 0;
  for (const pars of settings.spectra) s += jonswap(omega, GRAVITY, depth, peakOmega, pars) * directionSpectrum(theta, omega, peakOmega, pars);
  if (k > kPeak) s *= Math.pow(k / kPeak, tilt);
  // `rippleStrength` scales the SHORT waves — everything more than four times
  // shorter than the peak, blended in over an octave. Not "the fine cascades":
  // with a short peak wavelength the coarse cascade already holds waves down
  // to a few centimetres and the fine ones carry nothing, and the control
  // scaled nothing ("DEAD rippleStrength", the property sweep, 2026-09-06).
  const short = Math.min(1, Math.max(0, (k / kPeak - 2) / 4));
  s *= 1 + (ripple - 1) * short * short * (3 - 2 * short);
  s *= Math.exp(-((k / kMax) ** 4));
  return s * Math.abs(frequencyDerivative(k, GRAVITY, depth)) / k;
}

// ── THE REALIZATION ──────────────────────────────────────────────────────────
/** Deterministic unit Gaussians, two per texel — the same numbers the GPU's
 *  noise texture holds, so both sides realize the SAME sea. */
export function gaussianNoise(size, seed = 1337) {
  let state = seed >>> 0;
  const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = new Float32Array(size * size * 2);
  for (let i = 0; i < out.length; i += 2) {
    const u1 = Math.max(1e-12, random()), u2 = random();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = r * Math.cos(2 * Math.PI * u2);
    out[i + 1] = r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

/**
 * The expected variance of the height field a set of cascades would realize at
 * amplitude 1 — the number that turns `waveHeight` into a real height. Each
 * cascade's band is disjoint, so the cascades add. Per cell the amplitude is
 * `a² = 2·S·Δk²` times a complex unit Gaussian (E|noise|² = 2), and the field
 * at k is `h0(k) + conj(h0(−k))`, two independent such terms — so each texel
 * contributes 8·S·Δk² to the variance, counted once over the whole grid.
 */
export function expectedVariance(size, bands, settings) { return spectrumMoments(size, bands, settings).variance; }
/**
 * The variance of the height AND of the horizontal displacement's gradient
 * (∂Dx/∂x = −h·kx²/k, per unit amplitude). The second is what decides how
 * much `choppiness` a sea can take before it folds — see `foldingLimit`.
 */
export function spectrumMoments(size, bands, settings) {
  let variance = 0, gradient = 0;
  for (const { L, cutLow, cutHigh } of bands) {
    const dk = 2 * Math.PI / L;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const kx = (i - size / 2) * dk, kz = (j - size / 2) * dk, k = Math.hypot(kx, kz);
      if (!(k <= cutHigh && k >= cutLow && k > 0)) continue;
      const cell = 8 * spectrumAt(kx, kz, settings) * dk * dk;
      variance += cell;
      gradient += cell * (kx * kx / k) ** 2;
    }
  }
  return { variance, gradient };
}
/**
 * ⭐ TESSENDORF'S FOLDING LIMIT, FROM THE SPECTRUM ITSELF. The horizontal
 * displacement λ·Dx sharpens a crest; where λ·∂Dx/∂x reaches −1 the surface
 * folds over itself. ∂Dx/∂x is Gaussian with the deviation the moments give,
 * so a λ of 1/(2.5σ) folds only the crests past 2.5σ — about one percent of
 * the surface, which is what whitecaps ARE. Uncapped, `choppiness 1` on a
 * steep authored sea folded almost everywhere: crumpled foil, and foam over
 * all of it (the premium sheet, 2026-09-06). The cap is the physics, not a
 * taste setting; `choppiness` still chooses anything up to it.
 */
export function foldingLimit(amplitude, gradientVariance) {
  const sigma = amplitude * Math.sqrt(Math.max(0, gradientVariance));
  return sigma > 1e-9 ? 1 / (2.5 * sigma) : 1;
}

/** One cascade's initial spectrum: h0 (h0(k), conj h0(−k)) and the wave data
 *  (kx, 1/k, kz, ω) per texel, both N²·4 floats — the GPU's two textures. */
export function initialSpectrum({ size, L, cutLow, cutHigh, settings, noise, amplitude = 1 }) {
  const dk = 2 * Math.PI / L;
  const h0k = new Float32Array(size * size * 2);
  const wavesData = new Float32Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const t = j * size + i;
    const kx = (i - size / 2) * dk, kz = (j - size / 2) * dk, k = Math.hypot(kx, kz);
    if (k <= cutHigh && k >= cutLow && k > 0) {
      wavesData.set([kx, 1 / k, kz, frequency(k, GRAVITY, settings.depth)], t * 4);
      const a = amplitude * Math.sqrt(2 * spectrumAt(kx, kz, settings) * dk * dk);
      h0k[t * 2] = noise[t * 2] * a; h0k[t * 2 + 1] = noise[t * 2 + 1] * a;
    } else wavesData.set([kx, 1, kz, 0], t * 4);
  }
  const h0 = new Float32Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const t = j * size + i, m = ((size - j) % size) * size + (size - i) % size;
    h0.set([h0k[t * 2], h0k[t * 2 + 1], h0k[m * 2], -h0k[m * 2 + 1]], t * 4);
  }
  return { size, L, h0, wavesData };
}

/** The four complex maps at time t, packed two real fields per complex one:
 *  A = [Dx + i·Dz, Dy + i·Dxz], B = [Dyx + i·Dyz, Dxx + i·Dzz]. */
export function evolve(cascade, time) {
  const { size, h0, wavesData } = cascade;
  const A = new Float32Array(size * size * 4), B = new Float32Array(size * size * 4);
  for (let t = 0; t < size * size; t++) {
    const kx = wavesData[t * 4], invK = wavesData[t * 4 + 1], kz = wavesData[t * 4 + 2], omega = wavesData[t * 4 + 3];
    const phase = omega * time, c = Math.cos(phase), s = Math.sin(phase);
    const ax = h0[t * 4], ay = h0[t * 4 + 1], bx = h0[t * 4 + 2], by = h0[t * 4 + 3];
    // h = h0(k)·e^{iωt} + conj(h0(−k))·e^{−iωt}
    const hx = ax * c - ay * s + (bx * c + by * s), hy = ax * s + ay * c + (by * c - bx * s);
    const ihx = -hy, ihy = hx;
    const Dx = [ihx * kx * invK, ihy * kx * invK], Dy = [hx, hy], Dz = [ihx * kz * invK, ihy * kz * invK];
    const Dxdx = [-hx * kx * kx * invK, -hy * kx * kx * invK], Dydx = [ihx * kx, ihy * kx], Dzdx = [-hx * kx * kz * invK, -hy * kx * kz * invK];
    const Dydz = [ihx * kz, ihy * kz], Dzdz = [-hx * kz * kz * invK, -hy * kz * kz * invK];
    A.set([Dx[0] - Dz[1], Dx[1] + Dz[0], Dy[0] - Dzdx[1], Dy[1] + Dzdx[0]], t * 4);
    B.set([Dydx[0] - Dydz[1], Dydx[1] + Dydz[0], Dxdx[0] - Dzdz[1], Dxdx[1] + Dzdz[0]], t * 4);
  }
  return { A, B };
}

// ── THE TRANSFORM ────────────────────────────────────────────────────────────
/** Unnormalized inverse FFT (positive exponent) of one complex row/column held
 *  in strided storage, in place. Radix-2 decimation in time. */
function ifft1d(re, im, offset, stride, n) {
  for (let i = 1, j = 0; i < n; i++) {                 // bit reversal
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = offset + i * stride, b = offset + j * stride;
      [re[a], re[b]] = [re[b], re[a]]; [im[a], im[b]] = [im[b], im[a]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      const a = offset + (i + k) * stride, b = offset + (i + k + len / 2) * stride;
      const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - xr; im[b] = im[a] - xi;
      re[a] += xr; im[a] += xi;
    }
  }
}
/** In-place 2-D inverse transform of both complex fields of a packed N²·4 map,
 *  with the (−1)^(x+y) centring sign applied — the GPU's rows, columns and
 *  permute in one call. */
export function ifft2d(packed, size) {
  const n = size * size;
  const planes = [[new Float32Array(n), new Float32Array(n)], [new Float32Array(n), new Float32Array(n)]];
  for (let t = 0; t < n; t++) { planes[0][0][t] = packed[t * 4]; planes[0][1][t] = packed[t * 4 + 1]; planes[1][0][t] = packed[t * 4 + 2]; planes[1][1][t] = packed[t * 4 + 3]; }
  for (const [re, im] of planes) {
    for (let j = 0; j < size; j++) ifft1d(re, im, j * size, 1, size);
    for (let i = 0; i < size; i++) ifft1d(re, im, i, size, size);
  }
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const t = j * size + i, sign = (i + j) & 1 ? -1 : 1;
    packed[t * 4] = planes[0][0][t] * sign; packed[t * 4 + 1] = planes[0][1][t] * sign;
    packed[t * 4 + 2] = planes[1][0][t] * sign; packed[t * 4 + 3] = planes[1][1][t] * sign;
  }
  return packed;
}

/** Displacement (λ·Dx, Dy, λ·Dz, λ·Dxz) and derivatives (Dyx, Dyz, λ·Dxx,
 *  λ·Dzz) from the transformed maps — the ingredients of the composed
 *  surface's Jacobian, see `jacobianOf`. */
export function merge(A, B, size, lambda) {
  const n = size * size;
  const displacement = new Float32Array(n * 4), derivatives = new Float32Array(n * 4);
  for (let t = 0; t < n; t++) {
    const Dx = A[t * 4], Dz = A[t * 4 + 1], Dy = A[t * 4 + 2], Dxz = A[t * 4 + 3];
    const Dyx = B[t * 4], Dyz = B[t * 4 + 1], Dxx = B[t * 4 + 2], Dzz = B[t * 4 + 3];
    displacement.set([lambda * Dx, Dy, lambda * Dz, lambda * Dxz], t * 4);
    derivatives.set([Dyx, Dyz, Dxx * lambda, Dzz * lambda], t * 4);
  }
  return { displacement, derivatives };
}
/** The Jacobian of the COMPOSED surface at texel t, summed over cascades
 *  before the product (all cascades share one size here). */
export function jacobianOf(cascades, t) {
  let dxx = 0, dzz = 0, dxz = 0;
  for (const c of cascades) { dxx += c.derivatives[t * 4 + 2]; dzz += c.derivatives[t * 4 + 3]; dxz += c.displacement[t * 4 + 3]; }
  return (1 + dxx) * (1 + dzz) - dxz * dxz;
}

// ── SAMPLING, FOR BUOYANCY ───────────────────────────────────────────────────
/**
 * Half → float, for maps read straight back from the GPU (rgba16f). Converted
 * lazily at the sample, never as a whole map: a 256² readback is a quarter of
 * a million halves and converting them all every frame would cost more CPU
 * than the physics it feeds.
 */
const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
export function halfToFloat(h) {
  const s = (h & 0x8000) << 16, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return (s ? -1 : 1) * m * 5.960464477539063e-8;     // subnormal, or ±0
  if (e === 31) return m ? NaN : (s ? -Infinity : Infinity);
  _u32[0] = s | ((e + 112) << 23) | (m << 13);
  return _f32[0];
}
/** Bilinear, tiling sample of a displacement map at world (x, z). `map` is
 *  N²·4 floats — or N²·4 halves (Uint16Array) straight from a readback; `L`
 *  the cascade's length in metres. */
export function sampleDisplacement(map, size, L, x, z, out = [0, 0, 0]) {
  const fx = (x / L) * size, fz = (z / L) * size;
  const x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0;
  const wrap = (v) => ((v % size) + size) % size;
  const half = map instanceof Uint16Array;
  const read = half ? (i, j, c) => halfToFloat(map[(wrap(j) * size + wrap(i)) * 4 + c]) : (i, j, c) => map[(wrap(j) * size + wrap(i)) * 4 + c];
  for (let c = 0; c < 3; c++) {
    const a = read(x0, z0, c) + (read(x0 + 1, z0, c) - read(x0, z0, c)) * tx;
    const b = read(x0, z0 + 1, c) + (read(x0 + 1, z0 + 1, c) - read(x0, z0 + 1, c)) * tx;
    out[c] = a + (b - a) * tz;
  }
  return out;
}
/**
 * The sea's height at world (x, z), summed over cascades, with Babylon's
 * inverse-displacement iteration: the displacement map says where the water
 * that WAS at (x, z) went, so the water now AT (x, z) came from a point
 * displaced back by roughly that amount — three steps of that converge.
 */
export function seaHeightAt(cascades, x, z, steps = 3) {
  const d = [0, 0, 0], sum = [0, 0, 0];
  const total = (px, pz) => {
    sum[0] = sum[1] = sum[2] = 0;
    for (const c of cascades) { sampleDisplacement(c.displacement, c.size, c.L, px, pz, d); sum[0] += d[0]; sum[1] += d[1]; sum[2] += d[2]; }
    return sum;
  };
  let px = x, pz = z;
  for (let i = 0; i < steps; i++) { const t = total(px, pz); px = x - t[0]; pz = z - t[2]; }
  return total(px, pz)[1];
}

/** The whole model, end to end, for tests and the parity smoke. */
export function realizeSea({ size = 64, props = {}, depth = 20, time = 0, seed = 1337, cascadeCount = 3, amplitude: given = null, lambda: givenLambda = null }) {
  const settings = seaSettings(props, depth);
  const bands = cascadeBands(cascadeScales(settings.waveLength, cascadeCount));
  const { variance, gradient } = spectrumMoments(size, bands, settings);
  const amplitude = given ?? (variance > 0 ? settings.sigma / Math.sqrt(variance) : 0);
  settings.lambda = givenLambda ?? Math.min(settings.lambda, foldingLimit(amplitude, gradient));
  const noise = gaussianNoise(size, seed);
  const cascades = bands.map((band) => {
    const c = initialSpectrum({ size, ...band, settings, noise, amplitude });
    const { A, B } = evolve(c, time * settings.timeScale);
    ifft2d(A, size); ifft2d(B, size);
    return { ...c, ...merge(A, B, size, settings.lambda) };
  });
  return { settings, bands, amplitude, cascades };
}
