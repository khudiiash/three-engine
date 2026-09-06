// @ts-check
import { create } from "zustand";
import { ensureEngine } from "../engineInstance.js";
import { vmSingleton, oncePerVm } from "../singleton.js";

/**
 * The plain-data row shape the hierarchy renders (and hierarchySearch matches
 * against). The two enabled flags are mirrored so a structured search can
 * filter on them (`?enabled=true` = the row's eye icon, `enabledInGame` = the
 * play-time one). Both are set through commands that emit "hierarchy-changed"
 * and therefore land here via refresh() — but a DIRECT write to the entity's
 * flag bypasses refresh() and will lag in the mirror until the next refresh,
 * so the search box can briefly disagree with the engine about a flag nobody
 * changed through a command.
 */
function mirrorEntity(entity) {
  return {
    id: entity.id,
    name: entity.name,
    parentId: entity.parent?.id ?? null,
    childIds: entity.children.map((c) => c.id),
    transform: entity.getTransform(),
    tags: [...(entity.tags ?? [])],
    components: Object.fromEntries(
      [...entity.components.values()].map((c) => [c.type, { ...c.props }]),
    ),
    enabledInEditor: entity.enabledInEditor !== false,
    enabledInGame: entity.enabledInGame !== false,
  };
}

/**
 * Read-only mirror of the engine's entity tree for React rendering.
 * The three.js scene stays the source of truth; commands mutate the
 * engine, then call refresh() (or updateTransform for live gizmo drags).
 */
export const useSceneStore = vmSingleton("sceneStore", () =>
  create((set) => ({
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

    /**
     * Refreshes the mirrored transform of one entity or a batch of them.
     *
     * Accepts an array because the map object has to be replaced for zustand to
     * see a change, and that spread is proportional to SCENE SIZE, not to how
     * many entities moved. Calling this in a loop while dragging a 100-entity
     * multi-selection therefore copied a scene-sized object 100 times per
     * pointermove. One call, one spread.
     */
    updateTransform(ids) {
      const inst = engineInstanceCache;
      if (!inst) return;
      const list = Array.isArray(ids) ? ids : [ids];
      if (!list.length) return;
      set((state) => {
        let entities = null; // cloned lazily, at most once
        for (const id of list) {
          const entity = inst.getEntity(id);
          const previous = state.entities[id];
          if (!entity || !previous) continue;
          entities ??= { ...state.entities };
          entities[id] = { ...previous, transform: entity.getTransform() };
        }
        return entities ? { entities } : {};
      });
    },

      setScenePath(scenePath) {
        set({ scenePath });
      },

      /** Updates scene chrome without rebuilding the O(N) entity mirror. The
       * hierarchy transaction already published that mirror exactly once. */
      setSceneMeta(sceneName, scenePath) {
        set({ sceneName, scenePath });
      },

      markDirty(dirty = true) {
        set({ dirty });
      },
  })),
);

// Cached singleton handle so refresh/updateTransform can read the engine
// without going through the throwing Proxy.
let engineInstanceCache = null;

// Subscribe to engine events once the lazy engine has resolved. EditorShell
// calls `await ensureEngine()` in its mount effect, but we also kick off the
// load here so that subscribers attached by external modules (e.g. the
// autosave interval) start firing as early as possible.
//
// `oncePerVm` because a re-evaluated copy of this module would otherwise add a
// second "hierarchy-changed" listener that refreshes the same store again —
// harmless in outcome, but it doubles a scene-sized mirror rebuild on every
// tree change, and the count grows with each hot reload.
if (oncePerVm("sceneStore.subscribe")) {
  ensureEngine().then((engine) => {
    engineInstanceCache = engine;
    engine.on("hierarchy-changed", () => useSceneStore.getState().refresh());
  });
}
