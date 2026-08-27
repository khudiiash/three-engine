// GI2 MOTION PROBE — §19 Stage 4.1's gate ("60-70 fps static, heavy freezes
// when the camera moves")
//
// WHY A SEPARATE PROBE, AND WHAT IT SEES THAT NOTHING ELSE DOES
//
// Every existing GI instrument reports a MEAN over a settled scene:
// `profile.frameStats` smooths fps and gpuMs with an EMA, `profile.cpuFrame`
// averages phase marks over a capture, `profile.giPasses` suspends the render
// loop entirely and times kernels K times in a row. All three are correct and
// all three are structurally blind to the subject of this stage — a BURST. A
// 70 ms frame inside a 120-frame orbit moves an EMA by about a millisecond and
// moves a mean by half of one; the user sees a hitch and the receipt says the
// scene is healthy. [[probe-blind-statistics]]: before believing a null, ask
// whether the instrument can see its subject.
//
// So this probe measures PER FRAME, and it measures the frames a moving camera
// produces:
//
//   · wall-clock frame time, from a hook on `StatsSystem.endPhaseFrame` — the
//     one call the engine makes exactly once per tick, on every early-return
//     path included;
//   · the CPU PHASE BREAKDOWN of that individual frame. `beginPhaseCapture`
//     accumulates `_phaseTotals` monotonically while armed, so arming it once
//     with a huge target and taking the DELTA at each `endPhaseFrame` turns the
//     engine's own averaging profiler into a per-frame one — no engine edit, and
//     the same marks `profile.cpuFrame` reports. Sub-phases (`gi.*`) the same
//     way, out of `_subTotals`;
//   · REAL PER-PASS GPU TIME. three's `WebGPUTimestampQueryPool` keeps a
//     `timestamps` Map from a pass's uid to its resolved duration in ms
//     (`_resolveQueries`), and `backend.get(node).timestampUID` is that uid.
//     Wrapping `renderer.compute` / `renderer.render` records the uid of every
//     pass at dispatch time; polling the Map afterwards attributes a real GPU
//     millisecond count to the exact chain that spent it. `giCompute` submits
//     GI2's whole pre-gbuffer chain as ONE array with an `id`, so the
//     voxelizer's burst arrives as a single named number rather than as a
//     component of `renderer.info`'s frame total;
//   · `PerformanceObserver('longtask')`, which sees main-thread blocks that
//     happen BETWEEN ticks and would otherwise appear only as a large `dt` with
//     every phase reading zero;
//   · the console.log COUNT per frame. A `console.log` on a page with a CDP
//     console listener attached is not free, and §19 Stage 4.1's brief names a
//     per-frame chain-shape log as a suspect. Counted in-page, so the number is
//     the engine's own behaviour and not the harness's.
//
// THE THREE ARMS (each preceded by its own PARKED segment, so "moving" is
// always compared against a still camera measured seconds earlier, on the same
// boot, in the same place):
//   a) ORBIT  — 90° around the orbit pivot over 120 frames.
//   b) DOLLY  — 20 m along the view direction over 120 frames. At ultra the L0
//      brick is 1 m and L1 is 2 m, so this crosses ~20 L0 and ~10 L1 scroll
//      boundaries: it is the arm that makes the window's slab rebuild happen
//      over and over instead of once.
//   c) WHIP   — 180° pan in 10 frames. The camera does not translate, so the
//      window never scrolls; what changes is the g-buffer and therefore every
//      screen probe. This is the arm that isolates probe re-placement from
//      voxelization.
//
// GATES (§19 Stage 4.1): MAX frame ≤ 33 ms, p95 ≤ 1.3× the arm's parked median,
// 0 frames > 50 ms, and ≤ 1 console.log per second while moving.
//
// ══ WHAT IT FOUND, SO THE NEXT READER STARTS WHERE THIS ONE STOPPED ══════════
//
//  · THE FREEZE IS `binPairs`, ON SCROLL FRAMES ONLY. The GI2 pre-gbuffer chain
//    costs 0.14 ms on a frame where the window did not scroll and 63 ms median /
//    146 ms max on a frame where it did. Per-kernel timing (`__giBatchCompute =
//    false`) names `gi2.voxelize#5` and nothing else; every other GI2 kernel is
//    under 2 ms and the raster half never exceeds 21 ms. The WHIP arm is the
//    control that proves it: a 180° pan translates the camera zero metres, so
//    the window never scrolls, its voxelize median is 0.16 ms — and it is the
//    only arm with no frame over 50 ms.
//  · ⛔ CAPPING THE DIRTY-BRICK COUNT MAKES IT WORSE. See `VOX_SWEEP` below and
//    the table in `windowVoxelize`'s `dirtyLimitU`. `binPairs` is one thread per
//    brick and costs what its slowest thread costs, so fewer bricks buys no time
//    and multiplies the frames that each pay it.
//  · ⛔ REFUTED as freeze owners, each with a number: the 30-frame `gi2.stats`
//    READBACK (median frame 25.1 ms on a readback frame vs 22.2 without), probe
//    re-placement at the whip pan (`gi2.probeTrace` mean 0.92 ms, max 2.01), and
//    the detail-volume follow slide (0.8-1.6 ms of CPU, a handful per run).
//  · THE CHAIN-SHAPE LOG WAS REAL. Frames carrying a `console.log` ran a median
//    46.0 ms against 24.6 ms for frames that carried none, and the scroll made
//    that log fire on every other frame of a walk.
//
// ⚠ THE URL IS 5202, NEVER 5201 — this worktree has a junctioned node_modules
// and a private vite cache (`vite.gi19.config.mjs`). Start the server with:
//
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//   node scripts/run-gi2-motion-probe.mjs http://127.0.0.1:5202/
//
// Env:
//   PROJECT=<path>   default C:/Users/Khudiiash/Documents/GAME
//   SCENE=<name>     default Bistro
//   ARMS=orbit,dolly,whip
//   PARK=60 MOVE=120 WHIP=10 TAIL=60   (frames per segment)
//   HEADED=1         watch it
//   JSON=<path>      dump every frame record for offline analysis
//   BOOT_TIMEOUT=300 seconds to first light
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const ARMS = (process.env.ARMS ?? "orbit,dolly,whip").split(",").map((s) => s.trim()).filter(Boolean);
const PARK = Number(process.env.PARK ?? 60);
const MOVE = Number(process.env.MOVE ?? 120);
const WHIP = Number(process.env.WHIP ?? 10);
const TAIL = Number(process.env.TAIL ?? 60);
const DOLLY_M = Number(process.env.DOLLY_M ?? 20);
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT ?? 300) * 1000;
const SETTLE = Number(process.env.SETTLE ?? 8);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_FRAME_MS = Number(process.env.MAX_FRAME_MS ?? 33);
const HARD_FRAME_MS = Number(process.env.HARD_FRAME_MS ?? 50);
const P95_RATIO = Number(process.env.P95_RATIO ?? 1.3);
const LOG_PER_S = Number(process.env.LOG_PER_S ?? 1);

