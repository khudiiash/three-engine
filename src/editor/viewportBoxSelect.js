// @ts-check
import * as THREE from "three/webgpu";
import { engine } from "./engineInstance.js";
import { getViewportHandle } from "./viewportHandle.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { useGeometryEditStore } from "./store/geometryEditStore.js";
import { getTerrainBrushMode } from "./terrainBrush.js";
import { getLevelTool } from "./levelTool.js";
import { isArchitecturePlacementActive } from "./architecturePlacementTool.js";
import { isArchitectureSculptActive } from "./architectureSculptTool.js";
import { activeSpline } from "./splineEditing.js";
import { resolveTargets } from "./selectionRect.js";
import {
  collectSelectionCandidates,
  frustumFromNdcRect,
  idsInFrustum,
  ndcRectFromPixels,
} from "./boxSelect.js";

/**
 * Rubber-band selection in the scene viewport: drag a rectangle, select
 * everything it touches.
 *
 * It hangs off a MODIFIER rather than a bare left-drag because a bare left-drag
 * already orbits the camera here, and moving orbit to the middle button to
 * match Unity would retrain every existing muscle memory for one new gesture.
 *
 * ALT is the modifier, and it is the only one available. OrbitControls treats
 * left-drag with ctrl, meta OR shift as PAN — see its own header: "Pan: Right
 * mouse, or left mouse + ctrl/meta/shiftKey" — so any of those three would
 * silently cost the user a camera gesture they already use. Alt is the one it
 * never reads.
 *
 *   Alt+drag        replace the selection with what the box touches
 *   Alt+Shift+drag  add to the selection
 *   Alt+Ctrl+drag   remove from the selection
 *
 * Alt+Shift is "add", not "toggle", on purpose: a toggle re-evaluated on every
 * pointermove makes objects flicker in and out as the box sweeps back over
 * them, which reads as a bug rather than a gesture. Subtract gets its own
 * modifier instead.
 *
 * Without a drag, Alt+click keeps its meaning (drill into a prefab). The click
 * path in ViewportPanel's `setupPicking` ignores any gesture that moved more
 * than a few pixels and this one ignores any that didn't, so exactly one of
 * them acts on any given press — they share `SLOP_PX` to keep that true.
 *
 * The geometry lives in boxSelect.js (frustum + AABBs, testable headlessly);
 * this file is the gesture, the modifiers and the overlay rectangle.
 */

/** Pixels the pointer must travel before a modified click becomes a marquee. */
const SLOP_PX = 4;

/**
 * Installs the gesture. Safe to call again on remount — the previous
 * installation is torn down first.
 *
 * @param {HTMLCanvasElement} canvas
 */
