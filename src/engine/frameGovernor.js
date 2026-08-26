/**
 * The frame-rate floor: a closed loop that spends QUALITY to buy TIME.
 *
 * ## Why this exists at all
 *
 * The user's standing rule is that the engine holds over 60 fps under ANY
 * conditions, and that when quality and the floor conflict the floor wins —
 * "degrade quality smoothly (resolution, stride, tier), never the frame rate".
 * No fixed workload can promise that. A scene's cost is a function of the
 * scene, the viewport, the GPU and, on a laptop, the THERMAL STATE of that GPU
 * (measured while writing this: an RTX 4070 Laptop at 2085 of 3105 MHz with
 * `SW Thermal Slowdown: Active` — a third of the clocks gone, mid-session, for
 * reasons no engine setting can see). The only thing that can promise a frame
 * rate is a controller that measures the frame and adjusts.
 *
 * ## What it controls, and why that one thing
 *
 * `engine.giCostScale` — a multiplier on the GI module's TRACED PIXEL budget,
 * read by `GISystem#screenResolveSize`. GI's screen chain (the gather resolve,
 * the BVH reflection trace, hit shading, the emitter shadow march) is the
 * overwhelming majority of the GPU frame on any scene that enables it, and all
 * of it is per-resolve-pixel work. MEASURED on Bistro at ultra, same camera,
 * same frame:
 *
 * | pixels | GPU     | CPU     |
 * |--------|---------|---------|
 * | 1.00x  | 45.7 ms | 30.8 ms |
 * | 0.25x  | 12.1 ms | 32.2 ms |
 *
 * 3.8x for 4x fewer pixels, and the CPU does not move — so this knob is very
 * nearly a pure GPU dial with no fixed floor hiding behind it. The
 * position-validated bilateral upsample reconstructs full-resolution edges
 * from the traced channel, which is why spending pixels here degrades much
 * more gracefully than spending them on the raster.
 *
 * ⚠ It does NOT touch `dynamicResolution`. That controller scales the canvas
 * and is deliberately divided back out of GI's sizing (a GI resize costs ~56
 * pipelines and every temporal accumulation, so letting a per-frame nudge
 * drive it made the loop hunt forever). The two are independent: DRS scales
 * the raster it was built for, this scales GI.
 *
 * ## Why a coarse ladder and not a continuous nudge
 *
 * Every change of the GI pixel budget re-creates the GI targets, resizes the
 * probe population and rebuilds the resolve pipeline. That is a HITCH, and the
 * same standing rule says a spike is a regression regardless of average cost.
 * So the controller is built to move as rarely as it can while still meeting
 * the floor:
 *
 * · a fixed six-rung ladder, so the whole session ever visits six pipeline
 *   sets and the driver's cache is warm after the first visit to each;
 * · descent is a SNAP, not a walk — cost is ~linear in pixels, so the loop
 *   solves for the rung it needs and goes there in ONE resize instead of
 *   stepping down three times and hitching three times;
 * · ascent is one rung at a time behind a much longer dwell, because climbing
 *   is speculative (it raises cost to find out whether the budget allows it)
 *   while descending is a response to a miss that has already happened.
 *
 * ## ⭐⭐ WHY IT CANNOT HUNT, WRITTEN AS AN INEQUALITY
 *
 * The loop hunts when one rung is "too slow" and the rung below it is "too
 * fast", so it can never rest. For a STATIONARY cost that is impossible by
 * construction, and the proof is short enough to keep here:
 *
 *   drop at rung n  requires  cost(n) > DROP_OVER x aim
 *   climb from n+1  requires  cost(n) x 0.72 < CLIMB_BELOW x aim
 *                      i.e.   cost(n) < (CLIMB_BELOW / 0.72) x aim = 0.944 x aim
 *
 * Both can only hold at once if `DROP_OVER < 0.944`, so any margin at all makes
 * oscillation unreachable. ⚠ THAT IS EXACTLY WHY THE FIRST VERSION LOOKED SAFE
 * AND STILL HUNTED IN THE FIELD: the proof assumes `aim` is a constant, and
 * `effectiveAim = max(budget, cpu)` had put a RAW PER-FRAME MEASUREMENT inside
 * it. With the aim itself moving between the drop and the climb, the condition
 * becomes `aim_high / aim_low > DROP_OVER / 0.944`, and at DROP_OVER = 1.0 a
 * SIX PERCENT wobble in CPU time is enough to sustain the cycle forever.
 * MEASURED on Bistro/ultra with a parked camera: 23 rung changes, a steady
 * 4-second cadence of full GI field rebuilds in the user's console, reported as
 * "gi constantly reloads".
 *
 * Three things close it, each with its own failing negative control in the gate:
 * 1. a CLIMB is judged against the lowest aim seen in the last ~20 s, not the
 *    live one, so a rung is only bought with headroom that has proved durable;
 * 2. the CPU is smoothed with the same EMA as the GPU, which stops a brief dip
 *    from arming a DROP (the floor deliberately does not guard that side);
 * 3. `DROP_OVER = 1.12` raises the wobble needed to sustain a cycle from 6% to
 *    19%, so the two filters above have far less to absorb.
 *
 * ## What it deliberately does NOT do
 *
 * Nothing when the frame is CPU-bound. Dropping traced pixels cannot buy back
 * a frame whose cost is draw submission, so a controller that reacted to total
 * frame time would strip a scene to its lowest rung and change nothing — a
 * silent quality loss bought for zero. The signal is the measured GPU time
 * ALONE, exactly as `#updateDynamicResolution` reasons about the same problem.
 * When the GPU has headroom the CPU is not using, the loop climbs back and
 * spends it, which is the correct answer to "the GPU is idle at 12 ms".
 */

