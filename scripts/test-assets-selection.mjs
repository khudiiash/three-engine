// Exercises the Assets-panel selection rules (click / shift-range / ctrl-toggle
// / box select) against the real selection store, without a DOM.
import assert from "node:assert/strict";
import { useSelectionStore } from "../src/editor/store/selectionStore.js";
import { clickSelect, pathsInBox, rectsOverlap } from "../src/editor/assetSelection.js";

const visible = ["a.png", "b.png", "c.png", "d.png", "e.png"].map((name) => ({
  name,
  path: `/proj/${name}`,
  ext: "png",
  is_dir: false,
}));
const at = (i) => visible[i];
const paths = () => useSelectionStore.getState().assetPaths;
const primary = () => useSelectionStore.getState().assetPath;

const CLICK = {};
const SHIFT = { shiftKey: true };
const CTRL = { ctrlKey: true };

useSelectionStore.getState().clear();

// Plain click selects exactly one and makes it the inspected asset.
clickSelect(CLICK, at(1), visible);
assert.deepEqual(paths(), ["/proj/b.png"]);
assert.equal(primary(), "/proj/b.png");

// Shift-click extends a contiguous range from the anchor.
clickSelect(SHIFT, at(3), visible);
assert.deepEqual(paths(), ["/proj/b.png", "/proj/c.png", "/proj/d.png"]);
assert.equal(primary(), "/proj/d.png", "the shift-clicked tile is the inspected one");

// The anchor doesn't move, so a second shift-click re-ranges from b — it
// shrinks the range rather than chaining off d.
clickSelect(SHIFT, at(2), visible);
assert.deepEqual(paths(), ["/proj/b.png", "/proj/c.png"]);

// Shift-click backwards past the anchor still yields a forward-ordered range.
clickSelect(SHIFT, at(0), visible);
assert.deepEqual(paths(), ["/proj/a.png", "/proj/b.png"]);

// Ctrl-click adds without disturbing the rest, and a second one removes it.
clickSelect(CTRL, at(4), visible);
assert.deepEqual(paths(), ["/proj/a.png", "/proj/b.png", "/proj/e.png"]);
clickSelect(CTRL, at(4), visible);
assert.deepEqual(paths(), ["/proj/a.png", "/proj/b.png"]);
assert.equal(primary(), "/proj/b.png", "deselecting the primary falls back to another selected asset");

// Selecting an asset clears the entity selection and vice versa — the
// inspector shows one or the other, never both.
useSelectionStore.getState().select(["entity-1"]);
assert.deepEqual(paths(), []);
assert.equal(primary(), null);
clickSelect(CLICK, at(0), visible);
assert.deepEqual(useSelectionStore.getState().ids, []);

// Box select: rows laid out vertically, marquee crosses the middle two.
const rects = visible.map((e, i) => [
  e.path,
  { left: 0, right: 100, top: i * 30, bottom: i * 30 + 26 },
]);
assert.deepEqual(pathsInBox({ left: 10, right: 60, top: 35, bottom: 95 }, rects), [
  "/proj/b.png",
  "/proj/c.png",
  "/proj/d.png",
]);
// A marquee inside the gap between two rows touches nothing.
assert.deepEqual(pathsInBox({ left: 10, right: 60, top: 27, bottom: 29 }, rects), []);
// Edge contact alone isn't an overlap (a 0-area marquee selects nothing).
assert.equal(rectsOverlap({ left: 0, right: 0, top: 0, bottom: 0 }, rects[0][1]), false);

console.log("assets selection: all checks passed");
