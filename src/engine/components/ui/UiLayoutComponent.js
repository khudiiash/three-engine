import { Component } from "../Component.js";

/**
 * Flexbox-style container: positions its direct children in a row or column,
 * overriding their anchors (their `size` is still used as the preferred
 * size; the cross axis stretches by default). `fitContent` grows the
 * container's computed rect along the main axis to the content extent —
 * pair it with a UiScroll parent for scrollable lists.
 */
export class UiLayoutComponent extends Component {
  static type = "uilayout";
  static label = "UI Layout";
  static defaults = {
    direction: "column",
    gap: 8,
    padding: 8,
    alignItems: "stretch",
    justify: "start",
    fitContent: false,
  };
  static schema = [
    { key: "direction", label: "Direction", type: "select", options: ["column", "row"] },
    { key: "gap", label: "Gap", type: "number", min: 0, step: 1 },
    { key: "padding", label: "Padding", type: "number", min: 0, step: 1 },
    { key: "alignItems", label: "Align Items", type: "select", options: ["stretch", "start", "center", "end"] },
    { key: "justify", label: "Justify", type: "select", options: ["start", "center", "end", "space-between"] },
    { key: "fitContent", label: "Fit Content", type: "boolean" },
  ];

  onAttach() {
    this.contentMain = 0; // written by the layout pass
  }

  onPropChanged() {}
}
