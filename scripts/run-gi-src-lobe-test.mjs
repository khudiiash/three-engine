// ⭐⭐⭐ THE DIRECTIONAL-CONTRAST GATE — does the cascade deliver E(n)'s SHAPE?
//
//   npm run test:gi-src-lobe
//
// ══ WHY THIS EXISTS ════════════════════════════════════════════════════════
//
// The GPU probe (`probe:gi-sun-bounce -- base:lobe`, plan §2.7j) established
// that the engine's error is NOT a scale error. Hold a point fixed, sweep the
// surface NORMAL, and the ratio against a path-traced truth runs 1.21x facing
// into shadow and 0.70x facing the light: energy CONSERVED and REDISTRIBUTED.
// Its `noshadow` control is the real finding — with no shadow anywhere the
// truth still peaks at −17.5° while the engine's curve is MONOTONE, no peak at
// all. The engine retains ~81% of the directional contrast a smooth field asks
// for and ~66% of what a discontinuous one asks for. **A low-pass on
// direction.** The shadow boundary is an amplifier, not the cause.
//
// Every point-level probe in this repo is blind to that: they integrate one
// hemisphere into one number, so a bias that cancels across directions and one
// that does not look identical.
//
// ⚠ AND EVERY REFUTATION SO FAR COST A SIX-MINUTE BROWSER ARM. Ray budget,
// wall thickness, bounce depth, bin width and tile resolution are all refuted
// (§2.7h/i/j) at roughly ten GPU minutes each. That is the wrong instrument for
// a bisection. `srcRef.js` is a CPU twin of the entire chain — buildProbes →
// assignRays → traceAndDeposit → resolveProbes → mergeCascades →
// bakeProbeIrradiance → gatherPixel — with `brutePointIrradiance` as its own
// arbiter over the SAME analytic trace. If the twin reproduces the compression,
// the stage can be found in milliseconds.
//
// ══ THE FIXTURE ═══════════════════════════════════════════════════════════
//
// One face of a closed room emits, the other five are black. That is the
// highest directional contrast a room can have and it needs no shading, so a
// failure can only be transport — the same reasoning the FURNACE arm in
// `run-gi-src-ref-test.mjs` runs on, with the uniformity deliberately broken.
//
// ⭐ THE FURNACE IS THE CONTROL AND IT IS NOT OPTIONAL. A uniform enclosure
// asks for ZERO directional contrast, so it must read 1.00x at every normal —
// and the shipped estimator already passes that (it is why the normalisation is
// π·Σ(L·cos)/Σ(cos)). Running both arms is what separates "the transport is
// broken" from "the transport is fine and only its DIRECTIONAL detail is lost".
// Without it a bad number here could just be a broken fixture.
import {
  bakeProbeIrradiance,
  brutePointIrradiance,
  gatherPixel,
  makeSrcConfig,
  runSrcFrame,
} from "../src/modules/gi/srcRef.js";
import {
  SUN_BOUNCE_CHROMA_GAIN_MAX,
  SUN_BOUNCE_CHROMA_GAIN_PER_MERGE,
  intervalBoundaries,
  sunBounceGainForCascade,
  sunBounceChromaGainForCascade,
} from "../src/modules/gi/srcConfig.js";

const ANGLES = [-70, -52.5, -35, -17.5, 0, 17.5, 35, 52.5, 70];
// `RPP=4 npm run test:gi-src-lobe` reproduces the under-sampled reading the
// banner below describes; anything >= 64 is converged.
const SAMPLE = [0, 3, 0];
const HALF = 4;
const HEIGHT = 6;

/** The analytic closed room from run-gi-src-ref-test.mjs, faces 0..5 = ∓x ∓y ∓z. */
function makeRoom(faceRadiance, distanceGain = null) {
  const min = [-HALF, 0, -HALF];
  const max = [HALF, HEIGHT, HALF];
  return function sceneTrace(origin, dir) {
    let best = Infinity;
    let face = -1;
    for (let a = 0; a < 3; a++) {
      const d = dir[a];
      if (Math.abs(d) < 1e-12) continue;
      const lo = (min[a] - origin[a]) / d;
      const hi = (max[a] - origin[a]) / d;
      if (lo > 1e-6 && lo < best) { best = lo; face = a * 2; }
      if (hi > 1e-6 && hi < best) { best = hi; face = a * 2 + 1; }
    }
    if (face < 0) return { t: -1, radiance: [0, 0, 0] };
    const radiance = faceRadiance(face);
    const gain = distanceGain ? distanceGain(best) : 1;
    return { t: best, radiance: radiance.map((v) => v * gain) };
  };
}

