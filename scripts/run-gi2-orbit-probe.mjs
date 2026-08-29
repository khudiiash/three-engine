// GI2 ORBIT PROBE — §19 6.10: "light FLASHES when orbiting" + "green blotches
// on the red wall under certain angles" (Cornel.scene, user 08-29).
//
// Reads `gi2.textures.irradiance` at a FIXED GRID OF WORLD POINTS on the red
// wall, per frame, while the camera orbits 30° around the box centre and then
// rests. Reports per-frame p90/max relative step (against each point's own
// at-rest luminance), the spatial σ of the green fraction G/(R+G+B) across the
// wall at rest before and after the orbit, and the after-orbit time series of
// that σ (a transient that decays = tile re-seeding; a stable σ = placement).
//
//   FLAGS='{"__gi2MergeSeedParent":0}' OUT=x.json node scripts/run-gi2-orbit-probe.mjs http://127.0.0.1:5207/
//
// Env: PROJECT · SCENE=Cornel · POSE 'eye|target' · REST=40 · ORBIT=60 ·
//      AFTER=120 · DEG=30 · SETTLE=8 · FLAGS · OUT · HEADED=1
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5207/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const SETTLE = Number(process.env.SETTLE ?? 8);
const REST = Number(process.env.REST ?? 40);
const ORBIT = Number(process.env.ORBIT ?? 60);
const AFTER = Number(process.env.AFTER ?? 120);
const DEG = Number(process.env.DEG ?? 30);
const OUT = process.env.OUT ?? "";
const POSE = (process.env.POSE ?? "1.6,2.3,2.1|-0.6,2.0,-2.5").split("|").map((s) => s.split(",").map(Number));
// Cornel.scene: parent at (0.38, 0.24, 0); Red wall plane x = -2.5+0.38, thickness 0.1 → inner face x ≈ -2.07.
const RED_X = -2.5 + 0.3816651532689147 + 0.05;
const Y0 = 0.24055190797330517;
const CENTRE = [0.38, Y0 + 2.5, 0];
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
await page.evaluateOnNewDocument((flags, project) => {
  globalThis.__gi2Rc5 = true;
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, JSON.parse(process.env.FLAGS ?? "{}"), PROJECT);
let firstLight = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (/rc5|RC5|first light|\[gi\].*(rror|ailed)/i.test(t)) console.log(`  ${t.slice(0, 160)}`);
});
page.on("pageerror", (e) => { const s = e.stack ?? e.message ?? String(e); if (!/save_scene|esbuild|transpile/.test(s)) console.log(`  pageerror: ${s.slice(0, 160)}`); });
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
}, `${PROJECT}/scenes/${SCENE}.scene`);
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
const t0 = Date.now();
while (!firstLight && Date.now() - t0 < 90000) await wait(250);
console.log(`first light ${firstLight ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s` : "NOT seen"}`);
await page.evaluate(async ({ p, t }) => {
  const vhm = await import("/src/editor/viewportHandle.js");
  const vh = vhm.getViewportHandle();
  globalThis.__giViewport = vh;
  vh.camera.position.set(p[0], p[1], p[2]);
  if (vh.orbit) { vh.orbit.target.set(t[0], t[1], t[2]); vh.orbit.update(); } else vh.camera.lookAt(t[0], t[1], t[2]);
}, { p: POSE[0], t: POSE[1] });
await wait(SETTLE * 1000);

const res = await page.evaluate(async ({ REST, ORBIT, AFTER, DEG, POSE, RED_X, Y0, CENTRE }) => {
  const eng = globalThis.__giEngineForProbe;
  const sys = globalThis.__giSys();
  const gi2 = globalThis.__gi2();
  const stats = eng?.stats;
  const viewport = globalThis.__giViewport;
  const { createGi2PointSampler } = await import("/scripts/lib/gi2PointProbe.js");
  const sampler = createGi2PointSampler({ renderer: eng.renderer, gi2, screen: sys.state.screen });
  if (!sampler) return { err: "no sampler" };
  // the wall grid: 14 (y) × 16 (z)
  const PTS = [];
  for (let iy = 0; iy < 14; iy++) for (let iz = 0; iz < 16; iz++) {
    PTS.push([RED_X, Y0 + 0.2 + iy * (4.6 / 13), -2.3 + iz * (4.6 / 15)]);
  }
  const project = (P) => {
    const cam = viewport.camera;
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
    const py = (0.5 - (cy / cw) * 0.5) * sampler.height;
    if (!(px >= 2 && py >= 2 && px < sampler.width - 2 && py < sampler.height - 2)) return null;
    return [Math.round(px), Math.round(py)];
  };
  const frames = [];
  const total = REST + ORBIT + AFTER;
  const eye0 = POSE[0]; const tgt = POSE[1];
  const rx = eye0[0] - CENTRE[0]; const rz = eye0[2] - CENTRE[2];
  const setCam = (ang) => {
    const c = Math.cos(ang); const s = Math.sin(ang);
    const x = CENTRE[0] + rx * c - rz * s; const z = CENTRE[2] + rx * s + rz * c;
    const tx = CENTRE[0] + (tgt[0] - CENTRE[0]) * c - (tgt[2] - CENTRE[2]) * s;
    const tz = CENTRE[2] + (tgt[0] - CENTRE[0]) * s + (tgt[2] - CENTRE[2]) * c;
    viewport.camera.position.set(x, eye0[1], z);
    if (viewport.orbit) { viewport.orbit.target.set(tx, tgt[1], tz); viewport.orbit.update(); } else viewport.camera.lookAt(tx, tgt[1], tz);
    viewport.camera.updateMatrixWorld(true);
  };
  let i = 0; let pending = [];
  const rawEnd = stats.endPhaseFrame.bind(stats);
  const done = new Promise((resolve) => {
    stats.endPhaseFrame = function () {
      rawEnd();
      if (i >= total) { stats.endPhaseFrame = rawEnd; Promise.all(pending).then(resolve); return; }
      const phase = i < REST ? "rest" : i < REST + ORBIT ? "orbit" : "after";
      const ang = i < REST ? 0 : i < REST + ORBIT ? ((i - REST + 1) / ORBIT) * DEG * Math.PI / 180 : DEG * Math.PI / 180;
      setCam(ang);
      const px = []; const idx = [];
      for (let k = 0; k < PTS.length; k++) { const c = project(PTS[k]); if (c) { px.push(c); idx.push(k); } }
      const fi = i;
      const p = sampler.dispatch(px);
      if (p) pending.push(p.then((out) => {
        const rec = { i: fi, phase, ang: +(ang * 180 / Math.PI).toFixed(2), E: new Array(PTS.length).fill(null), dbg: [] };
        for (let j = 0; j < idx.length; j++) {
          const b = j * sampler.OUT_VEC * 4;
          const gx = out[b], gy = out[b + 1], gz = out[b + 2], gw = out[b + 3];
          const P = PTS[idx[j]];
          if (gw > 0.5 && Math.abs(gx - P[0]) < 0.15 && Math.abs(gy - P[1]) < 0.2 && Math.abs(gz - P[2]) < 0.2) {
            rec.E[idx[j]] = [out[b + 4], out[b + 5], out[b + 6]];
          } else if (fi === 0 && (idx[j] % 16) === 4) rec.dbg.push([idx[j], px[j], [gx, gy, gz, gw].map((v) => +v.toFixed(2)), P.map((v) => +v.toFixed(2))]);
        }
        frames[fi] = rec;
      }));
      i++;
    };
  });
  await done;
  const gb = sys.state.screen.gbuffer;
  const cv = viewport.renderer?.domElement ?? eng.renderer?.domElement;
  return { frames, pts: PTS, w: sampler.width, h: sampler.height, sizes: { gi2: [gi2.width, gi2.height], gbPos: [gb.position.image?.width, gb.position.image?.height], canvas: [cv?.width, cv?.height], rs: eng.renderer?.getPixelRatio?.(), aspect: viewport.camera.aspect } };
}, { REST, ORBIT, AFTER, DEG, POSE, RED_X, Y0, CENTRE });
if (res.err) { console.log(`FATAL ${res.err}`); await browser.close(); process.exit(1); }
console.log("  sizes " + JSON.stringify(res.sizes));
await browser.close();

// ── the reduction ─────────────────────────────────────────────────────────
const F = res.frames.filter(Boolean);
if (F[0]?.dbg?.length) console.log("  invalid-point debug (frame 0): " + JSON.stringify(F[0].dbg.slice(0, 8)));
const lum = (e) => 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2];
const N = res.pts.length;
// per-point rest luminance (the last 10 rest frames)
const restL = new Array(N).fill(0); const restN = new Array(N).fill(0);
for (const f of F) if (f.phase === "rest" && f.i >= REST - 10) for (let k = 0; k < N; k++) if (f.E[k]) { restL[k] += lum(f.E[k]); restN[k]++; }
for (let k = 0; k < N; k++) restL[k] = restN[k] ? restL[k] / restN[k] : 0;
const medRest = [...restL].filter((x) => x > 0).sort((a, b) => a - b);
const floor = 0.1 * (medRest[medRest.length >> 1] ?? 1e-3);
const q = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const greenFrac = (e) => { const s = e[0] + e[1] + e[2]; return s > 0 ? e[1] / s : 0; };
const stepRows = [];
let prev = null;
for (const f of F) {
  if (prev) {
    const rel = [];
    for (let k = 0; k < N; k++) if (f.E[k] && prev.E[k]) rel.push(Math.abs(lum(f.E[k]) - lum(prev.E[k])) / Math.max(restL[k], floor));
    const gf = []; for (let k = 0; k < N; k++) if (f.E[k]) gf.push(greenFrac(f.E[k]));
    const gmean = gf.reduce((a, b) => a + b, 0) / Math.max(1, gf.length);
    const gsig = Math.sqrt(gf.reduce((a, b) => a + (b - gmean) ** 2, 0) / Math.max(1, gf.length));
    stepRows.push({ i: f.i, phase: f.phase, ang: f.ang, n: rel.length, p90: q(rel, 0.9), max: q(rel, 1), gmean, gsig, gmax: q(gf, 1) });
  }
  prev = f;
}
const byPhase = (ph) => stepRows.filter((r) => r.phase === ph);
const summarise = (rows, label) => {
  const p90s = rows.map((r) => r.p90); const maxs = rows.map((r) => r.max);
  console.log(`  ${label.padEnd(6)} frames ${String(rows.length).padStart(3)}  step p90: median ${(100 * q(p90s, 0.5)).toFixed(2)} %  p90 ${(100 * q(p90s, 0.9)).toFixed(2)} %  worst ${(100 * q(p90s, 1)).toFixed(2)} %   step max: median ${(100 * q(maxs, 0.5)).toFixed(2)} %  worst ${(100 * q(maxs, 1)).toFixed(2)} %`);
};
console.log(`\n══ red-wall orbit probe: ${N} points, ${F.length} frames, ${DEG}° over ${ORBIT} frames ══`);
summarise(byPhase("rest"), "rest");
summarise(byPhase("orbit"), "orbit");
summarise(byPhase("after"), "after");
const restRows = byPhase("rest"); const afterRows = byPhase("after");
const gAt = (rows) => rows.length ? rows[rows.length - 1] : null;
console.log(`  green fraction on the red wall: rest mean ${gAt(restRows)?.gmean.toFixed(3)} σ ${gAt(restRows)?.gsig.toFixed(3)} max ${gAt(restRows)?.gmax.toFixed(3)}  →  after mean ${gAt(afterRows)?.gmean.toFixed(3)} σ ${gAt(afterRows)?.gsig.toFixed(3)} max ${gAt(afterRows)?.gmax.toFixed(3)}`);
console.log("  after-orbit σ(green) series (every 10 frames): " + afterRows.filter((_, j) => j % 10 === 0).map((r) => r.gsig.toFixed(3)).join(" "));
console.log("  orbit p90 step series: " + byPhase("orbit").map((r) => (100 * r.p90).toFixed(1)).join(" "));
console.log("  after p90 step series: " + afterRows.map((r) => (100 * r.p90).toFixed(1)).join(" "));
// the spatial map of green fraction at the end of after, rows = y (bottom→top), cols = z
const last = F[F.length - 1];
console.log("  green-fraction map (rows y bottom→top, cols z −2.3→2.3), ×100:");
for (let iy = 13; iy >= 0; iy--) {
  let row = "   ";
  for (let iz = 0; iz < 16; iz++) { const e = last.E[iy * 16 + iz]; row += e ? String(Math.round(100 * greenFrac(e))).padStart(4) : "   ."; }
  console.log(row);
}
if (OUT) writeFileSync(OUT, JSON.stringify({ steps: stepRows, restL, pts: res.pts, last }, null, 0));
