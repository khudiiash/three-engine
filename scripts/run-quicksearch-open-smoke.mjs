// Quick search → asset → open, the two-Enter flow.
//
// Ctrl+F, type, Enter reveals the asset in the Assets panel; Enter AGAIN opens
// it in whatever editor owns the type. The second Enter is the fragile half and
// the only reason this test exists: `keyScope` resolves focus before hover, and
// after the quick-search modal closes the pointer is wherever the user left it
// (usually over the viewport). If the reveal doesn't hand keyboard focus to the
// asset grid, the follow-up keystroke lands nowhere — and "nowhere" looks
// exactly like "the feature is flaky", never like a bug with a stack trace.
//
// Also pinned: browsing to the asset's folder clears the asset selection, so
// the selection has to be applied AFTER the navigate or the revealed tile ends
// up ringed but unselected.
//
// And pinned at the end: GHOST ROWS. The result list was keyed on
// `type:title:subtitle`, which is the same string for two entities that share
// a name — React's warning for that says children may be "duplicated and/or
// omitted", and they were: rows from the previous query stayed in the DOM above
// the real match while the footer, counting the array rather than the DOM,
// correctly said "1 result". The scene below deliberately contains duplicate
// names, and the console-error gate at the bottom of this file fails on React's
// key warning, so the fixture and the assertion catch it from both ends.
//
//   npx vite --port 5219
//   node scripts/run-quicksearch-open-smoke.mjs [url]
//
// HEADED=1 to watch it run, VERBOSE=1 for step tracing.
//
// START THE DEV SERVER FRESH — see run-editor-ui-smoke.mjs for why (`?t=`
// module duplication makes harness-created state invisible to the UI).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { installTauriShim } from "./lib/tauriShim.mjs";

const url = process.argv[2] ?? "http://localhost:5219/";

// --- a throwaway project: the asset lives in a SUBFOLDER on purpose, so the
// reveal has to navigate (which is what clears the selection) ---------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-qsopen-"));
fs.writeFileSync(path.join(root, "project.json"), JSON.stringify({ name: "QsOpen", version: 1 }, null, 2));
fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(root, "scripts", "Whirligig.js"),
  "export default class Whirligig {\n  onUpdate(dt) {\n    this.entity.rotation.y += dt;\n  }\n}\n",
);
const scriptPath = path.join(root, "scripts", "Whirligig.js").replaceAll("\\", "/");

