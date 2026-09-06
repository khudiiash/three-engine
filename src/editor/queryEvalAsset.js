// @ts-check
/**
 * Asset-side evaluation of the query language (queryLang.js).
 *
 * Entries are the plain `{ name, path, ext, is_dir, size, modified }` records
 * `listProjectEntries` produces. Property filters need MORE than that record
 * carries — a texture's pixel size exists nowhere on disk metadata, a
 * material's roughness only in its `.mat` JSON — so the caller injects a
 * `getMeta(path)` accessor (assetMetaIndex.js in the editor; a plain Map in
 * the node tests). When `getMeta` returns null — meta not probed yet, or the
 * editor running without Tauri — every meta-dependent predicate is simply
 * false, and the UI refills results as batches land.
 *
 * Kind words come from this module because assetFilter.js imports lucide
 * icons and must stay browser-only; the ids are the same strings as its
 * ASSET_TYPES. If a kind is ever added there, add its extensions here too.
 */

import {
  MODEL_IMPORT_EXTENSIONS,
  TEXTURE_EXTENSIONS,
  MATERIAL_EXTENSIONS,
  ENVIRONMENT_EXTENSIONS,
  GEOMETRY_EXTENSIONS,
  ATLAS_EXTENSIONS,
  PREFAB_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  ANIMATOR_EXTENSIONS,
  POST_EXTENSIONS,
  AUDIO_EXTENSIONS,
  FONT_EXTENSIONS,
} from "./assetLoader.js";
import { compareOp, nameMatches } from "./queryLang.js";

/** ext (lowercase, no dot) → ASSET kind id. */
const KIND_BY_EXT = /** @type {Map<string, string>} */ (new Map());
for (const [id, exts] of /** @type {const} */ ([
  ["model", MODEL_IMPORT_EXTENSIONS],
  ["texture", TEXTURE_EXTENSIONS],
  ["material", MATERIAL_EXTENSIONS],
  ["cubemap", ENVIRONMENT_EXTENSIONS],
  ["geometry", GEOMETRY_EXTENSIONS],
  ["atlas", ATLAS_EXTENSIONS],
  ["prefab", PREFAB_EXTENSIONS],
  ["script", SCRIPT_EXTENSIONS],
  ["animator", ANIMATOR_EXTENSIONS],
  ["post", POST_EXTENSIONS],
  ["audio", AUDIO_EXTENSIONS],
  ["font", FONT_EXTENSIONS],
  ["scene", ["scene"]],
])) {
  for (const ext of exts) KIND_BY_EXT.set(String(ext).toLowerCase(), id);
}

/**
 * The ASSET kind id of an entry, or null for unclassified files.
 * @param {{ ext?: string, is_dir?: boolean }} entry
 */
export function assetKindOf(entry) {
  if (entry.is_dir) return "folder";
  return KIND_BY_EXT.get(String(entry.ext ?? "").toLowerCase()) ?? null;
}

/**
 * @typedef {{
 *   getMeta?: (path: string) => null | {
 *     width?: number, height?: number,
 *     material?: { roughness?: number, metalness?: number, color?: string, graph?: boolean, map?: string },
 *   },
 *   getTags?: (entry: any) => string[],
 * }} AssetEvalOptions
 */

/**
 * Resolve a dotted filter path against an entry + its meta.
 * @returns {{ found: boolean, value?: unknown }}
 */
export function resolveAssetPath(entry, meta, path) {
  const head = path[0];
  if (head === "name") return { found: true, value: entry.name };
  if (head === "path") return { found: true, value: entry.path };
  if (head === "ext") return { found: true, value: entry.ext };
  if (head === "size") return entry.size === undefined ? { found: false } : { found: true, value: entry.size };
  if (head === "modified") return entry.modified === undefined ? { found: false } : { found: true, value: entry.modified };
  if (head === "dir" || head === "is_dir") return { found: true, value: !!entry.is_dir };
  if (head === "kind" || head === "type") {
    const kind = assetKindOf(entry);
    return kind === null ? { found: false } : { found: true, value: kind };
  }
  if (head === "tag" || head === "tags") return { found: true, value: meta?.tags ?? [] };
  if (!meta) return { found: false };
  if (head === "width") {
    const w = meta.width ?? meta.atlasSize?.[0];
    return w === undefined ? { found: false } : { found: true, value: w };
  }
  if (head === "height") {
    const h = meta.height ?? meta.atlasSize?.[1];
    return h === undefined ? { found: false } : { found: true, value: h };
  }
  const material = meta.material;
  if (head === "roughness") return material?.roughness === undefined ? { found: false } : { found: true, value: material.roughness };
  if (head === "metalness") return material?.metalness === undefined ? { found: false } : { found: true, value: material.metalness };
  if (head === "color") return material?.color === undefined ? { found: false } : { found: true, value: material.color };
  // `graph=true` surfaces shader-graph materials, which expose NO comparable
  // scalars — without this they silently vanish from `roughness=0` results.
  if (head === "graph") return material ? { found: true, value: !!material.graph } : { found: false };
  if (head === "map") return material?.map === undefined ? { found: false } : { found: true, value: material.map };
  return { found: false };
}

