/** Real Terrain pointer strokes must reseat architecture before release, with one undo. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";

const out = path.resolve("artifacts/architecture-terrain");
await fs.mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: await fs.mkdtemp(path.join(os.tmpdir(), "architecture-terrain-")),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
const errors = [], checks = [], snapshots = {};
const ready = new Promise(resolve => page.on("console", message => { if (message.text() === "Editor ready") resolve(); }));
page.on("pageerror", error => errors.push(error.stack ?? error.message));
page.on("console", message => { if (message.type() === "error" && /GPUValidation|WebGPU.*error|storage buffers/i.test(message.text())) errors.push(message.text()); });
const check = (name, value, detail = "") => { assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`); checks.push(name); console.log(`PASS ${name}`); };
const near = (a, b, epsilon = 1e-5) => Math.abs(a - b) <= epsilon;
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const chord = async (key, shift = false) => {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.down("Control"); if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift"); await page.keyboard.up("Control"); await sleep(120);
};

const live = (operation, args) => page.evaluate(async (operation, args) => {
  const importLive = modulePath => {
    const prefix = location.origin + modulePath;
    const fetched = performance.getEntriesByType("resource").map(entry => entry.name).filter(name => name === prefix || name.startsWith(prefix + "?"));
    return import(/* @vite-ignore */ fetched.find(name => name.includes("?")) ?? fetched[0] ?? modulePath);
  };
  const engine = await (await importLive("/src/editor/engineInstance.js")).ensureEngine();
  const viewport = (await importLive("/src/editor/viewportHandle.js")).getViewportHandle();
  const { commandBus } = await importLive("/src/editor/commands/CommandBus.js");
  const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
  const THREE = globalThis.__ENGINE_THREE__;
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (operation === "init") {
    const { setModuleEnabled } = await importLive("/src/editor/modules.js");
    await setModuleEnabled("terrain", true); await setModuleEnabled("architecture", true);
    const terrainEntity = engine.createEntity({ id: "architecture-terrain-ground", name: "Sculpt this ground" });
    terrainEntity.addComponent("terrain", { size: 64, resolution: 64, splatResolution: 16 });
    const { createArchitectureModel } = await importLive("/src/editor/architectureModelBuild.js");
    const base = { shape: "box", rotationY: 0, color: "#d5d1c7", roof: "hip", roofHeight: 1.2, windows: false };
    const result = createArchitectureModel({ name: "Terrain-following buildings", model: {
      forms: [
        { ...base, id: "near", position: [-6, .4, 0], size: [4, 3, 4] },
        { ...base, id: "upper", position: [-6, 3.4, 0], size: [3, 2.5, 3] },
        { ...base, id: "far", position: [9, .4, 0], size: [4, 3, 4], color: "#bd8d76" },
      ],
      openings: [{ id: "near-window", formId: "near", kind: "window", position: [-6, 1.8, 2], normal: [0, 0, 1], width: 1.1, height: 1.2 }], paths: [],
    } });
    const root = engine.getEntity(result.entityId);
    root.getComponent("architecture").setProp("terrainId", terrainEntity.id);
    globalThis.__architectureTerrainFixture = { terrainId: terrainEntity.id, modelId: root.id };
    const fill = new THREE.HemisphereLight(0xdce9fa, 0x9a8469, 2.2);
    const sun = new THREE.DirectionalLight(0xfff1d6, 3.5); sun.position.set(8, 20, 12); engine.scene.add(fill, sun);
    viewport.camera.position.set(14, 19, 27); viewport.orbit.target.set(0, 1.5, 0);
    viewport.orbit.update(); viewport.camera.updateMatrixWorld(); viewport.camera.updateProjectionMatrix();
    (await importLive("/src/editor/store/sceneStore.js")).useSceneStore.getState().refresh();
    useSelectionStore.getState().select(terrainEntity.id);
    await (await importLive("/src/editor/EditorShell.jsx")).openPanel("inspector");
    await frame();
    // Readable fixture lighting; the production terrain geometry remains live.
    const terrain = terrainEntity.getComponent("terrain");
    terrain.mesh.material = new THREE.MeshStandardNodeMaterial({ color: "#748468", roughness: 1 });
    commandBus.clearHistory(); await frame();
    return { ...globalThis.__architectureTerrainFixture, modules: [...engine.modules.keys()] };
  }
  const ids = globalThis.__architectureTerrainFixture;
  if (!ids) return null;
  const terrain = engine.getEntity(ids.terrainId)?.getComponent("terrain");
  const component = engine.getEntity(ids.modelId)?.getComponent("architecture");
  if (operation === "select") { useSelectionStore.getState().select(args === "terrain" ? ids.terrainId : ids.modelId); await frame(); return true; }
  if (operation === "brush") {
    const brush = await importLive("/src/editor/terrainBrush.js");
    for (const [key, value] of Object.entries(args)) brush.setTerrainBrushSetting(key, value);
    return { mode: brush.getTerrainBrushMode(), settings: brush.getTerrainBrushSettings() };
  }
  if (operation === "project") {
    const point = new THREE.Vector3(args[0], terrain.heightAtLocal(args[0], args[1]), args[1]);
    terrain.mesh.localToWorld(point); point.project(viewport.camera);
    const rect = document.querySelector(".viewport-canvas").getBoundingClientRect();
    const x = rect.left + (point.x + 1) * rect.width / 2, y = rect.top + (1 - point.y) * rect.height / 2;
    const canvas = document.querySelector(".viewport-canvas"), target = document.elementFromPoint(x, y);
    return { x, y, canvas: target === canvas || canvas.contains(target) };
  }
  if (operation === "snapshot") {
    engine.scene.updateMatrixWorld(true);
    const bases = {}, position = component.geometry?.attributes.position, index = component.geometry?.index;
    for (const form of component.props.model.forms) {
      let min = Infinity;
      for (const surface of component.surfaces ?? []) {
        if (surface.formId !== form.id || surface.kind !== "wall" || surface.interior) continue;
        for (let i = surface.start; i < surface.start + surface.count; i++) {
          const point = new THREE.Vector3().fromBufferAttribute(position, index.getX(i)).applyMatrix4(component.mesh.matrixWorld);
          min = Math.min(min, point.y);
        }
      }
      bases[form.id] = Number.isFinite(min) ? min : null;
    }
    let foundationMax = -Infinity;
    for (let x = -8; x <= -4; x += .5) for (let z = -2; z <= 2; z += .5) foundationMax = Math.max(foundationMax, terrain.heightAtLocal(x, z));
    const brush = await importLive("/src/editor/terrainBrush.js");
    return { model: component.props.model, bindings: component.props.terrainBindings, follow: component.props.followTerrain,
      bases, foundationMax, terrainHeights: Array.from(terrain.heightsArray), committedHeights: terrain.props.heights,
      centerHeight: terrain.heightAtLocal(-6, 0), brushMode: brush.getTerrainBrushMode(), brushing: !!viewport.terrainBrushing,
      undo: commandBus.undoStack.length, redo: commandBus.redoStack.length, preview: commandBus.previewing,
      geometryVertices: position?.count, geometryVersion: position?.version,
      service: !!engine.architectureTerrain, terrainErrors: Object.fromEntries(engine.architectureTerrain?.errors ?? []), selected: useSelectionStore.getState().ids[0] };
  }
}, operation, args);

