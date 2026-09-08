import { useProjectStore } from "./store/projectStore.js";
import { toBlobUrl, writeBinaryFile } from "./assetLoader.js";
import { invalidateThumb } from "./assetThumbs.js";

/**
 * Scene previews: a small picture of the viewport, taken when the scene is
 * saved and kept in the project's derived cache (`Library/thumbs/scenes/`),
 * so a scene shows up as a picture wherever assets do — the Assets grid, a
 * scene field's card, the scene switcher — instead of a layers glyph.
 *
 * Saving is the moment: the view is exactly what the user was looking at, no
 * offscreen engine needs building, and a scene that was never saved with this
 * code simply has no picture yet (its glyph stays until the next save).
 * Autosave runs every few seconds, so captures are throttled per scene.
 */

const THUMB_W = 320;
const THUMB_H = 200;
const MIN_INTERVAL_MS = 20_000;
const lastCapture = new Map(); // normalised scene path → performance.now()

const norm = (p) => String(p ?? "").replaceAll("\\", "/");

/** A short stable hash of the path, so two "main.scene" in different folders differ. */
function hashPath(path) {
  let h = 0x811c9dc5;
  const s = norm(path).toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Where a scene's picture lives, or null outside a project. */
export function sceneThumbPath(scenePath, rootPath = useProjectStore.getState().rootPath) {
  if (!rootPath || !scenePath) return null;
  const base = norm(scenePath).split("/").pop().replace(/\.[^.]+$/, "");
  return `${norm(rootPath)}/Library/thumbs/scenes/${base}-${hashPath(scenePath)}.png`;
}

/** The saved picture as a blob URL, or null when there is none yet. */
export async function readSceneThumb(scenePath) {
  const path = sceneThumbPath(scenePath);
  if (!path) return null;
  return toBlobUrl(path).catch(() => null);
}

/**
 * Renders the viewport at thumbnail size and writes the picture. Silent on
 * every failure — a save must never fail because its preview did.
 */
export async function captureSceneThumb(scenePath, { force = false } = {}) {
  const dest = sceneThumbPath(scenePath);
  if (!dest) return false;
  const key = norm(scenePath).toLowerCase();
  const now = performance.now();
  if (!force && now - (lastCapture.get(key) ?? -Infinity) < MIN_INTERVAL_MS) return false;
  lastCapture.set(key, now);
  try {
    const [{ captureViewportFrame }, { getViewportHandle }] = await Promise.all([
      import("./api/ops/viewport.js"),
      import("./viewportHandle.js"),
    ]);
    const camera = getViewportHandle()?.camera;
    if (!camera) return false;
    const dataUrl = await captureViewportFrame({ width: THUMB_W, height: THUMB_H, camera, includeGizmos: false });
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return false;
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("create_dir", { path: dest.slice(0, dest.lastIndexOf("/")) }).catch(() => {});
    await writeBinaryFile(dest, bytes);
    invalidateThumb("scene", scenePath);
    return true;
  } catch (err) {
    console.warn(`Scene preview failed: ${err?.message ?? err}`);
    return false;
  }
}
