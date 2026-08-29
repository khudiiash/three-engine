import assert from "node:assert/strict";
import test from "node:test";

import { SceneContentKey } from "../src/engine/contentKey.js";
import {
  giFingerprintContentAxes,
  giFingerprintContentFresh,
} from "../src/modules/gi/fingerprintSchedule.js";
import {
  PROBE_RAY_CAP_OFF,
  rcFrameProbeRayCap,
  rcTierSpec,
} from "../src/modules/gi/window/rc/rcConfig.js";

test("transform-only bumps do not invalidate the GI structural fingerprint", () => {
  const content = new SceneContentKey();
  const scanned = giFingerprintContentAxes(content);

  content.bump("transforms", "test:drag");
  assert.equal(giFingerprintContentAxes(content), scanned);
  assert.equal(giFingerprintContentFresh(scanned, content, false), true);

  content.bump("materials", "test:recolour");
  assert.notEqual(giFingerprintContentAxes(content), scanned);
  assert.equal(giFingerprintContentFresh(scanned, content, false), false);
});

test("the periodic audit still forces a full fingerprint scan", () => {
  const content = new SceneContentKey();
  const scanned = giFingerprintContentAxes(content);
  assert.equal(giFingerprintContentFresh(scanned, content, true), false);
});

test("Cornell-dense RC work is capped at rest and lowered during camera motion", () => {
  const ultra = rcTierSpec("ultra");
  assert.equal(rcFrameProbeRayCap(ultra, false, {}), 16);
  assert.equal(rcFrameProbeRayCap(ultra, true, {}), 8);
});

test("the explicit RC cap diagnostic remains exact", () => {
  const ultra = rcTierSpec("ultra");
  assert.equal(rcFrameProbeRayCap(ultra, false, { __gi2ProbeRayCap: 24 }), 24);
  assert.equal(rcFrameProbeRayCap(ultra, true, { __gi2ProbeRayCap: 24 }), 24);
  assert.equal(rcFrameProbeRayCap(ultra, true, { __gi2ProbeRayCap: 0 }), PROBE_RAY_CAP_OFF);
});
