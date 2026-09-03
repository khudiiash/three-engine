// GTAO GATE (2026-08-26) — does the ground-truth AO estimator actually
// darken a contact, and what does its error distribution look like?
//
// ⭐ IT READS THE AO TEXTURE, NEVER THE SCREEN. This module's own history is
// four instruments reporting confidently about a subject they could not see:
// screen luminance cannot resolve AO in an emitter-lit room (the resolve
// multiplies the factor into the GATHER only, which is a few percent of the
// pixel there — full-strength AO moves it ~2.7%), so every AO number here
// comes from `screen.vxaoPass.target` itself, paired with the gbuffer world
// position each texel was computed from. No projection maths, no row-order
// assumption. See memory: gi-vxao-rebuild, probe-blind-statistics.
//
// ⚠ THE TARGET IS HALF FLOAT. The retired 8-bit read (`byte / 255`, still in
// run-gi-vxao-probe.mjs) returns garbage on it — the AO chain has been
// HalfFloatType since the ray-traced arm landed.
//
// WHAT IT ASSERTS
//   CONTACT   the floor at the box's base is darker than open floor of the
//             same material and orientation, by ≥ 8% of the open value. This
//             is the whole point of a sub-lattice AO term; the cascade's own
//             BIN_T visibility cannot resolve it at 0.70 m spacing.
//   RANGE     rawTarget.x (GTAO alone) is neither crushed (p95 < 0.9 ⇒ everything is
//             occluded, i.e. a sign error in the arc integral) nor inert
//             (p05 > 0.95 ⇒ nothing is).
//             The final composite is intentionally excluded: every point in
//             this closed 6m room lies within the world cone's 2.88m reach.
//             Exact-open world response is gated by test:gi-ao-phase instead.
//   FINITE    no NaN/Inf texels. A NaN here multiplies into every indirect
//             pixel of the frame.
//   COST      the `gtao` pass group's GPU ms, reported.
//
//   node scripts/run-gi-gtao-probe.mjs         (vite on :5201)
//   QUALITY=ultra SETTLE=20000 ARM=raytraced   (A/B against the RTAO arm)
//   WORLD=1                                    (opt-in occupancy diagnostic)
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeAoGlossyProject, POSE, SUBJECTS } from "./lib/makeAoGlossyProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const QUALITY = process.env.QUALITY ?? "high";
const SETTLE = Number(process.env.SETTLE ?? 18000);
const VIEW = (process.env.VIEW ?? "1200x800").split("x").map(Number);
// "gtao" (default) | "raytraced" | "legacy" — the three arms #armAoTerm can take.
const ARM = process.env.ARM ?? "gtao";
const WORLD = process.env.WORLD ?? "0";
const HOT_REARM = process.env.HOT_REARM === "1";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const root = path.resolve("scripts/.gi-gtao").replaceAll("\\", "/");
mkdirSync(root, { recursive: true });
await makeAoGlossyProject(root, { quality: QUALITY });
console.log(`rig: 6x3x6 room, ceiling panel only light, contact box + metal sphere; quality ${QUALITY}; arm ${ARM}`);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: `${root}/chrome-profile`,
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1 });
await installTauriShim(page, root);
let built = false;
let errors = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built = true;
  // Everything the AO term says about itself, plus anything that failed.
  if (/\[gi\] AO:|\[gi\] AO |TSL|Error|error|WARN|warn/.test(t)) console.log(`  ${t.slice(0, 400)}`);
});
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (!/save_scene/.test(msg)) { errors++; console.log(`  pageerror: ${msg.slice(0, 300)}`); }
});
await page.evaluateOnNewDocument((project, arm, world, profileFull, intervals, filterRadius) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = { exactReflections: false };
  if (arm === "raytraced") globalThis.__giAoRaytraced = true;
  if (arm === "legacy") globalThis.__giAoLegacy = true;
  if (world === "1") globalThis.__giWorldAo = true;
  if (profileFull) globalThis.__GI_PROFILE_FULL = true;
  if (Number.isFinite(intervals)) globalThis.__giGtaoIntervals = intervals;
  if (Number.isFinite(filterRadius)) globalThis.__giAoFilterRadius = filterRadius;
  if (globalThis.__GTAO_DEBUG) globalThis.__giGtaoDebug = true;
}, root, ARM, WORLD, process.env.PROFILE_FULL === "1", Number(process.env.GTAO_INTERVALS), Number(process.env.AO_FILTER_RADIUS));
if (process.env.THIN !== undefined) {
  await page.evaluateOnNewDocument((t) => { globalThis.__giGtaoThin = t; }, Number(process.env.THIN));
}
// DEBUG also turns the bilateral OFF, so `vxaoPass.target` IS the raw target
// and the y/z/w channels survive to the readback.
if (process.env.GTAO_DEBUG === "1") await page.evaluateOnNewDocument(() => {
  globalThis.__GTAO_DEBUG = true; globalThis.__giGtaoDebug = true; globalThis.__giAoFilter = false;
});
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, root);
for (let i = 0; i < 180 && !built; i++) await wait(1000);
if (!built) { console.log("FAIL — never built"); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
await page.evaluate(async (pose) => globalThis.__editorApi.call("viewport.setCamera", pose), POSE);
await wait(SETTLE);

let hotRearm = null;
if (HOT_REARM) {
  hotRearm = await page.evaluate(async () => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const sys = engine.modules?.get?.("gi")?.system ?? null;
    const before = {
      sys,
      state: sys?.state,
      field: sys?.state?.volume?.occupancyField,
      bvh: sys?.state?.bvhScene,
      light: sys?.state?.light,
      screen: sys?.state?.screen,
      srcProbes: sys?.state?.screen?.srcProbes,
      aoPass: sys?.state?.screen?.vxaoPass,
      runs: sys?.rebuilds ?? 0,
      asks: sys?.rebuildAsks ?? 0,
      size: [sys?.state?.screen?.vxaoPass?.width, sys?.state?.screen?.vxaoPass?.height],
    };
    if (!before.state || !before.aoPass) return { error: "GI/AO state missing before hot rearm" };

    const entities = await globalThis.__editorApi.call("entity.list", {});
    const gi = entities.find((entity) =>
      (entity.components ?? []).some((component) => component.type === "global-illumination"));
    if (!gi) return { error: "global-illumination entity missing" };

    const t0 = performance.now();
    await globalThis.__editorApi.call("component.setProp", {
      id: gi.id,
      type: "global-illumination",
      key: "ao",
      value: 0.25,
    });
    const setPropMs = performance.now() - t0;
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const after = sys.state;
    return {
      setPropMs,
      sameSystem: sys === before.sys,
      sameState: after === before.state,
      sameField: after?.volume?.occupancyField === before.field,
      sameBvh: after?.bvhScene === before.bvh,
      sameLight: after?.light === before.light,
      sameScreen: after?.screen === before.screen,
      sameSrcProbes: after?.screen?.srcProbes === before.srcProbes,
      changedAoPass: after?.screen?.vxaoPass !== before.aoPass,
      runsDelta: (sys.rebuilds ?? 0) - before.runs,
      asksDelta: (sys.rebuildAsks ?? 0) - before.asks,
      beforeSize: before.size,
      afterSize: [after?.screen?.vxaoPass?.width, after?.screen?.vxaoPass?.height],
    };
  });
  const hotOk = !hotRearm?.error
    && hotRearm.sameSystem && hotRearm.sameState && hotRearm.sameField
    && hotRearm.sameBvh && hotRearm.sameLight && hotRearm.sameScreen
    && hotRearm.sameSrcProbes && hotRearm.changedAoPass
    && hotRearm.runsDelta === 0 && hotRearm.asksDelta === 0
    && hotRearm.setPropMs < 1500;
  console.log(`HOT REARM: ${JSON.stringify(hotRearm)}  ${hotOk ? "PASS" : "FAIL"}`);
  if (!hotOk) errors++;
}

