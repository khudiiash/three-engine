import assert from "node:assert/strict";
import test from "node:test";
import { giEmitterShadowSize } from "../src/modules/gi/giBudget.js";

test("Bistro-sized rig emitter shadows obey the fixed pixel ceiling", () => {
  const size = giEmitterShadowSize(815, 491, 0.85);
  assert.ok(size.width * size.height <= 160_000, JSON.stringify(size));
  assert.ok(size.width >= 500 && size.height >= 300, JSON.stringify(size));
});

test("ordinary emitter targets retain their requested scale", () => {
  assert.deepEqual(giEmitterShadowSize(448, 270, 0.55), { width: 246, height: 149 });
});

test("the override can disable the ceiling", () => {
  assert.deepEqual(giEmitterShadowSize(815, 491, 0.85, 0), { width: 693, height: 417 });
});
