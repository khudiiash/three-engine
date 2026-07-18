import * as THREE from "three/webgpu";
import { uniform, uniformArray } from "three/tsl";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";

/**
 * Capsule shadows for skinned characters (the UE approach for skeletal
 * meshes). Baked distance fields can't follow bones, so characters get a
 * handful of capsules auto-fitted to the skeleton from skin weights instead:
 * per bone, its dominant vertices are gathered in BONE-LOCAL bind space, and
 * a capsule covers their bounding box along its longest axis. At runtime the
 * endpoints just follow bone.matrixWorld — animation costs a few matrix
 * multiplies per frame and the sun trace tests each capsule analytically
 * (exact ray↔segment distance, no field, no texture).
 */

export const MAX_CAPSULES = 32; // scene-wide budget
export const MAX_CAPSULES_PER_MESH = 8;
const MIN_VERTS_PER_BONE = 24;
const MIN_RADIUS = 0.02;
const MAX_RADIUS = 1.5;
// Vertices accumulate into their dominant bone's ancestor at this skeleton
// depth: feather/finger/tail chains merge into wing/hand/hip capsules. One
// capsule per leaf bone turns a winged character's shadow into a fan of
// 2cm sticks — regional masses are what read as a creature's shadow.
const BONE_DEPTH_CAP = 4;
// Capsules thinner than this fraction of the mesh bounding radius are
// residual sticks — drop them rather than draw scratch shadows.
const MIN_RADIUS_FRACTION = 0.04;
// Shadow blobs read better slightly fat than slightly thin.
const RADIUS_INFLATE = 1.25;

const _v = new THREE.Vector3();
const _bind = new THREE.Matrix4();
const EDITOR_ONLY_MASK = (1 << EDITOR_LAYER) >>> 0;

/** Visible, non-editor skinned meshes under `root` (invisible subtrees pruned). */
export function collectSkinnedMeshes(root, out = []) {
  if (root.visible === false) return out;
  if (
    root.isSkinnedMesh &&
    !root.userData.engineOwned &&
    (root.layers.mask >>> 0) !== EDITOR_ONLY_MASK
  ) {
    out.push(root);
  }
  for (const child of root.children) collectSkinnedMeshes(child, out);
  return out;
}

/**
 * Fits capsules to a SkinnedMesh from its bind pose + skin weights.
 * Returns [{ bone, a: Vector3, b: Vector3, radius }] in BONE-LOCAL space,
 * largest volumes first.
 */
