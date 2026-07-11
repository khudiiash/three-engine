const SCENE_VERSION = 1;

export function serializeEntity(entity) {
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

export function serializeScene(engine) {
  return {
    version: SCENE_VERSION,
    name: engine.sceneName,
    settings: structuredClone(engine.settings),
    entities: engine.rootEntities.map(serializeEntity),
  };
}

export function instantiateEntity(engine, data, parent) {
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
  for (const entityData of json.entities ?? []) {
    instantiateEntity(engine, entityData, null);
  }
  engine.emit("hierarchy-changed");
}
