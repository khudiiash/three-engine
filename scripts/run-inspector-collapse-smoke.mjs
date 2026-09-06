// Inspector section folding smoke: the chevron on every inspector section
// (src/editor/panels/InspectorPanel.jsx → SectionFoldHeader, state in
// src/editor/inspectorPrefs.js).
//
// The store itself is pinned headlessly by tests/inspector-prefs.test.mjs. What
// needs a real browser is everything the store cannot see:
//
//   * the fold is keyed by COMPONENT TYPE, so folding "Light" on one entity
//     leaves it folded on the NEXT light you select — the papercut the feature
//     exists to remove, and a claim about two renders of two entities
//   * a reload paints the fold on the FIRST frame rather than opening flat and
//     snapping shut (a MutationObserver, the same way run-hierarchy-fold-smoke
//     does it)
//   * the header still LOOKS like a header. Both hit targets are real
//     `<button>`s, so without the stylesheet they arrive with the UA's own
//     font, background and border and the title row reads as two grey chips.
//     That is a computed-style claim and nothing but a browser can make it.
//
//   npx vite --port 5262 --strictPort
//   node scripts/run-inspector-collapse-smoke.mjs [url]
//
// HEADED=1 to watch it run. START THE DEV SERVER FRESH — a stale server makes
// the harness's importLive a second copy of the app (see run-editor-ui-smoke.mjs).
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5262/";
const STORAGE_KEY = "engine.inspector.collapsed.v1";

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

/** The live-module importer — see run-editor-ui-smoke.mjs. */
const IMPORT_LIVE = `
const importLive = (path) => {
  const prefix = location.origin + path;
  const fetched = performance.getEntriesByType("resource").map((e) => e.name)
    .filter((n) => n === prefix || n.startsWith(prefix + "?"));
  const live = fetched.find((n) => n.includes("?")) ?? fetched[0];
  return import(/* @vite-ignore */ live ?? path);
};`;

/** Two lights: two entities that SHARE a component type is what makes the
 *  "keyed by type, not by entity" claim testable at all. */
const BUILD_SCENE = `${IMPORT_LIVE}
  const { ensureEngine } = await importLive("/src/editor/engineInstance.js");
  const engine = await ensureEngine();
  const { useSceneStore } = await importLive("/src/editor/store/sceneStore.js");
  engine.clear();
  const lampA = engine.createEntity({ id: "fold-lamp-a", name: "Lamp A" });
  lampA.addComponent("light", { intensity: 3 });
  const lampB = engine.createEntity({ id: "fold-lamp-b", name: "Lamp B" });
  lampB.addComponent("light", { intensity: 1 });
  useSceneStore.getState().refresh();
  return engine.entities.size;`;

const select = (id) =>
  page.evaluate(`(async () => {${IMPORT_LIVE}
    const { useSelectionStore } = await importLive("/src/editor/store/selectionStore.js");
    useSelectionStore.getState().select(${JSON.stringify(id)});
    return useSelectionStore.getState().ids.join(",");
  })()`);

/** Every inspector section on screen, as `{ title, collapsed, fields }`.
 *  The entity header (name / tags / prefab) is an `.inspector-section` too and
 *  does NOT fold — it has no `.section-collapse`, which is what `hasChevron`
 *  separates it by. */
const sections = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".inspector-panel .inspector-section")].map((section) => ({
      title: section.querySelector(".section-title")?.textContent?.trim() ?? "",
      collapsed: section.classList.contains("collapsed"),
      hasChevron: !!section.querySelector(".section-collapse"),
      fields: section.querySelectorAll(".field-row").length,
    })),
  );

const sectionNamed = async (title) => (await sections()).find((s) => s.title === title) ?? null;

/** Clicks the chevron of the section whose title is `title`. */
const clickChevron = (title) =>
  page.evaluate((wanted) => {
    const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find(
      (s) => s.querySelector(".section-title")?.textContent?.trim() === wanted,
    );
    section?.querySelector(".section-collapse")?.click();
    return !!section;
  }, title);

/** Clicks the section TITLE — the second, larger hit target. */
const clickTitle = (title) =>
  page.evaluate((wanted) => {
    const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find(
      (s) => s.querySelector(".section-title")?.textContent?.trim() === wanted,
    );
    section?.querySelector(".section-title-hit")?.click();
    return !!section;
  }, title);

const storedCollapsed = () =>
  page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw).collapsed ?? null) : null;
  }, STORAGE_KEY);

/**
 * `wipe` clears the saved folds and RELOADS, because the store reads storage at
 * import time — clearing it in a page that has already imported the module
 * would leave the live store holding the old folds. It is deliberately not an
 * `evaluateOnNewDocument` hook: those stay registered for every later
 * navigation, which would wipe the very state session 2 exists to recover.
 */
async function boot({ wipe = false } = {}) {
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  if (wipe) {
    await page.evaluate((key) => {
      try { localStorage.removeItem(key); } catch { /* private mode */ }
    }, STORAGE_KEY);
    await page.goto(url, { waitUntil: "load", timeout: 45000 });
  }
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
  });
  await wait(6000);
}

