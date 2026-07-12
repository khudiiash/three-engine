import { useEffect, useRef, useState } from "react";
import { subscribeLayers } from "../panels/ViewportPanel.jsx";
import { engine } from "../engineInstance.js";

/**
 * Editor-only viewport overlay showing live engine telemetry:
 *
 *   FPS              frames/second (smoothed)
 *   CPU %            engine frame time as a percentage of a 60 Hz budget,
 *                    clamped 0–100 so the bar saturates instead of overflowing
 *   GPU %            renderer.render() wall time as a percentage of a 60 Hz
 *                    budget, clamped 0–100
 *   Memory           JS heap (Chromium-only; "—" elsewhere)
 *   Textures         GPU memory used by tracked textures (sum of every
 *                    three.Texture's byte size, in MB)
 *   Draw calls       three's per-frame draw-call count
 *                    (note: `renderer.info.render.calls` is cumulative
 *                    since startup — we deliberately read `drawCalls` instead)
 *   Triangles        three's per-frame triangle count
 *
 * Two interactions:
 *   - The Layers dropdown's "Stats" entry shows/hides the overlay entirely
 *     (mirrors `viewport.layers.stats`).
 *   - Clicking the header collapses the panel to FPS-only, or expands it
 *     to all six rows. The collapsed/expanded choice is persisted to
 *     localStorage so it survives reloads without polluting project.json.
 *
 * Layout: two columns (label | value) inside a fixed-width panel. Label
 * column gets enough room for "Draw calls" without truncation; value
 * column gets enough room for a comma-formatted number like "13 392" or
 * a "9999 MB" reading. No detail column — the percent is enough on its
 * own (capped 0–100, colour-coded), and adding a third column pushed
 * detail content past the right edge on smaller viewports.
 */
const REFRESH_HZ = 10;
const COLLAPSED_STORAGE_KEY = "engine.viewport.stats.collapsed";

const EMPTY_READOUT = {
  fps: 0,
  frameMs: 0,
  cpuLoadPct: 0,
  renderMs: 0,
  gpuLoadPct: 0,
  jsHeapBytes: null,
  drawCalls: 0,
  triangles: 0,
  textureMem: 0,
};

function readStats() {
  // `engine` is a Proxy that throws if accessed before `ensureEngine()`
  // resolves. The overlay is rendered inside ViewportPanel, which awaits
  // `ensureEngine()` first — so this is safe. Every engine has a built-in
  // `stats` instance, so there's no module-installed / not-installed split.
  const stats = engine.stats;
  if (!stats) return { ...EMPTY_READOUT };
  // The StatsSystem mutates its readout in place every frame; React's
  // useState bails out on identical references, so we shallow-clone to
  // guarantee every 10 Hz poll triggers a render.
  return { ...stats.readout };
}

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(v) {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, v ? "1" : "0");
  } catch {
    // localStorage may be unavailable (private mode, quota exceeded); the
    // overlay still works, it just forgets between reloads.
  }
}

export function StatsOverlay() {
  const [r, setR] = useState(EMPTY_READOUT);
  const [visible, setVisible] = useState(true);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const rafRef = useRef(0);

  // Mirror viewport.layers.stats so the Layers-dropdown toggle controls
  // mounting. (The "Stats" entry sits alongside Gizmos/Colliders/Grid in
  // the dropdown; turning it off hides the overlay entirely.)
  useEffect(() => subscribeLayers((l) => setVisible(!!l.stats)), []);

  // 10 Hz poll. RAF-driven (not the engine tick) so React stays out of
  // the engine's hot path. We always advance state to a fresh object so
  // React sees a new reference each tick — see readStats().
  useEffect(() => {
    let stopped = false;
    let last = 0;
    const interval = 1000 / REFRESH_HZ;
    const loop = (now) => {
      if (stopped) return;
      if (now - last >= interval) {
        last = now;
        setR(readStats());
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (!visible) return null;

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      writeCollapsed(next);
      return next;
    });
  };

  // Group rows into two visual sections when expanded: "Performance" (FPS,
  // CPU, GPU, Memory) and "Renderer" (textures memory, draw calls,
  // triangles). The group labels are subtle dividers — same colour as the
  // row labels, slightly smaller, with a thin top border separating them
  // from the row above. Collapsed view shows only FPS; the section labels
  // never appear in collapsed mode.
  return (
    <div
      className={`stats-overlay ${collapsed ? "collapsed" : "expanded"}`}
      role="status"
    >
      <button
        type="button"
        className="stats-overlay-header"
        onClick={toggleCollapsed}
        title={collapsed ? "Expand stats (click)" : "Collapse stats (click)"}
      >
        <span className="stats-overlay-chevron" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="stats-overlay-label">FPS</span>
        <span className={`stats-overlay-value tone-${fpsTone(r.fps)}`}>
          {r.fps > 0 ? r.fps.toFixed(0) : "—"}
        </span>
      </button>
      {!collapsed && (
        <>
          <Section title="Performance" />
          <Row
            label="CPU"
            value={`${r.cpuLoadPct.toFixed(0)}%`}
            tone={loadClass(r.frameMs)}
          />
          <Row
            label="GPU"
            value={`${r.gpuLoadPct.toFixed(0)}%`}
            tone={loadClass(r.renderMs)}
          />
          <Row
            label="Memory"
            value={formatBytes(r.jsHeapBytes)}
            tone={memTone(r.jsHeapBytes)}
          />
          <Section title="Renderer" />
          <Row label="Textures" value={formatBytes(r.textureMem)} tone={memTone(r.textureMem)} />
          <Row label="Draw calls" value={formatCount(r.drawCalls)} />
          <Row label="Triangles" value={formatCount(r.triangles)} />
        </>
      )}
    </div>
  );
}

function Section({ title }) {
  return <div className="stats-overlay-section">{title}</div>;
}

function Row({ label, value, tone = "ok" }) {
  return (
    <div className={`stats-overlay-row tone-${tone}`}>
      <span className="stats-overlay-label">{label}</span>
      <span className="stats-overlay-value">{value}</span>
    </div>
  );
}

function formatBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCount(n) {
  // `toLocaleString()` gives a locale-aware thousands separator. Counts
  // can be 0 (an engine that hasn't rendered anything yet) so we don't
  // need a special-case for that — "0" reads fine on its own.
  return n.toLocaleString();
}

function loadClass(ms) {
  // CPU/GPU percentages are hard-capped at 100 in the StatsSystem; the
  // colour tone keys off the underlying ms so a saturated-100% frame at
  // 16.7 ms doesn't turn red (it fits the budget exactly) while a
  // saturated-100% frame at 50 ms does.
  if (ms >= 22) return "heavy"; // can't hold 45 fps
  if (ms >= 17) return "warm";  // saturated 60 fps budget
  return "ok";
}

function fpsTone(fps) {
  if (fps <= 0) return "ok";
  if (fps < 30) return "heavy";
  if (fps < 50) return "warm";
  return "ok";
}

function memTone(bytes) {
  if (bytes == null) return "ok";
  // 1 GB heap = warm. Above 2 GB = heavy. Generous thresholds; the
  // overlay's role is to flag "memory is climbing", not to be precise.
  if (bytes > 2 * 1024 * 1024 * 1024) return "heavy";
  if (bytes > 1 * 1024 * 1024 * 1024) return "warm";
  return "ok";
}
