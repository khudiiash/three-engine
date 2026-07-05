import { makeBindingId } from "./Action.js";

/**
 * Binding kinds. A binding always knows:
 *   path     — "device/control" (e.g. "keyboard/w", "mouse/leftButton",
 *              "gamepad/0/buttonSouth", "virtualjoystick/move").
 *   negate   — invert (sensitivity sign for axes, axis flip for gamepad).
 *   scale    — multiplier on the raw value (1 = identity).
 *
 * Composites join a fixed shape of parts into one value:
 *   1D: up/down -> scalar in [-1..1]
 *   2D: up/down/left/right -> { x, y } in [-1..1]^2
 * Each part references another regular binding by id; the manager looks up
 * that binding's resolved value when evaluating the composite.
 */
export class Binding {
  constructor({ id = makeBindingId(), path, negate = false, scale = 1 } = {}) {
    if (!path || !path.includes("/")) throw new Error(`Binding needs a "device/control" path`);
    this.id = id;
    this.kind = "binding";
    this.path = path;
    this.negate = !!negate;
    this.scale = scale;
  }
  toJSON() {
    return { kind: "binding", id: this.id, path: this.path, negate: this.negate, scale: this.scale };
  }
  static fromJSON(o) {
    return new Binding({ id: o.id, path: o.path, negate: o.negate, scale: o.scale ?? 1 });
  }
}

export class Composite {
  constructor({ id = makeBindingId(), type, parts = {} } = {}) {
    if (!["1d", "2d"].includes(type)) throw new Error(`Composite type must be 1d or 2d`);
    this.id = id;
    this.kind = "composite";
    this.type = type;
    // 1d: { negative, positive }; 2d: { up, down, left, right }.
    // Each value is either a Binding instance, or a { path, negate?, scale? }
    // shorthand that's upgraded to a Binding on creation.
    this.parts = {};
    for (const [slot, def] of Object.entries(parts)) {
      this.parts[slot] = def instanceof Binding ? def : new Binding(def);
    }
  }
  toJSON() {
    const parts = {};
    for (const [k, v] of Object.entries(this.parts)) parts[k] = v.toJSON();
    return { kind: "composite", id: this.id, type: this.type, parts };
  }
  static fromJSON(o) {
    const parts = {};
    for (const [k, v] of Object.entries(o.parts ?? {})) parts[k] = Binding.fromJSON(v);
    return new Composite({ id: o.id, type: o.type, parts });
  }
}