// GI2 BOOT PROBE — §19 Stage 3.4's gate (audits §M.4)
//
// WHAT IT ANSWERS, AND WHY IT IS A SEPARATE SCRIPT
//
// `run-gi-boot-probe.mjs` is a REPORTER for the SRC boot: it anchors on
// `[gi] field first pass dispatched` and prints a compile-latency table. GI2
// has no field, dispatches no SRC kernel, and its two boot facts are different
// quantities entirely — when each WINDOW LEVEL first held occupancy, and when
// the first ray came back from it with radiance. So this is a gate, not a
// reporter: it prints a PASS/FAIL row per budget and exits non-zero.
//
// THE FOUR GATES (§M.4)
//   1. first light ≤ 3 s after `scene assets ready` — on the Level AND on
//      Bistro. This is the number the whole stage exists to move: Stage 0
//      measured Bistro's first light at 37-40 s.
//   2. GI GPU ≤ 4 ms. Measured with `profile.giPasses`, which suspends the
//      render loop and times each dispatch K times — the only per-kernel GPU
//      number in the engine that is not a guess.
//   3. heap ≤ 1.5 GB on Bistro. Stage 0 measured 2.3 GB. The soup is ~120 MB
//      of that and is DELIBERATE (see GISystem's dispose note).
//   4. ZERO SRC KERNELS. Not "SRC is slower now" — absent. The pipeline ledger
//      is scanned for the names `src#`, `occupancy#` and the SRC pass family;
//      one hit fails the run. This is what makes "GI2 is the lit path" a
//      measurement rather than a claim.
//
// ⚠ THE URL IS 5202, NEVER 5201. This worktree has a junctioned `node_modules`
// and therefore a private vite cache (`vite.gi19.config.mjs`); pointing at the
// main tree's :5201 server measures the main tree's code with the main tree's
// cache. Start the server with:
//
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//   node scripts/run-gi2-boot-probe.mjs http://127.0.0.1:5202/
//
// Env:
//   PROJECT=<path>     default C:/Users/Khudiiash/Documents/GAME
//   SCENES=Level,Bistro    which scenes to run, in order
//   SETTLE=10          seconds of steady state before the perf read
//   FIRST_LIGHT_MS=3000 · GI_GPU_MS=4 · HEAP_MB=1500   the budgets
//   HEADED=1
import zlib from "node:zlib";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

// ── MEAN LUMINANCE OF A COMPOSITOR SCREENSHOT (§19 Stage 4.3a) ──────────────
//
// ⚠ A WEBGPU CANVAS CANNOT BE `drawImage`d. The first version of this receipt
// picked the viewport canvas correctly, sampled it 184 times, and reported a
// mean of 0.00 on a boot that was plainly rendering — the instrument was blind
// to its subject ([[probe-blind-statistics]]), not the scene black. The only
// capture path that sees WebGPU content is the COMPOSITOR's, i.e. puppeteer's
// `page.screenshot`, which hands back a PNG. Decoding it here (zlib is in the
// standard library; a screenshot is 8-bit RGB/RGBA, non-interlaced) keeps the
// probe dependency-free and keeps the sample off the page's main thread, which
// is the thread the compile wave is busy blocking.
function pngMeanLuminance(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let at = 8;
  let w = 0; let h = 0; let depth = 0; let color = 0; let interlace = 0;
  const idat = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      depth = body[8]; color = body[9]; interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (!w || !h || depth !== 8 || interlace !== 0) return null;
  const channels = color === 2 ? 3 : color === 6 ? 4 : color === 0 ? 1 : 0;
  if (!channels) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let sum = 0;
  for (let y = 0, p = 0; y < h; y++) {
    const filter = raw[p++];
    raw.copy(cur, 0, p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const i = x * channels;
      sum += channels === 1
        ? cur[i]
        : 0.2126 * cur[i] + 0.7152 * cur[i + 1] + 0.0722 * cur[i + 2];
    }
    cur.copy(prev);
  }
  return sum / (w * h);
}

