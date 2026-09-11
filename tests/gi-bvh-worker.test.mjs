// GATE: the exact-reflection BLAS cache and its off-thread build
// (src/modules/gi/bvh/bvhScene.js + bvhBlasWorker.js).
//
// Two faults this pins, both found on the user's terrain (2026-09-10):
//
//   1. STALENESS. `blasCache` was a WeakMap keyed by geometry IDENTITY, and
//      terrain sculpting edits the position attribute of the SAME
//      BufferGeometry object — so the scene-level resync noticed the edit
//      (`giBvhContentKey` mixes `position.version`), rebuilt the whole scene,
//      and packed the pre-stroke triangles out of the cache. Section (a).
//
//   2. MAIN-THREAD COST. Once (1) misses, every stroke end paid a 1-2 s
//      synchronous MeshBVH build inside frame:preRender — the freeze class
//      docs/ZERO_FREEZE_PLAN.md unit 4.4 exists to remove. Section (b): the
//      build moves to `prewarmGeometryBlas` (a worker live; an injected
//      builder here, node has no Worker) and `buildBvhScene` then packs from
//      the warm cache with ZERO main-thread builds — asserted by the counter
//      that increments exactly where `new MeshBVH` is called.
//
//   Section (c) is what makes (b) safe to ship: a BVH built in the worker
//   from COPIES of the arrays packs byte-identical to the in-place build, on
//   a grouped geometry too (three-mesh-bvh builds one root PER GROUP; the
//   sync path strips groups, the worker builds a groupless copy).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { MeshBVH } from "three-mesh-bvh";
import {
  blasBuildStats,
  blasCacheState,
  blasFromWorkerResult,
  buildBvhScene,
  coldBlasGeometries,
  packGeometryBlas,
  packGeometryBlasFrom,
  peekGeometryBlas,
  prewarmGeometryBlas,
} from "../src/modules/gi/bvh/bvhScene.js";
import { buildBlasFromArrays } from "../src/modules/gi/bvh/bvhBlasWorker.js";

// `buildBvhScene` bakes an albedo atlas through a 2D canvas; node has none,
// and a stub that swallows the draws is all the BLAS path needs.
globalThis.OffscreenCanvas ??= class {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() {
    return { save() {}, restore() {}, translate() {}, scale() {}, drawImage() {}, fillRect() {}, fillStyle: "" };
  }
};

function meshOf(geometry) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.updateMatrixWorld();
  return mesh;
}

// A "worker" that runs in-process: exactly what bvhBlasWorker.js does with a
// message — copies in, MeshBVH on a groupless geometry, roots + reordered
// index out — minus the message, resolving on a later task like the real one.
function inProcessBuilder(log = []) {
  return async (geometry) => {
    log.push(geometry);
    const position = geometry.attributes.position.array.slice();
    const index = new Uint32Array(geometry.index.array);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return blasFromWorkerResult(geometry, buildBlasFromArrays({ position, index }));
  };
}

const bytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = warn; }
}

// ── (a) the cache is keyed by content revision ─────────────────────────────

test("blas cache: hits while unchanged, misses after an in-place position edit", () => {
  const geometry = new THREE.PlaneGeometry(4, 4, 8, 8); // 128 tris, Uint16 index
  const mesh = meshOf(geometry);
  const before = blasBuildStats.syncBuilds;

  buildBvhScene([mesh]);
  assert.equal(blasBuildStats.syncBuilds, before + 1, "the first build packs on the main thread");
  assert.equal(blasCacheState(geometry), "warm");
  const first = peekGeometryBlas(geometry);
  assert.ok(first);

  buildBvhScene([mesh]);
  assert.equal(blasBuildStats.syncBuilds, before + 1, "an unchanged geometry is a cache HIT");
  assert.equal(peekGeometryBlas(geometry), first, "the very same pack object");

  // The terrain stroke: raise one vertex of the SAME geometry object in place.
  const position = geometry.attributes.position;
  position.setZ(10, 3.5);
  position.needsUpdate = true; // bumps `version`, as the sculpt tool does
  assert.equal(blasCacheState(geometry), "stale", "an in-place edit invalidates the pack");
  assert.equal(peekGeometryBlas(geometry), undefined);

  const scene = buildBvhScene([mesh]);
  assert.equal(blasBuildStats.syncBuilds, before + 2, "the edit is a cache MISS, not the old triangles");
  const packed = peekGeometryBlas(geometry);
  assert.notEqual(packed, first);
  assert.equal(packed.position[10 * 3 + 2], 3.5, "the fresh pack carries the sculpted vertex");
  // Node 0 is the root: its max-z must enclose the raised vertex. And the
  // per-mesh AABB the TLAS rejects rays against must too — it comes from
  // the root, not from `geometry.boundingBox`, which three never recomputes
  // on an attribute edit and still describes the flat plane.
  assert.ok(packed.bounds[5] >= 3.5 - 1e-3, "root bounds enclose the sculpted vertex");
  assert.ok(packed.boundsMax.z >= 3.5 - 1e-3, "the mesh AABB encloses the sculpted vertex");
  assert.equal(scene.triCount, 128);
  assert.equal(scene.meshCount, 1);

  buildBvhScene([mesh]);
  assert.equal(blasBuildStats.syncBuilds, before + 2, "warm again at the new revision");
});