/**
 * Which probes a query needs, so the warm-up only touches relevant files.
 *
 * Reads every STAGE, not just the target one: the asset side ignores scoping
 * when it matches, but a `>` query still has to warm what its terms ask about
 * — and a query whose only meta filter sits in a scope stage would otherwise
 * probe nothing and quietly answer "no matches".
 */
export function queryNeeds(query) {
  const needs = { dims: false, material: false };
  const terms = query.stages ? query.stages.flatMap((stage) => stage.terms) : query.terms;
  for (const term of terms) {
    for (const filter of term.filters) {
      const head = filter.path[0];
      if (head === "width" || head === "height") needs.dims = true;
      else if (head === "roughness" || head === "metalness" || head === "color" || head === "graph" || head === "map") {
        needs.material = true;
      }
    }
  }
  return needs;
}

function compareFilter(entry, meta, filter) {
  const { found, value } = resolveAssetPath(entry, meta, filter.path);
  // `?width` / `?!material` — no operator was typed, so the question is
  // whether the path resolves at all. On this side "resolves" is honest about
  // the lazy metadata: an unprobed texture answers `?width` with false, the
  // same way `?width>1920` answers false for it.
  if (filter.op === "exists") return found === filter.value;
  if (!found) return false;
  if (filter.path[0] === "tag" || filter.path[0] === "tags") {
    const tags = /** @type {string[]} */ (value).map((tag) => String(tag));
    // An UNTAGGED entry passes `tag!=x` (nothing in it is x) and fails `tag=x`.
    if (!tags.length) return filter.op === "!=";
    // `tag=rock` is "any tag is rock"; `tag!=rock` is "NO tag is rock" — a
    // some() over != would let any unrelated tag sneak the entry through.
    return filter.op === "!="
      ? tags.every((tag) => compareOp(filter.op, tag, filter.value))
      : tags.some((tag) => compareOp(filter.op, tag, filter.value));
  }
  return compareOp(filter.op, value, filter.value);
}

/**
 * @param {import("./queryLang.js").QueryTerm} term
 * @param {AssetEvalOptions} options
 */
export function assetTermMatcher(term, options = {}) {
  const legacy = !term.structured || !term.valid;
  return (entry, meta) => {
    if (legacy) return entry.name.toLowerCase().includes(term.raw.trim().toLowerCase());
    // A kind word REPLACES name matching on the asset side: `material` means
    // every material, not also an unlucky texture named "material_normal".
    if (term.name.kind) {
      const kind = assetKindOf(entry);
      if (kind !== term.name.kind) return false;
    } else if (!nameMatches(entry.name, term.name)) {
      return false;
    }
    for (const filter of term.filters) {
      if (!compareFilter(entry, meta, filter)) return false;
    }
    return true;
  };
}

/**
 * @param {import("./queryLang.js").Query} query
 * @param {AssetEvalOptions} options
 * @returns {(entry: any, meta?: any) => boolean}  meta may be omitted —
 * meta-dependent filters just fail (see module doc).
 */
export function assetMatcher(query, options = {}) {
  const getMeta = options.getMeta ?? (() => null);
  const getTags = options.getTags ?? (() => []);
  const matchers = query.terms.map((term) => assetTermMatcher(term, options));
  return (entry) => {
    const meta = { ...getMeta(entry.path), tags: getTags(entry) };
    return matchers.every((matcher) => matcher(entry, meta));
  };
}
