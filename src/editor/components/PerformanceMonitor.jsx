import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play, Rows3 } from "../icons/index.jsx";
import { ensureEngine } from "../engineInstance.js";
import {
  FRAME_BUDGET_MS,
  PERF_WINDOWS,
  readPerf,
  setPerfSize,
  startPerfSampling,
  usePerfStore,
  watchBreakdown,
  watchMemory,
} from "../perfMonitor.js";
import { PerfChart } from "./PerfChart.jsx";

/** The engine's tick phases, in words. */
const PHASE_LABELS = {
  frustumCull: "Frustum culling",
  lod: "LOD",
  occlusionApply: "Occlusion (apply)",
  visibilityWalk: "Visibility walk",
  coreSystems: "Core systems",
  scripts: "Components & scripts (update)",
  audio: "Audio",
  matrixWorld: "Matrix world",
  batching: "Batching",
  merging: "Merging",
  impostors: "Impostors",
  occlusionRender: "Occlusion (render)",
  preRender: "Pre-render (GI, prepasses)",
  debugFlush: "Debug draw",
  shadowFreeze: "Shadow freeze",
  renderEncode: "Render encode",
  postRender: "Post-render (overlays)",
};

/**
 * Every group holds a FIXED number of rows, so the profiler keeps one height:
 * a row that drops out of a capture leaves its slot empty instead of
 * shortening the list and shifting everything under it.
 */
const GROUP_SLOTS = { engine: 10, components: 8, scripts: 6, memory: 12 };
/** How much of a new capture a shown value takes (the rest is the old one).
 *  Captures land half a second apart and jump; the eye wants their mean. */
const ROW_SMOOTHING = 0.4;
/** Captures a vanished row survives, halving each time, before it is dropped —
 *  a row that comes and goes must not re-rank the list every other capture. */
const ROW_GRACE = 6;

/** One ranked group of the breakdown: `slots` rows with a share of `total`. */
function BreakdownGroup({ title, rows, total, slots, unit = "ms", empty = "Nothing measured yet" }) {
  const sum = rows.reduce((s, r) => s + r.value, 0);
  const fmt = (v) => (unit === "ms" ? `${v.toFixed(2)} ms` : `${(v / 1048576).toFixed(v > 104857600 ? 0 : 1)} MB`);
  const pad = Math.max(0, slots - Math.max(rows.length, 1));
  return (
    <div className="perf-group">
      <div className="perf-group-head">
        <span className="perf-group-title">{title}</span>
        <span className="perf-group-sum">{rows.length ? fmt(sum) : ""}</span>
      </div>
      <ul className="perf-rows">
        {rows.map((r) => {
          const pct = total > 0 ? Math.min((r.value / total) * 100, 100) : 0;
          return (
            <li className={`perf-row kind-${r.kind ?? "component"}`} key={r.key} title={r.title ?? r.name}>
              <span className="perf-row-name">
                {r.name}
                {r.detail && <small>{r.detail}</small>}
              </span>
              <span className="perf-row-ms">{fmt(r.value)}</span>
              <span className="perf-row-pct">
                <span className="perf-row-bar" aria-hidden="true">
                  <i style={{ width: `${pct}%` }} />
                </span>
                {pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%
              </span>
            </li>
          );
        })}
        {rows.length === 0 && <li className="perf-row empty note">{empty}</li>}
        {Array.from({ length: pad }, (_, i) => (
          <li className="perf-row empty" key={`pad:${i}`} aria-hidden="true" />
        ))}
      </ul>
    </div>
  );
}

/**
 * Ranked rows that hold their slot. A row's shown value is a rolling mean over
 * captures, and a row missing from one decays for a few before it leaves — so
 * neither the order nor the numbers jump between two captures half a second
 * apart. `memo` is the caller's per-group state, and is mutated here.
 */
function smoothRows(memo, rows, slots) {
  const seen = new Set();
  for (const row of rows) {
    seen.add(row.key);
    const prev = memo.get(row.key);
    memo.set(row.key, { ...row, value: prev ? prev.value + (row.value - prev.value) * ROW_SMOOTHING : row.value, miss: 0 });
  }
  for (const [key, row] of memo) {
    if (seen.has(key)) continue;
    row.miss++;
    row.value *= 0.5;
    if (row.miss > ROW_GRACE) memo.delete(key);
  }
  return [...memo.values()].sort((a, b) => b.value - a.value).slice(0, slots);
}

/** The three ranked lists of one capture, before smoothing. */
function breakdownRows(breakdown) {
  const phases = (breakdown.phases ?? [])
    .filter((p) => p.ms > 0.005)
    .map((p) => ({ key: p.name, name: PHASE_LABELS[p.name] ?? p.name, value: p.ms, kind: "engine" }));
  const subs = (breakdown.subPhases ?? [])
    .filter((p) => p.ms > 0.005)
    .slice(0, 8)
    .map((p) => ({ key: `sub:${p.name}`, name: p.name, detail: "inside its stage", value: p.ms, kind: "module" }));
  const owners = breakdown.owners ?? [];
  const byType = new Map();
  for (const o of owners) {
    if (o.kind !== "component") continue;
    const row = byType.get(o.type) ?? { key: `t:${o.type}`, name: o.label, value: 0, count: 0, top: null, kind: "component" };
    row.value += o.ms;
    row.count++;
    if (!row.top || o.ms > row.top.ms) row.top = o;
    byType.set(o.type, row);
  }
  const components = [...byType.values()].map((r) => ({
    ...r,
    detail: r.count > 1 ? `${r.count} · most: ${r.top.entity} ${r.top.ms.toFixed(2)} ms` : r.top.entity,
  }));
  const modules = owners
    .filter((o) => o.kind === "module" || o.kind === "engine")
    .map((o) => ({ key: o.key, name: o.kind === "module" ? `${o.label} (module)` : o.label, value: o.ms, kind: o.kind }));
  const scripts = owners
    .filter((o) => o.kind === "script")
    .map((o) => ({
      key: o.key,
      name: o.label,
      title: o.path,
      value: o.ms,
      kind: "script",
      detail: o.hooks
        ? Object.entries(o.hooks)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([h, v]) => `${h} ${v.toFixed(2)}`)
            .join(" · ")
        : undefined,
    }));
  return { engine: [...phases, ...subs], components: [...components, ...modules], scripts };
}

