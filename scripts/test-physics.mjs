// Headless test of the module system + Rapier physics module: enables the
// module on a bare Engine (no renderer), builds a ground + falling box, steps
// the world by driving engine update callbacks, and checks fall, rest,
// collision events, and raycasts. Run: node scripts/test-physics.mjs
import assert from "node:assert/strict";
import { Engine, enableEngineModule, disableEngineModule, getComponentClass } from "../src/engine/index.js";
import "../src/modules/index.js";

const engine = new Engine();

// -- enable --
await enableEngineModule(engine, "physics-rapier");
assert.ok(getComponentClass("rigidbody"), "rigidbody registered");
assert.ok(getComponentClass("collider"), "collider registered");
assert.ok(engine.physics, "engine.physics exposed");
assert.ok(engine.modules.has("physics-rapier"), "module handle stored");

// -- scene: static ground + dynamic box 5 units up --
const ground = engine.createEntity({ name: "Ground" });
ground.addComponent("collider", { shape: "box", size: [20, 1, 20] });
ground.object3D.position.set(0, -0.5, 0);

const box = engine.createEntity({ name: "Box" });
box.addComponent("rigidbody", { bodyType: "dynamic", mass: 2 });
box.addComponent("collider", { shape: "box", size: [1, 1, 1], restitution: 0 });
box.object3D.position.set(0, 5, 0);

let collisions = 0;
engine.on("collision", ({ a, b, started }) => {
  if (started) collisions++;
});

// -- play: world builds, bodies appear --
engine.setPlaying(true);
const rb = box.getComponent("rigidbody");
assert.ok(rb.body, "rigidbody got a Rapier body on play start");

const step = (dt = 1 / 60) => {
  for (const fn of engine.updateCallbacks) fn(dt);
};

step();
step();
assert.ok(box.object3D.position.y < 5, `box started falling (y=${box.object3D.position.y})`);

for (let i = 0; i < 300; i++) step();
const restY = box.object3D.position.y;
assert.ok(Math.abs(restY - 0.5) < 0.05, `box rests on ground (y=${restY}, expected ~0.5)`);
assert.ok(collisions >= 1, `collision event fired (${collisions})`);

// -- raycast straight down hits the box top --
const hit = engine.physics.raycast([0, 10, 0], [0, -1, 0]);
assert.ok(hit, "raycast hit something");
assert.equal(hit.entity, box, "raycast hit the box");
assert.ok(Math.abs(hit.point[1] - 1) < 0.05, `hit point at box top (y=${hit.point[1]})`);

// -- script-facing impulse --
rb.applyImpulse([0, 10, 0]);
step();
assert.ok(rb.getLinearVelocity()[1] > 1, "impulse raised velocity");

// -- trigger (sensor) events --
let triggers = 0;
engine.on("trigger", ({ started }) => started && triggers++);
engine.setPlaying(false);
assert.equal(rb.body, null, "body cleared on stop");
const sensor = engine.createEntity({ name: "Zone" });
sensor.addComponent("collider", { shape: "box", size: [4, 4, 4], isSensor: true });
sensor.object3D.position.set(0, 0.5, 0); // overlaps the box (headless has no play-mode snapshot; the box stays where it fell)
engine.setPlaying(true);
for (let i = 0; i < 30; i++) step();
assert.ok(triggers >= 1, `trigger event fired (${triggers})`);

// -- child collider compounds onto ancestor body --
engine.setPlaying(false);
const parent = engine.createEntity({ name: "Compound" });
parent.addComponent("rigidbody", { bodyType: "dynamic" });
const childCol = engine.createEntity({ name: "Part", parent });
childCol.addComponent("collider", { shape: "sphere", radius: 0.5 });
childCol.object3D.position.set(0, 20, 0);
parent.object3D.position.set(8, 3, 0);
engine.setPlaying(true);
for (let i = 0; i < 10; i++) step();
assert.ok(parent.object3D.position.y < 3, "compound body falls");
engine.setPlaying(false);

// -- disable: components unregister, physics detaches --
await disableEngineModule(engine, "physics-rapier");
assert.equal(getComponentClass("rigidbody"), undefined, "rigidbody unregistered");
assert.equal(engine.physics, undefined, "engine.physics removed");

// -- missing-component tolerance: serialize keeps disabled-module data --
const { serializeEntity } = await import("../src/engine/serialize.js");
const orphan = engine.createEntity({ name: "Orphan" });
orphan.addComponent("rigidbody", { bodyType: "kinematic" });
const json = serializeEntity(orphan);
assert.equal(json.components[0].type, "rigidbody", "missing component keeps its type");
assert.equal(json.components[0].props.bodyType, "kinematic", "missing component keeps its props");

console.log("test-physics: all assertions passed ✔");
