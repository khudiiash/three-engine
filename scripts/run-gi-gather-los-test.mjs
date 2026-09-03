// LOS GATHER VALIDITY GATE (2026-08-22, §15 unit U3) — verifies that
// `__giGatherLosWeight` suppresses corner probes the shaded point cannot SEE.
//
// Rig: makeLosLeakProject — a sealed two-room box, red panel in room A, dim
// white panel in room B, camera in B staring at the partition's B face. Any
// red on that face is leak; the LOS march must reduce it without touching the
// control crop lit by B's own panel.
//
// TWO ARMS, CROSS-BOOT (the hatch is read at kernel build time; one BROWSER
// per arm — arms sharing a browser inherit each other's UI layout and the
// canvases stop being comparable, the U1 flip gate's burned lesson):
//   off   the shipping default (both validity terms off)
//   on    __giGatherLosWeight = true
//
// STATISTICS (linear, crops projected from SUBJECTS through the live camera):
//   ALIVE     control ≥ 0.005 (polled to convergence), 0 pageerrors, both arms
//   LEAK      redness r/(r+g+b) at the partition face: on ≤ off − 0.03 AND
//             leak luminance on ≤ off (direction), on BOTH face crops
//   CONTROL   control luminance within ±20% across arms
//   NOISE     held-pose leak drift ≤ 10% per arm
//   PRICE     gather pass ms per arm (report-only — shared GPU)
//
//   node scripts/run-gi-gather-los-test.mjs        (vite on :5201)
//   SETTLE=18000 ARMS=off,on QUALITY=high PNG=1
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeLosLeakProject, POSE, A_POSE, subjectsFor } from "./lib/makeLosLeakProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const SETTLE = Number(process.env.SETTLE ?? 18000);
const VIEW = (process.env.VIEW ?? "1200x800").split("x").map(Number);
// §15 U3b arms: each arm names a (gather, merge) flag PAIR — every flag
// explicit on every arm (the module's standing rule). Both guards are opt-in:
// later healthy-ladder/collateral runs overturned the transient default-on
// claim recorded in the older ledger entry.
//   off    both validity terms off — the leak baseline
//   on     gather march only (U3's historical arm; opt-in in the product)
//   merge  ladder cross-wall validity only — diagnostic, not shipping
//   both   the two together
//   binary the gather march reading the ONE-BIT occupancy instead of the
//          filtered one — the arm that separates "the LOS test suppresses too
//          much" from "the FILTERED read suppresses too much", which a single
//          control ratio cannot.
const ARM_FLAGS = {
  off: { gather: false, merge: false },
  on: { gather: true, merge: false },
  merge: { gather: false, merge: true },
  both: { gather: true, merge: true },
  binary: { gather: true, merge: false, filtered: false },
};
const ARMS = (process.env.ARMS ?? "off,on").split(",").map((s) => s.trim()).filter(Boolean);
for (const a of ARMS) if (!ARM_FLAGS[a]) { console.error(`unknown arm '${a}'`); process.exit(2); }
const QUALITY = process.env.QUALITY ?? "high";
// PART=0.5 (default) is the mechanism arm: a partition THICKER than one probe
// cell gives the two faces distinct corner probes, which is the case the LOS
// weight separates — run 7 measured COMPLETE removal (every crop back to the
// 1/3 neutral baseline). PART=0.1 is the thin-slab case whose leak is the
// SHARED probe payload — LOS cannot fix that half (informational arm).
const PART = Number(process.env.PART ?? 0.5);
const SUBJECTS = subjectsFor(PART);
const wantPng = process.env.PNG === "1";
const OUT = ".gi-shots/gather-los";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const root = path.resolve(`scripts/.gi-gather-los-${QUALITY}-p${PART}`).replaceAll("\\", "/");
// REDSTRENGTH=0 is THE COLLATERAL ARM. With room A's panel dark there is no
// leak to remove, so any control difference between off and on is the LOS
// term suppressing LEGITIMATE light and nothing else. The lit rig cannot
// answer that question at all: every crop of room B carries leak (the
// "control" crop measured redness 0.404 against the 0.333 neutral baseline),
// and the leak is red-TINTED rather than pure red, so it moves the
// achromatic component too.
const RED = Number(process.env.REDSTRENGTH ?? 24);
await makeLosLeakProject(root, { quality: QUALITY, partition: PART, redStrength: RED });
console.log(`rig: sealed two-room 8x3x4 box, red panel in A, dim white in B, partition ${PART}m; quality ${QUALITY}`);

