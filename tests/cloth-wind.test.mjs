import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClothWind, windVector, SCENE_WIND_DEFAULTS } from '../src/engine/vfx/clothWind.js';

test('a cloth inherits the scene wind by default', () => {
  const scene = { vector: [1, 0, 3], gust: 4, gustFrequency: 0.5 };
  const wind = resolveClothWind({ wind: [0, 0, 9], gust: 99, gustFrequency: 7 }, scene);
  assert.deepEqual(wind.vector, [1, 0, 3]);
  assert.equal(wind.gust, 4);
  assert.equal(wind.gustFrequency, 0.5);
  assert.equal(wind.inherited, true, 'the cloth\'s own authored wind is ignored, not blended');
});

test('a cloth that opts out keeps its own weather', () => {
  const scene = { vector: [1, 0, 3], gust: 4, gustFrequency: 0.5 };
  const wind = resolveClothWind({ windSource: 'custom', wind: [0, 0, 9], gust: 99, gustFrequency: 7 }, scene);
  assert.deepEqual(wind.vector, [0, 0, 9]);
  assert.equal(wind.gust, 99);
  assert.equal(wind.gustFrequency, 7);
  assert.equal(wind.inherited, false);
});

/**
 * ⛔ "scene" must never mean "no wind at all" — a scene saved before this
 * existed has no wind block, and every cloth in it would go still.
 */
test('a scene with no wind block falls back to the solver defaults, not to zero', () => {
  const wind = resolveClothWind({}, null);
  assert.deepEqual(wind.vector, SCENE_WIND_DEFAULTS.vector);
  assert.equal(wind.gustFrequency, SCENE_WIND_DEFAULTS.gustFrequency);
  assert.equal(wind.inherited, true);
  // A partial block keeps the defaults for what it does not say.
  const partial = resolveClothWind({}, { gust: 6 });
  assert.deepEqual(partial.vector, SCENE_WIND_DEFAULTS.vector);
  assert.equal(partial.gust, 6);
});

/**
 * ⚠ Wind was a single number added to +Z before it became a vector, and every
 * scene saved then still says so.
 */
test('a scalar wind still loads as [0, 0, w]', () => {
  assert.deepEqual(windVector(5), [0, 0, 5]);
  assert.deepEqual(resolveClothWind({ windSource: 'custom', wind: 5 }, null).vector, [0, 0, 5]);
  assert.deepEqual(windVector(undefined), SCENE_WIND_DEFAULTS.vector);
  assert.deepEqual(windVector([1, 'x', 3]), [1, 0, 3], 'a corrupt lane reads as zero, not NaN');
});

test('gust strength and frequency are clamped to the ranges the solver accepts', () => {
  const wild = resolveClothWind({ windSource: 'custom', gust: 1e6, gustFrequency: -4 }, null);
  assert.equal(wild.gust, 100);
  assert.equal(wild.gustFrequency, 0);
  const nan = resolveClothWind({ windSource: 'custom', gust: NaN, gustFrequency: NaN }, null);
  assert.equal(nan.gust, 0);
  assert.equal(nan.gustFrequency, 1);
});
