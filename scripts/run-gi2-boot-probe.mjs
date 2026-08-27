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
  // The live GI2 system, wherever GISystem happens to keep it. TWO different
  // accessors were already in use in this file (`_gi2` for the gather,
  // `state.screen.gi2` for the trace); one helper, so a receipt cannot
  // silently read `undefined` and report a null as a measurement.
  globalThis.__gi2 = () => {
    const sys = mod.engine?.modules?.get?.("gi")?.system;
    return sys?._gi2 ?? sys?.state?.screen?.gi2 ?? null;
  };
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

/** Wait until the gather has advanced `n` frames (or `capMs`, whichever first). */
const gatherFrame = () => page.evaluate(() => globalThis.__gi2()?.gather?.frame ?? 0);
const settleFrames = async (n, capMs = 90000) => {
  const f0 = await gatherFrame();
  const deadline = Date.now() + capMs;
  let f = f0;
  while (f - f0 < n && Date.now() < deadline) { await wait(400); f = await gatherFrame(); }
  return f - f0;
};

// == §19 STAGE 3.7 P.5 — THE THREE BISTRO POSES, DERIVED FROM THE SCENE =======
//
// ⭐ A CAMERA POSE CANNOT BE READ OFF A SCREENSHOT — BUT WHAT THE SCREENSHOTS
// ARE OF IS IN THE SCENE. The user's three views are the café façade in shade,
// the doors under the awning close up, and a wide shot down the street. All
// three are anchored on one object the scene names — the bistro's own front
// banner — and on one direction, which is where the street runs; and the
// street's direction is a fact about the WORLD, which the window can be asked
// with rays rather than a number to be guessed at.
//
// ⚠ `staticMerging` EATS THE MESH NAMES, so the lookup goes through the ENTITY
// graph (`entity.list` / `entity.getBounds`), which survives merging. A
// traverse of `engine.scene` on this project finds 189 objects all called
// `Merged(N)` and no banner at all.
async function bistroPoses() {
  const bounds = async (needle) => {
    const list = (await call("entity.list", { nameContains: needle })).value ?? [];
    let agg = null;
    for (const e of list.slice(0, 24)) {
      const b = (await call("entity.getBounds", { id: e.id })).value;
      if (!b || b.empty) continue;
      agg ??= { min: [...b.min], max: [...b.max] };
      for (let i = 0; i < 3; i++) {
        agg.min[i] = Math.min(agg.min[i], b.min[i]);
        agg.max[i] = Math.max(agg.max[i], b.max[i]);
      }
    }
    return agg;
  };
  const banner = await bounds("FrontBanner");
  if (!banner) return null;
  const street = await bounds("Paris_Street_");
  const B = banner.min.map((v, i) => (v + banner.max[i]) / 2);
  const ground = street ? street.max[1] : banner.min[1] - 3.4;
  const eye = ground + 1.65;
  // The open direction, asked of the window: park ON the banner's own ground
  // point (the window is camera-centred, so it has to be filled AROUND the
  // question before the question is asked), fire a horizontal ring, and take
  // the direction that runs furthest without hitting anything. That is the
  // street, and it is the axis all three poses are laid out along.
  await call("viewport.setCamera", { position: [B[0], eye, B[2]], target: [B[0] + 4, eye, B[2]] });
  await settleFrames(90, 20000);
  const ring = await page.evaluate(async ({ o }) => {
    const eng = globalThis.__giEngineForProbe;
    const gi2 = globalThis.__gi2();
    if (!gi2?.trace || !eng?.renderer) return null;
    const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
    const shoot = createGi2RayShooter(gi2, eng.renderer);
    const dirs = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      dirs.push([Math.cos(a), 0, Math.sin(a)]);
    }
    const out = await shoot(dirs.map((d) => ({ o, d, tMax: 30 })));
    return dirs.map((d, i) => ({ d, t: out[i].hit ? out[i].t : 30 }));
  }, { o: [B[0], eye, B[2]] });
  if (!ring) return null;
  const best = ring.reduce((a, b) => (b.t > a.t ? b : a));
  const D = best.d;
  const at = (k, y) => [B[0] + D[0] * k, y, B[2] + D[2] * k];
  return {
    banner: B.map((v) => +v.toFixed(2)), ground: +ground.toFixed(2),
    dir: D.map((v) => +v.toFixed(2)), openRun: +best.t.toFixed(1),
    list: [
      { name: "facade-wide", position: at(6.0, eye), target: [B[0], ground + 2.2, B[2]] },
      { name: "doors-close", position: at(2.2, eye), target: [B[0], ground + 1.6, B[2]] },
      { name: "street-overview", position: at(22.0, ground + 4), target: at(2.0, ground + 3) },
    ],
  };
}

