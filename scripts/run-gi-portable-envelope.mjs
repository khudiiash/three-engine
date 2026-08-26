// PORTABLE-ENVELOPE PROBE — "on mobile only emissive lighting works; the sun's
// indirect light is missing entirely" (user, 2026-08-23).
//
// ══ WHY A DESKTOP CAN ANSWER A PHONE QUESTION ══════════════════════════════
//
// A WebGPU device does NOT inherit the adapter's limits. `requestDevice` hands
// back exactly the `requiredLimits` that were asked for, and the SPEC DEFAULT
// for every key that was not — so pinning the five keys `resolveRendererLimits`
// opportunistically raises (sceneSettings.js) back down to their baselines
// creates, on this 4070, a device with a phone's binding envelope:
//
//     maxStorageBuffersPerShaderStage   8   (desktop asks 16)
//     maxStorageTexturesPerShaderStage  4   (desktop asks 8)
//     maxUniformBuffersPerShaderStage  12   (desktop asks 24)
//     maxStorageBufferBindingSize    128MB  (desktop asks 1GB)
//     maxBufferSize                  256MB  (desktop asks 1GB)
//
// `globalThis.__engineLimitsCap` is the sanctioned per-key CEILING on the ask
// (gi-gpu-smoke already pins the storage-buffer one). What this probe canNOT
// reproduce is mobile SPEED and mobile driver bugs — so a PASS here does not
// clear the phone, but a FAIL here names a bug the phone is certainly hitting.
//
// ══ WHY THE SYMPTOM POINTS AT THE FIELD, NOT AT THE RESOLVE ════════════════
//
// Emissive light reaches a pixel by TWO routes and the sun's bounce by one:
//
//   emissive → the screen-space analytic direct term (emitterShadowPass +
//              the resolve's emitterDirectAt) — no transport involved
//   emissive → the SRC field (light tree NEE inside [J])
//   sun      → the SRC field ONLY (deposit shades ray hits with the light
//              slots; the merge ladders it; the gather reads it)
//
// So "emissive works, sun indirect does not" is the exact signature of a LIVE
// resolve over a DEAD transport. This probe therefore reports the transport's
// own tallies (rays → deposits → merge → tiles → gather) per arm, which
// localizes the death to a stage instead of to "GI".
//
//   node scripts/run-gi-portable-envelope.mjs [url]
// Env:
//   PROJECT=C:/Users/Khudiiash/Documents/GAME  read-only via the tauri shim
//   SCENE=scenes/Level.scene
//   POSE=px,py,pz,tx,ty,tz
//   QUALITY=high        pinned per arm (the phone gets the BUILD's tier — see
//                       project.json build.quality, "ultra" as of 2026-08-23)
//   ARMS=desktop,portable
//   SETTLE=12000  PNG=1
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = `${PROJECT}/${process.env.SCENE ?? "scenes/Level.scene"}`;
// Inside the west room, looking north-and-up — the same verified pose the
// low-sun probe uses, so its ceiling/wall/floor regions are comparable.
const POSE = (process.env.POSE ?? "-8,1.6,5.5,-8,3.6,-3").split(",").map(Number);
const QUALITY = process.env.QUALITY ?? "high";
const SETTLE = Number(process.env.SETTLE ?? 12000);
const ARMS = (process.env.ARMS ?? "desktop,portable").split(",").map((s) => s.trim()).filter(Boolean);
const wantPng = process.env.PNG !== "0";
const OUT = ".gi-shots/portable-envelope";
mkdirSync(OUT, { recursive: true });

/** The WebGPU spec defaults for every key `resolveRendererLimits` raises. */
const PORTABLE_CAP = {
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxStorageBufferBindingSize: 134217728,
  maxBufferSize: 268435456,
};

