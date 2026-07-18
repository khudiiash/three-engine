import * as THREE from "three/webgpu";
import { forEachVoxelizableMesh } from "./voxelizer.js";
import {
  getCoarsestClusterIndices,
  getVirtualGeometryRecord,
} from "../virtual-geometry/index.js";

export const RAY_PROXY_VERSION = 1;
export const RAY_PROXY_MIN_TRIANGLES = 500;
export const RAY_PROXY_MAX_TRIANGLES = 2000;
export const RAY_BVH_NODE_STRIDE = 8;
export const RAY_TRIANGLE_STRIDE = 12;
export const RAY_BVH_LEAF_SIZE = 4;
// 16 MiB, allocated only when the opt-in ray-proxy graph is enabled.
export const RAY_GPU_DATA_CAPACITY_VEC4 = 1 << 20;

const proxyCache = new Map(); // sourceHash + source kind -> Promise<BLAS>
const RAY_PROXY_CACHE_LIMIT = 24;
let meshoptPromise = null;

export function clearRayProxyCache() {
  proxyCache.clear();
}

async function getMeshoptSimplifier() {
  if (!meshoptPromise) {
    meshoptPromise = import("meshoptimizer").then(async ({ MeshoptSimplifier }) => {
      await MeshoptSimplifier.ready;
      return MeshoptSimplifier;
    });
  }
  return meshoptPromise;
}

function attrToFloat32(attribute) {
  if (
    attribute &&
    !attribute.isInterleavedBufferAttribute &&
    attribute.array instanceof Float32Array &&
    attribute.itemSize === 3
  ) {
    return attribute.array;
  }
  const out = new Float32Array((attribute?.count ?? 0) * 3);
  for (let i = 0; i < (attribute?.count ?? 0); i++) {
    out[i * 3] = attribute.getX(i);
    out[i * 3 + 1] = attribute.getY(i);
    out[i * 3 + 2] = attribute.getZ(i);
  }
  return out;
}

function geometryArrays(geometry) {
  const position = geometry?.getAttribute?.("position");
  if (!position) throw new Error("Ray proxy geometry has no position attribute");
  const positions = attrToFloat32(position);
  let indices;
  if (geometry.index) {
    indices =
      geometry.index.array instanceof Uint32Array
        ? geometry.index.array
        : new Uint32Array(geometry.index.array);
  } else {
    indices = new Uint32Array(position.count);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
  }
  return { positions, indices };
}

const _hashFloat = new Float32Array(1);
const _hashUint = new Uint32Array(_hashFloat.buffer);

/** Stable content fingerprint used to reject stale `.geom.meta` proxies. */
export function hashRayProxySource(positions, indices) {
  let hash = 2166136261;
  const mix = (value) => {
    hash = Math.imul(hash ^ (value >>> 0), 16777619) >>> 0;
  };
  mix(positions.length);
  mix(indices.length);
  for (let i = 0; i < positions.length; i++) {
    _hashFloat[0] = positions[i];
    mix(_hashUint[0]);
  }
  for (let i = 0; i < indices.length; i++) mix(indices[i]);
  return hash.toString(16).padStart(8, "0");
}

function targetTriangleCount(sourceTriangles, requested) {
  if (sourceTriangles <= RAY_PROXY_MAX_TRIANGLES) return sourceTriangles;
  if (Number.isFinite(requested)) {
    return Math.min(
      sourceTriangles,
      Math.max(RAY_PROXY_MIN_TRIANGLES, Math.round(requested)),
    );
  }
  return Math.min(
    sourceTriangles,
    Math.max(
      RAY_PROXY_MIN_TRIANGLES,
      Math.min(RAY_PROXY_MAX_TRIANGLES, Math.round(sourceTriangles * 0.1)),
    ),
  );
}

function weldPositionIndices(positions, indices, epsilon) {
  const vertexCount = positions.length / 3;
  const remap = new Uint32Array(vertexCount);
  const cellSize = Math.max(epsilon * 4, 1e-12);
  const epsilonSq = epsilon * epsilon;
  const buckets = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    const gz = Math.floor(z / cellSize);
    let canonical = -1;
    for (let dz = -1; dz <= 1 && canonical < 0; dz++) {
      for (let dy = -1; dy <= 1 && canonical < 0; dy++) {
        for (let dx = -1; dx <= 1 && canonical < 0; dx++) {
          const candidates = buckets.get(key(gx + dx, gy + dy, gz + dz));
          if (!candidates) continue;
          for (const candidate of candidates) {
            const px = positions[candidate * 3] - x;
            const py = positions[candidate * 3 + 1] - y;
            const pz = positions[candidate * 3 + 2] - z;
            if (px * px + py * py + pz * pz <= epsilonSq) {
              canonical = candidate;
              break;
            }
          }
        }
      }
    }
    if (canonical < 0) {
      canonical = vertex;
      const bucketKey = key(gx, gy, gz);
      const bucket = buckets.get(bucketKey);
      if (bucket) bucket.push(vertex);
      else buckets.set(bucketKey, [vertex]);
    }
    remap[vertex] = canonical;
  }

  const welded = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) welded[i] = remap[indices[i]];
  return welded;
}

