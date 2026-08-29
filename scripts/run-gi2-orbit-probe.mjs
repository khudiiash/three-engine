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
const CENTRE = process.env.CENTRE ? process.env.CENTRE.split(",").map(Number) : (SCENE === "Cornel" ? [0.38, Y0 + 2.5, 0] : POSE[1]);
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

// ── FLASH=1 — §19 6.16: the PERIODIC FLASH instrument. One composed frame per
// orbit step (`viewport.screenshot`, sRGB-decoded), scored as the MEAN
// LUMINANCE over the whole frame, the red wall, the ceiling band and the floor
// band, each tagged with the GI2 frame index it was composed from (so a step's
// cadence phase — `cascadeDue(frame)` — is on the row). A step whose mean moves
// > 10 % against the previous step is FLAGGED and the flagged steps are binned
// by cadence phase: a flash that lands on every 2nd/4th/8th frame names the
// cadence; one with no phase names something else.
if (process.env.FLASH) {
  const SW = Number(process.env.SW ?? 480), SH = Number(process.env.SH ?? 280);
  const r = await page.evaluate(async ({ REST, ORBIT, AFTER, DEG, POSE, CENTRE, SW, SH }) => {
    const viewport = globalThis.__giViewport;
    const eye0 = POSE[0]; const tgt = POSE[1];
    const rx = eye0[0] - CENTRE[0]; const rz = eye0[2] - CENTRE[2];
    const setCam = (ang) => {
      const c = Math.cos(ang); const s = Math.sin(ang);
      const x = CENTRE[0] + rx * c - rz * s; const z = CENTRE[2] + rx * s + rz * c;
      const tx = CENTRE[0] + (tgt[0] - CENTRE[0]) * c - (tgt[2] - CENTRE[2]) * s;
      const tz = CENTRE[2] + (tgt[0] - CENTRE[0]) * s + (tgt[2] - CENTRE[2]) * c;
      viewport.camera.position.set(x, eye0[1], z);
      if (viewport.orbit) { viewport.orbit.target.set(tx, tgt[1], tz); viewport.orbit.update(); } else viewport.camera.lookAt(tx, tgt[1], tz);
    };
    const raf = () => new Promise((res) => requestAnimationFrame(() => res()));
    const cv = document.createElement("canvas"); cv.width = SW; cv.height = SH;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const LUT = new Float32Array(256); for (let i = 0; i < 256; i++) LUT[i] = lin(i);
    const grab = async () => {
      const r = await globalThis.__editorApi.viewport.screenshot({ width: SW, height: SH, includeGizmos: false });
      const raw0 = typeof r === "string" ? r : (r?.__image ?? r?.png ?? r?.dataUrl ?? r?.image ?? r?.data ?? r?.base64);
      const raw1 = typeof raw0 === "string" ? raw0 : (raw0?.data ?? raw0?.base64 ?? String(raw0));
      const url = raw1.startsWith("data:") ? raw1 : "data:image/png;base64," + raw1;
      const img = new Image(); img.src = url; await img.decode();
      ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, SW, SH).data;
    };
    const total = REST + ORBIT + AFTER;
    const angAt = (i) => i < REST ? 0 : i < REST + ORBIT ? ((i - REST + 1) / ORBIT) * DEG * Math.PI / 180 : DEG * Math.PI / 180;
    const phaseAt = (i) => i < REST ? "rest" : i < REST + ORBIT ? "orbit" : "after";
    // ⚠ PER FRAME, NOT PER SETTLE. The camera moves on EVERY animation frame
    // and the composed frame is captured on every animation frame, un-awaited
    // (the render is synchronous; only the readback is deferred), so a step is
    // one engine frame and the cadence phase on the row is the phase of the
    // frame the user would have seen. The first instrument awaited each
    // screenshot and let ~7 frames pass per step — a slow orbit that every
    // cascade re-traces between steps, which is why it saw nothing.
    const pending = [];
    await new Promise((done) => {
      let i = 0;
      setCam(angAt(0));
      const tick = () => {
        const frame = globalThis.__giSys()?._gi2Frame ?? -1;
        // §19 6.16 receipts on the same row: the window scroll counter, the
        // rc anchor-jump counter, and the live probe population (one
        // un-awaited readback per frame — the age pass's counters).
        const g2 = globalThis.__gi2?.();
        const scrolls = g2?.snapshot?.()?.scrolls ?? -1;
        const jumps = g2?.rc?.anchorJumps?.() ?? -1;
        const renderer = globalThis.__giEngineForProbe?.renderer;
        const probes = (g2?.rc?.readProbeStats && renderer)
          ? g2.rc.readProbeStats(renderer).then((rows) => ({ live: rows.reduce((a, r) => a + r.live, 0), rekeyed: rows.reduce((a, r) => a + (r.rekeyed ?? 0), 0), fresh: rows.reduce((a, r) => a + r.fresh, 0) })).catch(() => null)
          : Promise.resolve(null);
        pending.push({ i, phase: phaseAt(i), frame, scrolls, jumps, probes, ang: +(angAt(i) * 180 / Math.PI).toFixed(2), p: grab() });
        i++;
        if (i >= total) { done(); return; }
        setCam(angAt(i));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const steps = []; let prevL = null;
    for (const st of pending) {
      const d = await st.p; const pr = await st.probes;
      const Lcur = new Float32Array(SW * SH); let nMove = 0, nBig = 0, nLamp = 0;
      let sAll = 0, nAll = 0, sRed = 0, nRed = 0, sCeil = 0, nCeil = 0, sFloor = 0, nFloor = 0, nBlack = 0;
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        const i0 = (y * SW + x) * 4; const R = LUT[d[i0]], G = LUT[d[i0 + 1]], B = LUT[d[i0 + 2]];
        const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        sAll += L; nAll++; if (L < 0.002) nBlack++;
        if (d[i0] >= 250 && d[i0 + 1] >= 250 && d[i0 + 2] >= 250) nLamp++;
        Lcur[y * SW + x] = L;
        if (prevL) { const Lp = prevL[y * SW + x]; const m = Math.max(L, Lp); if (m > 0.01) { const rr = Math.abs(L - Lp) / m; if (rr > 0.5) nBig++; if (rr > 0.2) nMove++; } }
        const red = R > 0.02 && R > 3 * G && R > 3 * B;
        const grn = G > 0.02 && G > 3 * R && G > 3 * B;
        if (red) { sRed += L; nRed++; }
        else if (!grn && L > 0.005) {
          if (y < SH * 0.2) { sCeil += L; nCeil++; }
          else if (y > SH * 0.8) { sFloor += L; nFloor++; }
        }
      }
      prevL = Lcur;
      steps.push({ i: st.i, px50: nBig / nAll, px20: nMove / nAll, lamp: nLamp / nAll, scrolls: st.scrolls, jumps: st.jumps, live: pr?.live ?? -1, rekeyed: pr?.rekeyed ?? -1, fresh: pr?.fresh ?? -1, phase: st.phase, frame: st.frame, ang: st.ang, all: sAll / Math.max(1, nAll), red: nRed ? sRed / nRed : 0, ceil: nCeil ? sCeil / nCeil : 0, floor: nFloor ? sFloor / nFloor : 0, nRed, black: nBlack / nAll });
    }
    return steps;
  }, { REST, ORBIT, AFTER, DEG, POSE, CENTRE, SW, SH });
  await browser.close();
  const due = (f) => { let c = 0; while (c < 3 && (f % (1 << (c + 1))) === 0) c++; return c; };
  console.log(`\n══ FLASH arm — composed-frame mean luminance per step, ${DEG}° over ${ORBIT} steps (${SW}x${SH}) — FLAGS ${process.env.FLAGS ?? "{}"} ══`);
  const rel = (a, b) => (b > 1e-6 ? (a - b) / b : 0);
  const q = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  for (const ph of ["rest", "orbit", "after"]) {
    const rows = r.filter((x) => x.phase === ph);
    const flagged = []; const dAll = [], dRed = [], dCeil = [], dFloor = [];
    for (let k = 0; k < rows.length; k++) {
      const x = rows[k]; const p = r[x.i - 1]; if (!p) continue;
      const da = rel(x.all, p.all), dr = rel(x.red, p.red), dc = rel(x.ceil, p.ceil), df = rel(x.floor, p.floor);
      dAll.push(Math.abs(da)); dRed.push(Math.abs(dr)); dCeil.push(Math.abs(dc)); dFloor.push(Math.abs(df));
      if (Math.max(Math.abs(da), Math.abs(dr), Math.abs(dc), Math.abs(df)) > 0.10) flagged.push({ ...x, da, dr, dc, df, dframe: x.frame - p.frame });
    }
    const frames = rows.map((x) => x.frame); const dfr = frames.slice(1).map((f, k) => f - frames[k]);
    console.log(`  ${ph.padEnd(6)} steps ${String(rows.length).padStart(3)}  frames/step median ${q(dfr, 0.5)} max ${q(dfr, 1)}  |Δ| all: p90 ${(100 * q(dAll, 0.9)).toFixed(2)} % max ${(100 * q(dAll, 1)).toFixed(2)} %  red: p90 ${(100 * q(dRed, 0.9)).toFixed(2)} % max ${(100 * q(dRed, 1)).toFixed(2)} %  ceil: p90 ${(100 * q(dCeil, 0.9)).toFixed(2)} % max ${(100 * q(dCeil, 1)).toFixed(2)} %  floor: p90 ${(100 * q(dFloor, 0.9)).toFixed(2)} % max ${(100 * q(dFloor, 1)).toFixed(2)} %  FLAGGED ${flagged.length}`);
    if (flagged.length) {
      const byDue = [0, 0, 0, 0]; for (const f of flagged) byDue[due(f.frame)]++;
      console.log(`    flagged by cadence phase due(frame) c0/c1/c2/c3: ${byDue.join("/")}   (unflagged phases: ${[0, 1, 2, 3].map((c) => rows.filter((x) => due(x.frame) === c).length - byDue[c]).join("/")})`);
      for (const f of flagged.slice(0, 24)) console.log(`    step ${String(f.i).padStart(3)} frame ${f.frame} (+${f.dframe}, due c${due(f.frame)}) ang ${f.ang}  all ${(100 * f.da).toFixed(1)} %  red ${(100 * f.dr).toFixed(1)} %  ceil ${(100 * f.dc).toFixed(1)} %  floor ${(100 * f.df).toFixed(1)} %  black ${(100 * f.black).toFixed(1)} %`);
    }
  }
  const orbit = r.filter((x) => x.phase === "orbit");
  console.log("  orbit mean-all series  : " + orbit.map((x) => x.all.toFixed(4)).join(" "));
  console.log("  orbit Δall % series    : " + orbit.map((x) => (100 * rel(x.all, r[x.i - 1].all)).toFixed(1)).join(" "));
  console.log("  orbit Δred % series    : " + orbit.map((x) => (100 * rel(x.red, r[x.i - 1].red)).toFixed(1)).join(" "));
  console.log("  orbit Δceil % series   : " + orbit.map((x) => (100 * rel(x.ceil, r[x.i - 1].ceil)).toFixed(1)).join(" "));
  console.log("  orbit Δfloor % series  : " + orbit.map((x) => (100 * rel(x.floor, r[x.i - 1].floor)).toFixed(1)).join(" "));
  console.log("  orbit frame series     : " + orbit.map((x) => x.frame).join(" "));
  console.log("  orbit px>50% series    : " + orbit.map((x) => (100 * x.px50).toFixed(1)).join(" "));
  console.log("  orbit lamp px % series : " + orbit.map((x) => (100 * x.lamp).toFixed(1)).join(" "));
  console.log("  orbit scrolls series   : " + orbit.map((x) => x.scrolls).join(" "));
  console.log("  orbit anchorJumps      : " + orbit.map((x) => x.jumps).join(" "));
  console.log("  orbit live probes      : " + orbit.map((x) => x.live).join(" "));
  console.log("  orbit rekeyed series   : " + orbit.map((x) => x.rekeyed).join(" "));
  for (let k = 1; k < r.length; k++) {
    const x = r[k], p = r[k - 1];
    if (x.jumps > p.jumps) console.log(`  ANCHOR JUMP at step ${x.i} (frame ${x.frame}, ${x.phase}, ang ${x.ang}): Δmean ${(100 * rel(x.all, p.all)).toFixed(1)} %  px>50 % ${(100 * x.px50).toFixed(1)} %  live ${p.live} → ${x.live} → ${r[k + 1]?.live ?? "?"}  rekeyed ${x.rekeyed}  fresh ${x.fresh}`);
    if (x.scrolls > p.scrolls) console.log(`  window scroll at step ${x.i} (frame ${x.frame}, ${x.phase}, ang ${x.ang}): Δmean ${(100 * rel(x.all, p.all)).toFixed(1)} %  px>50 % ${(100 * x.px50).toFixed(1)} %`);
  }
  console.log("  orbit px>20% series    : " + orbit.map((x) => (100 * x.px20).toFixed(1)).join(" "));
  const px50 = orbit.map((x) => x.px50);
  console.log(`  orbit per-pixel |ΔL|>50 % fraction: median ${(100 * q(px50, 0.5)).toFixed(1)} % p90 ${(100 * q(px50, 0.9)).toFixed(1)} % max ${(100 * q(px50, 1)).toFixed(1)} %  (a full-frame flash reads ~100 %; a 1°/frame slide of smooth shading reads a few %)`);
  if (OUT) writeFileSync(OUT, JSON.stringify(r));
  process.exit(0);
}


// ── SHOT=1 — the fallback instrument: the FINAL COMPOSED FRAME per orbit step
// via `viewport.screenshot` (decoded in-page, sRGB → linear), scored on the
// red-wall pixels. Coarser than the irradiance readback (a screenshot is not
// one engine frame, and screen pixels slide over the wall as the camera moves)
// but it sees exactly what the user sees.
if (process.env.SHOT) {
  const SW = Number(process.env.SW ?? 480), SH = Number(process.env.SH ?? 320);
  const r = await page.evaluate(async ({ REST, ORBIT, AFTER, DEG, POSE, CENTRE, SW, SH }) => {
    const viewport = globalThis.__giViewport;
    const eye0 = POSE[0]; const tgt = POSE[1];
    const rx = eye0[0] - CENTRE[0]; const rz = eye0[2] - CENTRE[2];
    const setCam = (ang) => {
      const c = Math.cos(ang); const s = Math.sin(ang);
      const x = CENTRE[0] + rx * c - rz * s; const z = CENTRE[2] + rx * s + rz * c;
      const tx = CENTRE[0] + (tgt[0] - CENTRE[0]) * c - (tgt[2] - CENTRE[2]) * s;
      const tz = CENTRE[2] + (tgt[0] - CENTRE[0]) * s + (tgt[2] - CENTRE[2]) * c;
      viewport.camera.position.set(x, eye0[1], z);
      if (viewport.orbit) { viewport.orbit.target.set(tx, tgt[1], tz); viewport.orbit.update(); } else viewport.camera.lookAt(tx, tgt[1], tz);
    };
    const raf = () => new Promise((res) => requestAnimationFrame(() => res()));
    const cv = document.createElement("canvas"); cv.width = SW; cv.height = SH;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const LUT = new Float32Array(256); for (let i = 0; i < 256; i++) LUT[i] = lin(i);
    const grab = async () => {
      const r = await globalThis.__editorApi.viewport.screenshot({ width: SW, height: SH, includeGizmos: false });
      const raw0 = typeof r === "string" ? r : (r?.__image ?? r?.png ?? r?.dataUrl ?? r?.image ?? r?.data ?? r?.base64);
      const raw1 = typeof raw0 === "string" ? raw0 : (raw0?.data ?? raw0?.base64 ?? String(raw0));
      const url = raw1.startsWith("data:") ? raw1 : "data:image/png;base64," + raw1;
      const img = new Image(); img.src = url; await img.decode();
      ctx.drawImage(img, 0, 0); const d = ctx.getImageData(0, 0, SW, SH).data;
      const R = new Float32Array(SW * SH), G = new Float32Array(SW * SH), B = new Float32Array(SW * SH);
      for (let i = 0; i < SW * SH; i++) { R[i] = LUT[d[i * 4]]; G[i] = LUT[d[i * 4 + 1]]; B[i] = LUT[d[i * 4 + 2]]; }
      return { R, G, B };
    };
    const isRed = (f, i) => f.R[i] > 0.02 && f.R[i] > 3 * f.G[i] && f.R[i] > 3 * f.B[i];
    const q = (arr, p) => { if (!arr.length) return 0; const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const steps = []; let prev = null; const total = REST + ORBIT + AFTER;
    for (let i = 0; i < total; i++) {
      const phase = i < REST ? "rest" : i < REST + ORBIT ? "orbit" : "after";
      const ang = i < REST ? 0 : i < REST + ORBIT ? ((i - REST + 1) / ORBIT) * DEG * Math.PI / 180 : DEG * Math.PI / 180;
      setCam(ang); await raf(); await raf();
      const f = await grab();
      // the red mask, eroded by one pixel so edge pixels never score
      const mask = new Uint8Array(SW * SH);
      for (let y = 1; y < SH - 1; y++) for (let x = 1; x < SW - 1; x++) {
        const i0 = y * SW + x; if (!isRed(f, i0)) continue;
        let ok = true; for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (!isRed(f, i0 + dy * SW + dx)) { ok = false; break; }
        mask[i0] = ok ? 1 : 0;
      }
      const rel = []; const gr = []; let ymin = SH, ymax = 0;
      for (let i0 = 0; i0 < SW * SH; i0++) if (mask[i0]) { const y = (i0 / SW) | 0; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
      const grTop = [], grMid = [], grBot = [];
      for (let i0 = 0; i0 < SW * SH; i0++) {
        if (!mask[i0]) continue;
        const L = 0.2126 * f.R[i0] + 0.7152 * f.G[i0] + 0.0722 * f.B[i0];
        if (prev && prev.mask[i0]) { const Lp = 0.2126 * prev.f.R[i0] + 0.7152 * prev.f.G[i0] + 0.0722 * prev.f.B[i0]; rel.push(Math.abs(L - Lp) / Math.max(Lp, 1e-3)); }
        const g = f.G[i0] / f.R[i0]; gr.push(g);
        const y = (i0 / SW) | 0; const t = (y - ymin) / Math.max(1, ymax - ymin);
        (t < 0.15 ? grTop : t > 0.85 ? grBot : (t > 0.35 && t < 0.65 ? grMid : null))?.push(g);
      }
      const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
      const gm = mean(gr); const gs = Math.sqrt(mean(gr.map((v) => (v - gm) ** 2)));
      steps.push({ i, phase, ang: +(ang * 180 / Math.PI).toFixed(1), n: rel.length, red: gr.length, p90: q(rel, 0.9), max: q(rel, 1), gmean: gm, gsig: gs, gmax: q(gr, 1), gTop: mean(grTop), gMid: mean(grMid), gBot: mean(grBot), gTopMax: q(grTop, 1), gBotMax: q(grBot, 1) });
      prev = { f, mask };
    }
    return steps;
  }, { REST, ORBIT, AFTER, DEG, POSE, CENTRE, SW, SH });
  await browser.close();
  const q = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const by = (ph) => r.filter((x) => x.phase === ph && x.n > 0);
  console.log(`\n══ SHOT arm — red-wall pixels of the composed frame, ${DEG}° over ${ORBIT} steps (${SW}x${SH}) — FLAGS ${process.env.FLAGS ?? "{}"} ══`);
  for (const ph of ["rest", "orbit", "after"]) {
    const rows = by(ph); const p90s = rows.map((x) => x.p90); const maxs = rows.map((x) => x.max);
    console.log(`  ${ph.padEnd(6)} steps ${String(rows.length).padStart(3)}  red px ${rows[0]?.red ?? 0}  step p90: median ${(100 * q(p90s, 0.5)).toFixed(2)} %  p90 ${(100 * q(p90s, 0.9)).toFixed(2)} %  worst ${(100 * q(p90s, 1)).toFixed(2)} %   step max: median ${(100 * q(maxs, 0.5)).toFixed(2)} %  worst ${(100 * q(maxs, 1)).toFixed(2)} %`);
  }
  const stop = r.find((x) => x.phase === "after");
  console.log(`  stop step (first after-frame): p90 ${(100 * (stop?.p90 ?? 0)).toFixed(2)} %  max ${(100 * (stop?.max ?? 0)).toFixed(2)} %`);
  const g = (x) => `mean ${x.gmean.toFixed(3)} σ ${x.gsig.toFixed(3)} max ${x.gmax.toFixed(3)} | top(ceiling) ${x.gTop.toFixed(3)} (max ${x.gTopMax.toFixed(3)}) mid ${x.gMid.toFixed(3)} bottom(floor) ${x.gBot.toFixed(3)} (max ${x.gBotMax.toFixed(3)})`;
  console.log(`  G/R on red pixels at rest before: ${g(r[REST - 1])}`);
  console.log(`  G/R on red pixels at rest after : ${g(r[r.length - 1])}`);
  console.log("  orbit p90 series: " + by("orbit").map((x) => (100 * x.p90).toFixed(1)).join(" "));
  console.log("  orbit max series: " + by("orbit").map((x) => (100 * x.max).toFixed(1)).join(" "));
  console.log("  after p90 series: " + by("after").map((x) => (100 * x.p90).toFixed(1)).join(" "));
  if (OUT) writeFileSync(OUT, JSON.stringify(r));
  process.exit(0);
}
if (process.env.GRID) {
  const g = await page.evaluate(async () => {
    const eng = globalThis.__giEngineForProbe; const sys = globalThis.__giSys(); const gi2 = globalThis.__gi2();
    const viewport = globalThis.__giViewport;
    const { createGi2PointSampler } = await import("/scripts/lib/gi2PointProbe.js");
    const sampler = createGi2PointSampler({ renderer: eng.renderer, gi2, screen: sys.state.screen });
    const px = []; const NX = 33, NY = 13;
    for (let iy = 0; iy < NY; iy++) for (let ix = 0; ix < NX; ix++) px.push([Math.round((ix + 0.5) * sampler.width / NX), Math.round((iy + 0.5) * sampler.height / NY)]);
    const out = await sampler.sample(px);
    const rows = [];
    for (let iy = 0; iy < NY; iy++) { let r = ""; for (let ix = 0; ix < NX; ix++) { const b = (iy * NX + ix) * sampler.OUT_VEC * 4; const w = out[b + 3]; const x = out[b]; r += w > 0.5 ? (x < -1.9 ? "R" : x > 2.7 ? "G" : "o") : "."; } rows.push(r); }
    const cam = viewport.camera; cam.updateMatrixWorld(true);
    const gb = sys.state.screen.gbuffer; let direct = null, direct2 = null;
    try { const buf = new Float32Array(4); await eng.renderer.readRenderTargetPixelsAsync(gb.rt, (sampler.width / 2) | 0, (sampler.height / 2) | 0, 1, 1, buf, 0, 0); direct = Array.from(buf); } catch (e) { direct = String(e); }
    try { const buf = new Float32Array(4); await eng.renderer.readRenderTargetPixelsAsync(gb.rt, 100, 100, 1, 1, buf, 0, 0); direct2 = Array.from(buf); } catch (e) { direct2 = String(e); }
    const held = sys._gbufHeld; const heldFrames = sys._gbufferHeldFrames; const same = gb.rt.textures[0] === gb.position;
    const engCam = eng.camera; const sameCam = engCam === cam; const ecp = engCam ? [engCam.position.x, engCam.position.y, engCam.position.z] : null;
    return { direct, direct2, held, heldFrames, same, sameCam, ecp, rtSize: [gb.rt.width, gb.rt.height], rows, w: sampler.width, h: sampler.height, cam: [cam.position.x, cam.position.y, cam.position.z], q: cam.quaternion.toArray(), gi2cam: gi2?.uniforms?.rcCamera?.value ?? null };
  });
  console.log("  gbuffer validity grid (R = red-wall x, G = green-wall x, o = other, . = empty):"); for (const r of g.rows) console.log("   " + r);
  console.log("  direct " + JSON.stringify(g.direct) + " direct2 " + JSON.stringify(g.direct2) + " held " + g.held + "/" + g.heldFrames + " sameTex " + g.same + " sameCam " + g.sameCam + " engCam " + JSON.stringify(g.ecp) + " rt " + JSON.stringify(g.rtSize));
  console.log("  cam " + JSON.stringify(g.cam) + " q " + JSON.stringify(g.q.map((v) => +v.toFixed(3))));
  await browser.close(); process.exit(0);
}
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