/**
 * Receiver pixels filling a shell around the sample point, in SIX orientations.
 *
 * ⚠ THE SIX ORIENTATIONS ARE LOAD-BEARING. Rays are cast into each pixel's own
 * hemisphere, so a single-normal pixel set leaves half of every nearby probe's
 * direction bins unsampled — and a gather over half-empty bins would measure
 * this harness's pixel layout, not the cascade ([[probe-blind-statistics]]).
 */
function shellPixels(step = 0.5, reach = 1.5) {
  const NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const pixels = [];
  for (let dx = -reach; dx <= reach + 1e-9; dx += step) {
    for (let dy = -reach; dy <= reach + 1e-9; dy += step) {
      for (let dz = -reach; dz <= reach + 1e-9; dz += step) {
        const p = [SAMPLE[0] + dx, SAMPLE[1] + dy, SAMPLE[2] + dz];
        if (p[1] <= 0.05 || p[1] >= HEIGHT - 0.05) continue;
        for (const n of NORMALS) pixels.push({ position: p, normal: n });
      }
    }
  }
  return pixels;
}

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const pad = (s, w) => String(s).padEnd(w);

function sweep(label, faceRadiance, { plane = "xy", sunDriven = false } = {}) {
  const cfg = makeSrcConfig({
    spacing0: 0.5,
    // ⚠⚠ 64, AND THE NUMBER IS LOAD-BEARING — MEASURED, NOT PICKED.
    //
    // The first run of this gate used 4 and reported a 4.62x up/down asymmetry
    // in a room that is symmetric to 1.015x. That was very nearly written up as
    // a bug in the octahedral fold. It was UNDER-SAMPLING: converging the budget
    // gives 4.62x (rpp 4) -> 1.63x (16) -> 1.20x (64) -> 1.20x (256). Everything
    // past 64 is the same number; everything below it is this harness measuring
    // itself.
    //
    // ⭐⭐ AND THE FURNACE ARM STRUCTURALLY CANNOT CATCH THAT. A uniform
    // enclosure returns pi for ANY distribution of ray directions, so it
    // validates the normalisation and says nothing whatever about directional
    // bias — the exact blind spot that makes a passing control feel like
    // permission to trust the subject ([[probe-blind-statistics]]). Any change
    // to the pixel shell or the ray budget must re-run the convergence ladder
    // before its numbers mean anything.
    raysPerPixel: Number(process.env.RPP ?? 64),
    forceLod: 0,
    sky: [0, 0, 0],
    camera: SAMPLE,
    anchor: SAMPLE,
  });
  // Prototype only: compensate the analytic-sun half at the hit according to
  // how many cascade hand-offs its owning interval must survive. The uniform
  // furnace deliberately does not take this arm: it models environment /
  // emissive radiance, which must remain energy-exact. A value of 1 leaves the
  // shipping estimator bit-identical.
  const perMergeGain = Number(process.env.SUN_MERGE_GAIN ?? 1.08);
  const directGain = Number(process.env.SUN_DIRECT_GAIN ?? 1);
  const bounds = intervalBoundaries(0, cfg.spacing0, cfg.cascadeCount);
  const truthTrace = makeRoom(faceRadiance);
  const trace = makeRoom(faceRadiance, sunDriven && perMergeGain !== 1
    ? (distance) => {
        let owner = cfg.cascadeCount - 1;
        for (let c = 0; c < cfg.cascadeCount; c++) {
          if (distance <= bounds[c]) { owner = c; break; }
        }
        const cascadeGain = process.env.SUN_MERGE_GAIN == null
          ? sunBounceGainForCascade(owner)
          : Math.min(1.2, perMergeGain ** owner);
        return directGain * cascadeGain;
      }
    : (sunDriven && directGain !== 1 ? () => directGain : null));
  const pixels = shellPixels();
  const frame = runSrcFrame(cfg, pixels, trace);

  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}`);
  console.log(pad("normal", 14) + pad("truth", 10) + pad("engine", 10) + "ratio");
  const rows = [];
  for (const deg of ANGLES) {
    const r = (deg * Math.PI) / 180;
    // "xy" tilts the normal UP/DOWN (the octahedral fold's axis); "xz" swings it
    // sideways, where the same room is equally symmetric but the y component
    // stays zero. Comparing the two isolates the y axis from everything else.
    const n = plane === "xz"
      ? [Math.cos(r), 0, Math.sin(r)]
      : [Math.cos(r), Math.sin(r), 0];
    // ⚠ `.irradiance` — the arbiter returns { irradiance, stderr, samples }, and
    // reading the object as an array yields NaN silently (caught on the first
    // run, where the ENGINE column was already perfect and only truth was NaN).
    const truth = lum(brutePointIrradiance(SAMPLE, n, truthTrace, cfg.sky, 40000, 7).irradiance);
    const got = lum(gatherPixel(cfg, frame.built, frame.tiles, SAMPLE, n));
    rows.push({ deg, truth, got, ratio: truth > 1e-9 ? got / truth : NaN });
    console.log(pad(`${deg > 0 ? "+" : ""}${deg}deg`, 14) +
      pad(truth.toFixed(4), 10) + pad(got.toFixed(4), 10) +
      (truth > 1e-9 ? `${(got / truth).toFixed(2)}x` : "-"));
  }

  const valid = rows.filter((x) => Number.isFinite(x.ratio) && x.truth > 1e-6);
  const lo = Math.min(...valid.map((x) => x.ratio));
  const hi = Math.max(...valid.map((x) => x.ratio));
  // ⭐ SYMMETRY, not "contrast retained". This room is symmetric about the
  // sweep's centre, so the TRUTH is symmetric by construction (checked, not
  // assumed) — which makes any engine asymmetry a pure defect with no physical
  // component to argue about. A max/min "range" cannot express that: it compares
  // two extremes and says nothing about which way the curve leans.
  const at = (d) => valid.find((x) => x.deg === d);
  const asym = [70, 52.5, 35, 17.5]
    .map((d) => ({ d, lo: at(-d), hi: at(d) }))
    .filter((x) => x.lo && x.hi);
  const truthAsym = Math.max(...asym.map((x) => Math.max(x.lo.truth, x.hi.truth) / Math.max(1e-9, Math.min(x.lo.truth, x.hi.truth))));
  const engineAsym = Math.max(...asym.map((x) => Math.max(x.lo.got, x.hi.got) / Math.max(1e-9, Math.min(x.lo.got, x.hi.got))));
  const mean = valid.reduce((a, x) => a + x.ratio, 0) / valid.length;
  console.log(`  ratio ${lo.toFixed(2)}x .. ${hi.toFixed(2)}x (mean ${mean.toFixed(2)}x, spread ${(hi - lo).toFixed(2)})`);
  console.log(`  worst -θ vs +θ asymmetry:  truth ${truthAsym.toFixed(2)}x   engine ${engineAsym.toFixed(2)}x`);
  let offCentreWorst = 0;
  if (sunDriven) {
    const points = [
      { p: [0.35, 3.2, 0.25], n: [1, 0, 0] },
      { p: [-0.45, 2.65, -0.3], n: [0.8660254, 0.5, 0] },
      { p: [0.2, 2.55, -0.55], n: [0.8660254, 0, 0.5] },
    ];
    const errors = points.map(({ p, n }) => {
      const truth = lum(brutePointIrradiance(p, n, truthTrace, cfg.sky, 80000, 19).irradiance);
      const got = lum(gatherPixel(cfg, frame.built, frame.tiles, p, n));
      const error = Math.abs(got - truth) / Math.max(1e-9, truth);
      offCentreWorst = Math.max(offCentreWorst, error);
      return `${p.join(",")}:${(error * 100).toFixed(1)}% (${(got / truth).toFixed(2)}x)`;
    });
    console.log(`  off-centre src/ref: ${errors.join("  ")}`);
  }
  return { spread: hi - lo, label, lo, hi, mean, truthAsym, engineAsym, offCentreWorst };
}

// ── THE CONTROL: a uniform enclosure asks for no contrast at all ───────────
const furnace = sweep("FURNACE (all six faces radiance 1) — the control",
  () => [1, 1, 1], { expectFlat: true });

// ── THE SUBJECT: one bright face, five black ──────────────────────────────
const brightX = (f) => (f === 1 ? [1, 1, 1] : [0, 0, 0]);
const vert = sweep("+x BRIGHT, normal tilted UP/DOWN (x-y plane)", brightX, { plane: "xy", sunDriven: true });
const horiz = sweep("+x BRIGHT, normal swung SIDEWAYS (x-z plane)", brightX, { plane: "xz", sunDriven: true });

// A white furnace plus a red analytic first bounce. Green/blue are a uniform
// environment control and must remain exact; R-G isolates the coloured sun
// lobe without a saturation metric changing under exposure. This is the CPU
// twin of the red-wall comparison: a broad neutral sky and one directional,
// albedo-coloured bounce share the field, but only the latter is allowed to
// take the owner-cascade compensation.
function colourSweep(label, gainPerMerge, gainMax) {
  const cfg = makeSrcConfig({
    spacing0: 0.5,
    raysPerPixel: Number(process.env.RPP ?? 64),
    forceLod: 0,
    sky: [0, 0, 0],
    camera: SAMPLE,
    anchor: SAMPLE,
  });
  const bounds = intervalBoundaries(0, cfg.spacing0, cfg.cascadeCount);
  const ownerAt = (distance) => {
    let owner = cfg.cascadeCount - 1;
    for (let c = 0; c < cfg.cascadeCount; c++) {
      if (distance <= bounds[c]) { owner = c; break; }
    }
    return owner;
  };
  // Every path pays one c0 bin -> cosine-tile angular reconstruction in
  // addition to its owning cascade's merge hand-offs. BASE_STAGE=0 retains the
  // old diagnostic arm that accidentally left c0 uncompensated.
  const baseStages = Number(process.env.BASE_STAGE ?? 1);
  const productionDefault = process.env.SUN_CHROMA_GAIN == null
    && process.env.SUN_CHROMA_MAX == null && process.env.BASE_STAGE == null;
  const gainAt = (distance) => productionDefault
    ? sunBounceChromaGainForCascade(ownerAt(distance))
    : Math.min(gainMax, gainPerMerge ** (ownerAt(distance) + baseStages));
  const mixedFace = (face) => face === 1 ? [1.25, 0.25, 0.25] : [0.25, 0.25, 0.25];
  const truthTrace = makeRoom(mixedFace);
  const mixedTrace = (redGainAt) => {
    const min = [-HALF, 0, -HALF];
    const max = [HALF, HEIGHT, HALF];
    return (origin, dir) => {
      let best = Infinity, face = -1;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(dir[a]) < 1e-12) continue;
        const lo = (min[a] - origin[a]) / dir[a];
        const hi = (max[a] - origin[a]) / dir[a];
        if (lo > 1e-6 && lo < best) { best = lo; face = a * 2; }
        if (hi > 1e-6 && hi < best) { best = hi; face = a * 2 + 1; }
      }
      if (face < 0) return { t: -1, radiance: [0, 0, 0] };
      const red = face === 1 ? redGainAt(best) : 0;
      return { t: best, radiance: [0.25 + red, 0.25, 0.25] };
    };
  };
  // Current production already applies the conservative achromatic sun gain
  // to the whole albedo. The candidate changes only the chromatic remainder,
  // so this comparison is incremental rather than against an obsolete raw arm.
  const baseTrace = mixedTrace((distance) => sunBounceGainForCascade(ownerAt(distance)));
  const correctedTrace = mixedTrace(gainAt);
  const pixels = shellPixels();
  const baseFrame = runSrcFrame(cfg, pixels, baseTrace);
  const frame = runSrcFrame(cfg, pixels, correctedTrace);
  const rows = [];
  for (const deg of ANGLES) {
    const r = deg * Math.PI / 180;
    const n = [Math.cos(r), Math.sin(r), 0];
    const truth = brutePointIrradiance(SAMPLE, n, truthTrace, cfg.sky, 40000, 7).irradiance;
    const base = gatherPixel(cfg, baseFrame.built, baseFrame.tiles, SAMPLE, n);
    const got = gatherPixel(cfg, frame.built, frame.tiles, SAMPLE, n);
    const truthRed = truth[0] - truth[1];
    const baseRed = base[0] - base[1];
    const gotRed = got[0] - got[1];
    if (truthRed > 1e-4) rows.push({
      deg,
      neutral: got[1] / Math.max(1e-9, truth[1]),
      base: baseRed / truthRed,
      ratio: gotRed / truthRed,
    });
  }
  const mean = (key) => rows.reduce((a, x) => a + x[key], 0) / rows.length;
  const out = {
    neutral: mean("neutral"),
    base: mean("base"),
    mean: mean("ratio"),
    min: Math.min(...rows.map((x) => x.ratio)),
    max: Math.max(...rows.map((x) => x.ratio)),
    offCentreWorst: 0,
  };
  const points = [
    { p: [0.35, 3.2, 0.25], n: [1, 0, 0] },
    { p: [-0.45, 2.65, -0.3], n: [0.8660254, 0.5, 0] },
    { p: [0.2, 2.55, -0.55], n: [0.8660254, 0, 0.5] },
  ];
  const offCentre = points.map(({ p, n }) => {
    const truth = brutePointIrradiance(p, n, truthTrace, cfg.sky, 80000, 23).irradiance;
    const got = gatherPixel(cfg, frame.built, frame.tiles, p, n);
    const truthRed = truth[0] - truth[1];
    const gotRed = got[0] - got[1];
    const error = Math.abs(gotRed - truthRed) / Math.max(1e-9, truthRed);
    out.offCentreWorst = Math.max(out.offCentreWorst, error);
    return `${p.join(",")}:${(error * 100).toFixed(1)}% (${(gotRed / truthRed).toFixed(2)}x)`;
  });
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}`);
  console.log(`  neutral furnace ${out.neutral.toFixed(3)}x; red excess current ${out.base.toFixed(3)}x -> candidate ${out.mean.toFixed(3)}x`);
  console.log(`  candidate red-excess range ${out.min.toFixed(3)}x .. ${out.max.toFixed(3)}x`);
  console.log(`  off-centre red-excess src/ref: ${offCentre.join("  ")}`);
  return out;
}

