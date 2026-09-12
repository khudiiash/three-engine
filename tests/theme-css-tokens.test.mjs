import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * THE BUG THIS FILE EXISTS FOR (2026-09-11): `theme-v3.css` declared
 *
 *     --fill-2: #111`;
 *
 * with a stray backtick. A custom property accepts almost any token sequence,
 * so the declaration itself parsed — but every `var(--fill-2)` that consumed it
 * became invalid at computed-value time, silently dropping **59 declarations**
 * across the editor. The visible symptom was one missing hairline: the progress
 * track behind the Inspector's five-point quality rails ("there used to be a
 * white line on the progress bar, but it is gone"). Nothing errored, nothing
 * logged, and the rule looked correct in the file.
 *
 * A backtick is never valid CSS, so its presence anywhere in a stylesheet is a
 * typo by definition — cheap to assert, and it catches the whole class.
 */

const CSS_ROOT = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function cssFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (name.endsWith(".css")) out.push(full);
  }
  return out;
}

/**
 * Blanks comment bodies, keeping newlines so line numbers still line up. This
 * codebase quotes code in CSS comments with backticks constantly, so a raw scan
 * would be all false positives — only DECLARATIONS matter here.
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));

test("no CSS declaration contains a backtick (never valid CSS)", () => {
  const offenders = [];
  for (const file of cssFiles(CSS_ROOT)) {
    stripComments(readFileSync(file, "utf8"))
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (line.includes("`")) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(offenders, [], `stray backtick in CSS:\n${offenders.join("\n")}`);
});

test("every custom property the theme defines has a usable value", () => {
  const offenders = [];
  for (const file of cssFiles(CSS_ROOT)) {
    const text = readFileSync(file, "utf8");
    // `--name: value;` declarations, value captured up to the terminating ";".
    for (const match of stripComments(text).matchAll(/(--[\w-]+)\s*:\s*([^;{}]*);/g)) {
      const [, name, rawValue] = match;
      const value = rawValue.trim();
      if (!value) {
        offenders.push(`${file}: ${name} is empty`);
        continue;
      }
      // A hex colour is the shape that broke: anything after the digits means
      // the token is not a colour any consumer can resolve.
      if (/^#/.test(value) && !/^#[0-9a-fA-F]{3,8}$/.test(value)) {
        offenders.push(`${file}: ${name}: ${value}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `malformed custom-property values:\n${offenders.join("\n")}`);
});
