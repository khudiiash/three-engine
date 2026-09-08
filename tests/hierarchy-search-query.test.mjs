import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSearchIndex,
  sortMatchIds,
  matchTier,
  matchCandidate,
  candidateFromMirror,
  candidateFromLive,
  highlightFor,
  scopePool,
} from "../src/editor/hierarchySearch.js";
import { parseQuery, isPlainQuery } from "../src/editor/queryLang.js";
import { FILTER_ONLY_TIER } from "../src/editor/queryEvalEntity.js";

/**
 * The hierarchy search index, dual-path.
 *
 * The PLAIN path is the behaviour the box has always had — the test keeps a
 * verbatim copy of the old loop beside it and demands the same tiers, because
 * "red lamp" must keep meaning "the name contains 'red lamp'" and not the
 * structured reading of it.
 *
 * The STRUCTURED path is the queryLang grammar, and it must agree with
 * `selection.selectMatching` (which ranks live entities) letter for letter.
 */

const mirrorScene = {
  rootIds: ["lamp1", "lamp2", "box", "jukebox", "note", "empty", "redlamp"],
  entities: {
    lamp1: {
      id: "lamp1",
      name: "Lamp Post 2",
      tags: ["street", "lighting"],
      components: {
        transform: { enabled: true },
        light: { enabled: true, intensity: 3.5, kind: "point" },
        collider: { enabled: true, shape: "convex" },
      },
      visibleInEditor: true,
      enabled: true,
      childIds: [],
    },
    lamp2: {
      id: "lamp2",
      name: "Floor Lamp",
      tags: [],
      components: { transform: { enabled: true }, light: { enabled: true, intensity: 1 } },
      visibleInEditor: false, // hidden while editing; still enabled
      enabled: true,
      childIds: [],
    },
    box: {
      id: "box",
      name: "Crate",
      tags: ["enemy"],
      components: { transform: { enabled: true }, mesh: { castShadow: true } },
      visibleInEditor: true,
      enabled: false, // the hierarchy's eye is off
      childIds: [],
    },
    jukebox: {
      id: "jukebox",
      name: "JukeBox",
      tags: [],
      components: { transform: { enabled: true }, sound: { volume: 0.5 } },
      visibleInEditor: true,
      enabled: true,
      childIds: [],
    },
    note: {
      id: "note",
      name: "Enemy spawn note",
      tags: [],
      components: { transform: { enabled: true } },
      visibleInEditor: true,
      enabled: true,
      childIds: [],
    },
    empty: {
      id: "empty",
      name: "empty",
      tags: [],
      components: {},
      visibleInEditor: true,
      enabled: true,
      childIds: ["lamp1"], // a hit inside a nested branch must still surface
    },
    redlamp: {
      id: "redlamp",
      name: "my red lamp 1",
      tags: [],
      components: { transform: { enabled: true } },
      visibleInEditor: true,
      enabled: true,
      childIds: [],
    },
  },
};

/** A live engine Entity reduced to the bits the adapters read. */
function liveEntity(mirror) {
  return {
    id: mirror.id,
    name: mirror.name,
    tags: mirror.tags,
    components: new Map(
      Object.entries(mirror.components).map(([type, props]) => [type, { type, props }]),
    ),
    children: (mirror.childIds ?? []).map((id) => ({ id })),
    enabled: mirror.enabled,
    visibleInEditor: mirror.visibleInEditor,
  };
}

const { rootIds, entities } = mirrorScene;

test("buildSearchIndex returns null for an empty (or blank) query", () => {
  assert.equal(buildSearchIndex(rootIds, entities, ""), null);
  assert.equal(buildSearchIndex(rootIds, entities, "   "), null);
  assert.equal(buildSearchIndex(rootIds, entities, null), null);
  assert.equal(buildSearchIndex(rootIds, null, "lamp"), null);
});

