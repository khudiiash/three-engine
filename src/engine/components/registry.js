import { Component } from "./Component.js";

const componentClasses = new Map();

export function registerComponent(cls) {
  if (!cls.type) throw new Error("Component class needs a static `type`");
  componentClasses.set(cls.type, cls);
}

export function unregisterComponent(type) {
  componentClasses.delete(type);
}

export function getComponentClass(type) {
  return componentClasses.get(type);
}

export function getComponentTypes() {
  return [...componentClasses.keys()];
}

/**
 * Inert stand-in for a component whose type isn't registered (its module is
 * disabled or removed). Holds the original type + props so the scene
 * serializes back unchanged — nothing is lost by opening the scene.
 */
export class MissingComponent extends Component {
  static type = "__missing__";
  static label = "Missing Component";
  static defaults = {};
  static schema = [];

  constructor(entity, props, missingType) {
    super(entity, props);
    this.missingType = missingType;
  }

  get type() {
    return this.missingType;
  }
}

export function createComponent(type, entity, props) {
  const Cls = componentClasses.get(type);
  if (!Cls) {
    console.warn(`Unknown component type "${type}" — keeping it as data (is its module enabled?)`);
    return new MissingComponent(entity, props, type);
  }
  return new Cls(entity, props);
}