test("blas cache: a geometry shared by many meshes is packed once", () => {
  const geometry = new THREE.PlaneGeometry(1, 1, 2, 2);
  const before = blasBuildStats.syncBuilds;
  const scene = buildBvhScene([meshOf(geometry), meshOf(geometry), meshOf(geometry)]);
  assert.equal(blasBuildStats.syncBuilds, before + 1);
  assert.equal(scene.meshCount, 3);
});

// ── (b) the prewarm fills the cache off the resync path ────────────────────

test("prewarm: an injected builder fills the cache and buildBvhScene then builds nothing on the main thread", async () => {
  const a = new THREE.PlaneGeometry(2, 2, 6, 6); // 72 tris
  const b = new THREE.BoxGeometry(1, 1, 1); // 12 tris, SIX groups — must still come back as one root
  const meshes = [meshOf(a), meshOf(b), meshOf(a)]; // `a` is shared: warmed once
  assert.deepEqual(coldBlasGeometries(meshes), [a, b], "what the build would seat and has not packed");

  const log = [];
  const receipt = await prewarmGeometryBlas(coldBlasGeometries(meshes), { builder: inProcessBuilder(log) });
  assert.equal(receipt.built, 2);
  assert.equal(receipt.failed, 0);
  assert.equal(receipt.fallback, 0);
  assert.equal(log.length, 2, "one build per distinct geometry");
  assert.equal(blasCacheState(a), "warm");
  assert.equal(blasCacheState(b), "warm");
  assert.ok(peekGeometryBlas(b), "the grouped box packed as one root, not the multi-root null");
  assert.deepEqual(coldBlasGeometries(meshes), [], "nothing left to warm");

  const syncBefore = blasBuildStats.syncBuilds;
  const scene = buildBvhScene(meshes);
  assert.equal(blasBuildStats.syncBuilds, syncBefore, "the resync hit the warm cache — no main-thread MeshBVH build");
  assert.equal(scene.meshCount, 3);
  assert.equal(scene.triCount, 72 + 12 + 72);

  // The off-thread path never touches the live geometry: its index is still
  // in three's authored order (the in-place build would have partitioned it).
  assert.equal(Buffer.compare(bytes(a.index.array), bytes(new THREE.PlaneGeometry(2, 2, 6, 6).index.array)), 0);

  // A warm set costs the builder nothing.
  const again = await prewarmGeometryBlas([a, b, a], { builder: inProcessBuilder(log) });
  assert.equal(again.built, 0);
  assert.equal(again.warm, 2);
  assert.equal(log.length, 2);

  // An edit AFTER the prewarm is a miss again, and the builder runs again.
  a.attributes.position.needsUpdate = true;
  assert.deepEqual(coldBlasGeometries(meshes), [a]);
  const third = await prewarmGeometryBlas(coldBlasGeometries(meshes), { builder: inProcessBuilder(log) });
  assert.equal(third.built, 1);
  assert.equal(log.length, 3);
  assert.equal(blasCacheState(a), "warm");
});