test("the plain path returns EXACTLY the tiers the legacy loop produced", () => {
  // The old implementation, kept here verbatim as the reference.
  const legacyIndex = (query) => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const out = {};
    const stack = [...rootIds];
    while (stack.length) {
      const id = stack.pop();
      const e = entities[id];
      if (!e) continue;
      const tier = matchTier(
        { name: e.name, tags: e.tags, componentTypes: Object.keys(e.components) },
        q,
      );
      if (tier !== Infinity) out[id] = { tier };
      if (e.childIds.length) stack.push(...e.childIds);
    }
    return out;
  };

  for (const query of [
    "lamp", "Lamp", "lamp post", "red lamp", "crate", "juke", "box", "note",
    "tag:enemy", "tag:street", "tag:", "mesh", "collider", "sound", "zzz",
    "enemy spawn", "e", "castshadow",
  ]) {
    // Queries the grammar claims route through the structured path by design —
    // an asset kind word ("post", "mesh", "sound") makes the term structured.
    // Those are covered by the dedicated test below; everything a plain string
    // can be must match the legacy loop exactly.
    if (!isPlainQuery(parseQuery(query))) continue;
    assert.deepEqual(buildSearchIndex(rootIds, entities, query), legacyIndex(query), query);
  }

  // And the one thing a plain query still is: ONE substring. "red lamp" has to
  // match the entity literally named "red lamp" — not "red" AND "lamp".
  assert.deepEqual(buildSearchIndex(rootIds, entities, "red lamp"), { redlamp: { tier: 1 } });
});

test("a multi-word query holding an ASSET kind word takes the structured path", () => {
  // "post" is an asset kind word, so "lamp post" parses as two terms ANDed
  // together (worst tier wins) instead of the legacy whole-string substring.
  // The routing lives in queryLang.js, which owns ASSET_KIND_WORDS — recorded
  // here so a change to it shows up as a deliberate diff, not a surprise.
  assert.equal(isPlainQuery(parseQuery("lamp post")), false);
  assert.deepEqual(buildSearchIndex(rootIds, entities, "lamp post"), { lamp1: { tier: 1 } });
});

test("Lamp?enabled=true&collider.shape=convex finds the convex, enabled lamp only", () => {
  const index = buildSearchIndex(rootIds, entities, "Lamp?enabled=true&collider.shape=convex");
  assert.deepEqual(Object.keys(index), ["lamp1"]);
  assert.equal(index.lamp1.tier, 0, "'Lamp Post 2' starts with Lamp");
  // Floor Lamp is editor-disabled and has no collider — out on both counts.
  assert.equal(index.lamp2, undefined);
});

test("the same query ranks live entities the same way (both callers agree)", () => {
  const query = parseQuery("Lamp?enabled=true&collider.shape=convex");
  for (const id of rootIds) {
    const mirror = entities[id];
    assert.equal(
      matchCandidate(candidateFromLive(liveEntity(mirror)), query),
      matchCandidate(candidateFromMirror(mirror), query),
      id,
    );
  }
});

test("Lamp... is a prefix, ...Box is a suffix", () => {
  const prefix = buildSearchIndex(rootIds, entities, "Lamp...");
  assert.deepEqual(Object.keys(prefix), ["lamp1"], "'Floor Lamp' does not START with Lamp");
  assert.equal(prefix.lamp1.tier, 0);
  const suffix = buildSearchIndex(rootIds, entities, "...lamp");
  assert.deepEqual(Object.keys(suffix), ["lamp2"], "'Lamp Post 2' ends with '2', not 'lamp'");
  assert.equal(suffix.lamp2.tier, 0);
  assert.equal(buildSearchIndex(rootIds, entities, "...box").jukebox.tier, 0);
  assert.equal(buildSearchIndex(rootIds, entities, "...box").box, undefined, "'Crate' does not end in box");
  assert.equal(buildSearchIndex(rootIds, entities, "...Box").jukebox.tier, 0, "matching is case-insensitive");
  // ...stand... is an explicit contains, same as plain text.
  assert.equal(buildSearchIndex(rootIds, entities, "...lamp...").lamp2.tier, 1);
});

test("a hit inside a nested branch is still found", () => {
  assert.deepEqual(buildSearchIndex(rootIds, entities, "Lamp Post"), { lamp1: { tier: 1 } });
  assert.deepEqual(buildSearchIndex(rootIds, entities, "lamp..."), { lamp1: { tier: 0 } });
});

test("a filter-only match ranks at tier 5, below every textual hit", () => {
  const index = buildSearchIndex(rootIds, entities, "?light.intensity>2");
  assert.deepEqual(Object.keys(index), ["lamp1"]);
  assert.equal(index.lamp1.tier, FILTER_ONLY_TIER);
  assert.equal(buildSearchIndex(rootIds, entities, "?visibleineditor=false").lamp2.tier, FILTER_ONLY_TIER);
  assert.equal(buildSearchIndex(rootIds, entities, "?enabled=false").box.tier, FILTER_ONLY_TIER);
  assert.equal(buildSearchIndex(rootIds, entities, "?tag=enemy").box.tier, FILTER_ONLY_TIER);
  // Filters can also gate a name match without changing its tier.
  assert.deepEqual(buildSearchIndex(rootIds, entities, "lamp?visibleineditor=false"), { lamp2: { tier: 1 } });
});

