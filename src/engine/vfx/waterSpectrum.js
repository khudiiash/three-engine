import * as THREE from "three/webgpu";
import {
  Fn, If, Loop, float, int, ivec2, vec2, vec4, uniform, uniformArray, instanceIndex, texture, textureLoad, textureStore, storageTexture,
  workgroupArray, workgroupBarrier, localId, workgroupId, select, atan, cameraPosition, positionWorld, mix,
} from "three/tsl";
import { GRAVITY, cascadeBands, cascadeScales, foldingLimit, gaussianNoise, seaSettings, spectrumMoments } from "./waterSpectrumCPU.js";
import { releaseComputeNodes } from "../../modules/gi/releaseCompute.js";
import { mipmapBlitter } from "./gpuMipmaps.js";

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
/** How much sea a build quality buys: cascades × resolution. One model, sized
 *  to the device — a phone runs two 128² cascades of the same spectrum. */
export function seaQuality(quality = "high") {
  return { low: { size: 128, cascadeCount: 2, foamSize: 256 }, medium: { size: 128, cascadeCount: 3, foamSize: 512 } }[quality]
    ?? { size: SEA_SIZE, cascadeCount: 3, foamSize: 1024 };
}
/**
 * ══ THE WHITECAP MEMORY (2026-09-07) ══════════════════════════════════════
 *
 * "Our default ocean looks pathetic" — a 500 m sea with soft foam blobs in
 * the 32 m ripple window and NOTHING beyond it. The per-pixel whitecap gate
 * (`seaFoamNode` on the composed Jacobian) is instantaneous and reads the
 * cascades at the pixel's own mip, and a filtered Jacobian averages toward 1:
 * past a few tens of metres the gate can never open, so the far sea is glass
 * while the reference (Popov72/OceanDemo) carries streaky foam to the
 * horizon. Its foam is a MEMORY — "turbulence", the Jacobian's deficit
 * integrated over seconds and decaying — and a memory mip-filters as a
 * COVERAGE, which is exactly what the distance needs.
 *
 * So the sea keeps one: a camera-following window of FOAM_WINDOW_METRES
 * (texel-snapped, like the caustic and ripple windows) over the COMPOSED
 * Jacobian — never per cascade, see the ⛔ below — where each texel holds
 * max(whitecap now, last frame's value × decay). A crest that folds leaves
 * a trail as it travels: the streaks. The lid reads it per pixel
 * (`waterFoam.js`) and per vertex (the solver's far-foam seed), the ripple
 * window's field remains the near-field memory a splash writes into.
 */
export const FOAM_WINDOW_METRES = 512;
/** e-folding time of a whitecap's memory: a few seconds, as in the demo. */
export const FOAM_LIFE_SECONDS = 6;
/** Babylon's LOD scale: a cascade fades out of the shading normal past
 *  LOD_SCALE × L metres from the eye, where its texels are under a pixel. */
export const LOD_SCALE = 7.13;
/**
 * ⛔ NO PER-CASCADE FOAM MEMORY, AND NO PER-CASCADE JACOBIAN. Babylon keeps a
 * "turbulence" memory of each cascade's own Jacobian and sums them. A fine
 * cascade's own horizontal gradient is large (it scales with k²·h), so on any
 * choppy sea it "folds" at the centimetre scale constantly — while the
 * COMPOSED surface does nothing of the kind — and the sum whited out the
 * whole pool. The fold test belongs to the sum of the cascades' gradients,
 * taken where the surface is composed (`seaJacobianAt`, in the solver's
 * surface kernel), and the memory belongs to the solver's persistent foam
 * field, which already spreads and dissolves a wake's foam. So the maps carry
 * the ingredients: derivatives (Dyx, Dyz, λDxx, λDzz) and, in
 * displacement.w, λDxz.
 */

/**
 * ⚠ THE TWO OUTPUT MAPS ARE TEXTURE ARRAYS, ONE LAYER PER CASCADE — because
 * the water FRAGMENT binds them, and it already binds the medium's four slot
 * maps, the depth texture, the mirror, the transmission target, the shadow
 * maps, GI's and the environment: three separate derivative textures took it
 * to **18 sampled textures against the portable 16** and the water's pipeline
 * refused to build in the editor. One array is one binding.
 */
