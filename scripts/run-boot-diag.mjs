/**
 * Boot diagnostic: WHO destroys the GPU device, WHERE the unattributed
 * TypeErrors come from, and WHAT GI init actually spends its time on.
 *
 *   node scripts/run-boot-diag.mjs [url]
 *
 * This is an instrument, not a gate. It exists because three of the user's
 * reports are invisible to every existing harness:
 *
 * 1. `[gpu] DEVICE LOST (destroyed): Device was destroyed.` on EVERY editor and
 *    game start. `reason: "destroyed"` is not a driver loss — something called
 *    `device.destroy()` (or `renderer.dispose()`, which destroys the device).
 *    Engine.js's own `device.lost` handler prints the symptom from inside a
 *    promise callback, so the console line carries NO stack and the caller is
 *    unattributable. This harness patches `GPUDevice.prototype.destroy` and
 *    `GPUAdapter.prototype.requestDevice` BEFORE any app code runs and records
 *    `new Error().stack` at each call, which names the caller directly.
 *
 * 2. `TypeError: Cannot read properties of undefined (reading 'M_ID')`, which
 *    appears nowhere in src/ or node_modules — so it is a COMPUTED property
 *    access (`undefinedThing[name]`) whose key comes from data, most likely an
 *    asset/material name (`M_` is the Unreal/Fab material prefix). The editor's
 *    console capture pushes only `e.message` for window errors, so the user
 *    never sees the frame that threw. Here every pageerror is printed with its
 *    full stack.
 *
 * 3. "GI initialization is super slow". Console lines are timestamped relative
 *    to page load so the gap between stages is readable, and the long-task
 *    observer reports every main-thread block over 50 ms with its duration —
 *    a CPU-blocking voxelize/probe-placement loop shows up here as a single
 *    multi-hundred-millisecond task, while slow GPU pipeline creation does not.
 *
 * Needs a FRESH `npx vite --port 5201 --strictPort` (a stale server makes the
 * harness's `import("/src/...")` a second copy of the app with its own Engine).
 */
import puppeteer from "puppeteer-core";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installTauriShim } from "./lib/tauriShim.mjs";
import { makeAoGlossyProject } from "./lib/makeAoGlossyProject.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
// MODE=skip   boot with no project (the "Skip the project" path)
// MODE=project  open a real project whose scene carries its own settings — the
//               user's actual flow, and the only one that can show the
//               boot-time renderer REBUILD (scene settings arrive after the
//               renderer was already built from the defaults).
const MODE = process.env.MODE ?? "skip";
// The scene's renderer block. "default" matches SCENE_SETTINGS_DEFAULTS exactly;
// "noaa" is the Level scene's `antialias: false`, which differs from the
// defaults and must therefore force exactly one rebuild.
const SCENE_RENDERER = process.env.SCENE_RENDERER ?? "default";
const T0 = Date.now();
const stamp = () => `${((Date.now() - T0) / 1000).toFixed(2)}s`;

let projectRoot = null;
if (process.env.PROJECT) {
  // A REAL project, opened read-only (the Tauri shim refuses every write
  // outside its scratch root, so an autosave cannot touch it). The synthetic
  // fixture is a 9-mesh room and cannot reproduce what a 200-entity scene with
  // thirteen lights and three reflection probes spends its startup on.
  projectRoot = resolve(process.env.PROJECT).replaceAll("\\", "/");
  console.log(`mode=project root=${projectRoot} (existing project, read-only)`);
} else if (MODE === "project") {
  projectRoot = resolve("scripts/.boot-diag").replaceAll("\\", "/");
  await makeAoGlossyProject(projectRoot, { quality: process.env.QUALITY ?? "high" });
  if (SCENE_RENDERER !== "default") {
    const file = join(projectRoot, "scenes", "Main.scene");
    const scene = JSON.parse(readFileSync(file, "utf8"));
    scene.settings.renderer = { antialias: false, samples: 4, transparent: false };
    writeFileSync(file, JSON.stringify(scene, null, 1));
  }
  console.log(`mode=project root=${projectRoot} scene.renderer=${SCENE_RENDERER}`);
} else {
  console.log(`mode=skip (no project)`);
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  // A shared default profile is locked by any Chrome the user already has open,
  // which fails as `Code: 0` with an empty stderr (see AGENTS.md).
  userDataDir: mkdtempSync(join(tmpdir(), "boot-diag-")),
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 });