export function setupBoxSelect(canvas) {
  const frustum = new THREE.Frustum();
  /** @type {any} */
  let drag = null;

  /** Everything that owns the left button while it is active: a marquee
   *  started under any of these would fight a tool already listening. */
  const viewportIsBusy = () => {
    const viewport = getViewportHandle();
    return (
      engine.playing ||
      !!viewport?.terrainBrushing ||
      !!getTerrainBrushMode() ||
      !!viewport?.gizmo?.dragging ||
      // The gizmo parks its arrows on the selection; a drag that starts on one
      // belongs to the gizmo even with a modifier held.
      !!viewport?.gizmo?.axis ||
      !!useGeometryEditStore.getState().entityId ||
      // Spline edit mode spends Ctrl+click (insert knot) and Shift+click
      // (append knot) on the two modifiers this gesture uses.
      !!activeSpline() ||
      isArchitectureSculptActive() || isArchitecturePlacementActive() || (!!getLevelTool() && getLevelTool() !== "select")
    );
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || !e.altKey || e.target !== canvas) return;
    const viewport = getViewportHandle();
    if (!viewport?.camera || viewportIsBusy()) return;

    const selection = useSelectionStore.getState();
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      frame: 0,
      mode: e.ctrlKey || e.metaKey ? "remove" : e.shiftKey ? "add" : "replace",
      active: false,
      candidates: null,
      selected: null,
      base: [...selection.ids],
      anchor: selection.anchorId,
      applied: null,
      // OrbitControls owns the left button and would rotate the camera out from
      // under the marquee. Restore whatever was there rather than assuming
      // `true`: play mode and gizmo drags both turn it off for their own
      // reasons and this gesture must not turn it back on for them.
      orbitWasEnabled: viewport.orbit?.enabled,
    };
    if (viewport.orbit) viewport.orbit.enabled = false;
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    // A release outside the window never reaches us, and a drag that never ends
    // leaves OrbitControls disabled — "the camera stopped rotating" with no way
    // back short of a reload. Losing focus ends the gesture.
    window.addEventListener("blur", onPointerUp);
    window.addEventListener("keydown", onKeyDown, true);
  };

  // Pointer events are NOT capped at the refresh rate — a 1000 Hz mouse fires
  // a thousand of them a second, and each one here would rewrite the selection
  // store, which hands every Hierarchy row a fresh array. Record the position,
  // do the work once per frame.
  const onPointerMove = (e) => {
    if (!drag) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      if (!drag) return;
      drag.frame = 0;
      applyMarquee();
    });
  };

  const applyMarquee = () => {
    if (!drag) return;
    const viewport = getViewportHandle();
    if (!viewport?.camera) return;

    if (!drag.active) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < SLOP_PX) return;
      drag.active = true;
      // Built ONCE: the camera is pinned for the duration of the marquee, so
      // every box in here stays valid and each subsequent move costs six plane
      // tests per candidate instead of another walk of the scene graph.
      drag.candidates = collectSelectionCandidates(engine.scene, engine.entities.values());
      drag.selected = drag.base.map((id) => engine.getEntity(id)).filter(Boolean);
    }

    const rect = canvas.getBoundingClientRect();
    const view = {
      left: Math.min(drag.startX, drag.x),
      right: Math.max(drag.startX, drag.x),
      top: Math.min(drag.startY, drag.y),
      bottom: Math.max(drag.startY, drag.y),
    };
    showMarquee(canvas, view);

    frustumFromNdcRect(
      ndcRectFromPixels(
        {
          left: view.left - rect.left,
          right: view.right - rect.left,
          top: view.top - rect.top,
          bottom: view.bottom - rect.top,
        },
        rect,
      ),
      viewport.camera,
      frustum,
    );

    // Same "a click means the whole model" rule a single click gets, fed the
    // selection as it was when the drag STARTED — re-reading it mid-drag would
    // let the marquee's own output decide whether it counts as drilled in.
    const touched = resolveTargets(idsInFrustum(drag.candidates, frustum), drag.selected);

    let ids;
    if (drag.mode === "add") ids = [...new Set([...drag.base, ...touched])];
    else if (drag.mode === "remove") ids = drag.base.filter((id) => !touched.has(id));
    else ids = [...touched];

    // The selection store hands every Hierarchy row a fresh array on each
    // write, so writing an unchanged set sixty times a second re-renders the
    // whole tree for nothing.
    const key = ids.join(",");
    if (key === drag.applied) return;
    drag.applied = key;
    // add/remove keep the anchor a later Shift+click extends from, the way the
    // asset grid's marquee does; replace threw the old one away with the rest
    // of the selection, so it starts a new range instead of pointing outside.
    const anchor = drag.mode === "replace" ? ids[0] : (drag.anchor ?? ids[0]);
    if (ids.length) useSelectionStore.getState().select(ids, anchor);
    else useSelectionStore.getState().clear();
  };

  const onKeyDown = (e) => {
    if (e.key !== "Escape" || !drag) return;
    e.preventDefault();
    e.stopPropagation();
    const base = drag.base;
    endDrag();
    if (base.length) useSelectionStore.getState().select(base);
    else useSelectionStore.getState().clear();
  };

  const onPointerUp = () => endDrag();

  function endDrag() {
    if (!drag) return;
    const viewport = getViewportHandle();
    if (viewport?.orbit) viewport.orbit.enabled = drag.orbitWasEnabled ?? true;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    hideMarquee();
    drag = null;
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
    window.removeEventListener("blur", onPointerUp);
    window.removeEventListener("keydown", onKeyDown, true);
  }

  // Capture on WINDOW, not on the canvas: OrbitControls listens on the canvas
  // itself, and listeners on the *target* element fire in registration order
  // whatever their capture flag — so a capture listener added here would still
  // run second and the camera would already be rotating.
  window.addEventListener("pointerdown", onPointerDown, true);
  const viewport = getViewportHandle();
  viewport?.disposeBoxSelect?.();
  if (viewport) {
    viewport.disposeBoxSelect = () => {
      endDrag();
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }
}

/** The marquee rectangle. A plain div beside the canvas rather than React
 *  state, so a pointermove doesn't re-render the panel. */
function showMarquee(canvas, view) {
  const host = canvas.parentElement;
  if (!host) return;
  const viewport = getViewportHandle();
  let el = viewport?.marqueeOverlay;
  if (!el?.isConnected || el.parentElement !== host) {
    el = document.createElement("div");
    el.className = "viewport-marquee";
    host.appendChild(el);
    if (viewport) viewport.marqueeOverlay = el;
  }
  const hostRect = host.getBoundingClientRect();
  el.style.left = `${view.left - hostRect.left}px`;
  el.style.top = `${view.top - hostRect.top}px`;
  el.style.width = `${view.right - view.left}px`;
  el.style.height = `${view.bottom - view.top}px`;
  el.classList.add("visible");
}

function hideMarquee() {
  getViewportHandle()?.marqueeOverlay?.classList.remove("visible");
}
