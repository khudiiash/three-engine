// §19 6.21 — MOVED OCCLUDER: the emitter's exact shadow must follow a moved block.
//
//   OUT=shot.png node scripts/run-gi2-moved-occluder.mjs http://127.0.0.1:5206/
//
// Boots Cornell, settles, reads rcDirect's slot-0 visibility at points on the
// floor and both side walls in the tall block's geometric shadow (OLD pose) and
// in the shadow it WILL cast DX metres +x (NEW pose); moves the block's ENTITY
// via entity.setTransform; re-reads at 0.5 s, 3 s and after the settle rebuild.
// Every read re-fetches the live gi2 (a rebuild mints a new generation) and
// dispatches twice, keeping the second (the first-dispatch-dropped trap).
// PASS = old-shadow visibility > 0.7 and new-shadow < 0.3 at 3 s and settled.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";
const url = process.argv[2] ?? "http://127.0.0.1:5206/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE_PATH = `${PROJECT}/scenes/${process.env.SCENE ?? "Cornel"}.scene`;
const DX = Number(process.env.DX ?? -1);
const OUT = process.env.OUT ?? "";
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
await page.evaluateOnNewDocument((project) => {
  globalThis.__gi2Rc5 = true; globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
let firstLight = false;
page.on("console", (m) => { const t = m.text(); if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true; if (/shadow bvh|exact shadow|mover|adopted|rror|\[occ\]/i.test(t)) console.log(`  ${t.slice(0, 200)}`); });
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => { const rows = [...document.querySelectorAll(".hub-recent")]; (rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0])?.querySelector(".hub-recent-open-btn")?.click(); }, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__giEngineForProbe = mod.engine;
  globalThis.__giSys = () => mod.engine?.modules?.get?.("gi")?.system ?? null;
  globalThis.__gi2 = () => { const sys = globalThis.__giSys(); return sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null; };
});
await page.evaluate(async (path) => globalThis.__editorApi.call("scene.open", { path }), SCENE_PATH);
const t0 = Date.now();
while (!firstLight && Date.now() - t0 < 120000) await wait(250);
console.log(`first light ${firstLight ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen"}`);
await page.evaluate(async () => {
  const vhm = await import("/src/editor/viewportHandle.js"); const vh = vhm.getViewportHandle(); globalThis.__giViewport = vh;
  vh.camera.position.set(0.38, 2.60, 4.10); if (vh.orbit) { vh.orbit.target.set(0.38, 2.30, -1.00); vh.orbit.update(); } else vh.camera.lookAt(0.38, 2.30, -1.0);
  vh.camera.updateMatrixWorld(true);
});
await wait(8000);
const shoot = async (tag) => {
  if (!OUT) return;
  const shot = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.viewport.screenshot({ width: 960, height: 640, includeGizmos: false });
    const img = typeof r === "string" ? r : (r?.__image ?? r?.png ?? r?.dataUrl ?? r?.image ?? r);
    return typeof img === "string" ? img : (img?.data ?? img?.base64 ?? img?.png ?? img?.dataUrl ?? "");
  });
  const b64 = String(shot).replace(/^data:image\/png;base64,/, "");
  if (/^[A-Za-z0-9+/=]+$/.test(b64) && b64.length > 1000) { const f = OUT.replace(/\.png$/i, "") + `-${tag}.png`; writeFileSync(f, Buffer.from(b64, "base64")); console.log(`wrote ${f}`); }
};
// ── the geometry, the points and the entity: once ─────────────────────────
const setup = await page.evaluate(({ DX }) => {
  const sys = globalThis.__giSys(), vh = globalThis.__giViewport;
  const boxOf = (m) => { m.geometry.computeBoundingBox?.(); const bb = m.geometry.boundingBox; m.updateMatrixWorld(true); const e = m.matrixWorld.elements; const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (let c = 0; c < 8; c++) { const x = c & 1 ? bb.max.x : bb.min.x, y = c & 2 ? bb.max.y : bb.min.y, z = c & 4 ? bb.max.z : bb.min.z; const w = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], w[i]); mx[i] = Math.max(mx[i], w[i]); } } return { mn, mx }; };
  const boxes = []; for (const e of sys.state.entries ?? []) { const m = e.mesh; if (!m?.geometry) continue; boxes.push({ mesh: m, name: m.name, ...boxOf(m), peak: e.peak ?? 0 }); }
  const vol = (b) => (b.mx[0] - b.mn[0]) * (b.mx[1] - b.mn[1]) * (b.mx[2] - b.mn[2]);
  const thin = (b) => Math.min(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]) < 0.2;
  const nonEm = boxes.filter((b) => b.peak < 0.5), walls = nonEm.filter(thin);
  const occ = nonEm.filter((b) => !thin(b)).reduce((a, b) => (a && vol(a) > vol(b) ? a : b), null);
  const slot = (sys.state.emitterSlots ?? []).find((s) => s.radius?.value > 1e-5); const L = slot.center.value.toArray();
  const S = { mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }; for (const w of walls) for (let i = 0; i < 3; i++) { S.mn[i] = Math.min(S.mn[i], w.mn[i]); S.mx[i] = Math.max(S.mx[i], w.mx[i]); }
  for (let i = 0; i < 3; i++) { S.mn[i] += 0.1; S.mx[i] -= 0.1; }
  const segHits = (a, b, box) => { let t0 = 0, t1 = 1; for (let i = 0; i < 3; i++) { const d = b[i] - a[i]; if (Math.abs(d) < 1e-9) { if (a[i] < box.mn[i] || a[i] > box.mx[i]) return false; continue; } let ta = (box.mn[i] - a[i]) / d, tb = (box.mx[i] - a[i]) / d; if (ta > tb) [ta, tb] = [tb, ta]; t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) return false; } return true; };
  const occNew = { mn: [occ.mn[0] + DX, occ.mn[1], occ.mn[2]], mx: [occ.mx[0] + DX, occ.mx[1], occ.mx[2]] };
  const near = (P, b, m) => P[0] > b.mn[0] - m && P[0] < b.mx[0] + m && P[1] > b.mn[1] - m && P[1] < b.mx[1] + m && P[2] > b.mn[2] - m && P[2] < b.mx[2] + m;
  const planes = [
    { name: "floor", axis: 1, v: S.mn[1] + 0.01 },
    { name: "left", axis: 0, v: S.mn[0] + 0.01 },
    { name: "right", axis: 0, v: S.mx[0] - 0.01 },
    { name: "back", axis: 2, v: S.mn[2] + 0.01 },
  ];
  const pts = [];
  const N = 48;
  for (const pl of planes) {
    const ax = [0, 1, 2].filter((i) => i !== pl.axis);
    for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
      const P = [0, 0, 0]; P[pl.axis] = pl.v;
      P[ax[0]] = S.mn[ax[0]] + (S.mx[ax[0]] - S.mn[ax[0]]) * i / N; P[ax[1]] = S.mn[ax[1]] + (S.mx[ax[1]] - S.mn[ax[1]]) * j / N;
      if (near(P, occ, 0.1) || near(P, occNew, 0.1)) continue;
      const so = segHits(P, L, occ), sn = segHits(P, L, occNew);
      const cls = so && !sn ? "old" : sn && !so ? "new" : (!so && !sn ? "lit" : null); if (!cls) continue;
      pts.push({ P, cls, plane: pl.name });
    }
  }
  // the ENTITY that owns the block: the nearest ancestor carrying an entity id
  let eid = null; for (let o = occ.mesh; o && eid == null; o = o.parent) eid = o.userData?.entityId ?? null;
  globalThis.__occPts = pts; globalThis.__occMesh = occ.mesh;
  const cam = vh.camera; cam.updateMatrixWorld(true);
  const count = (c) => pts.filter((p) => p.cls === c).length;
  return { occ: occ.name, eid, occBox: { mn: occ.mn, mx: occ.mx }, L, n: { old: count("old"), new: count("new"), lit: count("lit") },
    byPlane: Object.fromEntries(planes.map((pl) => [pl.name, { old: pts.filter((p) => p.plane === pl.name && p.cls === "old").length, new: pts.filter((p) => p.plane === pl.name && p.cls === "new").length }])) };
}, { DX });
console.log(JSON.stringify({ occ: setup.occ, eid: setup.eid, n: setup.n, byPlane: setup.byPlane, occBox: { mn: setup.occBox.mn, mx: setup.occBox.mx }, L: setup.L }));
if (setup.eid == null) { console.log("FATAL: no entity id on the occluder's ancestry"); await browser.close(); process.exit(1); }
const readVis = async () => page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe, gi2 = globalThis.__gi2(), vh = globalThis.__giViewport, pts = globalThis.__occPts;
  const cam = vh.camera; cam.updateMatrixWorld(true);
  const { createGi2TexProbe } = await import("/scripts/lib/gi2TexProbe.js");
  const d = gi2?.rc?.resolve?.direct; if (!d?.texture) return { error: "no direct texture", gen: gi2?.generation ?? null };
  const tp = createGi2TexProbe({ renderer: eng.renderer, tex: d.texture });
  const project = (P, flip) => { const e = cam.matrixWorldInverse.elements, q = cam.projectionMatrix.elements; const vx = e[0] * P[0] + e[4] * P[1] + e[8] * P[2] + e[12], vy = e[1] * P[0] + e[5] * P[1] + e[9] * P[2] + e[13], vz = e[2] * P[0] + e[6] * P[1] + e[10] * P[2] + e[14]; const cx = q[0] * vx + q[4] * vy + q[8] * vz + q[12], cy = q[1] * vx + q[5] * vy + q[9] * vz + q[13], cw = q[3] * vx + q[7] * vy + q[11] * vz + q[15]; if (!(cw > 1e-4)) return null; const px = ((cx / cw) * 0.5 + 0.5) * gi2.width, py = (flip ? ((cy / cw) * 0.5 + 0.5) : (0.5 - (cy / cw) * 0.5)) * gi2.height; if (!(px > 8 && py > 8 && px < gi2.width - 8 && py < gi2.height - 8)) return null; return [Math.round(px) >> 1, Math.round(py) >> 1]; };
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? +s[s.length >> 1].toFixed(3) : NaN; };
  const once = async (flip) => {
    const vis = pts.map((p) => ({ p, pix: project(p.P, flip) })).filter((x) => x.pix);
    for (let f = 0; f < 2; f++) await new Promise((r) => requestAnimationFrame(r));
    await tp.read(vis.map((x) => x.pix)); // the first dispatch is dropped
    for (let f = 0; f < 2; f++) await new Promise((r) => requestAnimationFrame(r));
    const o = await tp.read(vis.map((x) => x.pix));
    const k = (sel) => med(vis.map((x, i) => sel(x.p) ? o[i * 4] : NaN));
    return { old: k((p) => p.cls === "old"), new: k((p) => p.cls === "new"), lit: k((p) => p.cls === "lit"), oldFloor: k((p) => p.cls === "old" && p.plane === "floor"), newFloor: k((p) => p.cls === "new" && p.plane === "floor"), oldWall: k((p) => p.cls === "old" && p.plane !== "floor"), newWall: k((p) => p.cls === "new" && p.plane !== "floor"), n: vis.length };
  };
  const a = await once(false), b = await once(true);
  return (b.lit > a.lit) ? { ...b, flip: true } : { ...a, flip: false };
});
const before = await readVis();
await shoot("before");
const moved = await page.evaluate(async ({ eid, DX }) => {
  const e = await globalThis.__editorApi.call("entity.get", { id: eid });
  const pos = e?.transform?.position ?? [0, 0, 0];
  await globalThis.__editorApi.call("entity.setTransform", { id: eid, position: [pos[0] + DX, pos[1], pos[2]] });
  return { from: pos, name: e?.name };
}, { eid: setup.eid, DX });
const tMove = Date.now(); await page.evaluate(() => { globalThis.__occT0 = performance.now(); });
console.log(`moved entity "${moved.name}" (${setup.eid}) from ${moved.from.map((v) => +v.toFixed(2))} by +${DX} x`);
await wait(500); const at05 = await readVis();
const st05 = await page.evaluate(() => { const g = globalThis.__gi2(); return { movers: g?.stats?.()?.movers ?? null, excluded: g?.bvhExcludedCount, bvhReady: g?.shadowBvh?.ready }; });
await wait(Math.max(0, 3000 - (Date.now() - tMove))); const at3 = await readVis();
await shoot("at3s");
await wait(8000); const settled = await readVis();
await shoot("settled");
const stEnd = await page.evaluate(() => { const g = globalThis.__gi2(), sys = globalThis.__giSys(); return { movers: g?.stats?.()?.movers ?? null, excluded: g?.bvhExcludedCount, bvhReady: g?.shadowBvh?.ready, bvhTris: g?.shadowBvh?.triCount, rebuilds: (sys.rebuildLog ?? []).map((r) => `${r.reason}@${Math.round(r.at - globalThis.__occT0)}ms`) }; });
console.log(JSON.stringify({ before, at05, st05, at3, settled, stEnd }));
const ok = at3.old > 0.7 && at3.new < 0.3 && settled.old > 0.7 && settled.new < 0.3;
console.log(ok ? `PASS: the shadow followed the block — old ${before.old}→${at05.old}/${at3.old}/${settled.old}, new ${before.new}→${at05.new}/${at3.new}/${settled.new}` : `FAIL: old ${before.old}→${at05.old}/${at3.old}/${settled.old}, new ${before.new}→${at05.new}/${at3.new}/${settled.new}`);
await browser.close();
process.exit(ok ? 0 : 1);
