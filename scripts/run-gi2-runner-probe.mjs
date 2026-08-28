// ⭐⭐⭐ GI2 RUNNER PROBE — §AE: WHY THE LIGHT JUMPS ON A RUNNING CHARACTER
//
// THE REPORT (user, 08-28 11:40, Bistro, play mode, world probes default since
// 80f390b): "I have just tested with a character running around bistro:
// lighting still jumps a lot, no smooth transitions, it just dark->bright->dark
// rapidly, it is distracting, it must go smoothly and naturally. Otherwise, it
// won't be usable in games."
//
// ══ WHY NOTHING ALREADY IN `scripts/` CAN ANSWER THIS ════════════════════════
//
// `probe:gi2-motion` measures FRAME TIME on three camera arms and, since 3.18,
// a per-pixel SIGN-FLIP census. A flip census answers "did the estimate reverse
// direction", which is a question about GRAIN. The complaint is about AMPLITUDE
// and DURATION — how big a step, and how long a bright phase lasts — and a
// census that scores a 0.3 % reversal and a 60 % reversal identically is
// structurally blind to it. [[probe-blind-statistics]]
//
// `probe:gi2-flood`, `-farfield`, `-corridor`, `-doors` each measure ONE
// SETTLED frame. Every one of them is a statement about a scene that has
// stopped moving, and the complaint is about a scene that never does.
//
// So this probe measures a TIME SERIES of irradiance at NAMED points while the
// scene's OWN character runs the street at 5 m/s, and reports the step
// distribution, the phase length, and — the part that makes it a diagnosis
// rather than the complaint restated in numbers — WHICH TERM OF THE RESOLVE
// moved on each step.
//
// ⭐⭐ IT DRIVES THE USER'S ACTUAL CHARACTER. `Bistro.scene` carries a `Player`
// rig as an `addEntity` override on the prefab instance: a `charactercontroller`
// root, a `Camera` child, and a `Body` child holding a `skinnedmesh`
// (`Character/Chainer/CH`) plus an `animation` with `playInEditor: true`. Every
// one of Bistro's 1532 prefab meshes carries `giMobility = "static"`, so
// `#gi2Movers` (`GISystem.js:18408`) can seat NOTHING from the scene — the
// Player's own bone boxes are the entire dynamic layer, which is why a box the
// harness invents would have measured a different scene than the user's.
//
// ══ THE FIVE CANDIDATE MECHANISMS, AND THE COLUMN THAT SEPARATES EACH ════════
//
//   A  TRAVERSAL   — the runner moved into a cell whose STATIC value differs.
//                    Discriminator: the four fixed GROUND points and four fixed
//                    FAÇADE points DO NOT MOVE, so a step in their series can
//                    never be traversal. Plus the out/back legs: a step at the
//                    same path parameter `s` on both legs is position-keyed.
//   B  DYNAMIC     — the runner's own voxels change the probes near it.
//                    Discriminator: the `nodyn` arm runs the identical path
//                    with `gi2.setMovers([])` — the body is still drawn, still
//                    animating, still in the picture, and contributes NOTHING
//                    to the window's dynamic levels. `run` − `nodyn` is B and
//                    nothing else.
//   C  INTERPOLATION — the eight-corner hand-off itself is discontinuous.
//                    Discriminator: `diagBuf`'s `cov` and `claim` per cascade,
//                    read out of the SAME registers `resolveHalf` built the
//                    composite from (`gatherProbes.js:3830`, `:3939`). `cov` is
//                    Σ tri·live; `claim` is `cov/wpCovFull · band · rem`. A
//                    corner flipping live/dead, or `cov` crossing `wpCovFull`,
//                    moves these and nothing else. `vis` isolates the Chebyshev
//                    term (`worldProbes.js:1955 octTapVisAt`) on its own.
//   D  LIFECYCLE   — a probe was re-keyed by a window scroll and is ramping
//                    (§19 4.3c `wpSeedRamp`, `worldProbes.js:582`).
//                    Discriminator: `diagBuf`'s `fresh` (Σ tri·live·[ready <
//                    0.75]) at the SAME sample, plus the world lattice ORIGINS
//                    read per frame — a scroll is an origin that stepped,
//                    exactly. ⚠ `gi2.snapshot().gather` CANNOT do this job:
//                    `_gi2Stats` refreshes on `statsCadence()` = 30 frames once
//                    the window has filled (`gi2System.js:1617`), so its
//                    counters lag the frame that paid for them by up to half a
//                    second. They are recorded, and they are not the evidence.
//   E  ACCUMULATOR — §19 3.12's image blend at the receiver, i.e. the camera
//                    follow's own reprojection. Discriminator: the resolve's
//                    OWN luminance BEFORE the blend rides in the last cascade's
//                    `diag.w` (`gatherProbes.js:4052`). A jump in the final
//                    irradiance with the pre-blend luminance steady is the
//                    blend; a jump in both is the field. Plus the `static` arm,
//                    where the runner crosses a PARKED camera's view.
//
// ══ THE ARMS ════════════════════════════════════════════════════════════════
//
//   run     the Player runs, third-person camera follows — the user's case, OUT
//           and BACK over the same ground.
//   nodyn   identical, `gi2.setMovers([])`.       run − nodyn = B.
//   static  identical run, camera PARKED beside the path.  run − static = E.
//
// ⚠ THE RUNNER MOVES A FIXED DISTANCE PER RENDERED FRAME, not per wall-clock
// second. A probe that reads back a buffer every frame costs a pipeline flush,
// so its wall clock is not the user's; pinning the SPATIAL step (5 m/s ÷ 60 fps
// = 8.33 cm/frame) makes every number here a statement about "5 m/s at 60 fps"
// whatever the harness's own frame rate turns out to be. `dt` is recorded so
// the real rate is on the table.
//
// ⚠ THE URL IS 5202, NEVER 5201 — this worktree has a junctioned node_modules
// and a private vite cache (`vite.gi19.config.mjs`):
//
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//   node scripts/run-gi2-runner-probe.mjs http://127.0.0.1:5202/
//
// Env:
//   PROJECT=<path>  default C:/Users/Khudiiash/Documents/GAME
//   SCENE=Bistro    ARMS=run,nodyn,static,faceoff,visoff  (also: covfull1)
//   SPEED=5         m/s  ·  FPS=60 (the virtual rate the spatial step assumes)
//   SECONDS=9       per one-way leg  ·  WARM=90 (discarded) PARK=60 (the control)
//   SETTLE=16       seconds after first light
//   STEP_PCT=10 BIG_PCT=25
//   JSON=<path>     dump every frame record   ·   HEADED=1  watch it
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { reportEmitterSeats } from "./lib/gi2EmitterWait.mjs";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const ARMS = (process.env.ARMS ?? "run,nodyn,static,faceoff,visoff").split(",").map((s) => s.trim()).filter(Boolean);
const SPEED = Number(process.env.SPEED ?? 5);
const FPS = Number(process.env.FPS ?? 60);
const SECONDS = Number(process.env.SECONDS ?? 9);
const PARK_FRAMES = Number(process.env.PARK ?? 60);
const WARM_FRAMES = Number(process.env.WARM ?? 90);
const SETTLE = Number(process.env.SETTLE ?? 16);
const STEP_PCT = Number(process.env.STEP_PCT ?? 10);
const BIG_PCT = Number(process.env.BIG_PCT ?? 25);
const JSON_OUT = process.env.JSON ?? "";
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT ?? 300) * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const pctl = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  protocolTimeout: 1800000,
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--js-flags=--expose-gc",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
// ⚠ BEFORE BOOT. `wantNoise` gates the BUILD of `diagBuf` (`gatherProbes.js:713`);
// set after the gather exists, this probe would report a table of zeros and call
// it "no mechanism found". [[probe-blind-statistics]]
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
  if (/\[gi2\] (first light|dynamic layer|skinned movers|window)|\[gi\] built/.test(t)) {
    console.log(`    ${t.slice(0, 200)}`);
  }
});
page.on("pageerror", (e) => {
  const s = e.stack ?? e.message ?? String(e);
  if (!/save_scene|esbuild|transpile/.test(s)) console.log(`    pageerror: ${s.slice(0, 180)}`);
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

console.log(`\n══ ${SCENE} — the runner (${SPEED} m/s, ${SECONDS} s legs) ════════════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{
  const dl = Date.now() + BOOT_TIMEOUT;
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

const settled = (await call("profile.frameStats", { settleMs: 1100 })).value ?? {};
console.log(`  settled: ${settled.fps ?? "?"} fps, cpu ${f(settled.cpuMs, 1)} ms, gpu ${f(settled.gpuMs, 1)} ms`);

// ════════════════════════════════════════════════════════ 1. THE PLAYER RIG
const rig = await page.evaluate(() => {
  const eng = globalThis.__giEngineForProbe;
  const sys = globalThis.__giSys();
  let ent = null;
  for (const e of eng.entities?.values?.() ?? []) {
    if ((e.name ?? "") === "Player") { ent = e; break; }
  }
  if (!ent) {
    for (const e of eng.entities?.values?.() ?? []) {
      if (/player|character/i.test(e.name ?? "")) { ent = e; break; }
    }
  }
  if (!ent) return { err: "no Player entity" };
  ent.object3D.updateMatrixWorld(true);
  const skinned = [];
  ent.object3D.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o.name || "(skinned)"); });
  // ⚠ THE MATRIX, NOT `getWorldPosition`. The harness has no THREE binding to
  // hand it a target vector, and `matrixWorld` is already up to date after the
  // `updateMatrixWorld(true)` above — its translation IS the world position.
  const m = ent.object3D.matrixWorld.elements;
  globalThis.__giPlayer = ent;
  const movers = sys?._gi2Movers ?? [];
  return {
    ok: true, id: ent.id, name: ent.name,
    P: [m[12], m[13], m[14]],
    skinned, movers: movers.length,
    skinnedMovers: movers.filter((x) => x.skinned).length,
    boneMovers: movers.filter((x) => typeof x.matrixOf === "function").length,
    dyn: sys?._gi2Stats?.dynamic ?? null,
  };
});
if (rig.err) { console.log(`FATAL: ${rig.err}`); await browser.close(); process.exit(1); }
console.log(`  Player "${rig.name}" at [${rig.P.map((v) => v.toFixed(2))}]  ` +
  `skinned meshes [${rig.skinned.join(", ")}]`);
console.log(`  movers ${rig.movers} (${rig.skinnedMovers} skinned, ${rig.boneMovers} on live bone matrices), ` +
  `dynamic voxelsSet ${rig.dyn?.voxelsSet ?? "?"}`);
if (!rig.movers) console.log("  ⚠ NO MOVERS SEATED — the B column will read empty, which is itself the finding.");

// ════════════════════════════════════ 2. THE STREET, FROM THE GBUFFER
//
// ⭐⭐ THE PATH IS DERIVED FROM THE PAVEMENT THE FRAME ACTUALLY SHOWS, NOT FROM
// A NAME OR A BOUNDING BOX. `Paris_Street_*`'s AABB spans y −4.73 … 4.99 — kerbs,
// ramps and undersides all in one box — so `street.max.y` is not a ground plane
// and a path derived from it walks in the air. The Player's authored feet ARE a
// known-good ground point, and the up-facing gbuffer samples around that height
// are the pavement; their XZ scatter's principal axis is the street.
// ⭐⭐ THE STREET'S DIRECTION IS RAY-CAST, NOT GUESSED. A "17 m up and 17 m
// back" overview put the camera inside a building — Bistro's façades run to
// 27 m — and the frame that came back held 21 pavement samples out of 178 000.
// A camera pose is a guess about geometry; the WINDOW already knows. So the
// probe stands at the Player's eye, fires a horizontal ring through
// `traceWindow`, and takes the longest free direction: that is the street,
// measured, and it is the same trick `run-gi2-flood-probe` uses to find the
// same street from the same rig.
const setCam = (p, t) => page.evaluate(async ({ p, t }) => {
  const vhm = await import("/src/editor/viewportHandle.js");
  const vh = vhm.getViewportHandle();
  globalThis.__giViewport = vh;
  const cam = vh.camera;
  cam.position.set(p[0], p[1], p[2]);
  if (vh.orbit) { vh.orbit.target.set(t[0], t[1], t[2]); vh.orbit.update(); }
  else cam.lookAt(t[0], t[1], t[2]);
}, { p, t });
await setCam([rig.P[0], rig.P[1] + 1.7, rig.P[2]], [rig.P[0] + 4, rig.P[1] + 1.7, rig.P[2]]);
await wait(5000);
const ring = await page.evaluate(async ({ P }) => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  if (!gi2?.trace) return null;
  const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
  const shoot = createGi2RayShooter(gi2, eng.renderer);
  const dirs = [];
  for (let k = 0; k < 32; k++) { const a = (k / 32) * Math.PI * 2; dirs.push([Math.cos(a), 0, Math.sin(a)]); }
  const o = [P[0], P[1] + 1.7, P[2]];
  const rays = dirs.map((d) => ({ o, d, tMax: 45 }));
  await shoot(rays);                       // the first dispatch only compiles
  const out = await shoot(rays);
  return dirs.map((d, i) => ({ d, t: out[i].hit ? out[i].t : 45 }));
}, { P: rig.P });
let axis = [1, 0, 0];
if (ring) {
  const best = ring.reduce((a, b) => (b.t > a.t ? b : a));
  axis = best.d;
  const opp = ring.reduce((a, b) => {
    const dp = b.d[0] * best.d[0] + b.d[2] * best.d[2];
    return dp < -0.7 && b.t > a.t ? b : a;
  }, { d: best.d, t: 0 });
  console.log(`  ring: longest free direction [${axis.map((v) => v.toFixed(2))}] at ${f(best.t, 1)} m, ` +
    `opposite ${f(opp.t, 1)} m`);
} else console.log("  ring: no window trace — falling back to +X");
// The overview looks ALONG the street from 6 m behind the Player, 7 m up: the
// whole run is in the frame and every sample in it is street.
await setCam(
  [rig.P[0] - axis[0] * 7, rig.P[1] + 7, rig.P[2] - axis[2] * 7],
  [rig.P[0] + axis[0] * 22, rig.P[1] + 1, rig.P[2] + axis[2] * 22],
);
await wait(8000);

const path = await page.evaluate(async ({ P0, axis }) => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const { createGi2StageDump } = await import("/scripts/lib/gi2StageProbe.js");
  const dump = createGi2StageDump({
    renderer: eng.renderer, gi2, screen: globalThis.__giSys().state.screen, stride: 3,
  });
  if (!dump) return { err: "no stage dump" };
  const D = await dump.read();
  const V = 6;
  const at = (i, v, c) => D[(i * V + v) * 4 + c];
  const n = D.length / (V * 4);
  const up = []; const side = [];
  for (let i = 0; i < n; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    const P = [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)];
    const N = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
    const E = [at(i, 2, 0), at(i, 2, 1), at(i, 2, 2)];
    if (N[1] > 0.9 && Math.abs(P[1] - P0[1]) < 0.9) up.push({ P, N, E });
    else if (Math.abs(N[1]) < 0.35 && P[1] > P0[1] + 0.9 && P[1] < P0[1] + 6) side.push({ P, N, E });
  }
  if (up.length < 40) {
    // ⚠ A FAILURE THAT SAYS WHAT IT SAW. "not enough samples" is a null the
    // next reader cannot act on; the height histogram says whether the camera
    // was looking at a roof, a wall, or nothing at all.
    const hist = {};
    for (let i = 0; i < n; i++) {
      if (!(at(i, 0, 3) > 0.5)) continue;
      const y = Math.round(at(i, 0, 1));
      hist[y] = (hist[y] ?? 0) + 1;
    }
    const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { err: `only ${up.length} pavement samples near the Player's height (${side.length} façade); ` +
      `valid-pixel height histogram ${top.map(([y, c]) => `${y}m:${c}`).join(" ")}` };
  }
  const groundY = up.map((s) => s.P[1]).sort((a, b) => a - b)[up.length >> 1];
  // ── the principal axis of the pavement's XZ scatter ─────────────────────
  let cx = 0; let cz = 0;
  for (const s of up) { cx += s.P[0]; cz += s.P[2]; }
  cx /= up.length; cz /= up.length;
  let sxx = 0; let sxz = 0; let szz = 0;
  for (const s of up) {
    const dx = s.P[0] - cx; const dz = s.P[2] - cz;
    sxx += dx * dx; sxz += dx * dz; szz += dz * dz;
  }
  sxx /= up.length; sxz /= up.length; szz /= up.length;
  const tr = sxx + szz; const det = sxx * szz - sxz * sxz;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let dx = sxz; let dz = l1 - sxx;
  if (Math.hypot(dx, dz) < 1e-6) { dx = 1; dz = 0; }
  const dl = Math.hypot(dx, dz); dx /= dl; dz /= dl;
  // ⭐ THE RING IS THE ARBITER WHEN THE SCATTER IS AMBIGUOUS. A pavement patch
  // that happens to be as wide as it is long has no principal axis worth the
  // name, and PCA will hand back the diagonal of the crop rather than the
  // street. The measured longest free ray cannot be ambiguous that way, so it
  // wins whenever the two disagree by more than 45°.
  let axisSrc = "pca";
  const align = Math.abs(dx * axis[0] + dz * axis[2]);
  if (align < 0.707) { dx = axis[0]; dz = axis[2]; axisSrc = "ring (PCA disagreed)"; }
  else if (dx * axis[0] + dz * axis[2] < 0) { dx = -dx; dz = -dz; }
  // The path runs THROUGH the Player's authored position — a point the scene's
  // own author put on the ground — and reaches as far each way as the pavement
  // the frame actually shows.
  const along = (Q) => (Q[0] - P0[0]) * dx + (Q[2] - P0[2]) * dz;
  const lateral = (Q) => -(Q[0] - P0[0]) * dz + (Q[2] - P0[2]) * dx;
  const near = up.filter((s) => Math.abs(lateral(s.P)) < 2.2).map((s) => along(s.P)).sort((a, b) => a - b);
  if (near.length < 20) return { err: `only ${near.length} pavement samples within 2.2 m of the axis` };
  const t0 = near[Math.floor(near.length * 0.04)];
  const t1 = near[Math.floor(near.length * 0.96)];
  const A = [P0[0] + dx * t0, groundY, P0[2] + dz * t0];
  const B = [P0[0] + dx * t1, groundY, P0[2] + dz * t1];
  const L = Math.hypot(B[0] - A[0], B[2] - A[2]);
  // ── the fixed points, chosen out of the same dump ────────────────────────
  const alongA = (Q) => (Q[0] - A[0]) * dx + (Q[2] - A[2]) * dz;
  const latA = (Q) => Math.abs(-(Q[0] - A[0]) * dz + (Q[2] - A[2]) * dx);
  const pick = (pool, frac, latMin, latMax, taken) => {
    const want = L * frac;
    let best = null; let bd = Infinity;
    for (const s of pool) {
      const lat = latA(s.P);
      if (lat < latMin || lat > latMax) continue;
      if (taken.some((t) => Math.hypot(t[0] - s.P[0], t[2] - s.P[2]) < 1.5)) continue;
      const d = Math.abs(alongA(s.P) - want);
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return null;
    taken.push(best.P);
    return { P: best.P.map((v) => +v.toFixed(3)), N: best.N.map((v) => +v.toFixed(3)), E0: best.E.map((v) => +v.toFixed(4)) };
  };
  const takenG = []; const takenF = [];
  const ground = [0.2, 0.4, 0.6, 0.8].map((k) => pick(up, k, 0, 1.4, takenG)).filter(Boolean);
  const facade = [0.25, 0.45, 0.65, 0.85].map((k) => pick(side, k, 1.6, 10, takenF)).filter(Boolean);
  // ⭐⭐⭐ THE SCALE RECEIPT — WITHOUT IT EVERY PERCENTAGE BELOW IS UNREADABLE.
  //
  // A relative step |ΔE|/E is a fraction, and a fraction of a number at the
  // half-float denormal floor is a statement about rounding, not about light.
  // The first run of this probe reported "200 % steps" on a series whose median
  // was 1.6e-5 with R = B = 0 — which is the instrument describing the last
  // representable bit of a black texture. So the whole frame's distribution is
  // printed FIRST, for every stage, and any receipt that follows is void unless
  // the field it is about is actually lit. [[probe-blind-statistics]]
  const dist = (rows, get) => {
    const xs = rows.map(get).sort((a, b) => a - b);
    if (!xs.length) return null;
    const q = (p) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
    return { n: xs.length, zero: xs.filter((v) => v === 0).length, p05: q(0.05), p50: q(0.5), p95: q(0.95), max: xs[xs.length - 1] };
  };
  const L3 = (a) => 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  const all = [];
  for (let i = 0; i < n; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    all.push({
      before: [at(i, 2, 0), at(i, 2, 1), at(i, 2, 2)],
      after: [at(i, 3, 0), at(i, 3, 1), at(i, 3, 2)],
      lit: [at(i, 4, 0), at(i, 4, 1), at(i, 4, 2)],
      sh: at(i, 5, 0),
      gloss: at(i, 3, 3),
    });
  }
  const scale = {
    validPixels: all.length,
    irrBefore: dist(all, (r) => L3(r.before)),
    irrAfter: dist(all, (r) => L3(r.after)),
    lit: dist(all, (r) => L3(r.lit)),
    sunShadow: dist(all, (r) => r.sh),
    glossy: dist(all, (r) => r.gloss),
    pavementBefore: dist(up, (s) => L3(s.E)),
    // The channel split: a field that is green-only is the §19 4.3d emitter
    // bug, not a dim field, and the two need different fixes.
    meanRGB: [0, 1, 2].map((c) => all.reduce((a, r) => a + r.before[c], 0) / Math.max(1, all.length)),
    meanAfterRGB: [0, 1, 2].map((c) => all.reduce((a, r) => a + r.after[c], 0) / Math.max(1, all.length)),
    meanLitRGB: [0, 1, 2].map((c) => all.reduce((a, r) => a + r.lit[c], 0) / Math.max(1, all.length)),
  };
  const sys = globalThis.__giSys();
  const g = gi2?.gather;
  scale.gatherFrame = g?.frame ?? -1;
  scale.sun = (() => {
    const out = [];
    eng.scene.traverse((o) => {
      if (o.isDirectionalLight || o.isPointLight || o.isSpotLight) {
        out.push({ type: o.type, on: o.visible, intensity: o.intensity, color: [o.color.r, o.color.g, o.color.b] });
      }
    });
    return out.slice(0, 6);
  })();
  scale.giProps = (() => {
    const c = sys?.state ?? null;
    return { quality: sys?._quality ?? sys?.state?.quality ?? null, ao: !!sys?.state?.screen?.aoPass, hasScreen: !!c?.screen };
  })();
  return {
    scale,
    ok: true, A, B, L: +L.toFixed(2), dir: [dx, 0, dz], groundY: +groundY.toFixed(3),
    ground, facade, upN: up.length, sideN: side.length, attempts: D.attempts, axisSrc,
  };
}, { P0: rig.P, axis });
if (path.err) { console.log(`FATAL path: ${path.err}`); await browser.close(); process.exit(1); }
console.log(`  street axis: [${path.A.map((v) => v.toFixed(1))}] → [${path.B.map((v) => v.toFixed(1))}]  ` +
  `${path.L} m  groundY ${path.groundY}  axis from ${path.axisSrc}   ` +
  `(${path.upN} pavement / ${path.sideN} façade samples, dump attempts ${path.attempts})`);
