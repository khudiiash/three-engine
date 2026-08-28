// GI2 §AG — DOES THE STREET SEE THE SKY? (`probe:gi2-sky`)
//
// ══ THE COMPLAINT THIS EXISTS TO SETTLE ══════════════════════════════════════
//
// User, Bistro terrace, 08-28 12:40, the `sdf` and `occupancy` debug views: the
// balcony ironwork and the string-light cables are OPAQUE BLACK 0.25 m blocks,
// and in `sdf` a CONTINUOUS SLAB crosses the whole street at cable height.
// Everything under it has lost most of its sky, so the indirect reads flat and
// dull and the bounce comes back black.
//
// "The slab is gone" is a claim about a picture, and a picture is exactly what
// this repo has learned not to argue from. The measurable form of the same
// claim is:
//
//   ⭐ OF A FIXED SET OF UPWARD RAYS FIRED FROM A POINT ON THE PAVEMENT, WHAT
//     FRACTION REACHES THE SKY, AND WITH HOW MUCH OF ITSELF LEFT?
//
// Under the old window a ray that met a cable was STOPPED — sky reach 0 for
// every direction the cable covered, and the street's whole sky term with it.
// Under §AG the same ray crosses the cable's voxel at 94 % of its strength and
// carries on, so the number this probe prints is the sky the gather can now
// actually collect.
//
// ══ ONE BOOT, TWO ARMS, AND THAT IS THE WHOLE POINT ══════════════════════════
//
// ⭐⭐ The arms are `voxelizer.setCoverage(0|1)` + `markAllDirty()` — §AG's
// control lives ON THE DATA, so both arms run the SAME compiled trace over the
// SAME triangles in the SAME session. A before/after measured across two boots
// would put a pipeline cache, a GPU clock and another agent's battery between
// the two numbers, and the claim here is a RATIO. `[[gi-harness-viewport-traps]]`.
//
// ══ THE POINT IS DERIVED, NOT TYPED ══════════════════════════════════════════
//
// "The pavement centre" cannot be named in Bistro — there is no pavement
// entity. So the probe drops a ray straight DOWN from the camera through the
// live window, takes the first opaque hit as the ground, and stands 1.5 m above
// it. Same instrument, no coordinates anyone could have picked to flatter the
// result, and the ground height is printed so a pose that landed on a table
// rather than the street is visible.
//
// ⚠ THE DIRECTIONS ARE A FIXED FIBONACCI HEMISPHERE. No jitter, no frame index,
// no RNG — §T, and so the two arms are compared on the IDENTICAL rays rather
// than on two samples of the same distribution.
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//   node scripts/run-gi2-sky-probe.mjs http://127.0.0.1:5202/
//
// Env: PROJECT · SCENE=Bistro · SETTLE=14 · RAYS=512 · REACH=60 · POSE · HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 14);
const RAYS = Number(process.env.RAYS ?? 512);
const REACH = Number(process.env.REACH ?? 60);
// The terrace pose `probe:gi2-faceterm` pins, so the two receipts describe the
// same place in the same street.
const POSE_ENV = process.env.POSE ?? "-13.83,7.35,-9.49|-9.75,7.35,-13.90";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (v, n = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(n)} %` : "—");
const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : "—");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

let firstLight = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2\] first light/.test(t) && !firstLight) firstLight = Date.now();
  // The project's TypeScript gameplay scripts cannot transpile under the shim
  // (esbuild-wasm resolves against the OTHER worktree's node_modules) and say so
  // once per frame. Nothing here traces a script, so it is noise that would bury
  // the one line that matters.
  if (/failed to transpile|esbuild\.wasm/i.test(t)) return;
  if (/\[gi2\] (soup|first light)/.test(t) || m.type() === "error"
    || /wgsl|shader|pipeline|invalid|cannot|undefined is not/i.test(t)) {
    console.log(`    ${t.slice(0, 400)}`);
  }
});
page.on("pageerror", (e) => {
  const s = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(s)) console.log(`    pageerror: ${s.slice(0, 240)}`);
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
  globalThis.__gi2 = () => {
    const sys = mod.engine?.modules?.get?.("gi")?.system ?? null;
    return sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null;
  };
});

const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });
const gatherFrame = () => page.evaluate(() => globalThis.__gi2()?.gather?.frame ?? 0);
const settleFrames = async (n, capMs = 180000) => {
  const f0 = await gatherFrame();
  const deadline = Date.now() + capMs;
  let fr = f0;
  while (fr - f0 < n && Date.now() < deadline) { await wait(400); fr = await gatherFrame(); }
  return fr - f0;
};

console.log(`\n══ ${SCENE} — §AG: how much sky does the street get? ═══════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{
  const dl = Date.now() + 240000;
  while (Date.now() < dl && !firstLight) await wait(250);
}
// ⚠⚠ NO FIRST LIGHT IS A FATAL, NOT A FOOTNOTE — [[probe-blind-statistics]]. A
// chain that never compiled produces a full table of zeros and a verdict block
// comparing them, and "0 % of rays reach the sky" is exactly what a dead window
// prints AND exactly what the bug under test looks like.
if (!firstLight) {
  console.log("\n  FATAL: [gi2] first light NEVER arrived — the GI2 chain did not compile.");
  await browser.close();
  process.exit(1);
}
console.log(`  first light yes — settling ${SETTLE}s`);
await wait(SETTLE * 1000);

