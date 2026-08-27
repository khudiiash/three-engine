// GI RESOLVE-RESIZE PROBE — §19 stage 0.3, loop B.
//
// WHAT IT MEASURES, AND WHY IT HAD TO BE A PROBE
//
// `GISystem#syncScreenResolveSize` bypasses `requestRebuild()`, so a resize
// never appears as a GI "rebuild" anywhere — it only ever showed up as a
// `resolve-resize WxH→WxH (giCostScale …)` line in `profile.frameStats`'
// `giRebuilds.log`, and on the user's live Bistro there were EIGHT of them in
// three minutes with two compile waves overlapping (§1 of GI_SCALE_PLAN.md).
// The path re-creates ~25 compute passes, and the screen kernels bake `height`
// and its derived ratios into their WGSL TEXT (giScreen.js: `.div(height)`,
// `height - 1`, `aoHeight / height`) — so each distinct size is a fresh driver
// compile for every one of them. `bvhHitShade` alone measured 110 s.
//
// This probe sweeps GI's traced-pixel budget and counts what each step COSTS:
//
//   Phase A  slow sweep  — budget down, settle, budget up, settle. Each step is
//            a genuine, durable size change: it SHOULD resize, and the numbers
//            say what a resize actually costs in pipelines and shader modules.
//   Phase B  fast round trip — budget down and immediately back, inside the
//            `RESOLVE_RESIZE_SETTLE_MS` window. This is a governor overshoot,
//            a window drag, a DRS step and its correction. It must cost ZERO:
//            no `resolve-resize` entry, no new pipeline, no new shader module.
//
// The receipt columns are the ones that name the cost: compute pipelines
// created, shader modules created (a NEW module = WGSL that differed by at
// least one byte = a kernel that bakes the size), live GPU textures, and heap.
//
//   node node_modules/vite/bin/vite.js --port 5202 --strictPort   (if not up)
//   node scripts/run-gi-resize-probe.mjs http://127.0.0.1:5202/
//
// Env:
//   PROJECT=<path>   default C:/Users/Khudiiash/Documents/GAME
//   SCENE=<path>     default <project>/scenes/Level.scene  (Bistro takes 2+ min)
//   SWEEPS=2         Phase A round trips
//   SETTLE=6         seconds to wait after a durable budget change
//   HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = (process.env.SCENE ?? `${PROJECT}/scenes/Level.scene`).replaceAll("\\", "/");
const SWEEPS = Number(process.env.SWEEPS ?? 2);
const SETTLE = Number(process.env.SETTLE ?? 6);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--js-flags=--expose-gc",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let readySeen = false;
let builtCount = 0;
let waveStarts = 0;
let maxConcurrentWaves = 0;
let liveWaves = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] field ready/.test(t)) readySeen = true;
  if (/\[gi\] built/.test(t)) builtCount++;
  // Wave bookkeeping: the opening line is "[gi] compile wave: N unique
  // material variants"; the wave ends with the "N compute pipelines compiled"
  // / "async compile wave failed" tail. Overlap is the §19 0.3 loop C receipt.
  // ⚠ ONE LINE PER EVENT, AND `compile wave:` IS NOT IT. Four different lines
  // start with "[gi] compile wave:" (the variant count, the "warmed safely"
  // tail, the timing tail) — matching the prefix counted a single healthy wave
  // as three overlapping ones on the first run of this probe.
  if (/\[gi\] compile wave started/.test(t)) {
    waveStarts++;
    liveWaves++;
    maxConcurrentWaves = Math.max(maxConcurrentWaves, liveWaves);
  }
  if (/compile wave: materials \d+ms, computes|compile wave failed/.test(t)) {
    liveWaves = Math.max(0, liveWaves - 1);
  }
  if (/\[gi\] (built|field ready|compile wave|resolve target|§19)|resolve-resize|drain cycle|SETTLED/.test(t)) {
    console.log(`  ${t.slice(0, 220)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 300)}`);
});

