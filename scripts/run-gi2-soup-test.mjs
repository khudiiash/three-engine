// GI2 STAGE 2.2 — the triangle soup gate (node, no browser, no GPU).
//
// The soup is the ONLY thing the voxelizer's `binPairs` kernel reads, and every
// one of its failure modes is silent on the GPU: a triangle missing from a cell
// is a hole in occupancy that looks like "GI is still converging", a palette
// byte off by one lane is a wall that bleeds the neighbouring material's
// colour, and a prefix sum that is one entry short reads another cell's
// triangles. So the grid is checked against a BRUTE-FORCE reference here —
// every triangle, every cell, both directions — rather than by spot checks.
//
// Families:
//   1. SOUP      — triCount, world-space placement, indexed + unindexed input.
//   2. GRID      — origin snapping, dim coverage, prefix sums, and the exact
//                  set equality "tri t is in cell c ⟺ t's AABB overlaps c".
//   3. PALETTE   — byte packing round-trip, including PAL_NONE and the dense
//                  renumbering after a drop.
//   4. DROPS     — zero-area, collinear and non-finite triangles leave, and
//                  they leave without shifting anyone else's palette byte.
//   5. CAP       — largest-first truncation order, the cut list, and the single
//                  oversized placement that must still produce a soup.
//   6. BUILDER   — the main-thread API: copies vs transfers, single in-flight,
//                  supersede, dispose (with a fake worker; the REAL worker is
//                  proved by scripts/run-gi2-soup-probe.mjs).
//   7. TIMING    — 3 M triangles built in ≤ 2 s, with its byte count (the
//                  §K.3 sizing claim: "Bistro 3 M tris ≈ 120 MB").
//
// Run: node scripts/run-gi2-soup-test.mjs
import {
  PAL_NONE, SOUP_CELL_SIZE, buildTriangleSoup, soupTransferables,
} from "../src/modules/gi/window/triangleSoup.worker.js";
import {
  PAL_NONE as API_PAL_NONE, SOUP_CELL_SIZE as API_CELL, createTriangleSoupBuilder,
} from "../src/modules/gi/window/triangleSoup.js";
import * as THREE from "three";
import { estimateMaterialAreaShares, serializeMeshForBake } from "../src/modules/gi/voxelizeOnce.js";

let failures = 0;
let checks = 0;
const groups = new Map();
const ok = (group, cond, msg) => {
  checks++;
  let g = groups.get(group);
  if (!g) { g = { pass: 0, fail: 0 }; groups.set(group, g); }
  if (cond) { g.pass++; return true; }
  g.fail++;
  failures++;
  if (g.fail <= 6) console.error(`  FAIL [${group}] ${msg}`);
  return false;
};

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Indexed axis-aligned box of the given half-extents, centred on the origin. */
function boxIndexed(hx, hy, hz) {
  const positions = new Float32Array([
    -hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz,
    -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz,
  ]);
  const index = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  return { positions, index };
}

/** The same box, unindexed (the other input path). */
function boxUnindexed(hx, hy, hz) {
  const src = boxIndexed(hx, hy, hz);
  const positions = new Float32Array(src.index.length * 3);
  for (let i = 0; i < src.index.length; i++) {
    const v = src.index[i] * 3;
    positions[i * 3] = src.positions[v];
    positions[i * 3 + 1] = src.positions[v + 1];
    positions[i * 3 + 2] = src.positions[v + 2];
  }
  return { positions, index: null };
}

/** Column-major TRS, three.js element order. */
function matrix(tx, ty, tz, s = 1, yaw = 0) {
  const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s;
  return new Float32Array([
    c, 0, -sn, 0,
    0, s, 0, 0,
    sn, 0, c, 0,
    tx, ty, tz, 1,
  ]);
}

const palOf = (soup, i) => (soup.triPal[i >> 2] >>> ((i & 3) * 8)) & 255;

