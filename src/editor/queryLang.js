// @ts-check
/**
 * The editor's search query language, in one place.
 *
 * A query is one or more whitespace-separated terms that AND together. Each
 * term is a name part optionally followed by `?`-introduced property filters:
 *
 *   Lamp                      — name contains "lamp" (today's behaviour)
 *   Lamp...                   — name STARTS WITH "lamp" (any ending)
 *   ...Box                    — name ENDS WITH "box"
 *   ...stand...               — explicit contains (same as plain substring)
 *   texture?width>1920        — assets of kind "texture" wider than 1920px
 *   Lamp?enabled=true&collider.shape=convex
 *                             — named Lamp, entity enabled, collider is convex
 *   material?roughness=0      — every material with roughness 0, whatever its name
 *   "red lamp"...?enabled=true — quoting protects spaces; `...` still applies
 *   mesh.castShadow=true      — a filter ALONE, with no name half and no `?`
 *   M...?cloth                — starts with M and HAS a cloth component
 *   Lamp?collider&!sound       — has a collider and no sound
 *   Mesh > light              — every light UNDERNEATH something named Mesh
 *   mesh.castShadow=true > light
 *                             — lights under any shadow-casting mesh
 *
 * The grammar is deliberately tiny: `?`, `...`, `&`, `!`, a standalone `>`,
 * the six comparison ops and double quotes are the only structural characters.
 * Anything that does not parse — a stray `?`, an unterminated quote, `width>`
 * with no value — degrades to a plain substring term of the raw text, so a
 * query typed before its filters are finished never blank-outs the panel, and
 * legacy queries that happen to contain `?` behave exactly as they always did.
 *
 * Three shorthands exist because the long forms are what people actually got
 * wrong:
 *
 *   A BARE FILTER needs no `?`. `collider.shape=convex` on its own is the
 *   filter, not a search for the literal text — but ONLY when the path is
 *   dotted or names a field the evaluators actually expose (see
 *   BARE_FILTER_FIELDS), so `a<b` stays the substring it always was.
 *
 *   A VALUELESS FILTER is an existence test. `?cloth` is "has a cloth
 *   component", `?!cloth` is "has none". It fires only when the part carries
 *   NO operator at all — `?width>` still has one, is still half-typed, and
 *   still degrades to text.
 *
 *   A STANDALONE `>` scopes: everything left of it selects a set of entities,
 *   everything right of it is matched only among their DESCENDANTS, and the
 *   result rows are the right-hand matches. It chains (`A > B > C`), and it
 *   must be its own whitespace-delimited token — `light.intensity>1` is a
 *   comparison, `Mesh > light` is a scope, and nothing has to guess which.
 *   Scoping is a HIERARCHY idea: the asset side ignores it and matches the
 *   last stage, because a flat file listing has no "inside".
 *
 * This module is PURE on purpose: no imports, no DOM, no Tauri. The parsers
 * behind three different search boxes (hierarchy, assets, Ctrl+F) share it,
 * and the node tests import it directly. Evaluation lives one layer up
 * (queryEvalEntity.js / queryEvalAsset.js) because "what is a width" is a
 * question about the pool being searched, not about the grammar.
 */

/** `...x` suffix match, `x...` prefix match, neither = substring, empty = no name constraint. @typedef {"substring"|"prefix"|"suffix"|"none"} NameMode */

/**
 * @typedef {{
 *   text: string,            // name text as typed, quotes resolved
 *   mode: NameMode,
 *   kind: string|null,       // ASSET kind word (texture, material, …) — asset-side only
 *   quoted: boolean,         // "..." wins: a quoted "texture" is a name, never a kind
 * }} QueryName
 *
 * @typedef {{
 *   path: string[],          // ["collider", "shape"] or ["width"]
 *   op: "="|"!="|">"|"<"|">="|"<="|"exists",
 *   value: string|number|boolean,   // for "exists": true = must be there
 *   raw: string,
 * }} QueryFilter
 *
 * @typedef {{
 *   raw: string,
 *   name: QueryName,
 *   filters: QueryFilter[],
 *   structured: boolean,     // has filters, `...`, quotes or a kind word
 *   valid: boolean,          // false ⇒ callers must treat the term as plain substring of `raw`
 * }} QueryTerm
 *
 * @typedef {{ raw: string, terms: QueryTerm[] }} QueryStage
 *
 * @typedef {{
 *   raw: string,
 *   stages: QueryStage[],    // split on standalone `>`; always at least one
 *   terms: QueryTerm[],      // the LAST stage's terms — what a result row is
 *   scopes: QueryStage[],    // every stage before it, outermost first
 *   structured: boolean,
 * }} Query
 */