const colour = colourSweep(
  "NEUTRAL SKY + RED ANALYTIC BOUNCE",
  Number(process.env.SUN_CHROMA_GAIN ?? SUN_BOUNCE_CHROMA_GAIN_PER_MERGE),
  Number(process.env.SUN_CHROMA_MAX ?? SUN_BOUNCE_CHROMA_GAIN_MAX),
);

console.log("\n── VERDICT ──────────────────────────────────────────────────────");
const fail = [];
// The furnace is the fixture check: E = π at every normal, so any spread here
// is the harness and nothing below it can be believed.
if (!Number.isFinite(furnace.spread) || !Number.isFinite(vert.spread) || !Number.isFinite(horiz.spread)) {
  fail.push("a sweep produced non-finite numbers — the arbiter or the gather returned " +
    "something other than what this harness assumes; fix that before reading any verdict.");
} else if (furnace.spread > 0.06) {
  fail.push(`FURNACE is not flat (spread ${furnace.spread.toFixed(2)}) — the fixture ` +
    "or the pixel shell is wrong, so the subject arm proves nothing.");
} else if (Math.abs(furnace.mean - 1) > 0.02) {
  // A scene-wide indirect gain is the tempting zero-cost answer to the dark
  // directional arms below. It is not a correction: the uniform enclosure is
  // already energy-exact, and a flat 1.25x furnace still has ZERO spread. Pin
  // the absolute mean as well as the shape so that shortcut cannot pass this
  // gate while breaking every uniform-sky scene.
  fail.push(`FURNACE has the right shape but the wrong energy (${furnace.mean.toFixed(3)}x; want 1.00x) — ` +
    "a global indirect gain cannot repair the directional merge deficit.");
}
if (vert.mean < 0.8 || horiz.mean < 0.9) {
  fail.push(`analytic first-bounce compensation missed its bounded target ` +
    `(up/down ${vert.mean.toFixed(2)}x, sideways ${horiz.mean.toFixed(2)}x)`);
}
if (vert.hi > 1.2 || horiz.hi > 1.2) {
  fail.push(`analytic first-bounce compensation exceeded its 1.20x bound ` +
    `(up/down ${vert.hi.toFixed(2)}x, sideways ${horiz.hi.toFixed(2)}x)`);
}
if (vert.offCentreWorst > 0.18 || horiz.offCentreWorst > 0.18) {
  fail.push(`off-centre source/reference error escaped its 18% bound ` +
    `(up/down ${(vert.offCentreWorst * 100).toFixed(1)}%, ` +
    `sideways ${(horiz.offCentreWorst * 100).toFixed(1)}%)`);
}
if (Math.abs(colour.neutral - 1) > 0.02) {
  fail.push(`coloured-bounce compensation moved neutral furnace energy (${colour.neutral.toFixed(3)}x)`);
}
if (colour.mean < 0.9 || colour.max > 1.25) {
  fail.push(`coloured first-bounce correction missed its bounded target ` +
    `(mean ${colour.mean.toFixed(2)}x, max ${colour.max.toFixed(2)}x)`);
}
if (colour.mean < colour.base + 0.1) {
  fail.push(`coloured first-bounce correction did not materially improve the current base gain ` +
    `(${colour.base.toFixed(3)}x -> ${colour.mean.toFixed(3)}x)`);
}
if (colour.offCentreWorst > 0.2) {
  fail.push(`coloured first-bounce off-centre error escaped its 20% bound ` +
    `(${(colour.offCentreWorst * 100).toFixed(1)}%)`);
}
console.log(`furnace   spread ${furnace.spread.toFixed(2)}   (a uniform room must read 1.00x at every normal)`);
console.log(`up/down   engine asymmetry ${vert.engineAsym.toFixed(2)}x   against a truth of ${vert.truthAsym.toFixed(2)}x`);
console.log(`sideways  engine asymmetry ${horiz.engineAsym.toFixed(2)}x   against a truth of ${horiz.truthAsym.toFixed(2)}x`);

