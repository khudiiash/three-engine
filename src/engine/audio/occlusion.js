import * as THREE from "three/webgpu";

/**
 * Per-sound occlusion test.
 *
 * Strategy: try `engine.physics.raycast` first — Rapier (or any module that
 * exposes the same API) handles mesh-vs-segment tests against the live
 * physics world with native performance. When physics is absent or not
 * currently playing, fall back to a cheap geometric test that walks every
 * occluder candidate's bounding sphere, then refines the closest one with
 * a triangle-vs-segment check.
 *
 * Returns a fraction in [0, 1] representing how occluded the path is — the
 * AudioSystem multiplies the source's gain by `(1 - attenuation * fraction)`.
 *
 * Per-frame cost: dominated by the mesh triangle test, which we only run
 * once (the closest candidate). For the typical scene (~5 occluders near
 * the camera) this is well under a millisecond.
 */

const _direction = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();

/**
 * Returns { fractionOccluded, hit } or null when no occlusion test ran.
 * `hit` is a debugging shape; the AudioSystem only consumes the fraction.
 */
export function raycastOcclusion(engine, originX, originY, originZ, targetX, targetY, targetZ) {
  if (!engine) return null;

  // Path 1: physics.raycast — high-fidelity.
  if (engine.physics && typeof engine.physics.raycast === "function" && engine.playing) {
    const dx = targetX - originX;
    const dy = targetY - originY;
    const dz = targetZ - originZ;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-3) return { fractionOccluded: 0, hit: null };
    const hit = engine.physics.raycast(
      [originX, originY, originZ],
      [dx / len, dy / len, dz / len],
      len,
    );
    if (hit) {
      // One solid hit occludes strongly; we treat "distance < len" as a hit
      // and map closeness to the attenuation. A near hit (almost the full
      // path) attenuates less than a wall right next to the source.
      const closeness = Math.max(0, Math.min(1, hit.distance / len));
      return { fractionOccluded: closeness, hit };
    }
    return { fractionOccluded: 0, hit: null };
  }

  // Path 2: bounding-sphere early-out + closest-mesh refinement.
  return geometricOcclusion(engine, originX, originY, originZ, targetX, targetY, targetZ);
}

function geometricOcclusion(engine, ox, oy, oz, tx, ty, tz) {
  const dx = tx - ox;
  const dy = ty - oy;
  const dz = tz - oz;
  const segmentLenSq = dx * dx + dy * dy + dz * dz;
  if (segmentLenSq < 1e-6) return { fractionOccluded: 0, hit: null };
  const segmentLen = Math.sqrt(segmentLenSq);

  // Phase 1 — find the closest bounding sphere along the ray. Walk every
  // entity with a Mesh (mesh occluders are the common case).
  let closest = null;
  for (const entity of engine.entities.values()) {
    const meshComp = entity.getComponent?.("mesh");
    const mesh = meshComp?.mesh;
    if (!mesh || !mesh.geometry) continue;
    const sphere = mesh.geometry.boundingSphere;
    if (!sphere) continue;
    // World-space center.
    entity.object3D.updateWorldMatrix(true, false);
    const worldCenter = sphere.center.clone().applyMatrix4(entity.object3D.matrixWorld);
    const worldRadius = sphere.radius * entity.object3D.getWorldScale(new THREE.Vector3()).length() / Math.sqrt(3);

    // Sphere-vs-segment test: dist² between sphere center and the segment,
    // clamped to [0, segmentLen].
    const cx = worldCenter.x;
    const cy = worldCenter.y;
    const cz = worldCenter.z;
    const relX = cx - ox;
    const relY = cy - oy;
    const relZ = cz - oz;
    const t = Math.max(0, Math.min(segmentLen, (relX * dx + relY * dy + relZ * dz) / segmentLenSq));
    const distSq = (relX - dx * t) ** 2 + (relY - dy * t) ** 2 + (relZ - dz * t) ** 2;
    const r = worldRadius;
    if (distSq > r * r) continue;

    // Skip the entity itself and its ancestors (a sound shouldn't occlude
    // itself). Cheap O(depth) walk.
    if (isSelfOrAncestor(entity, entity)) continue;

    if (!closest || t < closest.t) {
      closest = { entity, t, sphere, worldCenter };
    }
  }
  if (!closest) return { fractionOccluded: 0, hit: null };

  // Phase 2 — closest candidate gets a real triangle test. Cheap because we
  // only do this once per sound per frame.
  if (meshIntersectsSegment(engine, closest.entity, ox, oy, oz, tx, ty, tz)) {
    const closeness = Math.max(0, Math.min(1, closest.t / segmentLen));
    return { fractionOccluded: closeness, hit: { entity: closest.entity, distance: closest.t } };
  }
  return { fractionOccluded: 0, hit: null };
}

