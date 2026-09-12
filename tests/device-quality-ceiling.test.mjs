import assert from "node:assert/strict";
import test from "node:test";
import { MOBILE_QUALITY_CEILING, MOBILE_SHADOW_MAP_MAX, QUALITY_PRESETS, applyQualityCeiling, capShadowMapSize, deviceQualityCeiling, isPortableDevice } from "../src/engine/sceneSettings.js";

const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 };
const ipad = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", maxTouchPoints: 5 };
const android = { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36", userAgentData: { mobile: true } };
const laptop = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", userAgentData: { mobile: false }, maxTouchPoints: 0 };
const mac = { userAgent: ipad.userAgent, maxTouchPoints: 0 };

test("a phone or tablet is portable; a laptop or a Mac is not", () => {
  assert.equal(isPortableDevice(iphone), true);
  assert.equal(isPortableDevice(ipad), true);
  assert.equal(isPortableDevice(android), true);
  assert.equal(isPortableDevice(laptop), false);
  assert.equal(isPortableDevice(mac), false);
  assert.equal(isPortableDevice(null), false);
});

test("a portable device is held to the build's MOBILE preset only when one is authored; a preset only ever lowers", () => {
  assert.equal(MOBILE_QUALITY_CEILING, "medium");
  // No mobile preset ("same"/null): phones ship the build's preset untouched.
  assert.equal(deviceQualityCeiling("high", iphone), "high");
  assert.equal(deviceQualityCeiling("high", iphone, null, "same"), "high");
  assert.equal(deviceQualityCeiling("high", iphone, null, "banana"), "high");
  // An authored mobile preset caps portable devices and nothing else.
  assert.equal(deviceQualityCeiling("high", iphone, null, "medium"), "medium");
  assert.equal(deviceQualityCeiling("ultra", android, null, "medium"), "medium");
  assert.equal(deviceQualityCeiling("medium", iphone, null, "medium"), "medium");
  assert.equal(deviceQualityCeiling("low", iphone, null, "medium"), "low");
  assert.equal(deviceQualityCeiling(null, iphone, null, "medium"), "medium");
  assert.equal(deviceQualityCeiling("banana", iphone, null, "medium"), "medium");
  assert.equal(deviceQualityCeiling("high", laptop, null, "medium"), "high");
  assert.equal(deviceQualityCeiling("ultra", mac, null, "low"), "ultra");
  assert.equal(deviceQualityCeiling(null, laptop, null, "medium"), null);
});

test("a URL override wins on any device, and only for a real preset", () => {
  assert.equal(deviceQualityCeiling("high", iphone, "high", "medium"), "high");
  assert.equal(deviceQualityCeiling("high", iphone, "ultra", "medium"), "ultra");
  assert.equal(deviceQualityCeiling("high", laptop, "low"), "low");
  assert.equal(deviceQualityCeiling("high", iphone, "banana", "medium"), "medium");
  assert.equal(deviceQualityCeiling("high", laptop, ""), "high");
});

test("no device caps a shadow map by default (the 1024 cap was rejected on sight); only an explicit pin does", () => {
  assert.equal(MOBILE_SHADOW_MAP_MAX, 0);
  assert.equal(capShadowMapSize(2048, iphone, {}), 2048);
  assert.equal(capShadowMapSize(512, iphone, {}), 512);
  assert.equal(capShadowMapSize(2048, android, {}), 2048);
  assert.equal(capShadowMapSize(2048, laptop, {}), 2048);
  assert.equal(capShadowMapSize(4096, mac, {}), 4096);
  // The pin: a desktop can rehearse the phone's map, and a phone can opt out.
  assert.equal(capShadowMapSize(2048, laptop, { __engineShadowMapCap: 1024 }), 1024);
  assert.equal(capShadowMapSize(2048, iphone, { __engineShadowMapCap: 0 }), 2048);
});

test("the mobile ceiling is a real preset that lowers the renderer's cost", () => {
  const preset = QUALITY_PRESETS[MOBILE_QUALITY_CEILING];
  assert.ok(preset);
  const authored = { performance: { maxDevicePixelRatio: 2, renderScale: 1, dynamicResolution: false } };
  const capped = applyQualityCeiling(authored, MOBILE_QUALITY_CEILING);
  assert.ok(capped.performance.maxDevicePixelRatio < 2);
  assert.ok(capped.performance.renderScale < 1);
  assert.equal(capped.shadows, true);
});
