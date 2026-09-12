import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_PROBE_MAX_SPAN_M, autoProbeSpanOk } from "../src/modules/gi/reflectionProbes.js";

// The scene-AABB fallback probe models the whole scene as ONE convex room.
// It must stay at room scale: the user's Sponza (about 30 x 18 m of courtyard
// ringed by arcades) passed the old 48 m bound and its curtain hems reflected
// the sunlit courtyard through the arcade walls on the phone (2026-09-12).
const box = (w, h, d) => ({ min: { x: -w / 2, y: 0, z: -d / 2 }, max: { x: w / 2, y: h, z: d / 2 } });

test("a room-sized box gets the fallback probe; a courtyard with arcades or a street does not", () => {
  assert.equal(AUTO_PROBE_MAX_SPAN_M, 20);
  assert.equal(autoProbeSpanOk(box(10, 4, 8)), true, "a 10 m room");
  assert.equal(autoProbeSpanOk(box(20, 6, 12)), true, "a 20 m hall is the bound");
  assert.equal(autoProbeSpanOk(box(30, 12, 18)), false, "Sponza");
  assert.equal(autoProbeSpanOk(box(120, 10, 30)), false, "Bistro's street");
  // Height never decides: a tall single room is still one room.
  assert.equal(autoProbeSpanOk(box(12, 30, 12)), true);
});

test("a missing or degenerate box never yields a probe", () => {
  assert.equal(autoProbeSpanOk(null), false);
  assert.equal(autoProbeSpanOk({}), false);
  assert.equal(autoProbeSpanOk(box(0, 0, 0)), false);
  assert.equal(autoProbeSpanOk({ min: { x: 0, y: 0, z: 0 }, max: { x: NaN, y: 1, z: 1 } }), false);
  assert.equal(autoProbeSpanOk(box(30, 12, 18), 48), true, "a caller may widen the bound explicitly");
});
