// GI2 COLOUR CHAIN — §19 6.33: WHERE DOES THE BROWN WALL'S BOUNCE LOSE ITS COLOUR?
//
// The user's Bistro: "the sun hits a brown wall, but no brown at all over the
// street". [[gi-colour-probe-method]]: read back EVERY stage and the FIRST grey
// one is the owner. Five stages for the most-brown, largest palette class:
//   (a) the material's resolved albedo (texture mean × base) vs its palette entry
//   (b) the voxel's palette class at the wall (`t.pal` read through `shadeTerms`)
//   (c) the face cache there: Esun + Enee (and the stored E_rc word)
//   (d) the hit radiance a ray gets: albedo/π · E (what `shadeHit` deposits)
//   (e) the street pixels' final indirect chroma (`indirect` debug view, bottom rows)
//
// Run:  node scripts/run-gi2-colour-chain.mjs http://127.0.0.1:5207/
// Env:  PROJECT · SCENE=Bistro · SETTLE=10 · SHOT=1 (write PNGs to OUT dir)
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { reportEmitterSeats } from "./lib/gi2EmitterWait.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5207/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 10);
const OUT = process.env.OUT ?? ".";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const rgb = (a) => (a ? `[${a.map((v) => f(v, 3)).join(", ")}]` : "null");
// "brown-ness": red over blue. 1.00 = neutral; the brown wall should read well above 1.
const rb = (a) => (a && a[2] > 1e-5 ? a[0] / a[2] : NaN);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--js-flags=--expose-gc",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

let firstLight = 0;
let retintTex = 0;
const lines = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t) && !firstLight) firstLight = Date.now();
  if (/palette re-tint \(texture-averages\)/.test(t)) retintTex++;
  if (/palette|retint|bounce albedo|Basis|KTX2|transcode/i.test(t)) lines.push(t.slice(0, 220));
  if (m.type() === "error" && !/save_scene/.test(t)) lines.push(`ERROR ${t.slice(0, 220)}`);
});
page.on("pageerror", (e) => {
  const s = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(s)) console.log(`    pageerror: ${s.slice(0, 200)}`);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__giEngineForProbe = mod.engine;
  globalThis.__giSys = () => mod.engine?.modules?.get?.("gi")?.system ?? null;
  globalThis.__gi2 = () => {
    const sys = globalThis.__giSys();
    return sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null;
  };
});
const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });

