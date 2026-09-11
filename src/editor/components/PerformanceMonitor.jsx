import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play, Rows3, ScanEye } from "../icons/index.jsx";
import { ensureEngine } from "../engineInstance.js";
import {
  FRAME_BUDGET_MS,
  PERF_WINDOWS,
  readPerf,
  setPerfSize,
  startPerfSampling,
  usePerfStore,
  watchBreakdown,
  measureFrameCensus,
  watchFrameAudit,
  watchHostFrameRate,
  watchMemory,
} from "../perfMonitor.js";
import { holdViewportAwake } from "../viewportFreeze.js";
import { PerfChart } from "./PerfChart.jsx";

import { Select } from "../fields/Select.jsx";
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
    const row = byType.get(o.type) ?? { key: `t:${o.type}`, name: o.label, value: 0, count: 0, dispatches: 0, top: null, kind: "component" };
    row.value += o.ms;
    row.count++;
    // ⚠ MILLISECONDS ALONE CALL A GPU COMPONENT FREE. A cloth's update is
    // 0.008 ms of main thread and then three hundred compute dispatches the
    // frame has to wait for. The count goes in the row's own line, because a
    // reader scanning for the expensive thing must be able to see it there.
    row.dispatches += o.dispatches ?? 0;
    if (!row.top || o.ms > row.top.ms) row.top = o;
    byType.set(o.type, row);
  }
  const components = [...byType.values()].map((r) => {
    const parts = [];
    if (r.count > 1) parts.push(`${r.count} · most: ${r.top.entity} ${r.top.ms.toFixed(2)} ms`);
    else parts.push(r.top.entity);
    if (r.dispatches > 0) parts.push(`${Math.round(r.dispatches)} GPU dispatches/frame`);
    return { ...r, detail: parts.join(" · ") };
  });
  const modules = owners
    .filter((o) => o.kind === "module" || o.kind === "engine")
    .map((o) => ({
      key: o.key,
      name: o.kind === "module" ? `${o.label} (module)` : o.label,
      value: o.ms,
      kind: o.kind,
      detail: o.dispatches > 0 ? `${Math.round(o.dispatches)} GPU dispatches/frame` : undefined,
    }));
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

/**
 * Where the whole frame went, before any of the work is broken down.
 *
 * The stage lists below only ever add up to the WORK, and on a paced frame
 * the work is the small half — ten milliseconds of engine inside a thirty
 * millisecond frame, with nothing on screen to say what the other twenty
 * were. This group is that sentence: game, render, and the wait, adding up
 * to the frame.
 *
 * And the wait gets a REASON, because "idle" on its own only renames the
 * question. The engine counts frame callbacks before its limiter can turn
 * one away, so comparing what the host OFFERED with what we DREW separates
 * the two possible answers: fewer draws than offers is the editor pacing
 * itself on purpose, and offers that already match the draws mean nothing
 * here is pacing anything — the display, the compositor or an occluded
 * window is, and no engine change will move it.
 */
