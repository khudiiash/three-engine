/**
 * THE CLOTH ARENA, ON THE CPU MODEL.
 *
 * Every test here runs `stepClothArena` — the transliteration of the GPU step
 * kernel — over arrays packed by the same code the arena packs with. The
 * fixtures are chosen for what they can PROVE, not for what they look like:
 * a constant-acceleration fall (Verlet is exact for it, so the integrator's
 * scale is checked to 1e-4), a hanging sheet (sag, strain, settling), the same
 * steps taken in different frame sizes (step invariance is a bit-exact
 * equality here, not a tolerance), and a particle crossing a triangle at
 * 72 m/s (the swept test, not the proximity test, is what stops it).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Euler, Matrix4, Vector3 } from "three/webgpu";

import {
  ARENA_MAX_ANCHORS, CLOTH_MAX_STEPS, CLOTH_STEP, PARAM_ROWS, ROW, STATIC_STRIDE, TRI_FLOATS, SPRING_SHEAR, SPRING_STRUCTURAL,
  ArenaLayout, buildGridClothTopology, buildTriangleGrid, clearMemberStatic, clothReachBox, clothSteps, dampingPerStep,
  gridCellOf, packCollision, triangleTouchesBox, writeClothParams, writeMemberStatic,
} from "../src/engine/vfx/clothArenaPack.js";
import { createArenaState, seedRest, stepClothArena } from "../src/engine/vfx/clothArenaModel.js";
import { SPRING_END } from "../src/engine/vfx/clothMeshTopology.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const IDENTITY = new Matrix4().elements.slice();

/** A whole arena from members, primitives and static triangles, packed for real. */
function makeArena({ members, capacity = 4096, stride = 16, primitives = [], triangles = [], maxCloths = 8 }) {
  const state = createArenaState({ capacity, stride, collisionFloats: 1 << 18, maxCloths });
  const layout = new ArenaLayout(capacity);
  const built = members.map((member, id) => {
    const base = layout.allocate(member.topology.count, member);
    assert.ok(base >= 0, "the fixture fits its arena");
    writeMemberStatic(state, member.topology, base, id);
    seedRest(state, base, member.topology.count);
    const world = member.matrix ?? IDENTITY;
    const inverse = new Matrix4().fromArray(world).invert().elements.slice();
    return { ...member, id, base, count: member.topology.count, world, inverse };
  });
  state.count = layout.highWater;
  // Grids over each member's reach, packed into one collision buffer.
  const grids = built.map((m) => {
    if (!triangles.length) return null;
    const box = clothReachBox(m.topology, m.world);
    const candidates = triangles.map((_, i) => i).filter((i) => triangleTouchesBox(triangles[i].vertices, box, .1));
    return buildTriangleGrid(triangles, candidates, box, .1);
  });
  const packed = packCollision(triangles, grids, state.collision);
  assert.ok(packed, "the collision buffer fits");
  built.forEach((m, k) => {
    m.grid = grids[k] ? { ...grids[k], cellBase: packed.bases[k].cellBase } : null;
    writeClothParams(state.params, m.id, { world: m.world, inverse: m.inverse, gravity: 9.81, damping: .99, stiffness: 1, bend: .1, shear: 1, wind: [0, 0, 0], gust: 0, gustFrequency: 1, collisionRadius: .03, friction: .2, ...m.props, grid: m.grid });
  });
  primitives.forEach((row, k) => writePrimitive(state, k, row));
  state.primitiveCount = primitives.length;
  return { state, layout, members: built, packed };
}

function writePrimitive(state, k, { type, centre, radius = 0, axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half = [radius, radius, radius] }) {
  const b = k * 16;
  state.primitives[b] = type === "sphere" ? 1 : 0;
  state.primitives.set(centre, b + 1);
  for (let a = 0; a < 3; a++) { state.primitives.set(axes[a], b + 4 + a * 4); state.primitives[b + 7 + a * 4] = half[a]; }
}

/** A member's live LOCAL positions, one [x, y, z] per particle. */
function positionsOf(state, member) {
  const out = [];
  for (let v = 0; v < member.count; v++) out.push([state.read[(member.base + v) * 4], state.read[(member.base + v) * 4 + 1], state.read[(member.base + v) * 4 + 2]]);
  return out;
}
const toWorld = (m, p) => new Vector3(...p).applyMatrix4(new Matrix4().fromArray(m)).toArray();

