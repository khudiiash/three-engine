import * as THREE from "three/webgpu";
import { MeshoptSimplifier } from "meshoptimizer/simplifier";
import { EDITOR_LAYER } from "../../engine/editorLayers.js";

export const collisionSimplifierReady = MeshoptSimplifier.ready;

/**
 * Collects rendered triangles in `root`'s local frame.
 *
 * Authored Collider components deliberately aggregate the whole subtree, as
 * they always have. Automatic colliders pass `ownerEntityId`, which keeps a
 * parent and its child mesh entities from both cooking the same triangles.
 * Root scale is optional so background cooks remain valid when an entity is
 * scaled after the cook; Rapier shapes receive the live scale at Play time.
 */
export function collectCollisionMesh(root, {
  ownerEntityId = null,
  bakeRootScale = true,
  includeSkinned = true,
} = {}) {
  const meshes = collectSourceMeshes(root, { ownerEntityId, bakeRootScale, includeSkinned });
  return mergeCollisionMeshes(meshes);
}

export function mergeCollisionMeshes(meshes) {
  if (!meshes.length) return null;
  const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.vertices.length, 0);
  const indexCount = meshes.reduce((sum, mesh) => sum + mesh.indices.length, 0);
  const vertices = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    vertices.set(mesh.vertices, vertexOffset * 3);
    for (let i = 0; i < mesh.indices.length; i++) indices[indexOffset + i] = mesh.indices[i] + vertexOffset;
    vertexOffset += mesh.vertices.length / 3;
    indexOffset += mesh.indices.length;
  }
  return { vertices, indices };
}

/**
 * Reduces a triangle island while retaining its concave surface and open
 * borders. Mesh colliders bypass this entirely; this is the lower-cost
 * geometry used only by the Concave shape.
 */
export function simplifyCollisionMesh(mesh, {
  ratio = 0.25,
  maxTriangles = 2000,
  minTriangles = 96,
  error = 0.01,
} = {}) {
  if (!mesh || !MeshoptSimplifier.supported) return mesh;
  const welded = weldCollisionMesh(mesh);
  const triangleCount = welded.indices.length / 3;
  if (triangleCount <= minTriangles) return welded;
  const targetTriangles = Math.max(
    minTriangles,
    Math.min(maxTriangles, Math.floor(triangleCount * ratio)),
  );
  if (targetTriangles >= triangleCount) return welded;
  try {
    const [indices] = MeshoptSimplifier.simplify(
      welded.indices,
      welded.vertices,
      3,
      targetTriangles * 3,
      error,
      ["LockBorder"],
    );
    if (!indices?.length || indices.length >= welded.indices.length) return welded;
    return compactCollisionMesh(welded.vertices, indices);
  } catch (error) {
    console.warn(`Concave collider simplification failed; using the exact mesh: ${error?.message ?? error}`);
    return welded;
  }
}

/** Welds position-only seams on a private copy before simplification. Render
 * geometry is often split at UV/normal seams; leaving those duplicate points
 * makes every face look border-locked to the simplifier. */
function weldCollisionMesh(mesh) {
  const positionRemap = MeshoptSimplifier.generatePositionRemap(mesh.vertices, 3);
  const indices = [];
  const triangles = new Set();

  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = positionRemap[mesh.indices[i]];
    const b = positionRemap[mesh.indices[i + 1]];
    const c = positionRemap[mesh.indices[i + 2]];
    if (a == null || b == null || c == null || a === b || b === c || c === a) continue;

    const key = [a, b, c].sort((left, right) => left - right).join(":");
    if (triangles.has(key)) continue;
    triangles.add(key);
    indices.push(a, b, c);
  }

  if (!indices.length) return mesh;
  return compactCollisionMesh(mesh.vertices, new Uint32Array(indices));
}

function compactCollisionMesh(sourceVertices, sourceIndices) {
  const remap = new Map();
  const vertices = [];
  const indices = new Uint32Array(sourceIndices.length);
  for (let i = 0; i < sourceIndices.length; i++) {
    const oldIndex = sourceIndices[i];
    let nextIndex = remap.get(oldIndex);
    if (nextIndex == null) {
      nextIndex = remap.size;
      remap.set(oldIndex, nextIndex);
      const p = oldIndex * 3;
      vertices.push(sourceVertices[p], sourceVertices[p + 1], sourceVertices[p + 2]);
    }
    indices[i] = nextIndex;
  }
  return { vertices: new Float32Array(vertices), indices };
}

