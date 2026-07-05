# Input System

Unity-style Input System for the three.js engine. Three device classes,
action maps, schemes, and an editor rebinding UI. Built into the core engine
(no module toggle required), enabled by default with `Player` + `UI` maps.

## TL;DR for scripts

```js
import { attribute } from "engine";

export default class MyController {
  @attribute({ type: "number", default: 6, label: "Move Speed" })
  moveSpeed = 6;

  onUpdate(dt) {
    const input = this.input; // attached automatically

    // Buttons (with per-frame edge latches)
    if (input.wasPressedThisFrame("Jump")) this.velocity.y = 8;
    if (input.isPressed("Sprint")) this.moveSpeed *= 1.7;

    // Vec2 (move stick, mouse delta, joystick, etc.)
    const move = input.readValue("Move"); // { x, y }
    const look = input.readValue("Look");
    // …use them…

    // Subscribe to events
    this._offFire = input.onAction("Fire", () => this.#shoot());
  }

  onDestroy() {
    this._offFire?.();
  }
}
```

## Concepts

- **Device** — keyboard, mouse, gamepad (W3C Standard Mapping), touchscreen,
  virtual joystick overlay. Each exposes a stable path grammar:
  `device/<slot>/<control>` (gamepad slots are `0..3` or `any`).
- **Action** — a named, typed handle (`button` / `value` / `vec2`) the
  game reads by name, decoupled from which device produced it.
- **Binding** — connects an action to a control path on a device, optionally
  with `negate` and `scale` modifiers.
- **Composite** — joins up to four bindings (1D `negative/positive` or 2D
  `up/down/left/right`) into one value. Used for WASD-style keys.
- **Action map** — a named group of actions (e.g. `Player`, `UI`).
- **Scheme** — `KeyboardMouse` / `Gamepad` / `Touch`. The manager
  auto-detects the active scheme from recent hardware signal and filters
  maps tagged to a subset.

## Default action maps

The engine ships with two maps pre-enabled. Open **Window → Input** in the
editor to rebind them; the changes persist into `project.json` and ride
along into exported games.

### Player

| Action  | Type   | Keyboard / Mouse       | Gamepad                | Touch                |
| ------- | ------ | ---------------------- | ---------------------- | -------------------- |
| Move    | vec2   | WASD, Arrow keys       | Left stick             | Left virtual stick   |
| Look    | vec2   | Mouse delta × 0.1      | Right stick            | Right virtual stick  |
| Jump    | button | Space                  | A (buttonSouth)        | —                    |
| Sprint  | button | Left/Right Shift       | L3 (leftStickPress)    | —                    |
| Crouch  | button | Left/Right Ctrl        | B (buttonEast)         | —                    |
| Fire    | button | Left Mouse             | Right Trigger > 0.5    | Right joystick tap   |
| Aim     | button | Right Mouse            | Left Trigger > 0.5     | —                    |
| Reload  | button | R                      | X (buttonWest)         | —                    |
| Pause   | button | Escape                 | Start                  | —                    |

### UI

| Action   | Type   | Keyboard / Mouse     | Gamepad         |
| -------- | ------ | -------------------- | --------------- |
| Navigate | vec2   | Arrow keys           | Left stick / D-pad |
| Submit   | button | Enter, Numpad Enter  | A               |
| Cancel   | button | Escape               | B               |
| Point    | vec2   | Cursor NDC           | —               |
| Click    | button | Left Mouse           | —               |

## Stacking maps

UI overlays typically need to swallow input while visible. Push the UI map
on top of the active stack:

```js
// In a script attached to a pause-menu entity
onStart()  { this.input.enableMap("UI"); }
onDestroy() { this.input.disableMap("UI"); }
```

When several maps are active, the **top of the stack wins** for any action
it defines. Lower maps still contribute actions the top doesn't define.

## Custom actions

Add an action map from a script:

```js
this.input.addActionMap({
  name: "Vehicle",
  schemes: ["KeyboardMouse", "Gamepad"],
  actions: [
    { name: "Steer", type: "value", bindings: [{ path: "keyboard/keya", negate: true, scale: 1 }, { path: "keyboard/keyd" }, { path: "gamepad/any/leftStickX" }] },
    { name: "Throttle", type: "value", bindings: [{ path: "keyboard/keyw" }, { path: "gamepad/any/rightTrigger" }] },
    { name: "Handbrake", type: "button", bindings: [{ path: "keyboard/space" }, { path: "gamepad/any/buttonSouth" }] },
  ],
});
this.input.enableMap("Vehicle");
```

> **Note:** `path` shorthand works because the binding has no `kind: "composite"`.
> The manager auto-detects composites by their shape (`{ type: "2d", parts }`).

## Virtual joysticks

A two-stick overlay is auto-shown on devices where the primary input is
touch (`pointer: coarse` media query, or `navigator.maxTouchPoints > 0`).
The player can force them with `engine.applyInput({ ...snapshot, virtualJoysticks: true })`.

The overlay exposes these paths to action maps:

| Path                                | Value                            |
| ----------------------------------- | -------------------------------- |
| `virtualjoystick/left/stick`        | `{ x, y }` in `[-1..1]`          |
| `virtualjoystick/right/stick`       | `{ x, y }` in `[-1..1]`          |
| `virtualjoystick/<side>/fire`       | `true` on quick taps (<180ms)    |

As soon as the player touches the keyboard or mouse, the overlay hides for
3 s so it doesn't fight gamepad or keyboard play.

## Editor panel

**Window → Input** opens the rebinding UI:

- Left rail: action maps with enable/disable toggles.
- Right pane: actions, type selectors, and per-binding rows with
  Rebind / Invert / Scale.
- The Rebind button waits for the next input of any kind and writes the
  captured path back into the binding.
- Save writes the snapshot into `project.json` (the `input` key).
  Disable-while-playing is not enforced — edits apply immediately on Save.

## Export

`scene.json` includes the input snapshot under `scene.input`. The player
runtime applies it during boot so the same bindings travel with the game.
`scene.player` carries `title` and `pixelRatioCap` next to it.

## Reference

### `engine.input`

| Member                                   | Description                                |
| ---------------------------------------- | ------------------------------------------ |
| `isPressed(name)`                        | Currently held                             |
| `wasPressedThisFrame(name)`              | Pressed this tick                          |
| `wasReleasedThisFrame(name)`             | Released this tick                         |
| `readValue(name)`                        | Number / `{ x, y }` for value / vec2       |
| `onAction(name, cb)`                     | Subscribe to press events                  |
| `onRelease(name, cb)`                    | Subscribe to release events                |
| `addActionMap(def)`                      | Register a map                             |
| `removeActionMap(name)`                  | Unregister a map                           |
| `enableMap(name)` / `disableMap(name)`   | Stack manipulation                         |
| `setActiveMap(name)`                     | Replace the stack                          |
| `getMap(name)`                           | Live map (for inspection)                  |
| `detectScheme()`                         | Re-run scheme detection                    |
| `setScheme(name)`                        | Pin the active scheme                      |
| `toJSON()` / `InputManager.fromJSON(...)`| Round-trip persistence                     |
| `keypad` / `mouse` / `touch` / `gamepads`| Raw device handles                         |
| `virtualJoysticks`                       | The mobile overlay instance                |