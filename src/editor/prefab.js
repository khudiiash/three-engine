import { commandBus } from "./commands/CommandBus.js";
import { PasteCommand } from "./commands/entityCommands.js";
import { useSelectionStore } from "./store/selectionStore.js";

/**
 * .entity prefab assets: a JSON file holding one serialized entity snapshot
 * (serializeEntity format, ids stripped). Dropping one into the viewport or
 * hierarchy instantiates it through the command bus (undoable).
 */

/** Reads a .entity file and spawns it (optionally at a world position). */
export async function instantiatePrefab(path, position = null, parentId = null) {
  const { invoke } = await import("@tauri-apps/api/core");
  const snapshot = JSON.parse(await invoke("read_text_file", { path }));
  if (position) snapshot.position = position;
  const cmd = new PasteCommand([snapshot], parentId);
  cmd.label = `Add ${snapshot.name ?? "prefab"}`;
  commandBus.execute(cmd);
  if (cmd.entityIds[0]) useSelectionStore.getState().select(cmd.entityIds[0]);
  return cmd.entityIds[0] ?? null;
}
