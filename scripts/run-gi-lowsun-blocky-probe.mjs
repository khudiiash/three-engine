// LOW-SUN BLOCKINESS PROBE (2026-08-22, §15 U2).
//
// THE REPORT: "at lower sun intensity, getting blocky artifacts, a lot"
// (the user's Level, ultra). When the sun fades, the indirect terms dominate
// the frame, and whichever channel quantizes space — the half-res shadow
// upsample, the emitter-shadow pass, the probe lattice, AO — becomes the
// picture. The §15 rule: NAME THE CHANNEL BEFORE TOUCHING IT.
//
// THE INSTRUMENT: hold one pose on the user's own scene (read-only boot),
// find the largest FLAT regions by CPU raycast, and measure MULTI-SCALE
// STEP ENERGY of the rendered luminance inside each region:
//
//     step(k) = mean |lum(p + k px) − lum(p)| / mean lum     k ∈ {2, 8, 16}
//
// A smooth gradient has step8 ≈ 4×step2; BLOCKS have large step8/step16
// with small step2 (flat plateaus, sharp seams). The headline per region is
// `blockIndex = step8 / max(step2, 1e-4)` — > ~6 means plateau-and-seam
// structure, not noise and not a ramp.
//
// ONE BOOT PER ARM — learned the hard way (runs 3–4): `__giShadowScale` /
// `__giEmitterShadowScale` are read at pass-BUILD time, and forcing a
// rebuild by resizing the drawing buffer trips the unfocused-page trap (the
// occupancy chain never re-arms headless → permanently washed frames that
// read as a 3× brightness jump). Only the SUN itself is scaled live (that
// one is verified: 10× authored drop = 10× measured mean). Arms:
//   base       the scene as authored
//   lowsun     directional lights × SUN (default 0.1) — the repro
//   shadow1    lowsun + __giShadowScale=1        (sun gi-shadow FULL RES)
//   emsh1      lowsun + __giEmitterShadowScale=1 (emitter pass full res)
//   aooff      lowsun + __giConfigOverride={ao:false}
//   srcoff     lowsun + __giSrcProbes=false      (field off — do the blocks
//              live in the indirect field or in a direct channel?)
// If full-res arms shrink step8/step16 while base holds, the upsample is
// convicted; if srcoff deletes the blocks, they live in the field/gather.
//
// This is a PROBE, not a gate: numbers + PNGs, fails only on boot errors.
//
//   node scripts/run-gi-lowsun-blocky-probe.mjs [url]
// Env:
//   PROJECT=C:/Users/Khudiiash/Documents/GAME   read-only via the tauri shim
//   SCENE=scenes/Level.scene   scene under test (project-relative)
//   POSE=px,py,pz,tx,ty,tz     aim at the blocky surface
//   SUN=0.1  ARMS=base,lowsun,shadow1,emsh1,aooff,srcoff
//   SETTLE=9000  GRID=64  PNG=1
import puppeteer from "puppeteer-core";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = `${PROJECT}/${process.env.SCENE ?? "scenes/Level.scene"}`;
// Default pose (from Level.scene geometry, 2026-08-22): inside the west
// room — the sofa room of the user's blocky screenshots (x ∈ [−12,−4],
// z ∈ [−8,8], ceiling ~3.85) — looking north-and-up so the crop set holds
// CEILING + upper WALL + floor, the surfaces the blocks were reported on.
// ⚠ The old flat-walls pose predates the Level rebuild and now stares at
// featureless exterior ground (runs 3–6 measured exactly that).
const POSE = (process.env.POSE ?? "-8,1.6,5.5,-8,3.6,-3").split(",").map(Number);
const SUN = Number(process.env.SUN ?? 0.1);
const SETTLE = Number(process.env.SETTLE ?? 9000);
const GRID = Number(process.env.GRID ?? 64);
const ARMS = (process.env.ARMS ?? "base,lowsun,shadow1,emsh1,aooff,srcoff")
  .split(",").map((s) => s.trim()).filter(Boolean);