/**
 * Kind words an asset search may use in place of a name. `texture?width>1920`
 * means "every texture" — the word selects a TYPE, not a title. The ids match
 * assetFilter.js's ASSET_TYPES; the ext→kind table that acts on them lives in
 * queryEvalAsset.js (assetFilter itself imports lucide icons and is therefore
 * not importable from the node tests — keep it that way).
 */
export const ASSET_KIND_WORDS = {
  texture: "texture", textures: "texture", tex: "texture", image: "texture", images: "texture",
  material: "material", materials: "material", mat: "material",
  model: "model", models: "model", glb: "model", gltf: "model", fbx: "model",
  mesh: "geometry", meshes: "geometry", geometry: "geometry", geom: "geometry",
  sky: "cubemap", skies: "cubemap", cubemap: "cubemap", hdri: "cubemap", environment: "cubemap",
  atlas: "atlas", atlases: "atlas", spritesheet: "atlas",
  prefab: "prefab", prefabs: "prefab",
  scene: "scene", scenes: "scene",
  script: "script", scripts: "script",
  animator: "animator", animation: "animator", animations: "animator",
  post: "post", postfx: "post",
  audio: "audio", sound: "audio", sounds: "audio", music: "audio",
  font: "font", fonts: "font",
  folder: "folder", folders: "folder",
};

/**
 * The scope separator. It is a WHOLE token, never a character scan: `>` is
 * also the greater-than operator, and `light.intensity>1` must stay a
 * comparison while `Mesh > light` is a scope. Requiring whitespace on both
 * sides is the entire disambiguation rule, and it is one a user can hold in
 * their head.
 */
export const SCOPE_TOKEN = ">";

/**
 * Single-word paths a BARE filter (one written with no `?`) may name.
 *
 * A dotted path is self-evidently a filter — nothing is called
 * `collider.shape=convex`. A single word is not: `a<b` has to stay the plain
 * substring it always was, or the back-compat guarantee is gone. So a bare
 * one-word filter is accepted only for the fields the two evaluators actually
 * expose. The list is duplicated knowledge, deliberately: the alternative is
 * this pure module importing the evaluators it exists underneath.
 */
const BARE_FILTER_FIELDS = new Set([
  // entity (queryEvalEntity.resolveEntityPath)
  "name", "tag", "tags", "enabled", "enabledingame", "childcount",
  // asset (queryEvalAsset.resolveAssetPath)
  "path", "ext", "size", "modified", "dir", "is_dir", "kind", "type",
  "width", "height", "roughness", "metalness", "color", "graph", "map",
]);

/** Characters that end a bare (unquoted) word. */
const BARE_BREAK = new Set([" ", "\t", "\n", '"']);

/**
 * Split on whitespace that is not inside double quotes: `red "big lamp"` is
 * two terms, the second containing a space.
 * @param {string} input
 * @returns {string[]}
 */
function splitTerms(input) {
  const terms = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && input[i - 1] !== "\\") inQuotes = !inQuotes;
    if (!inQuotes && (ch === " " || ch === "\t" || ch === "\n")) {
      if (current) terms.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) terms.push(current);
  return terms;
}

/**
 * Strip a leading/trailing `...` pair so they cannot be mistaken for both.
 * Quote-aware: the dots only count as the operator when they sit OUTSIDE the
 * quotes — `"Staging..."` is a name that ends in literal dots, `"Lamp"...`
 * is a prefix match on Lamp.
 */
function splitEllipsis(body) {
  let mode = /** @type {"substring"|"prefix"|"suffix"} */ ("substring");
  let dots = false;
  let rest = body;
  if (rest.startsWith("...")) {
    mode = "suffix";
    dots = true;
    rest = rest.slice(3);
  }
  if (rest.endsWith("...")) {
    const lastQuote = rest.lastIndexOf('"');
    // Any quote at or after the dots' start means the dots live inside a
    // quoted literal and are part of the name.
    if (lastQuote < 0 || lastQuote < rest.length - 3) {
      mode = mode === "suffix" ? "substring" : "prefix";
      dots = true;
      rest = rest.slice(0, -3);
    }
  }
  return { mode, body: rest, dots };
}

