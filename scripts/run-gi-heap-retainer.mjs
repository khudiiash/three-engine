// GI HEAP RETAINER PROBE — the 2026-08-24 session-killer: 13.3 GB JS heap ->
// "WebGPU Device Lost ... Instance reference no longer exists" on the user's
// Bistro session. The 08-17 leak class (renderer caches retaining per-build
// compute nodes + material node graphs) already has an eviction path
// (releaseCompute.js, called from GISystem#dispose), so a recurrence is either
// a GAP in that sweep or a NEW class — prime suspect: material recompiles that
// happen WITHOUT a GI rebuild (R4's roughness-floor healing flips needsUpdate
// on ~102 Bistro materials; merging churn does the same), which grow
// `nodeBuilderCache` / `Pipelines.caches` / `programs.*` under fresh string
// keys with no purge in sight.
//
// Instead of a heap snapshot (a 4 GB heap snapshots to tens of GB of JSON),
// this censuses every COUNTABLE cache after each accumulation event the user's
// session actually performs:
//
//   Phase A: N forced GI rebuilds (rayHitProfiling flip — the established
//            structural poke). The 08-17 class shows here.
//   Phase B: 60 s idle. A storm/leak with no rebuild shows here.
//   Phase C: scene cycles (Level -> Bistro). A GISystem retained across scene
//            loads shows here (each cycle = one whole build leaked).
//
// Census columns: post-GC JS heap, NodeManager.nodeBuilderCache.size,
// Pipelines.caches.size, programs.vertex/fragment/compute.size, and the GPU
// object counters (buffers net of destroy + bytes, bind groups, pipelines,
// shader modules). Whichever column climbs with the heap names the retainer.
//
//   node node_modules/vite/bin/vite.js --port 5201 --strictPort   (if not up)
//   node scripts/run-gi-heap-retainer.mjs
//
// Env:
//   PROJECT=<path>   default C:/Users/Khudiiash/Documents/GAME
//   SCENE=<path>     default <project>/scenes/Bistro.scene
//   REBUILDS=5       Phase A iterations
//   CYCLES=2         Phase C iterations (0 skips)
//   IDLE=60          Phase B seconds
//   ALLOC_CENSUS=1  §I.2b: live typed-array bytes by allocation site (WeakRef)
//   HEADED=1
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5201/";
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = (process.env.SCENE ?? `${PROJECT}/scenes/Bistro.scene`).replaceAll("\\", "/");
const ALT_SCENE = `${PROJECT}/scenes/Level.scene`;
const REBUILDS = Number(process.env.REBUILDS ?? 5);
const CYCLES = Number(process.env.CYCLES ?? 2);
const IDLE = Number(process.env.IDLE ?? 60);
// §I.2b instrument: WeakRef + allocation-stack census of every typed array
// >= 2 MB. Opt-in — it proxies five global constructors.
const ALLOC_CENSUS = process.env.ALLOC_CENSUS === "1";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    // gc() in the page — heap numbers without it are allocation noise.
    "--js-flags=--expose-gc",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, {});

// Console bookkeeping: rebuild completion is detected by a NEW "[gi] built"
// line, and the dispose eviction receipts are part of the evidence.
let builtCount = 0;
let readySeen = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) builtCount++;
  if (/\[gi\] field ready/.test(t)) readySeen = true;
  if (/\[gi\] built|\[gi\] field ready|\[gi\] dispose|\[gi\] compile wave|roughness-map floors|HEAP-RET/.test(t)) {
    console.log(`  ${t.slice(0, 220)}`);
  }
});
page.on("pageerror", (e) => {
  const msg = e.stack ?? e.message ?? String(e);
  if (!/save_scene/.test(msg)) console.log(`  pageerror: ${msg.slice(0, 300)}`);
});

