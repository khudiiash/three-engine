globalThis.document ??= { body: {} };
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { buildSceneBVHAsync } from "../src/modules/restir-gi/bvh.js";

// Scene: floor quad at y=0 spanning [-5,5]^2, wall quad at x=5 (yz plane).
const scene = new THREE.Scene();
const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ color: 0x8080ff }));
floor.rotation.x = -Math.PI / 2;
const wall = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ color: 0xff0000 }));
wall.position.x = 5;
wall.rotation.y = -Math.PI / 2;
scene.add(floor, wall);
scene.updateMatrixWorld(true);

const bvh = await buildSceneBVHAsync(scene);
assert.ok(!bvh.cancelled);
assert.equal(bvh.count, 4, "two quads = four triangles");
assert.ok(bvh.nodeCount >= 1);
console.log(`built: tris=${bvh.count} nodes=${bvh.nodeCount} ms=${bvh.buildMs.toFixed(1)}`);

// JS reference of the GPU traversal (same threaded walk + leaf decode).
function trace(o, d, tMax = 1e30) {
  let best = tMax, bestTri = -1;
  const inv = d.map((c) => 1 / (Math.abs(c) < 1e-8 ? (c < 0 ? -1e-8 : 1e-8) : c));
  let ptr = 0;
  let guard = 0;
  while (ptr >= 0 && guard++ < 10000) {
    const nb = ptr * 8;
    const leafCode = bvh.nodes[nb + 3];
    const miss = bvh.nodes[nb + 7];
    let tn = 0, tf = best;
    for (let a = 0; a < 3; a++) {
      const t0 = (bvh.nodes[nb + a] - o[a]) * inv[a];
      const t1 = (bvh.nodes[nb + 4 + a] - o[a]) * inv[a];
      tn = Math.max(tn, Math.min(t0, t1));
      tf = Math.min(tf, Math.max(t0, t1));
    }
    if (tn > tf) { ptr = miss; continue; }
    if (leafCode < 0) {
      const code = -leafCode - 1;
      const start = Math.floor(code / 4);
      const cnt = (code % 4) + 1;
      for (let k = 0; k < cnt; k++) {
        const tb = (start + k) * 12;
        const v0 = bvh.positions.subarray(tb, tb + 3);
        const v1 = bvh.positions.subarray(tb + 4, tb + 7);
        const v2 = bvh.positions.subarray(tb + 8, tb + 11);
        const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
        const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
        const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
        const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
        if (Math.abs(det) < 1e-10) continue;
        const invDet = 1 / det;
        const tv = [o[0] - v0[0], o[1] - v0[1], o[2] - v0[2]];
        const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * invDet;
        if (u < 0 || u > 1) continue;
        const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
        const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * invDet;
        if (v < 0 || u + v > 1) continue;
        const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * invDet;
        if (t > 1e-3 && t < best) { best = t; bestTri = start + k; }
      }
      ptr = miss;
    } else {
      ptr = ptr + 1;
    }
  }
  return { t: best, tri: bestTri };
}

const down = trace([0, 1, 0], [0, -1, 0]);
assert.ok(down.tri >= 0 && Math.abs(down.t - 1) < 1e-4, `down ray hits floor at t=1, got t=${down.t} tri=${down.tri}`);
const toWall = trace([0, 1, 0], [1, 0, 0]);
assert.ok(toWall.tri >= 0 && Math.abs(toWall.t - 5) < 1e-4, `+x ray hits wall at t=5, got t=${toWall.t}`);
const up = trace([0, 1, 0], [0, 1, 0]);
assert.equal(up.tri, -1, "up ray misses");
const diag = trace([-4, 0.5, -4], [Math.SQRT1_2, 0, Math.SQRT1_2]);
assert.ok(diag.tri >= 0 && Math.abs(diag.t - 9 * Math.SQRT2) < 1e-3, `diagonal hits wall, got t=${diag.t}`);
// Material colors are linear-space (three converts hex on assignment).
const expectedR = Math.round(floor.material.color.r * 255);
const albedo = bvh.data[down.tri * 4] & 0xff;
assert.equal(albedo, expectedR, `floor albedo red channel packs the linear material color`);

// Stress: 5k random triangles, compare 200 rays against brute force.
{
  const geo = new THREE.BufferGeometry();
  const n = 5000;
  const arr = new Float32Array(n * 9);
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n * 9; i += 9) {
    const cx = (rand() - 0.5) * 40, cy = (rand() - 0.5) * 40, cz = (rand() - 0.5) * 40;
    for (let v = 0; v < 3; v++) {
      arr[i + v * 3] = cx + (rand() - 0.5) * 2;
      arr[i + v * 3 + 1] = cy + (rand() - 0.5) * 2;
      arr[i + v * 3 + 2] = cz + (rand() - 0.5) * 2;
    }
  }
  geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  const cloud = new THREE.Scene();
  cloud.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
  cloud.updateMatrixWorld(true);
  const b2 = await buildSceneBVHAsync(cloud);
  const bruteTrace = (o, d) => {
    let best = 1e30;
    for (let i = 0; i < b2.count; i++) {
      const tb = i * 12;
      const v0 = b2.positions.subarray(tb, tb + 3);
      const v1 = b2.positions.subarray(tb + 4, tb + 7);
      const v2 = b2.positions.subarray(tb + 8, tb + 11);
      const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
      const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
      const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
      if (Math.abs(det) < 1e-10) continue;
      const invDet = 1 / det;
      const tv = [o[0] - v0[0], o[1] - v0[1], o[2] - v0[2]];
      const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) * invDet;
      if (u < 0 || u > 1) continue;
      const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
      const v = (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]) * invDet;
      if (v < 0 || u + v > 1) continue;
      const t = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) * invDet;
      if (t > 1e-3 && t < best) best = t;
    }
    return best;
  };
  // Local reference traversal against b2:
  const bvhSave = { ...bvh };
  Object.assign(bvh, b2);
  let mismatches = 0;
  for (let r = 0; r < 200; r++) {
    const o = [(rand() - 0.5) * 50, (rand() - 0.5) * 50, (rand() - 0.5) * 50];
    let d = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
    const len = Math.hypot(...d) || 1;
    d = d.map((c) => c / len);
    const a = trace(o, d).t;
    const b = bruteTrace(o, d);
    if (Math.abs(a - b) > 1e-3 && !(a > 1e29 && b > 1e29)) mismatches++;
  }
  Object.assign(bvh, bvhSave);
  assert.equal(mismatches, 0, `${mismatches} traversal mismatches vs brute force`);
  console.log(`stress: ${b2.count} tris, ${b2.nodeCount} nodes, 200 rays match brute force`);
}

console.log("BVH_TESTS_OK");
