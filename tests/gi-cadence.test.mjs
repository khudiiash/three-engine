import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { shouldDispatchGiWorld, stepGiWorldCadence } from "../src/modules/gi/giCadence.js";

test("60 Hz rendering advances persistent GI world transport at about 30 Hz", () => {
  let next;
  let updates = 0;
  for (let now = 0; now < 1000; now += 1000 / 60) {
    const step = stepGiWorldCadence(now, next, 30);
    next = step.nextAt;
    if (step.due) updates++;
  }
  assert.ok(updates >= 29 && updates <= 31, `expected ~30 updates, got ${updates}`);
});

test("a renderer below the target rate advances transport every frame", () => {
  let next;
  let updates = 0;
  for (let now = 0; now < 1000; now += 50) {
    const step = stepGiWorldCadence(now, next, 30);
    next = step.nextAt;
    if (step.due) updates++;
  }
  assert.equal(updates, 20);
});

test("disabled cadence and clock discontinuities fail open", () => {
  assert.equal(stepGiWorldCadence(10, 100, 0).due, true);
  assert.equal(stepGiWorldCadence(10_000, 20, 30).due, true);
});

test("slow-frame backpressure alternates only persistent world transport", () => {
  assert.equal(shouldDispatchGiWorld({ due: true, frameGapMs: 50, dispatchedPreviousFrame: true, hz: 30 }), false);
  assert.equal(shouldDispatchGiWorld({ due: true, frameGapMs: 50, dispatchedPreviousFrame: false, hz: 30 }), true);
  assert.equal(shouldDispatchGiWorld({ due: true, frameGapMs: 16, dispatchedPreviousFrame: true, hz: 30 }), true);
  assert.equal(shouldDispatchGiWorld({ due: false, frameGapMs: 50, dispatchedPreviousFrame: false, hz: 30 }), false);
});

