import test from "node:test";
import assert from "node:assert/strict";

/**
 * Which inspector sections stay folded (src/editor/inspectorPrefs.js).
 *
 * The store loads its initial state from localStorage AT IMPORT TIME — that is
 * the whole reason the fold survives a reload without a first paint that flashes
 * every section open — so the storage stub is installed before the import.
 * zustand and the singleton helper are real, so these tests drive the genuine
 * store rather than a mock of it.
 *
 * `useComponentCollapsed` is a React hook and is not exercised here; the
 * per-section render is what run-inspector-collapse-smoke.mjs is for.
 */

class MemoryStorage {
  /** @type {Map<string, string>} */
  #items = new Map();
  getItem(key) { return this.#items.has(String(key)) ? this.#items.get(String(key)) : null; }
  setItem(key, value) { this.#items.set(String(key), String(value)); }
  removeItem(key) { this.#items.delete(String(key)); }
  clear() { this.#items.clear(); }
  get length() { return this.#items.size; }
  key(index) { return [...this.#items.keys()][index] ?? null; }
}

globalThis.localStorage = new MemoryStorage();

const prefs = await import("../src/editor/inspectorPrefs.js");
const {
  INSPECTOR_COLLAPSED_KEY,
  INSPECTOR_MODULE_GROUPS_KEY,
  useInspectorCollapse,
  toggleTypeCollapsed,
  setTypesCollapsed,
  toggleModuleGroupCollapsed,
} = prefs;

const collapsed = () => useInspectorCollapse.getState().collapsed;
const stored = () => JSON.parse(globalThis.localStorage.getItem(INSPECTOR_COLLAPSED_KEY));
const moduleGroups = () => useInspectorCollapse.getState().moduleGroups;
const moduleGroupsStored = () => JSON.parse(globalThis.localStorage.getItem(INSPECTOR_MODULE_GROUPS_KEY));

// vmSingleton hangs the store off a well-known symbol; dropping it and
// re-importing under a new specifier simulates a second copy of the module
// (Vite's `?t=` HMR URLs, or a genuine reload).
const STORE_SYMBOL = Symbol.for("three-engine.inspectorCollapseStore");
const freshImport = (tag) => {
  delete globalThis[STORE_SYMBOL];
  return import(`../src/editor/inspectorPrefs.js?${tag}`);
};

test.beforeEach(() => {
  globalThis.localStorage.clear();
  useInspectorCollapse.setState({ collapsed: {}, moduleGroups: {} });
});

test("toggling a type folds it, and toggling again unfolds it", () => {
  toggleTypeCollapsed("light");
  assert.deepEqual(collapsed(), { light: true });
  toggleTypeCollapsed("light");
  assert.deepEqual(collapsed(), {}, "an unfolded type is ABSENT, never `false`");
});

test("the fold is keyed by component type, not by entity", () => {
  // There is no entity id anywhere in the API — that is the guarantee. Folding
  // "light" once has to hold for the next light the user selects.
  toggleTypeCollapsed("light");
  toggleTypeCollapsed("transform");
  assert.deepEqual(collapsed(), { light: true, transform: true });
});

test("every write persists, and only `true` is ever written", () => {
  toggleTypeCollapsed("mesh");
  assert.deepEqual(stored(), { version: 1, collapsed: { mesh: true } });
  toggleTypeCollapsed("mesh");
  assert.deepEqual(stored(), { version: 1, collapsed: {} }, "the unfold has to survive a restart too");
});

test("setTypesCollapsed folds and unfolds a whole list at once", () => {
  const types = ["transform", "mesh", "light"];
  setTypesCollapsed(types, true);
  assert.deepEqual(collapsed(), { transform: true, mesh: true, light: true });
  // Collapse All then Expand All is a round trip, and it leaves nothing behind.
  setTypesCollapsed(types, false);
  assert.deepEqual(collapsed(), {});
  assert.deepEqual(stored(), { version: 1, collapsed: {} });
});

test("setTypesCollapsed leaves types outside the list alone", () => {
  toggleTypeCollapsed("camera");
  setTypesCollapsed(["mesh"], true);
  assert.deepEqual(collapsed(), { camera: true, mesh: true });
  // "Expand All" on one entity must not unfold a type that entity does not have.
  setTypesCollapsed(["mesh"], false);
  assert.deepEqual(collapsed(), { camera: true });
});

test("setTypesCollapsed with an empty list is a no-op that still persists", () => {
  toggleTypeCollapsed("light");
  setTypesCollapsed([], false);
  assert.deepEqual(collapsed(), { light: true });
  assert.deepEqual(stored(), { version: 1, collapsed: { light: true } });
});

test("a fresh module recovers the folds from storage before its first render", async () => {
  toggleTypeCollapsed("light");
  toggleTypeCollapsed("mesh");
  const revived = await freshImport("reload");
  assert.notEqual(revived.useInspectorCollapse, useInspectorCollapse);
  assert.deepEqual(revived.useInspectorCollapse.getState().collapsed, { light: true, mesh: true });
});

test("a second copy of the module reuses the same store (vmSingleton)", async () => {
  toggleTypeCollapsed("light");
  const same = await import("../src/editor/inspectorPrefs.js");
  assert.equal(same.useInspectorCollapse, useInspectorCollapse, "two stores would be two truths about what is open");
  assert.deepEqual(same.useInspectorCollapse.getState().collapsed, { light: true });
});

test("corrupt or hostile persisted state reads as everything expanded", async () => {
  globalThis.localStorage.setItem(INSPECTOR_COLLAPSED_KEY, "{not json at all");
  let revived = await freshImport("corrupt");
  assert.deepEqual(revived.useInspectorCollapse.getState().collapsed, {});

  globalThis.localStorage.setItem(INSPECTOR_COLLAPSED_KEY, "42");
  revived = await freshImport("non-object");
  assert.deepEqual(revived.useInspectorCollapse.getState().collapsed, {});

  globalThis.localStorage.setItem(INSPECTOR_COLLAPSED_KEY, JSON.stringify({ version: 1, collapsed: null }));
  revived = await freshImport("null-collapsed");
  assert.deepEqual(revived.useInspectorCollapse.getState().collapsed, {});

  // Anything that is not exactly `true` is not a fold this module wrote.
  globalThis.localStorage.setItem(
    INSPECTOR_COLLAPSED_KEY,
    JSON.stringify({ version: 1, collapsed: { light: true, mesh: false, camera: "yes", rigidbody: 1 } }),
  );
  revived = await freshImport("junk-values");
  assert.deepEqual(revived.useInspectorCollapse.getState().collapsed, { light: true });
});

test("a storage that throws does not stop the fold from happening", async () => {
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error("private mode"); },
    setItem() { throw new Error("quota exceeded"); },
    removeItem() {},
  };
  try {
    const revived = await freshImport("throwing-storage");
    assert.deepEqual(revived.useInspectorCollapse.getState().collapsed, {});
    revived.toggleTypeCollapsed("light");
    assert.deepEqual(
      revived.useInspectorCollapse.getState().collapsed,
      { light: true },
      "the fold applies to this session even when it cannot be saved",
    );
  } finally {
    globalThis.localStorage = real;
  }
});

// ── Module groups (ModuleFieldsGroup in InspectorPanel.jsx) ──────────────────

test("module groups fold and unfold like types, but live in their own map", () => {
  toggleModuleGroupCollapsed("physics-rapier");
  assert.deepEqual(moduleGroups(), { "physics-rapier": true });
  assert.deepEqual(collapsed(), {}, "a module fold must never leak into the component-type folds");
  toggleModuleGroupCollapsed("physics-rapier");
  assert.deepEqual(moduleGroups(), {});
});

test("module group folds persist under their own key, not the v1 payload", () => {
  toggleTypeCollapsed("mesh");
  toggleModuleGroupCollapsed("gi");
  assert.deepEqual(stored(), { version: 1, collapsed: { mesh: true } });
  assert.deepEqual(moduleGroupsStored(), { version: 1, moduleGroups: { gi: true } });
});

test("a module group fold is keyed by MODULE, so it holds across components", () => {
  // "Physics" appears on meshes, models and virtual cameras; one fold covers
  // them all — the same papercut rule as the per-type component folds.
  toggleModuleGroupCollapsed("physics-rapier");
  assert.deepEqual(moduleGroups(), { "physics-rapier": true });
});

test("module groups survive a reload, and junk values read as expanded", async () => {
  toggleModuleGroupCollapsed("gi");
  const revived = await freshImport("module-groups-reload");
  assert.deepEqual(revived.useInspectorCollapse.getState().moduleGroups, { gi: true });

  globalThis.localStorage.setItem(INSPECTOR_MODULE_GROUPS_KEY, JSON.stringify({ version: 1, moduleGroups: { gi: true, "physics-rapier": "yes" } }));
  const junk = await freshImport("module-groups-junk");
  assert.deepEqual(junk.useInspectorCollapse.getState().moduleGroups, { gi: true }, "only an exact `true` is a fold this module wrote");

  globalThis.localStorage.setItem(INSPECTOR_MODULE_GROUPS_KEY, "{broken");
  const broken = await freshImport("module-groups-broken");
  assert.deepEqual(broken.useInspectorCollapse.getState().moduleGroups, {}, "a broken payload costs only the module-group folds");
});
