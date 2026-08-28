// GI2 BOOT STAGE TABLE — §19 Stage 6.3 (plan §4.3, audits §R)
//
// WHAT IT ANSWERS
//
// `probe:gi2-boot` gates first light against a budget; it says the Bistro boot
// took 17 s and cannot say WHERE. This one prints the LEDGER: every boot stage
// as ms since `engine.sceneOpenAt`, so the two largest gaps are read off the
// table instead of argued from console-line order (which has no clock).
//
// It also prints two things a stage table alone cannot carry:
//
//   · THE ARRIVAL RAMP. The user rule is that light arrives in a natural
//     gradient — no pop from black to lit, no cascade landing as a step. That
//     is a claim about dE/dt, so the receipt is the SERIES: per-sample
//     |ΔE|/E over the ramp window, p90 and the monotone fraction.
//     `__gi2RampProbe` holds GI2's stats cadence at 1 across that window;
//     without it the series is two points and would flatter any ramp.
//
//   · THE FRAME-TIME SPIKE AT FIRST LIGHT. A boot that gets fast by moving
//     work into one 300 ms frame has not got faster. rAF deltas are recorded
//     page-side for the whole boot and the worst is printed with its offset
//     from first light.
//
// Usage:
//   node node_modules/vite/bin/vite.js -c vite.cut.config.mjs --port 5204 --strictPort --host 127.0.0.1
//   node scripts/run-gi2-stage-probe.mjs http://127.0.0.1:5204/
//
// Env: PROJECT, SCENE (default Bistro), URL, WAIT_MS, BOOTS (default 1), FLAGS
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? process.env.URL ?? "http://127.0.0.1:5204/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const WAIT_MS = Number(process.env.WAIT_MS ?? 40000);
const BOOTS = Number(process.env.BOOTS ?? 1);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The table's row order — the boot's causal order, not the ledger's insertion order. */
const ORDER = [
  ["giTick", "first GI tick"],
  ["assetsReady", "scene assets ready"],
  ["geometryReady", "geometry-ready gate"],
  ["gi2Build", "GI2 build start"],
  ["soupReady", "soup ready (off-thread)"],
  ["voxelizerLive", "voxelizer live"],
  ["compileWaveStart", "compile wave start"],
  ["gatherAsked", "gather chain asked"],
  ["gatherRan", "gather chain SUBMITTED WHOLE"],
  ["firstOccupancy", "first occupancy"],
  ["rcFirstDeposit", "RC first deposit (rays > 0)"],
  ["rcFirstHit", "RC first hit"],
  ["rcFirstMerge", "RC first merge"],
  ["rcFirstBake", "RC first bake"],
  ["rcFirstLitTile", "RC first LIT tile"],
  ["firstLight", "FIRST LIGHT"],
  ["compileWaveEnd", "compile wave end (materials warm)"],
];

function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

async function boot(n) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
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
  await page.evaluateOnNewDocument((project) => {
    globalThis.__editorKeepRendering = true;
    globalThis.__gi2RampProbe = true;
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    // Frame deltas for the whole boot, page-side: a boot that "got faster" by
    // folding its work into one 300 ms frame has not got faster.
    globalThis.__frameLog = [];
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      if (globalThis.__frameLog.length < 20000) globalThis.__frameLog.push([Math.round(now), +(now - last).toFixed(1)]);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, PROJECT);
  await page.evaluateOnNewDocument((flags) => {
    for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
  }, JSON.parse(process.env.FLAGS ?? "{}"));

  const lines = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi2\] first light|\[gi\] compile wave:|\[gi\] scene assets ready|\[gi2\] soup |transport never produced/.test(t)) {
      lines.push(t);
    }
  });
  page.on("pageerror", (e) => console.log(`    pageerror: ${(e.stack ?? e.message ?? String(e)).slice(0, 200)}`));

  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

  const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args }).catch((err) => ({ ok: false, error: err?.message ?? String(err) }));

  await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });

  // Poll rather than sleep the whole window: a boot that lights at 4 s should
  // not cost 40 s of wall clock, and the ramp needs ~2.5 s past first light.
  const deadline = Date.now() + WAIT_MS;
  let lit = false;
  while (Date.now() < deadline) {
    lit = await page.evaluate(() => globalThis.__gi2Stage?.marks?.firstLight != null).catch(() => false);
    if (lit) break;
    await wait(250);
  }
  await wait(3000);

  const out = await page.evaluate(() => ({
    stage: globalThis.__gi2Stage ?? null,
    ramp: globalThis.__gi2Ramp ?? [],
    frames: globalThis.__frameLog ?? [],
  }));
  await browser.close();
  return { ...out, lines, boot: n };
}

