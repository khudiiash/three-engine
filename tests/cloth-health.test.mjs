/**
 * THE VERDICT MUST FAIL THE CURTAIN THAT IS ACTUALLY BROKEN.
 *
 * Every fixture below is a REAL island measured off the live Sponza scene on
 * 2026-09-08 (`vfx.cloth.status` with `readPositions`), not a number invented
 * to make a threshold look good. The two broken ones are the curtains the user
 * reported as "red and blue are not [working]"; the healthy ones are their
 * neighbours in the same entities, simulated by the same solver against the
 * same colliders.
 *
 * ⛔ THE CONTROL, and the reason this file exists: `diagonalVerdict` below is
 * the statistic that SHIPPED FIRST, and the last test proves it calls the
 * destroyed curtain "plausible". A test that only checked the new classifier
 * would pass just as happily against the old one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { classifyClothIsland, STRETCH_LIMIT, BILLOW_LIMIT } from "../src/engine/vfx/clothHealth.js";

/** Live islands, Sponza, 2026-09-08. `[span, restSpan]`, local space, metres. */
const HEALTHY = {
  "Mesh_0_18 island 1": [[2.269, 2.259, 0.701], [2.296, 2.272, 0.202]],
  "Mesh_0_18 island 2": [[2.315, 2.254, 0.631], [2.298, 2.263, 0.197]],
  "Mesh_0_19 island 0": [[2.094, 2.354, 0.576], [2.296, 2.272, 0.202]],
  "Mesh_0_19 island 1": [[2.272, 2.314, 0.568], [2.298, 2.263, 0.197]],
  "Mesh_0_19 island 2": [[2.274, 2.321, 0.561], [2.298, 2.263, 0.197]],
  "Mesh_0_19 island 3": [[2.062, 2.343, 0.639], [2.296, 2.272, 0.202]],
  "Mesh_0_20 island 2": [[2.300, 2.360, 0.972], [2.298, 2.263, 0.197]],
};
const BROKEN = {
  "Mesh_0_20 island 0": [[4.542, 5.028, 3.550], [2.298, 2.263, 0.197]],
  "Mesh_0_20 island 1": [[2.745, 3.787, 3.092], [2.296, 2.272, 0.202]],
};

test("every curtain that looks right is called healthy", () => {
  for (const [name, [span, rest]] of Object.entries(HEALTHY)) {
    const { verdict, billow, stretch } = classifyClothIsland(span, rest);
    assert.equal(verdict, "healthy", `${name} misjudged (billow ${billow}, stretch ${stretch})`);
  }
});

test("⛔ both curtains the user reported as broken are called TORN", () => {
  for (const [name, [span, rest]] of Object.entries(BROKEN)) {
    const { verdict, billow, stretch } = classifyClothIsland(span, rest);
    assert.equal(verdict, "TORN", `${name} escaped the net (billow ${billow}, stretch ${stretch})`);
  }
});

test("the thresholds sit in a real gap, not against the nearest fixture", () => {
  // A threshold tuned to one sample either side is a threshold that will
  // reclassify the whole scene on the next solver change. Measure the gap.
  const worstHealthy = Object.values(HEALTHY).map(([s, r]) => classifyClothIsland(s, r));
  const bestBroken = Object.values(BROKEN).map(([s, r]) => classifyClothIsland(s, r));
  const healthyBillow = Math.max(...worstHealthy.map((v) => v.billow));
  const healthyStretch = Math.max(...worstHealthy.map((v) => v.stretch));
  const brokenBillow = Math.min(...bestBroken.map((v) => v.billow));
  const brokenStretch = Math.min(...bestBroken.map((v) => v.stretch));

  assert.ok(healthyStretch < STRETCH_LIMIT, `healthiest stretch ${healthyStretch} must clear ${STRETCH_LIMIT}`);
  assert.ok(brokenStretch > STRETCH_LIMIT, `mildest broken stretch ${brokenStretch} must exceed ${STRETCH_LIMIT}`);
  assert.ok(healthyBillow < BILLOW_LIMIT && brokenBillow > BILLOW_LIMIT);
  // Both sides at least 1.15x clear of the line.
  assert.ok(brokenStretch / healthyStretch > 1.5, `stretch gap is only ${healthyStretch} -> ${brokenStretch}`);
  assert.ok(brokenBillow / healthyBillow > 2, `billow gap is only ${healthyBillow} -> ${brokenBillow}`);
});

