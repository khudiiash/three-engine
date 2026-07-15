import { useEffect, useRef, useState } from "react";
import { Box, Circle, Eye, Layers, Magnet, Move, Rotate3d, Scale3d, Scissors, Square, Triangle, Undo2, X } from "lucide-react";
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { engine } from "../engineInstance.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { invalidateBlobUrl } from "../assetLoader.js";
import { ensureGeometryAsset } from "../geometryEditing.js";
import {
  bufferGeometryFromEditable,
  beginExtrudeFaces,
  assignFaceMaterial,
  bevelEdges,
  cloneEditable,
  coplanarHiddenEdges,
  cutMeshByEdgeRing,
  deleteFaces,
  editableFromBufferGeometry,
  expandLogicalVertices,
  geometryAssetFromEditable,
  insetFaces,
  mergeVerticesAtCenter,
  mirrorVertices,
  subdivideFaces,
  MAX_SUBDIVISION_CUTS,
  unwrapBox,
  unwrapPlanar,
} from "../editableGeometry.js";

const MODES = ["vertex", "edge", "face"];
const MODE_LABELS = { vertex: "Vertex", edge: "Edge", face: "Face" };
const WIRE_COLOR = 0x22272b;
const SELECT_COLOR = 0xff9b42;
// Blender draws unselected vertices as small dark dots; selected ones barely larger.
const VERTEX_PIXEL_RADIUS = 1.5;
const SELECTED_VERTEX_PIXEL_RADIUS = 2;
const positionKey = (point) => point.map((value) => Math.round(value * 1e5)).join(",");
const edgeKey = (editable, a, b) => [positionKey(editable.positions[a]), positionKey(editable.positions[b])].sort().join("|");
const indexEdgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const materialSlotLabel = (path, index) => {
  const filename = String(path ?? "").split(/[\\/]/).pop()?.replace(/\.mat$/i, "");
  return `Slot ${index + 1} · ${filename || "Unassigned"}`;
};

function reloadGeometryUsers(path) {
  for (const candidate of engine.entities.values()) {
    const mesh = candidate.getComponent?.("mesh");
    if (mesh?.props.geometryAsset === path) mesh.setProp("geometryAsset", path);
  }
}

/**
 * The render mesh is necessarily triangulated, but the edit topology is not: a
 * quad is two triangles whose shared diagonal is an implementation detail.
 *
 * Which edges are such artefacts is *remembered* — session.hiddenEdges, keyed by
 * vertex-index pair so it survives vertex moves — rather than re-derived from
 * coplanarity, because bending a quad must not make its diagonal pop into view.
 */
function logicalEdges(session) {
  const { editable, hiddenEdges } = session;
  const edges = new Map();
  editable.faces.forEach((face) => {
    for (let i = 0; i < 3; i++) {
      const a = face[i];
      const b = face[(i + 1) % 3];
      const key = edgeKey(editable, a, b);
      const entry = edges.get(key) ?? { a, b, hiddenDiagonal: true };
      // Seams duplicate vertices, so one logical edge can have several index
      // pairs. It only stays hidden while every one of them is an artefact.
      entry.hiddenDiagonal = entry.hiddenDiagonal && hiddenEdges.has(indexEdgeKey(a, b));
      edges.set(key, entry);
    }
  });
  (editable.looseEdges ?? []).forEach(([a, b]) => {
    if (!editable.positions[a] || !editable.positions[b]) return;
    edges.set(edgeKey(editable, a, b), { a, b, hiddenDiagonal: false, loose: true });
  });
  return edges;
}

const sessionEdges = (session) => session.cachedEdges ?? logicalEdges(session);

function visibleLogicalEdges(session) {
  if (!session.cachedVisibleEdges) {
    session.cachedVisibleEdges = new Map([...sessionEdges(session)].filter(([, edge]) => !edge.hiddenDiagonal));
  }
  return session.cachedVisibleEdges;
}

function logicalEdgeIncidence(session) {
  if (session.cachedEdgeIncidence) return session.cachedEdgeIncidence;
  const incidence = new Map();
  visibleLogicalEdges(session).forEach((edge, key) => {
    for (const index of [edge.a, edge.b]) {
      const vertex = positionKey(session.editable.positions[index]);
      if (!incidence.has(vertex)) incidence.set(vertex, []);
      incidence.get(vertex).push({ key, edge });
    }
  });
  session.cachedEdgeIncidence = incidence;
  return incidence;
}

/** Snapshots the edge set and its hidden flags in position space, before an operation. */
function topologySnapshot(session) {
  const { editable, hiddenEdges } = session;
  const edges = new Set();
  const hidden = new Set();
  editable.faces.forEach((face) => {
    for (let i = 0; i < 3; i++) {
      const a = face[i];
      const b = face[(i + 1) % 3];
      const key = edgeKey(editable, a, b);
      edges.add(key);
      if (hiddenEdges.has(indexEdgeKey(a, b))) hidden.add(key);
    }
  });
  return { edges, hidden };
}

/**
 * Re-keys the hidden set after an operation rebuilt the topology. Surviving edges
 * keep the flag they had; edges the operation invented are artefacts when they
 * are coplanar and the operation did not declare them visible. An operation that
 * knows its own answer (subdivision) hands the whole set over as `hidden`.
 */
function applyTopology(session, before, result = {}) {
  const { editable } = session;
  const coplanar = result.hidden ? null : coplanarHiddenEdges(editable);
  const hidden = new Set();
  editable.faces.forEach((face) => {
    for (let i = 0; i < 3; i++) {
      const a = face[i];
      const b = face[(i + 1) % 3];
      const key = edgeKey(editable, a, b);
      const isHidden = result.hidden ? result.hidden.has(key)
        : before.edges.has(key) ? before.hidden.has(key)
          : !result.visible?.has(key) && coplanar.has(key);
      if (isHidden) hidden.add(indexEdgeKey(a, b));
    }
  });
  session.hiddenEdges = hidden;
}

function logicalEdgeLoop(session, seedKey) {
  const { editable } = session;
  const edges = visibleLogicalEdges(session);
  const seed = edges.get(seedKey);
  if (!seed) return new Set();
  const adjacency = logicalEdgeIncidence(session);
  const selected = new Set([seedKey]);
  const walk = (previousIndex, currentIndex) => {
    // Non-manifold meshes can branch back through positional welds. Keep a
    // strict topology-sized budget so modifier loop selection (Shift+Alt) can
    // never spin forever on malformed/imported geometry.
    for (let step = 0; step < edges.size; step++) {
      const currentKey = positionKey(editable.positions[currentIndex]);
      const incoming = new THREE.Vector3(...editable.positions[currentIndex]).sub(new THREE.Vector3(...editable.positions[previousIndex])).normalize();
      const candidates = (adjacency.get(currentKey) ?? []).filter(({ key }) => !selected.has(key)).map(({ key, edge }) => {
        const nextIndex = positionKey(editable.positions[edge.a]) === currentKey ? edge.b : edge.a;
        const outgoing = new THREE.Vector3(...editable.positions[nextIndex]).sub(new THREE.Vector3(...editable.positions[currentIndex])).normalize();
        return { key, nextIndex, score: incoming.dot(outgoing) };
      }).sort((a, b) => b.score - a.score);
      if (!candidates.length || candidates[0].score < 0.35) break;
      selected.add(candidates[0].key);
      previousIndex = currentIndex;
      currentIndex = candidates[0].nextIndex;
    }
  };
  walk(seed.a, seed.b);
  walk(seed.b, seed.a);
  return selected;
}

function setPositions(geometry, positions) {
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
}

function setVertexMarkers(markers, points, session, pixelRadius) {
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const viewportHeight = Math.max(session.canvas.clientHeight, 1);
  const perspectiveScale = 2 * Math.tan(THREE.MathUtils.degToRad(session.camera.fov * 0.5)) / viewportHeight;
  markers.userData.markerPoints = points;
  markers.userData.pixelRadius = pixelRadius;
  markers.count = Math.min(points.length, markers.instanceMatrix.count);
  for (let index = 0; index < markers.count; index++) {
    const point = new THREE.Vector3(...points[index]);
    const size = Math.max(session.camera.position.distanceTo(point) * perspectiveScale * pixelRadius, 0.00001);
    scale.setScalar(size);
    matrix.compose(point, rotation, scale);
    markers.setMatrixAt(index, matrix);
  }
  markers.instanceMatrix.needsUpdate = true;
  markers.computeBoundingSphere();
}

function refreshVertexMarkerScales(session) {
  [session.basePoints, session.vertexOverlay].forEach((markers) => {
    setVertexMarkers(markers, markers.userData.markerPoints ?? [], session, markers.userData.pixelRadius ?? VERTEX_PIXEL_RADIUS);
  });
}

/** Rebuilds the wireframe line list and caches its edge order for recolouring. */
function refreshWire(session) {
  const { editable, wire } = session;
  session.wireEdges = [...sessionEdges(session).values()].filter((edge) => !edge.hiddenDiagonal);
  setPositions(wire.geometry, session.wireEdges.flatMap((edge) => [...editable.positions[edge.a], ...editable.positions[edge.b]]));
  refreshWireColors(session);
}

/**
 * Blender fades an edge from the selection colour at a selected vertex to the
 * plain wire colour at the far end, so a vertex selection reads at a glance.
 */