test("GISystem cadences world transport but dispatches screen consumers every frame", () => {
  const source = fs.readFileSync(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
  assert.match(source, /src\.screenPassStart/);
  assert.match(source, /src\.passes\.slice\(0, split\)/);
  assert.match(source, /src\.passes\.slice\(split\)/);
  assert.match(source, /stepGiWorldCadence/);
  assert.match(source, /shouldDispatchGiWorld/);
  assert.match(source, /if \(worldDue\)/);
  assert.match(source, /giCompute\(renderer, screenPasses/);
});

test("a skipped downstream pipeline never invalidates a completed occupancy fill", () => {
  const source = fs.readFileSync(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
  const start = source.indexOf("giCompute(renderer, rateQueue);", source.indexOf("const occPasses"));
  const end = source.indexOf("if (this._fieldReadyOnce) this.#maybeLogStats", start);
  assert.ok(start >= 0 && end > start, "occupancy retry block must remain discoverable");
  const downstreamRetry = source.slice(start, end);
  assert.match(downstreamRetry, /this\._fieldReadyOnce = false/);
  assert.doesNotMatch(
    downstreamRetry,
    /occupancyField\?\.invalidate\(\)/,
    "only an occupancy wait/skip may invalidate occupancy; downstream retries must reuse it",
  );
});

test("an incomplete occupancy chain never feeds screen or temporal consumers", () => {
  const source = fs.readFileSync(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
  const earlyGate = source.indexOf(
    "if (state.screen.srcProbes && this._occupancyChainIncomplete !== true)",
  );
  const earlyWorldDispatch = source.indexOf("giCompute(renderer, worldPasses", earlyGate);
  const occupancyAttempt = source.indexOf("const occPasses =", earlyWorldDispatch);
  assert.ok(earlyGate >= 0, "cross-frame SRC consumers need an incomplete-chain gate");
  assert.ok(
    earlyGate < earlyWorldDispatch && earlyWorldDispatch < occupancyAttempt,
    "the regression requires guarding the SRC dispatch that precedes occupancy retry",
  );

  const start = source.indexOf("if (occWait || occSkipped)", occupancyAttempt);
  const end = source.indexOf("} else {", start);
  assert.ok(start >= 0 && end > start, "occupancy bail branch must remain discoverable");
  const bail = source.slice(start, end);
  assert.doesNotMatch(
    bail,
    /giCompute\(renderer, rateQueue\)/,
    "a partial clear/voxelize chain must not enter temporal history",
  );
  assert.match(
    bail,
    /this\._occupancyChainIncomplete = true/,
    "the next frame must remember that occupancy buffers may be partial",
  );

  const successEnd = source.indexOf("giCompute(renderer, rateQueue)", end);
  const success = source.slice(end, successEnd);
  assert.match(
    success,
    /if \(occPasses\) this\._occupancyChainIncomplete = false/,
    "only a completed occupancy attempt may reopen SRC consumers",
  );
  assert.doesNotMatch(
    source.slice(earlyGate, earlyWorldDispatch),
    /if \(state\.screen\.srcProbes && this\._fieldReadyOnce/,
    "downstream warm-up must not self-deadlock the occupancy-consumer gate",
  );
});

// ── §11.55: the world rate follows the light-motion drive ──────────────────
import { GI_WORLD_REST_HZ, GI_WORLD_UPDATE_HZ, giRateCompensatedAlpha, giWorldRateHz } from "../src/modules/gi/giCadence.js";

test("the world rate rests at the rest rate, saturates at the full rate, and rises monotonically between", () => {
  assert.equal(giWorldRateHz({ rested: true, drive: 1 }), GI_WORLD_REST_HZ);
  assert.equal(giWorldRateHz({ rested: false, drive: 0.05 }), GI_WORLD_REST_HZ);
  assert.equal(giWorldRateHz({ rested: false, drive: 1 }), GI_WORLD_UPDATE_HZ);
  assert.equal(giWorldRateHz({ rested: false, drive: 0.6 }), GI_WORLD_UPDATE_HZ);
  let last = 0;
  for (let d = 0; d <= 1; d += 0.01) {
    const hz = giWorldRateHz({ rested: false, drive: d });
    assert.ok(hz >= last - 1e-9, `rate must not fall with drive (${d})`);
    assert.ok(hz >= GI_WORLD_REST_HZ && hz <= GI_WORLD_UPDATE_HZ);
    last = hz;
  }
  // A 3-minute Sponza day (drive ~0.35) runs well under the full rate.
  const slowSun = giWorldRateHz({ rested: false, drive: 0.35 });
  assert.ok(slowSun > GI_WORLD_REST_HZ + 2 && slowSun < GI_WORLD_UPDATE_HZ - 2, `got ${slowSun}`);
  // Opted out = the old binary rate. A missing drive fails to the full rate.
  assert.equal(giWorldRateHz({ rested: false, drive: 0.35, scaled: false }), GI_WORLD_UPDATE_HZ);
  assert.equal(giWorldRateHz({ rested: false, drive: Number.NaN }), GI_WORLD_UPDATE_HZ);
});

test("the rate-compensated alpha holds the per-second decay and is the identity at the full rate", () => {
  for (const alpha of [0.02, 0.048, 0.1]) {
    assert.equal(giRateCompensatedAlpha(alpha, GI_WORLD_UPDATE_HZ), alpha);
    assert.equal(giRateCompensatedAlpha(alpha, 60), alpha);
    assert.equal(giRateCompensatedAlpha(alpha, Number.NaN), alpha);
    for (const hz of [15, 20, 23.6]) {
      const lifted = giRateCompensatedAlpha(alpha, hz);
      assert.ok(lifted > alpha);
      // (1 − α')^hz == (1 − α)^30: the same fraction of the field survives a second.
      assert.ok(Math.abs((1 - lifted) ** hz - (1 - alpha) ** GI_WORLD_UPDATE_HZ) < 1e-12);
    }
  }
  assert.equal(giRateCompensatedAlpha(1, 15), 1);
  assert.equal(giRateCompensatedAlpha(0, 15), 0);
});
