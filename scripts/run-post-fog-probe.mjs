/**
 * VOLUMETRIC FOG / LENS FLARE / RADIAL BLUR — does the WGSL actually build,
 * and does the effect actually change the image?
 *
 * `node --test tests/post-volumetric-fog.test.mjs` can only see the CPU-side
 * node graph; every one of these three effects is a shader that is compiled
 * later, by a real renderer, and a TSL type error there surfaces as a WGSL
 * validation failure and a dead viewport. So: boot a real project in real
 * Chrome with real WebGPU, put each graph on the camera in turn, and report
 *
 *   1. every console error / page error the build produced, and
 *   2. the MEAN CANVAS COLOUR with the effect on vs. off — a number, so
 *      "it compiled" and "it did something" are separate answers.
 *
 *   npx vite --port 5233 --strictPort
 *   node scripts/run-post-fog-probe.mjs http://localhost:5233/
 *
 * HEADED=1 to watch. KEEP=1 to leave the scratch project behind.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5233/";
const ROOT = path.join(os.tmpdir(), "post-fog-project").replaceAll("\\", "/");
const T0 = Date.now();
const stamp = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;

const write = (rel, contents) => {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
};

fs.rmSync(ROOT, { recursive: true, force: true });

const node = (id, type, props, x, y) => ({ id, type, props, position: { x, y } });
const edge = (id, source, sourceHandle, target, targetHandle) => ({ id, source, sourceHandle, target, targetHandle });

/** input(color,depth) → volumetricFog → output. */
const FOG_GRAPH = (props = {}) => ({
  nodes: [
    node("input", "input", {}, 80, 160),
    node("fog", "volumetricFog", { ...props }, 300, 160),
    node("output", "output", {}, 540, 180),
  ],
  edges: [
    edge("e1", "input", "color", "fog", "color"),
    edge("e2", "input", "depth", "fog", "depth"),
    edge("e3", "fog", "out", "output", "color"),
  ],
});

/** input → bloom → lensflare → add(beauty) → output — three's own composite. */
const FLARE_GRAPH = {
  nodes: [
    node("input", "input", {}, 80, 160),
    node("bloom", "bloom", { strength: 1.5, threshold: 0.4 }, 280, 240),
    node("flare", "lensflare", { threshold: 0.2 }, 480, 240),
    node("sum", "add", {}, 680, 160),
    node("output", "output", {}, 860, 160),
  ],
  edges: [
    edge("e1", "input", "color", "bloom", "color"),
    edge("e2", "bloom", "out", "flare", "color"),
    edge("e3", "input", "color", "sum", "a"),
    edge("e4", "flare", "out", "sum", "b"),
    edge("e5", "sum", "out", "output", "color"),
  ],
};

/** input → radialBlur → output. */
const RADIAL_GRAPH = {
  nodes: [
    node("input", "input", {}, 80, 160),
    node("blur", "radialBlur", { weight: 0.9, decay: 0.95, count: 32, exposure: 5 }, 300, 160),
    node("output", "output", {}, 540, 160),
  ],
  edges: [
    edge("e1", "input", "color", "blur", "color"),
    edge("e2", "blur", "out", "output", "color"),
  ],
};

const POST_PATH = write("post/Look.post", JSON.stringify({ version: 1, graph: FOG_GRAPH() }));

const entity = (id, name, position, components) => ({
  id, name, position, rotation: [0, 0, 0], scale: [1, 1, 1],
  viewOnly: false, enabledInEditor: true, enabledInGame: true,
  components, children: [],
});

