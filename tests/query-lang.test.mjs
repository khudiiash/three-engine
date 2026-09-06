import test from "node:test";
import assert from "node:assert/strict";

import {
  parseQuery,
  isPlainQuery,
  isPlainString,
  compareOp,
  coerceValue,
  nameMatches,
} from "../src/editor/queryLang.js";

/**
 * The query language grammar. Every row here is a promise the three search
 * boxes make to the user; when one of them changes meaning, that is a
 * breaking change to what people's fingers already type.
 */

test("plain queries stay plain — legacy behaviour must not move", () => {
  for (const raw of ["rock", "rock cliff", "tag:enemy", "Big Lamp 2", "  spaced  ", "a<b", "wall>"]) {
    const q = parseQuery(raw);
    assert.equal(isPlainQuery(q), true, `"${raw}" should be plain`);
    assert.equal(q.terms.length, raw.trim() ? raw.trim().split(/\s+/).length : 0);
  }
  // A single UNKNOWN word before an operator is a name, not a filter: `a<b`
  // has to stay the substring it always was. Only a dotted path, or one of the
  // fields the evaluators actually expose, is promoted (see the bare-filter
  // test below).
  assert.equal(parseQuery("a<b").terms[0].name.text, "a<b");
});

test("prefix / suffix / contains via ...", () => {
  const prefix = parseQuery("Lamp...?enabled=true").terms[0];
  assert.equal(prefix.name.mode, "prefix");
  assert.equal(prefix.name.text, "Lamp");
  assert.equal(prefix.filters.length, 1);

  const suffix = parseQuery("...Box").terms[0];
  assert.equal(suffix.name.mode, "suffix");
  assert.equal(suffix.name.text, "Box");
  assert.equal(suffix.structured, true);

  const both = parseQuery("...stand...").terms[0];
  assert.equal(both.name.mode, "substring");
  assert.equal(both.structured, true);

  assert.equal(nameMatches("Lamp Post 2", prefix.name), true);
  assert.equal(nameMatches("Floor Lamp", prefix.name), false);
  assert.equal(nameMatches("Jewel Box", suffix.name), true);
  assert.equal(nameMatches("Boxy", suffix.name), false);
  assert.equal(nameMatches("Grand Stand", both.name), true);
});

test("kind words select by type; ...texture is a name, not a kind", () => {
  const kind = parseQuery("texture?width>1920").terms[0];
  assert.equal(kind.name.kind, "texture");
  assert.equal(kind.filters[0].path.join("."), "width");
  assert.equal(kind.filters[0].op, ">");

  const dotted = parseQuery("...texture").terms[0];
  assert.equal(dotted.name.kind, null, "an operator makes the word a name");
  assert.equal(dotted.name.mode, "suffix");

  const quoted = parseQuery('"texture"').terms[0];
  assert.equal(quoted.name.kind, null, "a quoted word is a literal name");
  assert.equal(quoted.name.quoted, true);

  const rock = parseQuery("rock").terms[0];
  assert.equal(rock.name.kind, null);
  assert.equal(rock.structured, false, "ordinary names must not become kinds");
});

test("multi-term queries AND; filters split on &", () => {
  const q = parseQuery('Lamp?enabled=true&collider.shape=convex "red lamp"');
  assert.equal(q.terms.length, 2);
  assert.deepEqual(q.terms[0].filters.map((f) => f.path.join(".")), ["enabled", "collider.shape"]);
  assert.equal(q.terms[0].name.text, "Lamp");
  assert.equal(q.terms[1].name.text, "red lamp");
  assert.equal(q.terms[1].name.quoted, true);
});