const runs = [];
for (let i = 1; i <= BOOTS; i++) {
  console.log(`\n${"═".repeat(72)}\n  ${SCENE} — boot ${i}/${BOOTS}\n${"═".repeat(72)}`);
  const r = await boot(i);
  runs.push(r);

  const marks = r.stage?.marks ?? {};
  console.log(`\n  STAGE TABLE (ms from scene open)`);
  console.log(`  ${"stage".padEnd(36)} ${"at".padStart(7)} ${"Δ".padStart(7)}`);
  let prev = 0;
  for (const [key, label] of ORDER) {
    const at = marks[key];
    if (at == null) { console.log(`  ${label.padEnd(36)} ${"—".padStart(7)}`); continue; }
    console.log(`  ${label.padEnd(36)} ${String(at).padStart(7)} ${String(at - prev).padStart(7)}`);
    prev = at;
  }

  // The two largest gaps, named. This is the whole point of the table.
  const present = ORDER.filter(([k]) => marks[k] != null).map(([k, l]) => ({ k, l, at: marks[k] }));
  const gaps = present.slice(1).map((row, i) => ({ from: present[i].l, to: row.l, ms: row.at - present[i].at }))
    .sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.log(`\n  LARGEST GAPS:`);
  for (const g of gaps) console.log(`    ${String(g.ms).padStart(6)} ms  ${g.from} → ${g.to}`);

  // ── the arrival ramp ──────────────────────────────────────────────────────
  const ramp = r.ramp.filter((s) => s.meanLum > 0);
  if (ramp.length >= 3) {
    const d = [];
    let mono = 0;
    for (let i = 1; i < ramp.length; i++) {
      const e0 = ramp[i - 1].meanLum, e1 = ramp[i].meanLum;
      const rel = e1 > 0 ? Math.abs(e1 - e0) / Math.max(e0, e1) : 0;
      d.push(rel);
      if (e1 >= e0 - 1e-9) mono++;
    }
    console.log(`\n  ARRIVAL RAMP — ${ramp.length} samples over ${ramp.at(-1).t} ms`);
    console.log(`    |ΔE|/E  p50 ${(100 * percentile(d, 0.5)).toFixed(1)}%  ` +
      `p90 ${(100 * percentile(d, 0.9)).toFixed(1)}%  max ${(100 * Math.max(...d)).toFixed(1)}%`);
    console.log(`    monotone rising: ${mono}/${d.length} steps (${(100 * mono / d.length).toFixed(0)}%)`);
    console.log(`    E: ${ramp[0].meanLum.toFixed(4)} → ${ramp.at(-1).meanLum.toFixed(4)}`);
  } else {
    console.log(`\n  ARRIVAL RAMP — only ${r.ramp.length} sample(s); ramp not measurable`);
  }

  // ── the frame-time spike ──────────────────────────────────────────────────
  const fl = marks.firstLight, open = r.stage?.openAt;
  if (fl != null && r.frames.length) {
    const flAbs = open + fl;
    const near = r.frames.filter(([t]) => t >= flAbs - 1500 && t <= flAbs + 1500);
    const worst = near.sort((a, b) => b[1] - a[1])[0];
    const worstAll = [...r.frames].sort((a, b) => b[1] - a[1])[0];
    console.log(`\n  FRAME TIME`);
    console.log(`    worst within ±1.5 s of first light: ${worst ? `${worst[1]} ms (${Math.round(worst[0] - flAbs)} ms from first light)` : "n/a"}`);
    console.log(`    worst of the whole boot:            ${worstAll[1]} ms`);
    console.log(`    frames > 50 ms near first light:    ${near.filter(([, dt]) => dt > 50).length}`);
  }
  for (const l of r.lines) console.log(`    · ${l.slice(0, 160)}`);
}

const fls = runs.map((r) => r.stage?.marks?.firstLight).filter((x) => x != null);
console.log(`\n${"═".repeat(72)}`);
console.log(`  ${SCENE}: first light from scene open = ${fls.join(", ")} ms over ${BOOTS} boot(s)`);
console.log(`${"═".repeat(72)}\n`);