write(
  "scenes/Main.scene",
  JSON.stringify({
    version: 1,
    name: "Main",
    settings: {},
    entities: [
      // A floor at y=0 (the fog's default ground level) and pillars at
      // several depths — the depth edges are what the JBU upsample has to
      // hold, and what a broken guide smears across.
      entity("floor", "Floor", [0, -0.1, 0], [
        { type: "mesh", props: { geometry: "box", geometryAsset: "", material: "", scale: [60, 0.2, 60] } },
      ]),
      entity("near", "Near", [-2, 1, -4], [
        { type: "mesh", props: { geometry: "box", geometryAsset: "", material: "", scale: [1, 2, 1] } },
      ]),
      entity("mid", "Mid", [2, 1.5, -12], [
        { type: "mesh", props: { geometry: "box", geometryAsset: "", material: "", scale: [1.5, 3, 1.5] } },
      ]),
      entity("far", "Far", [-1, 2.5, -30], [
        { type: "mesh", props: { geometry: "box", geometryAsset: "", material: "", scale: [2, 5, 2] } },
      ]),
      entity("sun", "Sun", [4, 8, 4], [{ type: "light", props: { castShadow: true, intensity: 3 } }]),
      entity("cam", "Camera", [0, 2, 6], [
        { type: "camera", props: {} },
        { type: "postprocess", props: { enabled: true, showInEditor: true, asset: POST_PATH } },
      ]),
    ],
  }),
);
write(
  "project.json",
  JSON.stringify({ name: "PostFog", mainScene: "scenes/Main.scene", modules: ["postprocessing"], settings: {} }, null, 2),
);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "post-fog-")),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

/** Everything that looks like a failure, kept per phase. */
let phase = "boot";
const problems = [];
const noteProblem = (text) => {
  const line = `[${phase} ${stamp()}] ${text.slice(0, 400)}`;
  problems.push(line);
  console.log(`  ⚠ ${line}`);
};
page.on("console", (m) => {
  const text = m.text();
  if (!text.trim()) return;
  // WGSL failures arrive as plain console errors from the WebGPU backend, not
  // as exceptions — "Shader ... parsing/validation", "Error while parsing WGSL".
  // The engine's own lifecycle lines mention "pipeline" and "shader" constantly
  // and are not failures; counting them made the verdict cry wolf.
  const benign = /^\[(postprocessing|engine)\]/.test(text) || /adapter ok/.test(text);
  if (!benign && (m.type() === "error" || /WGSL|Tint|parsing|validation|Invalid/i.test(text))) noteProblem(text);
  else if (/addon|not available|volumetricFog|Volumetric Fog|Lens Flare|Radial Blur|postprocessing/i.test(text)) {
    console.log(`  console: [${stamp()}] ${text.slice(0, 220)}`);
  }
});
page.on("pageerror", (err) => noteProblem(`PAGEERROR ${String(err?.stack ?? err)}`));

await installTauriShim(page, {});
await page.evaluateOnNewDocument((project) => {
  localStorage.clear();
  localStorage.setItem("engine.projectRoot.v1", project);
  localStorage.setItem("engine.recentProjects.v1", JSON.stringify([project]));
  globalThis.__editorNoAutoOpen = true;
  globalThis.__editorKeepRendering = true;
}, ROOT);

console.log(`[${stamp()}] goto ${url}`);
await page.goto(url, { waitUntil: "load", timeout: 60_000 });
await page.waitForSelector(".hub-recent-open-btn", { timeout: 60_000 });
await page.evaluate((project) => {
  const rows = [...document.querySelectorAll(".hub-recent")];
  const row = rows.find((r) => (r.getAttribute("title") ?? "").replaceAll("\\", "/") === project) ?? rows[0];
  row?.querySelector(".hub-recent-open-btn")?.click();
}, ROOT);

const ready = await page.waitForFunction(
  () => !!globalThis.__editorApi && document.querySelector("canvas") !== null,
  { timeout: 180_000, polling: 500 },
).then(() => true).catch(() => false);
console.log(`[${stamp()}] editor ${ready ? "up" : "NOT up"}`);
if (!ready) { await browser.close(); process.exit(1); }

await new Promise((r) => setTimeout(r, 20_000));

/** Mean canvas colour + how much of the frame is not background. */
const stats = () => page.evaluate(async () => {
  const { engine } = await import("/src/editor/engineInstance.js");
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const ctx2d = c.getContext("2d");
      ctx2d.drawImage(src, 0, 0);
      const { data } = ctx2d.getImageData(0, 0, c.width, c.height);
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      const n = data.length / 4;
      resolve({ r: +(r / n).toFixed(2), g: +(g / n).toFixed(2), b: +(b / n).toFixed(2), px: n });
    }));
  });
});