test("`enabled` is the one flag (both modes); `visibleInEditor` is the editing aid; `enabledInGame` still reads enabled", () => {
  assert.deepEqual(
    buildSearchIndex(rootIds, entities, "?enabled=false"),
    { box: { tier: FILTER_ONLY_TIER } },
  );
  assert.deepEqual(
    buildSearchIndex(rootIds, entities, "?visibleInEditor=false"),
    { lamp2: { tier: FILTER_ONLY_TIER } },
  );
  assert.deepEqual(
    buildSearchIndex(rootIds, entities, "?enabledInGame=false"),
    { box: { tier: FILTER_ONLY_TIER } },
  );
});

test("sortMatchIds orders by tier, then name", () => {
  const matches = {
    note: { tier: 1 },
    lamp1: { tier: 1 },
    box: { tier: FILTER_ONLY_TIER },
    jukebox: { tier: 0 },
    lamp2: { tier: 5 },
  };
  assert.deepEqual(sortMatchIds(matches, entities), ["jukebox", "note", "lamp1", "box", "lamp2"]);
  // Tier 5 (filter-only) is just a number — it sorts after everything textual.
  assert.equal(sortMatchIds({ a: { tier: 5 }, b: { tier: 0 } }, entities)[0], "b");
  assert.deepEqual(sortMatchIds(null, entities), []);
});

test("highlightFor: plain queries keep the raw behaviour", () => {
  assert.equal(highlightFor(parseQuery("  Lamp  "), "Lamp"), "Lamp");
  // A multi-word plain query highlights the WHOLE trimmed string, as always —
  // not just its first word.
  assert.equal(highlightFor(parseQuery("enemy spawn"), "enemy spawn"), "enemy spawn");
  assert.equal(highlightFor(parseQuery(""), ""), "");
  assert.equal(highlightFor(parseQuery("   "), ""), "");
});

test("highlightFor: structured queries highlight the first term's name text", () => {
  assert.equal(highlightFor(parseQuery("Lamp?enabled=true"), "Lamp?enabled=true"), "Lamp");
  assert.equal(highlightFor(parseQuery("Lamp..."), "Lamp..."), "Lamp");
  assert.equal(highlightFor(parseQuery("...Box"), "...Box"), "Box");
  assert.equal(highlightFor(parseQuery('"red lamp"?enabled=true'), '"red lamp"?enabled=true'), "red lamp");
});

test("highlightFor: a name-less or structured-tag match has nothing to highlight", () => {
  assert.equal(highlightFor(parseQuery("?light.intensity>2"), "?light.intensity>2"), "");
  assert.equal(highlightFor(parseQuery("tag:enemy?enabled=true"), "tag:enemy?enabled=true"), "");
  // The PLAIN `tag:enemy` is not structured grammar, so it keeps today's
  // behaviour (the raw string) — harmless, because the rows it highlights
  // rarely contain the literal text "tag:enemy".
  assert.equal(highlightFor(parseQuery("tag:enemy"), "tag:enemy"), "tag:enemy");
});

test("highlightFor: a structured query whose FIRST term is plain text still highlights it", () => {
  assert.equal(highlightFor(parseQuery('crate "big box"'), 'crate "big box"'), "crate");
});

test("the two adapters agree on the flags they report", () => {
  const mirror = entities.lamp2;
  assert.equal(candidateFromMirror(mirror).enabled, true);
  assert.equal(candidateFromMirror(mirror).visibleInEditor, false);
  assert.equal(candidateFromLive(liveEntity(mirror)).enabled, true);
  assert.equal(candidateFromLive(liveEntity(mirror)).visibleInEditor, false);
  assert.equal(candidateFromMirror(entities.box).enabled, false);
  assert.equal(candidateFromMirror(entities.box).enabledInGame, false);
  // Absent flags read as enabled — an older mirror that predates them must
  // not turn the whole scene invisible to `?enabled=true`.
  const legacyMirror = { name: "x", tags: [], components: {} };
  assert.equal(candidateFromMirror(legacyMirror).enabled, true);
  assert.equal(candidateFromLive({ name: "x", components: new Map() }).enabledInGame, true);
  // A mirror still carrying the old per-mode pair: its game flag is enabled,
  // its editor flag the viewing aid.
  const oldMirror = { name: "y", tags: [], components: {}, enabledInEditor: false, enabledInGame: false };
  assert.equal(candidateFromMirror(oldMirror).enabled, false);
  assert.equal(candidateFromMirror(oldMirror).visibleInEditor, false);
});

