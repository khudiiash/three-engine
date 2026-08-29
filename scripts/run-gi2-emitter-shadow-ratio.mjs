// §19 6.12 — EMITTER SHADOW RATIO: shadowed vs lit wall pixels behind an occluder.
//
//   SCENE=Cornel RC5=1 OUT=shot.png node scripts/run-gi2-emitter-shadow-ratio.mjs http://127.0.0.1:5206/
//
// Boots the scene, waits for first light, aims the camera (POSE 'eye|target',
// default the cornell-ref pose), writes a PNG, then picks receiver points on
// the wall behind the largest non-emissive box (WALL=back|left|right|floor),
// classifies each by whether the segment to the emitter centre crosses the
// occluder's AABB, projects them to even pixels and reads the irradiance under
// three uniform settings: shipped, direct-only (rcTermField=0), and
// direct-only-unshadowed (rcDirectShadow=0). Prints medians and ratios.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { bvhAnyHit, bruteAnyHit } from "./lib/shadowBvhMirror.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5206/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const SCENE_PATH = SCENE.includes("/") || SCENE.includes("\\") ? SCENE.replaceAll("\\", "/") : `${PROJECT}/scenes/${SCENE}.scene`;
const RC5 = (process.env.RC5 ?? "1") === "1";
const SETTLE = Number(process.env.SETTLE ?? 8);
const OUT = process.env.OUT ?? "";
const POSE = (process.env.POSE ?? "0.38,2.60,4.10|0.38,2.30,-1.00").split("|").map((s) => s.split(",").map(Number));
const WALL = process.env.WALL ?? "back";
const HATCH = process.env.HATCH ?? ""; // JS evaluated before boot, e.g. "globalThis.__gi2Rc5BvhShadow=0"
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
await page.evaluateOnNewDocument((rc5, project, hatch) => {
  if (rc5) globalThis.__gi2Rc5 = true;
  if (hatch) { try { (0, eval)(hatch); } catch (e) { console.log("[hatch] " + e); } }
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, RC5, PROJECT, HATCH);
let firstLight = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (/shadow bvh|exact shadow|emitter.*admit|admission|\[gi\].*(rror|ailed)|hatch/i.test(t)) console.log(`  ${t.slice(0, 220)}`);
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
  globalThis.__gi2 = () => { const sys = globalThis.__giSys(); return sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null; };
});
const opened = await page.evaluate(async (path) => {
  try { return { ok: true, v: await globalThis.__editorApi.call("scene.open", { path }) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}, SCENE_PATH);
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
const t0 = Date.now();
while (!firstLight && Date.now() - t0 < 120000) await wait(250);
console.log(`first light ${firstLight ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen"}; rc5=${RC5}`);
await page.evaluate(async ({ p, t }) => {
  const vhm = await import("/src/editor/viewportHandle.js");
  const vh = vhm.getViewportHandle();
  globalThis.__giViewport = vh;
  vh.camera.position.set(p[0], p[1], p[2]);
  if (vh.orbit) { vh.orbit.target.set(t[0], t[1], t[2]); vh.orbit.update(); }
  else vh.camera.lookAt(t[0], t[1], t[2]);
  vh.camera.updateMatrixWorld(true);
}, { p: POSE[0], t: POSE[1] });
await wait(SETTLE * 1000);
if (OUT) {
  const shot = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.viewport.screenshot({ width: 960, height: 640, includeGizmos: false });
    return typeof r === "string" ? r : (r?.__image ?? r?.png ?? r?.dataUrl ?? r?.image ?? "");
  });
  const b64 = String(shot).replace(/^data:image\/png;base64,/, "");
  if (b64.length > 1000) { writeFileSync(OUT, Buffer.from(b64, "base64")); console.log(`wrote ${OUT}`); }
}

