// ⭐⭐ THE CORNELL BOX AS A **PER-PIXEL** GROUND-TRUTH GATE (§19 §AJ).
//
// ══ WHY THE OLD GATE READ 8/8 ON A PICTURE THE USER CALLED "FUCKED UP" ══════
//
// `probe:gi2-gather`'s Cornell parity samples EIGHT CROPS, averages 81 pixels
// into one world point each, and asks whether that average sits inside the
// [1-bounce, 4-bounce] bracket. Every one of those questions is about ENERGY,
// and every one of them is answered by a MEAN. The user's 15:24 screenshot is
// not an energy fault:
//
//   · cloudy grey blotches on the ceiling      — a VARIANCE fault
//   · the tall box's faces nearly black        — a fault of the DARKEST pixels
//   · bright blobs and dark patches on a wall  — a fault of the SPATIAL
//                                                DERIVATIVE, not the level
//   · seams and dots at the lattice scale      — a fault at a KNOWN WAVELENGTH
//
// A crop mean is blind to all four by construction: averaging 81 pixels is
// exactly the operation that deletes blotchiness, and a bracket around the mean
// is satisfied by a surface that is half twice as bright and half black.
// [[probe-blind-statistics]] — before believing 8/8, ask whether the instrument
// can see the subject. It cannot.
//
// So this gate is per pixel, and it scores four things the crops cannot:
//
//   (a) AGREEMENT   |log(E_gi2 / E_ref)| — median and p90, over lit pixels
//   (b) BLACK       pixels at < 5 % of the reference where the reference is
//                   meaningfully lit, listed BY SURFACE
//   (c) BLOTCH      the residual (E_gi2 − E_ref) after removing each surface's
//                   own mean — its σ, and its SECOND DIFFERENCE at 0.25 m and
//                   0.5 m lags, against the reference's own floor
//   (d) ENERGY      the per-surface mean ratio (what the old crops measured)
//
// ══ THE REFERENCE ═══════════════════════════════════════════════════════════
//
// `scripts/lib/gi2SceneReference.mjs` path-traces the scene's OWN TRIANGLES,
// read out of the live engine — `giSystem.state.entries`, i.e. exactly the
// meshes GI participates in, with exactly the albedo/emissive `resolveMaterial
// Surface` assigned them — with no sky and no sun unless the live gather's own
// uniforms carry them. It computes `E`, the incident irradiance, which is what
// `gi2.textures.irradiance` holds.
//
// ⚠ THE REFERENCE'S OWN NOISE IS MEASURED AND REPORTED, per pixel, by splitting
// the sample budget in half and comparing the halves. Any pixel whose reference
// is noisier than 2 % is EXCLUDED from the blotch metric and counted in the
// receipt, because a blotch statistic taken against a noisy reference measures
// the instrument.
//
// ══ RUN ═════════════════════════════════════════════════════════════════════
//
//   npm run probe:gi2-cornell                        # the user's Cornel.scene
//   SCENE=Cornel PROJECT=... node scripts/run-gi2-cornell-ref.mjs
//   RIG=1 node scripts/run-gi2-cornell-ref.mjs       # the harness rig arm
//   OUT=/tmp/a.json ... ; REF=/tmp/a.json ...        # before → after
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//
// Env: PROJECT · SCENE=Cornel · POSE · SIZE=512 · TARGET=160 · SPP=1024 ·
//      SETTLE=20 · FRAMES=240 · BOUNCES=4 · OUT · REF · FLAGS · HEADED=1 ·
//      RIG=1 · NOCACHE=1
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeSceneTracer, lum } from "./lib/gi2SceneReference.mjs";
import { makeCornellProject } from "./lib/makeCornellProject.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
// ⭐ TWO ARMS, ONE GATE. The PRIMARY target is the user's own `Cornel.scene` —
// the picture they are looking at, with their emitter, their albedos and their
// GI props. The harness rig (`RIG=1`) is the REGRESSION arm: deterministic,
// checked in, and immune to the user editing their scene under a measurement.
const RIG = !!process.env.RIG;
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-cornell-gate")).replaceAll("\\", "/");
if (RIG) {
  await makeCornellProject(GEN_ROOT, { emitStrength: 10, gi: { quality: "ultra", ao: false, reflections: false } });
  console.log(`  RIG arm: generated project at ${GEN_ROOT}`);
}
const PROJECT = (process.env.PROJECT ?? (RIG ? GEN_ROOT : "C:/Users/Khudiiash/Documents/GAME")).replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? (RIG ? "Main" : "Cornel");
const SIZE = Number(process.env.SIZE ?? 512);
/** Target width of the dump grid; the stride is derived from the live target. */
const TARGET = Number(process.env.TARGET ?? 160);
const SPP = Number(process.env.SPP ?? 1024);
const BOUNCES = Number(process.env.BOUNCES ?? 4);
const SETTLE = Number(process.env.SETTLE ?? 20);
const FRAMES = Number(process.env.FRAMES ?? 240);
const OUT = process.env.OUT ?? "";
const REF = process.env.REF ?? "";
const NOCACHE = !!process.env.NOCACHE;
// `ARMS="name=uniform:value,uniform:value|name2=…"`. Every name here is a
// `uniform()` on the live gather, so an arm is a WRITE, not a rebuild.
const ARM_FRAMES = Number(process.env.ARM_FRAMES ?? 240);
/** `kernelSamples` for the per-arm chain timing; 0 skips it (no freeze). */
const ARM_MS = Number(process.env.ARM_MS ?? 20);
/** Gather frames between the two at-rest dumps; 0 skips the stability read. */
const REST = Number(process.env.REST ?? 180);
/**
 * §19 5.3c — HOW MANY BACK-TO-BACK DUMPS THE Δ MAP TAKES. `REST` answers "is
 * the image still" with ONE number over ONE lag, which cannot say WHICH
 * surfaces rattle nor whether the rattle has a PERIOD — and a period names its
 * mechanism (4 = the E_rc phase refresh, `stride` = the ray budget's round
 * robin, none = a field still climbing). 0 = off.
 */
const RESTMAP = Number(process.env.RESTMAP ?? 0);
const ARMS = (process.env.ARMS ?? "").split("|").filter(Boolean).map((spec) => {
  const [name, body] = spec.includes("=") ? spec.split("=") : [spec, spec];
  const set = {};
  for (const kv of body.split(",")) {
    const [k, v] = kv.split(":");
    if (k) set[k.trim()] = Number(v);
  }
  return { name: name.trim(), set };
});
// A frontal view of the box, from just inside the open front — the pose the
// user's screenshot was taken from. The Cornell root sits at x = 0.38.
const POSE_ENV = process.env.POSE ?? "0.38,2.60,4.10|0.38,2.30,-1.00";
const CACHE_DIR = process.env.CACHE_DIR
  ?? path.join(process.env.TEMP ?? "/tmp", "gi2-cornell-ref");

