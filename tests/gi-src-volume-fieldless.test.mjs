// SRC VOLUME WITHOUT AN OCCUPANCY FIELD (plan §10 / §10.1 — the BVH-only
// visibility structure). The volume bundle used to THROW without a field; the
// BVH-only build has no field and still needs `world.min/size/cell/minCell/
// cellMax/capWorld` for every downstream bias uniform. This pins the shape of
// that mode: bounds + a nominal cell, `null` for everything that closed over
// the field, and the field arms byte-identical.
//
// Plain node, no GPU: `srcVolume.js` imports `three/webgpu` and `three/tsl`,
// but the world bundle is `THREE.Vector3` + `uniform()` and no graph is built
// here (`scripts/run-gi-src-volume-test.mjs` imports it the same way).
//
// Run with `node --test tests/gi-src-volume-fieldless.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three/webgpu";

import { createSrcVolume, createSrcWorld } from "../src/modules/gi/srcVolume.js";

const roomBounds = () => new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 4, 6));
const xyz = (v) => [v.x, v.y, v.z];

test("a field-less volume from bounds is bounds + a nominal cell", () => {
  const vol = createSrcVolume({ bounds: roomBounds(), minCell: 0.25 });
  assert.equal(vol.occupancyField, null);
  assert.equal(vol.distance, null);
  assert.equal(vol.res, null);
  assert.deepEqual(xyz(vol.world.min.value), [0, 0, 0]);
  assert.deepEqual(xyz(vol.world.size.value), [10, 4, 6]);
  assert.deepEqual(xyz(vol.cell), [0.25, 0.25, 0.25]);
  assert.deepEqual(xyz(vol.world.cell.value), [0.25, 0.25, 0.25]);
  assert.equal(vol.minCell, 0.25);
  assert.equal(vol.world.minCell.value, 0.25);
  assert.equal(vol.world.cellMax.value, 0.25);
  assert.equal(vol.capWorld, 4);
  assert.equal(vol.world.capWorld.value, 4);
});

test("setBounds moves min/size, mutates the caller's box, and keeps the nominal cell", () => {
  const bounds = roomBounds();
  const vol = createSrcVolume({ bounds, minCell: 0.25 });
  const next = new THREE.Box3(new THREE.Vector3(-2, -1, -3), new THREE.Vector3(18, 7, 9));
  vol.setBounds(next);
  assert.deepEqual(xyz(vol.world.min.value), [-2, -1, -3]);
  assert.deepEqual(xyz(vol.world.size.value), [20, 8, 12]);
  assert.deepEqual(xyz(vol.cell), [0.25, 0.25, 0.25]);
  assert.equal(vol.minCell, 0.25);
  assert.equal(vol.world.minCell.value, 0.25);
  assert.equal(vol.world.cellMax.value, 0.25);
  assert.equal(vol.capWorld, 4);
  assert.equal(vol.world.capWorld.value, 4);
  assert.ok(bounds.min.equals(next.min) && bounds.max.equals(next.max), "giField's setBounds mutated the caller's box; so does this one");
});

test("the field-bound factories return null so callers can feature-detect", () => {
  const vol = createSrcVolume({ bounds: roomBounds(), minCell: 0.25 });
  assert.equal(vol.createSoftShadowTrace(0.2, 56, "giLightShadowTrace", true), null);
  assert.equal(vol.createSoftShadowTrace(), null);
  assert.equal(vol.createWidthProbe("srcShadowWidthProbe"), null);
  assert.equal(vol.createWidthProbe?.() ?? null, null);
});

test("neither a field nor bounds still throws, with a message that says so", () => {
  assert.throws(() => createSrcVolume({}), /occupancy field or bounds/);
  assert.throws(() => createSrcVolume(), /occupancy field or bounds/);
  assert.throws(() => createSrcVolume({ occField: null, res: { x: 8, y: 8, z: 8 } }), /occupancy field or bounds/);
});

test("createSrcWorld defaults the nominal cell to 0.1 m and ignores a bad one", () => {
  const w = createSrcWorld(roomBounds());
  assert.equal(w.minCellValue, 0.1);
  assert.equal(w.capWorldValue, 16 * 0.1);
  assert.deepEqual(xyz(w.cell.value), [0.1, 0.1, 0.1]);
  for (const bad of [0, -1, NaN, Infinity, "0.3"]) {
    assert.equal(createSrcWorld(roomBounds(), null, null, { minCell: bad }).minCellValue, 0.1, `minCell ${bad}`);
  }
  w.refit(new THREE.Box3(new THREE.Vector3(1, 1, 1), new THREE.Vector3(3, 3, 3)));
  assert.deepEqual(xyz(w.size.value), [2, 2, 2]);
  assert.equal(w.minCellValue, 0.1);
});

test("a field-less volume with `res` still derives its cell from the lattice, not the nominal", () => {
  const vol = createSrcVolume({ bounds: roomBounds(), res: { x: 20, y: 8, z: 24 }, minCell: 0.9 });
  assert.equal(vol.occupancyField, null);
  assert.deepEqual(xyz(vol.cell), [0.5, 0.5, 0.25]);
  assert.equal(vol.minCell, 0.25);
  assert.equal(vol.world.cellMax.value, 0.5);
  assert.equal(vol.capWorld, 4);
});

test("the field arms are unchanged: voxel-derived cell, the (1,1,1) fallback, and refit chaining", () => {
  const field = { voxel: { value: new THREE.Vector3(0.1, 0.1, 0.1) }, hasSurfaceRecords: false, refits: 0, refit() { this.refits++; } };
  const vol = createSrcVolume({ occField: field, bounds: roomBounds(), res: null, minCell: 0.9 });
  assert.equal(vol.occupancyField, field);
  assert.equal(typeof vol.distance, "function");
  assert.deepEqual(xyz(vol.cell), [0.1, 0.1, 0.1], "the nominal is ignored when a field supplies the voxel");
  assert.equal(vol.capWorld, 1.6);
  vol.setBounds(new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)));
  assert.equal(field.refits, 1);
  assert.deepEqual(xyz(vol.cell), [0.1, 0.1, 0.1]);
  // A field without a voxel still lands on the historical (1,1,1) cell.
  const bare = createSrcVolume({ occField: { hasSurfaceRecords: false, refit() {} }, bounds: roomBounds(), minCell: 0.9 });
  assert.deepEqual(xyz(bare.cell), [1, 1, 1]);
  assert.equal(bare.capWorld, 16);
});
