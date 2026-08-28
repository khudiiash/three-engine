// GI2 PUDDLE PROBE — §19 Stage 4.4: WHY DO NEIGHBOURING PROBES ON ONE FLAT
// WALL DISAGREE?
//
// ══ THE REPORT (user screenshot 08-28 10:13, Bistro, `indirect` view) ════════
//
// The terrace wall behind the café chairs shows 30–60 px "puddles" — patches of
// irradiance that differ strongly between neighbouring 16 px probe tiles on ONE
// FLAT WALL, smeared through the upsample, pink. Irradiance on a flat lit wall
// is low-frequency; adjacent probes on it must agree to within a few per cent.
//
// ══ THE METHOD — [[gi-colour-probe-method]] ══════════════════════════════════
//
// A "puddle" is a SPATIAL statistic, and every instrument this chain had reads
// either a temporal one (`reprojBuf`, the flip census) or a crop mean — both of
// which are low-pass filters applied to the exact quantity under complaint. So
// this probe reads the probe grid itself and reports, for the largest flat LIT
// plane in the frame, the neighbour-ratio distribution
//
//     r = |E_i − E_j| / max(E_i, E_j)   over 4-adjacent probe pairs
//
// at every stage of the chain, in the order the chain computes them:
//
// ⚠ AND IN THE IMAGE IT IS A SECOND DIFFERENCE OVER A LADDER OF SEPARATIONS,
// NOT THIS. Two adjacent half-res pixels interpolate the SAME four probes, so
// their ratio measures the upsample and reads 0.19 % on a wall whose probes
// disagree by 4.2 %; and a FIRST difference at any lag cannot tell a puddle
// from the smooth falloff every lit wall has. See `imgCurv`.
//
//   RAW       `shRawIdx` — the probe's own SH2 projection of its 64 oct texels
//   FILTERED  the 5×5 probe-space bilateral, RECOMPUTED ON THE CPU out of the
//             same `probeMeta` weights `makeShFilter` uses
//   FINAL     `shIdx` — what `resolveHalf` actually reads
//   IMAGE     the irradiance texture itself, along the same wall
//
// ⭐⭐ AND THE SUBTRACTION IS THE WHOLE POINT. `gi2System` splices
// `emitterDirectPass` between `probeShFilter` and `resolveHalf`, so `shIdx` is
// `filter(raw) + emitterNEE` — which means `shIdx − cpuFilter(shRaw)` isolates
// the emitter term EXACTLY, with its binary shadow ray already applied, and no
// GPU edit is needed to ask whether it is the puddle. Two stages, one
// subtraction, no argument.
//
// The counterfactual arm is computed the same way: `cpuFilter(shIdx)` is what
// the wall would read if the 5×5 ran AFTER the emitter add instead of before.
//
// ══ AND THEN WHICH MECHANISM ═════════════════════════════════════════════════
//
// For the three worst adjacent pairs the probe dumps both probes' 64 oct texels
// — radiance, packed hit DISTANCE and sample count — and attributes the DC gap
// per texel. A gap carried by two or three texels with sub-metre hit distances
// is a NEAR-FIELD OCCLUDER quantized to a 0.25 m block; a gap spread thinly
// over twenty texels at long range is CACHE noise; a gap that survives the
// subtraction above is the emitter NEE.
//
// It also measures the two placement suspects directly:
//   ANCHOR OFFSET  how far each probe's world anchor is from the tile centre
//                  the resolve's bilinear weights ASSUME it sits at.
//   TILE PURITY    what share of a tile's own pixels lie on the plane its
//                  probe anchored to (a probe that anchored on a chair
//                  represents the wall pixels behind it).
//   FILTER TAPS    how many of the 25 taps survive the plane/normal weights on
//                  a flat wall — the "v0 tolerance collapses the filter" case.
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//
// Run:
//   node scripts/run-gi2-puddle-probe.mjs
//   POSE='x,y,z|x,y,z' OUT=/tmp/puddle-before.json node scripts/run-gi2-puddle-probe.mjs
//   REF=/tmp/puddle-before.json node scripts/run-gi2-puddle-probe.mjs
//
// Env: PROJECT · SCENE=Bistro · SETTLE=14 · FRAMES=240 · POSE · OUT · REF ·
//      FLAGS · HEADED=1
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { reportEmitterSeats } from "./lib/gi2EmitterWait.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 14);
const FRAMES = Number(process.env.FRAMES ?? 240);
const OUT = process.env.OUT ?? "";
const REF = process.env.REF ?? "";
const POSE_ENV = process.env.POSE ?? "";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const pct = (v, n = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(n)} %` : "—");

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
  if (/\[gi2\] (soup|first)|\[gi\] built/i.test(t)) console.log(`    ${t.slice(0, 200)}`);
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

console.log(`\n══ ${SCENE} — the puddles ════════════════════════════════════`);
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
// The user's frame: street level, one flat wall filling most of it, café
// furniture standing in front of it.
//
// ⭐⭐ AND IT IS FOUND IN THE GBUFFER, NOT BY NAME. The obvious derivation —
// find the chair meshes, stand back from the wall behind them — CANNOT RUN
// HERE: Bistro is ONE entity carrying a model component, its 1697 meshes never
// become ECS entities, and by the time GI is live the static merge has replaced
// them with proxies, so both `entity.list({nameContains})` and a scene-graph
// traverse for `Paris_Chair_01` return nothing. Measured, twice.
//
// So the pose is derived from the only description of the scene that is always
// there and always current: the frame itself. The camera sweeps eight yaws from
// the model's centre at eye height, and for each the gbuffer is asked which
// PLANE owns the most pixels — the same plane vote the measurement below uses,
// so the pose is chosen by the criterion the receipt is graded on rather than
// by a proxy for it. The winner's pixels give a point and a normal; the camera
// stands off that point along its normal at 4.5 m, which is what puts the
// terrace furniture between the two.
//
// ⚠ A PINNED POSE ALWAYS WINS, and `OUT`/`REF` carry it: the screen arm and the
// world arm must measure ONE wall or the comparison is between two places.
const refData = REF ? JSON.parse(readFileSync(REF, "utf8")) : null;
const sweepDump = async (maxDist) => page.evaluate(async ({ maxDist }) => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const { createGi2StageDump } = await import("/scripts/lib/gi2StageProbe.js");
  const dump = createGi2StageDump({
    renderer: eng.renderer, gi2, screen: globalThis.__giSys().state.screen, stride: 8,
  });
  const D = await dump.read();
  const V = 6;
  const at = (i, v, c) => D[(i * V + v) * 4 + c];
  const n = D.length / (V * 4);
  const cam = [eng.camera.position.x, eng.camera.position.y, eng.camera.position.z];
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const votes = new Map();
  let valid = 0;
  let frameE = 0;
  for (let i = 0; i < n; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    valid++;
    frameE += lum(at(i, 2, 0), at(i, 2, 1), at(i, 2, 2));
    const N = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
    if (Math.abs(N[1]) >= 0.5) continue;
    const P = [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)];
    const d = Math.hypot(P[0] - cam[0], P[1] - cam[1], P[2] - cam[2]);
    if (d > maxDist) continue;
    const off = N[0] * P[0] + N[1] * P[1] + N[2] * P[2];
    const key = `${Math.round(N[0] * 8)},${Math.round(N[2] * 8)},${Math.round(off / 0.25)}`;
    let e = votes.get(key);
    if (!e) votes.set(key, e = { c: 0, N: [0, 0, 0], P: [0, 0, 0], E: 0 });
    e.c++;
    e.E += lum(at(i, 2, 0), at(i, 2, 1), at(i, 2, 2));
    for (let a = 0; a < 3; a++) { e.N[a] += N[a]; e.P[a] += P[a]; }
  }
  const best = [...votes.values()].sort((a, b) => b.c - a.c)[0];
  if (!best) return { share: 0, total: n, valid };
  const l = Math.hypot(best.N[0], best.N[1], best.N[2]) || 1;
  return {
    share: best.c / Math.max(1, n),
    validShare: valid / Math.max(1, n),
    // ⚠ AND HOW LIT IT IS. The first sweep maximized SHARE alone and parked the
    // camera 4.5 m from a courtyard wall whose irradiance was 0.0005 — a frame
    // where every ratio is a division of one rounding error by another. A wall
    // the complaint is about is a wall you can SEE, so the score is share
    // subject to the plane carrying at least half the frame's mean irradiance.
    planeE: best.E / Math.max(1, best.c),
    frameE: frameE / Math.max(1, valid),
    N: best.N.map((v) => v / l),
    P: best.P.map((v) => v / best.c),
    total: n, valid,
  };
}, { maxDist });

async function terracePose() {
  if (POSE_ENV) {
    const [e, a] = POSE_ENV.split("|").map((s) => s.split(",").map(Number));
    return { position: e, target: a, source: "POSE env" };
  }
  if (refData?.pose) return { ...refData.pose, source: `pinned by ${REF}` };
  // ⭐⭐ THE SEARCH IS ANCHORED ON THE EMITTERS, AND THAT IS THE COMPLAINT'S OWN
  // GEOMETRY. The model's bounding box is 115 m across — it includes the Paris
  // AERIAL backdrop cards — so its centre is not a place, and a sweep from
  // there found a 15°-tilted plane owning 3 % of the frame and pronounced the
  // wall healthy. The user's frame is a CAFÉ FRONT: a lit sign, an awning, a
  // wall, chairs. The four admitted emitter slots ARE the café fronts, and
  // `state.emitterSlots` gives their world centres for free.
  const slots = await page.evaluate(() => (globalThis.__giSys()?.state?.emitterSlots ?? [])
    .filter((s) => s.radius.value > 1e-5)
    .map((s) => ({
      c: [s.center.value.x, s.center.value.y, s.center.value.z],
      reff: s.reff.value,
      rgb: [s.color.value.r, s.color.value.g, s.color.value.b],
    })));
  if (!slots.length) { console.log("    no active emitter slots"); return null; }
  console.log(`    ${slots.length} emitter slots: ` +
    slots.map((s) => `[${s.c.map((v) => v.toFixed(1))}]`).join(" "));
  const groundAt = async (x, z, from) => page.evaluate(async ({ o }) => {
    const eng = globalThis.__giEngineForProbe;
    const gi2 = globalThis.__gi2();
    const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
    const shoot = createGi2RayShooter(gi2, eng.renderer);
    const rays = [{ o, d: [0, -1, 0], tMax: 40 }];
    await shoot(rays);
    const r = (await shoot(rays))[0];
    return r.hit ? o[1] - r.t : null;
  }, { o: [x, from, z] });
  let best = null;
  for (let si = 0; si < slots.length; si++) {
    const s = slots[si];
    const g = await groundAt(s.c[0], s.c[2], s.c[1] - 0.2);
    if (g === null) { console.log(`    slot ${si}: no ground below it`); continue; }
    const eye = g + 1.6;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const pos = [s.c[0] + Math.cos(a) * 5.5, eye, s.c[2] + Math.sin(a) * 5.5];
      await call("viewport.setCamera", { position: pos, target: [s.c[0], eye, s.c[2]] });
      await settleFrames(4, 20000);
      const d = await sweepDump(18);
      // Lit enough to be the subject of a complaint, and not the ONLY thing in
      // the frame — the user's shot has furniture in front of the wall, and a
      // 100 % wall means the camera is pressed against it.
      const lit = d.planeE >= 0.5 * d.frameE;
      d.score = (lit && d.share >= 0.35) ? Math.min(d.share, 0.8) : 0;
      if (d.N && (!best || d.score > best.score)) best = { ...d, pos, eye, si, a };
      if (d.share > 0.3) {
        console.log(`    slot ${si} yaw ${(a * 180 / Math.PI).toFixed(0).padStart(3)}°  ` +
          `wall ${(d.share * 100).toFixed(1)} %  E ${d.planeE.toFixed(4)} ` +
          `(frame ${d.frameE.toFixed(4)})  score ${d.score.toFixed(2)}`);
      }
    }
  }
  if (!best?.N || !(best.score > 0)) { console.log("    no lit wall found"); return null; }
  console.log(`    best: slot ${best.si}, wall ${(best.share * 100).toFixed(1)} % of the frame, ` +
    `E ${best.planeE.toFixed(4)}`);
  // The normal must point at the camera side of the wall, or the stand-off puts
  // the camera inside the building.
  const toCam = [best.pos[0] - best.P[0], best.eye - best.P[1], best.pos[2] - best.P[2]];
  const sgn = (best.N[0] * toCam[0] + best.N[1] * toCam[1] + best.N[2] * toCam[2]) >= 0 ? 1 : -1;
  const N = best.N.map((v) => v * sgn);
  const back = 6.0;
  const W = [best.P[0], best.eye, best.P[2]];
  return {
    position: [W[0] + N[0] * back, best.eye, W[2] + N[2] * back],
    target: W,
    source: `emitter sweep (slot ${best.si}, ${(best.share * 100).toFixed(1)} % wall)`,
  };
}
const pose = await terracePose();
if (!pose) { console.log("FATAL: no terrace pose"); await browser.close(); process.exit(1); }
console.log(`  pose (${pose.source}): eye [${pose.position.map((v) => v.toFixed(2))}] ` +
  `→ [${pose.target.map((v) => v.toFixed(2))}]`);
await call("viewport.setCamera", { position: pose.position, target: pose.target });
await settleFrames(FRAMES);


// ── THE READING ─────────────────────────────────────────────────────────────
//
// ⚠ ALL OF IT IN THE PAGE. `probeOct` alone is 13 MB at 1650×970 and `probeSh`
// is 1.8 MB; shipping those across the CDP bridge to analyse them in node would
// make the instrument the run's wall time. The page returns the STATISTICS and
// the three worst pairs' oct maps, which are bounded.
const R = await page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const gather = gi2?.gather;
  if (!gather) return { error: "no gather" };
  const renderer = eng.renderer;
  const world = gather.world;
  const isWorld = !!gather.worldProbes;
  const v0 = gi2.win.voxel0;
  const f32 = async (attr) => new Float32Array(await renderer.getArrayBufferAsync(attr));
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const quant = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN);
  const COS5 = Math.cos(5 * Math.PI / 180);
  // ⚠ THE FLOOR IS A FRACTION OF THE WALL, NOT A METRIC CONSTANT. Set below,
  // once the wall's own mean irradiance is known: a ratio whose denominator is
  // 0.0005 is a division of one rounding error by another, and the first cut of
  // this receipt reported 75 % neighbour disagreement on a courtyard wall that
  // was, in every stage, black. [[gi-colour-probe-method]] — constants in world
  // units get retracted; prefer a fraction of what the scene measures.
  let FLOOR = 1e-4;

  /** `shEval` from `gatherProbes.js`, coefficient for coefficient. */
  const shEval = (L, n) => {
    const c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      out[k] = Math.max(0,
        L[8][k] * c1 * (n[0] * n[0] - n[1] * n[1])
        + L[6][k] * c3 * n[2] * n[2]
        + L[0][k] * c4
        - L[6][k] * c5
        + L[4][k] * 2 * c1 * n[0] * n[1]
        + L[7][k] * 2 * c1 * n[0] * n[2]
        + L[5][k] * 2 * c1 * n[1] * n[2]
        + L[3][k] * 2 * c2 * n[0]
        + L[1][k] * 2 * c2 * n[1]
        + L[2][k] * 2 * c2 * n[2]);
    }
    return out;
  };

  // ══ 1. THE IMAGE, AND THE WALL IT NAMES ═══════════════════════════════════
  //
  // ⭐ THE WALL IS FOUND IN THE PIXELS, NOT IN THE PROBES, AND THAT IS WHAT
  // MAKES THE TWO PATHS COMPARABLE. A screen probe grid and a 0.5 m world
  // lattice are different populations; the gbuffer is the same gbuffer, so the
  // plane both are asked about is defined once, there.
  const { createGi2StageDump } = await import("/scripts/lib/gi2StageProbe.js");
  const dump = createGi2StageDump({
    renderer, gi2, screen: globalThis.__giSys().state.screen, stride: 2,
  });
  const D = await dump.read();
  const V = 6;
  const dw = dump.dumpW;
  const dh = dump.dumpH;
  const at = (i, v, c) => D[(i * V + v) * 4 + c];
  const NPX = dw * dh;
  const okPx = new Uint8Array(NPX);
  const Eb = new Float32Array(NPX);
  const Ea = new Float32Array(NPX);
  let validPx = 0;
  for (let i = 0; i < NPX; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    okPx[i] = 1;
    validPx++;
    Eb[i] = lum([at(i, 2, 0), at(i, 2, 1), at(i, 2, 2)]);
    Ea[i] = lum([at(i, 3, 0), at(i, 3, 1), at(i, 3, 2)]);
  }
  // The plane vote: normal quantized to a 1/8 grid, offset to half a level-0
  // cell. The winner is only a REPRESENTATIVE — the final membership test is
  // the 5° / 0.5·v0 tolerance over every pixel, so a plane split across two
  // buckets is recovered whole.
  const votes = new Map();
  for (let i = 0; i < NPX; i++) {
    if (!okPx[i]) continue;
    const n = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
    if (Math.abs(n[1]) >= 0.5) continue; // a WALL, not the pavement
    const p = [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)];
    const d = n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
    const key = `${Math.round(n[0] * 8)},${Math.round(n[1] * 8)},${Math.round(n[2] * 8)},`
      + `${Math.round(d / (0.5 * v0))}`;
    let e = votes.get(key);
    if (!e) votes.set(key, e = { c: 0, n: [0, 0, 0], d: 0 });
    e.c++;
    e.n[0] += n[0]; e.n[1] += n[1]; e.n[2] += n[2];
    e.d += d;
  }
  const top = [...votes.values()].sort((a, b) => b.c - a.c);
  if (!top.length) return { error: "no wall-like plane in the frame" };
  const wn = (() => {
    const e = top[0];
    const l = Math.hypot(e.n[0], e.n[1], e.n[2]);
    return [e.n[0] / l, e.n[1] / l, e.n[2] / l];
  })();
  const wd = top[0].d / top[0].c;
  const OFF = 0.5 * v0;
  const onPlane = (p, n) => {
    const cd = n[0] * wn[0] + n[1] * wn[1] + n[2] * wn[2];
    if (cd < COS5) return false;
    const od = wn[0] * p[0] + wn[1] * p[1] + wn[2] * p[2];
    return Math.abs(od - wd) <= OFF;
  };
  const onWall = new Uint8Array(NPX);
  let wallPx = 0;
  for (let i = 0; i < NPX; i++) {
    if (!okPx[i]) continue;
    if (!onPlane([at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)],
      [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)])) continue;
    onWall[i] = 1;
    wallPx++;
  }
  let wallMeanE = 0;
  for (let i = 0; i < NPX; i++) if (onWall[i]) wallMeanE += Ea[i];
  wallMeanE /= Math.max(1, wallPx);
  FLOOR = Math.max(1e-4, 0.05 * wallMeanE);
  // ⭐⭐ THE LAG IS THE WHOLE INSTRUMENT, AND A ONE-PIXEL LAG IS BLIND TO A
  // PUDDLE. Two ADJACENT half-res pixels interpolate the SAME four probes with
  // almost the same weights, so their ratio measures the upsample's smoothness
  // and nothing else — measured 0.19 % p50 on a wall whose probes disagreed by
  // 4.2 %, which is an instrument reporting its own filter. A "30-60 px patch"
  // is a statement about a LENGTH, so the receipt is a STRUCTURE FUNCTION:
  // |ΔE|/max against separation, from one pixel out past a probe tile. The tile
  // lag (T/2 half-res pixels) is the row the complaint is about.
  //
  // ⭐⭐ AND THE STATISTIC IS THE SECOND DIFFERENCE, NOT THE FIRST. A FIRST
  // difference cannot tell a PUDDLE from a GRADIENT: irradiance on a real wall
  // falls off smoothly away from the light, so |ΔE|/max grows linearly with the
  // lag whether the field is smooth or patchy, and the first cut of this
  // receipt duly reported 3 % → 26 % → 73 % across the lags on a wall and
  // called it evidence. `|E(−L) + E(+L) − 2·E(0)|` annihilates ANY linear
  // trend exactly, so what it leaves is the part of the field that is not
  // smooth — which is the complaint. A gradient reads ~0 at every lag; a field
  // that steps between probe tiles PEAKS at the tile lag, which is a shape, not
  // a number, and a shape cannot be argued with.
  const LAGS = [1, 2, 4, 8, 16, 32];
  const stat = (rs, lag) => {
    rs.sort((a, b) => a - b);
    return {
      lag, n: rs.length, p50: quant(rs, 0.5), p90: quant(rs, 0.9),
      max: rs.length ? rs[rs.length - 1] : NaN,
    };
  };
  const imgRatios = (buf, lag) => {
    const rs = [];
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const i = y * dw + x;
        if (!onWall[i]) continue;
        for (const j of [x + lag < dw ? i + lag : -1, y + lag < dh ? i + dw * lag : -1]) {
          if (j < 0 || !onWall[j]) continue;
          const m = Math.max(buf[i], buf[j]);
          if (m < FLOOR) continue;
          rs.push(Math.abs(buf[i] - buf[j]) / m);
        }
      }
    }
    return stat(rs, lag);
  };
  const imgCurv = (buf, lag) => {
    const rs = [];
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const i = y * dw + x;
        if (!onWall[i]) continue;
        const trip = [
          x >= lag && x + lag < dw ? [i - lag, i, i + lag] : null,
          y >= lag && y + lag < dh ? [i - dw * lag, i, i + dw * lag] : null,
        ];
        for (const t of trip) {
          if (!t || !onWall[t[0]] || !onWall[t[2]]) continue;
          const m = Math.max(buf[t[0]], buf[t[1]], buf[t[2]]);
          if (m < FLOOR) continue;
          rs.push(Math.abs(buf[t[0]] + buf[t[2]] - 2 * buf[t[1]]) / m);
        }
      }
    }
    return stat(rs, lag);
  };
  const structure = (buf) => LAGS.map((l) => imgRatios(buf, l));
  const curvature = (buf) => LAGS.map((l) => imgCurv(buf, l));
  const out = {
    path: isWorld ? "world" : "screen",
    cfg: {
      tier: gather.tier, v0, width: gi2.width, height: gi2.height,
      emitters: (globalThis.__giSys()?.state?.emitterSlots ?? [])
        .filter((s) => s.radius.value > 1e-5).length,
      world: world ? world.describe() : null,
      T: gather.T, O: gather.O, probeW: gather.probeW, probeH: gather.probeH,
      radius: gather.SH_R, octAlpha: gather.uniforms.octAlpha.value,
      accumAlpha: gather.uniforms.accumAlpha.value,
    },
    wall: {
      nrm: wn.map((v) => +v.toFixed(3)), d: +wd.toFixed(3),
      pxShare: wallPx / Math.max(1, validPx), wallPx, validPx,
    },
    image: {
      before: imgRatios(Eb, 1), after: imgRatios(Ea, 1),
      structBefore: structure(Eb), structAfter: structure(Ea),
      curvBefore: curvature(Eb), curvAfter: curvature(Ea),
      meanE: wallMeanE, floor: FLOOR,
      tileLag: Math.max(1, Math.round((gather.T ?? 16) / 2)),
    },
    health: { dumpAttempts: D.attempts },
  };

  // ══ 2a. THE SCREEN PROBE GRID ═════════════════════════════════════════════
  if (!isWorld) {
    const { probeW, probeH, probeCount, T, O } = gather;
    const OCT = O * O;
    const META_VEC = 3;
    const PACK_N = 262144;
    const PACK_D = 1024;
    const DIST_Q = 255;
    const RAY_MAX = 40;
    const cur = gather.uniforms.curBase.value;
    const meta = await f32(gather.buffers.probeMeta.value);
    const sh = await f32(gather.buffers.probeSh.value);
    // ⭐ THE INSTRUMENT'S OWN HEALTH. Three GPU round trips and the frame does
    // not stop between them. At rest the field is converged and a second read
    // of the same buffer is identical; the share that is not IS the error bar.
    const metaB = await f32(gather.buffers.probeMeta.value);
    const mAt = (half, probe, slot) => (half * probeCount * META_VEC + probe * META_VEC + slot) * 4;
    const shAt = (probe, c) => (probe * 9 + c) * 4;
    const shRawAt = (probe, c) => (probeCount * 9 + probe * 9 + c) * 4;

    const octDir = (idx, res) => {
      const u = idx % res;
      const v = Math.floor(idx / res);
      const fx = ((u + 0.5) / res) * 2 - 1;
      const fy = ((v + 0.5) / res) * 2 - 1;
      const nz = 1 - Math.abs(fx) - Math.abs(fy);
      const fold = Math.max(-nz, 0);
      const nx = fx - (fx >= 0 ? 1 : -1) * fold;
      const ny = fy - (fy >= 0 ? 1 : -1) * fold;
      const l = Math.hypot(nx, ny, nz);
      return [nx / l, ny / l, nz / l];
    };
    const octTab = (() => {
      const rows = [];
      let s = 0;
      for (let i = 0; i < OCT; i++) {
        const d = octDir(i, O);
        const w = (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2])) ** 3;
        rows.push({ d, w });
        s += w;
      }
      const k = (4 * Math.PI) / s;
      return rows.map((r) => ({ d: r.d, w: r.w * k }));
    })();

    const P = [];
    for (let i = 0; i < probeCount; i++) {
      const a = mAt(cur, i, 0);
      const b = mAt(cur, i, 1);
      const c = mAt(cur, i, 2);
      P.push({
        i, tx: i % probeW, ty: Math.floor(i / probeW),
        p: [meta[a], meta[a + 1], meta[a + 2]], valid: meta[a + 3],
        n: [meta[b], meta[b + 1], meta[b + 2]], depth: meta[b + 3],
        reprojFail: meta[c + 1], cls: meta[c + 2], ripe: meta[c + 3],
      });
    }
    let metaDrift = 0;
    for (let i = 0; i < probeCount; i++) {
      const a = mAt(cur, i, 0);
      if (Math.abs(meta[a] - metaB[a]) + Math.abs(meta[a + 1] - metaB[a + 1])
        + Math.abs(meta[a + 2] - metaB[a + 2]) > 1e-5) metaDrift++;
    }
    out.health.metaDrift = metaDrift;
    out.health.metaDriftPct = metaDrift / probeCount;

    const getSh = (base, i) => {
      const L = [];
      for (let c = 0; c < 9; c++) {
        const o = base(i, c);
        L.push([sh[o], sh[o + 1], sh[o + 2]]);
      }
      return L;
    };
    const shRaw = P.map((q) => getSh(shRawAt, q.i));
    const shFin = P.map((q) => getSh(shAt, q.i));

    // `makeShFilter(SH_R)`, on the CPU, weight for weight.
    const RADIUS = gather.SH_R ?? 2;
    const filterOf = (src) => {
      const outL = [];
      const taps = [];
      for (const q of P) {
        const acc = Array.from({ length: 9 }, () => [0, 0, 0]);
        let wsum = 0;
        let live = 0;
        for (let oy = -RADIUS; oy <= RADIUS; oy++) {
          for (let ox = -RADIUS; ox <= RADIUS; ox++) {
            const nx = q.tx + ox;
            const ny = q.ty + oy;
            const inB = nx >= 0 && ny >= 0 && nx < probeW && ny < probeH;
            const np = Math.min(probeH - 1, Math.max(0, ny)) * probeW
              + Math.min(probeW - 1, Math.max(0, nx));
            const na = P[np];
            const dp = q.n[0] * (na.p[0] - q.p[0]) + q.n[1] * (na.p[1] - q.p[1])
              + q.n[2] * (na.p[2] - q.p[2]);
            const wp = Math.exp(-Math.abs(dp) / v0);
            const nn = Math.max(0, q.n[0] * na.n[0] + q.n[1] * na.n[1] + q.n[2] * na.n[2]);
            const g = Math.exp(-(ox * ox + oy * oy) / 2);
            const w = (inB && na.valid > 0.5 && q.valid > 0.5) ? wp * nn ** 4 * g : 0;
            if (w > 1e-5) {
              live++;
              for (let c = 0; c < 9; c++) {
                acc[c][0] += src[np][c][0] * w;
                acc[c][1] += src[np][c][1] * w;
                acc[c][2] += src[np][c][2] * w;
              }
              wsum += w;
            }
          }
        }
        const inv = wsum > 1e-5 ? 1 / wsum : 0;
        outL.push(acc.map((a) => [a[0] * inv, a[1] * inv, a[2] * inv]));
        taps.push(live);
      }
      return { out: outL, taps };
    };
    const filt = filterOf(shRaw);
    const filtAfter = filterOf(shFin);
    const shEmit = P.map((q, i) => {
      const L = [];
      for (let c = 0; c < 9; c++) {
        L.push([
          shFin[i][c][0] - filt.out[i][c][0],
          shFin[i][c][1] - filt.out[i][c][1],
          shFin[i][c][2] - filt.out[i][c][2],
        ]);
      }
      return L;
    });
    for (let i = 0; i < probeCount; i++) {
      const q = P[i];
      q.Eraw = shEval(shRaw[i], q.n);
      q.Efil = shEval(filt.out[i], q.n);
      q.Efin = shEval(shFin[i], q.n);
      q.Eaft = shEval(filtAfter.out[i], q.n);
      q.Eemi = shEval(shEmit[i], q.n);
      q.taps = filt.taps[i];
      q.d = q.n[0] * q.p[0] + q.n[1] * q.p[1] + q.n[2] * q.p[2];
    }

    const wallSet = new Set();
    for (const q of P) if (q.valid > 0.5 && onPlane(q.p, q.n)) wallSet.add(q.i);
    const members = [...wallSet];
    const ratios = (pick) => {
      const rs = [];
      for (const i of members) {
        const q = P[i];
        for (const j of [q.tx < probeW - 1 ? i + 1 : -1, q.ty < probeH - 1 ? i + probeW : -1]) {
          if (j < 0 || !wallSet.has(j)) continue;
          const a = lum(pick(P[i]));
          const b = lum(pick(P[j]));
          const m = Math.max(a, b);
          if (m < FLOOR) continue;
          rs.push(Math.abs(a - b) / m);
        }
      }
      rs.sort((x, y) => x - y);
      return {
        n: rs.length, p50: quant(rs, 0.5), p90: quant(rs, 0.9),
        max: rs.length ? rs[rs.length - 1] : NaN,
      };
    };
    // The same second difference as the image's, in probe space: three probes
    // in a row on one plane, so a smooth falloff across the wall cancels and
    // what is left is the probe-to-probe step.
    const curv = (pick) => {
      const rs = [];
      for (const i of members) {
        const q = P[i];
        const trip = [
          q.tx > 0 && q.tx < probeW - 1 ? [i - 1, i, i + 1] : null,
          q.ty > 0 && q.ty < probeH - 1 ? [i - probeW, i, i + probeW] : null,
        ];
        for (const t of trip) {
          if (!t || !wallSet.has(t[0]) || !wallSet.has(t[2])) continue;
          const a = lum(pick(P[t[0]]));
          const b = lum(pick(P[t[1]]));
          const c = lum(pick(P[t[2]]));
          const m = Math.max(a, b, c);
          if (m < FLOOR) continue;
          rs.push(Math.abs(a + c - 2 * b) / m);
        }
      }
      rs.sort((x, y) => x - y);
      return {
        n: rs.length, p50: quant(rs, 0.5), p90: quant(rs, 0.9),
        max: rs.length ? rs[rs.length - 1] : NaN,
      };
    };
    out.probes = { n: members.length };
    out.stages = {
      raw: ratios((q) => q.Eraw),
      filtered: ratios((q) => q.Efil),
      final: ratios((q) => q.Efin),
      emitterOnly: ratios((q) => q.Eemi),
      filterAfterNee: ratios((q) => q.Eaft),
    };
    out.curv = {
      raw: curv((q) => q.Eraw),
      filtered: curv((q) => q.Efil),
      final: curv((q) => q.Efin),
      filterAfterNee: curv((q) => q.Eaft),
    };

    const shares = [];
    const tapsW = [];
    // ⚠ THE ANCHOR OFFSET IS MEASURED IN METRES OFF THE GBUFFER, NOT PROJECTED.
    // Projecting the anchor through `u.viewProj` read 528 px of offset in a
    // 16 px tile — the uniform is not the matrix this readback's frame was
    // drawn with. The gbuffer at the tile's OWN centre pixel is the same
    // surface description the placement kernel sampled, so the distance between
    // it and the probe's anchor is what the resolve's bilinear is wrong by, in
    // the units the plane weight uses. (The dump is stride 2, so the tile
    // centre `(tx·T + T/2, ty·T + T/2)` is dump texel `(tx·T/2 + T/4, …)`.)
    const anchorOff = [];
    for (const i of members) {
      const q = P[i];
      const t = lum(q.Efin);
      if (t > FLOOR) shares.push(lum(q.Eemi) / t);
      tapsW.push(q.taps);
      const cx = Math.min(dw - 1, Math.floor(q.tx * (T / 2) + T / 4));
      const cy = Math.min(dh - 1, Math.floor(q.ty * (T / 2) + T / 4));
      const ci = cy * dw + cx;
      if (!okPx[ci]) continue;
      anchorOff.push(Math.hypot(
        at(ci, 0, 0) - q.p[0], at(ci, 0, 1) - q.p[1], at(ci, 0, 2) - q.p[2]));
    }
    shares.sort((a, b) => a - b);
    tapsW.sort((a, b) => a - b);
    anchorOff.sort((a, b) => a - b);
    out.emitShare = { p50: quant(shares, 0.5), p90: quant(shares, 0.9), n: shares.length };
    out.taps = { p05: quant(tapsW, 0.05), p50: quant(tapsW, 0.5), min: tapsW[0] ?? NaN };
    out.anchor = {
      p50: quant(anchorOff, 0.5), p90: quant(anchorOff, 0.9),
      max: anchorOff[anchorOff.length - 1] ?? NaN, tile: T, n: anchorOff.length,
    };

    // ══ THE ORIGIN CENSUS — see `gi2OriginProbe.js` ═════════════════════════
    //
    // `windowTrace` biases the origin half a level-0 cell along the normal and
    // then ESCAPES it a WHOLE CELL at a time while its voxel reads occupied. So
    // a probe's real trace origin is `p + (0.5 + k)·v₀·n`, and `k` is decided by
    // the conservative voxelization's LOCAL thickness. Two probes on one flat
    // wall with different `k` trace all 64 rays from origins a quarter-metre
    // apart — which is not parallax, it is a different vantage point.
    //
    // `k` is measured, not inferred: a zero-normal trace takes neither the bias
    // nor the escape, so firing outward along the normal from `p + s·n` and
    // asking how far it gets says whether that point is inside the occupied set.
    {
      const { createGi2OriginProbe } = await import("/scripts/lib/gi2OriginProbe.js");
      const shoot = createGi2OriginProbe(gi2, renderer);
      const STEPS = [0.5, 1.5, 2.5]; // the cells the escape tests, in v0
      const cap = Math.floor(4096 / STEPS.length);
      const sample = members.length <= cap
        ? members
        : members.filter((_, i) => i % Math.ceil(members.length / cap) === 0).slice(0, cap);
      const rays = [];
      for (const i of sample) {
        const q = P[i];
        for (const s of STEPS) {
          rays.push({
            o: [q.p[0] + q.n[0] * s * v0, q.p[1] + q.n[1] * s * v0, q.p[2] + q.n[2] * s * v0],
            d: q.n, tMax: 2.0,
          });
        }
      }
      await shoot(rays);
      const res = await shoot(rays);
      // "Inside the occupied set" = the outward ray leaves through the current
      // voxel's own far face, i.e. within a cell diagonal.
      const kOf = new Map();
      for (let a = 0; a < sample.length; a++) {
        let k = 0;
        for (let s = 0; s < STEPS.length; s++) {
          const r = res[a * STEPS.length + s];
          if (r.hit && r.t < v0 * 1.75) k = s + 1; else break;
        }
        kOf.set(sample[a], k);
      }
      const hist = [0, 0, 0, 0];
      for (const k of kOf.values()) hist[k]++;
      // ⭐ THE ATTRIBUTION. Split the SAME adjacent-pair population by whether
      // the two probes escaped the same number of cells. If the split does not
      // separate the ratios, the origin is not the source and this line says so.
      const same = [];
      const diff = [];
      for (const i of members) {
        const q = P[i];
        if (!kOf.has(i)) continue;
        for (const j of [q.tx < probeW - 1 ? i + 1 : -1, q.ty < probeH - 1 ? i + probeW : -1]) {
          if (j < 0 || !wallSet.has(j) || !kOf.has(j)) continue;
          const a = lum(P[i].Eraw);
          const b = lum(P[j].Eraw);
          const m = Math.max(a, b);
          if (m < FLOOR) continue;
          (kOf.get(i) === kOf.get(j) ? same : diff).push(Math.abs(a - b) / m);
        }
      }
      same.sort((a, b) => a - b);
      diff.sort((a, b) => a - b);
      out.origin = {
        sampled: sample.length, hist,
        same: { n: same.length, p50: quant(same, 0.5), p90: quant(same, 0.9) },
        diff: { n: diff.length, p50: quant(diff, 0.5), p90: quant(diff, 0.9) },
      };
    }

    // TILE PURITY — does a probe's plane represent its own tile's pixels?
    const tilePure = [];
    {
      const cnt = new Int32Array(probeCount);
      const same = new Int32Array(probeCount);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          const i = y * dw + x;
          if (!okPx[i]) continue;
          const tx = Math.min(probeW - 1, Math.floor((x * 2) / T));
          const ty = Math.min(probeH - 1, Math.floor((y * 2) / T));
          const pi = ty * probeW + tx;
          const q = P[pi];
          if (!(q.valid > 0.5)) continue;
          cnt[pi]++;
          const N = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
          const p = [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)];
          const cd = N[0] * q.n[0] + N[1] * q.n[1] + N[2] * q.n[2];
          const od = q.n[0] * p[0] + q.n[1] * p[1] + q.n[2] * p[2];
          if (cd >= COS5 && Math.abs(od - q.d) <= OFF) same[pi]++;
        }
      }
      for (const i of members) if (cnt[i] >= 4) tilePure.push(same[i] / cnt[i]);
      tilePure.sort((a, b) => a - b);
    }
    out.tilePurity = { p05: quant(tilePure, 0.05), p50: quant(tilePure, 0.5), n: tilePure.length };

    // THE THREE WORST PAIRS, TEXEL BY TEXEL.
    const pairs = [];
    for (const i of members) {
      const q = P[i];
      for (const j of [q.tx < probeW - 1 ? i + 1 : -1, q.ty < probeH - 1 ? i + probeW : -1]) {
        if (j < 0 || !wallSet.has(j)) continue;
        const a = lum(P[i].Efin);
        const b = lum(P[j].Efin);
        const m = Math.max(a, b);
        if (m < FLOOR) continue;
        pairs.push({ i, j, r: Math.abs(a - b) / m });
      }
    }
    pairs.sort((x, y) => y.r - x.r);
    const worst = pairs.slice(0, 3);
    const oct = worst.length ? await f32(gather.buffers.probeOct.value) : null;
    const octOf = (probe) => {
      const rows = [];
      for (let t = 0; t < OCT; t++) {
        const o = ((cur * probeCount + probe) * OCT + t) * 4;
        const w = Math.max(0, oct[o + 3]);
        const n = Math.floor(w / PACK_N);
        const dq = Math.floor((w - n * PACK_N) / PACK_D);
        rows.push({
          t, L: [oct[o], oct[o + 1], oct[o + 2]], n,
          dist: (dq * RAY_MAX) / DIST_Q, d: octTab[t].d, w: octTab[t].w,
        });
      }
      return rows;
    };
    out.worst = worst.map((pr) => {
      const A = P[pr.i];
      const B = P[pr.j];
      const ra = octOf(pr.i);
      const rb = octOf(pr.j);
      const contrib = (rows, nrm) => rows.map((r) => {
        const c = Math.max(0, r.d[0] * nrm[0] + r.d[1] * nrm[1] + r.d[2] * nrm[2]);
        return lum(r.L) * c * r.w;
      });
      const ca = contrib(ra, A.n);
      const cb = contrib(rb, B.n);
      const delta = ca.map((v, k) => v - cb[k]);
      const order = delta.map((v, k) => k).sort((x, y) => Math.abs(delta[y]) - Math.abs(delta[x]));
      const total = delta.reduce((s, v) => s + Math.abs(v), 0);
      let near = 0;
      let spread = 0;
      for (let k = 0; k < OCT; k++) {
        if (Math.min(ra[k].dist, rb[k].dist) < v0 * 4) near += Math.abs(delta[k]);
        if (Math.abs(delta[k]) > 0.02 * total) spread++;
      }
      return {
        i: pr.i, j: pr.j, r: +pr.r.toFixed(4),
        Ea: +lum(A.Efin).toFixed(5), Eb: +lum(B.Efin).toFixed(5),
        rawA: +lum(A.Eraw).toFixed(5), rawB: +lum(B.Eraw).toFixed(5),
        filA: +lum(A.Efil).toFixed(5), filB: +lum(B.Efil).toFixed(5),
        emiA: +lum(A.Eemi).toFixed(5), emiB: +lum(B.Eemi).toFixed(5),
        tapsA: A.taps, tapsB: B.taps,
        dist: +Math.hypot(A.p[0] - B.p[0], A.p[1] - B.p[1], A.p[2] - B.p[2]).toFixed(3),
        nearShare: +(near / Math.max(1e-9, total)).toFixed(3), spreadTexels: spread,
        top: order.slice(0, 6).map((k) => ({
          t: k, dl: +delta[k].toFixed(5),
          share: +(Math.abs(delta[k]) / Math.max(1e-9, total)).toFixed(3),
          La: +lum(ra[k].L).toFixed(4), Lb: +lum(rb[k].L).toFixed(4),
          da: +ra[k].dist.toFixed(2), db: +rb[k].dist.toFixed(2),
          na: ra[k].n, nb: rb[k].n, dir: ra[k].d.map((v) => +v.toFixed(2)),
        })),
      };
    });
    return out;
  }

  // ══ 2b. THE WORLD LATTICE ═════════════════════════════════════════════════
  //
  // The same question, asked of the population the world path actually
  // interpolates: cascade-0 cells standing on the wall, 6-adjacent in LATTICE
  // space, each evaluated at the WALL's normal — which is the receiver every
  // wall pixel presents to `shEval`.
  const wInfo = await f32(world.buffers.wpInfo.value);
  const INFO_VEC = 12;
  const CELLS = world.cellCount;
  const NC = world.cascades;
  const cascOut = [];
  for (let c = 0; c < NC; c++) {
    const sp = world.spacings[c];
    const base = c * CELLS;
    const byCell = new Map();
    const rows = [];
    for (let k = 0; k < CELLS; k++) {
      const o = (base + k) * INFO_VEC * 4;
      const state = wInfo[o + 3];
      if (!(state > 0.5)) continue;
      const p = [wInfo[o], wInfo[o + 1], wInfo[o + 2]];
      const od = wn[0] * p[0] + wn[1] * p[1] + wn[2] * p[2];
      // Within one spacing of the wall plane is "on the wall" for a lattice
      // that samples it: the probes a wall pixel interpolates are the eight
      // around it, which straddle the surface by construction.
      if (Math.abs(od - wd) > sp) continue;
      const L = [];
      for (let s = 0; s < 9; s++) {
        const q = o + (3 + s) * 4;
        L.push([wInfo[q], wInfo[q + 1], wInfo[q + 2]]);
      }
      const cc = [wInfo[o + 8], wInfo[o + 9], wInfo[o + 10]];
      const ready = wInfo[o + 11];
      const row = {
        k, E: lum(shEval(L, wn)), cc, ready, state,
        faced: state > 1.5 ? 1 : 0,
      };
      rows.push(row);
      byCell.set(`${cc[0]}|${cc[1]}|${cc[2]}`, row);
    }
    const rs = [];
    for (const r of rows) {
      for (const ax of [0, 1, 2]) {
        const key = `${r.cc[0] + (ax === 0 ? 1 : 0)}|${r.cc[1] + (ax === 1 ? 1 : 0)}|`
          + `${r.cc[2] + (ax === 2 ? 1 : 0)}`;
        const o = byCell.get(key);
        if (!o) continue;
        const m = Math.max(r.E, o.E);
        if (m < FLOOR) continue;
        rs.push(Math.abs(r.E - o.E) / m);
      }
    }
    rs.sort((a, b) => a - b);
    const rd = rows.map((r) => r.ready).sort((a, b) => a - b);
    cascOut.push({
      c, spacing: sp, cells: rows.length,
      faced: rows.filter((r) => r.faced).length,
      readyP50: quant(rd, 0.5), notReady: rows.filter((r) => r.ready < 0.75).length,
      ratio: {
        n: rs.length, p50: quant(rs, 0.5), p90: quant(rs, 0.9),
        max: rs.length ? rs[rs.length - 1] : NaN,
      },
    });
  }
  out.cascades = cascOut;
  out.stages = { final: cascOut[0]?.ratio ?? { n: 0, p50: NaN, p90: NaN, max: NaN } };
  return out;
});

if (R.error) {
  console.log(`\n  FATAL: ${R.error}`);
  await browser.close();
  process.exit(1);
}

const row = (name, s) => `    ${name.padEnd(18)} p50 ${f(s.p50 * 100, 2).padStart(7)} %   ` +
  `p90 ${f(s.p90 * 100, 2).padStart(7)} %   max ${f(s.max * 100, 1).padStart(7)} %   (n ${s.n})`;

console.log(`\n  PATH: ${R.path.toUpperCase()} probes`);
console.log(`  config: tier ${R.cfg.tier}  v0 ${f(R.cfg.v0, 3)} m  emitters ${R.cfg.emitters}  ` +
  (R.path === "screen"
    ? `tile ${R.cfg.T}  oct ${R.cfg.O}²  grid ${R.cfg.probeW}×${R.cfg.probeH}  ` +
      `shRadius ${R.cfg.radius}  octAlpha ${R.cfg.octAlpha}`
    : `cascades ${R.cfg.world.cascades}  spacing ${R.cfg.world.spacings.join("/")} m  ` +
      `extent ${R.cfg.world.extents.map((v) => v.toFixed(0)).join("/")} m`)
  + `  accumAlpha ${R.cfg.accumAlpha}`);
if (R.health.metaDriftPct !== undefined) {
  console.log(`  health: meta drift between two reads ${pct(R.health.metaDriftPct)} of probes  ` +
    `(a converged field reads ~0)   dump attempts ${R.health.dumpAttempts}`);
}
console.log(`  THE WALL: n [${R.wall.nrm}] d ${f(R.wall.d, 2)} — ` +
  `${pct(R.wall.pxShare)} of the frame's ${R.wall.validPx} valid pixels ` +
  `${R.wall.pxShare >= 0.4 ? "(≥ 40 %, the pose holds)" : "(< 40 %)"}`);

