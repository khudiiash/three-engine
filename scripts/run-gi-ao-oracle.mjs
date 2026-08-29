// AO GRAIN ORACLE (§19 6.13b) — one boot per configuration, same pose, same
// resolution: dumps the half-res AO texture (f32), a region map (floor / edge /
// foliage / other), the full-res COMPOSED factor vs its nearest half-res texel
// (the 2x2 upsample's own grain), and a full-res viewport PNG with the AO
// debug view on. `scripts/gi-ao-oracle-compare.mjs` diffs two dumps:
// grain = |AO_default − AO_16slice|.
//
//   SCENE=Bistro SLICES=16 TAG=ref OUT=<dir> node scripts/run-gi-ao-oracle.mjs http://127.0.0.1:5208/
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5208/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SCENE_PATH = SCENE.includes("/") ? SCENE : `${PROJECT}/scenes/${SCENE}.scene`;
const SETTLE = Number(process.env.SETTLE ?? 15);
const OUT = process.env.OUT ?? "scripts/.gi-ao-grain";
const TAG = process.env.TAG ?? "run";
const POSE = process.env.POSE ? process.env.POSE.split("|").map((s) => s.split(",").map(Number)) : null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const o = {
  slices: Number(process.env.SLICES) || 0, steps: Number(process.env.STEPS) || 0,
  filterOff: process.env.FILTER === "0", view: process.env.VIEW ?? "ao",
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project, o) => {
  globalThis.__gi2Rc5 = true;
  globalThis.__editorKeepRendering = true;
  if (o.slices) globalThis.__giGtaoSlices = o.slices;
  if (o.steps) globalThis.__giGtaoSteps = o.steps;
  if (o.filterOff) globalThis.__giAoFilter = false;
  if (o.view !== "off") globalThis.__giDebugView = o.view;
  globalThis.__giConfigOverride = { ao: true };
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT, o);
let firstLight = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (/\[gi\] AO:/.test(t)) console.log(`  ${t.slice(0, 160)}`);
});
page.on("pageerror", (e) => { const s = String(e?.message ?? e); if (!/save_scene/.test(s)) console.log(`  pageerror: ${s.slice(0, 200)}`); });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
const opened = await page.evaluate(async (p) => {
  try { return { ok: true, v: await globalThis.__editorApi.call("scene.open", { path: p }) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}, SCENE_PATH);
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
const t0 = Date.now();
while (!firstLight && Date.now() - t0 < 120000) await wait(250);
console.log(`first light ${firstLight ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen"}`);

// Street-level pose: banner-derived like run-gi2-boot-probe, unless POSE given.
const pose = POSE ? { position: POSE[0], target: POSE[1] } : await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const bounds = async (needle) => {
    const r = await api.call("entity.list", { nameContains: needle });
    const list = Array.isArray(r) ? r : (r?.value ?? []);
    let agg = null;
    for (const e of list.slice(0, 40)) {
      const b = await api.call("entity.getBounds", { id: e.id });
      const bb = b?.value ?? b;
      if (!bb?.min) continue;
      agg ??= { min: [...bb.min], max: [...bb.max] };
      for (let i = 0; i < 3; i++) { agg.min[i] = Math.min(agg.min[i], bb.min[i]); agg.max[i] = Math.max(agg.max[i], bb.max[i]); }
    }
    return agg;
  };
  const banner = await bounds("FrontBanner");
  if (!banner) return null;
  const street = await bounds("Paris_Street_");
  const B = banner.min.map((v, i) => (v + banner.max[i]) / 2);
  const ground = street ? street.max[1] : banner.min[1] - 3.4;
  const eye = ground + 1.65;
  return { position: [B[0] + 7, eye, B[2] + 2], target: [B[0], ground + 1.4, B[2]], ground };
});
console.log(`pose ${JSON.stringify(pose)}`);
if (pose) await page.evaluate(async (p) => globalThis.__editorApi.call("viewport.setCamera", { position: p.position, target: p.target }), pose);
await wait(SETTLE * 1000);

