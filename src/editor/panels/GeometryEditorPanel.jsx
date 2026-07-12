import { useEffect, useRef, useState } from "react";
import { Box, Circle, Eye, Layers, Magnet, Move, Rotate3d, Save, Scale3d, Scissors, Square, Triangle, Undo2, X } from "lucide-react";
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { engine } from "../engineInstance.js";
import { useSelectionStore } from "../store/selectionStore.js";
import { useProjectStore } from "../store/projectStore.js";
import { commandBus } from "../commands/CommandBus.js";
import { SetComponentPropCommand } from "../commands/componentCommands.js";
import { invalidateBlobUrl } from "../assetLoader.js";
import {
  bufferGeometryFromEditable,
  beginExtrudeFaces,
  cloneEditable,
  coplanarFaceGroup,
  cutMeshByPlane,
  deleteFaces,
  editableFromBufferGeometry,
  expandLogicalVertices,
  geometryAssetFromEditable,
  unwrapBox,
  unwrapPlanar,
} from "../editableGeometry.js";

const MODES = ["vertex", "edge", "face"];
const MODE_LABELS = { vertex: "Vertex", edge: "Edge", face: "Face" };
const positionKey = (point) => point.map((value) => Math.round(value * 1e5)).join(",");
const edgeKey = (editable, a, b) => [positionKey(editable.positions[a]), positionKey(editable.positions[b])].sort().join("|");

function safeStem(value) {
  return (value || "Geometry").replace(/[^a-z0-9 _-]/gi, "").trim() || "Geometry";
}

async function uniqueGeometryPath(root, stem) {
  const { invoke } = await import("@tauri-apps/api/core");
  for (let i = 0; ; i++) {
    const path = `${root}/geometries/${stem}${i ? ` ${i}` : ""}.geom`;
    try { await invoke("stat_file", { path }); } catch { return path; }
  }
}

function reloadGeometryUsers(path) {
  for (const candidate of engine.entities.values()) {
    const mesh = candidate.getComponent?.("mesh");
    if (mesh?.props.geometryAsset === path) mesh.setProp("geometryAsset", path);
  }
}

function faceNormal(editable, face) {
  const a = new THREE.Vector3(...editable.positions[face[0]]);
  return new THREE.Vector3(...editable.positions[face[1]]).sub(a)
    .cross(new THREE.Vector3(...editable.positions[face[2]]).sub(a)).normalize();
}

function logicalEdges(editable, forced = new Set()) {
  const edges = new Map();
  editable.faces.forEach((face) => {
    const normal = faceNormal(editable, face);
    for (let i = 0; i < 3; i++) {
      const a = face[i];
      const b = face[(i + 1) % 3];
      const key = edgeKey(editable, a, b);
      const entry = edges.get(key) ?? { a, b, normals: [] };
      entry.normals.push(normal);
      edges.set(key, entry);
    }
  });
  return new Map([...edges].filter(([key, edge]) =>
    forced.has(key) || edge.normals.length === 1 || edge.normals.some((normal) => normal.dot(edge.normals[0]) < 0.9999),
  ));
}

function setPositions(geometry, positions) {
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
}

