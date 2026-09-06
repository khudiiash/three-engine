// Smart query search smoke: the hierarchy search box, the Ctrl+F quick search
// and the shared recent-searches list, driven through the real inputs.
//
//   npx vite --port 5262 --strictPort
//   node scripts/run-query-search-smoke.mjs [url]
//
// HEADED=1 to watch it run. START THE DEV SERVER FRESH — a stale server makes
// the harness's importLive a second copy of the app (see run-editor-ui-smoke.mjs).
//
// The ASSETS half of the query language is NOT exercised here on purpose: the
// pixel-size and material probes are Tauri commands over real project files,
// which a browser harness has neither of. That half is pinned by
// tests/query-eval-asset.test.mjs and tests/asset-meta-index.test.mjs instead.
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5262/";
const RECENTS_KEY = "engine.search.recents.v1";

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADED ? false : "new",
  userDataDir: process.env.SMOKE_USER_DATA ?? undefined,
  args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });

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

const IMPORT_LIVE = `
const importLive = (path) => {
  const prefix = location.origin + path;
  const fetched = performance.getEntriesByType("resource").map((e) => e.name)
    .filter((n) => n === prefix || n.startsWith(prefix + "?"));
  const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
  return import(/* @vite-ignore */ live ?? path);
};`;

/**
 * Four lamps: the prefix, the enable flag, the intensity and the entity flag
 * each rule one out. Plus a `Rig` holding a nested lamp two levels down, which
 * is what makes `Rig > Lamp...` a real claim rather than a shape test — a
 * one-level version would pass with a direct-children implementation.
 */
const BUILD_SCENE = `${IMPORT_LIVE}
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const { useSceneStore } = await importLive("/src/editor/store/sceneStore.js");
  engine.clear();
  const mk = (id, name, intensity, parent) => {
    const entity = engine.createEntity({ id, name, parent });
    entity.addComponent("light", { intensity });
    return entity;
  };
  mk("lamp-a", "Lamp A", 3);
  mk("lamp-b", "Lamp B", 1);
  mk("floor-lamp", "Floor Lamp", 3);
  const dark = mk("dark-lamp", "Dark Lamp", 3);
  dark.setEnabledInEditor(false);
  const rig = engine.createEntity({ id: "rig", name: "Rig" });
  rig.addComponent("mesh", { castShadow: true });
  const socket = engine.createEntity({ id: "socket", name: "Socket", parent: rig });
  mk("rig-lamp", "Lamp Nested", 5, socket);
  useSceneStore.getState().refresh();
  return engine.entities.size;`;

/** React-controlled inputs need the native setter; a plain .value write is undone. */
const typeInto = (selector, text) =>
  page.evaluate((sel, value) => {
    const input = document.querySelector(sel);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, selector, text);

const visibleEntityRows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".hierarchy-panel .hierarchy-row")]
      .filter((r) => r.offsetParent !== null)
      .map((r) => r.dataset.entityId),
  );

