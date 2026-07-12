export {
  PREFAB_FORMAT_VERSION,
  PREFAB_EXT,
  LEGACY_PREFAB_EXT,
  newGuid,
  newFid,
  isInstanceNode,
  isPrefabDef,
  isVariant,
  parsePrefabFile,
  upgradeLegacyEntity,
  makeDef,
  makeVariantDef,
  deepEqual,
} from "./format.js";

export { prefabRegistry, registerPrefabDefs } from "./registry.js";
export { resolvePrefab, resolveInstance, applyOverrides, findByPath } from "./resolve.js";
export {
  instantiatePrefabNode,
  liveTree,
  unpackInstance,
  clearPrefabTags,
  getPrefabRoot,
  isPrefabRoot,
  isInsidePrefab,
} from "./expand.js";
export { diffInstance, hasOverrides, groupOverrides, applyInstanceToDef, absorbOverrides } from "./diff.js";
export {
  instanceNodeOf,
  respawnInstance,
  reloadPrefab,
  instancesAffectedBy,
  dependenciesOf,
  createDefFromEntity,
  bindEntityToPrefab,
  createVariantDefFromInstance,
  defWithInstanceApplied,
  defFromStageRoot,
} from "./sync.js";
