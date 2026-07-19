import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import {
  bufferGeometryFromEditable,
  bevelEdges,
  beginExtrudeEdges,
  beginExtrudeFaces,
  beginExtrudeVertices,
  bridgeEdgeLoops,
  editableFromBufferGeometry,
  coplanarFaceGroup,
  coplanarHiddenEdges,
  cutMeshByPlane,
  cutMeshByEdgeRing,
  cutMeshByParallelPlanes,
  extrudeFace,
  extrudeFaces,
  expandLogicalVertices,
  deleteFaces,
  flipFaces,
  geometryAssetFromEditable,
  gridFillEdges,
  insetFaces,
  subdivideFaces,
  unwrapBox,
  unwrapPlanar,
  updateExtrudeUVs,
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
assert.equal(regionCopy.positions.length, regionVertices + 4 + 4 * 4,
  "a quad extrusion needs four cap vertices and four UV-seam vertices per wall");
assert.equal(regionCopy.faces.length, regionFaces + 8);
assert.equal(regionCopy.uvs.length, regionCopy.positions.length,
  "extrusion must retain one UV per render vertex");
const interactiveCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const interactiveBefore = interactiveCopy.positions.map((position) => [...position]);
const interactive = beginExtrudeFaces(interactiveCopy, coplanarFaceGroup(interactiveCopy, 0));
assert.equal(interactive.vertexIndices.length, 12,
  "interactive quad extrusion moves four cap vertices plus two UV-seam vertices per wall");
assert.ok(interactive.vertexIndices.every((index) => interactiveBefore.some((position) =>
  position.every((value, axis) => value === interactiveCopy.positions[index][axis]),
)), "interactive extrusion must begin at zero offset");
const interactiveOffset = new THREE.Vector3(...interactive.normal).multiplyScalar(0.25);
interactive.vertexIndices.forEach((index) => {
  interactiveCopy.positions[index] = new THREE.Vector3(...interactiveCopy.positions[index]).add(interactiveOffset).toArray();
});
updateExtrudeUVs(interactiveCopy, interactive);
assert.ok(interactive.walls.every(([baseA, baseB, topA, topB]) => {
  const quadUVs = [baseA, baseB, topA, topB].map((index) => interactiveCopy.uvs[index]);
  return quadUVs[1][0] > quadUVs[0][0] && quadUVs[2][1] > quadUVs[0][1];
}), "extrusion walls must receive a non-degenerate UV strip");
const edgeIdentityCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const edgeIdentityRegion = coplanarFaceGroup(edgeIdentityCopy, 0);
const edgeIdentityHiddenSpatial = coplanarHiddenEdges(edgeIdentityCopy);
const edgeIdentityHidden = new Set();
const extrusionPointKey = (point) => point.map((value) => Math.round(value * 1e5)).join(",");
edgeIdentityCopy.faces.forEach((face) => face.forEach((a, edge) => {
  const b = face[(edge + 1) % 3];
  const spatial = [extrusionPointKey(edgeIdentityCopy.positions[a]), extrusionPointKey(edgeIdentityCopy.positions[b])];
  if (edgeIdentityHiddenSpatial.has(spatial.sort().join("|"))) {
    edgeIdentityHidden.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
}));
const edgeIdentity = beginExtrudeFaces(edgeIdentityCopy, edgeIdentityRegion, edgeIdentityHidden);
const visibleCapEdges = new Set();
edgeIdentity.faceIndices.forEach((faceIndex) => {
  const face = edgeIdentityCopy.faces[faceIndex];
  face.forEach((a, edge) => {
    const b = face[(edge + 1) % 3];
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (edgeIdentity.visiblePairs.has(key)) visibleCapEdges.add(key);
  });
});
assert.equal(visibleCapEdges.size, 4,
  "extruded cap must preserve four authored quad borders while hiding its triangulation diagonal");
const cutCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const cut = cutMeshByPlane(cutCopy, [0, 1, 0], [0, 0, 0], 0);
assert.ok(cutCopy.faces.length > 12, "loop cut should split intersected triangles");
assert.ok(cut.vertexIndices.length >= 8, "loop cut should create a closed set of intersection vertices");
assert.ok(cut.edgeKeys.length >= 4, "loop cut should expose selectable cut edges");
const multiCutCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const multiCut = cutMeshByParallelPlanes(multiCutCopy, [1, 0, 0], Array.from({ length: 8 }, (_, index) => [-0.4 + index * 0.1, 0, 0]), 0);
assert.ok(multiCut.edgeKeys.length >= 32, "parallel loop cuts should expose every cut ring");
assert.ok(multiCutCopy.faces.length < 200, "parallel loop cuts should grow linearly rather than repeatedly fragmenting triangles");
// Loop cuts are edge-ring interpolation, not a camera/edge-normal plane. On a
// tapered cone every crossed longitudinal edge reaches the same local height.
const coneCopy = editableFromBufferGeometry(new THREE.CylinderGeometry(1, 0.2, 2, 16, 5, false));
const coneHidden = coplanarHiddenEdges(coneCopy);
const coneSeedFace = coneCopy.faces.find((face) => {
  const ys = face.map((index) => coneCopy.positions[index][1]);
  return Math.min(...ys) < -0.15 && Math.max(...ys) > 0.15;
});
const coneSeedPair = coneSeedFace.map((a, index) => [a, coneSeedFace[(index + 1) % 3]])
  .find(([a, b]) => Math.abs(coneCopy.positions[a][1] - coneCopy.positions[b][1]) > 0.39);
const coneCut = cutMeshByEdgeRing(
  coneCopy,
  coneSeedPair.map((index) => coneCopy.positions[index]),
  [0.25, 0.5, 0.75],
  coneHidden,
);
assert.equal(coneCut.edgeKeys.length, 16 * 3, "three cuts should traverse the full tapered quad ring");
const coneCutHeights = coneCut.edgeKeys.map((key) => key.split("|").map((point) => Number(point.split(",")[1]) / 1e5));
assert.ok(coneCutHeights.every(([a, b]) => Math.abs(a - b) < 1e-5), "tapered loop-cut edges must stay level in local geometry");
// The actual primitive cone is a triangle fan (one height segment), not the
// multi-band quad cone above. It still needs usable horizontal Ctrl+R rings.
const primitiveCone = editableFromBufferGeometry(new THREE.ConeGeometry(0.5, 1, 32));
const primitiveHidden = coplanarHiddenEdges(primitiveCone);
const primitiveSeedFace = primitiveCone.faces.find((face) => {
  const ys = face.map((index) => primitiveCone.positions[index][1]);
  return Math.min(...ys) < -0.49 && Math.max(...ys) > 0.49;
});
const primitiveSeed = primitiveSeedFace.map((a, index) => [a, primitiveSeedFace[(index + 1) % 3]])
  .find(([a, b]) => Math.abs(primitiveCone.positions[a][1] - primitiveCone.positions[b][1]) > 0.99);
const primitiveCut = cutMeshByEdgeRing(
  primitiveCone,
  primitiveSeed.map((index) => primitiveCone.positions[index]),
  [0.25, 0.5, 0.75],
  primitiveHidden,
);
assert.equal(primitiveCut.edgeKeys.length, 32 * 3, "primitive triangle-fan cone should expose every requested cut ring");
// Seed-edge direction must never flip the reconstructed quad winding. This
// was visually catastrophic under backface culling even though face counts passed.
const boxPointKey = (point) => point.map((value) => Math.round(value * 1e5)).join(",");
const boxSource = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const boxHidden = coplanarHiddenEdges(boxSource);
const boxEdges = new Map();
boxSource.faces.forEach((face) => face.forEach((a, edge) => {
  const b = face[(edge + 1) % 3];
  const key = [boxPointKey(boxSource.positions[a]), boxPointKey(boxSource.positions[b])].sort().join("|");
  if (!boxHidden.has(key)) boxEdges.set(key, [boxSource.positions[a], boxSource.positions[b]]);
}));
boxEdges.forEach((pair) => [pair, [pair[1], pair[0]]].forEach((orientedPair) => {
  const copy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
  const result = cutMeshByEdgeRing(copy, orientedPair, [0.5], coplanarHiddenEdges(copy));
  assert.equal(result.edgeKeys.length, 4, "every directed cube edge should produce a complete loop");
  copy.faces.forEach((face) => {
    const [a, b, c] = face.map((index) => new THREE.Vector3(...copy.positions[index]));
    const normal = b.clone().sub(a).cross(c.clone().sub(a));
    const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    assert.ok(normal.dot(center) >= -1e-7, "loop cut must preserve outward face winding");
  });
}));
const deleteCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
deleteFaces(deleteCopy, coplanarFaceGroup(deleteCopy, 0));
assert.equal(deleteCopy.faces.length, 10);
assert.ok(deleteCopy.faces.flat().every((index) => index < deleteCopy.positions.length));
const flipCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const flippedRegion = coplanarFaceGroup(flipCopy, 0);
const facesBeforeFlip = flipCopy.faces.map((face) => [...face]);
const faceNormal = (mesh, face) => {
  const [a, b, c] = face.map((index) => new THREE.Vector3(...mesh.positions[index]));
  return b.sub(a).cross(c.sub(a)).normalize();
};
const normalsBeforeFlip = flippedRegion.map((faceIndex) => faceNormal(flipCopy, flipCopy.faces[faceIndex]));
assert.equal(flipFaces(flipCopy, [...flippedRegion, flippedRegion[0], -1]), flippedRegion.length,
  "flipping should ignore duplicate and invalid face indices");
flippedRegion.forEach((faceIndex, index) => {
  assert.deepEqual(flipCopy.faces[faceIndex], [facesBeforeFlip[faceIndex][0], facesBeforeFlip[faceIndex][2], facesBeforeFlip[faceIndex][1]],
    "flipping a face should reverse its winding");
  assert.ok(faceNormal(flipCopy, flipCopy.faces[faceIndex]).dot(normalsBeforeFlip[index]) < -0.9999,
    "reversed winding should reverse the geometric normal");
});
const untouchedFace = flipCopy.faces.findIndex((_, faceIndex) => !flippedRegion.includes(faceIndex));
assert.deepEqual(flipCopy.faces[untouchedFace], facesBeforeFlip[untouchedFace],
  "unselected faces should keep their winding");
const vertexExtrudeCopy = {
  positions: [[0, 0, 0]], faces: [], uvs: [[0, 0]], faceMaterials: [], looseEdges: [], hiddenEdges: [],
};
const vertexExtrusion = beginExtrudeVertices(vertexExtrudeCopy, [0]);
assert.equal(vertexExtrudeCopy.positions.length, 2, "vertex extrusion should duplicate the selected vertex");
assert.deepEqual(vertexExtrudeCopy.looseEdges, [[0, 1]], "vertex extrusion should connect the source and new vertex");
assert.deepEqual(vertexExtrusion.vertexIndices, [1]);
const edgeExtrudeCopy = {
  positions: [[0, 0, 0], [1, 0, 0]], faces: [], uvs: [[0, 0], [1, 0]], faceMaterials: [], looseEdges: [[0, 1]], hiddenEdges: [],
};
const edgeExtrusion = beginExtrudeEdges(edgeExtrudeCopy, [[0, 1]]);
assert.equal(edgeExtrudeCopy.faces.length, 2, "edge extrusion should bridge the source and duplicated edge with a quad");
assert.equal(edgeExtrusion.edges.length, 1, "edge extrusion should expose the new top edge for selection");
assert.equal(edgeExtrusion.vertexIndices.length, 2, "only the new edge endpoints should move interactively");
const bridgeCopy = {
  positions: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  faces: [], uvs: [], faceMaterials: [], looseEdges: [], hiddenEdges: [],
};
const squareEdges = (offset) => Array.from({ length: 4 }, (_, index) => [offset + index, offset + ((index + 1) % 4)]);
const bridgeResult = bridgeEdgeLoops(bridgeCopy, [...squareEdges(0), ...squareEdges(4)]);
assert.equal(bridgeResult.error, undefined);
assert.equal(bridgeCopy.faces.length, 8, "bridging two four-edge loops should create four quads");
assert.equal(bridgeResult.hiddenKeys.length, 4, "each bridged quad should hide its triangulation diagonal");
const gridFillCopy = {
  positions: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0], [2, 2, 0], [1, 2, 0], [0, 2, 0], [0, 1, 0]],
  faces: [], uvs: [], faceMaterials: [], looseEdges: [], hiddenEdges: [],
};
const gridBoundary = Array.from({ length: 8 }, (_, index) => [index, (index + 1) % 8]);
const gridFillResult = gridFillEdges(gridFillCopy, gridBoundary);
assert.equal(gridFillResult.error, undefined);
assert.equal(gridFillCopy.positions.length, 9, "a 2x2 Grid Fill should create one interior vertex");
assert.equal(gridFillCopy.faces.length, 8, "a 2x2 Grid Fill should create four triangulated quads");
assert.equal(gridFillResult.hiddenKeys.length, 4, "Grid Fill should hide one diagonal per generated quad");
const bevelCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const bevelFace = bevelCopy.faces[0];
const bevelKey = [bevelCopy.positions[bevelFace[0]], bevelCopy.positions[bevelFace[1]]]
  .map((point) => point.map((value) => Math.round(value * 1e5)).join(","))
  .sort().join("|");