// ── the gate's thresholds, and why each one is where it is ──────────────────
//
// ⭐ EVERY NUMBER BELOW IS DERIVED FROM SOMETHING THE SCENE OR THE REFERENCE
// MEASURES, not chosen to make a build pass.
const GATE = {
  // (a) 0.15 in |log ratio| is 16 %, the SAME tolerance the old 8-crop parity
  // used for its mean — so a build that passed the old gate at the mean is
  // being asked for no more accuracy, only for it at every pixel.
  medLogRatio: 0.15,
  // p90 at 0.35 (42 %) admits the voxelization error at silhouettes — a
  // 0.16 m voxel against a 0.1 m wall genuinely cannot resolve the corner —
  // while refusing a surface that is wrong across its whole area.
  p90LogRatio: 0.35,
  // (b) A black pixel is not a tolerance question. Zero.
  blackPixels: 0,
  // (c) The residual's σ, as a fraction of the surface's own mean. 10 %: below
  // that a flat wall reads flat by eye at the exposures this scene uses, and
  // the reference's own σ on the same population is the floor the receipt
  // prints beside it.
  blotchSigma: 0.10,
  // The second difference is what the EYE sees as a blotch — a level offset is
  // invisible, a curvature is not. 2× the reference's own second difference at
  // the same lag, so the gate scales with how curved the truth actually is.
  d2Ratio: 2.0,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const pct = (v, n = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(n)} %` : "—");
const quantile = (a, q) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// ════════════════════════════════════════════════════════════════════ BOOT
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--js-flags=--expose-gc",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: SIZE + 420, height: SIZE + 180, deviceScaleFactor: 1 });
await installTauriShim(page, {});
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
  if (/\[gi2\] (soup|first light|palette)/.test(t) || m.type() === "error"
    || /wgsl|shader|pipeline|invalid|cannot|undefined is not/i.test(t)) {
    console.log(`    ${t.slice(0, 300)}`);
  }
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
  let fr = f0;
  while (fr - f0 < n && Date.now() < deadline) { await wait(400); fr = await gatherFrame(); }
  return fr - f0;
};

console.log(`\n══ ${SCENE} — THE PER-PIXEL CORNELL GATE ═══════════════════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{
  const dl = Date.now() + 240000;
  while (Date.now() < dl && !firstLight) await wait(250);
}
// ⚠⚠ NO FIRST LIGHT IS A FATAL. A broken shader module produces a full,
// well-formatted table of zeros and a VERDICT comparing them.
if (!firstLight) {
  console.log("\n  FATAL: [gi2] first light NEVER arrived — the chain did not compile.");
  await browser.close();
  process.exit(1);
}
const [eye, aim] = POSE_ENV.split("|").map((s) => s.split(",").map(Number));
await call("viewport.setCamera", { position: eye, target: aim });
console.log(`  first light yes · pose eye [${eye.map((v) => v.toFixed(2))}] → [${aim.map((v) => v.toFixed(2))}] · settling ${SETTLE}s`);

// ═══════════════════════════════════════════════════ CONVERGENCE, FROM BOOT
//
// ⭐⭐ §19 STAGE 5.3 — THE LOOP IS `probes → hits → probes` NOW, SO "DOES IT
// CONVERGE" STOPPED BEING A THING TO ARGUE ABOUT.
//
// A hit's radiance reads the merged field, and the field is fed by hits: that
// is a fixed-point iteration whose gain is the albedo, and §AK.6 has already
// shown what a gain near 1 does when the iteration passes through a NOISY
// intermediate (two fixed points, and a gate that lands on either one across
// identical boots). The direct-only face cache removes the cache's own loop;
// what remains has to be MEASURED, not asserted, and it has to be measured
// FROM BOOT rather than from a settled state — a monotone climb to a value and
// a damped oscillation around it look identical once you are standing on it.
//
// So: the gate's own pixels, sampled every poll from the moment the camera is
// parked, reduced to one mean. Two questions, both answerable from that curve:
//
//   · FRAMES TO 90 %  — the first gather frame whose mean is within 10 % of the
//                       final one, and never leaves. That is first-light
//                       latency for the SECOND BOUNCE, which no `[gi2] first
//                       light` line can see.
//   · MONOTONE        — the largest DROP between consecutive samples, as a
//                       fraction of the final mean. A rising series with a
//                       small dip is integration; a series that overshoots and
//                       comes back is a gain above 1 being clamped somewhere.
//
// ⚠ THE SAMPLER IS BUILT ONCE AND CACHED ON THE PAGE. `createGi2PixelDump`
// allocates GPU resources; rebuilding it per poll would measure the allocator.
const CONV = Number(process.env.CONV ?? 1);
const convSetup = CONV ? await page.evaluate(async ({ TARGET }) => {
  try {
    const eng = globalThis.__giEngineForProbe;
    const sys = globalThis.__giSys();
    const gi2 = globalThis.__gi2();
    const { createGi2PixelDump, GI2_PIXEL_OUT_VEC } = await import("/scripts/lib/gi2PixelDump.js");
    const stride = Math.max(1, Math.round(gi2.width / Math.max(24, TARGET / 4)));
    const dump = createGi2PixelDump({ renderer: eng.renderer, gi2, screen: sys.state?.screen, stride });
    const awaitFrame = () => new Promise((r) => { const off = eng.onPostRender(() => { off(); r(); }); });
    globalThis.__convSample = async () => {
      const d = await dump.read(awaitFrame);
      const OV = GI2_PIXEL_OUT_VEC;
      let sum = 0;
      let n = 0;
      for (let y = 0; y < dump.dumpH; y++) {
        for (let x = 0; x < dump.dumpW; x++) {
          const b = (y * dump.dumpW + x) * OV * 4;
          if (d[b + 3] < 0.5) continue;
          sum += 0.2126 * d[b + 8] + 0.7152 * d[b + 9] + 0.0722 * d[b + 10];
          n++;
        }
      }
      return { mean: n ? sum / n : 0, px: n, frame: gi2.gather?.frame ?? 0 };
    };
    return JSON.stringify({ ok: true, stride, px: dump.dumpW * dump.dumpH });
  } catch (e) { return JSON.stringify({ error: `${e?.message}` }); }
}, { TARGET }) : null;
const convSeries = [];
const convPoll = async () => {
  if (!CONV || !convSetup || JSON.parse(convSetup).error) return;
  try {
    const v = await page.evaluate(() => globalThis.__convSample?.());
    if (v && Number.isFinite(v.mean)) convSeries.push(v);
  } catch { /* a poll that races a rebuild is a missing sample, not a failure */ }
};
{
  const deadline = Date.now() + SETTLE * 1000;
  await convPoll();
  while (Date.now() < deadline) { await wait(400); await convPoll(); }
}
// The same wait `settleFrames` does, with the sampler in the loop: the climb
// continues well past the SETTLE window and a curve that stops at 20 s cannot
// answer "monotone".
let settled = 0;
{
  const f0 = await gatherFrame();
  const dl = Date.now() + 180000;
  let fr = f0;
  while (fr - f0 < FRAMES && Date.now() < dl) {
    await convPoll();
    await wait(250);
    fr = await gatherFrame();
  }
  settled = fr - f0;
}
await convPoll();
console.log(`  settled ${settled} gather frames`);

// ══════════════════════════════════════════════════════ THE PAGE-SIDE READ
const RJSON = await page.evaluate(async ({ TARGET }) => {
 try {
  const eng = globalThis.__giEngineForProbe;
  const sys = globalThis.__giSys();
  const gi2 = globalThis.__gi2();
  if (!gi2?.gather) return { error: "no gi2 gather" };
  const { createGi2PixelDump, GI2_PIXEL_OUT_VEC } = await import("/scripts/lib/gi2PixelDump.js");
  // ⚠ NO `import("three")` HERE. A bare specifier inside `page.evaluate` is
  // never transformed by Vite, so it does not resolve — and importing three by
  // URL would mint a SECOND module instance (the vite-module-duplication trap).
  // Everything below is plain arithmetic on `matrixWorld.elements`.
  const xf = (e, v) => [
    e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12],
    e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13],
    e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14],
  ];
  // ⚠ THE STRIDE IS DERIVED FROM THE LIVE TARGET, NOT ASSUMED. The viewport
  // panel's canvas is whatever the editor's dock layout leaves it, so a fixed
  // stride would give a different pixel count on every window size — and the
  // reference cache is keyed on the pixel set.
  const STRIDE = Math.max(1, Math.round(gi2.width / TARGET));
  const dump = createGi2PixelDump({
    renderer: eng.renderer, gi2, screen: sys.state?.screen, stride: STRIDE,
  });
  if (!dump) return JSON.stringify({ error: "pixel dump unavailable" });
  const awaitFrame = () => new Promise((r) => { const off = eng.onPostRender(() => { off(); r(); }); });
  const data = await dump.read(awaitFrame);
  // Only the VALID pixels cross the CDP boundary, 11 floats each: a full
  // 6 × vec4 dump of a 160² grid is 7 MB of JSON for 4 columns nothing reads.
  const OV = GI2_PIXEL_OUT_VEC;
  const compact = [];
  let ran = 0;
  for (let y = 0; y < dump.dumpH; y++) {
    for (let x = 0; x < dump.dumpW; x++) {
      const b = (y * dump.dumpW + x) * OV * 4;
      if (data[b + 15] === 12345) ran++;
      if (data[b + 3] < 0.5) continue;
      compact.push(x, y,
        data[b], data[b + 1], data[b + 2],
        data[b + 4], data[b + 5], data[b + 6],
        data[b + 8], data[b + 9], data[b + 10]);
    }
  }

  // ── the scene, as GI SEES IT ──────────────────────────────────────────────
  //
  // `state.entries` is GI's own participant list: one record per (mesh,
  // instance) with the surface the GI resolver assigned it. Reading the scene
  // graph instead would re-derive "which meshes count" in a second place and
  // could disagree with the build under test.
  const entries = sys.state?.entries ?? [];
  const byMesh = new Map();
  for (const e of entries) if (e.mesh && !byMesh.has(e.mesh)) byMesh.set(e.mesh, e);

  const tri = [];
  const triMat = [];
  const triSurf = [];
  const triEmit = [];
  const mats = [];
  const matKey = new Map();
  const meshSummary = [];
  const AXIS = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];

  // ⭐ THE SURFACE LABEL MUST NAME THE ENTITY, NOT THE THREE OBJECT. GI's
  // meshes are built by `MeshComponent` and carry an EMPTY `.name`; labelling
  // by it merged the back wall, the ceiling and two faces of the tall box into
  // one row called "mesh·+Z" — a population that averages a black box face
  // with a lit wall, which is the exact blindness this gate exists to remove.
  const nameOf = (mesh, i) => {
    let o = mesh;
    for (let k = 0; k < 6 && o; k++) {
      if (o.name) return o.name;
      o = o.parent;
    }
    return `mesh${i}`;
  };
  const nameUse = new Map();
  let meshIx = 0;
  for (const [mesh, entry] of byMesh) {
    const geo = mesh.geometry;
    const pos = geo?.attributes?.position;
    if (!pos) continue;
    mesh.updateWorldMatrix(true, false);
    const s = entry.surface ?? {};
    const albedo = [s.color?.r ?? 0.5, s.color?.g ?? 0.5, s.color?.b ?? 0.5];
    const ei = s.emissiveIntensity ?? 1;
    const emissive = [(s.emissive?.r ?? 0) * ei, (s.emissive?.g ?? 0) * ei, (s.emissive?.b ?? 0) * ei];
    const key = `${albedo.join(",")}|${emissive.join(",")}`;
    let mi = matKey.get(key);
    if (mi === undefined) { mi = mats.length; mats.push({ albedo, emissive }); matKey.set(key, mi); }
    let label = nameOf(mesh, meshIx);
    const seen = (nameUse.get(label) ?? 0) + 1;
    nameUse.set(label, seen);
    if (seen > 1) label = `${label}#${seen}`;
    meshIx++;
    const me = mesh.matrixWorld.elements;
    const idx = geo.index;
    const n = idx ? idx.count : pos.count;
    const before = tri.length / 9;
    for (let i = 0; i + 2 < n; i += 3) {
      const p = [];
      const lp = [];
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(i + k) : i + k;
        const l = [pos.getX(vi), pos.getY(vi), pos.getZ(vi)];
        lp.push(l);
        p.push(xf(me, l));
      }
      // Degenerate triangles poison a BVH's centroid box; drop them here, the
      // same rule the soup worker applies.
      const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
      const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
      const cx2 = ay * bz - az * by, cy2 = az * bx - ax * bz, cz2 = ax * by - ay * bx;
      if (!(cx2 * cx2 + cy2 * cy2 + cz2 * cz2 > 1e-18)) continue;
      for (const q of p) tri.push(q[0], q[1], q[2]);
      triMat.push(mi);
      // ⭐ THE FACE LABEL IS TAKEN IN THE MESH'S OWN FRAME. The tall box is
      // rotated 61°, so a WORLD dominant axis would merge two of its four
      // sides into one "surface" and average a black face with a lit one —
      // which is precisely the fault this gate exists to see.
      const la = [lp[1][0] - lp[0][0], lp[1][1] - lp[0][1], lp[1][2] - lp[0][2]];
      const lb = [lp[2][0] - lp[0][0], lp[2][1] - lp[0][1], lp[2][2] - lp[0][2]];
      const ln = [la[1] * lb[2] - la[2] * lb[1], la[2] * lb[0] - la[0] * lb[2], la[0] * lb[1] - la[1] * lb[0]];
      const aX = Math.abs(ln[0]), aY = Math.abs(ln[1]), aZ = Math.abs(ln[2]);
      const axis = aX >= aY && aX >= aZ ? (ln[0] < 0 ? 1 : 0)
        : (aY >= aZ ? (ln[1] < 0 ? 3 : 2) : (ln[2] < 0 ? 5 : 4));
      triSurf.push(`${label}·${AXIS[axis]}`);
      triEmit.push(emissive[0] + emissive[1] + emissive[2] > 1e-6 ? 1 : 0);
    }
    meshSummary.push({
      name: label, tris: tri.length / 9 - before, albedo, emissive,
      promoted: !!entry.promoted,
    });
  }

  const u = gi2.gather.uniforms;
  const vv = (x) => (x?.value?.isColor
    ? [x.value.r, x.value.g, x.value.b]
    : (x?.value ? [x.value.x ?? 0, x.value.y ?? 0, x.value.z ?? 0] : [0, 0, 0]));
  // ⚠ A SLOT'S FIELDS ARE NOT ALL PLAIN NUMBERS — `center`/`color` may be a
  // three Vector3/Color, an array, or a uniform node depending on how the
  // seat was filled. Coerce every one, and say so when a field could not be
  // read rather than printing a shape.
  // ⭐⭐ §19 5.4d — AND A COLOUR IS `r,g,b`, WHICH IS WHY THIS PRINTED A DEAD
  // LAMP. `THREE.Color` has NO `x`/`y`/`z` and is not indexable, so every
  // seated emitter's radiance read `[0,0,0]` and the receipt said the slots
  // were empty on a boot whose picture was demonstrably lit BY THOSE SLOTS —
  // the same class of blind statistic as 4e8dece, one line above the numbers a
  // whole stage was reasoned from. Read the container FIRST (a node's `.value`
  // is the object, not a bag of keys), then every naming convention it could
  // use. [[probe-blind-statistics]]
  const num3 = (v) => {
    if (!v) return [0, 0, 0];
    const src = (v.isColor || v.isVector3 || Array.isArray(v)) ? v : (v.value ?? v);
    const g = (k, c, j) => Number(src?.[k] ?? src?.[c] ?? src?.[j] ?? 0);
    const out = [g("x", "r", 0), g("y", "g", 1), g("z", "b", 2)];
    return out.map((q) => (Number.isFinite(q) ? q : 0));
  };
  const num1 = (v) => {
    const q = Number(v?.value ?? v ?? 0);
    return Number.isFinite(q) ? q : 0;
  };
  const slots = (sys.state?.emitterSlots ?? []).map((s) => ({
    center: num3(s.center), reff: num1(s.reff), radius: num1(s.radius),
    color: num3(s.color ?? s.rgb),
    keys: Object.keys(s).slice(0, 14).join(","),
  }));

  const cam = eng.camera;
  cam.updateMatrixWorld();
  return JSON.stringify({
    dumpW: dump.dumpW, dumpH: dump.dumpH, stride: dump.stride, OUT_VEC: GI2_PIXEL_OUT_VEC,
    width: dump.width, height: dump.height, attempts: data.attempts, ran,
    gi2W: gi2.width, gi2H: gi2.height, witness: data.witness,
    compact,
    scene: { tri, triMat, triSurf, triEmit, mats, meshes: meshSummary },
    sky: vv(u.skyColor), sunColor: vv(u.sunColor), sunDir: vv(u.sunDir),
    slots,
    gather: gi2.gather.describe(),
    camera: { pos: [cam.position.x, cam.position.y, cam.position.z], fov: cam.fov, aspect: cam.aspect },
    probes: gi2.gather.probeCount ?? 0,
    v0: gi2.win?.voxel0 ?? 0,
  });
 } catch (err) { return JSON.stringify({ error: `${err?.message ?? err}
${err?.stack ?? ""}`.slice(0, 900) }); }
}, { TARGET });
// ⚠ THE PAGE HANDS BACK A STRING, NOT AN OBJECT. Puppeteer's structured return
// silently yields `undefined` for a value it cannot serialise, and the first
// cut of this probe spent a boot on `Cannot read properties of undefined`
// instead of on a scene. A string always crosses.
const R = JSON.parse(RJSON ?? '{"error":"the page returned nothing"}');

