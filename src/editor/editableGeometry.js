import * as THREE from "three/webgpu";
import { GEOMETRY_ASSET_VERSION } from "../engine/geometryAsset.js";

export function editableFromBufferGeometry(geometry) {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const indices = geometry.index
    ? Array.from(geometry.index.array)
    : Array.from({ length: position.count }, (_, i) => i);
  const faceMaterials = Array(indices.length / 3).fill(0);
  for (const group of geometry.groups) {
    const first = Math.floor(group.start / 3);
    const last = Math.min(faceMaterials.length, Math.ceil((group.start + group.count) / 3));
    for (let face = first; face < last; face++) faceMaterials[face] = group.materialIndex ?? 0;
  }
  return {
    positions: Array.from({ length: position.count }, (_, i) => [position.getX(i), position.getY(i), position.getZ(i)]),
    faces: Array.from({ length: indices.length / 3 }, (_, i) => indices.slice(i * 3, i * 3 + 3)),
    uvs: uv ? Array.from({ length: position.count }, (_, i) => [uv.getX(i), uv.getY(i)]) : [],
    faceMaterials,
    looseEdges: (geometry.userData?.editableEdges ?? []).map((edge) => [...edge]),
    // `null` means legacy / unauthored topology and lets Edit Mode infer flat
    // triangulation diagonals once. An array (including an empty one) is an
    // authored answer and must be preserved exactly.
    hiddenEdges: Array.isArray(geometry.userData?.editableHiddenEdges)
      ? geometry.userData.editableHiddenEdges.map((edge) => [...edge])
      : null,
  };
}

export function cloneEditable(editable) {
  return {
    positions: editable.positions.map((p) => [...p]),
    faces: editable.faces.map((f) => [...f]),
    uvs: editable.uvs.map((uv) => [...uv]),
    faceMaterials: [...(editable.faceMaterials ?? [])],
    looseEdges: (editable.looseEdges ?? []).map((edge) => [...edge]),
    hiddenEdges: Array.isArray(editable.hiddenEdges) ? editable.hiddenEdges.map((edge) => [...edge]) : null,
  };
}

export function bufferGeometryFromEditable(editable) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(editable.positions.flat(), 3));
  geometry.setIndex(editable.faces.flat());
  if (editable.uvs.length === editable.positions.length) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(editable.uvs.flat(), 2));
  }
  applyMaterialGroups(geometry, editable.faceMaterials, editable.faces.length);
  geometry.userData.editableEdges = (editable.looseEdges ?? []).map((edge) => [...edge]);
  if (Array.isArray(editable.hiddenEdges)) {
    geometry.userData.editableHiddenEdges = editable.hiddenEdges.map((edge) => [...edge]);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function geometryAssetFromEditable(editable) {
  const hiddenEdges = Array.isArray(editable.hiddenEdges)
    ? editable.hiddenEdges
    : inferredHiddenEdgePairs(editable);
  return {
    version: GEOMETRY_ASSET_VERSION,
    positions: editable.positions.flat(),
    indices: editable.faces.flat(),
    uvs: editable.uvs.length === editable.positions.length ? editable.uvs.flat() : [],
    groups: materialGroups(editable.faceMaterials, editable.faces.length),
    edges: (editable.looseEdges ?? []).flat(),
    hiddenEdges: hiddenEdges.flat(),
  };
}

function inferredHiddenEdgePairs(editable) {
  const hidden = coplanarHiddenEdges(editable);
  const pairs = new Map();
  editable.faces.forEach((face) => face.forEach((a, edge) => {
    const b = face[(edge + 1) % 3];
    if (hidden.has(spatialEdgeKey(editable.positions[a], editable.positions[b]))) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      pairs.set(key, a < b ? [a, b] : [b, a]);
    }
  }));
  return [...pairs.values()];
}

function materialGroups(faceMaterials = [], faceCount = 0) {
  if (!faceCount) return [];
  const groups = [];
  let materialIndex = faceMaterials[0] ?? 0;
  let startFace = 0;
  for (let face = 1; face <= faceCount; face++) {
    const next = face < faceCount ? (faceMaterials[face] ?? 0) : null;
    if (next === materialIndex) continue;
    groups.push({ start: startFace * 3, count: (face - startFace) * 3, materialIndex });
    startFace = face;
    materialIndex = next;
  }
  return groups;
}

function applyMaterialGroups(geometry, faceMaterials, faceCount) {
  for (const group of materialGroups(faceMaterials, faceCount)) geometry.addGroup(group.start, group.count, group.materialIndex);
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
export function beginExtrudeFaces(editable, faceIndices, hiddenIndexEdges = new Set()) {
  const selected = [...new Set(faceIndices)].filter((index) => editable.faces[index]);
  if (!selected.length) return { faceIndices: [], vertexIndices: [], normal: [0, 0, 1] };
  const hasUVs = editable.uvs.length === editable.positions.length;
  const normals = selected.map((index) => faceNormal(editable, editable.faces[index]));
  const normal = normals.reduce((sum, value) => sum.add(value), new THREE.Vector3());
  if (normal.lengthSq() < 1e-10) normal.copy(normals[0]);
  normal.normalize();
  const vertexMap = new Map();
  const duplicate = (oldIndex) => {
    // Render vertices at the same position can carry different UVs/normals.
    // Welding them by position here destroyed cap UV seams after extrusion.
    if (vertexMap.has(oldIndex)) return vertexMap.get(oldIndex);
    const index = editable.positions.length;
    editable.positions.push([...editable.positions[oldIndex]]);
    if (hasUVs) editable.uvs.push([...(editable.uvs[oldIndex] ?? [0, 0])]);
    vertexMap.set(oldIndex, index);
    return index;
  };
  const boundary = new Map();
  const visiblePairs = new Set();
  const indexKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const faceIndex of selected) {
    const face = editable.faces[faceIndex];
    for (let edge = 0; edge < 3; edge++) {
      const a = face[edge];
      const b = face[(edge + 1) % 3];
      const key = spatialEdgeKey(editable.positions[a], editable.positions[b]);
      const entry = boundary.get(key) ?? { count: 0, edge: [a, b] };
      entry.count++;
      boundary.set(key, entry);
    }
    const cap = face.map(duplicate);
    editable.faces[faceIndex] = cap;
    for (let edge = 0; edge < 3; edge++) {
      const sourceKey = indexKey(face[edge], face[(edge + 1) % 3]);
      if (!hiddenIndexEdges.has(sourceKey)) {
        visiblePairs.add(indexKey(cap[edge], cap[(edge + 1) % 3]));
      }
    }
  }
  const moving = [...vertexMap.values()];
  const walls = [];
  for (const { count, edge: [a, b] } of boundary.values()) {
    if (count !== 1) continue;
    // Walls need their own four render vertices. Sharing cap vertices forces
    // one UV value to serve two perpendicular surfaces and visibly tears the
    // texture. Logical edit topology remains welded by position.
    const wall = [a, b, a, b].map((sourceIndex) => {
      const index = editable.positions.length;
      editable.positions.push([...editable.positions[sourceIndex]]);
      if (hasUVs) editable.uvs.push([0, 0]);
      return index;
    });
    const [baseA, baseB, topA, topB] = wall;
    editable.faces.push([baseA, baseB, topB], [baseA, topB, topA]);
    moving.push(topA, topB);
    walls.push(wall);
    visiblePairs.add(indexKey(baseA, baseB));
    visiblePairs.add(indexKey(topA, topB));
    visiblePairs.add(indexKey(baseA, topA));
    visiblePairs.add(indexKey(baseB, topB));
    const material = editable.faceMaterials?.[selected[0]] ?? 0;
    editable.faceMaterials?.push(material, material);
  }
  const result = {
    faceIndices: selected,
    vertexIndices: moving,
    normal: normal.toArray(),
    walls,
    visiblePairs,
  };
  updateExtrudeUVs(editable, result);
  return result;
}

/** Creates connected duplicate vertices for an interactive vertex extrusion. */
export function beginExtrudeVertices(editable, vertexIndices) {
  const hasUVs = editable.uvs.length === editable.positions.length;
  const sources = new Map();
  vertexIndices.forEach((index) => {
    if (editable.positions[index]) sources.set(pointKey(editable.positions[index]), index);
  });
  const moving = [];
  editable.looseEdges ??= [];
  sources.forEach((source) => {
    const next = editable.positions.length;
    editable.positions.push([...editable.positions[source]]);
    if (hasUVs) editable.uvs.push([...(editable.uvs[source] ?? [0, 0])]);
    editable.looseEdges.push([source, next]);
    moving.push(next);
  });
  return { vertexIndices: moving, normal: [0, 0, 1], walls: [], visiblePairs: new Set() };
}

