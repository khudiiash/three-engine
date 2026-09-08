import test from "node:test";
import assert from "node:assert/strict";
import { accumulateFolderSizes, folderSizeOf, normalizeFolderPath } from "../src/editor/folderSizes.js";

const root = "C:\\Users\\me\\GAME";
const listing = [
  { path: "C:\\Users\\me\\GAME\\Audio", is_dir: true, size: 0 },
  { path: "C:\\Users\\me\\GAME\\Audio\\hit.ogg", is_dir: false, size: 100 },
  { path: "C:\\Users\\me\\GAME\\Audio\\Freesound", is_dir: true, size: 0 },
  { path: "C:\\Users\\me\\GAME\\Audio\\Freesound\\slice.ogg", is_dir: false, size: 250 },
  { path: "C:\\Users\\me\\GAME\\materials\\Red.mat", is_dir: false, size: 7 },
  { path: "C:\\Users\\me\\GAME\\scene.scene", is_dir: false, size: 1000 },
  { path: "D:\\elsewhere\\stray.bin", is_dir: false, size: 99999 },
];

test("normalizeFolderPath folds separators, trailing slashes and drive-letter case", () => {
  assert.equal(normalizeFolderPath("C:\\Users\\Me\\GAME\\"), "c:/users/me/game");
  assert.equal(normalizeFolderPath("C:/Users/Me/GAME/scenes/"), "c:/users/me/game/scenes");
  assert.equal(normalizeFolderPath("/home/Me/Game/"), "/home/Me/Game");
  assert.equal(normalizeFolderPath("/"), "/");
});

test("every file counts toward each ancestor up to the root", () => {
  const totals = accumulateFolderSizes(listing, root);
  assert.equal(folderSizeOf(totals, "C:/Users/me/GAME/Audio/Freesound"), 250);
  assert.equal(folderSizeOf(totals, "C:\\Users\\me\\GAME\\Audio"), 350);
  assert.equal(folderSizeOf(totals, "C:\\Users\\me\\GAME\\materials"), 7);
  assert.equal(folderSizeOf(totals, root), 1357);
});

test("directories, strays outside the root and unknown folders do not count", () => {
  const totals = accumulateFolderSizes(listing, root);
  assert.equal(folderSizeOf(totals, "D:\\elsewhere"), undefined);
  assert.equal(folderSizeOf(totals, "C:\\Users\\me\\GAME\\Fonts"), undefined);
  assert.equal(folderSizeOf(null, root), undefined);
  assert.equal(folderSizeOf(accumulateFolderSizes([], root), root), 0);
});

test("a mixed-separator root still matches the walker's backslash paths", () => {
  const totals = accumulateFolderSizes(listing, "C:\\Users\\me\\GAME/");
  assert.equal(folderSizeOf(totals, "C:/Users/me/GAME/Audio"), 350);
});