if (R.error) { console.log(`  FATAL page read: ${R.error}`); await browser.close(); process.exit(1); }

// ══════════════════════════════════════════ UNPACK + THE HEALTH GATE (⚠ first)
const px = [];
for (let i = 0; i < R.compact.length; i += 11) {
  const c = R.compact;
  px.push({
    x: c[i], y: c[i + 1],
    p: [c[i + 2], c[i + 3], c[i + 4]],
    n: [c[i + 5], c[i + 6], c[i + 7]],
    // `gi2.textures.irradiance` — the texture every material samples, i.e.
    // what the user's eye sees.
    E: [c[i + 8], c[i + 9], c[i + 10]],
  });
}
const irrP50 = quantile(px.map((q) => lum(q.E)), 0.5);
console.log(`  health: ${px.length} valid px of ${R.dumpW * R.dumpH}, irradiance p50 ${f(irrP50, 5)}, ` +
  `probes ${R.probes}, tris ${R.scene.triMat.length}, mats ${R.scene.mats.length}, ` +
  `dump attempts ${R.attempts}, kernel witness ${R.ran}/${R.dumpW * R.dumpH}`);
if (!(px.length > 0) || !(irrP50 > 1e-3) || !(R.probes > 0)) {
  console.log("  FATAL health gate: an unlit or empty frame — every number below would be a zero dressed as a measurement.");
  await browser.close();
  process.exit(1);
}
// ⚠ AN ALL-ZERO SLOT PRINTS THE FIELD NAMES IT ACTUALLY FOUND. A reader must
// be able to tell "this lamp is dark" from "this printer cannot read this
// object", and only the second one has a `keys` list worth showing.
console.log(`  emitter slots ${R.slots.length}: ` + (R.slots.map((s) => {
  const dead = !(s.radius > 1e-5) && !(s.color.reduce((a, b) => a + b, 0) > 1e-6);
  return `c[${s.center.map((v) => v.toFixed(2))}] reff ${f(s.reff, 2)} `
    + `r ${f(s.radius, 2)} L[${s.color.map((v) => v.toFixed(2))}]`
    + (dead && s.keys ? ` {${s.keys}}` : "");
}).join(" · ") || "none"));
console.log(`  sky [${R.sky.map((v) => v.toFixed(3))}]  sun [${R.sunColor.map((v) => v.toFixed(3))}]  ` +
  `worldProbes ${R.gather.worldProbes}  cacheSmooth ${R.gather.cacheSmooth}  coldFill ${R.gather.coldFill}  skyRays ${R.gather.skyRays}`);
for (const m of R.scene.meshes) {
  console.log(`    ${String(m.name).padEnd(14)} ${String(m.tris).padStart(5)} tris  albedo [${m.albedo.map((v) => v.toFixed(2))}]  emissive [${m.emissive.map((v) => v.toFixed(2))}]`);
}

// ═══════════════════════════════════════════════════ THE REFERENCE, ON CPU
const tris = new Float32Array(R.scene.tri);
const triMat = new Int32Array(R.scene.triMat);
const tracer = makeSceneTracer({ tris, triMat, mats: R.scene.mats, sky: R.sky }, BOUNCES);
console.log(`  reference: ${tracer.stats.tris} tris, ${tracer.stats.nodes} bvh nodes, ` +
  `${tracer.stats.emitTris} emissive tris, ${f(tracer.stats.emitArea, 3)} m² emitting`);
if (tracer.stats.emitTris === 0) {
  console.log("  FATAL: the reference found NO emissive triangle — it would path-trace a dark room and call GI2 wrong everywhere.");
  await browser.close();
  process.exit(1);
}

// ── which surface each pixel belongs to (closest point on triangle) ─────────
const closestOnTri = (p, ti) => {
  const b = ti * 9;
  const ax = tris[b], ay = tris[b + 1], az = tris[b + 2];
  const e1x = tris[b + 3] - ax, e1y = tris[b + 4] - ay, e1z = tris[b + 5] - az;
  const e2x = tris[b + 6] - ax, e2y = tris[b + 7] - ay, e2z = tris[b + 8] - az;
  const dx = p[0] - ax, dy = p[1] - ay, dz = p[2] - az;
  const a = e1x * e1x + e1y * e1y + e1z * e1z;
  const bb = e1x * e2x + e1y * e2y + e1z * e2z;
  const c = e2x * e2x + e2y * e2y + e2z * e2z;
  const d = e1x * dx + e1y * dy + e1z * dz;
  const e = e2x * dx + e2y * dy + e2z * dz;
  const det = a * c - bb * bb;
  let s = (c * d - bb * e) / (det || 1e-12);
  let t = (a * e - bb * d) / (det || 1e-12);
  if (s < 0) s = 0; if (t < 0) t = 0;
  if (s + t > 1) { const k = s + t; s /= k; t /= k; }
  const qx = ax + e1x * s + e2x * t, qy = ay + e1y * s + e2y * t, qz = az + e1z * s + e2z * t;
  return Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz);
};
const gnOf = (ti) => {
  const b = ti * 9;
  const ax = tris[b + 3] - tris[b], ay = tris[b + 4] - tris[b + 1], az = tris[b + 5] - tris[b + 2];
  const bx = tris[b + 6] - tris[b], by = tris[b + 7] - tris[b + 1], bz = tris[b + 8] - tris[b + 2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
};
const triN = [];
for (let i = 0; i < triMat.length; i++) triN.push(gnOf(i));
for (const q of px) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < triMat.length; i++) {
    // The gbuffer normal is the shading normal; a triangle whose geometric
    // normal disagrees with it is a different surface even if it is nearer.
    const dp = triN[i][0] * q.n[0] + triN[i][1] * q.n[1] + triN[i][2] * q.n[2];
    if (dp < 0.8) continue;
    const d = closestOnTri(q.p, i);
    if (d < bd) { bd = d; best = i; }
  }
  q.surf = best >= 0 && bd < 0.35 ? R.scene.triSurf[best] : "unclassified";
  // ⚠ AN EMITTER'S OWN FACE IS NOT SCORED. What the eye sees there is the
  // raster material's emission, not GI's irradiance — the reference correctly
  // reports ~0 incident irradiance on a convex emitter, so scoring it would
  // put a 13.6× row in a table about bounce light.
  q.emitFace = best >= 0 ? !!R.scene.triEmit[best] : false;
  q.surfDist = bd;
}

// ── the cache key: the scene, the pose and the sample budget ────────────────
/**
 * ⚠ AND THE TRACER'S OWN VERSION. A cached reference is a TRUTH on disk; when
 * the estimator that produced it is corrected the cache must miss, or the next
 * run scores a fixed build against the old bug. Bump on any change to
 * `gi2SceneReference.mjs`'s estimator. 2 = §19 5.3e's NEE self-shadow fix.
 */
const REF_VERSION = 2;
const sceneHash = createHash("sha1").update(JSON.stringify({
  REF_VERSION,
  tri: R.scene.tri.map((v) => Math.round(v * 1e4)), triMat: R.scene.triMat,
  mats: R.scene.mats, sky: R.sky, BOUNCES, SPP,
  pose: POSE_ENV, SIZE, stride: R.stride, dumpW: R.dumpW, dumpH: R.dumpH,
})).digest("hex").slice(0, 16);
mkdirSync(CACHE_DIR, { recursive: true });
const cachePath = path.join(CACHE_DIR, `${SCENE}-${sceneHash}.json`);

let cached = null;
if (!NOCACHE && existsSync(cachePath)) {
  try {
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    // ⚠ A HASH IS NOT A VERIFICATION. The reference is keyed on the scene, but
    // the PIXELS come off the GPU gbuffer; a cache reused against a different
    // pixel set would silently compare each pixel to another pixel's truth.
    let ok = c.n === px.length;
    for (let i = 0; i < px.length && ok; i++) {
      for (let k = 0; k < 3; k++) if (Math.abs(c.pos[i * 3 + k] - px[i].p[k]) > 2e-3) ok = false;
    }
    cached = ok ? c : null;
  } catch { cached = null; }
}

let refE;
let refNoise;
if (cached) {
  refE = cached.E;
  refNoise = cached.noise;
  console.log(`  reference: CACHE HIT ${path.basename(cachePath)}`);
} else {
  const t0 = Date.now();
  refE = new Array(px.length);
  refNoise = new Array(px.length);
  const half = Math.max(4, Math.round(SPP / 2));
  for (let i = 0; i < px.length; i++) {
    const q = px[i];
    // Two independent halves at different seeds: their disagreement IS the
    // reference's own per-pixel noise, and the gate refuses to score a pixel
    // whose instrument is noisier than the artefact it is looking for.
    const A = tracer.irradiance(q.p, q.n, half, 0x9e37 + i * 2654435761 % 1e9, 64);
    const B = tracer.irradiance(q.p, q.n, half, 0x1b3f + i * 40503 % 1e9, 64);
    const E = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
    refE[i] = E;
    const la = lum(A), lb = lum(B), lm = (la + lb) / 2;
    // |A−B|/2 estimates the σ of one half; the mean's σ is that over √2.
    refNoise[i] = lm > 1e-9 ? Math.abs(la - lb) / 2 / Math.SQRT2 / lm : 1;
    if ((i & 1023) === 0) {
      process.stdout.write(`\r  reference: ${i}/${px.length} px  ${Math.round((Date.now() - t0) / 1000)}s   `);
    }
  }
  console.log(`\r  reference: ${px.length} px traced at ${SPP} spp in ${Math.round((Date.now() - t0) / 1000)}s          `);
  writeFileSync(cachePath, JSON.stringify({
    n: px.length, pos: px.flatMap((q) => q.p), E: refE, noise: refNoise,
  }));
}
const noiseP50 = quantile(refNoise, 0.5);
const noiseP90 = quantile(refNoise, 0.9);
console.log(`  reference noise (its own, per pixel): p50 ${pct(noiseP50, 2)}, p90 ${pct(noiseP90, 2)} ` +
  `— ${refNoise.filter((v) => v < 0.02).length}/${refNoise.length} pixels under 2 %`);