function run(state, steps) { for (let i = 0; i < steps; i++) stepClothArena(state); }

/** Structural strain over a member from its topology's analysis. */
function strainOf(state, member) {
  const { offsets, neighbours, restLength, weight } = member.analysis;
  const pos = positionsOf(state, member);
  let sum = 0, n = 0, worst = 0;
  for (let v = 0; v < member.count; v++) for (let i = offsets[v]; i < offsets[v + 1]; i++) {
    if (weight[i] !== SPRING_STRUCTURAL) continue;
    const u = neighbours[i];
    const live = Math.hypot(pos[v][0] - pos[u][0], pos[v][1] - pos[u][1], pos[v][2] - pos[u][2]);
    const strain = Math.abs(live - restLength[i]) / restLength[i];
    sum += strain; n++; worst = Math.max(worst, strain);
  }
  return { mean: sum / n, worst };
}

const grid = (options) => { const g = buildGridClothTopology(options); return { topology: g.topology, analysis: g.analysis, render: g.render }; };

/* -------------------------------------------------------------------------- */
/* Packing                                                                     */
/* -------------------------------------------------------------------------- */

test("a plane's lattice is a mesh topology: counts, pins by mode, both diagonals", () => {
  const n = 8;
  const { topology, analysis } = grid({ resolution: n, width: 2, height: 1, pinning: "top" });
  assert.equal(topology.count, n * n);
  assert.equal(topology.renderCount, n * n);
  assert.equal(analysis.pinnedCount, n, "the top row is pinned");
  for (let ix = 0; ix < n; ix++) assert.equal(topology.rest[ix * 4 + 3], 1);
  assert.equal(topology.rest[(n * n - 1) * 4 + 3], 0, "the hem is free");
  // The top row sits at y = height, row-major exactly as the old lattice.
  assert.equal(topology.rest[1], 1);
  assert.equal(topology.rest[(n * (n - 1)) * 4 + 1], 0);
  // Every quad carries both diagonals: one structural, one shear.
  let shear = 0, structural = 0;
  for (let i = 0; i < analysis.weight.length; i++) { if (analysis.weight[i] === SPRING_SHEAR) shear++; if (analysis.weight[i] === SPRING_STRUCTURAL) structural++; }
  assert.equal(shear, 2 * (n - 1) * (n - 1), "one shear spring per quad, both directions");
  assert.equal(structural, 2 * (n * (n - 1) * 2 + (n - 1) * (n - 1)), "axis edges plus one diagonal per quad, both directions");
  for (const [mode, expected] of [["topCorners", 2], ["left", n], ["leftCorners", 2], ["none", 0]]) {
    assert.equal(grid({ resolution: n, pinning: mode }).analysis.pinnedCount, expected, mode);
  }
});

test("the lattice's fan successors close consistent triangles: every vertex normal faces +z", () => {
  const n = 6;
  const { topology } = grid({ resolution: n, width: 1, height: 1 });
  const { rest, springs, stride } = topology;
  for (let v = 0; v < n * n; v++) {
    const p = [rest[v * 4], rest[v * 4 + 1], rest[v * 4 + 2]];
    const normal = [0, 0, 0];
    let fans = 0;
    for (let j = 0; j < stride; j++) {
      const s = (v * stride + j) * 4;
      if (springs[s] < 0) break;
      if (springs[s + 3] < 0) continue;
      const a = springs[s], b = springs[s + 3];
      const pa = [rest[a * 4] - p[0], rest[a * 4 + 1] - p[1], rest[a * 4 + 2] - p[2]];
      const pb = [rest[b * 4] - p[0], rest[b * 4 + 1] - p[1], rest[b * 4 + 2] - p[2]];
      normal[2] += pa[0] * pb[1] - pa[1] * pb[0];
      fans++;
    }
    assert.ok(fans >= 1, `vertex ${v} has a fan`);
    assert.ok(normal[2] > 0, `vertex ${v} faces +z (${normal[2]})`);
  }
});