/**
 * §P.5's "dirty" number, on one pose.
 *
 * ⭐⭐ THE 3.6 SPATIAL RECEIPT IS A FIVE-PIXEL BOX AND THE USER'S COMPLAINT IS A
 * ONE-METRE BLOTCH. A 5×5 screen box at 6 m is about 4 cm of wall; a filter
 * that narrow passes a 1 m blotch straight through unchanged, which is exactly
 * how every 3.6 receipt came back green on a frame the user called "very
 * dirty". So the statistic here is a BAND-PASS at the world scale of the
 * complaint: the pixel's neighbourhood mean at a ONE-METRE radius minus its
 * mean at FOUR, both radii PROJECTED from the pixel's own depth so that a metre
 * is a metre at 2 m and at 40. What survives is variation on the 1-4 m scale —
 * the blotches — with the scene's own shading gradient (which lives at 4 m and
 * above) subtracted rather than argued about.
 *
 * The radii vary per pixel, so the box means come out of a SUMMED-AREA TABLE:
 * an O(1) query at any radius, over ~400 k pixels, in one pass.
 *
 * ⚠ AND THE MASK IS THE GEOMETRY, NOT A RECTANGLE. "The façade" is every
 * VERTICAL surface (|n·y| < 0.4) and "the pavement" every UP-FACING one
 * (n·y > 0.8). A screen-space crop would have to be re-authored for every pose
 * and would silently swallow the sky, the awning and the street furniture.
 */