console.log(`\n══ ${SCENE} — the colour chain ═══════════════════════════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{ const dl = Date.now() + 240000; while (Date.now() < dl && !firstLight) await wait(250); }
console.log(`  first light ${firstLight ? "yes" : "NEVER"}`);
await reportEmitterSeats(page);
// The texture averages land after the material tail; wait for the re-tint they trigger.
{ const dl = Date.now() + 90000; while (Date.now() < dl && !retintTex) await wait(500); }
console.log(`  texture-average re-tints seen: ${retintTex} — settling ${SETTLE}s`);
await wait(SETTLE * 1000);

// ── 0. textures receipt ───────────────────────────────────────────────────
const tex = await call("profile.textures", { limit: 5 });
if (tex.ok) {
  const v = tex.value;
  const summary = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== "object"));
  console.log(`  profile.textures: ${JSON.stringify(summary).slice(0, 400)}`);
  for (const k of Object.keys(v)) if (Array.isArray(v[k])) console.log(`    ${k}: ${v[k].length} rows; first ${JSON.stringify(v[k][0]).slice(0, 200)}`);
} else console.log(`  profile.textures failed: ${tex.error}`);

// ── (a) the palette vs the material ───────────────────────────────────────
const A = await page.evaluate(async () => {
  const sys = globalThis.__giSys();
  const gi2 = globalThis.__gi2();
  const gather = gi2?.gather;
  const assign = gi2?.paletteAssign;
  const meshByKey = sys?._gi2PaletteMeshByKey;
  if (!gather || !assign || !meshByKey) return { error: `no palette: gather ${!!gather} assign ${!!assign} meshByKey ${!!meshByKey}` };
  const { resolveMaterialSurface } = await import("/src/modules/gi/voxelizeOnce.js");
  const pal = (gather.palette ?? []).map((v) => [v.x, v.y, v.z, v.w]);
  const cls = Array.from({ length: assign.classCount }, (_, i) => ({ i, pal: pal[i]?.slice(0, 3) ?? [0, 0, 0], area: 0, n: 0, meshes: new Map() }));
  for (let k = 0; k < assign.keys.length; k++) {
    const c = assign.classOf[k]; const key = assign.keys[k];
    if (!(c >= 0) || c >= cls.length) continue;
    const rec = meshByKey.get(key);
    if (!rec?.mesh) continue;
    const e = cls[c];
    e.n++; e.area += rec.area ?? 1;
    const m = e.meshes.get(rec.mesh.uuid) ?? { mesh: rec.mesh, area: 0 };
    m.area += rec.area ?? 1; e.meshes.set(rec.mesh.uuid, m);
  }
  const brown = (p) => (p[2] > 1e-5 ? p[0] / p[2] : 0);
  const ranked = cls.filter((e) => e.n > 0).sort((x, y) => brown(y.pal) * Math.log1p(y.area) - brown(x.pal) * Math.log1p(x.area));
  const out = ranked.slice(0, 6).map((e) => {
    const top = [...e.meshes.values()].sort((x, y) => y.area - x.area)[0];
    const mesh = top.mesh;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const raw = resolveMaterialSurface(mesh.material, mesh.name);
    const map = mat?.map ?? null;
    const bb = mesh.geometry?.boundingBox ?? (mesh.geometry?.computeBoundingBox?.(), mesh.geometry?.boundingBox);
    const box = bb ? bb.clone().applyMatrix4(mesh.matrixWorld) : null;
    return {
      cls: e.i, pal: e.pal, n: e.n, area: e.area, meshUuid: mesh.uuid, meshName: mesh.name, matName: mat?.name ?? mat?.type,
      resolved: [raw.color.r, raw.color.g, raw.color.b], base: [mat?.color?.r ?? 1, mat?.color?.g ?? 1, mat?.color?.b ?? 1],
      mapInfo: map ? `${map.isCompressedTexture ? "KTX2" : "cpu"} ${map.image?.width ?? "?"}×${map.image?.height ?? "?"}` : "none",
      box: box ? [[box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]] : null,
    };
  });
  return { classes: cls.length, live: ranked.length, top: out };
});
if (A.error) { console.log(`  (a) FAILED: ${A.error}`); }
else {
  console.log(`\n  (a) palette: ${A.live} live of ${A.classes} classes; most-brown × area:`);
  for (const t of A.top) {
    console.log(`    #${String(t.cls).padStart(2)} pal ${rgb(t.pal)} r/b ${f(rb(t.pal), 2)}  n ${t.n} area ${f(t.area, 0)}  ` +
      `mesh "${(t.meshName || "").slice(0, 22)}" mat ${t.matName} map ${t.mapInfo}`);
    console.log(`        resolved albedo ${rgb(t.resolved)} r/b ${f(rb(t.resolved), 2)}   base ${rgb(t.base)}   box ${t.box ? t.box.map((v) => v.map((x) => x.toFixed(1)).join(",")).join(" → ") : "—"}`);
  }
}

