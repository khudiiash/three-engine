// WALK-INTO-A-ROOM PROBE — "there are many patches of light updating, creating
// checkerboards and different grid-like patterns" (user, 2026-08-23, front 4).
//
// ══ THE MEASUREMENT PROBLEM, AND THE TRICK THAT SOLVES IT ══════════════════
//
// The complaint is about frames DURING and just after movement, so the obvious
// instrument — frame-to-frame difference while walking — is useless: parallax
// changes every pixel, and the GI transient is a few percent on top of that.
// Any statistic taken while the camera moves is measuring the camera.
//
// So this probe walks, then **STOPS**, and only then starts measuring. With the
// camera pinned, every remaining frame-to-frame change IS the GI field catching
// up. That is exactly the thing the user watches: you arrive in a room and the
// light keeps rearranging itself in blocks for the next second or two.
//
// ══ WHAT THE NUMBERS MEAN ══════════════════════════════════════════════════
//
// The burst is compared against the SETTLED frame captured seconds later, so
// `err` is literally "how wrong is the picture right now", and the convergence
// curve is honest even if the arrival frame happens to be pretty.
//
//   err0        mean |L − L_settled| on the first pinned frame (linear luma)
//   settle95    ms until err falls to 5% of err0 and stays there — how long the
//               user watches the light move after they stop
//   maxStep     the largest per-TILE change between two consecutive pinned
//               frames. ⭐ THIS IS THE PATCH STATISTIC: smooth convergence is
//               many small steps everywhere, a block popping in is one big step
//               in one place. A pop is what the eye catches, not the mean.
//   patch0      std/mean of per-tile error at arrival. Low = the whole image is
//               uniformly a bit wrong (invisible); high = a few regions are very
//               wrong and the rest is right, which is the visible patchwork.
//
// Plus the transport's own tallies AT ARRIVAL (not at rest — the previous
// session's whole confusion was reading a healthy parked ladder and inferring a
// healthy moving one): fresh/live/noBlock/failed/held per cascade, the seed
// pass's cold/orphan split, and the merge orphan rate.
//
//   node scripts/run-gi-walk-patches.mjs [url]
// Env:
//   PROJECT=C:/Users/Khudiiash/Documents/GAME   read-only via the tauri shim
//   SCENE=scenes/Level.scene   QUALITY=high     ARMS=base
//   SETTLE=14000   walk-in settle before the first leg
//   WALKMS=1600    how long a leg takes   BURST=4000   pinned measuring window
//   TAIL=6000      extra settle before the reference frame is taken
//   LEGS=2         how many room-to-room legs to walk
//   PNG=1          arrival / settled / error-heatmap per leg
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = `${PROJECT}/${process.env.SCENE ?? "scenes/Level.scene"}`;
const QUALITY = process.env.QUALITY ?? "high";
const ARMS = (process.env.ARMS ?? "base").split(",").map((s) => s.trim()).filter(Boolean);
const CFG = {
  settle: Number(process.env.SETTLE ?? 14000),
  walkMs: Number(process.env.WALKMS ?? 1600),
  burstMs: Number(process.env.BURST ?? 4000),
  tailMs: Number(process.env.TAIL ?? 6000),
  legs: Number(process.env.LEGS ?? 2),
  telem: process.env.TELEM === "1",
  freeze: process.env.FREEZE === "1",
  // PINSUN=0 freezes the character but LEAVES THE SUN TURNING — the isolation
  // arm. The rotating sun is the demo's whole point (user: "this is for the
  // demo to demonstrate dynamic gi"), so the question is not how to stop it but
  // how much of the visible transient it owns.
  pinSun: process.env.PINSUN !== "0",
  /**
   * ⭐ WHICH HALF OF THE DAY CYCLE IS PINNED — the attribution arm.
   *
   * The day cycle drives the sun's ORIENTATION and its INTENSITY/COLOUR, and
   * the stored radiance goes stale against BOTH. They cost wildly different
   * amounts to fix: de-staling the intensity needs the sun's contribution kept
   * in a channel of its own (3 words per bin, re-multiplied by the CURRENT
   * `E_sun` at resolve); de-staling the ANGLE needs the hit's normal cached too
   * (3 more, plus a visibility term that cannot be made analytic at all). So
   * before widening the hottest buffer in the module, measure which one the
   * user's checkerboard is actually made of:
   *
   *   all  both pinned    — the static control (`checker` 0.0046, no decay)
   *   dim  intensity+colour pinned, ORIENTATION FREE — what the ANGLE costs
   *   aim  orientation pinned, INTENSITY+COLOUR FREE — what the INTENSITY costs
   *   off  nothing pinned — the user's condition (`checker` 0.0415)
   *
   * `dim` ≈ `off` says the angle owns it and the cheap fix is not enough;
   * `aim` ≈ `off` says the intensity owns it and 3 words buy the whole repair.
   *
   * ⚠ `dim` and `aim` are DELIBERATELY non-static scenes, so the fingerprint
   * WILL drift and `scene STATIC` will not print. That is the arm working, not
   * the freeze failing — the character mixers are still frozen either way.
   */
  sunPin: (process.env.SUNPIN ?? (process.env.PINSUN === "0" ? "off" : "all")).toLowerCase(),
  /** Sun ELEVATION in degrees, held fixed so runs are comparable. */
  sunDeg: Number(process.env.SUNDEG ?? 40),
  /**
   * ⭐ THE DAY CYCLE'S PERIOD, and the point in it every leg starts from.
   *
   * The user's `Rotator.ts` is `rotation.x = sin(elapsed·0.1) − 1`, so the
   * cycle is 2π/0.1 = 62.83 s of GAME time. `SUNALIGN=0` opts out (and the
   * pinned arms opt out by themselves — there is nothing to align, and under
   * `all` game time is stopped so an aligner would wait on a dead clock).
   */
  /**
   * ⭐ WHERE IN ITS CLIP EVERY ANIMATED CHARACTER IS PINNED, in seconds.
   *
   * `timeScale = 0` freezes the pose wherever boot timing left it, and on this
   * Level that alone moved leg0 `checker` 20× between two runs of the SAME arm.
   * See the freeze block. `POSE=` moves the pin; there is no "off".
   */
  poseT: Number(process.env.POSE ?? 0),
  sunPeriod: Number(process.env.SUNPERIOD ?? (2 * Math.PI) / 0.1),
  sunPhase: Number(process.env.SUNPHASE ?? 0.25),
  sunAlign: process.env.SUNALIGN !== "0",
};
if (!["all", "dim", "aim", "off"].includes(CFG.sunPin)) {
  throw new Error(`SUNPIN must be one of all|dim|aim|off (got ${CFG.sunPin})`);
}
// SUNPIN is the authority; PINSUN stays as the historical spelling of all|off.
CFG.pinSun = CFG.sunPin !== "off";
/** Does this mode hold the sun's ORIENTATION still? */
CFG.pinAim = CFG.sunPin === "all" || CFG.sunPin === "aim";
/** Does this mode hold the sun's INTENSITY and COLOUR still? */
CFG.pinDim = CFG.sunPin === "all" || CFG.sunPin === "dim";
const wantPng = process.env.PNG !== "0";
const OUT = ".gi-shots/walk-patches";
mkdirSync(OUT, { recursive: true });

/**
 * Arm globals. Every one of these is a 2026-08-22 experiment that the user's
 * revert put back to opt-in, so an arm here is a QUESTION, never a default.
 */
