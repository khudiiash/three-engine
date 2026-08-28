// GI2 FACE-TERM PROBE — §19 Stage 4.5: WHICH TERM OF `shadeHit` CARRIES THE 110 %?
//
// ══ WHAT §AC LEFT OPEN ══════════════════════════════════════════════════════
//
// §AC proved the puddles are the RADIANCE CACHE's per-face values — two probes
// 7 cm apart trace the same 64 directions, hit the same distant wall to within
// 30 cm, and read 0.152 against 0.005 — and it could not say WHICH of the four
// things `shadeHit` adds produces that. `cacheAccumFn`'s header quotes a σ/mean
// of 110 % across one brick's faces; that is a statement about their SUM.
//
// The fix is different for each:
//   · a 4-ray SKY quadrature disagreeing → more directions, or a wider read
//   · a binary SUN shadow ray → a small deterministic cone
//   · the second BOUNCE reading COLD faces as black → what a cold hit pays
//   · the emitter NEE → nowhere near here (and §AC.3 already measured it at 0)
//
// So this probe evaluates the SHIPPING estimator (`gather.internals.shadeTerms`,
// the same accumulators `shadeHit` sums) at every coplanar voxel face of the
// wall bricks in front of the camera, and reports the σ/mean of each term
// against the SAME denominator — the face radiance's own mean. A term's share
// of the total spread is then a number, not an argument.
//
// It also prints the census the terms were built from: the sun's binary
// visibility, how many of the sky rays MISSED (open sky) and how many hit a
// face the cache had already written (a warm second bounce) rather than a cold
// one (a black one).
//
// ⚠ THE POPULATION IS ONE BRICK'S COPLANAR FACES, not "every written word".
// [[probe-blind-statistics]]: a σ/mean over a layer that mixes wall and air, or
// two planes of one brick, measures the geometry and not the estimator. The
// slab is the 16 voxels of the brick that share the hit's own layer along the
// face axis, filtered to OCCUPIED voxels whose voxelized dominant axis is the
// face's — exactly the population `run-gi2-dirt-probe.mjs` scores.
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//
// Run:
//   POSE='x,y,z|x,y,z' node scripts/run-gi2-faceterm-probe.mjs
//   OUT=/tmp/faceterm-before.json ... ; REF=/tmp/faceterm-before.json ...
//
// Env: PROJECT · SCENE=Bistro · SETTLE=14 · FRAMES=240 · POSE · OUT · REF ·
//      FLAGS · HEADED=1
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 14);
const FRAMES = Number(process.env.FRAMES ?? 240);
const OUT = process.env.OUT ?? "";
const REF = process.env.REF ?? "";
// §AC.2's pose, pinned: the two receipts must measure ONE wall.
// ARMS="w:cold,w:cold,…" — the smoother weight and the cold-fill flag per arm.
// Default sweeps the WIDTH with cold-fill OFF, which is also the energy control:
// the smoother is row-stochastic, so every arm must report the same mean.
const ARMS = (process.env.ARMS ?? "0:0,0.5:0,0.85:0").split(",").map((a) => {
  const [w, c] = a.split(":").map(Number);
  return { name: `w ${w} · cold ${c}`, smooth: w, cold: c };
});
const POSE_ENV = process.env.POSE ?? "-13.83,7.35,-9.49|-9.75,7.35,-13.90";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const pct = (v, n = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(n)} %` : "—");

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

console.log(`\n══ ${SCENE} — the face terms ════════════════════════════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{
  const dl = Date.now() + 240000;
  while (Date.now() < dl && !firstLight) await wait(250);
}
// ⚠⚠ NO FIRST LIGHT IS A FATAL, NOT A FOOTNOTE. [[probe-blind-statistics]]: a
// broken shader module produces a full, well-formatted table of zeros and a
// VERDICT block comparing them — which is exactly what this probe printed when
// the plane smoother's first cut invalidated the compute module. A receipt that
// can report a pass on a chain that never lit is worse than no receipt.
if (!firstLight) {
  console.log("");
  console.log("  FATAL: [gi2] first light NEVER arrived — the GI2 chain did not compile.");
  console.log("  Every number below would be a zero dressed as a measurement.");
  await browser.close();
  process.exit(1);
}
console.log(`  first light yes — settling ${SETTLE}s`);
await wait(SETTLE * 1000);

