/**
 * TURNING AN ARBITRARY MESH INTO A CLOTH.
 *
 * The cloth solver was a GRID: `constrain()` unrolled a fixed twelve-neighbour
 * stencil at shader-build time with rest lengths folded in as JavaScript
 * constants, so it could only ever simulate a plane it generated itself. The
 * ask (2026-09-07) is to drape a mesh the author already has — *"we take a
 * model of a boat with sails, and we want to turn sails into cloth"* — while
 * skipping the ones that make no sense, *"like a human model for example"*.
 *
 * This module is the CPU half, and deliberately the whole of the hard part: it
 * turns a `BufferGeometry` into the four buffers the solver needs, and it
 * decides whether the mesh is cloth-shaped at all. It touches no GPU and no
 * three renderer state, so every rule in here is testable in Node — which
 * matters, because "which meshes qualify" is a judgement that will be argued
 * with and should be arguable against numbers.
 *
 * ── WHAT THE SOLVER NEEDS, AND WHY EACH PIECE EXISTS ──────────────────────
 *
 * · `rest` — the welded source positions. Replaces the grid's `initial(x, y)`.
 * · `pinned` — a flag per particle. Replaces `pinned()`, which tested row 0.
 * · `offsets` + `neighbours`/`restLength`/`weight` — the constraint graph in
 *   CSR form. Replaces the unrolled stencil: each thread loops its own
 *   incident springs instead of twelve hardcoded offsets.
 * · `simOf` — render vertex → particle, because welding collapses seams.
 *
 * ⭐ THE SOLVER IS ALREADY JACOBI, which is what makes this tractable.
 * `constrain` ping-pongs between two buffers and never reads a value another
 * thread wrote this pass, so an arbitrary graph needs no colouring, no
 * ordering and no atomics — only the neighbour list changes.
 *
 * ⛔ WELDING IS NOT OPTIONAL. An imported mesh is split at every UV and normal
 * seam: Sponza's curtain carries 7 739 render vertices for 7 174 distinct
 * positions. Simulate the render vertices and the sheet tears along every seam
 * on the first frame, because the two copies of a seam vertex share no spring.
 */

/**
 * Positions this close together are the same particle.
 *
 * A hard metric tolerance rather than a relative one: seam duplicates are
 * BIT-IDENTICAL or within float32 round-off of each other, never a millimetre
 * apart, so a tight value welds every seam without ever fusing two genuinely
 * distinct vertices of a fine mesh.
 */
const WELD_EPSILON = 1e-5;

/**
 * How thin a piece has to be, relative to its own longest axis, to count as
 * cloth. Measured on the PRINCIPAL axes, not the bounding box — see
 * `principalExtents`.
 *
 * The value is set from the two ends of the real range rather than taste:
 * Sponza's curtains measure 0.087 (2.3 x 2.26 x 0.20 m) and want to pass; a
 * closed solid — a character, a prop, a barrel — sits far above 0.25 because
 * no axis of a solid is small against its longest. 0.25 leaves the sheet case
 * a wide margin while still rejecting anything with real volume.
 */
export const CLOTH_THINNESS_LIMIT = 0.25;

/**
 * Particles per cloth, over all islands.
 *
 * The solver runs eight Jacobi relaxations per fixed step at 120 Hz, so the
 * cost is `particles x springs x 8 x 120` per second. 20 000 is roughly four
 * of Sponza's curtains and keeps a mesh cloth in the same cost class as the
 * 32x32 grid it replaces (1 024 particles, but a far denser stencil).
 */
export const CLOTH_MAX_PARTICLES = 20000;

/**
 * The most springs one particle may have.
 *
 * The GPU stores the graph at a FIXED STRIDE — `maxDegree` slots per particle,
 * padded with a sentinel — rather than as a CSR range, because that costs one
 * storage binding instead of two and the cloth solver is already close to the
 * eight-per-stage floor once the collider fields are bound. The stride is the
 * mesh's OWN measured maximum, so nothing is ever truncated; this cap only
 * bounds what that stride can cost.
 *
 * Measured on Sponza's curtains: median degree 12 (exactly the old grid
 * stencil's twelve neighbours), p99 14, max 17. A well-behaved sheet has
 * valence around six, so 32 is far above anything cloth-shaped — a mesh that
 * exceeds it has a fan or a pole and is not a sheet. At 32 the buffer is
 * 512 bytes per particle, so the cap also bounds memory at ~10 MB.
 */
export const CLOTH_MAX_DEGREE = 32;

/** Union-find over welded vertices, for splitting a mesh into its pieces. */
function connectedIslands(triangles, count) {
  const parent = new Uint32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (a) => {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    // Path compression, so a long chain of merges does not make this quadratic
    // on a mesh whose triangles arrive in a bad order.
    while (parent[a] !== root) { const next = parent[a]; parent[a] = root; a = next; }
    return root;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let t = 0; t < triangles.length; t += 3) {
    union(triangles[t], triangles[t + 1]);
    union(triangles[t + 1], triangles[t + 2]);
  }
  const island = new Int32Array(count).fill(-1);
  const roots = new Map();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    let id = roots.get(root);
    if (id === undefined) { id = roots.size; roots.set(root, id); }
    island[i] = id;
  }
  return { island, count: roots.size };
}

/**
 * The extents of a point set along its OWN principal axes, largest first.
 *
 * ⛔ A BOUNDING BOX IS THE WRONG RULER HERE and would reject exactly the meshes
 * this feature is for. A sail is thin along its own normal, which is almost
 * never a world axis: a 3 x 3 m sheet rotated 45° has an axis-aligned box of
 * 2.1 x 2.1 x 3, and reads as a solid. The covariance's smallest eigenvalue is
 * the thickness whatever the orientation.
 *
 * Eigenvalues of the symmetric 3x3 covariance come from the closed form
 * (Smith 1961): shift by the mean of the diagonal, and the remainder's
 * eigenvalues are three cosines. It is exact, allocation-free and has no
 * iteration to converge — which a per-attach analysis of a 20 000-vertex mesh
 * should not have.
 */
export function principalExtents(positions, indices) {
  const n = indices ? indices.length : positions.length / 3;
  if (n === 0) return [0, 0, 0];
  const at = (k) => (indices ? indices[k] : k) * 3;
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < n; k++) { const o = at(k); cx += positions[o]; cy += positions[o + 1]; cz += positions[o + 2]; }
  cx /= n; cy /= n; cz /= n;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let k = 0; k < n; k++) {
    const o = at(k);
    const dx = positions[o] - cx, dy = positions[o + 1] - cy, dz = positions[o + 2] - cz;
    xx += dx * dx; yy += dy * dy; zz += dz * dz;
    xy += dx * dy; xz += dx * dz; yz += dy * dz;
  }
  xx /= n; yy /= n; zz /= n; xy /= n; xz /= n; yz /= n;

  const q = (xx + yy + zz) / 3;
  const ax = xx - q, ay = yy - q, az = zz - q;
  const p2 = (ax * ax + ay * ay + az * az) / 6 + (xy * xy + xz * xz + yz * yz) / 3;
  const p = Math.sqrt(Math.max(p2, 0));
  let eig;
  if (p < 1e-20) {
    // Isotropic: all three variances equal, so the shape has no thin axis.
    eig = [q, q, q];
  } else {
    const bx = ax / p, by = ay / p, bz = az / p;
    const bxy = xy / p, bxz = xz / p, byz = yz / p;
    const det = bx * (by * bz - byz * byz) - bxy * (bxy * bz - byz * bxz) + bxz * (bxy * byz - by * bxz);
    const phi = Math.acos(Math.min(1, Math.max(-1, det / 2))) / 3;
    const e0 = q + 2 * p * Math.cos(phi);
    const e2 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
    // The trace is invariant, so the middle one comes free and cannot drift.
    eig = [e0, xx + yy + zz - e0 - e2, e2];
  }
  // Variance to a half-extent-like length, then to a full extent. The constant
  // is irrelevant to the RATIO this is used for; the square root is not.
  return eig.map((value) => 2 * Math.sqrt(Math.max(value, 0))).sort((a, b) => b - a);
}

