// GI2 — TEST-ONLY ANALYTIC FILLER (Stage 2.4's harness; NOT the Stage 2.3
// voxelizer)
//
// The real window is filled by the (brick, triangle) SAT pipeline of audits
// §K.3. That pipeline needs the worker triangle grid (Stage 2.2) that does not
// exist yet, and the trace's throughput receipt must not wait for it — so this
// fills `occ` / `face` / `pal` from an ANALYTIC scene instead: a Cornell-shaped
// room with 5 cm walls, a 2 m box and a 1 m sphere, at every level.
//
// It exists to answer three questions the triangle path cannot answer yet:
//   · does a 5 cm wall block every ray at a 0.25 m (and 0.5 m) cell?
//   · does the ENTRY-FACE bit carry that, i.e. does the same scene LEAK when
//     the bits are withheld? (`faceBits: false` — a flag on the FILL, so the
//     control arm changes the data and not the tracer, which is the only way
//     the comparison isolates the bit.)
//   · what does one ray cost?
//
// ══ THE SAME RULE AS THE TRACE, DERIVED FROM SOLIDS ══════════════════════════
//
// `windowTrace.js`'s header states the face-bit rule: bit(±a) is set when the
// surface inside the voxel is not parallel to axis a. For an axis-aligned box
// that is exactly "one of the box's two a-planes lies inside this voxel's
// a-span": a wall slab crossing a cell in X sets ±X and nothing else, because
// its ±Y and ±Z planes are nowhere near. A voxel INSIDE a solid (no plane of
// the box inside it) sets all six — a solid blocks everything. A sphere sets
// all six wherever its surface reaches, which is conservative and honest: a
// curved patch has a normal component along every axis except on a
// measure-zero equator.
//
// ══ THE CPU MIRROR ═══════════════════════════════════════════════════════════
//
// `analyticVoxel` is the same rule in JS. It is what `run-gi2-window-test.mjs`
// walks to prove 6-SEPARABILITY without a GPU: every axis-aligned path from
// inside the room to outside must cross a voxel that is occupied AND carries
// the face bit for that direction. If that property holds on the CPU and the
// GPU fill is the same rule, a leak in the probe is a TRACE bug, not a data
// bug — which is the only reason to write the mirror at all.
import {
  Fn, If, Loop, atomicAnd, atomicMax, atomicOr, bitAnd, bitNot, bitOr, exp2, float, instanceIndex,
  instancedArray, int, select, shiftLeft, shiftRight, uint, uniform, vec3,
} from "three/tsl";
import {
  BMASK_OFF, BRICK, BTAB_OFF, FACE_OFF, LEVEL_WORDS, N, OCC_OFF, PAL_NONE, PAL_OFF, STATE_BUILT,
} from "./windowStore.js";

/** Slots in the primitive buffer. A tier constant of the FILL, not the trace. */
export const MAX_PRIMS = 16;
export const KIND_BOX = 0;
export const KIND_SPHERE = 1;

/** Face-bit masks per axis pair (bits 2a and 2a+1 together). */
export const AXIS_MASK = [0b000011, 0b001100, 0b110000];
export const ALL_FACES = 0b111111;

/**
 * The harness scene. Interior 10 × 6 × 10 m centred on the origin, 5 cm walls,
 * a 2 m box and a 1 m sphere both standing on the floor.
 *
 * These numbers live HERE and are uploaded as buffer contents — the trace
 * kernel never sees them, which is the property `probe:gi2-trace` greps for.
 */
export const ROOM = { hx: 5, hy: 3, hz: 5, wall: 0.05 };

export const CORNELL_SCENE = (() => {
  const { hx, hy, hz, wall } = ROOM;
  const box = (min, max, pal) => ({ kind: KIND_BOX, min, max, pal });
  return [
    // floor / ceiling span the full outer footprint so the room is SEALED at
    // the corners — a room with a gap where two walls meet is a room whose leak
    // test measures the gap.
    box([-hx - wall, -hy - wall, -hz - wall], [hx + wall, -hy, hz + wall], 1), // floor
    box([-hx - wall, hy, -hz - wall], [hx + wall, hy + wall, hz + wall], 2), // ceiling
    box([-hx - wall, -hy, -hz - wall], [-hx, hy, hz + wall], 3), // −X (red)
    box([hx, -hy, -hz - wall], [hx + wall, hy, hz + wall], 4), // +X (green)
    box([-hx, -hy, -hz - wall], [hx, hy, -hz], 5), // −Z
    box([-hx, -hy, hz], [hx, hy, hz + wall], 6), // +Z
    box([-3, -hy, -2.5], [-1, -hy + 2, -0.5], 7), // 2 m box on the floor
    { kind: KIND_SPHERE, min: [1.5, -hy, 1], max: [2.5, -hy + 1, 2], pal: 8 }, // 1 m sphere
  ];
})();

