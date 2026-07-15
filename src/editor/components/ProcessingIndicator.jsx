import { Loader2 } from "lucide-react";
import { useAssetProcessingStore } from "../store/assetProcessingStore.js";

/**
 * Tiny spinner + the most recent job's label, shown on the menu bar whenever
 * any asset-processing task is in flight. Hidden when nothing's running so
 * it doesn't take up space in the chrome the rest of the time.
 */
export function ProcessingIndicator() {
  const jobs = useAssetProcessingStore((s) => s.jobs);
  if (jobs.size === 0) return null;
  const latest = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
  const extra = jobs.size - 1;
  return (
    <div
      className="processing-indicator"
      title={
        extra > 0
          ? `${jobs.size} tasks running: ${[...jobs.values()].map((j) => j.label).join(", ")}`
          : latest.label
      }
    >
      <Loader2 size={13} className="processing-spin" strokeWidth={2.25} />
      <span className="processing-label">{latest.label}</span>
      {extra > 0 && <span className="processing-extra">+{extra}</span>}
    </div>
  );
}