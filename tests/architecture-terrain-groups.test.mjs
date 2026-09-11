import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { getArchitectureTerrainGroups, translateArchitectureTerrainGroup } from "../src/modules/architecture/terrainFormGroups.js";

const form = (id, position, overrides = {}) => ({ id, shape: "box", position, size: [4, 3, 4], rotationY: 0, color: "#cda787", roof: "hip", roofHeight: 1, ...overrides });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("connected and stacked forms follow together while distant buildings remain separate", () => {
  const model = { forms: [form("main", [0, 0, 0]), form("wing", [4, 0, 0]), form("tower", [0, 3, 0]), form("other", [20, 0, 0])] };
  const groups = getArchitectureTerrainGroups(model);
  assert.deepEqual(groups.map(group => group.formIds), [["main", "tower", "wing"], ["other"]]);
  assert.equal(groups[0].key, "main");
  assert.ok(groups[0].samplesWorldXYZ.every(p => Math.abs(p[1]) < 1e-8));
  assert.ok(groups[0].samplesWorldXYZ.every(p => p[0] <= 6 && p[0] >= -2));
  assert.deepEqual(getArchitectureTerrainGroups({ forms: [...model.forms].reverse() }), groups, "group membership and keys must not depend on array order");
});

test("a wide upper form does not add its cantilever footprint to foundation samples", () => {
  const groups = getArchitectureTerrainGroups({ forms: [form("base", [0, 0, 0]), form("upper", [0, 3, 0], { size: [12, 3, 12] })] });
  assert.equal(groups.length, 1);
  assert.ok(groups[0].samplesWorldXYZ.every(([x, y, z]) => Math.abs(x) <= 2 && Math.abs(z) <= 2 && y === 0));
  assert.ok(groups[0].samplesWorldXYZ.some(([x, , z]) => x === 0 && z === 0), "central terrain hill must be sampled");
});

test("overlapping AABBs do not join disjoint rotated bodies or separated round forms", () => {
  const bars = { forms: [form("a", [0, 0, 0], { size: [10, 3, .5], rotationY: Math.PI / 4, roof: "none" }), form("b", [1, 0, 1], { size: [10, 3, .5], rotationY: Math.PI / 4, roof: "none" })] };
  assert.equal(getArchitectureTerrainGroups(bars).length, 2);
  const rounds = { forms: [form("a", [0, 0, 0], { shape: "round" }), form("b", [3.5, 0, 3.5], { shape: "round" })] };
  assert.equal(getArchitectureTerrainGroups(rounds).length, 2);
  rounds.forms[1].position = [2, 0, 2]; assert.equal(getArchitectureTerrainGroups(rounds).length, 1);
});

test("roof contact includes actual hip and cone slopes without joining clear air under their bounding boxes", () => {
  for (const shape of ["box", "round"]) {
    const base = form("base", [0, 0, 0], { shape, size: [8, 3, 8], roofHeight: 3 });
    const floating = form("tower", [3.2, 5.5, 0], { size: [.6, 2, .6], roof: "flat" });
    assert.equal(getArchitectureTerrainGroups({ forms: [base, floating] }).length, 2, `${shape}: roof bounds should not count as roof contact`);
    floating.position = [0, 5.5, 0]; assert.equal(getArchitectureTerrainGroups({ forms: [base, floating] }).length, 1);
  }
});

test("derived supports do not attach a raised independent building to a different body below it", () => {
  const groups = getArchitectureTerrainGroups({ forms: [form("lower", [0, 0, 0], { roof: "none" }), form("raised", [0, 12, 0], { roof: "none" })] });
  assert.equal(groups.length, 2); assert.equal(groups[1].baseWorldY, 12);
});

test("samples use transformed world positions and retain exact extrema for dirty-region checks", () => {
  const model = { forms: [form("tilted", [2, 1, -3], { shape: "round", size: [8, 3, 4], rotationY: .6 })] };
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(30, 7, -20), new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, .4, -.2)), new THREE.Vector3(2, .7, 1.5));
  const group = getArchitectureTerrainGroups(model, matrix)[0], inverse = matrix.clone().invert();
  for (const point of group.samplesWorldXYZ) { const local = new THREE.Vector3(...point).applyMatrix4(inverse); near(local.y, 1); }
  near(group.baseWorldY, Math.min(...group.samplesWorldXYZ.map(p => p[1])));
  assert.ok(group.samplesWorldXYZ.some(p => { const local = new THREE.Vector3(...p).applyMatrix4(inverse); return Math.abs(local.x - 2) < 1e-6 && Math.abs(local.z + 3) < 1e-6; }));
  assert.equal(group.foundationPolygonsWorldXYZ.length, 1); assert.equal(group.foundationPolygonsWorldXYZ[0].length, 24);
  for (const point of group.foundationPolygonsWorldXYZ[0]) {
    const local = new THREE.Vector3(...point).applyMatrix4(inverse); near(local.y, 1);
    local.sub(new THREE.Vector3(2, 1, -3)).applyAxisAngle(new THREE.Vector3(0, 1, 0), -.6);
    near((local.x / 4) ** 2 + (local.z / 2) ** 2, 1);
  }
});

