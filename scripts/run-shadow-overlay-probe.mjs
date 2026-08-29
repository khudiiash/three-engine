// §19 6.31 SHADOW STATIC-CACHE + DYNAMIC OVERLAY PROBE — boots a scene on the
// harness, adds a skinned character, and reads draws PER PASS with the freeze
// off (the old "a skinned mesh is present → never freeze" behaviour) and on
// (static map cached, character overlaid), parked and after a 5 m camera move.
//
//   SCENE=Bistro node scripts/run-shadow-overlay-probe.mjs http://127.0.0.1:5208/
//
// Env: SCENE · PROJECT · SETTLE seconds · OUT png (optional, one LOOKED-at shot
// after the move) · HEADED=1.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5208/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SCENE_PATH = `${PROJECT}/scenes/${SCENE}.scene`;
const SETTLE = Number(process.env.SETTLE ?? 6);
const OUT = process.env.OUT ?? "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
let firstLight = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (/shadowFreeze|overlay failed|Uncaught|DEVICE|device lost/i.test(t)) console.log(`  ${t.slice(0, 220)}`);
});
page.on("pageerror", (e) => console.log(`  PAGEERROR ${String(e).slice(0, 200)}`));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
const call = (op, params = {}) => page.evaluate(async (op, params) => {
  try { return await globalThis.__editorApi.call(op, params); }
  catch (e) { return { __error: String(e?.message ?? e) }; }
}, op, params);
const opened = await call("scene.open", { path: SCENE_PATH });
if (opened?.__error) { console.log(`FATAL scene.open: ${opened.__error}`); await browser.close(); process.exit(1); }
const t0 = Date.now();
while (!firstLight && Date.now() - t0 < 60000) await wait(250);
console.log(`first light ${firstLight ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen in 60 s"}`);

// A skinned character 4 m in front of the camera, feet on y = 0.
const cam = await call("viewport.getCamera");
const pos = cam?.position ?? [0, 2, 5];
const target = cam?.target ?? [0, 0, 0];
const dir = [target[0] - pos[0], 0, target[2] - pos[2]];
const len = Math.hypot(dir[0], dir[2]) || 1;
const feet = [pos[0] + (dir[0] / len) * 4, 0, pos[2] + (dir[2] / len) * 4];
const created = await call("character.create", { name: "ProbeCharacter", position: feet, view: "third" });
console.log(`character.create → ${created?.__error ?? JSON.stringify(created).slice(0, 120)}`);
await wait(SETTLE * 1000);

const setFreeze = (enabled) => page.evaluate(async (e) => {
  // The editor keeps its engine in a module singleton, not on a global.
  const m = await import("/src/editor/engineInstance.js");
  if (!m.engine?.shadowFreeze) return "no engine.shadowFreeze";
  m.engine.shadowFreeze.enabled = e;
  return `shadowFreeze.enabled=${e}`;
}, enabled);

const read = async (label) => {
  const fs = await call("profile.frameStats");
  const dc = await call("profile.drawCalls", { frames: 1 });
  const passes = (dc?.passes ?? []).map((p) => `${p.name ?? p.pass ?? "?"}: ${p.draws ?? p.count ?? "?"} draws / ${p.triangles ?? "?"} tris`);
  const sh = fs?.shadows ?? {};
  console.log(`\n== ${label} ==\n  fps ${fs?.fps} cpuMs ${fs?.cpuMs} gpuMs ${fs?.gpuMs} drawCalls ${fs?.drawCalls} triangles ${fs?.triangles}\n  shadows managed ${sh.managed} frozen ${sh.frozen} overlay ${sh.overlay} dynamicCasters ${sh.dynamicCasters}\n  reason: ${sh.freezeReason}\n  ${passes.join("\n  ")}`);
  if (!dc?.passes) console.log("  drawCalls keys: " + Object.keys(dc ?? {}).join(",") + " " + JSON.stringify(dc).slice(0, 600));
  return fs;
};

console.log(await setFreeze(false));
await wait(1500);
await read("BEFORE (freeze off = the old skinned-mesh behaviour), parked");
console.log(await setFreeze(true));
await wait(2500);
await read("AFTER (static cache + overlay), parked");

// Move the camera 5 m sideways, read while it settles and after.
const right = [-(dir[2] / len), 0, dir[0] / len];
const p2 = [pos[0] + right[0] * 5, pos[1], pos[2] + right[2] * 5];
const t2 = [target[0] + right[0] * 5, target[1], target[2] + right[2] * 5];
await call("viewport.setCamera", { position: p2, target: t2 });
await wait(300);
await read("AFTER, 300 ms after a 5 m move");
await wait(2500);
await read("AFTER, parked again after the move");
if (OUT) {
  const r = await call("viewport.screenshot", { width: 960, height: 640, includeGizmos: false });
  const shot = typeof r === "string" ? r : (r?.__image ?? r?.png ?? r?.dataUrl ?? r?.image ?? r?.data ?? "");
  const b64 = String(shot).replace(/^data:image\/png;base64,/, "");
  if (b64.length > 1000) { writeFileSync(OUT, Buffer.from(b64, "base64")); console.log(`shot → ${OUT}`); }
}
await browser.close();
