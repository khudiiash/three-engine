import { Component } from "../Component.js";
import { getUiSystem } from "../../ui/UiSystem.js";

/**
 * Root of a UI hierarchy — the "canvas". Children lay out against the render
 * canvas size, scaled per the reference resolution + scale mode, so the same
 * layout adapts to any window/screen size:
 *
 *   none   — 1 UI px = 1 canvas px (no scaling).
 *   fit    — the whole reference resolution stays visible (min scale).
 *   fill   — the reference resolution covers the canvas (max scale).
 *   width  — reference width matches exactly, height is free.
 *   height — reference height matches exactly, width is free.
 *
 * Keep Screen entities at the scene root; the layout pass pins the root's
 * transform to identity every frame.
 */
export class UiScreenComponent extends Component {
  static type = "uiscreen";
  static label = "UI Screen";
  static defaults = {
    referenceWidth: 1280,
    referenceHeight: 720,
    scaleMode: "fit",
    sortOrder: 0,
  };
  static schema = [
    { key: "referenceWidth", label: "Ref Width", type: "number", min: 1, step: 1 },
    { key: "referenceHeight", label: "Ref Height", type: "number", min: 1, step: 1 },
    { key: "scaleMode", label: "Scale Mode", type: "select", options: ["fit", "fill", "width", "height", "none"] },
    { key: "sortOrder", label: "Sort Order", type: "number", step: 1 },
  ];

  onAttach() {
    // Written by the UiSystem layout pass each frame.
    this.uiWidth = 0;
    this.uiHeight = 0;
    this.scale = 1;
    this.k = 1;
    this.hitList = [];
    getUiSystem(this.entity.engine).addScreen(this);
  }

  onDetach() {
    getUiSystem(this.entity.engine, { create: false })?.removeScreen(this);
  }

  onPropChanged() {}
}
