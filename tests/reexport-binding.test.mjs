// GATE: a re-export does not bind the name locally.
//
// `export { chordMatches } from "./keyChords.js"` forwards the name to
// importers and binds NOTHING in the exporting module's own scope. Use it in
// that same file and you get a ReferenceError — at runtime, on the code path
// that happens to touch it, with no warning from anything earlier.
//
// This shipped: `src/editor/keybindings.js` re-exported six names from
// `keyChords.js` and used five of them, so the editor threw
// `Uncaught ReferenceError: chordMatches is not defined` out of
// `dispatchVisibilityKeyAction` on EVERY keydown — the entire shortcut system
// dead while the module looked perfectly well-formed. `node --check` passes,
// the module loads, and importers resolve the names fine. Only pressing a key
// finds it, and there is no eslint in this repo to say otherwise.
//
// So the check is static and repo-wide: for every `export { … } from "…"`,
// none of the exported names may appear anywhere else in that same file.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function* jsFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* jsFiles(full);
    else if (/\.(js|jsx|mjs)$/.test(entry)) yield full;
  }
}

/** Source with comments and string literals blanked, so a name in prose or in
 *  an import path never counts as a use. Crude on purpose — it only has to be
 *  conservative in the direction of NOT inventing failures. */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

// ⚠ `[^"']*` NOT `+`: `stripNoise` blanks every string literal, so by the
// time this runs the module path is `""`. With `+` this regex matched
// NOTHING and the gate passed on a file that WAS broken — verified by
// dropping a real offender into src/ and watching it stay green. A check
// that cannot see its subject is worse than no check.
const RE_EXPORT = /export\s*\{([^}]*)\}\s*from\s*["'][^"']*["']\s*;?/g;

test("no file uses a name it only RE-EXPORTS (export { x } from '…' binds nothing locally)", () => {
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    if (!/export\s*\{[^}]*\}\s*from/.test(source)) continue;
    const clean = stripNoise(source);
    // Every name this file also imports normally is genuinely bound.
    const imported = new Set();
    for (const m of clean.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) imported.add(name);
      }
    }
    // …and anything declared in the file is bound too.
    const declared = new Set(
      [...clean.matchAll(/(?:^|\s)(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    );
    const withoutReExports = clean.replace(RE_EXPORT, " ");
    for (const m of clean.matchAll(RE_EXPORT)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (!name || imported.has(name) || declared.has(name)) continue;
        const used = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(withoutReExports);
        if (used) offenders.push(`${path.relative(SRC, file)} uses re-exported "${name}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "These names are re-exported but never imported, so they are undefined in their own module:\n  " +
      offenders.join("\n  "),
  );
});

test("the detector actually catches the shape that shipped", () => {
  // The exact pre-fix keybindings.js shape, reduced.
  const bad = `
    export { chordMatches } from "./keyChords.js";
    function onKeyDown(event, b) {
      if (chordMatches(event, b["editor.toggleSelected"])) return true;
      return false;
    }
  `;
  const clean = stripNoise(bad);
  const withoutReExports = clean.replace(RE_EXPORT, " ");
  assert.equal(/\bchordMatches\b/.test(withoutReExports), true, "detector missed a real offender");

  // …and does not fire when the name is properly imported as well.
  const good = `
    import { chordMatches } from "./keyChords.js";
    export { chordMatches };
    function onKeyDown(event, b) { return chordMatches(event, b.x); }
  `;
  const cleanGood = stripNoise(good);
  const imported = [...cleanGood.matchAll(/import\s*\{([^}]*)\}\s*from/g)]
    .flatMap((m) => m[1].split(",").map((s) => s.trim()));
  assert.ok(imported.includes("chordMatches"), "a plain `export { x }` after an import is fine");
  // `.test()` on a /g regex advances lastIndex, so reset before asking.
  RE_EXPORT.lastIndex = 0;
  assert.equal(RE_EXPORT.test(cleanGood), false, "`export { x }` with no `from` is not a re-export");
  RE_EXPORT.lastIndex = 0;
});