const wantPng = process.env.PNG === "1";
const OUT = ".gi-shots/lowsun-blocky";
mkdirSync(OUT, { recursive: true });

// Quality is PINNED per arm through the sanctioned override (the user sees
// ultra; the scene's authored tier booted `high` in runs 3–6) — and the
// aooff arm folds `ao:false` into the SAME override object rather than a
// second one.
const QUALITY = process.env.QUALITY ?? "ultra";
const armGlobals = (arm) => {
  const cfg = { quality: QUALITY };
  if (arm === "aooff") cfg.ao = false;
  return {
    __giConfigOverride: cfg,
    ...(arm === "shadow1" ? { __giShadowScale: 1 } : {}),
    ...(arm === "emsh1" ? { __giEmitterShadowScale: 1 } : {}),
    ...(arm === "srcoff" ? { __giSrcProbes: false } : {}),
    // The §12.70 tile cut keeps the top-4 emitters PER 8×8 TILE — a tile
    // grid whose screen period matches the observed block scale. `nocut`
    // pays every emitter everywhere (slow, diagnosis only).
    ...(arm === "nocut" ? { __giEmitterTileCut: false, __giSrcLightTree: false } : {}),
  };
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  protocolTimeout: 900_000,
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});

async function runArm(arm) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  let pageErrors = 0;
  const watchdogLines = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/§12\.56 AUTO-RETRY|DEAD FIELD|DEAD SHADING/.test(t)) watchdogLines.push(t.slice(0, 200));
  });
  page.on("pageerror", (e) => {
    const msg = String(e.message ?? e);
    if (!/save_scene/.test(msg)) { pageErrors++; console.log(`  pageerror: ${msg.slice(0, 200)}`); }
  });
  await installTauriShim(page, {});   // no writableRoot — read-only by construction
  await page.evaluateOnNewDocument((project, globals) => {
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

  const result = await page.evaluate(async ({ grid, sunMul, settle, lowsun, pose }) => {
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

    // VERIFIED pose (run 5: a one-shot setCamera was stomped by the scene's
    // own async editor-camera restore — both arms measured the restore's
    // view, not the requested one). Re-issue until the live camera actually
    // holds the pose.
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

    // Linear light — blockiness is a ratio metric and AgX would reshape it.
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;

    // The sun, scaled LIVE (verified: 10× authored drop = 10× measured
    // mean). Both the THREE light and the component prop, so raster and GI
    // agree whichever the slot sync reads.
    if (lowsun) {
      scene.traverse((o) => {
        if (!o.isDirectionalLight) return;
        o.intensity *= sunMul;
        const comp = o.userData?.component ?? o.userData?.entity?.getComponent?.("light");
        if (comp?.props && comp.props.intensity != null) comp.props.intensity *= sunMul;
      });
    }
    await sleep(settle);

    // ── FLAT REGIONS BY CPU RAYCAST ────────────────────────────────────────
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
      .slice(0, 5);
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
    const isDead = (rs) => rs.some((r) => r.region.endsWith("|ceiling") && r.mean < 0.001);
    const snapStats = async () => {
      try {
        const sys = engine.modules.get("gi").system;
        const src = sys.state?.screen?.srcProbes;
        if (!src?.readStats) return null;
        const s = await src.readStats(renderer);
        return {
          rays: s.rays, secondary: s.secondary, tiles: s.tiles, merge: s.merge, totalRays: s.totalRays,
          seed: s.seed,
          cascades: (s.cascades ?? []).map((c) => (c && typeof c === "object"
            ? Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === "number"))
            : c)),
        };
      } catch (e) { return { err: String(e).slice(0, 200) }; }
    };
    // CONVERGENCE POLL, never a fixed settle (the late-08-22 confound: under
    // GPU contention a fixed settle reads tiles MID-CONVERGENCE and calls a
    // slow boot dead). Converged = two consecutive reads whose per-region
    // means all agree within 3% (or the floor of measurement at 1e-4).
    const converged = (a, b) => a.every((r, i) =>
      Math.abs(r.mean - b[i].mean) <= Math.max(0.03 * Math.max(r.mean, b[i].mean), 1e-4));
    let out = await measureFrame();
    {
      const deadline = performance.now() + 120_000;
      for (;;) {
        await sleep(4000);
        const next = await measureFrame();
        const done = converged(out, next);
        out = next;
        if (done || performance.now() > deadline) break;
      }
    }
    // §12.56 AUTO-RETRY validation: a genuinely dead boot converges to BLACK
    // ceilings, then the watchdog re-mints. SNAPSHOT the dead state's stats
    // BEFORE the heal window; a "healed" without a captured watchdog line is
    // natural convergence the poll failed to wait out — report it as such.
    let healed = false;
    let deadStats = null;
    if (isDead(out)) {
      deadStats = await snapStats();
      await sleep(35000);
      const again = await measureFrame();
      if (!isDead(again)) { out = again; healed = true; }
    }
    // Pass-stats dump (§12.56 family): dead-merge root cause needs the
    // UPSTREAM counters — meanCorners is identical in dead and healthy
    // boots, so corner+merge run and the orphans' parents are missing
    // upstream (seed / per-cascade population).
    const stats = await snapStats();
    return { regions: out, stats, deadStats, dead: isDead(out), healed };
  }, { grid: GRID, sunMul: SUN, settle: SETTLE, lowsun: arm !== "base", pose: POSE });

  if (wantPng && !result.fail) {
    const shot = await page.screenshot({ encoding: "base64" });
    writeFileSync(`${OUT}/frame-${arm}.png`, Buffer.from(shot, "base64"));
  }
  await page.close();
  return { arm, pageErrors, watchdogLines, ...result };
}

