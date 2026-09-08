import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Entity } from '../src/engine/Entity.js';
import { ColliderComponent } from '../src/modules/physics-rapier/ColliderComponent.js';
import { PhysicsSystem } from '../src/modules/physics-rapier/PhysicsSystem.js';
import { collisionSimplifierReady } from '../src/modules/physics-rapier/collisionGeometry.js';

// These tests assert preview SEMANTICS (which shape's wireframe is on screen
// after a switch), not the queue's timing. The documented hatch restores the
// synchronous, uncached outline build so assertions can be synchronous.
globalThis.__editorColliderOutlineAsync = false;

/** A cooked hull (tetrahedron) as PhysicsSystem caches it per entity. */
const COOKED = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]),
  convexParts: [{
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]),
  }],
};

function visualFixture(props = {}) {
  const engine = {
    entities: new Map(),
    playing: false,
    on: () => () => {},
    emit: () => {},
  };
  const entity = new Entity(engine, { id: 'c', name: 'Crate' });
  engine.entities.set(entity.id, entity);
  const renderMesh = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 6));
  renderMesh.userData.entityId = entity.id;
  entity.object3D.add(renderMesh);
  engine.physics = {
    markDirty() {}, removeEntity() {}, invalidateAutoCollider() {}, prewarmAutoColliders() {},
    getCookedColliderGeometry: () => COOKED,
  };
  const collider = new ColliderComponent({ shape: 'box', ...props });
  collider.entity = entity;
  entity.components.set('collider', collider);
  collider.onAttach();
  return { engine, entity, collider, renderMesh };
}

test('switching shape swaps gizmo and outline — the baked mesh outline never lingers', () => {
  const { collider } = visualFixture();
  // A primitive shows its real gizmo and — with outlines requested — nothing else.
  collider.setDebugVisible(true, true);
  assert.ok(collider.gizmo, 'box shows its gizmo');
  assert.ok(!collider.outline, 'box must not also show a baked geometry outline');

  // Onto a geometry-derived shape: gizmo goes, the cooked hull outline comes.
  collider.setProp('shape', 'convex');
  assert.ok(!collider.gizmo);
  assert.ok(collider.outline, 'convex shows its cooked outline');

  // Back to a primitive: the outline is gone. This is the old bug — #buildOutline
  // fell through to a rendered-mesh trace for shapes it has no cooked data for.
  collider.setProp('shape', 'box');
  assert.ok(collider.gizmo);
  assert.ok(!collider.outline, 'no baked outline beside the new gizmo');
});

test('heightfield requests an outline and gets no baked mesh edges', () => {
  const { collider } = visualFixture({ shape: 'heightfield' });
  collider.setDebugVisible(true, true);
  // No sibling Terrain: no gizmo can be built, but the fallback must be
  // nothing at all — never the rendered meshes traced as an outline.
  assert.ok(!collider.outline);
});

test('custom collider shows the cooked asset outline instead of a gizmo', () => {
  const { collider } = visualFixture({ shape: 'custom', geometryAsset: 'proxy.geom' });
  collider.setDebugVisible(true, true);
  assert.ok(!collider.gizmo, 'geometry-derived shapes build no primitive gizmo');
  assert.ok(collider.outline, 'cooked asset geometry is previewed');
  collider.setDebugVisible(false);
  assert.ok(!collider.outline);
});

test('custom collider cooks from its authored asset, not the rendered meshes', async () => {
  // The cook welds/simplifies through meshoptimizer's wasm — it must be live.
  await collisionSimplifierReady;
  const engine = {
    config: {},
    entities: new Map(),
    playing: false,
    on: () => () => {},
    onUpdate: () => () => {},
    emit: () => {},
    getEntity: (id) => engine.entities.get(id),
    // Real Engine API: runs the coalesced pass (one hierarchy event for it).
    batchHierarchy: (fn) => fn(),
  };
  const entity = new Entity(engine, { id: 'c', name: 'Block' });
  engine.entities.set(entity.id, entity);
  // A rendered mesh that must NOT leak into a custom collider's cook.
  const renderMesh = new THREE.Mesh(new THREE.BoxGeometry(50, 50, 50));
  renderMesh.userData.entityId = entity.id;
  entity.object3D.add(renderMesh);
  const collider = new ColliderComponent({ shape: 'custom', geometryAsset: 'proxy.geom' });
  collider.entity = entity;
  entity.components.set('collider', collider);
  // Hand over the loaded shared instance the way acquireGeometryAsset would.
  const asset = new THREE.BoxGeometry(2, 2, 2);
  asset.userData.assetPath = 'proxy.geom';
  collider.geometry = asset;

  // No RAPIER: hull cooking is unavailable, but the exact-triangle cook —
  // the shape a Custom collider builds on fixed bodies — must still work.
  const physics = new PhysicsSystem(engine, undefined);
  physics.invalidateAutoCollider(entity);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const cooked = physics.getCookedColliderGeometry(entity);
  assert.ok(cooked, 'the asset cooked');
  assert.equal(cooked.indices.length / 3, 12, 'the ASSET is cooked (12 triangles), not the render mesh');
  let maxExtent = 0;
  for (let i = 0; i < cooked.vertices.length; i++) maxExtent = Math.max(maxExtent, Math.abs(cooked.vertices[i]));
  assert.ok(maxExtent <= 1.0001, `vertices stay within the asset's 2-unit box (max ${maxExtent})`);
  assert.ok(cooked.concave, 'a reduced view is cooked alongside the exact one');

  // A geometry whose path no longer matches the picker is treated as missing:
  // a mid-swap cook must never build the OLD asset's shape.
  collider.props.geometryAsset = 'other.geom';
  physics.invalidateAutoCollider(entity);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!physics.getCookedColliderGeometry(entity));
  physics.dispose();
});