const [eye, aim] = POSE_ENV.split("|").map((s) => s.split(",").map(Number));
console.log(`  pose: eye [${eye.map((v) => v.toFixed(2))}] → [${aim.map((v) => v.toFixed(2))}]`);
await call("viewport.setCamera", { position: eye, target: aim });
await settleFrames(120);

const R = await page.evaluate(async ({ eye, RAYS, REACH }) => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  if (!gi2?.voxelizer) return { error: "no gi2 voxelizer — old build?" };
  if (!gi2.voxelizer.setCoverage) return { error: "voxelizer has no setCoverage — §AG not in this build" };
  const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
  const shoot = createGi2RayShooter(gi2, eng.renderer);
  const nz = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  // ── THE POINT. Straight down from the camera to the first opaque thing.
  //
  // ⚠ WITH THE RAY'S OWN DIRECTION AS THE "NORMAL", which turns on the origin
  // escape. A camera at eye height in a street stands INSIDE the conservatively
  // voxelized set (a cell is occupied if a triangle merely touches it), and a
  // ray born inside geometry with no escape is tested against the face it
  // LEAVES by — straight down, that is the floor's own -Y bit, so the ray
  // "hits" its own cell at t = 0 and the ground comes back at the camera's feet.
  // Same trap `windowDebugView` documents for the camera ray.
  // ⭐⭐ A FRESH COMPUTE NODE'S FIRST DISPATCHES WRITE NOTHING, AND "TWICE" IS
  // NOT ENOUGH FOR THIS ONE.
  //
  // The ray rig inlines the whole DDA, and `probeTrace`'s history records
  // seconds of pipeline compile for that text; `computeAsync` resolves before
  // the pipeline exists and the dispatch is dropped, with no error and no
  // rejected promise. The output buffer then reads back as the zeros it was
  // allocated with — which for THIS instrument is indistinguishable from an
  // empty world, and is exactly what its first run reported ("no ground under
  // the camera") about a Bistro that had 191 871 live window hits in the same
  // second. `gi2FaceTermProbe.js` lost a whole battery to the same thing.
  //
  // So the warm-up is written against an OBSERVABLE rather than a belief about
  // how many dispatches are enough: every executed ray burns at least one DDA
  // step, so `steps === 0` on a real ray means the kernel did not run. It costs
  // one dispatch when the pipeline is already there.
  const warm = async () => {
    for (let k = 0; k < 10; k++) {
      const r = await shoot([{ o: eye, d: [0, -1, 0], tMax: 80 }]);
      if ((r[0]?.steps ?? 0) > 0) return k + 1;
      await new Promise((res) => setTimeout(res, k === 0 ? 2500 : 900));
    }
    return -1;
  };
  const warmed = await warm();
  if (warmed < 0) return { error: "the ray kernel never ran — 10 dispatches, every row still zero" };
  const probeDown = await shoot([{ o: eye, d: [0, -1, 0], tMax: 80 }]);
  const down = probeDown[0];
  const vox0 = await gi2.voxelizer.stats(eng.renderer);
  if (!down?.hit) {
    return {
      error: "no ground under the camera — the window is empty here",
      diag: {
        row: { h: down?.hit, t: down?.t, s: down?.steps, T: down?.throughput }, warmed,
        built: vox0.built, voxelsSet: vox0.voxelsSet, covClasses: vox0.covClasses,
      },
    };
  }
  const groundY = eye[1] - down.t;
  const P = [eye[0], groundY + 1.5, eye[2]];

  // ── THE DIRECTIONS. A fixed Fibonacci hemisphere about +Y. Deterministic by
  // construction (§T): the same N directions every run, every arm, so the two
  // arms differ in the WINDOW and in nothing else.
  const GA = Math.PI * (3 - Math.sqrt(5));
  const dirs = [];
  for (let i = 0; i < RAYS; i++) {
    const y = (i + 0.5) / RAYS; // 0..1, so +Y hemisphere only
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * GA;
    dirs.push(nz([Math.cos(a) * r, y, Math.sin(a) * r]));
  }

  const measure = async () => {
    const rows = [];
    for (let b = 0; b < dirs.length; b += 64) {
      rows.push(...await shoot(dirs.slice(b, b + 64).map((d) => ({ o: P, d, tMax: REACH }))));
    }
    let sky = 0; let skyHalf = 0; let sumT = 0; let dimmed = 0; let sumTsky = 0;
    const ts = [];
    for (const r of rows) {
      const T = Number.isFinite(r.throughput) ? r.throughput : 1;
      sumT += T;
      if (T < 0.999) dimmed++;
      if (!r.hit) { sky++; sumTsky += T; if (T > 0.5) skyHalf++; } else ts.push(r.t);
    }
    ts.sort((a, b) => a - b);
    const n = rows.length || 1;
    return {
      rays: rows.length,
      // The headline: rays that got OUT, and rays that got out with most of
      // themselves intact — the second is the one the old window could not
      // produce at all, because a thin voxel stopped a ray outright.
      sky: sky / n,
      skyT50: skyHalf / n,
      meanT: sumT / n,
      meanTsky: sky ? sumTsky / sky : 0,
      // How many rays met ANY thin geometry. 0 here in the control arm is the
      // instrument's own proof that the arms differ in the intended way.
      dimmed: dimmed / n,
      // ⭐ THE SLAB, MEASURED DIRECTLY. The user's `sdf` view showed a ceiling
      // over the street at CABLE HEIGHT: every upward ray ending a few metres
      // up. So how far an upward ray gets before something stops it, and what
      // share of them stop inside the cable band, is the picture in numbers.
      medHit: ts.length ? ts[ts.length >> 1] : null,
      nearShare: ts.filter((t) => t < 6).length / n,
    };
  };

  const on = await measure();

  // ── THE CONTROL. Every occupied voxel back to class 3 (the solid-slab window
  // this stage replaced), same pipelines, same triangles, same rays.
  // ⚠ AND `markAllDirty` IS A FRESH NODE WITH THE SAME PROBLEM. Its observable
  // is the voxelizer's own dirty count: the engine dispatches the chain every
  // frame, so a landed mark shows up as thousands of dirty bricks on the very
  // next stats read, and a dropped one as the settled zero.
  // ── THE CENSUS. What the window ACTUALLY holds, per level, per class.
  //
  // ⭐⭐ AND IT IS ALSO THE ARM CHECK, because the two observables tried before
  // it were both blind. The voxelizer's per-frame `dirty` counter is zeroed at
  // the top of every frame and a Bistro re-voxelize finishes between two 700 ms
  // polls; the BRICK TABLE ends up back at the same state count for the same
  // reason. Both said "markAllDirty never landed" about a mark that had landed
  // AND completed. [[probe-blind-statistics]] — ask whether the instrument can
  // see its subject before believing its null.
  //
  // The coverage field itself is not per-frame and does not settle back: with
  // the classes off, every occupied voxel is 3, and any voxel below 3 is proof
  // the flip did not take.
  const ws = await import("/src/modules/gi/window/windowStore.js");
  const census = async () => {
    const w = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
    const per = [];
    const all = [0, 0, 0, 0];
    for (let l = 0; l < gi2.win.levels; l++) {
      const base = l * ws.LEVEL_WORDS;
      const c = [0, 0, 0, 0];
      for (let vi = 0; vi < 262144; vi++) {
        if (!((w[base + ws.OCC_OFF + (vi >> 5)] >>> (vi & 31)) & 1)) continue;
        c[(w[base + ws.COV_OFF + (vi >> 4)] >>> ((vi & 15) * 2)) & 3]++;
      }
      for (let k = 0; k < 4; k++) all[k] += c[k];
      per.push(c);
    }
    return { per, all };
  };
  const censusOn = await census();

  // ⚠ `markAllDirty` IS A FRESH NODE with the same first-dispatch problem as the
  // ray rig, so it is fired several times; whether it landed is decided by the
  // census AFTER the rebuild, not by a poll during it.
  gi2.voxelizer.setCoverage(false);
  for (let k = 0; k < 4; k++) {
    await eng.renderer.computeAsync(gi2.voxelizer.markAllDirty());
    await new Promise((res) => setTimeout(res, k === 0 ? 1200 : 300));
  }
  return { P, groundY, on, warmed, censusOn };
}, { eye, RAYS, REACH });

