// GI GREEN-CAST TERM DECOMPOSITION (§18.15, 2026-08-25)
//
// THE REPORT this exists for: "all reflections are greenish" on Bistro, while
// the scene itself looks right. Four theories have now been wrong about it, all
// of them plausible from reading the code, none of them measured:
//   1. the scene's own green neon
//   2. the §18.7 emitter power cull removing the warm balance
//   3. the probe-atlas chroma import (real defect, fixed, not this bug)
//   4. the 4 m emitter march cap at reflection hits (real defect, raised to
//      16 m — and the cast survived it, which is why this file exists)
//
// The reason code-reading keeps losing is structural: the reflected radiance is
// a SUM of four independently-sourced terms and `bvhRadiance` only ever shows
// the sum. So this drives the §18.15 TERM MASK — a vec4 uniform inside
// createGiBvhHitShade, one scalar per term — and reads the §18.13 colour probe
// back once per arm. Each arm isolates one term of
//
//     hitE = gather·x  ->  blend(probe atlas)·y  +  emitter·z  +  analytic·w
//
// and the arm whose green ratio is high is the source. No rebuild between arms:
// the mask is live, so five arms cost seconds instead of five 50 s Bistro
// builds — which is the difference between an experiment that gets run and one
// that gets argued about.
//
// It also dumps the FULL emitter ledger (all 116, not the console's top six),
// because "is the scene's emitted light actually green?" is a question about an
// aggregate that the top-six log cannot answer either way.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort   (if not up)
//   node scripts/run-gi-green-terms.mjs
//
// Env:
//   PROJECT=<path>   default C:/Users/Khudiiash/Documents/GAME
//   SCENE=<path>     default <project>/scenes/Bistro.scene (opened only if the
//                    boot scene differs)
//   SETTLE=45        frames the probe waits after each arm switch
//   HEADED=1
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = (process.env.SCENE ?? `${PROJECT}/scenes/Bistro.scene`).replaceAll("\\", "/");
const SETTLE = Number(process.env.SETTLE ?? 45);
// The hit path's trace ADMISSION multiplier (`__giHitEmitterTraceScale`,
// shipped 24). Slots below it are not marched and keep shadow = 1 — dim
// emitter light is delivered through walls, "a bounded exception, reflections
// only". TRACESCALE=1 is the arm where nothing visible is unshadowed.
const TRACESCALE = process.env.TRACESCALE ? Number(process.env.TRACESCALE) : null;
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// x = field gather, y = probe-atlas blend, z = emitter direct, w = analytic/sun.
const ARMS = [
  { label: "all (shipped)", mask: [1, 1, 1, 1] },
  { label: "gather only", mask: [1, 0, 0, 0] },
  { label: "probe atlas only", mask: [0, 1, 0, 0] },
  { label: "emitter only", mask: [0, 0, 1, 0] },
  { label: "analytic only", mask: [0, 0, 0, 1] },
  { label: "all minus probe", mask: [1, 0, 1, 1] },
  { label: "all minus emitter", mask: [1, 1, 0, 1] },
];

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
// ⚠ REFLECTIONS ARE OFF IN THE SAVED SCENE, AND FLIPPING THEM LIVE IS NOT THE
// SAME EXPERIMENT. The user's Bistro carries `global-illumination.reflections:
// false`, so a plain boot has no exact-reflection chain at all. Setting the prop
// after load does turn it on — but it rebuilds the GI mid-session, and the run
// that tried it read `bvhRadiance` as UNIFORMLY BLACK on every arm including
// sun-only: a second compile wave was still landing while the arms were being
// sampled. Patching the scene as it is READ turns reflections on for the FIRST
// build, which is the state the baseline was measured in. Nothing is written
// back — this rewrites the bytes in flight, the file on disk is untouched.
const patchScene = (path) => {
  const text = fs.readFileSync(path, "utf8");
  if (!path.replaceAll("\\", "/").toLowerCase().endsWith(SCENE.toLowerCase().split("/").pop())) return text;
  try {
    const doc = JSON.parse(text);
    let flipped = 0;
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { for (const n of node) visit(n); return; }
      if (node.c === "global-illumination" && node.v && node.v.reflections === false) {
        node.v.reflections = true;
        flipped++;
      }
      if (node.type === "global-illumination" && node.props?.reflections === false) {
        node.props.reflections = true;
        flipped++;
      }
      for (const v of Object.values(node)) visit(v);
    };
    visit(doc);
    if (flipped) console.log(`  [shim] forced global-illumination.reflections = true (${flipped} site(s)) at scene READ`);
    return JSON.stringify(doc);
  } catch {
    return text;
  }
};
await installTauriShim(page, {
  extraCommands: {
    load_scene: (args) => patchScene(args.path),
    read_text_file: (args) => (/\.scene$/i.test(args.path ?? "") ? patchScene(args.path) : fs.readFileSync(args.path, "utf8")),
  },
});

