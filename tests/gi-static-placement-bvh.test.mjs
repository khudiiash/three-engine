import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as THREE from "three/webgpu";

import {
  STATIC_PLACEMENT_BVH_HEADER_WORDS,
  STATIC_PLACEMENT_BVH_MAGIC,
  STATIC_PLACEMENT_BVH_VERSION,
  adoptStaticPlacementBvhWords,
  buildStaticPlacementBvhWords,
  refitStaticPlacementBvh,
  traceStaticPlacementBvh,
} from "../src/modules/gi/staticPlacementBvh.js";
import {
  STATIC_BVH_PLACEMENT_BUILDER_ABI,
  STATIC_BVH_PLACEMENT_PACKER_ID,
  STATIC_BVH_FORMAT_PLACEMENT,
} from "../src/modules/gi/staticBvhFormats.js";
import {
  decodeStaticBvhArtifact,
  encodeStaticBvhArtifact,
  staticBvhArtifactRelativePath,
  staticBvhInputSignature,
} from "../src/modules/gi/staticBvhDiskCache.js";
import { STATIC_TLAS_PLACEMENT_WORDS } from "../src/modules/gi/staticPlacementTlas.js";

const positions = new Float32Array([
  -1, -1, 0,
  1, -1, 0,
  1, 1, 0,
  -1, 1, 0,
]);
const index = new Uint16Array([0, 1, 2, 0, 2, 3]);
const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);

function matrix(tx, ty, tz, scale = 1, angle = 0) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(tx, ty, tz),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle),
    new THREE.Vector3(scale, scale, scale),
  );
}

function item(slot, transform, overrides = {}) {
  return {
    geometryKey: "shared-square:1",
    positions,
    index,
    uvs,
    matrix: transform,
    slot,
    ...overrides,
  };
}

function changedIndices(a, b) {
  const changed = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
  return changed;
}

test("shared placements emit one local BLAS and one occupancy-ready word array", () => {
  const packed = buildStaticPlacementBvhWords([
    item(7, matrix(0, 0, 8)),
    item(2, matrix(0, 0, 4)),
    item(11, matrix(3, 0, 6)),
  ], null, { uvs: true });

  assert.equal(packed.words[0], STATIC_PLACEMENT_BVH_MAGIC);
  assert.equal(packed.words[1], STATIC_PLACEMENT_BVH_VERSION);
  assert.equal(packed.words[3], packed.words.length);
  assert.equal(packed.layout.headerWordCount, STATIC_PLACEMENT_BVH_HEADER_WORDS);
  assert.equal(packed.blasCount, 1);
  assert.equal(packed.placementCount, 3);
  assert.equal(packed.triangleCount, 2, "triangle storage is per unique geometry, not per placement");
  assert.equal(packed.layout.triangleWordCount, 2 * 9);
  assert.equal(packed.layout.uvWordCount, 2 * 3);
  assert.equal(packed.tlas.nodeWords.buffer, packed.words.buffer);
  assert.equal(packed.tlas.placementWords.buffer, packed.words.buffer);

  const blas = packed.blases[0];
  for (const slot of [2, 7, 11]) {
    const placementIndex = packed.tlas.slotToPlacement.get(slot);
    const base = packed.layout.placementWordOffset + placementIndex * STATIC_TLAS_PLACEMENT_WORDS;
    assert.equal(packed.words[base + 16], blas.nodeWordOffset);
    assert.equal(packed.words[base + 17], blas.triangleWordOffset);
    assert.equal(packed.words[base + 19], blas.uvWordOffset);
  }
});

test("transform-only rebuilds alter only TLAS and placement words", () => {
  const before = buildStaticPlacementBvhWords([
    item(2, matrix(0, 0, 4)),
    item(7, matrix(0, 0, 8)),
  ], null, { uvs: true });
  const after = buildStaticPlacementBvhWords([
    item(2, matrix(5, 1, 4, 1.5, 0.4)),
    item(7, matrix(0, 0, 8)),
  ], null, { uvs: true });

  assert.deepEqual(after.layout, before.layout);
  assert.deepEqual(
    [...after.words.subarray(after.layout.blasNodeWordOffset)],
    [...before.words.subarray(before.layout.blasNodeWordOffset)],
    "the complete BLAS/triangle/UV suffix remains byte-identical",
  );
  const changed = changedIndices(before.words, after.words);
  assert.ok(changed.length > 0);
  assert.ok(changed.every((word) => word >= before.layout.tlasNodeWordOffset && word < before.layout.blasNodeWordOffset));
});

function transformPoint(transform, source) {
  return new THREE.Vector3(source[0], source[1], source[2]).applyMatrix4(transform).toArray();
}