/**
 * Build the constraint graph, in CSR.
 *
 * Two spring families, and a general triangle mesh wants exactly these:
 *
 * · **structural** — every mesh edge, at its own rest length. This is the
 *   sheet's resistance to stretching.
 * · **dihedral** — across each interior edge, joining the two opposite
 *   vertices. This is bending resistance, and on a quad triangulated into two
 *   triangles it lands exactly where the grid solver's diagonal SHEAR spring
 *   was, which is why one construction covers both.
 *
 * ⚠ There is no separate shear family on an arbitrary mesh, and pretending
 * otherwise would be a lie in the inspector: a triangle already resists shear
 * through its own three edges, whereas a grid quad does not and needs a
 * diagonal added. The `shear` prop therefore has no effect on a mesh cloth,
 * and `analyseClothMesh` says so in `notes` rather than silently ignoring it.
 */
function buildSprings(triangles, positions, count) {
  // ── THE FAN SUCCESSOR, AND WHY IT RIDES IN A SPRING'S SPARE LANE ─────────
  //
  // The render mesh needs a vertex NORMAL every frame, and a mesh has no grid
  // neighbours to cross: the old solver took `cross(east - west, north - south)`
  // straight off the lattice. The correct replacement is the area-weighted sum
  // of `cross(a - p, b - p)` over the triangles around p, which needs p's
  // one-ring IN ORDER.
  //
  // Storing that ring as its own buffer would be a fourth binding on a solver
  // already close to WebGPU's eight-per-stage floor. But every ring edge is
  // ALREADY a structural spring, and a spring slot's `w` lane is unused — so
  // ordering the ring here and writing each neighbour's fan successor into `w`
  // costs nothing and gives the shader a walkable fan.
  //
  // A boundary vertex's last edge has no successor and stores `SPRING_END`:
  // its fan is open, which is exactly right — the missing triangle is outside
  // the sheet and must contribute no normal.
  const successorOf = new Map();
  const cornerKey = (a, b) => a * count + b;
  for (let t = 0; t < triangles.length; t += 3) {
    const v = [triangles[t], triangles[t + 1], triangles[t + 2]];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    // Winding order is what makes this a consistent fan: around p, the next
    // neighbour after `a` is `b` for the triangle (p, a, b).
    for (let e = 0; e < 3; e++) {
      const p = v[e], a = v[(e + 1) % 3], b = v[(e + 2) % 3];
      if (!successorOf.has(cornerKey(p, a))) successorOf.set(cornerKey(p, a), b);
    }
  }

  const structural = new Map();
  const dihedral = new Map();
  const key = (a, b) => (a < b ? a * count + b : b * count + a);
  // edge → the vertices opposite it, so the second one closes a dihedral pair.
  const opposite = new Map();
  for (let t = 0; t < triangles.length; t += 3) {
    const v = [triangles[t], triangles[t + 1], triangles[t + 2]];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue; // degenerate
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3], c = v[(e + 2) % 3];
      structural.set(key(a, b), [a, b]);
      const k = key(a, b);
      const seen = opposite.get(k);
      if (seen === undefined) opposite.set(k, c);
      else if (seen !== c) dihedral.set(key(seen, c), [seen, c]);
    }
  }
  // A dihedral pair that is ALSO a real edge stays structural: on a closed
  // fan the opposite vertices can be neighbours, and adding the same pair
  // twice would double its stiffness for no reason anyone authored.
  for (const k of structural.keys()) dihedral.delete(k);

  const degree = new Uint32Array(count + 1);
  const bump = (map) => { for (const [a, b] of map.values()) { degree[a]++; degree[b]++; } };
  bump(structural); bump(dihedral);
  const offsets = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + degree[i];
  const total = offsets[count];
  const cursor = offsets.slice(0, count);
  const neighbours = new Uint32Array(total);
  const restLength = new Float32Array(total);
  const weight = new Float32Array(total);
  const successor = new Int32Array(total).fill(-1);
  const emit = (map, kindWeight) => {
    for (const [a, b] of map.values()) {
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const length = Math.hypot(bx - ax, by - ay, bz - az);
      for (const [from, to] of [[a, b], [b, a]]) {
        const slot = cursor[from]++;
        neighbours[slot] = to;
        restLength[slot] = length;
        weight[slot] = kindWeight;
        // Only a structural spring is a real ring edge; a dihedral one jumps
        // across a triangle and would fold the fan back on itself.
        successor[slot] = kindWeight === 0 ? (successorOf.get(cornerKey(from, to)) ?? -1) : -1;
      }
    }
  };
  // 0 = structural (scaled by `stiffness`), 1 = dihedral (scaled by `bend`).
  emit(structural, 0);
  emit(dihedral, 1);
  return { offsets, neighbours, restLength, weight, successor, structural: structural.size, dihedral: dihedral.size, thickness: 0 };
}

/**
 * How far to look for the opposite face, as a multiple of the piece's own
 * thinnest principal extent. Two, so a shell whose faces sit exactly that far
 * apart is found comfortably while a fold twice as deep is not mistaken for
 * one.
 */
const THICKNESS_SEARCH = 2;

/**
 * Fold an extra spring family into an existing CSR graph.
 *
 * Rebuilt rather than appended because CSR is contiguous per vertex: adding one
 * spring to particle 0 would have to shift every slot after it.
 */
function mergeSprings(springs, extra, positions, count) {
  const degree = new Uint32Array(count);
  for (let v = 0; v < count; v++) degree[v] = springs.offsets[v + 1] - springs.offsets[v];
  for (const [a, b] of extra.values()) { degree[a]++; degree[b]++; }
  const offsets = new Uint32Array(count + 1);
  for (let v = 0; v < count; v++) offsets[v + 1] = offsets[v] + degree[v];
  const total = offsets[count];
  const cursor = offsets.slice(0, count);
  const neighbours = new Uint32Array(total);
  const restLength = new Float32Array(total);
  const weight = new Float32Array(total);
  const successor = new Int32Array(total).fill(-1);
  for (let v = 0; v < count; v++) {
    for (let i = springs.offsets[v]; i < springs.offsets[v + 1]; i++) {
      const slot = cursor[v]++;
      neighbours[slot] = springs.neighbours[i];
      restLength[slot] = springs.restLength[i];
      weight[slot] = springs.weight[i];
      successor[slot] = springs.successor[i];
    }
  }
  for (const [a, b] of extra.values()) {
    const length = Math.hypot(
      positions[b * 3] - positions[a * 3],
      positions[b * 3 + 1] - positions[a * 3 + 1],
      positions[b * 3 + 2] - positions[a * 3 + 2],
    );
    for (const [from, to] of [[a, b], [b, a]]) {
      const slot = cursor[from]++;
      neighbours[slot] = to;
      restLength[slot] = length;
      // Structural: a shell's thickness should be as hard to change as its
      // edges. The successor lane marks the FAMILY — this spring closes no
      // triangle (so the normal fan skips it) and is not a surface edge (so
      // contact must not sweep along it).
      weight[slot] = 0;
      successor[slot] = SPRING_THICKNESS;
    }
  }
  return { offsets, neighbours, restLength, weight, successor,
    structural: springs.structural, dihedral: springs.dihedral, thickness: extra.size };
}