/** Mean colour of the bottom `frac` of the frame — where the FLOOR is. */
const floorStats = (frac = 0.3) => page.evaluate(async (f) => {
  const { engine } = await import("/src/editor/engineInstance.js");
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const src = engine.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx2d = c.getContext("2d");
      ctx2d.drawImage(src, 0, 0);
      const y0 = Math.floor(c.height * (1 - f));
      const { data } = ctx2d.getImageData(0, y0, c.width, c.height - y0);
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      const n = data.length / 4;
      resolve({ r: +(r / n).toFixed(2), g: +(g / n).toFixed(2), b: +(b / n).toFixed(2) });
    }));
  });
}, frac);

/** Live component state — did the pipeline actually build this graph? */
const readComp = () => page.evaluate(async () => {
  const { engine } = await import("/src/editor/engineInstance.js");
  let comp = null;
  for (const ent of engine.entities.values()) {
    const c = ent.getComponent?.("postprocess");
    if (c) { comp = c; break; }
  }
  if (!comp) return { found: false };
  return {
    found: true,
    hasPipeline: !!comp.pipeline,
    passthrough: comp.signature === "__passthrough__",
    tickers: comp.compiled?.tickers?.length ?? 0,
    frames: engine.renderer?.info?.render?.frame ?? null,
    drawCalls: engine.renderer?.info?.render?.drawCalls ?? null,
  };
});

/** Swap the live graph (the editor's own apply path, not a file rewrite). */
const applyGraph = (graph) => page.evaluate(async (g) => {
  const { engine } = await import("/src/editor/engineInstance.js");
  for (const ent of engine.entities.values()) {
    const comp = ent.getComponent?.("postprocess");
    if (comp) { comp.applyGraph(g); return true; }
  }
  return false;
}, graph);

/**
 * Which effect functions the graph ACTUALLY resolved. A failed dynamic import
 * compiles the node to a passthrough with only a console warning, which on a
 * dev server that answers 504 "Outdated Optimize Dep" looks exactly like "the
 * effect does nothing" — so ask directly rather than inferring it from pixels.
 */
const addonsFor = (graph) => page.evaluate(async (g) => {
  const mod = await import("/src/modules/postprocessing/postGraph.js");
  const loaded = await mod.loadAddonsForGraph(g);
  return Object.fromEntries(
    [...mod.collectPostAddonKeys(g)].map((k) => [k, typeof loaded[k] === "function"]),
  );
}, graph);

/** Did the cloud-noise worker deliver? Zeros read as "no fog", not as an error. */
const noiseState = () => page.evaluate(async () => {
  const mod = await import("/src/modules/postprocessing/volumetricFog.js");
  const data = mod.cloudNoiseTexture(64).image.data;
  const n = Math.ceil(data.length / 97);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < data.length; i += 97) { sum += data[i]; max = Math.max(max, data[i]); }
  return { samples: n, mean: +(sum / n).toFixed(2), max };
});

const report = {};

// ── 1. FOG: on vs off, through the HOT path (no rebuild) ───────────────────
phase = "fog";
console.log(`[${stamp()}] ── volumetric fog ──`);
console.log(JSON.stringify(await readComp(), null, 2));
report.fogAddons = await addonsFor(FOG_GRAPH());
report.noise = await noiseState();
console.log(`  addons: ${JSON.stringify(report.fogAddons)}  noise: ${JSON.stringify(report.noise)}`);
report.fogOn = await stats();
console.log(`  mean(on)  = ${JSON.stringify(report.fogOn)}`);

// Intensity is a hot param: this must retune the live shader without a rebuild.
await applyGraph(FOG_GRAPH({ intensity: 0 }));
await new Promise((r) => setTimeout(r, 6_000));
report.fogOff = await stats();
console.log(`  mean(off) = ${JSON.stringify(report.fogOff)}`);
report.fogDelta = +(report.fogOn.r - report.fogOff.r).toFixed(2);
console.log(`  Δred = ${report.fogDelta}`);