function storageMap(size, { half = false, mips = false, name = "", layers = 0 } = {}) {
  const t = layers ? new THREE.StorageArrayTexture(size, size, layers) : new THREE.StorageTexture(size, size);
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
  // Short waves (k > 4·kp, blended over an octave) scale with `rippleStrength`.
  const short = k.div(u.kPeak).sub(2).div(4).clamp(0, 1);
  s = s.mul(float(1).add(u.ripple.sub(1).mul(short.mul(short).mul(float(3).sub(short.mul(2))))));
  s = s.mul(k.div(u.kMax).pow(4).negate().exp());
  return s.mul(frequencyDerivativeNode(k, u.depth).abs()).div(k);
};

const cmul = (a, b) => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));

/**
 * One in-place radix-2 transform over every row (or column) of two packed
 * maps, unnormalized, positive exponent. Bit reversal happens on the load.
 */
function fftKernel(srcA, srcB, dstA, dstB, horizontal, size) {
  const LOG2 = Math.log2(size), HALF = size / 2;
  return Fn(() => {
    const shA = workgroupArray("vec4", size), shB = workgroupArray("vec4", size);
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
  })().compute([size, 1, 1], [HALF, 1, 1]);
}

/**
 * The sea: `configure(props, depthMetres)` re-realizes the spectrum,
 * `tick(renderer, dt, time)` advances it. `cascades[i]` exposes the maps.
 */
