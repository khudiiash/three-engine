import assert from "node:assert/strict";
import * as THREE from "three/webgpu";

import { MeshComponent } from "../src/engine/components/MeshComponent.js";

const entity = {
  id: "cube",
  object3D: new THREE.Group(),
  getComponent: () => null,
};

const component = new MeshComponent(entity, { geometry: "box" });
component.onAttach();

// #loadExtraMaterials completes on a microtask even when every extra slot is
// empty. This used to replace the scalar material with an eight-item array;
// BoxGeometry then mapped Material 1 to just its first side group.
await Promise.resolve();
await Promise.resolve();

assert.equal(component.mesh.geometry.groups.length, 6, "the cube retains its six built-in face groups");
assert.ok(!Array.isArray(component.mesh.material), "one assigned material must cover every cube face");

component.onDetach();
console.log("Mesh material-slot checks passed.");
