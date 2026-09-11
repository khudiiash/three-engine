import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { celestialState } from "../src/modules/atmosphere/sunCycle.js";
import { weatherPreset } from "../src/modules/atmosphere/weather.js";
import {
  SUN_PEAK, celestialLight, equirectDirection, fillSkyEquirect, floatToHalf, fogColor, measureSky,
  sampleSkyIrradiance, skyParameters,
} from "../src/modules/atmosphere/skyModel.js";
import { describeSkySource, describeSun, integrateEquirectBins, skyLumaCeiling } from "../src/modules/gi/srcSkyBins.js";

const WIDTH = 128, HEIGHT = 64;
const LUMA = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

function halfToFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function sky({ hour = 12, dayOfYear = 172, latitude = 45, weather = "clear", ...rest } = {}) {
  const celestial = celestialState({ hour, dayOfYear, latitude });
  const parameters = skyParameters({
    sunDirection: celestial.sun.direction,
    moonDirection: celestial.moon.direction,
    moonIllumination: celestial.moon.illumination,
    weather: weatherPreset(weather),
    ...rest,
  });
  measureSky(parameters);
  const data = new Uint16Array(WIDTH * HEIGHT * 4);
  fillSkyEquirect(data, WIDTH, HEIGHT, parameters);
  return { celestial, parameters, data, light: celestialLight(parameters) };
}

test("half-float packing round-trips the range a sky uses", () => {
  for (const value of [0, 1e-4, 0.5, 1, 3.6, 60, 1000]) {
    const back = halfToFloat(floatToHalf(value));
    assert.ok(Math.abs(back - value) <= Math.max(1e-6, value * 0.002), `${value} → ${back}`);
  }
  assert.equal(halfToFloat(0x3c00), 1, "the alpha constant really is 1.0");
});

test("half-float packing carries the mantissa's rounding into the exponent", () => {
  // ⛔⛔ THE BUG THIS EXISTS FOR, and it cost four rounds of hunting. Rounding
  // the mantissa up can carry OUT of it; the carry is the exponent field's
  // lowest bit and must be ADDED. The first version OR-ed it in, which works
  // only while that bit is clear — for an ODD exponent the carry landed on a
  // bit that was already 1 and vanished, and the value came back HALVED.
  //
  // One channel of one texel at half brightness, bilinearly smeared across ~3°
  // of sky, is a soft coloured blob that moves as the sky changes: the user's
  // "random colour spots in the sky", reported three times. The list above
  // could not catch it — every value in it has an even exponent or an exact
  // mantissa.
  for (const value of [0.4999999, 1.9999999, 7.999625, 0.031248, 0.0019531, 0.12499999]) {
    const back = halfToFloat(floatToHalf(value));
    assert.ok(Math.abs(back - value) / value < 0.002,
      `${value} must not be halved: got ${back} (ratio ${back / value})`);
  }
  // And the whole range, densely: nothing may be off by more than half a step.
  let worst = 0, worstValue = 0;
  for (let i = 0; i < 200000; i++) {
    const value = 10 ** (Math.random() * 5 - 4);          // 1e-4 … 10
    const error = Math.abs(halfToFloat(floatToHalf(value)) - value) / value;
    if (error > worst) { worst = error; worstValue = value; }
  }
  assert.ok(worst < 0.001, `worst relative packing error ${worst} at ${worstValue}`);
});

test("the equirect direction convention is three's, exactly", () => {
  // ⭐ THIS IS THE CONTRACT WITH GI AND WITH THE BACKGROUND SHADER. `equirectUV`
  // is u = atan2(z, x)/2π + ½, v = asin(y)/π + ½, and `srcSkyBins` walks rows
  // bottom-up on the same convention. Get it wrong and the sky is mirrored or
  // upside down in the lighting while the picture stays right — which is
  // exactly the kind of bug nobody finds by looking.
  const direction = [0, 0, 0];
  for (const [column, row] of [[0, 0], [31, 12], [64, 32], [127, 63]]) {
    equirectDirection(column, row, WIDTH, HEIGHT, direction);
    const [x, y, z] = direction;
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-12, "unit length");
    const u = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
    const v = Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI + 0.5;
    assert.ok(Math.abs(u - (column + 0.5) / WIDTH) < 1e-9, `u at ${column}: ${u}`);
    assert.ok(Math.abs(v - (row + 0.5) / HEIGHT) < 1e-9, `v at ${row}: ${v}`);
  }
  // Row 0 is the nadir, the last row the zenith.
  assert.ok(equirectDirection(0, 0, WIDTH, HEIGHT, direction)[1] < -0.99);
  assert.ok(equirectDirection(0, HEIGHT - 1, WIDTH, HEIGHT, direction)[1] > 0.99);
});

