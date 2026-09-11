/**
 * ══ THE CLOTH ARENA — the CPU half ═══════════════════════════════════════════
 *
 * Every cloth in the scene is solved as ONE particle set: one storage buffer
 * for positions, one for the springs, one dispatch per step for all of them.
 * This module is the pure-JS half — layouts, packing, the triangle grid — so
 * it can be tested under node without a GPU; `clothArena.js` is the kernels.
 *
 * ⭐ WHY AN ARENA. The previous solver ran ~16 dispatches per substep PER
 * CLOTH (integrate, eight Jacobi passes, commits, a BVH contact per particle
 * per edge sweep) and ten curtains issued ~300 dispatches a frame — measured
 * at 26 ms of a 40 ms frame by `profile.frameCensus`, with the maths itself
 * worth two. three's own `webgpu_compute_cloth` runs TWO dispatches per step
 * at 360 Hz and looks better, because a small fixed step with one relaxation
 * per step converges further than a big step with eight ("Small Steps in
 * Physics Simulation", Macklin et al. 2019). So:
 *
 *   · a FIXED step of 1/360 s, the count varying with the frame (`clothSteps`)
 *   · ONE fused kernel per step: Verlet + one Jacobi spring pass + the
 *     fabric-length cap + contact, ping-ponging two position buffers
 *   · every cloth in the same dispatch, so ten cost what one costs
 *   · contact against a per-cloth UNIFORM GRID of the static triangles
 *     (`buildTriangleGrid`): one cell lookup and a handful of exact
 *     triangle tests per particle per step, instead of a BVH walk per
 *     particle per edge sweep
 *
 * ⚠ The step never changes size. A frame longer than `CLOTH_MAX_FRAME` is
 * clamped (slow motion under a hitch, never a launched curtain), and the
 * remainder is carried in an accumulator. Damping is authored per 1/120 s and
 * re-exponentiated for the real step, once, on the CPU.
 */
import { analyseClothMesh, longRangeAttachments, packClothTopology, SPRING_END } from "./clothMeshTopology.js";

export const CLOTH_STEP_HZ = 360;
export const CLOTH_STEP = 1 / CLOTH_STEP_HZ;
/** Frames longer than this are clamped: a loading stall is not cloth motion. */
export const CLOTH_MAX_FRAME = 1 / 20;
export const CLOTH_MAX_STEPS = Math.round(CLOTH_MAX_FRAME / CLOTH_STEP);
/** The step the authored `damping` ("velocity retention") is defined against. */
export const CLOTH_DAMPING_REFERENCE_STEP = 1 / 120;
/** Cloths a scene may solve at once — a uniform-array budget (16 vec4 rows each, well inside 64 KB). */
export const ARENA_MAX_CLOTHS = 128;
/** Particles the arena starts with; it doubles when a scene outgrows it. */
export const ARENA_INITIAL_CAPACITY = 8192;
/** The widest spring stride the arena starts with (Sponza's curtains measure 20). */
export const ARENA_INITIAL_STRIDE = 16;
/** Floats the collision buffer starts with (~8 MB); doubles on overflow. */
export const ARENA_INITIAL_COLLISION_FLOATS = 1 << 21;
/** Entity anchors across the whole arena. */
export const ARENA_MAX_ANCHORS = 32;

/** Per-cloth parameter rows (vec4 each) in the `params` uniform array. */
export const PARAM_ROWS = 16;
export const ROW = Object.freeze({
  WORLD: 0,        // 4 rows: the entity's world matrix, column-major
  INVERSE: 4,      // 4 rows: its inverse
  FORCES: 8,       // (gravity, damping per step, stiffness, bend)
  WIND: 9,         // (wind.xyz, gust)
  CONTACT: 10,     // (gust frequency, shear, contact radius, friction)
  SKIP: 11,        // (own primitive row to skip, own triangle owner to skip, scene collision on, fabric-length relaxation)
  GRID_ORIGIN: 12, // (grid origin.xyz, cell size; 0 = no grid)
  GRID_DIMS: 13,   // (cells x, y, z, first cell's float offset in the collision buffer)
  STATE: 14,       // (reset to rest this frame, enabled, Jacobi relaxation, unused)
  SPARE: 15,
});
/** Per-particle static rows (vec4 each): rest (xyz, pinned), fabric cap (pin.xyz, length), meta (cloth, contact cap, 0, 0). */
export const STATIC_STRIDE = 3;
/** Floats per packed collision triangle: a.xyz, owner, b.xyz, 0, c.xyz, 0. */
export const TRI_FLOATS = 12;
/** Spring families, in the spring's `z` lane. */
export const SPRING_STRUCTURAL = 0, SPRING_BEND = 1, SPRING_SHEAR = 2;
/**
 * Jacobi over-relaxation. With every correction averaged over the particle's
 * springs, 1 closes a lone spring exactly in one pass and anything under 2 is
 * stable; measured on the reference model (`cloth-arena.test.mjs`) 1 settles
 * a hanging sheet without ringing. `__clothRelax` overrides it live.
 */
