// GI2 WINDOW — the node-side gate (no GPU, no browser).
//
// Everything in the window store that is ARITHMETIC rather than a dispatch is
// checked here, because a toroidal address that is wrong by one bit and a
// hysteresis that thrashes both present on the GPU as "the field looks fine but
// the scroll counter is nonsense", which is an afternoon to attribute. The four
// families:
//
//   1. TOROIDAL ADDRESSING — round-trips, including negative world cells, which
//      is where a `%` instead of a `& 63` differs and where every other grid in
//      this module has been bitten at least once.
//   2. IN-WINDOW — the containment test the trace's level hand-off turns on.
//   3. BRICK SNAP + HYSTERESIS — a 0.1 m walk never scrolls; crossing the
//      central half scrolls EXACTLY one brick row; a teleport re-origins the
//      whole window; the origin is always brick-aligned.
//   4. 6-SEPARABILITY of the analytic fill — every axis-aligned path from
//      inside the room to outside crosses a voxel that is occupied AND carries
//      the entry-face bit for that direction, at every level's cell size. Plus
//      its complement: a path running PARALLEL to a wall inside the wall's own
//      voxels is NOT blocked, which is what makes the face bit worth six bits
//      instead of one.
//
// Run: node scripts/run-gi2-window-test.mjs
import {
  BRICK, BRICKS, BRICKS_PER_LEVEL, GI2_TIERS, HYST_HI, HYST_LO, LEVEL_WORDS, N, PAL_NONE,
  brickFloor, brickIndex, brickWorldCoord, createGiWindow, enteringBricks, inWindow, packWb,
  stepOrigin, voxelIndex, worldCell,
} from "../src/modules/gi/window/windowStore.js";
import { ALL_FACES, CORNELL_SCENE, ROOM, analyticVoxel } from "../src/modules/gi/window/windowFill.js";
import { entryFaceBit } from "../src/modules/gi/window/windowTrace.js";
import { RC_TIERS, rcBinBudget, rcBlockCapacities } from "../src/modules/gi/window/rc/rcConfig.js";

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
  if (g.fail <= 4) console.error(`  FAIL [${group}] ${msg}`);
  return false;
};

{
  const G = "rc-bin-pools";
  const expected = {
    ultra: [12288, 3072, 768, 192],
    high: [11264, 2560, 640, 160],
    medium: [4096, 1024, 256, 64],
    phone: [1024, 256, 64, 16],
  };
  const budgets = { ultra: 1_572_864, high: 1_343_488, medium: 524_288, phone: 131_072 };
  for (const [tier, spec] of Object.entries(RC_TIERS)) {
    const caps = rcBlockCapacities(spec);
    ok(G, JSON.stringify(caps) === JSON.stringify(expected[tier]),
      `${tier} block hierarchy ${caps.join("/")} (want ${expected[tier].join("/")})`);
    ok(G, rcBinBudget(spec) === budgets[tier],
      `${tier} bin budget ${rcBinBudget(spec)} (want ${budgets[tier]})`);
    for (let c = 1; c < caps.length; c++) ok(G, caps[c - 1] >= caps[c],
      `${tier} c${c - 1} capacity ${caps[c - 1]} is below c${c} ${caps[c]}`);
  }
}

