// ⭐⭐ OUTLINE ROOT PROBE — what selecting a 1 600-mesh import costs.
//
// THE REPORT (user, 08-28 13:00): "fps drops 2 times when bistro entity is
// selected and outline for it is drawn in the viewport (1600+ entities to a
// single outline, I guess this is the cost)".
//
// ══ WHY THE PROBES ALREADY IN `scripts/` CANNOT ANSWER IT ═══════════════════
//
// `run-outline-hitch-probe.mjs` measures the WORST rAF DELTA in the 2 s after a
// selection — a spike detector, built for the first-selection pipeline compile.
// The complaint is not a spike. It is a STEADY halving that persists for as
// long as the thing stays selected, and a max-of-window statistic scores
// "one 120 ms compile then 60 fps" and "every frame at 33 ms forever"
// identically. [[probe-blind-statistics]]
//
// `run-selection-outline-smoke.mjs` measures the ring in PIXELS on a synthetic
// four-box scene. It proves the effect is correct and says nothing about what
// it costs, and its scene has no merge proxies at all — the entire mechanism
// under test here is invisible to it by construction.
//
// ══ WHAT THIS MEASURES ══════════════════════════════════════════════════════
//
// Four arms, the 2x2 that isolates the claim. The user's report is a RATIO, so
// the deselected arm is not a baseline to be nice about — it IS the target:
//
//   parked-off   camera still, nothing selected      ← the frame's own cost
//   */B4         the same arm with `__outlineNoProxyCollapse` +
//                `__outlineNoCache` set: the exact pre-08-28 mask pass
//   parked-on    camera still, Bistro root selected  ← must equal parked-off
//   orbit-off    camera orbiting, nothing selected
//   orbit-on     camera orbiting, root selected      ← the honest mask cost
//
// `parked-on == parked-off` is the static cache: a frame that changes nothing
// the mask depends on must not re-render the mask. `orbit-on` is where the
// proxy collapse is visible, because every frame there is a real mask render.
//
// ⭐ AND THE NUMBER THAT IS NOT A TIMING. `maskDraws` — read out of
// `renderer.info.render.drawCalls` by the module itself, so it counts what the
// renderer submitted rather than what we hoped it would. A timing on a shared
// GPU is arguable; a draw count is not. Before this change the root selected
// ~865 of them per frame; the main pass draws the same subtree as ~189
// proxies, and that is the floor this is aiming at.
//
// ⭐⭐ PIXEL IDENTITY, MEASURED. The whole proxy collapse rests on "a merge
// proxy's geometry IS its members concatenated in world space, so the
// silhouette is identical". That is a claim about pixels, so it is checked as
// pixels: the same selection is rendered with the collapse ON and OFF and the
// two mask textures are compared texel for texel. `__outlineNoProxyCollapse`
// exists for exactly this. A `differing: 0` line is the receipt; anything else
// means a proxy exists whose geometry is not its members, and the collapse must
// come back out.
//
// ⚠ THE URL IS 5202, NEVER 5201 — this worktree has a junctioned node_modules
// and a private vite cache (`vite.gi19.config.mjs`):
//
//   node node_modules/vite/bin/vite.js -c vite.gi19.config.mjs --port 5202 --strictPort
//   node scripts/run-outline-root-probe.mjs http://127.0.0.1:5202/
//
// Env:
//   PROJECT=<path>   default C:/Users/Khudiiash/Documents/GAME
//   SCENE=Bistro     ENTITY=<name>  (default: the entity with the most meshes)
//   SETTLE=16        seconds after the scene reports built
//   FRAMES=90        frames per cpuFrame capture
//   ORBIT_DEG=40     total yaw swept per orbit arm
//   HEADED=1         watch it run
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = (process.argv[2] ?? "http://127.0.0.1:5202/").replace(/\/$/, "");
const PROJECT = (process.env.PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SCENE = process.env.SCENE ?? "Bistro";
const ENTITY = process.env.ENTITY ?? "";
const SETTLE = Number(process.env.SETTLE ?? 16);
const FRAMES = Number(process.env.FRAMES ?? 90);
const ORBIT_DEG = Number(process.env.ORBIT_DEG ?? 40);
const BOOT_TIMEOUT = Number(process.env.BOOT_TIMEOUT ?? 300) * 1000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : "—");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  protocolTimeout: 1800000,
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1650, height: 970, deviceScaleFactor: 1 });
await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  globalThis.__editorKeepRendering = true;
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
}, PROJECT);

