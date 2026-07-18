import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { SetComponentPropCommand } from "./commands/componentCommands.js";
import { invalidateBlobUrl } from "./assetLoader.js";
import { useProjectStore } from "./store/projectStore.js";
import { editableFromBufferGeometry, geometryAssetFromEditable } from "./editableGeometry.js";

const safeStem = (value) => (value || "Geometry").replace(/[^a-z0-9 _-]/gi, "").trim() || "Geometry";

export async function uniqueGeometryPath(root, stem) {
  const { invoke } = await import("@tauri-apps/api/core");
  for (let suffix = 0; ; suffix++) {
    const path = `${root}/geometries/${stem}${suffix ? ` ${suffix}` : ""}.geom`;
    try { await invoke("stat_file", { path }); } catch { return path; }
  }
}

/**
 * Blender-style make-single-user step for primitive meshes. Asset-backed
 * meshes keep their existing path and are edited in place.
 */
export async function ensureGeometryAsset(entityId) {
  const entity = engine.getEntity(entityId);
  const component = entity?.getComponent("mesh");
  if (!component?.mesh) return null;
  if (component.props.geometryAsset) return component.props.geometryAsset;
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project before editing geometry");
  const path = await uniqueGeometryPath(root, safeStem(entity.name));
  const sourceGeometry = entity.getComponent("geometryModifiers")?.getSourceGeometry?.() ?? component.mesh.geometry;
  const asset = geometryAssetFromEditable(editableFromBufferGeometry(sourceGeometry));
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_scene", { path, contents: JSON.stringify(asset, null, 2) });
  invalidateBlobUrl(path);
  commandBus.execute(new SetComponentPropCommand(entityId, "mesh", "geometryAsset", path));
  await useProjectStore.getState().refresh();
  return path;
}

/** Saves a new editable geometry asset without attaching it to an entity. */
export async function saveNewGeometryAsset(stem, editable) {
  const root = useProjectStore.getState().rootPath;
  if (!root) throw new Error("Open a project before creating geometry");
  const path = await uniqueGeometryPath(root, safeStem(stem));
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_scene", {
    path,
    contents: JSON.stringify(geometryAssetFromEditable(editable), null, 2),
  });
  invalidateBlobUrl(path);
  await useProjectStore.getState().refresh();
  return path;
}
