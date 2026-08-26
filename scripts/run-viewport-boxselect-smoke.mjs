// Box select in the viewport, and "a click means the whole model", driven as a
// real browser gesture.
//
// run-viewport-select-test.mjs owns the arithmetic (frustum planes, the prefab
// walk). This owns the half that arithmetic cannot see: does a modified drag
// actually reach the marquee, and does the camera hold still while it does.
//
// That second question is the whole reason the gesture is on a modifier.
// OrbitControls rotates on the LEFT button, and it listens on the canvas — so
// the marquee has to disable it from a WINDOW-level capture listener, because
// listeners on the target element itself fire in registration order whatever
// their capture flag. Get that wrong and the feature still "works": you get a
// selection AND a camera that spun while you dragged, which reads as the
// viewport lurching every time you box-select.
//
// The other half is WHICH modifier, and this shipped on the wrong one first.
// Shift/Ctrl+drag broke panning, because OrbitControls reads left-drag with
// ctrl, meta OR shift as pan ("Pan: Right mouse, or left mouse +
// ctrl/meta/shiftKey" — its own header), so the marquee had quietly eaten both
// pan modifiers. Alt is the one it never reads. The "camera gestures still
// work" section below is that regression's gate: box select must cost the
// navigation nothing.
//
//   npx vite --port 5219
//   node scripts/run-viewport-boxselect-smoke.mjs [url]
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs on Vite `?t=` twins.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5219/";
const ROOT = path.join(os.tmpdir(), "viewport-boxselect-smoke").replaceAll("\\", "/");

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

const node = (name, position, extra = {}) => ({
  name,
  position,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  viewOnly: false,
  enabledInEditor: true,
  enabledInGame: true,
  components: [{ type: "mesh", props: { geometry: "box" } }],
  children: [],
  ...extra,
});
const box = (id, name, position) => ({ id, ...node(name, position) });

// A real prefab def, embedded in the scene rather than written as an asset:
// `deserializeScene` registers `scene.prefabs` before it expands anything, so
// the fixture needs no project scan and no boot ordering to be right.
const TREE_GUID = "boxselect-smoke-tree";
const TREE_PATH = `${ROOT}/assets/Tree.prefab`;
const TREE_DEF = {
  prefab: 1,
  guid: TREE_GUID,
  path: TREE_PATH,
  name: "Tree",
  root: {
    fid: "f0",
    ...node("Tree", [0, 0, 0], { components: [] }),
    children: [
      { fid: "f1", ...node("Trunk", [0, -0.6, 0]) },
      {
        fid: "f2",
        ...node("Foliage", [0, 0.9, 0], { components: [] }),
        children: [{ fid: "f3", ...node("Leaf", [0, 0, 0]) }],
      },
    ],
  },
};

const ROW_Y = 2;
const XS = { box0: -6, box1: -3, box2: 0, tree: 5 };

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify({ name: "BoxSelect", version: 1, lastScene: "scenes/Box.scene", modules: [] }, null, 2),
);
fs.writeFileSync(
  path.join(ROOT, "scenes", "Box.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Box",
      settings: {
        background: "#202329",
        ambientColor: "#ffffff",
        ambientIntensity: 0.6,
        shadows: false,
        // Merging is run-viewport-pick-smoke's subject; keep the meshes their
        // own so a failure here can only be about the gesture.
        performance: { staticMerging: false, autoBatching: false },
      },
      prefabs: [TREE_DEF],
      entities: [
        box("box0", "Box 0", [XS.box0, ROW_Y, 0]),
        box("box1", "Box 1", [XS.box1, ROW_Y, 0]),
        box("box2", "Box 2", [XS.box2, ROW_Y, 0]),
        {
          id: "tree",
          name: "Tree",
          prefab: { guid: TREE_GUID, path: TREE_PATH },
          position: [XS.tree, ROW_Y, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          overrides: [],
        },
      ],
    },
    null,
    2,
  ),
);

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: ROOT });

const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !/404|Failed to load resource/.test(m.text())) pageErrors.push(m.text());
});

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(
  async ({ ROOT }) => {
    const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
    await useProjectStore.getState().openProject(ROOT);
    const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
    await openScenePath(`${ROOT}/scenes/Box.scene`);
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    globalThis.__engine = await ensureEngine();
  },
  { ROOT },
);
await settle(4000);

await page.evaluate(
  ({ ROW_Y }) => {
    const v = globalThis.__viewport;
    v.camera.position.set(0, ROW_Y, 16);
    v.orbit.target.set(0, ROW_Y, 0);
    v.orbit.update();
    v.camera.updateMatrixWorld(true);
  },
  { ROW_Y },
);
await settle(1500);