/** Independent reference: which cells does triangle `t`'s AABB overlap? */
function refCells(soup, t) {
  const { origin, cell, dim } = soup.grid;
  const o = t * 9;
  const cells = [];
  const span = (a, b, c, oo, n) => {
    const lo = Math.min(Math.min(soup.tris[o + a], soup.tris[o + b]), soup.tris[o + c]);
    const hi = Math.max(Math.max(soup.tris[o + a], soup.tris[o + b]), soup.tris[o + c]);
    const i0 = Math.max(0, Math.min(n - 1, Math.floor((lo - oo) / cell)));
    const i1 = Math.max(0, Math.min(n - 1, Math.floor((hi - oo) / cell)));
    return [i0, i1];
  };
  const [x0, x1] = span(0, 3, 6, origin[0], dim[0]);
  const [y0, y1] = span(1, 4, 7, origin[1], dim[1]);
  const [z0, z1] = span(2, 5, 8, origin[2], dim[2]);
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) cells.push(x + dim[0] * (y + dim[1] * z));
    }
  }
  return cells;
}

/** Full both-directions set equality between the grid and the reference. */
function checkGrid(G, soup) {
  const { dim } = soup.grid;
  const cellCount = dim[0] * dim[1] * dim[2];
  ok(G, soup.cellRange.length === cellCount * 2, `cellRange length ${soup.cellRange.length} vs ${cellCount * 2}`);
  // Prefix sums: starts are the running total of counts, and the last one ends
  // exactly at cellTris.length (no gap, no overlap).
  let acc = 0;
  let contiguous = true;
  for (let c = 0; c < cellCount; c++) {
    if (soup.cellRange[c * 2] !== acc) { contiguous = false; break; }
    acc += soup.cellRange[c * 2 + 1];
  }
  ok(G, contiguous, "cellRange starts are not the running prefix sum of counts");
  ok(G, acc === soup.cellTris.length, `prefix total ${acc} vs cellTris ${soup.cellTris.length}`);

  // grid -> reference: every listed (cell, tri) pair is a real AABB overlap.
  const built = new Map(); // tri -> Set(cells)
  let strays = 0;
  for (let c = 0; c < cellCount; c++) {
    const start = soup.cellRange[c * 2];
    const n = soup.cellRange[c * 2 + 1];
    for (let i = 0; i < n; i++) {
      const t = soup.cellTris[start + i];
      if (t >= soup.triCount) { strays++; continue; }
      let set = built.get(t);
      if (!set) { set = new Set(); built.set(t, set); }
      if (set.has(c)) strays++; // a triangle listed twice in one cell
      set.add(c);
    }
  }
  ok(G, strays === 0, `${strays} out-of-range or duplicated cellTris entries`);
  // reference -> grid: every AABB overlap is listed, and nothing else is.
  let mismatched = 0;
  for (let t = 0; t < soup.triCount; t++) {
    const want = refCells(soup, t);
    const got = built.get(t) ?? new Set();
    if (got.size !== want.length || want.some((c) => !got.has(c))) mismatched++;
  }
  ok(G, mismatched === 0, `${mismatched} of ${soup.triCount} triangles have the wrong cell set`);
}