/** Creates zero-offset quad walls for an interactive edge extrusion. */
export function beginExtrudeEdges(editable, edgePairs) {
  const hasUVs = editable.uvs.length === editable.positions.length;
  const selected = new Map();
  edgePairs.forEach(([a, b]) => {
    if (editable.positions[a] && editable.positions[b]) selected.set(spatialEdgeKey(editable.positions[a], editable.positions[b]), [a, b]);
  });
  const moving = [];
  const topEdges = [];
  const walls = [];
  const visiblePairs = new Set();
  const normal = new THREE.Vector3();
  const indexKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  selected.forEach((pair, spatialKey) => {
    let [a, b] = pair;
    let material = 0;
    for (let faceIndex = 0; faceIndex < editable.faces.length; faceIndex++) {
      const face = editable.faces[faceIndex];
      const directed = face.map((start, edge) => [start, face[(edge + 1) % face.length]])
        .find(([start, end]) => spatialEdgeKey(editable.positions[start], editable.positions[end]) === spatialKey);
      if (!directed) continue;
      [a, b] = directed;
      normal.add(faceNormal(editable, face));
      material = editable.faceMaterials?.[faceIndex] ?? 0;
      break;
    }
    const wall = [a, b, a, b].map((source) => {
      const next = editable.positions.length;
      editable.positions.push([...editable.positions[source]]);
      if (hasUVs) editable.uvs.push([0, 0]);
      return next;
    });
    const [baseA, baseB, topA, topB] = wall;
    editable.faces.push([baseA, baseB, topB], [baseA, topB, topA]);
    editable.faceMaterials?.push(material, material);
    moving.push(topA, topB);
    topEdges.push([topA, topB]);
    walls.push(wall);
    [[baseA, baseB], [topA, topB], [baseA, topA], [baseB, topB]].forEach(([start, end]) => visiblePairs.add(indexKey(start, end)));
  });
  if (normal.lengthSq() < 1e-10) normal.set(0, 0, 1);
  normal.normalize();
  const result = { vertexIndices: moving, edges: topEdges, normal: normal.toArray(), walls, visiblePairs };
  updateExtrudeUVs(editable, result);
  return result;
}

/** Rebuilds the dedicated wall UV strips after an interactive extrusion moves. */
export function updateExtrudeUVs(editable, extrusion) {
  if (editable.uvs.length !== editable.positions.length) return;
  for (const [baseA, baseB, topA, topB] of extrusion.walls ?? []) {
    const a = new THREE.Vector3(...editable.positions[baseA]);
    const b = new THREE.Vector3(...editable.positions[baseB]);
    const c = new THREE.Vector3(...editable.positions[topA]);
    const d = new THREE.Vector3(...editable.positions[topB]);
    const width = Math.max(a.distanceTo(b), 1e-6);
    const height = Math.max((a.distanceTo(c) + b.distanceTo(d)) * 0.5, 1e-6);
    editable.uvs[baseA] = [0, 0];
    editable.uvs[baseB] = [width, 0];
    editable.uvs[topA] = [0, height];
    editable.uvs[topB] = [width, height];
  }
}

/** Extrudes a connected triangle region by a fixed distance. */
export function extrudeFaces(editable, faceIndices, distance) {
  if (!Number.isFinite(distance)) return [];
  const result = beginExtrudeFaces(editable, faceIndices);
  const offset = new THREE.Vector3(...result.normal).multiplyScalar(distance);
  result.vertexIndices.forEach((index) => {
    editable.positions[index] = new THREE.Vector3(...editable.positions[index]).add(offset).toArray();
  });
  updateExtrudeUVs(editable, result);
  return result.faceIndices;
}

export function deleteFaces(editable, faceIndices) {
  const removed = new Set(faceIndices);
  editable.faceMaterials = (editable.faceMaterials ?? []).filter((_, index) => !removed.has(index));
  editable.faces = editable.faces.filter((_, index) => !removed.has(index));
  const used = new Set([...editable.faces.flat(), ...(editable.looseEdges ?? []).flat()]);
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
  editable.looseEdges = (editable.looseEdges ?? []).map(([a, b]) => [remap.get(a), remap.get(b)]).filter(([a, b]) => a !== undefined && b !== undefined);
  if (Array.isArray(editable.hiddenEdges)) {
    editable.hiddenEdges = editable.hiddenEdges
      .map(([a, b]) => [remap.get(a), remap.get(b)])
      .filter(([a, b]) => a !== undefined && b !== undefined);
  }
}

/** Reverses the winding (and therefore the normal) of the requested faces. */
export function flipFaces(editable, faceIndices) {
  const selected = new Set(faceIndices);
  let flipped = 0;
  selected.forEach((faceIndex) => {
    const face = editable.faces[faceIndex];
    if (!face || face.length < 3) return;
    editable.faces[faceIndex] = [face[0], ...face.slice(1).reverse()];
    flipped++;
  });
  return flipped;
}

function orderedEdgeComponents(editable, edgePairs) {
  const nodes = new Map();
  const edges = new Map();
  const node = (index) => {
    const key = pointKey(editable.positions[index]);
    if (!nodes.has(key)) nodes.set(key, { key, index, neighbours: new Set() });
    return nodes.get(key);
  };
  edgePairs.forEach(([a, b]) => {
    if (!editable.positions[a] || !editable.positions[b]) return;
    const start = node(a);
    const end = node(b);
    if (start.key === end.key) return;
    const key = [start.key, end.key].sort().join("|");
    edges.set(key, [start.key, end.key]);
    start.neighbours.add(end.key);
    end.neighbours.add(start.key);
  });
  if ([...nodes.values()].some((entry) => entry.neighbours.size > 2)) {
    return { error: "Selected edges must form non-branching loops or chains" };
  }
  const remaining = new Set(edges.keys());
  const components = [];
  while (remaining.size) {
    const seedEdge = edges.get(remaining.values().next().value);
    const connected = new Set(seedEdge);
    const queue = [...seedEdge];
    while (queue.length) {
      const key = queue.pop();
      nodes.get(key).neighbours.forEach((next) => {
        if (!connected.has(next)) { connected.add(next); queue.push(next); }
      });
    }
    const endpoints = [...connected].filter((key) => nodes.get(key).neighbours.size === 1);
    if (endpoints.length !== 0 && endpoints.length !== 2) return { error: "Selected edges do not form a valid loop or chain" };
    const closed = endpoints.length === 0;
    const start = endpoints[0] ?? connected.values().next().value;
    const ordered = [];
    let previous = null;
    let current = start;
    do {
      ordered.push(nodes.get(current).index);
      const next = [...nodes.get(current).neighbours].find((key) => key !== previous && (closed ? key !== start || ordered.length === connected.size : true));
      if (!next) break;
      remaining.delete([current, next].sort().join("|"));
      previous = current;
      current = next;
    } while (current !== start && ordered.length <= connected.size);
    if (closed) remaining.delete([current, previous].sort().join("|"));
    connected.forEach((key) => nodes.get(key).neighbours.forEach((next) => remaining.delete([key, next].sort().join("|"))));
    if (ordered.length !== connected.size) return { error: "Could not order the selected edge boundary" };
    components.push({ indices: ordered, closed });
  }
  return { components };
}

/** Bridges two equally sized selected edge loops or open chains with quads. */
export function bridgeEdgeLoops(editable, edgePairs) {
  const ordered = orderedEdgeComponents(editable, edgePairs);
  if (ordered.error) return ordered;
  if (ordered.components.length !== 2) return { error: "Bridge requires exactly two edge loops or chains" };
  const [first, second] = ordered.components;
  if (first.closed !== second.closed) return { error: "Both bridge boundaries must both be open or both be closed" };
  if (first.indices.length !== second.indices.length) return { error: "Bridge boundaries must have the same vertex count" };
  const count = first.indices.length;
  if (count < 2) return { error: "Bridge boundaries are too small" };
  const distance = (a, b) => new THREE.Vector3(...editable.positions[a]).distanceToSquared(new THREE.Vector3(...editable.positions[b]));
  let best = null;
  const orientations = [second.indices, [...second.indices].reverse()];
  orientations.forEach((candidate) => {
    const shifts = first.closed ? count : 1;
    for (let shift = 0; shift < shifts; shift++) {
      const aligned = candidate.map((_, index) => candidate[(index + shift) % count]);
      const score = aligned.reduce((sum, index, i) => sum + distance(first.indices[i], index), 0);
      if (!best || score < best.score) best = { score, indices: aligned };
    }
  });
  const faceIndices = [];
  const hiddenKeys = [];
  const segments = first.closed ? count : count - 1;
  for (let index = 0; index < segments; index++) {
    const next = (index + 1) % count;
    const a = first.indices[index];
    const b = first.indices[next];
    const c = best.indices[next];
    const d = best.indices[index];
    faceIndices.push(editable.faces.length, editable.faces.length + 1);
    editable.faces.push([a, b, c], [a, c, d]);
    editable.faceMaterials?.push(0, 0);
    hiddenKeys.push(spatialEdgeKey(editable.positions[a], editable.positions[c]));
  }
  return { faceIndices, hiddenKeys };
}

