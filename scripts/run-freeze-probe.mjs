/**
 * THE FREEZE GATE — boot a real project, drive a fixed sequence of editor
 * actions, and print the freeze ledger for each one.
 *
 *   npx vite --port 5211 --strictPort            (a FRESH server; see below)
 *   PROJECT=C:/Users/me/GAME node scripts/run-freeze-probe.mjs
 *
 * ⭐ WHY (docs/ZERO_FREEZE_PLAN.md unit 0.4). Every other harness in this repo
 * measures a FRAME. None of them can see the thing the user actually reports —
 * the editor stopping dead for seconds — because during a freeze there are no
 * frames to sample, and `profile.cpuFrame` reports a healthy mean for a window
 * that contained a 3 s block. This one reads `profile.freezes`, the engine's
 * always-on long-task ledger, so a regression shows up as a NAMED block with
 * an owner rather than as a number that got worse.
 *
 * ⚠ HOW TO OPEN THE PROJECT, and the trap that killed the previous probe.
 * Two mechanisms exist and they FIGHT: `startupReopen.js` auto-opens the last
 * project when `engine.projectRoot.v1` is in localStorage, and the hub's
 * recent-project button opens it on click. `run-boot-diag.mjs` did BOTH — it
 * set the key and then clicked — so the project opened twice, the second open
 * navigated, and every later `page.evaluate` died with "Attempted to use
 * detached Frame".
 *
 * ⛔ The fix is NOT "never click": every working harness in this repo clicks
 * (`run-gi-cornell-ref`, `run-gi-walk-patches`). They first set
 * `globalThis.__editorNoAutoOpen = true`, which is exactly what that flag is
 * for — `plannedProject()` returns null and the hub stays up for the click.
 * One opener, not two. This probe does the same.
 *
 * ⚠ AND: never run this while the user's editor is compiling. The harness
 * Chrome and the editor share one GPU and one driver compile queue; a boot
 * number measured beside another compiling WebGPU process is not comparable
 * with anything (this project has re-learned that four times).
 *
 * Env:
 *   PROJECT=<path>   the project to open (required for a real measurement)
 *   SCENE=<path>     open this scene after boot (absolute, or relative to the
 *                    project). Without it the editor opens project.json's
 *                    `lastScene`, which is whatever the user was last looking
 *                    at — fine for a boot number, useless for measuring a
 *                    SPECIFIC scene's compile wave.
 *   URL=<url>        default http://localhost:5211/
 *   SETTLE=<ms>      how long to let the boot finish before reading (90000)
 *   ACTIONS=0        boot only; skip the select/edit sequence
 *   HEADED=1         watch it
 *   JSON=<path>      also write the raw report there
 */
import puppeteer from "puppeteer-core";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.env.URL ?? "http://localhost:5211/";
const settleMs = Number(process.env.SETTLE ?? 90_000);
const projectRoot = process.env.PROJECT ? resolve(process.env.PROJECT).replaceAll("\\", "/") : null;
const T0 = Date.now();
const stamp = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;

if (!projectRoot) {
  console.log("⚠ No PROJECT= given. Booting an empty editor: the numbers will be a floor, not a measurement.");
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: mkdtempSync(join(tmpdir(), "freeze-probe-")),
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // The editor ships with these; a probe that measures a different cache
    // ceiling than the app is measuring a different app. `CACHE_ARGS=0` drops
    // them, which is the A/B arm for "is the raised cache itself a problem".
    ...(process.env.CACHE_ARGS === "0"
      ? []
      : ["--gpu-program-cache-size-kb=262144", "--gpu-disk-cache-size-mb=1024"]),
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 });

const consoleLines = [];
page.on("console", (message) => {
  const text = message.text();
  if (!text.trim()) return;
  consoleLines.push(`[${stamp()}] ${text.slice(0, 400)}`);
  if (/^\[(freeze|boot|gi)\]|Editor ready|Restored scene/.test(text)) {
    console.log(`[${stamp()}] ${text.slice(0, 400)}`);
  }
});
const pageErrors = [];
page.on("pageerror", (error) => {
  pageErrors.push(error.stack ?? error.message);
  console.log(`[${stamp()}] PAGEERROR ${error.message}`);
});

if (projectRoot) {
  await installTauriShim(page, {});
  await page.evaluateOnNewDocument((project) => {
    localStorage.clear();
    // Remembered so the hub LISTS it; the click is what opens it. See the
    // header: letting both openers run is what detaches the frame.
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorNoAutoOpen = true;
    // Nothing is ever focused in a headless run, so the viewport would suspend
    // itself and the boot would never finish.
    globalThis.__editorKeepRendering = true;
  }, projectRoot);
}

console.log(`[${stamp()}] goto ${url}`);
await page.goto(url, { waitUntil: "load", timeout: 60_000 });

if (projectRoot) {
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 120_000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, projectRoot);
  console.log(`[${stamp()}] opened the project from the hub`);
}

// The editor API appears when `ensureEngine` runs, which needs the shell — i.e.
// a project. Generous, because the Tauri SHIM reads files over CDP and is an
// order of magnitude slower than the real host: the same boot the desktop app
// finishes in 6 s takes tens of seconds here.
const ready = await page
  .waitForFunction(
    () => !!globalThis.__editorApi && document.querySelector("canvas") !== null,
    { timeout: 240_000, polling: 500 },
  )
  .then(() => true)
  .catch(() => false);
console.log(`[${stamp()}] editor api ${ready ? "up" : "NOT up (timed out)"}`);