let builtCount = 0;
let readySeen = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) builtCount++;
  // "field ready" is not a line this build prints on every path — waiting only
  // for it burned the full 300 s timeout on the first two runs. The first-pass
  // dispatch is the event that actually matters here (the reflection chain has
  // real inputs from then on), and the colour probe has its own settle gate
  // anyway.
  if (/\[gi\] field ready|field first pass dispatched/.test(t)) readySeen = true;
  if (/colour probe|emitter ledger|emitter seats|exact reflections|\[gi\] built|field ready|compile wave: materials/.test(t)) {
    console.log(`  ${t.slice(0, 400)}`);
  }
});
// ⚠ THE RENDERER SOMETIMES FAILS TO COME UP AT ALL — `Engine.init` throws
// "Cannot read properties of null (reading 'backend')", i.e. no WebGPU device,
// and the editor then retries forever behind a dead renderer. It hit 2 of the
// first 4 runs here, always shortly after a previous instance was killed, so
// the likely cause is GPU memory not yet released (this scene is a 2.8M-tri
// BVH plus a 274 MB occupancy field, alongside the user's own live editor).
// Counted rather than merely logged: a run that measures nothing must SAY it
// failed to boot, not sit at a 300 s timeout looking like a slow build.
let initFailures = 0;
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (/reading 'backend'/.test(msg)) initFailures++;
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 300)}`);
});

await page.evaluateOnNewDocument((PROJECT, SETTLE, TRACESCALE) => {
  globalThis.__editorKeepRendering = true;
  if (TRACESCALE != null) globalThis.__giHitEmitterTraceScale = TRACESCALE;
  // ⚠ THE MASK IS BUILD-TIME OPT-IN. It must exist BEFORE the GI system builds
  // its kernels or the uniform is never created and every arm below silently
  // measures the same shipped image — the blind-instrument failure this whole
  // section of the plan is about.
  globalThis.__giHitTermMask = [1, 1, 1, 1];
  globalThis.__giColourProbe = true;
  globalThis.__giColourProbeRun = 0;
  globalThis.__giColourProbeSettle = SETTLE;
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
}, PROJECT, SETTLE, TRACESCALE);

const bootOnce = async () => {
  initFailures = 0;
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (initFailures >= 3) return false;
    const up = await page.evaluate(() => !!globalThis.__editorApi).catch(() => false);
    if (up) return true;
    await wait(1000);
  }
  return false;
};
let booted = false;
const call = async (op, args = {}) => {
  try {
    return await page.evaluate(async ({ op, args }) => {
      try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, { op, args });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
};

// ⚠ THE DEVICE FAILS ON THE SCENE LOAD, NOT ONLY ON THE FIRST BOOT. Opening
// Bistro re-inits the engine, and on 3 of 6 runs here that init came back with
// no WebGPU device at all (`Engine.init` → "reading 'backend'" on a null
// renderer) — the scene is a 2.8M-tri BVH plus a 274 MB occupancy field, next
// to the user's own live editor on the same GPU. So the retry has to wrap the
// LOAD, not just the hub click, and it has to be able to tell "still building"
// from "the renderer is gone": `builtCount` rising is the only proof of life.
const openScene = async () => {
  const scene = await call("scene.get");
  const openPath = (scene.value?.path ?? "").replaceAll("\\", "/");
  if (openPath.toLowerCase() === SCENE.toLowerCase()) return true;
  console.log(`  opening ${SCENE} (boot scene was ${openPath || "none"})`);
  const before = builtCount;
  initFailures = 0;
  await call("scene.open", { path: SCENE });
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    if (builtCount > before) return true;
    if (initFailures >= 3) return false;
    await wait(1000);
  }
  return false;
};

let ready = false;
for (let attempt = 1; attempt <= 4 && !ready; attempt++) {
  if (!booted) {
    booted = await bootOnce();
    if (!booted) {
      console.log(`  boot attempt ${attempt} FAILED (no WebGPU device) — waiting 45 s for the GPU to drain`);
      await wait(45000);
      continue;
    }
  }
  ready = await openScene();
  if (!ready) {
    console.log(`  scene-load attempt ${attempt} FAILED (no WebGPU device) — reloading after 45 s`);
    booted = false;
    await wait(45000);
  }
}
if (!ready) {
  console.log("⛔ NO BOOT: the renderer never came up, so nothing below would be a measurement. Aborting.");
  await browser.close();
  process.exit(1);
}

// ⚠ THE SCENE ON DISK CAN HAVE REFLECTIONS OFF. The user's Bistro is saved with
// `global-illumination.reflections: false` (it was flipped off during an
// earlier investigation and autosaved), and with it off there is no exact-
// reflection chain at all: no hit shade, no term mask, and a rig that would
// have measured the diffuse frame while claiming to report on reflections.
// Turned ON here, explicitly, and the seat/arm reads below still refuse to run
// if the chain never appears.
const gi = async (fn) => page.evaluate(async (src) => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const system = engine?.modules?.get?.("gi")?.system;
  // eslint-disable-next-line no-new-func
  return new Function("system", "engine", `return (${src})(system, engine)`)(system, engine);
}, fn.toString());

{
  // `entity.list` has no component filter, so the match happens here. The
  // component list's shape is not pinned down by the op's contract — accept an
  // array of names, an array of {type}, or a keyed object rather than assume.
  const list = await call("entity.list", {});
  const rows = Array.isArray(list.value) ? list.value : (list.value?.entities ?? []);
  const hasGi = (e) => {
    const c = e?.components;
    if (!c) return false;
    if (Array.isArray(c)) return c.some((x) => (typeof x === "string" ? x : x?.type) === "global-illumination");
    return Object.keys(c).includes("global-illumination");
  };
  const target = rows.find(hasGi);
  // VERIFY ONLY — the shim already forced it on at scene read, and setting the
  // prop here would rebuild the GI a second time, which is what produced a
  // whole table of black readings last run.
  const live = await gi((system) => system?.config?.reflections);
  console.log(
    `  global-illumination on "${target?.name ?? "?"}": reflections = ${live}` +
    (live === false ? "  ⛔ still off — the scene patch did not take" : ""),
  );
}

// The chain must be LIVE before any arm means anything — the §18.13 probe's own
// first cut measured empty textures and called them black.
console.log("  waiting for the first field + the reflection chain…");
{
  const t0 = Date.now();
  while (!readySeen && Date.now() - t0 < 300000) await wait(2000);
}
console.log(`  field ready: ${readySeen}, gi builds: ${builtCount}`);

// ── THE EMITTER AGGREGATE ────────────────────────────────────────────────────
const ledger = await gi((system) => {
  const rows = system?._emitterLedger;
  if (!Array.isArray(rows) || !rows.length) return null;
  let total = 0;
  const wsum = [0, 0, 0];
  for (const e of rows) {
    total += e.power;
    const s = e.rgb[0] + e.rgb[1] + e.rgb[2];
    // Power-weighted CHROMA: normalise each emitter's colour so a bright white
    // emitter cannot read as "colourful" merely by being bright.
    if (s > 1e-6) for (let i = 0; i < 3; i++) wsum[i] += (e.power * e.rgb[i]) / s;
  }
  const green = rows
    .filter((e) => e.rgb[1] > 1.4 * ((e.rgb[0] + e.rgb[2]) / 2 + 1e-6))
    .sort((a, b) => b.power - a.power);
  return {
    count: rows.length,
    totalPower: total,
    weightedChroma: wsum.map((v) => v / Math.max(1e-9, total)),
    greenCount: green.length,
    greenPower: green.reduce((a, e) => a + e.power, 0),
    greenTop: green.slice(0, 5).map((e) => ({ name: e.name, power: e.power, rgb: e.rgb, area: e.area })),
  };
});
console.log("\n══ EMITTER AGGREGATE ══");
if (!ledger) {
  console.log("  no ledger — `_emitterLedger` absent (light tree off, or an older build).");
} else {
  const c = ledger.weightedChroma;
  const gr = c[1] / Math.max(1e-6, (c[0] + c[2]) / 2);
  console.log(
    `  ${ledger.count} emitters, total power ${ledger.totalPower.toFixed(2)}; ` +
    `power-weighted chroma ${c.map((v) => v.toFixed(3)).join("/")} green x${gr.toFixed(2)}`,
  );
  console.log(
    `  strongly-green emitters: ${ledger.greenCount} carrying ` +
    `${(100 * ledger.greenPower / Math.max(1e-9, ledger.totalPower)).toFixed(1)}% of scene emitted power`,
  );
  for (const e of ledger.greenTop) {
    console.log(`    "${e.name}" P=${e.power.toExponential(2)} rgb=${e.rgb.map((v) => v.toFixed(2)).join("/")} area=${e.area.toExponential(1)}m²`);
  }
}

// ── THE FOUR SEATS THE HIT SHADING ACTUALLY USES ─────────────────────────────
// The reflection-hit path deliberately uses the GLOBAL emitter seats, not the
// per-pixel tile cut (giScreen: "a hit is a different world point — its tile is
// not this pixel's"). So the entire scene's reflections are lit by whatever
// four emitters `#chooseEmitterSeats` promoted. On a scene with 116 emitters
// and 17 green ones, WHICH FOUR is the whole question, and nothing logged it.
const seats = await gi((system) => {
  const slots = system?.state?.emitterSlots ?? [];
  return slots.map((s, i) => ({
    i,
    rgb: [s.color.value.r, s.color.value.g, s.color.value.b],
    radius: s.radius.value,
    reff: s.reff?.value ?? 0,
    center: [s.center.value.x, s.center.value.y, s.center.value.z],
  }));
});
console.log("\n══ EMITTER SEATS (the four the reflection hits are lit by) ══");
for (const s of seats ?? []) {
  const lum = 0.2126 * s.rgb[0] + 0.7152 * s.rgb[1] + 0.0722 * s.rgb[2];
  const gr = s.rgb[1] / Math.max(1e-6, (s.rgb[0] + s.rgb[2]) / 2);
  console.log(
    `  slot ${s.i}: rgb ${s.rgb.map((v) => v.toFixed(2)).join("/")} green x${gr.toFixed(2)} ` +
    `lum ${lum.toFixed(2)} r ${s.radius.toFixed(2)}m at ${s.center.map((v) => v.toFixed(1)).join(",")}`,
  );
}

