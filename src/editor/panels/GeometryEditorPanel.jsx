import { useEffect, useRef, useState } from "react";
import { Box, Save, Undo2, X } from "lucide-react";
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

function refreshOverlays(session) {
  const { editable, selections, faceOverlay, edgeOverlay, vertexOverlay, basePoints } = session;
  const facePositions = [...selections.face].flatMap((index) =>
    editable.faces[index]?.flatMap((vertex) => editable.positions[vertex]) ?? [],
  );
  setPositions(faceOverlay.geometry, facePositions);
  faceOverlay.visible = facePositions.length > 0;

  const edges = logicalEdges(editable, session.forcedEdges);
  const edgePositions = [...selections.edge].flatMap((key) => {
    const edge = edges.get(key);
    return edge ? [...editable.positions[edge.a], ...editable.positions[edge.b]] : [];
  });
  setPositions(edgeOverlay.geometry, edgePositions);
  edgeOverlay.visible = edgePositions.length > 0;

  const uniquePositions = new Map(editable.positions.map((position) => [positionKey(position), position]));
  setPositions(basePoints.geometry, [...uniquePositions.values()].flat());
  const vertexPositions = [...selections.vertex].flatMap((key) => uniquePositions.get(key) ?? []);
  setPositions(vertexOverlay.geometry, vertexPositions);
  vertexOverlay.visible = vertexPositions.length > 0;
  basePoints.visible = session.mode === "vertex";
}

function pickElement(session, hit) {
  const { editable, mode } = session;
  const faceIndex = hit.faceIndex;
  const face = editable.faces[faceIndex];
  if (!face) return [];
  if (mode === "face") return coplanarFaceGroup(editable, faceIndex);
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
  const cutPoint = macro.edgeStart.clone().lerp(macro.edgeEnd, t);
  Object.assign(session.editable, cloneEditable(macro.before));
  const result = cutMeshByPlane(session.editable, macro.edgeDirection.toArray(), cutPoint.toArray(), macro.seedFace);
  session.forcedEdges = new Set(result.edgeKeys);
  session.selections.edge = new Set(result.edgeKeys);
  macro.t = t;
  session.rebuild();
}

