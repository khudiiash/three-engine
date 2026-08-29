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
  if (!sys) return { error: "no gi system", modules: [...(engine.modules?.keys?.() ?? [])] };
  if (!sys.state?.bvhScene) return { error: "no bvhScene", hasState: !!sys.state, target: !!sys._giBvhTarget };
  const renderer = engine.renderer;
  const meshes = []; engine.scene.traverse((o) => { if (o.isMesh) meshes.push({ name: o.name, mat: o.material?.name, color: o.material?.color?.getHexString?.(), map: !!o.material?.map, emissive: o.material?.emissive?.getHexString?.(), rough: o.material?.roughness, metal: o.material?.metalness, tris: ((o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0) / 3), side: o.material?.side, layers: o.layers.mask, merge: !!o.userData.mergeProxy }); });
  const bvh = sys.state?.bvhScene; const seated = bvh?.meshes?.map((m) => m.name) ?? null;
  const t = sys._giBvhTarget;
  const unpad = (raw, w, h) => { const rowBytes = w * 8; const padded = Math.ceil(rowBytes / 256) * 256; const s = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length); const d = new Uint8Array(rowBytes * h); for (let y = 0; y < h; y++) d.set(s.subarray(y * padded, y * padded + rowBytes), y * rowBytes); return new Uint16Array(d.buffer); };
  const f16 = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff; if (e === 0) return s * Math.pow(2, -14) * (f / 1024); if (e === 31) return f ? NaN : s * Infinity; return s * Math.pow(2, e - 15) * (1 + f / 1024); };
  const read = async (tex) => { const w = tex.image.width, h = tex.image.height; return { w, h, a: unpad(await renderer.backend.copyTextureToBuffer(tex, 0, 0, w, h, 0), w, h) }; };
  const hit = await read(t.bvhReflect); const col = await read(t.bvhColor);
  const texs = sys._gi2?.textures ?? sys.state?.screen?.gi2?.textures ?? sys.state?.screen?.gi2?.gather?.textures ?? null;
  const gl = texs?.glossy ? await read(texs.glossy) : null;
  const ir = texs?.irradiance ? await read(texs.irradiance) : null;
  const lum = (buf, i) => f16(buf.a[i * 4]) * 0.2126 + f16(buf.a[i * 4 + 1]) * 0.7152 + f16(buf.a[i * 4 + 2]) * 0.0722;
  let never = 0, miss = 0, hitBlack = 0, hitLit = 0, total = 0; let sumA = 0; let missA = 0, missGl = 0, hitGl = 0, missIr = 0, hitIr = 0, missGlNonBlack = 0;
  const same = gl && gl.w === hit.w && gl.h === hit.h;
  for (let i = 0; i < hit.w * hit.h; i++) { const tv = f16(hit.a[i * 4]); if (tv < -1.5) { miss++; missA += f16(col.a[i * 4 + 3]); if (same) { const L = lum(gl, i); missGl += L; if (L > 0.01) missGlNonBlack++; missIr += lum(ir, i); } } else if (tv < 0) never++; else { total++; const r = f16(col.a[i * 4]), g = f16(col.a[i * 4 + 1]), b = f16(col.a[i * 4 + 2]); const ha = f16(col.a[i * 4 + 3]); sumA += ha; if (r + g + b < 0.01) hitBlack++; else hitLit++; if (same) { hitGl += lum(gl, i); hitIr += lum(ir, i); } } }
  return { meshes: meshes.length, seated, meshCount: bvh?.meshCount, triCount: bvh?.triCount, size: [hit.w, hit.h], glossySize: gl ? [gl.w, gl.h, texs.glossy.type] : null, never, miss, hits: total, hitBlack, hitLit, meanHasAlbedo: total ? sumA / total : null,
    missMeanColA: miss ? missA / miss : null, missGlossyLum: miss ? missGl / miss : null, missGlossyNonBlackPct: miss ? 100 * missGlNonBlack / miss : null, hitGlossyLum: total ? hitGl / total : null, missIrrLum: miss ? missIr / miss : null, hitIrrLum: total ? hitIr / total : null };
});
console.log(JSON.stringify(R, null, 1));
await browser.close();
