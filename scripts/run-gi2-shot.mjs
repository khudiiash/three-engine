// GI2 SCENE SHOT — boots the editor on the harness, opens a project scene,
// waits for first light + a settle, aims the camera and writes ONE PNG of the
// viewport (the editor's own offscreen `viewport.screenshot`, gizmos excluded).
//
//   SCENE=Cornel POSE='x,y,z|x,y,z' RC5=1 OUT=shot.png node scripts/run-gi2-shot.mjs http://127.0.0.1:5202/
//
// Env: SCENE (bare name or path) · PROJECT · POSE 'eye|target' · RC5=1 (the
// Stage 5 arm: sets `__gi2Rc5` before the scene opens) · SETTLE seconds ·
// OUT path · W/H size · HEADED=1.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const SCENE_PATH = SCENE.includes("/") || SCENE.includes("\\") ? SCENE.replaceAll("\\", "/") : `${PROJECT}/scenes/${SCENE}.scene`;
const RC5 = process.env.RC5 === "1";
const SETTLE = Number(process.env.SETTLE ?? 8);
const OUT = process.env.OUT ?? `gi2-shot-${SCENE}-${RC5 ? "rc5" : "shipped"}.png`;
const W = Number(process.env.W ?? 960);
const H = Number(process.env.H ?? 640);
const POSE = process.env.POSE ? process.env.POSE.split("|").map((s) => s.split(",").map(Number)) : null;
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
await page.evaluateOnNewDocument((flags) => {
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, JSON.parse(process.env.EXTRA ?? "{}"));
await page.evaluateOnNewDocument((rc5, project) => {
  if (rc5) globalThis.__gi2Rc5 = true;
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, RC5, PROJECT);
let firstLight = false;
const giLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (/\[gi/.test(t)) { giLines.push(t.slice(0, 140)); if (giLines.length > 12) giLines.shift(); }
  if (/rc5|RC5|bvh|BVH|rebuild|first light|\[gi\].*(rror|ailed)/i.test(t)) console.log(`  ${t.slice(0, 200)}`);
});
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
const opened = await page.evaluate(async (path) => {
  try { return { ok: true, v: await globalThis.__editorApi.call("scene.open", { path }) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}, SCENE_PATH);
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
const t0 = Date.now();
while (!firstLight && Date.now() - t0 < 90000) await wait(250);
console.log(`first light ${firstLight ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen in 45 s"}; rc5=${RC5}`);
if (!firstLight) console.log("  last [gi lines:\n  " + giLines.join("\n  "));
if (POSE) {
  await page.evaluate(async (p) => globalThis.__editorApi.call("viewport.setCamera", { position: p[0], target: p[1] }), POSE);
}
// §19 6.25b — `LAMP_SCALE=<k>`: scale the admitted lamp's entity (the gizmo's
// path) before the settle, as `run-gi2-cornell-ref.mjs` does.
const LAMP_SCALE = Number(process.env.LAMP_SCALE ?? 1);
if (LAMP_SCALE !== 1) {
  const sc = await page.evaluate(async ({ k }) => {
    const mod = await import("/src/editor/engineInstance.js");
    const sys = mod.engine?.modules?.get?.("gi")?.system ?? null;
    const emEntry = (sys?.state?.entries ?? []).find((e) => (e.peak ?? 0) > 0.5 && e.mesh);
    let id = null;
    for (let o = emEntry?.mesh; o && !id; o = o.parent) if (o.userData?.entityId) id = o.userData.entityId;
    if (!id) return { error: "no lamp entity" };
    const ent = await globalThis.__editorApi.call("entity.get", { id }).catch(() => null);
    const s0 = ent?.transform?.scale ?? [1, 1, 1];
    const r = await globalThis.__editorApi.call("entity.setTransform", { id, scale: s0.map((v) => v * k) });
    return { id, from: s0, to: r?.transform?.scale };
  }, { k: LAMP_SCALE });
  console.log(`lamp scaled x${LAMP_SCALE}: ${JSON.stringify(sc)}`);
}
await wait(SETTLE * 1000);
const shot = await page.evaluate(async (w, h) => {
  const r = await globalThis.__editorApi.viewport.screenshot({ width: w, height: h, includeGizmos: false });
  return typeof r === "string" ? r : (r?.__image ?? r?.png ?? r?.dataUrl ?? r?.image ?? JSON.stringify(Object.keys(r ?? {})));
}, W, H);
const raw = typeof shot === "string" ? shot : (shot?.data ?? shot?.base64 ?? JSON.stringify(shot).slice(0, 200));
const b64 = String(raw).replace(/^data:image\/png;base64,/, "");
if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 1000) { console.log(`FATAL screenshot payload: ${String(shot).slice(0, 120)}`); await browser.close(); process.exit(1); }
writeFileSync(OUT, Buffer.from(b64, "base64"));
console.log(`wrote ${OUT} (${W}x${H})`);
await browser.close();
