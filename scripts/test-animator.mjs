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
  entry: "idle",
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

assert(runtime.currentState?.name === "Idle", "enters entry state");

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

console.log("All animator runtime checks passed.");