await page.evaluateOnNewDocument((PROJECT) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  const c = { computePipeline: 0, renderPipeline: 0, shaderModule: 0, texture: 0, textureDestroyed: 0 };
  globalThis.__GPU_COUNTERS__ = c;
  const patch = (proto, name, fn) => {
    if (!proto || typeof proto[name] !== "function") return;
    const orig = proto[name];
    proto[name] = function (...args) { fn(args, this); return orig.apply(this, args); };
  };
  if (globalThis.GPUDevice) {
    patch(GPUDevice.prototype, "createComputePipeline", () => c.computePipeline++);
    patch(GPUDevice.prototype, "createComputePipelineAsync", () => c.computePipeline++);
    patch(GPUDevice.prototype, "createRenderPipeline", () => c.renderPipeline++);
    patch(GPUDevice.prototype, "createRenderPipelineAsync", () => c.renderPipeline++);
    patch(GPUDevice.prototype, "createShaderModule", () => c.shaderModule++);
    patch(GPUDevice.prototype, "createTexture", () => c.texture++);
  }
  if (globalThis.GPUTexture) patch(GPUTexture.prototype, "destroy", () => c.textureDestroyed++);
}, PROJECT);

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

const call = async (op, args = {}) => {
  try {
    return await page.evaluate(async ({ op, args }) => {
      try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, { op, args });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
};

{
  const before = builtCount;
  const r = await call("scene.open", { path: SCENE });
  if (!r.ok) { console.log(`FATAL: scene.open: ${r.error}`); await browser.close(); process.exit(1); }
  const t0 = Date.now();
  while (builtCount <= before && Date.now() - t0 < 300000) await wait(1000);
  console.log(`  scene open, gi built: ${builtCount > before}`);
}
{
  const t0 = Date.now();
  while (!readySeen && Date.now() - t0 < 240000) await wait(2000);
  console.log(`  field ready seen: ${readySeen}`);
}
await wait(8000);

// The census. `giRebuilds` comes from the editor op (the same receipt the user
// reads); everything else is counted at the WebGPU boundary, because "a
// pipeline was created" is the only statement about compile cost that no
// caching layer can quietly reinterpret.
// ⛔⛔ THE LOOP MUST ACTUALLY RUN, AND `__editorKeepRendering` WAS NOT ENOUGH.
// `#syncScreenResolveSize` is called from GI's per-frame tick, so a suspended
// editor loop makes every phase below a measurement of nothing: measured on
// this probe's own first passes, `system._frame` moved 179 → 180 across FIFTY
// SECONDS of sweeping (0 fps), and the sweep "cost 0 pipelines" purely because
// GI never ticked. Pin the loop from the page side — `Engine.start()` is
// idempotent (it re-installs the animation loop) so re-calling it a few times a
// second overrides whatever editorFramePacing decided about an unfocused,
// headless window.
const ensureKeepAlive = () => page.evaluate(async () => {
  if (globalThis.__giResizeProbeKeepAlive) return;
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  globalThis.__editorKeepRendering = true;
  globalThis.__giResizeProbeKeepAlive = setInterval(() => {
    engine.setFrameRateLimit?.(0);
    if (!engine.loopActive) engine.start?.();
  }, 250);
});

// ⚠ RETRIED, BECAUSE VITE CAN RELOAD THE PAGE UNDER THE PROBE. This worktree's
// dev server watches the repo root — editing anything (this file included)
// full-reloads the editor, and a census caught mid-navigation throws
// "Execution context was destroyed". Retrying is the difference between a probe
// that reports a number and one that reports a stack trace.
const census = async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      // Re-armed on EVERY census, not once at the start: vite full-reloads this
      // page (a newly optimized dep, a file touched in the repo root) and a
      // reload drops both the keep-alive interval and the GPU counters. Doing
      // it here means the probe heals itself instead of reporting a dead page.
      await ensureKeepAlive();
      return await censusOnce();
    } catch (err) {
      if (attempt >= 4) throw err;
      console.log(`  (census retry ${attempt + 1}: ${String(err?.message ?? err).slice(0, 90)})`);
      await wait(4000);
    }
  }
};
const censusOnce = () => page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const system = engine?.modules?.get?.("gi")?.system;
  for (let i = 0; i < 2; i++) { globalThis.gc?.(); await new Promise((r) => setTimeout(r, 120)); }
  const c = globalThis.__GPU_COUNTERS__ ?? {};
  const screen = system?.state?.screen;
  const log = (system?.rebuildLog ?? []).map((e) => e.reason);
  return {
    heapMB: (performance.memory?.usedJSHeapSize ?? 0) / 1e6,
    cPipes: c.computePipeline ?? 0,
    rPipes: c.renderPipeline ?? 0,
    shaderModules: c.shaderModule ?? 0,
    texturesLive: (c.texture ?? 0) - (c.textureDestroyed ?? 0),
    resolveW: screen?.width ?? -1,
    resolveH: screen?.height ?? -1,
    rebuildRuns: system?.rebuilds ?? -1,
    rebuildAsks: system?.rebuildAsks ?? -1,
    resizeEntries: log.filter((r) => /^resolve-resize/.test(r)).length,
    // §19 0.3 receipts that live on the system rather than in profile.*
    giTagFlips: system?.giTagFlips ?? 0,
    mergedRebuilds: engine?.shadowMerge?.rebuilds ?? 0,
    mergedRebuiltBy: engine?.shadowMerge?.lastRebuildReason ?? null,
    floorDrainSettled: system?._floorDrainSettled === true,
    floorDrainCycles: system?._floorDrainCycles ?? 0,
    // Is the tick even RUNNING? Every number above reads as a healthy null
    // when it is not — [[probe-blind-statistics]]. `giFrame` moving between
    // two censuses is the proof that anything here was measured at all.
    giFrame: system?._frame ?? -1,
    // …and is the ENGINE running at all? A frozen `giFrame` next to a live fps
    // means GI's tick is returning early; both frozen means the editor loop is
    // asleep (headless is never focused — see editorFramePacing's harness
    // hatch) and NOTHING in this probe measured GI.
    fps: Math.round(engine?.stats?.sample?.().fps ?? engine?.stats?.readout?.fps ?? -1),
    skippedFps: Math.round(engine?.stats?.sample?.().skippedFps ?? -1),
    compileWaveActive: system?._compileWaveActive === true,
    renderSuspended: engine?.renderSuspended === true,
    wantedSize: (() => {
      // What #screenResolveSize would answer right now, recomputed here so a
      // "no resize happened" reading can be told apart from "no resize was
      // WANTED" (the budget override never reached the module).
      // The canvas' own backing-store size IS the drawing buffer, and reading
      // it needs no THREE.Vector2 (`getDrawingBufferSize` writes through
      // `.set().floor()`, so no plain object stands in for one).
      const canvas = engine?.renderer?.domElement;
      if (!canvas?.width) return null;
      const s = { x: canvas.width, y: canvas.height };
      const drs = engine?._drsScale || 1;
      const scale = 0.5 / drs;
      let w = Math.max(16, Math.round(s.x * scale));
      let h = Math.max(16, Math.round(s.y * scale));
      const budget = Number(globalThis.__giResolveMaxPixels) || 1600000;
      const px = w * h;
      const governed = Math.min(px, budget) * (engine?.giCostScale ?? 1);
      if (px > governed) {
        const k = Math.sqrt(governed / px);
        w = Math.max(16, Math.round(w * k));
        h = Math.max(16, Math.round(h * k));
      }
      return `${w}x${h}`;
    })(),
    pendingMaterials: system?.reflectTierCensus?.()?.pendingMaterials ?? -1,
    unknownMaterials: system?.reflectTierCensus?.()?.unknownMaterials ?? -1,
    log,
  };
});

