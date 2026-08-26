// EXACT-REFLECTION HIT-SHADE GATE (2026-08-22, §14 unit R-A) — verifies that
// createGiBvhHitShade (hit shading in ITS OWN PASS) delivers traced emitter
// shadows inside ultra's exact reflections, which the in-resolve form never
// could (66 ms occupancy collapse → hits shipped UNSHADOWED at dense → every
// mirror showed flat, uniformly-lit albedo).
//
// TWO ARMS, CROSS-BOOT (the hatch is read at kernel build time):
//   shadow   the shipping default (traced cone shadows at hits)
//   flat     __giHitEmitterShadows=false — the pre-R-A dense behaviour
//
// STATISTICS (linear luminance, crops projected from SUBJECTS' world points;
// the mirror crops project the floor points' MIRROR IMAGES — see the rig):
//   ARMED    the `[gi] bvh: exact reflections ON … hit-shaded` boot line.
//   SHADOW   mirrorLit / mirrorShadow on the shadow arm ≥ 1.12 AND exceeds
//            the flat arm's ratio by ≥ 0.08 — the shadow exists IN the
//            reflection and the hatch is what controls it.
//   ALIVE    mirrorLit ≥ 0.02 (polled — the hit-shade kernel compiles in the
//            background wave; a mirror is black until it lands), 0 pageerrors.
//   NOISE    held-pose mirrorLit drift ≤ 10%.
//
//   node scripts/run-gi-hit-shade-test.mjs        (vite on :5201)
//   SETTLE=20000 ARMS=shadow,flat PNG=1
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeHitShadeProject, POSE, SUBJECTS } from "./lib/makeHitShadeProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const SETTLE = Number(process.env.SETTLE ?? 20000);
const VIEW = (process.env.VIEW ?? "1200x800").split("x").map(Number);
const ARMS = (process.env.ARMS ?? "shadow,flat").split(",").map((s) => s.trim()).filter(Boolean);
// QUALITY=high FORCE_EXACT=1 ARMS=shadow is the "exact at high" pricing arm:
// the tier keeps its half-res resolve while `__giConfigOverride` forces the
// exact-BVH ladder on — the measurement behind any preset-flip decision.
const QUALITY = process.env.QUALITY ?? "ultra";
const FORCE_EXACT = process.env.FORCE_EXACT === "1";
const wantPng = process.env.PNG === "1";
const OUT = ".gi-shots/hit-shade";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const root = path.resolve(`scripts/.gi-hit-shade-${QUALITY}`).replaceAll("\\", "/");
await makeHitShadeProject(root, { quality: QUALITY });
console.log(`rig: 6x3x6 room, mirror wall -Z, ceiling panel light, occluder box; quality ${QUALITY}${FORCE_EXACT ? " + forced exactReflections" : ""}`);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm) {
  const traced = arm === "shadow";
  const page = await browser.newPage();
  await page.setViewport({ width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let errors = 0;
  let bvhLine = "";
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/bvh: exact reflections ON/.test(t)) bvhLine = t;
    // §18.16/§18.17 receipts: WHICH albedo path and WHICH sun-visibility path
    // armed. Both fall back silently, so a run that never printed these is a
    // run that proved nothing about them.
    if (/reflections: one-BVH hits|reflection albedo atlas|static shadow bvh:/.test(t)) console.log(`  ${t}`);
    // §17: a WGSL validation failure surfaces only as this warn, and a
    // skipped pipeline renders as a stale target, not an error — echo it.
    if (/failed to compile|compilation info|Invalid ShaderModule|error while parsing WGSL/i.test(t)) {
      console.log(`  COMPILE: ${t.slice(0, 500)}`);
    }
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) { errors++; console.log(`  pageerror: ${msg.slice(0, 200)}`); }
  });
  await page.evaluateOnNewDocument((project, tracedOn, forceExact, extra) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    if (!tracedOn) globalThis.__giHitEmitterShadows = false;
    if (forceExact) globalThis.__giConfigOverride = { exactReflections: true };
    // §17: EXTRA={"__giOneBvhReflect":false} etc. — arm any dev global at
    // boot, the same escape hatch every sibling rig carries.
    if (extra) for (const [k, v] of Object.entries(extra)) globalThis[k] = v;
  }, root, traced, FORCE_EXACT, process.env.EXTRA ? JSON.parse(process.env.EXTRA) : null);
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

  await page.evaluate(async ({ subjects }) => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const { THREE } = await import("/src/engine/index.js");
    const camera = engine.camera;
    const renderer = engine.renderer;
    const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    globalThis.__hsSample = async () => {
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
        const r = Math.round(Math.min(cw, ch) * 0.02);
        let sum = 0, count = 0;
        for (let y = cy - r; y <= cy + r; y++) {
          for (let x = cx - r; x <= cx + r; x++) {
            if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
            const o = (y * cw + x) * 4;
            sum += 0.2126 * srgbToLinear(img[o] / 255)
              + 0.7152 * srgbToLinear(img[o + 1] / 255)
              + 0.0722 * srgbToLinear(img[o + 2] / 255);
            count++;
          }
        }
        return count ? sum / count : 0;
      };
      return Object.fromEntries(Object.entries(subjects).map(([k, w]) => [k, crop(w)]));
    };
  }, { subjects: SUBJECTS });

  // POLLED FOR CONVERGENCE, not first light (2026-08-22): the hit radiance
  // has a temporal chain now, so the mirror brightens over ~a second after
  // its pipelines land — a first-light exit sampled it mid-EMA (measured
  // 0.12 → 0.40 across one held pose, a 24% "noise" failure that was really
  // convergence). Lit AND two consecutive reads within 3% is the exit; the
  // deadline still catches a genuinely dead binding.
  let base = null;
  let prevLit = null;
  const deadline = Date.now() + 120000;
  for (;;) {
    const s = await page.evaluate(() => globalThis.__hsSample());
    const lit = s.mirrorLit > 0.02;
    const stable = lit && prevLit != null &&
      Math.abs(s.mirrorLit - prevLit) / Math.max(1e-6, prevLit) < 0.03;
    prevLit = lit ? s.mirrorLit : null;
    if (stable || Date.now() > deadline) { base = s; break; }
    await wait(1500);
  }
  await wait(700);
  const again = await page.evaluate(() => globalThis.__hsSample());

  let frameMs = null;
  try {
    const prof = await page.evaluate(() => globalThis.__editorApi.call("profile.frameStats", {}));
    frameMs = { cpu: prof?.cpuMs ?? prof?.cpu ?? null, gpu: prof?.gpuMs ?? prof?.gpu ?? null };
  } catch { /* report-only */ }

  if (wantPng) {
    const shot = await page.screenshot({ encoding: "base64" });
    writeFileSync(`${OUT}/frame-${arm}.png`, Buffer.from(shot, "base64"));
  }
  await page.close();
  return { arm, bvhLine, errors, base, again, frameMs };
}

