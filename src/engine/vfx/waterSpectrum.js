import * as THREE from "three/webgpu";
import {
  Fn, If, float, int, ivec2, vec2, vec4, uniform, instanceIndex, textureLoad, textureStore,
  workgroupArray, workgroupBarrier, localId, workgroupId, select, atan,
} from "three/tsl";
import { GRAVITY, cascadeBands, cascadeScales, expectedVariance, gaussianNoise, seaSettings } from "./waterSpectrumCPU.js";
import { releaseComputeNodes } from "../../modules/gi/releaseCompute.js";

/**
 * ══ THE SPECTRAL SEA, ON THE GPU ═══════════════════════════════════════════
 *
 * Popov72/OceanDemo's ocean (Babylon, MIT) rebuilt in TSL: a JONSWAP/TMA
 * spectrum realized once per settings change, evolved every frame by the
 * dispersion relation, inverse-transformed back to space and merged into the
 * three maps everything else reads — DISPLACEMENT (x, y, z, foam memory),
 * DERIVATIVES (the slopes the normal is built from) and, in `.w`, the JACOBIAN
 * TURBULENCE that says where the surface folded and how long ago.
 *
 * Three CASCADES tile the world at three length scales (250 : 17 : 5, hung
 * from the authored peak wavelength) so the swell, the wind chop and the
 * capillary texture each get a full 256² of spectrum. They tile in WORLD
 * metres, which is the whole point for this engine: the same sea state on a
 * 5 m pool and a 500 m lake, because neither knows how big its box is.
 *
 * `waterSpectrumCPU.js` is the specification: every formula here is the same
 * one, and `scripts/water-spectrum-smoke.html` diffs the two.
 *
 * ── THE TRANSFORM IS TWO DISPATCHES PER CASCADE, NOT SIXTEEN ──────────────
 *
 * Babylon runs log₂N ping-pong passes per direction — 32 tiny dispatches per
 * cascade per frame, which in three is 32 bind-group updates on the CPU
 * every frame. Here each workgroup owns one ROW (or column) in shared memory:
 * 128 threads load it bit-reversed, run the eight butterfly stages with a
 * barrier between them, and write it back. Both packed maps ride in the same
 * kernel, so a cascade's whole 2-D transform is `fftRows` + `fftCols`.
 *
 * ⚠ DISPATCHED BY WORKGROUP COUNT, NOT BY THREAD COUNT. `.compute(number)`
 * makes three prepend `if (index >= count) return;`, and a return before a
 * `workgroupBarrier()` is non-uniform control flow — the shader does not
 * compile. An ARRAY count is a dispatch size and adds no return.
 */
export const SEA_SIZE = 256;
const LOG2 = Math.log2(SEA_SIZE);
const HALF = SEA_SIZE / 2;

function storageMap(size, { half = false, mips = false, name = "" } = {}) {
  const t = new THREE.StorageTexture(size, size);
  t.type = half ? THREE.HalfFloatType : THREE.FloatType;
  t.format = THREE.RGBAFormat;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.name = name;
  return t;
}

// ── THE SPECTRUM, IN TSL (see waterSpectrumCPU.js for the same in JS) ────────
const frequencyNode = (k, depth) => k.mul(GRAVITY).mul(k.mul(depth).min(20).tanh()).sqrt();
const frequencyDerivativeNode = (k, depth) => {
  const kd = k.mul(depth).min(20), th = kd.tanh(), ch = kd.cosh();
  return depth.mul(k).div(ch).div(ch).add(th).mul(GRAVITY).div(frequencyNode(k, depth)).mul(.5);
};
const normalisationFactorNode = (s) => {
  const s2 = s.mul(s), s3 = s2.mul(s), s4 = s3.mul(s);
  const low = s4.mul(-.000564).add(s3.mul(.00776)).sub(s2.mul(.044)).add(s.mul(.192)).add(.163);
  const high = s4.mul(-4.8e-8).add(s3.mul(1.07e-5)).sub(s2.mul(9.53e-4)).add(s.mul(5.9e-2)).add(3.93e-1);
  return select(s.lessThan(5), low, high);
};
const spreadPowerNode = (omega, peakOmega) => select(omega.greaterThan(peakOmega),
  omega.div(peakOmega).abs().pow(-2.5).mul(9.77), omega.div(peakOmega).abs().pow(5).mul(6.97));
