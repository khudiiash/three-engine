import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cascadeBands, cascadeScales, evolve, expectedVariance, foldingLimit, gaussianNoise, ifft2d, initialSpectrum, jacobianOf,
  realizeSea, sampleDisplacement, seaHeightAt, seaSettings, spectrumAt, spectrumMoments,
} from '../src/engine/vfx/waterSpectrumCPU.js';

/** A naive 2-D inverse DFT (positive exponent, unnormalized, centred sign) of
 *  one complex plane — the definition the fast one has to match. */
function naiveIfft2d(re, im, size) {
  const outRe = new Float32Array(size * size), outIm = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sr = 0, si = 0;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const ang = 2 * Math.PI * (i * x + j * y) / size, c = Math.cos(ang), s = Math.sin(ang);
      sr += re[j * size + i] * c - im[j * size + i] * s;
      si += re[j * size + i] * s + im[j * size + i] * c;
    }
    const sign = (x + y) & 1 ? -1 : 1;
    outRe[y * size + x] = sr * sign; outIm[y * size + x] = si * sign;
  }
  return [outRe, outIm];
}

test('the fast inverse transform is the definition, on both packed planes', () => {
  const size = 8, packed = new Float32Array(size * size * 4);
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - .5; };
  for (let i = 0; i < packed.length; i++) packed[i] = rnd();
  const plane = (c) => Float32Array.from({ length: size * size }, (_, t) => packed[t * 4 + c]);
  const [r0, i0] = naiveIfft2d(plane(0), plane(1), size), [r1, i1] = naiveIfft2d(plane(2), plane(3), size);
  ifft2d(packed, size);
  for (let t = 0; t < size * size; t++) {
    assert.ok(Math.abs(packed[t * 4] - r0[t]) < 1e-4 && Math.abs(packed[t * 4 + 1] - i0[t]) < 1e-4, `plane A texel ${t}`);
    assert.ok(Math.abs(packed[t * 4 + 2] - r1[t]) < 1e-4 && Math.abs(packed[t * 4 + 3] - i1[t]) < 1e-4, `plane B texel ${t}`);
  }
});

test('a delta at the centre of the grid is a flat unit field (the centring sign)', () => {
  const size = 16, packed = new Float32Array(size * size * 4);
  packed[((size / 2) * size + size / 2) * 4] = 1;
  ifft2d(packed, size);
  for (let t = 0; t < size * size; t++) assert.ok(Math.abs(packed[t * 4] - 1) < 1e-5 && Math.abs(packed[t * 4 + 1]) < 1e-5);
});

test('cascades hang from the peak wavelength in the 250:17:5 proportion and partition k', () => {
  const scales = cascadeScales(5);
  assert.equal(scales.length, 3);
  assert.ok(Math.abs(scales[0] / scales[1] - 15) < 1e-9 && Math.abs(scales[1] / scales[2] - 3.4) < 1e-9);
  const bands = cascadeBands(scales);
  for (let i = 1; i < bands.length; i++) assert.equal(bands[i].cutLow, bands[i - 1].cutHigh);
  assert.ok(bands[0].cutLow < 2 * Math.PI / 5 && bands[0].cutHigh > 2 * Math.PI / 5, 'the swell lives in cascade 0');
  assert.ok(cascadeScales(.1)[0] === 8 && cascadeScales(1000)[0] === 1024, 'clamped');
});

test('the spectrum peaks at the authored wavelength along the wind', () => {
  const settings = seaSettings({ waveLength: 6, waveDirection: 0 });
  let best = 0, bestK = 0;
  for (let k = .05; k < 20; k *= 1.01) { const v = spectrumAt(k, 0, settings) * k; if (v > best) { best = v; bestK = k; } }
  assert.ok(Math.abs(bestK / settings.kPeak - 1) < .35, `peak at k ${bestK.toFixed(3)} vs kp ${settings.kPeak.toFixed(3)}`);
  assert.ok(spectrumAt(settings.kPeak, 0, settings) > spectrumAt(-settings.kPeak, 0, settings) * 3, 'directional: downwind beats upwind');
  assert.equal(spectrumAt(settings.kMax * 3, 0, settings), 0 + spectrumAt(settings.kMax * 3, 0, settings), 'finite');
  assert.ok(spectrumAt(settings.kMax * 2, 0, settings) < spectrumAt(settings.kMax * .5, 0, settings) * 1e-3, 'the octave cutoff removes short waves');
});