/** Fills a four-sided selected boundary with a Coons-interpolated quad grid. */
export function gridFillEdges(editable, edgePairs) {
  const ordered = orderedEdgeComponents(editable, edgePairs);
  if (ordered.error) return ordered;
  if (ordered.components.length !== 1 || !ordered.components[0].closed) return { error: "Grid Fill requires one closed edge boundary" };
  const boundary = ordered.components[0].indices;
  if (boundary.length < 4) return { error: "Grid Fill boundary is too small" };
  const score = boundary.map((index, position) => {
    const previous = new THREE.Vector3(...editable.positions[boundary[(position - 1 + boundary.length) % boundary.length]]);
    const point = new THREE.Vector3(...editable.positions[index]);
    const next = new THREE.Vector3(...editable.positions[boundary[(position + 1) % boundary.length]]);
    return { position, score: 1 - previous.sub(point).normalize().dot(next.sub(point).normalize()) };
  });
  if (boundary.length % 2) return { error: "Grid Fill requires an even number of boundary vertices" };
  const scores = new Map(score.map((entry) => [entry.position, entry.score]));
  const half = boundary.length / 2;
  let bestCorners = null;
  for (let start = 0; start < boundary.length; start++) for (let firstSpan = 1; firstSpan < half; firstSpan++) {
    const candidate = [start, (start + firstSpan) % boundary.length, (start + half) % boundary.length, (start + half + firstSpan) % boundary.length];
    const cornerScore = candidate.reduce((sum, position) => sum + scores.get(position), 0);
    const candidateScore = cornerScore - Math.abs(firstSpan - (half - firstSpan)) * 1e-3;
    if (!bestCorners || candidateScore > bestCorners.score) bestCorners = { score: candidateScore, positions: candidate };
  }
  const corners = bestCorners.positions.sort((a, b) => a - b);
  const side = (start, end) => {
    const values = [];
    for (let at = start; ; at = (at + 1) % boundary.length) {
      values.push(boundary[at]);
      if (at === end) return values;
    }
  };
  const sides = corners.map((corner, index) => side(corner, corners[(index + 1) % 4]));
  if (sides[0].length !== sides[2].length || sides[1].length !== sides[3].length) {
    return { error: "Opposite Grid Fill sides must have matching vertex counts" };
  }
  const columns = sides[0].length - 1;
  const rows = sides[1].length - 1;
  const top = sides[0];
  const right = sides[1];
  const bottom = [...sides[2]].reverse();
  const left = [...sides[3]].reverse();
  const grid = Array.from({ length: rows + 1 }, () => Array(columns + 1));
  top.forEach((index, column) => { grid[0][column] = index; });
  bottom.forEach((index, column) => { grid[rows][column] = index; });
  left.forEach((index, row) => { grid[row][0] = index; });
  right.forEach((index, row) => { grid[row][columns] = index; });
  const vector = (index) => new THREE.Vector3(...editable.positions[index]);
  const c00 = vector(grid[0][0]);
  const c10 = vector(grid[0][columns]);
  const c01 = vector(grid[rows][0]);
  const c11 = vector(grid[rows][columns]);
  const hasUVs = editable.uvs.length === editable.positions.length;
  for (let row = 1; row < rows; row++) {
    const v = row / rows;
    for (let column = 1; column < columns; column++) {
      const u = column / columns;
      const point = vector(top[column]).multiplyScalar(1 - v).addScaledVector(vector(bottom[column]), v)
        .addScaledVector(vector(left[row]), 1 - u).addScaledVector(vector(right[row]), u)
        .sub(c00.clone().multiplyScalar((1 - u) * (1 - v)))
        .sub(c10.clone().multiplyScalar(u * (1 - v)))
        .sub(c01.clone().multiplyScalar((1 - u) * v))
        .sub(c11.clone().multiplyScalar(u * v));
      grid[row][column] = editable.positions.length;
      editable.positions.push(point.toArray());
      if (hasUVs) editable.uvs.push([u, v]);
    }
  }
  const polygonNormal = new THREE.Vector3();
  boundary.forEach((index, at) => {
    const current = vector(index);
    const next = vector(boundary[(at + 1) % boundary.length]);
    polygonNormal.x += (current.y - next.y) * (current.z + next.z);
    polygonNormal.y += (current.z - next.z) * (current.x + next.x);
    polygonNormal.z += (current.x - next.x) * (current.y + next.y);
  });
  const faceIndices = [];
  const hiddenKeys = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const a = grid[row][column];
    const b = grid[row][column + 1];
    const c = grid[row + 1][column + 1];
    const d = grid[row + 1][column];
    let faces = [[a, b, c], [a, c, d]];
    if (faceNormal(editable, faces[0]).dot(polygonNormal) < 0) faces = faces.map(([x, y, z]) => [x, z, y]);
    faceIndices.push(editable.faces.length, editable.faces.length + 1);
    editable.faces.push(...faces);
    editable.faceMaterials?.push(0, 0);
    hiddenKeys.push(spatialEdgeKey(editable.positions[a], editable.positions[c]));
  }
  return { faceIndices, hiddenKeys };
}

/** Removes intermediate/orphan vertices while preserving UV and loose-edge indices. */
export function removeUnusedVertices(editable) {
  const used = new Set([...editable.faces.flat(), ...(editable.looseEdges ?? []).flat()]);
  const remap = new Map();
  const positions = [];
  const uvs = [];
  [...used].sort((a, b) => a - b).forEach((oldIndex) => {
    remap.set(oldIndex, positions.length);
    positions.push(editable.positions[oldIndex]);
    if (editable.uvs[oldIndex]) uvs.push(editable.uvs[oldIndex]);
  });
  const removed = editable.positions.length - positions.length;
  editable.positions = positions;
  editable.uvs = uvs.length === positions.length ? uvs : [];
  editable.faces = editable.faces.map((face) => face.map((index) => remap.get(index)));
  editable.looseEdges = (editable.looseEdges ?? [])
    .map(([a, b]) => [remap.get(a), remap.get(b)])
    .filter(([a, b]) => a !== undefined && b !== undefined);
  if (Array.isArray(editable.hiddenEdges)) {
    editable.hiddenEdges = editable.hiddenEdges
      .map(([a, b]) => [remap.get(a), remap.get(b)])
      .filter(([a, b]) => a !== undefined && b !== undefined);
  }
  return removed;
}

/**
 * Builds a compact editable mesh from a face selection. This is the persistent
 * half of Blender's Separate by Selection operation; the caller decides where
 * the returned mesh is saved and which entity owns it.
 */
export function editableFromFaces(editable, faceIndices) {
  const selected = [...new Set(faceIndices)]
    .filter((index) => Number.isInteger(index) && editable.faces[index]);
  const used = new Set(selected.flatMap((index) => editable.faces[index]));
  const remap = new Map();
  const positions = [];
  const uvs = [];
  [...used].sort((a, b) => a - b).forEach((oldIndex) => {
    remap.set(oldIndex, positions.length);
    positions.push([...editable.positions[oldIndex]]);
    if (editable.uvs[oldIndex]) uvs.push([...editable.uvs[oldIndex]]);
  });
  const hiddenEdges = Array.isArray(editable.hiddenEdges)
    ? editable.hiddenEdges
      .map(([a, b]) => [remap.get(a), remap.get(b)])
      .filter(([a, b]) => a !== undefined && b !== undefined)
    : null;
  return {
    positions,
    faces: selected.map((index) => editable.faces[index].map((vertex) => remap.get(vertex))),
    uvs: uvs.length === positions.length ? uvs : [],
    faceMaterials: selected.map((index) => editable.faceMaterials?.[index] ?? 0),
    looseEdges: [],
    hiddenEdges,
  };
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
  const nextMaterials = [];
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
  const triangulate = (polygon, material) => {
    for (let i = 1; i < polygon.length - 1; i++) {
      nextFaces.push([polygon[0], polygon[i], polygon[i + 1]]);
      nextMaterials.push(material);
    }
  };
  sourceFaces.forEach((face, faceIndex) => {
    const material = editable.faceMaterials?.[faceIndex] ?? 0;
    if (!component.has(faceIndex)) { nextFaces.push(face); nextMaterials.push(material); return; }
    const distances = face.map(distance);
    const hasPositive = distances.some((value) => value > epsilon);
    const hasNegative = distances.some((value) => value < -epsilon);
    if (!hasPositive || !hasNegative) { nextFaces.push(face); nextMaterials.push(material); return; }
    const faceCuts = [];
    for (let edge = 0; edge < 3; edge++) {
      const next = (edge + 1) % 3;
      if ((distances[edge] > epsilon && distances[next] < -epsilon) || (distances[edge] < -epsilon && distances[next] > epsilon)) {
        faceCuts.push(intersection(face[edge], face[next], distances[edge], distances[next]));
      }
    }
    triangulate(clip(face, distances, true), material);
    triangulate(clip(face, distances, false), material);
    const uniqueCuts = [...new Set(faceCuts)];
    if (uniqueCuts.length >= 2) {
      const a = editable.positions[uniqueCuts[0]];
      const b = editable.positions[uniqueCuts[1]];
      cutEdges.add(spatialEdgeKey(a, b));
    }
  });
  editable.faces = nextFaces;
  editable.faceMaterials = nextMaterials;
  return { edgeKeys: [...cutEdges], vertexIndices: [...intersectionCache.values()] };
}