const directionNode = (theta, omega, peakOmega, pars) => {
  const s = spreadPowerNode(omega, peakOmega).add(omega.div(peakOmega).min(20).tanh().mul(16).mul(pars.swell).mul(pars.swell));
  const iso = theta.cos().mul(theta.cos()).mul(2 / Math.PI);
  const cos2s = normalisationFactorNode(s).mul(theta.sub(pars.angle).mul(.5).cos().abs().pow(s.mul(2)));
  return iso.add(cos2s.sub(iso).mul(pars.spreadBlend));
};
const tmaNode = (omega, depth) => {
  const omegaH = omega.mul(depth.div(GRAVITY).sqrt());
  return select(omegaH.lessThanEqual(1), omegaH.mul(omegaH).mul(.5),
    select(omegaH.lessThan(2), float(1).sub(float(2).sub(omegaH).pow(2).mul(.5)), float(1)));
};
const jonswapNode = (omega, depth, peakOmega, pars) => {
  const sigma = select(omega.lessThanEqual(peakOmega), float(.07), float(.09));
  const r = omega.sub(peakOmega).pow(2).div(sigma.mul(sigma).mul(2)).div(peakOmega.mul(peakOmega)).negate().exp();
  const oneOverOmega = float(1).div(omega), peakOver = peakOmega.div(omega);
  return pars.scale.mul(tmaNode(omega, depth)).mul(GRAVITY * GRAVITY).mul(oneOverOmega.pow(5))
    .mul(peakOver.pow(4).mul(-1.25).exp()).mul(pars.gamma.abs().pow(r));
};
/** S(k, θ)·|dω/dk|/k — the variance density per Δk² cell, as on the CPU. */
const spectrumNode = (kx, kz, k, u) => {
  const omega = frequencyNode(k, u.depth);
  const theta = atan(kz, kx);
  let s = float(0);
  for (const pars of u.spectra) s = s.add(jonswapNode(omega, u.depth, u.peakOmega, pars).mul(directionNode(theta, omega, u.peakOmega, pars)));
  s = s.mul(select(k.greaterThan(u.kPeak), k.div(u.kPeak).pow(u.tilt), float(1)));
  s = s.mul(k.div(u.kMax).pow(4).negate().exp());
  return s.mul(frequencyDerivativeNode(k, u.depth).abs()).div(k);
};

const cmul = (a, b) => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));

/**
 * One in-place radix-2 transform over every row (or column) of two packed
 * maps, unnormalized, positive exponent. Bit reversal happens on the load.
 */
function fftKernel(srcA, srcB, dstA, dstB, horizontal) {
  return Fn(() => {
    const shA = workgroupArray("vec4", SEA_SIZE), shB = workgroupArray("vec4", SEA_SIZE);
    const t = localId.x.toInt().toVar();
    const line = workgroupId.x.toInt().toVar();
    const coord = (i) => (horizontal ? ivec2(i, line) : ivec2(line, i));
    const reversed = (v) => {
      let r = int(0), x = v;
      for (let b = 0; b < LOG2; b++) { r = r.shiftLeft(int(1)).bitOr(x.bitAnd(int(1))); x = x.shiftRight(int(1)); }
      return r;
    };
    const i0 = t, i1 = t.add(int(HALF));
    shA.element(i0).assign(textureLoad(srcA, coord(reversed(i0))));
    shA.element(i1).assign(textureLoad(srcA, coord(reversed(i1))));
    shB.element(i0).assign(textureLoad(srcB, coord(reversed(i0))));
    shB.element(i1).assign(textureLoad(srcB, coord(reversed(i1))));
    workgroupBarrier();
    for (let stage = 1; stage <= LOG2; stage++) {
      const half = 1 << (stage - 1), span = 1 << stage;
      const group = t.div(int(half)), pos = t.mod(int(half));
      const i = group.mul(int(span)).add(pos).toVar(), j = i.add(int(half)).toVar();
      const ang = pos.toFloat().mul(2 * Math.PI / span);
      const w = vec2(ang.cos(), ang.sin()).toVar();
      for (const sh of [shA, shB]) {
        const a = sh.element(i).toVar(), b = sh.element(j).toVar();
        const bw = vec4(cmul(b.xy, w), cmul(b.zw, w)).toVar();
        sh.element(i).assign(a.add(bw));
        sh.element(j).assign(a.sub(bw));
      }
      workgroupBarrier();
    }
    textureStore(dstA, coord(i0), shA.element(i0));
    textureStore(dstA, coord(i1), shA.element(i1));
    textureStore(dstB, coord(i0), shB.element(i0));
    textureStore(dstB, coord(i1), shB.element(i1));
  })().compute([SEA_SIZE, 1, 1], [HALF, 1, 1]);
}

/**
 * The sea: `configure(props, depthMetres)` re-realizes the spectrum,
 * `tick(renderer, dt, time)` advances it. `cascades[i]` exposes the maps.
 */
