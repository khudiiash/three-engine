// PAIRED C0-vs-C1 GATHER PROBE (§12.86) — the within-boot dial.
//
// ══ WHY THIS EXISTS AND `probe:gi-walk` COULD NOT ANSWER IT ════════════════
//
// The question is whether §13.9's smoothed trilinear weights (`3t²−2t³`, C1
// across cell faces) remove the cell-shaped structure the user reports as
// "blockiness ... when we transite from one voxel grid to another". Three
// separate instrument failures blocked the cross-boot answer, all recorded:
//
//   1. `checker` is a mean FIRST difference, and total variation across a cell
//      is a property of the ENDPOINTS. A linear ramp and a smoothstep ramp from
//      L0 to L1 have the SAME Σ|ΔL|, so `checker` is BLIND to an interpolant
//      order change by construction. Measured: nosmooth 0.0724/0.0117 vs base
//      0.0649/0.0116 — inside the repeat spread.
//   2. The SECOND difference is the right quantity (a crease is a gradient
//      step) but on a whole-frame crop its p99 is dominated by ALBEDO and
//      GEOMETRY edges — a doorway's border outweighs every lighting crease in
//      the frame. Measured: p99 1.73 vs 1.77, i.e. nothing.
//   3. This scene's boot-to-boot spread is ~2× (plan §15 U2's method rule:
//      "N≥4 boots per arm with medians+spread, or a within-boot dial").
//
// So: ONE boot, ONE pose, ONE converged field, and the arm flipped as a live
// UNIFORM between captures (`__giGatherSmoothLive`, srcScreenGather's
// `smoothU`). Everything that is not the interpolant — probe population, bin
// contents, tile atlas, GPU clock, sun, character pose, camera — is IDENTICAL
// between A and B, because it is literally the same frame sequence. The
// comparison is then a PAIRED IMAGE DIFFERENCE, which needs no summary
// statistic to be believed and no boot-variance envelope to be defended.
//
// ══ WHAT IT REPORTS ════════════════════════════════════════════════════════
//
//   delta       mean |A−B| / mean L — how much of the picture the arm moves at
//               all. ~0 means the flip is inert HERE (not that it is inert).
//   creaseFlat  the second difference restricted to LOW-GRADIENT pixels, i.e.
//               with albedo/geometry edges excluded by a first-difference mask.
//               This is the statistic failure (2) above asks for.
//   A/B/diff    PNGs of the RENDERER CANVAS ONLY (never `page.screenshot`,
//               which captures the whole editor and is ~60% chrome).
//
// A/B/A/B alternation, N rounds, medians reported — a monotone drift in the
// field (still converging) would otherwise be credited to whichever arm ran
// second.
//
//   node scripts/run-gi-gather-smooth-paired.mjs [url]
// Env:
//   PROJECT=C:/Users/Khudiiash/Documents/GAME   SCENE=scenes/Level.scene
//   QUALITY=high   SETTLE=25000   ROUNDS=3   HOLD=1200   PNG=1
//   POSE=px,py,pz,tx,ty,tz   (repeatable: POSE2=..., POSE3=...)
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = `${PROJECT}/${process.env.SCENE ?? "scenes/Level.scene"}`;
const QUALITY = process.env.QUALITY ?? "high";
/**
 * Which dial this run sweeps.
 *
 *   `smooth`  the C0/C1 gather weights — the question this probe was built for,
 *             refuted 2026-08-23 at a crease ratio of 1.001.
 *   `bias`    §12.88's NORMAL BIAS, the thin-wall leak arm and the default now.
 *
 * The bias is geometric rather than heuristic, which is why it is worth a
 * sweep: the far trilinear corner reaches `s0 − β` BEHIND the shaded face, so
 * the leak through a wall of thickness `w` is exactly ZERO once `β > s0 − w`.
 * On the user's Level that is 0.45 − 0.25 = **0.20 m**, and 0.6·s0 = 0.27 m
 * holds it at every lattice phase. The levels bracket that threshold on both
 * sides on purpose: 0.10 should still leak, 0.20 should be marginal, 0.27
 * should not leak at all. A sweep that does NOT show a step near 0.20 refutes
 * the geometry, which is the point of measuring rather than arguing.
 *
 * Swept as a LIVE UNIFORM because this scene's boot-to-boot spread is ~2×, so
 * cross-boot arms cannot resolve an effect this size.
 */