// ══════════════════════════════════════════════════════════════ THE METRICS
const LIT = 0.02;            // E_ref luminance above which a pixel is "lit"
const rows = px.map((q, i) => ({
  ...q, ref: refE[i], noise: refNoise[i],
  lg: Math.log(Math.max(1e-9, lum(q.E)) / Math.max(1e-9, lum(refE[i]))),
}));
const litRows = rows.filter((r) => lum(r.ref) > LIT && !r.emitFace);

// (a) AGREEMENT
const absLg = litRows.map((r) => Math.abs(r.lg));
const medLg = quantile(absLg, 0.5);
const p90Lg = quantile(absLg, 0.9);
// The global gain, so the receipt can say whether a miss is a SCALE (one
// number wrong everywhere — an emitter-shape approximation) or a SHAPE (the
// light in the wrong places), which are different bugs with different fixes.
const gain = Math.exp(quantile(litRows.map((r) => r.lg), 0.5));
const absLgN = litRows.map((r) => Math.abs(r.lg - Math.log(gain)));

// (b) BLACK CENSUS
const black = litRows.filter((r) => lum(r.E) < 0.05 * lum(r.ref));
const blackBySurf = new Map();
for (const r of black) blackBySurf.set(r.surf, (blackBySurf.get(r.surf) ?? 0) + 1);

// (c)+(d) PER SURFACE
const bySurf = new Map();
for (const r of rows) {
  if (r.emitFace) continue;
  if (!bySurf.has(r.surf)) bySurf.set(r.surf, []);
  bySurf.get(r.surf).push(r);
}
const tangents = (n) => {
  const a = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]];
  const tl = Math.hypot(...t) || 1;
  const t1 = [t[0] / tl, t[1] / tl, t[2] / tl];
  const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
  return [t1, t2];
};
/**
 * The SECOND DIFFERENCE at a world-space lag, on the surface's own plane.
 *
 * ⭐ A LEVEL OFFSET IS INVISIBLE AND A CURVATURE IS NOT. A surface that is
 * uniformly 20 % bright reads as a surface; one that swings ±20 % over half a
 * metre reads as a blotch. So the statistic is `|m[i−1] − 2m[i] + m[i+1]|`
 * over cells of side `h`, which is zero for any level AND any linear ramp —
 * the two things a correct GI legitimately has — and is exactly the curvature
 * the eye picks out. The REFERENCE is measured the same way and is the floor.
 */
const secondDiff = (list, pick, n, h) => {
  const [t1, t2] = tangents(n);
  const cell = new Map();
  for (const r of list) {
    const a = Math.floor((r.p[0] * t1[0] + r.p[1] * t1[1] + r.p[2] * t1[2]) / h);
    const b = Math.floor((r.p[0] * t2[0] + r.p[1] * t2[1] + r.p[2] * t2[2]) / h);
    const k = `${a},${b}`;
    const c = cell.get(k) ?? { s: 0, n: 0, a, b };
    c.s += lum(pick(r)); c.n++;
    cell.set(k, c);
  }
  const at = (a, b) => { const c = cell.get(`${a},${b}`); return c && c.n >= 3 ? c.s / c.n : null; };
  const out = [];
  for (const c of cell.values()) {
    for (const [da, db] of [[1, 0], [0, 1]]) {
      const m0 = at(c.a - da, c.b - db), m1 = at(c.a, c.b), m2 = at(c.a + da, c.b + db);
      if (m0 == null || m1 == null || m2 == null) continue;
      out.push(Math.abs(m0 - 2 * m1 + m2));
    }
  }
  return out.length ? Math.sqrt(mean(out.map((v) => v * v))) : NaN;
};

const surfRows = [];
for (const [name, list] of [...bySurf.entries()].sort((a, b) => b[1].length - a[1].length)) {
  if (name === "unclassified" || list.length < 24) continue;
  const nrm = list[0].n;
  const gi = list.map((r) => lum(r.E));
  const rf = list.map((r) => lum(r.ref));
  const mg = mean(gi), mr = mean(rf);
  // ⚠ SCORED ONLY WHERE THE REFERENCE IS QUIET. A residual σ taken against a
  // noisy reference measures the reference.
  const quiet = list.filter((r) => r.noise < 0.02 && lum(r.ref) > LIT);
  const resid = quiet.map((r) => lum(r.E) - lum(r.ref));
  const mres = mean(resid);
  const sd = quiet.length > 8
    ? Math.sqrt(mean(resid.map((v) => (v - mres) ** 2))) : NaN;
  // the reference's own residual against ITSELF is zero by construction, so
  // the floor for σ is the reference's shot noise on the same population
  const refSigma = quiet.length > 8
    ? Math.sqrt(mean(quiet.map((r) => (r.noise * lum(r.ref)) ** 2))) : NaN;
  surfRows.push({
    name, n: list.length, quiet: quiet.length,
    meanGi: mg, meanRef: mr, ratio: mg / Math.max(1e-9, mr),
    sigma: sd, sigmaRel: sd / Math.max(1e-9, mr),
    refSigmaRel: refSigma / Math.max(1e-9, mr),
    black: blackBySurf.get(name) ?? 0,
    d2_25: secondDiff(list, (r) => r.E, nrm, 0.25),
    d2r_25: secondDiff(list, (r) => r.ref, nrm, 0.25),
    d2_50: secondDiff(list, (r) => r.E, nrm, 0.5),
    d2r_50: secondDiff(list, (r) => r.ref, nrm, 0.5),
  });
}

// ═══════════════════════════════════════════════════════════════ THE REPORT
console.log("");
console.log("  ── (a) AGREEMENT, per pixel ─────────────────────────────────────────");
console.log(`  |log(E_gi2/E_ref)|   median ${f(medLg)}  p90 ${f(p90Lg)}   over ${litRows.length} lit px` +
  `   [gate: med < ${GATE.medLogRatio}, p90 < ${GATE.p90LogRatio}]`);
console.log(`  global gain ${f(gain)}×  →  after removing it: median ${f(quantile(absLgN, 0.5))}  p90 ${f(quantile(absLgN, 0.9))}`);
console.log("");
console.log("  ── (b) BLACK CENSUS  (E_gi2 < 5 % of E_ref, where E_ref > 0.02) ─────");
console.log(`  ${black.length} of ${litRows.length} lit px   [gate: ${GATE.blackPixels}]`);
if (black.length) {
  for (const [s, c] of [...blackBySurf.entries()].sort((a, b) => b[1] - a[1])) {
    const tot = (bySurf.get(s) ?? []).length;
    console.log(`    ${s.padEnd(20)} ${String(c).padStart(5)} of ${String(tot).padStart(5)} px  ${pct(c / tot)}`);
  }
}
console.log("");
console.log("  ── (c) BLOTCH + (d) ENERGY, per surface ─────────────────────────────");
console.log("  surface               px   E_gi2    E_ref    ratio |  σ(res)/mean  (ref)  |  d²@0.25  (ref)  |  d²@0.50  (ref)  | black");
for (const s of surfRows) {
  console.log(
    `  ${s.name.padEnd(20)} ${String(s.n).padStart(4)}  ${f(s.meanGi, 4).padStart(7)}  ${f(s.meanRef, 4).padStart(7)}  ` +
    `${f(s.ratio, 2).padStart(6)} | ${pct(s.sigmaRel).padStart(8)} ${pct(s.refSigmaRel).padStart(8)} | ` +
    `${f(s.d2_25, 4).padStart(8)} ${f(s.d2r_25, 4).padStart(8)} | ${f(s.d2_50, 4).padStart(8)} ${f(s.d2r_50, 4).padStart(8)} | ${String(s.black).padStart(5)}`,
  );
}

// ── the verdict ─────────────────────────────────────────────────────────────
const failSigma = surfRows.filter((s) => s.sigmaRel > GATE.blotchSigma && s.quiet > 32);
const failD2 = surfRows.filter((s) => Number.isFinite(s.d2_25) && Number.isFinite(s.d2r_25)
  && s.d2_25 > Math.max(GATE.d2Ratio * s.d2r_25, 0.02 * s.meanRef) && s.quiet > 32);
