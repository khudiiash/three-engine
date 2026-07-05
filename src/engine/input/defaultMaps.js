import { ActionMap } from "./ActionMap.js";
import { Binding, Composite } from "./bindings.js";

/**
 * Default action maps that ship with the engine. These match the conventions
 * Unity uses for a typical third-person controller — games can rename, remove,
 * or rebind them through the editor's Input panel.
 *
 * Maps:
 *   Player — Movement (WASD/left stick + virtual left stick), Look (mouse
 *            delta / right stick), Jump, Sprint, Crouch, Fire, Aim, Reload.
 *   UI     — Navigate (arrow keys / dpad / left stick), Submit, Cancel,
 *            Point (mouse position / right stick).
 */

export const DEFAULT_PLAYER_MAP = () =>
  new ActionMap({
    name: "Player",
    schemes: ["KeyboardMouse", "Gamepad", "Touch"],
    actions: [
      {
        name: "Move",
        type: "vec2",
        composite: "any",
        // Default to camera-space so `move.x`/`move.y` are already world XZ.
        // A 3rd-person controller is the typical use case and "WASD = strafe
        // relative to camera" is what every third-person game expects. Toggle
        // to "world" in the Input panel for top-down / fixed-camera setups.
        space: "camera",
        bindings: [
          // WASD composite (KeyboardMouse). Composite parts are magnitudes —
          // the slot name (up/down/left/right) is the direction, and the
          // composite formula (`x += right - left`) handles the sign. Putting
          // `negate: true` on the left/right parts would double-count the
          // direction (the binding's negate flips the magnitude, then the
          // formula subtracts again), so pressing A and D both produced +x.
          new Composite({
            type: "2d",
            parts: {
              up: new Binding({ path: "keyboard/keyw" }),
              down: new Binding({ path: "keyboard/keys" }),
              left: new Binding({ path: "keyboard/keya" }),
              right: new Binding({ path: "keyboard/keyd" }),
            },
          }),
          // Arrow-key composite (alt KeyboardMouse). Same rule: magnitudes only.
          new Composite({
            type: "2d",
            parts: {
              up: new Binding({ path: "keyboard/arrowup" }),
              down: new Binding({ path: "keyboard/arrowdown" }),
              left: new Binding({ path: "keyboard/arrowleft" }),
              right: new Binding({ path: "keyboard/arrowright" }),
            },
          }),
          // Left stick (Gamepad).
          new Binding({ path: "gamepad/any/leftStick" }),
          // Virtual left joystick (Touch).
          new Binding({ path: "virtualjoystick/left/stick" }),
        ],
      },
      {
        name: "Look",
        type: "vec2",
        composite: "any",
        bindings: [
          new Binding({ path: "mouse/delta", scale: 0.1 }),
          new Binding({ path: "gamepad/any/rightStick" }),
          new Binding({ path: "virtualjoystick/right/stick" }),
        ],
      },
      {
        name: "Jump",
        type: "button",
        bindings: [
          new Binding({ path: "keyboard/space" }),
          new Binding({ path: "gamepad/any/buttonSouth" }),
        ],
      },
      {
        name: "Sprint",
        type: "button",
        bindings: [
          new Binding({ path: "keyboard/shiftleft" }),
          new Binding({ path: "keyboard/shiftright" }),
          new Binding({ path: "gamepad/any/leftStickPress" }),
        ],
      },
      {
        name: "Crouch",
        type: "button",
        bindings: [
          new Binding({ path: "keyboard/controlleft" }),
          new Binding({ path: "keyboard/controlright" }),
          new Binding({ path: "gamepad/any/buttonEast" }),
        ],
      },
      {
        name: "Fire",
        type: "button",
        bindings: [
          new Binding({ path: "mouse/leftButton" }),
          new Binding({ path: "gamepad/any/rightTrigger", scale: 0.5 }),
          new Binding({ path: "virtualjoystick/right/fire" }),
        ],
      },
      {
        name: "Aim",
        type: "button",
        bindings: [
          new Binding({ path: "mouse/rightButton" }),
          new Binding({ path: "gamepad/any/leftTrigger", scale: 0.5 }),
        ],
      },
      {
        name: "Reload",
        type: "button",
        bindings: [
          new Binding({ path: "keyboard/keyr" }),
          new Binding({ path: "gamepad/any/buttonWest" }),
        ],
      },
      {
        name: "Pause",
        type: "button",
        bindings: [
          new Binding({ path: "keyboard/escape" }),
          new Binding({ path: "gamepad/any/start" }),
        ],
      },
    ],
  });

export const DEFAULT_UI_MAP = () =>
  new ActionMap({
    name: "UI",
    schemes: ["KeyboardMouse", "Gamepad", "Touch"],
    actions: [
      {
        name: "Navigate",
        type: "vec2",
        composite: "any",
        bindings: [
          new Composite({
            type: "2d",
            parts: {
              up: new Binding({ path: "keyboard/arrowup" }),
              down: new Binding({ path: "keyboard/arrowdown" }),
              left: new Binding({ path: "keyboard/arrowleft" }),
              right: new Binding({ path: "keyboard/arrowright" }),
            },
          }),
          new Binding({ path: "gamepad/any/leftStick" }),
          new Binding({ path: "gamepad/any/dpad" }),
        ],
      },
      {
        name: "Submit",
        type: "button",
        bindings: [
          new Binding({ path: "keyboard/enter" }),
          new Binding({ path: "keyboard/numpadenter" }),
          new Binding({ path: "gamepad/any/buttonSouth" }),
        ],
      },
      {
        name: "Cancel",
        type: "button",
        bindings: [
          new Binding({ path: "keyboard/escape" }),
          new Binding({ path: "gamepad/any/buttonEast" }),
        ],
      },
      {
        name: "Point",
        type: "vec2",
        composite: "any",
        bindings: [
          new Binding({ path: "mouse/position" }),
          new Binding({ path: "touch/primary" }),
        ],
      },
      {
        name: "Click",
        type: "button",
        bindings: [
          new Binding({ path: "mouse/leftButton" }),
          new Binding({ path: "touch/any" }),
        ],
      },
    ],
  });

/** Returns the bundled default set; a fresh map each call so callers can mutate. */
export function createDefaultMaps() {
  return [DEFAULT_PLAYER_MAP(), DEFAULT_UI_MAP()];
}