test("every comparison operator parses and compares", () => {
  const ops = { "=": "=", "!=": "!=", ">": ">", "<": "<", ">=": ">=", "<=": "<=" };
  for (const [text, op] of Object.entries(ops)) {
    const f = parseQuery(`x?width${text}10`).terms[0].filters[0];
    assert.equal(f.op, op, text);
  }
  assert.equal(compareOp("=", 10, 10), true);
  assert.equal(compareOp(">=", 10.5, 10), true);
  assert.equal(compareOp("<", "9", 10), true, "numeric strings coerce");
  assert.equal(compareOp("!=", "convex", "box"), true);
  assert.equal(compareOp("=", "Convex", "convex"), true, "strings compare case-insensitively");
  assert.equal(compareOp(">", "abc", "b"), false, "no alphabetical ordering");
  assert.equal(compareOp("=", undefined, true), false, "absent matches nothing, even !=");
  assert.equal(compareOp("!=", undefined, true), false);
  assert.equal(compareOp("=", true, true), true);
  assert.equal(compareOp("=", false, true), false);
});

test("values: numbers, booleans, barewords, quoted strings", () => {
  assert.deepEqual(coerceValue("1920"), 1920);
  assert.deepEqual(coerceValue("-3.5"), -3.5);
  assert.deepEqual(coerceValue("true"), true);
  assert.deepEqual(coerceValue("false"), false);
  assert.deepEqual(coerceValue("convex"), "convex");
  const q = parseQuery('mat?name="big rock"&flag=true&mesh!=capsule');
  const [a, b, c] = q.terms[0].filters;
  assert.deepEqual(a.value, "big rock");
  assert.deepEqual(b.value, true);
  assert.deepEqual(c.value, "capsule");
});

test("malformed structured syntax degrades to plain substring text", () => {
  for (const raw of [
    "foo?width>",        // an operator with no value — half-typed, not "has a width"
    "foo?>10",           // an operator with no path
    "foo?width@10",      // junk where an operator or an identifier should be
    "foo?1abc",          // not an identifier, so not an existence test either
    'foo?width>"10',     // unterminated quote in the value
    'foo"bar',           // unterminated quote in the name
  ]) {
    const q = parseQuery(raw);
    for (const term of q.terms) {
      assert.equal(term.structured, false, JSON.stringify(term.raw));
      assert.equal(term.name.text, term.raw);
    }
  }
});

test("a valueless filter is an EXISTENCE test", () => {
  // `M...?cloth` — the form the whole feature exists for: a name shape plus
  // "and it has one of these".
  const [term] = parseQuery("M...?cloth").terms;
  assert.equal(term.structured, true);
  assert.equal(term.name.mode, "prefix");
  assert.equal(term.name.text, "M");
  assert.deepEqual(term.filters, [{ path: ["cloth"], op: "exists", value: true, raw: "cloth" }]);

  // `!` negates it, and existence ANDs with the rest like any other filter.
  const [both] = parseQuery("Lamp?collider&!sound").terms;
  assert.deepEqual(both.filters.map((f) => [f.path.join("."), f.op, f.value]), [
    ["collider", "exists", true],
    ["sound", "exists", false],
  ]);

  // The asymmetry that keeps the degradation guarantee intact: `?width>` has
  // an operator and is simply unfinished, so it must NOT become "has a width".
  assert.equal(parseQuery("foo?width>").terms[0].structured, false);

  // The cost of the feature, spelled out: a name that really does contain a
  // `?` needs quoting now. That is the escape hatch, and it works.
  assert.equal(parseQuery("a?b").terms[0].structured, true, "?b is read as an existence test");
  const quoted = parseQuery('"a?b"').terms[0];
  assert.equal(quoted.name.text, "a?b");
  assert.equal(quoted.filters.length, 0);
});

test("a filter needs no `?` when it stands alone", () => {
  for (const raw of ["collider.shape=convex", "mesh.castShadow=true", "light.intensity>1"]) {
    const [term] = parseQuery(raw).terms;
    assert.equal(term.structured, true, raw);
    assert.equal(term.name.mode, "none", `${raw} has no name half to match`);
    assert.equal(term.filters.length, 1, raw);
    assert.equal(term.filters[0].raw, raw);
  }
  assert.deepEqual(parseQuery("mesh.castShadow=true").terms[0].filters[0], {
    path: ["mesh", "castShadow"],
    op: "=",
    value: true,
    raw: "mesh.castShadow=true",
  });
  // A top-level field is promoted too; an unknown single word is not.
  assert.equal(parseQuery("enabled=false").terms[0].structured, true);
  assert.equal(parseQuery("wat=false").terms[0].structured, false);
  // And it still ANDs with everything else on the line.
  const two = parseQuery("Lamp mesh.castShadow=true");
  assert.equal(two.terms.length, 2);
  assert.equal(two.terms[0].name.text, "Lamp");
  assert.equal(two.terms[1].filters.length, 1);
});

