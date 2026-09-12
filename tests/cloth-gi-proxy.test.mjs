/**
 * THE MESH-CLOTH GI PROXY LATTICE.
 *
 * The bug these exist for: a Cloth on an AUTHORED mesh was invisible to GI in
 * every respect (no traced shadow, no occlusion, no colour bleed), because
 * `userData.giGpuGrid` was only ever set on the plane path while both other
 * doors into GI are shut for a cloth by design. Sponza's curtains threw red
 * and green across the floor with Cloth off and nothing with it on.
 *
 * So what is proved here is that an arbitrary sheet gets a lattice: 81 corners
 * that SPAN it, in order, whatever its orientation — and that a plane cloth's
 * lattice is unchanged vertex for vertex now that the same arithmetic lives on
 * the CPU.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { instancedArray, uniform } from "three/tsl";

import { CLOTH_GI_PROXY_CORNERS, CLOTH_GI_PROXY_SPAN, clothGiProxyCorners } from "../src/engine/vfx/clothGiProxy.js";
import { GPU_GRID_BVH_CORNERS, createGpuGridBvh, gridBvhCorners } from "../src/modules/gi/gpuGridBvh.js";
import { createDynamicObjectSet } from "../src/modules/gi/dynamicObjects.js";
import { noteTextureAverage, pendingTextureAverages } from "../src/modules/gi/voxelizeOnce.js";

const SIDE = CLOTH_GI_PROXY_SPAN + 1;

/** A w×h sheet of vertices, rotated out of every world axis, xyz-interleaved. */
function sheet(w, h, { rotation = [0, 0, 0], skip = () => false } = {}) {
  const euler = new THREE.Euler(...rotation);
  const out = [];
  const keep = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (skip(x, y)) continue;
      const p = new THREE.Vector3(x / (w - 1) - 0.5, y / (h - 1) - 0.5, 0).multiplyScalar(4).applyEuler(euler);
      keep.push([x / (w - 1), y / (h - 1)]);
      out.push(p.x, p.y, p.z);
    }
  }
  return { positions: Float32Array.from(out), uv: keep, count: keep.length };
}

test("a rotated sheet gets a lattice that spans it, in order", () => {
  // 45° on two axes: the axis-aligned box of this sheet is a solid-looking
  // cube, which is exactly why the frame comes from the covariance instead.
  const { positions, uv, count } = sheet(24, 24, { rotation: [Math.PI / 4, Math.PI / 4, 0] });
  const corners = clothGiProxyCorners(positions, count);
  assert.ok(corners, "a 576-vertex sheet is big enough for an 81-corner lattice");
  assert.equal(corners.length, CLOTH_GI_PROXY_CORNERS);
  for (const index of corners) assert.ok(index < count, `corner ${index} is a real vertex of ${count}`);

  // The lattice is a PARAMETERISATION, so walking a row must walk the sheet:
  // each step advances monotonically in one of the source grid's own axes.
  // (Which axis, and which sign, is whatever the covariance picked — a square
  // sheet has no preferred one, and the proxy does not care.)
  const at = (x, y) => uv[corners[y * SIDE + x]];
  const rowAxis = Math.abs(at(SIDE - 1, 0)[0] - at(0, 0)[0]) > Math.abs(at(SIDE - 1, 0)[1] - at(0, 0)[1]) ? 0 : 1;
  const sign = Math.sign(at(SIDE - 1, 0)[rowAxis] - at(0, 0)[rowAxis]);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 1; x < SIDE; x++) {
      const step = (at(x, y)[rowAxis] - at(x - 1, y)[rowAxis]) * sign;
      assert.ok(step > 0.05, `row ${y} advances at column ${x} (got ${step.toFixed(3)})`);
    }
  }
  // And it reaches the edges: a proxy sampled from the middle of a curtain
  // would occlude and bleed from a sheet half the size of the real one.
  const spanned = Array.from(corners, (i) => uv[i]);
  for (const axis of [0, 1]) {
    assert.ok(Math.min(...spanned.map((p) => p[axis])) < 0.02, `lattice reaches axis ${axis} start`);
    assert.ok(Math.max(...spanned.map((p) => p[axis])) > 0.98, `lattice reaches axis ${axis} end`);
  }
});

test("a sheet with a hole fills every corner from its neighbours", () => {
  // An unfilled corner defaults to vertex 0, which drags a proxy quad across
  // the room and traces as a spike. The flood fill is what stops that.
  const hole = (x, y) => x > 6 && x < 17 && y > 6 && y < 17;
  const { positions, count } = sheet(24, 24, { skip: hole });
  const corners = clothGiProxyCorners(positions, count);
  assert.ok(corners);
  assert.equal(corners.length, CLOTH_GI_PROXY_CORNERS);
  for (const index of corners) assert.ok(index < count);
  // Nothing collapsed onto a single vertex: the rim is still sampled widely.
  assert.ok(new Set(corners).size > 40, `distinct corners ${new Set(corners).size}`);
});

test("a cloth too small or too degenerate to decimate declines a proxy", () => {
  const small = sheet(8, 8); // 64 vertices < 81 corners
  assert.equal(clothGiProxyCorners(small.positions, small.count), null);
  assert.equal(clothGiProxyCorners(new Float32Array(300), 100), null, "a point cloud has no plane");
  // A LINE has one principal axis and no second one: no lattice, no proxy.
  const line = new Float32Array(100 * 3);
  for (let i = 0; i < 100; i++) line[i * 3] = i * 0.01;
  assert.equal(clothGiProxyCorners(line, 100), null);
});

