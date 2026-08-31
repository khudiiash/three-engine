import assert from "node:assert/strict";
import test from "node:test";

import {
  giBvhReflectAnchorOffsets,
  giBvhReflectStride,
} from "../src/modules/gi/giScreen.js";

test("the shipping reflection trace uses a 2x2 ray block", () => {
  delete globalThis.__giBvhReflectStride;
  assert.equal(giBvhReflectStride(2), 2);
});

test("the reference hatch still restores per-pixel tracing", () => {
  globalThis.__giBvhReflectStride = 1;
  assert.equal(giBvhReflectStride(2), 1);
  delete globalThis.__giBvhReflectStride;
});

test("reconstruction examines all four anchors bracketing a block", () => {
  assert.deepEqual(giBvhReflectAnchorOffsets(2), [
    [0, 0], [2, 0], [0, 2], [2, 2],
  ]);
});

test("per-pixel tracing has exactly one source anchor", () => {
  assert.deepEqual(giBvhReflectAnchorOffsets(1), [[0, 0]]);
});

test("anchor policy clamps malformed and non-portable strides", () => {
  assert.deepEqual(giBvhReflectAnchorOffsets(0), [[0, 0]]);
  assert.deepEqual(giBvhReflectAnchorOffsets(99), [
    [0, 0], [4, 0], [0, 4], [4, 4],
  ]);
});
