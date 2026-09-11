/** Real-editor Architecture shelf, gestures, ghost placement and keyboard undo. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://127.0.0.1:5341/";
const out = path.resolve("artifacts/architecture-ui");
await fs.mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: await fs.mkdtemp(path.join(os.tmpdir(), "architecture-ui-")),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
const errors = [], checks = [];
const parseFailures = [];
const debuggerSession = await page.createCDPSession();
await debuggerSession.send("Debugger.enable");
debuggerSession.on("Debugger.scriptFailedToParse", (event) => parseFailures.push({ url: event.url, line: event.startLine, column: event.startColumn }));
const editorReady = new Promise((resolve) => page.on("console", (message) => { if (message.text() === "Editor ready") resolve(); }));
page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
page.on("console", (message) => { if (message.type() === "error" && /GPUValidation|WebGPU.*error|storage buffers/i.test(message.text())) errors.push(message.text()); });
const check = (name, value, detail = "") => { assert.ok(value, `${name}${detail ? `: ${detail}` : ""}`); checks.push(name); console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shelf = "[data-architecture-shelf]", flyout = "[data-architecture-flyout]";
const clickText = async (selector, text) => {
  const handle = await page.waitForFunction((selector, text) => [...document.querySelectorAll(selector)].find((element) => element.textContent.trim() === text), { timeout: 25000 }, selector, text);
  await handle.asElement().click();
};
const chord = async (key, shift = false) => {
  await page.keyboard.down("Control");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
};
const number = async (label, value, scope = flyout) => {
  await page.click(`${scope} input[aria-label="${label}"]`, { clickCount: 3 }); await chord("A");
  await page.keyboard.type(String(value)); await page.keyboard.press("Enter");
};
const drag = async (from, to, alt = false) => {
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
  await sleep(160);
};
const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });

// Read through the app's live imports. Creation happens only through visible UI.
const live = async (operation, args) => page.evaluate(async (operation, args) => {
  const importLive = (modulePath) => {
    const prefix = location.origin + modulePath;
    const fetched = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name === prefix || name.startsWith(prefix + "?"));
    return import(/* @vite-ignore */ fetched.find((name) => name.includes("?")) ?? fetched[0] ?? modulePath);
  };
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const { getViewportHandle } = await importLive("/src/editor/viewportHandle.js");
  const viewport = getViewportHandle();
  if (operation === "enable") {
    const { setModuleEnabled } = await importLive("/src/editor/modules.js");
    await setModuleEnabled("architecture", true); return [...engine.modules.keys()];
  }
  if (operation === "snapshot") {
    const { commandBus } = await importLive("/src/editor/commands/CommandBus.js");
    const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
    const entities = [];
    for (const root of engine.rootEntities) root.traverse((entity) => {
      const piece = entity.getComponent("architecturepiece"), architecture = entity.getComponent("architecture");
      const geometry = entity.getComponent("mesh")?.mesh?.geometry;
      if (geometry && !geometry.boundingBox) geometry.computeBoundingBox();
      entities.push({ id: entity.id, parentId: entity.parent?.id, components: [...entity.components.keys()],
        shape: piece?.props.shape, size: piece?.props.size, color: piece?.props.color, openings: piece?.props.openings,
        settings: architecture?.props.settings, generatedRootId: architecture?.props.generatedRootId,
        position: entity.object3D.getWorldPosition(entity.object3D.position.clone()).toArray(),
        rotation: entity.object3D.rotation.clone().setFromQuaternion(entity.object3D.getWorldQuaternion(entity.object3D.quaternion.clone())).toArray().slice(0, 3),
        vertices: geometry?.attributes.position?.count ?? 0,
        geometryHeight: geometry?.boundingBox ? geometry.boundingBox.max.y - geometry.boundingBox.min.y : null });
    });
    return { entities, selectedId: useSelectionStore.getState().ids[0], undoDepth: commandBus.undoStack.length };
  }
  if (operation === "placement") {
    const { getArchitecturePlacementState } = await importLive("/src/editor/architectureTool.js");
    const ghosts = [];
    engine.scene.traverse((object) => {
      if (!object.userData.architecturePlacementPreview) return;
      let vertices = 0; object.traverse((part) => { vertices += part.geometry?.attributes.position?.count ?? 0; });
      ghosts.push({ visible: object.visible, vertices, children: object.children.length, editorOnly: object.userData.editorOnly });
    });
    return { ...getArchitecturePlacementState(), ghosts };
  }
  if (operation === "drawState") return (await importLive("/src/editor/architectureTool.js")).getArchitectureToolState();
  if (operation === "aim") {
    viewport.camera.position.set(35, 27, 38); viewport.orbit.target.set(0, 0, 0);
    viewport.orbit.update(); viewport.camera.updateMatrixWorld(); viewport.camera.updateProjectionMatrix(); return true;
  }
  if (operation === "camera") return viewport.camera.quaternion.toArray();
  if (operation === "project") {
    const point = new globalThis.__ENGINE_THREE__.Vector3(...args.position);
    if (args.entityId) engine.getEntity(args.entityId).object3D.localToWorld(point);
    point.project(viewport.camera);
    const rect = document.querySelector(".viewport-canvas").getBoundingClientRect();
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  }
  if (operation === "select") {
    const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().select(args); return true;
  }
}, operation, args);