const [eye, aim] = POSE_ENV.split("|").map((s) => s.split(",").map(Number));
console.log(`  pose: eye [${eye.map((v) => v.toFixed(2))}] → [${aim.map((v) => v.toFixed(2))}]`);
await call("viewport.setCamera", { position: eye, target: aim });
await settleFrames(FRAMES);

const R = await page.evaluate(async ({ eye, aim, ARMS, ARMFRAMES }) => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  if (!gi2?.gather?.internals) return { error: "no gather internals — old build?" };
  const ws = await import("/src/modules/gi/window/windowStore.js");
  const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
  const { createGi2FaceTermProbe } = await import("/scripts/lib/gi2FaceTermProbe.js");
  const shoot = createGi2RayShooter(gi2, eng.renderer);
  const terms = createGi2FaceTermProbe(gi2, eng.renderer);
  const v0 = gi2.win.voxel0;
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const nz = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const fwd = nz([aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]]);
  const right = nz(cross(fwd, [0, 1, 0]));
  const up = nz(cross(right, fwd));

  // ── 1. WHICH BRICKS. A fan of rays from the camera, in batches of 63 (the
  // shooter's dispatch is 64 wide), jittered so the fan walks over the wall at
  // a fraction of a brick rather than sampling one row of it.
  const hits = [];
  for (let b = 0; b < 16; b++) {
    const ox = ((b % 4) - 1.5) * 0.045;
    const oy = (Math.floor(b / 4) - 1.5) * 0.045;
    const rays = [];
    for (let i = -4; i <= 4; i++) {
      for (let j = -3; j <= 3; j++) {
        const a = i * 0.11 + ox;
        const c = j * 0.11 + oy;
        rays.push({
          o: eye,
          d: nz([fwd[0] + right[0] * a + up[0] * c,
            fwd[1] + right[1] * a + up[1] * c,
            fwd[2] + right[2] * a + up[2] * c]),
          tMax: 30,
        });
      }
    }
    hits.push(...await shoot(rays));
  }
  const winW = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
  const occAt = (x, y, z) => {
    const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12);
    return (winW[ws.OCC_OFF + (i >> 5)] >>> (i & 31)) & 1;
  };
  const faceByte = (x, y, z) => {
    const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12);
    return (winW[ws.FACE_OFF + (i >> 2)] >>> ((i & 3) * 8)) & 255;
  };
  const NRM = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  // ── 2. THE SLAB. The hit's world cell comes from the hit POINT (the toroidal
  // index alone cannot say which 64-cell window it belongs to); the brick is
  // that cell's top bits, and the slab is the brick layer that contains it.
  const dirOf = (k) => {
    // Re-derive the ray direction for hit k from the same fan.
    const b = Math.floor(k / 63); const r = k % 63;
    const ox = ((b % 4) - 1.5) * 0.045;
    const oy = (Math.floor(b / 4) - 1.5) * 0.045;
    const i = Math.floor(r / 7) - 4; const j = (r % 7) - 3;
    const a = i * 0.11 + ox; const c = j * 0.11 + oy;
    return nz([fwd[0] + right[0] * a + up[0] * c,
      fwd[1] + right[1] * a + up[1] * c,
      fwd[2] + right[2] * a + up[2] * c]);
  };

  // ⭐⭐ THE FACE A HIT BELONGS TO IS THE VOXEL'S, NOT THE RAY'S — §19 STAGE 3.9,
  // AND THE FIRST CUT OF THIS PROBE FORGOT IT AND WENT BLIND.
  //
  // `traceWindow` reports the face it ENTERED through, and 95 % of Bistro's
  // façade voxels carry all six blocking bits, so a grazing ray on a +Z wall
  // files its hit under −X. Voting the wall's face on THAT gave face 1 on a wall
  // whose voxelized dominant axis is Z: every voxel was then rejected by the
  // axis test, one brick survived by luck, its faces were placed on a side the
  // wall does not have, and every number came back 0.000 with "100 % of the sky
  // rays hit a COLD face". A dead instrument that prints a passing gate.
  // [[probe-blind-statistics]] — this is `gatherProbes.dominantFace`'s rule,
  // transcribed for the CPU: the voxel's own dominant axis out of the face
  // byte's bits 6-7, and the SIDE whose outward neighbour is empty.
  const domFace = (wc, hint) => {
    const code = (faceByte(wc[0], wc[1], wc[2]) >>> 6) & 3;
    if (!code) return -1;
    const ax = code - 1;
    const e = [0, 0, 0];
    e[ax] = 1;
    const occP = occAt(wc[0] + e[0], wc[1] + e[1], wc[2] + e[2]);
    const occN = occAt(wc[0] - e[0], wc[1] - e[1], wc[2] - e[2]);
    if (!occP && occN) return 2 * ax;
    if (!occN && occP) return 2 * ax + 1;
    return 2 * ax + (hint[ax] >= 0 ? 0 : 1);
  };

  // The hit's world cell, and the face it really belongs to. Voted over every
  // level-0 hit; a façade is VERTICAL, so ±Y is not a candidate.
  const faceVotes = new Array(6).fill(0);
  const cells = [];
  let badCell = 0;
  for (let k = 0; k < hits.length; k++) {
    const h = hits[k];
    if (!h.hit || h.level !== 0) continue;
    const d = dirOf(k);
    const t = h.t + 0.02;
    const hp = [eye[0] + d[0] * t, eye[1] + d[1] * t, eye[2] + d[2] * t];
    const cell = hp.map((c) => Math.floor(c / v0));
    // The toroidal index must agree, or the hit-point reconstruction is wrong.
    const vi = (cell[0] & 63) | ((cell[1] & 63) << 6) | ((cell[2] & 63) << 12);
    if (vi !== h.voxelIdx) { badCell++; continue; }
    const face = domFace(cell, [-d[0], -d[1], -d[2]]);
    if (face < 0 || face === 2 || face === 3) continue;
    faceVotes[face]++;
    cells.push({ cell, face });
  }
  const wallFace = faceVotes.indexOf(Math.max(...faceVotes));
  if (!(faceVotes[wallFace] > 0)) {
    return { error: "no vertical level-0 hits", hits: hits.length, badCell, faceVotes };
  }
  const nrm = NRM[wallFace];
  // ⭐⭐ THE WALL IS A STAIRCASE, AND A BRICK *LAYER* IS THE WRONG POPULATION.
  // §AC's wall runs at 45° to both horizontal axes, so its conservative
  // voxelization steps diagonally through the grid: within one 4×4×4 brick the
  // wall's voxels are a diagonal ribbon, and the SAT's area-weighted argmax
  // hands neighbouring steps DIFFERENT dominant axes. Scoring the 16 voxels of
  // one axis-aligned layer found four bricks' worth of faces in the whole frame.
  // The population is therefore every OCCUPIED voxel of the bricks the rays hit
  // whose dominant face is the wall's, at any layer — the wall as the voxelizer
  // actually built it.
  const faceOf = new Map(); // "x,y,z" → the face record
  const brickSeen = new Set();
  for (const { cell } of cells) {
    const base = cell.map((c) => (c >> 2) << 2);
    const bkey = `${base}`;
    if (brickSeen.has(bkey)) continue;
    brickSeen.add(bkey);
    for (let k = 0; k < 64; k++) {
      const wc = [base[0] + (k & 3), base[1] + ((k >> 2) & 3), base[2] + ((k >> 4) & 3)];
      if (!occAt(wc[0], wc[1], wc[2])) continue;
      if (domFace(wc, nrm) !== wallFace) continue;
      const key = `${wc}`;
      if (faceOf.has(key)) continue;
      faceOf.set(key, {
        p: [(wc[0] + 0.5) * v0 + nrm[0] * v0 * 0.5,
          (wc[1] + 0.5) * v0 + nrm[1] * v0 * 0.5,
          (wc[2] + 0.5) * v0 + nrm[2] * v0 * 0.5],
        n: nrm,
        level: 0,
        voxelIdx: (wc[0] & 63) | ((wc[1] & 63) << 6) | ((wc[2] & 63) << 12),
        face: wallFace,
        cell: wc,
        brick: bkey,
      });
    }
  }
  if (!faceOf.size) return { error: "no wall faces", wallFace, faceVotes, badCell };

  // ── 3. THE TERMS, at every one of those faces (capped at the rig's width).
  const all = [...faceOf.values()].slice(0, 4096);

  // ⭐⭐ BOTH ARMS OUT OF ONE BOOT, AT ONE POSE, OVER ONE FACE LIST. The wall is
  // chosen once, above; each arm then flips two uniforms, lets the cache settle,
  // and re-reads the SAME faces. A before/after taken from two runs would differ
  // by the voxelization, the merge, the pose sweep and the emitter admission as
  // well as by the change — and §AC already records what that costs.
  const waitFrames = async (n) => {
    const f0 = gi2.gather.frame;
    const dl = Date.now() + 180000;
    while (gi2.gather.frame - f0 < n && Date.now() < dl) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return gi2.gather.frame - f0;
  };
  const U = gi2.gather.uniforms;
  const arms = [];
  for (const arm of ARMS) {
  U.cacheSmoothU.value = arm.smooth;
  U.coldFillU.value = arm.cold;
  const settled = await waitFrames(ARMFRAMES);
  const out = await terms(all);
  const byBrick = new Map();
  const byCell = new Map();
  for (const o of out) {
    let a = byBrick.get(o.brick);
    if (!a) byBrick.set(o.brick, a = []);
    a.push(o);
    byCell.set(`${o.cell}`, o);
  }
  for (const [k, a] of [...byBrick]) if (a.length < 4) byBrick.delete(k);

  // ── 4. THE STATISTICS. Every term against ONE denominator — the face
  // radiance's own mean over the brick — so the shares are comparable and add
  // up to something.
  const outRad = (o) => {
    const E = [0, 1, 2].map((c) => o.Esun[c] + o.Emiss[c] + o.Ebnc[c] + o.Enee[c]);
    return [0, 1, 2].map((c) => (o.albedo[c] * E[c]) / Math.PI);
  };
  const termRad = (o, k) => [0, 1, 2].map((c) => (o.albedo[c] * o[k][c]) / Math.PI);
  const cv = (vals, mean) => {
    if (vals.length < 4) return null;
    const m = mean ?? vals.reduce((a, b) => a + b, 0) / vals.length;
    if (!(m > 1e-7)) return null;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
    return sd / m;
  };
  const med = (a) => {
    const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  };
  const q = (a, p) => {
    const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
  };
  const cvTotal = []; const cvStored = [];
  const cvSun = []; const cvMiss = []; const cvBnc = []; const cvNee = [];
  const shareSun = []; const shareMiss = []; const shareBnc = []; const shareNee = [];
  const diag = out.diag ?? null;
  let ran = 0;
  for (const o of out) if (o.ran > 0) ran++;
  let nFaces = 0; let sumRad = 0; let sumStored = 0; let nStored = 0;
  let sunLit = 0; let skyMiss = 0; let skyWarm = 0; let skyCold = 0; let nSky = 0;
  const skyRays = gi2.gather.describe().skyRays;
  for (const [, arr] of byBrick) {
    const rad = arr.map((o) => lum(outRad(o)));
    const m = rad.reduce((a, b) => a + b, 0) / rad.length;
    nFaces += arr.length;
    sumRad += rad.reduce((a, b) => a + b, 0);
    for (const o of arr) {
      if (o.storedValid > 0.5) { sumStored += lum(o.stored); nStored++; }
      sunLit += o.sunVis; skyMiss += o.skyMiss; skyWarm += o.skyWarm;
      skyCold += skyRays - o.skyMiss - o.skyWarm; nSky += skyRays;
    }
    const c = cv(rad, m);
    if (c !== null) cvTotal.push(c);
    const st = arr.filter((o) => o.storedValid > 0.5).map((o) => lum(o.stored));
    const cs = cv(st);
    if (cs !== null) cvStored.push(cs);
    // ⭐ EACH TERM'S SPREAD AGAINST THE TOTAL'S MEAN. σ(term)/mean(total) is the
    // term's CONTRIBUTION to the composite's coefficient of variation; a term
    // scored against its own mean would make a term that is almost always zero
    // look like the loudest thing in the estimator.
    for (const [k, dst, sh] of [["Esun", cvSun, shareSun], ["Emiss", cvMiss, shareMiss],
      ["Ebnc", cvBnc, shareBnc], ["Enee", cvNee, shareNee]]) {
      const t = arr.map((o) => lum(termRad(o, k)));
      const c2 = cv(t, m);
      if (c2 !== null) dst.push(c2);
      const tm = t.reduce((a, b) => a + b, 0) / t.length;
      if (m > 1e-7) sh.push(tm / m);
    }
  }
  // ⭐ AND THE PAIR STATISTIC, WHICH IS THE COMPLAINT'S OWN SHAPE. §AC's dump is
  // two rays landing on ADJACENT faces of one wall and reading 30× apart; a
  // per-brick σ/mean can be inflated by a real gradient across a metre, a
  // 26-neighbour pair ratio cannot. Both are reported; the pair one is the gate.
  const pairR = [];
  const pairLit = [];
  const meanRadForFloor = sumRad / Math.max(1, nFaces);
  for (const [, o] of byCell) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue;
          const nb = byCell.get(`${[o.cell[0] + dx, o.cell[1] + dy, o.cell[2] + dz]}`);
          if (!nb) continue;
          // Each unordered pair once.
          if (`${nb.cell}` < `${o.cell}`) continue;
          const a = lum(outRad(o)); const b = lum(outRad(nb));
          const mx = Math.max(a, b);
          if (mx > 1e-6) pairR.push(Math.abs(a - b) / mx);
          // ⚠ AND THE SAME PAIRS ABOVE A FLOOR. The unfloored p90 pinned at
          // exactly 77.0 % in two arms that differ everywhere else — a tail made
          // of pairs where ONE face is essentially black, so the ratio is 1 by
          // construction and no smoother can move it. The puddle probe's own
          // FLOOR discipline, applied here: a fraction of what the wall
          // measures, never a constant in radiance units.
          if (Math.min(a, b) > 0.1 * meanRadForFloor) pairLit.push(Math.abs(a - b) / mx);
        }
      }
    }
  }
  arms.push({
    name: arm.name, settled,
    pair: { p50: med(pairR), p90: q(pairR, 0.9), n: pairR.length },
    pairLit: { p50: med(pairLit), p90: q(pairLit, 0.9), n: pairLit.length },
    cfg: {
      tier: gi2.gather.tier, v0, skyRays, nCap: gi2.gather.uniforms.nCapU.value,
      shadeStride: gi2.gather.uniforms.shadeStrideU.value,
      worldProbes: !!gi2.gather.worldProbes,
      smooth: gi2.gather.uniforms.cacheSmoothU?.value ?? null,
      coldFill: gi2.gather.uniforms.coldFillU?.value ?? null,
      skySets: gi2.gather.describe().skySets ?? null,
    },
    wallFace, faceVotes, badCell, ran, diag, dispatched: out.length, bricks: byBrick.size, faces: nFaces,
    meanRad: sumRad / Math.max(1, nFaces),
    meanStored: sumStored / Math.max(1, nStored), storedFrac: nStored / Math.max(1, nFaces),
    census: {
      sunLit: sunLit / Math.max(1, nFaces),
      skyMiss: skyMiss / Math.max(1, nSky),
      skyWarm: skyWarm / Math.max(1, nSky),
      skyCold: skyCold / Math.max(1, nSky),
    },
    cv: {
      total: { p50: med(cvTotal), p90: q(cvTotal, 0.9), n: cvTotal.length },
      stored: { p50: med(cvStored), p90: q(cvStored, 0.9), n: cvStored.length },
      sun: { p50: med(cvSun), share: med(shareSun) },
      skyMiss: { p50: med(cvMiss), share: med(shareMiss) },
      bounce: { p50: med(cvBnc), share: med(shareBnc) },
      nee: { p50: med(cvNee), share: med(shareNee) },
    },
  });
  }
  return { wallFace, faceVotes, badCell, faces: all.length, arms };
}, { eye, aim, ARMS, ARMFRAMES: FRAMES });

