// GI2 §19 — THE GROUND-TRUTH RECEIPT FOR DIFFUSE INDIRECT (`probe:gi2-ref`).
//
// ══ THE COMPLAINT THIS EXISTS TO ADJUDICATE ══════════════════════════════════
//
// User, 11:24, Bistro, `indirect` debug view, world-probe path: "got more
// stable, no motion noise, but it is still wrong". What the frames show is a
// FLAT field — the street-level façade reads as bright as the roofline, the
// narrow street as bright as open sky, the undersides of awnings and the arch
// barely darken. A Paris street of height/width ≈ 2 has a cosine-weighted sky
// view factor of ~0.3-0.4 at its base against ~1.0 at the top, so the indirect
// irradiance MUST fall 2-3× down a façade. "Flat" is not a matter of taste; it
// is a number that can be wrong, and until now nothing in this repo could say
// what the right number was for Bistro.
//
// ⭐⭐ EVERY EXISTING §19 REFERENCE IS ANALYTIC. `scripts/lib/gi2Reference.mjs`
// path-traces the FILL's primitive list — boxes, spheres, one panel — which is
// the Cornell rig and the 60 m corridor. It cannot be pointed at Bistro,
// because Bistro is not a list of boxes. So this probe adds the one reference
// the suite did not have: a cosine-hemisphere path trace against the ACTUAL
// TRIANGLE SOUP, the same `{tris, triPal, grid, cellRange, cellTris}` the
// voxelizer consumes, read out of `giSystem._gi2Shared.soup` on the main
// thread. Same triangles, same palette, same sun, same sky — it differs from
// GI2 in ONE respect, which is the whole point: it never voxelizes, never
// caches, never interpolates a probe. It integrates.
//
// ══ WHAT THE REFERENCE INCLUDES — EXACTLY ════════════════════════════════════
//
//   E_ref(p, n) = (π/N) · Σ_i L(p, ω_i),   ω_i cosine-distributed about n
//
//   L(p, ω) = MISS → skyColor                              (`u.skyColor`, flat)
//             HIT  → emissive[c] + albedo[c]/π · (E_sun + E_sky)   at the hit
//
//       E_sun = sunColor · max(0, m·toSun) · (1 − occluded)   one shadow ray
//       E_sky = (π/M) · Σ_j [ ω_j escapes → skyColor : 0 ]    M cosine rays
//
// ⚠ SO IT IS ONE BOUNCE, AND THE DIRECT SUN AT `p` IS NOT IN IT. That is not
// an approximation, it is the definition of the quantity under test:
// `gi2.textures.irradiance` is the INDIRECT field — GI2's `lit` composite
// carries no direct term at all, `giLight` multiplies the direct sun in
// separately — so a reference that included the sun at `p` would be measuring a
// different texture. What the reference and GI2 must agree about is: sky seen
// from `p`, plus everything that sky and sun bounce off on the way.
//
// ⚠ AND ONE BOUNCE IS A LOWER BOUND, deliberately. Multi-bounce adds energy, so
// a GI2 reading ABOVE this reference cannot be excused by "the reference is
// missing bounces"; a reading BELOW it might be. The direction of the bias is
// stated so the verdicts can respect it. `BOUNCE=2` re-runs with two.
//
// ══ THE THREE COLUMNS THAT NAME THE TERM ═════════════════════════════════════
//
// A ratio alone says "wrong", not "which term". So every point also carries the
// two SKY-VISIBILITY numbers, which is where a flat field has to come from:
//
//   V_ref   the truth: Σ over cosine rays that escape, / N. A pure geometric
//           fact about the point — 1.0 in the open, ~0.35 at a street base.
//   V_probe the same quantity AS THE WORLD PROBE HOLDS IT: over the covering
//           probe's 64 oct texels, the cosine-weighted solid-angle share whose
//           stored radiance IS `skyColor` (within 3 %). This is the sky the
//           delivered field is actually made of.
//
// ⭐⭐ THOSE TWO DECIDE (a). If `V_probe ≫ V_ref` the flatness is in the SKY
// TERM — sky credited where geometry blocks it, and the resolve/merge is
// letting it through. If `V_probe ≈ V_ref` and `E_gi2/E_ref` is still flat, the
// sky is occluded correctly and the excess is in the HIT radiances — the
// radiance cache's faces are too bright (the 3.17 cold-hit `max(shade,
// albedo·E_parent/π)` seeding faces from a parent that saw open sky, or a sun
// term on faces the sun cannot reach). The two cannot be confused, and neither
// can be argued from the picture.
//
// Plus, per point, the covering probe's own state — cascade, cell, `ready`,
// faced, texels with n > 0, texels still transparent (T = 1) after the merge,
// and E from the oct map against `shEval` of the stored SH — which is what
// answers (b), the black cell.
//
// ⚠ THE PROBE IS READ WHERE THE PIXEL IS, NOT WHERE IT IS CONVENIENT. The
// covering probe is the highest-weight LIVE corner of the finest cascade whose
// lattice contains the normal-biased sample point — the same choice the resolve
// makes — so "which probe lit this pixel" is answered by the same arithmetic
// that lit it.
//
// ══ THE POINTS ═══════════════════════════════════════════════════════════════
//
// ⭐ CHOSEN BY THE GBUFFER, NOT BY EYE. "Under the awning" cannot be named in
// Bistro (there is no awning entity, only `Bistro_Research_Exterior_*`), and a
// crop someone picked by eye is a crop that can be wrong about which plane it
// landed on. So every population is a PREDICATE over the stage dump:
//
//   FAC1..6   the screen column of wall pixels with the largest world-Y span
//             and a consistent normal — a façade column, top to bottom. THE
//             RATIO PROFILE DOWN THIS COLUMN IS THE HEADLINE.
//   SOFF1..3  n·up < −0.5: an underside. Awning soffits, the arch, table tops
//             seen from below — whatever the frame actually contains.
//   PAVE1..3  n·up > 0.9: open pavement.
//   DARK1..3  the lowest `E_gi2` luminance in the frame — the user's black
//             cell finds itself, wherever it is.
//   WDRK1..3  the lowest `E_gi2` among WALL pixels — window recesses.
//   WBRT1..2  the highest among walls — the roofline, the control.
//
// ══ RUN ══════════════════════════════════════════════════════════════════════
//
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//   npm run probe:gi2-ref
//
// ⚠ THE URL IS 5202, NEVER 5201 (this worktree has a private vite cache).
//
// Env: PROJECT · SCENE=Bistro · SETTLE=14 · FRAMES=240 · N=128 (primary rays)
//      M=8 (sky rays at the bounce) · BOUNCE=1 · POSE_A · POSE_B · ONLY=a|b
//      OUT · HEADED=1 · TMAX=200
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:5202/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const SETTLE = Number(process.env.SETTLE ?? 14);
const FRAMES = Number(process.env.FRAMES ?? 240);
const NSPP = Number(process.env.N ?? 128);
const MSPP = Number(process.env.M ?? 8);
const BOUNCE = Number(process.env.BOUNCE ?? 1);
const TMAX = Number(process.env.TMAX ?? 200);
const ONLY = (process.env.ONLY ?? "").toLowerCase();
const OUT = process.env.OUT ?? "";
/**
 * §19 5.4c — THE TERM ARMS. `ARMS=field,direct,noSky` names presets; anything
 * else is `name=uniform:value,uniform:value`, and a uniform whose value is a
 * `Vector3` (`skyColor`, `sunColor`) is set to `(v, v, v)`.
 *
 * ⭐ PRESETS, not raw uniform names, because the question each arm answers is
 * about a TERM and the term's uniform has moved twice already (`rcTermField`
 * did not exist before 5.3e). A preset that fails to resolve prints SKIPPED
 * with the missing uniform's name instead of silently measuring the baseline
 * a second time — the blind-instrument failure this suite keeps meeting.
 */
const ARM_PRESETS = {
  field: { rcTermField: 1, rcTermDirect: 0 },
  direct: { rcTermField: 0, rcTermDirect: 1 },
  // ⚠ `noSky`/`noSun` ARE NOT VIABLE AS UNIFORM ARMS ON A LIVE BOOT:
  // `GISystem.#tick` republishes `skyColor` from `sceneSkyRadiance` and
  // `sunColor` from the light every frame, so the write survives exactly one
  // tick and the arm measures the baseline a second time. They are kept
  // because the SKIPPED/equal reading is itself the receipt — an arm that
  // reads `share ≈ 0 %` here means the write was reverted, not that the term
  // is empty. The honest sky split is the reference's own `E_sky_p` /
  // `E_hit_p` columns, which are printed per point above.
  noSky: { skyColor: 0 },
  noSun: { sunColor: 0 },
};
const ARMS = (process.env.ARMS ?? "").split(/[,|]/).map((s) => s.trim()).filter(Boolean)
  .map((spec) => {
    if (!spec.includes("=") && ARM_PRESETS[spec]) {
      return { name: spec, sets: Object.entries(ARM_PRESETS[spec]).map(([k, v]) => ({ k, v })) };
    }
    const [name, body] = spec.includes("=") ? [spec.slice(0, spec.indexOf("=")), spec.slice(spec.indexOf("=") + 1)] : [spec, spec];
    return {
      name: name.trim(),
      sets: body.split(";").map((kv) => {
        const [k, v] = kv.split(":");
        return { k: k?.trim(), v: Number(v) };
      }).filter((s) => s.k),
    };
  });
