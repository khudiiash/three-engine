// passLedger — a per-pass GPU ledger over a rolling window, read from three's
// timestamp-query pools.
//
// three stamps every compute dispatch and every render pass with a query
// pair keyed `c:<computeFrameCalls>:<node.id>:f<frame>` /
// `r:<renderFrameCalls>:<ctx.id>:f<frame>` and resolves them a few frames
// later into `backend.timestampQueryPool[type].timestamps`. The pools RETAIN
// a backlog (gpuTimestampRetention), so a reader has to remember what it has
// already counted. This module wraps `renderer.compute` and
// `backend.beginRender` ONCE to learn pass names, then scans the pools every
// presented frame and keeps a window of attributed samples.
//
// The same method `scripts/run-player-fps.mjs --passes` uses from puppeteer;
// this is the in-page copy so a build can show its own ledger on a device the
// harness cannot reach (the player's `?hud=1`). Rows are ms PER PRESENTED
// FRAME — three's frame ids advance per render call (shadow map, prepass,
// main), so an id count would over-count the main pass ~3×.
//
// Every number here carries the timestamp-query caveat: the GPU clocks down
// when it is not busy, so an idle frame reads slower per pass than a full one.
// Adapters without `timestamp-query` (Safari today) yield no rows at all —
// `rows()` returns [] and `available` is false.

/**
 * @param {import("./Engine.js").Engine} engine
 * @param {{ windowMs?: number }} [options]
 */
export function createPassLedger(engine, { windowMs = 2000 } = {}) {
  const renderer = engine.renderer;
  const backend = renderer?.backend;
  const registry = armPassNameRegistry(renderer);
  const seen = new Set();
  /** @type {{ t: number, label: string, ms: number }[]} */
  let samples = [];
  /** @type {number[]} presented-frame timestamps */
  let frames = [];
  // Everything already resolved belongs to frames before this ledger existed.
  for (const type of ["compute", "render"]) {
    const pool = backend?.timestampQueryPool?.[type];
    if (pool?.timestamps) for (const uid of pool.timestamps.keys()) seen.add(uid);
  }
  const scan = (now) => {
    for (const type of ["compute", "render"]) {
      const pool = backend?.timestampQueryPool?.[type];
      if (!pool?.timestamps) continue;
      for (const [uid, ms] of pool.timestamps) {
        if (seen.has(uid)) continue;
        seen.add(uid);
        const m = /^([rc]):(\d+):(.+):f(\d+)$/.exec(uid);
        if (!m) continue;
        // The POOL says what it was, not the uid's prefix: three prefixes
        // `c:` only for a bare ComputeNode (`isComputeNode`), so every ARRAY
        // dispatch — GI's grouped batches, the cloth arena's chains — is
        // stamped `r:` and used to read as an unnamed render context (the
        // phone's "r:(ctx undefined) 8.75 ms" was the cloth solver).
        const label = type === "compute"
          ? `c:${registry.names.get(m[3]) ?? `(id ${m[3]})`}`
          : `r:${registry.renderLabels.get(m[3]) ?? `(ctx ${m[3]})`}`;
        samples.push({ t: now, label, ms });
      }
    }
    // The seen set only ever grows; trim it against what the pools still hold
    // every few thousand entries so a long session does not keep every uid.
    if (seen.size > 20000) {
      const live = new Set();
      for (const type of ["compute", "render"]) {
        const pool = backend?.timestampQueryPool?.[type];
        if (pool?.timestamps) for (const uid of pool.timestamps.keys()) live.add(uid);
      }
      seen.clear();
      for (const uid of live) seen.add(uid);
    }
  };
  const tick = () => {
    const now = performance.now();
    frames.push(now);
    scan(now);
    const cut = now - windowMs * 2;
    if (frames.length && frames[0] < cut) {
      frames = frames.filter((t) => t >= cut);
      samples = samples.filter((s) => s.t >= cut);
    }
  };
  const detach = engine.onPostRender ? engine.onPostRender(tick) : null;
  return {
    /** True when the adapter resolves timestamp queries at all. */
    get available() {
      return !!(backend?.timestampQueryPool?.render?.timestamps || backend?.timestampQueryPool?.compute?.timestamps);
    },
    /**
     * Rows over the last `windowMs`, sorted by ms per presented frame.
     * @returns {{ frames: number, totalMsPerFrame: number, rows: { label: string, msPerFrame: number, callsPerFrame: number }[] }}
     */
    rows(now = performance.now()) {
      const from = now - windowMs;
      const nFrames = Math.max(1, frames.filter((t) => t >= from).length);
      const acc = new Map();
      for (const s of samples) {
        if (s.t < from) continue;
        const row = acc.get(s.label) ?? { ms: 0, calls: 0 };
        row.ms += s.ms;
        row.calls += 1;
        acc.set(s.label, row);
      }
      const rows = [...acc]
        .map(([label, v]) => ({ label, msPerFrame: v.ms / nFrames, callsPerFrame: v.calls / nFrames }))
        .sort((a, b) => b.msPerFrame - a.msPerFrame);
      return { frames: nFrames, totalMsPerFrame: rows.reduce((t, r) => t + r.msPerFrame, 0), rows };
    },
    dispose() {
      detach?.();
      samples = [];
      frames = [];
    },
  };
}

