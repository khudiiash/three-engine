import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity } from "../icons/index.jsx";
import { setLayerVisible, subscribeLayers } from "../panels/ViewportPanel.jsx";
import { PerformanceMonitor } from "../components/PerformanceMonitor.jsx";
import { setPerfHandedOff, setPerfPos, usePerfStore } from "../perfMonitor.js";
import { pushToast } from "../toasts.js";

/**
 * The viewport's performance HUD: the monitor (components/PerformanceMonitor)
 * at one of three sizes — the frame rate alone, the frame rate with a small
 * chart, or the full profiler — chosen by the HUD's own size control and
 * kept in localStorage. The Layers dropdown's "Stats" entry shows or hides
 * it (`viewport.layers.stats`); `forceVisible` is for isolated diagnostics
 * that opt out of the layers profile.
 *
 * It is also DRAGGABLE, by any part of it that is not a control:
 *   · dropped inside the viewport it stays where it was put (the place is
 *     kept in localStorage, per size-independent x/y from the top-left),
 *   · dropped on any other panel's group it becomes the Performance panel
 *     there — the profiler people actually want while reading a breakdown,
 *     without hunting for it in the panel launcher.
 * The gesture is pointer events, NOT HTML5 drag-and-drop: dragstart/drop
 * never fire under Tauri's webview, so Dockview's own drop targets cannot be
 * used here (see `dockGroupAt` in EditorShell).
 */
export function StatsOverlay({ forceVisible = false }) {
  const [visible, setVisible] = useState(true);
  const size = usePerfStore((s) => s.size);
  const pos = usePerfStore((s) => s.pos);
  const rootRef = useRef(null);
  const { drag, onPointerDown } = useHudDrag(rootRef, size);

  useEffect(() => {
    if (forceVisible) return undefined;
    return subscribeLayers((l) => setVisible(!!l.stats));
  }, [forceVisible]);
  if (!visible && !forceVisible) return null;

  // While dragging, the HUD itself stays put but goes see-through: the panel
  // it would land on has to stay readable under the pointer, and a viewport
  // with `overflow: hidden` would clip the real element the moment the drag
  // left it. The thing that follows the pointer is the ghost below.
  const style = pos ? { left: pos.x, top: pos.y, right: "auto" } : undefined;
  return (
    <>
      <div
        ref={rootRef}
        className={`stats-overlay perf-hud size-${size}${drag ? " dragging" : ""}${pos ? " placed" : ""}`}
        role="status"
        style={style}
        onPointerDown={onPointerDown}
      >
        <PerformanceMonitor size={size} hud />
      </div>
      {drag && <HudGhost drag={drag} />}
    </>
  );
}

/** What follows the pointer: a small card saying what dropping here does. */
function HudGhost({ drag }) {
  return createPortal(
    <div className={`perf-hud-ghost${drag.group ? " docking" : ""}`} style={{ left: drag.x, top: drag.y }}>
      <Activity size={13} aria-hidden="true" />
      <span>{drag.group ? "Dock the profiler here" : "Performance"}</span>
    </div>,
    document.body,
  );
}

/** How far the pointer travels before a press becomes a drag. */
const DRAG_SLOP = 4;
/** The drop target's outline, added to the group element under the pointer. */
const DROP_CLASS = "perf-hud-drop-target";

/**
 * The drag gesture. Returns the live drag (or null) and the pointerdown
 * handler for the HUD's root.
 *
 * A press anywhere but a select or a text field can become a drag, including
 * on the HUD's own buttons — at the smallest size the fps pill is the entire
 * HUD, so a rule that spared buttons would leave it ungrabbable. A press that
 * never travels `DRAG_SLOP` stays a click; one that does has its click
 * swallowed, so changing the time window never also moves the profiler.
 */
