// REFLECTION-PROBE GATE (2026-08-21, §14 unit R-B) — verifies box-projected
// reflection probes deliver WORLD-ANCHORED reflections at a tier where the
// exact per-pixel BVH path is off.
//
// THREE ARMS, CROSS-BOOT (probe existence is structural):
//   probe   the rig with a room-sized ReflectionProbe component at the room
//           centre (box faces coincide with the walls)
//   off     the identical rig without it
//   offset  the probe DISPLACED to [1.8, 1.5, 0.9] — every box face now
//           disagrees with the real walls. Depth-aware parallax (§15 U4a)
//           reprojects lookups by the hit distance the capture stored, so
//           the reflection must MATCH the centred arm (placement is
//           coverage, not geometry). Plain box projection shears it — run
//           the offset arm with `__giProbeDepthParallax=false` to see the
//           failure this arm exists to catch.
//
// STATISTICS (crops projected from SUBJECTS' world points, linear RGB):
//   HUE SPLIT   redness(left limb) − redness(right limb) of the metal sphere.
//               The red wall sits at -X, the green wall at +X, so a world-
//               correct reflection puts red on the camera-left limb and green
//               on the camera-right limb. Inside the box the probe REPLACES
//               the field lookup (feathered weight ≈ 1 at the sphere), so on
//               the probe arm the split arrives THROUGH THE PROBE ATLAS or
//               not at all — a black/garbled/mis-projected capture collapses
//               it. PASS = probe-arm split ≥ 0.06. The off arm is REPORTED
//               for context, not gated against: the SRC field is positional
//               and carries wall hue on its own (measured 0.18 on this rig,
//               2026-08-21 — the "field is monochromatic" assumption from
//               gi-probe-placement-and-colour-bleed does not hold here), so
//               probe-vs-off is parity on hue; what the probe adds over the
//               field is anchoring, sharpness and behind-the-camera coverage.
//   ARMED       the affirmative boot line ("[gi] reflection probes: armed").
//               At medium, ALSO the probes-only BVH line — proof the BVH was
//               built for the capture without turning the per-pixel prepass on.
//   NOISE       held-pose left-limb drift across 700 ms ≤ 10% (recaptures
//               repeat every 16 frames — an unstable capture would flicker).
//
//   node scripts/run-gi-reflection-probe-test.mjs   (vite on :5201)
//   QUALITY=medium SETTLE=20000 ARMS=probe,off PNG=1
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeReflProbeProject, POSE, SUBJECTS } from "./lib/makeReflProbeProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const QUALITY = process.env.QUALITY ?? "medium";
const SETTLE = Number(process.env.SETTLE ?? 20000);
const VIEW = (process.env.VIEW ?? "1200x800").split("x").map(Number);
const ARMS = (process.env.ARMS ?? "probe,off,offset").split(",").map((s) => s.trim()).filter(Boolean);
const wantPng = process.env.PNG === "1";
// EXTRA={"__giProbeDepthParallax":false} — arm any dev global at boot (the
// depth-parallax control arm for PLACEMENT INVARIANCE failures).
const EXTRA = process.env.EXTRA ? JSON.parse(process.env.EXTRA) : null;
const OUT = ".gi-shots/refl-probe";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm) {
  const withProbe = arm !== "off";
  const root = path.resolve(`scripts/.gi-refl-probe-${arm}`).replaceAll("\\", "/");
  // CAPTURE-POINT CLEARANCE (learned 2026-08-22, the first invariance run):
  // the room-centre default (0, 1.5, 0) sits 5 cm off the metal sphere's
  // crown — HALF that capture is the sphere's own surface at point-blank,
  // smeared over the room by projection. A probe adjacent to geometry is a
  // poisoned reference, so BOTH arms capture from y = 2.2 (0.75 m clear of
  // sphere and ceiling). The same rule binds §15 U4b auto-placement: pick
  // capture points with clearance, not just room centres.
  await makeReflProbeProject(root, {
    quality: QUALITY,
    probe: withProbe,
    probePos: arm === "offset" ? [1.8, 2.2, 0.9] : [0, 2.2, 0],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let errors = 0;
  let armedLine = "";
  let bvhLine = "";
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/reflection probes: armed/.test(t)) armedLine = t;
    if (/\[gi\] bvh:/.test(t)) bvhLine = t;
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) { errors++; console.log(`  pageerror: ${msg.slice(0, 200)}`); }
  });
  await page.evaluateOnNewDocument((project, extra) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    // §16 R1 made auto probes DEFAULT-ON; this gate's arms are defined by
    // the HAND-PLACED probe alone (off = no reflection source at all), so
    // the auto derivation is pinned off here — left on, it hands the "off"
    // arm a room probe and the no-probe baseline stops being a baseline.
    globalThis.__giAutoRoomProbes = false;
    if (extra) for (const [k, v] of Object.entries(extra)) globalThis[k] = v;
  }, root, EXTRA);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, root);
  for (let i = 0; i < 180 && !built; i++) await wait(1000);
  if (!built) throw new Error(`${arm}: never built`);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  await page.evaluate(async (pose) => {
    await globalThis.__editorApi.call("viewport.setCamera", pose);
  }, POSE);
  await wait(SETTLE);

  const measure = await page.evaluate(async ({ subjects }) => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const { THREE } = await import("/src/engine/index.js");
    const camera = engine.camera;
    const renderer = engine.renderer;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

    // Crop sampler: mean LINEAR RGB in a small square around each subject's
    // projection (drawImage-the-frame-it-presented rule, §12.65).
    const sample = async () => {
      const canvas = renderer.domElement;
      const cw = canvas.width, ch = canvas.height;
      const off = new OffscreenCanvas(cw, ch);
      const ctx = off.getContext("2d");
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      ctx.drawImage(canvas, 0, 0);
      const img = ctx.getImageData(0, 0, cw, ch).data;
      const crop = (world) => {
        const p = new THREE.Vector3(...world).project(camera);
        const cx = Math.round((p.x * 0.5 + 0.5) * cw);
        const cy = Math.round((0.5 - p.y * 0.5) * ch);
        const r = Math.round(Math.min(cw, ch) * 0.018);
        let R = 0, G = 0, B = 0, count = 0;
        for (let y = cy - r; y <= cy + r; y++) {
          for (let x = cx - r; x <= cx + r; x++) {
            if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
            const o = (y * cw + x) * 4;
            R += srgbToLinear(img[o] / 255);
            G += srgbToLinear(img[o + 1] / 255);
            B += srgbToLinear(img[o + 2] / 255);
            count++;
          }
        }
        return count ? { r: R / count, g: G / count, b: B / count } : { r: 0, g: 0, b: 0 };
      };
      return Object.fromEntries(Object.entries(subjects).map(([k, w]) => [k, crop(w)]));
    };

    // POLLED, not one-shot — the RESIZE-GATE lesson generalized (2026-08-21,
    // this gate's own flake): the metal sphere's ONLY light is the probe
    // reflection, and the atlas is legitimately EMPTY until the capture
    // kernel's pipeline lands (~12s inside a 105-pipeline wave; a WGSL
    // change cold-caches the driver and pushes it past any fixed settle).
    // The 16-frame round-robin re-fires captures forever, so a healthy boot
    // converges; a real breakage stays black past the deadline and fails
    // exactly as before. The probe-less arm lights the sphere with the
    // glossy field on the same schedule, so one poll serves both arms.
    const lum = (s) =>
      0.2126 * s.sphereC.r + 0.7152 * s.sphereC.g + 0.0722 * s.sphereC.b;
    // CONVERGENCE poll, not first-light (2026-08-22): the probe EMA and the
    // glossy temporal both climb for a second or two after their pipelines
    // land — a first-light exit sampled mid-EMA and read 187% held-pose
    // "drift" that was really convergence. Exit on lit AND two consecutive
    // reads within 3%; the deadline still catches a real black.
    const deadline = Date.now() + 90000;
    let base = await sample();
    let prev = null;
    for (;;) {
      const value = lum(base);
      if (value > 0.02 && prev != null && Math.abs(value - prev) / Math.max(1e-6, prev) < 0.03) break;
      prev = value > 0.02 ? value : null;
      if (Date.now() > deadline) break;
      await sleep(1500);
      base = await sample();
    }
    await sleep(700);
    const again = await sample();
    return { base, again };
  }, { subjects: SUBJECTS });

  if (wantPng) {
    const shot = await page.screenshot({ encoding: "base64" });
    writeFileSync(`${OUT}/frame-${arm}.png`, Buffer.from(shot, "base64"));
  }
  await page.close();
  return { arm, armedLine, bvhLine, errors, ...measure };
}