async function dirtyReceipt(pose, frames = 220) {
  await call("viewport.setCamera", { position: pose.position, target: pose.target });
  const ran = await settleFrames(frames);
  const out = await page.evaluate(async () => {
    const eng = globalThis.__giEngineForProbe;
    const g = globalThis.__gi2()?.gather;
    const r = eng?.renderer;
    if (!g?.passes?.noiseDump || !g.buffers?.dirtyBuf) {
      return { error: "the noise kernel was not built (set __gi2NoiseDump before the GI build)" };
    }
    // An instrument's first sample is not a sample — see the temporal receipt.
    for (let k = 0; k < 3; k++) {
      await new Promise((res) => requestAnimationFrame(() => res()));
      await r.computeAsync(g.passes.noiseDump);
    }
    const noise = new Float32Array(await r.getArrayBufferAsync(g.buffers.noiseBuf.value));
    const geo = new Float32Array(await r.getArrayBufferAsync(g.buffers.dirtyBuf.value));
    const d = g.describe();
    const W = d.halfW; const H = d.halfH;
    const projScale = g.uniforms.projScale.value;
    // ⭐⭐ ONE SUMMED-AREA TABLE PER SURFACE CLASS, NOT ONE PER FRAME.
    //
    // The first cut built a single SAT over every valid pixel and took a
    // façade pixel's 4 m box out of it — so the box averaged the façade
    // TOGETHER WITH the street receding behind it to forty metres, and the
    // "band" it produced was mostly the perspective gradient down the road.
    // The control caught it: the same statistic over the FLAT street came back
    // 20-45 %, indistinguishable from the façade's, on geometry that has no 1 m
    // features at all. A façade pixel's neighbourhood is the FAÇADE.
    const NP = (W + 1) * (H + 1);
    const mk = () => ({ S: new Float64Array(NP), C: new Float64Array(NP), D: new Float64Array(NP), D2: new Float64Array(NP) });
    const T = [mk(), mk()]; // 0 = façade (vertical), 1 = pavement (up-facing)
    const cls = new Int8Array(W * H).fill(-1);
    for (let y = 0; y < H; y++) {
      const acc = [{ s: 0, c: 0, d: 0, d2: 0 }, { s: 0, c: 0, d: 0, d2: 0 }];
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let k = -1;
        if (noise[i * 4 + 3] > 0.5) {
          const ny = geo[i * 4 + 1];
          if (Math.abs(ny) <= 0.4) k = 0; else if (ny > 0.8) k = 1;
        }
        cls[i] = k;
        if (k >= 0) {
          const a = acc[k];
          a.s += noise[i * 4]; a.c += 1; a.d += geo[i * 4]; a.d2 += geo[i * 4] * geo[i * 4];
        }
        for (let t = 0; t < 2; t++) {
          const A = T[t]; const a = acc[t];
          A.S[(y + 1) * (W + 1) + x + 1] = A.S[y * (W + 1) + x + 1] + a.s;
          A.C[(y + 1) * (W + 1) + x + 1] = A.C[y * (W + 1) + x + 1] + a.c;
          A.D[(y + 1) * (W + 1) + x + 1] = A.D[y * (W + 1) + x + 1] + a.d;
          A.D2[(y + 1) * (W + 1) + x + 1] = A.D2[y * (W + 1) + x + 1] + a.d2;
        }
      }
    }
    const win = (A, x0, y0, x1, y1) => A[(y1 + 1) * (W + 1) + x1 + 1] - A[y0 * (W + 1) + x1 + 1]
      - A[(y1 + 1) * (W + 1) + x0] + A[y0 * (W + 1) + x0];
    const boxMean = (t, x, y, rad) => {
      const A = T[t];
      const x0 = Math.max(0, x - rad); const x1 = Math.min(W - 1, x + rad);
      const y0 = Math.max(0, y - rad); const y1 = Math.min(H - 1, y + rad);
      const c = win(A.C, x0, y0, x1, y1);
      if (!(c > 0)) return null;
      // ⚠ AND THE BOX REPORTS ITS OWN DEPTH SPREAD. A screen box is a world box
      // only on a surface that faces the camera; at a few degrees off grazing a
      // 4 m-wide screen box still spans thirty metres of street. The caller
      // drops the PIXEL where that is true — not a bilateral weight (the box's
      // contents stay unweighted, so a blotch that follows the surface's own
      // plane is as visible as ever, which is `noiseDump`'s own warning), just
      // a refusal to speak where the geometry makes the question meaningless.
      const dm = win(A.D, x0, y0, x1, y1) / c;
      const dv = Math.max(0, win(A.D2, x0, y0, x1, y1) / c - dm * dm);
      return { m: win(A.S, x0, y0, x1, y1) / c, c, dm, dsd: Math.sqrt(dv) };
    };
    const band = []; const pband = []; const facL = []; const pavL = [];
    let grazing = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const k = cls[i];
        if (k < 0) continue;
        const L = noise[i * 4];
        (k === 0 ? facL : pavL).push(L);
        const pixWorld = geo[i * 4] / projScale; // metres per FULL-res pixel
        if (!(pixWorld > 0)) continue;
        const r1 = Math.round(0.5 / pixWorld); // 1 m, in HALF-res pixels
        const r4 = Math.round(2.0 / pixWorld);
        if (r1 < 2 || r4 <= r1 || r4 > 240) continue;
        const a = boxMean(k, x, y, r1); const b = boxMean(k, x, y, r4);
        if (!a || !b || a.c < 9 || b.c < 25) continue;
        if (b.dsd > 0.35 * b.dm) { grazing++; continue; }
        (k === 0 ? band : pband).push(a.m - b.m);
      }
    }
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const pct = (a, q) => {
      if (!a.length) return null;
      const v = [...a].sort((x, y) => x - y);
      return v[Math.min(v.length - 1, Math.floor(q * v.length))];
    };
    const sdOf = (a) => {
      const m = avg(a);
      return Math.sqrt(Math.max(0, avg(a.map((b) => b * b)) - m * m));
    };
    const mF = avg(facL);
    const mP = avg(pavL);
    const sun = pct(pavL, 0.75) ?? 0;
    return {
      facadePx: facL.length, pavementPx: pavL.length,
      bandPx: band.length, pbandPx: pband.length, grazingDropped: grazing,
      facadeMean: mF, pavementMean: mP, pavementP75: sun,
      dirtPct: (100 * sdOf(band)) / Math.max(1e-9, mF),
      bandP95Pct: (100 * (pct(band.map(Math.abs), 0.95) ?? 0)) / Math.max(1e-9, mF),
      flatPct: (100 * sdOf(pband)) / Math.max(1e-9, mP),
      ratioPct: (100 * mF) / Math.max(1e-9, sun),
    };
  });
  return { ran, ...out };
}