// ══ THE SCALE RECEIPT ═══════════════════════════════════════════════════════
{
  const S = path.scale;
  const row = (label, d) => (d
    ? `  ${label.padEnd(16)} n ${String(d.n).padStart(6)}  exact-zero ${f((100 * d.zero) / d.n, 1).padStart(5)} %  ` +
      `p05 ${d.p05.toExponential(2)}  p50 ${d.p50.toExponential(2)}  p95 ${d.p95.toExponential(2)}  max ${d.max.toExponential(2)}`
    : `  ${label.padEnd(16)} —`);
  console.log(`\n  ── the frame's own scale (${S.validPixels} valid pixels, gather frame ${S.gatherFrame}) ──`);
  console.log(row("irr BEFORE AO", S.irrBefore));
  console.log(row("irr AFTER  AO", S.irrAfter));
  console.log(row("gi2 lit", S.lit));
  console.log(row("glossy lum", S.glossy));
  console.log(row("sun shadow", S.sunShadow));
  console.log(row("pavement irr", S.pavementBefore));
  console.log(`  mean rgb  before [${S.meanRGB.map((v) => v.toExponential(2))}]  ` +
    `after [${S.meanAfterRGB.map((v) => v.toExponential(2))}]  lit [${S.meanLitRGB.map((v) => v.toExponential(2))}]`);
  console.log(`  lights: ${S.sun.map((l) => `${l.type}${l.on ? "" : "(off)"} i=${l.intensity}`).join(", ") || "none"}`);
  const p50 = S.irrBefore?.p50 ?? 0;
  // ⛔⛔⛔ THE DEAD-BOOT GATE, AND IT COST A WHOLE BATTERY TO LEARN.
  //
  // This probe's first two runs produced a complete, plausible, entirely VOID
  // receipt: 890 frames per arm, an attribution table, cross-arm controls — all
  // of it computed on an irradiance field whose median was 1.6e-5 with R = B =
  // 0, i.e. the half-float denormal floor of a BLACK texture. `[gi2] first
  // light` had never arrived (the intermittent dead boot, ~2 in 9), and every
  // "200 % lighting jump" in that table was the last representable bit of
  // nothing moving. A settle timer is not evidence that a field exists.
  //
  // So the arms do not run unless the frame is measurably lit. A probe that
  // reports numbers off a dead boot is worse than one that reports nothing.
  // [[probe-blind-statistics]] [[gi-watchdog-false-fire]]
  if (!(p50 > 1e-3)) {
    console.log(`
  ⛔⛔ DEAD BOOT — the irradiance field is at the half-float floor ` +
      `(p50 ${p50.toExponential(2)}, mean rgb [${S.meanRGB.map((v) => v.toExponential(2))}]).`);
    console.log(`      first light console line: ${firstLight ? "seen" : "NEVER SEEN"}. ` +
      `Every relative step this probe could report would be a statement about rounding.`);
    console.log(`      Re-run; the dead boot is intermittent (~2 in 9). NOT RUNNING THE ARMS.`);
    await browser.close();
    process.exit(2);
  }
}
for (const [k, g] of path.ground.entries()) console.log(`    ground ${k} [${g.P}]  n [${g.N}]  E0 [${g.E0}]`);
for (const [k, s] of path.facade.entries()) console.log(`    façade ${k} [${s.P}]  n [${s.N}]  E0 [${s.E0}]`);
if (path.ground.length < 2 || path.facade.length < 1 || path.L < 12) {
  console.log("FATAL: not enough street to run on"); await browser.close(); process.exit(1);
}

