import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { InstancerComponent } from "../src/engine/components/InstancerComponent.js";

/**
 * THE RELOAD REPORT: "instances work properly when first setting up, but after
 * reload all instances lose the original mesh geometry, turning into simple
 * planes."
 *
 * The mechanism: components attach synchronously in stored order, so a scene
 * load builds the InstancerComponent from the MeshComponent's PLACEHOLDER
 * primitive; the real `.geom` asset swaps in a microtask later. The fix is the
 * component-changed listener — these tests pin its contract: the swap event
 * (exactly what MeshComponent.#announceSwap emits) must rebuild the instancer,
 * a material swap must refresh without a rebuild, unrelated keys must be
 * ignored, and a detached instancer must stay dead.
 */

function makeEngine() {
  const listeners = new Map();
  return {
    entities: new Map(),
    playing: false,
    scene: new THREE.Scene(),
    deltaTime: 0,
    on(event, fn) {
      let arr = listeners.get(event);
      if (!arr) listeners.set(event, (arr = []));
      arr.push(fn);
      return () => {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(event, ...args) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    },
    onPreRender(fn) {
      return this.on("__preRender", fn);
    },
  };
}

function fixture() {
  const engine = makeEngine();
  const entity = new Entity(engine, { id: "rock", name: "Rock" });
  engine.entities.set(entity.id, entity);
  // Same attach order a scene load uses: the mesh (and its placeholder
  // geometry) first, the instancer second.
  const mesh = entity.addComponent(new MeshComponent({ geometry: "plane" }));
  const instancer = entity.addComponent(new InstancerComponent({ mode: "array", count: 4 }));
  return { engine, entity, mesh, instancer };
}

/** The event MeshComponent.#announceSwap emits when an async asset lands. */
function announceSwap(engine, entity, key) {
  engine.emit("component-changed", {
    entityId: entity.id,
    componentType: "mesh",
    key,
  });
}

test("instances build from the source mesh's geometry", () => {
  const { mesh, instancer } = fixture();
  assert.ok(instancer.instancedMesh, "the instancer built");
  assert.equal(instancer.instancedMesh.geometry, mesh.mesh.geometry,
    "instances share the source mesh's current geometry");
});

test("a late geometry-asset swap rebuilds the instances onto the real geometry", () => {
  const { engine, entity, mesh, instancer } = fixture();
  const stale = instancer.instancedMesh;
  assert.equal(stale.geometry, mesh.mesh.geometry, "sanity: built from the placeholder");

  // The .geom lands: the mesh swaps the object, then announces it — the two
  // things #loadGeometry does, in the same order.
  const loaded = new THREE.TorusKnotGeometry(0.3, 0.1);
  mesh.mesh.geometry = loaded;
  announceSwap(engine, entity, "geometryAsset");

  assert.ok(instancer.instancedMesh !== stale, "the InstancedMesh was rebuilt, not patched");
  assert.equal(instancer.instancedMesh.geometry, loaded,
    "instances now draw the loaded geometry — not the placeholder plane");
});

test("a late material swap refreshes the material without a rebuild", () => {
  const { engine, entity, mesh, instancer } = fixture();
  const before = instancer.instancedMesh;
  const mat = new THREE.MeshBasicMaterial({ color: 0x3366ff });
  mesh.mesh.material = mat;
  announceSwap(engine, entity, "material");

  assert.equal(instancer.instancedMesh, before, "no rebuild for a material swap");
  assert.equal(instancer.instancedMesh.material, mat, "instances follow the source's material");
});

test("unrelated mesh props do not disturb the instancer", () => {
  const { engine, entity, instancer } = fixture();
  const before = instancer.instancedMesh;
  announceSwap(engine, entity, "castShadow");
  announceSwap(engine, entity, "receiveShadow");
  announceSwap(engine, entity, "material2");
  assert.equal(instancer.instancedMesh, before, "noise keys must not rebuild");
});

test("events for other entities are ignored", () => {
  const { engine, instancer } = fixture();
  const before = instancer.instancedMesh;
  engine.emit("component-changed", { entityId: "someone-else", componentType: "mesh", key: "geometryAsset" });
  assert.equal(instancer.instancedMesh, before);
});

test("a detached instancer stays dead when the swap announcement arrives", () => {
  const { engine, entity, instancer } = fixture();
  entity.removeComponent(instancer);
  assert.equal(instancer.instancedMesh, null, "torn down with the component");
  announceSwap(engine, entity, "geometryAsset");
  assert.equal(instancer.instancedMesh, null, "the late swap must not resurrect it");
});

test("an instancer added before its mesh builds once the mesh arrives", () => {
  const engine = makeEngine();
  const entity = new Entity(engine, { id: "late", name: "Late" });
  engine.entities.set(entity.id, entity);
  const instancer = entity.addComponent(new InstancerComponent({ mode: "array", count: 3 }));
  assert.equal(instancer.instancedMesh, null, "inert with no source mesh");
  entity.addComponent(new MeshComponent({ geometry: "box" }));
  assert.ok(instancer.instancedMesh, "the component-added announcement built it");
});

test("motion parameters are read live — a drag must not rebuild the buffer", () => {
  const { engine, entity, instancer } = fixture();
  instancer.setProp("motion", true);
  const rebuilt = instancer.instancedMesh;
  assert.ok(rebuilt, "the toggle rebuilt with motion armed");

  instancer.setProp("motionSpeed", 3);
  instancer.setProp("motionDirection", [0, 1, 0]);
  instancer.setProp("motionNeighborRadius", 3);
  instancer.setProp("motionCohesion", 0.5);
  assert.equal(instancer.instancedMesh, rebuilt,
    "motion param edits are read per frame and must not re-allocate the instance buffer");

  instancer.setProp("motionMode", "boids");
  assert.ok(instancer.instancedMesh !== rebuilt, "the model switch rebuilds — it changes the state machine");
});
