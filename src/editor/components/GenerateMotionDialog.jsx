import { useEffect, useState } from "react";
import { ChevronDown, Loader2, Sparkles, X } from "../icons/index.jsx";
import { invoke } from "../assetOps.js";
import { useProjectStore } from "../store/projectStore.js";
import { getKimodoPrefs, setKimodoPrefs } from "../kimodoPrefs.js";

/** Compact prompt-first surface for local text-to-motion generation. */
export function GenerateMotionDialog({ onApply, onCancel, busy = false, error = "" }) {
  const prefs = getKimodoPrefs();
  const [prompt, setPrompt] = useState("");
  const [seconds, setSeconds] = useState(3);
  const [steps, setSteps] = useState(25);
  // A fresh dialog is a fresh variation. The seed stays visible/editable in
  // Advanced for reproducibility, but retrying a weak generation must not
  // silently reproduce the exact same motion forever.
  const [seed, setSeed] = useState(() => {
    const values = new Uint32Array(1);
    globalThis.crypto?.getRandomValues?.(values);
    return values[0] || Math.floor(Math.random() * 0xffffffff) || 1;
  });
  const [inPlace, setInPlace] = useState(true);
  const [motionModel, setMotionModel] = useState(prefs.motionModel);
  const [advanced, setAdvanced] = useState(false);
  const [runtime, setRuntime] = useState("checking");

  useEffect(() => {
    let live = true;
    setRuntime("checking");
    invoke("probe_kimodo_tool", {
      projectRoot: useProjectStore.getState().rootPath ?? "",
      motionModel,
    })
      .then((found) => live && setRuntime(found ? "ready" : "missing"))
      .catch(() => live && setRuntime("missing"));
    return () => {
      live = false;
    };
  }, [motionModel]);

  const frames = Math.max(2, Math.min(600, Math.round((Number(seconds) || 3) * 30)));
  const canApply = !busy && runtime === "ready" && prompt.trim().length > 0;
  const apply = () => {
    if (!canApply) return;
    setKimodoPrefs({ motionModel });
    onApply({
      prompt: prompt.trim(),
      frames,
      steps: Math.max(1, Math.min(150, Math.round(Number(steps) || 25))),
      seed: Math.max(0, Math.round(Number(seed) || 1)),
      travel: !inPlace,
    });
  };

  return (
    <div className="texture-dialog-backdrop" onPointerDown={busy ? undefined : onCancel}>
      <div
        className="motion-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="motion-dialog-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="motion-dialog-header">
          <span className="motion-dialog-icon"><Sparkles size={16} /></span>
          <div>
            <h3 id="motion-dialog-title">Generate animation</h3>
            <p>Describe the motion. It becomes a state and plays immediately.</p>
          </div>
          <button className="motion-dialog-close" aria-label="Close" disabled={busy} onClick={onCancel}>
            <X size={15} />
          </button>
        </div>

        <textarea
          className="motion-prompt"
          autoFocus
          rows={4}
          aria-label="Motion prompt"
          placeholder="A relaxed walk forward with natural arm swing…"
          value={prompt}
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) apply();
          }}
        />

        <div className="motion-essentials">
          <label>
            <span>Duration</span>
            <span className="motion-number">
              <input type="number" min={0.5} max={20} step={0.5} value={seconds} onChange={(event) => setSeconds(Number(event.target.value))} />
              <em>s</em>
            </span>
          </label>
          <label className="motion-switch-row">
            <span>In place</span>
            <input type="checkbox" checked={inPlace} onChange={(event) => setInPlace(event.target.checked)} />
          </label>
        </div>

        <button className={`motion-advanced-toggle${advanced ? " open" : ""}`} onClick={() => setAdvanced((value) => !value)}>
          Advanced
          <ChevronDown size={13} />
        </button>
        {advanced && (
          <div className="motion-advanced">
            <label>
              <span>Model</span>
              <select value={motionModel} onChange={(event) => setMotionModel(event.target.value)}>
                <option value="rp">SOMA RP</option>
                <option value="seed">SOMA SEED</option>
              </select>
            </label>
            <label><span>Steps</span><input type="number" min={1} max={150} value={steps} onChange={(event) => setSteps(Number(event.target.value))} /></label>
            <label><span>Seed</span><input type="number" min={0} step={1} value={seed} onChange={(event) => setSeed(Number(event.target.value))} /></label>
          </div>
        )}

        {(error || runtime === "missing") && (
          <div className="motion-error" role="alert">
            {error || "Local Kimodo runtime was not found beside the editor or project."}
          </div>
        )}

        <div className="motion-dialog-footer">
          <span className={`motion-runtime ${runtime}`}>
            {runtime === "checking" ? "Finding local model…" : runtime === "ready" ? "Local model ready" : "Model unavailable"}
          </span>
          <button className="motion-generate" disabled={!canApply} onClick={apply}>
            {busy ? <Loader2 className="motion-spinner" size={14} /> : <Sparkles size={14} />}
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}
