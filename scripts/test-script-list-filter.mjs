// Mirrors the filtering in src/editor/assetLoader.js so we can verify the
// rules in plain Node without spinning up Tauri.

const isDeclarationFile = (name) => /\.d\.(?:c|m)?ts$/i.test(name);
const isEngineTypesPath = (path) => /[\\/]engine-types(?:[\\/]|$)/i.test(path);

// Fake entries — same shape the Rust `list_dir` returns.
const allEntries = [
  { name: "Player.ts",           ext: "ts", is_dir: false, path: "/proj/Player.ts" },
  { name: "Enemy.js",            ext: "js", is_dir: false, path: "/proj/Enemy.js" },
  { name: "engine.d.ts",         ext: "ts", is_dir: false, path: "/proj/engine-types/engine.d.ts" },
  { name: "three.d.ts",          ext: "ts", is_dir: false, path: "/proj/engine-types/three.d.ts" },
  { name: "engine-types",        ext: "",   is_dir: true,  path: "/proj/engine-types" },
  { name: "nested.d.mts",        ext: "ts", is_dir: false, path: "/proj/lib/nested.d.mts" },
  { name: "old.d.cts",           ext: "ts", is_dir: false, path: "/proj/legacy/old.d.cts" },
  { name: "PlayerController.js", ext: "js", is_dir: false, path: "/proj/examples/PlayerController.js" },
  { name: "texture.png",         ext: "png",is_dir: false, path: "/proj/texture.png" },
  { name: "model.glb",           ext: "glb",is_dir: false, path: "/proj/model.glb" },
];

const wantExts = ["js", "ts"];

function pickScripts(entries, exts) {
  return entries
    .filter((e) => !e.is_dir)
    .filter((e) => exts.includes(e.ext))
    .filter((e) => !isDeclarationFile(e.name))
    .filter((e) => !isEngineTypesPath(e.path))
    .map((e) => e.path);
}

const result = pickScripts(allEntries, wantExts);
const expected = [
  "/proj/Player.ts",
  "/proj/Enemy.js",
  "/proj/examples/PlayerController.js",
];

console.assert(result.length === expected.length, `expected ${expected.length} scripts, got ${result.length}`);
for (const p of expected) {
  console.assert(result.includes(p), `missing: ${p}`);
}
const forbidden = [
  "/proj/engine-types/engine.d.ts",
  "/proj/engine-types/three.d.ts",
  "/proj/lib/nested.d.mts",
  "/proj/legacy/old.d.cts",
];
for (const p of forbidden) {
  console.assert(!result.includes(p), `should not include declaration: ${p}`);
}

console.log("OK — script picker filter:");
for (const p of result) console.log("  ", p);