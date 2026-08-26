// Renaming a FOLDER is a rename like any other — through the grid tile, and
// through the folder tree's own row. The reported bug: the typed name snaps
// back to the old one on Enter, on folders only.
//
//   * grid tile, F2 → type → Enter          (folder)
//   * grid tile, F2 → type → Enter          (file, the control)
//   * folder tree row, double-click → Enter (folder)
//
// Each case is checked on DISK and in the VISIBLE label, because the panel
// renders whatever the last listing said — a rename that lands on disk but
// never refreshes reads to the user exactly like a rename that failed.
//
//   npx vite --port 5217
//   node scripts/run-folder-rename-smoke.mjs [url]
//
// HEADED=1 to watch it run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5217/";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-folderrename-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "FolderRename", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "Textures"), { recursive: true });
fs.mkdirSync(path.join(root, "Props"), { recursive: true });
fs.writeFileSync(path.join(root, "Textures", "inside.mat"), "{}\n");
fs.writeFileSync(path.join(root, "Loose.mat"), "{}\n");
// A script inside a folder, so renaming that folder has a reference to move.
fs.mkdirSync(path.join(root, "code"), { recursive: true });
fs.writeFileSync(path.join(root, "code", "Runner.ts"), "export default class Runner {}\n");

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await installTauriShim(page, { writableRoot: root, verbose: !!process.env.VERBOSE });

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const onDisk = (name) => fs.existsSync(path.join(root, name));

await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});
await wait(6000);

await page.evaluate(async (projectRoot) => {
  const importLive = (q) => {
    const prefix = location.origin + q;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? q);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  globalThis.__engine = await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore.getState().openProject(projectRoot).then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));
for (let i = 0; i < 90 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);

for (let i = 0; i < 60; i++) {
  if (await page.evaluate(() => document.querySelectorAll(".asset-tile,.asset-row").length > 0)) break;
  await wait(500);
}
check("the Assets panel lists the project", await page.evaluate(() => document.querySelectorAll("[data-asset-path]").length > 0));

/** The label the user actually sees for `name`, or null when no tile shows it. */
const labelFor = (name) =>
  page.evaluate(
    (n) =>
      [...document.querySelectorAll(".asset-name,.asset-row-label")]
        .map((el) => el.textContent?.trim())
        .find((t) => t === n) ?? null,
    name,
  );

/** F2-rename whatever tile carries `oldName`, typing `newName` and pressing Enter. */
async function renameViaGrid(oldName, newName) {
  const found = await page.evaluate((n) => {
    const tile = [...document.querySelectorAll("[data-asset-path]")].find(
      (el) => (el.getAttribute("data-asset-path") ?? "").replaceAll("\\", "/").split("/").pop() === n,
    );
    if (!tile) return false;
    tile.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    tile.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    return true;
  }, oldName);
  if (!found) return false;
  await wait(300);
  // F2 on the grid, the same key path a user takes.
  await page.evaluate(() => document.querySelector(".asset-grid")?.focus());
  await page.keyboard.press("F2");
  await wait(400);
  const armed = await page.evaluate(() => !!document.querySelector("input.rename-input"));
  if (!armed) return false;
  await page.evaluate(() => document.querySelector("input.rename-input")?.focus());
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type(newName);
  await page.keyboard.press("Enter");
  await wait(1800);
  return true;
}

/* -------------------------------------------------------------------------- */
/* 1 — a folder, renamed from the grid                                         */
/* -------------------------------------------------------------------------- */

console.log("\nfolder rename, from the grid");
const gridFolder = await renameViaGrid("Textures", "Skins");
check("the folder tile enters rename mode on F2", gridFolder);
check("the folder is renamed on disk", onDisk("Skins") && !onDisk("Textures"));
check("its contents came along", onDisk(path.join("Skins", "inside.mat")));
check("the panel shows the new name", (await labelFor("Skins")) === "Skins", `old still shown: ${(await labelFor("Textures")) != null}`);

/* -------------------------------------------------------------------------- */
/* 2 — a file, the control                                                     */
/* -------------------------------------------------------------------------- */

console.log("\nfile rename, from the grid (control)");
const gridFile = await renameViaGrid("Loose.mat", "Tight.mat");
check("the file tile enters rename mode on F2", gridFile);
check("the file is renamed on disk", onDisk("Tight.mat") && !onDisk("Loose.mat"));
check("the panel shows the new name", (await labelFor("Tight.mat")) === "Tight.mat");

/* -------------------------------------------------------------------------- */
/* 3 — a folder, renamed from the folder tree                                  */
/* -------------------------------------------------------------------------- */