test("a sliced fill is byte-identical to a whole one", () => {
  // ⛔ THE INVARIANT THE THROTTLE RESTS ON. The component fills 16 rows a frame
  // to keep a 1.5 ms refresh out of any single frame; if a slice differed from
  // the whole — a running sum, a per-call random, anything stateful — the sky
  // would band, and it would band only on the slow path nobody tests by eye.
  const { parameters } = sky({ hour: 17.5, weather: "cloudy" });
  const whole = new Uint16Array(WIDTH * HEIGHT * 4);
  fillSkyEquirect(whole, WIDTH, HEIGHT, parameters);
  const sliced = new Uint16Array(WIDTH * HEIGHT * 4);
  for (let row = 0; row < HEIGHT; row += 16) {
    fillSkyEquirect(sliced, WIDTH, HEIGHT, parameters, { rowStart: row, rowCount: 16 });
  }
  assert.deepEqual(sliced, whole);
});

test("every texel is finite and non-negative, at every hour", () => {
  for (let hour = 0; hour < 24; hour += 0.5) {
    const { data } = sky({ hour, weather: hour % 6 < 3 ? "clear" : "storm" });
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const value = halfToFloat(data[i + c]);
        assert.ok(Number.isFinite(value) && value >= 0, `hour ${hour} texel ${i / 4} channel ${c}: ${value}`);
      }
    }
  }
});

test("night is dark, and the light hands over to the moon", () => {
  const noon = sky({ hour: 12 });
  const midnight = sky({ hour: 0 });
  const ratio = LUMA(noon.parameters.irradiance) / LUMA(midnight.parameters.irradiance);
  // Real life is 400 000:1, which no display can show. This is the authored
  // compression, and it is a decision worth pinning: at 15:1 (the first cut) a
  // moonlit night read as an overcast afternoon.
  assert.ok(ratio > 40 && ratio < 500, `day:night is ${ratio}:1`);
  const moonless = sky({ hour: 0, dayOfYear: 8 });   // ~new moon, see the sun tests
  assert.ok(LUMA(moonless.parameters.irradiance) < LUMA(midnight.parameters.irradiance),
    "a moonless night is darker than a moonlit one");
  assert.equal(noon.light.body, "sun");
  assert.equal(midnight.light.body, "moon");
  assert.ok(noon.light.intensity > 2 && noon.light.intensity < SUN_PEAK, `midday sun ${noon.light.intensity}`);
  assert.ok(midnight.light.intensity > 0 && midnight.light.intensity < 0.2, `moonlight ${midnight.light.intensity}`);
  // ⚠ The handover must not leave a light pointing at nothing: a lerp between
  // two unit vectors is not one.
  for (const state of [noon, midnight, sky({ hour: 19.9 }), sky({ hour: 4.5 })]) {
    const length = Math.hypot(...state.light.direction);
    assert.ok(Math.abs(length - 1) < 1e-9, `unit light direction: ${length}`);
  }
});

test("weather takes the sun away and the storm is darker than the day", () => {
  const clear = sky({ hour: 12, weather: "clear" });
  const overcast = sky({ hour: 12, weather: "overcast" });
  const storm = sky({ hour: 12, weather: "storm" });
  assert.ok(overcast.light.intensity < clear.light.intensity * 0.15, "an overcast noon casts no real shadow");
  assert.ok(storm.light.intensity < overcast.light.intensity, "a storm is darker still");
  const total = (s) => s.light.intensity + LUMA(s.parameters.irradiance);
  assert.ok(total(overcast) < total(clear) * 0.45, `overcast ${total(overcast)} vs clear ${total(clear)}`);
  assert.ok(total(storm) < total(overcast), `storm ${total(storm)} vs overcast ${total(overcast)}`);
  // ⛔ The bug this pins: an earlier cut gave the cloud deck back ALL the light
  // it took from the beam, and a thunderstorm came out brighter than noon.
  assert.ok(LUMA(storm.parameters.irradiance) < LUMA(clear.parameters.irradiance) * 1.05,
    `storm sky ${LUMA(storm.parameters.irradiance)} vs clear ${LUMA(clear.parameters.irradiance)}`);
});

test("the sunset is red because the air made it red", () => {
  const noon = sky({ hour: 12 });
  const sunset = sky({ hour: 19.65 });
  const warmth = (state) => state.light.color[0] / Math.max(1e-4, state.light.color[2]);
  assert.ok(warmth(sunset) > 8 * warmth(noon), `sunset ${warmth(sunset)} vs noon ${warmth(noon)}`);
  assert.ok(sunset.light.intensity < noon.light.intensity * 0.2, "and much dimmer");
  // The fog is the horizon's colour, so it is warm at sunset and never grey.
  const fog = fogColor(sunset.parameters);
  assert.ok(fog[0] > fog[2] * 1.8, `warm fog: ${fog}`);
  const noonFog = fogColor(noon.parameters);
  assert.ok(noonFog[2] >= noonFog[0] * 0.9, `a midday fog is not warm: ${noonFog}`);
});

test("the sun sets without a step in the light", () => {
  // A shadow that pops off is the classic day-cycle artefact. Sample the
  // handover minute by minute and cap the frame-to-frame change.
  let previous = null, worst = 0;
  for (let hour = 18.5; hour < 21; hour += 1 / 60) {
    const state = sky({ hour });
    if (previous) worst = Math.max(worst, Math.abs(state.light.intensity - previous));
    previous = state.light.intensity;
  }
  assert.ok(worst < 0.05, `largest one-minute jump in light intensity: ${worst}`);
});