test("prewarm: a geometry edited WHILE its build ran is dropped, not cached against the wrong triangles", async () => {
  const geometry = new THREE.PlaneGeometry(2, 2, 4, 4);
  const racing = async (target) => {
    const bvh = await inProcessBuilder()(target);
    target.attributes.position.setZ(3, 1); // the stroke continued
    target.attributes.position.needsUpdate = true;
    return bvh;
  };
  const receipt = await prewarmGeometryBlas([geometry], { builder: racing });
  assert.equal(receipt.stale, 1);
  assert.equal(receipt.built, 0);
  assert.equal(blasCacheState(geometry), "cold", "nothing was cached for the superseded revision");
});

test("prewarm: ineligible and aborted geometries are skipped; no builder means a main-thread fallback", async () => {
  const unindexed = new THREE.PlaneGeometry(1, 1, 2, 2).toNonIndexed();
  const skipped = await prewarmGeometryBlas([unindexed, null], { builder: inProcessBuilder() });
  assert.equal(skipped.ineligible, 1);
  assert.equal(skipped.built, 0);

  const controller = new AbortController();
  controller.abort();
  const aborted = await prewarmGeometryBlas([new THREE.PlaneGeometry(1, 1, 2, 2)], { builder: inProcessBuilder(), signal: controller.signal });
  assert.equal(aborted.built, 0);

  // node has no Worker: the prewarm still leaves the cache warm, paid on the
  // main thread, and says so in the receipt (the live path logs it once).
  const cold = new THREE.PlaneGeometry(1, 1, 3, 3);
  const before = blasBuildStats.syncBuilds;
  const fallback = await quiet(() => prewarmGeometryBlas([cold]));
  assert.equal(fallback.fallback, 1);
  assert.equal(fallback.worker, false);
  assert.equal(blasBuildStats.syncBuilds, before + 1);
  assert.equal(blasCacheState(cold), "warm");
});

// ── (c) worker pack === main-thread pack ───────────────────────────────────

test("a worker-built BVH packs byte-identical to the main-thread pack", () => {
  const plane = new THREE.PlaneGeometry(3, 2, 9, 7); // 126 tris, Uint16 index
  const heights = plane.attributes.position;
  for (let i = 0; i < heights.count; i++) heights.setZ(i, Math.sin(i * 1.7) * 0.3); // a non-trivial partition
  const box = new THREE.BoxGeometry(1, 2, 3); // six groups

  for (const source of [plane, box]) {
    const viaSync = source.clone();
    const viaWorker = source.clone();
    assert.equal(viaSync.boundingBox, null, "neither clone arrives with a box — both paths must mint the same one");

    const packedSync = packGeometryBlas(viaSync);

    // What bvhBlasWorker.js does with a message: copies in, roots + index out.
    const built = buildBlasFromArrays({
      position: viaWorker.attributes.position.array.slice(),
      index: new Uint32Array(viaWorker.index.array),
    });
    const bvh = blasFromWorkerResult(viaWorker, built);
    assert.ok(bvh instanceof MeshBVH, "the worker result is a real MeshBVH");
    assert.equal(bvh._roots.length, 1, "one root from a groupless copy");
    const packedWorker = packGeometryBlasFrom(viaWorker, bvh);

    for (const key of ["nodeCount", "triCount", "vertexCount"]) {
      assert.equal(packedWorker[key], packedSync[key], key);
    }
    for (const key of ["bounds", "contents", "index", "position", "uv"]) {
      assert.equal(packedWorker[key].constructor, packedSync[key].constructor, `${key} type`);
      assert.equal(Buffer.compare(bytes(packedWorker[key]), bytes(packedSync[key])), 0, `${key} is byte-identical`);
    }
    assert.deepEqual(packedWorker.boundsMin.toArray(), packedSync.boundsMin.toArray());
    assert.deepEqual(packedWorker.boundsMax.toArray(), packedSync.boundsMax.toArray());
    assert.deepEqual(viaWorker.boundingBox.min.toArray(), viaSync.boundingBox.min.toArray(), "the same box is minted onto the geometry");
    assert.deepEqual(viaWorker.boundingBox.max.toArray(), viaSync.boundingBox.max.toArray());
    assert.deepEqual(viaWorker.groups, source.groups, "the worker path leaves groups alone");
    assert.deepEqual(viaSync.groups, source.groups, "and so does the sync path, after its build");

    // The worker path never reordered the live index.
    assert.equal(Buffer.compare(bytes(viaWorker.index.array), bytes(source.index.array)), 0);
  }
});
