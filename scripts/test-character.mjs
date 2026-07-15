// Headless test of the Rapier character-controller component: enables the
// module on a bare Engine, drops a capsule character above a static floor, and
// checks gravity/grounding, horizontal movement, jumping, and teleport by
// driving engine update callbacks. Run: node scripts/test-character.mjs
//
// The Engine constructor builds an InputManager that reads `document.body`, so
// stub a minimal DOM before importing anything that constructs an Engine.
globalThis.document ??= { body: {} };

import assert from "node:assert/strict";
import { Engine, enableEngineModule, getComponentClass } from "../src/engine/index.js";
import "../src/modules/index.js";

const engine = new Engine();
await enableEngineModule(engine, "physics-rapier");
// Rapier's WASM init runs in the background; wait for it before playing.
await engine.modules.get("physics-rapier")?.ready;
assert.ok(getComponentClass("charactercontroller"), "charactercontroller registered");
assert.ok(engine.physics, "engine.physics exposed");

// Static floor: top face at y = 0.
const ground = engine.createEntity({ name: "Ground" });
ground.addComponent("collider", { shape: "box", size: [40, 1, 40] });
ground.object3D.position.set(0, -0.5, 0);

// Character capsule dropped from y = 3. Centered capsule → rests with its
// center at floor_top + height/2 + radius = 0 + 0.5 + 0.3 = 0.8.
const player = engine.createEntity({ name: "Player" });
player.addComponent("charactercontroller", { radius: 0.3, height: 1.0 });
player.object3D.position.set(0, 3, 0);

engine.setPlaying(true);
const cc = player.getComponent("charactercontroller");
assert.ok(cc.body && cc.collider && cc.controller, "character got body + collider + controller on play");

const step = (dt = 1 / 60) => {
  for (const fn of engine.updateCallbacks) fn(dt);
};

// -- falls under gravity and comes to rest grounded --
assert.equal(cc.isGrounded(), false, "not grounded while falling");
for (let i = 0; i < 180; i++) step();
const restY = player.object3D.position.y;
assert.ok(cc.isGrounded(), "grounded after landing");
assert.ok(Math.abs(restY - 0.8) < 0.12, `rests on floor (y=${restY.toFixed(3)}, expected ~0.8)`);

// -- horizontal move is velocity-based (units/sec) and framerate-independent --
cc.move([2, 0, 0]); // 2 u/s along +x
const x0 = player.object3D.position.x;
for (let i = 0; i < 60; i++) step(); // ~1 s
const dx = player.object3D.position.x - x0;
assert.ok(Math.abs(dx - 2) < 0.4, `moved ~2 units in 1s (dx=${dx.toFixed(3)})`);
assert.ok(cc.isGrounded(), "stays grounded while walking on flat floor");

// -- stop moving: velocity persists until changed, so zero it --
cc.move([0, 0, 0]);
const xStopped = player.object3D.position.x;
for (let i = 0; i < 30; i++) step();
assert.ok(Math.abs(player.object3D.position.x - xStopped) < 0.02, "stops when velocity set to 0");

// -- jump leaves the ground, then gravity brings it back --
const yBeforeJump = player.object3D.position.y;
cc.jump(6);
step();
assert.ok(player.object3D.position.y > yBeforeJump, "rises right after jump");
for (let i = 0; i < 8; i++) step();
assert.equal(cc.isGrounded(), false, "airborne mid-jump");
for (let i = 0; i < 90; i++) step();
assert.ok(cc.isGrounded(), "lands again after the jump");

// -- jump only works when grounded --
cc.setVelocity([0, 0, 0]);
step();
const airborneJumpIgnored = (() => {
  cc.grounded = false; // pretend airborne
  cc.jump(6);
  return cc.getVelocity()[1] === 0;
})();
assert.ok(airborneJumpIgnored, "jump ignored while airborne");

// -- teleport repositions instantly and clears fall speed --
cc.teleport([10, 5, -4]);
step();
assert.ok(player.object3D.position.x > 9 && player.object3D.position.x < 11, "teleported in x");
assert.ok(player.object3D.position.z < -3 && player.object3D.position.z > -5, "teleported in z");

// A browser/Tauri animation loop can report a very large delta after the
// editor was minimized. The fixed-step cap must absorb it without invalidating
// the live character handles.
assert.doesNotThrow(() => step(5), "large resume delta keeps the character live");
assert.ok(cc.body && cc.collider && cc.controller, "handles survive a resumed frame");

// -- live removal must unregister the Rapier handles before the next tick --
// This is also the stale-entry path seen when a suspended editor resumes after
// an entity/component lifecycle change.
player.removeComponent("charactercontroller");
assert.equal(engine.physics.characters.length, 0, "character entry removed immediately on detach");
assert.doesNotThrow(() => step(), "next/resumed physics tick ignores the detached character");

engine.setPlaying(false);
assert.equal(cc.body, null, "body cleared on stop");
assert.equal(cc.controller, null, "controller cleared on stop");

console.log("test-character: all assertions passed ✔");
