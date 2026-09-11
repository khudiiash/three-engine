// The sculpt brush cursor, driven through the REAL geometry editor.
//
// The cursor used to be a DOM circle pinned at the pointer, and the whole
// point of replacing it with a ring in the scene is that it now claims to
// report three things a flat disc could not: where on the surface the dab
// lands, which way that surface faces, and how far the brush actually
// reaches. Those are exactly the claims a kernel test cannot check — they
// live in the boundary conversions between the local space every vertex is
// expressed in and the world space the camera sees.
//
// So the checks that matter here are the transform ones, and they are run
// twice: once on an entity at the identity, and once on one rotated 45° and
// scaled 2×, where a forgotten normal matrix or a forgotten length
// conversion stops being invisible.
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5199/";
const ROOT = path.join(os.tmpdir(), "sculpt-cursor-smoke").replaceAll("\\", "/");

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

/* -------------------------------------------------------------------------- */

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "project.json"), JSON.stringify({
  name: "SculptCursorSmoke", version: 1, lastScene: "scenes/Sculpt.scene", modules: [],
}, null, 2));

const meshEntity = (id, name, position, rotation, scale) => ({
  id, name, position, rotation, scale,
  viewOnly: false, enabledInEditor: true, enabledInGame: true,
  components: [{ type: "mesh", props: { enabled: true, geometry: "box", geometryAsset: "", material: "", castShadow: true, receiveShadow: true } }],
  children: [],
});

