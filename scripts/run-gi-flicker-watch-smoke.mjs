// SMOKE: the LIVE flicker watch (`profile.flicker`) boots, counts, and reduces.
//
// The op it exercises is meant to be run against the USER'S OWN session, so it
// gets a smoke test on the harness first: a broken kernel or a bad readback in
// GISystem's tick would otherwise land in their editor as a black viewport.
//
// Checks, in order of what would actually go wrong:
//   1. the op exists and returns (the accumulator compiles, the readback works)
//   2. it counted frames  — a window that sees 0 frames is a suspended viewport
//   3. it saw MOVEMENT    — `movedShare` 0 with a live scene means the compute
//                           pipeline never landed and the whole thing is a
//                           silent no-op (§11.7's rule, restated per instrument)
//   4. the dials came back — the picture and the machinery on ONE timeline is
//                           the entire reason this exists rather than another
//                           puppeteer script
//   5. a PARKED scene is quieter than a SWUNG one — the instrument must be able
//      to tell the two apart, or it cannot be used to judge a fix
//
//   node scripts/run-gi-flicker-watch-smoke.mjs [url]
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = `${PROJECT}/${process.env.SCENE ?? "scenes/Sponza.scene"}`;
const SECONDS = Number(process.env.SECONDS ?? 5);
// §11.34: `LIGHTS_STATIC=1` declares every light static (`__giLightsStatic`)
// so the converged-idle gate can engage on a scene whose authored lights are
// movable. The receipts then are: the world chain ASLEEP after the parked
// window, and the light-response step still waking it (arm 4 unchanged).
const LIGHTS_STATIC = process.env.LIGHTS_STATIC === "1";
// §11.36: `WORLD_MOTION_REST=1` arms the converged-motion cadence (needs
// LIGHTS_STATIC=1 to engage) — the swung arm's fps and churn are its receipts.
const WORLD_MOTION_REST = process.env.WORLD_MOTION_REST === "1";
// FLAGS='{"__giEmitterStaticCache":false}' — any `globalThis.__gi*` hatch,
// set before the engine boots (the way the editor's localStorage flags are).
const FLAGS = process.env.FLAGS ? JSON.parse(process.env.FLAGS) : {};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  protocolTimeout: 600_000,
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/flicker|FLICKER|field ready/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`);
  if (m.type() === "error") {
    errors.push(t.slice(0, 200));
    // Timestamped as it happens: the summary at the end cannot say WHICH arm
    // a device loss landed in, and that is the whole question.
    console.log(`  [${new Date().toISOString().slice(11, 19)}] console.error: ${t.slice(0, 160)}`);
  }
});
page.on("pageerror", (e) => errors.push(`pageerror ${String(e.message ?? e).slice(0, 200)}`));
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project, lightsStatic, motionRest, flags) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  if (lightsStatic) globalThis.__giLightsStatic = true;
  if (motionRest) globalThis.__giWorldMotionRest = true;
  for (const [k, v] of Object.entries(flags ?? {})) globalThis[k] = v;
}, PROJECT, LIGHTS_STATIC, WORLD_MOTION_REST, FLAGS);
if (Object.keys(FLAGS).length) console.log(`  flags: ${JSON.stringify(FLAGS)}`);

let fail = 0;
const check = (ok, name, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

try {
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  // The editor boots into its HUB, not a project — clicking the recent row is
  // how every probe in this directory opens one (see run-gi-walk-patches).
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 120_000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  await page.waitForFunction(() => !!globalThis.__editorApi?.call, { timeout: 180_000 });
  await page.evaluate((scene) => globalThis.__editorApi.call("scene.open", { path: scene }), SCENE);
  // ⚠ `ensureEngine()` is what CREATES the engine — there is no `globalThis
  // .engine` to poll until something has called it (the walk probe's own note).
  // Wait for the FIELD, not a clock: measuring before it exists measures boot.
  let ready = false;
  // BOOT_DEADLINE_S: Bistro boots past the 300 s default in headless Chrome.
  const bootDeadline = Date.now() + Number(process.env.BOOT_DEADLINE_S ?? 300) * 1000;
  while (Date.now() < bootDeadline) {
    ready = await page.evaluate(async () => {
      const { ensureEngine } = await import("/src/editor/engineInstance.js");
      const engine = await ensureEngine();
      return !!engine?.modules?.get?.("gi")?.system?._giTargets?.irradiance;
    }).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check(ready, "GI irradiance target exists");
  if (!ready) throw new Error("no field");
  await page.evaluate(() => new Promise((r) => setTimeout(r, 12_000)));

  console.log(`  [${new Date().toISOString().slice(11, 19)}] ── ARM 1: PARKED`);
  // ── ARM 1: PARKED. Nothing moves; the watch should be quiet. ────────────
  const parked = await page.evaluate(
    (s) => globalThis.__editorApi.call("profile.flicker", { seconds: s }),
    SECONDS,
  );
  console.log(`  parked : frames ${parked.frames} @ ${parked.fps} fps, moved ${(parked.movedShare * 100).toFixed(1)}%, ` +
    `rev/px/frame ${parked.reversalsPerFrame}, churn ${(parked.churnShare * 100).toFixed(2)}%, ` +
    `stepP95 ${parked.stepP95OfMean}x mean`);
  check(parked.frames > 10, "counted frames", `${parked.frames}`);
  check(!!parked.signals?.alpha, "dials came back", JSON.stringify(parked.signals?.alpha ?? null));
  check(Array.isArray(parked.tileReversalsPerFrame) && parked.tileReversalsPerFrame.length === 9,
    "16x9 tile grid", `${parked.tileReversalsPerFrame?.length} rows`);
  // §11.34 the converged-idle receipt: parked for 12 s + the window, every
  // light static → the world chain must be asleep; without the declaration it
  // must NOT be (the reason names the movable light).
  const holdParked = await page.evaluate(() => globalThis.__editorApi.call("profile.frameStats", { settleMs: 0 }));
  const idleP = holdParked?.giHold ?? {};
  console.log(`  idle   : parked worldIdle ${idleP.worldIdle} (${idleP.worldIdleFrames} frames) — ${idleP.worldIdleReason}; worldHz ${idleP.worldHz}, rested ${idleP.worldRested}; breakers ${JSON.stringify(idleP.quietBreakers)}; restTerms ${JSON.stringify(idleP.restTerms)}`);
  if (LIGHTS_STATIC) check(idleP.worldIdle === true, "world chain asleep with every light static", String(idleP.worldIdleReason));
  else check(idleP.worldIdle !== true, "world chain awake with movable lights", String(idleP.worldIdleReason));
  // §11.40 the parked frame's receipts: the GPU split, how many of the last
  // frames were movers-only (the static key held while the character moved —
  // the frames the static visibility cache serves), and the emitter
  // marcher's cost at stride 1 (every pixel marches) vs the cache arm
  // (profile.giPasses sets the movers-only stride, fills the cache and times
  // it). A held cost that is not well under the stride-1 cost means the
  // cache is not being read.
  console.log(`  parked : gpu ${holdParked?.gpuMs} ms (render ${holdParked?.gpuRenderMs}, compute ${holdParked?.gpuComputeMs}) @ ${holdParked?.fps} fps, ` +
    `moverOnlyFrames ${idleP.moverOnlyFrames}, staticHeldFrames ${idleP.staticHeldFrames}, gbufferHeldFrames ${idleP.gbufferHeldFrames}, ` +
    `emitter chain last frame: ${JSON.stringify(Object.fromEntries(Object.entries(idleP.dispatchedLastFrame?.byName ?? {}).filter(([k]) => k.startsWith("emitter"))))}`);
  const passes = await page.evaluate(() => globalThis.__editorApi.call("profile.giPasses", { samples: 20 }).catch((e) => ({ error: String(e?.message ?? e) })));
  if (passes?.error) console.log(`  passes : ${passes.error}`);
  else {
    const sp = passes.screenPassesMs ?? {};
    const cacheKey = Object.keys(sp).find((k) => k.startsWith("emitterShadowPass (movers-only"));
    console.log(`  passes : emitterShadowPass ${sp.emitterShadowPass} ms; ${cacheKey ?? "cache arm MISSING"} ${cacheKey ? sp[cacheKey] : ""} ms; ` +
      `snapshot ${passes.queueMs?.emitterStaticSnapshotPass} ms; bvhHitShade ${passes.queueMs?.bvhHitShade} ms; queue ${passes.queueTotalMs} ms; ` +
      `emitters ${passes.emitters}, emitterShadow px ${JSON.stringify(passes.pixels?.emitterShadow)}`);
    if (cacheKey && typeof sp[cacheKey] === "number" && typeof sp.emitterShadowPass === "number") {
      check(sp[cacheKey] < sp.emitterShadowPass * 0.8, "static cache cuts the held emitter march",
        `${sp.emitterShadowPass} -> ${sp[cacheKey]} ms (${(sp[cacheKey] / sp.emitterShadowPass * 100).toFixed(0)} %)`);
    }
  }

  console.log(`  [${new Date().toISOString().slice(11, 19)}] ── ARM 2: SWUNG`);
  // ── ARM 2: SWUNG. Orbit the camera through the window. ──────────────────
  const swung = await page.evaluate(async (s) => {
    const api = globalThis.__editorApi;
    const cam = await api.call("viewport.getCamera", {});
    const [tx, ty, tz] = cam.target;
    const dx = cam.position[0] - tx, dz = cam.position[2] - tz;
    // Swing while the watch runs — `profile.flicker` resolves only when the
    // window closes, so the orbit has to be launched BESIDE it, not awaited.
    // stillOnly:false on purpose — this arm is asking whether the instrument
    // can tell motion from stillness at all, and the default would skip every
    // frame of an orbit and report nothing.
    const done = api.call("profile.flicker", { seconds: s, stillOnly: false });
    const t0 = performance.now();
    while (performance.now() - t0 < s * 1000) {
      const a = ((performance.now() - t0) / 1000) * 0.9;
      const c = Math.cos(a), n = Math.sin(a);
      await api.call("viewport.setCamera", {
        position: [tx + dx * c - dz * n, cam.position[1], tz + dx * n + dz * c],
        target: [tx, ty, tz],
      });
      await new Promise((r) => requestAnimationFrame(r));
    }
    return done;
  }, SECONDS);
  const holdSwung = await page.evaluate(() => globalThis.__editorApi.call("profile.frameStats", { settleMs: 0 }));
  console.log(`  swung  : gpu ${holdSwung?.gpuMs} ms (render ${holdSwung?.gpuRenderMs}, compute ${holdSwung?.gpuComputeMs}), motionRest ${holdSwung?.giHold?.worldMotionRest}, worldHz ${holdSwung?.giHold?.worldHz}, restTerms ${JSON.stringify(holdSwung?.giHold?.restTerms)}`);
  if (WORLD_MOTION_REST) check(holdSwung?.giHold?.worldMotionRest === true, "world chain at the rest cadence under motion",
    `motionRest ${holdSwung?.giHold?.worldMotionRest}, worldHz ${holdSwung?.giHold?.worldHz}`);
  console.log(`  swung  : frames ${swung.frames} @ ${swung.fps} fps, moved ${(swung.movedShare * 100).toFixed(1)}%, ` +
    `rev/px/frame ${swung.reversalsPerFrame}, churn ${(swung.churnShare * 100).toFixed(2)}%, ` +
    `stepP95 ${swung.stepP95OfMean}x mean`);
  check(swung.frames > 10, "counted frames while swinging", `${swung.frames}`);
  check(swung.movedShare > 0.05, "SAW MOVEMENT (the pipeline landed)", `${(swung.movedShare * 100).toFixed(1)}% of pixels`);
  // The discriminating check: an instrument that reports the same number for a
  // parked scene and an orbiting one cannot be used to judge anything.
  check(swung.movedShare > parked.movedShare, "tells parked from swung",
    `moved ${(parked.movedShare * 100).toFixed(1)}% -> ${(swung.movedShare * 100).toFixed(1)}%`);
  console.log(`  camera-motion dial: parked ${JSON.stringify(parked.signals?.cameraMotion)} vs swung ${JSON.stringify(swung.signals?.cameraMotion)}`);

  console.log(`  [${new Date().toISOString().slice(11, 19)}] ── ARM 3: SWUNG, stillOnly`);
  // ── ARM 3: SWUNG, stillOnly (the DEFAULT). The whole window is motion, so
  // the watch must count NOTHING and say so rather than return a zero that
  // reads like a calm field. This is the guard on the guard.
  const swungStill = await page.evaluate(async (s) => {
    const api = globalThis.__editorApi;
    const cam = await api.call("viewport.getCamera", {});
    const [tx, ty, tz] = cam.target;
    const dx = cam.position[0] - tx, dz = cam.position[2] - tz;
    const done = api.call("profile.flicker", { seconds: s });
    const t0 = performance.now();
    while (performance.now() - t0 < s * 1000) {
      const a = ((performance.now() - t0) / 1000) * 0.9;
      const c = Math.cos(a), n = Math.sin(a);
      await api.call("viewport.setCamera", {
        position: [tx + dx * c - dz * n, cam.position[1], tz + dx * n + dz * c],
        target: [tx, ty, tz],
      });
      await new Promise((r) => requestAnimationFrame(r));
    }
    return done;
  }, SECONDS);
  check(swungStill.movingFramesSkipped > 10, "stillOnly skips moving frames",
    `${swungStill.movingFramesSkipped} skipped, ${swungStill.frames} counted`);
  check(/NO STILL FRAMES|counted frames/.test(swungStill.note ?? ""), "says why it counted little");

  console.log(`  [${new Date().toISOString().slice(11, 19)}] ── ARM 4: THE LIGHT-RESPONSE GATE`);
  // ── ARM 4: THE LIGHT-RESPONSE GATE (plan 11.23). Steps the sun 25 deg and
  // must (a) run its kernel, (b) see the picture CHANGE, (c) see it settle.
  // A gate that cannot see its own step is the blind instrument this whole
  // file exists to prevent.
  const lr = await page.evaluate(() => globalThis.__editorApi.call("profile.lightResponse", { stepDeg: 25, seconds: 6 }));
  console.log(`  light  : frames ${lr.frames}, change ${((lr.changeOfBaseline ?? 0) * 100).toFixed(1)}%, err0 ${lr.err0}, ` +
    `t50 ${lr.t50Ms} ms, t90 ${lr.t90Ms} ms, monotone ${((lr.monotoneShare ?? 0) * 100).toFixed(0)}%` +
    (lr.error ? ` ERROR ${lr.error}` : "") + (lr.pipelinePending ? " PIPELINE PENDING" : ""));
  check(!lr.pipelinePending && !lr.error, "light-response kernel ran", lr.error ?? (lr.pipelinePending ? "pending" : ""));
  check((lr.changeOfBaseline ?? 0) > 0.02, "the step reached the picture", `${((lr.changeOfBaseline ?? 0) * 100).toFixed(1)}% change`);
  check(lr.t90Frames >= 0, "the picture settled within the window", `t90 ${lr.t90Frames} frames`);
  // The wake receipt: the sun step lifted the drive, so the sleep must have
  // been broken (the counter restarted) even though the light is "static".
  const holdAfter = await page.evaluate(() => globalThis.__editorApi.call("profile.frameStats", { settleMs: 0 }));
  const idleA = holdAfter?.giHold ?? {};
  console.log(`  idle   : after the sun step worldIdle ${idleA.worldIdle} (${idleA.worldIdleFrames} frames) — ${idleA.worldIdleReason}`);
  if (LIGHTS_STATIC) check((idleA.worldIdleFrames ?? 0) < (lr.frames ?? 0), "the sun step woke the world chain",
    `${idleA.worldIdleFrames} idle frames since, ${lr.frames} frames recorded`);
} catch (e) {
  check(false, "smoke ran", String(e?.message ?? e).slice(0, 200));
}
const real = errors.filter((e) => !/404|favicon|save_scene/.test(e));
if (real.length) { console.log(`  page errors: ${[...new Set(real)].slice(0, 5).join(" || ")}`); fail++; }
await browser.close();
console.log(fail ? `\nFLICKER WATCH SMOKE: ${fail} FAILED` : "\nFLICKER WATCH SMOKE: all checks passed");
process.exit(fail ? 1 : 0);
