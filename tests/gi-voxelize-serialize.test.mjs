import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three/webgpu";

import { serializeMeshForBake } from "../src/modules/gi/voxelizeOnce.js";

function makeMesh() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([
    0, 0,
    1, 0,
    0, 1,
  ]), 2));
  return new THREE.Mesh(geometry);
}

const serialize = (mesh) => serializeMeshForBake(mesh, { geometryOnly: true });

test("serializeMeshForBake cache invalidates position, index, and UV edits independently", () => {
  const mesh = makeMesh();
  const first = serialize(mesh);
  const stable = serialize(mesh);
  assert.equal(stable.geometryKey, first.geometryKey);
  assert.equal(stable.positions, first.positions);
  assert.equal(stable.index, first.index);
  assert.equal(stable.uvs, first.uvs);

  mesh.geometry.index.setX(1, 2);
  mesh.geometry.index.needsUpdate = true;
  const indexEdited = serialize(mesh);
  assert.notEqual(indexEdited.geometryKey, stable.geometryKey);
  assert.deepEqual([...indexEdited.index], [0, 2, 2]);

  mesh.geometry.attributes.uv.setXY(2, 0.25, 0.75);
  mesh.geometry.attributes.uv.needsUpdate = true;
  const uvEdited = serialize(mesh);
  assert.notEqual(uvEdited.geometryKey, indexEdited.geometryKey);
  assert.deepEqual([...uvEdited.uvs], [0, 0, 1, 0, 0.25, 0.75]);
  assert.deepEqual([...indexEdited.uvs], [0, 0, 1, 0, 0, 1], "the prior copied UV record stays immutable");

  mesh.geometry.attributes.position.setXYZ(2, 0, 2, 0);
  mesh.geometry.attributes.position.needsUpdate = true;
  const positionEdited = serialize(mesh);
  assert.notEqual(positionEdited.geometryKey, uvEdited.geometryKey);
  assert.equal(positionEdited.positions[7], 2);
});

test("serializeMeshForBake cache invalidates same-version attribute replacements", () => {
  const mesh = makeMesh();
  const first = serialize(mesh);

  const position = new THREE.BufferAttribute(new Float32Array([
    5, 0, 0,
    6, 0, 0,
    5, 1, 0,
  ]), 3);
  assert.equal(position.version, mesh.geometry.attributes.position.version);
  mesh.geometry.setAttribute("position", position);
  const positionReplaced = serialize(mesh);
  assert.notEqual(positionReplaced.geometryKey, first.geometryKey);
  assert.equal(positionReplaced.positions, position.array);
  assert.equal(positionReplaced.positions[0], 5);

  const index = new THREE.BufferAttribute(new Uint16Array([2, 1, 0]), 1);
  assert.equal(index.version, mesh.geometry.index.version);
  mesh.geometry.setIndex(index);
  const indexReplaced = serialize(mesh);
  assert.notEqual(indexReplaced.geometryKey, positionReplaced.geometryKey);
  assert.equal(indexReplaced.index, index.array);
  assert.deepEqual([...indexReplaced.index], [2, 1, 0]);

  const uv = new THREE.BufferAttribute(new Float32Array([
    0.5, 0.5,
    0.75, 0.5,
    0.5, 0.75,
  ]), 2);
  assert.equal(uv.version, mesh.geometry.attributes.uv.version);
  mesh.geometry.setAttribute("uv", uv);
  const uvReplaced = serialize(mesh);
  assert.notEqual(uvReplaced.geometryKey, indexReplaced.geometryKey);
  assert.deepEqual([...uvReplaced.uvs], [...uv.array]);
});

test("serializeMeshForBake cache invalidates backing-array and optional-attribute shape changes", () => {
  const mesh = makeMesh();
  const first = serialize(mesh);

  const position = mesh.geometry.attributes.position;
  position.array = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 1, 0,
  ]);
  position.count = 4;
  const reshaped = serialize(mesh);
  assert.notEqual(reshaped.geometryKey, first.geometryKey);
  assert.equal(reshaped.positions, position.array);
  assert.equal(reshaped.positions.length, 12);
  assert.equal(reshaped.uvs, null, "a now-short UV attribute must not reuse the old three-vertex copy");

  mesh.geometry.deleteAttribute("uv");
  mesh.geometry.setIndex(null);
  const attributesRemoved = serialize(mesh);
  assert.notEqual(attributesRemoved.geometryKey, reshaped.geometryKey);
  assert.equal(attributesRemoved.index, null);
  assert.equal(attributesRemoved.uvs, null);

  mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1,
  ]), 2));
  const uvAdded = serialize(mesh);
  assert.notEqual(uvAdded.geometryKey, attributesRemoved.geometryKey);
  assert.deepEqual([...uvAdded.uvs], [0, 0, 1, 0, 1, 1, 0, 1]);
});
