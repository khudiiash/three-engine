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

function readSize() {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return PERF_SIZES.includes(v) ? v : "medium";
  } catch {
    return "medium";
  }
}

export const usePerfStore = vmSingleton("perfStore", () =>
  create(() => ({
    tick: 0,
    paused: false,
    windowSec: 5,
    tab: "cpu",
    size: readSize(),
    // The breakdown (a phase capture with owners) and the memory-by-owner
    // walk, kept fresh only while a view watches them.
    breakdown: null,
    memory: null,
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
    frameMs: r.frameMs || 0,
    workMs: work,
    cpuGame,
    cpuRender,
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
