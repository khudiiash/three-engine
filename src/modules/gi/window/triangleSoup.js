// GI2 — THE TRIANGLE SOUP BUILDER (main-thread side; plan §4.1, Stage 2.2)
//
// Owns the Web Worker that turns `{geometries, placements}` — the exact shape
// `GISystem#occupancyContentOf` already produces — into the packed world-space
// soup + 4 m grid described in `triangleSoup.worker.js`.
//
// ══ THE FIRST `new Worker` IN THIS ENGINE ════════════════════════════════════
//
// There was none in `src/` before this (plan §7.5). The spawn form below is the
// one that survives all four builds we ship through, and it is not
// interchangeable with the alternatives:
//
//   new Worker(new URL("./triangleSoup.worker.js", import.meta.url), { type: "module" })
//
//   · Vite DEV serves the worker file as a transformed ES MODULE, so `type:
//     "module"` is mandatory — a classic worker chokes on the first `export`.
//   · Vite BUILD (editor `vite.config.js`, player `vite.player.config.js`, and
//     the browser-preview/export path that copies `dist-player/`) statically
//     recognises this exact `new URL(..., import.meta.url)` literal and emits a
//     separate worker chunk with a hashed, base-relative URL. A computed URL,
//     a string variable, or `import.meta.url` behind a helper defeats that
//     analysis and ships a 404 in the packaged game.
//   · Tauri loads the same built output over its custom protocol; a
//     base-relative worker chunk is what makes that work.
//
// ⚠ `worker.format` is Vite's default (`iife`) in this repo. That is fine for
// THIS worker only because it imports nothing — it is a single self-contained
// chunk either way. A future worker that imports a shared module needs
// `worker: { format: "es" }` in both vite configs, or the chunk will be
// inlined/duplicated. See the Stage 2.2 report.
//
// ══ TRANSFER, AND WHOSE ARRAYS THEY ARE ══════════════════════════════════════
//
// Geometry buffers are TRANSFERRED (detached from this thread) — that is what
// keeps the post at memcpy speed instead of a structured clone of 100 MB. But
// `serializeMeshForBake` REFERENCES `geometry.attributes.position.array` when
// the layout allows it (§19 Stage 0.2), so transferring what the caller handed
// us would detach LIVE three.js geometry and blank the mesh. Hence
// `copyInputs: true` by DEFAULT: we copy, then transfer our copies. A caller
// that owns disposable arrays passes `copyInputs: false` and loses them.

// ⚠ THESE TWO CONSTANTS ARE DELIBERATELY NOT IMPORTED from the worker module.
// Importing it here would make the same file both a worker entry AND a module
// in the main graph, so Vite would emit its code twice (once as the worker
// chunk, once inlined in the app chunk) — and the point of the worker is that
// its chunk is self-contained. They are format constants (`grid.cell`, the
// palette's "none" byte) and the worker's copies are the authority; the node
// gate asserts the two agree.
export const SOUP_CELL_SIZE = 4.0;
export const PAL_NONE = 255;

/**
 * @typedef {{
 *   triCount: number, tris: Float32Array, triPal: Uint32Array,
 *   grid: {origin: number[], cell: number, dim: number[]},
 *   cellRange: Uint32Array, cellTris: Uint32Array, bytes: number,
 *   dropped: number, truncated: boolean, cut: Array<{placement: number, tris: number}>,
 *   stats: Object,
 * }} TriangleSoup
 */

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Thrown into the older promise when a newer build supersedes it. */
export class SoupSupersededError extends Error {
  constructor() {
    super("triangle soup build superseded by a newer request");
    this.name = "SoupSupersededError";
    this.superseded = true;
  }
}

/**
 * @param {{copyInputs?: boolean, workerFactory?: () => Worker}} [options]
 */
