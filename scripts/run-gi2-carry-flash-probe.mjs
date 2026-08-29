// GI2 CARRY FLASH PROBE — §19 6.29: "a dragged object settles and the light
// flashes black".
//
// Boots the harness on Cornell, parks the camera, then captures the COMPOSED
// frame's mean luminance on every animation frame while an entity (the Box by
// default) is moved once through `entity.setTransform` at frame MOVE. That one
// move drives the 6.22 mobility resolver through a PROMOTION rebuild (the mesh
// starts moving) and, ~90 frames later, a SETTLE rebuild (it stops). Before
// 6.29 each rebuild re-created the GI2 system and the light restarted from
// black; the receipt is the largest frame-over-frame DROP of the mean and the
// count of frames that dropped more than 3 %.
//
// Usage: node scripts/run-gi2-carry-flash-probe.mjs http://127.0.0.1:5204/
//   env: SCENE (Cornel), ENTITY (/box/i), MOVE (30), TOTAL (260), DX (0.6),
//        FLAGS='{"__gi2CarryState":false}' for the before-6.29 arm.
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5204/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const ENTITY = new RegExp(process.env.ENTITY ?? "box", "i");
const MOVE = Number(process.env.MOVE ?? 30);
const TOTAL = Number(process.env.TOTAL ?? 260);
const DX = Number(process.env.DX ?? 0.6);
const SETTLE = Number(process.env.SETTLE ?? 8);
const POSE = (process.env.POSE ?? "1.6,2.3,2.1|-0.6,2.0,-2.5").split("|").map((s) => s.split(",").map(Number));
const SW = Number(process.env.SW ?? 480), SH = Number(process.env.SH ?? 280);
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
const events = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light|\[gi\] field ready/.test(t)) firstLight = true;
  if (/CARRIED|NOT carried|hold released|transport refreshed|\[gi2\] soup |compile wave started|mobility/.test(t)) {
    events.push(t.slice(0, 150));
  }
  if (/\[gi\].*(rror|ailed)/i.test(t)) console.log(`  ${t.slice(0, 160)}`);
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
  vh.camera.position.set(p[0], p[1], p[2]);
  if (vh.orbit) { vh.orbit.target.set(t[0], t[1], t[2]); vh.orbit.update(); } else vh.camera.lookAt(t[0], t[1], t[2]);
}, { p: POSE[0], t: POSE[1] });
await wait(SETTLE * 1000);

const target = await page.evaluate(async (src) => {
  const re = new RegExp(src, "i");
  const list = await globalThis.__editorApi.call("entity.list", {});
  const rows = Array.isArray(list) ? list : (list?.entities ?? list?.items ?? []);
  const hit = rows.find((e) => re.test(e.name ?? "")) ?? null;
  return hit ? { id: hit.id, name: hit.name } : { rows: rows.slice(0, 12).map((e) => e.name) };
}, ENTITY.source);
if (!target?.id) { console.log(`FATAL: no entity matching ${ENTITY} — names: ${JSON.stringify(target?.rows)}`); await browser.close(); process.exit(1); }
console.log(`moving "${target.name}" (${target.id}) by +${DX} x at frame ${MOVE}, ${TOTAL} frames captured`);
const eventsAtStart = events.length;