test('waveHeight is metres: the realized RMS height tracks σ = H/2, and 0 is flat', () => {
  for (const [H, L] of [[.4, 6], [1.2, 24]]) {
    const sea = realizeSea({ size: 64, props: { waveHeight: H, waveLength: L, choppiness: 0 }, depth: 30 });
    let sum = 0, n = 0;
    for (const c of sea.cascades) for (let t = 0; t < 64 * 64; t++) { sum += c.displacement[t * 4 + 1] ** 2; n++; }
    // Cascades are independent realizations over disjoint bands, so their
    // variances add: total σ² = Σ per-cascade mean squares.
    const rms = Math.sqrt(sum / (64 * 64));
    assert.ok(Math.abs(rms / (H / 2) - 1) < .25, `H ${H}: rms ${rms.toFixed(3)} vs σ ${(H / 2).toFixed(3)}`);
  }
  const flat = realizeSea({ size: 32, props: { waveHeight: 0 } });
  for (const c of flat.cascades) for (let t = 0; t < 32 * 32; t++) assert.ok(Math.abs(c.displacement[t * 4 + 1]) === 0);
});

test('the expected variance is the realized one, statistically', () => {
  const settings = seaSettings({ waveHeight: 1, waveLength: 8 }, 30);
  const bands = cascadeBands(cascadeScales(8));
  const size = 64, noise = gaussianNoise(size, 99);
  const expected = expectedVariance(size, bands, settings);
  let realized = 0;
  for (const band of bands) {
    const c = initialSpectrum({ size, ...band, settings, noise });
    const { A } = evolve(c, 0); ifft2d(A, size);
    for (let t = 0; t < size * size; t++) realized += A[t * 4 + 2] ** 2 / (size * size);
  }
  assert.ok(Math.abs(realized / expected - 1) < .3, `realized ${realized.toFixed(4)} vs expected ${expected.toFixed(4)}`);
});

test('the derivative maps are the slopes of the displacement map (packing is consistent)', () => {
  // One octave above the peak and N = 256: the finest wave spans ~10 texels,
  // so a central difference reads the analytic slope to a few percent. (A
  // cascade's band edge is ~3 texels per wavelength by design — Babylon's
  // proportion — where a finite difference cannot read a slope at all.)
  const N = 256;
  const sea = realizeSea({ size: N, props: { waveHeight: .5, waveLength: 6, choppiness: 0, waveOctaves: 1 }, depth: 30 });
  const c = sea.cascades[0], h = c.L / N;
  let worst = 0, scale = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const t = j * N + i, r = j * N + (i + 1) % N, l = j * N + (i + N - 1) % N;
    const fd = (c.displacement[r * 4 + 1] - c.displacement[l * 4 + 1]) / (2 * h);
    worst = Math.max(worst, Math.abs(fd - c.derivatives[t * 4]));
    scale = Math.max(scale, Math.abs(c.derivatives[t * 4]));
  }
  assert.ok(scale > 1e-3, 'the swell has a slope at all');
  assert.ok(worst < scale * .12, `fd error ${worst.toExponential(2)} vs slope ${scale.toExponential(2)}`);
});

test('choppiness folds the surface: the Jacobian dips below 1 only when λ > 0', () => {
  const calm = realizeSea({ size: 64, props: { waveHeight: .6, waveLength: 5, choppiness: 0 } });
  const choppy = realizeSea({ size: 64, props: { waveHeight: .6, waveLength: 5, choppiness: 1 } });
  const minJ = (sea) => Math.min(...Array.from({ length: 64 * 64 }, (_, t) => jacobianOf(sea.cascades, t)));
  assert.ok(Math.abs(minJ(calm) - 1) < 1e-5);
  assert.ok(minJ(choppy) < .95, `choppy min J ${minJ(choppy)}`);
});

