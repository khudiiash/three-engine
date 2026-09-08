/**
 * IS THIS PIECE OF CLOTH STILL CLOTH?
 *
 * ⛔ THE STATISTIC THAT HID THE BUG. The first version of this judged an
 * island by the ratio of its live bounding-box DIAGONAL to its rest diagonal,
 * and called a visibly destroyed Sponza curtain "plausible" at 2.37. The
 * numbers say why:
 *
 *     rest span   2.298 x 2.263 x 0.197      a curtain: two long axes, one thin
 *     live span   4.542 x 5.028 x 3.550      18x its thickness, 2.2x its height
 *
 * A diagonal is dominated by the LONG axes, so inflating the thin one from
 * 0.2 m to 3.6 m — an eighteen-fold blow-out, the single most obvious thing
 * about the picture — moves the diagonal by a factor of two and hides inside
 * an ordinary-looking ratio. **The thin axis is where a sheet fails, and it is
 * the axis a diagonal is least sensitive to.** Judge the axes separately.
 *
 * Two independent readings, because they are two different failures:
 *
 *   · STRETCH — growth along the two long (in-plane) axes. Structural springs
 *     hold these at rest length, so they cannot legitimately grow at all.
 *     Anything past ~1.5 is the solver losing the constraint: a tear.
 *   · BILLOW — growth along the thin axis. This one is SUPPOSED to grow; a
 *     curtain in wind measured 2.8-5.6x here and looks right. Past ~8 it is
 *     not billowing, it is being blown apart.
 *
 * The separation on the live scene was clean with room to spare: every healthy
 * island came in at or below 5.6 billow / 1.03 stretch, and both broken ones
 * at 15.3 and 18.0 billow / 1.7 and 2.2 stretch.
 */

/** In-plane growth past this is a tear — structural springs hold these axes. */
export const STRETCH_LIMIT = 1.5;
/** Thin-axis growth past this is a blow-out, not a billow. */
export const BILLOW_LIMIT = 8;
/** Below this an island has collapsed to a point (all axes). */
export const COLLAPSE_LIMIT = 0.25;
/**
 * ⛔ AND THE SECOND BLIND SPOT: A CLOTH CAN FAIL BY GETTING SHORTER.
 *
 * `stretch` took the MAXIMUM ratio over the in-plane axes, so a curtain
 * measuring 2.279 m wide (0.99 of rest) and **1.444 m tall against a 2.272 m
 * rest height** reported `max(0.99, 0.64) = 0.99` and was called healthy. The
 * user's answer to that verdict was "nope, still broken", and they were right:
 * that piece is 64 % of its own length, bunched into a ball — which the billow
 * of 5.56 says too, and which the maximum hid.
 *
 * A hanging cloth DOES contract as it folds; the healthy Sponza islands
 * measured 0.89-1.03 on their shortest in-plane axis. So `gather` is reported
 * separately from `stretch`, and it is a real reading, not a rounding of one.
 */
export const GATHER_LIMIT = 0.75;

/**
 * ⭐⭐ SPRING STRAIN OUTRANKS EVERY BOX READING.
 *
 * ⛔ AND THE BOX HAS A THIRD BLIND SPOT: it cannot tell BLOWING from CRUMPLED.
 * 2.26 m of fabric swinging out at 30° in the wind measures 1.9 m tall and
 * scores `gather` 0.84 while every thread in it is exactly its rest length.
 * The extents are a function of POSE as much as of damage, and a wind setting
 * moves them.
 *
 * Strain is not. Each structural spring has an authored rest length, and
 * `|live − rest| / rest` reads the same however the cloth is oriented. So when
 * strain and the box disagree, strain is the one measuring the cloth rather
 * than the camera angle, and it decides.
 *
 * Live Sponza, after the contact-radius fix: the visibly-broken island carries
 * a spring at **4.70 — 5.7x its own rest length** — while the box called it
 * healthy at gather 0.76. The cleanest island's worst is 0.62.
 */
/**
 * ⛔ RECALIBRATED, AND THE FIRST VALUES CONDEMNED EVERY HEALTHY CLOTH. 0.05 and
 * 2 were read off ONE unusually relaxed island early on, before two things
 * were known:
 *
 *   · a hanging cloth carries its own weight by stretching, so several per
 *     cent of mean strain is PHYSICS, not damage — forcing three times the
 *     solver iterations barely moved it (0.060 -> 0.057);
 *   · the real failure is an order of magnitude away, not a few per cent.
 *
 * Measured populations, live, with motion coherence as the ground truth for
 * which is which:
 *
 *     healthy (coherence 0.96-0.99)   mean 0.055-0.114   worst 0.92-2.54
 *     fighting (coherence 0.56)       mean 0.795         worst 14.66
 *
 * The limits sit in that gap with room on both sides.
 */