/**
 * Builds the import-cache form stored at `.geom.meta.giRayProxy`.
 * `LockBorder` plus the normal topology-aware simplifier deliberately avoids
 * sloppy/prune modes: a slightly denser wall is preferable to a proxy hole.
 */
export async function buildRayProxyAsset(
  { positions, indices },
  { targetTriangles } = {},
) {
  positions =
    positions instanceof Float32Array ? positions : new Float32Array(positions);
  indices = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
  const sourceTriangles = Math.floor(indices.length / 3);
  const sourceHash = hashRayProxySource(positions, indices);
  const target = targetTriangleCount(sourceTriangles, targetTriangles);
  let proxyIndices = indices.slice(0, sourceTriangles * 3);
  let error = 0;
  let simplified = false;

  if (target < sourceTriangles) {
    const simplifier = await getMeshoptSimplifier();
    const scale = Math.max(simplifier.getScale(positions, 3), 1e-9);
    const welded = weldPositionIndices(positions, proxyIndices, scale * 1e-6);
    const [result, resultError] = simplifier.simplify(
      welded,
      positions,
      3,
      target * 3,
      1,
      ["LockBorder"],
    );
    if (result?.length >= 3 && result.length < proxyIndices.length) {
      proxyIndices = result;
      error = resultError;
      simplified = true;
    }
  }

  return {
    version: RAY_PROXY_VERSION,
    sourceHash,
    sourceTriangles,
    targetTriangles: target,
    triangles: Math.floor(proxyIndices.length / 3),
    error,
    simplified,
    indices: Array.from(proxyIndices),
  };
}

function cachedProxyIndices(cached, positions, indices) {
  if (cached?.version !== RAY_PROXY_VERSION) return null;
  if (cached.sourceHash !== hashRayProxySource(positions, indices)) return null;
  if (!Array.isArray(cached.indices) || cached.indices.length % 3 !== 0) return null;
  const vertexCount = positions.length / 3;
  if (
    cached.indices.some(
      (index) =>
        !Number.isInteger(index) || index < 0 || index >= vertexCount,
    )
  ) {
    return null;
  }
  return new Uint32Array(cached.indices);
}

function boundsForTriangle(positions, indices, triangle) {
  const i0 = indices[triangle * 3] * 3;
  const i1 = indices[triangle * 3 + 1] * 3;
  const i2 = indices[triangle * 3 + 2] * 3;
  const min = [
    Math.min(positions[i0], positions[i1], positions[i2]),
    Math.min(positions[i0 + 1], positions[i1 + 1], positions[i2 + 1]),
    Math.min(positions[i0 + 2], positions[i1 + 2], positions[i2 + 2]),
  ];
  const max = [
    Math.max(positions[i0], positions[i1], positions[i2]),
    Math.max(positions[i0 + 1], positions[i1 + 1], positions[i2 + 1]),
    Math.max(positions[i0 + 2], positions[i1 + 2], positions[i2 + 2]),
  ];
  return {
    id: triangle,
    min,
    max,
    center: [
      (min[0] + max[0]) * 0.5,
      (min[1] + max[1]) * 0.5,
      (min[2] + max[2]) * 0.5,
    ],
  };
}

function unionItems(items) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const item of items) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], item.min[axis]);
      max[axis] = Math.max(max[axis], item.max[axis]);
    }
  }
  return { min, max };
}

function buildTree(items, leafSize = RAY_BVH_LEAF_SIZE) {
  const { min, max } = unionItems(items);
  if (items.length <= leafSize) return { leaf: true, items, min, max };
  const cmin = [Infinity, Infinity, Infinity];
  const cmax = [-Infinity, -Infinity, -Infinity];
  for (const item of items) {
    for (let axis = 0; axis < 3; axis++) {
      cmin[axis] = Math.min(cmin[axis], item.center[axis]);
      cmax[axis] = Math.max(cmax[axis], item.center[axis]);
    }
  }
  let axis = 0;
  if (cmax[1] - cmin[1] > cmax[axis] - cmin[axis]) axis = 1;
  if (cmax[2] - cmin[2] > cmax[axis] - cmin[axis]) axis = 2;
  const sorted = [...items].sort((a, b) => a.center[axis] - b.center[axis]);
  const middle = Math.floor(sorted.length / 2);
  const left = buildTree(sorted.slice(0, middle), leafSize);
  const right = buildTree(sorted.slice(middle), leafSize);
  return { leaf: false, left, right, min, max };
}

