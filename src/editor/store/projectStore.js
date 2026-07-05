import { create } from "zustand";

const ROOT_KEY = "engine.projectRoot.v1";

function basename(path) {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Tracks the open project folder and the directory currently browsed in the
 * Assets panel. The three.js scene has no concept of a "project" beyond
 * asset file paths, so this is purely editor-side bookkeeping.
 */
const RECENT_KEY = "engine.recentProjects.v1";

function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) ?? [];
  } catch {
    return [];
  }
}

export const useProjectStore = create((set, get) => ({
  rootPath: null,
  currentPath: null,
  entries: [],
  loading: false,
  error: null,
  recent: loadRecent(),
  hubSkipped: false,

  skipHub() {
    set({ hubSkipped: true });
  },

  projectMeta: {}, // contents of <root>/project.json (lastScene, name, …)

  /** Opens a known project folder and records it in the recent list. */
  async openProject(path) {
    localStorage.setItem(ROOT_KEY, path);
    const recent = [path, ...get().recent.filter((p) => p !== path)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    const { invoke } = await import("@tauri-apps/api/core");
    let projectMeta = {};
    try {
      projectMeta = JSON.parse(await invoke("load_scene", { path: `${path}/project.json` }));
    } catch {
      // Not a project created by the hub (or unreadable) — treat as empty meta.
    }
    set({ rootPath: path, recent, projectMeta });
    await get().navigate(path);
    return true;
  },

  /** Merges a patch into project.json on disk (source of truth for lastScene etc.). */
  async updateMeta(patch) {
    const { rootPath, projectMeta } = get();
    if (!rootPath) return;
    const next = { ...projectMeta, ...patch };
    set({ projectMeta: next });
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_scene", {
      path: `${rootPath}/project.json`,
      contents: JSON.stringify(next, null, 2),
    });
  },

  async openFolder() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true });
    if (!path) return false;
    return get().openProject(path);
  },

  /** Picks a folder, writes a project.json marker, and opens it. */
  async createProject() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ directory: true, title: "Select a folder for the new project" });
    if (!path) return false;
    const { invoke } = await import("@tauri-apps/api/core");
    const marker = JSON.stringify({ name: basename(path), version: 1 }, null, 2);
    await invoke("save_scene", { path: `${path}/project.json`, contents: marker });
    return get().openProject(path);
  },

  async restoreLastFolder() {
    const saved = localStorage.getItem(ROOT_KEY);
    if (!saved) return;
    await get().openProject(saved);
  },

  async navigate(path) {
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const entries = await invoke("list_dir", { path });
      set({ currentPath: path, entries, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  async refresh() {
    const { currentPath } = get();
    if (currentPath) await get().navigate(currentPath);
  },

  goUp() {
    const { rootPath, currentPath } = get();
    if (!currentPath || currentPath === rootPath) return;
    const parent = currentPath.replace(/[\\/][^\\/]+$/, "");
    get().navigate(parent || rootPath);
  },
}));

export { basename };