test("arena layout: first fit, release, reuse, and no compaction", () => {
  const layout = new ArenaLayout(100);
  const a = {}, b = {}, c = {};
  assert.equal(layout.allocate(40, a), 0);
  assert.equal(layout.allocate(30, b), 40);
  assert.equal(layout.allocate(40, c), -1, "no room");
  assert.equal(layout.highWater, 70);
  layout.release(a);
  assert.equal(layout.allocate(50, c), -1, "a freed 40 does not fit 50, and nothing moves");
  assert.equal(layout.allocate(30, c), 0, "a freed range is reused");
  assert.equal(layout.rangeOf(b).base, 40, "b stayed where it was");
  assert.equal(layout.used, 60);
});

test("⛔ merging rebases the neighbour AND the fan successor, keeps the markers, pads with the sentinel", () => {
  const one = grid({ resolution: 4, width: 1, height: 1 }).topology;
  const stride = 16;
  const state = createArenaState({ capacity: 64, stride });
  const layout = new ArenaLayout(64);
  const baseA = layout.allocate(one.count, "a"), baseB = layout.allocate(one.count, "b");
  writeMemberStatic(state, one, baseA, 0);
  writeMemberStatic(state, one, baseB, 1);
  assert.equal(baseB, 16);
  for (let v = 0; v < one.count; v++) {
    for (let j = 0; j < stride; j++) {
      const src = j < one.stride ? (v * one.stride + j) * 4 : -1;
      const dst = ((baseB + v) * stride + j) * 4;
      if (src < 0 || one.springs[src] < 0) { assert.equal(state.springs[dst], SPRING_END); continue; }
      assert.equal(state.springs[dst], one.springs[src] + baseB, "neighbour rebased");
      const successor = one.springs[src + 3];
      assert.equal(state.springs[dst + 3], successor >= 0 ? successor + baseB : successor, "successor rebased, markers kept");
    }
    assert.equal(state.statics[(baseB + v) * STATIC_STRIDE * 4 + 8], 1, "cloth id");
  }
  clearMemberStatic(state, baseA, one.count);
  assert.equal(state.statics[baseA * STATIC_STRIDE * 4 + 8], -1);
  assert.equal(state.statics[(baseB) * STATIC_STRIDE * 4 + 8], 1, "the neighbour is untouched");
});

test("the triangle grid never drops a triangle within reach of a point", () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const triangles = [];
  for (let t = 0; t < 120; t++) {
    const cx = random() * 4 - 2, cy = random() * 4 - 2, cz = random() * 4 - 2;
    const v = [];
    for (let k = 0; k < 3; k++) v.push(cx + random() * .6 - .3, cy + random() * .6 - .3, cz + random() * .6 - .3);
    triangles.push({ vertices: v, owner: t % 3 });
  }
  const box = { min: [-2.5, -2.5, -2.5], max: [2.5, 2.5, 2.5] };
  const radius = .05;
  const gridOut = buildTriangleGrid(triangles, triangles.map((_, i) => i), box, radius, { maxCells: 12 });
  const buffer = new Float32Array(1 << 16);
  const packed = packCollision(triangles, [gridOut], buffer);
  assert.ok(packed);
  const distance = (p, v) => {
    // Exact point–triangle distance, via the model's own routine through a resolve probe.
    let best = Infinity;
    const probe = { touched: false };
    const t = new Float32Array(TRI_FLOATS);
    t.set(v.slice(0, 3)); t.set(v.slice(3, 6), 4); t.set(v.slice(6, 9), 8);
    // brute force closest point: sample barycentrics
    for (let a = 0; a <= 20; a++) for (let b = 0; a + b <= 20; b++) {
      const u = a / 20, w = b / 20, s = 1 - u - w;
      const q = [u * v[0] + w * v[3] + s * v[6], u * v[1] + w * v[4] + s * v[7], u * v[2] + w * v[5] + s * v[8]];
      best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    void probe;
    return best;
  };
  let checked = 0;
  for (let n = 0; n < 200; n++) {
    // Points NEAR a triangle, or a box this size produces no near misses at all.
    const v = triangles[n % triangles.length].vertices;
    const u = random(), w = random() * (1 - u), s = 1 - u - w;
    const p = [0, 1, 2].map((k) => u * v[k] + w * v[3 + k] + s * v[6 + k] + (random() - .5) * .16);
    if (gridCellOf(gridOut, p[0], p[1], p[2]) < 0) continue;
    const cell = gridCellOf(gridOut, p[0], p[1], p[2]);
    assert.ok(cell >= 0);
    const start = buffer[packed.bases[0].cellBase + cell], end = buffer[packed.bases[0].cellBase + cell + 1];
    const listed = new Set();
    for (let k = start; k < end; k++) listed.add(buffer[k]);
    for (let t = 0; t < triangles.length; t++) {
      if (distance(p, triangles[t].vertices) <= radius * .95) { assert.ok(listed.has(t), `triangle ${t} near point ${n} is listed`); checked++; }
    }
  }
  assert.ok(checked > 0, "the fixture produced near misses to check");
  // The packed triangles round-trip.
  assert.equal(buffer[5 * TRI_FLOATS + 3], triangles[5].owner);
});