// ── stats helpers (Node side; the page ships raw records) ───────────────────
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : "—");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--js-flags=--expose-gc",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((flags) => {
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, JSON.parse(process.env.FLAGS ?? "{}"));
if (process.env.SCRIPT_RELOAD === "1") {
  await page.evaluateOnNewDocument(() => { globalThis.__gi2MotionKeepScriptReload = true; });
}
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

const marks = { firstLight: 0, assetsReady: 0, lines: [] };
page.on("console", (m) => {
  const t = m.text();
  if (/scene assets ready/.test(t) && !marks.assetsReady) marks.assetsReady = Date.now();
  if (/\[gi2\] first light/.test(t) && !marks.firstLight) marks.firstLight = Date.now();
  if (/\[gi2\]|\[gi\] (built|quality|auto-fit|follow|compile wave)/.test(t)) {
    marks.lines.push(t.slice(0, 200));
    console.log(`    ${t.slice(0, 240)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`    pageerror: ${msg.slice(0, 200)}`);
});

console.log(`gi2 motion probe → ${url}  project ${PROJECT}  scene ${SCENE}`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__giEngineForProbe = mod.engine;
  globalThis.__gi2 = () => {
    const sys = mod.engine?.modules?.get?.("gi")?.system;
    return sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null;
  };
  globalThis.__giSysForProbe = () => mod.engine?.modules?.get?.("gi")?.system ?? null;
});

const call = async (op, args = {}) => {
  try {
    return await page.evaluate(async ({ op, args }) => {
      try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, { op, args });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
};

// ── open the scene and wait for first light ─────────────────────────────────
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(2); }
const openedAt = Date.now();
{
  const deadline = Date.now() + BOOT_TIMEOUT;
  while (Date.now() < deadline && !marks.firstLight) await wait(250);
}
const anchor = marks.assetsReady || openedAt;
console.log(marks.firstLight
  ? `  first light at ${marks.firstLight - anchor} ms — settling ${SETTLE}s`
  : `  ⚠ NO FIRST LIGHT in ${BOOT_TIMEOUT / 1000}s — measuring anyway (the numbers describe a boot, not a steady state)`);
await wait(SETTLE * 1000);

const settled = (await call("profile.frameStats", { settleMs: 1100 })).value ?? {};
console.log(`  settled: ${settled.fps ?? "?"} fps, cpu ${settled.cpuMs ?? "?"} ms, gpu ${settled.gpuMs ?? "?"} ms` +
  `, ${settled.drawCalls ?? "?"} draws`);

// ══════════════════════════════════════════════════════════ THE IN-PAGE RECORDER
//
// Everything below runs ONCE, inside the page, and then does its work on the
// engine's own tick — no per-frame CDP round trip, because a round trip per
// frame would itself be the stall the probe is trying to find.
const installed = await page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  if (!eng?.stats) return { ok: false, why: "no engine.stats" };
  const vh = await import("/src/editor/viewportHandle.js");
  const viewport = vh.getViewportHandle();
  if (!viewport?.camera) return { ok: false, why: "no viewport camera" };

  const R = {
    frames: [], plan: null, planAt: 0, arm: "boot", seg: "boot",
    longtasks: [], logCount: 0, pending: [], base: null, done: true,
    dispatchLabel: new Map(), pin: 0,
  };
  globalThis.__gi2Motion = R;

  // ── console counter. In-page, so it counts what the ENGINE emits. ─────────
  //
  // ⚠ AND IT KEEPS THE TEXT. A count alone makes "≤ 1 log per second" a gate
  // nobody can act on — the fix needs the OFFENDER's name, and a frame with two
  // logs in it and a 60 ms wall clock is a very different report depending on
  // whether the two lines are a GI receipt or a React warning.
  R.logTexts = new Map(); // text → count
  R.frameLogs = [];
  for (const k of ["log", "info", "warn", "error"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      R.logCount++;
      try {
        const s = String(a[0] ?? "").slice(0, 90);
        R.logTexts.set(s, (R.logTexts.get(s) ?? 0) + 1);
        R.frameLogs.push(s);
      } catch { /* an object with a throwing toString */ }
      return orig(...a);
    };
  }

  // ── GPU→CPU readbacks, which are pipeline FLUSHES ─────────────────────────
  //
  // `getArrayBufferAsync` copies a storage buffer and awaits `mapAsync`, so the
  // queue has to drain to the pass that wrote it. Counted per frame because
  // GI2's receipt (`gi2.stats`) does three of them on a fixed 30-frame cadence
  // and nothing else in the tick shows a cost when it does.
  if (eng.renderer && !eng.renderer.__gi2MotionReadbackWrapped) {
    eng.renderer.__gi2MotionReadbackWrapped = true;
    const rawRB = eng.renderer.getArrayBufferAsync.bind(eng.renderer);
    eng.renderer.getArrayBufferAsync = function (attr) { R.readbacks++; return rawRB(attr); };
  }
  R.readbacks = 0;

  // ── long tasks (main-thread blocks between ticks) ─────────────────────────
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) R.longtasks.push({ t: e.startTime, ms: e.duration });
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* not every build ships longtask */ }

  // ── per-pass GPU timestamps ───────────────────────────────────────────────
  //
  // `backend.get(ctx).timestampUID` is the key three files the resolved
  // duration under. ⚠ `backend.getTimestamp(uid)` picks its pool by the uid's
  // PREFIX, and `giCompute`'s batched ARRAY has no `isComputeNode`, so its uid
  // starts with `r:` while its timestamp lives in the COMPUTE pool — reading
  // through the accessor would look in the wrong pool and warn. Both pools are
  // consulted directly instead.
  //
  // ⚠ THE ENGINE READS THE SAME MAP AND CONSUMES ITS ENTRY. `gi2System`'s own
  // receipt drains the pre-gbuffer chain's uid inside `passes()`, which runs
  // EARLIER in the tick than this hook, so that one chain will not appear in
  // `gpu` here — its number arrives as the per-frame `voxMs` field instead,
  // which is the same measurement rather than a second one that could disagree.
  const renderer = eng.renderer;
  const backend = renderer?.backend;
  const poolOf = (kind) => backend?.timestampQueryPool?.[kind] ?? null;
  const labelOf = (nodes) => {
    const list = Array.isArray(nodes) ? nodes : [nodes];
    for (const n of list) {
      const nm = n?.__giPassName;
      if (typeof nm === "string") {
        // `gi2.voxelize#3` → `gi2.voxelize`: a chain, not an index.
        const fam = nm.split("#")[0];
        if (list.length > 1) return `${fam}+${list.length}`;
        return nm;
      }
    }
    return list.length > 1 ? `compute[${list.length}]` : "compute";
  };
  if (renderer && backend && !renderer.__gi2MotionWrapped) {
    renderer.__gi2MotionWrapped = true;
    const rawCompute = renderer.compute.bind(renderer);
    renderer.compute = function (nodes, dispatch) {
      const out = rawCompute(nodes, dispatch);
      try {
        const uid = backend.get(nodes)?.timestampUID;
        if (uid) R.pending.push({ uid, kind: "compute", label: labelOf(nodes), frame: R.frames.length });
      } catch { /* a context three did not track */ }
      return out;
    };
    const rawRender = renderer.render.bind(renderer);
    renderer.render = function (scene, camera) {
      const out = rawRender(scene, camera);
      try {
        const ctx = backend.get(renderer._renderContext ?? {});
        if (ctx?.timestampUID) {
          R.pending.push({ uid: ctx.timestampUID, kind: "render", label: "render", frame: R.frames.length });
        }
      } catch { /* ditto */ }
      return out;
    };
  }
  /** Drain whatever the last resolve landed. Returns {label: ms} for OLD frames. */
  const drainGpu = () => {
    const cPool = poolOf("compute");
    const rPool = poolOf("render");
    if (!cPool && !rPool) return;
    const keep = [];
    for (const p of R.pending) {
      const pool = p.kind === "compute" ? cPool : rPool;
      const other = p.kind === "compute" ? rPool : cPool;
      let ms;
      if (pool?.timestamps?.has(p.uid)) ms = pool.timestamps.get(p.uid);
      else if (other?.timestamps?.has(p.uid)) ms = other.timestamps.get(p.uid);
      if (ms === undefined) {
        // Give a uid ~4 s of frames to resolve, then drop it: a pass whose
        // queries were evicted never lands and would otherwise leak.
        if (R.frames.length - p.frame < 240) keep.push(p);
        continue;
      }
      pool?.timestamps?.delete(p.uid);
      other?.timestamps?.delete(p.uid);
      const rec = R.frames[p.frame];
      if (rec) rec.gpu[p.label] = +((rec.gpu[p.label] ?? 0) + ms).toFixed(3);
    }
    R.pending = keep;
    // Whatever is LEFT in the render pool is the frame's raster work, which no
    // wrapper here claimed (three opens those contexts internally). Summed
    // rather than named: the question this probe asks of the raster half is
    // only "did it get more expensive while moving".
    if (rPool?.timestamps?.size) {
      let sum = 0;
      for (const [uid, ms] of rPool.timestamps) { sum += ms; rPool.timestamps.delete(uid); }
      const rec = R.frames[R.frames.length - 1];
      if (rec) rec.gpu.render = +((rec.gpu.render ?? 0) + sum).toFixed(3);
    }
  };

  // ── the per-frame hook ────────────────────────────────────────────────────
  const stats = eng.stats;
  const PHASES = (() => {
    // `readPhaseCapture` maps PHASES by index; the names are recovered from a
    // zero-frame read rather than re-declared here (a second name table is a
    // second thing to get out of date).
    const snap = stats.readPhaseCapture?.();
    return (snap?.phases ?? []).map((p) => p.name);
  })();
  // The index order of `_phaseTotals` is the PHASES table's, which
  // `readPhaseCapture` SORTS before returning — so the sorted list above is not
  // an index map. Read the raw array and label by a fresh unsorted read.
  const phaseNames = [];
  {
    // Arm briefly, mark nothing, and read: `readPhaseCapture` builds its list
    // with `PHASES.map` BEFORE sorting, and `pct` is 0 for all when totals are
    // zero, so a stable sort leaves the table in declaration order.
    stats.beginPhaseCapture(1);
    const snap = stats.readPhaseCapture();
    for (const p of snap.phases) phaseNames.push(p.name);
  }
  const totals = stats._phaseTotals;
  const NP = totals?.length ?? 0;
  const prevPhase = new Float64Array(NP);
  const prevSub = new Map();
  let prevLogs = 0;
  let prevReadbacks = 0;
  let lastNow = performance.now();

  const rawEnd = stats.endPhaseFrame.bind(stats);
  stats.endPhaseFrame = function () {
    rawEnd();
    // Re-arm before the counter can disarm us: `beginPhaseCapture` zeroes the
    // totals, which would make every delta wrong, so instead the target is
    // pushed out of reach and the frame counter is simply ignored.
    if (stats._phaseFramesTarget < 1e8) stats._phaseFramesTarget = 1e9;
    stats._phaseArmed = true;

    const now = performance.now();
    const dt = now - lastNow;
    lastNow = now;

    const phases = {};
    for (let i = 0; i < NP; i++) {
      const d = totals[i] - prevPhase[i];
      prevPhase[i] = totals[i];
      if (d > 0.05) phases[phaseNames[i] ?? `#${i}`] = +d.toFixed(3);
    }
    const subs = {};
    const sm = stats._subTotals;
    if (sm) {
      for (const [k, v] of sm) {
        const d = v - (prevSub.get(k) ?? 0);
        prevSub.set(k, v);
        if (d > 0.05) subs[k] = +d.toFixed(3);
      }
    }
    const logs = R.logCount - prevLogs;
    prevLogs = R.logCount;
    const logLines = R.frameLogs.slice(0, 4);
    R.frameLogs.length = 0;
    const readbacks = R.readbacks - prevReadbacks;
    prevReadbacks = R.readbacks;

    const gi2 = globalThis.__gi2?.();
    // ⭐ THE IN-BOOT SWEEP. Cross-RUN maxima on this machine are not
    // comparable: the GPU is shared with other harnesses, and a 146 ms pass in
    // one run against 101 ms in the next says as much about the neighbour as
    // about the change. Pinning the limit and re-running the SAME arm inside
    // ONE boot puts every arm under the same contention, which is the only way
    // to ask "does the dirty limit move this pass's cost at all".
    if (R.pin > 0 && gi2?.voxelizer) gi2.voxelizer.setDirtyLimit(R.pin);
    const snap = gi2?.snapshot ? gi2.snapshot() : null;
    const vx = snap?.voxelizer ?? null;
    const rec = {
      i: R.frames.length, t: +now.toFixed(2), dt: +dt.toFixed(3),
      arm: R.arm, seg: R.seg, logs, logLines, readbacks, phases, subs, gpu: {},
      scrolls: snap?.scrolls ?? 0, movers: snap?.movers ?? 0,
      // Voxelizer counters come from the LAST readback (`statsCadence`), so
      // they lag; they are here to say "a slab was in flight around now", not
      // to time it. `dirty`/`built`/`pairsWritten` are the ones that move.
      vxDirty: vx?.dirty ?? 0, vxBuilt: vx?.built ?? 0,
      vxPairs: vx?.pairsWritten ?? 0, vxDeferred: vx?.deferred ?? 0,
      vxResumed: vx?.resumed ?? 0,
      probes: snap?.gather?.probesValid ?? 0,
      // §19 Stage 4.1's own receipt. The engine consumes the pre-gbuffer
      // chain's GPU timestamp for its budget controller and publishes the
      // number here, so this is the SAME measurement the controller acted on —
      // not a second one that could disagree with it.
      voxMs: snap?.voxMs ?? 0,
      // Read off the voxelizer, not the snapshot: the engine does not drive the
      // dirty limit (it was measured and refuted as a budget — see
      // `windowVoxelize`'s `dirtyLimitU`), so the only writer is `VOX_SWEEP`'s
      // pin, and the sweep table has to be able to show what it pinned.
      voxLimit: gi2?.voxelizer?.dirtyLimit ?? 0,
    };
    R.frames.push(rec);
    drainGpu();

    // ── drive the camera ───────────────────────────────────────────────────
    const plan = R.plan;
    if (plan) {
      const k = R.planAt++;
      const step = plan.steps[k];
      if (step) {
        // The NEXT frame is the one that pays for this pose, so only `R.seg`
        // moves — overwriting `rec.seg` here would label the frame that merely
        // set the camera as the frame that rendered from it.
        R.seg = step.seg;
        const cam = viewport.camera;
        cam.position.set(step.p[0], step.p[1], step.p[2]);
        if (viewport.orbit) {
          viewport.orbit.target.set(step.t[0], step.t[1], step.t[2]);
          viewport.orbit.update();
        } else cam.lookAt(step.t[0], step.t[1], step.t[2]);
      }
      if (R.planAt >= plan.steps.length) { R.plan = null; R.done = true; }
    }
  };

  // ⚠ A HARNESS ARTIFACT THAT WOULD OWN EVERY GATE, REMOVED RATHER THAN
  // MEASURED AROUND. `ScriptComponent` re-imports each script on a wall-clock
  // hot-reload poll; under the tauri shim that import throws, so the Bistro
  // scene's two character scripts print a `console.error` pair every few
  // seconds and the frame carrying them ran 40-160 ms. Both files exist on
  // disk and load in the real editor, so this is the harness failing, not the
  // engine — and leaving it in would put a 160 ms frame in a table about
  // camera motion. `SCRIPT_RELOAD=1` puts it back.
  if (!globalThis.__gi2MotionKeepScriptReload) {
    eng.config ??= {};
    eng.config.scriptHotReload = false;
  }
  stats.beginPhaseCapture(1e9);
  const cam = viewport.camera;
  const tgt = viewport.orbit?.target ?? { x: 0, y: 0, z: 0 };
  R.base = { p: [cam.position.x, cam.position.y, cam.position.z], t: [tgt.x, tgt.y, tgt.z] };
  return {
    ok: true, phases: phaseNames.length, base: R.base,
    sameCamera: eng.camera === viewport.camera,
  };
});
if (!installed.ok) {
  console.log(`FATAL recorder: ${installed.why}`);
  await browser.close();
  process.exit(2);
}
console.log(`  recorder armed — ${installed.phases} phases, camera ${installed.sameCamera ? "shared with engine" : "⚠ NOT engine.camera"}`);
console.log(`  base pose ${installed.base.p.map((n) => n.toFixed(1)).join(",")} → ${installed.base.t.map((n) => n.toFixed(1)).join(",")}`);