const res = await page.evaluate(async ({ WALL }) => {
  const eng = globalThis.__giEngineForProbe;
  const sys = globalThis.__giSys();
  const gi2 = globalThis.__gi2();
  const vh = globalThis.__giViewport;
  const { createGi2PointSampler } = await import("/scripts/lib/gi2PointProbe.js");
  const sampler = createGi2PointSampler({ renderer: eng.renderer, gi2, screen: sys.state.screen });
  if (!sampler) return { error: "no sampler" };
  // ── geometry: world AABBs of the GI entries ─────────────────────────────
  const boxes = [];
  for (const e of sys.state.entries ?? []) {
    const m = e.mesh; if (!m?.geometry) continue;
    m.geometry.computeBoundingBox?.();
    const bb = m.geometry.boundingBox; if (!bb) continue;
    m.updateMatrixWorld?.(true);
    const me = m.matrixWorld.elements;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? bb.max.x : bb.min.x, y = c & 2 ? bb.max.y : bb.min.y, z = c & 4 ? bb.max.z : bb.min.z;
      const wx = me[0] * x + me[4] * y + me[8] * z + me[12];
      const wy = me[1] * x + me[5] * y + me[9] * z + me[13];
      const wz = me[2] * x + me[6] * y + me[10] * z + me[14];
      mn[0] = Math.min(mn[0], wx); mn[1] = Math.min(mn[1], wy); mn[2] = Math.min(mn[2], wz);
      mx[0] = Math.max(mx[0], wx); mx[1] = Math.max(mx[1], wy); mx[2] = Math.max(mx[2], wz);
    }
    boxes.push({ name: m.name, mn, mx, lum: e.luminance ?? 0, peak: e.peak ?? 0, tris: e.tris ?? 0, promoted: !!e.promoted });
  }
  const slots = (sys.state.emitterSlots ?? []).map((s) => ({
    center: s.center?.value?.toArray?.() ?? null, radius: s.radius?.value, reff: s.reff?.value,
    exHalf: s.exHalf?.value?.toArray?.() ?? null, color: s.color?.value?.toArray?.() ?? null,
  })).filter((s) => s.radius > 1e-5);
  if (!slots.length) return { error: "no active emitter slot", boxes };
  const L = slots[0].center;
  // the occluder: the largest-volume non-emissive box that is not the room shell
  const vol = (b) => (b.mx[0] - b.mn[0]) * (b.mx[1] - b.mn[1]) * (b.mx[2] - b.mn[2]);
  const nonEm = boxes.filter((b) => b.peak < 0.5);
  const thin = (b) => Math.min(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]) < 0.2;
  const walls = nonEm.filter(thin);
  const occ = nonEm.filter((b) => !thin(b)).reduce((a, b) => (a && vol(a) > vol(b) ? a : b), null);
  if (!occ || !walls.length) return { error: "no occluder/walls", boxes, slots };
  // the room shell = the union of the thin boxes, shrunk by their thickness
  const S = { mn: [Infinity, Infinity, Infinity], mx: [-Infinity, -Infinity, -Infinity], name: "shell" };
  for (const w of walls) for (let i = 0; i < 3; i++) { S.mn[i] = Math.min(S.mn[i], w.mn[i]); S.mx[i] = Math.max(S.mx[i], w.mx[i]); }
  for (let i = 0; i < 3; i++) { S.mn[i] += 0.1; S.mx[i] -= 0.1; }
  const scene = S;
  let plane;
  if (WALL === "back") plane = { axis: 2, v: S.mn[2] + 0.01, n: [0, 0, 1] };
  else if (WALL === "front") plane = { axis: 2, v: S.mx[2] - 0.01, n: [0, 0, -1] };
  else if (WALL === "left") plane = { axis: 0, v: S.mn[0] + 0.01, n: [1, 0, 0] };
  else if (WALL === "right") plane = { axis: 0, v: S.mx[0] - 0.01, n: [-1, 0, 0] };
  else plane = { axis: 1, v: S.mn[1] + 0.01, n: [0, 1, 0] };
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
  const cam = vh.camera;
  let FLIP = false;
  cam.updateMatrixWorld(true);
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
    const px = ((cx / cw) * 0.5 + 0.5) * sampler.width;
    const py = (FLIP ? ((cy / cw) * 0.5 + 0.5) : (0.5 - (cy / cw) * 0.5)) * sampler.height;
    if (!(px >= 4 && py >= 4 && px < sampler.width - 4 && py < sampler.height - 4)) return null;
    return [2 * Math.round(px / 2), 2 * Math.round(py / 2)];
  };
  // sample the wall on a grid
  const pts = [];
  const ax = [0, 1, 2].filter((i) => i !== plane.axis);
  const N = 40;
  for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
    const P = [0, 0, 0];
    P[plane.axis] = plane.v;
    P[ax[0]] = S.mn[ax[0]] + (S.mx[ax[0]] - S.mn[ax[0]]) * (i / N);
    P[ax[1]] = S.mn[ax[1]] + (S.mx[ax[1]] - S.mn[ax[1]]) * (j / N);
    // skip points inside the occluder or the emitter
    if (P[0] > occ.mn[0] - 0.05 && P[0] < occ.mx[0] + 0.05 && P[1] > occ.mn[1] - 0.05 && P[1] < occ.mx[1] + 0.05 && P[2] > occ.mn[2] - 0.05 && P[2] < occ.mx[2] + 0.05) continue;
    const shadowed = segHitsBox(P, L, occ);
    const pix = project(P);
    if (!pix) continue;
    pts.push({ P, shadowed, pix, dist: Math.hypot(P[0] - L[0], P[1] - L[1], P[2] - L[2]) });
  }
  if (pts.length > 1000) pts.length = 1000;
  // row order: try both and keep the mapping whose gbuffer identity check passes
  {
    const probeRows = async () => {
      for (let f = 0; f < 2; f++) await new Promise((r) => requestAnimationFrame(r));
      const out = await sampler.dispatch(pts.map((p) => p.pix));
      const OV = sampler.OUT_VEC; let ok = 0;
      pts.forEach((p, i) => { const b = i * OV * 4; if (out[b + 3] > 0.5 && Math.hypot(out[b] - p.P[0], out[b + 1] - p.P[1], out[b + 2] - p.P[2]) < 0.08) ok++; });
      return ok;
    };
    const okA = await probeRows();
    FLIP = true; for (const p of pts) p.pix = project(p.P) ?? p.pix;
    const okB = await probeRows();
    if (okA >= okB) { FLIP = false; for (const p of pts) p.pix = project(p.P) ?? p.pix; }
    var rowOrder = { okDown: okA, okUp: okB, flip: FLIP };
  }
  const u = gi2.rc?.uniforms ?? {};
  const read = async () => {
    // render a few frames so the uniforms take
    for (let f = 0; f < 6; f++) await new Promise((r) => requestAnimationFrame(r));
    const out = await sampler.dispatch(pts.map((p) => p.pix));
    const OV = sampler.OUT_VEC;
    return pts.map((p, i) => {
      const b = i * OV * 4;
      const g = [out[b], out[b + 1], out[b + 2], out[b + 3]];
      const ia = [out[b + 4], out[b + 5], out[b + 6]];
      const ib = [out[b + 8], out[b + 9], out[b + 10]];
      const err = Math.hypot(g[0] - p.P[0], g[1] - p.P[1], g[2] - p.P[2]);
      return { valid: g[3] > 0.5 && err < 0.08, lumA: (ia[0] + ia[1] + ia[2]) / 3, lumB: (ib[0] + ib[1] + ib[2]) / 3 };
    });
  };
  const fieldU = u.rcTermField, shadowU = u.rcDirectShadow, directU = u.rcTermDirect;
  const hasU = !!(fieldU && shadowU);
  const shipped = await read();
  let directOnly = null, directNoShadow = null, fieldOnly = null, shippedNoShadow = null;
  if (hasU) {
    shadowU.value = 0; shippedNoShadow = await read(); shadowU.value = 1;
    fieldU.value = 0; directOnly = await read();
    shadowU.value = 0; directNoShadow = await read();
    shadowU.value = 1; fieldU.value = 1; directU.value = 0; fieldOnly = await read();
    directU.value = 1;
    for (let f = 0; f < 3; f++) await new Promise((r) => requestAnimationFrame(r));
  }
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  const stat = (rows, key) => {
    if (!rows) return null;
    const sh = [], lit = [];
    rows.forEach((r, i) => { if (!r.valid) return; (pts[i].shadowed ? sh : lit).push(r[key]); });
    return { nShadow: sh.length, nLit: lit.length, medShadow: med(sh), medLit: med(lit), ratio: med(sh) / med(lit) };
  };
  const nValid = shipped.filter((r) => r.valid).length;
  // per-pixel visibility: the shadowed read over the bypassed read, same pixel
  const pix = (a, b, key) => {
    if (!a || !b) return null;
    const sh = [], lit = [];
    a.forEach((r, i) => { if (!r.valid || !b[i].valid || !(b[i][key] > 1e-6)) return; (pts[i].shadowed ? sh : lit).push(r[key] / b[i][key]); });
    return { nShadow: sh.length, nLit: lit.length, medVisShadow: med(sh), medVisLit: med(lit) };
  };
  // rcDirect's FILTERED visibility texture (visA), slot 0, at the half-res texel
  let visTex = null;
  try {
    const vt = gi2.rc?.resolve?.direct?.texture ?? null;
    if (vt) {
      const { createGi2TexProbe } = await import("/scripts/lib/gi2TexProbe.js");
      const tp = createGi2TexProbe({ renderer: eng.renderer, tex: vt });
      const o = await tp.read(pts.map((p) => [p.pix[0] >> 1, p.pix[1] >> 1]));
      const sh = [], lit = [];
      pts.forEach((p, i) => { if (!shipped[i].valid) return; (p.shadowed ? sh : lit).push(o[i * 4]); });
      visTex = { medShadow: med(sh), medLit: med(lit), nShadow: sh.length, nLit: lit.length, minShadow: Math.min(...sh), maxShadow: Math.max(...sh) };
    }
  } catch (e) { visTex = String(e?.message ?? e); }
  const sb = gi2.shadowBvh ?? null;
  let gpuNodes = null, gpuIdx = null, gpuTris = null;
  if (sb?.nodesAttr) {
    try {
      gpuNodes = Array.from(new Float32Array(await eng.renderer.getArrayBufferAsync(sb.nodesAttr))).slice(0, 16);
      gpuIdx = Array.from(new Uint32Array(await eng.renderer.getArrayBufferAsync(sb.triIdxAttr))).slice(0, 8);
      gpuTris = Array.from(new Float32Array(await eng.renderer.getArrayBufferAsync(sb.trisAttr))).slice(0, 9);
    } catch (e) { gpuNodes = String(e?.message ?? e); }
  }
  // the GPU any-hit kernel on the very rays the CPU mirror scores
  let gpuRays = null;
  if (sb) {
    try {
      const { createGi2BvhRayProbe } = await import("/scripts/lib/gi2BvhRayProbe.js");
      const rp = createGi2BvhRayProbe({ renderer: eng.renderer, bvh: sb });
      const ex = slots[0].exHalf, rad = Math.max(slots[0].radius, slots[0].reff);
      const rr = pts.map((p) => {
        const ro = [p.P[0] + plane.n[0] * 2e-3, p.P[1] + plane.n[1] * 2e-3, p.P[2] + plane.n[2] * 2e-3];
        const wv = [L[0] - ro[0], L[1] - ro[1], L[2] - ro[2]]; const d = Math.hypot(...wv); const rd = wv.map((v) => v / d);
        const aw = rd.map((v) => Math.max(1e-6, Math.abs(v)));
        const slab = Math.min(ex[0] / aw[0], ex[1] / aw[1], ex[2] / aw[2]);
        return { ro, rd, maxT: Math.max(1e-3, d - Math.min(slab, rad)), shadowed: p.shadowed };
      });
      const o = await rp.run(rr);
      const t = { shadowHit: 0, shadowN: 0, litHit: 0, litN: 0, ready: o[1] };
      rr.forEach((r, k) => { if (r.shadowed) { t.shadowN++; t.shadowHit += o[k * 4]; } else { t.litN++; t.litHit += o[k * 4]; } });
      gpuRays = t;
    } catch (e) { gpuRays = String(e?.message ?? e); }
  }
  const bvhDump = sb ? { gpuRays, gpuNodes, gpuIdx, gpuTris,
    ready: sb.ready, triCount: sb.triCount, nodeCount: sb.nodeCount,
    nodes: Array.from(sb.nodes ?? []), triIdx: Array.from(sb.triIdx ?? []), tris: Array.from(sb.tris ?? []),
  } : null;
  const rays = pts.map((p) => ({ P: p.P, n: plane.n, shadowed: p.shadowed }));
  return {
    bvhDump, rays, L, exHalf: slots[0].exHalf, radius: slots[0].radius, reff: slots[0].reff,
    visTex, rowOrder, slots, occ: occ.name, scene: scene.name, plane, nPts: pts.length, nValid,
    nShadowPts: pts.filter((p) => p.shadowed).length, hasU, rcReady: gi2.rc ? true : false,
    bvh: (() => { try { return gi2.describe?.()?.shadowBvh ?? gi2.rc?.describe?.()?.shadowBvh ?? null; } catch { return null; } })(),
    perPixel: { direct: pix(directOnly, directNoShadow, "lumB"), finalBeforeAO: pix(shipped, shippedNoShadow, "lumB"), finalAfterAO: pix(shipped, shippedNoShadow, "lumA") },
    shipped: { afterAO: stat(shipped, "lumA"), beforeAO: stat(shipped, "lumB") },
    directOnly: stat(directOnly, "lumB"), directNoShadow: stat(directNoShadow, "lumB"), fieldOnly: stat(fieldOnly, "lumB"),
  };
}, { WALL });
if (res.bvhDump) {
  const { bvhDump: B, rays, L, exHalf, radius, reff } = res;
  const nodes = new Float32Array(B.nodes), triIdx = new Uint32Array(B.triIdx), tris = new Float32Array(B.tris);
  const tally = { shadow: { bvh: 0, brute: 0, n: 0 }, lit: { bvh: 0, brute: 0, n: 0 } };
  let sample = null;
  for (const r of rays) {
    const ro = [r.P[0] + r.n[0] * 2e-3, r.P[1] + r.n[1] * 2e-3, r.P[2] + r.n[2] * 2e-3];
    const wv = [L[0] - ro[0], L[1] - ro[1], L[2] - ro[2]];
    const d = Math.hypot(...wv); const rd = wv.map((v) => v / d);
    const aw = rd.map((v) => Math.max(1e-6, Math.abs(v)));
    const slab = Math.min(exHalf[0] / aw[0], exHalf[1] / aw[1], exHalf[2] / aw[2]);
    const maxT = Math.max(1e-3, d - Math.min(slab, Math.max(radius, reff)));
    const k = r.shadowed ? tally.shadow : tally.lit;
    k.n++;
    const h = bvhAnyHit({ nodes, triIdx }, tris, ro, rd, maxT);
    k.bvh += h.hit; k.brute += bruteAnyHit(tris, B.triCount, ro, rd, maxT);
    if (!sample && r.shadowed) sample = { ro, rd, maxT, d, slab, h };
  }
  console.log("GPU RAYS", JSON.stringify(B.gpuRays));
  console.log("GPU BUFFERS", JSON.stringify({ gpuNodes: B.gpuNodes, gpuIdx: B.gpuIdx, gpuTris: B.gpuTris }));
  console.log("CPU MIRROR", JSON.stringify({ ready: B.ready, triCount: B.triCount, nodeCount: B.nodeCount, tally, sample, nodes0: B.nodes.slice(0, 16), tri0: B.tris.slice(0, 9), triIdx0: B.triIdx.slice(0, 8) }));
  delete res.bvhDump; delete res.rays;
}
console.log(JSON.stringify(res, (k, v) => (typeof v === "number" ? Number(v.toFixed(4)) : v), 1).replace(/\n\s*(?=[\d\-"nfte])/g, " "));
await browser.close();
