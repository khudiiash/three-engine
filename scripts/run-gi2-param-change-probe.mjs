// GI2 PARAM-CHANGE PROBE — flips every GI component property in turn on a live
// scene and counts WebGPU validation errors (§19 6.8: "when changing GI params,
// it crashes" — `Binding size for [Buffer] is zero` from a compute bind group).
//
//   SCENE=Cornel node scripts/run-gi2-param-change-probe.mjs http://127.0.0.1:5203/
//
// Boots the editor on the harness, opens the scene, waits for first light, then
// for each flip: resets the first-light flag, sets the prop through
// `component.setProp`, waits for `[gi2] first light` to RE-ARRIVE (or a
// timeout), and reports every console line matching a GPU validation error.
// Exit code 1 when any flip produced an error or first light never came back.
//
// Env: SCENE (bare name or path) · PROJECT · GAP seconds between flips (default
// 4) · RELIGHT seconds to wait for first light after a flip (default 45) ·
// FLIPS a comma list to override the default sequence (`quality=low,ao=false`)
// · HEADED=1.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5203/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const SCENE_PATH = SCENE.includes("/") || SCENE.includes("\\") ? SCENE.replaceAll("\\", "/") : `${PROJECT}/scenes/${SCENE}.scene`;
const GAP = Number(process.env.GAP ?? 4);
const RELIGHT = Number(process.env.RELIGHT ?? 45);
const GI_TYPE = "global-illumination";
const DEFAULT_FLIPS = [
  "quality=low", "quality=high", "quality=ultra", "quality=medium",
  "ao=false", "ao=true",
  "reflections=false", "reflections=true",
];
const FLIPS = (process.env.FLIPS ? process.env.FLIPS.split(",") : DEFAULT_FLIPS).map((s) => {
  const [key, raw] = s.split("=");
  const value = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
  return { key: key.trim(), value };
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ERROR_RE = /GPUValidationError|Binding size|zero-size storage|DEVICE LOST|device lost|Device lost/i;

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
let errors = [];
const recent = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (ERROR_RE.test(t)) errors.push(t.replace(/\s+/g, " ").slice(0, 400));
  if (/\[gi/.test(t)) { recent.push(t.slice(0, 160)); if (recent.length > 8) recent.shift(); }
});
let pageLost = null;
page.on("error", (e) => { pageLost = `renderer crashed: ${String(e?.message ?? e).slice(0, 200)}`; console.log(`  PAGE ${pageLost}`); });
page.on("framenavigated", (f) => { if (f === page.mainFrame() && gotApi) { pageLost = `page navigated to ${f.url()}`; console.log(`  PAGE ${pageLost}`); } });
let gotApi = false;
page.on("pageerror", (e) => { const t = String(e?.message ?? e); if (ERROR_RE.test(t)) errors.push(`pageerror: ${t.slice(0, 400)}`); });

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
gotApi = true;
const opened = await page.evaluate(async (path) => {
  try { return { ok: true, v: await globalThis.__editorApi.call("scene.open", { path }) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}, SCENE_PATH);
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }

const waitFirstLight = async (limitMs) => {
  const t0 = Date.now();
  while (!firstLight && Date.now() - t0 < limitMs) await wait(250);
  return firstLight ? (Date.now() - t0) / 1000 : null;
};
const boot = await waitFirstLight(120000);
console.log(`scene ${SCENE}: first light ${boot === null ? "NOT seen in 120 s" : `after ${boot.toFixed(1)} s`}; boot errors ${errors.length}`);
for (const e of errors) console.log(`  BOOT ERROR: ${e}`);
const bootErrors = errors.length;
errors = [];

// Find the GI entity + its current props.
const gi = await page.evaluate(async (type) => {
  const list = await globalThis.__editorApi.call("entity.list", {});
  for (const ent of list) {
    const comps = Array.isArray(ent.components) ? ent.components : Object.values(ent.components ?? {});
    const hit = comps.find((c) => c?.type === type) ?? (ent.components && !Array.isArray(ent.components) && ent.components[type] ? { type, ...ent.components[type] } : null);
    if (hit) return { id: ent.id, name: ent.name, props: hit.props ?? hit };
  }
  return null;
}, GI_TYPE);
if (!gi) { console.log(`FATAL: no entity carries a "${GI_TYPE}" component`); await browser.close(); process.exit(1); }
console.log(`GI entity "${gi.name}" (${gi.id}); props ${JSON.stringify(gi.props).slice(0, 160)}`);

await wait(GAP * 1000);
const results = [];
const current = { ...gi.props };
for (const flip of FLIPS) {
  firstLight = false;
  errors = [];
  // A flip to the value the component already holds is not a change: no
  // structural signature moves, no rebuild runs, no first light re-arrives
  // (Bistro authors `ao:false, reflections:false`). Report it as a no-op
  // rather than as a dark field.
  if (current[flip.key] === flip.value) {
    console.log(`  ${flip.key}=${String(flip.value).padEnd(6)} no-op (already ${JSON.stringify(flip.value)})`);
    results.push({ ...flip, noop: true, errors: 0 });
    continue;
  }
  const set = await page.evaluate(async (id, type, key, value) => {
    try { await globalThis.__editorApi.call("component.setProp", { id, type, key, value }); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  }, gi.id, GI_TYPE, flip.key, flip.value);
  current[flip.key] = flip.value;
  if (!set.ok) {
    console.log(`  ${flip.key}=${flip.value}: setProp FAILED: ${set.error}${pageLost ? ` (${pageLost})` : ""}`);
    results.push({ ...flip, refused: true, errors: 0 });
    continue;
  }
  const relight = await waitFirstLight(RELIGHT * 1000);
  await wait(GAP * 1000);
  const n = errors.length;
  results.push({ ...flip, errors: n, relight });
  console.log(`  ${flip.key}=${String(flip.value).padEnd(6)} errors ${String(n).padStart(3)}  first light ${relight === null ? "NOT back" : `back after ${relight.toFixed(1)} s`}`);
  for (const e of [...new Set(errors)].slice(0, 3)) console.log(`      ${e.slice(0, 300)}`);
  if (relight === null) console.log("      last [gi lines: " + recent.slice(-3).join(" | "));
}

const totalErrors = results.reduce((s, r) => s + (r.errors ?? 0), 0);
const dark = results.filter((r) => !r.refused && !r.noop && r.relight === null).length;
const refused = results.filter((r) => r.refused).length;
const culprits = results.filter((r) => r.errors > 0).map((r) => `${r.key}=${r.value}`);
console.log(`\nSUMMARY ${SCENE}: boot errors ${bootErrors}; ${results.length} flips; validation errors ${totalErrors}${culprits.length ? ` (first at ${culprits[0]}; flips with errors: ${culprits.join(", ")})` : ""}; first light missing after ${dark} flips; setProp failed ${refused}${pageLost ? `; ${pageLost}` : ""}`);
const pass = totalErrors === 0 && dark === 0 && bootErrors === 0 && refused === 0 && !pageLost;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
