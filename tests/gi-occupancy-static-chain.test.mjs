import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("static occupancy boots without dynamic-only voxel and surface passes", async () => {
  const source = await readFile(new URL("../src/modules/gi/occupancyField.js", import.meta.url), "utf8");
  const chainStart = source.indexOf("fullStatic: [");
  const chainEnd = source.indexOf("\n      full: [", chainStart);
  assert.ok(chainStart >= 0 && chainEnd > chainStart, "static first-fill chain must exist");
  const chain = source.slice(chainStart, chainEnd);
  assert.match(chain, /voxStatic, snapStaticBitsCompute/);
  assert.match(chain, /surfAccumStatic/);
  assert.doesNotMatch(chain, /voxDynamic|surfAccumDynamic|dynSurf/);
  assert.match(source, /return dynamicCount === 0 \? computes\.fullStatic : computes\.full/);
});

test("static boot prewarms the later dynamic promotion chain atomically", async () => {
  const source = await readFile(new URL("../src/modules/gi/occupancyField.js", import.meta.url), "utf8");
  assert.match(source, /const clearCompute = buildClearCompute\(\)/);
  const chainStart = source.indexOf("fullStatic: [");
  const chainEnd = source.indexOf("\n    };", chainStart);
  const chains = source.slice(chainStart, chainEnd);
  assert.equal(
    chains.match(/\bclearCompute\b/g)?.length,
    2,
    "fullStatic and full must share the same revision-local destructive clear",
  );
  assert.match(
    source,
    /const chains = \[computes\.fullStatic, computes\.full, computes\.fast\]/,
    "the first promotion must not encounter never-attempted full/fast kernels",
  );
});
