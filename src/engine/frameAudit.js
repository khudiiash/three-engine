/**
 * ⭐⭐⭐ WHAT THE "IDLE" IS ACTUALLY MADE OF.
 *
 * The profiler reports idle as a RESIDUAL — `frameMs - workMs` — and a
 * residual cannot tell waiting from working. Every millisecond the main thread
 * spends on something the engine does not mark lands in it and is then
 * displayed as rest: React rendering the editor's own panels, the browser's
 * style/layout/paint of the DOM, a GC pause, another rAF callback, the
 * WebGPU submission that happens after the tick returns. A 29 ms frame made of
 * 8 ms of marked work reads as "21 ms idle" whether the thread was parked on
 * vsync or flat out the whole time. The user's verdict on 2026-09-09: "it says
 * its idle / wait time, but I don't think so."
 *
 * ⭐ THE TRICK: A HEARTBEAT CAN ONLY RUN WHEN THE THREAD IS FREE. A
 * `MessageChannel` message posts a macrotask that the event loop runs at the
 * first opportunity and never sooner (and unlike `setTimeout` it carries no
 * 4 ms clamp). Re-post it from its own handler and it runs back-to-back,
 * microseconds apart, for as long as nothing else wants the thread. Every gap
 * between two consecutive beats is therefore a CONTIGUOUS BUSY BLOCK, measured
 * from outside, with no cooperation from the code that was running.
 *
 * That converts the residual into two different numbers:
 *
 *   busy   — the thread was executing something (ours or not)
 *   idle   — the thread was genuinely parked, waiting for a frame
 *
 * and the blocks are then attributed by CONTAINMENT: the engine stamps
 * `performance.now()` from inside its own update, so the one block that
 * contains a stamp is that frame's tick — its whole tick, render included,
 * because a tick is one uninterrupted block. Every other block is somebody
 * else's, and those are the milliseconds the profiler has been calling rest.
 *
 * ⚠ THE INSTRUMENT IS NOT FREE AND IT IS NOT NEUTRAL. A heartbeat keeps the
 * main thread hot, which can suppress the browser's own idle behaviour. Run it
 * for a window and stop; never leave it on.
 *
 * ⚠ Long Animation Frames name the scripts, but only above 50 ms, so at 30 fps
 * they stay silent. They are collected when the browser offers them and are a
 * bonus, not the measurement.
 */

/** Below this a gap is scheduling jitter, not a block. */
const BEAT_FLOOR_MS = 0.6;

const nowMs = () => performance.now();

/**
 * Watch the main thread for `ms` and report what it was doing.
 *
 * @param {object} engine       the live engine, for the tick stamp (optional)
 * @param {object} options
 * @param {number} options.ms   window length
 */
