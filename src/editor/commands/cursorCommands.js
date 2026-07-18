import { setCursor3DPosition } from "../threeDCursor.js";

/**
 * Records a single 3D-cursor position change as an undoable command.
 * Mirrors the SetTransformCommand API used for entity drags so the
 * editor's existing undo plumbing handles it without changes.
 *
 * `before` is captured eagerly (it can be null on construction — the
 * current cursor position is read at do/undo time).
 *
 * The cursor's visible proxy is moved as a side effect of
 * `setCursor3DPosition`, so this command is self-contained.
 */
export class SetCursor3DCommand {
  constructor(after, before = null) {
    this.after = Array.isArray(after) ? [...after] : [after.x, after.y, after.z];
    this.before = before
      ? (Array.isArray(before) ? [...before] : [before.x, before.y, before.z])
      : null;
    this.label = "Move 3D Cursor";
  }

  do() {
    setCursor3DPosition(this.after);
  }

  undo() {
    if (this.before) setCursor3DPosition(this.before);
  }
}
