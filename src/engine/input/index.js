/**
 * Public surface for the input system. The engine builds an InputManager at
 * init() and exposes it as `engine.input`; scripts read actions through
 * `engine.input.isPressed("Jump")` / `engine.input.readValue("Move")` /
 * `engine.input.onAction("Fire", ...)`.
 */
export { InputManager } from "./InputManager.js";
export { ActionMap } from "./ActionMap.js";
export { InputAction } from "./Action.js";
export { Binding, Composite } from "./bindings.js";
export { KeyboardDevice } from "./devices/KeyboardDevice.js";
export { MouseDevice } from "./devices/MouseDevice.js";
export { GamepadDevice } from "./devices/GamepadDevice.js";
export { TouchDevice } from "./devices/TouchDevice.js";
export { VirtualJoysticks } from "./VirtualJoysticks.js";
export { DEFAULT_PLAYER_MAP, DEFAULT_UI_MAP, createDefaultMaps } from "./defaultMaps.js";