const DIAL = process.env.DIAL ?? "bias";
/**
 * BUILD-TIME transport overrides, for the 2026-08-24 "mud" question.
 *
 * `SPACING0` pins the SRC gather lattice outright (`__giSrcSpacing0`, which
 * outranks both the scene rule and the tier). It is the ONE lever that changes
 * the indirect's SPATIAL resolution, and the profile argues it is the binding
 * one: at rest the user's Level holds ~780 c0 probes, which is about the count
 * of 0.35 m cells their visible surfaces occupy — lattice-limited, not
 * budget-limited (a 50% ray-budget lift left the population bit-identical).
 *
 * `RAYCAP` pins `__giSrcProbeRayCap`. LOWERING it spends the same budget on more
 * probes; every cap experiment ever run in this repo raised it, and all of them
 * were inert anyway because their arm names ended in a digit.
 *
 * ⚠ Both are BUILD decisions — they must be set before the page boots, and the
 * A/B is therefore CROSS-BOOT, which this scene's ~2x spread makes unreliable
 * for small effects. Use them for the PICTURE (`PNG=1` + a per-run `OUT`), not
 * for a few-percent statistic.
 */
const SPACING0 = Number(process.env.SPACING0) || 0;
const RAYCAP = Number(process.env.RAYCAP) || 0;
/**
 * `EMITSCALE` pins `__giEmitterShadowScale` — the 2026-08-24 "mud" lead.
 *
 * The emitter shadow pack is `scale × the HALF-RES shadow buffer`, so the
 * shipped 0.85 puts it at **42.5% of resolve** (measured on the user's Level:
 * resolve 1647×972, emitterShadow 700×413). It is the only heavily
 * under-sampled screen channel they have — the light-shadow chain is not
 * dispatched at all on that scene — and their lighting is substantially
 * EMITTER lighting (16 emitters, several saturated: rgb 0/5/0, 0/2/5).
 *
 * Why this arm and not another: the user's three observations are muddy at
 * distance, **instantly** sharp on approach, and clean after seconds of
 * standing still. "Instantly" rules out anything temporal and points at a
 * screen-space FOOTPRINT, which is what this scales.
 * [[gi-emitter-penumbra-camera-dependence]] already records the mechanism as
 * known and NOT fixed: "a shadow a few texels wide is destroyed by the ±2
 * bilateral that follows it — a binary signal does not survive undersampling."
 */
const EMITSCALE = Number(process.env.EMITSCALE) || 0;
/** `KEEPTONE=1` leaves the scene's own tone mapping alone — see instrument
 *  failure #10 below. Required for any capture a human will judge. */
const KEEPTONE = process.env.KEEPTONE === "1";
/** `IRREPS` pins `__giIrrValidEps` — the irradiance temporal pass's reprojection
 *  tolerance in METRES (shipped: voxMax ~0.22). Build-time. */
const IRREPS = Number(process.env.IRREPS) || 0;
/** `VERBOSE=1` echoes every `[gi]` console line — the first thing to reach for
 *  when a boot does not reach `field ready` and the filtered log is silent. */
const VERBOSE = process.env.VERBOSE === "1";
/** How long to wait for `[gi] field ready`. A boot that misses it is NOT a slow
 *  boot to be measured anyway: the statistics below normalise by frame luma. */
const READY_MS = Number(process.env.READY_MS ?? 240000);
const LEVELS = (process.env.LEVELS ?? (DIAL === "bias" ? "0,0.10,0.20,0.27" : DIAL === "los" ? "0,0.5,1" : "0,1"))
  .split(",").map(Number);
/**
 * §12.89's LOS suppression strength, live. ⚠ The march itself is a BUILD
 * decision (`__giGatherLosWeight === true` before boot, set below), so this
 * sweeps only how much of it is applied — 0 is the unguarded baseline WITH the
 * march's cost still paid, which prices the guard and its effect separately.
 */