// ══════════════════════════════════════════════════════ 3. THE IN-PAGE RECORDER
const installed = await page.evaluate(async ({ path }) => {
  const eng = globalThis.__giEngineForProbe;
  const sys = globalThis.__giSys();
  const gi2 = globalThis.__gi2();
  const stats = eng?.stats;
  if (!stats?.endPhaseFrame) return { ok: false, why: "no engine.stats" };
  const viewport = globalThis.__giViewport;
  if (!viewport?.camera) return { ok: false, why: "no viewport camera" };
  const { createGi2PointSampler } = await import("/scripts/lib/gi2PointProbe.js");
  const sampler = createGi2PointSampler({ renderer: eng.renderer, gi2, screen: sys.state.screen });
  if (!sampler) return { ok: false, why: "no point sampler" };

  // ⚠ THE SCRIPT HOT-RELOAD POLL IS A HARNESS ARTIFACT. Under the tauri shim
  // its re-import throws, and the frame carrying the `console.error` pair runs
  // 40-160 ms — a frame-rate artefact inside a receipt about temporal
  // smoothness. Bistro carries exactly two such scripts (the Player's).
  eng.config ??= {};
  eng.config.scriptHotReload = false;

  const player = globalThis.__giPlayer;
  const world = gi2?.gather?.world ?? null;
  const NC = world?.describe?.()?.cascades ?? 0;
  const R = {
    frames: [], plan: null, at: 0, arm: "boot", done: true, pending: [], err: null,
    runPos: path.A, noDyn: false,
  };
  globalThis.__gi2Runner = R;

  // ── projection ───────────────────────────────────────────────────────────
  //
  // ⚠ EVEN PIXELS ONLY. `resolveHalf` dispatches over the half-res grid and
  // each thread reads the gbuffer at (2gx, 2gy) (`gatherProbes.js:3651`); the
  // diag row that describes a full-res pixel is the one at (px>>1, py>>1) ONLY
  // when px and py are even. An odd pixel would pair one surface's irradiance
  // with another surface's diagnostics, which is the exact confusion this probe
  // exists to remove.
  const project = (P) => {
    const cam = viewport.camera;
    const e = cam.matrixWorldInverse.elements;
    const vx = e[0] * P[0] + e[4] * P[1] + e[8] * P[2] + e[12];
    const vy = e[1] * P[0] + e[5] * P[1] + e[9] * P[2] + e[13];
    const vz = e[2] * P[0] + e[6] * P[1] + e[10] * P[2] + e[14];
    const q = cam.projectionMatrix.elements;
    const cx = q[0] * vx + q[4] * vy + q[8] * vz + q[12];
    const cy = q[1] * vx + q[5] * vy + q[9] * vz + q[13];
    const cw = q[3] * vx + q[7] * vy + q[11] * vz + q[15];
    if (!(cw > 1e-4)) return null;
    const px = ((cx / cw) * 0.5 + 0.5) * sampler.width;
    const py = (0.5 - (cy / cw) * 0.5) * sampler.height;
    if (!(px >= 4 && py >= 4 && px < sampler.width - 4 && py < sampler.height - 4)) return null;
    return [2 * Math.round(px / 2), 2 * Math.round(py / 2)];
  };
  const cluster = (P, k = 1) => {
    const c = project(P);
    if (!c) return [];
    const out = [];
    for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) out.push([c[0] + 2 * dx, c[1] + 2 * dy]);
    return out;
  };

  const SERIES = [];
  for (let i = 0; i < path.ground.length; i++) SERIES.push({ key: `g${i}`, kind: "ground", P: path.ground[i].P });
  for (let i = 0; i < path.facade.length; i++) SERIES.push({ key: `f${i}`, kind: "facade", P: path.facade[i].P });
  // `near` — the pavement 1.5 m to the LEFT of the runner. It moves with the
  // runner (so it can traverse) and it is never occluded by the body (so its
  // samples are pavement, not shirt). It is the series cause B has to move.
  SERIES.push({ key: "near", kind: "moving" });
  // `body` — the runner's own lit pixels, masked by its world box.
  SERIES.push({ key: "body", kind: "body" });

  const nx = -path.dir[2]; const nz = path.dir[0];
  const buildPixels = (runPos) => {
    const list = []; const spans = [];
    for (const s of SERIES) {
      if (s.kind === "body") {
        // A world box round the rig: ±0.45 m in XZ, 0 … 1.85 m up. Projecting
        // its eight corners gives a screen box; the world-box test then keeps
        // only the pixels that really landed on the body, so a lamp post in
        // front of it is DROPPED rather than averaged in.
        const lo = [runPos[0] - 0.45, path.groundY - 0.05, runPos[2] - 0.45];
        const hi = [runPos[0] + 0.45, path.groundY + 1.85, runPos[2] + 0.45];
        let a = null; let b = null;
        for (let k = 0; k < 8; k++) {
          const p = project([k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]]);
          if (!p) continue;
          a = a ? [Math.min(a[0], p[0]), Math.min(a[1], p[1])] : [p[0], p[1]];
          b = b ? [Math.max(b[0], p[0]), Math.max(b[1], p[1])] : [p[0], p[1]];
        }
        const px = [];
        if (a && b) {
          for (let iy = 0; iy < 10; iy++) {
            for (let ix = 0; ix < 8; ix++) {
              const x = a[0] + ((b[0] - a[0]) * (ix + 0.5)) / 8;
              const y = a[1] + ((b[1] - a[1]) * (iy + 0.5)) / 10;
              px.push([2 * Math.round(x / 2), 2 * Math.round(y / 2)]);
            }
          }
        }
        spans.push({ key: s.key, from: list.length, n: px.length, box: [lo, hi], tol: 0.15 });
        for (const p of px) list.push(p);
        continue;
      }
      const target = s.kind === "moving"
        ? [runPos[0] + nx * 1.5, path.groundY + 0.02, runPos[2] + nz * 1.5]
        : s.P;
      // ⚠ FIVE BY FIVE, NOT THREE BY THREE. The f3 façade series ran at a
      // MEDIAN OF ONE valid pixel at range, and a one-pixel mean has no spread
      // to report — the very statistic that separates spatial speckle from
      // temporal churn was missing exactly where the biggest steps were.
      const px = cluster(target, 2);
      spans.push({ key: s.key, from: list.length, n: px.length, target, tol: s.kind === "moving" ? 0.5 : 0.35 });
      for (const p of px) list.push(p);
    }
    return { list, spans };
  };

  const LUM = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sig = (v) => (Number.isFinite(v) ? +v.toPrecision(6) : 0);
  const reduce = (raw, spans, rec) => {
    const OV = sampler.OUT_VEC; const DV = sampler.DV;
    const out = {};
    for (const sp of spans) {
      let n = 0; let r = 0; let g = 0; let b = 0; let pre = 0;
      // ⭐⭐⭐ THE SPATIAL SPREAD, AND IT IS THE WHOLE DIAGNOSIS.
      //
      // A series' mean stepping 100 % between two frames has two completely
      // different causes with completely different fixes: the FIELD moved in
      // time, or the field is SPECKLED in space and the camera re-sampled it.
      // A fixed world point projects to a different pixel every frame, and if
      // neighbouring pixels of one flat wall disagree by 10x, a camera that
      // moves 8 cm converts that spatial disagreement into temporal flicker.
      // The mean cannot tell them apart. The spread within one frame's own
      // samples can: lo/hi/sd over the very pixels the mean averaged.
      const Ls = [];
      // ⭐⭐⭐ §19 4.9 — THE OWNERSHIP MOSAIC, PER PIXEL.
      //
      // The user's `src-probes` screenshot of a Bistro façade shows c0's 0.5 m
      // cells as a PATCHWORK on one flat wall: light-blue c0-owned cells with
      // green c1-owned gaps between them. Two adjacent pixels of one plane
      // answered by two different lattices holding two different values IS the
      // per-pixel bimodality, and no column in this probe could see it — the
      // `d` rows below are MEANS over the cluster, and a mean over a mosaic is
      // a smooth number describing a checkerboard. [[probe-blind-statistics]]
      //
      // So the argmax over each PIXEL's own `claim` row is kept, and the
      // fraction of the patch that disagrees with the patch's modal owner is
      // reported beside the spread. `mixD` is what it costs: the mean
      // luminance of the minority owner against the majority's, so "they
      // disagree about who answers" and "they disagree about the answer" are
      // two numbers rather than one worry.
      const owners = [];
      const ownL = [];
      const dg = Array.from({ length: DV }, () => [0, 0, 0, 0]);
      for (let k = 0; k < sp.n; k++) {
        const o = (sp.from + k) * OV * 4;
        if (!(raw[o + 3] > 0.5)) continue;
        const W = [raw[o], raw[o + 1], raw[o + 2]];
        if (sp.box) {
          const [lo, hi] = sp.box;
          if (W[0] < lo[0] - sp.tol || W[0] > hi[0] + sp.tol
            || W[1] < lo[1] - sp.tol || W[1] > hi[1] + sp.tol
            || W[2] < lo[2] - sp.tol || W[2] > hi[2] + sp.tol) continue;
        } else {
          const d = Math.hypot(W[0] - sp.target[0], W[1] - sp.target[1], W[2] - sp.target[2]);
          if (d > sp.tol) continue;
        }
        n++;
        r += raw[o + 4]; g += raw[o + 5]; b += raw[o + 6];
        Ls.push(LUM(raw[o + 4], raw[o + 5], raw[o + 6]));
        // The LAST cascade's `.w` is the resolve's OWN luminance, BEFORE
        // `resolveUpsample`'s image blend (`gatherProbes.js:4052`) — the whole
        // basis of the E column.
        if (DV) pre += raw[o + (3 + DV - 1) * 4 + 3];
        for (let c = 0; c < DV; c++) {
          const q = o + (3 + c) * 4;
          dg[c][0] += raw[q]; dg[c][1] += raw[q + 1]; dg[c][2] += raw[q + 2]; dg[c][3] += raw[q + 3];
        }
        // Which cascade SPENT this pixel — the argmax of its own claim column.
        // ⚠ `NC` — the IN-PAGE cascade count. `NCASC` is a Node-side const and
        // referencing it here throws once per frame inside `page.evaluate`,
        // which empties every series and inflates the frame time the same
        // receipt is reading. The reducer runs in the browser.
        let dom = -1; let dc = -1;
        for (let c = 0; c < NC; c++) {
          const cl = raw[o + (3 + c) * 4 + 2];
          if (cl > dc) { dc = cl; dom = c; }
        }
        owners.push(dom);
        ownL.push(LUM(raw[o + 4], raw[o + 5], raw[o + 6]));
      }
      if (!n) { out[sp.key] = { n: 0 }; continue; }
      // ⚠⚠ SIGNIFICANT FIGURES, NOT DECIMAL PLACES. `toFixed(6)` on a field
      // whose median is 1.6e-5 keeps ONE digit, and a one-digit series steps by
      // 100 % every time its last bit moves — the first run of this probe
      // reported exactly that and called it a lighting jump. `sig` keeps six
      // significant figures whatever the exponent, so the receipt's resolution
      // does not depend on how bright the scene happens to be.
      const mu = Ls.reduce((a, x) => a + x, 0) / n;
      const sd = Math.sqrt(Ls.reduce((a, x) => a + (x - mu) * (x - mu), 0) / n);
      const tally = new Map();
      for (const d of owners) tally.set(d, (tally.get(d) ?? 0) + 1);
      let modal = -1; let best = -1;
      for (const [d, c] of tally) if (c > best) { best = c; modal = d; }
      const mix = owners.length ? 1 - best / owners.length : 0;
      const maj = ownL.filter((_, i) => owners[i] === modal);
      const min_ = ownL.filter((_, i) => owners[i] !== modal);
      const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN);
      const mA = avg(maj); const mI = avg(min_);
      out[sp.key] = {
        n,
        E: [sig(r / n), sig(g / n), sig(b / n)],
        L: sig(LUM(r / n, g / n, b / n)),
        pre: sig(pre / n),
        lo: sig(Math.min(...Ls)), hi: sig(Math.max(...Ls)), sd: sig(sd),
        // The ownership mosaic: what share of this patch is answered by a
        // cascade OTHER than its modal one, and how far apart the two groups'
        // luminances are.
        mix: +mix.toFixed(4),
        mixD: Number.isFinite(mI) && mA > 1e-6 ? +Math.abs(mI - mA) / mA : 0,
        d: dg.map((v) => v.map((x) => +(x / n).toFixed(4))),
      };
    }
    rec.ser = out;
  };

  // ── the per-frame hook ───────────────────────────────────────────────────
  //
  // `endPhaseFrame` is the one call the engine makes exactly once per tick, on
  // every early-return path included — the same anchor `probe:gi2-motion` uses.
  // A `requestAnimationFrame` loop would race the engine's own rAF and could
  // sample a frame the GI chain had not finished writing.
  let lastNow = performance.now();
  const rawEnd = stats.endPhaseFrame.bind(stats);
  stats.endPhaseFrame = function () {
    rawEnd();
    const now = performance.now();
    const dt = now - lastNow;
    lastNow = now;
    if (R.done || !R.plan) return;
    const step = R.plan.steps[R.at];
    if (!step) { R.done = true; R.plan = null; return; }

    // ⚠ THE B CONTROL IS RE-APPLIED EVERY FRAME. `#refreshGi2Movers` re-derives
    // whenever `_gi2MoversDirty` is set (`GISystem.js:18582`), and an arm whose
    // control silently switched itself back on halfway is worse than no arm.
    if (R.noDyn) {
      sys._gi2Movers = [];
      sys._gi2MoversDirty = false;
      if (!R.noDynApplied) { gi2.setMovers([]); R.noDynApplied = true; }
    }

    const cam = viewport.camera;
    const runPos = R.runPos;
    const { list, spans } = buildPixels(runPos);
    const rec = {
      i: R.frames.length, arm: R.arm, seg: step.seg, s: +step.s.toFixed(3), dt: +dt.toFixed(2),
      cp: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
      rp: [+runPos[0].toFixed(2), +runPos[1].toFixed(2), +runPos[2].toFixed(2)],
    };
    // ⭐ THE LATTICE ORIGINS, PER FRAME AND EXACTLY. `snapshot().gather` is the
    // last stats READBACK and lags up to `statsCadence()` = 30 frames, so a
    // scroll read from it cannot be aligned with the frame that paid for it.
    // The origin uniforms ARE the scroll, and cost no readback at all.
    if (world?.origins) rec.org = world.origins.map((o) => [o.value.x, o.value.y, o.value.z]);
    const snap = gi2?.snapshot ? gi2.snapshot() : null;
    rec.scrolls = snap?.scrolls ?? 0;
    rec.movers = snap?.movers ?? 0;
    rec.dynVox = snap?.dynamic?.voxelsSet ?? -1;
    rec.moving = sys?._gi2MoversMoving ?? -1;
    const gs = snap?.gather ?? null;
    if (gs) {
      rec.gs = {
        alphaForced: gs.alphaForced ?? 0, probesFresh: gs.probesFresh ?? 0,
        wpCoarseMoved: gs.wpCoarseMoved ?? 0, wpCoarseFar: gs.wpCoarseFar ?? 0,
        wpCoarseOut: gs.wpCoarseOut ?? 0, freshShades: gs.freshShades ?? 0,
      };
    }

    if (list.length) {
      try {
        const p = sampler.dispatch(list);
        if (p) {
          R.frames.push(rec);
          R.pending.push(p.then((raw) => reduce(raw, spans, rec))
            .catch((e) => { R.err ??= String(e?.message ?? e); }));
        } else R.frames.push(rec);
      } catch (e) { R.err ??= String(e?.message ?? e); R.frames.push(rec); }
    } else R.frames.push(rec);

    // ── drive the next frame ────────────────────────────────────────────────
    R.at++;
    const next = R.plan.steps[R.at];
    if (!next) { R.done = true; return; }
    R.runPos = next.p;
    cam.position.set(next.cam[0], next.cam[1], next.cam[2]);
    if (viewport.orbit) { viewport.orbit.target.set(next.tgt[0], next.tgt[1], next.tgt[2]); viewport.orbit.update(); }
    else cam.lookAt(next.tgt[0], next.tgt[1], next.tgt[2]);
    if (player) {
      // ⚠ `entity.setTransform` DOES NOT UPDATE `matrixWorld` (`Entity.js:486`),
      // and `#refreshGi2Movers` reads `mesh.matrixWorld` BY REFERENCE inside the
      // tick, BEFORE `renderer.render` refreshes it — so a mover driven without
      // this call lags the pose by exactly one frame, on every frame.
      player.object3D.position.set(next.p[0], next.p[1], next.p[2]);
      player.object3D.updateMatrixWorld(true);
    }
  };

  // ⭐⭐⭐ THE RESOLVE'S OWN LEVERS, AS ARMS. `worldProbes` publishes `wpFaceOn`
  // and `wpVisOn` as UNIFORMS precisely so a receipt can remove one term and
  // re-read the same scene out of the SAME binary and the same shader cache
  // (`worldProbes.js:583-585`). Turning the face gate off is the only way to
  // ask "is the per-pixel cliff the `wf` term" that is not an argument about
  // the code: `wf` is the one factor in the eight-corner weight that `cov`,
  // `claim` and `fresh` do NOT contain, so it is exactly the term that can
  // collapse `wsumC` to zero while every diagnostic this probe reads stays
  // flat — and `resolveHalf` then spends the claim on a black pixel by design
  // ("a cascade that covers the point spends its claim even if its weights came
  // out zero", `gatherProbes.js:3926`).
  const uniDefaults = {};
  R.setUni = (over) => {
    const g = gi2?.gather;
    if (!g?.uniforms) return null;
    const applied = {};
    for (const [k, v] of Object.entries(over ?? {})) {
      const u = g.uniforms[k];
      if (!u) continue;
      if (!(k in uniDefaults)) uniDefaults[k] = u.value;
      u.value = v;
      applied[k] = v;
    }
    return applied;
  };
  R.restoreUni = () => {
    const g = gi2?.gather;
    for (const [k, v] of Object.entries(uniDefaults)) if (g?.uniforms?.[k]) g.uniforms[k].value = v;
  };
  R.run = (arm, steps, noDyn) => {
    R.frames = []; R.pending = []; R.at = 0; R.arm = arm; R.done = false;
    R.noDyn = !!noDyn; R.noDynApplied = false;
    R.runPos = steps[0].p;
    R.plan = { steps };
    const cam = viewport.camera;
    cam.position.set(steps[0].cam[0], steps[0].cam[1], steps[0].cam[2]);
    if (viewport.orbit) { viewport.orbit.target.set(steps[0].tgt[0], steps[0].tgt[1], steps[0].tgt[2]); viewport.orbit.update(); }
    else cam.lookAt(steps[0].tgt[0], steps[0].tgt[1], steps[0].tgt[2]);
    if (player) {
      player.object3D.position.set(steps[0].p[0], steps[0].p[1], steps[0].p[2]);
      player.object3D.updateMatrixWorld(true);
    }
  };
  R.restoreDyn = () => {
    R.noDyn = false;
    sys._gi2MoversDirty = true;
  };
  R.finish = async () => { await Promise.all(R.pending); return { frames: R.frames, err: R.err }; };
  return {
    ok: true, hasDiag: sampler.hasDiag, DV: sampler.DV, DC: sampler.DC, NC,
    world: world?.describe?.() ?? null, hasPlayer: !!player,
  };
}, { path });

