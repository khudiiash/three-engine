/**
 * Gate for the frame-rate floor (engine/frameGovernor.js).
 *
 * The controller's dangerous failures are not "it did not react" — they are
 * reacting too much: a resize storm, an oscillation between two rungs, or
 * spending quality on a frame that is CPU-bound where it can buy nothing. Each
 * of those is asserted here directly, because each of them ships as a visible
 * hitch rather than as a slow frame.
 */
import assert from "node:assert";

const { FrameGovernorSystem, GI_COST_LADDER } = await import("../src/engine/frameGovernor.js");

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}\n       ${error.message}`);
  }
};

/**
 * A stand-in engine: the governor only ever reads `settings.performance` and
 * `stats.readout.gpuMs`, so the fake is the whole contract.
 */
function makeEngine({ targetFps = 60, adaptiveQuality = true } = {}) {
  return {
    settings: { performance: { targetFps, adaptiveQuality } },
    // `workMs` is the engine's own CPU time for the frame. 0 means "unknown",
    // which the governor treats as "no reason to hold".
    stats: { readout: { gpuMs: 0, workMs: 0 } },
  };
}

/**
 * Run `frames` ticks at a GPU cost supplied by `costFor(scale)`, advancing a
 * fake clock so the interval floors are exercised rather than bypassed.
 */
function run(gov, engine, frames, costFor, { startMs = 0, msPerFrame = 16, cpuFor = null } = {}) {
  let now = startMs;
  for (let i = 0; i < frames; i++) {
    engine.stats.readout.gpuMs = costFor(gov.scale);
    // `cpuFor` exists because the governor's aim is `max(budget, cpu)` — the CPU
    // is INSIDE the threshold, so a fixture that holds it constant cannot see
    // the failure mode that actually shipped. See the jitter check below.
    if (cpuFor) engine.stats.readout.workMs = cpuFor(i);
    gov.update(now);
    now += msPerFrame;
  }
  return now;
}

/** A scene whose GPU cost is exactly proportional to the traced-pixel scale. */
const linearCost = (atFullScale) => (scale) => atFullScale * scale;

check("an untouched scene sits at rung 0 — the governor is invisible when it can be", () => {
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  assert.equal(gov.scale, 1);
  run(gov, engine, 300, linearCost(10)); // 10 ms, comfortably inside a 15 ms aim
  assert.equal(gov.level, 0, "a frame that makes its target must never be degraded");
  assert.equal(gov.stats.changes, 0, "and must never pay for a resize");
});

check("⭐ a GPU-bound frame is brought to the aim and STAYS there", () => {
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  // 46 ms at full scale — the measured Bistro/ultra frame this was built for.
  const end = run(gov, engine, 4000, linearCost(46), { msPerFrame: 20 });
  const settled = 46 * gov.scale;
  assert.ok(gov.level > 0, "it must actually spend something");
  assert.ok(settled <= 15.1, `expected the settled GPU cost under the 15 ms aim, got ${settled.toFixed(1)}ms`);
  // ⚠ THE REAL ASSERTION. Reaching the aim is easy; reaching it and then
  // sitting still is the whole design. Anything that keeps resizing is a
  // permanent hitch generator, which the 60 fps rule counts as a regression
  // regardless of the average frame time it achieves.
  const changesAtEnd = gov.stats.changes;
  run(gov, engine, 2000, linearCost(46), { startMs: end, msPerFrame: 20 });
  assert.equal(gov.stats.changes, changesAtEnd, "the loop must stop moving once it is on target");
  assert.ok(changesAtEnd <= 3, `expected to converge in a few resizes, took ${changesAtEnd}`);
});

check("⭐ a big miss is SNAPPED in one resize, not walked down rung by rung", () => {
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  // 5x over the aim: walking would be four resizes and four hitches.
  run(gov, engine, 200, linearCost(75), { msPerFrame: 20 });
  assert.equal(gov.stats.changes, 1, `expected one snap, took ${gov.stats.changes}`);
  assert.ok(gov.level >= 3, `expected the snap to land deep in the ladder, got rung ${gov.level}`);
});

check("⭐ it climbs back when the load lifts — and does not overshoot into a miss", () => {
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  let now = run(gov, engine, 600, linearCost(46), { msPerFrame: 20 });
  const degraded = gov.level;
  assert.ok(degraded > 0, "fixture must have degraded first");
  // The load drops to a quarter — a camera turning away from the expensive view.
  now = run(gov, engine, 8000, linearCost(11), { startMs: now, msPerFrame: 20 });
  assert.ok(gov.level < degraded, "it must give the quality back");
  assert.ok(11 * gov.scale <= 15.1, "and must not climb into a frame that misses the aim");
});

check("⭐⭐ a rung spent while CPU-bound is GIVEN BACK, not held forever", () => {
  // THE SECOND LIVE BUG, and the one the user actually saw as "reflections look
  // incredibly shitty". With the crossover enforced only on the DESCENT, the
  // loop parked at a rung it could neither leave nor improve: dropping was
  // blocked by the guard, and climbing compared against the raw 15 ms aim,
  // which a CPU-bound frame can never reach. Measured live: rung 3 held
  // permanently at GPU 23.7 ms against a CPU of 30.6 ms — a whole rung of
  // reflection sharpness discarded for zero fps.
  //
  // Fixture: the scene degrades under a heavy CPU, then the CPU load lifts
  // enough that the GPU has room to climb back.
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  engine.stats.readout.workMs = 40;
  let now = run(gov, engine, 2000, linearCost(60), { msPerFrame: 40 });
  const degraded = gov.level;
  assert.ok(degraded > 0, "fixture must degrade first");

  // The CPU stays the limiter, but there is now real GPU headroom underneath
  // it — enough for a whole rung, which is the only headroom a discrete ladder
  // can spend. (A gap smaller than one rung is correctly left alone: climbing
  // into it would land in a miss and drop straight back.)
  engine.stats.readout.workMs = 60;
  run(gov, engine, 12000, linearCost(60), { startMs: now, msPerFrame: 60 });
  assert.ok(
    gov.level < degraded,
    `it must climb back into the headroom the CPU leaves — stuck on rung ${gov.level}`,
  );
  assert.ok(60 * gov.scale <= 60.1, "and must not climb past what the CPU allows");
});

check("⛔ NO OSCILLATION: a cost sitting right on the aim must not hunt", () => {
  // ⚠ EXPRESSED RELATIVE TO THE GOVERNOR'S OWN AIM, not to a hard-coded 15 ms.
  // The literal made this check silently stop testing the boundary the day
  // GPU_BUDGET_SHARE moved: 15 ms went from "exactly on the aim" to "past the
  // drop threshold", and the fixture became a walk to the bottom of the ladder.
  const probeEngine = makeEngine();
  const probe = new FrameGovernorSystem(probeEngine);
  run(probe, probeEngine, 1, () => 1, {});
  const aim = probe.stats.aimMs;
  assert.ok(aim > 0, "the fixture needs the governor's real aim");

  for (const [label, atFullScale] of [["on the aim", aim], ["just inside the margin", aim * 1.05]]) {
    const engine = makeEngine();
    const gov = new FrameGovernorSystem(engine);
    run(gov, engine, 6000, linearCost(atFullScale), { msPerFrame: 16 });
    assert.equal(gov.stats.changes, 0, `${label}: the dead band must hold it still`);
  }

  // And the case that actually could cycle: over the threshold at rung 0, so it
  // steps once — and the rung it lands on must not then look like headroom.
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  run(gov, engine, 12_000, linearCost(aim * 1.25), { msPerFrame: 16 });
  assert.equal(gov.stats.changes, 1, `expected one step and silence, saw ${gov.stats.changes}`);
});

check("⛔⛔ A JITTERING CPU MUST NOT DRIVE THE LOOP — the live 'gi constantly reloads' bug", () => {
  // THE FAILURE THE USER REPORTED, as a fixture. Bistro/ultra, PARKED camera,
  // nothing in the scene moving: `governor.changes` climbed 12 → 23 and the
  // console filled with `[gi] src ... slot NEE replaced` on a 4-second cadence,
  // which is `MIN_CLIMB_INTERVAL_MS` exactly. Every one of those is a full GI
  // field rebuild and the loss of every temporal history.
  //
  // The cause is not in the ladder or the dead band — for a stationary cost
  // those make oscillation unreachable (see the inequality in the module
  // header). It is that `effectiveAim = max(budget, cpu)` fed on the RAW
  // per-frame CPU, so the threshold moved further between frames than the dead
  // band was wide. A 6% wobble was enough.
  //
  // The wave here is much worse than the live one on purpose: 32↔46 ms is a
  // 44% swing, held long enough at each end that no filter can dismiss it as
  // noise.
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  const cpuWave = (i) => (Math.floor(i / 200) % 2 === 0 ? 32 : 46);
  // 36 ms of GPU at full scale — the measured live reading, sitting right in
  // the middle of that CPU wave, which is what makes it marginal in BOTH
  // directions and therefore able to cycle.
  run(gov, engine, 30_000, linearCost(36), { msPerFrame: 20, cpuFor: cpuWave });
  // ⚠ NOT `changes === 0`. A swing this size genuinely does change what the
  // frame can afford, and refusing to ever move would be the opposite bug. What
  // must be bounded is the RATE: 30 000 frames at 20 ms is ten simulated
  // minutes, and the old loop produced a step every four seconds — 150 of them.
  assert.ok(
    gov.stats.changes <= 12,
    `ten minutes of CPU jitter produced ${gov.stats.changes} GI rebuilds`,
  );
});

check("⛔⛔ a CPU that gets FASTER on an idle scene is chased once per RUNG, not per drift", () => {
  // THE LIVE TELEMETRY THIS ENCODES (2026-08-25, idle Bistro, parked camera,
  // "gi still reloads occasionally for no reason"): editor background work
  // wound down, cpuEma drifted 34.4 → 25.9 ms, and the loop chased the falling
  // aim down three rungs in nine minutes — three full GI re-mints, each a
  // visible reset, each buying a couple of ms of a frame the CPU still owned.
  //
  // The rule under test: a CPU-bound drop fires only when the recoverable
  // overlap is worth a whole rung (gpu > cpu × 1.35), so a slow drift costs AT
  // MOST one re-mint per full rung of overlap it opens — never one per 12%
  // threshold crossing.
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  // The measured Bistro shape: a fixed GPU floor (srcProbes is pool-driven and
  // does not scale with resolve pixels) plus a scaled part.
  //
  // ⚠ THE NUMBERS ARE PINNED SO PHASE 1 CONVERGES TO THE SAME RUNG UNDER BOTH
  // MARGINS. The first version let the margins converge to DIFFERENT rungs,
  // which absorbed the drift difference and the negative control passed — the
  // fixture was testing phase 1's convergence, not the drift rule. cpu 36 puts
  // rung 1 (gpu 38.2) under both 36 × 1.12 and 36 × 1.35, so both arms start
  // identically; the drift to 29.5 then crosses the 1.12 threshold
  // (38.2 / 1.12 = 34.1) but never the 1.35 one (38.2 / 1.35 = 28.3) — exactly
  // the live shape, where gpu 32.5 against a cpu falling 34.4 → 25.9 kept
  // crossing 12% lines without ever opening a full rung.
  const cost = (scale) => 8 + 42 * scale;

  // Phase 1: heavy CPU, converge. Both margins land on rung 1.
  const now = run(gov, engine, 3000, cost, { msPerFrame: 33, cpuFor: () => 36 });
  const converged = gov.stats.changes;
  const level = gov.level;
  assert.equal(gov.level, 1, "fixture precondition: converged exactly one rung down");

  // Phase 2: the CPU drifts 36 → 29.5 ms over ~6 simulated minutes. Less than
  // one rung of overlap ever opens, so NOTHING may fire.
  run(gov, engine, 12000, cost, {
    startMs: now,
    msPerFrame: 33,
    cpuFor: (i) => 36 - Math.min(6.5, (i / 12000) * 6.5),
  });
  assert.equal(
    gov.stats.changes, converged,
    `the drift cost ${gov.stats.changes - converged} re-mint(s) without ever opening a full rung `
      + "of overlap — that is the 'gi reloads for no reason' bug",
  );
  assert.equal(gov.level, level, "and the rung must hold still while the aim wanders");
});

check("⛔ a brief CPU DIP must not be mistaken for a frame that got cheaper", () => {
  // The aim floor protects the CLIMB side only — a drop answers a miss that has
  // already happened, so it deliberately reads the live aim. That leaves the
  // drop exposed to the opposite transient: a GC pause or a scheduling gap ends
  // and the CPU briefly reads far LOWER than the scene's real cost, which lowers
  // `max(budget, cpu)` and makes a perfectly healthy GPU look like a miss.
  //
  // 12 frames is the whole point of the fixture: it is exactly
  // FRAMES_BEFORE_DROP, so a raw reading arms a drop on the first dip, while a
  // 10-frame EMA is still less than halfway down when the dip ends.
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  const dips = (i) => (i % 600 < 12 ? 22 : 40);
  run(gov, engine, 6000, linearCost(36), { msPerFrame: 25, cpuFor: dips });
  assert.equal(
    gov.stats.changes,
    0,
    `a 36ms GPU under a 40ms CPU is not a miss — ${gov.stats.changes} rebuilds bought by transients`,
  );
});

check("⛔ the DROP THRESHOLD itself must fit inside the frame budget", () => {
  // The loop acts at `aim x DROP_OVER`, not at `aim`, so THAT is the number the
  // 60 fps floor is really made of. With GPU_BUDGET_SHARE left at 0.9 the
  // margin pushed it to 16.8 ms — 59.5 fps — and every existing fixture missed
  // it because they all asserted against `aimMs`.
  const engine = makeEngine({ targetFps: 60 });
  const gov = new FrameGovernorSystem(engine);
  run(gov, engine, 200, linearCost(46), { msPerFrame: 20 });
  assert.ok(gov.stats.dropOverMs > 0, "the receipt must be published");
  assert.ok(
    gov.stats.dropOverMs <= 1000 / 60,
    `the loop tolerates ${gov.stats.dropOverMs}ms of GPU, past the 16.67ms a 60 fps frame has`,
  );
});

check("⭐⭐ the RESIZE HITCH does not drive the loop into a resize storm", () => {
  // A GI resize re-creates every target, resizes the probe population and
  // rebuilds the resolve pipeline (~56 pipelines) — so the frames right after
  // a step are far slower than the rung they just moved to. Fed back into the
  // loop that reads as "still missing", and the controller drops again... on a
  // cost it caused itself. The settle window is the only thing standing
  // between this design and a permanent hitch generator, and the plain linear
  // fixtures above cannot see it because nothing in them models the transient.
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  let lastScale = gov.scale;
  let sinceChange = 1e9;
  const cost = (scale) => {
    if (scale !== lastScale) {
      lastScale = scale;
      sinceChange = 0;
    }
    sinceChange++;
    // 46 ms at full scale, and a 4x spike for 30 frames after every step —
    // one sync pipeline rebuild plus the frames that re-accumulate the
    // temporal histories the resize threw away.
    const steady = 46 * scale;
    return sinceChange <= 30 ? steady * 4 : steady;
  };
  run(gov, engine, 4000, cost, { msPerFrame: 20 });
  assert.ok(
    gov.stats.changes <= 4,
    `the transient must not be mistaken for the rung: ${gov.stats.changes} resizes`,
  );
  // ⭐ THE SHARP ASSERTION, and the one the interval floor alone cannot carry:
  // the loop must land on the SHALLOWEST rung that meets the aim, not one
  // below it. 46 ms needs scale <= 15/46 = 0.326, which is rung 4 (0.27).
  // Settling on rung 5 would be a permanent quality loss bought by measuring
  // the controller's own resize instead of the rung it moved to.
  const shallowest = GI_COST_LADDER.findIndex((s) => 46 * s <= 15.1);
  assert.equal(
    gov.level,
    shallowest,
    `expected rung ${shallowest} (the cheapest that meets the aim), settled on ${gov.level}`,
  );
});

check("⭐⭐ a COMPILE STALL must not be mistaken for a scene that is too heavy", () => {
  // Boot reality, and the reason `hold()` exists: GI suspends rendering for
  // seconds while it compiles, and the frame that resumes is enormous (the
  // console has logged 1163 ms). None of that is a cost the pixel budget can
  // buy back. MEASURED on the first live boot with this controller: 8 resizes
  // before the scene had settled. Engine#tick calls hold() on every path that
  // skips a draw, so the loop must ride straight through this.
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  let now = 0;
  for (let i = 0; i < 400; i++) {
    // Every 20th frame the engine skips a draw; the next one is a 1163 ms
    // recompile spike. Between stalls the scene comfortably makes its target.
    if (i % 20 === 0) {
      gov.hold(now);
      now += 400;
      engine.stats.readout.gpuMs = 1163;
    } else {
      engine.stats.readout.gpuMs = 9;
    }
    gov.update(now);
    now += 16;
  }
  assert.equal(gov.level, 0, `a stalling boot must not be degraded — landed on rung ${gov.level}`);
  assert.equal(gov.stats.changes, 0, `and must not pay for a resize: ${gov.stats.changes}`);
});

check("⛔ a CPU-BOUND frame is left completely alone", () => {
  // The GPU is idle at 6 ms and the frame is still 33 ms because submission
  // owns it. Traced pixels cannot buy that back, so spending them would be a
  // silent quality loss for nothing.
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  engine.stats.readout.workMs = 33;
  run(gov, engine, 2000, () => 6, { msPerFrame: 33 });
  assert.equal(gov.level, 0, "a frame the governor cannot help must not be degraded");
});

check("⭐⭐ it stops descending at the CPU crossover instead of walking to the bottom", () => {
  // THE LIVE BUG THIS ENCODES. On Bistro/ultra the loop reached the bottom rung
  // and sat there reporting "gpu 17.1ms over 15.0ms aim" while the CPU was
  // 33 ms. Every rung past the crossover bought zero fps — the frame was gated
  // on draw submission the whole time — and cost real GI resolution.
  //
  // 46 ms GPU at full scale, CPU pinned at 33 ms. The governor SHOULD spend
  // down to roughly the CPU (below that the GPU is no longer the limiter) and
  // then stop, well short of the bottom.
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  engine.stats.readout.workMs = 33;
  run(gov, engine, 6000, linearCost(46), { msPerFrame: 33 });
  assert.ok(gov.level > 0, "it must still spend while the GPU is genuinely the limiter");
  assert.ok(
    46 * gov.scale <= 33,
    `it must spend down to the crossover: ${(46 * gov.scale).toFixed(1)}ms GPU vs 33ms CPU`,
  );
  assert.ok(gov.stats.effectiveAimMs >= 33, "the CPU must be folded into the aim, not bolted beside it");
  // ⚠ THE DISCRIMINATING BOUND. Without the crossover clamp the loop settles on
  // rung 4 (0.27 → 12.4 ms GPU against a 33 ms CPU): three rungs of GI
  // resolution spent for zero fps. The first rung that clears the crossover is
  // rung 2 (0.52 → 23.9 ms), so anything past it is quality burnt for nothing.
  // An earlier version of this test asserted only `level < bottom` and PASSED
  // with the guard disabled — the guard alone stops the next descent, but the
  // snap had already overshot in one step.
  assert.ok(
    gov.level <= 2,
    `it must stop AT the crossover, not past it — settled on rung ${gov.level} ` +
      `(${(46 * gov.scale).toFixed(1)}ms GPU against a 33ms CPU)`,
  );
});

check("⛔ no GPU timestamps → hold the authored cost rather than guess", () => {
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  run(gov, engine, 2000, () => 0, { msPerFrame: 50 });
  assert.equal(gov.level, 0, "without a real GPU number there is no way to know a drop would help");
  assert.equal(gov.scale, 1);
});

check("switching it off returns the authored cost immediately", () => {
  const engine = makeEngine();
  const gov = new FrameGovernorSystem(engine);
  run(gov, engine, 600, linearCost(46), { msPerFrame: 20 });
  assert.ok(gov.level > 0, "fixture must have degraded first");
  engine.settings.performance.adaptiveQuality = false;
  gov.update(1e6);
  assert.equal(gov.level, 0, "a scene must not keep a rung it can no longer climb out of");
  assert.equal(gov.scale, 1);
  assert.equal(gov.stats.enabled, false);
});

check("a 30 fps target spends less than a 60 fps one on the same scene", () => {
  const at = (targetFps) => {
    const engine = makeEngine({ targetFps });
    const gov = new FrameGovernorSystem(engine);
    run(gov, engine, 3000, linearCost(46), { msPerFrame: 20 });
    return gov.level;
  };
  assert.ok(at(30) < at(60), "a looser target must degrade less");
});

check("the ladder is monotonic, starts at 1, and never reaches zero", () => {
  assert.equal(GI_COST_LADDER[0], 1, "rung 0 must be the authored cost exactly");
  for (let i = 1; i < GI_COST_LADDER.length; i++) {
    assert.ok(GI_COST_LADDER[i] < GI_COST_LADDER[i - 1], `rung ${i} must be cheaper than ${i - 1}`);
    assert.ok(GI_COST_LADDER[i] > 0, "a rung of 0 would size the resolve to nothing");
  }
});

console.log(failures === 0 ? "\nall ok" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
