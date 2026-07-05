// Verify that the Vite-bundled scriptRuntime chunk has the runtime content
// (the math class re-exports) inlined as a data URL, plus Script and attribute.

import fs from "node:fs";
import path from "node:path";

const distDir = "dist/assets";
const files = fs.readdirSync(distDir).filter((f) => f.startsWith("scriptRuntime-") && f.endsWith(".js"));
if (files.length !== 1) throw new Error("expected exactly one scriptRuntime-*.js chunk, found " + files.length);
const runtimeChunk = fs.readFileSync(path.join(distDir, files[0]), "utf-8");

// The chunk now contains the inlined runtime as a data: URL (Vite/Rollup
// transformed `new URL('./scriptRuntime/runtime.js', import.meta.url)` at
// build time into a data:text/javascript;base64,… string). Find the URL
// by regex, decode base64, and look for our exported symbols.

const dataUrl = runtimeChunk.match(/data:text\/javascript;base64,([A-Za-z0-9+/=]+)/);
if (!dataUrl) throw new Error("could not find inlined runtime data URL in scriptRuntime chunk");
const dataBody = Buffer.from(dataUrl[1], "base64").toString("utf-8");

const needed = [
  "Vector2", "Vector3", "Euler", "Quaternion", "Matrix4",
  "Color", "Object3D", "Camera", "MathUtils",
  "export class Script", "export function attribute",
];

let pass = true;
console.log("=== Runtime contents (decoded from data URL in scriptRuntime chunk) ===");
for (const sym of needed) {
  const present = dataBody.includes(sym);
  console.log((present ? "OK  " : "FAIL") + " " + sym);
  if (!present) pass = false;
}

console.log("");
console.log("=== Exports in inlined runtime ===");
const exportMatch = dataBody.match(/export \{ ([^}]+) \}/);
if (exportMatch) {
  const exported = exportMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  console.log("Math class re-exports: " + exported.join(", "));
} else {
  console.log("No re-export block found");
  pass = false;
}

console.log("");
console.log(pass ? "ALL PASS" : "FAIL");
process.exit(pass ? 0 : 1);