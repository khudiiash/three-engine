// WHAT THE BOOT'S SLOW FRAMES ARE — per-frame ledger over the whole boot.
//
// `run-gi-boot-probe` names the pipelines and their latencies, but a slow
// FRAME has two possible kinds of owner and neither instrument can see the
// other's — and the boot's tail is frames, not pipelines: three frames of
// 1.2-2.4 s dominate a boot whose compile wave is only ~2 s. This probe names
// the owner of each frame:
//
//   · THE WEBGPU LEDGER. Every GPUDevice/GPUQueue entry point that can block
//     the main thread is wrapped at document start and its SYNCHRONOUS wall
//     time is accumulated PER FRAME: createComputePipeline (three calls this
//     one synchronously — there is no async variant in WebGPUPipelineUtils),
//     createRenderPipeline, createShaderModule, createTexture/createBuffer,
//     writeBuffer/writeTexture/copyExternalImageToTexture, submit. A driver
//     compile or a 400 MB texture upload shows up here as ms, not as a guess.
//
//   · THE CPU PROFILE. Anything the ledger does not explain is plain JS —
//     transcode, BVH packing, a GC pause. The CDP sampling profiler runs for
//     the whole boot and every slow frame is attributed to the hottest stack
//     inside ITS OWN time window, so the answer is a function name.
//
// GC is read separately: a frame whose usedJSHeapSize FALLS by tens of MB paid
// for a major collection, and no wrapped call will confess to it.
//
// The "scene is lit" marker is the occupancy field's first dispatch — the same
// end marker `run-gi-boot-probe` settled on, for the same reason: a readback
// marker (`field ready:`) cannot be stamped faster than the frames that carry
// it, so it inherits whatever stall it is trying to measure. The old line is
// still accepted so a boot that never prints the dispatch line still ends.
//
// Usage:
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort --host 127.0.0.1
//   node scripts/run-gi-boot-frames-probe.mjs http://127.0.0.1:5201/
//
// Env: PROJECT (a project dir; `scripts/.boot-diag` is the fast deterministic
//      one), SCENE (default Main), URL, WAIT_MS, BOOTS, SLOW_MS, TOPN, FLAGS
//      (JSON of page globals), NO_PROFILE, CHROME_PATH
import puppeteer from "puppeteer-core";
import os from "node:os";
import path from "node:path";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? process.env.URL ?? "http://127.0.0.1:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Main";
const WAIT_MS = Number(process.env.WAIT_MS ?? 120000);
const BOOTS = Number(process.env.BOOTS ?? 1);
const SLOW_MS = Number(process.env.SLOW_MS ?? 50);
const AUTO = process.env.AUTO === "1";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (x, n = 0) => (x == null ? "—" : x.toFixed(n));
const mb = (bytes) => (bytes / 1048576).toFixed(1);

