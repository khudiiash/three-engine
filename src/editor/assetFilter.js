/**
 * Search + type filter for the Assets panel.
 *
 * The search box takes the shared query language (queryLang.js) on top of the
 * plain substrings it always took. Whitespace-separated terms AND together;
 * a term may select a kind and constrain a property:
 *
 *   texture?width>1920       every texture wider than 1920px
 *   material?roughness=0     every material with roughness 0
 *   ..._diffuse              names ending in _diffuse
 *   wall...                  names starting with wall
 *   ?size>1000               anything over a thousand bytes, any name
 *   tag:wall  ?tag=wall      tagged wall (legacy form / grammar form)
 *   texture png              kind texture AND name containing "png"
 *
 * The pixel sizes and material scalars those filters need are not in the
 * directory listing — assetMetaIndex.js warms them for the pool being
 * searched, and until it has, meta-dependent filters match nothing instead of
 * throwing. Plain strings (`rock`) never touch any of that: they keep the
 * exact substring/tag behaviour they always had.
 */

import {
  Aperture,
  Boxes,
  Grid3x3,
  FileCode2,
  Files,
  Folder,
  Globe,
  Image,
  Layers,
  Package,
  Palette,
  Shapes,
  Type,
  Volume2,
  Workflow,
} from "./icons/index.jsx";
import {
  MODEL_IMPORT_EXTENSIONS,
  TEXTURE_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  MATERIAL_EXTENSIONS,
  ENVIRONMENT_EXTENSIONS,
  PREFAB_EXTENSIONS,
  ANIMATOR_EXTENSIONS,
  POST_EXTENSIONS,
  VFX_EXTENSIONS,
  GEOMETRY_EXTENSIONS,
  ATLAS_EXTENSIONS,
  AUDIO_EXTENSIONS,
  FONT_EXTENSIONS,
} from "./assetLoader.js";
import { isPlainString, parseQuery as parseLangQuery } from "./queryLang.js";
import { assetMatcher } from "./queryEvalAsset.js";

/**
 * assetFlags sits behind the panel's own import graph (assetOps →
 * ConfirmDialog.jsx and friends), which node cannot evaluate — so it is
 * reached lazily rather than statically. That keeps THIS module importable
 * from tests/asset-meta-index.test.mjs, which pins the legacy search
 * behaviour. In the browser the promise resolves long before the user can
 * type; until it does, tags read as empty, which is exactly what an unloaded
 * flags store reads as anyway.
 * @type {{ getAssetFlags: (path: string) => { tags?: string[] } } | null}
 */
let assetFlagsModule = null;
import("./assetFlags.js").then((module) => { assetFlagsModule = module; }, () => {});

/** The tags a `tag:` term matches against — the asset's `.meta` sidecar. */
const tagsOf = (entry) => (assetFlagsModule ? assetFlagsModule.getAssetFlags(entry.path).tags ?? [] : []);

/**
 * Type filter for the Assets panel. Extension lists are pulled from
 * assetLoader so a new format registered there shows up in the filter without
 * a second place to update.
 */
export const ASSET_TYPES = [
  { id: "all", label: "All", Icon: Files, exts: null },
  { id: "folder", label: "Folders", Icon: Folder, exts: [], dirs: true },
  { id: "model", label: "Models", Icon: Boxes, exts: MODEL_IMPORT_EXTENSIONS },
  { id: "texture", label: "Textures", Icon: Image, exts: TEXTURE_EXTENSIONS },
  { id: "material", label: "Materials", Icon: Palette, exts: MATERIAL_EXTENSIONS },
  // Both shapes of a sky under one filter — a cube map and an HDRI are the same
  // thing to anyone looking for one. See src/engine/environmentAsset.js.
  { id: "cubemap", label: "Skies", Icon: Globe, exts: ENVIRONMENT_EXTENSIONS },
  { id: "geometry", label: "Geometry", Icon: Shapes, exts: GEOMETRY_EXTENSIONS },
  { id: "atlas", label: "Sprite Atlases", Icon: Grid3x3, exts: ATLAS_EXTENSIONS },
  { id: "prefab", label: "Prefabs", Icon: Package, exts: PREFAB_EXTENSIONS },
  { id: "scene", label: "Scenes", Icon: Layers, exts: ["scene"] },
  { id: "script", label: "Scripts", Icon: FileCode2, exts: SCRIPT_EXTENSIONS },
  { id: "animator", label: "Animators", Icon: Workflow, exts: ANIMATOR_EXTENSIONS },
  { id: "vfx", label: "Simulation Graphs", Icon: Workflow, exts: VFX_EXTENSIONS },
  { id: "post", label: "Post Process", Icon: Aperture, exts: POST_EXTENSIONS },
  { id: "audio", label: "Audio", Icon: Volume2, exts: AUDIO_EXTENSIONS },
  { id: "font", label: "Fonts", Icon: Type, exts: FONT_EXTENSIONS },
];

