// Exact-scene AO split: final composite, filtered screen GTAO, and occupancy
// world visibility. Opens the project read-only and writes both the live AO
// debug view and the native AO target as grayscale PNGs.
//
//   WORLD=0 node scripts/run-gi-scene-ao-probe.mjs http://127.0.0.1:5201/
//   WORLD=1 node scripts/run-gi-scene-ao-probe.mjs http://127.0.0.1:5201/
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5201/";
const project = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const world = process.env.WORLD !== "0";
const settle = Number(process.env.SETTLE ?? 15000);
const width = Number(process.env.WIDTH ?? 1200);
const height = Number(process.env.HEIGHT ?? 760);
const outDir = process.env.OUT ?? ".gi-shots/scene-ao";
const arm = world ? "world" : "screen";
mkdirSync(outDir, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  userDataDir: mkdtempSync(join(tmpdir(), `gi-scene-ao-${arm}-`)),
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox",
    "--disable-dev-shm-usage", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = false;
const errors = [];
page.on("console", (message) => {
  const text = message.text();
  if (/\[gi\] built/.test(text)) built = true;
  if (/^\[gi\]/.test(text)) console.log(`  ${text}`);
});
page.on("pageerror", (error) => {
  const text = error.message ?? String(error);
  if (!/save_scene|refusing write|rapier/.test(text)) errors.push(text);
});
await page.evaluateOnNewDocument((root, worldEnabled) => {
  localStorage.setItem("engine.projectRoot.v1", root);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([root]));
  globalThis.__editorKeepRendering = true;
  // This probe owns the AO arm even when the saved scene currently has the
  // component toggle off for a beauty comparison.
  globalThis.__giConfigOverride = { quality: "ultra", ao: true };
  globalThis.__giWorldAo = worldEnabled;
}, project, world);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((root) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === root) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, project);
for (let i = 0; i < 180 && !built; i++) await wait(1000);
if (!built) throw new Error("GI build did not complete");
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });

const pose = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const rows0 = await api.call("entity.list", {});
  const rows = rows0.value ?? rows0;
  const row = rows.find((r) => r.name === "Main Camera");
  const live = row ? api.entities.live(row.id) : null;
  let camera = null;
  live?.object3D?.traverse?.((object) => { if (!camera && object.isCamera) camera = object; });
  if (!camera) return null;
  camera.updateWorldMatrix(true, false);
  const p = camera.getWorldPosition(camera.position.clone());
  const d = camera.getWorldDirection(p.clone());
  const target = p.clone().addScaledVector(d, 8);
  await api.call("viewport.setCamera", { position: p.toArray(), target: target.toArray() });
  const rows1 = await api.call("entity.list", {});
  const engine = api.entities.live((rows1.value ?? rows1)[0].id)?.engine;
  if (engine?.camera && camera.fov) {
    engine.camera.fov = camera.fov;
    engine.camera.updateProjectionMatrix();
  }
  return { position: p.toArray(), target: target.toArray(), fov: camera.fov };
});
console.log(`${arm}: pose ${JSON.stringify(pose)}, settling ${settle}ms`);
await wait(settle);

