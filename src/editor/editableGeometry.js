import * as THREE from "three/webgpu";
import { GEOMETRY_ASSET_VERSION } from "../engine/geometryAsset.js";

export function editableFromBufferGeometry(geometry) {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const indices = geometry.index
    ? Array.from(geometry.index.array)
    : Array.from({ length: position.count }, (_, i) => i);
  return {
    positions: Array.from({ length: position.count }, (_, i) => [position.getX(i), position.getY(i), position.getZ(i)]),
    faces: Array.from({ length: indices.length / 3 }, (_, i) => indices.slice(i * 3, i * 3 + 3)),
    uvs: uv ? Array.from({ length: position.count }, (_, i) => [uv.getX(i), uv.getY(i)]) : [],
  };
}

export function cloneEditable(editable) {
  return {
    positions: editable.positions.map((p) => [...p]),
    faces: editable.faces.map((f) => [...f]),
    uvs: editable.uvs.map((uv) => [...uv]),
  };
}

export function bufferGeometryFromEditable(editable) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(editable.positions.flat(), 3));
  geometry.setIndex(editable.faces.flat());
  if (editable.uvs.length === editable.positions.length) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(editable.uvs.flat(), 2));
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function geometryAssetFromEditable(editable) {
  return {
    version: GEOMETRY_ASSET_VERSION,
    positions: editable.positions.flat(),
    indices: editable.faces.flat(),
    uvs: editable.uvs.length === editable.positions.length ? editable.uvs.flat() : [],
  };
}

export function extrudeFace(editable, faceIndex, distance) {
  const face = editable.faces[faceIndex];
  if (!face || !Number.isFinite(distance) || distance === 0) return faceIndex;
  const a = new THREE.Vector3(...editable.positions[face[0]]);
  const b = new THREE.Vector3(...editable.positions[face[1]]);
  const c = new THREE.Vector3(...editable.positions[face[2]]);
  const offset = b.clone().sub(a).cross(c.clone().sub(a)).normalize().multiplyScalar(distance);
  const next = face.map((oldIndex) => {
    const p = new THREE.Vector3(...editable.positions[oldIndex]).add(offset);
    editable.positions.push(p.toArray());
    editable.uvs.push(editable.uvs[oldIndex] ? [...editable.uvs[oldIndex]] : [0, 0]);
    return editable.positions.length - 1;
  });
  editable.faces[faceIndex] = next;
  for (let edge = 0; edge < 3; edge++) {
    const n = (edge + 1) % 3;
    editable.faces.push([face[edge], face[n], next[n]], [face[edge], next[n], next[edge]]);
  }
  return faceIndex;
}

function faceNormal(editable, face) {
  const a = new THREE.Vector3(...editable.positions[face[0]]);
  const b = new THREE.Vector3(...editable.positions[face[1]]);
  const c = new THREE.Vector3(...editable.positions[face[2]]);
  return b.sub(a).cross(c.sub(a)).normalize();
}

const pointKey = (point) => point.map((value) => Math.round(value * 1e5)).join(",");
const spatialEdgeKey = (a, b) => [pointKey(a), pointKey(b)].sort().join("|");

/** Expands render-buffer indices to every duplicate representing the same logical vertex. */
export function expandLogicalVertices(editable, indices) {
  const keys = new Set(indices.map((index) => pointKey(editable.positions[index])));
  const expanded = [];
  editable.positions.forEach((position, index) => {
    if (keys.has(pointKey(position))) expanded.push(index);
  });
  return expanded;
}