let built = false;
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi2?\] (built|first light)/.test(t)) built = true;
  if (/\[merging\]/.test(t)) console.log(`    ${t.slice(0, 190)}`);
});
page.on("pageerror", (e) => {
  const s = e.stack ?? e.message ?? String(e);
  if (!/save_scene|esbuild|transpile/.test(s)) console.log(`    pageerror: ${s.slice(0, 180)}`);
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, PROJECT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 180000 });

const call = async (op, args = {}) => {
  try {
    return await page.evaluate(async ({ op, args }) => {
      try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
      catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
    }, { op, args });
  } catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
};

console.log(`\n══ ${SCENE} — what selecting the root costs ═══════════════════════`);
const opened = await call("scene.open", { path: `${PROJECT}/scenes/${SCENE}.scene` });
if (!opened.ok) { console.log(`FATAL scene.open: ${opened.error}`); await browser.close(); process.exit(1); }
{
  const dl = Date.now() + BOOT_TIMEOUT;
  while (Date.now() < dl && !built) await wait(250);
}
console.log(`  built ${built ? "yes" : "NEVER (measuring anyway)"} — settling ${SETTLE}s`);
await wait(SETTLE * 1000);

// ⚠ AND THEN WAIT FOR THE MERGE. The first run of this probe took its
// DESELECTED baseline while merging was still forming its 189 groups, and read
// 113 ms of CPU against 17 ms for the same camera a minute later — the baseline
// was four times the arm it was supposed to bound, and the verdict read "the
// outline made the frame FASTER". A merge that has not run yet is also the
// whole mechanism under test missing, so this waits for `groups` to stop
// moving rather than for a clock.
{
  const dl = Date.now() + 180_000;
  let last = -1, still = 0;
  while (Date.now() < dl) {
    const n = await page.evaluate(async () => {
      const eng = (await import("/src/editor/engineInstance.js")).engine;
      return eng?.merging?.groups?.length ?? 0;
    });
    still = n === last && n > 0 ? still + 1 : 0;
    last = n;
    if (still >= 4) break;
    await wait(2000);
  }
  console.log(`  merging settled at ${last} proxies`);
}

// ═════════════════════════════════════════════════ 1. THE HANDLES + THE TARGET
const setup = await page.evaluate(async (wantName) => {
  const eng = (await import("/src/editor/engineInstance.js")).engine;
  const viewport = (await import("/src/editor/viewportHandle.js")).getViewportHandle();
  // Vite serves a touched module under two specifiers; the LIVE one is the one
  // the panel already fetched. Importing the other gets a second copy of the
  // singleton's module and a `state` nobody is writing.
  const live = (p) => {
    const prefix = location.origin + p;
    const seen = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    return import(/* @vite-ignore */ seen.find((n) => n.includes("?")) ?? seen[0] ?? p);
  };
  const outline = await live("/src/editor/selectionOutline.js");
  globalThis.__ol = { eng, viewport, outline };

  // The target entity: the one whose subtree holds the most meshes. Naming it
  // would tie this probe to one import's spelling; the report is about the
  // BIGGEST subtree, so pick it by that.
  let best = null;
  for (const e of eng.entities?.values?.() ?? []) {
    if (wantName && (e.name ?? "") !== wantName) continue;
    let meshes = 0;
    e.object3D?.traverse?.((o) => { if (o.isMesh && !o.userData?.batchProxy) meshes++; });
    if (!best || meshes > best.meshes) best = { id: e.id, name: e.name, meshes };
  }
  const merging = eng.merging;
  return {
    target: best,
    merge: merging ? { groups: merging.groups?.length ?? 0,
      members: (merging.groups ?? []).reduce((n, g) => n + (g.members?.length ?? 0), 0) } : null,
    batches: eng.batching?.batches?.length ?? 0,
    hasStats: typeof outline.selectionOutlineStats === "function",
    cam: [viewport.camera.position.x, viewport.camera.position.y, viewport.camera.position.z],
    tgt: viewport.orbit ? [viewport.orbit.target.x, viewport.orbit.target.y, viewport.orbit.target.z] : null,
  };
}, ENTITY);
if (!setup.target) { console.log("FATAL: no entity found"); await browser.close(); process.exit(1); }
console.log(`  target: "${setup.target.name}" (${setup.target.id}) — ${setup.target.meshes} meshes`);
console.log(`  merging: ${setup.merge?.groups ?? 0} proxies standing in for ${setup.merge?.members ?? 0} meshes; ${setup.batches} batches`);
if (!setup.hasStats) console.log("  ⚠ selectionOutlineStats() missing — this build predates the fix; maskDraws will read 0");