/**
 * ⭐ THICKNESS SPRINGS: what holds a MODELLED cloth together.
 *
 * A curtain or a sail authored with thickness is a closed SHELL — a front face
 * and a back face joined only around the rim. Nothing in the mesh connects them
 * anywhere else, so under gravity and wind the two layers slide and separate
 * independently and the cloth reads as torn (user, 2026-09-08: "looks a bit
 * torn up"). Measured on Sponza's curtain: **100 % of its 7 174 vertices have a
 * partner within 11 cm that is more than two rings away in the graph**, at a
 * median separation of 5.8 cm. Every one of those pairs was free to drift.
 *
 * So each vertex gets one spring to its nearest such partner, at their rest
 * separation. That is the shell's thickness, and holding it turns two loose
 * sheets into one piece of cloth.
 *
 * ⚠ THE 2-RING EXCLUSION IS THE WHOLE TRICK. Without it the "nearest distant
 * partner" is simply a neighbour, and every vertex gets a duplicate of a spring
 * it already has — stiffening the surface rather than binding the layers.
 *
 * The search radius comes from the piece's own thinnest principal extent, so it
 * scales with the mesh instead of assuming centimetres.
 */
function buildThicknessSprings(rest, count, offsets, neighbours, radiusOf, islandOf) {
  const pairs = new Map();
  const key = (a, b) => (a < b ? a * count + b : b * count + a);
  let maxRadius = 0;
  for (const value of radiusOf) if (value > maxRadius) maxRadius = value;
  if (!(maxRadius > 0)) return pairs;
  // A uniform grid at the search radius: 27 cells per query, against 7 174**2
  // distance tests for the naive version.
  const cells = new Map();
  const cellKey = (x, y, z) => `${x},${y},${z}`;
  const at = (v, k) => Math.floor(rest[v * 3 + k] / maxRadius);
  for (let v = 0; v < count; v++) {
    const k = cellKey(at(v, 0), at(v, 1), at(v, 2));
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(v);
  }
  const near = new Set();
  for (let v = 0; v < count; v++) {
    const radius = radiusOf[islandOf[v]] ?? 0;
    if (!(radius > 0)) continue;
    near.clear();
    near.add(v);
    for (let i = offsets[v]; i < offsets[v + 1]; i++) {
      const a = neighbours[i];
      near.add(a);
      for (let j = offsets[a]; j < offsets[a + 1]; j++) near.add(neighbours[j]);
    }
    let best = -1, bestDistance = radius * radius;
    const cx = at(v, 0), cy = at(v, 1), cz = at(v, 2);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = cells.get(cellKey(cx + dx, cy + dy, cz + dz));
      if (!list) continue;
      for (const u of list) {
        if (near.has(u) || islandOf[u] !== islandOf[v]) continue;
        const ex = rest[u * 3] - rest[v * 3], ey = rest[u * 3 + 1] - rest[v * 3 + 1], ez = rest[u * 3 + 2] - rest[v * 3 + 2];
        const d = ex * ex + ey * ey + ez * ez;
        if (d < bestDistance) { bestDistance = d; best = u; }
      }
    }
    if (best >= 0) pairs.set(key(v, best), [v, best]);
  }
  return pairs;
}

/**
 * Which particles are held in place.
 *
 * The grid solver pinned by ROW (`y === 0` is the top edge), which an
 * arbitrary mesh has no notion of. Here it is geometry: the band of vertices
 * within a tolerance of the island's extreme along the chosen local axis.
 *
 * ⚠ PER ISLAND, not per mesh, and that is the whole reason this takes the
 * island map. A boat's two sails are one geometry with two pieces at different
 * heights; pinning "the top" globally would nail the upper sail's head and let
 * the lower sail fall out of the sky. Measured on Sponza's curtain, which is
 * three separate 2.3 m drapes inside one asset.
 *
 * The band is a fraction of the island's own extent, so it scales with the
 * piece instead of assuming metres.
 */
const PIN_BAND = 0.02;

/**
 * ⛔ A FLAT BAND CANNOT HOLD A HEM THAT IS NOT FLAT.
 *
 * A curtain is modelled DRAPED OVER ITS ROD, so its top edge is a wave, not a
 * line. Measured on all three Sponza cloths: the top hem rises and falls
 * **8.4 to 11.4 cm** while `PIN_BAND` of a 2.26 m drape is **4.5 cm**. Only
 * the crests fell inside the band — 47 of 60 columns held on one island, 38 of
 * 60 on another — and every unheld column sagged away from the rod between two
 * pinned neighbours. That is the sawtooth along the top of the curtain the
 * user photographed ("there are artifacts even on those that work properly",
 * 2026-09-08), and no amount of solver work could have fixed it: those
 * vertices were never attached to anything.
 *
 * So the band is sized from the hem's OWN relief, measured rather than
 * assumed, and `PIN_BAND` becomes its floor. A flat-topped banner has no
 * relief and keeps the tight band it had — which is what protects the case in
 * `clothPinFlags` below, where widening the band for everyone made an 11 m
 * banner pin 36 % of itself.
 */
const PIN_HEM_HEADROOM = 1.15;
/**
 * And a ceiling, because the relief is measured off arbitrary user geometry: a
 * piece whose "hem" wanders over a sixth of its own height is not a hem, and
 * pinning that much of a cloth would freeze it. 2.26 m x 0.15 = 34 cm, three
 * times the deepest real drape measured.
 */
const PIN_BAND_LIMIT = 0.15;

/**
 * How many columns the hem profile is sampled in. The profile is the topmost
 * vertex in each slice across the pinned edge, so the slices must be coarse
 * enough to each contain several vertices — a slice that catches one vertex
 * measures mesh sampling, not relief.
 */
