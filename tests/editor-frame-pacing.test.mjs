import test from "node:test";
import assert from "node:assert/strict";
import { editorFrameRateFor, shouldSuspendViewport } from "../src/editor/framePolicy.js";

test("editor frame pacing leaves cheap and play-mode frames uncapped", () => {
  assert.equal(editorFrameRateFor(10), 0);
  assert.equal(editorFrameRateFor(60, { playing: true }), 0);
});

test("editor frame pacing yields progressively more time for expensive frames", () => {
  assert.equal(editorFrameRateFor(25), 30);
  assert.equal(editorFrameRateFor(50), 20);
  assert.equal(editorFrameRateFor(25, { interacting: true }), 15);
});

test("a direct viewport gesture is never capped, whatever the frame costs", () => {
  assert.equal(editorFrameRateFor(50, { gesture: true }), 0);
  assert.equal(editorFrameRateFor(25, { interacting: true, gesture: true }), 0);
});

test("a hold keeps an unfocused viewport drawing, but never a hidden one", () => {
  // The profiler docked beside the viewport: it owns the focus, and pausing
  // the viewport would make it measure its own side effect.
  assert.equal(
    shouldSuspendViewport({ visible: true, focused: false, freeze: true, held: true }),
    false,
  );
  // Without the hold, the same state is exactly what the freeze is for.
  assert.equal(
    shouldSuspendViewport({ visible: true, focused: false, freeze: true }),
    true,
  );
  // Hidden behind another dock tab beats a hold: nothing is watching either.
  assert.equal(
    shouldSuspendViewport({ visible: false, focused: false, freeze: true, held: true }),
    true,
  );
  // And a hold changes nothing when the viewport was going to draw anyway.
  assert.equal(
    shouldSuspendViewport({ visible: true, focused: true, freeze: true, held: true }),
    false,
  );
});

test("an unfocused editor WINDOW stops the viewport, panel focus notwithstanding", () => {
  // The reported case: the viewport's own dock group is still the active one
  // and the window is not `document.hidden` — it is simply behind Chrome while
  // the user measures an exported build on the same GPU.
  assert.equal(
    shouldSuspendViewport({ visible: true, focused: true, appFocused: false, freeze: true }),
    true,
  );
  // Play mode is exempt from PANEL focus but not from the window being in the
  // background: a game nobody has in the foreground is not being watched.
  assert.equal(
    shouldSuspendViewport({ playing: true, visible: true, focused: true, appFocused: false, freeze: true }),
    true,
  );
  assert.equal(
    shouldSuspendViewport({ playing: true, visible: true, focused: false, appFocused: true, freeze: true }),
    false,
  );
  // The preference still governs it — turning the toggle off keeps drawing.
  assert.equal(
    shouldSuspendViewport({ visible: true, focused: true, appFocused: false, freeze: false }),
    false,
  );
  // A hold still wins: the profiler deliberately measures a viewport whose
  // window may not hold focus.
  assert.equal(
    shouldSuspendViewport({ visible: true, focused: true, appFocused: false, freeze: true, held: true }),
    false,
  );
  // Absent (an older caller that never passed it) must mean "focused", so
  // every existing decision is unchanged.
  assert.equal(
    shouldSuspendViewport({ visible: true, focused: true, freeze: true }),
    false,
  );
});