export function createWaterSpectrum({ size = SEA_SIZE, cascadeCount = 3, seed = 1337, foamSize = 1024 } = {}) {
  const noiseData = gaussianNoise(size, seed);
  const noise = new THREE.DataTexture(noiseData, size, size, THREE.RGFormat, THREE.FloatType);
  noise.minFilter = noise.magFilter = THREE.NearestFilter;
  noise.needsUpdate = true;

  const u = {
    time: uniform(0), dt: uniform(0), lambda: uniform(.35),
    // ── THE CURRENT (2026-09-07) ──────────────────────────────────────────
    // "I want to make it look like the boat is floating, without actually
    // moving it, so I need to scroll the ocean." Every sample of the sea is
    // taken at world + scroll, and scroll advances by the authored current
    // (metres per second) each tick: the sea streams under a fixed lid —
    // geometry, normals, whitecaps, caustics and the buoyancy query alike.
    scroll: uniform(new THREE.Vector2(0, 0)),
    depth: uniform(20), peakOmega: uniform(1), kPeak: uniform(1), kMax: uniform(10), tilt: uniform(0), ripple: uniform(1),
    spectra: [0, 1].map(() => ({ scale: uniform(1), angle: uniform(0), spreadBlend: uniform(1), swell: uniform(.3), gamma: uniform(3.3) })),
  };
  const index = instanceIndex.toInt();
  const px = index.mod(size), py = index.div(size);
  const texel = ivec2(px, py);
  const sign = select(px.add(py).bitAnd(int(1)).equal(int(1)), float(-1), float(1));
  const displacement = storageMap(size, { half: true, mips: true, layers: cascadeCount, name: "sea displacement" });
  const derivatives = storageMap(size, { half: true, mips: true, layers: cascadeCount, name: "sea derivatives" });
  // The whitecap memory: two maps, ping-ponged (a storage texture is never
  // read and written in one kernel), and its window's placement.
  const foamMaps = [0, 1].map((i) => storageMap(foamSize, { half: true, mips: true, name: `sea foam ${i}` }));
  for (const t of foamMaps) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  const f = {
    size: foamSize, center: uniform(new THREE.Vector2(0, 0)), half: uniform(FOAM_WINDOW_METRES / 2),
    texel: uniform(FOAM_WINDOW_METRES / foamSize), shift: uniform(new THREE.Vector2(0, 0)),
    gate: uniform(.25), decay: uniform(1), lods: Array.from({ length: cascadeCount }, () => uniform(0)),
    // Foam handed to the memory from outside — a hull's waterline (x, z,
    // radius in the sea's metres, a value 0–1): the tail a boat trails, as
    // long as the current times the memory's life ("there must be a tail
    // behind the boat", user, 2026-09-07). The ripple window is 32 m; the
    // memory is 512 m and rides the current.
    seedRows: Array.from({ length: 64 }, () => new THREE.Vector4()),
    seedCount: uniform(0, "int"),
  };
  f.seeds = uniformArray(f.seedRows, "vec4");
  let foamPhase = 0, foamWritten = null;
  // The current's sub-texel remainder for the whitecap memory's shift.
  const scrollAccum = { x: 0, y: 0 };

  const cascades = Array.from({ length: cascadeCount }, (_, i) => {
    const c = { dk: uniform(1), cutLow: uniform(0), cutHigh: uniform(9999), amplitude: uniform(0), invL: uniform(1), L: 1,
      // This cascade's slope variance (both directions), for the roughness the
      // shading normal must take on where distance fades the cascade out.
      slopeVariance: uniform(0) };
    const h0k = storageMap(size, { name: `sea ${i} h0k` });
    const h0 = storageMap(size, { name: `sea ${i} h0` });
    const wavesData = storageMap(size, { name: `sea ${i} waves` });
    const A = storageMap(size, { name: `sea ${i} A` }), B = storageMap(size, { name: `sea ${i} B` });
    const A2 = storageMap(size, { name: `sea ${i} A2` }), B2 = storageMap(size, { name: `sea ${i} B2` });
    const layer = int(i);

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
    const fftRows = fftKernel(A, B, A2, B2, true, size);
    const fftCols = fftKernel(A2, B2, A, B, false, size);
    const merge = Fn(() => {
      const a = textureLoad(A, texel).mul(sign).toVar(), b = textureLoad(B, texel).mul(sign).toVar();
      const Dx = a.x, Dz = a.y, Dy = a.z, Dxz = a.w, Dyx = b.x, Dyz = b.y, Dxx = b.z, Dzz = b.w;
      storageTexture(displacement).depth(layer).store(texel, vec4(u.lambda.mul(Dx), Dy, u.lambda.mul(Dz), u.lambda.mul(Dxz)));
      storageTexture(derivatives).depth(layer).store(texel, vec4(Dyx, Dyz, Dxx.mul(u.lambda), Dzz.mul(u.lambda)));
    })().compute(size * size);
    for (const [k, node] of Object.entries({ initial, conjugate, evolve, fftRows, fftCols, merge })) node.__giPassName = `sea${i}.${k}`;
    return { index: i, uniforms: c, get L() { return c.L; },
      textures: [h0k, h0, wavesData, A, B, A2, B2],
      kernels: { initial, conjugate, evolve, fftRows, fftCols, merge } };
  });

  let settings = null, dirty = true;
  const spectrum = {
    size, cascades, uniforms: u, noise, displacement, derivatives,
    // Bound ONCE per consumer graph and shared: the texture node is what a
    // material or kernel binds; a cascade is a LAYER of it.
    nodes: { displacement: texture(displacement), derivatives: texture(derivatives) },
    get settings() { return settings; },
    amplitude: 0,
    /** Re-realize the spectrum from the component's wave fields. */
    configure(props, depthMetres) {
      settings = seaSettings(props, depthMetres);
      const bands = cascadeBands(cascadeScales(settings.waveLength, cascadeCount));
      // The expected variance is an integral over k; a 64² estimate of it is
      // within a few percent of the 256² one and a hundred times cheaper.
      const { variance, gradient } = spectrumMoments(64, bands, settings);
      spectrum.amplitude = variance > 0 ? settings.sigma / Math.sqrt(variance) : 0;
      // `choppiness`, capped where the surface would fold (`foldingLimit`).
      settings.lambda = Math.min(settings.lambda, foldingLimit(spectrum.amplitude, gradient));
      u.lambda.value = settings.lambda; u.depth.value = settings.depth;
      u.peakOmega.value = settings.peakOmega; u.kPeak.value = settings.kPeak; u.kMax.value = settings.kMax; u.tilt.value = settings.tilt;
      u.ripple.value = settings.ripple;
      settings.spectra.forEach((pars, i) => { const s = u.spectra[i]; s.scale.value = pars.scale; s.angle.value = pars.angle; s.spreadBlend.value = pars.spreadBlend; s.swell.value = pars.swell; s.gamma.value = pars.gamma; });
      bands.forEach((band, i) => {
        const c = cascades[i].uniforms;
        c.L = band.L; c.invL.value = 1 / band.L; c.dk.value = 2 * Math.PI / band.L; c.cutLow.value = band.cutLow; c.cutHigh.value = band.cutHigh;
        c.amplitude.value = spectrum.amplitude;
        // The x-slope moment of this band alone, doubled for both directions,
        // at the realized amplitude.
        c.slopeVariance.value = 2 * spectrumMoments(64, [band], settings).gradient * spectrum.amplitude * spectrum.amplitude;
        // The foam window reads each cascade at the level whose texel matches
        // its own, or a fine cascade aliases across the window's texels.
        f.lods[i].value = Math.max(0, Math.log2(Math.max(1, f.texel.value / (band.L / size))));
      });
      dirty = true;
      return settings;
    },
    /** The sea carries no memory of its own (the solver's foam field does);
     *  a restart re-realizes nothing. Kept so the solver may call it. */
    restart() {},
    /** The dispatches for this frame, in order; `renderer.compute(...)` them.
     *  `eye` is the camera in the sea's metres (a water's local XZ × its
     *  scale) — the foam window follows it; `foam` is the water's dial. */
    passes(dt, time, { eye = null, foam = null, current = null, seeds = null } = {}) {
      // Foam handed in this tick (the sea's metres); the rows are consumed here.
      const count = Math.min(f.seedRows.length, seeds?.length ?? 0);
      for (let i = 0; i < count; i++) f.seedRows[i].fromArray(seeds[i]);
      f.seedCount.value = count;
      const queue = [];
      if (!settings) return queue;
      if (dirty) { for (const c of cascades) queue.push(c.kernels.initial, c.kernels.conjugate); dirty = false; }
      u.time.value = time * settings.timeScale; u.dt.value = Math.min(.5, Math.max(0, dt));
      for (const c of cascades) queue.push(c.kernels.evolve, c.kernels.fftRows, c.kernels.fftCols, c.kernels.merge);
      // The whitecap memory: window snapped to whole texels on the eye, last
      // frame's map read at the shifted texel, this frame's written to the
      // other map, which the lid then samples.
      if (foam != null) f.gate.value = Math.max(0, Math.min(1, foam));
      f.decay.value = Math.exp(-Math.min(.5, Math.max(0, dt)) / FOAM_LIFE_SECONDS);
      const t = f.texel.value;
      if (eye) {
        const cx = Math.round(eye[0] / t) * t, cz = Math.round(eye[1] / t) * t;
        f.shift.value.set(Math.round((cx - f.center.value.x) / t), Math.round((cz - f.center.value.y) / t));
        f.center.value.set(cx, cz);
      } else f.shift.value.set(0, 0);
      // The current: the sea's samples move by it, and so must the whitecap
      // memory — foam rides the water. The window stays on the eye (world
      // space); its CONTENTS take the value that was upstream a tick ago,
      // whole texels at a time with the remainder carried.
      if (current && (current[0] || current[1])) {
        const step = Math.min(.1, Math.max(0, dt));
        // ⚠ THE SCROLL DECREASES. The sea is sampled at world + scroll, so the
        // pattern at W now is what stood at W + scroll before: for the water
        // to travel WITH the current (+v), the scroll must run against it —
        // sampled at world + v·t the sea streamed backwards while the wake
        // and the whitecaps went forward ("foam is running in the opposite
        // direction than the current", user, 2026-09-07). `scrollAccum`
        // tracks the WATER's displacement (+v·dt) for the memory's shift.
        u.scroll.value.x -= current[0] * step; u.scroll.value.y -= current[1] * step;
        scrollAccum.x += current[0] * step; scrollAccum.y += current[1] * step;
        const sx = Math.round(scrollAccum.x / t), sz = Math.round(scrollAccum.y / t);
        scrollAccum.x -= sx * t; scrollAccum.y -= sz * t;
        f.shift.value.x -= sx; f.shift.value.y -= sz;
      }
      queue.push(foamKernels[foamPhase]);
      foamWritten = foamMaps[1 - foamPhase];
      spectrum.nodes.foam.value = foamWritten;
      foamPhase = 1 - foamPhase;
      return queue;
    },
    /**
     * ⛔ THE MAPS' MIPS ARE OURS TO MAKE. three regenerates a storage
     * texture's mips only when a SAMPLED binding of it is (re)built after a
     * store binding marked it (Bindings.js), and the sea's arrays are bound
     * once and cached — so every mip above 0 stayed the zero it was created
     * with. Every `.level(n > 0)` read — the clipmap's coarse rings, the
     * far pixels' hardware mip, the foam memory's coverage — read NOTHING:
     * the sea was flat from the sixth ring out (receipt: RMS 0.00 m on
     * levels 6–8, 0.41 on level 5 = 0.8 × mip 0 + 0.2 × an empty mip 1;
     * 2026-09-07). Called after the sea's dispatches and before the surface
     * reads them, so the coarse levels describe THIS frame's sea.
     */
    generateMipmaps(renderer) {
      if (globalThis.__waterSeaMips === false) return;   // `__waterSeaMips = false`: the harness's control arm
      // ⛔ NOT three's mipmap pass: it creates a view and a bind group per
      // layer per level per call, and every frame of that exhausted Dawn's
      // D3D12 descriptor heaps ("CreateDescriptorHeap failed with
      // E_OUTOFMEMORY", device lost, 2026-09-07). gpuMipmaps.js builds them
      // once per GPU texture and only encodes passes here.
      const blitter = mipmapBlitter(renderer);
      if (!blitter) return;
      for (const t of [displacement, derivatives, foamWritten]) if (t) blitter.generate(t);
    },
    tick(renderer, dt, time, options) {
      const queue = spectrum.passes(dt, time, options);
      if (queue.length && renderer?.isWebGPURenderer) { renderer.compute(queue); spectrum.generateMipmaps(renderer); }
    },
    /**
     * The displacement maps of the cascades that carry height, copied to the
     * CPU for buoyancy — Babylon's `_getDisplacementMap`. Asynchronous and a
     * frame or two behind, which no floating body can see; kept as HALVES and
     * converted at the sample (`sampleDisplacement`), never as a whole map.
     */
    async readback(renderer, count = 2) {
      if (!renderer?.backend?.copyTextureToBuffer || !settings) return null;
      const maps = await Promise.all(cascades.slice(0, count).map((c, i) => renderer.backend.copyTextureToBuffer(displacement, 0, 0, size, size, i)));
      return { cascades: maps.map((map, i) => ({ size, L: cascades[i].L, displacement: map })), scroll: { x: u.scroll.value.x, z: u.scroll.value.y } };
    },
    dispose(renderer) {
      releaseComputeNodes(renderer, [...cascades.flatMap((c) => Object.values(c.kernels)), ...foamKernels]);
      for (const c of cascades) for (const t of c.textures) t.dispose();
      for (const t of foamMaps) t.dispose();
      displacement.dispose(); derivatives.dispose(); noise.dispose();
    },
  };
  spectrum.foam = f;
  spectrum.nodes.foam = texture(foamMaps[0]);
  // The memory's step, one kernel per ping-pong direction. A texel's world
  // position is the window's centre plus its offset; the whitecap it holds
  // is the same per-pixel gate the lid uses (on the composed Jacobian, at
  // the cascades' matching levels); its past is the OTHER map at the texel
  // that held this world position before the window moved, or — at the
  // window's fresh edge — the present.
  const foamKernel = (source, target) => Fn(() => {
    const i = instanceIndex.toInt();
    const fx = i.mod(foamSize), fy = i.div(foamSize);
    const world = vec2(
      fx.toFloat().add(.5).sub(foamSize / 2).mul(f.texel).add(f.center.x),
      fy.toFloat().add(.5).sub(foamSize / 2).mul(f.texel).add(f.center.y));
    const sea = seaDisplacementAt(spectrum, world, f.lods);
    const now = seaFoamNode(seaJacobianAt(spectrum, world, sea.w, f.lods), f.gate).toVar();
    Loop({ start: 0, end: f.seedCount }, ({ i }) => {
      const seed = f.seeds.element(i);
      const d = world.sub(seed.xy).length().div(seed.z.max(1e-4));
      now.assign(now.max(d.mul(1.5).pow(6).min(20).negate().exp().mul(seed.w.min(1))));
    });
    const sx = fx.add(f.shift.x.toInt()), sy = fy.add(f.shift.y.toInt());
    const inside = sx.greaterThanEqual(0).and(sx.lessThan(foamSize)).and(sy.greaterThanEqual(0)).and(sy.lessThan(foamSize));
    const prev = select(inside, textureLoad(source, ivec2(sx.clamp(0, foamSize - 1), sy.clamp(0, foamSize - 1))).x, now);
    textureStore(target, ivec2(fx, fy), vec4(now.max(prev.mul(f.decay)), 0, 0, 1));
  })().compute(foamSize * foamSize);
  const foamKernels = [foamKernel(foamMaps[0], foamMaps[1]), foamKernel(foamMaps[1], foamMaps[0])];
  foamKernels.forEach((k, i) => { k.__giPassName = `sea.foam${i}`; });
  return spectrum;
}