test("clothSteps: a fixed step, a count that follows the frame, a clamp on hitches", () => {
  let { count, accumulator } = clothSteps(0, 1 / 60);
  assert.equal(count, 6);
  assert.ok(accumulator < 1e-6);
  ({ count, accumulator } = clothSteps(accumulator, 1 / 30));
  assert.equal(count, 12);
  ({ count } = clothSteps(0, 1 / 100));
  assert.equal(count, 3, "1/100 s is 3.6 steps: three, and the rest carried");
  ({ count } = clothSteps(0, 2));
  assert.equal(count, CLOTH_MAX_STEPS, "a two-second stall is clamped, not simulated");
  ({ accumulator } = clothSteps(CLOTH_STEP * 3, 0));
  assert.ok(accumulator <= CLOTH_STEP, "the accumulator never hoards more than a step");
  assert.ok(Math.abs(dampingPerStep(.99) - Math.pow(.99, 1 / 3)) < 1e-12);
});

/* -------------------------------------------------------------------------- */
/* The solver                                                                  */
/* -------------------------------------------------------------------------- */

test("Verlet is exact under constant acceleration: a free sheet falls ½gt² to 1e-4", () => {
  const member = grid({ resolution: 4, width: 1, height: 1, pinning: "none" });
  const { state, members } = makeArena({ members: [{ ...member, props: { damping: 1, stiffness: 0 } }] });
  const before = positionsOf(state, members[0]);
  const steps = 180;   // half a second
  run(state, steps);
  const after = positionsOf(state, members[0]);
  const t = steps * CLOTH_STEP;
  // Verlet seeded with previous == current starts half a step "early", so a
  // fall from rest is exactly ½·g·t·(t + h) — the same in three's example.
  const expected = .5 * 9.81 * t * (t + CLOTH_STEP);
  for (let v = 0; v < member.topology.count; v++) {
    assert.ok(Math.abs((before[v][1] - after[v][1]) - expected) < 1e-4, `particle ${v} fell ${before[v][1] - after[v][1]} against ${expected}`);
    assert.equal(after[v][0], before[v][0]);
  }
});

test("a hanging sheet settles: small sag, low strain, no residual motion", () => {
  const member = grid({ resolution: 16, width: 1, height: 1, pinning: "top" });
  const { state, members } = makeArena({ members: [{ ...member, props: {} }] });
  run(state, 360 * 4);
  const strain = strainOf(state, members[0]);
  assert.ok(strain.mean < .02, `mean strain ${strain.mean}`);
  assert.ok(strain.worst < .1, `worst strain ${strain.worst}`);
  const pos = positionsOf(state, members[0]);
  const hem = pos.slice(16 * 15);
  const hemY = hem.reduce((a, p) => a + p[1], 0) / hem.length;
  assert.ok(hemY > -.04 && hemY < -.005, `the hem hangs ${(-hemY * 100).toFixed(2)} cm below its rest`);
  for (const p of pos) assert.ok(p.every(Number.isFinite));
  // Settling: the motion left after four seconds is small, and four seconds
  // later it is a fraction of that — a decaying tail, not a sustained buzz.
  const motion = () => {
    const before = positionsOf(state, members[0]);
    stepClothArena(state);
    const after = positionsOf(state, members[0]);
    let moved = 0;
    for (let v = 0; v < after.length; v++) moved = Math.max(moved, Math.hypot(after[v][0] - before[v][0], after[v][1] - before[v][1], after[v][2] - before[v][2]));
    return moved;
  };
  const at4 = motion();
  assert.ok(at4 < 1e-4, `residual motion ${at4} m per step at 4 s`);
  run(state, 360 * 4);
  const at8 = motion();
  assert.ok(at8 < at4 / 3, `motion decays: ${at8} at 8 s against ${at4} at 4 s`);
});