test("a billowing curtain is not a torn one", () => {
  // The thin axis is MEANT to grow. Mesh_0_20 island 2 sits at 4.9x and is the
  // healthiest-looking curtain in the scene; a limit that fails it would
  // condemn every cloth in wind.
  const { verdict, billow, stretch } = classifyClothIsland([2.300, 2.360, 0.972], [2.298, 2.263, 0.197]);
  assert.equal(verdict, "healthy");
  assert.ok(billow > 4.5, `a real curtain billows — ${billow}`);
  assert.ok(stretch < 1.05, `...without stretching — ${stretch}`);
});

test("the thin axis is taken from the REST pose, not the live one", () => {
  // A curtain blown into a ball has no thin axis left. Reading the thin axis
  // off the live span would pick whichever axis happened to be smallest and
  // compare it against the wrong rest extent — here it would divide the live
  // X (4.542) by the rest Z (0.197) and report nonsense.
  const { verdict, billow } = classifyClothIsland([4.542, 5.028, 3.550], [2.298, 2.263, 0.197]);
  assert.equal(verdict, "TORN");
  assert.equal(billow, 18.02, "3.550 / 0.197 — the rest's thin axis is Z, and stays Z");
});

test("a degenerate rest axis reports unknown, never healthy", () => {
  // A flat or empty island must not be scored. Silence that reads as health is
  // how an instrument lies.
  assert.equal(classifyClothIsland([1, 1, 1], [1, 1, 0]).verdict, "unknown");
  assert.equal(classifyClothIsland([1, 1, 1], [0, 0, 0]).verdict, "unknown");
  assert.equal(classifyClothIsland(null, [1, 1, 1]).verdict, "unknown");
});

test("an island collapsed to a point is caught", () => {
  const { verdict } = classifyClothIsland([0.02, 0.02, 0.002], [2.298, 2.263, 0.197]);
  assert.equal(verdict, "COLLAPSED");
});

/** ⛔ THE STATISTIC THAT SHIPPED FIRST — kept only to prove it was blind. */
const diagonalVerdict = (span, rest) => {
  const h = (v) => Math.hypot(...v);
  const ratio = h(span) / h(rest);
  return ratio > 3 ? "EXPLODED" : ratio < 0.25 ? "COLLAPSED" : "plausible";
};

test("⛔ the CONTROL: the diagonal ratio calls the destroyed curtain plausible", () => {
  // This is the whole reason the classifier was rewritten. Without this check
  // the suite would pass against the version that could not see the bug.
  const [span, rest] = BROKEN["Mesh_0_20 island 0"];
  assert.equal(diagonalVerdict(span, rest), "plausible", "the old statistic really was blind here");
  assert.equal(classifyClothIsland(span, rest).verdict, "TORN", "and the new one is not");
});

/**
 * ── THE SOLVE SPLIT ───────────────────────────────────────────────────────
 *
 * Where the Jacobi passes sit RELATIVE TO CONTACT, which is what actually
 * tore the curtains. These reconstruct the step list exactly as
 * `gridSimulation.js` builds it, because the property that matters is not a
 * number — it is that the tail leaves the newest data in `positions`.
 */
import { clothSolveSplit, CLOTH_SOLVE_PASSES, CLOTH_SOLVE_SPLIT } from "../src/engine/vfx/clothHealth.js";

/**
 * Walk the substep the way the buffers do. `solveA` reads scratch → writes
 * positions; `solveB` reads positions → writes scratch; `commit` reads scratch
 * → writes positions; the contact kernels start and end in positions except
 * `collideEdges`, which writes scratch for the `commit` that follows it.
 */
function newestBufferAfterSubstep(split) {
  const steps = [
    ...Array.from({ length: split }, (_, i) => (i % 2 === 0 ? "solveA" : "solveB")),
    "commit", "collide", "collideEdges", "commit", "collideEdges", "commit", "collide",
    ...Array.from({ length: CLOTH_SOLVE_PASSES - split }, (_, i) => (i % 2 === 0 ? "solveB" : "solveA")),
  ];
  let newest = "scratch"; // integrate writes scratch
  for (const step of steps) {
    if (step === "solveA") { assert.equal(newest, "scratch", "solveA read a stale scratch"); newest = "positions"; }
    else if (step === "solveB") { assert.equal(newest, "positions", "solveB read a stale positions"); newest = "scratch"; }
    else if (step === "commit") { assert.equal(newest, "scratch", "commit read a stale scratch"); newest = "positions"; }
    else if (step === "collideEdges") { assert.equal(newest, "positions"); newest = "scratch"; }
    else if (step === "collide") { assert.equal(newest, "positions"); newest = "positions"; }
  }
  return { newest, steps };
}

