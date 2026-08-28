// GI2 BAND PROBE — §19 Stage 4.12: WHAT BAND DOES A COARSE PROBE ACTUALLY PAY?
//
// ══ THE QUESTION, AND WHY NO EXISTING INSTRUMENT ASKS IT ═════════════════════
//
// §3.15's ownership rule says cascade `i` traces `[t_i, t_{i+1})` — its OWN
// band — and defers everything nearer to the finer cascade whose LATTICE
// contains it. `worldProbes.js` implements that as
//
//     coveredBelow = casc > 0 && inLatticeAt(originOf(casc-1), floor(pos/sp_{casc-1}))
//     t0           = coveredBelow ? tStart[casc] : 0
//
// — a test of GEOMETRIC CONTAINMENT. §AH.2 measured the hole that opens under
// it: at `DARK2`, 31 m out, `c0 cov 0.00 · c1 cov 0.03 · c2 cov 1.00`. c1's
// lattice CONTAINS the point (it is a 64 m cube and the point is 31 m out) so
// c2 defers `[0, 20)` to it — but c1 has essentially no LIVE probe there, so
// the deferral is to nobody. The pixel is answered at full claim by a map that
// begins twenty metres away, and a wall one metre from that probe is invisible
// to it. Dark, flat, and exactly the shape the pinned profile shows.
//
// Every existing instrument is blind to it. `probe:gi2-ref` reads the FIELD
// (SH, oct radiance, `V_probe`) and can say a probe is dark; it cannot say
// WHICH RANGE OF DISTANCES the probe was allowed to see. That is a property of
// the trace's classification, not of the value it stored, and it lives in two
// places this probe reads and nothing else does:
//
//   · `wpOct` word 1's MOMENTS — the TRUE first-hit distance from the probe,
//     near hits included (§3.15 stores it unconditionally, precisely so the
//     Chebyshev test stays meaningful), and its `T` bit.
//   · `wpOct` word 2 — the probe's OWN radiance under `SPLIT_OWN`, which a
//     `blockedNear` texel writes as EXACTLY ZERO.
//
// So a texel with `own == 0`, `T == 0` and a stored first hit BELOW `t0` is a
// direction whose light was measured and then thrown away. Counting them, by
// cosine-weighted solid angle, IS the missing near field — as a number.
//
// ══ WHAT IT PRINTS ═══════════════════════════════════════════════════════════
//
//   1. PER PINNED POINT (the same `scripts/gi2-ref-pins.json` set the reference
//      receipt uses, so the two are talking about the same places): for every
//      cascade that covers it, the cascade's coverage, its answering probe, the
//      `t0` that probe traced with, whether the FINER lattice merely CONTAINS
//      the probe or actually has live probes around it, and the discarded
//      near-band share.
//   2. THE LATTICE-WIDE CENSUS: over every live probe of every cascade above
//      c0, how many defer their near band under containment while the finer
//      cascade's liveness-weighted coverage at their own position is below a
//      half — i.e. how many probes are handing `[0, t_i)` to nobody.
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//
// Run:  node scripts/run-gi2-band-probe.mjs            (both poses)
//       ONLY=b node scripts/run-gi2-band-probe.mjs
//
// Env: PROJECT · SCENE=Bistro · FRAMES=240 · ONLY=a|b · FLAGS · HEADED=1
import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const FRAMES = Number(process.env.FRAMES ?? 240);
const ONLY = (process.env.ONLY ?? "").toLowerCase();
const SCENE = process.env.SCENE ?? "Bistro";
const PINS = JSON.parse(readFileSync(new URL("./gi2-ref-pins.json", import.meta.url), "utf8"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : "—");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--js-flags=--expose-gc --max-old-space-size=8192",
  ],
});
const page = await browser.newPage();
page.setDefaultTimeout(600000);
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument(() => { globalThis.__gi2NoiseDump = true; });
await page.evaluateOnNewDocument((flags) => {
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, JSON.parse(process.env.FLAGS ?? "{}"));
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);
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
const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });
// ⚠ OPEN THE SCENE EXPLICITLY. A probe that measures whatever the editor
// happened to have open reads whatever the LAST probe left behind — this one's
// first battery run landed on a corridor rig and reported a lattice of eight
// c2 probes as if it were Bistro. Every other gi2 probe does this; so does this
// one now.
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
console.log(`
══ ${SCENE} — what band does a coarse probe pay? ═══════════════`);

