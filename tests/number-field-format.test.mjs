import test from "node:test";
import assert from "node:assert/strict";
import { decimalsFor, formatNumber, tidy } from "../src/editor/fields/numberFormat.js";

/**
 * THE BUG THIS FILE EXISTS FOR (2026-09-11): the Inspector's number field
 * formatted every value at a fixed 3 decimals, and it seeds its edit draft from
 * that text on focus and commits the draft on blur. So a light's default
 * `shadowBias` of -0.0005 displayed as "0", and clicking into the Bias field
 * and clicking away silently wrote 0 over it.
 */

test("a shadow bias survives the round trip its field puts it through", () => {
  const step = 0.0005; // LightComponent's shadowBias step
  const bias = -0.0005; // LightComponent's shadowBias default

  // Before the fix this was "0" — the value was not merely mis-displayed, it
  // was unrepresentable, and the field committed the "0" back on blur.
  assert.equal(formatNumber(bias, step), "-0.0005");
  assert.equal(parseFloat(formatNumber(bias, step)), bias, "focus → blur must not change the value");

  // The whole useful range for three's shadow bias has to survive too.
  for (const v of [-0.0001, -0.00025, -0.0005, -0.001, -0.002, 0.0005]) {
    assert.equal(parseFloat(formatNumber(v, step)), v, `bias ${v} round-trips`);
  }
});

test("normal bias and other fine steps round-trip at their own precision", () => {
  assert.equal(parseFloat(formatNumber(0.02, 0.005)), 0.02);
  assert.equal(parseFloat(formatNumber(0.0025, 0.005)), 0.0025);
});

test("coarse fields read exactly as they did before (never fewer than 3 decimals)", () => {
  // Position-style fields default to step 0.1 and used to show 3 decimals.
  assert.equal(decimalsFor(0.1), 3);
  assert.equal(decimalsFor(1), 3);
  assert.equal(decimalsFor(undefined), 3);
  assert.equal(formatNumber(1.2345, 0.1), "1.234");
  assert.equal(formatNumber(0.5, 0.1), "0.5", "no trailing zeros");
  assert.equal(formatNumber(2, 0.1), "2");
});

test("precision follows the step, and is bounded so it cannot print float noise", () => {
  assert.equal(decimalsFor(0.0005), 5);
  assert.equal(decimalsFor(0.005), 4);
  assert.equal(decimalsFor(1e-9), 6, "clamped at 6 decimals");
});

test("non-numbers are still text-safe", () => {
  assert.equal(formatNumber(NaN, 0.1), "0");
  assert.equal(formatNumber(undefined, 0.1), "0");
  assert.equal(formatNumber(null, 0.1), "0");
});

test("tidy still trims drag-accumulated float noise", () => {
  assert.equal(tidy(0.30000000000000004, 0.1), 0.3);
  assert.equal(tidy(-0.0005000000001, 0.0005), -0.0005);
});
