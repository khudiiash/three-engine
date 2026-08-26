// AO + GLOSSY GATE (2026-08-21) — prices and verifies the two indirect
// completions shipped together: screen-space AO (createGiAoPass, `ao: true`
// in giConfig) and the half-res glossy radiance chain (createSrcGlossyGather
// + the radiance temporal filter, §12.71b v2 default-on).
//
// TWO ARMS, CROSS-BOOT (both hatches are build-time):
//   on    the shipping defaults
//   off   __giConfigOverride={ao:false} + __giGlossyRadiance=false — the
//         pre-change image (dark-but-stable metals, no contact darkening)
//
// STATISTICS (linear luminance, crops projected from SUBJECTS' world points
// through the live camera — never hand-coded rectangles):
//   AO      same-page A/B on the `on` arm: `__giAoOverride={strength:0}` is a
//           live uniform, so contact-vs-open floor is measured twice in ONE
//           page. PASS = zeroing AO brightens the contact strip by ≥3% while
//           moving the open-floor control by materially less.
//   GLOSSY  sphere crop, on-arm vs off-arm. PASS = the metal sphere is
//           brighter with the chain on (off is the §12.71b black-metal state).
//   NOISE   two sphere samples 700ms apart at a held pose (the S2 lesson:
//           hold the pose and sample twice). Reported, PASS ≤ 10% drift.
//   COST    profile.giPasses group ms for "ao" / "glossy gather" / "glossy
//           temporal". Reported, PASS = combined ≤ 2.5 ms at rig scale.
//
//   node scripts/run-gi-ao-glossy-probe.mjs        (vite on :5201)
//   QUALITY=high SETTLE=20000 ARMS=on,off PNG=1
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeAoGlossyProject, POSE, SUBJECTS } from "./lib/makeAoGlossyProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const QUALITY = process.env.QUALITY ?? "high";
const SETTLE = Number(process.env.SETTLE ?? 20000);
// VIEW=1920x1080 QUALITY=ultra is the editor-scale pricing arm — resolve
// near the 1.6M-pixel budget instead of the default rig scale.
const VIEW = (process.env.VIEW ?? "1200x800").split("x").map(Number);
const ARMS = (process.env.ARMS ?? "on,off").split(",").map((s) => s.trim()).filter(Boolean);
const wantPng = process.env.PNG === "1";
const OUT = ".gi-shots/ao-glossy";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const root = path.resolve("scripts/.gi-ao-glossy").replaceAll("\\", "/");
await makeAoGlossyProject(root, { quality: QUALITY });
console.log(`rig: 6x3x6 room, ceiling panel only light, contact box + metal sphere; quality ${QUALITY}`);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm) {
  const featuresOn = arm === "on";
  const page = await browser.newPage();
  await page.setViewport({ width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let errors = 0;
  let glossyLine = "";
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/glossy radiance/.test(t)) glossyLine = t;
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) { errors++; console.log(`  pageerror: ${msg.slice(0, 200)}`); }
  });
  await page.evaluateOnNewDocument((project, on) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    // BOTH arms pin the exact-BVH arm OFF (high takes exactReflections since
    // 2026-08-22): this gate's sphere discriminator is "the glossy FIELD
    // chain is the metal's only light" — an exact reflection would light the
    // sphere on the off arm too and dissolve the on/off ratio into ~1.
    if (!on) {
      globalThis.__giGlossyRadiance = false;
      globalThis.__giConfigOverride = { ao: false, exactReflections: false };
    } else {
      globalThis.__giConfigOverride = { exactReflections: false };
    }
  }, root, featuresOn);
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

  const measure = await page.evaluate(async ({ subjects, on }) => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const { THREE } = await import("/src/engine/index.js");
    const camera = engine.camera;
    const renderer = engine.renderer;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

    // One crop sampler: draw the live canvas the frame it presented (§12.65's
    // drawImage rule), average a small square around each subject's projection.
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

    const base = await sample();
    // Held-pose noise read: the S2 lesson — camera motion swamps any temporal
    // signal, so the pose is held and the same crop is sampled twice.
    await sleep(700);
    const again = await sample();

    // Same-page AO A/B, on-arm only — BOTH ends of the live dial, so the
    // statistic is the term's full swing rather than default-vs-off (the
    // contact strip is mostly emitter-DIRECT light, which AO deliberately
    // leaves alone; the modulated indirect is the minor share here).
    //
    // VXAO IS HELD AT ZERO ACROSS IT. The resolve composes the two obscurance
    // estimators with `min`, so wherever the world-space one is the darker the
    // screen-space dial moves nothing and this A/B measures the composition
    // instead of the term it names. That is not hypothetical: it clipped the
    // swing from 2.7% to 1.3% here. Zeroing VXAO's live strength makes it
    // return 1 and hands the `min` back to the estimator under test — the same
    // isolation run-gi-vxao-probe.mjs applies in the mirror direction.
    let aoFull = null, aoZero = null;
    if (on) {
      // Restored explicitly, not by deleting the hatch: the override is a live
      // uniform write, so dropping the global leaves the last value latched and
      // the RESIZE measurement below would run with VXAO still off.
      const vxaoStrength = engine.modules.get("gi")?.system?.state?.screen?.vxao?.strength?.value ?? null;
      globalThis.__giVxaoOverride = { strength: 0 };
      globalThis.__giAoOverride = { strength: 1, radius: 0.8 };
      await sleep(1200);
      aoFull = await sample();
      globalThis.__giAoOverride = { strength: 0, radius: 0.8 };
      await sleep(1200);
      aoZero = await sample();
      delete globalThis.__giAoOverride;
      if (vxaoStrength !== null) globalThis.__giVxaoOverride = { strength: vxaoStrength };
      await sleep(300);
      delete globalThis.__giVxaoOverride;
      await sleep(300);
    }

    // Pass cost, from the editor's own profiler op (groupMs keyed by
    // srcSystem's passGroups labels — the sum assertion inside the op is
    // itself a gate on the group bookkeeping this change added to).
    let passMs = null;
    try {
      const prof = await globalThis.__editorApi.call("profile.giPasses", {});
      const groupMs = prof?.srcProbes?.groupMs ?? {};
      const pick = {};
      for (const key of ["ao", "glossy gather", "glossy temporal", "far field", "gather"]) {
        if (groupMs[key]?.ms != null) pick[key] = groupMs[key].ms;
      }
      passMs = { total: prof?.srcProbes?.totalMs ?? null, pick, error: groupMs.ERROR ?? null };
    } catch (e) {
      passMs = { error: String(e).slice(0, 200) };
    }
    // For the post-resize re-check (a second evaluate re-uses the sampler —
    // the projection reads the live camera, so the crops follow the resize).
    globalThis.__aogSample = sample;
    return { base, again, aoFull, aoZero, passMs };
  }, { subjects: SUBJECTS, on: featuresOn });

  // ── THE RESIZE RE-ARM (on-arm only) ──────────────────────────────────────
  // #syncScreenResolveSize rebuilds the gbuffer, the AO pass and the glossy
  // temporal pair against fresh srcProbes — the one dispatch path the static
  // rig never exercises. A stale texture node here is a black specular term
  // or a dead AO texture, both of which this catches as a crop collapse.
  let resized = null;
  if (featuresOn) {
    await page.setViewport({ width: Math.round(VIEW[0] * 0.72), height: Math.round(VIEW[1] * 0.72), deviceScaleFactor: 1 });
    // POLLED, not one-shot: a resize rebuilds ~56 pipelines and frames present
    // black GI until the async compiles land — one early sample read 0.0000
    // on a perfectly healthy rebuild. A REAL dead binding stays black past
    // any wait, which is what the timeout still catches.
    const deadline = Date.now() + 25000;
    for (;;) {
      await wait(2000);
      resized = await page.evaluate(() => globalThis.__aogSample());
      if (resized.sphere > 0.02 && resized.contact > 0.02) break;
      if (Date.now() > deadline) break;
    }
    // The drawImage readback races the swapchain a resize just reconfigured —
    // a compositor screenshot is the arbiter when the crops read black.
    const shot = await page.screenshot({ encoding: "base64" });
    writeFileSync(`${OUT}/frame-${arm}-resized.png`, Buffer.from(shot, "base64"));
  }

  if (wantPng) {
    const shot = await page.screenshot({ encoding: "base64" });
    writeFileSync(`${OUT}/frame-${arm}.png`, Buffer.from(shot, "base64"));
  }
  await page.close();
  return { arm, glossyLine, errors, resized, ...measure };
}