/**
 * Returns one mesh per disconnected rendered island. Object3D mesh boundaries
 * are always preserved; islands inside one BufferGeometry are found by triangle
 * connectivity after welding duplicate corner positions (box faces commonly
 * duplicate their vertices, so index connectivity alone is insufficient).
 */
export function collectCollisionMeshParts(root, options = {}) {
  return collectSourceMeshes(root, options).flatMap(splitCollisionMesh);
}

/** A bind-pose hull is not valid collision for geometry whose positions can
 * change independently of its entity transform. */
export function isDeformingCollisionMesh(object) {
  return !!(object?.isSkinnedMesh
    || object?.morphTargetInfluences?.length
    || object?.geometry?.morphAttributes?.position?.length);
}

/** True when this entity owns any render mesh that needs skeletal/morph
 * deformation. Other entities' descendants and editor/runtime proxies do not
 * affect whether the entity receives its visible default Collider. */
export function hasOwnedDeformingCollisionGeometry(root, ownerEntityId) {
  let found = false;
  root?.traverse?.((child) => {
    if (found || !child.isMesh || child.userData?.entityId !== ownerEntityId) return;
    if (child.userData.engineOwned || child.isInstancedMesh || child.isBatchedMesh) return;
    if (child.layers.mask === 1 << EDITOR_LAYER) return;
    if (isDeformingCollisionMesh(child)) found = true;
  });
  return found;
}

/** Rigid geometry beside a skin remains useful automatic collision. This is
 * intentionally separate from the deforming predicate so a mixed GLB keeps a
 * hull for its ordinary submeshes while its skin is omitted. */
export function hasOwnedStaticCollisionGeometry(root, ownerEntityId) {
  let found = false;
  root?.traverse?.((child) => {
    if (found || !child.isMesh || !child.geometry?.attributes?.position
      || child.userData?.entityId !== ownerEntityId) return;
    if (child.userData.engineOwned || child.isInstancedMesh || child.isBatchedMesh) return;
    if (child.layers.mask === 1 << EDITOR_LAYER || isDeformingCollisionMesh(child)) return;
    found = true;
  });
  return found;
}

function collectSourceMeshes(root, {
  ownerEntityId = null,
  bakeRootScale = true,
  includeSkinned = true,
} = {}) {
  const meshes = [];
  root.updateWorldMatrix(true, false);
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rootScale = new THREE.Vector3(1, 1, 1);
  if (bakeRootScale) root.getWorldScale(rootScale);
  const local = new THREE.Matrix4();
  const v = new THREE.Vector3();

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry?.attributes?.position) return;
    if (child.userData.vfxSimulation) return;
    if (child.layers.mask === 1 << EDITOR_LAYER) return;
    // This must apply even when ownerEntityId is null: an ancestor/implicit
    // automatic cook must never absorb a skinned descendant's bind pose.
    if (!includeSkinned && isDeformingCollisionMesh(child)) return;
    if (ownerEntityId != null) {
      if (child.userData.entityId !== ownerEntityId) return;
      if (child.userData.engineOwned || child.isInstancedMesh || child.isBatchedMesh) return;
    }
    child.updateWorldMatrix(true, false);
    local.copy(invRoot).multiply(child.matrixWorld);
    const pos = child.geometry.attributes.position;
    const verts = new Float32Array(pos.count * 3);
    let valid = true;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(local).multiply(rootScale);
      if (![v.x, v.y, v.z].every(Number.isFinite)) {
        valid = false;
        return;
      }
      verts[i * 3] = v.x;
      verts[i * 3 + 1] = v.y;
      verts[i * 3 + 2] = v.z;
    }
    if (!valid) return;
    const index = child.geometry.index;
    const childIndices = new Uint32Array(index?.count ?? pos.count);
    if (index) {
      for (let i = 0; i < index.count; i++) childIndices[i] = index.getX(i);
    } else {
      for (let i = 0; i < pos.count; i++) childIndices[i] = i;
    }
    if (childIndices.length >= 3) meshes.push({ vertices: verts, indices: childIndices });
  });

  return meshes;
}

