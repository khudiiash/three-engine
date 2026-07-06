import * as THREE from "three/webgpu";

/**
 * CPU-side geometry sampling shared by anything that needs to bake random
 * points from a mesh into a GPU buffer once (particle emitSelf, instancer
 * onMesh scatter). Object-space in, object-space out — callers apply
 * whatever transform their use case needs.
 */

function triangleCount(geometry) {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  return index ? index.count / 3 : position.count / 3;
}

function triVerts(geometry, t, out) {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  let i0, i1, i2;
  if (index) {
    i0 = index.getX(t * 3);
    i1 = index.getX(t * 3 + 1);
    i2 = index.getX(t * 3 + 2);
  } else {
    i0 = t * 3;
    i1 = t * 3 + 1;
    i2 = t * 3 + 2;
  }
  out[0].fromBufferAttribute(position, i0);
  out[1].fromBufferAttribute(position, i1);
  out[2].fromBufferAttribute(position, i2);
}

/** Face-area-weighted cumulative distribution over a geometry's triangles. */
function buildAreaCdf(geometry, triCount) {
  const cdf = new Float32Array(triCount);
  const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    triVerts(geometry, t, [a, b, c]);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    total += ab.cross(ac).length() * 0.5;
    cdf[t] = total;
  }
  return { cdf, total };
}

function pickTriangle(cdf, total, r) {
  const target = r * total;
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Uniformly samples `count` points across the surface of `geometry`,
 * weighted by triangle area. Returns object-space positions + face normals.
 */
export function sampleSurfacePoints(geometry, count) {
  const triCount = triangleCount(geometry);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  if (triCount === 0) return { positions, normals };

  const { cdf, total } = buildAreaCdf(geometry, triCount);
  if (total <= 0) return { positions, normals };

  const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  const p = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const t = pickTriangle(cdf, total, Math.random());
    triVerts(geometry, t, [a, b, c]);
    let u = Math.random();
    let v = Math.random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const w = 1 - u - v;
    p.set(0, 0, 0).addScaledVector(a, w).addScaledVector(b, u).addScaledVector(c, v);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac).normalize();
    positions.set([p.x, p.y, p.z], i * 3);
    normals.set([n.x, n.y, n.z], i * 3);
  }
  return { positions, normals };
}

const EPS = 1e-7;

/** Möller–Trumbore ray/triangle test along a fixed direction; returns hit distance or null. */
function rayTriangle(origin, dir, a, b, c) {
  const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
  const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
  const px = dir.y * e2z - dir.z * e2y;
  const py = dir.z * e2x - dir.x * e2z;
  const pz = dir.x * e2y - dir.y * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < EPS) return null;
  const invDet = 1 / det;
  const tx = origin.x - a.x, ty = origin.y - a.y, tz = origin.z - a.z;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir.x * qx + dir.y * qy + dir.z * qz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const dist = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return dist > EPS ? dist : null;
}

/**
 * Rejection-samples `count` points inside the volume enclosed by `geometry`
 * (must be reasonably closed/manifold). Containment is tested by counting
 * ray intersections along +X from the candidate point — odd = inside.
 * Normals are the inward-pointing direction (unused by callers today, kept
 * for parity with sampleSurfacePoints' return shape).
 */
export function sampleVolumePoints(geometry, count) {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return { positions, normals };

  const triCount = triangleCount(geometry);
  const tris = [];
  const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let t = 0; t < triCount; t++) {
    triVerts(geometry, t, [a, b, c]);
    tris.push([a.clone(), b.clone(), c.clone()]);
  }

  const dir = new THREE.Vector3(1, 0, 0);
  const p = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxAttempts = count * 64;
  let written = 0;
  let attempts = 0;

  while (written < count && attempts < maxAttempts) {
    attempts++;
    p.set(
      box.min.x + Math.random() * size.x,
      box.min.y + Math.random() * size.y,
      box.min.z + Math.random() * size.z,
    );
    let hits = 0;
    for (const [ta, tb, tc] of tris) {
      if (rayTriangle(p, dir, ta, tb, tc) !== null) hits++;
    }
    if (hits % 2 === 1) {
      positions.set([p.x, p.y, p.z], written * 3);
      normals.set([0, 1, 0], written * 3);
      written++;
    }
  }
  // Fill any remainder (degenerate/non-closed geometry) with the box center.
  const cx = box.min.x + size.x / 2, cy = box.min.y + size.y / 2, cz = box.min.z + size.z / 2;
  for (; written < count; written++) {
    positions.set([cx, cy, cz], written * 3);
    normals.set([0, 1, 0], written * 3);
  }
  return { positions, normals };
}
