/**
 * A single named action (e.g. "Jump", "Move", "Fire"). Owns its bindings and
 * resolves their state into a per-frame value the game reads. Unity Input
 * System-style: actions are abstract ("Move"); the bindings connect them to
 * concrete controls ("WASD", "Gamepad Left Stick", "Virtual Joystick").
 *
 * Action types:
 *   button — boolean; triggered/dragged/notHeld. Pressed/released edges.
 *   value  — scalar [min..max]. Axis-like (mouse delta, trigger pressure).
 *   vec2   — { x, y }. Movement, look, joystick.
 *
 * Composites: a binding can be a "composite" that joins up to four sub-parts
 * into one value (1D up/down+left/right for WASD, or 2D x/y/z/w for gamepad
 * sticks). Sub-parts reference regular bindings by id.
 *
 * Space (vec2 only):
 *   "world"  (default) — value stays in input-axis space: x is strafe-right,
 *                       y is forward, matching Unity. The consumer does its
 *                       own world-space transform.
 *   "camera" — the InputManager rotates the resolved vec2 by the active
 *              camera's yaw before storing it. The value becomes a world-
 *              space direction (X, Z components on the ground plane); Y is
 *              dropped because camera-relative movement is grounded. The
 *              consumer can write it directly into `entity.position`. This
 *              is the equivalent of Unity's "Input Action Properties →
 *              Use Right/Up Vector from Active Camera".
 *
 *              Requires the InputManager to be wired with a `cameraProvider`
 *              (see Engine constructor → `input.setCameraProvider(() =>
 *              engine.camera)`). When no camera is available the value
 *              falls back to input-space (world) — this keeps headless
 *              tests and unit tests deterministic.
 */
export class InputAction {
  constructor({ name, type, composite = "any", initial = null, space = "world" }) {
    if (!["button", "value", "vec2"].includes(type)) {
      throw new Error(`InputAction "${name}": unknown type "${type}"`);
    }
    if (!["any", "all", "min"].includes(composite)) {
      throw new Error(`InputAction "${name}": unknown composite "${composite}"`);
    }
    if (!["world", "camera"].includes(space)) {
      throw new Error(`InputAction "${name}": unknown space "${space}"`);
    }
    this.name = name;
    this.type = type;
    this.composite = composite;
    this.space = space;
    // Bindings list. Each is either a regular binding:
    //   { kind: "binding", id, path, ... } where path is "device/control".
    // or a composite:
    //   { kind: "composite", id, type: "2d"|"1d", parts: { up, down, left, right } }
    this.bindings = [];
    // Per-frame value produced by the input manager each tick.
    this.value = defaultValue(type, initial);
    // Edge latches: wasDown = pressed/active last frame, so the consumer can
    // ask WasPressedThisFrame() / WasReleasedThisFrame().
    this.wasDown = false;
    this.pressedThisFrame = false;
    this.releasedThisFrame = false;
  }

  /** Resets the live state; bindings + name stay intact. */
  reset() {
    this.value = defaultValue(this.type);
    this.wasDown = false;
    this.pressedThisFrame = false;
    this.releasedThisFrame = false;
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      composite: this.composite,
      // Only serialize space when it's the non-default ("camera"). Keeps
      // existing project.json snapshots untouched.
      ...(this.space === "camera" ? { space: "camera" } : {}),
      bindings: this.bindings.map((b) => b.toJSON()),
    };
  }
}

function defaultValue(type, initial) {
  if (type === "button") return false;
  if (type === "value") return typeof initial === "number" ? initial : 0;
  return { x: 0, y: 0 };
}

/** Returns a unique-enough id without pulling a uuid lib. */
export function makeBindingId() {
  return "b_" + Math.random().toString(36).slice(2, 10);
}