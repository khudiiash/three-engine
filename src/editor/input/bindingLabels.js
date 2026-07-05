/**
 * Editor-side helpers for the Input panel: turn raw control paths into
 * friendly labels, and listen for the next input event of any kind to
 * capture it as a new binding.
 *
 * Path grammar: "<device>/<slot>/<control>" or "<device>/<control>".
 *   keyboard/<code>             e.g. keyboard/space, keyboard/keyw
 *   mouse/<button|delta|...>    e.g. mouse/leftButton, mouse/delta
 *   gamepad/<index|any>/<ctrl>  e.g. gamepad/0/buttonSouth, gamepad/any/leftStick
 *   touch/<index|primary|...>   e.g. touch/primary, touch/count
 *   virtualjoystick/<side>/<c>  e.g. virtualjoystick/left/stick
 */

const KEY_LABELS = {
  space: "Space",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  shiftleft: "Left Shift",
  shiftright: "Right Shift",
  controlleft: "Left Ctrl",
  controlright: "Right Ctrl",
  altleft: "Left Alt",
  altright: "Right Alt",
  metaleft: "Left Meta",
  metaright: "Right Meta",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  numpadenter: "Numpad Enter",
};

const MOUSE_LABELS = {
  leftButton: "Left Button",
  rightButton: "Right Button",
  middleButton: "Middle Button",
  x1Button: "Mouse 4",
  x2Button: "Mouse 5",
  position: "Cursor Position",
  delta: "Mouse Delta",
  scroll: "Scroll",
};

const GAMEPAD_LABELS = {
  buttonSouth: "A / Cross",
  buttonEast: "B / Circle",
  buttonWest: "X / Square",
  buttonNorth: "Y / Triangle",
  leftShoulder: "Left Bumper",
  rightShoulder: "Right Bumper",
  leftTrigger: "Left Trigger",
  rightTrigger: "Right Trigger",
  leftStick: "Left Stick",
  rightStick: "Right Stick",
  leftStickPress: "L3 (Stick Click)",
  rightStickPress: "R3 (Stick Click)",
  dpad: "D-Pad",
  dpadUp: "D-Pad Up",
  dpadDown: "D-Pad Down",
  dpadLeft: "D-Pad Left",
  dpadRight: "D-Pad Right",
  select: "Select / Share",
  start: "Start / Options",
};

const VJ_LABELS = {
  stick: "Stick",
  fire: "Fire (tap)",
};

/** Renders a path as a friendly label; falls back to the raw path (or a
 *  placeholder for empty bindings so the rebind button always has text). */
export function describePath(path) {
  if (!path || typeof path !== "string") return "Unbound · click to set";
  const parts = path.split("/");
  if (!parts[0]) return "Unbound · click to set";
  if (parts[0] === "keyboard") {
    const code = parts[1];
    if (!code) return "Unbound · click to set";
    if (KEY_LABELS[code]) return KEY_LABELS[code];
    if (code?.startsWith("key") && code.length === 4) return code.slice(3).toUpperCase();
    if (code?.startsWith("digit")) return code.slice(5);
    if (code?.startsWith("numpad")) return `Numpad ${code.slice(6)}`;
    return code ?? "?";
  }
  if (parts[0] === "mouse") return MOUSE_LABELS[parts[1]] ?? parts[1] ?? "?";
  if (parts[0] === "gamepad") {
    const slot = parts[1];
    const ctrl = parts[2];
    if (!ctrl) return "Unbound · click to set";
    const label = GAMEPAD_LABELS[ctrl] ?? ctrl ?? "?";
    return slot === "any" ? `Gamepad · ${label}` : `Gamepad ${Number(slot) + 1} · ${label}`;
  }
  if (parts[0] === "touch") {
    if (!parts[1]) return "Unbound · click to set";
    if (parts[1] === "primary") return "Touch · Primary";
    if (parts[1] === "count") return "Touch · Count";
    return `Touch · Finger ${Number(parts[1]) + 1}`;
  }
  if (parts[0] === "virtualjoystick") {
    const side = parts[1] === "left" ? "Left" : "Right";
    const ctrl = VJ_LABELS[parts[2]] ?? parts[2] ?? "?";
    return `V-Joystick ${side} · ${ctrl}`;
  }
  return path;
}

/**
 * Waits for the user to press / move any control, then resolves with the
 * captured path. Returns a cancel function. The captured path is the
 * canonical form produced by the matching device (e.g. KeyboardDevice
 * yields "keyboard/<code>", MouseDevice yields "mouse/<control>").
 *
 * Pass an array of acceptable families ("keyboard", "mouse", "gamepad",
 * "touch") to limit which devices count — useful for binding a button to
 * "any key" only.
 */
