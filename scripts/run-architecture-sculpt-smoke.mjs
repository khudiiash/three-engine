/** Real mouse gestures against the editor and its rendered connected architecture. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";

const out = path.resolve("artifacts/architecture-sculpt");
await fs.mkdir(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new", userDataDir: await fs.mkdtemp(path.join(os.tmpdir(), "architecture-sculpt-")),
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
const errors = [], checks = [];
const ready = new Promise(resolve => page.on("console", message => { if (message.text() === "Editor ready") resolve(); }));
page.on("pageerror", error => errors.push(error.stack ?? error.message));
page.on("console", message => { if (message.type() === "error" && /GPUValidation|WebGPU.*error|storage buffers/i.test(message.text())) errors.push(message.text()); });
const check = (name, value, detail = "") => { assert.ok(value, `${name}: ${detail}`); checks.push(name); console.log(`PASS ${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tool = async name => { await page.click(`[data-architecture-shelf] [aria-label="Architecture ${name}"]`); await sleep(80); };
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const chord = async (key, shift = false) => { await page.keyboard.down("Control"); if (shift) await page.keyboard.down("Shift"); await page.keyboard.press(key); if (shift) await page.keyboard.up("Shift"); await page.keyboard.up("Control"); await sleep(100); };

const live = (operation, args) => page.evaluate(async (operation, args) => {
  const importLive = modulePath => {
    const prefix = location.origin + modulePath;
    const fetched = performance.getEntriesByType("resource").map(entry => entry.name).filter(name => name === prefix || name.startsWith(prefix + "?"));
    return import(/* @vite-ignore */ fetched.find(name => name.includes("?")) ?? fetched[0] ?? modulePath);
  };
  const engine = await (await importLive("/src/editor/engineInstance.js")).ensureEngine();
  const viewport = (await importLive("/src/editor/viewportHandle.js")).getViewportHandle();
  const THREE = globalThis.__ENGINE_THREE__;
  const project = point => {
    point.project(viewport.camera);
    const rect = document.querySelector(".viewport-canvas").getBoundingClientRect();
    return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
  };
  if (operation === "enable") {
    await (await importLive("/src/editor/modules.js")).setModuleEnabled("architecture", true);
    const fill = new THREE.HemisphereLight(0xdce9fa, 0x9a8469, 2.2);
    const sun = new THREE.DirectionalLight(0xfff1d6, 3.5); sun.position.set(8, 20, 12);
    engine.scene.add(fill, sun);
    viewport.camera.position.set(20, 18, 25); viewport.orbit.target.set(0, 1.5, 0);
    viewport.orbit.update(); viewport.camera.updateMatrixWorld(); viewport.camera.updateProjectionMatrix();
    return [...engine.modules.keys()];
  }
  if (operation === "project") {
    const point = new THREE.Vector3(...args.position);
    if (args.entityId) engine.getEntity(args.entityId).object3D.localToWorld(point);
    return project(point);
  }
  if (operation === "snapshot") {
    const { commandBus } = await importLive("/src/editor/commands/CommandBus.js");
    const state = (await importLive("/src/editor/architectureSculptTool.js")).getArchitectureSculptState();
    const roots = [];
    for (const root of engine.rootEntities) root.traverse(entity => {
      const component = entity.getComponent("architecture");
      if (!component?.props.model) return;
      roots.push({ id: entity.id, model: component.props.model, children: entity.children.length,
        components: [...entity.components.keys()], vertices: component.geometry?.attributes.position.count,
        indices: component.geometry?.index.count, groups: component.geometry?.groups.length,
        surfaces: component.surfaces.map(({ formId, kind, interior, start, count, face }) => ({ formId, kind, interior, start, count, face })),
        modelMesh: component.mesh === entity.getComponent("mesh")?.mesh && component.mesh?.geometry === component.geometry });
    });
    return { state, roots, undo: commandBus.undoStack.length, preview: commandBus.previewing };
  }
  if (operation === "handle") {
    let found;
    engine.scene.updateMatrixWorld(true);
    engine.scene.traverse(object => { if (object.userData.architectureSculptHandle && object.userData.handle === args.name && object.userData.formId === args.formId) found = object; });
    if (!found) return null;
    return { ...project(found.getWorldPosition(new THREE.Vector3())), world: found.getWorldPosition(new THREE.Vector3()).toArray() };
  }
  if (operation === "surface") {
    // Choose an actually visible triangle. Facade centres can be window holes.
    const component = engine.getEntity(args.rootId).getComponent("architecture"), mesh = component.mesh, geometry = mesh.geometry;
    mesh.updateWorldMatrix(true, false);
    const position = geometry.attributes.position, index = geometry.index, candidates = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (const surface of component.surfaces) {
      if (surface.formId !== args.formId || surface.kind !== args.kind || surface.interior) continue;
      for (let offset = surface.start; offset < surface.start + surface.count; offset += 3) {
        a.fromBufferAttribute(position, index.getX(offset)); b.fromBufferAttribute(position, index.getX(offset + 1)); c.fromBufferAttribute(position, index.getX(offset + 2));
        const area = b.clone().sub(a).cross(c.clone().sub(a)).length();
        const point = a.clone().add(b).add(c).multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld);
        const ray = new THREE.Raycaster(viewport.camera.position, point.clone().sub(viewport.camera.position).normalize());
        const hit = ray.intersectObject(mesh, false)[0];
        if (hit && hit.point.distanceTo(point) < .01) candidates.push({ ...project(point), area });
      }
    }
    return candidates.sort((a, b) => b.area - a.area)[0] ?? null;
  }
  if (operation === "ray") {
    const component = engine.getEntity(args.rootId).getComponent("architecture");
    const origin = new THREE.Vector3(...args.origin), direction = new THREE.Vector3(...args.direction).normalize();
    component.mesh.updateWorldMatrix(true, false);
    if (args.local) { origin.applyMatrix4(component.entity.object3D.matrixWorld); direction.transformDirection(component.entity.object3D.matrixWorld); }
    const hits = new THREE.Raycaster(origin, direction, 0, args.far ?? 100).intersectObject(component.mesh);
    return hits.map(hit => ({ distance: hit.distance, kind: component.surfaceAt(hit.faceIndex)?.kind, point: hit.point.toArray() }));
  }
  if (operation === "camera") return viewport.camera.quaternion.toArray();
  if (operation === "showcase") {
    (await importLive("/src/editor/store/selectionStore.js")).useSelectionStore.getState().clear();
    viewport.camera.position.set(13, 13, 19); viewport.orbit.target.set(-1, 0, 1);
    viewport.orbit.update(); viewport.camera.updateMatrixWorld(); return true;
  }
}, operation, args);