function hemRelief(rest, island, id, axis, cross, wantMax, members) {
  if (members < 4) return 0;
  const columns = Math.max(8, Math.min(64, Math.round(Math.sqrt(members))));
  let lo = Infinity, hi = -Infinity;
  for (let v = 0; v < rest.length / 3; v++) {
    if (island[v] !== id) continue;
    const c = rest[v * 3 + cross];
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  const width = hi - lo;
  if (!(width > 1e-9)) return 0;
  const profile = new Float32Array(columns).fill(wantMax ? -Infinity : Infinity);
  for (let v = 0; v < rest.length / 3; v++) {
    if (island[v] !== id) continue;
    const slice = Math.min(columns - 1, Math.floor(((rest[v * 3 + cross] - lo) / width) * columns));
    const a = rest[v * 3 + axis];
    if (wantMax ? a > profile[slice] : a < profile[slice]) profile[slice] = a;
  }
  let min = Infinity, max = -Infinity;
  for (const value of profile) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
}

/**
 * Below this share of its own size, a piece is FLAT against the pinned axis
 * and has no edge there to hold. 5 % is well under any real drape (a curtain
 * 2.3 m wide and 2.26 m tall is 98 %) and well above the numerical noise of a
 * sheet modelled dead flat.
 */
const FLAT_AXIS_LIMIT = 0.05;

/**
 * How much longer than the taut geodesic a particle may sit from its pin.
 * Exported because `cloth-health` measures the cap's step-invariance and the
 * two must not drift apart.
 */
export const LRA_SLACK = 1.02;

export function clothPinFlags(rest, island, islandCount, mode) {
  const count = rest.length / 3;
  const pinned = new Uint8Array(count);
  if (mode === "none" || islandCount === 0) return pinned;
  // 0 = top edge (max Y), 2 = left edge (min X); the corner modes pin the same
  // edge but only at its ends, matching the grid solver's `pin` enum.
  const axis = mode === "left" || mode === "leftCorners" ? 0 : 1;
  const wantMax = axis === 1;
  const corners = mode === "corners" || mode === "leftCorners";
  const cross = axis === 1 ? 0 : 1;

  const lo = new Float32Array(islandCount).fill(Infinity);
  const hi = new Float32Array(islandCount).fill(-Infinity);
  const spanLo = new Float32Array(islandCount).fill(Infinity);
  const spanHi = new Float32Array(islandCount).fill(-Infinity);
  for (let v = 0; v < count; v++) {
    const id = island[v];
    if (id < 0) continue;
    const a = rest[v * 3 + axis], c = rest[v * 3 + cross];
    if (a < lo[id]) lo[id] = a;
    if (a > hi[id]) hi[id] = a;
    if (c < spanLo[id]) spanLo[id] = c;
    if (c > spanHi[id]) spanHi[id] = c;
  }
  // ⛔ AN AXIS THE PIECE IS FLAT AGAINST HAS NO EDGE TO PIN, and that has to be
  // DETECTED rather than absorbed. A cloth lying horizontally has almost no Y
  // extent, so "the band near max Y" is the whole piece: Sponza's `Mesh_0_9`
  // came back with all 23 of its vertices pinned, a cloth that could never
  // move. Widening the band to the piece's overall size fixes that case and
  // breaks the opposite one — an 11 m banner 2 m tall then pinned 36 % of
  // itself. So the band stays a fraction of the PINNED axis, and a piece whose
  // pinned axis is negligible against its own size is reported instead.
  const boxLo = new Float32Array(islandCount * 3).fill(Infinity);
  const boxHi = new Float32Array(islandCount * 3).fill(-Infinity);
  for (let v = 0; v < count; v++) {
    const id = island[v];
    if (id < 0) continue;
    for (let a = 0; a < 3; a++) {
      const value = rest[v * 3 + a];
      if (value < boxLo[id * 3 + a]) boxLo[id * 3 + a] = value;
      if (value > boxHi[id * 3 + a]) boxHi[id * 3 + a] = value;
    }
  }
  const size = new Float32Array(islandCount);
  for (let id = 0; id < islandCount; id++) {
    size[id] = Math.max(boxHi[id * 3] - boxLo[id * 3], boxHi[id * 3 + 1] - boxLo[id * 3 + 1], boxHi[id * 3 + 2] - boxLo[id * 3 + 2]);
  }

  const memberCount = new Int32Array(islandCount);
  for (let v = 0; v < count; v++) if (island[v] >= 0) memberCount[island[v]]++;
  const relief = new Float32Array(islandCount);
  for (let id = 0; id < islandCount; id++) {
    if (hi[id] - lo[id] >= size[id] * FLAT_AXIS_LIMIT) relief[id] = hemRelief(rest, island, id, axis, cross, wantMax, memberCount[id]);
  }

  for (let v = 0; v < count; v++) {
    const id = island[v];
    if (id < 0) continue;
    const axisExtent = hi[id] - lo[id];
    // Flat against this axis: there is no such edge, so hold nothing here.
    if (axisExtent < size[id] * FLAT_AXIS_LIMIT) continue;
    // The band must reach at least as deep as the hem's own relief, or a
    // draped edge is held only at its crests — see `PIN_HEM_HEADROOM`.
    const band = Math.min(
      Math.max(axisExtent * PIN_BAND, relief[id] * PIN_HEM_HEADROOM),
      axisExtent * PIN_BAND_LIMIT,
    );
    const edge = wantMax ? hi[id] : lo[id];
    const distance = Math.abs(rest[v * 3 + axis] - edge);
    if (distance > band) continue;
    if (!corners) { pinned[v] = 1; continue; }
    const span = Math.max(spanHi[id] - spanLo[id], 1e-6);
    const c = rest[v * 3 + cross];
    // Only the two ends of that edge, within the same relative band.
    if (Math.abs(c - spanLo[id]) <= span * PIN_BAND || Math.abs(c - spanHi[id]) <= span * PIN_BAND) pinned[v] = 1;
  }
  return pinned;
}

/**
 * How many of each island's particles a pin mode holds.
 *
 * A cloth whose every vertex is pinned is not a cloth — it is the original
 * mesh, simulated at full cost and unable to move by construction. That is a
 * silent failure of exactly the kind this feature must not ship: the component
 * would look enabled, cost real frames, and change nothing on screen. It is
 * detected here so `analyseClothMesh` can say so in words.
 */
export function pinnedPerIsland(pinned, island, islandCount) {
  const held = new Uint32Array(islandCount);
  const total = new Uint32Array(islandCount);
  for (let v = 0; v < pinned.length; v++) {
    const id = island[v];
    if (id < 0) continue;
    total[id]++;
    if (pinned[v]) held[id]++;
  }
  return { held, total };
}

/**
 * Analyse a geometry and, if it is cloth-shaped, produce everything the solver
 * needs. Never throws: an unusable mesh comes back with `ok: false` and a
 * `reason` written for the person who has to act on it.
 *
 * @param {{ positions: ArrayLike<number>, indices: ?ArrayLike<number> }} source
 * @param {{ pinning?: string, maxParticles?: number, thinnessLimit?: number }} [options]
 */
/**
 * ⛔⛔ A CONTACT CANNOT BE THICKER THAN THE CLOTH IT PUSHES.
 *
 * A shell cloth has two faces. A contact pushes whatever it touches to
 * `collisionRadius` clear of the collider — BOTH faces — so the shell needs
 * `2 x radius` of its own thickness or the near face is driven straight
 * through the far one. And the thickness springs are DISTANCE-ONLY: they are
 * perfectly satisfied with the shell inside-out, at exactly the same rest
 * length, so nothing ever un-inverts it. The cloth is left fighting itself and
 * never recovers — which is precisely what the user reported ("its like those
 * curtains are fighting themselves", and earlier "after I interact with the
 * cloth via my character, they get broken as well", 2026-09-08).
 *
 * Measured on Sponza at the authored `collisionRadius` of 0.03 (so a 0.06 m
 * demand): **68 % of every curtain's shell is thinner than that, and on the
 * thin islands 68 % is thinner than the RADIUS ALONE** (median shell 0.0274 m).
 * Every curtain in the scene was one touch away from inverting; the two that
 * looked wrong were simply the two the character had walked into.
 *
 * ⚠⚠ AND THE PERCENTILE HAS TO BE LOW ENOUGH THAT **NOTHING** IS LEFT UNDER
 * `2 x cap` — which the first choice of 0.1 was not, by a margin that wrecked
 * a curtain. The constraint is `2 x radius <= shell`, so every spring below the
 * chosen percentile is GUARANTEED to have its two faces driven through each
 * other, and each one is a permanent inside-out patch. Measured on Sponza:
 *
 *     percentile   thin island          thick islands
 *      10 %        cap 1.09 cm ->  30   cap 2.19 cm -> 142  springs inverting
 *       5 %        cap 1.09 cm ->  30   cap 1.85 cm ->  78
 *       2 %        cap 1.09 cm ->  30   cap 1.43 cm ->   2
 *       1 %        cap 0.55 cm ->   0   cap 1.15 cm ->   0
 *
 * Thirty guaranteed inversions is plenty: the island carrying them measured a
 * mean structural strain of **0.795**, one particle moving **1.2 m between two
 * readbacks**, and a motion coherence of 0.56 against 0.96-0.99 for its two
 * healthy neighbours. It was the last curtain still visibly fighting itself.
 *
 * ⚠ Not the strict minimum: one degenerate pair would collapse the cap to
 * nothing and disable contact for the whole piece. 1 % is low enough to leave
 * the invariant clean on real geometry and still tolerate a stray.
 */
const SHELL_PERCENTILE = 0.01;

/**
 * ⛔⛔ PER ISLAND, AND THE FIRST VERSION WAS NOT.
 *
 * Shell thickness is a property of ONE PIECE OF CLOTH, and a `.geom` holds
 * several: Sponza's curtain file carries a 5.47 cm shell and a 2.74 cm shell
 * in the same asset. Taking the percentile over the whole file gave every
 * curtain the THINNEST one's number, so two curtains that could safely carry a
 * 2.19 cm contact were capped at 1.09 cm — half the contact they needed,
 * because of a different curtain somewhere else in the file.
 *
 * The user found this from the outside: *"this issue is related to the fact
 * that both curtains sit on the same geometry. One works well, another one does
 * not."* Any quantity describing A CLOTH must be reduced over that cloth's own
 * island, never over the file.
 *
 * ⚠ A LOW PERCENTILE, NOT THE MEDIAN — within an island too. The constraint
 * has to hold where that shell is THINNEST; a median lets the thin third
 * invert while the number still looks comfortable.
 */
function shellThicknessPerIsland(thickness, rest, island, islandCount) {
  const lengths = Array.from({ length: Math.max(islandCount, 1) }, () => []);
  if (thickness?.size) {
    for (const [a, b] of thickness.values()) {
      const id = island[a];
      if (id < 0 || id >= lengths.length) continue;
      lengths[id].push(Math.hypot(
        rest[a * 3] - rest[b * 3],
        rest[a * 3 + 1] - rest[b * 3 + 1],
        rest[a * 3 + 2] - rest[b * 3 + 2],
      ));
    }
  }
  return lengths.map((list) => {
    if (!list.length) return 0;
    list.sort((x, y) => x - y);
    return list[Math.min(list.length - 1, Math.floor(list.length * SHELL_PERCENTILE))];
  });
}

/**
 * The largest contact radius this cloth can carry without inverting its own
 * shell. Half the thickness would let the two faces meet exactly; the margin
 * keeps them apart under a push. Returns `Infinity` for a cloth with no shell
 * (a single-surface sheet has nothing to invert), so the authored value stands.
 */
export function clothContactRadiusLimit(shellThickness) {
  return shellThickness > 0 ? shellThickness * 0.4 : Infinity;
}

/**
 * ⭐⭐⭐ LONG-RANGE ATTACHMENTS — A HARD CEILING ON HOW FAR CLOTH CAN GET FROM
 * ITS PIN (Kim, Chentanez & Müller-Fischer 2012).
 *
 * A Jacobi solve propagates a constraint ONE RING PER PASS. The Sponza curtain
 * is ~60 rings from its pinned hem to its bottom edge, and the solver runs 8
 * passes over 2 substeps — so the pin's influence physically cannot reach the
 * hem in a frame. Gravity pulls every frame, the pin answers 60 frames later,
 * and the error compounds. Measured live: island 0 went from a worst
 * structural strain of **4.70 to 15.01 while I watched it** — a spring at
 * sixteen times its rest length. That is divergence, and more passes cannot
 * fix a diverging solve; it needs a bound that does not depend on iteration.
 *
 * This is that bound. A particle can never be further from its pin than the
 * fabric between them is long — that distance is a property of the MESH, known
 * before the first frame, and it is enforced in one step regardless of how far
 * away the pin is. It is applied inside the existing constraint kernel, so it
 * costs **no extra dispatch** in a solver that is launch-bound.
 *
 * ⚠ The distance is GEODESIC — measured along the cloth, not through space.
 * A straight-line distance would let a curtain hang through a wall to reach
 * its pin, and would be wrong for any piece that is not flat.
 *
 * Pins are static in local space (`constrainMesh` assigns `initial()` to every
 * pinned particle every pass), so the target position is baked here rather
 * than looked up per frame.
 */
export function longRangeAttachments(rest, count, offsets, neighbours, pinned, weight = null, successor = null) {
  const out = new Float32Array(count * 4);
  if (!count) return out;
  const distance = new Float64Array(count).fill(Infinity);
  const source = new Int32Array(count).fill(-1);

  // Multi-source Dijkstra from every pinned vertex at once: each vertex ends
  // up holding the distance to its NEAREST pin along the fabric.
  const heap = [];
  const push = (node, d) => {
    heap.push([d, node]);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let small = i;
        if (l < heap.length && heap[l][0] < heap[small][0]) small = l;
        if (r < heap.length && heap[r][0] < heap[small][0]) small = r;
        if (small === i) break;
        [heap[small], heap[i]] = [heap[i], heap[small]];
        i = small;
      }
    }
    return top;
  };

  for (let v = 0; v < count; v++) {
    if (!pinned[v]) continue;
    distance[v] = 0;
    source[v] = v;
    push(v, 0);
  }
  // A piece with no pin at all has nothing to attach to; `w = 0` is the
  // sentinel the solver reads as "no constraint here".
  if (!heap.length) return out;

  while (heap.length) {
    const [d, v] = pop();
    if (d > distance[v]) continue;
    for (let i = offsets[v]; i < offsets[v + 1]; i++) {
      const u = neighbours[i];
      if (u < 0 || u >= count) continue;
      // ⛔⛔ STRUCTURAL EDGES ONLY. The merged graph also carries BEND springs,
      // which span two rings, and THICKNESS springs, which jump through the
      // shell to the far face. Both are SHORTCUTS: walking them lets Dijkstra
      // cut corners across the folds, so the "fabric distance" comes out
      // shorter than the cloth actually is and the limit reels the curtain in.
      //
      // Measured, when this filter was missing: all three Sponza islands were
      // HOISTED — centres at y 2.56-2.66 against 1.11 when hanging correctly,
      // height 0.96 m of a 2.26 m drop. A constraint derived from the wrong
      // graph is worse than no constraint, because it pulls.
      if (weight && weight[i] > 0.5) continue;
      if (successor && successor[i] === -2) continue;
      const step = Math.hypot(
        rest[u * 3] - rest[v * 3],
        rest[u * 3 + 1] - rest[v * 3 + 1],
        rest[u * 3 + 2] - rest[v * 3 + 2],
      );
      const next = d + step;
      if (next < distance[u]) { distance[u] = next; source[u] = source[v]; push(u, next); }
    }
  }

  for (let v = 0; v < count; v++) {
    const pin = source[v];
    if (pin < 0 || !Number.isFinite(distance[v])) continue; // unreachable: leave w = 0
    out[v * 4] = rest[pin * 3];
    out[v * 4 + 1] = rest[pin * 3 + 1];
    out[v * 4 + 2] = rest[pin * 3 + 2];
    // ⚠ A HAIR OF SLACK. Enforced at exactly the geodesic length the cloth
    // could never drape at all — a hanging sheet is always a little shorter
    // than its own fabric once it folds, and clamping to the taut length would
    // hold every particle out on a rigid string.
    out[v * 4 + 3] = distance[v] * LRA_SLACK;
  }
  return out;
}

