// @ts-check
/**
 * The editor's viewport-rendering policy, on its own so it can be checked
 * headlessly.
 *
 * `editorFramePacing.js` imports the live engine at module scope, which drags
 * three.js and a WebGPU renderer behind it — fine in a browser, impossible in a
 * node test. The decisions themselves are arithmetic and deserve to be provable.
 */

/**
 * Whether the viewport should render at all.
 *
 * A viewport nobody is looking at can be pure cost: a heavy scene rendering
 * behind a paint canvas or a node graph makes the WHOLE editor lag and is buying
 * nothing. Throttling it to a few frames a second was not enough — one 60ms
 * frame still lands in the middle of a brush stroke — so when the user opts in,
 * an unfocused viewport stops completely and `editorFramePacing` wakes it when
 * something it draws actually changes. That keeps the picture honest without
 * holding a render loop open for a panel nobody is looking at.
 *
 * Play is the exception and always will be: the game is the thing being watched
 * even when the pointer is in the Inspector.
 *
 * `freeze` is the user's preference (Project Settings → Editor, on by default —
 * see `viewportFreeze.js`). It is a plain parameter here rather than a read of
 * that module so this stays a pure function; the default below is "don't
 * suspend", the conservative answer for a caller that didn't say. A hidden
 * viewport still stops either way: an element with no box on screen cannot be
 * being watched, whatever the preference says.
 *
 * ⭐ `appFocused` IS A DIFFERENT QUESTION FROM `focused`, AND IT WAS MISSING.
 * `focused` asks which DOCK PANEL the user is working in; it is `true` for a
 * viewport whose group is active even when the whole editor window is behind
 * another application. `document.hidden` does not cover the gap either — in a
 * Tauri/WebView2 window it stays false while the window merely sits behind
 * Chrome, so alt-tabbing away from the editor left the viewport rendering at
 * full rate. That is the "there is no way to stop rendering; I have to close
 * the editor to test the browser build cleanly" report (user, 2026-09-11):
 * measuring an exported build on the same GPU means the editor's frame is
 * stealing from the thing being measured. A window nobody has in the
 * foreground is the clearest case of nobody looking there is.
 *
 * It is gated on the same `freeze` preference as panel focus — turning the
 * toggle off restores rendering-while-blurred — and `held` still wins, so the
 * profiler keeps measuring a viewport it deliberately holds awake.
 */
export function shouldSuspendViewport({
  playing = false,
  visible = true,
  focused = true,
  appFocused = true,
  freeze = false,
  held = false,
} = {}) {
  // Play is exempt from PANEL focus — the game is the thing being watched even
  // when the pointer is in the Inspector — but not from the window being in the
  // background. A game running behind another app is not being watched either,
  // which is exactly the case the GPU has to be free for.
  if (playing && appFocused) return false;
  // Hidden behind another dock tab beats everything: nothing is watching it
  // then either, and a "hold" is a request to watch, not a request to burn.
  if (!visible) return true;
  // Something is watching the viewport itself rather than the panel that
  // happens to hold focus — the profiler, an animation audition. See
  // `holdViewportAwake`.
  if (held) return false;
  if (freeze && !appFocused) return true;
  if (playing) return false;
  return freeze && !focused;
}

/**
 * The frame-rate cap for a viewport that IS rendering, or 0 for uncapped.
 *
 * This is about sharing the main thread during heavy work, not about idleness:
 * an idle scene runs uncapped because capping it buys nothing and costs
 * smoothness while orbiting.
 *
 * `gesture` means the pointer is actively dragging ON the viewport canvas —
 * an orbit, a gizmo drag, a transform. That is the one moment the viewport
 * must never be capped: the heavy work IS what the user is steering, and the
 * work-based caps below turned a heavy-scene orbit into a visible stutter that
 * came and went as workMs crossed their thresholds.
 *
 * @param {number} workMs how long the last frame's GPU/CPU work took
 * @param {{ interacting?: boolean, playing?: boolean, gesture?: boolean }} [state]
 * @returns {number} an fps cap, or 0 for uncapped
 */
export function editorFrameRateFor(workMs, { interacting = false, playing = false, gesture = false } = {}) {
  if (playing || gesture || !(workMs > 0)) return 0;
  if (interacting && workMs >= 14) return 15;
  if (workMs >= 42) return 20;
  if (workMs >= 24) return 30;
  return 0;
}
