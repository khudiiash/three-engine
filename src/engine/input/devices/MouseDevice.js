import * as THREE from "three/webgpu";

/**
 * Mouse input device. Tracks button state, position (normalized -1..1 like
 * a small NDC), and per-frame delta since the last poll. The manager is
 * expected to call `consumeDelta()` after each tick so "delta" actions read
 * exactly the movement since the previous frame (matches Unity's axis
 * expectation).
 *
 * Control paths:
 *   mouse/leftButton, mouse/rightButton, mouse/middleButton
 *   mouse/position       — vec2 NDC
 *   mouse/delta          — vec2 px-per-frame, consumed each tick
 *   mouse/scroll         — vec2 (x = horizontal, y = vertical) per-frame
 */
export class MouseDevice {
  constructor() {
    this.id = "mouse";
    this.name = "Mouse";
    this.connected = true;
    this.buttons = new Map(); // "leftButton" -> bool
    this.position = { x: 0, y: 0 };
    this.delta = { x: 0, y: 0 };
    this.scroll = { x: 0, y: 0 };
    this._target = null;
    this._cursor = "default";
    this._onMove = (e) => this.#onPointerMove(e);
    this._onDown = (e) => this.#onPointerDown(e);
    this._onUp = (e) => this.#onPointerUp(e);
    this._onWheel = (e) => this.#onWheel(e);
    this._onContext = (e) => e.preventDefault();
  }

  /** `target` is usually the canvas; falls back to window. */
  attach(target = window) {
    this._target = target;
    target.addEventListener("pointermove", this._onMove);
    target.addEventListener("pointerdown", this._onDown);
    window.addEventListener("pointerup", this._onUp);
    target.addEventListener("wheel", this._onWheel, { passive: false });
    target.addEventListener("contextmenu", this._onContext);
  }

  detach() {
    if (!this._target) return;
    this._target.removeEventListener("pointermove", this._onMove);
    this._target.removeEventListener("pointerdown", this._onDown);
    window.removeEventListener("pointerup", this._onUp);
    this._target.removeEventListener("wheel", this._onWheel);
    this._target.removeEventListener("contextmenu", this._onContext);
    this._target = null;
    this.buttons.clear();
    this.delta.x = this.delta.y = 0;
    this.scroll.x = this.scroll.y = 0;
  }

  /**
   * A touchscreen speaks Pointer Events too: one finger dragging across the
   * glass fires `pointerdown`/`pointermove`/`pointerup` with
   * `pointerType === "touch"`, indistinguishable from a mouse to any
   * listener that doesn't ask.
   *
   * It has to be asked. Touch has its own device (`TouchDevice`) and its own
   * higher-level layer (`VirtualJoysticks`); letting it ALSO drive this one
   * meant `mouse/delta` — which the default Player map binds to Look — was
   * fed by every finger on the screen, so dragging the on-screen MOVE stick
   * turned the camera. It also latched `mouse/leftButton`, which made
   * `InputManager.#anyMouseDown()` report keyboard-and-mouse activity on a
   * phone and hide the joystick overlay the player was holding.
   *
   * Pen/stylus is deliberately still a mouse: it has a hover state and a
   * button, and games treat it as one.
   */
  #isTouch(e) {
    return e.pointerType === "touch";
  }

  #onPointerMove(e) {
    const t = this._target;
    // Normalize against the target's bounding rect so cursor-locked reads
    // (which never move the OS cursor) still produce sane NDC.
    const rect = t.getBoundingClientRect ? t.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    // Position still tracks a finger — `mouse/position` and `mouse.ray()` are
    // how a game picks what was tapped, and a touch that never updated it
    // would raycast through wherever the mouse last was. Only the per-frame
    // DELTA (the look axis) is refused.
    if (!this.#isTouch(e)) {
      this.delta.x += e.movementX ?? nx - this.position.x;
      this.delta.y += e.movementY ?? ny - this.position.y;
    }
    this.position.x = nx;
    this.position.y = ny;
  }

  #onPointerDown(e) {
    if (e.button === undefined || this.#isTouch(e)) return;
    this.buttons.set(this.#buttonName(e.button), true);
  }

  #onPointerUp(e) {
    if (this.#isTouch(e)) return;
    // pointerup's button is whatever was released; `buttons` (plural) covers
    // the case where the OS only fires once for all up events.
    const name = e.button !== undefined ? this.#buttonName(e.button) : null;
    if (name) this.buttons.set(name, false);
    if (e.buttons === 0) for (const k of this.buttons.keys()) this.buttons.set(k, false);
  }

  #onWheel(e) {
    e.preventDefault();
    this.scroll.x += e.deltaX;
    this.scroll.y += e.deltaY;
  }

  #buttonName(button) {
    switch (button) {
      case 0: return "leftButton";
      case 1: return "middleButton";
      case 2: return "rightButton";
      case 3: return "x1Button";
      case 4: return "x2Button";
      default: return `button${button}`;
    }
  }

  // ---- Query API ----

  isPressed(path) {
    const which = path.split("/")[1];
    return !!this.buttons.get(which);
  }

  readValue(path) {
    const which = path.split("/")[1];
    if (which === "position") return this.position;
    if (which === "delta") return this.delta;
    if (which === "scroll") return this.scroll;
    return this.isPressed(path) ? 1 : 0;
  }

  /** Called by the input manager after each tick — reset per-frame deltas. */
  consumeFrame() {
    this.delta.x = this.delta.y = 0;
    this.scroll.x = this.scroll.y = 0;
  }

  reset() {
    this.buttons.clear();
    this.delta.x = this.delta.y = 0;
    this.scroll.x = this.scroll.y = 0;
  }

  /** Raycast helper: ray from camera through current pointer position. */
  ray(camera) {
    const ndc = new THREE.Vector2(this.position.x, this.position.y);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    return raycaster;
  }

  /** Lock the cursor for FPS-style games. Returns true if supported. */
  requestPointerLock() {
    const t = this._target;
    if (!t || !t.requestPointerLock) return false;
    t.requestPointerLock();
    return true;
  }
}