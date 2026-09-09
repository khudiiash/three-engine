import { create } from "zustand";
import { vmSingleton } from "./singleton.js";

/**
 * The performance monitor's numbers: a 10 Hz sampler over `engine.stats`
 * keeping the last minute of every series in a ring, and one store whose
 * `tick` the views subscribe to. The engine's hot path is untouched — the
 * sampler reads the readout the StatsSystem already keeps, from a timer.
 *
 * Series, all per sample:
 *   cpuGame   main-thread work minus the render encode (update, scripts,
 *             physics, the systems), ms
 *   cpuRender the render encode on the main thread, ms
 *   gpu       real on-GPU frame time (timestamp queries), else the encode
 *             time — `readPerf().gpuReal` says which
 *   frame     wall time between ticks, ms
 *   fps       frames presented in the last second
 *   heap      JS heap in use, bytes (Chromium only, else 0)
 *   textures  bytes in tracked textures
 *   geometry  bytes in the scene's geometry attributes (walked every 2 s)
 */

export const PERF_HZ = 10;
const KEEP_SEC = 60;
const CAP = KEEP_SEC * PERF_HZ;
export const SERIES = ["cpuGame", "cpuRender", "gpu", "frame", "fps", "heap", "textures", "geometry"];
export const FRAME_BUDGET_MS = 1000 / 60;
export const PERF_SIZES = ["fps", "medium", "full"];
export const PERF_WINDOWS = [5, 15, 60];
const SIZE_KEY = "engine.viewport.stats.size";
const POS_KEY = "engine.viewport.stats.pos";

function readSize() {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return PERF_SIZES.includes(v) ? v : "medium";
  } catch {
    return "medium";
  }
}

/** The HUD's place in its viewport, `{ x, y }` from the viewport's top-left,
 *  or null for its default corner. Written by dragging it (StatsOverlay). */
function readPos() {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
    return Number.isFinite(raw?.x) && Number.isFinite(raw?.y) ? { x: raw.x, y: raw.y } : null;
  } catch {
    return null;
  }
}

export const usePerfStore = vmSingleton("perfStore", () =>
  create(() => ({
    tick: 0,
    paused: false,
    windowSec: 5,
    tab: "cpu",
    size: readSize(),
    pos: readPos(),
    // The breakdown (a phase capture with owners) and the memory-by-owner
    // walk, kept fresh only while a view watches them.
    breakdown: null,
    memory: null,
    // The measured engine/other/idle split, refreshed in short windows while
    // the Breakdown tab is open. Null until the first window completes.
    audit: null,
    // The by-removal census: what each component/module actually costs. Run
    // on demand (it takes seconds and the viewport visibly changes), so it
    // is null until the user asks for it.
    census: null,
    censusProgress: null,
  })),
);

export function setPerfSize(size) {
  if (!PERF_SIZES.includes(size)) return;
  usePerfStore.setState({ size });
  try {
    localStorage.setItem(SIZE_KEY, size);
  } catch {
    /* forgotten between reloads, nothing more */
  }
}

/** Moves the HUD to `{ x, y }` in its viewport, or back to its corner (null). */
export function setPerfPos(pos) {
  usePerfStore.setState({ pos });
  try {
    if (pos) localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
    else localStorage.removeItem(POS_KEY);
  } catch {
    /* forgotten between reloads, nothing more */
  }
}

export function cyclePerfSize() {
  const cur = usePerfStore.getState().size;
  setPerfSize(PERF_SIZES[(PERF_SIZES.indexOf(cur) + 1) % PERF_SIZES.length]);
}

const ring = {
  head: 0,
  filled: 0,
  data: Object.fromEntries(SERIES.map((k) => [k, new Float32Array(CAP)])),
};
let latest = null;
// The frame interval, smoothed. `readout.frameMs` is ONE tick's interval and
// `readout.workMs` is the engine's own EMA over ~10 frames: reading the two
// side by side compares a smoothed number to an unsmoothed one, which is how
// the tiles came to disagree with each other. Same treatment for both.
let frameEma = 0;
const FRAME_EMA = 0.25;
let geometryBytes = 0;
let geometryStamp = 0;
let timer = null;
let engineRef = null;

