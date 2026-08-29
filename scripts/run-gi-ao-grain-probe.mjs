// AO GRAIN PROBE (§19 6.13) — is the 4x4 rotation tile (or per-pixel jitter)
// surviving the bilateral? Reads the FINAL AO texture (post-filter,
// pre-upsample) and the RAW one, pairs every texel with its gbuffer
// position/normal, and scores TWO regions:
//
//   floor  — normal within 18° of +Y and no depth/normal discontinuity in
//            the 5x5 AO-grid neighbourhood
//   edge   — any 5x5 neighbour off this pixel's plane or with a different
//            normal (tables, chairs, foliage, rails)
//
// per region: RESIDUAL |AO − mean over SAME-PLANE 5x5 neighbours| p50/p90
// (as % of the region mean) and the 4x4 PHASE PROFILE — mean AO per
// (x mod 4, y mod 4) minus the region mean, max |dev| as % of the mean. A
// non-zero phase profile IS the rotation pattern showing through.
//
//   SCENE=Bistro RC5=1 SETTLE=10 OUT=<dir> node scripts/run-gi-ao-grain-probe.mjs http://127.0.0.1:5208/
//   SLICES= STEPS= FILTER_R= SCALE=  (build-time overrides, for A/B)
//   POSE='x,y,z|x,y,z'
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5208/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SCENE_PATH = SCENE.includes("/") ? SCENE : `${PROJECT}/scenes/${SCENE}.scene`;
const RC5 = process.env.RC5 !== "0";
const SETTLE = Number(process.env.SETTLE ?? 10);
const OUT = process.env.OUT ?? "scripts/.gi-ao-grain";
const TAG = process.env.TAG ?? "run";
const POSE = process.env.POSE ? process.env.POSE.split("|").map((s) => s.split(",").map(Number)) : null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
const overrides = {
  slices: Number(process.env.SLICES) || 0, steps: Number(process.env.STEPS) || 0,
  filterR: Number(process.env.FILTER_R) || 0, scale: Number(process.env.SCALE) || 0,
  filterOff: process.env.FILTER === "0",
};
await page.evaluateOnNewDocument((rc5, project, o) => {
  if (rc5) globalThis.__gi2Rc5 = true;
  globalThis.__editorKeepRendering = true;
  if (o.slices) globalThis.__giGtaoSlices = o.slices;
  if (o.steps) globalThis.__giGtaoSteps = o.steps;
  if (o.filterR) globalThis.__giAoFilterRadius = o.filterR;
  if (o.scale) globalThis.__giGtaoScale = o.scale;
  if (o.filterOff) globalThis.__giAoFilter = false;
  // Bistro authors `ao: false`; the documented hatch forces the term ON.
  globalThis.__giConfigOverride = { ao: true };
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, RC5, PROJECT, overrides);
let firstLight = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (/\[gi\] AO:|pageerror|TSL/.test(t)) console.log(`  ${t.slice(0, 220)}`);
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
// AO must be ON (Bistro authors `ao: false`); the GI component is found by type.
const aoSet = await page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const list = await api.call("entity.list", {});
  const ents = Array.isArray(list) ? list : (list?.value ?? list?.entities ?? []);
  for (const e of ents) {
    const comps = e.components ?? [];
    const names = Array.isArray(comps) ? comps.map((c) => (typeof c === "string" ? c : c?.type)) : Object.keys(comps);
    if (names.includes("global-illumination")) { await api.call("component.setProp", { id: e.id, type: "global-illumination", key: "ao", value: true }); return e.id; }
  }
  return null;
});
console.log(`  ao enabled on ${aoSet}`);
const t0 = Date.now();
while (!firstLight && Date.now() - t0 < 120000) await wait(250);
console.log(`first light ${firstLight ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen"}`);
if (POSE) await page.evaluate(async (p) => globalThis.__editorApi.call("viewport.setCamera", { position: p[0], target: p[1] }), POSE);
await wait(SETTLE * 1000);