/**
 * §P.1's verification, and the number the whole stage is judged on: the SPREAD
 * of the radiance cache ACROSS the 64 voxel faces of one brick on a flat wall.
 *
 * ⭐⭐ THE DIRT IS IN THE CACHE, AND THIS IS WHERE IT IS VISIBLE. A brick is 1 m
 * at `v0 = 0.25`, which is the scale of the blotches; its 64 voxels on one flat
 * façade all see nearly the same hemisphere, so their stored radiances should
 * agree to a few percent. Anything else is the estimator, not the scene — and
 * before §P.1 they disagreed by more than their own mean.
 *
 * The bricks are found by RAYS through the live window rather than by world
 * arithmetic, so the level, the voxel index and the face are the same ones a
 * gather ray would address; a CPU re-derivation of the toroidal index is
 * exactly the kind of second implementation that drifts.
 */
async function facadeBrickSpread(pose) {
  await call("viewport.setCamera", { position: pose.position, target: pose.target });
  return page.evaluate(async ({ pose }) => {
    const rc = await import("/src/modules/gi/window/radianceCache.js");
    const eng = globalThis.__giEngineForProbe;
    const gi2 = globalThis.__gi2();
    if (!gi2?.cache) return { error: "no gi2 cache" };
    const { createGi2RayShooter } = await import("/scripts/lib/gi2RayProbe.js");
    const shoot = createGi2RayShooter(gi2, eng.renderer);
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const nz = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const fwd = nz(sub(pose.target, pose.position));
    const right = nz(cross(fwd, [0, 1, 0]));
    const up = nz(cross(right, fwd));
    const rays = [];
    for (let i = -3; i <= 3; i++) {
      for (let j = -2; j <= 2; j++) {
        rays.push({
          o: pose.position,
          d: nz([
            fwd[0] + right[0] * i * 0.09 + up[0] * j * 0.09,
            fwd[1] + right[1] * i * 0.09 + up[1] * j * 0.09,
            fwd[2] + right[2] * i * 0.09 + up[2] * j * 0.09,
          ]),
          tMax: 30,
        });
      }
    }
    const hits = await shoot(rays);
    const words = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.cache.attribute));
    const off = gi2.cache.describe().offsets;
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const cvs = []; const ns = []; const means = [];
    const seen = new Set();
    let bricks = 0;
    const ws = await import("/src/modules/gi/window/windowStore.js");
    const winW = new Uint32Array(await eng.renderer.getArrayBufferAsync(gi2.win.attribute));
    const dAir = []; const dWall = []; const dOpen = []; const dBuried = []; const dOpenCls = [];
    const airFrac = []; const buriedFrac = []; const buriedRatio = []; const clsPerSlab = [];
    let allBits = 0; let fullBits = 0;
    const push = (arr, q) => { if (q) arr.push(q.cv); };
    for (const h of hits) {
      if (!h.hit || h.level !== 0) continue;
      const face = h.faceId;
      if (face === 2 || face === 3) continue; // a façade is VERTICAL
      const vi = h.voxelIdx;
      const cx = vi & 63; const cy = (vi >> 6) & 63; const cz = (vi >> 12) & 63;
      const b = (cx >> 2) | ((cy >> 2) << 4) | ((cz >> 2) << 8);
      const key = b + ":" + face;
      if (seen.has(key)) continue;
      seen.add(key);
      const m = words[off.MAP_OFF + b];
      if (!m) continue;
      const slot = m - 1;
      // ⭐ THE BRICK'S OWN SLAB, NOT ALL 64 VOXELS. A brick is 4×4×4; a wall
      // passing through it occupies ONE 4×4 layer of that cube and the other
      // 48 voxels are air, interior, or a different surface entirely. Scoring
      // the spread over all 64 mixes "two neighbouring patches of one wall
      // disagree" — which is the dirt — with "a wall and the air beside it
      // disagree", which is not a defect. The layer is picked by the FACE: an
      // ±X face means the wall lies at a fixed x inside the brick, so the
      // comparable set is the 16 voxels that share the hit's own `cx & 3`.
      const axis = face >> 1; // 0 = ±X, 1 = ±Y, 2 = ±Z
      const key3 = [cx & 3, cy & 3, cz & 3][axis];
      const vals = []; const counts = [];
      // ⭐⭐ §19 STAGE 3.8's DECOMPOSITION — the same 16 voxels, split by the
      // three things that can differ between two patches of one wall: the
      // PALETTE CLASS (a second material inside the brick), the OCCUPANCY of
      // the cell the face's own shade point falls in (a face buried in the far
      // half of a two-cell-thick conservative wall shades from INSIDE the
      // wall), and whether the voxel is a wall at all. Whatever the spread
      // SURVIVES is the estimator's; the rest is the scene's, or the
      // addressing's.
      const rows = [];
      const occAt = (x, y, z) => {
        const i = (x & 63) | ((y & 63) << 6) | ((z & 63) << 12);
        return (winW[ws.OCC_OFF + (i >> 5)] >>> (i & 31)) & 1;
      };
      const nOf = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][face];
      for (let lv = 0; lv < 64; lv++) {
        const l3 = [lv & 3, (lv >> 2) & 3, (lv >> 4) & 3];
        if (l3[axis] !== key3) continue;
        const rgb = rc.unpackRgbe(words[off.DATA_OFF + slot * 384 + lv * 6 + face]);
        const wcx = ((cx >> 2) << 2) | l3[0];
        const wcy = ((cy >> 2) << 2) | l3[1];
        const wcz = ((cz >> 2) << 2) | l3[2];
        const wvi = wcx | (wcy << 6) | (wcz << 12);
        rows.push({
          lv, rgb,
          occ: occAt(wcx, wcy, wcz),
          buried: occAt(wcx + nOf[0], wcy + nOf[1], wcz + nOf[2]),
          pal: (winW[ws.PAL_OFF + (wvi >> 2)] >>> ((wvi & 3) * 8)) & 255,
          bits: (winW[ws.FACE_OFF + (wvi >> 2)] >>> ((wvi & 3) * 8)) & 255,
        });
        if (!rgb) continue;
        vals.push(lum(rgb));
        if (gi2.cache.readCount) counts.push(gi2.cache.readCount(words, slot, lv, face));
      }
      if (vals.length < 6) continue;
      bricks++;
      const mean = vals.reduce((a, x) => a + x, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, x) => a + (x - mean) ** 2, 0) / vals.length);
      cvs.push((100 * sd) / Math.max(1e-9, mean));
      means.push(mean);
      if (counts.length) ns.push(counts.reduce((a, x) => a + x, 0) / counts.length);
      {
        const cvOf = (a) => {
          if (a.length < 5) return null;
          const m = a.reduce((x, y) => x + y, 0) / a.length;
          const v = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
          return { cv: (100 * v) / Math.max(1e-9, m), mean: m };
        };
        const L = (r) => lum(r.rgb);
        const lit = rows.filter((r) => r.rgb);
        const air = lit.filter((r) => !r.occ);
        const wall = lit.filter((r) => r.occ);
        const open = wall.filter((r) => !r.buried);
        const bur = wall.filter((r) => r.buried);
        push(dAir, cvOf(air.map(L))); push(dWall, cvOf(wall.map(L)));
        push(dOpen, cvOf(open.map(L))); push(dBuried, cvOf(bur.map(L)));
        if (lit.length) airFrac.push(air.length / lit.length);
        if (wall.length) buriedFrac.push(bur.length / wall.length);
        const so = cvOf(open.map(L)); const sb = cvOf(bur.map(L));
        if (so && sb) buriedRatio.push(sb.mean / Math.max(1e-9, so.mean));
        const byCls = new Map();
        for (const r of open) { if (!byCls.has(r.pal)) byCls.set(r.pal, []); byCls.get(r.pal).push(L(r)); }
        const big = [...byCls.values()].sort((a, b) => b.length - a.length)[0] ?? [];
        push(dOpenCls, cvOf(big));
        clsPerSlab.push(new Set(wall.map((r) => r.pal)).size);
        // ⚠ MASK WITH 63. §19 Stage 3.9 put the voxel's dominant AXIS in bits
        // 6-7 of this same byte, so the bare `=== 63` that measured Bistro's
        // 95 % all-six share reads 0 % the moment an axis is written — a
        // receipt that changes meaning without changing text.
        for (const r of wall) { allBits++; if ((r.bits & 63) === 63) fullBits++; }
      }
    }
    const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    return {
      bricks, cvMedian: med(cvs), cvMin: cvs.length ? Math.min(...cvs) : null,
      cvMax: cvs.length ? Math.max(...cvs) : null, samplesMedian: med(ns),
      // ⭐⭐ A σ/mean OF 0 IS EITHER A PERFECT SURFACE OR AN EMPTY ONE, and this
      // gate has already reported the second as a PASS: a run whose façade
      // slabs read all-zero printed "cache spread 0.0 % PASS" with 9.2 samples
      // per face and a DIRT receipt that said ⚠ BLIND in the line above it. A
      // coefficient of variation divides the spread away along with the signal,
      // so the gate has to see the MEAN too — [[probe-blind-statistics]]: before
      // believing a null, ask whether the instrument could see its subject.
      cvMeanMedian: med(means),
      dAir: med(dAir), dWall: med(dWall), dOpen: med(dOpen), dBuried: med(dBuried),
      dOpenCls: med(dOpenCls), airFrac: med(airFrac), buriedFrac: med(buriedFrac),
      buriedRatio: med(buriedRatio), clsPerSlab: med(clsPerSlab),
      fullBitsPct: allBits ? (100 * fullBits) / allBits : null,
      nOpen: dOpen.length, nBuried: dBuried.length, nOpenCls: dOpenCls.length,
    };
  }, { pose });
}

