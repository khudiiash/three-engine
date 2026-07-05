import { useCallback, useRef } from "react";
import { extOf } from "./assetLoader.js";

/**
 * Pointer-based drag-and-drop for asset paths. Tauri's `dragDropEnabled`
 * (needed for OS file imports) swallows the webview's HTML5 DnD wholesale —
 * dragstart/dragover/drop never fire — so, like HierarchyPanel's entity drag,
 * asset drags are a manual pointerdown/pointermove/pointerup gesture with
 * DOM `elementFromPoint` hit-testing against registered drop targets.
 *
 * Sources call `armAssetDrag(e, path)` on pointerdown. Targets register via
 * the `useAssetDrop({ accepts, onDrop })` hook (or `registerAssetDropTarget`
 * for non-React code) — `accepts` is an extension array or a predicate,
 * `onDrop(path, point)` receives the dragged path and the drop point.
 */

const DRAG_THRESHOLD_PX = 5;
const HOVER_CLASS = "asset-drop-hover";

const dropTargets = new Map(); // element -> { accepts?, onDrop, hoverClass? }

let session = null; // { path, isDir, startX, startY, moved, ghost }
let hoverEl = null;
let suppressClickUntil = 0;

export function registerAssetDropTarget(el, handler) {
  dropTargets.set(el, handler);
  return () => dropTargets.delete(el);
}

/** Ref-callback hook: attach the returned ref to the drop-target element. */
export function useAssetDrop(handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const elRef = useRef(null);
  return useCallback((el) => {
    if (elRef.current) dropTargets.delete(elRef.current);
    elRef.current = el;
    if (el) {
      dropTargets.set(el, {
        get accepts() {
          return handlerRef.current.accepts;
        },
        get hoverClass() {
          return handlerRef.current.hoverClass;
        },
        onDrop: (path, point) => handlerRef.current.onDrop(path, point),
      });
    }
  }, []);
}

/** Call from pointerdown on a draggable asset tile. */
export function armAssetDrag(e, path, { isDir = false } = {}) {
  if (e.button !== 0) return;
  session = { path, isDir, startX: e.clientX, startY: e.clientY, moved: false, ghost: null };
}

/** True while a drag gesture is in flight (targets can use it to style). */
export function isAssetDragActive() {
  return !!session?.moved;
}

/** Tile onClick guard: returns true if the click ended a drag gesture. */
export function consumeAssetDragClick() {
  return performance.now() < suppressClickUntil;
}

function targetAccepts(handler, path, isDir) {
  const { accepts } = handler;
  if (accepts == null) return true;
  if (typeof accepts === "function") return accepts(path, isDir);
  return !isDir && accepts.includes(extOf(path));
}

/** Deepest registered drop target under the pointer that accepts the path. */
function hitTest(x, y, path, isDir) {
  let node = document.elementFromPoint(x, y);
  while (node) {
    const handler = dropTargets.get(node);
    if (handler) return targetAccepts(handler, path, isDir) ? { el: node, handler } : null;
    node = node.parentElement;
  }
  return null;
}

function setHover(el, handler) {
  if (hoverEl === el) return;
  hoverEl?.classList.remove(hoverEl._assetHoverClass ?? HOVER_CLASS);
  hoverEl = el;
  if (el) {
    el._assetHoverClass = handler?.hoverClass ?? HOVER_CLASS;
    el.classList.add(el._assetHoverClass);
  }
}

function makeGhost(path) {
  const ghost = document.createElement("div");
  ghost.className = "hierarchy-drag-ghost asset-drag-ghost";
  ghost.textContent = path.split(/[\\/]/).pop() ?? path;
  document.body.appendChild(ghost);
  return ghost;
}

function endSession() {
  session?.ghost?.remove();
  session = null;
  setHover(null);
}

function onPointerMove(e) {
  if (!session) return;
  if (!session.moved) {
    if (Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < DRAG_THRESHOLD_PX) return;
    session.moved = true;
    session.ghost = makeGhost(session.path);
  }
  session.ghost.style.left = `${e.clientX}px`;
  session.ghost.style.top = `${e.clientY}px`;
  const hit = hitTest(e.clientX, e.clientY, session.path, session.isDir);
  setHover(hit?.el ?? null, hit?.handler);
}

function onPointerUp(e) {
  if (!session) return;
  if (session.moved) {
    suppressClickUntil = performance.now() + 300;
    const hit = hitTest(e.clientX, e.clientY, session.path, session.isDir);
    const { path } = session;
    endSession();
    hit?.handler.onDrop(path, { clientX: e.clientX, clientY: e.clientY });
  } else {
    endSession();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("blur", endSession);
}