const out = await page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const renderer = engine.renderer;
  const sys = engine.modules?.get?.("gi")?.system ?? null;
  const screen = sys?.state?.screen ?? null;
  const pass = screen?.aoPass ?? screen?.vxaoPass;
  if (!pass?.target || !screen?.gbuffer?.position) return { error: `no AO pass (sys ${!!sys} screen ${!!screen} keys ${Object.keys(screen ?? {}).filter((k) => /ao/i.test(k)).join(",")})` };
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
  const read = async (tex) => unpad(await renderer.backend.copyTextureToBuffer(tex, 0, 0, vw, vh, 0), vw, vh, 4, Uint16Array);
  const fin = await read(pass.target);
  const raw = pass.rawTarget && pass.rawTarget !== pass.target ? await read(pass.rawTarget) : null;
  const posTex = screen.gbuffer.position, nrmTex = screen.gbuffer.normal;
  const gw = posTex.image?.width ?? screen.width, gh = posTex.image?.height ?? screen.height;
  const pos = unpad(await renderer.backend.copyTextureToBuffer(posTex, 0, 0, gw, gh, 0), gw, gh, 4, Float32Array);
  const nrmRaw = await renderer.backend.copyTextureToBuffer(nrmTex, 0, 0, gw, gh, 0);
  // normal may be half float or float — detect by byte length
  const nrmIsHalf = (nrmRaw.byteLength ?? nrmRaw.length) < gw * gh * 16 * 0.75;
  const nrm = nrmIsHalf ? unpad(nrmRaw, gw, gh, 4, Uint16Array) : unpad(nrmRaw, gw, gh, 4, Float32Array);
  const nz = (i) => (nrmIsHalf ? f16(nrm[i]) : nrm[i]);
  const sx = gw / vw, sy = gh / vh;
  const cam = engine.camera?.position ?? { x: 0, y: 0, z: 0 };
  const ao = new Float32Array(vw * vh), aoRaw = raw ? new Float32Array(vw * vh) : null;
  const P = new Float32Array(vw * vh * 3), N = new Float32Array(vw * vh * 3), valid = new Uint8Array(vw * vh);
  const dist = new Float32Array(vw * vh);
  for (let py = 0; py < vh; py++) for (let px = 0; px < vw; px++) {
    const gx = Math.min(gw - 1, Math.floor((px + 0.5) * sx)), gy = Math.min(gh - 1, Math.floor((py + 0.5) * sy));
    const g = (gy * gw + gx) * 4, i = py * vw + px;
    if (pos[g + 3] < 0.5) continue;
    const v = f16(fin[i * 4]); if (!Number.isFinite(v)) continue;
    valid[i] = 1; ao[i] = v; if (aoRaw) aoRaw[i] = f16(raw[i * 4]);
    P[i * 3] = pos[g]; P[i * 3 + 1] = pos[g + 1]; P[i * 3 + 2] = pos[g + 2];
    let nx = nz(g), ny = nz(g + 1), nzz = nz(g + 2); const l = Math.hypot(nx, ny, nzz) || 1;
    N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nzz / l;
    dist[i] = Math.hypot(pos[g] - cam.x, pos[g + 1] - cam.y, pos[g + 2] - cam.z);
  }
  // classify + same-plane residual
  const R = 2;
  const region = new Uint8Array(vw * vh); // 1 floor, 2 edge, 3 other-smooth
  const resid = new Float32Array(vw * vh), residRaw = new Float32Array(vw * vh);
  for (let py = R; py < vh - R; py++) for (let px = R; px < vw - R; px++) {
    const i = py * vw + px; if (!valid[i]) continue;
    const tol = 0.02 * dist[i];
    let edge = false, sum = 0, sumR = 0, cnt = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const j = (py + dy) * vw + (px + dx);
      if (!valid[j]) { edge = true; continue; }
      const ddx = P[j * 3] - P[i * 3], ddy = P[j * 3 + 1] - P[i * 3 + 1], ddz = P[j * 3 + 2] - P[i * 3 + 2];
      const plane = Math.abs(N[i * 3] * ddx + N[i * 3 + 1] * ddy + N[i * 3 + 2] * ddz);
      const nd = N[i * 3] * N[j * 3] + N[i * 3 + 1] * N[j * 3 + 1] + N[i * 3 + 2] * N[j * 3 + 2];
      if (plane > tol || nd < 0.95) { edge = true; continue; }
      sum += ao[j]; if (aoRaw) sumR += aoRaw[j]; cnt++;
    }
    if (cnt < 4) continue;
    region[i] = edge ? 2 : (N[i * 3 + 1] > 0.95 ? 1 : 3);
    resid[i] = Math.abs(ao[i] - sum / cnt);
    if (aoRaw) residRaw[i] = Math.abs(aoRaw[i] - sumR / cnt);
  }
  const score = (which, arr, res) => {
    const vals = [], rs = []; const ph = new Float64Array(16), phc = new Float64Array(16);
    for (let py = 0; py < vh; py++) for (let px = 0; px < vw; px++) {
      const i = py * vw + px; if (region[i] !== which) continue;
      vals.push(arr[i]); rs.push(res[i]);
      const k = (py & 3) * 4 + (px & 3); ph[k] += arr[i]; phc[k]++;
    }
    if (!vals.length) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    rs.sort((a, b) => a - b);
    const q = (f) => rs[Math.min(rs.length - 1, Math.floor(f * rs.length))];
    let phMax = 0; const prof = [];
    for (let k = 0; k < 16; k++) { const d = phc[k] ? ph[k] / phc[k] - mean : 0; prof.push(+(d / mean * 100).toFixed(2)); phMax = Math.max(phMax, Math.abs(d)); }
    return { n: vals.length, mean: +mean.toFixed(4), residP50pct: +(q(0.5) / mean * 100).toFixed(2), residP90pct: +(q(0.9) / mean * 100).toFixed(2), phaseMaxPct: +(phMax / mean * 100).toFixed(2), profile: prof };
  };
  const result = { size: [vw, vh], gsize: [gw, gh], final: { floor: score(1, ao, resid), edge: score(2, ao, resid), other: score(3, ao, resid) } };
  if (aoRaw) result.raw = { floor: score(1, aoRaw, residRaw), edge: score(2, aoRaw, residRaw) };
  // grayscale rows for a PNG (final AO + region mask)
  const img = new Uint8Array(vw * vh * 2);
  for (let i = 0; i < vw * vh; i++) { img[i] = valid[i] ? Math.max(0, Math.min(255, Math.round(ao[i] * 255))) : 0; img[vw * vh + i] = region[i] * 80; }
  result.img = btoa(String.fromCharCode(...img.subarray(0, vw * vh))) ;
  result.mask = btoa(String.fromCharCode(...img.subarray(vw * vh)));
  return result;
});
if (out.error) { console.log(`FAIL — ${out.error}`); await browser.close(); process.exit(1); }
let cost = null;
try {
  cost = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.call("profile.giPasses", { samples: 30 });
    const hits = {};
    const walk = (o, p) => { if (!o || typeof o !== "object") return; for (const [k, v] of Object.entries(o)) { if (/^(gtao|aoFilterX|aoFilterY)$/i.test(k)) hits[`${p}${k}`] = v; else if (v && typeof v === "object") walk(v, `${p}${k}.`); } };
    walk(r, ""); return hits;
  });
} catch {}