/** Splits a connected shell by many parallel planes in one linear pass. */
export function cutMeshByParallelPlanes(editable, planeNormal, planePoints, seedFace = 0) {
  const normal = new THREE.Vector3(...planeNormal).normalize();
  const thresholds = planePoints.map((point) => normal.dot(new THREE.Vector3(...point))).sort((a, b) => a - b);
  if (!thresholds.length) return { edgeKeys: [], vertexIndices: [] };
  const component = connectedFaces(editable, seedFace);
  const sourceFaces = editable.faces.map((face) => [...face]);
  const sourceMaterials = [...(editable.faceMaterials ?? [])];
  const nextFaces = [];
  const nextMaterials = [];
  const generated = new Map();
  const epsilon = 1e-7;
  const scalar = (index) => normal.dot(new THREE.Vector3(...editable.positions[index]));
  const createVertex = (a, b, boundary) => {
    const pa = new THREE.Vector3(...editable.positions[a]);
    const pb = new THREE.Vector3(...editable.positions[b]);
    const sa = normal.dot(pa);
    const sb = normal.dot(pb);
    const t = THREE.MathUtils.clamp((boundary - sa) / (sb - sa || 1), 0, 1);
    const position = pa.lerp(pb, t).toArray();
    const uvA = editable.uvs[a] ?? [0, 0];
    const uvB = editable.uvs[b] ?? [0, 0];
    const uv = [THREE.MathUtils.lerp(uvA[0], uvB[0], t), THREE.MathUtils.lerp(uvA[1], uvB[1], t)];
    const key = `${pointKey(position)}|${pointKey(uv)}|${Math.round(boundary * 1e6)}`;
    if (generated.has(key)) return generated.get(key);
    const index = editable.positions.length;
    editable.positions.push(position);
    if (editable.uvs.length) editable.uvs.push(uv);
    generated.set(key, index);
    return index;
  };
  const clip = (polygon, boundary, keepAbove) => {
    const result = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const da = scalar(a) - boundary;
      const db = scalar(b) - boundary;
      const insideA = keepAbove ? da >= -epsilon : da <= epsilon;
      const insideB = keepAbove ? db >= -epsilon : db <= epsilon;
      if (insideA) result.push(a);
      if (insideA !== insideB) result.push(createVertex(a, b, boundary));
    }
    return result;
  };
  sourceFaces.forEach((face, faceIndex) => {
    const material = sourceMaterials[faceIndex] ?? 0;
    if (!component.has(faceIndex)) {
      nextFaces.push(face);
      nextMaterials.push(material);
      return;
    }
    const values = face.map(scalar);
    const faceMin = Math.min(...values);
    const faceMax = Math.max(...values);
    for (let band = 0; band <= thresholds.length; band++) {
      const lower = band ? thresholds[band - 1] : -Infinity;
      const upper = band < thresholds.length ? thresholds[band] : Infinity;
      if (upper < faceMin - epsilon || lower > faceMax + epsilon) continue;
      let polygon = face;
      if (Number.isFinite(lower)) polygon = clip(polygon, lower, true);
      if (polygon.length >= 3 && Number.isFinite(upper)) polygon = clip(polygon, upper, false);
      for (let index = 1; index + 1 < polygon.length; index++) {
        const triangle = [polygon[0], polygon[index], polygon[index + 1]];
        if (new Set(triangle.map((vertex) => pointKey(editable.positions[vertex]))).size < 3) continue;
        nextFaces.push(triangle);
        nextMaterials.push(material);
      }
    }
  });
  editable.faces = nextFaces;
  editable.faceMaterials = nextMaterials;
  const cutEdges = new Set();
  const cutVertices = new Set();
  editable.faces.forEach((face) => {
    for (let edge = 0; edge < 3; edge++) {
      const a = face[edge];
      const b = face[(edge + 1) % 3];
      const sa = scalar(a);
      const sb = scalar(b);
      if (thresholds.some((value) => Math.abs(sa - value) < 1e-5 && Math.abs(sb - value) < 1e-5)) {
        cutEdges.add(spatialEdgeKey(editable.positions[a], editable.positions[b]));
        cutVertices.add(a);
        cutVertices.add(b);
      }
    }
  });
  return { edgeKeys: [...cutEdges], vertexIndices: [...cutVertices] };
}

/**
 * Inserts cuts through the quad edge-ring containing `seedEdge`.
 *
 * Unlike a plane cut, an edge-ring cut is defined by topology: in every quad
 * we cross from an edge to the opposite edge and interpolate both of them by
 * the same factor.  This is the important distinction on cones and other
 * tapered meshes, where a plane normal to one sloping edge produces a tilted
 * ring while Blender's loop cut stays at the same local height.
 *
 * `hiddenSourceEdges` contains spatial keys for render-only triangulation
 * diagonals.  They are used to recover the logical quads from the triangle
 * buffer and the returned hidden keys describe the new triangulation.
 */
