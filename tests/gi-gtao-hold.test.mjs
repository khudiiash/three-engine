import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { GiGtaoHold } from "../src/modules/gi/giGtaoHold.js";

const ready = { gbufferHeld: true, chainReady: true };

function fixture() {
  const raw = {}, filterX = {}, filterY = {};
  return {
    enabled: true,
    pass: {
      reusableGtao: true,
      target: { version: 0 }, rawTarget: { version: 0 },
      width: 1600, height: 900,
    },
    nodes: new Set([raw, filterX, filterY]),
    gbuffer: {
      rt: { width: 1600, height: 900 },
      position: { version: 0 }, normal: { version: 0 },
    },
    gbufferGeneration: 1,
    cameraPosition: { x: 10, y: 3, z: 5 },
    cameraRight: { x: 1, y: 0, z: 0 },
    cameraUp: { x: 0, y: 1, z: 0 },
    projectionScale: 779.4229,
    strength: 1,
    radius: 0.56,
  };
}

test("a ready pipeline cannot hold an output until its entire chain actually ran", () => {
  const cache = new GiGtaoHold();
  const inputs = fixture();
  assert.equal(cache.canReuse(inputs, ready), false, "fresh targets contain no AO");
  cache.record(inputs, false);
  assert.equal(cache.canReuse(inputs, ready), false, "pending or skipped filter cannot seed the hold");
  cache.record(inputs, true);
  assert.equal(cache.canReuse(inputs, ready), true);
});

test("a stationary view dispatches once; the first changed frame dispatches all three passes", () => {
  const cache = new GiGtaoHold();
  const inputs = fixture();
  let dispatches = 0;
  const frame = (state = ready) => {
    if (cache.canReuse(inputs, state)) return;
    dispatches += inputs.nodes.size;
    cache.record(inputs, true);
  };
  for (let i = 0; i < 120; i++) frame();
  assert.equal(dispatches, 3);
  inputs.gbufferGeneration++;
  frame({ ...ready, gbufferHeld: false });
  assert.equal(dispatches, 6, "mover or camera changes must update the same frame");
  frame();
  assert.equal(dispatches, 6);
  inputs.strength = 0.5;
  frame();
  assert.equal(dispatches, 9, "live AO controls must not wait for camera motion");
});

for (const [name, mutate] of [
  ["camera position below the gbuffer's hash precision", (i) => { i.cameraPosition.x += 1e-8; }],
  ["camera right", (i) => { i.cameraRight.z = 1e-8; }],
  ["camera up", (i) => { i.cameraUp.z = 1e-8; }],
  ["projection scale", (i) => { i.projectionScale += 1e-8; }],
  ["strength", (i) => { i.strength = 2; }],
  ["radius", (i) => { i.radius = 0.8; }],
  ["g-buffer revision", (i) => { i.gbufferGeneration++; }],
  ["same-size g-buffer replacement", (i) => { i.gbuffer = { ...i.gbuffer }; }],
  ["g-buffer target replacement", (i) => { i.gbuffer.rt = { ...i.gbuffer.rt }; }],
  ["g-buffer position replacement", (i) => { i.gbuffer.position = { version: 0 }; }],
  ["g-buffer normal replacement", (i) => { i.gbuffer.normal = { version: 0 }; }],
  ["g-buffer texture reinitialization", (i) => { i.gbuffer.position.version++; }],
  ["resize", (i) => { i.gbuffer.rt.width++; }],
  ["AO resize", (i) => { i.pass.width++; }],
  ["AO quality rearm", (i) => { i.pass = { ...i.pass }; }],
  ["AO output replacement", (i) => { i.pass.target = { version: 0 }; }],
  ["AO raw replacement", (i) => { i.pass.rawTarget = { version: 0 }; }],
  ["AO texture reinitialization", (i) => { i.pass.target.version++; }],
  ["filter rebuild", (i) => { i.nodes = new Set([...i.nodes].slice(0, 2).concat({})); }],
  ["filter removal", (i) => { i.nodes.delete([...i.nodes][2]); }],
]) {
  test(`${name} invalidates cached GTAO immediately`, () => {
    const cache = new GiGtaoHold();
    const inputs = fixture();
    cache.record(inputs, true);
    mutate(inputs);
    assert.equal(cache.canReuse(inputs, ready), false);
    cache.record(inputs, true);
    assert.equal(cache.canReuse(inputs, ready), true);
  });
}

test("a partial chain cannot reuse the old receipt after inputs change back", () => {
  const cache = new GiGtaoHold();
  const inputs = fixture();
  cache.record(inputs, true);
  inputs.strength = 0.5;
  cache.record(inputs, false);
  inputs.strength = 1;
  assert.equal(cache.canReuse(inputs, ready), false, "the raw prefix may now hold the failed frame");
});

test("geometry changed while the screen chain was gated is fresh when it resumes", () => {
  const cache = new GiGtaoHold();
  const inputs = fixture();
  cache.record(inputs, true);
  // The g-buffer changed while occupancy warm-up gated the consumer block.
  // On the next frame it is held again, but AO still belongs to the old one.
  inputs.gbufferGeneration++;
  assert.equal(cache.canReuse(inputs, ready), false);
});

