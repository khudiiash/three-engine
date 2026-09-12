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

/**
 * §11.55 (2026-09-11) — THE WORLD RATE FOLLOWS THE LIGHT-MOTION DRIVE.
 *
 * Awake used to mean one rate: any drive above the rest threshold ran the
 * transport at GI_WORLD_UPDATE_HZ, so a sun creeping round a 3-minute day
 * (2°/s, drive ~0.35) paid the same 30 chains a second as a 1-minute day
 * (drive ~1). Measured on the user's Sponza build at 2872×1532: the chain at
 * 30 Hz is ~5.7 ms of a 22.7 ms GPU frame; at 15 Hz ~3.7 ms. The drive is
 * already the transport's own measure of how fast the field is being
 * invalidated (`srcSystem`'s α ramp), so the rate rides it: rest at the rest
 * rate, the full rate only once the drive says the light is really moving,
 * a smooth step between. Fractional rates are fine — the cadence is a
 * wall-clock accumulator.
 *
 * The rate on its own would double the field's lag behind a slow sun, so the
 * transport's α is rate-compensated (`giRateCompensatedAlpha`): the per-second
 * decay is held constant, so t50/t90 in wall time do not move. What moves is
 * the per-update variance (fewer updates carry the same evidence rate), and
 * on the drive band this lands where the α ramp already runs (0.05-0.1).
 * `__giWorldRateDrive = false` restores the binary awake rate for an A/B.
 */
export const GI_WORLD_DRIVE_LOW = 0.05;
export const GI_WORLD_DRIVE_HIGH = 0.6;

export function giWorldRateHz({
  rested,
  drive,
  restHz = GI_WORLD_REST_HZ,
  updateHz = GI_WORLD_UPDATE_HZ,
  scaled = true,
} = {}) {
  if (rested) return restHz;
  if (!scaled) return updateHz;
  const d = Number(drive);
  if (!Number.isFinite(d)) return updateHz;
  const t = Math.min(1, Math.max(0, (d - GI_WORLD_DRIVE_LOW) / (GI_WORLD_DRIVE_HIGH - GI_WORLD_DRIVE_LOW)));
  const s = t * t * (3 - 2 * t);
  return restHz + (updateHz - restHz) * s;
}

/**
 * The per-update α that gives the SAME per-second decay at `hz` as `alpha`
 * gives at `baseHz`: (1 − α')^hz = (1 − α)^baseHz. Identity at or above the
 * base rate, so the full-rate path is bit-for-bit what it was.
 */
export function giRateCompensatedAlpha(alpha, hz, baseHz = GI_WORLD_UPDATE_HZ) {
  const a = Math.min(1, Math.max(0, Number(alpha) || 0));
  const rate = Number(hz);
  if (!(rate > 0) || !(baseHz > 0) || rate >= baseHz) return a;
  return 1 - (1 - a) ** (baseHz / rate);
}
