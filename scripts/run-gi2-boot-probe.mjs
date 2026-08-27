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
// ⭐ §19 STAGE 3.6 — ASK FOR THE NOISE KERNEL BEFORE THE GI BUILD.
//
// "GI is noisy" is a report about the resolved IRRADIANCE TEXTURE, and no
// counter in `profile.gi2` can see a texture. `gatherProbes` builds a per-pixel
// dump kernel only when a receipt asked for it first (Stage 4.3a's rule: a
// kernel only a receipt dispatches must only be BUILT by a receipt), and this
// is that asking. Set before the document runs, so it is set before the gather
// factory reads it. `NOISE=0` leaves it out.
if (process.env.NOISE !== "0") {
  await page.evaluateOnNewDocument(() => { globalThis.__gi2NoiseDump = true; });
}
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
  marks = { assetsReady: 0, firstLight: 0, occupancy: new Map(), built: 0, soup: null, placements: null, lines: [] };
};
resetMarks();
page.on("console", (m) => {
  const t = m.text();
  const now = Date.now();
  if (/scene assets ready/.test(t) && !marks.assetsReady) marks.assetsReady = now;
  const occ = /\[gi2\] first occupancy L(\d+) at (\d+) ms/.exec(t);
  if (occ && !marks.occupancy.has(occ[1])) marks.occupancy.set(occ[1], now);
  if (/\[gi2\] first light/.test(t) && !marks.firstLight) marks.firstLight = now;
  // TWO different soup lines now (§19 Stage 4.0b): the ENUMERATION receipt
  // ("N placements, K past the old 768 cap") on the way in, and the built-soup
  // receipt ("N tris, M MB, palette …") on the way out. Kept apart, because the
  // whole point of 4.0b is the first one and a single slot would let the second
  // overwrite it.
  if (/\[gi2\] soup \d+ placements/.test(t)) marks.placements = t;
  else if (/\[gi2\] soup /.test(t)) marks.soup = t;
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
  console.log(`  ${marks.placements ?? "  (no placement line — the content walk never ran)"}`);
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
      `${gi2.soupTris} tris / ${gi2.soupMB} MB, ${gi2.probes} probes × ${gi2.rays / Math.max(1, gi2.probes)} rays, ` +
      // §19 Stage 4.0b: "N classes" and "N of them emit" are different facts.
      `palette ${gi2.palClasses} classes / ${gi2.palEmissiveClasses ?? "?"} emissive ` +
      `(band ${gi2.palEmitterBand ?? "?"})`);
    console.log(`  rays: ${gi2.windowHits ?? 0} window / ${gi2.screenHits ?? 0} screen / ${gi2.skyMiss ?? 0} sky ` +
      `of ${gi2.raysTraced ?? 0} traced; ${gi2.probesValid ?? 0} of ${gi2.probesPlaced ?? 0} probes valid; ` +
      `${gi2.freshShades ?? 0} fresh shades, ${gi2.reprojHits ?? 0} reprojections`);
    // ── §19 STAGE 3.6's three counters, as RATES ─────────────────────────
    //
    // ⭐ THE RAW NUMBERS DO NOT COMPARE ACROSS SCENES. "105 977 resets" means
    // one thing on a 25 254-probe Bistro and another on the Level; the rate
    // against the rays actually traced is the same quantity everywhere, and it
    // is the one the user's report quoted (26 %). The reprojection census
    // turns the miss rate into a MECHANISM — five gates, summing to the misses
    // by construction.
    {
      const rt = Math.max(1, gi2.raysTraced ?? 0);
      const pv = Math.max(1, gi2.probesValid ?? 0);
      const miss = (gi2.probesValid ?? 0) - (gi2.reprojHits ?? 0);
      const cls = {
        offScreen: gi2.reprojOffScreen ?? 0, noPrev: gi2.reprojNoPrev ?? 0,
        plane: gi2.reprojPlane ?? 0, slant: gi2.reprojSlant ?? 0, align: gi2.reprojAlign ?? 0,
      };
      const sum = Object.values(cls).reduce((a, x) => a + x, 0);
      console.log(`  §3.6: history resets ${gi2.alphaForced ?? 0}/${rt} = ` +
        `${(100 * (gi2.alphaForced ?? 0) / rt).toFixed(2)} % of traced rays; texel maturity ` +
        `${(100 * (gi2.matureTexels ?? 0) / rt).toFixed(1)} % (n ≥ H/2); reprojection ` +
        `${(100 * (gi2.reprojHits ?? 0) / pv).toFixed(2)} %`);
      console.log(`  §3.6 reprojection census: ${miss} misses — ` +
        Object.entries(cls).map(([k, v]) => `${k} ${v}`).join(", ") +
        ` (sum ${sum}${sum === miss ? "" : ` ≠ ${miss} — THE CENSUS IS BLIND`})`);
    }
    // ── §19 STAGE 3.6's NOISE RECEIPT, on the real scene ─────────────────
    //
    // Thirty consecutive frames of the resolved irradiance, reduced IN THE
    // PAGE — 30 × 6.4 MB across the CDP bridge would be most of this probe's
    // wall time, and the reduction is two histograms.
    const noise = await page.evaluate(async () => {
      // The same accessor the crop-ownership gate below uses — the engine has
      // no global of its own, and importing `engineInstance.js` from here
      // would risk Vite's `?t=` twin and a SECOND Engine.
      const eng = globalThis.__giEngineForProbe ?? null;
      const g = eng?.modules?.get?.("gi")?.system?._gi2?.gather;
      const r = eng?.renderer;
      if (!g?.passes?.noiseDump || !g.buffers?.noiseBuf || !r) {
        return { error: "the noise kernel was not built (set __gi2NoiseDump before the GI build)" };
      }
      const BINS = 2048; const LO = 1e-5; const HI = 100; const K = Math.log(HI / LO);
      const mk = () => ({ b: new Float64Array(BINS), n: 0 });
      const add = (h, v) => {
        const t = Math.log(Math.min(HI, Math.max(LO, v)) / LO) / K;
        h.b[Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)))]++; h.n++;
      };
      const pct = (h, p) => {
        if (!h.n) return null;
        let c = 0;
        for (let i = 0; i < BINS; i++) { c += h.b[i]; if (c >= (h.n * p) / 100) return LO * Math.exp(K * ((i + 0.5) / BINS)); }
        return HI;
      };
      const N = g.buffers.noiseBuf.value.array.length / 4;
      const sum = new Float64Array(N); const sq = new Float64Array(N); const cnt = new Uint16Array(N);
      const spat = [];
      let lit = null;
      const FRAMES = 30;
      // ⚠ WARM THE KERNEL FIRST. The first `computeAsync` of a pass that has
      // never run pays its pipeline creation, and the readback that follows it
      // came back ALL ZEROES — which the statistic then read as "no lit
      // pixels", every pixel failed `cnt == FRAMES`, and the temporal receipt
      // reported n/a on a scene that was plainly lit. An instrument's first
      // sample is not a sample.
      for (let k = 0; k < 3; k++) {
        await new Promise((res) => requestAnimationFrame(() => res()));
        await r.computeAsync(g.passes.noiseDump);
      }
      for (let k = 0; k < FRAMES; k++) {
        await new Promise((res) => requestAnimationFrame(() => res()));
        await r.computeAsync(g.passes.noiseDump);
        const f = new Float32Array(await r.getArrayBufferAsync(g.buffers.noiseBuf.value));
        if (lit == null) {
          const h = mk();
          for (let i = 0; i < N; i++) if (f[i * 4 + 3] > 0.5) add(h, f[i * 4 + 1]);
          // A scene-derived threshold, and it must come from a frame that HAS
          // a scene: a zero median would admit every black pixel.
          if (h.n > 0 && (pct(h, 50) ?? 0) > 0) lit = 0.1 * pct(h, 50);
          else continue;
        }
        const hp = mk();
        for (let i = 0; i < N; i++) {
          if (!(f[i * 4 + 3] > 0.5)) continue;
          const L = f[i * 4]; const B = f[i * 4 + 1];
          if (!(B > lit)) continue;
          sum[i] += L; sq[i] += L * L; cnt[i]++;
          if (f[i * 4 + 2] < 0.5) add(hp, Math.abs(L - B) / B);
        }
        spat.push([pct(hp, 50), pct(hp, 95), hp.n]);
      }
      const th = mk();
      // A pixel counts if it was lit in essentially every frame — not in ALL
      // of them, so one frame in which the lit threshold clipped a flickering
      // pixel does not delete it from the population.
      const need = Math.max(2, spat.length - 2);
      for (let i = 0; i < N; i++) {
        if (cnt[i] < need) continue;
        const m = sum[i] / cnt[i];
        if (!(m > 0)) continue;
        add(th, Math.sqrt(Math.max(0, sq[i] / cnt[i] - m * m)) / m);
      }
      const med = (xs) => {
        const v = xs.filter((x) => x != null).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : null;
      };
      return {
        pixels: N, frames: spat.length, litThreshold: lit,
        temporal: { p50: pct(th, 50), p95: pct(th, 95), n: th.n },
        spatial: { p50: med(spat.map((s) => s[0])), p95: med(spat.map((s) => s[1])), n: med(spat.map((s) => s[2])) },
      };
    });
    if (noise?.error) console.log(`  §3.6 noise: ${noise.error}`);
    else if (noise) {
      const p = (v) => (v == null ? "n/a" : `${(100 * v).toFixed(2)} %`);
      console.log(`  §3.6 noise (resolved irradiance, camera parked, ${noise.frames} frames, ` +
        `${noise.pixels} sampled pixels): TEMPORAL p50 ${p(noise.temporal.p50)} p95 ${p(noise.temporal.p95)} ` +
        `over ${noise.temporal.n} lit px | SPATIAL p50 ${p(noise.spatial.p50)} p95 ${p(noise.spatial.p95)} ` +
        `over ${noise.spatial.n} lit non-edge px`);
    }
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
  // ══ §19 STAGE 4.0b — THE PAST-THE-CAP RAY ARM ════════════════════════════
  //
  // ⭐⭐ "1532 placements went into the soup" IS A STATEMENT ABOUT A JS ARRAY.
  //
  // Until 4.0b the GI2 content walk `break`ed at `MAX_INSTANCE_SLOTS = 768` —
  // the SRC atlas's uniform-array ceiling, which GI2 does not build — so on
  // Bistro 764 placements had no occupancy, no bounce, no shadow and no palette
  // entry, and WHICH 764 was an accident of the prefab's hierarchy order (every
  // lantern and string light sits past index 1156). A placement COUNT cannot
  // tell "enumerated" apart from "in the world"; a ray can.
  //
  // So: pick three placements whose index is past the old cap, put the camera
  // 2 m off each one (the window is camera-centred and 64³ per level — a
  // lantern across the scene is simply not in it), let the voxelizer fill, and
  // fire a `traceWindow` ray at its centre from the SAME 2 m. A hit inside the
  // subject's bounding sphere is the receipt.
  //
  // ⚠ THE tMax IS THE GATE'S OWN GUARD. It stops at the far side of the
  // subject's bounding sphere, so a wall BEHIND the lantern cannot produce the
  // hit; and the reported `t` is printed next to the sphere's near/far bounds,
  // so a hit from something in FRONT is visible rather than counted as a pass.
  {
    const subjects = await page.evaluate(() => {
      const sys = globalThis.__giEngineForProbe?.modules?.get?.("gi")?.system;
      const gi2 = sys?.state?.screen?.gi2;
      if (!gi2 || !sys) return { error: "no gi2 system" };
      const keys = gi2.paletteAssign?.keys ?? [];
      const byKey = sys._gi2PaletteMeshByKey;
      if (!keys.length || !byKey) return { error: "no palette assignment (the soup has not landed)" };
      const CAP = 768;
      const out = [];
      // Evenly spread across the past-the-cap tail rather than the first three
      // after it — three neighbours in hierarchy order are usually three copies
      // of one prop, which would make this one measurement wearing three hats.
      // ⚠ AND WHEN NOTHING IS PAST THE CAP, THE ARM STILL RUNS — on the LAST
      // THIRD of the walk. `staticMerging` collapses Bistro's 1532 authored
      // meshes to ~516 live ones, so on that scene today the 768 cut never
      // fires; a probe that reported "n/a" there would leave "the walk reaches
      // its own end" untested on the only scene big enough to matter. The row
      // says which population it sampled.
      const tail = keys.length - CAP;
      const past = tail > 0;
      const from = past ? CAP : Math.floor(keys.length * 0.67);
      const span = keys.length - from;
      if (span <= 0) return { error: `only ${keys.length} placements`, total: keys.length };
      for (const f of [0.15, 0.5, 0.85]) {
        const idx = Math.min(keys.length - 1, from + Math.floor(span * f));
        const rec = byKey.get(keys[idx]);
        const mesh = rec?.mesh;
        if (!mesh?.parent || mesh.isInstancedMesh) continue;
        mesh.updateWorldMatrix(true, false);
        const g = mesh.geometry;
        const pos = g?.attributes?.position;
        if (!pos) continue;
        // ⛔⛔ THE TARGET IS A POINT **ON THE GEOMETRY**, NOT THE BOUNDING-BOX
        // CENTRE, and the first version of this arm proved why: `staticMerging`
        // gives Bistro `Merged(4)` meshes whose world bound radius is 23.55 m,
        // so "the centre" was a point in open air 20 m from any triangle and
        // every one of its six rays missed — a FAIL that measured the subject
        // picker, not the window. A triangle centroid is on the surface by
        // construction, at any scale, for a merged batch and for a 3 cm prop
        // alike.
        const index3 = g.index;
        const triCount = Math.floor((index3 ? index3.count : pos.count) / 3);
        if (triCount < 1) continue;
        const t3 = Math.floor(triCount / 2) * 3;
        const vi = (k) => (index3 ? index3.getX(t3 + k) : t3 + k);
        let lx = 0; let ly = 0; let lz = 0;
        for (let k = 0; k < 3; k++) { const v = vi(k); lx += pos.getX(v); ly += pos.getY(v); lz += pos.getZ(v); }
        lx /= 3; ly /= 3; lz /= 3;
        const e = mesh.matrixWorld.elements;
        const w = [
          e[0] * lx + e[4] * ly + e[8] * lz + e[12],
          e[1] * lx + e[5] * ly + e[9] * lz + e[13],
          e[2] * lx + e[6] * ly + e[10] * lz + e[14],
        ];
        out.push({ index: idx, name: mesh.name || "(unnamed)", world: w, tris: triCount });
      }
      return { total: keys.length, pastCap: Math.max(0, tail), past, voxel0: gi2.win?.voxel0 ?? 0.25, subjects: out };
    });
    if (subjects?.error) {
      console.log(`  §4.0b past-the-cap ray: ${subjects.error}`);
    } else if (subjects?.subjects?.length) {
      console.log(`\n  ── §4.0b ${subjects.past ? "PAST-THE-CAP" : "WALK-TAIL"} RAY ` +
        `(${subjects.total} placements, ${subjects.pastCap} past 768` +
        `${subjects.past ? "" : " — the cut never fired on this scene; sampling the last third instead"}) ──`);
      let hits = 0;
      // 2 m off a point ON the surface — a fixed distance, because the target
      // is a triangle centroid and not a bound whose size varies by three
      // orders of magnitude across a merged scene.
      const D = 2;
      const v0 = subjects.voxel0;
      for (const s of subjects.subjects) {
        // Six offsets: whichever direction is OPEN is the one that tests the
        // subject rather than its neighbour. A subject reachable from NO
        // direction is reported as such, not silently passed.
        const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.577, 0.577, 0.577], [-0.577, 0.577, -0.577]];
        const res = await page.evaluate(async ({ s, D, dirs, v0 }) => {
          const eng = globalThis.__giEngineForProbe;
          const sys = eng?.modules?.get?.("gi")?.system;
          const gi2 = sys?.state?.screen?.gi2;
          if (!gi2?.trace || !eng?.renderer) return { error: "no live window" };
          // The window follows the CAMERA. A subject anywhere else in the scene
          // is outside all 64³ levels, so the ray would miss for a reason that
          // has nothing to do with the cap. Park on it and let the voxelizer
          // fill before asking.
          await globalThis.__editorApi.call("viewport.setCamera", {
            position: [s.world[0] + D * 0.7, s.world[1] + D * 0.5, s.world[2] + D * 0.7],
            target: s.world,
          });
          await new Promise((r) => setTimeout(r, 3500));
          const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
          const shoot = createGi2RayShooter(gi2, eng.renderer);
          const rays = dirs.map((d) => ({
            o: [s.world[0] + d[0] * D, s.world[1] + d[1] * D, s.world[2] + d[2] * D],
            d: [-d[0], -d[1], -d[2]],
            // Stops ONE VOXEL past the target: nothing behind the subject can
            // produce this hit, so a pass cannot be borrowed from the wall
            // behind it.
            tMax: D + v0,
          }));
          const out = await shoot(rays);
          // ⭐⭐ AND THE DIRECT ANSWER, BESIDE THE RAY. A ray can miss for
          // reasons that are nothing to do with the cap — an origin born inside
          // a neighbour, a target on a one-sided sliver, a step budget — so
          // "does the window HOLD this placement" is asked of the window
          // itself: the OCC bit and the PAL byte of the cell the target point
          // falls in, at every level whose 64³ covers it. This is the receipt;
          // the ray is the corroboration.
          const store = await import("/src/modules/gi/window/windowStore.js");
          const win = gi2.win;
          const words = new Uint32Array(await eng.renderer.getArrayBufferAsync(win.attribute));
          const cells = [];
          for (let l = 0; l < win.levels; l++) {
            const v = win.voxel0 * Math.pow(2, l);
            const wc = [store.worldCell(s.world[0], v), store.worldCell(s.world[1], v), store.worldCell(s.world[2], v)];
            const o = [win.origins[l * 3], win.origins[l * 3 + 1], win.origins[l * 3 + 2]];
            if (!store.inWindow(wc, o)) continue;
            const vi = store.voxelIndex(wc[0], wc[1], wc[2]);
            const base = l * store.LEVEL_WORDS;
            const occ = (words[base + store.OCC_OFF + (vi >>> 5)] >>> (vi & 31)) & 1;
            const pal = (words[base + store.PAL_OFF + (vi >>> 2)] >>> ((vi & 3) * 8)) & 255;
            cells.push({ l, occ, pal });
          }
          return { rays: out.map((r) => ({ hit: !!r.hit, t: +Number(r.t).toFixed(3) })), cells };
        }, { s, D, dirs, v0 });
        if (res?.error) { console.log(`   #${s.index} ${s.name}: ${res.error}`); continue; }
        // The target is ON the surface, so an on-subject hit lands within a
        // voxel of D — the window's own resolution, which is the tightest a
        // voxelized world can be asked for.
        const lo = D - 2 * v0;
        const hi = D + v0;
        const good = res.rays.filter((r) => r.hit && r.t >= lo && r.t <= hi);
        // THE GATE IS THE OCCUPANCY, not the ray: a placement is "in the
        // window" when the cell its own triangle sits in is marked occupied and
        // carries a real palette class. The ray is printed beside it.
        const occ = (res.cells ?? []).filter((c) => c.occ === 1 && c.pal !== 255);
        if (occ.length) hits++;
        console.log(`   #${s.index} "${s.name}" ${s.tris} tris — occupancy at the target: ` +
          `${(res.cells ?? []).map((c) => `L${c.l} occ=${c.occ} pal=${c.pal}`).join(", ") || "OUTSIDE EVERY LEVEL"}` +
          `; rays ${good.length}/${res.rays.length} inside [${lo.toFixed(2)}, ${hi.toFixed(2)}] m ` +
          `(t: ${res.rays.map((r) => (r.hit ? r.t.toFixed(2) : "miss")).join(" ")})`);
      }
      gate(name, subjects.past ? "past-768 placements in window" : "walk-tail placements in window",
        hits, subjects.subjects.length, hits === subjects.subjects.length, "/3");
    }
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
