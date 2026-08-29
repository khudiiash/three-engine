// §19 6.23 — THE SCALED-LAMP TEST: an emitter's GI seat is a function of its
// CURRENT world matrix, scale included.
//
//   SCENE=Cornel node scripts/run-gi-scaled-lamp-test.mjs http://127.0.0.1:5203/
//
// Boots the scene, waits for first light, aims the cornell-ref pose, then reads
// the admitted emitter's SEAT (radius / reff / exHalf / colour), the dynamic
// layer's receipt (`profile.gi2` movers / voxelsSet) and the PCSS visibility
// ramp on the wall behind the occluder (rcDirect's filtered visA, slot 0, along
// a vertical line through the occluder's shadow). Then it scales the lamp's
// ENTITY by `SCALE` through the editor's own `entity.setTransform` (the gizmo's
// path) and re-reads after 1 s and 4 s.
//
// GATES (PASS = all):
//   · reff and radius scale by SCALE (±10 %), exHalf likewise
//   · the seat colour (radiance L) is UNCHANGED — power grows through AREA
//   · the direct shadow on the wall RESPONDED (ramp wider, or the shadowed
//     median visibility moved) — every sample validated against the gbuffer
//   · the lamp entered the dynamic layer (movers > 0) — its voxels follow it
//   · the ADMISSION GATE re-ran with SCALE^2 x the area (§19 6.23: the seat
//     followed the scale every frame already; the gate, the ledger and the
//     palette did not, because world scale was not part of the fingerprint)
//
// Env: SCENE, SCALE (default 2), SETTLE (s, default 8), OUT=<png prefix>, WALL.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { installWebGpuErrorLog } from "./lib/webgpuErrorLog.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5203/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const SCENE_PATH = SCENE.includes("/") || SCENE.includes("\\") ? SCENE.replaceAll("\\", "/") : `${PROJECT}/scenes/${SCENE}.scene`;
const SCALE = Number(process.env.SCALE ?? 2);
const SETTLE = Number(process.env.SETTLE ?? 8);
const OUT = process.env.OUT ?? "";
// NOT the cornell-ref pose: the lamp sits between that eye and the back wall,
// and at x2 it fills the frame - every "wall" pixel was then the lamp itself
// (vis 1, a blind instrument). This eye looks over the lamp from the upper
// left; samples are ALSO validated against the gbuffer (below).
const POSE = (process.env.POSE ?? "-2.2,5.0,3.4|0.9,1.4,-1.4").split("|").map((s) => s.split(",").map(Number));
const WALL = process.env.WALL ?? "back";
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
await page.evaluateOnNewDocument((flags) => { for (const [k, v] of Object.entries(flags)) globalThis[k] = v; }, JSON.parse(process.env.FLAGS ?? "{}"));
await installWebGpuErrorLog(page);
await page.evaluateOnNewDocument((project) => {
  globalThis.__gi2Rc5 = true;
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
let firstLight = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (/emitter|admi|dynamic layer|seat|\[gi\].*(rror|ailed)/i.test(t)) console.log(`  ${t.slice(0, 200)}`);
  if (process.env.ALLCONSOLE && /error|wgsl|compil|shader|pipeline|rcDirect|undeclared|unresolved|exact shadow|bvh/i.test(t)) console.log(`  [console] ${t.slice(0, 600)}`);
  if (t.startsWith("[webgpu]") && (globalThis.__gpuErrN = (globalThis.__gpuErrN ?? 0) + 1) <= 4) console.log(`  ${t.slice(0, 1500)}`);
});
page.on("pageerror", (e) => console.log(`pageerror: ${e.message}`));
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
  globalThis.__gi2 = () => { const sys = globalThis.__giSys(); return sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null; };
});
const opened = await page.evaluate(async (path) => {
  try { return { ok: true, v: await globalThis.__editorApi.call("scene.open", { path }) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}, SCENE_PATH);
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
const t0 = Date.now();
while (!firstLight && Date.now() - t0 < 120000) await wait(250);
console.log(`first light ${firstLight ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen"}`);
await page.evaluate(async ({ p, t }) => {
  const vhm = await import("/src/editor/viewportHandle.js");
  const vh = vhm.getViewportHandle();
  globalThis.__giViewport = vh;
  vh.camera.position.set(p[0], p[1], p[2]);
  if (vh.orbit) { vh.orbit.target.set(t[0], t[1], t[2]); vh.orbit.update(); }
  else vh.camera.lookAt(t[0], t[1], t[2]);
  vh.camera.updateMatrixWorld(true);
}, { p: POSE[0], t: POSE[1] });
// §19 6.25f — WAIT FOR THE DIRECT TERM'S FIRST OUTPUT, NOT A FIXED SETTLE. The
// raw pass's pipeline can take tens of seconds to compile (6.25b: 4 slots x 14
// trace call sites); until its first dispatch lands, visA/penA are the zeros
// the textures were born with and the filter chain blurs them into a grey
// ramp — the "lit wall 0.3" of 6.25b-d was a read BEFORE the kernel ran.
{
  const tA = Date.now();
  let arrived = -1;
  for (let k = 0; k < 60; k++) {
    const nz = await page.evaluate(async () => {
      const gi2 = globalThis.__gi2(); const pt = gi2?.rc?.resolve?.direct?.penumbra ?? null; if (!pt) return -1;
      const { createGi2TexProbe } = await import("/scripts/lib/gi2TexProbe.js");
      if (globalThis.__tpPenTex !== pt) { globalThis.__tpPen = createGi2TexProbe({ renderer: globalThis.__giEngineForProbe.renderer, tex: pt }); globalThis.__tpPenTex = pt; }
      const w = pt.image?.width ?? 1, h = pt.image?.height ?? 1; const pts = [];
      for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) pts.push([Math.floor((i + 0.5) * w / 24), Math.floor((j + 0.5) * h / 24)]);
      const o = await globalThis.__tpPen.read(pts); let n = 0; for (const v of o) if (v > 0) n++; return n;
    });
    if (nz > 0) { arrived = (Date.now() - tA) / 1000; break; }
    await wait(1500);
  }
  console.log(`direct term first output ${arrived >= 0 ? `${arrived.toFixed(1)} s after the pose (penumbra texels > 0)` : "NOT seen in 90 s"}`);
}
await wait(SETTLE * 1000);

const shoot = async (name) => {
  if (!OUT) return;
  const shot = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.viewport.screenshot({ width: 960, height: 640, includeGizmos: false });
    const img = typeof r === "string" ? r : (r?.__image ?? r?.png ?? r?.dataUrl ?? r?.image ?? r);
    return typeof img === "string" ? img : (img?.data ?? img?.base64 ?? img?.png ?? img?.dataUrl ?? "");
  });
  const b64 = String(shot).replace(/^data:image\/png;base64,/, "");
  if (/^[A-Za-z0-9+/=]+$/.test(b64) && b64.length > 1000) { writeFileSync(`${OUT}-${name}.png`, Buffer.from(b64, "base64")); console.log(`wrote ${OUT}-${name}.png`); }
};