// ══════════════════════════════════════════════════════════════════ THE ARMS
//
// Each arm is a list of poses computed up front, in the page, from the pose the
// scene opened at. One `evaluate` starts it; the probe then polls a boolean.
// A pose per FRAME (not per wall-clock millisecond) is deliberate: a hitching
// frame must not be compensated for by a bigger camera step, or the arm would
// silently reduce its own load exactly where the load is the question.
const runArm = async (arm, label = arm, pin = 0) => {
  console.log(`\n── ${label} ──────────────────────────────────────────────`);
  const ok = await page.evaluate(({ arm, label, pin, PARK, MOVE, WHIP, TAIL, DOLLY_M }) => {
    const R = globalThis.__gi2Motion;
    R.pin = pin;
    const B = R.base;
    const steps = [];
    const push = (seg, p, t) => steps.push({ seg, p, t });
    const rotY = (v, o, a) => {
      const c = Math.cos(a), s = Math.sin(a);
      const x = v[0] - o[0], z = v[2] - o[2];
      return [o[0] + x * c - z * s, v[1], o[2] + x * s + z * c];
    };
    for (let i = 0; i < PARK; i++) push("parked", B.p, B.t);
    if (arm === "orbit") {
      for (let i = 0; i < MOVE; i++) {
        const a = (Math.PI / 2) * ((i + 1) / MOVE);
        push("moving", rotY(B.p, B.t, a), B.t);
      }
    } else if (arm === "dolly") {
      const d = [B.t[0] - B.p[0], B.t[1] - B.p[1], B.t[2] - B.p[2]];
      const len = Math.hypot(d[0], d[1], d[2]) || 1;
      const u = [d[0] / len, d[1] / len, d[2] / len];
      for (let i = 0; i < MOVE; i++) {
        const k = DOLLY_M * ((i + 1) / MOVE);
        push("moving",
          [B.p[0] + u[0] * k, B.p[1] + u[1] * k, B.p[2] + u[2] * k],
          [B.t[0] + u[0] * k, B.t[1] + u[1] * k, B.t[2] + u[2] * k]);
      }
    } else if (arm === "whip") {
      for (let i = 0; i < WHIP; i++) {
        const a = Math.PI * ((i + 1) / WHIP);
        push("moving", B.p, rotY(B.t, B.p, a));
      }
    }
    const last = steps[steps.length - 1];
    for (let i = 0; i < TAIL; i++) push("tail", last.p, last.t);
    R.arm = label;
    R.seg = "parked";
    R.planAt = 0;
    R.plan = { steps };
    R.done = false;
    return steps.length;
  }, { arm, label, pin, PARK, MOVE, WHIP, TAIL, DOLLY_M });
  // Poll rather than sleep: a stalled arm must be reported as stalled, not
  // measured over a window it never filled.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => globalThis.__gi2Motion.done)) break;
    await wait(200);
  }
  // Return to the base pose and let the window rebuild before the next arm, so
  // one arm's slab does not land in the next arm's parked segment.
  await page.evaluate(() => {
    const R = globalThis.__gi2Motion;
    R.arm = "recover"; R.seg = "recover";
    R.plan = { steps: Array.from({ length: 90 }, () => ({ seg: "recover", p: R.base.p, t: R.base.t })) };
    R.planAt = 0; R.done = false;
  });
  {
    const d2 = Date.now() + 40_000;
    while (Date.now() < d2) {
      if (await page.evaluate(() => globalThis.__gi2Motion.done)) break;
      await wait(200);
    }
  }
  return ok;
};

