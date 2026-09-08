/**
 * WHICH MESHES CAN BE CLOTH, AND WHAT THE SOLVER GETS WHEN THEY CAN.
 *
 * The cloth solver was a grid — an unrolled twelve-neighbour stencil with rest
 * lengths folded into the shader as constants — so it could only simulate a
 * plane it generated itself. `clothMeshTopology.js` is the CPU half of draping
 * a mesh the author already has: *"we take a model of a boat with sails, and we
 * want to turn sails into cloth"*, while skipping the ones that make no sense,
 * *"like a human model"* (user, 2026-09-07).
 *
 * Everything here is arithmetic on typed arrays, which is the point: the rule
 * for "is this cloth-shaped" will be argued with, and it should be arguable
 * against numbers rather than against a screenshot. The real Sponza assets the
 * thresholds were set from are quoted in the cases that use them.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { analyseClothMesh, clothPinFlags, principalExtents, pinnedPerIsland, CLOTH_THINNESS_LIMIT, packClothTopology, SPRING_END, SPRING_THICKNESS, clothContactRadiusLimit, collapseShellToMidSurface, shellOffsets } from "../src/engine/vfx/clothMeshTopology.js";

/** A flat w x h sheet of quads in the XY plane, hanging down from y = h. */
function sheet(w, h, cols = 4, rows = 4, { z = 0, offsetX = 0 } = {}) {
  const positions = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) positions.push(offsetX + (c / cols) * w, (r / rows) * h, z);
  }
  const indices = [];
  const at = (c, r) => r * (cols + 1) + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      indices.push(at(c, r), at(c + 1, r), at(c + 1, r + 1));
      indices.push(at(c, r), at(c + 1, r + 1), at(c, r + 1));
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A solid box: eight corners, twelve triangles. */
function box(size = 1) {
  const s = size / 2;
  const positions = Float32Array.from([
    -s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s,
    -s, -s, s, s, -s, s, s, s, s, -s, s, s,
  ]);
  const indices = Uint32Array.from([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]);
  return { positions, indices };
}

/**
 * ⚠ THE PRE-COLLAPSE ANALYSIS, WHICH IS WHAT THESE TESTS ARE ABOUT.
 *
 * A shell is now collapsed onto its MID-SURFACE by default, so
 * `analyseClothMesh(shell(...))` returns the analysis of a single-surface
 * cloth: no thickness springs, no shell figure, no per-piece contact cap.
 * Every one of those readings still matters — the collapse is built ON them,
 * and it only fires when they find pairs — so the tests that describe them ask
 * for the uncollapsed pass explicitly rather than being deleted.
 */
const analyseShell = (source, options = {}) => analyseClothMesh(source, { midSurface: false, ...options });

/** The welded triangles the analysis worked from. */
function trianglesOf(analysis) {
  assert.ok(analysis.triangles, "the analysis does not expose its welded triangles");
  return analysis.triangles;
}
/** Front/back pairs, read back out of the packed thickness springs. */
function thicknessPairsOf(analysis) {
  const pairs = new Map();
  for (let v = 0; v < analysis.count; v++) {
    for (let i = analysis.offsets[v]; i < analysis.offsets[v + 1]; i++) {
      if (analysis.successor[i] !== -2) continue;
      const u = analysis.neighbours[i];
      pairs.set(v < u ? v * analysis.count + u : u * analysis.count + v, [Math.min(v, u), Math.max(v, u)]);
    }
  }
  return pairs;
}

test("principal extents ignore orientation — a rotated sheet is still flat", () => {
  // ⛔ THE REASON A BOUNDING BOX CANNOT BE THE RULER. A sail is thin along its
  // own normal, which is almost never a world axis; measured axis-aligned, a
  // sheet rotated 45° reads as a solid and this feature would reject exactly
  // the meshes it exists for.
  const flat = [];
  const turned = [];
  const c = Math.SQRT1_2;
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) / 10, y = Math.floor(i / 20) / 10;
    flat.push(x, y, 0);
    turned.push(x * c, y, x * c);          // the same sheet, rotated about Y
  }
  const a = principalExtents(Float32Array.from(flat));
  const b = principalExtents(Float32Array.from(turned));
  assert.ok(a[2] < 1e-6, `an axis-aligned sheet has no thickness, got ${a[2]}`);
  assert.ok(b[2] < 1e-6, `and neither does a rotated one, got ${b[2]}`);
  assert.ok(Math.abs(a[0] - b[0]) < 1e-5, "and its longest axis is the same length either way");
});

test("a solid box is not thin on any axis", () => {
  const e = principalExtents(box(2).positions);
  assert.ok(e[2] / e[0] > CLOTH_THINNESS_LIMIT, `a cube's thinnest axis is ${(e[2] / e[0]).toFixed(2)} of its longest`);
});

test("⛔ a solid mesh is REJECTED, with a reason an author can act on", () => {
  const result = analyseClothMesh(box(1));
  assert.equal(result.ok, false);
  assert.match(result.reason, /solid, not sheet-like/);
  assert.match(result.reason, /Separate the flat pieces/, "the message has to say what to DO, not just no");
});

test("a sheet is accepted and welded to its distinct positions", () => {
  const grid = sheet(2, 3, 4, 4);
  const result = analyseClothMesh(grid);
  assert.equal(result.ok, true, result.reason ?? "");
  assert.equal(result.count, 25, "5x5 lattice points");
  assert.equal(result.islandCount, 1);
});

test("⛔ SEAM DUPLICATES WELD, or the cloth tears along every UV seam", () => {
  // An imported mesh is split wherever a UV or normal seam runs: Sponza's
  // curtain carries 7 739 render vertices for 7 174 distinct positions. Two
  // copies of one position share no spring, so an unwelded sheet comes apart
  // on the first frame.
  const grid = sheet(2, 2, 2, 2);
  const positions = Float32Array.from([...grid.positions, ...grid.positions.slice(0, 3)]);
  const duplicate = positions.length / 3 - 1;
  const indices = Uint32Array.from([...grid.indices, duplicate, 1, 2]);

  const result = analyseClothMesh({ positions, indices });
  assert.equal(result.ok, true, result.reason ?? "");
  assert.equal(result.count, 9, "the duplicated corner is ONE particle, not two");
  assert.equal(
    result.simOf[duplicate], result.simOf[0],
    "and both render vertices map to it, so the render mesh still has its seam",
  );
});

test("the constraint graph is the mesh's own edges plus the folds across them", () => {
  // One quad, two triangles: edges 01 12 02 23 03 are structural (5), and the
  // shared diagonal 02 has vertices 1 and 3 opposite it, giving one dihedral
  // spring 13. On a grid that dihedral lands exactly where the old solver's
  // SHEAR diagonal was, which is why one construction covers both.
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  const r = analyseClothMesh({ positions, indices, }, { pinning: "none" });
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.structural, 5);
  assert.equal(r.dihedral, 1);
});

test("every spring appears in BOTH endpoints' lists", () => {
  // The solver is Jacobi: each thread corrects its own particle by looping its
  // own incident springs. A one-directional list would make half of every
  // spring invisible and the sheet would shear apart along that bias.
  const r = analyseClothMesh(sheet(2, 2, 3, 3), { pinning: "none" });
  const has = (from, to) => {
    for (let i = r.offsets[from]; i < r.offsets[from + 1]; i++) if (r.neighbours[i] === to) return true;
    return false;
  };
  let checked = 0;
  for (let v = 0; v < r.count; v++) {
    for (let i = r.offsets[v]; i < r.offsets[v + 1]; i++) {
      assert.ok(has(r.neighbours[i], v), `spring ${v}->${r.neighbours[i]} is missing its reverse`);
      checked++;
    }
  }
  assert.equal(checked, (r.structural + r.dihedral) * 2, "every spring is stored twice, once per end");
});

test("rest lengths come from the mesh, not from a cell size", () => {
  // The whole reason the grid solver could not do this: its rest lengths were
  // `Math.hypot(ox * dx, oy * dy)`, folded into the shader as constants.
  const positions = Float32Array.from([0, 0, 0, 3, 0, 0, 3, 4, 0]);
  const indices = Uint32Array.from([0, 1, 2]);
  const r = analyseClothMesh({ positions, indices }, { pinning: "none" });
  const lengthOf = (from, to) => {
    for (let i = r.offsets[from]; i < r.offsets[from + 1]; i++) if (r.neighbours[i] === to) return r.restLength[i];
    return null;
  };
  assert.ok(Math.abs(lengthOf(0, 1) - 3) < 1e-5);
  assert.ok(Math.abs(lengthOf(1, 2) - 4) < 1e-5);
  assert.ok(Math.abs(lengthOf(0, 2) - 5) < 1e-5, "the 3-4-5 hypotenuse, from the geometry itself");
});

test("separate pieces in one mesh are found and pinned SEPARATELY", () => {
  // ⚠ A boat's two sails are one geometry with two pieces at different
  // heights. Pinning "the top" globally would nail the upper sail's head and
  // let the lower one fall out of the sky. Sponza's curtain is the same shape
  // of problem: three 2.3 m drapes inside one asset.
  const low = sheet(1, 1, 2, 2, { offsetX: 0 });
  const high = sheet(1, 1, 2, 2, { offsetX: 10 });
  const shifted = Float32Array.from(high.positions);
  for (let i = 1; i < shifted.length; i += 3) shifted[i] += 5;      // lift the second piece
  const positions = Float32Array.from([...low.positions, ...shifted]);
  const offset = low.positions.length / 3;
  const indices = Uint32Array.from([...low.indices, ...Array.from(high.indices, (i) => i + offset)]);

  const r = analyseClothMesh({ positions, indices });
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.islandCount, 2);
  const { held, total } = pinnedPerIsland(r.pinned, r.island, r.islandCount);
  for (let id = 0; id < 2; id++) {
    assert.ok(held[id] > 0, `piece ${id} must be held by its OWN top edge`);
    assert.ok(held[id] < total[id], `piece ${id} must not be pinned solid`);
  }
});

test("pinning holds a thin band of the top edge, not a third of the sheet", () => {
  const r = analyseClothMesh(sheet(2, 3, 8, 8));
  const { held, total } = pinnedPerIsland(r.pinned, r.island, r.islandCount);
  assert.equal(held[0], 9, "exactly the top row of a 9-wide lattice");
  assert.ok(held[0] / total[0] < 0.2, "a pin band is an edge, not a region");
});

