// U1 — THE `__giSrcWorldKeys` DEFAULT-FLIP GATE (plan "NEXT" item 2, §15 U1).
//
// The mechanical conversion (srcRef.js mirror + srcGizmos.js) shipped with
// bit-identical transport numbers on both arms; what remains before the flip is
// the plan's three GPU gates, all three in this harness:
//
//   G1  PIXEL DIFF     — world keys must not change the picture. Diff is judged
//                        against the honest yardstick: a second boot of the SAME
//                        shipped arm (cross-boot temporal noise), never zero.
//   G3  FREEZELESS     — 100 m teleport and return with a rAF frame-delta
//                        recorder armed. The plan's literal criterion ("no frame
//                        > 2× median") is REPORTED, but the GATE is comparative
//                        (world's spike ratio vs shipped's, plus a 500 ms hard
//                        cap): on a GPU shared with a live editor an absolute
//                        2×median trips on ambient contention, and the claim
//                        under test is that world keys ADD no freeze.
//   G4  MEMORY         — three loops of the same 200 m out-and-back walk; heap
//                        (gc'd) and live-probe totals sampled at each loop's
//                        end. Growth loop-over-loop is the failure: a store that
//                        accumulates per visited cell climbs every lap.
//
// Three arms, every flag explicit on every arm (this module's standing rule):
//
//   shipped    __giSrcWorldKeys=false                        (today's default)
//   shipped2   identical re-boot of shipped                  (G1's noise floor)
//   world      __giSrcWorldKeys=true, __giSrcProbeRetain=true (the flip state)
//
//   node scripts/run-gi-worldkeys-flip-gate.mjs      (vite on :5201)
//   ARMS=shipped,shipped2,world SETTLE=22000 QUALITY=high LOOPS=3
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeEmissiveStormProject } from "./lib/makeEmissiveStormProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = path.resolve("scripts/.gi-worldkeys-flip").replaceAll("\\", "/");
const ARMS = (process.env.ARMS ?? "shipped,shipped2,world").split(",").map((s) => s.trim());
const SETTLE = Number(process.env.SETTLE ?? 22000);
const QUALITY = process.env.QUALITY ?? "high";
const LOOPS = Number(process.env.LOOPS ?? 3);
const OUT = ".gi-shots/worldkeys-flip";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// The enclosed storm room — same rig as the spin gate, so its numbers carry.
await makeEmissiveStormProject(GEN_ROOT, {
  lampMobility: "static", emitStrength: 8, enclosed: true, gi: { quality: QUALITY },
});

const POSE_A = { position: [0, 1.9, 0], target: [0, 1.4, -6] };
const TELEPORT = { position: [100, 1.9, 0], target: [100, 1.4, -6] };
// One walk lap: out to x=100 in 8 hops, back in 8. The room re-enters view on
// the return leg every lap, so per-cell leakage shows as lap-over-lap growth.
const LAP = [];
for (let i = 1; i <= 8; i++) LAP.push({ position: [i * 12.5, 1.9, 0], target: [i * 12.5, 1.4, -6] });
for (let i = 7; i >= 0; i--) LAP.push({ position: [i * 12.5, 1.9, 0], target: [i * 12.5, 1.4, -6] });

const FLAGS = {
  shipped: { __giSrcWorldKeys: false },
  shipped2: { __giSrcWorldKeys: false },
  world: { __giSrcWorldKeys: true, __giSrcProbeRetain: true },
  // Diagnostic arm (not in the default set): keying without retention — the
  // spin gate's isolator. If `world` diverges from shipped but this arm does
  // not, the divergence belongs to retention; if this arm already diverges,
  // to the keying itself. ARMS=shipped,worldonly,world to attribute.
  worldonly: { __giSrcWorldKeys: true, __giSrcProbeRetain: false },
};

// ONE BROWSER PER ARM. Sharing a browser leaked UI layout from arm to arm
// through a channel localStorage.clear() does not reach (the third page kept
// booting a 520px-tall viewport against the first two's 342px, run after run)
// — and a cross-arm pixel diff at different canvas sizes measures the layout,
// not the lighting. A fresh temp profile per arm closes every such channel.
const launchBrowser = () => puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--enable-precise-memory-info", "--js-flags=--expose-gc",
  ],
});