/**
 * ⭐⭐⭐ COLLAPSE A SHELL ONTO ITS MID-SURFACE.
 *
 * ⛔ THE GEOMETRY THAT FORCED THIS. Sponza's curtains are shells 1.4-2.9 cm
 * thick built from triangles ~9 cm wide: **the two faces are six times closer
 * together than the triangles are wide.** Simulating that as two independent
 * sheets held apart by distance-only springs is the failure itself, not a
 * tuning problem — a contact pushes BOTH faces clear of a collider, so it
 * needs `2 x radius` of thickness, and there is no radius small enough to be
 * safe at 1.4 cm. The cap was already down to 0.55 cm and the shell still tore
 * (`worstShell` 19.97, mean shell strain 1.661).
 *
 * So there is no shell to invert any more. Each front vertex is paired with
 * its back vertex, the pair is simulated as ONE particle at their midpoint,
 * and the render mesh reconstructs both faces by stepping along the surface
 * normal. Halves the particle count as a side effect.
 *
 * ⚠ MUTUAL BEST ONLY. `buildThicknessSprings` gives each vertex its own
 * nearest partner, which is not symmetric: v can choose u while u chooses w.
 * Collapsing a non-mutual chain would weld three vertices into one and pucker
 * the sheet, so only mutual pairs collapse and everything else stays its own
 * particle — a cloth with no shell at all therefore passes through unchanged.
 */
