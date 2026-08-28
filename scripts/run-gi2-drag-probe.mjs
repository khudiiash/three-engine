// GI2 DRAG PROBE — §19 Stage 6.5 ("dragging an emissive object freezes the
// viewport to 0-1 fps").
//
// WHAT IT MEASURES AND WHY THE EXISTING PROBES CANNOT
//
// `run-gi2-motion-probe` moves the CAMERA. The camera never bumps the engine's
// scene content key, so it exercises the window scroll and nothing on the
// REBUILD chain. This probe moves an OBJECT — the same call the editor's own
// gizmo makes (`entity.setTransform`) — which bumps `engine.content` on every
// frame and is therefore the only arm that can see a per-drag-frame soup
// rebuild, voxelizer rescan, shadow-BVH kick or merge rebuild.
//
// Per frame it records: wall-clock frame ms (hooked on `StatsSystem
// .endPhaseFrame`, the one call made exactly once per tick), the GI system's
// rebuild run/ask counters, the GI2 store's `soupBuilds`, the engine content
// key's version and per-category counts, and the console lines the chain emits
// (so a `[gi2] shadow bvh` kick is attributable to the frame that paid for it).
//
// Env: PROJECT (default C:/Users/Khudiiash/Documents/GAME), SCENE (Cornel),
//      TARGET=<entity name substring> (default: the brightest emissive mesh),
//      PARK=60 DRAG_MS=3000 TAIL=90, AMP=0.6 (metres of travel),
//      HEADED=1, JSON=<path>, CHROME_PATH.
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = (process.argv[2] ?? "http://127.0.0.1:5210/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Cornel";
const TARGET = process.env.TARGET ?? "";
const PARK = Number(process.env.PARK ?? 60);
const DRAG_MS = Number(process.env.DRAG_MS ?? 3000);
const TAIL = Number(process.env.TAIL ?? 90);
const AMP = Number(process.env.AMP ?? 0.6);
const SETTLE = Number(process.env.SETTLE ?? 6);
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT ?? 300) * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : "—");

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--js-flags=--expose-gc"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((flags) => { for (const [k, v] of Object.entries(flags)) globalThis[k] = v; },
  JSON.parse(process.env.FLAGS ?? "{}"));
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

const marks = { firstLight: 0, assetsReady: 0 };
page.on("console", (m) => {
  const t = m.text();
  if (/scene assets ready/.test(t) && !marks.assetsReady) marks.assetsReady = Date.now();
  if (/\[gi2\] first light/.test(t) && !marks.firstLight) marks.firstLight = Date.now();
});
page.on("pageerror", (e) => { const s = e.stack ?? e.message ?? String(e); if (!/save_scene/.test(s)) console.log(`    pageerror: ${s.slice(0, 200)}`); });

