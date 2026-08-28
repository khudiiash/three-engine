// GI2 §AG — THE COVERAGE ESTIMATOR, PINNED ON THE CPU (`test:gi2-coverage`).
//
// ══ WHY THIS IS A NODE TEST AND NOT A PROBE ══════════════════════════════════
//
// The whole of §AG rests on one arithmetic claim: that "how much of this voxel's
// cross-section does this triangle fill" comes out ≈ 1 for a wall and ≈ 0.03 for
// a cable, at every level, from the SAME expression. That is a pure function of
// nine floats and three integers. Sending it to a GPU to find out would put a
// pipeline compile, a device, another agent's battery and a 60-minute queue
// between a one-line arithmetic error and the person who made it.
//
// So `coverageOfTriangleInVoxel` is exported from `windowVoxelize.js` as the
// CPU mirror of the kernel's `gi2Coverage`, and this file pins the four cases
// the classes were designed around. A disagreement between the mirror and the
// kernel is then a bug with a NAME (`probe:gi2-voxelize`'s class histogram
// against these numbers), not a receipt nobody can reproduce.
//
// ⚠ THE MIRROR IS NOT A SECOND IMPLEMENTATION. It is the same two terms — a
// 4 × 4 sample grid and the AABB × fill sliver floor, `max` of the two — written
// in JS. Keeping them in step is a maintenance obligation and is stated as one;
// the alternative (deriving one from the other at run time) is not available in
// a shader.
//
// Run: node scripts/run-gi2-coverage-test.mjs
import { coverageOfTriangleInVoxel, COV_SAMPLES_AXIS } from "../src/modules/gi/window/windowVoxelize.js";
import { COV_EDGES, covClassOf } from "../src/modules/gi/window/windowStore.js";

let failed = 0;
const rows = [];
const ok = (group, cond, what, detail = "") => {
  if (!cond) failed++;
  rows.push(`  ${cond ? "PASS" : "FAIL"}  ${group.padEnd(9)} ${what}${detail ? `  — ${detail}` : ""}`);
};

/**
 * The coverage a whole QUAD contributes to one voxel, which is what a real
 * surface is: two triangles sharing a diagonal. Summing them is exactly what
 * the kernel's `atomicAdd` does, and it is the only honest way to ask "is a
 * wall opaque" — the first estimator this stage tried scored each triangle's
 * fill ratio at 0.5 and made every plain wall 50 % transparent.
 */
const quadCoverage = (a, b, c, d, corner) => Math.min(1,
  coverageOfTriangleInVoxel(a, b, c, corner)
  + coverageOfTriangleInVoxel(a, c, d, corner));

// Everything below is in VOXEL SPACE — world metres divided by the level's cell
// size — because that is the space the voxelizer works in and the space the
// estimator is defined in. A "2 cm cable at v = 0.25 m" is therefore a cylinder
// 0.08 cells across, and the SAME cable at v = 4 m (level 4) is 0.005 cells.
const cellFrac = (metres, v) => metres / v;

console.log("── §AG coverage estimator (CPU mirror) ───────────────────────────");

