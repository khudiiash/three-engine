// CORNELL vs THE PATH TRACER — the fidelity rig (plan §11.18, 2026-09-03).
//
// The user's two captures of their Cornell (our GI, then the in-editor path
// tracer) measured our whites at a tenth of the tracer's saturation and our
// brightness 1.4–1.8× next to the emitter and 0.2–0.5× on the far side. This
// rig makes that comparison repeatable and cheap: a READ-ONLY COPY of the
// user's own Cornell scene (the tauri shim refuses writes outside the scratch
// root, so their project is never touched), one pose, our GI settled for
// SETTLE ms, then the debug view flipped to "path-tracer" and left to
// accumulate for PT_MS, both captured with puppeteer's page.screenshot —
// which, unlike the MCP's viewport.screenshot, sees the tracer's canvas blit.
// Regions are WORLD points projected through the pose, so both frames share
// them exactly whatever the harness viewport's aspect.
//
//   npx vite --port 5201 --strictPort
//   node scripts/run-gi-cornell-ref.mjs
// Env:
//   FLAGS='{"__giSrcSecondary":false}'   page globals for the arm (before boot)
//   SETTLE=30000  PT_SAMPLES=64  PT_MS=300000 (ceiling)  QUALITY=ultra  HEADED=1  TAG=name
//   PT=0          skip the tracer;  DEBUG_VIEW=indirect,occupancy  extra captures
//   ENVLIGHT=0    patch the copied scene's environment lighting/background off
//   LIGHT_MOBILITY=static  re-tag the emitter mesh (mover → static);  HIDE_LIGHT=1 drop it
//   SRC_PROJECT=C:/Users/Khudiiash/Documents/GAME  SRC_SCENE=scenes/Cornel.scene
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { installTauriShim } from "./lib/tauriShim.mjs";
/** Decode a PNG buffer to { width, height, data } with 3 channels (RGB). */
const decode = async (buf) => {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
};

