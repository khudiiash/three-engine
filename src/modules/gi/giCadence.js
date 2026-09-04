export const GI_WORLD_UPDATE_HZ = 30;
/** The world chain's REST rate (2026-09-02): when the transport's rest drive is
 *  ~0 — camera parked, lights and emitters unchanged, no light surprise — the
 *  probe update runs at half rate. Movers alone do not lift it: their GI
 *  influence is low-frequency, and the screen passes keep their own cadence. */
export const GI_WORLD_REST_HZ = 15;
/** §11.34 CONVERGED IDLE: once every light is declared static (LightComponent
 *  `mobility`), the transport's rest drive is ~0 AND the static inputs (lights,
 *  emitters, sky, knobs — not the movers) have held still for this long, the
 *  world chain is not dispatched at all. The rest cadence above still costs
 *  ~20 ms of GPU every other frame on the user's Bistro for a field that has
 *  nothing left to learn; the hold is what makes "converged" true by the time
 *  the sleep begins (the rest rate's α 0.02 reaches steady state in ~2 s).
 *  Any drive — a light drag, a camera move, a sky or emitter edit, a rebuild —
 *  wakes it on the same frame. `__giWorldIdle = false` disables the sleep. */
export const GI_WORLD_IDLE_AFTER_MS = 3000;
/** Screen passes that shade the whole view (emitter shadows, the exact
 *  reflection prepass, the hit shade) run every Nth frame when ONLY movers
 *  changed under a parked camera (the static g-buffer key is held) — one
 *  animated character used to force all of them every frame. */
export const GI_MOVER_ONLY_STRIDE = 2;

/**
 * Fixed-rate accumulator for persistent GI world transport. It never catches
 * up with multiple updates in one render frame: when rendering is slower than
 * the target, every frame advances transport once; above the target, spare
 * frames reuse the last world result while camera-dependent gather/AO still
 * run. This keeps convergence measured in wall time instead of tying one full
 * transport update to every presented frame.
 */
export function stepGiWorldCadence(nowMs, nextAtMs, hz = GI_WORLD_UPDATE_HZ) {
  const now = Number(nowMs);
  const rate = Number(hz);
  if (!(rate > 0) || !Number.isFinite(now)) return { due: true, nextAt: now };
  const period = 1000 / rate;
  let next = Number(nextAtMs);
  if (!Number.isFinite(next) || next < now - period * 8 || next > now + period * 8) {
    return { due: true, nextAt: now + period };
  }
  if (now < next) return { due: false, nextAt: next };
  do next += period;
  while (next <= now);
  return { due: true, nextAt: next };
}

/**
 * Recovery valve for a renderer that is already below the transport target.
 * Persistent world transport may skip every other slow frame; screen-space
 * gather, AO and reflections remain outside this decision and still dispatch.
 */
export function shouldDispatchGiWorld({ due, frameGapMs, dispatchedPreviousFrame, hz = GI_WORLD_UPDATE_HZ }) {
  if (!due) return false;
  const rate = Number(hz);
  if (!(rate > 0)) return true;
  const slowFrame = Number(frameGapMs) > (1000 / rate) * 1.05;
  return !slowFrame || !dispatchedPreviousFrame;
}