const rows = [];
const record = async (label) => {
  const s = await census();
  rows.push({ label, ...s });
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const d = (k, fixed = 0) => prev ? `${s[k] - prev[k] >= 0 ? "+" : ""}${(s[k] - prev[k]).toFixed(fixed)}` : "";
  console.log(
    `GI-RESIZE ${label.padEnd(16)} ${String(s.resolveW).padStart(5)}x${String(s.resolveH).padEnd(5)}` +
    ` want ${String(s.wantedSize).padEnd(9)} f${String(s.giFrame).padStart(6)} ${String(s.fps).padStart(3)}fps` +
    `${s.compileWaveActive ? " WAVE" : ""}${s.renderSuspended ? " SUSP" : ""}` +
    ` cPipes ${String(s.cPipes).padStart(4)} (${d("cPipes").padStart(5)})` +
    // §19 0.3b: RENDER pipelines beside compute ones. Without this column a
    // durable step that minted 3 compute pipelines and 33 shader modules is
    // unreadable — 2 modules per render pipeline is the only arithmetic that
    // closes, and a MATERIAL recompile on a resize is a different bug from a
    // screen kernel re-mint.
    ` rPipes ${String(s.rPipes).padStart(4)} (${d("rPipes").padStart(5)})` +
    ` shaderMods ${String(s.shaderModules).padStart(4)} (${d("shaderModules").padStart(5)})` +
    ` tex ${String(s.texturesLive).padStart(4)} (${d("texturesLive").padStart(5)})` +
    ` heap ${s.heapMB.toFixed(0).padStart(5)}MB (${d("heapMB", 0).padStart(5)})` +
    ` resizeLog ${s.resizeEntries} runs ${s.rebuildRuns} asks ${s.rebuildAsks}` +
    ` merged ${s.mergedRebuilds}`,
  );
  return s;
};