async function bootArm(browser, arm) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  let built = false;
  let bootLine = "";
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\] built/.test(t)) built = true;
    if (/\[gi\] src probes:/.test(t) && !bootLine) bootLine = t;
  });
  page.on("pageerror", (e) => {
    const msg = e.message ?? String(e);
    if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument((project, flags) => {
    // The three arms share one browser, so persisted UI layout leaks from arm
    // to arm through localStorage — the first run of this gate booted its third
    // arm with a taller viewport + stats HUD and G1 diffed the LAYOUT, not the
    // lighting (the spin rig's "different gbuffer sizes" trap, reproduced).
    // Clear everything, then set only what a boot needs.
    localStorage.clear();
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
  }, GEN_ROOT, FLAGS[arm]);
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, GEN_ROOT);
  for (let i = 0; i < 180 && !built; i++) await wait(1000);
  if (!built) { await page.close(); throw new Error(`${arm}: never built`); }
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 60000 });
  return { page, bootLine: () => bootLine };
}

// ── In-page instruments ─────────────────────────────────────────────────────
// All 2D-canvas / counter reads — never a WebGPU call from the harness (§12.65).

const lumOf = (page) => page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const ids = await api.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const engine = api.entities.live(anyId)?.engine;
  return await new Promise((resolve) => {
    let n = 0;
    const off = engine.onPostRender(() => {
      if (++n < 2) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      const x0 = Math.floor(c.width * 0.2), y0 = Math.floor(c.height * 0.2);
      const w = Math.floor(c.width * 0.6), h = Math.floor(c.height * 0.6);
      const d = ctx.getImageData(x0, y0, w, h).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      resolve(s / (d.length / 4) / 255);
    });
  });
});

// Centre crop, stride-4 downsample, RGB triplets — the G1 image. Small enough
// to hand back over JSON, big enough that a structural shift cannot hide.
const pixelsOf = (page) => page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const ids = await api.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const engine = api.entities.live(anyId)?.engine;
  return await new Promise((resolve) => {
    let n = 0;
    const off = engine.onPostRender(() => {
      if (++n < 2) return;
      off();
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      const x0 = Math.floor(c.width * 0.2), y0 = Math.floor(c.height * 0.2);
      const w = Math.floor(c.width * 0.6), h = Math.floor(c.height * 0.6);
      const d = ctx.getImageData(x0, y0, w, h).data;
      const out = [];
      for (let y = 0; y < h; y += 4) {
        for (let x = 0; x < w; x += 4) {
          const i = (y * w + x) * 4;
          out.push(d[i], d[i + 1], d[i + 2]);
        }
      }
      resolve({ pix: out, canvasW: src.width, canvasH: src.height });
    });
  });
});

const countersOf = (page) => page.evaluate(async () => {
  const api = globalThis.__editorApi;
  const ids = await api.call("entity.list", {});
  const anyId = (ids.value ?? ids)?.[0]?.id;
  const engine = api.entities.live(anyId)?.engine;
  const src = engine.modules?.get?.("gi")?.system?.state?.screen?.srcProbes ?? null;
  let live = -1, held = -1, failed = -1;
  try {
    if (src?.readPressure) {
      const p = await src.readPressure(engine.renderer);
      live = 0; held = 0; failed = 0;
      for (const s of p.cascades ?? []) { live += s.live; held += s.held ?? 0; failed += s.failed; }
    }
  } catch { /* a readback that fails must not fail the arm */ }
  globalThis.gc?.();
  const heap = performance.memory?.usedJSHeapSize ?? -1;
  return { live, held, failed, heap, reanchors: src?.reanchorCount ?? -1 };
});