// ═══════════════════════════════════════════════════════ 2. THE CAMERA DRIVER
// Orbit in-page, one step per rendered frame: a `viewport.setCamera` per step
// over the bridge would pace the arm at the bridge's rate, not the engine's,
// and this is a measurement of frames.
await page.evaluate((deg) => {
  const { viewport } = globalThis.__ol;
  const cam = viewport.camera;
  const t = viewport.orbit?.target ?? { x: 0, y: 0, z: 0 };
  const R = (globalThis.__olOrbit = {
    base: [cam.position.x, cam.position.y, cam.position.z],
    tgt: [t.x, t.y, t.z], on: false, k: 0, span: (deg * Math.PI) / 180, steps: 120,
  });
  const step = () => {
    requestAnimationFrame(step);
    if (!R.on) return;
    const a = (R.k++ / R.steps) * R.span;
    const [bx, by, bz] = R.base, [tx, ty, tz] = R.tgt;
    const dx = bx - tx, dz = bz - tz;
    const c = Math.cos(a), s = Math.sin(a);
    viewport.camera.position.set(tx + dx * c - dz * s, by, tz + dx * s + dz * c);
    if (viewport.orbit) { viewport.orbit.target.set(tx, ty, tz); viewport.orbit.update(); }
    else viewport.camera.lookAt(tx, ty, tz);
  };
  requestAnimationFrame(step);
}, ORBIT_DEG);

const setOrbit = (on) => page.evaluate((v) => { globalThis.__olOrbit.on = v; globalThis.__olOrbit.k = 0; }, on);
const park = () => page.evaluate(() => {
  const { viewport } = globalThis.__ol;
  const R = globalThis.__olOrbit;
  R.on = false;
  viewport.camera.position.set(R.base[0], R.base[1], R.base[2]);
  if (viewport.orbit) { viewport.orbit.target.set(R.tgt[0], R.tgt[1], R.tgt[2]); viewport.orbit.update(); }
});

const outlineStats = () => page.evaluate(() => {
  const s = globalThis.__ol.outline.selectionOutlineStats?.();
  return s ? { ...s } : null;
});

// ══════════════════════════════════════════════════════════════════ 3. AN ARM
//
// ⭐ BEFORE AND AFTER IN ONE BOOT. `__outlineNoProxyCollapse` +
// `__outlineNoCache` together are exactly the pre-08-28 mask pass, so the
// comparison is against the same GI build, the same merge outcome, the same
// governor rung and the same thermal state. A second boot would differ in all
// four, and Bistro takes minutes to reach first light — a cross-session A/B
// here is not a controlled experiment, it is two anecdotes.
const setMode = (before) => page.evaluate((v) => {
  globalThis.__outlineNoProxyCollapse = v;
  globalThis.__outlineNoCache = v;
  globalThis.__ol.outline.invalidateSelectionOutline();
}, before);