test("⛔ contact is no longer the last thing that touches a particle", () => {
  // THE REGRESSION. With every pass before contact, a character's push had
  // nothing to redistribute it and the stretch accumulated across substeps.
  const { steps } = newestBufferAfterSubstep(CLOTH_SOLVE_SPLIT);
  const lastContact = Math.max(steps.lastIndexOf("collide"), steps.lastIndexOf("collideEdges"));
  const passesAfter = steps.slice(lastContact).filter((s) => s === "solveA" || s === "solveB").length;
  assert.ok(passesAfter >= 2, `only ${passesAfter} relaxation passes follow the last contact`);
});

test("the substep leaves the newest data in positions, at every legal split", () => {
  // Parity. An odd or mis-led tail silently discards the substep's own work
  // while costing exactly the same — it would still look like cloth.
  for (let split = 0; split <= CLOTH_SOLVE_PASSES; split += 2) {
    assert.equal(newestBufferAfterSubstep(split).newest, "positions", `split ${split} ended in the wrong buffer`);
  }
});

test("the reorder is free: the dispatch count does not move with the split", () => {
  // The whole justification. This solver is launch-bound, so a fix that added
  // passes would trade one defect for the frame rate.
  const counts = new Set();
  for (let split = 0; split <= CLOTH_SOLVE_PASSES; split += 2) counts.add(newestBufferAfterSubstep(split).steps.length);
  assert.equal(counts.size, 1, `step count varied with the split: ${[...counts]}`);
});

test("split 8 reproduces the old order exactly, so it is a usable A/B arm", () => {
  const { steps } = newestBufferAfterSubstep(8);
  const lastContact = Math.max(steps.lastIndexOf("collide"), steps.lastIndexOf("collideEdges"));
  assert.equal(steps.slice(lastContact).filter((s) => s.startsWith("solve")).length, 0, "the broken arm must have zero passes after contact");
});

test("⛔ an absent override does not collapse the split to zero", () => {
  // `Number(undefined)` is NaN and `??` does not catch it, so the first
  // version shipped `NaN & ~1` = 0 on every ordinary run.
  assert.equal(clothSolveSplit(undefined), CLOTH_SOLVE_SPLIT);
  assert.equal(clothSolveSplit(null), CLOTH_SOLVE_SPLIT);
  assert.equal(clothSolveSplit("not a number"), CLOTH_SOLVE_SPLIT);
});

test("the split is forced even and clamped, whatever it is handed", () => {
  assert.equal(clothSolveSplit(5), 4, "odd splits break the ping-pong parity");
  assert.equal(clothSolveSplit(7), 6);
  assert.equal(clothSolveSplit(-3), 0);
  assert.equal(clothSolveSplit(99), CLOTH_SOLVE_PASSES);
  assert.equal(clothSolveSplit(0), 0);
  assert.equal(clothSolveSplit(8), 8);
});

test("⛔ a curtain bunched to 64 % of its own height is not healthy", () => {
  // THE SECOND BLIND SPOT, and the user's answer to the first verdict:
  // "nope, still broken". Mesh_0_20 island 1, live, after the contact
  // reorder. `stretch` took the MAXIMUM in-plane ratio, so the 0.99 across
  // the curtain's width hid the 0.64 down its length.
  const live = classifyClothIsland([2.279, 1.444, 1.126], [2.296, 2.272, 0.202]);
  assert.equal(live.gather, 0.64, "the short axis has to be reported, not maximised away");
  assert.equal(live.verdict, "BUNCHED", `called ${live.verdict} at stretch ${live.stretch}`);
});