// ─────────────────────────────────────────────── 1. toroidal addressing
{
  const G = "toroidal";
  // A world cell and the same cell 64 (and 640) away share a slot, and a cell
  // inside the window is unique. Negatives included deliberately.
  for (const c of [-1025, -641, -65, -64, -63, -1, 0, 1, 63, 64, 65, 4095]) {
    ok(G, voxelIndex(c, 0, 0) === voxelIndex(c + 64, 0, 0), `x alias at ${c}`);
    ok(G, voxelIndex(0, c, 0) === voxelIndex(0, c + 640, 0), `y alias at ${c}`);
    ok(G, voxelIndex(c, 0, 0) >= 0 && voxelIndex(c, 0, 0) < N, `x slot range at ${c}`);
  }
  // Full round-trip over a window: every cell in [o, o+64) has a distinct slot,
  // and decoding the slot under that origin gives the cell back.
  for (const o of [[0, 0, 0], [-64, 12, -1000], [7, -7, 3], [-3, -3, -3]]) {
    const seen = new Set();
    for (let i = 0; i < 512; i++) {
      const wc = [
        o[0] + ((i * 37) % N), o[1] + ((i * 53) % N), o[2] + ((i * 11) % N),
      ];
      const idx = voxelIndex(wc[0], wc[1], wc[2]);
      ok(G, idx >= 0 && idx < N * N * N, `slot in range for ${wc}`);
      seen.add(idx);
      // decode: the in-window cell whose low 6 bits match
      const dec = [0, 1, 2].map((a) => o[a] + (((wc[a] - o[a]) % N) + N) % N);
      ok(G, dec[0] === wc[0] && dec[1] === wc[1] && dec[2] === wc[2], `decode ${wc} under ${o}`);
    }
  }
  // Brick and voxel addresses must agree: (wc & 63) >> 2 === (wc >> 2) & 15.
  for (let c = -300; c <= 300; c++) {
    ok(G, ((c & 63) >> 2) === ((c >> 2) & 15), `brick/voxel agreement at ${c}`);
  }
  // The brick table's identity: the slot a world brick lands in decodes back.
  for (const ob of [0, -4, 12, -300]) {
    for (let b = 0; b < BRICKS; b++) {
      const wb = brickWorldCoord(b, ob);
      ok(G, wb >= ob && wb < ob + BRICKS, `wb ${wb} in [${ob}, ${ob + BRICKS})`);
      ok(G, (wb & 15) === b, `wb ${wb} owns slot ${b}`);
    }
  }
  // packWb is injective over a window and never collides with the zero word.
  const packs = new Set();
  for (let x = -8; x < 8; x++) for (let y = -8; y < 8; y++) {
    const p = packWb(x, y, 3);
    ok(G, p !== 0, `packWb(${x},${y},3) is not the empty word`);
    packs.add(p);
  }
  ok(G, packs.size === 256, `packWb injective (${packs.size}/256)`);
  ok(G, packWb(512, 512, 512) !== 0, "packWb(512,512,512) is not zero — the VALID bit");
  ok(G, brickIndex(-1, -1, -1) === (15 | (15 << 4) | (15 << 8)), "brickIndex on negatives");
}

// ─────────────────────────────────────────────── 2. in-window test
{
  const G = "in-window";
  const o = [-8, 100, -1000];
  ok(G, inWindow(o, o), "origin is in");
  ok(G, inWindow([o[0] + 63, o[1] + 63, o[2] + 63], o), "far corner is in");
  ok(G, !inWindow([o[0] - 1, o[1], o[2]], o), "one below is out");
  ok(G, !inWindow([o[0], o[1] + 64, o[2]], o), "one past is out");
  ok(G, !inWindow([o[0], o[1], o[2] + 64], o), "one past in z is out");
}