// PNG writer (grayscale 8-bit)
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const png = (w, h, gray) => {
  const rows = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { rows[y * (w + 1)] = 0; gray.copy(rows, y * (w + 1) + 1, y * w, y * w + w); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
};
const [vw, vh] = out.size;
writeFileSync(path.join(OUT, `ao-${SCENE}-${TAG}.png`), png(vw, vh, Buffer.from(out.img, "base64")));
writeFileSync(path.join(OUT, `mask-${SCENE}-${TAG}.png`), png(vw, vh, Buffer.from(out.mask, "base64")));
const line = (k, s) => s ? `  ${k.padEnd(6)} n ${String(s.n).padStart(7)}  mean ${s.mean.toFixed(3)}  resid p50 ${s.residP50pct.toFixed(2)}%  p90 ${s.residP90pct.toFixed(2)}%  phaseMax ${s.phaseMaxPct.toFixed(2)}%` : `  ${k}: (none)`;
console.log(`\nAO ${vw}x${vh} over gbuffer ${out.gsize.join("x")}  [${TAG}]`);
console.log("FINAL (post-filter):"); console.log(line("floor", out.final.floor)); console.log(line("edge", out.final.edge)); console.log(line("other", out.final.other));
if (out.final.floor) console.log(`  floor phase profile (%): ${out.final.floor.profile.join(" ")}`);
if (out.raw) { console.log("RAW (pre-filter):"); console.log(line("floor", out.raw.floor)); console.log(line("edge", out.raw.edge)); }
if (cost) console.log(`COST: ${JSON.stringify(cost)}`);
await browser.close();
