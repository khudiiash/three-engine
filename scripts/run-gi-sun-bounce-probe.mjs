// THE SUN-BOUNCE PROBE — drives scripts/gi-sun-bounce.html and prints the
// engine's delivered irradiance beside a path-traced truth.
//
//   npm run probe:gi-sun-bounce                      base arm
//   npm run probe:gi-sun-bounce -- base noshadow     several arms
//   npm run probe:gi-sun-bounce -- base:sky          the sky arm
//   npm run probe:gi-sun-bounce -- base:sky:occ      THE OCCLUSION LADDER
//   npm run probe:gi-sun-bounce -- base:cap0 base:cap32   THE RAY-COUNT GATE
//   npm run probe:gi-sun-bounce -- base nosec        THE BOUNCE-COUNT GATE
//   MC_DEPTH=1 npm run probe:gi-sun-bounce -- base   ...against 1-bounce truth
//   WALL_T=1.5 npm run probe:gi-sun-bounce -- base   THE THIN-GEOMETRY GATE
//   npm run probe:gi-sun-bounce -- base:lobe         THE DIRECTION SWEEP
//   npm run probe:gi-sun-bounce -- base:a0.2         __giSrcAlpha pinned
//   npm run probe:gi-sun-bounce -- plane:sky         THE CALIBRATION ARM
//   SETTLE=120 npm run probe:gi-sun-bounce           longer convergence ladder
//
// An arm spec is `arm[:tag[:tag]]`; tags are `sky`, `occ`, `a<alpha>`,
// `cap<N>`, and a quality name.
//
// ⭐ `cap<N>` pins the per-probe ray cap (0 = uncapped) and the two arms MUST
// AGREE: the bake normalises by weight, so ray count buys variance, never
// energy. If `cap0` reads brighter than `cap32`, the field's brightness depends
// on how many rays it was given — which on a live scene shows up as the user's
// "bright when it appears, darker with time", since the light-track window
// lifts the cap to OFF on any change and drops it when the window closes. `occ` swaps the bounce points for the OCCLUSION ladder and
// prints the ground-truth ambient occlusion beside each ratio — see SKY_POINTS
// in gi-sun-bounce-ref.mjs for what that ladder decides. It only means anything
// with `sky` (an occlusion ladder needs an ambient source), so it implies it.
//
// The arm name `plane` is the CALIBRATION SCENE rather than a hatch: a
// flat unoccluded slab under a uniform sky must read `E = pi*L` exactly, so run
// `plane:sky` first whenever a number here looks wrong — it separates "the
// field is short" from "the instrument is".
//
// Every arm is a fresh browser because every hatch is read at shader BUILD
// time — two arms in one page would measure the first one's kernels.
//
// ══ WHAT THE NUMBERS MEAN ══════════════════════════════════════════════════
//
// `ratio` is engine / truth at that point. 1.00 is correct. The reference is a
// 4-bounce path trace over three boxes, so it is not an approximation of the
// answer — it IS the answer, to within the Monte-Carlo noise printed at the
// bottom of `node scripts/gi-sun-bounce-ref.mjs`.
//
// Read the LADDER, not the last column alone: a field that is still climbing at
// the last mark has not converged, and "too dark" and "too slow" are different
// bugs with different fixes. Pin `a0.2` to collapse the temporal constant and
// see the plateau directly.
import puppeteer from "puppeteer-core";
import { LOBE_POINTS, SKY_POINTS, irradianceAt, PROBE_POINTS } from "./gi-sun-bounce-ref.mjs";

const BASE = process.env.RIG_URL ?? "http://localhost:5231/scripts/gi-sun-bounce.html";
const SETTLE = process.env.SETTLE ?? "60";
// ⭐ ONE env var drives BOTH the CPU truth (imported above, which reads it at
// module load) and the rig's geometry, so the two cannot disagree about where
// a wall is. See WALL_T in gi-sun-bounce-ref.mjs.
const WALL_T = process.env.WALL_T ?? null;
const specs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!specs.length) specs.push("base");

// The truth, once — the geometry is the same for every arm.
const truth = PROBE_POINTS.map((p) => ({
  shadowed: irradianceAt(p.P, p.n),
  open: irradianceAt(p.P, p.n, { withShadow: false }),
}));
// The occlusion ladder's truth is only path-traced when an arm asks for it —
// six more 200k-sample integrations is a few seconds nobody should pay to read
// a bounce number. `escape` is the cosine-weighted first-bounce sky visibility,
// i.e. the ground-truth AO factor at that point.
const wantsOcc = specs.some((sp) => sp.split(":").includes("occ"));
const wantsLobe = specs.some((sp) => sp.split(":").includes("lobe"));
// One point, nine normals — see LOBE_POINTS. Truth is the same `irradianceAt`
// both other ladders use; only the question's shape is new.
// Both truths, because `noshadow` is THE CONTROL for this sweep: it removes the
// shadow boundary and leaves everything else — same geometry, same lattice, same
// bins — so a flat ratio there says the directional machinery is accurate and
// the boundary is the entire story.
const lobeTruth = wantsLobe ? LOBE_POINTS.map((p) => irradianceAt(p.P, p.n)) : null;
const lobeTruthOpen = wantsLobe
  ? LOBE_POINTS.map((p) => irradianceAt(p.P, p.n, { withShadow: false }))
  : null;