test("corner pinning holds only the ends of that edge", () => {
  const grid = sheet(2, 3, 8, 8);
  const r = analyseClothMesh(grid, { pinning: "corners" });
  const { held } = pinnedPerIsland(r.pinned, r.island, r.islandCount);
  assert.equal(held[0], 2, "two corners, not the whole top row");
});

test("⛔ a piece FLAT against the pinned axis is reported, not silently frozen", () => {
  // Found on Sponza's `Mesh_0_9`: a horizontal sheet has almost no Y extent,
  // so "the band near max Y" was the entire piece and it came back with all 23
  // vertices pinned — a cloth that costs frames and can never move. Widening
  // the band to the piece's overall size cured that and broke the opposite
  // case (an 11 m banner 2 m tall then pinned 36 % of itself), so the band
  // stays on the pinned axis and the flat case is DETECTED.
  const flat = sheet(2, 2, 4, 4);
  const horizontal = Float32Array.from(flat.positions);
  for (let i = 0; i < horizontal.length; i += 3) {
    const y = horizontal[i + 1];
    horizontal[i + 1] = 0;          // lay it down: all Y equal
    horizontal[i + 2] = y;
  }
  const result = analyseClothMesh({ positions: horizontal, indices: flat.indices });
  assert.equal(result.ok, false);
  assert.match(result.reason, /lies flat against the "top" axis/);
  assert.match(result.reason, /Pinning to None/, "and offers the way to simulate it anyway");
});

test("a flat piece with no pinning at all is allowed to fall free", () => {
  const flat = sheet(2, 2, 4, 4);
  const horizontal = Float32Array.from(flat.positions);
  for (let i = 0; i < horizontal.length; i += 3) { horizontal[i + 2] = horizontal[i + 1]; horizontal[i + 1] = 0; }
  const r = analyseClothMesh({ positions: horizontal, indices: flat.indices }, { pinning: "none" });
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.pinnedCount, 0);
});