const launchBrowser = () => puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm, expectCanvas) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let errors = 0;
  const losLines = [];
  const mergeLines = [];
  const giLines = [];
  let retryCount = 0;
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/gather: LOS validity/.test(t)) losLines.push(t);
    if (/merge: cross-wall LOS/.test(t)) mergeLines.push(t);
    // §12.56 weather: the auto-retry re-mints the WHOLE field, destroying the
    // A-room population this rig's leak depends on. Fires on ~every boot of
    // this rig (measured 3/3), at a time that varies — so the protocol below
    // re-runs the population sequence when one lands mid-protocol.
    if (/AUTO-RETRY/.test(t)) retryCount++;
    // Boot-state forensics (LOG_GI=1): the watchdog/retry/dead-merge family
    // — a partial-removal boot must be correlatable with the field's own
    // health lines, not guessed at.
    if (process.env.LOG_GI === "1" && /\[gi\].*(watchdog|retry|dead|orphan|re-mint|rebuild)/i.test(t)) giLines.push(t);
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) { errors++; console.log(`  pageerror: ${msg.slice(0, 200)}`); }
  });
  await page.evaluateOnNewDocument((project, flags) => {
    localStorage.clear();
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    // §10 (2026-09-02): the gather LOS is point-in-solid over the occupancy
    // pyramid; "auto" is the field-less BVH build now, so this rig pins the
    // occupancy mode it measures.
    globalThis.__giRayHitMode = "hybrid-exact-complex";
    // EVERY flag explicit on EVERY arm (the module's standing rule).
    globalThis.__giGatherLosWeight = flags.gather;
    globalThis.__giMergeLosWeight = flags.merge;
    globalThis.__giLosFiltered = flags.filtered !== false;
  }, root, ARM_FLAGS[arm]);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, root);
  for (let i = 0; i < 180 && !built; i++) await wait(1000);
  if (!built) { await browser.close(); throw new Error(`${arm}: never built`); }
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  // POPULATE ROOM A FIRST — probe insertion is visibility-driven, so the
  // A-side probes whose retained tiles are the leak only exist if a camera
  // has looked at them (run 2's lesson). Same protocol on both arms.
  //
  // Repeated once if the §12.56 auto-retry lands mid-protocol: the re-mint
  // destroys the A population and every deposit made in the pre-heal window,
  // so a single pass measures the WEATHER, not the term (three forensic
  // boots: retry fired 3/3, and the heal's timing decided how much leak
  // source survived — 1 clean / 2 partial on identical code).
  const populate = async () => {
    await page.evaluate(async (pose) => {
      await globalThis.__editorApi.call("viewport.setCamera", pose);
    }, A_POSE);
    await wait(SETTLE);
    await page.evaluate(async (pose) => {
      await globalThis.__editorApi.call("viewport.setCamera", pose);
    }, POSE);
    await wait(Math.max(6000, SETTLE / 2));
  };
  const retriesBefore = retryCount;
  await populate();
  if (retryCount > retriesBefore) {
    console.log(`  ${arm}: §12.56 retry landed mid-protocol (${retryCount}) — repeating the population sequence post-heal`);
    await populate();
  }

  await page.evaluate(async ({ subjects }) => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const { THREE } = await import("/src/engine/index.js");
    const camera = engine.camera;
    const renderer = engine.renderer;
    const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    globalThis.__losSample = async () => {
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
        // A subject out of frame is an instrument fault, never "dark" — the
        // first run scored an off-screen floor point as control 0.0000.
        const inFrame = p.z < 1 && cx - r >= 0 && cy - r >= 0 && cx + r < cw && cy + r < ch;
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
        if (!count) return { lum: 0, lumNeutral: 0, redness: 0, inFrame: false };
        R /= count; G /= count; B /= count;
        const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        const redness = R / Math.max(1e-6, R + G + B);
        // THE ACHROMATIC PART, and it is what the control assertion has to
        // read. Room B's own panel is WHITE and room A's leak is RED, so
        // total luminance in ANY crop of room B mixes the two — including the
        // "control" crop, which measured redness 0.404 against the 0.333
        // neutral baseline, i.e. it was a third leak by luminance. A complete
        // removal therefore drops the control's TOTAL by ~40% while touching
        // none of its legitimate light, and a ±20% band on the total scores
        // the best possible outcome as a failure. Taking the min channel as
        // the white component separates them: a pure-red leak contributes
        // nothing to it, so it must HOLD.
        const lumNeutral = Math.min(R, G, B);
        return { lum, lumNeutral, redness, inFrame };
      };
      const out = Object.fromEntries(Object.entries(subjects).map(([k, w]) => [k, crop(w)]));
      out.canvas = [cw, ch];
      return out;
    };
  }, { subjects: SUBJECTS });

  // Every subject must be in frame BEFORE anything is classified.
  const first = await page.evaluate(() => globalThis.__losSample());
  for (const k of Object.keys(SUBJECTS)) {
    if (!first[k].inFrame) {
      await browser.close();
      throw new Error(`INSTRUMENT: subject '${k}' projects out of frame — fix POSE/SUBJECTS`);
    }
  }

  // Convergence-polled on BOTH the control's luminance AND the leak crop's
  // redness (never a fixed settle — the refl-gate idiom). The first form
  // watched control.lum alone, and under GPU contention it classified a
  // mid-convergence field: the leak crop is the SLOWEST mover (it is the
  // thing being suppressed/accumulated), and one contended run read a
  // partial 0.349 where five uncontended runs read a converged 0.333.
  let base = null;
  let prev = null;
  const deadline = Date.now() + 150000;
  for (;;) {
    const s = await page.evaluate(() => globalThis.__losSample());
    const lit = s.control.lum > 0.005;
    const stable = lit && prev != null &&
      Math.abs(s.control.lum - prev.lum) / Math.max(1e-6, prev.lum) < 0.03 &&
      Math.abs(s.leak.redness - prev.red) < 0.004 &&
      Math.abs(s.leakLow.redness - prev.redLow) < 0.004;
    prev = lit ? { lum: s.control.lum, red: s.leak.redness, redLow: s.leakLow.redness } : null;
    if (stable || Date.now() > deadline) { base = s; break; }
    await wait(2000);
  }
  if (expectCanvas && (base.canvas[0] !== expectCanvas[0] || base.canvas[1] !== expectCanvas[1])) {
    await browser.close();
    throw new Error(`INSTRUMENT: ${arm} canvas ${base.canvas.join("x")} != ${expectCanvas.join("x")}`);
  }
  await wait(700);
  const again = await page.evaluate(() => globalThis.__losSample());

  // The whole giPasses result rides into result.json; `groupMs` (label →
  // {ms}) is the per-group breakdown the price reads. The first parser
  // guessed an array shape and read null twice — dump, don't guess.
  let giPasses = null;
  try {
    giPasses = await page.evaluate(() => globalThis.__editorApi.call("profile.giPasses", { samples: 24 }));
  } catch (e) {
    console.log(`  giPasses failed: ${String(e).slice(0, 140)}`);
  }
  // U3b forensics: the merge's own telemetry decides between "ladder broken
  // (leak is corner-selection, merge march can't help)" and "ladder healthy
  // but the march isn't cutting (straddling parent cells)". orphanRate ≥0.12
  // with low meanLum is the wedge signature; losRate says whether the march
  // convicted anything at all.
  let mergeStats = null;
  try {
    mergeStats = await page.evaluate(async () => {
      const { ensureEngine } = await import("/src/editor/engineInstance.js");
      const engine = await ensureEngine();
      const src = engine.modules?.get("gi")?.system?.state?.screen?.srcProbes;
      if (!src?.readStats) return null;
      const s = await src.readStats(engine.renderer);
      return { merge: s.merge ?? null, tiles: s.tiles ?? null };
    });
    if (mergeStats?.merge) {
      const m = mergeStats.merge;
      console.log(`  merge: orphan ${(m.orphanRate * 100).toFixed(1)}%  corners ${m.meanCorners?.toFixed(1)}/8  ` +
        `los-cut ${m.losSuppressed ?? 0} (${((m.losRate ?? 0) * 100).toFixed(1)}%)  toSky ${(m.resolvedRate * 100).toFixed(0)}%`);
    }
  } catch (e) {
    console.log(`  mergeStats failed: ${String(e).slice(0, 140)}`);
  }
  const gatherMs = giPasses?.groupMs
    ? Object.entries(giPasses.groupMs).find(([label]) => /gather|\[I\]/i.test(label))?.[1]?.ms ?? null
    : null;

  if (wantPng) {
    const shot = await page.screenshot({ encoding: "base64" });
    writeFileSync(`${OUT}/frame-${arm}.png`, Buffer.from(shot, "base64"));
  }
  if (giLines.length) console.log(`  gi-health: ${giLines.slice(0, 8).join(" | ").slice(0, 600)}`);
  await page.close();
  await browser.close();
  return { arm, errors, base, again, gatherMs, giPasses, losLines, mergeLines, mergeStats };
}