/**
 * The rungs, as a fraction of the tier's own traced-pixel budget.
 *
 * Ratios of ~0.72 between neighbours: coarse enough that six rungs span a 5x
 * cost range (so one snap can absorb a thermal throttle or a 4K viewport),
 * fine enough that a single step is not a visible jump in GI detail.
 *
 * Rung 0 is exactly 1 — the tier's authored budget, untouched. A scene that
 * makes its target never leaves it, so the governor is invisible on hardware
 * that does not need it.
 */
export const GI_COST_LADDER = Object.freeze([1, 0.72, 0.52, 0.37, 0.27, 0.19]);

/**
 * Fraction of the frame budget the GPU half is allowed to occupy.
 *
 * Not 1.0: the budget is a FRAME budget and the GPU shares it with everything
 * the CPU must do before the submit. Aiming the GPU at the whole budget
 * guarantees the frame misses it.
 *
 * ⚠⚠ THIS AND `DROP_OVER` ARE A PAIR: the loop tolerates `aim x DROP_OVER`
 * before it acts, so `GPU_BUDGET_SHARE x DROP_OVER` is the real ceiling and it
 * MUST stay under 1.0 or the controller quietly settles below 60 fps. It was
 * 0.9, which with a 1.12 margin tolerates 16.8 ms — 59.5 fps, a floor
 * violation that no test would have caught because every fixture asserted
 * against `aimMs` rather than against the frame budget. The gate now asserts
 * `stats.dropOverMs <= 1000 / targetFps` directly.
 */
const GPU_BUDGET_SHARE = 0.8;

/**
 * Below this fraction of its aim, the loop starts looking for a rung up.
 *
 * DERIVED, not chosen: climbing one rung multiplies cost by `1 / 0.72 ≈ 1.389`
 * (the ladder's step ratio), so a climb is only safe from `0.95 / 1.389 ≈ 0.68`
 * of the aim — anything higher lands the next rung in a miss, and the loop
 * would drop straight back. It was 0.62 by feel, which left a needlessly wide
 * band where the loop would neither climb nor drop while sitting on quality it
 * could have afforded to give back.
 *
 * ⚠ This constant and GI_COST_LADDER's spacing are a PAIR. Widen the ladder's
 * steps and this must come down with them, or the loop starts oscillating.
 */
