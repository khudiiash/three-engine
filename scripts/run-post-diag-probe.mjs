/**
 * POST-PROCESS DIAGNOSTIC — boot a real project whose camera carries a
 * PostprocessComponent pointed at a `.post` asset, then read the LIVE
 * component state back: did the pipeline build, does it own the camera, is
 * the graph the real asset or the passthrough fallback?
 *
 * Answers, with numbers instead of theories, the report
 * "post processing is not appearing in the editor / in the build".
 *
 *   npx vite --port 5233 --strictPort
 *   node scripts/run-post-diag-probe.mjs http://localhost:5233/
 *
 * HEADED=1 to watch. KEEP=1 to leave the scratch project behind.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5233/";
// PROJECT=<existing project> runs the probe against a REAL project (read-only
// through the shim) instead of the scratch fixture.
const REAL = process.env.PROJECT ? path.resolve(process.env.PROJECT).replaceAll("\\", "/") : null;
const ROOT = REAL ?? path.join(os.tmpdir(), "post-diag-project").replaceAll("\\", "/");
const T0 = Date.now();
const stamp = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;

const write = (rel, contents) => {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return full;
};

if (!REAL) fs.rmSync(ROOT, { recursive: true, force: true });

// A .post shaped like the user's: GODRAYS ONLY (color + depth → godrays →
// output). God rays compile against a shadow-mapped light SNATCHED AT BUILD
// TIME — at boot that map does not exist yet, which is exactly the failure
// under test.
const POST_PATH = write(
  "post/Look.post",
  JSON.stringify({
    version: 1,
    graph: {
      nodes: [
        { id: "input", type: "input", props: {}, position: { x: 80, y: 160 } },
        { id: "shaft", type: "godrays", props: { density: 0.6, resolutionScale: "1" }, position: { x: 280, y: 160 } },
        { id: "output", type: "output", props: {}, position: { x: 480, y: 180 } },
      ],
      edges: [
        { id: "e1", source: "input", sourceHandle: "color", target: "shaft", targetHandle: "color" },
        { id: "e2", source: "input", sourceHandle: "depth", target: "shaft", targetHandle: "depth" },
        { id: "e3", source: "shaft", sourceHandle: "out", target: "output", targetHandle: "color" },
      ],
    },
  }),
);

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
      entity("floor", "Floor", [0, -0.5, 0], [
        { type: "mesh", props: { geometry: "box", geometryAsset: "", material: "", scale: [8, 0.2, 8] } },
      ]),
      // Shadow casting starts OFF: at boot the godrays graph compiles against
      // a world with NO shadow-mapped light (the boot-time state the user's
      // heavy scene hits because its map renders later). The probe switches
      // it on after settle — the light "materializes" — and the watcher must
      // rebuild the pipeline without any post param being touched.
      entity("sun", "Sun", [0, 5, 0], [{ type: "light", props: { castShadow: false, intensity: 3 } }]),
      entity("cam", "Camera", [0, 1.6, 4], [
        { type: "camera", props: {} },
        // Asset paths in component props are ABSOLUTE host paths (the
        // resolver passes them to the host fs verbatim).
        { type: "postprocess", props: { enabled: true, showInEditor: true, asset: POST_PATH } },
      ]),
    ],
  }),
);
write(
  "project.json",
  JSON.stringify({ name: "PostDiag", mainScene: "scenes/Main.scene", modules: ["postprocessing"], settings: {} }, null, 2),
);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "post-diag-")),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const postLines = [];
page.on("console", (m) => {
  const text = m.text();
  if (!text.trim()) return;
  if (/postprocess|post-process|postprocessing/i.test(text)) {
    postLines.push(`[${stamp()}] ${text.slice(0, 300)}`);
    console.log(`  console: ${postLines.at(-1)}`);
  }
});
page.on("pageerror", (err) => console.log(`[${stamp()}] PAGEERROR ${String(err?.message ?? err).slice(0, 300)}`));

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
console.log(`[${stamp()}] project opened`);

const ready = await page.waitForFunction(
  () => !!globalThis.__editorApi && document.querySelector("canvas") !== null,
  { timeout: 180_000, polling: 500 },
).then(() => true).catch(() => false);
console.log(`[${stamp()}] editor ${ready ? "up" : "NOT up"}`);
if (!ready) { await browser.close(); process.exit(1); }

// Let the boot finish and the render loop run a while — the load-time build
// and any self-heal both land inside this window.
await new Promise((r) => setTimeout(r, 25_000));

const read = () => page.evaluate(async () => {
  const { engine } = await import("/src/editor/engineInstance.js");
  let comp = null;
  let entityName = "";
  for (const ent of engine.entities.values()) {
    const c = ent.getComponent?.("postprocess");
    if (c) { comp = c; entityName = ent.name; break; }
  }
  if (!comp) return { found: false };
  let owns = null;
  try { owns = comp.ownsCamera(engine); } catch (err) { owns = `THREW: ${err?.message ?? err}`; }
  return {
    found: true,
    entityName,
    props: {
      enabled: comp.props.enabled,
      showInEditor: comp.props.showInEditor,
      asset: comp.props.asset,
      hasInlineGraph: !!comp.props.graph,
    },
    hasPipeline: !!comp.pipeline,
    hasOutputNode: !!comp.outputNode,
    hasScenePass: !!comp.scenePass,
    signature: comp.signature ?? null,
    godraysAwaitingLight: comp._godraysAwaitingLight === true,
    godraysShadowLight: !!comp._godraysShadowLight,
    generation: comp.generation ?? null,
    hasAssetGraph: !!comp.assetGraph,
    buildInFlight: comp._buildInFlight === true,
    registeredOverride: !!engine.renderOverrides?.has?.(comp),
    renderCameraIsEngineCamera: comp.renderCamera ? comp.renderCamera === engine.camera : null,
    ownCameraIsEngineCamera: comp.camera ? comp.camera === engine.camera : null,
    playing: engine.playing,
    ownsCamera: owns,
    overrideCount: engine.renderOverrides?.size ?? -1,
  };
});

console.log(`[${stamp()}] ── live state (edit mode) ──`);
console.log(JSON.stringify(await read(), null, 2));

// Now materialize the light — the exact move the pipeline never notices.
await page.evaluate(async () => {
  const { engine } = await import("/src/editor/engineInstance.js");
  for (const ent of engine.entities.values()) {
    const light = ent.getComponent?.("light");
    if (light) { light.setProp("castShadow", true); return "light castShadow → true"; }
  }
  return "no light found";
});
await new Promise((r) => setTimeout(r, 8_000));
console.log(`[${stamp()}] ── live state (light materialized) ──`);
console.log(JSON.stringify(await read(), null, 2));

// Play-mode check: the exported build runs this branch.
await page.evaluate(async () => {
  const { engine } = await import("/src/editor/engineInstance.js");
  engine.setPlaying(true);
});
await new Promise((r) => setTimeout(r, 6_000));
console.log(`[${stamp()}] ── live state (play mode) ──`);
console.log(JSON.stringify(await read(), null, 2));
await page.evaluate(async () => {
  const { engine } = await import("/src/editor/engineInstance.js");
  engine.setPlaying(false);
});

console.log(`[${stamp()}] ── postprocessing console lines ──`);
for (const line of postLines) console.log(`  ${line}`);

if (process.env.KEEP !== "1") fs.rmSync(ROOT, { recursive: true, force: true });
await browser.close();