await page.evaluateOnNewDocument(({ PROJECT, ALLOC_CENSUS }) => {
  globalThis.__ALLOC_CENSUS__ = ALLOC_CENSUS;
  globalThis.__editorKeepRendering = true;
  globalThis.__giLogComputeRelease = true;
  localStorage.setItem("engine.projectRoot.v1", PROJECT);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([PROJECT]));
  const c = {
    buffer: 0, bufferDestroyed: 0, bufferBytes: 0, bufferBytesDestroyed: 0,
    bindGroup: 0, computePipeline: 0, renderPipeline: 0,
    texture: 0, textureDestroyed: 0, shaderModule: 0,
  };
  globalThis.__GPU_COUNTERS__ = c;
  const patch = (proto, name, fn) => {
    if (!proto || typeof proto[name] !== "function") return;
    const orig = proto[name];
    proto[name] = function (...args) { fn(args, this); return orig.apply(this, args); };
  };
  if (globalThis.GPUDevice) {
    patch(GPUDevice.prototype, "createBuffer", (a) => { c.buffer++; c.bufferBytes += a[0]?.size ?? 0; });
    patch(GPUDevice.prototype, "createBindGroup", () => c.bindGroup++);
    patch(GPUDevice.prototype, "createComputePipeline", () => c.computePipeline++);
    patch(GPUDevice.prototype, "createComputePipelineAsync", () => c.computePipeline++);
    patch(GPUDevice.prototype, "createRenderPipeline", () => c.renderPipeline++);
    patch(GPUDevice.prototype, "createRenderPipelineAsync", () => c.renderPipeline++);
    patch(GPUDevice.prototype, "createTexture", () => c.texture++);
    patch(GPUDevice.prototype, "createShaderModule", () => c.shaderModule++);
  }
  if (globalThis.GPUBuffer) {
    patch(GPUBuffer.prototype, "destroy", (a, self) => {
      c.bufferDestroyed++;
      c.bufferBytesDestroyed += self?.size ?? 0;
    });
  }
  if (globalThis.GPUTexture) patch(GPUTexture.prototype, "destroy", () => c.textureDestroyed++);

  // ── §19 STAGE 0.2b / AUDIT §I.2b — TYPED-ARRAY ALLOCATION CENSUS ────────
  //
  // OPT-IN (`ALLOC_CENSUS=1`), because it proxies four global constructors.
  //
  // WHAT IT IS FOR. After 0.2b destroys the storage buffers, the GPU half of
  // the climb is gone and the JS heap still moves. The arithmetic in §I.2b
  // predicted this: a generation is 1,853 MB of which ~750 MB is detached CPU
  // twins, leaving ~740 MB/rebuild that is neither a GPU buffer nor a renderer
  // cache. The candidates are build-time CPU transients that never become a GPU
  // buffer and may be closure-pinned — `buildStaticSceneBvhWords` (188 MB of
  // words on Bistro, and built a SECOND time when the budget ladder drops UV),
  // `voxelizeOnce`'s attribute copies, the occupancy build's pair and scratch
  // arrays, `items` in `#syncBvhScene`.
  //
  // ⭐ READING CODE WILL NOT NAME THAT CLOSURE; a WeakRef will. Every typed
  // array ≥ 2 MB is stamped with its allocation stack and held by a WeakRef,
  // so after three `gc()`s "live bytes by allocation site" says which sites are
  // still reachable and how much they hold. A transient shows up as ALLOCATED
  // but not LIVE; a leak shows up as both, growing per rebuild.
  //
  // The proxy is `construct`-only: `array.constructor` resolves through the
  // prototype to the ORIGINAL, so `new array.constructor(0)` — which is exactly
  // what `detachCpuMirror` does — never re-enters this.
  if (globalThis.__ALLOC_CENSUS__) {
    const MIN_BYTES = 2 * 1024 * 1024;
    const sites = new Map();   // stack -> { count, bytes, refs: [] }
    globalThis.__ALLOC_SITES__ = sites;
    for (const name of ["Uint32Array", "Float32Array", "Int32Array", "Uint16Array", "Uint8Array"]) {
      const Original = globalThis[name];
      if (typeof Original !== "function") continue;
      // ⚠ AND THE PROTOTYPE'S `constructor` MUST FOLLOW THE PROXY, or this
      // census silently breaks every render pipeline. three keys
      // `typedArraysToVertexFormatPrefix` (WebGPUAttributeUtils.js:12-40) on the
      // GLOBAL constructor — which is the proxy, since this runs before three
      // loads — and looks it up with `attribute.array.constructor`
      // (`_getVertexFormat`, :522), which `Reflect.construct` resolves through
      // the prototype to the ORIGINAL. The map misses, `format` is undefined,
      // and every `createRenderPipeline` throws
      // "Cannot read properties of undefined (reading '0')". Measured: the
      // first run of this census turned 234 pipelines into 6,453 and
      // invalidated its own heap column.
      const Wrapped = new Proxy(Original, {
        construct(target, args, newTarget) {
          const out = Reflect.construct(target, args, newTarget);
          try {
            if (out.byteLength >= MIN_BYTES) {
              // Frames 0-2 are this proxy and the Error itself; the caller we
              // want is the first frame outside them.
              const stack = (new Error().stack ?? "").split("\n").slice(2, 6).join(" <- ")
                .replace(/https?:\/\/[^/]+\//g, "").replace(/\?[^\s)]*/g, "");
              let site = sites.get(stack);
              if (!site) { site = { count: 0, bytes: 0, refs: [] }; sites.set(stack, site); }
              site.count++;
              site.bytes += out.byteLength;
              site.refs.push(new WeakRef(out));
            }
          } catch { /* the census must never break an allocation */ }
          return out;
        },
      });
      globalThis[name] = Wrapped;
      try {
        Object.defineProperty(Original.prototype, "constructor", {
          value: Wrapped, writable: true, configurable: true,
        });
      } catch { /* frozen prototype: the census degrades to broken pipelines */ }
    }
  }
}, { PROJECT, ALLOC_CENSUS });

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });

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

