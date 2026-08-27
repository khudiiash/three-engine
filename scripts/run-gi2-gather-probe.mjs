// GI2 STAGE 3.1 — drives scripts/gi2-gather.html and arbitrates it against a
// CPU path tracer.
//
// The page can measure everything about itself EXCEPT whether the light is
// right. So the reference lives here: a small path tracer over the SAME
// analytic primitives, the SAME palette, the SAME sun/panel/sky the page
// uploaded — it receives them in the page's result, so the two cannot drift
// apart by someone editing one copy of the scene.
//
// It compares IRRADIANCE against IRRADIANCE at the crop's own world point and
// normal (which the page reports back from the gbuffer), not one composite
// against another: a composite folds in albedo, a tone curve and an exposure,
// and a ratio taken across those says nothing about the estimator.
//
// A browser with a real adapter is required — headless WebGPU has never worked
// in this repo, and a software adapter's timings would be a fiction the ray
// budgets then inherit.
//
// Run: node scripts/run-gi2-gather-probe.mjs [url]
//      TIER=high node scripts/run-gi2-gather-probe.mjs
//      TIER=phone,high,ultra …        (the default table)
//      GI2_OUT=<dir> …                (where the PNG lands; never the repo)
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/scripts/gi2-gather.html").replace(/\/$/, "");
const tiers = (process.env.TIER ?? "phone,high,ultra").split(",").map((t) => t.trim()).filter(Boolean);
const outDir = process.env.GI2_OUT ?? join(tmpdir(), "gi2-gather");

// ── the CPU reference ────────────────────────────────────────────────────────

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const mulv = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** A rotation, as its three COLUMNS — the form `windowFill.js` publishes. */
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const rot = (R, v) => [0, 1, 2].map((a) => R[0][a] * v[0] + R[1][a] * v[1] + R[2][a] * v[2]);
const rotT = (R, v) => [0, 1, 2].map((k) => R[k][0] * v[0] + R[k][1] * v[1] + R[k][2] * v[2]);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A path tracer over the page's analytic scene.
 *
 * The estimator mirrors the GPU's exactly where the GPU is exact and differs
 * only where the GPU approximates: direct light is next-event (sun by a shadow
 * ray, panel by one area sample), indirect is a cosine-sampled bounce to
 * `bounces` deep, and the sun is a DELTA direction so a bounce ray can never
 * hit it — the same reason the GPU's gather cannot double-count it.
 */
function makeReference(scene, palette, light, bounces = 4, R = IDENTITY) {
  const EPS = 1e-4;
  const panel = light.panel;
  const sunTo = norm(mul(light.sunDir, -1));
  // ⭐ §19 STAGE 3.9 — THE ROTATED ROOM IS INTERSECTED IN ITS OWN FRAME.
  //
  // `KIND_OBB` primitives (2) carry LOCAL `min`/`max` and the arm's rotation
  // turns them. Rather than write an OBB intersector, the RAY is turned into
  // that frame — `R` is orthonormal so `t` is the same number on both sides
  // and only the normal has to come back — and the world-space primitives (the
  // panel, the sphere) keep the intersector they already had. The two answers
  // are compared by `t`, which is the only comparison that means anything
  // across the two frames.
  const boxes = scene.filter((p) => p.kind !== 2).map((p, i) => ({ ...p, i }));
  const local = scene.filter((p) => p.kind === 2).map((p, i) => ({ ...p, kind: 0, i }));

  const intersectIn = (list, o, d) => {
    let bt = Infinity;
    let bn = null;
    let bp = -1;
    for (const p of list) {
      if (p.kind !== 1) {
        let t0 = -Infinity, t1 = Infinity, a0 = 0, a1 = 0, s0 = -1, s1 = 1;
        let miss = false;
        for (let a = 0; a < 3 && !miss; a++) {
          if (Math.abs(d[a]) < 1e-12) {
            if (o[a] < p.min[a] || o[a] > p.max[a]) miss = true;
            continue;
          }
          const inv = 1 / d[a];
          let tE, tX, nE, nX;
          if (inv >= 0) { tE = (p.min[a] - o[a]) * inv; tX = (p.max[a] - o[a]) * inv; nE = -1; nX = 1; }
          else { tE = (p.max[a] - o[a]) * inv; tX = (p.min[a] - o[a]) * inv; nE = 1; nX = -1; }
          if (tE > t0) { t0 = tE; a0 = a; s0 = nE; }
          if (tX < t1) { t1 = tX; a1 = a; s1 = nX; }
        }
        if (miss || t1 < t0 || t1 < EPS) continue;
        const useEntry = t0 > EPS;
        const t = useEntry ? t0 : t1;
        if (t >= bt || t < EPS) continue;
        bt = t;
        bn = [0, 0, 0];
        bn[useEntry ? a0 : a1] = useEntry ? s0 : s1;
        bp = p.pal;
      } else {
        const c = [0, 1, 2].map((a) => (p.min[a] + p.max[a]) / 2);
        const r = (p.max[0] - p.min[0]) / 2;
        const oc = sub(o, c);
        const b = dot3(oc, d);
        const cc = dot3(oc, oc) - r * r;
        const disc = b * b - cc;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        let t = -b - sq;
        if (t < EPS) t = -b + sq;
        if (t < EPS || t >= bt) continue;
        bt = t;
        bn = norm(sub(add(o, mul(d, t)), c));
        bp = p.pal;
      }
    }
    return bn ? { t: bt, n: bn, pal: bp } : null;
  };

  const intersect = local.length === 0
    ? (o, d) => intersectIn(boxes, o, d)
    : (o, d) => {
      const a = intersectIn(boxes, o, d);
      const b = intersectIn(local, rotT(R, o), rotT(R, d));
      if (b && (!a || b.t < a.t)) return { t: b.t, n: rot(R, b.n), pal: b.pal };
      return a;
    };

  const occluded = (o, d, tMax) => {
    const h = intersect(o, d);
    return h != null && h.t < tMax;
  };

  const directE = (p, n, rnd) => {
    let E = [0, 0, 0];
    const ndl = dot3(n, sunTo);
    if (ndl > 0 && !occluded(add(p, mul(n, EPS * 10)), sunTo, 1e5)) {
      E = add(E, mul(light.sunColor, ndl));
    }
    if (p[1] < panel.centre[1] - 0.02) {
      const q = [
        panel.centre[0] + (rnd() - 0.5) * 2 * panel.half[0],
        panel.centre[1],
        panel.centre[2] + (rnd() - 0.5) * 2 * panel.half[1],
      ];
      const wv = sub(q, p);
      const d2 = Math.max(1e-4, dot3(wv, wv));
      const dd = Math.sqrt(d2);
      const w = mul(wv, 1 / dd);
      const cosX = Math.max(0, dot3(n, w));
      const cosP = Math.max(0, w[1]); // the panel faces −Y
      if (cosX * cosP > 0 && !occluded(add(p, mul(n, EPS * 10)), w, dd - 1e-3)) {
        E = add(E, mul(panel.radiance, (cosX * cosP * panel.area) / d2));
      }
    }
    return E;
  };

  const basis = (n) => {
    const a = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t = norm([
      a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0],
    ]);
    const b = [
      n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0],
    ];
    return [t, b];
  };
  const cosineDir = (n, rnd) => {
    const [t, b] = basis(n);
    const r = Math.sqrt(rnd());
    const phi = 2 * Math.PI * rnd();
    const x = r * Math.cos(phi);
    const y = r * Math.sin(phi);
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    return norm(add(add(mul(t, x), mul(b, y)), mul(n, z)));
  };

  const radiance = (o, d, depth, rnd) => {
    const h = intersect(o, d);
    if (!h) return light.sky;
    const p = add(o, mul(d, h.t));
    const n = dot3(h.n, d) < 0 ? h.n : mul(h.n, -1);
    const e = palette[h.pal] ?? { albedo: [0, 0, 0], emissive: 0 };
    let L = [e.emissive, e.emissive, e.emissive];
    L = add(L, mulv(mul(e.albedo, 1 / Math.PI), directE(p, n, rnd)));
    if (depth + 1 < bounces) {
      const w = cosineDir(n, rnd);
      // (albedo/π) · π · L_in — the π of the cosine-pdf estimator cancels.
      L = add(L, mulv(e.albedo, radiance(add(p, mul(n, EPS * 10)), w, depth + 1, rnd)));
    }
    return L;
  };

  /** Incident irradiance at (p, n) — the quantity the resolve writes. */
  const irradiance = (p, n, spp, seed) => {
    const rnd = mulberry32(seed);
    const o = add(p, mul(n, EPS * 20));
    let E = [0, 0, 0];
    for (let s = 0; s < spp; s++) E = add(E, radiance(o, cosineDir(n, rnd), 0, rnd));
    return mul(E, Math.PI / spp);
  };

  return { intersect, irradiance, radiance };
}