export const CLOTH_RELAXATION = 1;
/** How hard the fabric-length cap pulls — see the solver's `lraRelax` history. */
export const CLOTH_LRA_RELAX = .5;
/** The triangle grid: at most this many cells an axis, cells no finer than this. */
export const GRID_MAX_CELLS_PER_AXIS = 40;
export const GRID_MIN_CELL = .1;
/** Slack past the cloth's own reach that the collision grid still covers. */
export const GRID_MARGIN = .3;
/** Plane cloth is capped here: 16 384 particles, past which the mesh analysis is the bottleneck. */
export const GRID_CLOTH_MAX_RESOLUTION = 128;

const finite = (v, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Number(v) : fallback));

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * How many fixed steps this frame runs, and what the accumulator keeps.
 *
 * ⛔ THE STEP IS FIXED; ONLY THE COUNT MOVES. Dividing a frame among a fixed
 * number of substeps (the old solver) made the step size a function of the
 * frame rate, and Jacobi's residual scales with h² — so the cloth sagged four
 * times further at 30 fps than at 60 and rang when the frame rate jittered.
 * Here 30 fps simply runs twelve steps instead of six.
 */
export function clothSteps(accumulator, frameSeconds) {
  const frame = Math.min(Math.max(Number(frameSeconds) || 0, 0), CLOTH_MAX_FRAME);
  let total = Math.max(0, accumulator) + frame;
  let count = Math.floor(total / CLOTH_STEP + 1e-9);
  if (count > CLOTH_MAX_STEPS) count = CLOTH_MAX_STEPS;
  total -= count * CLOTH_STEP;
  // Time the frame could not afford is dropped, never hoarded: owing a whole
  // frame's worth of steps to the next frame is how death spirals start.
  if (total > CLOTH_STEP) total = CLOTH_STEP;
  return { count, accumulator: total };
}

/** The per-step velocity retention for an authored per-1/120 s `damping`. */
export function dampingPerStep(damping) {
  return Math.pow(finite(damping, .99, 0, 1), CLOTH_STEP / CLOTH_DAMPING_REFERENCE_STEP);
}

/* -------------------------------------------------------------------------- */
/* A plane's lattice, as a mesh topology                                       */
/* -------------------------------------------------------------------------- */

/** The grid pin modes, in the order the old solver numbered them. */
export const GRID_PIN_MODES = ["top", "topCorners", "left", "leftCorners", "none"];

/**
 * A plane cloth's lattice in the SAME format a mesh cloth uses, so the solver
 * has one path. Row-major, `iy * n + ix`, the top row at `y = height` — the
 * old grid solver's layout, which entity anchors (`resolveClothAnchors`) and
 * GI's lattice sampling both index by.
 *
 * Springs are the mesh analysis's own (every triangle edge, and the dihedral
 * across each edge) plus the quad's OTHER diagonal as a `SPRING_SHEAR`
 * spring, so a quad is cross-braced both ways as three's example is.
 */
