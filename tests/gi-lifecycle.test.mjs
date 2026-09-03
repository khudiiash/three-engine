import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GI_RESIZE_SETTLE_MS,
  canStartGiRebuild,
  giBroadReflectionReadinessNodes,
  giPropInvalidation,
  ownsGiCompileWave,
  settleGiResize,
} from "../src/modules/gi/giLifecycle.js";

test("broad reflections do not wait for the optional exact-BVH tail", () => {
  const broad = [{ id: "glossy" }];
  const screen = {
    reflectionComputes: broad,
    bvhReflect: { compute: { id: "trace" } },
    bvhHitShade: { compute: { id: "shade" } },
    bvhHitTemporal: { filter: { compute: { id: "filter" } } },
  };
  assert.equal(giBroadReflectionReadinessNodes(screen), broad);
  assert.deepEqual(giBroadReflectionReadinessNodes({}), []);
});

test("GI resize commits only after one stable 250 ms window", () => {
  const state = {};
  const first = { state, width: 800, height: 450, shadowW: 400, shadowH: 225 };
  let step = settleGiResize(null, first, 1000);
  assert.equal(step.ready, false);

  step = settleGiResize(step.pending, first, 1000 + GI_RESIZE_SETTLE_MS - 1);
  assert.equal(step.ready, false);

  const final = { ...first, width: 900, shadowW: 450 };
  step = settleGiResize(step.pending, final, 1200);
  assert.equal(step.ready, false, "a new drag size restarts the settle clock");
  assert.equal(step.pending.since, 1200);

  step = settleGiResize(step.pending, final, 1200 + GI_RESIZE_SETTLE_MS);
  assert.equal(step.ready, true);
  assert.equal(step.pending, null);
});

test("a replacement GI state cannot inherit an old pending resize", () => {
  const candidate = { state: {}, width: 800, height: 450, shadowW: 400, shadowH: 225 };
  const first = settleGiResize(null, candidate, 0);
  const replacement = { ...candidate, state: {} };
  const next = settleGiResize(first.pending, replacement, 1000);
  assert.equal(next.ready, false);
  assert.equal(next.pending.since, 1000);
});

test("background compile waves serialize rebuilds and own cleanup by token", () => {
  assert.equal(canStartGiRebuild(false, false), true);
  assert.equal(canStartGiRebuild(true, false), false, "background wave keeps rendering live");
  assert.equal(canStartGiRebuild(false, true), false);

  const current = {};
  assert.equal(ownsGiCompileWave(current, current), true);
  assert.equal(ownsGiCompileWave(current, {}), false);
});

test("AO quality is screen-local while Bounce and Reflections remain world quality", () => {
  assert.equal(giPropInvalidation("bounce"), "world");
  assert.equal(giPropInvalidation("ao"), "screen");
  assert.equal(giPropInvalidation("reflections"), "world");
  assert.equal(giPropInvalidation("debugView"), "live");
  assert.equal(giPropInvalidation("quality"), "world");
});

test("GISystem routes every rebuild and resize through the lifecycle guards", async () => {
  const source = await readFile(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(!canStartGiRebuild\(this\._compileWaveActive, this\.engine\.renderSuspended\)\) return;/,
  );
  assert.match(source, /if \(ownsGiCompileWave\(this\._compileToken, token\)\) \{/);
  assert.match(source, /const settled = settleGiResize\(/);
  assert.match(
    source,
    /screen\.giCostScale === giCostScale[\s\S]*?this\._pendingResolveResize = null;[\s\S]*?return;/,
    "ordinary viewport resizes must retain the live GI target bundle",
  );
  assert.match(source, /new SlotRegistry\(MAX_INSTANCE_SLOTS\)/);
  assert.match(source, /slotCapacity: MAX_INSTANCE_SLOTS/);
  assert.match(source, /if \(invalidation === "screen"\) \{[\s\S]*?this\.#refreshAoQuality\(\)/);
  assert.match(source, /AO quality changed to .*screen term rearmed in place/);
  assert.doesNotMatch(source, /while \(giPendingComputePipelines\.size\)/);
  assert.doesNotMatch(source, /await Promise\.all\(\[\.\.\.giPendingComputePipelines\]\)/);
  assert.match(source, /visible GI already committed/);
  assert.equal(
    [...source.matchAll(/this\.#rebuild\(\);/g)].length,
    1,
    "only the serialized tick may invoke the full rebuild",
  );
});