const r = await page.evaluate(async ({ MOVE, TOTAL, DX, id, SW, SH }) => {
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
  const snap = () => {
    const g2 = globalThis.__gi2?.(); const s = g2?.snapshot?.() ?? {};
    const sys = globalThis.__giSys(); const eng = globalThis.__giEngineForProbe;
    const light = sys?.state?.light ?? null;
    return {
      soupBuilds: s.soupBuilds ?? -1, carried: s.carriedBuilds ?? -1, hold: !!s.rcHold,
      // §19 6.29b receipts — WHICH of the candidate gates is true on a black frame.
      skipped: eng?.stats?.skippedFps ?? eng?.statsSystem?.skippedFps ?? -1,
      irr: g2?.textures?.irradiance?.uuid?.slice(0, 8) ?? "-",
      irrNode: sys?._giIrradianceNode?.value?.uuid?.slice(0, 8) ?? "-",
      light: light ? light.uuid.slice(0, 8) : "-",
      lightIn: !!(light && light.parent === eng?.scene),
      state: !!sys?.state, wave: !!sys?._compileWaveActive, gbufHeld: sys?._gbufHeld === true,
    };
  };
  const before = snap();
  const pending = [];
  let moved = null;
  await new Promise((done) => {
    let i = 0;
    const tick = () => {
      const frame = globalThis.__giSys()?._gi2Frame ?? -1;
      if (i === MOVE) {
        const ent = globalThis.__editorApi.call("entity.get", { id }).then((e) => {
          const p = e?.transform?.position ?? e?.position ?? [0, 0, 0];
          moved = [p[0] + DX, p[1], p[2]];
          return globalThis.__editorApi.call("entity.setTransform", { id, position: moved });
        }).catch((err) => { moved = String(err?.message ?? err); });
        void ent;
      }
      pending.push({ i, frame, s: snap(), p: grab() });
      i++;
      if (i >= TOTAL) { done(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const steps = [];
  for (const st of pending) {
    const d = await st.p; let sAll = 0, nAll = 0, nBlack = 0;
    for (let k = 0; k < SW * SH * 4; k += 4) {
      const L = 0.2126 * LUT[d[k]] + 0.7152 * LUT[d[k + 1]] + 0.0722 * LUT[d[k + 2]];
      sAll += L; nAll++; if (L < 0.002) nBlack++;
    }
    steps.push({ i: st.i, frame: st.frame, all: sAll / nAll, black: nBlack / nAll, soup: st.s.soupBuilds, carried: st.s.carried, hold: st.s.hold, r: st.s });
  }
  return { steps, before, after: snap(), moved };
}, { MOVE, TOTAL, DX, id: target.id, SW, SH });
await wait(500);
await browser.close();

console.log(`\n══ CARRY FLASH — composed-frame mean per frame, move at frame ${MOVE} — FLAGS ${process.env.FLAGS ?? "{}"} ══`);
console.log(`moved to ${JSON.stringify(r.moved)}; soupBuilds ${r.before.soupBuilds} → ${r.after.soupBuilds}; carriedBuilds ${r.before.carried} → ${r.after.carried}`);
const rel = (a, b) => (b > 1e-6 ? (a - b) / b : 0);
let worst = { d: 0 }; let over3 = 0; let over10 = 0;
const flagged = [];
for (let k = 1; k < r.steps.length; k++) {
  const x = r.steps[k], p = r.steps[k - 1];
  const d = rel(x.all, p.all);
  if (d < -0.03) over3++;
  if (d < -0.10) over10++;
  if (d < worst.d) worst = { d, i: x.i, frame: x.frame, from: p.all, to: x.all };
  if (Math.abs(d) > 0.03 || x.carried !== p.carried || x.hold !== p.hold || x.soup !== p.soup || x.black > 0.5 || (x.r?.lightIn !== p.r?.lightIn) || (x.r?.wave !== p.r?.wave)) {
    const q = x.r ?? {}; const pq = p.r ?? {};
    flagged.push(`  step ${String(x.i).padStart(3)} frame ${x.frame}: mean ${p.all.toFixed(4)} → ${x.all.toFixed(4)} (${(100 * d).toFixed(1)} %) black ${(100 * x.black).toFixed(1)} %  soup ${x.soup} carried ${x.carried} hold ${x.hold ? 1 : 0}` +
      ` | skippedFps ${q.skipped} irr ${q.irr}${q.irr !== pq.irr ? "*" : ""} node ${q.irrNode === q.irr ? "same" : "DIFF"} light ${q.light}${q.light !== pq.light ? "*" : ""} in-scene ${q.lightIn ? 1 : 0} state ${q.state ? 1 : 0} wave ${q.wave ? 1 : 0} gbufHeld ${q.gbufHeld ? 1 : 0}`);
  }
}
const first = r.steps[0]?.all ?? 0, last = r.steps[r.steps.length - 1]?.all ?? 0;
console.log(`mean at start ${first.toFixed(4)}, at end ${last.toFixed(4)}; worst frame-over-frame drop ${(100 * worst.d).toFixed(1)} % at step ${worst.i ?? "-"} (frame ${worst.frame ?? "-"}); frames dropping > 3 %: ${over3}; > 10 %: ${over10}`);
for (const l of flagged.slice(0, 40)) console.log(l);
console.log("events:");
for (const e of events.slice(eventsAtStart)) console.log(`  ${e}`);
console.log(over3 === 0 ? "PASS: no frame dropped more than 3 % across the promotion + settle" : `FAIL: ${over3} frame(s) dropped more than 3 %`);
process.exit(over3 === 0 ? 0 : 1);
