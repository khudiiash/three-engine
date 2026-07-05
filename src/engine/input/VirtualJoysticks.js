import { pollAllGamepads } from "./devices/GamepadDevice.js";

/**
 * Mobile virtual joystick overlay. Two fixed-position joysticks (left = move,
 * right = look/fire-axis) auto-appear on coarse-pointer / touch-primary
 * devices, but the host can also force them visible. They register a
 * "virtualjoystick" device that the manager queries just like a real gamepad.
 *
 * Each joystick:
 *   - appears when the user touches inside its dead zone,
 *   - follows the touch until release (clamped to the joystick radius),
 *   - exposes `vec2` value in [-1..1]^2 at the path
 *     "virtualjoystick/<left|right>/stick".
 *   - exposes a "fire" button path "virtualjoystick/<left|right>/fire" —
 *     a quick tap (touch < TAP_TIME) registers as a press edge.
 *
 * Auto-detection: shown by default on devices where the primary input is
 * touch (matchMedia "(pointer: coarse)") or when the project explicitly
 * enables them via settings. They hide when a real gamepad or keyboard+mouse
 * gives input (controller-friendly UX).
 */
export class VirtualJoysticks {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.parent  Container to append the overlay to.
   *                                   Defaults to document.body.
   * @param {boolean}     opts.enabled Force-show regardless of detection.
   * @param {string}      opts.theme   "dark" | "light".
   */
  constructor({ parent = document.body, enabled = null, theme = "dark" } = {}) {
    this.parent = parent;
    this.enabled = enabled; // null = auto-detect
    this.theme = theme;
    this.leftValue = { x: 0, y: 0 };
    this.rightValue = { x: 0, y: 0 };
    this.leftFire = false;
    this.rightFire = false;
    this.visible = false;
    this._wasAnyHardwareInput = false;
    this._hardwareInputGraceTimer = 0;
    this._activeTouches = new Map(); // touchId -> { side, startTime, startX, startY }
    this._el = null;
    this._leftKnob = null;
    this._rightKnob = null;
    this._leftBase = null;
    this._rightBase = null;
    this._deadzoneEls = [];
    this._onTouchStart = (e) => this.#touchStart(e);
    this._onTouchMove = (e) => this.#touchMove(e);
    this._onTouchEnd = (e) => this.#touchEnd(e);
    this._onCancel = (e) => this.#touchEnd(e);
    this._onHardwareInput = () => this.#hardwareInput();
  }

  /** Auto-detect: coarse pointer / first touch / `navigator.maxTouchPoints`. */
  static shouldAutoShow() {
    if (typeof window === "undefined") return false;
    if (window.matchMedia?.("(pointer: coarse)").matches) return true;
    if ((navigator.maxTouchPoints ?? 0) > 0) return true;
    return false;
  }

  /** Attaches the overlay to the DOM and starts listening. */
  attach() {
    if (this._el) return;
    const shouldShow = this.enabled ?? VirtualJoysticks.shouldAutoShow();
    this.#buildDOM();
    if (!shouldShow) {
      this._el.style.display = "none";
    } else {
      this.visible = true;
    }
    this.parent.appendChild(this._el);
    window.addEventListener("touchstart", this._onTouchStart, { passive: false });
    window.addEventListener("touchmove", this._onTouchMove, { passive: false });
    window.addEventListener("touchend", this._onTouchEnd, { passive: false });
    window.addEventListener("touchcancel", this._onCancel, { passive: false });
    window.addEventListener("keydown", this._onHardwareInput, { capture: true });
    window.addEventListener("pointerdown", this._onHardwareInput, { capture: true });
  }

  detach() {
    if (!this._el) return;
    window.removeEventListener("touchstart", this._onTouchStart);
    window.removeEventListener("touchmove", this._onTouchMove);
    window.removeEventListener("touchend", this._onTouchEnd);
    window.removeEventListener("touchcancel", this._onCancel);
    window.removeEventListener("keydown", this._onHardwareInput, { capture: true });
    window.removeEventListener("pointerdown", this._onHardwareInput, { capture: true });
    this._el.remove();
    this._el = null;
    this._activeTouches.clear();
    this.leftValue = { x: 0, y: 0 };
    this.rightValue = { x: 0, y: 0 };
    this.leftFire = this.rightFire = false;
  }

  /** Called by the manager each frame. Releases fire edges. */
  tick(dt) {
    // After hardware input, hide for a grace period (3s) so the player can
    // switch from gamepad to touch without the joysticks fighting them.
    if (this._hardwareInputGraceTimer > 0) {
      this._hardwareInputGraceTimer = Math.max(0, this._hardwareInputGraceTimer - dt);
      if (this._hardwareInputGraceTimer === 0 && this.visible) {
        this._el.style.display = "none";
        this.visible = false;
      }
    }
  }

  /** Whether the manager should expose virtualjoystick controls. */
  isVisible() {
    return this.visible;
  }

  // ---- Manager-facing device API ----
  isPressed(path) {
    const [, side, control] = path.split("/");
    if (control === "fire") return side === "left" ? this.leftFire : this.rightFire;
    return false;
  }

  readValue(path) {
    const [, side, control] = path.split("/");
    if (control === "stick") return side === "left" ? this.leftValue : this.rightValue;
    return 0;
  }