console.log(`\n  ── the same wall in the IMAGE (mean E ${f(R.image.meanE, 4)}, ` +
  `ratio floor ${f(R.image.floor, 5)}) ─────`);
console.log(`     SECOND difference |E(−L)+E(+L)−2E(0)|/max — a linear gradient reads 0,`);
console.log(`     a field that steps between probe tiles PEAKS at the tile lag ` +
  `(${R.image.tileLag} half-res px):`);
for (const s of R.image.curvAfter) {
  console.log(row(`curv lag ${String(s.lag).padStart(2)}` +
    (s.lag === R.image.tileLag ? " ←tile" : ""), s));
}
console.log(`     first difference |ΔE|/max, for reference (a gradient grows with L):`);
for (const s of R.image.structAfter) {
  console.log(row(`lag ${String(s.lag).padStart(2)} px` +
    (s.lag === R.image.tileLag ? " ←tile" : ""), s));
}

if (R.path === "screen") {
  console.log(`\n  ── NEIGHBOUR RATIO |Ei−Ej|/max on 4-adjacent WALL probes (${R.probes.n}) ──`);
  console.log(row("RAW (shRawIdx)", R.stages.raw));
  console.log(row("FILTERED 5×5", R.stages.filtered));
  console.log(row("FINAL (shIdx)", R.stages.final));
  console.log(row("· emitter term", R.stages.emitterOnly));
  console.log(row("counterfactual", R.stages.filterAfterNee) + "   ← 5×5 AFTER the NEE add");
  console.log(`    (same probes, SECOND difference — the gradient removed)`);
  console.log(row("  curv RAW", R.curv.raw));
  console.log(row("  curv FILTERED", R.curv.filtered));
  console.log(row("  curv FINAL", R.curv.final));
  console.log(`\n  ── the placement suspects ──────────────────────────────────────────`);
  console.log(`    emitter NEE share of E   p50 ${pct(R.emitShare.p50)}  p90 ${pct(R.emitShare.p90)}`);
  console.log(`    live filter taps of 25   p50 ${R.taps.p50}  p05 ${R.taps.p05}  min ${R.taps.min}`);
  console.log(`    anchor vs its tile-centre gbuffer point  p50 ${f(R.anchor.p50, 3)} m  ` +
    `p90 ${f(R.anchor.p90, 3)} m  max ${f(R.anchor.max, 3)} m  (n ${R.anchor.n})`);
  if (R.origin) {
    console.log(`    ORIGIN ESCAPE k (cells the trace origin is pushed past the bias),` +
      ` ${R.origin.sampled} wall probes:`);
    console.log(`      k=0 ${R.origin.hist[0]}   k=1 ${R.origin.hist[1]}   ` +
      `k=2 ${R.origin.hist[2]}   k=3 ${R.origin.hist[3]}`);
    console.log(`      adjacent pairs with the SAME k: p50 ${pct(R.origin.same.p50)}  ` +
      `p90 ${pct(R.origin.same.p90)}  (n ${R.origin.same.n})`);
    console.log(`      adjacent pairs with a DIFFERENT k: p50 ${pct(R.origin.diff.p50)}  ` +
      `p90 ${pct(R.origin.diff.p90)}  (n ${R.origin.diff.n})   <- raw |dE|/max`);
  }
  console.log(`    tile purity (share of a tile's pixels on its probe's plane)  ` +
    `p50 ${pct(R.tilePurity.p50)}  p05 ${pct(R.tilePurity.p05)}`);
  console.log(`\n  ── the three worst adjacent pairs, texel by texel ──────────────────`);
  for (const w of R.worst) {
    console.log(`\n    probes ${w.i}/${w.j}  ratio ${pct(w.r)}   E ${f(w.Ea, 4)} vs ${f(w.Eb, 4)}   ` +
      `${f(w.dist, 2)} m apart`);
    console.log(`      raw ${f(w.rawA, 4)}/${f(w.rawB, 4)}   filtered ${f(w.filA, 4)}/${f(w.filB, 4)}   ` +
      `emitter ${f(w.emiA, 4)}/${f(w.emiB, 4)}   taps ${w.tapsA}/${w.tapsB}`);
    console.log(`      near-field (hit < 4 cells) carries ${pct(w.nearShare)} of the texel gap;  ` +
      `${w.spreadTexels} texels carry > 2 % of it each`);
    for (const t of w.top) {
      console.log(`        texel ${String(t.t).padStart(2)} dir [${t.dir}]  Δ ${f(t.dl, 5)} ` +
        `(${pct(t.share, 1)})  L ${f(t.La, 3)}/${f(t.Lb, 3)}  hit ${f(t.da, 2)}/${f(t.db, 2)} m  ` +
        `n ${t.na}/${t.nb}`);
    }
  }
} else {
  console.log(`\n  ── NEIGHBOUR RATIO on 6-adjacent WALL LATTICE cells, per cascade ───`);
  for (const c of R.cascades) {
    console.log(`    c${c.c} ${f(c.spacing, 2)} m  cells ${String(c.cells).padStart(5)} ` +
      `(${c.faced} faced, ${c.notReady} not ready, ready p50 ${f(c.readyP50, 2)})`);
    console.log(row(`  c${c.c} pairs`, c.ratio));
  }
}

