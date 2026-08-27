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
      if (!(c.samples > 0)) { parity.push({ name: c.name, skipped: "no gbuffer samples" }); continue; }
      const seed = 0x51ed + c.name.length * 7919;
      const E1 = refs[1].irradiance(c.pos, c.nrm, SPP, seed);
      const E2 = refs[2].irradiance(c.pos, c.nrm, SPP, seed);
      const E4 = refs[4].irradiance(c.pos, c.nrm, SPP, seed);
      parity.push({
        name: c.name, pos: c.pos, nrm: c.nrm, gpu: c.irr, ref: E4, ref1: E1, ref2: E2,
        ratio: lum(c.irr) / Math.max(1e-9, lum(E4)),
        ratio1: lum(c.irr) / Math.max(1e-9, lum(E1)),
        ratio2: lum(c.irr) / Math.max(1e-9, lum(E2)),
        perChannel: [0, 1, 2].map((i) => c.irr[i] / Math.max(1e-9, E4[i])),
      });
    }
    const within = parity.filter((p) => !p.skipped && Math.abs(p.ratio - 1) <= 0.15).length;
    const within1 = parity.filter((p) => !p.skipped && Math.abs(p.ratio1 - 1) <= 0.15).length;
    const within2 = parity.filter((p) => !p.skipped && Math.abs(p.ratio2 - 1) <= 0.15).length;
    // A crop that sits BETWEEN one and four bounces is a gather that is
    // integrating correctly over a cache that has not yet fed itself all the
    // way. A crop outside that bracket is something else, and that is the
    // distinction worth counting.
    const bracketed = parity.filter((p) => !p.skipped && p.ratio <= 1.15 && p.ratio1 >= 0.85).length;
    const scored = parity.filter((p) => !p.skipped).length;
    r.parity = { spp: SPP, rows: parity, within, within1, within2, bracketed, scored };
    console.log("");
    console.log(`  CORNELL PARITY (GPU irradiance ÷ CPU path tracer, ${SPP} spp)`);
    console.log("  crop          GPU E (rgb)                 ref E, 4 bounces            /b4      /b2      /b1     per-channel (b4)");
    for (const p of parity) {
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
    if (r.hzbAB) {
      console.log(`  HZB screen segment, on / off: ` +
        r.hzbAB.map((x) => `${x.name} ${x.ratio.toFixed(3)}`).join(", "));
    }

    table.push({
      tier,
      parity: { within, within1, within2, bracketed, scored, rows: parity },
      hzbAB: r.hzbAB,
      secondBounce: r.secondBounce,
      offScreen: r.offScreen,
      firstLight: r.firstLight,
      motion: r.motion,
      kernels: r.kernels,
      gatherMs: r.gatherMs,
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
  console.log("tier     b4    b2    b1   brkt   2nd bnc   off-scr   1st light 50/90   orbit max/parked   reproj%   gather ms");
  for (const t of table) {
    const sb = t.secondBounce ? t.secondBounce.ratio.toFixed(3) : "—";
    const os = t.offScreen ? t.offScreen.ratio.toFixed(3) : "—";
    const fl = `${t.firstLight?.frame ?? "—"}/${t.firstLight?.frame90 ?? "—"}`;
    const mo = t.motion?.gatherOnlyRatio ? `${t.motion.gatherOnlyRatio.toFixed(2)}×` : "—";
    const rp = t.motion ? `${t.motion.reprojPct.toFixed(1)}` : "—";
    console.log(
      `${t.tier.padEnd(9)}${`${t.parity.within}/${t.parity.scored}`.padStart(4)}  ` +
      `${`${t.parity.within2}/${t.parity.scored}`.padStart(4)}  ` +
      `${`${t.parity.within1}/${t.parity.scored}`.padStart(4)}  ` +
      `${`${t.parity.bracketed}/${t.parity.scored}`.padStart(5)}  ` +
      `${sb.padStart(8)}  ${os.padStart(8)}  ${fl.padStart(16)}   ` +
      `${mo.padStart(16)}   ${rp.padStart(7)}   ${(t.gatherMs ?? 0).toFixed(3).padStart(9)}`,
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
}

process.exit(failed ? 1 : 0);
