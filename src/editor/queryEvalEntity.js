// @ts-check
/**
 * Entity-side evaluation of the query language (queryLang.js).
 *
 * A candidate is the ADAPTER-SHAPED view both callers normalize to before this
 * module sees it — the hierarchy panel's sceneStore mirror (plain objects)
 * and the MCP `selection.selectMatching` op's live `Entity` instances must
 * produce the same shape, or the agent's idea of "every lamp" drifts from the
 * panel's:
 *
 *   { name, tags: string[], componentTypes: string[],
 *     components: Record<type, propsObject>,   // props are plain data
 *     enabled: boolean,          // enabledInEditor — what the hierarchy eye shows
 *     enabledInGame: boolean,    // queryable separately
 *     childIds?: string[] }
 *
 * All reads are synchronous plain-property walks: a 1500-entity scene with a
 * couple of filters must stay well under a millisecond per keystroke, so
 * there is no engine round-trip and no allocation beyond the returned tier.
 */

import { compareOp, nameMatches } from "./queryLang.js";

/**
 * The name ladder shared with hierarchySearch.matchTier, so the structured
 * path cannot invent its own ranking:
 *   0 name starts with / tag equals · 1 name contains / tag contains ·
 *   2 component type starts with · 3 component type contains · 4 tag contains
 * `Infinity` = no match.
 * @param {{ name?: string, tags?: string[], componentTypes?: string[] }} candidate
 * @param {string} q  lowercased, trimmed
 */
export function textTier(candidate, q) {
  const tags = (candidate.tags ?? []).map((tag) => String(tag).toLowerCase());
  if (q.startsWith("tag:")) {
    const needle = q.slice(4).trim();
    if (!needle) return tags.length ? 0 : Infinity;
    if (tags.some((tag) => tag === needle)) return 0;
    return tags.some((tag) => tag.includes(needle)) ? 1 : Infinity;
  }
  const name = (candidate.name ?? "").toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  const types = candidate.componentTypes ?? [];
  for (const type of types) {
    if (type.toLowerCase().startsWith(q)) return 2;
  }
  for (const type of types) {
    if (type.toLowerCase().includes(q)) return 3;
  }
  if (tags.some((tag) => tag.includes(q))) return 4;
  return Infinity;
}

/** Tier assigned when a term matches only through its filters / kind. */
export const FILTER_ONLY_TIER = 5;

/**
 * Resolve a dotted filter path against a candidate. Top-level fields first
 * (name, tag, enabled, enabledInGame, childCount), then path[0] as a
 * component type and the rest as a props walk. Missing anything ⇒
 * `{ found: false }` — never a throw, because `Lamp?collider.shape=convex`
 * is EXPECTED to skip lamps without colliders.
 * @param {Record<string, any>} candidate
 * @param {string[]} path
 * @returns {{ found: boolean, value?: unknown }}
 */
export function resolveEntityPath(candidate, path) {
  const head = path[0];
  if (head === "name") return { found: true, value: candidate.name };
  if (head === "tag" || head === "tags") return { found: true, value: candidate.tags ?? [] };
  if (head === "enabled") return { found: true, value: candidate.enabled };
  if (head === "enabledingame") return { found: true, value: candidate.enabledInGame };
  if (head === "childcount") {
    return { found: true, value: candidate.childIds ? candidate.childIds.length : 0 };
  }
  const props = candidate.components?.[head];
  if (props === undefined || props === null) return { found: false };
  // A bare `collider=true` asks "does it have one" — the props object itself
  // is the value, and existence is the comparison (see compareFilter).
  if (path.length === 1) return { found: true, value: props };
  let value = props;
  for (let i = 1; i < path.length; i++) {
    if (value === null || typeof value !== "object") return { found: false };
    const key = path[i];
    let next = value[key] !== undefined ? value[key] : value[key.toLowerCase()];
    if (next === undefined && value[key.toLowerCase()] === undefined) {
      // camelCase typed loosely (`castshadow`): one case-insensitive scan on
      // the miss path only — the hit path stays two plain property reads.
      const lower = key.toLowerCase();
      const match = Object.keys(value).find((k) => k.toLowerCase() === lower);
      if (match !== undefined) next = value[match];
    }
    if (next === undefined) return { found: false };
    value = next;
  }
  return { found: true, value };
}

/**
 * Does `path` resolve on this candidate at all — the `?cloth` / `?!cloth`
 * existence test. `resolveEntityPath` already answers "is it there" for every
 * shape of path (a component, a prop inside one, a top-level field), so this
 * is that question asked without a value to compare, plus the same
 * context-type fallback a valued filter gets.
 */
function existsOnEntity(candidate, path, contextType) {
  if (resolveEntityPath(candidate, path).found) return true;
  if (contextType) return resolveEntityPath(candidate, [contextType, ...path]).found;
  return false;
}