  reset() {
    this.leftValue = { x: 0, y: 0 };
    this.rightValue = { x: 0, y: 0 };
    this.leftFire = this.rightFire = false;
    this._activeTouches.clear();
  }

  // ---- Internals ----

  #buildDOM() {
    const root = document.createElement("div");
    root.className = `virtual-joysticks theme-${this.theme}`;
    root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999;";
    const mkBase = (side) => {
      const base = document.createElement("div");
      base.className = `vj-base vj-${side}`;
      base.dataset.side = side;
      base.style.cssText = `
        position:absolute;bottom:14%;width:120px;height:120px;border-radius:50%;
        background:rgba(255,255,255,0.10);border:2px solid rgba(255,255,255,0.30);
        ${side === "left" ? "left:6%" : "right:6%"};
        display:none;align-items:center;justify-content:center;`;
      const knob = document.createElement("div");
      knob.className = "vj-knob";
      knob.style.cssText = `
        width:54px;height:54px;border-radius:50%;
        background:rgba(255,255,255,0.45);border:2px solid rgba(255,255,255,0.55);`;
      base.appendChild(knob);
      root.appendChild(base);
      return { base, knob };
    };
    const L = mkBase("left");
    const R = mkBase("right");
    this._el = root;
    this._leftBase = L.base;
    this._leftKnob = L.knob;
    this._rightBase = R.base;
    this._rightKnob = R.knob;
  }

  #hardwareInput() {
    // Hide the overlay as soon as the player touches keyboard/mouse — give
    // them 3s of grace in case they're still using gamepad.
    this._wasAnyHardwareInput = true;
    this._hardwareInputGraceTimer = 3;
    if (this._el && this.visible && this.enabled !== true) {
      this._el.style.display = "none";
      this.visible = false;
    }
  }

  #touchStart(e) {
    if (!this._el || !this.visible) {
      // First touch: become visible unless explicitly disabled.
      if (this.enabled === false) return;
      this._el.style.display = "block";
      this.visible = true;
    }
    const w = window.innerWidth;
    for (const t of e.changedTouches) {
      const x = t.clientX;
      const y = t.clientY;
      // Side determined by X at touch-down — touches starting on the left
      // half become the move stick; the right half becomes the look stick.
      const side = x < w / 2 ? "left" : "right";
      this._activeTouches.set(t.identifier, { side, startTime: performance.now(), startX: x, startY: y, x, y });
      this.#showBase(side, x, y);
      this.#updateStick(side, x, y, x, y);
    }
    e.preventDefault();
  }

  #touchMove(e) {
    for (const t of e.changedTouches) {
      const entry = this._activeTouches.get(t.identifier);
      if (!entry) continue;
      entry.x = t.clientX;
      entry.y = t.clientY;
      this.#updateStick(entry.side, entry.startX, entry.startY, t.clientX, t.clientY);
    }
    e.preventDefault();
  }

  #touchEnd(e) {
    for (const t of e.changedTouches) {
      const entry = this._activeTouches.get(t.identifier);
      if (!entry) continue;
      // Quick tap (touch lasted < 180ms and barely moved) -> fire edge.
      const elapsed = performance.now() - entry.startTime;
      const moved = Math.hypot(t.clientX - entry.startX, t.clientY - entry.startY);
      if (elapsed < 180 && moved < 12) {
        if (entry.side === "left") this.leftFire = true;
        else this.rightFire = true;
        // Auto-release fire after a short pulse so consumers see the edge.
        setTimeout(() => {
          if (entry.side === "left") this.leftFire = false;
          else this.rightFire = false;
        }, 80);
      }
      this._activeTouches.delete(t.identifier);
      // If the opposite side is also gone, hide its base; else keep the
      // base where it last was (the touch never left that side).
      if (![...this._activeTouches.values()].some((e2) => e2.side === entry.side)) {
        this.#hideBase(entry.side);
        this.#updateStick(entry.side, 0, 0, 0, 0);
      }
    }
  }

  #showBase(side, x, y) {
    const base = side === "left" ? this._leftBase : this._rightBase;
    base.style.left = `${x - 60}px`;
    base.style.top = `${y - 60}px`;
    base.style.display = "flex";
  }

  #hideBase(side) {
    const base = side === "left" ? this._leftBase : this._rightBase;
    base.style.display = "none";
  }

  #updateStick(side, baseX, baseY, touchX, touchY) {
    const dx = touchX - baseX;
    const dy = touchY - baseY;
    const radius = 60; // matches the joystick base half-size
    const mag = Math.hypot(dx, dy);
    const clamped = mag > radius ? { x: (dx / mag) * radius, y: (dy / mag) * radius } : { x: dx, y: dy };
    const knob = side === "left" ? this._leftKnob : this._rightKnob;
    knob.style.transform = `translate(${clamped.x - 27}px, ${clamped.y - 27}px)`;
    const norm = { x: clamped.x / radius, y: -clamped.y / radius }; // y-up matches Unity
    if (side === "left") this.leftValue = norm;
    else this.rightValue = norm;
  }
}

/**
 * Standalone helper used by the manager: poll all gamepads' axes/buttons
 * from the W3C Gamepad API. (Re-exported here so callers don't have to
 * reach into devices/GamepadDevice.js just to poll.)
 */
export { pollAllGamepads };