/**
 * THE FREEZE LEDGER'S OWN GATE.
 *
 * Every unit of docs/ZERO_FREEZE_PLAN.md is scored on `profile.freezes`, so an
 * instrument fault here does not read as a fault — it reads as a fix. This
 * project has lost whole sessions to exactly that (a boot probe that
 * timestamped console lines at NODE receipt time turned a 7 s boot into a
 * reported 21.7 s; a "field ready" marker that resolved a debug readback made
 * every startup number a second pessimistic). So the ledger is pinned:
 *
 *   · self time excludes children, or one block reads as 300 % of itself and
 *     the deepest — most specific — owner is buried under its callers;
 *   · a span that overlaps a window only partly is charged only for the part
 *     inside it;
 *   · time nobody marked is reported as `(unattributed)` rather than
 *     redistributed onto whoever happens to be on the stack;
 *   · a `begin` whose `end` is skipped (an early return, a throw) must not
 *     corrupt the stack for everything after it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { freeze, installGpuCallLedger } from "../src/engine/freezeLedger.js";

/** Burn wall-clock: the ledger measures `performance.now()`, not calls. */
function busy(ms) {
  const end = performance.now() + ms;
  // eslint-disable-next-line no-empty
  while (performance.now() < end) {}
}

function reset() {
  freeze.clear();
  freeze._filled = 0;
  freeze._head = 0;
  freeze._stackName.length = 0;
  freeze._stackStart.length = 0;
  freeze._stackChild.length = 0;
  freeze.buildCauseLog = [];
  freeze.logging = false;
}

test("self time excludes children, so the deepest owner wins", () => {
  reset();
  const from = performance.now();
  const outer = freeze.begin("outer");
  busy(10);
  const inner = freeze.begin("inner");
  busy(30);
  freeze.end(inner);
  busy(10);
  freeze.end(outer);
  const to = performance.now();

  const owners = freeze.attribute(from, to);
  const byName = Object.fromEntries(owners.map((o) => [o.name, o.ms]));
  assert.ok(byName.inner > byName.outer, `inner (${byName.inner}) should outrank outer (${byName.outer})`);
  // outer is ~20 ms of self time, not the ~50 ms it wall-clocked.
  assert.ok(byName.outer < 35, `outer self time ${byName.outer} must exclude its child`);
  const total = owners.reduce((sum, o) => sum + o.ms, 0);
  assert.ok(total <= (to - from) * 1.15, `attribution ${total} must not exceed the window ${to - from}`);
});

test("a window that covers only part of a span is charged only that part", () => {
  reset();
  const start = performance.now();
  const token = freeze.begin("half");
  busy(40);
  freeze.end(token);
  const end = performance.now();

  const whole = freeze.attribute(start, end).find((o) => o.name === "half");
  const half = freeze.attribute(start, start + (end - start) / 2).find((o) => o.name === "half");
  assert.ok(whole && half, "the span must appear in both windows");
  assert.ok(half.ms < whole.ms * 0.75, `half window charged ${half.ms} of ${whole.ms}`);
});

test("unmarked time is reported as unattributed, not given to a neighbour", () => {
  reset();
  const from = performance.now();
  const token = freeze.begin("small");
  busy(5);
  freeze.end(token);
  busy(45);
  const to = performance.now();

  const owners = freeze.attribute(from, to);
  const unattributed = owners.find((o) => o.name === "(unattributed)");
  assert.ok(unattributed, "a window that is mostly unmarked must say so");
  assert.ok(unattributed.ms > 25, `unattributed ${unattributed.ms} should carry most of the window`);
});

test("a skipped end does not corrupt the stack", () => {
  reset();
  const outer = freeze.begin("outer");
  freeze.begin("leaked-a");
  freeze.begin("leaked-b");
  // The caller only ends the outermost token — which is what a `finally`
  // around an early return does when the inner spans belong to code that
  // threw.
  freeze.end(outer);
  assert.equal(freeze._stackName.length, 0, "every span opened inside must be closed with its parent");

  const from = performance.now();
  const token = freeze.begin("after");
  busy(20);
  freeze.end(token);
  const owners = freeze.attribute(from, performance.now());
  assert.equal(owners[0].name, "after", "the ledger keeps working after a leak");
});