const ARM_FRAMES = Number(process.env.ARM_FRAMES ?? 60);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const f = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : "—");
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
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
// ⭐ BEFORE BOOT. The GI2 arms (`__gi2ShClamp`, `__gi2Ratio`, `__gi2Cascades`)
// are read at BUILD time, so an A/B of any of them has to be set here and not
// after the gather exists — and the whole point of having them is that two arms
// can be measured in one tight window against ONE tree, rather than across two
// commits and an hour of somebody else's edits. `probe:gi2-runner` has had
// this hook since 4.7; this receipt needed it more.
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

console.log(`\n══ ${SCENE} — the ground-truth receipt ═══════════════════════`);
// ⭐⭐ §19 5.4c — THE CONTRACT, PRINTED. Every ratio below is a quotient of two
// quantities, and a reader who does not know what the DENOMINATOR contains
// cannot tell an energy bug from a definition mismatch. Both 5.2 gains were
// argued without this line on screen.
console.log("  CONTRACT — what E_gi2 must contain, in the reference's own convention:");
console.log("    · SKY as seen from p, occluded by the geometry            ✔ IN");
console.log("    · everything the sky and the sun BOUNCE off on the way     ✔ IN");
console.log("      (emitter direct AT A BOUNCE SURFACE is part of this)");
console.log("    · the emitter's direct term at p (seated lamps, NEE)       ✔ IN");
console.log("      ⚠ BUT THE REFERENCE CANNOT SEE A *SEATED* ONE: it shades a");
console.log("        hit from `gather.paletteEmissive`, and `#gi2SlotEmissive`");
console.log("        zeroes a promoted emitter's palette emission, so a scene");
console.log("        with slots needs the analytic seat term added to E_ref or");
console.log("        every ratio near a lamp is a DEFINITION mismatch, not a bug.");
console.log("        The palette-emission census is printed below — 0 emitters");
console.log("        makes this paragraph a provable no-op for this scene.");
console.log("    · the SUN's direct term at p                              ✘ OUT");
console.log("      (`giLight` multiplies it in separately; a field that");
console.log("       carried it would be measured against a different truth)");
console.log("    · bounces beyond the reference's BOUNCE (default 1)        ✘ OUT");
console.log("      → the reference is a LOWER BOUND; ratio > 1 needs a term,");
console.log("        ratio < 1 may be the missing bounces alone.");
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{ const dl = Date.now() + 240000; while (Date.now() < dl && !firstLight) await wait(250); }
console.log(`  first light ${firstLight ? "yes" : "NEVER"} — settling ${SETTLE}s`);
await wait(SETTLE * 1000);

// ═══════════════════════════════════════════════════ THE REFERENCE, IN THE PAGE
//
// It is installed ONCE and left on `globalThis.__gi2Ref`, because the soup is
// 200 MB of typed arrays and nothing about it may cross `page.evaluate`. Every
// later call is "trace this one point", which keeps each round trip short
// enough that a slow scene cannot trip the evaluate timeout.
const setup = await page.evaluate(async ({ tmax }) => {
  const sys = globalThis.__giSys();
  const gi2 = globalThis.__gi2();
  const soup = sys?._gi2Shared?.soup ?? null;
  if (!soup?.tris?.length) {
    return { ok: false, why: soup ? "soup arrays are detached (length 0)" : "no _gi2Shared.soup" };
  }
  const g = gi2.gather;
  const uv = (u) => {
    const v = u?.value;
    if (!v) return [0, 0, 0];
    return [v.x ?? v.r ?? 0, v.y ?? v.g ?? 0, v.z ?? v.b ?? 0];
  };
  const sky = uv(g.uniforms.skyColor);
  const sunC = uv(g.uniforms.sunColor);
  const sunD = uv(g.uniforms.sunDir);
  // The palette exactly as the shaders read it: `gather.palette` is the albedo
  // table `palAt` samples and `paletteEmissive` is `palEmU`, so the reference
  // shades a hit with the same two numbers `shadeTerms` multiplies.
  //
  // ⚠ THEY ARE `THREE.Vector4`, NOT `THREE.Color` (`setPalette` calls `.set(r,
  // g, b, lum)`). Reading `.r` off them yields `undefined`, which propagates as
  // a silent zero albedo and a reference with NO BOUNCE TERM AT ALL — measured
  // on this probe's first run, where every `E_ref` came back as exactly
  // `π·V·L_sky` and the fit to that formula is what exposed it.
  const alb = g.palette.map((c) => [c.x, c.y, c.z]);
  const emi = g.paletteEmissive.map((c) => [c.x, c.y, c.z]);

  const { tris, cellRange, cellTris } = soup;
  // ⚠ `triPal` IS ONE BYTE PER TRIANGLE, FOUR TO A `u32` (the worker's header
  // says so: `Uint32Array(ceil(triCount/4))`). Indexing it by triangle reads
  // four triangles' classes as one number, which lands outside the 63-entry
  // palette and shades every hit black.
  const triPalW = soup.triPal;
  const palOf = (t) => (triPalW[t >> 2] >>> ((t & 3) * 8)) & 255;
  const gO = soup.grid.origin; const gC = soup.grid.cell; const gD = soup.grid.dim;
  const nx = gD[0], ny = gD[1], nz = gD[2];
  const EPS = 1e-4;

  /**
   * Möller–Trumbore over one grid cell's triangle list, nearest hit only.
   * `best` is mutated in place: [t, pal, nx, ny, nz].
   */
  const testCell = (ci, ox, oy, oz, dx, dy, dz, best, tLimit) => {
    const s = cellRange[ci * 2];
    const n = cellRange[ci * 2 + 1];
    for (let k = 0; k < n; k++) {
      const t3 = cellTris[s + k];
      const o = t3 * 9;
      const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
      const e1x = tris[o + 3] - ax, e1y = tris[o + 4] - ay, e1z = tris[o + 5] - az;
      const e2x = tris[o + 6] - ax, e2y = tris[o + 7] - ay, e2z = tris[o + 8] - az;
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - ax, ty = oy - ay, tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < -1e-6 || u + v > 1 + 1e-6) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t <= EPS || t >= best[0] || t > tLimit) continue;
      best[0] = t;
      best[1] = palOf(t3);
      // Geometric normal, un-normalized here and normalized by the caller.
      best[2] = e1y * e2z - e1z * e2y;
      best[3] = e1z * e2x - e1x * e2z;
      best[4] = e1x * e2y - e1y * e2x;
    }
  };

  /**
   * 3D-DDA the uniform grid. Returns null on a miss, else the nearest hit.
   *
   * ⚠ A CELL'S TRIANGLES MAY EXTEND PAST IT, so the walk cannot stop at the
   * first cell that reports a hit — it stops when the accumulated `t` of the
   * cell boundary passes the best hit found so far, which is the standard
   * conservative exit and the only one that does not clip a triangle straddling
   * two cells.
   */
  const trace = (ox, oy, oz, dx, dy, dz, tMax) => {
    // Clip to the grid box.
    let t0 = 0; let t1 = tMax;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? ox : a === 1 ? oy : oz;
      const d = a === 0 ? dx : a === 1 ? dy : dz;
      const lo = gO[a]; const hi = gO[a] + (a === 0 ? nx : a === 1 ? ny : nz) * gC;
      if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) return null; continue; }
      let ta = (lo - o) / d; let tb = (hi - o) / d;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
    t0 = Math.max(t0, 0);
    const sx = ox + dx * (t0 + 1e-5);
    const sy = oy + dy * (t0 + 1e-5);
    const sz = oz + dz * (t0 + 1e-5);
    let ix = Math.min(nx - 1, Math.max(0, Math.floor((sx - gO[0]) / gC)));
    let iy = Math.min(ny - 1, Math.max(0, Math.floor((sy - gO[1]) / gC)));
    let iz = Math.min(nz - 1, Math.max(0, Math.floor((sz - gO[2]) / gC)));
    const stx = dx > 0 ? 1 : -1, sty = dy > 0 ? 1 : -1, stz = dz > 0 ? 1 : -1;
    const inf = 1e30;
    const dtx = Math.abs(dx) < 1e-12 ? inf : gC / Math.abs(dx);
    const dty = Math.abs(dy) < 1e-12 ? inf : gC / Math.abs(dy);
    const dtz = Math.abs(dz) < 1e-12 ? inf : gC / Math.abs(dz);
    const nb = (i, st, o0, oc) => (st > 0 ? gO[o0] + (i + 1) * gC : gO[o0] + i * gC);
    let tnx = Math.abs(dx) < 1e-12 ? inf : t0 + (nb(ix, stx, 0) - sx) / dx;
    let tny = Math.abs(dy) < 1e-12 ? inf : t0 + (nb(iy, sty, 1) - sy) / dy;
    let tnz = Math.abs(dz) < 1e-12 ? inf : t0 + (nb(iz, stz, 2) - sz) / dz;
    const best = [Infinity, 255, 0, 1, 0];
    let guard = 0;
    for (;;) {
      if (++guard > 4096) break;
      testCell(ix + nx * (iy + ny * iz), ox, oy, oz, dx, dy, dz, best, tMax);
      const tExit = Math.min(tnx, tny, tnz);
      if (best[0] <= tExit) break;
      if (tExit > t1) break;
      if (tnx <= tny && tnx <= tnz) { ix += stx; tnx += dtx; if (ix < 0 || ix >= nx) break; }
      else if (tny <= tnz) { iy += sty; tny += dty; if (iy < 0 || iy >= ny) break; }
      else { iz += stz; tnz += dtz; if (iz < 0 || iz >= nz) break; }
    }
    if (!Number.isFinite(best[0]) || best[0] > tMax) return null;
    const l = Math.hypot(best[2], best[3], best[4]) || 1;
    let hx = best[2] / l, hy = best[3] / l, hz = best[4] / l;
    if (hx * dx + hy * dy + hz * dz > 0) { hx = -hx; hy = -hy; hz = -hz; }
    return { t: best[0], pal: best[1], n: [hx, hy, hz] };
  };

  // Deterministic RNG — never Math.random in a receipt.
  const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  // Duff's branchless tangent frame — the SAME one `shadeTerms` uses, so a
  // difference between the two cannot be a frame difference.
  const frame = (n) => {
    const sgn = n[2] >= 0 ? 1 : -1;
    const a = -1 / (sgn + n[2]);
    const b = n[0] * n[1] * a;
    return [
      [1 + sgn * n[0] * n[0] * a, sgn * b, -sgn * n[0]],
      [b, sgn + n[1] * n[1] * a, -n[1]],
    ];
  };
  const cosDir = (n, t1, t2, r1, r2) => {
    const r = Math.sqrt(r1);
    const ph = 2 * Math.PI * r2;
    const x = r * Math.cos(ph), y = r * Math.sin(ph);
    const z = Math.sqrt(Math.max(0, 1 - r1));
    const d = [t1[0] * x + t2[0] * y + n[0] * z, t1[1] * x + t2[1] * y + n[1] * z,
      t1[2] * x + t2[2] * y + n[2] * z];
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / l, d[1] / l, d[2] / l];
  };

  const toSun = (() => {
    const l = Math.hypot(sunD[0], sunD[1], sunD[2]) || 1;
    return [-sunD[0] / l, -sunD[1] / l, -sunD[2] / l];
  })();

  /** Sun irradiance at (p, n) — one shadow ray, the estimator `shadeTerms` has. */
  const sunE = (p, n) => {
    const ndl = n[0] * toSun[0] + n[1] * toSun[1] + n[2] * toSun[2];
    if (ndl <= 0.001) return [0, 0, 0];
    const o = [p[0] + n[0] * 2e-3, p[1] + n[1] * 2e-3, p[2] + n[2] * 2e-3];
    if (trace(o[0], o[1], o[2], toSun[0], toSun[1], toSun[2], tmax)) return [0, 0, 0];
    return [sunC[0] * ndl, sunC[1] * ndl, sunC[2] * ndl];
  };

  /**
   * Cosine-sampled sky irradiance at (p, n) and the bare visibility with it.
   * A ray that HITS contributes zero — this is the terminal level of the path.
   */
  const skyE = (p, n, m, rnd) => {
    const [t1, t2] = frame(n);
    const o = [p[0] + n[0] * 2e-3, p[1] + n[1] * 2e-3, p[2] + n[2] * 2e-3];
    let miss = 0;
    for (let j = 0; j < m; j++) {
      const d = cosDir(n, t1, t2, (j + rnd()) / m, rnd());
      if (!trace(o[0], o[1], o[2], d[0], d[1], d[2], tmax)) miss++;
    }
    const v = miss / m;
    return { E: [sky[0] * Math.PI * v, sky[1] * Math.PI * v, sky[2] * Math.PI * v], v };
  };

  /** Outgoing radiance of the hit at (p, n) of class `c`, `depth` bounces left. */
  const outgoing = (p, n, c, depth, m, rnd) => {
    const a = alb[c] ?? [0, 0, 0];
    const e = emi[c] ?? [0, 0, 0];
    const Es = sunE(p, n);
    let Ek;
    if (depth <= 1) {
      Ek = skyE(p, n, m, rnd).E;
    } else {
      // A second bounce: the same estimator one level down, terminated by sky.
      const [t1, t2] = frame(n);
      const o = [p[0] + n[0] * 2e-3, p[1] + n[1] * 2e-3, p[2] + n[2] * 2e-3];
      const acc = [0, 0, 0];
      for (let j = 0; j < m; j++) {
        const d = cosDir(n, t1, t2, (j + rnd()) / m, rnd());
        const h = trace(o[0], o[1], o[2], d[0], d[1], d[2], tmax);
        if (!h) { acc[0] += sky[0]; acc[1] += sky[1]; acc[2] += sky[2]; continue; }
        const q = [o[0] + d[0] * h.t, o[1] + d[1] * h.t, o[2] + d[2] * h.t];
        const L = outgoing(q, h.n, h.pal, depth - 1, Math.max(2, m >> 1), rnd);
        acc[0] += L[0]; acc[1] += L[1]; acc[2] += L[2];
      }
      Ek = [acc[0] * Math.PI / m, acc[1] * Math.PI / m, acc[2] * Math.PI / m];
    }
    return [
      e[0] + a[0] / Math.PI * (Es[0] + Ek[0]),
      e[1] + a[1] / Math.PI * (Es[1] + Ek[1]),
      e[2] + a[2] / Math.PI * (Es[2] + Ek[2]),
    ];
  };

  /**
   * THE RECEIPT'S QUANTITY: indirect irradiance at (p, n) — sky seen from p,
   * plus everything sun and sky bounce off on the way. No direct sun at p.
   */
  globalThis.__gi2Ref = (p, n, N, M, bounce, seed) => {
    const rnd = mulberry32(seed >>> 0);
    const [t1, t2] = frame(n);
    const o = [p[0] + n[0] * 3e-3, p[1] + n[1] * 3e-3, p[2] + n[2] * 3e-3];
    const Esky = [0, 0, 0];
    const Ebnc = [0, 0, 0];
    let miss = 0;
    let hitT = 0; let hits = 0;
    for (let i = 0; i < N; i++) {
      const d = cosDir(n, t1, t2, (i + rnd()) / N, rnd());
      const h = trace(o[0], o[1], o[2], d[0], d[1], d[2], tmax);
      if (!h) { Esky[0] += sky[0]; Esky[1] += sky[1]; Esky[2] += sky[2]; miss++; continue; }
      hits++; hitT += h.t;
      const q = [o[0] + d[0] * h.t, o[1] + d[1] * h.t, o[2] + d[2] * h.t];
      const L = outgoing(q, h.n, h.pal, bounce, M, rnd);
      Ebnc[0] += L[0]; Ebnc[1] += L[1]; Ebnc[2] += L[2];
    }
    const k = Math.PI / N;
    return {
      E: [(Esky[0] + Ebnc[0]) * k, (Esky[1] + Ebnc[1]) * k, (Esky[2] + Ebnc[2]) * k],
      Esky: [Esky[0] * k, Esky[1] * k, Esky[2] * k],
      Ebnc: [Ebnc[0] * k, Ebnc[1] * k, Ebnc[2] * k],
      V: miss / N,
      meanHitT: hits ? hitT / hits : 0,
    };
  };
  return {
    ok: true, tris: soup.triCount, cell: gC, dim: [nx, ny, nz], origin: [...gO],
    sky, sunC, sunD, palClasses: alb.filter((a) => a[0] + a[1] + a[2] > 0).length,
  };
}, { tmax: TMAX });

