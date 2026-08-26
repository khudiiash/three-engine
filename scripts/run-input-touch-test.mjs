/**
 * Touch input, headless.
 *
 * The bug this exists to keep fixed, in the words it was reported in: "on
 * mobile, both joysticks rotate the camera". Two independent faults stacked up
 * to produce it, and both are invisible to anything short of driving the real
 * event handlers:
 *
 *  1. `VirtualJoysticks` never set a `device.id`. The manager matches a
 *     binding's device family against exactly that (`#readBinding`), so every
 *     `virtualjoystick/...` path fell off the end of the device loop and
 *     resolved to 0. The sticks drew, tracked the finger, and drove nothing —
 *     including Move, which is the only binding the LEFT stick has.
 *  2. `MouseDevice` listens on Pointer Events, and a touchscreen speaks those
 *     too. Every finger on the glass fed `mouse/delta`, which the default
 *     Player map binds to Look. So the only thing either stick did was turn
 *     the camera, which is exactly what was seen.
 *
 * Nothing here needs a GPU or a browser: the devices are attached to a DOM
 * stub that records handlers, and the tests call those handlers with the event
 * shapes a phone actually sends.
 */
import assert from "node:assert/strict";

/* ------------------------------- DOM stub -------------------------------- */

const listeners = new Map();
const record = (map) => ({
  addEventListener(type, fn) {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    map.get(type)?.delete(fn);
  },
});

const stubElement = () => ({
  style: {},
  dataset: {},
  className: "",
  children: [],
  appendChild(child) {
    this.children.push(child);
  },
  remove() {},
  ...record(new Map()),
});

globalThis.document ??= {
  body: stubElement(),
  createElement: stubElement,
  ...record(new Map()),
};
globalThis.window ??= {
  innerWidth: 800,
  innerHeight: 600,
  matchMedia: () => ({ matches: true }),
  ...record(listeners),
};
globalThis.navigator ??= { maxTouchPoints: 5, getGamepads: () => [] };

/** Fires every handler registered on `window` for `type`. */
function fire(type, event) {
  for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {}, ...event });
}

/** A TouchEvent's worth of changed touches. `y` defaults to mid-screen. */
const touches = (...list) => ({
  changedTouches: list.map((t) => ({ identifier: t.id, clientX: t.x, clientY: t.y ?? 300 })),
});

/* ------------------------------- harness --------------------------------- */

const { InputManager } = await import("../src/engine/input/InputManager.js");
const { createDefaultMaps } = await import("../src/engine/input/defaultMaps.js");

let failures = 0;
function check(what, fn) {
  try {
    fn();
    console.log(`  ok   ${what}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${what}`);
    console.error(`       ${error.message}`);
  }
}

/**
 * A manager wired the way the engine wires one, with the shipped Player map.
 *
 * `virtualJoysticks: "auto"` is the shipped default and the interesting case:
 * the overlay decides for itself whether to appear (the DOM stub reports a
 * coarse pointer, so it does) and is allowed to put itself away again when a
 * real mouse shows up. Forcing it on with `true` would pin `visible` and hide
 * both halves of that behaviour.
 */
function mount() {
  const input = new InputManager({ virtualJoysticks: "auto" });
  for (const map of createDefaultMaps()) input.addActionMap(map);
  input.enableMap("Player");
  input.attach();
  return input;
}

/** Drags a finger from `from` to `to` the way a phone reports it: pointer
 *  events AND touch events, in the order the browser fires them. */
function drag(input, { id = 0, from, to }) {
  fire("pointerdown", { pointerId: id, pointerType: "touch", button: 0, clientX: from.x, clientY: from.y });
  fire("touchstart", touches({ id, x: from.x, y: from.y }));
  fire("pointermove", { pointerId: id, pointerType: "touch", clientX: to.x, clientY: to.y, movementX: to.x - from.x, movementY: to.y - from.y });
  fire("touchmove", touches({ id, x: to.x, y: to.y }));
  input.tick(1 / 60);
}

const LEFT = { x: 150, y: 400 }; // left half of an 800px-wide screen
const RIGHT = { x: 650, y: 400 };

/* --------------------------------- tests --------------------------------- */

console.log("virtual joystick wiring");

check("the overlay registers as a device bindings can actually reach", () => {
  const input = mount();
  assert.equal(input.virtualJoysticks.id, "virtualjoysticks");
  assert.ok(
    input.devices.some((device) => device.id === "virtualjoysticks"),
    "no device in the set answers to the `virtualjoystick/...` binding family",
  );
  input.detach();
});