export const MEAN_STRAIN_LIMIT = 0.25;
/**
 * ⚠ AND THIS ONE'S MARGIN IS NARROW, WHICH IS WORTH SAYING RATHER THAN
 * HIDING. Healthy swaying cloth has been measured spiking to a worst spring of
 * **2.54**, and an island that was visibly broken sat at **4.70**. 3.5 splits
 * them, but only just — a transient could cross it either way, which is
 * precisely why `coherence` outranks this reading when motion data exists.
 * The mean is the reliable shape figure; this one is a backstop.
 */
export const WORST_STRAIN_LIMIT = 3.5;

/**
 * ⭐⭐⭐ AND COHERENCE DECIDES WHEN IT IS AVAILABLE, because it is the only
 * reading that measures the complaint. "Fighting themselves" is a statement
 * about MOTION, and shape describes one frozen frame: a cloth the right size
 * in the right place scores perfectly while buzzing.
 *
 *     coherence = |mean displacement| / mean |displacement|
 *
 * A curtain in wind moves far and moves TOGETHER (0.96-0.99). A cloth pulling
 * against itself moves just as far with its particles disagreeing, so the
 * vectors cancel (0.56 measured on the island that was visibly wrong).
 */
export const COHERENCE_LIMIT = 0.85;

/**
 * `span` and `restSpan` are axis-aligned extents in the SAME local space.
 * Returns the two ratios and a verdict. Degenerate rest axes report `null`
 * rather than a ratio, so a flat or empty island is never scored as healthy.
 */
export function classifyClothIsland(span, restSpan, strain = null, motion = null) {
  if (!span || !restSpan || span.length !== 3 || restSpan.length !== 3) return { verdict: "unknown", stretch: null, billow: null };
  // The thin axis is a property of the REST pose, not of the live one — a
  // curtain blown into a ball has no thin axis left to find.
  let thin = 0;
  for (let k = 1; k < 3; k++) if (restSpan[k] < restSpan[thin]) thin = k;

  const ratio = (k) => (restSpan[k] > 1e-6 ? span[k] / restSpan[k] : null);
  const billow = ratio(thin);
  // BOTH ends of the in-plane range. A maximum alone cannot see a cloth that
  // fails by getting shorter — see GATHER_LIMIT.
  let stretch = null, gather = null;
  for (let k = 0; k < 3; k++) {
    if (k === thin) continue;
    const r = ratio(k);
    if (r == null) continue;
    if (stretch == null || r > stretch) stretch = r;
    if (gather == null || r < gather) gather = r;
  }

  const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
  if (stretch == null || billow == null || gather == null) {
    return { verdict: "unknown", stretch: round(stretch), gather: round(gather), billow: round(billow) };
  }
  // Order matters: a broken island usually trips several of these at once, and
  // the verdict should name the CAUSE rather than the loudest symptom.
  // Strain first: a cloth whose own springs are far from rest is damaged in
  // any pose, and a box that disagrees is reading the wind.
  const torn = strain != null
    && ((strain.mean != null && strain.mean > MEAN_STRAIN_LIMIT)
      || (strain.worst != null && strain.worst > WORST_STRAIN_LIMIT));
  // Incoherent motion is the complaint itself, so it outranks every shape
  // reading — but only when the cloth actually moved enough to have a
  // direction worth measuring.
  const fighting = motion?.coherence != null && motion.coherence < COHERENCE_LIMIT
    && (motion.movedMm ?? 0) > 1;
  const verdict = fighting ? "FIGHTING"
    : torn ? "TORN"
    : stretch > STRETCH_LIMIT ? "TORN"
    : gather < COLLAPSE_LIMIT && billow < COLLAPSE_LIMIT ? "COLLAPSED"
    : gather < GATHER_LIMIT ? "BUNCHED"
    : billow > BILLOW_LIMIT ? "BLOWN OUT"
    : "healthy";
  return { verdict, stretch: round(stretch), gather: round(gather), billow: round(billow) };
}

