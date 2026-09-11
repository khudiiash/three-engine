/**
 * VORONOI FRACTURE (src/modules/physics-rapier/fracture.js).
 *
 * The geometry half of Destructible, tested without Rapier, an engine or a
 * GPU — `fractureGeometry` is geometry in, geometry out precisely so that the
 * properties that make a fracture look right can be asserted rather than
 * eyeballed:
 *
 *   · the pieces TILE the original — their volumes sum back to the source's,
 *     which is the one check that catches a lost cap face, an inverted
 *     winding or a cell that swallowed its neighbour;
 *   · the same seed gives the same pieces (a scene reloads the same way);
 *   · a multi-material object keeps its materials per piece;
 *   · the impact pattern really does concentrate pieces near the hit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { collectFractureSources, fractureGeometry, geometryVolume } from "../src/modules/physics-rapier/fracture.js";

const CUBE_VOLUME = 8; // 2 x 2 x 2

function cube() {
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  geometry.computeVertexNormals();
  return geometry;
}

function sources(...geometries) {
  return geometries.map((geometry, i) => ({ geometry, material: { name: `mat${i}` } }));
}

test("the pieces tile the object they came from", () => {
  const fragments = fractureGeometry(sources(cube()), { pieces: 12, seed: 3 });
  assert.ok(fragments.length >= 8, `expected most of 12 cells to survive, got ${fragments.length}`);
  const total = fragments.reduce((sum, fragment) => sum + fragment.volume, 0);
  // 1% — the cut faces are exact planes, so the only error is float noise in
  // the CSG. A missing cap or a flipped face is a whole piece out, not 1%.
  assert.ok(
    Math.abs(total - CUBE_VOLUME) < CUBE_VOLUME * 0.01,
    `pieces sum to ${total.toFixed(4)}, the cube is ${CUBE_VOLUME}`,
  );
});

test("every piece is recentred on its own origin", () => {
  const fragments = fractureGeometry(sources(cube()), { pieces: 8, seed: 11 });
  for (const fragment of fragments) {
    const bounds = new THREE.Box3();
    for (const part of fragment.parts) bounds.union(part.geometry.boundingBox);
    const centre = bounds.getCenter(new THREE.Vector3());
    // A body built around a geometry whose centre is metres away spins about a
    // point outside itself — the classic "the debris orbits something".
    assert.ok(centre.length() < 1e-3, `piece centre is ${centre.toArray()}`);
    assert.ok(fragment.offset.length() <= Math.sqrt(3), "the offset must be inside the cube");
  }
});

test("the same seed fractures the same way, a different seed does not", () => {
  const a = fractureGeometry(sources(cube()), { pieces: 10, seed: 7 });
  const b = fractureGeometry(sources(cube()), { pieces: 10, seed: 7 });
  const c = fractureGeometry(sources(cube()), { pieces: 10, seed: 8 });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(a[i].offset.distanceTo(b[i].offset) < 1e-9, "same seed, same piece");
    assert.ok(Math.abs(a[i].volume - b[i].volume) < 1e-9);
  }
  const moved = c.some((fragment, i) => !a[i] || fragment.offset.distanceTo(a[i].offset) > 1e-3);
  assert.ok(moved, "a different seed must produce a different break-up");
});

test("each piece keeps the material of the mesh it was cut from", () => {
  const left = cube();
  left.translate(-1.5, 0, 0);
  const right = cube();
  right.translate(1.5, 0, 0);
  const fragments = fractureGeometry(sources(left, right), { pieces: 10, seed: 5 });
  assert.ok(fragments.length >= 6);
  const names = new Set(fragments.flatMap((fragment) => fragment.parts.map((part) => part.material.name)));
  assert.deepEqual([...names].sort(), ["mat0", "mat1"], "both materials must survive the cut");
  // The two cubes do not touch, so no cell may claim a piece of both.
  for (const fragment of fragments) {
    const owners = new Set(fragment.parts.map((part) => part.material.name));
    assert.equal(owners.size, 1, "a piece spanning two disjoint meshes means the cells leaked");
  }
});

test("the impact pattern puts the small pieces where it was hit", () => {
  const focus = new THREE.Vector3(-1, 0, 0);
  const impact = fractureGeometry(sources(cube()), { pieces: 16, seed: 2, pattern: "impact", focus });
  const near = impact.filter((fragment) => fragment.offset.distanceTo(focus) < 1).length;
  const far = impact.length - near;
  assert.ok(near > far, `impact fracture put ${near} pieces near the hit and ${far} away from it`);
});

test("a piece is a closed solid, not a surface", () => {
  const [fragment] = fractureGeometry(sources(cube()), { pieces: 6, seed: 21 });
  // Enclosing a real volume is what lets Rapier weigh the debris; an open cut
  // (the cap face missing) integrates to nearly nothing.
  assert.ok(fragment.volume > 0.05, `piece volume ${fragment.volume}`);
  assert.ok(Math.abs(geometryVolume(fragment.parts[0].geometry) - fragment.volume) < 1e-6);
});

test("fracture refuses the cases that cannot produce pieces", () => {
  assert.deepEqual(fractureGeometry([], { pieces: 8 }), []);
  assert.deepEqual(fractureGeometry(sources(cube()), { pieces: 1 }), []);
  assert.deepEqual(fractureGeometry(sources(new THREE.BufferGeometry()), { pieces: 4 }), []);
});

test("collectFractureSources bakes child meshes into the root's frame", () => {
  const root = new THREE.Object3D();
  root.position.set(5, 0, 0);
  const child = new THREE.Mesh(cube());
  child.position.set(0, 2, 0);
  root.add(child);
  root.updateMatrixWorld(true);
  const collected = collectFractureSources(root);
  assert.equal(collected.length, 1);
  collected[0].geometry.computeBoundingBox();
  const centre = collected[0].geometry.boundingBox.getCenter(new THREE.Vector3());
  // Local to the root: the child's own offset survives, the root's does not.
  assert.ok(centre.distanceTo(new THREE.Vector3(0, 2, 0)) < 1e-5, `baked centre ${centre.toArray()}`);
});
