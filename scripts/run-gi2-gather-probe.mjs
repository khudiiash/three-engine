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
function makeReference(scene, palette, light, bounces = 4) {
  const EPS = 1e-4;
  const panel = light.panel;
  const sunTo = norm(mul(light.sunDir, -1));
  const boxes = scene.map((p, i) => ({ ...p, i }));

  const intersect = (o, d) => {
    let bt = Infinity;
    let bn = null;
    let bp = -1;
    for (const p of boxes) {
      if (p.kind === 0) {
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
    await page.waitForFunction("globalThis.__GI2_GATHER_RESULT__ !== undefined", { timeout: 900000 });
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

    table.push({
      tier,
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