const setBudget = (px) => page.evaluate((v) => { globalThis.__giResolveMaxPixels = v; }, px);

// ⚠ THE CONSOLE IS NOT THE PAGE. `[gi] built` can arrive from a page that then
// RELOADS (the hub's project open does), which resets the GPU counters and
// leaves the census reading a half-constructed engine — measured on this probe:
// one run reported `heap 466MB / cPipes 111` and the next `216MB / 0` from the
// same code. Poll the live objects until GI is actually there.
{
  const t0 = Date.now();
  let seen = null;
  let prevFrame = -1;
  while (Date.now() - t0 < 240000) {
    seen = await census();
    // TICKING, not merely present. A system that exists but never ticks makes
    // every later delta a zero, which reads as a pass.
    if (seen.rebuildRuns >= 1 && seen.resolveW > 0 && seen.giFrame > prevFrame && prevFrame >= 0) break;
    prevFrame = seen.giFrame;
    await wait(3000);
  }
  console.log(`  gi system live: runs=${seen?.rebuildRuns} resolve=${seen?.resolveW}x${seen?.resolveH} frame=${seen?.giFrame} fps=${seen?.fps}`);
  await wait(5000);
}

await wait(4000);

console.log("\n--- baseline ---");
const base = await record("baseline");
// ⛔ [[probe-blind-statistics]] — EVERY NUMBER BELOW READS AS A CLEAN PASS ON
// A DEAD BOOT. GI intermittently never builds (~2 boots in 9, see
// [[gi-watchdog-false-fire]]): `system` is undefined, every delta is 0, and the
// verdict prints ALL PASS having measured nothing. Refuse instead.
if (base.rebuildRuns < 1 || base.resolveW < 1) {
  console.log(
    `\nGI-RESIZE ENVIRONMENT FAILURE: GI never built (rebuildRuns=${base.rebuildRuns}, ` +
    `resolve=${base.resolveW}x${base.resolveH}, field ready=${readySeen}). ` +
    "Nothing was measured — re-run; do not read this as a pass.",
  );
  await browser.close();
  process.exit(2);
}
console.log(`  drain: settled=${base.floorDrainSettled} cycles=${base.floorDrainCycles} pending=${base.pendingMaterials} unknown=${base.unknownMaterials}`);
console.log(`  tags: giTagFlips=${base.giTagFlips} mergedRebuilds=${base.mergedRebuilds} by=${base.mergedRebuiltBy}`);