function splitCollisionMesh(mesh) {
  const vertexTotal = mesh.vertices.length / 3;
  if (vertexTotal < 3 || mesh.indices.length < 3) return [];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const x = mesh.vertices[i], y = mesh.vertices[i + 1], z = mesh.vertices[i + 2];
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const weld = Math.max(diagonal * 1e-7, 1e-7);
  const canonical = new Uint32Array(vertexTotal);
  const keys = new Map();
  let canonicalCount = 0;
  for (let i = 0; i < vertexTotal; i++) {
    const p = i * 3;
    const key = `${Math.round(mesh.vertices[p] / weld)},${Math.round(mesh.vertices[p + 1] / weld)},${Math.round(mesh.vertices[p + 2] / weld)}`;
    let id = keys.get(key);
    if (id == null) {
      id = canonicalCount++;
      keys.set(key, id);
    }
    canonical[i] = id;
  }

  const parent = new Uint32Array(canonicalCount);
  const rank = new Uint8Array(canonicalCount);
  for (let i = 0; i < canonicalCount; i++) parent[i] = i;
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a, b) => {
    let ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
  };
  const triangles = [];
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const ia = mesh.indices[i], ib = mesh.indices[i + 1], ic = mesh.indices[i + 2];
    if (ia >= vertexTotal || ib >= vertexTotal || ic >= vertexTotal) continue;
    const a = canonical[ia], b = canonical[ib], c = canonical[ic];
    if (a === b || b === c || c === a) continue;
    const ap = ia * 3, bp = ib * 3, cp = ic * 3;
    const abx = mesh.vertices[bp] - mesh.vertices[ap];
    const aby = mesh.vertices[bp + 1] - mesh.vertices[ap + 1];
    const abz = mesh.vertices[bp + 2] - mesh.vertices[ap + 2];
    const acx = mesh.vertices[cp] - mesh.vertices[ap];
    const acy = mesh.vertices[cp + 1] - mesh.vertices[ap + 1];
    const acz = mesh.vertices[cp + 2] - mesh.vertices[ap + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    if (nx * nx + ny * ny + nz * nz <= weld * weld * weld * weld) continue;
    triangles.push(ia, ib, ic);
    union(a, b);
    union(b, c);
  }

  const trianglesByPart = new Map();
  for (let i = 0; i < triangles.length; i += 3) {
    const root = find(canonical[triangles[i]]);
    let partTriangles = trianglesByPart.get(root);
    if (!partTriangles) trianglesByPart.set(root, partTriangles = []);
    partTriangles.push(triangles[i], triangles[i + 1], triangles[i + 2]);
  }

  const parts = [];
  for (const triangles of trianglesByPart.values()) {
    const remap = new Map();
    const vertices = [];
    const indices = new Uint32Array(triangles.length);
    for (let i = 0; i < triangles.length; i++) {
      const oldIndex = triangles[i];
      let nextIndex = remap.get(oldIndex);
      if (nextIndex == null) {
        nextIndex = remap.size;
        remap.set(oldIndex, nextIndex);
        const p = oldIndex * 3;
        vertices.push(mesh.vertices[p], mesh.vertices[p + 1], mesh.vertices[p + 2]);
      }
      indices[i] = nextIndex;
    }
    if (vertices.length >= 9) parts.push({ vertices: new Float32Array(vertices), indices });
  }
  return parts;
}

/** Returns a collision mesh scaled for Rapier without mutating cached data. */
export function scaleCollisionMesh(mesh, scale) {
  if (!mesh) return null;
  const vertices = new Float32Array(mesh.vertices.length);
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    vertices[i] = mesh.vertices[i] * scale.x;
    vertices[i + 1] = mesh.vertices[i + 1] * scale.y;
    vertices[i + 2] = mesh.vertices[i + 2] * scale.z;
  }
  let indices = mesh.indices;
  if (scale.x * scale.y * scale.z < 0) {
    indices = new Uint32Array(mesh.indices);
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const b = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = b;
    }
  }
  return { vertices, indices };
}

/**
 * Centre of the rendered geometry in an entity's local frame. Used only by
 * primitive colliders: mesh/convex shapes already carry vertex offsets and
 * applying this to them would shift the collider twice.
 */
export function collisionGeometryBounds(root, { ownerEntityId = null } = {}) {
  root.updateWorldMatrix(true, false);
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const bounds = new THREE.Box3();
  const childBounds = new THREE.Box3();
  let found = false;

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry?.attributes?.position) return;
    if (child.layers.mask === 1 << EDITOR_LAYER || child.userData.engineOwned || child.userData.vfxSimulation) return;
    if (ownerEntityId != null && child.userData.entityId !== ownerEntityId) return;
    child.geometry.computeBoundingBox();
    if (!child.geometry.boundingBox || child.geometry.boundingBox.isEmpty()) return;
    child.updateWorldMatrix(true, false);
    local.copy(invRoot).multiply(child.matrixWorld);
    childBounds.copy(child.geometry.boundingBox).applyMatrix4(local);
    bounds.union(childBounds);
    found = true;
  });

  return found ? bounds : null;
}

export function collisionGeometryCenter(root) {
  return collisionGeometryBounds(root)?.getCenter(new THREE.Vector3()) ?? null;
}