// ── 1/2/3. the three-mesh scene ──────────────────────────────────────────────
{
  const G = "soup";
  const geometries = new Map([
    ["box10", boxIndexed(5, 5, 5)],          // a 10 m box at the origin
    ["prop", boxUnindexed(0.5, 0.5, 0.5)],   // a 1 m prop, unindexed
  ]);
  const placements = [
    { geometryKey: "box10", matrix: matrix(0, 0, 0), pal: 3 },
    { geometryKey: "prop", matrix: matrix(20, 0, 0, 2), pal: 7 },
    { geometryKey: "prop", matrix: matrix(-13.5, 6, 30, 1, Math.PI / 4), pal: PAL_NONE },
  ];
  const soup = buildTriangleSoup({ geometries, placements });

  ok(G, soup.triCount === 36, `triCount ${soup.triCount} vs 36`);
  ok(G, soup.tris.length === 36 * 9, `tris length ${soup.tris.length}`);
  ok(G, soup.dropped === 0, `dropped ${soup.dropped}`);
  ok(G, soup.truncated === false, "truncated with no cap");
  // World placement: the box spans ±5, the scaled prop is a 2 m cube at x=20,
  // and the rotated prop's AABB is √2 wide.
  const aabb = soup.stats.aabb;
  ok(G, Math.abs(aabb[0] - -14.21) < 0.02, `min x ${aabb[0]}`);
  ok(G, Math.abs(aabb[3] - 21) < 1e-4, `max x ${aabb[3]}`);
  ok(G, Math.abs(aabb[4] - 6.5) < 1e-4, `max y ${aabb[4]}`);
  ok(G, Math.abs(aabb[5] - 30.71) < 0.02, `max z ${aabb[5]}`);
  // The unindexed prop's first triangle must land where the indexed one would:
  // both boxes share vertex data, so triangle 12 (prop @ x=20, scale 2) has a
  // vertex at (19, -1, -1).
  ok(G, Math.abs(soup.tris[12 * 9] - 19) < 1e-5 && Math.abs(soup.tris[12 * 9 + 1] - -1) < 1e-5,
    `unindexed placement wrong: ${soup.tris[12 * 9]}, ${soup.tris[12 * 9 + 1]}`);

  const Gg = "grid";
  ok(Gg, soup.grid.cell === SOUP_CELL_SIZE, `cell ${soup.grid.cell}`);
  ok(Gg, soup.grid.origin.every((v, i) => v % SOUP_CELL_SIZE === 0 && v <= aabb[i]),
    `origin ${soup.grid.origin} not a floor-to-4m of ${aabb.slice(0, 3)}`);
  ok(Gg, soup.grid.dim.every((n, i) => n >= 1 && soup.grid.origin[i] + n * SOUP_CELL_SIZE > aabb[i + 3]),
    `dim ${soup.grid.dim} does not cover the AABB max`);
  ok(Gg, soup.grid.dim.join() === "10,4,10", `dim ${soup.grid.dim} vs 10,4,10`);
  checkGrid(Gg, soup);

  const Gp = "palette";
  let palOkCount = 0;
  for (let t = 0; t < 12; t++) palOkCount += palOf(soup, t) === 3 ? 1 : 0;
  for (let t = 12; t < 24; t++) palOkCount += palOf(soup, t) === 7 ? 1 : 0;
  for (let t = 24; t < 36; t++) palOkCount += palOf(soup, t) === PAL_NONE ? 1 : 0;
  ok(Gp, palOkCount === 36, `${36 - palOkCount} triangles carry the wrong palette byte`);
  ok(Gp, soup.triPal.length === Math.ceil(36 / 4), `triPal length ${soup.triPal.length}`);
  // Byte ORDER inside the word (the thing a GPU unpack gets wrong): tri 0 is
  // the LOW byte of word 0.
  ok(Gp, (soup.triPal[0] & 255) === 3 && (soup.triPal[3] >>> 24) === 7,
    `little-endian byte order broken: word0 ${soup.triPal[0].toString(16)} word3 ${soup.triPal[3].toString(16)}`);
  ok(Gp, API_PAL_NONE === PAL_NONE && API_CELL === SOUP_CELL_SIZE, "API constants disagree with the worker's");
  ok(Gp, soup.bytes === soup.tris.byteLength + soup.triPal.byteLength + soup.cellRange.byteLength + soup.cellTris.byteLength,
    `bytes ${soup.bytes} is not the sum of the four arrays`);
  ok(Gp, soupTransferables(soup).length === 5, "transfer list is not the five distinct buffers (including triOwner)");
}