/** The frame's owners: engine stages, components by type, scripts by file. */
function FrameBreakdown({ breakdown }) {
  const memo = useRef({ engine: new Map(), components: new Map(), scripts: new Map() });
  const [stable, setStable] = useState({ engine: [], components: [], scripts: [], total: 0 });

  // One smoothing step per capture — not per render, or the 10 Hz sampler's
  // ticks would decay every row between two captures.
  useEffect(() => {
    if (!breakdown) return;
    const raw = breakdownRows(breakdown);
    const next = {
      engine: smoothRows(memo.current.engine, raw.engine, GROUP_SLOTS.engine),
      components: smoothRows(memo.current.components, raw.components, GROUP_SLOTS.components),
      scripts: smoothRows(memo.current.scripts, raw.scripts, GROUP_SLOTS.scripts),
    };
    setStable((prev) => ({
      ...next,
      total: prev.total > 0 ? prev.total + ((breakdown.totalMs || 0) - prev.total) * ROW_SMOOTHING : breakdown.totalMs || 0,
    }));
  }, [breakdown]);

  return (
    <div className="perf-groups">
      <BreakdownGroup
        title="Engine stages"
        rows={stable.engine}
        total={stable.total}
        slots={GROUP_SLOTS.engine}
        empty="Measuring the next frames…"
      />
      <BreakdownGroup
        title="Components & modules"
        rows={stable.components}
        total={stable.total}
        slots={GROUP_SLOTS.components}
        empty="No component registered per-frame work"
      />
      <BreakdownGroup title="Scripts" rows={stable.scripts} total={stable.total} slots={GROUP_SLOTS.scripts} empty="No script ran this frame" />
    </div>
  );
}