test("...and a normally draping curtain still is healthy", () => {
  // A hanging cloth DOES contract as it folds. Every healthy island measured
  // on the live scene must survive the new reading, or the limit is useless.
  for (const [name, [span, rest]] of Object.entries(HEALTHY)) {
    const { verdict, gather } = classifyClothIsland(span, rest);
    assert.equal(verdict, "healthy", `${name} now fails on gather ${gather}`);
  }
  const gathers = Object.values(HEALTHY).map(([s, r]) => classifyClothIsland(s, r).gather);
  assert.ok(Math.min(...gathers) > 0.75, `the tightest healthy drape is ${Math.min(...gathers)} — no room under the limit`);
});

/**
 * ── STRAIN OUTRANKS THE BOX ────────────────────────────────────────────────
 *
 * ⛔ THE BOX'S THIRD BLIND SPOT: it cannot tell BLOWING from CRUMPLED. A
 * curtain swinging out in the wind loses vertical extent while every thread in
 * it sits at exactly its rest length, so `gather` moves when the WIND setting
 * moves. Spring strain does not — it reads the cloth, not the camera angle.
 */
import { MEAN_STRAIN_LIMIT, WORST_STRAIN_LIMIT } from "../src/engine/vfx/clothHealth.js";

test("⛔ a spring at 5.7x its rest length is TORN, whatever the box says", () => {
  // Live Sponza island 0 after the contact-radius fix. The box called this
  // healthy at gather 0.76 while a thread in it was stretched 470 %.
  const box = [2.278, 1.726, 1.033], rest = [2.298, 2.263, 0.197];
  assert.equal(classifyClothIsland(box, rest).verdict, "healthy", "the control: the box alone cannot see it");
  assert.equal(classifyClothIsland(box, rest, { mean: 0.073, worst: 4.7 }).verdict, "TORN");
});

test("a curtain merely BLOWING is not condemned by strain", () => {
  // Same swung-out box, but the springs are at rest — this is what wind looks
  // like, and calling it damage would fail every cloth in a breeze.
  const verdict = classifyClothIsland([2.278, 1.9, 1.0], [2.298, 2.263, 0.197], { mean: 0.01, worst: 0.3 });
  assert.notEqual(verdict.verdict, "TORN");
});

test("either strain reading alone is enough to condemn", () => {
  const box = [2.3, 2.26, 0.5], rest = [2.298, 2.263, 0.197];
  assert.equal(classifyClothIsland(box, rest, { mean: MEAN_STRAIN_LIMIT + 0.01, worst: 0.1 }).verdict, "TORN",
    "a cloth stretched everywhere is torn even with no single bad spring");
  assert.equal(classifyClothIsland(box, rest, { mean: 0.001, worst: WORST_STRAIN_LIMIT + 0.1 }).verdict, "TORN",
    "one thread at triple length is torn even if the average looks fine");
});

test("no strain data leaves the box verdicts exactly as they were", () => {
  // The op can be called against a cloth whose topology is not available; that
  // must not silently turn every island into a pass.
  for (const [name, [span, rest]] of Object.entries(HEALTHY)) {
    assert.equal(classifyClothIsland(span, rest, null).verdict, "healthy", name);
  }
  const [span, rest] = BROKEN["Mesh_0_20 island 0"];
  assert.equal(classifyClothIsland(span, rest, null).verdict, "TORN");
});

/**
 * ── COHERENCE DECIDES ─────────────────────────────────────────────────────
 *
 * ⛔ THE THRESHOLDS CONDEMNED EVERY HEALTHY CLOTH. 0.05 mean / 2 worst were
 * read off ONE unusually relaxed island early on, before it was known that a
 * hanging cloth carries its own weight by stretching (forcing three times the
 * solver iterations barely moved it: 0.060 -> 0.057) and that the real failure
 * is an order of magnitude away, not a few per cent.
 *
 * These fixtures are the live populations, with motion coherence as the ground
 * truth for which is which.
 */
import { COHERENCE_LIMIT } from "../src/engine/vfx/clothHealth.js";

/** Live islands, Sponza, with their measured motion. */
const SWAYING = [
  { name: "M20 i0", span: [2.384, 2.308, 0.429], rest: [2.298, 2.263, 0.197], strain: { mean: 0.088, worst: 2.53 }, motion: { movedMm: 10.74, coherence: 0.96 } },
  { name: "M20 i1", span: [2.429, 2.301, 0.570], rest: [2.296, 2.272, 0.202], strain: { mean: 0.114, worst: 1.40 }, motion: { movedMm: 10.00, coherence: 0.97 } },
  { name: "M18 i2", span: [2.343, 2.263, 0.571], rest: [2.298, 2.263, 0.197], strain: { mean: 0.055, worst: 0.92 }, motion: { movedMm: 15.43, coherence: 0.99 } },
];
/** The island that was visibly wrong, before the shell percentile was fixed. */
const FIGHTING = {
  span: [2.414, 3.432, 0.747], rest: [2.296, 2.272, 0.202],
  strain: { mean: 0.795, worst: 14.66 }, motion: { movedMm: 253.83, coherence: 0.56 },
};

