import { useEffect } from "react";
import { Minimize2 } from "../icons/index.jsx";
import { PerformanceMonitor } from "../components/PerformanceMonitor.jsx";
import { closePanel } from "../EditorShell.jsx";
import { isPerfHandedOff, setPerfHandedOff } from "../perfMonitor.js";
import { setLayerVisible } from "./ViewportPanel.jsx";

/**
 * The profiler as a dockable panel: the monitor's full size, always.
 *
 * ⚠ THE GESTURE THAT BRINGS IT HERE MUST HAVE AN INVERSE. The HUD becomes
 * this panel by being dragged onto a tab strip, and it switches itself off
 * when it does — two live profilers over one scene cost twice, since the
 * breakdown and memory walks are not free. For a while that made the drag
 * one-way: close this panel and the profiler was in neither place, with only
 * a toast that had long since vanished to say where it went. So there are
 * two ways home now, one deliberate and one automatic:
 *
 *   · the button below, which puts the HUD back and closes this panel;
 *   · closing this panel by any means at all, which does the same thing.
 *
 * Only when the HUD was the one that handed over, though — a Performance
 * panel opened from the Window menu closes without turning anything on.
 */

/** How long a disappearance has to last before it counts as a close. */
const CLOSE_GRACE_MS = 300;
/** Dockview UNMOUNTS AND REMOUNTS a panel when it is dragged to another
 *  group, and that must not read as a close — so the restore waits, and a
 *  panel that comes straight back cancels it. */
let mounted = 0;
let pending = 0;

function restoreHud() {
  setPerfHandedOff(false);
  setLayerVisible("stats", true);
}

export function PerformancePanel() {
  useEffect(() => {
    mounted++;
    clearTimeout(pending);
    return () => {
      mounted--;
      if (!isPerfHandedOff()) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        if (mounted === 0 && isPerfHandedOff()) restoreHud();
      }, CLOSE_GRACE_MS);
    };
  }, []);

  return (
    <div className="perf-panel">
      <div className="panel-toolbar">
        <button
          className="toolbar-btn icon-only"
          title="Put the profiler back over the viewport as a collapsible HUD, and close this panel"
          onClick={() => {
            restoreHud();
            closePanel("performance");
          }}
        >
          <Minimize2 size={13} />
        </button>
      </div>
      <div className="perf-panel-body">
        <PerformanceMonitor size="full" />
      </div>
    </div>
  );
}