fs.writeFileSync(path.join(ROOT, "scenes", "Sculpt.scene"), JSON.stringify({
  version: 1, name: "Sculpt",
  settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
  entities: [
    meshEntity("plain", "Plain", [0, 0, 0], [0, 0, 0], [1, 1, 1]),
    // Rotated so a local normal and a world one genuinely differ, and scaled so
    // a local length and a world one do too.
    meshEntity("skewed", "Skewed", [4, 0, 0], [0, Math.PI / 4, 0], [2, 2, 2]),
  ],
}, null, 2));

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
await installTauriShim(page, { writableRoot: ROOT });
page.on("pageerror", (e) => console.log(`  pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !/404|Failed to load resource/.test(m.text())) console.log(`  console error: ${m.text()}`);
});

await page.evaluateOnNewDocument(() => {
  globalThis.__importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
});

await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.evaluate(async ({ ROOT }) => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  await useProjectStore.getState().openProject(ROOT);
  const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
  await openScenePath(`${ROOT}/scenes/Sculpt.scene`);
  const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
  globalThis.__engine = await ensureEngine();
}, { ROOT });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(3500);

/* -------------------------------------------------------------------------- */
/* Page-side probes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything the checks need about the cursor, plus the answer computed the
 * long way round from the object's own world matrix.
 *
 * The independent path matters: `applyNormalMatrix(session.worldNormalMatrix)`
 * is the code under test, so the expected normal is rebuilt here from
 * `matrixWorld` alone — inverse transpose, then `transformDirection`, which is
 * three's own primitive for exactly this.
 */
const readCursor = () => page.evaluate(() => {
  const session = globalThis.__geometrySession;
  if (!session?.brushCursor) return null;
  const cursor = session.brushCursor;
  const scratch = cursor.group.position.clone();
  const forward = cursor.group.getWorldDirection(scratch.clone());

  const hit = session.raycastAtLast?.() ?? null;
  const matrixWorld = session.meshObject.matrixWorld;
  let expectedPoint = null;
  let expectedNormal = null;
  let localNormal = null;
  if (hit) {
    expectedPoint = hit.point.clone().applyMatrix4(matrixWorld);
    const normal = hit.normal ?? hit.face?.normal ?? null;
    if (normal) {
      localNormal = normal.clone().normalize();
      expectedNormal = normal.clone().transformDirection(matrixWorld.clone().invert().transpose());
    }
  }
  const array = (v) => (v ? [v.x, v.y, v.z] : null);
  return {
    visible: cursor.group.visible,
    dotVisible: cursor.dot.visible,
    ringOpacity: cursor.material.opacity,
    outlineOpacity: cursor.outline.material.opacity,
    position: array(cursor.group.position),
    forward: array(forward),
    scale: cursor.group.scale.x,
    // Uniform, or the ring is an ellipse.
    scaleUniform: Math.abs(cursor.group.scale.x - cursor.group.scale.y) < 1e-9
      && Math.abs(cursor.group.scale.x - cursor.group.scale.z) < 1e-9,
    dotScale: cursor.dot.scale.x,
    inScene: cursor.group.parent === session.scene,
    // WebGPU has no loop topology: a LineLoop here is dropped by the renderer
    // with only a console warning, so the outline silently never draws.
    outlineDrawable: cursor.outline.isLine === true && cursor.outline.isLineLoop !== true,
    hasHit: !!hit,
    expectedPoint: array(expectedPoint),
    expectedNormal: array(expectedNormal),
    localNormal: array(localNormal),
    brushRadius: session.brushRadius,
    sculpting: session.sculpting,
  };
});

const meshDigest = () => page.evaluate(() => {
  const session = globalThis.__geometrySession;
  let sum = 0;
  for (const vert of session.mesh.verts) sum += vert.co[0] * 3.1 + vert.co[1] * 5.7 + vert.co[2] * 9.3;
  return { verts: session.mesh.verts.size, sum: +sum.toFixed(6) };
});

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Opens the geometry editor on `entityId` in Sculpt mode. */
const openSculpt = async (entityId) => {
  await page.evaluate(async (id) => {
    const { useGeometryEditStore } = await globalThis.__importLive("/src/editor/store/geometryEditStore.js");
    useGeometryEditStore.getState().exit();
    delete globalThis.__geometrySession;
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().select([id]);
    const { ensureGeometryAsset } = await globalThis.__importLive("/src/editor/geometryEditing.js");
    await ensureGeometryAsset(id);
    useGeometryEditStore.getState().enter(id);
  }, entityId);
  await page.waitForFunction(() => !!globalThis.__geometrySession, { timeout: 30000 });
  await settle(2500);

  // Frame the object, so the canvas centre is over it whatever its transform.
  const canvas = await page.$(".geometry-editor-canvas");
  const box = await canvas.boundingBox();
  const centre = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
  await page.mouse.click(centre.x, centre.y);
  await settle(300);
  await page.keyboard.press("Home");
  await settle(700);

  const entered = await page.evaluate(() => {
    const button = [...document.querySelectorAll(".toolbar-btn")].find((b) => b.textContent.trim() === "Sculpt");
    if (!button) return false;
    button.click();
    return true;
  });
  if (!entered) throw new Error("no Sculpt button in the geometry toolbar");
  await settle(700);
  return { box, centre };
};

/* -------------------------------------------------------------------------- */

const run = async (entityId, label, expectedScale) => {
  console.log(`\n${label}`);
  const { box, centre } = await openSculpt(entityId);

  await page.mouse.move(centre.x, centre.y, { steps: 4 });
  await settle(300);
  const over = await readCursor();

  check("sculpt mode is armed", !!over?.sculpting);
  check("hovering the surface shows the cursor", !!over?.visible && over.hasHit,
    over ? `visible=${over.visible} hit=${over.hasHit}` : "no cursor");
  if (!over?.hasHit) { check(`${label}: ray hit the mesh at the canvas centre`, false); return; }

  check("the ring hangs off the scene, not the scaled mesh", over.inScene);
  check("the outline is a topology WebGPU actually draws", over.outlineDrawable);
  check("the ring sits on the surface", distance(over.position, over.expectedPoint) < 1e-4,
    `off by ${distance(over.position, over.expectedPoint).toExponential(2)}`);
  check("the ring faces along the surface normal",
    !!over.expectedNormal && dot(over.forward, over.expectedNormal) > 0.999,
    over.expectedNormal ? `dot ${dot(over.forward, over.expectedNormal).toFixed(6)}` : "no normal on the hit");
  check("the ring is a circle, not an ellipse", over.scaleUniform);
  check("the ring's world radius is the brush radius in world units",
    Math.abs(over.scale - over.brushRadius * expectedScale) < over.brushRadius * expectedScale * 0.02,
    `${over.scale.toFixed(4)} vs ${(over.brushRadius * expectedScale).toFixed(4)}`);
  check("the centre dot is far smaller than the ring", over.dotScale < 0.2, `dot ${over.dotScale.toFixed(4)}× ring`);

  // Under a rotated entity a local normal and a world one must part company —
  // otherwise the check above would pass on a cursor that never transformed
  // anything at all.
  if (expectedScale !== 1) {
    check("a rotated entity's world normal is not its local one",
      dot(over.forward, over.localNormal) < 0.99,
      `dot ${dot(over.forward, over.localNormal).toFixed(4)}`);
  }

  /* Off the surface ------------------------------------------------------- */

  await page.mouse.move(box.x + 12, box.y + 12, { steps: 4 });
  await settle(300);
  const off = await readCursor();
  check("off the surface the cursor stays, dimmed, with no centre dot",
    !!off?.visible && !off.dotVisible && off.ringOpacity < over.ringOpacity,
    off ? `visible=${off.visible} dot=${off.dotVisible} opacity=${off.ringOpacity}` : "no cursor");

  /* Resizing without moving the pointer ----------------------------------- */

  await page.mouse.move(centre.x, centre.y, { steps: 4 });
  await settle(300);
  const before = await readCursor();
  await page.keyboard.press("BracketRight");
  await page.keyboard.press("BracketRight");
  await settle(400);
  const after = await readCursor();
  check("] grows the ring with the pointer standing still",
    after.scale > before.scale * 1.2 && Math.abs(after.scale / after.brushRadius - before.scale / before.brushRadius) < 1e-3,
    `${before.scale.toFixed(4)} → ${after.scale.toFixed(4)}`);
  await page.keyboard.press("BracketLeft");
  await page.keyboard.press("BracketLeft");
  await settle(400);

  /* The cursor must not shadow the thing it is drawn on -------------------- */

  const beforeStroke = await meshDigest();
  await page.mouse.move(centre.x, centre.y, { steps: 2 });
  await page.mouse.down();
  await page.mouse.move(centre.x + 26, centre.y + 14, { steps: 8 });
  await page.mouse.up();
  await settle(600);
  const afterStroke = await meshDigest();
  check("a stroke still reaches the mesh through the cursor",
    afterStroke.sum !== beforeStroke.sum,
    `${beforeStroke.verts} verts → ${afterStroke.verts}`);

  /* Leaving sculpt mode ---------------------------------------------------- */

  await page.evaluate(() => {
    [...document.querySelectorAll(".toolbar-btn")].find((b) => b.textContent.trim() === "Edit")?.click();
  });
  await settle(500);
  const left = await readCursor();
  check("leaving sculpt mode hides the cursor", left && !left.visible);
};

await run("plain", "an entity at the identity", 1);
await run("skewed", "an entity rotated 45° and scaled 2×", 2);

/* -------------------------------------------------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
await browser.close();
process.exit(failed ? 1 : 0);