if (!installed.ok) { console.log(`FATAL install: ${installed.why}`); await browser.close(); process.exit(1); }
console.log(`  recorder in: diag ${installed.hasDiag ? `yes (${installed.DC} cascade rows + 1 fallback row of ${installed.DV})` : "NO — __gi2NoiseDump missed"}` +
  `, world ${installed.world ? `${installed.world.cascades}×${installed.world.cells}³ spacings ${installed.world.spacings.join("/")} m, ` +
    `extents ${installed.world.extents.join("/")} m` : "OFF"}` +
  `, player ${installed.hasPlayer ? "yes" : "no"}`);
if (!installed.hasDiag) console.log("  ⚠ WITHOUT diagBuf EVERY ATTRIBUTION COLUMN IS BLIND — steps will read `unknown`.");

// ══════════════════════════════════════════════════════════════ 4. THE PLANS
const STEP_M = SPEED / FPS;
const LEG = Math.max(12, Math.min(path.L - 2, SPEED * SECONDS));
const LEG_FRAMES = Math.round(LEG / STEP_M);
const dirU = path.dir;
const at = (s) => [path.A[0] + dirU[0] * s, path.groundY, path.A[2] + dirU[2] * s];
const camFor = (s, sign) => {
  const p = at(s);
  return {
    cam: [p[0] - dirU[0] * 4.5 * sign, path.groundY + 1.9, p[2] - dirU[2] * 4.5 * sign],
    tgt: [p[0], path.groundY + 1.1, p[2]],
  };
};
// ⭐ THE PARKED CAMERA LOOKS DOWN THE STREET, NOT ACROSS IT. A camera 9 m to
// the side sees about 10 m of a 38 m run, so seven of the ten series would go
// off-screen for most of the arm and the E control would be comparing two
// different populations. From 6 m BEHIND the start, aimed at the far end, every
// fixed point and the runner itself stay in frame for the whole leg.
const parkPose = {
  cam: [path.A[0] - dirU[0] * 6, path.groundY + 2.4, path.A[2] - dirU[2] * 6],
  tgt: [path.A[0] + dirU[0] * LEG, path.groundY + 1.0, path.A[2] + dirU[2] * LEG],
};
const makeSteps = (arm) => {
  const steps = [];
  const follow = arm !== "static";
  // ⭐⭐ THE WARM SEGMENT IS THROWN AWAY, AND THAT IS THE POINT. Starting an arm
  // is a camera JUMP, and §19 3.19 measured what a jump costs: a post-jump park
  // reads 41.5 / 56.0 / 1.5 / 29.4 … % for about six frames and beats at the
  // round-robin period for a few more, against 0.0-0.4 % for a park that was
  // never jumped into. Folding that into the control would make every arm's
  // "the field churns at rest" reading a measurement of this probe's own
  // entrance. `warm` is recorded (it is in the JSON) and excluded from every
  // table, which are keyed on park/out/back by name.
  for (let k = 0; k < WARM_FRAMES; k++) {
    steps.push({ seg: "warm", s: 0, p: at(0), ...(follow ? camFor(0, 1) : parkPose) });
  }
  // ⭐ THE PARK SEGMENT IS THE CONTROL, NOT A WARM-UP. The rig's `animation` has
  // `playInEditor: true`, so the skeleton keeps moving while the ROOT does not:
  // a field that steps here is churning on its own (or on the animation alone),
  // and no motion-side fix would reach it. [[probe-blind-statistics]]
  for (let k = 0; k < PARK_FRAMES; k++) {
    steps.push({ seg: "park", s: 0, p: at(0), ...(follow ? camFor(0, 1) : parkPose) });
  }
  for (let k = 0; k <= LEG_FRAMES; k++) {
    const s = k * STEP_M;
    steps.push({ seg: "out", s, p: at(s), ...(follow ? camFor(s, 1) : parkPose) });
  }
  // The return leg over the SAME ground: a step that repeats at the same `s` is
  // position-keyed (traversal / interpolation); one that does not is time-keyed
  // (lifecycle / accumulator). One arm, both readings.
  for (let k = LEG_FRAMES; k >= 0; k--) {
    const s = k * STEP_M;
    steps.push({ seg: "back", s, p: at(s), ...(follow ? camFor(s, -1) : parkPose) });
  }
  return steps;
};