export function extractSkinnedCapsules(skinnedMesh, maxCapsules = MAX_CAPSULES_PER_MESH) {
  const geometry = skinnedMesh.geometry;
  const pos = geometry?.getAttribute?.("position");
  const skinIndex = geometry?.getAttribute?.("skinIndex");
  const skinWeight = geometry?.getAttribute?.("skinWeight");
  const skeleton = skinnedMesh.skeleton;
  if (!pos || !skinIndex || !skinWeight || !skeleton?.bones?.length) return [];

  // Map each bone to its regional ancestor (depth-capped within the rig).
  const boneIndexOf = new Map(skeleton.bones.map((bone, i) => [bone, i]));
  const depthOf = (bone) => {
    let depth = 0;
    let parent = bone.parent;
    while (parent && parent.isBone) {
      depth++;
      parent = parent.parent;
    }
    return depth;
  };
  const regionCache = new Map();
  const regionOf = (boneIndex) => {
    let cached = regionCache.get(boneIndex);
    if (cached !== undefined) return cached;
    let bone = skeleton.bones[boneIndex];
    while (bone.parent?.isBone && depthOf(bone) > BONE_DEPTH_CAP && boneIndexOf.has(bone.parent)) {
      bone = bone.parent;
    }
    cached = boneIndexOf.get(bone) ?? boneIndex;
    regionCache.set(boneIndex, cached);
    return cached;
  };

  // Per-region bounds of dominant vertices, in the REGION bone's bind space.
  const bounds = new Map(); // boneIndex → { min, max, count }
  for (let i = 0; i < pos.count; i++) {
    let bone = skinIndex.getX(i);
    let best = skinWeight.getX(i);
    if (skinWeight.getY(i) > best) { best = skinWeight.getY(i); bone = skinIndex.getY(i); }
    if (skinWeight.getZ(i) > best) { best = skinWeight.getZ(i); bone = skinIndex.getZ(i); }
    if (skinWeight.getW(i) > best) { best = skinWeight.getW(i); bone = skinIndex.getW(i); }
    if (!(best > 0.3) || !skeleton.bones[bone]) continue;
    bone = regionOf(bone);
    let entry = bounds.get(bone);
    if (!entry) {
      entry = {
        min: new THREE.Vector3(Infinity, Infinity, Infinity),
        max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
        count: 0,
      };
      bounds.set(bone, entry);
    }
    // bind-world = bindMatrix · position; bone-local = boneInverse · bind-world
    // (the exact chain three's skinning uses, so the fit is pose-independent).
    _bind.multiplyMatrices(skeleton.boneInverses[bone], skinnedMesh.bindMatrix);
    _v.fromBufferAttribute(pos, i).applyMatrix4(_bind);
    entry.min.min(_v);
    entry.max.max(_v);
    entry.count++;
  }

  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const meshRadius = geometry.boundingSphere?.radius || 1;

  const capsules = [];
  for (const [boneIndex, entry] of bounds) {
    if (entry.count < MIN_VERTS_PER_BONE) continue;
    const size = new THREE.Vector3().subVectors(entry.max, entry.min);
    const axes = [size.x, size.y, size.z];
    let longest = 0;
    if (axes[1] > axes[longest]) longest = 1;
    if (axes[2] > axes[longest]) longest = 2;
    const others = [0, 1, 2].filter((a) => a !== longest);
    const radius =
      Math.min(
        MAX_RADIUS,
        Math.max(MIN_RADIUS, 0.25 * (axes[others[0]] + axes[others[1]])),
      ) * RADIUS_INFLATE;
    // Residual stick: even a merged region can stay skinny (a lone antenna
    // chain) — scratch-line shadows look worse than no shadow.
    if (radius < meshRadius * MIN_RADIUS_FRACTION) continue;
    const center = new THREE.Vector3().addVectors(entry.min, entry.max).multiplyScalar(0.5);
    const half = Math.max(0, axes[longest] / 2 - radius);
    const axis = new THREE.Vector3();
    axis.setComponent(longest, 1);
    const a = center.clone().addScaledVector(axis, -half);
    const b = center.clone().addScaledVector(axis, half);
    capsules.push({
      bone: skeleton.bones[boneIndex],
      a,
      b,
      radius,
      volume: radius * radius * (2 * half + radius),
    });
  }
  capsules.sort((c1, c2) => c2.volume - c1.volume);
  return capsules.slice(0, maxCapsules);
}

/**
 * Runtime manager: extraction cache per skinned mesh + the per-frame world
 * capsule table (uniform array: [a.xyz|radius], [b.xyz|0] per capsule).
 */
export class CapsuleShadows {
  constructor() {
    this.values = Array.from({ length: MAX_CAPSULES * 2 }, () => new THREE.Vector4());
    this.node = uniformArray(this.values);
    this.countU = uniform(0, "uint");
    this._cache = new Map(); // mesh.uuid → capsules[]
    this.count = 0;
  }

  update(skinnedMeshes) {
    let written = 0;
    for (const mesh of skinnedMeshes) {
      if (written >= MAX_CAPSULES) break;
      let capsules = this._cache.get(mesh.uuid);
      if (!capsules) {
        capsules = extractSkinnedCapsules(mesh);
        this._cache.set(mesh.uuid, capsules);
      }
      for (const capsule of capsules) {
        if (written >= MAX_CAPSULES) break;
        const bone = capsule.bone;
        bone.updateWorldMatrix(true, false);
        const m = bone.matrixWorld;
        _v.copy(capsule.a).applyMatrix4(m);
        const e = m.elements;
        const scale = Math.hypot(e[0], e[1], e[2]); // uniform-ish bone scale
        this.values[written * 2].set(_v.x, _v.y, _v.z, capsule.radius * scale);
        _v.copy(capsule.b).applyMatrix4(m);
        this.values[written * 2 + 1].set(_v.x, _v.y, _v.z, 0);
        written++;
      }
    }
    this.count = written;
    this.countU.value = written;
  }
}