const shot = await page.evaluate(async () => {
  const r = await globalThis.__editorApi.viewport.screenshot({ width: 1650, height: 970, includeGizmos: false });
  return typeof r === "string" ? r : (r?.__image ?? r?.png ?? r?.dataUrl ?? r?.image ?? r);
});
const rawShot = typeof shot === "string" ? shot : (shot?.data ?? shot?.base64 ?? "");
const b64 = String(rawShot).replace(/^data:image\/png;base64,/, "");
if (b64.length > 1000) writeFileSync(path.join(OUT, `view-${SCENE}-${TAG}.png`), Buffer.from(b64, "base64"));
else console.log(`  screenshot payload unusable: ${JSON.stringify(shot).slice(0, 160)}`);
if (process.env.SHOT_ONLY === "1") { await browser.close(); process.exit(0); }

const out = await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const renderer = engine.renderer;
  const sys = engine.modules?.get?.("gi")?.system ?? null;
  const screen = sys?.state?.screen ?? null;
  const pass = screen?.aoPass;
  if (!pass?.target) return { error: "no AO pass" };
  const unpad = (raw, w, h, comps, Ctor) => {
    const rowBytes = w * comps * Ctor.BYTES_PER_ELEMENT;
    const padded = Math.ceil(rowBytes / 256) * 256;
    const src = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
    const dst = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      const from = y * padded;
      const avail = Math.max(0, Math.min(rowBytes, src.length - from));
      if (avail > 0) dst.set(src.subarray(from, from + avail), y * rowBytes);
    }
    return new Ctor(dst.buffer);
  };
  const f16 = (h) => {
    const s = (h & 0x8000) ? -1 : 1; const e = (h >> 10) & 0x1f; const m = h & 0x3ff;
    if (e === 0) return s * m * 2 ** -24;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (m + 1024) * 2 ** (e - 25);
  };
  const vw = pass.width, vh = pass.height;
  const fin = unpad(await renderer.backend.copyTextureToBuffer(pass.target, 0, 0, vw, vh, 0), vw, vh, 4, Uint16Array);
  const posTex = screen.gbuffer.position, nrmTex = screen.gbuffer.normal;
  const gw = posTex.image?.width ?? screen.width, gh = posTex.image?.height ?? screen.height;
  const pos = unpad(await renderer.backend.copyTextureToBuffer(posTex, 0, 0, gw, gh, 0), gw, gh, 4, Float32Array);
  const nrmRaw = await renderer.backend.copyTextureToBuffer(nrmTex, 0, 0, gw, gh, 0);
  const nrmIsHalf = (nrmRaw.byteLength ?? nrmRaw.length) < gw * gh * 16 * 0.75;
  const nrm = nrmIsHalf ? unpad(nrmRaw, gw, gh, 4, Uint16Array) : unpad(nrmRaw, gw, gh, 4, Float32Array);
  const nz = (i) => (nrmIsHalf ? f16(nrm[i]) : nrm[i]);
  const sx = gw / vw, sy = gh / vh;
  const cam = engine.camera?.position ?? { x: 0, y: 0, z: 0 };
  const ao = new Float32Array(vw * vh), valid = new Uint8Array(vw * vh), dist = new Float32Array(vw * vh);
  const P = new Float32Array(vw * vh * 3), N = new Float32Array(vw * vh * 3);
  for (let py = 0; py < vh; py++) for (let px = 0; px < vw; px++) {
    const gx = Math.min(gw - 1, Math.floor((px + 0.5) * sx)), gy = Math.min(gh - 1, Math.floor((py + 0.5) * sy));
    const g = (gy * gw + gx) * 4, i = py * vw + px;
    if (pos[g + 3] < 0.5) continue;
    const v = f16(fin[i * 4]);
    if (!Number.isFinite(v)) continue;
    valid[i] = 1; ao[i] = v;
    P[i * 3] = pos[g]; P[i * 3 + 1] = pos[g + 1]; P[i * 3 + 2] = pos[g + 2];
    const nx = nz(g), ny = nz(g + 1), nzz = nz(g + 2); const l = Math.hypot(nx, ny, nzz) || 1;
    N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nzz / l;
    dist[i] = Math.hypot(pos[g] - cam.x, pos[g + 1] - cam.y, pos[g + 2] - cam.z);
  }
  // regions: 1 floor, 2 edge, 3 foliage (edge with >= 50 % normal-disagreeing
  // neighbours), 4 other smooth
  const region = new Uint8Array(vw * vh);
  for (let py = 2; py < vh - 2; py++) for (let px = 2; px < vw - 2; px++) {
    const i = py * vw + px;
    if (!valid[i]) continue;
    const tol = 0.02 * dist[i];
    let bad = 0, nbad = 0, cnt = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const j = (py + dy) * vw + (px + dx); cnt++;
      if (!valid[j]) { bad++; continue; }
      const plane = Math.abs(N[i * 3] * (P[j * 3] - P[i * 3]) + N[i * 3 + 1] * (P[j * 3 + 1] - P[i * 3 + 1]) + N[i * 3 + 2] * (P[j * 3 + 2] - P[i * 3 + 2]));
      const nd = N[i * 3] * N[j * 3] + N[i * 3 + 1] * N[j * 3 + 1] + N[i * 3 + 2] * N[j * 3 + 2];
      if (nd < 0.95) nbad++;
      if (plane > tol || nd < 0.95) bad++;
    }
    region[i] = bad === 0 ? (N[i * 3 + 1] > 0.95 ? 1 : 4) : (nbad >= cnt * 0.5 ? 3 : 2);
  }
  // 2x2 upsample grain: composed factor at full res vs the nearest half-res texel.
  let up = null;
  try {
    const gi2 = sys?._gi2 ?? screen?.gi2 ?? null;
    const composed = gi2?.textures?.irradiance ?? null;
    const pre = gi2?.gather?.textures?.irradiance ?? gi2?.textures?.irradianceRaw ?? null;
    if (composed && pre && composed !== pre) {
      const cw = composed.image?.width ?? gw, ch = composed.image?.height ?? gh;
      const rd = async (t) => unpad(await renderer.backend.copyTextureToBuffer(t, 0, 0, cw, ch, 0), cw, ch, 4, Uint16Array);
      const A = await rd(composed), B = await rd(pre);
      const acc = { 1: [], 2: [], 3: [], 4: [] };
      for (let y = 0; y < ch; y += 2) for (let x = 0; x < cw; x += 2) {
        const k = (y * cw + x) * 4;
        const a = f16(A[k]) + f16(A[k + 1]) + f16(A[k + 2]);
        const b = f16(B[k]) + f16(B[k + 1]) + f16(B[k + 2]);
        if (!(b > 1e-3)) continue;
        const hx = Math.min(vw - 1, Math.floor(x * vw / cw)), hy = Math.min(vh - 1, Math.floor(y * vh / ch));
        const hi = hy * vw + hx;
        if (!region[hi]) continue;
        acc[region[hi]].push(Math.abs(a / b - ao[hi]));
      }
      up = {};
      for (const r of [1, 2, 3, 4]) {
        const v = acc[r].sort((p, q) => p - q);
        up[r] = v.length ? { n: v.length, p50: v[Math.floor(v.length * 0.5)], p90: v[Math.floor(v.length * 0.9)] } : null;
      }
      up.size = [cw, ch];
    } else up = { skipped: `composed ${!!composed} pre ${!!pre}` };
  } catch (e) { up = { error: String(e?.message ?? e) }; }
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192)); return btoa(s); };
  return { size: [vw, vh], ao: b64(new Uint8Array(ao.buffer)), region: b64(region), up };
});
if (out.error) { console.log(`FAIL — ${out.error}`); await browser.close(); process.exit(1); }
let cost = null;
try {
  cost = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.call("profile.giPasses", { samples: 30 });
    const hits = {};
    const walk = (o, p) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (/^(gtao|aoFilterX|aoFilterY|gi2\.aoCompose|aoCompose)$/i.test(k)) hits[`${p}${k}`] = v;
        else if (v && typeof v === "object") walk(v, `${p}${k}.`);
      }
    };
    walk(r, "");
    return hits;
  });
} catch {}
writeFileSync(path.join(OUT, `dump-${SCENE}-${TAG}.json`), JSON.stringify({ size: out.size, ao: out.ao, region: out.region, up: out.up, cost, pose }));
const rn = { 1: "floor", 2: "edge", 3: "foliage", 4: "other" };
console.log(`dump ${TAG} ${out.size.join("x")}  cost ${JSON.stringify(cost)}`);
if (out.up && !out.up.skipped && !out.up.error) {
  for (const r of [1, 2, 3, 4]) {
    const u = out.up[r];
    if (u) console.log(`  upsample |composed − nearest half| ${rn[r].padEnd(8)} n ${u.n}  p50 ${(u.p50 * 100).toFixed(2)}%  p90 ${(u.p90 * 100).toFixed(2)}%`);
  }
} else console.log(`  upsample: ${JSON.stringify(out.up)}`);
await browser.close();