const startFrameRecorder = (page) => page.evaluate(() => {
  globalThis.__ftArr = [];
  globalThis.__ftOn = true;
  let last = performance.now();
  const tick = (t) => {
    globalThis.__ftArr.push(t - last);
    last = t;
    if (globalThis.__ftOn) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const stopFrameRecorder = (page) => page.evaluate(() => {
  globalThis.__ftOn = false;
  const a = globalThis.__ftArr ?? [];
  return a.slice(1); // first delta spans the recorder's own install
});

const setPose = (page, pose) => page.evaluate(
  async (p) => { await globalThis.__editorApi.call("viewport.setCamera", p); },
  { position: pose.position, target: pose.target },
);

// Convergence polling, the refl-gate idiom: two reads within 3% — never a
// fixed settle (a shared GPU converges when it converges, not on a schedule).
async function converge(page, label) {
  let prev = await lumOf(page);
  for (let i = 0; i < 36; i++) {
    await wait(2500);
    const cur = await lumOf(page);
    if (Math.abs(cur - prev) <= 0.03 * Math.max(cur, 1e-4)) return cur;
    prev = cur;
  }
  console.log(`  ⚠ ${label}: never converged within poll budget (last ${prev.toFixed(4)})`);
  return prev;
}

async function runArm(arm, expectCanvas) {
  const browser = await launchBrowser();
  const { page, bootLine } = await bootArm(browser, arm);
  await setPose(page, POSE_A);
  await wait(SETTLE);
  let lum = await converge(page, `${arm} pose A`);
  // Dead-boot marker (the U2 lesson): an enclosed lamp-lit room reading black
  // is a dead field, and one retry is cheaper than a poisoned A/B.
  if (lum < 0.005) {
    console.log(`  ⚠ ${arm}: dead boot marker (lum ${lum.toFixed(5)}) — extending poll for the auto-retry heal`);
    lum = await converge(page, `${arm} pose A (heal)`);
    if (lum < 0.005) { await page.close(); throw new Error(`${arm}: dead boot twice`); }
  }
  console.log(`  ${arm}: converged at ${lum.toFixed(4)}`);
  const { pix: pixA, canvasW, canvasH } = await pixelsOf(page);
  console.log(`  ${arm}: canvas ${canvasW}x${canvasH}`);
  // Abort THE MOMENT the canvas mismatches — laps against an incomparable
  // canvas are minutes spent proving nothing.
  if (expectCanvas && (canvasW !== expectCanvas[0] || canvasH !== expectCanvas[1])) {
    await browser.close();
    throw new Error(`INSTRUMENT: ${arm} canvas ${canvasW}x${canvasH} != ${expectCanvas[0]}x${expectCanvas[1]}`);
  }
  await page.screenshot({ path: `${OUT}/${arm}-poseA.png` });

  // G3 — teleport with the recorder armed.
  await startFrameRecorder(page);
  await setPose(page, TELEPORT);
  await wait(3000);
  await setPose(page, POSE_A);
  await wait(3000);
  const frames = await stopFrameRecorder(page);

  // G4 — the walk. Counters at boot, then after each lap (gc'd heap).
  const mem = [await countersOf(page)];
  for (let lap = 0; lap < LOOPS; lap++) {
    for (const p of LAP) { await setPose(page, p); await wait(1100); }
    await setPose(page, POSE_A);
    await wait(3000);
    mem.push(await countersOf(page));
    console.log(
      `  ${arm} lap ${lap + 1}: heap ${(mem.at(-1).heap / 1048576).toFixed(1)}MB  live ${mem.at(-1).live}  ` +
      `held ${mem.at(-1).held}  failed ${mem.at(-1).failed}  reanchors ${mem.at(-1).reanchors}`,
    );
  }

  // Post-walk look, for the record (both arms converge; the PNG pair is the
  // human-check that the walk did not permanently disfigure either).
  const lumBack = await converge(page, `${arm} pose A post-walk`);
  await page.screenshot({ path: `${OUT}/${arm}-poseA-postwalk.png` });
  await page.close();
  await browser.close();
  return { arm, bootLine: bootLine(), lum, lumBack, pixA, canvasW, canvasH, frames, mem };
}

const results = [];
for (const arm of ARMS) {
  console.log(`\n── arm ${arm}`);
  const expect = results[0] ? [results[0].canvasW, results[0].canvasH] : null;
  results.push(await runArm(arm, expect));
}
const byArm = Object.fromEntries(results.map((r) => [r.arm, r]));

// ── Statistics ──────────────────────────────────────────────────────────────
const meanAbsDiff = (a, b) => {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
};
const p99Diff = (a, b) => {
  const n = Math.min(a.length, b.length);
  const d = new Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.abs(a[i] - b[i]);
  d.sort((x, y) => x - y);
  return d[Math.floor(n * 0.99)];
};
const frameStats = (frames) => {
  const s = [...frames].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)] || 1;
  const max = s[s.length - 1] ?? 0;
  const spikes = frames.filter((d) => d > 2 * median).length;
  return { median, max, ratio: max / median, spikes, count: frames.length };
};

console.log(`\n== U1 WORLD-KEYS FLIP GATE (${QUALITY}, enclosed storm room, ${LOOPS} laps) ==`);
let pass = true;
const say = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) pass = false;
};

const ship = byArm.shipped, ship2 = byArm.shipped2, world = byArm.world;