const out = await page.evaluate(async ({ subjects }) => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const renderer = engine.renderer;
  const sys = engine.modules?.get?.("gi")?.system ?? null;
  const screen = sys?.state?.screen ?? null;
  const pass = screen?.vxaoPass;
  if (!pass?.target || !screen?.gbuffer?.position) return { error: "no AO pass on state.screen.vxaoPass" };

  // 256-byte row padding is mandatory on every WebGPU readback, and the row
  // ORDER is the texture's own — pairing each AO texel with the gbuffer texel
  // it was computed FROM makes both facts irrelevant to the answer.
  const unpad = (raw, w, h, comps, Ctor) => {
    const rowBytes = w * comps * Ctor.BYTES_PER_ELEMENT;
    const padded = Math.ceil(rowBytes / 256) * 256;
    const src = new Uint8Array(raw.buffer ?? raw, raw.byteOffset ?? 0, raw.byteLength ?? raw.length);
    const dst = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      const from = y * padded;
      const avail = Math.max(0, Math.min(rowBytes, src.length - from));
      if (avail > 0) dst.set(src.subarray(from, from + avail), y * rowBytes);
    }
    return new Ctor(dst.buffer);
  };
  // IEEE 754 binary16 -> Number. The AO chain is HalfFloatType end to end.
  const f16 = (h) => {
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    if (e === 0) return s * m * 2 ** -24;
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (m + 1024) * 2 ** (e - 25);
  };

  const vw = pass.width, vh = pass.height;
  const finalAo = unpad(await renderer.backend.copyTextureToBuffer(pass.target, 0, 0, vw, vh, 0), vw, vh, 4, Uint16Array);
  const rawGtao = pass.rawTarget && pass.rawTarget !== pass.target
    ? unpad(await renderer.backend.copyTextureToBuffer(pass.rawTarget, 0, 0, vw, vh, 0), vw, vh, 4, Uint16Array)
    : finalAo;
  const posTex = screen.gbuffer.position;
  const gw = posTex.image?.width ?? screen.width;
  const gh = posTex.image?.height ?? screen.height;
  const pos = unpad(await renderer.backend.copyTextureToBuffer(posTex, 0, 0, gw, gh, 0), gw, gh, 4, Float32Array);
  const sx = gw / vw, sy = gh / vh;

  const values = [];
  const gtaoValues = [];
  let nonFinite = 0;
  const nearest = Object.fromEntries(Object.keys(subjects).map((k) => [k, { d: Infinity, v: null, dbg: null }]));
  for (let py = 0; py < vh; py++) {
    for (let px = 0; px < vw; px++) {
      const gx = Math.min(gw - 1, Math.floor((px + 0.5) * sx));
      const gy = Math.min(gh - 1, Math.floor((py + 0.5) * sy));
      const gi2 = (gy * gw + gx) * 4;
      if (pos[gi2 + 3] < 0.5) continue;               // sky: never written
      const o = (py * vw + px) * 4;
      const v = f16(finalAo[o]);
      if (!Number.isFinite(v)) { nonFinite++; continue; }
      values.push(v);
      const gv = f16(rawGtao[o]);
      if (Number.isFinite(gv)) gtaoValues.push(gv);
      for (const [k, p] of Object.entries(subjects)) {
        const d = (pos[gi2] - p[0]) ** 2 + (pos[gi2 + 1] - p[1]) ** 2 + (pos[gi2 + 2] - p[2]) ** 2;
        if (d < nearest[k].d) {
          nearest[k] = { d, v, dbg: [f16(finalAo[o + 1]), f16(finalAo[o + 2]), f16(finalAo[o + 3])] };
        }
      }
    }
  }
  const summarize = (xs, extra = {}) => {
    xs.sort((a, b) => a - b);
    const q = (f) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(f * xs.length))] : NaN);
    return {
      count: xs.length,
      mean: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length),
      min: xs[0], p05: q(0.05), p50: q(0.5), p95: q(0.95), max: xs[xs.length - 1],
      ...extra,
    };
  };
  const stats = summarize(values, { nonFinite });
  const gtaoStats = summarize(gtaoValues);
  const points = Object.fromEntries(Object.entries(nearest).map(([k, n]) => [k, { ao: n.v, dist: Math.sqrt(n.d), dbg: n.dbg }]));
  return { stats, gtaoStats, points, size: [vw, vh], gsize: [gw, gh] };
}, { subjects: SUBJECTS });