function useHudDrag(rootRef, size) {
  const [drag, setDrag] = useState(null);
  const state = useRef(null);

  const finish = useCallback(
    (event, commit) => {
      const current = state.current;
      state.current = null;
      setDrag(null);
      if (!current) return;
      window.removeEventListener("pointermove", current.onMove);
      window.removeEventListener("pointerup", current.onUp);
      window.removeEventListener("pointercancel", current.onCancel);
      current.marked?.classList.remove(DROP_CLASS);
      if (!current.moved) return;
      // The press started on a button (the size control, the fps pill — at the
      // smallest size the pill IS the whole HUD, so it has to be draggable);
      // now that it turned out to be a drag, its click must not also fire.
      armClickSwallow();
      if (!commit) return;
      if (current.group) {
        dropIntoDock(current.group);
        return;
      }
      const host = current.element?.offsetParent ?? current.element?.parentElement;
      const hostRect = host?.getBoundingClientRect();
      if (!hostRect) return;
      const rect = current.element.getBoundingClientRect();
      // Clamped so a drop near an edge can never park the HUD off screen,
      // where nothing could reach it again but localStorage.
      const x = clamp(current.x - current.grabX - hostRect.left, 0, Math.max(0, hostRect.width - rect.width));
      const y = clamp(current.y - current.grabY - hostRect.top, 0, Math.max(0, hostRect.height - rect.height));
      setPerfPos({ x, y });
    },
    [],
  );

  const onPointerDown = useCallback(
    (event) => {
      if (event.button !== 0) return;
      // A select or a text field owns its own pointer gesture; everything else,
      // buttons included, can start a drag — the click is swallowed in `finish`
      // if it does. Excluding buttons would leave the smallest size, which is
      // one pill-shaped button, with nothing to grab.
      const target = event.target;
      if (target instanceof Element && target.closest("select, input, textarea")) return;
      const element = rootRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const onMove = (moveEvent) => {
        const current = state.current;
        if (!current) return;
        current.x = moveEvent.clientX;
        current.y = moveEvent.clientY;
        if (!current.moved) {
          if (Math.hypot(moveEvent.clientX - current.startX, moveEvent.clientY - current.startY) < DRAG_SLOP) return;
          current.moved = true;
        }
        // Inside the viewport it is a move; anywhere else, the group under
        // the pointer is offered as a dock target.
        const overViewport = document.elementFromPoint(current.x, current.y)?.closest(".viewport-panel, .game-panel");
        const group = overViewport ? null : groupAt(current.x, current.y);
        if (group !== current.group) {
          current.marked?.classList.remove(DROP_CLASS);
          current.marked = group?.element ?? null;
          current.marked?.classList.add(DROP_CLASS);
          current.group = group;
        }
        setDrag({ x: current.x - current.grabX, y: current.y - current.grabY, group: current.group });
      };
      const onUp = (upEvent) => finish(upEvent, true);
      const onCancel = (cancelEvent) => finish(cancelEvent, false);
      state.current = {
        element,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        grabX: event.clientX - rect.left,
        grabY: event.clientY - rect.top,
        moved: false,
        group: null,
        marked: null,
        onMove,
        onUp,
        onCancel,
      };
      // ⛔ NO `setPointerCapture` HERE. Capturing on pointerdown retargets the
      // click that follows to this element, so the press never reaches the
      // button under it — the fps pill stopped expanding the moment the HUD
      // became draggable. The window listeners below already follow the
      // pointer anywhere, capture or not, so the capture bought nothing.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      // The viewport's orbit controls are listening on the canvas under this;
      // a drag of the HUD must not also spin the camera.
      event.stopPropagation();
    },
    [finish, rootRef],
  );

  // A size change can leave a placed HUD hanging off the bottom or right of a
  // viewport it used to fit in — the full profiler is much taller than the
  // pill. Pull it back inside whenever the size or the viewport changes.
  useEffect(() => {
    const element = rootRef.current;
    const host = element?.offsetParent;
    if (!element || !host) return undefined;
    const clampIntoHost = () => {
      const { pos } = usePerfStore.getState();
      if (!pos) return;
      const rect = element.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const x = clamp(pos.x, 0, Math.max(0, hostRect.width - rect.width));
      const y = clamp(pos.y, 0, Math.max(0, hostRect.height - rect.height));
      if (x !== pos.x || y !== pos.y) setPerfPos({ x, y });
    };
    clampIntoHost();
    const observer = new ResizeObserver(clampIntoHost);
    observer.observe(host);
    return () => observer.disconnect();
  }, [rootRef, size]);

  return { drag, onPointerDown };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Eats the click that closes a drag — the press may have started on the size
 * control or the fps pill, and a drag must not also press it. Disarmed on the
 * next task either way, so a drag that produces no click (the pointer came up
 * over another panel) can never swallow the user's next real one.
 */
function armClickSwallow() {
  window.addEventListener("click", swallowOnce, true);
  setTimeout(() => window.removeEventListener("click", swallowOnce, true), 0);
}

function swallowOnce(event) {
  event.stopPropagation();
  event.preventDefault();
  window.removeEventListener("click", swallowOnce, true);
}

/** The Dockview group under a point, through a lazy import: this module is
 *  loaded by the viewport, which the shell itself imports. */
let dockApi = null;
import("../EditorShell.jsx")
  .then((module) => {
    dockApi = module;
  })
  .catch(() => {
    /* no shell (a standalone harness): the HUD is then move-only */
  });

function groupAt(x, y) {
  return dockApi?.dockGroupAt?.(x, y) ?? null;
}

/** Turn the HUD into the Performance panel in `group`. */
function dropIntoDock(group) {
  if (!dockApi?.openPanelInDockGroup?.("performance", group)) return;
  // Two live profilers over one scene is one too many — the HUD's breakdown
  // and memory walks are not free — so the viewport's copy stands down. The
  // way back is a button in the panel itself, where the thing you just moved
  // now lives; the toast only has to say so once.
  setLayerVisible("stats", false);
  setPerfHandedOff(true);
  pushToast({
    level: "info",
    title: "Profiler docked",
    detail: "The viewport HUD stood down. Closing the panel — or its button, top left — brings it back.",
    key: "perf-hud-docked",
  });
}