// ── SAMPLING THE SEA, IN TSL ─────────────────────────────────────────────────
//
// `world` is a vec2 in WORLD metres (a water's local XZ times its scale, so the
// tiling is in metres whatever the box). `lods` are per-cascade mip levels for
// a compute stage that has no screen derivatives — a vertex spacing coarser
// than a cascade's texel must read a coarser level or it aliases; a fragment
// passes null and lets the hardware pick.

/** Σ displacement (x, y, z, world metres) over the cascades, and in `.w` the
 *  Σ of λ·Dxz — the cross term the Jacobian of the composed surface needs. */
// ⚠ HALF A TEXEL, AND IT IS NOT A DETAIL. The transform puts sample i at
// x = i·L/N, but a sampler puts texel i's CENTRE at (i + ½)/N — so `x/L`
// alone reads every cascade half a texel early, and the coarse cascade's
// band reaches waves only 2.7 texels long, where half a texel is most of a
// wave. The CPU (`sampleDisplacement`) follows the transform; so must this,
// or buoyancy floats on a sea the eye does not see.
const texelCentre = (spectrum) => .5 / spectrum.size;
export function seaDisplacementAt(spectrum, world, lods = null) {
  let sum = vec4(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    let s = spectrum.nodes.displacement.sample(uv).depth(i);
    if (lods) s = s.level(lods[i]);
    sum = sum.add(s);
  });
  return sum;
}
/**
 * ⭐ THE JACOBIAN OF THE COMPOSED SURFACE: J = (1 + Σλ·Dxx)(1 + Σλ·Dzz) −
 * (Σλ·Dxz)², summed over the cascades BEFORE the product — the horizontal
 * displacement gradient of the surface the eye sees, not of any one layer.
 * Below zero the surface has folded over itself; that is what foam is made
 * of, and `seaFoamNode` turns its deficit into a source for the foam field.
 * `crossSum` is `seaDisplacementAt(...).w`, already sampled by the caller.
 */