function assignPreorder(node, state) {
  node.flatIndex = state.next++;
  if (!node.leaf) {
    assignPreorder(node.left, state);
    assignPreorder(node.right, state);
  }
}

function flattenTree(root, writeLeaf) {
  const state = { next: 0 };
  assignPreorder(root, state);
  const nodes = new Float32Array(state.next * RAY_BVH_NODE_STRIDE);
  const topology = new Array(state.next);
  const visit = (node, miss) => {
    const base = node.flatIndex * RAY_BVH_NODE_STRIDE;
    nodes[base] = node.min[0];
    nodes[base + 1] = node.min[1];
    nodes[base + 2] = node.min[2];
    nodes[base + 4] = node.max[0];
    nodes[base + 5] = node.max[1];
    nodes[base + 6] = node.max[2];
    nodes[base + 7] = miss;
    topology[node.flatIndex] = node;
    if (node.leaf) {
      const { start, count } = writeLeaf(node.items);
      nodes[base + 3] = -(start * RAY_BVH_LEAF_SIZE + count - 1) - 1;
      node.start = start;
      node.count = count;
      return;
    }
    nodes[base + 3] = 0;
    visit(node.left, node.right.flatIndex);
    visit(node.right, miss);
  };
  visit(root, -1);
  return { nodes, topology };
}

function nonDegenerateTriangles(positions, indices) {
  const result = [];
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const a = indices[triangle * 3] * 3;
    const b = indices[triangle * 3 + 1] * 3;
    const c = indices[triangle * 3 + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    if (nx * nx + ny * ny + nz * nz > 1e-20) {
      result.push(boundsForTriangle(positions, indices, triangle));
    }
  }
  return result;
}

/** Builds one mesh-local, threaded skip-link BLAS. */
export function buildRayProxyBLAS(
  positions,
  indices,
  { source = "meshopt", sourceHash = null } = {},
) {
  const items = nonDegenerateTriangles(positions, indices);
  if (!items.length) {
    return {
      nodes: new Float32Array([
        1e30,
        1e30,
        1e30,
        -1,
        -1e30,
        -1e30,
        -1e30,
        -1,
      ]),
      triangles: new Float32Array(0),
      proxyPositions: new Float32Array(0),
      proxyIndices: new Uint32Array(0),
      triangleCount: 0,
      nodeCount: 1,
      bounds: new Float32Array([1e30, 1e30, 1e30, -1e30, -1e30, -1e30]),
      source,
      sourceHash,
    };
  }

  const ordered = [];
  const root = buildTree(items);
  const flat = flattenTree(root, (leafItems) => {
    const start = ordered.length;
    ordered.push(...leafItems);
    return { start, count: leafItems.length };
  });
  const triangles = new Float32Array(ordered.length * RAY_TRIANGLE_STRIDE);
  const proxyPositions = new Float32Array(ordered.length * 9);
  const proxyIndices = new Uint32Array(ordered.length * 3);
  for (let triangle = 0; triangle < ordered.length; triangle++) {
    const sourceTriangle = ordered[triangle].id;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[sourceTriangle * 3 + corner];
      const src = vertex * 3;
      const packed = triangle * RAY_TRIANGLE_STRIDE + corner * 4;
      const debug = triangle * 9 + corner * 3;
      triangles[packed] = positions[src];
      triangles[packed + 1] = positions[src + 1];
      triangles[packed + 2] = positions[src + 2];
      proxyPositions[debug] = positions[src];
      proxyPositions[debug + 1] = positions[src + 1];
      proxyPositions[debug + 2] = positions[src + 2];
      proxyIndices[triangle * 3 + corner] = triangle * 3 + corner;
    }
  }
  return {
    nodes: flat.nodes,
    triangles,
    proxyPositions,
    proxyIndices,
    triangleCount: ordered.length,
    nodeCount: flat.nodes.length / RAY_BVH_NODE_STRIDE,
    bounds: new Float32Array([...root.min, ...root.max]),
    source,
    sourceHash,
  };
}