// ─────────────────────────────────────────────── 3. brick snap + hysteresis
{
  const G = "hysteresis";
  for (const [tier, spec] of Object.entries(GI2_TIERS)) {
    const win = createGiWindow(tier);
    const v = spec.voxel0;
    // First placement centres the camera and lands on a brick.
    let r = win.setCamera([0, 0, 0]);
    for (let l = 0; l < spec.levels; l++) {
      const o = r.perLevel[l].origin;
      for (let a = 0; a < 3; a++) {
        ok(G, o[a] % BRICK === 0, `${tier} L${l} axis ${a} origin ${o[a]} is brick-aligned`);
      }
      const off = worldCell(0, win.levelVoxel(l)) - o[0];
      ok(G, off >= HYST_LO && off < HYST_HI, `${tier} L${l} first placement is central (off ${off})`);
      ok(G, r.perLevel[l].enteringBricks === BRICKS_PER_LEVEL, `${tier} L${l} first placement enters everything`);
    }

    // A 0.1 m walk — 40 steps, 4 m total, well inside L0's central half at
    // 0.25 m cells (16 cells = 4 m each way) — must not scroll at level 0
    // until it has actually left it.
    let scrolls = 0;
    let x = 0;
    const smallStep = 0.1;
    const budget = Math.floor((HYST_LO * v) / smallStep) - 1; // stay inside
    for (let i = 0; i < budget; i++) {
      x += smallStep;
      r = win.setCamera([x, 0, 0]);
      if (r.perLevel[0].shift.some((s) => s !== 0)) scrolls++;
    }
    ok(G, scrolls === 0, `${tier} L0: ${budget} × 0.1 m walk scrolled ${scrolls} times (want 0)`);

    // Keep walking until it DOES scroll — the first crossing must move the
    // origin exactly one brick row, on one axis only.
    let crossed = false;
    for (let i = 0; i < 400 && !crossed; i++) {
      x += smallStep;
      r = win.setCamera([x, 0, 0]);
      const s = r.perLevel[0].shift;
      if (s.some((k) => k !== 0)) {
        crossed = true;
        ok(G, s[0] === BRICK, `${tier} first scroll shifts one brick row (got ${s[0]})`);
        ok(G, s[1] === 0 && s[2] === 0, `${tier} first scroll touches one axis only (${s})`);
        ok(G, r.perLevel[0].enteringBricks === BRICKS * BRICKS,
          `${tier} one row enters ${BRICKS * BRICKS} bricks (got ${r.perLevel[0].enteringBricks})`);
        ok(G, r.perLevel[0].slabs.length === 1 && r.perLevel[0].slabs[0].rows === 1,
          `${tier} one entering slab of one row`);
      }
    }
    ok(G, crossed, `${tier} the walk eventually scrolls`);

    // A teleport past the window re-origins everything.
    r = win.setCamera([500, 500, 500]);
    ok(G, r.perLevel[0].enteringBricks === BRICKS_PER_LEVEL, `${tier} teleport invalidates the whole window`);
    for (let a = 0; a < 3; a++) {
      ok(G, r.perLevel[0].origin[a] % BRICK === 0, `${tier} teleport origin still brick-aligned`);
      const off = worldCell(500, win.levelVoxel(0)) - r.perLevel[0].origin[a];
      ok(G, off >= HYST_LO && off < HYST_HI, `${tier} teleport re-centres (off ${off})`);
    }
    win.dispose();
  }

  // stepOrigin, in isolation, over the whole deadband.
  const G2 = "stepOrigin";
  const o0 = 0;
  for (let off = HYST_LO; off < HYST_HI; off++) {
    ok(G2, stepOrigin(o0 + off, o0) === o0, `off ${off} inside the central half does not move`);
  }
  ok(G2, stepOrigin(o0 + HYST_HI, o0) === o0 + BRICK, "one past the top edge moves one brick");
  ok(G2, stepOrigin(o0 + HYST_LO - 1, o0) === o0 - BRICK, "one below the bottom edge moves one brick");
  ok(G2, stepOrigin(o0 + HYST_HI + 3, o0) === o0 + BRICK, "three past the edge still one brick");
  ok(G2, stepOrigin(o0 + HYST_HI + 4, o0) === o0 + 2 * BRICK, "four past the edge is two bricks");
  // and the result is always back inside the deadband
  for (const off of [-500, -49, -17, -1, 48, 49, 63, 64, 500, 5000]) {
    const next = stepOrigin(o0 + off, o0);
    const rel = o0 + off - next;
    ok(G2, rel >= HYST_LO && rel < HYST_HI, `off ${off} lands back inside the central half (rel ${rel})`);
    ok(G2, next % BRICK === 0, `off ${off} keeps the origin brick-aligned`);
  }
  ok(G2, brickFloor(-1) === -4 && brickFloor(-4) === -4 && brickFloor(3) === 0, "brickFloor on negatives");

  const G3 = "entering";
  ok(G3, enteringBricks([0, 0, 0]) === 0, "no shift enters nothing");
  ok(G3, enteringBricks([BRICK, 0, 0]) === BRICKS * BRICKS, "one row");
  ok(G3, enteringBricks([BRICK, BRICK, 0]) === BRICKS_PER_LEVEL - 15 * 15 * 16, "two rows, corner counted once");
  ok(G3, enteringBricks([N, 0, 0]) === BRICKS_PER_LEVEL, "a full window shift enters everything");
  ok(G3, enteringBricks([1000, 0, 0]) === BRICKS_PER_LEVEL, "a teleport enters everything");
}

