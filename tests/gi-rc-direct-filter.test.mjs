import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RC_DIRECT_FILTER_RADIUS,
  RC_DIRECT_PASS_NAMES,
  rcDirectFilterRadii,
  rcDirectFilterSupport,
} from "../src/modules/gi/window/rc/rcDirectFilterPolicy.js";

test("rcDirect uses one trace and two bounded filter passes", async () => {
  assert.deepEqual(RC_DIRECT_PASS_NAMES, ["raw", "filterH", "filterV"]);
  const source = await readFile(new URL("../src/modules/gi/window/rc/rcDirect.js", import.meta.url), "utf8");
  assert.match(source, /const filteredPasses = \[rawPass, hPass, vPass\]/);
  assert.doesNotMatch(source, /dilatePass\s*=|dilH2|filterHCoarse/);
});

test("rcDirect caps reconstruction while retaining a one-texel antialias floor", () => {
  assert.deepEqual(rcDirectFilterRadii([0, 0.01, 0.2, 100], 0.02), [1, 1, 6, 6]);
  assert.equal(RC_DIRECT_FILTER_RADIUS, 6);
});

test("each packed emitter channel owns its filter support", () => {
  const first = rcDirectFilterSupport([0.02, 2, 0.08, 0], 0.02);
  const changed = rcDirectFilterSupport([0.02, 100, 0.08, 0], 0.02);
  const activeTaps = (support, channel) => support
    .filter(({ weights }) => weights[channel] > 0)
    .map(({ tap }) => tap);

  assert.deepEqual(activeTaps(first, 0), [-1, 0, 1]);
  assert.deepEqual(activeTaps(first, 1), [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(activeTaps(first, 2), [-4, -3, -2, -1, 0, 1, 2, 3, 4]);
  assert.deepEqual(activeTaps(first, 0), activeTaps(changed, 0));
  assert.deepEqual(activeTaps(first, 2), activeTaps(changed, 2));
  assert.deepEqual(activeTaps(first, 3), activeTaps(changed, 3));
});