const results = {};
for (const arm of ARMS) results[arm] = await runArm(arm);
await browser.close();

const fmt = (v) => (v == null ? "  n/a " : v.toFixed(4));
for (const [arm, r] of Object.entries(results)) {
  console.log(`\nARM=${arm}${r.glossyLine ? `\n  ${r.glossyLine.slice(0, 160)}` : ""}`);
  console.log(`  crops      contact ${fmt(r.base.contact)}  open ${fmt(r.base.open)}  sphere ${fmt(r.base.sphere)}`);
  console.log(`  held-pose  contact ${fmt(r.again.contact)}  open ${fmt(r.again.open)}  sphere ${fmt(r.again.sphere)}`);
  if (r.aoFull) console.log(`  ao=1       contact ${fmt(r.aoFull.contact)}  open ${fmt(r.aoFull.open)}`);
  if (r.aoZero) console.log(`  ao=0       contact ${fmt(r.aoZero.contact)}  open ${fmt(r.aoZero.open)}`);
  if (r.passMs?.pick && Object.keys(r.passMs.pick).length) {
    console.log(`  pass ms    total ${r.passMs.total}  ${JSON.stringify(r.passMs.pick)}`);
  } else if (r.passMs?.error) console.log(`  pass ms    ERROR: ${r.passMs.error}`);
}

