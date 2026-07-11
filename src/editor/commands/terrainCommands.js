import { engine } from "../engineInstance.js";

/**
 * Commits one full sculpt stroke as a single undo step. `before`/`after` are
 * base64-encoded snapshots of the terrain's height buffer (captured at
 * pointerdown / pointerup) — the stroke itself mutates the live geometry
 * directly for immediate feedback and never touches the command bus.
 */
export class SetTerrainHeightsCommand {
  constructor(entityId, before, after) {
    this.entityId = entityId;
    this.before = before;
    this.after = after;
    this.label = "Sculpt Terrain";
  }

  do() {
    engine.getEntity(this.entityId)?.getComponent("terrain")?.setProp("heights", this.after);
  }

  undo() {
    engine.getEntity(this.entityId)?.getComponent("terrain")?.setProp("heights", this.before);
  }
}

/** Mirrors SetTerrainHeightsCommand for one texture-paint stroke on the splatmap. */
export class SetTerrainSplatmapCommand {
  constructor(entityId, before, after) {
    this.entityId = entityId;
    this.before = before;
    this.after = after;
    this.label = "Paint Terrain";
  }

  do() {
    engine.getEntity(this.entityId)?.getComponent("terrain")?.setProp("splatmap", this.after);
  }

  undo() {
    engine.getEntity(this.entityId)?.getComponent("terrain")?.setProp("splatmap", this.before);
  }
}