// ── (b)(c)(d) a fan of rays from the SAVED camera, every level-0 hit's face,
// grouped by the palette chroma the voxel carries (brown = r/b > 2.5) ────────
const B = await page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const ws = await import("/src/modules/gi/window/windowStore.js");
  const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
  const { createGi2FaceTermProbe } = await import("/scripts/lib/gi2FaceTermProbe.js");
  const nz = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const cam = await globalThis.__editorApi.call("viewport.getCamera", {});
  const eye = cam.position; const aim = cam.target ?? [eye[0], eye[1], eye[2] - 1];
  const fwd = nz([aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]]);
  const right = nz(cross(fwd, [0, 1, 0])); const up = nz(cross(right, fwd));
  const shoot = createGi2RayShooter(gi2, eng.renderer);
  const terms = createGi2FaceTermProbe(gi2, eng.renderer);
  const v0 = gi2.win.voxel0;
  const rays = [];
  for (let b = 0; b < 16; b++) {
    const ox = ((b % 4) - 1.5) * 0.06, oy = (Math.floor(b / 4) - 1.5) * 0.06;
    for (let i = -4; i <= 4; i++) for (let j = -3; j <= 3; j++) {
      const a = i * 0.24 + ox, c = j * 0.18 + oy;
      rays.push({ o: eye, d: nz([fwd[0] + right[0] * a + up[0] * c, fwd[1] + right[1] * a + up[1] * c, fwd[2] + right[2] * a + up[2] * c]), tMax: 40 });
    }
  }
  const hits = [];
  for (let k = 0; k < rays.length; k += 63) hits.push(...await shoot(rays.slice(k, k + 63)));
  const winW = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
  const faceByte = (x, y, z) => { const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12); return (winW[ws.FACE_OFF + (i >> 2)] >>> ((i & 3) * 8)) & 255; };
  const occAt = (x, y, z) => { const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12); return (winW[ws.OCC_OFF + (i >> 5)] >>> (i & 31)) & 1; };
  const faces = []; let miss = 0, notL0 = 0, badCell = 0; const seen = new Set();
  for (let k = 0; k < hits.length; k++) {
    const h = hits[k]; if (!h.hit) { miss++; continue; } if (h.level !== 0) { notL0++; continue; }
    const d = rays[k].d; const t = h.t + 0.02;
    const cell = [eye[0] + d[0] * t, eye[1] + d[1] * t, eye[2] + d[2] * t].map((x) => Math.floor(x / v0));
    const vi = (cell[0] & 63) | ((cell[1] & 63) << 6) | ((cell[2] & 63) << 12);
    if (vi !== h.voxelIdx) { badCell++; continue; }
    if (seen.has(`${cell}`)) continue; seen.add(`${cell}`);
    const code = (faceByte(cell[0], cell[1], cell[2]) >>> 6) & 3; if (!code) continue;
    const ax = code - 1; const e = [0, 0, 0]; e[ax] = 1;
    const occP = occAt(cell[0] + e[0], cell[1] + e[1], cell[2] + e[2]); const occN = occAt(cell[0] - e[0], cell[1] - e[1], cell[2] - e[2]);
    const sideF = (!occP && occN) ? 0 : (!occN && occP) ? 1 : (d[ax] <= 0 ? 0 : 1);
    const nrm = [0, 0, 0]; nrm[ax] = sideF === 0 ? 1 : -1;
    faces.push({ p: [(cell[0] + 0.5) * v0 + nrm[0] * v0 * 0.5, (cell[1] + 0.5) * v0 + nrm[1] * v0 * 0.5, (cell[2] + 0.5) * v0 + nrm[2] * v0 * 0.5], n: nrm, level: 0, voxelIdx: vi, face: 2 * ax + sideF, cell });
  }
  if (!faces.length) return { error: "no level-0 faces", miss, notL0, badCell, hits: hits.length, eye, aim };
  const rows = await terms(faces.slice(0, 4096));
  return { eye, aim, v0, miss, notL0, badCell, hits: hits.length, rows: rows.map((r) => ({ face: r.face, albedo: r.albedo, Esun: r.Esun, sunVis: r.sunVis, Enee: r.Enee, stored: r.stored, storedValid: r.storedValid, Erc: r.Erc, ercValid: r.ercValid, Efield: r.Efield })), diag: rows.diag };
});
if (B.error) { console.log(`  (b-d) FAILED: ${JSON.stringify(B).slice(0, 300)}`); }
else {
  const mean = (arr, pick) => { const s = [0, 0, 0]; let n = 0; for (const r of arr) { const v = pick(r); if (!v) continue; s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; n++; } return n ? s.map((x) => x / n) : null; };
  console.log(`\n  saved camera eye ${B.eye.map((x) => x.toFixed(1))} → ${B.aim.map((x) => x.toFixed(1))}  v0 ${f(B.v0, 3)}  rays ${B.hits} miss ${B.miss} notL0 ${B.notL0} badCell ${B.badCell}  faces ${B.rows.length}  diag ${JSON.stringify(B.diag)}`);
  const groups = { "brown r/b>2.5": (r) => rb(r.albedo) > 2.5, "neutral r/b<1.3": (r) => rb(r.albedo) < 1.3 };
  for (const [name, sel] of Object.entries(groups)) {
    const g = B.rows.filter(sel); const lit = g.filter((r) => r.sunVis > 0.5); const pop = lit.length ? lit : g;
    if (!g.length) { console.log(`  ${name}: none`); continue; }
    const pal = mean(pop, (r) => r.albedo), esun = mean(pop, (r) => r.Esun), enee = mean(pop, (r) => r.Enee);
    const E = esun.map((x, i) => x + enee[i]); const hit = pal.map((x, i) => (Math.min(x, 0.9) / Math.PI) * E[i]);
    const stored = mean(pop.filter((r) => r.storedValid > 0), (r) => r.stored); const erc = mean(pop.filter((r) => r.ercValid > 0), (r) => r.Erc);
    console.log(`  ── ${name}: ${g.length} faces, ${lit.length} sun-lit (population = ${lit.length ? "sun-lit" : "all"})`);
    console.log(`    (b) voxel palette albedo ${rgb(pal)} r/b ${f(rb(pal), 2)}`);
    console.log(`    (c) face cache Esun ${rgb(esun)} Enee ${rgb(enee)} → E ${rgb(E)} r/b ${f(rb(E), 2)}; stored ${rgb(stored)} r/b ${f(rb(stored), 2)} (${pop.filter((r) => r.storedValid > 0).length} valid); E_rc ${rgb(erc)} (${pop.filter((r) => r.ercValid > 0).length} valid)`);
    console.log(`    (d) hit radiance albedo/π·E ${rgb(hit)} r/b ${f(rb(hit), 2)};  field at face ${rgb(mean(pop, (r) => r.Efield))} r/b ${f(rb(mean(pop, (r) => r.Efield)), 2)}`);
  }
}