if (R?.error) {
  console.log(`  FATAL: ${R.error}`);
  if (R.diag) console.log(`  diag: ${JSON.stringify(R.diag)}`);
  await browser.close();
  process.exit(1);
}

// The re-voxelize is BUDGETED — the whole window cannot come back in one frame,
// so the control arm has to be given the frames the budget needs, exactly as a
// scene load is. Measured after, not during.
console.log(`  ground y ${R.groundY.toFixed(2)} → sample point [${R.P.map((v) => v.toFixed(2))}]`
  + `  (ray kernel landed on dispatch ${R.warmed})`);
{
  const c = R.censusOn.all;
  const n = c[0] + c[1] + c[2] + c[3];
  console.log(`  coverage census, coverage ON: ${n} occupied voxels — `
    + `class 0 ${pct(c[0] / n)}, 1 ${pct(c[1] / n)}, 2 ${pct(c[2] / n)}, 3 ${pct(c[3] / n)}`);
  R.censusOn.per.forEach((p, l) => {
    const t = p[0] + p[1] + p[2] + p[3];
    if (t) console.log(`    L${l}: ${t} occupied — ${p.map((v) => pct(v / t)).join(" / ")}`);
  });
}
console.log("  re-voxelizing for the control arm (coverage OFF)…");
await settleFrames(240);
await wait(4000);