test("diagnostic world AO, legacy AO and disabled caching never hold", () => {
  for (const reusableGtao of [false, undefined]) {
    const cache = new GiGtaoHold();
    const inputs = fixture();
    inputs.pass.reusableGtao = reusableGtao;
    cache.record(inputs, true);
    assert.equal(cache.canReuse(inputs, ready), false);
  }
  const cache = new GiGtaoHold();
  const inputs = fixture();
  cache.record(inputs, true);
  inputs.enabled = false;
  assert.equal(cache.canReuse(inputs, ready), false);
});

test("unready chains, missing uniforms, and nonfinite values fail open", () => {
  const cache = new GiGtaoHold();
  const inputs = fixture();
  cache.record(inputs, true);
  assert.equal(cache.canReuse(inputs, { ...ready, chainReady: false }), false);
  assert.equal(cache.canReuse(inputs, { ...ready, gbufferHeld: false }), false);
  for (const invalid of [undefined, NaN, Infinity]) {
    inputs.strength = invalid;
    cache.record(inputs, true);
    assert.equal(cache.canReuse(inputs, ready), false);
  }
});

// Execute the real tick block with a deterministic fake compute queue. The
// helper's input tests alone cannot catch a missing live uniform at its caller,
// a filter left dispatching, or a receipt stamped before the async skip check.
const systemSource = fs.readFileSync(new URL("../src/modules/gi/GISystem.js", import.meta.url), "utf8");
const dispatchStart = systemSource.indexOf("const gtaoHold = this._gtaoHold");
const dispatchEnd = systemSource.indexOf("if (state.screen.ao?.enabled)", dispatchStart);
assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart);
const dispatchScreen = new Function("GiGtaoHold", "giNodesReady", "giCompute", "renderer", "state", "screenPasses", "dispatchOptions",
  systemSource.slice(dispatchStart, dispatchEnd));

function runtimeFixture() {
  const inputs = fixture();
  const system = {
    config: { ao: true },
    _gbufHeld: true,
    _gtaoGbufferGeneration: inputs.gbufferGeneration,
    _giResolveCamU: { value: inputs.cameraPosition },
    _giAoCamRightU: { value: inputs.cameraRight },
    _giAoCamUpU: { value: inputs.cameraUp },
    _giAoProjU: { value: inputs.projectionScale },
  };
  const state = { screen: {
    vxaoPass: inputs.pass,
    aoComputes: inputs.nodes,
    gbuffer: inputs.gbuffer,
    vxao: { strength: { value: inputs.strength }, radius: { value: inputs.radius } },
  } };
  const before = { name: "screen gather" }, after = { name: "screen resolve" };
  const all = [before, ...inputs.nodes, after];
  let chainReady = false;
  let complete = true;
  const submitted = [];
  const frame = () => {
    submitted.length = 0;
    const candidates = system.config.ao ? all : all.filter((n) => !inputs.nodes.has(n));
    dispatchScreen.call(system, GiGtaoHold, () => chainReady,
      (_renderer, queue) => {
        submitted.push(...queue);
        if (queue.some((n) => inputs.nodes.has(n))) chainReady = complete;
      }, {}, state, candidates, {});
    return [...submitted];
  };
  return { system, state, inputs, all, before, after, frame, setComplete: (value) => { complete = value; } };
}

test("production tick holds every AO node while leaving other screen work in order", () => {
  const r = runtimeFixture();
  assert.deepEqual(r.frame(), r.all);
  assert.equal(r.system._gtaoHeld, false);
  assert.deepEqual(r.frame(), [r.before, r.after]);
  assert.equal(r.system._gtaoHeld, true);
  assert.equal(r.system._gtaoHeldFrames, 1);
  r.system._gbufHeld = false;
  r.system._gtaoGbufferGeneration++;
  assert.deepEqual(r.frame(), r.all);
  assert.equal(r.system._gtaoHeldFrames, 0);
  r.system._gbufHeld = true;
  assert.deepEqual(r.frame(), [r.before, r.after]);
  r.state.screen.vxao.strength.value = 0.7;
  assert.deepEqual(r.frame(), r.all, "caller must pass live strength to the receipt");
  r.system._giAoProjU.value += 10;
  assert.deepEqual(r.frame(), r.all, "caller must pass live projection to the receipt");
});

test("production tick retries the whole chain after a pending or skipped filter", () => {
  const r = runtimeFixture();
  r.setComplete(false);
  assert.deepEqual(r.frame(), r.all);
  assert.deepEqual(r.frame(), r.all);
  r.setComplete(true);
  assert.deepEqual(r.frame(), r.all);
  assert.deepEqual(r.frame(), [r.before, r.after]);
});

test("production tick does not claim a dispatch while AO is disabled", () => {
  const r = runtimeFixture();
  r.frame();
  r.system.config.ao = false;
  assert.deepEqual(r.frame(), [r.before, r.after]);
  assert.equal(r.system._gtaoHeld, false);
  r.system.config.ao = true;
  assert.deepEqual(r.frame(), r.all);
});