// ── 4. degenerate drops ──────────────────────────────────────────────────────
{
  const G = "groups";
  const geo = boxIndexed(1, 1, 1); // 12 indexed triangles / 36 draw elements
  geo.groups = [
    { start: 0, count: 18, materialIndex: 0 },
    { start: 18, count: 18, materialIndex: 1 },
  ];
  const grouped = buildTriangleSoup({
    geometries: new Map([["grouped", geo]]),
    placements: [{ geometryKey: "grouped", matrix: matrix(0, 0, 0), pal: 3, pals: [3, 17] }],
  });
  ok(G, grouped.triCount === 12, `grouped triCount ${grouped.triCount}`);
  ok(G, Array.from({ length: 6 }, (_, t) => palOf(grouped, t)).every((p) => p === 3),
    `material slot 0 did not own triangles 0..5: ${Array.from({ length: 6 }, (_, t) => palOf(grouped, t))}`);
  ok(G, Array.from({ length: 6 }, (_, t) => palOf(grouped, t + 6)).every((p) => p === 17),
    `material slot 1 did not own triangles 6..11: ${Array.from({ length: 6 }, (_, t) => palOf(grouped, t + 6))}`);

  // Transparent/volume material ranges are absent from occupancy, but an
  // opaque sibling range in the same mesh must remain. Inactive ranges also
  // must not consume the tier's triangle cap before the opaque range arrives.
  const onlyFirst = buildTriangleSoup({
    geometries: new Map([["grouped", geo]]),
    placements: [{ geometryKey: "grouped", matrix: matrix(0, 0, 0), pal: 3, pals: [3, 17], active: [true, false] }],
  });
  ok(G, onlyFirst.triCount === 6 && Array.from({ length: 6 }, (_, t) => palOf(onlyFirst, t)).every((p) => p === 3),
    `inactive second range survived: count=${onlyFirst.triCount}`);
  const onlySecond = buildTriangleSoup({
    geometries: new Map([["grouped", geo]]),
    placements: [{ geometryKey: "grouped", matrix: matrix(0, 0, 0), pal: 3, pals: [3, 17], active: [false, true] }],
  });
  ok(G, onlySecond.triCount === 6 && Array.from({ length: 6 }, (_, t) => palOf(onlySecond, t)).every((p) => p === 17),
    `inactive first range survived or changed palette: count=${onlySecond.triCount}`);
  const cappedSecond = buildTriangleSoup({
    geometries: new Map([["grouped", geo]]), triCap: 4,
    placements: [{ geometryKey: "grouped", matrix: matrix(0, 0, 0), pal: 3, pals: [3, 17], active: [false, true] }],
  });
  ok(G, cappedSecond.triCount === 4 && Array.from({ length: 4 }, (_, t) => palOf(cappedSecond, t)).every((p) => p === 17),
    `inactive prefix consumed the cap: count=${cappedSecond.triCount}`);
  const unusedOpaque = { ...geo, groups: [{ start: 0, count: 36, materialIndex: 0 }] };
  const noDrawnOpaque = buildTriangleSoup({
    geometries: new Map([["unused-opaque", unusedOpaque]]),
    placements: [{ geometryKey: "unused-opaque", matrix: matrix(0, 0, 0), pal: 3,
      pals: [3, 17], active: [false, true] }],
  });
  ok(G, noDrawnOpaque.triCount === 0,
    `an unused opaque material slot made transparent drawn groups occupy ${noDrawnOpaque.triCount} triangles`);

  // Old callers hand in one `pal`. Groups must be a strict no-op for them.
  const scalar = buildTriangleSoup({
    geometries: new Map([["grouped", geo]]),
    placements: [{ geometryKey: "grouped", matrix: matrix(0, 0, 0), pal: 9 }],
  });
  ok(G, Array.from({ length: 12 }, (_, t) => palOf(scalar, t)).every((p) => p === 9),
    "a grouped geometry changed legacy scalar-pal behaviour");
  const missingSlot = buildTriangleSoup({
    geometries: new Map([["grouped", geo]]),
    placements: [{ geometryKey: "grouped", matrix: matrix(0, 0, 0), pal: 11, pals: [11] }],
  });
  ok(G, Array.from({ length: 6 }, (_, t) => palOf(missingSlot, t + 6)).every((p) => p === 11),
    "a missing material-slot palette did not fall back to scalar pal");

  // The real mesh serializer must carry the native draw ranges, and a group
  // edit must change geometry identity even when position.version does not.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(geo.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(geo.index, 1));
  geometry.addGroup(0, 18, 0);
  geometry.addGroup(18, 18, 1);
  const mesh = new THREE.Mesh(geometry, [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]);
  const record = serializeMeshForBake(mesh, { geometryOnly: true });
  ok(G, record.groups?.length === 2 && record.groups[1].materialIndex === 1,
    `serializer lost groups: ${JSON.stringify(record.groups)}`);
  const keyBefore = record.geometryKey;
  geometry.clearGroups();
  geometry.addGroup(0, 36, 1);
  const changed = serializeMeshForBake(mesh, { geometryOnly: true });
  ok(G, changed.geometryKey !== keyBefore, "a group edit reused the old geometry/soup key");
  geometry.dispose();
  for (const material of mesh.material) material.dispose();

  // Palette clustering is weighted by physical triangle area, not topology.
  // One large triangle and 100 small triangles below cover the same total
  // area; a count-weighted implementation reports ~1/101 and reproduces the
  // wrong-colour bias seen on heavily tessellated material ranges.
  const areaPositions = [0, 0, 0, 2, 0, 0, 0, 1, 0]; // area = 1
  for (let i = 0; i < 100; i++) {
    const x = i * 0.25;
    areaPositions.push(x, 0, 0, x + 0.2, 0, 0, x, 0.1, 0); // area = .01
  }
  const areaGeometry = new THREE.BufferGeometry();
  areaGeometry.setAttribute("position", new THREE.Float32BufferAttribute(areaPositions, 3));
  areaGeometry.addGroup(0, 3, 0);
  areaGeometry.addGroup(3, 300, 1);
  const shares = estimateMaterialAreaShares(areaGeometry, 2);
  ok(G, Math.abs(shares[0] - 0.5) < 1e-5 && Math.abs(shares[1] - 0.5) < 1e-5,
    `material palette weights follow tessellation instead of area: ${shares.join("/")}`);
  areaGeometry.dispose();
}

