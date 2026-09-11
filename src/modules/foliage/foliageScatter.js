import * as THREE from "three/webgpu";
import { foliageRandom } from "./foliageGeometry.js";

export const MAX_FOLIAGE_INSTANCES = 100000;
export const MAX_FOLIAGE_TRIANGLES = 1000000;
const UP = new THREE.Vector3(0, 1, 0);
const finite = (n, fallback) => n != null && Number.isFinite(Number(n)) ? Number(n) : fallback;

/**
 * Snapshot triangle positions and normals in WORLD space, including nested and
 * instanced meshes. World-space area makes density correct under nonuniform scale.
 * Mirrored transforms retain outward normals via the normal matrix, rather than
 * turning an upward-facing ground mesh into a downward-facing one.
 */
export function collectSurfaceTriangles(rootOrRoots, options = {}) {
  const roots = Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots];
  const positions = [], normals = [], areas = [];
  const bounds = new THREE.Box3();
  const triangleBudget = Math.min(MAX_FOLIAGE_TRIANGLES, Math.max(1, finite(options.maxTriangles, MAX_FOLIAGE_TRIANGLES)));
  const visited = new Set();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3(), normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3(), world = new THREE.Matrix4(), instance = new THREE.Matrix4();
  let totalArea = 0, skippedDegenerate = 0, meshes = 0, topologyHash = 2166136261;
  const topologyParts = [];
  function append(mesh, matrix) {
    const geometry = mesh.geometry, attr = geometry?.getAttribute("position");
    if (!attr || attr.itemSize < 3) return;
    normalMatrix.getNormalMatrix(matrix);
    const index = geometry.index, count = index?.count ?? attr.count;
    const start = Math.max(0, Math.ceil(finite(geometry.drawRange?.start, 0) / 3) * 3);
    const end = Math.min(count, start + finite(geometry.drawRange?.count, count));
    meshes++;
    topologyParts.push(`${mesh.uuid}:${geometry.uuid}:${index?.version ?? 0}:${count}:${start}:${end}`);
    if (mesh.isSkinnedMesh) mesh.skeleton?.update();
    for (let i = start; i + 2 < end; i += 3) {
      const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
      if (mesh.getVertexPosition) { mesh.getVertexPosition(ia, a); mesh.getVertexPosition(ib, b); mesh.getVertexPosition(ic, c); }
      else { a.fromBufferAttribute(attr, ia); b.fromBufferAttribute(attr, ib); c.fromBufferAttribute(attr, ic); }
      normal.crossVectors(edge1.copy(b).sub(a), edge2.copy(c).sub(a)).applyMatrix3(normalMatrix).normalize();
      a.applyMatrix4(matrix); b.applyMatrix4(matrix); c.applyMatrix4(matrix);
      const area = edge1.copy(b).sub(a).cross(edge2.copy(c).sub(a)).length() * 0.5;
      if (!Number.isFinite(area) || area < 1e-12 || normal.lengthSq() < 0.5) { skippedDegenerate++; continue; }
      if (areas.length >= triangleBudget) throw new RangeError(`Foliage surface exceeds ${triangleBudget.toLocaleString("en-US")} triangles. Use a simpler scatter surface or select a smaller mesh.`);
      topologyHash = Math.imul(topologyHash ^ i, 16777619) >>> 0;
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      normals.push(normal.x, normal.y, normal.z);
      totalArea += area; areas.push(totalArea);
      bounds.expandByPoint(a); bounds.expandByPoint(b); bounds.expandByPoint(c);
    }
  }
  function visit(object) {
    if (!object || visited.has(object)) return;
    visited.add(object);
    const data = object.userData ?? {};
    // Batching/merging hide the authored mesh and draw their own proxy. The
    // authored surface remains the stable source for planting and attachments.
    const optimizedSource = data.batchedInto || data.mergedInto;
    if (data.foliage || data.foliageGenerated || data.foliageOwned || data.editorHelper || data.batchProxy || data.mergeProxy || data.impostorQuad || (options.includeInvisible !== true && object.visible === false && !optimizedSource)) return;
    if (object.isMesh && (!options.filter || options.filter(object))) {
      if (object.isInstancedMesh) {
        for (let i = 0; i < object.count; i++) { object.getMatrixAt(i, instance); append(object, world.multiplyMatrices(object.matrixWorld, instance)); }
      } else append(object, object.matrixWorld);
    }
    for (const child of object.children ?? []) visit(child);
  }
  for (const root of roots) { root?.updateWorldMatrix?.(true, true); visit(root); }
  return { triangles: new Float64Array(positions), normals: new Float32Array(normals), cumulativeAreas: new Float64Array(areas), totalArea, bounds, topologyKey: `${topologyParts.join("|")}:${topologyHash}`, stats: { triangles: areas.length, meshes, skippedDegenerate } };
}