// ─────────────────────────────────────────────── 4. the analytic fill
{
  const G = "6-separating";
  const { hx, hy, hz } = ROOM;
  // Every level's cell size across the tier table: 0.25 … 4 m.
  const cells = [0.25, 0.5, 1, 2, 4];
  // Interior sample points, deliberately including near-corner and near-wall
  // starts (a leak test that only fires from the middle of the room measures
  // the middle of the room).
  const starts = [];
  const rng = (() => { let s = 0x9e3779b9 >>> 0; return () => {
    s = (s + 0x6d2b79f5) >>> 0; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }; })();
  for (let i = 0; i < 240; i++) {
    starts.push([
      (rng() * 2 - 1) * (hx - 0.2), (rng() * 2 - 1) * (hy - 0.2), (rng() * 2 - 1) * (hz - 0.2),
    ]);
  }
  starts.push([-hx + 0.02, -hy + 0.02, -hz + 0.02], [hx - 0.02, hy - 0.02, hz - 0.02], [0, 0, 0]);

  const AXES = [0, 1, 2];
  let blocked = 0;
  let paths = 0;
  for (const v of cells) {
    for (const p of starts) {
      for (const a of AXES) {
        for (const dir of [1, -1]) {
          paths++;
          const want = entryFaceBit(a, dir > 0);
          // Walk cells from the start out past the shell, at this cell size.
          const startCell = Math.floor(p[a] / v);
          const limit = Math.ceil((([hx, hy, hz][a] + 1) * 2) / v) + 4;
          let stopped = false;
          for (let k = 0; k <= limit && !stopped; k++) {
            const c = [Math.floor(p[0] / v), Math.floor(p[1] / v), Math.floor(p[2] / v)];
            c[a] = startCell + dir * k;
            const vmin = [c[0] * v, c[1] * v, c[2] * v];
            const r = analyticVoxel(CORNELL_SCENE, vmin, v);
            // k === 0 is the cell the ray was BORN in; the trace seeds its
            // entry face from the ray's dominant axis there, so it is fair
            // game — but a start cell that is already occupied would make the
            // test vacuous, so those starts are skipped rather than counted.
            if (k === 0 && r.occ) { stopped = true; paths--; break; }
            if (r.occ && (r.face & (1 << want)) !== 0) { stopped = true; blocked++; }
          }
          ok(G, stopped, `cell ${v}: axis ${a} dir ${dir} from ${p.map((n) => n.toFixed(2))} escaped`);
        }
      }
    }
  }
  ok(G, blocked > 0, "at least one path was actually blocked (the instrument can see its subject)");
  console.log(`  6-separability: ${blocked}/${paths} axis paths blocked at 5 cell sizes`);

  // ── the complement: the bits DISCRIMINATE ──────────────────────────────────
  // A path running parallel to the −X wall, inside the wall's own voxel column,
  // must NOT be stopped by the wall voxels — only by the ceiling. If this
  // fails, the face byte is just a second copy of the occupancy bit.
  const G2 = "discrimination";
  {
    const v = 0.25;
    const xCell = Math.floor((-hx - 0.01) / v); // the wall's own column
    const zCell = 0;
    let wallVoxels = 0;
    let wallBlocksY = 0;
    for (let yc = Math.floor((-hy + 0.5) / v); yc < Math.floor((hy - 0.5) / v); yc++) {
      const r = analyticVoxel(CORNELL_SCENE, [xCell * v, yc * v, zCell * v], v);
      if (!r.occ) continue;
      wallVoxels++;
      if ((r.face & (1 << entryFaceBit(1, true))) !== 0) wallBlocksY++;
      ok(G2, (r.face & (1 << entryFaceBit(0, true))) !== 0, `wall voxel y=${yc} blocks +X`);
    }
    ok(G2, wallVoxels > 10, `the wall column has voxels to test (${wallVoxels})`);
    ok(G2, wallBlocksY === 0, `no wall voxel blocks a parallel +Y ray (${wallBlocksY} of ${wallVoxels} do)`);
  }
  // A floor voxel blocks ±Y and passes ±X — the "thickened geometry" case.
  {
    const v = 0.25;
    const r = analyticVoxel(CORNELL_SCENE, [0, Math.floor((-hy - 0.01) / v) * v, 0], v);
    ok(G2, r.occ, "the floor voxel is occupied");
    ok(G2, (r.face & (1 << entryFaceBit(1, true))) !== 0, "the floor blocks a +Y ray");
    ok(G2, (r.face & (1 << entryFaceBit(0, true))) === 0, "the floor passes a horizontal +X ray");
    ok(G2, r.pal === 1, `the floor carries its palette index (got ${r.pal})`);
  }
  // Empty space is empty, and the sphere/box are solid from every direction.
  {
    const v = 0.25;
    const air = analyticVoxel(CORNELL_SCENE, [0, 0, 0], v);
    ok(G2, !air.occ && air.face === 0 && air.pal === PAL_NONE, "the middle of the room is empty");
    const box = analyticVoxel(CORNELL_SCENE, [-2, -2.5, -1.5], v);
    ok(G2, box.occ && box.face === ALL_FACES, "inside the 2 m box is solid on all faces");
    const sph = analyticVoxel(CORNELL_SCENE, [2, -2.6, 1.5], v);
    ok(G2, sph.occ && sph.face === ALL_FACES, "the sphere is solid on all faces");
  }
}