const waitForBuilt = async (sinceCount, timeoutMs) => {
  const t0 = Date.now();
  while (builtCount <= sinceCount && Date.now() - t0 < timeoutMs) await wait(1000);
  return builtCount > sinceCount;
};

const openScene = async (path, label) => {
  const before = builtCount;
  const r = await call("scene.open", { path });
  if (!r.ok) { console.log(`FATAL: scene.open ${label}: ${r.error}`); await browser.close(); process.exit(1); }
  const built = await waitForBuilt(before, 300000);
  console.log(`  ${label} open, gi built: ${built} (builds so far: ${builtCount})`);
  await wait(8000);
};

// The census. All reads are optional-chained: a three upgrade that renames a
// cache must cost a blank column, never the probe.
const census = () => page.evaluate(async () => {
  const { ensureEngine } = await import("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const renderer = engine?.renderer;
  for (let i = 0; i < 3; i++) { globalThis.gc?.(); await new Promise((r) => setTimeout(r, 150)); }
  const c = globalThis.__GPU_COUNTERS__ ?? {};
  const pip = renderer?._pipelines;
  return {
    heapMB: (performance.memory?.usedJSHeapSize ?? 0) / 1e6,
    nodeBuilderCache: renderer?._nodes?.nodeBuilderCache?.size ?? -1,
    pipeCaches: pip?.caches?.size ?? -1,
    progV: pip?.programs?.vertex?.size ?? -1,
    progF: pip?.programs?.fragment?.size ?? -1,
    progC: pip?.programs?.compute?.size ?? -1,
    buffersLive: (c.buffer ?? 0) - (c.bufferDestroyed ?? 0),
    bufferLiveMB: ((c.bufferBytes ?? 0) - (c.bufferBytesDestroyed ?? 0)) / 1e6,
    bindGroups: c.bindGroup ?? 0,
    cPipes: c.computePipeline ?? 0,
    rPipes: c.renderPipeline ?? 0,
    shaderModules: c.shaderModule ?? 0,
    texturesLive: (c.texture ?? 0) - (c.textureDestroyed ?? 0),
    // §I.3 #6 — three's OWN counters for the quantity 0.2b exists to hold
    // flat, and the plain Map that used to pin every attribute forever.
    storageAttrs: renderer?.info?.memory?.storageAttributes ?? -1,
    storageAttrMB: (renderer?.info?.memory?.storageAttributesSize ?? 0) / 1e6,
    memoryMap: renderer?.info?.memoryMap?.size ?? -1,
    // §I.2b — live typed-array bytes by allocation site, after the gc()s
    // above. `allocMB` is everything ever allocated at >= 2 MB; `liveMB` is
    // what is still reachable, which is the number that matters.
    allocSites: (() => {
      const sites = globalThis.__ALLOC_SITES__;
      if (!sites) return null;
      const out = [];
      let liveTotal = 0, allocTotal = 0;
      for (const [stack, site] of sites) {
        let live = 0, kept = 0;
        const alive = [];
        for (const ref of site.refs) {
          const arr = ref.deref();
          if (arr === undefined) continue;
          live += arr.byteLength; kept++; alive.push(ref);
        }
        site.refs = alive;                       // the census must not itself retain
        liveTotal += live; allocTotal += site.bytes;
        if (live > 0) out.push({ stack, liveMB: live / 1e6, liveCount: kept, madeMB: site.bytes / 1e6, made: site.count });
      }
      out.sort((a, b) => b.liveMB - a.liveMB);
      return { liveMB: liveTotal / 1e6, allocMB: allocTotal / 1e6, top: out.slice(0, 12) };
    })(),
  };
});

const rows = [];
const record = async (label) => {
  const s = await census();
  // §I.4's third gate line. Read through the editor op rather than the
  // renderer, because "orphan" is a SCENE question (a texture no open scene
  // references), which only the editor's asset graph can answer.
  const tex = await call("profile.textures", {});
  s.orphanMB = tex.ok
    ? (tex.value?.notReferencedByOpenScene?.mb ?? tex.value?.notReferencedByOpenScene?.bytes / 1e6 ?? -1)
    : -1;
  rows.push({ label, ...s });
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const d = (k) => prev ? (s[k] - prev[k] >= 0 ? "+" : "") + (k === "heapMB" || k === "bufferLiveMB" ? (s[k] - prev[k]).toFixed(0) : s[k] - prev[k]) : "";
  console.log(
    `HEAP-RET ${label.padEnd(14)} heap ${s.heapMB.toFixed(0).padStart(5)}MB (${d("heapMB").padStart(5)})` +
    `  nbCache ${String(s.nodeBuilderCache).padStart(4)} (${d("nodeBuilderCache")})` +
    `  pipes ${String(s.pipeCaches).padStart(4)} (${d("pipeCaches")})` +
    `  progV/F/C ${s.progV}/${s.progF}/${s.progC} (${d("progV")}/${d("progF")}/${d("progC")})` +
    `  gpuBuf ${String(s.buffersLive).padStart(4)} (${d("buffersLive")}) ${s.bufferLiveMB.toFixed(0)}MB (${d("bufferLiveMB")})` +
    `  sm ${s.shaderModules} (${d("shaderModules")})` +
    `  stAttr ${s.storageAttrs} (${d("storageAttrs")}) ${s.storageAttrMB.toFixed(0)}MB` +
    `  memMap ${s.memoryMap} (${d("memoryMap")})` +
    `  texOrphan ${s.orphanMB < 0 ? "?" : s.orphanMB.toFixed(0) + "MB"}`,
  );
  if (s.allocSites) {
    console.log(
      `           typed arrays >=2MB: live ${s.allocSites.liveMB.toFixed(0)}MB of ` +
      `${s.allocSites.allocMB.toFixed(0)}MB ever allocated`,
    );
    for (const site of s.allocSites.top) {
      console.log(`             ${site.liveMB.toFixed(0).padStart(5)}MB live x${site.liveCount} (made ${site.made}, ${site.madeMB.toFixed(0)}MB)  ${site.stack.slice(0, 190)}`);
    }
  }
};

// ---- Boot: open the target scene, settle, baseline ----
await openScene(SCENE, "bistro");
// GI ready wait: field-ready line, or 240 s.
{
  const t0 = Date.now();
  while (!readySeen && Date.now() - t0 < 240000) await wait(2000);
  console.log(`  field ready seen: ${readySeen}`);
}
await wait(10000);

// GI entity for the structural poke, from the FRESH scene.
let giEntity = null;
{
  const r = await call("entity.list", {});
  if (r.ok) giEntity = r.value.find((e) => (e.components ?? []).some((c) => c.type === "global-illumination"));
  if (!giEntity) { console.log("FATAL: no gi entity in scene"); await browser.close(); process.exit(1); }
  const props = (giEntity.components ?? []).find((c) => c.type === "global-illumination")?.props ?? {};
  console.log(`  gi props: quality=${props.quality} reflections=${props.reflections} ao=${props.ao} rayHitProfiling=${props.rayHitProfiling === true}`);
}

await record("baseline");

// ---- Phase A: forced rebuilds ----
// POKE=quality (default) flips the quality preset ultra<->high — a preset
// change is unambiguously structural. POKE=profiling is the OLD poke
// (rayHitProfiling), kept for comparison: measured 2026-08-24, it NO LONGER
// triggers a rebuild at all ("NO [gi] built within 180s" on every flip, all
// census columns +0) — a blind arm, not a healthy one.
const POKE = process.env.POKE ?? "quality";
const giPropsNow = (giEntity.components ?? []).find((c) => c.type === "global-illumination")?.props ?? {};
const pokeKey = POKE === "profiling" ? "rayHitProfiling" : "quality";
const pokeBase = POKE === "profiling" ? giPropsNow.rayHitProfiling === true : (giPropsNow.quality ?? "ultra");
const pokeAlt = POKE === "profiling" ? !pokeBase : (pokeBase === "high" ? "medium" : "high");
let pokeState = pokeBase;
for (let i = 1; i <= REBUILDS; i++) {
  const before = builtCount;
  pokeState = pokeState === pokeBase ? pokeAlt : pokeBase;
  await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: pokeKey, value: pokeState });
  const built = await waitForBuilt(before, 180000);
  if (!built) console.log(`  rebuild ${i}: NO [gi] built within 180s — census may straddle a wave`);
  await wait(6000);
  await record(`rebuild-${i}`);
}
if (pokeState !== pokeBase) {
  await call("component.setProp", { id: giEntity.id, type: "global-illumination", key: pokeKey, value: pokeBase });
  await waitForBuilt(builtCount, 180000);
}

