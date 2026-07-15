import assert from "node:assert/strict";
import { useSelectionStore } from "../src/editor/store/selectionStore.js";

const selection = () => useSelectionStore.getState();

selection().clear();
selection().select("a");
assert.deepEqual(selection().ids, ["a"]);
assert.equal(selection().anchorId, "a");

selection().toggle("b");
assert.deepEqual(selection().ids, ["a", "b"]);
assert.equal(selection().anchorId, "b");

selection().toggle("a");
assert.deepEqual(selection().ids, ["b"]);

// Range selection supplies its stable anchor explicitly.
selection().select(["b", "c", "d"], "b");
assert.deepEqual(selection().ids, ["b", "c", "d"]);
assert.equal(selection().anchorId, "b");

// Switching between entities and assets is mutually exclusive.
selection().selectAsset("/project/a.png");
assert.deepEqual(selection().ids, []);
assert.deepEqual(selection().assetPaths, ["/project/a.png"]);
selection().select(["c", "d"], "c");
assert.deepEqual(selection().assetPaths, []);
assert.equal(selection().assetPath, null);

// Deleted entities are removed without disturbing surviving selections.
selection().prune(new Set(["d"]));
assert.deepEqual(selection().ids, ["d"]);

console.log("entity selection: all checks passed");