// ---- Phase A: durable steps. Each SHOULD resize; this is what one costs. ----
console.log("\n--- phase A: slow sweep (durable size changes) ---");
const fullPx = Math.max(1, base.resolveW * base.resolveH);
for (let i = 1; i <= SWEEPS; i++) {
  await setBudget(Math.round(fullPx * 0.25));
  await wait(SETTLE * 1000);
  await record(`down-${i}`);
  await setBudget(0);
  await wait(SETTLE * 1000);
  await record(`up-${i}`);
}

// ---- Phase B: a round trip inside the settle window. Must cost nothing. ----
console.log("\n--- phase B: fast round trip (must not re-mint) ---");
const beforeFast = await record("pre-fast");
for (let i = 0; i < 5; i++) {
  await setBudget(Math.round(fullPx * 0.25));
  await wait(120);
  await setBudget(0);
  await wait(120);
}
await wait(4000);
const afterFast = await record("post-fast");

// ---- Verdict ----
const dPipes = afterFast.cPipes - beforeFast.cPipes;
const dMods = afterFast.shaderModules - beforeFast.shaderModules;
const dResize = afterFast.resizeEntries - beforeFast.resizeEntries;
const slowRows = rows.filter((r) => /^(down|up)-/.test(r.label));
let worstStep = 0;
for (let i = 1; i < slowRows.length; i++) worstStep = Math.max(worstStep, slowRows[i].cPipes - slowRows[i - 1].cPipes);

const ticks = afterFast.giFrame - base.giFrame;
console.log("\nGI-RESIZE VERDICT");
console.log(`  GI ticked ${ticks} times across the whole sweep (fps ${base.fps} → ${afterFast.fps})` +
  (ticks < 40
    ? " — ⚠ HEADLESS THROTTLES THE EDITOR LOOP. Phase A is then a weak arm (a" +
      " durable resize needs two ticks a settle apart); phase B stays valid, because" +
      " WITHOUT the settle each resize WAKES the loop and the next one follows" +
      " (measured on the pre-fix tree: +276 pipelines, +555 MB, 10 resize entries)."
    : ""));
console.log(`  a DURABLE resize costs up to ${worstStep} compute pipelines (phase A, per step)`);
console.log(`  a fast round trip (5x down+up inside the settle window): ` +
  `${dPipes} pipelines, ${dMods} shader modules, ${dResize} new resolve-resize entries`);
console.log(`  compile waves started: ${waveStarts}, max concurrent: ${maxConcurrentWaves}`);
console.log(`  gi rebuild runs ${base.rebuildRuns} -> ${afterFast.rebuildRuns}, asks ${base.rebuildAsks} -> ${afterFast.rebuildAsks}`);
console.log(`  shadowMerge rebuilds ${base.mergedRebuilds} -> ${afterFast.mergedRebuilds} (last by ${afterFast.mergedRebuiltBy})`);
console.log(`  floor drain settled=${afterFast.floorDrainSettled} cycles=${afterFast.floorDrainCycles} ` +
  `pending=${afterFast.pendingMaterials} unknown=${afterFast.unknownMaterials}`);
console.log(`  heap ${base.heapMB.toFixed(0)} -> ${afterFast.heapMB.toFixed(0)} MB`);
console.log(`  rebuild log tail: ${JSON.stringify(afterFast.log.slice(-8))}`);

const fails = [];
if (dResize > 0) fails.push(`fast round trip minted ${dResize} resolve-resize rebuilds (must be 0)`);
if (dPipes > 4) fails.push(`fast round trip created ${dPipes} compute pipelines (must be ~0)`);
if (maxConcurrentWaves > 1) fails.push(`${maxConcurrentWaves} compile waves ran concurrently (must be 1)`);
console.log(fails.length ? `\nGI-RESIZE ${fails.length} FAILURES\n  - ${fails.join("\n  - ")}` : "\nGI-RESIZE ALL PASS");
await browser.close();
process.exit(fails.length ? 1 : 0);