export async function auditFrames(engine, { ms = 2000 } = {}) {
  const window_ = Math.max(200, Math.min(20000, Number(ms) || 2000));
  const blocks = [];        // contiguous busy blocks: { start, end }
  const tickStamps = [];    // performance.now() from inside the engine update
  const endStamps = [];     // ...and from onPostRender, the far end of the tick
  const hostFrames = [];    // rAF offers
  const loaf = [];

  let running = true;
  let beats = 0;
  let last = nowMs();
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const t = nowMs();
    beats++;
    if (t - last >= BEAT_FLOOR_MS) blocks.push({ start: last, end: t });
    last = nowMs();
    if (running) channel.port2.postMessage(0);
  };

  // ⭐ WHO ELSE IS ON THIS FRAME? A rAF callback that is not the engine's runs
  // in the same uninterrupted block as the engine's, so a heartbeat sees one
  // long block and the engine's own profiler sees only its share. Wrapping the
  // registration for the length of the window names every one of them — which
  // matters because the editor is a React app on the same thread as the
  // renderer, and its per-frame callbacks are invisible from inside the engine.
  const rafRows = new Map();
  const originalRaf = globalThis.requestAnimationFrame.bind(globalThis);
  const site = () => {
    const line = (new Error().stack ?? "").split(String.fromCharCode(10))[3] ?? "";
    return line.trim().replace(/^at\s+/, "").slice(-70);
  };
  globalThis.requestAnimationFrame = (callback) => {
    const label = callback.name || "(anonymous)";
    const where = site();
    return originalRaf((t) => {
      const start = nowMs();
      try { return callback(t); }
      finally {
        const key = `${label} @ ${where}`;
        const took = nowMs() - start;
        const row = rafRows.get(key) ?? { callback: label, at: where, ms: 0, calls: 0, minMs: Infinity, maxMs: 0, chainMs: [0, 0] };
        row.ms += took;
        row.calls++;
        // ⚠ A SITE IS NOT A CHAIN. three's loop closure is one source line, so
        // every renderer's callback aggregates under the same key — min against
        // max is what separates "one loop costing 2 ms" from "a throttled
        // preview rendering every other frame".
        if (took < row.minMs) row.minMs = took;
        if (took > row.maxMs) row.maxMs = took;
        // Two chains alternate in a fixed order every frame, so parity splits
        // them: `chainMs[0]` and `chainMs[1]` are the two loops' own means.
        row.chainMs[row.calls % 2] += took;
        rafRows.set(key, row);
      }
    });
  };

  let raf = 0;
  const onFrame = (t) => { hostFrames.push(t); if (running) raf = originalRaf(onFrame); };

  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        loaf.push({
          ms: +entry.duration.toFixed(1),
          blockingMs: +(entry.blockingDuration ?? 0).toFixed(1),
          renderMs: +Math.max(0, (entry.startTime + entry.duration) - (entry.renderStart || 0)).toFixed(1),
          styleAndLayoutMs: +Math.max(0, (entry.startTime + entry.duration) - (entry.styleAndLayoutStart || 0)).toFixed(1),
          scripts: (entry.scripts ?? []).slice(0, 6).map((s) => ({
            ms: +s.duration.toFixed(1),
            invoker: s.invoker,
            source: `${s.sourceURL || ""}${s.sourceFunctionName ? ` ${s.sourceFunctionName}` : ""}`.slice(-90) || undefined,
            forcedLayoutMs: s.forcedStyleAndLayoutDuration ? +s.forcedStyleAndLayoutDuration.toFixed(1) : undefined,
          })),
        });
      }
    });
    observer.observe({ type: "long-animation-frame", buffered: false });
  } catch { observer = null; }

  // ⭐ TWO STAMPS, NOT ONE. A block containing only the update stamp is "the
  // engine's", but that block also carries whatever the browser did after the
  // callback returned WITHOUT YIELDING — style, layout, paint, and the
  // editor's own React render. Those never yield to a message task, so a
  // heartbeat cannot separate them from the tick; a second stamp at the far
  // end of the engine's work can. On this editor that split is 4.2 ms of
  // engine against 3.4 ms of browser-and-DOM, and only the first half is
  // anything the engine can fix.
  const unsubscribe = engine?.onUpdate?.(() => { tickStamps.push(nowMs()); }) ?? null;
  const unsubscribeEnd = engine?.onPostRender?.(() => { endStamps.push(nowMs()); }) ?? null;

  // ⭐ three's frame callback is not only OUR tick. `Animation.start`'s closure
  // runs `info.reset()` and `nodes.nodeFrame.update()` BEFORE it calls the
  // animation loop, so that work lands in the same block and is invisible to
  // every profiler that measures from inside the loop. Time it directly.
  const nodeFrame = engine?.renderer?._nodes?.nodeFrame ?? null;
  const originalNodeUpdate = nodeFrame?.update?.bind(nodeFrame) ?? null;
  let nodeFrameMs = 0, nodeFrameCalls = 0;
  if (nodeFrame && originalNodeUpdate) {
    nodeFrame.update = (...args) => {
      const start = nowMs();
      try { return originalNodeUpdate(...args); }
      finally { nodeFrameMs += nowMs() - start; nodeFrameCalls++; }
    };
  }

  const started = nowMs();
  channel.port2.postMessage(0);
  raf = requestAnimationFrame(onFrame);
  await new Promise((resolve) => setTimeout(resolve, window_));
  running = false;
  const ended = nowMs();
  globalThis.requestAnimationFrame = originalRaf;
  if (nodeFrame && originalNodeUpdate) nodeFrame.update = originalNodeUpdate;
  cancelAnimationFrame(raf);
  channel.port1.onmessage = null;
  channel.port1.close();
  channel.port2.close();
  observer?.disconnect();
  unsubscribe?.();
  unsubscribeEnd?.();

  // ── Attribute every block ────────────────────────────────────────────────
  // A block that contains an engine update stamp IS that frame's tick. One
  // stamp per tick, and a tick never yields, so containment is exact rather
  // than a heuristic.
  let stamp = 0, endStamp = 0;
  const engineBlocks = [], otherBlocks = [];
  let beforeMs = 0, tickMs = 0, afterMs = 0;
  for (const block of blocks) {
    if (block.end < started || block.start > ended) continue;
    while (stamp < tickStamps.length && tickStamps[stamp] < block.start) stamp++;
    const ours = stamp < tickStamps.length && tickStamps[stamp] <= block.end;
    const row = { ...block, ms: block.end - block.start };
    if (!ours) { otherBlocks.push(row); continue; }
    const opened = tickStamps[stamp++];
    while (endStamp < endStamps.length && endStamps[endStamp] < opened) endStamp++;
    const closed = endStamp < endStamps.length && endStamps[endStamp] <= block.end ? endStamps[endStamp++] : null;
    beforeMs += opened - block.start;
    tickMs += (closed ?? block.end) - opened;
    afterMs += closed === null ? 0 : block.end - closed;
    engineBlocks.push(row);
  }

  const span = ended - started;
  const sum = (rows) => rows.reduce((t, b) => t + b.ms, 0);
  const engineMs = sum(engineBlocks), otherMs = sum(otherBlocks);
  const busyMs = engineMs + otherMs;
  const idleMs = Math.max(0, span - busyMs);
  const frames = Math.max(1, hostFrames.length);
  const stat = (rows, total) => ({
    blocks: rows.length,
    totalMs: +total.toFixed(1),
    pct: +(total / span * 100).toFixed(1),
    perFrameMs: +(total / frames).toFixed(2),
    meanMs: rows.length ? +(total / rows.length).toFixed(2) : 0,
    maxMs: rows.length ? +Math.max(...rows.map((b) => b.ms)).toFixed(2) : 0,
  });

  return {
    windowMs: +span.toFixed(0),
    heartbeats: beats,
    hostFrames: hostFrames.length,
    hostFps: +(hostFrames.length / span * 1000).toFixed(1),
    hostFramePeriodMs: +(span / Math.max(1, hostFrames.length)).toFixed(2),
    engineTicks: tickStamps.length,
    engineFps: +(tickStamps.length / span * 1000).toFixed(1),
    engine: stat(engineBlocks, engineMs),
    // What that block is made of. `afterTick` is the browser's own rendering
    // steps plus the editor's DOM: real main-thread time that no engine
    // profiler can see, because it happens after the tick returns and before
    // the thread yields.
    engineBlockSplit: {
      beforeTickMs: +(beforeMs / frames).toFixed(2),
      tickMs: +(tickMs / frames).toFixed(2),
      afterTickMs: +(afterMs / frames).toFixed(2),
    },
    other: stat(otherBlocks, otherMs),
    idle: { totalMs: +idleMs.toFixed(1), pct: +(idleMs / span * 100).toFixed(1), perFrameMs: +(idleMs / frames).toFixed(2) },
    nodeFrameUpdate: { perFrameMs: +(nodeFrameMs / frames).toFixed(2), calls: nodeFrameCalls },
    rafCallbacks: [...rafRows.values()]
      .filter((r) => r.callback !== "onFrame")
      .map((r) => ({ ...r, perFrameMs: +(r.ms / frames).toFixed(2), ms: +r.ms.toFixed(1),
        callsPerFrame: +(r.calls / frames).toFixed(2),
        minMs: +(r.minMs === Infinity ? 0 : r.minMs).toFixed(2), maxMs: +r.maxMs.toFixed(2),
        chainPerFrameMs: r.chainMs.map((ms) => +(ms / frames).toFixed(2)) }))
      .sort((a, b) => b.ms - a.ms).slice(0, 10),
    longestOther: otherBlocks.sort((a, b) => b.ms - a.ms).slice(0, 8).map((b) => ({ ms: +b.ms.toFixed(2) })),
    loaf: loaf.sort((a, b) => b.ms - a.ms).slice(0, 6),
    loafSupported: !!observer,
  };
}