export function collapseShellToMidSurface(rest, count, triangles, pairs, adjacency = null) {
  const partner = new Int32Array(count).fill(-1);
  // ⚠ SHORTEST FIRST. Each vertex nominates its own nearest partner and that
  // is NOT symmetric, so whoever is processed first wins and the loser is
  // stranded. Taking the closest candidates first strands far fewer, and the
  // ones it does strand are the least shell-like.
  const candidates = [...pairs.values()].map(([a, b]) => [a, b, Math.hypot(
    rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2],
  )]).sort((x, y) => x[2] - y[2]);
  for (const [a, b] of candidates) {
    // Both sides free keeps the relation a matching by construction.
    if (partner[a] === -1 && partner[b] === -1) { partner[a] = b; partner[b] = a; }
  }

  /**
   * ⛔⛔ AN UNPAIRED VERTEX IS NOT ON THE MID-SURFACE, AND TREATING IT AS IF IT
   * WERE IS WHAT CRUMPLED THE CLOTH.
   *
   * The first version made every unpaired vertex its own particle AT ITS OWN
   * POSITION, so the render step `mid + normal * offset` gave it offset 0 —
   * it drew ON the mid-surface while every neighbour drew a half-thickness
   * out. Measured on the real curtains that is **430 of 2 306 vertices
   * (18.6 %), none of them on the rim, all interior**: a 2.2 cm step at nearly
   * one vertex in five, scattered through the mesh. The user photographed the
   * result as a curtain "squashed in places" — sharp vertical pleats with
   * V-notches, which is exactly what a field of one-in-five potholes looks
   * like once it is lit.
   *
   * So a stranded vertex is pushed onto the mid-surface instead. Its paired
   * NEIGHBOURS know where that is: each of them spans the shell, so half their
   * span is the local offset vector, and a vertex on the same face shares its
   * direction. Averaging those gives both the direction and the thickness
   * without needing a partner of its own.
   */
  const halfOffset = new Float32Array(count * 3);
  if (adjacency?.offsets && adjacency?.neighbours) {
    const { offsets, neighbours } = adjacency;
    for (let v = 0; v < count; v++) {
      if (partner[v] >= 0) continue;
      let x = 0, y = 0, z = 0, n = 0;
      for (let i = offsets[v]; i < offsets[v + 1]; i++) {
        const u = neighbours[i], w = partner[u];
        if (u < 0 || w < 0) continue;
        // u sits a half-thickness off the mid-surface, in the direction v also
        // lies — u and v are neighbours on the SAME face.
        x += (rest[u * 3] - rest[w * 3]) / 2;
        y += (rest[u * 3 + 1] - rest[w * 3 + 1]) / 2;
        z += (rest[u * 3 + 2] - rest[w * 3 + 2]) / 2;
        n++;
      }
      if (!n) continue; // no paired neighbour to learn from: leave it in place
      halfOffset[v * 3] = x / n;
      halfOffset[v * 3 + 1] = y / n;
      halfOffset[v * 3 + 2] = z / n;
    }
  }

  const midOf = new Int32Array(count).fill(-1);
  const midRest = [];
  for (let v = 0; v < count; v++) {
    if (midOf[v] >= 0) continue;
    const u = partner[v];
    const id = midRest.length / 3;
    if (u >= 0) {
      midRest.push((rest[v * 3] + rest[u * 3]) / 2, (rest[v * 3 + 1] + rest[u * 3 + 1]) / 2, (rest[v * 3 + 2] + rest[u * 3 + 2]) / 2);
      midOf[v] = id; midOf[u] = id;
    } else {
      // Stranded: step back along the local shell offset so this particle
      // lands where the mid-surface actually is. `shellOffsets` then measures
      // a real offset for it rather than zero.
      midRest.push(
        rest[v * 3] - halfOffset[v * 3],
        rest[v * 3 + 1] - halfOffset[v * 3 + 1],
        rest[v * 3 + 2] - halfOffset[v * 3 + 2],
      );
      midOf[v] = id;
    }
  }

  // Triangles lifted onto the mid vertices. The front face and the back face
  // become the SAME triangle (opposite winding), and every rim triangle that
  // stitched them collapses to a degenerate sliver — both are dropped.
  const midTriangles = [];
  const seen = new Set();
  for (let t = 0; t < triangles.length; t += 3) {
    const a = midOf[triangles[t]], b = midOf[triangles[t + 1]], c = midOf[triangles[t + 2]];
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    midTriangles.push(a, b, c);
  }
  return {
    midOf,
    partner,
    rest: Float32Array.from(midRest),
    count: midRest.length / 3,
    triangles: Uint32Array.from(midTriangles),
    collapsed: (() => { let n = 0; for (let v = 0; v < count; v++) if (partner[v] >= 0) n++; return n / 2; })(),
  };
}

/**
 * How far each ORIGINAL welded vertex sits from its mid particle, signed along
 * the mid-surface's own rest normal. The render mesh is rebuilt as
 * `mid + normal * offset`, and the solver's fan normal is the same normal, so
 * the shell follows the cloth as it moves instead of being frozen into it.
 */
