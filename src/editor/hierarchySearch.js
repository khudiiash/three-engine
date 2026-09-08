// @ts-check
/**
 * The hierarchy's search ranking, in one place.
 *
 * Two callers need it and have to agree: the Hierarchy panel's filter box, and
 * the `selection.selectMatching` op an agent drives over MCP. "Select every
 * mesh" must mean the same 1500 entities whichever one asks, so the tiers live
 * here rather than inside the panel — otherwise the agent's idea of a match and
 * the user's would drift the first time either side was tweaked.
 *
 * The two callers hold entities in different shapes (the panel reads
 * sceneStore's plain mirror, the op reads live `Entity` objects), so ranking
 * takes a small normalized candidate and each side brings its own adapter.
 *
 * Queries come in two shapes, and both routes stay deliberately separate:
 *
 *   plain       — what the box has always done. One lowercased substring, ranked
 *                 on the 0-4 ladder. Multi-word queries still match the WHOLE
 *                 string ("red lamp" is not "red" AND "lamp"), which is the
 *                 back-compat guarantee, so this path is preserved verbatim.
 *   structured  — the queryLang.js grammar (`Lamp...`, `...Box`, `?prop=value`,
 *                 `&`, quotes), evaluated by queryEvalEntity's shared ladder.
 *
 * SCOPING (`Mesh > light`) lives here rather than in the evaluator, and that is
 * not a filing decision: "inside" is a question about the TREE, and a
 * per-candidate matcher has no tree. Each stage left of a `>` selects a set,
 * the next stage may only match that set's DESCENDANTS, and the last stage's
 * matches are the result. The two callers hold the tree in different shapes
 * (the panel a mirror keyed by id, the op live `Entity` objects with
 * `.children`), so `scopePool` takes the two accessors it needs and neither
 * side ends up owning a second copy of the rule.
 *
 * This module is pure and node-testable: its only imports are the two query
 * modules, which have no DOM, no three.js and no Tauri in them.
 */

import { parseQuery, isPlainQuery, isPlainStage } from "./queryLang.js";
import { textTier, entityTermsMatcher, FILTER_ONLY_TIER } from "./queryEvalEntity.js";

/**
 * Rank a candidate against the query. Lower = better; `Infinity` = no match.
 *
 *   0 — name starts with the query
 *   1 — name contains it
 *   2 — a component type starts with it
 *   3 — a component type contains it
 *   4 — a tag contains it
 *
 * Name and component type are both checked in this priority, so "can" jumps to
 * the top for entities literally named "can" AND for anything carrying a
 * `camera` component.
 *
 * A `tag:` prefix searches tags exclusively — "tag:enemy" finds every tagged
 * enemy without also dragging in the entity someone named "Enemy spawn note".
 *
 * Delegates to queryEvalEntity.textTier, which is this ladder verbatim — there
 * is one copy of it in the codebase, so the legacy path and the structured path
 * cannot drift apart.
 *
 * @param {{ name?: string, tags?: string[], componentTypes?: string[] }} candidate
 * @param {string} q  already lowercased and trimmed
 */
export function matchTier(candidate, q) {
  return textTier(candidate, q);
}

/** Candidate from a sceneStore mirror entity (`components` is a plain map).
 *
 *  `components` is taken BY REFERENCE: the props objects already are plain
 *  data the mirror copied at refresh() time, and a per-candidate copy would
 *  multiply a scene-sized object by the number of entities walked per
 *  keystroke. The enabled flags default to true so an older mirror that has
 *  not been refreshed since the flags were added still behaves as "visible".
 */
export function candidateFromMirror(entity) {
  return {
    name: entity.name,
    tags: entity.tags,
    componentTypes: Object.keys(entity.components ?? {}),
    components: entity.components,
    childIds: entity.childIds,
    enabled: (entity.enabled ?? entity.enabledInGame) !== false,
    enabledInGame: (entity.enabled ?? entity.enabledInGame) !== false,
    visibleInEditor: (entity.visibleInEditor ?? entity.enabledInEditor) !== false,
  };
}

/** Candidate from a live engine `Entity` (`components` is a Map of instances).
 *
 *  The props objects are taken by reference for the same reason as the mirror
 *  adapter — they are plain data already, and nothing here mutates them.
 */
