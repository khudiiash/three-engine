import assert from "node:assert/strict";
import test from "node:test";

import {
  STATIC_TLAS_LEAF_BIT,
  STATIC_TLAS_NODE_WORDS,
  STATIC_TLAS_PLACEMENT_ACTIVE,
  STATIC_TLAS_PLACEMENT_WORDS,
  buildStaticPlacementTlas,
  refitStaticPlacementTlas,
  traceStaticPlacementBruteForce,
  traceStaticPlacementTlas,
} from "../src/modules/gi/staticPlacementTlas.js";

function matrix(tx = 0, ty = 0, tz = 0, scale = [1, 1, 1], angle = 0) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    c * scale[0], 0, -s * scale[0], 0,
    0, scale[1], 0, 0,
    s * scale[2], 0, c * scale[2], 0,
    tx, ty, tz, 1,
  ];
}

function placement(slot, tx, extras = {}) {
  return {
    slot,
    localMin: [-0.5, -0.5, -0.5],
    localMax: [0.5, 0.5, 0.5],
    matrix: matrix(tx),
    blasNodeBase: 1000 + slot * 100,
    indexBase: 2000 + slot * 100,
    positionBase: 3000 + slot * 100,
    uvBase: 4000 + slot * 100,
    ...extras,
  };
}

function changedIndices(before, after) {
  const changed = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i);
  return changed;
}

test("builder preserves authored placement order and keeps topology independent of slots", () => {
  const inputs = [placement(8, 8), placement(2, 2), placement(5, 5)];
  const a = buildStaticPlacementTlas(inputs);
  const b = buildStaticPlacementTlas(inputs.map((input, index) => ({ ...input, slot: 20 + index })));

  assert.equal(a.nodeWords.length, (inputs.length * 2 - 1) * STATIC_TLAS_NODE_WORDS);
  assert.equal(a.placementWords.length, inputs.length * STATIC_TLAS_PLACEMENT_WORDS);
  assert.equal(a.words.length, a.nodeWords.length + a.placementWords.length);
  assert.equal(a.nodeWords.buffer, a.words.buffer);
  assert.equal(a.placementWords.buffer, a.words.buffer);
  assert.equal(a.layout.placementWordOffset, a.nodeWords.length);
  assert.deepEqual([...a.nodeWords], [...b.nodeWords]);
  assert.deepEqual(a.placements.map((p) => p.slot), [8, 2, 5]);

  for (const slot of [2, 5, 8]) {
    const leaf = a.leafBySlot.get(slot);
    const base = leaf * STATIC_TLAS_NODE_WORDS;
    assert.notEqual(a.nodeWords[base + 6] & STATIC_TLAS_LEAF_BIT, 0);
    assert.equal(a.nodeWords[base + 7], 0);
    const chain = [...a.parentChainBySlot.get(slot)];
    assert.equal(chain[0], leaf);
    assert.equal(chain.at(-1), a.rootNode);
    for (let i = 1; i < chain.length; i++) assert.equal(a.parentByNode[chain[i - 1]], chain[i]);
  }

  const p = a.slotToPlacement.get(5) * STATIC_TLAS_PLACEMENT_WORDS;
  assert.equal(a.placementWords[p + 16], 1500);
  assert.equal(a.placementWords[p + 17], 2500);
  assert.equal(a.placementWords[p + 18], 3500);
  assert.equal(a.placementWords[p + 19], 4500);
  assert.equal(a.placementWords[p + 20], 5);
  assert.notEqual(a.placementWords[p + 21] & STATIC_TLAS_PLACEMENT_ACTIVE, 0);
});

