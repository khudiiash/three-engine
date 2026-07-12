import { normalizePath } from "./format.js";

/**
 * Process-wide catalog of prefab defs, keyed by guid.
 *
 * A module singleton (like `assetResolver`) rather than engine state, because
 * `serializeEntity` / `instantiateEntity` are free functions and need to reach
 * prefab data synchronously. Both hosts fill it before touching a scene:
 *
 *   - the editor scans the project for `.prefab` files on project open and
 *     re-registers a def whenever one is saved (see editor/prefab.js);
 *   - the player reads the `prefabs` array embedded in the exported scene.json.
 *
 * Guid is authoritative; `path` is a hint used to relink an instance whose
 * prefab was recreated, and to write the (human-readable) path back into
 * scene files.
 */
class PrefabRegistry {
  constructor() {
    this.defs = new Map(); // guid -> def
    this.paths = new Map(); // guid -> source path (as given)
    this.byPath = new Map(); // normalized path -> guid
    // Bumped on every mutation. The editor subscribes to it to know when to
    // re-expand live instances; `resolve()` uses it to invalidate its cache.
    this.version = 0;
    this._resolved = new Map(); // guid -> resolved tree (cleared on bump)
  }

  register(def, path = null) {
    if (!def?.guid) throw new Error("Prefab def has no guid");
    this.defs.set(def.guid, def);
    if (path) {
      // Drop a stale path->guid entry if this file previously held another guid.
      const key = normalizePath(path);
      const previous = this.byPath.get(key);
      if (previous && previous !== def.guid) this.paths.delete(previous);
      this.paths.set(def.guid, path);
      this.byPath.set(key, def.guid);
    }
    this.#bump();
    return def.guid;
  }

  unregister(guid) {
    const path = this.paths.get(guid);
    if (path) this.byPath.delete(normalizePath(path));
    this.paths.delete(guid);
    this.defs.delete(guid);
    this.#bump();
  }

  clear() {
    this.defs.clear();
    this.paths.clear();
    this.byPath.clear();
    this.#bump();
  }

  #bump() {
    this.version++;
    this._resolved.clear();
  }

  /** Invalidate the resolve cache without changing any def (used after an
   *  in-place def mutation, e.g. Apply writing into a nested instance node). */
  touch() {
    this.#bump();
  }

  getDef(guid) {
    return this.defs.get(guid) ?? null;
  }

  pathOf(guid) {
    return this.paths.get(guid) ?? null;
  }

  guidForPath(path) {
    return this.byPath.get(normalizePath(path)) ?? null;
  }

  /** Resolves a link `{ guid, path }` to a guid, falling back to the path when
   *  the guid is unknown (the prefab was deleted and recreated, or the scene
   *  predates the guid). Returns null when neither resolves. */
  resolveLink(link) {
    if (!link) return null;
    if (link.guid && this.defs.has(link.guid)) return link.guid;
    if (link.path) return this.guidForPath(link.path);
    return null;
  }

  /** Every registered def (for export bundling / asset pickers). */
  all() {
    return [...this.defs.values()];
  }

  has(guid) {
    return this.defs.has(guid);
  }
}

export const prefabRegistry = new PrefabRegistry();

/** Loads defs into the registry from an exported scene's `prefabs` array. */
export function registerPrefabDefs(defs = []) {
  for (const def of defs) {
    if (def?.guid) prefabRegistry.register(def, def.path ?? null);
  }
}
