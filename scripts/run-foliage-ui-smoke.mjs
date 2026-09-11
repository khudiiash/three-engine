import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

// Run alone after the GPU smoke, against a freshly started Vite server.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-foliage-ui-"));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new", userDataDir: path.join(root, "profile"),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
page.on("console", (message) => {
  if (message.type() === "error" || /GPUValidationError|validation error|exceeds the maximum/i.test(message.text())) errors.push(message.text());
});
const check = (name, value) => { assert.ok(value, name); console.log(`ok ${name}`); };
const control = async (label, selector = "input") => {
  const handle = await page.evaluateHandle((label, selector) => [...document.querySelectorAll("[data-foliage-section] .field-row")]
    .find((row) => row.querySelector(".field-label")?.textContent === label)?.querySelector(selector), label, selector);
  assert.ok(handle.asElement(), `Foliage field ${label}`);
  return handle.asElement();
};
async function editNumber(label, value) {
  const input = await control(label);
  await input.click();
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.keyboard.type(String(value)); await page.keyboard.press("Enter");
}
async function shortcut(redo = false) {
  await page.evaluate(() => document.activeElement?.blur());
  const viewport = await page.$(".viewport-panel canvas");
  const bounds = await viewport?.boundingBox();
  if (bounds) await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.keyboard.down("Control");
  if (redo) await page.keyboard.down("Shift");
  await page.keyboard.press("KeyZ");
  if (redo) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}