const bevelFaces = bevelCopy.faces.length;
assert.ok(bevelEdges(bevelCopy, [bevelKey], 0.18, 4) > 0, "a selected cube edge should bevel");
assert.ok(bevelCopy.faces.length > bevelFaces, "bevel should add a visible chamfer strip");
assert.equal(bevelCopy.uvs.length, bevelCopy.positions.length, "bevel should preserve a UV for every generated vertex");
const bevelUsedVertices = new Set(bevelCopy.faces.flat());
assert.equal(bevelUsedVertices.size, bevelCopy.positions.length, "bevel should not leave orphan vertices in the edit mesh");
const bevelEdgeUses = new Map();
const bevelPointKey = (point) => point.map((value) => Math.round(value * 1e5)).join(",");
bevelCopy.faces.forEach((face) => face.forEach((a, index) => {
  const key = [bevelPointKey(bevelCopy.positions[a]), bevelPointKey(bevelCopy.positions[face[(index + 1) % 3]])].sort().join("|");
  bevelEdgeUses.set(key, (bevelEdgeUses.get(key) ?? 0) + 1);
}));
assert.ok([...bevelEdgeUses.values()].every((uses) => uses === 2), "segmented bevel should remain manifold");
const subdivideCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const subdivideFacesBefore = subdivideCopy.faces.length;
const subdivision = subdivideFaces(subdivideCopy);
assert.ok(subdivideCopy.faces.length > subdivideFacesBefore, "whole-mesh subdivision should add faces");
assert.ok(subdivision.hiddenKeys.length > 0, "subdivision should report the triangulation edges it hides");

