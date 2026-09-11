import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { engine } from "./engineInstance.js";
import { EDITOR_LAYER } from "../engine/editorLayers.js";
import { getComponentClass } from "../engine/components/registry.js";
import { generateArchitecture } from "../modules/architecture/blueprints.js";
import { buildBlockoutGeometry } from "../modules/level-design/blockoutGeometry.js";
import { createArchitecture, resolveArchitecturePlacement } from "./architectureBuild.js";
import { disarmArchitectureTool } from "./architectureTool.js";
import { disarmTerrainBrush } from "./terrainBrush.js";
import { useHistoryStore } from "./commands/CommandBus.js";

let state = { active: false, settings: {}, rotationY: 0, elevation: 0, grid: 1, parentId: null, error: "", position: null, previewPieceCount: 0, warnings: [], lastEntityId: null };
let plan = null;
let revision = 0;
let teardownPrevious = null;
const listeners = new Set();
const notify = () => { for (const listener of listeners) listener(); };
const finite = (value, label, min = -1e7, max = 1e7) => {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number between ${min} and ${max}.`);
  return value;
};
function compile(settings) {
  const recipe = generateArchitecture(settings);
  const count = recipe.buildings.reduce((n, b) => n + b.floors.reduce((m, f) => m + f.pieces.length, 0), 0);
  if (!recipe.buildings.length || !count) throw new Error(recipe.warnings.join(" ") || "Choose a recipe with pieces to place.");
  return { recipe, count };
}
function target(parentId) {
  if (parentId && !engine.getEntity(parentId)) throw new Error("The placement parent no longer exists.");
  return parentId ?? null;
}

export function isArchitecturePlacementActive() { return state.active; }
export function getArchitecturePlacementState() { return { ...state, settings: structuredClone(state.settings), position: state.position ? [...state.position] : null, warnings: [...state.warnings] }; }
export function subscribeArchitecturePlacement(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export function armArchitecturePlacement({ settings = {}, rotationY = 0, elevation = 0, grid = 1, parentId = null } = {}) {
  if (!getComponentClass("architecturepiece")) throw new Error("Enable Architecture before placing structures.");
  finite(rotationY, "Rotation"); finite(elevation, "Elevation"); finite(grid, "Grid", 0, 100);
  target(parentId);
  const { recipe, count } = compile(settings);
  disarmArchitectureTool();
  disarmTerrainBrush();
  plan = recipe;
  state = { active: true, settings: structuredClone(recipe.settings), rotationY, elevation, grid, parentId, error: "", position: null, previewPieceCount: count, warnings: [...recipe.warnings], lastEntityId: null };
  revision++;
  notify();
  return getArchitecturePlacementState();
}

export function disarmArchitecturePlacement() {
  const active = state.active;
  state = { ...state, active: false, error: "", position: null };
  plan = null;
  notify();
  return active;
}

export function setArchitecturePlacementSetting(key, value) {
  if (["rotationY", "elevation", "grid"].includes(key)) {
    finite(value, key, key === "grid" ? 0 : -1e7, key === "grid" ? 100 : 1e7);
    state = { ...state, [key]: value, error: "" };
  } else if (key === "parentId") state = { ...state, parentId: target(value), error: "" };
  else {
    const { recipe, count } = compile(key === "settings" ? value : { ...state.settings, [key]: value });
    plan = recipe;
    state = { ...state, settings: structuredClone(recipe.settings), previewPieceCount: count, warnings: [...recipe.warnings], error: "" };
    revision++;
  }
  notify();
  return getArchitecturePlacementState();
}

/** Called by the viewport's existing keyboard scope, after text inputs are excluded. */
export function dispatchArchitecturePlacementKey(event) {
  if (!state.active || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return false;
  const key = event.key?.toLowerCase();
  if (key === "escape") { disarmArchitecturePlacement(); return true; }
  if (key === "r") { setArchitecturePlacementSetting("rotationY", state.rotationY + (event.shiftKey ? -1 : 1) * Math.PI / 2); return true; }
  return false;
}

function ghostGeometry(recipe) {
  const group = new THREE.Group();
  group.userData.architecturePlacementPreview = true;
  group.userData.editorOnly = true;
  group.layers.set(EDITOR_LAYER);
  group.visible = false;
  const material = new THREE.LineBasicMaterial({ color: 0x91cbb3, transparent: true, opacity: .78, depthWrite: false, depthTest: true });
  for (const building of recipe.buildings) {
    const geometries = [];
    for (const assembly of building.floors) for (const piece of assembly.pieces) {
      const { geometry } = buildBlockoutGeometry(piece.shape, { ...piece.props, size: piece.size });
      const edges = new THREE.EdgesGeometry(geometry, 25);
      geometry.dispose();
      const position = new THREE.Vector3(...piece.position); position.y += assembly.elevation;
      const rotation = piece.rotation ?? [0, piece.rotationY ?? 0, 0];
      edges.applyMatrix4(new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1)));
      geometries.push(edges);
    }
    const merged = geometries.length ? mergeGeometries(geometries, false) : new THREE.BufferGeometry();
    for (const geometry of geometries) geometry.dispose();
    const lines = new THREE.LineSegments(merged, material);
    lines.userData.editorOnly = true;
    lines.layers.set(EDITOR_LAYER);
    lines.raycast = () => {};
    lines.position.fromArray(building.position);
    lines.rotation.y = building.rotationY ?? 0;
    group.add(lines);
  }
  return group;
}

function disposeGhost(group) {
  if (!group) return;
  const materials = new Set();
  group.traverse((object) => { object.geometry?.dispose(); if (object.material) materials.add(object.material); });
  for (const material of materials) material.dispose();
  group.removeFromParent();
}

/** One canvas owner. Overlay DOM controls are siblings of the canvas and never
 * pass through these handlers. Pointer capture ends only this stamp gesture. */
export function setupArchitecturePlacementTool(canvas, viewport) {
  teardownPrevious?.();
  const raycaster = new THREE.Raycaster();
  raycaster.layers.enableAll();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0));
  const originalMiddle = viewport.orbit?.mouseButtons?.MIDDLE;
  let ghost = null, ghostRevision = -1, pointer = null, down = null, alt = false, ctrl = false;
  let surfaces = [], surfacesDirty = true, originalOrbitEnabled = true;
  const validTarget = (event) => event.target === canvas;
  const error = (message) => {
    if (state.error === message) return;
    state = { ...state, error: message };
    notify();
  };
  const collectSurfaces = () => {
    if (!surfacesDirty) return;
    surfacesDirty = false; surfaces = [];
    const visit = (object) => {
      if (object.userData?.editorOnly || object.visible === false) return;
      if (object.isMesh && object.geometry && !object.userData?.architecturePlacementPreview) surfaces.push(object);
      for (const child of object.children ?? []) visit(child);
    };
    for (const child of engine.scene.children) visit(child);
  };
  const hit = () => {
    if (!pointer || !viewport.camera) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ndc.set((pointer.x - rect.left) / rect.width * 2 - 1, -(pointer.y - rect.top) / rect.height * 2 + 1);
    viewport.camera.updateWorldMatrix(true, false);
    raycaster.setFromCamera(ndc, viewport.camera);
    engine.scene.updateMatrixWorld();
    collectSurfaces();
    const intersection = raycaster.intersectObjects(surfaces, false)[0];
    plane.constant = -state.elevation;
    const point = intersection?.point?.clone() ?? raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!point) return null;
    // On geometry, Elevation is a vertical offset above the hit surface. In
    // empty space the same value is the world height of the fallback plane.
    if (intersection) point.y += state.elevation;
    const grid = ctrl ? 0 : state.grid;
    if (grid > 0) { point.x = Math.round(point.x / grid) * grid; point.z = Math.round(point.z / grid) * grid; }
    return point.toArray();
  };
  const cancelPress = () => {
    if (!down) return;
    if (down.pointerId !== undefined && canvas.hasPointerCapture?.(down.pointerId)) canvas.releasePointerCapture(down.pointerId);
    down = null;
    if (viewport.orbit) viewport.orbit.enabled = originalOrbitEnabled;
  };
  const refresh = () => {
    if (!state.active || engine.playing) {
      cancelPress();
      disposeGhost(ghost); ghost = null; ghostRevision = -1;
      canvas.style.cursor = "";
      if (viewport.orbit?.mouseButtons) viewport.orbit.mouseButtons.MIDDLE = originalMiddle;
      return;
    }
    if (state.parentId && !engine.getEntity(state.parentId)) { disarmArchitecturePlacement(); return; }
    if (!ghost || ghostRevision !== revision) {
      disposeGhost(ghost);
      ghost = ghostGeometry(plan); ghostRevision = revision;
      engine.scene.add(ghost);
    }
    if (viewport.orbit?.mouseButtons) viewport.orbit.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    canvas.style.cursor = alt ? "grab" : "crosshair";
    ghost.visible = !alt && !!pointer;
    if (!ghost.visible) return;
    const position = hit();
    if (!position) { ghost.visible = false; state.position = null; return; }
    state.position = position;
    try {
      const placed = resolveArchitecturePlacement(plan, { position, rotationY: state.rotationY, parentId: state.parentId });
      ghost.position.fromArray(position);
      ghost.rotation.y = state.rotationY;
      placed.buildings.forEach((building, index) => ghost.children[index].position.fromArray(building.position));
      state.warnings = placed.warnings;
      if (state.error) error("");
    } catch (cause) {
      ghost.visible = false;
      error(cause?.message ?? String(cause));
    }
  };
  const remember = (event) => { pointer = { x: event.clientX, y: event.clientY }; alt = !!event.altKey; ctrl = !!event.ctrlKey; };
  const onMove = (event) => {
    if (!state.active || engine.playing || !validTarget(event)) return;
    remember(event); refresh();
  };
  const onDown = (event) => {
    if (!state.active || engine.playing || !validTarget(event) || event.button !== 0 || event.altKey) return;
    remember(event); refresh();
    event.preventDefault(); event.stopImmediatePropagation();
    if (!state.position || state.error) return;
    down = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    originalOrbitEnabled = viewport.orbit?.enabled ?? true;
    if (viewport.orbit) viewport.orbit.enabled = false;
    if (event.pointerId !== undefined) canvas.setPointerCapture?.(event.pointerId);
  };
  const onUp = (event) => {
    if (!down || event.button !== 0) return;
    const press = down;
    cancelPress();
    event.preventDefault(); event.stopImmediatePropagation();
    if (!state.active || engine.playing || event.altKey || Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return;
    const rect = canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.left + rect.width || event.clientY < rect.top || event.clientY > rect.top + rect.height) return;
    remember(event); refresh();
    if (!state.position || state.error) return;
    try {
      const result = createArchitecture(state.settings, { position: state.position, rotationY: state.rotationY, parentId: state.parentId });
      state = { ...state, lastEntityId: result.entityId, error: "", warnings: result.warnings };
      surfacesDirty = true;
      // Keep the recipe armed and refresh surfaces so the next stamp can
      // deliberately snap onto newly created roofs for stacking.
      notify();
    } catch (cause) { error(cause?.message ?? String(cause)); }
  };
  const onLeave = () => { if (down) return; pointer = null; if (ghost) ghost.visible = false; };
  const onModifier = (event) => {
    if (!state.active || !pointer) return;
    const changed = alt !== !!event.altKey || ctrl !== !!event.ctrlKey;
    alt = !!event.altKey; ctrl = !!event.ctrlKey;
    if (changed) refresh();
  };
  const onTree = () => { surfacesDirty = true; };
  canvas.addEventListener("pointerdown", onDown, true);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp, true);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointercancel", cancelPress);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onModifier);
  window.addEventListener("keyup", onModifier);
  const unsub = subscribeArchitecturePlacement(refresh);
  const unHistory = useHistoryStore.subscribe((history) => {
    surfacesDirty = true;
    // Editor scene swaps clear both history stacks, including same-file reload.
    // Ordinary undo leaves a redo entry and keeps repeated placement armed.
    if (state.active && !history.canUndo && !history.canRedo) { disarmArchitecturePlacement(); return; }
    refresh();
  });
  const unTree = engine.on?.("hierarchy-changed", onTree);
  const unPlay = engine.on?.("play-changed", refresh);
  const unScene = engine.on?.("scene-load-start", disarmArchitecturePlacement);
  refresh();
  const teardown = () => {
    cancelPress(); disposeGhost(ghost); ghost = null;
    canvas.removeEventListener("pointerdown", onDown, true); canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp, true); canvas.removeEventListener("pointerleave", onLeave); canvas.removeEventListener("pointercancel", cancelPress);
    window.removeEventListener("pointerup", onUp, true); window.removeEventListener("keydown", onModifier); window.removeEventListener("keyup", onModifier);
    unsub(); unHistory(); unTree?.(); unPlay?.(); unScene?.(); canvas.style.cursor = "";
    if (viewport.orbit?.mouseButtons) viewport.orbit.mouseButtons.MIDDLE = originalMiddle;
    if (teardownPrevious === teardown) teardownPrevious = null;
  };
  teardownPrevious = teardown;
  return teardown;
}