test("a standalone `>` splits the query into scope stages", () => {
  const scoped = parseQuery("Mesh > light");
  assert.equal(scoped.structured, true, "the legacy substring path has nowhere to put 'inside'");
  assert.equal(scoped.stages.length, 2);
  assert.equal(scoped.scopes.length, 1);
  assert.equal(scoped.scopes[0].raw, "Mesh");
  assert.equal(scoped.terms[0].name.text, "light", "the LAST stage is what a result row must match");

  // It chains, and a filter may stand on either side of it.
  const chained = parseQuery("mesh.castShadow=true > Rig > light");
  assert.equal(chained.scopes.length, 2);
  assert.equal(chained.scopes[0].terms[0].filters[0].path.join("."), "mesh.castShadow");
  assert.equal(chained.scopes[1].raw, "Rig");
  assert.equal(chained.terms[0].name.text, "light");

  // `>` is ALSO the greater-than operator. Whitespace on both sides is the
  // entire disambiguation rule, so a comparison is never mistaken for a scope.
  const compare = parseQuery("light.intensity>1");
  assert.equal(compare.scopes.length, 0);
  assert.equal(compare.terms[0].filters[0].op, ">");

  // Half-typed `Mesh >` must behave as `Mesh`, not as "everything": an empty
  // stage would blank the panel for one keystroke and then refill it.
  const typing = parseQuery("Mesh >");
  assert.equal(typing.scopes.length, 0);
  assert.equal(typing.terms.length, 1);
  assert.equal(typing.terms[0].name.text, "Mesh");
});

test("a filter-only term matches any name", () => {
  const q = parseQuery("?enabled=true");
  assert.equal(q.terms.length, 1);
  assert.equal(q.terms[0].name.mode, "none");
  assert.equal(nameMatches("Anything At All", q.terms[0].name), true);
});

test("parse is memoized — the same string returns the same AST", () => {
  const a = parseQuery("lamp?enabled=true");
  const b = parseQuery("lamp?enabled=true");
  assert.equal(a, b);
  const c = parseQuery("lamp?enabled=tru");
  assert.notEqual(a, c);
});

test("quoted names keep spaces through term splitting", () => {
  const q = parseQuery('"big red lamp"...');
  assert.equal(q.terms.length, 1, "spaces inside quotes do not split terms");
  assert.equal(q.terms[0].name.text, "big red lamp");
  assert.equal(q.terms[0].name.mode, "prefix");
});

test("trailing dots inside quotes are literal, outside are the operator", () => {
  assert.equal(parseQuery('"Staging..."').terms[0].name.mode, "substring");
  assert.equal(parseQuery('"Staging..."').terms[0].name.text, "Staging...");
  assert.equal(parseQuery('"Lamp"...').terms[0].name.mode, "prefix");
  assert.equal(parseQuery('"Lamp"...').terms[0].name.text, "Lamp");
});

test("isPlainString agrees with parseQuery about what is plain", () => {
  assert.equal(isPlainString("rock"), true);
  assert.equal(isPlainString("tag:enemy"), true);
  assert.equal(isPlainString("a?b"), false, "a ? is structural even when the parse degrades");
  assert.equal(isPlainString('"balanced"'), true);
  assert.equal(isPlainString('"unbalanced'), false);
  assert.equal(isPlainString("a..."), false);
});

test("empty and whitespace queries parse to zero terms", () => {
  assert.deepEqual(parseQuery("").terms, []);
  assert.deepEqual(parseQuery("   ").terms, []);
  assert.equal(isPlainQuery(parseQuery("")), true);
});