test("the sky darkens smoothly across the whole day", () => {
  let previous = null, worst = 0;
  for (let hour = 0; hour < 24; hour += 1 / 60) {
    const parameters = sky({ hour }).parameters;
    const level = LUMA(parameters.irradiance);
    if (previous !== null) worst = Math.max(worst, Math.abs(level - previous));
    previous = level;
  }
  assert.ok(worst < 0.05, `largest one-minute jump in sky irradiance: ${worst}`);
});

test("the measured irradiance is the irradiance that was asked for", () => {
  for (const hour of [6.5, 9, 12, 16, 19.5, 23]) {
    const { parameters } = sky({ hour });
    const measured = LUMA(sampleSkyIrradiance(parameters)) * parameters.gain;
    assert.ok(Math.abs(measured - parameters.target) < parameters.target * 0.02,
      `hour ${hour}: measured ${measured} vs target ${parameters.target}`);
  }
});

// ── the contract with GI ────────────────────────────────────────────────────

function asTexture(data) {
  const texture = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.needsUpdate = true;
  return texture;
}

test("GI can read the sky map on the CPU", () => {
  // ⭐⭐ THE WHOLE REASON THE MAP IS A HALF-FLOAT DataTexture. `srcSkyBins`
  // integrates the environment per direction on the CPU and can only do that
  // for float or half-float data; anything else silently falls back to a
  // texture tap, and the procedural sky would light the scene as a flat colour
  // while still LOOKING right. Nothing about the picture would tell you.
  const { data } = sky({ hour: 12 });
  const source = describeSkySource(asTexture(data));
  assert.ok(source, "describeSkySource accepts the atmosphere's map");
  assert.equal(source.width, WIDTH);
  assert.equal(source.height, HEIGHT);
  assert.equal(source.channels, 4);
  assert.equal(source.half, true);
  assert.equal(source.flipY, false, "a DataTexture is not flipped, and the row walk assumes it");
});

test("the sky map carries no second sun", () => {
  // ⛔ THE FAILURE THIS PREVENTS HAS SHIPPED IN THIS PROJECT BEFORE: an HDRI's
  // sun carried into the probes beside the scene's real directional light, and
  // everything was lit twice. The model draws the aureole but never the disc,
  // so GI's own sun detector must find nothing worth extracting.
  for (const hour of [8, 12, 17]) {
    const { data } = sky({ hour });
    const source = describeSkySource(asTexture(data));
    const ceiling = skyLumaCeiling(source);
    const bins = integrateEquirectBins(source, { ceiling });
    const sun = describeSun(bins);
    assert.ok(!sun.present, `hour ${hour}: GI found a sun in the sky map (share ${sun.share})`);
  }
});

test("what GI integrates is the light the model promised", () => {
  const { data, parameters } = sky({ hour: 12 });
  const bins = integrateEquirectBins(describeSkySource(asTexture(data)));
  // `eUp` is the cosine-weighted irradiance of the upper hemisphere — the same
  // quantity `measureSky` normalises. They are computed by two different
  // integrators over two different grids, so they should agree to a few
  // percent, and disagreeing by more means one of them has the wrong weights.
  const modelled = LUMA(parameters.irradiance);
  assert.ok(Math.abs(bins.eUp - modelled) < modelled * 0.12,
    `GI reads ${bins.eUp}, the model says ${modelled}`);
});

// ── the cloud field ─────────────────────────────────────────────────────────

test("coverage is a fraction of the sky, not an arbitrary dial", async () => {
  const { cloudOpacityAt } = await import("../src/modules/atmosphere/cloudNoise.js");
  const sample = (coverage, density) => {
    let sum = 0, covered = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const value = cloudOpacityAt((i * 37) % 991 * 0.041, (i * 13) % 733 * 0.057, coverage, density);
      sum += value;
      if (value > 0.5) covered++;
    }
    return { mean: sum / N, covered: covered / N };
  };
  // ⛔ THE BUG THIS PINS — the user's "random colour circles in the sky". The
  // field is a sum of octaves, so it is roughly normal about 0.47, NOT uniform.
  // A linear coverage-to-threshold map put the threshold out in the 1 % tail at
  // low coverage: what survived was a handful of small round lit blobs.
  const clear = sample(0.03, 0.35);
  assert.ok(clear.mean < 0.02, `a clear sky is empty: ${JSON.stringify(clear)}`);
  const fair = sample(0.38, 0.45);
  assert.ok(fair.covered > 0.1 && fair.covered < 0.45, `fair is scattered cloud: ${JSON.stringify(fair)}`);
  const overcast = sample(0.97, 0.82);
  assert.ok(overcast.mean > 0.9, `an overcast sky is a lid: ${JSON.stringify(overcast)}`);
  // Monotone in coverage, which a threshold fitted to quantiles guarantees and
  // a hand-tuned one does not.
  let previous = -1;
  for (const coverage of [0, 0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
    const { mean } = sample(coverage, 0.6);
    assert.ok(mean >= previous - 1e-9, `coverage ${coverage} adds cloud (${mean} after ${previous})`);
    previous = mean;
  }
});
