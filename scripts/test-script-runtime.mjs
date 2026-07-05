// Verify engine module exports and linkEngineImports rewrites.

globalThis.document = { body: null, addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { getRuntimeUrl, linkEngineImports } = await import("../src/engine/scriptRuntime.js");

const url = await getRuntimeUrl();
console.log("Runtime URL: " + url.slice(0, 60) + "...");
console.log("");

let pass = true;

// Test 1: Runtime module loads and exports Script + attribute.
const runtime = await import(url);
console.log("=== Runtime exports ===");
console.log("Script:    " + typeof runtime.Script + (runtime.Script ? " OK" : " MISSING"));
console.log("attribute: " + typeof runtime.attribute + (runtime.attribute ? " OK" : " MISSING"));

if (typeof runtime.Script !== "function") pass = false;
if (typeof runtime.attribute !== "function") pass = false;

// Test 2: New Script() gives a usable instance.
const inst = new runtime.Script();
const instOk = inst instanceof runtime.Script;
if (!instOk) pass = false;
console.log("new Script(): " + (instOk ? "OK" : "FAIL"));

// Test 3: linkEngineImports rewrites "engine" → runtime URL.
const code = [
  'import { Script, attribute, Vector3 } from "engine";',
  'import * as THREE from "engine";',
  'import "engine";',
  "export default class Foo extends Script {",
  '  @attribute({ type: "number", default: 1 })',
  "  speed = 1;",
  "}",
].join("\n");

const rewritten = await linkEngineImports(code);
const stillHasEngine = /from\s*["']engine["']|import\s*["']engine["']/.test(rewritten);
const hasRuntimeUrl = rewritten.includes(url);
if (stillHasEngine) pass = false;
if (!hasRuntimeUrl) pass = false;

console.log("");
console.log("=== linkEngineImports ===");
console.log('"from engine" rewritten:    ' + (!stillHasEngine ? "OK" : "FAIL"));
console.log("References runtime URL:    " + (hasRuntimeUrl ? "OK" : "FAIL"));
const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matches = rewritten.match(new RegExp(escaped, "g"));
console.log("Rewrite count:             " + (matches ? matches.length : 0) + " (expected 3)");

if (!matches || matches.length !== 3) pass = false;

console.log("");
console.log("=== Result ===");
console.log(pass ? "ALL PASS" : "FAIL");

console.log("");
console.log("Note: math class re-exports (Vector2/Vector3/...) only work in Vite-bundled code");
console.log("(editor + player) where the runtime module can import three.js from a real path.");
console.log("Node tests use a fallback blob with just Script + attribute; users import three.js");
console.log("classes directly from three/webgpu in tests, or use the editor/player for full runtime.");

process.exit(pass ? 0 : 1);