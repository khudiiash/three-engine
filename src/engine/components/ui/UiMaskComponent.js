import { Component } from "../Component.js";

/**
 * Clips all descendant UI visuals to this element's rect (screen-space
 * rectangular clip in the shader — no stencil). Nested masks intersect.
 */
export class UiMaskComponent extends Component {
  static type = "uimask";
  static label = "UI Mask";
  static defaults = { enabled: true };
  static schema = [{ key: "enabled", label: "Enabled", type: "boolean" }];

  onPropChanged() {}
}
