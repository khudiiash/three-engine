// THE 30-SECOND CACHE CHECK for the selection outline. Empty scene, one box,
// parked camera; reports hits/renders and the miss histogram BY REASON.
//
// Why it exists beside `probe:outline-root`: that probe needs Bistro, and
// Bistro needs four to ten minutes to reach first light and settle its merge.
// When the question is only "does the frame cache engage at all", paying that
// to find out is how a two-line bug costs an afternoon — this answered
// "the cache refused because ONE skinned mesh was in the selection" in half
// a minute after the Bistro run had spent ten proving only that it did not.
//
// A clean run is `hits N / renders 0 / audits 0` with the camera reporting 0 of
// 32 matrix elements moved. Any `renders` on a parked empty scene is a bug in
// the cache; `camera:` misses there mean the viewport camera is not still.
//
//   node scripts/_outline-cache-diag.mjs http://127.0.0.1:5202/
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.log(`  pageerror: ${(e.stack ?? e.message).slice(0, 200)}`));
await page.evaluateOnNewDocument(() => {
  globalThis.__editorKeepRendering = true;
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const seen = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ seen.find((n) => n.includes("?")) ?? seen[0] ?? p);
  };
});
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await page.waitForFunction(() => !!globalThis.__viewport?.orbit, { timeout: 60000 });
await wait(4000);

const built = await page.evaluate(async () => {
  const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  const outline = await globalThis.__importLive("/src/editor/selectionOutline.js");
  globalThis.__d = { engine, sel: useSelectionStore, outline };
  const e = engine.createEntity({ name: "DiagBox" });
  e.addComponent("mesh", { geometry: "box" });
  e.object3D.position.set(0, 0, 0);
  e.object3D.scale.setScalar(3);
  e.object3D.updateMatrixWorld(true);
  globalThis.__viewport.camera.position.set(0, 0, 11);
  globalThis.__viewport.orbit.target.set(0, 0, 0);
  globalThis.__viewport.orbit.update();
  return e.id;
});
await page.evaluate((id) => {
  globalThis.__d.sel.getState().select(id);
  globalThis.__d.engine.viewportOverlayNode; // touch, no-op
}, built);
await wait(2500);

const before = await page.evaluate(() => globalThis.__d.outline.selectionOutlineStats());
await wait(3000);
const after = await page.evaluate(() => globalThis.__d.outline.selectionOutlineStats());
const delta = (k) => (after[k] ?? 0) - (before[k] ?? 0);
const dm = {};
for (const k of Object.keys(after.misses ?? {})) {
  const d = (after.misses[k] ?? 0) - (before.misses?.[k] ?? 0);
  if (d > 0) dm[k] = d;
}
console.log(`\n  parked, one box selected, over ${delta("frames")} frames:`);
console.log(`    hits ${delta("hits")}  renders ${delta("renders")}  audits ${delta("audits")}`);
console.log(`    animated ${after.animated}  ringLive ${after.ringLive}  lastMiss ${after.lastMiss}`);
console.log(`    misses: ${JSON.stringify(dm)}`);

// If the camera term is the culprit, is the camera actually still?
const cam = await page.evaluate(async () => {
  const v = globalThis.__viewport;
  const snap = () => [...v.camera.matrixWorld.elements, ...v.camera.projectionMatrix.elements];
  const a = snap();
  await new Promise((r) => setTimeout(r, 1200));
  const b = snap();
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return { diff, damping: v.orbit?.enableDamping ?? null };
});
console.log(`    camera matrix elements that moved over 1.2 s while "parked": ${cam.diff}/32 (damping ${cam.damping})`);

// How many times per frame is the mask asked for one?
const perFrame = await page.evaluate(async () => {
  const o = globalThis.__d.outline;
  const a = o.selectionOutlineStats().frames;
  let raf = 0;
  await new Promise((r) => {
    const t = () => { if (++raf >= 60) return r(); requestAnimationFrame(t); };
    requestAnimationFrame(t);
  });
  return { frames: o.selectionOutlineStats().frames - a, raf };
});
console.log(`    updateSelectionOutlineMask ran ${perFrame.frames} times in ${perFrame.raf} rAFs`);
await browser.close();