// ══════════════════════════════════════════════════ 1. A WALL IS CLASS 3
//
// A plaster wall's triangles are METRES across; a voxel in the middle of one
// spans the whole cross-section. This is the invariant the §V.1 thin-wall gate
// rests on, and it has to hold at every level and away from the quad's diagonal
// as well as across it.
{
  const G = "wall";
  // A wall ⊥ X at x = 0.5 inside the voxel [0,1)³, as a 20-cell quad so the
  // voxel sits deep in its interior — the case the fill-ratio estimator got
  // catastrophically wrong.
  const A = [0.5, -10, -10];
  const B = [0.5, 10, -10];
  const C = [0.5, 10, 10];
  const D = [0.5, -10, 10];
  const cov = quadCoverage(A, B, C, D, [0, 0, 0]);
  ok(G, cov > 0.99, "a wall quad's interior voxel is fully covered", `cov ${cov.toFixed(3)}`);
  ok(G, covClassOf(cov) === 3, "…and therefore class 3");

  // ⭐ THE ONE THAT KILLED THE FIRST DESIGN: a voxel AWAY FROM THE DIAGONAL is
  // reached by exactly ONE of the quad's two triangles, and that triangle fills
  // half its own bounding box. A fill-RATIO estimator scores it 0.5 → class 2 →
  // a 50 % transparent wall, on every plain wall in the scene. The sample grid
  // scores it 1.0, because the question is LOCAL and a ratio is an average.
  const single = coverageOfTriangleInVoxel(A, B, C, [0, 3, 0]);
  ok(G, single > 0.99, "one triangle alone covers a voxel deep inside it",
    `cov ${single.toFixed(3)} (a fill ratio would say 0.5)`);
  // ⚠ AND ON the diagonal it is genuinely partial — 10 of 16 samples — which is
  // why the pack SUMS the quad's two triangles rather than taking a max over
  // them. Stated as a property, because a reader who saw only the number above
  // would think one triangle is always enough.
  const onDiag = coverageOfTriangleInVoxel(A, B, C, [0, 0, 0]);
  ok(G, onDiag > 0.5 && onDiag < 0.8, "…and is partial ON the shared diagonal",
    `cov ${onDiag.toFixed(3)}, the other triangle supplies the rest`);

  // Every level: the wall is huge in cell units at v = 0.25 and still huge at
  // v = 4, so the answer must not move.
  for (const v of [0.25, 0.5, 1, 2, 4]) {
    const s = 10 / v;
    const q = quadCoverage([0.5, -s, -s], [0.5, s, -s], [0.5, s, s], [0.5, -s, s], [0, 0, 0]);
    ok(G, covClassOf(q) === 3, `class 3 at v = ${v} m`, `cov ${q.toFixed(3)}`);
  }

  // A wall CROSSING the voxel at an angle is still a surface.
  const tilt = quadCoverage([0.2, -10, -10], [0.2, 10, -10], [0.9, 10, 10], [0.9, -10, 10], [0, 0, 0]);
  ok(G, covClassOf(tilt) === 3, "a wall crossing the voxel diagonally is class 3",
    `cov ${tilt.toFixed(3)}`);
}

// ══════════════════════════════════════════════════ 2. A CABLE IS CLASS 0
//
// The string-light cables that voxelized into a slab across Bistro's street.
// A 2 cm cable is a long thin quad however you slice it, and its triangles'
// AABB extents are METRES — which is exactly why the dust cull could never
// reach them.
{
  const G = "cable";
  for (const v of [0.25, 0.5, 1, 2, 4]) {
    const w = cellFrac(0.02, v); // 2 cm across, in cells
    const L = 40 / v; // 40 m of cable, in cells
    // A ribbon in the XZ plane, crossing the voxel along +X, `w` thick in Z.
    const q = quadCoverage(
      [-L, 0.5, 0.5], [L, 0.5, 0.5], [L, 0.5 + w, 0.5], [-L, 0.5 + w, 0.5], [0, 0, 0],
    );
    ok(G, covClassOf(q) === 0, `a 2 cm cable is class 0 at v = ${v} m`,
      `cov ${q.toFixed(4)} < ${COV_EDGES[0]}`);
  }
  // ⭐ AND IT SURVIVES THE SLIVER FLOOR BEING THE ONLY TERM. At v = 4 m the
  // ribbon is 1/200 of a cell wide and misses all 16 sample points; the AABB ×
  // fill floor is what keeps it from reading as literally nothing, which is what
  // lets a hundred of them in one coarse voxel still add up to an occluder.
  const w4 = cellFrac(0.02, 4);
  const one = quadCoverage(
    [-10, 0.5, 0.5], [10, 0.5, 0.5], [10, 0.5 + w4, 0.5], [-10, 0.5 + w4, 0.5], [0, 0, 0],
  );
  ok(G, one > 0 && one < COV_EDGES[0], "a sub-sample-grid sliver is small but NOT zero",
    `cov ${one.toExponential(2)}`);
}

