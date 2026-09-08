/**
 * SPLITTING A GEOMETRY INTO ITS DISCONNECTED PIECES.
 *
 * An imported model routinely packs several unrelated surfaces into one mesh —
 * Sponza ships its curtains three and four to a `.geom` — and every per-object
 * decision then has to be made for the group instead of the thing: one cloth
 * component for three curtains, one collider, one enabled flag. Anything
 * DERIVED from the mesh is derived from all of them at once, which is its own
 * class of bug: a single thin curtain in a file dragged every other curtain's
 * contact radius to half what it needed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { geometryIslands, splitGeometryIslands, ISLAND_WELD_EPSILON } from "../src/engine/geometryIslands.js";

/** A flat grid in XY at `z`, offset along X, as its own connected surface. */
function quadGrid(cols = 2, rows = 2, { offsetX = 0, z = 0, size = 1 } = {}) {
  const positions = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) positions.push(offsetX + (c / cols) * size, (r / rows) * size, z);
  }
  const indices = [], at = (c, r) => r * (cols + 1) + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) indices.push(at(c, r), at(c + 1, r), at(c + 1, r + 1), at(c, r), at(c + 1, r + 1), at(c, r + 1));
  }
  return { positions, indices };
}

/** Several grids concatenated into one definition, as an importer would. */
function merged(...pieces) {
  const positions = [], indices = [];
  for (const piece of pieces) {
    const base = positions.length / 3;
    positions.push(...piece.positions);
    for (const i of piece.indices) indices.push(i + base);
  }
  return {
    version: 2,
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    uvs: Float32Array.from(Array.from({ length: (positions.length / 3) * 2 }, (_, i) => i * 0.01)),
    normals: Float32Array.from(Array.from({ length: positions.length }, (_, i) => (i % 3 === 2 ? 1 : 0))),
  };
}

test("one surface is one island", () => {
  const g = merged(quadGrid(3, 3));
  assert.equal(geometryIslands(g).count, 1);
});

test("⭐ three separate surfaces are three islands", () => {
  // Sponza's curtains, in miniature.
  const g = merged(quadGrid(2, 2), quadGrid(2, 2, { offsetX: 10 }), quadGrid(2, 2, { offsetX: 20 }));
  assert.equal(geometryIslands(g).count, 3);
});

test("⛔⛔ A UV SEAM IS NOT A SEPARATE PIECE — islands come from WELDED positions", () => {
  // THE FAULT THAT WOULD MAKE THIS FEATURE WORSE THAN USELESS. A model with UV
  // seams, split normals or per-face materials stores the SAME point several
  // times — Sponza's curtain has 7 739 vertices for 7 174 distinct positions.
  // Index connectivity would call every seam a separate piece and shatter one
  // curtain into dozens of ribbons.
  //
  // Here the grid is duplicated along its middle column: identical positions,
  // different vertex numbers, and the two halves share no INDEX at all.
  const left = quadGrid(2, 2, { size: 1 });
  const right = quadGrid(2, 2, { size: 1, offsetX: 1 });
  const g = merged(left, right);
  // The seam really is duplicated — the fixture would prove nothing otherwise.
  const seam = [];
  for (let v = 0; v < g.positions.length / 3; v++) if (Math.abs(g.positions[v * 3] - 1) < 1e-9) seam.push(v);
  assert.ok(seam.length >= 6, `expected a duplicated seam column, found ${seam.length} vertices at x = 1`);

  assert.equal(geometryIslands(g).count, 1, "the two halves meet in space and are ONE surface");
});

test("the weld epsilon is a real distance, not a hash bucket", () => {
  // A quantised key alone is not a weld: two points a fraction of an epsilon
  // apart can land either side of a cell boundary and never be compared. These
  // two grids are offset by a third of an epsilon and must still join.
  const g = merged(quadGrid(2, 2), quadGrid(2, 2, { offsetX: 1 + ISLAND_WELD_EPSILON / 3 }));
  assert.equal(geometryIslands(g).count, 1);

  // ...and a gap far wider than the epsilon must NOT join.
  const apart = merged(quadGrid(2, 2), quadGrid(2, 2, { offsetX: 1 + ISLAND_WELD_EPSILON * 1000 }));
  assert.equal(geometryIslands(apart).count, 2);
});

test("⭐ splitting produces one valid geometry per piece", () => {
  const g = merged(quadGrid(2, 2), quadGrid(3, 3, { offsetX: 10 }));
  const pieces = splitGeometryIslands(g);
  assert.equal(pieces.length, 2);
  for (const piece of pieces) {
    assert.ok(piece.positions.length % 3 === 0 && piece.positions.length > 0);
    assert.ok(piece.indices.length % 3 === 0 && piece.indices.length > 0);
    const vertices = piece.positions.length / 3;
    for (const i of piece.indices) assert.ok(i >= 0 && i < vertices, `index ${i} is outside its own piece`);
  }
  // Nothing invented and nothing lost.
  const total = pieces.reduce((n, p) => n + p.indices.length, 0);
  assert.equal(total, g.indices.length, "triangles must be partitioned, not duplicated or dropped");
});