function FrameWhere({ r, audit }) {
  if (!r) return null;
  const frame = r.frameMs || 0;
  // ⚠ MEASURED WHEN WE HAVE IT, SUBTRACTED ONLY WHEN WE DO NOT. `r.idle` is
  // `frameMs - workMs`, and a residual cannot tell waiting from working:
  // React rendering this very panel, style, layout, paint and GC are all
  // unmarked, so all of them were being displayed as rest. The audit's
  // heartbeat can only run when the thread is free, so its three numbers are
  // three measurements — and they are labelled as such, because a number the
  // profiler did not measure must not be given a name that claims it did.
  // ⭐ ONE FRAME, ITEMISED, WITH NOTHING LEFT OVER. Each row is a measured
  // span charged to whoever was innermost, so the engine's tick is not billed
  // again as three's frame callback around it, and the rows add up to the
  // frame the browser actually offered. `unbilledMs` is the residual and is
  // shown when it is not negligible, because an accounting that cannot be
  // checked is an assertion.
  const KIND_CLASS = { engine: "component", callback: "module", browser: "script", parked: "script" };
  const DETAIL = {
    "engine tick": "update, scripts, physics, the render submit",
    "Browser and untagged tasks": "style, layout, paint, GC, and timers older than this window",
    "Thread parked": "nothing was executing — see Cost by removal for what it is waiting on",
  };
  const rows = audit?.frame?.length
    ? audit.frame.map((row, i) => ({
        key: `${row.name}:${i}`,
        name: row.name === "engine tick" ? "Engine tick" : row.name,
        detail: DETAIL[row.name],
        value: row.perFrameMs,
        kind: KIND_CLASS[row.kind] ?? "component",
      }))
    : [
        { key: "game", name: "Game update", value: r.cpuGame || 0, kind: "component" },
        { key: "render", name: "Render encode", value: r.cpuRender || 0, kind: "module" },
        {
          key: "idle",
          name: "Unaccounted",
          detail: "everything the engine does not mark — measuring…",
          value: r.idle || 0,
          kind: "script",
        },
      ];
  // The audit divides by the browser's frame OFFERS, so its three numbers sum
  // to one OFFERED frame's period — which is the frame interval only when
  // every offer drew. Totalling the rows themselves keeps the arithmetic on
  // screen self-consistent instead of leaving a silent remainder.
  const total = audit ? rows.reduce((sum, row) => sum + row.value, 0) : frame;
  return (
    <div className="perf-group">
      <div className="perf-group-head">
        <span className="perf-group-title">Where the frame went</span>
        <span className="perf-group-sum">
          {total.toFixed(2)} ms{audit ? " per frame offered" : ""}
        </span>
      </div>
      <ul className="perf-rows">
        {rows.map((row) => {
          const pct = total > 0 ? Math.min((row.value / total) * 100, 100) : 0;
          return (
            <li className={`perf-row kind-${row.kind}`} key={row.key}>
              <span className="perf-row-name">
                {row.name}
                {row.detail && <small>{row.detail}</small>}
              </span>
              <span className="perf-row-ms">{row.value.toFixed(2)} ms</span>
              <span className="perf-row-pct">
                <span className="perf-row-bar" aria-hidden="true">
                  <i style={{ width: `${pct}%` }} />
                </span>
                {pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * What each component and module costs, measured by taking it away.
 *
 * ⚠ THIS EXISTS BECAUSE THE ROWS ABOVE CANNOT SEE EVERYTHING. Work handed to
 * the GPU costs almost nothing on every clock inside the page — a cloth
 * solver reads 1.65 ms of main thread and 2.49 ms of GPU pass time and makes
 * the frame 26 ms longer — so the accounting kept ending in a large row that
 * belonged to nobody. Removing a thing and looking at the frame is the only
 * way to price it, and it is a button rather than a reading because it takes
 * seconds and the viewport changes while it runs.
 */
function FrameCensus({ census, progress }) {
  const rows = census?.rows?.filter((row) => (row.costMs ?? 0) > 0.05) ?? [];
  const drifted =
    census && census.baseline.frameMs !== null && census.restored.frameMs !== null
      ? Math.abs(census.baseline.frameMs - census.restored.frameMs) > census.baseline.frameMs * 0.1
      : false;
  return (
    <div className="perf-group">
      <div className="perf-group-head">
        <span className="perf-group-title">Cost by removal</span>
        <button
          className="toolbar-btn perf-census-btn"
          disabled={!!progress}
          onClick={measureFrameCensus}
          title="Skip each component and module in turn and compare the frame. About a second each; the scene is not modified."
        >
          <ScanEye size={12} className="perf-tile-icon" aria-hidden="true" />
          {progress ? `${progress.done}/${progress.total || "…"}` : census ? "Again" : "Measure"}
        </button>
      </div>
      <ul className="perf-rows">
        {rows.map((row) => (
          <li className="perf-row kind-component" key={row.key}>
            <span className="perf-row-name">
              {row.label}
              <small>
                {row.instances > 1 ? `${row.instances} · ` : ""}
                {row.withoutFps} fps without it
              </small>
            </span>
            <span className="perf-row-ms">{row.costMs.toFixed(2)} ms</span>
            <span className="perf-row-pct">
              <span className="perf-row-bar" aria-hidden="true">
                <i
                  style={{
                    width: `${Math.min((row.costMs / Math.max(census.baseline.frameMs ?? 1, 0.01)) * 100, 100)}%`,
                  }}
                />
              </span>
              {Math.round((row.costMs / Math.max(census.baseline.frameMs ?? 1, 0.01)) * 100)}%
            </span>
          </li>
        ))}
        {!rows.length && (
          <li className="perf-row empty note">
            {progress
              ? `Measuring ${progress.label || "…"}`
              : census
                ? "Nothing measurable: removing any one of them left the frame the same."
                : "Not measured yet."}
          </li>
        )}
        {/* ⚠ THESE NUMBERS DO NOT ADD UP TO "Unaccounted" AND MUST NOT LOOK
            LIKE THEY SHOULD. Removing a component shortens the frame; what is
            left is the wait every frame has once its work is done, and no
            amount of removing anything takes that away. Saying the two
            numbers plainly, side by side, is the only way to stop the reader
            doing the subtraction and finding a hole. */}
        {census && rows.length > 0 && (
          <li className="perf-row empty note">
            Frame is {census.baseline.frameMs} ms; without {rows[0].label} it is {rows[0].withoutFrameMs} ms. The rest
            is the wait every frame has once its work is done.
          </li>
        )}
        {drifted && (
          <li className="perf-row empty note">
            ⚠ The frame moved during the run ({census.baseline.frameMs} ms → {census.restored.frameMs} ms), so these
            are only as good as that.
          </li>
        )}
      </ul>
    </div>
  );
}

/** The frame's owners: engine stages, components by type, scripts by file. */
function FrameBreakdown({ breakdown, readout, audit, census, censusProgress }) {
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
      <FrameWhere r={readout} audit={audit} />
      <FrameCensus census={census} progress={censusProgress} />
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
// The full chart carries the frame line too: the distance between it and the
// work lines IS the idle time, and seeing that gap is what stops a 29 ms frame
// made of 9 ms of work from reading as a contradiction.
const CPU_FULL_SERIES = [...CPU_SERIES, { key: "frame", color: COLORS.frame }];

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
  const audit = usePerfStore((s) => s.audit);
  const census = usePerfStore((s) => s.census);
  const censusProgress = usePerfStore((s) => s.censusProgress);
  // The biggest thing the census could account for, if it has ever been run.
  const censusTop = census?.rows?.find((row) => (row.costMs ?? 0) > 0.05) ?? null;

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
  // The browser's own frame rate, for as long as a profiler is displayed.
  useEffect(() => watchHostFrameRate(), []);

  // ⚠ AN INSTRUMENT MUST NOT CHANGE WHAT IT MEASURES. Docked, this panel owns
  // the focus, so the unfocused-viewport freeze paused the very viewport it
  // was reading — and then honestly reported a 25 ms frame that was 5 ms of
  // work and 20 ms of waiting, which describes a paused viewport and says
  // nothing whatever about the scene. Reading the frame is a reason to keep
  // drawing it.
  //
  // Not at the smallest size: the frame-rate pill is a glance, not a
  // measurement, and holding the viewport awake for it would cancel the
  // editor's idle saving for as long as the overlay is switched on.
  useEffect(() => {
    if (size === "fps") return undefined;
    return holdViewportAwake();
  }, [size]);

  // The measured split costs a hot thread while its window runs, so it is
  // taken only where it is displayed.
  useEffect(() => {
    if (size !== "full" || tab !== "breakdown") return undefined;
    return watchFrameAudit();
  }, [size, tab]);

  useEffect(() => {
    if (size !== "full" || tab !== "breakdown") return undefined;
    return watchBreakdown();
  }, [size, tab]);
  useEffect(() => {
    if (size !== "full" || tab !== "memory") return undefined;
    return watchMemory();
  }, [size, tab]);

  const r = readPerf();
  // The main thread is parked because the GPU has not finished. That is not a
  // mystery needing a census — it is the GPU tile two columns over, and the
  // unaccounted tile should say so rather than send the reader looking.
  // ⚠ Must come AFTER `r`: declared above it this threw "Cannot access 'r'
  // before initialization" and took the whole panel down with it.
  const gpuBound = !!r?.gpuReal && r.frameMs > 0 && r.gpu > r.frameMs * 0.6;
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
      <PerfChart series={CPU_FULL_SERIES} height={120} floor={33.3} />
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
        <span><i style={{ background: COLORS.frame }} />Frame <b>{r ? ms(r.frameMs) : "—"}</b></span>
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
          <Select
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
          </Select>
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
        <FrameBreakdown
          breakdown={breakdown}
          readout={r}
          audit={audit}
          census={census}
          censusProgress={censusProgress}
        />
      ) : (
        <>
      <div className="perf-tiles">
        <div className="perf-tile primary" title="The interval between frames, smoothed. Game + Render + Idle add up to it.">
          <span className="perf-tile-label">Frame Time</span>
          <span className="perf-tile-value big">{r ? ms(r.frameMs) : "—"}</span>
          <span className="perf-tile-sub">{fpsText(r)} FPS</span>
        </div>
        <div className="perf-tile" title="Main-thread work in the tick, without the render submit: update, scripts, physics, the systems.">
          <span className="perf-tile-label">Game Thread</span>
          <span className="perf-tile-value">{r ? ms(r.cpuGame) : "—"}</span>
        </div>
        <div className="perf-tile" title="Main-thread time inside renderer.render() — encoding and submitting the frame's draws.">
          <span className="perf-tile-label">Render Thread</span>
          <span className="perf-tile-value">{r ? ms(r.cpuRender) : "—"}</span>
        </div>
{/* ⚠ THE TILE THAT KEPT SAYING NOTHING. This is the frame interval minus
            the engine's own marks, so it holds real waiting AND everything the
            engine cannot see — and for a scene with a GPU-heavy component it
            is most of the frame with no owner against it. The number is still
            a subtraction, but it does not have to stay ANONYMOUS: one click
            prices every component by removing it, and the answer sits under
            the number from then on. */}
        <button
          type="button"
          className="perf-tile perf-tile-action"
          disabled={!!censusProgress}
          onClick={measureFrameCensus}
          title="Frame time not accounted for by the engine's own marks: real waiting, plus anything the engine cannot measure — the editor's React, style, layout and paint, GC, and work handed to the GPU. Click to price every component and module by removing each in turn; about a second per row, and the scene is not modified."
        >
          <span className="perf-tile-label">
            Unaccounted
            <ScanEye size={12} className="perf-tile-icon" aria-hidden="true" />
          </span>
          <span className="perf-tile-value">{r ? ms(r.idle) : "—"}</span>
          {(censusProgress || censusTop || gpuBound) && (
            <span className="perf-tile-sub">
              {censusProgress
                ? `measuring ${censusProgress.label || "…"}`
                : censusTop
                  ? `${censusTop.label}: ${censusTop.costMs.toFixed(1)} ms if removed`
                  : `waiting on the GPU (${ms(r.gpu)})`}
            </span>
          )}
        </button>
        <div
          className="perf-tile"
          title={
            r?.gpuReal
              ? "On-GPU time from timestamp queries. It overlaps the CPU frame rather than adding to it."
              : "No GPU timestamps on this adapter — this is the CPU-side submit time, which understates async GPU work."
          }
        >
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