const checks = [
  ["(a) median |log ratio|", medLg <= GATE.medLogRatio, `${f(medLg)} ≤ ${GATE.medLogRatio}`],
  ["(a) p90 |log ratio|", p90Lg <= GATE.p90LogRatio, `${f(p90Lg)} ≤ ${GATE.p90LogRatio}`],
  ["(b) black pixels", black.length <= GATE.blackPixels, `${black.length} ≤ ${GATE.blackPixels}`],
  ["(c) blotch σ/mean", failSigma.length === 0, `${failSigma.length} surfaces over ${pct(GATE.blotchSigma, 0)}: ${failSigma.map((s) => s.name).join(", ") || "—"}`],
  ["(c) second difference", failD2.length === 0, `${failD2.length} surfaces over ${GATE.d2Ratio}× the reference: ${failD2.map((s) => s.name).join(", ") || "—"}`],
];
console.log("");
console.log("  ── VERDICT ──────────────────────────────────────────────────────────");
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} ${detail}`);
}
const passed = checks.filter((c) => c[1]).length;
console.log(`  ${passed}/${checks.length} gate checks pass`);

const result = {
  scene: SCENE, pose: POSE_ENV, size: SIZE, stride: R.stride, spp: SPP, bounces: BOUNCES,
  gather: R.gather, slots: R.slots, meshes: R.scene.meshes,
  px: px.length, lit: litRows.length, irrP50,
  medLg, p90Lg, gain, medLgN: quantile(absLgN, 0.5), p90LgN: quantile(absLgN, 0.9),
  black: black.length, blackBySurf: Object.fromEntries(blackBySurf),
  refNoiseP50: noiseP50, refNoiseP90: noiseP90,
  surfaces: surfRows, checks: checks.map(([n, ok, d]) => ({ n, ok, d })), passed,
  // ⭐ THE POPULATIONS THE NEXT PROBE HAS TO EXPLAIN, CARRIED FORWARD RATHER
  // THAN RE-DERIVED. `run-gi2-cornell-black.mjs` reads the cache faces behind
  // these exact world points; deriving "which pixels are black" a second time
  // there would let the two probes disagree about the subject.
  // The SCENE and the sky, so an OFFLINE analysis (`run-gi2-quadrature.mjs`)
  // can path-trace the same room without a second boot and without a second
  // description of it.
  scene: R.scene, sky: R.sky, v0: R.v0,
  // An UNBIASED per-surface sample, next to the two biased ones below: a σ
  // measured over "the black pixels" is a statement about the tail, and the
  // quadrature question is about the whole surface.
  sampleList: [...bySurf.entries()].flatMap(([name, list]) => {
    const step = Math.max(1, Math.floor(list.length / 260));
    return list.filter((_, i) => i % step === 0)
      .map((r) => ({ p: r.p, n: r.n, surf: name, E: lum(r.E), ref: lum(r.ref), noise: r.noise }));
  }),
  blackList: black.slice(0, 600).map((r) => ({ p: r.p, n: r.n, surf: r.surf, E: lum(r.E), ref: lum(r.ref) })),
  // …and a matched CONTROL: the brightest pixel of each surface that carries
  // black ones, so "the cache is cold there" can be told from "the cache is
  // cold everywhere".
  litList: [...bySurf.entries()].flatMap(([name, list]) => {
    const ok = list.filter((r) => lum(r.ref) > LIT).sort((a, b) => lum(b.E) - lum(a.E)).slice(0, 40);
    return ok.map((r) => ({ p: r.p, n: r.n, surf: name, E: lum(r.E), ref: lum(r.ref) }));
  }),
};

// ══════════════════════════════════════════════ CONVERGENCE — THE RECEIPT
if (convSeries.length >= 3) {
  const finalMean = convSeries[convSeries.length - 1].mean;
  const f0 = convSeries[0].frame;
  // The first sample within 10 % of the final value that is never left again —
  // "reached and stayed", which a first-crossing alone does not establish.
  let idx90 = convSeries.length - 1;
  for (let i = convSeries.length - 1; i >= 0; i--) {
    if (Math.abs(convSeries[i].mean - finalMean) <= 0.1 * Math.abs(finalMean)) idx90 = i;
    else break;
  }
  let maxDrop = 0;
  for (let i = 1; i < convSeries.length; i++) {
    const d = convSeries[i - 1].mean - convSeries[i].mean;
    if (d > maxDrop) maxDrop = d;
  }
  const dropRel = finalMean > 0 ? maxDrop / finalMean : NaN;
  console.log("");
  console.log("  ── CONVERGENCE FROM BOOT (the gate's own pixels, every poll) ────────");
  // §19 5.3 — [E]'s and [J]'s tallies beside the curve. A hit list that dropped
  // entries and a genuinely dim bounce are the same picture; only this says
  // which. Silent when the cascades are not built.
  try {
    const rcj = await page.evaluate(async () => {
      const eng = globalThis.__giEngineForProbe;
      const rc = globalThis.__gi2()?.rc;
      if (!rc) return null;
      const [d, j, m] = await Promise.all([
        rc.readStats(eng.renderer), rc.readHitStats(eng.renderer),
        rc.readMergeStats ? rc.readMergeStats(eng.renderer) : null,
      ]);
      return JSON.stringify({ d, j, m, describe: rc.describe() });
    });
    if (rcj) {
      const { d, j, m, describe } = JSON.parse(rcj);
      console.log(`  [E] rays ${d.rays} hits ${d.hits} (${pct(d.hitRate)}) deposits ${d.deposits} ` +
        `perRay ${f(d.perRay, 2)} noBlock ${d.noBlock} clamped ${d.clamped} maxL ${f(d.maxRadianceFraction, 3)}`);
      console.log(`  [J] ${j ? `${j.hits}/${j.capacity} shaded${j.bounce ? " +bounce" : " (single)"}` +
        `  BOUNCE-CLAMPED ${j.clamped}  OVERFLOW ${d.secondaryOverflow}` : "not built (inline arm)"}` +
        `   hitRadiance ${describe.hitRadiance}  hitList ${describe.pools.hitList}`);
      // ⭐⭐ §19 5.4d — THE BIN CENSUS, PER CASCADE. A gain measured on the
      // picture cannot say whether a direction was DARK or ABSENT, and those
      // want opposite fixes: an orphaned bin kept `L_self + T·sky` because no
      // parent bin in that direction was ever filled. `cycle` names the
      // direction schedule the fill ran under, because the whole point of the
      // census is to compare two of them.
      if (Array.isArray(m?.cascades)) {
        console.log(`  merge census (cycle ${describe.cycleK ?? "—"}, jitter ${describe.jitter}): `
          + m.cascades.map((c, i) => `c${i} orphan ${pct(c.orphanRate ?? 0)}`
            + (c.orphanLiveRate != null ? `/live ${pct(c.orphanLiveRate)}` : "")).join("  "));
      }
    }
  } catch (e) { console.log(`  [E]/[J] tallies unavailable: ${e?.message}`); }
  console.log(`  samples ${convSeries.length} · mean E ${f(convSeries[0].mean, 4)} → ${f(finalMean, 4)}`);
  console.log(`  frames to 90 % of final   ${convSeries[idx90].frame - f0}   ` +
    `(gather frame ${convSeries[idx90].frame}, ${convSeries[idx90] === convSeries[convSeries.length - 1] ? "NEVER SETTLED" : "held"})`);
  console.log(`  largest drop between samples ${pct(dropRel, 2)}   ` +
    `[monotone: ≤ 2 %]  → ${dropRel <= 0.02 ? "MONOTONE" : "NOT MONOTONE"}`);
  const step = Math.max(1, Math.floor(convSeries.length / 10));
  console.log(`  curve  ${convSeries.filter((_, i) => i % step === 0).map((v) => f(v.mean, 3)).join(" ")}`);
  result.convergence = {
    samples: convSeries.length,
    framesTo90: convSeries[idx90].frame - f0,
    settled: convSeries[idx90] !== convSeries[convSeries.length - 1],
    maxDropRel: dropRel,
    monotone: dropRel <= 0.02,
    first: convSeries[0].mean,
    final: finalMean,
    series: convSeries.map((v) => [v.frame - f0, +v.mean.toFixed(5)]),
  };
}

// ═══════════════════════════════════════════ THE IMAGE AT REST (must be 0)
//
// ⭐⭐ THE NO-NOISE RULE IS A STATEMENT ABOUT THE IMAGE, NOT ABOUT THE METHOD.
// "noiseless BY CONSTRUCTION" means that with the camera parked and nothing in
// the scene moving, two frames N apart must be THE SAME FRAME. This dumps the
// same pixels again after `REST` gather frames and reports the per-pixel
// |ΔE|/E — which is zero for a converged deterministic chain and is not zero
// for one that is still rattling.
if (REST > 0) {
  await settleFrames(REST);
  const BJ = await page.evaluate(async ({ TARGET }) => {
    try {
      const eng = globalThis.__giEngineForProbe;
      const sys = globalThis.__giSys();
      const gi2 = globalThis.__gi2();
      const { createGi2PixelDump, GI2_PIXEL_OUT_VEC } = await import("/scripts/lib/gi2PixelDump.js");
      const stride = Math.max(1, Math.round(gi2.width / TARGET));
      const dump = createGi2PixelDump({ renderer: eng.renderer, gi2, screen: sys.state?.screen, stride });
      const awaitFrame = () => new Promise((r) => { const off = eng.onPostRender(() => { off(); r(); }); });
      const d = await dump.read(awaitFrame);
      const OV = GI2_PIXEL_OUT_VEC;
      const out = [];
      for (let y = 0; y < dump.dumpH; y++) {
        for (let x = 0; x < dump.dumpW; x++) {
          const b = (y * dump.dumpW + x) * OV * 4;
          if (d[b + 3] < 0.5) continue;
          out.push(d[b + 8], d[b + 9], d[b + 10]);
        }
      }
      return JSON.stringify({ out });
    } catch (e) { return JSON.stringify({ error: `${e?.message}` }); }
  }, { TARGET });
  const B = JSON.parse(BJ ?? '{"error":"nothing"}');
  if (B.error || B.out.length / 3 !== rows.length) {
    console.log(`
  at rest: could not re-dump (${B.error ?? `${B.out.length / 3} px vs ${rows.length}`})`);
  } else {
    const rel = [];
    for (let i = 0; i < rows.length; i++) {
      const a = lum(rows[i].E);
      const b = lum([B.out[i * 3], B.out[i * 3 + 1], B.out[i * 3 + 2]]);
      if (a > 0.02) rel.push(Math.abs(b - a) / a);
    }
    console.log("");
    console.log(`  ── THE IMAGE AT REST (${REST} gather frames apart, camera parked) ──────`);
    console.log(`  |ΔE|/E   p50 ${pct(quantile(rel, 0.5), 2)}   p90 ${pct(quantile(rel, 0.9), 2)}   ` +
      `max ${pct(Math.max(...rel), 1)}   over ${rel.length} px   [rule: 0 %]`);
    result.rest = { frames: REST, p50: quantile(rel, 0.5), p90: quantile(rel, 0.9), max: Math.max(...rel) };
  }
}

// ═════════════════════════ §19 5.3c — THE Δ MAP: WHICH PIXELS, AND IS IT PERIODIC
//
// ⭐⭐ A RESIDUAL WITH A PERIOD IS A DIFFERENT BUG FROM ONE WITHOUT. This takes
// `RESTMAP` dumps back to back, records the GATHER FRAME each landed on, and
// scores every PAIR of dumps by its frame gap. A converged deterministic field
// reads 0 at every gap; a phase-staggered refresh reads far lower at gaps that
// are multiples of its period — which names the period, and the period names
// the pass. The per-surface SWING then says where the residual lives.
if (RESTMAP > 1) {
  const dumpOnce = async () => {
    const j = await page.evaluate(async ({ TARGET }) => {
      try {
        const eng = globalThis.__giEngineForProbe;
        const sys = globalThis.__giSys();
        const gi2 = globalThis.__gi2();
        const { createGi2PixelDump, GI2_PIXEL_OUT_VEC } = await import("/scripts/lib/gi2PixelDump.js");
        const stride = Math.max(1, Math.round(gi2.width / TARGET));
        const dump = createGi2PixelDump({ renderer: eng.renderer, gi2, screen: sys.state?.screen, stride });
        const awaitFrame = () => new Promise((r) => { const off = eng.onPostRender(() => { off(); r(); }); });
        const d = await dump.read(awaitFrame);
        const OV = GI2_PIXEL_OUT_VEC;
        const out = [];
        for (let y = 0; y < dump.dumpH; y++) {
          for (let x = 0; x < dump.dumpW; x++) {
            const b = (y * dump.dumpW + x) * OV * 4;
            if (d[b + 3] < 0.5) continue;
            out.push(d[b + 8], d[b + 9], d[b + 10]);
          }
        }
        return JSON.stringify({ out, frame: gi2?.gather?.frame ?? 0 });
      } catch (e) { return JSON.stringify({ error: String(e?.message) }); }
    }, { TARGET });
    return JSON.parse(j ?? '{"error":"nothing"}');
  };
  const series = [];
  for (let k = 0; k < RESTMAP; k++) {
    const d = await dumpOnce();
    if (d.error || d.out.length / 3 !== rows.length) {
      console.log(`  Δ map: dump ${k} failed (${d.error ?? d.out.length / 3})`);
      break;
    }
    series.push(d);
  }
  if (series.length > 1) {
    const lumOf = (sr, i) => lum([sr.out[i * 3], sr.out[i * 3 + 1], sr.out[i * 3 + 2]]);
    const idx = rows.map((r, i) => i).filter((i) => lum(rows[i].E) > 0.02 && !rows[i].emitFace);
    console.log("");
    console.log(`  ── §19 5.3c THE Δ MAP (${series.length} dumps, gather frames ${series.map((x) => x.frame).join(",")}) ──`);
    const byGap = new Map();
    for (let a = 0; a < series.length; a++) {
      for (let b = a + 1; b < series.length; b++) {
        const gap = series[b].frame - series[a].frame;
        if (gap <= 0) continue;
        const rel2 = idx.map((i) => Math.abs(lumOf(series[b], i) - lumOf(series[a], i))
          / Math.max(1e-6, lumOf(series[a], i)));
        if (!byGap.has(gap)) byGap.set(gap, []);
        byGap.get(gap).push(quantile(rel2, 0.9));
      }
    }
    const gaps = [...byGap.keys()].sort((x, y) => x - y);
    console.log("  frame gap   pairs   p90 |ΔE|/E");
    for (const g of gaps.slice(0, 20)) {
      console.log(`  ${String(g).padStart(9)} ${String(byGap.get(g).length).padStart(7)}   ${pct(mean(byGap.get(g)), 2)}`);
    }
    const swing = new Map();
    for (const i of idx) {
      const vs = series.map((x) => lumOf(x, i));
      const m = mean(vs);
      const sw = (Math.max(...vs) - Math.min(...vs)) / Math.max(1e-6, m);
      const name = rows[i].surf;
      if (!swing.has(name)) swing.set(name, []);
      swing.get(name).push(sw);
    }
    console.log("  surface                px    swing p50    swing p90    swing max");
    const swRows = [...swing.entries()].filter(([, v]) => v.length >= 16)
      .sort((a, b) => quantile(b[1], 0.9) - quantile(a[1], 0.9));
    for (const [name, v] of swRows) {
      console.log(`  ${name.padEnd(20)} ${String(v.length).padStart(5)}   ${pct(quantile(v, 0.5), 2).padStart(9)}   ` +
        `${pct(quantile(v, 0.9), 2).padStart(9)}   ${pct(Math.max(...v), 1).padStart(9)}`);
    }
    result.restMap = {
      dumps: series.length,
      frames: series.map((x) => x.frame),
      byGap: gaps.map((g) => [g, mean(byGap.get(g))]),
      surfaces: swRows.map(([name, v]) => ({ name, px: v.length, p50: quantile(v, 0.5), p90: quantile(v, 0.9) })),
    };
  }
}

// ═══════════════════════════════════════════════════════ THE UNIFORM ARMS
//
// ⭐⭐ WHAT CAN BE TUNED, AND WHAT NEEDS A SHADER. Four of the levers this
// chain has are `uniform()`s on the live gather — `cacheSmoothU`, `coldFillU`,
// `shadeStrideU`, `nCapU`, `skyAtHit` — so every one of them can be flipped
// from the harness, settled, and re-scored against the SAME cached reference
// at the SAME pixels, inside ONE boot. A lever that needs a source change is
// then distinguishable from one that does not by measurement rather than by
// argument, and the arms cannot disagree about the pose, the voxelization or
// the reference.
//
// ⚠ THE PIXEL SET IS THE BASELINE'S, BY INDEX. The camera is parked, so the
// dump order is identical; the arm read verifies each world position against
// the baseline's and refuses the arm if they moved.
if (ARMS.length) {
  const rescore = (Enew) => {
    const rws = rows.map((r, i) => ({ ...r, E: Enew[i] }));
    const lit = rws.filter((r) => lum(r.ref) > LIT && !r.emitFace);
    const alg = lit.map((r) => Math.abs(Math.log(Math.max(1e-9, lum(r.E)) / Math.max(1e-9, lum(r.ref)))));
    const blk = lit.filter((r) => lum(r.E) < 0.05 * lum(r.ref));
    const bs = new Map();
    for (const r of rws) {
      if (r.emitFace) continue;
      if (!bs.has(r.surf)) bs.set(r.surf, []);
      bs.get(r.surf).push(r);
    }
    const sr = [];
    for (const [name, list] of bs) {
      if (name === "unclassified" || list.length < 24) continue;
      const quiet = list.filter((r) => r.noise < 0.02 && lum(r.ref) > LIT);
      if (quiet.length <= 8) continue;
      const resid = quiet.map((r) => lum(r.E) - lum(r.ref));
      const mres = mean(resid);
      const mr = mean(list.map((r) => lum(r.ref)));
      sr.push({
        name, ratio: mean(list.map((r) => lum(r.E))) / Math.max(1e-9, mr),
        sigmaRel: Math.sqrt(mean(resid.map((v) => (v - mres) ** 2))) / Math.max(1e-9, mr),
        d2_25: secondDiff(list, (r) => r.E, list[0].n, 0.25),
        black: blk.filter((r) => r.surf === name).length,
      });
    }
    return {
      med: quantile(alg, 0.5), p90: quantile(alg, 0.9), black: blk.length,
      worstSigma: Math.max(...sr.map((x) => x.sigmaRel)),
      meanSigma: mean(sr.map((x) => x.sigmaRel)),
      surfaces: sr,
    };
  };
  /**
   * ⭐ §19 5.3e — THE σ OF WHAT AN ARM REMOVED, per surface, normalised by the
   * SAME reference mean `sigmaRel` uses.
   *
   * `sigmaRel` scores an arm's residual against the reference, which for a
   * TERM MASK is the wrong question — a direct-only arm is missing the whole
   * bounce field and its residual is dominated by that absence. What names the
   * blotch carrier is the structure of the term the mask DELETED:
   * `σ(E_baseline − E_arm)`, which for `rcTermDirect:0` is exactly σ of the
   * analytic direct term and for `rcTermField:0` exactly σ of the cascade
   * field. Their quadrature sum against the baseline's own σ is the check that
   * the split is complete.
   */
  const deltaSigma = (Enew) => {
    const out = [];
    const bs = new Map();
    rows.forEach((r, i) => {
      if (r.emitFace) return;
      if (!bs.has(r.surf)) bs.set(r.surf, []);
      bs.get(r.surf).push({ ...r, d: lum(r.E) - lum(Enew[i]) });
    });
    for (const [name, list] of bs) {
      if (name === "unclassified" || list.length < 24) continue;
      const quiet = list.filter((r) => r.noise < 0.02 && lum(r.ref) > LIT);
      if (quiet.length <= 8) continue;
      const d = quiet.map((r) => r.d);
      const md = mean(d);
      const mr = mean(list.map((r) => lum(r.ref)));
      out.push({
        name,
        sigmaRel: Math.sqrt(mean(d.map((v) => (v - md) ** 2))) / Math.max(1e-9, mr),
        meanRel: md / Math.max(1e-9, mr),
      });
    }
    return out;
  };
  const base = rescore(rows.map((r) => r.E));
  console.log("");
  console.log("  ── THE UNIFORM ARMS (one boot, one pose, one reference) ─────────────");
  console.log("  arm                          med|log|   p90    black   σ̄/mean  σmax/mean   chain ms");
  const baseProf = ARM_MS > 0 ? await call("profile.gi2", { kernelSamples: ARM_MS }) : { ok: false };
  const armRows = [{ name: "baseline (as shipped)", ...base, ms: baseProf.ok ? (baseProf.value?.kernelTotalMs ?? NaN) : NaN }];
  const show = (r) => console.log(
    `  ${r.name.padEnd(28)} ${f(r.med).padStart(7)} ${f(r.p90).padStart(7)} ${String(r.black).padStart(7)}  ` +
    `${pct(r.meanSigma).padStart(8)} ${pct(r.worstSigma).padStart(9)}  ${f(r.ms, 2).padStart(8)}`);
  show(armRows[0]);
  for (const arm of ARMS) {
    const set = await page.evaluate(async ({ arm, ARM_FRAMES }) => {
      const gi2 = globalThis.__gi2();
      // §19 5.3e — the RC resolve's own uniforms (`rcTermField`/`rcTermDirect`,
      // `rcKeep`, the cadence) live on `gi2.rc`, not on the gather. An arm that
      // names one of those must reach it or the split is two boots.
      const u = { ...(gi2.rc?.uniforms ?? {}), ...gi2.gather.uniforms };
      const before = {};
      for (const [k, v] of Object.entries(arm.set)) {
        if (!u[k]) return { error: `no uniform ${k}` };
        before[k] = u[k].value;
        u[k].value = v;
      }
      return { ok: true, before };
    }, { arm, ARM_FRAMES });
    if (set.error) { console.log(`  ${arm.name.padEnd(28)} SKIPPED — ${set.error}`); continue; }
    await settleFrames(ARM_FRAMES);
    const AJ = await page.evaluate(async ({ TARGET }) => {
      try {
        const eng = globalThis.__giEngineForProbe;
        const sys = globalThis.__giSys();
        const gi2 = globalThis.__gi2();
        const { createGi2PixelDump, GI2_PIXEL_OUT_VEC } = await import("/scripts/lib/gi2PixelDump.js");
        const stride = Math.max(1, Math.round(gi2.width / TARGET));
        const dump = createGi2PixelDump({ renderer: eng.renderer, gi2, screen: sys.state?.screen, stride });
        const awaitFrame = () => new Promise((r) => { const off = eng.onPostRender(() => { off(); r(); }); });
        const d = await dump.read(awaitFrame);
        const OV = GI2_PIXEL_OUT_VEC;
        const out = [];
        for (let y = 0; y < dump.dumpH; y++) {
          for (let x = 0; x < dump.dumpW; x++) {
            const b = (y * dump.dumpW + x) * OV * 4;
            if (d[b + 3] < 0.5) continue;
            out.push(d[b], d[b + 1], d[b + 2], d[b + 8], d[b + 9], d[b + 10]);
          }
        }
        return JSON.stringify({ out, witness: d.witness, attempts: d.attempts });
      } catch (e) { return JSON.stringify({ error: `${e?.message}` }); }
    }, { TARGET });
    const A = JSON.parse(AJ ?? '{"error":"nothing"}');
    if (A.error) { console.log(`  ${arm.name.padEnd(28)} SKIPPED — ${A.error}`); continue; }
    if (A.out.length / 6 !== rows.length) {
      console.log(`  ${arm.name.padEnd(28)} SKIPPED — ${A.out.length / 6} px against the baseline's ${rows.length}`);
      continue;
    }
    let moved = 0;
    const Enew = [];
    for (let i = 0; i < rows.length; i++) {
      const b = i * 6;
      if (Math.abs(A.out[b] - rows[i].p[0]) > 2e-3 || Math.abs(A.out[b + 1] - rows[i].p[1]) > 2e-3
        || Math.abs(A.out[b + 2] - rows[i].p[2]) > 2e-3) moved++;
      Enew.push([A.out[b + 3], A.out[b + 4], A.out[b + 5]]);
    }
    if (moved > rows.length * 0.01) {
      console.log(`  ${arm.name.padEnd(28)} SKIPPED — ${moved} pixels moved; the pose is not parked`);
      continue;
    }
    // The CHAIN's GPU cost, from the shipping receipt (`profile.gi2`'s
    // `kernelTotalMs`) rather than from a wall clock: the arms differ by a few
    // hundred microseconds and only a timestamp query can see that.
    const prof = ARM_MS > 0 ? await call("profile.gi2", { kernelSamples: ARM_MS }) : { ok: false };
    const ms = prof.ok ? (prof.value?.kernelTotalMs ?? NaN) : NaN;
    const r = { name: arm.name, ...rescore(Enew), ms, delta: deltaSigma(Enew) };
    armRows.push(r);
    show(r);
  }
  console.log("");
  console.log("  per-surface σ(TERM REMOVED)/refmean  [what the mask deleted]");
  {
    const dn = [...new Set(armRows.flatMap((a) => (a.delta ?? []).map((s2) => s2.name)))];
    const cols = armRows.filter((a) => a.delta);
    if (cols.length) {
      console.log(`  ${"surface".padEnd(16)}${cols.map((a) => a.name.slice(0, 13).padStart(15)).join("")}`);
      for (const n of dn) {
        console.log(`  ${n.padEnd(16)}` + cols.map((a) => {
          const s2 = a.delta.find((x) => x.name === n);
          return (s2 ? `${pct(s2.sigmaRel)}/${pct(s2.meanRel)}` : "—").padStart(15);
        }).join(""));
      }
      console.log("");
    }
  }
  console.log("  per-surface σ(residual)/mean by arm");
  const names = [...new Set(armRows.flatMap((a) => a.surfaces.map((s) => s.name)))];
  console.log(`  ${"surface".padEnd(16)}${armRows.map((a) => a.name.slice(0, 13).padStart(15)).join("")}`);
  for (const n of names) {
    console.log(`  ${n.padEnd(16)}` + armRows.map((a) => {
      const s = a.surfaces.find((x) => x.name === n);
      return (s ? pct(s.sigmaRel) : "—").padStart(15);
    }).join(""));
  }
  result.arms = armRows;
}