const OFF = await page.evaluate(async ({ P, RAYS, REACH }) => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
  // The rig is cached on `gi2` by the first arm, so its pipeline exists and this
  // shooter is already warm — but one discarded call costs nothing and makes the
  // arm independent of that fact.
  const shoot = createGi2RayShooter(gi2, eng.renderer);
  // The rig is cached on `gi2`, so its pipeline exists — but the arm asserts it
  // rather than assuming it, for the reason the first arm's `warm` explains.
  for (let k = 0; k < 10; k++) {
    const r = await shoot([{ o: P, d: [0, 1, 0], tMax: 80 }]);
    if ((r[0]?.steps ?? 0) > 0) break;
    await new Promise((res) => setTimeout(res, 900));
  }
  const nz = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const GA = Math.PI * (3 - Math.sqrt(5));
  const dirs = [];
  for (let i = 0; i < RAYS; i++) {
    const y = (i + 0.5) / RAYS;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * GA;
    dirs.push(nz([Math.cos(a) * r, y, Math.sin(a) * r]));
  }
  const rows = [];
  for (let b = 0; b < dirs.length; b += 64) {
    rows.push(...await shoot(dirs.slice(b, b + 64).map((d) => ({ o: P, d, tMax: REACH }))));
  }
  let sky = 0; let skyHalf = 0; let sumT = 0; let dimmed = 0; let sumTsky = 0;
  const ts = [];
  for (const r of rows) {
    const T = Number.isFinite(r.throughput) ? r.throughput : 1;
    sumT += T;
    if (T < 0.999) dimmed++;
    if (!r.hit) { sky++; sumTsky += T; if (T > 0.5) skyHalf++; } else ts.push(r.t);
  }
  ts.sort((a, b) => a - b);
  const n = rows.length || 1;
  const ws = await import("/src/modules/gi/window/windowStore.js");
  const w = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
  const all = [0, 0, 0, 0];
  for (let l = 0; l < gi2.win.levels; l++) {
    const base = l * ws.LEVEL_WORDS;
    for (let vi = 0; vi < 262144; vi++) {
      if (!((w[base + ws.OCC_OFF + (vi >> 5)] >>> (vi & 31)) & 1)) continue;
      all[(w[base + ws.COV_OFF + (vi >> 4)] >>> ((vi & 15) * 2)) & 3]++;
    }
  }
  // Put the window back the way the engine expects to find it.
  gi2.voxelizer.setCoverage(true);
  for (let k = 0; k < 3; k++) {
    await eng.renderer.computeAsync(gi2.voxelizer.markAllDirty());
    await new Promise((res) => setTimeout(res, 300));
  }
  return {
    rays: rows.length,
    sky: sky / n,
    skyT50: skyHalf / n,
    meanT: sumT / n,
    meanTsky: sky ? sumTsky / sky : 0,
    dimmed: dimmed / n,
    medHit: ts.length ? ts[ts.length >> 1] : null,
    nearShare: ts.filter((t) => t < 6).length / n,
    census: all,
  };
}, { P: R.P, RAYS, REACH });