function rayTriangle(origin, direction, a, b, c, tMin, tMax) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const h = [
    direction[1] * e2[2] - direction[2] * e2[1],
    direction[2] * e2[0] - direction[0] * e2[2],
    direction[0] * e2[1] - direction[1] * e2[0],
  ];
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-10) return null;
  const inverse = 1 / det;
  const s = [origin[0] - a[0], origin[1] - a[1], origin[2] - a[2]];
  const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * inverse;
  const q = [
    s[1] * e1[2] - s[2] * e1[1],
    s[2] * e1[0] - s[0] * e1[2],
    s[0] * e1[1] - s[1] * e1[0],
  ];
  const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) * inverse;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inverse;
  return u >= -1e-4 && v >= -1e-4 && u + v <= 1.0001 && t > tMin && t < tMax ? t : null;
}

function traceBruteForce(items, origin, direction, tMin, tMax) {
  let best = null;
  for (const candidate of items) {
    for (let triangle = 0; triangle < candidate.index.length / 3; triangle++) {
      const vertices = [0, 1, 2].map((corner) => {
        const vertex = candidate.index[triangle * 3 + corner];
        return transformPoint(candidate.matrix, candidate.positions.subarray(vertex * 3, vertex * 3 + 3));
      });
      const t = rayTriangle(origin, direction, vertices[0], vertices[1], vertices[2], tMin, best?.t ?? tMax);
      if (t != null && (best == null || t < best.t || (t === best.t && candidate.slot < best.slot))) {
        best = { t, slot: candidate.slot };
      }
    }
  }
  return best;
}

test("packed TLAS plus local BVH8 trace agrees with transformed triangle brute force", () => {
  const items = [
    item(9, matrix(-2, 0.4, 5, 1.3, 0.35)),
    item(3, matrix(0.25, -0.5, 7, 0.8, -0.6)),
    item(14, matrix(2.1, 0.2, 9, 1.1, 0.15)),
  ];
  const packed = buildStaticPlacementBvhWords(items, null, { uvs: true });
  let seed = 0x51a7c3d2;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  let hitCount = 0;
  for (let ray = 0; ray < 500; ray++) {
    const origin = [(random() - 0.5) * 7, (random() - 0.5) * 5, -2];
    const direction = [(random() - 0.5) * 0.12, (random() - 0.5) * 0.12, 1];
    const expected = traceBruteForce(items, origin, direction, 0.001, 100);
    const actual = traceStaticPlacementBvh(packed, origin, direction, { tMin: 0.001, tMax: 100 });
    assert.equal(actual?.slot ?? null, expected?.slot ?? null, `ray ${ray} chose the wrong placement`);
    if (expected) {
      hitCount++;
      assert.ok(Math.abs(actual.t - expected.t) < 2e-5, `ray ${ray}: ${actual.t} != ${expected.t}`);
    }
  }
  assert.ok(hitCount > 25, `trace oracle exercised only ${hitCount} hits`);
});

test("placement artifact v2 round-trips zero-copy and rehydrates refit metadata", async () => {
  const items = [item(2, matrix(0, 0, 4)), item(7, matrix(0, 0, 8))];
  const packed = buildStaticPlacementBvhWords(items, null, { uvs: true });
  const signature = await staticBvhInputSignature(items, {
    uvs: true,
    packerId: STATIC_BVH_PLACEMENT_PACKER_ID,
  });
  const encoded = encodeStaticBvhArtifact(packed, { signature });
  const decoded = decodeStaticBvhArtifact(encoded, {
    expectedSignature: signature,
    expectedFormat: STATIC_BVH_FORMAT_PLACEMENT,
    builderAbi: STATIC_BVH_PLACEMENT_BUILDER_ABI,
  });
  assert.ok(decoded);
  assert.equal(decoded.format, STATIC_BVH_FORMAT_PLACEMENT);
  assert.equal(decoded.packed.words.buffer, encoded.buffer);
  assert.equal(
    staticBvhArtifactRelativePath(signature, { format: STATIC_BVH_FORMAT_PLACEMENT }),
    `gi-static-bvh/v2/${signature.slice(0, 2)}/${signature}.gbvh`,
  );
  assert.equal(
    decodeStaticBvhArtifact(encoded, { expectedSignature: signature }),
    null,
    "the world-v1 ABI treats placement-v2 as a normal miss",
  );

  const adopted = adoptStaticPlacementBvhWords(decoded.packed.words, items);
  const immutableBefore = adopted.words.slice(adopted.layout.blasNodeWordOffset);
  const dirty = refitStaticPlacementBvh(adopted, 2, { matrix: matrix(3, 0, 5) });
  assert.ok(dirty.uploads.length >= 2);
  assert.ok(dirty.uploads.every((upload) =>
    upload.wordOffset >= adopted.layout.tlasNodeWordOffset &&
    upload.wordOffset + upload.wordCount <= adopted.layout.blasNodeWordOffset &&
    upload.words.buffer === adopted.words.buffer));
  assert.deepEqual([...adopted.words.subarray(adopted.layout.blasNodeWordOffset)], [...immutableBefore]);
});

