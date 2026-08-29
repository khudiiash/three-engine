// GI2 ROTATION RECEIPT (§19 6.17) — boots Bistro in the "indirect" debug view, yaws the camera in-page at DEG_S deg/s for ROT_S s, screenshots the composited canvas every ~10 frames and prints per shot the fraction of 16x16 blocks that are black (<0.02), isolated-black (checkerboard signature) and >2x the frame median, plus rcMerge.readStats() every 5 frames. Env: POSE, TAG, OUTDIR, WW/WH window, VIEW, CHROME_PATH.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { installTauriShim } from "./lib/tauriShim.mjs";
const url = process.argv[2] ?? "http://127.0.0.1:5204/";
const PROJECT = "C:/Users/Khudiiash/Documents/GAME";
const SCENE_PATH = `${PROJECT}/scenes/Bistro.scene`;
const OUTDIR = process.env.OUTDIR ?? ".";
const TAG = process.env.TAG ?? "a";
const ROT_S = Number(process.env.ROT_S ?? 4), DEG_S = Number(process.env.DEG_S ?? 30);
const VIEW = process.env.VIEW ?? "indirect";
const WW = Number(process.env.WW ?? 2120), WH = Number(process.env.WH ?? 1240);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    `--window-size=${WW},${WH}`],
});
const page = await browser.newPage();
await page.setViewport({ width: WW, height: WH, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project, view) => {
  globalThis.__gi2Rc5 = true;
  globalThis.__editorKeepRendering = true;
  if (view !== "off") globalThis.__giDebugView = view;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT, VIEW);
let firstLight = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (/first light|\[gi\].*(rror|ailed)|exhaust|DEVICE|lost|rebuild|invalidat|pool|budget/i.test(t)) console.log(`  ${t.slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log("  pageerror", String(e).slice(0, 200)));
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
const call = (op, args) => page.evaluate(async (op, args) => {
  try { return await globalThis.__editorApi.call(op, args ?? {}); } catch (e) { return { __err: String(e?.message ?? e) }; }
}, op, args);
const opened = await call("scene.open", { path: SCENE_PATH });
if (opened?.__err) { console.log("FATAL", opened.__err); await browser.close(); process.exit(1); }
const t0 = Date.now();
while (!firstLight && Date.now() - t0 < 150000) await wait(250);
console.log(`first light ${firstLight ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen"}`);
await wait(5000);
const rect = await page.evaluate(() => {
  const cs = [...document.querySelectorAll("canvas")].map((c) => ({ c, r: c.getBoundingClientRect() })).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  const r = cs[0].r; return { x: r.x, y: r.y, w: r.width, h: r.height, cw: cs[0].c.width, ch: cs[0].c.height };
});
console.log("canvas rect", JSON.stringify(rect));
const clip = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) };
function decodePng(buf) {
  let off = 8; let w = 0, h = 0, ct = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IHDR") { w = buf.readUInt32BE(off + 8); h = buf.readUInt32BE(off + 12); ct = buf[off + 17]; }
    else if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 1; const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp; const out = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y > 0 ? out[dst - stride + x] : 0, c = (x >= bpp && y > 0) ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      out[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, d: out };
}
const lin = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const stats = (buf) => {
  const img = decodePng(buf); const { d, bpp, w, h } = img; const B = 16; const means = [];
  for (let ty = 0; ty + B <= h; ty += B) for (let tx = 0; tx + B <= w; tx += B) {
    let s = 0; for (let y = ty; y < ty + B; y++) for (let x = tx; x < tx + B; x++) { const i = (y * w + x) * bpp; s += 0.2126 * lin[d[i]] + 0.7152 * lin[d[i + 1]] + 0.0722 * lin[d[i + 2]]; }
    means.push(s / (B * B));
  }
  const n = means.length; const black = means.filter((m) => m < 0.02).length;
  const nb = means.filter((m) => m >= 0.02).sort((a, b) => a - b); const med = nb.length ? nb[nb.length >> 1] : 0;
  const bright = means.filter((m) => m > 2 * med).length;
  const bw = Math.floor(w / B), bh = Math.floor(h / B); let iso = 0;
  for (let i = 0; i < n; i++) if (means[i] < 0.02) {
    const x = i % bw, y = (i / bw) | 0; let nk = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue; if (means[yy * bw + xx] >= 0.02) nk++; }
    if (nk >= 2) iso++;
  }
  return `black ${(100 * black / n).toFixed(2)} %  isoBlack ${(100 * iso / n).toFixed(2)} %  bright(>2xmed ${med.toFixed(3)}) ${(100 * bright / n).toFixed(2)} %  [${w}x${h}]`;
};
const shot = async (name) => { const buf = await page.screenshot({ clip, type: "png" }); writeFileSync(`${OUTDIR}/${name}.png`, buf); return stats(buf); };
const rcs = async () => { const g = await call("profile.gi2"); return g?.rcMerge ?? g?.gi2?.rcMerge ?? (g ? { keys: Object.keys(g) } : null); };
const cam = await call("viewport.getCamera"); console.log("camera", JSON.stringify(cam));
if (process.env.POSE) { const p = process.env.POSE.split("|").map((s) => s.split(",").map(Number)); await call("viewport.setCamera", { position: p[0], target: p[1] }); await wait(4000); }
const cam0 = await call("viewport.getCamera");
console.log("settled-0:", await shot(`rot-${TAG}-settled0`));
console.log("rcMerge settled:", JSON.stringify(await rcs())?.slice(0, 1200)); { const g = await call("profile.gi2"); console.log("gi2 keys", Object.keys(g??{}).join(",")); console.log("rc:", JSON.stringify(g?.rc ?? null)?.slice(0, 2500)); }
await page.evaluate((cam, rotS, degS) => {
  const e = cam.position, t = cam.target; const dx = t[0] - e[0], dz = t[2] - e[2]; const R = Math.hypot(dx, dz) || 5; const a0 = Math.atan2(dz, dx);
  const st = performance.now(); const samples = []; let frames = 0; globalThis.__rot = { done: false, samples, frames: 0 };
  const step = async () => {
    const el = (performance.now() - st) / 1000; frames++;
    const a = a0 + el * degS * Math.PI / 180;
    try { await globalThis.__editorApi.call("viewport.setCamera", { position: e, target: [e[0] + Math.cos(a) * R, t[1], e[2] + Math.sin(a) * R] }); } catch {}
    if (frames % 5 === 0) { try { const g = await globalThis.__editorApi.call("profile.gi2"); const r = g?.rcMerge; samples.push({ el: +el.toFixed(2), frames, resolve: r?.resolve, cov: r?.tiles?.coverage, c: (g?.rc?.probes?.cascades ?? g?.rc?.cascades ?? []).map((c) => [c.live ?? c.probes, c.failedInserts, c.fresh, c.noBlock]) , merged: r?.merge?.perCascade?.map((c) => c.probes) }); } catch {} }
    globalThis.__rot.frames = frames;
    if (el < rotS) requestAnimationFrame(step); else globalThis.__rot.done = true;
  };
  requestAnimationFrame(step);
}, cam0, ROT_S, DEG_S);
const t1 = Date.now(); let k = 0;
while (Date.now() - t1 < ROT_S * 1000) { const s = await shot(`rot-${TAG}-r${String(k).padStart(2, "0")}`); console.log(`rot +${((Date.now() - t1) / 1000).toFixed(2)}s:`, s); k++; }
await page.waitForFunction(() => globalThis.__rot?.done, { timeout: 20000 });
const rot = await page.evaluate(() => globalThis.__rot);
console.log(`frames during rotation: ${rot.frames} (${(rot.frames / ROT_S).toFixed(1)} fps)`);
for (const s of rot.samples) console.log("  sample", JSON.stringify(s).slice(0, 700));
console.log("stop+0.3:", await shot(`rot-${TAG}-stop0`)); await wait(1000);
console.log("stop+1.3:", await shot(`rot-${TAG}-stop1`)); await wait(3000);
console.log("stop+4.3:", await shot(`rot-${TAG}-stop4`));
console.log("rcMerge end:", JSON.stringify(await rcs())?.slice(0, 600)); { const g = await call("profile.gi2"); console.log("rc end:", JSON.stringify(g?.rc ?? null)?.slice(0, 2500)); }
await browser.close();