check("the LEFT stick walks", () => {
  const input = mount();
  drag(input, { from: LEFT, to: { x: LEFT.x + 60, y: LEFT.y } });
  const move = input.readValue("Move");
  assert.ok(move.x > 0.9, `the left stick moved the character by ${move.x}, not right`);
  input.detach();
});

check("the RIGHT stick looks", () => {
  const input = mount();
  drag(input, { id: 1, from: RIGHT, to: { x: RIGHT.x + 60, y: RIGHT.y } });
  const look = input.readValue("Look");
  assert.ok(look.x > 0.9, `the right stick turned the camera by ${look.x}`);
  input.detach();
});

check("a tap on the right stick fires", () => {
  const input = mount();
  fire("touchstart", touches({ id: 3, x: RIGHT.x, y: RIGHT.y }));
  fire("touchend", touches({ id: 3, x: RIGHT.x, y: RIGHT.y }));
  input.tick(1 / 60);
  assert.equal(input.isPressed("Fire"), true, "a quick tap is the only fire button a phone has");
  input.detach();
});

console.log("touch is not a mouse");

check("the LEFT stick does NOT turn the camera", () => {
  // The whole report, as one assertion.
  const input = mount();
  drag(input, { from: LEFT, to: { x: LEFT.x + 60, y: LEFT.y - 40 } });
  const look = input.readValue("Look");
  assert.equal(look.x, 0, `walking turned the camera by ${look.x}`);
  assert.equal(look.y, 0, `walking pitched the camera by ${look.y}`);
  input.detach();
});

check("a finger never feeds mouse/delta", () => {
  const input = mount();
  fire("pointermove", { pointerType: "touch", clientX: 400, clientY: 300, movementX: 90, movementY: 90 });
  assert.equal(input.mouse.delta.x, 0);
  assert.equal(input.mouse.delta.y, 0);
  input.detach();
});

check("a real mouse still feeds mouse/delta", () => {
  const input = mount();
  fire("pointermove", { pointerType: "mouse", clientX: 400, clientY: 300, movementX: 90, movementY: -30 });
  assert.equal(input.mouse.delta.x, 90);
  assert.equal(input.mouse.delta.y, -30);
  input.detach();
});

check("a finger still updates mouse/position, so tap-to-pick keeps working", () => {
  const input = mount();
  fire("pointermove", { pointerType: "touch", clientX: 600, clientY: 150, movementX: 0, movementY: 0 });
  assert.ok(input.mouse.position.x > 0, "a tap on the right of the screen raycasts through the left");
  input.detach();
});

check("a finger never latches a mouse button", () => {
  // `#anyMouseDown()` reads these to decide the player has picked up a mouse —
  // which switches the active scheme to KeyboardMouse and hides the overlay
  // the player is currently holding.
  const input = mount();
  fire("pointerdown", { pointerType: "touch", button: 0, clientX: 400, clientY: 300 });
  assert.equal(input.mouse.buttons.get("leftButton"), undefined);
  input.detach();
});

check("touching the screen leaves the joysticks on screen and the scheme on Touch", () => {
  const input = mount();
  drag(input, { from: LEFT, to: { x: LEFT.x + 40, y: LEFT.y } });
  assert.equal(input.virtualJoysticks.visible, true, "the overlay hid itself the moment it was used");
  assert.equal(input.activeScheme, "Touch", `active scheme went to ${input.activeScheme}`);
  input.detach();
});

check("a real mouse still puts the joysticks away", () => {
  const input = mount();
  fire("pointerdown", { pointerType: "mouse", button: 0, clientX: 400, clientY: 300 });
  assert.equal(input.virtualJoysticks.visible, false, "the overlay outstayed a real mouse");
  input.detach();
});

check("both sticks at once: one walks, the other looks", () => {
  const input = mount();
  drag(input, { id: 0, from: LEFT, to: { x: LEFT.x, y: LEFT.y - 60 } });
  drag(input, { id: 1, from: RIGHT, to: { x: RIGHT.x - 60, y: RIGHT.y } });
  const move = input.readValue("Move");
  const look = input.readValue("Look");
  assert.ok(move.y > 0.9, `the left stick should walk forward, gave y = ${move.y}`);
  assert.ok(look.x < -0.9, `the right stick should turn left, gave x = ${look.x}`);
  assert.ok(Math.abs(move.x) < 0.01, `the right stick leaked into movement: x = ${move.x}`);
  assert.ok(Math.abs(look.y) < 0.01, `the left stick leaked into look: y = ${look.y}`);
  input.detach();
});

if (failures) {
  console.error(`\n${failures} touch-input check(s) failed`);
  process.exit(1);
}
console.log("\ntouch input: all checks passed");
