/**
 * The profiler's breakdown: while a phase capture is armed with
 * `{ attribute: true }`, every per-frame callback's time is charged to the
 * component (with its entity), the module or the script that registered it,
 * and `readPhaseCapture` reports them as means per frame, costliest first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { StatsSystem } from "../src/engine/StatsSystem.js";

function makeStats() {
  const engine = { renderer: null, renderScale: 1 };
  return new StatsSystem(engine);
}

test("owners are charged by component, module and script; means are per frame", () => {
  const stats = makeStats();
  const cloth = { type: "cloth", entity: { id: "e1", name: "Flag" }, constructor: { label: "Cloth" } };
  const clothFn = () => {};
  clothFn.__owner = cloth;
  const giFn = () => {};
  giFn.__owner = { kind: "module", id: "gi" };
  const bare = () => {};

  stats.beginPhaseCapture(2, { attribute: true });
  assert.equal(stats._attribArmed, true);
  for (let frame = 0; frame < 2; frame++) {
    stats.markPhase(0);
    stats.attribute(clothFn, "update", 1.5);
    stats.attribute(giFn, "preRender", 3);
    stats.attribute(bare, "update", 0.5);
    stats.attributeScript("scripts/Player.ts", "onUpdate", 0.25);
    stats.attributeScript("scripts/Player.ts", "onLateUpdate", 0.25);
    stats.endPhaseFrame();
  }
  assert.equal(stats._attribArmed, false, "disarmed with the capture");
  const capture = stats.readPhaseCapture();
  assert.equal(capture.frames, 2);
  const byKey = Object.fromEntries(capture.owners.map((o) => [o.key, o]));
  assert.equal(capture.owners[0].key, "m:gi", "costliest first");
  assert.equal(byKey["m:gi"].ms, 3);
  assert.deepEqual(
    { kind: byKey["c:cloth:e1"].kind, label: byKey["c:cloth:e1"].label, entity: byKey["c:cloth:e1"].entity, ms: byKey["c:cloth:e1"].ms },
    { kind: "component", label: "Cloth", entity: "Flag", ms: 1.5 },
  );
  assert.equal(byKey["e:update"].ms, 0.5, "an unowned callback is the engine's");
  const script = byKey["s:scripts/Player.ts"];
  assert.equal(script.label, "Player.ts");
  assert.equal(script.ms, 0.5);
  assert.deepEqual(script.hooks, { onUpdate: 0.25, onLateUpdate: 0.25 });
});

test("a capture without attribute charges nothing and costs nothing", () => {
  const stats = makeStats();
  stats.beginPhaseCapture(1);
  assert.equal(stats._attribArmed, false);
  stats.markPhase(0);
  stats.endPhaseFrame();
  assert.deepEqual(stats.readPhaseCapture().owners, []);
});

test("re-arming clears the previous owners", () => {
  const stats = makeStats();
  const fn = () => {};
  fn.__owner = { kind: "module", id: "physics" };
  stats.beginPhaseCapture(1, { attribute: true });
  stats.attribute(fn, "update", 2);
  stats.endPhaseFrame();
  assert.equal(stats.readPhaseCapture().owners.length, 1);
  stats.beginPhaseCapture(1, { attribute: true });
  stats.endPhaseFrame();
  assert.deepEqual(stats.readPhaseCapture().owners, []);
});
