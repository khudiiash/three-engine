// WHAT THE BOOT'S SLOW FRAMES ARE — §19 Stage 6.6
//
// 6.3/6.4 measured Bistro first light at 19.4 s with three frames of 1.2-2.4 s
// in the tail and ~20 frames over 50 ms per boot, and 6.3b showed that warming
// all 56 GI2/RC compute kernels off-frame does NOT remove them. So the spikes
// are not node-graph builds. This probe names the owner of each one.
//
// TWO INSTRUMENTS, because a slow frame has two possible kinds of owner and
// neither instrument can see the other's:
//
//   · THE WEBGPU LEDGER. Every GPUDevice/GPUQueue entry point that can block
//     the main thread is wrapped at document start and its SYNCHRONOUS wall
//     time is accumulated per frame: createComputePipeline (three calls this
//     one synchronously — there is no Async variant in WebGPUPipelineUtils),
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
// Usage:
//   node node_modules/vite/bin/vite.js -c vite.cut.config.mjs --port 5204 --strictPort --host 127.0.0.1
//   node scripts/run-gi2-boot-frames-probe.mjs http://127.0.0.1:5204/
//
// Env: PROJECT, SCENE (default Bistro), URL, WAIT_MS, BOOTS, FLAGS, NO_PROFILE
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? process.env.URL ?? "http://127.0.0.1:5204/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const WAIT_MS = Number(process.env.WAIT_MS ?? 45000);
const BOOTS = Number(process.env.BOOTS ?? 1);
const SLOW_MS = Number(process.env.SLOW_MS ?? 50);
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
  timed(D, "createShaderModule", "sm");
  timed(D, "createTexture", "ct");
  timed(D, "createBuffer", "cb", (a) => a[0]?.size);
  timed(D, "createBindGroup", "bg");
  timed(Q, "writeBuffer", "wb", (a) => a[2]?.byteLength ?? a[2]?.length ?? 0);
  timed(Q, "writeTexture", "wt", (a) => a[1]?.byteLength ?? a[1]?.length ?? 0);
  timed(Q, "copyExternalImageToTexture", "ce");
  timed(Q, "submit", "sub");

  if (D && typeof D.createRenderPipelineAsync === "function") {
    const o = D.createRenderPipelineAsync;
    D.createRenderPipelineAsync = function (...a) { cur.rpaN += 1; return o.apply(this, a); };
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
    if (/\[gi2\]|compile wave|scene assets ready|still COLD|SLOWEST PIPELINE/.test(t)) lines.push(t);
  });
  page.on("pageerror", (e) => console.log(`    pageerror: ${(e.stack ?? e.message ?? String(e)).slice(0, 160)}`));

  const cdp = await page.target().createCDPSession();
  if (!process.env.NO_PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  }

  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
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

  // Start the profiler and stamp the page clock in the same breath, so profile
  // microseconds and performance.now() milliseconds can be put on one axis.
  if (!process.env.NO_PROFILE) await cdp.send("Profiler.start");
  const alignNow = await page.evaluate(() => performance.now());

  await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });

  const deadline = Date.now() + WAIT_MS;
  let lit = false;
  while (Date.now() < deadline) {
    lit = await page.evaluate(() => globalThis.__gi2Stage?.marks?.firstLight != null).catch(() => false);
    if (lit) break;
    await wait(250);
  }
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
    stage: globalThis.__gi2Stage ?? null,
  }));
  await browser.close();
  return { ...out, profile, alignUs, lines, boot: n };
}