{
  const G = "drops";
  // 5 triangles: good, repeated-vertex, collinear, NaN, good.
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,          // good
    2, 0, 0, 2, 0, 0, 3, 0, 0,          // two vertices identical
    5, 0, 0, 6, 0, 0, 7, 0, 0,          // collinear
    9, 0, 0, NaN, 0, 0, 9, 1, 0,        // non-finite
    12, 0, 0, 13, 0, 0, 12, 1, 0,       // good
  ]);
  const soup = buildTriangleSoup({
    geometries: [{ key: "g", positions, index: null }],
    placements: [{ geometryKey: "g", matrix: matrix(0, 0, 0), pal: 11 }],
  });
  ok(G, soup.triCount === 2, `triCount ${soup.triCount} vs 2`);
  ok(G, soup.dropped === 3, `dropped ${soup.dropped} vs 3`);
  ok(G, soup.tris.length === 18, `tris length ${soup.tris.length} — survivors were not compacted`);
  ok(G, soup.tris[9] === 12, `the surviving second triangle is at the wrong index (${soup.tris[9]})`);
  ok(G, palOf(soup, 0) === 11 && palOf(soup, 1) === 11, "palette bytes did not follow the compaction");
  ok(G, Number.isFinite(soup.stats.aabb[0]) && soup.stats.aabb[3] === 13,
    `a dropped NaN triangle poisoned the AABB: ${soup.stats.aabb}`);
  checkGrid(G, soup);

  // Two placements, the first entirely degenerate: the second's palette must
  // not inherit the first's lane offset.
  const soup2 = buildTriangleSoup({
    geometries: [
      { key: "bad", positions: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]), index: null },
      { key: "good", positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), index: null },
    ],
    placements: [
      { geometryKey: "bad", matrix: matrix(0, 0, 0), pal: 1 },
      { geometryKey: "good", matrix: matrix(0, 0, 0), pal: 2 },
    ],
  });
  ok(G, soup2.triCount === 1 && palOf(soup2, 0) === 2, `palette lane shifted by a drop: ${palOf(soup2, 0)}`);
}

