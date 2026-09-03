import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  StaticBvhBuildCache,
  staticBvhGeometryRevision,
} from "../src/modules/gi/staticBvhBuildCache.js";
import {
  STATIC_BVH_FORMAT_PLACEMENT,
  STATIC_BVH_FORMAT_WORLD,
  staticBvhFormatDescriptor,
} from "../src/modules/gi/staticBvhFormats.js";

function item(overrides = {}) {
  return {
    geometryKey: "7:2",
    geometryRevision: "7:p2/3/3/0:i1/3/1/0:u4/3/2/0",
    positions: new Float32Array(9),
    index: new Uint16Array([0, 1, 2]),
    uvs: new Float32Array(6),
    matrix: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1] },
    slot: 3,
    ...overrides,
  };
}

test("static BVH cache key is quality-independent but input-complete", () => {
  const cache = new StaticBvhBuildCache();
  const base = item();
  const key = cache.keyFor([base], { uvs: true, strategy: "sah" });

  assert.equal(
    cache.keyFor([{ ...base, matrix: { elements: [...base.matrix.elements] } }], { uvs: true, strategy: "sah" }),
    key,
    "equivalent placement values hit even when the Matrix4 was recreated",
  );
  assert.notEqual(cache.keyFor([{ ...base, geometryRevision: `${base.geometryRevision}:edited` }], { uvs: true, strategy: "sah" }), key);
  assert.notEqual(cache.keyFor([{ ...base, positions: base.positions.slice() }], { uvs: true, strategy: "sah" }), key);
  assert.notEqual(cache.keyFor([{ ...base, matrix: { elements: [...base.matrix.elements.slice(0, 12), 4.25, 5, 6, 1] } }], { uvs: true, strategy: "sah" }), key);
  assert.notEqual(cache.keyFor([{ ...base, slot: 4 }], { uvs: true, strategy: "sah" }), key);
  assert.notEqual(cache.keyFor([base], { uvs: false, strategy: "sah" }), key);
  assert.notEqual(cache.keyFor([base], { uvs: true, strategy: "center" }), key);
});

test("UV array changes matter only when the packed format contains UVs", () => {
  const cache = new StaticBvhBuildCache();
  const base = item();
  const changed = { ...base, uvs: base.uvs.slice() };
  assert.notEqual(cache.keyFor([base], { uvs: true }), cache.keyFor([changed], { uvs: true }));
  assert.equal(cache.keyFor([base], { uvs: false }), cache.keyFor([changed], { uvs: false }));
});

test("format negotiation fails closed until placement traversal is compiled", () => {
  const fallback = staticBvhFormatDescriptor("placement");
  assert.equal(fallback.requested, STATIC_BVH_FORMAT_PLACEMENT);
  assert.equal(fallback.format, STATIC_BVH_FORMAT_WORLD);
  assert.equal(fallback.fallback, true);
  const ready = staticBvhFormatDescriptor("placement", { placementTraversal: true });
  assert.equal(ready.format, STATIC_BVH_FORMAT_PLACEMENT);
  assert.equal(ready.builderAbi, 3);

  const cache = new StaticBvhBuildCache();
  assert.notEqual(
    cache.keyFor([item()], { format: STATIC_BVH_FORMAT_WORLD }),
    cache.keyFor([item()], { format: STATIC_BVH_FORMAT_PLACEMENT }),
  );
});

test("placement cache identity ignores refittable slots and transforms", () => {
  const cache = new StaticBvhBuildCache();
  const base = item();
  const options = { uvs: true, format: STATIC_BVH_FORMAT_PLACEMENT };
  const key = cache.keyFor([base], options);
  assert.equal(cache.keyFor([{ ...base, slot: 99 }], options), key);
  assert.equal(
    cache.keyFor([{ ...base, matrix: { elements: [...base.matrix.elements.slice(0, 12), 100, -20, 7, 1] } }], options),
    key,
  );
  assert.notEqual(cache.keyFor([item({ positions: base.positions.slice() })], options), key);
});

test("geometry revision includes position, index, and UV attribute versions", () => {
  const geometry = {
    id: 9,
    attributes: {
      position: { version: 1, count: 3, itemSize: 3 },
      uv: { version: 2, count: 3, itemSize: 2 },
    },
    index: { version: 3, count: 3, itemSize: 1 },
  };
  const before = staticBvhGeometryRevision(geometry);
  geometry.index.version++;
  assert.notEqual(staticBvhGeometryRevision(geometry), before);
  geometry.index.version--;
  geometry.attributes.uv.version++;
  assert.notEqual(staticBvhGeometryRevision(geometry), before);
});

test("cache is single-entry and weakly references giant packed words", () => {
  const cache = new StaticBvhBuildCache();
  const first = { words: new Uint32Array(16) };
  const second = { words: new Uint32Array(8) };
  cache.set("first", first);
  assert.equal(cache.get("first").words, first.words);
  assert.ok(cache._entry.ref instanceof WeakRef);
  assert.equal(Object.hasOwn(cache._entry, "packed"), false, "cache must not strongly pin Bistro-sized words");
  assert.equal(Object.hasOwn(cache._entry, "words"), false, "entry metadata must not own the giant array");

  cache.set("second", second);
  assert.equal(cache.get("first"), null);
  assert.equal(cache.get("second").words, second.words);
  cache.clear();
  assert.equal(cache.get("second"), null);
});

test("placement cache metadata cannot pin payload through nested typed-array views", () => {
  const cache = new StaticBvhBuildCache();
  const words = new Uint32Array(128);
  cache.set("placement", {
    format: STATIC_BVH_FORMAT_PLACEMENT,
    builderAbi: 2,
    words,
    layout: { totalWords: words.length },
    placementCount: 2,
    blasCount: 1,
    triangleCount: 1,
    arity: 8,
    uvs: false,
    tlas: { nodeWords: words.subarray(0, 8) },
    blases: [{ triangleWords: words.subarray(8) }],
  });
  assert.equal(Object.hasOwn(cache._entry.meta, "tlas"), false);
  assert.equal(Object.hasOwn(cache._entry.meta, "blases"), false);
  assert.equal(cache.get("placement").words, words);
});

test("GISystem routes full and incremental static builds through the weak cache", async () => {
  const source = await readFile(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
  assert.equal((source.match(/buildStaticSceneBvhWords\(/g) ?? []).length, 1, "only the cache wrapper may invoke the expensive builder");
  assert.match(source, /#buildStaticBvhPacked\(items, wantsUv\)/);
  assert.match(source, /#buildStaticBvhPacked\(items, this\._staticBvhItemsWantedUv === true\)/);
  assert.match(source, /geometryRevision: g\.key/);
  assert.match(source, /geometryRevision: record\.geometryKey/);
  assert.match(source, /this\._staticBvhBuildCache\?\.clear\(\);\s*this\._staticBvhBuildCache = null;/);
});
