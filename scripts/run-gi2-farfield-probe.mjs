// GI2 FAR-FIELD PROBE — §19 Stage 3.14's own gate: DO THE CASCADES LIGHT THE
// FAR FIELD, OR DOES THE CLAMP?
//
// ══ WHY THIS PROBE HAD TO EXIST ══════════════════════════════════════════════
//
// 3.13 put the diffuse path on a world-anchored lattice and won almost every
// receipt it was gated on. It shipped OFF for one reason: the lattice is a 16 m
// cube and Bistro is a 100 m street, so most of what a wide shot shows is
// BEYOND it. 3.13's answer there was a boundary CLAMP — a pixel past the
// lattice reads its nearest edge probe — and the doors receipt caught what that
// costs (6.3 % of the picked dark pixels had no live corner at all, p95 15 m).
// A clamp is not black, which is why it shipped; it is also not light, because
// what it extrapolates is the ambient measured at the edge of the NEAR room.
//
// Every existing instrument is structurally blind to this. The Cornell rig is a
// 5 m box entirely inside cascade 0. The doors pose stands 2 m from a wall. The
// motion probe measures FLIPS — a stable wrong answer flips as little as a
// stable right one. `probe:gi2-boot`'s dirt receipt band-passes one pose at one
// scale. Not one of them samples a surface forty metres away and asks what its
// irradiance IS. [[probe-blind-statistics]]: before believing that the far
// field is fine, ask whether anything can see it.
//
// ══ WHAT IT MEASURES ═════════════════════════════════════════════════════════
//
// The street-overview pose — the third of `run-gi2-boot-probe`'s three derived
// Bistro poses, 22 m back along the open street at 4 m up, looking down it — and
// then, out of the gather's own per-pixel stage dump:
//
//   · the FAR FAÇADES: valid pixels at least `FAR` metres from the camera whose
//     normal is within `|n.y| ≤ 0.5` of horizontal. A façade, not the road:
//     the road is a floor and a floor's irradiance is dominated by the sky,
//     which every path gets right. A vertical wall forty metres out is lit by
//     the street's bounce, and that is the quantity a lattice with a horizon
//     cannot know.
//   · the same statistic in DISTANCE BANDS, so "the far field is dark" and
//     "everything is dark" are different readings rather than one number.
//
// ⭐⭐ AND IT COMPARES THE SAME PIXELS, NOT THE SAME STATISTIC. The two arms
// (screen probes / world cascades) are two BOOTS — the path is a build-time
// constant — so `OUT=<file>` writes this boot's pixel indices with their world
// positions and irradiances, and `REF=<file>` reads them back and reports the
// ratio at each index that is still valid in both. The pose is derived, and a
// derived pose came back 11 cm apart on two boots of the doors probe, so this
// one PINS it: the reference file carries the pose it was measured at and the
// comparison arm is placed there exactly.
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//
// Run:
//   node scripts/run-gi2-farfield-probe.mjs                       (screen path)
//   OUT=/tmp/ff-screen.json node scripts/run-gi2-farfield-probe.mjs
//   REF=/tmp/ff-screen.json FLAGS='{"__gi2WorldProbes":true}' \
//     node scripts/run-gi2-farfield-probe.mjs
//
// Env: PROJECT · SCENE=Bistro · SETTLE=14 · FRAMES=240 · FAR=30 · OUT · REF ·
//      POSE=ex,ey,ez|ax,ay,az · FLAGS · HEADED=1
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { reportEmitterSeats } from "./lib/gi2EmitterWait.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 14);
const FRAMES = Number(process.env.FRAMES ?? 240);
const FAR = Number(process.env.FAR ?? 30);
const OUT = process.env.OUT ?? "";
const REF = process.env.REF ?? "";
const POSE_ENV = process.env.POSE ?? "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const quant = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);

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
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
// The stage dump is built out of the gather's own textures, but `noiseDump` is
// what publishes the gather handle this probe reaches through.
await page.evaluateOnNewDocument(() => { globalThis.__gi2NoiseDump = true; });
await page.evaluateOnNewDocument((flags) => {
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, JSON.parse(process.env.FLAGS ?? "{}"));
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

let firstLight = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light/.test(t) && !firstLight) firstLight = Date.now();
  if (/\[gi2\] (soup|first)|\[gi\] built/.test(t)) console.log(`    ${t.slice(0, 200)}`);
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