test("moving one placement changes only its record, leaf, and parent chain", () => {
  const tlas = buildStaticPlacementTlas([
    placement(0, 0),
    placement(1, 10),
    placement(2, 20),
    placement(3, 30),
  ]);
  const nodesBefore = tlas.nodeWords.slice();
  const placementsBefore = tlas.placementWords.slice();
  const dirty = refitStaticPlacementTlas(tlas, 3, { matrix: matrix(40) });
  const allowedNodes = new Set(dirty.nodeIndices);

  const changedNodes = changedIndices(nodesBefore, tlas.nodeWords);
  assert.ok(changedNodes.length > 0);
  for (const word of changedNodes) {
    assert.ok(allowedNodes.has(Math.floor(word / STATIC_TLAS_NODE_WORDS)), `node word ${word} escaped the refit chain`);
  }
  for (const node of dirty.nodeIndices) {
    assert.ok(
      changedNodes.some((word) => Math.floor(word / STATIC_TLAS_NODE_WORDS) === node),
      `translated outer leaf must alter node ${node}`,
    );
  }

  const changedPlacements = changedIndices(placementsBefore, tlas.placementWords);
  const p0 = dirty.placementRange.wordOffset;
  const p1 = p0 + dirty.placementRange.wordCount;
  assert.ok(changedPlacements.length > 0);
  assert.ok(changedPlacements.every((word) => word >= p0 && word < p1));

  const covered = new Set();
  for (const range of dirty.nodeRanges) {
    assert.equal(range.wordOffset % STATIC_TLAS_NODE_WORDS, 0);
    assert.equal(range.wordCount % STATIC_TLAS_NODE_WORDS, 0);
    for (let word = range.wordOffset; word < range.wordOffset + range.wordCount; word += STATIC_TLAS_NODE_WORDS) {
      covered.add(word / STATIC_TLAS_NODE_WORDS);
    }
  }
  assert.deepEqual(covered, allowedNodes);
  assert.deepEqual(dirty.packedRanges.slice(0, -1), dirty.nodeRanges);
  assert.equal(
    dirty.packedRanges.at(-1).wordOffset,
    tlas.layout.placementWordOffset + dirty.placementRange.wordOffset,
  );
});

function sphereHit({ originLocal: o, directionLocal: d, tMin, tMax }) {
  const a = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const b = 2 * (o[0] * d[0] + o[1] * d[1] + o[2] * d[2]);
  const c = o[0] ** 2 + o[1] ** 2 + o[2] ** 2 - 0.25;
  const disc = b * b - 4 * a * c;
  if (!(disc >= 0) || !(a > 0)) return null;
  const root = Math.sqrt(disc);
  const near = (-b - root) / (2 * a);
  const far = (-b + root) / (2 * a);
  if (near >= tMin && near <= tMax) return { t: near };
  if (far >= tMin && far <= tMax) return { t: far };
  return null;
}

function assertTraceAgreement(tlas, rays) {
  for (const [origin, direction] of rays) {
    const options = { tMin: 0.001, tMax: 100, intersectPlacement: sphereHit };
    const accelerated = traceStaticPlacementTlas(tlas, origin, direction, options);
    const brute = traceStaticPlacementBruteForce(tlas, origin, direction, options);
    assert.equal(accelerated?.slot ?? null, brute?.slot ?? null);
    if (brute) assert.ok(Math.abs(accelerated.t - brute.t) < 1e-5, `${accelerated.t} != ${brute.t}`);
  }
}

test("packed TLAS trace matches brute force before and after a refit", () => {
  const tlas = buildStaticPlacementTlas([
    placement(9, -3, { matrix: matrix(-3, 0, 4, [1.5, 0.75, 1], 0.3) }),
    placement(4, 0, { matrix: matrix(0, 0.5, 6, [0.8, 1.4, 1.2], -0.5) }),
    placement(12, 3, { matrix: matrix(3, -0.25, 8, [1, 1, 1], 0.8) }),
  ]);
  let seed = 0x12345678;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };
  const rays = [];
  for (let i = 0; i < 400; i++) {
    const origin = [(random() - 0.5) * 10, (random() - 0.5) * 5, -2];
    const direction = [(random() - 0.5) * 0.3, (random() - 0.5) * 0.2, 1];
    rays.push([origin, direction]);
  }
  assertTraceAgreement(tlas, rays);
  refitStaticPlacementTlas(tlas, 12, { matrix: matrix(-1.5, 1.25, 5, [0.7, 1.8, 0.9], -0.2) });
  assertTraceAgreement(tlas, rays);
});

test("singular placements fail closed and malformed topology inputs are rejected", () => {
  const tlas = buildStaticPlacementTlas([
    placement(1, 0, { matrix: matrix(0, 0, 2, [0, 1, 1]) }),
  ]);
  assert.equal(tlas.placementWords[21] & STATIC_TLAS_PLACEMENT_ACTIVE, 0);
  assert.equal(traceStaticPlacementTlas(tlas, [0, 0, 0], [0, 0, 1]), null);
  const tied = buildStaticPlacementTlas([placement(7, 3), placement(3, 3)]);
  assert.equal(traceStaticPlacementTlas(tied, [0, 0, 0], [1, 0, 0])?.slot, 3);
  assert.equal(traceStaticPlacementBruteForce(tied, [0, 0, 0], [1, 0, 0])?.slot, 3);
  assert.throws(() => buildStaticPlacementTlas([placement(2, 0), placement(2, 4)]), /duplicate/);
  assert.equal(buildStaticPlacementTlas([]), null);
});