function push(sample) {
  for (const key of SERIES) ring.data[key][ring.head] = sample[key] ?? 0;
  ring.head = (ring.head + 1) % CAP;
  if (ring.filled < CAP) ring.filled++;
}

/** Bytes held by the scene's geometry attributes, unique geometries once. */
function measureGeometry(engine) {
  const seen = new Set();
  let bytes = 0;
  engine.scene?.traverse?.((object) => {
    const g = object.geometry;
    if (!g || seen.has(g)) return;
    seen.add(g);
    for (const attr of Object.values(g.attributes ?? {})) bytes += attr?.array?.byteLength ?? 0;
    bytes += g.index?.array?.byteLength ?? 0;
  });
  return bytes;
}

function sample() {
  const engine = engineRef;
  const stats = engine?.stats;
  if (!stats) return;
  stats.sample();
  const r = stats.readout;
  const now = performance.now();
  if (now - geometryStamp > 2000) {
    geometryStamp = now;
    try {
      geometryBytes = measureGeometry(engine);
    } catch {
      /* a scene mid-rebuild: keep the last figure */
    }
  }
  const work = r.workMs || r.frameMs || 0;
  const cpuRender = r.renderMs || 0;
  const cpuGame = Math.max(work - cpuRender, 0);
  const gpuReal = r.gpuMs > 0;
  const gpu = gpuReal ? r.gpuMs : cpuRender;
  const heap = r.jsHeapBytes ?? 0;
  const frame = r.frameMs || 0;
  frameEma = frameEma > 0 ? frameEma + (frame - frameEma) * FRAME_EMA : frame;
  push({
    cpuGame,
    cpuRender,
    gpu,
    frame: r.frameMs || 0,
    fps: r.fps || 0,
    heap,
    textures: r.textureMem || 0,
    geometry: geometryBytes,
  });
  latest = {
    fps: r.fps || 0,
    skippedFps: r.skippedFps || 0,
    frameMs: frameEma,
    frameRawMs: frame,
    workMs: work,
    cpuGame,
    cpuRender,
    // What the loop did NOT spend executing: the display's vsync wait, the
    // browser's own frame scheduling, and the editor's frame limiter. The
    // frame's arithmetic closes on it — game + render + idle = the frame —
    // and without it a 29 ms frame made of 9 ms of work reads as a lie.
    idle: Math.max(frameEma - work, 0),
    // What the idle is MADE of. `callbackFps` is how often the host offered
    // us a frame and `frameLimit` is the cap we answered with, so together
    // they say whether the wait was ours to give or the browser's to impose.
    callbackFps: r.callbackFps || 0,
    hostFps: hostHz,
    frameLimit: engineRef?.frameRateLimit ?? 0,
    gpu,
    gpuReal,
    gpuRenderMs: r.gpuRenderMs ?? 0,
    gpuComputeMs: r.gpuComputeMs ?? 0,
    heap,
    heapLimit: globalThis.performance?.memory?.jsHeapSizeLimit ?? 0,
    textures: r.textureMem || 0,
    geometry: geometryBytes,
    drawCalls: r.drawCalls || 0,
    triangles: r.triangles || 0,
    renderScale: r.renderScale ?? 1,
    running: (r.fps || 0) > 0 || (r.skippedFps || 0) > 0,
  };
  if (!usePerfStore.getState().paused) usePerfStore.setState((s) => ({ tick: s.tick + 1 }));
}