const pageErrors = [];
page.on("pageerror", (error) => {
  pageErrors.push(error.stack ?? error.message);
  console.log(`\n[${stamp()}] PAGEERROR ${error.message}\n${(error.stack ?? "").split("\n").slice(1, 12).join("\n")}`);
});
page.on("console", (message) => {
  const text = message.text();
  if (/^\s*$/.test(text)) return;
  console.log(`[${stamp()}] ${text.slice(0, 900)}`);
});

// Instrument the WebGPU entry points before a single line of app code runs.
await page.evaluateOnNewDocument(() => {
  globalThis.__gpuEvents = [];
  const record = (kind) => {
    const stack = new Error().stack ?? "";
    globalThis.__gpuEvents.push({ kind, t: performance.now(), stack });
    console.log(`__GPU__ ${kind} @${performance.now().toFixed(0)}ms\n${stack.split("\n").slice(2, 14).join("\n")}`);
  };
  const patch = () => {
    if (typeof GPUDevice !== "undefined" && !GPUDevice.prototype.__patched) {
      GPUDevice.prototype.__patched = true;
      const destroy = GPUDevice.prototype.destroy;
      GPUDevice.prototype.destroy = function (...a) {
        record("device.destroy");
        return destroy.apply(this, a);
      };
    }
    if (typeof GPUAdapter !== "undefined" && !GPUAdapter.prototype.__patched) {
      GPUAdapter.prototype.__patched = true;
      const requestDevice = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = function (...a) {
        record("requestDevice");
        return requestDevice.apply(this, a);
      };
    }
    if (navigator.gpu && !navigator.gpu.__patched) {
      navigator.gpu.__patched = true;
      const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = (...a) => {
        record("requestAdapter");
        return requestAdapter(...a);
      };
    }
  };
  patch();

  // Every main-thread block over 50 ms, so a CPU-bound GI stage is
  // distinguishable from slow GPU pipeline creation.
  globalThis.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        globalThis.__longTasks.push({ start: entry.startTime, duration: entry.duration });
        if (entry.duration > 120) console.log(`__LONGTASK__ ${entry.duration.toFixed(0)}ms at ${entry.startTime.toFixed(0)}ms`);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* no longtask support */ }
});

if (projectRoot) {
  await installTauriShim(page, {});
  // FLAGS={"__giLogComposite":true} — the `__gi*` diagnostic hatches, set
  // before any module loads so a build-time one still takes.
  const flags = process.env.FLAGS ? JSON.parse(process.env.FLAGS) : null;
  await page.evaluateOnNewDocument((project, extra) => {
    localStorage.clear();
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
    globalThis.__editorKeepRendering = true;
    if (extra) for (const [k, v] of Object.entries(extra)) globalThis[k] = v;
  }, projectRoot, flags);
}

// PROFILE=1: a real CPU profile over the whole boot, aggregated by function.
// The long-task observer says WHEN the main thread blocked; only a profile says
// WHICH function spent the time, and every attempt to infer it from the phase
// logs has been wrong (GI's own `setup 69ms` covers ~3% of a 2s block).
const cdp = process.env.PROFILE === "1" ? await page.createCDPSession() : null;
if (cdp) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
}
// The profile's own clock is not `performance.now()`, so samples cannot be
// matched to a long-task window without a baseline. Aggregating over the WHOLE
// boot instead is what made the first read of this profile useless: the top
// entries were per-frame render submissions spread over 20 s, which say nothing
// about the one 2.8 s task that actually freezes the editor.
const profileBase = cdp
  ? await page.evaluate(() => performance.now()).catch(() => 0)
  : 0;

console.log(`[${stamp()}] goto ${url}`);
await page.goto(url, { waitUntil: "load", timeout: 60_000 });
if (projectRoot) {
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 30_000 });
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, projectRoot);
} else {
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
}
await new Promise((r) => setTimeout(r, 5000));

console.log(`\n===== after boot (no GI yet) =====`);
const bootEvents = await page.evaluate(() => globalThis.__gpuEvents.map((e) => ({ kind: e.kind, t: e.t, stack: e.stack })));
for (const e of bootEvents) {
  console.log(`  ${e.kind} @${e.t.toFixed(0)}ms`);
  console.log(e.stack.split("\n").slice(1, 10).map((l) => `      ${l.trim()}`).join("\n"));
}