// Subdividing a quad must read like Blender's: a centre cross and split borders,
// with no stranded parent edge and no visible triangulation diagonal.
const visibleEdgesOf = (mesh, hidden) => {
  const keys = new Set();
  mesh.faces.forEach((face) => {
    for (let edge = 0; edge < 3; edge++) {
      keys.add([bevelPointKey(mesh.positions[face[edge]]), bevelPointKey(mesh.positions[face[(edge + 1) % 3]])].sort().join("|"));
    }
  });
  return [...keys].filter((key) => !hidden.has(key));
};
const onQuad = (key) => key.split("|").every((point) => point.startsWith("50000,"));
const quadCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const quadCut = subdivideFaces(quadCopy, coplanarFaceGroup(quadCopy, 0), coplanarHiddenEdges(quadCopy), 1);
const quadEdges = visibleEdgesOf(quadCopy, new Set(quadCut.hiddenKeys));
assert.equal(quadEdges.filter(onQuad).length, 12, "one cut on a quad should leave 8 border halves plus a 4-edge centre cross");
assert.equal(quadCut.faceIndices.length, 8, "subdivision should hand back its resulting faces so cuts can stack");

// A bent quad is no longer coplanar, but its diagonal is still an artefact: the
// hidden set is carried in, never re-derived from the geometry.
const bentCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const bentHidden = coplanarHiddenEdges(bentCopy);
expandLogicalVertices(bentCopy, [bentCopy.faces[0][0]]).forEach((index) => { bentCopy.positions[index][0] += 0.4; });
const bentCut = subdivideFaces(bentCopy, coplanarFaceGroup(bentCopy, 0).length > 1 ? [0, 1] : [0, 1], bentHidden, 1);
const bentDiagonals = visibleEdgesOf(bentCopy, new Set(bentCut.hiddenKeys))
  .filter((key) => key.split("|").every((point) => point.startsWith("50000,") || point.startsWith("90000,")));