/**
 * True while the viewport HUD is standing down because it was DRAGGED into
 * the dock as the Performance panel.
 *
 * The profiler has to end up in exactly one place, and both places have to be
 * reachable from the other. Dragging the HUD onto a tab strip is a one-way
 * gesture without this flag: the HUD switches itself off to avoid two live
 * profilers, and then closing the panel leaves the profiler nowhere at all —
 * which is the dead end the user actually hit. The panel reads this on its
 * way out and gives the HUD back.
 */
let handedOff = false;
export function setPerfHandedOff(value) {
  handedOff = !!value;
}
export function isPerfHandedOff() {
  return handedOff;
}

/**
 * How many frames the BROWSER offers a second, counted outside the engine.
 *
 * ⚠ THIS IS THE ONE THE ENGINE CANNOT MEASURE. `readout.callbackFps` counts
 * callbacks that reach the tick, and when the editor STOPS the loop — an
 * unfocused viewport freezing, idle pacing suspending it — no callback
 * reaches the tick at all. Read from inside, that state is indistinguishable
 * from a browser that has stopped offering frames, and the profiler duly
 * blamed the display for a 70% idle the editor had chosen itself.
 *
 * A bare requestAnimationFrame that increments a counter is immune to that,
 * because nothing in the app can stop it. The gap between this and `fps` is
 * then exactly the frames the editor declined to draw.
 *
 * Only runs while a profiler is on screen: it costs almost nothing, but it
 * is not free, and the editor's whole idle policy is about not doing work
 * nobody asked for.
 */
let hostWatchers = 0;
let hostRaf = 0;
let hostFrames = 0;
let hostWindowStart = 0;
let hostHz = 0;

function hostTick(now) {
  hostRaf = requestAnimationFrame(hostTick);
  hostFrames++;
  if (!hostWindowStart) hostWindowStart = now;
  const span = now - hostWindowStart;
  if (span >= 1000) {
    hostHz = (hostFrames * 1000) / span;
    hostFrames = 0;
    hostWindowStart = now;
  }
}

/** Counts the browser's frame offers while anything is watching. Returns an unsubscribe. */
export function watchHostFrameRate() {
  if (hostWatchers++ === 0) {
    hostFrames = 0;
    hostWindowStart = 0;
    hostRaf = requestAnimationFrame(hostTick);
  }
  return () => {
    if (--hostWatchers > 0) return;
    cancelAnimationFrame(hostRaf);
    hostRaf = 0;
    hostHz = 0;
  };
}

/**
 * ⭐ THE IDLE, MEASURED INSTEAD OF SUBTRACTED.
 *
 * `latest.idle` is `frameMs - workMs`, and a residual cannot tell waiting
 * from working: React rendering these very panels, the browser's style,
 * layout and paint, a GC pause, the WebGPU submission after the tick returns
 * — none of it is marked by the engine, so all of it was being displayed as
 * rest. `engine/frameAudit.js` measures the difference properly, with a
 * MessageChannel heartbeat that can only run when the thread is free, and
 * splits the frame into engine / other / genuinely parked.
 *
 * ⚠ IT IS NOT FREE AND NOT NEUTRAL — a heartbeat keeps the thread hot and
 * can suppress the browser's own idle behaviour — so it runs in SHORT
 * WINDOWS on a duty cycle rather than continuously, and only while a
 * profiler is actually showing the split. The reading between windows is
 * the last one taken, which is why it is stamped with its own age.
 */
const AUDIT_WINDOW_MS = 600;
const AUDIT_PERIOD_MS = 4000;
let auditWatchers = 0;
let auditTimer = 0;
let auditing = false;

async function runAudit() {
  if (auditing || !engineRef) return;
  auditing = true;
  try {
    const { auditFrames } = await import("../engine/frameAudit.js");
    const report = await auditFrames(engineRef, { ms: AUDIT_WINDOW_MS });
    if (auditWatchers > 0) usePerfStore.setState({ audit: { ...report, at: Date.now() } });
  } catch (err) {
    console.warn(`Frame audit unavailable: ${err?.message ?? err}`);
  } finally {
    auditing = false;
  }
}