test("⛔ the fabric-length cap is what carries a tall cloth's weight — one Jacobi pass a step cannot", () => {
  // Measured on this model: a 48-ring, 2.3 m sheet sags 32 % with the cap off
  // and 2 % with it on; over-relaxation moves the first number to 17 % at
  // best. The cap is therefore not a safety net here but the load path, and
  // turning it off (or shipping `lraRelax` at 0) is a regression this test
  // exists to catch.
  const settle = (lraRelax) => {
    const member = grid({ resolution: 32, width: 1, height: 2, pinning: "top" });
    const { state, members } = makeArena({ members: [{ ...member, props: { lraRelax } }] });
    run(state, 360 * 3);
    const hem = positionsOf(state, members[0]).slice(32 * 31);
    return { sag: -hem.reduce((a, p) => a + p[1], 0) / hem.length / 2, strain: strainOf(state, members[0]) };
  };
  const capped = settle(.5), bare = settle(0);
  assert.ok(capped.sag < .03, `capped sag ${(capped.sag * 100).toFixed(1)} %`);
  assert.ok(capped.strain.mean < .02, `capped mean strain ${capped.strain.mean}`);
  assert.ok(bare.sag > capped.sag * 4, `the bare solver sags ${(bare.sag * 100).toFixed(1)} % — if this is small, the solver changed and the cap may no longer be load-bearing`);
});

test("⭐ the same steps in different frame sizes are bit-identical: the step is fixed", () => {
  const make = () => makeArena({ members: [{ ...grid({ resolution: 10, width: 1, height: 1 }), props: { wind: [0, 0, 1.5] } }] });
  const a = make(), b = make();
  let stepsA = 0, stepsB = 0;
  let accA = 0, accB = 0;
  for (let frame = 0; frame < 20; frame++) {
    const fa = clothSteps(accA, 1 / 60); accA = fa.accumulator; run(a.state, fa.count); stepsA += fa.count;
  }
  while (stepsB < stepsA) {
    const fb = clothSteps(accB, 1 / 33); accB = fb.accumulator;
    const n = Math.min(fb.count, stepsA - stepsB);
    run(b.state, n); stepsB += n;
  }
  assert.equal(stepsA, stepsB);
  assert.deepEqual(Array.from(a.state.read.subarray(0, a.state.count * 4)), Array.from(b.state.read.subarray(0, b.state.count * 4)));
});

test("the top row stays pinned, an anchor overrides, a disabled cloth holds, a reset restores rest", () => {
  const member = grid({ resolution: 6, width: 1, height: 1 });
  const { state, members } = makeArena({ members: [{ ...member, props: {} }] });
  const m = members[0];
  state.anchors.set([.3, -.3, .1, m.base + 35], 0); state.anchorCount = 1;
  run(state, 120);
  const pos = positionsOf(state, m);
  for (let ix = 0; ix < 6; ix++) assert.deepEqual(pos[ix].map((v) => +v.toFixed(6)), [m.topology.rest[ix * 4], 1, 0].map((v) => +v.toFixed(6)));
  assert.deepEqual(pos[35].map((v) => +v.toFixed(6)), [.3, -.3, .1]);
  assert.ok(pos[20][1] < m.topology.rest[20 * 4 + 1] - 1e-4, "a free particle sagged");
  // Disabled: nothing moves.
  state.params[(m.id * PARAM_ROWS + ROW.STATE) * 4 + 1] = 0;
  const held = positionsOf(state, m);
  run(state, 30);
  assert.deepEqual(positionsOf(state, m), held);
  state.params[(m.id * PARAM_ROWS + ROW.STATE) * 4 + 1] = 1;
  // Reset: back to rest in one step.
  state.params[(m.id * PARAM_ROWS + ROW.STATE) * 4] = 1;
  stepClothArena(state);
  const reset = positionsOf(state, m);
  for (let v = 0; v < m.count; v++) if (v !== 35) assert.deepEqual(reset[v], [m.topology.rest[v * 4], m.topology.rest[v * 4 + 1], m.topology.rest[v * 4 + 2]]);
});