const waitState = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout; let snapshot;
  do { snapshot = await live("snapshot"); if (predicate(snapshot)) return snapshot; await sleep(80); } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify({ ...snapshot, terrainHeights: undefined })}`);
};
const formY = (snapshot, id) => snapshot.model.forms.find(form => form.id === id).position[1];
const groundEqual = (a, b) => exact(a.terrainHeights, b.terrainHeights);
const startStroke = async () => {
  // Reproject onto the current terrain before each mouse sample; the surface
  // moves during this very stroke. Terrain brushing raycasts its selected mesh.
  const points = [[-7, -.6], [-5, .6], [-7, .6], [-5, -.6], [-7, -.6], [-5, .6]];
  const first = await live("project", points[0]); assert.ok(first.canvas, "Sculpt start must hit the viewport canvas");
  await page.mouse.move(first.x, first.y); await page.mouse.down();
  for (const point of points.slice(1)) { const screen = await live("project", point); assert.ok(screen.canvas, "Sculpt samples must stay on the viewport canvas"); await page.mouse.move(screen.x, screen.y, { steps: 6 }); }
};
const armBrush = async (tool = "raise") => {
  await live("select", "terrain");
  const button = await page.waitForSelector('button[title="Sculpt terrain height with the mouse in the viewport (S)"]');
  if ((await live("snapshot")).brushMode !== "sculpt") await button.click();
  const brush = await live("brush", { tool, radius: 6, strength: 1, hardness: .85 });
  assert.equal(brush.mode, "sculpt");
};

try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5341/", { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent.includes("Skip the project"))?.click());
  await page.waitForSelector(".viewport-toolbar", { timeout: 60000 });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Editor boot timeout")), 60000); ready.then(() => { clearTimeout(timer); resolve(); }); });
  const ids = await live("init");
  check("Architecture and Terrain enable in the same editor", ids.modules.includes("architecture") && ids.modules.includes("terrain"));
  const baseline = snapshots.baseline = await waitState(value => value.follow && Object.keys(value.bindings ?? {}).length > 0, "Initial terrain bindings were not established");
  check("Independent buildings bind to terrain while retaining initial clearance", near(formY(baseline, "near"), .4) && near(formY(baseline, "upper"), 3.4) && near(formY(baseline, "far"), .4));
  await armBrush("raise"); check("The Inspector Sculpt control arms the real terrain brush", (await live("snapshot")).brushMode === "sculpt");
  await shot("before-sculpt");

  await startStroke();
  const during = snapshots.raiseDuring = await waitState(value => value.brushing && formY(value, "near") > formY(baseline, "near") + .02, "Architecture did not move during the terrain stroke");
  const delta = formY(during, "near") - formY(baseline, "near");
  check("Raising terrain moves the building before mouse release", during.centerHeight > baseline.centerHeight + .02 && delta > .02 && during.brushing);
  check("The live indexed mesh follows the authored building base", near(during.bases.near - baseline.bases.near, delta, 2e-4));
  check("Connected upper forms and manual windows keep their relative elevation", near(formY(during, "upper") - formY(baseline, "upper"), delta) && near(during.model.openings[0].position[1] - baseline.model.openings[0].position[1], delta));
  check("The separate building in the same model stays in place", exact(during.model.forms.find(form => form.id === "far"), baseline.model.forms.find(form => form.id === "far")) && near(during.bases.far, baseline.bases.far));
  check("Terrain following adds no history while the stroke is active", during.undo === baseline.undo);
  await shot("live-sculpt-before-release"); await page.mouse.up();
  const raised = snapshots.raised = await waitState(value => !value.brushing && value.undo === baseline.undo + 1, "Terrain stroke did not commit as one undo");
  check("Releasing one stroke commits terrain and building together", formY(raised, "near") > formY(baseline, "near") && raised.undo === baseline.undo + 1);
  await chord("z");
  const undone = snapshots.raiseUndone = await waitState(value => groundEqual(value, baseline) && exact(value.model, baseline.model), "Undo did not restore terrain and architecture exactly");
  check("One keyboard undo restores the exact terrain and building document", groundEqual(undone, baseline) && exact(undone.model, baseline.model));
  await chord("z", true);
  const redone = snapshots.raiseRedone = await waitState(value => groundEqual(value, raised) && exact(value.model, raised.model), "Redo did not restore terrain and architecture exactly");
  check("Keyboard redo restores the same raised terrain and buildings", groundEqual(redone, raised) && exact(redone.model, raised.model));

  await armBrush("lower"); await startStroke();
  const lowerDuring = snapshots.lowerDuring = await waitState(value => value.brushing && formY(value, "near") < formY(raised, "near") - .02, "Lower brush did not reseat the building before release");
  check("Lowering terrain moves the building downward during the stroke", lowerDuring.centerHeight < raised.centerHeight && formY(lowerDuring, "near") < formY(raised, "near") - .02 && lowerDuring.undo === raised.undo);
  await page.mouse.up();
  await waitState(value => !value.brushing && value.undo === raised.undo + 1, "Lower stroke failed to commit");
  await chord("z");
  await waitState(value => groundEqual(value, raised) && exact(value.model, raised.model), "Lower stroke undo did not restore raised state");
  check("Lowering also has one exact terrain-and-building undo", true);

  await live("select", "model");
  const follow = await page.waitForSelector(`[data-architecture-model-section="${ids.modelId}"] input[aria-label="Follow sculpted terrain"]`);
  check("Terrain following is exposed in the Architecture Inspector", await follow.evaluate(input => input.checked));
  await follow.click();
  await waitState(value => value.follow === false, "Follow sculpted terrain checkbox did not disable following");
  await armBrush("raise"); const frozenBefore = snapshots.frozenBefore = await live("snapshot");
  await startStroke();
  const frozenDuring = snapshots.frozenDuring = await waitState(value => value.brushing && value.centerHeight > frozenBefore.centerHeight + .02, "Frozen building test did not sculpt the terrain");
  check("Disabling Follow sculpted terrain freezes the model and its mesh", exact(frozenDuring.model, frozenBefore.model) && exact(frozenDuring.bases, frozenBefore.bases) && frozenDuring.undo === frozenBefore.undo);
  await page.mouse.up(); await waitState(value => !value.brushing && value.undo === frozenBefore.undo + 1, "Frozen stroke did not commit");
  await shot("following-disabled"); await chord("z");
  await waitState(value => groundEqual(value, frozenBefore) && exact(value.model, frozenBefore.model), "Frozen stroke undo failed");
  check("A frozen model still allows ordinary one-stroke terrain undo", true);
  check("The terrain-following service reports no errors", Object.keys((await live("snapshot")).terrainErrors).length === 0);
  check("No runtime or WebGPU validation errors", errors.length === 0, errors.join("\n"));
  await fs.writeFile(path.join(out, "results.json"), JSON.stringify({ checks, errors, snapshots }, null, 2));
  console.log(`ARCHITECTURE-TERRAIN PASS (${checks.length} checks)`);
} catch (error) {
  await page.mouse.up().catch(() => {});
  await shot("failure").catch(() => {});
  const snapshot = await live("snapshot").catch(() => null);
  await fs.writeFile(path.join(out, "failure.json"), JSON.stringify({ error: error.stack ?? String(error), checks, errors, snapshots, snapshot }, null, 2));
  console.error("ARCHITECTURE-TERRAIN FAIL", error.stack ?? error); if (errors.length) console.error(errors.join("\n")); process.exitCode = 1;
} finally { await browser.close(); }
