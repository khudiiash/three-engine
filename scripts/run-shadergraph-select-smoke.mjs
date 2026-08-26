// Opening the Shader Graph panel must not repaint the scene.
//
// Reported as "whenever Shader Graph is open, clicking on meshes often turns
// them white, like resetting their albedo". It did, and nothing about it was
// random — it happened to exactly those materials that have no shader graph:
//
// A .mat authored in the Inspector keeps its look in `material.color` and
// `material.map`. It has no `shaderGraph` key, so the panel shows DEFAULT_GRAPH
// — one Principled BSDF, base colour white — as a starting point. The panel's
// load then bumped `structural`, the compile effect ran, and
// `applyGraphMutations` nulls EVERY node slot before setting the graph's:
// `colorNode` becomes white and, being a node, it overrides `color` and `map`.
// One selection, and every mesh sharing that material went white until reload.
//
// The rule this pins: **reading a material must not change how it looks.** The
// graph takes the material over on the first real EDIT, never on selection —
// the same contract the shared Default material already had, extended to any
// .mat that isn't graph-authored yet.
//
//   npx vite --port 5219
//   node scripts/run-shadergraph-select-smoke.mjs [url]
//
// Env: HEADED=1 to watch, KEEP=1 to leave the scratch project behind.
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs on Vite `?t=` twins.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5219/";
const ROOT = path.join(os.tmpdir(), "shadergraph-select-smoke").replaceAll("\\", "/");

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

// A plain material: a colour and nothing else. No `shaderGraph` key — this is
// what the Inspector writes, and it is the case that broke.
const PLAIN_MAT = `${ROOT}/materials/Crimson.mat`;
const PLAIN_COLOR = "#c81e28";

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, "scenes"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "materials"), { recursive: true });
// A texture for the Texture node's picker to find. Contents don't matter — the
// picker lists by extension — but it has to be a real file on disk.
fs.mkdirSync(path.join(ROOT, "textures"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "textures", "Crate_Albedo.png"),
  Buffer.from("89504e470d0a1a0a", "hex"),
);
fs.writeFileSync(
  path.join(ROOT, "project.json"),
  JSON.stringify({ name: "SgSelect", version: 1, lastScene: "scenes/Sg.scene", modules: [] }, null, 2),
);
fs.writeFileSync(
  path.join(ROOT, "materials", "Crimson.mat"),
  JSON.stringify({ color: PLAIN_COLOR, roughness: 0.5, metalness: 0 }, null, 2),
);

const box = (id, name, position, material) => ({
  id,
  name,
  position,
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  viewOnly: false,
  enabledInEditor: true,
  enabledInGame: true,
  components: [{ type: "mesh", props: { geometry: "box", material } }],
  children: [],
});

fs.writeFileSync(
  path.join(ROOT, "scenes", "Sg.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Sg",
      settings: { background: "#202329", ambientColor: "#ffffff", ambientIntensity: 0.6, shadows: false },
      entities: [
        box("painted", "Painted Box", [-2, 0, 0], PLAIN_MAT),
        // A second mesh on the SAME material: the damage was to the shared
        // instance, so it hit meshes that were never even clicked.
        box("sibling", "Sibling Box", [2, 0, 0], PLAIN_MAT),
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
    await openScenePath(`${ROOT}/scenes/Sg.scene`);
    const { ensureEngine } = await globalThis.__importLive("/src/editor/engineInstance.js");
    globalThis.__engine = await ensureEngine();
  },
  { ROOT },
);
await settle(4000);

/** What the LIVE material of an entity actually looks like right now. */
const look = (id) =>
  page.evaluate((entityId) => {
    const mesh = globalThis.__engine.getEntity(entityId)?.getComponent("mesh")?.mesh;
    const material = mesh?.material;
    if (!material) return null;
    return {
      // `colorNode` overrides `color` and `map` when it is set, so its mere
      // presence is the whole bug — no need to read pixels.
      colorNode: !!material.colorNode,
      roughnessNode: !!material.roughnessNode,
      color: `#${material.color?.getHexString?.() ?? ""}`,
    };
  }, id);

const select = (id) =>
  page.evaluate(async (entityId) => {
    const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
    if (entityId) useSelectionStore.getState().select(entityId);
    else useSelectionStore.getState().clear();
  }, id);

console.log("\nthe fixture is a plain, graph-less material (otherwise this proves nothing)");

const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, "materials", "Crimson.mat"), "utf8"));
check("the .mat has no shaderGraph", !("shaderGraph" in onDisk), Object.keys(onDisk).join(", "));

const before = await look("painted");
check("its colour is loaded from the def, not from a node", before?.color === PLAIN_COLOR && !before.colorNode,
  JSON.stringify(before));

console.log("\nopening Shader Graph and selecting the mesh");

await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("shaderGraph");
});
await settle(1500);
check("the panel is open", await page.evaluate(() => !!document.querySelector(".shader-graph-panel, .nodegraph")));