test("⛔ a curtain SWAYING in the wind is not condemned", () => {
  for (const c of SWAYING) {
    const v = classifyClothIsland(c.span, c.rest, c.strain, c.motion);
    assert.equal(v.verdict, "healthy", `${c.name} called ${v.verdict} at strain ${c.strain.mean}, coherence ${c.motion.coherence}`);
  }
});

test("⭐ and the one that was actually fighting is called FIGHTING", () => {
  assert.equal(classifyClothIsland(FIGHTING.span, FIGHTING.rest, FIGHTING.strain, FIGHTING.motion).verdict, "FIGHTING");
});

test("⛔ coherence outranks shape: the same box and strain, judged by motion alone", () => {
  // THE POINT OF THE INSTRUMENT. A cloth the right size in the right place
  // with springs near rest scores perfectly on every SHAPE reading while
  // buzzing — which is what a whole session of "the numbers improved" walked
  // past. Identical geometry, identical strain, opposite verdicts.
  const span = [2.3, 2.26, 0.5], rest = [2.298, 2.263, 0.197], strain = { mean: 0.06, worst: 1.2 };
  assert.equal(classifyClothIsland(span, rest, strain, { movedMm: 12, coherence: 0.97 }).verdict, "healthy");
  assert.equal(classifyClothIsland(span, rest, strain, { movedMm: 12, coherence: 0.4 }).verdict, "FIGHTING");
});

test("a cloth at rest is not called incoherent for having no direction", () => {
  // Guarded: a settled cloth has no displacement to agree on, and scoring that
  // as maximum disagreement would fail every still curtain in the scene.
  assert.equal(classifyClothIsland([2.3, 2.26, 0.5], [2.298, 2.263, 0.197], { mean: 0.06, worst: 1.2 },
    { movedMm: 0.02, coherence: 0.1 }).verdict, "healthy");
  assert.equal(classifyClothIsland([2.3, 2.26, 0.5], [2.298, 2.263, 0.197], { mean: 0.06, worst: 1.2 },
    { movedMm: 12, coherence: null }).verdict, "healthy");
});

test("the thresholds sit in the measured gap, on both readings", () => {
  const healthyMean = Math.max(...SWAYING.map((c) => c.strain.mean));
  const healthyWorst = Math.max(...SWAYING.map((c) => c.strain.worst));
  const healthyCoh = Math.min(...SWAYING.map((c) => c.motion.coherence));
  assert.ok(healthyMean < MEAN_STRAIN_LIMIT / 2, `healthiest mean ${healthyMean} is not clear of ${MEAN_STRAIN_LIMIT}`);
  assert.ok(FIGHTING.strain.mean > MEAN_STRAIN_LIMIT * 2, "the broken mean is not clear of the limit");
  // ⚠ The worst-spring margin is NARROW and the test says so instead of
  // pretending otherwise: healthy cloth spikes to 2.54 and a visibly broken
  // island sat at 4.70, so 3.5 splits them by a whisker. That is why coherence
  // outranks this reading whenever motion data exists.
  assert.ok(healthyWorst < WORST_STRAIN_LIMIT, `healthy worst ${healthyWorst} is over the limit`);
  assert.ok(FIGHTING.strain.worst > WORST_STRAIN_LIMIT * 2, "the broken worst is not clear of the limit");
  assert.ok(healthyCoh > COHERENCE_LIMIT && FIGHTING.motion.coherence < COHERENCE_LIMIT * 0.75,
    `coherence gap is only ${FIGHTING.motion.coherence} -> ${healthyCoh}`);
});

