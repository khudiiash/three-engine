// DETAIL-BOX DENSITY PROBE (2026-08-22 night, §15 fronts 2+4) — measures, on
// the USER'S OWN LEVEL (frozen snapshot), what the §13 F1 detail box buys
// indoors and what it costs while moving.
//
// THE LEVER: the Level auto-fits to 40.7×12.1×41.8 m — under the 60 m
// DETAIL_TRIGGER — so `high` lands at 1.10 m probes / 0.33 m field cells and
// the boot ledger itself prints the consequences (rings/bands warning, 65/88
// thin-mesh warning). `__giConfigOverride.detailExtent = 16` force-arms a
// 16 m camera-centred box: SAME budgets re-spent → ~0.4 m probes / ~0.13 m
// cells indoors, far field covered by the shipped §13 F3 fallback.
//
// THE INTERLOCK priced here too: a smaller box slides more (F2 hysteresis is
// extent/6), and slides churn probes under anchor-relative keys — which is
// where world keys WITHOUT retention may earn back their reverted flip (the
// Level-scale movement price the U1 revert demands, retention bisected).
//
// ARMS (one BROWSER each — the shared-browser layout trap):
//   base        as authored (quality pinned high)
//   detail16    + detailExtent 16
//   detail16wk  + detailExtent 16 + world keys, retention OFF
//   wk          world keys only, retention OFF   (freeze bisect: keying)
//   wkret       world keys + retention           (the reverted flip state)
//
// MEASUREMENTS per arm:
//   · boot lines: probe spacing, volume dims, "detail volume armed"
//   · held-pose flat-region step energy (the lowsun probe's statistic —
//     blockIndex = step8/step2; banding/blockiness at the SAME pose)
//   · MOVEMENT: two laps of a west-room rectangle at play speed with an rAF
//     frame recorder — median/p95/max, spikes>2×median, freezes>50 ms,
//     'follow: slide' count
//   · post-movement recovery: region mean at stop vs +3 s (slide churn)
//
// This is a PROBE: numbers + PNGs; fails only on boot errors.
//
//   node scripts/run-gi-detail-density-probe.mjs [url]
// Env: PROJECT (default the 08-22 snapshot), SCENE, QUALITY=high,
//      ARMS=base,detail16,detail16wk,wk,wkret  POSE=  SETTLE=9000  PNG=1
import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/AppData/Local/Temp/claude/game-snapshot-0822").replaceAll("\\", "/");
const SCENE = `${PROJECT}/${process.env.SCENE ?? "scenes/Level.scene"}`;
const POSE = (process.env.POSE ?? "-8,1.6,5.5,-8,3.6,-3").split(",").map(Number);
const SETTLE = Number(process.env.SETTLE ?? 9000);
const GRID = Number(process.env.GRID ?? 64);
const QUALITY = process.env.QUALITY ?? "high";
const ARMS = (process.env.ARMS ?? "base,detail16,detail16wk,wk,wkret")
  .split(",").map((s) => s.trim()).filter(Boolean);
const wantPng = process.env.PNG === "1";
const OUT = ".gi-shots/detail-density";
mkdirSync(OUT, { recursive: true });

// West-room walk rectangle (the lowsun probe's room: x ∈ [−12,−4], z ∈ [−8,8])
// at ~3.5 m/s — play speed. The camera looks at the next waypoint, like a
// player walking. Two laps.
const WALK = [
  [-11, 1.6, 3], [-5, 1.6, 3], [-5, 1.6, -3], [-11, 1.6, -3],
];
const WALK_SPEED = 3.5;
const WALK_LAPS = 2;

const armGlobals = (arm) => {
  const cfg = { quality: QUALITY };
  if (arm === "detail16" || arm === "detail16wk") cfg.detailExtent = 16;
  return {
    __giConfigOverride: cfg,
    // EVERY flag explicit on EVERY arm (the module's standing rule).
    // Post-re-flip: world keys+retention are the DEFAULT; base/detail16 set
    // false explicitly, the wk arms say what they arm.
    __giSrcWorldKeys: arm === "detail16wk" || arm === "wk" || arm === "wkret",
    __giSrcProbeRetain: arm === "wkret",
    // noretry: the §12.56 control — signature logged, re-mint suppressed.
    ...(arm === "noretry" ? { __giNoDeadFieldRetry: true } : {}),
  };
};