const rows = [];
async function arm(label, { selected, orbiting, oldWay = false }) {
  await setMode(oldWay);
  await call("selection.set", { ids: selected ? [setup.target.id] : [] });
  if (orbiting) await setOrbit(true); else await park();
  await wait(2500); // let the EMAs and the mask settle into the new regime
  const pre = await outlineStats();
  const cpu = (await call("profile.cpuFrame", { frames: FRAMES })).value ?? {};
  const fs = (await call("profile.frameStats", { settleMs: 1200 })).value ?? {};
  const after = await outlineStats();
  const row = {
    label,
    fps: fs.fps ?? null,
    cpuMs: cpu.cpuMs ?? null,
    gpuMs: cpu.gpuMs ?? null,
    draws: cpu.drawCalls ?? null,
    maskDraws: after?.maskDraws ?? 0,
    stamped: after?.stamped ?? 0,
    proxies: after?.proxies ?? 0,
    meshes: after?.meshes ?? 0,
    // The cache's own receipt for this arm: how many mask RENDERS it paid for
    // over the whole capture, against how many frames it skipped.
    renders: (after?.renders ?? 0) - (pre?.renders ?? 0),
    hits: (after?.hits ?? 0) - (pre?.hits ?? 0),
    audits: (after?.audits ?? 0) - (pre?.audits ?? 0),
  };
  // ⚠ `maskDraws` IS PER RENDER, NOT PER FRAME, and on a parked camera those
  // are different numbers by a factor of a hundred. The stats block is written
  // by the mask RENDER, so a cached frame reports the last real render's count
  // — read as "per frame" it would say a parked selection still submits 189
  // draws when it submits none at all. This is the per-frame number, and it is
  // the one the verdict uses.
  row.drawsPerFrame = (row.maskDraws * row.renders) / Math.max(1, row.renders + row.hits);
  // ⭐ WHY IT MISSED, not just that it did. Six causes produce the identical
  // "hits: 0" line, and the first run of this probe hit one of them.
  const dm = {};
  for (const k of Object.keys(after?.misses ?? {})) {
    const d = (after.misses[k] ?? 0) - (pre?.misses?.[k] ?? 0);
    if (d > 0) dm[k] = d;
  }
  row.missBy = dm;
  row.frames = (after?.frames ?? 0) - (pre?.frames ?? 0);
  row.contentChurn = (after?.contentChurn ?? 0) - (pre?.contentChurn ?? 0);
  rows.push(row);
  console.log(
    `  ${label.padEnd(13)} ${String(row.fps ?? "—").padStart(4)} fps · cpu ${f(row.cpuMs).padStart(6)} ms · ` +
    `gpu ${f(row.gpuMs).padStart(6)} ms · draws ${String(row.draws ?? "—").padStart(5)} · ` +
    `mask ${String(row.maskDraws).padStart(4)}/render → ${f(row.drawsPerFrame, 1).padStart(6)}/frame ` +
    `(${row.proxies}p+${row.meshes}m${after?.animated ? `,${after.animated}anim` : ""}) · ` +
    `renders ${row.renders}/hits ${row.hits}` +
    `${Object.keys(dm).length ? ` · miss ${Object.entries(dm).map(([k, v]) => `${k}:${v}`).join(" ")}` : ""}`,
  );
  return row;
}

console.log("\n── arms ───────────────────────────────────────────────────────────");
await arm("parked-off", { selected: false, orbiting: false });
await arm("parked-on/B4", { selected: true, orbiting: false, oldWay: true });
await arm("parked-on", { selected: true, orbiting: false });
await arm("orbit-off", { selected: false, orbiting: true });
await arm("orbit-on/B4", { selected: true, orbiting: true, oldWay: true });
await arm("orbit-on", { selected: true, orbiting: true });
// The deselected baseline AGAIN, last. Everything above is a ratio against it,
// and a baseline measured once at the top is an assumption that nothing drifted
// over the six minutes that followed. Two readings bound that drift; if they
// disagree, no ratio in the verdict means anything.
await arm("parked-off/2", { selected: false, orbiting: false });
await setOrbit(false);
await park();
await setMode(false);