export function cutMeshByEdgeRing(editable, seedEdge, factors, hiddenSourceEdges = new Set()) {
  const cuts = [...new Set(factors
    .map((value) => THREE.MathUtils.clamp(Number(value), 0.000001, 0.999999))
    .filter(Number.isFinite))].sort((a, b) => a - b);
  if (!cuts.length || !seedEdge?.[0] || !seedEdge?.[1]) {
    return { edgeKeys: [], vertexIndices: [], hiddenKeys: [...hiddenSourceEdges] };
  }

  const sourceFaces = editable.faces.map((face) => [...face]);
  const sourceMaterials = [...(editable.faceMaterials ?? [])];
  const edgeFaces = new Map();
  sourceFaces.forEach((face, faceIndex) => {
    for (let edge = 0; edge < 3; edge++) {
      const key = spatialEdgeKey(editable.positions[face[edge]], editable.positions[face[(edge + 1) % 3]]);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(faceIndex);
    }
  });

  // Recover individual logical quads from pairs of triangles. A flood fill is
  // subtly wrong here: several stacked cone quads can be coplanar, which would
  // merge an entire side strip into one long polygon and leave no quad ring to
  // walk. Rank candidate shared diagonals against the quad's other diagonal;
  // real triangulation diagonals are similar in length, while a grid border
  // shared by triangles in neighboring rows is much shorter than the span.
  const faceGroup = new Array(sourceFaces.length);
  const groups = [];
  const candidates = [];
  edgeFaces.forEach((faces, key) => {
    if (!hiddenSourceEdges.has(key) || faces.length !== 2) return;
    const [first, second] = faces;
    const shared = key.split("|");
    const vertices = new Map([...sourceFaces[first], ...sourceFaces[second]]
      .map((index) => [pointKey(editable.positions[index]), index]));
    if (vertices.size !== 4) return;
    const opposite = [...vertices].filter(([vertex]) => !shared.includes(vertex)).map(([, index]) => index);
    if (opposite.length !== 2) return;
    const [a, b] = (edgeFaces.get(key) ? sourceFaces[first] : []).filter((index) => shared.includes(pointKey(editable.positions[index])));
    const sharedLength = new THREE.Vector3(...editable.positions[a]).distanceTo(new THREE.Vector3(...editable.positions[b]));
    const otherLength = new THREE.Vector3(...editable.positions[opposite[0]]).distanceTo(new THREE.Vector3(...editable.positions[opposite[1]]));
    const score = Math.min(sharedLength, otherLength) / Math.max(sharedLength, otherLength, 1e-9);
    candidates.push({ first, second, score });
  });
  candidates.sort((a, b) => b.score - a.score).forEach(({ first, second }) => {
    if (faceGroup[first] !== undefined || faceGroup[second] !== undefined) return;
    const id = groups.length;
    faceGroup[first] = id;
    faceGroup[second] = id;
    groups.push({ faces: [first, second], boundary: [] });
  });
  sourceFaces.forEach((_, faceIndex) => {
    if (faceGroup[faceIndex] !== undefined) return;
    faceGroup[faceIndex] = groups.length;
    groups.push({ faces: [faceIndex], boundary: [] });
  });

  // A consistently-wound triangle contributes its directed edge to the
  // logical polygon boundary when that edge is not internal to the group.
  groups.forEach((group, groupId) => {
    const boundary = [];
    group.faces.forEach((faceIndex) => {
      const face = sourceFaces[faceIndex];
      for (let edge = 0; edge < 3; edge++) {
        const a = face[edge];
        const b = face[(edge + 1) % 3];
        const key = spatialEdgeKey(editable.positions[a], editable.positions[b]);
        const internal = (edgeFaces.get(key) ?? []).some((other) => other !== faceIndex && faceGroup[other] === groupId);
        if (!internal) boundary.push({ a, b, key });
      }
    });
    if (!boundary.length) return;
    const ordered = [boundary.shift()];
    while (boundary.length) {
      const end = pointKey(editable.positions[ordered.at(-1).b]);
      const next = boundary.findIndex((edge) => pointKey(editable.positions[edge.a]) === end);
      if (next < 0) break;
      ordered.push(boundary.splice(next, 1)[0]);
    }
    group.boundary = ordered;
  });

  const polygonEdges = new Map();
  groups.forEach((group, groupId) => group.boundary.forEach((edge) => {
    if (!polygonEdges.has(edge.key)) polygonEdges.set(edge.key, []);
    polygonEdges.get(edge.key).push(groupId);
  }));
  const seedKey = spatialEdgeKey(seedEdge[0], seedEdge[1]);
  const orientedSeed = [pointKey(seedEdge[0]), pointKey(seedEdge[1])];
  const descriptors = new Map();
  const walk = (startGroup) => {
    let groupId = startGroup;
    let incomingKey = seedKey;
    let orientation = orientedSeed;
    while (groupId !== undefined && !descriptors.has(groupId)) {
      const group = groups[groupId];
      if (group.boundary.length !== 4) break; // Blender terminates at poles/ngons too.
      let incoming = group.boundary.findIndex((edge) => edge.key === incomingKey);
      if (incoming < 0) break;
      // Rotate the boundary so vertices 0->1 follow the propagated direction.
      const edge = group.boundary[incoming];
      if (pointKey(editable.positions[edge.a]) !== orientation[0]) {
        group.boundary = [...group.boundary].reverse().map(({ a, b, key }) => ({ a: b, b: a, key }));
        incoming = group.boundary.findIndex((candidate) => candidate.key === incomingKey);
      }
      const ordered = Array.from({ length: 4 }, (_, offset) => group.boundary[(incoming + offset) % 4]);
      const opposite = ordered[2];
      descriptors.set(groupId, { group, vertices: [ordered[0].a, ordered[0].b, ordered[1].b, ordered[2].b] });
      // Corresponding parameter direction is opposite to the polygon winding.
      orientation = [pointKey(editable.positions[opposite.b]), pointKey(editable.positions[opposite.a])];
      incomingKey = opposite.key;
      groupId = (polygonEdges.get(incomingKey) ?? []).find((candidate) => candidate !== groupId);
    }
  };
  (polygonEdges.get(seedKey) ?? []).forEach(walk);
  if (!descriptors.size) {
    // A primitive cone has a triangle fan rather than quads. Treat its radial
    // edges as an edge ring around the high-valence pole so Ctrl+R can insert
    // horizontal rings instead of silently doing nothing.
    const incidence = new Map();
    sourceFaces.forEach((face) => new Set(face.map((index) => pointKey(editable.positions[index]))).forEach((key) => {
      incidence.set(key, (incidence.get(key) ?? 0) + 1);
    }));
    const endpoints = orientedSeed.map((key) => ({ key, count: incidence.get(key) ?? 0 })).sort((a, b) => b.count - a.count);
    const poleKey = endpoints[0]?.key;
    if (!poleKey || endpoints[0].count < Math.max(3, endpoints[1].count * 2)) {
      return { edgeKeys: [], vertexIndices: [], hiddenKeys: [...hiddenSourceEdges] };
    }
    const fan = new Map();
    const walkFan = (startGroup) => {
      let groupId = startGroup;
      let incoming = seedKey;
      while (groupId !== undefined && !fan.has(groupId)) {
        const group = groups[groupId];
        if (group.boundary.length !== 3) break;
        const radial = group.boundary.filter(({ a, b }) =>
          pointKey(editable.positions[a]) === poleKey || pointKey(editable.positions[b]) === poleKey);
        if (radial.length !== 2 || !radial.some((edge) => edge.key === incoming)) break;
        const outgoing = radial.find((edge) => edge.key !== incoming);
        const sourceFace = sourceFaces[group.faces[0]];
        const pole = sourceFace.find((index) => pointKey(editable.positions[index]) === poleKey);
        const outer = radial.map((edge) => pointKey(editable.positions[edge.a]) === poleKey ? edge.b : edge.a);
        fan.set(groupId, { group, pole, outer });
        incoming = outgoing.key;
        groupId = (polygonEdges.get(incoming) ?? []).find((candidate) => candidate !== groupId);
      }
    };
    (polygonEdges.get(seedKey) ?? []).forEach(walkFan);
    if (!fan.size) return { edgeKeys: [], vertexIndices: [], hiddenKeys: [...hiddenSourceEdges] };

    const fanCuts = (orientedSeed[0] === poleKey ? cuts : cuts.map((value) => 1 - value)).sort((a, b) => a - b);
    const removed = new Set([...fan.values()].flatMap(({ group }) => group.faces));
    const nextFaces = [];
    const nextMaterials = [];
    const nextHidden = new Set(hiddenSourceEdges);
    const cutEdges = new Set();
    const cutVertices = new Set();
    const cache = new Map();
    sourceFaces.forEach((face, faceIndex) => {
      if (removed.has(faceIndex)) return;
      nextFaces.push(face);
      nextMaterials.push(sourceMaterials[faceIndex] ?? 0);
    });
    const interpolateFan = (a, b, t) => {
      const key = `${a}|${b}|${Math.round(t * 1e9)}`;
      if (cache.has(key)) return cache.get(key);
      const index = editable.positions.length;
      editable.positions.push(new THREE.Vector3(...editable.positions[a]).lerp(new THREE.Vector3(...editable.positions[b]), t).toArray());
      if (editable.uvs.length) {
        const uvA = editable.uvs[a] ?? [0, 0];
        const uvB = editable.uvs[b] ?? [0, 0];
        editable.uvs.push([THREE.MathUtils.lerp(uvA[0], uvB[0], t), THREE.MathUtils.lerp(uvA[1], uvB[1], t)]);
      }
      cache.set(key, index);
      cutVertices.add(index);
      return index;
    };
    const orientFan = (face, normal) => {
      const [a, b, c] = face.map((index) => new THREE.Vector3(...editable.positions[index]));
      return b.sub(a).cross(c.sub(a)).dot(normal) < 0 ? [face[0], face[2], face[1]] : face;
    };
    fan.forEach(({ group, pole, outer: [a, b] }) => {
      const sourceFace = sourceFaces[group.faces[0]];
      const sourceA = new THREE.Vector3(...editable.positions[sourceFace[0]]);
      const normal = new THREE.Vector3(...editable.positions[sourceFace[1]]).sub(sourceA)
        .cross(new THREE.Vector3(...editable.positions[sourceFace[2]]).sub(sourceA)).normalize();
      const material = sourceMaterials[group.faces[0]] ?? 0;
      let previousA = pole;
      let previousB = pole;
      fanCuts.forEach((t, cutIndex) => {
        const nextA = interpolateFan(pole, a, t);
        const nextB = interpolateFan(pole, b, t);
        if (cutIndex === 0) {
          nextFaces.push(orientFan([pole, nextA, nextB], normal));
          nextMaterials.push(material);
        } else {
          nextFaces.push(orientFan([previousA, nextA, nextB], normal), orientFan([previousA, nextB, previousB], normal));
          nextMaterials.push(material, material);
          nextHidden.add(spatialEdgeKey(editable.positions[previousA], editable.positions[nextB]));
        }
        const key = spatialEdgeKey(editable.positions[nextA], editable.positions[nextB]);
        cutEdges.add(key);
        nextHidden.delete(key);
        previousA = nextA;
        previousB = nextB;
      });
      nextFaces.push(orientFan([previousA, a, b], normal), orientFan([previousA, b, previousB], normal));
      nextMaterials.push(material, material);
      nextHidden.add(spatialEdgeKey(editable.positions[previousA], editable.positions[b]));
    });
    editable.faces = nextFaces;
    editable.faceMaterials = nextMaterials;
    return { edgeKeys: [...cutEdges], vertexIndices: [...cutVertices], hiddenKeys: [...nextHidden] };
  }

  const nextFaces = [];
  const nextMaterials = [];
  const nextHidden = new Set(hiddenSourceEdges);
  const cutEdges = new Set();
  const cutVertices = new Set();
  const interpolationCache = new Map();
  const removedFaces = new Set([...descriptors.values()].flatMap(({ group }) => group.faces));
  sourceFaces.forEach((face, faceIndex) => {
    if (removedFaces.has(faceIndex)) return;
    nextFaces.push(face);
    nextMaterials.push(sourceMaterials[faceIndex] ?? 0);
  });
  const interpolate = (a, b, t) => {
    // Preserve the source mesh's smoothing topology. Adjacent quads which
    // shared an indexed edge reuse the cut vertex; UV seams (different source
    // indices at the same position) intentionally keep separate copies.
    const canonicalT = a < b ? t : 1 - t;
    const cacheKey = `${Math.min(a, b)}|${Math.max(a, b)}|${Math.round(canonicalT * 1e9)}`;
    if (interpolationCache.has(cacheKey)) return interpolationCache.get(cacheKey);
    const index = editable.positions.length;
    editable.positions.push(new THREE.Vector3(...editable.positions[a]).lerp(new THREE.Vector3(...editable.positions[b]), t).toArray());
    if (editable.uvs.length) {
      const uvA = editable.uvs[a] ?? [0, 0];
      const uvB = editable.uvs[b] ?? [0, 0];
      editable.uvs.push([THREE.MathUtils.lerp(uvA[0], uvB[0], t), THREE.MathUtils.lerp(uvA[1], uvB[1], t)]);
    }
    cutVertices.add(index);
    interpolationCache.set(cacheKey, index);
    return index;
  };
  const oriented = (face, referenceNormal) => {
    const [a, b, c] = face.map((index) => new THREE.Vector3(...editable.positions[index]));
    return b.sub(a).cross(c.sub(a)).dot(referenceNormal) < 0 ? [face[0], face[2], face[1]] : face;
  };
  const pushQuad = (a, b, c, d, material, referenceNormal) => {
    nextFaces.push(oriented([a, b, c], referenceNormal), oriented([a, c, d], referenceNormal));
    nextMaterials.push(material, material);
    nextHidden.add(spatialEdgeKey(editable.positions[a], editable.positions[c]));
  };
  descriptors.forEach(({ group, vertices: [a, b, c, d] }) => {
    const material = sourceMaterials[group.faces[0]] ?? 0;
    const sourceFace = sourceFaces[group.faces[0]];
    const sourceA = new THREE.Vector3(...editable.positions[sourceFace[0]]);
    const referenceNormal = new THREE.Vector3(...editable.positions[sourceFace[1]]).sub(sourceA)
      .cross(new THREE.Vector3(...editable.positions[sourceFace[2]]).sub(sourceA)).normalize();
    let leftA = a;
    let leftD = d;
    cuts.forEach((t) => {
      const ab = interpolate(a, b, t);
      const dc = interpolate(d, c, t);
      pushQuad(leftA, ab, dc, leftD, material, referenceNormal);
      const key = spatialEdgeKey(editable.positions[ab], editable.positions[dc]);
      cutEdges.add(key);
      nextHidden.delete(key);
      leftA = ab;
      leftD = dc;
    });
    pushQuad(leftA, b, c, leftD, material, referenceNormal);
  });
  editable.faces = nextFaces;
  editable.faceMaterials = nextMaterials;
  return { edgeKeys: [...cutEdges], vertexIndices: [...cutVertices], hiddenKeys: [...nextHidden] };
}