export function seaJacobianAt(spectrum, world, crossSum, lods = null) {
  let dxx = float(0), dzz = float(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    let s = spectrum.nodes.derivatives.sample(uv).depth(i);
    if (lods) s = s.level(lods[i]);
    dxx = dxx.add(s.z); dzz = dzz.add(s.w);
  });
  return dxx.add(1).mul(dzz.add(1)).sub(crossSum.mul(crossSum));
}
/**
 * The sea's slope (dy/dx, dy/dz, world) from the derivative cascades —
 * Babylon's `slope = (d.x/(1+d.z), d.y/(1+d.w))`, the horizontal displacement
 * folded into the denominator. `weights[i]` fades a cascade (distance LOD,
 * `surfaceDetail`); `lods` as above.
 */
export function seaSlopeAt(spectrum, world, { lods = null, weights = null } = {}) {
  let d = vec4(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    let s = spectrum.nodes.derivatives.sample(uv).depth(i);
    if (lods) s = s.level(lods[i]);
    if (weights) s = s.mul(weights[i]);
    d = d.add(s);
  });
  return vec2(d.x.div(d.z.add(1)), d.y.div(d.w.add(1)));
}
/**
 * Jacobian foam on the COMPOSED surface: `foam` sets how far into folding a
 * crest has to be. J is 1 on flat water and crosses 0 as the surface folds;
 * at `foam` 1 a crest past J = 0.4 (well into breaking) counts, at 0.25 it
 * takes J < −0.3 — folded right over. This is a SOURCE for the persistent
 * foam field (gridSimulation), which is what gives a fold's foam its life
 * after the crest has moved on.
 */