const layout = () => page.evaluate(() => {
  const canvas = document.querySelector(".viewport-canvas"), rect = canvas.getBoundingClientRect();
  const bounds = (element) => { if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const samples = [];
  for (const x of [.12, .3, .5, .7, .88]) for (const y of [.28, .42, .56, .7]) {
    const px = rect.x + rect.width * x, py = rect.y + rect.height * y, target = document.elementFromPoint(px, py);
    samples.push({ x: px, y: py, canvas: target === canvas || canvas.contains(target) });
  }
  return { canvas: bounds(canvas), shelf: bounds(document.querySelector("[data-architecture-shelf]")), flyout: bounds(document.querySelector("[data-architecture-flyout]")),
    orientation: bounds(document.querySelector('[aria-label="Viewport orientation"]')),
    modal: !!document.querySelector('.architecture-backdrop, .architecture-dialog, [data-architecture-workspace] [aria-modal="true"]'),
    samples, freeSamples: samples.filter((sample) => sample.canvas).length };
});

try {
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent.includes("Skip the project"))?.click());
  await page.waitForSelector(".viewport-toolbar", { timeout: 60000 });
  // Project module restore follows viewport mount; await completion before enabling.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Editor boot did not complete")), 60000);
    editorReady.then(() => { clearTimeout(timer); resolve(); });
  });
  const modules = await live("enable");
  check("Architecture enables independently", modules.includes("architecture") && !modules.includes("level-design"));
  await live("aim");
  await page.waitForSelector('[aria-label="Open Architecture"]');
  await page.click('[aria-label="Open Architecture"]'); await page.waitForSelector(shelf);
  check("Architecture opens directly into connected building tools", await page.$(`${shelf} [aria-label="Architecture build"]`));
  let measured = await layout();
  check("Shelf leaves the scene visible without a modal or backdrop", !measured.modal && measured.shelf.height <= 148 && measured.shelf.width * measured.shelf.height < measured.canvas.width * measured.canvas.height * .35 && measured.freeSamples >= 8, JSON.stringify(measured));
  await shot("shelf");

  await clickText(`${shelf} [role="tab"]`, "Parts");

  await page.click(`${shelf} [aria-label="Draw wall"]`);
  await page.click(`${shelf} [aria-label="Terracotta tint"]`);
  await number("Architecture draw elevation", 1.7, shelf);
  const cameraBefore = await live("camera"), beforeDraw = await live("snapshot"), c = measured.canvas;
  await drag({ x: c.x + c.width * .6, y: c.y + c.height * .4 }, { x: c.x + c.width * .74, y: c.y + c.height * .32 }, true);
  check("Alt-drag orbits while shelf is open without drawing", (await live("camera")).some((value, index) => Math.abs(value - cameraBefore[index]) > 1e-4) && (await live("snapshot")).entities.length === beforeDraw.entities.length);
  await live("aim");
  await drag({ x: c.x + c.width * .36, y: c.y + c.height * .45 }, { x: c.x + c.width * .67, y: c.y + c.height * .45 });
  let snapshot = await live("snapshot");
  const wall = snapshot.entities.find((entity) => entity.shape === "wall"), assembly = snapshot.entities.find((entity) => entity.id === wall?.parentId);
  check("A real drag creates an editable wall and freeform assembly at the chosen elevation", wall?.vertices > 0 && wall.size[0] > .5 && Math.abs(wall.position[1] - 1.7) < 1e-6 && assembly?.components.includes("architecture"));
  check("The selected surface tint reaches the drawn piece", wall.color === "#bd8d76");
  check("Draw creates no legacy level or storey components", !snapshot.entities.some((entity) => entity.components.some((type) => ["level", "levelfloor", "blockout"].includes(type))));
  const doorway = await live("project", { entityId: wall.id, position: [0, wall.size[1] * .45, 0] });
  await page.click(`${shelf} [aria-label="Draw door"]`); await page.mouse.click(doorway.x, doorway.y);
  check("Clicking the wall cuts a real doorway", (await live("snapshot")).entities.find((entity) => entity.id === wall.id)?.openings.length === 1);
  await shot("draw-shelf"); await page.keyboard.press("Escape");
  check("Escape finishes drawing and keeps the shelf available", !(await live("drawState")).active && !!await page.$(shelf));
  await chord("z");
  check("Keyboard undo removes the doorway", (await live("snapshot")).entities.find((entity) => entity.id === wall.id)?.openings.length === 0);
  await live("select", wall.id);
  await clickText(`${shelf} [role="tab"]`, "Inspect");
  await page.waitForSelector(`${shelf} [data-architecture-selection="${wall.id}"]`);
  await number("Selected height", 5.4, shelf);
  const resizedWall = (await live("snapshot")).entities.find((entity) => entity.id === wall.id);
  check("Edit height updates the selected wall's authored dimensions and real geometry", resizedWall?.size[1] === 5.4 && Math.abs(resizedWall.geometryHeight - 5.4) < 1e-5);
  await shot("edit-selection"); await chord("z");
  await page.waitForFunction((expected) => Number(document.querySelector('[data-architecture-shelf] input[aria-label="Selected height"]')?.value) === expected, {}, wall.size[1]);
  const restoredWall = (await live("snapshot")).entities.find((entity) => entity.id === wall.id);
  check("One keyboard undo restores wall geometry and the Edit field", restoredWall?.size[1] === wall.size[1] && Math.abs(restoredWall.geometryHeight - wall.geometryHeight) < 1e-5);
  await chord("z");
  check("The first stroke is one undo including its new assembly", !(await live("snapshot")).entities.some((entity) => entity.id === wall.id || entity.id === assembly.id));

  // Selecting a preset arms the pointer without creating anything at the origin.
  await clickText(`${shelf} [role="tab"]`, "Presets");
  const beforeStamp = await live("snapshot");
  await page.click(`${shelf} [aria-label="Place House"]`);
  let placement = await live("placement");
  check("Selecting a preset arms placement without creating entities or history", placement.active && (await live("snapshot")).undoDepth === beforeStamp.undoDepth && (await live("snapshot")).entities.length === beforeStamp.entities.length);
  await page.click(`${shelf} [aria-label="Architecture settings"]`); await page.waitForSelector(flyout);
  await number("Width (m)", 14);
  check("Flyout dimensions update the armed stamp without editing the scene", (await live("placement")).settings.width === 14 && (await live("snapshot")).undoDepth === beforeStamp.undoDepth);
  await page.click('[aria-label="Close architecture settings"]');
  const firstPoint = await live("project", { position: [-14, 0, -14] });
  await page.mouse.move(firstPoint.x, firstPoint.y); await sleep(220); placement = await live("placement");
  check("The hover ghost contains real preview geometry", placement.previewPieceCount > 0 && placement.ghosts.some((ghost) => ghost.visible && ghost.vertices > 0 && ghost.editorOnly));
  await shot("stamp-preview"); await page.mouse.click(firstPoint.x, firstPoint.y); await sleep(180);
  const firstState = await live("placement"), firstId = firstState.lastEntityId;
  snapshot = await live("snapshot");
  const firstHouse = snapshot.entities.find((entity) => entity.id === firstId);
  check("A scene click places the configured preset where the ghost stood", firstHouse?.settings.preset === "house" && firstHouse.settings.width === 14 && Math.hypot(firstHouse.position[0] + 14, firstHouse.position[2] + 14) < 1.5 && firstHouse.generatedRootId);
  await page.keyboard.press("r"); placement = await live("placement");
  check("R rotates the armed preset by 90 degrees", Math.abs(Math.abs(placement.rotationY - firstState.rotationY) - Math.PI / 2) < 1e-6);
  const secondPoint = await live("project", { position: [14, 0, -14] });
  await page.mouse.move(secondPoint.x, secondPoint.y); await sleep(120); await page.mouse.click(secondPoint.x, secondPoint.y); await sleep(180);
  const secondState = await live("placement"), secondId = secondState.lastEntityId;
  snapshot = await live("snapshot");
  const secondHouse = snapshot.entities.find((entity) => entity.id === secondId);
  check("Repeated clicks place independent rotated structures", firstId !== secondId && secondHouse?.settings.preset === "house" && Math.hypot(secondHouse.position[0] - 14, secondHouse.position[2] + 14) < 1.5 && Math.abs(Math.abs(secondHouse.rotation[1]) - Math.PI / 2) < 1e-5 && secondState.active);
  await shot("stamped-houses"); await page.keyboard.press("Escape"); placement = await live("placement");
  check("Escape cancels stamping and removes the ghost while preserving the shelf", !placement.active && !placement.ghosts.some((ghost) => ghost.visible) && !!await page.$(shelf));
  await chord("z"); snapshot = await live("snapshot");
  check("Keyboard undo removes only the latest stamp", snapshot.entities.some((entity) => entity.id === firstId) && !snapshot.entities.some((entity) => entity.id === secondId));
  await chord("z", true);
  check("Keyboard redo restores the same stamped structure", (await live("snapshot")).entities.some((entity) => entity.id === secondId));

  await live("select", firstId);
  const section = `[data-architecture-section="${firstId}"]`;
  await page.waitForSelector(section); await number("Width (m)", 16, section);
  check("Inspector recipe edits stay staged", (await live("snapshot")).entities.find((entity) => entity.id === firstId)?.settings.width === firstHouse.settings.width);
  await page.waitForFunction((section) => !document.querySelector(`${section} .architecture-primary`)?.disabled, {}, section);
  await clickText(`${section} .architecture-primary`, "Regenerate");
  check("Regenerate applies staged edits to the selected structure", (await live("snapshot")).entities.find((entity) => entity.id === firstId)?.settings.width === 16);
  await page.mouse.move(c.x + c.width * .7, c.y + c.height * .35); await chord("z");
  check("Regeneration has one keyboard undo", (await live("snapshot")).entities.find((entity) => entity.id === firstId)?.settings.width === firstHouse.settings.width);

  await page.click(`${shelf} [aria-label="Architecture settings"]`); await page.waitForSelector(flyout); measured = await layout();
  check("Settings use a compact nonmodal flyout", !measured.modal && measured.flyout.width <= 300 && measured.flyout.x >= measured.canvas.x && measured.flyout.right <= measured.canvas.right && measured.freeSamples >= 4, JSON.stringify(measured));
  const available = measured.samples.filter((point) => point.canvas && point.y < measured.canvas.y + measured.canvas.height * .6);
  check("Canvas stays hit-testable beside the settings flyout", available.length >= 2);
  // Esc restored normal editor gestures above (where Alt is marquee selection).
  // Rearm the preset to exercise the shelf's advertised placement navigation.
  await clickText(`${flyout} button`, "Place in scene");
  const orbitBefore = await live("camera"), rootsBeforeOrbit = (await live("snapshot")).entities.length;
  await drag(available.at(-1), { x: available.at(-1).x - 30, y: available.at(-1).y - 15 }, true);
  check("Camera orbit still works with settings open", (await live("camera")).some((value, index) => Math.abs(value - orbitBefore[index]) > 1e-4) && (await live("snapshot")).entities.length === rootsBeforeOrbit);
  await shot("settings-flyout");
  await page.setViewport({ width: 1050, height: 800, deviceScaleFactor: 1 }); await sleep(200); measured = await layout();
  check("Shelf and flyout stay inside a narrow viewport", measured.shelf.x >= measured.canvas.x - 1 && measured.shelf.right <= measured.canvas.right + 1 && measured.shelf.bottom <= measured.canvas.bottom + 1 && measured.flyout.width <= 300 && measured.flyout.x >= measured.canvas.x - 1 && measured.flyout.right <= measured.canvas.right + 1 && measured.freeSamples >= 2, JSON.stringify(measured));
  check("The narrow shelf leaves the orientation gizmo unobstructed", measured.orientation && (measured.shelf.right <= measured.orientation.x || measured.shelf.x >= measured.orientation.right || measured.shelf.bottom <= measured.orientation.y || measured.shelf.y >= measured.orientation.bottom), JSON.stringify(measured));
  const beforeCity = await live("snapshot");
  const cityButton = await page.$(`${shelf} [aria-label="Place City block"]`);
  await cityButton.scrollIntoView(); await cityButton.click();
  check("The last preset remains reachable in the narrow scrollable shelf", (await live("placement")).settings.preset === "city" && (await live("snapshot")).undoDepth === beforeCity.undoDepth);
  await shot("narrow-shelf"); await page.click('[aria-label="Close Architecture"]');
  check("Closing Architecture removes the shelf and disarms its tools", !await page.$(shelf) && !(await live("drawState")).active && !(await live("placement")).active);
  check("No runtime or WebGPU validation errors", errors.length === 0, errors.join("\n"));
  await fs.writeFile(path.join(out, "results.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(`ARCHITECTURE-UI PASS (${checks.length} checks) — screenshots: ${out}`);
} catch (error) {
  await shot("failure").catch(() => {});
  console.error("ARCHITECTURE-UI FAIL", error.stack ?? error);
  if (errors.length) console.error(errors.join("\n"));
  if (parseFailures.length) console.error("Modules that failed to parse:", JSON.stringify(parseFailures));
  process.exitCode = 1;
} finally { await browser.close(); }