// ── one reading: seat, dynamic-layer receipt, wall visibility line ──────────
const READ = async ({ WALL }) => {
  const eng = globalThis.__giEngineForProbe;
  const sys = globalThis.__giSys();
  const gi2 = globalThis.__gi2();
  const vh = globalThis.__giViewport;
  const out = {};
  // seat
  const slots = (sys.state.emitterSlots ?? []).map((s, i) => ({
    slot: i, center: s.center?.value?.toArray?.().map((v) => +v.toFixed(3)), radius: +(s.radius?.value ?? 0).toFixed(4),
    reff: +(s.reff?.value ?? 0).toFixed(4), half: s.half?.value?.toArray?.().map((v) => +v.toFixed(4)),
    exHalf: s.exHalf?.value?.toArray?.().map((v) => +v.toFixed(4)), rgb: s.color?.value?.toArray?.().map((v) => +v.toFixed(3)),
    kind: s.kind?.value, moved: +(s.moved?.value ?? 0).toFixed(3),
  })).filter((s) => s.radius > 1e-5);
  out.slots = slots;
  // the lamp mesh + its entity
  const emEntry = (sys.state.entries ?? []).find((e) => (e.peak ?? 0) > 0.5 && e.mesh);
  const lamp = emEntry?.mesh ?? null;
  let entityId = null;
  if (lamp) {
    for (let o = lamp; o && !entityId; o = o.parent) if (o.userData?.entityId) entityId = o.userData.entityId;
  }
  out.lamp = lamp ? { name: lamp.name, entityId, scale: lamp.getWorldScale(new (lamp.position.constructor)()).toArray().map((v) => +v.toFixed(3)) } : null;
  const adm = lamp ? sys._emitterAdmissionByMesh?.get(lamp) : null;
  out.admitted = lamp ? { candidate: sys._emitterCandidateMeshes?.has(lamp) ?? null, admitted: sys._emitterAdmittedMeshes?.has(lamp) ?? null, fill: sys._emitterFillByMesh?.get(lamp) ?? null,
    area: adm ? +adm.area.toFixed(2) : null, power: adm ? +adm.power.toFixed(1) : null, gateAgeMs: sys._emitterAdmissionAt ? Math.round(performance.now() - sys._emitterAdmissionAt) : null } : null;
  // dynamic layer
  try {
    const st = await globalThis.__editorApi.call("profile.gi2", {});
    const pick = (o) => o && typeof o === "object" ? o : null;
    out.gi2 = { movers: st?.counters?.movers ?? st?.movers ?? null, moverTris: st?.counters?.moverTris ?? null,
      voxelsSet: st?.dynamic?.voxelsSet ?? pick(st?.dynamic)?.voxelsSet ?? null, dynamic: st?.dynamic ?? null };
  } catch (e) { out.gi2 = String(e?.message ?? e); }
  out.moversLive = (sys._gi2Movers ?? []).map((m) => m.mesh?.name ?? "?");
  out.promoted = [...(sys._gi2Promoted ?? [])].map((m) => m.name);
  // geometry for the wall line
  if (!slots.length) return { ...out, error: "no active seat" };
  const boxes = [];
  for (const e of sys.state.entries ?? []) {
    const m = e.mesh; if (!m?.geometry) continue;
    m.geometry.computeBoundingBox?.();
    const bb = m.geometry.boundingBox; if (!bb) continue;
    const me = m.matrixWorld.elements;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? bb.max.x : bb.min.x, y = c & 2 ? bb.max.y : bb.min.y, z = c & 4 ? bb.max.z : bb.min.z;
      const w = [me[0] * x + me[4] * y + me[8] * z + me[12], me[1] * x + me[5] * y + me[9] * z + me[13], me[2] * x + me[6] * y + me[10] * z + me[14]];
      for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], w[i]); mx[i] = Math.max(mx[i], w[i]); }
    }
    boxes.push({ name: m.name, mn, mx, peak: e.peak ?? 0 });
  }
  const L = slots[0].center;
  const vol = (b) => (b.mx[0] - b.mn[0]) * (b.mx[1] - b.mn[1]) * (b.mx[2] - b.mn[2]);
  const nonEm = boxes.filter((b) => b.peak < 0.5);
  const thin = (b) => Math.min(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]) < 0.2;
  const walls = nonEm.filter(thin);
  const occ = nonEm.filter((b) => !thin(b)).reduce((a, b) => (a && vol(a) > vol(b) ? a : b), null);
  if (!occ || !walls.length) return { ...out, error: "no occluder/walls" };
  const S = { mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity] };
  for (const w of walls) for (let i = 0; i < 3; i++) { S.mn[i] = Math.min(S.mn[i], w.mn[i]); S.mx[i] = Math.max(S.mx[i], w.mx[i]); }
  for (let i = 0; i < 3; i++) { S.mn[i] += 0.1; S.mx[i] -= 0.1; }
  let plane;
  if (WALL === "back") plane = { axis: 2, v: S.mn[2] + 0.01 };
  else if (WALL === "left") plane = { axis: 0, v: S.mn[0] + 0.01 };
  else if (WALL === "right") plane = { axis: 0, v: S.mx[0] - 0.01 };
  else plane = { axis: 1, v: S.mn[1] + 0.01 };
  const segHitsBox = (a, b, box) => {
    let t0 = 0, t1 = 1;
    for (let i = 0; i < 3; i++) {
      const d = b[i] - a[i];
      if (Math.abs(d) < 1e-9) { if (a[i] < box.mn[i] || a[i] > box.mx[i]) return false; continue; }
      let ta = (box.mn[i] - a[i]) / d, tb = (box.mx[i] - a[i]) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
    return true;
  };
  const cam = vh.camera; cam.updateMatrixWorld(true);
  const W = gi2.width ?? eng.renderer.domElement.width, H = gi2.height ?? eng.renderer.domElement.height;
  const project = (P) => {
    const e = cam.matrixWorldInverse.elements;
    const vx = e[0] * P[0] + e[4] * P[1] + e[8] * P[2] + e[12];
    const vy = e[1] * P[0] + e[5] * P[1] + e[9] * P[2] + e[13];
    const vz = e[2] * P[0] + e[6] * P[1] + e[10] * P[2] + e[14];
    const q = cam.projectionMatrix.elements;
    const cx = q[0] * vx + q[4] * vy + q[8] * vz + q[12];
    const cy = q[1] * vx + q[5] * vy + q[9] * vz + q[13];
    const cw = q[3] * vx + q[7] * vy + q[11] * vz + q[15];
    if (!(cw > 1e-4)) return null;
    const px = ((cx / cw) * 0.5 + 0.5) * W, py = (0.5 - (cy / cw) * 0.5) * H;
    if (!(px >= 4 && py >= 4 && px < W - 4 && py < H - 4)) return null;
    return [px, py];
  };
  // a VERTICAL line on the wall through the occluder's centre (x), floor→ceiling
  const ax = [0, 1, 2].filter((i) => i !== plane.axis);
  const N = 160;
  const line = [];
  const cx0 = (occ.mn[0] + occ.mx[0]) / 2;
  for (let j = 0; j <= N; j++) {
    const P = [0, 0, 0]; P[plane.axis] = plane.v;
    P[0] = plane.axis === 0 ? P[0] : cx0;
    P[1] = S.mn[1] + (S.mx[1] - S.mn[1]) * (j / N);
    if (plane.axis === 1) { P[1] = plane.v; P[2] = S.mn[2] + (S.mx[2] - S.mn[2]) * (j / N); }
    const pix = project(P); if (!pix) continue;
    line.push({ P, pix, shadowed: segHitsBox(P, L, occ) });
  }
  void ax;
  // the grid of the ratio script, coarser
  const pts = [];
  const M = 30;
  for (let i = 1; i < M; i++) for (let j = 1; j < M; j++) {
    const P = [0, 0, 0]; P[plane.axis] = plane.v;
    const a0 = [0, 1, 2].filter((k) => k !== plane.axis);
    P[a0[0]] = S.mn[a0[0]] + (S.mx[a0[0]] - S.mn[a0[0]]) * (i / M);
    P[a0[1]] = S.mn[a0[1]] + (S.mx[a0[1]] - S.mn[a0[1]]) * (j / M);
    const pix = project(P); if (!pix) continue;
    pts.push({ P, pix, shadowed: segHitsBox(P, L, occ) });
  }
  const vt = gi2.rc?.resolve?.direct?.texture ?? null;
  if (!vt) return { ...out, error: "no rcDirect visibility texture" };
  const { createGi2TexProbe } = await import("/scripts/lib/gi2TexProbe.js");
  const tp = createGi2TexProbe({ renderer: eng.renderer, tex: vt });
  for (let f = 0; f < 4; f++) await new Promise((r) => requestAnimationFrame(r));
  const all = [...line, ...pts];
  // CAN THE INSTRUMENT SEE ITS SUBJECT? Validate every sample against the
  // gbuffer's world position: a pixel whose surface is not the wall point
  // (the lamp in front of it, the block) is dropped, not read as "lit".
  let seen = all.map(() => true);
  try {
    const gp = gi2.gbuffer?.position ?? sys.state.screen?.gbuffer?.position ?? null;
    if (gp) {
      const pp = createGi2TexProbe({ renderer: eng.renderer, tex: gp });
      const sx = (gp.image?.width ?? W) / W, sy = (gp.image?.height ?? H) / H;
      const g = await pp.read(all.map((p) => [Math.round(p.pix[0] * sx), Math.round(p.pix[1] * sy)]));
      seen = all.map((p, i) => g[i * 4 + 3] > 0.5 && Math.hypot(g[i * 4] - p.P[0], g[i * 4 + 1] - p.P[1], g[i * 4 + 2] - p.P[2]) < 0.08);
      // the gbuffer may be stored bottom-up: if almost nothing matched, flip
      if (seen.filter(Boolean).length < all.length * 0.2) {
        const g2 = await pp.read(all.map((p) => [Math.round(p.pix[0] * sx), Math.round((H - p.pix[1]) * sy)]));
        const seen2 = all.map((p, i) => g2[i * 4 + 3] > 0.5 && Math.hypot(g2[i * 4] - p.P[0], g2[i * 4 + 1] - p.P[1], g2[i * 4 + 2] - p.P[2]) < 0.08);
        if (seen2.filter(Boolean).length > seen.filter(Boolean).length) { seen = seen2; out.gbufFlip = true; }
      }
    } else out.gbufCheck = "no gbuffer position texture";
  } catch (e) { out.gbufCheck = String(e?.message ?? e); }
  const o = await tp.read(all.map((p) => [Math.round(p.pix[0]) >> 1, Math.round(p.pix[1]) >> 1]));
  const vis = all.map((_, i) => (seen[i] ? o[i * 4] : NaN));
  const lineVis = vis.slice(0, line.length);
  // §19 6.25c — the FACE RECEIPT: debug 2 dumps (axis+10·[sign>0], F) per texel;
  // compare with the near face computed HERE from the seat's frame.
  if (globalThis.__faceDebug) {
    try {
      const dU = gi2.rc?.resolve?.direct?.uniforms?.rcDirectDebug, dU2 = gi2.rc?.uniforms?.rcDirectDebug;
      if (!dU && !dU2) throw new Error("no rcDirectDebug uniform");
      out.faceSame = dU === dU2;
      if (dU) dU.value = 2; if (dU2) dU2.value = 2;
      // the GI idles at rest: nudge the camera so the direct passes re-dispatch
      vh.camera.position.y += 0.003; vh.camera.updateMatrixWorld(true);
      for (let f = 0; f < 12; f++) await new Promise((r) => requestAnimationFrame(r));
      const dd = await tp.read(all.map((p) => [Math.round(p.pix[0]) >> 1, Math.round(p.pix[1]) >> 1]));
      if (dU) dU.value = 0; if (dU2) dU2.value = 0;
      vh.camera.position.y -= 0.003; vh.camera.updateMatrixWorld(true);
      for (let f = 0; f < 12; f++) await new Promise((r) => requestAnimationFrame(r));
      const s0 = sys.state.emitterSlots?.[0] ?? null;
      const sl = slots[0];
      const B = s0 ? [s0.bx.value.toArray(), s0.by.value.toArray(), s0.bz.value.toArray()] : null;
      const C = sl.center, EX = sl.exHalf;
      const rows = [];
      for (let i = 0; i < all.length && rows.length < 6; i++) {
        if (!seen[i] || !(vis[i] > 0.05)) continue;   // lit-ish texels
        if (rows.length && i % 7) continue;
        const P = all[i].P;
        const code = dd[i * 4], F = [dd[i * 4 + 1], dd[i * 4 + 2], dd[i * 4 + 3]];
        let hand = null;
        if (B) {
          const wv = [C[0] - P[0], C[1] - P[1], C[2] - P[2]]; const d = Math.hypot(...wv); const wd = wv.map((v) => v / d);
          const lds = B.map((b) => b[0] * wd[0] + b[1] * wd[1] + b[2] * wd[2]);
          const ratio = lds.map((l, k) => EX[k] / Math.max(1e-6, Math.abs(l)));
          const ax = ratio.indexOf(Math.min(...ratio));
          const sg = Math.sign(-lds[ax]);
          hand = { ax, sg, F: B[ax].map((b, m) => +(C[m] + b * sg * EX[ax]).toFixed(3)) };
        }
        rows.push({ P: P.map((v) => +v.toFixed(2)), vis: +vis[i].toFixed(3), code: +code.toFixed(1), F: F.map((v) => +v.toFixed(3)), hand });
      }
      out.faceRows = rows; out.faceB = B;
    } catch (e) { out.faceErr = String(e?.message ?? e); }
  }
  // §19 6.25b — the PCSS width W (metres, slot 0, dilated) at five wall texels
  try {
    const pt = gi2.rc?.resolve?.direct?.penumbra ?? null;
    if (pt) {
      const pp2 = createGi2TexProbe({ renderer: eng.renderer, tex: pt });
      const w = await pp2.read(line.map((p) => [Math.round(p.pix[0]) >> 1, Math.round(p.pix[1]) >> 1]));
      const ws = line.map((_, i) => (seen[i] ? +w[i * 4].toFixed(4) : NaN)).filter(Number.isFinite);
      const st = Math.max(1, Math.floor(ws.length / 5));
      out.penW = ws.filter((_, i) => i % st === 0).slice(0, 5);
      out.penWmax = ws.length ? Math.max(...ws) : null;
    } else out.penErr = "no penumbra texture";
  } catch (e) { out.penErr = String(e?.message ?? e); }
  // §19 6.25e — THE CPU INTERSECTION RECEIPT (FLAGS __cpuHit): the exact arm's
  // centre segment and the four quadrant segments for 5 seen wall texels,
  // brute-forced against the bound soup with the JS mirror of the GPU test.
  if (globalThis.__cpuHit) {
    try {
      const { triHit, bvhAnyHit } = await import("/scripts/lib/shadowBvhMirror.mjs");
      const bvh = gi2.shadowBvh ?? null;
      const tris = bvh?.tris ?? null;
      const s0 = sys.state.emitterSlots?.[0];
      if (!tris || !s0) throw new Error(`no soup tris (${!!tris}) / seat (${!!s0})`);
      const nT = tris.length / 9;
      const C = s0.center.value.toArray(), B = [s0.bx.value.toArray(), s0.by.value.toArray(), s0.bz.value.toArray()];
      const EX = s0.exHalf.value.toArray().map((v) => Math.max(Math.abs(v), 1e-4));
      const clear = Math.max(s0.radius.value, Math.max(s0.reff.value, 1e-3));
      const SP = globalThis.__giQuadSpread ?? 0.5;
      // lamp triangles = every triangle whose centroid lies inside the seat's OBB (+2 cm)
      const lampTris = [];
      for (let t = 0; t < nT; t++) {
        const o = t * 9; const cx = (tris[o] + tris[o + 3] + tris[o + 6]) / 3, cy = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3, cz = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
        const r = [cx - C[0], cy - C[1], cz - C[2]];
        const l = B.map((b) => Math.abs(b[0] * r[0] + b[1] * r[1] + b[2] * r[2]));
        if (l.every((v, i) => v <= EX[i] + 0.02)) lampTris.push(t);
      }
      const rows = [];
      const cand = line.map((p, i) => ({ p, i })).filter(({ i }) => seen[i]);
      const step = Math.max(1, Math.floor(cand.length / 5));
      for (let c = 0; c < cand.length && rows.length < 5; c += step) {
        const { p, i } = cand[c]; const P = p.P;
        const N = plane.axis === 2 ? [0, 0, 1] : plane.axis === 0 ? [WALL === "left" ? 1 : -1, 0, 0] : [0, 1, 0];
        const ro = [P[0] + N[0] * 2e-3, P[1] + N[1] * 2e-3, P[2] + N[2] * 2e-3];
        const wv = [C[0] - P[0], C[1] - P[1], C[2] - P[2]]; const d = Math.hypot(...wv); const wd = wv.map((v) => v / d);
        const ld = B.map((b) => Math.max(Math.abs(b[0] * wd[0] + b[1] * wd[1] + b[2] * wd[2]), 1e-6));
        const slab = Math.min(EX[0] / ld[0], EX[1] / ld[1], EX[2] / ld[2]);
        const reach = Math.max(d - Math.min(slab, clear) - Math.max(d * 1e-3, 2e-3), 1e-3);
        const hitsOf = (o, dir, maxT) => { const h = []; for (let t = 0; t < nT; t++) if (triHit(tris, t, o, dir, maxT)) h.push(t); return h; };
        const centreHits = hitsOf(ro, wd, reach);
        const treeHit = (bvh.nodes && bvh.triIdx) ? bvhAnyHit({ nodes: bvh.nodes, triIdx: bvh.triIdx }, tris, ro, wd, reach) : null;
        // the quadrant points (as the kernel computes them)
        const lds = B.map((b) => b[0] * wd[0] + b[1] * wd[1] + b[2] * wd[2]);
        const axq = EX.map((e, k) => e / ld[k]); const ax = axq.indexOf(Math.min(...axq));
        const sg = Math.sign(lds[ax]) || 1;
        const F = C.map((v, m) => v - B[ax][m] * sg * EX[ax]);
        const tU = B[ax === 0 ? 1 : 0], eU = EX[ax === 0 ? 1 : 0] * SP, tV = B[ax === 2 ? 1 : 2], eV = EX[ax === 2 ? 1 : 2] * SP;
        const quads = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => {
          const Q = SP < 0 ? C.map((v, m) => v - wd[m] * Math.min(slab, clear)) : F.map((v, m) => v + tU[m] * eU * a + tV[m] * eV * b);
          const w = [Q[0] - ro[0], Q[1] - ro[1], Q[2] - ro[2]]; const dq = Math.max(Math.hypot(...w), 1e-3); const dir = w.map((v) => v / dq);
          const mt = Math.max(dq - Math.max(dq * 1e-3, 2e-3), 1e-3);
          return { Q: Q.map((v) => +v.toFixed(3)), hits: hitsOf(ro, dir, mt) };
        });
        const tri = (t) => { const o = t * 9; return [...tris.slice(o, o + 9)].map((v) => +v.toFixed(2)); };
        rows.push({ P: P.map((v) => +v.toFixed(2)), vis: Number.isFinite(vis[i]) ? +vis[i].toFixed(3) : null, yzw: [1, 2, 3].map((c) => +o[i * 4 + c].toFixed(3)), d: +d.toFixed(3), slab: +slab.toFixed(3), clear: +clear.toFixed(3), reach: +reach.toFixed(3), tree: treeHit ? `${treeHit.hit}/${treeHit.visited}/${treeHit.tested}` : null,
          centreHits: centreHits.slice(0, 4).map((t) => ({ t, lamp: lampTris.includes(t), v: tri(t) })), quadHits: quads.map((q) => q.hits.length), Q0: quads[0].Q });
      }
      out.cpu = { nT, lampTris: lampTris.length, lampTriIds: lampTris.slice(0, 12), C: C.map((v) => +v.toFixed(3)), EX: EX.map((v) => +v.toFixed(3)), clear: +clear.toFixed(3), B, rows };
    } catch (e) { out.cpuErr = String(e?.message ?? e); }
  }
  // §19 6.25e — the raw pass's GENERATED WGSL (FLAGS __dumpRaw, WGSL_OUT=<file>)
  if (globalThis.__dumpRaw) {
    try {
      const rp = gi2.rc?.resolve?.direct?.passes?.[0];
      const st = eng.renderer._nodes?.getForCompute?.(rp);
      out.wgsl = st?.computeShader ?? null;
    } catch (e) { out.wgslErr = String(e?.message ?? e); }
  }
  // §19 6.25f — identities: is the texture read the one the LAST-built rawPass writes, and is that kernel in the frame?
  try {
    const last = globalThis.__rcDirectLast ?? null;
    const dir = gi2.rc?.resolve?.direct ?? null;
    const fl0 = typeof gi2.passes === "function" ? gi2.passes() : null; const frameList = Array.isArray(fl0) ? fl0 : Array.isArray(fl0?.computeNodes) ? fl0.computeNodes : Object.values(fl0 ?? {}).flat().filter((x) => x && typeof x === "object");
    out.ident = { builds: globalThis.__rcDirectBuilds ?? 0, lastBuild: last?.build ?? null, texIsLast: last ? last.visA === vt : null, texName: vt?.name, texUuid: vt?.uuid?.slice(0, 8), lastUuid: last?.visA?.uuid?.slice(0, 8),
      dirPasses: dir?.passes?.length ?? null, rawInDir: dir?.passes?.includes(last?.rawPass) ?? null, frameN: frameList.length, rawInFrame: frameList.includes(last?.rawPass), rawOnly: !!globalThis.__giRawOnly, flShape: fl0 == null ? null : Array.isArray(fl0) ? "array" : Object.keys(fl0).slice(0, 6).join(","), frameNames: frameList.slice(0, 60).map((p) => p?.__giPassName ?? p?.name ?? "?").filter((n) => /direct|rcEmitter|raw|vis|pen/i.test(n)) };
    // the pipeline's own state + a manual dispatch of the raw pass, then an immediate read
    try {
      const rp = last?.rawPass; const R = eng.renderer;
      const b = R._bindings.getForCompute(rp); const p = R._pipelines.getForCompute(rp, b); const st = R.backend.get(p);
      const mod = R.backend.get(p.computeProgram)?.module; const info = mod ? await mod.getCompilationInfo() : null;
      out.ident.pipe = { error: !!st?.error, has: !!st?.pipeline, count: rp?.count ?? null, halfW: dir?.halfW, halfH: dir?.halfH, tex: [vt?.image?.width, vt?.image?.height], wU: dir?.uniforms?.rcDirectWidth?.value, hU: dir?.uniforms?.rcDirectHeight?.value,
        msgs: (info?.messages ?? []).filter((m) => m.type !== "info").slice(0, 3).map((m) => `${m.type} L${m.lineNum}: ${m.message.slice(0, 160)}`) };
      R.compute(rp);
      const o2 = await tp.read(all.slice(0, 8).map((p) => [Math.round(p.pix[0]) >> 1, Math.round(p.pix[1]) >> 1]));
      out.ident.manual = [...o2.slice(0, 8)].map((v) => +v.toFixed(3));
      const gp = await globalThis.__editorApi.call("profile.giPasses", { samples: 4 });
      out.ident.rcKeys = Object.keys(gp?.gi2Ms ?? {}).filter((k) => /rc|direct|emitter/i.test(k)).slice(0, 12);
      out.ident.gi2Keys = Object.keys(gp?.gi2Ms ?? {}).length;
    } catch (e) { out.ident.pipeErr = String(e?.message ?? e); }
  } catch (e) { out.ident = String(e?.message ?? e); }
  const gridVis = vis.slice(line.length);
  const pxStep = line.length > 1 ? Math.hypot(line[1].pix[0] - line[0].pix[0], line[1].pix[1] - line[0].pix[1]) : 0;
  // THE RAMP: the transition between the darkest and the brightest visible
  // sample on the line - samples in the middle half of that span, in px.
  let minV = 1, maxV = 0, nSeen = 0;
  for (const v of lineVis) { if (!Number.isFinite(v)) continue; nSeen++; minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
  const lo = minV + (maxV - minV) * 0.25, hi = minV + (maxV - minV) * 0.75;
  let rampN = 0;
  for (const v of lineVis) if (Number.isFinite(v) && v > lo && v < hi) rampN++;
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  const sh = [], lit = [];
  pts.forEach((p, i) => { if (Number.isFinite(gridVis[i])) (p.shadowed ? sh : lit).push(gridVis[i]); });
  out.wall = { occ: occ.name, nLine: line.length, nLineSeen: nSeen, pxStep: +pxStep.toFixed(2), rampSamples: rampN, rampPx: +(rampN * pxStep).toFixed(1),
    depth: +(maxV - minV).toFixed(3), minVis: +minV.toFixed(3), maxVis: +maxV.toFixed(3),
    medVisShadow: +med(sh).toFixed(3), medVisLit: +med(lit).toFixed(3), nShadow: sh.length, nLit: lit.length,
    profile: lineVis.map((v) => (Number.isFinite(v) ? +v.toFixed(2) : "-")) };
  return out;
};
const readOnce = async (label) => {
  const r = await page.evaluate(READ, { WALL });
  const s = r.slots?.[0];
  console.log(`\n== ${label} ==`);
  if (r.error) console.log(`  error: ${r.error}`);
  console.log(`  lamp: ${JSON.stringify(r.lamp)} admission: ${JSON.stringify(r.admitted)}`);
  if (s) console.log(`  seat0: kind ${s.kind} radius ${s.radius} reff ${s.reff} half ${JSON.stringify(s.half)} exHalf ${JSON.stringify(s.exHalf)} rgb ${JSON.stringify(s.rgb)} moved ${s.moved} center ${JSON.stringify(s.center)}`);
  console.log(`  gi2: movers ${r.gi2?.movers} moverTris ${r.gi2?.moverTris} voxelsSet ${r.gi2?.voxelsSet} | live movers ${JSON.stringify(r.moversLive)} promoted ${JSON.stringify(r.promoted)}`);
  if (r.faceRows || r.faceErr) { console.log(`  face receipt B=${JSON.stringify(r.faceB)} sameUniform=${r.faceSame} ${r.faceErr ?? ""}`); for (const q of r.faceRows ?? []) console.log(`    ${JSON.stringify(q)}`); }
  if (r.wgsl && process.env.WGSL_OUT) { writeFileSync(process.env.WGSL_OUT, r.wgsl); console.log(`  wrote ${process.env.WGSL_OUT} (${r.wgsl.length} chars)`); } else if (r.wgslErr) console.log(`  wgsl: ${r.wgslErr}`);
  if (r.ident) console.log(`  ident: ${JSON.stringify(r.ident)}`);
  if (r.cpu || r.cpuErr) { console.log(`  cpu receipt: ${r.cpuErr ?? ""} nT ${r.cpu?.nT} lampTris ${r.cpu?.lampTris} ids ${JSON.stringify(r.cpu?.lampTriIds)} C ${JSON.stringify(r.cpu?.C)} EX ${JSON.stringify(r.cpu?.EX)} clear ${r.cpu?.clear}`); for (const q of r.cpu?.rows ?? []) console.log(`    ${JSON.stringify(q)}`); }
  if (r.penW || r.penErr) console.log(`  penumbra W (m) at 5 wall texels: ${JSON.stringify(r.penW)} max ${r.penWmax} ${r.penErr ?? ""}`);
  if (r.wall) console.log(`  wall(${r.wall.occ}): ramp ${r.wall.rampPx} px (${r.wall.rampSamples} of ${r.wall.nLineSeen}/${r.wall.nLine} seen samples @ ${r.wall.pxStep} px) vis min ${r.wall.minVis} max ${r.wall.maxVis} depth ${r.wall.depth} | medVis shadow ${r.wall.medVisShadow} lit ${r.wall.medVisLit} (n ${r.wall.nShadow}/${r.wall.nLit})${r.gbufFlip ? " [gbuf flipped]" : ""}${r.gbufCheck ? ` [${r.gbufCheck}]` : ""}`);
  if (r.wall && process.env.PROFILE) console.log(`  profile: ${r.wall.profile.join(" ")}`);
  return r;
};