/** Packs a scene into the 2-vec4-per-primitive layout the kernel reads. */
export function packPrims(scene) {
  const arr = new Float32Array(MAX_PRIMS * 8);
  for (let i = 0; i < MAX_PRIMS; i++) arr[i * 8 + 3] = -1; // kind < 0 = unused
  scene.forEach((p, i) => {
    if (i >= MAX_PRIMS) throw new Error(`analytic scene exceeds MAX_PRIMS (${MAX_PRIMS})`);
    arr.set([p.min[0], p.min[1], p.min[2], p.kind], i * 8);
    arr.set([p.max[0], p.max[1], p.max[2], p.pal], i * 8 + 4);
  });
  return arr;
}

// ── CPU MIRROR ───────────────────────────────────────────────────────────────

/**
 * Occupancy / face bits / palette of ONE voxel, analytically.
 *
 * @param {Array} scene   `CORNELL_SCENE`-shaped
 * @param {number[]} vmin voxel min corner, world
 * @param {number} v      cell size
 * @returns {{occ: boolean, face: number, pal: number}}
 */
export function analyticVoxel(scene, vmin, v) {
  const vmax = [vmin[0] + v, vmin[1] + v, vmin[2] + v];
  let occ = false;
  let face = 0;
  let pal = PAL_NONE;
  for (const p of scene) {
    if (p.kind === KIND_BOX) {
      let overlap = true;
      for (let a = 0; a < 3; a++) if (!(p.min[a] < vmax[a] && p.max[a] > vmin[a])) overlap = false;
      if (!overlap) continue;
      let mask = 0;
      for (let a = 0; a < 3; a++) {
        const lo = p.min[a] >= vmin[a] && p.min[a] <= vmax[a];
        const hi = p.max[a] >= vmin[a] && p.max[a] <= vmax[a];
        if (lo || hi) mask |= AXIS_MASK[a];
      }
      // No plane of the box inside the cell → the cell is INSIDE the solid.
      face |= mask === 0 ? ALL_FACES : mask;
      occ = true;
      pal = Math.min(pal, p.pal);
    } else {
      const c = [0, 1, 2].map((a) => (p.min[a] + p.max[a]) * 0.5);
      const r = (p.max[0] - p.min[0]) * 0.5;
      let d2 = 0;
      for (let a = 0; a < 3; a++) {
        const q = Math.min(Math.max(c[a], vmin[a]), vmax[a]);
        d2 += (q - c[a]) * (q - c[a]);
      }
      if (Math.sqrt(d2) > r) continue;
      occ = true;
      face |= ALL_FACES;
      pal = Math.min(pal, p.pal);
    }
  }
  return { occ, face, pal };
}

/** The voxel a world point falls in, at cell size `v`, as its min corner. */
export const cellMin = (p, v) => [Math.floor(p[0] / v) * v, Math.floor(p[1] / v) * v, Math.floor(p[2] / v) * v];

// ── GPU FILL ─────────────────────────────────────────────────────────────────

/**
 * A compute pass that fills every STATIC level of `win` from `scene`.
 *
 * One thread per (level, voxel). `faceBitsEnabled` is a UNIFORM, so the
 * blind-statistics control arm ("the same rays with the face-bit test
 * disabled") is a value written into the data, not a second kernel and not a
 * global flag — the tracer under test is byte-identical across both arms.
 */
