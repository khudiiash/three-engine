import { useEffect, useState } from "react";
import { subscribeLayers } from "../panels/ViewportPanel.jsx";
import { PerformanceMonitor } from "../components/PerformanceMonitor.jsx";
import { usePerfStore } from "../perfMonitor.js";

/**
 * The viewport's performance HUD: the monitor (components/PerformanceMonitor)
 * at one of three sizes — the frame rate alone, the frame rate with a small
 * chart, or the full profiler — chosen by the HUD's own size control and
 * kept in localStorage. The Layers dropdown's "Stats" entry shows or hides
 * it (`viewport.layers.stats`); `forceVisible` is for isolated diagnostics
 * that opt out of the layers profile.
 */
export function StatsOverlay({ forceVisible = false }) {
  const [visible, setVisible] = useState(true);
  const size = usePerfStore((s) => s.size);
  useEffect(() => {
    if (forceVisible) return undefined;
    return subscribeLayers((l) => setVisible(!!l.stats));
  }, [forceVisible]);
  if (!visible && !forceVisible) return null;
  return (
    <div className={`stats-overlay perf-hud size-${size}`} role="status">
      <PerformanceMonitor size={size} hud />
    </div>
  );
}