export function candidateFromLive(entity) {
  /** @type {Record<string, any>} */
  const components = {};
  for (const component of entity.components?.values() ?? []) {
    components[component.type] = component.props;
  }
  return {
    name: entity.name,
    tags: entity.tags,
    componentTypes: Object.keys(components),
    components,
    // `?childcount>0` has to mean the same thing on both sides: the mirror
    // carries `childIds` already, and a live Entity holds child OBJECTS.
    childIds: (entity.children ?? []).map((child) => child.id),
    enabled: (entity.enabled ?? entity.enabledInGame) !== false,
    enabledInGame: (entity.enabled ?? entity.enabledInGame) !== false,
    visibleInEditor: (entity.visibleInEditor ?? entity.enabledInEditor) !== false,
  };
}

/**
 * `entityTermsMatcher` builds a closure per stage. parseQuery memoizes the
 * query per raw string, so keying on the stage object gives every keystroke
 * exactly one matcher per stage, and the per-entity loop does no allocation
 * beyond its candidate.
 * @type {WeakMap<object, (candidate: Record<string, any>) => number>}
 */
const matcherCache = new WeakMap();

/**
 * The matcher for ONE stage of a query — the target stage, or any scope stage
 * left of a `>`. A stage holding nothing but legacy terms is matched as one
 * substring of its raw text, which is the "red lamp" guarantee holding inside
 * a scope as well as at the top level.
 * @param {import("./queryLang.js").QueryStage} stage
 */
export function stageMatcher(stage) {
  let matcher = matcherCache.get(stage);
  if (!matcher) {
    if (isPlainStage(stage)) {
      const q = stage.raw.trim().toLowerCase();
      matcher = (candidate) => textTier(candidate, q);
    } else {
      matcher = entityTermsMatcher(stage.terms);
    }
    matcherCache.set(stage, matcher);
  }
  return matcher;
}

/** @param {import("./queryLang.js").Query} query */
function matcherFor(query) {
  return stageMatcher(query.stages[query.stages.length - 1]);
}

/**
 * The ids a scoped query's TARGET stage is allowed to match, or `null` when the
 * query has no `>` and the whole pool is fair game. An EMPTY Set means the
 * scope matched nothing and the result must be empty — a different answer from
 * `null`, and one a caller must not confuse with it.
 *
 * Stages nest: in `A > B > C`, B is looked for only under A, and C only under
 * the B's that were found there.
 *
 * @param {import("./queryLang.js").Query} query
 * @param {string[]} ids  every id in the pool; iterated once per scope stage
 * @param {(id: string) => Record<string, any> | null | undefined} candidateOf
 * @param {(id: string) => string[]} childIdsOf
 * @returns {Set<string> | null}
 */
export function scopePool(query, ids, candidateOf, childIdsOf) {
  if (!query.scopes?.length) return null;
  /** @type {Set<string> | null} */
  let pool = null;
  for (const stage of query.scopes) {
    const match = stageMatcher(stage);
    const hits = [];
    for (const id of ids) {
      if (pool && !pool.has(id)) continue;
      const candidate = candidateOf(id);
      if (candidate && match(candidate) !== Infinity) hits.push(id);
    }
    pool = descendantIds(hits, childIdsOf);
    if (!pool.size) return pool;
  }
  return pool;
}

/**
 * Every descendant of `ids`, NOT including the ids themselves — `Mesh > light`
 * asks for the lights inside the Mesh, never the Mesh. Guarded against a cycle
 * in the tree, because a search box is the worst place to discover one.
 * @param {Iterable<string>} ids
 * @param {(id: string) => string[]} childIdsOf
 * @returns {Set<string>}
 */
function descendantIds(ids, childIdsOf) {
  const out = new Set();
  const stack = [];
  for (const id of ids) stack.push(...childIdsOf(id));
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...childIdsOf(id));
  }
  return out;
}

/**
 * Tier for one normalized candidate against a PARSED query. `Infinity` = no
 * match; tier 5 (FILTER_ONLY_TIER) means the candidate matched only through
 * its filters — no name, component-type or tag text pointed at it — so it
 * sorts below every textual hit.
 *
 * SCOPING IS NOT APPLIED HERE — it cannot be. `Mesh > light` is a question
 * about the tree and this function sees one candidate, so it answers only
 * "does this row match the target stage". A caller that honours `>` runs
 * `scopePool` first and skips the ids it excludes; `buildSearchIndex` and
 * `selection.selectMatching` both do.
 *
 * THE ROUTE LIVES INSIDE `stageMatcher`, not at the call sites. A plain stage
 * is the legacy ladder over its WHOLE trimmed string (see the header: "red
 * lamp" is one substring, not "red" AND "lamp"), and the structured grammar
 * would split it into two ANDed terms — which quietly matches an entity named
 * "lamp red" that the panel's box does not. Both callers reaching the same
 * function is the only thing that keeps the agent's idea of a match and the
 * user's from drifting apart, which is what this module exists for.
 *
 * @param {Record<string, any>} candidate
 * @param {import("./queryLang.js").Query} query  from parseQuery
 * @returns {number}
 */