/**
 * The FOLD itself — the rare event that seeds the persistent foam field
 * (the memory: foam that trails a breaking crest for seconds). Independent
 * of `foam`: at the folding limit the composed Jacobian's first percentile
 * sits near 0.5 on a pond and on an ocean alike, so this opens on the
 * steepest one or two percent of crests. The visible whitecaps are
 * `seaFoamNode`, per pixel and instantaneous; feeding THAT to the field
 * turned a pool into a 90 % sheet within a second (harness, 2026-09-06).
 */
export function seaFoldNode(jacobian) {
  return float(.45).sub(jacobian).div(.15).clamp(0, 1);
}
/**
 * The whitecap memory at a world point (see FOAM_WINDOW_METRES): 0–1, fading
 * to nothing over the window's outer 4 %. `level` for a compute stage (no
 * screen derivatives); a fragment lets the hardware pick — the mips are a
 * COVERAGE, so a far pixel reads the fraction of its footprint that foams.
 */
export function seaFoamWindowNode(spectrum, world, level = null) {
  const f = spectrum.foam;
  if (!f) return float(0);
  const uv = world.sub(f.center).div(f.half.mul(2)).add(.5).toVar();
  const margin = uv.x.min(uv.x.oneMinus()).min(uv.y).min(uv.y.oneMinus());
  let s = spectrum.nodes.foam.sample(uv.clamp(.001, .999));
  if (level != null) s = s.level(level);
  return s.x.mul(margin.smoothstep(0, .04));
}
export function seaFoamNode(jacobian, foam) {
  // ⚠ THE GATE IS ON J ITSELF. It used to open at 1 − J > mix(1.3, .6, foam),
  // i.e. J < −0.3 … 0.4 — and at the ocean preset with full choppiness the
  // composed Jacobian never drops below 0.2 (p1 0.52, p5 0.64, measured on
  // the CPU model, 2026-09-06): whitecaps could not exist by construction.
  // A whitecap is a crest steep enough to fold, and the folding limit keeps
  // the sea just short of it, so the gate sits in the steep tail: `foam` 0
  // opens at J < 0.45 (nothing at the limit), 1 at J < 0.85 (the steepest
  // third), 0.7 — the ocean preset's crests — at J < 0.73.
  return mix(float(.45), float(.85), foam).sub(jacobian).div(.25).clamp(0, 1);
}
/**
 * The per-pixel shading slope: every cascade with Babylon's distance fade
 * (min(LOD_SCALE × L / viewDist, 1) — a cascade drops out of the normal as its
 * texels fall under a pixel). This is what replaced the value-noise "detail
 * normal": real waves, at every scale the spectrum carries, band-limited by
 * the hardware mip chain.
 *
 * `surfaceDetail` is the SUB-VERTEX part of that slope: the difference between
 * the cascades at full resolution and the same cascades at the mip the mesh's
 * vertices sample (`vertexLods`, the solver's `seaLod`). At 0 the pixel normal
 * carries exactly what the geometry does; at 2 the structure finer than a
 * vertex is doubled. Defined this way it works at any peak wavelength — as
 * "the weight of the finest cascade" it scaled a cascade that, on a short
 * peak, carries nothing ("DEAD surfaceDetail", the property sweep, 2026-09-06).
 */