test("a sphere and a box keep every particle a contact radius away", () => {
  const member = grid({ resolution: 12, width: 1, height: 1, pinning: "none" });
  const radius = .03;
  const { state, members } = makeArena({
    members: [{ ...member, props: { collisionRadius: radius } }],
    primitives: [{ type: "sphere", centre: [0, -.6, 0], radius: .3 }, { type: "box", centre: [0, -1.5, 0], half: [2, .1, 2] }],
  });
  run(state, 360 * 3);
  const pos = positionsOf(state, members[0]);
  for (const p of pos) {
    const d = Math.hypot(p[0], p[1] + .6, p[2]);
    assert.ok(d >= .3 + radius - 2e-3, `sphere: particle at ${d.toFixed(4)} from the centre`);
    assert.ok(p[1] >= -1.4 + radius - 2e-3, `box: particle at y ${p[1].toFixed(4)}`);
  }
  assert.ok(pos.some((p) => p[1] < -1.2), "the sheet reached the floor");
});

test("⭐ a triangle floor holds a falling sheet, and a particle at 72 m/s cannot tunnel through it", () => {
  const floor = [
    { vertices: [-3, 0, -3, 3, 0, -3, 3, 0, 3], owner: 0 },
    { vertices: [-3, 0, -3, 3, 0, 3, -3, 0, 3], owner: 0 },
  ];
  const member = grid({ resolution: 10, width: 1, height: 1, pinning: "none" });
  // Laid flat (local y → world −z) and lifted 0.4 m, so it lands as a sheet.
  const matrix = new Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, .4, 0).elements.slice();
  const radius = .03;
  const { state, members } = makeArena({ members: [{ ...member, matrix, props: { collisionRadius: radius, friction: .5 } }], triangles: floor });
  const m = members[0];
  assert.ok(m.grid && m.grid.triangles === 2, "both floor triangles are in the cloth's grid");
  run(state, 360 * 3);
  for (const p of positionsOf(state, m)) {
    const w = toWorld(matrix, p);
    assert.ok(w[1] >= radius - 2e-3, `particle at world y ${w[1].toFixed(4)}`);
    assert.ok(w[1] < radius + .02, `particle rests on the floor, not above it (${w[1].toFixed(4)})`);
  }
  // The tunnel: one particle placed just above the floor with a previous
  // position 0.2 m higher — a step of 0.2 m, 72 m/s. The proximity test alone
  // cannot see it; the crossing test must. World height is local z + 0.4 here.
  const v = m.base + 44;
  state.read[v * 4 + 2] = .05 - .4; state.prev[v * 4 + 2] = .25 - .4;
  stepClothArena(state);
  const y = state.read[v * 4 + 2] + .4;
  assert.ok(y >= radius - 1e-6, `the fast particle was stopped at ${y.toFixed(4)}`);
});

test("the fabric-length cap: a hem dragged three metres is reeled back to the fabric's reach", () => {
  const member = grid({ resolution: 8, width: .5, height: 1.5, pinning: "top" });
  const { state, members } = makeArena({ members: [{ ...member, props: { stiffness: 0, gravity: 0, damping: 0 } }] });
  const m = members[0];
  for (let v = 0; v < m.count; v++) { state.read[(m.base + v) * 4 + 1] -= 3; state.prev[(m.base + v) * 4 + 1] -= 3; }
  run(state, 40);
  const pos = positionsOf(state, m);
  for (let v = 0; v < m.count; v++) {
    const s = (m.base + v) * STATIC_STRIDE * 4;
    const fabric = state.statics[s + 7];
    if (!(fabric > 0)) continue;
    const far = Math.hypot(pos[v][0] - state.statics[s + 4], pos[v][1] - state.statics[s + 5], pos[v][2] - state.statics[s + 6]);
    assert.ok(far <= fabric + 1e-3, `particle ${v} is ${far.toFixed(3)} from its pin, fabric ${fabric.toFixed(3)}`);
  }
});