// LIVE-EDIT CONTAMINATION DETECTOR (late-08-22 confound: the user edited the
// Level while a run read its autosaves — cross-arm comparison died silently).
// Hash the scene file at start and before every arm; a change marks the run.
const sceneHash = () => {
  try { return createHash("sha1").update(readFileSync(SCENE)).digest("hex").slice(0, 12); }
  catch { return "unreadable"; }
};
const hashAtStart = sceneHash();

let anyFail = false;
for (const arm of ARMS) {
  const h = sceneHash();
  if (h !== hashAtStart) {
    console.log(`\n⚠⚠ SCENE CHANGED ON DISK before ARM=${arm} (${hashAtStart} → ${h}) — the user is` +
      ` editing; this arm and everything after are NOT comparable to earlier arms.`);
  }
  const r = await runArm(arm);
  console.log(`\nARM=${r.arm}${r.pageErrors ? `  pageerrors=${r.pageErrors}` : ""}` +
    `${r.dead ? "  ⚠ DEAD-EMITTER BOOT (retry did NOT heal)" : ""}${r.healed ? "  ✚ dead boot HEALED by §12.56 auto-retry" : ""}`);
  if (r.fail) { console.log(`  FAIL: ${r.fail}`); anyFail = true; continue; }
  for (const l of r.watchdogLines ?? []) console.log(`  ${l}`);
  if (r.deadStats) console.log(`  DEAD-STATE stats ${JSON.stringify(r.deadStats)}`);
  if (r.stats) console.log(`  stats ${JSON.stringify(r.stats)}`);
  for (const g of r.regions) {
    console.log(`  ${g.region.padEnd(28)} n=${String(g.n).padStart(4)}  mean ${String(g.mean).padStart(8)}  ` +
      `step2 ${g.step2}  step8 ${g.step8}  step16 ${g.step16}  blockIndex ${g.blockIndex}`);
  }
  if (r.pageErrors) anyFail = true;
}
await browser.close();
process.exit(anyFail ? 1 : 0);