test("a long task is attributed and counted", () => {
  reset();
  const start = performance.now();
  const token = freeze.begin("blocker");
  busy(60);
  freeze.end(token);
  const task = freeze.recordTask(start, performance.now() - start);

  assert.equal(task.owners[0].name, "blocker");
  assert.ok(task.ms >= 55, `task ms ${task.ms}`);
  assert.equal(freeze.totals.tasks, 1);
  assert.ok(freeze.totals.worstMs >= 55);

  const report = freeze.read();
  assert.equal(report.byOwner[0].name, "blocker");
  assert.equal(report.worst[0].ms, task.ms);
});

test("spans below the floor never reach the ring", () => {
  reset();
  const before = freeze._filled;
  for (let i = 0; i < 50; i++) freeze.end(freeze.begin("noise"));
  assert.equal(freeze._filled, before, "sub-millisecond spans must not fill the ring");
});

test("the boot table records stages in order and closes the open one", () => {
  reset();
  freeze.boot = { stages: [], t0: performance.now(), openName: null, openAt: performance.now() };
  freeze.bootStage("first");
  busy(12);
  freeze.bootStage("second", "detail");
  busy(8);
  freeze.bootStage(null);

  const boot = freeze.readBoot();
  const names = boot.stages.map((s) => s.name);
  assert.deepEqual(names, ["first", "second"]);
  assert.ok(boot.stages[0].ms >= 10, `first stage ${boot.stages[0].ms} ms`);
  assert.equal(boot.stages[1].detail, "detail");
  assert.ok(boot.stages[1].at >= boot.stages[0].at, "stages carry their offset from load");
});

test("bootMark records a nested stage without closing the open one", () => {
  reset();
  freeze.boot = { stages: [], t0: performance.now(), openName: null, openAt: performance.now() };
  freeze.bootStage("outer");
  freeze.bootMark("inner", 7, "3 things");
  freeze.bootStage(null);

  const names = freeze.readBoot().stages.map((s) => s.name);
  assert.deepEqual(names, ["inner", "outer"], "the nested mark lands first and the outer stage still closes whole");
});

test("clear() empties every section a report shows, not just the blocks", () => {
  reset();
  freeze.nodeBuilds = new Map([["Water", { name: "Water", count: 3, ms: 200, worstMs: 90 }]]);
  freeze.nodeBuildCauses = new Map([["fog", { name: "fog", count: 31, ms: 700, materials: new Set(["Water"]) }]]);
  freeze.syncPipelines = new Map([["renderPipelines:x", { kind: "renderPipelines", name: "x", count: 2, ms: 9, bytes: 0 }]]);
  const start = performance.now();
  freeze.end(freeze.begin("blocker"));
  freeze.recordTask(start, 60);
  assert.ok(freeze.read().nodeBuilds.length > 0, "the counters are in the report");

  freeze.clear();
  const after = freeze.read();
  assert.equal(after.totals.tasks, 0);
  assert.equal(after.nodeBuilds.length, 0, "a cleared ledger must not carry the old session's builds into an A/B");
  assert.equal(after.nodeBuildCauses.length, 0);
  assert.equal(after.syncPipelines.length, 0);
});

test("a build's cause names which scene-wide input moved, and counts the materials it cost", () => {
  // The distinction the whole section exists for. Every material has to be
  // built ONCE — that is `first compile` and no amount of work removes it.
  // A build attributed to `fog` or `lights` is different in kind: a scene-wide
  // input to three's dynamic cache key moved, and it re-minted materials that
  // were already compiled and that nobody touched. Reporting them under one
  // heading is how three sessions of this project misread a wave as a cost.
  reset();
  freeze.nodeBuildCauses = new Map([
    ["first compile", { name: "first compile", count: 1, ms: 40, materials: new Set(["MeshPhysicalNodeMaterial"]) }],
    ["fog", { name: "fog", count: 31, ms: 700, materials: new Set(["MeshPhysicalNodeMaterial", "Water"]) }],
    ["lights+context", { name: "lights+context", count: 4, ms: 90, materials: new Set(["Water"]) }],
  ]);

  const causes = freeze.read().nodeBuildCauses;
  assert.equal(causes[0].name, "fog", "the most expensive cause leads");
  assert.equal(causes[0].count, 31);
  assert.equal(causes[0].materials, "MeshPhysicalNodeMaterial, Water", "the Set is reported as NAMES, not leaked as an object");
  assert.deepEqual(causes.map((c) => c.name), ["fog", "lights+context", "first compile"]);
});