// ─────────────────────────────────────────────── layout receipts
{
  const G = "layout";
  // 640.5 KB since §AG: 576.5 KB of occ/face/pal/masks/table + 64 KB of the
  // 2-bit COVERAGE class. The number is asserted rather than described because
  // a region silently changing size is how a consumer starts reading the wrong
  // one, and every kernel in GI2 bakes these offsets into its WGSL.
  ok(G, LEVEL_WORDS * 4 === 655872, `a level slot is 655872 B (got ${LEVEL_WORDS * 4})`);
  for (const [tier, spec] of Object.entries(GI2_TIERS)) {
    const win = createGiWindow(tier);
    const d = win.describe();
    ok(G, d.levels === spec.levels && d.voxel0 === spec.voxel0, `${tier} tier table`);
    ok(G, d.totalBytes === (spec.levels + 2) * LEVEL_WORDS * 4 + 64, `${tier} total bytes`);
    console.log(
      `  ${tier.padEnd(7)} ${d.levels} levels @ ${d.voxel0} m → windows ` +
      `${d.extents.map((e) => `${e.extent}m`).join("/")}  static ${(d.staticBytes / 1048576).toFixed(2)} MB ` +
      `+ dyn ${(d.dynamicBytes / 1048576).toFixed(2)} MB = ${d.totalMB} MB`,
    );
    win.dispose();
  }
}

const summary = [...groups.entries()].map(([g, s]) => `${g} ${s.pass}/${s.pass + s.fail}`).join("  ");
if (failures) {
  console.error(`gi2-window: FAIL — ${failures} of ${checks} checks failed`);
  console.error(`  ${summary}`);
  process.exit(1);
}
console.log(`gi2-window: PASS — ${checks} checks`);
console.log(`  ${summary}`);