// ── THE ARMS ─────────────────────────────────────────────────────────────────
const armed = await gi((system) => !!system?._giHitTermMaskU);
if (!armed) {
  console.log(
    "\n⛔ THE TERM MASK IS NOT ARMED (`_giHitTermMaskU` absent). Every arm below would " +
    "measure the same shipped image. The mask is BUILD-TIME opt-in and the global must " +
    "exist before the GI build — check evaluateOnNewDocument ran, and that this build " +
    "has the §18.15 `termMask` parameter.",
  );
  await browser.close();
  process.exit(1);
}

// ⛔ A BLACK `bvhRadiance` IS A BROKEN READING, NOT A RESULT. The previous run
// printed a full table of x0.00 — every arm, including sun-only — and called
// the greenest term "gather only". That is a rig reporting confidently about a
// subject it could not see, which is the FIFTH time in this investigation. The
// arms are only meaningful if the SHIPPED image has light in it, so that is now
// a precondition with its own retry and its own loud failure.
const armIsBlack = (lines) => {
  const line = (lines ?? []).find((l) => l.startsWith("bvhRadiance"));
  if (!line) return true;
  const m = /rgb ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(line);
  if (!m) return true;
  return (+m[1] + +m[2] + +m[3]) < 0.5;
};

const runArm = async (arm, index) => {
  await page.evaluate(({ mask, run }) => {
    globalThis.__giHitTermMask = mask;
    globalThis.__giColourProbeRun = run;
  }, { mask: arm.mask, run: index + 1 });
  const t0 = Date.now();
  let result = null;
  while (Date.now() - t0 < 90000) {
    await wait(1000);
    result = await gi((system) => (system?._colourProbeDone ? system?._colourProbeResult : null));
    if (result) break;
  }
  return result;
};

