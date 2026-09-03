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
