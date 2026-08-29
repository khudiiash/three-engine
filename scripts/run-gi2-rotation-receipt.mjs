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
// §19 6.32b — FRAME MODE: `DEG_F` degrees per RENDERED frame for `NFRAMES` frames, reading the LINEAR
// `gi2.textures.irradiance` (createGi2PixelDump, stride 2) per frame instead of the sRGB composed view, so a
// saturated debug view cannot blind the instrument. `SETTLE` s after the pose; a composed shot at `SHOT_AT`.
// `FLAGS="__gi2ParentPrior=false"` sets build-time globals before boot.
const DEG_F = Number(process.env.DEG_F ?? 0), NFRAMES = Number(process.env.NFRAMES ?? 30);
const SETTLE = Number(process.env.SETTLE ?? 4), SHOT_AT = Number(process.env.SHOT_AT ?? 15);
const FLAGS = (process.env.FLAGS ?? "").split(",").filter(Boolean);
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
await page.evaluateOnNewDocument((flags) => { for (const kv of flags) { const [k, v] = kv.split("="); if (!k) continue; let val; try { val = JSON.parse(v); } catch { val = v; } globalThis[k.trim()] = val; } }, FLAGS);
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
// §19 6.32 — TILE-EDGE CONTRAST + PER-FRAME STEP. Per 16x16 block mean (linear luminance): edge = mean over
// blocks of |mean(block) − mean(right/down neighbour)| / frameMean (mean + p90); step = |mean(block) − mean(same
// block, previous shot)| / frameMean, p90 over blocks. Only blocks with a lit neighbour (both ≥ 0.02) count.
let prevMeans = null;
const stats = (buf, keepPrev = true) => {
  const img = decodePng(buf); const { d, bpp, w, h } = img; const B = 16; const means = [];
  for (let ty = 0; ty + B <= h; ty += B) for (let tx = 0; tx + B <= w; tx += B) {
    let s = 0; for (let y = ty; y < ty + B; y++) for (let x = tx; x < tx + B; x++) { const i = (y * w + x) * bpp; s += 0.2126 * lin[d[i]] + 0.7152 * lin[d[i + 1]] + 0.0722 * lin[d[i + 2]]; }
    means.push(s / (B * B));
  }
  const n = means.length; const black = means.filter((m) => m < 0.02).length;
  const nb = means.filter((m) => m >= 0.02).sort((a, b) => a - b); const med = nb.length ? nb[nb.length >> 1] : 0;
  const fmean = nb.length ? nb.reduce((x, y) => x + y, 0) / nb.length : 1;
  const bright = means.filter((m) => m > 2 * med).length;
  const bw = Math.floor(w / B), bh = Math.floor(h / B); let iso = 0;
  for (let i = 0; i < n; i++) if (means[i] < 0.02) {
    const x = i % bw, y = (i / bw) | 0; let nk = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue; if (means[yy * bw + xx] >= 0.02) nk++; }
    if (nk >= 2) iso++;
  }
  const edges = [];
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const m0 = means[y * bw + x]; if (m0 < 0.02) continue;
    if (x + 1 < bw) { const m1 = means[y * bw + x + 1]; if (m1 >= 0.02) edges.push(Math.abs(m0 - m1) / fmean); }
    if (y + 1 < bh) { const m1 = means[(y + 1) * bw + x]; if (m1 >= 0.02) edges.push(Math.abs(m0 - m1) / fmean); }
  }
  edges.sort((a, b) => a - b);
  const p90 = (arr) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.9))] : 0;
  const eMean = edges.length ? edges.reduce((x, y) => x + y, 0) / edges.length : 0;
  let stepTxt = "step n/a";
  if (prevMeans && prevMeans.length === n) {
    const steps = [];
    for (let i = 0; i < n; i++) if (means[i] >= 0.02 && prevMeans[i] >= 0.02) steps.push(Math.abs(means[i] - prevMeans[i]) / fmean);
    steps.sort((a, b) => a - b); stepTxt = `step p90 ${(100 * p90(steps)).toFixed(2)} %`;
  }
  if (keepPrev) prevMeans = means;
  return `black ${(100 * black / n).toFixed(2)} %  isoBlack ${(100 * iso / n).toFixed(2)} %  bright(>2xmed ${med.toFixed(3)}) ${(100 * bright / n).toFixed(2)} %  edge mean ${(100 * eMean).toFixed(2)} % p90 ${(100 * p90(edges)).toFixed(2)} %  ${stepTxt}  [${w}x${h}]`;
};
const shot = async (name) => { const buf = await page.screenshot({ clip, type: "png" }); writeFileSync(`${OUTDIR}/${name}.png`, buf); return stats(buf); };
const rcs = async () => { const g = await call("profile.gi2"); return g?.rcMerge ?? g?.gi2?.rcMerge ?? (g ? { keys: Object.keys(g) } : null); };
const cam = await call("viewport.getCamera"); console.log("camera", JSON.stringify(cam));
if (process.env.POSE) { const p = process.env.POSE.split("|").map((s) => s.split(",").map(Number)); await call("viewport.setCamera", { position: p[0], target: p[1] }); await wait(SETTLE * 1000); }
if (DEG_F > 0) {
  const setup = await page.evaluate(async () => {
    try {
      const mod = await import("/src/editor/engineInstance.js");
      const eng = mod.engine, sys = eng?.modules?.get?.("gi")?.system ?? null, gi2 = sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null;
      const { createGi2PixelDump, GI2_PIXEL_OUT_VEC } = await import("/scripts/lib/gi2PixelDump.js");
      const stride = 2;
      const dump = createGi2PixelDump({ renderer: eng.renderer, gi2, screen: sys.state?.screen, stride });
      const awaitFrame = () => new Promise((r) => { const off = eng.onPostRender(() => { off(); r(); }); });
      globalThis.__yawRead = async (eye) => {
        const d = await dump.read(awaitFrame, 6, 1);
        const OV = GI2_PIXEL_OUT_VEC; const B = Math.max(1, Math.round(16 / stride));
        const bw = Math.floor(dump.dumpW / B), bh = Math.floor(dump.dumpH / B);
        const means = new Array(bw * bh).fill(-1), geo = new Array(bw * bh).fill(null);
        for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
          let s = 0, n = 0, nx = 0, ny = 0, nz = 0, dist = 0;
          for (let y = by * B; y < by * B + B; y++) for (let x = bx * B; x < bx * B + B; x++) {
            const b = (y * dump.dumpW + x) * OV * 4; if (d[b + 3] < 0.5) continue;
            s += 0.2126 * d[b + 8] + 0.7152 * d[b + 9] + 0.0722 * d[b + 10]; n++;
            nx += d[b + 4]; ny += d[b + 5]; nz += d[b + 6];
            dist += Math.hypot(d[b] - eye[0], d[b + 1] - eye[1], d[b + 2] - eye[2]);
          }
          if (n >= (B * B) / 2) {
            means[by * bw + bx] = s / n;
            const nl = Math.hypot(nx, ny, nz) || 1;
            // a block whose normals disagree (|mean n| < cos 5°) is not one plane — it takes no part in the edge/step census
            geo[by * bw + bx] = (nl / n) >= Math.cos(5 * Math.PI / 180) ? [nx / nl, ny / nl, nz / nl, dist / n] : null;
          }
        }
        return { means, geo, bw, bh, attempts: d.attempts, frame: gi2.gather?.frame ?? 0 };
      };
      return JSON.stringify({ ok: true, stride, dumpW: dump.dumpW, dumpH: dump.dumpH });
    } catch (e) { return JSON.stringify({ error: String(e?.message ?? e) }); }
  });
  console.log("linear dump", setup);
  const p90 = (arr) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.9))] : 0;
  // §19 6.32c — GEOMETRY-BLIND: an edge counts only between blocks on ONE gbuffer plane (normals within 5°, distance
  // within 2 %) — a brightness difference there is a TILE edge by construction, never a shading edge. A step counts
  // only for a block that shows the same plane in both frames.
  const COS5 = Math.cos(5 * Math.PI / 180);
  const samePlane = (g0, g1) => !!g0 && !!g1 && (g0[0] * g1[0] + g0[1] * g1[1] + g0[2] * g1[2]) >= COS5 && Math.abs(g0[3] - g1[3]) <= 0.02 * Math.max(g0[3], g1[3]);
  const blockStats = (cur, prev, bw, bh) => {
    const valid = cur.means.filter((m) => m >= 0); const fmean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 1;
    const black = valid.filter((m) => m < 0.02 * fmean).length;
    const edges = [], steps = [];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const i = y * bw + x; const m0 = cur.means[i]; if (m0 < 0) continue;
      if (x + 1 < bw && cur.means[i + 1] >= 0 && samePlane(cur.geo[i], cur.geo[i + 1])) edges.push(Math.abs(m0 - cur.means[i + 1]) / fmean);
      if (y + 1 < bh && cur.means[i + bw] >= 0 && samePlane(cur.geo[i], cur.geo[i + bw])) edges.push(Math.abs(m0 - cur.means[i + bw]) / fmean);
      if (prev && prev.means[i] >= 0 && samePlane(cur.geo[i], prev.geo[i])) steps.push(Math.abs(m0 - prev.means[i]) / fmean);
    }
    edges.sort((a, b) => a - b); steps.sort((a, b) => a - b);
    return { fmean, valid: valid.length, black: black / Math.max(1, valid.length), nEdges: edges.length, nSteps: steps.length, edgeMean: edges.length ? edges.reduce((a, b) => a + b, 0) / edges.length : 0, edgeP90: p90(edges), stepP90: prev ? p90(steps) : NaN };
  };
  const cam1 = await call("viewport.getCamera");
  const e = cam1.position, t = cam1.target; const dx = t[0] - e[0], dz = t[2] - e[2]; const R = Math.hypot(dx, dz) || 5; const a0 = Math.atan2(dz, dx);
  let prev = null; const eP = [], sP = [];
  for (let k = 0; k < NFRAMES; k++) {
    const a = a0 + k * DEG_F * Math.PI / 180;
    await call("viewport.setCamera", { position: e, target: [e[0] + Math.cos(a) * R, t[1], e[2] + Math.sin(a) * R] });
    const r = await page.evaluate((eye) => globalThis.__yawRead(eye), e);
    const st = blockStats(r, prev, r.bw, r.bh);
    console.log(`yaw f${String(k).padStart(2, "0")} +${(k * DEG_F).toFixed(0)}°  frame ${r.frame} att ${r.attempts}  mean ${st.fmean.toFixed(4)}  valid ${st.valid}  black ${(100 * st.black).toFixed(2)} %  planeEdges ${st.nEdges} planeSteps ${st.nSteps}  edge mean ${(100 * st.edgeMean).toFixed(2)} % p90 ${(100 * st.edgeP90).toFixed(2)} %  step p90 ${Number.isFinite(st.stepP90) ? (100 * st.stepP90).toFixed(2) + " %" : "n/a"}`);
    if (k >= 15) { eP.push(st.edgeP90); sP.push(st.stepP90); }
    prev = r;
    if (k === SHOT_AT) { const buf = await page.screenshot({ clip, type: "png" }); writeFileSync(`${OUTDIR}/rot-${TAG}-yaw${k}.png`, buf); console.log(`  composed shot at f${k}: ${stats(buf, false)}`); }
  }
  eP.sort((a, b) => a - b); sP.sort((a, b) => a - b);
  console.log(`YAW SUMMARY ${TAG}: frames ${NFRAMES} at ${DEG_F}°/frame, f15-f29 same-plane only — tile-edge p90 median ${(100 * eP[eP.length >> 1]).toFixed(2)} % max ${(100 * eP[eP.length - 1]).toFixed(2)} %  |  step p90 median ${(100 * sP[sP.length >> 1]).toFixed(2)} % max ${(100 * sP[sP.length - 1]).toFixed(2)} %`);
  await browser.close(); process.exit(0);
}
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