/**
 * §P.3's motion receipt: the temporal noise DURING a 90° orbit.
 *
 * ⭐ A PER-PIXEL σ OVER AN ORBIT IS MOSTLY PARALLAX, so this compares
 * CONSECUTIVE frames and only at pixels whose SURFACE did not change under them
 * — same view depth to 1 %, same normal-Y to 0.02, same world height to 5 cm.
 * What is left is the ESTIMATOR moving under a moving camera, which is the
 * thing the user called "very noisy on movement"; everything the scene itself
 * did between the two frames is excluded by construction rather than argued
 * about afterwards.
 */
async function orbitNoise(pose, frames = 60) {
  await call("viewport.setCamera", { position: pose.position, target: pose.target });
  await settleFrames(120);
  return page.evaluate(async ({ pose, frames }) => {
    const eng = globalThis.__giEngineForProbe;
    const g = globalThis.__gi2()?.gather;
    const r = eng?.renderer;
    if (!g?.passes?.noiseDump || !g.buffers?.dirtyBuf) return { error: "no noise kernel" };
    const T = pose.target; const P = pose.position;
    const rad = Math.hypot(P[0] - T[0], P[2] - T[2]);
    const th0 = Math.atan2(P[2] - T[2], P[0] - T[0]);
    const BINS = 2048; const LO = 1e-5; const HI = 100; const K = Math.log(HI / LO);
    const h = { b: new Float64Array(BINS), n: 0 };
    const add = (v) => {
      const t = Math.log(Math.min(HI, Math.max(LO, v)) / LO) / K;
      h.b[Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)))]++; h.n++;
    };
    const pct = (q) => {
      if (!h.n) return null;
      let c = 0;
      for (let i = 0; i < BINS; i++) { c += h.b[i]; if (c >= (h.n * q) / 100) return LO * Math.exp(K * ((i + 0.5) / BINS)); }
      return HI;
    };
    let prevN = null; let prevG = null;
    for (let k = 0; k <= frames; k++) {
      const th = th0 + (k / frames) * (Math.PI / 2);
      await globalThis.__editorApi.call("viewport.setCamera", {
        position: [T[0] + rad * Math.cos(th), P[1], T[2] + rad * Math.sin(th)],
        target: T,
      });
      await new Promise((res) => requestAnimationFrame(() => res()));
      await new Promise((res) => requestAnimationFrame(() => res()));
      await r.computeAsync(g.passes.noiseDump);
      const n1 = new Float32Array(await r.getArrayBufferAsync(g.buffers.noiseBuf.value));
      const g1 = new Float32Array(await r.getArrayBufferAsync(g.buffers.dirtyBuf.value));
      if (prevN) {
        for (let i = 0; i < g1.length / 4; i++) {
          if (!(n1[i * 4 + 3] > 0.5) || !(prevN[i * 4 + 3] > 0.5)) continue;
          const d1 = g1[i * 4];
          if (!(d1 > 0) || Math.abs(d1 - prevG[i * 4]) > 0.01 * d1) continue;
          if (Math.abs(g1[i * 4 + 1] - prevG[i * 4 + 1]) > 0.02) continue;
          if (Math.abs(g1[i * 4 + 2] - prevG[i * 4 + 2]) > 0.05) continue;
          const a = prevN[i * 4]; const b = n1[i * 4];
          const m = (a + b) / 2;
          if (m > 0) add(Math.abs(b - a) / m);
        }
      }
      prevN = n1; prevG = g1;
    }
    return { frames, paired: h.n, p50: pct(50), p95: pct(95) };
  }, { pose, frames });
}