if (!setup.ok) { console.log(`FATAL reference: ${setup.why}`); await browser.close(); process.exit(1); }
console.log(`  reference: ${setup.tris.toLocaleString()} tris, grid ${setup.dim.join("×")} @ ${setup.cell} m`);
console.log(`  sky ${setup.sky.map((v) => f(v, 3))}   sun ${setup.sunC.map((v) => f(v, 3))} ` +
  `dir [${setup.sunD.map((v) => f(v, 2))}]   ${setup.palClasses} palette classes`);
console.log(`  estimator: N=${NSPP} primary, M=${MSPP} sky, ${BOUNCE} bounce(s), tMax ${TMAX} m`);

// ═════════════════════════════════════════════════════════════════ THE POSES
//
// ══════════════════════════════════════════════ THE PINS (§AG — the fix that
// had to come before any other fix)
//
// ⭐⭐ A RECEIPT THAT RE-PICKS ITS OWN SAMPLE POINTS CANNOT ARBITRATE A CHANGE.
// §AF.7 measured pose A at 0.733 / 0.863 / 0.905 / 1.000 across four runs of
// the SAME tree, because `pickPoints` ranked pixels by their own `E_gi2`
// luminance — so DARK1..3 and WDRK1..3 are, by construction, whatever this
// boot's field happened to be worst at, and "the median moved" is then a
// statement about the picker. Run-to-run scatter of the same order as the
// effect is a blind instrument. [[probe-blind-statistics]]
//
// So the points are CHOSEN ONCE and written here: pose (eye/target) plus, per
// point, the dump pixel index, the world position and the normal. At run time
// each pin is resolved against the fresh dump by PIXEL FIRST and by NEAREST
// WORLD POSITION as the fallback, and the drift is printed — a pin that cannot
// be found is a loud row, never a silently different point.
//
// `PIN=0` restores the old self-picking behaviour (which is how a new pin set
// is chosen); `PIN_EMIT=1` prints a paste-ready block for this run's picks.
const PIN_ON = process.env.PIN !== "0";
const PIN_EMIT = !!process.env.PIN_EMIT;
/** Max world distance a pin may drift from its recorded position, in metres. */
const PIN_TOL = 0.35;
const PINS = JSON.parse(readFileSync(new URL("./gi2-ref-pins.json", import.meta.url), "utf8"));

