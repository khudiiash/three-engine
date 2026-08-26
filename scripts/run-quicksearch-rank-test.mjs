// Quick Search (Ctrl+F) ranking: does an item that has nothing in common with
// the query stay OUT of the results?
//
// Reported as "searching 'Shader Graph' shows a whole bunch of random entities
// and the actual match is down below the viewport". Two independent faults, and
// this file gates the first one:
//
//   - the matcher glued title + subtitle + keywords into ONE haystack, so every
//     entity carried the constant words "entity" and "hierarchy" (its subtitle)
//     and a random base-62 id, and the punctuation-blind fallback could match
//     across the seam between two fields;
//   - the list was keyed on `type:title:subtitle`, which collides for two
//     entities with the same name — that half is DOM behaviour and lives in
//     run-quicksearch-open-smoke.mjs.
//
// Run: node scripts/run-quicksearch-rank-test.mjs

import { makeItem, score } from "../src/editor/quickSearchRank.js";

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

const entity = (name, id, tags = []) =>
  makeItem({ key: `entity:${id}`, type: "entity", title: name, subtitle: "Entity · Hierarchy", terms: tags, exact: id, activate: () => {} });
const panel = (id, title) =>
  makeItem({ key: `panel:${id}`, type: "panel", title, subtitle: "Panel", terms: [id], activate: () => {} });
const asset = (name, path) =>
  makeItem({ key: `asset:${path}`, type: "asset", title: name, subtitle: `Asset · ${path}`, terms: [path], activate: () => {} });

// The scene from the bug report.
const ITEMS = [
  entity("bookcaseClosedDoors", "3UNTA7-1PB"),
  entity("Coffee Table", "WLYdZYMlR2"),
  entity("Light Ceiling", "e53f62_08M"),
  entity("Light Stand", "jDGdh5pNy9"),
  entity("Light Stand", "z25Lw3vupz"),
  entity("Light_Ceiling1", "qMq0MC1wAk"),
  entity("Light_Stand1", "Of7rs_J_M8"),
  panel("shaderGraph", "Shader Graph"),
  // A panel genuinely CALLED Hierarchy, so "the subtitle isn't searchable"
  // can't pass just because nothing in the fixture was called that.
  panel("hierarchy", "Hierarchy"),
  panel("git", "Source Control"),
  panel("itchio", "itch.io"),
  panel("mcp", "Assistant (MCP)"),
  asset("Floor.mat", "C:/GAME/materials/Floor.mat"),
];

/** Titles that survive the gate, best first — exactly what the panel renders. */
const search = (query, items = ITEMS) =>
  items
    .map((item) => ({ item, rank: score(item, query) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => b.rank - a.rank || a.item.title.localeCompare(b.item.title))
    .map((x) => x.item.title);

// ---------------------------------------------------------------------------
console.log("\nthe reported case");

const shaderGraph = search("Shader Graph");
check("'Shader Graph' returns the panel and nothing else", shaderGraph.length === 1 && shaderGraph[0] === "Shader Graph",
  shaderGraph.join(", ") || "nothing");

// ---------------------------------------------------------------------------
console.log("\ncategory labels are not searchable");

// Every entity's subtitle is the same two words. Matching them meant one
// keystroke returned the whole scene, ranked by nothing.
const hierarchy = search("hierarchy");
check("'hierarchy' returns the panel of that name and NOT the scene",
  hierarchy.length === 1 && hierarchy[0] === "Hierarchy", hierarchy.join(", ") || "nothing");
check("'entity' matches nothing at all", search("entity").length === 0, search("entity").join(", "));
check("'panel' does not return every panel", search("panel").length === 0, search("panel").join(", "));
check("'asset' does not return every asset", search("asset").length === 0, search("asset").join(", "));

// ---------------------------------------------------------------------------
console.log("\nentity ids match whole, never partial");

check("pasting a whole id finds its entity", search("jDGdh5pNy9").join() === "Light Stand");
check("...case-insensitively", search("JDGDH5PNY9").join() === "Light Stand");
// Ids are random base-62: as substrings they answer to any few characters
// someone types, which is where most of the "random entities" came from.
check("a fragment of an id matches nothing", search("dh5").length === 0, search("dh5").join(", "));
check("...nor does a fragment shared by several", search("z25").length === 0, search("z25").join(", "));

// ---------------------------------------------------------------------------
console.log("\nmatching is per field, never across the seam");

check("'itchio' still finds itch.io (punctuation-blind)", search("itchio").join() === "itch.io", search("itchio").join(", "));
check("'mcp' still finds Assistant (MCP)", search("mcp").join() === "Assistant (MCP)", search("mcp").join(", "));
check("'git' still finds Source Control by its panel id", search("git").join() === "Source Control", search("git").join(", "));
check("a path still finds its asset", search("materials/Floor").join() === "Floor.mat", search("materials/Floor").join(", "));

// Title ends where the term begins: joined into one string, "wallnorth"
// matches; kept apart, it does not.
const seam = [makeItem({ key: "a", type: "asset", title: "Wall", subtitle: "Asset · x", terms: ["north.png"], activate: () => {} })];
check("a query straddling two fields does NOT match", search("wallnorth", seam).length === 0, search("wallnorth", seam).join(", "));
check("...while each field on its own still does",
  search("wall", seam).length === 1 && search("north", seam).length === 1);

// Two characters compact-matched half the project; the fallback needs length.
const shortCompact = [panel("polyhaven", "Poly Haven")];
check("a 2-character query does not fall back to compact matching",
  search("ph", shortCompact).length === 0, search("ph", shortCompact).join(", "));
check("...but the real thing still matches", search("polyhaven", shortCompact).join() === "Poly Haven");

// ---------------------------------------------------------------------------
console.log("\nordering");

check("all query words in any order still match", search("graph shader").join() === "Shader Graph",
  search("graph shader").join(", "));

const ordered = search("light");
check("'light' returns only the lights", ordered.length === 5, ordered.join(", "));
check("...with the shortest/most exact first", ordered[0].startsWith("Light"), ordered.join(", "));

const mixed = [entity("Shader Graph Notes", "aaaaaaaaaa"), panel("shaderGraph", "Shader Graph")];
check("an exact title beats a longer one that contains it", search("shader graph", mixed)[0] === "Shader Graph",
  search("shader graph", mixed).join(", "));

check("an empty query matches everything (the browse list)", score(ITEMS[0], "   ") === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