if (REF && refData?.image) {
  console.log(`\n  ── against ${REF} (${refData.path ?? "?"}) ──────────────────────────`);
  if (refData.image.curvAfter) {
    for (let i = 0; i < R.image.curvAfter.length; i++) {
      const a = refData.image.curvAfter[i];
      const b = R.image.curvAfter[i];
      if (!a || !b) continue;
      console.log(`    curv lag ${String(b.lag).padStart(2)}  p50 ${pct(a.p50)} → ${pct(b.p50)}   ` +
        `p90 ${pct(a.p90)} → ${pct(b.p90)}`);
    }
  }
  if (refData.stages && R.stages) {
    for (const k of Object.keys(R.stages)) {
      if (!refData.stages[k]) continue;
      console.log(`    ${k.padEnd(14)} p50 ${pct(refData.stages[k].p50)} → ${pct(R.stages[k].p50)}   ` +
        `p90 ${pct(refData.stages[k].p90)} → ${pct(R.stages[k].p90)}`);
    }
  }
}

const tileRow = R.image.curvAfter.find((s) => s.lag === R.image.tileLag)
  ?? R.image.curvAfter[R.image.curvAfter.length - 1];
const gate = tileRow.p90;
console.log(`\n  GATE: wall CURVATURE p90 at the TILE lag (${tileRow.lag} px) ${pct(gate)}  ` +
  `${gate < 0.10 ? "PASS (< 10 %)" : "FAIL (≥ 10 % — the puddles)"}`);

if (OUT) {
  writeFileSync(OUT, JSON.stringify({
    pose: { position: pose.position, target: pose.target },
    path: R.path, cfg: R.cfg, wall: R.wall, stages: R.stages, image: R.image,
    emitShare: R.emitShare, taps: R.taps, anchor: R.anchor, tilePurity: R.tilePurity,
    cascades: R.cascades,
  }, null, 1));
  console.log(`  reference written to ${OUT}`);
}

await browser.close();