const call = async (op, args = {}) => {
  try {
    return await page.evaluate(async ({ op, args }) => {
      try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, { op, args });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
};
const gatherFrame = () => page.evaluate(() => globalThis.__gi2()?.gather?.frame ?? 0);
const settleFrames = async (n, capMs = 180000) => {
  const f0 = await gatherFrame();
  const deadline = Date.now() + capMs;
  let f = f0;
  while (f - f0 < n && Date.now() < deadline) { await wait(400); f = await gatherFrame(); }
  return f - f0;
};

console.log(`\n══ ${SCENE} — the far field ═══════════════════════════════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{
  const dl = Date.now() + 240000;
  while (Date.now() < dl && !firstLight) await wait(250);
}
console.log(`  first light ${firstLight ? "yes" : "NEVER"} — settling ${SETTLE}s`);

// ⭐ `first light` is GEOMETRY-ready, and a .mat's emissiveNode lands with the
// MATERIAL tail — up to ~27 s later on Bistro. Reading emitters before that
// reports 0 seats on a scene with four lamps. Waited for explicitly, and AHEAD
// of the settle, so SETTLE stays a settle rather than an accidental (and far
// too short) emitter wait.
await reportEmitterSeats(page);
await wait(SETTLE * 1000);

// ── THE POSE ────────────────────────────────────────────────────────────────
//
// `run-gi2-boot-probe`'s third derived pose, verbatim: 22 m back along the OPEN
// direction (found by a 24-ray horizontal ring through the live window — the
// street is a fact about the world, not a number to guess) at 4 m up, looking
// down the street at 3 m. Pinned by `POSE` or by a reference file, because a
// derivation that lands 11 cm apart on two boots turns a shared pixel set into
// a comparison between two different walls.
const refData = REF ? JSON.parse(readFileSync(REF, "utf8")) : null;
async function streetPose() {
  if (POSE_ENV) {
    const [e, a] = POSE_ENV.split("|").map((s) => s.split(",").map(Number));
    return { position: e, target: a, source: "POSE env" };
  }
  if (refData?.pose) return { ...refData.pose, source: `pinned by ${REF}` };
  const bounds = async (needle) => {
    const list = (await call("entity.list", { nameContains: needle })).value ?? [];
    let agg = null;
    for (const e of list.slice(0, 24)) {
      const b = (await call("entity.getBounds", { id: e.id })).value;
      if (!b || b.empty) continue;
      agg ??= { min: [...b.min], max: [...b.max] };
      for (let i = 0; i < 3; i++) {
        agg.min[i] = Math.min(agg.min[i], b.min[i]);
        agg.max[i] = Math.max(agg.max[i], b.max[i]);
      }
    }
    return agg;
  };
  const banner = await bounds("FrontBanner");
  if (!banner) return null;
  const street = await bounds("Paris_Street_");
  const B = banner.min.map((v, i) => (v + banner.max[i]) / 2);
  const ground = street ? street.max[1] : banner.min[1] - 3.4;
  const eye = ground + 1.65;
  await call("viewport.setCamera", { position: [B[0], eye, B[2]], target: [B[0] + 4, eye, B[2]] });
  await settleFrames(90, 30000);
  const ring = await page.evaluate(async ({ o }) => {
    const eng = globalThis.__giEngineForProbe;
    const gi2 = globalThis.__gi2();
    if (!gi2?.trace || !eng?.renderer) return null;
    const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
    const shoot = createGi2RayShooter(gi2, eng.renderer);
    const dirs = [];
    for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; dirs.push([Math.cos(a), 0, Math.sin(a)]); }
    // ⚠ FIRED TWICE — a fresh compute node's first `computeAsync` COMPILES
    // rather than runs, and the doors probe's own comment records what that
    // cost: 24 misses and a silently arbitrary "most open direction".
    const rays = dirs.map((d) => ({ o, d, tMax: 30 }));
    await shoot(rays);
    const out = await shoot(rays);
    return dirs.map((d, i) => ({ d, t: out[i].hit ? out[i].t : 30 }));
  }, { o: [B[0], eye, B[2]] });
  if (!ring) return null;
  const D = ring.reduce((a, b) => (b.t > a.t ? b : a)).d;
  const at = (k, y) => [B[0] + D[0] * k, y, B[2] + D[2] * k];
  console.log(`  banner ${B.map((v) => v.toFixed(2))} ground ${ground.toFixed(2)} open dir [${D.map((v) => v.toFixed(2))}]`);
  return { position: at(22.0, ground + 4), target: at(2.0, ground + 3), source: "derived" };
}

const pose = await streetPose();
if (!pose) { console.log("FATAL: no street pose (the scene names no FrontBanner)"); await browser.close(); process.exit(1); }
console.log(`  street-overview (${pose.source}): eye [${pose.position.map((v) => v.toFixed(2))}] ` +
  `→ [${pose.target.map((v) => v.toFixed(2))}]`);
await call("viewport.setCamera", { position: pose.position, target: pose.target });
await settleFrames(FRAMES);

// ── THE READ ────────────────────────────────────────────────────────────────
//
// One dispatch, every stage, the same frame — `createGi2StageDump`'s whole
// point. Irradiance is taken BEFORE AO: AO is a screen-space factor that both
// arms share, and folding it in would put a term neither path owns inside a
// comparison between the two paths.
const sample = await page.evaluate(async ({ far }) => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const { createGi2StageDump } = await import("/scripts/lib/gi2StageProbe.js");
  const dump = createGi2StageDump({
    renderer: eng.renderer, gi2, screen: globalThis.__giSys().state.screen, stride: 2,
  });
  const D = await dump.read();
  const V = 6;
  const at = (i, v, c) => D[(i * V + v) * 4 + c];
  const cam = [eng.camera.position.x, eng.camera.position.y, eng.camera.position.z];
  const n = D.length / (V * 4);
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    const P = [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)];
    const ny = at(i, 1, 1);
    const d = Math.hypot(P[0] - cam[0], P[1] - cam[1], P[2] - cam[2]);
    if (d < far) continue;
    if (Math.abs(ny) > 0.5) continue; // façades, not the road
    rows.push({ i, d: +d.toFixed(2), E: [at(i, 2, 0), at(i, 2, 1), at(i, 2, 2)] });
  }
  const g = gi2?.gather;
  return {
    rows, cam, total: n,
    worldProbes: !!g?.worldProbes,
    world: g?.world?.describe?.() ?? (g?.describe?.().world ?? null),
  };
}, { far: FAR });

const rows = sample.rows;
const L = rows.map((r) => lum(r.E)).sort((a, b) => a - b);
const band = (lo, hi) => {
  const s = rows.filter((r) => r.d >= lo && r.d < hi).map((r) => lum(r.E)).sort((a, b) => a - b);
  return { n: s.length, p50: quant(s, 0.5), mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length) };
};
console.log(`\n  path: ${sample.worldProbes ? "WORLD CASCADES" : "screen probes"}` +
  (sample.world ? ` (${sample.world.cascades ?? 1} × ${sample.world.cells}³, extents ` +
    `${(sample.world.extents ?? [sample.world.extent]).join("/")} m)` : ""));
console.log(`  far façades (≥ ${FAR} m, |n.y| ≤ 0.5): ${rows.length} of ${sample.total} dump samples`);
console.log(`    irradiance luminance  p05 ${quant(L, 0.05).toFixed(4)}  p50 ${quant(L, 0.5).toFixed(4)}  ` +
  `p95 ${quant(L, 0.95).toFixed(4)}  mean ${(L.reduce((a, b) => a + b, 0) / Math.max(1, L.length)).toFixed(4)}`);
for (const [lo, hi] of [[FAR, 40], [40, 55], [55, 75], [75, 1e9]]) {
  const b = band(lo, hi);
  if (b.n) {
    console.log(`    ${String(lo).padStart(3)}–${hi > 1e8 ? "∞  " : String(hi).padStart(3)} m: ` +
      `n ${String(b.n).padStart(6)}  p50 ${b.p50.toFixed(4)}  mean ${b.mean.toFixed(4)}`);
  }
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({
    pose: { position: pose.position, target: pose.target },
    far: FAR, worldProbes: sample.worldProbes,
    rows: rows.map((r) => ({ i: r.i, d: r.d, L: +lum(r.E).toFixed(6) })),
  }));
  console.log(`  reference written to ${OUT} (${rows.length} pixels, pose pinned)`);
}

// ── THE GATE ────────────────────────────────────────────────────────────────
//
// ⭐⭐ THE RATIO IS TAKEN PER PIXEL AND THEN SUMMARISED, NOT THE OTHER WAY
// ROUND. Two population medians can agree while every individual pixel is
// wrong in a different direction — a far façade lit by the boundary clamp is
// UNIFORM, which is exactly the failure this probe exists to catch, and a
// uniform field can have the right mean. So the statistic is the distribution
// of `E_this / E_reference` at the SAME pixel index, and the gate is on its
// median and on the share within ±15 %.
if (refData) {
  const byIdx = new Map(refData.rows.map((r) => [r.i, r]));
  const pairs = [];
  for (const r of rows) {
    const ref = byIdx.get(r.i);
    if (!ref || !(ref.L > 1e-6)) continue;
    if (Math.abs(ref.d - r.d) > 0.5) continue; // a different surface at the same index
    pairs.push({ i: r.i, d: r.d, ratio: lum(r.E) / ref.L });
  }
  const rs = pairs.map((p) => p.ratio).sort((a, b) => a - b);
  const within = (t) => pairs.filter((p) => Math.abs(p.ratio - 1) <= t).length;
  console.log(`\n  ══ AGAINST ${refData.worldProbes ? "the world path" : "the SCREEN-PROBE path"} ` +
    `(${REF}) ══`);
  console.log(`  ${pairs.length} pixels paired by index and depth (of ${rows.length} here / ` +
    `${refData.rows.length} there)`);
  console.log(`    ratio  p05 ${quant(rs, 0.05).toFixed(3)}  p50 ${quant(rs, 0.5).toFixed(3)}  ` +
    `p95 ${quant(rs, 0.95).toFixed(3)}`);
  console.log(`    within ±15 % ${(100 * within(0.15) / Math.max(1, pairs.length)).toFixed(1)} %  ` +
    `| within ±30 % ${(100 * within(0.30) / Math.max(1, pairs.length)).toFixed(1)} %`);
  for (const [lo, hi] of [[FAR, 40], [40, 55], [55, 75], [75, 1e9]]) {
    const s = pairs.filter((p) => p.d >= lo && p.d < hi).map((p) => p.ratio).sort((a, b) => a - b);
    if (s.length) {
      console.log(`    ${String(lo).padStart(3)}–${hi > 1e8 ? "∞  " : String(hi).padStart(3)} m: ` +
        `n ${String(s.length).padStart(6)}  ratio p50 ${quant(s, 0.5).toFixed(3)}`);
    }
  }
  const med = quant(rs, 0.5);
  const pass = Math.abs(med - 1) <= 0.15;
  console.log(`\n  GATE far-field median within 15 % of the reference: ${med.toFixed(3)} ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}

await browser.close();