const armGlobals = (arm) => ({
  __giConfigOverride: { quality: QUALITY },
  ...(arm === "portable" ? { __engineLimitsCap: PORTABLE_CAP } : {}),
  // ISOLATION ARM for the `Destroyed texture "ShadowDepthTexture"` storm the
  // portable arm shows: a baseline device has 4 storage textures, so
  // #buildLightShadow declines and every light with Shadow Source "gi" falls
  // back to shadow maps. `nolightshadow` reproduces JUST that decline, on
  // desktop limits — if the storm appears here too, the limits are innocent
  // and the bug is in the fallback, which is a far smaller thing to fix.
  ...(arm === "nolightshadow" ? { __giNoLightShadows: true } : {}),
});

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  protocolTimeout: 900_000,
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm) {
  const t0 = Date.now();
  // ONE BROWSER CONTEXT PER ARM — arms sharing a browser inherit each other's
  // editor layout through a channel localStorage.clear() does not close, and a
  // cross-arm comparison then measures the canvas size
  // ([[gi-harness-viewport-traps]]).
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const gi = [];
  const errors = [];
  const all = [];
  page.on("console", (m) => {
    const t = m.text();
    all.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m.type()} ${t.slice(0, 220)}`);
    if (/^\[gi\]|DEAD FIELD|DEAD SHADING|AUTO-RETRY/.test(t)) gi.push(t.slice(0, 400));
    if (m.type() === "error") errors.push(t.slice(0, 300));
  });
  page.on("pageerror", (e) => {
    const msg = String(e.message ?? e);
    if (!/save_scene/.test(msg)) errors.push(`pageerror ${msg.slice(0, 300)}`);
  });
  await installTauriShim(page, {}); // read-only by construction
  await page.evaluateOnNewDocument((project, globals, wantPasses) => {
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    globalThis.__probeWantGiPasses = wantPasses;
    for (const [k, v] of Object.entries(globals)) globalThis[k] = v;
  }, PROJECT, armGlobals(arm), process.env.GPUS === "1");

  await page.goto(url, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 90000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
  const call = async (op, payload) => page.evaluate(async ({ op, payload }) => {
    const end = performance.now() + 180_000;
    for (;;) {
      try { return await globalThis.__editorApi.call(op, payload); }
      catch (e) {
        if (performance.now() > end) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, { op, payload });
  await call("scene.open", { path: SCENE });

  const out = await page.evaluate(async ({ pose, settle, wantPasses }) => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    if (!engine) return { fail: "no engine" };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    {
      const end = performance.now() + 240_000;
      for (;;) {
        if (engine.modules?.get?.("gi")?.system?.state) break;
        if (performance.now() > end) return { fail: "gi never ready" };
        await sleep(500);
      }
    }
    const { THREE } = await import("/src/engine/index.js");
    const renderer = engine.renderer;
    const camera = engine.camera ?? engine.activeCamera;
    if (!camera) return { fail: "no camera" };

    // VERIFIED pose — a one-shot setCamera loses to the scene's own async
    // editor-camera restore, so re-issue until the live camera holds it.
    {
      const want = new THREE.Vector3(pose[0], pose[1], pose[2]);
      const end = performance.now() + 60_000;
      for (;;) {
        await globalThis.__editorApi.call("viewport.setCamera", {
          position: [pose[0], pose[1], pose[2]], target: [pose[3], pose[4], pose[5]],
        });
        await sleep(400);
        if (camera.position.distanceTo(want) < 0.05) break;
        if (performance.now() > end) return { fail: "pose never held" };
      }
    }
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    await sleep(settle);

    const limits = {};
    const dev = renderer.backend?.device?.limits;
    for (const k of [
      "maxStorageBuffersPerShaderStage", "maxStorageTexturesPerShaderStage",
      "maxUniformBuffersPerShaderStage", "maxStorageBufferBindingSize", "maxBufferSize",
    ]) limits[k] = dev?.[k] ?? null;

    const system = engine.modules.get("gi").system;
    const src = system.state?.screen?.srcProbes ?? null;
    // POLL rather than read once: all-zeros is an instrument fault until it
    // survives the wait (§12.39) — a pipeline can still be compiling.
    let stats = null;
    if (src) {
      const end = performance.now() + 60_000;
      for (;;) {
        stats = await src.readStats(renderer);
        if ((stats?.rays?.rays ?? 0) > 0 || performance.now() > end) break;
        await sleep(1500);
      }
    }

    // FRAME LUMINANCE, linear. The transport's own tallies say whether the
    // field is alive; this says whether the PICTURE is.
    const canvas = renderer.domElement;
    const cw = canvas.width, ch = canvas.height;
    const off = new OffscreenCanvas(cw, ch);
    const ctx = off.getContext("2d");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    ctx.drawImage(canvas, 0, 0);
    const img = ctx.getImageData(0, 0, cw, ch).data;
    const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    let sum = 0, dark = 0, n = 0;
    for (let i = 0; i < img.length; i += 16) {
      const l = 0.2126 * s2l(img[i] / 255) + 0.7152 * s2l(img[i + 1] / 255) + 0.0722 * s2l(img[i + 2] / 255);
      sum += l; if (l < 0.002) dark++; n++;
    }

    // ── PER-PASS GPU COST (GPUS=1) ─────────────────────────────────────────
    // Real WebGPU timestamp queries, so a compile-shape change (rolling an
    // unrolled slot loop, say) can be shown not to have bought its compile
    // time with frame time — the 60 fps floor outranks startup.
    let passes = null;
    if (wantPasses) {
      try {
        passes = await globalThis.__editorApi.call("profile.giPasses", { samples: 60 });
      } catch (e) { passes = { error: String(e?.message ?? e) }; }
    }

    // ── THE STORAGE-BUFFER CENSUS ──────────────────────────────────────────
    //
    // gi-gpu-smoke audits `state.queue` + `srcProbes.passes` only — the
    // OCCUPANCY CHAIN is dispatched separately (occupancyField.passes()) and
    // has never been in the audited set, which is how a 9-buffer kernel got
    // past the portable pin. Census every GI compute node there is.
    const census = [];
    {
      const nodes = [];
      const push = (name, node) => { if (node && typeof node === "object") nodes.push([name, node]); };
      const occ = system.state?.volume?.occupancyField;
      try {
        (occ?.prewarmComputes?.() ?? []).forEach((n, i) => push(n.__giPassName ?? `occupancy#${i}`, n));
      } catch (e) { census.push({ name: "occupancy chain", error: String(e?.message ?? e) }); }
      (system.state?.queue ?? []).forEach((n, i) => push(n.__giPassName ?? `queue[${i}]`, n));
      (system.state?.screen?.srcProbes?.passes ?? []).forEach((n, i) => push(n.__giPassName ?? `src#${i}`, n));
      for (const [name, node] of nodes) {
        let shader = "";
        try { shader = renderer._nodes?.getForCompute?.(node)?.computeShader ?? ""; } catch { /* not built */ }
        if (!shader) continue;
        const lines = shader.split("\n").filter((l) => l.includes("var<storage"));
        // The WGSL names are `NodeBuffer_<nodeId>` and say nothing. The STRUCT
        // that each one is typed by does — `array<i32>` is the fit scratch,
        // `array<vec4<f32>>` the vertex pool — so carry the declaration too.
        const structOf = (line) => {
          const id = (line.match(/NodeBuffer_(\d+)/) ?? [])[1];
          if (!id) return "";
          const m = shader.match(new RegExp(`struct NodeBuffer_${id}Struct[^}]*}`, "s"));
          return (m?.[0] ?? "").replace(/\s+/g, " ").slice(0, 90);
        };
        census.push({
          name, storage: lines.length, kb: +(shader.length / 1024).toFixed(0),
          lines: lines.map((l) => `${(l.match(/NodeBuffer_\d+/) ?? [""])[0]}  ${structOf(l)}`),
          wgsl: lines.length > 8 ? shader : null,
        });
      }
    }

    return {
      limits,
      census,
      passes,
      canvas: `${cw}x${ch}`,
      quality: system.config?.quality ?? null,
      meanLum: sum / n,
      darkFrac: dark / n,
      src: src ? {
        live: stats.cascades?.map((c) => c.live) ?? null,
        rays: stats.rays?.rays ?? 0,
        hitRate: stats.rays?.hitRate ?? null,
        deposits: stats.rays?.deposits ?? 0,
        secondaryHits: stats.rays?.secondaryHits ?? null,
        shaded: stats.rays?.shaded ?? null,
        mergeBins: stats.merge?.bins ?? null,
        orphanRate: stats.merge?.orphanRate ?? null,
        meanCorners: stats.merge?.meanCorners ?? null,
        tilesLit: stats.tiles?.lit ?? null,
        tileMaxLum: stats.tiles?.maxLum ?? null,
        tileMeanLum: stats.tiles?.meanLum ?? null,
        gatherLit: stats.gather?.lit ?? null,
        gatherPixels: stats.gather?.pixels ?? null,
        gatherMeanLum: stats.gather?.meanLum ?? null,
      } : "NO SRC SYSTEM",
    };
  }, { pose: POSE, settle: SETTLE, wantPasses: process.env.GPUS === "1" });

  if (wantPng && !out.fail) {
    const shot = await page.screenshot({ encoding: "base64" });
    writeFileSync(`${OUT}/${arm}.png`, Buffer.from(shot, "base64"));
  }
  await context.close();
  // FULLLOG=1 keeps every console line in ORDER — the only way to see what a
  // storm of identical validation errors was preceded by.
  if (process.env.FULLLOG === "1") writeFileSync(`${OUT}/${arm}.log`, all.join("\n"));
  return { arm, ...out, gi, errors };
}