/** Measures what the frame's idle is really made of, in windows. Returns an unsubscribe. */
export function watchFrameAudit() {
  if (auditWatchers++ === 0) {
    runAudit();
    auditTimer = setInterval(runAudit, AUDIT_PERIOD_MS);
  }
  return () => {
    if (--auditWatchers > 0) return;
    clearInterval(auditTimer);
    auditTimer = 0;
  };
}

/**
 * Prices every component and module by taking it away, and keeps the result.
 *
 * The one measurement that can see work the page has no clock for — issuing
 * GPU dispatches costs almost nothing on every timer in here and can still be
 * most of the frame. See frameCensus.js.
 */
export async function measureFrameCensus() {
  if (usePerfStore.getState().censusProgress) return;
  usePerfStore.setState({ censusProgress: { done: 0, total: 0, label: "starting" } });
  try {
    const [{ runFrameCensus }, engine] = await Promise.all([
      import("./frameCensus.js"),
      engineRef ? Promise.resolve(engineRef) : import("./engineInstance.js").then((m) => m.ensureEngine()),
    ]);
    const census = await runFrameCensus(engine, {
      onProgress: (done, total, label) => usePerfStore.setState({ censusProgress: { done, total, label } }),
    });
    usePerfStore.setState({ census });
  } catch (err) {
    console.warn(`Frame census failed: ${err?.message ?? err}`);
  } finally {
    usePerfStore.setState({ censusProgress: null });
  }
}

/** Starts the sampler on `engine` (idempotent; re-pointing follows an engine rebuild). */
export function startPerfSampling(engine) {
  engineRef = engine;
  if (timer) return;
  timer = setInterval(sample, 1000 / PERF_HZ);
}

/** The most recent sample's derived numbers, or null before the first. */
export function readPerf() {
  return latest;
}

// ─────────────────────────── the breakdown ───────────────────────────
// Who owns the frame: the engine's phase capture (which stage), with every
// per-frame callback charged to the component, module or script that
// registered it (StatsSystem.attribute). Armed only while the Breakdown tab
// is open — each capture is 30 frames, read, then re-armed, so the numbers
// are a rolling mean over the last half second or so.

let breakdownWanted = 0;
let breakdownLoop = null;

async function runBreakdown() {
  while (breakdownWanted > 0) {
    const stats = engineRef?.stats;
    if (!stats) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    if (!usePerfStore.getState().paused) {
      stats.beginPhaseCapture(30, { attribute: true });
      const deadline = performance.now() + 3000;
      while (!stats.phaseCaptureComplete() && performance.now() < deadline && breakdownWanted > 0) {
        await new Promise((r) => setTimeout(r, 60));
      }
      if (breakdownWanted <= 0) break;
      const capture = stats.readPhaseCapture();
      if (capture.frames > 0) usePerfStore.setState({ breakdown: capture });
    } else {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  breakdownLoop = null;
}

/** Keeps the breakdown fresh while at least one view wants it; returns a release. */
export function watchBreakdown() {
  breakdownWanted++;
  if (!breakdownLoop) breakdownLoop = runBreakdown();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    breakdownWanted = Math.max(0, breakdownWanted - 1);
  };
}

// ─────────────────────────── memory by owner ───────────────────────────

const TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
  "bumpMap",
  "displacementMap",
  "specularMap",
  "envMap",
  "lightMap",
  "clearcoatMap",
  "clearcoatNormalMap",
  "sheenColorMap",
  "transmissionMap",
  "thicknessMap",
];