export const assetType = (id) => ASSET_TYPES.find((type) => type.id === id) ?? ASSET_TYPES[0];

function matchesType(entry, typeId) {
  if (typeId === "all") return true;
  const type = assetType(typeId);
  if (entry.is_dir) return !!type.dirs;
  return type.exts?.includes(entry.ext) ?? false;
}

/**
 * Parses the search box into name terms and `tag:` terms. Both kinds AND
 * together, so "rock tag:cliff" means "named rock AND tagged cliff" — the
 * narrowing most people expect from a search box that accepts qualifiers.
 *
 * Legacy strings stay on this path untouched. Anything that uses the
 * structured grammar instead comes back as `query`, and matching hands the
 * term list to queryEvalAsset.assetMatcher.
 *
 *   texture?width>1920   — every texture wider than 1920px, whatever its name
 *   material?roughness=0 — every material with roughness 0
 *
 * @returns {{ names: string[], tags: string[], empty: boolean,
 *             query: import("./queryLang.js").Query | null }}
 *   `query` is null unless the raw string actually uses the grammar
 *   (`?`, `...`, quotes) — a plain `rock` must keep behaving exactly as it
 *   always did, down to which entry objects come back.
 */
export function parseQuery(query) {
  const raw = String(query ?? "");
  const terms = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tags = [];
  const names = [];
  for (const term of terms) {
    if (term.startsWith("tag:")) {
      const tag = term.slice(4);
      if (tag) tags.push(tag);
    } else names.push(term);
  }
  const structured = !isPlainString(raw);
  return {
    names,
    tags,
    empty: !names.length && !tags.length,
    query: structured ? parseLangQuery(raw) : null,
  };
}

/**
 * One entry against one parsed query. The plain path is the original
 * substring/tag logic, unchanged. The structured path is a per-term
 * evaluation: a term with a kind word (`texture`) selects by TYPE and ignores
 * the name entirely, a plain term matches the name, and the terms AND
 * together — so `texture?width>1920 rock` is "wide textures named rock".
 *
 * @param {*} entry
 * @param {ReturnType<typeof parseQuery>} parsed
 * @param {(path: string) => null | { width?: number, height?: number, material?: object, atlasSize?: number[] }} getMeta
 *        meta for `entry.path`, or null when it has not been probed (or the
 *        editor runs without Tauri) — meta-dependent filters then just fail
 * @param {(entry: any) => string[]} getTags
 */
function matchesQuery(entry, parsed, getMeta, getTags) {
  if (!parsed.query) {
    if (parsed.empty) return true;
    const name = entry.name.toLowerCase();
    if (!parsed.names.every((term) => name.includes(term))) return false;
    if (!parsed.tags.length) return true;
    const tags = tagsOf(entry).map((tag) => tag.toLowerCase());
    return parsed.tags.every((term) => tags.some((tag) => tag.includes(term)));
  }
  return assetMatcher(parsed.query, { getMeta, getTags })(entry);
}

/**
 * Applies the panel's filters in sequence. `usedPaths` is null when the
 * "used by selection" filter is off; when on it's a Set of normalised paths,
 * and folders are kept only if something inside them is used — otherwise the
 * result is a flat list with no way to navigate to what it found.
 *
 * `getMeta` is what lets structured filters see past the directory listing
 * (assetMetaIndex.js in the editor); it defaults to "nothing probed", which
 * turns every meta-dependent predicate false but leaves name, size, ext, kind
 * and tag matching working — so a picker that never warms the index still
 * answers `texture?width>1920` with nothing rather than lying, and still
 * answers `rock` correctly.
 */
export function filterEntries(
  entries,
  { typeId = "all", query = "", usedPaths = null, getMeta = () => null, getTags = tagsOf } = {},
) {
  const parsed = parseQuery(query);
  const norm = (p) => String(p ?? "").replaceAll("\\", "/").toLowerCase();
  const usedPrefixes = usedPaths ? [...usedPaths] : null;
  return entries.filter((entry) => {
    if (usedPaths) {
      const path = norm(entry.path);
      const hit = entry.is_dir
        ? usedPrefixes.some((used) => used.startsWith(`${path}/`))
        : usedPaths.has(path);
      if (!hit) return false;
    }
    // The type chip and a term's kind word both constrain the kind; they AND,
    // so `typeId=material` narrows `texture?width>1920` to nothing rather than
    // overriding it.
    if (!matchesType(entry, typeId)) return false;
    return matchesQuery(entry, parsed, getMeta, getTags);
  });
}