const launchBrowser = () => puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  protocolTimeout: 900_000,
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm) {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  let pageErrors = 0;
  const watchdogLines = [];
  const bootLines = [];
  let slideCount = 0;
  page.on("console", (m) => {
    const t = m.text();
    if (/§12\.56 AUTO-RETRY|§12\.56 signature|DEAD FIELD|DEAD SHADING/.test(t)) watchdogLines.push(t.slice(0, 180));
    // The uncapturederror listener (Engine.js, 2026-08-22 night): the first
    // time the §12.56 wedge's ACTUAL validation error is visible anywhere.
    if (/\[gpu\] UNCAPTURED|\[gpu\] DEVICE LOST/.test(t)) watchdogLines.push(t.slice(0, 1200));
    if (/\[gi\] built |\[gi\] src probes: |detail volume armed|probe spacing is/.test(t)) bootLines.push(t.slice(0, 260));
    if (/follow: slide/.test(t)) slideCount++;
  });
  page.on("pageerror", (e) => {
    const msg = String(e.message ?? e);
    if (!/save_scene/.test(msg)) { pageErrors++; console.log(`  pageerror: ${msg.slice(0, 200)}`); }
  });
  await installTauriShim(page, {});   // no writableRoot — read-only by construction
  await page.evaluateOnNewDocument((project, globals) => {
    localStorage.clear();
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    if (globals) for (const [k, v] of Object.entries(globals)) globalThis[k] = v;
  }, PROJECT, armGlobals(arm));

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

  const slidesBeforeWalk = () => slideCount;

  const result = await page.evaluate(async ({ grid, settle, pose, walk, walkSpeed, walkLaps }) => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    if (!engine) return { fail: "no engine" };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    {
      const end = performance.now() + 180_000;
      for (;;) {
        const system = engine.modules?.get?.("gi")?.system ?? null;
        if (system?.state) break;
        if (performance.now() > end) return { fail: "gi never ready" };
        await sleep(500);
      }
    }
    const { THREE } = await import("/src/engine/index.js");
    const renderer = engine.renderer;
    const scene = engine.scene;
    const camera = engine.camera ?? engine.activeCamera;
    if (!camera) return { fail: "no camera" };

    // VERIFIED pose — re-issue until it holds (the async editor-camera
    // restore stomps a one-shot setCamera).
    const setPose = (p, t) => globalThis.__editorApi.call("viewport.setCamera", { position: p, target: t });
    {
      const want = new THREE.Vector3(pose[0], pose[1], pose[2]);
      const end = performance.now() + 60_000;
      for (;;) {
        await setPose([pose[0], pose[1], pose[2]], [pose[3], pose[4], pose[5]]);
        await sleep(400);
        if (camera.position.distanceTo(want) < 0.05) break;
        if (performance.now() > end) return { fail: "pose never held" };
      }
    }
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    await sleep(settle);

    // ── FLAT REGIONS BY CPU RAYCAST (lowsun probe's block, verbatim) ──────
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const targets = [];
    scene.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      if (o.userData?.__giDebug || o.userData?.editorOnly) return;
      targets.push(o);
    });
    const W = grid;
    const H = Math.max(8, Math.round(grid * (renderer.domElement.height / renderer.domElement.width)));
    const nm = new THREE.Matrix3();
    const nrm = new THREE.Vector3();
    const groups = new Map();
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        raycaster.setFromCamera({ x: ((i + 0.5) / W) * 2 - 1, y: 1 - ((j + 0.5) / H) * 2 }, camera);
        const hit = raycaster.intersectObjects(targets, false).find((h) => h.face);
        if (!hit) continue;
        const mat = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material;
        const em = mat?.emissive;
        if (em && (em.r + em.g + em.b) > 1e-4) continue;
        nm.getNormalMatrix(hit.object.matrixWorld);
        nrm.copy(hit.face.normal).applyMatrix3(nm).normalize();
        const axis = Math.abs(nrm.y) > 0.8 ? (nrm.y > 0 ? "floor" : "ceiling") : "wall";
        const key = `${hit.object.name || hit.object.id}|${axis}`;
        if (!groups.has(key)) groups.set(key, { key, axis, us: [], vs: [] });
        const g = groups.get(key);
        g.us.push((i + 0.5) / W);
        g.vs.push((j + 0.5) / H);
      }
    }
    const regions = [...groups.values()]
      .filter((g) => g.us.length >= 25)
      .map((g) => {
        const lo = (a) => Math.min(...a), hi = (a) => Math.max(...a);
        const trim = (l, h) => [l + (h - l) * 0.15, h - (h - l) * 0.15];
        const [u0, u1] = trim(lo(g.us), hi(g.us));
        const [v0, v1] = trim(lo(g.vs), hi(g.vs));
        return { key: g.key, n: g.us.length, u0, u1, v0, v1 };
      })
      .sort((a, b) => b.n - a.n)
      .slice(0, 4);
    if (!regions.length) return { fail: "no flat regions found at this pose" };

    const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const measureFrame = async () => {
      const canvas = renderer.domElement;
      const cw = canvas.width, ch = canvas.height;
      const off = new OffscreenCanvas(cw, ch);
      const ctx = off.getContext("2d");
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      ctx.drawImage(canvas, 0, 0);
      const img = ctx.getImageData(0, 0, cw, ch).data;
      const lumAt = (x, y) => {
        const o = (y * cw + x) * 4;
        return 0.2126 * srgbToLinear(img[o] / 255) + 0.7152 * srgbToLinear(img[o + 1] / 255) + 0.0722 * srgbToLinear(img[o + 2] / 255);
      };
      return regions.map((r) => {
        const x0 = Math.round(r.u0 * cw), x1 = Math.round(r.u1 * cw);
        const y0 = Math.round(r.v0 * ch), y1 = Math.round(r.v1 * ch);
        let sum = 0, count = 0;
        const steps = { 2: [0, 0], 8: [0, 0], 16: [0, 0] };
        for (let y = y0; y <= y1; y += 2) {
          for (let x = x0; x <= x1; x += 2) {
            const l = lumAt(x, y);
            sum += l; count++;
            for (const k of [2, 8, 16]) {
              if (x + k <= x1) { steps[k][0] += Math.abs(lumAt(x + k, y) - l); steps[k][1]++; }
              if (y + k <= y1) { steps[k][0] += Math.abs(lumAt(x, y + k) - l); steps[k][1]++; }
            }
          }
        }
        const mean = count ? sum / count : 0;
        const st = (k) => (steps[k][1] && mean > 1e-5 ? steps[k][0] / steps[k][1] / mean : 0);
        const s2 = st(2), s8 = st(8), s16 = st(16);
        return {
          region: r.key, n: r.n,
          mean: +mean.toFixed(5),
          step2: +s2.toFixed(4), step8: +s8.toFixed(4), step16: +s16.toFixed(4),
          blockIndex: +(s8 / Math.max(s2, 1e-4)).toFixed(2),
        };
      });
    };

    // Convergence poll (two reads, all regions within 3%).
    const converged = (a, b) => a.every((r, i) =>
      Math.abs(r.mean - b[i].mean) <= Math.max(0.03 * Math.max(r.mean, b[i].mean), 1e-4));
    let held = await measureFrame();
    {
      const deadline = performance.now() + 150_000;
      for (;;) {
        await sleep(4000);
        const next = await measureFrame();
        const done = converged(held, next);
        held = next;
        if (done || performance.now() > deadline) break;
      }
    }
    // DEAD-FIELD marker + heal window (run 1's lesson: both arms measured a
    // dead field and the quality half compared direct raster light with
    // itself, bit-identically). A ceiling region at < 0.001 linear in an
    // interior is a dead/negligible field — wait out the §12.56 auto-retry's
    // re-mint, then re-converge; if still dead, the arm's quality stats are
    // marked and must not be compared.
    const isDead = (rs) => rs.some((r) => r.region.endsWith("|ceiling") && r.mean < 0.001);
    let dead = isDead(held);
    let healedByWait = false;
    if (dead) {
      await sleep(35000);
      let next = await measureFrame();
      const deadline = performance.now() + 90_000;
      for (;;) {
        await sleep(4000);
        const again = await measureFrame();
        const done = converged(next, again);
        next = again;
        if (done || performance.now() > deadline) break;
      }
      if (!isDead(next)) { held = next; dead = false; healedByWait = true; }
    }

    // ── THE WALK: waypoint lerp at play speed, frame recorder armed ───────
    const frames = [];
    let ftOn = true;
    {
      let last = performance.now();
      const tick = (t) => {
        frames.push(t - last);
        last = t;
        if (ftOn) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    const eye = 1.6;
    for (let lap = 0; lap < walkLaps; lap++) {
      for (let w = 0; w < walk.length; w++) {
        const from = new THREE.Vector3(...walk[w]);
        const to = new THREE.Vector3(...walk[(w + 1) % walk.length]);
        const dist = from.distanceTo(to);
        const dur = (dist / walkSpeed) * 1000;
        const t0 = performance.now();
        for (;;) {
          const f = Math.min(1, (performance.now() - t0) / dur);
          const p = from.clone().lerp(to, f);
          // Look where you walk: the target is the waypoint ahead at eye height.
          setPose([p.x, eye, p.z], [to.x, eye, to.z]);   // fire-and-forget
          if (f >= 1) break;
          await new Promise((r) => requestAnimationFrame(r));
        }
      }
    }
    ftOn = false;
    // Recovery, LIKE FOR LIKE (run 1 compared the walk's end pose against the
    // held pose — different views, meaningless percentages): return to the
    // HELD pose first, then sample immediately and at +3 s. The dip between
    // the two is the post-movement transient at the same crops.
    await setPose([pose[0], pose[1], pose[2]], [pose[3], pose[4], pose[5]]);
    await sleep(300);
    const atStop = await measureFrame();
    await sleep(3000);
    const after3s = await measureFrame();

    const sorted = [...frames].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    const median = q(0.5) || 1;
    const walkStats = {
      frames: frames.length,
      median: +median.toFixed(1),
      p95: +q(0.95).toFixed(1),
      max: +(sorted.at(-1) ?? 0).toFixed(0),
      spikes: frames.filter((d) => d > 2 * median).length,
      freezes50: frames.filter((d) => d > 50).length,
      freezes120: frames.filter((d) => d > 120).length,
    };
    const rec = held.map((r, i) => ({
      region: r.region,
      held: r.mean,
      atStop: atStop[i]?.mean ?? -1,
      after3s: after3s[i]?.mean ?? -1,
    }));
    return { regions: held, walkStats, recovery: rec, dead, healedByWait };
  }, { grid: GRID, settle: SETTLE, pose: POSE, walk: WALK, walkSpeed: WALK_SPEED, walkLaps: WALK_LAPS });

  if (wantPng && !result.fail) {
    const shot = await page.screenshot({ encoding: "base64" });
    writeFileSync(`${OUT}/frame-${arm}.png`, Buffer.from(shot, "base64"));
  }
  const slidesTotal = slideCount;
  await page.close();
  await browser.close();
  return { arm, pageErrors, watchdogLines, bootLines, slides: slidesTotal, walkSlides: slidesTotal - slidesBeforeWalk(), ...result };
}