test("⛔ each piece keeps its OWN vertices — a split that shares them has not split", () => {
  const g = merged(quadGrid(2, 2), quadGrid(2, 2, { offsetX: 10 }));
  const pieces = splitGeometryIslands(g);
  const xOf = (p) => Array.from({ length: p.positions.length / 3 }, (_, v) => p.positions[v * 3]);
  const a = xOf(pieces[0]), b = xOf(pieces[1]);
  assert.ok(Math.max(...a) < 5, `piece 0 reaches x ${Math.max(...a)} — it kept the other piece's vertices`);
  assert.ok(Math.min(...b) > 5, `piece 1 reaches x ${Math.min(...b)}`);
  assert.equal(a.length + b.length, g.positions.length / 3, "every vertex belongs to exactly one piece");
});

test("⭐ per-vertex data follows its vertex", () => {
  // UVs and normals are indexed by vertex; a split that remaps positions and
  // forgets them produces a piece that renders with someone else's texture
  // coordinates.
  const g = merged(quadGrid(2, 2), quadGrid(2, 2, { offsetX: 10 }));
  const pieces = splitGeometryIslands(g);
  let seen = 0;
  for (const piece of pieces) {
    assert.equal(piece.uvs.length, (piece.positions.length / 3) * 2);
    assert.equal(piece.normals.length, piece.positions.length);
    for (let v = 0; v < piece.positions.length / 3; v++) {
      // Find this vertex in the source by position, then compare its UV.
      let source = -1;
      for (let s = 0; s < g.positions.length / 3; s++) {
        if (Math.abs(g.positions[s * 3] - piece.positions[v * 3]) < 1e-9
          && Math.abs(g.positions[s * 3 + 1] - piece.positions[v * 3 + 1]) < 1e-9
          && Math.abs(g.positions[s * 3 + 2] - piece.positions[v * 3 + 2]) < 1e-9) { source = s; break; }
      }
      assert.ok(source >= 0, "a split vertex has no counterpart in the source");
      assert.ok(Math.abs(piece.uvs[v * 2] - g.uvs[source * 2]) < 1e-6, "UV did not follow its vertex");
      seen++;
    }
  }
  assert.ok(seen > 10);
});

test("⭐ multi-material groups survive as per-piece groups", () => {
  // A mesh with several material slots must not collapse to one on the way
  // through, or every split piece renders in the wrong material.
  const g = merged(quadGrid(2, 2), quadGrid(2, 2, { offsetX: 10 }));
  const half = g.indices.length / 2;
  g.groups = [
    { start: 0, count: half, materialIndex: 0 },
    { start: half, count: half, materialIndex: 3 },
  ];
  const pieces = splitGeometryIslands(g);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces[0].groups.map((x) => x.materialIndex), [0]);
  assert.deepEqual(pieces[1].groups.map((x) => x.materialIndex), [3]);
  for (const piece of pieces) {
    const covered = piece.groups.reduce((n, x) => n + x.count, 0);
    assert.equal(covered, piece.indices.length, "a group set must cover exactly its own piece");
  }
});

test("a single-piece geometry still returns one definition, not zero", () => {
  // So a caller never needs a special case — `geometryIslands().count` is the
  // cheap way to ask whether splitting is worth doing.
  const g = merged(quadGrid(3, 3));
  const pieces = splitGeometryIslands(g);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].indices.length, g.indices.length);
});

test("⚠ edit-mode topology is dropped, and says so", () => {
  // `editMesh`, `edges` and `hiddenEdges` are indexed against the ORIGINAL
  // vertex numbering. Remapping them is a separate job and getting it subtly
  // wrong corrupts a mesh the moment someone opens Edit Mode; losing them costs
  // a re-derive, which the editor already does for any imported mesh.
  const g = merged(quadGrid(2, 2), quadGrid(2, 2, { offsetX: 10 }));
  g.editMesh = { polygons: [[0, 1, 2, 3]] };
  g.edges = Uint32Array.from([0, 1, 1, 2]);
  const pieces = splitGeometryIslands(g);
  for (const piece of pieces) {
    assert.equal(piece.editMesh ?? null, null, "stale edit topology must not be carried over");
    assert.equal(piece.edges ?? null, null);
    assert.equal(piece.droppedEditTopology, true, "the caller must be able to tell the user");
  }
});

test("a vertex no triangle references is dropped rather than becoming a piece", () => {
  const g = merged(quadGrid(2, 2));
  const positions = Float32Array.from([...g.positions, 99, 99, 99]);
  const orphaned = { ...g, positions, uvs: Float32Array.from([...g.uvs, 0, 0]), normals: Float32Array.from([...g.normals, 0, 0, 1]) };
  assert.equal(geometryIslands(orphaned).count, 1, "a loose vertex is not a surface");
  const pieces = splitGeometryIslands(orphaned);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].positions.length / 3, g.positions.length / 3, "the orphan must not be carried into the piece");
});

test("an empty or triangle-less geometry splits into nothing", () => {
  assert.deepEqual(splitGeometryIslands({ positions: new Float32Array(0), indices: new Uint32Array(0) }), []);
  assert.equal(geometryIslands({}).count, 0);
});