// Clip only altitude-crossing triangles. Carry original barycentrics through the
// clipping so sculpting can later reseat a plant on its original source face.
function altitudePieces(triangles, offset, lower, upper) {
  let polygon = [
    [triangles[offset], triangles[offset + 1], triangles[offset + 2], 1, 0, 0],
    [triangles[offset + 3], triangles[offset + 4], triangles[offset + 5], 0, 1, 0],
    [triangles[offset + 6], triangles[offset + 7], triangles[offset + 8], 0, 0, 1],
  ];
  for (const [limit, direction] of [[lower, 1], [upper, -1]]) {
    if (!Number.isFinite(limit) || polygon.length === 0) continue;
    const output = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const insideA = (a[1] - limit) * direction >= 0, insideB = (b[1] - limit) * direction >= 0;
      if (insideA) output.push(a);
      if (insideA !== insideB) {
        const t = (limit - a[1]) / (b[1] - a[1]);
        output.push(a.map((value, j) => value + (b[j] - value) * t));
      }
    }
    polygon = output;
  }
  const pieces = [];
  for (let i = 1; i + 1 < polygon.length; i++) {
    const [a, b, c] = [polygon[0], polygon[i], polygon[i + 1]];
    const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const area = ab.cross(ac).length() * 0.5;
    if (area > 1e-12) pieces.push({ vertices: [a, b, c], area });
  }
  return pieces;
}

function triangleAt(areas, value) {
  let lo = 0, hi = areas.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (value < areas[mid]) hi = mid; else lo = mid + 1; }
  return lo;
}

/**
 * Area-weighted deterministic surface scatter with bounded rejection sampling.
 * count is optional; otherwise density is instances per square metre. Filters
 * are applied before computing density, so a rejected hillside does not steal
 * the meadow's population. Spacing uses a three-dimensional neighbor hash.
 */