const url = process.argv[2] ?? "http://localhost:5201/";
const GEN_ROOT = (process.env.GEN_ROOT ?? path.resolve("scripts/.gi-cornell-ref")).replaceAll("\\", "/");
const SRC_PROJECT = (process.env.SRC_PROJECT ?? "C:/Users/Khudiiash/Documents/GAME").replaceAll("\\", "/");
const SRC_SCENE = process.env.SRC_SCENE ?? "scenes/Cornel.scene";
const FLAGS = JSON.parse(process.env.FLAGS ?? "{}");
const SETTLE = Number(process.env.SETTLE ?? 30000);
const PT_MS = Number(process.env.PT_MS ?? 300000);   // ceiling on the tracer wait
const PT_SAMPLES = Number(process.env.PT_SAMPLES ?? 64); // the target sample count
const TAG = process.env.TAG ?? "base";
const ENVLIGHT = process.env.ENVLIGHT !== "0";
const OUT = ".gi-shots/cornell-ref";
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the copy: their scene, verbatim (material paths inside it are absolute
// into their project and are only READ), their GI component untouched ──────
mkdirSync(path.join(GEN_ROOT, "scenes"), { recursive: true });
const scene = JSON.parse(readFileSync(path.join(SRC_PROJECT, SRC_SCENE), "utf8"));
// LIGHT_MOBILITY=static|dynamic|auto re-tags the emitter mesh; HIDE_LIGHT=1 drops it.
const patchEntity = (list, name, fn) => { for (const e of list) { if (e.name === name) fn(e); if (e.children) patchEntity(e.children, name, fn); } };
if (process.env.LIGHT_MOBILITY) patchEntity(scene.entities, "Light", (e) => { for (const c of e.components) if (c.type === "mesh") c.props.giMobility = process.env.LIGHT_MOBILITY; });
if (process.env.HIDE_LIGHT === "1") patchEntity(scene.entities, "Light", (e) => { e.enabledInEditor = false; e.enabledInGame = false; });
// WALLS=<metres>: thicken the four 0.1 m box walls (Red, Green, Mesh = back,
// Ceiling), shifting each outward so the room's inner faces stay put. Their
// scene's walls are thinner than two GI cells, so both faces of a wall share
// one surface record (see the memory's thin-geometry note): a lit inner face
// averaged with a black outer face is half a bounce.
if (process.env.WALLS) {
  const t = Number(process.env.WALLS), d = (t - 0.1) / 2;
  const thicken = (name, axis, sign) => patchEntity(scene.entities, name, (e) => { e.scale[2] = t; e.position[axis] += sign * d; });
  thicken("Red", 0, -1); thicken("Green", 0, +1); thicken("Mesh", 2, -1); thicken("Ceiling", 1, +1);
}
// ROOT_SHIFT=x,y,z moves the whole room (the "Cornell" root) — an artefact
// that stays at the world origin while the room moves is lattice-anchored,
// one that moves with the room is geometry's. GI_PROPS='{"cascadeCount":3}'
// patches the root's global-illumination component props.
if (process.env.ROOT_SHIFT) {
  const [dx, dy, dz] = process.env.ROOT_SHIFT.split(",").map(Number);
  patchEntity(scene.entities, "Cornell", (e) => { e.position[0] += dx; e.position[1] += dy; e.position[2] += dz; });
}
if (process.env.GI_PROPS) {
  const props = JSON.parse(process.env.GI_PROPS);
  patchEntity(scene.entities, "Cornell", (e) => { for (const c of e.components) if (c.type === "global-illumination") Object.assign(c.props, props); });
}
if (!ENVLIGHT) {
  scene.settings.environment = { ...scene.settings.environment, lighting: false, background: false, intensity: 0 };
}
writeFileSync(path.join(GEN_ROOT, "scenes", "Cornel.scene"), JSON.stringify(scene, null, 1));
writeFileSync(path.join(GEN_ROOT, "project.json"), JSON.stringify({
  name: "GI-Cornell-copy", version: 1,
  lastScene: "scenes/Cornel.scene", mainScene: "scenes/Cornel.scene",
  modules: ["gi", "physics-rapier"],
  settings: {
    editor: {
      autosaveSeconds: 0, snapTranslate: 0.5, snapRotateDeg: 15, snapScale: 0.1,
      gridSize: 40, gridDivisions: 40, showGrid: false,
      layers: { gizmos: false, cursor3D: false, colliders: false, grid: false, stats: false, debugDraw: false, uiOverlay: false, virtualGeometry: false },
      keybindings: {},
    },
    scripts: { hotReload: false, reloadIntervalMs: 750 },
    rendering: { pixelRatioCap: 2 },
    build: { startScene: "", scenes: ["scenes/Cornel.scene"], target: "web", quality: process.env.QUALITY ?? "ultra" },
  },
}, null, 2));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: [
    "--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  ],
});
const page = await browser.newPage();
const [WIN_W, WIN_H] = (process.env.WINDOW ?? "1400x900").split("x").map(Number);
await page.setViewport({ width: WIN_W, height: WIN_H, deviceScaleFactor: 1 });
await installTauriShim(page, {});
let built = 0;
const gi = [];
page.on("console", (m) => {
  const t = m.text();
  if (/\[gi\] built/.test(t)) built++;
  if (/^\[gi\]/.test(t)) gi.push(t.slice(0, 220));
  if ((m.type() === "warning" || m.type() === "error") && !/^\[gi\]/.test(t)) warnings.push(`${m.type()}: ${t.slice(0, 260)}`);
});
const warnings = [];
page.on("pageerror", (e) => {
  const msg = e.message ?? String(e);
  if (/save_scene|weak set/.test(msg)) return;
  const where = String(e.stack ?? "").split("\n").slice(1, 5).map((l) => l.trim().replace(/^at /, "")).join(" < ");
  console.log(`  pageerror: ${msg.slice(0, 200)} @ ${where}`);
});
await page.evaluateOnNewDocument((P, flags, quality) => {
  localStorage.setItem("engine.projectRoot.v1", P);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([P]));
  for (const [k, v] of Object.entries(flags)) globalThis[k] = v;
  if (quality) globalThis.__giConfigOverride = { ...(globalThis.__giConfigOverride ?? {}), quality };
}, GEN_ROOT, FLAGS, process.env.QUALITY ?? null);
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 30000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, GEN_ROOT);
await page.waitForFunction(() => !!globalThis.__editorApi, { timeout: 150000 });
const call = (op, args = {}) => page.evaluate(async ({ op, args }) => {
  try { return { ok: true, value: await globalThis.__editorApi.call(op, args) }; }
  catch (err) { return { ok: false, error: err?.message ?? String(err) }; }
}, { op, args });
const must = async (op, args) => { const r = await call(op, args); if (!r.ok) throw new Error(`${op} failed: ${r.error}`); return r.value; };
for (let i = 0; i < 120 && built === 0; i++) await wait(1000);
await wait(5000);
// Their room: root at (0.38, 0.24, 0), 5 m, open toward +z. Eye on the room's
// axis outside the opening, looking straight down -z.
const SHIFT = (process.env.ROOT_SHIFT ?? "0,0,0").split(",").map(Number);
const shifted = (p) => [p[0] + SHIFT[0], p[1] + SHIFT[1], p[2] + SHIFT[2]];
const EYE = shifted([0.38, 2.74, 6.7]), TARGET = shifted([0.38, 2.74, -2.26]);
// Headless is never focused: with the freeze on, the editor suspends its loop
// the moment the GI queue stops pinning it — which is exactly when the tracer
// takes over (GI skips its work while the tracer is active), so the tracer
// froze at ~3 frames (1.3 samples) however long the rig waited.
await must("viewport.setFreezeWhenUnfocused", { enabled: false });
await must("viewport.setCamera", { position: EYE, target: TARGET });
const cam = await must("viewport.getCamera");
console.log(`[cornell-ref] ${TAG}: built, settling ${SETTLE} ms (flags ${JSON.stringify(FLAGS)}, envLight ${ENVLIGHT}, fov ${cam.fov})`);
await wait(SETTLE);