test("foundation polygons preserve a courtyard and disconnected supports inside one connected structure", () => {
  const enclosesCenter = polygon => Math.min(...polygon.map(p => p[0])) <= 0 && Math.max(...polygon.map(p => p[0])) >= 0 && Math.min(...polygon.map(p => p[2])) <= 0 && Math.max(...polygon.map(p => p[2])) >= 0;
  const courtyard = getArchitectureTerrainGroups({ forms: [
    form("front", [0, 0, -4], { size: [10, 3, 2] }), form("back", [0, 0, 4], { size: [10, 3, 2] }),
    form("west", [-4, 0, 0], { size: [2, 3, 6] }), form("east", [4, 0, 0], { size: [2, 3, 6] }),
  ] });
  assert.equal(courtyard.length, 1); assert.equal(courtyard[0].foundationPolygonsWorldXYZ.length, 4);
  assert.ok(courtyard[0].foundationPolygonsWorldXYZ.every(polygon => !enclosesCenter(polygon)), "the courtyard must not become a rectangular foundation");
  const bridge = getArchitectureTerrainGroups({ forms: [
    form("left", [-5, 0, 0], { size: [2, 3, 2] }), form("right", [5, 0, 0], { size: [2, 3, 2] }),
    form("span", [0, 3, 0], { size: [12, 2, 2], roof: "none" }),
  ] });
  assert.equal(bridge.length, 1); assert.equal(bridge[0].foundationPolygonsWorldXYZ.length, 2);
  assert.ok(bridge[0].foundationPolygonsWorldXYZ.every(polygon => !enclosesCenter(polygon)), "ground between the supports must remain outside the foundations");
});

test("world-vertical group movement preserves shape, root transform, distant forms and authored path elevations", () => {
  const model = { version: 1, forms: [form("base", [0, 0, 0]), form("upper", [0, 3, 0]), form("distant", [20, 0, 0])],
    openings: [{ id: "door", formId: "base", position: [0, 1, -2], normal: [0, 0, -1], width: 1, height: 2, kind: "door" }, { id: "window", formId: "distant", position: [20, 2, -2] }],
    paths: [{ id: "route", points: [[0, -10], [20, -10]], elevation: .5, width: 2 }], customMetadata: { preserved: true } };
  const original = structuredClone(model), matrix = new THREE.Matrix4().compose(new THREE.Vector3(8, -2, 6), new THREE.Quaternion().setFromEuler(new THREE.Euler(.5, .7, -.2)), new THREE.Vector3(2, 1.5, .8));
  const elements = [...matrix.elements], moved = translateArchitectureTerrainGroup(model, ["base", "upper"], 4.2, matrix);
  for (let i = 0; i < 2; i++) {
    const before = new THREE.Vector3(...model.forms[i].position).applyMatrix4(matrix), after = new THREE.Vector3(...moved.forms[i].position).applyMatrix4(matrix);
    near(after.x, before.x); near(after.y, before.y + 4.2); near(after.z, before.z);
    assert.deepEqual(moved.forms[i].size, model.forms[i].size); assert.equal(moved.forms[i].roofHeight, model.forms[i].roofHeight);
  }
  const openingDelta = new THREE.Vector3(...moved.openings[0].position).sub(new THREE.Vector3(...moved.forms[0].position));
  assert.deepEqual(openingDelta.toArray(), [0, 1, -2]);
  assert.deepEqual(moved.forms[2], model.forms[2]); assert.deepEqual(moved.openings[1], model.openings[1]); assert.deepEqual(moved.paths, model.paths);
  assert.deepEqual(moved.customMetadata, model.customMetadata); assert.deepEqual(matrix.elements, elements); assert.deepEqual(model, original);
  const restored = translateArchitectureTerrainGroup(moved, ["base", "upper"], -4.2, matrix);
  restored.forms.slice(0, 2).forEach((f, i) => f.position.forEach((value, axis) => near(value, model.forms[i].position[axis])));
});

test("large models have bounded samples and invalid transforms or displacements fail before mutation", () => {
  const forms = Array.from({ length: 256 }, (_, i) => form(`form-${i.toString().padStart(3, "0")}`, [i % 16 * 10, 0, Math.floor(i / 16) * 10], { size: [10, 3, 10], roof: "none" }));
  const groups = getArchitectureTerrainGroups({ forms }); assert.equal(groups.length, 1); assert.ok(groups[0].samplesWorldXYZ.length <= 4096);
  assert.ok(groups[0].samplesWorldXYZ.some(([x, , z]) => x === 150 && z === 150), "sample cap must retain every foundation center");
  assert.throws(() => getArchitectureTerrainGroups({ forms: forms.slice(0, 1) }, new THREE.Matrix4().makeScale(0, 1, 1)), /invertible/);
  assert.throws(() => translateArchitectureTerrainGroup({ forms: [] }, [], Infinity), /finite/);
  assert.deepEqual(getArchitectureTerrainGroups({ forms: [] }), []);
});
