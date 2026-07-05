// Example: a debug HUD that visualizes every input action's live state.
// Attach to an entity with a UiScreen + UiText (or just log to console).
//
// Reads from `this.input` (the InputManager) the same way gameplay code does.

import { attribute } from "engine";

export default class InputDebugHud {
  @attribute({ type: "text", default: "Player", label: "Map name" })
  mapName = "Player";

  @attribute({ type: "number", default: 1.5, min: 0.05, max: 5, step: 0.05, label: "Refresh (s)" })
  refreshInterval = 0.25;

  onStart() {
    this.timer = 0;
    this.lastText = "";
    this.#render();
  }

  onUpdate(dt) {
    this.timer += dt;
    if (this.timer < this.refreshInterval) return;
    this.timer = 0;
    this.#render();
  }

  #render() {
    const input = this.input;
    if (!input) return;
    const map = input.getMap(this.mapName);
    if (!map) return;
    const lines = [];
    lines.push(`▸ ${this.mapName}  (scheme: ${input.activeScheme})`);
    for (const action of map.actions.values()) {
      const val = action.value;
      const isOn = action.type === "button" ? action.wasDown : action.type === "value" ? Math.abs(val) > 0.01 : Math.hypot(val.x ?? 0, val.y ?? 0) > 0.01;
      const v =
        action.type === "button"
          ? action.wasDown ? "[ ON ]" : "[off ]"
          : action.type === "value"
            ? val.toFixed(2).padStart(6)
            : `(${val.x.toFixed(2)}, ${val.y.toFixed(2)})`;
      lines.push(`  ${action.name.padEnd(10)} ${action.type.padEnd(5)} ${v}${isOn ? "  ←" : ""}`);
    }
    const text = lines.join("\n");
    if (text === this.lastText) return;
    this.lastText = text;

    // Update the entity's UiText component if one exists, else log.
    const uiText = this.entity.getComponent("uitext");
    if (uiText) uiText.setText(text);
    else console.log("[Input]", text);
  }
}