// The viewport canvas rectangle — both captures clip to it.
const rect = await page.evaluate(() => {
  const c = document.querySelector("canvas");
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
});
const shot = async (name) => {
  const buf = await page.screenshot({ clip: rect, encoding: "binary" });
  writeFileSync(path.join(OUT, `${TAG}-${name}.png`), buf);
  return decode(buf);
};
// DRAG=<entity name>[,seconds]: the user's "moving the emitter or the
// reflective box freezes a lot". Nudge the entity's x by 1 cm every 33 ms
// for the period (a drag at 30 Hz), read profile.frameStats before and after
// and keep every [gi] rebuild/hold line the drag provoked.
if (process.env.DRAG) {
  const [dragName, dragSecs = "4"] = process.env.DRAG.split(",");
  const DRAG_STEP = Number(process.env.DRAG_STEP ?? 0.01);
  const list = await must("entity.list", { nameContains: dragName });
  const ent = list.find((e) => e.name === dragName) ?? list[0];
  if (!ent) throw new Error(`DRAG: no entity named ${dragName}`);
  const before = await call("profile.frameStats", { settleMs: 1500 });
  const giBefore = gi.length;
  const pos = [...ent.transform.position];
  const t0 = Date.now();
  let steps = 0;
  while (Date.now() - t0 < Number(dragSecs) * 1000) {
    // DRAG_STEP: the per-event displacement. The emitter motion metric is
    // dCenter/(0.1·reff) (reff 0.665 here), so a 1 cm nudge reads 0.15 and
    // never crosses ALPHA_TRACK_THRESHOLD 0.5 — a real gizmo drag moves
    // 5-10 cm per event and arms the light-track window every time.
    pos[0] += (steps % 40 < 20 ? 1 : -1) * DRAG_STEP;
    await call("entity.setTransform", { id: ent.id, position: pos });
    steps++;
    await wait(33);
  }
  const during = await call("profile.frameStats", { settleMs: 300 });
  const cpu = await call("profile.cpuFrame", { frames: 30 });
  await wait(2500);
  const after = await call("profile.frameStats", { settleMs: 1500 });
  const pick = (r) => {
    const v = r.ok ? r.value : null;
    if (!v) return `error ${r.error}`;
    const keys = ["fps", "frameMs", "cpuMs", "gpuMs", "giRebuilds", "giHold", "giHoldMs", "rebuilds", "holds", "workMs", "drawCalls"];
    const out = {};
    for (const k of keys) if (v[k] !== undefined) out[k] = typeof v[k] === "number" ? +v[k].toFixed(2) : v[k];
    const rest = JSON.stringify(v);
    return `${JSON.stringify(out)} | raw ${rest.slice(0, 500)}`;
  };
  console.log(`[cornell-ref] ${TAG}: DRAG ${dragName} ${steps} steps of ${DRAG_STEP} m in ${dragSecs} s (${(steps / Number(dragSecs)).toFixed(1)} Hz achieved)`);
  console.log(`  before: ${pick(before)}`);
  console.log(`  during: ${pick(during)}`);
  console.log(`  after:  ${pick(after)}`);
  console.log(`  cpuFrame (30 frames right after the drag): ${cpu.ok ? JSON.stringify(cpu.value).slice(0, 700) : cpu.error}`);
  const provoked = gi.slice(giBefore).filter((l) => /rebuild|hold|invalidate|wave|compile|grow|storm|bake|capture|light-track|motion|cap/i.test(l));
  console.log(`  [gi] lines during the drag: ${gi.length - giBefore}, of which rebuild/hold/compile: ${provoked.length}`);
  for (const l of provoked.slice(0, 12)) console.log(`    ${l}`);
}
const giImg = await shot("gi");
const profile = await call("profile.giPasses", { samples: 3 });
// PALETTE=1: the live slot palette — the albedo/emissive every attributed hit
// shades with (the transport's colours, not the raster's).
if (process.env.PALETTE) {
  const live = await page.evaluate(() => {
    const d = globalThis.__giSurfacePaletteDebug;
    if (!d) return null;
    const out = [];
    for (let i = 0; i < d.paletteSlots; i++) { const e = d.paletteEntry(i); if (e.live > 0.5) out.push({ slot: i, ...e }); }
    return { fallback: d.fallbackAlbedo, live: out };
  });
  console.log(`[cornell-ref] ${TAG}: palette ${live ? `${live.live.length} live, fallback ${live.fallback.map((v) => v.toFixed(2)).join("/")}` : "UNAVAILABLE"}`);
  for (const e of live?.live ?? []) console.log(`  slot ${e.slot}: albedo ${e.albedo.map((v) => v.toFixed(2)).join("/")} emissive ${e.emissive.map((v) => v.toFixed(1)).join("/")} emitter ${e.emitter}`);
}
// DEBUG_VIEW=indirect,occupancy: extra captures of the GI debug views (no numbers).
for (const view of (process.env.DEBUG_VIEW ?? "").split(",").filter(Boolean)) {
  await page.evaluate((v) => { globalThis.__giDebugView = v; }, view);
  await wait(4000);
  await shot(view);
  console.log(`[cornell-ref] ${TAG}: captured debug view "${view}"`);
}
await page.evaluate(() => { globalThis.__giDebugView = "off"; });
await wait(500);
// PT=0 skips the tracer (the "ours" columns still print; tracer reads as 0).
const PT_ON = process.env.PT !== "0";
if (PT_ON) await page.evaluate(() => { globalThis.__giDebugView = "path-tracer"; });
// The tracer is progressive and a small emitter at 1 spp is a field of dots:
// wait on ITS sample counter (three-gpu-pathtracer's `samples`), not the clock.
const tPt = Date.now();
let ptSamples = 0;
while (PT_ON && Date.now() - tPt < PT_MS) {
  await wait(2000);
  // WebGPUPathTracer has no `samples` property: per-pixel counts come back
  // from a GPU readback (`getSampleCountsAsync` → min/max/avg, samples/s).
  const st = await page.evaluate(async () => {
    const t = globalThis.__giPathTracer;
    if (!t) return { has: false, samples: 0 };
    try {
      const c = await t.getSampleCountsAsync();
      return { has: true, samples: c.avg, min: c.min, max: c.max, sps: +c.samplesPerSecond.toFixed(2), pause: t.pause,
        size: `${t._size?.x}x${t._size?.y}`, resetMs: Math.round(t._resetTime ?? -1), renderMs: Math.round(t.getRenderTime?.() ?? -1) };
    }
    catch (e) { return { has: true, samples: 0, error: String(e?.message ?? e) }; }
  });
  ptSamples = st.samples;
  if (process.env.PT_DIAG) console.log(`  tracer poll: ${JSON.stringify(st)} at ${((Date.now() - tPt) / 1000).toFixed(0)} s`);
  if (ptSamples >= PT_SAMPLES) break;
}
console.log(`[cornell-ref] ${TAG}: tracer at ${ptSamples.toFixed(1)} samples after ${((Date.now() - tPt) / 1000).toFixed(0)} s`);
const ptImg = PT_ON ? await shot("pt") : giImg;
await page.evaluate(() => { globalThis.__giDebugView = "off"; });

