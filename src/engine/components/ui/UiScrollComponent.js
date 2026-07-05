import { Component } from "../Component.js";

/**
 * Scrollable viewport: children are clipped to this element's rect and
 * offset by the scroll position. Mouse wheel and pointer-drag scrolling are
 * handled by the UiSystem while playing. Content extent is measured from the
 * children's computed rects each frame (use a child with UiLayout
 * `fitContent` for lists).
 */
export class UiScrollComponent extends Component {
  static type = "uiscroll";
  static label = "UI Scroll View";
  static defaults = {
    vertical: true,
    horizontal: false,
    dragScroll: true,
    wheelSpeed: 1,
  };
  static schema = [
    { key: "vertical", label: "Vertical", type: "boolean" },
    { key: "horizontal", label: "Horizontal", type: "boolean" },
    { key: "dragScroll", label: "Drag To Scroll", type: "boolean" },
    { key: "wheelSpeed", label: "Wheel Speed", type: "number", min: 0.1, max: 5, step: 0.1 },
  ];

  onAttach() {
    this.scrollX = 0;
    this.scrollY = 0;
    this.contentW = 0;
    this.contentH = 0;
    this.viewportW = 0;
    this.viewportH = 0;
  }

  onPropChanged() {}

  /** Script API: scroll to a position (UI px, clamped by the layout pass). */
  scrollTo(x, y) {
    if (x != null) this.scrollX = x;
    if (y != null) this.scrollY = y;
  }
}
