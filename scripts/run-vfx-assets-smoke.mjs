import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "engine-vfx-assets-"));
const clothPath = path.join(scratchRoot, "Shared cloth.vfx").replaceAll("\\", "/");
const waterPath = path.join(scratchRoot, "Shared water.vfx").replaceAll("\\", "/");
const particlePath = path.join(scratchRoot, "Shared particles.vfx").replaceAll("\\", "/");
const scenePath = path.join(scratchRoot, "Linked effects.scene").replaceAll("\\", "/");
fs.writeFileSync(path.join(scratchRoot, "project.json"), JSON.stringify({ name: "VFX Asset Smoke", modules: ["vfx", "particles", "cloth", "water"] }));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new", userDataDir: path.join(scratchRoot, "profile"),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" || /GPUValidationError|validation error|exceeds the maximum/i.test(message.text())) errors.push(`${message.text()} ${message.location().url ?? ""}`);
});
const check = (name, value) => { assert.ok(value, name); console.log(`ok ${name}`); };
async function op(name, args) { return page.evaluate((name, args) => __vfxCall(name, args), name, args); }
async function editNumber(id, label, value) {
  const handle = await page.evaluateHandle((id, label) => [...document.querySelectorAll(`.vfx-panel .react-flow__node[data-id="${id}"] .shader-node-row.field`)]
    .find((row) => row.querySelector(".param-label")?.textContent === label)?.querySelector("input"), id, label);
  assert.ok(handle.asElement(), `${id} has ${label}`);
  await handle.asElement().click();
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.keyboard.type(String(value)); await page.keyboard.press("Enter");
}
async function apply() {
  const handle = await page.evaluateHandle(() => [...document.querySelectorAll(".vfx-panel button")].find((button) => /^(Apply|Save)(?:\s*[•·])?$/.test(button.textContent.trim())));
  assert.ok(handle.asElement(), "Save/Apply exists"); await handle.asElement().click();
}

