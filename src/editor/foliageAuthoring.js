import { engine } from "./engineInstance.js";
import { setModuleEnabled } from "./modules.js";
import { commandBus } from "./commands/CommandBus.js";
import { CreateEntityCommand } from "./commands/entityCommands.js";
import { useSelectionStore } from "./store/selectionStore.js";
import { foliageEntitySpec, isFoliageSurface } from "./foliagePresets.js";

export async function createFoliage({ species = "oak", surfaceId = "", parentId = null, position } = {}) {
  if (surfaceId && !isFoliageSurface(engine.getEntity(surfaceId))) {
    throw new Error("Choose a Mesh, Model, Terrain, or a group containing mesh surfaces.");
  }
  await setModuleEnabled("foliage", true);
  // Module setup can yield; never leave an orphan if its target was deleted meanwhile.
  if (surfaceId && !engine.getEntity(surfaceId)) throw new Error("The foliage surface was removed.");
  if (parentId && !engine.getEntity(parentId)) throw new Error("The foliage parent was removed.");
  const command = new CreateEntityCommand(foliageEntitySpec({ species, surfaceId, parentId, position }));
  commandBus.execute(command);
  useSelectionStore.getState().select(command.entityId);
  return engine.getEntity(command.entityId);
}