// ── (e) the street pixels' indirect chroma ────────────────────────────────
const shotOf = async (name) => {
  const s = await call("viewport.screenshot", { width: 640, height: 400 });
  if (!s.ok) { console.log(`  screenshot failed: ${s.error}`); return null; }
  const b64 = s.value?.__image?.base64;
  if (!b64) return null;
  if (process.env.SHOT) fs.writeFileSync(`${OUT}/colour-chain-${name}.png`, Buffer.from(b64, "base64"));
  return b64;
};
const meanOf = async (b64, y0, y1) => page.evaluate(async ({ b64, y0, y1 }) => {
  const img = new Image(); img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
  const cx = cv.getContext("2d"); cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, Math.floor(img.height * y0), img.width, Math.floor(img.height * (y1 - y0))).data;
  const s = [0, 0, 0]; let n = 0;
  for (let i = 0; i < d.length; i += 4) { s[0] += Math.pow(d[i] / 255, 2.2); s[1] += Math.pow(d[i + 1] / 255, 2.2); s[2] += Math.pow(d[i + 2] / 255, 2.2); n++; }
  return s.map((x) => x / n);
}, { b64, y0, y1 });
const lit = await shotOf("lit");
if (lit) {
  console.log(`\n  (e) lit frame — wall band (rows 30-60 %) ${rgb(await meanOf(lit, 0.3, 0.6))}   street band (rows 78-98 %) ${rgb(await meanOf(lit, 0.78, 0.98))}`);
}
await page.evaluate(() => { globalThis.__giDebugView = "indirect"; });
await wait(2500);
const ind = await shotOf("indirect");
if (ind) {
  const wall = await meanOf(ind, 0.3, 0.6); const street = await meanOf(ind, 0.78, 0.98);
  console.log(`  (e) INDIRECT view — wall band ${rgb(wall)} r/b ${f(rb(wall), 2)}   street band ${rgb(street)} r/b ${f(rb(street), 2)}`);
}
await page.evaluate(() => { globalThis.__giDebugView = "off"; });
if (lines.length) { console.log(`\n  console:`); for (const l of lines.slice(0, 12)) console.log(`    ${l}`); }
await browser.close();