// ---------------------------------------------------------------------------
// Session 1 — folding, the two hit targets, and the type key
// ---------------------------------------------------------------------------

await boot({ wipe: true });
const built = await page.evaluate(`(async () => {${BUILD_SCENE}})()`);
await wait(500);
check("the harness scene reached the editor's engine", built === 2, `${built} entities`);

await select("fold-lamp-a");
await wait(600);

const opening = (await sections()).filter((s) => s.hasChevron);
check(
  "the inspector opens with every section expanded and chevroned",
  opening.length >= 2 &&
    opening.every((s) => !s.collapsed) &&
    opening.some((s) => s.title === "Transform" && s.hasChevron && s.fields > 0) &&
    opening.some((s) => s.title === "Light" && s.hasChevron && s.fields > 0),
  JSON.stringify(opening.map((s) => `${s.title}:${s.fields}`)),
);

// --- the header still reads as a header, not as two UA buttons ---------------

const headerStyle = await page.evaluate(() => {
  const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find(
    (s) => s.querySelector(".section-title")?.textContent?.trim() === "Light",
  );
  const title = section.querySelector(".section-title-hit");
  const chevron = section.querySelector(".section-collapse");
  const read = (el) => {
    const style = getComputedStyle(el);
    return {
      background: style.backgroundColor,
      borderTop: style.borderTopWidth,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      textTransform: style.textTransform,
      cursor: style.cursor,
    };
  };
  return { title: read(title), chevron: read(chevron), header: read(section.querySelector(".section-header")) };
});
const transparent = (colour) => colour === "rgba(0, 0, 0, 0)" || colour === "transparent";
check(
  "the title button inherits the header's type instead of the browser's",
  transparent(headerStyle.title.background) &&
    headerStyle.title.borderTop === "0px" &&
    headerStyle.title.fontSize === headerStyle.header.fontSize &&
    headerStyle.title.fontWeight === headerStyle.header.fontWeight &&
    headerStyle.title.textTransform === headerStyle.header.textTransform &&
    headerStyle.title.cursor === "pointer",
  JSON.stringify(headerStyle.title),
);
check(
  "the chevron button is a bare affordance, not a chip",
  transparent(headerStyle.chevron.background) && headerStyle.chevron.borderTop === "0px",
  JSON.stringify(headerStyle.chevron),
);

// The chevron has to actually TURN, or a folded section reads as an empty one.
const chevronAngle = () =>
  page.evaluate(() => {
    const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find(
      (s) => s.querySelector(".section-title")?.textContent?.trim() === "Light",
    );
    return getComputedStyle(section.querySelector(".section-chevron")).transform;
  });
const openAngle = await chevronAngle();

// --- folding through the chevron --------------------------------------------

await clickChevron("Light");
await wait(400);
const folded = await sectionNamed("Light");
check(
  "clicking the chevron folds the section away, header and all its fields",
  folded?.collapsed === true && folded.fields === 0,
  JSON.stringify(folded),
);
check(
  "the Transform section beside it is untouched",
  (await sectionNamed("Transform"))?.fields > 0,
  JSON.stringify(await sectionNamed("Transform")),
);
const foldedAngle = await chevronAngle();
check(
  "the chevron turns between the two states",
  openAngle !== foldedAngle && foldedAngle !== "none",
  `open=${openAngle} folded=${foldedAngle}`,
);

check(
  "the fold is persisted, and only as `true`",
  JSON.stringify(await storedCollapsed()) === JSON.stringify({ light: true }),
  JSON.stringify(await storedCollapsed()),
);

// --- the type key ------------------------------------------------------------

await select("fold-lamp-b");
await wait(600);
const otherLamp = await sectionNamed("Light");
check(
  "the NEXT entity's Light section is already folded — the state is keyed by type",
  otherLamp?.collapsed === true && otherLamp.fields === 0,
  JSON.stringify(otherLamp),
);

// --- the title is the second hit target --------------------------------------

await clickTitle("Light");
await wait(400);
const reopened = await sectionNamed("Light");
check(
  "clicking the title unfolds it too — the whole header is clickable",
  reopened?.collapsed === false && reopened.fields > 0,
  JSON.stringify(reopened),
);
check(
  "unfolding removes the key rather than writing `false`",
  JSON.stringify(await storedCollapsed()) === JSON.stringify({}),
  JSON.stringify(await storedCollapsed()),
);

// --- Collapse All / Expand All from the section context menu -----------------

