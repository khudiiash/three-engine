import assert from "node:assert/strict";
import test from "node:test";
import { resolveGiConfig } from "../src/modules/gi/giConfig.js";

test("ultra keeps twice high's screen sample budget instead of tracing every display pixel", () => {
  const high = resolveGiConfig({ bounce: 0.75, ao: 0.75, reflections: 0.75 }, { __giDeviceTier: null });
  const ultra = resolveGiConfig({ bounce: 1, ao: 1, reflections: 1 }, { __giDeviceTier: null });
  const ratio = (ultra.resolveScale ** 2) / (high.resolveScale ** 2);

  assert.ok(Math.abs(ultra.resolveScale - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(ratio - 2) < 1e-12);
  assert.equal(ultra.exactReflections, true);
});

// ── 2026-09-11: the pixel ceiling is a tier property, and the build preset caps the tier ──
test("the resolve pixel ceiling rises with the screen tier and ultra keeps its 1.6 M contract", () => {
  const at = (v) => resolveGiConfig({ bounce: v, ao: v, reflections: v }, { __giDeviceTier: null });
  const low = at(0.25), medium = at(0.5), high = at(0.75), ultra = at(1);
  assert.ok(low.resolveMaxPixels < medium.resolveMaxPixels);
  assert.ok(medium.resolveMaxPixels < high.resolveMaxPixels);
  assert.ok(high.resolveMaxPixels < ultra.resolveMaxPixels);
  assert.equal(ultra.resolveMaxPixels, 1_600_000);
  // A 1570×962 editor viewport never reaches any of them.
  assert.ok(low.resolveMaxPixels >= 1570 * 962 * 0.5 * 0.5);
  assert.ok(ultra.resolveMaxPixels >= 1570 * 962 * 0.5);
  // The ceiling follows the SCREEN tier — the highest of the three rails.
  const mixed = resolveGiConfig({ bounce: 0.25, ao: 1, reflections: 0.25 }, { __giDeviceTier: null });
  assert.equal(mixed.resolveMaxPixels, ultra.resolveMaxPixels);
});

test("the build's quality preset is a ceiling on the GI tiers; ultra and the editor pass nothing", () => {
  const props = { bounce: 1, ao: 1, reflections: 0.25 };
  const asAuthored = resolveGiConfig(props, { __giDeviceTier: null });
  const highBuild = resolveGiConfig(props, { __giDeviceTier: null }, { qualityCeiling: "high" });
  const ultraBuild = resolveGiConfig(props, { __giDeviceTier: null }, { qualityCeiling: "ultra" });
  const unknown = resolveGiConfig(props, { __giDeviceTier: null }, { qualityCeiling: "banana" });
  assert.equal(asAuthored.bounceQuality, "ultra");
  assert.equal(highBuild.bounceQuality, "high");
  assert.equal(highBuild.aoQuality, "high");
  assert.equal(highBuild.reflectionsQuality, "low");
  assert.equal(highBuild.resolveScale, 0.5);
  assert.equal(highBuild.resolveMaxPixels, 900_000);
  assert.equal(highBuild.qualityClampedFrom, "ultra");
  assert.deepEqual({ ...ultraBuild }, { ...asAuthored });
  assert.deepEqual({ ...unknown }, { ...asAuthored });
  // A preset never raises: a low-authored scene stays low under a high build.
  const lowScene = resolveGiConfig({ bounce: 0.25, ao: 0.25, reflections: 0.25 }, { __giDeviceTier: null }, { qualityCeiling: "high" });
  assert.equal(lowScene.bounceQuality, "low");
  assert.equal(lowScene.qualityClampedFrom, undefined);
});

test("a portable device gets the mobile pixel ceiling under the tier's", () => {
  const phone = resolveGiConfig({ bounce: 1, ao: 1, reflections: 1 }, { __giDeviceTier: "low" });
  assert.equal(phone.bounceQuality, "low");
  assert.equal(phone.resolveMaxPixels, 250_000);
  // The device ceiling and the build ceiling compose to the lower one.
  const phoneHighBuild = resolveGiConfig({ bounce: 1, ao: 1, reflections: 1 }, { __giDeviceTier: "medium" }, { qualityCeiling: "high" });
  assert.equal(phoneHighBuild.bounceQuality, "medium");
  const laptopLowBuild = resolveGiConfig({ bounce: 1, ao: 1, reflections: 1 }, { __giDeviceTier: "high" }, { qualityCeiling: "low" });
  assert.equal(laptopLowBuild.bounceQuality, "low");
});

test("a runtime pin on a rail reads exactly like the authored value", () => {
  const authored = resolveGiConfig({ bounce: 0.75, ao: 0.75, reflections: 0.25 }, { __giDeviceTier: null });
  const pinned = resolveGiConfig({ bounce: 0.75, ao: 0.75, reflections: 0.25 }, { __giDeviceTier: null, __giReflectionsLevel: 0 });
  assert.equal(authored.reflections, true);
  assert.equal(pinned.reflections, false);
  assert.equal(pinned.bounce, true);
  const unpinned = resolveGiConfig({ bounce: 0.75, ao: 0.75, reflections: 0.25 }, { __giDeviceTier: null, __giReflectionsLevel: null });
  assert.equal(unpinned.reflections, true);
});

test("a portable device bounds the world chain: 15 Hz ceiling and the two-frame split; a desktop leaves both to the hatches", () => {
  const phone = resolveGiConfig({ bounce: 0.75, ao: 0.75, reflections: 0.75 }, { __giDeviceTier: "low" });
  const desktop = resolveGiConfig({ bounce: 0.75, ao: 0.75, reflections: 0.75 }, { __giDeviceTier: null });
  assert.equal(phone.worldUpdateHz, 15);
  assert.equal(phone.worldSplit, true);
  assert.equal(phone.worldRayScale, 0.35);
  assert.equal(desktop.worldRayScale, 1);
  assert.equal(phone.resolveMaxPixels, 250_000);
  assert.equal(desktop.worldUpdateHz, null);
  assert.equal(desktop.worldSplit, false);
});