// The precondition: the SHIPPED image must have light in it. Retried, because
// the honest failure modes here are "the chain has not dispatched yet" and "a
// compile wave is still landing", both of which pass with time.
{
  let ok = false;
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    const lines = await runArm({ label: "warmup", mask: [1, 1, 1, 1] }, 100 + attempt);
    ok = !armIsBlack(lines);
    if (!ok) console.log(`  warmup ${attempt}: bvhRadiance is BLACK — waiting 20 s (a compile wave, or the chain has not dispatched)`);
    if (!ok) await wait(20000);
  }
  if (!ok) {
    console.log(
      "\n⛔ bvhRadiance IS BLACK with every term on. That is a broken reading, not a colour " +
      "result — the arms below would all report x0.00 and the 'greenest term' line would be " +
      "meaningless. Aborting instead of printing a table of zeros.",
    );
    await browser.close();
    process.exit(1);
  }
}

const parse = (lines, stage) => {
  const line = (lines ?? []).find((l) => l.startsWith(stage));
  if (!line) return null;
  const m = /rgb ([\d.]+)\/([\d.]+)\/([\d.]+) green x([\d.]+).*sat ([\d.]+)/.exec(line);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], green: +m[4], sat: +m[5] };
};

console.log(
  `\n══ TERM DECOMPOSITION (bvhRadiance — the texture materials sample)` +
  `${TRACESCALE != null ? `, traceCutoffScale ${TRACESCALE}` : ""} ══`,
);
console.log("arm                    rgb                     green   sat     lum");
const table = [];
for (let i = 0; i < ARMS.length; i++) {
  const arm = ARMS[i];
  if (ONLY && !ONLY.includes(arm.label)) continue;
  const lines = await runArm(arm, i);
  const s = parse(lines, "bvhRadiance");
  if (!s) {
    console.log(`${arm.label.padEnd(22)} (no reading — probe did not report)`);
    continue;
  }
  const lum = 0.2126 * s.r + 0.7152 * s.g + 0.0722 * s.b;
  table.push({ ...arm, ...s, lum });
  console.log(
    `${arm.label.padEnd(22)} ${s.r.toFixed(1).padStart(6)}/${s.g.toFixed(1).padStart(6)}/${s.b.toFixed(1).padStart(6)}` +
    `   x${s.green.toFixed(2)}   ${s.sat.toFixed(3)}   ${lum.toFixed(1).padStart(6)}`,
  );
  // The other stages only need reporting once — they do not depend on the mask.
  if (i === 0) {
    for (const stage of ["bvhColor", "irradiance", "reflProbeAtlas"]) {
      const o = parse(lines, stage);
      if (o) {
        console.log(
          `  (${stage.padEnd(14)} ${o.r.toFixed(1)}/${o.g.toFixed(1)}/${o.b.toFixed(1)}  green x${o.green.toFixed(2)}  sat ${o.sat.toFixed(3)})`,
        );
      }
    }
  }
}