// ── 5. the triangle cap ──────────────────────────────────────────────────────
{
  const G = "cap";
  // Three placements with 100 / 40 / 8 triangles, declared smallest-first so
  // scene order cannot be what produces the right answer.
  const fan = (n) => {
    const positions = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      positions[i * 9] = i; positions[i * 9 + 1] = 0; positions[i * 9 + 2] = 0;
      positions[i * 9 + 3] = i + 0.5; positions[i * 9 + 4] = 0; positions[i * 9 + 5] = 0;
      positions[i * 9 + 6] = i; positions[i * 9 + 7] = 0.5; positions[i * 9 + 8] = 0;
    }
    return { positions, index: null };
  };
  const geometries = new Map([["t8", fan(8)], ["t40", fan(40)], ["t100", fan(100)]]);
  const placements = [
    { geometryKey: "t8", matrix: matrix(0, 0, 0), pal: 1 },
    { geometryKey: "t100", matrix: matrix(0, 10, 0), pal: 2 },
    { geometryKey: "t40", matrix: matrix(0, 20, 0), pal: 3 },
  ];
  const uncapped = buildTriangleSoup({ geometries, placements });
  ok(G, uncapped.triCount === 148 && !uncapped.truncated, `uncapped triCount ${uncapped.triCount}`);

  // Cap 130: the 100 fits, the 40 does not — so the 40 AND the 8 are cut
  // (largest-first prefix), and the survivor is the big one.
  const capped = buildTriangleSoup({ geometries, placements, triCap: 130 });
  ok(G, capped.triCount === 100, `capped triCount ${capped.triCount} vs 100`);
  ok(G, capped.truncated === true, "truncated flag not set");
  ok(G, capped.cut.length === 2, `cut ${JSON.stringify(capped.cut)}`);
  ok(G, capped.cut.map((c) => c.placement).sort().join() === "0,2", `cut the wrong placements: ${JSON.stringify(capped.cut)}`);
  ok(G, capped.cut.reduce((n, c) => n + c.tris, 0) === 48, "cut triangle count wrong");
  let allPal2 = true;
  for (let t = 0; t < capped.triCount; t++) if (palOf(capped, t) !== 2) allPal2 = false;
  ok(G, allPal2, "the capped soup kept the wrong placement");

  // A single placement larger than the whole cap is taken PARTIALLY — a phone
  // with one huge terrain mesh must not end up with an empty soup.
  const tiny = buildTriangleSoup({ geometries, placements, triCap: 50 });
  ok(G, tiny.triCount === 50 && tiny.truncated, `oversized-single-placement cap: ${tiny.triCount}`);
  ok(G, tiny.cut.some((c) => c.placement === 1 && c.tris === 50), `partial cut not reported: ${JSON.stringify(tiny.cut)}`);
  // Cap 0 is legal and yields an empty, well-formed soup.
  const empty = buildTriangleSoup({ geometries, placements, triCap: 0 });
  ok(G, empty.triCount === 0 && empty.cellTris.length === 0 && empty.cellRange.length === 2,
    `empty soup malformed: ${empty.triCount}/${empty.cellRange.length}`);
  ok(G, empty.truncated && empty.cut.length === 3, "cap 0 did not report every placement as cut");
}