/**
 * Resolve quotes at the ENDS of a name part ("mid" quotes inside a name are
 * taken literally — they cannot be, since quotes also group spaces). Returns
 * null when a quote opens but never closes, which invalidates the term.
 * @returns {{ text: string, quoted: boolean } | null}
 */
function stripNameQuotes(body) {
  let quoted = false;
  let text = body;
  if (text.startsWith('"')) {
    quoted = true;
    const end = findClosingQuote(text, 1);
    if (end < 0) return null;
    text = text.slice(1, end);
  } else if (text.endsWith('"')) {
    // `"red lamp` degenerate forms fall through to invalid via findClosingQuote;
    // `lamp"` with no opener keeps the quote as a literal character.
    quoted = false;
  }
  text = unescapeQuotes(text);
  return { text, quoted };
}

/** Index of the closing quote for one opened at `start`, honouring `\"`. */
function findClosingQuote(text, start) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === '"') { i++; continue; }
    if (text[i] === '"') return i;
  }
  return -1;
}

function unescapeQuotes(text) {
  return text.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * Split `a&b&c` on ampersands that are not inside quotes.
 * @param {string} input
 * @returns {string[]}
 */
function splitFilters(input) {
  const parts = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' && input[i - 1] !== "\\") inQuotes = !inQuotes;
    if (ch === "&" && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** First comparison operator outside quotes, longest-match at its position. */
function findOp(filter) {
  let inQuotes = false;
  for (let i = 0; i < filter.length; i++) {
    const ch = filter[i];
    if (ch === '"' && filter[i - 1] !== "\\") inQuotes = !inQuotes;
    if (inQuotes) continue;
    const two = filter.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "!=") return { op: two, at: i };
    if (ch === ">" || ch === "<" || ch === "=") return { op: ch, at: i };
  }
  return null;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const IDENT_RE = /^[A-Za-z_$][\w$-]*(\.[\w$-]+)*$/;

/**
 * "1920" → 1920, "true" → true, "convex" → "convex". Quoted values are
 * resolved by the caller before reaching here and arrive as plain strings.
 * @param {string} token
 * @returns {string|number|boolean}
 */
export function coerceValue(token) {
  const raw = token.trim();
  if (NUMBER_RE.test(raw)) return Number(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

/**
 * @param {"="|"!="|">"|"<"|">="|"<="} op
 * @param {unknown} actual  value from the pool; null/undefined means "absent"
 * @param {string|number|boolean} wanted  parsed query value
 * @returns {boolean}  absent values NEVER match, not even `!=` — a lamp with
 *                    no collider has no shape to compare, so `collider.shape!=box`
 *                    is false for it.
 */
export function compareOp(op, actual, wanted) {
  if (actual === null || actual === undefined) return false;
  if (typeof wanted === "number") {
    const n = typeof actual === "number" ? actual : Number(actual);
    if (!Number.isFinite(n)) return false;
    return applyOp(op, n, wanted);
  }
  if (typeof wanted === "boolean") {
    if (typeof actual === "boolean") return applyOp(op, actual, wanted);
    return false;
  }
  // String comparisons are case-insensitive: `shape=convex` should not care
  // that the component serialises "Convex". Ordering over strings is not a
  // thing — say no rather than invent an alphabetical order nobody asked for.
  if (op === "=" || op === "!=") {
    const equal = String(actual).toLowerCase() === String(wanted).toLowerCase();
    return op === "=" ? equal : !equal;
  }
  return false;
}

function applyOp(op, a, b) {
  switch (op) {
    case "=": return a === b;
    case "!=": return a !== b;
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    default: return false;
  }
}

/**
 * Name-part matching. Everything is lowercased on both sides — consistent
 * with hierarchySearch.matchTier, which the structured path must agree with.
 * @param {string} name
 * @param {QueryName} namePart
 */
export function nameMatches(name, namePart) {
  if (namePart.mode === "none") return true;
  const text = namePart.text.toLowerCase();
  if (!text) return true;
  const n = (name ?? "").toLowerCase();
  if (namePart.mode === "prefix") return n.startsWith(text);
  if (namePart.mode === "suffix") return n.endsWith(text);
  return n.includes(text);
}

/**
 * True when nothing about the raw string uses the structured grammar — the
 * cheap gate the Assets panel takes before parsing at all.
 *
 * The bare-filter and scope forms carry no `?`/`&`/`...`, so a character scan
 * alone would call `collider.shape=convex` and `Mesh > light` plain and route
 * them to the legacy substring path. Both are settled on TOKENS, so the token
 * split runs here too — it is one pass over a search box's worth of text.
 */
export function isPlainString(input) {
  const s = String(input ?? "");
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") inQuotes = !inQuotes;
    if (inQuotes) continue;
    if (ch === "?" || ch === "&" || (ch === "." && s[i + 1] === "." && s[i + 2] === ".")) return false;
  }
  if (inQuotes) return false;
  const tokens = splitTerms(s);
  if (tokens.length > 1 && tokens.includes(SCOPE_TOKEN)) return false;
  return !tokens.some((token) => parseBareFilter(token));
}

/**
 * Parse one term. Invalid structured syntax degrades to a plain substring
 * term of the raw text — that is the back-compat guarantee: `foo?width>`
 * searches for things whose name contains "foo?width>", exactly as it did
 * before the language existed.
 * @param {string} raw
 * @returns {QueryTerm}
 */
function parseTerm(raw) {
  const plain = () => ({
    raw,
    name: { text: raw, mode: "substring", kind: null, quoted: false },
    filters: [],
    structured: false,
    valid: true,
  });

  const qAt = findUnquoted(raw, "?");
  if (qAt < 0) {
    // `mesh.castShadow=true` with no `?` in front of it. Tried BEFORE the name
    // parse, because the whole term is the filter — there is no name half to
    // find, and mode "none" is what makes it rank at FILTER_ONLY_TIER.
    const bare = parseBareFilter(raw);
    if (bare) {
      return {
        raw,
        name: { text: "", mode: /** @type {NameMode} */ ("none"), kind: null, quoted: false },
        filters: [bare],
        structured: true,
        valid: true,
      };
    }
  }
  const namePart = qAt >= 0 ? raw.slice(0, qAt) : raw;
  const filterPart = qAt >= 0 ? raw.slice(qAt + 1) : "";

  const { mode, body, dots } = splitEllipsis(namePart);
  const stripped = stripNameQuotes(body);
  if (!stripped) return plain(); // unterminated quote — not structured, just text
  const text = stripped.text;
  // A bare kind word ("texture", unquoted, no dots) selects by TYPE on the
  // asset side; the entity evaluator ignores it and matches the word as a
  // name like any other. A bare quoted term ("big lamp") is structured too —
  // its spaces must survive name matching, which only the structured
  // evaluators do.
  const kind = !stripped.quoted && !dots && mode === "substring" && ASSET_KIND_WORDS[text.toLowerCase()]
    ? ASSET_KIND_WORDS[text.toLowerCase()]
    : null;

  const structured = qAt >= 0 || mode !== "substring" || dots || stripped.quoted || kind !== null;
  if (!structured) return plain();

  /** @type {QueryFilter[]} */
  const filters = [];
  if (qAt >= 0) {
    for (const part of splitFilters(filterPart)) {
      const f = parseFilter(part);
      if (!f) return plain(); // malformed filter degrades the WHOLE term to text
      filters.push(f);
    }
  }

  return {
    raw,
    name: { text, mode: /** @type {NameMode} */ (text ? mode : "none"), kind, quoted: stripped.quoted },
    filters,
    structured: true,
    valid: true,
  };
}

function findUnquoted(text, ch) {
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== "\\") inQuotes = !inQuotes;
    if (c === ch && !inQuotes) return i;
  }
  return -1;
}

/**
 * `path=value` / `width>=1920` / `name="big lamp"` / `cloth` / `!cloth`.
 * Returns null for anything malformed — no path, no value, junk characters in
 * the path — which degrades the WHOLE term to plain text.
 */
function parseFilter(part) {
  const found = findOp(part);
  if (!found) {
    // No operator ANYWHERE in the part: this is an existence test. `?cloth` is
    // "has a cloth component", `?!cloth` its negation. Note the asymmetry with
    // `?width>`, which DOES carry an operator, is simply half-typed, and must
    // keep degrading to text rather than silently becoming "has a width".
    const body = part.trim();
    const negated = body.startsWith("!");
    const pathRaw = (negated ? body.slice(1) : body).trim();
    if (!pathRaw || !IDENT_RE.test(pathRaw)) return null;
    return { path: foldPath(pathRaw), op: /** @type {QueryFilter["op"]} */ ("exists"), value: !negated, raw: part };
  }
  const pathRaw = part.slice(0, found.at).trim();
  const valueRaw = part.slice(found.at + found.op.length).trim();
  if (!pathRaw || !valueRaw) return null;
  if (!IDENT_RE.test(pathRaw)) return null;
  let value;
  if (valueRaw.startsWith('"')) {
    const end = findClosingQuote(valueRaw, 1);
    if (end < 0) return null;
    value = unescapeQuotes(valueRaw.slice(1, end));
    if (valueRaw.slice(end + 1).trim()) return null; // trailing junk after the quote
  } else {
    value = coerceValue(valueRaw);
  }
  return {
    path: foldPath(pathRaw),
    op: /** @type {QueryFilter["op"]} */ (found.op),
    value,
    raw: part,
  };
}

/**
 * Component types are lowercase; prop keys are usually camelCase, so only the
 * FIRST segment is folded — the walk in the evaluator still falls back to a
 * case-insensitive key scan when an exact prop misses.
 * @param {string} pathRaw
 * @returns {string[]}
 */
function foldPath(pathRaw) {
  const parts = pathRaw.split(".");
  return [parts[0].toLowerCase(), ...parts.slice(1)];
}

/**
 * A term written as a filter with no `?` in front of it —
 * `mesh.castShadow=true`, `collider.shape=convex`, `enabled=false`. Returns
 * null when the text is not unambiguously a filter, which leaves it the plain
 * substring it has always been.
 * @param {string} raw
 * @returns {QueryFilter | null}
 */
function parseBareFilter(raw) {
  const found = findOp(raw);
  if (!found) return null; // a bare WORD is a name, not an existence test
  const pathRaw = raw.slice(0, found.at).trim();
  if (!pathRaw) return null;
  if (!pathRaw.includes(".") && !BARE_FILTER_FIELDS.has(pathRaw.toLowerCase())) return null;
  return parseFilter(raw);
}

const parseMemo =
  /** @type {Map<string, Query>} */ (new Map());
const PARSE_MEMO_MAX = 256;

/**
 * Parse a search box string. Memoized per raw string — every keystroke in
 * every panel re-parses the same in-progress queries, and the memo keeps the
 * per-keystroke cost at a Map hit.
 * @param {string} input
 * @returns {Query}
 */
export function parseQuery(input) {
  const raw = String(input ?? "");
  const hit = parseMemo.get(raw);
  if (hit) return hit;

  // Stages, split on standalone `>`. An EMPTY stage is dropped rather than
  // treated as "match everything": halfway through typing `Mesh > light` the
  // box holds `Mesh >`, and a stage of no terms there would empty the panel
  // for a keystroke and then refill it.
  /** @type {string[][]} */
  const tokenStages = [[]];
  let sawScope = false;
  for (const token of splitTerms(raw)) {
    if (token === SCOPE_TOKEN) {
      sawScope = true;
      tokenStages.push([]);
    } else {
      tokenStages[tokenStages.length - 1].push(token);
    }
  }
  const kept = tokenStages.filter((tokens) => tokens.length);
  /** @type {QueryStage[]} */
  const stages = kept.map((tokens) => ({
    // With no `>` anywhere the stage raw is the query VERBATIM, because a plain
    // stage is matched as one substring and "red  lamp" with two spaces must
    // not silently become "red lamp". The moment a `>` appears the raw is
    // rebuilt from the tokens instead — `Rig >` drops a token, and a stage that
    // kept the whole string would then look for the literal text "Rig >".
    raw: sawScope ? tokens.join(" ") : raw,
    terms: tokens.map(parseTerm),
  }));
  if (!stages.length) stages.push({ raw, terms: [] });

  const terms = stages[stages.length - 1].terms;
  const scopes = stages.slice(0, -1);
  /** @type {Query} */
  const query = {
    raw,
    stages,
    terms,
    scopes,
    // A scope is structured whatever its stages hold: the legacy path is one
    // substring over a flat list and has nowhere to put "inside".
    structured: scopes.length > 0 || stages.some((stage) => stage.terms.some((t) => t.structured)),
  };
  if (parseMemo.size >= PARSE_MEMO_MAX) parseMemo.clear();
  parseMemo.set(raw, query);
  return query;
}

/**
 * True when a stage holds nothing but legacy substring terms, so it should be
 * matched as ONE substring of its raw text rather than as ANDed terms — the
 * back-compat rule ("red lamp" is not "red" AND "lamp"), which has to hold
 * inside a scope stage as much as at the top level.
 * @param {QueryStage} stage
 */
export function isPlainStage(stage) {
  return !stage.terms.some((term) => term.structured);
}

/** @param {Query} query */
export function isPlainQuery(query) {
  return !query.structured;
}