// ══════════════════════ §19 5.4d — WHAT A KNOWN BIN CARRIES (`FACETRUTH=1`) ══
//
// ⭐⭐⭐ THE SINGLE-BOUNCE ARM PUT THE LOSS IN `J`, AND `J` IS ONE NUMBER: the
// face cache's DIRECT word at the hit, `ρ/π·(Esun + Enee)`. Everything else in
// the one-bounce field is transport of that number. So this block reads the
// SHIPPING estimator at the voxel faces the camera can see (`shadeTerms`, via
// `gi2FaceTermProbe` — not a transcription of it) and scores each face against
// the reference's OWN next-event estimator at the same point:
//
//     truth(p, n) = neeE(p, n)   ← `makeSceneTracer(scene, 0).irradiance`: the
//                                  emissive triangles, area-sampled and
//                                  occlusion-tested against the real mesh.
//
// `Enee` and `truth` are the same physical quantity — irradiance at (p, n) from
// the admitted emitters — computed by two independent programs, so their ratio
// is the direct term's own gain with no transport, no probes and no cascades in
// it. Grouped by DISTANCE TO THE LAMP, because the ladder the gate measures is
// ordered by how far a surface's light has to travel.
if (process.env.FACETRUTH) {
  console.log("");
  console.log("  ── §19 5.4d — THE FACE CACHE'S DIRECT TERM vs THE REFERENCE'S NEE ───");
  const FJ = await page.evaluate(async ({ eye, aim }) => {
    try {
      const eng = globalThis.__giEngineForProbe;
      const gi2 = globalThis.__gi2();
      if (!gi2?.gather?.internals) return JSON.stringify({ error: "no gather internals" });
      const ws = await import("/src/modules/gi/window/windowStore.js");
      const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
      const { createGi2FaceTermProbe } = await import("/scripts/lib/gi2FaceTermProbe.js");
      const terms = createGi2FaceTermProbe(gi2, eng.renderer);
      const v0 = gi2.win.voxel0;
      const NRM = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      const winW = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
      const lvlBase = (l) => l * ws.LEVEL_WORDS;
      const occAt = (l, x, y, z) => {
        const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12);
        return (winW[lvlBase(l) + ws.OCC_OFF + (i >> 5)] >>> (i & 31)) & 1;
      };
      const faceByte = (l, x, y, z) => {
        const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12);
        return (winW[lvlBase(l) + ws.FACE_OFF + (i >> 2)] >>> ((i & 3) * 8)) & 255;
      };
      // ⭐⭐⭐ THE POPULATION IS THE OCCUPANCY, NOT A CAMERA FAN. `probe:gi2-
      // faceterm` enumerates the wall from the window's own bits and never
      // shoots a ray; 5.4d's two dead runs were both the shooter, and the whole
      // question — what does a face's DIRECT term carry, near the lamp and far
      // from it — is about faces, not about what the camera can see.
      //
      // ⚠ THE BUFFER INDEX IS TOROIDAL, SO THE WORLD CELL MUST BE UNWRAPPED.
      // The lattice stores `worldCell & 63` and the window covers
      // `[origin, origin + 64)`, so the world cell is the one congruent to the
      // index inside that span. Skipping this puts every face at a position up
      // to 64 cells wrong and scores the reference at the wrong point.
      const unwrap = (idx, org) => org + (((idx - org) % 64) + 64) % 64;
      const seen = new Map();
      const levelCensus = [0, 0, 0, 0, 0, 0, 0, 0];
      let occTotal = 0;
      for (let l = 0; l < gi2.win.levels; l++) {
        const vl = v0 * (1 << l);
        const ox = gi2.win.origins[l * 3];
        const oy = gi2.win.origins[l * 3 + 1];
        const oz = gi2.win.origins[l * 3 + 2];
        for (let z = 0; z < 64; z++) {
          for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
              if (!occAt(l, x, y, z)) continue;
              occTotal++;
              // The voxel's own dominant axis (§19 3.9's rule) and the SIDE
              // whose outward neighbour is empty — that side faces the room.
              const code = (faceByte(l, x, y, z) >>> 6) & 3;
              if (!code) continue;
              const ax = code - 1;
              const e = [0, 0, 0]; e[ax] = 1;
              const occP = occAt(l, x + e[0], y + e[1], z + e[2]);
              const occN = occAt(l, x - e[0], y - e[1], z - e[2]);
              let face = -1;
              if (!occP && occN) face = 2 * ax;
              else if (!occN && occP) face = 2 * ax + 1;
              else continue; // interior or isolated — no side faces the room
              levelCensus[Math.min(7, l)]++;
              const wc = [unwrap(x, ox), unwrap(y, oy), unwrap(z, oz)];
              const n = NRM[face];
              seen.set(`${l}|${wc}|${face}`, {
                p: [(wc[0] + 0.5) * vl + n[0] * vl * 0.5,
                  (wc[1] + 0.5) * vl + n[1] * vl * 0.5,
                  (wc[2] + 0.5) * vl + n[2] * vl * 0.5],
                n, level: l, voxelIdx: (x & 63) | ((y & 63) << 6) | ((z & 63) << 12), face,
              });
            }
          }
        }
      }
      const rejCell = occTotal;
      const rejFace = 0;
      const hits = { length: occTotal };
      // Evenly SUBSAMPLED, never truncated: taking the first 600 of a map
      // built by a z-major scan would take one slab of the room and call it the
      // scene. [[probe-blind-statistics]]
      const allFaces = [...seen.values()];
      const step = Math.max(1, Math.ceil(allFaces.length / 600));
      const faces = allFaces.filter((_, i) => i % step === 0).slice(0, 600);
      const res = await terms(faces);
      return JSON.stringify({
        faces, out: res.faces ?? res, diag: res.diag ?? null,
        census: { occupied: occTotal, levels: levelCensus, kept: seen.size, sampled: faces.length },
      });
    } catch (e) { return JSON.stringify({ error: `${e && e.message}` }); }
  }, { eye, aim });
  const F = JSON.parse(FJ ?? '{"error":"nothing"}');
  if (F.error) console.log(`  SKIPPED — ${F.error}`);
  else {
    // ⚠ THE TRUTH IS THE REFERENCE'S OWN NEE, AT ZERO BOUNCES. `Lo` returns
    // immediately at depth 0 when `bounces` is 0, so `irradiance` is exactly
    // `neeE(p, n)`. Nothing about the cascades enters it.
    const direct = makeSceneTracer(
      { tris: R.scene.tri, triMat: R.scene.triMat, mats: R.scene.mats, sky: [0, 0, 0] }, 0,
    );
    const lamp = (R.slots.find((s) => s.radius > 1e-5) || {}).center || [0, 0, 0];
    const rows = [];
    for (let i = 0; i < F.faces.length; i++) {
      const fc = F.faces[i];
      const o = F.out[i];
      if (!o) continue;
      const nee = o.Enee || o.enee || null;
      if (!nee) continue;
      const truth = direct.irradiance(fc.p, fc.n, 1, 12345 + i, 256);
      const d = Math.hypot(fc.p[0] - lamp[0], fc.p[1] - lamp[1], fc.p[2] - lamp[2]);
      rows.push({
        d, gpu: lum(nee), ref: lum(truth), level: fc.level, face: fc.face,
        stored: lum(o.stored || [0, 0, 0]), storedValid: o.storedValid || 0,
        erc: lum(o.Erc || [0, 0, 0]), ercValid: o.ercValid ?? -1,
        field: lum(o.Efield || [0, 0, 0]), fieldValid: o.fieldValid ?? 0,
      });
    }
    const lit = rows.filter((r) => r.ref > 1e-4);
    // ⚠ THE POPULATION IS PRINTED BEFORE THE TABLE, ALWAYS. 5.4d's first cut
    // rejected every hit and printed an all-zero table under a "0 faces" line;
    // the line is what made that legible as a miss instead of a measurement.
    const c = F.census || {};
    console.log(`  occupied voxels ${c.occupied ?? "—"} · room-facing by level `
      + `[${(c.levels ?? []).join(",")}] · kept ${c.kept ?? "—"} · sampled ${c.sampled ?? "—"}`);
    console.log(`  ${lit.length} faces of ${rows.length} with a lit reference   `
      + `(lamp at [${lamp.map((v) => v.toFixed(2))}])`);
    const bands = [[0, 1.5], [1.5, 2.5], [2.5, 3.5], [3.5, 5], [5, 99]];
    console.log(`  ${"distance to lamp".padEnd(20)}${"faces".padStart(7)}${"Enee(gpu)".padStart(12)}`
      + `${"E_direct(ref)".padStart(15)}${"ratio".padStart(9)}${"cached word".padStart(13)}`);
    for (const [lo, hi] of bands) {
      const b = lit.filter((r) => r.d >= lo && r.d < hi);
      if (!b.length) continue;
      const mg = b.reduce((a, r) => a + r.gpu, 0) / b.length;
      const mr = b.reduce((a, r) => a + r.ref, 0) / b.length;
      const mc = b.reduce((a, r) => a + r.stored, 0) / b.length;
      console.log(`  ${`${lo}-${hi} m`.padEnd(20)}${String(b.length).padStart(7)}`
        + `${f(mg, 4).padStart(12)}${f(mr, 4).padStart(15)}`
        + `${f(mg / Math.max(1e-9, mr), 3).padStart(9)}${f(mc, 4).padStart(13)}`);
    }
    const all = lit.reduce((a, r) => a + r.gpu, 0) / Math.max(1, lit.length);
    const allr = lit.reduce((a, r) => a + r.ref, 0) / Math.max(1, lit.length);
    console.log(`  ${"ALL".padEnd(20)}${String(lit.length).padStart(7)}${f(all, 4).padStart(12)}`
      + `${f(allr, 4).padStart(15)}${f(all / Math.max(1e-9, allr), 3).padStart(9)}`);
    // ⭐ AND BY CASCADE BAND, because the ladder the gate measures is ordered by
    // how far a surface's light travels and the BAND is what "far" means to this
    // transport: a level `l` face is `v0·2^l` across and is answered by cascade
    // `l`'s interval. A term that degrades with the band is a different bug from
    // one that degrades with distance.
    // By ORIENTATION: a floor face (+Y) sees the lamp straight on, a ceiling
    // face (−Y) sees it edge-on, and the vertical faces are the walls and the
    // boxes. If the direct term degrades with geometry rather than with
    // distance, this is the table that says so.
    const FN = ["+X wall", "-X wall", "+Y floor", "-Y ceiling", "+Z wall", "-Z wall"];
    console.log("");
    console.log(`  ${"orientation".padEnd(20)}${"faces".padStart(7)}${"Enee/ref".padStart(12)}`
      + `${"stored/ref".padStart(13)}`);
    for (let fi = 0; fi < 6; fi++) {
      const b = lit.filter((r) => r.face === fi);
      if (!b.length) continue;
      const mg = b.reduce((a2, r) => a2 + r.gpu, 0) / b.length;
      const mr = b.reduce((a2, r) => a2 + r.ref, 0) / b.length;
      const mc = b.reduce((a2, r) => a2 + r.stored, 0) / b.length;
      console.log(`  ${FN[fi].padEnd(20)}${String(b.length).padStart(7)}`
        + `${f(mg / Math.max(1e-9, mr), 3).padStart(12)}`
        + `${f(mc / Math.max(1e-9, mr), 3).padStart(13)}`);
    }
    // ⭐⭐ HOP (b): the loop's return edge, at the faces themselves. `E_rc` is
    // the word [J] multiplies by ρ/π; `field` is what the merged cascades say at
    // the SAME point and normal. `rcHit`'s refresh writes the second into the
    // first, so their ratio is the cadence and the write — and 1.00 moves the
    // question to what the field carries, not to how it is stored.
    const withF = lit.filter((r) => r.fieldValid > 0.5);
    if (withF.length) {
      const me = withF.reduce((a2, r) => a2 + r.erc, 0) / withF.length;
      const mf = withF.reduce((a2, r) => a2 + r.field, 0) / withF.length;
      console.log("");
      console.log(`  hop (b)  E_rc word ${f(me, 4)} · field at the same face ${f(mf, 4)}`
        + ` · E_rc/field ${f(me / Math.max(1e-9, mf), 3)}  over ${withF.length} faces`);
      for (let l = 0; l < 4; l++) {
        const b = withF.filter((r) => r.level === l);
        if (!b.length) continue;
        const e2 = b.reduce((a2, r) => a2 + r.erc, 0) / b.length;
        const f2 = b.reduce((a2, r) => a2 + r.field, 0) / b.length;
        console.log(`    c${l}  ${String(b.length).padStart(4)} faces  E_rc ${f(e2, 4)}`
          + `  field ${f(f2, 4)}  ratio ${f(e2 / Math.max(1e-9, f2), 3)}`);
      }
    } else {
      console.log("");
      console.log("  hop (b) UNAVAILABLE — the probe rig published no field read"
        + " (pre-5.1 chain or the world-probe arm); reporting nothing rather than a zero.");
    }
    console.log("");
    console.log(`  ${"cascade band".padEnd(20)}${"faces".padStart(7)}${"Enee/ref".padStart(12)}`
      + `${"stored/ref".padStart(13)}${"written".padStart(10)}`);
    for (let l = 0; l < 8; l++) {
      const b = lit.filter((r) => r.level === l);
      if (!b.length) continue;
      const mg = b.reduce((a2, r) => a2 + r.gpu, 0) / b.length;
      const mr = b.reduce((a2, r) => a2 + r.ref, 0) / b.length;
      const mc = b.reduce((a2, r) => a2 + r.stored, 0) / b.length;
      const wv = b.filter((r) => r.storedValid > 0.5).length;
      console.log(`  ${`c${l}`.padEnd(20)}${String(b.length).padStart(7)}`
        + `${f(mg / Math.max(1e-9, mr), 3).padStart(12)}`
        + `${f(mc / Math.max(1e-9, mr), 3).padStart(13)}`
        + `${`${wv}/${b.length}`.padStart(10)}`);
    }
    result.faceTruth = { rows: rows.length, lit: lit.length, ratio: all / Math.max(1e-9, allr) };
  }
}

