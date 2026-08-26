import test from "node:test";
import assert from "node:assert/strict";

import { extOf, lfsPointerMessage, lfsPointerSize } from "../src/editor/assetLoader.js";

/**
 * `extOf` is the editor's answer to "what kind of thing is this path", and
 * nearly every asset-facing surface asks it: which preview the Inspector
 * renders, which actions the context menu offers, which extension a rename puts
 * back on the end.
 *
 * It used to be `path.split(".").pop()`, which returns the WHOLE STRING when
 * there is no dot — so an extension-less path reported its own full path as its
 * extension. Every folder is extension-less. The Asset Inspector's Name field
 * then asked the filesystem to rename `New Folder` to
 * `MyFolder.c:/users/…/new folder`, which it refused, and the refusal only ever
 * reached the console: renaming a folder from the Inspector simply did nothing.
 *
 * These are the cases that distinguish the two implementations.
 */

test("a folder has no extension", () => {
  assert.equal(extOf("C:/Users/K/GAME/New Folder"), "");
  assert.equal(extOf("C:\\Users\\K\\GAME\\New Folder"), "");
  assert.equal(extOf("/home/k/game/Character"), "");
});

test("a dot in a DIRECTORY name is not the file's extension", () => {
  // The old implementation returned "game/scripts/rotator" here.
  assert.equal(extOf("C:/My.Game/scripts/Rotator"), "");
  assert.equal(extOf("C:/My.Game/scripts/Rotator.ts"), "ts");
});

test("real extensions still resolve, lowercased", () => {
  assert.equal(extOf("C:/a/b.GLB"), "glb");
  assert.equal(extOf("C:\\a\\b.glb"), "glb");
  assert.equal(extOf("Rotator.ts"), "ts");
});

test("a sidecar's own suffix wins, not the asset's", () => {
  assert.equal(extOf("C:/a/wood.png.meta"), "meta");
  assert.equal(extOf("C:/a/wood.png.basis"), "basis");
});

test("a leading dot is a name, not an extension", () => {
  assert.equal(extOf(".gitignore"), "");
  assert.equal(extOf("C:/project/.gitignore"), "");
});

test("nothing in, empty string out — never a crash", () => {
  assert.equal(extOf(null), "");
  assert.equal(extOf(undefined), "");
  assert.equal(extOf(""), "");
});

/**
 * The arithmetic both rename entry points do — the Assets panel's inline
 * rename (`assetOps.renameEntry`) and the Inspector's Name field
 * (`AssetInspector.renameAsset`). Reproduced rather than imported because both
 * modules pull in React and Tauri; what is under test is the shape of the path
 * they build, which is where the bug was.
 */
const fileName = (p) => p?.split(/[\\/]/).pop() ?? "";
const stemOf = (name) => name.replace(/\.[^.]+$/, "");

function renamedPath(path, newName, isDir) {
  const ext = isDir ? "" : extOf(path);
  const oldName = fileName(path);
  const dir = path.slice(0, path.length - oldName.length);
  return `${dir}${newName}${ext ? `.${ext}` : ""}`;
}

test("renaming a folder does not glue an extension onto it", () => {
  assert.equal(
    renamedPath("C:/Users/K/GAME/New Folder", "Enemies", true),
    "C:/Users/K/GAME/Enemies",
  );
});

test("renaming a file keeps its extension", () => {
  assert.equal(
    renamedPath("C:/Users/K/GAME/scripts/Rotator.ts", "Spinner", false),
    "C:/Users/K/GAME/scripts/Spinner.ts",
  );
});

test("a folder's editable name is the WHOLE name, not a stem", () => {
  // "Sky.HDRIs" is a legal folder name. Shown through the file path it would
  // appear in the Name field as "Sky", and committing it would silently rename
  // the folder.
  const path = "C:/Users/K/GAME/Sky.HDRIs";
  assert.equal(fileName(path), "Sky.HDRIs");
  assert.equal(stemOf(fileName(path)), "Sky"); // what the file field would show
  assert.equal(renamedPath(path, "Sky.HDRIs", true), path); // folder field: a no-op
});

/**
 * Git LFS pointer detection.
 *
 * A repo template the editor itself writes puts `*.glb` and `*.fbx` in LFS, so
 * unexpanded pointers arrive through the front door. Every one is ~130 bytes of
 * ASCII that fails a model parser's header check, and the resulting "no FBX
 * header/version found" blames the exporter for a file that was never fetched.
 * These assertions pin the shape the detector keys on.
 */

const pointer = (size) =>
  `version https://git-lfs.github.com/spec/v1\n` +
  `oid sha256:55b7740048b502e63278e1af3369733de365c59362dbbe9c10cdee73c6dcc2ca\n` +
  `size ${size}\n`;

const bytesOf = (text) => new TextEncoder().encode(text);

test("an LFS pointer reports the size of the file that is missing", () => {
  assert.equal(lfsPointerSize(bytesOf(pointer(111248))), 111248);
  // The exact stub that failed to import: 131 bytes standing in for 108 KB.
  assert.equal(bytesOf(pointer(111248)).byteLength, 131);
});

test("a pointer is detected as ArrayBuffer, view, or string alike", () => {
  const view = bytesOf(pointer(4096));
  assert.equal(lfsPointerSize(view), 4096);
  assert.equal(lfsPointerSize(view.buffer), 4096);
  assert.equal(lfsPointerSize(pointer(4096)), 4096);
});

test("a real model is not mistaken for a pointer", () => {
  // Binary FBX: the exact 27-byte magic three's FBXLoader checks for.
  const fbx = bytesOf("Kaydara FBX Binary  \0\u001a\0\u00e4\u001d\0\0");
  assert.equal(lfsPointerSize(fbx), null);
  // GLB: "glTF" magic, version 2.
  assert.equal(lfsPointerSize(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])), null);
  // ASCII FBX carries no magic at all — still not a pointer.
  assert.equal(lfsPointerSize(bytesOf("; FBX 7.4.0 project file\nFBXVersion: 7400\n")), null);
  assert.equal(lfsPointerSize(new Uint8Array(0)), null);
});

test("the message names the fix, not the symptom", () => {
  const msg = lfsPointerMessage("Chainer_Base.fbx", 111248);
  assert.match(msg, /Chainer_Base\.fbx/);
  assert.match(msg, /git lfs pull/);
  assert.match(msg, /109 KB/); // 111248 bytes, stated in units a person reads
  const big = lfsPointerMessage("Level.glb", 52428800);
  assert.match(big, /50\.0 MB/);
});