if (R.error) {
  console.log(`\n  FATAL: ${R.error}  ${JSON.stringify(R)}`);
  await browser.close();
  process.exit(1);
}
const refData = REF ? JSON.parse(readFileSync(REF, "utf8")) : null;
const A = R.arms[0];
const B = R.arms[1];
console.log(`
  wall face ${R.wallFace} — ${R.faces} occupied faces on it, ` +
  `${A.bricks} bricks with 4+ faces`);
console.log(`  kernel: ${A.ran} of ${A.dispatched} threads wrote (attempts ${A.diag?.attempts}, ` +
  `witness ${A.diag?.witness}, gpu error ${A.diag?.gpuError ?? "none"})`);

for (const a of R.arms) {
  console.log(`
  ══ ${a.name} — smooth ${a.cfg.smooth} · coldFill ${a.cfg.coldFill} ` +
    `· skyRays ${a.cfg.skyRays} · nCap ${a.cfg.nCap} · stride ${a.cfg.shadeStride} ` +
    `· ${a.cfg.worldProbes ? "WORLD" : "SCREEN"} probes · settled ${a.settled} frames`);
  console.log(`     mean face radiance ${f(a.meanRad, 5)}   (cache holds ${f(a.meanStored, 5)}, ` +
    `${pct(a.storedFrac)} of the faces written)`);
  console.log(`     census: sun visible on ${pct(a.census.sunLit)} of faces;  of the sky rays ` +
    `${pct(a.census.skyMiss)} MISS, ${pct(a.census.skyWarm)} hit a WARM face, ` +
    `${pct(a.census.skyCold)} a COLD one`);
  console.log(`     ADJACENT face pairs |La−Lb|/max   p50 ${pct(a.pair.p50)}  ` +
    `p90 ${pct(a.pair.p90)}   (n ${a.pair.n})`);
  console.log(`       … both faces above 10 % of the wall mean   p50 ${pct(a.pairLit.p50)}  ` +
    `p90 ${pct(a.pairLit.p90)}   (n ${a.pairLit.n})`);
  console.log(`     σ/mean over one brick's faces    shade p50 ${pct(a.cv.total.p50)} ` +
    `p90 ${pct(a.cv.total.p90)}   stored p50 ${pct(a.cv.stored.p50)}`);
  console.log(`     σ(term)/mean(total)  ·  share of the mean:`);
  for (const [name, k] of [["sun", "sun"], ["sky (miss)", "skyMiss"], ["bounce (hit)", "bounce"],
    ["emitter NEE", "nee"]]) {
    console.log(`       ${name.padEnd(13)} σ/mean ${pct(a.cv[k].p50).padStart(8)}   ` +
      `share ${pct(a.cv[k].share).padStart(8)}`);
  }
}

