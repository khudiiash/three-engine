// §19 STAGE 5.4a — THE COLD-START RECEIPT: BLACK PIXELS WHILE THE CAMERA MOVES.
//
// The user's report is "checkerboards building every time I move my camera".
// Every existing GI2 instrument reports a SETTLED scene, so none of them can
// see it. This one reads `gi2.textures.irradiance` — the texture every material
// samples — ONCE PER FRAME through `createGi2PixelDump`, parked and then moving,
// and reports the fraction of VALID pixels whose irradiance luminance is under
// BLACK_T.
//
// A moved camera sees different geometry, so a per-pixel A/B across the move is
// meaningless. The measure is therefore the black FRACTION of the frame, with
// the parked frame at the same pose as its own base rate: the artifact is a
// POPULATION of newly-seeded probe footprints, and a population is what this
// counts. EXCESS BLACK (moving minus parked base) is the headline.
//
// Env: PROJECT SCENE POSE='x,y,z|x,y,z' SETTLE MOVE RECOVER TARGET YAW DOLLY
//      FLAGS='{"__gi2RcWarmFrames":0}' CHROME_PATH HEADED
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = (process.argv[2] ?? "http://localhost:5203/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 60);
const MOVE = Number(process.env.MOVE ?? 30);
const RECOVER = Number(process.env.RECOVER ?? 24);
const TARGET = Number(process.env.TARGET ?? 160);
const YAW = Number(process.env.YAW ?? 1.5);
const DOLLY = Number(process.env.DOLLY ?? 0.12);
const BLACK_T = Number(process.env.BLACK_T ?? 0.02);
const LIT_T = Number(process.env.LIT_T ?? 0.10);
const POSE = process.env.POSE ?? "";
const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : "n/a");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  protocolTimeout: 1800000,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox",
    "--disable-dev-shm-usage", "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((flags) => {
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, JSON.parse(process.env.FLAGS ?? "{}"));
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] (first light|window)|\[gi\] built/.test(t)) console.log(`    ${t.slice(0, 160)}`);
});
page.on("pageerror", (e) => console.log(`    pageerror: ${String(e?.stack ?? e).slice(0, 160)}`));

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 240000 });
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__eng = mod.engine;
  globalThis.__giSys = () => mod.engine?.modules?.get?.("gi")?.system ?? null;
  globalThis.__gi2 = () => {
    const s = globalThis.__giSys();
    return s?._gi2 ?? s?.state?.screen?.gi2 ?? null;
  };
});
const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });

console.log(`\n== ${SCENE} -- COLD START  FLAGS=${process.env.FLAGS ?? "{}"} ==`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
await page.waitForFunction(() => {
  const g = globalThis.__gi2 ? globalThis.__gi2() : null;
  return !!g && (g.gather?.probeCount ?? 0) > 0;
}, { timeout: 600000, polling: 500 });
if (POSE) {
  const parts = POSE.split("|").map((s) => s.split(",").map(Number));
  await call("viewport.setCamera", { position: parts[0], target: parts[1] });
}

const rig = await page.evaluate(async (opts) => {
  try {
    const { createGi2PixelDump, GI2_PIXEL_OUT_VEC } = await import("/scripts/lib/gi2PixelDump.js");
    let readSrcProbeStats = null;
    try {
      const m = await import("/src/modules/gi/srcProbes.js");
      readSrcProbeStats = m.readSrcProbeStats;
    } catch { /* counters optional */ }
    const eng = globalThis.__eng;
    const sys = globalThis.__giSys();
    const gi2 = globalThis.__gi2();
    const rc = gi2.rc ?? gi2.win?.rc ?? sys.state?.screen?.rc ?? sys.state?.rc ?? null;
    const dump = createGi2PixelDump({
      renderer: eng.renderer, gi2, screen: sys.state?.screen,
      stride: Math.max(1, Math.round(gi2.width / opts.TARGET)),
    });
    if (!dump) return { error: "pixel dump unavailable" };
    const OV = GI2_PIXEL_OUT_VEC;
    const awaitFrame = () => new Promise((r) => { const off = eng.onPostRender(() => { off(); r(); }); });
    globalThis.__cold = {
      async frame() {
        const d = await dump.read(awaitFrame);
        let valid = 0; let black = 0; let lit = 0; let sum = 0;
        for (let y = 0; y < dump.dumpH; y++) {
          for (let x = 0; x < dump.dumpW; x++) {
            const b = (y * dump.dumpW + x) * OV * 4;
            if (d[b + 3] < 0.5) continue;
            valid++;
            const L = 0.2126 * d[b + 8] + 0.7152 * d[b + 9] + 0.0722 * d[b + 10];
            sum += L;
            if (L < globalThis.__coldBlackT) black++;
            if (L > globalThis.__coldLitT) lit++;
          }
        }
        let fresh = 0; let live = 0;
        if (rc && readSrcProbeStats) {
          try {
            const st = await readSrcProbeStats(eng.renderer, rc.store);
            for (const s of st) { fresh += s.fresh; live += s.live; }
          } catch { /* counters unavailable */ }
        }
        return { valid, black, lit, meanE: valid ? sum / valid : 0, fresh, live };
      },
      move(yaw, dolly) {
        const c = globalThis.__coldCam;
        c.yaw += (yaw * Math.PI) / 180;
        c.r = Math.max(2, c.r - dolly);
        return {
          position: [c.t[0] + c.r * Math.sin(c.yaw), c.eyeY, c.t[2] + c.r * Math.cos(c.yaw)],
          target: c.t,
        };
      },
    };
    return { ok: true, hasRc: !!rc, hasStats: !!readSrcProbeStats, dumpW: dump.dumpW, dumpH: dump.dumpH, probes: gi2.gather.probeCount ?? 0 };
  } catch (err) { return { error: `${err && err.message ? err.message : err}` }; }
}, { TARGET });
if (!rig || rig.error) { console.log(`FATAL rig: ${rig ? rig.error : "no return"}`); await browser.close(); process.exit(1); }
await page.evaluate((t) => { globalThis.__coldBlackT = t[0]; globalThis.__coldLitT = t[1]; }, [BLACK_T, LIT_T]);
console.log(`  rig: ${rig.dumpW}x${rig.dumpH} dump, probes ${rig.probes}, rc ${rig.hasRc ? "yes" : "NO"}, counters ${rig.hasStats ? "yes" : "NO"}`);

const cam0 = (await call("viewport.getCamera")).value ?? {};
const eye = cam0.position ?? [0, 2, 6];
const tgt = cam0.target ?? [0, 2, 0];
await page.evaluate((c) => {
  const dx = c.eye[0] - c.tgt[0]; const dz = c.eye[2] - c.tgt[2];
  globalThis.__coldCam = { t: c.tgt, eyeY: c.eye[1], r: Math.hypot(dx, dz) || 6, yaw: Math.atan2(dx, dz) };
}, { eye, tgt });
console.log(`  pose: eye [${eye.map((v) => f(v, 2))}] target [${tgt.map((v) => f(v, 2))}]`);

const readOne = () => page.evaluate(() => globalThis.__cold.frame());
const seg = async (label, n, moving) => {
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (moving) {
      const c = await page.evaluate((o) => globalThis.__cold.move(o.y, o.d), { y: YAW, d: DOLLY });
      await call("viewport.setCamera", c);
    }
    rows.push(await readOne());
  }
  const pct = rows.map((r) => (r.valid ? (100 * r.black) / r.valid : NaN));
  const fr = rows.map((r) => r.fresh);
  console.log(`  ${label.padEnd(8)} black% mean ${f(mean(pct), 2)} max ${f(Math.max(...pct), 2)}` +
    `  |  fresh/frame mean ${Math.round(mean(fr))} max ${Math.max(...fr)}` +
    `  |  live ${rows[rows.length - 1].live}  meanE ${f(rows[rows.length - 1].meanE, 4)}`);
  return { rows, pct, fr };
};

for (let i = 0; i < SETTLE; i++) await readOne();
const parked = await seg("PARKED", 16, false);
const moving = await seg("MOVING", MOVE, true);
const after = await seg("RECOVER", RECOVER, false);
const base = mean(parked.pct);
const excess = moving.pct.map((p) => p - base);
console.log(`\n  EXCESS BLACK moving: mean ${f(mean(excess), 2)} pp  max ${f(Math.max(...excess), 2)} pp   (parked base ${f(base, 2)} %)`);
const rec = after.pct.findIndex((p) => p <= base + 0.05);
console.log(`  frames to recover: ${rec < 0 ? `>${RECOVER}` : rec}`);
console.log(`  black% moving : ${moving.pct.map((p) => p.toFixed(1)).join(" ")}`);
console.log(`  fresh   moving: ${moving.fr.join(" ")}`);
await browser.close();