console.log(`gi2 drag probe → ${url}  project ${PROJECT}  scene ${SCENE}`);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });
await page.evaluate(async () => {
  const mod = await import("/src/editor/engineInstance.js");
  globalThis.__giEngineForProbe = mod.engine;
  globalThis.__giSysForProbe = () => mod.engine?.modules?.get?.("gi")?.system ?? null;
  globalThis.__gi2 = () => { const s = globalThis.__giSysForProbe(); return s?._gi2 ?? s?.state?.screen?.gi2 ?? null; };
});
const call = async (op, args = {}) => {
  try {
    return await page.evaluate(async ({ op, args }) => {
      try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, { op, args });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
};

const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(2); }
{ const dl = Date.now() + BOOT_TIMEOUT; while (Date.now() < dl && !marks.firstLight) await wait(250); }
console.log(marks.firstLight ? `  first light` : `  ⚠ NO FIRST LIGHT in ${BOOT_TIMEOUT / 1000}s`);
{
  const quietBy = Date.now() + Number(process.env.QUIESCE_MS ?? 90000);
  await page.evaluate(async () => { const m = await import("/src/engine/textureAsset.js"); globalThis.__texInFlight = () => m.textureLoadsInFlight?.() ?? 0; }).catch(() => {});
  while (Date.now() < quietBy) {
    const s = await page.evaluate(() => ({ tex: globalThis.__texInFlight?.() ?? 0, merging: !!globalThis.__giEngineForProbe?.merging?.settling })).catch(() => null);
    if (s && !s.tex && !s.merging) break;
    await wait(500);
  }
}
await wait(SETTLE * 1000);
const settled = (await call("profile.frameStats", { settleMs: 1100 })).value ?? {};
console.log(`  settled: ${settled.fps ?? "?"} fps, cpu ${f2(settled.cpuMs)} ms, gpu ${f2(settled.gpuMs)} ms`);

// ── pick the target: the brightest emissive mesh with an entity id ──────────
//
// ⚠ The engine's entity registry is not walkable from the page in one shape
// across scenes, so the search runs over `scene.traverse` and maps each object
// back to its entity through `userData.entityId` — the same link the picker
// uses. `TARGET` narrows by name when a scene has several emitters.
const target = await page.evaluate((want) => {
  const eng = globalThis.__giEngineForProbe;
  const best = { lum: 0 };
  const seen = new Map();
  eng?.scene?.traverse?.((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    let lum = 0;
    for (const m of mats) {
      const c = m?.emissive; if (!c) continue;
      const i = m.emissiveIntensity ?? 1;
      lum = Math.max(lum, (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * i);
    }
    if (!(lum > 0)) return;
    let n = o, id = null;
    while (n && !id) { id = n.userData?.entityId ?? n.userData?.entity?.id ?? null; n = n.parent; }
    if (!id) return;
    const prev = seen.get(id) ?? 0;
    if (lum > prev) seen.set(id, lum);
  });
  for (const [id, lum] of seen) {
    const ent = eng.getEntity?.(id) ?? eng.entities?.get?.(id) ?? null;
    const name = ent?.name ?? String(id);
    if (want && !name.toLowerCase().includes(want.toLowerCase())) continue;
    const obj = ent?.object3D ?? ent?.object ?? null;
    const p = obj ? [obj.position.x, obj.position.y, obj.position.z] : [0, 0, 0];
    if (lum > best.lum) Object.assign(best, { id, name, lum, pos: p });
  }
  return best.lum > 0 ? best : null;
}, TARGET);
if (!target) { console.log("FATAL: no emissive mesh found"); await browser.close(); process.exit(2); }
console.log(`  target: "${target.name}" (${target.id}) emissive luminance ${f2(target.lum)} at ${target.pos.map((v) => v.toFixed(2)).join(", ")}`);

// ── the in-page recorder + drag driver ─────────────────────────────────────
const installed = await page.evaluate(async ({ target, amp }) => {
  const eng = globalThis.__giEngineForProbe;
  if (!eng?.stats) return { ok: false, why: "no engine.stats" };
  const R = { frames: [], seg: "park", logs: [], frameLogs: [], done: false, i: 0 };
  globalThis.__gi2Drag = R;
  for (const k of ["log", "info", "warn", "error"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { try { const s = String(a[0] ?? "").slice(0, 110); R.frameLogs.push(s); } catch {} return orig(...a); };
  }
  const stats = eng.stats;
  const origEnd = stats.endPhaseFrame.bind(stats);
  let last = performance.now();
  stats.endPhaseFrame = (...a) => {
    const r = origEnd(...a);
    const now = performance.now();
    const sys = globalThis.__giSysForProbe();
    const gi2 = globalThis.__gi2();
    const store = gi2?.store ?? gi2?._store ?? null;
    R.frames.push({
      seg: R.seg, ms: now - last,
      rebuilds: sys?.rebuilds ?? 0, asks: sys?.rebuildAsks ?? 0,
      soup: store?.soupBuilds ?? gi2?.snapshot?.()?.soupBuilds ?? 0,
      cv: eng.content?.version ?? 0,
      ct: eng.content?.counts ? { ...eng.content.counts } : null,
      logs: R.frameLogs.splice(0),
    });
    last = now;
    return r;
  };
  R.restore = () => { stats.endPhaseFrame = origEnd; };
  R.target = target; R.amp = amp;
  return { ok: true };
}, { target, amp: AMP });
if (!installed.ok) { console.log(`FATAL recorder: ${installed.why}`); await browser.close(); process.exit(2); }

await wait((PARK / 60) * 1000 + 300);

// The drag: `entity.setTransform` once per animation frame, exactly as the
// editor's translate gizmo does while the pointer is held.
console.log(`  dragging "${target.name}" for ${DRAG_MS} ms …`);
await page.evaluate(({ ms, base, amp }) => {
  const R = globalThis.__gi2Drag;
  R.seg = "drag";
  const t0 = performance.now();
  const step = () => {
    const t = performance.now() - t0;
    if (t >= ms) { R.seg = "tail"; R.dragEndedAt = performance.now(); R.dragDone = true; return; }
    const u = Math.sin((t / ms) * Math.PI * 2) * amp;
    globalThis.__editorApi.call("entity.setTransform", { id: R.target.id, position: { x: base[0] + u, y: base[1], z: base[2] } })
      .catch(() => {});
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}, { ms: DRAG_MS, base: target.pos, amp: AMP });
await page.waitForFunction(() => globalThis.__gi2Drag?.dragDone === true, { timeout: DRAG_MS + 120000, polling: 250 });
await wait((TAIL / 60) * 1000 + 500);

const R = await page.evaluate(() => {
  const R = globalThis.__gi2Drag; R.restore?.();
  return { frames: R.frames };
});
await browser.close();

const segs = { park: [], drag: [], tail: [] };
for (const f of R.frames) (segs[f.seg] ?? segs.park).push(f);
const report = {};
for (const [name, fs_] of Object.entries(segs)) {
  if (!fs_.length) continue;
  const ms = fs_.map((f) => f.ms);
  const first = fs_[0], lastF = fs_[fs_.length - 1];
  report[name] = {
    n: fs_.length, medianMs: median(ms), p95: pct(ms, 95), max: Math.max(...ms),
    fps: 1000 / median(ms), over50: ms.filter((m) => m > 50).length,
    rebuildRuns: lastF.rebuilds - first.rebuilds, rebuildAsks: lastF.asks - first.asks,
    soupBuilds: lastF.soup - first.soup,
    contentBumps: lastF.cv - first.cv,
    contentCounts: first.ct && lastF.ct ? Object.fromEntries(Object.keys(lastF.ct).map((k) => [k, lastF.ct[k] - first.ct[k]])) : null,
  };
  console.log(`\n  ${name.toUpperCase()}  n=${fs_.length}  median ${f2(median(ms))} ms (${f2(1000 / median(ms))} fps)  p95 ${f2(pct(ms, 95))}  max ${f2(Math.max(...ms))}  >50ms: ${ms.filter((m) => m > 50).length}`);
  console.log(`    giRebuild runs +${report[name].rebuildRuns}, asks +${report[name].rebuildAsks}, soupBuilds +${report[name].soupBuilds}, contentKey +${report[name].contentBumps} ${JSON.stringify(report[name].contentCounts)}`);
}
// The chain, named: which console lines land on the slow frames.
const slow = R.frames.filter((f) => f.ms > 40).slice(0, 400);
const owners = new Map();
for (const f of slow) for (const l of f.logs) owners.set(l, (owners.get(l) ?? 0) + 1);
console.log(`\n  slow frames (>40 ms): ${R.frames.filter((f) => f.ms > 40).length} of ${R.frames.length}`);
console.log("  lines emitted on slow frames (top 14):");
for (const [l, n] of [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`    ${String(n).padStart(4)}×  ${l}`);
const allLogs = new Map();
for (const f of R.frames) if (f.seg === "drag") for (const l of f.logs) allLogs.set(l, (allLogs.get(l) ?? 0) + 1);
console.log("  every line during the DRAG (top 18):");
for (const [l, n] of [...allLogs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`    ${String(n).padStart(4)}×  ${l}`);

if (process.env.JSON) { fs.writeFileSync(process.env.JSON, JSON.stringify({ target, settled, report, frames: R.frames }, null, 1)); console.log(`\n  frames → ${process.env.JSON}`); }