const summary = [];
for (let i = 1; i <= BOOTS; i++) {
  console.log(`\n${"═".repeat(96)}\n  ${SCENE} — boot ${i}/${BOOTS}\n${"═".repeat(96)}`);
  const r = await boot(i);
  const marks = r.stage?.marks ?? {};
  const open = r.stage?.openAt ?? 0;
  const fl = marks.firstLight;

  const slow = r.frames.filter(([, dt]) => dt > SLOW_MS);
  const total = r.frames.length;
  const spent = slow.reduce((a, [, dt]) => a + dt, 0);
  console.log(`\n  first light ${fl ?? "—"} ms from scene open · ${total} frames logged`);
  console.log(`  frames > ${SLOW_MS} ms: ${slow.length}  (${Math.round(spent)} ms of stall)`);

  const top = [...slow].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOPN ?? 6));
  console.log(`\n  TOP FRAMES — each row is ONE frame; ms are SYNCHRONOUS time inside it`);
  console.log(`  ${"@ms".padStart(7)} ${"dt".padStart(7)} │ ${"cPipe".padStart(11)} ${"rPipe".padStart(11)} ` +
    `${"cPipeAsync".padStart(12)} ${"tex+buf".padStart(11)} ${"upload".padStart(13)} ${"submit".padStart(9)} ${"heapΔ".padStart(7)}`);
  for (const [tAbs, dt, c, heap] of top) {
    const idx = r.frames.findIndex((f) => f[0] === tAbs);
    const prevHeap = idx > 0 ? r.frames[idx - 1][3] : heap;
    const alloc = c.ctMs + c.cbMs, allocN = c.ctN + c.cbN;
    const upMs = c.wbMs + c.wtMs + c.ceMs, upB = c.wbB + c.wtB;
    console.log(`  ${String(tAbs).padStart(7)} ${fmt(dt).padStart(7)} │ ` +
      `${(c.cpN + "×" + fmt(c.cpMs)).padStart(11)} ${(c.rpN + "×" + fmt(c.rpMs)).padStart(11)} ` +
      `${(c.cpaN + "×" + fmt(c.cpaMs) + "✓" + c.cpaDoneN).padStart(12)} ${(allocN + "×" + fmt(alloc)).padStart(11)} ` +
      `${((c.wbN + c.wtN + c.ceN) + "×" + fmt(upMs) + "/" + mb(upB) + "M").padStart(13)} ` +
      `${(c.subN + "×" + fmt(c.subMs)).padStart(9)} ${((heap - prevHeap >= 0 ? "+" : "") + (heap - prevHeap)).padStart(7)}`);
    const acc = c.cpMs + c.cpaMs + c.rpMs + c.smMs + alloc + upMs + c.subMs + c.bgMs;
    const hot = r.profile ? hottestIn(r.profile, r.alignUs, tAbs - dt, tAbs) : null;
    const lt = r.longtasks.find(([s, d]) => s >= tAbs - dt - 5 && s <= tAbs + 5 && d > dt * 0.5);
    console.log(`          webgpu accounts for ${fmt(acc)} of ${fmt(dt)} ms (${fmt(100 * acc / dt)}%)` +
      (lt ? ` · longtask ${lt[1]} ms ${lt[2]}` : ""));
    if (hot) for (const h of hot) console.log(`            ${fmt(h.ms, 1).padStart(7)} ms  ${h.label}  ${h.url}`);
  }

  // Roll the whole boot up, so a cost paid in 200 small frames is not invisible.
  const sum = r.frames.reduce((a, [, , c]) => {
    for (const k of Object.keys(c)) a[k] = (a[k] ?? 0) + c[k];
    return a;
  }, {});
  console.log(`\n  WHOLE BOOT`);
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
    const hot = hottestIn(r.profile, r.alignUs, 0, bootEnd) ?? [];
    console.log(`\n  HOTTEST OF THE WHOLE BOOT (self time)`);
    for (const h of hot) console.log(`    ${fmt(h.ms).padStart(7)} ms  ${h.label}  ${h.url}`);
  }
  for (const l of r.lines.slice(0, 30)) console.log(`    · ${l.slice(0, 150)}`);
  summary.push({ boot: i, fl, slow: slow.length, worst: top[0]?.[1] });
}

console.log(`\n${"═".repeat(96)}`);
for (const s of summary) console.log(`  boot ${s.boot}: first light ${s.fl} ms · ${s.slow} slow frames · worst ${fmt(s.worst)} ms`);
console.log(`${"═".repeat(96)}\n`);