async function boot() {
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  await page.evaluate(() => {
    localStorage.removeItem("engine.search.recents.v1");
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await wait(6000);
}

await boot();
const built = await page.evaluate(`(async () => {${BUILD_SCENE}})()`);
await wait(800);
check("the harness scene reached the editor's engine", built === 7, `${built} entities`);

// --- hierarchy: plain search is unchanged ------------------------------------

await typeInto(".hierarchy-search-input", "lamp");
await wait(500);
const plainRows = await visibleEntityRows();
// Search mode renders sortMatchIds, not scene order: tier first (0 = the name
// STARTS with the query, 1 = merely contains it), then name as the tiebreaker.
// So the three "Lamp *" lead, and "Dark Lamp" precedes "Floor Lamp" in tier 1.
check(
  "a plain query still finds every lamp by substring, ranked prefix-first",
  plainRows.join(",") === "lamp-a,lamp-b,rig-lamp,dark-lamp,floor-lamp",
  plainRows.join(","),
);

// --- hierarchy: the structured query discriminates on every clause -----------

const QUERY = "Lamp...?enabled=true&light.intensity>2";
await typeInto(".hierarchy-search-input", QUERY);
await wait(500);
const smartRows = await visibleEntityRows();
check(
  "Lamp...?enabled=true&light.intensity>2 matches only the enabled bright prefix-lamps",
  smartRows.join(",") === "lamp-a,rig-lamp",
  smartRows.join(",") || "(no rows)",
);

// --- the three shorthands, through the real box ------------------------------

// A filter with no `?` in front of it. This is the whole term: no name half,
// so it can only have arrived through the filter.
await typeInto(".hierarchy-search-input", "mesh.castShadow=true");
await wait(500);
const bareFilterRows = await visibleEntityRows();
check(
  "a bare filter needs no `?` — mesh.castShadow=true finds the rig",
  bareFilterRows.join(",") === "rig",
  bareFilterRows.join(",") || "(no rows)",
);

// A filter with no VALUE is an existence test.
await typeInto(".hierarchy-search-input", "R...?mesh");
await wait(500);
const existsRows = await visibleEntityRows();
check(
  "a valueless filter is an existence test — R...?mesh finds the rig",
  existsRows.join(",") === "rig",
  existsRows.join(",") || "(no rows)",
);

// ...and `!` negates it.
await typeInto(".hierarchy-search-input", "Lamp...?!mesh");
await wait(500);
const negatedRows = await visibleEntityRows();
check(
  "?!mesh excludes the one entity that has a mesh",
  negatedRows.length === 3 && !negatedRows.includes("rig"),
  negatedRows.join(",") || "(no rows)",
);

// --- the scope operator ------------------------------------------------------

await typeInto(".hierarchy-search-input", "Rig > Lamp...");
await wait(500);
const scopedRows = await visibleEntityRows();
check(
  "Rig > Lamp... finds only the lamp nested two levels under the Rig",
  scopedRows.join(",") === "rig-lamp",
  scopedRows.join(",") || "(no rows)",
);

// The left half may be a filter, and the `>` must not be read as a comparison.
await typeInto(".hierarchy-search-input", "mesh.castShadow=true > ?light.intensity>4");
await wait(500);
const scopedFilterRows = await visibleEntityRows();
check(
  "a scope and a comparison coexist on one line — the spaces are the whole rule",
  scopedFilterRows.join(",") === "rig-lamp",
  scopedFilterRows.join(",") || "(no rows)",
);

// Half-typed `Rig >` must behave as `Rig`, never as "everything".
await typeInto(".hierarchy-search-input", "Rig >");
await wait(500);
const halfTypedRows = await visibleEntityRows();
check(
  "a trailing `>` mid-typing shows the left half rather than emptying the panel",
  halfTypedRows.includes("rig") && !halfTypedRows.includes("lamp-a"),
  halfTypedRows.join(",") || "(no rows)",
);

// A filter-only term (tier 5) surfaces rows with no name to match.
await typeInto(".hierarchy-search-input", "?enabled=false");
await wait(500);
const darkRows = await visibleEntityRows();
check(
  "?enabled=false finds the disabled lamp without any name to match",
  darkRows.join(",") === "dark-lamp",
  darkRows.join(","),
);

// Ctrl+Shift+A selects exactly what the search shows.
await typeInto(".hierarchy-search-input", QUERY);
await wait(500);
await page.keyboard.down("Control");
await page.keyboard.down("Shift");
await page.keyboard.press("KeyA");
await page.keyboard.up("Shift");
await page.keyboard.up("Control");
await wait(400);
const selectedIds = await page.evaluate(() =>
  [...document.querySelectorAll(".hierarchy-panel .hierarchy-row.selected")].map((r) => r.dataset.entityId),
);
check(
  "Ctrl+Shift+A selects exactly the matching rows",
  selectedIds.join(",") === "lamp-a,rig-lamp",
  `selected=[${selectedIds.join(",")}]`,
);

// Clearing the box lets the idle debounce record the last executed query.
await typeInto(".hierarchy-search-input", "");
await wait(1400);

// --- Ctrl+F: recent searches --------------------------------------------------

await page.keyboard.down("Control");
await page.keyboard.press("KeyF");
await page.keyboard.up("Control");
await wait(500);
const recentsText = await page.evaluate(() =>
  [...document.querySelectorAll(".quick-search-result")].map((r) => r.textContent),
);
check(
  "Ctrl+F with an empty query shows the executed search as a recent",
  recentsText.some((t) => t.includes("Lamp...")),
  JSON.stringify(recentsText.slice(0, 4)),
);

// Activating a recent fills the input without closing the dialog.
const clickedRecent = await page.evaluate(() => {
  const row = [...document.querySelectorAll(".quick-search-result")].find((r) => r.textContent.includes("Lamp..."));
  row?.click();
  return !!row;
});
await wait(300);
const filled = await page.evaluate(() => document.querySelector(".quick-search-input-wrap input")?.value ?? "");
const stillOpen = await page.evaluate(() => !!document.querySelector(".quick-search"));
check(
  "clicking a recent fills the query and keeps the dialog open",
  clickedRecent && filled.includes("Lamp...") && stillOpen,
  `value="${filled}"`,
);

// --- quick search: structured filtering across its pools ----------------------

await typeInto(".quick-search-input-wrap input", "?enabled=false");
await wait(600);
const quickEntities = await page.evaluate(() =>
  [...document.querySelectorAll(".quick-search-result")]
    .filter((r) => r.textContent.includes("Entity"))
    .map((r) => r.querySelector(".quick-search-title")?.textContent?.trim()),
);
check(
  "a filter-only query filters Ctrl+F entity results too",
  quickEntities.length >= 1 && quickEntities.every((n) => n === "Dark Lamp"),
  JSON.stringify(quickEntities),
);

// Select the filtered entity from the dialog — the whole pipeline end to end.
await page.evaluate(() => {
  const row = [...document.querySelectorAll(".quick-search-result")].find(
    (r) => r.querySelector(".quick-search-title")?.textContent?.trim() === "Dark Lamp",
  );
  row?.click();
});
await wait(600);
// The async IIFE is not optional: a bare template string is evaluated as a
// SCRIPT, where a top-level `await` is a SyntaxError.
const selection = await page.evaluate(`(async () => {${IMPORT_LIVE}
  const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
  const { useSceneStore } = await importLive("/src/editor/store/sceneStore.js");
  const id = useSelectionStore.getState().ids[0];
  return id ? (useSceneStore.getState().entities[id]?.name ?? id) : null;
})()`);
check(
  "choosing the filtered result selects the disabled lamp in the editor",
  selection === "Dark Lamp",
  String(selection),
);

// ---------------------------------------------------------------------------

await page.evaluate((key) => localStorage.removeItem(key), RECENTS_KEY);

const passed = results.filter((r) => r.ok).length;
const realErrors = errors.filter((e) => !/save_scene|Failed to load resource|GPU/i.test(e));
if (realErrors.length) {
  console.log(`\n${realErrors.length} console error(s):`);
  for (const e of realErrors.slice(0, 8)) console.log(`  ${e.slice(0, 300)}`);
}
console.log(
  `\n${passed === results.length && !realErrors.length ? "QUERY-SEARCH PASS" : "QUERY-SEARCH FAIL"} — ` +
    `${passed}/${results.length} checks, ${realErrors.length} console errors`,
);
await browser.close();
process.exit(passed === results.length && !realErrors.length ? 0 : 1);