const result = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const rows0 = await api.call("entity.list", {});
  const rows = rows0.value ?? rows0;
  const engine = api.entities.live(rows[0].id)?.engine;
  const screen = engine.modules?.get?.("gi")?.system?.state?.screen;
  const pass = screen?.vxaoPass;
  if (!pass?.target || !pass?.rawTarget) {
    throw new Error(`AO targets unavailable: engine=${!!engine} system=${!!engine?.modules?.get?.("gi")?.system} screen=${!!screen} keys=${Object.keys(screen ?? {}).join(",")}`);
  }
  const unpad = (raw, w, h, Ctor) => {
    const rowBytes = w * 4 * Ctor.BYTES_PER_ELEMENT;
    const padded = Math.ceil(rowBytes / 256) * 256;
    const src = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
    const dst = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) dst.set(src.subarray(y * padded, Math.min(src.length, y * padded + rowBytes)), y * rowBytes);
    return new Ctor(dst.buffer);
  };
  const f16 = (h) => {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) return sign * mant * 2 ** -24;
    if (exp === 31) return mant ? NaN : sign * Infinity;
    return sign * (mant + 1024) * 2 ** (exp - 25);
  };
  const w = pass.width;
  const h = pass.height;
  const finalPx = unpad(await engine.renderer.backend.copyTextureToBuffer(pass.target, 0, 0, w, h, 0), w, h, Uint16Array);
  const rawPx = unpad(await engine.renderer.backend.copyTextureToBuffer(pass.rawTarget, 0, 0, w, h, 0), w, h, Uint16Array);
  const gposTex = screen.gbuffer.position;
  const normalTex = screen.gbuffer.normal;
  const gw = gposTex.image.width;
  const gh = gposTex.image.height;
  const pos = unpad(await engine.renderer.backend.copyTextureToBuffer(gposTex, 0, 0, gw, gh, 0), gw, gh, Float32Array);
  const normals = unpad(await engine.renderer.backend.copyTextureToBuffer(normalTex, 0, 0, gw, gh, 0), gw, gh, Uint16Array);
  const values = { final: [], gtaoRaw: [], worldFiltered: [], openFloor: [], originFloor: [] };
  const grey = new Uint8Array(w * h);
  const surface = new Uint8Array(w * h);
  const sampleFinal = (x, y) => f16(finalPx[(y * w + x) * 4]);
  const neighbourDelta = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const gx = Math.min(gw - 1, Math.floor((x + 0.5) * gw / w));
    const gy = Math.min(gh - 1, Math.floor((y + 0.5) * gh / h));
    const go = (gy * gw + gx) * 4;
    if (!(pos[go + 3] > 0.5)) { grey[y * w + x] = 255; continue; }
    surface[y * w + x] = 1;
    const a = f16(finalPx[o]);
    const raw = f16(rawPx[o]);
    const world = f16(finalPx[o + 1]);
    if (Number.isFinite(a)) values.final.push(a);
    if (Number.isFinite(raw)) values.gtaoRaw.push(raw);
    if (Number.isFinite(world)) values.worldFiltered.push(world);
    grey[y * w + x] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    const pxw = pos[go], pyw = pos[go + 1], pzw = pos[go + 2];
    if (Math.abs(pyw) < 0.08) {
      if (pzw < -1 && Math.abs(pxw) < 4) values.openFloor.push(a);
      if (Math.hypot(pxw, pzw) < 0.45) values.originFloor.push(a);
    }
    if (x + 1 < w) {
      const gx2 = Math.min(gw - 1, Math.floor((x + 1.5) * gw / w));
      const g2 = (gy * gw + gx2) * 4;
      if (pos[g2 + 3] > 0.5) {
        const n0 = [f16(normals[go]), f16(normals[go + 1]), f16(normals[go + 2])];
        const n1 = [f16(normals[g2]), f16(normals[g2 + 1]), f16(normals[g2 + 2])];
        const nd = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
        const plane = Math.abs(n0[0] * (pos[g2] - pxw) + n0[1] * (pos[g2 + 1] - pyw) + n0[2] * (pos[g2 + 2] - pzw));
        if (nd > 0.999 && plane < 0.01) neighbourDelta.push(Math.abs(a - sampleFinal(x + 1, y)));
      }
    }
  }
  const summarize = (xs) => {
    const sorted = xs.filter(Number.isFinite).sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
    return { n: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length), p05: q(.05), p50: q(.5), p95: q(.95), p99: q(.99) };
  };
  const shot = await api.call("viewport.screenshot", { width: 960, height: 608, includeGizmos: true });
  return {
    size: [w, h], grey: Array.from(grey), screenshot: shot.__image.base64,
    stats: Object.fromEntries(Object.entries(values).map(([key, xs]) => [key, summarize(xs)])),
    neighbourDelta: summarize(neighbourDelta),
  };
});

writeFileSync(`${outDir}/${arm}-debug.png`, Buffer.from(result.screenshot, "base64"));
await sharp(Buffer.from(result.grey), { raw: { width: result.size[0], height: result.size[1], channels: 1 } })
  .png().toFile(`${outDir}/${arm}-target.png`);
console.log(JSON.stringify({ arm, size: result.size, stats: result.stats, neighbourDelta: result.neighbourDelta, errors }, null, 2));
console.log(`wrote ${outDir}/${arm}-{debug,target}.png`);
await browser.close();