const before = await readOnce("BEFORE");
await shoot("before");
const id = before.lamp?.entityId;
if (!id) { console.log("FATAL: no lamp entity"); await browser.close(); process.exit(1); }
const scaled = await page.evaluate(async ({ id, SCALE }) => {
  const ent = await globalThis.__editorApi.call("entity.get", { id }).catch(() => null);
  const s0 = ent?.transform?.scale ?? [1, 1, 1];
  const r = await globalThis.__editorApi.call("entity.setTransform", { id, scale: s0.map((v) => v * SCALE) });
  return { from: s0, to: r?.transform?.scale };
}, { id, SCALE });
console.log(`\nscaled entity ${id} x${SCALE}: ${JSON.stringify(scaled)}`);
await wait(1000);
const after1 = await readOnce("AFTER +1 s");
await wait(3000);
const after4 = await readOnce("AFTER +4 s");
await shoot("after");

// ── gates ────────────────────────────────────────────────────────────────────
const b = before.slots?.[0], a = after4.slots?.[0];
const near = (x, y, tol) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= tol * Math.max(Math.abs(y), 1e-6);
const gates = [];
gates.push(["reff x" + SCALE, !!(b && a) && near(a.reff, b.reff * SCALE, 0.1), `${b?.reff} → ${a?.reff}`]);
gates.push(["radius x" + SCALE, !!(b && a) && near(a.radius, b.radius * SCALE, 0.1), `${b?.radius} → ${a?.radius}`]);
gates.push(["exHalf x" + SCALE, !!(b && a) && [0, 1, 2].every((i) => near(a.exHalf[i], b.exHalf[i] * SCALE, 0.1)), `${JSON.stringify(b?.exHalf)} → ${JSON.stringify(a?.exHalf)}`]);
gates.push(["radiance unchanged", !!(b && a) && [0, 1, 2].every((i) => near(a.rgb[i], b.rgb[i], 0.02)), `${JSON.stringify(b?.rgb)} → ${JSON.stringify(a?.rgb)}`]);
const rb = before.wall?.rampPx ?? NaN, ra = after4.wall?.rampPx ?? NaN;
// THE SHADOW RESPONDED: either the ramp widened or the shadowed wall's median
// visibility moved by >= 0.05 (a bigger lamp fills more of its own shadow).
// MEASURED (Cornell, x2): ramp 9 -> 9 px (the kernel's PCSS floor
// `max(d - t_occ, lampHalf)` makes the width `t_occ` whenever the blocker is
// within one lamp-half of the lamp - true for both sizes here), medVis
// shadow 0.225 -> 0.332.
const vb = before.wall?.medVisShadow ?? NaN, va = after4.wall?.medVisShadow ?? NaN;
gates.push(["direct shadow responded to the scale", Number.isFinite(rb) && Number.isFinite(ra) && Number.isFinite(vb) && Number.isFinite(va) && (ra >= rb * 1.3 || Math.abs(va - vb) >= 0.05),
  `ramp ${rb} -> ${ra} px, medVis shadow ${vb} -> ${va} (depth ${before.wall?.depth} -> ${after4.wall?.depth}; the direct filter caps at 24 px)`]);
