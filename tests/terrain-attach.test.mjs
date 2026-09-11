import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { Entity } from "../src/engine/Entity.js";
import { MeshComponent } from "../src/engine/components/MeshComponent.js";
import { TerrainComponent } from "../src/modules/terrain/TerrainComponent.js";

test("real Terrain attaches and authored resolution setters rebuild without recursive attachment", async () => {
  const listeners = new Map();
  const engine = {
    entities: new Map(), playing: false, scene: new THREE.Scene(),
    on(name, fn) { const group = listeners.get(name) ?? new Set(); listeners.set(name, group); group.add(fn); return () => group.delete(fn); },
    emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); },
  };
  const entity = new Entity(engine, { id: "terrain", name: "Terrain" });
  engine.entities.set(entity.id, entity);
  const mesh = entity.addComponent(new MeshComponent({ geometry: "plane" }));
  const terrain = entity.addComponent(new TerrainComponent({ size: 12, resolution: 4, splatResolution: 16 }));
  await Promise.resolve();
  assert.equal(terrain.geometry.getAttribute("position").count, 25);
  assert.equal(terrain.splatTexture.image.width, 16);
  assert.equal(mesh.mesh.geometry, terrain.geometry);
  assert.equal(terrain.heightAtLocal(0, 0), 0);
  const oldGeometry = terrain.geometry;
  let disposed = false;
  oldGeometry.addEventListener("dispose", () => { disposed = true; });
  terrain.resolution = 6;
  assert.equal(terrain.props.resolution, 6, "script setter remains an authored property");
  assert.equal(terrain.geometry.getAttribute("position").count, 49);
  assert.equal(mesh.mesh.geometry, terrain.geometry);
  assert.equal(disposed, true, "the previous GPU resource is retired once");
  terrain.splatResolution = 32;
  assert.equal(terrain.props.splatResolution, 32);
  assert.equal(terrain.splatData.length, 32 * 32 * 4);
  assert.equal(terrain.splatTexture.image.width, 32);
  terrain.setProp("heights", terrain.props.heights);
  assert.equal(terrain.heightsArray.length, 49);
  assert.equal(terrain.heightAtLocal(2, -2), 0);
  for (const [authored, canonical] of [[6.9, 6], [1.9, 2], [0, 2], [-3, 2]]) {
    terrain.resolution = authored;
    assert.equal(terrain.props.resolution, authored, "authored input stays available to scripts and serialization");
    assert.equal(terrain.resolution, authored, "the authored mirror must not become a runtime field again");
    assert.equal(terrain._gridResolution, canonical, "colliders consume the built grid resolution");
    assert.equal(terrain.heightsArray.length, (canonical + 1) ** 2);
    assert.equal(terrain.geometry.getAttribute("position").count, terrain.heightsArray.length);
    assert.equal(terrain.geometry.parameters.widthSegments, canonical);
    assert.equal(terrain.geometry.parameters.heightSegments, canonical);
    assert.ok(Number.isFinite(terrain.heightAtLocal(2, -2)), "sampling uses the canonical row stride");
  }
  terrain.splatResolution = 5.9;
  assert.equal(terrain.props.splatResolution, 5.9);
  assert.equal(terrain._splatResolution, 5);
  assert.equal(terrain.splatData.length, 5 * 5 * 4);
  assert.equal(terrain.splatTexture.image.width, 5);
  entity.removeComponent("terrain");
  entity.removeComponent("mesh");
});