// INSTRUMENT PRECONDITION — every arm must have rendered the same canvas. A
// mismatch is a broken instrument, never a gate verdict (first-run lesson).
const sizes = results.map((r) => `${r.arm}:${r.canvasW}x${r.canvasH}`);
if (new Set(results.map((r) => `${r.canvasW}x${r.canvasH}`)).size > 1) {
  console.log(`\nINSTRUMENT ERROR: arms rendered different canvases — ${sizes.join("  ")}`);
  console.log("Cross-arm pixels/luminance/populations are not comparable. Fix the layout leak and re-run.");
  process.exit(2);
}

// G1 — pixel diff against the cross-boot noise floor.
if (ship && ship2 && world) {
  const noise = meanAbsDiff(ship.pixA, ship2.pixA);
  const delta = meanAbsDiff(world.pixA, ship.pixA);
  const noiseP99 = p99Diff(ship.pixA, ship2.pixA);
  const deltaP99 = p99Diff(world.pixA, ship.pixA);
  console.log(`  G1  noise floor (shipped vs shipped2): mean ${noise.toFixed(2)}  p99 ${noiseP99}`);
  console.log(`  G1  world vs shipped:                  mean ${delta.toFixed(2)}  p99 ${deltaP99}`);
  say("G1 pixel diff within 2× cross-boot noise", delta <= Math.max(2 * noise, 4), `${delta.toFixed(2)} vs allowed ${Math.max(2 * noise, 4).toFixed(2)}`);
}

// G3 — freezeless teleport.
if (ship && world) {
  const fs_ = frameStats(ship.frames), fw = frameStats(world.frames);
  console.log(`  G3  shipped: median ${fs_.median.toFixed(1)}ms  max ${fs_.max.toFixed(0)}ms  ratio ${fs_.ratio.toFixed(1)}  >2×median ${fs_.spikes}/${fs_.count}`);
  console.log(`  G3  world:   median ${fw.median.toFixed(1)}ms  max ${fw.max.toFixed(0)}ms  ratio ${fw.ratio.toFixed(1)}  >2×median ${fw.spikes}/${fw.count}`);
  console.log(`  G3  plan's literal criterion on world arm (no frame > 2× median): ${fw.spikes === 0 ? "MET" : `${fw.spikes} spikes (informational under shared GPU)`}`);
  say("G3 world adds no freeze over shipped", fw.ratio <= fs_.ratio * 1.5 + 0.5, `ratio ${fw.ratio.toFixed(1)} vs shipped ${fs_.ratio.toFixed(1)}`);
  say("G3 hard cap: no world frame > 500ms", fw.max <= 500, `max ${fw.max.toFixed(0)}ms`);
}

// G4 — memory fixed across the walk (lap 1 → lap N growth, both stores).
if (ship && world) {
  for (const r of [ship, world]) {
    const h1 = r.mem[1]?.heap ?? r.mem[0].heap, hN = r.mem.at(-1).heap;
    const l1 = r.mem[1]?.live ?? r.mem[0].live, lN = r.mem.at(-1).live;
    r.heapGrowth = (hN - h1) / 1048576;
    r.liveGrowth = lN - l1;
    console.log(`  G4  ${r.arm.padEnd(8)} heap lap1→lap${LOOPS} ${r.heapGrowth >= 0 ? "+" : ""}${r.heapGrowth.toFixed(1)}MB  live ${l1}→${lN}  failed↑ ${Math.max(...r.mem.map((m) => m.failed))}  reanchors ${r.mem.at(-1).reanchors}`);
  }
  say("G4 heap fixed across laps", world.heapGrowth <= Math.max(ship.heapGrowth * 1.5, 8), `world +${world.heapGrowth.toFixed(1)}MB vs allowed ${Math.max(ship.heapGrowth * 1.5, 8).toFixed(1)}MB`);
  say("G4 probe store does not accumulate per lap", world.liveGrowth <= Math.max(64, (world.mem[1]?.live ?? 1) * 0.25), `live growth ${world.liveGrowth}`);
  say("G4 no dropped inserts on world arm", Math.max(...world.mem.map((m) => m.failed)) === 0, `failed ${Math.max(...world.mem.map((m) => m.failed))}`);
  const wr = world.mem.at(-1).reanchors;
  say("G4 world keys never re-anchor across a 600m walk", wr <= 1, `reanchorCount ${wr} (shipped: ${ship.mem.at(-1).reanchors})`);
}

writeFileSync(`${OUT}/result.json`, JSON.stringify({
  quality: QUALITY, loops: LOOPS,
  results: results.map(({ pixA, frames, ...r }) => ({ ...r, frameStats: frameStats(frames) })),
}, null, 2));

console.log(`\nU1 FLIP GATE: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