test("disabled, the ledger costs nothing and records nothing", () => {
  reset();
  freeze.enabled = false;
  try {
    const token = freeze.begin("ignored");
    assert.equal(token, 0, "a disabled begin hands back a falsy token");
    busy(5);
    freeze.end(token);
    assert.equal(freeze._stackName.length, 0);
    assert.equal(freeze._filled, 0);
  } finally {
    freeze.enabled = true;
  }
});

test("a block names the causes of the builds INSIDE it, not the session's", () => {
  // The two readings genuinely disagree, and only one of them explains a
  // freeze. On the user's scene the session total put `material key: side`
  // on top — 40 builds spread across a whole boot — while the block the user
  // actually felt was a single 724 ms task. A report that offers only the
  // session total invites reading the largest row as the cause of the worst
  // block, which is a different claim entirely.
  reset();
  const start = performance.now();
  freeze.noteBuildCause(start - 5000, "lights", 300);      // long before the block
  freeze.noteBuildCause(start + 10, "fog", 200);
  freeze.noteBuildCause(start + 20, "fog", 150);
  freeze.noteBuildCause(start + 30, "first compile", 40);
  freeze.noteBuildCause(start + 9999, "environment", 500); // long after it

  const task = freeze.recordTask(start, 60);
  assert.deepEqual(
    task.causes.map((c) => c.name), ["fog", "first compile"],
    "only the builds inside the window, largest first",
  );
  assert.equal(task.causes[0].count, 2);
  assert.equal(task.causes[0].ms, 350);
});

test("a block with no node build in it carries no causes at all", () => {
  // An empty array would read as "nothing rebuilt, and we checked" on every
  // block in a session where the ledger simply is not wrapped.
  reset();
  const start = performance.now();
  assert.equal(freeze.recordTask(start, 60).causes, null);
});

test("the ASYNC pipeline calls are charged for their synchronous half only", async () => {
  // The trap this exists for: `createRenderPipelineAsync` returns a promise,
  // which reads as "this does not block". The promise covers the DRIVER's
  // compile; the WGSL parsing, reflection and layout validation before it run
  // on the calling thread inside the call. Leaving those unwrapped is why
  // `(unattributed)` was the largest owner of every boot measured.
  //
  // The opposite error is just as easy and this project has made it: charging
  // the block for the driver's own threads. So the span must END when the call
  // returns, not when its promise settles.
  reset();
  const device = {
    createRenderPipelineAsync(descriptor) {
      busy(25);                                    // the synchronous half
      return new Promise((resolve) => setTimeout(() => resolve({ descriptor }), 120));
    },
  };
  assert.equal(installGpuCallLedger(device), true);
  assert.equal(installGpuCallLedger(device), false, "installing twice must not double-wrap");

  const from = performance.now();
  const promise = device.createRenderPipelineAsync({ label: "renderPipeline_Water_99" });
  const returnedAt = performance.now();
  const resolved = await promise;
  const to = performance.now();

  assert.ok(resolved.descriptor, "the caller still gets the real promise, untouched");
  assert.ok(to - returnedAt > 90, "the control: the promise really did settle long after the call returned");

  const owners = freeze.attribute(from, to);
  const span = owners.find((o) => o.name === "gpu:renderPipeline(async call)");
  assert.ok(span, "the synchronous half must be attributed to somebody");
  assert.ok(span.ms >= 20, `it should carry the ~25 ms of real work, got ${span.ms}`);
  assert.ok(span.ms < 90, `and NOT the driver's ${(to - returnedAt).toFixed(0)} ms, got ${span.ms}`);

  const row = freeze.read().syncPipelines.find((r) => r.name?.includes("renderPipeline_Water_99"));
  assert.ok(row, "and it is named in the offender table, so a report says WHICH pipeline");
  assert.equal(row.count, 1);
});