// ── drive the page ───────────────────────────────────────────────────────────

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});

let failed = 0;
const table = [];
mkdirSync(outDir, { recursive: true });

for (const tier of tiers) {
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.stack ?? e.message}`));
  const target = `${url}${url.includes("?") ? "&" : "?"}tier=${encodeURIComponent(tier)}`;
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
    // §19 Stage 3.6 added ~1 000 frames of arms (six cumulative levers, the
    // panel-move re-convergence, the motion window and the cache σ) on top of
    // Stage 3.5's page, and at 1650×970 that is well past fifteen minutes on a
    // GPU this machine shares with another agent's probes.
    await page.waitForFunction("globalThis.__GI2_GATHER_RESULT__ !== undefined", { timeout: 5400000 });
    const r = await page.evaluate("globalThis.__GI2_GATHER_RESULT__");
    console.log(`── ${tier} ${"─".repeat(Math.max(0, 62 - tier.length))}`);
    if (r?.text) console.log(r.text.split("\n").map((l) => `  ${l}`).join("\n"));
    if (!r?.pass) {
      failed++;
      console.error(`  FAIL ${tier}: ${r?.error ?? "no result"}`);
      const noise = logs.filter((l) => /error|Error|fail/i.test(l)).slice(-8);
      if (noise.length) console.error(noise.map((l) => `    ${l}`).join("\n"));
      await page.close();
      continue;
    }

    if (r.png) {
      const file = join(outDir, `gi2-gather-${tier}.png`);
      writeFileSync(file, Buffer.from(r.png.split(",")[1], "base64"));
      console.log(`  image written to ${file}`);
      r.pngFile = file;
      delete r.png;
    }

    // ── Cornell parity against the CPU reference ─────────────────────
    //
    // ⭐ THE REFERENCE IS RUN AT THREE DEPTHS, and that is the whole
    // diagnostic. The GPU's cache holds, for a voxel face nothing has
    // injected, exactly a ONE-BOUNCE answer: albedo/π × (sun + panel NEE) +
    // emissive. Multibounce arrives only through `injectLitFrame` and the EMA.
    // So a gather that matches `b1` and misses `b4` is not a broken estimator,
    // it is a cache that has not finished feeding itself — and a gather that
    // misses `b1` IS a broken estimator. One ratio cannot tell those apart;
    // three can.
    const refs = {
      1: makeReference(r.scene, r.palette, r.light, 1),
      2: makeReference(r.scene, r.palette, r.light, 2),
      4: makeReference(r.scene, r.palette, r.light, 4),
    };
    // 81 pixels per crop × 64 spp — the page already averaged the 81 pixels
    // into one world point, so the samples are spent at that point instead.
    const SPP = 81 * 64;
    const parity = [];
    for (const c of r.cornell.crops) {
      if (!(c.samples > 0)) { parity.push({ name: c.name, diag: !!c.diag, skipped: "no gbuffer samples" }); continue; }
      const seed = 0x51ed + c.name.length * 7919;
      const E1 = refs[1].irradiance(c.pos, c.nrm, SPP, seed);
      const E2 = refs[2].irradiance(c.pos, c.nrm, SPP, seed);
      const E4 = refs[4].irradiance(c.pos, c.nrm, SPP, seed);
      parity.push({
        name: c.name, diag: !!c.diag, pos: c.pos, nrm: c.nrm, gpu: c.irr, ref: E4, ref1: E1, ref2: E2,
        ratio: lum(c.irr) / Math.max(1e-9, lum(E4)),
        ratio1: lum(c.irr) / Math.max(1e-9, lum(E1)),
        ratio2: lum(c.irr) / Math.max(1e-9, lum(E2)),
        perChannel: [0, 1, 2].map((i) => c.irr[i] / Math.max(1e-9, E4[i])),
      });
    }
    // ⭐ THE RECEIPT CROPS AND THE INSTRUMENT CROPS ARE SCORED APART. Stage
    // 3.2 added a wall ladder and a sphere-crescent sample to DIAGNOSE items 3
    // and 4; folding them into "6 of 8 bracketed" would silently redefine the
    // gate every time the instrument grows a row. They are path-traced and
    // printed exactly the same way, and counted nowhere.
    const scoredRows = parity.filter((p) => !p.diag);
    const within = scoredRows.filter((p) => !p.skipped && Math.abs(p.ratio - 1) <= 0.15).length;
    const within1 = scoredRows.filter((p) => !p.skipped && Math.abs(p.ratio1 - 1) <= 0.15).length;
    const within2 = scoredRows.filter((p) => !p.skipped && Math.abs(p.ratio2 - 1) <= 0.15).length;
    // A crop that sits BETWEEN one and four bounces is a gather that is
    // integrating correctly over a cache that has not yet fed itself all the
    // way. A crop outside that bracket is something else, and that is the
    // distinction worth counting.
    const bracketed = scoredRows.filter((p) => !p.skipped && p.ratio <= 1.15 && p.ratio1 >= 0.85).length;
    const scored = scoredRows.filter((p) => !p.skipped).length;
    r.parity = { spp: SPP, rows: parity, within, within1, within2, bracketed, scored };
    console.log("");
    console.log(`  CORNELL PARITY (GPU irradiance ÷ CPU path tracer, ${SPP} spp)`);
    console.log("  crop          GPU E (rgb)                 ref E, 4 bounces            /b4      /b2      /b1     per-channel (b4)");
    for (const p of parity.filter((x) => !x.diag)) {
      if (p.skipped) { console.log(`  ${p.name.padEnd(13)} ${p.skipped}`); continue; }
      console.log(
        `  ${p.name.padEnd(13)}${p.gpu.map((v) => v.toFixed(3).padStart(8)).join("")}   ` +
        `${p.ref.map((v) => v.toFixed(3).padStart(8)).join("")}   ` +
        `${p.ratio.toFixed(3).padStart(6)}   ${p.ratio2.toFixed(3).padStart(6)}   ${p.ratio1.toFixed(3).padStart(6)}   ` +
        `${p.perChannel.map((v) => v.toFixed(2)).join("/")}`,
      );
    }
    console.log(`  within 15 %: ${within}/${scored} against 4 bounces, ${within2}/${scored} against 2, ` +
      `${within1}/${scored} against 1; ${bracketed}/${scored} sit inside the [1-bounce, 4-bounce] bracket`);
    const diagRows = parity.filter((x) => x.diag && !x.skipped);
    if (diagRows.length) {
      console.log("");
      console.log(`  INSTRUMENT CROPS (not scored) — item 3/4 diagnostics`);
      for (const p of diagRows) {
        console.log(
          `  ${p.name.padEnd(13)}${p.gpu.map((v) => v.toFixed(3).padStart(8)).join("")}   ` +
          `${p.ref.map((v) => v.toFixed(3).padStart(8)).join("")}   ` +
          `${p.ratio.toFixed(3).padStart(6)}   ${p.ratio2.toFixed(3).padStart(6)}   ${p.ratio1.toFixed(3).padStart(6)}`,
        );
      }
    }
    // ── THE TEXEL DUMP: the probe's own oct map, direction by direction ──
    //
    // ⭐ A CROP RATIO SAYS "DARK". IT NEVER SAYS "BLOCKED BY WHAT". The page
    // ships the whole 64-texel map of the dominant probe on each crop that is
    // still wrong — direction, stored hit distance, stored radiance — and the
    // reference intersects the SAME 64 directions from the SAME point against
    // the ANALYTIC geometry. A ray the GPU stopped at 0.3 m where the true
    // surface is 8 m away has been stopped by something that is not in the
    // scene, and the only thing in the window that is not in the scene is the
    // conservative voxelization's own thickness.
    if (r.texelDump?.length) {
      console.log("");
      console.log("  TEXEL DUMP — the GPU's oct map against the analytic geometry, per direction");
      r.texelDumpReport = [];
      for (const d of r.texelDump) {
        const rnd = mulberry32(0x51ed);
        const o = [0, 1, 2].map((i) => d.pos[i] + d.nrm[i] * 1e-3);
        const rows = d.texels.map((t) => {
          const h = refs[4].intersect(o, t.dir);
          return {
            ...t,
            trueDist: h ? h.t : Infinity,
            refL: lum(refs[4].radiance(o, t.dir, 0, rnd)),
          };
        });
        const phantom = rows.filter((x) => x.dist < 1 && x.trueDist > 2);
        const gpuMean = rows.reduce((a, x) => a + x.L, 0) / Math.max(1, rows.length);
        const refMean = rows.reduce((a, x) => a + x.refL, 0) / Math.max(1, rows.length);
        console.log(`  ${d.name}: probe ${d.probe} at ${d.pos.map((v) => v.toFixed(3)).join(",")} ` +
          `n ${d.nrm.map((v) => v.toFixed(2)).join(",")} — ${rows.length} filled texels`);
        console.log(`    mean stored radiance ${gpuMean.toFixed(4)} vs reference ${refMean.toFixed(4)} ` +
          `= ${(gpuMean / Math.max(1e-9, refMean)).toFixed(3)}×; ` +
          `${phantom.length}/${rows.length} texels stopped under 1 m where the geometry is over 2 m away`);
        const worst = rows.slice().sort((a, b) => (b.refL - b.L) - (a.refL - a.L)).slice(0, 8);
        console.log("    dir (x,y,z)              gpu d    true d     gpu L     ref L");
        for (const x of worst) {
          console.log(`    ${x.dir.map((v) => v.toFixed(2).padStart(6)).join(",")}  ` +
            `${x.dist.toFixed(2).padStart(7)}  ${(x.trueDist === Infinity ? "sky" : x.trueDist.toFixed(2)).padStart(7)}  ` +
            `${x.L.toFixed(4).padStart(8)}  ${x.refL.toFixed(4).padStart(8)}`);
        }
        r.texelDumpReport.push({
          name: d.name, gpuMean, refMean, ratio: gpuMean / Math.max(1e-9, refMean),
          phantom: phantom.length, filled: rows.length,
        });
      }
    }
    if (r.exhausted) {
      const e = r.exhausted;
      console.log("");
      console.log(`  EXHAUSTED RAYS: ${e.rays}/${e.traced} = ${e.pct.toFixed(2)} % — ` +
        Object.entries(e.classes).map(([k, v]) => `${k} ${v}`).join(", ") + ` (of ${e.recorded} recorded)`);
    }
    // ══ §19 STAGE 3.11a — GRAIN UNDER MOTION ═══════════════════════════════
    //
    // ⭐⭐ THE ORBIT COLUMN IS THE SUBJECT AND THE REST COLUMN IS ITS NULL.
    // A sign-flip rate means nothing on its own — the same instrument has to
    // read ~0 on a parked camera, or it is measuring itself. Both are printed
    // for every arm, from one page load, on the same pose sequence.
    if (r.motionGrain?.arms?.length) {
      console.log("");
      console.log(`  §19 3.11a GRAIN, per pixel against its own REPROJECTED previous value ` +
        `(${r.motionGrain.frames} frames)`);
      // ⚠ `flip%` IS CONDITIONED ON `moved`, so it is only readable BESIDE
      // `moved%`: an arm that freezes most of the image reports flips over the
      // minority that is left, and a rate over a shrinking denominator is the
      // censoring trap. Δp50/Δp95 are uncensored and are the headline.
      console.log("  arm                  stick%  ORBIT px: Δp50    Δp95  flip%  moved%  |  ORBIT probe RAW SH:" +
        "  Δp50    Δp95  flip%  moved%  |  REST px Δp95");
      for (const a of r.motionGrain.arms) {
        const f = (x, d = 2) => (x == null ? "—" : (100 * x).toFixed(d));
        const p = (x, d = 1) => (x == null ? "—" : x.toFixed(d));
        const q = a.orbit.probe ?? {};
        console.log(
          `  ${a.arm.padEnd(20)}${p(a.stickPct).padStart(6)}` +
          `${f(a.orbit.p50).padStart(15)} ${f(a.orbit.p95).padStart(7)} ${p(a.orbit.flipPct).padStart(6)} ` +
          `${p(a.orbit.movedPct).padStart(7)}  |${f(q.p50).padStart(22)} ${f(q.p95).padStart(7)} ` +
          `${p(q.flipPct).padStart(6)} ${p(q.movedPct).padStart(7)}  |${f(a.rest.p95).padStart(14)}`,
        );
      }
    }
    // ══ §19 STAGE 3.11 — THE TRIM ARM, AGAINST ITS OWN PATH TRACER ═════════
    //
    // ⭐⭐ THE PAIRING IS THE RECEIPT. Each sub-voxel crop is printed beside the
    // FLAT crop on the same surface at the same height, and what is gated is
    // the ratio of their ratios: a room that is uniformly dim moves both and
    // says nothing, while a blob moves only one. The reference is the same
    // tracer the flat room uses, over the primitive list the page actually
    // voxelized — the trim features cannot be a second description of
    // themselves.
    if (r.trim?.crops?.length) {
      const refs = {
        1: makeReference(r.trim.scene, r.palette, r.light, 1),
        4: makeReference(r.trim.scene, r.palette, r.light, 4),
      };
      const rows = [];
      for (const c of r.trim.crops) {
        if (!(c.samples > 0)) { rows.push({ name: c.name, skipped: "no gbuffer samples" }); continue; }
        const seed = 0x51ed + c.name.length * 7919;
        const E1 = refs[1].irradiance(c.pos, c.nrm, SPP, seed);
        const E4 = refs[4].irradiance(c.pos, c.nrm, SPP, seed);
        rows.push({
          name: c.name, pair: c.pair, gpu: c.irr, ref: E4,
          ratio: lum(c.irr) / Math.max(1e-9, lum(E4)),
          ratio1: lum(c.irr) / Math.max(1e-9, lum(E1)),
        });
      }
      console.log("");
      console.log(`  §19 3.11 TRIM ARM (${r.trim.frames} frames, ${r.trim.taps} taps, ${SPP} spp reference)`);
      console.log("  crop            GPU E (rgb)                 ref E, 4 bounces            /b4      /b1    vs its flat pair");
      for (const p of rows) {
        if (p.skipped) { console.log(`  ${p.name.padEnd(15)} ${p.skipped}`); continue; }
        const pr = p.pair ? rows.find((q) => q.name === p.pair) : null;
        const rel = pr && !pr.skipped ? (p.ratio / Math.max(1e-9, pr.ratio)) : null;
        console.log(
          `  ${p.name.padEnd(15)}${p.gpu.map((v) => v.toFixed(3).padStart(8)).join("")}   ` +
          `${p.ref.map((v) => v.toFixed(3).padStart(8)).join("")}   ` +
          `${p.ratio.toFixed(3).padStart(6)}  ${p.ratio1.toFixed(3).padStart(6)}   ` +
          (rel == null ? "      —" : `${rel.toFixed(3).padStart(6)} of ${p.pair}`),
        );
      }
      const flat = rows.filter((p) => !p.skipped && !p.pair);
      const trimmed = rows.filter((p) => !p.skipped && p.pair);
      const lo = Math.min(...flat.map((p) => p.ratio));
      const hi = Math.max(...flat.map((p) => p.ratio));
      // THE GATE: every sub-voxel crop inside the bracket the FLAT crops of the
      // same room span. The bracket is measured, not asserted — a room whose
      // flat crops sit at 0.6-0.8 of a path tracer sets a 0.6-0.8 bar for its
      // recesses, and the blob is a crop that is BELOW its own room.
      const out = trimmed.filter((p) => p.ratio < lo * 0.9);
      console.log(`  flat crops span ${lo.toFixed(3)}–${hi.toFixed(3)} of the 4-bounce reference; ` +
        `sub-voxel crops ${trimmed.map((p) => `${p.name} ${p.ratio.toFixed(3)}`).join(", ")}`);
      console.log(`  TRIM GATE: ${trimmed.length - out.length}/${trimmed.length} sub-voxel crops inside ` +
        `the flat bracket` + (out.length ? ` — OUT: ${out.map((p) => p.name).join(", ")}` : ""));
      if (r.trim.leak) {
        const L = r.trim.leak;
        console.log(`  5 cm-wall leak on the CONTACT RULE: ${L.escaped}/10000 escaped ` +
          `(${L.plain} of them without the rule firing) | ${L.contact} in the band, ${L.seen} the screen ` +
          `could see, ${L.cleared} it vouched for | CONTROL (authority forced) ${L.control}/10000 ` +
          `= ${(L.control / 100).toFixed(1)} %`);
      }
      const stC = r.trim.stats ?? {};
      r.trimReport = {
        rows, flatLo: lo, flatHi: hi, out: out.map((p) => p.name), leak: r.trim.leak,
        contactPct: 100 * (stC.contactBand ?? 0) / Math.max(1, stC.raysTraced ?? 1),
        contPct: 100 * (stC.contactCont ?? 0) / Math.max(1, stC.raysTraced ?? 1),
        gates: {
          inBracket: out.length === 0,
          leak: (r.trim.leak?.escaped ?? 999) === 0,
          leakControl: (r.trim.leak?.control ?? 0) >= 9000,
        },
      };
      console.log(`  3.11 gates: ` + Object.entries(r.trimReport.gates)
        .map(([k, v]) => `${k} ${v ? "PASS" : "FAIL"}`).join("  "));
      if (Object.values(r.trimReport.gates).some((v) => !v)) failed++;
    }
    if (r.hzbAB) {
      console.log("");
      console.log(`  HZB screen segment, on / off: ` +
        r.hzbAB.filter((x) => !/^wall@|^sphereEdge/.test(x.name))
          .map((x) => `${x.name} ${x.ratio.toFixed(3)}`).join(", "));
    }
    if (r.resolveScaleAB) {
      const sc = r.resolveScaleAB.filter((x) => !x.diag && x.full > 1e-3);
      const w = sc.reduce((a, x) => (Math.abs(x.ratio - 1) > Math.abs(a.ratio - 1) ? x : a));
      console.log(`  RESOLVE SCALE A/B (half-res + 2×2 upsample ÷ full res): worst ${w.name} ` +
        `${((w.ratio - 1) * 100).toFixed(2)} % — ` + sc.map((x) => `${x.name} ${x.ratio.toFixed(3)}`).join(", "));
    }
    if (r.resolveAB) {
      const worst = r.resolveAB.filter((x) => !x.diag && x.oct > 1e-3)
        .reduce((a, x) => (Math.abs(x.ratio - 1) > Math.abs(a.ratio - 1) ? x : a));
      console.log(`  RESOLVE A/B (SH2 / oct sum): worst receipt crop ${worst.name} ` +
        `${((worst.ratio - 1) * 100).toFixed(2)} % — ` +
        r.resolveAB.filter((x) => !x.diag).map((x) => `${x.name} ${x.ratio.toFixed(3)}`).join(", "));
    }

    // ══ §19 STAGE 3.9 — THE ROTATED ROOM, AGAINST ITS OWN REFERENCE ═══════
    //
    // ⭐⭐ THE SAME PATH TRACER, TURNED. Each world reports the primitive list
    // the fill actually voxelized and the rotation the kernel actually held, so
    // the reference cannot be a second description of the room that drifts from
    // it; and each world runs the attribution rule OFF and ON, so the "before"
    // in this receipt is the same binary at the same pose and not a memory of
    // an earlier commit.
    //
    // The GATE is a comparison of RATIOS and not of radiances. A turned room's
    // absolute irradiance differs (the panel does not turn with it, the walls
    // meet the light at different angles), so "the rotated arm is dimmer" says
    // nothing; "the rotated arm's GPU-over-reference ratio differs from the
    // axis-aligned room's by more than 5 %" says the estimator lost something
    // when the walls stopped agreeing with the grid, which is the whole claim.
    if (r.rotated?.worlds?.length) {
      const rotParity = (world, arm) => {
        const refs = {
          1: makeReference(world.scene, r.palette, { ...r.light, panel: world.panel }, 1, world.rot),
          4: makeReference(world.scene, r.palette, { ...r.light, panel: world.panel }, 4, world.rot),
        };
        const rows = [];
        for (const c of world.arms[arm].crops) {
          if (!(c.samples > 0)) { rows.push({ name: c.name, diag: !!c.diag, skipped: true }); continue; }
          const seed = 0x51ed + c.name.length * 7919;
          const E1 = refs[1].irradiance(c.pos, c.nrm, SPP, seed);
          const E4 = refs[4].irradiance(c.pos, c.nrm, SPP, seed);
          rows.push({
            name: c.name, diag: !!c.diag, gpu: c.irr, ref: E4,
            ratio: lum(c.irr) / Math.max(1e-9, lum(E4)),
            ratio1: lum(c.irr) / Math.max(1e-9, lum(E1)),
          });
        }
        const s = rows.filter((p) => !p.diag && !p.skipped);
        return {
          rows,
          scored: s.length,
          within: s.filter((p) => Math.abs(p.ratio - 1) <= 0.15).length,
          bracketed: s.filter((p) => p.ratio <= 1.15 && p.ratio1 >= 0.85).length,
        };
      };
      console.log("");
      console.log("  §19 STAGE 3.9 — ROTATED CORNELL (attribution off = 3.8's entry face, on = dominant face)");
      const rotTable = [];
      for (const world of r.rotated.worlds) {
        for (const arm of ["off", "on"]) {
          const par = rotParity(world, arm);
          const sp = world.arms[arm].split;
          const st = world.arms[arm].stats;
          rotTable.push({ world: world.name, arm, parity: par, split: sp, leak: world.leak, stats: st });
          const f = (x, d = 1) => (x == null || Number.isNaN(x) ? "—" : x.toFixed(d));
          console.log(
            `  ${`${world.name}/${arm}`.padEnd(12)} bracketed ${`${par.bracketed}/${par.scored}`.padStart(5)}  ` +
            `within15% ${`${par.within}/${par.scored}`.padStart(5)}  ` +
            `MIS-SLOTS ${f(sp.misPct).padStart(6)} % of ${String(sp.misN).padStart(5)} wall voxels, off by ` +
            `${f(sp.misErrPct, 0).padStart(5)} %  |  spread ${f(sp.spread).padStart(5)} %  ` +
            `open ${f(sp.dOpen).padStart(5)} %  buried ${f(sp.dBuried).padStart(5)} % ` +
            `(${f(100 * sp.buriedFrac, 0)} % of words)  six-bits ${f(sp.fullBitsPct, 0)} %  ` +
            `axis known ${f(sp.axKnownPct, 0)} % agree ${f(sp.axAgreePct, 0)} %  inject-mismatch ` +
            `${st.axisKnown ? (100 * st.axisMismatch / st.axisKnown).toFixed(1) : "—"} %`,
          );
        }
      }
      // ⭐⭐ DISTANCE FROM THE REFERENCE, NOT DISTANCE FROM ANOTHER ARM.
      //
      // The Δ gate asks whether a rotated room's ratio matches the axis-aligned
      // room's, and that question inherits BOTH arms' convergence state — which
      // is why its own null floor is several percent. The question the fix is
      // actually answerable on is `mean |ratio − 1|` over the flat crops: how
      // far the estimator sits from a path tracer, in one room, with the rule
      // off and on. It needs no second room to be meaningful and it cannot be
      // moved by the other arm's luck.
      // ⚠ THE SPHERE IS REPORTED AND NOT GATED, for a reason the fill states
      // outright: a sphere's normal turns through a hemisphere inside one voxel,
      // so `analyticVoxel` gives its voxels NO dominant axis and the rule under
      // test cannot apply to them. What its crop ratio does measure is how a
      // CURVED surface lands on the grid, and that is genuinely a different
      // quantity once the room stops being grid-aligned — a comparison across
      // rotations of a number the rotation redefines.
      const CURVED = new Set(["sphere"]);
      const meanErr = (row) => {
        const rows = row.parity.rows.filter((p) => !p.diag && !p.skipped && !CURVED.has(p.name));
        return rows.reduce((a, p) => a + Math.abs(p.ratio - 1), 0) / Math.max(1, rows.length);
      };
      console.log("  mean |ratio − 1| over the flat crops, attribution off → on:");
      for (const world of r.rotated.worlds) {
        const o = meanErr(rotTable.find((x) => x.world === world.name && x.arm === "off"));
        const n = meanErr(rotTable.find((x) => x.world === world.name && x.arm === "on"));
        console.log(`    ${world.name.padEnd(8)} ${(100 * o).toFixed(1)} % → ${(100 * n).toFixed(1)} % ` +
          `(${n <= o ? "closer to the reference" : "further"})`);
      }
      // The crop ratios themselves, off against on, per world — the receipt a
      // bracket count summarises away.
      console.log("  per-crop GPU ÷ 4-bounce reference, attribution off → on:");
      for (const world of r.rotated.worlds) {
        const off = rotTable.find((x) => x.world === world.name && x.arm === "off").parity.rows;
        const on = rotTable.find((x) => x.world === world.name && x.arm === "on").parity.rows;
        console.log(`    ${world.name.padEnd(8)} ` + on.filter((p) => !p.diag && !p.skipped).map((p, i) => {
          const o = off.filter((q) => !q.diag && !q.skipped)[i];
          return `${p.name} ${o.ratio.toFixed(2)}→${p.ratio.toFixed(2)}`;
        }).join("  "));
      }
      // The Δ gate: every scored crop of a rotated arm against the SAME crop of
      // the axis-aligned room, both with the rule ON and both at the same frame
      // count, so the comparison is the room's alignment and nothing else.
      const base = rotTable.find((x) => x.world === "axis" && x.arm === "on");
      const ratioOf = (row, name) => row.parity.rows.find((q) => q.name === name && !q.skipped)?.ratio;
      // ⭐⭐ THE Δ GATE NEEDS ITS OWN NULL, AND THE PAGE ALREADY RAN IT.
      //
      // The axis-aligned room's OFF and ON arms are the same room, the same
      // reference and a rule that provably does nothing there (0.0 % of its
      // wall voxels have a mis-attributed slot in EITHER arm). Whatever those
      // two arms differ by IS this instrument's own arm-to-arm spread — two
      // independent convergences with different random streams — and a 5 %
      // threshold read against a floor that has not been measured is a threshold
      // read against a hope. The gate is `max(5 %, the measured floor)`.
      const axOff = rotTable.find((x) => x.world === "axis" && x.arm === "off");
      const nulls = base.parity.rows.filter((p) => !p.diag && !p.skipped).map((p) => {
        const o = ratioOf(axOff, p.name);
        return o == null ? 0 : Math.abs((p.ratio - o) / Math.max(1e-9, o));
      });
      const floor = Math.max(...nulls, 0);
      const deltas = [];
      for (const row of rotTable.filter((x) => x.arm === "on" && x.world !== "axis")) {
        for (const p of row.parity.rows) {
          if (p.diag || p.skipped) continue;
          const b = ratioOf(base, p.name);
          if (b == null) continue;
          deltas.push({
            world: row.world, name: p.name, curved: CURVED.has(p.name),
            d: (p.ratio - b) / Math.max(1e-9, b),
          });
        }
      }
      const pick = (list) => list.reduce((a, x) => (Math.abs(x.d) > Math.abs(a.d) ? x : a),
        { d: 0, name: "—", world: "—" });
      const worst = pick(deltas.filter((x) => !x.curved));
      const worstCurved = pick(deltas.filter((x) => x.curved));
      const onRows = rotTable.filter((x) => x.arm === "on");
      const gates = {
        bracketed: onRows.every((x) => x.parity.bracketed === x.parity.scored),
        delta: Math.abs(worst.d) <= Math.max(0.05, floor),
        spread: onRows.filter((x) => x.world !== "axis").every((x) => (x.split.spread ?? 99) < 20),
        // ⭐ THE FIX'S OWN GATE: no wall voxel may carry a slot on an axis that
        // is not its own. The OFF arm is what says this gate can fail.
        misSlots: onRows.every((x) => (x.split.misPct ?? 99) <= 1),
        buried: onRows.filter((x) => x.world !== "axis").every((x) => (x.split.buriedFrac ?? 1) === 0),
        leak: r.rotated.worlds.every((w) => w.leak.sealed === 0 && w.leak.control >= 0.9 * w.leak.rays),
      };
      console.log(`  Δ vs the axis-aligned room (rule ON), flat crops: worst ${worst.world}/${worst.name} ` +
        `${(100 * worst.d).toFixed(2)} % against a gate of max(5 %, the axis room's own off↔on floor ` +
        `${(100 * floor).toFixed(2)} %) | curved, reported not gated: ${worstCurved.world}/${worstCurved.name} ` +
        `${(100 * worstCurved.d).toFixed(2)} %`);
      console.log(`  ` + r.rotated.worlds.map((w) => `${w.name} leak ${w.leak.sealed}/${w.leak.rays}, control ` +
        `${(100 * w.leak.control / w.leak.rays).toFixed(1)} %`).join(" | "));
      console.log(`  3.9 gates: ${Object.entries(gates).map(([k, v]) => `${k} ${v ? "PASS" : "FAIL"}`).join("  ")}`);
      r.rotatedReport = {
        table: rotTable, worstDelta: worst, worstCurved, floor, gates,
        frames: r.rotated.frames, taps: r.rotated.taps,
      };
      if (Object.values(gates).some((v) => !v)) failed++;
    }

    table.push({
      tier,
      rotated: r.rotatedReport,
      parity: { within, within1, within2, bracketed, scored, rows: parity },
      hzbAB: r.hzbAB,
      secondBounce: r.secondBounce,
      offScreen: r.offScreen,
      firstLight: r.firstLight,
      motion: r.motion,
      resolveAB: r.resolveAB,
      resolveScaleAB: r.resolveScaleAB,
      wallColumn: r.wallColumn,
      probeAudit: r.probeAudit,
      exhausted: r.exhausted,
      texelDump: r.texelDumpReport,
      mottlingArms: r.mottlingArms,
      levers: r.levers,
      panelMove: r.panelMove,
      motionNoise: r.motionNoise,
      motionGrain: r.motionGrain,
      trim: r.trimReport,
      cacheSigma: r.cacheSigma,
      reprojCensus: r.reprojCensus,
      kernels: r.kernels,
      gatherMs: r.gatherMs,
      chainMs: r.chainMs ?? r.gatherMs,
      image: r.image,
      stats: r.cornell?.stats,
      gather: r.gather,
    });
  } catch (err) {
    failed++;
    console.error(`  FAIL ${tier}: ${err.message}`);
    console.error(logs.slice(-15).map((l) => `    ${l}`).join("\n"));
  }
  await page.close();
}
await browser.close();