export function createWindowFill(win, { scene = CORNELL_SCENE } = {}) {
  const { levels, voxel0, atomics, originAt } = win;
  const primArr = packPrims(scene);
  const prims = instancedArray(primArr, "vec4");
  const faceBitsEnabled = uniform(1);

  const pass = Fn(() => {
    const idx = instanceIndex.toVar();
    const slot = shiftRight(idx, uint(18)).toVar(); // 64³ voxels per level
    const vi = bitAnd(idx, uint(0x3ffff)).toVar();
    const cx = bitAnd(vi, uint(63)).toInt().toVar();
    const cy = bitAnd(shiftRight(vi, uint(6)), uint(63)).toInt().toVar();
    const cz = bitAnd(shiftRight(vi, uint(12)), uint(63)).toInt().toVar();

    // Which WORLD cell this torus slot currently addresses (K.1, inverted).
    const o = originAt(slot.toInt()).toVar();
    const ox = o.x.toInt().toVar();
    const oy = o.y.toInt().toVar();
    const oz = o.z.toInt().toVar();
    const wcx = ox.add(bitAnd(cx.sub(ox), int(N - 1))).toVar();
    const wcy = oy.add(bitAnd(cy.sub(oy), int(N - 1))).toVar();
    const wcz = oz.add(bitAnd(cz.sub(oz), int(N - 1))).toVar();

    const vl = float(voxel0).mul(exp2(slot.toFloat())).toVar();
    const vmin = vec3(wcx.toFloat(), wcy.toFloat(), wcz.toFloat()).mul(vl).toVar();
    const vmax = vmin.add(vl).toVar();

    const occ = float(0).toVar();
    const faceMask = uint(0).toVar();
    const pal = uint(PAL_NONE).toVar();

    Loop({ start: 0, end: MAX_PRIMS, name: "fillPrim" }, ({ fillPrim }) => {
      const base = uint(fillPrim).mul(uint(2)).toVar();
      const p0 = prims.element(base).toVar();
      const p1 = prims.element(base.add(uint(1))).toVar();
      const kind = p0.w.toVar();
      const pmin = p0.xyz.toVar();
      const pmax = p1.xyz.toVar();
      const palIdx = p1.w.toUint().toVar();

      If(kind.greaterThanEqual(0), () => {
        const isBox = kind.lessThan(0.5);
        // ── box: overlap, then which of its planes cut this cell ────────────
        const overlap = pmin.x.lessThan(vmax.x).and(pmax.x.greaterThan(vmin.x))
          .and(pmin.y.lessThan(vmax.y)).and(pmax.y.greaterThan(vmin.y))
          .and(pmin.z.lessThan(vmax.z)).and(pmax.z.greaterThan(vmin.z));
        const cut = (lo, hi, a0, a1) =>
          lo.greaterThanEqual(a0).and(lo.lessThanEqual(a1))
            .or(hi.greaterThanEqual(a0).and(hi.lessThanEqual(a1)));
        const cutX = cut(pmin.x, pmax.x, vmin.x, vmax.x);
        const cutY = cut(pmin.y, pmax.y, vmin.y, vmax.y);
        const cutZ = cut(pmin.z, pmax.z, vmin.z, vmax.z);
        const boxMask = bitOr(
          bitOr(select(cutX, uint(AXIS_MASK[0]), uint(0)), select(cutY, uint(AXIS_MASK[1]), uint(0))),
          select(cutZ, uint(AXIS_MASK[2]), uint(0)),
        ).toVar();
        // Nothing cut → the cell is strictly inside the solid → all six.
        boxMask.assign(select(boxMask.equal(uint(0)), uint(ALL_FACES), boxMask));

        // ── sphere: closest point in the cell within the radius ─────────────
        const c = pmin.add(pmax).mul(0.5).toVar();
        const r = pmax.x.sub(pmin.x).mul(0.5).toVar();
        const q = c.clamp(vmin, vmax).toVar();
        const sphereIn = q.sub(c).length().lessThanEqual(r);

        const inside = select(isBox, overlap, sphereIn);
        If(inside, () => {
          occ.assign(1);
          faceMask.assign(bitOr(faceMask, select(isBox, boxMask, uint(ALL_FACES))));
          pal.assign(pal.min(palIdx));
        });
      });
    });

    If(occ.greaterThan(0.5), () => {
      const levelBase = slot.mul(uint(LEVEL_WORDS)).toVar();
      atomicOr(
        atomics.element(levelBase.add(uint(OCC_OFF)).add(shiftRight(vi, uint(5)))),
        shiftLeft(uint(1), bitAnd(vi, uint(31))),
      );
      const byteWord = shiftRight(vi, uint(2)).toVar();
      const byteShift = bitAnd(vi, uint(3)).mul(uint(8)).toVar();
      // THE CONTROL ARM lives on this line: a uniform, so both arms run the
      // same kernel over the same rays and only the stored bits differ.
      const stored = select(faceBitsEnabled.greaterThan(0.5), faceMask, uint(0)).toVar();
      atomicOr(atomics.element(levelBase.add(uint(FACE_OFF)).add(byteWord)), shiftLeft(stored, byteShift));
      // pal byte: clear then set. The scroll leaves 0xFF in every byte, so the
      // AND is what makes a re-fill without a scroll land the right value, and
      // the OR is what makes concurrent neighbours in the same word survive.
      atomicAnd(
        atomics.element(levelBase.add(uint(PAL_OFF)).add(byteWord)),
        bitNot(shiftLeft(uint(255), byteShift)),
      );
      atomicOr(atomics.element(levelBase.add(uint(PAL_OFF)).add(byteWord)), shiftLeft(pal, byteShift));

      const b = bitOr(
        bitOr(shiftRight(bitAnd(vi, uint(63)), uint(2)),
          shiftLeft(shiftRight(bitAnd(shiftRight(vi, uint(6)), uint(63)), uint(2)), uint(4))),
        shiftLeft(shiftRight(bitAnd(shiftRight(vi, uint(12)), uint(63)), uint(2)), uint(8)),
      ).toVar();
      atomicOr(
        atomics.element(levelBase.add(uint(BMASK_OFF)).add(shiftRight(b, uint(5)))),
        shiftLeft(uint(1), bitAnd(b, uint(31))),
      );
      atomicMax(atomics.element(levelBase.add(uint(BTAB_OFF)).add(b.mul(uint(2))).add(uint(1))), uint(STATE_BUILT));
    });
  })().compute(levels * N * N * N);

  return {
    pass,
    prims,
    faceBitsEnabled,
    /** Harness-only: withhold the face bits so the entry-face test has nothing
     *  to find. The control that proves the bit is load-bearing. */
    setFaceBits(on) { faceBitsEnabled.value = on ? 1 : 0; },
    scene,
    brick: BRICK,
  };
}