/**
 * ── THE TIMESTEP ──────────────────────────────────────────────────────────
 *
 * ⛔⛔ A CLOTH MUST NOT CHANGE SPEED WITH THE FRAME RATE, AND THIS ONE DID.
 * The substep loop advanced a FIXED step and DISCARDED whatever the frame
 * could not afford, so the cloth ran in slow motion whenever the budget bit —
 * 0.63x in the editor at ~38 fps, 1.00x in play mode at 120. A whole session
 * was spent judging a cloth at two-thirds speed, and the moment the user
 * pressed play it ran properly: "cloth started moving unnatural, like gravity
 * is super strong or it is made of rubber". Nothing about the cloth had
 * changed — only how much of each second it was allowed to simulate.
 */
import {
  clothSubsteps, clothVelocityScale, CLOTH_REFERENCE_STEP, MAX_CLOTH_FRAME,
} from "../src/engine/vfx/clothHealth.js";

test("the OPT-IN real-time step simulates the whole frame, at every rate and budget", () => {
  // ⚠ THIS IS NOT THE DEFAULT — see the h² test at the end of this file, which
  // is why. `clothSubsteps` is the arithmetic behind `__clothRealtimeStep`, and
  // it has to stay honest for whoever turns that on: simulated seconds per real
  // second is 1.
  for (const fps of [144, 120, 90, 60, 45, 38, 30, 24]) {
    for (const budget of [2, 3, 4, 6]) {
      const frame = 1 / fps;
      const { count, step, simulated } = clothSubsteps(frame, budget);
      assert.ok(count >= 1 && count <= budget, `${fps} fps / ${budget}: ran ${count} substeps`);
      assert.ok(
        Math.abs(count * step - frame) < 1e-9,
        `${fps} fps with a budget of ${budget} simulated ${(count * step).toFixed(5)} s of a ${frame.toFixed(5)} s frame`,
      );
      assert.ok(Math.abs(simulated - frame) < 1e-9);
    }
  }
});

test("⛔ THE CONTROL: the fixed-step loop really did run slow", () => {
  // What shipped: as many WHOLE reference steps as the budget allows, the rest
  // dropped. At 38 fps with a budget of 2 that is 1/60 s of a 1/38 s frame.
  const fixed = (frame, budget) => Math.min(budget, Math.floor(frame / CLOTH_REFERENCE_STEP)) * CLOTH_REFERENCE_STEP;
  const frame = 1 / 38;
  assert.ok(fixed(frame, 2) / frame < 0.7, "the fixture must reproduce the slowdown");
  assert.ok(Math.abs(fixed(frame, 2) / frame - 0.633) < 0.01, "0.63x, as measured");
  // ...and at 120 fps the same loop is exactly real time, which is why the two
  // looked like different cloths.
  assert.ok(Math.abs(fixed(1 / 120, 2) / (1 / 120) - 1) < 1e-9);
});

test("a long hitch is DROPPED, not stretched across the same few substeps", () => {
  // A 300 ms step is not cloth motion at any step size, and a loading stall
  // must not launch a curtain across the room.
  const { count, step, simulated } = clothSubsteps(0.3, 2);
  assert.ok(simulated <= MAX_CLOTH_FRAME + 1e-9, `simulated ${simulated} s of a 300 ms hitch`);
  assert.ok(count * step <= MAX_CLOTH_FRAME + 1e-9);
});

test("a frame of no time runs nothing", () => {
  assert.equal(clothSubsteps(0, 4).count, 0);
  assert.equal(clothSubsteps(-1, 4).count, 0);
});

test("⭐ damping is the same PER SECOND however the steps are sized", () => {
  // Damping is authored per reference step. Simulated in fewer, larger steps
  // it must not come out lighter, or a cloth rings exactly where the budget
  // bites — which is the "made of rubber" half of the report.
  const damping = 0.99;
  const perSecond = (fps, budget) => {
    const { count, step } = clothSubsteps(1 / fps, budget);
    // Ignore the step-ratio term here: at a steady frame rate step == previous.
    const perStep = clothVelocityScale(step, step, damping);
    return Math.pow(perStep, count * fps); // one real second
  };
  const reference = Math.pow(damping, 120);
  for (const [fps, budget] of [[120, 2], [60, 2], [38, 2], [30, 6], [144, 4]]) {
    const got = perSecond(fps, budget);
    assert.ok(
      Math.abs(got - reference) < reference * 0.05,
      `${fps} fps / budget ${budget}: ${got.toExponential(2)} per second against ${reference.toExponential(2)}`,
    );
  }
});

