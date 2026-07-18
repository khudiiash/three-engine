import * as THREE from "three/webgpu";
import { engine } from "./engineInstance.js";
import { commandBus } from "./commands/CommandBus.js";
import { BatchCommand, topMostIds } from "./commands/entityCommands.js";
import { SetTransformCommand } from "./commands/transformCommands.js";
import { SetCursor3DCommand } from "./commands/cursorCommands.js";
import { useSelectionStore } from "./store/selectionStore.js";
import {
  getCursor3D,
  getCursor3DPosition,
  setCursor3DPosition,
} from "./threeDCursor.js";

/**
 * High-level 3D-cursor operations that mirror Blender's snap menu:
 *
 *   snapSelectionToCursor()   "Shift+S → Selection to Cursor"
 *     Translates each top-most selected entity so its origin lands on
 *     the cursor. Each transform becomes one SetTransformCommand; the
 *     whole batch collapses to a single undoable.
 *
 *   snapSelectionToOrigin()    "Shift+S → Selection to World Origin"
 *     Same as above but with the cursor temporarily set to (0,0,0).
 *
 *   snapCursorToSelection()    "Shift+S → Cursor to Selected"
 *     Repositions the 3D cursor to the selection's anchor. With one
 *     entity selected this is the entity's world-space origin; with
 *     multiple entities it's their world-space centroid (the same
 *     notion Blender uses for "Cursor to Selected"). Routed through
 *     SetCursor3DCommand so Ctrl+Z brings the cursor back.
 *
 *   snapCursorToWorldOrigin()  "Shift+S → Cursor to World Origin"
 *     Cursor → (0,0,0). Routed through SetCursor3DCommand so it's
 *     undoable like the other cursor moves.
 *
 *   snapCursorToGridFloor()    "Shift+S → Cursor to Grid"
 *     Drops the cursor onto the world XZ plane (y = 0). Undoable.
 */

export function snapSelectionToCursor() {
  const ids = topMostIds(useSelectionStore.getState().ids ?? []).filter((id) => engine.getEntity(id));
  if (!ids.length) return false;
  const target = getCursor3DPosition(new THREE.Vector3());
  const cmds = [];
  const worldDelta = new THREE.Vector3();
  const localDelta = new THREE.Vector3();
  const parentInverse = new THREE.Matrix4();
  for (const id of ids) {
    const entity = engine.getEntity(id);
    if (!entity?.object3D) continue;
    entity.object3D.updateWorldMatrix(true, false);
    const worldPos = new THREE.Vector3().setFromMatrixPosition(entity.object3D.matrixWorld);
    worldDelta.subVectors(target, worldPos);
    // Translate the world delta into the parent's local space so the
    // entity lands at the cursor in world coordinates even when it's a
    // child of a transformed parent. Without this a parent at a
    // rotated parent space would double-count the rotation.
    if (entity.parent?.object3D) {
      entity.parent.object3D.updateWorldMatrix(true, false);
      parentInverse.copy(entity.parent.object3D.matrixWorld).invert();
      localDelta.copy(worldDelta).applyMatrix4(parentInverse);
    } else {
      localDelta.copy(worldDelta);
    }
    const after = entity.getTransform();
    after.position = [
      after.position[0] + localDelta.x,
      after.position[1] + localDelta.y,
      after.position[2] + localDelta.z,
    ];
    cmds.push(new SetTransformCommand(id, after));
  }
  if (!cmds.length) return false;
  const label = cmds.length === 1 ? "Snap to 3D Cursor" : `Snap ${cmds.length} to 3D Cursor`;
  commandBus.execute(new BatchCommand(cmds, label));
  return true;
}

export function snapSelectionToOrigin() {
  const prev = getCursor3D();
  setCursor3DPosition(0, 0, 0);
  const ok = snapSelectionToCursor();
  setCursor3DPosition(prev.position);
  return ok;
}

export function snapCursorToSelection() {
  // Drop the cursor on the selection's anchor. With exactly one entity
  // selected the anchor is that entity's world-space origin (matches
  // Blender's "Cursor to Active"); with multiple selected entities we
  // average their world-space origins (matches Blender's "Cursor to
  // Selected"). Both paths are routed through SetCursor3DCommand so
  // Ctrl+Z reverses the move.
  const ids = useSelectionStore.getState().ids;
  const filtered = ids.filter((id) => engine.getEntity(id)?.object3D);
  if (!filtered.length) return false;
  let count = 0;
  const target = new THREE.Vector3();
  for (const id of filtered) {
    const entity = engine.getEntity(id);
    entity.object3D.updateWorldMatrix(true, false);
    target.x += entity.object3D.matrixWorld.elements[12];
    target.y += entity.object3D.matrixWorld.elements[13];
    target.z += entity.object3D.matrixWorld.elements[14];
    count++;
  }
  target.multiplyScalar(1 / count);
  const before = getCursor3D().position;
  // Skip the command (and the position write) entirely when the cursor
  // is already at the target — saves the undo stack from a no-op entry
  // when the user spams the menu shortcut.
  if (Math.abs(before[0] - target.x) < 1e-6 && Math.abs(before[1] - target.y) < 1e-6 && Math.abs(before[2] - target.z) < 1e-6) {
    return false;
  }
  commandBus.execute(new SetCursor3DCommand(target, before));
  return true;
}

export function snapCursorToWorldOrigin() {
  // "Cursor to World Origin" — undoable via SetCursor3DCommand so Ctrl+Z
  // pops the cursor back. Done lazily (and only when the cursor isn't
  // already at the origin) to avoid spamming the undo stack.
  const before = getCursor3D().position;
  if (before[0] === 0 && before[1] === 0 && before[2] === 0) return false;
  commandBus.execute(new SetCursor3DCommand([0, 0, 0], before));
  return true;
}

export function snapCursorToGridFloor() {
  // "Cursor to Grid" — drop the cursor onto the XZ plane (y = 0). Blender's
  // bind is Shift+S → Cursor to Grid. Undoable.
  const before = getCursor3D().position;
  if (before[1] === 0) return false;
  commandBus.execute(new SetCursor3DCommand([before[0], 0, before[2]], before));
  return true;
}