// ════════════════════════════════════════════ 4. PIXEL IDENTITY OF THE MASK
//
// ⚠ RE-SELECT FIRST. The arms end on a DESELECTED control, and run 2 of this
// probe compared two empty masks and printed "0 differing of 464544 — IDENTICAL"
// in bold. A comparison whose subject is absent passes every time.
// [[probe-blind-statistics]] — the `covered` counts below exist so an empty
// mask can never be mistaken for an agreeing one.
await call("selection.set", { ids: [setup.target.id] });
await wait(1500);
console.log("\n── silhouette: proxy path vs member path ──────────────────────────");
const identity = await page.evaluate(async () => {
  const { eng, outline } = globalThis.__ol;
  const readMask = async () => {
    const { mask } = outline.selectionOutlineTargets();
    if (!mask) return null;
    // Element-wise copy, not a view over `.buffer`: a WebGPU readback's rows
    // are padded to 256 bytes and the raw buffer is longer than w*h*4. Both
    // reads go through this same path, so the comparison below is exact
    // whatever the padding does — but only if both are shaped the same way.
    const px = await eng.renderer.readRenderTargetPixelsAsync(mask, 0, 0, mask.width, mask.height);
    return { w: mask.width, h: mask.height, px: Uint8Array.from(px) };
  };
  // A frame in each mode. `invalidateSelectionOutline` is what makes the frame
  // cache re-render — without it the second read would return the first one's
  // texels and the comparison would "pass" while measuring nothing.
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  globalThis.__outlineNoProxyCollapse = false;
  outline.invalidateSelectionOutline();
  await frame(); await frame();
  const withProxy = await readMask();
  const statsProxy = outline.selectionOutlineStats();

  globalThis.__outlineNoProxyCollapse = true;
  outline.invalidateSelectionOutline();
  await frame(); await frame();
  const withMembers = await readMask();
  const statsMembers = outline.selectionOutlineStats();

  globalThis.__outlineNoProxyCollapse = false;
  outline.invalidateSelectionOutline();
  if (!withProxy || !withMembers) return { error: "no mask target" };
  if (withProxy.px.length !== withMembers.px.length) return { error: "size mismatch" };

  let differing = 0, coveredA = 0, coveredB = 0;
  for (let i = 0; i < withProxy.px.length; i += 4) {
    const a = Math.max(withProxy.px[i], withProxy.px[i + 1]) > 127;
    const b = Math.max(withMembers.px[i], withMembers.px[i + 1]) > 127;
    if (a) coveredA++;
    if (b) coveredB++;
    if (a !== b) differing++;
  }
  return {
    w: withProxy.w, h: withProxy.h, differing, coveredA, coveredB,
    total: withProxy.px.length / 4,
    proxyDraws: statsProxy.maskDraws, memberDraws: statsMembers.maskDraws,
    proxyStamped: statsProxy.stamped, memberStamped: statsMembers.stamped,
  };
});
if (identity?.error) console.log(`  ⚠ ${identity.error}`);
else {
  const pct = (100 * identity.differing) / Math.max(1, identity.coveredB);
  console.log(`  proxy path  : ${identity.proxyDraws} mask draws (${identity.proxyStamped} stamped), ${identity.coveredA} covered texels`);
  console.log(`  member path : ${identity.memberDraws} mask draws (${identity.memberStamped} stamped), ${identity.coveredB} covered texels`);
  console.log(`  differing   : ${identity.differing} of ${identity.total} texels (${pct.toFixed(4)}% of the silhouette) ` +
    `${identity.coveredB === 0 ? "⚠ VACUOUS — the mask is EMPTY, this compared nothing"
      : identity.differing === 0 ? "— IDENTICAL" : "⚠ NOT IDENTICAL"}`);
}