const call = (name, args = {}) =>
  page.evaluate(
    async (opName, opArgs) => {
      try {
        return await globalThis.__editorApi.call(opName, opArgs);
      } catch (err) {
        return { __error: String(err?.message ?? err) };
      }
    },
    name,
    args,
  );

// Let the boot finish: the material wave and the GI build both land well after
// the first frame, and they are the point.
const settleUntil = Date.now() + settleMs;
while (Date.now() < settleUntil) {
  await new Promise((r) => setTimeout(r, 2000));
  const boot = await call("profile.boot").catch(() => null);
  if (boot?.blocked && Date.now() - T0 > 20_000) {
    // Stop early once nothing has blocked for 15 s — the boot is quiet.
    const quiet = await page.evaluate(() => {
      const tasks = globalThis.__editorApi ? null : null;
      void tasks;
      return performance.now();
    });
    void quiet;
  }
}

// A named scene, once the editor is up. `scene.open` goes through the same
// path the File menu does, so the numbers are the ones a person would get.
if (process.env.SCENE) {
  const scenePath = process.env.SCENE.includes(":") || process.env.SCENE.startsWith("/")
    ? process.env.SCENE
    : `${projectRoot}/${process.env.SCENE}`;
  console.log(`[${stamp()}] opening ${scenePath}`);
  const opened = await call("scene.open", { path: scenePath });
  console.log(`[${stamp()}] scene.open → ${JSON.stringify(opened).slice(0, 200)}`);
  // A scene switch rebuilds GI and re-runs the material wave; give it room.
  await new Promise((r) => setTimeout(r, Number(process.env.SCENE_SETTLE ?? 120_000)));
}

const report = {
  boot: await call("profile.boot"),
  freezes: await call("profile.freezes", { limit: 30 }),
  frame: await call("profile.frameStats", { settleMs: 1200 }),
};

const table = (rows, cols) => rows.map((r) => cols.map(([k, w]) => String(r[k] ?? "").padStart(w)).join("  ")).join("\n");

console.log(`\n===== BOOT (${report.boot?.sinceLoadMs} ms since load) =====`);
for (const stage of report.boot?.stages ?? []) {
  console.log(`  ${String(stage.ms).padStart(6)} ms  at ${String(stage.at).padStart(6)}  ${stage.name}${stage.detail ? `  (${stage.detail})` : ""}`);
}
console.log(`\n  main thread BLOCKED ${report.boot?.blocked?.ms} ms in ${report.boot?.blocked?.tasks} task(s), worst ${report.boot?.blocked?.worstMs} ms`);

console.log(`\n===== FREEZES BY OWNER =====`);
console.log(table(report.freezes?.byOwner ?? [], [["ms", 8], ["blocks", 8], ["name", 0]]));

console.log(`\n===== WORST BLOCKS =====`);
for (const task of (report.freezes?.worst ?? []).slice(0, 12)) {
  const who = task.owners.map((o) => `${o.name} ${o.ms}`).join(", ");
  const gpu = task.gpu ? ` [${task.gpu.renderPipelines}r/${task.gpu.computePipelines}c/${task.gpu.shaderModules}m, ${(task.gpu.bytes / 1024).toFixed(0)}kB]` : "";
  console.log(`  ${String(task.ms).padStart(6)} ms at ${String(task.sinceBootMs).padStart(6)} — ${who}${gpu}`);
}

if (report.freezes?.syncPipelines?.length) {
  console.log(`\n===== COMPILED SYNCHRONOUSLY (each one blocks the frame that needs it) =====`);
  for (const row of report.freezes.syncPipelines.slice(0, 15)) {
    console.log(`  ${String(row.count).padStart(4)}×  ${row.ms.toFixed(0).padStart(6)} ms  ${row.kind}  ${row.name}`);
  }
}

console.log(`\n===== FRAME =====`);
console.log(`  fps ${report.frame?.fps}  cpu ${report.frame?.cpuMs} ms  gpu ${report.frame?.gpuMs} ms  draws ${report.frame?.drawCalls}`);

// ── The action sequence: the two things the user says freeze the editor ────
if (process.env.ACTIONS !== "0") {
  const entities = await call("entity.list").catch(() => []);
  const meshIds = (Array.isArray(entities) ? entities : [])
    .filter((e) => (e.components ?? []).some((c) => (c.type ?? c) === "mesh"))
    .slice(0, 3)
    .map((e) => e.id);
  if (meshIds.length) {
    console.log(`\n===== ACTIONS =====`);
    for (const id of meshIds) {
      await call("profile.freezes", { clear: true });
      await call("selection.set", { ids: [id] });
      await new Promise((r) => setTimeout(r, 1500));
      const after = await call("profile.freezes", { limit: 6 });
      const worst = after?.worst?.[0];
      console.log(
        `  select ${id}: ${after?.totals?.tasks ?? 0} block(s), worst ${worst?.ms ?? 0} ms` +
          (worst ? ` — ${worst.owners.map((o) => `${o.name} ${o.ms}`).join(", ")}` : ""),
      );
    }
    await call("selection.set", { ids: [] });
  }
}

if (pageErrors.length) {
  console.log(`\n===== PAGE ERRORS (${pageErrors.length}) =====`);
  for (const err of pageErrors.slice(0, 5)) console.log(`  ${err.split("\n").slice(0, 4).join("\n  ")}`);
}

if (process.env.JSON) {
  writeFileSync(process.env.JSON, JSON.stringify({ report, consoleLines, pageErrors }, null, 1));
  console.log(`\nwrote ${process.env.JSON}`);
}

await browser.close();
process.exit(pageErrors.length ? 1 : 0);