// ── 6. the main-thread builder ───────────────────────────────────────────────
{
  const G = "builder";
  // A fake Worker that runs the REAL build after a tick, with the REAL
  // structured-clone-with-transfer semantics, so the copy/transfer contract is
  // exercised exactly as the browser would exercise it.
  let live = 0;
  class FakeWorker {
    constructor(delay = 0) { this.delay = delay; this.dead = false; live++; }
    postMessage(msg, transfer) {
      const cloned = structuredClone(msg, { transfer });
      setTimeout(() => {
        if (this.dead) return;
        const soup = buildTriangleSoup(cloned.input);
        this.onmessage?.({ data: { type: "done", gen: cloned.gen, soup } });
      }, this.delay);
    }
    terminate() { this.dead = true; live--; }
  }
  const geo = boxIndexed(1, 1, 1);
  const request = () => ({
    geometries: new Map([["b", geo], ["unused", boxIndexed(9, 9, 9)]]),
    placements: [{ geometryKey: "b", matrix: matrix(3, 0, 0), pal: 5 }],
  });

  // (a) copies by default — the caller's live arrays survive the transfer.
  const b1 = createTriangleSoupBuilder({ workerFactory: () => new FakeWorker(0) });
  const soup = await b1.build(request());
  ok(G, soup.triCount === 12, `builder triCount ${soup.triCount}`);
  ok(G, geo.positions.byteLength === 96, `copyInputs:true detached the caller's positions (${geo.positions.byteLength} B)`);
  ok(G, geo.index.byteLength === 72, "copyInputs:true detached the caller's index");
  ok(G, typeof soup.postStallMs === "number" && typeof soup.wallMs === "number", "builder did not report its timings");
  ok(G, palOf(soup, 0) === 5, "builder lost the palette");
  ok(G, soup.stats.placementsBuilt === 1, "builder shipped a geometry nothing places");
  const groupedGeo = boxIndexed(1, 1, 1);
  groupedGeo.groups = [
    { start: 0, count: 18, materialIndex: 0 },
    { start: 18, count: 18, materialIndex: 1 },
  ];
  const groupedSoup = await b1.build({
    geometries: new Map([["grouped", groupedGeo]]),
    placements: [{ geometryKey: "grouped", matrix: matrix(0, 0, 0), pal: 4, pals: [4, 23] }],
  });
  ok(G, palOf(groupedSoup, 0) === 4 && palOf(groupedSoup, 11) === 23,
    "builder structured-clone path lost groups or per-slot palettes");

  // (b) copyInputs:false donates — the caller's array is detached, which is
  // what makes the "document it" warning in triangleSoup.js load-bearing.
  const donor = boxIndexed(1, 1, 1);
  const b2 = createTriangleSoupBuilder({ workerFactory: () => new FakeWorker(0), copyInputs: false });
  await b2.build({ geometries: new Map([["b", donor]]), placements: [{ geometryKey: "b", matrix: matrix(0, 0, 0), pal: 0 }] });
  ok(G, donor.positions.byteLength === 0, "copyInputs:false did not transfer (no detach)");

  // (c) single in-flight: the newer build supersedes the older, which rejects
  // rather than hanging, and the stale worker is terminated.
  const b3 = createTriangleSoupBuilder({ workerFactory: () => new FakeWorker(40) });
  const first = b3.build(request());
  const second = b3.build(request());
  let superseded = false;
  await first.catch((err) => { superseded = err?.superseded === true; });
  const soup2 = await second;
  ok(G, superseded, "the superseded build did not reject with .superseded");
  ok(G, soup2.triCount === 12, "the superseding build did not complete");
  // (d) dispose rejects the in-flight build and terminates the worker.
  const b4 = createTriangleSoupBuilder({ workerFactory: () => new FakeWorker(40) });
  const orphan = b4.build(request());
  b4.dispose();
  let disposedRejected = false;
  await orphan.catch((err) => { disposedRejected = err?.superseded === true; });
  ok(G, disposedRejected, "dispose left the in-flight build hanging");
  // Every builder disposed: no worker outlives its owner (a leaked worker per
  // scene open is a thread and a soup's worth of memory the profiler never
  // attributes back here).
  b1.dispose(); b2.dispose(); b3.dispose();
  ok(G, live === 0, `${live} fake workers left running after dispose/supersede`);
}

