// Headless check of the AnimatorRuntime state machine (node scripts/test-animator.mjs).
import * as THREE from "three/webgpu";
import { AnimatorRuntime, ANY_STATE } from "../src/engine/animGraph.js";

const clip = (name, duration = 1) =>
  new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack(".position", [0, duration], [0, 0, 0, 0, 0, 1]),
  ]);

const clips = [clip("Idle"), clip("Run"), clip("Jump", 0.5)];
const root = new THREE.Object3D();
const mixer = new THREE.AnimationMixer(root);

const graph = {
  version: 1,
  parameters: [
    { name: "speed", type: "number", default: 0 },
    { name: "jump", type: "trigger" },
  ],
  states: [
    { id: "idle", name: "Idle", clip: "Idle", loop: true },
    { id: "run", name: "Run", clip: "Run", loop: true },
    { id: "jump", name: "Jump", clip: "Jump", loop: false },
  ],
  startTransitions: [
    { id: "st1", to: "idle", conditions: [] }, // default entry
    { id: "st2", to: "run", conditions: [{ param: "speed", op: ">", value: 0.5 }] }, // boot-time conditional
  ],
  transitions: [
    { id: "t1", from: "idle", to: "run", duration: 0.2, conditions: [{ param: "speed", op: ">", value: 0.5 }] },
    { id: "t2", from: "run", to: "idle", duration: 0.2, conditions: [{ param: "speed", op: "<=", value: 0.5 }] },
    { id: "t3", from: ANY_STATE, to: "jump", duration: 0.1, conditions: [{ param: "jump" }] },
    { id: "t4", from: "jump", to: "idle", duration: 0.2, conditions: [] }, // exit-time default (clip end)
  ],
};

const runtime = new AnimatorRuntime(graph, mixer, clips);
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg} (current: ${runtime.currentState?.name})`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
};

assert(runtime.currentState?.name === "Idle", "enters via first Start transition with no conditions");

runtime.update(0.016);
assert(runtime.currentState?.name === "Idle", "stays in Idle without conditions met");

runtime.setParam("speed", 1);
runtime.update(0.016);
assert(runtime.currentState?.name === "Run", "speed > 0.5 transitions Idle -> Run");

runtime.setTrigger("jump");
runtime.update(0.016);
assert(runtime.currentState?.name === "Jump", "any-state trigger fires Run -> Jump");
assert(runtime.getParam("jump") === false, "trigger consumed by transition");

runtime.setParam("speed", 0);
for (let i = 0; i < 60; i++) runtime.update(0.016); // ride out the 0.5s jump clip
assert(runtime.currentState?.name === "Idle", "exit-time transition returns Jump -> Idle");

runtime.play("Run", 0);
assert(runtime.currentState?.name === "Run", "play() forces a state");

// Conditional Start transition: a fresh runtime whose Start list is
// [conditional → Run, unconditional → Idle] and whose `speed` default is
// already > 0.5 should boot straight into Run.
const conditionalGraph = {
  ...graph,
  startTransitions: [
    { id: "st1", to: "run", conditions: [{ param: "speed", op: ">", value: 0.5 }] },
    { id: "st2", to: "idle", conditions: [] },
  ],
};
{
  const g = JSON.parse(JSON.stringify(conditionalGraph));
  for (const p of g.parameters) if (p.name === "speed") p.default = 1;
  const rt = new AnimatorRuntime(g, new THREE.AnimationMixer(new THREE.Object3D()), clips);
  assert(rt.currentState?.name === "Run", "conditional Start transition picks Run when speed default > 0.5");
}
{
  const g = JSON.parse(JSON.stringify(conditionalGraph));
  // speed default stays at 0 — no Start condition passes, so we fall through
  // to the unconditional default entry (Idle).
  const rt = new AnimatorRuntime(g, new THREE.AnimationMixer(new THREE.Object3D()), clips);
  assert(rt.currentState?.name === "Idle", "Start falls through to default when conditions fail");
}

// Regression: overlapping transition thresholds must not freeze the model on
// frame 0. Walk->Run fires at speed>2, Run->Walk at speed<3; at speed 2.5 both
// conditions hold. Before the transition-lock fix the runtime flipped states
// every frame, and each re-entry's reset() pinned the clip at time 0. Now the
// current clip must actually advance.
{
  const g = {
    version: 1,
    parameters: [{ name: "speed", type: "number", default: 2.5 }],
    states: [{ id: "walk", name: "Walk", clip: "Idle", loop: true }, { id: "run", name: "Run", clip: "Run", loop: true }],
    startTransitions: [{ to: "walk", conditions: [] }],
    transitions: [
      { id: "t1", from: "walk", to: "run", duration: 0.2, conditions: [{ param: "speed", op: ">", value: 2 }] },
      { id: "t2", from: "run", to: "walk", duration: 0.2, conditions: [{ param: "speed", op: "<", value: 3 }] },
    ],
  };
  const rt = new AnimatorRuntime(g, new THREE.AnimationMixer(new THREE.Object3D()), clips);
  let maxTime = 0;
  for (let i = 0; i < 40; i++) {
    rt.update(0.05);
    const a = rt.actions.get(rt.currentId);
    if (a) maxTime = Math.max(maxTime, a.time);
  }
  assert(maxTime > 0.15, "overlapping thresholds keep the clip advancing (not frozen at frame 0)");
}

// A self-targeting transition must never be auto-taken (it would reset the clip
// to frame 0 every frame it holds).
{
  const g = {
    version: 1,
    parameters: [{ name: "on", type: "boolean", default: true }],
    states: [{ id: "a", name: "A", clip: "Idle", loop: true }],
    startTransitions: [{ to: "a", conditions: [] }],
    transitions: [{ id: "self", from: "a", to: "a", conditions: [{ param: "on", op: "==", value: true }] }],
  };
  const rt = new AnimatorRuntime(g, new THREE.AnimationMixer(new THREE.Object3D()), clips);
  for (let i = 0; i < 10; i++) rt.update(0.05);
  assert(rt.actions.get("a").time > 0.15, "self-transition is ignored, clip keeps advancing");
}

console.log("All animator runtime checks passed.");