const sceneHash = () => {
  try { return createHash("sha1").update(readFileSync(SCENE)).digest("hex").slice(0, 12); }
  catch { return "unreadable"; }
};
const hashAtStart = sceneHash();
console.log(`snapshot: ${PROJECT} (scene ${hashAtStart}) — quality ${QUALITY}, walk ${WALK_LAPS} laps @ ${WALK_SPEED} m/s`);

const all = [];
let anyFail = false;
for (const arm of ARMS) {
  const h = sceneHash();
  if (h !== hashAtStart) console.log(`\n⚠⚠ SNAPSHOT CHANGED (${hashAtStart} → ${h}) — should be impossible; investigate.`);
  console.log(`\n── ARM=${arm}`);
  const r = await runArm(arm);
  all.push(r);
  if (r.fail) { console.log(`  FAIL: ${r.fail}`); anyFail = true; continue; }
  if (r.dead) console.log("  ⚠⚠ DEAD FIELD at measurement (heal window expired) — quality stats NOT comparable");
  else if (r.healedByWait) console.log("  ✚ dead at first convergence, healed within the wait window");
  for (const l of r.bootLines.slice(0, 4)) console.log(`  ${l}`);
  for (const l of r.watchdogLines) console.log(`  ⚠ ${l}`);
  const w = r.walkStats;
  console.log(`  WALK: median ${w.median}ms  p95 ${w.p95}ms  max ${w.max}ms  spikes>2x ${w.spikes}/${w.frames}  >50ms ${w.freezes50}  >120ms ${w.freezes120}  slides ${r.slides}`);
  for (const g of r.regions) {
    console.log(`  ${g.region.padEnd(26)} mean ${String(g.mean).padStart(8)}  step2 ${g.step2}  step8 ${g.step8}  blockIndex ${g.blockIndex}`);
  }
  for (const rec of r.recovery) {
    const dip = rec.held > 1e-5 ? ((rec.atStop - rec.held) / rec.held * 100).toFixed(0) : "n/a";
    console.log(`  recover ${rec.region.padEnd(24)} held ${rec.held}  atStop ${rec.atStop} (${dip}%)  +3s ${rec.after3s}`);
  }
  if (r.pageErrors) anyFail = true;
}
writeFileSync(`${OUT}/result.json`, JSON.stringify({ quality: QUALITY, pose: POSE, arms: all }, null, 2));
console.log(`\n${anyFail ? "PROBE COMPLETED WITH FAILURES" : "PROBE COMPLETE"} — result.json + PNGs in ${OUT}`);
process.exit(anyFail ? 1 : 0);