// Pose A is `probe:gi2-farfield`/`flood`'s street overview, derived from the
// FrontBanner + Paris_Street bounds so it lands on the same street every run.
// Pose B is `probe:gi2-puddle`'s terrace anchor with its 8-yaw sweep dropped:
// the brightest emitter seat, the ground under it, six metres back. Both take a
// `POSE_A`/`POSE_B` override, which is how a run is pinned to a screenshot.
const boundsOf = async (needle) => {
  const list = (await call("entity.list", { nameContains: needle })).value ?? [];
  let agg = null;
  for (const e of list.slice(0, 24)) {
    const b = (await call("entity.getBounds", { id: e.id })).value;
    if (!b || b.empty) continue;
    agg ??= { min: [...b.min], max: [...b.max] };
    for (let i = 0; i < 3; i++) {
      agg.min[i] = Math.min(agg.min[i], b.min[i]);
      agg.max[i] = Math.max(agg.max[i], b.max[i]);
    }
  }
  return agg;
};
const shootRays = (rays) => page.evaluate(async ({ rays }) => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
  const shoot = createGi2RayShooter(gi2, eng.renderer);
  await shoot(rays);
  const out = await shoot(rays);
  return out.map((r) => ({ hit: r.hit > 0.5, t: r.t }));
}, { rays });
const parsePose = (s) => {
  const [e, a] = s.split("|").map((x) => x.split(",").map(Number));
  return { position: e, target: a, source: "env" };
};

async function poseStreet() {
  if (process.env.POSE_A) return parsePose(process.env.POSE_A);
  if (PIN_ON && PINS.a?.pose) return { ...PINS.a.pose, source: "PINNED street overview" };
  const banner = await boundsOf("FrontBanner");
  if (!banner) return null;
  const street = await boundsOf("Paris_Street_");
  const B = banner.min.map((v, i) => (v + banner.max[i]) / 2);
  const ground = street ? street.max[1] : banner.min[1] - 3.4;
  const eye = ground + 1.65;
  await call("viewport.setCamera", { position: [B[0], eye, B[2]], target: [B[0] + 4, eye, B[2]] });
  await settleFrames(90, 30000);
  const dirs = [];
  for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; dirs.push([Math.cos(a), 0, Math.sin(a)]); }
  const out = await shootRays(dirs.map((d) => ({ o: [B[0], eye, B[2]], d, tMax: 30 })));
  let bi = 0;
  for (let i = 1; i < out.length; i++) if ((out[i].hit ? out[i].t : 30) > (out[bi].hit ? out[bi].t : 30)) bi = i;
  const D = dirs[bi];
  const at = (k, y) => [B[0] + D[0] * k, y, B[2] + D[2] * k];
  return { position: at(22.0, ground + 4), target: at(2.0, ground + 3), source: "street overview (derived)" };
}
async function poseTerrace() {
  if (process.env.POSE_B) return parsePose(process.env.POSE_B);
  if (PIN_ON && PINS.b?.pose) return { ...PINS.b.pose, source: "PINNED terrace close" };
  const slots = await page.evaluate(() => (globalThis.__giSys()?.state?.emitterSlots ?? [])
    .filter((s) => s.radius.value > 1e-5)
    .map((s) => ({ c: [s.center.value.x, s.center.value.y, s.center.value.z],
      L: 0.2126 * s.color.value.r + 0.7152 * s.color.value.g + 0.0722 * s.color.value.b })));
  if (!slots.length) return null;
  slots.sort((a, b) => b.L - a.L);
  const s = slots[0];
  const g = (await shootRays([{ o: [s.c[0], s.c[1] - 0.2, s.c[2]], d: [0, -1, 0], tMax: 40 }]))[0];
  if (!g.hit) return null;
  const ground = s.c[1] - 0.2 - g.t;
  const eye = ground + 1.6;
  // Stand where there is room: the most open of eight yaws around the seat.
  const dirs = [];
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; dirs.push([Math.cos(a), 0, Math.sin(a)]); }
  const out = await shootRays(dirs.map((d) => ({ o: [s.c[0], eye, s.c[2]], d, tMax: 12 })));
  let bi = 0;
  for (let i = 1; i < out.length; i++) if ((out[i].hit ? out[i].t : 12) > (out[bi].hit ? out[bi].t : 12)) bi = i;
  const D = dirs[bi];
  const back = Math.min(6.0, (out[bi].hit ? out[bi].t : 12) - 0.6);
  return {
    position: [s.c[0] + D[0] * back, eye, s.c[2] + D[2] * back],
    target: [s.c[0], eye, s.c[2]],
    source: `terrace close (seat ${f(s.L, 2)}, ${f(back, 1)} m back)`,
  };
}

// ══════════════════════════════════════ THE SAMPLE POINTS, OUT OF THE GBUFFER
const pickPoints = (pins) => page.evaluate(async ({ pins }) => {
  const eng = globalThis.__giEngineForProbe;
  const gi2 = globalThis.__gi2();
  const { createGi2StageDump } = await import("/scripts/lib/gi2StageProbe.js");
  const dump = createGi2StageDump({
    renderer: eng.renderer, gi2, screen: globalThis.__giSys().state.screen, stride: 2,
  });
  const D = await dump.read();
  const V = 6;
  const at = (i, v, c) => D[(i * V + v) * 4 + c];
  const W = dump.dumpW; const H = dump.dumpH;
  const rows = [];
  for (let i = 0; i < W * H; i++) {
    if (!(at(i, 0, 3) > 0.5)) continue;
    const N = [at(i, 1, 0), at(i, 1, 1), at(i, 1, 2)];
    const nl = Math.hypot(N[0], N[1], N[2]);
    if (!(nl > 0.5)) continue;
    rows.push({
      i, gx: i % W, gy: Math.floor(i / W),
      P: [at(i, 0, 0), at(i, 0, 1), at(i, 0, 2)],
      N: [N[0] / nl, N[1] / nl, N[2] / nl],
      // Column 3 is `gi2.textures.irradiance` — the texture every material
      // samples and the one the `indirect` view divides by π. Column 2 is the
      // gather's own `irradiance` BEFORE the AO multiply.
      //
      // ⭐⭐ BOTH, ALWAYS. AO is a MULTIPLIER on this texture, so a pixel whose
      // AO is 0 reads exactly 0 no matter what the field says — and "the field
      // is black here" and "AO blacked out a healthy field" are opposite faults
      // with opposite fixes. The first run of this probe could not tell them
      // apart at the user's black cell.
      E: [at(i, 3, 0), at(i, 3, 1), at(i, 3, 2)],
      Eb: [at(i, 2, 0), at(i, 2, 1), at(i, 2, 2)],
      ao: at(i, 1, 3), aoRaw: at(i, 2, 3),
    });
  }
  const L = (r) => 0.2126 * r.E[0] + 0.7152 * r.E[1] + 0.0722 * r.E[2];
  const far = (list, r, d) => list.every((q) =>
    Math.hypot(q.P[0] - r.P[0], q.P[1] - r.P[1], q.P[2] - r.P[2]) > d);
  const take = (pool, n, d, sort) => {
    const out = [];
    for (const r of (sort ? pool.slice().sort(sort) : pool)) {
      if (out.length >= n) break;
      if (far(out, r, d)) out.push(r);
    }
    return out;
  };
  const wall = rows.filter((r) => Math.abs(r.N[1]) <= 0.35);
  const soff = rows.filter((r) => r.N[1] < -0.5);
  const pave = rows.filter((r) => r.N[1] > 0.9);

  // ── the façade column: the screen column-bucket of wall pixels with the
  // largest world-Y span whose normals agree. That is a façade, by definition
  // and not by eye.
  const buckets = new Map();
  for (const r of wall) {
    const b = r.gx >> 2;
    (buckets.get(b) ?? buckets.set(b, []).get(b)).push(r);
  }
  let bestCol = null;
  for (const [, list] of buckets) {
    if (list.length < 10) continue;
    const mn = [0, 1, 2].map((k) => list.reduce((a, r) => a + r.N[k], 0) / list.length);
    const ml = Math.hypot(mn[0], mn[1], mn[2]) || 1;
    const M = mn.map((v) => v / ml);
    const keep = list.filter((r) => r.N[0] * M[0] + r.N[1] * M[1] + r.N[2] * M[2] > 0.9);
    if (keep.length < 8) continue;
    const ys = keep.map((r) => r.P[1]);
    const span = Math.max(...ys) - Math.min(...ys);
    if (!bestCol || span > bestCol.span) bestCol = { span, keep, M };
  }
  const facade = [];
  if (bestCol) {
    const s = bestCol.keep.slice().sort((a, b) => b.P[1] - a.P[1]);
    for (let k = 0; k < 6; k++) facade.push(s[Math.min(s.length - 1, Math.round(k * (s.length - 1) / 5))]);
  }
  // ══ THE ZERO CENSUS — over the WHOLE dump, not over the pins ═══════════
  //
  // The pinned points are a fixed 24. A fix that lifts those and blacks out a
  // thousand others would read as a win, so the frame's own count of exact
  // zeros travels with every run. `preZero` separates the two faults the §AF
  // header names: a field that is zero (`E_pre` zero too) from AO having
  // multiplied a healthy field away.
  let zTot = 0; let zPre = 0;
  for (const r of rows) {
    if (L(r) >= 1e-4) continue;
    zTot++;
    if (0.2126 * r.Eb[0] + 0.7152 * r.Eb[1] + 0.0722 * r.Eb[2] < 1e-4) zPre++;
  }
  const census = { zeros: zTot, zerosPreAlso: zPre, valid: rows.length };

  // ══ PINNED RESOLUTION ══════════════════════════════════════════════════
  if (pins && pins.length) {
    const out = [];
    for (const p of pins) {
      const dist = (r) => Math.hypot(r.P[0] - p.P[0], r.P[1] - p.P[1], r.P[2] - p.P[2]);
      const agrees = (r) => r.N[0] * p.N[0] + r.N[1] * p.N[1] + r.N[2] * p.N[2] > 0.9;
      let hit = null; let how = "";
      const byIdx = rows.find((r) => r.i === p.i);
      if (byIdx && dist(byIdx) <= 0.35 && agrees(byIdx)) { hit = byIdx; how = "px"; }
      if (!hit) {
        let best = null;
        for (const r of rows) {
          if (!agrees(r)) continue;
          const d = dist(r);
          if (d > 1.0) continue;
          if (!best || d < dist(best)) best = r;
        }
        if (best) { hit = best; how = "near"; }
      }
      if (!hit) { out.push({ tag: p.tag, missing: true, i: p.i, P: p.P, N: p.N }); continue; }
      out.push({
        tag: p.tag, i: hit.i, P: hit.P, N: hit.N, E: hit.E, Eb: hit.Eb,
        ao: hit.ao, aoRaw: hit.aoRaw, how, drift: +dist(hit).toFixed(3),
        // ⭐ THE REFERENCE'S SEED IS THE PIN'S, NOT THE PIXEL'S. Same 128
        // cosine directions every run, so `E_ref` is a constant of the pin and
        // any move in the ratio is GI2's.
        seed: p.i,
      });
    }
    return {
      pts: out, valid: rows.length, total: W * H, census, pinned: true,
      counts: { wall: wall.length, soff: soff.length, pave: pave.length },
      colSpan: 0, cam: [eng.camera.position.x, eng.camera.position.y, eng.camera.position.z],
    };
  }

  const tag = (list, pre) => list.map((r, k) => ({ ...r, tag: `${pre}${k + 1}` }));
  const pts = [
    ...tag(facade, "FAC"),
    ...tag(take(soff, 3, 1.0, (a, b) => a.N[1] - b.N[1]), "SOFF"),
    ...tag(take(pave, 3, 3.0, () => 0), "PAVE"),
    ...tag(take(rows, 3, 0.4, (a, b) => L(a) - L(b)), "DARK"),
    ...tag(take(wall, 3, 1.0, (a, b) => L(a) - L(b)), "WDRK"),
    ...tag(take(wall, 2, 3.0, (a, b) => L(b) - L(a)), "WBRT"),
  ];
  // De-duplicate: a DARK pixel can also be the darkest wall.
  const seen = new Set();
  const out = [];
  for (const p of pts) {
    if (seen.has(p.i)) continue;
    seen.add(p.i);
    out.push({ tag: p.tag, i: p.i, P: p.P, N: p.N, E: p.E, Eb: p.Eb, ao: p.ao, aoRaw: p.aoRaw, seed: p.i, how: "auto", drift: 0 });
  }
  return {
    pts: out, valid: rows.length, total: W * H, census, pinned: false,
    counts: { wall: wall.length, soff: soff.length, pave: pave.length },
    colSpan: bestCol ? +bestCol.span.toFixed(2) : 0,
    cam: [eng.camera.position.x, eng.camera.position.y, eng.camera.position.z],
  };
}, { pins });