console.log(`
  ══ THE VERDICT ═══════════════════════════════════════════════`);
console.log("    arm            pair p50   pair p90   LIT p50   LIT p90   brick σ/mean   mean E      ΔE");
for (const a of R.arms) {
  const dE = (a.meanRad - A.meanRad) / Math.max(1e-9, A.meanRad);
  console.log(`    ${a.name.padEnd(14)} ${pct(a.pair.p50).padStart(8)}   ` +
    `${pct(a.pair.p90).padStart(8)}  ${pct(a.pairLit.p50).padStart(8)}  ` +
    `${pct(a.pairLit.p90).padStart(8)}   ${pct(a.cv.total.p50).padStart(10)}   ` +
    `${f(a.meanRad, 5)}   ${(dE * 100).toFixed(1).padStart(6)} %`);
}
console.log("    (ΔE is against the first arm; the smoother is row-stochastic, so a");
console.log("     width sweep with cold-fill OFF must hold the mean — that is the energy control.)");
if (refData?.arms) {
  console.log(`
  ── against ${REF} ──`);
  for (let i = 0; i < Math.min(refData.arms.length, R.arms.length); i++) {
    console.log(`    ${R.arms[i].name.padEnd(14)} pair p90 ${pct(refData.arms[i].pair.p90)} → ` +
      `${pct(R.arms[i].pair.p90)}   meanRad ${f(refData.arms[i].meanRad, 5)} → ` +
      `${f(R.arms[i].meanRad, 5)}`);
  }
}
if (OUT) {
  writeFileSync(OUT, JSON.stringify(R, null, 1));
  console.log(`  reference written to ${OUT}`);
}
await browser.close();