if (out.error) { console.log(`FAIL — ${out.error}`); await browser.close(); process.exit(1); }

let cost = null;
try {
  cost = await page.evaluate(async () => {
    const r = await globalThis.__editorApi.call("profile.giPasses", { samples: 30 });
    // Only the AO-shaped entries, wherever the op happens to put them.
    const hits = {};
    const walk = (o, path) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (/^(gtao|rtao|ao|vxao)$/i.test(k)) hits[`${path}${k}`] = v;
        else if (v && typeof v === "object") walk(v, `${path}${k}.`);
      }
    };
    walk(r, "");
    return globalThis.__GI_PROFILE_FULL ? { hits, full: r } : hits;
  });
} catch { /* profiling is optional here */ }

const f = (n) => (Number.isFinite(n) ? n.toFixed(3) : String(n));
const s = out.stats;
const gs = out.gtaoStats;
console.log(`\nAO buffer ${out.size.join("x")} over gbuffer ${out.gsize.join("x")} — ${s.count} surface texels`);
console.log(`  mean ${f(s.mean)}  min ${f(s.min)}  p05 ${f(s.p05)}  p50 ${f(s.p50)}  p95 ${f(s.p95)}  max ${f(s.max)}`);
for (const [k, v] of Object.entries(out.points)) {
  const d = process.env.GTAO_DEBUG === "1" && v.dbg
    ? `  | unoccluded-ref ${f(v.dbg[0])}  horizon-raise ${f(v.dbg[1])}  reach ${f(v.dbg[2])}px`
    : "";
  console.log(`  ${k.padEnd(8)} ao ${f(v.ao)}  (nearest texel ${f(v.dist)} m away)${d}`);
}