const setLos = async (v) => page.evaluate((x) => { globalThis.__giGatherLosLive = x; }, v);

const SETTLE = Number(process.env.SETTLE ?? 25000);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
// Frames to hold after flipping the dial. The gather feeds §12.65's temporal
// filter, so the flip needs to propagate through it before the picture is the
// arm's own answer rather than a blend of both.
const HOLD = Number(process.env.HOLD ?? 1200);
const wantPng = process.env.PNG !== "0";
const OUT = process.env.OUT ?? ".gi-shots/gather-smooth";
mkdirSync(OUT, { recursive: true });

/**
 * Poses. Defaults aim INTO a room from its threshold — the user's own
 * condition ("camera moves from one room into the other") and the framing of
 * their 2026-08-23 screenshots. Deliberately NOT a leg endpoint of
 * `probe:gi-walk`: those park the camera ~0.5 m off a wall with the viewport
 * background filling a third of the crop.
 */
const POSES = [];
for (const key of ["POSE", "POSE2", "POSE3", "POSE4"]) {
  const raw = process.env[key];
  if (raw) POSES.push(raw.split(",").map(Number));
}
if (!POSES.length) {
  POSES.push(
    [-8, 1.7, 5.5, -8, 1.6, -3],     // west room, looking down its long axis
    [-0.3, 1.7, 2.0, -7.5, 1.5, 0],  // centre → west doorway, into the dark room
    [-0.3, 1.7, -2.0, -0.3, 1.6, 6], // centre corridor, looking along it
  );
}

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  protocolTimeout: 900_000,
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});

const t0 = Date.now();
const context = await browser.createBrowserContext();
const page = await context.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
const errors = [];
let markReady = null, readyAfter = Infinity;
let latticeReceipt = null;
const fieldReady = new Promise((r) => { markReady = r; });
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] field ready:/.test(t) && Date.now() >= readyAfter) markReady?.(t.slice(0, 80));
  if (/adaptive gather lattice/.test(t)) latticeReceipt = t;
  if (/§\d|ARMED|: OFF \(/.test(t) || (VERBOSE && /\[gi\]/.test(t))) {
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s ${t.slice(0, 220)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = String(e.message ?? e);
  if (!/save_scene/.test(msg)) errors.push(msg.slice(0, 200));
});

await installTauriShim(page, {});
await page.evaluateOnNewDocument((project, quality, dial, spacing0, rayCap, emitScale, irrEps) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  globalThis.__giConfigOverride = { quality };
  // §12.89: the LOS march is compiled in or out at BUILD time, so a `los` sweep
  // has to arm it before the page boots and vary only its STRENGTH afterwards.
  // ⚠ This ARMS A GUARD THE USER REVERTED ON THEIR OWN EYES (2026-08-22). It is
  // armed HERE, in a probe, and nowhere else — measuring it is not shipping it,
  // and the standing rule is that a re-flip needs their explicit go-ahead, one
  // at a time, judged on their Level.
  if (dial === "los") globalThis.__giGatherLosWeight = true;
  if (spacing0 > 0) globalThis.__giSrcSpacing0 = spacing0;
  if (rayCap > 0) globalThis.__giSrcProbeRayCap = rayCap;
  if (emitScale > 0) globalThis.__giEmitterShadowScale = emitScale;
  if (irrEps > 0) globalThis.__giIrrValidEps = irrEps;
  // The dial starts at the SHIPPED default so the boot, the build and the
  // convergence are the ones a user gets; the probe only moves it after the
  // field is settled.
}, PROJECT, QUALITY, DIAL, SPACING0, RAYCAP, EMITSCALE, IRREPS);

