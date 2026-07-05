import { ensureEngine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import {
  BatchCommand,
  DeleteEntityCommand,
  DuplicateEntityCommand,
  PasteCommand,
  stripIds,
  topMostIds,
} from "./commands/entityCommands.js";
import { useSelectionStore } from "./store/selectionStore.js";

/**
 * Editor-internal entity clipboard. Holds serialized snapshots (ids stripped),
 * so pasting after the source was deleted/cut still works and every paste
 * mints fresh ids.
 */
let buffer = [];

export const clipboardHasEntities = () => buffer.length > 0;

export async function copyEntities(ids) {
  const engine = await ensureEngine();
  const { serializeEntity } = await import("../engine/index.js");
  const top = topMostIds(ids).filter((id) => engine.getEntity(id));
  if (!top.length) return;
  buffer = top.map((id) => stripIds(serializeEntity(engine.getEntity(id))));
  console.log(`Copied ${buffer.length} ${buffer.length === 1 ? "entity" : "entities"}`);
}

export async function cutEntities(ids) {
  const engine = await ensureEngine();
  const top = topMostIds(ids).filter((id) => engine.getEntity(id));
  if (!top.length) return;
  await copyEntities(top);
  commandBus.execute(
    new BatchCommand(
      top.map((id) => new DeleteEntityCommand(id)),
      top.length === 1 ? `Cut ${engine.getEntity(top[0])?.name ?? "entity"}` : `Cut ${top.length} entities`,
    ),
  );
}

/** Pastes the clipboard under `parentId` (null = scene root) and selects the copies. */
export async function pasteEntities(parentId = null) {
  const engine = await ensureEngine();
  if (!buffer.length) return;
  if (parentId && !engine.getEntity(parentId)) parentId = null;
  const cmd = new PasteCommand(buffer, parentId);
  commandBus.execute(cmd);
  useSelectionStore.getState().select(cmd.entityIds);
}

/** Duplicates every top-most selected entity as one undo step. */
export async function duplicateSelection() {
  const engine = await ensureEngine();
  const ids = topMostIds(useSelectionStore.getState().ids).filter((id) => engine.getEntity(id));
  if (!ids.length) return;
  const cmds = ids.map((id) => new DuplicateEntityCommand(id));
  commandBus.execute(
    new BatchCommand(cmds, cmds.length === 1 ? cmds[0].label : `Duplicate ${cmds.length} entities`),
  );
  useSelectionStore.getState().select(cmds.map((c) => c.entityId));
}

/** Deletes every top-most selected entity as one undo step. */
export async function deleteSelection() {
  const engine = await ensureEngine();
  const ids = topMostIds(useSelectionStore.getState().ids).filter((id) => engine.getEntity(id));
  if (!ids.length) return;
  const cmds = ids.map((id) => new DeleteEntityCommand(id));
  commandBus.execute(
    new BatchCommand(cmds, cmds.length === 1 ? cmds[0].label : `Delete ${cmds.length} entities`),
  );
}
