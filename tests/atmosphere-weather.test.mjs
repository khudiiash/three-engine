import test from "node:test";
import assert from "node:assert/strict";
import {
  WEATHER_CHANNELS, WEATHER_NAMES, WEATHER_PRESETS, applyThermalPhase, blendWeather, makeRandom, scaleWeather,
  stepAccumulation, stepAutoWeather, transitionWeights, weatherPreset,
} from "../src/modules/atmosphere/weather.js";

/**
 * The weather model is a pure function, so a whole simulated year runs in a
 * millisecond — which is the only way to assert the claims that actually
 * matter about it: that a July scene at 45° N never snows, that a January one
 * does, and that the same seed replays exactly.
 */

test("every preset fills every channel", () => {
  for (const name of WEATHER_NAMES) {
    const preset = weatherPreset(name);
    for (const key of Object.keys(WEATHER_CHANNELS)) {
      assert.equal(typeof preset[key], "number", `${name}.${key}`);
      assert.ok(Number.isFinite(preset[key]), `${name}.${key} is finite`);
    }
  }
  // An unknown name is clear weather, not a crash: a scene may hold a preset
  // name from a future version.
  assert.deepEqual(weatherPreset("nonsense"), weatherPreset("clear"));
});

test("presets get darker and windier as they get worse", () => {
  const order = ["clear", "fair", "cloudy", "overcast", "rain", "storm"];
  for (let i = 1; i < order.length; i++) {
    const before = WEATHER_PRESETS[order[i - 1]], after = WEATHER_PRESETS[order[i]];
    assert.ok(after.cloudCover >= before.cloudCover, `${order[i]} covers more sky than ${order[i - 1]}`);
    assert.ok(after.sunLight <= before.sunLight, `${order[i]} passes less sun than ${order[i - 1]}`);
  }
  // ⛔ The one that matters for the look: under a real overcast there are no
  // shadows. A first cut had 0.34 here and the scene still cast a crisp sun
  // shadow through a solid lid of cloud.
  assert.ok(WEATHER_PRESETS.overcast.sunLight < 0.12, "overcast leaves no direct sun");
  assert.ok(WEATHER_PRESETS.storm.sunLight < 0.05);
});

test("blending is channel-wise and clamped", () => {
  const a = weatherPreset("clear"), b = weatherPreset("storm");
  const half = blendWeather(a, b, 0.5);
  for (const key of Object.keys(WEATHER_CHANNELS)) {
    assert.ok(Math.abs(half[key] - (a[key] + b[key]) / 2) < 1e-12, key);
  }
  assert.deepEqual(blendWeather(a, b, -3), a);
  assert.deepEqual(blendWeather(a, b, 7), b);
});

test("severity blends towards clear, never towards zero", () => {
  const storm = weatherPreset("storm");
  assert.deepEqual(scaleWeather(storm, 0), weatherPreset("clear"));
  assert.deepEqual(scaleWeather(storm, 1), storm);
  const mild = scaleWeather(storm, 0.2);
  // ⚠ The trap this pins: multiplying every channel by 0.2 would take
  // `sunLight` to 0.004 — a fifth of a storm would be DARKER than the storm.
  assert.ok(mild.sunLight > storm.sunLight, "a milder storm is brighter, not darker");
  assert.ok(mild.turbidity < storm.turbidity && mild.turbidity > 2, "turbidity stays physical");
  assert.ok(mild.rain < storm.rain && mild.rain > 0);
});

test("the same seed replays the same weather", () => {
  const run = () => {
    const state = { random: makeRandom(7) };
    const seen = [];
    for (let i = 0; i < 400; i++) {
      stepAutoWeather(state, 0.25, { seed: 7, temperature: 14, seasonPhase: 0.3, hour: (i / 4) % 24 });
      seen.push(state.current);
    }
    return seen.join(",");
  };
  assert.equal(run(), run());
  const other = (() => {
    const state = { random: makeRandom(8) };
    const seen = [];
    for (let i = 0; i < 400; i++) {
      stepAutoWeather(state, 0.25, { seed: 8, temperature: 14, seasonPhase: 0.3, hour: (i / 4) % 24 });
      seen.push(state.current);
    }
    return seen.join(",");
  })();
  assert.notEqual(run(), other, "a different seed is a different year");
});

test("a warm year never snows and a cold one never rains", () => {
  const sample = (temperature) => {
    const state = { current: "cloudy", random: makeRandom(3) };
    const seen = new Set();
    for (let i = 0; i < 3000; i++) {
      stepAutoWeather(state, 0.3, { seed: 3, temperature, seasonPhase: 0.25, hour: (i / 3) % 24 });
      seen.add(state.current);
    }
    return seen;
  };
  const summer = sample(24);
  assert.ok(!summer.has("snow") && !summer.has("blizzard"), `a 24 °C year: ${[...summer]}`);
  assert.ok(summer.has("rain") || summer.has("drizzle"), "…but it does rain");
  const winter = sample(-8);
  assert.ok(!winter.has("rain") && !winter.has("drizzle"), `a -8 °C year: ${[...winter]}`);
  assert.ok(winter.has("snow"), "…and it snows");
});

