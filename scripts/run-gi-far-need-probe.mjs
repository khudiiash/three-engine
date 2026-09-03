// THE FAR-NEED PROBE (§11.13) — what do the far bins' COUNTS actually hold?
//
//   npx vite --config vite.base.config.mjs --port 5201   (in another terminal)
//   node scripts/run-gi-far-need-probe.mjs
//   PROJECT=C:/path/to/project SETTLE=90000 node scripts/run-gi-far-need-probe.mjs
//
// The far duty's NEED FLOOR forces a ray's far intervals when the far bins in
// its direction hold fewer than `farNeed` rays of decayed count. On the live
// Bistro the floor kept forcing ~32 % of all rays at rest, at `farNeed = 1`,
// which the count model (steady count ≈ 440·rate at the compensated far keep)
// says is impossible for a third of the ray mass. This rig reads the bins
// back and histograms the counts per cascade, so the argument is settled by
// the words themselves: are the needy bins EMPTY (never sampled — direction
// coverage), DECAYED (sampled but forgotten — the decay), or is the read
// looking at the wrong words?
//
// Read-only against the user's real project, like the density probe.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SETTLE = Number(process.env.SETTLE ?? 90000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The street overview every §11 receipt was read at.
const POSE = {
  position: [-3.992247479683467, 8.21160109544345, -8.56766189652123],
  target: [25.345291550621535, 9.694627946485872, -32.44857854553187],
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await installTauriShim(page, {});

let built = false;
let bootLine = "";
const farLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  if (/\[gi\] src probes:/.test(t) && !bootLine) bootLine = t;
  if (/far duty/.test(t)) farLines.push(t);
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene|refusing write/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
});

await page.evaluateOnNewDocument((project, quality) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  if (quality) globalThis.__giConfigOverride = { quality };
}, PROJECT, process.env.QUALITY ?? "ultra");

console.log(`opening ${PROJECT} (read-only)`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);

// ⚠ BOOT FIRST, THEN WAIT (the walk probe's lesson): in the harness the engine
// is created by `ensureEngine()`, and a node-side wait for GI's console markers
// placed before it waits forever for a module nothing has started.
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
const SCENE = process.env.SCENE ?? `${PROJECT}/scenes/Bistro.scene`;
await page.evaluate(async (scene) => {
  const end = performance.now() + 180_000;
  for (;;) {
    try { return await globalThis.__editorApi.call("scene.open", { path: scene }); }
    catch (e) { if (performance.now() > end) throw e; await new Promise((r) => setTimeout(r, 500)); }
  }
}, SCENE);
const booted = await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  if (!engine) return "no engine";
  const end = performance.now() + 240_000;
  for (;;) {
    if (engine.modules?.get?.("gi")?.system?.state?.screen?.srcProbes) return "gi system up";
    if (performance.now() > end) return "gi never ready";
    await new Promise((r) => setTimeout(r, 500));
  }
});
console.log(`boot: ${booted}`);
if (booted !== "gi system up") throw new Error(booted);
for (let i = 0; i < 120 && !built; i++) await wait(1000);
console.log(`built ${built}. ${bootLine.slice(0, 160)}`);
for (const l of farLines) console.log(`  ${l.slice(0, 200)}`);

await page.evaluate(async (p) => {
  await globalThis.__editorApi.call("viewport.setCamera", p);
}, POSE);
console.log(`settling ${(SETTLE / 1000).toFixed(0)}s at the street overview…`);
await wait(SETTLE);