// ══════════════════════════════════════════════════════════════ 5. THE ARMS
// The resolve-term arms. Each is the `run` arm with ONE uniform removed, so a
// difference is that term and nothing else — one boot, one shader cache.
const ARM_UNI = {
  faceoff: { wpFaceOn: 0 },
  visoff: { wpVisOn: 0 },
  covfull1: { wpCovFull: 1 },
};
const results = {};
for (const arm of ARMS) {
  const steps = makeSteps(ARM_UNI[arm] ? "run" : arm);
  console.log(`\n── arm "${arm}" — ${steps.length} frames, leg ${f(LEG, 1)} m at ${f(STEP_M * 100, 1)} cm/frame ──`);
  if (ARM_UNI[arm]) {
    const got = await page.evaluate((o) => globalThis.__gi2Runner.setUni(o), ARM_UNI[arm]);
    console.log(`  uniforms: ${got ? JSON.stringify(got) : "NOT REACHABLE"}`);
    if (!got || !Object.keys(got).length) {
      console.log("  ⚠ THE LEVER DID NOT TAKE — this arm is a repeat of `run`, not a control.");
    }
    await wait(5000);
  }
  await page.evaluate(({ arm, steps, noDyn }) => {
    globalThis.__gi2Runner.run(arm, steps, noDyn);
  }, { arm, steps, noDyn: arm === "nodyn" });
  const deadline = Date.now() + 20 * 60 * 1000;
  let done = false;
  while (!done && Date.now() < deadline) {
    await wait(1500);
    done = await page.evaluate(() => globalThis.__gi2Runner.done);
  }
  const got = await page.evaluate(async () => globalThis.__gi2Runner.finish());
  results[arm] = got.frames;
  const dts = got.frames.map((r) => r.dt).filter((v) => v > 0);
  const vox = got.frames.map((r) => r.dynVox).filter((v) => v >= 0);
  console.log(`  ${got.frames.length} frames, real ${f(1000 / (mean(dts) || 1), 1)} fps ` +
    `(median frame ${f(pctl(dts, 50), 1)} ms), dynamic voxelsSet median ${pctl(vox, 50)}` +
    `${got.err ? `  ⚠ ${got.err}` : ""}`);
  if (arm === "nodyn") {
    await page.evaluate(() => globalThis.__gi2Runner.restoreDyn());
    await wait(4000);
  }
  if (ARM_UNI[arm]) {
    await page.evaluate(() => globalThis.__gi2Runner.restoreUni());
    await wait(5000);
  }
}