test("the thermometer splits precipitation without changing how much falls", () => {
  const warm = applyThermalPhase({ ...weatherPreset("rain") }, 14);
  assert.ok(warm.rain > 0.6 && warm.snow === 0, `warm rain: ${JSON.stringify(warm)}`);
  const cold = applyThermalPhase({ ...weatherPreset("rain") }, -6);
  assert.equal(cold.rain, 0, "a rain preset at -6 °C falls as snow");
  assert.ok(Math.abs(cold.snow - WEATHER_PRESETS.rain.rain) < 1e-9, "…and all of it falls");
  const sleet = applyThermalPhase({ ...weatherPreset("rain") }, 1.5);
  assert.ok(sleet.rain > 0.2 && sleet.snow > 0.2, `1.5 °C is sleet: ${JSON.stringify(sleet)}`);
  // The one invariant: the phase split never creates or destroys water.
  for (const temperature of [-20, -1, 0, 1, 5, 30]) {
    const before = weatherPreset("snow");
    const after = applyThermalPhase({ ...before }, temperature);
    assert.ok(Math.abs((after.rain + after.snow) - (before.rain + before.snow)) < 1e-9, `${temperature} °C conserves`);
  }
});

test("the chain only moves to neighbours, and it always moves", () => {
  for (const name of WEATHER_NAMES) {
    const weights = transitionWeights(name, { temperature: 12, hour: 12 });
    assert.ok(Object.keys(weights).length > 0, `${name} has somewhere to go`);
    for (const [target, weight] of Object.entries(weights)) {
      assert.ok(WEATHER_NAMES.includes(target), `${name} → ${target} is a real weather`);
      assert.ok(weight > 0, `${name} → ${target} has weight`);
    }
    // Clear weather cannot become a thunderstorm without clouding over first.
    if (name === "clear") assert.ok(!weights.storm && !weights.rain, "a clear sky clouds over before it rains");
  }
});

test("thunder is a warm afternoon animal, fog a cold dawn one", () => {
  const afternoon = transitionWeights("overcast", { temperature: 26, hour: 15 });
  const midnight = transitionWeights("overcast", { temperature: 2, hour: 1 });
  assert.ok(afternoon.storm > midnight.storm * 3, `storm ${afternoon.storm} vs ${midnight.storm}`);
  const dawn = transitionWeights("cloudy", { temperature: 8, hour: 5 });
  const noon = transitionWeights("cloudy", { temperature: 8, hour: 13 });
  assert.ok(dawn.fog > noon.fog * 2, `fog ${dawn.fog} vs ${noon.fog}`);
});

test("weather dwells for a while before it changes", () => {
  const state = { current: "clear", random: makeRandom(5) };
  let changes = 0;
  for (let i = 0; i < 240; i++) {                       // ten simulated days
    const before = state.current;
    stepAutoWeather(state, 1, { seed: 5, temperature: 15, seasonPhase: 0.3, hour: i % 24 });
    if (state.current !== before) changes++;
  }
  // Roughly hourly rolls over ten days: a handful of fronts, not a flicker.
  assert.ok(changes > 2 && changes < 60, `${changes} weather changes in ten days`);
});

test("wetness and snow depth are integrators, not copies of the rate", () => {
  const wet = { wetness: 0, snowDepth: 0 };
  stepAccumulation(wet, 0.02, { rain: 1, temperature: 12 });      // ~1 minute of rain
  assert.ok(wet.wetness > 0.1 && wet.wetness < 1.0001, `wets fast: ${wet.wetness}`);
  const soaked = { wetness: 1, snowDepth: 0 };
  stepAccumulation(soaked, 0.5, { rain: 0, temperature: 25, sunLight: 1 });
  assert.ok(soaked.wetness < 0.7, `dries in warm sun: ${soaked.wetness}`);
  const shaded = { wetness: 1, snowDepth: 0 };
  stepAccumulation(shaded, 0.5, { rain: 0, temperature: 3, sunLight: 0 });
  assert.ok(shaded.wetness > soaked.wetness, "a cold sunless afternoon dries slower");

  const snow = { wetness: 0, snowDepth: 0 };
  for (let i = 0; i < 10; i++) stepAccumulation(snow, 1, { snow: 1, temperature: -4 });
  assert.ok(snow.snowDepth > 0.3, `ten hours of snow settles: ${snow.snowDepth} m`);
  for (let i = 0; i < 24; i++) stepAccumulation(snow, 1, { snow: 0, temperature: 12, sunLight: 1 });
  assert.ok(snow.snowDepth < 0.1, `a warm day melts it: ${snow.snowDepth} m`);
  const frozen = { wetness: 0, snowDepth: 0.5 };
  for (let i = 0; i < 24; i++) stepAccumulation(frozen, 1, { snow: 0, temperature: -6 });
  assert.ok(frozen.snowDepth > 0.49, "a cold day does not");
});
