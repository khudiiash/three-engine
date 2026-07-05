/**
 * Raw touchscreen device. Tracks active touches by identifier (so a second
 * finger landing while the first is still down gets its own entry). The
 * virtual joystick layer consumes this and exposes higher-level "leftStick"
 * / "rightStick" vec2 controls that action maps can bind to.
 *
 * Control paths:
 *   touch/primary  — vec2 normalized [0..1] of the first active touch,
 *                     or {x: 0, y: 0} when no touches.
 *   touch/count    — scalar: number of currently active touches.
 *   touch/<i>      — vec2 of touch i (0-based) or {0,0} when fewer.
 *
 * For mobile games the developer usually binds Virtual Joysticks (the
 * touchoverlay.js layer) — these raw paths are there for gesture-style
 * controls (swipe, tap) and direct touch ID usage.
 */
export class TouchDevice {
  constructor() {
    this.id = "touch";
    this.name = "Touchscreen";
    this.connected = typeof window !== "undefined" && "ontouchstart" in window;
    this.touches = []; // [{ id, x, y, startX, startY }], normalized 0..1
    this._target = null;
    this._onStart = (e) => this.#update(e.changedTouches, "start");
    this._onMove = (e) => this.#update(e.changedTouches, "move");
    this._onEnd = (e) => this.#update(e.changedTouches, "end");
    this._onCancel = (e) => this.#update(e.changedTouches, "cancel");
  }

  attach(target = window) {
    this._target = target;
    target.addEventListener("touchstart", this._onStart, { passive: false });
    target.addEventListener("touchmove", this._onMove, { passive: false });
    target.addEventListener("touchend", this._onEnd, { passive: false });
    target.addEventListener("touchcancel", this._onCancel, { passive: false });
  }

  detach() {
    if (!this._target) return;
    this._target.removeEventListener("touchstart", this._onStart);
    this._target.removeEventListener("touchmove", this._onMove);
    this._target.removeEventListener("touchend", this._onEnd);
    this._target.removeEventListener("touchcancel", this._onCancel);
    this._target = null;
    this.touches = [];
  }

  #update(changed, phase) {
    const t = this._target;
    const w = t.clientWidth || window.innerWidth;
    const h = t.clientHeight || window.innerHeight;
    for (const touch of changed) {
      const id = touch.identifier;
      const x = touch.clientX / w;
      const y = touch.clientY / h;
      const idx = this.touches.findIndex((tt) => tt.id === id);
      if (phase === "start") {
        if (idx === -1) this.touches.push({ id, x, y, startX: x, startY: y });
        else {
          // Browser re-fired start for an existing id (rare): refresh pos.
          this.touches[idx] = { id, x, y, startX: x, startY: y };
        }
      } else if (phase === "move") {
        if (idx !== -1) this.touches[idx].x = x, this.touches[idx].y = y;
      } else if (phase === "end" || phase === "cancel") {
        if (idx !== -1) this.touches.splice(idx, 1);
      }
    }
  }

  isPressed(path) {
    const which = path.split("/")[1];
    if (which === "any") return this.touches.length > 0;
    const i = parseInt(which, 10);
    return i < this.touches.length;
  }

  readValue(path) {
    const which = path.split("/")[1];
    if (which === "primary") return this.touches[0] ? { x: this.touches[0].x, y: this.touches[0].y } : { x: 0, y: 0 };
    if (which === "count") return this.touches.length;
    const i = parseInt(which, 10);
    return this.touches[i] ? { x: this.touches[i].x, y: this.touches[i].y } : { x: 0, y: 0 };
  }

  reset() {
    this.touches = [];
  }
}