if (!fail.length) {
  console.log("");
  console.log("THE BOUNDED ANALYTIC FIRST-BOUNCE CORRECTIONS PASS.");
  console.log(`  Achromatic lobe means remain ${vert.mean.toFixed(2)}x up/down and ${horiz.mean.toFixed(2)}x sideways;`);
  console.log(`  mixed red excess improves ${colour.base.toFixed(3)}x -> ${colour.mean.toFixed(3)}x, with ` +
    `${(colour.offCentreWorst * 100).toFixed(1)}% worst off-centre error.`);
  console.log(`  A uniform enclosure remains EXACT (1.00x, spread ${furnace.spread.toFixed(2)}) because`);
  console.log("  environment/emissive/recursive radiance does not take this analytic-sun-only path.");
  console.log("  The remaining achromatic residual is directional transport error, not permission for a global gain.");
  if (vert.engineAsym > 1.15 || horiz.engineAsym > 1.15) {
    console.log("");
    console.log(`  ▶ Secondary: a symmetric room reads asymmetrically (${vert.engineAsym.toFixed(2)}x up/down,`);
    console.log(`    ${horiz.engineAsym.toFixed(2)}x sideways, against a truth of ~1.01x). Smaller than the`);
    console.log("    deficit and worth its own unit; do NOT chase it at low RPP (see the banner).");
  }
}

if (fail.length) {
  console.log("");
  console.log("FAIL:");
  for (const f of fail) console.log("  " + f);
  process.exit(1);
}
