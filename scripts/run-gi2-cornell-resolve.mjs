// ⭐⭐ THE BLACK PIXELS, ONE STAGE FURTHER DOWN — THE RESOLVE (§19 §AJ.2b).
//
// `run-gi2-cornell-black.mjs` settled the first half of the question and its
// answer was NEGATIVE, which is the useful kind:
//
//   at the back wall's black pixels the cache face is OCCUPIED (100 %), carries
//   a dominant-axis CODE (100 %), OWNS A SLOT (100 %), has been WRITTEN
//   (100 %, n̄ 1.4) and HOLDS 0.1125 — against 0.1411 at the same surface's
//   brightest pixels. The cache is not cold, not misfiled and not black.
//
// So the light exists in the world and is lost between the cache and the
// pixel. That is the RESOLVE, and §19 3.18/4.9 already built the instrument for
// it: `gather.buffers.diagBuf` carries, per half-res pixel, one row per cascade
// (`cov`, `freshCov`, `claim`, `visCov/cov`) plus a FALLBACK row
// (`faceCov`, `tail`, `csum`, pre-blend luminance). `gi2PointProbe.js` reads
// exactly those columns at a caller-supplied pixel list.
//
// ⚠ `diagBuf` EXISTS ONLY WHEN `globalThis.__gi2NoiseDump = true` WAS SET
// BEFORE BOOT (`wantNoise` gates the BUILD in `gatherProbes.js`), so this probe
// sets it pre-navigation and REFUSES to print a table when `hasDiag` is false.
//
// ⚠ AND THE PIXELS ARE FOUND BY WORLD POSITION, NOT RE-DERIVED. The gate's
// `blackList` carries world points; this probe dumps the frame, matches each
// point to the pixel whose gbuffer position IS that point, and snaps to EVEN
// coordinates (the half-res diag row that describes a full-res pixel is the one
// at `px>>1, py>>1` only when `px`/`py` are even).
//
// Run:  IN=/tmp/cornell-before.json node scripts/run-gi2-cornell-resolve.mjs
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const IN = process.env.IN ?? "/tmp/cornell-before.json";
const SETTLE = Number(process.env.SETTLE ?? 20);
const FRAMES = Number(process.env.FRAMES ?? 240);
const POSE_ENV = process.env.POSE ?? "0.38,2.60,4.10|0.38,2.30,-1.00";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const gate = JSON.parse(readFileSync(IN, "utf8"));
const groups = [
  ["BLACK", (gate.blackList ?? []).slice(0, 400)],
  ["LIT", (gate.litList ?? []).slice(0, 400)],
];
if (!groups[0][1].length) { console.log("  no black pixels in the gate output."); process.exit(0); }

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 932, height: 692, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  // ⚠ PRE-BOOT: `wantNoise` gates the BUILD of `diagBuf`, not a read of it.
  globalThis.__gi2NoiseDump = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
let firstLight = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/first light/.test(t) && !firstLight) firstLight = Date.now();
  if (m.type() === "error" || /wgsl|reserved keyword/i.test(t)) console.log(`    ${t.slice(0, 220)}`);
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
  globalThis.__gi2 = () => globalThis.__giSys()?._gi2 ?? null;
});
const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{ const dl = Date.now() + 240000; while (Date.now() < dl && !firstLight) await wait(250); }
if (!firstLight) { console.log("  FATAL: no first light."); await browser.close(); process.exit(1); }
const [eye, aim] = POSE_ENV.split("|").map((s) => s.split(",").map(Number));
await call("viewport.setCamera", { position: eye, target: aim });
await wait(SETTLE * 1000);
{
  const g = () => page.evaluate(() => globalThis.__gi2()?.gather?.frame ?? 0);
  const f0 = await g();
  const dl = Date.now() + 180000;
  let fr = f0;
  while (fr - f0 < FRAMES && Date.now() < dl) { await wait(400); fr = await g(); }
  console.log(`\n══ ${SCENE} — WHERE THE LIGHT IS LOST (the resolve) ═══════════`);
  console.log(`  settled ${fr - f0} gather frames · ${groups[0][1].length} black, ${groups[1][1].length} lit`);
}