export function shellOffsets(rest, count, midOf, mid) {
  const normals = new Float32Array(mid.count * 3);
  for (let t = 0; t < mid.triangles.length; t += 3) {
    const [a, b, c] = [mid.triangles[t], mid.triangles[t + 1], mid.triangles[t + 2]];
    const ux = mid.rest[b * 3] - mid.rest[a * 3], uy = mid.rest[b * 3 + 1] - mid.rest[a * 3 + 1], uz = mid.rest[b * 3 + 2] - mid.rest[a * 3 + 2];
    const vx = mid.rest[c * 3] - mid.rest[a * 3], vy = mid.rest[c * 3 + 1] - mid.rest[a * 3 + 1], vz = mid.rest[c * 3 + 2] - mid.rest[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { normals[v * 3] += nx; normals[v * 3 + 1] += ny; normals[v * 3 + 2] += nz; }
  }
  for (let v = 0; v < mid.count; v++) {
    const l = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    if (l > 1e-12) { normals[v * 3] /= l; normals[v * 3 + 1] /= l; normals[v * 3 + 2] /= l; }
  }
  const offset = new Float32Array(count);
  for (let v = 0; v < count; v++) {
    const m = midOf[v];
    if (m < 0) continue;
    offset[v] = (rest[v * 3] - mid.rest[m * 3]) * normals[m * 3]
      + (rest[v * 3 + 1] - mid.rest[m * 3 + 1]) * normals[m * 3 + 1]
      + (rest[v * 3 + 2] - mid.rest[m * 3 + 2]) * normals[m * 3 + 2];
  }
  return { offset, normals };
}

export function analyseClothMesh(source, options = {}) {
  const positions = source?.positions;
  const reject = (reason) => ({ ok: false, reason, notes: [] });
  if (!positions || positions.length < 9) return reject("the mesh has no vertices");

  const vertexCount = positions.length / 3;
  const indices = source.indices ?? null;
  const triangleCount = (indices ? indices.length : vertexCount) / 3;
  if (!(triangleCount >= 1)) return reject("the mesh has no triangles");

  // ── WELD ────────────────────────────────────────────────────────────────
  const buckets = new Map();
  const simOf = new Uint32Array(vertexCount);
  const restList = [];
  const quantum = 1 / WELD_EPSILON;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return reject("the mesh has non-finite vertex positions");
    const key = `${Math.round(x * quantum)},${Math.round(y * quantum)},${Math.round(z * quantum)}`;
    let id = buckets.get(key);
    if (id === undefined) {
      id = restList.length / 3;
      buckets.set(key, id);
      restList.push(x, y, z);
    }
    simOf[v] = id;
  }
  const count = restList.length / 3;
  const rest = Float32Array.from(restList);

  const maxParticles = options.maxParticles ?? CLOTH_MAX_PARTICLES;
  if (count > maxParticles) {
    return reject(`${count} simulated vertices is over the ${maxParticles} limit — decimate the mesh, or raise __clothMaxParticles`);
  }

  const triangles = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount * 3; t++) triangles[t] = simOf[indices ? indices[t] : t];

  // ── SHAPE ───────────────────────────────────────────────────────────────
  const { island, count: islandCount } = connectedIslands(triangles, count);
  const members = Array.from({ length: islandCount }, () => []);
  for (let v = 0; v < count; v++) if (island[v] >= 0) members[island[v]].push(v);

  const islands = members.map((list) => {
    const extents = principalExtents(rest, list);
    const thickest = extents[0] || 1e-9;
    return { vertices: list.length, extents, thinness: extents[2] / thickest };
  });
  const thinnessLimit = options.thinnessLimit ?? CLOTH_THINNESS_LIMIT;
  // The WORST piece decides. A boat whose sail is cloth and whose hull is not
  // must be rejected as one mesh rather than half-simulated: the author's fix
  // is to split the sail out, and a half-draped boat would hide that from them.
  const worst = islands.reduce((a, b) => (a.thinness > b.thinness ? a : b), islands[0] ?? { thinness: 1 });
  if (!(worst.thinness <= thinnessLimit)) {
    return {
      ok: false,
      reason: `this mesh is solid, not sheet-like (thickness is ${(worst.thinness * 100).toFixed(0)}% of its longest axis, `
        + `and cloth needs ${(thinnessLimit * 100).toFixed(0)}% or less). Separate the flat pieces into their own mesh.`,
      notes: [],
      islands,
    };
  }

  const springs = buildSprings(triangles, rest, count);
  if (springs.structural === 0) return reject("the mesh has no usable edges (every triangle is degenerate)");

  // ── BIND THE SHELL'S TWO FACES ──────────────────────────────────────────
  // The radius is each piece's own thinnest principal extent, generously
  // doubled: a shell's faces sit exactly that far apart, and anything further
  // is a fold rather than the opposite side.
  const radiusOf = islands.map((island) => island.extents[2] * THICKNESS_SEARCH);
  const thickness = options.thickness === false
    ? new Map()
    : buildThicknessSprings(rest, count, springs.offsets, springs.neighbours, radiusOf, island);
  // ── COLLAPSE THE SHELL, AND RE-ENTER ────────────────────────────────────
  //
  // ⭐⭐⭐ Sponza's curtains are shells 1.4-2.9 cm thick made of triangles ~9 cm
  // wide, and every remaining failure was the shell tearing itself apart
  // (`worstShell` 19.97). A contact pushes BOTH faces clear of a collider, so
  // it needs `2 x radius` of thickness — at 1.4 cm no radius is small enough,
  // and the cap was already down to 0.55 cm. Simulating two faces that close
  // together is the fault, not a setting.
  //
  // So the pair is collapsed to its midpoint and the WHOLE analysis re-enters
  // on the result: springs, pinning, islands and the contact cap are all
  // recomputed by the same code on a mesh that has no second face left to
  // invert. `simOf` is re-pointed through the collapse and each render vertex
  // keeps a signed offset along the surface normal, which the render kernel
  // steps along to rebuild both faces.
  //
  // ⚠ `__collapsed` stops it recursing forever: the mid mesh has no shell, so
  // a second pass would find no pairs, but the guard makes that a fact rather
  // than a hope.
  // ⛔⛔ OFF BY DEFAULT — THE COLLAPSE ONLY PARTIALLY FUSES, AND A HALF-FUSED
  // SHELL IS WORSE THAN AN UNFUSED ONE.
  //
  // It removes shell inversion outright when it works (`worstShell` 19.97 ->
  // 0.02) and it halves the particle count, but it depends on every front
  // vertex having a mutual partner on the back face, and on real geometry the
  // two faces DO NOT CORRESPOND 1:1. Measured on the split Sponza curtains:
  //
  //     2306 verts -> 938 pairs, 430 stranded (18.6 %, all INTERIOR)
  //     sim triangles 3364 of a source 4608, where a clean collapse gives ~2300
  //
  // That excess is a thousand triangles surviving as OVERLAPPING front/back
  // sheets — two nearly-coincident surfaces sewn together, which is a corrupt
  // simulation mesh however well the solver behaves.
  //
  // Two attempts to rescue the stranded vertices both made it visibly worse:
  // leaving them at their own position renders them ON the mid-surface (a
  // pothole at one vertex in five), and projecting them onto it using their
  // neighbours' offsets put 32-44 of them on the WRONG SIDE, which folds the
  // render mesh back through itself. The user photographed all three curtains
  // failing in three different ways.
  //
  // `midSurface: true` opts back in. Making it viable needs the pairing to be
  // near-complete — which means matching the two faces properly rather than
  // taking one nearest-neighbour guess per vertex.
  if (thickness.size && options.midSurface === true && !options.__collapsed) {
    const mid = collapseShellToMidSurface(rest, count, triangles, thickness, springs);
    if (mid.collapsed > 0) {
      const inner = analyseClothMesh({ positions: mid.rest, indices: mid.triangles },
        { ...options, __collapsed: true });
      if (inner.ok) {
        const { offset } = shellOffsets(rest, count, mid.midOf, mid);
        // render vertex -> welded -> mid particle -> the inner analysis's own
        // welded id, since it welds again (a no-op here, but not assumed).
        const renderToSim = new Uint32Array(simOf.length);
        const renderOffset = new Float32Array(simOf.length);
        for (let r = 0; r < simOf.length; r++) {
          const welded = simOf[r];
          renderToSim[r] = inner.simOf[mid.midOf[welded]];
          renderOffset[r] = offset[welded];
        }
        return {
          ...inner,
          simOf: renderToSim,
          shellOffset: renderOffset,
          midSurface: true,
          collapsedPairs: mid.collapsed,
          shellVertexCount: count,
          notes: [
            ...inner.notes,
            `This mesh is a shell ${(2 * (offset.reduce((a, b) => a + Math.abs(b), 0) / Math.max(offset.length, 1)) * 100).toFixed(1)} cm thick. `
              + `Its two faces are simulated as ONE surface of ${inner.count} particles (down from ${count}) and rebuilt on either side, `
              + `because faces that close together cannot both be pushed clear of a collider without passing through each other.`,
          ],
        };
      }
    }
  }

  const bound = thickness.size ? mergeSprings(springs, thickness, rest, count) : springs;
  const islandShell = shellThicknessPerIsland(thickness, rest, island, islandCount);
  // Reported for the whole cloth as the tightest of its pieces, purely so a
  // single number can be shown; the SOLVER reads the per-particle limit.
  const shellThickness = islandShell.reduce((a, b) => (b > 0 && (a === 0 || b < a) ? b : a), 0);

  let maxDegree = 0;
  for (let v = 0; v < count; v++) {
    const degree = bound.offsets[v + 1] - bound.offsets[v];
    if (degree > maxDegree) maxDegree = degree;
  }
  const degreeLimit = options.maxDegree ?? CLOTH_MAX_DEGREE;
  if (maxDegree > degreeLimit) {
    return {
      ok: false,
      reason: `one vertex has ${maxDegree} springs, over the ${degreeLimit} limit — this mesh has a fan or a pole `
        + `rather than an even sheet. Retopologise it, or raise __clothMaxDegree.`,
      notes: [], islands,
    };
  }

  // One limit per PARTICLE, from its own island's shell — see
  // `shellThicknessPerIsland`.
  const contactRadius = new Float32Array(count);
  for (let v = 0; v < count; v++) {
    const shell = island[v] >= 0 ? islandShell[island[v]] : 0;
    const limit = clothContactRadiusLimit(shell);
    contactRadius[v] = Number.isFinite(limit) ? limit : 0; // 0 = no shell, no cap
  }

  const pinned = clothPinFlags(rest, island, islandCount, options.pinning ?? "top");
  const { held, total } = pinnedPerIsland(pinned, island, islandCount);
  const frozen = [];
  for (let id = 0; id < islandCount; id++) if (total[id] > 0 && held[id] === total[id]) frozen.push(id);
  const loose = [];
  for (let id = 0; id < islandCount; id++) if (total[id] > 0 && held[id] === 0) loose.push(id);
  if (frozen.length === islandCount) {
    return {
      ok: false,
      reason: `every vertex would be pinned, so nothing could move. Pin a different edge, or use Anchors.`,
      notes: [], islands,
    };
  }
  if (loose.length === islandCount && (options.pinning ?? "top") !== "none") {
    return {
      ok: false,
      reason: `no vertex can be pinned: every piece lies flat against the "${options.pinning ?? "top"}" axis, `
        + `so it has no edge there. Pin a different edge, or set Pinning to None to let it fall free.`,
      notes: [], islands,
    };
  }

  const notes = [];
  if (loose.length) {
    notes.push(`${loose.length} of ${islandCount} pieces lie flat against the pinned axis and are held by nothing — they will fall unless anchored.`);
  }
  if (frozen.length) {
    notes.push(`${frozen.length} of ${islandCount} pieces are pinned on every vertex and will not move — they lie flat against the pinned axis.`);
  }
  if (islandCount > 1) {
    notes.push(`${islandCount} separate pieces in one mesh — each drapes on its own and is pinned on its own edge.`);
  }
  notes.push("Shear has no effect on a mesh cloth: a triangle already resists shear through its own edges. Stiffness drives the mesh edges, Bend the folds across them.");
  // The user cannot see why their authored radius stopped taking effect, and
  // the alternative — honouring it — turns the cloth inside out on first
  // contact and never lets go.
  const shells = islandShell.filter((v) => v > 0);
  if (shells.length) {
    const lo = Math.min(...shells), hi = Math.max(...shells);
    const range = hi - lo > 1e-4
      ? `${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)} cm thick depending on the piece, so Collision Radius is capped `
        + `per piece at ${(clothContactRadiusLimit(lo) * 100).toFixed(1)}-${(clothContactRadiusLimit(hi) * 100).toFixed(1)} cm`
      : `${(lo * 100).toFixed(1)} cm thick, so Collision Radius is capped at ${(clothContactRadiusLimit(lo) * 100).toFixed(1)} cm`;
    notes.push(`This cloth is a shell ${range}. A contact pushes BOTH faces clear of the collider, so a bigger radius `
      + `would drive one face through the other and the cloth could never recover.`);
  }

  return {
    ok: true,
    reason: null,
    notes,
    vertexCount,
    triangleCount,
    count,
    islandCount,
    islands,
    shellThickness,
    islandShell,
    contactRadius,
    simOf,
    rest,
    // The WELDED triangles the springs were built from — what a mid-surface
    // collapse has to lift onto its own vertices.
    triangles,
    island,
    pinned,
    lra: longRangeAttachments(rest, count, bound.offsets, bound.neighbours, pinned, bound.weight, bound.successor),
    pinnedCount: pinned.reduce((a, b) => a + b, 0),
    maxDegree,
    ...bound,
  };
}