// ══════════════════════════════════════════════════════════════ 6. THE ANALYSIS
const SERIES_KEYS = [
  ...path.ground.map((_, i) => `g${i}`),
  ...path.facade.map((_, i) => `f${i}`),
  "near", "body",
];
const KIND = (k) => (k === "near" ? "moving" : k === "body" ? "body" : k[0] === "g" ? "ground" : "façade");
const FIXED = (k) => k[0] === "g" || k[0] === "f";
/**
 * §19 4.9. `diagBuf` is `DC` cascade rows then ONE fallback row; the fallback
 * row is always the last, so its index is `DV - 1` on every tier.
 */
const NCASC = installed.DC ?? installed.DV ?? 0;
const FBROW = Math.max(0, (installed.DV ?? 0) - 1);

// ⭐⭐⭐ THE LIT FLOOR, DERIVED FROM THE FRAME RATHER THAN CHOSEN.
//
// `|ΔE|/E` on a pair of values at the half-float denormal floor is a statement
// about the last representable bit, and it will happily report 200 %. So a step
// is SCORED only where there is light to step: the brighter of the two frames
// must clear a tenth of the frame's own median irradiance. A dark arm and a
// bright one are then judged the same way and no constant is a threshold — the
// same rule `probe:gi2-motion`'s `G.lit` uses on its own signal.
//
// `dropped` is reported beside every table: an arm whose steps were nearly all
// dropped has not been shown to be smooth, it has been shown to be BLACK, and
// those are different findings.
const LIT_FLOOR = Math.max(1e-6, 0.1 * (path.scale?.irrBefore?.p50 ?? 0));
let DROPPED = 0; let KEPT = 0;
const stepsOf = (frames, key, seg = null) => {
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]; const b = frames[i];
    if (a.seg !== b.seg) continue;
    if (seg && b.seg !== seg) continue;
    const sa = a.ser?.[key]; const sb = b.ser?.[key];
    if (!sa?.n || !sb?.n) continue;
    if (Math.max(sa.L, sb.L) < LIT_FLOOR) { DROPPED++; continue; }
    const m = 0.5 * (sa.L + sb.L);
    if (!(m > 0)) continue;
    KEPT++;
    out.push({ i, r: Math.abs(sb.L - sa.L) / m, a, b, key });
  }
  return out;
};

/** Autocorrelation time: the first lag where r(τ) falls below 1/e. */
const tauOf = (frames, key, seg) => {
  const xs = [];
  for (const fr of frames) {
    if (seg && fr.seg !== seg) continue;
    const s = fr.ser?.[key];
    xs.push(s?.n ? s.L : NaN);
  }
  const v = xs.filter(Number.isFinite);
  if (v.length < 30) return NaN;
  const mu = mean(v);
  const c = xs.map((x) => (Number.isFinite(x) ? x - mu : NaN));
  let v0 = 0; let n0 = 0;
  for (const x of c) if (Number.isFinite(x)) { v0 += x * x; n0++; }
  v0 /= Math.max(1, n0);
  if (!(v0 > 1e-14)) return NaN;
  for (let lag = 1; lag < Math.min(240, c.length - 2); lag++) {
    let s = 0; let n = 0;
    for (let i = 0; i + lag < c.length; i++) {
      if (Number.isFinite(c[i]) && Number.isFinite(c[i + lag])) { s += c[i] * c[i + lag]; n++; }
    }
    if (n < 10) break;
    if (s / n / v0 < Math.exp(-1)) return lag;
  }
  return NaN;
};