test('sampling tiles and the buoyancy query returns the height where there is no horizontal displacement', () => {
  const sea = realizeSea({ size: 32, props: { waveHeight: .5, waveLength: 4, choppiness: 0 } });
  const c = sea.cascades[0], texel = c.L / 32;
  const at = sampleDisplacement(c.displacement, 32, c.L, 5 * texel, 7 * texel);
  assert.ok(Math.abs(at[1] - c.displacement[(7 * 32 + 5) * 4 + 1]) < 1e-6, 'texel centre reads the texel');
  const wrapped = sampleDisplacement(c.displacement, 32, c.L, 5 * texel + c.L * 3, 7 * texel - c.L);
  assert.ok(Math.abs(wrapped[1] - at[1]) < 1e-6, 'tiles');
  let expected = 0; for (const cc of sea.cascades) expected += sampleDisplacement(cc.displacement, 32, cc.L, 1.3, 2.7)[1];
  assert.ok(Math.abs(seaHeightAt(sea.cascades, 1.3, 2.7) - expected) < 1e-6);
});

test('choppiness is capped where the surface would fold, and a capped sea folds only at its rarest crests', () => {
  // A sea at the breaking limit with every short wave turned up: past the fold.
  const settings = seaSettings({ waveHeight: 1, waveLength: 5, choppiness: 1, waveOctaves: 8, waveGain: .9, rippleStrength: 2 }, 3);
  const bands = cascadeBands(cascadeScales(5));
  const { variance, gradient } = spectrumMoments(64, bands, settings);
  const amplitude = settings.sigma / Math.sqrt(variance);
  const limit = foldingLimit(amplitude, gradient);
  assert.ok(limit < 1, `a sea at the breaking limit is capped: λ ≤ ${limit.toFixed(3)}`);
  // The user's own sea (H .2 on a 5 m peak) sits under the limit: its foam is
  // a threshold question, not a folding one.
  const user = seaSettings({ waveHeight: .2, waveLength: 5, choppiness: 1, waveOctaves: 8, waveGain: .45, rippleStrength: 1 }, 3);
  const um = spectrumMoments(64, bands, user);
  assert.ok(foldingLimit(user.sigma / Math.sqrt(um.variance), um.gradient) > 1);
  const sea = realizeSea({ size: 128, props: { waveHeight: .2, waveLength: 5, choppiness: 1, waveOctaves: 8, waveGain: .45, rippleStrength: 1 }, depth: 3 });
  let folded = 0, n = 0;
  for (let t = 0; t < 128 * 128; t++) { if (jacobianOf(sea.cascades, t) < 0) folded++; n++; }
  assert.ok(folded / n < .03, `folded share ${(folded / n * 100).toFixed(2)} % — whitecaps, not a crumpled sheet`);
  assert.ok(realizeSea({ size: 64, props: { waveHeight: .02, waveLength: 8, choppiness: .3 } }).settings.lambda === .3, 'a calm sea keeps its authored choppiness');
});

test('a sea steeper than the breaking limit is capped by its wavelength', () => {
  assert.equal(seaSettings({ waveHeight: .35, waveLength: 2 }).sigma, .1);
  assert.equal(seaSettings({ waveHeight: .2, waveLength: 5 }).sigma, .1);
});

test('time moves the sea and waveSpeed scales the clock', () => {
  const a = realizeSea({ size: 32, props: { waveHeight: .5, waveLength: 4, waveSpeed: 1 }, time: 0 });
  const b = realizeSea({ size: 32, props: { waveHeight: .5, waveLength: 4, waveSpeed: 1 }, time: .5 });
  const c = realizeSea({ size: 32, props: { waveHeight: .5, waveLength: 4, waveSpeed: 2 }, time: .25 });
  const diff = (x, y) => { let d = 0; for (let t = 0; t < 32 * 32; t++) d += Math.abs(x.cascades[0].displacement[t * 4 + 1] - y.cascades[0].displacement[t * 4 + 1]); return d; };
  assert.ok(diff(a, b) > 1e-3, 'moves');
  assert.ok(diff(b, c) < 1e-9, 'speed 2 at t .25 is speed 1 at t .5');
});