/**
 * Pack an analysis into the two flat arrays the solver binds.
 *
 * ⭐ FIXED STRIDE, NOT CSR RANGES. The obvious layout is a range buffer plus a
 * flat neighbour array, which is exact and costs two storage bindings. The
 * cloth solver already binds positions, previous, scratch, anchors and both
 * collider fields, and WebGPU only guarantees eight per stage — so the graph
 * gets ONE binding, at `maxDegree` slots per particle with a sentinel for the
 * unused tail. Because the stride is the mesh's own measured maximum rather
 * than a guess, nothing is ever truncated; the padding is the only cost, and
 * on Sponza's curtain (median 12, max 16) that is a quarter of the buffer.
 *
 * Layouts, both `vec4` so the shader indexes them without bit unpacking:
 * · `rest`    — (x, y, z, pinned ? 1 : 0)
 * · `springs` — (neighbour, restLength, weight, fanSuccessor), `SPRING_END`
 *   in the neighbour lane to stop, and in the successor lane for a boundary
 *   edge or a dihedral spring (neither closes a triangle around this vertex)
 *
 * `weight` is 0 for a structural spring and 1 for a dihedral one, so the
 * shader mixes `stiffness` and `bend` with a single `mix()` instead of a
 * branch inside the innermost loop.
 */
export const SPRING_END = -1;

/**
 * A thickness spring's marker in the fan-successor lane.
 *
 * ⛔ IT NEEDED ITS OWN VALUE. A spring's family was readable from two lanes
 * until thickness arrived: structural was weight 0, dihedral weight 1, and a
 * boundary structural edge carried successor -1. A thickness spring is ALSO
 * weight 0 with no successor, so it became indistinguishable from a boundary
 * edge — and the edge-CONTACT walk, which asks for structural springs to sweep
 * along, started sweeping straight THROUGH the shell to the opposite face.
 * With 8 000 collider triangles in the scene that flung particles into spikes
 * (user, 2026-09-08: "half of the cloths started getting glitched").
 *
 * -2 keeps the normal fan's `w >= 0` test working untouched and gives contact
 * something to exclude.
 */
export const SPRING_THICKNESS = -2;

export function packClothTopology(analysis) {
  const { count, maxDegree, rest, pinned, offsets, neighbours, restLength, weight, simOf } = analysis;
  const restBuffer = new Float32Array(count * 4);
  for (let v = 0; v < count; v++) {
    restBuffer[v * 4] = rest[v * 3];
    restBuffer[v * 4 + 1] = rest[v * 3 + 1];
    restBuffer[v * 4 + 2] = rest[v * 3 + 2];
    restBuffer[v * 4 + 3] = pinned[v] ? 1 : 0;
  }
  const stride = Math.max(1, maxDegree);
  const springBuffer = new Float32Array(count * stride * 4);
  for (let v = 0; v < count; v++) {
    const base = v * stride * 4;
    let slot = 0;
    for (let i = offsets[v]; i < offsets[v + 1]; i++, slot++) {
      springBuffer[base + slot * 4] = neighbours[i];
      springBuffer[base + slot * 4 + 1] = restLength[i];
      springBuffer[base + slot * 4 + 2] = weight[i];
      springBuffer[base + slot * 4 + 3] = analysis.successor[i];
    }
    // ⛔ EVERY UNUSED SLOT, NOT JUST THE FIRST. This wrote the sentinel once
    // and left the rest of the tail zero-filled, on the assumption that the
    // shader's `Break()` would never reach it. It did reach it, and a
    // zero-filled slot is not inert: it reads as a spring to PARTICLE 0 with a
    // rest length of ZERO, so every particle was dragged toward particle 0.
    // That is the tearing the user photographed — the cloth smeared into
    // vertical threads. Reproduced on the CPU over the real curtain: worst
    // stretch 2 114x and a 10.7 x 66 x 52 m bounding box, against 1.58x and
    // 11.0 x 2.3 x 4.6 m when the tail is skipped.
    //
    // Correctness must not depend on control flow the data can make
    // unnecessary: filled with the sentinel throughout, a `>= 0` guard is
    // sufficient and `Break` becomes a pure optimisation.
    for (let pad = slot; pad < stride; pad++) springBuffer[base + pad * 4] = SPRING_END;
  }
  // Render vertex -> particle, as floats because a storage buffer of `float`
  // is what the surface kernel can index with. The render mesh KEEPS its seams
  // (they carry different UVs and normals), so it has more vertices than the
  // simulation does and every one of them reads its particle through this.
  const simIndex = Float32Array.from(simOf);
  return { rest: restBuffer, springs: springBuffer, simIndex, stride, count, renderCount: simOf.length,
    shellThickness: analysis.shellThickness ?? 0, lra: analysis.lra ?? null,
    contactRadius: analysis.contactRadius ?? null,
    // Per RENDER vertex: how far to step along the surface normal to put
    // this face back where it was authored. Null for a cloth with no shell.
    shellOffset: analysis.shellOffset ?? null };
}