// ══════════════════════════════════════════════════════════════ 5. THE VERDICT
console.log("\n── verdict ────────────────────────────────────────────────────────");
const by = (l) => rows.find((r) => r.label === l) ?? {};
const pOff = by("parked-off"), pOn = by("parked-on"), pB4 = by("parked-on/B4");
const oOff = by("orbit-off"), oOn = by("orbit-on"), oB4 = by("orbit-on/B4");
const ratio = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : NaN);
const parkedCpu = ratio(pOn.cpuMs, pOff.cpuMs);
const orbitCpu = ratio(oOn.cpuMs, oOff.cpuMs);
console.log(`  mask draws PER FRAME with the root selected : ${f(pB4.drawsPerFrame, 1)} → ${f(pOn.drawsPerFrame, 1)} parked, ` +
  `${f(oB4.drawsPerFrame, 1)} → ${f(oOn.drawsPerFrame, 1)} orbiting (the whole frame is ${oOff.draws ?? "—"} draws)`);
console.log(`  parked : selected costs ${f(parkedCpu)}x the deselected CPU ` +
  `(${f(pOn.cpuMs)} vs ${f(pOff.cpuMs)} ms; before ${f(pB4.cpuMs)} ms), ${pOn.renders} mask render(s) in ` +
  `${pOn.renders + pOn.hits} frames — ${pOn.renders === 0 && parkedCpu < 1.1 ? "PASS (the cache is holding)" : "FAIL"}`);
console.log(`  orbit  : selected costs ${f(orbitCpu)}x the deselected CPU ` +
  `(${f(oOn.cpuMs)} vs ${f(oOff.cpuMs)} ms; before ${f(oB4.cpuMs)} ms), ${oOn.maskDraws} mask draws for ` +
  `${setup.target.meshes} meshes — ${orbitCpu <= 1.3 ? "PASS (≤1.3x)" : "FAIL (>1.3x)"}`);
console.log(`  fps    : parked ${pOff.fps} off / ${pB4.fps} before / ${pOn.fps} after · ` +
  `orbit ${oOff.fps} off / ${oB4.fps} before / ${oOn.fps} after`);
const pOff2 = by("parked-off/2");
console.log(`  drift  : the deselected baseline read ${f(pOff.cpuMs)} ms at the top and ` +
  `${f(pOff2.cpuMs)} ms at the end — ${Math.abs((pOff.cpuMs ?? 0) - (pOff2.cpuMs ?? 0)) < 0.25 * (pOff2.cpuMs ?? 1)
    ? "stable, the ratios above hold" : "⚠ DRIFTED >25%, treat every ratio above as unsound"}`);
console.log(`  content: engine.content.version moved on ${pOn.contentChurn} of ${pOn.frames} parked frames ` +
  `— ${pOn.contentChurn >= pOn.frames - 2 && pOn.frames > 10
    ? "it churns every frame, which is why the key uses .hierarchy instead"
    : "stable enough that the broad key would also have worked"}`);
if (pOn.renders > 0) {
  const why = pOn.missBy ?? {};
  console.log(`  parked re-renders: ${pOn.renders} of ${pOn.renders + pOn.hits} frames — ` +
    `${Object.entries(why).map(([k, v]) => `${k}:${v}`).join(", ") || "unknown"}`);
  if (why.pose) {
    console.log(`    → \`pose\` is an animation playing INSIDE the selection (this scene's Player rig ` +
      `sits under the same prefab root). Expected work, not a fault: one moving character re-submits ` +
      `every static draw, because the mask is one target that has to be cleared.`);
  }
  if (why.audit) {
    console.log(`    → ⚠ \`audit\` means the declared key said "unchanged" and the stamp-list walk ` +
      `disagreed about something that is NOT a pose — a producer is missing (contentKey.js).`);
  }
  if (why.camera) {
    console.log(`    → ⚠ \`camera\` on a PARKED arm means the camera is not actually still.`);
  }
}

await browser.close();