// ---- Phase B: idle ----
if (IDLE > 0) {
  await wait(IDLE * 1000);
  await record(`idle-${IDLE}s`);
}

// ---- Phase C: scene cycles ----
for (let i = 1; i <= CYCLES; i++) {
  await openScene(ALT_SCENE, "level");
  await wait(12000);
  await openScene(SCENE, "bistro");
  await wait(12000);
  await record(`cycle-${i}`);
}

// ---- Verdict ----
const base = rows[0];
const last = rows[rows.length - 1];
const rebuildRows = rows.filter((r) => r.label.startsWith("rebuild-"));
const perRebuild = rebuildRows.length >= 2
  ? (rebuildRows[rebuildRows.length - 1].heapMB - rebuildRows[0].heapMB) / (rebuildRows.length - 1)
  : 0;
console.log(`\nHEAP-RET VERDICT`);
console.log(`  total: ${base.heapMB.toFixed(0)} -> ${last.heapMB.toFixed(0)} MB across ${rows.length - 1} events`);
console.log(`  per-rebuild (steady, excluding the first): ${perRebuild.toFixed(0)} MB`);
const cycleRows = rows.filter((r) => r.label.startsWith("cycle-"));
if (cycleRows.length >= 1) {
  const cycleBase = rows[rows.findIndex((r) => r.label.startsWith("cycle-")) - 1];
  const perCycle = (cycleRows[cycleRows.length - 1].heapMB - cycleBase.heapMB) / cycleRows.length;
  console.log(`  per scene-cycle: ${perCycle.toFixed(0)} MB`);
}
console.log(`  columns that grew: ${["nodeBuilderCache", "pipeCaches", "progV", "progF", "progC", "buffersLive", "shaderModules"].filter((k) => last[k] > base[k] + 2).join(", ") || "none"}`);

console.log("\nGI-HEAP-RETAINER DONE");
await browser.close();
process.exit(0);