/** Memory by owner: geometry per entity, bytes per texture. */
function MemoryOwners({ memory }) {
  const slots = GROUP_SLOTS.memory;
  const entities = (memory?.entities ?? []).slice(0, slots).map((e) => ({ key: e.id, name: e.name, value: e.bytes, kind: "component" }));
  const textures = (memory?.textures ?? [])
    .slice(0, slots)
    .map((t, i) => ({ key: `${t.name}:${i}`, name: t.name, detail: t.entity, value: t.bytes, kind: "module" }));
  return (
    <div className="perf-groups">
      <BreakdownGroup
        title="Geometry by entity"
        rows={entities}
        total={memory?.geometryTotal ?? 0}
        slots={slots}
        unit="MB"
        empty={memory ? "No geometry in the scene" : "Measuring…"}
      />
      <BreakdownGroup
        title="Textures"
        rows={textures}
        total={memory?.textureTotal ?? 0}
        slots={slots}
        unit="MB"
        empty={memory ? "No textures in the scene" : "Measuring…"}
      />
    </div>
  );
}

const COLORS = {
  cpuGame: "#3fd2b0",
  cpuRender: "#4c8dff",
  gpu: "#b06cff",
  frame: "#e8a33b",
  fps: "#4fd68f",
  heap: "#4c8dff",
  textures: "#3fd2b0",
  geometry: "#b06cff",
  gpuRender: "#b06cff",
  gpuCompute: "#e8a33b",
};

const CPU_SERIES = [
  { key: "cpuGame", color: COLORS.cpuGame },
  { key: "cpuRender", color: COLORS.cpuRender },
  { key: "gpu", color: COLORS.gpu },
];

const TABS = [
  { id: "cpu", label: "CPU" },
  { id: "gpu", label: "GPU" },
  { id: "memory", label: "Memory" },
  { id: "breakdown", label: "Breakdown" },
];

