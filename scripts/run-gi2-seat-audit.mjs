// §19 6.35 — THE EMITTER SEAT AUDIT (Bistro).
//
// Boots Bistro at the street pose, settles, and dumps every analytic emitter
// seat WITH ITS SOURCE LEDGER (`_emitterSeatMeta`: mesh name, world position,
// bounding-sphere radius, raw emissive, fill), plus the GI sky term next to the
// scene's environment. The receipt answers: which seat is a giant sphere over a
// string of bulbs, and is the sky term grey under a coloured sky.
//
//   node scripts/run-gi2-seat-audit.mjs          # URL defaults to 5207
//
// Env: PROJECT · SCENE=Bistro · SETTLE=20 · URL
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.env.URL ?? process.argv[2] ?? "http://127.0.0.1:5207/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 20);
const PINS = JSON.parse(await (await import("node:fs")).promises.readFile(
  new URL("./gi2-ref-pins.json", import.meta.url), "utf8"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--js-flags=--expose-gc --max-old-space-size=8192",
  ],
});
const page = await browser.newPage();
page.setDefaultTimeout(300000);
await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
page.on("pageerror", (e) => {
  const s = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(s)) console.log(`    pageerror: ${s.slice(0, 200)}`);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 120000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__giEngineForProbe = mod.engine;
  globalThis.__giSys = () => mod.engine?.modules?.get?.("gi")?.system ?? null;
  globalThis.__gi2 = () => {
    const sys = globalThis.__giSys();
    return sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null;
  };
});
const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });

const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
console.log(`══ ${SCENE} — seat audit: settling ${SETTLE}s ═══════════════`);

// Wait for the GI2 gather to exist, then the settle window.
const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  const has = await page.evaluate(() => !!globalThis.__gi2()?.gather);
  if (has) break;
  await wait(1000);
}
await wait(SETTLE * 1000);

const fs = await call("profile.frameStats");
const seats = fs?.value?.giEmitterSeats ?? null;
const sky = fs?.value?.giSkyTerm ?? null;
console.log("\n── SEATS (slot · rgb · green · radius · reff · source mesh) ──");
for (const s of seats ?? []) {
  console.log(
    `  slot ${s.slot}: rgb [${s.rgb}] green x${s.green} radius ${s.radius} reff ${s.reff}` +
    ` ← ${s.name ?? "?"} pos [${(s.pos ?? []).join(", ")}] bsR ${s.bsRadius}` +
    ` emissive [${(s.emissive ?? []).join(", ")}] fill ${s.fill}`
  );
}
console.log(`\n── SKY TERM ──\n  ${JSON.stringify(sky)}`);

// What the readback surface exposes (for the awning-tint follow-up).
const gi2keys = await page.evaluate(() => {
  const g = globalThis.__gi2();
  return { gi2: Object.keys(g ?? {}), gather: Object.keys(g?.gather ?? {}) };
});
console.log(`\n── __gi2 keys ──\n  ${JSON.stringify(gi2keys)}`);

// Street pose PNGs: lit, then the indirect debug view.
const pose = PINS?.a?.pose;
if (pose) {
  await call("viewport.setCamera", { position: pose.position, target: pose.target });
  await wait(4000);
  await page.screenshot({ path: "scripts/gi2-seat-audit-lit.png" });
  await page.evaluate(() => { globalThis.__giDebugView = "indirect"; });
  await wait(4000);
  await page.screenshot({ path: "scripts/gi2-seat-audit-indirect.png" });
  await page.evaluate(() => { globalThis.__giDebugView = "off"; });
  console.log("\n  PNGs: scripts/gi2-seat-audit-{lit,indirect}.png");
}

writeFileSync("scripts/gi2-seat-audit.json", JSON.stringify({ seats, sky, gi2keys }, null, 2));
console.log("  JSON: scripts/gi2-seat-audit.json");
await browser.close();