const skyTruth = wantsOcc ? SKY_POINTS.map((p) => irradianceAt(p.P, p.n)) : null;

const pad = (s, w) => String(s).padEnd(w);
let failures = 0;

for (const spec of specs) {
  const [arm, ...tags] = spec.split(":");
  const q = tags.find((t) => /^(low|medium|high|ultra)$/.test(t));
  const a = tags.find((t) => /^a[\d.]+$/.test(t));
  const cap = tags.find((t) => /^cap\d+$/.test(t));
  const isPlane = arm === "plane";
  // `occ` implies `sky`: the ladder measures how much of an AMBIENT source each
  // point can see, and with the sun arm there is no ambient source to occlude.
  const isOcc = tags.includes("occ");
  const isLobe = tags.includes("lobe");
  const url = `${BASE}?arm=${encodeURIComponent(isPlane ? "base" : arm)}&settle=${SETTLE}` +
    (isPlane ? "&scene=plane" : "") +
    (tags.includes("sky") || isOcc ? "&sky=1" : "") +
    (isOcc ? "&points=sky" : "") +
    (isLobe ? "&points=lobe" : "") +
    (q ? `&quality=${q}` : "") +
    (a ? `&alpha=${a.slice(1)}` : "") +
    (cap ? `&cap=${cap.slice(3)}` : "") +
    (WALL_T ? `&thick=${WALL_T}` : "");

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.HEADED ? false : "new",
    userDataDir: "C:/Users/Khudiiash/AppData/Local/Temp/claude/gi-sky-chrome-profile",
    args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  page.on("pageerror", (e) => console.log(`  PAGEERROR ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !t.includes("404")) console.log(`  err: ${t.slice(0, 300)}`);
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  let out = null;
  try {
    await page.waitForFunction("globalThis.__RIG_DONE__ === true",
      { timeout: Number(process.env.WAIT_MS ?? 900000) });
    out = await page.evaluate("globalThis.__RIG_RESULT__");
  } catch { console.log(`  TIMEOUT on ${spec}`); failures++; }
  await browser.close();
  if (!out) continue;
  if (out.error) { console.log(`  ERROR ${out.error}`); failures++; }

  const isSky = tags.includes("sky");
  const isOpen = arm === "noshadow";
  console.log(`\n═══ ${out.arm} ═══  ${JSON.stringify(out.stats)}`);
  console.log(`frames: ${out.points.map((m) => `${m.t}s=${m.frames}`).join("  ")}`);
  console.log(pad("point", 26) + pad("truth", 9) +
    out.points.map((m) => pad(`t=${m.t}s`, 9)).join("") + "ratio");
  // The calibration scene's truth is analytic and needs no path trace: a flat
  // unoccluded surface under a uniform sky of radiance L receives exactly pi*L.
  const rows = isPlane ? [{ name: "open ground (E = pi*L)" }]
    : isOcc ? SKY_POINTS : isLobe ? LOBE_POINTS : PROBE_POINTS;
  rows.forEach((p, i) => {
    const t = isPlane ? Math.PI * 0.1
      : isOcc ? skyTruth[i].sky
        : isLobe ? (isOpen ? lobeTruthOpen[i].sun : lobeTruth[i].sun)
          : isSky ? truth[i].shadowed.sky : (isOpen ? truth[i].open.sun : truth[i].shadowed.sun);
    const last = out.points.at(-1)?.E?.[i]?.lum;
    console.log(
      pad(p.name, 26) + pad(t.toFixed(4), 9) +
      out.points.map((m) => pad(m.E?.[i]?.lum ?? "-", 9)).join("") +
      (last != null ? `${(last / t).toFixed(2)}x` : "-") +
      // The ground-truth AO factor beside the ratio, because the ratio is only
      // readable AGAINST it: 1.05x at V=0.95 is noise, 1.05x at V=0.08 is the
      // cascade putting an order of magnitude too much light in a corner.
      (isOcc ? `   V ${skyTruth[i].escape.toFixed(3)}` : ""),
    );
  });
  if (isLobe) {
    // ⭐ THE SHAPE IS THE VERDICT. A scale error is FLAT in theta — a
    // directional bias cannot integrate to the same fraction over every lobe
    // orientation — so print the spread explicitly rather than leaving nine
    // rows to be eyeballed. Zero readings are excluded for the reason the
    // occlusion ladder excludes them (no probe answered != no light).
    const rs = LOBE_POINTS.map((p, i) => {
      const e = out.points.at(-1)?.E?.[i]?.lum;
      const tt = (isOpen ? lobeTruthOpen : lobeTruth)[i];
      return e == null || !(Number(e) > 0)
        ? null
        : { deg: p.deg, r: Number(e) / tt.sun, esc: tt.escape };
    }).filter(Boolean);
    if (rs.length >= 3) {
      const lo = Math.min(...rs.map((x) => x.r));
      const hi = Math.max(...rs.map((x) => x.r));
      const at = (d) => rs.find((x) => x.deg === d);
      console.log(`\ndirection sweep: ratio ${lo.toFixed(2)}x .. ${hi.toFixed(2)}x ` +
        `(spread ${(hi - lo).toFixed(2)}), min at ${rs.find((x) => x.r === lo).deg}deg`);
      const down = at(-52.5), up = at(52.5);
      if (down && up) {
        console.log(`  down-facing ${down.r.toFixed(2)}x   up-facing ${up.r.toFixed(2)}x` +
          `  ->  ${(down.r / up.r).toFixed(2)}x`);
      }
      console.log(hi - lo < 0.12
        ? "  FLAT in theta — the deficit is a SCALE error, not a directional bias.\n" +
          "  ⛔ That REFUTES the known-bin extrapolation: a biased subset of directions\n" +
          "     cannot integrate to the same fraction over every lobe orientation."
        : "  DIRECTIONAL — the deficit depends on which way the lobe faces, which is\n" +
          "  what a non-random known-bin subset looks like once you can see per-direction.");
    }
  }
  if (isOcc) {
    // ⭐ THE SHAPE IS THE VERDICT, NOT ANY ONE RATIO. A gain error is flat in V
    // and cancels here; a transport/occlusion error is not, so print the trend
    // explicitly rather than leaving it to be eyeballed off six rows.
    // ⚠ A ZERO IS NOT A DATUM. Screen-anchored probes answer 0.0000 for a point
    // no probe covers — off-frustum, or hidden behind geometry — and that is
    // "the instrument could not see it", never "the engine sent no light there"
    // (gi-harness-viewport-traps). Averaged in as data it fabricates exactly
    // the deficit this ladder is looking for, which it did on the first run:
    // one hidden point pulled the open mean 0.92x -> 0.46x and doubled the
    // reported leak. So drop them from the trend and SAY SO.
    const dead = [];
    const ratios = SKY_POINTS.map((p, i) => {
      const e = out.points.at(-1)?.E?.[i]?.lum;
      if (e == null) return null;
      if (!(Number(e) > 0)) { dead.push(p.name); return null; }
      return { v: skyTruth[i].escape, r: e / skyTruth[i].sky };
    }).filter(Boolean);
    if (dead.length) {
      console.log(`
⚠ NO PROBE ANSWERED at ${dead.length} point(s): ${dead.join(", ")} — ` +
        "excluded from the trend. Move the point into the camera's view, or move the camera.");
      failures++;
    }
    const openR = ratios.filter((x) => x.v >= 0.5);
    const shutR = ratios.filter((x) => x.v < 0.25);
    const mean = (xs) => xs.reduce((a, x) => a + x.r, 0) / (xs.length || 1);
    if (openR.length && shutR.length) {
      const o = mean(openR);
      const c = mean(shutR);
      console.log(`
occlusion trend: open (V>=0.5) ${o.toFixed(2)}x, enclosed (V<0.25) ${c.toFixed(2)}x` +
        `  ->  ${(c / o).toFixed(2)}x more light per unit truth in the corners`);
      console.log(c / o > 1.25
        ? "  the CASCADE LEAKS into enclosure — AO is being asked to cover a transport deficit"
        : c / o < 0.8
          ? "  the cascade OVER-occludes — adding AO on top would crush corners"
          : "  the cascade carries occlusion in proportion; the AO report is not about this");
    }
  }

  const v = out.visibility;
  if (v) {
    console.log(`visibility on ${v.sunFacing} sun-facing traced hits ` +
      `(${v.originInsideSolid} rays discarded, born inside solid):`);
    console.log(`  agree ${v.agree}   FALSE DARK ${v.falseDark}   false lit ${v.falseLit}` +
      (v.falseDarkMedianCells != null ? `   median occluder ${v.falseDarkMedianCells} cells` : ""));
    for (const f of v.byFace) {
      console.log(`  ${pad(f.face, 4)} facing ${pad(f.facing, 7)} falseDark ${pad(f.falseDark, 9)} falseLit ${f.falseLit}`);
    }
    if (process.env.VERBOSE) for (const s of v.samples) console.log(`    ${JSON.stringify(s)}`);
  } else if (out.visibilityError) {
    console.log(`visibility: ERROR ${out.visibilityError}`);
    failures++;
  } else if (out.visibilitySkipped) {
    console.log(`visibility: ${out.visibilitySkipped}`);
  }
}

process.exit(failures ? 1 : 0);