test("the adapters hand through the props objects without copying them", () => {
  const mirror = entities.lamp1;
  assert.equal(candidateFromMirror(mirror).components, mirror.components);
  const live = liveEntity(mirror);
  const candidate = candidateFromLive(live);
  for (const [type, component] of live.components) {
    assert.equal(candidate.components[type], component.props, type);
  }
});

test("matchCandidate takes the SAME route as the panel for a plain query", () => {
  // The drift this guards: the grammar splits a multi-word plain query into
  // ANDed terms, so `selection.selectMatching("lamp red")` would have matched
  // "my red lamp 1" while the panel's box — one substring — does not. The op
  // and the box are the two callers this module exists to keep identical, so
  // the plain/structured route belongs inside matchCandidate, not at each site.
  const panelIndex = (raw) => buildSearchIndex(rootIds, entities, raw);
  const opIds = (raw) => {
    const query = parseQuery(raw);
    return Object.keys(entities).filter(
      (id) => matchCandidate(candidateFromLive(liveEntity(entities[id])), query) !== Infinity,
    );
  };
  for (const raw of ["lamp red", "red lamp", "lamp", "tag:enemy", "spawn note"]) {
    assert.deepEqual(
      opIds(raw).sort(),
      Object.keys(panelIndex(raw) ?? {}).sort(),
      `the op and the panel disagree about "${raw}"`,
    );
  }
  // And the specific pair, spelled out: "lamp red" is a substring nothing has.
  assert.deepEqual(panelIndex("lamp red"), {});
  assert.deepEqual(opIds("lamp red"), []);
  assert.deepEqual(Object.keys(panelIndex("red lamp")), ["redlamp"]);
});

// ---------------------------------------------------------------------------
// The three shorthands and the scope operator, over a tree with real depth.
// ---------------------------------------------------------------------------

/** A scene shaped like the one the shorthands were reported broken against. */
const scopedScene = {
  rootIds: ["dirlight", "box", "meshroot", "crate"],
  entities: {
    dirlight: {
      id: "dirlight", name: "Directional Light", tags: [], childIds: [],
      components: { transform: {}, light: { kind: "directional", intensity: 1 } },
      enabledInEditor: true, enabledInGame: true,
    },
    box: {
      id: "box", name: "Box", tags: [], childIds: [],
      components: { transform: {}, mesh: { geometry: "box", castShadow: true } },
      enabledInEditor: true, enabledInGame: true,
    },
    meshroot: {
      id: "meshroot", name: "Mesh", tags: [], childIds: ["fill", "group"],
      components: { transform: {}, mesh: { geometry: "plane", castShadow: true }, cloth: { gust: 0 } },
      enabledInEditor: true, enabledInGame: true,
    },
    fill: {
      id: "fill", name: "Fill Light", tags: [], childIds: [],
      components: { transform: {}, light: { kind: "point", intensity: 2 } },
      enabledInEditor: true, enabledInGame: true,
    },
    group: {
      id: "group", name: "Nested Group", tags: [], childIds: ["deep"],
      components: { transform: {} },
      enabledInEditor: true, enabledInGame: true,
    },
    deep: {
      id: "deep", name: "Deep Light", tags: [], childIds: [],
      components: { transform: {}, light: { kind: "point", intensity: 5 } },
      enabledInEditor: true, enabledInGame: true,
    },
    crate: {
      id: "crate", name: "Crate", tags: [], childIds: [],
      components: { transform: {}, mesh: { castShadow: false }, collider: { shape: "convex" } },
      enabledInEditor: true, enabledInGame: true,
    },
  },
};

/** Names of what the panel would show, in the order it would show them. */
const found = (raw) => {
  const index = buildSearchIndex(scopedScene.rootIds, scopedScene.entities, raw);
  return sortMatchIds(index, scopedScene.entities).map((id) => scopedScene.entities[id].name);
};

