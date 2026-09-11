import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { collectSurfaceTriangles, scatterFoliage, reseatFoliageInstances } from "../src/modules/foliage/foliageScatter.js";

function triangle(vertices = [0, 0, 0, 0, 0, 1, 1, 0, 0]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}
function floor(size = 10, segments = 1) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments); geometry.rotateX(-Math.PI / 2);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}
const near = (a, b, epsilon = 1e-7) => assert.ok(Math.abs(a - b) <= epsilon, `${a} is near ${b}`);

test("area-weighted nested surfaces respect nonuniform world scale and actual triangles", () => {
  const root = new THREE.Group(), small = triangle(), nested = new THREE.Group(), big = triangle();
  nested.position.set(100, 2, 0); nested.scale.set(3, 2, 3); nested.add(big); root.add(small, nested);
  const surface = collectSurfaceTriangles(root);
  near(surface.totalArea, 5);
  const { instances } = scatterFoliage(surface, { count: 20000, maxInstances: 20000, seed: 17 });
  const large = instances.filter(i => i.position[0] >= 100);
  near(large.length / instances.length, 0.9, 0.012);
  for (const instance of instances) {
    const [x, y, z] = instance.position;
    if (x >= 100) { near(y, 2); assert.ok((x - 100) / 3 + z / 3 <= 1 + 1e-10); }
    else { near(y, 0); assert.ok(x + z <= 1 + 1e-10); }
  }
});

test("reflected geometry retains its outward surface normal under parent transforms", () => {
  const root = new THREE.Group(), mesh = triangle(); root.scale.set(-2, 3, 4); root.add(mesh);
  const surface = collectSurfaceTriangles(root);
  near(surface.totalArea, 4);
  surface.normals.forEach((value, i) => near(value, [0, 1, 0][i]));
  const { instances } = scatterFoliage(surface, { count: 10, maxSlope: 1 });
  assert.equal(instances.length, 10);
  for (const item of instances) assert.ok(item.position[0] <= 0 && item.position[2] >= 0);
});

test("InstancedMesh placement includes each instance and the complete parent matrix", () => {
  const prototype = triangle(), mesh = new THREE.InstancedMesh(prototype.geometry, prototype.material, 2);
  mesh.position.set(10, 0, 0);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 3, 0));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeScale(2, 1, 2).setPosition(20, 4, 0));
  const surface = collectSurfaceTriangles(mesh);
  near(surface.totalArea, 2.5);
  const { instances } = scatterFoliage(surface, { count: 100, seed: 3 });
  assert.ok(instances.some(i => i.position[0] >= 30 && i.position[1] === 4));
  assert.ok(instances.some(i => i.position[0] >= 10 && i.position[0] < 11 && i.position[1] === 3));
});

test("indexed, nonindexed, drawRange, degenerate, hidden and generated source handling", () => {
  const root = new THREE.Group(), indexed = floor(2), nonindexed = triangle();
  const degenerate = triangle([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const ranged = triangle([0, 0, 0, 0, 0, 1, 1, 0, 0, 5, 0, 0, 5, 0, 2, 7, 0, 0]);
  ranged.geometry.setDrawRange(3, 3);
  const hidden = floor(100); hidden.visible = false;
  const generated = new THREE.Group(); generated.userData.foliageOwned = true; generated.add(floor(100));
  root.add(indexed, nonindexed, degenerate, ranged, hidden, generated);
  const surface = collectSurfaceTriangles([root, indexed]);
  near(surface.totalArea, 6.5); assert.equal(surface.stats.triangles, 4); assert.equal(surface.stats.skippedDegenerate, 1);
  assert.throws(() => collectSurfaceTriangles(root, { maxTriangles: 2 }), /exceeds 2 triangles/);
});

test("scatter uses the visible morph snapshot through getVertexPosition", () => {
  const mesh = triangle();
  mesh.geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 1, 1, 2, 0], 3)];
  mesh.updateMorphTargets(); mesh.morphTargetInfluences[0] = 0.5;
  const { instances } = scatterFoliage(mesh, { count: 20 });
  assert.equal(instances.length, 20);
  for (const instance of instances) near(instance.position[1], 1);
});

test("optimizer-hidden source meshes remain plantable while batching/merging/impostor proxies are excluded", () => {
  const root = new THREE.Group(), batched = floor(2), merged = floor(3);
  batched.visible = false; batched.userData.batchedInto = {};
  merged.visible = false; merged.userData.mergedInto = {};
  root.add(batched, merged);
  for (const flag of ["batchProxy", "mergeProxy", "impostorQuad"]) {
    const proxy = floor(100); proxy.userData[flag] = true; root.add(proxy);
  }
  const surface = collectSurfaceTriangles(root);
  near(surface.totalArea, 13); assert.equal(surface.stats.triangles, 4);
  const disabledParent = new THREE.Group(); disabledParent.visible = false; disabledParent.add(batched); root.add(disabledParent);
  near(collectSurfaceTriangles(root).totalArea, 9, 1e-6);
});

test("seeded distribution is stable and disconnected surfaces do not fill their empty bounding box", () => {
  const root = new THREE.Group(), a = floor(2), b = floor(2); b.position.x = 1000; root.add(a, b);
  const surface = collectSurfaceTriangles(root);
  const first = scatterFoliage(surface, { density: 20, seed: 77 });
  const again = scatterFoliage(surface, { density: 20, seed: 77 });
  const other = scatterFoliage(surface, { density: 20, seed: 78 });
  assert.deepEqual(first.instances, again.instances); assert.notDeepEqual(first.instances, other.instances);
  assert.equal(first.instances.length, 160);
  assert.ok(first.instances.every(i => Math.abs(i.position[0]) <= 1 || Math.abs(i.position[0] - 1000) <= 1));
  const prefix = scatterFoliage(surface, { count: 10, seed: 77 });
  assert.deepEqual(first.instances.slice(0, 10), prefix.instances);
});

