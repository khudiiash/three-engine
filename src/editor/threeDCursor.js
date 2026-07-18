import * as THREE from "three/webgpu";
import { EDITOR_LAYER } from "../engine/editorLayers.js";
import { engine } from "./engineInstance.js";
import { useSelectionStore } from "./store/selectionStore.js";

/**
 * Blender-style 3D cursor.
 *
 * A persistent world-space point (default origin) that drives a handful of
 * secondary actions:
 *
 *   - New meshes spawned via the hierarchy panel / asset drop without a
 *     pre-set transform land at the 3D cursor instead of (0,0,0).
 *   - "Snap Selection to Cursor" (Shift+S) re-positions every selected
 *     entity so its origin lands on the cursor — like Blender's snap menu.
 *   - "Set Cursor to Selected" recenters the cursor on the selection
 *     centroid (orverts an entity's origin in geometry editor parlance).
 *   - The cursor also acts as a transform-origin for the gizmo when no
 *     entity is selected, so users can pre-place a target before dropping
 *     a primitive into the scene.
 *
 * The cursor is rendered as three red/green/blue short axes meeting at a
 * small disc — matching Blender's own widget without leaning on an
 * external asset. It lives on EDITOR_LAYER so play cameras ignore it, and
 * is excluded from picking raycasts (its `raycast` is a no-op).
 */

const DEFAULT_POSITION = Object.freeze([0, 0, 0]);

// 3D cursor state. Subscribers get notified on every position or active
// change so React components can render a readout and the viewport panel
// can toggle its visibility without polling.
const state = {
  position: [...DEFAULT_POSITION],
  visible: true,
  // When the cursor is "anchored" the gizmo treats it as the pivot for a
  // transient transform operation, even when there's no selection. This is
  // the in-engine analogue of Blender's "Transform Pivot Point: 3D Cursor".
  anchored: false,
};

const listeners = new Set();
function notify() {
  for (const fn of listeners) fn(snapshot());
}

function snapshot() {
  return {
    position: [...state.position],
    visible: !!state.visible,
    anchored: !!state.anchored,
  };
}

export function subscribeCursor3D(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getCursor3D() {
  return snapshot();
}

export function getCursor3DPosition(target = new THREE.Vector3()) {
  target.fromArray(state.position);
  return target;
}

export function setCursor3DPosition(xOrPos, y, z) {
  if (typeof xOrPos === "number") {
    state.position[0] = xOrPos;
    state.position[1] = y;
    state.position[2] = z;
  } else if (Array.isArray(xOrPos)) {
    [state.position[0], state.position[1], state.position[2]] = xOrPos;
  } else if (xOrPos?.isVector3) {
    state.position[0] = xOrPos.x;
    state.position[1] = xOrPos.y;
    state.position[2] = xOrPos.z;
  } else {
    return false;
  }
  ensureCursorProxy();
  if (cursorObject) {
    cursorObject.position.fromArray(state.position);
    cursorObject.updateMatrixWorld(true);
  }
  anchor.updateFromArray(state.position);
  notify();
  return true;
}

export function setCursor3DVisible(visible) {
  if (state.visible === !!visible) return;
  state.visible = !!visible;
  ensureCursorProxy();
  if (cursorObject) cursorObject.visible = state.visible;
  notify();
}

export function toggleCursor3DVisible() {
  setCursor3DVisible(!state.visible);
}

export function setCursor3DAnchored(anchored) {
  if (state.anchored === !!anchored) return;
  state.anchored = !!anchored;
  notify();
}

export function resetCursor3D() {
  setCursor3DPosition(0, 0, 0);
}

/** Centroid of the current selection in world space, or null when empty. */
export function selectionCentroid(target = new THREE.Vector3()) {
  const ids = useSelectionStore.getState().ids;
  if (!ids.length) return null;
  // Mirror what's actually rendered: traverse each entity's world matrix and
  // accumulate origin. Skips entities that the engine has dropped since the
  // last selection update (Gettransform would still return local data but
  // its world matrix would not be current).
  let count = 0;
  target.set(0, 0, 0);
  for (const id of ids) {
    const entity = engine.getEntity(id);
    if (!entity?.object3D) continue;
    entity.object3D.updateWorldMatrix(true, false);
    target.x += entity.object3D.matrixWorld.elements[12];
    target.y += entity.object3D.matrixWorld.elements[13];
    target.z += entity.object3D.matrixWorld.elements[14];
    count++;
  }
  if (!count) return null;
  target.multiplyScalar(1 / count);
  return target;
}

export function setCursor3DToSelection() {
  const centroid = selectionCentroid();
  if (!centroid) return false;
  setCursor3DPosition(centroid);
  return true;
}

// ---------------------------------------------------------------------------
// Three.js proxy: the small on-screen representation (3 crosshairs + disc).
// Built lazily so editors running the headless smoke test never instantiate
// WebGPU-only paths they don't need. `anchor` is a shared Vector3 the rest
// of the editor reads from to avoid allocating per frame.
//
// Two flavors exist:
//   - cursorObject    the "primary" proxy (the engine-scene one)
//   - additionalProxies detached scenes (the geometry editor's local scene)
//     track the same world position but through their own Object3D so the
//     detached camera/view sees the cursor without depending on the
//     engine scene existing.
// ---------------------------------------------------------------------------
let cursorObject = null;
let primaryBoundParent = null;
const additionalProxies = []; // [{ object3D, transform: (local) => Vector3 }]
const anchor = new THREE.Vector3();

function buildCursorProxy() {
  const group = new THREE.Group();
  group.name = "ThreeDCursor";
  group.userData.editorOnly = true;
  group.layers.set(EDITOR_LAYER);
  group.renderOrder = 998;

  // Disc — a small flat ring drawn with depthTest off so the cursor
  // remains visible even when occluded (Blender's own behaviour). Sizing
  // is in world units; a 0.18/0.55 pair is readable across the editor's
  // typical zoom levels without becoming a dot at distance.
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(0.18, 32),
    new THREE.MeshBasicMaterial({ color: 0xf9ec4d, transparent: true, opacity: 0.92, depthTest: false, depthWrite: false }),
  );
  fill.rotation.x = -Math.PI / 2;
  fill.renderOrder = 999;
  fill.raycast = () => {};

  const rim = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(buildRing(0.18, 32)),
    new THREE.LineBasicMaterial({ color: 0xf9ec4d, transparent: true, opacity: 0.9, depthTest: false }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.renderOrder = 999;
  rim.raycast = () => {};

  const makeAxis = (color, axis) => {
    const negative = new THREE.BufferGeometry();
    negative.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, ...axisToVec(axis, -0.55)], 3),
    );
    const positive = new THREE.BufferGeometry();
    positive.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, ...axisToVec(axis, 0.55)], 3),
    );
    return {
      neg: new THREE.Line(negative, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false })),
      pos: new THREE.Line(positive, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false })),
    };
  };

  const x = makeAxis(0xe24444, "x");
  const y = makeAxis(0x4caf50, "y");
  const z = makeAxis(0x4a90ff, "z");

  for (const obj of [fill, rim, x.neg, x.pos, y.neg, y.pos, z.neg, z.pos]) {
    obj.renderOrder = 999;
    obj.raycast = () => {};
    group.add(obj);
  }
  group.userData.noPick = true;
  group.raycast = () => {};
  return group;
}