const gatherFrame = () => page.evaluate(() => globalThis.__gi2()?.gather?.frame ?? 0);
const settleFrames = async (n, capMs = 300000) => {
  const f0 = await gatherFrame();
  const deadline = Date.now() + capMs;
  let fr = f0;
  while (fr - f0 < n && Date.now() < deadline) { await wait(400); fr = await gatherFrame(); }
  return fr - f0;
};

// ══════════════════════════════════════════════════ THE READBACK, ON THE PAGE
const bandAt = (pts) => page.evaluate(async ({ pts }) => {
  const eng = globalThis.__giEngineForProbe;
  const g = globalThis.__gi2().gather;
  if (!g?.world) return null;
  const w = g.world.describe();
  const { octTable } = await import("/src/modules/gi/window/gatherProbes.js");
  const OCT = w.oct; const OCTR = Math.round(Math.sqrt(OCT));
  const tbl = octTable(OCTR).map((v) => [v.x, v.y, v.z, v.w]);
  const OW = w.octWords;
  const NC = w.cascades; const C = w.cells; const CB = Math.log2(C); const CELLS = w.cellCount;
  const INFO_VEC = 12;
  const info = new Float32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpInfo.value));
  const oct = new Uint32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpOct.value));
  const org = g.world.origins.map((u) => [u.value.x, u.value.y, u.value.z]);
  const slotOf = (x, y, z) => ((x & (C - 1)) >>> 0) | (((y & (C - 1)) >>> 0) << CB)
    | (((z & (C - 1)) >>> 0) << (2 * CB));
  const inLat = (o, x, y, z) => [x - o[0], y - o[1], z - o[2]].every((v) => v >= 0 && v < C);
  const nOf = (word) => (word >>> 24) & 63;
  const tOf = (word) => (word >>> 30) & 1;
  const meanOf = (word, dmax) => (word & 4095) * dmax / 4095;
  const decode = (word) => {
    const e = (word >>> 24) - 128;
    const s = Math.pow(2, e) / 255;
    return [(word & 255) * s, ((word >>> 8) & 255) * s, ((word >>> 16) & 255) * s];
  };
  const live = (gc) => info[gc * INFO_VEC * 4 + 3] > 0.5;
  const posOf = (gc) => [info[gc * INFO_VEC * 4], info[gc * INFO_VEC * 4 + 1], info[gc * INFO_VEC * 4 + 2]];

  /** The liveness-weighted trilinear coverage of cascade `cc` at a world point. */
  const covAt = (cc, P) => {
    const sp = w.spacings[cc];
    const gp = P.map((v) => v / sp - 0.5);
    const b = gp.map(Math.floor);
    const fr = gp.map((v, k) => v - b[k]);
    let cov = 0; let best = null;
    for (let c8 = 0; c8 < 8; c8++) {
      const dx = c8 & 1, dy = (c8 >> 1) & 1, dz = (c8 >> 2) & 1;
      const rx = b[0] + dx, ry = b[1] + dy, rz = b[2] + dz;
      if (!inLat(org[cc], rx, ry, rz)) continue;
      const gc = cc * CELLS + slotOf(rx, ry, rz);
      if (!live(gc)) continue;
      const tri = (dx ? fr[0] : 1 - fr[0]) * (dy ? fr[1] : 1 - fr[1]) * (dz ? fr[2] : 1 - fr[2]);
      cov += tri;
      if (!best || tri > best.tri) best = { tri, gc };
    }
    return { cov, best };
  };

  /**
   * The band census of ONE probe's 64 texels.
   *
   * `near` — a stored first hit strictly below the `t0` this probe traced with,
   * with `own == 0` and `T == 0`: the trace saw geometry there, wrote radiance
   * zero because the interval rule said the finer cascade owns it, and marked
   * the direction OPAQUE so the parent cannot answer it either. That is light
   * that no cascade in the chain pays.
   */
  const census = (gc, cc, t0, N) => {
    const base = gc * OCT * OW;
    const dmax = w.distMax[cc];
    let nHas = 0; let nNear = 0; let nNearDark = 0; let nT = 0;
    let wAll = 0; let wNear = 0; let wNearDark = 0;
    let dMin = Infinity; let dSum = 0;
    for (let t = 0; t < OCT; t++) {
      const a = base + t * OW;
      const w1 = oct[a + 1];
      const e = tbl[t];
      const cw = N ? Math.max(0, e[0] * N[0] + e[1] * N[1] + e[2] * N[2]) * e[3] : e[3];
      if (!(nOf(w1) > 0)) continue;
      nHas++; wAll += cw;
      const d = meanOf(w1, dmax);
      const T = tOf(w1);
      if (T) { nT++; continue; }          // a clean miss — deferred to the parent
      dSum += d;
      if (d < dMin) dMin = d;
      if (d < t0 - 1e-3) {
        nNear++; wNear += cw;
        const own = decode(oct[a + (OW > 2 ? 2 : 0)]);
        if (own[0] + own[1] + own[2] < 1e-6) { nNearDark++; wNearDark += cw; }
      }
    }
    return {
      nHas, nNear, nNearDark, nT,
      minHit: Number.isFinite(dMin) ? +dMin.toFixed(2) : null,
      meanHit: nHas - nT > 0 ? +(dSum / (nHas - nT)).toFixed(2) : null,
      // the cosine-weighted solid-angle share the interval rule discarded
      shareNear: wAll > 1e-6 ? +(wNear / wAll).toFixed(3) : 0,
      shareNearDark: wAll > 1e-6 ? +(wNearDark / wAll).toFixed(3) : 0,
    };
  };

  // ── per pinned point ────────────────────────────────────────────────────
  const rows = [];
  for (const pt of pts) {
    const per = [];
    for (let cc = 0; cc < NC; cc++) {
      const sp = w.spacings[cc];
      const bl = 0.3 * sp;
      const Pb = [0, 1, 2].map((k) => pt.P[k] + pt.N[k] * bl);
      const { cov, best } = covAt(cc, Pb);
      if (!best) { per.push({ cc, cov: +cov.toFixed(3), probe: null }); continue; }
      const pp = posOf(best.gc);
      // What the SHADER decided for this probe, recomputed from its own inputs.
      const fSp = w.spacings[Math.max(0, cc - 1)];
      const fc = pp.map((v) => Math.floor(v / fSp));
      const contained = cc > 0 && inLat(org[Math.max(0, cc - 1)], fc[0], fc[1], fc[2]);
      // §19 4.12's rule: the finer lattice must hold this probe's whole CELL
      // and must actually be LIVE there. `covBelow` of 0 is 3.15's rule.
      const lo = pp.map((v) => Math.floor((v - sp) / fSp));
      const hi = pp.map((v) => Math.floor((v + sp) / fSp));
      const o = org[Math.max(0, cc - 1)];
      const holds = cc > 0 && inLat(o, lo[0], lo[1], lo[2]) && inLat(o, hi[0], hi[1], hi[2]);
      const fCov = cc > 0 ? covAt(cc - 1, pp).cov : 1;
      const defers = holds && fCov >= (w.covBelow ?? 0.5);
      // ⚠ THE CENSUS IS ALWAYS TAKEN AGAINST 3.15's `t0`, WHETHER OR NOT THIS
      // BUILD DEFERS. That is what makes the column an A/B: the same set of
      // directions is counted in both arms, and `nearDark%` — how many of them
      // stored radiance ZERO — is the number the fix moves.
      const t0 = contained ? w.tStart[cc] : 0;
      per.push({
        cc, cov: +cov.toFixed(3),
        probe: {
          pos: pp.map((v) => +v.toFixed(2)),
          dist: +Math.hypot(pp[0] - pt.P[0], pp[1] - pt.P[1], pp[2] - pt.P[2]).toFixed(2),
          contained, defers, t0, finerCov: +fCov.toFixed(3),
          ...census(best.gc, cc, t0, pt.N),
        },
      });
    }
    rows.push({ tag: pt.tag, P: pt.P, per });
  }

  // ── the lattice-wide census ─────────────────────────────────────────────
  const lattice = [];
  for (let cc = 1; cc < NC; cc++) {
    const fSp = w.spacings[cc - 1];
    let nLive = 0; let nContained = 0; let nOrphan = 0;
    let shareSum = 0; let shareN = 0; let orphanShare = 0;
    for (let cell = 0; cell < CELLS; cell++) {
      const gc = cc * CELLS + cell;
      if (!live(gc)) continue;
      nLive++;
      const pp = posOf(gc);
      const fc = pp.map((v) => Math.floor(v / fSp));
      const contained = inLat(org[cc - 1], fc[0], fc[1], fc[2]);
      if (!contained) continue;
      nContained++;
      const fCov = covAt(cc - 1, pp).cov;
      const cs = census(gc, cc, w.tStart[cc], null);
      shareSum += cs.shareNearDark; shareN++;
      // ORPHANED — contained by the finer lattice's BOX while that lattice has
      // essentially nothing live here. Under 3.15 these deferred `[0, t_i)` to
      // nobody; under 4.12 they pay it themselves.
      if (fCov < 0.5) { nOrphan++; orphanShare += cs.shareNearDark; }
    }
    lattice.push({
      cc, spacing: w.spacings[cc], tStart: w.tStart[cc], nLive, nContained, nOrphan,
      meanDiscard: shareN ? +(shareSum / shareN).toFixed(3) : 0,
      orphanDiscard: nOrphan ? +(orphanShare / nOrphan).toFixed(3) : 0,
    });
  }
  return {
    rows, lattice, cascades: NC, spacings: w.spacings,
    tStart: w.tStart, tEnd: w.tEnd, splitOwn: w.splitOwn,
    covBelow: w.covBelow, thinT: w.thinT,
    cam: [eng.camera.position.x, eng.camera.position.y, eng.camera.position.z],
  };
}, { pts });