const openSectionMenu = async (title) => {
  const box = await page.evaluate((wanted) => {
    const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find(
      (s) => s.querySelector(".section-title")?.textContent?.trim() === wanted,
    );
    if (!section) return null;
    const rect = section.querySelector(".section-header").getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, title);
  if (!box) return false;
  await page.mouse.click(box.x, box.y, { button: "right" });
  await wait(300);
  return true;
};
const clickMenuItem = (label) =>
  page.evaluate((wanted) => {
    const item = [...document.querySelectorAll(".context-menu .dropdown-item")].find(
      (b) => b.textContent?.trim() === wanted,
    );
    item?.click();
    return !!item;
  }, label);

await openSectionMenu("Light");
const collapsedAll = await clickMenuItem("Collapse All Sections");
await wait(400);
const afterCollapseAll = (await sections()).filter((s) => s.hasChevron);
check(
  "Collapse All Sections folds every foldable section the entity is showing",
  collapsedAll && afterCollapseAll.length >= 2 && afterCollapseAll.every((s) => s.collapsed && s.fields === 0),
  JSON.stringify(afterCollapseAll.map((s) => `${s.title}:${s.collapsed}`)),
);
check(
  "Collapse All wrote the transform row too, not just the components",
  JSON.stringify(await storedCollapsed()) === JSON.stringify({ transform: true, light: true }),
  JSON.stringify(await storedCollapsed()),
);

await openSectionMenu("Light");
const expandedAll = await clickMenuItem("Expand All Sections");
await wait(400);
const afterExpandAll = (await sections()).filter((s) => s.hasChevron);
check(
  "Expand All Sections is the exact round trip",
  expandedAll && afterExpandAll.every((s) => !s.collapsed) && afterExpandAll.some((s) => s.fields > 0),
  JSON.stringify(afterExpandAll.map((s) => `${s.title}:${s.collapsed}`)),
);

// ---------------------------------------------------------------------------
// Session 2 — a reload paints the fold, it does not animate into it
// ---------------------------------------------------------------------------

await clickChevron("Light");
await wait(400);
check(
  "one section is folded going into the reload",
  JSON.stringify(await storedCollapsed()) === JSON.stringify({ light: true }),
  JSON.stringify(await storedCollapsed()),
);

// This one must NOT wipe storage — the fold is what the reload has to recover.
await page.goto(url, { waitUntil: "load", timeout: 45000 });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Skip the project"))?.click();
});

// Watch from BEFORE the inspector has anything to show. The bug being guarded
// against is a frame in which the Light section's fields are present because
// the store had not loaded yet; if that frame ever commits, the observer sees it.
await page.evaluate(() => {
  globalThis.__inspectorFrames = [];
  const record = () => {
    for (const section of document.querySelectorAll(".inspector-panel .inspector-section")) {
      if (section.querySelector(".section-title")?.textContent?.trim() !== "Light") continue;
      globalThis.__inspectorFrames.push({
        collapsed: section.classList.contains("collapsed"),
        fields: section.querySelectorAll(".field-row").length,
      });
    }
  };
  new MutationObserver(record).observe(document.body, { childList: true, subtree: true });
});
await wait(6000);

const rebuilt = await page.evaluate(`(async () => {${BUILD_SCENE}})()`);
await select("fold-lamp-a");
await wait(1200);
check("the scene was rebuilt for the second session", rebuilt === 2, `${rebuilt} entities`);

const restored = await sectionNamed("Light");
check(
  "the fold came back after the reload",
  restored?.collapsed === true && restored.fields === 0,
  JSON.stringify(restored),
);

const frames = await page.evaluate(() => globalThis.__inspectorFrames ?? []);
const flashed = frames.filter((f) => f.fields > 0);
check(
  "no frame ever showed the folded section open — it is folded before the first paint",
  frames.length > 0 && flashed.length === 0,
  flashed.length ? `${flashed.length} flashed frame(s) of ${frames.length}` : `${frames.length} frames observed`,
);

// A folded section must not keep reserving the 180px the panel's
// content-visibility guess gives an unfolded one, or the scrollbar describes a
// document several times taller than the one on screen.
const foldedHeight = await page.evaluate(() => {
  const section = [...document.querySelectorAll(".inspector-panel .inspector-section")].find(
    (s) => s.querySelector(".section-title")?.textContent?.trim() === "Light",
  );
  return section.getBoundingClientRect().height;
});
check(
  "a folded section is one row tall, not a 180px placeholder",
  foldedHeight > 0 && foldedHeight < 60,
  `${Math.round(foldedHeight)}px`,
);

// ---------------------------------------------------------------------------

await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

const passed = results.filter((r) => r.ok).length;
const realErrors = errors.filter((e) => !/save_scene|Failed to load resource|GPU/i.test(e));
if (realErrors.length) {
  console.log(`\n${realErrors.length} console error(s):`);
  for (const e of realErrors.slice(0, 8)) console.log(`  ${e.slice(0, 300)}`);
}
console.log(
  `\n${passed === results.length && !realErrors.length ? "INSPECTOR-COLLAPSE PASS" : "INSPECTOR-COLLAPSE FAIL"} — ` +
    `${passed}/${results.length} checks, ${realErrors.length} console errors`,
);
await browser.close();
process.exit(passed === results.length && !realErrors.length ? 0 : 1);