test("spacing is enforced across hash-cell boundaries and rejection work is bounded", () => {
  const surface = collectSurfaceTriangles(floor(3));
  const result = scatterFoliage(surface, { count: 2000, minSpacing: 0.65, seed: 91 });
  assert.ok(result.instances.length > 5 && result.instances.length < 40);
  assert.equal(result.stats.exhausted, true);
  assert.ok(result.stats.attempts <= 40000);
  for (let i = 0; i < result.instances.length; i++) for (let j = 0; j < i; j++) {
    const a = new THREE.Vector3().fromArray(result.instances[i].position), b = new THREE.Vector3().fromArray(result.instances[j].position);
    assert.ok(a.distanceTo(b) >= 0.65 - 1e-9);
  }
});

test("slope filtering computes density only over accepted faces", () => {
  const root = new THREE.Group(), flat = floor(4), wall = floor(4); wall.rotation.x = Math.PI / 2; wall.position.x = 20; root.add(flat, wall);
  const result = scatterFoliage(root, { density: 2, maxSlope: 30 });
  near(result.stats.eligibleArea, 16); assert.equal(result.instances.length, 32);
  assert.ok(result.instances.every(i => i.position[0] <= 2));
  const steep = scatterFoliage(root, { count: 20, minSlope: 80, maxSlope: 100 });
  assert.equal(steep.instances.length, 20); assert.ok(steep.instances.every(i => i.position[0] > 17));
});

test("altitude clips sloped triangle area before computing density and keeps barycentrics", () => {
  // Right triangle area = sqrt(2)/2. Cutting y >= 0.5 retains a similar
  // triangle with half the side lengths and one quarter of the area.
  const mesh = triangle([0, 0, 0, 0, 0, 1, 1, 1, 0]);
  const result = scatterFoliage(mesh, { density: 1000, minAltitude: 0.5, maxAltitude: 1, maxSlope: 90, seed: 5 });
  near(result.stats.eligibleArea, Math.SQRT2 / 8);
  assert.equal(result.instances.length, Math.floor(Math.SQRT2 / 8 * 1000));
  for (const instance of result.instances) {
    assert.ok(instance.position[1] >= 0.5 && instance.position[1] <= 1);
    near(instance.barycentric.reduce((a, b) => a + b, 0), 1);
    near(instance.position[0], instance.barycentric[2]);
  }
});

test("surface alignment maps local up onto the normal and preserves explicit upright mode", () => {
  const mesh = floor(); mesh.rotation.z = Math.PI / 4;
  for (const alignToNormal of [true, false]) {
    const result = scatterFoliage(mesh, { count: 20, alignToNormal, minScale: 0.6, maxScale: 0.9 });
    for (const instance of result.instances) {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().fromArray(instance.quaternion));
      const expected = alignToNormal ? new THREE.Vector3().fromArray(instance.normal) : new THREE.Vector3(0, 1, 0);
      assert.ok(up.distanceTo(expected) < 1e-6); assert.ok(instance.scale >= 0.6 && instance.scale <= 0.9);
    }
  }
});

test("terrain sculpt reseats existing plants without changing xz, seeds, scale or triangle identity", () => {
  const terrain = floor(10, 3), oldSurface = collectSurfaceTriangles(terrain);
  const result = scatterFoliage(oldSurface, { count: 100, seed: 29 });
  const previous = structuredClone(result.instances);
  const position = terrain.geometry.attributes.position;
  for (let i = 0; i < position.count; i++) position.setY(i, position.getX(i) * 0.2 + 3);
  position.needsUpdate = true;
  const surface = collectSurfaceTriangles(terrain);
  assert.equal(surface.topologyKey, oldSurface.topologyKey);
  const updated = reseatFoliageInstances(surface, result.instances);
  assert.equal(updated.updated, 100); assert.equal(updated.invalid, 0);
  for (let i = 0; i < result.instances.length; i++) {
    const after = result.instances[i], before = previous[i];
    near(after.position[0], before.position[0]); near(after.position[2], before.position[2]);
    near(after.position[1], after.position[0] * 0.2 + 3, 2e-7);
    assert.equal(after.seed, before.seed); assert.equal(after.scale, before.scale);
    assert.deepEqual(after.barycentric, before.barycentric); assert.equal(after.triangleIndex, before.triangleIndex);
    assert.ok(after.normal[0] < -0.19, "normal follows the newly sculpted slope");
  }
  terrain.geometry.index.needsUpdate = true;
  assert.notEqual(collectSurfaceTriangles(terrain).topologyKey, surface.topologyKey);
});

test("zero/empty/invalid inputs and population caps have explicit bounded outcomes", () => {
  assert.equal(scatterFoliage(null, { count: 10 }).instances.length, 0);
  const mesh = floor(10);
  assert.equal(scatterFoliage(mesh, { density: 0 }).instances.length, 0);
  assert.equal(scatterFoliage(mesh, { count: 10, maxInstances: 0 }).instances.length, 0);
  const capped = scatterFoliage(mesh, { count: 100000000, maxInstances: 13 });
  assert.equal(capped.instances.length, 13); assert.equal(capped.stats.capped, true);
  assert.equal(scatterFoliage(mesh, { minAltitude: 10, maxAltitude: 0 }).instances.length, 0);
  assert.equal(reseatFoliageInstances(collectSurfaceTriangles(mesh), [{ triangleIndex: 1000000 }]).invalid, 1);
});
