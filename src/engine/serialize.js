import { prefabRegistry } from "./prefab/registry.js";
import { instantiatePrefabNode } from "./prefab/expand.js";
import { instanceNodeOf } from "./prefab/sync.js";

const SCENE_VERSION = 1;

/**
 * A prefab instance serializes as a *link*, not as a tree: the entities under
 * it are the prefab's business, and only the differences (its overrides) belong
 * to the scene. That's what makes editing a prefab update every instance in
 * every scene. See engine/prefab/ for the format.
 */
export function serializeEntity(entity) {
  if (entity.prefab) return instanceNodeOf(entity);
  return {
    id: entity.id,
    name: entity.name,
    ...entity.getTransform(),
    viewOnly: !!entity.viewOnly,
    // Newer scenes may include entities without these flags — defaults are
    // booleans, but we still defensively normalise on read.
    enabledInEditor: entity.enabledInEditor !== false,
    enabledInGame: entity.enabledInGame !== false,
    components: [...entity.components.values()].map((c) => c.toJSON()),
    children: entity.children.map(serializeEntity),
  };
}

/**
 * `embedPrefabs` bundles every registered prefab def into the scene JSON. The
 * editor doesn't need it (it scans the project for `.prefab` files), but an
 * exported build has no project to scan — and the player must be able to
 * resolve instances (and `engine.instantiate` from scripts) with no I/O.
 */
export function serializeScene(engine, { embedPrefabs = false } = {}) {
  const scene = {
    version: SCENE_VERSION,
    name: engine.sceneName,
    settings: structuredClone(engine.settings),
    entities: engine.rootEntities.map(serializeEntity),
  };
  if (embedPrefabs) scene.prefabs = structuredClone(prefabRegistry.all());
  return scene;
}

export function instantiateEntity(engine, data, parent) {
  if (data.prefab) return instantiatePrefabNode(engine, data, parent);

  const entity = engine.createEntity({ id: data.id, name: data.name, parent });
  entity.setTransform(data);
  // Restore the entity-wide viewOnly flag before attaching components so
  // their initial `_viewOnlyActive` cache picks up the inherited state.
  if (data.viewOnly) entity.setViewOnly(true);
  // Per-mode enabled flags. Older scenes omit them — default to true so
  // existing scenes keep their current behaviour.
  if (data.enabledInEditor === false) entity.setEnabledInEditor(false);
  if (data.enabledInGame === false) entity.setEnabledInGame(false);
  for (const { type, props } of data.components ?? []) {
    entity.addComponent(type, props);
  }
  for (const childData of data.children ?? []) {
    instantiateEntity(engine, childData, entity);
  }
  return entity;
}

/** Replaces the current scene contents with the serialized scene. */
export function deserializeScene(engine, json) {
  if (json.version !== SCENE_VERSION) {
    throw new Error(`Unsupported scene version ${json.version}`);
  }
  engine.clear(); // resets settings to defaults
  engine.sceneName = json.name ?? "Untitled";
  if (json.settings) engine.applySettings(json.settings);
  // Prefabs must be in the registry before any instance node is expanded.
  for (const def of json.prefabs ?? []) {
    if (def?.guid) prefabRegistry.register(def, def.path ?? null);
  }
  for (const entityData of json.entities ?? []) {
    instantiateEntity(engine, entityData, null);
  }
  engine.emit("hierarchy-changed");
}
