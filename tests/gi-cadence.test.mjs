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