test("wind blows the hem downwind; a rotated entity still hangs down in world space", () => {
  const blown = makeArena({ members: [{ ...grid({ resolution: 10, width: 1, height: 1 }), props: { wind: [0, 0, 3] } }] });
  run(blown.state, 360 * 2);
  const hem = positionsOf(blown.state, blown.members[0]).slice(90);
  assert.ok(hem.every((p) => p[2] > .1), "the hem moved downwind");
  // The entity is turned most of the way over and lifted, so its rest pose
  // has the hem ABOVE the rod (⚠ not exactly upside down: a sheet balanced
  // precisely on its pins is an unstable equilibrium the solver honours).
  // Gravity is transformed into its local frame, so the hem must still fall
  // to well below the pins in world space.
  const matrix = new Matrix4().makeRotationFromEuler(new Euler(.3, .7, 2.6)).setPosition(1, 3, 0).elements.slice();
  const turned = makeArena({ members: [{ ...grid({ resolution: 8, width: 1, height: 1 }), matrix, props: {} }] });
  run(turned.state, 360 * 3);
  const pos = positionsOf(turned.state, turned.members[0]);
  const mean = (list) => list.reduce((a, v) => a + v, 0) / list.length;
  const pinsY = mean(pos.slice(0, 8).map((p) => toWorld(matrix, p)[1]));
  const hemY = mean(pos.slice(56).map((p) => toWorld(matrix, p)[1]));
  assert.ok(pinsY - hemY > .6, `the hem hangs below the rod in world space (${hemY} vs ${pinsY})`);
  const strain = strainOf(turned.state, turned.members[0]);
  assert.ok(strain.worst < .15, `strain ${strain.worst}`);
});

test("two cloths in one arena solve independently; removing one leaves the other untouched", () => {
  const a = grid({ resolution: 8, width: 1, height: 1 }), b = grid({ resolution: 6, width: 1, height: 1 });
  const arena = makeArena({ members: [{ ...a, props: {} }, { ...b, matrix: new Matrix4().makeTranslation(5, 0, 0).elements.slice(), props: {} }] });
  const alone = makeArena({ members: [{ ...b, matrix: new Matrix4().makeTranslation(5, 0, 0).elements.slice(), props: {} }] });
  run(arena.state, 300); run(alone.state, 300);
  const shared = positionsOf(arena.state, arena.members[1]), single = positionsOf(alone.state, alone.members[0]);
  assert.deepEqual(shared, single, "a member solves exactly as it would alone");
  // Every spring of member b points inside member b.
  const m = arena.members[1];
  for (let v = 0; v < m.count; v++) for (let j = 0; j < arena.state.stride; j++) {
    const other = arena.state.springs[((m.base + v) * arena.state.stride + j) * 4];
    if (other < 0) break;
    assert.ok(other >= m.base && other < m.base + m.count);
  }
  clearMemberStatic(arena.state, arena.members[0].base, arena.members[0].count);
  const before = positionsOf(arena.state, m);
  run(arena.state, 60); run(alone.state, 60);
  assert.deepEqual(positionsOf(arena.state, m), positionsOf(alone.state, alone.members[0]));
  assert.notDeepEqual(positionsOf(arena.state, m), before, "and it kept moving");
});

test("the reach box covers a hanging cloth's fabric and a free sheet's fall", () => {
  const hung = grid({ resolution: 8, width: 1, height: 2 }).topology;
  const box = clothReachBox(hung, IDENTITY);
  assert.ok(box.fabric > 1.9 && box.fabric < 2.6, `fabric ${box.fabric}`);
  assert.ok(box.min[1] < -1.9, "a 2 m curtain can reach 2 m below its rod");
  assert.ok(box.max[0] > 2 && box.min[0] < -2);
  const free = clothReachBox(grid({ resolution: 8, width: 1, height: 2, pinning: "none" }).topology, IDENTITY);
  assert.ok(free.min[1] < box.min[1] - 4, "a free sheet's box reaches well below");
});

test("anchor capacity and parameter rows are bounded by the layout constants", () => {
  assert.equal(ARENA_MAX_ANCHORS, 32);
  assert.equal(PARAM_ROWS * 16 * 128, 32768, "128 cloths of 16 vec4 rows fit a 64 KB uniform buffer");
});