// A scene whose entity names REPEAT — the key collision needs two rows that
// look identical to the old key function to reproduce at all.
const sceneEntity = (id, name) => ({
  id,
  name,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  viewOnly: false,
  enabledInEditor: true,
  enabledInGame: true,
  components: [],
  children: [],
});
fs.mkdirSync(path.join(root, "scenes"), { recursive: true });
fs.writeFileSync(
  path.join(root, "scenes", "Ghost.scene"),
  JSON.stringify(
    {
      version: 1,
      name: "Ghost",
      entities: [
        sceneEntity("aaaaaaaaa1", "Light Stand"),
        sceneEntity("aaaaaaaaa2", "Light Stand"),
        sceneEntity("aaaaaaaaa3", "Light Ceiling"),
        sceneEntity("aaaaaaaaa4", "Coffee Table"),
        sceneEntity("aaaaaaaaa5", "bookcaseClosedDoors"),
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
await installTauriShim(page, { writableRoot: root, verbose: !!process.env.VERBOSE });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e.message}`));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => process.env.VERBOSE && console.log(`  [step] ${name}`);

step("goto");
await page.goto(url, { waitUntil: "load", timeout: 45000 });
await wait(6000);

// Open the scratch project without awaiting the page promise from Node — see
// run-editor-polish-smoke.mjs for why that gets collected.
await page.evaluate(async (projectRoot) => {
  const importLive = (p) => {
    const prefix = location.origin + p;
    const fetched = performance.getEntriesByType("resource").map((e) => e.name)
      .filter((n) => n === prefix || n.startsWith(`${prefix}?`));
    const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
    return import(/* @vite-ignore */ live ?? p);
  };
  globalThis.__importLive = importLive;
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  await ensureEngine();
  const { useProjectStore } = await importLive("/src/editor/store/projectStore.js");
  globalThis.__openDone = false;
  useProjectStore.getState().openProject(projectRoot).then(() => (globalThis.__openDone = true));
}, root.replaceAll("\\", "/"));

for (let i = 0; i < 60 && !(await page.evaluate(() => globalThis.__openDone === true)); i++) await wait(500);
step("project open");

// Assets panel on screen and parked at the project root, so the reveal has a
// folder to travel to.
await page.evaluate(async () => {
  const { openPanel } = await globalThis.__importLive("/src/editor/EditorShell.jsx");
  openPanel("assets");
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  await useProjectStore.getState().navigate(useProjectStore.getState().rootPath);
});
await wait(1200);

const before = await page.evaluate(async () => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  const { useCodeStore } = await globalThis.__importLive("/src/editor/codeStore.js");
  return {
    atRoot: useProjectStore.getState().currentPath === useProjectStore.getState().rootPath,
    openFiles: useCodeStore.getState().files.length,
  };
});
check("the Assets panel starts at the project root with nothing open", before.atRoot && before.openFiles === 0, JSON.stringify(before));

// --- Ctrl+F, type, Enter ----------------------------------------------------

// Park the pointer over the viewport — where it lands after a centred modal
// closes, and NOT over the Assets panel. Hover ownership must not be what
// makes this work.
const awayPoint = await page.evaluate(() => {
  const panel = document.querySelector(".assets-panel");
  const r = panel?.getBoundingClientRect();
  const mid = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
  const inside = r && mid.x >= r.left && mid.x <= r.right && mid.y >= r.top && mid.y <= r.bottom;
  return inside ? { x: 8, y: 8 } : mid;
});
await page.mouse.move(awayPoint.x, awayPoint.y);
check(
  "the pointer is parked OUTSIDE the Assets panel for the whole flow",
  await page.evaluate((p) => {
    const r = document.querySelector(".assets-panel")?.getBoundingClientRect();
    return !r || p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom;
  }, awayPoint),
  JSON.stringify(awayPoint),
);

await page.keyboard.down("Control");
await page.keyboard.press("f");
await page.keyboard.up("Control");
await wait(400);
check("Ctrl+F opens quick search", await page.evaluate(() => !!document.querySelector(".quick-search")), "");

await page.keyboard.type("Whirligig");
await wait(500);

const hint = await page.evaluate(() => ({
  top: document.querySelector(".quick-search-result.active .quick-search-title")?.textContent,
  kind: document.querySelector(".quick-search-result.active .quick-search-kind")?.className,
  footer: [...document.querySelectorAll(".quick-search-hint")].map((n) => n.textContent.trim()),
}));
check("the asset is the top hit", hint.top === "Whirligig.js", JSON.stringify(hint.top));
check(
  "the footer promises Reveal, not Open, while an asset is active",
  hint.footer.some((t) => /Reveal/.test(t)),
  JSON.stringify(hint.footer),
);

await page.keyboard.press("Enter");
await wait(1500);

const revealed = await page.evaluate(async () => {
  const { useProjectStore } = await globalThis.__importLive("/src/editor/store/projectStore.js");
  const { useSelectionStore } = await globalThis.__importLive("/src/editor/store/selectionStore.js");
  const { useCodeStore } = await globalThis.__importLive("/src/editor/codeStore.js");
  const active = document.activeElement;
  return {
    overlay: !!document.querySelector(".quick-search"),
    folder: useProjectStore.getState().currentPath,
    selected: useSelectionStore.getState().assetPath,
    ringed: !!document.querySelector(".asset-tile.revealed, .asset-row.revealed"),
    tileSelected: !!document.querySelector(".asset-tile.selected, .asset-row.selected"),
    focusIsGrid: !!active && active.classList.contains("asset-grid"),
    openFiles: useCodeStore.getState().files.length,
  };
});
check("the first Enter closes the overlay and browses to the asset's folder", !revealed.overlay && /scripts$/i.test(revealed.folder ?? ""), JSON.stringify(revealed.folder));
check("the tile is both ringed and SELECTED — the selection survives the navigate", revealed.ringed && revealed.tileSelected, JSON.stringify(revealed));
check("the first Enter reveals only — nothing is opened yet", revealed.openFiles === 0, `${revealed.openFiles} open files`);
check(
  "the reveal hands keyboard focus to the asset grid (pointer is over the viewport)",
  revealed.focusIsGrid,
  JSON.stringify(revealed.focusIsGrid),
);

// --- Enter again -------------------------------------------------------------

await page.keyboard.press("Enter");
await wait(1500);

const opened = await page.evaluate(async () => {
  const { useCodeStore } = await globalThis.__importLive("/src/editor/codeStore.js");
  const state = useCodeStore.getState();
  return { files: state.files, activePath: state.activePath };
});
const norm = (p) => String(p ?? "").replaceAll("\\", "/").toLowerCase();
check(
  "Enter again opens the revealed asset in its editor",
  norm(opened.activePath) === norm(scriptPath) && opened.files.length === 1,
  JSON.stringify(opened),
);

// --- ghost rows --------------------------------------------------------------

await page.evaluate(async (projectRoot) => {
  const { openScenePath } = await globalThis.__importLive("/src/editor/sceneIO.js");
  await openScenePath(`${projectRoot}/scenes/Ghost.scene`);
}, root.replaceAll("\\", "/"));
await wait(2000);

/** What the list is ACTUALLY showing, read from the DOM, next to what it says
 *  it is showing. The bug lived precisely in the gap between the two. */
const listState = () =>
  page.evaluate(() => ({
    rows: [...document.querySelectorAll(".quick-search-result")].map((row) => ({
      title: row.querySelector(".quick-search-title")?.textContent ?? "",
      // "entity" / "asset" / "panel" / "setting" — a panel legitimately named
      // "Hierarchy" is a different thing from every entity answering to its
      // own subtitle, and only the kind tells them apart.
      kind: (row.querySelector(".quick-search-kind")?.className ?? "").replace("quick-search-kind", "").trim(),
    })),
    footer: document.querySelector(".quick-search-result-count")?.textContent ?? "",
  }));

await page.keyboard.down("Control");
await page.keyboard.press("f");
await page.keyboard.up("Control");
await wait(400);
await page.keyboard.type("Light");
await wait(500);

const lights = await listState();
const lightTitles = lights.rows.map((r) => r.title);
// "Use for Lighting" (a Scene Settings property) is a REAL match for "light" —
// the rule is that everything listed contains the query somewhere the user can
// see, not that everything listed is an entity.
check(
  "everything a query returns visibly contains it",
  lights.rows.length > 0 && lightTitles.every((t) => t.toLowerCase().includes("light")),
  lightTitles.join(", ") || "nothing",
);
check(
  "...including both same-named entities, and only the three Light entities",
  lights.rows.filter((r) => r.kind === "entity").length === 3 &&
    lightTitles.filter((t) => t === "Light Stand").length === 2,
  lightTitles.join(", "),
);

// Retype, don't reopen: the stale rows only survived a list that CHANGED.
await page.keyboard.down("Control");
await page.keyboard.press("a");
await page.keyboard.up("Control");
await page.keyboard.type("Shader Graph");
await wait(600);

const narrowed = await listState();
check(
  "narrowing to a panel leaves ONLY the panel on screen",
  narrowed.rows.length === 1 && narrowed.rows[0].title === "Shader Graph",
  narrowed.rows.map((r) => r.title).join(", ") || "nothing",
);
check(
  "...and the DOM agrees with the footer's count",
  narrowed.footer.startsWith(String(narrowed.rows.length)),
  `${narrowed.rows.length} rows vs "${narrowed.footer}"`,
);

// The other half of the report: nothing unrelated is admitted in the first
// place. "hierarchy" is every entity's subtitle and used to return the scene.
await page.keyboard.down("Control");
await page.keyboard.press("a");
await page.keyboard.up("Control");
await page.keyboard.type("hierarchy");
await wait(600);
const subtitleQuery = await listState();
// The Hierarchy PANEL is a real hit and must stay. What must not come back is
// the scene: every entity's subtitle reads "Entity · Hierarchy", and matching
// that turned one keystroke into "here are all 291 of your entities".
check(
  "an entity's category label is not searchable",
  subtitleQuery.rows.every((r) => r.kind !== "entity"),
  subtitleQuery.rows.map((r) => `${r.title}[${r.kind}]`).join(", ") || "nothing",
);
check(
  "...while a panel actually named Hierarchy still answers to it",
  subtitleQuery.rows.some((r) => r.kind === "panel" && r.title === "Hierarchy"),
  subtitleQuery.rows.map((r) => r.title).join(", ") || "nothing",
);

await page.keyboard.press("Escape");
await wait(300);

// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
const realErrors = errors.filter((e) => !/save_scene|Failed to load resource|404/.test(e));
if (realErrors.length) {
  console.log(`\n${realErrors.length} console error(s):`);
  for (const e of realErrors.slice(0, 8)) console.log(`  ${e.slice(0, 300)}`);
}
console.log(
  `\n${passed === results.length && !realErrors.length ? "QUICKSEARCH-OPEN PASS" : "QUICKSEARCH-OPEN FAIL"} — ` +
    `${passed}/${results.length} checks, ${realErrors.length} console errors`,
);
await browser.close();
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {}
process.exit(passed === results.length && !realErrors.length ? 0 : 1);