const results = [];
for (const arm of ARMS) {
  process.stdout.write(`\n── ${arm} ──────────────────────────────────────────\n`);
  try {
    const r = await runArm(arm);
    results.push(r);
    if (r.fail) { console.log(`  FAIL ${r.fail}`); continue; }
    console.log(`  device limits: ${Object.entries(r.limits).map(([k, v]) =>
      `${k.replace("maxStorage", "stg").replace("maxUniform", "uni").replace("PerShaderStage", "")}=${v}`).join(" ")}`);
    console.log(`  canvas ${r.canvas}  quality ${r.quality}  frame meanLum ${r.meanLum.toFixed(4)} dark ${(r.darkFrac * 100).toFixed(1)}%`);
    if (typeof r.src === "string") console.log(`  src: ${r.src}`);
    else {
      const s = r.src;
      console.log(`  src live[${s.live?.join(",")}] rays ${s.rays} hit ${((s.hitRate ?? 0) * 100).toFixed(0)}% ` +
        `deposits ${s.deposits} shaded ${s.shaded} secondaryHits ${s.secondaryHits}`);
      console.log(`  merge bins ${s.mergeBins} corners ${s.meanCorners?.toFixed?.(2)}/8 orphan ${((s.orphanRate ?? 0) * 100).toFixed(1)}%`);
      console.log(`  tiles lit ${s.tilesLit} mean ${s.tileMeanLum?.toFixed?.(4)} max ${s.tileMaxLum?.toFixed?.(4)} | ` +
        `gather ${s.gatherLit}/${s.gatherPixels} mean ${s.gatherMeanLum?.toFixed?.(4)}`);
    }
    if (r.census?.length) {
      const over = r.census.filter((c) => (c.storage ?? 0) > 8).sort((a, b) => b.storage - a.storage);
      const near = r.census.filter((c) => (c.storage ?? 0) >= 6 && (c.storage ?? 0) <= 8);
      console.log(`  census: ${r.census.length} kernels; ${over.length} OVER the portable 8, ${near.length} at 6-8`);
      for (const c of over) {
        console.log(`   ⛔ ${c.name}: ${c.storage} storage buffers (${c.kb}kB)`);
        for (const l of c.lines) console.log(`        ${l.trim().slice(0, 150)}`);
        if (c.wgsl) {
          writeFileSync(`${OUT}/${c.name.replace(/[^\w#-]/g, "_")}.wgsl`, c.wgsl);
          console.log(`        (full WGSL → ${OUT}/${c.name}.wgsl)`);
        }
      }
      for (const c of near) console.log(`    · ${c.name}: ${c.storage} (${c.kb}kB)`);
    }
    if (r.passes && !r.passes.error) {
      // The op nests: screen passes under one key, the frame queue under
      // another, plus scalar counts at the top level. Flatten every numeric
      // leaf and rank — a hard-coded key set goes stale the next time a pass
      // is added, and a missing pole reads as "cheap".
      const rows = [];
      const walk = (obj, prefix) => {
        for (const [k, v] of Object.entries(obj ?? {})) {
          if (typeof v === "number") rows.push([prefix + k, v]);
          else if (v && typeof v === "object") walk(v, `${prefix}${k}.`);
        }
      };
      walk(r.passes.screenPassesMs ?? r.passes.passes, "");
      walk(r.passes.queueMs, "q:");
      rows.sort((a, b) => b[1] - a[1]);
      console.log(`  GPU passes: ${rows.filter(([, v]) => v > 0.02).slice(0, 12)
        .map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  ")}`);
    } else if (r.passes?.error) console.log(`  giPasses failed: ${r.passes.error}`);
    for (const l of r.gi) console.log(`  ${l}`);
    for (const e of r.errors.slice(0, 15)) console.log(`  ERR ${e}`);
    if (r.errors.length > 15) console.log(`  ERR … ${r.errors.length - 15} more`);
  } catch (e) {
    console.log(`  ARM THREW ${String(e.message ?? e).slice(0, 300)}`);
  }
}
await browser.close();

if (results.length === 2 && !results[0].fail && !results[1].fail) {
  const [a, b] = results;
  const alive = (r) => typeof r.src === "object" && (r.src.gatherMeanLum ?? 0) > 1e-4;
  console.log(`\n── VERDICT ────────────────────────────────────────────`);
  console.log(`  ${a.arm}: field ${alive(a) ? "ALIVE" : "DEAD"} (gather mean ${typeof a.src === "object" ? a.src.gatherMeanLum : "n/a"})`);
  console.log(`  ${b.arm}: field ${alive(b) ? "ALIVE" : "DEAD"} (gather mean ${typeof b.src === "object" ? b.src.gatherMeanLum : "n/a"})`);
  if (alive(a) && !alive(b)) console.log("  ⇒ the portable envelope KILLS the transport — this is the mobile bug.");
  else if (alive(a) && alive(b)) console.log("  ⇒ the transport survives the portable envelope; mobile loss is elsewhere (speed, driver, or the build's tier).");
}