console.log("\nfolder rename, from the folder tree");
const treeArmed = await page.evaluate(() => {
  const row = [...document.querySelectorAll(".folder-row")].find((el) =>
    /(^|[\\/])Props$/.test(el.getAttribute("title") ?? ""),
  );
  if (!row) return "no row";
  row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  return "clicked";
});
await wait(400);
const treeInput = await page.evaluate(() => !!document.querySelector("input.folder-rename"));
check("the tree row enters rename mode on double-click", treeInput, String(treeArmed));
if (treeInput) {
  await page.evaluate(() => document.querySelector("input.folder-rename")?.focus());
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type("Kit");
  await page.keyboard.press("Enter");
  await wait(1800);
}
check("the tree folder is renamed on disk", onDisk("Kit") && !onDisk("Props"));
check(
  "the tree shows the new name",
  await page.evaluate(() =>
    [...document.querySelectorAll(".folder-label")].some((el) => el.textContent?.trim() === "Kit"),
  ),
);

/* -------------------------------------------------------------------------- */
/* 4 — a case-only rename is a rename                                          */
/* -------------------------------------------------------------------------- */
//
// On Windows `Skins` "already exists" the moment `skins` does, so the refusal
// guard rejected every case-only rename — and because nothing is applied
// optimistically, the panel just showed the old spelling again.

console.log("\ncase-only folder rename");
await renameViaGrid("Skins", "SKINS");
const cased = fs.readdirSync(root).find((n) => n.toLowerCase() === "skins");
check("the folder takes the new casing on disk", cased === "SKINS", `on disk: ${cased}`);
check("its contents survived the two-step", onDisk(path.join("SKINS", "inside.mat")));
check("the panel shows the new casing", (await labelFor("SKINS")) === "SKINS");

/* -------------------------------------------------------------------------- */
/* 5 — a refused rename says so                                                */
/* -------------------------------------------------------------------------- */

console.log("\nrename onto a name that is taken");
await page.evaluate(async (dir) => {
  const { renameEntry } = await globalThis.__importLive("/src/editor/assetOps.js");
  await renameEntry({ path: `${dir}/Kit`, name: "Kit", is_dir: true }, "SKINS");
}, root.replaceAll("\\", "/"));
await wait(800);
check("the collision is refused", onDisk("Kit"));
check(
  "and it reaches the user as a toast, not just the console",
  await page.evaluate(async () => {
    const { useToastStore } = await globalThis.__importLive("/src/editor/toasts.js");
    return useToastStore.getState().toasts.some((t) => t.level === "error" && /rename/i.test(t.title ?? ""));
  }),
);

/* -------------------------------------------------------------------------- */
/* 6 — scripts under a renamed folder follow it                                */
/* -------------------------------------------------------------------------- */
//
// `retargetScriptPath` only ever matched the renamed path itself, so renaming
// the folder a script lived in left every entity pointing at a path that was
// gone — silently, until the behaviour simply stopped running.

console.log("\nscripts under a renamed folder");
await page.evaluate(async (file) => {
  const { commandBus } = await globalThis.__importLive("/src/editor/commands/CommandBus.js");
  const { CreateEntityCommand } = await globalThis.__importLive("/src/editor/commands/entityCommands.js");
  const { SetComponentPropCommand } = await globalThis.__importLive("/src/editor/commands/componentCommands.js");
  const create = new CreateEntityCommand({ name: "Runner", components: [{ type: "script" }] });
  commandBus.execute(create);
  globalThis.__runnerId = create.entityId;
  commandBus.execute(
    new SetComponentPropCommand(create.entityId, "script", "scripts",
      [{ path: file, enabled: true, attributes: {} }], "Set script"),
  );
}, path.join(root, "code", "Runner.ts").replaceAll("\\", "/"));
await wait(600);

await page.evaluate(async (dir) => {
  const { renameEntry } = await globalThis.__importLive("/src/editor/assetOps.js");
  await renameEntry({ path: `${dir}/code`, name: "code", is_dir: true }, "gameplay");
}, root.replaceAll("\\", "/"));
await wait(1800);

check("the folder is renamed on disk", onDisk(path.join("gameplay", "Runner.ts")) && !onDisk("code"));
const slots = await page.evaluate(
  () => (globalThis.__engine.getEntity(globalThis.__runnerId)?.getComponent("script")?.props?.scripts ?? [])
    .map((s) => s.path),
);
check("the entity's script slot follows the folder", slots.every((s) => /gameplay[\\/]Runner\.ts$/.test(s)), JSON.stringify(slots));

/* -------------------------------------------------------------------------- */

const bad = errors.filter((e) => !/favicon|WebGPU|GPUAdapter|Rapier/i.test(e));
if (bad.length) console.log(`\nconsole errors:\n  ${bad.slice(0, 8).join("\n  ")}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`project: ${root}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