if (OUT) { writeFileSync(OUT, JSON.stringify(result, null, 1)); console.log(`  wrote ${OUT}`); }
if (REF && existsSync(REF)) {
  const before = JSON.parse(readFileSync(REF, "utf8"));
  console.log("");
  console.log("  ── BEFORE → AFTER ───────────────────────────────────────────────────");
  console.log(`  median |log ratio|   ${f(before.medLg)} → ${f(medLg)}`);
  console.log(`  p90 |log ratio|      ${f(before.p90Lg)} → ${f(p90Lg)}`);
  console.log(`  black pixels         ${before.black} → ${black.length}`);
  console.log(`  gate                 ${before.passed}/${before.checks.length} → ${passed}/${checks.length}`);
  const bs = new Map(before.surfaces.map((s) => [s.name, s]));
  console.log("  surface               ratio          σ/mean          d²@0.25       black");
  for (const s of surfRows) {
    const b = bs.get(s.name);
    if (!b) continue;
    console.log(`  ${s.name.padEnd(20)} ${f(b.ratio, 2)} → ${f(s.ratio, 2)}   ` +
      `${pct(b.sigmaRel)} → ${pct(s.sigmaRel)}   ${f(b.d2_25, 4)} → ${f(s.d2_25, 4)}   ${b.black} → ${s.black}`);
  }
}