const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} ms` : "—");
const mb = (bytes) => (bytes > 0 ? `${(bytes / 1048576).toFixed(bytes > 104857600 ? 0 : 1)} MB` : "—");
const gb = (bytes) => `${(bytes / 1073741824).toFixed(1)} GB`;
const count = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US").replace(/,/g, " ") : "—");

/** Green inside the budget, orange over it, red past two of them. */
function tone(frameMs) {
  if (!(frameMs > 0)) return "";
  if (frameMs <= FRAME_BUDGET_MS) return "good";
  if (frameMs <= FRAME_BUDGET_MS * 2) return "warm";
  return "hot";
}

function fpsText(r) {
  if (!r) return "—";
  if (r.fps > 0) return String(Math.round(r.fps));
  return r.skippedFps > 0 ? "0" : "—";
}

/**
 * The performance monitor, in three sizes:
 *   fps     one pill — the frame rate
 *   medium  the frame rate, the frame time and a small three-line chart
 *   full    the profiler: CPU / GPU / Memory tabs over a chart with a time
 *           window and pause, the frame's tiles, memory and renderer counts
 * The same component is the viewport's HUD (with the size control) and the
 * Performance panel (always full).
 */
export function PerformanceMonitor({ size = "full", hud = false }) {
  const tick = usePerfStore((s) => s.tick);
  const paused = usePerfStore((s) => s.paused);
  const windowSec = usePerfStore((s) => s.windowSec);
  const tab = usePerfStore((s) => s.tab);
  const breakdown = usePerfStore((s) => s.breakdown);
  const memory = usePerfStore((s) => s.memory);

  useEffect(() => {
    let live = true;
    ensureEngine()
      .then((engine) => live && startPerfSampling(engine))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // The breakdown and the memory walk cost a little each frame or every two
  // seconds, so they run only while their tab is showing at full size.
  useEffect(() => {
    if (size !== "full" || tab !== "breakdown") return undefined;
    return watchBreakdown();
  }, [size, tab]);
  useEffect(() => {
    if (size !== "full" || tab !== "memory") return undefined;
    return watchMemory();
  }, [size, tab]);

  const r = readPerf();
  void tick;

  const sizeControl = hud ? (
    <span className="perf-sizes" role="group" aria-label="Monitor size">
      <button type="button" className={`perf-size-btn${size === "fps" ? " on" : ""}`} title="Frame rate only" onClick={() => setPerfSize("fps")}>
        <Minimize2 size={11} />
      </button>
      <button type="button" className={`perf-size-btn${size === "medium" ? " on" : ""}`} title="Frame rate and chart" onClick={() => setPerfSize("medium")}>
        <Rows3 size={11} />
      </button>
      <button type="button" className={`perf-size-btn${size === "full" ? " on" : ""}`} title="Full profiler" onClick={() => setPerfSize("full")}>
        <Maximize2 size={11} />
      </button>
    </span>
  ) : null;

  if (size === "fps") {
    return (
      <div className={`perf perf-fps tone-${tone(r?.frameMs)}`}>
        <button type="button" className="perf-pill" title="Frame rate — click for the chart" onClick={() => setPerfSize("medium")}>
          <span className="perf-pill-value">{fpsText(r)}</span>
          <span className="perf-pill-unit">FPS</span>
        </button>
      </div>
    );
  }

  if (size === "medium") {
    return (
      <div className={`perf perf-medium tone-${tone(r?.frameMs)}`}>
        <div className="perf-medium-head">
          <span className="perf-big">{fpsText(r)}</span>
          <span className="perf-big-unit">FPS</span>
          <span className="perf-medium-ms">{r ? ms(r.frameMs) : "—"}</span>
          {sizeControl}
        </div>
        <PerfChart series={CPU_SERIES} height={56} floor={33.3} />
        <div className="perf-legend small">
          <span><i style={{ background: COLORS.cpuGame }} />CPU <b>{r ? r.cpuGame.toFixed(1) : "—"}</b></span>
          <span><i style={{ background: COLORS.cpuRender }} />Render <b>{r ? r.cpuRender.toFixed(1) : "—"}</b></span>
          <span><i style={{ background: COLORS.gpu }} />GPU <b>{r ? r.gpu.toFixed(1) : "—"}</b></span>
        </div>
      </div>
    );
  }

  const gpuSeries = [
    { key: "gpu", color: COLORS.gpu },
    { key: "frame", color: COLORS.frame },
  ];
  const memSeries = [
    { key: "heap", color: COLORS.heap },
    { key: "textures", color: COLORS.textures },
    { key: "geometry", color: COLORS.geometry },
  ];
  const chart =
    tab === "gpu" ? (
      <PerfChart series={gpuSeries} height={120} floor={33.3} />
    ) : tab === "memory" ? (
      <PerfChart series={memSeries} height={120} unit="MB" floor={64 * 1048576} />
    ) : (
      <PerfChart series={CPU_SERIES} height={120} floor={33.3} />
    );
  const legend =
    tab === "gpu" ? (
      <>
        <span><i style={{ background: COLORS.gpu }} />{r?.gpuReal ? "GPU" : "GPU (submit)"} <b>{r ? ms(r.gpu) : "—"}</b></span>
        <span><i style={{ background: COLORS.frame }} />Frame <b>{r ? ms(r.frameMs) : "—"}</b></span>
        {r?.gpuReal && r.gpuRenderMs + r.gpuComputeMs > 0 && (
          <span className="perf-legend-note">render {r.gpuRenderMs.toFixed(1)} · compute {r.gpuComputeMs.toFixed(1)}</span>
        )}
      </>
    ) : tab === "memory" ? (
      <>
        <span><i style={{ background: COLORS.heap }} />Heap <b>{r ? mb(r.heap) : "—"}</b></span>
        <span><i style={{ background: COLORS.textures }} />Textures <b>{r ? mb(r.textures) : "—"}</b></span>
        <span><i style={{ background: COLORS.geometry }} />Geometry <b>{r ? mb(r.geometry) : "—"}</b></span>
      </>
    ) : (
      <>
        <span><i style={{ background: COLORS.cpuGame }} />CPU (Game) <b>{r ? ms(r.cpuGame) : "—"}</b></span>
        <span><i style={{ background: COLORS.cpuRender }} />CPU (Render) <b>{r ? ms(r.cpuRender) : "—"}</b></span>
        <span><i style={{ background: COLORS.gpu }} />GPU <b>{r ? ms(r.gpu) : "—"}</b></span>
      </>
    );

  const budgetPct = r ? Math.min((r.frameMs / FRAME_BUDGET_MS) * 100, 100) : 0;
  const heapPct = r && r.heapLimit > 0 ? Math.min((r.heap / r.heapLimit) * 100, 100) : 0;

  return (
    <div className={`perf perf-full tone-${tone(r?.frameMs)}`}>
      <div className="perf-head">
        <span className="perf-title">Performance</span>
        {sizeControl}
      </div>
      <div className="perf-toolbar">
        <span className="perf-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`perf-tab${tab === t.id ? " on" : ""}`}
              onClick={() => usePerfStore.setState({ tab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </span>
        <span className="perf-toolbar-right">
          <select
            className="select-field perf-window"
            value={windowSec}
            aria-label="Time window"
            onChange={(e) => usePerfStore.setState({ windowSec: Number(e.target.value) })}
          >
            {PERF_WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w} s
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`icon-btn perf-pause${paused ? " on" : ""}`}
            title={paused ? "Resume" : "Pause"}
            aria-pressed={paused}
            onClick={() => usePerfStore.setState({ paused: !paused })}
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </button>
        </span>
      </div>
      <div className="perf-legend">{legend}</div>
      {chart}
      {tab === "breakdown" ? (
        <FrameBreakdown breakdown={breakdown} />
      ) : (
        <>
      <div className="perf-tiles">
        <div className="perf-tile primary">
          <span className="perf-tile-label">Frame Time</span>
          <span className="perf-tile-value big">{r ? ms(r.frameMs) : "—"}</span>
          <span className="perf-tile-sub">{fpsText(r)} FPS</span>
        </div>
        <div className="perf-tile">
          <span className="perf-tile-label">Game Thread</span>
          <span className="perf-tile-value">{r ? ms(r.cpuGame) : "—"}</span>
        </div>
        <div className="perf-tile">
          <span className="perf-tile-label">Render Thread</span>
          <span className="perf-tile-value">{r ? ms(r.cpuRender) : "—"}</span>
        </div>
        <div className="perf-tile">
          <span className="perf-tile-label">{r?.gpuReal ? "GPU Time" : "GPU (submit)"}</span>
          <span className="perf-tile-value">{r ? ms(r.gpu) : "—"}</span>
        </div>
        <div className="perf-tile">
          <span className="perf-tile-label">Frame Budget</span>
          <span className="perf-tile-value">{FRAME_BUDGET_MS.toFixed(1)} ms</span>
          <span className="perf-bar" aria-hidden="true">
            <i style={{ width: `${budgetPct}%` }} />
          </span>
        </div>
      </div>
      <div className="perf-section-title">Memory &amp; Resources</div>
      <div className="perf-memory">
        <div className="perf-mem-col">
          <div className="perf-mem-head">
            <span className="perf-tile-label">Memory</span>
            <span className="perf-mem-total">
              {r && r.heap > 0 ? (r.heapLimit > 0 ? `${gb(r.heap)} / ${gb(r.heapLimit)}` : gb(r.heap)) : "—"}
            </span>
            {r && r.heapLimit > 0 && <span className="perf-mem-pct">{Math.round(heapPct)}%</span>}
          </div>
          <span className="perf-bar heap" aria-hidden="true">
            <i style={{ width: `${heapPct}%` }} />
          </span>
          <ul className="perf-list">
            <li><i style={{ background: COLORS.heap }} />JS heap<b>{r ? mb(r.heap) : "—"}</b></li>
            <li><i style={{ background: COLORS.textures }} />Textures<b>{r ? mb(r.textures) : "—"}</b></li>
            <li><i style={{ background: COLORS.geometry }} />Geometry<b>{r ? mb(r.geometry) : "—"}</b></li>
          </ul>
        </div>
        <div className="perf-mem-col">
          <div className="perf-mem-head">
            <span className="perf-tile-label">Renderer</span>
          </div>
          <ul className="perf-list plain">
            <li>Draw calls<b>{r ? count(r.drawCalls) : "—"}</b></li>
            <li>Triangles<b>{r ? count(r.triangles) : "—"}</b></li>
            {r && r.renderScale < 0.995 && <li>Render scale<b>{Math.round(r.renderScale * 100)}%</b></li>}
            {r && r.skippedFps > 0 && <li className="warm">Stalled<b>{Math.round(r.skippedFps)} /s</b></li>}
          </ul>
        </div>
      </div>
      {tab === "memory" && <MemoryOwners memory={memory} />}
        </>
      )}
    </div>
  );
}