try {
  await page.setViewport({ width: 1600, height: 1000 });
  await installTauriShim(page, { writableRoot: scratchRoot });
  await page.evaluateOnNewDocument(() => {
    document.addEventListener("DOMContentLoaded", () => { const icon = document.createElement("link"); icon.rel = "icon"; icon.href = "data:,"; document.head.append(icon); }, { once: true });
    globalThis.__importLive = (p) => {
      const prefix = location.origin + p;
      const resources = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name === prefix || name.startsWith(`${prefix}?`));
      return import(resources.find((name) => name.includes("?")) ?? resources[0] ?? p);
    };
  });
  await page.goto(process.argv[2] ?? "http://localhost:5293/", { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Skip the project"))?.click());
  await page.waitForFunction(() => !!globalThis.__viewport?.orbit, { timeout: 60000 });
  await page.evaluate(async (projectRoot) => {
    const { engine } = await __importLive("/src/editor/engineInstance.js");
    const { callOp } = await __importLive("/src/editor/api/registry.js");
    const { setModuleEnabled } = await __importLive("/src/editor/modules.js");
    const { useProjectStore } = await __importLive("/src/editor/store/projectStore.js");
    await useProjectStore.getState().openProject(projectRoot);
    for (const kind of ["vfx", "particles", "cloth", "water"]) await setModuleEnabled(kind, true);
    globalThis.__vfxEngine = engine; globalThis.__vfxCall = callOp;
    globalThis.__vfxIds = [];
    for (const name of ["Shared Cloth A", "Shared Cloth B"]) {
      const created = await callOp("entity.create", { name });
      const id = created.id ?? created.entityId; __vfxIds.push(id);
      await callOp("component.add", { id, type: "mesh", props: { geometry: "plane" } });
      await callOp("component.add", { id, type: "cloth" });
    }
  }, scratchRoot);
  check("uses real WebGPU", await page.evaluate(() => __vfxEngine.renderer.backend.isWebGPUBackend));
  await op("vfx.create", { path: clothPath, kind: "cloth" });
  await op("vfx.create", { path: waterPath, kind: "water" });
  const initial = JSON.parse(fs.readFileSync(clothPath, "utf8"));
  check("creates a versioned cloth asset on disk", initial.version === 1 && initial.kind === "cloth" && initial.graph.nodes.length >= 4);
  const ids = await page.evaluate(() => __vfxIds);
  for (const entityId of ids) await op("vfx.assign", { entityId, kind: "cloth", path: clothPath });
  await page.waitForFunction((assetPath) => __vfxIds.every((id) => { const component = __vfxEngine.getEntity(id).getComponent("cloth"); return component.props.asset === assetPath && component.effectiveGraph && !component.vfxAssetError; }), {}, clothPath);
  check("one saved effect links to two components", true);
  const shared = await op("vfx.get", { path: clothPath });
  const graph = structuredClone(shared.graph ?? shared.document?.graph);
  assert.ok(graph?.nodes, "vfx.get returns asset graph");
  Object.assign(graph.nodes.find((node) => node.type === "grid").props, { width: 5, resolution: 12 });
  graph.nodes.find((node) => node.type === "cloth").props.stiffness = .5;
  await op("vfx.set", { path: clothPath, graph });
  await page.waitForFunction(() => __vfxIds.every((id) => { const c = __vfxEngine.getEntity(id).getComponent("cloth"); return c.resolvedProps.stiffness === .5 && c.simulation.resolution === 12; }));
  check("saving the shared graph updates both live simulations", JSON.parse(fs.readFileSync(clothPath, "utf8")).graph.nodes.find((node) => node.type === "cloth").props.stiffness === .5);
  const independent = await page.evaluate(async () => {
    const [a, b] = __vfxIds.map((id) => __vfxEngine.getEntity(id).getComponent("cloth"));
    const renderer = __vfxEngine.renderer;
    const distinct = a.simulation !== b.simulation && a.simulation.positions.value !== b.simulation.positions.value;
    a.setEnabledOverride(false); b.setEnabledOverride(false);
    try {
      a.restart(); b.restart(); a.simulation.tick(renderer, 0); b.simulation.tick(renderer, 0);
      for (let i = 0; i < 30; i++) a.simulation.tick(renderer, 1 / 120);
      const first = new Float32Array(await renderer.getArrayBufferAsync(a.simulation.positions.value));
      const second = new Float32Array(await renderer.getArrayBufferAsync(b.simulation.positions.value));
      return distinct && first.every(Number.isFinite) && second.every(Number.isFinite) && first.some((value, i) => Math.abs(value - second[i]) > .001);
    } finally { a.setEnabledOverride(null); b.setEnabledOverride(null); }
  });
  check("linked instances have independent evolving GPU state", independent);

  // A serialized wrong-kind path must remain recoverable even though the
  // assignment API rejects creating it interactively.
  let rejected = false;
  try { await op("vfx.assign", { entityId: ids[0], kind: "cloth", path: waterPath }); } catch { rejected = true; }
  check("asset assignment refuses another simulation kind", rejected);
  await page.evaluate(async (waterPath) => {
    const { createSimulationGraph } = await __importLive("/src/engine/vfx/simulationGraph.js");
    const c = __vfxEngine.getEntity(__vfxIds[0]).getComponent("cloth");
    c.setProp("graph", createSimulationGraph("cloth", { stiffness: .3, resolution: 8 }));
    c.setProp("asset", waterPath);
  }, waterPath);
  await page.waitForFunction(() => { const c = __vfxEngine.getEntity(__vfxIds[0]).getComponent("cloth"); return !!c.vfxAssetError && c.resolvedProps.stiffness === .3; });
  check("wrong-kind saved references keep their inline fallback", true);
  await page.evaluate((missingPath) => __vfxEngine.getEntity(__vfxIds[0]).getComponent("cloth").setProp("asset", missingPath), path.join(scratchRoot, "missing.vfx"));
  await page.waitForFunction(() => { const c = __vfxEngine.getEntity(__vfxIds[0]).getComponent("cloth"); return !!c.vfxAssetError && c.resolvedProps.stiffness === .3 && !!c.simulation; });
  check("missing assets keep an active inline fallback", true);
  await op("vfx.assign", { entityId: ids[0], kind: "cloth", path: clothPath });
  await page.waitForFunction(() => __vfxIds.every((id) => !__vfxEngine.getEntity(id).getComponent("cloth").vfxAssetError));

  graph.nodes.find((node) => node.type === "cloth").props.stiffness = .7;
  await op("vfx.set", { path: clothPath, graph });
  await page.waitForFunction(() => __vfxIds.every((id) => __vfxEngine.getEntity(id).getComponent("cloth").resolvedProps.stiffness === .7));
  check("legacy cloth assets remain editable through the API",true);


  for (const entityId of ids) {
    await op("component.add", { id: entityId, type: "water" });
    await op("component.add", { id: entityId, type: "particles" });
    await op("vfx.assign", { entityId, kind: "water", path: waterPath });
  }
  const water = await op("vfx.get", { path: waterPath });
  Object.assign(water.graph.nodes.find((node) => node.type === "grid").props, { width: 9, resolution: 12 });
  await op("vfx.set", { path: waterPath, graph: water.graph });
  await page.waitForFunction(() => __vfxIds.every((id) => { const c = __vfxEngine.getEntity(id).getComponent("water"); return c.effectiveGraph && c.resolvedProps.width === 9 && c.simulation.resolution === 12 && !c.vfxAssetError; }));
  check("shared water file updates both live GPU surfaces", true);

  const particles = await op("vfx.create", { path: particlePath, kind: "particles" });
  particles.graph.nodes.find((node) => node.type === "system").props.capacity = 128;
  particles.graph.nodes.find((node) => node.type === "emitSphere").props.radius = 1;
  const feed = particles.graph.edges.find((edge) => edge.targetHandle === "position");
  particles.graph.edges = particles.graph.edges.filter((edge) => edge !== feed);
  particles.graph.nodes.push({ id: "spawn-route", type: "__reroute", props: {}, position: { x: 300, y: 20 } });
  particles.graph.edges.push({ source: feed.source, sourceHandle: feed.sourceHandle, target: "spawn-route", targetHandle: "in" }, { source: "spawn-route", sourceHandle: "out", target: feed.target, targetHandle: feed.targetHandle });
  await op("vfx.set", { path: particlePath, graph: particles.graph });
  await op("vfx.assign", { entityId: ids[0], kind: "particles", path: particlePath });
  // Relative paths are how exported/project-authored scenes commonly link;
  // a save through the absolute asset path must notify this instance too.
  await page.evaluate(() => __vfxEngine.getEntity(__vfxIds[1]).getComponent("particles").setProp("asset", "Shared particles.vfx"));
  await page.waitForFunction(() => __vfxIds.every((id) => { const c = __vfxEngine.getEntity(id).getComponent("particles"); return c.compiled && c.subsystems?.[0]?.sysProps.capacity === 128 && !c.vfxAssetError; }), { timeout: 30000 });
  const rerouteSpawn = await page.evaluate(async () => {
    const c = __vfxEngine.getEntity(__vfxIds[0]).getComponent("particles");
    const renderer = __vfxEngine.renderer;
    c.setEnabledOverride(false);
    try {
      const sub = c.subsystems[0]; renderer.compute(sub.initCompute);
      const positions = new Float32Array(await renderer.getArrayBufferAsync(sub.positions.value));
      const stride = positions.length / sub.sysProps.capacity;
      const radii = [];
      for (let i = 0; i < positions.length; i += stride) radii.push(Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
      return radii.every((radius) => Number.isFinite(radius) && radius <= 1.01) && Math.max(...radii) > .5;
    } finally { c.setEnabledOverride(null); }
  });
  check("particle asset reroute reaches the GPU sphere emitter", rerouteSpawn);
  particles.graph.nodes.find((node) => node.type === "system").props.capacity = 256;
  await op("vfx.set", { path: particlePath, graph: particles.graph });
  await page.waitForFunction(() => __vfxIds.every((id) => __vfxEngine.getEntity(id).getComponent("particles").subsystems?.[0]?.sysProps.capacity === 256), { timeout: 30000 });
  check("absolute saves update absolute and relative particle links", true);

  await page.evaluate(async (assetPath) => {
    const { useSelectionStore } = await __importLive("/src/editor/store/selectionStore.js");
    const { openPanel } = await __importLive("/src/editor/EditorShell.jsx");
    useSelectionStore.getState().selectAsset(assetPath); openPanel("particles");
  }, particlePath);
  await page.waitForFunction((assetPath) => document.querySelector(".vfx-graph-workspace")?.dataset.vfxDocument === assetPath && !!document.querySelector('.vfx-panel .react-flow__node[data-id="emit"]'), { timeout: 30000 }, particlePath);
  await editNumber("emit", "Radius", 1.4); await apply();
  await page.waitForFunction(() => __vfxIds.every((id) => __vfxEngine.getEntity(id).getComponent("particles").effectiveGraph.nodes.find((n)=>n.id==="emit").props.radius===1.4));
  check("particle asset editor saves and updates both linked instances without entity selection",JSON.parse(fs.readFileSync(particlePath,"utf8")).graph.nodes.find((n)=>n.id==="emit").props.radius===1.4);

  await page.evaluate(async (scenePath) => {
    const { serializeScene } = await __importLive("/src/engine/index.js");
    await window.__TAURI_INTERNALS__.invoke("save_scene", { path: scenePath, contents: JSON.stringify(serializeScene(__vfxEngine), null, 2) });
  }, scenePath);
  check("scene serializes both asset references", fs.readFileSync(scenePath, "utf8").split("Shared cloth.vfx").length - 1 === 2);
  await op("scene.open", { path: scenePath });
  await page.waitForFunction((assetPath) => __vfxIds.every((id) => { const c = __vfxEngine.getEntity(id)?.getComponent("cloth"); return c?.props.asset === assetPath && c.effectiveGraph && c.resolvedProps.stiffness === .7 && !c.vfxAssetError; }), { timeout: 30000 }, clothPath);
  check("scene reload restores both shared references and simulations", true);
  await page.waitForFunction(() => __vfxIds.every((id) => { const e = __vfxEngine.getEntity(id); return e.getComponent("water")?.resolvedProps.width === 9 && e.getComponent("particles")?.subsystems?.[0]?.sysProps.capacity === 256; }), { timeout: 30000 });
  check("scene reload restores shared water and particle assets", true);
  await page.screenshot({ path: path.join(scratchRoot, "vfx-assets.png") });
  await page.evaluate(() => __vfxEngine.renderer.backend.device.queue.onSubmittedWorkDone());
  check("no page, console, or WebGPU errors", errors.length === 0);
  console.log(`VFX-ASSETS PASS\nArtifacts: ${scratchRoot}`);
} catch (error) {
  console.error(error, errors);
  await page.screenshot({ path: path.join(scratchRoot, "failure.png") }).catch(() => {});
  fs.writeFileSync(path.join(scratchRoot, "errors.json"), JSON.stringify(errors, null, 2));
  console.error(`Artifacts: ${scratchRoot}`); process.exitCode = 1;
} finally { await browser.close(); }