function selectedVertexIndices(session) {
  const { editable, selections, mode } = session;
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
  indices.forEach((index, i) => {
    const point = positions[i].clone();
    if (kind === "translate") point.add(translation);
    if (kind === "extrude") point.add(translation);
    if (kind === "rotate") point.sub(pivot).applyQuaternion(quaternion).add(pivot);
    if (kind === "scale") {
      point.sub(pivot);
      if (axis) {
        if (axis === "x") point.x *= factor;
        if (axis === "y") point.y *= factor;
        if (axis === "z") point.z *= factor;
      } else point.multiplyScalar(factor);
      point.add(pivot);
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
  const entity = entityId ? engine.getEntity(entityId) : null;
  const component = entity?.getComponent("mesh");

  useEffect(() => {
    if (sessionRef.current?.context) sessionRef.current.context.visible = showSceneContext;
  }, [showSceneContext]);

  const changeMode = (next) => {
    const session = sessionRef.current;
    if (session) {
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
      kind: "extrude", axis: null, buffer: "", indices: result.vertexIndices, positions, pivot,
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
      before: cloneEditable(session.editable), beforeSelections: cloneSelections(session.selections),
      beforeForcedEdges: new Set(session.forcedEdges), beforeMode,
      pivot: new THREE.Vector3(), start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    applyTransformMacro(session);
    setMacroState({ kind: "loopcut", axis: null, buffer: "" });
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
    session.macro = {
      kind, axis: null, buffer: "", indices, positions, pivot, edges,
      before: cloneEditable(session.editable), beforeSelections: cloneSelections(session.selections),
      beforeForcedEdges: new Set(session.forcedEdges), beforeMode: session.mode,
      start: { ...pointer }, current: { ...pointer },
    };
    session.controls.enabled = false;
    setMacroState({ kind, axis: null, buffer: "" });
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") { event.preventDefault(); startLoopCut(); return; }
    if (event.ctrlKey && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); return; }
    if (["1", "2", "3"].includes(event.key)) { event.preventDefault(); changeMode(MODES[Number(event.key) - 1]); return; }
    if (event.key.toLowerCase() === "a") { event.preventDefault(); event.altKey ? clearSelection() : selectAll(); return; }
    if (event.key.toLowerCase() === "e" && mode === "face") { event.preventDefault(); startExtrude(); return; }
    if (event.key.toLowerCase() === "u") { event.preventDefault(); mutate((session) => unwrapBox(session.editable)); }
    if (event.key.toLowerCase() === "g") { event.preventDefault(); startTransform("translate"); }
    if (event.key.toLowerCase() === "r") { event.preventDefault(); startTransform("rotate"); }
    if (event.key.toLowerCase() === "s") { event.preventDefault(); startTransform("scale"); }
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
    scene.background = new THREE.Color(0x111417);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
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
      const color = source.material?.color?.clone?.() ?? new THREE.Color(0x65717a);
      const material = new THREE.MeshStandardMaterial({
        color,
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
    // Render the editor copy with the same material instance as the runtime
    // mesh. Geometry editing must show the actual surface/texture, not a gray
    // preview substitute. Runtime materials are shared and never disposed by
    // this temporary editor scene.
    const editMaterial = component.mesh.material;
    const mesh = new THREE.Mesh(bufferGeometryFromEditable(editable), editMaterial);
    mesh.userData.sharedMaterial = true;
    scene.add(mesh);
    const wire = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x33414b }));
    const basePoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x202a31, size: 7, sizeAttenuation: false, depthTest: false }));
    const faceOverlay = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xf28b30, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false }));
    const edgeOverlay = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff9b42, depthTest: false }));
    const vertexOverlay = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xff9b42, size: 10, sizeAttenuation: false, depthTest: false }));
    [wire, basePoints, faceOverlay, edgeOverlay, vertexOverlay].forEach((object, index) => { object.renderOrder = 5 + index; mesh.add(object); });

    const session = {
      editable, original, mesh, wire, basePoints, faceOverlay, edgeOverlay, vertexOverlay, context,
      camera, controls, canvas, forcedEdges: new Set(), mode: "face", selections: { vertex: new Set(), edge: new Set(), face: new Set() }, history: [], macro: null,
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
    session.rebuild();

    const unsubscribeMaterial = engine.on("component-changed", (info) => {
      if (info.entityId !== entityId || info.componentType !== "mesh" || info.key !== "material") return;
      mesh.material = component.mesh?.material ?? editMaterial;
      mesh.userData.sharedMaterial = true;
    });

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
      down = [event.clientX, event.clientY];
      session.lastPointer = { x: event.clientX, y: event.clientY };
      canvas.focus();
    };
    const onPointerUp = (event) => {
      if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 4) return;
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
    const onWindowPointerMove = (event) => {
      session.lastPointer = { x: event.clientX, y: event.clientY };
      if (!session.macro) return;
      session.macro.current = { x: event.clientX, y: event.clientY };
      if (!session.macro.buffer) applyTransformMacro(session);
    };
    const onWindowPointerDown = (event) => {
      if (!session.macro) return;
      if (event.button === 0) commitTransform();
      else if (event.button === 2) {
        session.preventContextOnce = true;
        cancelTransform();
      }
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onContextMenu = (event) => {
      if (session.macro || session.preventContextOnce) {
        event.preventDefault();
        session.preventContextOnce = false;
      }
    };
    const onBlur = () => cancelTransform();
    window.addEventListener("pointermove", onWindowPointerMove, true);
    window.addEventListener("pointerdown", onWindowPointerDown, true);
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
      window.removeEventListener("pointermove", onWindowPointerMove, true);
      window.removeEventListener("pointerdown", onWindowPointerDown, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("blur", onBlur);
      controls.dispose();
      scene.traverse((object) => {
        if (!object.userData?.sharedGeometry) object.geometry?.dispose?.();
        if (!object.userData?.sharedMaterial) object.material?.dispose?.();
      });
      unsubscribeMaterial();
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
          {MODES.map((item, index) => <button key={item} className={`toolbar-btn ${mode === item ? "active" : ""}`} onClick={() => changeMode(item)}><kbd>{index + 1}</kbd>{MODE_LABELS[item]}</button>)}
        </div>
        <span className="geometry-editor-stat">{selectionCount} selected</span>
        <div className="geometry-transform-buttons">
          <button className="toolbar-btn" disabled={!selectionCount} onClick={() => startTransform("translate")}><kbd>G</kbd></button>
          <button className="toolbar-btn" disabled={!selectionCount} onClick={() => startTransform("rotate")}><kbd>R</kbd></button>
          <button className="toolbar-btn" disabled={!selectionCount} onClick={() => startTransform("scale")}><kbd>S</kbd></button>
        </div>
        <button className="toolbar-btn" disabled={mode !== "face" || !selectionCount} onClick={startExtrude}><kbd>E</kbd> Extrude</button>
        <button className="toolbar-btn" title="Loop cut under cursor" onClick={startLoopCut}><kbd>Ctrl+R</kbd> Loop Cut</button>
        <button className={`toolbar-btn ${showSceneContext ? "active" : ""}`} onClick={() => setShowSceneContext((value) => !value)}>
          Scene Context
        </button>
        <button className="toolbar-btn" onClick={() => mutate((value) => unwrapPlanar(value.editable, "z"))}>Planar UV</button>
        <button className="toolbar-btn" onClick={() => mutate((value) => unwrapBox(value.editable))}><Box size={13} /> Box UV</button>
        <button className="toolbar-btn icon-only" title="Undo (Ctrl+Z)" disabled={!session?.history.length} onClick={undo}><Undo2 size={14} /></button>
        <span className="geometry-editor-spacer" />
        <span className="geometry-editor-stat" key={revision}>{session?.editable.positions.length ?? 0} verts / {session?.editable.faces.length ?? 0} tris</span>
        <button
          className="toolbar-btn geometry-confirm"
          disabled={!component.props.geometryAsset}
          title={component.props.geometryAsset || "Use Save New for primitive geometry"}
          onClick={() => saveGeometry()}
        ><Save size={14} /> Save</button>
        <button className="toolbar-btn geometry-confirm" onClick={() => saveGeometry({ saveNew: true })}>
          <Save size={14} /> Save New
        </button>
        {embedded && <button className="toolbar-btn icon-only" title="Cancel scene edit" onClick={onClose}><X size={14} /></button>}
      </div>
      <div className="geometry-editor-viewport" ref={hostRef} />
      {macroState && (
        <div className="geometry-transform-hud">
          <strong>{macroState.kind === "translate" ? "Move" : macroState.kind === "rotate" ? "Rotate" : macroState.kind === "extrude" ? "Extrude" : macroState.kind === "loopcut" ? "Loop Cut" : "Scale"}</strong>
          <span>{macroState.kind === "loopcut" ? "Slide" : macroState.axis ? macroState.axis.toUpperCase() : macroState.kind === "rotate" ? "View" : macroState.kind === "extrude" ? "Normal" : "Free"}</span>
          {macroState.buffer && <span className="geometry-transform-value">{macroState.buffer}{macroState.kind === "rotate" ? "°" : ""}</span>}
          <small>Click / Enter confirm · Esc / RMB cancel</small>
        </div>
      )}
      <div className="geometry-editor-shortcuts"><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> modes <kbd>G/R/S</kbd> transform <kbd>E</kbd> extrude <kbd>Ctrl+R</kbd> loop cut <kbd>Del</kbd> delete <kbd>Ctrl+Z</kbd> undo</div>
      {status && <div className="geometry-editor-status">{status}</div>}
    </div>
  );
}