/** Collapses selected logical vertices to their average without destroying UV seams. */
export function mergeVerticesAtCenter(editable, indices) {
  const selected = [...new Set(indices)].filter((index) => editable.positions[index]);
  if (selected.length < 2) return [];
  const logicalPoints = new Map(selected.map((index) => [pointKey(editable.positions[index]), editable.positions[index]]));
  const center = [...logicalPoints.values()].reduce((sum, point) => sum.add(new THREE.Vector3(...point)), new THREE.Vector3())
    .multiplyScalar(1 / logicalPoints.size).toArray();
  selected.forEach((index) => { editable.positions[index] = [...center]; });
  const keptFaces = [];
  const keptMaterials = [];
  editable.faces.forEach((face, faceIndex) => {
    if (new Set(face.map((index) => pointKey(editable.positions[index]))).size < 3) return;
    keptFaces.push(face);
    keptMaterials.push(editable.faceMaterials?.[faceIndex] ?? 0);
  });
  editable.faces = keptFaces;
  editable.faceMaterials = keptMaterials;
  return selected;
}

/** Insets selected triangles while interpolating their UVs. */
export function insetFaces(editable, faceIndices, amount = 0.2) {
  const selected = new Set(faceIndices.filter((index) => editable.faces[index]));
  const factor = THREE.MathUtils.clamp(amount, 0.001, 0.999);
  const nextFaces = [];
  const nextMaterials = [];
  const insetSelection = [];
  const visibleEdgeKeys = new Set();
  editable.faces.forEach((face, faceIndex) => {
    if (selected.has(faceIndex)) return;
    nextFaces.push(face);
    nextMaterials.push(editable.faceMaterials?.[faceIndex] ?? 0);
  });
  const edgeFaces = new Map();
  selected.forEach((faceIndex) => {
    const face = editable.faces[faceIndex];
    for (let edge = 0; edge < 3; edge++) {
      const key = spatialEdgeKey(editable.positions[face[edge]], editable.positions[face[(edge + 1) % 3]]);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(faceIndex);
    }
  });
  const remaining = new Set(selected);
  while (remaining.size) {
    const seed = remaining.values().next().value;
    const region = new Set([seed]);
    const queue = [seed];
    remaining.delete(seed);
    while (queue.length) {
      const faceIndex = queue.pop();
      const face = editable.faces[faceIndex];
      for (let edge = 0; edge < 3; edge++) {
        const key = spatialEdgeKey(editable.positions[face[edge]], editable.positions[face[(edge + 1) % 3]]);
        for (const neighbor of edgeFaces.get(key) ?? []) {
          if (remaining.delete(neighbor)) { region.add(neighbor); queue.push(neighbor); }
        }
      }
    }
    const boundary = [];
    region.forEach((faceIndex) => {
      const face = editable.faces[faceIndex];
      for (let edge = 0; edge < 3; edge++) {
        const a = face[edge];
        const b = face[(edge + 1) % 3];
        const key = spatialEdgeKey(editable.positions[a], editable.positions[b]);
        if ((edgeFaces.get(key) ?? []).filter((index) => region.has(index)).length === 1) boundary.push([a, b]);
      }
    });
    if (boundary.length < 3) continue;
    const ordered = [boundary[0][0]];
    const used = new Set([0]);
    let current = boundary[0][1];
    while (used.size < boundary.length && pointKey(editable.positions[current]) !== pointKey(editable.positions[ordered[0]])) {
      ordered.push(current);
      const currentKey = pointKey(editable.positions[current]);
      let nextEdge = boundary.findIndex(([a], index) => !used.has(index) && pointKey(editable.positions[a]) === currentKey);
      let reversed = false;
      if (nextEdge < 0) {
        nextEdge = boundary.findIndex(([, b], index) => !used.has(index) && pointKey(editable.positions[b]) === currentKey);
        reversed = true;
      }
      if (nextEdge < 0) break;
      used.add(nextEdge);
      current = boundary[nextEdge][reversed ? 0 : 1];
    }
    if (ordered.length < 3) continue;
    const center = ordered.reduce((sum, index) => sum.add(new THREE.Vector3(...editable.positions[index])), new THREE.Vector3()).multiplyScalar(1 / ordered.length);
    const uvCenter = ordered.reduce((sum, index) => {
      const uv = editable.uvs[index] ?? [0, 0];
      return [sum[0] + uv[0] / ordered.length, sum[1] + uv[1] / ordered.length];
    }, [0, 0]);
    const inner = ordered.map((index) => {
      const next = editable.positions.length;
      editable.positions.push(new THREE.Vector3(...editable.positions[index]).lerp(center, factor).toArray());
      if (editable.uvs.length) {
        const uv = editable.uvs[index] ?? [0, 0];
        editable.uvs.push([THREE.MathUtils.lerp(uv[0], uvCenter[0], factor), THREE.MathUtils.lerp(uv[1], uvCenter[1], factor)]);
      }
      return next;
    });
    // Both the inset perimeter and the spokes joining it to the source border
    // are real edit edges. They are coplanar with the surrounding faces, so the
    // topology cache cannot distinguish them from triangulation diagonals
    // unless the operation reports them explicitly.
    for (let edge = 0; edge < ordered.length; edge++) {
      const n = (edge + 1) % ordered.length;
      visibleEdgeKeys.add(spatialEdgeKey(editable.positions[inner[edge]], editable.positions[inner[n]]));
      visibleEdgeKeys.add(spatialEdgeKey(editable.positions[ordered[edge]], editable.positions[inner[edge]]));
    }
    const material = editable.faceMaterials?.[seed] ?? 0;
    const firstInsetFace = nextFaces.length;
    for (let index = 1; index < inner.length - 1; index++) {
      nextFaces.push([inner[0], inner[index], inner[index + 1]]);
      nextMaterials.push(material);
      insetSelection.push(firstInsetFace + index - 1);
    }
    for (let edge = 0; edge < ordered.length; edge++) {
      const n = (edge + 1) % ordered.length;
      nextFaces.push([ordered[edge], ordered[n], inner[n]], [ordered[edge], inner[n], inner[edge]]);
      nextMaterials.push(material, material);
    }
  }
  editable.faces = nextFaces;
  editable.faceMaterials = nextMaterials;
  insetSelection.visibleEdgeKeys = [...visibleEdgeKeys];
  return insetSelection;
}