// ════════════════════════════════ THE WORLD PROBE THAT COVERS ONE SAMPLE POINT
//
// The same choice the resolve makes — the highest-weight LIVE corner of the
// finest cascade whose lattice contains the normal-biased point — and then the
// probe's WHOLE oct map, split into what it thinks is sky and what it thinks is
// geometry. `V_probe` is the column that names the term.
const probeAt = (pts) => page.evaluate(async ({ pts }) => {
  const eng = globalThis.__giEngineForProbe;
  const g = globalThis.__gi2().gather;
  if (!g?.world) return null;
  const w = g.world.describe();
  const { octTable } = await import("/src/modules/gi/window/gatherProbes.js");
  // ⚠ `describe().oct` IS THE TEXEL COUNT (`OCT = O*O` in `gatherProbes`), NOT
  // the octahedral resolution. Reading it as a resolution squares it, the
  // addresses land 64× past the buffer, and every probe reads as `n = 0` — a
  // silently EMPTY oct map, which is indistinguishable from a dead lattice.
  // (`run-gi2-flood-probe.mjs` has this bug; its transport column is inert.)
  const OCT = w.oct; const OCTR = Math.round(Math.sqrt(OCT));
  const tbl = octTable(OCTR).map((v) => [v.x, v.y, v.z, v.w]);
  const OW = w.octWords;
  const NC = w.cascades; const C = w.cells; const CB = Math.log2(C); const CELLS = w.cellCount;
  const LW = 2 * CELLS + w.blocks + 8;
  const INFO_VEC = 12;
  const info = new Float32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpInfo.value));
  const oct = new Uint32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpOct.value));
  const list = new Uint32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpList.value));
  const org = g.world.origins.map((u) => [u.value.x, u.value.y, u.value.z]);
  const uv = (u) => { const v = u?.value; return v ? [v.x ?? v.r, v.y ?? v.g, v.z ?? v.b] : [0, 0, 0]; };
  const sky = uv(g.uniforms.skyColor);
  const skyL = Math.max(1e-6, 0.2126 * sky[0] + 0.7152 * sky[1] + 0.0722 * sky[2]);
  const decode = (word) => {
    const e = (word >>> 24) - 128;
    const s = Math.pow(2, e) / 255;
    return [(word & 255) * s, ((word >>> 8) & 255) * s, ((word >>> 16) & 255) * s];
  };
  const nOf = (word) => (word >>> 24) & 63;
  const tOf = (word) => (word >>> 30) & 1;
  const meanOf = (word, dmax) => (word & 4095) * dmax / 4095;
  const slotOf = (x, y, z) => ((x & (C - 1)) >>> 0) | (((y & (C - 1)) >>> 0) << CB)
    | (((z & (C - 1)) >>> 0) << (2 * CB));
  const inLat = (o, x, y, z) => [x - o[0], y - o[1], z - o[2]].every((v) => v >= 0 && v < C);
  // ⭐⭐ §AF.6 — THE CLAMP IS A COLUMN NOW, NOT A SUSPICION.
  // `shEvalRaw` is the shader's arithmetic WITHOUT its terminal `.max(vec3(0))`;
  // `shDC` is the band-0 term alone (`L0 · 0.886227`), which is π-normalised
  // irradiance from a uniform sphere and can only be negative if a coefficient
  // is. Print all three and the diagnosis is arithmetic, not inference: DC > 0
  // with raw < 0 IS the ringing, and `E = 0` beside `DC > 0` is the cliff.
  const shEvalRaw = (L, n) => {
    const c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
    return [0, 1, 2].map((k) =>
      L[8][k] * c1 * (n[0] * n[0] - n[1] * n[1]) + L[6][k] * c3 * n[2] * n[2]
      + L[0][k] * c4 - L[6][k] * c5 + L[4][k] * 2 * c1 * n[0] * n[1]
      + L[7][k] * 2 * c1 * n[0] * n[2] + L[5][k] * 2 * c1 * n[1] * n[2]
      + L[3][k] * 2 * c2 * n[0] + L[1][k] * 2 * c2 * n[1] + L[2][k] * 2 * c2 * n[2]);
  };
  const shEval = (L, n) => shEvalRaw(L, n).map((v) => Math.max(0, v));
  const shDC = (L) => [0, 1, 2].map((k) => L[0][k] * 0.886227);
  const liveOf = (cc) => list[cc * LW + 2 * CELLS + w.blocks];

  const out = [];
  for (const pt of pts) {
    const P = pt.P; const N = pt.N;
    let pick = null;
    // ⭐ EVERY CASCADE ANSWERS, AND ALL THREE ANSWERS ARE PRINTED. The resolve
    // composites them finest-first by confidence, so "which cascade lit this
    // pixel" is a claim about `cov`, and "would a finer one have been better"
    // is a claim only the OTHER cascades' answers can settle. A single covering
    // probe cannot say whether a flat façade is the coarse lattice's fault or
    // the estimator's.
    const perCasc = [];
    for (let cc = 0; cc < NC; cc++) {
      const sp = w.spacings[cc];
      // The resolve biases along the normal by a fraction of the cascade's own
      // spacing before it looks up the lattice; the same bias here or the probe
      // named is not the probe that answered.
      const bl = 0.3 * sp;
      const Pb = [P[0] + N[0] * bl, P[1] + N[1] * bl, P[2] + N[2] * bl];
      const gp = [Pb[0] / sp - 0.5, Pb[1] / sp - 0.5, Pb[2] / sp - 0.5];
      const b = gp.map(Math.floor);
      const fr = gp.map((v, k) => v - b[k]);
      let best = null;
      for (let c8 = 0; c8 < 8; c8++) {
        const dx = c8 & 1, dy = (c8 >> 1) & 1, dz = (c8 >> 2) & 1;
        const rx = b[0] + dx, ry = b[1] + dy, rz = b[2] + dz;
        if (!inLat(org[cc], rx, ry, rz)) continue;
        const gc = cc * CELLS + slotOf(rx, ry, rz);
        const bi = gc * INFO_VEC * 4;
        if (!(info[bi + 3] > 0.5)) continue;
        const tri = (dx ? fr[0] : 1 - fr[0]) * (dy ? fr[1] : 1 - fr[1]) * (dz ? fr[2] : 1 - fr[2]);
        if (!best || tri > best.tri) best = { tri, gc, cc };
      }
      // The cascade's own trilinear, liveness-weighted SH answer at this point.
      let cov = 0;
      const Lc = Array.from({ length: 9 }, () => [0, 0, 0]);
      for (let c8 = 0; c8 < 8; c8++) {
        const dx = c8 & 1, dy = (c8 >> 1) & 1, dz = (c8 >> 2) & 1;
        const rx = b[0] + dx, ry = b[1] + dy, rz = b[2] + dz;
        if (!inLat(org[cc], rx, ry, rz)) continue;
        const gcc = cc * CELLS + slotOf(rx, ry, rz);
        const bb = gcc * INFO_VEC * 4;
        if (!(info[bb + 3] > 0.5)) continue;
        const tri = (dx ? fr[0] : 1 - fr[0]) * (dy ? fr[1] : 1 - fr[1]) * (dz ? fr[2] : 1 - fr[2]);
        if (!(tri > 1e-6)) continue;
        cov += tri;
        for (let i = 0; i < 9; i++) {
          const o = bb + (3 + i) * 4;
          Lc[i][0] += info[o] * tri; Lc[i][1] += info[o + 1] * tri; Lc[i][2] += info[o + 2] * tri;
        }
      }
      const Ln = Lc.map((v) => v.map((x) => x / Math.max(1e-9, cov)));
      const Ecc = cov > 1e-5 ? shEval(Ln, N) : [0, 0, 0];
      const Erw = cov > 1e-5 ? shEvalRaw(Ln, N) : [0, 0, 0];
      const Edc = cov > 1e-5 ? shDC(Ln) : [0, 0, 0];
      const lu = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      perCasc.push({
        cov: +cov.toFixed(3), E: +lu(Ecc).toFixed(3),
        Eraw: +lu(Erw).toFixed(3), Edc: +lu(Edc).toFixed(3),
        // how many of the three channels the clamp actually bit
        clamped: [0, 1, 2].filter((k) => Erw[k] < 0).length,
      });
      if (best && !pick) pick = best;
    }
    if (!pick) { out.push({ tag: pt.tag, probe: null, perCasc, live: liveOf(0) }); continue; }
    const { gc, cc } = pick;
    const bi = gc * INFO_VEC * 4;
    const pos = [info[bi], info[bi + 1], info[bi + 2]];
    const state = info[bi + 3];
    const faced = state > 1.5;
    const fN = [info[bi + 4], info[bi + 5], info[bi + 6]];
    const ready = info[bi + 2 * 4 + 3];
    const SH = [];
    for (let i = 0; i < 9; i++) {
      const o = bi + (3 + i) * 4;
      SH.push([info[o], info[o + 1], info[o + 2]]);
    }
    // ── the oct map, split ────────────────────────────────────────────────
    const base = gc * OCT * OW;
    const dmax = w.distMax[cc];
    let nHas = 0; let nT = 0; let nSky = 0; let nZero = 0;
    let wSky = 0; let wHit = 0; let wAll = 0;      // cosine·Δω, per class
    const Esky = [0, 0, 0]; const Ehit = [0, 0, 0];
    let dSum = 0; let dN = 0;
    let maxRad = 0;
    for (let t = 0; t < OCT; t++) {
      const a = base + t * OW;
      const w1 = oct[a + 1];
      const e = tbl[t];
      const cw = Math.max(0, e[0] * N[0] + e[1] * N[1] + e[2] * N[2]) * e[3];
      if (cw > 0) wAll += cw;
      if (!(nOf(w1) > 0)) { nZero++; continue; }
      nHas++;
      if (tOf(w1)) nT++;
      const r = decode(oct[a]);
      const rl = 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2];
      if (rl > maxRad) maxRad = rl;
      const d = meanOf(w1, dmax);
      dSum += d; dN++;
      // "IS THIS TEXEL THE SKY" — the stored radiance is `skyColor` to within
      // 3 % of its luminance AND its chroma matches. The sky is credited by a
      // single uniform, so a texel that carries it carries it exactly; a
      // bounce that happens to land near the sky's luminance will not also
      // match its ratios.
      const isSky = Math.abs(rl - skyL) <= 0.03 * skyL
        && [0, 1, 2].every((k) => Math.abs(r[k] - sky[k]) <= 0.05 * Math.max(1e-6, sky[k]) + 1e-5);
      if (isSky) { nSky++; wSky += cw; for (let k = 0; k < 3; k++) Esky[k] += r[k] * cw; }
      else { wHit += cw; for (let k = 0; k < 3; k++) Ehit[k] += r[k] * cw; }
    }
    const Eoct = [0, 1, 2].map((k) => Esky[k] + Ehit[k]);
    out.push({
      tag: pt.tag,
      perCasc,
      probe: {
        cc, gc, cell: gc - cc * CELLS, pos: pos.map((v) => +v.toFixed(2)),
        spacing: w.spacings[cc], state: +state.toFixed(1), ready: +ready.toFixed(2),
        faced, fN: faced ? fN.map((v) => +v.toFixed(2)) : null,
        dist: +Math.hypot(pos[0] - pt.P[0], pos[1] - pt.P[1], pos[2] - pt.P[2]).toFixed(2),
        nHas, nT, nSky, nZero,
        // ⭐ V_probe: the cosine-weighted solid-angle share of the hemisphere
        // this probe believes is open sky, normalised by π (the full cosine
        // hemisphere). Directly comparable to the reference's V.
        Vprobe: +(wSky / Math.PI).toFixed(4),
        Vcov: +(wAll / Math.PI).toFixed(4),
        Eoct, Esky, Ehit,
        Esh: shEval(SH, N), EshRaw: shEvalRaw(SH, N), EshDc: shDC(SH),
        meanHitDist: dN ? +(dSum / dN).toFixed(2) : 0,
        maxRad: +maxRad.toFixed(4),
      },
      live: liveOf(cc),
    });
  }
  return {
    rows: out, cascades: NC, spacings: w.spacings, extents: w.extents,
    live: Array.from({ length: NC }, (_, c) => liveOf(c)),
    tStart: w.tStart, tEnd: w.tEnd, sky, wpCovFull: g.uniforms.wpCovFull?.value ?? null,
  };
}, { pts });