// ═════════════════════════════════════════════════════════════════════ THE RUN
for (const key of ["a", "b"]) {
  if (ONLY && ONLY !== key) continue;
  const P = PINS[key];
  if (!P?.pose) continue;
  console.log(`\n══ POSE ${key.toUpperCase()} ══════════════════════════════════════════`);
  await call("viewport.setCamera", { position: P.pose.position, target: P.pose.target });
  await settleFrames(FRAMES);
  const R = await bandAt(P.pts);
  if (!R) { console.log("  SKIP: no world lattice (screen-probe path?)"); continue; }
  console.log(`  cascades ${R.cascades}  spacings [${R.spacings.map((v) => f(v, 2))}]  ` +
    `bands [${R.tStart.map((v, i) => `${f(v, 1)}–${f(R.tEnd[i], 0)}`).join("  ")}]  ` +
    `splitOwn ${R.splitOwn}  covBelow ${R.covBelow}  thinT ${R.thinT}`);
  console.log("\n  ── PER PINNED POINT — the answering cascade's probe, and its band ──");
  console.log("  tag     cc  cov    dist   contained  defers  t0     finerCov  minHit  meanHit  " +
    "near%  nearDark%");
  for (const r of R.rows) {
    for (const p of r.per) {
      if (!p.probe) { if (p.cov > 0) console.log(`  ${r.tag.padEnd(7)} c${p.cc}  ${f(p.cov, 2)}   (no live corner)`); continue; }
      const b = p.probe;
      console.log(`  ${r.tag.padEnd(7)} c${p.cc}  ${f(p.cov, 2)}   ${f(b.dist, 2).padStart(5)}  ` +
        `${String(b.contained).padEnd(9)}  ${String(b.defers).padEnd(6)}  ` +
        `${f(b.t0, 1).padStart(5)}  ${f(b.finerCov, 3).padStart(8)}  ` +
        `${String(b.minHit ?? "—").padStart(6)}  ${String(b.meanHit ?? "—").padStart(7)}  ` +
        `${f(100 * b.shareNear, 1).padStart(5)}  ${f(100 * b.shareNearDark, 1).padStart(9)}`);
    }
  }
  console.log("\n  ── THE LATTICE-WIDE CENSUS ──");
  for (const L of R.lattice) {
    console.log(`  c${L.cc} (sp ${f(L.spacing, 1)} m, band starts ${f(L.tStart, 1)} m): ` +
      `${L.nLive} live, ${L.nContained} contained by c${L.cc - 1}'s lattice, ` +
      `of which ${L.nOrphan} ORPHANED (finer coverage < 0.5)`);
    console.log(`      mean discarded near-band share ${f(100 * L.meanDiscard, 1)} % of the ` +
      `sphere; over the orphans ${f(100 * L.orphanDiscard, 1)} %`);
  }
}
await browser.close();
