import { useCallback, useRef } from "react";

/**
 * Drop targets for entities dragged out of the Hierarchy.
 *
 * The Hierarchy already runs a manual pointer drag for reparenting (HTML5 DnD
 * never reaches the webview under Tauri's `dragDropEnabled`). This is the
 * other half: a field anywhere in the editor — a camera's follow target, a
 * joint's connected body — registers itself here, and when the Hierarchy's
 * drag ends outside its own tree it asks this registry what is under the
 * pointer. Same shape as `assetDrag.js`, so a field can be both.
 *
 * `useEntityDrop({ accepts, onDrop })`: `accepts(ids)` is an optional
 * predicate over the dragged entity ids, `onDrop(ids, point)` receives them.
 */

const HOVER_CLASS = "entity-drop-hover";
const targets = new Map(); // element -> { accepts?, onDrop }
let hoverEl = null;

/** Ref-callback hook: attach the returned ref to the drop-target element. */
export function useEntityDrop(handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const elRef = useRef(null);
  return useCallback((el) => {
    if (elRef.current) targets.delete(elRef.current);
    elRef.current = el;
    if (el) {
      targets.set(el, {
        get accepts() {
          return handlerRef.current.accepts;
        },
        onDrop: (ids, point) => handlerRef.current.onDrop(ids, point),
      });
    }
  }, []);
}

/** Deepest registered target under the pointer that accepts `ids`, or null. */
export function hitTestEntityDrop(x, y, ids) {
  let node = document.elementFromPoint(x, y);
  while (node) {
    const handler = targets.get(node);
    if (handler) return !handler.accepts || handler.accepts(ids) ? { el: node, handler } : null;
    node = node.parentElement;
  }
  return null;
}

/** Marks the target the drag is over (null clears it). */
export function setEntityDropHover(el) {
  if (hoverEl === el) return;
  hoverEl?.classList.remove(HOVER_CLASS);
  hoverEl = el;
  el?.classList.add(HOVER_CLASS);
}