// ---------------------------------------------------------------------------
const selection = () =>
  page.evaluate(async () => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    return useSelectionStore.getState().ids;
  });

const setSelection = (ids) =>
  page.evaluate(async (list) => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    if (list.length) useSelectionStore.getState().select(list);
    else useSelectionStore.getState().clear();
  }, ids);

/** Screen position of an entity's origin. */
const screenOf = (id) =>
  page.evaluate((entityId) => {
    const v = globalThis.__viewport;
    const object = globalThis.__engine.getEntity(entityId).object3D;
    object.updateMatrixWorld(true);
    const p = object.position.clone().setFromMatrixPosition(object.matrixWorld).project(v.camera);
    const rect = v.canvas.getBoundingClientRect();
    return {
      x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
    };
  }, id);

const cameraPose = () =>
  page.evaluate(() => {
    const q = globalThis.__viewport.camera.quaternion;
    return [q.x, q.y, q.z, q.w];
  });
const cameraPosition = () => page.evaluate(() => globalThis.__viewport.camera.position.toArray());
const moved = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 1e-4);

const orbitEnabled = () => page.evaluate(() => !!globalThis.__viewport.orbit?.enabled);
const marqueeVisible = () =>
  page.evaluate(() => !!document.querySelector(".viewport-marquee.visible"));

/**
 * Drags a rectangle from one screen point to another with `modifiers` held.
 * `midway` runs while the button is still down, which is the only moment the
 * overlay and the disabled orbit can be observed.
 */
async function dragBox(from, to, modifiers = [], midway) {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await settle(120);
  const observed = midway ? await midway() : null;
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await settle(120);
  await page.mouse.up();
  for (const key of modifiers) await page.keyboard.up(key);
  await settle(250);
  return observed;
}

/** A rectangle that covers the given entities' origins with margin. */
async function bandOver(ids, pad = 45) {
  const points = [];
  for (const id of ids) points.push(await screenOf(id));
  return {
    from: { x: Math.min(...points.map((p) => p.x)) - pad, y: Math.min(...points.map((p) => p.y)) - pad },
    to: { x: Math.max(...points.map((p) => p.x)) + pad, y: Math.max(...points.map((p) => p.y)) + pad },
  };
}

// ---------------------------------------------------------------------------
console.log("\nthe fixture is a real prefab instance (otherwise this test proves nothing)");

const treeShape = await page.evaluate(() => {
  const entity = globalThis.__engine.getEntity("tree");
  const names = [];
  const walk = (e) => { for (const c of e.children) { names.push(c.name); walk(c); } };
  if (entity) walk(entity);
  return { isInstance: !!entity?.prefab, descendants: names };
});
check("the scene's Tree expanded into an instance", treeShape.isInstance, JSON.stringify(treeShape.isInstance));
check("...with the prefab's meshes underneath it",
  treeShape.descendants.includes("Trunk") && treeShape.descendants.includes("Leaf"),
  treeShape.descendants.join(", ") || "no children");

// ---------------------------------------------------------------------------
console.log("\nalt+drag replaces the selection");

await setSelection([]);
const band01 = await bandOver(["box0", "box1"]);
const before = await cameraPose();
const midway = await dragBox(band01.from, band01.to, ["Alt"], async () => ({
  marquee: await marqueeVisible(),
  orbit: await orbitEnabled(),
}));
const afterAlt = await selection();
check("the boxes under the band are selected", same(afterAlt, ["box0", "box1"]), afterAlt.join(", ") || "nothing");
check("the marquee rectangle is on screen while dragging", midway.marquee === true);
check("OrbitControls is off while dragging", midway.orbit === false);
check("the camera did NOT rotate under the marquee", !moved(before, await cameraPose()));
check("...and orbiting is back on afterwards", (await orbitEnabled()) === true);

// ---------------------------------------------------------------------------
console.log("\nthe camera gestures still work (the regression this shipped with)");

// Put the camera back where the screen positions were measured from.
const resetCamera = async () => {
  await page.evaluate(({ ROW_Y }) => {
    const v = globalThis.__viewport;
    v.camera.position.set(0, ROW_Y, 16);
    v.orbit.target.set(0, ROW_Y, 0);
    v.orbit.update();
    v.camera.updateMatrixWorld(true);
  }, { ROW_Y });
  await settle(600);
};
await resetCamera();