export function createWaterSpectrum({ cascadeCount = 3, seed = 1337 } = {}) {
  const size = SEA_SIZE;
  const noiseData = gaussianNoise(size, seed);
  const noise = new THREE.DataTexture(noiseData, size, size, THREE.RGFormat, THREE.FloatType);
  noise.minFilter = noise.magFilter = THREE.NearestFilter;
  noise.needsUpdate = true;

  const u = {
    time: uniform(0), dt: uniform(0), lambda: uniform(.35),
    depth: uniform(20), peakOmega: uniform(1), kPeak: uniform(1), kMax: uniform(10), tilt: uniform(0),
    spectra: [0, 1].map(() => ({ scale: uniform(1), angle: uniform(0), spreadBlend: uniform(1), swell: uniform(.3), gamma: uniform(3.3) })),
  };
  const index = instanceIndex.toInt();
  const px = index.mod(size), py = index.div(size);
  const texel = ivec2(px, py);
  const sign = select(px.add(py).bitAnd(int(1)).equal(int(1)), float(-1), float(1));

  const cascades = Array.from({ length: cascadeCount }, (_, i) => {
    const c = { dk: uniform(1), cutLow: uniform(0), cutHigh: uniform(9999), amplitude: uniform(0), L: 1 };
    const h0k = storageMap(size, { name: `sea ${i} h0k` });
    const h0 = storageMap(size, { name: `sea ${i} h0` });
    const wavesData = storageMap(size, { name: `sea ${i} waves` });
    const A = storageMap(size, { name: `sea ${i} A` }), B = storageMap(size, { name: `sea ${i} B` });
    const A2 = storageMap(size, { name: `sea ${i} A2` }), B2 = storageMap(size, { name: `sea ${i} B2` });
    const displacement = storageMap(size, { half: true, mips: true, name: `sea ${i} displacement` });
    const derivatives = storageMap(size, { half: true, mips: true, name: `sea ${i} derivatives` });
    const turbulence = storageMap(size, { half: true, name: `sea ${i} turbulence` });

    const initial = Fn(() => {
      const kx = px.toFloat().sub(size / 2).mul(c.dk), kz = py.toFloat().sub(size / 2).mul(c.dk);
      const k = kx.mul(kx).add(kz.mul(kz)).sqrt().toVar();
      If(k.lessThanEqual(c.cutHigh).and(k.greaterThanEqual(c.cutLow)).and(k.greaterThan(0)), () => {
        textureStore(wavesData, texel, vec4(kx, float(1).div(k), kz, frequencyNode(k, u.depth)));
        const a = c.amplitude.mul(spectrumNode(kx, kz, k, u).mul(2).mul(c.dk).mul(c.dk).max(0).sqrt());
        const n = textureLoad(noise, texel).xy;
        textureStore(h0k, texel, vec4(n.x.mul(a), n.y.mul(a), 0, 0));
      }).Else(() => {
        textureStore(wavesData, texel, vec4(kx, 1, kz, 0));
        textureStore(h0k, texel, vec4(0));
      });
    })().compute(size * size);
    const conjugate = Fn(() => {
      const here = textureLoad(h0k, texel).xy;
      const mirror = textureLoad(h0k, ivec2(int(size).sub(px).mod(size), int(size).sub(py).mod(size))).xy;
      textureStore(h0, texel, vec4(here.x, here.y, mirror.x, mirror.y.negate()));
    })().compute(size * size);
    const evolve = Fn(() => {
      const wave = textureLoad(wavesData, texel).toVar();
      const kx = wave.x, invK = wave.y, kz = wave.z, omega = wave.w;
      const phase = omega.mul(u.time);
      const e = vec2(phase.cos(), phase.sin()).toVar();
      const h0v = textureLoad(h0, texel).toVar();
      const h = cmul(h0v.xy, e).add(cmul(h0v.zw, vec2(e.x, e.y.negate()))).toVar();
      const ih = vec2(h.y.negate(), h.x).toVar();
      const Dx = ih.mul(kx).mul(invK), Dy = h, Dz = ih.mul(kz).mul(invK);
      const Dxdx = h.negate().mul(kx).mul(kx).mul(invK), Dydx = ih.mul(kx), Dzdx = h.negate().mul(kx).mul(kz).mul(invK);
      const Dydz = ih.mul(kz), Dzdz = h.negate().mul(kz).mul(kz).mul(invK);
      textureStore(A, texel, vec4(Dx.x.sub(Dz.y), Dx.y.add(Dz.x), Dy.x.sub(Dzdx.y), Dy.y.add(Dzdx.x)));
      textureStore(B, texel, vec4(Dydx.x.sub(Dydz.y), Dydx.y.add(Dydz.x), Dxdx.x.sub(Dzdz.y), Dxdx.y.add(Dzdz.x)));
    })().compute(size * size);
    const fftRows = fftKernel(A, B, A2, B2, true);
    const fftCols = fftKernel(A2, B2, A, B, false);
    const merge = Fn(() => {
      const a = textureLoad(A, texel).mul(sign).toVar(), b = textureLoad(B, texel).mul(sign).toVar();
      const Dx = a.x, Dz = a.y, Dy = a.z, Dxz = a.w, Dyx = b.x, Dyz = b.y, Dxx = b.z, Dzz = b.w;
      const J = u.lambda.mul(Dxx).add(1).mul(u.lambda.mul(Dzz).add(1)).sub(u.lambda.mul(u.lambda).mul(Dxz).mul(Dxz)).toVar();
      // The foam memory: pulled down to J the moment the surface folds, then
      // recovering at 0.5/s — Babylon's `wavesTexturesMerger.wgsl`.
      const previous = textureLoad(turbulence, texel).x;
      const turb = previous.add(u.dt.mul(.5).div(J.max(.5))).min(J);
      textureStore(displacement, texel, vec4(u.lambda.mul(Dx), Dy, u.lambda.mul(Dz), turb));
      textureStore(derivatives, texel, vec4(Dyx, Dyz, Dxx.mul(u.lambda), Dzz.mul(u.lambda)));
    })().compute(size * size);
    // The memory lives in `displacement.w` for consumers and is copied to its
    // own map so `merge` can read last frame's without reading what it writes.
    const remember = Fn(() => {
      textureStore(turbulence, texel, vec4(textureLoad(displacement, texel).w, 0, 0, 0));
    })().compute(size * size);
    const reset = Fn(() => { textureStore(turbulence, texel, vec4(1, 0, 0, 0)); })().compute(size * size);
    for (const [k, node] of Object.entries({ initial, conjugate, evolve, fftRows, fftCols, merge, remember, reset })) node.__giPassName = `sea${i}.${k}`;
    return { index: i, uniforms: c, get L() { return c.L; }, displacement, derivatives, turbulence,
      textures: [h0k, h0, wavesData, A, B, A2, B2, displacement, derivatives, turbulence],
      kernels: { initial, conjugate, evolve, fftRows, fftCols, merge, remember, reset } };
  });

  let settings = null, dirty = true, started = false;
  const spectrum = {
    size, cascades, uniforms: u, noise,
    get settings() { return settings; },
    amplitude: 0,
    /** Re-realize the spectrum from the component's wave fields. */
    configure(props, depthMetres) {
      settings = seaSettings(props, depthMetres);
      const bands = cascadeBands(cascadeScales(settings.waveLength, cascadeCount));
      // The expected variance is an integral over k; a 64² estimate of it is
      // within a few percent of the 256² one and a hundred times cheaper.
      const variance = expectedVariance(64, bands, settings);
      spectrum.amplitude = variance > 0 ? settings.sigma / Math.sqrt(variance) : 0;
      u.lambda.value = settings.lambda; u.depth.value = settings.depth;
      u.peakOmega.value = settings.peakOmega; u.kPeak.value = settings.kPeak; u.kMax.value = settings.kMax; u.tilt.value = settings.tilt;
      settings.spectra.forEach((pars, i) => { const s = u.spectra[i]; s.scale.value = pars.scale; s.angle.value = pars.angle; s.spreadBlend.value = pars.spreadBlend; s.swell.value = pars.swell; s.gamma.value = pars.gamma; });
      bands.forEach((band, i) => {
        const c = cascades[i].uniforms;
        c.L = band.L; c.dk.value = 2 * Math.PI / band.L; c.cutLow.value = band.cutLow; c.cutHigh.value = band.cutHigh;
        c.amplitude.value = spectrum.amplitude * (i ? settings.ripple : 1);
      });
      dirty = true;
      return settings;
    },
    /** The dispatches for this frame, in order; `renderer.compute(...)` them. */
    passes(dt, time) {
      const queue = [];
      if (!settings) return queue;
      if (!started) { for (const c of cascades) queue.push(c.kernels.reset); started = true; }
      if (dirty) { for (const c of cascades) queue.push(c.kernels.initial, c.kernels.conjugate); dirty = false; }
      u.time.value = time * settings.timeScale; u.dt.value = Math.min(.5, Math.max(0, dt));
      for (const c of cascades) queue.push(c.kernels.evolve, c.kernels.fftRows, c.kernels.fftCols, c.kernels.merge, c.kernels.remember);
      return queue;
    },
    tick(renderer, dt, time) {
      const queue = spectrum.passes(dt, time);
      if (queue.length && renderer?.isWebGPURenderer) renderer.compute(queue);
    },
    dispose(renderer) {
      releaseComputeNodes(renderer, cascades.flatMap((c) => Object.values(c.kernels)));
      for (const c of cascades) for (const t of c.textures) t.dispose();
      noise.dispose();
    },
  };
  return spectrum;
}