/** Apply one filter. `tag` is special: any tag matching is enough. */
function compareFilter(candidate, filter, contextType) {
  // `?cloth` — no operator was typed, so the question is existence and there
  // is nothing to compare. Checked FIRST: every branch below wants a value.
  if (filter.op === "exists") {
    return existsOnEntity(candidate, filter.path, contextType) === filter.value;
  }
  // `collider=true` / `sound=false` — a bare component path compared against
  // a boolean means existence, not object identity.
  if (filter.path.length === 1 && typeof filter.value === "boolean" && filter.path[0] !== "name" &&
      filter.path[0] !== "tag" && filter.path[0] !== "enabled" && filter.path[0] !== "enabledingame") {
    const exists = candidate.components?.[filter.path[0]] !== undefined;
    return compareOp(filter.op, exists, filter.value);
  }
  let { found, value } = resolveEntityPath(candidate, filter.path);
  if (!found && contextType) {
    // `light?intensity>2` / `collider?shape=convex` — the name half names a
    // component, so a bare prop resolves inside it. The explicit
    // `collider.shape=…` spelling always wins when it resolves.
    const nested = resolveEntityPath(candidate, [contextType, ...filter.path]);
    if (nested.found) { found = true; value = nested.value; }
  }
  if (!found) return false;
  if (filter.path[0] === "tag" || filter.path[0] === "tags") {
    const tags = /** @type {string[]} */ (value).map((tag) => String(tag));
    // An UNTAGGED entity passes `tag!=x` (nothing in it is x) and fails `tag=x`.
    if (!tags.length) return filter.op === "!=";
    // `tag=rock` is "any tag is rock"; `tag!=rock` is "NO tag is rock".
    return filter.op === "!="
      ? tags.every((tag) => compareOp(filter.op, tag, filter.value))
      : tags.some((tag) => compareOp(filter.op, tag, filter.value));
  }
  return compareOp(filter.op, value, filter.value);
}

/**
 * Tier for ONE parsed term against ONE candidate. `Infinity` = no match.
 * @param {import("./queryLang.js").QueryTerm} term
 * @param {Record<string, any>} candidate
 */
export function entityTermMatcher(term) {
  // Legacy/invalid terms are plain text through the shared ladder — the
  // structured path must agree with today's ranking letter for letter.
  if (!term.structured || !term.valid) {
    const q = term.raw.trim().toLowerCase();
    return (candidate) => textTier(candidate, q);
  }
  const contextType = term.name.text.toLowerCase() || null;
  return (candidate) => {
    for (const filter of term.filters) {
      if (!compareFilter(candidate, filter, contextType)) return Infinity;
    }
    const { name } = term;
    if (name.mode === "none") return FILTER_ONLY_TIER;
    // `tag:` in the name half keeps its exclusive meaning in structured
    // queries too: `tag:enemy?enabled=true` is tagged enemies, enabled.
    if (name.text.toLowerCase().startsWith("tag:")) {
      const tier = textTier(candidate, name.text.toLowerCase());
      return tier === Infinity ? Infinity : tier;
    }
    if (name.mode === "prefix") {
      return (candidate.name ?? "").toLowerCase().startsWith(name.text.toLowerCase()) ? 0 : Infinity;
    }
    if (name.mode === "suffix") {
      return (candidate.name ?? "").toLowerCase().endsWith(name.text.toLowerCase()) ? 0 : Infinity;
    }
    // substring (and kind words, which on the entity side are just words)
    const tier = textTier(candidate, name.text.toLowerCase());
    if (tier === Infinity) return Infinity;
    // Component-type tiers (2/3) and tag tier (4) rank below name tiers but
    // above a filter-only match.
    return tier;
  };
}

/**
 * Match a whole query: every term must match (AND); the returned tier is the
 * WORST term's tier, so a weaker partial match sorts below a strong one.
 * @param {import("./queryLang.js").Query} query
 * @returns {(candidate: Record<string, any>) => number}
 */
export function entityMatcher(query) {
  return entityTermsMatcher(query.terms);
}

/**
 * The same thing for a bare term list — what a SCOPE stage of a `>` query is.
 * `entityMatcher` is this function applied to the target stage; splitting them
 * is what lets `Mesh > light` evaluate its left half with the identical
 * semantics as its right.
 * @param {import("./queryLang.js").QueryTerm[]} terms
 * @returns {(candidate: Record<string, any>) => number}
 */
export function entityTermsMatcher(terms) {
  const matchers = terms.map(entityTermMatcher);
  return (candidate) => {
    let worst = 0;
    for (const matcher of matchers) {
      const tier = matcher(candidate);
      if (tier === Infinity) return Infinity;
      if (tier > worst) worst = tier;
    }
    return worst;
  };
}