// ── 7. the timing receipt ────────────────────────────────────────────────────
{
  const G = "timing";
  // 3 M triangles of small random geometry over 110 × 36 × 110 m — Bistro's
  // extent and triangle count (audits §K.3: "Bistro 3 M tris ≈ 120 MB").
  const PER = 100000;
  const PLACEMENTS = 30;
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  const positions = new Float32Array(PER * 9);
  for (let i = 0; i < PER; i++) {
    const x = rnd() * 110 - 55, y = rnd() * 36, z = rnd() * 110 - 55;
    for (let k = 0; k < 3; k++) {
      positions[i * 9 + k * 3] = x + rnd() * 0.6;
      positions[i * 9 + k * 3 + 1] = y + rnd() * 0.6;
      positions[i * 9 + k * 3 + 2] = z + rnd() * 0.6;
    }
  }
  const placements = [];
  for (let p = 0; p < PLACEMENTS; p++) {
    placements.push({ geometryKey: "cloud", matrix: matrix((p % 6) * 0.4 - 1, (p % 3) * 0.3, (p % 5) * 0.4 - 1), pal: p & 255 });
  }
  const t0 = performance.now();
  const big = buildTriangleSoup({ geometries: [{ key: "cloud", positions, index: null }], placements });
  const ms = performance.now() - t0;
  const mb = big.bytes / (1024 * 1024);
  console.log(`  3 M-triangle receipt: ${big.triCount.toLocaleString()} tris in ${ms.toFixed(0)} ms ` +
    `(plan ${big.stats.planMs.toFixed(0)} / soup ${big.stats.soupMs.toFixed(0)} / grid ${big.stats.gridMs.toFixed(0)}) — ` +
    `${mb.toFixed(1)} MB, ${big.stats.cellCount} cells, ${big.stats.cellEntries.toLocaleString()} entries, ` +
    `${(big.tris.byteLength / 1048576).toFixed(1)} MB soup + ${(big.cellTris.byteLength / 1048576).toFixed(1)} MB grid`);
  ok(G, big.triCount === PER * PLACEMENTS, `triCount ${big.triCount}`);
  ok(G, ms <= 2000, `3 M triangles took ${ms.toFixed(0)} ms (gate: ≤ 2000 ms)`);
  ok(G, mb < 200, `${mb.toFixed(1)} MB for 3 M tris (sizing claim: ~120 MB)`);
  // Sanity on the grid at scale: cells are 4 m, the volume is ~110×36×110.
  ok(G, big.grid.dim[0] === 29 && big.grid.dim[1] === 10 && big.grid.dim[2] === 29,
    `grid dim ${big.grid.dim} for a 110×36×110 m scene`);
  ok(G, big.cellTris.length >= big.triCount, "cellTris is smaller than triCount");
  // Spot-check 2000 triangles against the reference rather than all 3 M (the
  // full sweep is what the small scenes above are for).
  let bad = 0;
  const listed = new Map();
  for (let c = 0; c < big.stats.cellCount; c++) {
    const s = big.cellRange[c * 2];
    for (let i = 0; i < big.cellRange[c * 2 + 1]; i++) {
      const t = big.cellTris[s + i];
      if (t % 1500 !== 0) continue;
      let set = listed.get(t);
      if (!set) { set = new Set(); listed.set(t, set); }
      set.add(c);
    }
  }
  for (let t = 0; t < big.triCount; t += 1500) {
    const want = refCells(big, t);
    const got = listed.get(t) ?? new Set();
    if (got.size !== want.length || want.some((c) => !got.has(c))) bad++;
  }
  ok(G, bad === 0, `${bad} of ${Math.ceil(big.triCount / 1500)} sampled triangles are in the wrong cells at scale`);
}

console.log("");
for (const [name, g] of groups) {
  console.log(`  ${g.fail ? "FAIL" : "ok  "} ${name.padEnd(10)} ${g.pass}/${g.pass + g.fail}`);
}
console.log(`\n${failures ? "FAILED" : "PASSED"} — ${checks - failures}/${checks} checks`);
process.exit(failures ? 1 : 0);
