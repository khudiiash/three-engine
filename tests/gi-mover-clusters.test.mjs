/**
 * §11.57 mover clusters — the two-level structure over adopted movers.
 *
 * The pure bucketing is pinned here (union boxes, exact membership, stable
 * order, conservative handling of an invalid box), and the header table the
 * dynamic-object set writes each sync is read back word for word. The kernel
 * side is proven by `smoke:gi-gpu`'s dynamic-object arms.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";
import {
  DYN_CLUSTER_MAX, DYN_CLUSTER_STRIDE, DYN_HEADER_RESERVED, OBJ_WORDS,
  clusterMoverBoxes, createDynamicObjectSet, dynClusterWords, dynHeaderWords,
} from "../src/modules/gi/dynamicObjects.js";

const box = (slot, cx, cy, cz, h = 0.5) => ({ slot, mn: [cx - h, cy - h, cz - h], mx: [cx + h, cy + h, cz + h] });

test("two far-apart groups become two clusters whose boxes are the unions of their members", () => {
  const items = [box(0, 0, 0, 0), box(1, 0.5, 0, 0), box(2, 20, 0, 0), box(3, 20.5, 0, 0)];
  const { clusters, members } = clusterMoverBoxes(items);
  assert.equal(clusters.length, 2);
  assert.deepEqual(members, [0, 1, 2, 3]);
  const a = clusters[0], b = clusters[1];
  assert.deepEqual([a.first, a.count, b.first, b.count], [0, 2, 2, 2]);
  assert.deepEqual(a.mn, [-0.5, -0.5, -0.5]);
  assert.deepEqual(a.mx, [1, 0.5, 0.5]);
  assert.deepEqual(b.mn, [19.5, -0.5, -0.5]);
  assert.deepEqual(b.mx, [21, 0.5, 0.5]);
});

test("every slot appears exactly once, at most DYN_CLUSTER_MAX clusters, and an unchanged input is byte-stable", () => {
  const items = [];
  for (let i = 0; i < 40; i++) items.push(box(39 - i, (i % 4) * 10, ((i >> 2) % 3) * 10, (i % 5) * 4));
  const a = clusterMoverBoxes(items);
  assert.ok(a.clusters.length >= 1 && a.clusters.length <= DYN_CLUSTER_MAX);
  assert.deepEqual([...a.members].sort((x, y) => x - y), Array.from({ length: 40 }, (_, i) => i));
  for (const c of a.clusters) {
    for (let j = c.first; j < c.first + c.count; j++) {
      const it = items.find((x) => x.slot === a.members[j]);
      for (let k = 0; k < 3; k++) {
        assert.ok(c.mn[k] <= it.mn[k] && c.mx[k] >= it.mx[k], "a member lies inside its cluster's box");
      }
    }
  }
  const b = clusterMoverBoxes(items.slice().reverse());
  assert.deepEqual(b, a, "member order is by slot, not by input order");
});

test("a single mover is one cluster; no movers is no cluster; an invalid box is never culled", () => {
  assert.deepEqual(clusterMoverBoxes([]), { clusters: [], members: [] });
  const one = clusterMoverBoxes([box(3, 1, 2, 3)]);
  assert.equal(one.clusters.length, 1);
  assert.deepEqual(one.members, [3]);
  const bad = clusterMoverBoxes([box(0, 0, 0, 0), { slot: 1, mn: [Number.NaN, 0, 0], mx: [0, 0, 0] }]);
  const holder = bad.clusters.find((c) => bad.members.slice(c.first, c.first + c.count).includes(1));
  assert.ok(holder.mn[0] <= -1e29 && holder.mx[0] >= 1e29, "an unknown box makes its cluster unbounded");
});

test("the header grows by the cluster table and a sync writes it after the object blocks", () => {
  const maxObjects = 4;
  assert.equal(dynClusterWords(maxObjects), 1 + DYN_CLUSTER_MAX * DYN_CLUSTER_STRIDE + maxObjects);
  assert.equal(dynHeaderWords(maxObjects), DYN_HEADER_RESERVED + maxObjects * OBJ_WORDS + dynClusterWords(maxObjects));
  const bits = { element: () => ({ assign() {} }) };
  const dyn = createDynamicObjectSet({ bits, baseWord: 0, capacityWords: 16384, maxObjects });
  assert.equal(dyn.headerWords, dynHeaderWords(maxObjects));
  const mesh = (x) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    m.position.set(x, 0, 0);
    m.updateMatrixWorld(true);
    return m;
  };
  const shape = { type: "obb", center: new THREE.Vector3(), halfExtents: new THREE.Vector3(0.5, 0.5, 0.5) };
  assert.equal(dyn.adopt("a", mesh(0), null, shape), true);
  assert.equal(dyn.adopt("b", mesh(30), null, shape), true);
  dyn.sync(0);
  const mirror = dyn.debugMirror?.() ?? null;
  assert.ok(mirror, "the set exposes its header mirror for tests");
  const base = DYN_HEADER_RESERVED + maxObjects * OBJ_WORDS;
  assert.equal(mirror[base], 2, "two movers 30 m apart are two clusters");
  const c0 = base + 1, c1 = base + 1 + DYN_CLUSTER_STRIDE;
  assert.deepEqual([mirror[c0 + 6], mirror[c0 + 7], mirror[c1 + 6], mirror[c1 + 7]], [0, 1, 1, 1]);
  const memberBase = base + 1 + DYN_CLUSTER_MAX * DYN_CLUSTER_STRIDE;
  assert.deepEqual([mirror[memberBase], mirror[memberBase + 1]], [0, 1]);
  // The cluster box contains the object's swept box (words 24..30 of its block).
  const ob = DYN_HEADER_RESERVED + 1 * OBJ_WORDS;
  assert.ok(mirror[c1] <= mirror[ob + 24] && mirror[c1 + 3] >= mirror[ob + 28]);
  assert.equal(dyn.stats.clusters, 2);
});