// ── Now time the GI init stages. A project scene brings its own GI component
// and its own settings, so it is left alone; the skip-project arm builds a
// scene by hand.
console.log(`\n===== GI init =====`);
if (projectRoot) {
  await page.evaluate(() => {
    globalThis.__giStart = performance.now();
    globalThis.__editorApi?.viewport?.freezeWhenUnfocused?.(false);
  });
} else await page.evaluate(async () => {
  const { THREE } = await import("/src/engine/index.js");
  await import("/src/modules/index.js");
  const { enableEngineModule } = await import("/src/engine/modules.js");
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  await enableEngineModule(engine, "gi");
  globalThis.__engine = engine;
  globalThis.__editorApi.viewport.freezeWhenUnfocused(false);

  const material = (color) => new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(12, 0.3, 12), material(0xcccccc));
  floor.position.set(0, -0.15, 0);
  engine.scene.add(floor);
  const back = new THREE.Mesh(new THREE.BoxGeometry(12, 5, 0.3), material(0x999999));
  back.position.set(0, 2.5, -6);
  engine.scene.add(back);
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3, 0.5), material(0xb0b0b0));
  pillar.position.set(1.5, 1.5, 0);
  engine.scene.add(pillar);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 16), material(0xffffff));
  lamp.material.emissive = new THREE.Color(0xffffff);
  lamp.material.emissiveIntensity = 30;
  lamp.position.set(-1, 3.4, 2);
  engine.scene.add(lamp);

  globalThis.__giStart = performance.now();
  const giEntity = engine.createEntity({ name: "GI" });
  globalThis.__gi = giEntity.addComponent("global-illumination", {
    autoFit: true, quality: "high", intensity: 1,
  });
  console.log(`__GI__ addComponent returned after ${(performance.now() - globalThis.__giStart).toFixed(0)}ms`);
});
if (!projectRoot) {
  await page.evaluate(() => globalThis.__editorApi.viewport.setCamera([0, 1.6, 4.5], [0, 1.2, -2]));
}
const SETTLE = Number(process.env.SETTLE ?? (projectRoot && process.env.PROJECT ? 90_000 : 20_000));
await new Promise((r) => setTimeout(r, SETTLE));

// REBUILD=1: force a renderer rebuild AFTER GI is live, which replaces the
// device and invalidates every pipeline, bind group and storage buffer GI owns.
// GISystem now subscribes to `renderer-rebuilt` and re-mints; before that it
// held stale handles that fail silently, so the check is "does GI build again,
// with no page errors".
if (process.env.REBUILD === "1") {
  console.log(`\n===== forcing a renderer rebuild (device swap) =====`);
  const errorsBefore = pageErrors.length;
  await page.evaluate(async () => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    globalThis.__rebuiltAt = performance.now();
    await engine.applySettings({ renderer: { antialias: false, samples: 4, transparent: false } });
  });
  await new Promise((r) => setTimeout(r, 25_000));
  const after = await page.evaluate(async () => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const system = engine.modules?.get?.("gi")?.system;
    return {
      rendererReady: engine.rendererReady,
      hasState: !!system?.state,
      fieldReady: !!system?._fieldReadyOnce,
    };
  });
  console.log(`  after rebuild: ${JSON.stringify(after)} newPageErrors=${pageErrors.length - errorsBefore}`);
}