test("the particle cap refuses a mesh too dense to simulate, and names the hatch", () => {
  const r = analyseClothMesh(sheet(2, 3, 40, 40), { maxParticles: 100 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /over the 100 limit/);
  assert.match(r.reason, /decimate|__clothMaxParticles/);
});

test("garbage in gives a reason, never a throw", () => {
  // This runs at component attach on whatever the author dropped in. A throw
  // here takes the scene load with it.
  for (const bad of [null, {}, { positions: new Float32Array(0) }, { positions: new Float32Array([0, 0, 0]) }]) {
    const r = analyseClothMesh(bad);
    assert.equal(r.ok, false);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  }
  const nan = analyseClothMesh({ positions: Float32Array.from([0, 0, 0, 1, NaN, 0, 1, 1, 0]), indices: Uint32Array.from([0, 1, 2]) });
  assert.equal(nan.ok, false);
  assert.match(nan.reason, /non-finite/);
});

test("shear is reported as inert rather than silently ignored", () => {
  // A triangle already resists shear through its own three edges; only a grid
  // quad needs a diagonal added. Saying so beats an inspector slider that does
  // nothing.
  const r = analyseClothMesh(sheet(2, 2, 3, 3));
  assert.ok(r.notes.some((note) => /Shear has no effect/.test(note)));
});

test("clothPinFlags is pure: the same input twice gives the same answer", () => {
  const r = analyseClothMesh(sheet(2, 3, 5, 5), { pinning: "none" });
  const a = clothPinFlags(r.rest, r.island, r.islandCount, "top");
  const b = clothPinFlags(r.rest, r.island, r.islandCount, "top");
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("the packed buffers carry every spring, terminated for the short ones", () => {
  // The GPU gets a FIXED STRIDE rather than CSR ranges, to spend one storage
  // binding instead of two — the solver is already near WebGPU's eight-per-
  // stage floor with the collider fields bound. The stride is the mesh's own
  // measured maximum, so this must be lossless; the sentinel is what lets a
  // particle below that maximum stop early.
  const analysis = analyseClothMesh(sheet(2, 3, 4, 4));
  const packed = packClothTopology(analysis);
  assert.equal(packed.stride, analysis.maxDegree);
  assert.equal(packed.rest.length, analysis.count * 4);

  let found = 0;
  for (let v = 0; v < analysis.count; v++) {
    const base = v * packed.stride * 4;
    const degree = analysis.offsets[v + 1] - analysis.offsets[v];
    for (let slot = 0; slot < degree; slot++) {
      assert.notEqual(packed.springs[base + slot * 4], SPRING_END, `particle ${v} lost spring ${slot}`);
      assert.ok(packed.springs[base + slot * 4 + 1] > 0, "every spring has a real rest length");
      found++;
    }
    // ⛔ EVERY unused slot, not just the first. A zero-filled tail is NOT
    // inert: it reads as a spring to PARTICLE 0 with a rest length of ZERO,
    // which drags the whole sheet toward one point. That shipped, and the user
    // photographed the cloth smeared into vertical threads.
    for (let pad = degree; pad < packed.stride; pad++) {
      assert.equal(packed.springs[base + pad * 4], SPRING_END, `particle ${v} slot ${pad} is live padding`);
    }
  }
  assert.equal(found, (analysis.structural + analysis.dihedral) * 2, "nothing was truncated by the stride");
});

test("the packed rest buffer carries the pin flag in w", () => {
  // One buffer instead of two: the solver reads position and pinned-ness from
  // the same fetch, which is also what removes the grid's `pinned()` predicate.
  const analysis = analyseClothMesh(sheet(2, 3, 4, 4));
  const packed = packClothTopology(analysis);
  let pinned = 0;
  for (let v = 0; v < analysis.count; v++) {
    assert.equal(packed.rest[v * 4], analysis.rest[v * 3]);
    assert.equal(packed.rest[v * 4 + 3], analysis.pinned[v] ? 1 : 0);
    pinned += packed.rest[v * 4 + 3];
  }
  assert.equal(pinned, analysis.pinnedCount);
});

test("a fan or pole is refused before it can blow the stride up", () => {
  // The stride is per-mesh, so one 200-valence pole would cost every particle
  // 200 slots. A sheet has valence around six; anything past the cap is not
  // one, and the memory guard and the shape guard are the same guard.
  const positions = [0, 0, 0];
  const indices = [];
  const spokes = 40;
  for (let i = 0; i < spokes; i++) {
    positions.push(Math.cos((i / spokes) * Math.PI * 2), Math.sin((i / spokes) * Math.PI * 2), 0);
    indices.push(0, 1 + i, 1 + ((i + 1) % spokes));
  }
  const r = analyseClothMesh({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }, { pinning: "none" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /fan or a pole/);
});

test("the fan successor reproduces the mesh's own vertex normals", () => {
  // THE POINT OF THE SPARE LANE. The old solver crossed grid neighbours;
  // a mesh has none, so each structural spring carries the next neighbour
  // around the triangle fan and the shader sums `cross(a - p, b - p)`. If the
  // ordering or the winding were wrong the normals would flip or cancel, which
  // is invisible in a unit that only checks the field exists — so this
  // reconstructs the normals and compares them with the true ones.
  const grid = sheet(2, 2, 4, 4);          // flat in XY, so every normal is +Z
  const r = analyseClothMesh(grid, { pinning: "none" });
  let checked = 0;
  for (let v = 0; v < r.count; v++) {
    const px = r.rest[v * 3], py = r.rest[v * 3 + 1], pz = r.rest[v * 3 + 2];
    let nx = 0, ny = 0, nz = 0, fans = 0;
    for (let i = r.offsets[v]; i < r.offsets[v + 1]; i++) {
      const next = r.successor[i];
      if (next < 0) continue;
      const a = r.neighbours[i];
      const ax = r.rest[a * 3] - px, ay = r.rest[a * 3 + 1] - py, az = r.rest[a * 3 + 2] - pz;
      const bx = r.rest[next * 3] - px, by = r.rest[next * 3 + 1] - py, bz = r.rest[next * 3 + 2] - pz;
      nx += ay * bz - az * by; ny += az * bx - ax * bz; nz += ax * by - ay * bx;
      fans++;
    }
    if (fans === 0) continue;
    const length = Math.hypot(nx, ny, nz);
    assert.ok(length > 1e-9, `vertex ${v} produced a zero normal from ${fans} fan triangles`);
    assert.ok(nz / length > 0.999, `vertex ${v} normal points ${(nz / length).toFixed(3)} along +Z, not +1`);
    checked++;
  }
  assert.ok(checked >= 9, `only ${checked} vertices had a usable fan`);
});

test("a boundary edge has no successor, so the fan stays open", () => {
  // A corner vertex's outermost edges close no triangle. Inventing a successor
  // there would fold a phantom triangle in from outside the sheet and tilt the
  // normal along the whole border.
  const r = analyseClothMesh(sheet(1, 1, 1, 1), { pinning: "none" });
  let open = 0;
  for (let v = 0; v < r.count; v++) {
    for (let i = r.offsets[v]; i < r.offsets[v + 1]; i++) if (r.successor[i] < 0) open++;
  }
  assert.ok(open > 0, "a 2x2 quad is all boundary — some edges must have no successor");
});

test("a dihedral spring never carries a fan successor", () => {
  // It jumps ACROSS a triangle rather than around the vertex; treating it as a
  // ring edge would fold the fan back on itself.
  const r = analyseClothMesh(sheet(2, 2, 3, 3), { pinning: "none" });
  for (let v = 0; v < r.count; v++) {
    for (let i = r.offsets[v]; i < r.offsets[v + 1]; i++) {
      if (r.weight[i] === 1) assert.equal(r.successor[i], -1, "a bend spring is not a ring edge");
    }
  }
});

/** Two parallel sheets `gap` apart, joined only around their rim — a shell. */
function shell(gap = 0.06, cols = 4, rows = 4) {
  const front = sheet(2, 2, cols, rows, { z: 0 });
  const back = sheet(2, 2, cols, rows, { z: gap });
  const offset = front.positions.length / 3;
  const positions = Float32Array.from([...front.positions, ...back.positions]);
  const indices = [...front.indices, ...Array.from(back.indices, (i) => i + offset)];
  // Stitch the rim so it is ONE closed piece, exactly as a modelled curtain is.
  const at = (c, r) => r * (cols + 1) + c;
  for (let c = 0; c < cols; c++) {
    for (const r of [0, rows]) {
      const a = at(c, r), b = at(c + 1, r);
      indices.push(a, b, b + offset, a, b + offset, a + offset);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

test("⭐ a SHELL's two faces are bound by thickness springs", () => {
  // A curtain or sail authored with thickness is a front face and a back face
  // joined only at the rim: nothing in the mesh connects them anywhere else, so
  // the layers slide apart and the cloth reads as torn. Measured on Sponza's
  // curtain, 100 % of 7 174 vertices had an unconnected partner within 11 cm,
  // and simulating without these springs let the faces drift to 0.72x their
  // rest separation (worst 1.8x). With them: mean 1.00x, worst 1.2x.
  const withSprings = analyseShell(shell(), { pinning: "none" });
  assert.equal(withSprings.ok, true, withSprings.reason ?? "");
  assert.ok(withSprings.thickness > 0, "a shell must get thickness springs");

  const without = analyseShell(shell(), { pinning: "none", thickness: false });
  assert.equal(without.thickness, 0, "and the hatch must turn them off for an A/B");
  assert.ok(
    withSprings.offsets[withSprings.count] > without.offsets[without.count],
    "the bound graph carries strictly more springs",
  );
});

test("⛔ a thickness spring joins the two FACES, never a 2-ring neighbour", () => {
  // THE WHOLE TRICK, and it only bites when the surface is finer than the shell
  // is thick — which is the normal case for a modelled curtain. Here the
  // in-plane spacing is 0.05 m and the gap is 0.08, so without the exclusion
  // the "nearest distant partner" is simply the vertex next door and every
  // binding degenerates into a duplicate of a spring that already exists:
  // the surface stiffens and the two layers stay free to drift.
  const gap = 0.08;
  const dense = shell(gap, 40, 4);          // 0.05 m apart in plane, 0.08 across
  const bound = analyseShell(dense, { pinning: "none" });
  const plain = analyseShell(dense, { pinning: "none", thickness: false });
  assert.ok(bound.thickness > 0, "the shell must get bindings at all");

  // Everything within two rings of v in the UNBOUND graph — what a binding
  // must never connect to.
  const ringOf = (v) => {
    const near = new Set([v]);
    for (let i = plain.offsets[v]; i < plain.offsets[v + 1]; i++) {
      const a = plain.neighbours[i];
      near.add(a);
      for (let j = plain.offsets[a]; j < plain.offsets[a + 1]; j++) near.add(plain.neighbours[j]);
    }
    return near;
  };
  // The springs the binding pass added: present in `bound`, absent from `plain`.
  let bindings = 0;
  for (let v = 0; v < bound.count; v++) {
    const before = new Set();
    for (let i = plain.offsets[v]; i < plain.offsets[v + 1]; i++) before.add(plain.neighbours[i]);
    const near = ringOf(v);
    for (let i = bound.offsets[v]; i < bound.offsets[v + 1]; i++) {
      const o = bound.neighbours[i];
      if (before.has(o)) continue;                       // an original spring
      assert.ok(!near.has(o), `binding ${v}->${o} joins a 2-ring neighbour`);
      // ⚠ The claim is that it CROSSES the shell, not that it is perpendicular.
      // The nearest partner outside the 2-ring is often a step or two over, so
      // the total length runs past the gap (0.128 m for a 0.08 m shell at 0.05
      // spacing) while the face separation is still exactly the thickness.
      // Asserting the length instead measured the wrong thing and failed.
      const dz = Math.abs(bound.rest[o * 3 + 2] - bound.rest[v * 3 + 2]);
      assert.ok(
        Math.abs(dz - gap) < gap * 0.5,
        `a binding should cross the ${gap} m shell, but its faces are ${dz.toFixed(3)} apart`,
      );
      bindings++;
    }
  }
  assert.ok(bindings > 0, "no bindings were added at all");
});

test("a single-layer sheet gets NO thickness springs", () => {
  // It has no opposite face. Inventing pairs on a flat sheet would staple
  // distant parts of it together and crease the drape.
  const r = analyseClothMesh(sheet(2, 3, 6, 6), { pinning: "none" });
  assert.equal(r.thickness, 0);
});

test("thickness springs stay inside their own piece", () => {
  // Two curtains 8 cm apart in one asset must not be stitched to each other.
  const a = shell(0.06);
  const b = shell(0.06);
  const shifted = Float32Array.from(b.positions);
  for (let i = 2; i < shifted.length; i += 3) shifted[i] += 0.14;   // just behind a
  const offset = a.positions.length / 3;
  const positions = Float32Array.from([...a.positions, ...shifted]);
  const indices = Uint32Array.from([...a.indices, ...Array.from(b.indices, (i) => i + offset)]);

  const r = analyseClothMesh({ positions, indices }, { pinning: "none" });
  assert.equal(r.islandCount, 2);
  for (let v = 0; v < r.count; v++) {
    for (let i = r.offsets[v]; i < r.offsets[v + 1]; i++) {
      assert.equal(r.island[r.neighbours[i]], r.island[v], "a spring may never cross pieces");
    }
  }
});

test("⛔ a thickness spring is DISTINGUISHABLE from a boundary edge", () => {
  // Both are structural (weight 0) with no fan successor, so until thickness
  // springs carried their own marker the two were identical in the buffer —
  // and the edge-CONTACT walk, which asks for structural springs to sweep
  // along, started sweeping straight through the shell to the opposite face.
  // With 8 000 collider triangles in the scene that flung particles into
  // spikes (user, 2026-09-08: "half of the cloths started getting glitched").
  const r = analyseShell(shell(0.08, 40, 4), { pinning: "none" });
  const plain = analyseShell(shell(0.08, 40, 4), { pinning: "none", thickness: false });

  let marked = 0, boundary = 0;
  for (let v = 0; v < r.count; v++) {
    const before = new Set();
    for (let i = plain.offsets[v]; i < plain.offsets[v + 1]; i++) before.add(plain.neighbours[i]);
    for (let i = r.offsets[v]; i < r.offsets[v + 1]; i++) {
      const isNew = !before.has(r.neighbours[i]);
      if (isNew) { assert.equal(r.successor[i], SPRING_THICKNESS, "every binding must be marked"); marked++; }
      else if (r.weight[i] === 0 && r.successor[i] < 0) {
        assert.equal(r.successor[i], SPRING_END, "a boundary edge stays -1, or contact would skip a real edge");
        boundary++;
      }
    }
  }
  assert.ok(marked > 0, "no bindings found");
  assert.ok(boundary > 0, "the fixture must also contain boundary edges, or this proves nothing");
});

test("the marker survives packing into the spring buffer", () => {
  // The shader reads the family from `w`; if packing dropped it the fix would
  // be inert on the GPU while every CPU check still passed.
  const r = analyseShell(shell(0.08, 12, 4), { pinning: "none" });
  const packed = packClothTopology(r);
  let seen = 0;
  for (let v = 0; v < r.count; v++) {
    const base = v * packed.stride * 4;
    for (let slot = 0; slot < packed.stride; slot++) {
      if (packed.springs[base + slot * 4] === SPRING_END) break;
      if (packed.springs[base + slot * 4 + 3] === SPRING_THICKNESS) seen++;
    }
  }
  assert.ok(seen > 0, "no thickness marker reached the packed buffer");
});

/**
 * ── THE PIN BAND FOLLOWS THE HEM ──────────────────────────────────────────
 *
 * ⛔ A FLAT BAND CANNOT HOLD A HEM THAT IS NOT FLAT. A curtain is modelled
 * DRAPED OVER ITS ROD, so its top edge is a wave. Measured on all three Sponza
 * cloths: the hem rises and falls 8.4-11.4 cm while the 2 % band of a 2.26 m
 * drape is 4.5 cm. Only the crests were held — 38 to 47 of 60 columns — and
 * every unheld column sagged away between two pinned neighbours, which is the
 * sawtooth the user photographed along the top of the curtain.
 *
 * The band is now sized from the hem's measured relief. The risk that creates
 * is the one the original code warns about — a wider band pinning a large
 * share of a piece and freezing it — so both directions are pinned here.
 */

/** A sheet whose top edge undulates by `relief`, like fabric over a rod. */
function drapedSheet(w, h, relief, cols = 40, rows = 20) {
  const positions = [], at = (c, r) => r * (cols + 1) + c;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      // The wave lives at the TOP and dies out downward, so only the hem moves.
      const t = r / rows;
      const wave = Math.sin((c / cols) * Math.PI * 6) * 0.5 + 0.5;
      positions.push((c / cols) * w, t * h - wave * relief * t, 0);
    }
  }
  const indices = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    indices.push(at(c, r), at(c + 1, r), at(c + 1, r + 1), at(c, r), at(c + 1, r + 1), at(c, r + 1));
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Is the topmost vertex of every vertical slice pinned? That IS the hem. */
function topColumnsHeld(analysis, columns = 40) {
  const { count, rest, pinned } = analysis;
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < count; v++) { const x = rest[v * 3]; if (x < lo) lo = x; if (x > hi) hi = x; }
  const top = new Array(columns).fill(-1);
  for (let v = 0; v < count; v++) {
    const c = Math.min(columns - 1, Math.floor(((rest[v * 3] - lo) / Math.max(hi - lo, 1e-9)) * columns));
    if (top[c] < 0 || rest[v * 3 + 1] > rest[top[c] * 3 + 1]) top[c] = v;
  }
  const cols = top.filter((v) => v >= 0);
  return { held: cols.filter((v) => pinned[v]).length, total: cols.length };
}

test("⛔ a curtain draped over a rod is held along its WHOLE hem", () => {
  // Sponza's relief is 11.4 cm on a 2.26 m drape — 5 %, far past the 2 % band.
  const analysis = analyseClothMesh(drapedSheet(2.3, 2.26, 0.114), "top");
  assert.ok(analysis.ok, analysis.reason);
  const { held, total } = topColumnsHeld(analysis);
  assert.equal(held, total, `only ${held} of ${total} top columns held — the rest sag into a sawtooth`);
});

test("...and a flat-topped banner keeps the tight band it had", () => {
  // THE OPPOSITE FAILURE, from this file's own history: widening the band for
  // everyone made an 11 m banner pin 36 % of itself. No relief, no widening.
  const analysis = analyseClothMesh(sheet(11, 2, 60, 12), "top");
  assert.ok(analysis.ok, analysis.reason);
  const share = analysis.pinnedCount / analysis.count;
  assert.ok(share < 0.12, `a flat banner pinned ${(share * 100).toFixed(1)} % of itself`);
  const { held, total } = topColumnsHeld(analysis, 60);
  assert.equal(held, total, "and its perfectly flat hem is still fully held");
});

test("the band is capped, so wild geometry cannot freeze a cloth", () => {
  // Relief is measured off arbitrary user geometry. A piece whose "hem"
  // wanders over most of its own height is not a hem, and pinning that much
  // would nail the cloth in place.
  const analysis = analyseClothMesh(drapedSheet(2.3, 2.26, 1.6), "top");
  assert.ok(analysis.ok, analysis.reason);
  const share = analysis.pinnedCount / analysis.count;
  assert.ok(share < 0.35, `a pathological hem pinned ${(share * 100).toFixed(1)} % of the piece`);
});

test("the relief is measured per ISLAND, not across the mesh", () => {
  // Two pieces at different heights in one asset: a draped curtain beside a
  // flat banner. Sizing the band from the pair would over-pin the banner.
  const draped = drapedSheet(2.3, 2.26, 0.114, 20, 10);
  const flat = sheet(2.3, 2.26, 20, 10, { z: 5, offsetX: 40 });
  const positions = Float32Array.from([...draped.positions, ...flat.positions]);
  const shift = draped.positions.length / 3;
  const indices = Uint32Array.from([...draped.indices, ...[...flat.indices].map((i) => i + shift)]);
  const analysis = analyseClothMesh({ positions, indices }, "top");
  assert.ok(analysis.ok, analysis.reason);
  assert.equal(analysis.islandCount, 2);

  const shareOf = (id) => {
    let members = 0, held = 0;
    for (let v = 0; v < analysis.count; v++) if (analysis.island[v] === id) { members++; if (analysis.pinned[v]) held++; }
    return held / members;
  };
  const shares = [shareOf(0), shareOf(1)].sort((a, b) => a - b);
  assert.ok(shares[0] < 0.16, `the flat piece pinned ${(shares[0] * 100).toFixed(1)} % — it borrowed the drape's relief`);
});

/**
 * ── THE CONTACT CANNOT BE THICKER THAN THE CLOTH ──────────────────────────
 *
 * ⛔⛔ A shell cloth has two faces, and a contact pushes each of them to
 * `collisionRadius` clear of the collider INDEPENDENTLY. A shell thinner than
 * `2 x radius` therefore has its near face driven straight through its far
 * one — and the thickness springs are DISTANCE-ONLY, so they are exactly as
 * satisfied with the shell inside-out. Nothing un-inverts it; the cloth is
 * left fighting itself for good. ("its like those curtains are fighting
 * themselves", user 2026-09-08, after "they get broken as well" when the
 * character walks into them.)
 *
 * Measured on Sponza at the authored 0.03 radius — a 0.06 m demand —
 * **68 % of every curtain's shell is thinner than that**, and on the thin
 * islands 68 % is under the RADIUS ALONE (median shell 0.0274 m). Every
 * curtain was one touch from inverting; the ones that looked wrong were the
 * ones the character had reached.
 */
test("⛔ a shell reports its own thickness, so contact can be bounded by it", () => {
  const analysis = analyseShell(shell(0.05, 8, 8));
  assert.ok(analysis.ok, analysis.reason);
  assert.ok(
    Math.abs(analysis.shellThickness - 0.05) < 0.006,
    `measured ${analysis.shellThickness} for a 0.05 m shell`,
  );
  assert.ok(
    clothContactRadiusLimit(analysis.shellThickness) < 0.05 / 2,
    "the limit must leave the two faces strictly apart, not merely touching",
  );
});

test("⛔ the Sponza radius really is over the limit its own cloth allows", () => {
  // The live numbers, so the regression is pinned to the scene that showed it.
  const analysis = analyseShell(shell(0.0274, 8, 8));
  assert.ok(analysis.ok, analysis.reason);
  const limit = clothContactRadiusLimit(analysis.shellThickness);
  assert.ok(limit < 0.03, `a 2.74 cm shell must cap the authored 3 cm radius, got ${limit}`);
});

test("the limit is taken where the shell is THINNEST, not at its median", () => {
  // A median lets the thin third invert while the number still looks fine.
  // This shell is 6 cm over most of its area and 1 cm along one strip.
  const base = shell(0.06, 12, 12);
  const positions = Float32Array.from(base.positions);
  const half = positions.length / 2;
  for (let i = half; i < positions.length; i += 3) {
    if (positions[i] < -0.5 + 2 * (2 / 12)) positions[i + 2] = 0.01; // pull the back face in
  }
  const analysis = analyseShell({ positions, indices: base.indices });
  assert.ok(analysis.ok, analysis.reason);
  assert.ok(
    analysis.shellThickness < 0.06,
    `the thin strip must pull the figure down from the 0.06 median, got ${analysis.shellThickness}`,
  );
});

test("a cloth with no shell keeps the radius its author asked for", () => {
  // A single-surface sheet has no second face to invert, so there is nothing
  // to protect and no reason to silently shrink the user's contact.
  const analysis = analyseClothMesh(sheet(2, 2, 8, 8), "top");
  assert.ok(analysis.ok, analysis.reason);
  assert.equal(clothContactRadiusLimit(analysis.shellThickness), Infinity);
  assert.equal(Math.min(0.03, clothContactRadiusLimit(analysis.shellThickness)), 0.03);
});

test("the cap is explained to whoever authored the radius", () => {
  // A silently ignored setting is a bug report waiting to happen.
  const analysis = analyseShell(shell(0.0274, 8, 8));
  const note = analysis.notes.find((n) => /Collision Radius is capped/.test(n));
  assert.ok(note, `no note explaining the cap: ${JSON.stringify(analysis.notes)}`);
  assert.match(note, /shell/i);
});

/**
 * ── LONG-RANGE ATTACHMENTS ────────────────────────────────────────────────
 *
 * ⛔ A Jacobi pass propagates a constraint ONE RING. Sponza's curtain is ~60
 * rings from its pinned hem to its bottom edge and the solver runs 8 passes
 * over 2 substeps, so the pin's influence physically cannot reach the hem
 * within a frame: gravity pulls every frame, the pin answers 60 frames later,
 * and the error compounds. Measured live, island 0's worst structural strain
 * went from **4.70 to 15.01 while it was being watched** — a spring at sixteen
 * times its rest length. That is divergence, and no number of passes fixes a
 * diverging solve.
 *
 * A particle can never be further from its pin than the fabric between them is
 * long. That distance is a property of the MESH, known before the first frame,
 * and enforced in one step however far away the pin is.
 */
test("⭐ every particle gets a pin and the fabric distance to it", () => {
  const analysis = analyseClothMesh(sheet(2, 2, 12, 12), "top");
  assert.ok(analysis.ok, analysis.reason);
  const { lra, count, rest, pinned } = analysis;
  assert.ok(lra, "no long-range attachment buffer");
  let attached = 0;
  for (let v = 0; v < count; v++) if (lra[v * 4 + 3] > 0) attached++;
  assert.ok(attached > count * 0.8, `only ${attached} of ${count} particles are attached to anything`);
  // A pinned particle's own distance is zero (times the slack).
  for (let v = 0; v < count; v++) if (pinned[v]) assert.ok(lra[v * 4 + 3] < 1e-6, `pinned particle ${v} has slack`);
  assert.equal(rest.length, count * 3);
});

test("⛔ the distance is GEODESIC, not straight-line", () => {
  // A straight line would let a curtain hang THROUGH a wall to reach its pin.
  // On an L-folded sheet the two differ by a wide margin, and the fabric
  // distance must be the longer one.
  // A sheet that WAVES in Z as it descends: the path along the fabric is
  // measurably longer than the line through space, while the piece stays thin
  // enough to be accepted as cloth at all (an L-fold sharp enough to make the
  // point is rejected as solid at 36 % thickness).
  const cols = 16, rows = 16, positions = [], at = (c, r) => r * (cols + 1) + c;
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const t = r / rows;
    positions.push((c / cols) * 4, 2 - t * 2, Math.sin(t * Math.PI * 1.5) * 0.25);
  }
  const indices = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    indices.push(at(c, r), at(c + 1, r), at(c + 1, r + 1), at(c, r), at(c + 1, r + 1), at(c, r + 1));
  }
  const analysis = analyseClothMesh({ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }, "top");
  assert.ok(analysis.ok, analysis.reason);
  const { lra, count, rest } = analysis;
  let checked = 0, longestGap = 0;
  for (let v = 0; v < count; v++) {
    const limit = lra[v * 4 + 3];
    if (!(limit > 0)) continue;
    const straight = Math.hypot(
      rest[v * 3] - lra[v * 4], rest[v * 3 + 1] - lra[v * 4 + 1], rest[v * 3 + 2] - lra[v * 4 + 2],
    );
    // Geodesic >= Euclidean is the invariant; a straight-line limit would let
    // a curtain hang THROUGH a wall to reach its pin.
    assert.ok(limit >= straight - 1e-4, `particle ${v}: fabric ${limit} is SHORTER than the straight line ${straight}`);
    longestGap = Math.max(longestGap, limit - straight);
    checked++;
  }
  assert.ok(checked > 100, "the fixture produced nothing to check");
  // ...and the two must actually DIFFER here, or the check above would pass
  // just as well against a straight-line implementation.
  assert.ok(longestGap > 0.02, `fabric and straight-line never diverged (max gap ${longestGap})`);
});

test("the limit admits the rest pose, so a cloth is not yanked on frame one", () => {
  // Clamping to the taut geodesic would hold every particle out on a rigid
  // string. The rest pose must satisfy the constraint everywhere.
  const analysis = analyseClothMesh(sheet(2, 2, 16, 16), "top");
  const { lra, count, rest } = analysis;
  for (let v = 0; v < count; v++) {
    const limit = lra[v * 4 + 3];
    if (!(limit > 0)) continue;
    const at = Math.hypot(
      rest[v * 3] - lra[v * 4], rest[v * 3 + 1] - lra[v * 4 + 1], rest[v * 3 + 2] - lra[v * 4 + 2],
    );
    assert.ok(at <= limit + 1e-5, `the REST pose already violates the limit at ${v}: ${at} > ${limit}`);
  }
});

test("each island attaches to its OWN pins", () => {
  // A boat's two sails are one geometry. Attaching the lower sail to the upper
  // sail's head would hoist it into the sky — the same failure the per-island
  // pinning exists to prevent.
  const a = sheet(2, 2, 8, 8);
  const b = sheet(2, 2, 8, 8, { z: 6, offsetX: 40 });
  const shift = a.positions.length / 3;
  const analysis = analyseClothMesh({
    positions: Float32Array.from([...a.positions, ...b.positions]),
    indices: Uint32Array.from([...a.indices, ...[...b.indices].map((i) => i + shift)]),
  }, "top");
  assert.ok(analysis.ok, analysis.reason);
  assert.equal(analysis.islandCount, 2);
  for (let v = 0; v < analysis.count; v++) {
    if (!(analysis.lra[v * 4 + 3] > 0)) continue;
    // The pin it was given must be within its own island's X range, and the
    // two islands are 40 m apart, so a cross-island pin is unmissable.
    const dx = Math.abs(analysis.rest[v * 3] - analysis.lra[v * 4]);
    assert.ok(dx < 20, `particle ${v} attached across the island gap (dx ${dx})`);
  }
});

test("an unpinned cloth attaches to nothing rather than to particle zero", () => {
  // The sentinel matters: w = 0 is what the solver reads as "no constraint".
  // A cloth with no pins that attached to vertex 0 would collapse to a point.
  const analysis = analyseClothMesh(sheet(2, 2, 8, 8), { pinning: "none" });
  assert.ok(analysis.ok, analysis.reason);
  for (let v = 0; v < analysis.count; v++) {
    assert.equal(analysis.lra[v * 4 + 3], 0, `particle ${v} was attached despite no pinning`);
  }
});

test("⛔ the limit is TIGHT — a slack attachment constrains nothing", () => {
  // Structure alone is not enough: every check above passes just as happily
  // with the limit set to a billion, and so would a cloth that still stretches
  // to sixteen times its rest length. The limit has to actually BIND.
  //
  // On a flat 2 m sheet pinned along its top edge, the fabric distance from a
  // bottom-row vertex to its pin is the sheet's own height.
  const analysis = analyseClothMesh(sheet(2, 2, 16, 16), "top");
  assert.ok(analysis.ok, analysis.reason);
  const { lra, count, rest } = analysis;
  let deepest = 0, limitThere = 0;
  for (let v = 0; v < count; v++) {
    const depth = 2 - rest[v * 3 + 1];
    if (depth > deepest) { deepest = depth; limitThere = lra[v * 4 + 3]; }
  }
  assert.ok(deepest > 1.9, `the fixture has no bottom row (deepest ${deepest})`);
  assert.ok(
    limitThere > deepest * 0.99 && limitThere < deepest * 1.1,
    `the bottom row's limit is ${limitThere} for ${deepest} m of fabric — it must hug the geodesic, `
      + "not float above it where it can never engage",
  );
});

test("⛔⛔ the fabric distance walks STRUCTURAL edges only", () => {
  // THE REGRESSION, and it was worse than having no constraint at all.
  //
  // The merged spring graph also carries BEND springs (spanning two rings) and
  // THICKNESS springs (jumping through the shell to the far face). Both are
  // SHORTCUTS. Running Dijkstra over them lets the "fabric distance" cut
  // corners across the folds, so the limit comes out SHORTER than the cloth
  // really is — and a limit shorter than the rest pose does not restrain the
  // cloth, it PULLS it. Live result when the filter was missing: all three
  // Sponza islands hoisted to a centre height of 2.56-2.66 m against 1.11 m
  // hanging correctly, each squashed to 0.96 m of a 2.26 m drop.
  //
  // The invariant that catches it: a cloth's OWN REST POSE must satisfy the
  // limit everywhere. A folded sheet is where it bites, because that is where
  // a two-ring shortcut differs most from the fabric.
  const analysis = analyseClothMesh(drapedSheet(2.3, 2.26, 0.114, 30, 30), "top");
  assert.ok(analysis.ok, analysis.reason);
  const { lra, count, rest } = analysis;
  let violations = 0, worst = 0;
  for (let v = 0; v < count; v++) {
    const limit = lra[v * 4 + 3];
    if (!(limit > 0)) continue;
    const at = Math.hypot(
      rest[v * 3] - lra[v * 4], rest[v * 3 + 1] - lra[v * 4 + 1], rest[v * 3 + 2] - lra[v * 4 + 2],
    );
    if (at > limit + 1e-5) { violations++; worst = Math.max(worst, at / limit); }
  }
  assert.equal(violations, 0, `${violations} rest vertices are already outside their own limit (worst ${worst.toFixed(3)}x) — the cloth would be pulled in`);
});

/**
 * ── ONE CURTAIN MUST NOT SPEAK FOR ANOTHER ────────────────────────────────
 *
 * ⛔ THE USER FOUND THIS FROM THE OUTSIDE: *"this issue is related to the fact
 * that both curtains sit on the same geometry. One works well, another one
 * does not."* They were right, and this is the instance.
 *
 * Shell thickness is a property of ONE PIECE OF CLOTH, and a `.geom` holds
 * several — Sponza's curtain file carries a 5.47 cm shell and a 2.74 cm shell
 * in the same asset. Reducing it over the FILE gave every curtain the thinnest
 * one's number, so two curtains that could safely carry a 2.19 cm contact were
 * capped at 1.09 cm because of a different curtain somewhere else in the file.
 *
 * The general rule this pins: any quantity describing A CLOTH is reduced over
 * that cloth's own island, never over the asset.
 */
test("⛔ a thin piece does not drag its neighbours' contact radius down", () => {
  const thick = shell(0.06, 8, 8);
  const thin = shell(0.012, 8, 8);
  // Move the thin one far away so they are unmistakably separate pieces.
  const moved = Float32Array.from(thin.positions);
  for (let i = 0; i < moved.length; i += 3) moved[i] += 40;
  const shift = thick.positions.length / 3;
  const analysis = analyseShell({
    positions: Float32Array.from([...thick.positions, ...moved]),
    indices: Uint32Array.from([...thick.indices, ...[...thin.indices].map((i) => i + shift)]),
  });
  assert.ok(analysis.ok, analysis.reason);
  assert.equal(analysis.islandCount, 2);

  // Each island's own shell, and the per-particle caps that follow from it.
  const shells = analysis.islandShell.slice().sort((a, b) => a - b);
  assert.ok(shells[0] < 0.02, `the thin piece measured ${shells[0]}`);
  assert.ok(shells[1] > 0.04, `the thick piece measured ${shells[1]}`);

  const capOf = (id) => {
    for (let v = 0; v < analysis.count; v++) if (analysis.island[v] === id) return analysis.contactRadius[v];
    return null;
  };
  const caps = [capOf(0), capOf(1)].sort((a, b) => a - b);
  assert.ok(
    caps[1] > caps[0] * 2,
    `both pieces were capped at nearly the same radius (${caps[0]}, ${caps[1]}) — the thin one is speaking for the thick one`,
  );
  assert.ok(caps[1] > 0.02, `the THICK piece must keep its own larger radius, got ${caps[1]}`);
});

test("every particle carries the cap of its OWN island", () => {
  const a = shell(0.06, 6, 6);
  const b = shell(0.012, 6, 6);
  const moved = Float32Array.from(b.positions);
  for (let i = 0; i < moved.length; i += 3) moved[i] += 40;
  const shift = a.positions.length / 3;
  const analysis = analyseShell({
    positions: Float32Array.from([...a.positions, ...moved]),
    indices: Uint32Array.from([...a.indices, ...[...b.indices].map((i) => i + shift)]),
  });
  assert.ok(analysis.ok, analysis.reason);
  assert.equal(analysis.contactRadius.length, analysis.count);
  for (let v = 0; v < analysis.count; v++) {
    const expected = clothContactRadiusLimit(analysis.islandShell[analysis.island[v]]);
    const got = analysis.contactRadius[v];
    assert.ok(Math.abs(got - (Number.isFinite(expected) ? expected : 0)) < 1e-6,
      `particle ${v} in island ${analysis.island[v]} got ${got}, its island allows ${expected}`);
  }
});

test("a single-piece cloth is unaffected by the change", () => {
  const analysis = analyseShell(shell(0.05, 8, 8));
  assert.ok(analysis.ok, analysis.reason);
  assert.equal(analysis.islandCount, 1);
  const cap = clothContactRadiusLimit(analysis.islandShell[0]);
  for (let v = 0; v < analysis.count; v++) assert.ok(Math.abs(analysis.contactRadius[v] - cap) < 1e-6);
});

/**
 * ── STRAIN LIMITING, TESTED AS SOLVER BEHAVIOUR ───────────────────────────
 *
 * ⛔ THE LESSON THAT FORCED THIS FILE TO GROW A SOLVER. Long-range attachments
 * shipped with five passing tests and hoisted every curtain in the scene: the
 * tests checked the ANALYSIS — geodesic distances, per-island pins, a tight
 * limit — and nothing about what the solver DID with it. A claim about solver
 * behaviour needs a solver.
 *
 * `relaxPass` below mirrors `constrainMesh` in `gridSimulation.js` exactly:
 * Jacobi (read from one buffer, write to another), the soft spring correction
 * weighted by stiffness and averaged, then the hard strain limit accumulated
 * separately and halved because both endpoints move in the same pass.
 */
const STIFFNESS = 0.95, BEND = 0.1;

function relaxPass(source, analysis, { maxStretch = null } = {}) {
  const { count, offsets, neighbours, restLength, weight, successor, pinned, rest } = analysis;
  const next = Float32Array.from(source);
  for (let v = 0; v < count; v++) {
    const px = source[v * 3], py = source[v * 3 + 1], pz = source[v * 3 + 2];
    let cx = 0, cy = 0, cz = 0, total = 0;
    let lx = 0, ly = 0, lz = 0, limited = 0;
    for (let i = offsets[v]; i < offsets[v + 1]; i++) {
      const u = neighbours[i], restLen = restLength[i], w = weight[i] > 0.5 ? BEND : STIFFNESS;
      const dx = source[u * 3] - px, dy = source[u * 3 + 1] - py, dz = source[u * 3 + 2] - pz;
      const len = Math.max(Math.hypot(dx, dy, dz), 1e-5);
      const k = ((len - restLen) / len) * w;
      cx += dx * k; cy += dy * k; cz += dz * k; total += w;
      // Structural edges only: weight < 0.5 and not the thickness marker.
      if (maxStretch != null && weight[i] < 0.5 && successor[i] > -1.5) {
        const excess = Math.max(0, len - restLen * maxStretch);
        if (excess > 0) { const e = excess / len; lx += dx * e; ly += dy * e; lz += dz * e; limited++; }
      }
    }
    const inv = 1 / Math.max(total, 1e-4);
    let nx = px + cx * inv, ny = py + cy * inv, nz = pz + cz * inv;
    if (limited > 0) { nx += (lx / limited) * 0.5; ny += (ly / limited) * 0.5; nz += (lz / limited) * 0.5; }
    if (pinned[v]) { nx = rest[v * 3]; ny = rest[v * 3 + 1]; nz = rest[v * 3 + 2]; }
    next[v * 3] = nx; next[v * 3 + 1] = ny; next[v * 3 + 2] = nz;
  }
  return next;
}

/** The worst structural spring, as a multiple of its own rest length. */
function worstStructuralStretch(positions, analysis) {
  const { count, offsets, neighbours, restLength, weight, successor } = analysis;
  let worst = 0;
  for (let v = 0; v < count; v++) {
    for (let i = offsets[v]; i < offsets[v + 1]; i++) {
      if (weight[i] > 0.5 || successor[i] <= -1.5) continue;
      const u = neighbours[i];
      const len = Math.hypot(
        positions[u * 3] - positions[v * 3],
        positions[u * 3 + 1] - positions[v * 3 + 1],
        positions[u * 3 + 2] - positions[v * 3 + 2],
      );
      worst = Math.max(worst, len / restLength[i]);
    }
  }
  return worst;
}

/**
 * A cloth with one particle dragged far out of place — which is exactly what a
 * BISTABLE two-sided contact leaves behind. Pushing a particle back to
 * whichever side it came from means a particle that once ended up behind a
 * wall is held there, stably, while its neighbours stay in front.
 */
function withOneParticleDragged(analysis, metres = 1.5) {
  const positions = Float32Array.from(analysis.rest);
  let victim = -1;
  for (let v = 0; v < analysis.count; v++) if (!analysis.pinned[v]) { victim = v; break; }
  positions[victim * 3 + 2] += metres;
  return { positions, victim };
}

/**
 * ⚠ THE FIXTURE HAS TO BE THE REAL FAILURE. A single particle nudged out of
 * place and then left alone is trivial — a dozen neighbours pull it home in
 * one substep, and a test built that way proves nothing (it failed exactly
 * that way first).
 *
 * The real failure HOLDS. A two-sided contact against an open trimesh wall is
 * bistable: it pushes a particle back to whichever side it came from, so one
 * that ended up behind the wall is re-pushed there every substep, for good.
 * The solver is not recovering from a nudge, it is fighting a standing one.
 */
function relaxHeld(analysis, { maxStretch = null, passes = 24, metres = 1.5 } = {}) {
  let victim = -1;
  for (let v = 0; v < analysis.count; v++) if (!analysis.pinned[v]) { victim = v; break; }
  const held = [analysis.rest[victim * 3], analysis.rest[victim * 3 + 1], analysis.rest[victim * 3 + 2] + metres];
  let positions = Float32Array.from(analysis.rest);
  for (let k = 0; k < 3; k++) positions[victim * 3 + k] = held[k];
  for (let i = 0; i < passes; i++) {
    positions = relaxPass(positions, analysis, { maxStretch });
    // Contact re-asserts the wrong side every substep. This IS the bug.
    for (let k = 0; k < 3; k++) positions[victim * 3 + k] = held[k];
  }
  return { positions, victim };
}

test("⛔ WITHOUT the limit, a contact-held particle stays torn from its neighbours", () => {
  // THE CONTROL. `stiffness` only ever removes a FRACTION of the error per
  // pass — right for the millimetres gravity adds, useless against the metres
  // a bad contact adds, and hopeless when the contact keeps re-adding them.
  const analysis = analyseClothMesh(sheet(2, 2, 12, 12), "top");
  assert.ok(analysis.ok, analysis.reason);
  const { positions } = relaxHeld(analysis);
  const worst = worstStructuralStretch(positions, analysis);
  assert.ok(worst > 3, `the tear healed on its own (${worst.toFixed(2)}x) — the fixture is too gentle to prove anything`);
});

test("⚠ the limit HELPS against a held contact, but does not reach the bound", () => {
  // ⛔ AND THE HONEST NUMBER MATTERS MORE THAN THE HOPEFUL ONE. The first
  // version of this test asserted the bound was reached (< 1.6x). It is not:
  // against a particle a contact keeps re-pushing to the wrong side, the
  // limiter settles at ~2.7x after a substep and ~1.7x after four hundred
  // passes, because the neighbour it is pulling is itself held by eleven other
  // springs. Measured, held-particle fixture, worst structural stretch:
  //
  //     passes        8      24      60     400
  //     no limit    4.69    3.63    2.91    1.98
  //     limit 1.5   4.11    2.71    2.08    1.73
  //
  // ⚠ And a TIGHTER limit is WORSE (1.2 -> 2.92, 1.05 -> 3.21 at 24 passes):
  // Jacobi divides each particle's correction by the number of VIOLATED
  // springs, so once many are violated their corrections point in different
  // directions and average into mush. That is a property of the method, not a
  // tuning mistake, and it is why this is a safety BOUND and not the fix. The
  // fix is to stop the contact holding the particle on the wrong side at all.
  const analysis = analyseClothMesh(sheet(2, 2, 12, 12), "top");
  const free = worstStructuralStretch(relaxHeld(analysis).positions, analysis);
  const bounded = worstStructuralStretch(relaxHeld(analysis, { maxStretch: 1.5 }).positions, analysis);
  assert.ok(bounded < free * 0.85, `the limit bought nothing: ${free.toFixed(2)}x -> ${bounded.toFixed(2)}x`);
  assert.ok(bounded < 3, `still ${bounded.toFixed(2)}x — worse than measured, something regressed`);
});

test("the limit leaves an intact cloth alone", () => {
  // Sponza's healthy curtain measured a worst spring of 1.30x, so the limit
  // must not touch a cloth in that condition or it becomes a stiffness knob.
  const analysis = analyseClothMesh(sheet(2, 2, 12, 12), "top");
  const rest = Float32Array.from(analysis.rest);
  const free = relaxPass(rest, analysis);
  const limited = relaxPass(rest, analysis, { maxStretch: 1.5 });
  let worst = 0;
  for (let i = 0; i < rest.length; i++) worst = Math.max(worst, Math.abs(free[i] - limited[i]));
  assert.ok(worst < 1e-6, `the limit moved an intact cloth by ${worst} m`);
});

test("⛔ the limit is LOCAL — it cannot hoist a cloth toward one point", () => {
  // THE SAFETY ARGUMENT, and the difference from `__clothLra`, which pulled
  // every particle toward its pin and lifted whole curtains off their drop.
  // A neighbour-to-neighbour projection has no attractor: with the cloth
  // hanging free and untorn, its centre of mass must not travel.
  const analysis = analyseClothMesh(sheet(2, 2, 12, 12), "top");
  let positions = Float32Array.from(analysis.rest);
  const centre = (p) => {
    let y = 0;
    for (let v = 0; v < analysis.count; v++) y += p[v * 3 + 1];
    return y / analysis.count;
  };
  const before = centre(positions);
  for (let i = 0; i < 40; i++) positions = relaxPass(positions, analysis, { maxStretch: 1.5 });
  assert.ok(
    Math.abs(centre(positions) - before) < 1e-4,
    `the cloth drifted ${(centre(positions) - before).toFixed(4)} m over 40 passes — that is what hoisted the curtains`,
  );
});

test("the limit settles and STAYS settled, rather than oscillating", () => {
  // A hard projection applied every pass is exactly what went wrong with the
  // long-range attachment. Halving it (both endpoints move) must settle.
  //
  // ⚠ Monotone decrease is the WRONG assertion and it failed here first: once
  // the worst spring is under the bound the limiter stops acting entirely, and
  // the soft springs go on redistributing, which moves the figure both ways by
  // a hundredth. What must hold is that it comes under the bound and never
  // breaks back out.
  const analysis = analyseClothMesh(sheet(2, 2, 10, 10), "top");
  let { positions } = withOneParticleDragged(analysis, 2);
  const start = worstStructuralStretch(positions, analysis);
  const worsts = [];
  for (let i = 0; i < 60; i++) {
    positions = relaxPass(positions, analysis, { maxStretch: 1.5 });
    worsts.push(worstStructuralStretch(positions, analysis));
  }
  assert.ok(worsts[0] < start, "the first pass must make progress");
  const settledAt = worsts.findIndex((w) => w < 1.5);
  assert.ok(settledAt >= 0 && settledAt < 20, `never came under the bound within 20 passes (best ${Math.min(...worsts).toFixed(3)})`);
  for (let i = settledAt; i < worsts.length; i++) {
    assert.ok(worsts[i] < 1.55, `pass ${i} broke back out to ${worsts[i].toFixed(3)} after settling`);
  }
});

test("⛔⛔ WHY STRAIN LIMITING IS OFF: a FREE-FREE pair at large stretch diverges", () => {
  // THE FIXTURE THAT WAS MISSING, and the reason a NaN reached the live scene:
  // 2 128 of 7 174 particles non-finite, a whole island reduced to its 306
  // pinned vertices.
  //
  // Every other fixture in this file HOLDS one end — that was the point, since
  // the failure being modelled is a contact re-pushing a particle. With one
  // end fixed only half the closure happens and the limiter converges neatly.
  // With BOTH ends free and `len` far past `rest * maxStretch`, the excess
  // approaches `len` itself, so each end travels half the gap, they MEET, and
  // the soft spring correction applied in the same pass carries them through
  // one another. Flip, grow, repeat.
  //
  // ⚠ A test that only exercises the case a fix was designed for will bless
  // the fix. This asserts the failure so that whoever re-enables
  // `__clothMaxStretch` has to make this pass first.
  const analysis = analyseClothMesh(sheet(2, 2, 10, 10), { pinning: "none" });
  assert.ok(analysis.ok, analysis.reason);
  let positions = Float32Array.from(analysis.rest);
  // Tear a free interior pair far apart — no pins anywhere to anchor it.
  positions[5 * 3 + 2] += 6;
  const start = worstStructuralStretch(positions, analysis);
  let worst = start;
  for (let i = 0; i < 60; i++) {
    positions = relaxPass(positions, analysis, { maxStretch: 1.5 });
    worst = worstStructuralStretch(positions, analysis);
    if (!Number.isFinite(worst) || worst > start * 2) break;
  }
  assert.ok(
    !Number.isFinite(worst) || worst > start,
    `the free-free case now converges (${start.toFixed(2)}x -> ${worst.toFixed(2)}x) — if that is a real fix, `
      + "turn `__clothMaxStretch` back on by default and delete this test",
  );
});

test("⛔⛔ NOTHING may be left thinner than twice the contact cap", () => {
  // THE INVARIANT, and the first choice of percentile broke it. The constraint
  // is `2 x radius <= shell`: every thickness spring below the chosen
  // percentile is GUARANTEED to have its two faces driven through each other,
  // and each is a permanent inside-out patch that nothing can undo.
  //
  // At the 10 % percentile Sponza's thin curtain kept 30 such springs and its
  // thick ones 142. That island measured a mean structural strain of 0.795,
  // one particle moving 1.2 m between two readbacks, and a motion coherence of
  // 0.56 against 0.96-0.99 for its healthy neighbours.
  //
  // A shell with deliberately uneven thickness, so the percentile choice bites
  // the way it does on real geometry.
  // ⚠ THE FIXTURE HAS TO PUT THE THIN PART UNDER THE PERCENTILE, and the
  // first version put it nowhere: `shell()` spans x from 0 to 2 and the strip
  // was squeezed at `x < -0.6`, so the geometry was never touched and the test
  // passed at BOTH percentiles while proving nothing. The strip must also be
  // NARROWER than the percentile being guarded against, or the percentile
  // lands inside the thin group and the cap comes out small by luck.
  const base = shell(0.06, 32, 16);
  const positions = Float32Array.from(base.positions);
  const half = positions.length / 2;
  for (let i = half; i < positions.length; i += 3) {
    if (positions[i] < 2 * (2 / 32)) positions[i + 2] = 0.012; // ~4 % of the width
  }
  const analysis = analyseShell({ positions, indices: base.indices });
  assert.ok(analysis.ok, analysis.reason);

  // Gather this island's thickness springs straight from the packed buffer.
  const { springs, stride, count } = packClothTopology(analysis);
  const lengths = [];
  for (let v = 0; v < count; v++) {
    for (let s = 0; s < stride; s++) {
      const b = (v * stride + s) * 4;
      if (springs[b] === -1) break;
      if (springs[b] >= 0 && springs[b + 3] === -2) lengths.push(springs[b + 1]);
    }
  }
  assert.ok(lengths.length > 100, "the fixture produced no shell to measure");

  const cap = analysis.contactRadius[0];
  assert.ok(cap > 0, "no cap was derived");
  const inverting = lengths.filter((d) => d < 2 * cap);
  assert.equal(
    inverting.length, 0,
    `${inverting.length} of ${lengths.length} thickness springs are thinner than 2 x the cap `
      + `(${(cap * 100).toFixed(2)} cm) — thinnest ${(Math.min(...lengths) * 100).toFixed(2)} cm`,
  );
});

/**
 * ── COLLAPSING A SHELL ONTO ITS MID-SURFACE ───────────────────────────────
 *
 * ⛔ THE GEOMETRY THAT FORCED IT. Sponza's curtains are shells 1.4-2.9 cm
 * thick built from triangles ~9 cm wide — the two faces are SIX TIMES closer
 * together than the triangles are wide. A contact pushes both faces clear of a
 * collider, so it needs `2 x radius` of thickness, and no radius is small
 * enough to be safe at 1.4 cm: the cap was already down to 0.55 cm and the
 * shell still tore (`worstShell` 19.97, mean shell strain 1.661).
 *
 * Collapsing removes the category. There is no second face left to invert.
 */
test("⭐ a shell collapses its INTERIOR to half — the rim legitimately does not", () => {
  // ⚠ THE RIM SURVIVES, AND THAT IS RIGHT. The triangles stitching front to
  // back make each rim vertex a topological NEIGHBOUR of its opposite number,
  // and `buildThicknessSprings` excludes neighbours from pairing — they are
  // already held by real mesh edges. So only the interior halves, and a small
  // fixture is dominated by its rim: an 8x8 shell goes 162 -> 115 (0.71),
  // which looks like a poor collapse and is not one. The first version of this
  // test asserted 0.62 against that fixture and failed for that reason.
  //
  // On real geometry the rim is a rounding error: Sponza's curtain has 7 174
  // vertices and a few hundred on its rims.
  const analysis = analyseShell(shell(0.05, 16, 16));
  assert.ok(analysis.ok, analysis.reason);
  const pairs = thicknessPairsOf(analysis);
  const mid = collapseShellToMidSurface(analysis.rest, analysis.count, trianglesOf(analysis), pairs);
  assert.ok(mid.collapsed > 180, `only ${mid.collapsed} pairs collapsed`);
  assert.ok(
    mid.count < analysis.count * 0.65,
    `${analysis.count} vertices became ${mid.count} — the interior should halve`,
  );

  // And the part that must be exact: every collapsed vertex is interior, so
  // the arithmetic has to close.
  assert.equal(mid.count, analysis.count - mid.collapsed, "each pair must remove exactly one particle");
});

test("⭐ the mid particle sits exactly between the two faces", () => {
  const gap = 0.05;
  const analysis = analyseShell(shell(gap, 8, 8));
  const pairs = thicknessPairsOf(analysis);
  const mid = collapseShellToMidSurface(analysis.rest, analysis.count, trianglesOf(analysis), pairs);
  let checked = 0;
  for (let v = 0; v < analysis.count; v++) {
    const u = mid.partner[v];
    if (u < 0 || u < v) continue;
    const m = mid.midOf[v];
    for (let k = 0; k < 3; k++) {
      const expected = (analysis.rest[v * 3 + k] + analysis.rest[u * 3 + k]) / 2;
      assert.ok(Math.abs(mid.rest[m * 3 + k] - expected) < 1e-6);
    }
    checked++;
  }
  assert.ok(checked > 40, "no pairs to check");
});

test("⭐ both faces are reconstructed at the right distance along the normal", () => {
  // The render mesh is rebuilt as `mid + normal * offset`, so the offsets must
  // come back as +/- half the shell thickness — equal and opposite.
  const gap = 0.05;
  const analysis = analyseShell(shell(gap, 8, 8));
  const pairs = thicknessPairsOf(analysis);
  const mid = collapseShellToMidSurface(analysis.rest, analysis.count, trianglesOf(analysis), pairs);
  const { offset } = shellOffsets(analysis.rest, analysis.count, mid.midOf, mid);
  let checked = 0;
  for (let v = 0; v < analysis.count; v++) {
    const u = mid.partner[v];
    if (u < 0 || u < v) continue;
    assert.ok(Math.abs(offset[v] + offset[u]) < 1e-4, `offsets are not opposite: ${offset[v]} and ${offset[u]}`);
    assert.ok(Math.abs(Math.abs(offset[v]) - gap / 2) < 0.006, `offset ${offset[v]} is not half of ${gap}`);
    checked++;
  }
  assert.ok(checked > 40);
});

test("⛔ only MUTUAL pairs collapse — a chain must not weld three into one", () => {
  // `buildThicknessSprings` gives each vertex its own nearest partner, which is
  // NOT symmetric: v can choose u while u chooses w. Collapsing a chain would
  // pucker the sheet.
  const analysis = analyseShell(shell(0.05, 8, 8));
  const pairs = thicknessPairsOf(analysis);
  const mid = collapseShellToMidSurface(analysis.rest, analysis.count, trianglesOf(analysis), pairs);
  const members = new Map();
  for (let v = 0; v < analysis.count; v++) members.set(mid.midOf[v], (members.get(mid.midOf[v]) ?? 0) + 1);
  for (const [id, n] of members) assert.ok(n <= 2, `mid particle ${id} absorbed ${n} vertices`);
  for (let v = 0; v < analysis.count; v++) {
    const u = mid.partner[v];
    if (u >= 0) assert.equal(mid.partner[u], v, `partner of ${v} is ${u}, but ${u}'s partner is ${mid.partner[u]}`);
  }
});

test("a single-surface sheet passes through untouched", () => {
  // No shell, nothing to collapse, and the sheet must not lose a single
  // particle to a spurious pairing.
  const analysis = analyseClothMesh(sheet(2, 2, 8, 8), "top");
  const pairs = thicknessPairsOf(analysis);
  const mid = collapseShellToMidSurface(analysis.rest, analysis.count, trianglesOf(analysis), pairs);
  assert.equal(mid.collapsed, 0, "a flat sheet has no front/back pairs to collapse");
  assert.equal(mid.count, analysis.count);
  const { offset } = shellOffsets(analysis.rest, analysis.count, mid.midOf, mid);
  for (let v = 0; v < analysis.count; v++) assert.ok(Math.abs(offset[v]) < 1e-5, `offset ${offset[v]} on a flat sheet`);
});

test("⛔ the rim triangles that stitched the faces are dropped, not left degenerate", () => {
  // Every triangle joining front to back has two corners landing on the same
  // mid particle. Kept, they would be zero-area faces feeding NaN normals into
  // the fan walk.
  const analysis = analyseShell(shell(0.05, 8, 8));
  const pairs = thicknessPairsOf(analysis);
  const mid = collapseShellToMidSurface(analysis.rest, analysis.count, trianglesOf(analysis), pairs);
  for (let t = 0; t < mid.triangles.length; t += 3) {
    const [a, b, c] = [mid.triangles[t], mid.triangles[t + 1], mid.triangles[t + 2]];
    assert.ok(a !== b && b !== c && a !== c, `degenerate triangle ${a},${b},${c} survived`);
  }
  assert.ok(mid.triangles.length > 0, "everything was dropped");
});

test("⚠ a shell collapses ONLY WHEN ASKED, and then has no shell left to invert", () => {
  // ⛔⛔ IT IS NO LONGER THE DEFAULT. The collapse only partially fuses real
  // geometry — the two faces do not correspond 1:1, so ~18 % of vertices are
  // stranded and roughly a thousand triangles survive as OVERLAPPING
  // front/back sheets. A half-fused shell is worse than an unfused one, and
  // the user photographed all three curtains failing three different ways.
  // The machinery is kept and tested behind `midSurface: true`.
  const analysis = analyseClothMesh(shell(0.05, 16, 16), { midSurface: true });
  assert.ok(analysis.ok, analysis.reason);
  assert.equal(analysis.midSurface, true, "the shell was not collapsed");

  const uncollapsed = analyseShell(shell(0.05, 16, 16));
  assert.ok(analysis.count < uncollapsed.count * 0.7, `${uncollapsed.count} -> ${analysis.count} is not a collapse`);
  // ⚠ A handful of thickness springs survive on the RIM, where the stitching
  // triangles make the two faces genuine topological neighbours; what matters
  // is that the interior shell is gone.
  assert.ok(analysis.thickness < uncollapsed.thickness * 0.1,
    `${uncollapsed.thickness} thickness springs became ${analysis.thickness} — the shell is still there`);
});

test("⭐⭐ every render vertex keeps a place to stand on the rebuilt shell", () => {
  // The render mesh is `mid + normal * offset`. One offset per RENDER vertex,
  // and both faces must come back at opposite signs or the cloth renders flat.
  const analysis = analyseClothMesh(shell(0.05, 16, 16), { midSurface: true });
  assert.ok(analysis.shellOffset, "no offsets were produced");
  assert.equal(analysis.shellOffset.length, analysis.simOf.length,
    "there must be exactly one offset per render vertex");
  let front = 0, back = 0;
  for (const o of analysis.shellOffset) { if (o > 0.015) front++; else if (o < -0.015) back++; }
  assert.ok(front > 100 && back > 100, `the two faces did not separate (${front} front, ${back} back)`);
  for (let i = 0; i < analysis.simOf.length; i++) {
    assert.ok(analysis.simOf[i] < analysis.count, `render vertex ${i} points at a particle that does not exist`);
  }
});

test("a single-surface cloth is NOT collapsed and gets no offsets", () => {
  const analysis = analyseClothMesh(sheet(2, 2, 8, 8));
  assert.ok(analysis.ok, analysis.reason);
  assert.ok(!analysis.midSurface, "a flat sheet has no shell to collapse");
  assert.equal(analysis.shellOffset ?? null, null);
});

/**
 * A shell whose two faces do NOT line up — the back face is shifted half a
 * cell across. That asymmetry is what a modelled curtain actually has, and it
 * is what makes "each vertex's nearest partner" a non-bijection, stranding a
 * minority of vertices with no partner of their own.
 *
 * ⚠ The regular `shell()` pairs PERFECTLY, so the first version of the pothole
 * test passed against the broken code and proved nothing.
 */
function unevenShell(gap = 0.05, cols = 16, rows = 16) {
  const front = sheet(2, 2, cols, rows, { z: 0 });
  const back = sheet(2, 2, cols, rows, { z: gap });
  const moved = Float32Array.from(back.positions);
  for (let i = 0; i < moved.length; i += 3) moved[i] += 1 / cols; // half a cell
  const offset = front.positions.length / 3;
  const positions = Float32Array.from([...front.positions, ...moved]);
  const indices = [...front.indices, ...Array.from(back.indices, (i) => i + offset)];
  const at = (c, r) => r * (cols + 1) + c;
  for (let c = 0; c < cols; c++) {
    for (const r of [0, rows]) {
      const a = at(c, r), b = at(c + 1, r);
      indices.push(a, b, b + offset, a, b + offset, a + offset);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

test("⛔⛔ NO INTERIOR VERTEX MAY BE LEFT SITTING ON THE MID-SURFACE", () => {
  // THE DEFECT THE USER PHOTOGRAPHED as a curtain "squashed in places" —
  // sharp vertical pleats with V-notches through the lower half.
  //
  // Each vertex nominates its own nearest partner and that is NOT symmetric,
  // so first-claim-wins strands a large minority. The first version made every
  // stranded vertex its own particle AT ITS OWN POSITION, giving it offset 0,
  // so it RENDERED on the mid-surface while every neighbour rendered a
  // half-thickness out. Measured on the real curtains: **430 of 2 306 (18.6 %),
  // none on the rim, all interior** — a 2.2 cm pothole at nearly one vertex in
  // five, scattered through the mesh.
  //
  // ⚠ Offset 0 is LEGITIMATE where the two faces genuinely meet — the fold of
  // a closed shell has no thickness there. So this counts only vertices that
  // are flat while their own NEIGHBOURS are not, which is the pothole and not
  // the fold.
  // ⚠ AND THE FIXTURE HAS TO STRAND SOMETHING. A regular grid shell pairs
  // perfectly — every vertex's nearest partner is unique and mutual — so the
  // first version of this test passed against the BROKEN code and proved
  // nothing. A real modelled shell has two faces with different vertex
  // layouts, which is what makes the nearest-partner relation asymmetric.
  const gap = 0.05;
  const source = unevenShell(gap, 16, 16);
  const analysis = analyseClothMesh(source, { midSurface: true });
  assert.ok(analysis.ok, analysis.reason);
  assert.equal(analysis.midSurface, true);

  // ⚠ AND "FLAT WHILE ALL ITS NEIGHBOURS ARE PROUD" WAS THE WRONG TEST, for
  // the opposite reason: stranded vertices CLUSTER, so each one has a flat
  // neighbour and none are counted. It scored the broken version 0 and the
  // fixed version 1 — exactly backwards. Count the defect directly instead.
  //
  // A vertex at offset ~0 is legitimate only at the FOLD, where the two faces
  // genuinely meet; on this fixture that is the stitched rim at y = 0 and
  // y = 2. Anywhere else, offset ~0 means the vertex is drawing on the
  // mid-surface while the shell around it is a half-thickness thick.
  const { shellOffset } = analysis;
  let flatInterior = 0;
  for (let v = 0; v < shellOffset.length; v++) {
    const y = source.positions[v * 3 + 1];
    if (y < 1e-4 || y > 2 - 1e-4) continue; // the fold: no thickness there
    if (Math.abs(shellOffset[v]) < gap / 4) flatInterior++;
  }
  assert.equal(
    flatInterior, 0,
    `${flatInterior} of ${shellOffset.length} interior vertices sit on the mid-surface while the shell around `
      + "them is a half-thickness thick — a step the size of the shell at each one, which reads as creasing",
  );
});

/**
 * ⛔⛔ A PIECE OF FABRIC CANNOT BE FURTHER FROM ITS ROD THAN THERE IS FABRIC.
 *
 * Nothing in the solver said so, and the consequence was the picture the user
 * sent on 2026-09-08: a character walked through a curtain and dragged it into
 * a cone several metres long out of a 2.26 m cloth. Per-spring stretch limits
 * cannot fix that — the sheet is ~50 rings tall and eight Jacobi passes move
 * information one ring per pass, so the error never reaches the pins.
 *
 * `longRangeAttachments` already computes the answer: for each particle, the
 * nearest pin and the GEODESIC length of fabric between them. Enforcing it is
 * one clamp with no extra dispatch.
 *
 * These two tests are the reason it is safe to arm by default, where the first
 * attempt (hard-assigned, eight times a substep) had to be reverted.
 */
import { longRangeAttachments } from "../src/engine/vfx/clothMeshTopology.js";

/** The cap, exactly as `constrainMesh` applies it: mixed toward, never assigned. */
function applyCap(positions, lra, pinned, relax) {
  for (let v = 0; v < positions.length / 3; v++) {
    if (pinned[v]) continue;
    const maxD = lra[v * 4 + 3];
    if (!(maxD > 0)) continue;
    const dx = positions[v * 3] - lra[v * 4];
    const dy = positions[v * 3 + 1] - lra[v * 4 + 1];
    const dz = positions[v * 3 + 2] - lra[v * 4 + 2];
    const far = Math.hypot(dx, dy, dz);
    if (far <= maxD) continue;
    const k = maxD / far;
    positions[v * 3] += ((lra[v * 4] + dx * k) - positions[v * 3]) * relax;
    positions[v * 3 + 1] += ((lra[v * 4 + 1] + dy * k) - positions[v * 3 + 1]) * relax;
    positions[v * 3 + 2] += ((lra[v * 4 + 2] + dz * k) - positions[v * 3 + 2]) * relax;
  }
}

/** A pinned strip: a column of particles, top one pinned, unit spacing. */
function strip(n = 12) {
  const rest = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) rest[v * 3 + 1] = -v;          // hangs down Y
  const offsets = new Int32Array(n + 1), neighbours = [], successor = [];
  for (let v = 0; v < n; v++) {
    offsets[v] = neighbours.length;
    if (v > 0) { neighbours.push(v - 1); successor.push(-1); }
    if (v < n - 1) { neighbours.push(v + 1); successor.push(-1); }
  }
  offsets[n] = neighbours.length;
  const pinned = new Uint8Array(n); pinned[0] = 1;
  const lra = longRangeAttachments(rest, n, offsets, Int32Array.from(neighbours), pinned,
    new Float32Array(neighbours.length), Int32Array.from(successor));
  return { rest, pinned, lra, n };
}

test("⭐⭐ THE CAP: fabric dragged past its own length is pulled back to it", () => {
  const { rest, pinned, lra, n } = strip();
  assert.ok(lra, "longRangeAttachments must produce a cap for a pinned strip");

  // Drag the free end 30 units sideways — eleven units of fabric, thirty of rope.
  const pos = new Float32Array(rest);
  pos[(n - 1) * 3] += 30;
  const reach = () => Math.hypot(pos[(n - 1) * 3] - lra[(n - 1) * 4],
    pos[(n - 1) * 3 + 1] - lra[(n - 1) * 4 + 1], pos[(n - 1) * 3 + 2] - lra[(n - 1) * 4 + 2]);
  const allowed = lra[(n - 1) * 4 + 3];
  assert.ok(reach() > allowed * 2, "the fixture must actually over-reach");

  for (let i = 0; i < 8; i++) applyCap(pos, lra, pinned, 0.5);
  assert.ok(reach() <= allowed * 1.05,
    `after one frame the tip must be back inside its fabric length: ${reach().toFixed(2)} vs ${allowed.toFixed(2)}`);
});

test("⛔ AND IT COSTS NOTHING AT REST — the reason it can be on by default", () => {
  // The first attempt was reverted for hoisting every curtain. A cloth that is
  // not over-stretched is already inside its geodesic reach, so the cap must be
  // a complete no-op on the authored pose — measured on the real Sponza
  // curtain as 0 of 2434 vertices moving, at every relaxation.
  const { rest, pinned, lra } = strip();
  for (const relax of [0.25, 0.5, 1]) {
    const pos = new Float32Array(rest);
    for (let i = 0; i < 8; i++) applyCap(pos, lra, pinned, relax);
    for (let i = 0; i < pos.length; i++) {
      assert.ok(Math.abs(pos[i] - rest[i]) < 1e-6,
        `relaxation ${relax} moved the resting cloth at index ${i} — that is the hoist that got this reverted`);
    }
  }
});
