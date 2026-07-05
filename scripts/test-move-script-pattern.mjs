// Reference implementation of a `Move.ts` script that reads WASD via the
// engine's default Player action map. Mirrors what the user should write.
//
// Three common pitfalls are flagged inline so they're easy to spot in code
// review.

import { Script, attribute } from "engine";

export default class Move extends Script {
  // ① Define inspector-editable fields with @attribute.
  @attribute({ type: "number", default: 6, min: 0.1, max: 30, step: 0.1, label: "Move Speed" })
  moveSpeed = 6;

  onStart() {
    // ② ② ② `this.input` is injected by ScriptComponent before any hook
    // runs, but only if you `extends Script` (or the runtime equivalent). If
    // you skip `extends Script`, the property still gets injected at runtime
    // (it's set on the instance by ScriptComponent.#bind), but TypeScript
    // will say `this.input` doesn't exist — and your IDE autocomplete for
    // `this.input?.readValue(...)` will be gone.
  }

  onUpdate(dt) {
    // ③ `this.input` is non-null at runtime; the `?` is purely a TS guard
    // because the ambient typings type it as `ScriptInputManager | null`.
    const input = this.input;
    if (!input) return;

    // ④ The default Player action map ships with a "Move" action whose
    // bindings include WASD (via a 2D composite) + arrow keys + gamepad
    // left stick + virtual joystick. `readValue("Move")` returns {x, y}
    // where +x is strafe-right and +y is forward (matches Unity convention).
    const move = input.readValue("Move");
    // After the type narrowing fix in the previous turn, `move` is the union
    // `boolean | number | { x; y }`. We narrow on typeof.
    if (typeof move !== "object" || move === null) return;

    // ⑤ Most common bug: trying to use `move.x` directly without checking
    // it was an object — `readValue` returns `0` (a number) for missing
    // actions and `false` for buttons, so the typeof guard above is the
    // safe pattern.
    this.entity.position.x += move.x * this.moveSpeed * dt;
    this.entity.position.z += move.y * this.moveSpeed * dt;
  }
}

// ---- Quick checklist when "nothing happens" ----
//
// A. Press the **Play** button. Scripts only run their `onUpdate` while the
//    engine is in play mode (see ScriptComponent: `this.running` is gated by
//    `engine.playing`). Edit-mode previews don't execute game logic.
//
// B. Make sure the script is attached to an entity AND the script's `path`
//    property points at this file. The Inspector for a ScriptComponent has
//    a "File" picker — empty/missing = no class loaded.
//
// C. Confirm the "Player" action map is on the active stack. Open the
//    **Window → Input** panel — the Player map toggle should be ON. If a
//    custom map replaced it, your "Move" action may live there instead.
//
// D. Add a `InputDebugHud.js` entity (from examples/input-demo) with
//    mapName = "Player". It prints every action's live value each frame —
//    if "Move" stays at (0.00, 0.00) while you press keys, the issue is
//    either the keyboard device (click on the viewport to focus the canvas)
//    or the binding (try the default Player map).
//
// E. If `this.input` is `null`, your script doesn't `extends Script` AND
//    the runtime hasn't injected the context yet (impossible normally, but
//    if you've subclassed another class or used a wrapper, double-check).
//
// F. If your `Move.ts` imports something that throws at module-evaluation
//    time, the whole script fails to load — check the browser console for
//    "Script \"...\" failed to load: ..." messages from ScriptComponent.