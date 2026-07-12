import { useProjectStore } from "./store/projectStore.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { syncScriptClassNameAfterRename } from "./scriptClassSync.js";

/**
 * Filesystem operations behind the Assets panel (create / rename / move /
 * delete). Kept out of the panel components so the grid and the folder tree
 * can share them without importing each other.
 */

export async function invoke(cmd, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** First "name", "name 1", "name 2"… not already taken in the folder. */
export function uniqueName(baseName, entries) {
  const names = new Set(entries.map((e) => e.name));
  if (!names.has(baseName)) return baseName;
  const dot = baseName.lastIndexOf(".");
  const stem = dot === -1 ? baseName : baseName.slice(0, dot);
  const ext = dot === -1 ? "" : baseName.slice(dot);
  for (let i = 1; ; i++) {
    const name = `${stem} ${i}${ext}`;
    if (!names.has(name)) return name;
  }
}

export async function createAssetFile(baseName, contents) {
  const { currentPath, entries, refresh } = useProjectStore.getState();
  if (!currentPath) return;
  const name = uniqueName(baseName, entries);
  await invoke("save_scene", { path: `${currentPath}/${name}`, contents });
  await refresh();
  console.log(`Created ${name}`);
}

export async function createFolder() {
  const { currentPath, entries, refresh } = useProjectStore.getState();
  if (!currentPath) return;
  const name = uniqueName("New Folder", entries);
  await invoke("create_dir", { path: `${currentPath}/${name}` });
  await refresh();
}

/**
 * Deletes one or more entries after a single confirmation. Each asset's
 * `.meta` sidecar goes with it.
 */
export async function deleteEntries(entries) {
  const list = entries.filter(Boolean);
  if (!list.length) return;
  const { confirm } = await import("@tauri-apps/plugin-dialog");
  const message =
    list.length === 1
      ? `Delete "${list[0].name}"${list[0].is_dir ? " and everything inside it" : ""}? This can't be undone.`
      : `Delete ${list.length} items? Folders are deleted with everything inside them. This can't be undone.`;
  const ok = await confirm(message, {
    title: list.length === 1 ? "Delete asset" : "Delete assets",
    kind: "warning",
  });
  if (!ok) return;

  const deleted = [];
  for (const entry of list) {
    try {
      await invoke("delete_path", { path: entry.path });
      await invoke("delete_path", { path: `${entry.path}.meta` }).catch(() => {});
      deleted.push(entry.path);
    } catch (err) {
      console.error(`Delete failed for ${entry.name}: ${err}`);
    }
  }
  if (!deleted.length) return;

  // Drop anything that just went away from the selection.
  const { assetPaths, assetPath, selectAssets, clear } = useSelectionStore.getState();
  const gone = new Set(deleted);
  const kept = assetPaths.filter((p) => !gone.has(p));
  if (kept.length) selectAssets(kept);
  else if (assetPath == null || gone.has(assetPath)) clear();

  await useProjectStore.getState().refresh();
  console.log(deleted.length === 1 ? `Deleted ${list[0].name}` : `Deleted ${deleted.length} assets`);
}

export async function renameEntry(entry, newName) {
  const name = newName.trim();
  if (!name || name === entry.name) return;
  const dir = entry.path.slice(0, entry.path.length - entry.name.length);
  const newPath = `${dir}${name}`;
  try {
    await invoke("rename_path", { from: entry.path, to: newPath });
    // Keep texture import settings attached across the rename.
    await invoke("rename_path", { from: `${entry.path}.meta`, to: `${newPath}.meta` }).catch(() => {});

    // Scripts: rewrite the default-exported class name to match the new
    // filename stem, and inject `extends Script` if the script predates the
    // engine base class.
    const newStem = name.replace(/\.(ts|js)$/i, "");
    await syncScriptClassNameAfterRename(newPath, newStem);

    await useProjectStore.getState().refresh();
  } catch (err) {
    console.error(`Rename failed: ${err}`);
  }
}

const norm = (p) => p.replaceAll("\\", "/").toLowerCase();

/** True when moving `sourcePath` into `destDir` would be a no-op or a cycle. */
function badMove(sourcePath, destDir) {
  if (!sourcePath || !destDir || sourcePath === destDir) return true;
  const name = sourcePath.split(/[\\/]/).pop();
  if (`${destDir}/${name}` === sourcePath) return true;
  // Refuse moving a folder into itself/a descendant.
  return norm(destDir).startsWith(`${norm(sourcePath)}/`);
}

/** Moves files/folders into a target directory (drag-drop onto a folder). */
export async function movePathsIntoFolder(sourcePaths, destDir) {
  const paths = [...new Set(sourcePaths)].filter((p) => !badMove(p, destDir));
  if (!paths.length) return;
  let moved = 0;
  for (const sourcePath of paths) {
    const name = sourcePath.split(/[\\/]/).pop();
    const dest = `${destDir}/${name}`;
    try {
      await invoke("rename_path", { from: sourcePath, to: dest });
      await invoke("rename_path", { from: `${sourcePath}.meta`, to: `${dest}.meta` }).catch(() => {});
      moved++;
    } catch (err) {
      console.error(`Move failed for ${name}: ${err}`);
    }
  }
  if (!moved) return;
  useSelectionStore.getState().clear();
  await useProjectStore.getState().refresh();
  console.log(moved === 1 ? `Moved ${paths[0].split(/[\\/]/).pop()}` : `Moved ${moved} assets`);
}

/**
 * Drop handler for asset drags: when the dragged tile is part of the current
 * multi-selection the whole selection travels with it, otherwise just the one.
 */
export function moveDraggedIntoFolder(draggedPath, destDir) {
  const { assetPaths } = useSelectionStore.getState();
  const paths = assetPaths.includes(draggedPath) ? assetPaths : [draggedPath];
  return movePathsIntoFolder(paths, destDir);
}

export function formatBytes(bytes) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(seconds) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