// ══════════════════════════════════════════════════════════ THE HEALTH GATE
//
// ⭐⭐ A RECEIPT THAT CANNOT TELL A DEAD ENGINE FROM A DARK SCENE IS WORSE THAN
// NO RECEIPT — [[probe-blind-statistics]], and this probe learned it the
// expensive way. Two of its four runs landed on a worktree where a neighbouring
// agent's in-flight `radianceCache.js` edit had killed the chain
// (`ReferenceError: int is not defined`, then a silent empty cache). Every
// world probe came back `n = 0`, every SH came back 0, every pixel came back
// 0.0000 — and the table rendered all of that as "GI2 is 0.00× of the truth",
// a beautifully formatted lie.
//
// The gate is the cheapest fact that separates the two: the world lattice's
// SH buffer must contain SOMETHING. A scene can be dark; a lattice with 7000
// live probes and not one non-zero spherical-harmonic coefficient is a broken
// build, and the only honest thing to print is that.
const fieldAlive = () => page.evaluate(async () => {
  const eng = globalThis.__giEngineForProbe;
  const g = globalThis.__gi2()?.gather;
  if (!g?.world) return { ok: false, why: "no world lattice (screen-probe path?)" };
  const info = new Float32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpInfo.value));
  const oct = new Uint32Array(await eng.renderer.getArrayBufferAsync(g.buffers.wpOct.value));
  let shNz = 0; let octNz = 0;
  for (let i = 0; i < info.length; i += 7) if (info[i] !== 0) shNz++;
  for (let i = 0; i < oct.length; i += 11) if (oct[i] !== 0) octNz++;
  return { ok: shNz > 0 && octNz > 0, shNz, octNz };
});