// SWEEP=1 walks the density knob through the HOT path (no rebuild between
// steps) so the default can be CHOSEN from numbers instead of taste. The scene
// mean saturates toward the fog colour; a usable default leaves the scene
// readable rather than white.
if (process.env.SWEEP) {
  phase = "sweep";
  console.log(`[${stamp()}] -- density sweep --`);
  for (const density of [0.1, 0.2, 0.3, 0.5, 0.75, 1.05]) {
    await applyGraph(FOG_GRAPH({ density }));
    await new Promise((r) => setTimeout(r, 4_000));
    const s2 = await stats();
    console.log(`  density ${String(density).padEnd(5)} mean = ${JSON.stringify(s2)}`);
  }
  await applyGraph(FOG_GRAPH());
  await new Promise((r) => setTimeout(r, 4_000));
}

// ── 1b. Each DENOISER mode is a different shader ───────────────────────────
// "Gaussian" hands the low-res R8 buffer to three's blur addon and "Off"
// samples it raw; only "JBU" shares a code path with the measurement above, so
// a type error in either of the others would ship unnoticed. `hfNoise` is the
// mean absolute difference between horizontally adjacent pixels: the march is
// dithered per pixel, so a denoiser that is doing its job LOWERS it.
phase = "denoiser";
console.log(`[${stamp()}] -- denoiser modes --`);
for (const mode of ["JBU", "Gaussian", "Off"]) {
  await applyGraph(FOG_GRAPH({ denoiser: mode }));
  await new Promise((r) => setTimeout(r, 8_000));
  const s2 = await page.evaluate(async () => {
    const { engine } = await import("/src/editor/engineInstance.js");
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const src = engine.renderer.domElement;
        const c = document.createElement("canvas");
        c.width = src.width; c.height = src.height;
        const ctx2d = c.getContext("2d");
        ctx2d.drawImage(src, 0, 0);
        const { data } = ctx2d.getImageData(0, 0, c.width, c.height);
        let sum = 0, hf = 0, n = 0;
        for (let y = 0; y < c.height; y++) {
          for (let x = 1; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            sum += data[i];
            hf += Math.abs(data[i] - data[i - 4]);
            n++;
          }
        }
        resolve({ mean: +(sum / n).toFixed(2), hfNoise: +(hf / n).toFixed(3) });
      }));
    });
  });
  console.log(`  ${mode.padEnd(9)} ${JSON.stringify(s2)}`);
  report[`denoiser_${mode}`] = s2;
}

// ── 2. LENS FLARE ──────────────────────────────────────────────────────────
phase = "lensflare";
console.log(`[${stamp()}] ── lens flare ──`);
await applyGraph(FLARE_GRAPH);
await new Promise((r) => setTimeout(r, 12_000));
report.lensflareAddons = await addonsFor(FLARE_GRAPH);
console.log(`  addons: ${JSON.stringify(report.lensflareAddons)}`);
report.lensflare = await readComp();
report.lensflareStats = await stats();
console.log(JSON.stringify(report.lensflare, null, 2), JSON.stringify(report.lensflareStats));

// ── 3. RADIAL BLUR ─────────────────────────────────────────────────────────
phase = "radialblur";
console.log(`[${stamp()}] ── radial blur ──`);
await applyGraph(RADIAL_GRAPH);
await new Promise((r) => setTimeout(r, 12_000));
report.radialBlurAddons = await addonsFor(RADIAL_GRAPH);
console.log(`  addons: ${JSON.stringify(report.radialBlurAddons)}`);
report.radialBlur = await readComp();
report.radialBlurStats = await stats();
console.log(JSON.stringify(report.radialBlur, null, 2), JSON.stringify(report.radialBlurStats));