const results = {};
for (const arm of ARMS) results[arm] = await runArm(arm);
await browser.close();

const fmt = (v) => (v == null ? "  n/a " : v.toFixed(4));
for (const [arm, r] of Object.entries(results)) {
  console.log(`\nARM=${arm}${r.bvhLine ? `\n  ${r.bvhLine.slice(0, 160)}` : ""}`);
  console.log(`  crops      mirrorShadow ${fmt(r.base.mirrorShadow)}  mirrorLit ${fmt(r.base.mirrorLit)}  directLit ${fmt(r.base.directLit)}`);
  console.log(`  held-pose  mirrorShadow ${fmt(r.again.mirrorShadow)}  mirrorLit ${fmt(r.again.mirrorLit)}`);
  if (r.frameMs) console.log(`  frame ms   cpu ${r.frameMs.cpu}  gpu ${r.frameMs.gpu}`);
}

let pass = true;
const shadow = results.shadow;
const flat = results.flat;
for (const [arm, r] of Object.entries(results)) {
  const armed = /hit-shaded/.test(r.bvhLine);
  console.log(`\nARMED(${arm}): ${armed ? "PASS" : `FAIL (${r.bvhLine || "no bvh line"})`}`);
  pass &&= armed;
  const alive = r.base.mirrorLit >= 0.02 && r.errors === 0;
  console.log(`ALIVE(${arm}): mirrorLit ${fmt(r.base.mirrorLit)}  pageerrors ${r.errors}  ${alive ? "PASS" : "FAIL"}`);
  pass &&= alive;
}
if (shadow) {
  const ratio = shadow.base.mirrorLit / Math.max(1e-6, shadow.base.mirrorShadow);
  const flatRatio = flat ? flat.base.mirrorLit / Math.max(1e-6, flat.base.mirrorShadow) : null;
  const ok = ratio >= 1.12 && (flatRatio == null || ratio >= flatRatio + 0.08);
  console.log(`SHADOW: reflected lit/shadow x${ratio.toFixed(3)}${flatRatio != null ? ` vs flat arm x${flatRatio.toFixed(3)}` : ""}  ${ok ? "PASS" : "FAIL"}`);
  pass &&= ok;
  const drift = Math.abs(shadow.again.mirrorLit - shadow.base.mirrorLit) / Math.max(1e-6, shadow.base.mirrorLit);
  const stable = drift <= 0.10;
  console.log(`NOISE: held-pose mirrorLit drift ${(drift * 100).toFixed(1)}%  ${stable ? "PASS" : "FAIL"}`);
  pass &&= stable;
}
console.log(pass ? "\nALL PASS" : "\nFAIL");
process.exit(pass ? 0 : 1);