/** A texture's bytes on the GPU, estimated from its image (mips included). */
function textureBytes(texture) {
  if (!texture) return 0;
  const mips = texture.mipmaps;
  if (Array.isArray(mips) && mips.length && mips[0]?.data?.byteLength) {
    return mips.reduce((sum, m) => sum + (m.data?.byteLength ?? 0), 0);
  }
  const image = texture.image;
  if (!image) return 0;
  if (image.data?.byteLength) return image.data.byteLength * (texture.generateMipmaps ? 1.333 : 1);
  const w = image.width ?? image.videoWidth ?? 0;
  const h = image.height ?? image.videoHeight ?? 0;
  if (!w || !h) return 0;
  const channels = texture.isDepthTexture ? 4 : 4;
  return w * h * channels * (texture.generateMipmaps === false ? 1 : 1.333);
}

function textureName(texture) {
  if (texture.name) return texture.name;
  const src = texture.image?.src ?? texture.userData?.path ?? texture.source?.data?.src ?? "";
  const base = String(src).split(/[\\/]/).pop();
  return base && !base.startsWith("blob:") && base.length < 80 ? base : `texture ${texture.uuid.slice(0, 6)}`;
}

/**
 * Memory by owner: geometry bytes per entity (a geometry counts once, for
 * the first entity holding it) and bytes per texture (once, however many
 * materials sample it). A walk of every entity's own objects — a child
 * entity's objects are its own.
 */
export function measureMemoryBreakdown(engine) {
  const geomSeen = new Set();
  const texSeen = new Map();
  const entities = [];
  let geometryTotal = 0;
  for (const entity of engine?.entities?.values?.() ?? []) {
    const rootObject = entity.object3D;
    if (!rootObject) continue;
    let bytes = 0;
    const walk = (object) => {
      if (object !== rootObject && object.userData?.entityId) return;
      const g = object.geometry;
      if (g && !geomSeen.has(g)) {
        geomSeen.add(g);
        let gb = 0;
        for (const attr of Object.values(g.attributes ?? {})) gb += attr?.array?.byteLength ?? 0;
        gb += g.index?.array?.byteLength ?? 0;
        bytes += gb;
      }
      const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const material of materials) {
        for (const slot of TEXTURE_SLOTS) {
          const tex = material?.[slot];
          if (!tex || !tex.isTexture || texSeen.has(tex.uuid)) continue;
          texSeen.set(tex.uuid, { name: textureName(tex), bytes: textureBytes(tex), entity: entity.name });
        }
      }
      for (const child of object.children ?? []) walk(child);
    };
    walk(rootObject);
    geometryTotal += bytes;
    if (bytes > 0) entities.push({ id: entity.id, name: entity.name ?? entity.id, bytes });
  }
  entities.sort((a, b) => b.bytes - a.bytes);
  const textures = [...texSeen.values()].sort((a, b) => b.bytes - a.bytes);
  const textureTotal = textures.reduce((sum, t) => sum + t.bytes, 0);
  return { entities, textures, geometryTotal, textureTotal, at: performance.now() };
}

let memoryWanted = 0;
let memoryTimer = null;
function refreshMemory() {
  if (!engineRef) return;
  try {
    usePerfStore.setState({ memory: measureMemoryBreakdown(engineRef) });
  } catch {
    /* a scene mid-rebuild: keep the last figures */
  }
}

/** Keeps the memory breakdown fresh (every 2 s) while a view wants it. */
export function watchMemory() {
  memoryWanted++;
  if (!memoryTimer) {
    refreshMemory();
    memoryTimer = setInterval(refreshMemory, 2000);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    memoryWanted = Math.max(0, memoryWanted - 1);
    if (memoryWanted === 0 && memoryTimer) {
      clearInterval(memoryTimer);
      memoryTimer = null;
    }
  };
}

/** The last `windowSec` seconds of one series, oldest first (a fresh array). */
export function readSeries(key, windowSec) {
  const src = ring.data[key];
  if (!src) return new Float32Array(0);
  const n = Math.min(ring.filled, Math.round(windowSec * PERF_HZ));
  const out = new Float32Array(n);
  let idx = (ring.head - n + CAP) % CAP;
  for (let i = 0; i < n; i++) {
    out[i] = src[idx];
    idx = (idx + 1) % CAP;
  }
  return out;
}
