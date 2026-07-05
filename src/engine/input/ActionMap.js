import { InputAction } from "./Action.js";
import { Binding, Composite } from "./bindings.js";

/**
 * A named group of actions (e.g. "Gameplay", "UI"). Exactly one map is active
 * at a time per scheme; the manager keeps a stack so UI overlays can be
 * pushed on top of Gameplay without losing its bindings.
 *
 * An action map's "scheme" describes which device groups it listens to, so a
 * project can ship separate maps for Keyboard&Mouse vs Gamepad vs Touch and
 * the manager picks the right one based on what the player is currently
 * using.
 */
export class ActionMap {
  constructor({ name, schemes = null, actions = [] } = {}) {
    this.name = name;
    // schemes: ["KeyboardMouse"], ["Gamepad"], ["Touch"], or null = all.
    this.schemes = schemes;
    this.actions = new Map();
    for (const def of actions) this.addAction(def);
  }

  addAction({ name, type, composite = "any", space = "world", bindings = [] }) {
    if (this.actions.has(name)) throw new Error(`ActionMap "${this.name}": duplicate action "${name}"`);
    const action = new InputAction({ name, type, composite, space });
    for (const b of bindings) action.bindings.push(b instanceof Binding || b instanceof Composite ? b : fromAny(b));
    this.actions.set(name, action);
    return action;
  }

  /** Looks up an action by name; throws if missing so typos surface early. */
  get(name) {
    const a = this.actions.get(name);
    if (!a) throw new Error(`ActionMap "${this.name}": no action "${name}"`);
    return a;
  }

  /** Returns the action if present, or null. Safe version. */
  find(name) {
    return this.actions.get(name) ?? null;
  }

  removeAction(name) {
    const a = this.actions.get(name);
    if (!a) return;
    a.reset();
    this.actions.delete(name);
  }

  toJSON() {
    return {
      name: this.name,
      schemes: this.schemes,
      actions: [...this.actions.values()].map((a) => a.toJSON()),
    };
  }

  static fromJSON(o) {
    const defs = (o.actions ?? []).map((a) => ({
      name: a.name,
      type: a.type,
      composite: a.composite,
      space: a.space,
      bindings: a.bindings.map(fromAny),
    }));
    return new ActionMap({ name: o.name, schemes: o.schemes, actions: defs });
  }
}

function fromAny(o) {
  if (o instanceof Binding || o instanceof Composite) return o;
  // Shorthand composite: `{ type: "1d" | "2d", parts }` with no `kind`. The
  // shape itself is the giveaway (a regular binding has a `path`).
  if (!o.kind && (o.type === "1d" || o.type === "2d") && o.parts) {
    return Composite.fromJSON(o);
  }
  if (o.kind === "composite") return Composite.fromJSON(o);
  return Binding.fromJSON(o);
}