// ══ §19 6.10 — THE ERROR MAPS (`MAPS=<dir>`) ═════════════════════════════════
// Two PNGs from the SAME per-pixel rows the gate scored, so a picture of the
// error can be put next to the user's photo: `err.png` = signed log(E/ref)
// (red = ours brighter, blue = ours darker, ±0.7 saturates; black = unscored),
// `green.png` = G/(R+G+B) ours − truth (green = ours greener, magenta = ours
// redder, ±0.08 saturates). Plus the strip census the photo asks about.
if (process.env.MAPS) {
  const { deflateSync } = await import("node:zlib");
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const png = (w, h, rgb) => {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  };
  const xs = rows.map((q) => q.x), ys = rows.map((q) => q.y);
  const st = R.stride || 1;
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const gw = Math.floor((Math.max(...xs) - x0) / st) + 1, gh = Math.floor((Math.max(...ys) - y0) / st) + 1;
  const UP = 4; const W = gw * UP, H = gh * UP;
  const errImg = Buffer.alloc(W * H * 3), grnImg = Buffer.alloc(W * H * 3);
  const put = (img, gx, gy, r, g, b) => { for (let dy = 0; dy < UP; dy++) for (let dx = 0; dx < UP; dx++) { const o = ((gy * UP + dy) * W + gx * UP + dx) * 3; img[o] = r; img[o + 1] = g; img[o + 2] = b; } };
  const gf = (e) => { const s = e[0] + e[1] + e[2]; return s > 1e-9 ? e[1] / s : 0; };
  const strip = [], ceilCentre = [], floorCentre = [], shadowish = [];
  const REDX = -2.5 + 0.3816651532689147;
  for (const q of rows) {
    const gx = Math.round((q.x - x0) / st), gy = Math.round((q.y - y0) / st);
    if (!q.ref || q.emitFace || !(lum(q.ref) > 1e-6) || !(lum(q.E) > 0)) { put(errImg, gx, gy, 0, 0, 0); put(grnImg, gx, gy, 0, 0, 0); continue; }
    const lg = Math.log(lum(q.E) / lum(q.ref));
    const t = Math.max(-1, Math.min(1, lg / 0.7));
    put(errImg, gx, gy, Math.round(128 + 127 * Math.max(0, t) - 100 * Math.max(0, -t)), Math.round(128 - 100 * Math.abs(t)), Math.round(128 + 127 * Math.max(0, -t) - 100 * Math.max(0, t)));
    const dg = gf(q.E) - gf(q.ref);
    const u = Math.max(-1, Math.min(1, dg / 0.08));
    put(grnImg, gx, gy, Math.round(128 + 127 * Math.max(0, -u) - 110 * Math.max(0, u)), Math.round(128 + 127 * Math.max(0, u) - 110 * Math.max(0, -u)), Math.round(128 - 110 * Math.abs(u) + 60 * Math.max(0, -u)));
    const white = /floor|ceil/i.test(q.surf);
    const row = { lg, dg, surf: q.surf, p: q.p };
    if (white && q.p[0] < REDX + 0.5) strip.push(row);
    else if (/ceil/i.test(q.surf) && Math.abs(q.p[0] - 0.38) < 1 && Math.abs(q.p[2]) < 1) ceilCentre.push(row);
    else if (/floor/i.test(q.surf) && Math.abs(q.p[0] - 0.38) < 1 && Math.abs(q.p[2]) < 1) floorCentre.push(row);
    if (lum(q.ref) < 0.25 * irrP50 && lum(q.E) > 2 * lum(q.ref)) shadowish.push(row);
  }
  mkdirSync(process.env.MAPS, { recursive: true });
  writeFileSync(path.join(process.env.MAPS, "err.png"), png(W, H, errImg));
  writeFileSync(path.join(process.env.MAPS, "green.png"), png(W, H, grnImg));
  const med = (a, k) => quantile(a.map((r) => r[k]), 0.5);
  const medAbs = (a, k) => quantile(a.map((r) => Math.abs(r[k])), 0.5);
  const line = (name, a) => console.log(`  ${name.padEnd(34)} n ${String(a.length).padStart(5)}  |log| med ${f(medAbs(a, "lg"))}  signed log med ${f(med(a, "lg"))}  Δgreen med ${f(med(a, "dg"), 4)}  Δgreen p90 ${f(quantile(a.map((r) => r.dg), 0.9), 4)}`);
  console.log(`\n  ── §19 6.10 error maps → ${process.env.MAPS} (${W}x${H}, grid ${gw}x${gh}, stride ${st}) ──`);
  line("white strip ≤0.5 m from red wall", strip);
  line("ceiling centre", ceilCentre);
  line("floor centre", floorCentre);
  line("ref dark (<¼ p50) & ours >2× ref", shadowish);
  const bySurfStrip = new Map(); for (const r of strip) bySurfStrip.set(r.surf, [...(bySurfStrip.get(r.surf) ?? []), r]);
  for (const [s, a] of bySurfStrip) line(`  strip · ${s}`, a);
  const worst = [...rows].filter((q) => q.ref && !q.emitFace && lum(q.ref) > 1e-6 && lum(q.E) > 0).map((q) => ({ surf: q.surf, p: q.p.map((v) => +v.toFixed(2)), lg: Math.log(lum(q.E) / lum(q.ref)) })).sort((a, b) => Math.abs(b.lg) - Math.abs(a.lg)).slice(0, 12);
  console.log("  worst 12 pixels: " + worst.map((w) => `${w.surf}@[${w.p}] ${w.lg > 0 ? "+" : ""}${w.lg.toFixed(2)}`).join("; "));
}

await browser.close();
process.exit(passed === checks.length ? 0 : 1);