test("a plane cloth's lattice is unchanged now the arithmetic is on the CPU", () => {
  // The WGSL this replaced: sample = (coord * (resolution - 1) + 4) / 8, in
  // u32 arithmetic. A drift here silently re-shapes every plane cloth's proxy.
  for (const resolution of [9, 16, 32, 64, 128]) {
    const corners = gridBvhCorners(resolution);
    assert.equal(corners.length, GPU_GRID_BVH_CORNERS);
    for (let y = 0; y < SIDE; y++) {
      for (let x = 0; x < SIDE; x++) {
        const sx = Math.floor((x * (resolution - 1) + 4) / 8);
        const sy = Math.floor((y * (resolution - 1) + 4) / 8);
        assert.equal(corners[y * SIDE + x], sy * resolution + sx, `r${resolution} corner ${x},${y}`);
      }
    }
    assert.equal(corners[0], 0);
    assert.equal(corners[GPU_GRID_BVH_CORNERS - 1], resolution * resolution - 1, "the far corner is the last vertex");
  }
});

test("the proxy builder takes a corner table, and refuses a broken one", () => {
  const bits = instancedArray(new Uint32Array(16384), "uint");
  const positionAttribute = new THREE.StorageBufferAttribute(400, 3);
  const corners = Uint32Array.from({ length: GPU_GRID_BVH_CORNERS }, (_, i) => i * 4);
  const gpu = createGpuGridBvh({ bits, absStart: 0, positionAttribute, corners });
  assert.equal(gpu.corners, corners);
  assert.equal(gpu.computes.length, 1);
  assert.throws(
    () => createGpuGridBvh({ bits, absStart: 0, positionAttribute, corners: corners.slice(0, 80) }),
    /81 indices/,
  );
  assert.throws(
    // An index past the buffer is CLAMPED on WebGPU, not faulted — a proxy
    // silently pinned to the last vertex. It has to be caught here or nowhere.
    () => createGpuGridBvh({ bits, absStart: 0, positionAttribute, corners: corners.map((c) => (c === 0 ? 999 : c)) }),
    /is vertex 999 of 400/,
  );
  // No table and no square lattice is the pre-fix mesh cloth: a caller that
  // reaches here with neither has a bug, and must not get a silent proxy.
  assert.throws(() => createGpuGridBvh({ bits, absStart: 0, positionAttribute, resolution: 7 }), /corner table/);
});

test("a mesh cloth adopts into the dynamic set and carries its material colour", () => {
  // The whole point of the fix, one layer above the sampler: GI must see the
  // curtain, and must see it RED.
  const bits = instancedArray(new Uint32Array(16384), "uint");
  const dyn = createDynamicObjectSet({ bits, baseWord: 0, capacityWords: 16384, maxObjects: 4 });
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  material.colorNode = uniform(new THREE.Color(0xff0000));
  const { positions, count } = sheet(24, 24, { rotation: [0.3, 0.7, 0] });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.updateMatrixWorld(true);

  const corners = clothGiProxyCorners(positions, count);
  const positionAttribute = new THREE.StorageBufferAttribute(count, 3);
  const shape = {
    type: "mesh",
    center: new THREE.Vector3(),
    halfExtents: new THREE.Vector3(3, 3, 3),
    gpuGrid: { positionAttribute, corners },
  };
  assert.equal(dyn.adopt("cloth", mesh, null, shape), true);
  let entry;
  dyn.forEachEntry((e) => { entry = e; });
  assert.deepEqual(entry.surface.albedo, [1, 0, 0], "the bounce carries the curtain's colour");
  assert.ok(entry.geoBlock.gpu.computes.length > 0, "its proxy refits on the GPU");
});

test("a mover keeps asking until the albedo map's mean lands", () => {
  // ⭐ THE SECOND HALF OF THE SAME REPORT: "it reflects white light for some
  // reason, not taking the color of the cloth". A compressed (or still
  // decoding) albedo map has no mean on the first ask, so the resolver answers
  // with the CONSTANT factor alone — near white. The static palette corrects
  // itself on the next fingerprint scan; the mover's stamp
  // (`material.id:version:promoted`) does not move when a texture average
  // arrives, so before this it cached the white forever.
  const bits = instancedArray(new Uint32Array(16384), "uint");
  const dyn = createDynamicObjectSet({ bits, baseWord: 0, capacityWords: 16384, maxObjects: 4 });
  const texture = new THREE.CompressedTexture([], 4, 4);
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  material.map = texture;
  const geometry = new THREE.PlaneGeometry(2, 2, 8, 8);
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.updateMatrixWorld(true);
  const shape = {
    type: "mesh",
    center: new THREE.Vector3(),
    halfExtents: new THREE.Vector3(3, 3, 3),
    gpuGrid: { positionAttribute: new THREE.StorageBufferAttribute(81, 3), resolution: 9 },
  };
  assert.equal(dyn.adopt("curtain", mesh, null, shape), true);
  let entry;
  dyn.forEachEntry((e) => { entry = e; });
  assert.deepEqual(entry.surface.albedo, [1, 1, 1], "no mean yet: the constant factor alone");
  assert.ok(pendingTextureAverages.has(texture), "and the GPU averager has been asked");

  // The material is untouched — same id, same version, same promotion — which
  // is exactly the case the old stamp could not see.
  const before = material.version;
  noteTextureAverage(texture, { r: 0.5, g: 0.06, b: 0.05 });
  dyn.sync();
  dyn.forEachEntry((e) => { entry = e; });
  assert.equal(material.version, before, "nothing about the material changed");
  assert.deepEqual(entry.surface.albedo, [0.5, 0.06, 0.05], "the curtain bounces red");
  noteTextureAverage(texture, null); // leave no cross-test state behind
});