/**
 * ⭐⭐ THE ATTRIBUTION. Every indicator is a DELTA of the same registers the
 * composite was built from, so a class is a measurement of the resolve and not
 * a story about it. The priority order is the causal one: a probe re-keyed this
 * frame explains its own `cov` change, so D outranks C; and a step the resolve
 * did not make at all (pre-blend flat) belongs to the accumulator before any
 * field term is consulted.
 */
const classify = (st) => {
  const A = st.a.ser[st.key]; const B = st.b.ser[st.key];
  const dA = A.d ?? []; const dB = B.d ?? [];
  const ind = { fresh: 0, cov: 0, claim: 0, vis: 0, scroll: 0, pre: NaN, fb: 0, face: 0, csum: NaN };
  // ⚠⚠ THE LAST *ROW* IS NOT A CASCADE. `resolveHalf` writes `NCASC` rows of
  // `vec4(cov, fresh, claim, vis)` and then §19 4.9's FALLBACK row
  // `vec4(faceCov, tail, csum, luminance)`. Scoring that row as a fourth
  // cascade reads `faceCov` as `cov` and the resolve's own luminance as `vis`
  // — the tautology that was 21 % of this probe's first attribution table,
  // re-created one row over. `NCASC` comes from the gather itself.
  let domA = -1; let domB = -1; let cA = -1; let cB = -1;
  for (let c = 0; c < Math.min(NCASC, dA.length); c++) {
    if (!dA[c] || !dB[c]) continue;
    ind.cov = Math.max(ind.cov, Math.abs(dB[c][0] - dA[c][0]));
    ind.fresh = Math.max(ind.fresh, Math.abs(dB[c][1] - dA[c][1]));
    ind.claim = Math.max(ind.claim, Math.abs(dB[c][2] - dA[c][2]));
    if (dA[c][0] > 0.05 && dB[c][0] > 0.05) {
      ind.vis = Math.max(ind.vis, Math.abs(dB[c][3] - dA[c][3]));
    }
    if (dA[c][2] > cA) { cA = dA[c][2]; domA = c; }
    if (dB[c][2] > cB) { cB = dB[c][2]; domB = c; }
  }
  // ⭐⭐ §19 4.9 — THE TWO SWITCHES §AE COULD NOT SEE. `tail` is the share of
  // this sample's pixels the fallback carried (0/1 per pixel before 4.9, a
  // ramp after it), `faceCov` its own input, and `csum` the conservation sum.
  const fbA = dA[FBROW]; const fbB = dB[FBROW];
  if (fbA && fbB) {
    ind.fb = Math.abs(fbB[1] - fbA[1]);
    ind.face = Math.abs(fbB[0] - fbA[0]);
    ind.csum = Math.min(fbA[2], fbB[2]);
  }
  // Which cascade SPENT the pixel. A flip here is the hand-off changing hands,
  // and both `cov` and `claim` can stay flat through one.
  ind.dom = domA !== domB ? 1 : 0;
  // The field's own speckle at the pixels this step was measured on.
  const spread = (v) => (v?.n > 1 && v.L > 1e-6 ? (v.hi - v.lo) / v.L : 0);
  ind.spread = Math.max(spread(A), spread(B));
  const oa = st.a.org; const ob = st.b.org;
  if (oa && ob) {
    for (let c = 0; c < oa.length; c++) for (let k = 0; k < 3; k++) if (oa[c][k] !== ob[c][k]) ind.scroll = 1;
  }
  const mPre = 0.5 * (A.pre + B.pre);
  ind.pre = mPre > 1e-5 ? Math.abs(B.pre - A.pre) / mPre : NaN;

  if (ind.fresh > 0.03) return { cls: "D seeded probe ramping", ind };
  if (ind.scroll) return { cls: "D window scroll", ind };
  if (Number.isFinite(ind.pre) && ind.pre < 0.35 * st.r) return { cls: "E accumulator", ind };
  if (ind.dom) return { cls: "C dominant cascade flip", ind };
  if (ind.cov > 0.03) return { cls: "C corner liveness (cov)", ind };
  if (ind.claim > 0.03) return { cls: "C hand-off claim", ind };
  if (ind.vis > 0.05) return { cls: "C Chebyshev vis", ind };
  // ⭐⭐ §19 4.9. Deliberately BELOW every C class and ABOVE both F classes: the
  // question §AE left open is whether the "every weight flat" residual is the
  // fallback switching, so the fallback may only claim a step no cascade term
  // explains. A share here is a measurement of that residual, not a re-priced
  // one.
  if (ind.fb > 0.03) return { cls: "G fallback switch", ind };
  // ⭐⭐ THE RESIDUAL IS NOT "UNKNOWN" — IT IS A NAMED MECHANISM. Every weight
  // the resolve builds its composite from is flat, and the answer still moved.
  // What is left is the RADIANCE the eight corners hold — and if the field is
  // speckled at the pixel scale, a camera that moved 8 cm merely RE-SAMPLED it.
  // So the residual splits on the spread the frame itself measured, which is a
  // number rather than a story.
  if (ind.spread > 0.5) return { cls: "F spatial speckle re-sampled", ind };
  if (FIXED(st.key)) return { cls: "F probe radiance moved (fixed pt)", ind };
  return { cls: "A traversal", ind };
};