export function buildGridClothTopology({ resolution = 32, width = 4, height = 4, pinning = "top" } = {}) {
  const n = Math.round(finite(resolution, 32, 4, GRID_CLOTH_MAX_RESOLUTION));
  const w = finite(width, 4, .001, 1e6), h = finite(height, 4, .001, 1e6);
  const dx = w / (n - 1), dy = h / (n - 1);
  const count = n * n;
  const positions = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const indices = [];
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const i = iy * n + ix;
    positions[i * 3] = ix * dx - w / 2;
    positions[i * 3 + 1] = h - iy * dy;
    positions[i * 3 + 2] = 0;
    uv[i * 2] = ix / (n - 1);
    uv[i * 2 + 1] = 1 - iy / (n - 1);
    if (ix < n - 1 && iy < n - 1) indices.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
  }
  const analysis = analyseClothMesh({ positions, indices: Uint32Array.from(indices) }, { pinning: "none", thickness: false, maxParticles: count, maxDegree: 64 });
  if (!analysis.ok) throw new Error(`grid cloth analysis failed: ${analysis.reason}`);
  // Pins by mode, exactly as the lattice solver decided them.
  const mode = Math.max(0, GRID_PIN_MODES.indexOf(pinning ?? "top"));
  const pinned = new Uint8Array(count);
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const top = iy === 0, left = ix === 0;
    const corner = ix === 0 || ix === n - 1, end = iy === 0 || iy === n - 1;
    pinned[iy * n + ix] = mode === 0 ? top : mode === 1 ? top && corner : mode === 2 ? left : mode === 3 ? left && end : false;
  }
  // The other diagonal of every quad, both directions, as shear springs.
  const extra = Array.from({ length: count }, () => []);
  for (let iy = 0; iy < n - 1; iy++) for (let ix = 0; ix < n - 1; ix++) {
    const a = iy * n + ix + 1, b = (iy + 1) * n + ix;
    const rest = Math.hypot(dx, dy);
    extra[a].push([b, rest]); extra[b].push([a, rest]);
  }
  const offsets = new Uint32Array(count + 1);
  for (let v = 0; v < count; v++) offsets[v + 1] = offsets[v] + (analysis.offsets[v + 1] - analysis.offsets[v]) + extra[v].length;
  const total = offsets[count];
  const neighbours = new Uint32Array(total), restLength = new Float32Array(total), weight = new Float32Array(total), successor = new Int32Array(total);
  let maxDegree = 0;
  for (let v = 0; v < count; v++) {
    let k = offsets[v];
    for (let i = analysis.offsets[v]; i < analysis.offsets[v + 1]; i++, k++) {
      neighbours[k] = analysis.neighbours[i]; restLength[k] = analysis.restLength[i];
      weight[k] = analysis.weight[i]; successor[k] = analysis.successor[i];
    }
    for (const [other, rest] of extra[v]) { neighbours[k] = other; restLength[k] = rest; weight[k] = SPRING_SHEAR; successor[k] = -1; k++; }
    maxDegree = Math.max(maxDegree, offsets[v + 1] - offsets[v]);
  }
  const rest = analysis.rest;
  const lra = longRangeAttachments(rest, count, offsets, neighbours, pinned, weight, successor);
  const merged = { ...analysis, offsets, neighbours, restLength, weight, successor, maxDegree, pinned, lra,
    pinnedCount: pinned.reduce((a, b) => a + b, 0), grid: { resolution: n, width: w, height: h, pinning: GRID_PIN_MODES[mode] } };
  const topology = packClothTopology(merged);
  return { topology, analysis: merged, render: { positions, uv, indices: Uint32Array.from(indices), resolution: n } };
}

/* -------------------------------------------------------------------------- */
/* The arena's particle ranges                                                 */
/* -------------------------------------------------------------------------- */

/**
 * First-fit allocation of particle ranges over a fixed capacity.
 *
 * ⛔ NO COMPACTION. The GPU owns the live positions and nothing on the CPU
 * mirrors them, so moving a member's range would lose its pose. A member keeps
 * its range for life; a freed range is reused by whatever fits it next, and
 * only outgrowing the capacity rebuilds everything (which resets every cloth,
 * once, deliberately).
 */
export class ArenaLayout {
  constructor(capacity) {
    this.capacity = Math.max(1, Math.floor(capacity));
    /** @type {Array<{ base: number, count: number, member: any }>} sorted by base */
    this.ranges = [];
  }
  get highWater() { return this.ranges.length ? this.ranges[this.ranges.length - 1].base + this.ranges[this.ranges.length - 1].count : 0; }
  get used() { return this.ranges.reduce((sum, r) => sum + r.count, 0); }
  allocate(count, member) {
    if (!(count > 0)) return -1;
    let cursor = 0;
    for (let i = 0; i <= this.ranges.length; i++) {
      const next = i < this.ranges.length ? this.ranges[i].base : this.capacity;
      if (next - cursor >= count) {
        this.ranges.splice(i, 0, { base: cursor, count, member });
        return cursor;
      }
      if (i < this.ranges.length) cursor = this.ranges[i].base + this.ranges[i].count;
    }
    return -1;
  }
  release(member) {
    const at = this.ranges.findIndex((r) => r.member === member);
    if (at < 0) return null;
    return this.ranges.splice(at, 1)[0];
  }
  rangeOf(member) { return this.ranges.find((r) => r.member === member) ?? null; }
}