const url = (process.argv[2] ?? "http://127.0.0.1:5202/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENES = (process.env.SCENES ?? "Level,Bistro").split(",").map((s) => s.trim()).filter(Boolean);
const SETTLE = Number(process.env.SETTLE ?? 10);
const FIRST_LIGHT_MS = Number(process.env.FIRST_LIGHT_MS ?? 3000);
const GI_GPU_MS = Number(process.env.GI_GPU_MS ?? 4);
const HEAP_MB = Number(process.env.HEAP_MB ?? 1500);
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT ?? 300) * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the pipeline ledger ─────────────────────────────────────────────────────
//
// Patched onto `GPUDevice.prototype` before any page script runs, exactly as
// `run-gi-boot-probe`'s hook does. Two things are recorded that a bare counter
// cannot give: the WGSL BYTE COUNT (so "how much shader text did this boot
// compile" is answerable) and `__giCurrentPassName()`, the engine's own
// dev-only global — which is what makes the "no SRC kernel" assertion name a
// PASS rather than an anonymous index.
const pageHook = () => {
  const rec = { pipelines: [], t0: performance.now(), epochAtT0: Date.now(), bytesByModule: new WeakMap() };
  globalThis.__gi2BootProbe = rec;
  const patch = (proto, name, fn) => {
    if (!proto || typeof proto[name] !== "function") return;
    const orig = proto[name];
    proto[name] = function (...args) { return fn.call(this, orig, args); };
  };
  if (!globalThis.GPUDevice) return;
  patch(GPUDevice.prototype, "createShaderModule", function (orig, args) {
    const mod = orig.apply(this, args);
    try {
      const code = args[0]?.code ?? "";
      // §19 Stage 4.3a: the CONTENT SIGNATURE, not just the byte count. "How
      // many distinct fragment programs did this boot mint" is the whole
      // material-variant question, and a count of pipelines cannot answer it —
      // four roughness buckets of one material are four pipelines over
      // (possibly) four texts, or over one. Same cheap stride hash
      // `run-gi-boot-probe` uses, so the two probes' numbers line up.
      let h = 0;
      for (let i = 0; i < code.length; i += 127) h = ((h * 33) ^ code.charCodeAt(i)) >>> 0;
      rec.bytesByModule.set(mod, { bytes: code.length, sig: `${code.length}:${h.toString(36)}` });
    } catch { /* frozen */ }
    return mod;
  });
  const note = (desc, kind, async) => {
    const mod = kind === "compute" ? desc?.compute?.module : (desc?.fragment?.module ?? desc?.vertex?.module);
    let bytes = 0;
    let sig = "";
    try {
      const info = rec.bytesByModule.get(mod);
      bytes = info?.bytes ?? 0;
      sig = info?.sig ?? "";
    } catch { /* ditto */ }
    rec.pipelines.push({
      kind, async, sig,
      label: desc?.label ?? "",
      pass: globalThis.__giCurrentPassName?.() ?? "",
      bytes,
      at: performance.now() - rec.t0,
    });
  };
  patch(GPUDevice.prototype, "createComputePipeline", function (orig, args) {
    note(args[0], "compute", false); return orig.apply(this, args);
  });
  patch(GPUDevice.prototype, "createComputePipelineAsync", function (orig, args) {
    note(args[0], "compute", true); return orig.apply(this, args);
  });
  patch(GPUDevice.prototype, "createRenderPipeline", function (orig, args) {
    note(args[0], "render", false); return orig.apply(this, args);
  });
  patch(GPUDevice.prototype, "createRenderPipelineAsync", function (orig, args) {
    note(args[0], "render", true); return orig.apply(this, args);
  });
};

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--js-flags=--expose-gc",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument(pageHook);
// FLAGS={"__giNoCompileWave":true} — the same hatch `run-gi-boot-probe` has.
// An A/B of a boot-order claim needs to set a global BEFORE the page runs, and
// without this the only way to test "is the compile wave what starves the
// voxelizer" is to edit the engine, which makes the arms non-comparable.
await page.evaluateOnNewDocument((flags) => {
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
}, JSON.parse(process.env.FLAGS ?? "{}"));
await page.evaluateOnNewDocument((project) => {
  // Headless is never focused, and the editor suspends an unfocused viewport —
  // without this every frame number is a lie and GI never ticks at all.
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

// ── console capture ─────────────────────────────────────────────────────────
//
// Per-SCENE, because the run opens two of them in one page: every marker is
// reset by `armScene()` before `scene.open`, so a Bistro number can never
// inherit the Level's.
let marks = null;
const resetMarks = () => {
  marks = { assetsReady: 0, firstLight: 0, occupancy: new Map(), built: 0, soup: null, lines: [] };
};
resetMarks();
page.on("console", (m) => {
  const t = m.text();
  const now = Date.now();
  if (/scene assets ready/.test(t) && !marks.assetsReady) marks.assetsReady = now;
  const occ = /\[gi2\] first occupancy L(\d+) at (\d+) ms/.exec(t);
  if (occ && !marks.occupancy.has(occ[1])) marks.occupancy.set(occ[1], now);
  if (/\[gi2\] first light/.test(t) && !marks.firstLight) marks.firstLight = now;
  if (/\[gi2\] soup /.test(t)) marks.soup = t;
  if (/\[gi\] built/.test(t)) marks.built++;
  if (/\[gi2\]|gi2|screen chain|unavailable|failed|Error|postprocess pass warm|wave breakdown|prewarm loop|SLOWEST PIPELINE|pipelines compiled|variant swap|\[gi\] (built|light shadows|quality|auto-fit|compile wave|transport)/.test(t)) {
    marks.lines.push(t.slice(0, 220));
    console.log(`    ${t.slice(0, 900)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`    pageerror: ${msg.slice(0, 240)}`);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
// The op surface exposes no engine, and §19 Stage 4.0's ownership-list gate
// needs one. Resolved once, from the same module the editor boots from.
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__giEngineForProbe = mod.engine;
});

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

let failed = 0;
const rows = [];
const gate = (scene, name, measured, limit, ok, unit = "") => {
  rows.push({ scene, name, measured, limit, ok, unit });
  if (!ok) failed++;
};

for (const name of SCENES) {
  const scenePath = `${PROJECT}/scenes/${name}.scene`;
  console.log(`\n══ ${name} ═══════════════════════════════════════════════`);
  resetMarks();
  const ledgerBefore = await page.evaluate(() => globalThis.__gi2BootProbe?.pipelines.length ?? 0);
  // ── THE VISUAL-SAFETY RECEIPT (§19 Stage 4.3a) ────────────────────────────
  //
  // Stage 4.3a lets materials keep DRAWING WITH THEIR OLD PROGRAM while the
  // GI-injected variant compiles in the background. The failure that buys is
  // not a slow boot, it is a WRONG FRAME: a material that swaps half-configured,
  // or a scene that goes unlit for a second while the swap lands. Neither shows
  // up in a first-light timestamp, so the swap needs its own instrument —
  // the frame's mean luminance, sampled straight off the viewport canvas
  // every 200 ms through the whole wave. The gate is a floor relative to the
  // settled value, not an absolute: `never below 50% of the post-wave mean
  // after first light`.
  //
  // ⚠ IF EVERY SAMPLE IS 0 THE INSTRUMENT IS BLIND, NOT THE SCENE BLACK
  // ([[probe-blind-statistics]]) — the report says so rather than passing.
  //
  // ⚠ THE VIEWPORT IS NOT THE BIGGEST CANVAS EITHER — the editor keeps 4k
  // offscreen canvases around (thumbnails, GI's slot-albedo atlas). Pick by
  // ON-SCREEN box, which is what "the frame the user sees" means, and clip the
  // capture to a small centred patch so a sample costs a few ms rather than a
  // full-page PNG.
  const lum = [];
  let lumPick = "";
  let clip = null;
  const findClip = async () => {
    const r = await page.evaluate(() => {
      let best = null;
      let area = 0;
      for (const c of document.querySelectorAll("canvas")) {
        const b = c.getBoundingClientRect();
        const a = b.width * b.height;
        if (a > area && b.width > 8 && b.height > 8) { area = a; best = { c, b }; }
      }
      if (!best) return null;
      const { c, b } = best;
      return {
        x: b.x, y: b.y, w: b.width, h: b.height,
        pick: `${c.className || c.id || "canvas"} ${c.width}x${c.height} on-screen ${Math.round(b.width)}x${Math.round(b.height)}`,
      };
    });
    if (!r) return null;
    lumPick = r.pick;
    const w = Math.min(240, Math.floor(r.w));
    const h = Math.min(160, Math.floor(r.h));
    return { x: Math.round(r.x + (r.w - w) / 2), y: Math.round(r.y + (r.h - h) / 2), width: w, height: h };
  };
  // ⛔ OPT-IN (`LUM=1`), AND THAT IS NOT TIDINESS — IT IS THE MEASUREMENT.
  // A compositor screenshot every 200 ms perturbs the very boot it is watching:
  // with the sampler on, Bistro's first light read 7699 ms against 5447 ms on
  // the same build minutes earlier, and the wave's own number moved 7231 →
  // 4003 ms. So the visual receipt gets its OWN run and every timing run is
  // clean. ⭐ An instrument heavy enough to change its subject must never be
  // on by default in the arm that reports the subject's number.
  const LUM = process.env.LUM === "1";
  const sampleLum = async () => {
    if (!LUM) return;
    try {
      clip ??= await findClip();
      if (!clip) return;
      const png = await page.screenshot({ clip, type: "png", captureBeyondViewport: false });
      const mean = pngMeanLuminance(Buffer.from(png));
      if (mean != null) lum.push({ at: Date.now(), lum: +mean.toFixed(2) });
    } catch { /* a screenshot can race a resize; the next sample is 200 ms away */ }
  };
  const openedAt = Date.now();
  const openCall = call("scene.open", { path: scenePath });
  // NOT awaited before the sampler starts: the whole point is to watch the
  // frame WHILE the scene opens and the wave runs.
  let openSettled = null;
  openCall.then((r) => { openSettled = r; }, (e) => { openSettled = { ok: false, error: String(e) }; });
  while (!openSettled) {
    await sampleLum();
    await wait(200);
  }
  const opened = await openCall;
  if (!opened.ok) {
    console.log(`  FATAL scene.open: ${opened.error}`);
    failed++;
    continue;
  }

  // Wait for first light, or for the boot timeout. The anchor is `scene assets
  // ready` when it arrives and `scene.open` otherwise — the gate is "after the
  // scene's assets are in", and a scene whose assets were already resident
  // never prints the line.
  const deadline = Date.now() + BOOT_TIMEOUT;
  while (Date.now() < deadline && !marks.firstLight) {
    await sampleLum();
    await wait(200);
  }
  const anchor = marks.assetsReady || openedAt;
  const firstLightMs = marks.firstLight ? marks.firstLight - anchor : Infinity;

  // ⚠ THE OCCUPANCY LINES ARRIVE AFTER FIRST LIGHT, NOT BEFORE. A ray hits the
  // window as soon as the COARSE levels hold bricks; the per-level receipts are
  // published by the stats readback, which is slower than the light. Reading
  // them at the first-light moment printed "occupancy none" on a boot that had
  // just logged three levels. Read them after the settle.
  // Settle, then measure. `__editorKeepRendering` keeps the loop alive; the
  // wait is what separates "the first frames after a compile wave" from the
  // steady state every budget in §M.4 is written against.
  // Sampled, not slept: the wave outlives first light, and the frames the
  // swap has to be judged on are exactly the ones in this window.
  {
    const until = Date.now() + SETTLE * 1000;
    while (Date.now() < until) {
      await sampleLum();
      await wait(200);
    }
  }

  const frameStats = (await call("profile.frameStats", { settleMs: 1100 })).value ?? {};
  const gi2 = (await call("profile.gi2")).value ?? null;
  const giPasses = (await call("profile.giPasses", { samples: 24 })).value ?? null;
  const heapMB = await page.evaluate(() => (performance.memory?.usedJSHeapSize ?? 0) / 1048576);
  const occRows = [...marks.occupancy.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([lvl, at]) => `L${lvl} ${at - anchor} ms`);
  const ledger = await page.evaluate((from) => (globalThis.__gi2BootProbe?.pipelines ?? []).slice(from), ledgerBefore);

  const compute = ledger.filter((p) => p.kind === "compute");
  const render = ledger.filter((p) => p.kind === "render");
  const kB = ledger.reduce((n, p) => n + p.bytes, 0) / 1024;
  // §M.4's "zero SRC kernels". The names are the ones `#rebuild` stamps:
  // `src#N` for every SRC probe pass and `occupancy#N` for every pyramid pass.
  const srcNames = ledger
    .map((p) => `${p.pass || ""} ${p.label || ""}`.trim())
    .filter((s) => /(^|\W)(src#|occupancy#|srcProbes)/.test(s));

  // `gi2TotalMs` is the whole GI frame under GI2 (see profile.giPasses' own
  // note): GI2's chain is not in `state.queue`, so `queueTotalMs` would report
  // a near-zero GI frame on the very path that IS the GI frame.
  const giGpuMs = giPasses == null ? null
    : (giPasses.gi2TotalMs ?? 0) + (giPasses.screenTotalMs ?? 0) + (giPasses.queueTotalMs ?? 0);

  console.log(`\n  boot: assets→first light ${Number.isFinite(firstLightMs) ? `${firstLightMs} ms` : "NEVER"}` +
    `   occupancy ${occRows.length ? occRows.join(", ") : "none"}`);
  console.log(`  ${marks.soup ?? "  (no soup line — the window never received geometry)"}`);
  console.log(`  pipelines: ${compute.length} compute + ${render.length} render, ${kB.toFixed(1)} kB WGSL`);
  // ── THE MATERIAL-VARIANT CENSUS (§19 Stage 4.3a) ─────────────────────────
  // `render.length` is the pipeline count; what the compile wave actually
  // pays for is DISTINCT FRAGMENT TEXT, because that is what three's codegen
  // walks and what the driver compiles. The gap between the two is the
  // duplication a key collapse can delete.
  {
    const bySig = new Map();
    for (const p of render) {
      if (!p.sig) continue;
      const e = bySig.get(p.sig) ?? { count: 0, bytes: p.bytes };
      e.count++;
      bySig.set(p.sig, e);
    }
    const groups = [...bySig.values()].sort((a, b) => b.bytes - a.bytes);
    const dupes = groups.reduce((s, g) => s + (g.count - 1), 0);
    console.log(`  fragments: ${render.length} render pipelines over ${groups.length} distinct fragment shaders ` +
      `(${dupes} reuse an already-seen text); largest ${(groups[0]?.bytes ?? 0) / 1024 | 0} kB, ` +
      `top ${groups.slice(0, 5).map((g) => `${Math.round(g.bytes / 1024)}kB×${g.count}`).join(" ")}`);
  }
  // ── WHEN DID EACH GI2 KERNEL'S PIPELINE GET CREATED? ─────────────────────
  //
  // The gap between "the voxelizer is live" and "the window holds occupancy"
  // has two candidate mechanisms that a first-light timestamp cannot tell
  // apart: the dispatches are FRAME-STARVED (a per-frame budget, few frames),
  // or they are COMPILE-BLOCKED (a dispatch whose pipeline has not landed is
  // skipped). Creation time per pass, against the same anchor as first light,
  // separates them — a voxelize pipeline created at 1.2 s with occupancy at
  // 3.8 s is starvation; one created at 3.5 s is the compile.
  {
    const epoch = await page.evaluate(() => globalThis.__gi2BootProbe?.epochAtT0 ?? 0);
    const firstBy = new Map();
    for (const p of ledger) {
      if (p.kind !== "compute") continue;
      const nm = p.pass || p.label || "(anon)";
      if (!firstBy.has(nm)) firstBy.set(nm, epoch + p.at - anchor);
    }
    const line = [...firstBy.entries()].sort((a, b) => a[1] - b[1])
      .map(([n, t]) => `${n}@${(t / 1000).toFixed(2)}s`).join(" ");
    console.log(`  compute pipeline creation: ${line}`);
  }
  // ── THE SWAP'S VISUAL-SAFETY RECEIPT ─────────────────────────────────────
  if (LUM) {
    console.log(`  luminance source: ${lumPick || "(no canvas found)"}`);
    const post = lum.slice(-15);
    const settled = post.length ? post.reduce((s, p) => s + p.lum, 0) / post.length : 0;
    const afterLight = marks.firstLight ? lum.filter((p) => p.at >= marks.firstLight) : [];
    const floor = afterLight.length ? Math.min(...afterLight.map((p) => p.lum)) : null;
    if (!lum.length || settled <= 0.01) {
      console.log(`  luminance: ⚠ BLIND — ${lum.length} samples, settled mean ${settled.toFixed(2)}. ` +
        "The canvas snapshot returned nothing; this run proves nothing about the swap.");
    } else {
      const pct = floor == null ? null : (100 * floor) / settled;
      console.log(`  luminance: ${lum.length} samples, settled ${settled.toFixed(1)}, ` +
        `min after first light ${floor == null ? "n/a" : floor.toFixed(1)} ` +
        `(${pct == null ? "n/a" : `${pct.toFixed(0)}% of settled`}) — ` +
        `${pct == null ? "no post-light samples" : pct >= 50 ? "PASS (≥50%)" : "FAIL (<50%)"}`);
      const series = lum.filter((_, i) => i % 2 === 0).slice(-40)
        .map((p) => `${((p.at - anchor) / 1000).toFixed(1)}s:${p.lum.toFixed(0)}`).join(" ");
      console.log(`    series ${series}`);
    }
  }
  console.log(`  frame: ${frameStats.fps ?? "?"} fps, cpu ${frameStats.cpuMs ?? "?"} ms, gpu ${frameStats.gpuMs ?? "?"} ms` +
    `${frameStats.gpuMsIsReal ? "" : " (estimated)"}, heap ${heapMB.toFixed(0)} MB, transport ${frameStats.giTransport ?? "?"}`);
  if (gi2) {
    console.log(`  gi2: tier ${gi2.tier}, window ${gi2.windowMB} MB + cache ${gi2.cacheMB} MB, ` +
      `${gi2.soupTris} tris / ${gi2.soupMB} MB, ${gi2.probes} probes × ${gi2.rays / Math.max(1, gi2.probes)} rays`);
    console.log(`  rays: ${gi2.windowHits ?? 0} window / ${gi2.screenHits ?? 0} screen / ${gi2.skyMiss ?? 0} sky ` +
      `of ${gi2.raysTraced ?? 0} traced; ${gi2.probesValid ?? 0} of ${gi2.probesPlaced ?? 0} probes valid; ` +
      `${gi2.freshShades ?? 0} fresh shades, ${gi2.reprojHits ?? 0} reprojections`);
    if (gi2.voxelizer) {
      const v = gi2.voxelizer;
      console.log(`  voxelizer: ${v.built} built / ${v.dirty} dirty, ${v.pairsWritten} of ${v.pairsNeeded} pairs, ` +
        `${v.voxelsSet} voxels, overflow ${v.overflowed}, starved ${v.starved}, deferred ${v.deferred}, ` +
        `resumed ${v.resumed}, invalid ${v.invalid ?? "?"}, slotFull ${v.slotFull ?? "?"}, cellOvf ${v.cellOverflow ?? "?"}`);
      console.log(`             per level: ${(v.perLevel ?? []).map((l) => `L${l.level} ${l.built}b/${l.dirty}d/${l.pairs}p`).join("  ")}`);
    }
    if (gi2.dynamic) {
      console.log(`  dynamic: ${gi2.dynamic.trianglesPacked} mover tris, ${gi2.dynamic.voxelsSet} voxels, ` +
        `${gi2.dynamic.outside} outside the window`);
    }
  }
  if (giPasses) {
    // `gi2Ms` is the GI2 chain, `screenPassesMs` what survives of the old screen
    // chain (the g-buffer prepass and GTAO), `queueMs` the rate-gated queue
    // (empty under GI2). Merged and ranked, because the question this table
    // answers is "which kernel owns the GI frame", not "which list".
    const kernels = [
      ...Object.entries(giPasses.gi2Ms ?? {}),
      ...Object.entries(giPasses.screenPassesMs ?? {}),
      ...Object.entries(giPasses.queueMs ?? {}),
    ].filter(([, v]) => typeof v === "number" && v > 0);
    if (kernels.length) {
      console.log("\n  ── PER-KERNEL GPU ms ──────────────────────────────");
      for (const [n, v] of kernels.sort((a, b) => b[1] - a[1]).slice(0, 22)) {
        console.log(`   ${String(v.toFixed(3)).padStart(8)}  ${n}`);
      }
      console.log(`   ${String((giGpuMs ?? 0).toFixed(3)).padStart(8)}  TOTAL   (gi2 ` +
        `${(giPasses.gi2TotalMs ?? 0).toFixed(3)} + screen ${(giPasses.screenTotalMs ?? 0).toFixed(3)} + ` +
        `queue ${(giPasses.queueTotalMs ?? 0).toFixed(3)})`);
    } else if (process.env.RAW_PASSES) {
      console.log("  raw giPasses:", JSON.stringify(giPasses, null, 1).slice(0, 3000));
    }
  }

  gate(name, "first light after assets", Number.isFinite(firstLightMs) ? firstLightMs : -1,
    FIRST_LIGHT_MS, Number.isFinite(firstLightMs) && firstLightMs <= FIRST_LIGHT_MS, "ms");
  gate(name, "GI GPU", giGpuMs == null ? -1 : +giGpuMs.toFixed(2), GI_GPU_MS,
    giGpuMs != null && giGpuMs <= GI_GPU_MS, "ms");
  gate(name, "transport alive", frameStats.giTransport ?? "null", "alive",
    frameStats.giTransport === "alive");
  gate(name, "SRC kernels compiled", srcNames.length, 0, srcNames.length === 0);
  if (srcNames.length) console.log(`  ⚠ SRC kernels present: ${[...new Set(srcNames)].slice(0, 8).join(", ")}`);
  // ── §19 STAGE 4.0: `gi2.crop` MUST NOT BE REACHABLE FROM THE ENGINE ────────
  //
  // ⚠ A PIPELINE LEDGER CANNOT ANSWER THIS ON ITS OWN. `gi2.crop` never
  // appeared in the ledger even at 4.3a, because nothing DISPATCHES it — the
  // damage was that it sat in `computeNodes`, the OWNERSHIP list, where any
  // prewarm that walked that list dragged in 526 kB of WGSL and 11.8 s of
  // driver compile (the Level's `computes` phase, 36 ms → 7056 ms). So the
  // gate reads the ownership list itself, which is the thing that changed.
  const owned = await page.evaluate(() => {
    const mod = globalThis.__giEngineForProbe ?? null;
    const sys = mod?.modules?.get?.("gi")?.system;
    const nodes = sys?.state?.screen?.gi2?.computeNodes ?? null;
    if (!nodes) return null;
    return nodes.map((n) => n?.__giPassName ?? "(unnamed)");
  });
  if (owned) {
    const crops = owned.filter((n) => /crop/i.test(n));
    gate(name, "gi2.crop out of the ownership list", crops.length, 0, crops.length === 0);
    console.log(`  gi2 ownership list: ${owned.length} compute nodes, ${crops.length} crop`);
  }
  if (name.toLowerCase() === "bistro") {
    gate(name, "JS heap", +heapMB.toFixed(0), HEAP_MB, heapMB <= HEAP_MB, "MB");
  }
}

console.log("\n══ GATES ══════════════════════════════════════════════════");
console.log(`  ${"scene".padEnd(8)}${"gate".padEnd(26)}${"measured".padStart(12)}${"limit".padStart(10)}  verdict`);
for (const r of rows) {
  console.log(`  ${r.scene.padEnd(8)}${r.name.padEnd(26)}` +
    `${String(`${r.measured}${r.unit}`).padStart(12)}${String(`${r.limit}${r.unit}`).padStart(10)}  ` +
    `${r.ok ? "PASS" : "FAIL"}`);
}
console.log(failed ? `\ngi2-boot-probe: ${failed} FAILED` : "\ngi2-boot-probe: all PASS");
await browser.close();
process.exit(failed ? 1 : 0);