export function assignFaceMaterial(editable, faceIndices, materialIndex) {
  if (!Number.isInteger(materialIndex) || materialIndex < 0) return;
  if (!editable.faceMaterials) editable.faceMaterials = Array(editable.faces.length).fill(0);
  faceIndices.forEach((face) => { if (editable.faces[face]) editable.faceMaterials[face] = materialIndex; });
}

export function mirrorVertices(editable, indices, axis, pivot = [0, 0, 0]) {
  const component = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const selected = new Set(indices);
  selected.forEach((index) => {
    const point = editable.positions[index];
    if (point) point[component] = pivot[component] * 2 - point[component];
  });
  editable.faces.forEach((face) => {
    if (face.every((index) => selected.has(index))) [face[1], face[2]] = [face[2], face[1]];
  });
}

function clipForBevel(editable, normal, planePoint, edgeDirection, capMaterial, uvRange = [0, 1]) {
  const sourceFaces = editable.faces;
  const sourceMaterials = editable.faceMaterials ?? [];
  const nextFaces = [];
  const nextMaterials = [];
  const intersections = new Map();
  const capVertices = new Map();
  const epsilon = 1e-7;
  const distance = (index) => normal.dot(new THREE.Vector3(...editable.positions[index]).sub(planePoint));
  const intersection = (a, b, da, db) => {
    // Preserve render-vertex splits at UV/material seams. Logical welding is
    // still position-based in the editor, but each side keeps its own UV.
    const key = [a, b].sort((x, y) => x - y).join("|");
    if (intersections.has(key)) return intersections.get(key);
    const t = da / (da - db);
    const index = editable.positions.length;
    editable.positions.push(new THREE.Vector3(...editable.positions[a]).lerp(new THREE.Vector3(...editable.positions[b]), t).toArray());
    if (editable.uvs.length) {
      const uvA = editable.uvs[a] ?? [0, 0];
      const uvB = editable.uvs[b] ?? [0, 0];
      editable.uvs.push([THREE.MathUtils.lerp(uvA[0], uvB[0], t), THREE.MathUtils.lerp(uvA[1], uvB[1], t)]);
    }
    intersections.set(key, index);
    capVertices.set(pointKey(editable.positions[index]), index);
    return index;
  };
  sourceFaces.forEach((face, faceIndex) => {
    const polygon = [];
    for (let i = 0; i < 3; i++) {
      const current = face[i];
      const next = face[(i + 1) % 3];
      const dc = distance(current);
      const dn = distance(next);
      if (dc <= epsilon) {
        polygon.push(current);
        if (Math.abs(dc) <= epsilon) capVertices.set(pointKey(editable.positions[current]), current);
      }
      if ((dc < -epsilon && dn > epsilon) || (dc > epsilon && dn < -epsilon)) polygon.push(intersection(current, next, dc, dn));
    }
    for (let i = 1; i + 1 < polygon.length; i++) {
      nextFaces.push([polygon[0], polygon[i], polygon[i + 1]]);
      nextMaterials.push(sourceMaterials[faceIndex] ?? 0);
    }
  });
  const cap = [...capVertices.values()];
  if (cap.length >= 3) {
    const center = cap.reduce((sum, index) => sum.add(new THREE.Vector3(...editable.positions[index])), new THREE.Vector3()).multiplyScalar(1 / cap.length);
    const u = edgeDirection.clone().normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    cap.sort((a, b) => {
      const pa = new THREE.Vector3(...editable.positions[a]).sub(center);
      const pb = new THREE.Vector3(...editable.positions[b]).sub(center);
      return Math.atan2(pa.dot(v), pa.dot(u)) - Math.atan2(pb.dot(v), pb.dot(u));
    });
    const projected = cap.map((index) => {
      const point = new THREE.Vector3(...editable.positions[index]).sub(center);
      return [point.dot(u), point.dot(v)];
    });
    const minU = Math.min(...projected.map(([value]) => value));
    const maxU = Math.max(...projected.map(([value]) => value));
    const minV = Math.min(...projected.map(([, value]) => value));
    const maxV = Math.max(...projected.map(([, value]) => value));
    const capOnly = cap.map((source, index) => {
      const duplicate = editable.positions.length;
      editable.positions.push([...editable.positions[source]]);
      if (editable.uvs.length) {
        const localU = (projected[index][0] - minU) / (maxU - minU || 1);
        const localV = (projected[index][1] - minV) / (maxV - minV || 1);
        editable.uvs.push([localU, THREE.MathUtils.lerp(uvRange[0], uvRange[1], localV)]);
      }
      return duplicate;
    });
    for (let i = 1; i + 1 < capOnly.length; i++) {
      const face = [capOnly[0], capOnly[i], capOnly[i + 1]];
      if (faceNormal(editable, face).dot(normal) < 0) [face[1], face[2]] = [face[2], face[1]];
      nextFaces.push(face);
      nextMaterials.push(capMaterial);
    }
  }
  editable.faces = nextFaces;
  editable.faceMaterials = nextMaterials;
  return cap.length >= 3;
}

/** Bevels manifold convex edges by clipping their corner wedge and capping it. */
export function bevelEdges(editable, edgeKeys, amount = 0.12, segments = 1) {
  const selected = new Set(edgeKeys);
  const occurrences = new Map();
  editable.faces.forEach((face, faceIndex) => {
    const normal = faceNormal(editable, face);
    for (let edge = 0; edge < 3; edge++) {
      const a = face[edge];
      const b = face[(edge + 1) % 3];
      const key = spatialEdgeKey(editable.positions[a], editable.positions[b]);
      if (!selected.has(key)) continue;
      if (!occurrences.has(key)) occurrences.set(key, []);
      occurrences.get(key).push({ a, b, normal, material: editable.faceMaterials?.[faceIndex] ?? 0 });
    }
  });
  const center = editable.positions.reduce((sum, point) => sum.add(new THREE.Vector3(...point)), new THREE.Vector3()).multiplyScalar(1 / Math.max(editable.positions.length, 1));
  const descriptors = [];
  for (const sides of occurrences.values()) {
    const normals = [];
    sides.forEach((side) => {
      if (!normals.some((normal) => Math.abs(normal.dot(side.normal)) > 0.9999)) normals.push(side.normal);
    });
    if (normals.length !== 2 || Math.abs(normals[0].dot(normals[1])) > 0.9999) continue;
    const start = new THREE.Vector3(...editable.positions[sides[0].a]);
    const end = new THREE.Vector3(...editable.positions[sides[0].b]);
    const normal = normals[0].clone().add(normals[1]).normalize();
    if (normal.dot(center.clone().sub(start)) > 0) normal.negate();
    const available = normals.flatMap((sideNormal) => editable.positions
      .map((point) => -sideNormal.dot(new THREE.Vector3(...point).sub(start)))
      .filter((distance) => distance > 1e-6));
    if (!available.length) continue;
    const width = Math.min(...available) * THREE.MathUtils.clamp(amount, 0.001, 0.45);
    descriptors.push({ normals: normals.map((value) => value.clone()), start, direction: end.sub(start), width, material: sides[0].material });
  }
  let count = 0;
  descriptors.forEach(({ normals, start, direction, width, material }) => {
    const bisector = normals[0].clone().add(normals[1]).normalize();
    if (bisector.dot(center.clone().sub(start)) > 0) normals.forEach((value) => value.negate());
    const centerOffset = normals[0].clone().add(normals[1]).multiplyScalar(-width / Math.max(1 + normals[0].dot(normals[1]), 1e-5));
    const arcCenter = start.clone().add(centerOffset);
    let applied = false;
    const steps = THREE.MathUtils.clamp(Math.round(segments), 1, 12);
    for (let step = 1; step <= steps; step++) {
      const t = step / (steps + 1);
      const facetNormal = normals[0].clone().lerp(normals[1], t).normalize();
      const facetPoint = arcCenter.clone().addScaledVector(facetNormal, width);
      applied = clipForBevel(editable, facetNormal, facetPoint, direction, material, [(step - 1) / steps, step / steps]) || applied;
    }
    if (applied) count++;
  });
  removeUnusedVertices(editable);
  return count;
}