async function buildBLASForMesh(mesh) {
  const vgRecord = getVirtualGeometryRecord(mesh);
  const geometry = vgRecord?.original ?? mesh.geometry;
  const { positions, indices } = geometryArrays(geometry);
  const sourceHash = hashRayProxySource(positions, indices);
  let proxyIndices;
  let source;

  if (vgRecord?.dag) {
    proxyIndices = getCoarsestClusterIndices(vgRecord.dag);
    source = "virtual-geometry";
  } else {
    proxyIndices = cachedProxyIndices(
      geometry.userData?.giRayProxy,
      positions,
      indices,
    );
    if (proxyIndices) {
      source = "asset-cache";
    } else {
      const asset = await buildRayProxyAsset({ positions, indices });
      proxyIndices = new Uint32Array(asset.indices);
      source = asset.simplified ? "meshopt" : "full";
    }
  }

  const key = `${sourceHash}:${source}:${hashIndices(proxyIndices)}`;
  let cached = proxyCache.get(key);
  if (!cached) {
    cached = Promise.resolve(
      buildRayProxyBLAS(positions, proxyIndices, { source, sourceHash }),
    );
    cached.catch(() => proxyCache.delete(key));
    proxyCache.set(key, cached);
    // Imported/replaced geometry used to accumulate forever in this
    // module-global cache. Active ray scenes retain their BLAS references, so
    // evicting the oldest lookup entry is safe and bounds long editor sessions.
    while (proxyCache.size > RAY_PROXY_CACHE_LIMIT) {
      const oldest = proxyCache.keys().next().value;
      if (oldest === undefined) break;
      proxyCache.delete(oldest);
    }
  } else {
    // Refresh insertion order for simple LRU behaviour.
    proxyCache.delete(key);
    proxyCache.set(key, cached);
  }
  return cached;
}

function hashIndices(indices) {
  let hash = 2166136261;
  for (let i = 0; i < indices.length; i++) {
    hash = Math.imul(hash ^ indices[i], 16777619) >>> 0;
  }
  return hash.toString(16);
}

function matrixChanged(previous, matrix) {
  const elements = matrix.elements;
  if (!previous) return true;
  for (let i = 0; i < 16; i++) {
    if (previous[i] !== elements[i]) return true;
  }
  return false;
}

function copyMatrixElements(matrix) {
  return new Float32Array(matrix.elements);
}