// WHICH PLACEMENT MOVES EVERY FRAME. `state.atlas.revision` is the ONLY thing
// that turns a mesh transform into a re-voxelize, and a scene where it bumps
// every frame re-runs the whole occupancy chain forever — `__giLogComposite`
// reports it as `composites 120 (atlas 120, ...)`. That says the atlas did it
// but not WHO, and "who" is a single mesh whose matrixWorld is being rewritten.
{
  const movers = await page.evaluate(async () => {
    const { ensureEngine } = await import("/src/editor/engineInstance.js");
    const engine = await ensureEngine();
    const atlas = engine.modules?.get?.("gi")?.system?.state?.atlas;
    if (!atlas) return { error: "no atlas" };
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const snap = () => atlas.assignments.map((a) => (a?.mesh ? Array.from(a.mesh.matrixWorld.elements) : null));
    const before = snap();
    const rev0 = atlas.revision;
    await frame();
    const after = snap();
    await frame();
    const rev1 = atlas.revision;
    const moved = [];
    for (let i = 0; i < before.length; i++) {
      if (!before[i] || !after[i]) continue;
      let delta = 0;
      for (let k = 0; k < 16; k++) delta = Math.max(delta, Math.abs(before[i][k] - after[i][k]));
      if (delta > 1e-7) {
        const mesh = atlas.assignments[i].mesh;
        const chain = [];
        for (let o = mesh; o && chain.length < 5; o = o.parent) chain.push(o.name || o.type);
        moved.push({ slot: i, delta, name: mesh.name || "(unnamed)", type: mesh.type, chain: chain.join(" < ") });
      }
    }
    // Nothing moved but the revision still climbs => it is being RE-SEATED.
    // Wrap the three methods that bump it and keep one stack each.
    const calls = {};
    const stacks = {};
    for (const name of ["clearSlot", "setAnalyticSlot", "refreshAllSlots", "allocateSlot"]) {
      const original = atlas[name];
      if (typeof original !== "function") continue;
      calls[name] = 0;
      atlas[name] = function (...args) {
        calls[name]++;
        if (!stacks[name]) stacks[name] = (new Error().stack ?? "").split("\n").slice(1, 8).join("\n");
        return original.apply(this, args);
      };
    }
    // NON-FINITE TRANSFORMS. `#matrixChanged` returns true whenever the CACHE
    // holds a NaN — and if the live matrix is NaN too, the refresh writes the
    // NaN straight back, so that slot reports "moved" on every frame forever.
    // A plain delta check cannot see it: Math.abs(NaN - NaN) > 1e-7 is false.
    const bad = [];
    atlas.assignments.forEach((a, i) => {
      if (!a) return;
      const live = [...(a.mesh?.matrixWorld?.elements ?? [])];
      const cached = [...(a.matrixCache ?? [])];
      const liveBad = live.some((v) => !Number.isFinite(v));
      const cacheBad = cached.some((v) => !Number.isFinite(v));
      if (liveBad || cacheBad) {
        const chain = [];
        for (let o = a.mesh; o && chain.length < 5; o = o.parent) chain.push(o.name || o.type);
        bad.push({
          slot: i, liveBad, cacheBad, name: a.mesh?.name || "(unnamed)", type: a.mesh?.type,
          chain: chain.join(" < "),
          scale: [...(a.mesh?.scale ?? { x: 0, y: 0, z: 0 })].length ? null : `${a.mesh.scale.x},${a.mesh.scale.y},${a.mesh.scale.z}`,
          instanced: !!a.mesh?.isInstancedMesh,
          instanceId: a.instanceId ?? null,
        });
      }
    });
    const revStart = atlas.revision;
    let frames = 0;
    while (frames < 30) { await frame(); frames++; }
    const revEnd = atlas.revision;
    for (const name of Object.keys(calls)) delete atlas[name]; // restore the prototype method

    return {
      seated: before.filter(Boolean).length,
      revPerFrame: rev1 - rev0,
      moved: moved.slice(0, 10),
      movedTotal: moved.length,
      nonFinite: bad,
      over30Frames: { frames, revisionDelta: revEnd - revStart, calls, stacks },
    };
  });
  console.log(`\n===== who bumps the atlas =====`);
  console.log(`  seated placements: ${movers.seated}, revision bumps over ~2 frames: ${movers.revPerFrame}`);
  console.log(`  placements whose matrixWorld changed in one frame: ${movers.movedTotal}`);
  for (const m of movers.moved ?? []) {
    console.log(`    slot ${m.slot} Δ=${m.delta.toExponential(2)} "${m.name}" (${m.type})  ${m.chain}`);
  }
  console.log(`  placements with a NON-FINITE transform: ${movers.nonFinite?.length ?? 0}`);
  for (const b of movers.nonFinite ?? []) {
    console.log(`    slot ${b.slot} live=${b.liveBad} cache=${b.cacheBad} "${b.name}" (${b.type}${b.instanced ? ` inst#${b.instanceId}` : ""})  ${b.chain}`);
  }
  const w = movers.over30Frames;
  if (w) {
    console.log(`  over ${w.frames} frames: revision +${w.revisionDelta}, calls ${JSON.stringify(w.calls)}`);
    for (const [name, stack] of Object.entries(w.stacks ?? {})) {
      console.log(`    ${name} called from:\n${stack.split("\n").map((l) => `        ${l.trim()}`).join("\n")}`);
    }
  }
}

const summary = await page.evaluate(() => {
  const tasks = globalThis.__longTasks ?? [];
  const giStart = globalThis.__giStart ?? 0;
  const after = tasks.filter((t) => t.start >= giStart);
  const sum = (a) => a.reduce((s, t) => s + t.duration, 0);
  return {
    gpuEvents: globalThis.__gpuEvents.map((e) => ({ kind: e.kind, t: e.t, stack: e.stack })),
    giStart,
    longTaskCount: tasks.length,
    longTaskTotalMs: sum(tasks),
    afterGiCount: after.length,
    afterGiTotalMs: sum(after),
    worst: [...tasks].sort((a, b) => b.duration - a.duration).slice(0, 12)
      .map((t) => ({ start: Math.round(t.start), duration: Math.round(t.duration) })),
  };
});

console.log(`\n===== SUMMARY =====`);
console.log(`GPU lifecycle events (${summary.gpuEvents.length}):`);
for (const e of summary.gpuEvents) {
  console.log(`  ${e.kind} @${e.t.toFixed(0)}ms`);
  console.log(e.stack.split("\n").slice(1, 12).map((l) => `      ${l.trim()}`).join("\n"));
}
console.log(`\nMain-thread long tasks: ${summary.longTaskCount} totalling ${summary.longTaskTotalMs.toFixed(0)}ms`);
console.log(`  after GI attach (t=${summary.giStart.toFixed(0)}ms): ${summary.afterGiCount} tasks, ${summary.afterGiTotalMs.toFixed(0)}ms blocked`);
console.log(`  worst: ${JSON.stringify(summary.worst)}`);
console.log(`\nPage errors: ${pageErrors.length}`);
for (const e of pageErrors.slice(0, 6)) console.log(`  ${e.split("\n").slice(0, 6).join("\n  ")}`);

if (cdp) {
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  // Ancestor chain, so a sample inside a three.js leaf is still attributable to
  // the engine function that called it — the leaf alone ("submit", "(program)")
  // never says which subsystem asked for the work.
  const parentOf = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
  const label = (id) => {
    const f = byId.get(id)?.callFrame;
    if (!f) return null;
    const file = (f.url ?? "").replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    return { name: f.functionName || "(anonymous)", where: file ? `${file}:${(f.lineNumber ?? 0) + 1}` : "" };
  };
  /** The nearest ancestor that is OUR code, for blame that names a subsystem. */
  const ourFrame = (id) => {
    for (let cur = id; cur != null; cur = parentOf.get(cur)) {
      const f = byId.get(cur)?.callFrame;
      if (f && /\/src\//.test(f.url ?? "")) return label(cur);
    }
    return null;
  };

  // Sample i's timestamp = startTime + sum(timeDeltas[0..i]), mapped onto the
  // page's performance.now() via the baseline taken at Profiler.start.
  let cursor = profile.startTime;
  const samples = profile.samples.map((id, i) => {
    cursor += profile.timeDeltas[i] ?? 0;
    return { id, at: profileBase + (cursor - profile.startTime) / 1000, ms: (profile.timeDeltas[i] ?? 0) / 1000 };
  });

  const worst = (await page.evaluate(() => globalThis.__longTasks ?? []).catch(() => []))
    .sort((a, b) => b.duration - a.duration)[0];
  const windows = [{ name: "whole boot", from: -Infinity, to: Infinity }];
  if (worst) {
    windows.unshift({
      name: `worst long task (${worst.duration.toFixed(0)}ms at ${worst.start.toFixed(0)}ms)`,
      from: worst.start,
      to: worst.start + worst.duration,
    });
  }
  for (const win of windows) {
    const leaf = new Map();
    const blame = new Map();
    let total = 0;
    for (const s of samples) {
      if (s.at < win.from || s.at > win.to) continue;
      total += s.ms;
      const l = label(s.id);
      if (l) {
        const k = `${l.name}\u0000${l.where}`;
        leaf.set(k, (leaf.get(k) ?? 0) + s.ms);
      }
      const b = ourFrame(s.id);
      if (b) {
        const k = `${b.name}\u0000${b.where}`;
        blame.set(k, (blame.get(k) ?? 0) + s.ms);
      }
    }
    const top = (map, n) => [...map.entries()]
      .map(([k, ms]) => ({ ms, name: k.split("\u0000")[0], where: k.split("\u0000")[1] }))
      .sort((a, b) => b.ms - a.ms).slice(0, n);
    console.log(`\n===== CPU PROFILE — ${win.name} (${total.toFixed(0)}ms sampled) =====`);
    console.log("  by leaf (where the time is spent):");
    for (const r of top(leaf, 12)) console.log(`  ${r.ms.toFixed(0).padStart(6)}ms  ${r.name.slice(0, 40).padEnd(40)} ${r.where}`);
    console.log("  by nearest src/ caller (who asked for it):");
    for (const r of top(blame, 12)) console.log(`  ${r.ms.toFixed(0).padStart(6)}ms  ${r.name.slice(0, 40).padEnd(40)} ${r.where}`);
  }
}

await browser.close();
process.exit(0);