console.log("\n══ VERDICT ══");
const base = table.find((t) => t.label === "all (shipped)");
if (base) {
  const contributors = table.filter((t) => t.mask.reduce((a, v) => a + v, 0) === 1);
  const worst = contributors.slice().sort((a, b) => b.green - a.green)[0];
  console.log(
    `  shipped green x${base.green.toFixed(2)}. Isolated terms, greenest first: ` +
    contributors.slice().sort((a, b) => b.green - a.green)
      .map((t) => `${t.label} x${t.green.toFixed(2)} (lum ${t.lum.toFixed(1)})`).join(", "),
  );
  console.log(
    "  ⚠ A GREEN TERM ONLY MATTERS IN PROPORTION TO ITS LUMINANCE — a tiny term at x3 " +
    "tints nothing. Read the `all minus X` rows: the one whose REMOVAL drops the green " +
    "ratio toward 1.00 is the cause.",
  );
  for (const t of table.filter((x) => x.label.startsWith("all minus"))) {
    console.log(`  ${t.label.padEnd(22)} green x${t.green.toFixed(2)} (shipped x${base.green.toFixed(2)}) — Δ ${(t.green - base.green).toFixed(2)}`);
  }
  if (worst) console.log(`  greenest single term: ${worst.label}`);
}

await page.evaluate(() => { globalThis.__giHitTermMask = [1, 1, 1, 1]; });
await browser.close();