function refreshWireColors(session) {
  const { editable, wire, selections, mode } = session;
  const edges = session.wireEdges ?? [];
  const colors = new Float32Array(edges.length * 6);
  const base = new THREE.Color(WIRE_COLOR);
  const selected = new THREE.Color(SELECT_COLOR);
  edges.forEach((edge, index) => {
    const endpoints = mode === "vertex"
      ? [edge.a, edge.b].map((vertex) => (selections.vertex.has(positionKey(editable.positions[vertex])) ? selected : base))
      : [base, base];
    endpoints.forEach((color, side) => color.toArray(colors, index * 6 + side * 3));
  });
  wire.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function updateTopologyCache(session) {
  session.cachedEdges = logicalEdges(session);
  session.cachedVertices = new Map(session.editable.positions.map((position) => [positionKey(position), position]));
  session.cachedVisibleEdges = null;
  session.cachedEdgeIncidence = null;
  session.cachedFaceTopology = null;
  session.cachedPathGraphs = null;
}

function applyXray(session) {
  const materials = Array.isArray(session.mesh.material) ? session.mesh.material : [session.mesh.material];
  materials.forEach((material) => {
    material.transparent = session.xray;
    material.opacity = session.xray ? 0.38 : 1;
    material.depthWrite = !session.xray;
    material.needsUpdate = true;
  });
  [session.basePoints, session.vertexOverlay].forEach((markers) => {
    if (!markers?.material) return;
    markers.material.depthTest = !session.xray;
    markers.material.needsUpdate = true;
  });
}

function screenPosition(point, camera, rect) {
  const projected = point.clone().project(camera);
  return new THREE.Vector2(
    (projected.x + 1) * rect.width * 0.5 + rect.left,
    (-projected.y + 1) * rect.height * 0.5 + rect.top,
  );
}

function pointInSelectionRegion(point, gesture) {
  if (gesture.kind === "circle") return point.distanceToSquared(new THREE.Vector2(gesture.current.x, gesture.current.y)) <= gesture.radius ** 2;
  const left = Math.min(gesture.start.x, gesture.current.x);
  const right = Math.max(gesture.start.x, gesture.current.x);
  const top = Math.min(gesture.start.y, gesture.current.y);
  const bottom = Math.max(gesture.start.y, gesture.current.y);
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

function selectionPointVisible(session, localPoint) {
  if (session.xray) return true;
  const worldPoint = session.mesh.localToWorld(localPoint.clone());
  const projected = worldPoint.clone().project(session.camera);
  if (projected.z < -1 || projected.z > 1) return false;
  const raycaster = session.selectionRaycaster ??= new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(projected.x, projected.y), session.camera);
  const hit = raycaster.intersectObject(session.mesh, false)[0];
  if (!hit) return true;
  const targetDistance = raycaster.ray.origin.distanceTo(worldPoint);
  const tolerance = Math.max(targetDistance * 1e-4, 1e-5);
  return hit.distance + tolerance >= targetDistance;
}

/**
 * The triangles making up one logical polygon: flood fill across hidden diagonals
 * only. Coplanarity would split a quad in two the moment it is bent.
 */
function logicalFaceGroup(session, faceIndex) {
  const topology = logicalFaceTopology(session);
  const group = topology.groupOf.get(faceIndex);
  return group === undefined ? [] : topology.groups[group].faces;
}

function nearestVisibleFaceEdge(session, faceIndex, point) {
  const face = session.editable.faces[faceIndex];
  if (!face) return null;
  return face.map((a, index) => [a, face[(index + 1) % 3]])
    .map(([a, b]) => ({ a, b, key: edgeKey(session.editable, a, b), edge: sessionEdges(session).get(edgeKey(session.editable, a, b)) }))
    .filter(({ edge }) => edge && !edge.hiddenDiagonal)
    .map((entry) => ({ ...entry, distance: new THREE.Line3(
      new THREE.Vector3(...session.editable.positions[entry.a]),
      new THREE.Vector3(...session.editable.positions[entry.b]),
    ).closestPointToPoint(point, true, new THREE.Vector3()).distanceToSquared(point) }))
    .sort((a, b) => a.distance - b.distance)[0] ?? null;
}

function logicalFaceTopology(session) {
  if (session.cachedFaceTopology) return session.cachedFaceTopology;
  const { editable } = session;
  const edges = sessionEdges(session);
  const edgeFaces = new Map();
  editable.faces.forEach((face, faceIndex) => {
    for (let edge = 0; edge < 3; edge++) {
      const key = edgeKey(editable, face[edge], face[(edge + 1) % 3]);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(faceIndex);
    }
  });
  const groupOf = new Map();
  const groups = [];
  editable.faces.forEach((_, faceIndex) => {
    if (groupOf.has(faceIndex)) return;
    const id = groups.length;
    const faces = [];
    const queue = [faceIndex];
    groupOf.set(faceIndex, id);
    while (queue.length) {
      const current = queue.pop();
      faces.push(current);
      const face = editable.faces[current];
      for (let edge = 0; edge < 3; edge++) {
        const key = edgeKey(editable, face[edge], face[(edge + 1) % 3]);
        if (!edges.get(key)?.hiddenDiagonal) continue;
        for (const neighbour of edgeFaces.get(key) ?? []) {
          if (groupOf.has(neighbour)) continue;
          groupOf.set(neighbour, id);
          queue.push(neighbour);
        }
      }
    }
    groups.push({ faces, edges: [] });
  });
  const edgeGroups = new Map();
  groups.forEach((group, groupId) => {
    const keys = new Set();
    group.faces.forEach((faceIndex) => {
      const face = editable.faces[faceIndex];
      face.forEach((a, edge) => {
        const key = edgeKey(editable, a, face[(edge + 1) % 3]);
        if (!edges.get(key)?.hiddenDiagonal) keys.add(key);
      });
    });
    group.edges = [...keys];
    group.edges.forEach((key) => {
      if (!edgeGroups.has(key)) edgeGroups.set(key, []);
      edgeGroups.get(key).push(groupId);
    });
  });
  session.cachedFaceTopology = { groupOf, groups, edgeGroups };
  return session.cachedFaceTopology;
}

function logicalFaceLoop(session, faceIndex, seedEdgeKey) {
  const topology = logicalFaceTopology(session);
  const seedGroup = topology.groupOf.get(faceIndex);
  if (seedGroup === undefined) return new Set();
  const selected = new Set([seedGroup]);
  const opposite = (groupId, incoming) => {
    const edges = topology.groups[groupId].edges;
    if (edges.length !== 4) return null;
    const incomingEdge = sessionEdges(session).get(incoming);
    if (!incomingEdge) return null;
    const endpoints = new Set([positionKey(session.editable.positions[incomingEdge.a]), positionKey(session.editable.positions[incomingEdge.b])]);
    return edges.find((key) => {
      if (key === incoming) return false;
      const edge = sessionEdges(session).get(key);
      return edge && !endpoints.has(positionKey(session.editable.positions[edge.a])) && !endpoints.has(positionKey(session.editable.positions[edge.b]));
    }) ?? null;
  };
  const walkAcross = (edgeKeyValue) => {
    let previous = seedGroup;
    let edge = edgeKeyValue;
    for (let step = 0; step < topology.groups.length; step++) {
      const next = (topology.edgeGroups.get(edge) ?? []).find((id) => id !== previous);
      if (next === undefined || selected.has(next)) break;
      selected.add(next);
      const nextEdge = opposite(next, edge);
      if (!nextEdge) break;
      previous = next;
      edge = nextEdge;
    }
  };
  walkAcross(seedEdgeKey);
  const other = opposite(seedGroup, seedEdgeKey);
  if (other) walkAcross(other);
  return new Set([...selected].flatMap((id) => topology.groups[id].faces));
}

function loopSelectionAtHit(session, hit) {
  const nearest = nearestVisibleFaceEdge(session, hit.faceIndex, hit.point);
  if (!nearest) return new Set();
  if (session.mode === "edge") return logicalEdgeLoop(session, nearest.key);
  if (session.mode === "vertex") {
    const vertices = new Set();
    logicalEdgeLoop(session, nearest.key).forEach((key) => {
      const edge = sessionEdges(session).get(key);
      if (edge) { vertices.add(positionKey(session.editable.positions[edge.a])); vertices.add(positionKey(session.editable.positions[edge.b])); }
    });
    return vertices;
  }
  return logicalFaceLoop(session, hit.faceIndex, nearest.key);
}

function shortestPathGraph(session, mode) {
  session.cachedPathGraphs ??= {};
  if (session.cachedPathGraphs[mode]) return session.cachedPathGraphs[mode];
  const adjacency = new Map();
  const connect = (a, b) => {
    if (a === b) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  };
  let nodes;
  if (mode === "vertex") {
    nodes = new Set(session.editable.positions.map(positionKey));
    visibleLogicalEdges(session).forEach((edge) => connect(
      positionKey(session.editable.positions[edge.a]),
      positionKey(session.editable.positions[edge.b]),
    ));
  } else if (mode === "edge") {
    nodes = new Set(visibleLogicalEdges(session).keys());
    logicalEdgeIncidence(session).forEach((entries) => {
      for (let first = 0; first < entries.length; first++) {
        for (let second = first + 1; second < entries.length; second++) connect(entries[first].key, entries[second].key);
      }
    });
  } else {
    const topology = logicalFaceTopology(session);
    nodes = new Set(topology.groups.map((_, id) => id));
    topology.edgeGroups.forEach((groups) => {
      for (let first = 0; first < groups.length; first++) {
        for (let second = first + 1; second < groups.length; second++) connect(groups[first], groups[second]);
      }
    });
  }
  session.cachedPathGraphs[mode] = { nodes, adjacency };
  return session.cachedPathGraphs[mode];
}

function shortestSelectionPath(session, targets) {
  const selected = session.selections[session.mode];
  if (!selected.size || !targets.length) return new Set(targets);
  const { nodes, adjacency } = shortestPathGraph(session, session.mode);
  let normalizeTarget = (value) => value;
  let expandResult = (values) => values;
  if (session.mode === "face") {
    const topology = logicalFaceTopology(session);
    normalizeTarget = (faceIndex) => topology.groupOf.get(faceIndex);
    expandResult = (values) => values.flatMap((id) => topology.groups[id]?.faces ?? []);
  }
  const starts = [...selected].map(normalizeTarget).filter((value) => value !== undefined);
  const goal = normalizeTarget(targets[0]);
  if (goal === undefined) return new Set(targets);
  const queue = [...new Set(starts)];
  const previous = new Map(queue.map((value) => [value, null]));
  for (let head = 0; head < queue.length && !previous.has(goal); head++) {
    const current = queue[head];
    for (const next of adjacency.get(current) ?? []) {
      if (!nodes.has(next) || previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  if (!previous.has(goal)) return new Set(targets);
  const path = [];
  for (let current = goal; current !== null; current = previous.get(current)) path.push(current);
  return new Set(expandResult(path));
}

function pickRegion(session, gesture) {
  const rect = session.canvas.getBoundingClientRect();
  const selected = new Set();
  if (session.mode === "vertex") {
    const unique = new Map(session.editable.positions.map((position) => [positionKey(position), position]));
    unique.forEach((position, key) => {
      const point = new THREE.Vector3(...position);
      if (selectionPointVisible(session, point) && pointInSelectionRegion(screenPosition(point, session.camera, rect), gesture)) selected.add(key);
    });
  } else if (session.mode === "edge") {
    sessionEdges(session).forEach((edge, key) => {
      if (edge.hiddenDiagonal) return;
      const midpoint = new THREE.Vector3(...session.editable.positions[edge.a]).add(new THREE.Vector3(...session.editable.positions[edge.b])).multiplyScalar(0.5);
      if (selectionPointVisible(session, midpoint) && pointInSelectionRegion(screenPosition(midpoint, session.camera, rect), gesture)) selected.add(key);
    });
  } else {
    session.editable.faces.forEach((face, index) => {
      const center = face.reduce((sum, vertex) => sum.add(new THREE.Vector3(...session.editable.positions[vertex])), new THREE.Vector3()).multiplyScalar(1 / face.length);
      if (selectionPointVisible(session, center) && pointInSelectionRegion(screenPosition(center, session.camera, rect), gesture)) {
        logicalFaceGroup(session, index).forEach((faceIndex) => selected.add(faceIndex));
      }
    });
  }
  return selected;
}

function applyRegionSelection(session, gesture) {
  const selected = pickRegion(session, gesture);
  const selection = session.selections[session.mode];
  selected.forEach((key) => {
    if (gesture.subtractive) selection.delete(key);
    else selection.add(key);
  });
  refreshOverlays(session);
}

function refreshOverlays(session) {
  const { editable, selections, faceOverlay, edgeOverlay, vertexOverlay, basePoints } = session;
  const facePositions = [...selections.face].flatMap((index) =>
    editable.faces[index]?.flatMap((vertex) => editable.positions[vertex]) ?? [],
  );
  setPositions(faceOverlay.geometry, facePositions);
  faceOverlay.visible = session.mode === "face" && facePositions.length > 0;

  const edges = sessionEdges(session);
  const edgePositions = [...selections.edge].flatMap((key) => {
    const edge = edges.get(key);
    return edge ? [...editable.positions[edge.a], ...editable.positions[edge.b]] : [];
  });
  setPositions(edgeOverlay.geometry, edgePositions);
  edgeOverlay.visible = session.mode === "edge" && edgePositions.length > 0;

  const uniquePositions = session.cachedVertices ?? new Map(editable.positions.map((position) => [positionKey(position), position]));
  setVertexMarkers(basePoints, [...uniquePositions.values()], session, VERTEX_PIXEL_RADIUS);
  const vertexPositions = [...selections.vertex].map((key) => uniquePositions.get(key)).filter(Boolean);
  setVertexMarkers(vertexOverlay, vertexPositions, session, SELECTED_VERTEX_PIXEL_RADIUS);
  vertexOverlay.visible = session.mode === "vertex" && vertexPositions.length > 0;
  basePoints.visible = session.mode === "vertex";
  refreshWireColors(session);
}

function pickElement(session, hit) {
  const { editable, mode } = session;
  const faceIndex = hit.faceIndex;
  const face = editable.faces[faceIndex];
  if (!face) return [];
  if (mode === "face") return logicalFaceGroup(session, faceIndex);
  if (mode === "vertex") {
    const closest = face.reduce((best, index) => {
      const distance = hit.point.distanceToSquared(new THREE.Vector3(...editable.positions[index]));
      return distance < best.distance ? { index, distance } : best;
    }, { index: face[0], distance: Infinity });
    return [positionKey(editable.positions[closest.index])];
  }
  const closest = face.map((a, i) => [a, face[(i + 1) % 3]])
    .filter(([a, b]) => !sessionEdges(session).get(edgeKey(editable, a, b))?.hiddenDiagonal)
    .map(([a, b]) => {
      const line = new THREE.Line3(new THREE.Vector3(...editable.positions[a]), new THREE.Vector3(...editable.positions[b]));
      return { key: edgeKey(editable, a, b), distance: line.closestPointToPoint(hit.point, true, new THREE.Vector3()).distanceToSquared(hit.point) };
    }).sort((a, b) => a.distance - b.distance)[0];
  return closest ? [closest.key] : [];
}

function cloneSelections(selections) {
  return { vertex: new Set(selections.vertex), edge: new Set(selections.edge), face: new Set(selections.face) };
}

function previewLoopCut(session) {
  const macro = session.macro;
  const rect = session.canvas.getBoundingClientRect();
  const toScreen = (point) => {
    const projected = point.clone().project(session.camera);
    return new THREE.Vector2((projected.x + 1) * rect.width * 0.5 + rect.left, (-projected.y + 1) * rect.height * 0.5 + rect.top);
  };
  const a2 = toScreen(macro.edgeStart);
  const b2 = toScreen(macro.edgeEnd);
  const edge2 = b2.clone().sub(a2);
  const pointer = new THREE.Vector2(macro.current.x, macro.current.y);
  const t = THREE.MathUtils.clamp(pointer.sub(a2).dot(edge2) / Math.max(edge2.lengthSq(), 1), 0.02, 0.98);
  // Placement phase is always evenly spaced. The first click establishes the
  // edge-slide origin; only subsequent pointer movement offsets the cuts.
  const slide = macro.locked ? t - (macro.lockT ?? t) : 0;
  Object.assign(session.editable, cloneEditable(macro.before));
  session.hiddenEdges = new Set(macro.beforeHidden);
  const segments = Math.max(1, macro.segments ?? 1);
  const cutFactors = [];
  for (let index = 0; index < segments; index++) {
    const evenlySpaced = (index + 1) / (segments + 1);
    const cutT = THREE.MathUtils.clamp(evenlySpaced + slide, 0.02, 0.98);
    cutFactors.push(cutT);
  }
  const result = cutMeshByEdgeRing(
    session.editable,
    [macro.edgeStart.toArray(), macro.edgeEnd.toArray()],
    cutFactors,
    macro.beforeTopology.hidden,
  );
  // A cut ring lies flat in the face it crosses: it is a real edge only because
  // the cut says so, never because of geometry.
  applyTopology(session, macro.beforeTopology, { hidden: new Set(result.hiddenKeys) });
  session.selections.edge = new Set(result.edgeKeys);
  macro.t = t;
  session.rebuild();
}

function selectedVertexIndices(session, mode = session.mode) {
  const { editable, selections } = session;
  const indices = new Set();
  if (mode === "face") {
    for (const faceIndex of selections.face) editable.faces[faceIndex]?.forEach((index) => indices.add(index));
  } else if (mode === "vertex") {
    editable.positions.forEach((position, index) => {
      if (selections.vertex.has(positionKey(position))) indices.add(index);
    });
  } else {
    sessionEdges(session).forEach((edge, key) => {
      if (selections.edge.has(key)) { indices.add(edge.a); indices.add(edge.b); }
    });
  }
  return expandLogicalVertices(editable, [...indices]);
}

function syncTransformedSelection(session, macro) {
  if (session.mode === "vertex") {
    session.selections.vertex = new Set(macro.indices.map((index) => positionKey(session.editable.positions[index])));
  } else if (session.mode === "edge") {
    session.selections.edge = new Set(macro.edges.map(([a, b]) => edgeKey(session.editable, a, b)));
  }
}

function applyTransformMacro(session) {
  const macro = session.macro;
  if (!macro) return;
  if (macro.kind === "loopcut") { previewLoopCut(session); return; }
  if (macro.kind === "inset") {
    const dx = macro.current.x - macro.start.x;
    const dy = macro.current.y - macro.start.y;
    const numeric = macro.buffer && macro.buffer !== "." ? Number(macro.buffer) : null;
    const amount = numeric !== null && Number.isFinite(numeric)
      ? THREE.MathUtils.clamp(Math.abs(numeric), 0.001, 0.999)
      : THREE.MathUtils.clamp((dx - dy) * 0.005, 0.001, 0.999);
    Object.assign(session.editable, cloneEditable(macro.before));
    session.hiddenEdges = new Set(macro.beforeHidden);
    const inner = insetFaces(session.editable, macro.faceIndices, amount);
    session.selections.face = new Set(inner);
    applyTopology(session, macro.beforeTopology, { visible: new Set(inner.visibleEdgeKeys ?? []) });
    macro.amount = amount;
    session.rebuild();
    return;
  }
  if (macro.kind === "bevel") {
    const dx = macro.current.x - macro.start.x;
    const dy = macro.current.y - macro.start.y;
    const numeric = macro.buffer && macro.buffer !== "-" && macro.buffer !== "." ? Number(macro.buffer) : null;
    const amount = numeric !== null && Number.isFinite(numeric)
      ? THREE.MathUtils.clamp(Math.abs(numeric), 0.001, 0.45)
      : THREE.MathUtils.clamp(macro.initialAmount + (dx - dy) * 0.0015, 0.001, 0.45);
    Object.assign(session.editable, cloneEditable(macro.before));
    session.hiddenEdges = new Set(macro.beforeHidden);
    bevelEdges(session.editable, macro.edgeKeys, amount, macro.segments);
    applyTopology(session, macro.beforeTopology);
    session.selections.edge.clear();
    macro.amount = amount;
    session.rebuild();
    return;
  }
  const { kind, axis, buffer, start, current, pivot, indices, positions } = macro;
  const numeric = buffer && buffer !== "-" && buffer !== "." ? Number(buffer) : null;
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const camera = session.camera;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const viewAxis = camera.getWorldDirection(new THREE.Vector3()).normalize();
  const axisVector = axis ? new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0) : null;
  const worldPerPixel = Math.max(camera.position.distanceTo(session.controls.target), 0.1) / 800;
  let translation = new THREE.Vector3();
  let angle = 0;
  let factor = 1;
  if (kind === "translate") {
    if (numeric !== null && Number.isFinite(numeric)) translation.copy(axisVector ?? right).multiplyScalar(numeric);
    else if (axisVector) translation.copy(axisVector).multiplyScalar((dx - dy) * worldPerPixel);
    else translation.copy(right).multiplyScalar(dx * worldPerPixel).addScaledVector(up, -dy * worldPerPixel);
  } else if (kind === "rotate") {
    angle = numeric !== null && Number.isFinite(numeric) ? THREE.MathUtils.degToRad(numeric) : (dx - dy) * 0.01;
  } else if (kind === "extrude") {
    const extrusionAxis = axisVector ?? new THREE.Vector3(...macro.normal);
    if (numeric !== null && Number.isFinite(numeric)) {
      translation.copy(extrusionAxis).multiplyScalar(numeric);
    } else {
      const projected = dx * extrusionAxis.dot(right) - dy * extrusionAxis.dot(up);
      const screenDistance = Math.abs(extrusionAxis.dot(right)) + Math.abs(extrusionAxis.dot(up)) > 0.08
        ? projected
        : dx - dy;
      translation.copy(extrusionAxis).multiplyScalar(screenDistance * worldPerPixel);
    }
  } else {
    factor = numeric !== null && Number.isFinite(numeric) ? numeric : Math.max(0.001, 1 + (dx - dy) * 0.01);
  }
  const rotationAxis = axisVector ?? viewAxis;
  const quaternion = new THREE.Quaternion().setFromAxisAngle(rotationAxis, angle);
  const selectedKeys = new Set(indices.map((index) => positionKey(macro.allPositions[index])));
  const transformIndices = macro.proportional ? macro.allPositions.map((_, index) => index) : indices;
  transformIndices.forEach((index, i) => {
    const point = (macro.proportional ? new THREE.Vector3(...macro.allPositions[index]) : positions[i]).clone();
    let weight = 1;
    if (macro.proportional && !selectedKeys.has(positionKey(macro.allPositions[index]))) {
      const distance = Math.min(...indices.map((selectedIndex) => point.distanceTo(new THREE.Vector3(...macro.allPositions[selectedIndex]))));
      const normalized = THREE.MathUtils.clamp(distance / Math.max(macro.radius, 0.0001), 0, 1);
      weight = normalized >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * normalized);
    }
    if (kind === "translate") point.add(translation);
    if (kind === "extrude") point.add(translation);
    if (kind === "rotate") point.sub(pivot).applyQuaternion(quaternion).add(pivot);
    if (kind === "scale") {
      point.sub(pivot);
      const weightedFactor = THREE.MathUtils.lerp(1, factor, weight);
      if (axis) {
        if (axis === "x") point.x *= weightedFactor;
        if (axis === "y") point.y *= weightedFactor;
        if (axis === "z") point.z *= weightedFactor;
      } else point.multiplyScalar(weightedFactor);
      point.add(pivot);
    }
    if (weight !== 1 && (kind === "translate" || kind === "extrude")) point.sub(translation).addScaledVector(translation, weight);
    if (weight !== 1 && kind === "rotate") {
      const weightedQuaternion = new THREE.Quaternion().setFromAxisAngle(rotationAxis, angle * weight);
      point.copy((macro.proportional ? new THREE.Vector3(...macro.allPositions[index]) : positions[i])).sub(pivot).applyQuaternion(weightedQuaternion).add(pivot);
    }
    session.editable.positions[index] = point.toArray();
  });
  syncTransformedSelection(session, macro);
  session.preview();
}

function hasEditorOnlyAncestor(object) {
  let current = object;
  while (current) {
    if (current.userData?.editorOnly) return true;
    current = current.parent;
  }
  return false;
}

export function GeometryEditorPanel({ embedded = false, entityIdOverride = null, initialView = null, onClose = null } = {}) {
  const selectedEntityId = useSelectionStore((state) => state.ids[0] ?? null);
  const entityId = entityIdOverride ?? selectedEntityId;
  const rootRef = useRef(null);
  const hostRef = useRef(null);
  const sessionRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve());
  const [mode, setMode] = useState("face");
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("");
  const [macroState, setMacroState] = useState(null);
  const [showSceneContext, setShowSceneContext] = useState(embedded);
  const [proportional, setProportional] = useState(false);
  const [xray, setXray] = useState(false);
  const [selectionTool, setSelectionTool] = useState(null);
  const [selectionGesture, setSelectionGesture] = useState(null);
  const [faceMaterial, setFaceMaterial] = useState(0);
  const [cuts, setCuts] = useState(1);
  const entity = entityId ? engine.getEntity(entityId) : null;
  const component = entity?.getComponent("mesh");

  useEffect(() => {
    if (sessionRef.current?.context) sessionRef.current.context.visible = showSceneContext;
  }, [showSceneContext]);

  const changeMode = (next) => {
    const session = sessionRef.current;
    if (session) {
      const selectedVertices = new Set(selectedVertexIndices(session).map((index) => positionKey(session.editable.positions[index])));
      const nextSelection = new Set();
      if (next === "vertex") {
        selectedVertices.forEach((key) => nextSelection.add(key));
      } else if (next === "edge") {
        visibleLogicalEdges(session).forEach((edge, key) => {
          if (selectedVertices.has(positionKey(session.editable.positions[edge.a])) && selectedVertices.has(positionKey(session.editable.positions[edge.b]))) nextSelection.add(key);
        });
      } else {
        session.editable.faces.forEach((face, index) => {
          if (face.every((vertex) => selectedVertices.has(positionKey(session.editable.positions[vertex])))) nextSelection.add(index);
        });
      }
      session.selections[next] = nextSelection;
      session.mode = next;
      refreshOverlays(session);
    }
    setMode(next);
    setRevision((value) => value + 1);
  };

  const clearSelection = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.selections[session.mode].clear();
    refreshOverlays(session);
    setRevision((value) => value + 1);
  };

  const toggleProportional = () => {
    const next = !sessionRef.current?.proportional;
    if (sessionRef.current) sessionRef.current.proportional = next;
    setProportional(next);
  };

  const toggleXray = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.xray = !session.xray;
    applyXray(session);
    setXray(session.xray);
  };

  const armSelectionTool = (kind) => {
    const session = sessionRef.current;
    if (!session || session.macro) return;
    session.selectionTool = session.selectionTool === kind ? null : kind;
    setSelectionTool(session.selectionTool);
    session.canvas.focus();
  };

  const cancelSelectionTool = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.selectionTool = null;
    session.selectionGesture = null;
    session.controls.enabled = true;
    setSelectionTool(null);
    setSelectionGesture(null);
  };

  const autosaveGeometry = (session = sessionRef.current) => {
    if (!session || !entityId) return;
    // Snapshot now, then serialize writes. A quick sequence of edits must not
    // let an older asynchronous write finish after a newer one.
    const contents = JSON.stringify(geometryAssetFromEditable(session.editable), null, 2);
    // Update Object Mode immediately. Disk persistence and shared-asset reloads
    // can finish afterward without making Tab-out appear to discard the edit.
    const liveMesh = engine.getEntity(entityId)?.getComponent("mesh")?.mesh;
    if (liveMesh) {
      const previous = liveMesh.geometry;
      liveMesh.geometry = bufferGeometryFromEditable(session.editable);
      previous?.dispose?.();
    }
    setStatus("Autosaving geometry...");
    saveQueueRef.current = saveQueueRef.current.catch(() => {}).then(async () => {
      const path = await ensureGeometryAsset(entityId);
      if (!path) throw new Error("Geometry asset is unavailable");
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_scene", { path, contents });
      invalidateBlobUrl(path);
      reloadGeometryUsers(path);
      if (rootRef.current) setStatus(`Autosaved ${path.split(/[\\/]/).pop()}`);
    }).catch((error) => {
      if (rootRef.current) setStatus(`Autosave failed: ${error}`);
    });
  };

  const mutate = (operation) => {
    const session = sessionRef.current;
    if (!session) return;
    session.history.push({ editable: cloneEditable(session.editable), selections: cloneSelections(session.selections), hiddenEdges: new Set(session.hiddenEdges) });
    const before = topologySnapshot(session);
    const result = operation(session, before) ?? {};
    applyTopology(session, before, result);
    session.rebuild();
    autosaveGeometry(session);
  };

  const undo = () => {
    const session = sessionRef.current;
    const previous = session?.history.pop();
    if (!previous) return;
    Object.assign(session.editable, previous.editable);
    session.selections = previous.selections;
    session.hiddenEdges = new Set(previous.hiddenEdges ?? []);
    session.rebuild();
    autosaveGeometry(session);
  };

  const startExtrude = () => {
    const session = sessionRef.current;
    if (!session || session.mode !== "face" || !session.selections.face.size || session.macro) return;
    const before = cloneEditable(session.editable);
    const beforeSelections = cloneSelections(session.selections);
    const beforeHidden = new Set(session.hiddenEdges);
    const beforeTopology = topologySnapshot(session);
    const result = beginExtrudeFaces(session.editable, [...session.selections.face]);
    if (!result.vertexIndices.length) return;
    session.selections.face = new Set(result.faceIndices);
    const pointer = session.lastPointer ?? { x: 0, y: 0 };
    const positions = result.vertexIndices.map((index) => new THREE.Vector3(...session.editable.positions[index]));
    const pivot = positions.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / positions.length);
    session.macro = {
      kind: "extrude", axis: null, buffer: "", indices: result.vertexIndices, positions,
      allPositions: session.editable.positions.map((value) => [...value]), proportional: false, radius: 1,
      pivot,
      normal: result.normal, edges: [], before, beforeSelections,
      beforeHidden, beforeTopology, beforeMode: session.mode,
      start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    // The extruded walls are degenerate until the drag moves them, so their
    // hidden flags are re-derived on every preview frame, not just here.
    applyTopology(session, beforeTopology);
    session.rebuild();
    setMacroState({ kind: "extrude", axis: null, buffer: "" });
  };

  const startLoopCut = () => {
    const session = sessionRef.current;
    const hit = session?.raycastAtLast?.();
    if (!session || !hit || session.macro) return;
    const face = session.editable.faces[hit.faceIndex];
    const visible = visibleLogicalEdges(session);
    const candidates = face.map((a, index) => [a, face[(index + 1) % 3]])
      .filter(([a, b]) => visible.has(edgeKey(session.editable, a, b)))
      .map(([a, b]) => {
        const start = new THREE.Vector3(...session.editable.positions[a]);
        const end = new THREE.Vector3(...session.editable.positions[b]);
        const closest = new THREE.Line3(start, end).closestPointToPoint(hit.point, true, new THREE.Vector3());
        return { start, end, distance: closest.distanceToSquared(hit.point) };
      }).sort((a, b) => a.distance - b.distance);
    const edge = candidates[0];
    if (!edge) return;
    const pointer = session.lastPointer ?? { x: 0, y: 0 };
    const beforeMode = session.mode;
    session.mode = "edge";
    setMode("edge");
    session.macro = {
      kind: "loopcut", axis: null, buffer: "", indices: [], positions: [], edges: [],
      edgeStart: edge.start, edgeEnd: edge.end,
      edgeDirection: edge.end.clone().sub(edge.start).normalize(), seedFace: hit.faceIndex,
      segments: 1, locked: false,
      before: cloneEditable(session.editable), beforeSelections: cloneSelections(session.selections),
      beforeHidden: new Set(session.hiddenEdges), beforeTopology: topologySnapshot(session), beforeMode,
      pivot: new THREE.Vector3(), start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    applyTransformMacro(session);
    setMacroState({ kind: "loopcut", axis: null, buffer: "", segments: 1, locked: false });
  };

  const startTransform = (kind, options = {}) => {
    const session = sessionRef.current;
    const indices = session ? (options.indices ?? selectedVertexIndices(session)) : [];
    if (!session || !indices.length || session.macro) return;
    const pointer = session.lastPointer ?? { x: 0, y: 0 };
    const positions = indices.map((index) => new THREE.Vector3(...session.editable.positions[index]));
    const uniquePivotPoints = new Map(positions.map((point) => [positionKey(point.toArray()), point]));
    const pivot = [...uniquePivotPoints.values()].reduce((sum, point) => sum.add(point), new THREE.Vector3())
      .multiplyScalar(1 / uniquePivotPoints.size);
    const edges = options.edges ?? (session.mode === "edge"
      ? [...session.selections.edge].map((key) => {
          const edge = sessionEdges(session).get(key);
          return edge ? [edge.a, edge.b] : null;
        }).filter(Boolean)
      : []);
    const allPositions = session.editable.positions.map((value) => [...value]);
    const bounds = new THREE.Box3().setFromPoints(session.editable.positions.map((point) => new THREE.Vector3(...point)));
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.3, 0.25);
    session.macro = {
      kind, axis: null, buffer: "", indices, positions, allPositions, pivot, edges,
      proportional: session.proportional, radius,
      before: options.before ?? cloneEditable(session.editable),
      beforeSelections: options.beforeSelections ?? cloneSelections(session.selections),
      beforeHidden: options.beforeHidden ?? new Set(session.hiddenEdges),
      beforeTopology: options.beforeTopology ?? topologySnapshot(session), beforeMode: session.mode,
      start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    setMacroState({ kind, axis: null, buffer: "", proportional: session.proportional, radius });
  };

  const duplicateGeometrySelection = () => {
    const session = sessionRef.current;
    if (!session || session.macro || !session.selections[session.mode].size) return;
    const before = cloneEditable(session.editable);
    const beforeSelections = cloneSelections(session.selections);
    const beforeHidden = new Set(session.hiddenEdges);
    const beforeTopology = topologySnapshot(session);
    const selectedFaces = new Set();
    if (session.mode === "face") {
      session.selections.face.forEach((faceIndex) => selectedFaces.add(faceIndex));
    } else if (session.mode === "vertex") {
      session.editable.faces.forEach((face, faceIndex) => {
        if (face.every((index) => session.selections.vertex.has(positionKey(session.editable.positions[index])))) selectedFaces.add(faceIndex);
      });
    } else {
      // Duplicate a logical polygon when all of its visible boundary edges are selected.
      const topology = logicalFaceTopology(session);
      topology.groups.forEach((group) => {
        if (group.edges.length && group.edges.every((key) => session.selections.edge.has(key))) {
          group.faces.forEach((faceIndex) => selectedFaces.add(faceIndex));
        }
      });
    }
    const sourceIndices = new Set([...selectedFaces].flatMap((faceIndex) => session.editable.faces[faceIndex] ?? []));
    if (session.mode === "edge") {
      session.selections.edge.forEach((key) => {
        const edge = sessionEdges(session).get(key);
        if (edge) { sourceIndices.add(edge.a); sourceIndices.add(edge.b); }
      });
    }
    // Vertex mode can duplicate loose vertices too; the geometry asset retains
    // them even when no face currently references them.
    if (!sourceIndices.size && session.mode === "vertex") {
      session.editable.positions.forEach((position, index) => {
        if (session.selections.vertex.has(positionKey(position))) sourceIndices.add(index);
      });
    }
    if (!sourceIndices.size) return;
    const remap = new Map();
    sourceIndices.forEach((oldIndex) => {
      const next = session.editable.positions.length;
      remap.set(oldIndex, next);
      session.editable.positions.push([...session.editable.positions[oldIndex]]);
      if (session.editable.uvs.length) session.editable.uvs.push([...(session.editable.uvs[oldIndex] ?? [0, 0])]);
    });
    const duplicateFaces = [];
    selectedFaces.forEach((faceIndex) => {
      const face = session.editable.faces[faceIndex];
      if (!face?.every((index) => remap.has(index))) return;
      duplicateFaces.push(session.editable.faces.length);
      session.editable.faces.push(face.map((index) => remap.get(index)));
      session.editable.faceMaterials.push(session.editable.faceMaterials[faceIndex] ?? 0);
      face.forEach((a, edge) => {
        const b = face[(edge + 1) % 3];
        if (beforeHidden.has(indexEdgeKey(a, b))) session.hiddenEdges.add(indexEdgeKey(remap.get(a), remap.get(b)));
      });
    });
    const duplicateIndices = [...remap.values()];
    if (session.mode === "face") session.selections.face = new Set(duplicateFaces);
    if (session.mode === "vertex") session.selections.vertex = new Set(duplicateIndices.map((index) => positionKey(session.editable.positions[index])));
    let duplicateEdges = [];
    if (session.mode === "edge") {
      duplicateEdges = [...session.selections.edge].flatMap((key) => {
        const edge = sessionEdges(session).get(key);
        return edge && remap.has(edge.a) && remap.has(edge.b) ? [[remap.get(edge.a), remap.get(edge.b)]] : [];
      });
      session.selections.edge = new Set(duplicateEdges.map(([a, b]) => edgeKey(session.editable, a, b)));
      const faceEdgeKeys = new Set(duplicateFaces.flatMap((faceIndex) => {
        const face = session.editable.faces[faceIndex];
        return face.map((a, edge) => edgeKey(session.editable, a, face[(edge + 1) % 3]));
      }));
      session.editable.looseEdges ??= [];
      duplicateEdges.forEach(([a, b]) => {
        if (!faceEdgeKeys.has(edgeKey(session.editable, a, b))) session.editable.looseEdges.push([a, b]);
      });
    }
    session.rebuild();
    startTransform("translate", {
      indices: duplicateIndices,
      edges: duplicateEdges,
      before,
      beforeSelections,
      beforeHidden,
      beforeTopology,
    });
  };

  const cancelTransform = () => {
    const session = sessionRef.current;
    if (!session?.macro) return;
    Object.assign(session.editable, cloneEditable(session.macro.before));
    session.selections = cloneSelections(session.macro.beforeSelections);
    session.hiddenEdges = new Set(session.macro.beforeHidden ?? []);
    session.mode = session.macro.beforeMode ?? session.mode;
    setMode(session.mode);
    session.macro = null;
    session.controls.enabled = true;
    session.rebuild();
    setMacroState(null);
  };

  const commitTransform = () => {
    const session = sessionRef.current;
    if (!session?.macro) return;
    session.history.push({ editable: session.macro.before, selections: session.macro.beforeSelections, hiddenEdges: session.macro.beforeHidden ?? new Set() });
    session.macro = null;
    session.controls.enabled = true;
    session.rebuild();
    setMacroState(null);
    autosaveGeometry(session);
  };

  const selectAll = () => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.mode === "face") session.selections.face = new Set(session.editable.faces.map((_, index) => index));
    if (session.mode === "edge") session.selections.edge = new Set(visibleLogicalEdges(session).keys());
    if (session.mode === "vertex") session.selections.vertex = new Set(session.editable.positions.map(positionKey));
    refreshOverlays(session);
    setRevision((value) => value + 1);
  };

  const allSelection = (session) => {
    if (session.mode === 'face') return new Set(session.editable.faces.map((_, index) => index));
    if (session.mode === 'edge') return new Set(visibleLogicalEdges(session).keys());
    return new Set((session.cachedVertices ?? new Map(session.editable.positions.map((position) => [positionKey(position), position]))).keys());
  };

  const expandedSelection = (session, source) => {
    const expanded = new Set(source);
    const edges = sessionEdges(session);
    if (session.mode === 'vertex') {
      edges.forEach((edge) => {
        const a = positionKey(session.editable.positions[edge.a]);
        const b = positionKey(session.editable.positions[edge.b]);
        if (source.has(a) || source.has(b)) { expanded.add(a); expanded.add(b); }
      });
    } else if (session.mode === 'edge') {
      const vertices = new Set();
      source.forEach((key) => {
        const edge = edges.get(key);
        if (edge) { vertices.add(positionKey(session.editable.positions[edge.a])); vertices.add(positionKey(session.editable.positions[edge.b])); }
      });
      edges.forEach((edge, key) => {
        if (edge.hiddenDiagonal) return;
        if (vertices.has(positionKey(session.editable.positions[edge.a])) || vertices.has(positionKey(session.editable.positions[edge.b]))) expanded.add(key);
      });
    } else {
      const selectedEdges = new Set();
      source.forEach((faceIndex) => {
        const face = session.editable.faces[faceIndex];
        if (!face) return;
        for (let edge = 0; edge < 3; edge++) selectedEdges.add(edgeKey(session.editable, face[edge], face[(edge + 1) % 3]));
      });
      session.editable.faces.forEach((face, faceIndex) => {
        if (source.has(faceIndex)) return;
        const adjacent = face.some((vertex, edge) => selectedEdges.has(edgeKey(session.editable, vertex, face[(edge + 1) % 3])));
        if (adjacent) logicalFaceGroup(session, faceIndex).forEach((index) => expanded.add(index));
      });
    }
    return expanded;
  };

  const selectMore = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.selections[session.mode] = expandedSelection(session, session.selections[session.mode]);
    refreshOverlays(session);
    setRevision((value) => value + 1);
  };

  const selectLess = () => {
    const session = sessionRef.current;
    if (!session) return;
    const all = allSelection(session);
    const unselected = new Set([...all].filter((key) => !session.selections[session.mode].has(key)));
    const expandedUnselected = expandedSelection(session, unselected);
    session.selections[session.mode] = new Set([...all].filter((key) => !expandedUnselected.has(key)));
    refreshOverlays(session);
    setRevision((value) => value + 1);
  };

  const invertSelection = () => {
    const session = sessionRef.current;
    if (!session) return;
    const selection = session.selections[session.mode];
    session.selections[session.mode] = new Set([...allSelection(session)].filter((key) => !selection.has(key)));
    refreshOverlays(session);
    setRevision((value) => value + 1);
  };

  const deleteSelection = () => mutate((session) => {
    const remove = new Set();
    if (session.mode === "face") session.selections.face.forEach((index) => remove.add(index));
    session.editable.faces.forEach((face, faceIndex) => {
      if (session.mode === "vertex" && face.some((index) => session.selections.vertex.has(positionKey(session.editable.positions[index])))) remove.add(faceIndex);
      if (session.mode === "edge") {
        for (let edge = 0; edge < 3; edge++) {
          if (session.selections.edge.has(edgeKey(session.editable, face[edge], face[(edge + 1) % 3]))) remove.add(faceIndex);
        }
      }
    });
    if (session.mode === "edge") {
      session.editable.looseEdges = (session.editable.looseEdges ?? []).filter(([a, b]) => !session.selections.edge.has(edgeKey(session.editable, a, b)));
    }
    deleteFaces(session.editable, [...remove]);
    session.selections = { vertex: new Set(), edge: new Set(), face: new Set() };
  });

  const mergeSelection = () => mutate((session) => {
    const indices = selectedVertexIndices(session);
    mergeVerticesAtCenter(session.editable, indices);
    session.selections = { vertex: new Set(), edge: new Set(), face: new Set() };
    if (indices.length) session.selections.vertex.add(positionKey(session.editable.positions[indices[0]]));
    session.mode = 'vertex';
    setMode('vertex');
  });

  const startBevel = () => {
    const session = sessionRef.current;
    if (!session || session.mode !== "edge" || !session.selections.edge.size || session.macro) return;
    const pointer = session.lastPointer ?? { x: 0, y: 0 };
    session.macro = {
      kind: "bevel", axis: null, buffer: "", edgeKeys: [...session.selections.edge], segments: 1,
      initialAmount: 0.08, amount: 0.08,
      before: cloneEditable(session.editable), beforeSelections: cloneSelections(session.selections),
      beforeHidden: new Set(session.hiddenEdges), beforeTopology: topologySnapshot(session), beforeMode: session.mode,
      start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    applyTransformMacro(session);
    setMacroState({ kind: "bevel", axis: null, buffer: "", amount: 0.08, segments: 1 });
  };

  const subdivideSelection = () => mutate((session, before) => {
    const selectedFaces = new Set();
    const selection = session.selections[session.mode];
    const wasFaceMode = session.mode === "face";
    if (selection.size) {
      session.editable.faces.forEach((face, faceIndex) => {
        if (session.mode === "face" && selection.has(faceIndex)) selectedFaces.add(faceIndex);
        if (session.mode === "vertex" && face.some((index) => selection.has(positionKey(session.editable.positions[index])))) selectedFaces.add(faceIndex);
        if (session.mode === "edge" && face.some((a, edge) => selection.has(edgeKey(session.editable, a, face[(edge + 1) % 3])))) selectedFaces.add(faceIndex);
      });
    }
    const result = subdivideFaces(session.editable, [...selectedFaces], before.hidden, cuts);
    // Blender leaves the subdivided region selected so cuts can be stacked.
    session.selections = { vertex: new Set(), edge: new Set(), face: new Set() };
    if (wasFaceMode && selectedFaces.size) session.selections.face = new Set(result.faceIndices);
    setStatus(`Subdivided ${selectedFaces.size ? `${result.faceCount} selected faces` : "whole mesh"}${cuts > 1 ? ` (${cuts} cuts)` : ""}`);
    return { hidden: new Set(result.hiddenKeys) };
  });

  const startInset = () => {
    const session = sessionRef.current;
    if (!session || session.mode !== "face" || !session.selections.face.size || session.macro) return;
    const pointer = session.lastPointer ?? { x: 0, y: 0 };
    session.macro = {
      kind: "inset", axis: null, buffer: "", amount: 0.001,
      faceIndices: [...session.selections.face],
      before: cloneEditable(session.editable), beforeSelections: cloneSelections(session.selections),
      beforeHidden: new Set(session.hiddenEdges), beforeTopology: topologySnapshot(session), beforeMode: session.mode,
      start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    applyTransformMacro(session);
    setMacroState({ kind: "inset", axis: null, buffer: "", amount: session.macro.amount });
  };

  const assignMaterial = () => mutate((session) => {
    if (session.mode !== 'face' || !session.selections.face.size) return;
    assignFaceMaterial(session.editable, [...session.selections.face], faceMaterial);
  });

  const mirrorSelection = (axis) => mutate((session) => {
    const indices = selectedVertexIndices(session);
    if (!indices.length) return;
    const logicalPoints = new Map(indices.map((index) => [positionKey(session.editable.positions[index]), session.editable.positions[index]]));
    const pivot = [...logicalPoints.values()].reduce((sum, point) => sum.add(new THREE.Vector3(...point)), new THREE.Vector3())
      .multiplyScalar(1 / logicalPoints.size).toArray();
    mirrorVertices(session.editable, indices, axis, pivot);
    session.selections = { vertex: new Set(), edge: new Set(), face: new Set() };
  });

  const handleKeyDown = (event) => {
    if (!sessionRef.current?.macro && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateGeometrySelection();
      return;
    }
    if (event.target.closest("input, textarea, select")) return;
    // Edit mode owns its keyboard grammar. Prevent scene-level Delete,
    // duplicate, visibility and undo shortcuts from running as well.
    event.stopPropagation();
    if (sessionRef.current?.awaitingMirror) {
      const axis = event.key.toLowerCase();
      event.preventDefault();
      sessionRef.current.awaitingMirror = false;
      setStatus('');
      if (['x', 'y', 'z'].includes(axis)) mirrorSelection(axis);
      return;
    }
    if (!sessionRef.current?.macro && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      if (sessionRef.current) sessionRef.current.awaitingMirror = true;
      setStatus('Mirror: choose X, Y, or Z');
      return;
    }
    if (!sessionRef.current?.macro && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      startBevel();
      return;
    }
    if (!sessionRef.current?.macro && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      invertSelection();
      return;
    }
    if (!sessionRef.current?.macro && (event.ctrlKey || event.metaKey) && (event.code === 'NumpadAdd' || event.code === 'Equal' || event.key === '+')) {
      event.preventDefault();
      selectMore();
      return;
    }
    if (!sessionRef.current?.macro && (event.ctrlKey || event.metaKey) && (event.code === 'NumpadSubtract' || event.code === 'Minus' || event.key === '-')) {
      event.preventDefault();
      selectLess();
      return;
    }
    if (!sessionRef.current?.macro && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'i' && mode === 'face') {
      event.preventDefault();
      startInset();
      return;
    }
    if (!sessionRef.current?.macro && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      mergeSelection();
      return;
    }
    const activeMacro = sessionRef.current?.macro;
    if (activeMacro) {
      const key = event.key.toLowerCase();
      if (key === "escape") { event.preventDefault(); cancelTransform(); return; }
      if (key === "enter" || key === " ") { event.preventDefault(); commitTransform(); return; }
      if (activeMacro.kind === "loopcut") return;
      if (["bevel", "inset"].includes(activeMacro.kind) && !/^[0-9.]$/.test(key) && key !== "backspace") return;
      if (key === "o") {
        event.preventDefault();
        activeMacro.proportional = !activeMacro.proportional;
        sessionRef.current.proportional = activeMacro.proportional;
        setProportional(activeMacro.proportional);
        applyTransformMacro(sessionRef.current);
        setMacroState({ kind: activeMacro.kind, axis: activeMacro.axis, buffer: activeMacro.buffer, proportional: activeMacro.proportional, radius: activeMacro.radius });
        return;
      }
      if (["x", "y", "z"].includes(key)) {
        event.preventDefault();
        activeMacro.axis = activeMacro.axis === key ? null : key;
        applyTransformMacro(sessionRef.current);
        setMacroState({ kind: activeMacro.kind, axis: activeMacro.axis, buffer: activeMacro.buffer, amount: activeMacro.amount, segments: activeMacro.segments });
        return;
      }
      if (key === "backspace") {
        event.preventDefault();
        activeMacro.buffer = activeMacro.buffer.slice(0, -1);
        applyTransformMacro(sessionRef.current);
        setMacroState({ kind: activeMacro.kind, axis: activeMacro.axis, buffer: activeMacro.buffer, amount: activeMacro.amount, segments: activeMacro.segments });
        return;
      }
      if (/^[0-9.-]$/.test(key)) {
        if (key === "-" && activeMacro.buffer) return;
        if (key === "." && activeMacro.buffer.includes(".")) return;
        event.preventDefault();
        activeMacro.buffer += key;
        applyTransformMacro(sessionRef.current);
        setMacroState({ kind: activeMacro.kind, axis: activeMacro.axis, buffer: activeMacro.buffer, amount: activeMacro.amount, segments: activeMacro.segments });
      }
      return;
    }
    if (event.key.toLowerCase() === "escape" && (sessionRef.current?.selectionTool || sessionRef.current?.selectionGesture)) { event.preventDefault(); cancelSelectionTool(); return; }
    if (event.key.toLowerCase() === "b") { event.preventDefault(); armSelectionTool("box"); return; }
    if (event.key.toLowerCase() === "c") { event.preventDefault(); armSelectionTool("circle"); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") { event.preventDefault(); startLoopCut(); return; }
    if (event.ctrlKey && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); return; }
    if (["1", "2", "3"].includes(event.key)) { event.preventDefault(); changeMode(MODES[Number(event.key) - 1]); return; }
    if (event.key.toLowerCase() === "a") { event.preventDefault(); event.altKey ? clearSelection() : selectAll(); return; }
    if (event.key.toLowerCase() === "o") { event.preventDefault(); toggleProportional(); return; }
    if (event.altKey && event.key.toLowerCase() === "z") { event.preventDefault(); toggleXray(); return; }
    if (event.key === "Tab" && embedded && onClose) { event.preventDefault(); onClose(); return; }
    if (event.key.toLowerCase() === "e" && mode === "face") { event.preventDefault(); startExtrude(); return; }
    if (event.key.toLowerCase() === "u") { event.preventDefault(); mutate((session) => unwrapBox(session.editable)); }
    if (event.key.toLowerCase() === "g") { event.preventDefault(); startTransform("translate"); }
    if (event.key.toLowerCase() === "r") { event.preventDefault(); startTransform("rotate"); }
    if (event.key.toLowerCase() === "s") { event.preventDefault(); startTransform("scale"); }
    if (event.key.toLowerCase() === "x") { event.preventDefault(); deleteSelection(); }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deleteSelection(); }
  };

  // Consume Ctrl+R in the native capture phase. This runs before the webview's
  // reload shortcut and before React bubbling, so Edit Mode always owns it.
  useEffect(() => {
    const captureGeometryShortcuts = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "r") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      startLoopCut();
    };
    window.addEventListener("keydown", captureGeometryShortcuts, true);
    return () => window.removeEventListener("keydown", captureGeometryShortcuts, true);
  }, [entityId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !component?.mesh) return undefined;
    let disposed = false;
    let renderer;
    let frame = 0;
    let resizeObserver;
    const canvas = document.createElement("canvas");
    canvas.className = "geometry-editor-canvas";
    canvas.tabIndex = 0;
    host.replaceChildren(canvas);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x282828);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    // Match the main editor viewport. Geometry editing changes the mesh
    // interaction, but camera navigation must remain consistent everywhere.
    controls.dampingFactor = 0.12;
    scene.add(new THREE.HemisphereLight(0xdcecff, 0x26301f, 2.2));
    const light = new THREE.DirectionalLight(0xffffff, 2.5);
    light.position.set(3, 5, 4);
    scene.add(light);
    const grid = new THREE.GridHelper(10, 20, 0x4a5965, 0x283039);
    grid.position.y = -0.501;
    scene.add(grid);

    const context = new THREE.Group();
    context.visible = showSceneContext;
    context.userData.sceneContext = true;
    scene.add(context);
    engine.scene.updateMatrixWorld(true);
    entity.object3D.updateWorldMatrix(true, false);
    const toLocal = entity.object3D.matrixWorld.clone().invert();
    engine.scene.traverse((source) => {
      if (!source.isMesh || source === component.mesh || !source.visible || hasEditorOnlyAncestor(source)) return;
      const material = new THREE.MeshStandardMaterial({
        color: 0x687078,
        roughness: 0.9,
        metalness: 0,
        transparent: true,
        opacity: 0.38,
        depthWrite: true,
      });
      const clone = new THREE.Mesh(source.geometry, material);
      clone.userData.sharedGeometry = true;
      clone.matrixAutoUpdate = false;
      clone.matrix.copy(toLocal).multiply(source.matrixWorld);
      context.add(clone);
    });

    const original = editableFromBufferGeometry(component.mesh.geometry);
    const editable = cloneEditable(original);
    // Blender's Edit Mode uses a neutral solid viewport independent of the
    // object's material. Keep the topology readable while editing UVs and
    // geometry, and never let a runtime texture obscure the selection cues.
    // Material slots remain intact, but Edit Mode uses one neutral surface
    // colour. Selection overlays, rather than material groups, communicate
    // which logical polygon is active.
    const editMaterials = Array.from({ length: 8 }, () => new THREE.MeshStandardMaterial({ color: 0x92979d, roughness: 0.78, metalness: 0 }));
    const mesh = new THREE.Mesh(bufferGeometryFromEditable(editable), editMaterials);
    scene.add(mesh);
    const wire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
    const markerCapacity = Math.max(4096, Math.ceil(editable.positions.length * 1.5));
    const markerGeometry = new THREE.SphereGeometry(1, 8, 6);
    const basePoints = new THREE.InstancedMesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0x111820, depthTest: true, depthWrite: false }), markerCapacity);
    basePoints.count = 0;
    const faceOverlay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xf28b30, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    // Selected/cut edges sit exactly on the rebuilt surface. WebGPU depth
    // precision can otherwise reject the whole overlay as coplanar, making a
    // successful loop cut look like it did nothing. Blender likewise keeps
    // active edit edges readable over the solid surface.
    const edgeOverlay = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: SELECT_COLOR, depthTest: false, depthWrite: false }));
    const vertexOverlay = new THREE.InstancedMesh(markerGeometry, new THREE.MeshBasicMaterial({ color: 0xffa23f, depthTest: true, depthWrite: false }), markerCapacity);
    vertexOverlay.count = 0;
    [wire, basePoints, faceOverlay, edgeOverlay, vertexOverlay].forEach((object, index) => { object.renderOrder = 5 + index; mesh.add(object); });
    [basePoints, edgeOverlay, vertexOverlay].forEach((object) => { object.frustumCulled = false; });

    const session = {
      editable, original, mesh, wire, basePoints, faceOverlay, edgeOverlay, vertexOverlay, context,
      camera, controls, canvas, hiddenEdges: new Set(), mode: "face",
      selections: { vertex: new Set(), edge: new Set(), face: new Set() },
      wireEdges: [], history: [], macro: null,
      proportional: false, xray: false,
      selectionTool: null, selectionGesture: null, circleRadius: 32,
    };
    applyTopology(session, { edges: new Set(), hidden: new Set() });
    session.preview = () => {
      const attribute = mesh.geometry.getAttribute("position");
      editable.positions.forEach((position, index) => attribute.setXYZ(index, ...position));
      attribute.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      // Extrusion walls start degenerate and only take shape as the drag runs, so
      // their hidden flags follow the geometry. Plain moves must not re-derive:
      // that is what used to make a bent quad show its diagonal.
      if (session.macro?.kind === "extrude") applyTopology(session, session.macro.beforeTopology);
      updateTopologyCache(session);
      refreshWire(session);
      refreshOverlays(session);
      setRevision((value) => value + 1);
    };
    session.rebuild = () => {
      const old = mesh.geometry;
      mesh.geometry = bufferGeometryFromEditable(editable);
      old.dispose();
      updateTopologyCache(session);
      refreshWire(session);
      refreshOverlays(session);
      setRevision((value) => value + 1);
    };
    sessionRef.current = session;
    applyXray(session);
    session.rebuild();

    const sphere = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere());
    if (initialView) {
      controls.target.fromArray(initialView.target);
      camera.position.fromArray(initialView.position);
    } else {
      controls.target.copy(sphere.center);
      camera.position.copy(sphere.center).add(new THREE.Vector3(1.4, 1.1, 1.7).multiplyScalar(Math.max(sphere.radius, 0.75)));
    }
    camera.near = Math.max(sphere.radius / 100, 0.001);
    camera.far = Math.max(sphere.radius * 100, 100);
    camera.updateProjectionMatrix();
    refreshVertexMarkerScales(session);
    const onControlsChange = () => refreshVertexMarkerScales(session);
    controls.addEventListener("change", onControlsChange);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    session.raycastAtLast = () => {
      if (!session.lastPointer) return null;
      const rect = canvas.getBoundingClientRect();
      pointer.set(((session.lastPointer.x - rect.left) / rect.width) * 2 - 1, -((session.lastPointer.y - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(mesh, false)[0] ?? null;
    };
    let down = null;
    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      if (event.altKey) event.preventDefault();
      down = [event.clientX, event.clientY];
      session.lastPointer = { x: event.clientX, y: event.clientY };
      canvas.focus();
    };
    const onPointerUp = (event) => {
      if (event.button !== 0 || !down) return;
      const moved = Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4;
      down = null;
      if (moved) return;
      const rect = canvas.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(mesh, false)[0];
      const selection = session.selections[session.mode];
      const pathSelect = event.ctrlKey || event.metaKey;
      if (!event.shiftKey && !pathSelect) selection.clear();
      if (hit) {
        const picked = pickElement(session, hit);
        if (pathSelect && picked[0] !== undefined) {
          shortestSelectionPath(session, picked).forEach((key) => selection.add(key));
          refreshOverlays(session);
          setRevision((value) => value + 1);
          return;
        }
        if (event.altKey && picked[0] !== undefined) {
          const loop = loopSelectionAtHit(session, hit);
          if (!(loop instanceof Set) || !loop.size) return;
          const removeLoop = event.shiftKey && [...loop].every((key) => selection.has(key));
          loop.forEach((key) => removeLoop ? selection.delete(key) : selection.add(key));
          refreshOverlays(session);
          setRevision((value) => value + 1);
          return;
        }
        const remove = event.shiftKey && picked.every((key) => selection.has(key));
        picked.forEach((key) => remove ? selection.delete(key) : selection.add(key));
      }
      refreshOverlays(session);
      setRevision((value) => value + 1);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    const scheduleLoopCutPreview = () => {
      if (session.macroFrame) return;
      const runPreview = (now) => {
        if (now - (session.loopPreviewLast ?? 0) < 40) {
          session.macroFrame = requestAnimationFrame(runPreview);
          return;
        }
        session.macroFrame = 0;
        if (session.macro?.kind !== "loopcut") return;
        session.loopPreviewLast = now;
        applyTransformMacro(session);
        setMacroState({ kind: "loopcut", axis: null, buffer: "", segments: session.macro.segments, locked: session.macro.locked });
      };
      session.macroFrame = requestAnimationFrame(runPreview);
    };
    const onWindowPointerMove = (event) => {
      session.lastPointer = { x: event.clientX, y: event.clientY };
      if (session.selectionGesture) {
        session.selectionGesture.current = { x: event.clientX, y: event.clientY };
        if (session.selectionGesture.kind === "circle") applyRegionSelection(session, session.selectionGesture);
        setSelectionGesture({ ...session.selectionGesture });
        setRevision((value) => value + 1);
        return;
      }
      if (!session.macro) return;
      session.macro.current = { x: event.clientX, y: event.clientY };
      if (session.macro.kind === "loopcut") {
        // Pointer events can arrive much faster than a large mesh can be
        // retriangulated. Coalesce loop-cut previews to one rebuild per frame.
        scheduleLoopCutPreview();
      } else if (!session.macro.buffer) {
        applyTransformMacro(session);
        if (session.macro?.kind === "bevel") setMacroState({ kind: "bevel", axis: null, buffer: "", amount: session.macro.amount, segments: session.macro.segments });
        if (session.macro?.kind === "inset") setMacroState({ kind: "inset", axis: null, buffer: "", amount: session.macro.amount });
      }
    };
    const onWindowPointerDown = (event) => {
      if (!session.macro && session.selectionTool && event.target === canvas && event.button === 0) {
        const subtractive = event.ctrlKey || event.metaKey;
        if (!event.shiftKey && !subtractive) session.selections[session.mode].clear();
        session.selectionGesture = {
          kind: session.selectionTool,
          start: { x: event.clientX, y: event.clientY },
          current: { x: event.clientX, y: event.clientY },
          radius: session.circleRadius ?? 32,
          subtractive,
        };
        session.selectionTool = null;
        session.controls.enabled = false;
        setSelectionTool(null);
        setSelectionGesture({ ...session.selectionGesture });
        if (session.selectionGesture.kind === "circle") applyRegionSelection(session, session.selectionGesture);
        setRevision((value) => value + 1);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!session.macro) return;
      if (event.button === 0 && session.macro.kind === "loopcut" && !session.macro.locked) {
        session.macro.locked = true;
        session.macro.lockT = session.macro.t;
        cancelAnimationFrame(session.macroFrame);
        session.macroFrame = 0;
        applyTransformMacro(session);
        setMacroState({ kind: "loopcut", axis: null, buffer: "", segments: session.macro.segments, locked: true });
      } else if (event.button === 0) commitTransform();
      else if (event.button === 2) {
        session.preventContextOnce = true;
        cancelTransform();
      }
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onWindowPointerUp = (event) => {
      if (!session.selectionGesture || event.button !== 0) return;
      applyRegionSelection(session, session.selectionGesture);
      session.selectionGesture = null;
      session.controls.enabled = true;
      setSelectionGesture(null);
      setRevision((value) => value + 1);
      event.preventDefault();
      event.stopPropagation();
    };
    const onWindowWheel = (event) => {
      if (session.selectionGesture?.kind === "circle") {
        session.circleRadius = THREE.MathUtils.clamp((session.circleRadius ?? 32) * Math.pow(1.08, -event.deltaY / 100), 8, 240);
        session.selectionGesture.radius = session.circleRadius;
        setSelectionGesture({ ...session.selectionGesture });
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!session.macro) return;
      if (session.macro.kind === "loopcut") {
        session.macro.segments = THREE.MathUtils.clamp(session.macro.segments + (event.deltaY < 0 ? 1 : -1), 1, 32);
        scheduleLoopCutPreview();
      } else if (session.macro.kind === "bevel") {
        session.macro.segments = THREE.MathUtils.clamp(session.macro.segments + (event.deltaY < 0 ? 1 : -1), 1, 12);
        applyTransformMacro(session);
        setMacroState({ kind: "bevel", axis: null, buffer: session.macro.buffer, amount: session.macro.amount, segments: session.macro.segments });
      } else if (session.macro.proportional) {
        session.macro.radius = THREE.MathUtils.clamp(session.macro.radius * Math.pow(1.08, -event.deltaY / 100), 0.001, 100000);
        applyTransformMacro(session);
        setMacroState({ kind: session.macro.kind, axis: session.macro.axis, buffer: session.macro.buffer, proportional: true, radius: session.macro.radius });
      } else return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onContextMenu = (event) => {
      if (event.target === canvas || canvas.contains(event.target) || session.macro || session.preventContextOnce) {
        event.preventDefault();
        session.preventContextOnce = false;
      }
    };
    const onBlur = () => { cancelTransform(); cancelSelectionTool(); };
    window.addEventListener("pointermove", onWindowPointerMove, true);
    window.addEventListener("pointerdown", onWindowPointerDown, true);
    window.addEventListener("pointerup", onWindowPointerUp, true);
    window.addEventListener("wheel", onWindowWheel, { capture: true, passive: false });
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("blur", onBlur);

    (async () => {
      renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      await renderer.init();
      if (disposed) return;
      const resize = () => {
        const { width, height } = host.getBoundingClientRect();
        if (!width || !height) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      resize();
      const render = () => {
        if (disposed) return;
        const rect = host.getBoundingClientRect();
        if (canvas.isConnected && rect.width >= 1 && rect.height >= 1) {
          controls.update();
          renderer.render(scene, camera);
        }
        frame = requestAnimationFrame(render);
      };
      render();
    })().catch((err) => setStatus(`Renderer failed: ${err}`));

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(session.macroFrame);
      resizeObserver?.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointermove", onWindowPointerMove, true);
      window.removeEventListener("pointerdown", onWindowPointerDown, true);
      window.removeEventListener("pointerup", onWindowPointerUp, true);
      window.removeEventListener("wheel", onWindowWheel, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("blur", onBlur);
      controls.removeEventListener("change", onControlsChange);
      controls.dispose();
      scene.traverse((object) => {
        if (!object.userData?.sharedGeometry) object.geometry?.dispose?.();
        if (!object.userData?.sharedMaterial) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material?.dispose?.());
        }
      });
      renderer?.dispose();
      sessionRef.current = null;
    };
  }, [entityId, component]);

  if (!component) return <div className="geometry-editor-empty">Select an entity with a Mesh component.</div>;
  const session = sessionRef.current;
  const selectionCount = session?.selections[mode].size ?? 0;
  const materialSlots = Array.from({ length: 8 }, (_, index) => component.props[index ? `material${index + 1}` : "material"] ?? "");
  const runMenuAction = (event, action) => {
    event.currentTarget.closest("details")?.removeAttribute("open");
    action();
  };
  return (
    <div className={`geometry-editor ${embedded ? "embedded" : ""}`} ref={rootRef} onKeyDown={handleKeyDown}>
      <div className="geometry-editor-toolbar">
        <div className="geometry-mode-group">
          {MODES.map((item, index) => {
            const Icon = item === "vertex" ? Circle : item === "edge" ? Square : Triangle;
            return <button key={item} className={`toolbar-btn icon-only ${mode === item ? "active" : ""}`} title={`${MODE_LABELS[item]} select (${index + 1})`} onClick={() => changeMode(item)}><Icon size={14} /></button>;
          })}
        </div>
        <span className="geometry-editor-stat geometry-selection-count" title={`${selectionCount} selected`}>{selectionCount}</span>
        <details className="geometry-toolbar-menu">
          <summary>Select</summary>
          <div className="geometry-toolbar-popover">
            <button className={selectionTool === "box" ? "active" : ""} onClick={(event) => runMenuAction(event, () => armSelectionTool("box"))}>Box Select <kbd>B</kbd></button>
            <button className={selectionTool === "circle" ? "active" : ""} onClick={(event) => runMenuAction(event, () => armSelectionTool("circle"))}>Circle Select <kbd>C</kbd></button>
            <button onClick={(event) => runMenuAction(event, selectMore)}>Select More <kbd>Ctrl++</kbd></button>
            <button onClick={(event) => runMenuAction(event, selectLess)}>Select Less <kbd>Ctrl+−</kbd></button>
            <button onClick={(event) => runMenuAction(event, invertSelection)}>Invert <kbd>Ctrl+I</kbd></button>
          </div>
        </details>
        <details className="geometry-toolbar-menu">
          <summary>Transform</summary>
          <div className="geometry-toolbar-popover">
            <button disabled={!selectionCount} onClick={(event) => runMenuAction(event, () => startTransform("translate"))}><Move size={13} /> Move <kbd>G</kbd></button>
            <button disabled={!selectionCount} onClick={(event) => runMenuAction(event, () => startTransform("rotate"))}><Rotate3d size={13} /> Rotate <kbd>R</kbd></button>
            <button disabled={!selectionCount} onClick={(event) => runMenuAction(event, () => startTransform("scale"))}><Scale3d size={13} /> Scale <kbd>S</kbd></button>
            <button className={proportional ? "active" : ""} onClick={(event) => runMenuAction(event, toggleProportional)}><Magnet size={13} /> Proportional <kbd>O</kbd></button>
          </div>
        </details>
        <details className="geometry-toolbar-menu">
          <summary>Mesh</summary>
          <div className="geometry-toolbar-popover">
            <button disabled={mode !== "face" || !selectionCount} onClick={(event) => runMenuAction(event, startExtrude)}>Extrude <kbd>E</kbd></button>
            <button disabled={mode !== "face" || !selectionCount} onClick={(event) => runMenuAction(event, startInset)}>Inset Faces <kbd>I</kbd></button>
            <button disabled={mode !== "edge" || !selectionCount} onClick={(event) => runMenuAction(event, startBevel)}>Bevel Edges <kbd>Ctrl+B</kbd></button>
            <label className="geometry-menu-field">Cuts
              <input
                type="number"
                min={1}
                max={MAX_SUBDIVISION_CUTS}
                value={cuts}
                onChange={(event) => setCuts(THREE.MathUtils.clamp(Math.round(Number(event.target.value)) || 1, 1, MAX_SUBDIVISION_CUTS))}
              />
            </label>
            <button onClick={(event) => runMenuAction(event, subdivideSelection)}>Subdivide {cuts > 1 ? `${cuts}×` : ""}</button>
            <button disabled={!selectionCount} onClick={(event) => runMenuAction(event, mergeSelection)}>Merge at Center <kbd>M</kbd></button>
            <button onClick={(event) => runMenuAction(event, startLoopCut)}><Scissors size={13} /> Loop Cut <kbd>Ctrl+R</kbd></button>
          </div>
        </details>
        <details className="geometry-toolbar-menu">
          <summary>UV</summary>
          <div className="geometry-toolbar-popover">
            <button onClick={(event) => runMenuAction(event, () => mutate((value) => unwrapPlanar(value.editable, "z")))}><Triangle size={13} /> Planar</button>
            <button onClick={(event) => runMenuAction(event, () => mutate((value) => unwrapBox(value.editable)))}><Box size={13} /> Box</button>
          </div>
        </details>
        {mode === "face" && <details className="geometry-toolbar-menu">
          <summary>Material</summary>
          <div className="geometry-toolbar-popover geometry-material-popover">
            <label>Face slot
              <select value={faceMaterial} onChange={(event) => setFaceMaterial(Number(event.target.value))}>
                {materialSlots.map((path, index) => <option key={index} value={index}>{materialSlotLabel(path, index)}</option>)}
              </select>
            </label>
            <button disabled={!selectionCount} onClick={(event) => runMenuAction(event, assignMaterial)}>Assign to Selection</button>
          </div>
        </details>}
        <details className="geometry-toolbar-menu">
          <summary>View</summary>
          <div className="geometry-toolbar-popover">
            <button className={xray ? "active" : ""} onClick={(event) => runMenuAction(event, toggleXray)}><Eye size={13} /> X-Ray <kbd>Alt+Z</kbd></button>
            <button className={showSceneContext ? "active" : ""} onClick={(event) => runMenuAction(event, () => setShowSceneContext((value) => !value))}><Layers size={13} /> Scene Context</button>
          </div>
        </details>
        <button className="toolbar-btn icon-only" title="Undo (Ctrl+Z)" disabled={!session?.history.length} onClick={undo}><Undo2 size={14} /></button>
        <span className="geometry-editor-spacer" />
        <span className="geometry-editor-stat geometry-topology-count" key={revision} title={`${session?.editable.positions.length ?? 0} vertices / ${session?.editable.faces.length ?? 0} triangles`}>{session?.editable.positions.length ?? 0}v · {session?.editable.faces.length ?? 0}t</span>
        {embedded && <button className="toolbar-btn icon-only" title="Cancel scene edit" onClick={onClose}><X size={14} /></button>}
      </div>
      <div className="geometry-editor-viewport" ref={hostRef} />
      {selectionGesture?.kind === "box" && (() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return null;
        const left = Math.min(selectionGesture.start.x, selectionGesture.current.x) - rect.left;
        const top = Math.min(selectionGesture.start.y, selectionGesture.current.y) - rect.top;
        const width = Math.abs(selectionGesture.current.x - selectionGesture.start.x);
        const height = Math.abs(selectionGesture.current.y - selectionGesture.start.y);
        return <div className="geometry-selection-rect" style={{ left, top, width, height }} />;
      })()}
      {selectionGesture?.kind === "circle" && (() => {
        const rect = rootRef.current?.getBoundingClientRect();
        if (!rect) return null;
        const radius = selectionGesture.radius;
        return <div className="geometry-selection-circle" style={{ left: selectionGesture.current.x - rect.left - radius, top: selectionGesture.current.y - rect.top - radius, width: radius * 2, height: radius * 2 }} />;
      })()}
      {macroState && (
        <div className="geometry-transform-hud">
          <strong>{macroState.kind === "translate" ? "Move" : macroState.kind === "rotate" ? "Rotate" : macroState.kind === "extrude" ? "Extrude" : macroState.kind === "loopcut" ? "Loop Cut" : macroState.kind === "bevel" ? "Bevel" : macroState.kind === "inset" ? "Inset" : "Scale"}</strong>
          {(macroState.kind === "loopcut" || macroState.kind === "bevel") && <span className="geometry-transform-value">{macroState.segments ?? 1}×</span>}
          <span>{macroState.kind === "loopcut" ? (macroState.locked ? "Edge Slide" : "Even Spacing") : macroState.kind === "bevel" ? `${Math.round((macroState.amount ?? 0) * 1000) / 1000} width` : macroState.kind === "inset" ? `${Math.round((macroState.amount ?? 0) * 1000) / 1000} factor` : macroState.axis ? macroState.axis.toUpperCase() : macroState.kind === "rotate" ? "View" : macroState.kind === "extrude" ? "Normal" : "Free"}</span>
          {macroState.buffer && <span className="geometry-transform-value">{macroState.buffer}{macroState.kind === "rotate" ? "°" : ""}</span>}
          <small>{macroState.kind === "loopcut" && macroState.locked ? "Slide · LMB confirm · Esc cancel" : macroState.kind === "loopcut" ? "Scroll cuts · LMB set · Esc cancel" : macroState.kind === "bevel" ? "Move width · Scroll segments · LMB confirm · Esc cancel" : "LMB / Enter confirm · Esc / RMB cancel"}</small>
        </div>
      )}
      <div className="geometry-editor-shortcuts"><kbd>1/2/3</kbd> modes <kbd>Alt+Click</kbd> loop <kbd>Ctrl+Click</kbd> path <kbd>Shift+D</kbd> duplicate <kbd>Esc</kbd> cancel</div>
      {status && <div className="geometry-editor-status">{status}</div>}
    </div>
  );
}
