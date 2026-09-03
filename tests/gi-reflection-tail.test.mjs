import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GI_EXACT_TAIL_FULL,
  GI_EXACT_TAIL_ZERO,
  giExactPrefilterMean,
  giExactPrefilterTapCount,
  giNeedsExactTrace,
  giExactTailWeight,
  giRoughnessBucketOf,
} from "../src/modules/gi/giLight.js";
import { giBvhHitShadeReplicatesTarget } from "../src/modules/gi/giScreen.js";

test("every exact-hit rebuild receives the live Bounce weight", () => {
  const source = readFileSync(
    new URL("../src/modules/gi/GISystem.js", import.meta.url),
    "utf8",
  );
  const calls = source.split("createGiBvhHitShade({").slice(1);
  assert.equal(calls.length, 3, "the hit-shade build-path count changed");
  for (const call of calls) {
    const args = call.slice(0, call.indexOf("});"));
    assert.match(
      args,
      /bounceWeight: (?:inputs|screen)\.bounceWeight,/,
      "one of the three hit-shade build paths lost Bounce",
    );
  }
});

test("exact hit shading stays fail-open until its temporal filter is proven", () => {
  assert.equal(giBvhHitShadeReplicatesTarget({}, undefined), true);
  assert.equal(giBvhHitShadeReplicatesTarget({}, true), true);
  assert.equal(
    giBvhHitShadeReplicatesTarget({}, false),
    false,
    "the settled-chain A/B may remove the sampled-target replication",
  );
  assert.equal(
    giBvhHitShadeReplicatesTarget(null, false),
    false,
    "without a raw target the shader must write its sampled target directly",
  );
});

test("smooth mirrors keep the complete sharp reflection", () => {
  assert.equal(GI_EXACT_TAIL_FULL, 0.15);
  for (const roughness of [0, 0.05, 0.1, GI_EXACT_TAIL_FULL]) {
    assert.equal(giExactTailWeight(roughness), 1, `roughness ${roughness}`);
  }
});

test("the moderately rough sharp-image tail is bounded and monotonic", () => {
  let previous = 1;
  for (let roughness = GI_EXACT_TAIL_FULL; roughness <= GI_EXACT_TAIL_ZERO; roughness += 0.005) {
    const weight = giExactTailWeight(roughness);
    assert.ok(weight >= 0 && weight <= 1, `roughness ${roughness}: ${weight}`);
    assert.ok(weight <= previous, `weight rose at roughness ${roughness}`);
    previous = weight;
  }
  assert.ok(giExactTailWeight(0.2) < 0.7);
  assert.ok(giExactTailWeight(0.22) < 0.45);
});

test("rough lobes fully use the broad fallback", () => {
  assert.equal(GI_EXACT_TAIL_ZERO, 0.28);
  for (const roughness of [GI_EXACT_TAIL_ZERO, 0.45, 0.8, 1, Infinity, undefined]) {
    assert.equal(giExactTailWeight(roughness), 0, `roughness ${roughness}`);
  }
});

test("scalar materials stop arming exact reflections at the zero-tail boundary", () => {
  assert.equal(giRoughnessBucketOf({ roughness: GI_EXACT_TAIL_ZERO - 1e-6 }), 0);
  assert.equal(giRoughnessBucketOf({ roughness: GI_EXACT_TAIL_ZERO }), 1);
  assert.equal(giRoughnessBucketOf({ roughness: 0.45 }), 1);
  assert.equal(giRoughnessBucketOf({ roughness: 0.6 }), 2);
});

test("mapped and unknown roughness stay conservative exact consumers", () => {
  const roughnessMap = { isTexture: true };
  assert.equal(giRoughnessBucketOf({ roughness: 1, roughnessMap }), 3);
  assert.equal(giRoughnessBucketOf({
    roughness: 1,
    roughnessNode: { isTextureNode: true, value: roughnessMap },
  }), 3);
});

test("the sharp prepass excludes scalar surfaces whose exact tail is zero", () => {
  assert.equal(giNeedsExactTrace({ roughness: GI_EXACT_TAIL_ZERO - 0.001 }), true);
  assert.equal(giNeedsExactTrace({ roughness: GI_EXACT_TAIL_ZERO }), false);
  assert.equal(giNeedsExactTrace({ roughness: 0.4 }), false);
  assert.equal(giNeedsExactTrace({ roughnessMap: {} }), true);
});

test("the exact prefilter only pays ring taps where they can affect the image", () => {
  for (const roughness of [0, 0.01, 0.02, GI_EXACT_TAIL_ZERO, 0.5, 1]) {
    assert.equal(giExactPrefilterTapCount(roughness), 1, `roughness ${roughness}`);
  }
  for (const roughness of [0.021, 0.1, 0.2, GI_EXACT_TAIL_ZERO - 0.001]) {
    assert.equal(giExactPrefilterTapCount(roughness), 13, `roughness ${roughness}`);
  }
});

test("a uniform reflection furnace keeps exactly the same energy", () => {
  const taps = Array.from({ length: 13 }, () => ({ valid: true, value: 2.5 }));
  assert.equal(giExactPrefilterMean(taps, 0.25), 2.5);
});

test("traced misses carry broad energy under the fixed denominator", () => {
  const taps = [
    { valid: true, value: 4 },
    ...Array.from({ length: 12 }, () => ({ valid: false, miss: true, value: 0 })),
  ];
  assert.equal(giExactPrefilterMean(taps, 1), 16 / 13);
  assert.notEqual(giExactPrefilterMean(taps, 1), 4, "must not renormalise over the lone hit");
});

test("an all-miss footprint returns the broad reflection without a dark rim", () => {
  const taps = Array.from({ length: 13 }, () => ({ valid: false, miss: true, value: 0 }));
  assert.equal(giExactPrefilterMean(taps, 0.375), 0.375);
});

test("mask holes hold the centre instead of blurring a reflector", () => {
  const taps = [
    { valid: true, value: 2 },
    ...Array.from({ length: 12 }, () => ({ valid: false, miss: false, value: 0 })),
  ];
  assert.equal(giExactPrefilterMean(taps, 0.25), 2);
});