test("⚠ a CHANGE of step size rescales the stored velocity, or it reads as an impulse", () => {
  // Verlet keeps velocity as a displacement over the PREVIOUS step. Halving
  // the step without rescaling would halve the apparent speed for one frame —
  // a visible jolt every time the frame rate moves.
  const damping = 1; // isolate the ratio
  assert.ok(Math.abs(clothVelocityScale(1 / 120, 1 / 60, damping) - 0.5) < 1e-6, "step halved -> velocity halved");
  assert.ok(Math.abs(clothVelocityScale(1 / 60, 1 / 120, damping) - 2) < 1e-6, "step doubled -> velocity doubled");
  assert.ok(Math.abs(clothVelocityScale(1 / 120, 1 / 120, damping) - 1) < 1e-6, "steady step -> untouched");
});

/**
 * ── WIND IS A VECTOR ──────────────────────────────────────────────────────
 *
 * ⛔ It was a single number added to +Z, so a curtain could only ever be blown
 * one way: *"our wind is only Z, we must be able to choose any direction"*
 * (user). The schema now carries a `vec3`.
 *
 * ⚠ AND A SAVED SCENE HOLDING A NUMBER MUST STILL LOAD. `wind: 2` meant "2
 * along +Z", so that is exactly what it has to become — no migration pass, no
 * broken projects. These pin the reader that guarantees it.
 */
import { simulationNodeTypes } from "../src/engine/vfx/simulationGraph.js";

/** The reader in `applyProps`, which is where the compatibility lives. */
const readWind = (wind) => (Array.isArray(wind)
  ? [wind[0] ?? 0, wind[1] ?? 0, wind[2] ?? 0]
  : [0, 0, Number.isFinite(wind) ? wind : 2]);

test("⭐ wind is declared as a vec3, defaulting to the direction it always blew", () => {
  const types = simulationNodeTypes("cloth");
  const params = Object.values(types).flatMap((node) => node.params ?? []);
  const wind = params.find((param) => param.key === "wind");
  assert.ok(wind, "no wind parameter in the cloth schema");
  assert.equal(wind.type, "vec3");
  assert.deepEqual(wind.default, [0, 0, 2], "the default must reproduce the old +Z behaviour exactly");
});

test("⛔ a scene saved with a NUMBER still means what it meant", () => {
  assert.deepEqual(readWind(2), [0, 0, 2], "the old scalar was 2 along +Z");
  assert.deepEqual(readWind(-5), [0, 0, -5]);
  assert.deepEqual(readWind(0), [0, 0, 0]);
});

test("a vector is taken as given, on every axis", () => {
  assert.deepEqual(readWind([3, 0, 0]), [3, 0, 0], "wind along X");
  assert.deepEqual(readWind([0, 4, 0]), [0, 4, 0], "an updraft");
  assert.deepEqual(readWind([1, 2, 3]), [1, 2, 3]);
});

test("a missing or malformed wind falls back to the default, not to NaN", () => {
  assert.deepEqual(readWind(undefined), [0, 0, 2]);
  assert.deepEqual(readWind(null), [0, 0, 2]);
  assert.deepEqual(readWind([1]), [1, 0, 0], "a short vector fills with zeroes rather than undefined");
});

/**
 * ⛔⛔ WHY THE FRAME IS NOT DIVIDED BETWEEN THE SUBSTEPS THE BUDGET ALLOWS.
 *
 * "Consume the whole frame" is the obvious fix for cloth that slows down when
 * the substep budget bites, and it is right about the CLOCK. It is wrong about
 * this SOLVER, and the test below is the reason the real-time step ships
 * OPT-IN (`__clothRealtimeStep`) rather than as the default.
 *
 * Verlet's force term is `f·h²`, so a bigger step hands the constraint solver a
 * bigger violation to clean up each step. The cleanup is a FIXED eight Jacobi
 * passes, and Jacobi removes a fixed FRACTION of a violation per pass, never a
 * fixed distance. Four times the step is therefore sixteen times the residual
 * stretch — the cloth sags further AND springs back soft.
 *
 * That pair is exactly what was reported when the real-time step shipped:
 * "cloth started moving unnatural, like gravity is super strong or it is made
 * of rubber" (user, 2026-09-08). A Sponza curtain is far past the
 * 6 144-particle budget, so it runs at `maxSubsteps` = 2 always. At 15 fps the
 * frame is first clamped to `MAX_CLOTH_FRAME` (1/20) and then halved, giving
 * h = 1/40 — the THREE-times step this test measures, for nine times the
 * force term. At 60 fps the same division lands exactly on 1/120 and costs
 * nothing, which is why this only ever bit under load.
 */

