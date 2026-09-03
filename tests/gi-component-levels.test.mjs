import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GlobalIlluminationComponent } from "../src/modules/gi/GlobalIlluminationComponent.js";
import { giTermLevel, giTermTier, resolveGiConfig } from "../src/modules/gi/giConfig.js";
import { giPropInvalidation } from "../src/modules/gi/giLifecycle.js";
import { BIN_BUDGET, SRC_QUALITY, blockCapacities } from "../src/modules/gi/srcConfig.js";

test("GI exposes three five-point term rails and hides the legacy quality selector", () => {
  const visible = GlobalIlluminationComponent.schema.filter((field) => !field.advanced);
  assert.deepEqual(visible.map((field) => field.key), ["bounce", "ao", "reflections"]);
  for (const field of visible) {
    assert.equal(field.type, "level");
    assert.deepEqual(field.options, [0, 0.25, 0.5, 0.75, 1]);
    assert.deepEqual(field.optionLabels, ["Off", "Low", "Medium", "High", "Ultra"]);
    assert.equal(
      giPropInvalidation(field.key),
      field.key === "ao" ? "screen" : "world",
      `${field.key} changes only the resources owned by its sampling tier`,
    );
  }
  assert.equal(GlobalIlluminationComponent.schema.some((field) => field.key === "quality"), false);
});

test("term levels snap, migrate old booleans, and settle as independent quality tiers", () => {
  assert.equal(giTermLevel(false), 0);
  assert.equal(giTermLevel(true), 1);
  assert.equal(giTermLevel(0.62), 0.5);
  assert.equal(giTermLevel(9), 1);
  assert.equal(giTermTier(0), null);
  assert.equal(giTermTier(0.25), "low");
  assert.equal(giTermTier(0.5), "medium");
  assert.equal(giTermTier(0.75), "high");
  assert.equal(giTermTier(1), "ultra");

  const config = resolveGiConfig(
    { quality: "high", bounce: 0.25, ao: 0.5, reflections: 0.75 },
    { __giDeviceTier: null },
  );
  assert.equal(config.quality, "low");
  assert.equal(config.bounceQuality, "low");
  assert.equal(config.bounce, true);
  assert.equal(config.ao, true);
  assert.equal(config.aoLevel, 0.5);
  assert.equal(config.aoQuality, "medium");
  assert.equal(config.reflections, true);
  assert.equal(config.reflectionsLevel, 0.75);
  assert.equal(config.reflectionsQuality, "high");
  assert.equal(config.exactReflections, true);

  const off = resolveGiConfig(
    { quality: "ultra", bounce: 0, ao: false, reflections: 0 },
    { __giDeviceTier: null },
  );
  assert.equal(off.bounce, false);
  assert.equal(off.ao, false);
  assert.equal(off.aoLevel, 0);
  assert.equal(off.reflections, false);
  assert.equal(off.reflectionsLevel, 0);
  assert.equal(off.exactReflections, false);
});

test("Bounce Off gates displayed diffuse GI without attenuating nonzero quality tiers", async () => {
  const [screen, system] = await Promise.all([
    readFile(new URL("../src/modules/gi/giScreen.js", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8"),
  ]);
  assert.match(screen, /out\.mulAssign\(bounceWeight \? float\(bounceWeight\)\.clamp\(0, 1\) : 1\)/);
  assert.match(system, /bounceWeight: this\._giBounceWeightU/);
  assert.match(system, /_giBounceWeightU\.value = cfg\.bounce === false \? 0 : 1/);
});

test("AO and reflections compile their selected quality instead of acting as blend weights", async () => {
  const [system, src] = await Promise.all([
    readFile(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/gi/srcSystem.js", import.meta.url), "utf8"),
  ]);
  assert.match(system, /const tier = aoQualityTierOf\(this\.config\)/);
  assert.doesNotMatch(system, /p\.ao,\s+p\.aoQuality/);
  assert.match(system, /p\.bounce,\s+p\.reflections,\s+p\.reflectionsQuality/);
  assert.match(src, /low: 4,\s+medium: 3,\s+high: 2,\s+ultra: 1\.5/);
  assert.match(src, /GLOSSY_SCALE_BY_QUALITY\[props\?\.reflectionsQuality\]/);
});

test("Bounce tiers change diffuse work without starving Bistro's directional block pool", () => {
  assert.deepEqual(
    Object.values(SRC_QUALITY).map(({ w0 }) => w0),
    [4, 4, 4, 4],
    "w0=8 cuts fixed-bin probe capacity 4x and reintroduces permanent noBlock holes",
  );
  const ultraC0Blocks = blockCapacities(
    [32_768, 8_192, 4_096, 2_048],
    SRC_QUALITY.ultra.w0,
    BIN_BUDGET,
  )[0];
  assert.ok(ultraC0Blocks >= 14_273, `${ultraC0Blocks} c0 blocks cannot cover measured Bistro demand`);
  assert.ok(SRC_QUALITY.ultra.spacing0 < SRC_QUALITY.high.spacing0);
  assert.ok(SRC_QUALITY.ultra.transportRays > SRC_QUALITY.high.transportRays);
  assert.ok(SRC_QUALITY.ultra.probeRayCap > SRC_QUALITY.high.probeRayCap);
  assert.equal(SRC_QUALITY.low.secondary, false);
  assert.equal(SRC_QUALITY.medium.secondary, true);
});