/** Returns the connected, coplanar triangle region containing faceIndex. */
export function coplanarFaceGroup(editable, faceIndex, threshold = 0.9999, blockedEdges = new Set()) {
  if (!editable.faces[faceIndex]) return [];
  const edgeFaces = new Map();
  editable.faces.forEach((face, index) => {
    for (let edge = 0; edge < 3; edge++) {
      const key = spatialEdgeKey(editable.positions[face[edge]], editable.positions[face[(edge + 1) % 3]]);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(index);
    }
  });
  const originNormal = faceNormal(editable, editable.faces[faceIndex]);
  const found = new Set([faceIndex]);
  const queue = [faceIndex];
  while (queue.length) {
    const current = queue.pop();
    const face = editable.faces[current];
    for (let edge = 0; edge < 3; edge++) {
      const key = spatialEdgeKey(editable.positions[face[edge]], editable.positions[face[(edge + 1) % 3]]);
      if (blockedEdges.has(key)) continue;
      for (const neighbor of edgeFaces.get(key) ?? []) {
        if (!found.has(neighbor) && faceNormal(editable, editable.faces[neighbor]).dot(originNormal) >= threshold) {
          found.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }
  return [...found];
}

/** Creates zero-offset extrusion topology for an interactive extrusion. */
export function beginExtrudeFaces(editable, faceIndices) {
  const selected = [...new Set(faceIndices)].filter((index) => editable.faces[index]);
  if (!selected.length) return { faceIndices: [], vertexIndices: [], normal: [0, 0, 1] };
  const normals = selected.map((index) => faceNormal(editable, editable.faces[index]));
  const normal = normals.reduce((sum, value) => sum.add(value), new THREE.Vector3());
  if (normal.lengthSq() < 1e-10) normal.copy(normals[0]);
  normal.normalize();
  const vertexMap = new Map();
  const duplicate = (oldIndex) => {
    const key = pointKey(editable.positions[oldIndex]);
    if (vertexMap.has(key)) return vertexMap.get(key);
    const index = editable.positions.length;
    editable.positions.push([...editable.positions[oldIndex]]);
    editable.uvs.push(editable.uvs[oldIndex] ? [...editable.uvs[oldIndex]] : [0, 0]);
    vertexMap.set(key, index);
    return index;
  };
  const boundary = new Map();
  for (const faceIndex of selected) {
    const face = editable.faces[faceIndex];
    for (let edge = 0; edge < 3; edge++) {
      const a = face[edge];
      const b = face[(edge + 1) % 3];
      const key = spatialEdgeKey(editable.positions[a], editable.positions[b]);
      if (boundary.has(key)) boundary.delete(key);
      else boundary.set(key, [a, b]);
    }
    editable.faces[faceIndex] = face.map(duplicate);
  }
  for (const [a, b] of boundary.values()) {
    const nextA = duplicate(a);
    const nextB = duplicate(b);
    editable.faces.push([a, b, nextB], [a, nextB, nextA]);
  }
  return { faceIndices: selected, vertexIndices: [...vertexMap.values()], normal: normal.toArray() };
}

/** Extrudes a connected triangle region by a fixed distance. */
export function extrudeFaces(editable, faceIndices, distance) {
  if (!Number.isFinite(distance)) return [];
  const result = beginExtrudeFaces(editable, faceIndices);
  const offset = new THREE.Vector3(...result.normal).multiplyScalar(distance);
  result.vertexIndices.forEach((index) => {
    editable.positions[index] = new THREE.Vector3(...editable.positions[index]).add(offset).toArray();
  });
  return result.faceIndices;
}

export function deleteFaces(editable, faceIndices) {
  const removed = new Set(faceIndices);
  editable.faces = editable.faces.filter((_, index) => !removed.has(index));
  const used = new Set(editable.faces.flat());
  const remap = new Map();
  const positions = [];
  const uvs = [];
  [...used].sort((a, b) => a - b).forEach((oldIndex) => {
    remap.set(oldIndex, positions.length);
    positions.push(editable.positions[oldIndex]);
    if (editable.uvs[oldIndex]) uvs.push(editable.uvs[oldIndex]);
  });
  editable.positions = positions;
  editable.uvs = uvs.length === positions.length ? uvs : [];
  editable.faces = editable.faces.map((face) => face.map((index) => remap.get(index)));
}

function connectedFaces(editable, seedFace) {
  const edgeFaces = new Map();
  editable.faces.forEach((face, faceIndex) => {
    for (let edge = 0; edge < 3; edge++) {
      const key = spatialEdgeKey(editable.positions[face[edge]], editable.positions[face[(edge + 1) % 3]]);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(faceIndex);
    }
  });
  const found = new Set([seedFace]);
  const queue = [seedFace];
  while (queue.length) {
    const faceIndex = queue.pop();
    const face = editable.faces[faceIndex];
    if (!face) continue;
    for (let edge = 0; edge < 3; edge++) {
      const key = spatialEdgeKey(editable.positions[face[edge]], editable.positions[face[(edge + 1) % 3]]);
      for (const neighbor of edgeFaces.get(key) ?? []) {
        if (!found.has(neighbor)) { found.add(neighbor); queue.push(neighbor); }
      }
    }
  }
  return found;
}

/** Splits the connected shell at seedFace with a plane and returns the new cut edges. */
export function cutMeshByPlane(editable, planeNormal, planePoint, seedFace = 0) {
  const normal = new THREE.Vector3(...planeNormal).normalize();
  const point = new THREE.Vector3(...planePoint);
  const component = connectedFaces(editable, seedFace);
  const sourceFaces = editable.faces.map((face) => [...face]);
  const nextFaces = [];
  const intersectionCache = new Map();
  const cutEdges = new Set();
  const epsilon = 1e-7;
  const distance = (index) => normal.dot(new THREE.Vector3(...editable.positions[index]).sub(point));
  const intersection = (a, b, da, db) => {
    const key = [a, b].sort((x, y) => x - y).join(":");
    if (intersectionCache.has(key)) return intersectionCache.get(key);
    const t = da / (da - db);
    const position = new THREE.Vector3(...editable.positions[a]).lerp(new THREE.Vector3(...editable.positions[b]), t);
    const index = editable.positions.length;
    editable.positions.push(position.toArray());
    if (editable.uvs.length) {
      const uvA = editable.uvs[a] ?? [0, 0];
      const uvB = editable.uvs[b] ?? [0, 0];
      editable.uvs.push([uvA[0] + (uvB[0] - uvA[0]) * t, uvA[1] + (uvB[1] - uvA[1]) * t]);
    }
    intersectionCache.set(key, index);
    return index;
  };
  const clip = (face, distances, positive) => {
    const polygon = [];
    for (let i = 0; i < 3; i++) {
      const current = face[i];
      const next = face[(i + 1) % 3];
      const dc = distances[i];
      const dn = distances[(i + 1) % 3];
      const currentInside = positive ? dc >= -epsilon : dc <= epsilon;
      const nextInside = positive ? dn >= -epsilon : dn <= epsilon;
      if (currentInside) polygon.push(current);
      if (currentInside !== nextInside && Math.abs(dc - dn) > epsilon) polygon.push(intersection(current, next, dc, dn));
    }
    return polygon;
  };
  const triangulate = (polygon) => {
    for (let i = 1; i < polygon.length - 1; i++) nextFaces.push([polygon[0], polygon[i], polygon[i + 1]]);
  };
  sourceFaces.forEach((face, faceIndex) => {
    if (!component.has(faceIndex)) { nextFaces.push(face); return; }
    const distances = face.map(distance);
    const hasPositive = distances.some((value) => value > epsilon);
    const hasNegative = distances.some((value) => value < -epsilon);
    if (!hasPositive || !hasNegative) { nextFaces.push(face); return; }
    const faceCuts = [];
    for (let edge = 0; edge < 3; edge++) {
      const next = (edge + 1) % 3;
      if ((distances[edge] > epsilon && distances[next] < -epsilon) || (distances[edge] < -epsilon && distances[next] > epsilon)) {
        faceCuts.push(intersection(face[edge], face[next], distances[edge], distances[next]));
      }
    }
    triangulate(clip(face, distances, true));
    triangulate(clip(face, distances, false));
    const uniqueCuts = [...new Set(faceCuts)];
    if (uniqueCuts.length >= 2) {
      const a = editable.positions[uniqueCuts[0]];
      const b = editable.positions[uniqueCuts[1]];
      cutEdges.add(spatialEdgeKey(a, b));
    }
  });
  editable.faces = nextFaces;
  return { edgeKeys: [...cutEdges], vertexIndices: [...intersectionCache.values()] };
}

function normalizedProjection(positions, axes) {
  const values = positions.map((p) => [p[axes[0]], p[axes[1]]]);
  const min = [Math.min(...values.map((p) => p[0])), Math.min(...values.map((p) => p[1]))];
  const max = [Math.max(...values.map((p) => p[0])), Math.max(...values.map((p) => p[1]))];
  return values.map(([u, v]) => [
    (u - min[0]) / (max[0] - min[0] || 1),
    (v - min[1]) / (max[1] - min[1] || 1),
  ]);
}

export function unwrapPlanar(editable, axis = "z") {
  const axes = axis === "x" ? [2, 1] : axis === "y" ? [0, 2] : [0, 1];
  editable.uvs = normalizedProjection(editable.positions, axes);
}

export function unwrapBox(editable) {
  const positions = [];
  const faces = [];
  const projected = [];
  for (const face of editable.faces) {
    const points = face.map((i) => editable.positions[i]);
    const a = new THREE.Vector3(...points[0]);
    const normal = new THREE.Vector3(...points[1]).sub(a).cross(new THREE.Vector3(...points[2]).sub(a));
    const abs = normal.set(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
    const axes = abs.x >= abs.y && abs.x >= abs.z ? [2, 1] : abs.y >= abs.z ? [0, 2] : [0, 1];
    const start = positions.length;
    positions.push(...points.map((p) => [...p]));
    projected.push(...points.map((p) => [p[axes[0]], p[axes[1]], 0]));
    faces.push([start, start + 1, start + 2]);
  }
  editable.positions = positions;
  editable.faces = faces;
  editable.uvs = normalizedProjection(projected, [0, 1]);
}