const armGlobals = (armName) => ({
  // ⭐ A TRAILING DIGIT IS A REPEAT, NOT A NEW ARM. `ARMS=nosunsplit,nosunsplit2`
  // runs the SAME configuration twice in one session, which is the only way to
  // show reproducibility under the conditions the other arms are measured in —
  // and this harness has now had SIX inputs turn out to be uncontrolled, every
  // one of them found by two identical runs disagreeing. Without this, a repeat
  // arm silently matched nothing and ran as the default instead.
  //
  // ⚠ SO NO ARM NAME MAY END IN A DIGIT — `sunsplitcos1` was stripped to
  // `sunsplitcos`, matched nothing, and ran as `base` under another name.
  __giConfigOverride: { quality: QUALITY },
  ...(((arm) => ({
  // Probe retention: a probe stops being retired the instant it leaves the
  // screen. Anchor-relative keys are stable between re-anchors and the
  // re-anchor kill retires everything, so this is sound on the shipped arm.
  // ⛔ `retain` WAS INERT ITS WHOLE LIFE — `__giSrcProbeRetainAnchor` is read
  // by NOTHING in src (the cap64/a015 never-armed class). §16 D1 (2026-08-24)
  // made retention the DEFAULT, so the meaningful arm now points the other
  // way: `sixteenoff` is the pre-§16 control — retention AND the D3 tile
  // maturity off, i.e. the configuration every pre-08-24 number was taken in.
  ...(arm === "retain" ? { __giSrcProbeRetainAnchor: true } : {}),
  ...(arm === "sixteenoff" ? { __giSrcProbeRetain: false, __giSrcMaturity: false } : {}),
  ...(arm === "worldkeys" ? { __giSrcWorldKeys: true } : {}),
  ...(arm === "hold" ? { __giIrrValidityHold: true } : {}),
  // ⭐⭐ §12.87's CONTROL ARM — TILE COVERAGE BACK TO A FLAG (2026-08-26).
  //
  // Fractional coverage became the DEFAULT on the strength of a live A/B in the
  // user's editor (ultra, the Level this probe walks): against "when camera
  // moves and sees a new surface … patches look like a checkerboard, some
  // darker, some brighter", the fraction took the patches to ALMOST GONE at no
  // frame cost, where `capoff` — 25% of the frame — cleared less.
  //
  // This arm is what that claim has to keep beating, and it is the reason the
  // claim is falsifiable at all: `base` is now the fraction, so without a
  // control every future run would report the fixed number with nothing to
  // compare it to. The metric to read is `checker` (and `crease`, which sees
  // the interpolant-order change `checker` structurally cannot — see its
  // header): a flag hands whichever probe won a cell that probe's single-bin
  // constant, so the artifact is cell-scale blockiness that rearranges as
  // probes re-mint, which is exactly what `checker` measures.
  //
  // ⚠ RUN IT IN THE SAME SESSION AS `base`. This probe has had SEVEN
  // uncontrolled inputs (see the header and #7 below); a number from a
  // different session is not a control.
  ...(arm === "nocoverfrac" ? { __giTileCoverFraction: false } : {}),
  // §12.61's rest cadence halves the ray ceiling 1 s after the camera stops
  // (REST_CAM_HOLD_MS 600 + REST_CAM_FADE_MS 400) — while the field, measured
  // here, still has SECONDS of convergence left. This arm removes the cadence
  // entirely: not a shipping candidate (it costs frame time at rest, and the
  // 60 fps rule outranks), but it says how much of the tail the budget owns.
  ...(arm === "norest" ? { __giSrcRestCadence: false } : {}),
  // ── THE TWO FEEDBACK PATHS THAT CAN RING ───────────────────────────────
  // A sustained oscillation with a PINNED camera and a static scene is a loop
  // with too much gain, and there are only two candidates: multi-bounce (the
  // field feeds its own next bounce) and the surprise-driven α (a block whose
  // evidence disagrees with its history converges FAST — overshoot creates
  // fresh disagreement, which re-triggers the boost). Neither arm is a
  // shipping candidate; each one NAMES the loop by removing it.
  ...(arm === "nosecondary" ? { __giSrcSecondary: false } : {}),
  ...(arm === "nosurprise" ? { __giSrcSurprise: false } : {}),
  // ── THE PER-PROBE RAY CAP ──────────────────────────────────────────────
  // Measured on the Level: the deposit fires 3 864–12 676 rays/frame against
  // a tier ceiling of 131 072, because [D1'] clamps EVERY probe at 16 and only
  // 243–838 probes are live. ~95% of the sanctioned budget is never spent, and
  // evidence rate is what sets convergence. These arms buy it back.
  // ⛔⛔ THESE WERE NAMED `cap64` AND WERE INERT FOR THEIR ENTIRE LIFE. The
  // normaliser below strips trailing digits, so `cap64` arrived here as `cap`,
  // matched nothing, and ran as `base` under another name — the exact failure
  // the header twelve lines up warns about by name. Every "cap64 changed
  // nothing" reading is VOID, including the one the α comment below leans on.
  // Renamed past the stripper and guarded by `KNOWN_ARMS`.
  ...(arm === "capbig" ? { __giSrcProbeRayCap: 64 } : {}),
  ...(arm === "capoff" ? { __giSrcProbeRayCap: -1 } : {}),
  // ⭐ THE UNTRIED DIRECTION, and the one the 2026-08-24 profile argues for.
  // Live probes ≈ raysPerFrame / probeRayCap (the user's Level at rest: 33 810
  // rays, cap 32, 1 131 live c0 — and the gather then finds only 4.4 of its 8
  // trilinear corners, which IS a spatial smear). LOWERING the cap spends the
  // SAME budget on ~4× the probes: a fuller stencil, each probe noisier. Every
  // cap arm ever written pushed the cap UP, i.e. fewer, better-fed probes —
  // the opposite of what a 4.4/8 stencil is short of.
  ...(arm === "caplow" ? { __giSrcProbeRayCap: 8 } : {}),
  // ── THE α PIN — the decisive test of the "ladder = 4 EMAs in series" model ─
  // Measured: α runs 0.05–0.06 live, so a SINGLE stage's τ is ~1/α ≈ 17 frames
  // ≈ 0.5 s, i.e. ~1.5 s to settle — yet the picture takes 5–7 s. Four
  // cascades, each of whose content is itself an accumulator, is a 4th-order
  // low-pass: ~4× the single-stage settle, which is exactly the gap. It also
  // explains why cap64 did nothing: once a bin refreshes at least once per
  // frame, τ is floored at 1/α and MORE EVIDENCE CANNOT HELP.
  // `__giSrcAlpha` outranks the floor (readAlpha returns before the max), so
  // these arms pin it outright. If settle scales ~1/α, the model holds and the
  // surgical fix is a per-cascade α; if not, the model is wrong.
  // ⛔ ALSO INERT FOR THEIR ENTIRE LIFE — `a015`/`a03` stripped to `a`. So the
  // "decisive test of the 4-EMA model" was never once run, and the claim above
  // that "cap64 did nothing" — which this comment uses to motivate itself —
  // rests on an arm that never armed either. Both renamed; the model is UNTESTED.
  ...(arm === "alphamid" ? { __giSrcAlpha: 0.15 } : {}),
  ...(arm === "alphabig" ? { __giSrcAlpha: 0.3 } : {}),
  // §12.80 Unit B traces HALF the pixels per frame and keeps last frame's texel
  // for the other half. At rest that is a 2-frame refresh; the open question is
  // what it looks like when a walk has just replaced the content BOTH parities
  // are holding. `__giShadowCheckerboard = false` restores the full trace.
  ...(arm === "nochecker" ? { __giShadowCheckerboard: false } : {}),
  // ══ §12.84 — IS THE ARTIFACT JUST `mLight` TURNING BOTH SMOOTHERS DOWN? ══
  //
  // Neither of these touches the sun's PHYSICS. Both undo what a CONSTANT-RATE
  // sun does to the two temporal filters, and the arithmetic says that is most
  // of the effect §12.82 spent a session attributing to staleness:
  //
  //   the day cycle is 0.1 rad/s (GAME/scripts/Rotator.ts), so
  //   shadowMotion / ALPHA_MOTION_SAT = 0.52 at 72 fps — a PERMANENT mLight
  //   of ~0.5-0.6, not a transient. Feed that through the two laws:
  //
  //   · FIELD (srcSystem §12.74): sustained = min(0.7, mLight) = 0.57, so
  //     rootS = 1 + (stride−1)(1−0.57) = 2.72 at stride 5 instead of 5, and
  //     keep = (1−α)^(1/rootS) falls 0.99597 → 0.9752. Effective samples per
  //     probe **248 → 40**.
  //   · SCREEN (GISystem §12.65/§12.74 floor): histWeight = max(0.9(1−mLight),
  //     0.7·sustained) = **0.40** instead of 0.9. Effective frames **10 → 1.7**.
  //
  // ~2.5× more noise in the field and ~2.4× on screen, held there for as long
  // as the sun turns — carried by the c0 lattice (s₀ = 0.45 m on this Level, a
  // ~0.45 m tent), worst where the mean is smallest. That is the user's report
  // ("blockiness in the darker, further regions") without a single stale term.
  //
  // ⭐ AND IT RE-READS §12.82's ONE REAL NUMBER. Pinning the sun took leg0
  // `checker` 0.0133 → 0.0046 (~3×) and that was filed as "the sun owns the
  // transient, so the stale factor must be V". Pinning the sun ALSO sets
  // mLight to 0, which restores both filters — and 2.5-4× is exactly what
  // these two laws predict. If `motionsmooth` reproduces the pinned number
  // WITH THE SUN MOVING, the staleness reading was a confound and the fix is a
  // recalibration, not a rebuild.
  //
  // `noroot` and `irrhist` split the credit; run all three or none.
  // ⭐⭐ §12.85 — THE SHADOW CHECKERBOARD, AND WHY THIS PROBE'S OWN DESIGN
  // MAXIMISES IT. §12.80 Unit B traces HALF the light-shadow pixels per frame;
  // the other half keeps last frame's texel AT THE SAME SCREEN COORD. §14 Q3
  // noticed that hold is only valid at rest — and armed the smear fill from
  // the VIEW-PROJECTION DELTA ALONE (GISystem ~2061). A moving LIGHT invalidates
  // the very same hold and arms nothing.
  //
  // So: parked camera + moving sun = half the shadow buffer is one frame of sun
  // rotation stale, in a checkerboard, every frame, with no fill. That is this
  // probe's measuring window by construction (it walks, STOPS, then measures),
  // and `base-leg1-error.png` shows it literally — a checkerboard of squares on
  // the shadowed wall. It also re-reads §12.82's one real number: pinning the
  // sun made the two phases IDENTICAL, which is why `checker` fell 0.0133 →
  // 0.0046 under a pin and did not move for the sun SPLIT.
  //
  // The set that settles it, and they must run in ONE session:
  //   nolightfill  the shipped-before-2026-08-23 behaviour (fill on CAMERA
  //                motion only) — the bug, and the control
  //   base         §12.85's fix: the fill also arms on LIGHT motion. Costs no
  //                rays, only horizontal resolution on a frame that was stale
  //   nochecker    no checkerboard at all (arm defined further up) — the UPPER
  //                BOUND, and the arm that clears the scheme if base ≈ nolightfill
  ...(arm === "nolightfill" ? { __giShadowCheckerLightFill: false } : {}),
  // ⭐⭐ §12.86 — THE C0/C1 ARM. `gatherSmoothWeights` (srcMath.js) replaces the
  // trilinear parameter `t` with `3t²−2t³`, which zeroes the interpolant's
  // derivative at every cell face. Plain trilinear is C0: the GRADIENT steps at
  // each face and the eye reads a gradient step as a line (Mach banding) — over
  // a 3D lattice, a cell-shaped grid at exactly `spacing0` = 0.45 m, world-
  // locked, permanent, and invisible until you TRANSLATE across it. That is the
  // user's report word for word ("when we transite from one voxel grid to
  // another", "when our camera moves from one room into the other").
  // It shipped OPT-IN and is now DEFAULT-ON; this arm is the regression control.
  // ⚠ The reader is shared with srcRef.js's CPU mirror, so the arm flips BOTH
  // and `test:gi-src-gather` still diffs like against like.
  ...(arm === "nosmooth" ? { __giGatherSmoothWeights: false } : {}),
  ...(arm === "motionsmooth" ? { __giSrcMotionRoot: false, __giIrrHistWeight: 0.9 } : {}),
  ...(arm === "noroot" ? { __giSrcMotionRoot: false } : {}),
  ...(arm === "irrhist" ? { __giIrrHistWeight: 0.9 } : {}),
  }))(armName.replace(/\d+$/, ""))),
});