/**
 * The slope variance the shading normal has LOST to distance: each cascade
 * fades out of `seaShadingSlopeNode` as its texels fall under a pixel, and
 * the chop it carried must become ROUGHNESS or the far sea turns to glass —
 * a flat mirror of a flat sky with no sparkle in it (the ocean arm,
 * 2026-09-06). Toksvig's idea: variance that cannot be a normal is a lobe.
 */
export function seaLostSlopeVarianceNode(spectrum) {
  const viewDist = positionWorld.sub(cameraPosition).length();
  let lost = float(0);
  for (const c of spectrum.cascades) {
    const fade = float(1).div(c.uniforms.invL).mul(LOD_SCALE).div(viewDist.max(1e-3)).min(1);
    lost = lost.add(fade.oneMinus().mul(c.uniforms.slopeVariance));
  }
  return lost;
}
export function seaShadingSlopeNode(spectrum, world, surfaceDetail, vertexLods = null) {
  const viewDist = positionWorld.sub(cameraPosition).length();
  let d = vec4(0);
  spectrum.cascades.forEach((c, i) => {
    const uv = world.add(spectrum.uniforms.scroll).mul(c.uniforms.invL).add(texelCentre(spectrum));
    const fade = float(1).div(c.uniforms.invL).mul(LOD_SCALE).div(viewDist.max(1e-3)).min(1);
    const full = spectrum.nodes.derivatives.sample(uv).depth(i);
    let s = full;
    if (vertexLods) {
      const coarse = spectrum.nodes.derivatives.sample(uv).depth(i).level(vertexLods[i]);
      s = coarse.add(full.sub(coarse).mul(surfaceDetail));
    }
    d = d.add(s.mul(fade));
  });
  return vec2(d.x.div(d.z.add(1)), d.y.div(d.w.add(1)));
}
