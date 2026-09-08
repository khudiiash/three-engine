/**
 * The Assets list's order: a column and a direction, chosen by clicking a
 * header cell and kept across sessions.
 *
 * Folders always come first (Explorer's rule); within each half the column
 * decides, and the name breaks ties so equal sizes or dates stay in a stable,
 * readable order. Names compare numerically ("Mesh_2" before "Mesh_10") and
 * case-insensitively. The same order feeds the tile views, so switching
 * views never reshuffles the assets.
 *
 * Pure: no React, no DOM beyond `localStorage`, so `tests/asset-sort.test.mjs`
 * can exercise it under `node --test`.
 */

export const SORT_KEY = "engine.assets.sort.v1";
export const SORT_COLUMNS = ["name", "type", "size", "modified"];
export const DEFAULT_SORT = Object.freeze({ by: "name", dir: 1 });

/** The saved order, or the default when nothing valid is saved. */
export function readSort(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(SORT_KEY));
    if (saved && SORT_COLUMNS.includes(saved.by) && (saved.dir === 1 || saved.dir === -1)) {
      return { by: saved.by, dir: saved.dir };
    }
  } catch {
    /* a fresh install has no saved order */
  }
  return { ...DEFAULT_SORT };
}

/**
 * The order after clicking `by`: the same column flips; a new one starts
 * ascending, except dates, where "newest first" is the order people come for.
 */
export function nextSort(prev, by) {
  if (!SORT_COLUMNS.includes(by)) return prev;
  if (prev?.by === by) return { by, dir: -(prev.dir || 1) };
  return { by, dir: by === "modified" ? -1 : 1 };
}

export function writeSort(sort, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SORT_KEY, JSON.stringify(sort));
  } catch {
    /* storage full or blocked: the order still applies this session */
  }
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const toTime = (v) => (typeof v === "number" ? v : Date.parse(v) || 0);
const toSize = (v) => Number(v) || 0;

/**
 * `list` sorted by `sort`. `typeOf(entry)` names a file's type (the label the
 * list shows); `sizeOf(entry)` is its size in bytes — a folder's is the sum
 * of its contents, which the caller knows and the entry does not. Folders
 * sort among themselves by the same column, and always come first.
 */
export function sortEntries(list, sort = DEFAULT_SORT, typeOf = (e) => e.ext ?? "", sizeOf = (e) => e.size) {
  if (!Array.isArray(list) || list.length < 2) return list;
  const { by, dir = 1 } = sort ?? DEFAULT_SORT;
  const byName = (a, b) => nameCollator.compare(String(a.name ?? ""), String(b.name ?? ""));
  const cmp =
    by === "type"
      ? (a, b) => nameCollator.compare(String(typeOf(a) ?? ""), String(typeOf(b) ?? "")) || byName(a, b)
      : by === "size"
        ? (a, b) => toSize(sizeOf(a)) - toSize(sizeOf(b)) || byName(a, b)
        : by === "modified"
          ? (a, b) => toTime(a.modified) - toTime(b.modified) || byName(a, b)
          : byName;
  return [...list].sort((a, b) => {
    if (!!a.is_dir !== !!b.is_dir) return a.is_dir ? -1 : 1;
    return cmp(a, b) * dir;
  });
}
