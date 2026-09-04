// COLD ARRIVAL — the first time a surface is ever seen.
//
// ⭐⭐ WHY THIS EXISTS (2026-09-04, the user): "after it settled once, it seems
// to be stable on a revisit. Though the first time I see corridor - it
// flickers. When even just stepping back with the camera, the walls around
// that were not visible before start flickering a lot."
//
// Every "arrival" this project had measured was a REVISIT. Probes are
// RETAINED for >= 1800 frames after leaving view and yield only under capacity
// pressure (65 536 c0 slots, ~4 k live: never), so teleporting back into a
// corridor seen earlier in the session lands on warm probes with converged
// bins. The user's complaint is the COLD case — a freshly minted column whose
// PARENT probes are just as new — and only a field that has never seen the
// place can produce it. The harness boots cold every run by construction, so
// this script boots, waits for the field, converges the START view, and then
// jumps straight to POSE and counts the still frames of the first five
// seconds — the user's "first time I see the corridor", as a number.
//
// Same instrument as the live one (`profile.flicker`, still frames only,
// `warmupFrames` 2 so the arrival's own first frames are counted), then a
// `profile.lightResponse` at the pose so the responsiveness receipt rides
// beside the stability one, always.
//
//   node scripts/run-gi-cold-arrival.mjs [url]
// Env:
//   PROJECT=C:/Users/Khudiiash/Documents/GAME   SCENE=scenes/Sponza.scene
//   POSE='[-6,1.25,3.18, 8,1.25,3.18]'   position xyz, target xyz (the user's
//                                        corridor view is the default)
//   START='[-6,1.7,-0.3, 7,1.7,-0.3]'     the view the field converges on first
//   SETTLE=12000   ms at START after `field ready` before the jump
//   LIGHT=1        run profile.lightResponse at POSE afterwards (0 to skip)
//   FLAGS='{...}'  page globals (e.g. {"__giSrcConfidence":false} for the old
//                  estimator, {"__giSrcFarPrior":false} for Unit 1 without 1b)
//   SUNDEG=-90     PIN the sun: the directional light's parent `rotation.x`, in
//                  degrees (the axis the project's LightScript writes), set
//                  before the settle. ⚠ WITHOUT THIS THE HARNESS FOLLOWS THE
//                  USER'S AUTOSAVES: the editor autosaves every 10 s, so two
//                  runs an hour apart measured two different suns — one run's
//                  corridor at meanLum 0.004, the next's at 0.15 — and a "10×
//                  darker" reading was a regime change, not an estimator.
//                  Unset = whatever the scene file holds right now (printed).
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = `${PROJECT}/${process.env.SCENE ?? "scenes/Sponza.scene"}`;
const POSE = JSON.parse(process.env.POSE ?? "[-6,1.252553541378039,3.177201463619937, 8,1.2525535413780382,3.177201463619936]");
const START = JSON.parse(process.env.START ?? "[-6,1.7,-0.3, 7,1.7,-0.3]");
const SETTLE = Number(process.env.SETTLE ?? 12000);
const LIGHT = process.env.LIGHT !== "0";
const FLAGS = JSON.parse(process.env.FLAGS ?? "{}");
// SUNDEG="x" or "x,y,z" in degrees — the light parent's Euler rotation. The
// user's saved sun on 2026-09-04 was (−92, −3, −16.9); the authored one that
// produced the DARK regime was (−92, 0, 0) — straight down, corridors lit by
// bounce alone. The z tilt is what puts direct sun on the nave floor.
const SUNDEG = process.env.SUNDEG != null && process.env.SUNDEG !== ""
  ? process.env.SUNDEG.split(",").map((v) => Number(v))
  : null;

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
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => errors.push(`pageerror ${String(e.message ?? e).slice(0, 200)}`));
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project, flags) => {
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorKeepRendering = true;
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, PROJECT, FLAGS);