/**
 * Learns pass names as they are dispatched: compute nodes carry
 * `__giPassName` (GI) or `name`; render contexts are labelled by their target
 * and size. Installed once per renderer and shared by every ledger.
 */
export function armPassNameRegistry(renderer) {
  if (renderer.__passLedgerRegistry) return renderer.__passLedgerRegistry;
  const names = new Map();
  const renderLabels = new Map();
  const rawCompute = renderer.compute.bind(renderer);
  let anonymousSeq = 0;
  renderer.compute = (nodes, size) => {
    const list = Array.isArray(nodes) ? nodes : [nodes];
    // An array with no id stamps `undefined` into its timestamp uid and
    // every such chain collapses into one row. Give it one (the same trick
    // GI's grouped dispatch uses, in its own range) so the cloth arena, the
    // water solver and any other module chain get their own named rows.
    if (Array.isArray(nodes) && nodes.id == null) nodes.id = 0x50000000 + (anonymousSeq++ % 0x0fffffff);
    const id = Array.isArray(nodes) ? nodes.id : nodes?.id;
    if (id != null && !names.has(String(id))) {
      const parts = list.map((n) => n?.__giPassName || n?.name || "?");
      const uniq = [...new Set(parts)];
      names.set(String(id), uniq.length === 1 && parts.length > 1 ? `${uniq[0]} ×${parts.length}` : parts.join("+").slice(0, 60));
    }
    return rawCompute(nodes, size);
  };
  const backend = renderer.backend;
  if (backend?.beginRender) {
    const rawBegin = backend.beginRender.bind(backend);
    backend.beginRender = (ctx) => {
      if (ctx && !renderLabels.has(String(ctx.id))) {
        const rt = ctx.renderTarget;
        const tex = rt?.texture ?? rt?.textures?.[0];
        // A minified build turns `constructor.name` into two letters ("Xi"),
        // so an unnamed target is described by its shape instead: texture
        // count, MSAA, depth — and the camera that drew it.
        const shape = rt
          ? `rt${rt.textures?.length ?? 1}${rt.samples > 1 ? `x${rt.samples}` : ""}${rt.depthTexture ? "+D" : ""}`
            + `:${tex?.format ?? "?"}/${tex?.type ?? "?"}`
          : "canvas";
        const base = rt ? (tex?.name || rt.depthTexture?.name || shape) : "canvas";
        const cam = ctx.camera?.name || (ctx.camera?.isOrthographicCamera ? "ortho" : "")
          + (ctx.scene?.name ? `/${ctx.scene.name}` : "");
        renderLabels.set(String(ctx.id), `${base}${cam ? `@${cam}` : ""}:${ctx.width ?? "?"}x${ctx.height ?? "?"}`);
      }
      return rawBegin(ctx);
    };
  }
  renderer.__passLedgerRegistry = { names, renderLabels };
  return renderer.__passLedgerRegistry;
}
