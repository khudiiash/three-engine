/**
 * SUSPENDING SIMULATION FOR A MODAL EDITOR MODE.
 *
 * Reported 2026-09-07: "when entering geometry editing mode, all the components
 * currently ticking in the editor viewport must be stopped: they must be
 * causing freezes and lags in the geometry editor." They were right about the
 * mechanism — the geometry editor draws through its OWN renderer and its OWN
 * rAF loop, while the engine kept ticking and rendering the main canvas at full
 * rate behind an opaque overlay: the water solver dispatching its FFT chain
 * every frame, GI's g-buffer prepass re-rendering the scene, batching/merging/
 * impostors re-grouping, all into pixels nobody can see, on the one main thread
 * the geometry editor needs.
 *
 * `Engine.suspendSimulation(reason)` is the seam. What this file pins is the
 * part that is easy to get wrong and impossible to see when it breaks:
 *
 *   · it is REF-COUNTED BY REASON, so two holders cannot resume each other;
 *   · resuming a reason that was never held, or resuming twice, is a no-op
 *     rather than an underflow that silently un-suspends a live hold;
 *   · it is NOT play mode, NOT `paused`, and NOT `renderSuspended` — that last
 *     one is GI's flag, and suspending the DRAW while still running preRender
 *     re-creates the ShadowFreeze latch documented in Engine.#tick.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The Engine constructs an InputManager, which reaches for `document` to defer
// its attach until DOMContentLoaded. Nothing under test here touches the DOM,
// so the smallest stub that lets the constructor finish is the honest one —
// anything richer would be pretending this test knows about a browser.
globalThis.document ??= {
  body: {},
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

const { Engine } = await import("../src/engine/Engine.js");

function makeEngine() {
  // A bare Engine: no renderer, no canvas. Everything under test is state.
  return new Engine();
}

test("a hold suspends, and releasing it resumes", () => {
  const engine = makeEngine();
  assert.equal(engine.simulationSuspended, false, "an engine starts running");

  const release = engine.suspendSimulation("geometry-edit");
  assert.equal(engine.simulationSuspended, true);
  assert.deepEqual(engine.simulationHolds, ["geometry-edit"]);

  release();
  assert.equal(engine.simulationSuspended, false);
  assert.deepEqual(engine.simulationHolds, []);
});

test("two holders do not resume each other", () => {
  const engine = makeEngine();
  engine.suspendSimulation("geometry-edit");
  engine.suspendSimulation("lightmap-bake");
  assert.equal(engine.simulationSuspended, true);

  engine.resumeSimulation("geometry-edit");
  assert.equal(
    engine.simulationSuspended, true,
    "the bake still holds it — this is the whole reason it is a set and not a boolean",
  );
  assert.deepEqual(engine.simulationHolds, ["lightmap-bake"]);

  engine.resumeSimulation("lightmap-bake");
  assert.equal(engine.simulationSuspended, false);
});

test("the same reason twice is one hold, and resuming twice is harmless", () => {
  const engine = makeEngine();
  engine.suspendSimulation("geometry-edit");
  engine.suspendSimulation("geometry-edit");
  engine.resumeSimulation("geometry-edit");
  assert.equal(engine.simulationSuspended, false, "a set, so the second suspend added nothing to release");

  // An unbalanced resume must not underflow into a state where a LATER hold
  // reads as already released.
  engine.resumeSimulation("geometry-edit");
  engine.resumeSimulation("never-held");
  engine.suspendSimulation("geometry-edit");
  assert.equal(engine.simulationSuspended, true);
});

test("it announces both edges, so a consumer can react without polling", () => {
  const engine = makeEngine();
  const seen = [];
  engine.on("simulation-suspended", (holds) => seen.push(["suspended", [...holds]]));
  engine.on("simulation-resumed", () => seen.push(["resumed"]));

  engine.suspendSimulation("geometry-edit");
  engine.suspendSimulation("lightmap-bake");
  engine.resumeSimulation("geometry-edit");
  engine.resumeSimulation("lightmap-bake");

  assert.deepEqual(seen, [
    ["suspended", ["geometry-edit"]],
    ["suspended", ["geometry-edit", "lightmap-bake"]],
    ["resumed"],
  ], "resumed fires ONCE, when the last hold goes — not per release");
});

test("it is not play mode, not paused, and not renderSuspended", () => {
  const engine = makeEngine();
  engine.suspendSimulation("geometry-edit");
  assert.equal(engine.playing, false, "suspending must not change the mode");
  assert.equal(engine.paused, false, "suspending must not stop game time");
  assert.notEqual(
    engine.renderSuspended, true,
    "renderSuspended is GI's flag; a second writer clobbers its compile-wave bookkeeping, "
      + "and suspending the draw while preRender still runs latches ShadowFreeze off",
  );
});

test("a component tick guard reads the flag the consumers actually check", () => {
  // The guard every per-frame consumer uses is
  // `engine.simulationSuspended === true`. Pinned as a shape so a rename
  // cannot leave the consumers silently ticking again — the failure mode is
  // invisible: everything still works, it is just slow, which is exactly the
  // report this fixes.
  const engine = makeEngine();
  let ticks = 0;
  const tick = () => {
    if (engine.simulationSuspended === true) return;
    ticks++;
  };

  tick();
  assert.equal(ticks, 1);
  engine.suspendSimulation("geometry-edit");
  tick();
  tick();
  assert.equal(ticks, 1, "a suspended engine runs no simulation ticks");
  engine.resumeSimulation("geometry-edit");
  tick();
  assert.equal(ticks, 2, "and resumes from where it stood, with nothing torn down");
});