function applyXray(session) {
  const material = session.mesh.material;
  material.transparent = session.xray;
  material.opacity = session.xray ? 0.38 : 1;
  material.depthWrite = !session.xray;
  material.needsUpdate = true;
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

function pickRegion(session, gesture) {
  const rect = session.canvas.getBoundingClientRect();
  const selected = new Set();
  if (session.mode === "vertex") {
    const unique = new Map(session.editable.positions.map((position) => [positionKey(position), position]));
    unique.forEach((position, key) => {
      if (pointInSelectionRegion(screenPosition(new THREE.Vector3(...position), session.camera, rect), gesture)) selected.add(key);
    });
  } else if (session.mode === "edge") {
    logicalEdges(session.editable, session.forcedEdges).forEach((edge, key) => {
      const midpoint = new THREE.Vector3(...session.editable.positions[edge.a]).add(new THREE.Vector3(...session.editable.positions[edge.b])).multiplyScalar(0.5);
      if (pointInSelectionRegion(screenPosition(midpoint, session.camera, rect), gesture)) selected.add(key);
    });
  } else {
    session.editable.faces.forEach((face, index) => {
      const center = face.reduce((sum, vertex) => sum.add(new THREE.Vector3(...session.editable.positions[vertex])), new THREE.Vector3()).multiplyScalar(1 / face.length);
      if (pointInSelectionRegion(screenPosition(center, session.camera, rect), gesture)) coplanarFaceGroup(session.editable, index, 0.9999, session.forcedEdges).forEach((faceIndex) => selected.add(faceIndex));
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
  const {
    editable,
    selections,
    hover,
    faceOverlay,
    edgeOverlay,
    vertexOverlay,
    hoverFaceOverlay,
    hoverEdgeOverlay,
    hoverVertexOverlay,
    basePoints,
  } = session;
  const facePositions = [...selections.face].flatMap((index) =>
    editable.faces[index]?.flatMap((vertex) => editable.positions[vertex]) ?? [],
  );
  setPositions(faceOverlay.geometry, facePositions);
  faceOverlay.visible = session.mode === "face" && facePositions.length > 0;

  const edges = logicalEdges(editable, session.forcedEdges);
  const edgePositions = [...selections.edge].flatMap((key) => {
    const edge = edges.get(key);
    return edge ? [...editable.positions[edge.a], ...editable.positions[edge.b]] : [];
  });
  setPositions(edgeOverlay.geometry, edgePositions);
  edgeOverlay.visible = session.mode === "edge" && edgePositions.length > 0;

  const uniquePositions = new Map(editable.positions.map((position) => [positionKey(position), position]));
  setPositions(basePoints.geometry, [...uniquePositions.values()].flat());
  const vertexPositions = [...selections.vertex].flatMap((key) => uniquePositions.get(key) ?? []);
  setPositions(vertexOverlay.geometry, vertexPositions);
  vertexOverlay.visible = session.mode === "vertex" && vertexPositions.length > 0;
  basePoints.visible = session.mode === "vertex";

  const hoverFaces = session.mode === "face" ? [...hover.face] : [];
  const hoverFacePositions = hoverFaces
    .filter((index) => !selections.face.has(index))
    .flatMap((index) => editable.faces[index]?.flatMap((vertex) => editable.positions[vertex]) ?? []);
  setPositions(hoverFaceOverlay.geometry, hoverFacePositions);
  hoverFaceOverlay.visible = hoverFacePositions.length > 0;

  const hoverEdgePositions = session.mode === "edge"
    ? [...hover.edge].flatMap((key) => {
        if (selections.edge.has(key)) return [];
        const edge = edges.get(key);
        return edge ? [...editable.positions[edge.a], ...editable.positions[edge.b]] : [];
      })
    : [];
  setPositions(hoverEdgeOverlay.geometry, hoverEdgePositions);
  hoverEdgeOverlay.visible = hoverEdgePositions.length > 0;

  const hoverVertexPositions = session.mode === "vertex"
    ? [...hover.vertex].filter((key) => !selections.vertex.has(key)).flatMap((key) => uniquePositions.get(key) ?? [])
    : [];
  setPositions(hoverVertexOverlay.geometry, hoverVertexPositions);
  hoverVertexOverlay.visible = hoverVertexPositions.length > 0;
}

function pickElement(session, hit) {
  const { editable, mode } = session;
  const faceIndex = hit.faceIndex;
  const face = editable.faces[faceIndex];
  if (!face) return [];
  if (mode === "face") return coplanarFaceGroup(editable, faceIndex, 0.9999, session.forcedEdges);
  if (mode === "vertex") {
    const closest = face.reduce((best, index) => {
      const distance = hit.point.distanceToSquared(new THREE.Vector3(...editable.positions[index]));
      return distance < best.distance ? { index, distance } : best;
    }, { index: face[0], distance: Infinity });
    return [positionKey(editable.positions[closest.index])];
  }
  const closest = face.map((a, i) => [a, face[(i + 1) % 3]])
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
  const slide = t - 0.5;
  Object.assign(session.editable, cloneEditable(macro.before));
  const forcedEdges = new Set();
  const segments = Math.max(1, macro.segments ?? 1);
  for (let index = 0; index < segments; index++) {
    const evenlySpaced = (index + 1) / (segments + 1);
    const cutT = THREE.MathUtils.clamp(segments === 1 ? t : evenlySpaced + slide, 0.02, 0.98);
    const cutPoint = macro.edgeStart.clone().lerp(macro.edgeEnd, cutT);
    const result = cutMeshByPlane(session.editable, macro.edgeDirection.toArray(), cutPoint.toArray(), macro.seedFace);
    result.edgeKeys.forEach((key) => forcedEdges.add(key));
  }
  session.forcedEdges = forcedEdges;
  session.selections.edge = new Set(forcedEdges);
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
    for (const face of editable.faces) {
      for (let edge = 0; edge < 3; edge++) {
        const a = face[edge];
        const b = face[(edge + 1) % 3];
        if (selections.edge.has(edgeKey(editable, a, b))) {
          indices.add(a);
          indices.add(b);
        }
      }
    }
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
  const [mode, setMode] = useState("face");
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("");
  const [macroState, setMacroState] = useState(null);
  const [showSceneContext, setShowSceneContext] = useState(embedded);
  const [proportional, setProportional] = useState(false);
  const [xray, setXray] = useState(false);
  const [selectionTool, setSelectionTool] = useState(null);
  const [selectionGesture, setSelectionGesture] = useState(null);
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
        logicalEdges(session.editable, session.forcedEdges).forEach((edge, key) => {
          if (selectedVertices.has(positionKey(session.editable.positions[edge.a])) && selectedVertices.has(positionKey(session.editable.positions[edge.b]))) nextSelection.add(key);
        });
      } else {
        session.editable.faces.forEach((face, index) => {
          if (face.every((vertex) => selectedVertices.has(positionKey(session.editable.positions[vertex])))) nextSelection.add(index);
        });
      }
      session.selections[next] = nextSelection;
      session.mode = next;
      session.hover = { vertex: new Set(), edge: new Set(), face: new Set() };
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

  const mutate = (operation) => {
    const session = sessionRef.current;
    if (!session) return;
    session.history.push({ editable: cloneEditable(session.editable), selections: cloneSelections(session.selections), forcedEdges: new Set(session.forcedEdges) });
    operation(session);
    session.rebuild();
  };

  const undo = () => {
    const session = sessionRef.current;
    const previous = session?.history.pop();
    if (!previous) return;
    Object.assign(session.editable, previous.editable);
    session.selections = previous.selections;
    session.forcedEdges = previous.forcedEdges ?? new Set();
    session.rebuild();
  };

  const startExtrude = () => {
    const session = sessionRef.current;
    if (!session || session.mode !== "face" || !session.selections.face.size || session.macro) return;
    const before = cloneEditable(session.editable);
    const beforeSelections = cloneSelections(session.selections);
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
      beforeForcedEdges: new Set(session.forcedEdges), beforeMode: session.mode,
      start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    session.rebuild();
    setMacroState({ kind: "extrude", axis: null, buffer: "" });
  };

  const startLoopCut = () => {
    const session = sessionRef.current;
    const hit = session?.raycastAtLast?.();
    if (!session || !hit || session.macro) return;
    const face = session.editable.faces[hit.faceIndex];
    const visible = logicalEdges(session.editable, session.forcedEdges);
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
      beforeForcedEdges: new Set(session.forcedEdges), beforeMode,
      pivot: new THREE.Vector3(), start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    applyTransformMacro(session);
    setMacroState({ kind: "loopcut", axis: null, buffer: "", segments: 1, locked: false });
  };

  const startTransform = (kind) => {
    const session = sessionRef.current;
    const indices = session ? selectedVertexIndices(session) : [];
    if (!session || !indices.length || session.macro) return;
    const pointer = session.lastPointer ?? { x: 0, y: 0 };
    const positions = indices.map((index) => new THREE.Vector3(...session.editable.positions[index]));
    const uniquePivotPoints = new Map(positions.map((point) => [positionKey(point.toArray()), point]));
    const pivot = [...uniquePivotPoints.values()].reduce((sum, point) => sum.add(point), new THREE.Vector3())
      .multiplyScalar(1 / uniquePivotPoints.size);
    const edges = session.mode === "edge"
      ? [...session.selections.edge].map((key) => {
          const edge = logicalEdges(session.editable, session.forcedEdges).get(key);
          return edge ? [edge.a, edge.b] : null;
        }).filter(Boolean)
      : [];
    const allPositions = session.editable.positions.map((value) => [...value]);
    const bounds = new THREE.Box3().setFromPoints(positions);
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.75, 0.25);
    session.macro = {
      kind, axis: null, buffer: "", indices, positions, allPositions, pivot, edges,
      proportional: session.proportional, radius,
      before: cloneEditable(session.editable), beforeSelections: cloneSelections(session.selections),
      beforeForcedEdges: new Set(session.forcedEdges), beforeMode: session.mode,
      start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    setMacroState({ kind, axis: null, buffer: "", proportional: session.proportional, radius });
  };

  const cancelTransform = () => {
    const session = sessionRef.current;
    if (!session?.macro) return;
    Object.assign(session.editable, cloneEditable(session.macro.before));
    session.selections = cloneSelections(session.macro.beforeSelections);
    session.forcedEdges = new Set(session.macro.beforeForcedEdges ?? []);
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
    session.history.push({ editable: session.macro.before, selections: session.macro.beforeSelections, forcedEdges: session.macro.beforeForcedEdges ?? new Set() });
    session.macro = null;
    session.controls.enabled = true;
    session.rebuild();
    setMacroState(null);
  };

  const selectAll = () => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.mode === "face") session.selections.face = new Set(session.editable.faces.map((_, index) => index));
    if (session.mode === "edge") session.selections.edge = new Set(logicalEdges(session.editable, session.forcedEdges).keys());
    if (session.mode === "vertex") session.selections.vertex = new Set(session.editable.positions.map(positionKey));
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
    deleteFaces(session.editable, [...remove]);
    session.forcedEdges.clear();
    session.selections = { vertex: new Set(), edge: new Set(), face: new Set() };
  });

  const handleKeyDown = (event) => {
    if (event.target.closest("input, textarea, select")) return;
    // Edit mode owns its keyboard grammar. Prevent scene-level Delete,
    // duplicate, visibility and undo shortcuts from running as well.
    event.stopPropagation();
    const activeMacro = sessionRef.current?.macro;
    if (activeMacro) {
      const key = event.key.toLowerCase();
      if (key === "escape") { event.preventDefault(); cancelTransform(); return; }
      if (key === "enter" || key === " ") { event.preventDefault(); commitTransform(); return; }
      if (activeMacro.kind === "loopcut") return;
      if (key === "o") {
        event.preventDefault();
        activeMacro.proportional = !activeMacro.proportional;
        setProportional(activeMacro.proportional);
        applyTransformMacro(sessionRef.current);
        setMacroState({ kind: activeMacro.kind, axis: activeMacro.axis, buffer: activeMacro.buffer, proportional: activeMacro.proportional, radius: activeMacro.radius });
        return;
      }
      if (["x", "y", "z"].includes(key)) {
        event.preventDefault();
        activeMacro.axis = activeMacro.axis === key ? null : key;
        applyTransformMacro(sessionRef.current);
        setMacroState({ kind: activeMacro.kind, axis: activeMacro.axis, buffer: activeMacro.buffer });
        return;
      }
      if (key === "backspace") {
        event.preventDefault();
        activeMacro.buffer = activeMacro.buffer.slice(0, -1);
        applyTransformMacro(sessionRef.current);
        setMacroState({ kind: activeMacro.kind, axis: activeMacro.axis, buffer: activeMacro.buffer });
        return;
      }
      if (/^[0-9.-]$/.test(key)) {
        if (key === "-" && activeMacro.buffer) return;
        if (key === "." && activeMacro.buffer.includes(".")) return;
        event.preventDefault();
        activeMacro.buffer += key;
        applyTransformMacro(sessionRef.current);
        setMacroState({ kind: activeMacro.kind, axis: activeMacro.axis, buffer: activeMacro.buffer });
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
    const editMaterial = new THREE.MeshStandardMaterial({
      color: 0x9a9a9a,
      roughness: 0.72,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(bufferGeometryFromEditable(editable), editMaterial);
    scene.add(mesh);
    const wire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x22272b }));
    const basePoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x202a31, size: 7, sizeAttenuation: false, depthTest: false }));
    const faceOverlay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xf28b30, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    const edgeOverlay = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff9b42, depthTest: false }));
    const vertexOverlay = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff9b42, size: 10, sizeAttenuation: false, depthTest: false }));
    const hoverFaceOverlay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const hoverEdgeOverlay = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
    const hoverVertexOverlay = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 12, sizeAttenuation: false, depthTest: false }));
    [wire, basePoints, hoverFaceOverlay, faceOverlay, hoverEdgeOverlay, edgeOverlay, hoverVertexOverlay, vertexOverlay].forEach((object, index) => { object.renderOrder = 5 + index; mesh.add(object); });

    const session = {
      editable, original, mesh, wire, basePoints, faceOverlay, edgeOverlay, vertexOverlay,
      hoverFaceOverlay, hoverEdgeOverlay, hoverVertexOverlay, context,
      camera, controls, canvas, forcedEdges: new Set(), mode: "face",
      selections: { vertex: new Set(), edge: new Set(), face: new Set() },
      hover: { vertex: new Set(), edge: new Set(), face: new Set() }, history: [], macro: null,
      proportional: false, xray: false,
      selectionTool: null, selectionGesture: null, circleRadius: 32,
    };
    session.preview = () => {
      const attribute = mesh.geometry.getAttribute("position");
      editable.positions.forEach((position, index) => attribute.setXYZ(index, ...position));
      attribute.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      const edgePositions = [...logicalEdges(editable, session.forcedEdges).values()].flatMap((edge) => [...editable.positions[edge.a], ...editable.positions[edge.b]]);
      setPositions(wire.geometry, edgePositions);
      refreshOverlays(session);
      setRevision((value) => value + 1);
    };
    session.rebuild = () => {
      const old = mesh.geometry;
      mesh.geometry = bufferGeometryFromEditable(editable);
      old.dispose();
      const edgePositions = [...logicalEdges(editable, session.forcedEdges).values()].flatMap((edge) => [...editable.positions[edge.a], ...editable.positions[edge.b]]);
      setPositions(wire.geometry, edgePositions);
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
      down = [event.clientX, event.clientY];
      session.lastPointer = { x: event.clientX, y: event.clientY };
      canvas.focus();
    };
    const updateHover = (event) => {
      session.lastPointer = { x: event.clientX, y: event.clientY };
      if (session.macro) return;
      const rect = canvas.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(mesh, false)[0];
      session.hover = { vertex: new Set(), edge: new Set(), face: new Set() };
      if (hit) pickElement(session, hit).forEach((key) => session.hover[session.mode].add(key));
      refreshOverlays(session);
    };
    const onPointerLeave = () => {
      if (session.macro) return;
      session.hover = { vertex: new Set(), edge: new Set(), face: new Set() };
      refreshOverlays(session);
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
      if (!event.shiftKey) selection.clear();
      if (hit) {
        const picked = pickElement(session, hit);
        const remove = event.shiftKey && picked.every((key) => selection.has(key));
        picked.forEach((key) => remove ? selection.delete(key) : selection.add(key));
      }
      refreshOverlays(session);
      setRevision((value) => value + 1);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointermove", updateHover);
    canvas.addEventListener("pointerleave", onPointerLeave);
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
      if (session.macro.kind === "loopcut" || !session.macro.buffer) applyTransformMacro(session);
      if (session.macro.kind === "loopcut") {
        setMacroState({ kind: "loopcut", axis: null, buffer: "", segments: session.macro.segments, locked: session.macro.locked });
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
        applyTransformMacro(session);
        setMacroState({ kind: "loopcut", axis: null, buffer: "", segments: session.macro.segments, locked: session.macro.locked });
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
      resizeObserver?.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointermove", updateHover);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointermove", onWindowPointerMove, true);
      window.removeEventListener("pointerdown", onWindowPointerDown, true);
      window.removeEventListener("pointerup", onWindowPointerUp, true);
      window.removeEventListener("wheel", onWindowWheel, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("blur", onBlur);
      controls.dispose();
      scene.traverse((object) => {
        if (!object.userData?.sharedGeometry) object.geometry?.dispose?.();
        if (!object.userData?.sharedMaterial) object.material?.dispose?.();
      });
      renderer?.dispose();
      sessionRef.current = null;
    };
  }, [entityId, component]);

  const saveGeometry = async ({ saveNew = false } = {}) => {
    const session = sessionRef.current;
    const root = useProjectStore.getState().rootPath;
    if (!session || !component || !root) return;
    const existingPath = component.props.geometryAsset;
    if (!saveNew && !existingPath) {
      setStatus("This primitive has no geometry asset. Use Save New.");
      return;
    }
    setStatus("Saving geometry...");
    try {
      const path = saveNew ? await uniqueGeometryPath(root, safeStem(entity?.name)) : existingPath;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_scene", { path, contents: JSON.stringify(geometryAssetFromEditable(session.editable), null, 2) });
      invalidateBlobUrl(path);
      if (path !== existingPath) {
        commandBus.execute(new SetComponentPropCommand(entityId, "mesh", "geometryAsset", path));
      } else {
        // Overwriting a shared asset updates every mesh that references it.
        reloadGeometryUsers(path);
      }
      await useProjectStore.getState().refresh();
      setStatus(`${saveNew ? "Saved new" : "Saved"} ${path.split(/[\\/]/).pop()}`);
    } catch (err) { setStatus(`Save failed: ${err}`); }
  };

  if (!component) return <div className="geometry-editor-empty">Select an entity with a Mesh component.</div>;
  const session = sessionRef.current;
  const selectionCount = session?.selections[mode].size ?? 0;
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
        <div className="geometry-selection-tools">
          <button className={`toolbar-btn icon-only ${selectionTool === "box" ? "active" : ""}`} title="Box select (B)" onClick={() => armSelectionTool("box")}><Box size={14} /></button>
          <button className={`toolbar-btn icon-only ${selectionTool === "circle" ? "active" : ""}`} title="Circle select (C, wheel radius)" onClick={() => armSelectionTool("circle")}><Circle size={14} /></button>
        </div>
        <div className="geometry-transform-buttons">
          <button className="toolbar-btn icon-only" title="Move (G)" disabled={!selectionCount} onClick={() => startTransform("translate")}><Move size={14} /></button>
          <button className="toolbar-btn icon-only" title="Rotate (R)" disabled={!selectionCount} onClick={() => startTransform("rotate")}><Rotate3d size={14} /></button>
          <button className="toolbar-btn icon-only" title="Scale (S)" disabled={!selectionCount} onClick={() => startTransform("scale")}><Scale3d size={14} /></button>
        </div>
        <button className={`toolbar-btn icon-only ${proportional ? "active" : ""}`} title="Proportional editing (O)" onClick={toggleProportional}><Magnet size={14} /></button>
        <button className={`toolbar-btn icon-only ${xray ? "active" : ""}`} title="X-Ray (Alt+Z)" onClick={toggleXray}><Eye size={14} /></button>
        <button className="toolbar-btn icon-only" title="Extrude (E)" disabled={mode !== "face" || !selectionCount} onClick={startExtrude}><Move size={14} /></button>
        <button className="toolbar-btn icon-only" title="Loop cut (Ctrl+R)" onClick={startLoopCut}><Scissors size={14} /></button>
        <button className={`toolbar-btn icon-only ${showSceneContext ? "active" : ""}`} title="Scene context" onClick={() => setShowSceneContext((value) => !value)}><Layers size={14} /></button>
        <button className="toolbar-btn icon-only" title="Planar UV" onClick={() => mutate((value) => unwrapPlanar(value.editable, "z"))}><Triangle size={14} /></button>
        <button className="toolbar-btn icon-only" title="Box UV" onClick={() => mutate((value) => unwrapBox(value.editable))}><Box size={14} /></button>
        <button className="toolbar-btn icon-only" title="Undo (Ctrl+Z)" disabled={!session?.history.length} onClick={undo}><Undo2 size={14} /></button>
        <span className="geometry-editor-spacer" />
        <span className="geometry-editor-stat geometry-topology-count" key={revision} title={`${session?.editable.positions.length ?? 0} vertices / ${session?.editable.faces.length ?? 0} triangles`}>{session?.editable.positions.length ?? 0}v · {session?.editable.faces.length ?? 0}t</span>
        <button
          className="toolbar-btn geometry-confirm"
          disabled={!component.props.geometryAsset}
          title={component.props.geometryAsset || "Use Save New for primitive geometry"}
          onClick={() => saveGeometry()}
        ><Save size={14} /></button>
        <button className="toolbar-btn geometry-confirm icon-only" title="Save new geometry" onClick={() => saveGeometry({ saveNew: true })}>
          <Save size={14} />
        </button>
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
          <strong>{macroState.kind === "translate" ? "Move" : macroState.kind === "rotate" ? "Rotate" : macroState.kind === "extrude" ? "Extrude" : macroState.kind === "loopcut" ? "Loop Cut" : "Scale"}</strong>
          {macroState.kind === "loopcut" && <span className="geometry-transform-value">{macroState.segments ?? 1}×</span>}
          <span>{macroState.kind === "loopcut" ? "Slide" : macroState.axis ? macroState.axis.toUpperCase() : macroState.kind === "rotate" ? "View" : macroState.kind === "extrude" ? "Normal" : "Free"}</span>
          {macroState.buffer && <span className="geometry-transform-value">{macroState.buffer}{macroState.kind === "rotate" ? "°" : ""}</span>}
          <small>{macroState.kind === "loopcut" && macroState.locked ? "Slide · LMB confirm · Esc cancel" : macroState.kind === "loopcut" ? "Scroll cuts · LMB set · Esc cancel" : "LMB / Enter confirm · Esc / RMB cancel"}</small>
        </div>
      )}
      <div className="geometry-editor-shortcuts"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> <kbd>B</kbd> box <kbd>C</kbd> circle <kbd>O</kbd> prop <kbd>Alt+Z</kbd> xray <kbd>G/R/S</kbd> <kbd>E</kbd> <kbd>Ctrl+R</kbd> <kbd>X</kbd> <kbd>MMB</kbd> orbit</div>
      {status && <div className="geometry-editor-status">{status}</div>}
    </div>
  );
}