function transformBounds(localBounds, matrix, out) {
  const minX = localBounds[0];
  const minY = localBounds[1];
  const minZ = localBounds[2];
  const maxX = localBounds[3];
  const maxY = localBounds[4];
  const maxZ = localBounds[5];
  if (minX > maxX || minY > maxY || minZ > maxZ) {
    out.min.set(1e30, 1e30, 1e30);
    out.max.set(-1e30, -1e30, -1e30);
    return;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const ex = (maxX - minX) * 0.5;
  const ey = (maxY - minY) * 0.5;
  const ez = (maxZ - minZ) * 0.5;
  const e = matrix.elements;
  const wcx = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
  const wcy = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
  const wcz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
  const wex = Math.abs(e[0]) * ex + Math.abs(e[4]) * ey + Math.abs(e[8]) * ez;
  const wey = Math.abs(e[1]) * ex + Math.abs(e[5]) * ey + Math.abs(e[9]) * ez;
  const wez = Math.abs(e[2]) * ex + Math.abs(e[6]) * ey + Math.abs(e[10]) * ez;
  out.min.set(wcx - wex, wcy - wey, wcz - wez);
  out.max.set(wcx + wex, wcy + wey, wcz + wez);
}

function visibleInRoot(mesh, root) {
  for (let object = mesh; object; object = object.parent) {
    if (object.visible === false) return false;
    if (object === root) return true;
  }
  return false;
}

function tlasItem(instance, id) {
  return {
    id,
    min: instance.bounds.min.toArray(),
    max: instance.bounds.max.toArray(),
    center: instance.bounds.getCenter(_center).toArray(),
  };
}

function decodeLeaf(code) {
  const decoded = -code - 1;
  return {
    start: Math.floor(decoded / RAY_BVH_LEAF_SIZE),
    count: (decoded % RAY_BVH_LEAF_SIZE) + 1,
  };
}

function aabbHit(nodes, base, origin, direction, maxDistance) {
  if (
    nodes[base] > nodes[base + 4] ||
    nodes[base + 1] > nodes[base + 5] ||
    nodes[base + 2] > nodes[base + 6]
  ) {
    return false;
  }
  let near = 0;
  let far = maxDistance;
  for (let axis = 0; axis < 3; axis++) {
    const d = Math.abs(direction[axis]) < 1e-12
      ? direction[axis] < 0
        ? -1e-12
        : 1e-12
      : direction[axis];
    const inv = 1 / d;
    const t0 = (nodes[base + axis] - origin[axis]) * inv;
    const t1 = (nodes[base + 4 + axis] - origin[axis]) * inv;
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
  }
  return near <= far;
}

function traceTriangles(blas, origin, direction, maxDistance) {
  let best = maxDistance;
  let bestTriangle = -1;
  let pointer = 0;
  let guard = 0;
  while (pointer >= 0 && guard++ < blas.nodeCount * 4 + 16) {
    const nodeBase = pointer * RAY_BVH_NODE_STRIDE;
    const miss = blas.nodes[nodeBase + 7];
    if (!aabbHit(blas.nodes, nodeBase, origin, direction, best)) {
      pointer = miss;
      continue;
    }
    const leafCode = blas.nodes[nodeBase + 3];
    if (leafCode >= 0) {
      pointer++;
      continue;
    }
    const { start, count } = decodeLeaf(leafCode);
    for (let i = 0; i < count; i++) {
      const triangle = start + i;
      const distance = intersectPackedTriangle(
        blas.triangles,
        triangle,
        origin,
        direction,
      );
      if (distance > 1e-4 && distance < best) {
        best = distance;
        bestTriangle = triangle;
      }
    }
    pointer = miss;
  }
  return { distance: best, triangle: bestTriangle };
}

function intersectPackedTriangle(triangles, triangle, origin, direction) {
  const base = triangle * RAY_TRIANGLE_STRIDE;
  const ax = triangles[base];
  const ay = triangles[base + 1];
  const az = triangles[base + 2];
  const e1x = triangles[base + 4] - ax;
  const e1y = triangles[base + 5] - ay;
  const e1z = triangles[base + 6] - az;
  const e2x = triangles[base + 8] - ax;
  const e2y = triangles[base + 9] - ay;
  const e2z = triangles[base + 10] - az;
  const px = direction[1] * e2z - direction[2] * e2y;
  const py = direction[2] * e2x - direction[0] * e2z;
  const pz = direction[0] * e2y - direction[1] * e2x;
  const determinant = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(determinant) < 1e-10) return Infinity;
  const inverse = 1 / determinant;
  const tx = origin[0] - ax;
  const ty = origin[1] - ay;
  const tz = origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inverse;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v =
    (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inverse;
  if (v < 0 || u + v > 1) return Infinity;
  return (e2x * qx + e2y * qy + e2z * qz) * inverse;
}

function transformRay(origin, direction, inverse, localOrigin, localDirection) {
  localOrigin.copy(origin).applyMatrix4(inverse);
  const e = inverse.elements;
  localDirection.set(
    e[0] * direction.x + e[4] * direction.y + e[8] * direction.z,
    e[1] * direction.x + e[5] * direction.y + e[9] * direction.z,
    e[2] * direction.x + e[6] * direction.y + e[10] * direction.z,
  );
}

/**
 * CPU-side Stage-1 ray scene. BLAS data is immutable and shared by geometry;
 * TLAS topology is rebuilt only when the instance set changes, then refitted
 * from current world matrices for rigid movers.
 */
export class TriangleRayScene {
  constructor() {
    this.root = null;
    this.instances = [];
    this.tlasNodes = new Float32Array(0);
    this.tlasInstances = new Uint32Array(0);
    this.tlasTopology = [];
    this.stats = {
      instances: 0,
      uniqueBlas: 0,
      triangles: 0,
      nodes: 0,
      buildMs: 0,
      refitMs: 0,
      sources: {},
    };
    this.version = 0;
    this.topologyVersion = 0;
    this.transformVersion = 0;
    this._buildGeneration = 0;
    this._packed = null;
  }

  async rebuild(root, { signal } = {}) {
    const generation = ++this._buildGeneration;
    const started = performance.now();
    const meshes = [];
    forEachVoxelizableMesh(root, (mesh) => meshes.push(mesh));
    const instances = [];
    for (const mesh of meshes) {
      if (signal?.cancelled || generation !== this._buildGeneration) {
        return { cancelled: true };
      }
      const blas = await buildBLASForMesh(mesh);
      mesh.updateWorldMatrix(true, false);
      const instance = {
        mesh,
        blas,
        matrix: copyMatrixElements(mesh.matrixWorld),
        inverse: mesh.matrixWorld.clone().invert(),
        normalMatrix: new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),
        bounds: new THREE.Box3(),
        active: true,
      };
      transformBounds(blas.bounds, mesh.matrixWorld, instance.bounds);
      instances.push(instance);
      // Yield after every mesh: an uncached BLAS build (hash + meshopt
      // simplify + BVH) can take tens of milliseconds for a dense model, so
      // batching eight of them between yields froze the editor during scene
      // load and on hierarchy changes.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (signal?.cancelled || generation !== this._buildGeneration) {
      return { cancelled: true };
    }

    this.root = root;
    this.instances = instances;
    this.#buildTLAS();
    this.version++;
    this.topologyVersion++;
    this.transformVersion++;
    this._packed = null;
    const unique = new Set(instances.map((instance) => instance.blas));
    const sources = {};
    for (const blas of unique) sources[blas.source] = (sources[blas.source] ?? 0) + 1;
    this.stats = {
      instances: instances.length,
      uniqueBlas: unique.size,
      triangles: [...unique].reduce((sum, blas) => sum + blas.triangleCount, 0),
      nodes:
        this.tlasNodes.length / RAY_BVH_NODE_STRIDE +
        [...unique].reduce((sum, blas) => sum + blas.nodeCount, 0),
      buildMs: performance.now() - started,
      refitMs: 0,
      sources,
    };
    return { cancelled: false, ...this.stats };
  }

  cancelBuild() {
    this._buildGeneration++;
  }

  #buildTLAS() {
    if (!this.instances.length) {
      this.tlasNodes = new Float32Array([
        1e30,
        1e30,
        1e30,
        -1,
        -1e30,
        -1e30,
        -1e30,
        -1,
      ]);
      this.tlasInstances = new Uint32Array(0);
      this.tlasTopology = [];
      return;
    }
    const items = this.instances.map(tlasItem);
    const ordered = [];
    const root = buildTree(items);
    const flat = flattenTree(root, (leafItems) => {
      const start = ordered.length;
      for (const item of leafItems) ordered.push(item.id);
      return { start, count: leafItems.length };
    });
    this.tlasNodes = flat.nodes;
    this.tlasInstances = new Uint32Array(ordered);
    this.tlasTopology = flat.topology;
  }

  /** Refit rigid instance transforms without rebuilding BLAS/TLAS topology. */
  refit() {
    if (!this.instances.length) return false;
    const started = performance.now();
    let changed = false;
    for (const instance of this.instances) {
      const mesh = instance.mesh;
      mesh.updateWorldMatrix(true, false);
      const active = visibleInRoot(mesh, this.root);
      if (active !== instance.active || matrixChanged(instance.matrix, mesh.matrixWorld)) {
        instance.active = active;
        instance.matrix.set(mesh.matrixWorld.elements);
        instance.inverse.copy(mesh.matrixWorld).invert();
        instance.normalMatrix.getNormalMatrix(mesh.matrixWorld);
        if (active) transformBounds(instance.blas.bounds, mesh.matrixWorld, instance.bounds);
        else {
          instance.bounds.min.set(1e30, 1e30, 1e30);
          instance.bounds.max.set(-1e30, -1e30, -1e30);
        }
        changed = true;
      }
    }
    if (!changed) return false;

    for (const node of this.tlasTopology) {
      if (!node?.leaf) continue;
      const min = node.min;
      const max = node.max;
      min[0] = Infinity;
      min[1] = Infinity;
      min[2] = Infinity;
      max[0] = -Infinity;
      max[1] = -Infinity;
      max[2] = -Infinity;
      for (let i = 0; i < node.count; i++) {
        const instance = this.instances[this.tlasInstances[node.start + i]];
        min[0] = Math.min(min[0], instance.bounds.min.x);
        min[1] = Math.min(min[1], instance.bounds.min.y);
        min[2] = Math.min(min[2], instance.bounds.min.z);
        max[0] = Math.max(max[0], instance.bounds.max.x);
        max[1] = Math.max(max[1], instance.bounds.max.y);
        max[2] = Math.max(max[2], instance.bounds.max.z);
      }
      this.#writeTLASBounds(node);
    }
    for (let i = this.tlasTopology.length - 1; i >= 0; i--) {
      const node = this.tlasTopology[i];
      if (!node || node.leaf) continue;
      node.min[0] = Math.min(node.left.min[0], node.right.min[0]);
      node.min[1] = Math.min(node.left.min[1], node.right.min[1]);
      node.min[2] = Math.min(node.left.min[2], node.right.min[2]);
      node.max[0] = Math.max(node.left.max[0], node.right.max[0]);
      node.max[1] = Math.max(node.left.max[1], node.right.max[1]);
      node.max[2] = Math.max(node.left.max[2], node.right.max[2]);
      this.#writeTLASBounds(node);
    }
    this.version++;
    this.transformVersion++;
    this.#updatePackedDynamic();
    this.stats.refitMs = performance.now() - started;
    return true;
  }

  #updatePackedDynamic() {
    const packed = this._packed;
    if (!packed) return;
    packed.data.set(this.tlasNodes, packed.layout.tlasNodes.offset * 4);
    for (let i = 0; i < this.instances.length; i++) {
      const instance = this.instances[i];
      const base =
        (packed.layout.instances.offset +
          i * packed.layout.instances.stride) *
        4;
      packed.data.set(instance.inverse.elements, base);
      const meta = packed.instanceMeta[i];
      packed.data[base + 16] = meta.nodeOffset;
      packed.data[base + 17] = meta.triangleOffset;
      packed.data[base + 18] = meta.nodeCount;
      packed.data[base + 19] = instance.active ? meta.triangleCount : 0;
    }
    packed.version = this.version;
    packed.transformVersion = this.transformVersion;
  }

  #writeTLASBounds(node) {
    const base = node.flatIndex * RAY_BVH_NODE_STRIDE;
    this.tlasNodes[base] = node.min[0];
    this.tlasNodes[base + 1] = node.min[1];
    this.tlasNodes[base + 2] = node.min[2];
    this.tlasNodes[base + 4] = node.max[0];
    this.tlasNodes[base + 5] = node.max[1];
    this.tlasNodes[base + 6] = node.max[2];
  }

  traceRay(origin, direction, maxDistance = 1e30) {
    if (!this.instances.length) return null;
    _rayDirection.copy(direction).normalize();
    const worldOrigin = [origin.x, origin.y, origin.z];
    const worldDirection = [_rayDirection.x, _rayDirection.y, _rayDirection.z];
    let best = maxDistance;
    let bestInstance = -1;
    let bestTriangle = -1;
    let pointer = 0;
    let guard = 0;
    const tlasNodeCount = this.tlasNodes.length / RAY_BVH_NODE_STRIDE;
    while (pointer >= 0 && guard++ < tlasNodeCount * 4 + 16) {
      const base = pointer * RAY_BVH_NODE_STRIDE;
      const miss = this.tlasNodes[base + 7];
      if (!aabbHit(this.tlasNodes, base, worldOrigin, worldDirection, best)) {
        pointer = miss;
        continue;
      }
      const leafCode = this.tlasNodes[base + 3];
      if (leafCode >= 0) {
        pointer++;
        continue;
      }
      const { start, count } = decodeLeaf(leafCode);
      for (let i = 0; i < count; i++) {
        const instanceIndex = this.tlasInstances[start + i];
        const instance = this.instances[instanceIndex];
        if (!instance.active) continue;
        transformRay(
          origin,
          _rayDirection,
          instance.inverse,
          _localOrigin,
          _localDirection,
        );
        const hit = traceTriangles(
          instance.blas,
          [_localOrigin.x, _localOrigin.y, _localOrigin.z],
          [_localDirection.x, _localDirection.y, _localDirection.z],
          best,
        );
        if (hit.triangle >= 0 && hit.distance < best) {
          best = hit.distance;
          bestInstance = instanceIndex;
          bestTriangle = hit.triangle;
        }
      }
      pointer = miss;
    }
    if (bestInstance < 0) return null;
    return this.#makeHit(bestInstance, bestTriangle, best, origin, _rayDirection);
  }

  /** Brute-force reference used only by the focused Stage-1 node check. */
  traceRayBruteForce(origin, direction, maxDistance = 1e30) {
    _rayDirection.copy(direction).normalize();
    let best = maxDistance;
    let bestInstance = -1;
    let bestTriangle = -1;
    for (let instanceIndex = 0; instanceIndex < this.instances.length; instanceIndex++) {
      const instance = this.instances[instanceIndex];
      if (!instance.active) continue;
      transformRay(
        origin,
        _rayDirection,
        instance.inverse,
        _localOrigin,
        _localDirection,
      );
      const blas = instance.blas;
      for (let triangle = 0; triangle < blas.triangleCount; triangle++) {
        const distance = intersectPackedTriangle(
          blas.triangles,
          triangle,
          [_localOrigin.x, _localOrigin.y, _localOrigin.z],
          [_localDirection.x, _localDirection.y, _localDirection.z],
        );
        if (distance > 1e-4 && distance < best) {
          best = distance;
          bestInstance = instanceIndex;
          bestTriangle = triangle;
        }
      }
    }
    if (bestInstance < 0) return null;
    return this.#makeHit(bestInstance, bestTriangle, best, origin, _rayDirection);
  }

  #makeHit(instanceIndex, triangle, distance, origin, direction) {
    const instance = this.instances[instanceIndex];
    const base = triangle * RAY_TRIANGLE_STRIDE;
    _edgeA.set(
      instance.blas.triangles[base + 4] - instance.blas.triangles[base],
      instance.blas.triangles[base + 5] - instance.blas.triangles[base + 1],
      instance.blas.triangles[base + 6] - instance.blas.triangles[base + 2],
    );
    _edgeB.set(
      instance.blas.triangles[base + 8] - instance.blas.triangles[base],
      instance.blas.triangles[base + 9] - instance.blas.triangles[base + 1],
      instance.blas.triangles[base + 10] - instance.blas.triangles[base + 2],
    );
    const normal = _hitNormal
      .crossVectors(_edgeA, _edgeB)
      .normalize()
      .applyNormalMatrix(instance.normalMatrix)
      .normalize()
      .clone();
    return {
      distance,
      instanceIndex,
      triangle,
      mesh: instance.mesh,
      position: origin.clone().addScaledVector(direction, distance),
      normal,
    };
  }

  /**
   * Packs TLAS, BLASes, triangles and inverse instance transforms into one
   * vec4-addressed Float32Array. Stage 2 can consume one storage buffer rather
   * than breaking the portable eight-storage-buffer compute limit.
   */
  packGPUData() {
    if (this._packed?.version === this.version) return this._packed;
    const uniqueBlas = [];
    const blasIndex = new Map();
    for (const instance of this.instances) {
      if (!blasIndex.has(instance.blas)) {
        blasIndex.set(instance.blas, uniqueBlas.length);
        uniqueBlas.push(instance.blas);
      }
    }
    const tlasNodeVec4s = (this.tlasNodes.length / RAY_BVH_NODE_STRIDE) * 2;
    const tlasInstanceVec4s = this.tlasInstances.length;
    const blasNodeVec4s = uniqueBlas.reduce((sum, blas) => sum + blas.nodeCount * 2, 0);
    const triangleVec4s = uniqueBlas.reduce((sum, blas) => sum + blas.triangleCount * 3, 0);
    const instanceStride = 5;
    const instanceVec4s = this.instances.length * instanceStride;
    const layout = {
      tlasNodes: { offset: 0, count: tlasNodeVec4s },
      tlasInstances: { offset: tlasNodeVec4s, count: tlasInstanceVec4s },
      blasNodes: {
        offset: tlasNodeVec4s + tlasInstanceVec4s,
        count: blasNodeVec4s,
      },
      triangles: {
        offset: tlasNodeVec4s + tlasInstanceVec4s + blasNodeVec4s,
        count: triangleVec4s,
      },
      instances: {
        offset:
          tlasNodeVec4s +
          tlasInstanceVec4s +
          blasNodeVec4s +
          triangleVec4s,
        count: instanceVec4s,
        stride: instanceStride,
      },
    };
    layout.totalVec4s = layout.instances.offset + layout.instances.count;
    const data = new Float32Array(layout.totalVec4s * 4);
    data.set(this.tlasNodes, layout.tlasNodes.offset * 4);
    for (let i = 0; i < this.tlasInstances.length; i++) {
      data[(layout.tlasInstances.offset + i) * 4] = this.tlasInstances[i];
    }

    const blasMeta = [];
    let nodeOffset = layout.blasNodes.offset;
    let triangleOffset = layout.triangles.offset;
    for (const blas of uniqueBlas) {
      data.set(blas.nodes, nodeOffset * 4);
      data.set(blas.triangles, triangleOffset * 4);
      blasMeta.push({
        nodeOffset,
        triangleOffset,
        nodeCount: blas.nodeCount,
        triangleCount: blas.triangleCount,
      });
      nodeOffset += blas.nodeCount * 2;
      triangleOffset += blas.triangleCount * 3;
    }
    const instanceMeta = new Array(this.instances.length);
    for (let i = 0; i < this.instances.length; i++) {
      const instance = this.instances[i];
      const base = (layout.instances.offset + i * instanceStride) * 4;
      data.set(instance.inverse.elements, base);
      const meta = blasMeta[blasIndex.get(instance.blas)];
      instanceMeta[i] = meta;
      data.set(
        [
          meta.nodeOffset,
          meta.triangleOffset,
          meta.nodeCount,
          instance.active ? meta.triangleCount : 0,
        ],
        base + 16,
      );
    }
    this._packed = {
      version: this.version,
      topologyVersion: this.topologyVersion,
      transformVersion: this.transformVersion,
      data,
      layout,
      instanceMeta,
    };
    return this._packed;
  }

  createDebugObject() {
    const group = new THREE.Group();
    group.name = "GI Ray Proxies";
    group.userData.giDebug = true;
    group.userData.engineOwned = true;
    const material = new THREE.MeshBasicMaterial({
      color: 0x42d9ff,
      wireframe: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    group.userData.rayProxyMaterial = material;
    for (const instance of this.instances) {
      if (!instance.blas.triangleCount) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(instance.blas.proxyPositions, 3),
      );
      const debug = new THREE.Mesh(geometry, material);
      debug.frustumCulled = false;
      debug.matrixAutoUpdate = false;
      debug.matrix.copy(instance.mesh.matrixWorld);
      debug.userData.giDebug = true;
      debug.userData.rayProxyInstance = instance;
      group.add(debug);
    }
    return group;
  }

  updateDebugObject(group) {
    for (const child of group?.children ?? []) {
      const instance = child.userData.rayProxyInstance;
      if (!instance) continue;
      child.visible = instance.active;
      child.matrix.copy(instance.mesh.matrixWorld);
      child.matrixWorldNeedsUpdate = true;
    }
  }
}

const _center = new THREE.Vector3();
const _rayDirection = new THREE.Vector3();
const _localOrigin = new THREE.Vector3();
const _localDirection = new THREE.Vector3();
const _edgeA = new THREE.Vector3();
const _edgeB = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
