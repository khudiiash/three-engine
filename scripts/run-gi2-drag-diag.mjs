// throwaway diagnostic for the §19 6.5 drag probe: what is actually in the scene
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
const url = (process.argv[2] ?? "http://127.0.0.1:5210/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
page.on("console", (m) => { const t = m.text(); if (/\[gi2?\]/.test(t)) console.log("   ", t.slice(0, 160)); });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  (rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0])?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
await page.evaluate(async () => { const m = await import("/src/editor/engineInstance.js"); globalThis.__eng = m.engine; });
await page.evaluate(async ({ p, s }) => globalThis.__editorApi.call("scene.open", { path: `${p}/scenes/${s}.scene` }), { p: PROJECT, s: SCENE });
await wait(25000);
console.log(JSON.stringify(await page.evaluate(() => {
  const eng = globalThis.__eng;
  const sys = eng?.modules?.get?.("gi")?.system;
  const out = { gi2Path: globalThis.GI2_PATH, hasSys: !!sys, rebuilds: sys?.rebuilds, gi2: !!(sys?._gi2 ?? sys?.state?.screen?.gi2), entities: [] };
  for (const [id, e] of eng.entities ?? []) {
    let lum = 0, mats = 0;
    e.object3D?.traverse?.((o) => {
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) { mats++; const c = m?.emissive; if (c) lum = Math.max(lum, (c.r + c.g + c.b) / 3 * (m.emissiveIntensity ?? 1)); }
    });
    out.entities.push({ id, name: e.name, mats, lum: +lum.toFixed(3) });
  }
  return out;
}), null, 1));
await browser.close();
