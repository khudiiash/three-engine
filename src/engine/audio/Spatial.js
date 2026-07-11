import * as THREE from "three/webgpu";

/**
 * Scratch instances — reused on every per-frame call so the audio system
 * avoids allocating. The hot path (one write per sound + one per listener
 * per frame) would otherwise churn the GC.
 */
const _scratchPos = new THREE.Vector3();
const _scratchForward = new THREE.Vector3();
const _scratchUp = new THREE.Vector3();
const _scratchQuat = new THREE.Quaternion();

/**
 * Writes the entity's world-space position into `out`. Falls back to (0,0,0)
 * when no object3D is attached yet.
 */
export function worldPosition(entity, out = _scratchPos) {
  if (!entity?.object3D) {
    out.set(0, 0, 0);
    return out;
  }
  return entity.object3D.getWorldPosition(out);
}

/**
 * Writes the entity's world-space forward vector (local -Z, the conventional
 * "looking direction" for cameras and Three.js objects) into `out`. Default
 * is -Z, matching an identity rotation.
 */
export function worldForward(entity, out = _scratchForward) {
  if (!entity?.object3D) {
    out.set(0, 0, -1);
    return out;
  }
  return entity.object3D.getWorldDirection(out);
}

/**
 * Writes the entity's world-space up vector (local +Y, identity-up) into
 * `out`. Defaults to +Y.
 */
export function worldUp(entity, out = _scratchUp) {
  out.set(0, 1, 0);
  if (!entity?.object3D) return out;
  const q = entity.object3D.getWorldQuaternion(_scratchQuat);
  return out.applyQuaternion(q);
}

/**
 * Returns the squared distance between two arbitrary points, avoiding the
 * square root since occlusion lookup uses it as a sort key.
 */
export function distanceSq(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Returns the squared length of `(x, y, z)` — used by the geometric fallback
 * to compare ray directions quickly (without square-rooting).
 */
export function lengthSq(x, y, z) {
  return x * x + y * y + z * z;
}

/** Returns the unit-length version of `(x, y, z)` or the fallback if zero. */
export function safeNormalize(x, y, z, fallback = [0, 1, 0]) {
  const lenSq = lengthSq(x, y, z);
  if (lenSq < 1e-12) return fallback;
  const inv = 1 / Math.sqrt(lenSq);
  return [x * inv, y * inv, z * inv];
}