const CLIMB_BELOW = 0.68;

/**
 * How far PAST its aim the GPU must sit before a drop is worth its hitch.
 *
 * ⭐ ASYMMETRIC HYSTERESIS, AND IT IS NOT OPTIONAL. Without it the drop test is
 * "over the aim by any amount at all", so the loop treats the aim as a knife
 * edge and steps on every excursion across it. The band is now
 * `[0.68 x aim, 1.12 x aim]`, and a climb from the bottom of it lands at
 * `0.68 x 1.389 = 0.94` — still inside, so a climb cannot arm the next drop.
 */
const DROP_OVER = 1.12;

/**
 * Consecutive qualifying frames before a step. At 60 fps these are ~0.2 s and
 * ~0.5 s; the asymmetry is the descent-is-a-response/ascent-is-a-guess rule.
 */
const FRAMES_BEFORE_DROP = 12;
const FRAMES_BEFORE_CLIMB = 30;

/**
 * Floor on the interval between resizes, in ms. A GI resize is the expensive
 * event this whole design is arranged around; nothing may make one more often
 * than this however badly the frame is missing.
 *
 * ⚠ THE CLIMB FLOOR WAS 4000 AND THAT NUMBER IS IN THE USER'S CONSOLE. On
 * Bistro/ultra it produced a steady 4-second cadence of `[gi] src ... slot NEE
 * replaced` — ~20 full field rebuilds in four minutes on a PARKED camera,
 * reported as "gi constantly reloads". A climb is speculative and costs a full
 * GI rebuild plus every temporal history; it has no business being attempted
 * three times a minute.
 */
const MIN_DROP_INTERVAL_MS = 2000;
const MIN_CLIMB_INTERVAL_MS = 12_000;

/**
 * ⛔ THERE IS NO EXPONENTIAL BACKOFF ON THE CLIMB DWELL, AND THERE WAS ONE.
 *
 * It doubled the dwell on every climb that got reverted — 12 s, 24 s, 48 s — on
 * the reasoning that a loop repeatedly wrong about the headroom should stop
 * asking. It is deleted because a negative control could not tell it from its
 * absence: with the backoff patched out and the dwell pinned at its floor, the
 * whole gate still passed, ten-minute CPU-jitter fixture included. The aim
 * floor below removes the REASON for the reverted climbs, so bounding their
 * damage is bounding something that no longer happens. Same rule that retired
 * the settle window: a mechanism no fixture can justify is a knob nobody can
 * maintain, not belt and braces.
 */

/** EMA weight for the new sample. ~0.1 is roughly a 10-frame memory. */
const EMA_ALPHA = 0.1;

/**
 * The drop margin when the CPU is the binding constraint — see the payoff note
 * at the decision site. ≈ one ladder step (1/0.72 ≈ 1.39), so a CPU-bound drop
 * only fires when it can recover a full rung's worth of overlap. Chosen just
 * UNDER the step ratio so a genuinely GPU-dominated frame still qualifies.
 */
const DROP_OVER_CPU_BOUND = 1.35;

/**
 * ⭐⭐ HOW FAST THE CLIMB'S AIM IS ALLOWED TO FOLLOW A RISING CPU.
 *
 * A climb is judged against the WORST aim seen lately, not the current one, and
 * that asymmetry is the real cure for hunting. The aim is `max(budget, cpu)`, so
 * on a CPU that breathes — GC, thermal, a background tab — it is HIGH exactly
 * when the frame is momentarily slow, and a loop reading it live keeps buying
 * quality during the bad moments and being punished for it during the good ones.
 * Every one of those round trips is a full GI rebuild.
 *
 * So the floor snaps DOWN instantly (a cheaper aim is a real constraint and must
 * bind at once) and creeps UP at this rate per frame — about a 20-second memory
 * at 50 fps. Read as: "spend a rung only on headroom that has been there for
 * twenty seconds, not on headroom that exists this instant."
 *
 * ⚠ Drops deliberately do NOT use the floor. A drop answers a miss that has
 * already happened, and delaying it by twenty seconds would be twenty seconds
 * below the frame rate floor.
 */