export function scatterFoliage(rootOrSurface, props = {}) {
  const surface = rootOrSurface?.triangles ? rootOrSurface : collectSurfaceTriangles(rootOrSurface, props);
  const random = foliageRandom(finite(props.seed, 1));
  const minSlope = THREE.MathUtils.clamp(finite(props.minSlope, 0), 0, 180);
  const maxSlope = THREE.MathUtils.clamp(finite(props.maxSlope, 90), minSlope, 180);
  const minAltitude = finite(props.minAltitude, -Infinity), maxAltitude = finite(props.maxAltitude, Infinity);
  const eligible = [], areas = [];
  let eligibleArea = 0;
  for (let i = 0; i < surface.cumulativeAreas.length; i++) {
    const slope = Math.acos(THREE.MathUtils.clamp(surface.normals[i * 3 + 1], -1, 1)) * 180 / Math.PI;
    if (slope < minSlope - 1e-5 || slope > maxSlope + 1e-5) continue;
    const ys = [surface.triangles[i * 9 + 1], surface.triangles[i * 9 + 4], surface.triangles[i * 9 + 7]];
    if (Math.max(...ys) < minAltitude || Math.min(...ys) > maxAltitude) continue;
    if (Math.min(...ys) < minAltitude || Math.max(...ys) > maxAltitude) {
      for (const piece of altitudePieces(surface.triangles, i * 9, minAltitude, maxAltitude)) {
        eligibleArea += piece.area; eligible.push({ index: i, vertices: piece.vertices }); areas.push(eligibleArea);
      }
    } else {
      eligibleArea += surface.cumulativeAreas[i] - (surface.cumulativeAreas[i - 1] ?? 0);
      eligible.push({ index: i }); areas.push(eligibleArea);
    }
  }
  const cap = Math.min(MAX_FOLIAGE_INSTANCES, Math.max(0, Math.floor(finite(props.maxInstances, 10000))));
  const requested = Math.max(0, Math.floor(props.count != null ? finite(props.count, 0) : eligibleArea * Math.max(0, finite(props.density, 1))));
  const target = Math.min(cap, requested);
  const spacing = Math.max(0, finite(props.minSpacing, 0)), spacingSq = spacing * spacing;
  const minScale = Math.max(0.001, finite(props.minScale, 0.8)), maxScale = Math.max(minScale, finite(props.maxScale, 1.2));
  const cells = new Map(), instances = [];
  const normal = new THREE.Vector3(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), yawRotation = new THREE.Quaternion();
  let attempts = 0, rejectedSpacing = 0, rejectedAltitude = 0;
  const attemptBudget = Math.min(2000000, Math.max(target, target * 20));
  while (instances.length < target && attempts < attemptBudget && eligibleArea > 0) {
    attempts++;
    const selected = eligible[triangleAt(areas, random() * eligibleArea)], triangle = selected.index, offset = triangle * 9;
    const root = Math.sqrt(random()), split = random();
    let u = 1 - root, v = root * (1 - split), w = root * split;
    if (selected.vertices) {
      const [a, b, c] = selected.vertices;
      [u, v, w] = [a[3] * u + b[3] * v + c[3] * w, a[4] * u + b[4] * v + c[4] * w, a[5] * u + b[5] * v + c[5] * w];
    }
    const t = surface.triangles;
    position.set(t[offset] * u + t[offset + 3] * v + t[offset + 6] * w, t[offset + 1] * u + t[offset + 4] * v + t[offset + 7] * w, t[offset + 2] * u + t[offset + 5] * v + t[offset + 8] * w);
    if (position.y < minAltitude || position.y > maxAltitude) { rejectedAltitude++; continue; }
    let key;
    if (spacing > 0) {
      const gx = Math.floor(position.x / spacing), gy = Math.floor(position.y / spacing), gz = Math.floor(position.z / spacing);
      let blocked = false;
      for (let x = -1; x <= 1 && !blocked; x++) for (let y = -1; y <= 1 && !blocked; y++) for (let z = -1; z <= 1 && !blocked; z++) {
        const neighbors = cells.get(`${gx + x},${gy + y},${gz + z}`);
        for (const p of neighbors ?? []) if ((p[0] - position.x) ** 2 + (p[1] - position.y) ** 2 + (p[2] - position.z) ** 2 < spacingSq) { blocked = true; break; }
      }
      if (blocked) { rejectedSpacing++; continue; }
      key = `${gx},${gy},${gz}`;
    }
    normal.fromArray(surface.normals, triangle * 3).normalize();
    const yaw = random() * Math.PI * 2, scale = minScale + random() * (maxScale - minScale);
    rotation.identity();
    if (props.alignToNormal !== false) rotation.setFromUnitVectors(UP, normal);
    yawRotation.setFromAxisAngle(UP, yaw); rotation.multiply(yawRotation);
    const p = position.toArray();
    instances.push({ position: p, normal: normal.toArray(), quaternion: rotation.toArray(), scale, yaw, seed: Math.floor(random() * 4294967296), triangleIndex: triangle, barycentric: [u, v, w], alignToNormal: props.alignToNormal !== false });
    if (key) { let bucket = cells.get(key); if (!bucket) cells.set(key, bucket = []); bucket.push(p); }
  }
  return { instances, surface, stats: { ...surface.stats, surfaceArea: surface.totalArea, eligibleArea, requested, placed: instances.length, capped: requested > cap, attempts, rejectedSpacing, rejectedAltitude, exhausted: instances.length < target } };
}

/**
 * Update placements in place after a terrain sculpt or source transform. Caller
 * must compare surface.topologyKey before reseating and rescatters on a change.
 * Density/spacing are authoring constraints; reseating preserves plant identity.
 */
export function reseatFoliageInstances(surface, instances) {
  const normal = new THREE.Vector3(), rotation = new THREE.Quaternion(), yaw = new THREE.Quaternion();
  let updated = 0, invalid = 0;
  for (const instance of instances) {
    const offset = instance.triangleIndex * 9, bary = instance.barycentric;
    if (!bary || !Number.isInteger(instance.triangleIndex) || offset < 0 || offset + 8 >= surface.triangles.length) { invalid++; continue; }
    const t = surface.triangles, [u, v, w] = bary;
    instance.position[0] = t[offset] * u + t[offset + 3] * v + t[offset + 6] * w;
    instance.position[1] = t[offset + 1] * u + t[offset + 4] * v + t[offset + 7] * w;
    instance.position[2] = t[offset + 2] * u + t[offset + 5] * v + t[offset + 8] * w;
    normal.fromArray(surface.normals, instance.triangleIndex * 3).normalize(); normal.toArray(instance.normal);
    rotation.identity();
    if (instance.alignToNormal !== false) rotation.setFromUnitVectors(UP, normal);
    rotation.multiply(yaw.setFromAxisAngle(UP, instance.yaw)).toArray(instance.quaternion);
    updated++;
  }
  return { instances, updated, invalid };
}