const armReport = (arm) => {
  const frames = results[arm] ?? [];
  if (!frames.length) return;
  console.log(`\n══ arm "${arm}" ═══════════════════════════════════════════════`);
  console.log(`  series  kind    seg     n  px50 sprd  mix  mixD    E p50    step p50   p90      max     >${STEP_PCT}%  >${BIG_PCT}%   τ`);
  for (const key of SERIES_KEYS) {
    for (const seg of ["park", "out", "back"]) {
      const st = stepsOf(frames, key, seg);
      if (st.length < 5) continue;
      const rs = st.map((x) => x.r);
      const Ls = frames.filter((fr) => fr.seg === seg && fr.ser?.[key]?.n).map((fr) => fr.ser[key].L);
      const tau = tauOf(frames, key, seg);
      const spr = frames.filter((fr) => fr.seg === seg && fr.ser?.[key]?.n > 1 && fr.ser[key].L > 1e-6)
        .map((fr) => (fr.ser[key].hi - fr.ser[key].lo) / fr.ser[key].L);
      const npx = frames.filter((fr) => fr.seg === seg && fr.ser?.[key]?.n).map((fr) => fr.ser[key].n);
      const mixes = frames.filter((fr) => fr.seg === seg && fr.ser?.[key]?.n).map((fr) => fr.ser[key].mix ?? 0);
      const mixDs = frames.filter((fr) => fr.seg === seg && fr.ser?.[key]?.n).map((fr) => fr.ser[key].mixD ?? 0);
      console.log(`  ${key.padEnd(6)} ${KIND(key).padEnd(7)} ${seg.padEnd(6)} ${String(rs.length).padStart(4)}  ` +
        `${String(pctl(npx, 50)).padStart(3)} ${f(pctl(spr, 50), 2).padStart(5)} ` +
        `${f(pctl(mixes, 50), 2).padStart(4)} ${f(pctl(mixDs, 90), 2).padStart(5)} ` +
        `${f(pctl(Ls, 50), 4).padStart(7)}  ${f(100 * pctl(rs, 50), 1).padStart(7)}% ` +
        `${f(100 * pctl(rs, 90), 1).padStart(6)}% ${f(100 * Math.max(...rs), 1).padStart(7)}%  ` +
        `${String(rs.filter((r) => r > STEP_PCT / 100).length).padStart(5)} ` +
        `${String(rs.filter((r) => r > BIG_PCT / 100).length).padStart(5)}  ` +
        `${Number.isFinite(tau) ? tau : "—"}`);
    }
  }
  const cls = {}; const all = [];
  for (const key of SERIES_KEYS) {
    for (const st of stepsOf(frames, key)) {
      if (st.r <= STEP_PCT / 100) continue;
      const c = classify(st);
      cls[c.cls] = (cls[c.cls] ?? 0) + 1;
      all.push({ ...st, ...c });
    }
  }
  const tot = all.length;
  console.log(`\n  attribution of the ${tot} steps over ${STEP_PCT} %:`);
  for (const [k, v] of Object.entries(cls).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(30)} ${String(v).padStart(5)}   ${f((100 * v) / Math.max(1, tot), 1)} %`);
  }
  // ⭐⭐⭐ §19 4.9 — THE FALLBACK CENSUS, A SECOND CUT OF THE SAME STEPS.
  //
  // The attribution above is a PRIORITY ORDER, so a step whose `cov` also moved
  // is scored as C even when the fallback switched under it. That answers "what
  // is the leading term"; it does not answer "how many of these steps have a
  // fallback switch in them at all", which is the question §AE.4 left open. So
  // the same population is cut a second time, on the raw co-occurrence.
  const withFb = all.filter((t) => t.ind.fb > 0.03);
  const fFlat = all.filter((t) => t.ind.fresh <= 0.03 && !t.ind.scroll
    && !t.ind.dom && t.ind.cov <= 0.03 && t.ind.claim <= 0.03 && t.ind.vis <= 0.05);
  const fFlatFb = fFlat.filter((t) => t.ind.fb > 0.03);
  console.log(`  fallback census: ${withFb.length} of ${tot} steps `
    + `(${f((100 * withFb.length) / Math.max(1, tot), 1)} %) carry a tail switch > 0.03; `
    + `of the ${fFlat.length} "every cascade weight flat" steps, ${fFlatFb.length} `
    + `(${f((100 * fFlatFb.length) / Math.max(1, fFlat.length), 1)} %) do.`);
  // The population statistic, over every recorded sample rather than the steps.
  let nS = 0; let inFb = 0; let fbSum = 0; let csMin = Infinity; let csBad = 0;
  for (const fr of frames) {
    for (const key of SERIES_KEYS) {
      const v = fr.ser?.[key];
      if (!(v?.n) || !v.d?.[FBROW]) continue;
      nS++; fbSum += v.d[FBROW][1];
      if (v.d[FBROW][1] > 0.001) inFb++;
      const cs = v.d[FBROW][2];
      csMin = Math.min(csMin, cs);
      if (cs < 0.99) csBad++;
    }
  }
  console.log(`  tail weight: mean ${f(fbSum / Math.max(1, nS), 4)} over ${nS} samples; `
    + `${f((100 * inFb) / Math.max(1, nS), 1)} % of samples carry any tail.  `
    + `conservation Σcontrib: min ${f(csMin, 4)}, ${csBad} samples `
    + `(${f((100 * csBad) / Math.max(1, nS), 1)} %) below 0.99.`);
  all.sort((a, b) => b.r - a.r);
  console.log(`\n  the three largest steps:`);
  for (const t of all.slice(0, 3)) {
    const A = t.a.ser[t.key]; const B = t.b.ser[t.key];
    console.log(`    ${t.key} (${KIND(t.key)}) frame ${t.b.i} seg ${t.b.seg} s=${f(t.b.s, 1)} m  ` +
      `L ${f(A.L, 4)} → ${f(B.L, 4)} = ${f(100 * t.r, 1)} %   →  ${t.cls}`);
    console.log(`        Δfresh ${f(t.ind.fresh, 3)}  Δcov ${f(t.ind.cov, 3)}  Δclaim ${f(t.ind.claim, 3)}  ` +
      `Δvis ${f(t.ind.vis, 3)}  domFlip ${t.ind.dom}  scroll ${t.ind.scroll}  ` +
      `preMove/postMove ${f(t.ind.pre / Math.max(1e-6, t.r), 2)}  spread ${f(t.ind.spread, 2)}`);
    console.log(`        pixels ${A.n} (lo ${f(A.lo, 4)} hi ${f(A.hi, 4)} sd ${f(A.sd, 4)})  ->  ` +
      `${B.n} (lo ${f(B.lo, 4)} hi ${f(B.hi, 4)} sd ${f(B.sd, 4)})`);
    console.log(`        cov,fresh,claim,vis per cascade  ${A.d?.map((v) => `[${v.join(",")}]`).join(" ")}`);
    console.log(`                                      →  ${B.d?.map((v) => `[${v.join(",")}]`).join(" ")}`);
    console.log(`        runner [${t.b.rp}] cam [${t.b.cp}]  dynVox ${t.b.dynVox} movers ${t.b.movers}` +
      `  probesFresh ${t.b.gs?.probesFresh ?? "?"}  alphaForced ${t.b.gs?.alphaForced ?? "?"}` +
      `  wpCoarseMoved ${t.b.gs?.wpCoarseMoved ?? "?"}`);
  }
};
for (const arm of ARMS) armReport(arm);
console.log(`
  lit floor ${LIT_FLOOR.toExponential(2)} (a tenth of the frame's median irradiance): ` +
  `${KEPT} step pairs scored, ${DROPPED} dropped as too dark to have a relative step ` +
  `(${f((100 * DROPPED) / Math.max(1, DROPPED + KEPT), 1)} %).`);

// ── the cross-arm controls ──────────────────────────────────────────────────
//
// ⭐⭐ THE CONTROLS ARE SUBTRACTIONS, NOT ARGUMENTS. `run` and `nodyn` differ
// only by the dynamic layer; `run` and `static` differ only by the camera. A
// class that survives both subtractions is in the field itself.
const segStep = (arm, key, seg) => {
  const st = stepsOf(results[arm] ?? [], key, seg).map((x) => x.r);
  return st.length ? { p50: pctl(st, 50), p90: pctl(st, 90), big: st.filter((r) => r > STEP_PCT / 100).length, n: st.length } : null;
};
const control = (a, b, title) => {
  if (!results[a] || !results[b]) return;
  console.log(`\n══ ${title} ═══════════════════════════════`);
  console.log(`  series   ${a} p90   ${b} p90    ${a} >${STEP_PCT}%   ${b} >${STEP_PCT}%`);
  for (const key of SERIES_KEYS) {
    for (const seg of ["park", "out"]) {
      const x = segStep(a, key, seg); const y = segStep(b, key, seg);
      if (!x || !y) continue;
      console.log(`  ${key.padEnd(5)} ${seg.padEnd(5)} ${f(100 * x.p90, 1).padStart(7)}% ` +
        `${f(100 * y.p90, 1).padStart(9)}%  ${String(x.big).padStart(8)}  ${String(y.big).padStart(9)}`);
    }
  }
};
control("run", "nodyn", "the B control (run − nodyn: the runner's own dynamic voxels)");
control("run", "static", "the E control (run − static: the camera follow itself)");
control("run", "faceoff", "the FACE-GATE lever (run − faceoff: wpFaceOn = 0)");
control("run", "visoff", "the CHEBYSHEV lever (run − visoff: wpVisOn = 0)");

// ⭐ THE POSITION-REPEATABILITY TEST. Out and back cross the same ground; a big
// step at the same `s` on both legs is position-keyed (A/C), one that appears on
// only one leg is time-keyed (D/E).
for (const arm of ARMS) {
  const frames = results[arm];
  if (!frames?.length) continue;
  console.log(`\n══ position repeatability, arm "${arm}" (out vs back at the same s) ══`);
  for (const key of SERIES_KEYS) {
    const bins = new Map();
    for (const seg of ["out", "back"]) {
      for (const st of stepsOf(frames, key, seg)) {
        if (st.r <= STEP_PCT / 100) continue;
        const b = Math.round(st.b.s * 2) / 2;
        const e = bins.get(b) ?? { out: 0, back: 0 };
        e[seg]++;
        bins.set(b, e);
      }
    }
    if (!bins.size) continue;
    let both = 0; let only = 0;
    for (const e of bins.values()) { if (e.out && e.back) both++; else only++; }
    console.log(`  ${key.padEnd(6)} ${String(bins.size).padStart(4)} half-metre bins with a big step: ` +
      `${both} on BOTH legs (position-keyed), ${only} on one (time-keyed)`);
  }
}

// ⭐⭐ THE SPREAD TABLE — the field's own spatial discontinuity, per arm. A
// series whose OWN samples in ONE frame disagree by more than their mean is a
// series a moving camera will make flicker however stable it is in time.
console.log(`\n══ spatial spread (hi−lo)/mean WITHIN one frame's samples, p50 ════`);
{
  const arms = ARMS.filter((a) => results[a]?.length);
  console.log(`  series  seg    ${arms.map((a) => a.padStart(10)).join("")}`);
  for (const key of SERIES_KEYS) {
    for (const seg of ["park", "out"]) {
      const cells = arms.map((a) => {
        const xs = results[a].filter((fr) => fr.seg === seg && fr.ser?.[key]?.n > 1 && fr.ser[key].L > 1e-6)
          .map((fr) => (fr.ser[key].hi - fr.ser[key].lo) / fr.ser[key].L);
        return xs.length ? f(pctl(xs, 50), 2).padStart(10) : "         —";
      });
      if (cells.every((c) => c.trim() === "—")) continue;
      console.log(`  ${key.padEnd(6)} ${seg.padEnd(6)}${cells.join("")}`);
    }
  }
}

console.log(`\n══ what "smooth" has to mean numerically ════════════════════════════`);
console.log(`  At ${SPEED} m/s and ${FPS} fps the runner covers ${f(STEP_M * 100, 1)} cm per frame.`);
console.log(`  GATE 1  p99 step ≤ ${STEP_PCT} % of E frame-to-frame on EVERY series, and ZERO`);
console.log(`          steps over ${BIG_PCT} % — a mean cannot see a flicker.`);
console.log(`  GATE 2  p90 step ≤ 2 % per frame on the fixed ground and façade points.`);
console.log(`  GATE 3  autocorrelation time τ ≥ 30 frames (0.5 s) on every series.`);
console.log(`  GATE 4  the park segment's p90 ≤ 0.5 % — a field that churns while the`);
console.log(`          root is still cannot be fixed on the motion side.`);
console.log(`  GATE 5  ⭐ THE OWNERSHIP MOSAIC. \`mix\` is the share of one patch's pixels`);
console.log(`          answered by a cascade OTHER than the patch's modal one, \`mixD\` the`);
console.log(`          gap between the two groups' luminances. On ONE FLAT SURFACE the`);
console.log(`          answering cascade must not flip cell-to-cell: target mix ≤ 0.05,`);
console.log(`          and where a real blend boundary crosses a patch, mixD ≤ 0.10.`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    scene: SCENE, speed: SPEED, fps: FPS, stepM: STEP_M, leg: LEG,
    path, rig, world: installed.world, hasDiag: installed.hasDiag, results,
  }));
  console.log(`\n  frame records written to ${JSON_OUT}`);
}

await browser.close();