/**
 * ⭐⭐ THE GUARD. An arm that matches nothing runs as `base` UNDER ANOTHER NAME,
 * and the output is indistinguishable from a real null result — the run prints
 * a tidy table, both arms agree, and the conclusion "X changes nothing" goes
 * into the plan doc and then into memory as settled fact.
 *
 * That has now happened FOUR times in this file: `sunsplitcos1` (recorded in
 * the normaliser's header), then `cap64`, `a015` and `a03`, found 2026-08-24 —
 * the last three inert since the day they were written, and one of them is the
 * sole evidence behind "the ray cap does not matter", which is a load-bearing
 * claim about convergence. A warning comment did not stop it; a list does.
 *
 * Every name here must survive `replace(/\d+$/, "")` unchanged.
 */
const KNOWN_ARMS = new Set([
  "base", "retain", "worldkeys", "hold", "norest", "nosecondary", "nosurprise",
  "capbig", "capoff", "caplow", "alphamid", "alphabig", "nochecker",
  "nolightfill", "nosmooth", "motionsmooth", "noroot", "irrhist",
  "sixteenoff", "nocoverfrac",
]);
for (const armName of ARMS) {
  const normalized = armName.replace(/\d+$/, "");
  if (!KNOWN_ARMS.has(normalized)) {
    throw new Error(
      `unknown arm "${armName}"${normalized === armName ? "" : ` (normalizes to "${normalized}")`}` +
      ` — it would have run as \`base\` under another name and reported a convincing null. ` +
      `Known arms: ${[...KNOWN_ARMS].join(", ")}`,
    );
  }
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

async function runArm(arm) {
  const t0 = Date.now();
  // One context per arm — arms sharing a browser inherit each other's editor
  // layout through a channel localStorage.clear() does not close, and the
  // canvas size then becomes a hidden variable ([[gi-harness-viewport-traps]]).
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const gi = [];
  const errors = [];
  // ⚠⚠ THE TRANSIENT TRAP, PAID FOR TWICE ALREADY: this Level's GI takes ~30 s
  // to build (26 s of compute compiles, then the occupancy chain, then the
  // BVH). Measuring a "walk" before that lands measures the BOOT — the same
  // convergence transient the user twice read as a regression. So the probe
  // does not start until the engine itself says the field is up, and it says
  // so on the console. `bvh: exact reflections` is the LAST of the three
  // markers on this scene; whichever arrives, we then still settle.
  // ⚠ AND IT MUST BE THIS SCENE'S MARKER. The editor boots into whatever scene
  // was last open, so the startup scene fires `field ready` too — accepting the
  // first one measured a walk that began 20 s before the Level's own field
  // existed. `readyAfter` is stamped when `scene.open` returns.
  let markReady = null, readyAfter = Infinity;
  const fieldReady = new Promise((r) => { markReady = r; });
  /** Everything, in order, on the node clock — the flash-window timeline. */
  const all = [];
  page.on("console", (m) => {
    const t = m.text();
    const at = (Date.now() - t0) / 1000;
    all.push([at, m.type(), t.slice(0, 200)]);
    if (/^\[gi\]|DEAD FIELD|DEAD SHADING/.test(t)) gi.push(`${at.toFixed(1)}s ${t.slice(0, 300)}`);
    if (/\[gi\] field ready:/.test(t) && Date.now() >= readyAfter) markReady?.(t.slice(0, 80));
    if (m.type() === "error") errors.push(t.slice(0, 240));
  });
  page.on("pageerror", (e) => {
    const msg = String(e.message ?? e);
    if (!/save_scene/.test(msg)) errors.push(`pageerror ${msg.slice(0, 240)}`);
  });
  await installTauriShim(page, {}); // read-only by construction
  await page.evaluateOnNewDocument((project, globals) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    for (const [k, v] of Object.entries(globals)) globalThis[k] = v;
  }, PROJECT, armGlobals(arm));

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
  await call("scene.open", { path: SCENE });
  readyAfter = Date.now();
  // ⚠ BOOT FIRST, THEN WAIT. `ensureEngine()` is what CREATES the engine — a
  // node-side wait for GI's console markers placed before it waits forever for
  // a module that nothing has started (240 s of it, the first time).
  const booted = await page.evaluate(async () => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    if (!engine) return "no engine";
    const end = performance.now() + 240_000;
    for (;;) {
      if (engine.modules?.get?.("gi")?.system?.state) return "gi system up";
      if (performance.now() > end) return "gi never ready";
      await new Promise((r) => setTimeout(r, 500));
    }
  });
  console.log(`  boot: ${booted} at ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const readyMark = await Promise.race([
    fieldReady,
    new Promise((r) => setTimeout(() => r("TIMEOUT — measuring a scene whose field may still be building"), 240_000)),
  ]);
  console.log(`  field up after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${readyMark}`);

  const out = await page.evaluate(async (cfg) => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    if (!engine) return { fail: "no engine" };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
    {
      const end = performance.now() + 240_000;
      for (;;) {
        if (engine.modules?.get?.("gi")?.system?.state) break;
        if (performance.now() > end) return { fail: "gi never ready" };
        await sleep(500);
      }
    }
    const { THREE } = await import("/src/engine/index.js");
    /** Page-load-relative, so `lum` times and console timestamps share a zero. */
    const startedAt = performance.timeOrigin ? 0 : 0;
    const renderer = engine.renderer;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    const system = engine.modules.get("gi").system;

    // ── WAYPOINTS: THE LEVEL'S OWN ROOMS ──────────────────────────────────
    //
    // `level.rooms()` flood-fills the blockout's wall footprints and hands back
    // an open point at eye height per room — which is exactly "walk from one
    // room into another", the user's stated case, rather than a straight line
    // that might never cross a doorway. Duck-typed, like GISystem's own use.
    const rooms = [];
    for (const root of engine.rootEntities ?? []) {
      root.traverse?.((entity) => {
        const level = entity.getComponent?.("level");
        if (level && typeof level.rooms === "function") {
          try { rooms.push(...(level.rooms() ?? [])); } catch { /* a level without walls */ }
        }
      });
    }
    let waypoints = rooms.map((r) => ({ p: r.capture, area: r.area }));
    // ⚠ A blockout can carry a room on a storey nobody walks — this Level has
    // one at y = −498 (a stray floor piece). Walking to it is an 18 m vertical
    // teleport that swamps every statistic here, so keep the storey the
    // MEDIAN room lives on and drop the outliers.
    if (waypoints.length > 2) {
      const ys = waypoints.map((w) => w.p[1]).sort((a, b) => a - b);
      const medY = ys[Math.floor(ys.length / 2)];
      waypoints = waypoints.filter((w) => Math.abs(w.p[1] - medY) < 5);
    }
    if (waypoints.length < 2) {
      // Fallback for a scene with no blockout: the long axis of everything
      // renderable, at 1.6 m. Worse (it may walk through walls) but it still
      // exercises the "new geometry enters the view" path.
      const box = new THREE.Box3();
      engine.scene.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
      if (box.isEmpty()) return { fail: "no rooms and no geometry" };
      const lo = box.min, hi = box.max, y = Math.min(hi.y - 0.4, lo.y + 1.6);
      const longX = hi.x - lo.x >= hi.z - lo.z;
      const at = (t) => (longX
        ? [lo.x + (hi.x - lo.x) * t, y, (lo.z + hi.z) / 2]
        : [(lo.x + hi.x) / 2, y, lo.z + (hi.z - lo.z) * t]);
      waypoints = [{ p: at(0.15) }, { p: at(0.5) }, { p: at(0.85) }];
    }
    // Nearest-neighbour order from the biggest room, so the walk is a tour and
    // not a set of teleports between distant corners.
    const path = [waypoints.shift()];
    while (waypoints.length) {
      const last = path[path.length - 1].p;
      let best = 0, bestD = Infinity;
      waypoints.forEach((w, i) => {
        const d = (w.p[0] - last[0]) ** 2 + (w.p[2] - last[2]) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      });
      path.push(waypoints.splice(best, 1)[0]);
    }

    const setPose = (p, t) => {
      // ⛔ THE GUARD FOR UNCONTROLLED INPUT #7 (see `legAim`). A target equal to
      // the position is not a camera pose — OrbitControls resolves it to radius
      // 0 and three's lookAt falls back to world −Z, silently. It produced
      // plausible numbers for this probe's entire history. Fail loudly instead.
      const d = Math.hypot(t[0] - p[0], t[1] - p[1], t[2] - p[2]);
      if (!(d > 1e-3)) {
        throw new Error(
          `setPose: degenerate camera (|target − position| = ${d.toExponential(2)}). ` +
          `OrbitControls would snap the view to world −Z and every statistic after ` +
          `this point would be measured facing an arbitrary direction.`,
        );
      }
      return globalThis.__editorApi.call("viewport.setCamera", { position: p, target: t });
    };
    /**
     * Look 3 m ahead along the direction of travel, at eye height.
     *
     * ⛔⛔ **UNCONTROLLED INPUT #7, AND IT POISONED EVERY `checker` THIS PROBE
     * HAS EVER PRINTED** (found 2026-08-23 by a code fan-out, confirmed by
     * hand). The walk loop called `ahead(p, to)` with the CURRENT position as
     * `from`. On the LAST step `t = 1`, so `p === to` exactly — `dx` and `dz`
     * are both 0, `Math.hypot(0, 0) || 1` takes the fallback, and the function
     * returns **`p` itself**. That is `setCamera({ position: p, target: p })`.
     *
     * `viewport.setCamera` (src/editor/api/ops/viewport.js) writes
     * `orbit.target` and calls `orbit.update()`; with offset = position −
     * target = 0 the spherical radius is 0, and three's `Matrix4.lookAt` hits
     * its zero-direction fallback `_z.z = 1`. **The camera snaps to world −Z
     * and holds it for the entire pinned measuring window.** Every `checker`,
     * `err0`, `maxStep`, `patch0` and `ripple` in this probe's history was
     * therefore measured from the leg's endpoint facing an arbitrary compass
     * direction, one frame after an orientation JUMP whose magnitude is a
     * function of the leg's travel direction — i.e. systematically correlated
     * with the leg index. That is the whole of "leg1 is 11× leg0" and of
     * "POSE-DEPENDENT blockiness"; both were the instrument.
     *
     * ⚠ EVERY PRE-2026-08-23-NIGHT `checker` NUMBER IN THE PLAN DOC AND IN
     * `gi-walk-transient` IS VOID. That includes the sun-pinned 0.0505-0.0543
     * leg1 readings, the 0.0133 → 0.0051 moving-sun curve, and the §12.82
     * split-vs-control comparison, which straddled two different snap angles.
     *
     * THE FIX: aim along the LEG's direction (`from` → `to`, computed once),
     * never along the remaining distance, so the aim is defined at t = 1 and —
     * more importantly — IDENTICAL at every step of the leg. The camera's
     * orientation is now a controlled input: constant through the walk and
     * through the measurement.
     */
    const legAim = (from, to) => {
      const dx = to[0] - from[0], dz = to[2] - from[2];
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      return (q) => [q[0] + ux * 3, q[1], q[2] + uz * 3];
    };

    // ── THE CAPTURE ────────────────────────────────────────────────────────
    //
    // Downsampled to keep the per-frame cost off the thing being measured; a
    // patch that matters covers far more than one of these texels. Linear
    // luminance, because the artifact is a LIGHTING step and sRGB would
    // compress exactly the dark end where the black patches live.
    const canvas = renderer.domElement;
    const CW = 240, CH = 150, TILE = 8;
    const TX = Math.floor(CW / TILE), TY = Math.floor(CH / TILE);
    const off = new OffscreenCanvas(CW, CH);
    const ctx = off.getContext("2d", { willReadFrequently: true });
    // ── NATIVE-RESOLUTION CROP, FOR THE ARTIFACT THE USER ACTUALLY DESCRIBES ──
    //
    // ⚠⚠ The downsample above (686x342 → 240x150) ALIASES AWAY a pixel-scale
    // checkerboard completely. The user's report is "a bright and dark
    // checkerboard that gradually gets properly lit" — a SPATIAL,
    // high-frequency pattern whose amplitude decays — and every statistic in
    // this probe so far measured whole-frame BRIGHTNESS, which is blind to it
    // by construction. A centre crop at 1:1 keeps the pixel scale at a
    // fraction of the cost of the full frame; a checkerboard is spatially
    // uniform, so a crop is representative.
    const XW = Math.min(320, canvas.width), XH = Math.min(320, canvas.height);
    const xoff = new OffscreenCanvas(XW, XH);
    const xctx = xoff.getContext("2d", { willReadFrequently: true });
    /**
     * High-frequency spatial energy, normalized: mean |L(x,y) − L(x+1,y)| plus
     * the vertical twin, over the local mean. A converged image has smooth
     * gradients and reads LOW; alternating bright/dark neighbours read HIGH.
     * Normalizing by the mean keeps a dim room comparable to a bright one.
     */
    const checkerOf = () => {
      xctx.drawImage(canvas, (canvas.width - XW) / 2, (canvas.height - XH) / 2, XW, XH, 0, 0, XW, XH);
      const d = xctx.getImageData(0, 0, XW, XH).data;
      const L = new Float32Array(XW * XH);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        L[j] = 0.2126 * s2l(d[i] / 255) + 0.7152 * s2l(d[i + 1] / 255) + 0.0722 * s2l(d[i + 2] / 255);
      }
      let hf = 0, sum = 0, n = 0;
      for (let y = 0; y < XH - 1; y++) {
        for (let x = 0; x < XW - 1; x++) {
          const o = y * XW + x;
          hf += Math.abs(L[o] - L[o + 1]) + Math.abs(L[o] - L[o + XW]);
          sum += L[o]; n++;
        }
      }
      const m = sum / Math.max(1, n);
      return m > 1e-6 ? hf / (2 * n) / m : 0;
    };
    /**
     * ⭐⭐ `crease` — THE SECOND DIFFERENCE, BECAUSE `checker` STRUCTURALLY
     * CANNOT SEE AN INTERPOLANT ORDER CHANGE (2026-08-23).
     *
     * `checker` is a mean FIRST difference, and total variation across a cell is
     * a property of the ENDPOINTS, not of the curve between them: a linear ramp
     * and a smoothstep ramp from L0 to L1 have the SAME Σ|ΔL|. So C0 → C1
     * trilinear moves `checker` by ~nothing, and reading that as "the fix did
     * nothing" would be the same mistake `meanCorners` made about coverage.
     *
     * What the eye actually catches at a cell face is a GRADIENT STEP — Mach
     * banding — which is a second difference, and a LOCALISED one: plain
     * trilinear is perfectly smooth inside a cell and kinks only on the faces.
     * So the discriminator is the TAIL, not the mean:
     *
     *   creaseMean  mean |L(x−1) − 2L(x) + L(x+1)| (+ vertical twin) / local mean
     *   creaseP99   its 99th percentile — the crease lines themselves
     *
     * C0 predicts a low mean with a HIGH p99 (flat cells, sharp kinks on the
     * faces); C1 predicts a slightly higher mean with a much LOWER p99 (bounded
     * curvature everywhere, no kinks). p99/mean is the shape number: a large
     * ratio is a grid of lines, a small one is a smooth field.
     */
    const creaseOf = () => {
      xctx.drawImage(canvas, (canvas.width - XW) / 2, (canvas.height - XH) / 2, XW, XH, 0, 0, XW, XH);
      const d = xctx.getImageData(0, 0, XW, XH).data;
      const L = new Float32Array(XW * XH);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        L[j] = 0.2126 * s2l(d[i] / 255) + 0.7152 * s2l(d[i + 1] / 255) + 0.0722 * s2l(d[i + 2] / 255);
      }
      const vals = new Float32Array((XW - 2) * (XH - 2));
      let sum = 0, n = 0, k = 0;
      for (let y = 1; y < XH - 1; y++) {
        for (let x = 1; x < XW - 1; x++) {
          const o = y * XW + x;
          const cx = Math.abs(L[o - 1] - 2 * L[o] + L[o + 1]);
          const cy = Math.abs(L[o - XW] - 2 * L[o] + L[o + XW]);
          vals[k++] = (cx + cy) / 2;
          sum += L[o]; n++;
        }
      }
      const m = sum / Math.max(1, n);
      if (!(m > 1e-6)) return { mean: 0, p99: 0, ratio: 0 };
      const sorted = Array.prototype.slice.call(vals.subarray(0, k)).sort((a, b) => a - b);
      let acc = 0;
      for (let i = 0; i < k; i++) acc += sorted[i];
      const mean = acc / Math.max(1, k) / m;
      const p99 = sorted[Math.min(k - 1, Math.floor(k * 0.99))] / m;
      return {
        mean: +mean.toFixed(5),
        p99: +p99.toFixed(5),
        // >1 = the curvature lives in a few sharp lines (C0 creases);
        // ~1 = it is spread smoothly over the field.
        ratio: +(p99 / Math.max(1e-9, mean)).toFixed(2),
      };
    };
    const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const grab = () => {
      ctx.drawImage(canvas, 0, 0, CW, CH);
      const d = ctx.getImageData(0, 0, CW, CH).data;
      const L = new Float32Array(CW * CH);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        L[j] = 0.2126 * s2l(d[i] / 255) + 0.7152 * s2l(d[i + 1] / 255) + 0.0722 * s2l(d[i + 2] / 255);
      }
      return L;
    };
    /** Per-tile mean |a − b|, the grid the patch statistics live on. */
    const tileDiff = (a, b) => {
      const t = new Float32Array(TX * TY);
      for (let ty = 0; ty < TY; ty++) {
        for (let tx = 0; tx < TX; tx++) {
          let s = 0;
          for (let y = 0; y < TILE; y++) {
            const row = (ty * TILE + y) * CW + tx * TILE;
            for (let x = 0; x < TILE; x++) s += Math.abs(a[row + x] - b[row + x]);
          }
          t[ty * TX + tx] = s / (TILE * TILE);
        }
      }
      return t;
    };
    const mean = (a) => { let s = 0; for (const v of a) s += v; return s / a.length; };
    const std = (a) => { const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / a.length); };

    /** False-colour |L − settled|, drawn in page so node needs no encoder. */
    const heatmap = (a, b, scale) => {
      const c = document.createElement("canvas");
      c.width = CW; c.height = CH;
      const cx = c.getContext("2d");
      const img = cx.createImageData(CW, CH);
      for (let i = 0; i < CW * CH; i++) {
        const v = Math.min(1, Math.abs(a[i] - b[i]) / scale);
        // blue → cyan → yellow → red, so a patch edge is a colour edge.
        img.data[i * 4] = Math.round(255 * Math.min(1, Math.max(0, v * 2 - 0.5)));
        img.data[i * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(v - 0.5) * 3)));
        img.data[i * 4 + 2] = Math.round(255 * Math.min(1, Math.max(0, 1 - v * 2)));
        img.data[i * 4 + 3] = 255;
      }
      cx.putImageData(img, 0, 0);
      return c.toDataURL("image/png");
    };

    // ── IS THE SCENE ITSELF MOVING? ──────────────────────────────────────
    // Every GI parameter has now been swung and none of them moved the
    // transient: α 0.06→0.3 (5×) nothing, ray cap 16→64 (4×) nothing,
    // secondary off nothing, rest cadence off nothing. The one thing that
    // would explain "GI keeps changing and no GI knob affects it" is that GI
    // is correctly tracking a scene that is genuinely changing — an animating
    // character, a flickering emissive, a moving sun. This is the control that
    // should have been run first: a cheap fingerprint of the INPUTS.
    const _fpQuat = new THREE.Quaternion();
    const sceneFingerprint = () => {
      // `pose` is the BONE half on its own. The combined hash mixes bones with
      // lights, so a pose that drifted while the lights held still could not be
      // told from the reverse — and the pose is the input that voided a round of
      // A/B (see the freeze block). Reported separately so "the pose is pinned"
      // is something a run PROVES rather than claims.
      let h = 0, poseH = 0, bones = 0, lights = 0;
      engine.scene.traverse((o) => {
        if (o.isSkinnedMesh && o.skeleton?.bones?.length) {
          for (const b of o.skeleton.bones.slice(0, 6)) {
            h += b.position.x + b.position.y * 3 + b.position.z * 7
              + b.quaternion.x * 11 + b.quaternion.y * 13 + b.quaternion.z * 17;
            poseH += b.position.x + b.position.y * 3 + b.position.z * 7
              + b.quaternion.x * 11 + b.quaternion.y * 13 + b.quaternion.z * 17;
            bones++;
          }
        }
        if (o.isLight) {
          // ⚠ ORIENTATION, not just intensity. The first version of this
          // fingerprint hashed intensity and colour only, so it reported
          // "scene STATIC" while the Sun entity rotated 0.12° EVERY FRAME —
          // the single most important input in the scene, invisible to the
          // check that existed to catch exactly this.
          const q = o.getWorldQuaternion(_fpQuat);
          h += (o.intensity ?? 0) * 19 + (o.color?.r ?? 0) * 23
            + q.x * 31 + q.y * 37 + q.z * 41 + q.w * 43;
          lights++;
        }
        if (o.isMesh && o.material && !Array.isArray(o.material)) {
          const e = o.material.emissiveIntensity;
          if (typeof e === "number") h += e * 29;
        }
      });
      return { h: +h.toFixed(6), bones, lights, pose: +poseH.toFixed(6) };
    };

    const snapshot = async () => {
      const s = await system.state.screen.srcProbes.readStats(renderer);
      return {
        cascades: (s.cascades ?? []).map((c) => ({
          live: c.live, fresh: c.fresh, failed: c.failed, noBlock: c.noBlock,
          // ⭐ the population BALANCE SHEET — fresh − retired is the per-frame
          // change in live, and meanAge says how close to PROBE_MAX_AGE (60)
          // the population is sitting. See COUNTER_RETIRED in srcProbes.js.
          retired: c.retired, meanAge: c.meanAge,
          // `attempts` separates the two ways `fresh 0` happens: the insert
          // pass ran and found every key already present (healthy), or the
          // insert pass never ran at all (in which case nothing refreshed any
          // probe's age and the whole table is quietly ageing out).
          attempts: c.attempts,
          held: c.held, cap: c.probeCapacity, blocks: c.blockCapacity,
        })),
        seed: s.seed ? { probes: s.seed.probes, cold: s.seed.cold, orphans: s.seed.orphans } : null,
        // ── SURPRISE'S OWN THREE-WAY DIAGNOSTIC (srcSystem ~1888) ───────────
        // The per-block fast-α already exists: the decay mixes `keep′` toward
        // `surpriseF = TEMPORAL_ALPHA / α_now`, so a fully surprised block
        // ALREADY converges at α 0.1 instead of the still 0.02. These two
        // numbers say which of the three states we are in: never armed
        // (`boosted` 0 with nonzero mean u), never surprised (mean u 0), or
        // working. `totalRays` is the REAL fired count — `tracedRays` is only
        // an upper bound, because [D1'] clamps per probe.
        boosted: globalThis.__giSrcBoostedLive ?? null,
        meanU: globalThis.__giSrcSurpriseLive ?? null,
        alphaLive: globalThis.__giSrcAlphaLive ?? null,
        totalRays: s.totalRays ?? null,
        // ⭐ `perCascade` is the point: the aggregate orphanRate is a
        // bin-count-weighted blend over three lattices (c0 has ~64× c2's bins),
        // so it cannot name the level that is starving. See MERGE_STRIDE.
        merge: s.merge ? {
          orphanRate: s.merge.orphanRate, meanCorners: s.merge.meanCorners, bins: s.merge.bins,
          perCascade: (s.merge.perCascade ?? []).map((c) => ({
            c: c.cascade, bins: c.bins, orphanRate: c.orphanRate,
            // ⭐ the half of the orphan rate that actually cost light
            orphanLiveRate: c.orphanLiveRate,
            meanCorners: c.meanCorners, probes: c.probes,
          })),
        } : null,
        // ⚠ `coverage` / `meanKnownBins` are PRINTED by the telemetry table
        // (search "knownB") and were never captured here, so both columns have
        // read `0% 0.0` in every run this probe has ever made. Same for the
        // gather's corner counts, which are the whole "is the lattice thin or
        // just silent" question (see GG_COVERED in srcScreenGather.js).
        tiles: s.tiles ? {
          lit: s.tiles.lit, meanLum: s.tiles.meanLum,
          coverage: s.tiles.coverage, meanKnownBins: s.tiles.meanKnownBins,
          lobeBins: s.tiles.lobeBins, knownFrac: s.tiles.knownFrac,
        } : null,
        gather: s.gather ? {
          lit: s.gather.lit, pixels: s.gather.pixels, meanLum: s.gather.meanLum,
          meanCorners: s.gather.meanCorners, meanCovered: s.gather.meanCovered,
          empty: s.gather.empty,
        } : null,
      };
    };

    // ── LEG 0: get to the start pose and let the field converge fully ──────
    const legs = [];
    const nLegs = Math.min(cfg.legs, path.length - 1);
    await setPose(path[0].p, legAim(path[0].p, path[1].p)(path[0].p));
    // ── FREEZE=1: STOP THE SCENE **BEFORE** THE CONVERGENCE WAIT ──────────
    //
    // ⚠⚠ ORDER IS LOAD-BEARING, AND IT COST TWO RUNS TO LEARN. Freezing
    // AFTER the convergence wait JUMPS the sun from wherever the day cycle
    // had carried it to the fixed SUNDEG angle — a large lighting
    // discontinuity — and then measures before the field has caught up. The
    // jump distance differs every run, which is why two IDENTICAL runs
    // disagreed by 15-25x on err0 while both honestly reported "scene
    // STATIC". Freeze first; the convergence gate below then waits for the
    // FROZEN scene to settle, which is the state the legs should start from.
    //
    // ⚠⚠ THE PROBE'S FOUNDING PREMISE WAS WRONG ON THIS SCENE. "Pin the camera
    // and every remaining change is GI" assumes a STATIC scene, and this Level
    // animates a skinned character in the editor on a ~10-15 s loop — which is
    // the period of the "limit cycle" the ripple statistic was reporting, and
    // the reason no GI knob (α ×5, ray cap ×4, secondary off, rest cadence
    // off) ever moved the tail. GI was correctly tracking a moving scene.
    //
    // So: freeze every AnimationMixer, then VERIFY the fingerprint actually
    // stops moving. A freeze that silently fails would restore the exact bug
    // it exists to remove, so this reports rather than assumes.
    let frozen = null;
    if (cfg.freeze) {
      const mixers = new Set();
      for (const root of engine.rootEntities ?? []) {
        root.traverse?.((entity) => {
          const anim = entity.getComponent?.("animation");
          if (anim?.mixer) mixers.add(anim.mixer);
        });
      }
      engine.scene.traverse((o) => { if (o.userData?.mixer) mixers.add(o.userData.mixer); });
      // ⚠⚠⚠ **STOPPING THE ANIMATION IS NOT THE SAME AS FIXING THE POSE, AND
      // THE DIFFERENCE VOIDED A WHOLE ROUND OF A/B.**
      //
      // `timeScale = 0` freezes the character WHEREVER IT HAPPENED TO BE — and
      // where that is depends on how long the editor took to boot, which varies
      // by seconds. A skinned figure standing in the room is a large occluder
      // and a large receiver, so its pose moves the field: two runs of the
      // IDENTICAL arm, both honestly reporting `scene STATIC`, measured leg0
      // `checker` 0.0042 and 0.0842 — 20× — purely from where the walk cycle
      // stopped. `stopAllAction()` was worse than useless here: it stops the
      // actions and leaves the skeleton at that same arbitrary pose, while
      // making `setTime` a no-op, so the pose could not even be corrected
      // afterwards.
      //
      // `setTime(POSE_T)` drives every action to a FIXED point in its clip and
      // updates the skeleton once; `timeScale = 0` then holds it. `POSE=<sec>`
      // moves the pin if a scene's interesting pose is elsewhere.
      const poseT = cfg.poseT;
      for (const m of mixers) {
        try {
          m.timeScale = 0;
          if (Number.isFinite(poseT)) { m.setTime(poseT); m.update(0); }
        } catch { /* not a mixer */ }
      }
      // ⭐⭐ THE PROPERTY IS `scale`, NOT `timeScale`, AND THAT IS WHY THE SUN
      // WOULD NOT STOP. `TimeSystem` exposes `get/set scale` (which forwards to
      // `engine.setTimeScale`); `engine.time.timeScale = 0` therefore defined a
      // NEW own property on the instance and changed nothing at all. Every
      // earlier conclusion that "neither the mixers nor engine.time drive the
      // sun, so it must be pinned by force" rests on that typo: the day cycle
      // is `Rotator.ts`, an `@executeInEditMode` script that ASSIGNS
      // `rotation = f(engine.time.elapsed)` every editor tick, and `elapsed` is
      // game time. Stop game time and the sun stops exactly, at whatever phase
      // it had, with no per-frame fight.
      //
      // ⚠ ONLY THE FULL PIN MAY DO THIS. `off`/`dim`/`aim` need the day cycle
      // RUNNING (that is the input under study), so they keep game time and
      // hold what they hold with the quaternion/intensity pin below.
      if (cfg.sunPin === "all") {
        try {
          if (engine.time) engine.time.scale = 0;
          else engine.timeScale = 0;
        } catch { /* no clock */ }
      }
      // ── PIN THE SUN ────────────────────────────────────────────────────
      // Neither the mixers nor `engine.time` drive it: with both zeroed the
      // Sun entity kept rotating ~0.12°/frame. Whatever the driver is, holding
      // the authored quaternion and re-asserting it every frame beats it, and
      // the fingerprint below is what says whether it actually stuck.
      // ⚠⚠ PIN THE SUN TO A FIXED ANGLE, NOT TO "WHEREVER IT GOT TO".
      //
      // The day cycle turns ~5.6°/s, so every run reached a DIFFERENT sun angle
      // by the time the pin fired — i.e. every run lit the scene differently.
      // That is why `err0` for the same arm and pose ranged 0.033–0.24 across
      // runs: the instrument's variance was larger than any effect it was
      // being asked to measure, and no A/B run on it could mean anything.
      // SUNDEG fixes the angle so two runs are the same experiment.
      //
      // ⚠ SUNPIN SPLITS THE PIN IN TWO. `pinAim` holds the quaternions,
      // `pinDim` holds intensity and colour, and the `dim`/`aim` arms hold one
      // without the other so the checkerboard can be attributed to the angle or
      // to the brightness. Snapping to SUNDEG is part of the AIM pin — under
      // `dim` the sun must be left exactly where the day cycle has it, or the
      // snap becomes the lighting discontinuity §-10 spent two runs removing.
      const pins = [];
      engine.scene.traverse((o) => {
        if (!o.isLight || !cfg.pinSun) return;
        if (cfg.pinAim && o.isDirectionalLight && o.parent && Number.isFinite(cfg.sunDeg)) {
          const el = (cfg.sunDeg * Math.PI) / 180;
          o.parent.quaternion.setFromEuler(new THREE.Euler(-el, Math.PI * 0.75, 0, "YXZ"));
          o.parent.updateMatrixWorld(true);
        }
        pins.push([o, o.quaternion.clone(), o.intensity, o.color?.clone?.() ?? null]);
        if (o.parent) pins.push([o.parent, o.parent.quaternion.clone(), null, null]);
      });
      const hold = () => {
        // Orientation AND intensity: a day cycle that dims the sun would slide
        // the whole picture's brightness while the orientation pin held, and
        // the 1.5 s fingerprint check at the top would never see it.
        for (const [obj, q, intensity, color] of pins) {
          if (cfg.pinAim) obj.quaternion.copy(q);
          if (cfg.pinDim) {
            if (intensity != null) obj.intensity = intensity;
            if (color && obj.color) obj.color.copy(color);
          }
        }
        if (holding) requestAnimationFrame(hold);
      };
      let holding = true;
      requestAnimationFrame(hold);
      const a = sceneFingerprint().h;
      await sleep(1500);
      const b = sceneFingerprint().h;
      const fp = sceneFingerprint();
      frozen = {
        mixers: mixers.size, pins: pins.length, sunPin: cfg.sunPin,
        // THE POSE RECEIPT. Two runs of the same arm whose `pose` differs were
        // not the same experiment, whatever their checker numbers say.
        poseT, pose: fp.pose, bones: fp.bones,
        // A partial pin is SUPPOSED to drift — say so, rather than reporting a
        // working arm as a broken freeze.
        partial: cfg.sunPin === "dim" || cfg.sunPin === "aim",
        stable: Math.abs(a - b) < 1e-6, drift: +(b - a).toFixed(6), atFreeze: b,
      };
    }


    // CONVERGED, not "settled for N ms". A constant is a guess about a machine;
    // this waits until the picture itself stops moving, and REPORTS how long
    // that took so a run where it never converged is visible rather than
    // silently averaged in.
    let convergeMs = 0;
    {
      const t0 = performance.now();
      let prev = null, stable = 0;
      for (;;) {
        await sleep(500);
        const cur = grab();
        // A BLACK frame is perfectly stable. Requiring the picture to be lit
        // is what stops "converged" from meaning "the field has not started".
        const lit = mean(cur) > 1e-3;
        if (prev && lit) {
          stable = mean(tileDiff(cur, prev)) < 4e-4 ? stable + 1 : 0;
          if (stable >= 3 && performance.now() - t0 > 5000) break;
        }
        prev = cur;
        if (performance.now() - t0 > cfg.settle) break;
      }
      convergeMs = Math.round(performance.now() - t0);
    }

    // ── ⭐⭐ THE FIFTH UNCONTROLLED INPUT: THE SUN'S **PHASE** ───────────────
    //
    // The four inputs §-10 closed all applied to the PINNED arms. The arm that
    // reproduces the user's complaint does not pin the sun at all — and the day
    // cycle is `Rotator.ts`, `rotation = f(engine.time.elapsed)`, a ~62.8 s
    // cycle. So an unpinned run starts its walk at WHATEVER angle the clock had
    // reached, and the angle sets how much light the room gets at all: two
    // honest `PINSUN=0` runs measured leg0 `checker` 0.0415 and 0.0042, a 10×
    // spread, purely from where in the day each one happened to land.
    //
    // The fix is not to stop the sun (that deletes the phenomenon) but to START
    // EVERY LEG AT THE SAME POINT IN THE CYCLE. Game time is the driver, so
    // waiting on `engine.time.elapsed mod period` pins the angle exactly and
    // says nothing about HOW the scene turns it into a direction — any
    // elapsed-driven day cycle lands in the same place.
    //
    // ⚠ IT REPORTS THE SUN'S WORLD DIRECTION IT ACTUALLY WAITED FOR. If the
    // period is wrong for some other scene's script, two arms print different
    // directions and the control is visibly broken instead of quietly absent.
    const _sunV = new THREE.Vector3();
    const sunDir = () => {
      let d = null;
      engine.scene.traverse((o) => {
        if (d || !o.isDirectionalLight) return;
        d = _sunV.set(0, 0, -1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())).clone();
      });
      return d ? [+d.x.toFixed(4), +d.y.toFixed(4), +d.z.toFixed(4)] : null;
    };
    const phaseNow = () => {
      const e = engine.time?.elapsed;
      if (!Number.isFinite(e) || !(cfg.sunPeriod > 0)) return null;
      return ((e % cfg.sunPeriod) + cfg.sunPeriod) % cfg.sunPeriod / cfg.sunPeriod;
    };
    const alignSun = async () => {
      // Nothing to align when the sun is held still — `all`/`aim` already fix
      // the angle, and under `all` game time is stopped so this would spin
      // forever waiting for a clock that no longer advances.
      if (!cfg.sunAlign || cfg.pinAim) return null;
      const target = ((cfg.sunPhase % 1) + 1) % 1;
      const t0 = performance.now();
      let prev = phaseNow();
      if (prev == null) return null;
      for (;;) {
        await nextFrame();
        const cur = phaseNow();
        // Crossing the target, wrap included: the phase is monotone increasing
        // in game time, so a DECREASE is the wrap and both halves of the
        // interval have to be tested or an aligner can sit out a whole cycle.
        const crossed = cur < prev
          ? (target >= prev || target <= cur)
          : (target > prev && target <= cur);
        prev = cur;
        // One period plus a margin. A scene whose clock does not advance (or
        // whose period this guesses wrong) must not hang the run.
        if (crossed || performance.now() - t0 > (cfg.sunPeriod + 5) * 1000) {
          return {
            phase: +(cur ?? 0).toFixed(4), target: +target.toFixed(4),
            waitedMs: Math.round(performance.now() - t0),
            elapsed: +(engine.time?.elapsed ?? 0).toFixed(2),
            dir: sunDir(), crossed,
          };
        }
      }
    };

    for (let leg = 0; leg < nLegs; leg++) {
      const from = path[leg].p, to = path[leg + 1].p;
      // EVERY LEG STARTS AT THE SAME POINT IN THE DAY. See `alignSun`.
      const sunAt = await alignSun();
      // WALK. Small steps at frame cadence — a single setCamera jump pays the
      // motion-armed transients once instead of per frame, which is a different
      // load on the probe ladder than walking is.
      const steps = Math.max(8, Math.round(cfg.walkMs / 33));
      // ⚠ SAMPLE MID-WALK, NOT AFTER. Every earlier reading of the seed pass
      // was taken once the camera had stopped — by which time nothing is FRESH
      // any more, so `seed 0 probes / 0 cold / 0 orphan` said nothing at all
      // about whether newly-revealed probes get a usable prior. The cold-probe
      // question can only be asked while probes are actually being minted.
      let walkSample = null;
      // ONE aim direction for the whole leg — see `legAim`'s header for the
      // degenerate `target === position` bug this replaces. Computed from the
      // LEG, so it is defined at t = 1 and constant across the measurement.
      const aim = legAim(from, to);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const p = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
        await setPose(p, aim(p));
        await nextFrame();
        if (i === Math.round(steps * 0.6)) walkSample = await snapshot();
      }

      // ── PINNED. Everything from here is GI, not parallax. ────────────────
      //
      // ⚠ TELEM=1 IS A SEPARATE RUN ON PURPOSE. `readStats` is a GPU readback
      // that stalls the frame it lands on, and `maxStep` compares CONSECUTIVE
      // pinned frames — a stalled frame lets the field advance further between
      // two samples and manufactures exactly the pop the statistic exists to
      // detect. So the picture and the counters are never measured together.
      if (cfg.telem) {
        // ── STAGE ATTRIBUTION ────────────────────────────────────────────
        // The chain is deposit → merge → TILES → screen GATHER → irradiance
        // temporal filter → composite → DISPLAYED. Each of the last stages
        // publishes its own mean, so sampling all of them plus the actual
        // pixels on ONE timeline says which stage's curve is the slow one
        // instead of which stage we guessed. Safe to mix the readback with a
        // frame grab HERE (unlike the image burst) because TELEM computes no
        // consecutive-frame statistic for a stalled frame to corrupt.
        const series = [];
        const t0 = performance.now();
        while (performance.now() - t0 < cfg.burstMs + cfg.tailMs) {
          const s = await snapshot();
          // ⚠ MUST be inside a fresh frame: drawImage on the WebGPU canvas
          // outside a rAF returns a cleared buffer, which reads as a column of
          // honest-looking zeros rather than as an error.
          await nextFrame();
          const disp = mean(grab());
          series.push({ t: Math.round(performance.now() - t0), s, disp, scene: sceneFingerprint() });
          await sleep(250);
        }
        legs.push({
          from, to,
          dist: +Math.hypot(to[0] - from[0], to[2] - from[2]).toFixed(2),
          telem: series,
        });
        continue;
      }
      const frames = [];
      const times = [];
      const checkers = [];
      const creases = [];
      const tArrive = performance.now();
      // A marker ON THE CONSOLE, so the node side can put the picture's
      // timeline and the engine's own log/errors on ONE clock. Correlating a
      // page `performance.now()` against node `Date.now()` by hand is an
      // offset nobody can defend in a bug report.
      console.log(`[probe] ARRIVE leg${leg}`);
      const transportArrive = { ...(globalThis.__giSrcTransport ?? {}) };
      // The telemetry read is a GPU readback and would stall the very first
      // frames, so it goes AFTER a short burst head — the numbers still
      // describe the arrival, and the head is where `maxStep` usually lands.
      let arrival = null;
      while (performance.now() - tArrive < cfg.burstMs) {
        await nextFrame();
        frames.push(grab());
        checkers.push(checkerOf());
        // Every 4th frame: the sort inside `creaseOf` is ~100k elements and
        // must not become the thing that stalls the frame `maxStep` compares.
        if (creases.length === 0 || frames.length % 4 === 0) creases.push(creaseOf());
        times.push(performance.now() - tArrive);
        if (arrival === null && times[times.length - 1] > 250) {
          arrival = await snapshot();
        }
      }
      await sleep(cfg.tailMs);
      await nextFrame();
      const settled = grab();
      const rest = await snapshot();

      // Error against the settled frame, per burst frame.
      const err = frames.map((f) => mean(tileDiff(f, settled)));
      const err0 = err[0];
      // The step statistic: biggest single-tile jump between consecutive pinned
      // frames, and when it happened. A 40 ms pop is what the eye reports as
      // "a block updated"; the mean curve hides it completely.
      let maxStep = 0, maxStepAt = 0;
      for (let i = 1; i < frames.length; i++) {
        const t = tileDiff(frames[i], frames[i - 1]);
        let m = 0;
        for (const v of t) if (v > m) m = v;
        if (m > maxStep) { maxStep = m; maxStepAt = times[i]; }
      }
      // ── RIPPLE: does it ever actually STOP? ──────────────────────────────
      // Over the SECOND HALF of the pinned window, long after any arrival
      // transient, the coefficient of variation of whole-frame brightness. A
      // converged field is a flat line (ripple ≈ 0); a limit cycle is not, and
      // no error-against-a-reference statistic can tell them apart because the
      // reference is itself a point on the cycle.
      const tail = frames.slice(Math.floor(frames.length / 2)).map((f) => mean(f));
      const tailMean = mean(tail);
      const ripple = tailMean > 1e-6 ? std(tail) / tailMean : 0;
      const t0Tiles = tileDiff(frames[0], settled);
      const patch0 = mean(t0Tiles) > 1e-9 ? std(t0Tiles) / mean(t0Tiles) : 0;
      // settle95: first time err drops under 5% of err0 and never comes back.
      let settle95 = null;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (err[i] > err0 * 0.05) { settle95 = times[Math.min(i + 1, times.length - 1)]; break; }
      }
      if (settle95 === null) settle95 = 0;

      legs.push({
        from, to,
        dist: +Math.hypot(to[0] - from[0], to[2] - from[2]).toFixed(2),
        err0: +err0.toFixed(5),
        errMid: +err[Math.floor(frames.length / 2)].toFixed(5),
        settle95: Math.round(settle95),
        maxStep: +maxStep.toFixed(5),
        maxStepAt: Math.round(maxStepAt),
        patch0: +patch0.toFixed(2),
        ripple: +ripple.toFixed(3),
        // ⭐ THE USER'S ARTIFACT, DIRECTLY: how blocky the picture is at ARRIVAL
        // versus once settled, and how long the blockiness takes to fall.
        checker0: +(checkers[0] ?? 0).toFixed(4),
        checkerEnd: +(checkers[checkers.length - 1] ?? 0).toFixed(4),
        crease0: creases[0] ?? null,
        creaseEnd: creases[creases.length - 1] ?? null,
        checkerCurve: checkers.filter((_, i) => i % Math.ceil(checkers.length / 12) === 0)
          .map((v) => +v.toFixed(4)),
        // Time for the excess high-frequency energy to fall to 20% of its
        // arrival excess over the settled floor — "how long until it looks
        // properly lit", in the user's words.
        checkerSettle: (() => {
          const fin = checkers[checkers.length - 1] ?? 0;
          const exc = (checkers[0] ?? 0) - fin;
          if (exc <= 1e-6) return 0;
          for (let i = 0; i < checkers.length; i++) {
            if (checkers[i] - fin <= exc * 0.2) return Math.round(times[i]);
          }
          return Math.round(times[times.length - 1] ?? 0);
        })(),
        // Captures happen once per rAF, so this IS the frame rate — and the
        // 60 fps floor outranks every quality win here, so no arm that costs
        // rays may be read without it.
        fps: +(frames.length / (cfg.burstMs / 1000)).toFixed(1),
        tailMean: +tailMean.toFixed(5),
        frames: frames.length,
        arrival, rest, walkSample,
        // Curve, decimated — enough to see whether it decays smoothly or in
        // steps, which is the difference between "slow" and "patchy".
        curve: err.filter((_, i) => i % Math.ceil(frames.length / 12) === 0).map((v) => +v.toFixed(5)),
        // ABSOLUTE brightness over the same window. `err` is relative to a
        // reference frame and says nothing if the picture never settles — this
        // says what it is actually DOING: converging to a plateau, ramping, or
        // oscillating. Without it a drifting field and a converged one produce
        // the same-looking error curve.
        // Carries its own TIMES so a spike can be correlated against the
        // engine's console log — "it flashed at some point" is not a lead.
        lum: frames.map((f, i) => [Math.round(times[i]), +mean(f).toFixed(5)])
          .filter((_, i) => i % Math.ceil(frames.length / 24) === 0),
        /** Wall-clock at arrival, so console timestamps line up with `lum`. */
        arriveAt: Math.round(tArrive - startedAt),
        /** Where in the day this leg STARTED, and the direction it waited for. */
        sunAt,
        /** And where the sun had reached by the time the leg was measured. */
        sunEnd: sunDir(),
        // §12.61's published transport state. `stride` is the number of frames
        // it takes for every pixel to receive evidence ONCE — so it is both the
        // settle time's multiplier AND, because the selected pixel is
        // `thread·stride + phase` (a linear index), the PITCH of the lattice
        // that marches across anything still changing.
        transport: { ...(globalThis.__giSrcTransport ?? {}) },
        transportArrive,
        heat: cfg.png ? heatmap(frames[0], settled, Math.max(1e-4, err0 * 6)) : null,
      });
    }

    // ⚠ DID IT STAY STATIC? The 1.5 s check above says the freeze TOOK; it says
    // nothing about the following two minutes. Two runs that both certified
    // "scene STATIC" settled to brightnesses 48x apart, so the end-of-run
    // fingerprint is the check that was actually missing.
    if (frozen) {
      const end = sceneFingerprint().h;
      frozen.endDrift = +(end - frozen.atFreeze).toFixed(6);
      frozen.heldThroughout = Math.abs(frozen.endDrift) < 1e-6;
    }
    return {
      quality: system.config?.quality ?? null,
      canvas: `${canvas.width}x${canvas.height}`,
      rooms: rooms.length,
      convergeMs,
      frozen,
      path: path.map((w) => w.p.map((v) => +v.toFixed(1))),
      legs,
    };
  }, { ...CFG, png: wantPng });

  if (wantPng && !out.fail) {
    const shot = await page.screenshot({ encoding: "base64" });
    writeFileSync(`${OUT}/${arm}-settled.png`, Buffer.from(shot, "base64"));
    (out.legs ?? []).forEach((l, i) => {
      if (!l.heat) return;
      writeFileSync(`${OUT}/${arm}-leg${i}-error.png`, Buffer.from(l.heat.split(",")[1], "base64"));
      delete l.heat;
    });
  }
  await context.close();
  // The window around each arrival, deduplicated by message: a storm of 300
  // identical validation errors is one FACT plus a count, and printing it 300
  // times buries the one line that explains it.
  const windows = [];
  for (const [i, mark] of all.filter(([, , t]) => t.startsWith("[probe] ARRIVE")).entries()) {
    const at = mark[0];
    const seen = new Map();
    for (const [t, type, text] of all) {
      if (t < at - 3 || t > at + 22) continue;
      if (text.startsWith("[probe]")) continue;
      const key = text.slice(0, 90);
      if (!seen.has(key)) seen.set(key, { first: t, last: t, n: 0, type, text });
      const e = seen.get(key);
      e.last = t; e.n++;
    }
    windows.push({ leg: i, at, lines: [...seen.values()] });
  }
  return { arm, ...out, gi, errors, windows };
}

const results = [];
for (const arm of ARMS) {
  process.stdout.write(`\n── ${arm} ──────────────────────────────────────────\n`);
  try {
    const r = await runArm(arm);
    results.push(r);
    if (r.fail) { console.log(`  FAIL ${r.fail}`); continue; }
    // A PARTIAL sun pin (`dim`/`aim`) is a deliberately moving scene, so its
    // drift is the arm doing its job. Printing it as "⚠ STILL MOVING" would
    // read as a broken freeze and get the run thrown away.
    const drifted = r.frozen && !r.frozen.stable;
    const freezeNote = r.frozen
      ? `  FROZEN(${r.frozen.mixers} mixers @t=${r.frozen.poseT}s pose#${r.frozen.pose} (${r.frozen.bones} bones) + ${r.frozen.pins} light pins, sun=${r.frozen.sunPin}, ${
        r.frozen.partial
          ? `sun free by design, drift ${r.frozen.drift}`
          : drifted ? `⚠ STILL MOVING drift ${r.frozen.drift}` : "scene STATIC"
      }${r.frozen.partial ? "" : r.frozen.heldThroughout === false ? `, ⚠⚠ DRIFTED BY END ${r.frozen.endDrift}` : ", held throughout"})`
      : "";
    console.log(`  canvas ${r.canvas}  quality ${r.quality}  rooms ${r.rooms}  start converged in ${r.convergeMs} ms${freezeNote}  path ${JSON.stringify(r.path)}`);
    for (const [i, l] of (r.legs ?? []).entries()) {
      if (l.telem) {
        console.log(`  leg${i} ${JSON.stringify(l.from.map((v) => +v.toFixed(1)))} → ${JSON.stringify(l.to.map((v) => +v.toFixed(1)))} (${l.dist} m) — TELEMETRY, camera pinned from t=0`);
        // Each stage is ALSO shown normalized to its own final value, because
        // the stages have different units and only their SHAPES are
        // comparable — a stage that is already flat while the next is still
        // climbing is upstream of the lag.
        const last = l.telem[l.telem.length - 1] ?? {};
        const fT = last.s?.tiles?.meanLum || 1, fG = last.s?.gather?.meanLum || 1, fD = last.disp || 1;
        const n = (v, f) => (f ? (v / f) : 0).toFixed(2).padStart(6);
        console.log(`    ${"t".padStart(6)} ${"alpha".padStart(6)} ${"rays".padStart(7)} ${"cover".padStart(6)} ${"knownB".padStart(6)} | ${"tiles".padStart(7)} ${"gather".padStart(7)} ${"disp".padStart(8)} | normalized tiles/gather/disp`);
        const h0 = l.telem[0]?.scene?.h ?? 0;
        console.log(`    scene inputs: ${l.telem[0]?.scene?.bones ?? 0} bones, ${l.telem[0]?.scene?.lights ?? 0} lights sampled`);
        for (const { t, s, disp, scene } of l.telem) {
          const ti = s.tiles?.meanLum ?? 0, ga = s.gather?.meanLum ?? 0;
          if (scene && Math.abs(scene.h - h0) > 1e-6) {
            console.log(`    ${String(t).padStart(6)} ⚠ SCENE INPUT CHANGED (fingerprint ${scene.h} vs ${h0}) — GI is tracking a MOVING scene`);
          }
          console.log(`    ${String(t).padStart(6)} ${(s.alphaLive ?? 0).toFixed(4).padStart(6)} ${String(s.totalRays ?? "-").padStart(7)} ` +
            `${((s.tiles?.coverage ?? 0) * 100).toFixed(0).padStart(5)}% ${(s.tiles?.meanKnownBins ?? 0).toFixed(1).padStart(6)} | ` +
            `${ti.toFixed(4).padStart(7)} ${ga.toFixed(4).padStart(7)} ${(disp ?? 0).toFixed(5).padStart(8)} |  ${n(ti, fT)} ${n(ga, fG)} ${n(disp, fD)}`);
        }
        continue;
      }
      console.log(`  leg${i} ${JSON.stringify(l.from.map((v) => +v.toFixed(1)))} → ${JSON.stringify(l.to.map((v) => +v.toFixed(1)))} (${l.dist} m, ${l.frames} pinned frames)`);
      console.log(`    err0 ${l.err0}  mid ${l.errMid}  settle95 ${l.settle95} ms  ⭐ maxStep ${l.maxStep} @${l.maxStepAt} ms  patch0 ${l.patch0}`);
      // THE SUN'S PHASE RECEIPT. Two arms whose `sun@` lines differ were not
      // the same experiment, whatever their `checker` numbers say.
      if (l.sunAt || l.sunEnd) {
        console.log(`    sun@start phase ${l.sunAt?.phase ?? "—"}/${l.sunAt?.target ?? "—"} dir ${JSON.stringify(l.sunAt?.dir ?? null)}${l.sunAt && !l.sunAt.crossed ? " ⚠ TIMED OUT — not aligned" : ""}${l.sunAt ? ` (waited ${l.sunAt.waitedMs} ms)` : ""}  →  sun@measure ${JSON.stringify(l.sunEnd)}`);
      }
      console.log(`    ⭐⭐ checker ${l.checker0} → ${l.checkerEnd} (settles ${l.checkerSettle} ms) — blockiness, native res`);
      if (l.crease0 && l.creaseEnd) {
        // ⚠ `checker` is a FIRST difference and conserves total variation, so it
        // is blind to an interpolant ORDER change. This is the second one — the
        // gradient STEP at a cell face, which is what Mach banding actually is.
        // p99/mean is the shape: high = the curvature is concentrated in a few
        // sharp lines (a grid); ~1 = it is spread smoothly across the field.
        console.log(`    ⭐⭐ crease  p99 ${l.crease0.p99} → ${l.creaseEnd.p99}` +
          `   mean ${l.crease0.mean} → ${l.creaseEnd.mean}` +
          `   p99/mean ${l.crease0.ratio} → ${l.creaseEnd.ratio}  — cell-face gradient steps`);
      }
      console.log(`       ${l.checkerCurve.join(" ")}`);
      console.log(`    ⭐ ripple ${l.ripple} (tail mean luma ${l.tailMean}) — 0 = the picture finally stops moving   |   ${l.fps} fps`);
      console.log(`    curve ${l.curve.join(" ")}`);
      const tr = (t) => `stride ${t?.stride} rest×${t?.restFactor?.toFixed?.(2)} ceiling ${t?.ceiling} traced ${t?.tracedRays}`;
      console.log(`    transport at arrival: ${tr(l.transportArrive)}`);
      console.log(`    transport at rest:    ${tr(l.transport)}`);
      console.log(`    lum (page-clock s : mean luma, arrival at ${(l.arriveAt / 1000).toFixed(1)}s)`);
      console.log(`      ${l.lum.map(([t, v]) => `${((l.arriveAt + t) / 1000).toFixed(1)}s:${v}`).join("  ")}`);
      for (const [tag, s] of [["MID-WALK", l.walkSample], ["arrival", l.arrival], ["rest", l.rest]]) {
        if (!s) continue;
        console.log(`    ${tag}: ${s.cascades.map((c, ci) =>
          `c${ci} live ${c.live}/${c.cap} fresh ${c.fresh}` +
          ` retired ${c.retired ?? "?"} age ${(c.meanAge ?? 0).toFixed(1)}/60` +
          (c.failed ? ` FAILED ${c.failed}` : "") +
          (c.noBlock ? ` NOBLOCK ${c.noBlock}/${c.blocks}` : "") +
          (c.held ? ` held ${c.held}` : "")).join(" | ")}`);
        console.log(`      seed ${s.seed ? `${s.seed.probes} probes, ${s.seed.cold} cold, ${s.seed.orphans} orphan` : "n/a"}` +
          `  merge orphan ${((s.merge?.orphanRate ?? 0) * 100).toFixed(1)}% corners ${s.merge?.meanCorners?.toFixed?.(2)}/8` +
          // ⭐ THE LEVEL THAT IS STARVING. orphan%/corners per cascade — the
          // aggregate above is bin-weighted and cannot say which one.
          ((s.merge?.perCascade ?? []).filter((c) => c.bins > 0).length
            ? ` [${(s.merge.perCascade).filter((c) => c.bins > 0)
              .map((c) => `c${c.c} ${(c.orphanRate * 100).toFixed(0)}%(${((c.orphanLiveRate ?? 0) * 100).toFixed(0)}live)/${c.meanCorners.toFixed(1)} p${c.probes}`).join(" ")}]`
            : "") +
          `  gather ${s.gather?.lit}/${s.gather?.pixels} mean ${s.gather?.meanLum?.toFixed?.(4)}` +
          // ⭐ THE PAIR. corners = had a block; covered = actually voted. A big
          // gap means the cell is being answered by one probe = a flat plateau.
          ` corners ${s.gather?.meanCorners?.toFixed?.(2)}/8 covered ${s.gather?.meanCovered?.toFixed?.(2)}/8` +
          (s.gather?.empty ? ` EMPTY ${s.gather.empty}` : "") +
          // ⚠ /lobeBins, NOT /32: `known` only counts bins whose patch crosses
          // the texel's horizon (~20.1 at w0=4), so /32 understated it by 59%.
          ` | tiles cover ${((s.tiles?.coverage ?? 0) * 100).toFixed(0)}% knownBins ${(s.tiles?.meanKnownBins ?? 0).toFixed(1)}/${(s.tiles?.lobeBins ?? 32).toFixed(1)} (${((s.tiles?.knownFrac ?? 0) * 100).toFixed(0)}%)`);
      }
    }
    for (const w of r.windows ?? []) {
      console.log(`  ── console around leg${w.leg} arrival (node clock ${w.at.toFixed(1)}s, −3s…+22s) ──`);
      if (!w.lines.length) console.log("    (silence — the engine logged nothing while the picture moved)");
      for (const l of w.lines) {
        console.log(`    ${l.first.toFixed(1)}s${l.n > 1 ? `..${l.last.toFixed(1)}s ×${l.n}` : "        "} [${l.type}] ${l.text.replace(/\s+/g, " ").slice(0, 150)}`);
      }
    }
    // ⚠ THE LAST SIX, **PLUS THE ARM RECEIPTS**. The lines that say WHICH ARM
    // actually compiled are printed at BOOT — first of hundreds — so a plain
    // tail dropped every one of them, and a run could report an experiment it
    // had not performed. Anything naming a unit or a picked slot is kept
    // wherever it landed in the log.
    const receipts = r.gi.filter((l) => /§\d|sun slot|ARMED|: OFF \(/.test(l));
    for (const l of [...new Set([...receipts, ...r.gi.slice(-6)])]) console.log(`  ${l}`);
  } catch (e) {
    console.log(`  ARM THREW ${String(e.message ?? e).slice(0, 300)}`);
  }
}
await browser.close();

if (results.length > 1) {
  console.log(`\n── VERDICT ────────────────────────────────────────────`);
  const agg = (r) => {
    const ls = r.legs ?? [];
    if (!ls.length) return null;
    return {
      err0: ls.reduce((s, l) => s + l.err0, 0) / ls.length,
      settle95: ls.reduce((s, l) => s + l.settle95, 0) / ls.length,
      maxStep: Math.max(...ls.map((l) => l.maxStep)),
      patch0: ls.reduce((s, l) => s + l.patch0, 0) / ls.length,
      ripple: ls.reduce((s, l) => s + (l.ripple ?? 0), 0) / ls.length,
      fps: ls.reduce((s, l) => s + (l.fps ?? 0), 0) / ls.length,
    };
  };
  for (const r of results) {
    const a = agg(r);
    if (!a) { console.log(`  ${r.arm}: no legs`); continue; }
    console.log(`  ${r.arm.padEnd(12)} err0 ${a.err0.toFixed(5)}  settle95 ${Math.round(a.settle95)} ms  maxStep ${a.maxStep.toFixed(5)}  patch0 ${a.patch0.toFixed(2)}  ripple ${a.ripple.toFixed(3)}  ${a.fps.toFixed(1)} fps`);
  }
}