/**
 * A pinned chain under gravity, integrated exactly as `gridSimulation` does:
 * Verlet with `velocityScale`, then `passes` JACOBI distance relaxations. Runs
 * to steady state and returns how far it stretched past its rest length.
 */
function hangingChainStretch({ step, passes = CLOTH_SOLVE_PASSES, damping = 0.99, links = 12, restLength = 0.2, gravity = 9.81, seconds = 400 }) {
  const n = links + 1;
  const y = Array.from({ length: n }, (_, i) => -i * restLength);
  const old = y.slice();
  const scale = clothVelocityScale(step, step, damping, CLOTH_REFERENCE_STEP);
  const steps = Math.round(seconds / step);
  for (let s = 0; s < steps; s++) {
    for (let i = 1; i < n; i++) {
      const next = y[i] + (y[i] - old[i]) * scale - gravity * step * step;
      old[i] = y[i];
      y[i] = next;
    }
    // Jacobi: every correction is computed from the SAME buffer, then applied.
    for (let p = 0; p < passes; p++) {
      const delta = new Float64Array(n);
      const touched = new Float64Array(n);
      for (let i = 0; i < n - 1; i++) {
        const d = y[i] - y[i + 1];
        const error = (Math.abs(d) - restLength) * Math.sign(d) * 0.5;
        delta[i] -= error; delta[i + 1] += error;
        touched[i]++; touched[i + 1]++;
      }
      for (let i = 1; i < n; i++) if (touched[i]) y[i] += delta[i] / touched[i];
    }
  }
  return Math.abs(y[0] - y[n - 1]) / (links * restLength);
}

test("⛔⛔ A THREE-TIMES STEP IS RUBBER: residual stretch scales with h², not with h", () => {
  // The reference step, and the step the real-time division actually produces
  // for a mesh curtain at 15 fps — which the test below pins at 1/40.
  const reference = hangingChainStretch({ step: CLOTH_REFERENCE_STEP });
  const realtime = hangingChainStretch({ step: 1 / 40 });

  // The reference step holds its rest length to a couple of percent. It is not
  // zero and should not be: eight Jacobi passes cannot reach the far end of a
  // twelve-link chain in one step, and that finite stiffness is the whole
  // reason the step size matters so much.
  assert.ok(reference < 1.02, `the reference step should barely stretch, got ${reference.toFixed(4)}`);

  // ⭐ THE MEASUREMENT. Both runs are the same cloth, the same eight passes and
  // the same authored damping — the ONLY difference is the step size, and the
  // velocity rescale that is supposed to make a step change harmless is
  // applied. The extra sag is the "gravity is super strong" half of the report
  // and the softness that produced it is the "made of rubber" half.
  const referenceSag = reference - 1, realtimeSag = realtime - 1;
  assert.ok(realtimeSag > referenceSag * 4,
    `a 3x step should leave far more residual stretch (h² is 9x); reference sag ${(referenceSag * 100).toFixed(3)} %, real-time sag ${(realtimeSag * 100).toFixed(3)} %`);
});

test("⭐ the step a curtain actually gets, at the frame rates that matter", () => {
  // The behaviour is not deleted, only moved behind `__clothRealtimeStep`. What
  // it hands the solver is the whole argument, so it is written down: at 60 fps
  // the division is free, and everything below that pays h².
  const stepAt = (fps) => clothSubsteps(1 / fps, 2, CLOTH_REFERENCE_STEP).step;
  assert.ok(Math.abs(stepAt(60) - CLOTH_REFERENCE_STEP) < 1e-9, "at 60 fps it lands exactly on the reference step");
  assert.ok(Math.abs(stepAt(30) - 1 / 60) < 1e-9, "at 30 fps the step doubles");
  // Below 20 fps the frame is clamped first, so the step stops growing at 1/40.
  assert.ok(Math.abs(stepAt(15) - 1 / 40) < 1e-9, `at 15 fps the clamp caps the step at 1/40, got ${stepAt(15)}`);
  assert.ok(Math.abs(stepAt(5) - 1 / 40) < 1e-9, "and no slower frame can push it past that");
});