const AIM_FLOOR_RISE = 0.001;

/**
 * How long the loop stays quiet after the engine skips a draw. Long enough to
 * cover the recompile spike that follows a resumed compile wave, short enough
 * that a scene stalling every second still eventually gets governed.
 */
const HOLD_AFTER_STALL_MS = 1000;

/**
 * ## The transient after a resize, and why there is no settle window here
 *
 * The frame that performs a GI resize also rebuilds the resolve pipeline and
 * throws away every temporal history — the console has logged a single
 * 1163 ms frame for exactly this. Fed back into the loop that reads as "still
 * too slow" and drops another rung, on a cost the controller caused itself.
 *
 * The obvious guard is a settle window that discards N frames after a step,
 * and this file had one. It was REMOVED because no fixture could tell it from
 * its absence — including one that spikes 4x for 30 frames after every step,
 * and one that spikes to a full second. Two mechanisms already cover it:
 * `_emaMs = 0` on every step, so no old-rung sample survives the move, and
 * `MIN_DROP_INTERVAL_MS`, which is ~60 frames — by the time another drop is
 * even permitted, an EMA at alpha 0.1 has decayed the transient to 0.2% of
 * its weight. A third mechanism that changes no measurable behaviour is not
 * belt and braces, it is a knob nobody can maintain.
 *
 * ⚠ If the interval floor is ever shortened, this reasoning expires with it.
 * The test `the RESIZE HITCH does not drive the loop into a resize storm` is
 * what keeps that honest — it asserts the loop settles on the SHALLOWEST rung
 * that meets the aim, which is what measuring your own transient breaks.
 */

export class FrameGovernorSystem {
  constructor(engine) {
    this.engine = engine;
    /** Index into GI_COST_LADDER. 0 = the tier's authored cost. */
    this.level = 0;
    this._emaMs = 0;
    /**
     * ⭐⭐ THE CPU IS SMOOTHED WITH THE SAME FILTER AS THE GPU, AND THE ABSENCE
     * OF THIS LINE IS WHAT MADE THE LOOP HUNT.
     *
     * `effectiveAim = max(budget, cpu)` puts the CPU reading INSIDE the
     * threshold, so feeding it raw meant a 10-frame-smoothed measurement was
     * being compared against a target that jittered frame to frame by more than
     * the whole dead band was wide. MEASURED on Bistro/ultra, parked camera:
     * gpuEma 36 ms against a CPU wandering 30-44 ms, so the SAME GPU time read
     * as "over the aim" and "on target" in consecutive frames.
     *
     * ⚠ Never reset on a rung change. The CPU is the one signal a rung does not
     * move (measured: 30.8 ms at 1.00x pixels, 32.2 ms at 0.25x), so its memory
     * stays valid across a step and re-learning it would reintroduce exactly the
     * transient this filter exists to remove. `hold()` clears it, because a
     * skipped frame's CPU time is not a measurement of anything.
     */
    this._cpuEmaMs = 0;
    /** Slowest-recent view of the aim; only climbs are judged against it. */
    this._aimFloorMs = 0;
    this._overFrames = 0;
    this._underFrames = 0;
    this._lastChange = 0;
    this._holdUntil = 0;
    /** Receipt: why the loop is where it is, for `profile.frameStats`. */
    this.stats = {
      enabled: false,
      level: 0,
      scale: 1,
      gpuEmaMs: 0,
      aimMs: 0,
      changes: 0,
      lastReason: "idle",
    };
  }

