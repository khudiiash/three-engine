import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { ParticleColliderField } from "../src/engine/particleColliders.js";

const object3D = new THREE.Object3D();
object3D.position.set(3, 2, 1);
object3D.rotation.y = Math.PI / 2;
object3D.scale.set(2, 3, 4);

const collider = {
  enabled: true,
  props: {
    shape: "box",
    size: [2, 4, 6],
    offset: [1, 0.5, -0.25],
  },
};
const entity = {
  object3D,
  getComponent: (type) => (type === "collider" ? collider : null),
};
const engine = {
  entities: new Map([["box", entity]]),
  particleColliders: null,
};

const field = new ParticleColliderField(engine);
engine.particleColliders = field;
field.addUser();
field.refresh();

const expectedCenter = new THREE.Vector3(...collider.props.offset).applyMatrix4(object3D.matrixWorld);
assert.equal(field.countUniform.value, 1, "one supported scene collider is uploaded");
assert.deepEqual(
  Array.from(field.data.slice(1, 4)).map((value) => Number(value.toFixed(5))),
  expectedCenter.toArray().map((value) => Number(value.toFixed(5))),
  "a collider's local offset follows its full world transform",
);
assert.ok(field.buffer.value.version > 0, "refresh marks collider storage for GPU upload");

collider.enabled = false;
field.refresh();
assert.equal(field.countUniform.value, 0, "disabled colliders are removed on the next refresh");

field.removeUser();
field.dispose();
assert.equal(engine.particleColliders, undefined, "disposing releases the engine singleton");

console.log("Particle scene-collider checks passed.");