/* -------------------------------------------------------------------------- */
/* Static per-particle data                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Write one member's topology into the arena's static and spring arrays at
 * `base`, rebasing every particle index the springs carry.
 *
 * ⛔ THE FAN SUCCESSOR IS A PARTICLE INDEX TOO. It rides in the spring's `w`
 * lane and the render kernel reads it as one; the first merge of several
 * cloths forgot to rebase it and lit every curtain with the normals of
 * another. `-1` (no fan) and `-2` (a thickness spring) are markers, not
 * indices, and stay as they are.
 */
export function writeMemberStatic({ statics, springs, stride }, topology, base, clothId) {
  const { count, rest, lra, contactRadius, springs: source, stride: sourceStride } = topology;
  if (sourceStride > stride) throw new Error(`spring stride ${sourceStride} exceeds the arena's ${stride}`);
  for (let v = 0; v < count; v++) {
    const s = (base + v) * STATIC_STRIDE * 4;
    statics[s] = rest[v * 4]; statics[s + 1] = rest[v * 4 + 1]; statics[s + 2] = rest[v * 4 + 2]; statics[s + 3] = rest[v * 4 + 3];
    if (lra) { statics[s + 4] = lra[v * 4]; statics[s + 5] = lra[v * 4 + 1]; statics[s + 6] = lra[v * 4 + 2]; statics[s + 7] = lra[v * 4 + 3]; }
    else { statics[s + 4] = 0; statics[s + 5] = 0; statics[s + 6] = 0; statics[s + 7] = 0; }
    statics[s + 8] = clothId; statics[s + 9] = contactRadius ? contactRadius[v] : 0; statics[s + 10] = 0; statics[s + 11] = 0;
    const d = (base + v) * stride * 4;
    for (let j = 0; j < stride; j++) {
      const o = d + j * 4;
      const src = j < sourceStride ? (v * sourceStride + j) * 4 : -1;
      const neighbour = src >= 0 ? source[src] : SPRING_END;
      if (neighbour < 0) { springs[o] = SPRING_END; springs[o + 1] = 0; springs[o + 2] = 0; springs[o + 3] = -1; continue; }
      springs[o] = neighbour + base;
      springs[o + 1] = source[src + 1];
      springs[o + 2] = source[src + 2];
      const successor = source[src + 3];
      springs[o + 3] = successor >= 0 ? successor + base : successor;
    }
  }
}

/** Mark a freed range as nobody's: the kernel skips a particle whose cloth is -1. */
export function clearMemberStatic({ statics }, base, count) {
  for (let v = 0; v < count; v++) statics[(base + v) * STATIC_STRIDE * 4 + 8] = -1;
}

/* -------------------------------------------------------------------------- */
/* The triangle grid                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A uniform grid over `box` listing, per cell, every triangle whose bounds
 * (grown by `radius`) touch it. A particle then tests only its own cell's
 * triangles — exact contacts, no traversal. Cells are cubes of at least
 * `GRID_MIN_CELL`, at most `maxCells` an axis.
 *
 * `triangles` are the shared field's rows (`{ vertices: number[9] }`);
 * `candidates` are their indices — the caller filters to what can reach this
 * cloth, and the items keep those GLOBAL indices, which is what the packed
 * collision buffer indexes triangles by.
 */
export function buildTriangleGrid(triangles, candidates, box, radius, { maxCells = GRID_MAX_CELLS_PER_AXIS, minCell = GRID_MIN_CELL } = {}) {
  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const longest = Math.max(size[0], size[1], size[2], 1e-3);
  const cell = Math.max(minCell, longest / maxCells);
  const dims = size.map((s) => Math.max(1, Math.min(maxCells, Math.ceil(s / cell + 1e-6))));
  const cellCount = dims[0] * dims[1] * dims[2];
  const counts = new Uint32Array(cellCount);
  const pad = Math.max(0, radius) + 1e-4;
  const ranges = [];
  for (const id of candidates) {
    const v = triangles[id].vertices;
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
      const a = Math.min(v[axis], v[axis + 3], v[axis + 6]) - pad, b = Math.max(v[axis], v[axis + 3], v[axis + 6]) + pad;
      lo[axis] = Math.max(0, Math.floor((a - box.min[axis]) / cell));
      hi[axis] = Math.min(dims[axis] - 1, Math.floor((b - box.min[axis]) / cell));
    }
    if (lo[0] > hi[0] || lo[1] > hi[1] || lo[2] > hi[2]) continue;
    ranges.push({ id, lo, hi });
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) counts[x + y * dims[0] + z * dims[0] * dims[1]]++;
  }
  const cells = new Uint32Array(cellCount + 1);
  for (let c = 0; c < cellCount; c++) cells[c + 1] = cells[c] + counts[c];
  const items = new Uint32Array(cells[cellCount]);
  const fill = new Uint32Array(cellCount);
  for (const { id, lo, hi } of ranges) {
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
      const c = x + y * dims[0] + z * dims[0] * dims[1];
      items[cells[c] + fill[c]++] = id;
    }
  }
  return { origin: [box.min[0], box.min[1], box.min[2]], cell, dims, cells, items, triangles: ranges.length };
}