await select("painted");
// Generous: the compile is debounced 150 ms and the autosave 600 ms. Both have
// to have had their chance for a pass here to mean anything.
await settle(2500);

const after = await look("painted");
check("selecting the mesh does NOT hand its material to the graph", after?.colorNode === false, JSON.stringify(after));
check("...and its colour is untouched", after?.color === PLAIN_COLOR, JSON.stringify(after?.color));

const siblingAfter = await look("sibling");
check("...nor does it repaint the other mesh sharing the material",
  siblingAfter?.colorNode === false && siblingAfter?.color === PLAIN_COLOR, JSON.stringify(siblingAfter));

console.log("\nselecting back and forth is still inert");

for (const id of ["sibling", "painted", "sibling"]) {
  await select(id);
  await settle(900);
}
const afterCycling = await look("painted");
check("clicking around leaves the material alone", afterCycling?.colorNode === false && afterCycling?.color === PLAIN_COLOR,
  JSON.stringify(afterCycling));

const stillOnDisk = JSON.parse(fs.readFileSync(path.join(ROOT, "materials", "Crimson.mat"), "utf8"));
check("...and nothing was written to the .mat", !("shaderGraph" in stillOnDisk), Object.keys(stillOnDisk).join(", "));

console.log("\nbut a real edit still takes the material over");

// Reach the editor the way the user does — through the graph's own onChange —
// rather than poking the material directly, so this exercises the takeover
// path and not a shortcut around it.
await select("painted");
await settle(1200);
const edited = await page.evaluate(() => {
  // The BSDF node's colour swatch: change it and the graph becomes the
  // material's, which is the whole point of the panel.
  const input = document.querySelector('.shader-graph-panel input[type="color"], .nodegraph input[type="color"]');
  if (!input) return { found: false };
  // React tracks an input's value behind the property descriptor and skips the
  // change event when its own tracker already holds the new value — assigning
  // `.value` directly and dispatching would be a no-op that LOOKS like a real
  // edit, and the test would then be asserting nothing.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "#33cc66");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { found: true, inNode: !!input.closest(".react-flow__node, .nodegraph-node"), value: input.value };
});
check("there is a colour swatch on a graph node to edit", edited.found && edited.inNode, JSON.stringify(edited));
await settle(2500);

const afterEdit = await look("painted");
check("editing the graph DOES drive the material", afterEdit?.colorNode === true, JSON.stringify(afterEdit));

const savedDef = JSON.parse(fs.readFileSync(path.join(ROOT, "materials", "Crimson.mat"), "utf8"));
check("...and the graph is written to the .mat", "shaderGraph" in savedDef, Object.keys(savedDef).join(", "));
check("...without dropping what the def already had", savedDef.roughness === 0.5, JSON.stringify(savedDef.roughness));

console.log("\nand a material that IS graph-authored still compiles on sight");

// The other direction, and the reason the guard is a flag rather than "never
// compile on load": now that the .mat carries a graph, re-opening it must
// rebuild the material from that graph without waiting for an edit. Clearing
// the selection unmounts the editor, so re-selecting is a genuine fresh load.
await select(null);
await settle(800);
await select("painted");
await settle(2500);
const reopened = await look("painted");
check("re-selecting an authored material compiles its graph", reopened?.colorNode === true, JSON.stringify(reopened));

/* -------------------------------------------------------------------------- */
/* the Texture node can actually pick a texture                                */
/* -------------------------------------------------------------------------- */
//
// `AssetField` coerces a missing `exts` to `[]`, and `[]` matches nothing — so
// an asset param declared without an extension list browses an empty popover
// and refuses every drop. The Texture node was the one asset param in the repo
// that omitted it, which read to the user as "I can't select any of my
// textures". Checked through the same two calls the field itself makes.

console.log("\nthe Texture node's asset picker");
const picker = await page.evaluate(async (root) => {
  const { NODE_TYPES } = await globalThis.__importLive("/src/engine/tslGraph.js");
  const { listProjectAssets } = await globalThis.__importLive("/src/editor/assetLoader.js");
  const param = (NODE_TYPES.texture.params ?? []).find((p) => p.key === "path") ?? {};
  // Exactly what `<AssetField descriptor={{ exts: spec.exts }} />` ends up with.
  const options = await listProjectAssets(root, param.exts ?? []);
  return { exts: param.exts ?? null, options };
}, ROOT);
check("it declares the texture extensions", Array.isArray(picker.exts) && picker.exts.length > 0, JSON.stringify(picker.exts));
check("browsing lists the project's textures", picker.options.length > 0, `${picker.options.length} found`);
check(
  "and the .png is among them",
  picker.options.some((p) => /Albedo\.png$/i.test(p)),
  picker.options.slice(0, 3).join(", "),
);

console.log("");
check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
if (!process.env.KEEP) fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
