// @ts-check
import { engine } from "./engineInstance.js";
import { getViewportHandle } from "./viewportHandle.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { resolveSelectionTarget } from "./pickTarget.js";
import {
  collectSelectionCandidates,
  frustumFromNdcRect,
  idsInFrustum,
  ndcRectFromPixels,
} from "./boxSelect.js";

/**
 * "What does a screen rectangle select?", for callers that have a rectangle
 * but no pointer — the editor API's `selection.selectInRect`, and the shared
 * tail of the drag gesture in viewportBoxSelect.js.
 *
 * Kept apart from the gesture on purpose: that module reaches into spline edit
 * mode, the terrain brush and the geometry editor to decide whether the left
 * button is free, and an op has no business dragging any of that in just to
 * turn a rectangle into a list of ids.
 */

/**
 * Maps the entities that OWN the hit geometry to the entities a selection
 * should actually contain — the prefab-root rule in pickTarget.js.
 *
 * @param {Iterable<string>} ids
 * @param {any[]} [selected]  selection to judge "already drilled in" against
 * @returns {Set<string>}
 */
export function resolveTargets(ids, selected) {
  const out = new Set();
  for (const id of ids) {
    const entity = engine.getEntity(id);
    const target = entity ? resolveSelectionTarget(entity, { selected }) : null;
    if (target) out.add(target.id);
  }
  return out;
}

/** Live selection as entities, for the "already drilled in" test. */
function selectedEntities() {
  return useSelectionStore.getState().ids.map((id) => engine.getEntity(id)).filter(Boolean);
}

/** CSS pixel size of the viewport canvas — the coordinate space rectangles are
 *  given in. Callers working from a screenshot need it because
 *  `viewport.screenshot` renders at whatever size it was asked for, which is
 *  almost never the size of the canvas on screen. */
export function viewportPixelSize() {
  const canvas = getViewportHandle()?.canvas;
  return {
    width: canvas?.clientWidth || canvas?.width || 1,
    height: canvas?.clientHeight || canvas?.height || 1,
  };
}

/**
 * Entity ids a screen rectangle touches, with no side effects.
 *
 * @param {{left:number, top:number, right:number, bottom:number}} rect  canvas pixels, origin top-left
 * @returns {string[]}
 */
export function entitiesInScreenRect(rect) {
  const viewport = getViewportHandle();
  if (!viewport?.camera) throw new Error("No viewport is open.");
  const frustum = frustumFromNdcRect(ndcRectFromPixels(rect, viewportPixelSize()), viewport.camera);
  const candidates = collectSelectionCandidates(engine.scene, engine.entities.values());
  return [...resolveTargets(idsInFrustum(candidates, frustum), selectedEntities())];
}

/**
 * ...and apply it to the selection. Same three modes as the drag gesture.
 *
 * @param {{left:number, top:number, right:number, bottom:number}} rect
 * @param {"replace"|"add"|"remove"} [mode]
 * @returns {{touched: string[], entityIds: string[]}}
 */
export function selectInScreenRect(rect, mode = "replace") {
  const touched = entitiesInScreenRect(rect);
  const selection = useSelectionStore.getState();
  if (mode === "add") selection.add(touched);
  else if (mode === "remove") selection.remove(touched);
  else if (touched.length) selection.select(touched);
  else selection.clear();
  return { touched, entityIds: [...useSelectionStore.getState().ids] };
}