if (table.length) {
  console.log("");
  console.log("RECEIPTS — Stage 3.1");
  console.log("tier     b4    b2    b1   brkt   2nd bnc   off-scr   1st light 50/90   orbit/parked (paired)   reproj%   gather ms");
  for (const t of table) {
    const sb = t.secondBounce ? t.secondBounce.ratio.toFixed(3) : "—";
    const os = t.offScreen ? t.offScreen.ratio.toFixed(3) : "—";
    const fl = `${t.firstLight?.frame ?? "—"}/${t.firstLight?.frame90 ?? "—"}`;
    const mo = t.motion?.pooled ? `${t.motion.pooled.toFixed(2)}× (${t.motion.perPairRatio.map((x) => x.toFixed(2)).join("/")})` : "—";
    const rp = t.motion ? `${t.motion.reprojPct.toFixed(1)}` : "—";
    console.log(
      `${t.tier.padEnd(9)}${`${t.parity.within}/${t.parity.scored}`.padStart(4)}  ` +
      `${`${t.parity.within2}/${t.parity.scored}`.padStart(4)}  ` +
      `${`${t.parity.within1}/${t.parity.scored}`.padStart(4)}  ` +
      `${`${t.parity.bracketed}/${t.parity.scored}`.padStart(5)}  ` +
      `${sb.padStart(8)}  ${os.padStart(8)}  ${fl.padStart(16)}   ` +
      `${mo.padStart(22)}   ${rp.padStart(7)}   ${(t.gatherMs ?? 0).toFixed(3).padStart(9)}`,
    );
  }
  // ── §19 Stage 3.6: the noise, lever by lever ─────────────────────────────
  //
  // ⭐ THE ARMS ARE CUMULATIVE AND THE TABLE IS READ DOWNWARD. A lever that
  // does nothing is two rows that do not differ; a lever that undoes an
  // earlier one is a row that goes backwards. The two noise columns are
  // INDEPENDENT axes — a change that trades one for the other (a wider filter
  // buying spatial quiet with temporal lag, say) shows as one falling while
  // the other rises, which no single "noise" number could report.
  const pc = (v) => (v == null ? "    n/a" : `${(100 * v).toFixed(2)} %`.padStart(7));
  for (const t of table) {
    if (!t.levers?.length) continue;
    console.log("");
    console.log(`§19 STAGE 3.6 — NOISE, LEVER BY LEVER (${t.tier}, at rest, 30 frames per arm)`);
    console.log("arm                       temporal p50/p95   spatial p50/p95    reset%   reproj%  mature%  conv 50/90");
    for (const L of t.levers) {
      console.log(
        `${L.label.padEnd(24)}  ${pc(L.noise.temporal.p50)}/${pc(L.noise.temporal.p95)}  ` +
        `${pc(L.noise.spatial.p50)}/${pc(L.noise.spatial.p95)}  ` +
        `${L.alphaForcedPct.toFixed(2).padStart(7)}  ${L.reprojPct.toFixed(2).padStart(7)}  ` +
        `${L.maturePct.toFixed(1).padStart(6)}   ` +
        `${String(L.converge?.f50 ?? "—").padStart(3)}/${String(L.converge?.f90 ?? "—").padStart(3)}`,
      );
    }
    // ⭐⭐ §19 STAGE 3.10 — THE COLUMN THAT SEPARATES LAG FROM GRAIN.
    // σ/mean scores a monotone ramp and white noise identically; the sign of
    // the frame-to-frame delta does not. 0 % flips is light arriving late
    // (allowed), 50 % is grain (not). `still` is the share of scored pixels
    // that did not move at all beyond 1e-4 relative — on a deterministic
    // estimator over a settled cache that is the number that should read 100.
    console.log("arm                        still%   moved%   flip%   flip p50/p95");
    for (const L of t.levers) {
      const sg = L.noise.sign;
      if (!sg) continue;
      console.log(
        `${L.label.padEnd(24)}  ${(sg.stillPct ?? 0).toFixed(1).padStart(6)}  ` +
        `${(sg.movedPct ?? 0).toFixed(1).padStart(6)}  ` +
        `${(sg.flipRate == null ? NaN : 100 * sg.flipRate).toFixed(1).padStart(6)}  ` +
        `${pc(sg.flipP50)}/${pc(sg.flipP95)}`,
      );
    }
    const probeRows = t.levers.filter((L) => L.noise.shTemporal.n > 0);
    if (probeRows.length) {
      console.log("  probe SH DC (probe space, the same two axes):");
      for (const L of probeRows) {
        console.log(`    ${L.label.padEnd(22)} temporal ${pc(L.noise.shTemporal.p50)}/${pc(L.noise.shTemporal.p95)}  ` +
          `spatial ${pc(L.noise.shSpatial.p50)}/${pc(L.noise.shSpatial.p95)}`);
      }
    }
    console.log("  reprojection census, per arm (why a probe did NOT carry its history):");
    for (const L of t.levers) {
      console.log(`    ${L.label.padEnd(22)} ` + Object.entries(L.census)
        .map(([k, v]) => `${k} ${String(v).padStart(6)}`).join("  "));
    }
    if (t.panelMove) {
      console.log("  THE WORLD CHANGES — the emissive panel jumps 2 m:");
      for (const arm of [t.panelMove.shipped, t.panelMove.h8, t.panelMove.baseline]) {
        if (!arm) continue;
        console.log(`    ${arm.label.padEnd(20)} worst crop covers 90 % of the change in ` +
          `${arm.worstFrame ?? "never"} frames (locks at ${arm.worstLock ?? "never"}); mean fraction done ` +
          Object.entries(arm.done ?? {}).map(([i, v]) => `@${i} ${v == null ? "—" : `${(100 * v).toFixed(0)} %`}`).join(" "));
      }
    }
    if (t.motionNoise) {
      const m = t.motionNoise;
      console.log(`  UNDER MOTION: orbit sign — still ${(m.orbit.sign?.stillPct ?? 0).toFixed(1)} %, `
        + `moved ${(m.orbit.sign?.movedPct ?? 0).toFixed(1)} %, flips `
        + `${m.orbit.sign?.flipRate == null ? "n/a" : (100 * m.orbit.sign.flipRate).toFixed(1)} %`);
      console.log(`  UNDER MOTION: orbit temporal ${pc(m.orbit.temporal.p50)}/${pc(m.orbit.temporal.p95)} ` +
        `spatial ${pc(m.orbit.spatial.p50)}/${pc(m.orbit.spatial.p95)} (reproj ${m.reprojDuringOrbit.toFixed(1)} %); ` +
        `recovery after stopping — ` + (m.recovery ?? [m.after10]).map((r) => `+${r.at ?? 10} fr ` +
          `${pc(r.temporal.p50)}/${pc(r.temporal.p95)} temporal ${pc(r.spatial.p95)} spatial ` +
          `still ${(r.sign?.stillPct ?? 0).toFixed(1)} % flips ` +
          `${r.sign?.flipRate == null ? "n/a" : (100 * r.sign.flipRate).toFixed(1)} %`).join("; "));
    }
    if (t.cacheSigma) {
      const cs = t.cacheSigma;
      console.log(`  CACHE σ/mean at named faces over 30 frames: shipped median ${pc(cs.shipped?.median)} ` +
        `worst ${pc(cs.shipped?.worst)}; baseline median ${pc(cs.baseline?.median)} worst ${pc(cs.baseline?.worst)}`);
    }
  }

  console.log("");
  console.log("PER-KERNEL COST (ms at the page's resolve resolution, statsOn = 0)");
  const names = [...new Set(table.flatMap((t) => t.kernels.map((k) => k.name)))];
  console.log(`kernel        ${table.map((t) => t.tier.padStart(10)).join("")}   kB   storage  wg`);
  for (const n of names) {
    const row = table.map((t) => {
      const k = t.kernels.find((x) => x.name === n);
      return (k?.ms == null ? "n/a" : k.ms.toFixed(4)).padStart(10);
    }).join("");
    const k0 = table[0].kernels.find((x) => x.name === n);
    console.log(`${n.padEnd(14)}${row}   ${String(k0.kb).padStart(5)}   ${String(k0.storageBindings).padStart(7)}  ${k0.workgroupVars}`);
  }
  const worst = Math.max(...table.flatMap((t) => t.kernels.map((k) => k.storageBindings)));
  console.log(`storage buffers, worst kernel: ${worst} (envelope 6); no workgroup memory; WGSL scene-free`);

  // ── Stage 3.3's ≤ 4 ms budget lives at 1650×970, not at this page's size ──
  //
  // Every kernel in the chain is per-PIXEL or per-PROBE, and the probe grid is
  // the pixel grid divided by a tier constant — so the chain scales with the
  // pixel count and the scale factor is a ratio of areas, not a fit.
  console.log("");
  for (const t of table) {
    const px = (t.gather?.width ?? 0) * (t.gather?.height ?? 0);
    if (!px) continue;
    const k = (1650 * 970) / px;
    // ⭐ THE BUDGET IS THE CHAIN WITHOUT `composite`. That kernel is the
    // harness's stand-in for the engine's own shading of the resolved
    // irradiance (Stage 1.1's material hook, inside a raster draw that runs
    // anyway); the gather does not own it and must not be priced for it.
    console.log(`${t.tier}: chain ${(t.chainMs ?? 0).toFixed(3)} ms (+ composite ` +
      `${((t.gatherMs ?? 0) - (t.chainMs ?? 0)).toFixed(3)}) at ${t.gather.width}×${t.gather.height} ` +
      `→ ${((t.chainMs ?? 0) * k).toFixed(3)} ms scaled ×${k.toFixed(2)} to 1650×970 ` +
      `(Stage 3.3 budget ≤ 4 ms) ${(t.chainMs ?? 0) * k <= 4 ? "PASS" : "OVER"}`);
  }

  // ── the gate table, one line per Stage 3.1/3.2 receipt ────────────────────
  console.log("");
  console.log("GATES");
  for (const t of table) {
    const g = [];
    g.push(["2nd bounce ≥ 1.05", t.secondBounce?.ratio, (v) => v >= 1.05]);
    g.push(["off-screen ≥ 0.8", t.offScreen?.ratio, (v) => v >= 0.8]);
    g.push(["time to first light (90 %)", t.firstLight?.frame90, (v) => v != null]);
    g.push(["storage buffers ≤ 6", Math.max(...t.kernels.map((k) => k.storageBindings)), (v) => v <= 6]);
    g.push(["workgroup vars = 0", Math.max(...t.kernels.map((k) => k.workgroupVars)), (v) => v === 0]);
    g.push(["bracketed crops", t.parity.bracketed, (v) => v >= 6]);
    g.push(["orbit ÷ parked (paired)", t.motion?.pooled, (v) => v != null && v <= 1.2]);
    {
      const px = (t.gather?.width ?? 0) * (t.gather?.height ?? 0);
      const k = px ? (1650 * 970) / px : 0;
      g.push(["chain ms @1650×970 ≤ 4.0", (t.chainMs ?? 0) * k, (v) => v > 0 && v <= 4]);
    }
    if (t.resolveScaleAB) {
      const sc = t.resolveScaleAB.filter((x) => !x.diag && x.full > 1e-3);
      const w = sc.reduce((a, x) => (Math.abs(x.ratio - 1) > Math.abs(a.ratio - 1) ? x : a));
      g.push(["half-res resolve, worst ≤ 5 %", Math.abs(w.ratio - 1) * 100, (v) => v <= 5]);
    }
    if (t.exhausted) g.push(["exhausted rays, sealed room", t.exhausted.pct, (v) => v <= 0.5]);
    // ── §19 Stage 3.6's gates, scored on the SHIPPED arm (the last cumulative
    // lever), never on the arms that only exist to be compared against it.
    if (t.levers?.length) {
      // The SHIPPED arm is the last CUMULATIVE row — the rows whose label
      // starts with "·" are the alternatives each choice was measured against
      // and scoring a gate on one of those would score a thing we did not ship.
      const cumRows = t.levers.filter((L) => !L.label.startsWith("·"));
      const ship = cumRows.at(-1) ?? t.levers.at(-1);
      g.push(["noise: temporal p95 ≤ 1 %", 100 * (ship.noise.temporal.p95 ?? 9), (v) => v <= 1]);
      // §19 Stage 3.10: the noise gate proper. Whatever is left of the at-rest
      // temporal σ has to be a RAMP — a deterministic estimator over a cache
      // that is still filling — and a ramp does not change sign. 15 % leaves
      // room for the handful of pixels that sit on a converged plateau and
      // dither in the last bit of an f16 store; 50 % would be white noise.
      // ⚠ SCORED ON THE SETTLED WINDOW, NOT ON THE LADDER'S ROW. A lever arm
      // is measured 160 frames after the uniforms changed, and the world cache
      // has a time constant several times that — so the ladder's at-rest row
      // is always reading a cache re-converging from the PREVIOUS arm, which
      // is a transient and not the estimator. `motionNoise.recovery` at +100
      // frames is the same instrument over the SHIPPED arm after a long
      // settle, and that is the one this stage's claim is about.
      const rest = t.motionNoise?.recovery?.at(-1) ?? ship.noise;
      g.push(["at rest (settled): temporal p95 ≤ 0.3 %", 100 * (rest.temporal.p95 ?? 9), (v) => v <= 0.3]);
      // ⚠ `flipRate` IS NULL WHEN NOTHING MOVED AT ALL, WHICH IS THE BEST
      // POSSIBLE RESULT AND NOT A MISSING MEASUREMENT. The claim is scored as
      // a pair: a frozen image (`still` ≈ 100 %) passes with no flip rate to
      // report, and anything that does move has to move monotonically.
      g.push(["at rest (settled): still % ≥ 95", rest.sign?.stillPct ?? 0, (v) => v >= 95]);
      g.push(["at rest (settled): sign-flip ≤ 15 %",
        rest.sign?.flipRate == null ? 0 : 100 * rest.sign.flipRate, (v) => v <= 15]);
      g.push(["noise: spatial p95 ≤ 3 %", 100 * (ship.noise.spatial.p95 ?? 9), (v) => v <= 3]);
      g.push(["history resets at rest ≤ 0.5 %", ship.alphaForcedPct, (v) => v <= 0.5]);
      g.push(["reprojection at rest ≥ 99 %", ship.reprojPct, (v) => v >= 99]);
      g.push(["probe accumulator 90 % ≤ 60 fr", ship.converge?.f90 ?? 999, (v) => v <= 60]);
    }
    if (t.panelMove?.shipped) {
      g.push(["panel move re-converges ≤ 30 fr", t.panelMove.shipped.worstFrame ?? 999, (v) => v <= 30]);
    }
    if (t.motionNoise) {
      // §19 Stage 3.10's motion gate. The orbit's temporal σ is NOT a noise
      // number (a pixel that changes surface between frames has a σ made of
      // the scene — see the page's own warning), so what is gated under motion
      // is the SIGN rate: reinterpolation and parallax move a pixel smoothly,
      // grain does not.
      // ⚠ 35 %, AND THE BAR IS ARGUED RATHER THAN COPIED FROM THE AT-REST ONE.
      // A pixel under an orbiting camera changes SURFACE, so its value reverses
      // direction for reasons that are the scene and not the estimator — it
      // crosses a silhouette, a shadow edge, a colour boundary. What the number
      // still separates is a scene reversing at its own scale from white noise
      // reversing every frame: the 3.5 baseline reads 55 % at REST, i.e. the
      // orbit's honest ceiling is well under that.
      g.push(["orbit: sign-flip rate ≤ 35 %",
        t.motionNoise.orbit?.sign?.flipRate == null ? 999 : 100 * t.motionNoise.orbit.sign.flipRate,
        (v) => v <= 35]);
      g.push(["10 fr after stop: temporal ≤ 1 %", 100 * (t.motionNoise.after10.temporal.p95 ?? 9), (v) => v <= 1]);
      g.push(["10 fr after stop: spatial ≤ 3 %", 100 * (t.motionNoise.after10.spatial.p95 ?? 9), (v) => v <= 3]);
    }
    if (t.resolveAB) {
      const w = t.resolveAB.filter((x) => !x.diag && x.oct > 1e-3)
        .reduce((a, x) => (Math.abs(x.ratio - 1) > Math.abs(a.ratio - 1) ? x : a));
      g.push(["SH2 ÷ oct sum, worst ≤ 5 %", Math.abs(w.ratio - 1) * 100, (v) => v <= 5]);
    }
    for (const [name, value, ok] of g) {
      const v = typeof value === "number" ? value.toFixed(3) : String(value);
      console.log(`  ${t.tier.padEnd(7)} ${name.padEnd(28)} ${v.padStart(9)}  ${ok(value) ? "PASS" : "FAIL"}`);
    }
  }
}

process.exit(failed ? 1 : 0);
