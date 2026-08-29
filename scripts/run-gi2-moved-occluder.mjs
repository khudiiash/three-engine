// §19 6.21 — MOVED OCCLUDER: the emitter's exact shadow must follow a moved block.
//
//   node scripts/run-gi2-moved-occluder.mjs http://127.0.0.1:5206/
//
// Boots Cornell, settles, reads rcDirect's slot-0 visibility at floor points in
// the block's geometric shadow (OLD pose) and in the shadow it WILL cast one
// metre +x (NEW pose); moves the block via entity.setTransform; re-reads at
// 0.5 s, 3 s and after the settle rebuild. PASS = old-shadow visibility rose to
// > 0.7 and new-shadow visibility fell to < 0.3 by 3 s and stays so settled.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
const url = process.argv[2] ?? "http://127.0.0.1:5206/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE_PATH = `${PROJECT}/scenes/${process.env.SCENE ?? "Cornel"}.scene`;
const DX = Number(process.env.DX ?? 1);
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
page.on("console", (m) => { const t = m.text(); if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true; if (/shadow bvh|exact shadow|mover|adopted|rror|[occ]/i.test(t)) console.log(`  ${t.slice(0, 200)}`); });
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
const res = await page.evaluate(async ({ DX }) => {
  const eng = globalThis.__giEngineForProbe, sys = globalThis.__giSys(), gi2 = globalThis.__gi2(), vh = globalThis.__giViewport;
  const boxOf = (m) => { m.geometry.computeBoundingBox?.(); const bb = m.geometry.boundingBox; m.updateMatrixWorld(true); const e = m.matrixWorld.elements; const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (let c = 0; c < 8; c++) { const x = c & 1 ? bb.max.x : bb.min.x, y = c & 2 ? bb.max.y : bb.min.y, z = c & 4 ? bb.max.z : bb.min.z; const w = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], w[i]); mx[i] = Math.max(mx[i], w[i]); } } return { mn, mx }; };
  const boxes = []; for (const e of sys.state.entries ?? []) { const m = e.mesh; if (!m?.geometry) continue; boxes.push({ mesh: m, name: m.name, ...boxOf(m), peak: e.peak ?? 0 }); }
  const vol = (b) => (b.mx[0] - b.mn[0]) * (b.mx[1] - b.mn[1]) * (b.mx[2] - b.mn[2]);
  const thin = (b) => Math.min(b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]) < 0.2;
  const nonEm = boxes.filter((b) => b.peak < 0.5), walls = nonEm.filter(thin);
  const occ = nonEm.filter((b) => !thin(b)).reduce((a, b) => (a && vol(a) > vol(b) ? a : b), null);
  const slot = (sys.state.emitterSlots ?? []).find((s) => s.radius?.value > 1e-5); const L = slot.center.value.toArray();
  const S = { mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }; for (const w of walls) for (let i = 0; i < 3; i++) { S.mn[i] = Math.min(S.mn[i], w.mn[i]); S.mx[i] = Math.max(S.mx[i], w.mx[i]); }
  const floorY = S.mn[1] + 0.11;
  const segHits = (a, b, box) => { let t0 = 0, t1 = 1; for (let i = 0; i < 3; i++) { const d = b[i] - a[i]; if (Math.abs(d) < 1e-9) { if (a[i] < box.mn[i] || a[i] > box.mx[i]) return false; continue; } let ta = (box.mn[i] - a[i]) / d, tb = (box.mx[i] - a[i]) / d; if (ta > tb) [ta, tb] = [tb, ta]; t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) return false; } return true; };
  const occNew = { mn: [occ.mn[0] + DX, occ.mn[1], occ.mn[2]], mx: [occ.mx[0] + DX, occ.mx[1], occ.mx[2]] };
  const inBox = (P, b, m) => P[0] > b.mn[0] - m && P[0] < b.mx[0] + m && P[2] > b.mn[2] - m && P[2] < b.mx[2] + m;
  const cam = vh.camera; cam.updateMatrixWorld(true);
  const { createGi2TexProbe } = await import("/scripts/lib/gi2TexProbe.js");
  const d = gi2.rc?.resolve?.direct; const tp = createGi2TexProbe({ renderer: eng.renderer, tex: d.texture });
  const project = (P, flip) => { const e = cam.matrixWorldInverse.elements, q = cam.projectionMatrix.elements; const vx = e[0] * P[0] + e[4] * P[1] + e[8] * P[2] + e[12], vy = e[1] * P[0] + e[5] * P[1] + e[9] * P[2] + e[13], vz = e[2] * P[0] + e[6] * P[1] + e[10] * P[2] + e[14]; const cx = q[0] * vx + q[4] * vy + q[8] * vz + q[12], cy = q[1] * vx + q[5] * vy + q[9] * vz + q[13], cw = q[3] * vx + q[7] * vy + q[11] * vz + q[15]; if (!(cw > 1e-4)) return null; const px = ((cx / cw) * 0.5 + 0.5) * gi2.width, py = (flip ? ((cy / cw) * 0.5 + 0.5) : (0.5 - (cy / cw) * 0.5)) * gi2.height; if (!(px > 8 && py > 8 && px < gi2.width - 8 && py < gi2.height - 8)) return null; return [Math.round(px) >> 1, Math.round(py) >> 1]; };
  const pts = { old: [], new: [], lit: [] };
  const N = 60;
  for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
    const P = [S.mn[0] + (S.mx[0] - S.mn[0]) * i / N, floorY, S.mn[2] + (S.mx[2] - S.mn[2]) * j / N];
    if (inBox(P, occ, 0.08) || inBox(P, occNew, 0.08)) continue;
    const so = segHits(P, L, occ), sn = segHits(P, L, occNew);
    const cls = so && !sn ? "old" : sn && !so ? "new" : (!so && !sn ? "lit" : null); if (!cls) continue;
    pts[cls].push(P);
  }
  const all = [...pts.old, ...pts.new, ...pts.lit];
  const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? +s[s.length >> 1].toFixed(3) : NaN; };
  const readVis = async (flip) => { for (let f = 0; f < 3; f++) await new Promise((r) => requestAnimationFrame(r)); const pix = all.map((P) => project(P, flip) ?? [0, 0]); const o = await tp.read(pix); if (!globalThis.__occDbg) { globalThis.__occDbg = 1; console.log(`[occ] read ${o?.length} floats for ${pix.length} px`); } const k = (from, n) => med(Array.from({ length: n }, (_, i) => o[(from + i) * 4])); return { old: k(0, pts.old.length), new: k(pts.old.length, pts.new.length), lit: k(pts.old.length + pts.new.length, pts.lit.length) }; };
  const a = await readVis(false), b = await readVis(true); const flip = (b.lit > a.lit);
  const before = flip ? b : a;
  // the entity to move: match by mesh name (or the mesh's entity handle)
  let ents = [];
  try { const list = await globalThis.__editorApi.call("entity.list", {}); ents = Array.isArray(list) ? list : (list?.entities ?? list?.items ?? []); } catch {}
  const byName = ents.find((e) => (e.name ?? "") === occ.name) ?? ents.find((e) => (e.name ?? "").toLowerCase().includes((occ.name ?? "?").toLowerCase().split(" ")[0]));
  const eid = byName?.id ?? occ.mesh.userData?.entityId ?? occ.mesh.parent?.userData?.entityId ?? null;
  let how = "api";
  const obj = occ.mesh; const target = obj.parent && obj.parent.type !== "Scene" && obj.position.length() < 1e-6 ? obj.parent : obj;
  const pos = target.position.toArray();
  try { if (eid == null) throw new Error("no entity id"); await globalThis.__editorApi.call("entity.setTransform", { id: eid, position: [pos[0] + DX, pos[1], pos[2]] }); }
  catch (e) { how = `direct (${String(e?.message ?? e).slice(0, 60)})`; target.position.x += DX; target.updateMatrixWorld(true); }
  await new Promise((r) => setTimeout(r, 500)); const at05 = await readVis(flip);
  const mid = { movers: gi2.stats?.()?.movers ?? null, excluded: gi2.bvhExcludedCount };
  await new Promise((r) => setTimeout(r, 2500)); const at3 = await readVis(flip);
  await new Promise((r) => setTimeout(r, 7000)); const settled = await readVis(flip);
  const g2 = globalThis.__gi2();
  return { occ: occ.name, eid, how, n: { old: pts.old.length, new: pts.new.length, lit: pts.lit.length }, flip, before, at05, at3, settled, mid,
    after: { movers: g2.stats?.()?.movers ?? null, excluded: g2.bvhExcludedCount, bvhReady: g2.shadowBvh?.ready },
    rebuilds: (sys.rebuildLog ?? []).slice(-3).map((r) => r.reason) };
}, { DX });
console.log(JSON.stringify(res));
const ok = res.at3.old > 0.7 && res.at3.new < 0.3 && res.settled.old > 0.7 && res.settled.new < 0.3;
console.log(ok ? `PASS: shadow followed the block — old ${res.before.old}→${res.at3.old}, new ${res.before.new}→${res.at3.new} (settled ${res.settled.old}/${res.settled.new})` : `FAIL: old ${res.before.old}→${res.at05.old}/${res.at3.old}/${res.settled.old}, new ${res.before.new}→${res.at05.new}/${res.at3.new}/${res.settled.new}`);
await browser.close();
process.exit(ok ? 0 : 1);