export function createTriangleSoupBuilder(options = {}) {
  const copyInputsDefault = options.copyInputs !== false;
  const spawn = options.workerFactory ?? (() => new Worker(
    new URL("./triangleSoup.worker.js", import.meta.url),
    { type: "module" },
  ));

  let worker = null;
  let pending = null; // { gen, resolve, reject, tPost }
  let gen = 0;
  let disposed = false;
  const api = {
    /** Main-thread milliseconds the last `build()` call blocked for. */
    lastStallMs: 0,
    /** Wall milliseconds from post to result for the last completed build. */
    lastBuildMs: 0,
    /** Milliseconds the worker cold-start cost (first build only). */
    lastSpawnMs: 0,
  };

  const ensureWorker = () => {
    if (worker) return worker;
    const t0 = now();
    worker = spawn();
    api.lastSpawnMs = now() - t0;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (!msg || !pending || msg.gen !== pending.gen) return; // a stale worker's reply
      const p = pending;
      if (msg.type === "done") {
        pending = null;
        api.lastBuildMs = now() - p.tPost;
        const soup = msg.soup;
        soup.postStallMs = p.stallMs;
        soup.wallMs = api.lastBuildMs;
        p.resolve(soup);
      } else if (msg.type === "error") {
        pending = null;
        const err = new Error(`triangle soup worker: ${msg.message}`);
        err.workerStack = msg.stack;
        p.reject(err);
      }
    };
    worker.onerror = (event) => {
      const p = pending;
      pending = null;
      // A worker that threw at module scope (a bad chunk URL in a packaged
      // build is exactly this) never recovers — drop it so the next build
      // spawns a fresh one and reports its own failure.
      try { worker?.terminate(); } catch { /* already gone */ }
      worker = null;
      p?.reject(new Error(`triangle soup worker failed to run: ${event?.message ?? "unknown error"}`));
    };
    return worker;
  };

  /**
   * Single in-flight: a newer request TERMINATES the running one. A generation
   * id alone cannot cancel anything here — the worker is inside a synchronous
   * multi-second loop and will not read a cancel message until it is done, so
   * "cancel" without terminate means the new scene waits for the old scene's
   * build to finish. The id stays as the guard against a reply that was already
   * in flight when we terminated.
   *
   * @param {{geometries: Map|Array|Object, placements: Array, cellSize?: number, triCap?: number, copyInputs?: boolean}} request
   * @returns {Promise<TriangleSoup>}
   */
  const build = (request) => {
    if (disposed) return Promise.reject(new Error("triangle soup builder disposed"));
    if (pending) {
      const stale = pending;
      pending = null;
      try { worker?.terminate(); } catch { /* already gone */ }
      worker = null;
      stale.reject(new SoupSupersededError());
    }
    const tStall = now();
    const myGen = ++gen;
    let promise;
    try {
      const payload = packRequest(request, request.copyInputs ?? copyInputsDefault);
      const w = ensureWorker();
      promise = new Promise((resolve, reject) => {
        pending = { gen: myGen, resolve, reject, tPost: now(), stallMs: 0 };
      });
      w.postMessage({ type: "build", gen: myGen, input: payload.input }, payload.transfer);
    } catch (err) {
      pending = null;
      api.lastStallMs = now() - tStall;
      return Promise.reject(err);
    }
    const stall = now() - tStall;
    api.lastStallMs = stall;
    if (pending) { pending.stallMs = stall; pending.tPost = now(); }
    return promise;
  };

  const dispose = () => {
    disposed = true;
    const p = pending;
    pending = null;
    try { worker?.terminate(); } catch { /* already gone */ }
    worker = null;
    p?.reject(new SoupSupersededError());
  };

  api.build = build;
  api.dispose = dispose;
  return api;
}

/**
 * Turns the caller's live objects into a structured-cloneable payload plus its
 * transfer list. This is the ONLY main-thread work the builder does, and it is
 * a memcpy per referenced geometry — a placement matrix is 16 floats and a
 * geometry shipped twice is shipped once (deduped by key), so the cost tracks
 * unique geometry bytes, not scene complexity.
 */
function packRequest(request, copyInputs) {
  const src = request?.geometries;
  const placementsIn = request?.placements ?? [];
  const transfer = [];
  const geoms = [];
  const wanted = new Set();
  for (const p of placementsIn) if (p?.geometryKey != null) wanted.add(p.geometryKey);

  const push = (key, geo) => {
    if (!geo?.positions || !wanted.has(key)) return; // never ship geometry nothing places
    const positions = copyInputs ? geo.positions.slice() : geo.positions;
    const index = geo.index ? (copyInputs ? geo.index.slice() : geo.index) : null;
    geoms.push({ key, positions, index });
    transfer.push(positions.buffer);
    if (index) transfer.push(index.buffer);
  };
  if (src instanceof Map) for (const [key, geo] of src) push(key, geo);
  else if (Array.isArray(src)) {
    for (const entry of src) {
      if (!entry) continue;
      if (Array.isArray(entry)) push(entry[0], entry[1]);
      else push(entry.key ?? entry.geometryKey, entry);
    }
  } else if (src) for (const key of Object.keys(src)) push(key, src[key]);

  const placements = [];
  for (const p of placementsIn) {
    if (p?.geometryKey == null) continue;
    // THREE.Matrix4 | Float32Array(16) | number[16] — the caller's `matrix` is
    // a Matrix4 today (`#occupancyContentOf`), a bare array in the tests.
    const e = p.matrix?.elements ?? p.matrix;
    if (!e || e.length < 16) continue;
    placements.push({
      geometryKey: p.geometryKey,
      matrix: Float32Array.from(e), // 64 B; cloned, never transferred (a transfer list of 2000 tiny buffers costs more than the clone)
      pal: (p.pal ?? PAL_NONE) & 255,
      slot: p.slot,
    });
  }
  return {
    input: {
      geometries: geoms,
      placements,
      cellSize: request?.cellSize ?? SOUP_CELL_SIZE,
      triCap: request?.triCap,
    },
    transfer: [...new Set(transfer)],
  };
}
