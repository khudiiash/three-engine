import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Execute the actual private methods in a minimal host. No GPU graph builds,
// copied scheduler, brace-depth guessing, or source-text assertion as the gate.
const source = readFileSync(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
function methodBetween(start, next) {
  const from = source.indexOf(`  ${start}(`);
  const to = source.indexOf(`  ${next}(`, from + 1);
  assert.ok(from >= 0 && to > from, `find production ${start}`);
  return source.slice(from, to).trim();
}
const scheduler = methodBetween("#maybeLogSrcProbeStats", "#maybeLogStats");
const scanReset = methodBetween("#queueRebakeCheck", "#checkFingerprint");
const emptyStats = () => ({ cascades: [] });

function fixture({ code = scheduler, every, read = () => Promise.resolve(emptyStats()) } = {}) {
  const warnings = [], logs = [], calls = [];
  const hatches = { __giSrcProbeStatsEvery: every };
  const Host = new Function("globalThis", "formatSrcProbeFrame", "console", `
    return class {
      ${code}
      ${scanReset}
      sample(renderer) { this.#maybeLogSrcProbeStats(renderer, this.state); }
      changed() { this.#queueRebakeCheck(); }
    };
  `)(hatches, stats => JSON.stringify(stats), {
    warn: (...args) => warnings.push(args), log: (...args) => logs.push(args),
  });
  const host = new Host();
  let index = 0;
  const renderer = {};
  const makeSrc = (fn = read) => ({ readStats(receivedRenderer) {
    assert.equal(receivedRenderer, renderer);
    calls.push(index);
    return fn();
  } });
  host.state = { screen: { srcProbes: makeSrc() } };
  const tick = async (reset = false) => {
    if (reset) { host.changed(); host._frame++; } // the real reset repeatedly produces 0
    else host._frame = index;
    host.sample(renderer);
    index++;
    await Promise.resolve();
  };
  const advance = async (count, reset = false) => {
    for (let i = 0; i < count; i++) await tick(reset);
  };
  return { host, calls, warnings, logs, hatches, renderer, makeSrc, tick, advance };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("600 ticks read ten times with normal frames or component resets to zero", async () => {
  const normal = fixture(), moving = fixture();
  await normal.advance(600);
  await moving.advance(600, true);
  assert.deepEqual(normal.calls, [0, 60, 120, 180, 240, 300, 360, 420, 480, 540]);
  assert.deepEqual(moving.calls, normal.calls);
  assert.equal(moving.host._srcStatsTick, 600);
  assert.equal(moving.host._frame, 0, "the fingerprint counter really reset every tick");
});

test("negative control: the original scan clock makes the same moving fixture read 600 times", async () => {
  const oldCode = scheduler.replace("if (tick % every !== 0)", "if (this._frame % every !== 0)");
  assert.notEqual(oldCode, scheduler, "control replaces the scheduling clock only");
  const f = fixture({ code: oldCode });
  await f.advance(600, true);
  assert.equal(f.calls.length, 600);
});

test("a pending read cannot overlap and does not stop the independent clock", async () => {
  const pending = deferred();
  const f = fixture({ read: () => pending.promise });
  await f.advance(125, true);
  assert.deepEqual(f.calls, [0]);
  assert.equal(f.host._srcStatsTick, 125);
  pending.resolve(emptyStats());
  await Promise.resolve();
  await f.advance(55, true);
  assert.deepEqual(f.calls, [0], "missed intervals do not burst immediately after a read");
  await f.tick(true);
  assert.deepEqual(f.calls, [0, 180]);
  assert.equal(f.host._srcStatsPending, false);
});

test("state replacement retires pending statistics and the replacement reads on the same cadence", async () => {
  const pending = deferred();
  const f = fixture({ read: () => pending.promise });
  await f.tick();
  const next = { cascades: [], marker: "new state" };
  f.host.state = { screen: { srcProbes: f.makeSrc(() => Promise.resolve(next)) } };
  pending.resolve({ cascades: [], marker: "retired" });
  await Promise.resolve();
  assert.equal(f.host._srcProbeStats, undefined);
  assert.equal(f.host._srcStatsPending, false);
  await f.advance(60, true);
  assert.deepEqual(f.calls, [0, 60]);
  assert.equal(f.host._srcProbeStats, next);
});

test("probe-store replacement within the same state also retires old statistics", async () => {
  const pending = deferred();
  const f = fixture({ read: () => pending.promise });
  await f.tick();
  f.host.state.screen.srcProbes = f.makeSrc();
  pending.resolve({ cascades: [], marker: "retired store" });
  await Promise.resolve();
  assert.equal(f.host._srcProbeStats, undefined);
  assert.equal(f.host._srcStatsPending, false);
});

for (const synchronous of [false, true]) {
  test(`${synchronous ? "synchronous" : "async"} read failure releases the guard and retries at the next interval`, async () => {
    const error = new Error("readback failed");
    const f = fixture({ read: () => {
      if (synchronous) throw error;
      return Promise.reject(error);
    } });
    await f.tick(true);
    assert.equal(f.host._srcStatsPending, false);
    assert.equal(f.warnings.length, 1);
    assert.equal(f.warnings[0][1], error.message);
    f.host.state.screen.srcProbes = f.makeSrc(() => Promise.resolve(emptyStats()));
    await f.advance(60, true);
    assert.deepEqual(f.calls, [0, 60]);
    assert.equal(f.host._srcStatsPending, false);
    assert.deepEqual(f.host._srcProbeStats, emptyStats());
  });
}

test("the diagnostic interval override stays live without depending on scan resets", async () => {
  const f = fixture({ every: 10 });
  await f.advance(30, true);
  assert.deepEqual(f.calls, [0, 10, 20]);
  f.hatches.__giSrcProbeStatsEvery = 20;
  await f.advance(31, true);
  assert.deepEqual(f.calls, [0, 10, 20, 40, 60]);
});

test("a missing SRC store performs no read and keeps scheduling time monotonic", async () => {
  const f = fixture();
  f.host.state.screen.srcProbes = null;
  await f.advance(75, true);
  assert.equal(f.calls.length, 0);
  f.host.state.screen.srcProbes = f.makeSrc();
  await f.advance(46, true);
  assert.deepEqual(f.calls, [120]);
});