console.log("");
console.log("  arm            sky reach   sky T>0.5   mean T   dimmed   median hit   stopped < 6 m");
console.log("  ─────────────  ──────────  ──────────  ───────  ───────  ───────────  ─────────────");
const row = (name, a) => console.log(
  `  ${name.padEnd(13)}  ${pct(a.sky).padStart(10)}  ${pct(a.skyT50).padStart(10)}  `
  + `${f(a.meanT).padStart(7)}  ${pct(a.dimmed).padStart(7)}  `
  + `${(a.medHit == null ? "—" : `${a.medHit.toFixed(2)} m`).padStart(11)}  ${pct(a.nearShare).padStart(13)}`);
row("coverage OFF", OFF);
row("coverage ON", R.on);
console.log("");
const gain = OFF.sky > 0 ? R.on.sky / OFF.sky : Infinity;
console.log(`  sky reach ${pct(OFF.sky)} → ${pct(R.on.sky)}  (${Number.isFinite(gain) ? `${gain.toFixed(2)}x` : "from nothing"})`);
console.log(`  and ${pct(R.on.dimmed)} of the rays crossed thin geometry on the way — `
  + `${pct(OFF.dimmed)} in the control, which is the arms differing as designed.`);
console.log(`  ${R.on.rays} rays from [${R.P.map((v) => v.toFixed(2))}], reach ${REACH} m, `
  + "fixed Fibonacci hemisphere (no jitter).");

// ⚠ THE ONE READING THAT WOULD INVALIDATE THE REST: if the control arm ALSO
// shows dimmed rays, `setCoverage(false)` did not take (the re-voxelize did not
// finish) and the two rows are the same window measured twice.
{
  const c = OFF.census;
  const n = c[0] + c[1] + c[2] + c[3];
  console.log(`  coverage census, coverage OFF: ${n} occupied voxels — `
    + `class 0 ${pct(c[0] / n)}, 1 ${pct(c[1] / n)}, 2 ${pct(c[2] / n)}, 3 ${pct(c[3] / n)}`);
}
// ⚠ THE READING THAT WOULD INVALIDATE THE REST. If the control arm still holds
// voxels below class 3, `setCoverage(false)` + `markAllDirty` did not take and
// the two rows are one window measured twice — the failure the two blind
// observables before this one could not tell from success.
const thinLeft = OFF.census[0] + OFF.census[1] + OFF.census[2];
const suspect = thinLeft > 0.02 * (OFF.census[3] || 1) || OFF.dimmed > 0.02;
if (suspect) {
  console.log("");
  console.log(`  ⚠ CONTROL ARM IS NOT A CONTROL: ${thinLeft} voxels below class 3 and `
    + `${pct(OFF.dimmed)} dimmed rays. The re-voxelize had not finished, so the two rows`);
  console.log("    are the same window measured twice. Re-run with a larger SETTLE.");
}
await browser.close();
process.exit(suspect ? 1 : 0);