/**
 * Triangle-vs-segment test for one mesh. The mesh's transform is captured
 * once per frame (the caller already updatedWorldMatrix).
 */
function meshIntersectsSegment(engine, entity, ox, oy, oz, tx, ty, tz) {
  const meshComp = entity.getComponent?.("mesh");
  const mesh = meshComp?.mesh;
  if (!mesh?.geometry?.attributes?.position) return false;
  const geom = mesh.geometry;
  geom.computeBoundingBox();
  if (!geom.boundingBox) return false;
  // Reject early when the world AABB doesn't even contain the segment.
  entity.object3D.updateWorldMatrix(true, false);
  const worldBox = geom.boundingBox.clone().applyMatrix4(entity.object3D.matrixWorld);
  const min = worldBox.min;
  const max = worldBox.max;
  if (!segmentHitsBox(ox, oy, oz, tx, ty, tz, min, max)) return false;

  // Refine with a brute-force triangle test. This is the only heavy step;
  // the candidate count is bounded by Phase 1, so the cost is one mesh
  // worth of triangles per sound per frame.
  const posAttr = geom.attributes.position;
  const index = geom.index;
  const local = entity.object3D.matrixWorld;
  const inverse = new THREE.Matrix4().copy(local).invert();
  const oLocal = new THREE.Vector3(ox, oy, oz).applyMatrix4(inverse);
  const tLocal = new THREE.Vector3(tx, ty, tz).applyMatrix4(inverse);
  const sDir = new THREE.Vector3().subVectors(tLocal, oLocal);
  const segLen = sDir.length();
  if (segLen < 1e-6) return false;
  sDir.normalize();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const triCount = index ? index.count / 3 : posAttr.count / 3;
  for (let i = 0; i < triCount; i++) {
    let i0, i1, i2;
    if (index) {
      i0 = index.getX(i * 3);
      i1 = index.getX(i * 3 + 1);
      i2 = index.getX(i * 3 + 2);
    } else {
      i0 = i * 3;
      i1 = i * 3 + 1;
      i2 = i * 3 + 2;
    }
    a.fromBufferAttribute(posAttr, i0);
    b.fromBufferAttribute(posAttr, i1);
    c.fromBufferAttribute(posAttr, i2);
    if (rayTriangleIntersect(oLocal, sDir, a, b, c, segLen)) return true;
  }
  return false;
}

function rayTriangleIntersect(origin, dir, a, b, c, maxT) {
  // Möller–Trumbore, inlined. Returns true when the ray hits the triangle
  // within `[0, maxT]`.
  v1.subVectors(b, a);
  v0.subVectors(c, a);
  normal.crossVectors(dir, v0);
  const det = v1.dot(normal);
  if (Math.abs(det) < 1e-8) return false;
  const invDet = 1 / det;
  const tvec = new THREE.Vector3().subVectors(origin, a);
  const u = tvec.dot(normal) * invDet;
  if (u < 0 || u > 1) return false;
  const qvec = new THREE.Vector3().crossVectors(tvec, v1);
  const v = dir.dot(qvec) * invDet;
  if (v < 0 || u + v > 1) return false;
  const t = v0.dot(qvec) * invDet;
  return t >= 0 && t <= maxT;
}

const v1 = new THREE.Vector3();
const v0 = new THREE.Vector3();

function segmentHitsBox(x1, y1, z1, x2, y2, z2, min, max) {
  // Slab test, axis-aligned.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  let tmin = 0;
  let tmax = 1;
  for (const [o, d, lo, hi] of [
    [x1, dx, min.x, max.x],
    [y1, dy, min.y, max.y],
    [z1, dz, min.z, max.z],
  ]) {
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return false;
    } else {
      const inv = 1 / d;
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
  }
  return true;
}

function isSelfOrAncestor(candidate, target) {
  for (let e = target; e; e = e.parent) {
    if (e === candidate) return true;
  }
  return false;
}