const world = position => live("project", { position });
const drag = async (from, to, steps = 12) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps }); await page.mouse.up(); await sleep(150); };
const surface = async (root, form, kind = "wall") => {
  const point = await live("surface", { rootId: root.id, formId: form.id, kind });
  assert.ok(point, `Visible ${kind} surface for ${form.id}`); return point;
};
const click = async (point, button = "left") => { await page.mouse.move(point.x, point.y); await page.mouse.click(point.x, point.y, { button }); await sleep(150); };
let snapshot;
try {
  await page.goto(process.argv[2] ?? "http://127.0.0.1:5341/", { waitUntil: "load", timeout: 60000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent.includes("Skip the project"))?.click());
  await page.waitForSelector(".viewport-toolbar", { timeout: 60000 });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Editor boot timeout")), 60000); ready.then(() => { clearTimeout(timer); resolve(); }); });
  const viewportTab = await page.waitForFunction(() => [...document.querySelectorAll(".dv-tab")].find(element => element.textContent.trim() === "Viewport"));
  await viewportTab.asElement().click({ clickCount: 2 }); await sleep(250);
  const modules = await live("enable");
  check("Architecture enables without Level Design", modules.includes("architecture") && !modules.includes("level-design"));
  await page.click('[aria-label="Open Architecture"]'); await page.waitForSelector('[aria-label="Architecture build"]');
  snapshot = await live("snapshot");
  check("Default Building tool owns the canvas", snapshot.state.active && snapshot.state.tool === "build");
  const beforeCreate = snapshot.undo, from = await world([-4, 0, -3]), to = await world([4, 0, 3]);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 });
  let during = await live("snapshot");
  check("Footprint drag displays the live building and roof before release", during.preview && during.roots[0]?.vertices > 0 && during.roots[0].surfaces.some(s => s.kind === "roof"));
  await page.mouse.up(); await sleep(180); snapshot = await live("snapshot");
  let root = snapshot.roots[0], form = root?.model.forms[0];
  check("One stroke makes one connected model with no old piece hierarchy", root?.modelMesh && root.children === 0 && root.components.includes("architecture") && !root.components.includes("architecturepiece") && snapshot.undo === beforeCreate + 1 && form.size[0] > 7 && form.size[2] > 5, JSON.stringify(snapshot.state));
  await shot("building");

  await tool("grow"); const beforeGrow = snapshot.undo;
  await click(await surface(root, form)); snapshot = await live("snapshot"); root = snapshot.roots[0];
  const wing = root.model.forms.find(item => item.id !== form.id);
  check("Clicking a facade grows an attached volume", root.model.forms.length === 2 && wing.position[1] === form.position[1] && snapshot.undo === beforeGrow + 1);
  await click(await surface(root, form, "roof")); snapshot = await live("snapshot"); root = snapshot.roots[0];
  const upper = root.model.forms.find(item => item.position[1] >= form.size[1] - .01);
  check("Clicking a roof stacks above body height and adapts roof geometry", root.model.forms.length === 3 && upper?.position[1] === form.position[1] + form.size[1]);
  await shot("connected-growth");
  await click(await surface(root, upper, "roof"), "right"); snapshot = await live("snapshot");
  check("Right-click removes a form and regenerates the exposed structure", snapshot.roots[0].model.forms.length === 2 && snapshot.roots[0].surfaces.some(s => s.formId === form.id && s.kind === "roof"));
  await chord("z"); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("Keyboard undo restores the removed form with its identity", root.model.forms.some(item => item.id === upper.id));
  await chord("z"); await chord("z"); snapshot = await live("snapshot"); root = snapshot.roots[0]; form = root.model.forms[0];
  check("Undo removes each growth click independently", root.model.forms.length === 1);

  await tool("reshape"); await click(await surface(root, form));
  let handle = await live("handle", { name: "height", formId: form.id });
  check("Selecting a form exposes direct geometry handles", !!handle && !!await live("handle", { name: "width+", formId: form.id }) && !!await live("handle", { name: "roofHeight", formId: form.id }));
  const beforeReshape = (await live("snapshot")).undo;
  await drag(handle, await world([handle.world[0], handle.world[1] + 2.2, handle.world[2]])); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("Dragging the height handle changes geometry in one undo", root.model.forms[0].size[1] > form.size[1] + 1 && snapshot.undo === beforeReshape + 1, JSON.stringify(root.model.forms[0]));
  await chord("z"); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("Height undo restores the original continuous form", root.model.forms[0].size[1] === form.size[1]);
  handle = await live("handle", { name: "roofHeight", formId: form.id });
  await drag(handle, await world([handle.world[0], handle.world[1] + 1.5, handle.world[2]])); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("Roof handle changes pitch independently from wall height", root.model.forms[0].roofHeight > form.roofHeight + .5 && root.model.forms[0].size[1] === form.size[1]);
  handle = await live("handle", { name: "width+", formId: form.id });
  const original = JSON.stringify(root.model), beforeCancel = snapshot.undo;
  await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x + 55, handle.y + 8, { steps: 5 });
  await page.keyboard.press("Escape"); await page.mouse.up(); snapshot = await live("snapshot");
  check("Escape during a handle drag restores the exact document without history", JSON.stringify(snapshot.roots[0].model) === original && snapshot.undo === beforeCancel && snapshot.state.active);
  handle = await live("handle", { name: "elevation", formId: form.id });
  check("A visible lift handle exposes free vertical placement", !!handle);
  await drag(handle, await world([handle.world[0], handle.world[1] + 2.5, handle.world[2]])); snapshot = await live("snapshot");
  check("Lifting the base creates supports without changing building height", snapshot.roots[0].model.forms[0].position[1] > 2 && snapshot.roots[0].model.forms[0].size[1] === form.size[1] && snapshot.roots[0].surfaces.some(s => s.kind === "support"));
  await shot("lifted-building-supports"); await chord("z"); snapshot = await live("snapshot");
  await shot("reshape-handles");

  await tool("window"); root = snapshot.roots[0]; await click(await surface(root, form)); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("Facade click authors a real anchored window", root.model.openings.length === 1 && root.model.openings[0].kind === "window");
  const opening = root.model.openings[0], n = opening.normal;
  let hits = await live("ray", { rootId: root.id, local: true, origin: opening.position.map((v, i) => v + n[i] * 2), direction: n.map(v => -v), far: 2.5 });
  check("Window aperture is open through the wall mesh", hits.length === 0, JSON.stringify(hits));
  await tool("paint"); await page.click('[aria-label="Terracotta building colour"]'); await click(await surface(root, form)); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("Paint changes the clicked form's authored surface color", root.model.forms[0].color === "#bd8d76");

  await tool("round"); await drag(await world([-9, 0, 5]), await world([-7.5, 0, 5])); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("Tower drag creates a round form in the same composition", root.model.forms.some(item => item.shape === "round"));
  await tool("wall"); const stroke = [[-8, 0, 5], [-5, 0, 6], [-2, 0, 5.5], [1, 0, 7]];
  const first = await world(stroke[0]); await page.mouse.move(first.x, first.y); await page.mouse.down();
  for (const point of stroke.slice(1)) { const screen = await world(point); await page.mouse.move(screen.x, screen.y, { steps: 4 }); }
  await page.mouse.up(); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("Freehand wall stroke creates joined wall segments with varying directions", root.model.forms.filter(item => item.roof === "none" && !item.windows).length >= 3);
  await tool("path"); await drag(await world([0, 0, 9]), await world([0, 0, -7])); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("Drawing across forms creates a persistent path and passage cuts", root.model.paths.length === 1 && root.model.paths[0].points.length >= 2);
  hits = await live("ray", { rootId: root.id, origin: [0, 1, 4], direction: [0, 0, -1], far: 2 });
  check("The crossing path opens the original building facade", hits.length === 0, JSON.stringify(hits));
  await shot("building-tower-curved-wall-path");
  const pathId = root.model.paths[0].id, formCount = root.model.forms.length;
  await click(await surface(root, { id: null }, "path"), "right"); snapshot = await live("snapshot"); root = snapshot.roots[0];
  hits = await live("ray", { rootId: root.id, origin: [0, 1, 4], direction: [0, 0, -1], far: 2 });
  check("Right-clicking a path reseals the facade and preserves its buildings", root.model.paths.length === 0 && root.model.forms.length === formCount && hits.length > 0);
  await chord("z"); snapshot = await live("snapshot"); root = snapshot.roots[0];
  check("One undo restores the erased path and its identity", root.model.paths[0]?.id === pathId);

  const camera = await live("camera"), beforeOrbit = JSON.stringify(root.model), orbitPoint = await world([10, 0, -6]);
  await page.keyboard.down("Alt"); await drag(orbitPoint, { x: orbitPoint.x + 40, y: orbitPoint.y + 15 }); await page.keyboard.up("Alt");
  check("Alt-drag orbits without authoring geometry", (await live("camera")).some((v, i) => Math.abs(v - camera[i]) > 1e-4) && JSON.stringify((await live("snapshot")).roots[0].model) === beforeOrbit);
  await live("showcase"); await page.mouse.move(30, 20); await sleep(250); await shot("connected-building-tools");
  await page.keyboard.press("Escape"); await page.click('[aria-label="New building composition"]');
  check("New after releasing the tool clears the old composition target", (await live("snapshot")).state.entityId === null);
  await page.click('[aria-label="Close Architecture"]');
  check("Closing the shelf relinquishes canvas gestures", !(await live("snapshot")).state.active);
  check("No runtime or WebGPU validation errors", errors.length === 0, errors.join("\n"));
  await fs.writeFile(path.join(out, "results.json"), JSON.stringify({ checks, errors, model: root.model }, null, 2));
  console.log(`ARCHITECTURE-SCULPT PASS (${checks.length} checks)`);
} catch (error) {
  await shot("failure").catch(() => {});
  await fs.writeFile(path.join(out, "failure.json"), JSON.stringify({ error: error.stack, checks, errors, snapshot: await live("snapshot").catch(() => null) }, null, 2));
  console.error("ARCHITECTURE-SCULPT FAIL", error.stack ?? error); if (errors.length) console.error(errors.join("\n")); process.exitCode = 1;
} finally { await browser.close(); }
