import { create } from "zustand";

export const useSelectionStore = create((set, get) => ({
  ids: [],
  anchorId: null, // last plainly-clicked id; shift-click ranges extend from here
  assetPath: null, // selected Assets-panel file (shows an asset inspector)

  select(ids, anchorId) {
    const list = Array.isArray(ids) ? ids : [ids];
    set({ ids: list, anchorId: anchorId ?? list[0] ?? null, assetPath: null });
  },

  /** Ctrl/Cmd-click: add or remove one id without touching the rest. */
  toggle(id) {
    const ids = get().ids.includes(id)
      ? get().ids.filter((x) => x !== id)
      : [...get().ids, id];
    set({ ids, anchorId: id, assetPath: null });
  },

  selectAsset(path) {
    set({ ids: [], anchorId: null, assetPath: path });
  },

  clear() {
    set({ ids: [], anchorId: null, assetPath: null });
  },

  /** Drop ids that no longer exist (after deletes / scene loads). */
  prune(existingIds) {
    const ids = get().ids.filter((id) => existingIds.has(id));
    if (ids.length !== get().ids.length) set({ ids });
  },
}));
