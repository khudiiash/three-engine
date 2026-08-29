// §19 6.15c TRACE-COUNT RECEIPT — reads the exact-reflection prepass targets
// AND the gbuffer mask at one pose and counts: masked pixels (giNormal.w > 0.5),
// traced texels (t >= 0 hit, t < -1.5 env miss), never-traced, and — the
// number this exists for — traced texels OUTSIDE the mask. The prepass is
// mask-bounded by construction (`live` early-out before the traversal);
// `unmaskedTraced` must read 0. Also prints the sharp-tagged meshes and the
// tier census so a large mask can be attributed to the mesh that draws it.
//   SCENE=Cornel RC5=1 POSE='x,y,z|x,y,z' SETTLE=10 node scripts/run-gi2-tracecount.mjs http://127.0.0.1:5207/
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
await wait(SETTLE * 1000);
const R = await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const findSys = () => engine.modules?.get?.("gi")?.system ?? engine.modules?.get?.("globalIllumination")?.system ?? null;
  let sys = findSys();
  for (let i = 0; i < 40 && !sys?.state?.bvhScene; i++) { await new Promise((r) => setTimeout(r, 500)); sys = findSys(); }
  if (!sys?.state?.bvhScene) return { error: "no bvhScene" };
  const renderer = engine.renderer;
  const t = sys._giBvhTarget;
  const unpad = (raw, w, h) => { const rowBytes = w * 8; const padded = Math.ceil(rowBytes / 256) * 256; const s = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length); const d = new Uint8Array(rowBytes * h); for (let y = 0; y < h; y++) d.set(s.subarray(y * padded, y * padded + rowBytes), y * rowBytes); return new Uint16Array(d.buffer); };
  const f16 = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff; if (e === 0) return s * Math.pow(2, -14) * (f / 1024); if (e === 31) return f ? NaN : s * Infinity; return s * Math.pow(2, e - 15) * (1 + f / 1024); };
  const read = async (tex) => { const w = tex.image.width, h = tex.image.height; return { w, h, a: unpad(await renderer.backend.copyTextureToBuffer(tex, 0, 0, w, h, 0), w, h) }; };
  const hit = await read(t.bvhReflect); const col = await read(t.bvhColor);
  const gb = sys.state.screen.gbuffer;
  const pos = await read(gb.position); const nrm = await read(gb.normal);
  let hits = 0, miss = 0, never = 0, aNonZero = 0, masked = 0, valid = 0, maskedTraced = 0, unmaskedTraced = 0;
  const n = hit.w * hit.h;
  for (let i = 0; i < n; i++) {
    const tv = f16(hit.a[i * 4]); const ha = f16(col.a[i * 4 + 3]);
    const m = f16(nrm.a[i * 4 + 3]) > 0.5; const v = f16(pos.a[i * 4 + 3]) > 0.5;
    if (m) masked++; if (v) valid++;
    if (Math.abs(ha) > 0.5) aNonZero++;
    const traced = tv >= 0 || tv < -1.5;
    if (tv >= 0) hits++; else if (tv < -1.5) miss++; else never++;
    if (traced) { if (m) maskedTraced++; else unmaskedTraced++; }
  }
  const gp = await globalThis.__editorApi.call("profile.giPasses");
  const { GI_SHARP_LAYER, GI_MIRROR_LAYER } = await import("/src/engine/editorLayers.js");
  const sharpMeshes = []; engine.scene.traverse((o) => { if (o.isMesh && (o.layers.mask & (1 << GI_SHARP_LAYER))) sharpMeshes.push({ name: o.name, mat: o.material?.name, rough: o.material?.roughness, metal: o.material?.metalness, transparent: !!o.material?.transparent, mirror: !!(o.layers.mask & (1 << GI_MIRROR_LAYER)), visible: o.visible, proxy: !!o.userData?.mergeProxy }); });
  const census = sys.reflectTierCensus?.() ?? null;
  return { size: [hit.w, hit.h], n, valid, masked, hits, tracedMiss: miss, never, alphaNonZero: aNonZero, traced: hits + miss, maskedTraced, unmaskedTraced,
    bvhReflectMs: gp?.screenPassesMs?.bvhReflect ?? null, normalFormat: [gb.normal.format, gb.normal.type], maskOn: globalThis.__giBvhMask !== false, sharpMeshes, census };
});
console.log(JSON.stringify(R, null, 1));
await browser.close();
