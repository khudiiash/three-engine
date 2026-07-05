/**
 * Standard-mapped gamepad device. Up to four simultaneous gamepads via the
 * Gamepad API (W3C Standard Mapping). Path naming:
 *   gamepad/<index>/buttonSouth   — A on Xbox, X on PlayStation
 *   gamepad/<index>/buttonEast    — B / circle
 *   gamepad/<index>/buttonWest    — X / square
 *   gamepad/<index>/buttonNorth   — Y / triangle
 *   gamepad/<index>/leftShoulder / rightShoulder
 *   gamepad/<index>/leftTrigger / rightTrigger   (0..1 scalar)
 *   gamepad/<index>/leftStick / rightStick       ({x, y} in -1..1)
 *   gamepad/<index>/dpad                          ({x, y} in -1..1, integer)
 *   gamepad/<index>/start / select / leftStickPress / rightStickPress
 *
 * Sticks and triggers go through a per-frame deadzone so a wobbly stick
 * reads 0 instead of jittering.
 */
const DEADZONE = 0.12;

const BUTTON_MAP = {
  0: "buttonSouth",
  1: "buttonEast",
  2: "buttonWest",
  3: "buttonNorth",
  4: "leftShoulder",
  5: "rightShoulder",
  6: "leftTrigger",
  7: "rightTrigger",
  8: "select",
  9: "start",
  10: "leftStickPress",
  11: "rightStickPress",
  12: "dpadUp",
  13: "dpadDown",
  14: "dpadLeft",
  15: "dpadRight",
};

export class GamepadDevice {
  constructor(index) {
    this.index = index;
    this.id = `gamepad/${index}`;
    this.name = `Gamepad ${index + 1}`;
    this.connected = false;
    this.buttons = new Map();
    this.axes = new Map();
    this._onConnect = (e) => this.#onConnect(e);
    this._onDisconnect = (e) => this.#onDisconnect(e);
  }

  attach() {
    window.addEventListener("gamepadconnected", this._onConnect);
    window.addEventListener("gamepaddisconnected", this._onDisconnect);
    // Some browsers don't fire connected on first detection if a pad was
    // already plugged in before page load — sync from the API once.
    this.#pollGamepads();
  }

  detach() {
    window.removeEventListener("gamepadconnected", this._onConnect);
    window.removeEventListener("gamepaddisconnected", this._onDisconnect);
    this.buttons.clear();
    this.axes.clear();
    this.connected = false;
  }

  #onConnect(e) {
    if (e.gamepad.index !== this.index) return;
    this.connected = true;
  }

  #onDisconnect(e) {
    if (e.gamepad.index !== this.index) return;
    this.connected = false;
    this.buttons.clear();
    this.axes.clear();
  }

  /**
   * Reads the browser's gamepad state. Called every frame by the manager —
   * we don't keep a worker timer because the Gamepad API requires a poll
   * within rAF callbacks for fresh state on most browsers.
   */
  poll() {
    if (!this.connected) {
      // The browser might have populated this slot by the time we check —
      // adopt it so a hot-plug during play still works.
      const pads = navigator.getGamepads?.() ?? [];
      if (pads[this.index]) {
        this.connected = true;
      } else {
        return;
      }
    }
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads[this.index];
    if (!pad) return;

    this.buttons.clear();
    pad.buttons.forEach((b, i) => {
      const name = BUTTON_MAP[i] ?? `button${i}`;
      // `b.value` is 0..1 for analog triggers; 0 or 1 for digital. Some
      // browsers also expose `b.pressed` separately. Take the larger signal.
      this.buttons.set(name, b.pressed || b.value > 0.5);
    });

    this.axes.clear();
    pad.axes.forEach((v, i) => {
      const name = i === 0 ? "leftStickX" : i === 1 ? "leftStickY" : i === 2 ? "rightStickX" : i === 3 ? "rightStickY" : `axis${i}`;
      this.axes.set(name, Math.abs(v) < DEADZONE ? 0 : v);
    });
  }

  isPressed(path) {
    const which = path.split("/")[2]; // "gamepad/<index>/<control>"
    return !!this.buttons.get(which);
  }

  readValue(path) {
    const which = path.split("/")[2];
    if (which === "leftStick") return { x: this.axes.get("leftStickX") ?? 0, y: this.axes.get("leftStickY") ?? 0 };
    if (which === "rightStick") return { x: this.axes.get("rightStickX") ?? 0, y: this.axes.get("rightStickY") ?? 0 };
    if (which === "dpad") return {
      x: (this.buttons.get("dpadRight") ? 1 : 0) - (this.buttons.get("dpadLeft") ? 1 : 0),
      y: (this.buttons.get("dpadUp") ? 1 : 0) - (this.buttons.get("dpadDown") ? 1 : 0),
    };
    if (which === "leftTrigger") return this.#analogTrigger(6);
    if (which === "rightTrigger") return this.#analogTrigger(7);
    return this.isPressed(path) ? 1 : 0;
  }

  // Re-read trigger value from the live pad so analog pressure survives.
  #analogTrigger(buttonIndex) {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads[this.index];
    return pad?.buttons?.[buttonIndex]?.value ?? (this.buttons.get(buttonIndex === 6 ? "leftTrigger" : "rightTrigger") ? 1 : 0);
  }

  reset() {
    this.buttons.clear();
    this.axes.clear();
  }

  /** Force-recheck the navigator for pads matching our slot. */
  #pollGamepads() {
    const pads = navigator.getGamepads?.() ?? [];
    if (pads[this.index]) this.connected = true;
  }
}

/** Stable mapping for the "current gamepad" path alias (gamepad/any/...). */
export function pollAllGamepads(devices) {
  for (const d of devices) if (d instanceof GamepadDevice) d.poll();
}