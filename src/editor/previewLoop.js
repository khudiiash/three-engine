// Frame budget for the editor's SECONDARY renderers.
//
// Several panels (material preview, asset preview, geometry editor) each own a
// full extra WebGPURenderer and drove it at the display refresh rate, forever,
// while the panel was open — the material preview even spins its sphere, so it
// can never settle into an idle "nothing changed" state. On a 120Hz display
// that is a second (and third) queue submit + swapchain present competing with
// the viewport EVERY frame, which shows up as viewport frame drops and CPU
// spikes rather than as GPU load: the work is small, but it serializes against
// the main present.
//
// A rotating thumbnail does not need 120fps. These helpers cap a preview at a
// sane rate and skip entirely when it cannot be seen (background browser tab,
// collapsed dock tab, scrolled out of view). The viewport keeps the rest.

/** Preview refresh rate. Smooth enough for a spinning thumbnail, ~4× cheaper
 *  than vsync on a 120Hz display. */
export const PREVIEW_FPS = 30;

/**
 * True when `canvas` is worth rendering into: laid out, still in the document,
 * and in a visible tab. Cheap enough to call per frame.
 */
export function previewVisible(canvas) {
  if (!canvas || !canvas.isConnected) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  return canvas.clientWidth >= 1 && canvas.clientHeight >= 1;
}

/**
 * Wraps a preview's per-frame callback so it runs at most `fps` times a second
 * and never while hidden. Returns a function to pass straight to
 * `renderer.setAnimationLoop` / `requestAnimationFrame`.
 *
 * The callback still receives the REAL elapsed time, so anything integrating
 * motion (Timer/mixer deltas) advances by wall-clock and animates at the same
 * speed it did before the cap.
 */
export function throttlePreviewFrame(canvas, onFrame, fps = PREVIEW_FPS) {
  const interval = 1000 / fps;
  let last = -Infinity;
  return (time) => {
    if (!previewVisible(canvas)) return;
    const now = time ?? performance.now();
    if (now - last < interval) return;
    last = now;
    onFrame();
  };
}

/**
 * ⛔⛔ **`setAnimationLoop(null)` DOES NOT STOP THE FRAME CALLBACK.** three's
 * `Renderer.setAnimationLoop` only assigns `_animation._animationLoop`; the rAF
 * chain itself is started once by `Renderer.init()` and stopped by nothing —
 * not by passing null, and not by `dispose()`, which merely calls
 * `setAnimationLoop(null)` on its way out.
 *
 * So EVERY secondary renderer this editor has ever created keeps a callback
 * running on the main thread for the life of the page, re-arming itself every
 * frame and calling `info.reset()` and `nodes.nodeFrame.update()` each time,
 * long after its panel closed and its device went away. They are invisible to
 * the engine's own profiler, which only measures inside its own tick, and they
 * land in the frame as time the profiler then reports as idle.
 *
 * Measured on 2026-09-09: one extra chain, ~2.0 ms of every frame, in a frame
 * whose whole budget at 120 Hz is 8.3 ms.
 *
 * Call this instead of `setAnimationLoop(null)` when a preview is torn down.
 * `_animation` is private API; treat its absence as "nothing to stop" rather
 * than an error, so a three upgrade that renames it degrades to today's
 * behaviour instead of throwing on every panel close.
 */
export function stopPreviewRenderer(renderer) {
  if (!renderer) return;
  renderer.setAnimationLoop(null);
  try {
    renderer._animation?.stop?.();
  } catch {
    /* private API: a rename must not break panel teardown */
  }
}