// VOX_SWEEP="24,96,384,1536,20480" — the same arm, N times, each with the
// voxelizer's dirty limit pinned. Reported per pinned value so "does the limit
// move the pass" is answerable from one boot under one machine's contention.
const SWEEP = (process.env.VOX_SWEEP ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
const armList = [];
if (SWEEP.length) {
  for (const arm of ARMS) for (const v of SWEEP) armList.push([arm, `${arm}@${v}`, v]);
} else {
  for (const arm of ARMS) armList.push([arm, arm, 0]);
}
for (const [arm, label, pin] of armList) await runArm(arm, label, pin);

// ══════════════════════════════════════════════════════════════════ THE REPORT
const data = await page.evaluate(() => {
  const R = globalThis.__gi2Motion;
  return {
    frames: R.frames, longtasks: R.longtasks, logCount: R.logCount,
    logTexts: [...R.logTexts].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
});
if (process.env.JSON) {
  fs.writeFileSync(process.env.JSON, JSON.stringify(data));
  console.log(`\n  frame records → ${process.env.JSON}`);
}

const gi2Final = (await call("profile.gi2")).value ?? null;
const describe = await page.evaluate(() => {
  const g = globalThis.__gi2?.();
  return g?.describe ? { vox: g.describe().voxelizer, win: g.describe().window } : null;
});

const ownerOf = (f) => {
  const cand = [
    ...Object.entries(f.subs).map(([k, v]) => [`sub:${k}`, v]),
    ...Object.entries(f.phases).map(([k, v]) => [`cpu:${k}`, v]),
    ...Object.entries(f.gpu).map(([k, v]) => [`gpu:${k}`, v]),
  ].sort((a, b) => b[1] - a[1]);
  const cpuSum = Object.values(f.phases).reduce((a, b) => a + b, 0);
  const top = cand[0];
  if (!top) return `unattributed (${f2(f.dt)} ms with no marked work — a block BETWEEN ticks)`;
  // A frame whose marked CPU is far below its wall time was blocked outside the
  // tick (GPU backpressure, a long task, a GC). Saying "the top phase owns it"
  // there would be arithmetic, not evidence.
  if (cpuSum < f.dt * 0.5) {
    const g = Object.entries(f.gpu).sort((a, b) => b[1] - a[1])[0];
    return g && g[1] > f.dt * 0.4
      ? `gpu:${g[0]} ${f2(g[1])} ms (cpu marked only ${f2(cpuSum)} of ${f2(f.dt)})`
      : `outside the tick — cpu marked ${f2(cpuSum)} of ${f2(f.dt)} ms${top ? `, largest mark ${top[0]} ${f2(top[1])}` : ""}`;
  }
  return `${top[0]} ${f2(top[1])} ms`;
};

const rows = [];
console.log("\n══ PER-ARM ═══════════════════════════════════════════════════════");
console.log("arm     seg      n   median    p95     max   >33ms  >50ms  logs/s");
for (const [, arm] of armList) {
  const of = (seg) => data.frames.filter((f) => f.arm === arm && f.seg === seg);
  const parked = of("parked").slice(5).map((f) => f.dt);
  const moving = of("moving").map((f) => f.dt);
  const tail = of("tail").map((f) => f.dt);
  const pm = median(parked);
  for (const [seg, xs, recs] of [["parked", parked, of("parked").slice(5)], ["moving", moving, of("moving")], ["tail", tail, of("tail")]]) {
    if (!xs.length) continue;
    const span = recs.reduce((a, f) => a + f.dt, 0) / 1000;
    const logs = recs.reduce((a, f) => a + f.logs, 0);
    console.log(
      `${arm.padEnd(7)} ${seg.padEnd(7)} ${String(xs.length).padStart(3)} ` +
      `${f2(median(xs)).padStart(7)} ${f2(pct(xs, 95)).padStart(7)} ${f2(Math.max(...xs)).padStart(7)} ` +
      `${String(xs.filter((v) => v > MAX_FRAME_MS).length).padStart(6)} ` +
      `${String(xs.filter((v) => v > HARD_FRAME_MS).length).padStart(6)} ` +
      `${(logs / Math.max(0.001, span)).toFixed(2).padStart(7)}`);
  }
  const all = [...moving, ...tail];
  const movingRecs = [...of("moving"), ...of("tail")];
  const span = movingRecs.reduce((a, f) => a + f.dt, 0) / 1000;
  const logs = movingRecs.reduce((a, f) => a + f.logs, 0);
  rows.push({
    arm, parkedMedian: pm, movingMedian: median(moving), p95: pct(all, 95),
    max: all.length ? Math.max(...all) : 0,
    over33: all.filter((v) => v > MAX_FRAME_MS).length,
    over50: all.filter((v) => v > HARD_FRAME_MS).length,
    logsPerS: logs / Math.max(0.001, span),
  });
  // WHO OWNS THE HEAVY FRAMES. Top 6 by wall time, each named.
  const heavy = movingRecs.filter((f) => f.dt > MAX_FRAME_MS).sort((a, b) => b.dt - a.dt).slice(0, 6);
  if (heavy.length) {
    console.log(`        heaviest ${arm} frames:`);
    for (const f of heavy) {
      console.log(`          #${f.i} ${f2(f.dt)} ms — ${ownerOf(f)}` +
        (f.vxDirty || f.vxPairs ? `  [vox dirty ${f.vxDirty} pairs ${f.vxPairs} deferred ${f.vxDeferred}]` : ""));
    }
  } else {
    console.log(`        no ${arm} frame over ${MAX_FRAME_MS} ms`);
  }
}

// ── where the moving time goes overall ──────────────────────────────────────
const movingAll = data.frames.filter((f) => f.seg === "moving" || f.seg === "tail");
const agg = (key) => {
  const m = new Map();
  for (const f of movingAll) for (const [k, v] of Object.entries(f[key])) m.set(k, (m.get(k) ?? 0) + v);
  return [...m].map(([k, v]) => [k, v / Math.max(1, movingAll.length)]).sort((a, b) => b[1] - a[1]);
};
console.log("\n══ MOVING-FRAME MEANS (ms/frame) ═════════════════════════════════");
console.log("  cpu phases : " + agg("phases").slice(0, 6).map(([k, v]) => `${k} ${f2(v)}`).join("  "));
console.log("  gi subs    : " + agg("subs").slice(0, 6).map(([k, v]) => `${k} ${f2(v)}`).join("  "));
console.log("  gpu passes : " + agg("gpu").slice(0, 8).map(([k, v]) => `${k} ${f2(v)}`).join("  "));
{
  const gpuMax = new Map();
  for (const f of movingAll) for (const [k, v] of Object.entries(f.gpu)) gpuMax.set(k, Math.max(gpuMax.get(k) ?? 0, v));
  console.log("  gpu MAX    : " + [...gpuMax].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${f2(v)}`).join("  "));
}
console.log("\n══ WHO LOGS ══════════════════════════════════════════════════════");
{
  // Rebuilt from the PER-FRAME lines rather than from the page's own tally:
  // one source of truth for both the count and the attribution, so a line that
  // shows up in a heavy frame's record cannot be missing from this table.
  const m = new Map();
  for (const f of data.frames) for (const l of f.logLines ?? []) m.set(l, (m.get(l) ?? 0) + 1);
  for (const [t, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(5)} × ${t}`);
  }
  if (!m.size) console.log("  (none)");
}
console.log("\n══ VOXELIZE CHAIN GPU MS, PER ARM (the engine's own sample) ══════");
console.log("arm            n   median    p95     max   dirtyLimit");
for (const [, arm] of armList) {
  const recs = data.frames.filter((f) => f.arm === arm && (f.seg === "moving" || f.seg === "tail"));
  const vm = recs.map((f) => f.voxMs).filter((v) => v > 0);
  if (!vm.length) { console.log(`${arm.padEnd(13)} — no sample (the chain never batched, or no timestamp queries)`); continue; }
  const lim = recs.map((f) => f.voxLimit).filter((v) => v > 0);
  console.log(`${arm.padEnd(13)} ${String(vm.length).padStart(3)} ${f2(median(vm)).padStart(7)} ` +
    `${f2(pct(vm, 95)).padStart(7)} ${f2(Math.max(...vm)).padStart(7)}   ` +
    (lim.length ? `${Math.min(...lim)}–${Math.max(...lim)}` : "—"));
}
console.log("");
{
  const rb = movingAll.reduce((a, f) => a + f.readbacks, 0);
  const rbFrames = movingAll.filter((f) => f.readbacks > 0);
  const dtRb = median(rbFrames.map((f) => f.dt));
  const dtNo = median(movingAll.filter((f) => f.readbacks === 0).map((f) => f.dt));
  console.log(`  readbacks: ${rb} over ${movingAll.length} moving frames ` +
    `(${rbFrames.length} frames) — median dt ${f2(dtRb)} ms on a readback frame vs ${f2(dtNo)} ms without`);
}
const lt = data.longtasks.filter((e) => e.ms > 20);
console.log(`  longtasks  : ${data.longtasks.length} total, ${lt.length} over 20 ms` +
  (lt.length ? `, max ${f2(Math.max(...lt.map((e) => e.ms)))} ms` : ""));
if (describe?.vox) {
  console.log(`  voxelizer  : tier ${describe.vox.tier}, pairsPerFrame ${describe.vox.pairsPerFrame}, maxBuild ${describe.vox.maxBuild}` +
    (gi2Final?.voxelizer ? `, live dirty ${gi2Final.voxelizer.dirty} built ${gi2Final.voxelizer.built} pairsWritten ${gi2Final.voxelizer.pairsWritten} deferred ${gi2Final.voxelizer.deferred}` : ""));
}
if (gi2Final) console.log(`  scrolls this run: ${gi2Final.scrolls ?? "?"}   probes ${gi2Final.probes ?? "?"}`);

// ══════════════════════════════════════════════════════════════════════ GATES
console.log("\n══ GATES ═════════════════════════════════════════════════════════");
let failed = 0;
const gate = (name, measured, limit, ok) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(40)} ${String(measured).padStart(10)}  (limit ${limit})`);
};
for (const r of rows) {
  gate(`${r.arm}: MAX frame ms`, f2(r.max), `≤ ${MAX_FRAME_MS}`, r.max <= MAX_FRAME_MS);
  gate(`${r.arm}: p95 vs parked median`, `${f2(r.p95)}/${f2(r.parkedMedian)}`, `≤ ${P95_RATIO}x`,
    r.parkedMedian > 0 && r.p95 <= r.parkedMedian * P95_RATIO);
  gate(`${r.arm}: frames > ${HARD_FRAME_MS} ms`, r.over50, "0", r.over50 === 0);
  gate(`${r.arm}: console.log per second`, f2(r.logsPerS), `≤ ${LOG_PER_S}`, r.logsPerS <= LOG_PER_S);
}
console.log(`\n${failed === 0 ? "ALL GATES PASS" : `${failed} GATE(S) FAILED`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
