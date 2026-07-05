import { Component } from "../Component.js";
import { ELEMENT_DEFAULTS } from "../../ui/layout.js";

/**
 * The RectTransform of the UI system: anchors + pivot + pos/size relative to
 * the parent's rect. Every UI entity under a Screen should carry one
 * (entities without it stretch to fill their parent).
 *
 * The computed absolute rect is written by the UiSystem's layout pass each
 * frame onto `this.rect` ({x,y,w,h} in UI px), along with `clipRect`,
 * `worldAlpha` and `layoutControlled`. The entity's Object3D position is
 * layout-driven — edit `pos`/`size`/anchors, not the transform position.
 * Rotation and scale on the transform still apply (around the pivot).
 *
 * The inspector renders a custom section for this component (anchor preset
 * picker + smart labels), so the schema stays empty on purpose.
 */
export class UiElementComponent extends Component {
  static type = "uielement";
  static label = "UI Element";
  static defaults = { ...ELEMENT_DEFAULTS };
  static schema = [];

  onAttach() {
    this.rect = null;
    this.clipRect = null;
    this.worldAlpha = 1;
    this.layoutControlled = false;
  }

  // Layout runs every frame; prop changes need no rebuild.
  onPropChanged() {}
}
