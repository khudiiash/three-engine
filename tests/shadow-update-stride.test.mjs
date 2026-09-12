import assert from "node:assert/strict";
import test from "node:test";
import { MOBILE_SHADOW_UPDATE_STRIDE, shadowUpdateDue, shadowUpdateStride } from "../src/engine/shadowUpdateStride.js";

const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 };
const laptop = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", userAgentData: { mobile: false }, maxTouchPoints: 0 };

test("a portable device re-renders shadow maps every second frame; a desktop every frame; a pin wins", () => {
  assert.equal(MOBILE_SHADOW_UPDATE_STRIDE, 2);
  assert.equal(shadowUpdateStride(iphone, {}), 2);
  assert.equal(shadowUpdateStride(laptop, {}), 1);
  assert.equal(shadowUpdateStride(laptop, { __engineShadowUpdateStride: 3 }), 3);
  assert.equal(shadowUpdateStride(iphone, { __engineShadowUpdateStride: 1 }), 1);
  assert.equal(shadowUpdateStride(null, {}), 1);
});

test("the due test is a plain modulo with stride 1 always due", () => {
  assert.equal(shadowUpdateDue(0, 2), true);
  assert.equal(shadowUpdateDue(1, 2), false);
  assert.equal(shadowUpdateDue(2, 2), true);
  assert.equal(shadowUpdateDue(7, 1), true);
  assert.equal(shadowUpdateDue(9, 3), true);
  assert.equal(shadowUpdateDue(10, 3), false);
});
