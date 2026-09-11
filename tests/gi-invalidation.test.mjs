// GATE: the two GI invalidation decisions that cost the most when wrong.
//
// Both of these shipped BROKEN and were found live on the user's Sponza
// (2026-09-09) by the freeze ledger. Each check below was verified to FAIL
// against the pre-fix behaviour, which is the only thing that makes a
// regression gate worth having.

import test from "node:test";
import assert from "node:assert/strict";
import { giBvhContentKey, giEnvIblSuppressed } from "../src/modules/gi/giInvalidation.js";

// ── Fixtures ───────────────────────────────────────────────────────────────
// Only the fields `buildBvhScene` and the fingerprint actually read. A mesh
// here is a bag of those fields, not a THREE object: the point of the pure
// module is that this needs no renderer.
let nextId = 1;
function mesh({ tris = 12, skinned = false, indexed = true, verts = 36 } = {}) {
  return {
    id: nextId++,
    isSkinnedMesh: skinned,
    material: { color: { r: 1, g: 1, b: 1 }, emissive: { r: 0, g: 0, b: 0 }, emissiveIntensity: 1 },
    geometry: {
      id: nextId++,
      index: indexed ? { count: tris * 3, version: 0 } : null,
      attributes: { position: { count: verts, version: 0 } },
    },
  };
}
const entriesOf = (...meshes) => meshes.map((m) => ({ mesh: m }));

// ── giBvhContentKey ────────────────────────────────────────────────────────

test("bvh key: identical content is an identical key", () => {
  const a = mesh();
  const b = mesh();
  const entries = entriesOf(a, b);
  assert.equal(giBvhContentKey(entries), giBvhContentKey(entries));
  // A fresh array over the SAME meshes is the same scene.
  assert.equal(giBvhContentKey(entries), giBvhContentKey(entriesOf(a, b)));
});

test("bvh key: a material COLOUR change does not move it", () => {
  // ⭐ THE BUG. `#computeFingerprint` folds base colour, so a palette re-tint
  // (which `computeCompressedTextureAverage` performs on every KTX2 scene
  // AFTER it is already on screen) dropped a full 214k-triangle rebuild, a
  // new reflect kernel, an atlas re-blit and a ~280 ms reflection-probe
  // kernel re-arm — to produce a byte-identical BVH.
  const a = mesh();
  const before = giBvhContentKey(entriesOf(a));
  a.material.color = { r: 0.2, g: 0.5, b: 0.9 };
  assert.equal(giBvhContentKey(entriesOf(a)), before);
});

test("bvh key: an EMISSIVE change does not move it", () => {
  const a = mesh();
  const before = giBvhContentKey(entriesOf(a));
  a.material.emissive = { r: 4, g: 4, b: 4 };
  a.material.emissiveIntensity = 9;
  assert.equal(giBvhContentKey(entriesOf(a)), before);
});

test("bvh key: adding or removing a mesh moves it", () => {
  const a = mesh();
  const b = mesh();
  assert.notEqual(giBvhContentKey(entriesOf(a)), giBvhContentKey(entriesOf(a, b)));
  assert.notEqual(giBvhContentKey(entriesOf(a, b)), giBvhContentKey(entriesOf(b)));
});

test("bvh key: a geometry EDIT moves it", () => {
  // The one vertex-data change that really does need a new BLAS.
  const a = mesh();
  const before = giBvhContentKey(entriesOf(a));
  a.geometry.attributes.position.version++;
  assert.notEqual(giBvhContentKey(entriesOf(a)), before);
});

test("bvh key: a topology change (index count or version) moves it", () => {
  const a = mesh();
  const byCount = mesh();
  byCount.id = a.id;
  byCount.geometry.id = a.geometry.id;
  byCount.geometry.index.count = a.geometry.index.count + 3;
  byCount.geometry.attributes.position.count = a.geometry.attributes.position.count;
  assert.notEqual(giBvhContentKey(entriesOf(byCount)), giBvhContentKey(entriesOf(a)));

  const before = giBvhContentKey(entriesOf(a));
  a.geometry.index.version++;
  assert.notEqual(giBvhContentKey(entriesOf(a)), before);
});

test("bvh key: ELIGIBILITY changes move it — skinned and unindexed are excluded meshes", () => {
  // `buildBvhScene` pushes both of these to the coverage-flag set instead of
  // the traced set, so the scene it builds genuinely differs.
  const a = mesh();
  const before = giBvhContentKey(entriesOf(a));
  a.isSkinnedMesh = true;
  assert.notEqual(giBvhContentKey(entriesOf(a)), before);

  const b = mesh();
  const indexed = giBvhContentKey(entriesOf(b));
  b.geometry.index = null;
  assert.notEqual(giBvhContentKey(entriesOf(b)), indexed);
});

test("bvh key: duplicate placements collapse (an InstancedMesh is one BLAS)", () => {
  // `#syncBvhScene` dedupes with `new Set(entries.map(e => e.mesh))`; feeding
  // the builder the same mesh 200 times would build 200 identical BLASes, and
  // a key that counted them would rebuild whenever the instance count moved.
  const a = mesh();
  assert.equal(giBvhContentKey(entriesOf(a, a, a)), giBvhContentKey(entriesOf(a)));
});

test("bvh key: empty and entry-less inputs are the same stable key", () => {
  assert.equal(giBvhContentKey([]), "empty");
  assert.equal(giBvhContentKey(null), "empty");
  assert.equal(giBvhContentKey(undefined), "empty");
  // Entries whose mesh is gone contribute nothing rather than hashing null.
  assert.equal(giBvhContentKey([{ mesh: null }, {}]), "empty");
});

// ── giEnvIblSuppressed ─────────────────────────────────────────────────────

test("env ibl: not installed before GI can light (the 'everything disappears' guard)", () => {
  assert.equal(giEnvIblSuppressed({ hasEnvironment: true, giLive: false, latched: false }), false);
});

test("env ibl: installed once GI is live", () => {
  assert.equal(giEnvIblSuppressed({ hasEnvironment: true, giLive: true, latched: false }), true);
});

test("env ibl: A TRANSIENT re-arm does NOT drop it once latched", () => {
  // ⭐ THE BUG. `_fieldReadyOnce` is cleared by a rebuild, a half-built
  // occupancy pyramid, a skipped dispatch and a static-BVH rebuild. Each drop
  // and re-install re-mints every lit material, because `scene.environmentNode`
  // is half of three's node-builder dynamic cache key — measured at 578 ms +
  // 441 ms inside ONE rebuild that had already reported "materials reused".
  assert.equal(giEnvIblSuppressed({ hasEnvironment: true, giLive: false, latched: true }), true);
});

test("env ibl: the latch drops for the three reasons that really mean 'GI is not lighting this'", () => {
  // 1. the hatch — and it beats the latch, or `__giKeepIBL` could never win.
  assert.equal(giEnvIblSuppressed({ keep: true, hasEnvironment: true, giLive: true, latched: true }), false);
  // 2. the environment went away (a dummy node on an env-less scene would flip
  //    three's hasSceneEnvironment and dirty every cache key for nothing).
  assert.equal(giEnvIblSuppressed({ hasEnvironment: false, giLive: true, latched: true }), false);
  // 3. dispose() clears the latch itself; with both false nothing installs.
  assert.equal(giEnvIblSuppressed({ hasEnvironment: true, giLive: false, latched: false }), false);
});

test("env ibl: defaults are the safe ones", () => {
  assert.equal(giEnvIblSuppressed(), false);
  assert.equal(giEnvIblSuppressed({}), false);
});