/**
 * ⭐ §19 STAGE 3.7's OWN BASELINE, OUT OF THE SAME BINARY (`PRE37=1`).
 *
 * The four uniforms below ARE stage 3.7: `shadeProb = 0` makes the radiance
 * cache one-shot again (a face is shaded on its first hit and never revisited),
 * `skyAtHit = 0` removes the sky term from `shadeHit`, `needRays = 0` gives
 * every probe a flat `R` rays, and `priorOn = 0` starts a fresh probe from
 * black. Set all four and this build's gather IS 3.6's.
 *
 * ⚠ AND IT MUST BE SET BEFORE THE FIRST RAY, not after first light: the cache
 * is a world accumulator, so an arm applied ten seconds in would be measuring a
 * partly-3.7 cache and calling it the baseline. So it is attempted on every
 * poll of the boot loop and latches on the first one that finds a gather —
 * which is the frame the gather is built, before it has traced anything.
 */
let armed = false;
const tryArm = async () => {
  if (armed || process.env.PRE37 !== "1") return;
  armed = await page.evaluate(() => {
    const g = globalThis.__gi2?.()?.gather;
    if (!g?.uniforms?.shadeProb) return false;
    g.uniforms.shadeProb.value = 0;
    g.uniforms.skyAtHit.value = 0;
    g.uniforms.needRays.value = 0;
    g.uniforms.priorOn.value = 0;
    return true;
  }).catch(() => false);
  if (armed) console.log("    §3.7 arm: PRE-3.7 (one-shot cache, no sky at hits, flat R, black-start probes)");
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
    await tryArm();
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
    await tryArm();
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
    // ── §19 STAGE 3.7's ALLOCATION AND ACCUMULATION, AS RATES ────────────
    //
    // Three facts a per-kernel timing cannot give: how many rays the frame
    // actually spent (the need-driven allocator's whole point is that this is
    // no longer `probes × R`), how many hits re-shaded (P.1's cost), and how
    // many probes started from a neighbour prior instead of from black.
    {
      const pv = Math.max(1, gi2.probesValid ?? 0);
      const flat = (gi2.probes ?? 0) * ((gi2.rays ?? 0) / Math.max(1, gi2.probes ?? 1));
      console.log(`  §3.7 allocation: ${gi2.probesFresh ?? "?"} fresh / ${gi2.probesFlag ?? "?"} flagged / ` +
        `${gi2.probesMature ?? "?"} mature of ${pv} valid; mature share ${gi2.matureRays ?? "?"} rays; ` +
        `${gi2.raysTraced ?? 0} rays traced against a flat-R budget of ${Math.round(flat)} ` +
        `(${(100 * (gi2.raysTraced ?? 0) / Math.max(1, flat)).toFixed(0)} %); ` +
        `${gi2.neighbourPrior ?? "?"} probes seeded from neighbours`);
      console.log(`  §3.7 accumulation: ${gi2.freshShades ?? 0} first shades + ${gi2.reShades ?? 0} re-shades ` +
        `of ${gi2.windowHits ?? 0} window hits ` +
        `(${(100 * ((gi2.freshShades ?? 0) + (gi2.reShades ?? 0)) / Math.max(1, gi2.windowHits ?? 1)).toFixed(1)} % ` +
        "— each one a sun ray, a sky ray and the slot NEE)");
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
  // ══ §19 STAGE 3.7 — THE DIRT, THE CACHE AND THE ORBIT, ON THE USER'S POSES ══
  //
  // ⚠ THIS ARM MOVES THE CAMERA AND SETTLES FOR HUNDREDS OF FRAMES, so it runs
  // AFTER every timing gate above. A pose change scrolls the window, refills
  // the voxelizer and re-places every probe; a `profile.giPasses` read taken
  // after it would be measuring a transient, and `first light` would be
  // measuring the receipt.
  if (name.toLowerCase() === "bistro" && process.env.DIRTY !== "0") {
    const poses = await bistroPoses();
    if (!poses) {
      console.log("\n  §3.7 dirty receipt: the scene names no `FrontBanner` entity — no poses derived");
    } else {
      console.log(`\n  ── §3.7 THE "DIRTY" RECEIPT (banner [${poses.banner}], ground ${poses.ground}, ` +
        `street runs [${poses.dir}] for ${poses.openRun} m) ──`);
      for (const pose of poses.list) {
        const d = await dirtyReceipt(pose);
        if (d.error) { console.log(`   ${pose.name.padEnd(16)} ${d.error}`); continue; }
        console.log(`   ${pose.name.padEnd(16)} [${pose.position.map((v) => v.toFixed(1))}] → ` +
          `[${pose.target.map((v) => v.toFixed(1))}], ${d.ran} frames`);
        // ⚠ AND IT SAYS SO WHEN IT CANNOT SEE. A depth gate that rejected every
        // pixel once printed "0.00 %" and PASSED its own budget — a blind
        // instrument reporting the best possible number. Under a thousand
        // measured pixels is not a measurement.
        const blind = d.bandPx < 1000;
        console.log(`   ${" ".repeat(16)} DIRT (1 m band ÷ façade mean) ` +
          `${blind ? "⚠ BLIND" : `${d.dirtPct.toFixed(2)} %`} ` +
          `(p95 |band| ${d.bandP95Pct.toFixed(2)} %) over ${d.bandPx} of ${d.facadePx} façade px ` +
          `(${d.grazingDropped} dropped as grazing); ` +
          `CONTROL — the same band on the FLAT street ${d.flatPct.toFixed(2)} % over ${d.pbandPx} px`);
        console.log(`   ${" ".repeat(16)} façade ${d.facadeMean.toFixed(4)} vs sunlit pavement ` +
          `${d.pavementP75.toFixed(4)} (p75 of ${d.pavementPx} up-facing px) = ` +
          `${d.ratioPct.toFixed(1)} % — a shaded wall under a clear sky wants 15-30 %`);
        if (pose.name === "facade-wide") {
          const bs = await facadeBrickSpread(pose);
          if (bs?.error) console.log(`   ${" ".repeat(16)} brick spread: ${bs.error}`);
          else {
            console.log(`   ${" ".repeat(16)} §3.8 SPLIT — air ${bs.dAir?.toFixed(0) ?? "—"} % (${(100 * bs.airFrac).toFixed(0)} % of words) · ` +
              `wall ${bs.dWall?.toFixed(0) ?? "—"} % · BURIED ${bs.dBuried?.toFixed(0) ?? "—"} % ` +
              `(${(100 * bs.buriedFrac).toFixed(0)} % of wall, ${bs.buriedRatio?.toFixed(2) ?? "—"}× open) · ` +
              `OPEN ${bs.dOpen?.toFixed(0) ?? "—"} % · OPEN+1class ${bs.dOpenCls?.toFixed(0) ?? "—"} % ` +
              `[${bs.clsPerSlab} classes/slab, ${bs.fullBitsPct?.toFixed(0)} % of wall voxels carry all 6 face bits]`);
            console.log(`   ${" ".repeat(16)} §P.1 CACHE SPREAD across the 16 voxel faces of a brick's wall slab: ` +
              `${bs.bricks} bricks, σ/mean median ${bs.cvMedian?.toFixed(1)} % ` +
              `(${bs.cvMin?.toFixed(1)}-${bs.cvMax?.toFixed(1)} %), ` +
              `median samples per face ${bs.samplesMedian?.toFixed(1) ?? "n/a"}`);
            const spreadBlind = !(bs.bricks >= 6) || !(bs.cvMeanMedian > 1e-4);
            gate(name, "cache spread over a brick", spreadBlind ? "BLIND" : +(bs.cvMedian ?? 999).toFixed(1),
              40, !spreadBlind && (bs.cvMedian ?? 999) <= 40, "%");
          }
          const orb = await orbitNoise(pose);
          if (orb?.error) console.log(`   ${" ".repeat(16)} orbit: ${orb.error}`);
          else {
            console.log(`   ${" ".repeat(16)} §P.3 ORBIT (90° over ${orb.frames} frames, ` +
              `frame-to-frame at same-surface pixels): p50 ${(100 * orb.p50).toFixed(2)} % ` +
              `p95 ${(100 * orb.p95).toFixed(2)} % over ${orb.paired} pairs`);
            gate(name, "orbit temporal p95", +(100 * orb.p95).toFixed(2), 3, 100 * orb.p95 <= 3, "%");
          }
        }
        gate(name, `dirt @ ${pose.name}`, blind ? "BLIND" : +d.dirtPct.toFixed(2), 5,
          !blind && d.dirtPct <= 5, "%");
      }
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