const results = {};
let expectCanvas = null;
for (const arm of ARMS) {
  console.log(`\n── arm ${arm}`);
  const r = await runArm(arm, expectCanvas);
  expectCanvas ??= r.base.canvas;
  results[arm] = r;
  const f = (c) => `lum ${c.lum.toFixed(4)} white ${c.lumNeutral.toFixed(4)} red ${c.redness.toFixed(3)}`;
  console.log(`  canvas ${r.base.canvas.join("x")}  leak[${f(r.base.leak)}]  leakLow[${f(r.base.leakLow)}]  control[${f(r.base.control)}]${r.gatherMs != null ? `  gather ${r.gatherMs}ms` : ""}`);
}

writeFileSync(`${OUT}/result.json`, JSON.stringify({ quality: QUALITY, results }, null, 2));

let pass = true;
const say = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) pass = false;
};
console.log(`\n== U3/U3b LOS GATE (${QUALITY}) ==`);
for (const [arm, r] of Object.entries(results)) {
  const f = ARM_FLAGS[arm];
  say(`ARMED(${arm}): gather ${f.gather ? "on" : "off"}`,
    f.gather ? r.losLines.some((l) => /ARMED/.test(l)) : r.losLines.length === 0,
    r.losLines.join(" | ") || (f.gather ? "no line" : "clean"));
  say(`ARMED(${arm}): merge ${f.merge ? "on" : "off"}`,
    f.merge ? r.mergeLines.length > 0 : r.mergeLines.length === 0,
    r.mergeLines.join(" | ") || (f.merge ? "no line" : "clean"));
  say(`ALIVE(${arm})`, r.base.control.lum >= 0.005 && r.errors === 0,
    `control ${r.base.control.lum.toFixed(4)}  pageerrors ${r.errors}`);
  const drift = Math.abs(r.again.leak.lum - r.base.leak.lum) / Math.max(1e-6, r.base.leak.lum);
  say(`NOISE(${arm}) held-pose leak drift ≤ 10%`, drift <= 0.10, `${(drift * 100).toFixed(1)}%`);
}
const off = results.off;
const treatments = Object.values(results).filter((r) => r.arm !== "off");
if (off && treatments.length) {
  // The neutral baseline is redness = 1/3 (equal channels). The off arm must
  // PRODUCE a leak (or the gate proves nothing) and a treatment arm must
  // RETURN to baseline — "removed what existed", not a fixed drop that a
  // shallow leak can never satisfy (run 7's threshold lesson).
  const NEUTRAL = 1 / 3;
  // ⚠ THE COLLATERAL ARM HAS NO LEAK BY CONSTRUCTION. With REDSTRENGTH=0 the
  // source is dark, so "a leak exists" and "the leak returned to baseline"
  // are not merely unmet, they are meaningless — asserting them would make
  // the one arm that can measure collateral permanently red.
  if (RED === 0) {
    console.log("  info leak assertions SKIPPED — REDSTRENGTH=0 is the collateral arm (no source, no leak).");
  } else {
  say("LEAK exists on the off arm (rig sanity)",
    off.base.leakLow.redness >= NEUTRAL + 0.02,
    `leakLow redness ${off.base.leakLow.redness.toFixed(3)} vs baseline ${NEUTRAL.toFixed(3)}`);
  for (const on of treatments) {
    const isMergeArm = ARM_FLAGS[on.arm].merge;
    for (const k of ["leak", "leakLow"]) {
      // BASELINE RETURN: hard for any arm carrying the U3b merge validity —
      // on a healthy ladder the through-wall red rides the cascade MERGE
      // into the B-side probes' own tiles (c1/c2 parent cells span the
      // partition), which is exactly what the merge march suppresses.
      // Gather-only arms keep it advisory: post-heal they measurably cannot
      // reach the tile-borne share (0.398 → 0.387, the ⭐⭐ finding).
      const back = Math.abs(on.base[k].redness - NEUTRAL) <= 0.015;
      const backDetail = `${off.base[k].redness.toFixed(3)} → ${on.base[k].redness.toFixed(3)} (baseline ${NEUTRAL.toFixed(3)})`;
      if (isMergeArm) {
        say(`LEAK ${k} (${on.arm}): returns to baseline`, back, backDetail);
      } else {
        console.log(`  ${back ? "info" : "WARN"} LEAK ${k} (${on.arm}): baseline return ` +
          `${back ? "ACHIEVED" : "not reached (gather cannot touch tile-borne leak)"} — ${backDetail}`);
      }
      say(`LEAK ${k} (${on.arm}): LOS never makes it worse`, on.base[k].redness <= off.base[k].redness + 0.006,
        `${off.base[k].redness.toFixed(3)} → ${on.base[k].redness.toFixed(3)}`);
      // ×1.15, sized to the rig's own cross-boot luminance spread — the HUE
      // never-worse above is the discriminating invariant, lum only guards
      // gross brightening.
      say(`LEAK ${k} (${on.arm}): luminance does not rise`, on.base[k].lum <= off.base[k].lum * 1.15,
        `${off.base[k].lum.toFixed(4)} → ${on.base[k].lum.toFixed(4)}`);
    }
  }
  }
  // OUTSIDE the leak block on purpose: the control/collateral read is the one
  // thing BOTH rig configurations produce.
  for (const on of treatments) {
    // ── CONTROL: WHICH RIG CAN ANSWER IT ────────────────────────────────
    //
    // In the LIT rig it cannot be asserted at all, and the ±20% band that
    // used to be here scored a COMPLETE leak removal as a failure. Every crop
    // of room B carries leak (the control crop itself measured redness 0.404
    // against the 0.333 neutral baseline), and the leak is red-TINTED, not
    // pure red — its own green and blue move the achromatic component too
    // (predicted removal 0.0095 against 0.0083 measured). So the lit arm
    // REPORTS the ratios and the COLLATERAL arm asserts them.
    const cr = on.base.control.lum / Math.max(1e-6, off.base.control.lum);
    const cn = on.base.control.lumNeutral / Math.max(1e-6, off.base.control.lumNeutral);
    if (RED === 0) {
      // REDSTRENGTH=0: no leak exists, so every difference here is the LOS
      // term suppressing legitimate light. Measured 0.723 on 2026-08-23 — a
      // real cost of the unit, which is why it stays OPT-IN pending a live
      // look. The bound catches a COLLAPSE, not the known cost.
      say(`COLLATERAL (${on.arm}) legitimate light survives`, cr >= 0.6,
        `ratio ${cr.toFixed(3)} with the source dark (known cost ≈ 0.72)`);
    } else {
      console.log(`  info CONTROL (${on.arm}) ratio ${cr.toFixed(3)} total / ${cn.toFixed(3)} white — ` +
        "not an assertion: this crop is itself leak-lit. Run REDSTRENGTH=0 for the collateral arm.");
    }
  }
  for (const r of [off, ...treatments]) {
    if (!r.giPasses?.groupMs) continue;
    const rows = Object.entries(r.giPasses.groupMs)
      .filter(([, v]) => typeof v?.ms === "number")
      .map(([label, v]) => `${label} ${v.ms}ms`);
    console.log(`  PRICE (${r.arm}, report-only): ${rows.join("  ")}`);
  }
}
console.log(pass ? "\nALL PASS" : "\nFAIL");
process.exit(pass ? 0 : 1);
