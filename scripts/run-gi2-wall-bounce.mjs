// GI2 WALL BOUNCE — §19 6.33c: what a sun-lit brown wall deposits and what the street beneath it receives.
// Run: POSE="eye|aim" node scripts/run-gi2-wall-bounce.mjs http://127.0.0.1:5207/
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { reportEmitterSeats } from "./lib/gi2EmitterWait.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5207/";
const POSE = (process.env.POSE ?? "14,4,-42|14,4,-32.6").split("|").map((v) => v.split(",").map(Number));
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
  if (/palette|retint|bounce albedo|Basis|KTX2|transcode|sun slot|light input|lights/i.test(t)) lines.push(t.slice(0, 220));
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


console.log(`\n══ ${SCENE} — the brown wall's bounce onto the street ═══════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{ const dl = Date.now() + 240000; while (Date.now() < dl && !firstLight) await wait(250); }
console.log(`  first light ${firstLight ? "yes" : "NEVER"}`);
await reportEmitterSeats(page);
{ const dl = Date.now() + 90000; while (Date.now() < dl && !retintTex) await wait(500); }
console.log(`  texture-average re-tints seen: ${retintTex} — settling ${SETTLE}s`);
await wait(SETTLE * 1000);

const R = await page.evaluate(async ({ eye, aim, teleport }) => {
  const eng = globalThis.__giEngineForProbe; const sys = globalThis.__giSys(); const gi2 = globalThis.__gi2();
  const ws = await import("/src/modules/gi/window/windowStore.js");
  const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
  const { createGi2FaceTermProbe } = await import("/scripts/lib/gi2FaceTermProbe.js");
  const nz = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const log = [];
  // ── 1. TELEPORT (skip with POSE="") THEN WAIT FOR THE WINDOW TO SETTLE: scrolls still, voxelizer dirty drained.
  const stat = async () => { try { return await gi2.stats(eng.renderer); } catch { return null; } };
  if (teleport) {
  await globalThis.__editorApi.call("viewport.setCamera", { position: eye, target: aim });
  let s0 = await stat(); let still = 0; const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 400));
    const s1 = await stat();
    const same = s1 && s0 && s1.scrolls === s0.scrolls && (s1.voxelizer?.dirty ?? 0) === 0;
    still = same ? still + 1 : 0; s0 = s1;
    if (still >= 5) break;
  }
  log.push(`window settled after ${((Date.now() - t0) / 1000).toFixed(1)}s: scrolls ${s0?.scrolls} voxDirty ${s0?.voxelizer?.dirty ?? "?"} gather frame ${gi2.gather.frame}`);
  } else {
    const m = eng.camera.matrixWorld.elements;
    eye = [m[12], m[13], m[14]];
    const f0 = nz([-m[8], -m[9], -m[10]]);
    aim = [eye[0] + f0[0], eye[1] + f0[1], eye[2] + f0[2]];
    log.push(`no teleport — saved camera eye ${eye.map((v) => v.toFixed(1))} fwd ${f0.map((v) => v.toFixed(2))}`);
  }
  const shoot = createGi2RayShooter(gi2, eng.renderer);
  const terms0 = createGi2FaceTermProbe(gi2, eng.renderer);
  // readiness by RESULT, not attempt count: re-issue until the kernel's own `ran` stamp lands on every row.
  const terms = async (faces) => {
    for (let k = 0; k < 8; k++) {
      const rows = await terms0(faces);
      const ok = rows.filter((r) => r.ran > 0).length;
      if (ok === rows.length && rows.length) return rows;
      log.push(`  terms try ${k + 1}: ${ok}/${rows.length} rows stamped — waiting 30 gather frames`);
      const f0 = gi2.gather.frame; const dl = Date.now() + 20000;
      while (gi2.gather.frame - f0 < 30 && Date.now() < dl) await new Promise((r) => setTimeout(r, 50));
    }
    return await terms0(faces);
  };
  const v0 = gi2.win.voxel0;
  const sd = sys._giSunNodes.dir.value; const toSun = nz([-sd.x, -sd.y, -sd.z]); const sunCol = sys._giSunNodes.color.value;
  const winW = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
  const faceByte = (x, y, z) => { const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12); return (winW[ws.FACE_OFF + (i >> 2)] >>> ((i & 3) * 8)) & 255; };
  const occAt = (x, y, z) => { const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12); return (winW[ws.OCC_OFF + (i >> 5)] >>> (i & 31)) & 1; };
  const eyeCell = () => eye.map((v) => Math.floor(v / v0));
  if (occAt(eyeCell()[0], eyeCell()[1], eyeCell()[2])) {
    const back = nz([eye[0] - aim[0], eye[1] - aim[1], eye[2] - aim[2]]);
    for (let st = 1; st <= 4 && occAt(eyeCell()[0], eyeCell()[1], eyeCell()[2]); st++) {
      eye = [eye[0] + back[0], eye[1] + back[1], eye[2] + back[2]];
      log.push(`  eye was inside a solid voxel — stepped back ${st} m to ${eye.map((v) => v.toFixed(1))}`);
    }
  }
  const recOf = (cell, hint, forceAx = -1) => {
    const code = (faceByte(cell[0], cell[1], cell[2]) >>> 6) & 3; const ax = forceAx >= 0 ? forceAx : (code ? code - 1 : -1);
    if (ax < 0) return null;
    const e = [0, 0, 0]; e[ax] = 1;
    const occP = occAt(cell[0] + e[0], cell[1] + e[1], cell[2] + e[2]); const occN = occAt(cell[0] - e[0], cell[1] - e[1], cell[2] - e[2]);
    const sideF = (!occP && occN) ? 0 : (!occN && occP) ? 1 : (hint[ax] >= 0 ? 0 : 1);
    const nrm = [0, 0, 0]; nrm[ax] = sideF === 0 ? 1 : -1;
    const vi = (cell[0] & 63) | ((cell[1] & 63) << 6) | ((cell[2] & 63) << 12);
    return { p: [(cell[0] + 0.5) * v0 + nrm[0] * v0 * 0.5, (cell[1] + 0.5) * v0 + nrm[1] * v0 * 0.5, (cell[2] + 0.5) * v0 + nrm[2] * v0 * 0.5], n: nrm, level: 0, voxelIdx: vi, face: 2 * ax + sideF, cell };
  };
  const hitCell = (o, d, h) => { const t = h.t + 0.02; return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t].map((x) => Math.floor(x / v0)); };
  const runRays = async (rs) => { const out = []; for (let k = 0; k < rs.length; k += 63) out.push(...await shoot(rs.slice(k, k + 63))); return out; };
  // ── 2. THE WALL: a fan from the eye at the wall, level-0 hits only.
  const fwd = nz([aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]]); const right = nz(cross(fwd, [0, 1, 0])); const up = nz(cross(right, fwd));
  const fan = [];
  for (let i = -6; i <= 6; i++) for (let j = -4; j <= 4; j++) fan.push({ o: eye, d: nz([fwd[0] + right[0] * i * 0.09 + up[0] * j * 0.09, fwd[1] + right[1] * i * 0.09 + up[1] * j * 0.09, fwd[2] + right[2] * i * 0.09 + up[2] * j * 0.09]), tMax: 30 });
  let fh = await runRays(fan);
  for (let t = 0; t < 10 && !fh.some((h) => h.hit); t++) {
    const st = await stat();
    log.push(`  fan try ${t + 1}: 0/${fh.length} hits — voxDirty ${st?.voxelizer?.dirty} scrolls ${st?.scrolls} — waiting 5s`);
    await new Promise((r) => setTimeout(r, 5000));
    fh = await runRays(fan);
  }
  const seen = new Set(); const wallFaces = [];
  for (let k = 0; k < fh.length; k++) { const h = fh[k]; if (!h.hit || h.level !== 0) continue; const c = hitCell(eye, fan[k].d, h); if (seen.has(`${c}`)) continue; seen.add(`${c}`); const r = recOf(c, fan[k].d.map((x) => -x)); if (r && r.n[1] === 0) wallFaces.push(r); }
  if (!wallFaces.length) {
    let occ = 0; for (let x = 0; x < 128; x++) for (let y = 0; y < 99; y++) for (let z = 0; z < 128; z++) occ += occAt(x, y, z);
    const one = (await shoot([{ o: eye, d: fwd, tMax: 60 }]))[0];
    const ec = eyeCell(); const wc = [14, 7, -27].map((v) => Math.floor(v / v0));
    return { error: "no vertical level-0 faces in the fan", log, hits: fh.filter((h) => h.hit).length, l0: fh.filter((h) => h.hit && h.level === 0).length, occ, eyeCell: ec, eyeOcc: occAt(ec[0], ec[1], ec[2]), wallCell: wc, wallOcc: occAt(wc[0], wc[1], wc[2]), one };
  }
  const wallRows = await terms(wallFaces);
  const sunRays = wallFaces.map((f) => ({ o: [f.p[0] + f.n[0] * v0, f.p[1] + f.n[1] * v0, f.p[2] + f.n[2] * v0], d: toSun, tMax: 60 }));
  const sh = await runRays(sunRays);
  const rb = (a) => (a[2] > 1e-5 ? a[0] / a[2] : NaN);
  const wall = wallRows.map((r, i) => ({ ...r, ndl: Math.max(0, r.n[0] * toSun[0] + r.n[1] * toSun[1] + r.n[2] * toSun[2]), cpuClear: !sh[i].hit }));
  const sunlit = wall.filter((r) => r.cpuClear && r.ndl > 0.001);
  const mean = (arr, pick) => { const s = [0, 0, 0]; let n = 0; for (const r of arr) { const v = pick(r); if (!v) continue; s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; n++; } return n ? s.map((x) => x / n) : null; };
  const brown = wall.filter((r) => rb(r.albedo) > 2.5); const brownClear = brown.filter((r) => r.cpuClear && r.ndl > 0.001);
  const grp = (arr) => arr.length ? { n: arr.length, ran: arr.filter((r) => r.ran > 0).length, sunVisMean: arr.reduce((a, r) => a + r.sunVis, 0) / arr.length, ndl: arr.reduce((a, r) => a + r.ndl, 0) / arr.length, albedo: mean(arr, (r) => r.albedo), Esun: mean(arr, (r) => r.Esun), Enee: mean(arr, (r) => r.Enee), Erc: mean(arr.filter((r) => r.ercValid > 0), (r) => r.Erc), stored: mean(arr.filter((r) => r.storedValid > 0), (r) => r.stored), field: mean(arr, (r) => r.Efield), faces: arr.reduce((o, r) => (o[r.face] = (o[r.face] ?? 0) + 1, o), {}) } : null;
  // ── 3. THE GROUND within 3 m of the brown wall, facing it.
  const src = brownClear.length ? brownClear : brown;
  const groundRec = new Map();
  for (const f of src.slice(0, 40)) for (const off of [0.75, 1.5, 2.5]) {
    const o = [f.p[0] + f.n[0] * off, f.p[1] + 0.3, f.p[2] + f.n[2] * off];
    const dh = (await shoot([{ o, d: [0, -1, 0], tMax: 12 }]))[0];
    if (!dh.hit || dh.level !== 0) continue;
    const c = hitCell(o, [0, -1, 0], dh); const r = recOf(c, [0, 1, 0], 1); if (!r || r.n[1] !== 1) continue; groundRec.set(`${c}`, { ...r, off });
  }
  const groundFaces = [...groundRec.values()];
  const groundRows = groundFaces.length ? await terms(groundFaces) : [];
  // ── 4. Ω: cosine-weighted hemisphere from the ground points — the fraction whose hit voxel is brown.
  let omega = null;
  if (groundFaces.length) {
    const pts = groundFaces.slice(0, 6); const hemi = [];
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let pi = 0; pi < pts.length; pi++) for (let k = 0; k < 63; k++) { const u1 = rnd(), u2 = rnd(); const rr = Math.sqrt(u1); const ph = 2 * Math.PI * u2; hemi.push({ o: [pts[pi].p[0], pts[pi].p[1] + v0, pts[pi].p[2]], d: [rr * Math.cos(ph), Math.sqrt(1 - u1), rr * Math.sin(ph)], tMax: 60 }); }
    const hh = await runRays(hemi);
    const recs = [];
    for (let k = 0; k < hh.length; k++) { const h = hh[k]; if (!h.hit) continue; const c = hitCell(hemi[k].o, hemi[k].d, h); const lv = h.level; const cellL = c.map((x) => x >> lv); const vi = (cellL[0] & 63) | ((cellL[1] & 63) << 6) | ((cellL[2] & 63) << 12); recs.push({ p: [hemi[k].o[0] + hemi[k].d[0] * h.t, hemi[k].o[1] + hemi[k].d[1] * h.t, hemi[k].o[2] + hemi[k].d[2] * h.t], n: hemi[k].d.map((x) => -x), level: lv, voxelIdx: vi, face: 0 }); }
    const hr = recs.length ? await terms(recs) : [];
    let brownHits = 0, hits = 0; const miss = hh.length - recs.length; const lvl = {};
    for (let i = 0; i < hr.length; i++) { hits++; lvl[recs[i].level] = (lvl[recs[i].level] ?? 0) + 1; if (rb(hr[i].albedo) > 2.5) brownHits++; }
    omega = { rays: hh.length, miss, hits, brownHits, fBrown: brownHits / hh.length, fSky: miss / hh.length, lvl };
  }
  return { log, eye, aim, toSun, sunCol: [sunCol.x, sunCol.y, sunCol.z], wallN: wall.length, brownN: brown.length, brownClearN: brownClear.length, clearAll: wall.filter((r) => r.cpuClear && r.ndl > 0.001).length,
    brownClear: grp(brownClear), brownAll: grp(brown), neutralWall: grp(wall.filter((r) => rb(r.albedo) < 1.3)),
    ground: grp(groundRows), groundN: groundFaces.length, sunlit: grp(sunlit), sunlitN: sunlit.length, omega };
}, { eye: POSE[0], aim: POSE[1], teleport: (process.env.POSE ?? "") !== "" });
if (R.error) { console.log(`  FAILED: ${JSON.stringify(R).slice(0, 700)}`); }
else {
  for (const l of R.log) console.log(`  ${l}`);
  console.log(`  sun toSun ${rgb(R.toSun)} colour ${rgb(R.sunCol)}   wall faces ${R.wallN}: brown ${R.brownN}, brown+clear+facing ${R.brownClearN} (clear+facing any ${R.clearAll})`);
  const pg = (name, g) => { if (!g) { console.log(`  ${name}: none`); return; } console.log(`  ${name}: n ${g.n} ran ${g.ran} faces ${JSON.stringify(g.faces)} ndl ${f(g.ndl, 2)}\n     albedo ${rgb(g.albedo)} r/b ${f(rb(g.albedo), 2)}  sunVis ${f(g.sunVisMean, 2)}  Esun ${rgb(g.Esun)}  Enee ${rgb(g.Enee)}\n     E_rc ${rgb(g.Erc)} r/b ${f(rb(g.Erc), 2)}  stored word ${rgb(g.stored)} r/b ${f(rb(g.stored), 2)}  field(gatherAt) ${rgb(g.field)} r/b ${f(rb(g.field), 2)}`); };
  pg("(1) BROWN wall faces, CPU-clear to the sun", R.brownClear);
  pg("    brown wall faces, all", R.brownAll);
  pg("    neutral wall faces", R.neutralWall);
  pg(`(1b) SUNLIT faces (CPU ray clear, ndl>0.001)`, R.sunlit);
  pg(`(2) GROUND within 3 m facing the wall (${R.groundN} faces)`, R.ground);
  if (R.omega) {
    const o = R.omega; console.log(`  (3) hemisphere from the ground: ${o.rays} cosine rays — sky ${f(o.fSky, 3)}, hits ${o.hits} (levels ${JSON.stringify(o.lvl)}), brown-wall hits ${o.brownHits} → f = Ω/π = ${f(o.fBrown, 3)}`);
    const alb = R.brownClear?.albedo ?? R.brownAll?.albedo ?? [0.337, 0.125, 0.069];
    const Esun = R.brownClear?.Esun ?? [0, 0, 0]; const Erc = R.brownClear?.Erc ?? R.brownAll?.Erc ?? [1.3, 1.3, 1.3];
    const sky = R.ground?.Erc ?? [1.3, 1.3, 1.3];
    const expect = (E) => [0, 1, 2].map((i) => (1 - o.fBrown) * sky[i] + o.fBrown * alb[i] * (E[i] + Erc[i]));
    const cosT = R.brownClear?.ndl ?? 0.5;
    const gMeas = expect(Esun); const gSun = expect(R.sunCol.map((c) => c * cosT));
    console.log(`      expected ground r/b with the MEASURED wall E (Esun ${rgb(Esun)} + E_rc ${rgb(Erc)}): ${f(rb(gMeas), 3)}   with a FULLY sun-lit wall (10·cosθ, cosθ ${f(cosT, 2)}): ${f(rb(gSun), 3)}   measured ground field r/b ${f(rb(R.ground?.field ?? [0, 0, 1]), 3)}, ground E_rc r/b ${f(rb(R.ground?.Erc ?? [0, 0, 1]), 3)}`);
  }
}
const dl = lines.filter((l) => l.includes("debug view"));
if (dl.length) console.log(["  indirect view receipt:"].concat(dl.slice(-3)).join(" | "))
const s = await call("viewport.screenshot", { width: 640, height: 400 });
if (s.ok && s.value?.__image?.base64) fs.writeFileSync(`${OUT}/wall-bounce-lit.png`, Buffer.from(s.value.__image.base64, "base64"));
await page.evaluate(() => { globalThis.__giDebugView = "indirect"; }); await wait(15000);
const s2 = await call("viewport.screenshot", { width: 640, height: 400 });
if (s2.ok && s2.value?.__image?.base64) fs.writeFileSync(`${OUT}/wall-bounce-indirect.png`, Buffer.from(s2.value.__image.base64, "base64"));
if (lines.length) { console.log(`\n  console:`); for (const l of lines.slice(0, 6)) console.log(`    ${l}`); }
await browser.close();