test("a filter with no `?` in front of it is still a filter", () => {
  assert.deepEqual(found("collider.shape=convex"), ["Crate"]);
  assert.deepEqual(found("mesh.castShadow=true"), ["Box", "Mesh"], "Crate's is false, and it is the point of the test");
  assert.deepEqual(found("light.intensity>1"), ["Deep Light", "Fill Light"]);
  // The reported case, and why it looked broken: the Directional Light's
  // intensity is exactly 1, so `>1` correctly finds nothing and `>0` finds it.
  assert.deepEqual(found("Dir...?light.intensity>1"), []);
  assert.deepEqual(found("Dir...?light.intensity>0"), ["Directional Light"]);
});

test("a valueless filter asks whether the component is there", () => {
  assert.deepEqual(found("M...?cloth"), ["Mesh"]);
  assert.deepEqual(found("?cloth"), ["Mesh"]);
  assert.deepEqual(found("?collider"), ["Crate"]);
  assert.deepEqual(found("?!collider").includes("Crate"), false, "`!` is the negation");
  // "Mesh" is a name half, so it also matches anything carrying a MESH
  // COMPONENT (the tier-2 rung) — and those are exactly the rows `!cloth`
  // keeps. The entity actually named Mesh is the one it drops.
  assert.deepEqual(found("Mesh?!cloth"), ["Box", "Crate"]);
  // It ANDs with a valued filter like anything else.
  assert.deepEqual(found("?cloth&mesh.castShadow=true"), ["Mesh"]);
});

test("`A > B` searches INSIDE what A matched", () => {
  // Every light under something named Mesh — nested at two depths, and NOT
  // the Directional Light, which is a root.
  assert.deepEqual(found("Mesh > light"), ["Deep Light", "Fill Light"]);
  // The left side may be a filter.
  assert.deepEqual(found("mesh.castShadow=true > light"), ["Deep Light", "Fill Light"]);
  // The right side may be one.
  assert.deepEqual(found("Mesh > ?light.intensity>3"), ["Deep Light"]);
  // It chains, and each stage looks only inside the one before it.
  assert.deepEqual(found("Mesh > Nested > light"), ["Deep Light"]);
  // The scope's own matches are never results: `Mesh > mesh` is what is
  // UNDER the Mesh with a mesh component, not the Mesh itself.
  assert.equal(found("Mesh > Mesh").includes("Mesh"), false);
  // A scope that matches nothing gives nothing, rather than falling back to
  // the whole scene.
  assert.deepEqual(found("Nothing > light"), []);
  // Half-typed: `Mesh >` has to behave as `Mesh` and not empty the panel.
  assert.equal(found("Mesh >").includes("Mesh"), true);
});

test("`>` inside a filter is still the comparison it always was", () => {
  // No whitespace ⇒ no scope. If this ever flips, every numeric filter in the
  // editor silently becomes a scope with a nonsense left half.
  assert.deepEqual(found("light.intensity>1"), ["Deep Light", "Fill Light"]);
  assert.deepEqual(found("Mesh > light"), ["Deep Light", "Fill Light"]);
});

test("the op and the panel agree about `>` too", () => {
  // scopePool is shared, so the two callers cannot disagree about "inside" —
  // the same claim the plain/structured route test makes about "matches".
  const query = parseQuery("Mesh > light");
  const ids = Object.keys(scopedScene.entities);
  const pool = scopePool(
    query,
    ids,
    (id) => candidateFromLive(liveEntity(scopedScene.entities[id])),
    (id) => scopedScene.entities[id]?.childIds ?? [],
  );
  assert.deepEqual([...pool].sort(), ["deep", "fill", "group"], "every descendant of Mesh, and only those");
  const match = matchCandidate;
  const opIds = ids
    .filter((id) => pool.has(id))
    .filter((id) => match(candidateFromLive(liveEntity(scopedScene.entities[id])), query) !== Infinity);
  assert.deepEqual(
    opIds.map((id) => scopedScene.entities[id].name).sort(),
    found("Mesh > light").slice().sort(),
  );
});

test("candidateFromLive carries childIds, so `?childcount` means one thing", () => {
  const live = candidateFromLive(liveEntity(scopedScene.entities.meshroot));
  assert.deepEqual(live.childIds, ["fill", "group"]);
  assert.deepEqual(
    found("?childcount>1"),
    ["Mesh"],
    "the mirror side has to answer it the same way",
  );
});