// ── 4. THE SUN: does the fog react to the light at all? ────────────────────
// Recolour the scene's light and read the fog back. A fog that only lerps
// toward a constant (three's example) cannot move here; one that integrates
// scattering must.
phase = "sun";
console.log(`[${stamp()}] -- sun reaction --`);
await applyGraph(FOG_GRAPH());
await new Promise((r) => setTimeout(r, 8_000));
const setSun = (hex) => page.evaluate(async (h) => {
  const { engine } = await import("/src/editor/engineInstance.js");
  for (const ent of engine.entities.values()) {
    const l = ent.getComponent?.("light")?.light;
    if (l) { l.color.setHex(h); return true; }
  }
  return false;
}, hex);
for (const [name, hex] of [["red", 0xff2020], ["blue", 0x2020ff]]) {
  await setSun(hex);
  await new Promise((r) => setTimeout(r, 3_000));
  const s2 = await stats();
  report[`sun_${name}`] = s2;
  console.log(`  sun ${name.padEnd(5)} mean = ${JSON.stringify(s2)}  (r-b = ${(s2.r - s2.b).toFixed(2)})`);
}
await setSun(0xffffff);

// ── 5. PLAY MODE ───────────────────────────────────────────────────────────
// The reported bug: "floor is not in fog in play mode". In play the active
// camera is a CHILD of its entity, so anything reading `camera.position`
// instead of the world matrix marches from the wrong origin. Park the editor
// viewport at the game camera's exact world pose first, so edit and play are
// photographs of the same thing.
phase = "play";
console.log(`[${stamp()}] -- play mode --`);
await page.evaluate(() => globalThis.__editorApi.call("viewport.setCamera", { position: [0, 2, 6], target: [0, 2, -4] }));
await new Promise((r) => setTimeout(r, 4_000));
report.floorEdit = await floorStats();
console.log(`  floor(edit)     = ${JSON.stringify(report.floorEdit)}`);

await page.evaluate(async () => { const m = await import("/src/editor/playMode.js"); await m.play(); });
await new Promise((r) => setTimeout(r, 14_000));
report.playing = await page.evaluate(async () => {
  const { engine } = await import("/src/editor/engineInstance.js");
  return engine.playing;
});
report.floorPlay = await floorStats();
console.log(`  playing = ${report.playing}`);
console.log(`  floor(play)     = ${JSON.stringify(report.floorPlay)}`);

await applyGraph(FOG_GRAPH({ intensity: 0 }));
await new Promise((r) => setTimeout(r, 6_000));
report.floorPlayNoFog = await floorStats();
console.log(`  floor(play, fog off) = ${JSON.stringify(report.floorPlayNoFog)}`);
const dFloorPlay = +(report.floorPlay.r - report.floorPlayNoFog.r).toFixed(2);
const dFloorModes = +(Math.abs(report.floorPlay.r - report.floorEdit.r)).toFixed(2);
console.log(`  floor fogged in play: ${dFloorPlay > 5 ? "YES" : "NO"} (d ${dFloorPlay});  edit-vs-play gap: ${dFloorModes}`);

await page.evaluate(async () => { const m = await import("/src/editor/playMode.js"); await m.stop(); });
await new Promise((r) => setTimeout(r, 8_000));

// A passthrough graph, measured last: without it "the effect changed the
// image" has nothing to be a change FROM.
phase = "baseline";
console.log(`[${stamp()}] -- baseline (passthrough) --`);
await applyGraph({
  nodes: [node("input", "input", {}, 80, 160), node("output", "output", {}, 300, 160)],
  edges: [edge("e1", "input", "color", "output", "color")],
});
await new Promise((r) => setTimeout(r, 8_000));
report.baseline = await stats();
console.log(`  mean(baseline) = ${JSON.stringify(report.baseline)}`);

const delta = (x, y) => +(Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b)).toFixed(2);
console.log(`  fog       d(baseline) = ${delta(report.fogOn, report.baseline)}  [intensity 0: ${delta(report.fogOff, report.baseline)}]`);
console.log(`  lensflare d(baseline) = ${delta(report.lensflareStats, report.baseline)}`);
console.log(`  radial    d(baseline) = ${delta(report.radialBlurStats, report.baseline)}`);

console.log(`\n[${stamp()}] ══ verdict ══`);
console.log(`fog changed the image: ${Math.abs(report.fogDelta) > 1 ? "YES" : "NO"} (Δred ${report.fogDelta})`);
console.log(`problems: ${problems.length}`);
for (const p of problems.slice(0, 25)) console.log(`  ${p}`);

if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
await browser.close();
process.exit(problems.length ? 2 : 0);