/** The cell a world point falls in, or -1 outside the grid. */
export function gridCellOf(grid, x, y, z) {
  const cx = Math.floor((x - grid.origin[0]) / grid.cell), cy = Math.floor((y - grid.origin[1]) / grid.cell), cz = Math.floor((z - grid.origin[2]) / grid.cell);
  if (cx < 0 || cy < 0 || cz < 0 || cx >= grid.dims[0] || cy >= grid.dims[1] || cz >= grid.dims[2]) return -1;
  return cx + cy * grid.dims[0] + cz * grid.dims[0] * grid.dims[1];
}

/**
 * The collision buffer: `[triangles][every member's cells][every member's items]`
 * in one float array. Cells hold ABSOLUTE float offsets of their item runs, so
 * the kernel reads `buffer[cellBase + c]` .. `buffer[cellBase + c + 1]` and
 * then triangle ids from there. Returns the layout, or `null` when `target`
 * is too small (the caller grows it and packs again).
 */
export function packCollision(triangles, grids, target) {
  const triFloats = triangles.length * TRI_FLOATS;
  let cellFloats = 0, itemFloats = 0;
  for (const grid of grids) { if (!grid) continue; cellFloats += grid.cells.length; itemFloats += grid.items.length; }
  const total = triFloats + cellFloats + itemFloats;
  if (total > target.length) return null;
  for (let t = 0; t < triangles.length; t++) {
    const v = triangles[t].vertices, o = t * TRI_FLOATS;
    target[o] = v[0]; target[o + 1] = v[1]; target[o + 2] = v[2]; target[o + 3] = triangles[t].owner ?? -1;
    target[o + 4] = v[3]; target[o + 5] = v[4]; target[o + 6] = v[5]; target[o + 7] = 0;
    target[o + 8] = v[6]; target[o + 9] = v[7]; target[o + 10] = v[8]; target[o + 11] = 0;
  }
  const bases = [];
  let cellCursor = triFloats, itemCursor = triFloats + cellFloats;
  for (const grid of grids) {
    if (!grid) { bases.push(null); continue; }
    bases.push({ cellBase: cellCursor, itemBase: itemCursor });
    for (let c = 0; c < grid.cells.length; c++) target[cellCursor + c] = itemCursor + grid.cells[c];
    for (let k = 0; k < grid.items.length; k++) target[itemCursor + k] = grid.items[k];
    cellCursor += grid.cells.length;
    itemCursor += grid.items.length;
  }
  return { total, triangleCount: triangles.length, cellFloats, itemFloats, bases };
}

/** Does this triangle's box come within `pad` of `box`? */
export function triangleTouchesBox(vertices, box, pad = 0) {
  for (let axis = 0; axis < 3; axis++) {
    const lo = Math.min(vertices[axis], vertices[axis + 3], vertices[axis + 6]), hi = Math.max(vertices[axis], vertices[axis + 3], vertices[axis + 6]);
    if (hi + pad < box.min[axis] || lo - pad > box.max[axis]) return false;
  }
  return true;
}

/**
 * What a cloth's rest pose says about its reach, matrix-independent: its
 * local bounds, how many particles are pinned, and the longest run of fabric
 * from a pin. Computed once per topology; `clothReachBox` uses it per frame.
 */