// ═════════════════════════════════════════════════════════════════════ THE RUN
const results = {};
for (const [key, mk, label] of [["a", poseStreet, "STREET OVERVIEW"], ["b", poseTerrace, "TERRACE CLOSE"]]) {
  if (ONLY && ONLY !== key) continue;
  console.log(`\n══ POSE ${key.toUpperCase()} — ${label} ══════════════════════════════`);
  const pose = await mk();
  if (!pose) { console.log("  SKIP: pose could not be derived"); continue; }
  console.log(`  ${pose.source}: eye [${pose.position.map((v) => v.toFixed(2))}] ` +
    `→ [${pose.target.map((v) => v.toFixed(2))}]`);
  await call("viewport.setCamera", { position: pose.position, target: pose.target });
  await settleFrames(FRAMES);

  const health = await fieldAlive();
  if (!health.ok) {
    console.log(`
  ⛔ ABORT — THE GI2 FIELD IS DEAD IN THIS WORKTREE ` +
      `(${health.why ?? `non-zero SH coefficients ${health.shNz}, oct words ${health.octNz}`}).`);
    console.log("     Every ratio this run could print would be a statement about a broken");
    console.log("     build, not about the field. Check `git status` and the page console.");
    await browser.close();
    process.exit(2);
  }
  console.log(`  field alive: ${health.shNz} non-zero SH samples, ${health.octNz} non-zero oct words`);

  const sel = await pickPoints(PIN_ON ? (PINS[key]?.pts ?? null) : null);
  console.log(`  gbuffer ${sel.valid}/${sel.total} valid — wall ${sel.counts.wall}, ` +
    `soffit ${sel.counts.soff}, pavement ${sel.counts.pave}` +
    (sel.pinned ? "" : `; façade column span ${sel.colSpan} m`));
  const miss = sel.pts.filter((p) => p.missing);
  const nearN = sel.pts.filter((p) => p.how === "near");
  console.log(`  ${sel.pts.length} sample points ${sel.pinned ? "(PINNED)" : "(self-picked — NOT comparable across runs)"}` +
    (sel.pinned ? ` — ${sel.pts.length - miss.length - nearN.length} by pixel, ${nearN.length} by nearest ` +
      `(max drift ${f(Math.max(0, ...nearN.map((p) => p.drift)), 3)} m), ${miss.length} MISSING` +
      (miss.length ? `: ${miss.map((p) => p.tag).join(" ")}` : "") : ""));
  console.log(`  zero census: ${sel.census.zeros} of ${sel.census.valid} valid gbuffer pixels read ` +
    `E_gi2 < 1e-4 (${f(100 * sel.census.zeros / Math.max(1, sel.census.valid), 2)} %), ` +
    `${sel.census.zerosPreAlso} of them zero BEFORE ao`);
  if (PIN_EMIT) {
    console.log("  ── PIN_EMIT ──");
    console.log(JSON.stringify({
      pose: { position: pose.position, target: pose.target },
      pts: sel.pts.filter((p) => !p.missing).map((p) => ({
        tag: p.tag, i: p.i,
        P: p.P.map((v) => +v.toFixed(3)), N: p.N.map((v) => +v.toFixed(4)),
      })),
    }));
  }
  sel.pts = sel.pts.filter((p) => !p.missing);

  const dec = await probeAt(sel.pts);
  if (dec) {
    console.log(`  cascades ${dec.cascades} — spacing ${dec.spacings.join("/")} m, ` +
      `extents ${dec.extents.join("/")} m, live ${dec.live.join("/")}, ` +
      `intervals [${dec.tStart.map((v) => f(v, 1))}] → [${dec.tEnd.map((v) => f(v, 1))}]`);
  }
  const byTag = new Map((dec?.rows ?? []).map((r) => [r.tag, r]));

  // The reference, one point per round trip.
  const refs = [];
  const t0 = Date.now();
  for (const p of sel.pts) {
    const r = await page.evaluate(({ P, N, n, m, b, s }) => globalThis.__gi2Ref(P, N, n, m, b, s),
      { P: p.P, N: p.N, n: NSPP, m: MSPP, b: BOUNCE, s: ((p.seed ?? p.i) * 2654435761) >>> 0 });
    refs.push(r);
  }
  console.log(`  reference traced in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

  console.log("  tag    world position        E_ref  bnc%    E_gi2   E_pre    ao  ratio |  V_ref V_prb | " +
    "casc  E_sky_p E_hit_p  |  c0/c1/c2 E (cov)              n/T/sky  probe");
  console.log("  " + "─".repeat(150));

  const rows = [];
  for (let k = 0; k < sel.pts.length; k++) {
    const p = sel.pts[k]; const r = refs[k]; const d = byTag.get(p.tag);
    const Lr = lum(r.E); const Lg = lum(p.E);
    const ratio = Lg / Math.max(1e-6, Lr);
    const pr = d?.probe ?? null;
    rows.push({
      tag: p.tag, P: p.P, N: p.N, Eref: r.E, Egi2: p.E, Epre: p.Eb, ao: p.ao, aoRaw: p.aoRaw,
      perCasc: d?.perCasc ?? null, ratio,
      Vref: r.V, Vprobe: pr?.Vprobe ?? null, cc: pr?.cc ?? null,
      Erefsky: r.Esky, Erefbnc: r.Ebnc,
      Eskyp: pr ? lum(pr.Esky) : null, Ehitp: pr ? lum(pr.Ehit) : null,
      Eoct: pr ? lum(pr.Eoct) : null, Esh: pr ? lum(pr.Esh) : null,
      nHas: pr?.nHas ?? null, nT: pr?.nT ?? null, nSky: pr?.nSky ?? null,
      EshRaw: pr ? lum(pr.EshRaw) : null, EshDc: pr ? lum(pr.EshDc) : null,
      state: pr?.state ?? null, ready: pr?.ready ?? null, faced: pr?.faced ?? null,
      probePos: pr?.pos ?? null, probeDist: pr?.dist ?? null, spacing: pr?.spacing ?? null,
    });
    const flag = ratio < 0.7 ? "▼" : ratio > 1.4 ? "▲" : " ";
    const bncPct = 100 * lum(r.Ebnc) / Math.max(1e-6, Lr);
    const cascCol = (d?.perCasc ?? []).map((c) => `${f(c.E, 2)}(${f(c.cov, 2)})`).join(" ");
    console.log(`  ${p.tag.padEnd(6)} [${p.P.map((v) => v.toFixed(1).padStart(6)).join(",")}] ` +
      `${f(Lr, 4).padStart(7)} ${f(bncPct, 0).padStart(4)} ${f(Lg, 4).padStart(8)} ` +
      `${f(lum(p.Eb), 4).padStart(7)} ${f(p.ao, 2).padStart(5)} ${f(ratio, 2).padStart(6)}${flag}| ` +
      `${f(r.V, 2).padStart(5)} ${(pr ? f(pr.Vprobe, 2) : "  — ").padStart(5)} | ` +
      `${pr ? `c${pr.cc}` : " — "}  ${(pr ? f(lum(pr.Esky), 3) : "—").padStart(7)} ` +
      `${(pr ? f(lum(pr.Ehit), 3) : "—").padStart(7)}  | ${cascCol.padEnd(30)} ` +
      `${pr ? `${pr.nHas}/${pr.nT}/${pr.nSky}`.padStart(9) : "        —"} ` +
      `${pr ? `${pr.faced ? "face" : "air "} d${f(pr.dist, 1)}` : "NO PROBE"}`);
  }

  // ── the verdicts ──────────────────────────────────────────────────────────
  const fac = rows.filter((r) => r.tag.startsWith("FAC"));
  const errs = rows.map((r) => Math.abs(r.ratio - 1));
  console.log(`\n  median |ratio−1| over ${rows.length} points: ${f(med(errs), 3)}   ` +
    `outside [0.7, 1.4]: ${rows.filter((r) => r.ratio < 0.7 || r.ratio > 1.4).length}`);
  // ⭐ THE SIGNAL SET. A ratio is a quotient, and pose A's FAC3 divides
  // `E_gi2 = 0.058` by a path-traced `E_ref = 0.0005` to announce a 108×
  // error over six hundredths of a nit. Points whose truth is below `SIG`
  // cannot rank an estimator — they are printed and counted, and kept OUT of
  // the headline so the headline is about the places the picture is made of.
  const SIG = 0.02;
  const sig = rows.filter((r) => lum(r.Eref) > SIG);
  const sigErr = sig.map((r) => Math.abs(r.ratio - 1));
  const sigLog = sig.reduce((a, r) => a + Math.abs(Math.log(Math.max(1e-6, r.ratio))), 0)
    / Math.max(1, sig.length);
  console.log(`  ⭐ SIGNAL SET (E_ref > ${SIG}): ${sig.length} points, median |ratio−1| ` +
    `${f(med(sigErr), 3)}   outside [0.7, 1.4]: ` +
    `${sig.filter((r) => r.ratio < 0.7 || r.ratio > 1.4).length}   ` +
    `mean |log ratio| ${f(sigLog, 3)}`);

  // ══ §19 5.4c — THE TERM ARMS, IN THE SAME BOOT, AGAINST THE SAME REFERENCE
  //
  // The 5.2/5.3d receipts say "GI2 is TOO BRIGHT on Bistro" and a scalar gain
  // cannot name which term the excess is in. Three of them are live uniforms —
  // `rcTermField` and `rcTermDirect` on `gi2.rc` (5.3e), `skyColor` on the
  // gather — so the split is a WRITE, not a rebuild: the reference is already
  // traced, the pins are already resolved, and every arm re-reads E_gi2 at the
  // SAME pixels. `E_base − E_noSky` is the sky's share of the delivered field
  // BY SUBTRACTION, which is the number that decides the double-count question.
  if (ARMS.length) {
    console.log("\n  ── TERM ARMS (live uniforms, same pose, same reference) ────────────");
    console.log(`  ${"arm".padEnd(22)} ${"ΣE_gi2".padStart(9)} ${"Σratio".padStart(8)} ` +
      `${"med|log|".padStart(9)} ${"share".padStart(7)}  (signal set, ${sig.length} pts)`);
    const sigTags = new Set(sig.map((r) => r.tag));
    const sumRef = sig.reduce((a, r) => a + lum(r.Eref), 0);
    const scoreOf = (byTagE) => {
      let sumG = 0; const logs = [];
      for (const r of sig) {
        const E = byTagE.get(r.tag);
        if (!E) continue;
        const Lg = lum(E); sumG += Lg;
        logs.push(Math.abs(Math.log(Math.max(1e-6, Lg) / Math.max(1e-6, lum(r.Eref)))));
      }
      return { sumG, ratio: sumG / Math.max(1e-9, sumRef), med: med(logs) };
    };
    const baseScore = scoreOf(new Map(sig.map((r) => [r.tag, r.Egi2])));
    const line = (name, s, share) => console.log(
      `  ${name.padEnd(22)} ${f(s.sumG, 4).padStart(9)} ${f(s.ratio, 3).padStart(8)} ` +
      `${f(s.med, 3).padStart(9)} ${(share == null ? "—" : `${(share * 100).toFixed(0)} %`).padStart(7)}`);
    line("baseline (shipped)", baseScore, null);
    const armScores = { base: baseScore };
    for (const arm of ARMS) {
      const set = await page.evaluate(({ sets }) => {
        const gi2 = globalThis.__gi2();
        // The RC resolve's own uniforms live on `gi2.rc`, the transport's on the
        // gather. Merging them here is what makes an arm one name, not two.
        const u = { ...(gi2.rc?.uniforms ?? {}), ...gi2.gather.uniforms };
        const before = [];
        for (const s of sets) {
          const n = u[s.k];
          if (!n) return { error: `no uniform ${s.k}` };
          const v = n.value;
          // ⚠ `skyColor`/`sunColor` are THREE.Color (r/g/b), NOT Vector3
          // (x/y/z) — the first cut of this tested only `"x" in v`, fell to
          // the scalar branch and REPLACED the Color object with a number, and
          // the next `sceneSkyRadiance` tick threw `out.setRGB is not a
          // function` on every frame for the rest of the boot.
          if (v && typeof v === "object" && ("x" in v || "r" in v)) {
            const c = "r" in v ? ["r", "g", "b"] : ["x", "y", "z"];
            before.push({ k: s.k, vec: c.map((a) => v[a]), comp: c });
            for (const a of c) v[a] = s.v;
          } else { before.push({ k: s.k, num: v }); n.value = s.v; }
        }
        return { ok: true, before };
      }, { sets: arm.sets });
      if (set.error) { console.log(`  ${arm.name.padEnd(22)} SKIPPED — ${set.error}`); continue; }
      await settleFrames(ARM_FRAMES);
      const re = await pickPoints(PIN_ON ? (PINS[key]?.pts ?? null) : null);
      const m = new Map(re.pts.filter((p) => !p.missing && sigTags.has(p.tag)).map((p) => [p.tag, p.E]));
      const s = scoreOf(m);
      armScores[arm.name] = s;
      line(arm.name, s, (baseScore.sumG - s.sumG) / Math.max(1e-9, baseScore.sumG));
      await page.evaluate(({ before }) => {
        const gi2 = globalThis.__gi2();
        const u = { ...(gi2.rc?.uniforms ?? {}), ...gi2.gather.uniforms };
        for (const b of before) {
          if (b.vec) b.comp.forEach((a, i) => { u[b.k].value[a] = b.vec[i]; });
          else u[b.k].value = b.num;
        }
      }, { before: set.before });
      await settleFrames(ARM_FRAMES);
    }
    console.log("  `share` = (baseline − arm) / baseline: the fraction of the DELIVERED");
    console.log("  field this term carries. Σratio is against the SAME path-traced truth,");
    console.log("  whose contract is printed above — sky YES, sun-direct-at-p NO.");
    results[`arms_${key}`] = armScores;
  }

  // ══ THE FAÇADE COLUMN, AS A NAMED PROFILE ══════════════════════════════
  //
  // FAC1..FAC6 are one wall, top to bottom, and they are the headline: a
  // street of height/width ≈ 2 MUST darken toward its base. `fall` is the
  // profile's single number — top ÷ bottom — and it is printed for the truth
  // and for GI2 side by side, with the ratio between them (`flatness`, 1.0 =
  // GI2 reproduces the fall, > 1 = GI2 is flatter than the world).
  if (fac.length >= 2) {
    const top = fac[0]; const bot = fac[fac.length - 1];
    const fallRef = lum(top.Eref) / Math.max(1e-6, lum(bot.Eref));
    const fallGi2 = lum(top.Egi2) / Math.max(1e-6, lum(bot.Egi2));
    console.log(`  ── PROFILE façade-column (${f(top.P[1], 1)} m → ${f(bot.P[1], 1)} m, ` +
      `${fac.length} points) ────────`);
    console.log("     step   world-Y   E_ref    E_gi2   ratio   V_ref V_prb   casc  d_probe");
    for (const r of fac) {
      console.log(`     ${r.tag.padEnd(5)} ${f(r.P[1], 2).padStart(7)} ${f(lum(r.Eref), 4).padStart(8)} ` +
        `${f(lum(r.Egi2), 4).padStart(8)} ${f(r.ratio, 2).padStart(6)}  ` +
        `${f(r.Vref, 2).padStart(6)} ${(r.Vprobe === null ? "—" : f(r.Vprobe, 2)).padStart(5)}   ` +
        `${r.cc === null ? "—" : `c${r.cc}`}    ${r.probeDist === null ? "—" : f(r.probeDist, 2)}`);
    }
    const sk = fac.filter((r) => r.Eskyp !== null);
    if (sk.length >= 2) {
      console.log(`     sky term  top/bottom ${f(sk[0].Eskyp / Math.max(1e-6, sk[sk.length - 1].Eskyp), 2)}×` +
        `   hit term  top/bottom ${f(sk[0].Ehitp / Math.max(1e-6, sk[sk.length - 1].Ehitp), 2)}×`);
    }
    console.log(`     FAÇADE FALL  truth ${f(fallRef, 2)}×   GI2 ${f(fallGi2, 2)}×   ` +
      `flatness ${f(fallRef / Math.max(1e-6, fallGi2), 2)}× (1.0 = matched)`);
    const dp = fac.filter((r) => r.probeDist !== null).map((r) => r.probeDist);
    if (dp.length) {
      console.log(`     answering probe distance: median ${f(med(dp), 2)} m  max ${f(Math.max(...dp), 2)} m  ` +
        `(cascades ${fac.map((r) => (r.cc === null ? "—" : r.cc)).join("")})`);
    }
  }
  const withV = rows.filter((r) => r.Vprobe !== null);
  if (withV.length) {
    const dv = withV.map((r) => r.Vprobe - r.Vref);
    console.log(`  ── the sky term ─────────────────────────────────────────────`);
    console.log(`     V_probe − V_ref: median ${f(med(dv), 3)}  ` +
      `min ${f(Math.min(...dv), 3)}  max ${f(Math.max(...dv), 3)}   ` +
      `(> 0 ⇒ the probe credits sky the geometry blocks)`);
    const hi = withV.filter((r) => r.Vprobe > r.Vref + 0.15);
    console.log(`     points where the probe over-credits sky by > 0.15: ${hi.length}/${withV.length}` +
      (hi.length ? `  — ${hi.slice(0, 6).map((r) => r.tag).join(" ")}` : ""));
  }
  // ══ §AF.6 — THE CLAMP CENSUS ═══════════════════════════════════════════
  //
  // `shEval` ends in `.max(vec3(0))`. A truncated SH2 reconstructed on a
  // hemisphere with hard occluders RINGS: the band-1/2 terms overshoot
  // negative and the clamp turns a smoothly-varying small negative into a
  // FLAT ZERO that neighbouring pixels straddle. The question is not whether
  // the clamp fires — it is whether it fires where the DC term (the mean
  // radiance over the whole sphere, which cannot be negative for a physical
  // probe) is POSITIVE. That is a reconstruction fault, not a dark scene.
  {
    const cs = [];
    for (const r of rows) {
      for (const c of (r.perCasc ?? [])) {
        if (!(c.cov > 1e-5)) continue;
        cs.push({ tag: r.tag, ...c });
      }
    }
    const bit = cs.filter((c) => c.clamped > 0);
    const ring = bit.filter((c) => c.Edc > 1e-4);
    console.log(`  ── the SH clamp (§AF.6) ─────────────────────────────────────`);
    console.log(`     covered (cascade, point) pairs ${cs.length}; the clamp bites at least one ` +
      `channel in ${bit.length} (${f(100 * bit.length / Math.max(1, cs.length), 1)} %)`);
    console.log(`     of those, DC > 0 — i.e. RINGING, not darkness: ${ring.length}` +
      (ring.length ? `  — ${ring.slice(0, 8).map((c) => c.tag).join(" ")}` : ""));
    const zr = rows.filter((r) => lum(r.Egi2) < 1e-4 && lum(r.Eref) > 0.05);
    console.log(`     ⛔ GATE — pixels at 0 where E_ref > 0.05: ${zr.length}` +
      (zr.length ? `  — ${zr.map((r) => r.tag).join(" ")}` : "  (pass)"));
    for (const r of zr) {
      const fin = (r.perCasc ?? []).find((c) => c.cov > 1e-5);
      console.log(`        ${r.tag}: E_ref ${f(lum(r.Eref), 4)}  E_pre ${f(lum(r.Epre), 5)}  ` +
        `ao ${f(r.ao, 3)}  probe SH: E ${f(r.Esh, 4)} raw ${f(r.EshRaw, 4)} DC ${f(r.EshDc, 4)}` +
        (fin ? `  | finest covered cascade: E ${f(fin.E, 4)} raw ${f(fin.Eraw, 4)} DC ${f(fin.Edc, 4)} (${fin.clamped} ch clamped)` : ""));
    }
  }
  const dead = rows.filter((r) => r.nHas === null || r.nHas === 0 || lum(r.Egi2) < 1e-4);
  if (dead.length) {
    console.log(`  ── the dark points ──────────────────────────────────────────`);
    for (const r of dead) {
      console.log(`     ${r.tag} at [${r.P.map((v) => v.toFixed(2))}]  E_gi2 ${f(lum(r.Egi2), 5)}  ` +
        `E_pre ${f(lum(r.Epre), 5)} ao ${f(r.ao, 3)}/raw ${f(r.aoRaw, 3)}  ` +
        `E_ref ${f(lum(r.Eref), 4)}   probe ${r.probePos ? `c${r.cc} @[${r.probePos}] ` +
        `state ${r.state} ready ${r.ready} n ${r.nHas} T ${r.nT} sky ${r.nSky} ` +
        `d ${f(r.probeDist, 2)} m (spacing ${r.spacing})` : "NONE — no live corner in any cascade"}`);
    }
  }
  results[key] = { pose, sel: { valid: sel.valid, counts: sel.counts, colSpan: sel.colSpan }, rows, dec };
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`\n  written to ${OUT}`);
}
await browser.close();