export function rebindNextInput({ families = ["keyboard", "mouse", "gamepad", "touch"], timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("touchstart", onTouch, true);
      window.removeEventListener("gamepadconnected", onGamepad, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      if (pollHandle) cancelAnimationFrame(pollHandle);
      if (timer) clearTimeout(timer);
    };
    const finish = (val) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(val);
    };

    const ok = (family) => families.includes(family);

    const onKey = (e) => {
      if (!ok("keyboard")) return;
      e.preventDefault();
      e.stopPropagation();
      finish({ path: `keyboard/${e.code.toLowerCase()}` });
    };
    const onPointer = (e) => {
      if (!ok("mouse")) return;
      e.preventDefault();
      e.stopPropagation();
      const btn =
        e.button === 0 ? "leftButton" :
        e.button === 1 ? "middleButton" :
        e.button === 2 ? "rightButton" :
        e.button === 3 ? "x1Button" :
        e.button === 4 ? "x2Button" : `button${e.button}`;
      finish({ path: `mouse/${btn}` });
    };
    const onPointerMove = (e) => {
      if (!ok("mouse")) return;
      // We only accept mouse-move as a binding source for vec2 axis slots.
      // The caller controls whether they listen for this — we accept any.
      e.preventDefault();
      e.stopPropagation();
      finish({ path: "mouse/delta", vec2: true });
    };
    const onWheel = (e) => {
      if (!ok("mouse")) return;
      e.preventDefault();
      e.stopPropagation();
      finish({ path: "mouse/scroll", vec2: true });
    };
    const onTouch = (e) => {
      if (!ok("touch")) return;
      e.preventDefault();
      e.stopPropagation();
      finish({ path: "touch/primary", vec2: true });
    };
    const onMouseDown = (e) => onPointer(e);
    const onGamepad = () => {
      // We need to actually poll to know which button was pressed; let the
      // rAF loop below handle that — here we just remember a pad exists.
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("wheel", onWheel, true);
    window.addEventListener("touchstart", onTouch, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("gamepadconnected", onGamepad, true);

    let pollHandle = null;
    const poll = () => {
      if (done) return;
      if (ok("gamepad") && navigator.getGamepads) {
        const pads = navigator.getGamepads();
        for (let i = 0; i < pads.length; i++) {
          const pad = pads[i];
          if (!pad) continue;
          const BUTTONS = ["buttonSouth","buttonEast","buttonWest","buttonNorth","leftShoulder","rightShoulder","leftTrigger","rightTrigger","select","start","leftStickPress","rightStickPress","dpadUp","dpadDown","dpadLeft","dpadRight"];
          for (let b = 0; b < pad.buttons.length && b < BUTTONS.length; b++) {
            const btn = pad.buttons[b];
            if (btn.pressed || btn.value > 0.5) {
              finish({ path: `gamepad/${i}/${BUTTONS[b]}` });
              return;
            }
          }
          // Sticks: any axis moved past 0.5.
          for (let a = 0; a < pad.axes.length; a++) {
            if (Math.abs(pad.axes[a]) > 0.5) {
              const name = a === 0 ? "leftStickX" : a === 1 ? "leftStickY" : a === 2 ? "rightStickX" : "rightStickY";
              const stick = name.startsWith("left") ? "leftStick" : "rightStick";
              finish({ path: `gamepad/${i}/${stick}`, vec2: true });
              return;
            }
          }
        }
      }
      pollHandle = requestAnimationFrame(poll);
    };
    pollHandle = requestAnimationFrame(poll);

    let timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/** List of paths the panel can suggest adding when the user clicks "+". */
export function suggestedPaths(family) {
  if (family === "keyboard") return [
    "keyboard/space", "keyboard/enter", "keyboard/escape",
    "keyboard/keyw", "keyboard/keys", "keyboard/keya", "keyboard/keyd",
    "keyboard/arrowup", "keyboard/arrowdown", "keyboard/arrowleft", "keyboard/arrowright",
    "keyboard/shiftleft", "keyboard/controlleft",
  ];
  if (family === "mouse") return [
    "mouse/leftButton", "mouse/rightButton", "mouse/middleButton",
    "mouse/delta", "mouse/scroll", "mouse/position",
  ];
  if (family === "gamepad") return [
    "gamepad/any/buttonSouth", "gamepad/any/buttonEast", "gamepad/any/buttonWest", "gamepad/any/buttonNorth",
    "gamepad/any/leftShoulder", "gamepad/any/rightShoulder",
    "gamepad/any/leftTrigger", "gamepad/any/rightTrigger",
    "gamepad/any/leftStick", "gamepad/any/rightStick",
    "gamepad/any/dpad", "gamepad/any/start", "gamepad/any/select",
  ];
  if (family === "touch") return [
    "touch/primary", "touch/count", "touch/0",
  ];
  if (family === "virtualjoystick") return [
    "virtualjoystick/left/stick", "virtualjoystick/right/stick",
    "virtualjoystick/left/fire", "virtualjoystick/right/fire",
  ];
  return [];
}