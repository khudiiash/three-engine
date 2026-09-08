import { PerformanceMonitor } from "../components/PerformanceMonitor.jsx";

/** The profiler as a dockable panel: the monitor's full size, always. */
export function PerformancePanel() {
  return (
    <div className="perf-panel">
      <PerformanceMonitor size="full" />
    </div>
  );
}