/** Injected before any page script: wrap the WebGPU surface and log per frame. */
function installLedger() {
  const g = globalThis;
  g.__frames = [];        // [tAbs, dt, counters, heapUsed]
  g.__longtasks = [];
  const C = () => ({
    cpN: 0, cpMs: 0,        // createComputePipeline  (SYNC in three)
    cpaN: 0, cpaMs: 0,      // createComputePipelineAsync — SYNC portion (Tint parse)
    cpaDoneN: 0,            // ...and how many of them RESOLVED in this frame
    rpN: 0, rpMs: 0,        // createRenderPipeline   (SYNC path)
    rpaN: 0,                // createRenderPipelineAsync (kicked off)
    smN: 0, smMs: 0,        // createShaderModule
    ctN: 0, ctMs: 0,        // createTexture
    cbN: 0, cbMs: 0, cbB: 0,// createBuffer
    wbN: 0, wbMs: 0, wbB: 0,// writeBuffer
    wtN: 0, wtMs: 0, wtB: 0,// writeTexture
    ceN: 0, ceMs: 0,        // copyExternalImageToTexture
    subN: 0, subMs: 0,      // queue.submit
    mapN: 0, mapMs: 0,      // buffer.mapAsync (awaited resolve, informational)
    bgN: 0, bgMs: 0,        // createBindGroup
    ibN: 0, ibMs: 0,        // createImageBitmap (main-thread image decode)
    rpL: [],                // render-pipeline labels created this frame (sync + async)
    gctN: 0, gctMs: 0,      // GPUCanvasContext.getCurrentTexture — blocks when the swap chain is starved
    gpuDoneMs: -1,          // queue.onSubmittedWorkDone latency measured from this frame's rAF
    subTop: [],             // the slowest submits of this frame: [ms, name] (GPU completion latency per submit)
  });
  let cur = C();
  g.__ledgerCur = () => cur;

  const timed = (proto, name, key, bytesOf) => {
    if (!proto || typeof proto[name] !== "function") return;
    const orig = proto[name];
    proto[name] = function (...args) {
      const t0 = performance.now();
      try {
        return orig.apply(this, args);
      } finally {
        cur[key + "Ms"] += performance.now() - t0;
        cur[key + "N"] += 1;
        if (bytesOf) { try { cur[key + "B"] += bytesOf(args) || 0; } catch {} }
      }
    };
  };

  const D = g.GPUDevice?.prototype, Q = g.GPUQueue?.prototype;
  timed(D, "createComputePipeline", "cp");
  timed(D, "createRenderPipeline", "rp");
  if (D && typeof D.createRenderPipeline === "function") {
    const o = D.createRenderPipeline;
    D.createRenderPipeline = function (...a) {
      let label = "S:" + (a[0]?.label ?? "?");
      // GISystem records module → WGSL in `device.__giShaderSource`; a plain
      // "NodeMaterial_N" label says nothing, so carry the fragment source's
      // size and a recognisable head (its first binding names) with it.
      try {
        const code = this.__giShaderSource?.get(a[0]?.fragment?.module);
        if (typeof code === "string") {
          const heads = [...code.matchAll(/var<[^>]*>\s*([A-Za-z_][A-Za-z0-9_]*)|@binding\(\d+\)\s*var\s+([A-Za-z_][A-Za-z0-9_]*)/g)]
            .map((m) => m[1] || m[2]).filter(Boolean).slice(0, 6).join(",");
          label += ` [${code.length}B ${heads}]`;
        }
      } catch {}
      cur.rpL.push(label);
      return o.apply(this, a);
    };
  }
  timed(D, "createShaderModule", "sm");
  timed(D, "createTexture", "ct");
  timed(D, "createBuffer", "cb", (a) => a[0]?.size);
  timed(D, "createBindGroup", "bg");
  timed(Q, "writeBuffer", "wb", (a) => a[2]?.byteLength ?? a[2]?.length ?? 0);
  timed(Q, "writeTexture", "wt", (a) => a[1]?.byteLength ?? a[1]?.length ?? 0);
  timed(Q, "copyExternalImageToTexture", "ce");
  timed(Q, "submit", "sub");
  // Per-submit GPU completion latency, labelled by the GI pass being dispatched
  // (GISystem publishes `__giCurrentComputeName` around `renderer.compute`).
  if (Q && typeof Q.submit === "function") {
    const o = Q.submit;
    Q.submit = function (...a) {
      const r = o.apply(this, a);
      const c = cur;
      const name = g.__giCurrentComputeName ?? "render/other";
      const t0 = performance.now();
      const idx = (c.subN ?? 0);
      try {
        this.onSubmittedWorkDone().then(() => {
          const ms = performance.now() - t0;
          // Keep the EARLIEST slow submits of the frame in submission order:
          // every submit queued behind a multi-second one reports the same
          // latency, so the first one over the bar is the owner.
          if (ms > 150) {
            c.subTop.push([+ms.toFixed(1), name, idx]);
            c.subTop.sort((x, y) => x[2] - y[2]);
            if (c.subTop.length > 8) c.subTop.length = 8;
          }
        }).catch(() => {});
      } catch {}
      return r;
    };
  }
  timed(g.GPUCanvasContext?.prototype, "getCurrentTexture", "gct");
  // The GPU's own clock: how long after this frame's rAF does everything
  // submitted so far finish? A multi-second compute chain shows up HERE and
  // nowhere in the wrapped calls — the main thread then blocks on the swap.
  g.__gpuDevice = null;
  if (D && typeof D.createBuffer === "function") {
    const o = D.createBuffer;
    D.createBuffer = function (...a) { g.__gpuDevice = this; return o.apply(this, a); };
  }

  if (D && typeof D.createRenderPipelineAsync === "function") {
    const o = D.createRenderPipelineAsync;
    D.createRenderPipelineAsync = function (...a) { cur.rpaN += 1; cur.rpL.push("A:" + (a[0]?.label ?? "?")); return o.apply(this, a); };
  }
  // GISystem already redirects three's SYNC createComputePipeline to this one,
  // so the sync half of THIS call is what a kernel can still cost the frame:
  // Chrome parses and validates the WGSL (Tint) before the promise is handed
  // back, and a 132 kB kernel with 220 ifs is not free to parse.
  if (D && typeof D.createComputePipelineAsync === "function") {
    const o = D.createComputePipelineAsync;
    D.createComputePipelineAsync = function (...a) {
      const t0 = performance.now();
      let p;
      try { p = o.apply(this, a); } finally { cur.cpaMs += performance.now() - t0; cur.cpaN += 1; }
      return p.finally?.(() => { cur.cpaDoneN += 1; }) ?? p;
    };
  }
  // createImageBitmap is how a decoded image reaches the GPU on the main thread.
  if (typeof g.createImageBitmap === "function") {
    const o = g.createImageBitmap;
    g.createImageBitmap = function (...a) {
      const t0 = performance.now();
      cur.ibN += 1;
      const p = o.apply(this, a);
      return p.finally?.(() => { cur.ibMs += performance.now() - t0; }) ?? p;
    };
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (g.__longtasks.length > 4000) break;
        g.__longtasks.push([Math.round(e.startTime), Math.round(e.duration),
          (e.attribution ?? []).map((a) => `${a.name}:${a.containerType ?? ""}`).join(",").slice(0, 60)]);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {}

  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    if (g.__frames.length < 40000) {
      {
        const dev = g.__gpuDevice;
        const c = cur;
        if (dev?.queue?.onSubmittedWorkDone) {
          const t0 = performance.now();
          dev.queue.onSubmittedWorkDone().then(() => { c.gpuDoneMs = +(performance.now() - t0).toFixed(1); }).catch(() => {});
        }
      }
      g.__frames.push([Math.round(now), +(now - last).toFixed(1), cur,
        performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0]);
    }
    cur = C();
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Fold a CDP profile into "hottest self-time stack in [t0,t1]" (ms, page clock). */
function hottestIn(profile, alignUs, t0, t1) {
  if (!profile?.samples?.length) return null;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map();
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] ?? 0;
    const ms = (t - alignUs) / 1000;
    if (ms < t0 || ms > t1) continue;
    const id = profile.samples[i];
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.map(([id, msSelf]) => {
    const n = byId.get(id);
    const f = n?.callFrame ?? {};
    let name = f.functionName || "(anonymous)";
    if (name === "(program)" || name === "(idle)" || name === "(garbage collector)") {
      // Not a JS frame — say so plainly; (program) is native/driver time.
      return { label: name, ms: msSelf, url: "" };
    }
    const p = parent.get(id);
    const pf = p ? byId.get(p)?.callFrame : null;
    if (pf?.functionName) name = `${pf.functionName} > ${name}`;
    const url = (f.url ?? "").split("/").slice(-1)[0].split("?")[0];
    return { label: name, ms: msSelf, url: `${url}:${f.lineNumber ?? ""}` };
  });
}

async function boot(n) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.HEADED ? false : "new",
    userDataDir: path.join(os.tmpdir(), "gi-boot-frames-profile"),
    args: [
      "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--js-flags=--expose-gc",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await installTauriShim(page, {});
  await page.evaluateOnNewDocument((project) => {
    globalThis.__editorKeepRendering = true;
    localStorage.setItem("engine.projectRoot.v1", project);
    localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  }, PROJECT);
  await page.evaluateOnNewDocument(installLedger);
  await page.evaluateOnNewDocument((flags) => {
    for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
  }, JSON.parse(process.env.FLAGS ?? "{}"));

  const lines = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/\[gi\]|compile wave|scene assets ready|SLOWEST PIPELINE/.test(t)) lines.push(t);
  });
  page.on("pageerror", (e) => console.log(`    pageerror: ${(e.stack ?? e.message ?? String(e)).slice(0, 160)}`));

  const cdp = await page.target().createCDPSession();
  if (!process.env.NO_PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  }

  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });

  // AUTO profiles the project's remembered scene from the project-open click.
  // This matters for giant scenes: opening the project and then explicitly
  // opening Bistro again overlaps two 1500-mesh loads and can crash the page.
  if (!process.env.NO_PROFILE) await cdp.send("Profiler.start");
  const alignNow = await page.evaluate(() => performance.now());
  if (AUTO) await page.evaluate(() => { globalThis.__bootT0 = performance.now(); });
  let tOpenNode = AUTO ? Date.now() : 0;
  await page.evaluate((project) => {
    const rows = [...document.querySelectorAll(".hub-recent")];
    const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
    row?.querySelector(".hub-recent-open-btn")?.click();
  }, PROJECT);
  await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

  const call = async (op, args = {}) => page.evaluate(async ({ op, args }) => {
    try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
    catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
  }, { op, args }).catch((err) => ({ ok: false, error: err?.message ?? String(err) }));

  // __bootT0 is stamped INSIDE the page, immediately before the open call: the
  // frames ledger and every `@ms` below are page-clock, and a node-side stamp
  // would carry the CDP crossing.
  let open = { ok: true };
  if (!AUTO) {
    tOpenNode = Date.now();
    open = await page.evaluate(async (project, scene) => {
      globalThis.__bootT0 = performance.now();
      try { return { ok: true, value: await globalThis.__editorApi.call("scene.open", { path: `${project}/scenes/${scene}.scene` }) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, PROJECT, SCENE);
  }
  if (!open?.ok) console.log(`    scene.open failed: ${open?.error}`);

  // "Scene is lit" is read from the `lines` buffer the console listener has
  // filled since before the open call — no second listener, no race with a
  // marker that can print the moment scene.open resolves.
  // TWO markers (2026-09-02). `first diffuse gather dispatched` is the scene
  // being LIT — the SRC gather ran unskipped. `field first pass dispatched`
  // is the FULL consumer set landing, and the last of it is the exact-
  // reflection kernels' driver compile (17–25 s on the Level); every boot
  // number before this date used the full marker and so measured that
  // compile, not the light. The wall clock stops at the full marker so both
  // are read from one boot.
  const litDiffuse = () => lines.some((t) => /first diffuse gather dispatched/.test(t));
  const lit = () => lines.some((t) => /field first pass dispatched|field ready:/.test(t));

  // Node-clock wall time from open to the lit marker. ±1 poll interval coarse
  // and skewed by CDP delivery, but the SAME bias applies before and after a
  // change, so deltas are honest.
  const deadline = Date.now() + WAIT_MS;
  let done = false;
  let litDiffuseWallMs = null;
  while (Date.now() < deadline) {
    if (litDiffuseWallMs == null && litDiffuse()) litDiffuseWallMs = Date.now() - tOpenNode;
    done = lit();
    if (done) break;
    await wait(250);
  }
  const litWallMs = done ? Date.now() - tOpenNode : null;
  await wait(2500);

  let profile = null, alignUs = 0;
  if (!process.env.NO_PROFILE) {
    const res = await cdp.send("Profiler.stop");
    profile = res.profile;
    // profile.startTime is the microsecond stamp of Profiler.start; alignNow is
    // the page-clock ms read immediately after it.
    alignUs = profile.startTime - alignNow * 1000;
  }

  const out = await page.evaluate(() => ({
    frames: globalThis.__frames ?? [],
    longtasks: globalThis.__longtasks ?? [],
    bootT0: globalThis.__bootT0 ?? 0,
  }));
  // The material wave's driver bill is the SIZE of the programs it asked for,
  // so census three's program cache before the page goes away.
  let programs = null;
  try {
    programs = await page.evaluate(async () => {
      const api = globalThis.__editorApi;
      let eng = globalThis.__eng;
      if (!eng && api?.entities?.live) {
        try {
          const scene = await api.call("scene.get");
          eng = api.entities.live(scene.rootIds?.[0])?.engine;
        } catch {}
      }
      const pl = eng?.renderer?._pipelines;
      if (!pl) return null;
      const frag = [...pl.programs.fragment.keys()].map((c) => c.length).sort((a, b) => b - a);
      const vert = [...pl.programs.vertex.keys()].map((c) => c.length);
      const total = frag.reduce((a, b) => a + b, 0);
      return {
        fragCount: frag.length, fragTotalKB: Math.round(total / 1024),
        fragTop: frag.slice(0, 8).map((n) => Math.round(n / 1024)),
        vertCount: vert.length, vertKB: Math.round(vert.reduce((a, b) => a + b, 0) / 1024),
        pipelines: pl.caches.size,
      };
    });
  } catch {}
  await browser.close();
  return { ...out, profile, alignUs, lines, lit: done, litWallMs, litDiffuseWallMs, boot: n, programs };
}

const summary = [];
for (let i = 1; i <= BOOTS; i++) {
  console.log(`\n${"═".repeat(96)}\n  ${SCENE} — boot ${i}/${BOOTS}\n${"═".repeat(96)}`);
  const r = await boot(i);
  const t0 = r.bootT0;

  // Each row's gap to the NEXT row is that frame's dt (the ledger samples at
  // rAF), so a "slow frame" is a row whose gap to its successor exceeds the
  // threshold. Rows before scene open are excluded.
  const slowFrames = r.frames
    .map((f, i) => [f, (r.frames[i + 1]?.[0] ?? f[0] + 16.7) - f[0]])
    .filter(([[t], dt]) => t >= t0 && dt > SLOW_MS)
    .map(([f, dt]) => [f[0], dt, f[2], f[3]]);
  const total = r.frames.filter(([t]) => t >= t0).length;
  const spent = slowFrames.reduce((a, [, dt]) => a + dt, 0);
  const firstLitAt = r.lit ? "marker seen" : "TIMEOUT";
  console.log(`\n  DIFFUSE LIT (gather ran) at ~${r.litDiffuseWallMs ?? "?"} ms after scene.open · full marker (every consumer kernel landed): ${firstLitAt} at ~${r.litWallMs ?? "?"} ms after scene.open · scene open at page t+${Math.round(t0)} · ${total} frames logged after open`);
  console.log(`  frames > ${SLOW_MS} ms after open: ${slowFrames.length}  (${Math.round(spent)} ms of stall)`);

  const top = [...slowFrames].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOPN ?? 6));
  console.log(`\n  TOP FRAMES — each row is ONE frame; ms are SYNCHRONOUS time inside it`);
  console.log(`  ${"@ms".padStart(7)} ${"dt".padStart(7)} │ ${"cPipe".padStart(11)} ${"rPipe".padStart(11)} ` +
    `${"cPipeAsync".padStart(12)} ${"tex+buf".padStart(11)} ${"upload".padStart(13)} ${"submit".padStart(9)} ${"heapΔ".padStart(7)}`);
  for (const [tAbs, dt, c, heap] of top) {
    const idx = r.frames.findIndex((f) => f[0] === tAbs);
    const prevHeap = idx > 0 ? r.frames[idx - 1][3] : heap;
    const alloc = c.ctMs + c.cbMs, allocN = c.ctN + c.cbN;
    const upMs = c.wbMs + c.wtMs + c.ceMs, upB = c.wbB + c.wtB;
    console.log(`  ${String(Math.round(tAbs - t0)).padStart(7)} ${fmt(dt).padStart(7)} │ ` +
      `${(c.cpN + "×" + fmt(c.cpMs)).padStart(11)} ${(c.rpN + "×" + fmt(c.rpMs)).padStart(11)} ` +
      `${(c.cpaN + "×" + fmt(c.cpaMs) + "✓" + c.cpaDoneN).padStart(12)} ${(allocN + "×" + fmt(alloc)).padStart(11)} ` +
      `${((c.wbN + c.wtN + c.ceN) + "×" + fmt(upMs) + "/" + mb(upB) + "M").padStart(13)} ` +
      `${(c.subN + "×" + fmt(c.subMs)).padStart(9)} ${((heap - prevHeap >= 0 ? "+" : "") + (heap - prevHeap)).padStart(7)}`);
    const acc = c.cpMs + c.cpaMs + c.rpMs + c.smMs + alloc + upMs + c.subMs + c.bgMs;
    const hot = r.profile ? hottestIn(r.profile, r.alignUs, tAbs - dt, tAbs) : null;
    const lt = r.longtasks.find(([s, d]) => s >= tAbs - dt - 5 && s <= tAbs + 5 && d > dt * 0.5);
    console.log(`          webgpu accounts for ${fmt(acc)} of ${fmt(dt)} ms (${fmt(100 * acc / dt)}%) · getCurrentTexture ${c.gctN ?? 0}×${fmt(c.gctMs ?? 0)} ms · GPU done ${c.gpuDoneMs >= 0 ? fmt(c.gpuDoneMs) + ' ms after rAF' : 'n/a'}` +
      (lt ? ` · longtask ${lt[1]} ms ${lt[2]}` : ""));
    if (hot) for (const h of hot) console.log(`            ${fmt(h.ms, 1).padStart(7)} ms  ${h.label}  ${h.url}`);
    if (Array.isArray(c.subTop) && c.subTop.length) {
      console.log(`            first slow submits, in submission order (GPU completion after submit): ${c.subTop.map(([ms, n, i]) => `#${i} ${n || "(unnamed gi)"} ${ms} ms`).join(" · ")}`);
    }
    // `onSubmittedWorkDone` covers everything queued BEFORE the submit too, so
    // the owner of a stall is usually the last heavy submit of the PREVIOUS
    // frame (whose own rAF gap stayed short: the stall lands on the next one).
    if (idx > 0) {
      const pc = r.frames[idx - 1][2];
      if (Array.isArray(pc?.subTop) && pc.subTop.length) {
        console.log(`            previous frame's slow submits: ${pc.subTop.map(([ms, n, i]) => `#${i} ${n || "(unnamed gi)"} ${ms} ms`).join(" · ")} (of ${pc.subN} submits)`);
      }
    }
    if (process.env.RP_LABELS === "1" && Array.isArray(c.rpL) && c.rpL.length) {
      const tally = new Map();
      for (const l of c.rpL) tally.set(l, (tally.get(l) ?? 0) + 1);
      const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
      console.log(`            render pipelines created in this frame (${c.rpL.length}; S=sync A=async):`);
      for (const [l, n] of rows) console.log(`              ${String(n).padStart(3)}× ${l}`);
    }
  }

  // Roll the whole boot up, so a cost paid in 200 small frames is not invisible.
  const sum = r.frames.reduce((a, [, , c]) => {
    for (const k of Object.keys(c)) { if (k === "rpL" || k === "gpuDoneMs" || k === "subTop") continue; a[k] = (a[k] ?? 0) + c[k]; }
    return a;
  }, {});
  console.log(`\n  WHOLE BOOT (page open → now, not just the lit window)`);
  if (r.programs) {
    const p = r.programs;
    console.log(`    fragment programs      ${String(p.fragCount).padStart(5)}  ${String(p.fragTotalKB).padStart(7)} kB WGSL (largest ${p.fragTop.join("/")} kB) · vertex ${p.vertCount} / ${p.vertKB} kB · render pipelines cached ${p.pipelines}`);
  }
  console.log(`    createComputePipeline   ${String(sum.cpN).padStart(5)} calls  ${fmt(sum.cpMs).padStart(7)} ms  ← three has NO async variant`);
  console.log(`    createComputePipelineAsync ${String(sum.cpaN).padStart(2)} calls  ${fmt(sum.cpaMs).padStart(7)} ms SYNC (Tint parse), ${sum.cpaDoneN} resolved`);
  console.log(`    createRenderPipeline    ${String(sum.rpN).padStart(5)} calls  ${fmt(sum.rpMs).padStart(7)} ms  (+${sum.rpaN} async)`);
  console.log(`    createShaderModule      ${String(sum.smN).padStart(5)} calls  ${fmt(sum.smMs).padStart(7)} ms`);
  console.log(`    createTexture/Buffer    ${String(sum.ctN + sum.cbN).padStart(5)} calls  ${fmt(sum.ctMs + sum.cbMs).padStart(7)} ms  ${mb(sum.cbB)} MB buffers`);
  console.log(`    writeBuffer/Texture     ${String(sum.wbN + sum.wtN).padStart(5)} calls  ${fmt(sum.wbMs + sum.wtMs).padStart(7)} ms  ${mb(sum.wbB + sum.wtB)} MB`);
  console.log(`    copyExternalImage       ${String(sum.ceN).padStart(5)} calls  ${fmt(sum.ceMs).padStart(7)} ms`);
  console.log(`    createImageBitmap       ${String(sum.ibN).padStart(5)} calls`);
  console.log(`    createBindGroup         ${String(sum.bgN).padStart(5)} calls  ${fmt(sum.bgMs).padStart(7)} ms`);
  console.log(`    queue.submit            ${String(sum.subN).padStart(5)} calls  ${fmt(sum.subMs).padStart(7)} ms`);

  if (r.profile) {
    const bootEnd = r.frames.at(-1)?.[0] ?? 0;
    const hot = hottestIn(r.profile, r.alignUs, t0, bootEnd) ?? [];
    console.log(`\n  HOTTEST SINCE SCENE OPEN (self time)`);
    for (const h of hot) console.log(`    ${fmt(h.ms).padStart(7)} ms  ${h.label}  ${h.url}`);
  }
  for (const l of r.lines.slice(0, Number(process.env.MAX_LINES ?? 30))) console.log(`    · ${l.slice(0, 150)}`);
  summary.push({ boot: i, lit: r.lit, litWall: r.litWallMs, litDiffuse: r.litDiffuseWallMs, slow: slowFrames.length, worst: top[0]?.[1], stall: spent });
}

console.log(`\n${"═".repeat(96)}`);
for (const s of summary) console.log(`  boot ${s.boot}: lit ${s.lit ? "yes" : "TIMEOUT"} · ${s.litWall == null ? "?" : `${Math.round(s.litWall)} ms to lit`} · ${s.slow} slow frames · worst ${fmt(s.worst)} ms · ${Math.round(s.stall ?? 0)} ms stalled`);
console.log(`${"═".repeat(96)}\n`);
