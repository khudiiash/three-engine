// ⭐⭐ THE BLACK FACES, BY THE COLOUR-PROBE METHOD (§19 §AJ.2).
//
// `run-gi2-cornell-ref.mjs` says WHICH pixels are black — 328 of 10 019 lit
// pixels on the user's `Cornel.scene`, 23 % of the tall box's +Z face and 12 %
// of the back wall. It cannot say WHY, and [[gi-colour-probe-method]] is
// explicit that guessing at that point is the expensive move: read every stage
// and take the FIRST one that is wrong.
//
// The stages behind a black pixel, in order:
//
//   1. the WINDOW      is there an occupied voxel there at all, and what does
//                      its face byte say its dominant axis is
//   2. the CACHE SLOT  does the brick own a slot (`map != 0`), has this face
//                      ever been written (the RGBE word != 0), and how many
//                      samples has it taken (`n`, the parallel count byte)
//   3. the STORED VALUE what the cache actually hands a ray that lands here
//   4. the ESTIMATOR   what `shadeHit` would compute at this face RIGHT NOW,
//                      split into its four terms plus the census they were
//                      built from (sun visible / sky rays that missed / sky
//                      rays that hit a WARM face)
//
// A black pixel whose stage-2 says "never written" is a SCHEDULING fault (no
// ray ever selected it). One whose stage-2 says "written 16 times" and whose
// stage-4 says every term is zero is a TRANSPORT fault (the light does not
// reach it through this estimator at all). They have nothing in common but the
// colour, and only one read tells them apart.
//
// ⚠ THE CONTROL IS THE SAME SURFACE'S BRIGHTEST PIXELS. "the cache is cold at
// the black pixels" means nothing until it is set against "the cache is warm at
// the lit ones", on the same wall, in the same frame. Both lists come out of
// the gate's own JSON so the two probes cannot disagree about which pixels they
// are discussing.
//
// ⚠ THE URL IS 5202, NEVER 5201.
//
// Run:  IN=/tmp/cornell-before.json node scripts/run-gi2-cornell-black.mjs
// Env:  PROJECT · SCENE=Cornel · POSE · IN · SETTLE=20 · FRAMES=240 · HEADED=1
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const IN = process.env.IN ?? "/tmp/cornell-before.json";
const SETTLE = Number(process.env.SETTLE ?? 20);
const FRAMES = Number(process.env.FRAMES ?? 240);
const POSE_ENV = process.env.POSE ?? "0.38,2.60,4.10|0.38,2.30,-1.00";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const pct = (v, n = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(n)} %` : "—");
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

const gate = JSON.parse(readFileSync(IN, "utf8"));
const black = gate.blackList ?? [];
const lit = gate.litList ?? [];
if (!black.length) { console.log(`  no black pixels in ${IN} — nothing to explain.`); process.exit(0); }
console.log(`\n══ ${SCENE} — WHY THE FACES ARE BLACK ══════════════════════════`);
console.log(`  ${black.length} black samples and ${lit.length} lit controls out of ${IN}`);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 932, height: 692, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
let firstLight = 0;
page.on("console", (m) => {
  const t = m.text();
  if (/first light/.test(t) && !firstLight) firstLight = Date.now();
  if (m.type() === "error" || /wgsl|reserved keyword|Invalid Shader/i.test(t)) console.log(`    ${t.slice(0, 240)}`);
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
  globalThis.__gi2 = () => globalThis.__giSys()?._gi2 ?? null;
});
const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{ const dl = Date.now() + 240000; while (Date.now() < dl && !firstLight) await wait(250); }
if (!firstLight) { console.log("  FATAL: no first light."); await browser.close(); process.exit(1); }
const [eye, aim] = POSE_ENV.split("|").map((s) => s.split(",").map(Number));
await call("viewport.setCamera", { position: eye, target: aim });
await wait(SETTLE * 1000);
{
  const f0 = await page.evaluate(() => globalThis.__gi2()?.gather?.frame ?? 0);
  const dl = Date.now() + 180000;
  let fr = f0;
  while (fr - f0 < FRAMES && Date.now() < dl) { await wait(400); fr = await page.evaluate(() => globalThis.__gi2()?.gather?.frame ?? 0); }
  console.log(`  settled ${fr - f0} gather frames`);
}

const RJ = await page.evaluate(async ({ black, lit }) => {
 try {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const ws = await import("/src/modules/gi/window/windowStore.js");
  const rc = await import("/src/modules/gi/window/radianceCache.js");
  const { createGi2FaceTermProbe } = await import("/scripts/lib/gi2FaceTermProbe.js");
  const terms = createGi2FaceTermProbe(gi2, eng.renderer);
  const v0 = gi2.win.voxel0;

  // ── STAGE 1: the WINDOW. `occAt` / `faceByte` transcribe `windowStore`'s
  // layout; `domFace` transcribes `gatherProbes.dominantFace` (the voxel's own
  // dominant axis out of the face byte's bits 6-7, and the SIDE whose outward
  // neighbour is empty) — a hit filed under the RAY's entry face reads a slot
  // no producer ever fills (§19 Stage 3.9).
  const winW = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
  // ⭐⭐ EVERY WINDOW READ IS PER LEVEL. The window is a CLIPMAP: measured on
  // this scene, level 0 holds the floor's neighbourhood and NOTHING ELSE — the
  // back wall, the ceiling and the tall box are all at level 1/2 — so a probe
  // that reads level 0 everywhere reports "no voxel, no slot, never written"
  // for three quarters of the room and calls it the bug.
  const occAt = (L, x, y, z) => {
    const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12);
    return (winW[L * ws.LEVEL_WORDS + ws.OCC_OFF + (i >> 5)] >>> (i & 31)) & 1;
  };
  const faceByte = (L, x, y, z) => {
    const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12);
    return (winW[L * ws.LEVEL_WORDS + ws.FACE_OFF + (i >> 2)] >>> ((i & 3) * 8)) & 255;
  };
  const domFace = (L, wc, hint) => {
    const code = (faceByte(L, wc[0], wc[1], wc[2]) >>> 6) & 3;
    if (!code) return -1;
    const ax = code - 1;
    const e = [0, 0, 0]; e[ax] = 1;
    const occP = occAt(L, wc[0] + e[0], wc[1] + e[1], wc[2] + e[2]);
    const occN = occAt(L, wc[0] - e[0], wc[1] - e[1], wc[2] - e[2]);
    if (!occP && occN) return 2 * ax;
    if (!occN && occP) return 2 * ax + 1;
    return 2 * ax + (hint[ax] >= 0 ? 0 : 1);
  };

  // ── STAGE 2: the CACHE. Read the whole pool back once and decode the map,
  // the RGBE word and the parallel count byte for each face by hand — the
  // addressing rule is `radianceCache.addressOf`, transcribed.
  const cacheW = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.cache.attribute));
  const slotOf = (level, cell) => {
    const cx = cell[0] & 63, cy = cell[1] & 63, cz = cell[2] & 63;
    const b = (cx >> 2) | ((cy >> 2) << 4) | ((cz >> 2) << 8);
    const lv = (cx & 3) | ((cy & 3) << 2) | ((cz & 3) << 4);
    const m = cacheW[gi2.cache.MAP_OFF + level * ws.BRICKS_PER_LEVEL + b];
    return { m, slot: m - 1, lv, brick: b };
  };
  const faceState = (level, cell, face) => {
    const { m, slot, lv } = slotOf(level, cell);
    if (!m) return { hasSlot: 0, written: 0, n: 0, rgb: [0, 0, 0] };
    const sub = lv * rc.SLOT_FACES + face;
    const word = cacheW[gi2.cache.DATA_OFF + slot * rc.SLOT_WORDS + sub];
    const n = (cacheW[gi2.cache.CNT_OFF + slot * rc.SLOT_CNT_WORDS + (sub >> 2)] >>> ((sub & 3) * 8)) & 255;
    const rgb = rc.unpackRgbe(word) ?? [0, 0, 0];
    return { hasSlot: 1, written: word !== 0 ? 1 : 0, n, rgb };
  };

  // ⭐⭐ FIND THE VOXEL BY SEARCH, NOT BY ONE STEP ALONG −n. The first cut
  // stepped half a cell into the surface and read the occupancy there; on the
  // tall box — rotated 61°, so its conservative voxelization is a STAIRCASE —
  // that landed in AIR for 100 % of the samples and every cache column came
  // back "no slot, never written", which reads exactly like the fault under
  // investigation. [[probe-blind-statistics]] A 3³ search around the surface
  // point, keeping only cells that are OCCUPIED and carry a dominant-axis code,
  // is what makes the columns mean anything.
  const NRM6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const prep = (list) => list.map((s0) => {
    for (let L = 0; L < gi2.win.levels; L++) {
      const r = prepAt(s0, L);
      if (r.occ && r.face >= 0) return r;
    }
    return prepAt(s0, 0);
  });
  const prepAt = (s, L) => {
    const vs = v0 * (1 << L);
    const seed = [s.p[0] - s.n[0] * vs * 0.5, s.p[1] - s.n[1] * vs * 0.5, s.p[2] - s.n[2] * vs * 0.5];
    const c0 = seed.map((c) => Math.floor(c / vs));
    let best = null;
    // ⚠ "OCCUPIED" AND "HAS A DOMINANT-AXIS CODE" ARE TWO DIFFERENT FACTS AND
    // THE FIRST CUT REPORTED THEM AS ONE. A voxel whose face byte carries no
    // axis code (bits 6-7 = 0) is INVISIBLE to `dominantFace`, which is the
    // §19 3.9 trap — the hit is then filed under the RAY's entry face and reads
    // a word no producer writes. Counting that as "no voxel here" would hide
    // exactly the mechanism under investigation.
    let occAny = 0;
    let codeAny = 0;
    let anyCell = null;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cell = [c0[0] + dx, c0[1] + dy, c0[2] + dz];
          if (!occAt(L, cell[0], cell[1], cell[2])) continue;
          occAny = 1;
          if (!anyCell) anyCell = cell;
          const code = (faceByte(L, cell[0], cell[1], cell[2]) >>> 6) & 3;
          if (code) codeAny = 1;
          const face = domFace(L, cell, s.n);
          if (face < 0) continue;
          // Distance from the SURFACE POINT to the cell centre — the cell that
          // owns this pixel is the nearest occupied one, and among ties the one
          // whose face normal agrees with the shading normal.
          const cc = cell.map((c) => (c + 0.5) * vs);
          const d = Math.hypot(cc[0] - s.p[0], cc[1] - s.p[1], cc[2] - s.p[2]);
          const agree = NRM6[face][0] * s.n[0] + NRM6[face][1] * s.n[1] + NRM6[face][2] * s.n[2];
          const score = d - agree * vs * 0.75;
          if (!best || score < best.score) best = { cell, face, score, agree };
        }
      }
    }
    if (!best) {
      // No cell with an axis code. Still report the cache state of the nearest
      // OCCUPIED cell across all six faces: that is what says whether the
      // surface's light is stored under some OTHER face or nowhere at all.
      let faces6 = 0, best6 = 0;
      if (anyCell) {
        for (let fi = 0; fi < 6; fi++) {
          const q = faceState(L, anyCell, fi);
          if (q.written) faces6++;
          const l = 0.2126 * q.rgb[0] + 0.7152 * q.rgb[1] + 0.0722 * q.rgb[2];
          if (l > best6) best6 = l;
        }
      }
      const cell = anyCell ?? c0;
      return { ...s, cell, voxelIdx: (cell[0] & 63) | ((cell[1] & 63) << 6) | ((cell[2] & 63) << 12),
        face: -1, occ: occAny, code: codeAny, agree: 0, level: L,
        st: { hasSlot: anyCell ? (slotOf(L, cell).m ? 1 : 0) : 0, written: 0, n: 0, rgb: [0, 0, 0] },
        faces6, best6 };
    }
    const { cell, face } = best;
    const voxelIdx = (cell[0] & 63) | ((cell[1] & 63) << 6) | ((cell[2] & 63) << 12);
    const st = faceState(L, cell, face);
    // ⭐ AND THE OTHER FIVE FACES OF THE SAME VOXEL. If this face is black while
    // a SIBLING face of the same voxel holds light, the fault is ATTRIBUTION —
    // a producer filed the surface under a face no reader asks for (§19 3.9's
    // trap, which a 61°-rotated box is the worst case for). If all six are
    // black the fault is upstream of the cache entirely.
    let faces6 = 0;
    let best6 = 0;
    for (let fi = 0; fi < 6; fi++) {
      const q = faceState(L, cell, fi);
      if (q.written) faces6++;
      const l = 0.2126 * q.rgb[0] + 0.7152 * q.rgb[1] + 0.0722 * q.rgb[2];
      if (l > best6) best6 = l;
    }
    return { ...s, cell, voxelIdx, face, occ: 1, code: 1, agree: best.agree, st, faces6, best6, level: L };
  };
  // ── the occupancy, LEVEL BY LEVEL. `occ 0 %` on a wall the camera can see is
  // either a transcription bug or a window that does not hold that wall at
  // level 0; only a per-level scan can say which, and the answer decides
  // whether every cache column above is meaningful.
  const occAtL = occAt;
  const levelScan = (s0) => {
    const out = [];
    for (let L = 0; L < gi2.win.levels; L++) {
      const vs = v0 * (1 << L);
      const c = [0, 1, 2].map((a) => Math.floor((s0.p[a] - s0.n[a] * vs * 0.5) / vs));
      let hits = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        hits += occAtL(L, c[0] + dx, c[1] + dy, c[2] + dz);
      }
      out.push(hits);
    }
    return out;
  };
  // ⭐⭐ HOW MANY VOXELS DOES EACH LEVEL ACTUALLY HOLD? A popcount over each
  // level's occupancy words, next to the window's own description of where that
  // level is. "level 0 is empty above the floor" is a claim about the CLIPMAP's
  // placement, and a per-level census is the only thing that can make it.
  const OCC_WORDS_PER_LEVEL = ws.FACE_OFF - ws.OCC_OFF;
  const levelCensus = [];
  for (let L = 0; L < gi2.win.levels; L++) {
    let bits = 0;
    for (let w = 0; w < OCC_WORDS_PER_LEVEL; w++) {
      let v = winW[L * ws.LEVEL_WORDS + ws.OCC_OFF + w];
      while (v) { v &= v - 1; bits++; }
    }
    levelCensus.push(bits);
  }
  const B = prep(black);
  const L = prep(lit);

  // ── STAGE 4: the ESTIMATOR, as it stands right now at each of those faces.
  const NRM = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const ask = (rows) => rows.map((r) => ({
    p: r.p,
    // the FACE's own outward normal, not the gbuffer's — `shadeHit` is a
    // function of the face, and asking it about a different normal measures
    // a shade no ray ever computes.
    n: r.face >= 0 ? NRM[r.face] : r.n,
    level: r.level ?? 0, voxelIdx: r.voxelIdx, face: Math.max(0, r.face),
  }));
  const tB = await terms(ask(B));
  const tL = await terms(ask(L));
  // ⚠ THE PROBE'S OWN DIAGNOSTIC IS PART OF THE RECEIPT. `ran` is the thread
  // index each thread stamps; a table of zeros with `ran = 0` is a dead kernel,
  // not a dark wall. [[probe-blind-statistics]]
  const ranB = tB.filter((x) => x.ran > 0).length;
  const ranL = tL.filter((x) => x.ran > 0).length;
  return JSON.stringify({
    v0, levels: gi2.win.levels, win: gi2.win.describe?.() ?? null, levelCensus,
    scan: [...black.slice(0, 3), ...lit.slice(0, 3), ...lit.slice(40, 43), ...lit.slice(120, 123), ...lit.slice(160, 163)]
      .map((s0) => ({ surf: s0.surf, p: s0.p.map((v) => +v.toFixed(3)), n: s0.n.map((v) => +v.toFixed(2)), occ: levelScan(s0) })),
    black: B, lit: L, termsBlack: tB, termsLit: tL,
    diag: { ranB, ranL, nB: tB.length, nL: tL.length, diagB: tB.diag, diagL: tL.diag },
    cacheCtl: gi2.cache.readControl(cacheW),
    gather: gi2.gather.describe(),
  });
 } catch (err) { return JSON.stringify({ error: `${err?.message}\n${err?.stack}`.slice(0, 900) }); }
}, { black, lit });

const R = JSON.parse(RJ ?? '{"error":"page returned nothing"}');
if (R.error) { console.log(`  FATAL: ${R.error}`); await browser.close(); process.exit(1); }

const lumf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const summarise = (rows, terms, title) => {
  const bySurf = new Map();
  rows.forEach((r, i) => {
    const t = terms[i] ?? {};
    if (!bySurf.has(r.surf)) bySurf.set(r.surf, []);
    bySurf.get(r.surf).push({ r, t });
  });
  console.log("");
  console.log(`  ── ${title} ──────────────────────────────────────────────`);
  console.log("  surface            n   lvl  occ  code  face agree  slot  written   n̄    stored  faces6  best6 | Esun    Esky    Ebnc    Enee   | sunVis skyMiss warmHit");
  for (const [name, list] of [...bySurf.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const g = (fn) => mean(list.map(fn));
    console.log(
      `  ${name.padEnd(16)} ${String(list.length).padStart(4)} ` +
      `${f(g((x) => x.r.level), 1).padStart(4)} ${pct(g((x) => x.r.occ), 0).padStart(6)} ${pct(g((x) => x.r.code ?? 0), 0).padStart(5)} ${f(g((x) => x.r.face), 1).padStart(5)} ${f(g((x) => x.r.agree), 2).padStart(5)} ` +
      `${pct(g((x) => x.r.st.hasSlot), 0).padStart(6)} ${pct(g((x) => x.r.st.written), 0).padStart(7)} ` +
      `${f(g((x) => x.r.st.n), 1).padStart(5)} ${f(g((x) => lumf(x.r.st.rgb))).padStart(8)} ` +
      `${f(g((x) => x.r.faces6), 1).padStart(6)} ${f(g((x) => x.r.best6)).padStart(7)} | ` +
      `${f(g((x) => lumf(x.t.Esun ?? [0, 0, 0]))).padStart(7)} ${f(g((x) => lumf(x.t.Emiss ?? [0, 0, 0]))).padStart(7)} ` +
      `${f(g((x) => lumf(x.t.Ebnc ?? [0, 0, 0]))).padStart(7)} ${f(g((x) => lumf(x.t.Enee ?? [0, 0, 0]))).padStart(7)} | ` +
      `${f(g((x) => x.t.sunVis ?? 0), 2).padStart(6)} ${f(g((x) => x.t.skyMiss ?? 0), 2).padStart(7)} ${f(g((x) => x.t.skyWarm ?? 0), 2).padStart(7)}`,
    );
  }
};
console.log(`  kernel witness: ${R.diag.ranB}/${R.diag.nB} black, ${R.diag.ranL}/${R.diag.nL} lit ` +
  `(attempts ${R.diag.diagB?.attempts}/${R.diag.diagL?.attempts}${R.diag.diagB?.gpuError ? `, GPU error ${R.diag.diagB.gpuError}` : ""})`);
if (!(R.diag.ranB > 0)) {
  console.log("  FATAL: the face-term kernel never ran — every term below would be a zero dressed as a measurement.");
  await browser.close();
  process.exit(1);
}
summarise(R.black, R.termsBlack, "THE BLACK PIXELS");
summarise(R.lit, R.termsLit, "THE LIT CONTROLS (same surfaces)");
console.log("");
console.log("");
console.log("  ── OCCUPANCY BY WINDOW LEVEL (3³ neighbourhood hits) ────────────────");
for (const r of R.scan ?? []) {
  console.log(`  ${String(r.surf).padEnd(14)} p[${r.p.join(", ")}] n[${r.n.join(", ")}]  levels [${r.occ.join(", ")}]`);
}
console.log(`  window levels ${R.levels} · occupied voxels per level [${(R.levelCensus ?? []).join(", ")}]`);
console.log(`  window: ${JSON.stringify(R.win).slice(0, 900)}`);
console.log(`  cache control: ${JSON.stringify(R.cacheCtl)}`);
console.log(`  v0 ${f(R.v0, 4)} m · cacheSmooth ${R.gather.cacheSmooth} · coldFill ${R.gather.coldFill} · ` +
  `shadeProb ${R.gather.shadeProb} · nCap ${R.gather.nCap} · skyRays ${R.gather.skyRays} · worldProbes ${R.gather.worldProbes}`);
await browser.close();