assert.ok(!bentDiagonals.some((key) => {
  const [a, b] = key.split("|").map((point) => point.split(",").map(Number));
  return a[1] !== b[1] && a[2] !== b[2]; // a diagonal moves in both in-plane axes
}), "a bent quad must not expose its triangulation diagonal");

const gridCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const gridCut = subdivideFaces(gridCopy, coplanarFaceGroup(gridCopy, 0), coplanarHiddenEdges(gridCopy), 2);
assert.equal(visibleEdgesOf(gridCopy, new Set(gridCut.hiddenKeys)).filter(onQuad).length, 40, "two cuts should leave a 4x4 quad grid");

const insetCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
const insetResult = insetFaces(insetCopy, coplanarFaceGroup(insetCopy, 0), 0.25);
assert.equal(insetResult.length, 2, "insetting a logical quad should keep its two inner triangles selected");
assert.equal(insetResult.visibleEdgeKeys.length, 8, "a quad inset should expose its four-edge perimeter and four connecting spokes");
const insetMeshEdges = new Set(insetCopy.faces.flatMap((face) => face.map((a, edge) =>
  [bevelPointKey(insetCopy.positions[a]), bevelPointKey(insetCopy.positions[face[(edge + 1) % 3]])].sort().join("|"),
)));
assert.ok(insetResult.visibleEdgeKeys.every((key) => insetMeshEdges.has(key)), "every reported inset border must exist in the rebuilt topology");
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

const looseCopy = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
looseCopy.looseEdges.push([0, 1]);
const looseRestored = geometryFromAsset(geometryAssetFromEditable(looseCopy));
assert.deepEqual(looseRestored.userData.editableEdges, [[0, 1]], "duplicated loose edges should survive geometry autosave/reload");
const hiddenSource = editableFromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
hiddenSource.hiddenEdges = [[hiddenSource.faces[0][0], hiddenSource.faces[0][2]]];
const hiddenRoundTrip = editableFromBufferGeometry(geometryFromAsset(geometryAssetFromEditable(hiddenSource)));
assert.deepEqual(hiddenRoundTrip.hiddenEdges, hiddenSource.hiddenEdges,
  "authored subdivision visibility should survive geometry autosave/reload");

assert.throws(() => geometryFromAsset({ version: 1, positions: [0, 0, 0], indices: [0, 1, 2] }), /out of range/);
console.log("geometry editor topology tests passed");