// ── world-space regions → canvas fractions through the pose ──────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const fwd = norm(sub(TARGET, EYE)), right = norm(cross(fwd, [0, 1, 0])), up = cross(right, fwd);
const tanV = Math.tan(((cam.fov ?? 60) * Math.PI) / 360), aspect = rect.width / rect.height;
const project = (p) => {
  const d = sub(p, EYE), z = dot(d, fwd);
  return { fx: 0.5 + 0.5 * (dot(d, right) / (z * tanV * aspect)), fy: 0.5 - 0.5 * (dot(d, up) / (z * tanV)) };
};
// Surfaces (world): floor y 0.24, ceiling y 5.21, back wall z -2.45, red wall
// x -2.07, green wall x 2.83. The Light (a 0.74×1.92×0.51 emissive box at
// (-0.72, 3.18, 1.52)) hides the back wall's upper left from this eye and the
// Box (1.5×3×1.5 at (1.41, 2.71, -1.0)) hides its lower right — the points
// below avoid both.
const REGIONS = [
  ["ceiling near red", [-1.2, 5.21, -1.0]],
  ["ceiling centre", [0.4, 5.21, -1.0]],
  ["ceiling near green", [2.0, 5.21, -1.0]],
  ["back wall low left", [-1.6, 1.2, -2.45]],
  ["back wall centre", [-0.3, 3.5, -2.45]],
  ["back wall high right", [1.6, 4.9, -2.45]],
  ["floor near red", [-1.3, 0.24, 0.5]],
  ["floor centre", [0.4, 0.24, 0.8]],
  ["floor near green", [2.2, 0.24, 0.5]],
  ["floor back centre", [0.7, 0.24, -1.9]],
  // The user's "phantom plane": a lighter ~2.4×1.2 m rectangle on the floor
  // centred near the WORLD origin (unprojected from their indirect capture at
  // eye (1.54, 4.33, 8.07) → (1.96, 2.47, -2.01): centre ≈ (0.2, 0.24, -0.45)).
  ["floor phantom", [0.2, 0.24, -0.45]],
  ["floor left of phantom", [-1.7, 0.24, -0.45]],
  ["red wall", [-2.07, 2.5, -0.5]],
  ["green wall", [2.83, 2.5, -0.5]],
];
const WIN_X = 0.02, WIN_Y = 0.03;
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function sample(img, fx, fy) {
  const x0 = Math.max(0, Math.round((fx - WIN_X) * img.width)), x1 = Math.min(img.width, Math.round((fx + WIN_X) * img.width));
  const y0 = Math.max(0, Math.round((fy - WIN_Y) * img.height)), y1 = Math.min(img.height, Math.round((fy + WIN_Y) * img.height));
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 3;
    R += lin(img.data[i] / 255); G += lin(img.data[i + 1] / 255); B += lin(img.data[i + 2] / 255); n++;
  }
  if (n === 0) return { R: 0, G: 0, B: 0, lum: 0, sat: 0, n };
  R /= n; G /= n; B /= n;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  return { R, G, B, lum: 0.2126 * R + 0.7152 * G + 0.0722 * B, sat: mx > 0 ? (mx - mn) / mx : 0, n };
}
const f = (v) => v.toFixed(3);
const rows = [];
console.log(`\n[cornell-ref] ${TAG}: ours vs tracer (linear means; sat = (max−min)/max; canvas ${rect.width}×${rect.height})`);
for (const [name, p0] of REGIONS) {
  const p = shifted(p0);
  const { fx, fy } = project(p);
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) { console.log(`  ${name.padEnd(22)} OFF-SCREEN (${f(fx)}, ${f(fy)})`); continue; }
  const a = sample(giImg, fx, fy), b = sample(ptImg, fx, fy);
  rows.push({ name, fx, fy, gi: a, pt: b, lumRatio: a.lum / Math.max(1e-4, b.lum) });
  console.log(`  ${name.padEnd(22)} ours ${f(a.R)}/${f(a.G)}/${f(a.B)} sat ${f(a.sat)} | tracer ${f(b.R)}/${f(b.G)}/${f(b.B)} sat ${f(b.sat)} | lum ours/tracer ${(a.lum / Math.max(1e-4, b.lum)).toFixed(2)}`);
}
const whites = rows.filter((r) => /ceiling|back wall|floor/.test(r.name));
const mean = (a) => a.reduce((p, q) => p + q, 0) / Math.max(1, a.length);
console.log(`  WHITES: sat ours ${f(mean(whites.map((r) => r.gi.sat)))} vs tracer ${f(mean(whites.map((r) => r.pt.sat)))}; lum ratio min/mean/max ${f(Math.min(...whites.map((r) => r.lumRatio)))}/${f(mean(whites.map((r) => r.lumRatio)))}/${f(Math.max(...whites.map((r) => r.lumRatio)))}`);
const sp = profile.ok ? profile.value?.srcProbes : null;
if (sp) {
  const b0 = sp.secondary?.byLod?.[0];
  console.log(`  receipts: tiles meanLum ${sp.tiles?.meanLum?.toFixed(3)} knownFrac ${sp.tiles?.knownFrac?.toFixed(2)} | bounce/direct ${b0?.bounceOverDirect} E ${b0?.meanIrradianceLuma} ρloop ${b0?.meanLoopAlbedoLuma} | unattributed ${sp.unattributedRate} | merge losRate ${sp.merge?.losRate?.toFixed(3)} orphanRate ${sp.merge?.orphanRate?.toFixed(3)} | farField raw ${JSON.stringify(sp.farField?.rawRgb8)}`);
}
writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify({ tag: TAG, flags: FLAGS, envLight: ENVLIGHT, eye: EYE, target: TARGET, rect, ptSamples, rows, profile: sp ?? null }, null, 2));
for (const l of gi.filter((l) => /path-tracer|failed|error/i.test(l)).slice(-6)) console.log(`  ${l}`);
for (const l of gi.slice(-3)) console.log(`  ${l}`);
for (const l of warnings.slice(-8)) console.log(`  console.${l}`);
await browser.close();