export function clothRestBounds(topology) {
  const { count, rest, lra } = topology;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let fabric = 0, pins = 0;
  for (let v = 0; v < count; v++) {
    const x = rest[v * 4], y = rest[v * 4 + 1], z = rest[v * 4 + 2];
    lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z);
    hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z);
    if (rest[v * 4 + 3] > .5) pins++;
    if (lra && lra[v * 4 + 3] > fabric) fabric = lra[v * 4 + 3];
  }
  if (!(count > 0)) return { lo: [0, 0, 0], hi: [0, 0, 0], fabric: 0, pins: 0, count: 0 };
  return { lo, hi, fabric, pins, count };
}

/**
 * The world box a cloth can reach: its rest bounds through its matrix, grown
 * by the longest run of fabric from a pin (the fabric-length cap guarantees
 * nothing goes further) — or, with no pin to hang from, by several times its
 * own size, because a free sheet falls. Takes a topology or `clothRestBounds`.
 */
export function clothReachBox(topologyOrBounds, matrix, margin = GRID_MARGIN) {
  const bounds = topologyOrBounds.lo ? topologyOrBounds : clothRestBounds(topologyOrBounds);
  const { lo, hi, fabric, pins, count } = bounds;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let diag = 0;
  if (!(count > 0)) return { min: [0, 0, 0], max: [0, 0, 0], fabric: 0, pins: 0, radius: 0 };
  // The eight corners through the matrix (column-major, three's layout).
  const m = matrix;
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? hi[0] : lo[0], y = c & 2 ? hi[1] : lo[1], z = c & 4 ? hi[2] : lo[2];
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    min[0] = Math.min(min[0], wx); min[1] = Math.min(min[1], wy); min[2] = Math.min(min[2], wz);
    max[0] = Math.max(max[0], wx); max[1] = Math.max(max[1], wy); max[2] = Math.max(max[2], wz);
  }
  diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const scale = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]), 1e-6);
  let reach = (fabric > 0 ? fabric * scale : diag) + margin;
  const out = { min: min.map((v) => v - reach), max: max.map((v) => v + reach), fabric: fabric * scale, pins, radius: diag / 2 + reach };
  if (pins === 0) out.min[1] -= 4 * diag;    // a free sheet falls
  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-cloth parameters                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Write one cloth's parameter rows. `world`/`inverse` are 16-element
 * column-major arrays; everything else is authored or derived per frame.
 */
export function writeClothParams(rows, id, p) {
  const base = id * PARAM_ROWS * 4;
  const set = (row, x, y, z, w) => { const o = base + row * 4; rows[o] = x; rows[o + 1] = y; rows[o + 2] = z; rows[o + 3] = w; };
  for (let c = 0; c < 4; c++) {
    set(ROW.WORLD + c, p.world[c * 4], p.world[c * 4 + 1], p.world[c * 4 + 2], p.world[c * 4 + 3]);
    set(ROW.INVERSE + c, p.inverse[c * 4], p.inverse[c * 4 + 1], p.inverse[c * 4 + 2], p.inverse[c * 4 + 3]);
  }
  set(ROW.FORCES, finite(p.gravity, 9.81, -100, 100), dampingPerStep(p.damping), finite(p.stiffness, .95, 0, 1), finite(p.bend, .1, 0, 1));
  const wind = Array.isArray(p.wind) ? p.wind : [0, 0, 0];
  set(ROW.WIND, finite(wind[0], 0, -1000, 1000), finite(wind[1], 0, -1000, 1000), finite(wind[2], 0, -1000, 1000), finite(p.gust, 0, 0, 100));
  set(ROW.CONTACT, finite(p.gustFrequency, 1, 0, 10), finite(p.shear, 1, 0, 1), finite(p.collisionRadius, .03, .001, 1), finite(p.friction, .2, 0, 1));
  set(ROW.SKIP, p.skipPrimitive ?? -1, p.skipMesh ?? -1, p.sceneCollision === false ? 0 : 1, finite(p.lraRelax, CLOTH_LRA_RELAX, 0, 1));
  const grid = p.grid;
  if (grid) {
    set(ROW.GRID_ORIGIN, grid.origin[0], grid.origin[1], grid.origin[2], grid.cell);
    set(ROW.GRID_DIMS, grid.dims[0], grid.dims[1], grid.dims[2], grid.cellBase);
  } else { set(ROW.GRID_ORIGIN, 0, 0, 0, 0); set(ROW.GRID_DIMS, 0, 0, 0, 0); }
  set(ROW.STATE, p.reset ? 1 : 0, p.enabled === false ? 0 : 1, finite(p.relaxation, CLOTH_RELAXATION, 0, 1.95), 0);
  set(ROW.SPARE, 0, 0, 0, 0);
}