const contact = out.points.contact?.ao;
const open = out.points.open?.ao;
const drop = Number.isFinite(contact) && Number.isFinite(open) && open > 0 ? 1 - contact / open : NaN;
const okContact = Number.isFinite(drop) && drop >= 0.08;
const okRange = gs.p95 >= 0.9 && gs.p05 <= 0.95;
const okFinite = s.nonFinite === 0 && errors === 0;
console.log(`\nCONTACT: ${f(contact)} vs open ${f(open)} — ${(drop * 100).toFixed(1)}% darker  ${okContact ? "PASS" : "FAIL"}`);
console.log(`RANGE:   raw GTAO p05 ${f(gs.p05)} p95 ${f(gs.p95)}  ${okRange ? "PASS" : "FAIL"}`);
console.log(`FINITE:  ${s.nonFinite} non-finite texels, ${errors} page errors  ${okFinite ? "PASS" : "FAIL"}`);
if (cost && Object.keys(cost).length) {
  const hits = cost.hits ?? cost;
  console.log(`COST:    ${JSON.stringify(hits)}`);
  if (cost.full) console.log(`PROFILE: ${JSON.stringify(cost.full)}`);
}

if (process.env.CAPTURE === "1") {
  await page.evaluate(() => { globalThis.__giDebugView = "ao"; });
  await wait(1000);
  const shot = await page.evaluate(async () => (
    globalThis.__editorApi.call("viewport.screenshot", { width: 960, height: 640, includeGizmos: true })
  ));
  const name = `${root}/gtao-${QUALITY}-world${WORLD}-r${process.env.GTAO_INTERVALS ?? "default"}.png`;
  writeFileSync(name, Buffer.from(shot.__image.base64, "base64"));
  console.log(`CAPTURE: ${name}`);
}

await browser.close();
const pass = okContact && okRange && okFinite;
console.log(`\n${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