try {
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  await installTauriShim(page, { writableRoot: root });
  await page.evaluateOnNewDocument(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const icon = document.createElement("link"); icon.rel = "icon"; icon.href = "data:,"; document.head.append(icon);
    }, { once: true });
    globalThis.__importLive = (p) => {
      const prefix = location.origin + p;
      const resources = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
      return import(resources.find((n) => n.includes("?")) ?? resources[0] ?? p);
    };
  });
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5335/", { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Skip the project"))?.click());
  await page.waitForFunction(() => !!globalThis.__viewport?.orbit, { timeout: 60000 });
  await page.evaluate(async (root) => {
    const { engine } = await __importLive("/src/editor/engineInstance.js");
    const { useProjectStore } = await __importLive("/src/editor/store/projectStore.js");
    const { useSceneStore } = await __importLive("/src/editor/store/sceneStore.js");
    const { useSelectionStore } = await __importLive("/src/editor/store/selectionStore.js");
    const { commandBus } = await __importLive("/src/editor/commands/CommandBus.js");
    const { setModuleEnabled } = await __importLive("/src/editor/modules.js");
    const { openPanel } = await __importLive("/src/editor/EditorShell.jsx");
    useProjectStore.setState({ rootPath: root, currentPath: root, projectMeta: { modules: ["terrain"] } });
    await setModuleEnabled("terrain", true);
    engine.clear();
    const terrain = engine.createEntity({ id: "foliage-smoke-ground", name: "Foliage Smoke Ground" });
    terrain.addComponent("terrain", { size: 12, resolution: 8 });
    const surface = engine.createEntity({ id: "foliage-smoke-mesh", name: "Other Mesh Surface" });
    surface.setTransform({ position: [20, 0, 0], rotation: [-90, 0, 0], scale: [8, 8, 1] });
    surface.addComponent("mesh", { geometry: "plane" });
    const light = engine.createEntity({ name: "Sun" });
    light.addComponent("light", { kind: "directional", intensity: 3 });
    useSceneStore.getState().refresh(); useSelectionStore.getState().select(terrain.id);
    commandBus.clearHistory();
    openPanel("hierarchy"); openPanel("inspector");
    Object.assign(globalThis, { __foliageEngine: engine, __foliageSelection: useSelectionStore, __foliageBus: commandBus });
  }, root);
  await page.waitForSelector('[data-foliage-surface="foliage-smoke-ground"]');
  check("Terrain offers procedural foliage before its module is enabled", await page.evaluate(() => !__foliageEngine.modules.has("foliage")));
  const grass = await page.evaluateHandle(() => [...document.querySelectorAll('[data-foliage-surface="foliage-smoke-ground"] button')].find((button) => button.textContent === "Grass"));
  await grass.asElement().click();
  await page.waitForSelector("[data-foliage-section]", { timeout: 30000 });
  await page.waitForFunction(() => {
    const entity = __foliageEngine.getEntity(__foliageSelection.getState().ids[0]);
    if (!(entity?.getComponent("foliage")?.stats?.instances > 0)) return false;
    globalThis.__foliageId = entity.id;
    return true;
  }, { timeout: 45000 });
  const created = await page.evaluate(() => {
    const entity = __foliageEngine.getEntity(__foliageId), foliage = entity.getComponent("foliage");
    return { parent: entity.parent?.id, ...foliage.props, instances: foliage.stats.instances, history: __foliageBus.undoStack.length };
  });
  check("Grass button enables Foliage and creates populated terrain scatter", created.surface === "foliage-smoke-ground" && created.parent === created.surface && created.species === "grass" && created.distribution === "scatter" && created.instances > 0);
  check("Creation is one undo step", created.history === 1);
  check("Foliage enabling persists in project.json", JSON.parse(fs.readFileSync(path.join(root, "project.json"), "utf8")).modules.includes("foliage"));
  await shortcut();
  await page.waitForFunction(() => !__foliageEngine.getEntity(__foliageId));
  await shortcut(true);
  await page.waitForFunction(() => !!__foliageEngine.getEntity(__foliageId)?.getComponent("foliage"));
  check("Real Ctrl+Z / Ctrl+Shift+Z remove and restore the entire layer with its id", true);
  await page.evaluate(() => __foliageSelection.getState().select(__foliageId));
  await page.waitForSelector("[data-foliage-section]");
  await editNumber("Plants / m²", 1.25);
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.density === 1.25);
  await shortcut();
  await page.waitForFunction((density) => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.density === density, {}, created.density);
  await shortcut(true);
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.density === 1.25);
  check("Density edits work live and keyboard undo/redo restores them", true);

  await (await control("Surface", '[role="button"]')).click();
  const meshChoice = await page.evaluateHandle(() => [...document.querySelectorAll('.entity-browser [role="option"]')].find((button) => button.textContent.includes("Other Mesh Surface")));
  await meshChoice.asElement().click();
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.surface === "foliage-smoke-mesh");
  check("Surface browser retargets terrain foliage onto an ordinary mesh", true);
  await (await control("Species", "button")).click();
  const flowersChoice = await page.evaluateHandle(() => [...document.querySelectorAll('.tx-select-menu button')].find((button) => button.textContent.trim() === "Wildflowers"));
  await flowersChoice.asElement().click();
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.species === "wildflowers");
  const flowers = await page.evaluate(() => ({ ...__foliageEngine.getEntity(__foliageId).getComponent("foliage").props }));
  check("Species preset changes shape and density while retaining the selected surface", flowers.surface === "foliage-smoke-mesh" && flowers.height < 1 && flowers.density === 0.8);
  await shortcut();
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.species === "grass");
  check("A multi-property species preset is one keyboard undo", await page.evaluate(() => __foliageEngine.getEntity(__foliageId).getComponent("foliage").props.density === 1.25));

  // Match sceneIO's selection clearing before replacing the scene. A raw
  // deserializer does not own editor TransformControls or their selection.
  await page.evaluate(() => __foliageSelection.getState().clear());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reload = await page.evaluate(async () => {
    const { serializeScene, deserializeScene, getModuleDefinition } = await __importLive("/src/engine/index.js");
    const scene = JSON.parse(JSON.stringify(serializeScene(__foliageEngine)));
    globalThis.__foliageSavedScene = scene;
    await deserializeScene(__foliageEngine, scene);
    __foliageSelection.getState().select(__foliageId);
    return { registered: getModuleDefinition("foliage")?.components[0]?.type, props: __foliageEngine.getEntity(__foliageId)?.getComponent("foliage")?.props };
  });
  check("Scene reload restores module component and the explicit mesh surface", reload.registered === "foliage" && reload.props?.surface === "foliage-smoke-mesh");
  await page.waitForFunction(() => __foliageEngine.getEntity(__foliageId)?.getComponent("foliage")?.stats.instances > 0, { timeout: 45000 });
  await page.screenshot({ path: path.join(root, "foliage-authoring.png") });
  check("No editor or WebGPU errors", errors.length === 0);
  console.log(`FOLIAGE-UI PASS\nArtifacts: ${root}`);
} catch (error) {
  console.error(error, errors);
  await page.screenshot({ path: path.join(root, "failure.png") }).catch(() => {});
  console.error(`FOLIAGE-UI FAIL\nArtifacts: ${root}`);
  process.exitCode = 1;
} finally { await browser.close(); }
