import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import {
  bufferGeometryFromEditable,
  beginExtrudeFaces,
  editableFromBufferGeometry,
  coplanarFaceGroup,
  cutMeshByPlane,
  extrudeFace,
  extrudeFaces,
  expandLogicalVertices,
  deleteFaces,
  geometryAssetFromEditable,
  unwrapBox,
  unwrapPlanar,
} from "../src/editor/editableGeometry.js";
import { geometryFromAsset } from "../src/engine/geometryAsset.js";

const editable = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const cornerTwins = expandLogicalVertices(editable, [0]);
assert.equal(cornerTwins.length, 3, "box corners should behave as one welded edit vertex");
const movedCorner = [...editable.positions[0]];
movedCorner[0] += 0.5;
cornerTwins.forEach((index) => { editable.positions[index] = [...movedCorner]; });
assert.ok(cornerTwins.every((index) => editable.positions[index][0] === movedCorner[0]));
const freshEditable = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
Object.assign(editable, freshEditable);
const region = coplanarFaceGroup(editable, 0);
assert.equal(region.length, 2);
const regionCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const regionVertices = regionCopy.positions.length;
const regionFaces = regionCopy.faces.length;
extrudeFaces(regionCopy, coplanarFaceGroup(regionCopy, 0), 0.25);
assert.equal(regionCopy.positions.length, regionVertices + 4);
assert.equal(regionCopy.faces.length, regionFaces + 8);
const interactiveCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const interactiveBefore = interactiveCopy.positions.map((position) => [...position]);
const interactive = beginExtrudeFaces(interactiveCopy, coplanarFaceGroup(interactiveCopy, 0));
assert.equal(interactive.vertexIndices.length, 4);
assert.ok(interactive.vertexIndices.every((index) => interactiveBefore.some((position) =>
  position.every((value, axis) => value === interactiveCopy.positions[index][axis]),
)), "interactive extrusion must begin at zero offset");
const cutCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const cut = cutMeshByPlane(cutCopy, [0, 1, 0], [0, 0, 0], 0);
assert.ok(cutCopy.faces.length > 12, "loop cut should split intersected triangles");
assert.ok(cut.vertexIndices.length >= 8, "loop cut should create a closed set of intersection vertices");
assert.ok(cut.edgeKeys.length >= 4, "loop cut should expose selectable cut edges");
const deleteCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
deleteFaces(deleteCopy, coplanarFaceGroup(deleteCopy, 0));
assert.equal(deleteCopy.faces.length, 10);
assert.ok(deleteCopy.faces.flat().every((index) => index < deleteCopy.positions.length));
const originalVertices = editable.positions.length;
const originalFaces = editable.faces.length;
extrudeFace(editable, 0, 0.25);
assert.equal(editable.positions.length, originalVertices + 3);
assert.equal(editable.faces.length, originalFaces + 6);

unwrapPlanar(editable);
assert.equal(editable.uvs.length, editable.positions.length);
assert.ok(editable.uvs.flat().every((value) => value >= 0 && value <= 1));

unwrapBox(editable);
assert.equal(editable.positions.length, editable.faces.length * 3);
assert.equal(editable.uvs.length, editable.positions.length);

const asset = geometryAssetFromEditable(editable);
const restored = geometryFromAsset(asset);
assert.equal(restored.getAttribute("position").count, editable.positions.length);
assert.equal(restored.index.count, editable.faces.length * 3);
assert.equal(bufferGeometryFromEditable(editable).index.count, restored.index.count);

assert.throws(() => geometryFromAsset({ version: 1, positions: [0, 0, 0], indices: [0, 1, 2] }), /out of range/);
console.log("geometry editor topology tests passed");