const fmt = (w) => `rev/px/f ${w.reversalsPerFrame}  churn ${(w.churnShare * 100).toFixed(2)}%  moved ${(w.movedShare * 100).toFixed(0)}%  ` +
  `p95 step ${w.stepP95OfMean}x mean  max ${w.stepMaxOfMean}x  meanLum ${w.meanLum}  (${w.frames} f @ ${w.fps} fps)`;
const hot = (w) => {
  const g = w.tileReversalsPerFrame ?? [];
  const cells = [];
  g.forEach((row, y) => row.forEach((v, x) => cells.push({ v, x, y })));
  cells.sort((a, b) => b.v - a.v);
  return cells.slice(0, 4).map((c) => `[${c.x},${c.y}]=${c.v}`).join(" ");
};

try {
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 120_000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  await page.waitForFunction(() => !!globalThis.__editorApi?.call, { timeout: 180_000 });
  await page.evaluate((scene) => globalThis.__editorApi.call("scene.open", { path: scene }), SCENE);
  // The field, not the clock — and the START view, so the field converges on
  // something OTHER than the pose under test. `ensureEngine()` is what creates
  // the engine (run-gi-walk-patches' own note), so poll through it.
  let ready = false;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    ready = await page.evaluate(async () => {
      const { ensureEngine } = await import("/src/editor/engineInstance.js");
      const engine = await ensureEngine();
      return !!engine?.modules?.get?.("gi")?.system?._giTargets?.irradiance;
    }).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error("field never came up");
  // The sun: pinned to SUNDEG, or read and printed so the regime is on record.
  const sun = await page.evaluate(async (deg) => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    let light = null;
    engine.scene.traverse((o) => { if (!light && o.isDirectionalLight) light = o; });
    if (!light) return null;
    const pivot = light.parent ?? light;
    if (Array.isArray(deg) && Number.isFinite(deg[0])) {
      pivot.rotation.x = (deg[0] * Math.PI) / 180;
      if (Number.isFinite(deg[1])) pivot.rotation.y = (deg[1] * Math.PI) / 180;
      if (Number.isFinite(deg[2])) pivot.rotation.z = (deg[2] * Math.PI) / 180;
      pivot.updateMatrixWorld(true);
    }
    const d = { x: 0, y: 0, z: -1 };
    const q = light.getWorldQuaternion(new (light.quaternion.constructor)());
    // rotate (0,0,-1) by q — a directional light shines down its local -Z
    const { x, y, z, w } = q;
    const ix = w * d.x + y * d.z - z * d.y, iy = w * d.y + z * d.x - x * d.z, iz = w * d.z + x * d.y - y * d.x, iw = -x * d.x - y * d.y - z * d.z;
    const dir = [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
    const r = (v) => +((v * 180) / Math.PI).toFixed(1);
    return { rotDeg: [r(pivot.rotation.x), r(pivot.rotation.y), r(pivot.rotation.z)], dir: dir.map((v) => +v.toFixed(3)), intensity: light.intensity };
  }, SUNDEG);
  console.log(`  sun: ${sun ? `rotation ${JSON.stringify(sun.rotDeg)} deg, dir ${JSON.stringify(sun.dir)}, intensity ${sun.intensity}` : "NO DIRECTIONAL LIGHT"}${SUNDEG ? " (pinned)" : " (as saved)"}`);
  await page.evaluate((s) => globalThis.__editorApi.call("viewport.setCamera", { position: s.slice(0, 3), target: s.slice(3, 6) }), START);
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), SETTLE);
  const startWin = await page.evaluate(() => globalThis.__editorApi.call("profile.flicker", { seconds: 3 }));
  console.log(`  start view (converged): ${fmt(startWin)}`);

  // ── THE COLD JUMP ──────────────────────────────────────────────────────
  const cold = await page.evaluate(async (pose) => {
    const api = globalThis.__editorApi;
    await api.call("viewport.setCamera", { position: pose.slice(0, 3), target: pose.slice(3, 6) });
    const first = await api.call("profile.flicker", { seconds: 5, warmupFrames: 2 });
    const second = await api.call("profile.flicker", { seconds: 4 });
    return { first, second };
  }, POSE);
  console.log(`  COLD arrival, first 5 s : ${fmt(cold.first)}`);
  console.log(`                 hot tiles: ${hot(cold.first)}`);
  console.log(`  then 4 s at rest        : ${fmt(cold.second)}`);
  // ── THE ENERGY LEDGER at the pose: where a darkening lives, if there is one.
  // `profile.giPasses` suspends rendering briefly; taken AFTER the windows.
  try {
    const gp = await page.evaluate(() => globalThis.__editorApi.call("profile.giPasses", { samples: 8 }));
    const sp = gp?.srcProbes ?? {};
    const t = sp.tiles ?? {};
    const mg = sp.merge ?? {};
    const c0 = (sp.cascades ?? [])[0] ?? {};
    console.log(`  ledger: tiles meanLum ${t.meanLum?.toFixed?.(4)} coverage ${((t.coverage ?? 0) * 100).toFixed(1)}% knownBins ${t.meanKnownBins?.toFixed?.(1)}/${t.lobeBins?.toFixed?.(1)} ` +
      `| merge orphan ${((mg.orphanRate ?? 0) * 100).toFixed(1)}% (live ${((mg.orphanLiveRate ?? 0) * 100).toFixed(2)}%) corners ${mg.meanCorners?.toFixed?.(2)}/8 resolved ${((mg.resolvedRate ?? 0) * 100).toFixed(1)}% ` +
      `| c0 live ${c0.live} starved ${c0.starved} | rays/frame ${sp.raysPerFrame} | farField rgb8 ${JSON.stringify(sp.farField?.rgb8)} dark ${((sp.farField?.darkFrac ?? 0) * 100).toFixed(0)}% fill ${((sp.farField?.fillFrac ?? 0) * 100).toFixed(0)}%`);
    const sec = (sp.secondary?.byLod ?? []).find((b) => b.lod === 0);
    if (sec) console.log(`          [J] lod0 hits ${sec.hits} direct ${sec.meanDirectLuma} bounce ${sec.meanBounceLuma} irradiance ${sec.meanIrradianceLuma} bounce/direct ${sec.bounceOverDirect}`);
  } catch (e) {
    console.log(`  ledger: unavailable (${String(e?.message ?? e).slice(0, 120)})`);
  }
  // A REVISIT for contrast: leave, wait, come back to the same pose.
  // BEFORE the light step: its restore leaves the field mid-transition for
  // seconds, and a revisit measured on top of that reads the sun's return.
  const revisit = await page.evaluate(async (pose, start) => {
    const api = globalThis.__editorApi;
    await api.call("viewport.setCamera", { position: start.slice(0, 3), target: start.slice(3, 6) });
    await new Promise((r) => setTimeout(r, 5000));
    await api.call("viewport.setCamera", { position: pose.slice(0, 3), target: pose.slice(3, 6) });
    return api.call("profile.flicker", { seconds: 5, warmupFrames: 2 });
  }, POSE, START);
  console.log(`  WARM revisit, first 5 s : ${fmt(revisit)}`);
  if (LIGHT) {
    const lr = await page.evaluate(() => globalThis.__editorApi.call("profile.lightResponse", { stepDeg: 25, seconds: 8 }));
    console.log(`  light step 25 deg       : change ${((lr.changeOfBaseline ?? 0) * 100).toFixed(0)}%  t50 ${lr.t50Ms} ms  t90 ${lr.t90Ms} ms  ` +
      `monotone ${((lr.monotoneShare ?? 0) * 100).toFixed(0)}%` + (lr.error ? `  ERROR ${lr.error}` : "") + (lr.pipelinePending ? "  PIPELINE PENDING" : ""));
  }
} catch (e) {
  console.log(`  FAILED: ${String(e?.message ?? e).slice(0, 300)}`);
}
const real = errors.filter((e) => !/404|favicon|save_scene/.test(e));
if (real.length) console.log(`  page errors: ${[...new Set(real)].slice(0, 5).join(" || ")}`);
await browser.close();
