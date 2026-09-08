/**
 * Folder sizes for the Assets list: a folder's size is the sum of every file
 * under it, however deep.
 *
 * One native walk per folder shown (`list_dir_recursive`, the same call the
 * asset search uses — the IPC round trip per directory is what made walking
 * from JS slow, not the filesystem), then every file's size is added to each
 * of its ancestors in one pass. A folder's total is then a lookup, for the
 * folders in the listing and for any folder a search surfaces below it.
 *
 * Cached per folder and invalidated by the project store's change counter,
 * which the file watcher bumps; the walk runs again only after something on
 * disk changed. The accumulation is pure (`accumulateFolderSizes`) so
 * `tests/folder-sizes.test.mjs` can exercise it under `node --test`.
 */

const WALK_DEPTH = 64;

/** Forward slashes, no trailing slash; case-folded on drive-letter paths. */
export function normalizeFolderPath(path) {
  let p = String(path ?? "").replace(/\\/g, "/");
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return /^[a-z]:\//i.test(p) ? p.toLowerCase() : p;
}

/**
 * `Map<normalised folder path, bytes>` for `root` and every folder below it,
 * from the flat recursive listing of `root` (files carry `size`; directory
 * entries carry nothing and are skipped — their totals come from their files).
 */
export function accumulateFolderSizes(entries, root) {
  const rootPath = normalizeFolderPath(root);
  const totals = new Map();
  totals.set(rootPath, 0);
  for (const entry of entries ?? []) {
    if (entry?.is_dir) continue;
    const size = Number(entry?.size) || 0;
    let p = normalizeFolderPath(entry?.path);
    if (!p.startsWith(rootPath + "/")) continue;
    for (;;) {
      const cut = p.lastIndexOf("/");
      if (cut < 0) break;
      p = p.slice(0, cut);
      if (p.length < rootPath.length) break;
      totals.set(p, (totals.get(p) ?? 0) + size);
      if (p.length === rootPath.length) break;
    }
  }
  return totals;
}

/** The folder's total from a `Map` built above, or `undefined` if unknown. */
export function folderSizeOf(totals, path) {
  return totals?.get(normalizeFolderPath(path));
}

const cache = new Map(); // normalised root → { token, promise }

/**
 * The totals for `root` and everything under it. `token` is the project
 * store's change counter: a different token measures again, the same token
 * answers from the cache (including an in-flight measurement).
 *
 * `folders` are the folders the list shows; one the walk left out (the walker
 * skips `engine-types` whole — editor-scaffolded declarations, never assets)
 * is measured on its own so the list still shows a size for it.
 */
export function measureFolderSizes(root, token = 0, folders = []) {
  const key = `${normalizeFolderPath(root)}|${folders.length}`;
  const hit = cache.get(key);
  if (hit && hit.token === token) return hit.promise;
  const promise = (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const totals = new Map();
    // One native call, one number per folder, off the main thread
    // (`dir_sizes` in lib.rs). The first cut listed every file under the open
    // folder and summed in JS: a root with a `.git` of thousands of objects
    // took the better part of a second — on Tauri's main thread, ahead of the
    // listing for the folder the user had just clicked.
    try {
      const sizes = await invoke("dir_sizes", { paths: folders });
      folders.forEach((folder, i) => totals.set(normalizeFolderPath(folder), Number(sizes[i]) || 0));
      return totals;
    } catch {
      // An older binary without `dir_sizes`: walk the listing instead.
    }
    const walk = async (path) =>
      accumulateFolderSizes(await invoke("list_dir_recursive", { path, depth: WALK_DEPTH, exts: null }), path);
    for (const [path, bytes] of await walk(root)) totals.set(path, bytes);
    for (const folder of folders) {
      if (folderSizeOf(totals, folder) !== undefined) continue;
      try {
        for (const [path, bytes] of await walk(folder)) totals.set(path, bytes);
      } catch {
        /* unreadable: its size stays unknown */
      }
    }
    return totals;
  })();
  cache.set(key, { token, promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}