const RJ = await page.evaluate(async ({ groups }) => {
 try {
  const eng = globalThis.__giEngineForProbe;
  const sys = globalThis.__giSys();
  const gi2 = globalThis.__gi2();
  const { createGi2PixelDump, GI2_PIXEL_OUT_VEC } = await import("/scripts/lib/gi2PixelDump.js");
  const { createGi2PointSampler } = await import("/scripts/lib/gi2PointProbe.js");
  const ps = createGi2PointSampler({ renderer: eng.renderer, gi2, screen: sys.state?.screen });
  if (!ps) return JSON.stringify({ error: "no point sampler" });
  // ── find each world point's PIXEL, out of a full-res dump of this frame ──
  const dump = createGi2PixelDump({ renderer: eng.renderer, gi2, screen: sys.state?.screen, stride: 1 });
  const awaitFrame = () => new Promise((r) => { const off = eng.onPostRender(() => { off(); r(); }); });
  const d = await dump.read(awaitFrame);
  const OV = GI2_PIXEL_OUT_VEC;
  // A coarse spatial hash over the gbuffer, so 800 lookups are not 800 full
  // scans of a 600×340 frame.
  const CELL = 0.05;
  const grid = new Map();
  for (let y = 0; y < dump.dumpH; y++) {
    for (let x = 0; x < dump.dumpW; x++) {
      const b = (y * dump.dumpW + x) * OV * 4;
      if (d[b + 3] < 0.5) continue;
      const k = `${Math.round(d[b] / CELL)},${Math.round(d[b + 1] / CELL)},${Math.round(d[b + 2] / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([x, y, d[b], d[b + 1], d[b + 2]]);
    }
  }
  const findPixel = (p) => {
    let best = null, bd = Infinity;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = `${Math.round(p[0] / CELL) + dx},${Math.round(p[1] / CELL) + dy},${Math.round(p[2] / CELL) + dz}`;
      for (const c of grid.get(k) ?? []) {
        const dd = Math.hypot(c[2] - p[0], c[3] - p[1], c[4] - p[2]);
        if (dd < bd) { bd = dd; best = c; }
      }
    }
    return bd < 0.02 ? [best[0] & ~1, best[1] & ~1] : null;
  };
  const out = { hasDiag: ps.hasDiag, DV: ps.DV, DC: ps.DC, groups: [] };
  for (const [name, list] of groups) {
    const pix = [];
    const meta = [];
    for (const s of list) {
      const q = findPixel(s.p);
      if (!q) continue;
      pix.push(q); meta.push(s);
      if (pix.length >= ps.MAX_PTS) break;
    }
    // ⚠⚠ `sample()` DISPATCHES ONCE AND READS. Measured on this rig, that came
    // back all zeros — for the LIT controls too, which is the tell: a scene
    // where the brightest pixels read 0.0000 is a dead kernel, not a dark room.
    // (The same submit-timing fault `gi2PixelDump.js` documents.) So dispatch,
    // let real frames go by, and repeat while the LIT group is still empty.
    let raw = [];
    for (let k = 0; k < 6 && pix.length; k++) {
      raw = Array.from(await ps.sample(pix));
      let live = false;
      for (let i = 0; i < pix.length; i++) {
        const b = i * ps.OUT_VEC * 4;
        if (raw[b] !== 0 || raw[b + 3] !== 0) { live = true; break; }
      }
      if (live) break;
      await awaitFrame(); await awaitFrame();
    }
    out.groups.push({ name, n: pix.length, raw, surf: meta.map((m) => m.surf), refL: meta.map((m) => m.ref) });
  }
  out.OUT_VEC = ps.OUT_VEC;
  return JSON.stringify(out);
 } catch (e) { return JSON.stringify({ error: `${e?.message}\n${e?.stack}`.slice(0, 700) }); }
}, { groups });

const R = JSON.parse(RJ ?? '{"error":"nothing"}');
if (R.error) { console.log(`  FATAL: ${R.error}`); await browser.close(); process.exit(1); }
if (!R.hasDiag) {
  console.log("  FATAL: `diagBuf` was not built — `__gi2NoiseDump` did not reach the boot, so every");
  console.log("  cascade column below would be a zero that means 'not measured', not 'no coverage'.");
  await browser.close();
  process.exit(1);
}
const OV = R.OUT_VEC;
console.log("");
console.log(`  diag rows: ${R.DC} cascades + 1 fallback (of ${R.DV})`);
for (const g of R.groups) {
  const bySurf = new Map();
  for (let i = 0; i < g.n; i++) {
    const b = i * OV * 4;
    const row = {
      surf: g.surf[i], ref: g.refL[i],
      irrAfter: [g.raw[b + 4], g.raw[b + 5], g.raw[b + 6]],
      irrBefore: [g.raw[b + 8], g.raw[b + 9], g.raw[b + 10]],
      litLum: g.raw[b + 11],
      casc: [],
      fb: null,
    };
    for (let c = 0; c < R.DC; c++) {
      const o = b + (3 + c) * 4;
      row.casc.push([g.raw[o], g.raw[o + 1], g.raw[o + 2], g.raw[o + 3]]);
    }
    const o = b + (3 + R.DV - 1) * 4;
    row.fb = [g.raw[o], g.raw[o + 1], g.raw[o + 2], g.raw[o + 3]];
    if (!bySurf.has(row.surf)) bySurf.set(row.surf, []);
    bySurf.get(row.surf).push(row);
  }
  console.log("");
  console.log(`  ── ${g.name} (${g.n} pixels) ─────────────────────────────────────`);
  console.log("  surface            n   E_after  E_before  preBlend | " +
    [...Array(R.DC).keys()].map((c) => `c${c}: cov  fresh claim  vis `).join("| ") + "| faceCov  tail   csum");
  for (const [name, rows] of [...bySurf.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const L = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const g2 = (fn) => mean(rows.map(fn));
    console.log(
      `  ${name.padEnd(16)} ${String(rows.length).padStart(4)}  ${f(g2((r) => L(r.irrAfter))).padStart(8)}  ` +
      `${f(g2((r) => L(r.irrBefore))).padStart(8)}  ${f(g2((r) => r.fb[3])).padStart(8)} | ` +
      [...Array(R.DC).keys()].map((c) =>
        [0, 1, 2, 3].map((k) => f(g2((r) => r.casc[c][k]), 2).padStart(6)).join("")).join("| ") +
      `| ${f(g2((r) => r.fb[0]), 2).padStart(7)} ${f(g2((r) => r.fb[1]), 2).padStart(6)} ${f(g2((r) => r.fb[2]), 2).padStart(6)}`,
    );
  }
}
await browser.close();
