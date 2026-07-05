import { engine } from "../engineInstance.js";

/** Undoable patch of the scene's environment/rendering settings. */
export class SetSceneSettingsCommand {
  constructor(patch, label = "Change scene settings") {
    this.patch = patch;
    // Snapshot only the touched keys (fog snapshots whole for simplicity).
    this.before = {};
    for (const key of Object.keys(patch)) {
      this.before[key] = structuredClone(engine.settings[key]);
    }
    this.label = label;
  }

  do() {
    engine.applySettings(this.patch);
  }

  undo() {
    engine.applySettings(this.before);
  }
}
