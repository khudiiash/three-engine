// @ts-check

/**
 * Quick Search (Ctrl+F) ranking.
 *
 * Extracted from QuickSearch.jsx because the gate — "does this item match at
 * all?" — is the part that goes wrong, and it is only checkable in isolation.
 *
 * TWO RULES, and the first one is the one that was broken:
 *
 * 1. **Match per FIELD, never across the join.** The old version glued title,
 *    subtitle and keywords into one haystack and searched that. Every entity's
 *    subtitle is the constant string "Entity · Hierarchy", so "hierarchy"
 *    matched all 291 entities in the scene and "entity" did too — and the
 *    compact fallback (which strips punctuation from both sides before a
 *    substring test) could match across the seam between a name and a path,
 *    pairing the tail of one field with the head of the next. Fields are
 *    matched separately here and category labels are not fields at all.
 *
 * 2. **An entity id is matched WHOLE or not at all.** Ids are random base-62
 *    (`3UNTA7-1PB`), so as a substring they answer to any two or three
 *    characters the user types. Pasting a whole id still finds its entity —
 *    that is the case worth keeping — but a partial never matches one.
 */

export function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Ordering nudge between kinds when scores are otherwise level. `recent` is
 *  the "Recent searches" row Quick Search prepends to an empty query — it never
 *  competes with a real result, so it sorts before every kind. */
export const TYPE_WEIGHT = { recent: -1, entity: 0, asset: 1, panel: 2, setting: 3 };

/** Shorter than this, a punctuation-stripped query is too generic to fall back
 *  on: "io" would compact-match half the project. */
const MIN_COMPACT = 3;

/**
 * One item the search can return.
 *
 * @param {object} spec
 * @param {string} spec.key        stable and UNIQUE — React renders the list by it
 * @param {"entity"|"asset"|"panel"|"setting"} spec.type
 * @param {string} spec.title
 * @param {string} [spec.subtitle] shown, never matched (it is a category label)
 * @param {string[]} [spec.terms]  extra matchable fields: tags, a path, a panel id
 * @param {string} [spec.exact]    matches only when the query IS this (entity ids)
 * @param {() => any} spec.activate
 */
export function makeItem({ key, type, title, subtitle, terms = [], exact, activate }) {
  return {
    key,
    type,
    title,
    subtitle,
    activate,
    exact: exact ? normalizeSearch(exact) : null,
    // Field 0 is the title and is scored higher; the rest are equals.
    fields: [normalizeSearch(title), ...terms.filter(Boolean).map(normalizeSearch)],
  };
}

/**
 * Where `q` matches inside one field, or null when it doesn't.
 * @returns {{ at: number, whole: boolean } | null}
 */
function matchField(field, q, tokens, compactQuery) {
  if (!field) return null;

  const phraseAt = field.indexOf(q);
  if (phraseAt >= 0) return { at: phraseAt, whole: field === q };

  // Every word present, in any order — so "graph shader" finds "Shader Graph".
  // Single-token queries are already covered by the phrase test above; running
  // this for them would just repeat it.
  if (tokens.length > 1) {
    const positions = tokens.map((token) => field.indexOf(token));
    if (positions.every((position) => position >= 0)) {
      return { at: Math.min(...positions), whole: false };
    }
  }

  // Punctuation-blind fallback, so "itchio" finds "itch.io" and "polyhaven"
  // finds "Poly Haven". Per field, so it can't straddle two of them.
  if (compactQuery.length >= MIN_COMPACT) {
    const compact = field.replace(/[^a-z0-9]/g, "");
    const at = compact.indexOf(compactQuery);
    if (at >= 0) return { at, whole: compact === compactQuery };
  }
  return null;
}

/**
 * Rank one item. Higher is better; **negative means no match at all** and the
 * caller must drop it — a result the user can see no connection to is worse
 * than no result.
 *
 * @param {ReturnType<makeItem>} item
 * @param {string} query
 */
export function score(item, query) {
  const q = normalizeSearch(query).trim();
  if (!q) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  const compactQuery = q.replace(/[^a-z0-9]/g, "");

  // A pasted entity id beats everything: it is unambiguous by construction.
  if (item.exact && item.exact === q) return 5000;

  const inTitle = matchField(item.fields[0], q, tokens, compactQuery);
  let best = inTitle;
  if (!best) {
    for (let i = 1; i < item.fields.length; i++) {
      const found = matchField(item.fields[i], q, tokens, compactQuery);
      if (found && (!best || found.at < best.at)) best = found;
    }
  }
  if (!best) return -1;

  // Every admitted match stays above zero: position only orders the list, it
  // must never push a real match back out of it.
  return 1000
    + (inTitle && inTitle.whole ? 1400 : 0)
    + (inTitle && inTitle.at === 0 ? 1000 : 0)
    + (inTitle ? 400 : 0)
    - Math.min(best.at, 400)
    - TYPE_WEIGHT[item.type];
}
