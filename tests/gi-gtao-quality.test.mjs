import assert from "node:assert/strict";
import { giGtaoRadiusIntervals, giGtaoResolutionScale, giGtaoSamplingPreset } from "../src/modules/gi/giConfig.js";

assert.deepEqual(
  Object.fromEntries(["low", "medium", "high", "ultra"].map((tier) => [tier, giGtaoResolutionScale(tier)])),
  { low: 0.5, medium: 0.8, high: 1, ultra: 1 },
  "GTAO resolution ladder drifted from the authored quality contract",
);

assert.equal(giGtaoResolutionScale("ultra", 0.75), 0.75, "diagnostic scale override was ignored");
assert.equal(giGtaoResolutionScale("ultra", 9), 1, "scale override exceeded the full-res ceiling");
assert.equal(giGtaoResolutionScale("medium", 0), 0.25, "scale override exceeded the lower safety bound");

assert.deepEqual(
  giGtaoSamplingPreset("ultra"),
  { slices: 5, steps: 4, spatialJitter: false, filterRadius: 3 },
  "ultra must evaluate a complete angular pattern per pixel instead of printing angular strata",
);
assert.equal(giGtaoSamplingPreset("high").spatialJitter, true, "cheaper tiers lost their shared strata");
assert.equal(giGtaoSamplingPreset("high").filterRadius, 2, "cheaper tiers inherited Ultra's filter cost");

assert.equal(giGtaoRadiusIntervals(), 1, "shipping GTAO reach escaped the contact band");
assert.equal(giGtaoRadiusIntervals(0.25), 0.5, "GTAO reach override bypassed its lower bound");
assert.equal(giGtaoRadiusIntervals(99), 8, "GTAO reach override bypassed its upper bound");

console.log("GI GTAO QUALITY PASS");
