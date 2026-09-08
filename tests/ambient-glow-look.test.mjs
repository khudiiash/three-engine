import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AMBIENT_GLOW_DEFAULTS,
  getAmbientGlowLook,
  onAmbientGlowLook,
  setAmbientGlowLook,
} from "../src/editor/ambientGlowLook.js";

test("defaults are a 50 px halo at just over half strength", () => {
  assert.equal(AMBIENT_GLOW_DEFAULTS.spread, 50);
  assert.equal(AMBIENT_GLOW_DEFAULTS.intensity, 0.55);
  assert.deepEqual(getAmbientGlowLook(), AMBIENT_GLOW_DEFAULTS);
});

test("one number can be set without disturbing the other", () => {
  setAmbientGlowLook({ spread: 120 });
  assert.deepEqual(getAmbientGlowLook(), { spread: 120, intensity: 0.55 });
  setAmbientGlowLook({ intensity: 0.2 });
  assert.deepEqual(getAmbientGlowLook(), { spread: 120, intensity: 0.2 });
});

test("values out of range are clamped rather than refused", () => {
  setAmbientGlowLook({ spread: 9999, intensity: 4 });
  assert.deepEqual(getAmbientGlowLook(), { spread: 400, intensity: 1 });
  setAmbientGlowLook({ spread: -10, intensity: -1 });
  assert.deepEqual(getAmbientGlowLook(), { spread: 0, intensity: 0 });
});

test("garbage falls back to the default instead of poisoning the layer", () => {
  setAmbientGlowLook({ spread: Number.NaN, intensity: "not a number" });
  assert.deepEqual(getAmbientGlowLook(), AMBIENT_GLOW_DEFAULTS);
});

test("listeners hear real changes and not no-ops", () => {
  const seen = [];
  const off = onAmbientGlowLook((look) => seen.push({ ...look }));
  setAmbientGlowLook({ spread: 80 });
  setAmbientGlowLook({ spread: 80 }); // same value: nothing to announce
  off();
  setAmbientGlowLook({ spread: 30 }); // after unsubscribing
  assert.deepEqual(seen, [{ spread: 80, intensity: 0.55 }]);
});
