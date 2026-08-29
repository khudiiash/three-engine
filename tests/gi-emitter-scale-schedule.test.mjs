import assert from "node:assert/strict";
import test from "node:test";

import { SceneContentKey } from "../src/engine/contentKey.js";
import {
  EMITTER_POSE_STRIDE,
  refreshEmitterPoseSignature,
} from "../src/modules/gi/emitterRefresh.js";
import {
  giFingerprintContentAxes,
  giFingerprintContentFresh,
} from "../src/modules/gi/fingerprintSchedule.js";

test("emitter scaling stays on the live transform path, outside the structural fingerprint", () => {
  const content = new SceneContentKey();
  const scanned = giFingerprintContentAxes(content);
  content.bump("transforms", "test:emitter-scale");
  assert.equal(giFingerprintContentFresh(scanned, content, false), true);

  const row = new Float32Array(EMITTER_POSE_STRIDE);
  row[19] = NaN;
  const matrix = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  assert.equal(refreshEmitterPoseSignature(row, matrix, [4, 3, 2], 1), true);
  assert.equal(refreshEmitterPoseSignature(row, matrix, [4, 3, 2], 1), false);

  const scaled = [...matrix];
  scaled[0] = 1.5;
  scaled[5] = 0.75;
  assert.equal(refreshEmitterPoseSignature(row, scaled, [4, 3, 2], 1), true);
  assert.equal(refreshEmitterPoseSignature(row, scaled, [4, 3, 2], 1), false);
});

test("live emitter signature also wakes on radiance and instance changes", () => {
  const row = new Float32Array(EMITTER_POSE_STRIDE);
  row[19] = NaN;
  const matrix = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  refreshEmitterPoseSignature(row, matrix, [1, 1, 1], 1);
  assert.equal(refreshEmitterPoseSignature(row, matrix, [2, 1, 1], 1), true);
  assert.equal(refreshEmitterPoseSignature(row, matrix, [2, 1, 1], 2), true);
});