export function matchCandidate(candidate, query) {
  return matcherFor(query)(candidate);
}

/**
 * Builds the panel's match index for the current scene: `{ id -> { tier } }`.
 * Walks the FULL scene rather than the visible rows, so a hit inside a
 * collapsed branch still surfaces. Returns `null` for an empty query so the
 * caller can fast-path to "show everything".
 *
 * Plain queries take the legacy ladder verbatim (see the header); anything
 * using the grammar goes through the evaluator. Both arrive by the same
 * `stageMatcher` call and share one iterative stack walk over the same tree,
 * so neither is allowed to cost more per entity than the other.
 */
export function buildSearchIndex(rootIds, entities, query) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q || !entities) return null;
  const parsed = parseQuery(query);
  // One matcher per query, hoisted out of the walk: matchCandidate would look
  // it up per entity, and this loop runs over the whole scene per keystroke.
  // Plain and structured share the call because stageMatcher owns the choice —
  // a plain stage comes back as the legacy substring ladder over its own raw
  // text, which is also why `Rig >` searches for "Rig" and not for "Rig >".
  const match = matcherFor(parsed);
  // Everything before the last `>` narrows the pool to a set of descendants
  // before the target stage ranks anything. Only walked when a `>` was typed.
  const pool = parsed.scopes.length
    ? scopePool(
        parsed,
        Object.keys(entities),
        (id) => (entities[id] ? candidateFromMirror(entities[id]) : null),
        (id) => entities[id]?.childIds ?? [],
      )
    : null;
  const out = {};
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop();
    const e = entities[id];
    if (!e) continue;
    if (!pool || pool.has(id)) {
      const tier = match(candidateFromMirror(e));
      if (tier !== Infinity) out[id] = { tier };
    }
    if (e.childIds.length) stack.push(...e.childIds);
  }
  return out;
}

/**
 * The name text a match row should highlight, or "" when there is nothing to
 * highlight.
 *
 *   plain query        → the trimmed raw string, as the box has always done
 *   structured query   → the first term's name text, and only when that term
 *                        actually constrains the name: "" for mode "none"
 *                        (a filter-only term) and for a `tag:` name, since
 *                        highlighting "tag:enemy" inside "Enemy spawn" would
 *                        be a lie about why the row matched
 *   scoped query       → the same, read off the TARGET stage. A row in
 *                        `Mesh > red lamp` matched "red lamp", so that is what
 *                        it highlights — never "Mesh > red lamp", and never
 *                        just "red".
 *
 * `fallback` is today's raw-string behaviour, passed in by the caller so this
 * stays a pure function of its arguments.
 * @param {import("./queryLang.js").Query} query
 * @param {string} fallback
 * @returns {string}
 */
export function highlightFor(query, fallback) {
  // Plain (and term-less) queries highlight the whole trimmed string, exactly
  // as the box always did — for a single-word query that is the same text the
  // structured branch below would pick anyway, but a plain "lamp post" must
  // keep highlighting "Lamp Post" in "Lamp Post 2", not just "Lamp".
  if (!query || isPlainQuery(query) || !query.terms.length) return fallback;
  // Only the last stage put rows on screen, so only it may claim a highlight.
  // A plain target stage is still one substring — the "red lamp" rule — and
  // its own raw text is that substring, which the whole-query fallback is not.
  const stage = query.stages[query.stages.length - 1];
  if (isPlainStage(stage)) return stage.raw.trim();
  const term = query.terms[0];
  const { mode, text } = term.name;
  if (mode === "none") return "";
  const needle = String(text ?? "");
  if (!needle) return "";
  if (needle.toLowerCase().startsWith("tag:")) return "";
  return needle;
}

/**
 * Match ids in display order: best tier first, name as the stable tiebreaker.
 * This order is also the selection order — shift-click ranges and Ctrl+A in
 * search mode both run over exactly the list the user is looking at. Tier 5
 * (filter-only) sorts last by construction: it is a number like any other.
 */
export function sortMatchIds(matches, entities) {
  if (!matches) return [];
  return Object.keys(matches).sort((a, b) => {
    const t = matches[a].tier - matches[b].tier;
    if (t !== 0) return t;
    return (entities?.[a]?.name ?? "").localeCompare(entities?.[b]?.name ?? "");
  });
}

/** Re-exported so a caller can name the "matched only through its filters"
 *  tier without importing the evaluator too. */
export { FILTER_ONLY_TIER };
