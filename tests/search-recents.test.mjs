import test from "node:test";
import assert from "node:assert/strict";

/**
 * The shared recent-searches list behind the editor's search boxes (Ctrl+F,
 * Hierarchy, Assets — one list, see src/editor/searchRecents.js).
 *
 * The store loads its initial state from localStorage AT IMPORT TIME, so the
 * stub below is installed before the module is imported; everything else the
 * module needs (zustand, the singleton helper) is real, so these tests drive
 * the genuine store rather than a mock of it.
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

const searchRecents = await import("../src/editor/searchRecents.js");
const { SEARCH_RECENTS_KEY, MAX_SEARCH_RECENTS, useSearchRecents } = searchRecents;

const recents = () => useSearchRecents.getState().recents;
const stored = () => JSON.parse(globalThis.localStorage.getItem(SEARCH_RECENTS_KEY));

// vmSingleton hangs the store off a well-known symbol; dropping it and
// re-importing under a new specifier is how a "second copy of the module"
// (Vite's `?t=` HMR URLs, a fresh test registry) is simulated here.
const STORE_SYMBOL = Symbol.for("three-engine.searchRecents");
const freshImport = (tag) => {
  delete globalThis[STORE_SYMBOL];
  return import(`../src/editor/searchRecents.js?${tag}`);
};

test.beforeEach(() => searchRecents.clearSearchRecents());

test("noteSearch records newest-first and persists", () => {
  searchRecents.noteSearch("Lamp");
  searchRecents.noteSearch("texture?width>1920");
  assert.deepEqual(recents(), ["texture?width>1920", "Lamp"]);
  assert.deepEqual(stored(), ["texture?width>1920", "Lamp"], "the list must survive a restart");
});

test("noteSearch dedupes case-insensitively, keeping the LAST casing, and moves it to the front", () => {
  searchRecents.noteSearch("Lamp");
  searchRecents.noteSearch("shader graph");
  searchRecents.noteSearch("LAMP");
  assert.deepEqual(recents(), ["LAMP", "shader graph"], "re-typing a query promotes it, under the new casing");
  // Running the same search again must not grow the list.
  searchRecents.noteSearch("lamp");
  assert.equal(recents().length, 2);
  assert.deepEqual(recents(), ["lamp", "shader graph"]);
});

test("noteSearch ignores empty and whitespace-only queries", () => {
  searchRecents.noteSearch("Lamp");
  searchRecents.noteSearch("");
  searchRecents.noteSearch("   ");
  searchRecents.noteSearch("\t\n");
  searchRecents.noteSearch(null);
  searchRecents.noteSearch(undefined);
  assert.deepEqual(recents(), ["Lamp"], "an aborted box-clear is not a search");
});

test("noteSearch caps the list, evicting the oldest", () => {
  for (let i = 0; i < MAX_SEARCH_RECENTS + 2; i++) searchRecents.noteSearch(`query ${i}`);
  assert.equal(recents().length, MAX_SEARCH_RECENTS);
  assert.deepEqual(recents(), ["query 9", "query 8", "query 7", "query 6", "query 5", "query 4", "query 3", "query 2"]);
  assert.equal(stored().length, MAX_SEARCH_RECENTS, "the cap holds on disk too");
});

test("noteSearch trims what it stores", () => {
  searchRecents.noteSearch("   Lamp  ");
  assert.deepEqual(recents(), ["Lamp"]);
});

test("removeSearch removes exactly one", () => {
  for (const query of ["a", "b", "c"]) searchRecents.noteSearch(query);
  assert.deepEqual(searchRecents.removeSearch("B"), ["c", "a"], "matching is case-insensitive");
  assert.equal(recents().length, 2);
  assert.deepEqual(stored(), ["c", "a"]);
  // Removing something that is not there changes nothing.
  assert.deepEqual(searchRecents.removeSearch("nope"), ["c", "a"]);
});

test("clearSearchRecents empties the list and persists the empty list", () => {
  searchRecents.noteSearch("a");
  searchRecents.noteSearch("b");
  searchRecents.clearSearchRecents();
  assert.deepEqual(recents(), []);
  assert.deepEqual(stored(), [], "otherwise the old list would come back on restart");
});

test("corrupt persisted JSON is tolerated as an empty list", async () => {
  globalThis.localStorage.setItem(SEARCH_RECENTS_KEY, "{not json at all");
  const revived = await freshImport("corrupt");
  assert.deepEqual(revived.useSearchRecents.getState().recents, []);
});

test("persisted non-arrays and junk entries are tolerated", async () => {
  globalThis.localStorage.setItem(SEARCH_RECENTS_KEY, "42");
  let revived = await freshImport("non-array");
  assert.deepEqual(revived.useSearchRecents.getState().recents, []);

  globalThis.localStorage.setItem(SEARCH_RECENTS_KEY, '{"recents": ["nope"]}');
  revived = await freshImport("object");
  assert.deepEqual(revived.useSearchRecents.getState().recents, []);

  globalThis.localStorage.setItem(SEARCH_RECENTS_KEY, JSON.stringify([1, "keep", null, "   ", "also keep"]));
  revived = await freshImport("junk-entries");
  assert.deepEqual(revived.useSearchRecents.getState().recents, ["keep", "also keep"]);
});

test("a second copy of the module reuses the same list (vmSingleton), and a genuinely fresh one reloads it", async () => {
  searchRecents.noteSearch("solo");
  // Same specifier → the same module instance → the very same store object.
  const same = await import("../src/editor/searchRecents.js");
  assert.equal(same.useSearchRecents, useSearchRecents);
  assert.deepEqual(same.useSearchRecents.getState().recents, ["solo"]);

  // A new module registry (different specifier, dropped symbol) must recover
  // the persisted list, or an HMR update would silently empty the recents.
  const revived = await freshImport("reimport");
  assert.notEqual(revived.useSearchRecents, useSearchRecents);
  assert.deepEqual(revived.useSearchRecents.getState().recents, ["solo"]);
  assert.equal(typeof revived.useSearchRecents.getState().noteSearch, "function");
  assert.equal(typeof revived.useSearchRecents.getState().removeSearch, "function");
  assert.equal(typeof revived.useSearchRecents.getState().clearSearchRecents, "function");
});
