import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SORT, SORT_KEY, nextSort, readSort, sortEntries, writeSort } from "../src/editor/assetSort.js";

const dir = (name, modified = 0) => ({ name, is_dir: true, ext: "", size: 0, modified });
const file = (name, ext, size, modified) => ({ name, is_dir: false, ext, size, modified });

const entries = [
  file("b.png", "png", 300, 3000),
  dir("zeta", 100),
  file("Mesh_10.glb", "glb", 50, 1000),
  file("a.mat", "mat", 10, 2000),
  dir("alpha", 200),
  file("Mesh_2.glb", "glb", 500, 4000),
];
const names = (list) => list.map((e) => e.name);
const typeOf = (e) => ({ png: "Image", glb: "Model", mat: "Material" })[e.ext] ?? e.ext;

test("folders first, then names — numeric and case-insensitive", () => {
  assert.deepEqual(names(sortEntries(entries, DEFAULT_SORT, typeOf)), [
    "alpha",
    "zeta",
    "a.mat",
    "b.png",
    "Mesh_2.glb",
    "Mesh_10.glb",
  ]);
});

test("descending flips the files and the folders, folders still first", () => {
  assert.deepEqual(names(sortEntries(entries, { by: "name", dir: -1 }, typeOf)), [
    "zeta",
    "alpha",
    "Mesh_10.glb",
    "Mesh_2.glb",
    "b.png",
    "a.mat",
  ]);
});

test("type sorts by the shown label and breaks ties by name", () => {
  const sorted = sortEntries(entries, { by: "type", dir: 1 }, typeOf).filter((e) => !e.is_dir);
  assert.deepEqual(names(sorted), ["b.png", "a.mat", "Mesh_2.glb", "Mesh_10.glb"]);
});

test("size and modified sort numerically; strings parse as dates", () => {
  const bySize = sortEntries(entries, { by: "size", dir: 1 }, typeOf).filter((e) => !e.is_dir);
  assert.deepEqual(names(bySize), ["a.mat", "Mesh_10.glb", "b.png", "Mesh_2.glb"]);
  const newest = sortEntries(entries, { by: "modified", dir: -1 }, typeOf).filter((e) => !e.is_dir);
  assert.deepEqual(names(newest), ["Mesh_2.glb", "b.png", "a.mat", "Mesh_10.glb"]);
  const iso = [file("old", "x", 0, "2020-01-01T00:00:00Z"), file("new", "x", 0, "2026-01-01T00:00:00Z")];
  assert.deepEqual(names(sortEntries(iso, { by: "modified", dir: -1 })), ["new", "old"]);
});

test("folders sort by their measured size when a sizeOf is given", () => {
  const measured = { alpha: 5000, zeta: 20 };
  const sizeOf = (e) => (e.is_dir ? measured[e.name] : e.size);
  const asc = sortEntries(entries, { by: "size", dir: 1 }, typeOf, sizeOf);
  assert.deepEqual(names(asc).slice(0, 2), ["zeta", "alpha"]);
  const desc = sortEntries(entries, { by: "size", dir: -1 }, typeOf, sizeOf);
  assert.deepEqual(names(desc).slice(0, 2), ["alpha", "zeta"]);
  // An unmeasured folder counts as empty and keeps its place by name.
  const partial = sortEntries(entries, { by: "size", dir: 1 }, typeOf, (e) => (e.is_dir ? undefined : e.size));
  assert.deepEqual(names(partial).slice(0, 2), ["alpha", "zeta"]);
});

test("the input list is not mutated and short lists pass through", () => {
  const copy = [...entries];
  sortEntries(entries, { by: "size", dir: -1 }, typeOf);
  assert.deepEqual(entries, copy);
  const one = [file("only", "x", 1, 1)];
  assert.equal(sortEntries(one, DEFAULT_SORT), one);
});

test("nextSort flips the same column, starts a new one ascending, dates newest first", () => {
  assert.deepEqual(nextSort({ by: "name", dir: 1 }, "name"), { by: "name", dir: -1 });
  assert.deepEqual(nextSort({ by: "name", dir: -1 }, "size"), { by: "size", dir: 1 });
  assert.deepEqual(nextSort({ by: "size", dir: 1 }, "modified"), { by: "modified", dir: -1 });
  assert.deepEqual(nextSort({ by: "modified", dir: -1 }, "modified"), { by: "modified", dir: 1 });
  assert.deepEqual(nextSort({ by: "name", dir: 1 }, "bogus"), { by: "name", dir: 1 });
});

test("readSort survives garbage and round-trips through writeSort", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(readSort(storage), DEFAULT_SORT);
  storage.setItem(SORT_KEY, "{not json");
  assert.deepEqual(readSort(storage), DEFAULT_SORT);
  storage.setItem(SORT_KEY, JSON.stringify({ by: "colour", dir: 1 }));
  assert.deepEqual(readSort(storage), DEFAULT_SORT);
  writeSort({ by: "modified", dir: -1 }, storage);
  assert.deepEqual(readSort(storage), { by: "modified", dir: -1 });
  assert.deepEqual(readSort(undefined), DEFAULT_SORT);
});