// ══════════════════════════════════════════════════ 3. A RAILING BAR AT 45°
//
// The case that rules out the cheap "AABB overlap alone" estimator: a diagonal
// bar's bounding box fills the voxel completely, so an AABB-only rule would
// call it opaque and the balcony ironwork would stay a black wall.
{
  const G = "railing";
  const w = cellFrac(0.03, 0.25); // a 3 cm bar at v = 0.25 m
  // A ribbon running diagonally through the voxel in the XY plane.
  const n = w / Math.SQRT2;
  const q = quadCoverage(
    [-5, -5, 0.5], [5, 5, 0.5], [5 + n, 5 - n, 0.5], [-5 + n, -5 - n, 0.5], [0, 0, 0],
  );
  ok(G, covClassOf(q) <= 1, "a 3 cm bar at 45° is class 0-1, not opaque",
    `cov ${q.toFixed(4)} (its AABB fills the whole voxel)`);
}

// ══════════════════════════════════════════════════ 4. FOLIAGE ADDS UP
//
// One leaf is transparent, a canopy is not — the property only a SUM has, and
// the reason the coverage scratch is an `atomicAdd` where the palette and axis
// scratches beside it are `atomicMax`.
{
  const G = "foliage";
  const v = 1.0;
  const s = cellFrac(0.18, v) * 0.5; // an 18 cm leaf at a 1 m cell
  const leaf = (cx, cy) => quadCoverage(
    [cx - s, cy - s, 0.5], [cx + s, cy - s, 0.5], [cx + s, cy + s, 0.5], [cx - s, cy + s, 0.5],
    [0, 0, 0],
  );
  // A deterministic scatter inside the voxel's cross-section — not random, so
  // this test says the same thing every time it is run (§T).
  let sum = 0;
  const per = [];
  for (let i = 0; i < 40; i++) {
    const c = leaf(0.1 + ((i * 7) % 9) * 0.1, 0.1 + ((i * 5) % 9) * 0.1);
    per.push(c);
    sum += c;
  }
  const one = per[0];
  ok(G, covClassOf(one) <= 1, "ONE leaf is class 0-1", `cov ${one.toFixed(3)}`);
  ok(G, covClassOf(Math.min(1, sum * 5 / 40)) >= 1, "five leaves are already class 1+",
    `cov ${(sum * 5 / 40).toFixed(3)}`);
  ok(G, covClassOf(Math.min(1, sum)) === 3, "forty leaves in one cell are class 3 — a canopy",
    `cov ${Math.min(1, sum).toFixed(3)}`);
}

// ══════════════════════════════════════════════════ 5. THE QUANTISER
{
  const G = "classes";
  ok(G, covClassOf(0) === 0 && covClassOf(0.119) === 0, "below 12 % is class 0");
  ok(G, covClassOf(0.12) === 1 && covClassOf(0.349) === 1, "12-35 % is class 1");
  ok(G, covClassOf(0.35) === 2 && covClassOf(0.699) === 2, "35-70 % is class 2");
  ok(G, covClassOf(0.7) === 3 && covClassOf(1) === 3, "70 %+ is class 3 — opaque");
  ok(G, COV_SAMPLES_AXIS === 4, "the sample grid is 4 x 4");
  // The estimator is BOUNDED, which the fixed-point scratch depends on.
  const huge = coverageOfTriangleInVoxel([-99, -99, 0.5], [99, -99, 0.5], [0, 99, 0.5], [0, 0, 0]);
  ok(G, huge <= 1 + 1e-9, "coverage never exceeds 1", `got ${huge}`);
  // A DEGENERATE triangle has no area and must not produce a NaN that would
  // poison the sum for every other triangle in the voxel.
  // ⛔ AND IT MUST BE ZERO, NOT MERELY FINITE. Three collinear points make all
  // three edge functions identically 0, so every sample passes `>= 0` and the
  // naive form returns 1.0 — a zero-area triangle reported as an opaque wall.
  const degen = coverageOfTriangleInVoxel([0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0, 0]);
  ok(G, degen === 0, "a degenerate triangle covers NOTHING", `got ${degen}`);
}

console.log(rows.join("\n"));
console.log(failed === 0
  ? `\n§AG coverage: PASS — ${rows.length} checks`
  : `\n§AG coverage: FAIL — ${failed} of ${rows.length} checks`);
process.exit(failed === 0 ? 0 : 1);