  /** The multiplier GI applies to its traced-pixel budget. */
  get scale() {
    return GI_COST_LADDER[this.level] ?? 1;
  }

  /**
   * Back to the authored cost, and forget the loop's memory with it.
   *
   * Called when the controller is switched off, so a scene does not keep a
   * degraded rung it can no longer climb out of.
   */
  reset() {
    this.level = 0;
    this._emaMs = 0;
    this._cpuEmaMs = 0;
    this._aimFloorMs = 0;
    this._overFrames = 0;
    this._underFrames = 0;
  }

  /**
   * "The last frame was not a frame — do not believe the next few either."
   *
   * Called by `Engine#tick` from every path that skips the draw (a suspended
   * compile wave, a renderer resize in flight, no camera). The measurement is
   * discarded rather than merely ignored: an EMA carrying a compile stall is
   * still carrying it three seconds later.
   */
  hold(now = performance.now(), ms = HOLD_AFTER_STALL_MS) {
    this._holdUntil = Math.max(this._holdUntil, now + ms);
    this._emaMs = 0;
    this._cpuEmaMs = 0;
    this._aimFloorMs = 0;
    this._overFrames = 0;
    this._underFrames = 0;
  }

  /** One tick. Cheap and allocation-free on every path. */
  update(now = performance.now()) {
    const perf = this.engine?.settings?.performance;
    const enabled = perf?.adaptiveQuality !== false;
    if (!enabled) {
      if (this.level !== 0) this.reset();
      this.stats.enabled = false;
      this.stats.level = 0;
      this.stats.scale = 1;
      this.stats.lastReason = "disabled";
      return;
    }

    const targetFps = perf.targetFps > 0 ? perf.targetFps : 60;
    const aimMs = (1000 / targetFps) * GPU_BUDGET_SHARE;

    // REAL GPU TIME ONLY. `stats.readout.gpuMs` is the timestamp-query result
    // when the adapter has one; without it there is no way to tell a GPU-bound
    // frame from a CPU-bound one, and a controller that guesses would spend
    // quality on frames it cannot help. Staying at the authored cost is the
    // honest behaviour there — `gpuMsIsReal` in the profile reports which.
    const readout = this.engine?.stats?.readout;
    const gpuMs = readout?.gpuMs ?? 0;
    if (!(gpuMs > 0)) {
      this.stats.enabled = true;
      this.stats.lastReason = "no gpu timestamps — holding authored cost";
      return;
    }

    // ⭐ NOT WHILE THE ENGINE IS STALLING FOR SOMETHING ELSE. A GI compile wave
    // suspends rendering for seconds and the first frame after it resumes is
    // enormous (a 1163 ms one is in the console log). None of that is a cost
    // the pixel budget can buy back, and reacting to it spends quality on a
    // transient — MEASURED on the first boot with this controller live: 8
    // resizes before the scene had even settled, dropping on compile stalls
    // and climbing back out of them. `Engine#tick` calls `hold()` on every
    // path that skips a draw, so this covers boot, renderer resizes, and every
    // future stall without the governor needing to know what caused it.
    if (now < this._holdUntil) {
      this.stats.enabled = true;
      this.stats.lastReason = "holding — the engine skipped a frame recently";
      return;
    }

    this._emaMs = this._emaMs === 0 ? gpuMs : EMA_ALPHA * gpuMs + (1 - EMA_ALPHA) * this._emaMs;

    // ⭐⭐ THE GPU HAS NOTHING TO GAIN BY BEING FASTER THAN THE CPU.
    //
    // The target is not the frame budget, it is the frame budget OR the CPU,
    // whichever the frame is actually waiting on. Both failures this fixes were
    // observed live on Bistro/ultra within one session:
    //
    // · DESCENDING PAST THE CROSSOVER — the loop reached the bottom rung
    //   reporting "gpu 17.1ms over 15.0ms aim" while the CPU was 33 ms. Every
    //   rung past the crossover bought zero fps and cost real GI resolution.
    // · AND THEN BEING UNABLE TO CLIMB BACK — with a crossover guard bolted on
    //   the descent only, the loop sat at rung 3 (GPU 23.7 ms, CPU 30.6 ms)
    //   FOREVER: it could not drop (the guard held it) and could not climb
    //   (the climb still compared against a 15 ms aim it can never reach on a
    //   CPU-bound frame). One rung of reflection sharpness, thrown away for
    //   nothing, permanently. The user's report was "reflections look
    //   incredibly shitty".
    //
    // Folding the CPU into the aim makes one rule cover both directions, which
    // is why it replaced the guard rather than joining it: spend down to the
    // binding constraint, climb back up to it, and never cross it in either
    // direction. On a CPU-bound scene that means the governor holds FULL GI
    // quality — correctly, because degrading it would not move the frame rate.
    const cpuMs = readout?.workMs ?? 0;
    // Same filter, same alpha — see `_cpuEmaMs`. Comparing a smoothed signal to
    // an unsmoothed threshold is the whole bug this replaces.
    this._cpuEmaMs = this._cpuEmaMs === 0 ? cpuMs : EMA_ALPHA * cpuMs + (1 - EMA_ALPHA) * this._cpuEmaMs;
    const effectiveAimMs = Math.max(aimMs, this._cpuEmaMs);
    // Snaps down, creeps up — see AIM_FLOOR_RISE.
    this._aimFloorMs = this._aimFloorMs === 0 || effectiveAimMs < this._aimFloorMs
      ? effectiveAimMs
      : this._aimFloorMs + (effectiveAimMs - this._aimFloorMs) * AIM_FLOOR_RISE;

    this.stats.enabled = true;
    this.stats.level = this.level;
    this.stats.scale = this.scale;
    this.stats.gpuEmaMs = Math.round(this._emaMs * 100) / 100;
    this.stats.aimMs = Math.round(aimMs * 100) / 100;
    // The number that actually decides a drop, published because the aim alone
    // hid a floor violation once — see GPU_BUDGET_SHARE.
    this.stats.dropOverMs = Math.round(aimMs * DROP_OVER * 100) / 100;
    this.stats.effectiveAimMs = Math.round(effectiveAimMs * 100) / 100;
    this.stats.aimFloorMs = Math.round(this._aimFloorMs * 100) / 100;
    this.stats.cpuMs = Math.round(this._cpuEmaMs * 100) / 100;

    // ⭐⭐ ON A CPU-BOUND FRAME, A DROP MUST BE WORTH A FULL RUNG, BECAUSE ITS
    // PAYOFF IS CAPPED AT `gpu − cpu`.
    //
    // `effectiveAim = max(budget, cpu)` spends down to the binding constraint —
    // but the constraint MOVES. Measured live on an IDLE Bistro (2026-08-25,
    // parked camera): the editor's background work wound down, cpuEma drifted
    // 34.4 → 25.9 ms, and the loop chased the falling aim down three rungs in
    // nine minutes — three full GI re-mints, each a visible reset the user
    // reported as "gi still reloads occasionally for no reason", each buying a
    // couple of ms. Every step was locally correct under the old rule; the rule
    // lacked the fact that when the CPU is the wall, dropping GI can only
    // recover the gpu−cpu overlap, never the distance to 60 fps.
    //
    // So a CPU-bound drop demands `gpu > cpu × 1.35` — being over by roughly a
    // whole rung's worth (1/0.72 ≈ 1.39), so the re-mint recovers at least a
    // rung of frame time. The price is the last few ms of overlap staying
    // unclaimed near the crossover, deliberately traded for not re-minting the
    // field at every drift.
    //
    // A scene where the fixed 60 fps budget binds (aim === budget) keeps the
    // fast 1.12/2 s path untouched: there, every ms over the aim IS time spent
    // below the floor, and speed wins.
    const cpuBound = this._cpuEmaMs > aimMs;
    const dropOver = cpuBound ? DROP_OVER_CPU_BOUND : DROP_OVER;
    if (this._emaMs > effectiveAimMs * dropOver) {
      this._overFrames++;
      this._underFrames = 0;
    } else if (this._emaMs < this._aimFloorMs * CLIMB_BELOW) {
      // ⚠ THE FLOOR, NOT THE CURRENT AIM. Climbing on headroom that exists only
      // while the CPU happens to be slow is what made the loop rebuild GI every
      // four seconds on a parked camera.
      this._underFrames++;
      this._overFrames = 0;
    } else {
      // In the dead band: exactly where the loop wants to be.
      this._overFrames = 0;
      this._underFrames = 0;
      this.stats.lastReason = "on target";
      return;
    }

    if (this._overFrames >= FRAMES_BEFORE_DROP && this.level < GI_COST_LADDER.length - 1) {
      // ⛔ A CPU-bound drop briefly paced at the climb's 12 s dwell here; the
      // negative control could not tell it from its absence (the 1.35 margin
      // already blocks every drop the dwell would have delayed), so it went the
      // way of the settle window and the climb backoff.
      if (now - this._lastChange < MIN_DROP_INTERVAL_MS) return;
      // SNAP, DON'T WALK. Cost is ~linear in traced pixels, so the rung that
      // lands on the aim is the current scale times aim/measured. Going
      // straight there costs ONE resize; walking there costs one per rung, and
      // each of those is a hitch the floor rule counts as a regression.
      //
      // ⚠ AIMED AT `effectiveAimMs`, WHICH IS WHERE THE CROSSOVER IS ENFORCED.
      // An earlier version aimed the snap at the raw 15 ms budget and bolted a
      // separate "stop if CPU-bound" test in front of it; that test could only
      // block the NEXT descent, while a single snap from rung 0 had already
      // sailed four rungs past the crossover in one step. A negative control
      // caught it — the guard was in and the test still passed with it
      // disabled.
      const wanted = this.scale * (effectiveAimMs / this._emaMs);
      let next = this.level;
      while (next < GI_COST_LADDER.length - 1 && GI_COST_LADDER[next] > wanted) next++;
      // Always make progress: a `wanted` that rounds to the current rung still
      // means the frame is missing, so take one step rather than stalling.
      if (next === this.level) next = this.level + 1;
      const why = effectiveAimMs > aimMs
        ? `gpu ${this._emaMs.toFixed(1)}ms over the ${effectiveAimMs.toFixed(1)}ms the CPU allows`
        : `gpu ${this._emaMs.toFixed(1)}ms over ${aimMs.toFixed(1)}ms aim`;
      this.#applyLevel(next, now, why);
      return;
    }

    if (this._underFrames >= FRAMES_BEFORE_CLIMB && this.level > 0) {
      if (now - this._lastChange < MIN_CLIMB_INTERVAL_MS) return;
      // ONE RUNG, never a snap. Climbing raises cost to find out whether the
      // budget allows it, so overshooting means a miss the user sees; the
      // CLIMB_BELOW band already guarantees the next rung up (≈1.4x the cost)
      // still fits under the aim.
      this.#applyLevel(this.level - 1, now, `gpu ${this._emaMs.toFixed(1)}ms has headroom`);
    }
  }

  #applyLevel(level, now, reason) {
    if (level === this.level) return;
    this.level = level;
    this._lastChange = now;
    this._overFrames = 0;
    this._underFrames = 0;
    // The new rung's cost is unknown until it has been measured, and the EMA
    // is entirely made of the OLD rung's frames. Keeping it would carry the
    // old cost across the step and immediately re-trigger.
    this._emaMs = 0;
    this.stats.level = level;
    this.stats.scale = this.scale;
    this.stats.changes++;
    this.stats.lastReason = reason;
  }
}
