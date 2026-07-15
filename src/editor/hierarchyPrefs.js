/**
 * Per-scene hierarchy preferences — the editor-only collapse state the user
 * has chosen for each scene. Lives in localStorage so it survives editor
 * restarts; the keys are versioned (`.v1`) so a future schema change can be
 * migrated without colliding with stale data.
 *
 * Stored shape:
 *   { version: 1, scenes: { [sceneKey]: string[] } }
 *
 * `sceneKey` is whatever the panel passes — by default the scene's
 * `sceneName`, which is stable across save/load (engine entities keep their
 * IDs through `deserializeScene`). If a key doesn't exist yet, the panel
 * starts the scene fully collapsed (matching the user's stated default).
 *
 * Persistence is best-effort: localStorage may be unavailable (private mode,
 * quota exceeded), so every call is wrapped in try/catch and silently no-ops
 * on failure — the in-memory state still works, it just won't survive a
 * reload.
 */

const STORAGE_KEY = "engine.hierarchy.collapsed.v1";

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, scenes: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: 1, scenes: {} };
    if (!parsed.scenes || typeof parsed.scenes !== "object") parsed.scenes = {};
    return parsed;
  } catch {
    return { version: 1, scenes: {} };
  }
}

function saveAll(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage may throw on quota / disabled storage — collapse state
    // is editor-only UX, so silently drop the write.
  }
}

/** Returns the collapsed-id set saved for `sceneKey`, or null if the scene
 *  has no saved state yet (in which case the panel falls back to its
 *  default: fully collapsed). */
export function loadCollapsed(sceneKey) {
  if (!sceneKey) return null;
  const data = loadAll();
  const arr = data.scenes[sceneKey];
  if (!Array.isArray(arr)) return null;
  return new Set(arr);
}

/** Persists the collapsed-id set for `sceneKey`. Empty set is still saved —
 *  that's a meaningful state ("user has uncollapsed everything they care
 *  about"). */
export function saveCollapsed(sceneKey, ids) {
  if (!sceneKey) return;
  const data = loadAll();
  data.scenes[sceneKey] = [...ids];
  saveAll(data);
}

/** Drops any saved state for a scene. Used when a scene is deleted or when
 *  the saved entity-id set no longer matches the current scene (so we don't
 *  keep dead IDs around forever). */
export function forgetCollapsed(sceneKey) {
  if (!sceneKey) return;
  const data = loadAll();
  if (sceneKey in data.scenes) {
    delete data.scenes[sceneKey];
    saveAll(data);
  }
}