/**
 * HOW MANY OF THE CLOTH'S JACOBI PASSES RUN BEFORE CONTACT.
 *
 * Total passes per substep. Kept whole so the reordering is provably free:
 * `split` before contact and `PASSES - split` after is the same dispatch count
 * whatever the split, and this solver is launch-bound.
 */
export const CLOTH_SOLVE_PASSES = 8;
/** Four before, four after. See the step list in `gridSimulation.js`. */
export const CLOTH_SOLVE_SPLIT = 4;

/**
 * ⛔ PARITY IS NOT OPTIONAL. `solveA` reads `scratch` and writes `positions`;
 * `solveB` reads `positions` and writes `scratch`. An ODD split leaves the
 * newest data in the buffer the next stage does not read, so the substep
 * silently discards its own work — and it would still run, still cost the
 * same, and still look like cloth. The split is therefore forced even.
 *
 * ⛔ AND `Number(undefined)` IS `NaN`, WHICH `??` DOES NOT CATCH. The first
 * version read `Number(globalThis.__clothSolveSplit) ?? CLOTH_SOLVE_SPLIT`,
 * so with the override absent — the normal case, every run — the split was
 * `NaN & ~1` = 0, quietly shipping a different solver than the default names.
 */
export function clothSolveSplit(override) {
  // ⛔ AND `Number(null)` IS `0`, WHICH *IS* FINITE. An absent override has to
  // be tested for as absence, not sniffed out of the coerced value — zero is a
  // legitimate arm (every pass after contact) and must stay reachable.
  const absent = override == null || override === "" || Number.isNaN(Number(override));
  const value = absent ? CLOTH_SOLVE_SPLIT : Number(override);
  return Math.max(0, Math.min(CLOTH_SOLVE_PASSES, Math.floor(value))) & ~1;
}


/* -------------------------------------------------------------------------- */
/* Timestep                                                                    */
/* -------------------------------------------------------------------------- */

/** The step the authored `damping` is defined against. */
export const CLOTH_REFERENCE_STEP = 1 / 120;
/**
 * The longest frame worth simulating. Beyond this the time is DROPPED rather
 * than stretched across the same few substeps — a 300 ms step is not cloth
 * motion at any step size, and a loading hitch should not launch a curtain.
 */
export const MAX_CLOTH_FRAME = 1 / 20;

/**
 * ⛔⛔ A CLOTH MUST NOT CHANGE SPEED WITH THE FRAME RATE, AND THIS ONE DID.
 *
 * The substep loop advanced a FIXED step and threw away whatever the frame
 * could not afford, so the cloth ran in slow motion whenever the budget bit:
 *
 *     editor ~38 fps   wants 3.2 substeps, allowed 2  ->  0.63x speed
 *     play mode 120    1 substep is enough            ->  1.00x speed
 *
 * A whole session was spent judging a cloth at 0.63x, and the moment the user
 * pressed play it ran at true speed: *"cloth started moving unnatural, like
 * gravity is super strong or it is made of rubber"*. Nothing about the cloth
 * had changed — only how much of each second it was allowed to simulate.
 *
 * So the step SIZE adapts: the frame's time is divided between however many
 * substeps the budget allows, and ALL of it is simulated.
 */
export function clothSubsteps(frameSeconds, maxSubsteps, referenceStep = CLOTH_REFERENCE_STEP) {
  const frame = Math.min(Math.max(frameSeconds, 0), MAX_CLOTH_FRAME);
  if (!(frame > 1e-6)) return { count: 0, step: referenceStep, simulated: 0 };
  const count = Math.max(1, Math.min(Math.max(1, Math.floor(maxSubsteps)), Math.ceil(frame / referenceStep)));
  const step = frame / count;
  return { count, step, simulated: frame };
}

/**
 * What to multiply Verlet's stored velocity by.
 *
 * ⚠ TWO CORRECTIONS IN ONE NUMBER. Verlet keeps velocity as a DISPLACEMENT
 * over the previous step, so a change of step size has to be rescaled by the
 * ratio or it reads as an impulse. And damping is authored per REFERENCE step,
 * so it has to be re-exponentiated for the step actually taken — otherwise a
 * cloth simulated in fewer, larger steps is less damped per second and rings.
 */
export function clothVelocityScale(step, previousStep, damping, referenceStep = CLOTH_REFERENCE_STEP) {
  const ratio = previousStep > 1e-9 ? step / previousStep : 1;
  return ratio * Math.pow(Math.min(Math.max(damping, 0), 1), step / referenceStep);
}