const report = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const ids = await api.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const engine = api.entities.live(anyId)?.engine;
  const sys = engine.modules?.get?.("gi")?.system;
  const src = sys?.state?.screen?.srcProbes;
  if (!src?.store || !src?.binStore) return { error: "no live SRC probe store" };
  const D = await import("/src/modules/gi/srcDeposit.js");
  const P = await import("/src/modules/gi/srcProbes.js");
  const store = src.store;
  const binStore = src.binStore;
  const stats = await src.readStats(engine.renderer);
  const table = new Uint32Array(await engine.renderer.getArrayBufferAsync(store.probeTable.value));
  const scratch = new Uint32Array(await engine.renderer.getArrayBufferAsync(binStore.scratch.value));
  const SCALE = D.DEPOSIT_SCALE;
  const out = { cascades: [], rays: stats.rays, keep: globalThis.__giSrcKeepLive, alpha: globalThis.__giSrcAlphaLive, duty: globalThis.__giSrcFarDutyLive };
  for (let c = 0; c < store.cascades.length; c++) {
    const pc = store.cascades[c];
    const info = binStore.cascades.find((b) => b.cascade === c);
    if (!info) continue;
    const hist = { zero: 0, below1: 0, one4: 0, four16: 0, above16: 0, total: 0, probes: 0 };
    let sumRays = 0;
    let sampledSum = 0;
    for (let k = 0; k < pc.probeCapacity; k++) {
      const w = (pc.probeBase + k) * P.PROBE_WORDS;
      if ((table[w + P.PROBE_FLAGS] & P.FLAG_ALIVE) === 0) continue;
      const block = table[w + P.PROBE_BLOCK] >>> 0;
      if (block === P.SLOT_EMPTY) continue;
      hist.probes++;
      const base = (info.binBase + block * info.bins) * D.BIN_WORDS;
      for (let m = 0; m < info.bins; m++) {
        const cnt = scratch[base + m * D.BIN_WORDS + D.BIN_COUNT] >>> 0;
        const r = cnt / SCALE;
        hist.total++;
        sumRays += r;
        if (cnt === 0) hist.zero++;
        else {
          sampledSum += r;
          if (r < 1) hist.below1++;
          else if (r < 4) hist.one4++;
          else if (r < 16) hist.four16++;
          else hist.above16++;
        }
      }
    }
    const sampled = hist.total - hist.zero;
    out.cascades.push({
      cascade: c, probes: hist.probes, bins: hist.total,
      zeroPct: +(100 * hist.zero / Math.max(1, hist.total)).toFixed(1),
      below1Pct: +(100 * hist.below1 / Math.max(1, hist.total)).toFixed(1),
      one4Pct: +(100 * hist.one4 / Math.max(1, hist.total)).toFixed(1),
      four16Pct: +(100 * hist.four16 / Math.max(1, hist.total)).toFixed(1),
      above16Pct: +(100 * hist.above16 / Math.max(1, hist.total)).toFixed(1),
      meanRaysAll: +(sumRays / Math.max(1, hist.total)).toFixed(3),
      meanRaysSampled: +(sampledSum / Math.max(1, sampled)).toFixed(3),
    });
  }
  return out;
});

if (report.error) {
  console.log(`FAIL — ${report.error}`);
} else {
  console.log(`keep ${report.keep?.toFixed?.(5)}  alpha ${report.alpha?.toFixed?.(4)}  duty ${report.duty?.toFixed?.(3)}  ` +
    `rays ${report.rays?.rays}  far ${(100 * (report.rays?.farRate ?? 0)).toFixed(1)}%  forced ${(100 * (report.rays?.farNeedRate ?? 0)).toFixed(1)}%`);
  console.log("cascade  probes   bins      =0     <1     1-4    4-16   >16   mean(all)  mean(sampled)");
  for (const c of report.cascades) {
    console.log(`  c${c.cascade}     ${String(c.probes).padStart(6)} ${String(c.bins).padStart(8)}  ` +
      `${String(c.zeroPct).padStart(5)}% ${String(c.below1Pct).padStart(5)}% ${String(c.one4Pct).padStart(5)}% ` +
      `${String(c.four16Pct).padStart(5)}% ${String(c.above16Pct).padStart(5)}%   ${String(c.meanRaysAll).padStart(8)}   ${String(c.meanRaysSampled).padStart(8)}`);
  }
}
await browser.close();