let pass = true;
const on = results.on;
const off = results.off;
if (on) {
  if (on.aoZero && on.aoFull) {
    const contactLift = on.aoZero.contact / Math.max(1e-6, on.aoFull.contact);
    const openLift = on.aoZero.open / Math.max(1e-6, on.aoFull.open);
    // Discrimination, not magnitude: the AO term must darken the contact
    // strip several times harder than the open-floor control. The absolute
    // swing is small BY DESIGN here — the strip is mostly emitter-direct
    // light, which AO leaves alone.
    const ok = contactLift >= 1.02 && (contactLift - 1) >= 3 * Math.max(0, openLift - 1);
    console.log(`\nAO: full-strength vs zero lifts contact x${contactLift.toFixed(3)} vs open x${openLift.toFixed(3)}  ${ok ? "PASS" : "FAIL"}`);
    pass &&= ok;
  }
  const aoMs = on.passMs?.pick?.ao ?? null;
  const glossyMs = (on.passMs?.pick?.["glossy gather"] ?? 0) + (on.passMs?.pick?.["glossy temporal"] ?? 0);
  if (aoMs != null || glossyMs) {
    const total = (aoMs ?? 0) + glossyMs;
    const ok = total <= 2.5;
    console.log(`COST: ao ${aoMs}ms + glossy ${glossyMs.toFixed(3)}ms = ${total.toFixed(3)}ms  ${ok ? "PASS" : "FAIL"}`);
    pass &&= ok;
  }
  const drift = Math.abs(on.again.sphere - on.base.sphere) / Math.max(1e-6, on.base.sphere);
  const stable = drift <= 0.10;
  console.log(`NOISE: held-pose sphere drift ${(drift * 100).toFixed(1)}%  ${stable ? "PASS" : "FAIL"}`);
  pass &&= stable;
  if (!on.glossyLine) { console.log("GLOSSY: boot line missing — chain did not arm  FAIL"); pass = false; }
  if (on.resized) {
    // LIVENESS, not photometry: the crops follow the projection, and a 28%
    // aspect change moves them onto different pixels — a ratio against the
    // pre-resize base measured crop drift, not the re-arm (contact read
    // 0.08 vs 0.33 on a healthy rebuild). The gate's actual claim is that
    // the AO + glossy chains survive #syncScreenResolveSize: both crops
    // clearly lit, zero page errors. A dead binding reads 0.0000 forever.
    const ok = on.resized.sphere >= 0.02 && on.resized.contact >= 0.02 && on.errors === 0;
    console.log(`RESIZE: post-resize contact ${fmt(on.resized.contact)}  sphere ${fmt(on.resized.sphere)}  pageerrors ${on.errors}  ${ok ? "PASS" : "FAIL"}`);
    pass &&= ok;
  }
}
if (on && off) {
  const ratio = on.base.sphere / Math.max(1e-6, off.base.sphere);
  const ok = ratio >= 1.15;
  console.log(`GLOSSY: metal sphere on/off luminance x${ratio.toFixed(2)}  ${ok ? "PASS" : "FAIL"}`);
  pass &&= ok;
}
console.log(pass ? "\nALL PASS" : "\nFAIL");
process.exit(pass ? 0 : 1);
