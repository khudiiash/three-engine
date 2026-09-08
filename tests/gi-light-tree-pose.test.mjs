/**
 * A LAMP HAS NOT MOVED JUST BECAUSE FLOAT32 CANNOT HOLD ITS ADDRESS.
 *
 * `#refreshLightTree` caches each emissive mesh's world matrix in a
 * `Float32Array` and rebuilds the light tree when one differs. A mesh that
 * reads as MOVED also sets `lampsChanged`, and that calls
 * `srcProbes.invalidateVisCache()` — GI's world visibility cache, thrown away
 * whole.
 *
 * ⛔ THE BUG THIS PINS (2026-09-07, user-reported as "GI takes more than a
 * minute to init" and "no GI still"). The comparison was an ABSOLUTE
 * `> 1e-5`. Float32 carries about seven significant digits, so at a few
 * hundred metres from the origin the representable quantum is already larger
 * than that gate: a perfectly stationary lamp reported motion on every frame
 * that recomputed its world matrix. Measured on the user's Level scene, whose
 * content spans 502 m vertically: **2 554 light-tree refreshes and 2 554
 * visibility-cache invalidations**, with `camMotionEma` at 1e-72 and
 * `worldRested` true. GI was not initialising slowly. It was restarting sixty
 * times a second and could never converge.
 *
 * The tolerance is relative now. These checks are written in float32 on
 * purpose — the storage IS the mechanism, and a test using doubles would pass
 * against the broken version.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { giLightTreePoseMoved } from "../src/modules/gi/GISystem.js";

/** A column-major identity matrix translated to (x, y, z). */
function matrixAt(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** The cache row as the real code stores it: FLOAT32, which is the whole point. */
function rowFor(elements) {
  const row = new Float32Array(20);
  row.set(elements.slice(0, 16));
  return row;
}

test("the first comparison of an unchanged pose reports no motion", () => {
  const m = matrixAt(3, 1, -4);
  assert.equal(giLightTreePoseMoved(rowFor(m), m), false);
});

test("⛔ a STATIONARY lamp far from the origin does not move", () => {
  // THE REGRESSION, with the arithmetic that causes it.
  //
  // The cache row is a Float32Array and `Matrix4.elements` holds doubles, so
  // every frame stores a rounded copy and then compares it against the
  // unrounded original. That error is CONSTANT for a lamp that never moves —
  // so once it exceeds the gate it exceeds it forever, on every frame.
  //
  // Above ~256 m the float32 quantum is already wider than the old absolute
  // 1e-5 gate. Measured over 200 000 random coordinates in 256-768 m,
  // **50.8 % of them trip it**, with a worst round-trip error of 3.05e-5.
  // 300.000011 is one such coordinate: it rounds to exactly 300, an error of
  // 1.1e-5, and the user's Level scene spans 502 m.
  const truth = matrixAt(0, 300.000011, 0);
  const row = rowFor(truth);

  assert.ok(
    Math.abs(row[13] - truth[13]) > 1e-5,
    "the control: this coordinate's float32 round trip really does exceed the OLD absolute gate — "
      + `stored ${row[13]} vs ${truth[13]}`,
  );
  assert.equal(
    giLightTreePoseMoved(row, truth), false,
    "a lamp that has not moved must not invalidate GI's visibility cache",
  );

  // And it must stay quiet frame after frame. A constant rounding error is
  // what turns this from a glitch into a permanent 60 Hz rebuild: GI threw its
  // world visibility cache away every frame and could never converge.
  for (let frame = 0; frame < 10; frame++) {
    assert.equal(giLightTreePoseMoved(row, truth), false, `frame ${frame} reported phantom motion`);
  }
});

test("a lamp that really moves is still detected, near and far", () => {
  // The fix must not buy quiet by going blind. A centimetre is far below any
  // scale a lamp is authored at, and it has to register at both distances.
  const near = matrixAt(2, 1, 0);
  const rowNear = rowFor(near);
  assert.equal(giLightTreePoseMoved(rowNear, matrixAt(2.01, 1, 0)), true, "1 cm at 2 m");

  const far = matrixAt(0, 502.5, 0);
  const rowFar = rowFor(far);
  assert.equal(giLightTreePoseMoved(rowFar, matrixAt(0, 502.51, 0)), true, "1 cm at 502 m");
});

test("rotation and scale keep an absolute-sized tolerance", () => {
  // Those elements live around 1, so scaling by magnitude leaves them where
  // they were. A lamp turning on the spot still refreshes the tree.
  const m = matrixAt(0, 0, 0);
  const row = rowFor(m);
  const turned = m.slice();
  turned[0] = 0.999;
  turned[5] = 0.999;
  assert.equal(giLightTreePoseMoved(row, turned), true);
});

test("the row is updated in place, so the next frame compares against the last", () => {
  // Without this the cache never advances and every frame diffs against the
  // original pose — quiet while still, then permanently "moved" after one step.
  const row = rowFor(matrixAt(0, 0, 0));
  assert.equal(giLightTreePoseMoved(row, matrixAt(5, 0, 0)), true);
  assert.equal(giLightTreePoseMoved(row, matrixAt(5, 0, 0)), false, "the move was absorbed");
  assert.equal(row[12], 5);
});

test("the tolerance is a parameter, so a scene can be bisected against it", () => {
  const row = rowFor(matrixAt(0, 100, 0));
  // A deliberately huge tolerance swallows a real move — that is what makes it
  // usable as an A/B arm rather than a constant nobody can question.
  assert.equal(giLightTreePoseMoved(rowFor(matrixAt(0, 100, 0)), matrixAt(0, 100.5, 0), 1), false);
  assert.equal(giLightTreePoseMoved(row, matrixAt(0, 100.5, 0), 1e-5), true);
});