function axisToVec(axis, scale) {
  if (axis === "x") return [scale, 0, 0];
  if (axis === "y") return [0, scale, 0];
  return [0, 0, scale];
}

function buildRing(radius, segments) {
  // WebGPURenderer rejects THREE.LineLoop (the WebGL legacy wrapper
  // around gl.LINE_LOOP). Use a plain THREE.Line and explicitly close
  // the polyline by repeating the first vertex at the end. This matches
  // the workaround the terrain brush indicator uses for its rim and
  // produces an identical circle when the segments are dense enough.
  const points = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  points.push(points[0].clone());
  return points;
}

function ensureCursorProxy() {
  if (cursorObject) return cursorObject;
  cursorObject = buildCursorProxy();
  cursorObject.position.fromArray(state.position);
  return cursorObject;
}

/**
 * Add an additional proxy that lives in a different scene (typically the
 * detached scene the geometry editor uses). The optional `localTransform`
 * callback lets callers express the cursor in that scene's local space
 * (e.g. entity-local coordinates for the geometry editor); when omitted
 * the proxy mirrors the world position.
 */
export function attachCursor(parent, { localTransform = null } = {}) {
  ensureCursorProxy();
  if (!parent) return cursorObject;
  // Primary proxy (engine.scene). refreshCursor3D is the per-frame owner
  // for binding, so this call only needs to make sure the proxy ends up
  // under `parent` (idempotent if already there).
  if (!localTransform) {
    if (cursorObject.parent !== parent) {
      if (cursorObject.parent) cursorObject.parent.remove(cursorObject);
      parent.add(cursorObject);
    }
    cursorObject.position.fromArray(state.position);
    cursorObject.visible = state.visible;
    primaryBoundParent = parent;
    return cursorObject;
  }
  // Additional proxy: separate Object3D with a custom position mapper.
  // The geometry editor uses this to mirror the world cursor into its
  // detached scene's local space.
  const proxy = buildCursorProxy();
  parent.add(proxy);
  additionalProxies.push({ object3D: proxy, localTransform });
  return proxy;
}

export function detachCursor() {
  if (cursorObject?.parent) cursorObject.parent.remove(cursorObject);
  primaryBoundParent = null;
  for (const entry of [...additionalProxies]) {
    if (entry.object3D.parent) entry.object3D.parent.remove(entry.object3D);
  }
  additionalProxies.length = 0;
}

/**
 * Per-frame refresh — keeps the primary proxy parented to engine.scene
 * (re-binding after hot-reloads), keeps its world position current, and
 * walks every additional proxy calling its `localTransform` so detached
 * scenes (the geometry editor) see the cursor in their own coordinate
 * system.
 */
export function refreshCursor3D() {
  ensureCursorProxy();
  if (!cursorObject) return;
  const scene = engine?.scene;
  if (!scene) return;
  if (cursorObject.parent !== scene) {
    if (cursorObject.parent) cursorObject.parent.remove(cursorObject);
    scene.add(cursorObject);
    primaryBoundParent = scene;
  }
  cursorObject.position.fromArray(state.position);
  // The cursor is editor-only — it shares the EDITOR_LAYER with the rest
  // of viewport.helpers, but the geometry editor's local proxy lives in
  // its own scene which has no play-mode gate. Force the visibility off
  // here so neither proxy leaks into the player render. The user's own
  // visibility toggle is restored automatically when `engine.playing`
  // flips back to false.
  cursorObject.visible = state.visible && !engine.playing;
  cursorObject.updateMatrixWorld(true);
  anchor.copy(cursorObject.position);
  for (const entry of additionalProxies) {
    if (!entry.object3D.parent) continue;
    const local = entry.localTransform();
    entry.object3D.position.copy(local);
    entry.object3D.visible = state.visible && !engine.playing;
    entry.object3D.updateMatrixWorld(true);
  }
}

export { anchor as cursorAnchor };
