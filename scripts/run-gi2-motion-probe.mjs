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
// §19 Stage 4.1b's own gate: the voxelize chain's GPU cost on EVERY moving
// frame, not on average. The restructure's whole claim is that this number now
// has a ceiling — one thread walks ≤ TRIS_PER_ITEM triangles, and the frame
// walks ≤ cellLimit of them — so a MEAN would be the wrong statistic to gate
// on twice over. [[probe-blind-statistics]]
const VOX_MS = Number(process.env.VOX_MS ?? 3);

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
// ⚠ §19 3.12: `__gi2NoiseDump` HAS TO BE SET BEFORE THE GATHER IS BUILT, which
// is before first light — `createGiGather` reads it once, to decide whether to
// allocate the receipt buffers and build `reprojDump` at all (`gi2System` passes
// `crops: 0`, so nothing else on the engine path turns them on). Setting it
// after boot would leave the grain segment below reading a kernel that does not
// exist, which it reports rather than scoring as zero. `GRAIN=0` opts out and
// gets a gather with exactly the 3.11 memory footprint.
await page.evaluateOnNewDocument((flags) => {
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, {
  ...(process.env.GRAIN === "0" ? {} : { __gi2NoiseDump: true }),
  ...(process.env.CLASSIFY === "1" ? { __gi2Classify: true } : {}),
  ...(process.env.EPS_K ? { __gi2EpsK: Number(process.env.EPS_K) } : {}),
  ...(process.env.EXACT_EPS ? { __gi2ExactEps: Number(process.env.EXACT_EPS) } : {}),
  ...JSON.parse(process.env.FLAGS ?? "{}"),
});
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
// ⭐⭐ §19 STAGE 4.3b — FIRST LIGHT IS NO LONGER THE END OF THE LOAD.
//
// This probe took "boot done" to be first light + SETTLE, which was true while
// `#readyToRebuild` held GI until every texture and the merge had landed: GI
// was the LAST thing to appear. §R.1 makes GI build on geometry-ready, so
// first light now arrives ~10 s BEFORE the KTX2 tail finishes — and the arms
// were starting on a scene still decoding textures, still merging and still
// minting materials. Three runs showed it the same way: ~50 pipelines created
// "after boot" at a steady one per seven frames, 3.4 console logs per second,
// and an orbit MAX of 578 ms with nothing camera-shaped about it.
// ⭐ WHEN A CHANGE MOVES THE EVENT A PROBE ANCHORS ON, THE PROBE IS MEASURING A
// DIFFERENT SUBJECT — that is not a regression, and reading it as one costs a
// session.
//
// So the arms wait for QUIESCENCE, on the same two predicates
// `#readyToRebuild` reads. Bounded, and it says so when the bound is hit.
{
  const quietBy = Date.now() + Number(process.env.QUIESCE_MS ?? 90000);
  const armed = await page.evaluate(async () => {
    const m = await import("/src/engine/textureAsset.js");
    globalThis.__texInFlight = () => m.textureLoadsInFlight?.() ?? 0;
    return true;
  }).catch(() => false);
  let last = null;
  while (Date.now() < quietBy) {
    last = await page.evaluate(() => ({
      tex: globalThis.__texInFlight?.() ?? 0,
      merging: !!globalThis.__giEngineForProbe?.merging?.settling,
    })).catch(() => null);
    if (last && !last.tex && !last.merging) break;
    await wait(500);
  }
  console.log(`  asset quiescence: ${armed ? "" : "(texture probe unavailable) "}` +
    `${last ? `${last.tex} textures in flight, merging settling=${last.merging}` : "unknown"}` +
    `${last && (last.tex || last.merging) ? " — ⚠ BOUND HIT, the arms run on a still-loading scene" : " — clear"}`);
}
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
    // §19 3.18 — `CLASSIFY=1`. Off by default: the class census reads a second
    // buffer three times the size of `reprojBuf` every grain frame, which is a
    // pipeline flush the flip RATE itself does not need.
    classify: globalThis.__gi2Classify === true,
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
  // ⚠⚠ AND THE OBSERVER SAYS WHETHER IT CAN SEE ITS SUBJECT. "0 long tasks in a
  // run containing a 186 ms frame" is either a finding or a broken instrument,
  // and a `try/catch` that swallows an unsupported entry type makes the two
  // indistinguishable — the exact blind-statistic trap this repo keeps
  // relearning. `supportedEntryTypes` is reported alongside the count.
  R.obsTypes = (globalThis.PerformanceObserver?.supportedEntryTypes ?? []).slice();
  R.obsArmed = [];
  for (const type of ["longtask", "long-animation-frame"]) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const rec = { t: e.startTime, ms: e.duration, type };
          // ⭐ LoAF IS THE ONE THAT ANSWERS THIS STAGE'S QUESTION. A long task
          // says "the main thread was busy"; a long ANIMATION FRAME breaks the
          // same wall clock into the scripts that ran (with the function and
          // the URL that invoked each), the render phase, and — by
          // subtraction — the part that was NOT the page at all.
          if (type === "long-animation-frame") {
            rec.blocking = e.blockingDuration;
            rec.renderStart = e.renderStart - e.startTime;
            rec.styleLayout = e.styleAndLayoutStart ? e.styleAndLayoutStart - e.startTime : 0;
            rec.scripts = (e.scripts ?? []).map((sc) => ({
              ms: sc.duration, name: sc.sourceFunctionName || sc.name,
              url: (sc.sourceURL || "").split("?")[0].replace(/^https?:\/\/[^/]+/, ""),
              invoker: sc.invoker, invokerType: sc.invokerType,
              forced: sc.forcedStyleAndLayoutDuration, pause: sc.pauseDuration,
            })).sort((a, b) => b.ms - a.ms).slice(0, 4);
          }
          R.longtasks.push(rec);
        }
      }).observe({ type, buffered: true });
      R.obsArmed.push(type);
    } catch { /* this Chrome does not ship it */ }
  }

  // ══ §19 STAGE 3.10 ITEM 5 — WHO OWNS A BLOCK THAT IS *NOT* IN THE TICK ════
  //
  // 4.1b left two ~115-136 ms frames at fixed orbit indices with `voxMs` idle,
  // no scroll, no readback, no log, and only ~21 ms of the 136 marked by the
  // tick's own phases. "Outside the tick" is a very short list of things on a
  // single-threaded page: a TIMER callback, an IDLE callback, a WORKER message,
  // a promise continuation, or the garbage collector. Each of the first three
  // is wrappable at its registration point, which turns "something blocked"
  // into a NAME and a duration; GC is not, so it is inferred from a heap
  // measurement per frame instead (a `usedJSHeapSize` that DROPS across a slow
  // frame is a collection, and one that leaps is the allocation that caused it).
  //
  // ⚠ THE LABEL IS THE CALLBACK'S OWN SOURCE, NOT ITS REGISTRATION STACK.
  // Capturing `new Error().stack` at every `setTimeout` would cost more than
  // the thing it measures — the engine registers hundreds a second — while the
  // function's `name`, or its first 70 characters when it is anonymous, is
  // free and has been enough to name every owner this repo has hunted.
  R.cb = new Map();
  R.cbEvents = [];
  const noteCb = (kind, fn) => {
    if (typeof fn !== "function") return fn;
    let label;
    try { label = `${kind}:${fn.name || String(fn).replace(/\s+/g, " ").slice(0, 70)}`; }
    catch { label = `${kind}:<unprintable>`; }
    return function wrapped(...a) {
      const t0 = performance.now();
      try { return fn.apply(this, a); } finally {
        const d = performance.now() - t0;
        const e = R.cb.get(label) ?? { n: 0, ms: 0, max: 0 };
        e.n++; e.ms += d; if (d > e.max) e.max = d;
        R.cb.set(label, e);
        if (d > 8) R.cbEvents.push({ t: t0, ms: d, label });
      }
    };
  };
  for (const k of ["setTimeout", "setInterval", "requestIdleCallback"]) {
    const orig = globalThis[k];
    if (typeof orig !== "function") continue;
    globalThis[k] = function (fn, ...rest) { return orig.call(this, noteCb(k, fn), ...rest); };
  }
  {
    const origThen = Promise.prototype.then;
    // ⚠ ONLY THE REJECTION-FREE FAST PATH IS WRAPPED AND ONLY THE *FULFILLED*
    // HANDLER. A promise continuation is the one "outside the tick" class that
    // is genuinely hot (every `await` in the engine goes through it), so the
    // wrapper has to be a closure and nothing else — no stack, no allocation
    // beyond the one closure `then` was already going to allocate.
    Promise.prototype.then = function (onOk, onErr) {
      return origThen.call(this, typeof onOk === "function" ? noteCb("then", onOk) : onOk, onErr);
    };
  }
  {
    const addEL = Worker.prototype.addEventListener;
    Worker.prototype.addEventListener = function (type, fn, ...rest) {
      return addEL.call(this, type, type === "message" ? noteCb("worker", fn) : fn, ...rest);
    };
    const d = Object.getOwnPropertyDescriptor(Worker.prototype, "onmessage");
    if (d?.set) {
      Object.defineProperty(Worker.prototype, "onmessage", {
        ...d, set(fn) { d.set.call(this, noteCb("worker.onmessage", fn)); },
      });
    }
  }

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
    // ⭐⭐ §19 STAGE 3.10 ITEM 5 — COUNT THE RENDERS, AND NAME THE CALLER OF A
    // SLOW ONE. The sampling profile put the 4.1b spikes inside
    // `renderer.render → _renderScene → updateMatrixWorld / _projectObject`,
    // which is ORDINARY scene rendering — so the question is not what the
    // frame did, it is HOW MANY TIMES it did it and who asked. A count per
    // frame answers the first; `new Error().stack` on the calls that actually
    // run long answers the second, and costs nothing on the calls that do not.
    R.renderN = 0;
    R.renderMs = 0;
    R.renderStacks = [];
    // ⭐⭐⭐ THE DEVICE ITSELF. The 4.1b spikes have ZERO long tasks, 17 ms of
    // CPU inside `renderer.render` out of a 165 ms frame, and a sampling
    // profiler that only manages a third of the samples the window should hold
    // — i.e. the main thread is NOT RUNNING JAVASCRIPT for ~130 ms. On a page
    // whose only other engine is the GPU, the short list of things that block
    // a thread that is not running is: a pipeline the driver is compiling, a
    // shader module it is translating, and a queue too deep to accept another
    // frame. All three are WebGPU device calls, so all three are wrappable at
    // the device, which turns "the frame stalled" into a count and a cost.
    R.api = new Map();
    R.frameApi = {};
    // ⭐⭐ THE SWAP CHAIN. LoAF puts the spike between the end of the rAF
    // script and the START of the browser's render phase, with zero blocking
    // time — the page was not busy, the browser was refusing to begin the
    // frame. On a WebGPU canvas the thing that makes it refuse is the
    // presentation surface: `configure()` tears the swap chain down and builds
    // it again, and every texture the renderer sized to the old one with it.
    // So the canvas dimensions are recorded per frame and `configure` is
    // counted, which turns "the compositor waited" into either a resize with a
    // timestamp or a ruled-out hypothesis.
    R.configs = 0;
    R.pipelines = [];
    try {
      const CC = globalThis.GPUCanvasContext?.prototype;
      if (CC?.configure && !CC.__gi2MotionWrapped) {
        CC.__gi2MotionWrapped = true;
        const orig = CC.configure;
        CC.configure = function (...a) {
          R.configs++;
          R.frameApi.configure = (R.frameApi.configure ?? 0) + 1;
          return orig.apply(this, a);
        };
      }
    } catch { /* no WebGPU canvas context on this build */ }
    const dev = backend?.device;
    if (dev && !dev.__gi2MotionApiWrapped) {
      dev.__gi2MotionApiWrapped = true;
      for (const m of [
        "createRenderPipeline", "createRenderPipelineAsync",
        "createComputePipeline", "createComputePipelineAsync",
        "createShaderModule", "createBindGroup", "createBindGroupLayout",
      ]) {
        const orig = dev[m];
        if (typeof orig !== "function") continue;
        dev[m] = function (...a) {
          const t0 = performance.now();
          const r = orig.apply(this, a);
          const d = performance.now() - t0;
          const e = R.api.get(m) ?? { n: 0, ms: 0, max: 0 };
          e.n++; e.ms += d; if (d > e.max) e.max = d;
          R.api.set(m, e);
          R.frameApi[m] = (R.frameApi[m] ?? 0) + 1;
          R.frameApi[`${m}Ms`] = (R.frameApi[`${m}Ms`] ?? 0) + d;
          // ⭐ AND WHICH ONE. A pipeline count says a hitch is compilation; the
          // pipeline's LABEL says whose material, which is the difference
          // between "warm the pipelines" and a fix that can be aimed.
          if (m.startsWith("createRenderPipeline") || m.startsWith("createComputePipeline")) {
            let label = a[0]?.label || "";
            try {
              const v = a[0]?.vertex?.entryPoint ?? "";
              const f = a[0]?.fragment?.entryPoint ?? "";
              label += ` [${v}/${f}]`;
            } catch { /* a descriptor shape three changed */ }
            R.pipelines.push({ t: performance.now(), frame: R.frames.length, label });
          }
          return r;
        };
      }
    }
    const rawRender = renderer.render.bind(renderer);
    renderer.render = function (scene, camera) {
      const t0 = performance.now();
      const out = rawRender(scene, camera);
      const d = performance.now() - t0;
      R.renderN++;
      R.renderMs += d;
      if (d > 12) {
        let st = "";
        try { st = String(new Error().stack ?? "").split("\n").slice(1, 7).map((l) => l.trim()).join(" | "); }
        catch { /* no stack */ }
        R.renderStacks.push({
          t: t0, ms: d, frame: R.frames.length, scene: scene?.name || scene?.type || "?",
          children: scene?.children?.length ?? -1, stack: st,
        });
      }
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

  // ══ §19 STAGE 3.12 — the grain receipt's in-page half ═════════════════════
  //
  // The statistic is `gi2-gather.html`'s `grainReceipt`, verbatim in its
  // arithmetic: each pixel against its own REPROJECTED previous value, a
  // histogram of |Δ|/L, and a SIGN census that follows the surface point's own
  // trajectory through `src` (the reprojected source pixel index that
  // `reprojBuf` carries for exactly this). A flip is then the estimate
  // reversing on one surface point and cannot be parallax.
  R.grain = null;
  // ⭐⭐ §19 STAGE 3.18 — AND WHY EACH FLIP HAPPENED.
  //
  // `CLS` is the classifier's vocabulary, and its ORDER is its priority: a
  // flipping pixel is attributed to the FIRST mechanism whose input actually
  // moved between the two frames, read out of `diagBuf` at this pixel and at
  // the reprojected source pixel. `base` counts the same classes over every
  // SCORED step, so a class can be read as a LIFT (its share of flips against
  // its share of steps) rather than as a share that a common event would win
  // by being common. [[probe-blind-statistics]]
  const CLS = ["rekey", "band", "vis", "value"];
  const CLS_T = Number(globalThis.__gi2ClsThreshold ?? 0.02);
  R.grainMk = (want, label) => ({
    label, want, frames: 0, chain: Promise.resolve(), lit: null, litR: null, err: null,
    prevS: null, curS: null, hist: new Float64Array(2001), hn: 0,
    steps: 0, moved: 0, flips: 0, scored: 0, reproj: 0, dropped: 0,
    // ⭐⭐ §19 3.18 — THE PARK FRAMES ARE SCORED SEPARATELY, NOT DISCARDED.
    //
    // Every grain arm already begins with a settle at the start pose, and the
    // census has always folded those frames into the same totals — where they
    // read as "moved 0 %" and vanish. Scored on their own they are the control
    // this stage could not otherwise get: the SAME scene, the SAME boot, the
    // SAME instrument, with the camera not moving. A field that flips there is
    // churning on its own, and no camera-side fix can reach it.
    park: { steps: 0, flips: 0, moved: 0, reproj: 0 },
    move: { steps: 0, flips: 0, moved: 0, reproj: 0 },
    // §19 3.18 — the classifier's own state. `prevD` is the previous frame's
    // `diagBuf` and `prevV` says which of its pixels had geometry, because a
    // pixel that was sky carries stale diagnostics that must not be compared.
    dv: 0, prevD: null, prevV: null, curV: null,
    prevSR: null, curSR: null, stepsR: 0, flipsR: 0,
    cls: Object.fromEntries(CLS.map((k) => [k, 0])),
    base: Object.fromEntries(CLS.map((k) => [k, 0])),
    clsUnk: 0, baseUnk: 0,
  });
  const histAdd = (G, v) => { G.hist[Math.min(2000, Math.max(0, Math.round(v * 1000)))]++; G.hn++; };
  const histP = (G, p) => {
    if (!G.hn) return null;
    let acc = 0;
    for (let i = 0; i <= 2000; i++) { acc += G.hist[i]; if (acc >= (p / 100) * G.hn) return i / 1000; }
    return 2;
  };
  // ⭐⭐⭐ §19 3.18 — THE UNCERTAINTY GATE. `EPS_K` multiplies the kernel's own
  // error bar (`reprojErr`, the bicubic-minus-bilinear residual of the tap the
  // census reads). 0 is the historical statistic verbatim — every delta over a
  // tenth of a percent scored, including the ones that are the resampling. 1
  // scores only deltas the instrument can actually resolve.
  const EPS_K = Number(globalThis.__gi2EpsK ?? 0);
  // ⭐⭐⭐ §19 3.18 — THE EXACT-TAP CENSUS. A pixel is scored only when its
  // reprojection landed within `EXACT_EPS` of a sample centre, where the
  // previous value is read rather than interpolated. 0.5 is every pixel (the
  // historical statistic); 0.05 keeps the taps whose comparison is exact.
  const EXACT_EPS = Number(globalThis.__gi2ExactEps ?? 0.5);
  const grainReduce = (G, f, d = null, dv = 0, seg = "grain", er = null) => {
    const S = seg === "grain-park" ? G.park : G.move;
    const N = f.length / 4;
    if (!G.prevS) { G.prevS = new Int8Array(N); G.curS = new Int8Array(N); }
    if (d && !G.prevD) {
      G.dv = dv;
      G.prevD = new Float32Array(N * dv * 4);
      G.prevV = new Uint8Array(N);
      G.curV = new Uint8Array(N);
      G.prevSR = new Int8Array(N);
      G.curSR = new Int8Array(N);
    }
    if (d && G.litR == null) {
      // The pre-blend signal gets its OWN lit threshold, derived the same way.
      // Sharing the image's would judge two differently-scaled signals by one
      // constant, which is how a "no change" arm becomes a "no data" arm.
      const xs = [];
      const off = (dv - 1) * 4 + 3;
      for (let i = 0; i < N; i++) if (f[i * 4 + 3] > 0.5) xs.push(d[i * dv * 4 + off]);
      xs.sort((a, b) => a - b);
      G.litR = xs.length ? 0.1 * xs[xs.length >> 1] : 0;
    }
    if (G.lit == null) {
      // The lit threshold is a tenth of the median VALID luminance, derived
      // from the scene rather than chosen — a dark arm and a bright one are
      // then judged the same way and no constant is a threshold.
      const xs = [];
      for (let i = 0; i < N; i++) if (f[i * 4 + 3] > 0.5) xs.push(f[i * 4]);
      xs.sort((a, b) => a - b);
      G.lit = xs.length ? 0.1 * xs[xs.length >> 1] : 0;
    }
    G.curS.fill(0);
    if (d) { G.curV.fill(0); G.curSR.fill(0); }
    const NC = dv;
    for (let i = 0; i < N; i++) {
      if (!(f[i * 4 + 3] > 0.5)) continue;
      G.scored++;
      if (d) G.curV[i] = 1;
      const s = f[i * 4 + 2];
      if (!(s >= 0)) continue;
      G.reproj++;
      S.reproj++;
      const L = f[i * 4];
      const P = f[i * 4 + 1];
      // ══ §19 3.18 — the SAME census on the pre-blend signal ════════════════
      // `resolveHalf`'s own luminance, tracked through the same `src`. Its flip
      // rate against the image's is the image accumulation's whole effect.
      if (d) {
        const j = i * NC * 4 + (NC - 1) * 4 + 3;
        const k = (s | 0) * NC * 4 + (NC - 1) * 4 + 3;
        const LR = d[j];
        const PR = G.prevV[s | 0] ? G.prevD[k] : -1;
        if (LR > G.litR && PR > 0 && Math.abs(LR - PR) > 1e-3 * LR) {
          const sgR = LR - PR > 0 ? 1 : -1;
          G.curSR[i] = sgR;
          const psR = G.prevSR[s | 0];
          if (psR !== 0) { G.stepsR++; if (sgR !== psR) G.flipsR++; }
        }
      }
      if (!(L > G.lit) || !(P > 0)) continue;
      const dd = L - P;
      histAdd(G, Math.abs(dd) / L);
      // ⚠ THE FLOOR IS THE LARGER OF THE TWO. `1e-3·L` is the historical
      // amplitude floor; `EPS_K · reprojErr[i]` is what this tap could resolve
      // on this pixel this frame. A delta under either is not evidence.
      if (!(Math.abs(dd) > 1e-3 * L)) continue;
      if (er && EPS_K > 0 && !(Math.abs(dd) > EPS_K * er[i * 2])) { G.dropped++; continue; }
      if (er && EXACT_EPS < 0.5 && !(er[i * 2 + 1] <= EXACT_EPS)) { G.dropped++; continue; }
      G.moved++;
      S.moved++;
      const sg = dd > 0 ? 1 : -1;
      G.curS[i] = sg;
      const ps = G.prevS[s | 0];
      if (ps !== 0) {
        G.steps++;
        S.steps++;
        const flipped = sg !== ps;
        if (flipped) { G.flips++; S.flips++; }
        // ── classify, on the resolve's own inputs ─────────────────────────
        if (d) {
          const si = s | 0;
          if (!G.prevV[si]) { G.baseUnk++; if (flipped) G.clsUnk++; } else {
            let dCov = 0; let dFresh = 0; let dClaim = 0; let dVis = 0;
            for (let c = 0; c < NC; c++) {
              const a = i * NC * 4 + c * 4;
              const b = si * NC * 4 + c * 4;
              dCov = Math.max(dCov, Math.abs(d[a] - G.prevD[b]));
              dFresh = Math.max(dFresh, Math.abs(d[a + 1] - G.prevD[b + 1]));
              dClaim = Math.max(dClaim, Math.abs(d[a + 2] - G.prevD[b + 2]));
              // The LAST cascade's `.w` is the resolve luminance, not `vis`.
              if (c < NC - 1) dVis = Math.max(dVis, Math.abs(d[a + 3] - G.prevD[b + 3]));
            }
            const key = (dFresh > CLS_T || dCov > CLS_T) ? "rekey"
              : dClaim > CLS_T ? "band"
                : dVis > CLS_T ? "vis" : "value";
            G.base[key]++;
            if (flipped) G.cls[key]++;
          }
        }
      }
    }
    G.prevS.set(G.curS);
    if (d) {
      G.prevD.set(d);
      G.prevV.set(G.curV);
      G.prevSR.set(G.curSR);
    }
  };
  const grainTick = () => {
    const G = R.grain;
    const g = globalThis.__gi2GatherProbe;
    // ⚠ THE BLIND-INSTRUMENT CHECK IS A FIELD, NOT A SILENT ZERO. Without
    // `__gi2NoiseDump` set before boot the kernel is never built, and a receipt
    // that then reported "0 flips" would be reporting its own absence.
    if (!g?.passes?.reprojDump || !g?.buffers?.reprojBuf) {
      G.err = "no reprojDump kernel — __gi2NoiseDump must be set before boot";
      G.frames = G.want;
      return;
    }
    G.frames++;
    try {
      eng.renderer.compute(g.passes.reprojDump);
      const p = eng.renderer.getArrayBufferAsync(g.buffers.reprojBuf.value);
      // §19 3.18 — `diagBuf` is issued in the SAME encode as `reprojBuf`, for
      // the reason the note above `grainTick`'s readback already gives: the
      // copy happens when `getArrayBufferAsync` is CALLED, so two calls one
      // `await` apart would describe two different frames.
      const wantD = R.classify && g.buffers.diagBuf;
      const pd = wantD ? eng.renderer.getArrayBufferAsync(g.buffers.diagBuf.value) : null;
      // ⚠ THE SEGMENT IS CAPTURED AT DISPATCH, NOT READ IN THE `.then()`. The
      // reduction lands frames later, by which time `R.seg` names a different
      // part of the plan — and the park control would then be scored with the
      // moving frames it exists to be compared against.
      const seg = R.seg;
      const pe = g.buffers.reprojErr
        ? eng.renderer.getArrayBufferAsync(g.buffers.reprojErr.value) : null;
      G.chain = G.chain.then(() => Promise.all([p, pd, pe]))
        .then(([buf, dbuf, ebuf]) => grainReduce(G, new Float32Array(buf),
          dbuf ? new Float32Array(dbuf) : null, g.buffers.diagVec ?? 0, seg,
          ebuf ? new Float32Array(ebuf) : null))
        .catch((e) => { G.err ??= String(e?.message ?? e); });
    } catch (e) { G.err ??= String(e?.message ?? e); }
  };
  R.grainSummary = () => {
    const G = R.grain;
    if (!G) return null;
    return {
      label: G.label, frames: G.frames, err: G.err,
      p50: histP(G, 50), p95: histP(G, 95), n: G.hn,
      movedPct: G.reproj ? (100 * G.moved) / G.reproj : null,
      flipPct: G.steps ? (100 * G.flips) / G.steps : null,
      reprojPct: G.scored ? (100 * G.reproj) / G.scored : null,
      steps: G.steps,
      // §19 3.18 — the pre-blend census and the class shares.
      flipPctRaw: G.stepsR ? (100 * G.flipsR) / G.stepsR : null,
      stepsRaw: G.stepsR,
      cls: { ...G.cls, unknown: G.clsUnk },
      base: { ...G.base, unknown: G.baseUnk },
      droppedPct: (G.moved + G.dropped)
        ? (100 * G.dropped) / (G.moved + G.dropped) : null,
      parkFlipPct: G.park.steps ? (100 * G.park.flips) / G.park.steps : null,
      parkMovedPct: G.park.reproj ? (100 * G.park.moved) / G.park.reproj : null,
      parkSteps: G.park.steps,
      moveFlipPct: G.move.steps ? (100 * G.move.flips) / G.move.steps : null,
      moveMovedPct: G.move.reproj ? (100 * G.move.moved) / G.move.reproj : null,
      moveSteps: G.move.steps,
    };
  };

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
    // §19 4.1b's sweep, on the budget that actually bounds the walk. Same
    // one-boot argument as `R.pin` above: an item limit compared across runs is
    // a comparison of two GPU moods.
    if (R.cells > 0 && gi2?.voxelizer?.setCellLimit) gi2.voxelizer.setCellLimit(R.cells);
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
      // §19 4.1b. `cellLimit` is what the frame's item budget actually was;
      // `vxItems` / `vxItemTris` lag with the rest of the readback and are here
      // to say what shape the work had, not to time it.
      cellLimit: gi2?.voxelizer?.cellLimit ?? 0,
      vxItems: vx?.items ?? 0, vxItemTris: vx?.maxItemTris ?? 0, vxItemCut: vx?.itemCut ?? 0,
      // §19 Stage 3.10 item 5: the GC witness. `usedJSHeapSize` is a 20 ns
      // property read; a slow frame across which it FALLS is a collection, and
      // one across which it leaps names the allocation that bought it. Neither
      // can be seen in a phase mark, because neither is in the tick.
      heap: performance.memory?.usedJSHeapSize ?? 0,
      // How many times the frame drew the SCENE, and what those calls cost on
      // the CPU. `renderMs` is wall clock inside `renderer.render`, so a frame
      // whose `dt` is 180 ms with `renderMs` 160 has its answer on this line.
      renderN: R.renderN, renderMs: R.renderMs,
      draws: renderer?.info?.render?.drawCalls ?? 0,
      api: R.frameApi,
      cw: renderer?.domElement?.width ?? 0, ch: renderer?.domElement?.height ?? 0,
      texMB: Math.round((renderer?.info?.memory?.textures ?? 0)),
      geoN: renderer?.info?.memory?.geometries ?? 0,
    };
    R.renderN = 0;
    R.renderMs = 0;
    R.frameApi = {};
    // ⭐⭐⭐ IS THE GPU BEHIND? `onSubmittedWorkDone` resolves when everything
    // submitted so far has retired, so the latency of that promise measured
    // from the END of the tick is exactly "how far behind the queue is". A
    // frame whose wall clock is 160 ms with 20 ms of CPU, no long task and no
    // device call has nothing left to be waiting for except this — and the
    // number distinguishes a GPU that is genuinely busy from a compositor that
    // simply did not schedule us.
    try {
      const q = renderer?.backend?.device?.queue;
      if (q?.onSubmittedWorkDone) {
        const t0 = performance.now();
        q.onSubmittedWorkDone().then(() => { rec.gpuDrainMs = performance.now() - t0; });
      }
    } catch { /* a backend without a device */ }
    R.frames.push(rec);
    drainGpu();

    // ⭐⭐ §19 STAGE 3.12 — THE REPROJECTED SIGN-FLIP RECEIPT, ON BISTRO.
    //
    // 3.11a's grain instrument only ever ran on the Cornell box, where "the
    // camera moves" means a 4 m orbit in a sealed 10 m room. The user's report
    // is about a street. This runs the SAME kernel (`gatherProbes.reprojDump`)
    // on the same three camera arms this probe already drives, so the quantity
    // is identical and only the world differs.
    //
    // ⚠ IT MUST BE DISPATCHED EXACTLY ONCE PER ENGINE FRAME. `reprojDump`
    // writes this frame's luminance into `motionLum[curBase]` and reads the
    // previous frame's out of `[prevBase]`, and those two flip on the gather's
    // own `beginFrame` — so a dispatch every OTHER frame would compare a pixel
    // to itself two frames ago and call the difference grain, while two
    // dispatches in one frame would compare it to itself.
    // ⚠ AND THE READBACK IS ISSUED HERE, NOT IN THE `.then()`. The copy is
    // encoded when `getArrayBufferAsync` is CALLED; deferring the call into the
    // reduction chain would read whatever frame happened to be current when the
    // chain got round to it.
    if (R.grain && R.grain.frames < R.grain.want) grainTick();

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
const runArm = async (arm, label = arm, pin = 0, cells = 0) => {
  console.log(`\n── ${label} ──────────────────────────────────────────────`);
  const ok = await page.evaluate(({ arm, label, pin, cells, PARK, MOVE, WHIP, TAIL, DOLLY_M }) => {
    const R = globalThis.__gi2Motion;
    R.pin = pin;
    R.cells = cells;
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
  }, { arm, label, pin, cells, PARK, MOVE, WHIP, TAIL, DOLLY_M });
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
// VOX_CELLS="1024,4096,16384,32768" — the same one-boot sweep, on §19 4.1b's
// WORK-ITEM budget instead of the (refuted) dirty-brick one. This is the knob
// that calibrates `GI2_VOX_TIERS.itemsPerFrame`: the arm answers "what does an
// item budget of N cost per frame, and how many frames does the slab then take".
const CELLS = (process.env.VOX_CELLS ?? "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
const armList = [];
if (CELLS.length) {
  for (const arm of ARMS) for (const v of CELLS) armList.push([arm, `${arm}#${v}`, 0, v]);
} else if (SWEEP.length) {
  for (const arm of ARMS) for (const v of SWEEP) armList.push([arm, `${arm}@${v}`, v, 0]);
} else {
  for (const arm of ARMS) armList.push([arm, arm, 0, 0]);
}
// ══ §19 STAGE 3.10 ITEM 5 — A REAL JS SAMPLING PROFILE, VIA CDP ═══════════
//
// The in-page wrappers above name a block that arrives through a TIMER, an
// IDLE callback, a WORKER message or a promise continuation. They cannot name
// one that arrives inside a call the engine makes itself — a pipeline
// compilation inside `renderer.render`, a typed-array copy, a `Map` rehash —
// and "outside the tick" was inferred from the phase marks summing to 21 of
// 136 ms, which is exactly the shape a call the marks do not BRACKET makes.
//
// So `PROFILE=1` attaches Chrome's own sampler through the DevTools protocol
// and, for every frame over the spike threshold, prints what the main thread
// was actually executing during that frame's wall clock. No page change, real
// function names and file:line (vite serves unminified source), and it is off
// by default because a 200 µs sampler is not free and the GATE run must be
// measured without it.
//
// ⚠ THE TWO CLOCKS HAVE TO BE TIED TOGETHER, AND ONE `evaluate` DOES IT.
// `Profiler.stop` returns timestamps in the profiler's own microsecond domain;
// the frame records are `performance.now()` milliseconds. Reading
// `performance.now()` in the page immediately after `Profiler.start()` gives
// one point in both domains, and `profile.startTime` gives the other, so the
// map is an offset. The round-trip skew is a millisecond or two against a
// block of a hundred, which is well inside what "which function" needs.
let cdp = null;
let profZero = null;
if (process.env.PROFILE) {
  cdp = await page.target().createCDPSession();
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  profZero = await page.evaluate(() => performance.now());
  console.log("  JS sampling profiler ARMED (200 µs) — timings carry its overhead");
}

for (const [arm, label, pin, cells] of armList) await runArm(arm, label, pin, cells);

// ══════════════ §19 STAGE 3.12 — GRAIN UNDER MOTION, ON THIS SCENE ══════════
//
// ⭐⭐ THE 3.11a/3.12 GRAIN RECEIPT MOVED OFF THE CORNELL BOX. Everything the
// stage measured about motion grain was measured in a sealed 10 m room on a
// 4 m orbit; the user's report is about a street. This runs the identical
// statistic (each pixel against its own REPROJECTED previous value, with the
// sign followed along the surface point's own trajectory) on the three camera
// arms this probe already drives.
//
// ⚠ IT RUNS LAST, AND ITS FRAMES ARE NOT IN THE PERF TABLES. Each frame issues
// a storage-buffer READBACK, which is a pipeline flush — a frame-time number
// taken here would be measuring the instrument. The arms above have already
// finished by the time this starts.
//
// ⚠ BOTH CONFIGURATIONS COME OUT OF ONE BOOT. `probeDither` and `accumOn` are
// uniforms, so 3.11's arm and 3.12's arm run against the same voxelization, the
// same converged cache and the same shader cache; a "before" measured on a
// second boot would carry a different cache and a different contention.
const GRAIN = process.env.GRAIN !== "0";
const GRAIN_FRAMES = Number(process.env.GRAIN_FRAMES ?? 40);
// §19 3.18 — the settle at the arm's start pose, scored as its own control.
const GRAIN_PARK = Number(process.env.GRAIN_PARK ?? 24);
const grainRows = [];
if (GRAIN) {
  const armed = await page.evaluate(() => !!globalThis.__gi2GatherProbe?.passes?.reprojDump);
  if (!armed) {
    console.log("\n  ⚠ GRAIN SKIPPED — no `__gi2GatherProbe`. The receipt buffers are built only " +
      "when `__gi2NoiseDump` is set before boot; run with FLAGS='{\"__gi2NoiseDump\":true}'.");
  } else {
    console.log(`\n── grain (reprojected sign flips, ${GRAIN_FRAMES} frames per arm) ─────────`);
    // ⛔⛔ §19 3.18 — THIS CENSUS HAS A FLOOR AND IT IS THE SIZE OF THE NUMBER.
    // Measured on Bistro: the ALBEDO — a field that provably does not change
    // between two frames — read 34.1 / 31.6 / 24.3 % through this exact
    // statistic, against the world path's own 34.7 / 25.3 / 22.3 %, and the
    // SHIPPING screen path read 49.9 / 28.8 / 46.7 %. The reprojection
    // interpolates the previous frame at a sub-pixel position and the sign of
    // that resampling error is arbitrary, so below some amplitude this census
    // is reporting its own resampling. Never quote a moving flip rate without
    // the floor beside it. [[probe-blind-statistics]]
    console.log("  ⚠ the moving flip rate has a FLOOR — measure it beside the arm:");
    console.log("    GRAIN_CFG='[[\"base\",{}],[\"NULL\",{\"reprojNull\":1}]]'"
      + "  ·  EXACT_EPS=0.15 scores only taps that landed on a sample centre");
    // §19 3.13: `probeDither` is read by `probeTrace`, which the WORLD path does
    // not build — running the 3.11/3.12 pair there would print two identical
    // rows and label one of them a comparison. The world arm gets its own pair
    // (the lattice, and the lattice with the image accumulation off) and the
    // 3.12 row comes from the OTHER boot, which is what a before/after is.
    const worldArm = await page.evaluate(() => globalThis.__gi2WorldProbes === true);
    // ⭐⭐ §19 3.18 — THE ISOLATION ARMS, AS UNIFORMS OUT OF ONE BOOT.
    //
    // The class census (`CLASSIFY=1`) is CORRELATIONAL: it says which of the
    // resolve's inputs moved on a flipping pixel, and a reprojection that lands
    // a pixel away puts a SPATIAL gradient in every one of those deltas. The
    // arms below are causal instead — each disables exactly one mechanism
    // through a uniform the resolve already reads, on the same boot, the same
    // voxelization and the same cache, so the flip rate's MOVE is the
    // mechanism's own contribution and nothing else's.
    //   GRAIN_CFG='[["vis off",{"wpVisOn":0}],["c0 only",{"wpCascadesOn":0}]]'
    const EXTRA = JSON.parse(process.env.GRAIN_CFG ?? "null");
    const CFG = EXTRA ? EXTRA.map(([n, o]) => [n, { accumOn: 1, ...o }]) : worldArm ? [
      ["3.13 (world lattice)", { accumOn: 1 }],
      ["3.13 (world, no accum)", { accumOn: 0 }],
    ] : [
      ["3.11 (dither 1, no accum)", { probeDither: 1, accumOn: 0 }],
      ["3.12 (centres + accum)", { probeDither: 0, accumOn: 1 }],
    ];
    for (const arm of ARMS) {
      for (const [name, cfg] of CFG) {
        const label = `${arm} / ${name}`;
        await page.evaluate(({ arm, label, cfg, frames, DOLLY_M, park }) => {
          const R = globalThis.__gi2Motion;
          const gu = globalThis.__gi2GatherProbe.uniforms;
          // ⚠ RESTORE THE DEFAULTS FIRST. An arm that turns a term OFF and the
          // next that never mentions it would otherwise run with it still off,
          // and the table would read as though the second arm's change did the
          // first arm's work. Snapshotted once, on the first arm.
          // ⚠ ONLY THE ARMS' OWN KEYS. `u` also carries `frame`, `curBase` and
          // `prevBase`, which are PER-FRAME STATE — restoring those would rewind
          // the round-robin phase and the motion double-buffer at every arm
          // boundary, which is the instrument editing its own subject.
          const D = (globalThis.__gi2GrainDefaults ??= Object.fromEntries(
            Object.entries(gu).filter(([k, n]) => /^(wp|accum|probeDither|reproj|inject|hzbOn)/.test(k)
              && n && typeof n.value === "number").map(([k, n]) => [k, n.value])));
          for (const [k, v] of Object.entries(D)) gu[k].value = v;
          for (const [k, v] of Object.entries(cfg)) if (gu[k]) gu[k].value = v;
          const B = R.base;
          const steps = [];
          const rotY = (v, o, a) => {
            const c = Math.cos(a), s = Math.sin(a);
            const x = v[0] - o[0], z = v[2] - o[2];
            return [o[0] + x * c - z * s, v[1], o[2] + x * s + z * c];
          };
          // ⚠ A SETTLE AT THE START POSE FIRST, and it is not padding: the
          // accumulator's history and the probe map both carry the PREVIOUS
          // arm's camera, and a receipt that started measuring on frame 1
          // would score one arm's disocclusion as the next arm's grain.
          for (let i = 0; i < park; i++) steps.push({ seg: "grain-park", p: B.p, t: B.t });
          for (let i = 0; i < frames; i++) {
            const f = (i + 1) / frames;
            if (arm === "orbit") steps.push({ seg: "grain", p: rotY(B.p, B.t, (Math.PI / 2) * f), t: B.t });
            else if (arm === "dolly") {
              const d = [B.t[0] - B.p[0], B.t[1] - B.p[1], B.t[2] - B.p[2]];
              const len = Math.hypot(d[0], d[1], d[2]) || 1;
              const u = d.map((v) => v / len);
              const k = DOLLY_M * f;
              steps.push({
                seg: "grain",
                p: [B.p[0] + u[0] * k, B.p[1] + u[1] * k, B.p[2] + u[2] * k],
                t: [B.t[0] + u[0] * k, B.t[1] + u[1] * k, B.t[2] + u[2] * k],
              });
            } else steps.push({ seg: "grain", p: B.p, t: rotY(B.t, B.p, Math.PI * f) });
          }
          R.arm = label; R.seg = "grain-park";
          R.plan = { steps }; R.planAt = 0; R.done = false;
          // Armed AFTER the park segment is queued but counted from the first
          // tick, so `want` covers the park too — the park's frames are still
          // reduced (they are the instrument's own null) and the moving ones
          // follow them in the same census.
          R.grain = R.grainMk(steps.length, label);
        }, { arm, label, cfg, frames: GRAIN_FRAMES, DOLLY_M, park: GRAIN_PARK });
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          if (await page.evaluate(() => globalThis.__gi2Motion.done)) break;
          await wait(200);
        }
        const row = await page.evaluate(async () => {
          const R = globalThis.__gi2Motion;
          await R.grain.chain;
          return R.grainSummary();
        });
        row.arm = arm; row.cfg = name;
        grainRows.push(row);
        const f = (x, d = 2) => (x == null ? "—" : (100 * x).toFixed(d));
        const p = (x, d = 1) => (x == null ? "—" : x.toFixed(d));
        console.log(`  ${label.padEnd(34)} Δp50 ${f(row.p50).padStart(6)} %  Δp95 ${f(row.p95).padStart(7)} %  ` +
          `flips ${p(row.flipPct).padStart(5)} % of ${String(row.steps).padStart(8)}  moved ${p(row.movedPct).padStart(5)} %  ` +
          `reproj ${p(row.reprojPct).padStart(5)} %${row.err ? `  ⚠ ${row.err}` : ""}`);
        console.log(`      dropped by the error bar ${p(row.droppedPct).padStart(5)} % of deltas`);
        console.log(`      PARKED flips ${p(row.parkFlipPct).padStart(5)} % of ${String(row.parkSteps).padStart(8)}` +
          ` (moved ${p(row.parkMovedPct).padStart(5)} %)   MOVING flips ${p(row.moveFlipPct).padStart(5)} %` +
          ` of ${String(row.moveSteps).padStart(8)} (moved ${p(row.moveMovedPct).padStart(5)} %)`);
        // §19 3.18 — the class census, printed only when it was collected.
        if (row.cls && row.base && Object.values(row.base).some((n) => n > 0)) {
          const tot = Object.values(row.cls).reduce((a, b) => a + b, 0) || 1;
          const btot = Object.values(row.base).reduce((a, b) => a + b, 0) || 1;
          const cells = Object.keys(row.cls).map((k) => {
            const sf = (100 * row.cls[k]) / tot;
            const sb = (100 * row.base[k]) / btot;
            return `${k} ${sf.toFixed(1)}%/${sb.toFixed(1)}%`;
          });
          console.log(`      pre-blend flips ${p(row.flipPctRaw).padStart(5)} % of ` +
            `${String(row.stepsRaw).padStart(8)}   class (of flips / of steps): ${cells.join("  ")}`);
        }
      }
    }
    // Leave the gather on what ships, so anything read after this is the
    // shipped configuration and not the last arm's.
    await page.evaluate(() => {
      const gu = globalThis.__gi2GatherProbe.uniforms;
      if (gu.probeDither) gu.probeDither.value = 0;
      gu.accumOn.value = 1;
    });
  }
}

let profile = null;
if (cdp) {
  ({ profile } = await cdp.send("Profiler.stop"));
  await cdp.send("Profiler.disable");
}

// ══════════════════════════════════════════════════════════════════ THE REPORT
const data = await page.evaluate(() => {
  const R = globalThis.__gi2Motion;
  return {
    frames: R.frames, longtasks: R.longtasks, logCount: R.logCount,
    logTexts: [...R.logTexts].sort((a, b) => b[1] - a[1]).slice(0, 12),
    obsTypes: R.obsTypes, obsArmed: R.obsArmed,
    cb: [...R.cb].map(([label, e]) => ({ label, ...e })).sort((a, b) => b.max - a.max).slice(0, 20),
    renderStacks: R.renderStacks.sort((a, b) => b.ms - a.ms).slice(0, 12),
    api: [...R.api].map(([m, e]) => ({ m, ...e })).sort((a, b) => b.ms - a.ms),
    pipelines: R.pipelines,
    cbEvents: R.cbEvents.sort((a, b) => b.ms - a.ms).slice(0, 40),
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
console.log("arm             n   median    p95     max   itemLimit   busy%   slab frames (med/max)");
const voxRows = [];
for (const [, arm] of armList) {
  const recs = data.frames.filter((f) => f.arm === arm && (f.seg === "moving" || f.seg === "tail"));
  const vm = recs.map((f) => f.voxMs).filter((v) => v > 0);
  if (!vm.length) { console.log(`${arm.padEnd(14)} — no sample (the chain never batched, or no timestamp queries)`); continue; }
  const cl = recs.map((f) => f.cellLimit).filter((v) => v > 0);
  // ⭐ SCROLL-TO-SLAB-COMPLETE LATENCY, AND WHAT IT IS ACTUALLY MEASURING.
  //
  // The voxelizer's own `dirty` count lags: `statsCadence` samples it every 30
  // frames once the window has settled, so it cannot time an event that lasts a
  // handful of frames — the instrument would be reporting its own sampling rate.
  // `voxMs` is per-frame, so the run of consecutive frames on which the chain
  // stays ABOVE its idle floor is the frames-to-drain signal, and it is the
  // trade §19 4.1b buys: a bounded frame is paid for in more of them.
  //
  // The floor is derived from the arm's OWN parked segment rather than from a
  // constant, because a chain that costs 0.14 ms idle on one machine costs
  // something else on another, and the question is "above idle", not "above
  // 0.2 ms".
  const parkedVm = data.frames.filter((f) => f.arm === arm && f.seg === "parked").slice(5)
    .map((f) => f.voxMs).filter((v) => v > 0);
  const floor = Math.max(0.05, (median(parkedVm) || 0.15) * 3);
  const runs = [];
  let run = 0;
  for (const f of recs) {
    if (f.voxMs > floor) run++;
    else if (run) { runs.push(run); run = 0; }
  }
  if (run) runs.push(run);
  const busy = recs.filter((f) => f.voxMs > floor).length / Math.max(1, recs.length);
  voxRows.push({
    arm, n: vm.length, median: median(vm), p95: pct(vm, 95), max: Math.max(...vm),
    floor, busyPct: busy * 100, slabMedian: median(runs), slabMax: runs.length ? Math.max(...runs) : 0,
    slabs: runs.length, cellLimit: cl.length ? Math.max(...cl) : 0,
  });
  console.log(`${arm.padEnd(14)} ${String(vm.length).padStart(3)} ${f2(median(vm)).padStart(7)} ` +
    `${f2(pct(vm, 95)).padStart(7)} ${f2(Math.max(...vm)).padStart(7)}   ` +
    `${(cl.length ? `${Math.min(...cl)}–${Math.max(...cl)}` : "—").padStart(9)}   ` +
    `${(busy * 100).toFixed(0).padStart(5)}   ` +
    `${median(runs).toFixed(0).padStart(3)}/${String(runs.length ? Math.max(...runs) : 0).padStart(3)}` +
    ` over ${runs.length} slabs (floor ${f2(floor)} ms)`);
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
// ══ §19 STAGE 3.10 ITEM 5 — THE SPIKE TABLE ═══════════════════════════════
//
// One row per frame over the threshold, with everything that can explain it on
// the same line: what the tick's own phases accounted for, what the GPU chain
// cost, whether the window scrolled, whether a readback or a log landed, and
// what the JS heap did across it. The column that matters is `unmarked` — the
// wall clock the tick did NOT account for. That is the block.
{
  const SPIKE = Number(process.env.SPIKE_MS ?? 50);
  const spikes = data.frames
    .map((f, i) => ({ ...f, i }))
    .filter((f) => f.dt > SPIKE && f.seg !== "boot");
  console.log(`
══ SPIKES (> ${SPIKE} ms) ══ ${spikes.length} of ${data.frames.length} frames`);
  if (spikes.length) {
    console.log("  #     arm/seg          dt     marked  unmarked   voxMs  scroll  rb  log   ΔheapMB");
    let prevHeap = null;
    for (const f of data.frames) {
      const h = f.heap || 0;
      if (spikes.includes(f)) { /* placeholder, replaced below */ }
      prevHeap = h;
    }
    for (const f of spikes) {
      const prev = data.frames[f.i - 1];
      const marked = Object.values(f.phases ?? {}).reduce((a, v) => a + v, 0);
      const dHeap = prev?.heap ? (f.heap - prev.heap) / 1048576 : 0;
      console.log(
        `  ${String(f.i).padStart(4)}  ${`${f.arm}/${f.seg}`.padEnd(15)} ${f2(f.dt).padStart(7)} ` +
        `${f2(marked).padStart(7)} ${f2(f.dt - marked).padStart(9)} ${f2(f.voxMs).padStart(7)} ` +
        `${String(f.scrolls - (prev?.scrolls ?? f.scrolls)).padStart(6)} ${String(f.readbacks).padStart(3)} ` +
        `${String(f.logs).padStart(4)} ${dHeap.toFixed(1).padStart(9)}`,
      );
      console.log(`        renders ${f.renderN} costing ${f2(f.renderMs)} ms CPU, ` +
        `${f.draws} draw calls` +
        (Object.keys(f.api ?? {}).length
          ? `; device: ${Object.entries(f.api).filter(([k]) => !k.endsWith("Ms"))
            .map(([k, v]) => `${k.replace("create", "")} ×${v}` +
              (f.api[`${k}Ms`] > 1 ? ` (${f2(f.api[`${k}Ms`])} ms)` : "")).join(", ")}`
          : "; no device calls"));
      {
        const pv = data.frames[f.i - 1];
        console.log(`        canvas ${f.cw}×${f.ch}` +
          (pv && (pv.cw !== f.cw || pv.ch !== f.ch) ? `  ⚠ CHANGED from ${pv.cw}×${pv.ch}` : " (unchanged)") +
          `, textures ${f.texMB}${pv && pv.texMB !== f.texMB ? ` (was ${pv.texMB})` : ""}` +
          `, geometries ${f.geoN}${pv && pv.geoN !== f.geoN ? ` (was ${pv.geoN})` : ""}`);
      }
      console.log(`        queue drain after the tick: ${f2(f.gpuDrainMs ?? NaN)} ms` +
        `  (prev frame ${f2(data.frames[f.i - 1]?.gpuDrainMs ?? NaN)}, ` +
        `${f2(data.frames[f.i - 2]?.gpuDrainMs ?? NaN)})`);
      // The long-animation-frame entries that OVERLAP this frame's wall clock.
      // This is the row that answers "what was the browser doing", because LoAF
      // accounts for the whole frame — the scripts, the render phase, and the
      // remainder that belongs to neither.
      for (const e of data.longtasks.filter((x) => x.t + x.ms > f.t - f.dt && x.t < f.t)) {
        console.log(`        ${e.type} ${f2(e.ms)} ms` +
          (e.blocking != null
            ? ` (blocking ${f2(e.blocking)}, render phase at +${f2(e.renderStart)}, ` +
              `style/layout at +${f2(e.styleLayout)})`
            : ""));
        for (const sc of e.scripts ?? []) {
          console.log(`            ${f2(sc.ms).padStart(8)} ms  ${sc.invokerType ?? "?"} ` +
            `${sc.invoker ?? ""} ${sc.name ?? ""} ${sc.url ?? ""}`);
        }
      }
      const g = Object.entries(f.gpu ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
      if (g.length) {
        console.log(`        GPU: ${g.map(([k, v]) => `${k} ${f2(v)} ms`).join(", ")} ` +
          `(sum ${f2(Object.values(f.gpu).reduce((a, v) => a + v, 0))} ms)`);
      }
      for (const l of (f.logLines ?? []).slice(0, 2)) console.log(`        log: ${l}`);
    }
  }
  {
    // The same numbers for the frames that were FINE, so a spike row can be
    // read as a difference rather than as an absolute.
    const ok = data.frames.filter((f) => f.seg === "moving" && f.dt <= SPIKE);
    console.log(`  the ${ok.length} moving frames that were NOT spikes, for contrast: ` +
      `dt ${f2(median(ok.map((f) => f.dt)))} ms, renders ${median(ok.map((f) => f.renderN))}, ` +
      `renderMs ${f2(median(ok.map((f) => f.renderMs)))}, draws ${median(ok.map((f) => f.draws))}, ` +
      `queue drain ${f2(median(ok.map((f) => f.gpuDrainMs ?? 0)))} ms`);
  }
  // The in-page wrappers: what came in through a timer, an idle callback, a
  // worker message or a promise continuation, ranked by the WORST single call.
  if (data.cb?.length) {
    console.log("\n  callbacks outside the tick (worst single call first):");
    for (const c of data.cb.filter((c) => c.max > 4).slice(0, 12)) {
      console.log(`    ${f2(c.max).padStart(8)} ms max  ${f2(c.ms).padStart(9)} ms total  ` +
        `${String(c.n).padStart(6)} calls   ${c.label}`);
    }
    if (data.cbEvents?.length) {
      console.log("  the individual calls over 8 ms, worst first:");
      for (const e of data.cbEvents.slice(0, 10)) {
        console.log(`    t=${f2(e.t).padStart(10)}  ${f2(e.ms).padStart(8)} ms  ${e.label}`);
      }
    }
  }
  if (data.api?.length) {
    console.log("");
    console.log("  WebGPU device calls over the whole run:");
    for (const a of data.api) {
      console.log(`    ${String(a.n).padStart(6)} ×  ${f2(a.ms).padStart(9)} ms total  ` +
        `${f2(a.max).padStart(8)} ms worst   ${a.m}`);
    }
  }
  if (data.pipelines?.length) {
    console.log("");
    console.log(`  RENDER/COMPUTE PIPELINES CREATED AFTER BOOT: ${data.pipelines.length}`);
    for (const q of data.pipelines) {
      console.log(`    frame #${q.frame}  t=${f2(q.t)}  ${q.label || "(no label)"}`);
    }
    // ⭐⭐ §19 STAGE 4.3b — *WHOSE* PIPELINE. A label names the material's TYPE
    // and its `material.id` (`renderPipeline_${name || type}_${id}`, see
    // WebGPUPipelineUtils) and nothing about the object — so "warm the
    // pipelines" had no target: two stages of receipts said
    // `MeshPhysicalNodeMaterial_143` without ever saying which mesh that is,
    // what layer it sits on, or whether it was visible when the warm looked.
    // The id is the join back to the scene, and this is that join.
    const ids = [...new Set(data.pipelines
      .map((q) => /_(\d+)(?:\s|$)/.exec(q.label ?? "")?.[1])
      .filter(Boolean)
      .map(Number))];
    if (ids.length) {
      const who = await page.evaluate((wanted) => {
        const eng = globalThis.__giEngineForProbe;
        const scene = eng?.scene;
        if (!scene) return null;
        const want = new Set(wanted);
        const out = [];
        scene.traverse((o) => {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m || !want.has(m.id)) continue;
            const chain = [];
            for (let p = o; p && chain.length < 5; p = p.parent) chain.push(p.name || p.type);
            out.push({
              id: m.id, type: m.type, matName: m.name ?? "",
              name: o.name ?? "", visible: o.visible !== false,
              mask: (o.layers.mask >>> 0).toString(16),
              merged: !!o.userData.mergedInto, proxy: !!o.userData.mergeProxy,
              cameraHidden: !!o.userData.cameraHidden,
              attrs: Object.keys(o.geometry?.attributes ?? {}).sort().join(","),
              chain: chain.join(" <- "),
            });
          }
        });
        return out.slice(0, 12);
      }, ids).catch(() => null);
      if (!who?.length) {
        console.log("    ⚠ nothing in the live scene wears those materials — the pipeline's owner " +
          "was destroyed, or it is not a scene mesh (a nested render, an overlay, a postprocess quad).");
      } else {
        for (const w of who) {
          console.log(`      mat#${w.id} ${w.matName || w.type} -> "${w.name}" ` +
            `visible=${w.visible} mask=0x${w.mask} attrs=[${w.attrs}]` +
            `${w.merged ? " MERGED-MEMBER" : ""}${w.proxy ? " MERGE-PROXY" : ""}` +
            `${w.cameraHidden ? " CAMERA-HIDDEN" : ""}`);
          console.log(`         ${w.chain}`);
        }
      }
    }
  }
  if (data.renderStacks?.length) {
    console.log("  the `renderer.render` calls that ran over 12 ms, worst first:");
    for (const r of data.renderStacks.slice(0, 6)) {
      console.log(`    frame #${r.frame}  ${f2(r.ms).padStart(8)} ms  scene "${r.scene}" ` +
        `(${r.children} children)`);
      console.log(`        ${r.stack}`);
    }
  }
  // The sampling profile, attributed to each spike's own wall clock.
  if (profile && profZero != null) {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const times = [];
    let t = profile.startTime;
    for (const d of profile.timeDeltas) { t += d; times.push(t); }
    const toPage = (us) => profZero + (us - profile.startTime) / 1000;
    const name = (n) => {
      const cf = n.callFrame ?? {};
      const f = cf.functionName || "(anonymous)";
      const u = (cf.url || "").replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      return `${f}  ${u}:${(cf.lineNumber ?? 0) + 1}`;
    };
    // ⭐⭐ SELF TIME NAMES THE VICTIM; THE STACK NAMES THE OWNER. `updateMatrixWorld`
    // is hot on every frame of every three.js app ever written — the question a
    // spike asks is what CALLED it this time, and only the ancestor chain
    // answers that. The profile stores the tree as `children`, so the parent
    // map has to be inverted once.
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const chainOf = (id, depth = 7) => {
      const out = [];
      let cur = id;
      while (cur != null && out.length < depth) {
        const n = byId.get(cur);
        if (!n) break;
        out.push(name(n).split("  ")[0] || "?");
        cur = parent.get(cur);
      }
      return out.reverse().join(" › ");
    };
    const attribute = (t0, t1, limit = 8) => {
      const self = new Map();
      const stacks = new Map();
      let n = 0;
      for (let k = 0; k < profile.samples.length; k++) {
        const pt = toPage(times[k]);
        if (pt < t0 || pt > t1) continue;
        n++;
        const node = byId.get(profile.samples[k]);
        if (!node) continue;
        self.set(name(node), (self.get(name(node)) ?? 0) + 1);
        const ch = chainOf(profile.samples[k]);
        stacks.set(ch, (stacks.get(ch) ?? 0) + 1);
      }
      return {
        n,
        top: [...self].sort((a, b) => b[1] - a[1]).slice(0, limit),
        stacks: [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 5),
      };
    };
    console.log(`
  JS SAMPLING PROFILE: ${profile.samples.length} samples over ` +
      `${f2((profile.endTime - profile.startTime) / 1000)} ms`);
    for (const f of spikes.slice(0, 6)) {
      const a = attribute(f.t - f.dt, f.t);
      console.log(`  frame #${f.i} (${f2(f.dt)} ms, ${f.arm}/${f.seg}) — ${a.n} samples:`);
      for (const [k, c] of a.top) {
        console.log(`      ${((100 * c) / Math.max(1, a.n)).toFixed(0).padStart(3)} %  ` +
          `${f2((c * (profile.endTime - profile.startTime) / 1000) / profile.samples.length).padStart(7)} ms  ${k}`);
      }
      console.log("     — the stacks those samples sat in:");
      for (const [k, c] of a.stacks) {
        console.log(`      ${((100 * c) / Math.max(1, a.n)).toFixed(0).padStart(3)} %  ${k}`);
      }
    }
    const all = attribute(-Infinity, Infinity, 10);
    console.log("  whole run, hottest self time:");
    for (const [k, c] of all.top) {
      console.log(`      ${((100 * c) / Math.max(1, all.n)).toFixed(1).padStart(5)} %  ${k}`);
    }
  }
}

const lt = data.longtasks.filter((e) => e.ms > 20);
console.log(`  longtasks  : ${data.longtasks.length} total, ${lt.length} over 20 ms` +
  (lt.length ? `, max ${f2(Math.max(...lt.map((e) => e.ms)))} ms` : "") +
  ` [observers armed: ${(data.obsArmed ?? []).join(", ") || "NONE"}]`);
for (const e of data.longtasks.filter((x) => x.ms > 60).sort((a, b) => b.ms - a.ms).slice(0, 6)) {
  console.log(`    ${e.type} t=${f2(e.t)} ${f2(e.ms)} ms` +
    (e.blocking != null
      ? ` — blocking ${f2(e.blocking)}, render phase starts at +${f2(e.renderStart)}`
      : ""));
  for (const sc of e.scripts ?? []) {
    console.log(`        script ${f2(sc.ms).padStart(8)} ms  ${sc.invokerType ?? "?"}  ` +
      `${sc.invoker ?? ""}  ${sc.name ?? ""}  ${sc.url ?? ""}` +
      (sc.pause > 1 ? `  [paused ${f2(sc.pause)} ms]` : ""));
  }
}
{
  // §19 4.1b's structural receipt: the largest triangle range ONE THREAD walked
  // anywhere in the run, against the bound the kernel was compiled with. This is
  // the number that used to be "every triangle of every cell the brick touched".
  const its = data.frames.map((f) => f.vxItems ?? 0);
  const tri = data.frames.map((f) => f.vxItemTris ?? 0);
  console.log(`  work items : peak ${Math.max(0, ...its)}/frame, max triangles ONE THREAD walked ` +
    `${Math.max(0, ...tri)} of ${describe?.vox?.trisPerItem ?? "?"} ` +
    `(sampled at the stats cadence, so a lower bound)`);
}
if (describe?.vox) {
  console.log(`  voxelizer  : tier ${describe.vox.tier}, pairsPerFrame ${describe.vox.pairsPerFrame}, ` +
    `itemsPerFrame ${describe.vox.itemsPerFrame}, trisPerItem ${describe.vox.trisPerItem}, ` +
    `maxBuild ${describe.vox.maxBuild}` +
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
// §19 4.1b. The MAX, per arm — the pass whose median was already 0.14 ms is not
// the thing under test; the scroll frame is.
for (const v of voxRows) {
  gate(`${v.arm}: voxelize chain GPU ms, MAX`, f2(v.max), `≤ ${VOX_MS}`, v.max <= VOX_MS);
}
console.log(`\n${failed === 0 ? "ALL GATES PASS" : `${failed} GATE(S) FAILED`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
