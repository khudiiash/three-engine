/**
 * Base class for all components. Subclasses must define:
 *   static type       — unique string id ("mesh", "light", ...)
 *   static label      — display name for the editor
 *   static defaults   — default props object
 *   static schema     — property descriptors used by the inspector:
 *                       [{ key, label, type: "number"|"color"|"select"|"text"|"boolean",
 *                          min?, max?, step?, options? }]
 * and may override onAttach/onDetach/onPropChanged.
 */
export class Component {
  constructor(entity, props = {}) {
    this.entity = entity;
    this.props = { ...this.constructor.defaults, ...props };
  }

  get type() {
    return this.constructor.type;
  }

  /** Called after the component is added to its entity. Build three.js objects here. */
  onAttach() {}

  /** Called before removal. Tear down three.js objects here. */
  onDetach() {}

  /** Called after a prop changes. Default: rebuild by detach/attach. */
  onPropChanged() {
    this.onDetach();
    this.onAttach();
  }

  setProp(key, value) {
    this.props[key] = value;
    this.onPropChanged(key, value);
    // Two events, both for editor consumers:
    //   - "component-changed" is a precise signal — the camera follow
    //     section uses it to know exactly which entity/component changed
    //     and skip noise from other entities.
    //   - "hierarchy-changed" piggy-backs the existing sceneStore refresh
    //     so the React mirror re-reads the entity's props and controlled
    //     inputs (camera's follow checkboxes, show-preview toggle, …)
    //     reflect the latest value instead of going stale.
    const engine = this.entity?.engine;
    engine?.emit?.("component-changed", {
      entityId: this.entity?.id,
      componentType: this.type,
      key,
    });
    engine?.emit?.("hierarchy-changed");
  }

  toJSON() {
    return { type: this.type, props: { ...this.props } };
  }
}
