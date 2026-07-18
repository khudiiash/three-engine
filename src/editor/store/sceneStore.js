import { create } from "zustand";
import { ensureEngine } from "../engineInstance.js";

function mirrorEntity(entity) {
  return {
    id: entity.id,
    name: entity.name,
    parentId: entity.parent?.id ?? null,
    childIds: entity.children.map((c) => c.id),
    transform: entity.getTransform(),
    components: Object.fromEntries(
      [...entity.components.values()].map((c) => [c.type, { ...c.props }]),
    ),
  };
}

/**
 * Read-only mirror of the engine's entity tree for React rendering.
 * The three.js scene stays the source of truth; commands mutate the
 * engine, then call refresh() (or updateTransform for live gizmo drags).
 */
export const useSceneStore = create((set) => ({
  sceneName: "Untitled",
  scenePath: null,
  rootIds: [],
  entities: {}, // id -> mirror
  dirty: false,

  // refresh/updateTransform run inside React store actions, which fire only
  // after EditorShell has mounted and resolved `ensureEngine()`. Belt and
  // braces: guard against the load-not-yet-finished race so a stray call
  // during boot doesn't throw on the Proxy.
  refresh(scenePath = undefined) {
    const inst = engineInstanceCache;
    if (!inst) return;
    const entities = {};
    for (const entity of inst.entities.values()) {
      entities[entity.id] = mirrorEntity(entity);
    }
    set((state) => ({
      entities,
      rootIds: inst.rootEntities.map((e) => e.id),
      sceneName: inst.sceneName,
      ...(scenePath !== undefined ? { scenePath } : { scenePath: state.scenePath }),
    }));
  },

  updateTransform(id) {
    const inst = engineInstanceCache;
    if (!inst) return;
    const entity = inst.getEntity(id);
    if (!entity) return;
    set((state) => ({
      entities: {
        ...state.entities,
        [id]: { ...state.entities[id], transform: entity.getTransform() },
      },
    }));
  },

  setScenePath(scenePath) {
    set({ scenePath });
  },

  markDirty(dirty = true) {
    set({ dirty });
  },
}));

// Cached singleton handle so refresh/updateTransform can read the engine
// without going through the throwing Proxy.
let engineInstanceCache = null;

// Subscribe to engine events once the lazy engine has resolved. EditorShell
// calls `await ensureEngine()` in its mount effect, but we also kick off the
// load here so that subscribers attached by external modules (e.g. the
// autosave interval) start firing as early as possible.
ensureEngine().then((engine) => {
  engineInstanceCache = engine;
  engine.on("hierarchy-changed", () => useSceneStore.getState().refresh());
});