// A pan moves the camera POSITION and leaves its orientation alone; an orbit
// does the reverse. Asserting both halves is what tells "panning still works"
// apart from "the marquee let the drag fall through to a rotate".
for (const key of ["Shift", "Control"]) {
  await setSelection([]);
  const quatBefore = await cameraPose();
  const posBefore = await cameraPosition();
  await dragBox(band01.from, band01.to, [key]);
  const posAfter = await cameraPosition();
  check(`${key}+drag still pans the camera`, moved(posBefore, posAfter),
    posAfter.map((n) => n.toFixed(2)).join(", "));
  check(`...without rotating it, and without selecting anything`,
    !moved(quatBefore, await cameraPose()) && (await selection()).length === 0);
  await resetCamera();
}

await setSelection([]);
const beforePlain = await cameraPose();
await dragBox(band01.from, band01.to, []);
check("an unmodified drag still orbits the camera", moved(beforePlain, await cameraPose()));
check("...and selects nothing", (await selection()).length === 0);
await resetCamera();

// ---------------------------------------------------------------------------
console.log("\nalt+shift adds, alt+ctrl removes");

await setSelection(["box2"]);
const band0 = await bandOver(["box0"]);
await dragBox(band0.from, band0.to, ["Alt", "Shift"]);
const afterAdd = await selection();
check("alt+shift+drag keeps what was selected and adds the box", same(afterAdd, ["box2", "box0"]),
  afterAdd.join(", ") || "nothing");

await dragBox(band0.from, band0.to, ["Alt", "Control"]);
const afterRemove = await selection();
check("alt+ctrl+drag takes it back out", same(afterRemove, ["box2"]), afterRemove.join(", ") || "nothing");

// ---------------------------------------------------------------------------
console.log("\nescape cancels");

await setSelection(["box2"]);
await page.keyboard.down("Alt");
await page.mouse.move(band01.from.x, band01.from.y);
await page.mouse.down();
await page.mouse.move(band01.to.x, band01.to.y, { steps: 6 });
await settle(150);
const duringEscape = await selection();
await page.keyboard.press("Escape");
await settle(200);
await page.mouse.up();
await page.keyboard.up("Alt");
await settle(250);
check("the marquee had changed the selection before Escape", !same(duringEscape, ["box2"]),
  duringEscape.join(", "));
const afterEscape = await selection();
check("Escape puts the pre-drag selection back", same(afterEscape, ["box2"]), afterEscape.join(", ") || "nothing");
check("...and re-enables orbiting", (await orbitEnabled()) === true);

// ---------------------------------------------------------------------------
console.log("\na click means the whole model");

await setSelection([]);
const leaf = await page.evaluate(() => {
  const entity = globalThis.__engine.getEntity("tree");
  const find = (e, name) => {
    for (const c of e.children) {
      if (c.name === name) return c;
      const hit = find(c, name);
      if (hit) return hit;
    }
    return null;
  };
  return find(entity, "Leaf")?.id ?? null;
});
check("the prefab's Leaf is its own entity", !!leaf, leaf ?? "not found");

const leafAt = await screenOf(leaf);
await page.mouse.click(leafAt.x, leafAt.y);
await settle(400);
const clicked = await selection();
check("clicking a leaf of the prefab selects the instance ROOT", same(clicked, ["tree"]),
  clicked.join(", ") || "nothing");

await setSelection([]);
await settle(200);
await page.keyboard.down("Alt");
await page.mouse.click(leafAt.x, leafAt.y);
await page.keyboard.up("Alt");
await settle(400);
const alted = await selection();
check("alt+click drills to the exact child", same(alted, [leaf]), alted.join(", ") || "nothing");

// Two real presses, not `clickCount: 2` — puppeteer's clickCount sends a
// SINGLE down/up pair carrying a count, and the drill is timed off consecutive
// releases (a real double-click is two presses; `detail` is 0 on pointer
// events, so counting them ourselves is the portable way).
await setSelection([]);
await settle(600);
await page.mouse.click(leafAt.x, leafAt.y);
await settle(80);
await page.mouse.click(leafAt.x, leafAt.y);
await settle(400);
const doubled = await selection();
check("double-click drills too", same(doubled, [leaf]), doubled.join(", ") || "nothing");

await setSelection([]);
const treeBand = await bandOver(["tree"], 60);
await dragBox(treeBand.from, treeBand.to, ["Alt"]);
const marqueed = await selection();
check("a marquee over the model selects ONE id, not its meshes", same(marqueed, ["tree"]),
  marqueed.join(", ") || "nothing");

console.log("");
check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
