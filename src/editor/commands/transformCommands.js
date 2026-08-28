import { engine } from "../engineInstance.js";

export class SetTransformCommand {
  /**
   * before/after: { position, rotation, scale } (any subset).
   * Pass `before` explicitly when the object was already moved live
   * (gizmo drags), otherwise it is captured from the entity.
   */
  constructor(entityId, after, before = null) {
    this.entityId = entityId;
    this.after = after;
    this.before = before ?? engine.getEntity(entityId).getTransform();
    this.label = "Transform";
    // Tells CommandBus#afterMutation this never touched the hierarchy, tags
    // or components, so it can update just this entity's mirrored transform
    // instead of rebuilding the whole scene store.
    this.transformOnly = true;
    this.entityIds = [entityId];
  }

  do() {
    engine.getEntity(this.entityId)?.setTransform(this.after);
  }

  undo() {
    engine.getEntity(this.entityId)?.setTransform(this.before);
  }
}