test("artifact adoption and later refits recover bounds without scanning triangles", () => {
  const sourceItems = [item(2, matrix(0, 0, 4)), item(7, matrix(0, 0, 8))];
  const packed = buildStaticPlacementBvhWords(sourceItems, null, { uvs: true });
  let coordinateReads = 0;
  const trackedPositions = new Proxy(Array.from(positions), {
    get(target, property, receiver) {
      if (/^\d+$/.test(String(property))) coordinateReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const adopted = adoptStaticPlacementBvhWords(packed.words.slice(), sourceItems.map((source) => ({
    ...source,
    positions: trackedPositions,
  })));
  assert.equal(coordinateReads, 0, "a warm artifact hit must not rescan source triangles");

  refitStaticPlacementBvh(adopted, 2, { matrix: matrix(1, 0, 4) });
  assert.equal(coordinateReads, 0, "packed BLAS root bounds make a transform refit triangle-count independent");
  refitStaticPlacementBvh(adopted, 7, { matrix: matrix(1, 0, 8) });
  assert.equal(coordinateReads, 0, "shared geometry refits remain triangle-count independent");
});

test("artifact adoption patches transient slots and transforms without touching BLAS bytes", () => {
  const builtItems = [item(2, matrix(0, 0, 4)), item(7, matrix(0, 0, 8))];
  const packed = buildStaticPlacementBvhWords(builtItems, null, { uvs: true });
  const immutable = packed.words.slice(packed.layout.blasNodeWordOffset);
  const liveItems = [item(31, matrix(4, 1, 5)), item(12, matrix(-2, 0, 10))];
  const adopted = adoptStaticPlacementBvhWords(packed.words.slice(), liveItems);

  assert.deepEqual(adopted.tlas.placements.map((placement) => placement.slot), [31, 12]);
  assert.deepEqual([...adopted.words.subarray(adopted.layout.blasNodeWordOffset)], [...immutable]);
  assert.equal(traceStaticPlacementBvh(adopted, [4, 1, 0], [0, 0, 1])?.slot, 31);
  assert.equal(traceStaticPlacementBvh(adopted, [-2, 0, 0], [0, 0, 1])?.slot, 12);
});

test("placement artifact adoption rejects BLAS bases outside the packed regions", () => {
  const items = [item(2, matrix(0, 0, 4))];
  const packed = buildStaticPlacementBvhWords(items, null, { uvs: true });
  const malformed = packed.words.slice();
  malformed[packed.layout.placementWordOffset + 16] = packed.words.length + 28;
  assert.throws(() => adoptStaticPlacementBvhWords(malformed, items), /invalid BLAS range/);
});

test("production WGSL selects the bounded SBV2 traversal without a new storage buffer", async () => {
  const source = await readFile(new URL("../src/modules/gi/dynamicObjects.js", import.meta.url), "utf8");
  const start = source.indexOf("const staticPlacementTraceWgsl");
  const end = source.indexOf("// STATIC-SCENE traversal:", start);
  assert.ok(start >= 0 && end > start, "SBV2 WGSL source must be present");
  const wgsl = source.slice(start, end);

  assert.match(wgsl, /fn giStaticPlacementBvh8\(/);
  assert.match(wgsl, /bits\[packedBase\] != 0x32564253u/);
  assert.match(wgsl, /arrayLength\(bits\)/);
  assert.match(wgsl, /var stack: array<u32, 32>/, "TLAS traversal is stack bounded");
  assert.match(wgsl, /var stack: array<u32, 44>/, "BLAS traversal retains the proven bound");
  assert.match(wgsl, /guard >= 2048u/);
  assert.match(wgsl, /guard >= 768u/);
  assert.match(wgsl, /slot < 512u/, "placement masking must not read past the 512-bit mask");
  assert.match(wgsl, /let rdL = c0 \* rdW\.x \+ c1 \* rdW\.y \+ c2 \* rdW\.z/,
    "the local direction stays unnormalised so world t is preserved");
  assert.deepEqual(
    [...wgsl.matchAll(/ptr<storage, array<u32>, read_write>/g)].map(() => "bits"),
    ["bits", "bits", "bits"],
    "every helper shares the one existing occupancy-bits storage pointer",
  );

  assert.match(source, /normalizeStaticBvhFormat\(format\)/);
  assert.match(source, /info\.format === STATIC_BVH_FORMAT_PLACEMENT/);
  assert.match(source, /format = STATIC_BVH_FORMAT_WORLD/,
    "omitting format must preserve the legacy production fallback");
});

test("GISystem selects SBV2 by default and stages only settled refit ranges", async () => {
  const source = await readFile(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
  assert.match(source, /const STATIC_PLACEMENT_BVH_TRAVERSAL_READY = true/);
  assert.match(source, /__giStaticBvhFormat \?\? STATIC_BVH_FORMAT_PLACEMENT/);
  assert.match(source, /attachStaticBvh\(this\.#staticBvhAttachInfo\(staticBvhPacked, field\.staticBvhWordOffset\)\)/);
  assert.match(source, /refitStaticPlacementBvh\(/);
  assert.match(source, /this\._staticPlacementBvhPacked\.words\.subarray\(start, end\)/);
  assert.match(source, /pending\.blocks\.every\(\(block\) => block\?\.uploaded === true\)/,
    "partial ranges stay masked until every upload is acknowledged");
});