await page.goto(url, { waitUntil: "load", timeout: 90000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 90000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

const call = async (op, payload) => page.evaluate(async ({ op, payload }) => {
  const end = performance.now() + 180_000;
  for (;;) {
    try { return await globalThis.__editorApi.call(op, payload); }
    catch (e) {
      if (performance.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}, { op, payload });

readyAfter = Date.now();
await call("scene.open", { path: SCENE });
const readyMark = await Promise.race([
  fieldReady, new Promise((r) => setTimeout(() => r(null), READY_MS)),
]);
console.log(`  field ${readyMark ? "up" : "⚠ NOT READY (timed out)"} at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
// ⚠ REFUSE TO MEASURE AN ARM THAT DID NOT ARM. §12.90's adaptive gather
// lattice census runs on every build now; no receipt means it declined
// (under 8 separators) rather than that a flag never reached the page.
if (!latticeReceipt) {
  await browser.close();
  throw new Error(
    "no `§12.90 adaptive gather lattice` receipt — the census did not fire, " +
    "so this would be a bias sweep on the TIER lattice (s0 0.45) mislabelled as one on 0.35.",
  );
}
console.log(`  ⭐ ${latticeReceipt}`);

// FREEZE EVERYTHING THAT IS NOT THE DIAL. Game time drives the day cycle
// (GAME/scripts/Rotator.ts reads `engine.time.elapsed`) and the mixers drive
// the character; both are held so the ONLY difference between A and B is the
// uniform. `engine.time.scale`, not `.timeScale` — the latter silently defines
// a new own property and does nothing ([[gi-walk-transient]]).
await page.evaluate(async (keepTone) => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  if (engine?.time) engine.time.scale = 0;
  const mixers = new Set();
  for (const root of engine?.rootEntities ?? []) {
    root.traverse?.((entity) => {
      const anim = entity.getComponent?.("animation");
      if (anim?.mixer) mixers.add(anim.mixer);
    });
  }
  engine?.scene?.traverse?.((o) => { if (o.userData?.mixer) mixers.add(o.userData.mixer); });
  for (const m of mixers) { m.timeScale = 0; try { m.setTime(0); m.update(0); } catch {} }
  // Tone mapping off, matching probe:gi-walk — the statistics are on LINEAR
  // luma and a tone curve would compress exactly the dark end being judged.
  const { THREE } = await import("/src/engine/index.js");
  if (engine?.renderer) {
    // ⛔⛔ INSTRUMENT FAILURE #10 (2026-08-24). Forcing NoToneMapping here means
    // every PNG this probe has ever written, and every checker/crease/luma
    // number computed from one, describes a LINEAR image THE USER NEVER SEES.
    // Their scene ships `toneMapping: "neutral"` (Khronos PBR Neutral), which
    // desaturates and compresses the top end — i.e. it changes exactly the
    // washed-out, low-contrast character they call "mud". Comparing these
    // captures against their screenshots was comparing two different renderers.
    // The linear view is still right for the STATISTICS (a tone curve would
    // compress the dark end being judged), so it stays the default — but
    // `KEEPTONE=1` renders what the user actually looks at, and any capture
    // meant for their eyes MUST use it.
    if (!keepTone) {
      engine.renderer.toneMapping = THREE.NoToneMapping;
      engine.renderer.toneMappingExposure = 1;
    }
  }
  return mixers.size;
}, KEEPTONE);

await new Promise((r) => setTimeout(r, SETTLE));

/**
 * Capture the RENDERER canvas as linear luma.
 *
 * ⚠⚠ THE DRAW MUST HAPPEN INSIDE A rAF CALLBACK. A WebGPU canvas's texture is
 * invalidated once the frame is presented, so a `drawImage` from an arbitrary
 * task reads BLACK — silently, and with a plausible-looking PNG. The first
 * version of this probe did exactly that and reported "the dial is INERT at
 * this pose" for all three poses with `0 flat px`, which is the guard catching
 * an empty image rather than a null result. `probe:gi-walk` gets this right by
 * accident: its whole loop lives in one `page.evaluate` driven by rAF.
 * `ensureEngine()` is awaited BEFORE the rAF so the callback body yields never.
 */
const grab = async () => page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const canvas = (await ensureEngine()).renderer.domElement;
  return await new Promise((resolve) => {
    requestAnimationFrame(() => {
      const w = canvas.width, h = canvas.height;
      const off = new OffscreenCanvas(w, h);
      const ctx = off.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0);
      const d = ctx.getImageData(0, 0, w, h).data;
      const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const L = new Array(w * h);
      let nz = 0;
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        L[j] = 0.2126 * s2l(d[i] / 255) + 0.7152 * s2l(d[i + 1] / 255) + 0.0722 * s2l(d[i + 2] / 255);
        if (L[j] > 1e-5) nz++;
      }
      resolve({ w, h, L, nz });
    });
  });
});

const grabPng = async () => page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const canvas = (await ensureEngine()).renderer.domElement;
  const blob = await new Promise((resolve) => {
    requestAnimationFrame(async () => {
      const off = new OffscreenCanvas(canvas.width, canvas.height);
      off.getContext("2d").drawImage(canvas, 0, 0);
      resolve(await off.convertToBlob({ type: "image/png" }));
    });
  });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ""; for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
});

const setDial = async (v) => page.evaluate((x) => { globalThis.__giGatherSmoothLive = x; }, v);
/** §12.88's normal bias in metres, live. See `gatherNormalBias` in srcMath.js. */
const setBias = async (v) => page.evaluate((x) => { globalThis.__giGatherNormalBiasLive = x; }, v);
const applyDial = (v) => (
  DIAL === "bias" ? setBias(v) : DIAL === "los" ? setLos(v) : setDial(v));

/**
 * The second difference restricted to LOW-GRADIENT pixels.
 *
 * A crease is a gradient STEP, but on a real frame the largest second
 * differences are albedo and geometry edges — a doorway's border, the
 * character's silhouette — which no interpolant change can touch. So mask them
 * out by their own FIRST difference: keep only pixels whose local gradient is
 * below the frame's median, i.e. the flat, smoothly-shaded regions where a
 * lattice crease is the only thing that can bend the light.
 */
const creaseFlat = (L, w, h) => {
  const g = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = y * w + x;
      g[o] = Math.abs(L[o] - L[o + 1]) + Math.abs(L[o] - L[o + w]);
    }
  }
  const sortedG = Array.from(g).filter((v) => v > 0).sort((a, b) => a - b);
  const cut = sortedG[Math.floor(sortedG.length * 0.5)] ?? 0;
  const vals = [];
  let sum = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = y * w + x;
      if (g[o] > cut || !(L[o] > 1e-5)) continue;
      const cx = Math.abs(L[o - 1] - 2 * L[o] + L[o + 1]);
      const cy = Math.abs(L[o - w] - 2 * L[o] + L[o + w]);
      vals.push((cx + cy) / 2);
      sum += L[o]; n++;
    }
  }
  if (!n) return { mean: 0, p99: 0, px: 0 };
  const m = sum / n;
  vals.sort((a, b) => a - b);
  let acc = 0; for (const v of vals) acc += v;
  return {
    mean: +(acc / vals.length / m).toExponential(3),
    p99: +(vals[Math.floor(vals.length * 0.99)] / m).toExponential(3),
    px: n,
  };
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

console.log(`\n══ PAIRED C0 vs C1 GATHER WEIGHTS — ${POSES.length} poses × ${ROUNDS} rounds ══`);
console.log(`   the ONLY difference between A and B is srcScreenGather's smoothU uniform.\n`);

for (let pi = 0; pi < POSES.length; pi++) {
  const p = POSES[pi];
  await call("viewport.setCamera", { position: [p[0], p[1], p[2]], target: [p[3], p[4], p[5]] });
  // Re-issue: this scene's async editor-camera restore stomps a one-shot
  // setCamera (plan §15 U2's instrument note).
  await new Promise((r) => setTimeout(r, 500));
  await call("viewport.setCamera", { position: [p[0], p[1], p[2]], target: [p[3], p[4], p[5]] });
  await new Promise((r) => setTimeout(r, 6000));

  const bags = LEVELS.map(() => []);
  const deltas = [];
  let lastA = null, lastB = null;
  for (let r = 0; r < ROUNDS; r++) {
    for (let li = 0; li < LEVELS.length; li++) {
      const bag = bags[li];
      await applyDial(LEVELS[li]);
      await new Promise((t) => setTimeout(t, HOLD));
      const img = await grab();
      if (!(img.nz > img.w * img.h * 0.05)) {
        throw new Error(
          `capture is empty (${img.nz} lit px of ${img.w * img.h}) — the WebGPU drawing ` +
          `buffer was not readable. A black frame reads as "the dial is inert"; it is not a result.`,
        );
      }
      // ⚠ AND A FRAME CAN BE READABLE BUT UNLIT. Pose 0 of the 2026-08-24 LOS
      // sweep came back with 4,079 "flat" pixels against 123,468 in the run
      // before it: the field had not come up yet (LOS-armed boots are this
      // project's most reliable §12.56 dead-field reproducer), so every
      // normalised statistic divided by a near-zero mean and printed enormous
      // numbers that looked like data. The <5% guard above cannot see it — a
      // handful of emissive pixels clears it. Compare against the FIRST level's
      // pixel count at this pose instead, which is the same scene by
      // construction, and refuse rather than report.
      const meanL = img.L.reduce((x, y) => x + y, 0) / img.L.length;
      if (!(meanL > 1e-4)) {
        throw new Error(
          `frame is unlit at pose ${pi}, ${DIAL}=${LEVELS[li]} (mean luma ${meanL.toExponential(2)}) — ` +
          `the GI field is dead or still building. Statistics normalised by this mean are noise; ` +
          `raise SETTLE or check for a §12.56 dead-field boot.`,
        );
      }
      bag.push({ ...creaseFlat(img.L, img.w, img.h), lum: img.L.reduce((x, y) => x + y, 0) / img.L.length });
      if (li === 0) lastA = img;
      if (li === LEVELS.length - 1) lastB = img;
    }
    if (lastA && lastB) {
      let s = 0, m = 0;
      for (let i = 0; i < lastA.L.length; i++) { s += Math.abs(lastA.L[i] - lastB.L[i]); m += lastA.L[i]; }
      deltas.push(m > 0 ? s / m : 0);
    }
  }

  console.log(`── pose ${pi} [${p.slice(0, 3).join(",")}] → [${p.slice(3).join(",")}]   dial=${DIAL}`);
  const baseP99 = median(bags[0].map((x) => x.p99));
  const baseLum = median(bags[0].map((x) => x.lum));
  for (let li = 0; li < LEVELS.length; li++) {
    const b = bags[li];
    const p99 = median(b.map((x) => x.p99));
    const lum = median(b.map((x) => x.lum));
    console.log(`   ${DIAL}=${String(LEVELS[li]).padEnd(5)} creaseFlat p99 ${p99.toExponential(3)}` +
      `  mean ${median(b.map((x) => x.mean)).toExponential(3)}` +
      `  |  vs base: crease ${(p99 / Math.max(1e-12, baseP99)).toFixed(3)}x` +
      `  luma ${(lum / Math.max(1e-12, baseLum)).toFixed(3)}x` +
      (li === 0 ? `   over ${b[0]?.px} flat px` : ""));
  }
  // ⚠ THE LIVENESS LINE, and it is not decoration. Four statistics returned
  // confident nulls on this project in one day because they could not see their
  // subject — one of them was THIS probe reporting "the dial is INERT" from a
  // BLACK capture. A null with delta 0.00% is a broken instrument; a null with
  // delta 1.5% is a result. Read this before reading the ratios above.
  console.log(`   ⭐ picture delta first→last ${(median(deltas) * 100).toFixed(2)}% of mean luma`);
  if (median(deltas) < 0.001) {
    console.log(`   ⚠ the extremes differ by <0.1% of the picture — the dial is INERT at this pose, ` +
      `so every ratio above is noise. Check the live uniform actually reached the kernel.`);
  }

  if (wantPng) {
    for (const lv of LEVELS) {
      await applyDial(lv);
      await new Promise((t) => setTimeout(t, HOLD));
      const name = `${OUT}/pose${pi}-${DIAL}${String(lv).replace(".", "p")}.png`;
      writeFileSync(name, Buffer.from(await grabPng(), "base64"));
      console.log(`   png ${name}`);
    }
  }
}

if (errors.length) console.log(`\n⚠ ${errors.length} page error(s): ${errors.slice(0, 3).join(" | ")}`);
await browser.close();