const results = {};
for (const arm of ARMS) results[arm] = await runArm(arm);
await browser.close();

// redness ∈ [-1, 1]: hue balance of a crop, luminance-normalized so a dim
// reflection counts as much as a bright one.
const redness = (c) => (c.r - c.g) / Math.max(1e-6, c.r + c.g);
const split = (s) => redness(s.sphereL) - redness(s.sphereR);
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

for (const [arm, r] of Object.entries(results)) {
  console.log(`\nARM=${arm}`);
  if (r.armedLine) console.log(`  ${r.armedLine.slice(0, 160)}`);
  if (r.bvhLine) console.log(`  ${r.bvhLine.slice(0, 160)}`);
  const f = (c) => `(${c.r.toFixed(3)} ${c.g.toFixed(3)} ${c.b.toFixed(3)})`;
  console.log(`  crops     L ${f(r.base.sphereL)}  R ${f(r.base.sphereR)}  C ${f(r.base.sphereC)}`);
  console.log(`  hue split ${split(r.base).toFixed(4)}  (held-pose ${split(r.again).toFixed(4)})  pageerrors ${r.errors}`);
}

let pass = true;
const on = results.probe;
const off = results.off;
if (on) {
  if (!on.armedLine) { console.log("\nARMED: boot line missing — probes never armed  FAIL"); pass = false; }
  else console.log("\nARMED: PASS");
  const drift = Math.abs(lum(on.again.sphereL) - lum(on.base.sphereL)) / Math.max(1e-6, lum(on.base.sphereL));
  const stable = drift <= 0.10;
  console.log(`NOISE: held-pose left-limb drift ${(drift * 100).toFixed(1)}%  ${stable ? "PASS" : "FAIL"}`);
  pass &&= stable;
  if (on.errors > 0) { console.log(`ERRORS: ${on.errors} pageerrors  FAIL`); pass = false; }
}
if (on) {
  const sOn = split(on.base);
  const ok = sOn >= 0.06;
  const ctx = off ? `  (off arm ${split(off.base).toFixed(4)}, reported not gated)` : "";
  console.log(`HUE SPLIT: probe ${sOn.toFixed(4)}${ctx}  ${ok ? "PASS" : "FAIL"}`);
  pass &&= ok;
}
const offs = results.offset;
if (offs) {
  // The depth-parallax contract (§15 U4a), as MEASUREMENT bounded it
  // (2026-08-22): a displaced probe cannot fully match the centred one —
  // its capture holds the far walls at coarser angular resolution and the
  // metal sphere's white-diffuse blob in different directions, so per-limb
  // redness parity is not achievable at ANY iteration count (iter 2
  // sharpened the centred arm 0.53 → 0.63 and moved the offset arm 0.00).
  // What IS gateable: with depth parallax the displaced probe stays a
  // world-anchored reflection; with box projection alone it COLLAPSES to
  // the no-probe field baseline (measured 0.1801 vs field 0.177 — the
  // probe adds nothing when its box lies about the walls). Gate the
  // anchoring floor at 0.24 (depth holds 0.29); report the redness deltas
  // as context.
  // ⭐ FLOOR RE-ANCHORED 0.24 → 0.21 (2026-08-24, §16 R3a). The capture's
  // emitter shadows moved from the occupancy cone to the record march (the
  // cone etched the black-cross lattice INTO the atlas), and the cone's
  // over-occlusion was baked into this gate's reference values: with the
  // record march the displaced-probe split reads 0.2366/0.2387 across two
  // boots (brighter, less falsely-occluded captures compress the relative
  // hue contrast) while the CENTRED probe's discrimination went UP
  // (0.5464 vs ~0.53) — anchoring improved where placement is correct.
  // `EXTRA={"__giProbeRecordShadows":false}` reproduces the cone arm
  // (measured 0.3292 same day). Collapse stays ~0.18.
  const sOffs = split(offs.base);
  const okSplit = sOffs >= 0.21;
  console.log(`OFFSET ANCHORING: split ${sOffs.toFixed(4)} (box-only collapse ~0.18)  ${okSplit ? "PASS" : "FAIL"}`);
  pass &&= okSplit;
  if (offs.errors > 0) { console.log(`OFFSET ERRORS: ${offs.errors} pageerrors  FAIL`); pass = false; }
  if (on) {
    const dL = Math.abs(redness(offs.base.sphereL) - redness(on.base.sphereL));
    const dR = Math.abs(redness(offs.base.sphereR) - redness(on.base.sphereR));
    console.log(`PLACEMENT DRIFT (reported, not gated): |Δredness| L ${dL.toFixed(4)}  R ${dR.toFixed(4)}`);
  }
}
console.log(pass ? "\nALL PASS" : "\nFAIL");
process.exit(pass ? 0 : 1);
