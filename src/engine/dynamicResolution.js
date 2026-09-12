// dynamicResolution — the frame budget the DRS controller aims at.
//
// `performance.targetFps` is AUTHORED (60/90/120) and a display can be slower
// than it. A phone hands the page 60 callbacks a second at most, and a
// controller chasing 120 there measures every frame as 100 % over budget,
// backs the scale off to its 0.5 floor and stays there: the build ran
// "pixelated as if pixel ratio was 1 or lower" (2026-09-11) with a 2× ratio
// authored. The controller can only ever LOWER resolution, so its target must
// be a rate the display can actually show: the authored one, capped at the
// most callbacks per second the host has ever handed us. The PEAK, not the
// live rate — a phone that fell to 30 because frames were slow would
// otherwise teach the controller that 30 is the display, and it would never
// buy the resolution back.
export function drsBudgetMs(targetFps, peakCallbackFps = 0) {
  const authored = targetFps > 0 ? targetFps : 60;
  // Under 24 there is no evidence of a display rate yet (a stalled boot, a
  // tab in the background) — leave the authored target alone.
  const display = peakCallbackFps >= 24 ? peakCallbackFps : Infinity;
  return 1000 / Math.min(authored, display);
}