/** Spatial keys of the edges that are pure triangulation artefacts of a flat mesh. */
export function coplanarHiddenEdges(editable) {
  const normals = new Map();
  editable.faces.forEach((face) => {
    const normal = faceNormal(editable, face);
    for (let edge = 0; edge < 3; edge++) {
      const key = spatialEdgeKey(editable.positions[face[edge]], editable.positions[face[(edge + 1) % 3]]);
      if (!normals.has(key)) normals.set(key, []);
      normals.get(key).push(normal);
    }
  });
  return new Set([...normals]
    .filter(([, sides]) => sides.length === 2 && sides[0].dot(sides[1]) >= 0.9999)
    .map(([key]) => key));
}

/**
 * One subdivision pass: splits every edge of the selected triangles and
 * conformingly splits the neighbours that share those edges.
 *
 * Split edges are tracked spatially, not by vertex index: adjacent faces of an
 * imported mesh keep their own vertex copies at UV/normal seams, so an
 * index-keyed lookup would leave the neighbour un-split and strand its original
 * full-length edge across the freshly subdivided face.
 *
 * `hiddenSourceEdges` carries in which edges are triangulation artefacts rather
 * than real polygon borders, and the returned `hiddenKeys` says the same about
 * the result. Deriving that from coplanarity here would be wrong the moment a
 * quad is bent: its diagonal must stay hidden even when its triangles are not.
 */
function subdividePass(editable, faceIndices, hiddenSourceEdges) {
  const selected = new Set(faceIndices ?? editable.faces.map((_, index) => index));
  const splitEdges = new Set();
  selected.forEach((faceIndex) => {
    const face = editable.faces[faceIndex];
    if (!face) return;
    for (let edge = 0; edge < 3; edge++) splitEdges.add(spatialEdgeKey(editable.positions[face[edge]], editable.positions[face[(edge + 1) % 3]]));
  });
  const midpointCache = new Map();
  const midpoint = (a, b) => {
    // Keyed by index pair so each side of a UV seam keeps its own midpoint copy.
    const key = [a, b].sort((x, y) => x - y).join("|");
    if (midpointCache.has(key)) return midpointCache.get(key);
    const index = editable.positions.length;
    editable.positions.push(new THREE.Vector3(...editable.positions[a]).lerp(new THREE.Vector3(...editable.positions[b]), 0.5).toArray());
    if (editable.uvs.length) {
      const uvA = editable.uvs[a] ?? [0, 0];
      const uvB = editable.uvs[b] ?? [0, 0];
      editable.uvs.push([(uvA[0] + uvB[0]) * 0.5, (uvA[1] + uvB[1]) * 0.5]);
    }
    midpointCache.set(key, index);
    return index;
  };
  const nextFaces = [];
  const nextMaterials = [];
  const nextSelected = [];
  const nextHidden = new Set();
  const hide = (x, y) => nextHidden.add(spatialEdgeKey(editable.positions[x], editable.positions[y]));
  editable.faces.forEach((face, faceIndex) => {
    const [a, b, c] = face;
    const material = editable.faceMaterials?.[faceIndex] ?? 0;
    const isSelected = selected.has(faceIndex);
    const push = (faces) => faces.forEach((value) => {
      if (isSelected) nextSelected.push(nextFaces.length);
      nextFaces.push(value);
      nextMaterials.push(material);
    });
    const pairs = [[a, b], [b, c], [c, a]];
    const sourceKeys = pairs.map(([x, y]) => spatialEdgeKey(editable.positions[x], editable.positions[y]));
    const mids = pairs.map(([x, y], edge) => (splitEdges.has(sourceKeys[edge]) ? midpoint(x, y) : null));
    // A hidden edge stays hidden after the cut, whole or in halves.
    const hiddenSource = sourceKeys.map((key) => hiddenSourceEdges.has(key));
    sourceKeys.forEach((key, edge) => {
      if (!hiddenSource[edge]) return;
      const mid = mids[edge];
      if (mid === null) nextHidden.add(key);
      else { hide(pairs[edge][0], mid); hide(mid, pairs[edge][1]); }
    });
    const count = mids.filter((value) => value !== null).length;
    if (!count) { push([[a, b, c]]); return; }
    if (count === 3) {
      const [ab, bc, ca] = mids;
      push([[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]);
      // The centre edges of a subdivided triangle are real edges only where they
      // separate two different logical polygons. Inside a quad (whose diagonal is
      // a hidden triangulation artefact) that leaves Blender's centre cross. A
      // neighbour split only to stay conforming keeps all three centres hidden.
      const visible = isSelected
        ? [hiddenSource[0] !== hiddenSource[1], hiddenSource[1] !== hiddenSource[2], hiddenSource[2] !== hiddenSource[0]]
        : [false, false, false];
      if (isSelected && !hiddenSource.some(Boolean)) visible.fill(true);
      [[ab, bc], [bc, ca], [ca, ab]].forEach(([x, y], edge) => { if (!visible[edge]) hide(x, y); });
      return;
    }
    if (count === 1) {
      if (mids[0] !== null) { push([[a, mids[0], c], [mids[0], b, c]]); hide(mids[0], c); }
      else if (mids[1] !== null) { push([[b, mids[1], a], [mids[1], c, a]]); hide(mids[1], a); }
      else { push([[c, mids[2], b], [mids[2], a, b]]); hide(mids[2], b); }
      return;
    }
    if (mids[0] === null) {
      push([[c, mids[2], mids[1]], [mids[2], a, b], [mids[2], b, mids[1]]]);
      hide(mids[2], mids[1]);
      hide(mids[2], b);
    } else if (mids[1] === null) {
      push([[a, mids[0], mids[2]], [mids[0], b, c], [mids[0], c, mids[2]]]);
      hide(mids[0], mids[2]);
      hide(mids[0], c);
    } else {
      push([[b, mids[1], mids[0]], [mids[1], c, a], [mids[1], a, mids[0]]]);
      hide(mids[1], mids[0]);
      hide(mids[1], a);
    }
  });
  editable.faces = nextFaces;
  editable.faceMaterials = nextMaterials;
  return { sourceCount: selected.size, hiddenKeys: nextHidden, faceIndices: nextSelected };
}

export const MAX_SUBDIVISION_CUTS = 6;

/** Subdivides selected triangles `cuts` times, conformingly splitting neighbours. */
export function subdivideFaces(editable, faceIndices = [], hiddenSourceEdges = null, cuts = 1) {
  const passes = THREE.MathUtils.clamp(Math.round(cuts) || 1, 1, MAX_SUBDIVISION_CUTS);
  let selected = faceIndices.length ? [...new Set(faceIndices)] : null;
  let hidden = new Set(hiddenSourceEdges ?? coplanarHiddenEdges(editable));
  let faceCount = 0;
  for (let pass = 0; pass < passes; pass++) {
    const result = subdividePass(editable, selected, hidden);
    if (!pass) faceCount = result.sourceCount;
    hidden = result.hiddenKeys;
    selected = result.faceIndices;
  }
  return { faceCount, hiddenKeys: [...hidden], faceIndices: selected ?? [] };
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
  const faceMaterials = [];
  const projected = [];
  for (const [faceIndex, face] of editable.faces.entries()) {
    const points = face.map((i) => editable.positions[i]);
    const a = new THREE.Vector3(...points[0]);
    const normal = new THREE.Vector3(...points[1]).sub(a).cross(new THREE.Vector3(...points[2]).sub(a));
    const abs = normal.set(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
    const axes = abs.x >= abs.y && abs.x >= abs.z ? [2, 1] : abs.y >= abs.z ? [0, 2] : [0, 1];
    const start = positions.length;
    positions.push(...points.map((p) => [...p]));
    projected.push(...points.map((p) => [p[axes[0]], p[axes[1]], 0]));
    faces.push([start, start + 1, start + 2]);
    faceMaterials.push(editable.faceMaterials?.[faceIndex] ?? 0);
  }
  editable.positions = positions;
  editable.faces = faces;
  editable.faceMaterials = faceMaterials;
  editable.looseEdges = [];
  editable.uvs = normalizedProjection(projected, [0, 1]);
}
