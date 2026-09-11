import test from "node:test";
import assert from "node:assert/strict";

import { KEY_CATALOG, chordsOf, formatChord } from "../src/editor/keyCatalog.js";
import { KEY_BINDING_ACTIONS, parseChord } from "../src/editor/keyChords.js";

/**
 * The catalog is a MANIFEST — hand-written rows describing handlers that live
 * in a dozen other files — so the one thing a test can hold is its internal
 * consistency: every rebindable action listed exactly once, every chord
 * spelled in a grammar the matcher can read, and nothing rendered as a blank.
 *
 * The rebindable half is the half that can silently rot: `KEY_BINDING_ACTIONS`
 * is the real registry, and an action added there but not here would be
 * invisible on the page that exists to show it.
 */

const rows = KEY_CATALOG.flatMap((g) => g.items.map((i) => ({ ...i, group: g.id })));

test("every rebindable action appears exactly once", () => {
  const listed = rows.filter((r) => r.action).map((r) => r.action);
  assert.deepEqual([...listed].sort(), Object.keys(KEY_BINDING_ACTIONS).sort());
  assert.equal(new Set(listed).size, listed.length, "an action is listed twice");
});

test("group ids are unique and every group has rows", () => {
  const ids = KEY_CATALOG.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const group of KEY_CATALOG) {
    assert.ok(group.items.length > 0, `${group.id} is empty`);
    assert.ok(group.label, `${group.id} has no label`);
  }
});

test("every fixed row carries a label and at least one chord", () => {
  for (const row of rows) {
    if (row.action) continue;
    assert.ok(row.label, `a row in ${row.group} has no label`);
    const chords = chordsOf(row);
    assert.ok(chords.length > 0, `${row.label} has no keys`);
    for (const chord of chords) {
      assert.equal(typeof chord, "string", `${row.label} has a non-string chord`);
      assert.ok(chord.trim(), `${row.label} has a blank chord`);
    }
  }
});

test("modifier chords parse the way the matcher reads them", () => {
  // Only chords that name a modifier: the catalog also lists ranges a person
  // reads ("1–8", "0–9"), which are documentation, not matchable chords.
  for (const row of rows) {
    for (const chord of row.action ? [KEY_BINDING_ACTIONS[row.action].default] : chordsOf(row)) {
      if (!/^(Ctrl|Shift|Alt|Meta|Cmd)\+/i.test(chord)) continue;
      const parsed = parseChord(chord);
      assert.ok(parsed, `${chord} does not parse`);
      assert.ok(parsed.key, `${chord} parses to no key`);
      assert.ok(parsed.ctrl || parsed.shift || parsed.alt || parsed.meta, `${chord} lost its modifier`);
    }
  }
});

test("formatChord never renders a chord as empty or as a lone separator", () => {
  for (const row of rows) {
    for (const chord of row.action ? [KEY_BINDING_ACTIONS[row.action].default] : chordsOf(row)) {
      const text = formatChord(chord);
      assert.ok(text.trim(), `${chord} formats to nothing`);
      assert.notEqual(text, "+");
    }
  }
});

test("a chord that IS a plus survives formatting", () => {
  // "Ctrl++" splits to ["Ctrl", "", ""] on a naive split; the empty tail is
  // the key, not padding.
  assert.equal(formatChord("Ctrl++"), "Ctrl++");
  assert.equal(formatChord("Ctrl+="), "Ctrl+=");
  assert.equal(formatChord(""), "Unbound");
});

test("multi-word key names keep their capitals", () => {
  // `normalizeChord` would return "Arrowup"/"Numpad1" — display must not go
  // through it.
  assert.equal(formatChord("ArrowUp"), "ArrowUp");
  assert.equal(formatChord("Shift+ArrowDown"), "Shift+ArrowDown");
  assert.equal(formatChord("Numpad1"), "Numpad1");
});