// The gate's own receipt is the AREA it saw: x SCALE^2 after, at a run stamped
// AFTER the scale (the +1 s read's age is measured from the scale itself).
gates.push(["admission gate re-ran with the new area", !!(before.admitted && after1.admitted) && after1.admitted.gateAgeMs < 1500 && near(after4.admitted?.area, before.admitted.area * SCALE * SCALE, 0.1),
  `area ${before.admitted?.area} -> ${after4.admitted?.area} m2 (x${SCALE * SCALE} expected), power ${before.admitted?.power} -> ${after4.admitted?.power}, gate ran ${after1.admitted?.gateAgeMs} ms after the scale (+1 s read)`]);
gates.push(["lamp in dynamic layer", (after4.gi2?.movers ?? 0) > 0 && (after4.moversLive ?? []).length > 0, `movers ${before.gi2?.movers} → ${after4.gi2?.movers} ${JSON.stringify(after4.moversLive)}`]);
gates.push(["still admitted", after4.admitted?.admitted !== false, JSON.stringify(after4.admitted)]);
console.log("\n== GATES ==");
let pass = true;
for (const [name, ok, detail] of gates) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`); if (!ok) pass = false; }
console.log(`\n${pass ? "PASS" : "FAIL"} gi-scaled-lamp (scale x${SCALE})`);
try {
  const gp = await page.evaluate(async () => globalThis.__editorApi.call("profile.giPasses", { samples: 8 }));
  const list = Array.isArray(gp) ? gp : (gp?.passes ?? gp?.entries ?? gp?.rows ?? []);
  const hit = (Array.isArray(list) ? list : []).filter((e) => /direct|rc/i.test(JSON.stringify(e).slice(0, 80)));
  console.log(`  profile.giPasses (direct/rc): ${JSON.stringify(hit).slice(0, 700)}`);
  if (!hit.length) console.log(`  profile.giPasses raw: ${JSON.stringify(gp).slice(0, 500)}`);
} catch (e) { console.log(`  profile.giPasses failed: ${e?.message ?? e}`); }
await browser.close();
process.exit(pass ? 0 : 1);
