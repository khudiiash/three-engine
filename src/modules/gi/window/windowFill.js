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
import * as THREE from "three/webgpu";
import {
  Fn, If, Loop, atomicAnd, atomicMax, atomicOr, bitAnd, bitNot, bitOr, dot, exp2, float,
  instanceIndex, instancedArray, int, select, shiftLeft, shiftRight, uint, uniform, vec3,
} from "three/tsl";
import {
  BMASK_OFF, BRICK, BTAB_OFF, COV_OFF, COV_OPAQUE, FACE_OFF, LEVEL_WORDS, N, OCC_OFF, PAL_NONE,
  PAL_OFF, STATE_BUILT,
} from "./windowStore.js";
import { FACE_AX_SHIFT } from "./windowTrace.js";

/** Slots in the primitive buffer. A tier constant of the FILL, not the trace. */
export const MAX_PRIMS = 16;
export const KIND_BOX = 0;
export const KIND_SPHERE = 1;
/**
 * ⭐ §19 STAGE 3.9 — THE ROTATED ROOM. A box whose `min`/`max` are read in the
 * fill's LOCAL frame and turned by the fill's rotation `R`; `KIND_BOX` is the
 * same primitive with `R = I` and reduces to the old AABB test EXACTLY (the
 * derivation is on `obbVoxel` below), which is what keeps the axis-aligned
 * Cornell arm byte-identical while the rotated arms exist beside it.
 *
 * A SPHERE needs no kind of its own: rotating its centre on the CPU is the
 * whole transform, and its face bits are all six wherever its surface reaches
 * however the room is turned.
 */
export const KIND_OBB = 2;

/** Face-bit masks per axis pair (bits 2a and 2a+1 together). */
export const AXIS_MASK = [0b000011, 0b001100, 0b110000];
export const ALL_FACES = 0b111111;
/** The angle below which a face normal is treated as parallel to an axis. */
export const NORMAL_EPS = 1e-3;

// ── ROTATIONS (the instrument's own vocabulary) ──────────────────────────────
//
// A rotation is carried as its three COLUMNS, `[c0, c1, c2]`, because that is
// the form both consumers want: `world = c0·x + c1·y + c2·z` on the CPU, and
// three `vec3` uniforms on the GPU with no matrix type to marshal.

export const IDENTITY_ROT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
/** Right-handed rotation about +Y by `deg`, as columns. */
export const rotY = (deg) => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t); const s = Math.sin(t);
  return [[c, 0, -s], [0, 1, 0], [s, 0, c]];
};
/** Right-handed rotation about +X by `deg`, as columns. */
export const rotX = (deg) => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t); const s = Math.sin(t);
  return [[1, 0, 0], [0, c, s], [0, -s, c]];
};
/** `R · v`, columns form. */
export const applyRot = (R, v) => [0, 1, 2].map(
  (a) => R[0][a] * v[0] + R[1][a] * v[1] + R[2][a] * v[2],
);
/** `Rᵀ · v` — a world vector back into the room's own frame. */
export const applyRotT = (R, v) => [0, 1, 2].map((k) => R[k][0] * v[0] + R[k][1] * v[1] + R[k][2] * v[2]);

/**
 * The same scene, turned: every box becomes an `KIND_OBB` (its `min`/`max` are
 * now LOCAL and the fill turns them), every sphere keeps its shape and moves
 * its centre. `keep` names the primitives that must NOT turn — the harness's
 * emissive panel, whose NEE estimator in `gatherProbes` is written for a
 * −Y-facing axis-aligned rectangle and would otherwise have to be generalised
 * inside a shipping shader to serve a test rig.
 */
export const rotateScene = (scene, R, keep = () => false) => scene.map((p) => {
  if (keep(p)) return { ...p };
  if (p.kind === KIND_SPHERE) {
    const c = [0, 1, 2].map((a) => (p.min[a] + p.max[a]) * 0.5);
    const r = (p.max[0] - p.min[0]) * 0.5;
    const q = applyRot(R, c);
    return { ...p, min: q.map((v) => v - r), max: q.map((v) => v + r) };
  }
  return { ...p, kind: KIND_OBB };
});

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
 * ⭐⭐ ONE BOX TEST FOR BOTH ARMS, AND WHY IT IS SAFE TO REPLACE THE OLD ONE.
 *
 * SAT on six axes (three world, three of the box) with a STRICT separation
 * test, plus "which of the box's six face PLANES cuts this voxel" for the face
 * bits. With `R = I` every line reduces to the axis-aligned form it replaced:
 *
 *   · separation `|Δ.a| ≥ hv + he.a` ⟺ NOT (`pmin.a < vmax.a && pmax.a > vmin.a`)
 *     — strict, so a wall plane lying exactly ON a cell boundary (which every
 *     Cornell wall does: 5 / 0.25 is an integer) keeps landing in exactly the
 *     cells it landed in before;
 *   · the cut test `|p_k ∓ he[k]| ≤ r_k` with `r_k = hv` is `pmax.k ∈ [vmin.k,
 *     vmax.k]` and `pmin.k ∈ [vmin.k, vmax.k]`, verbatim;
 *   · the bits a cut contributes are the axes with `|n.a| > NORMAL_EPS`, and
 *     for `R = I` that is the one axis `AXIS_MASK[k]` named.
 *
 * Six axes and not fifteen: the edge-edge cross products only ever make the
 * test LESS conservative, and a voxelizer that occasionally claims a cell its
 * surface merely grazes is the conservative side of a conservative structure.
 *
 * The DOMINANT AXIS falls out of the same loop for free: a cutting face
 * contributes its own area to the axis its normal points most along, and the
 * voxel's dominant axis is the argmax of those. It is the CPU mirror of the
 * voxelizer's `atomicMax` over (area·|n|, axis) — same quantity, computed
 * exactly here because there is no atomic to launder it through.
 */
const obbVoxel = (p, R, vc, hv) => {
  const pc = [0, 1, 2].map((a) => (p.min[a] + p.max[a]) * 0.5);
  const he = [0, 1, 2].map((a) => (p.max[a] - p.min[a]) * 0.5);
  const C = applyRot(R, pc);
  const D = [0, 1, 2].map((a) => vc[a] - C[a]);
  // Separation on the three WORLD axes: the OBB's extent along `a` is the sum
  // of its half extents times the |R| entries of that row.
  for (let a = 0; a < 3; a++) {
    const reach = he[0] * Math.abs(R[0][a]) + he[1] * Math.abs(R[1][a]) + he[2] * Math.abs(R[2][a]);
    if (Math.abs(D[a]) >= hv + reach) return null;
  }
  // …and on the three BOX axes. `r[k]` is also the voxel's projected radius on
  // the k-th face normal, which the cut test below needs.
  const pk = [0, 1, 2].map((k) => R[k][0] * D[0] + R[k][1] * D[1] + R[k][2] * D[2]);
  const r = [0, 1, 2].map((k) => hv * (Math.abs(R[k][0]) + Math.abs(R[k][1]) + Math.abs(R[k][2])));
  for (let k = 0; k < 3; k++) if (Math.abs(pk[k]) >= he[k] + r[k]) return null;

  let mask = 0;
  const w = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const cut = Math.abs(pk[k] - he[k]) <= r[k] || Math.abs(pk[k] + he[k]) <= r[k];
    if (!cut) continue;
    for (let a = 0; a < 3; a++) if (Math.abs(R[k][a]) > NORMAL_EPS) mask |= AXIS_MASK[a];
    // The face's own area, and the axis its normal points most along.
    const area = 4 * he[(k + 1) % 3] * he[(k + 2) % 3];
    let best = 0;
    for (let a = 1; a < 3; a++) if (Math.abs(R[k][a]) > Math.abs(R[k][best])) best = a;
    w[best] += area * Math.abs(R[k][best]);
  }
  // No plane of the box inside the cell → the cell is INSIDE the solid, which
  // blocks everything and has no surface to name a dominant normal for.
  return { mask: mask === 0 ? ALL_FACES : mask, w };
};

/**
 * Occupancy / face bits / palette / dominant axis of ONE voxel, analytically.
 *
 * `face` carries the dominant axis in bits 6-7 (`windowTrace`'s `FACE_AX_*`),
 * exactly as the GPU byte does — every existing reader masks the bit it wants
 * out of it, so the extra two bits are invisible to them and the mirror stays a
 * mirror.
 *
 * @param {Array} scene   `CORNELL_SCENE`-shaped
 * @param {number[]} vmin voxel min corner, world
 * @param {number} v      cell size
 * @param {number[][]} [R] the fill's rotation, columns; `KIND_OBB` prims only
 * @returns {{occ: boolean, face: number, pal: number, axis: number}}
 */
export function analyticVoxel(scene, vmin, v, R = IDENTITY_ROT) {
  const vc = [vmin[0] + v * 0.5, vmin[1] + v * 0.5, vmin[2] + v * 0.5];
  const hv = v * 0.5;
  let occ = false;
  let face = 0;
  let pal = PAL_NONE;
  const w = [0, 0, 0];
  for (const p of scene) {
    if (p.kind === KIND_BOX || p.kind === KIND_OBB) {
      const hit = obbVoxel(p, p.kind === KIND_OBB ? R : IDENTITY_ROT, vc, hv);
      if (!hit) continue;
      face |= hit.mask;
      for (let a = 0; a < 3; a++) w[a] += hit.w[a];
      occ = true;
      pal = Math.min(pal, p.pal);
    } else {
      const c = [0, 1, 2].map((a) => (p.min[a] + p.max[a]) * 0.5);
      const rad = (p.max[0] - p.min[0]) * 0.5;
      let d2 = 0;
      for (let a = 0; a < 3; a++) {
        const q = Math.min(Math.max(c[a], vmin[a]), vmin[a] + v);
        d2 += (q - c[a]) * (q - c[a]);
      }
      if (Math.sqrt(d2) > rad) continue;
      occ = true;
      face |= ALL_FACES;
      pal = Math.min(pal, p.pal);
      // ⚠ A SPHERE NAMES NO DOMINANT AXIS. Its normal turns through the whole
      // hemisphere inside one voxel, so the honest answer is "not known" and
      // the reader falls back on the entry face — which is what Stage 3.8 did
      // for everything, and is still the right answer for a curved patch.
    }
  }
  let axis = -1;
  if (w[0] + w[1] + w[2] > 0) axis = w[0] >= w[1] && w[0] >= w[2] ? 0 : (w[1] >= w[2] ? 1 : 2);
  if (axis >= 0) face |= (axis + 1) << FACE_AX_SHIFT;
  return { occ, face, pal, axis };
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
export function createWindowFill(win, { scene = CORNELL_SCENE, rotation = IDENTITY_ROT } = {}) {
  const { levels, voxel0, atomics, originAt } = win;
  const primArr = packPrims(scene);
  const prims = instancedArray(primArr, "vec4");
  const faceBitsEnabled = uniform(1);
  let sceneNow = scene;
  let rotNow = rotation;
  // The rotation, as three column uniforms. A UNIFORM and not a rebuild for the
  // same reason `faceBitsEnabled` is one: the rotated arms and the axis-aligned
  // arm have to come out of ONE binary, or the difference between them is a
  // recompile as much as it is a room.
  const rotU = [
    uniform(new THREE.Vector3(...rotation[0])),
    uniform(new THREE.Vector3(...rotation[1])),
    uniform(new THREE.Vector3(...rotation[2])),
  ];

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
    // The area-weighted |n| per axis. The CPU mirror's `w`, accumulated over
    // every primitive that reaches this cell.
    const axW = vec3(0).toVar();
    const vcen = vmin.add(vmax).mul(0.5).toVar();
    const hv = vl.mul(0.5).toVar();

    Loop({ start: 0, end: MAX_PRIMS, name: "fillPrim" }, ({ fillPrim }) => {
      const base = uint(fillPrim).mul(uint(2)).toVar();
      const p0 = prims.element(base).toVar();
      const p1 = prims.element(base.add(uint(1))).toVar();
      const kind = p0.w.toVar();
      const pmin = p0.xyz.toVar();
      const pmax = p1.xyz.toVar();
      const palIdx = p1.w.toUint().toVar();

      If(kind.greaterThanEqual(0), () => {
        const isSphere = kind.greaterThan(0.5).and(kind.lessThan(1.5));
        // ── the box axes: the fill's rotation for a KIND_OBB, identity else ──
        //
        // ⚠ WRITTEN AS `a·(1−t) + b·t` AND NOT AS `a.mix(b, t)`. The `mix`
        // method's own argument order sent every column to ZERO here, and a
        // zero rotation is not a visible failure — it is a box whose extent
        // along every axis is 0, which separates from every voxel, which is a
        // window holding nothing but the sphere (measured: 136 occupied voxels
        // where the room has thousands, and the page's own emptiness guard is
        // the only reason it was a failure and not a silently dark room).
        const obbF = select(kind.greaterThan(1.5), float(1), float(0)).toVar();
        const notObb = float(1).sub(obbF).toVar();
        const cA = [
          vec3(1, 0, 0).mul(notObb).add(vec3(rotU[0]).mul(obbF)).toVar(),
          vec3(0, 1, 0).mul(notObb).add(vec3(rotU[1]).mul(obbF)).toVar(),
          vec3(0, 0, 1).mul(notObb).add(vec3(rotU[2]).mul(obbF)).toVar(),
        ];
        const aA = cA.map((c) => c.abs().toVar());

        const pc = pmin.add(pmax).mul(0.5).toVar();
        const he = pmax.sub(pmin).mul(0.5).toVar();
        const C = cA[0].mul(pc.x).add(cA[1].mul(pc.y)).add(cA[2].mul(pc.z)).toVar();
        const D = vcen.sub(C).toVar();
        const aD = D.abs().toVar();
        // Separation on the three WORLD axes.
        const reach = aA[0].mul(he.x).add(aA[1].mul(he.y)).add(aA[2].mul(he.z)).toVar();
        const sepW = aD.x.greaterThanEqual(hv.add(reach.x))
          .or(aD.y.greaterThanEqual(hv.add(reach.y)))
          .or(aD.z.greaterThanEqual(hv.add(reach.z)));
        // …and on the three BOX axes. `rk` doubles as the voxel's projected
        // radius on face `k`'s normal, which the cut test needs.
        const pk = [dot(D, cA[0]).toVar(), dot(D, cA[1]).toVar(), dot(D, cA[2]).toVar()];
        const rk = aA.map((a) => hv.mul(a.x.add(a.y).add(a.z)).toVar());
        const heK = [he.x, he.y, he.z];
        const sepB = pk[0].abs().greaterThanEqual(heK[0].add(rk[0]))
          .or(pk[1].abs().greaterThanEqual(heK[1].add(rk[1])))
          .or(pk[2].abs().greaterThanEqual(heK[2].add(rk[2])));
        const overlap = select(sepW.or(sepB), float(0), float(1)).greaterThan(0.5);

        // ── which of the box's six face PLANES cut this cell ───────────────
        const boxMask = uint(0).toVar();
        const boxW = vec3(0).toVar();
        for (let k = 0; k < 3; k++) {
          const cut = pk[k].sub(heK[k]).abs().lessThanEqual(rk[k])
            .or(pk[k].add(heK[k]).abs().lessThanEqual(rk[k]));
          const bits = bitOr(
            bitOr(select(aA[k].x.greaterThan(NORMAL_EPS), uint(AXIS_MASK[0]), uint(0)),
              select(aA[k].y.greaterThan(NORMAL_EPS), uint(AXIS_MASK[1]), uint(0))),
            select(aA[k].z.greaterThan(NORMAL_EPS), uint(AXIS_MASK[2]), uint(0)),
          ).toVar();
          boxMask.assign(bitOr(boxMask, select(cut, bits, uint(0))));
          // The face's own area, put on the axis its normal points most along.
          const area = heK[(k + 1) % 3].mul(heK[(k + 2) % 3]).mul(4).toVar();
          const ak = aA[k];
          const mx = ak.x.max(ak.y).max(ak.z).toVar();
          const add = select(cut, area.mul(mx), float(0)).toVar();
          const isX = ak.x.greaterThanEqual(ak.y).and(ak.x.greaterThanEqual(ak.z));
          const isY = ak.y.greaterThan(ak.x).and(ak.y.greaterThanEqual(ak.z));
          const isZ = ak.z.greaterThan(ak.x).and(ak.z.greaterThan(ak.y));
          boxW.addAssign(vec3(
            select(isX, add, float(0)),
            select(isY, add, float(0)),
            select(isZ, add, float(0)),
          ));
        }
        // Nothing cut → the cell is strictly inside the solid → all six, and
        // no surface to name a dominant normal for.
        boxMask.assign(select(boxMask.equal(uint(0)), uint(ALL_FACES), boxMask));

        // ── sphere: closest point in the cell within the radius ─────────────
        const c = pmin.add(pmax).mul(0.5).toVar();
        const r = pmax.x.sub(pmin.x).mul(0.5).toVar();
        const q = c.clamp(vmin, vmax).toVar();
        const sphereIn = q.sub(c).length().lessThanEqual(r);

        const inside = select(isSphere, sphereIn, overlap);
        If(inside, () => {
          occ.assign(1);
          faceMask.assign(bitOr(faceMask, select(isSphere, uint(ALL_FACES), boxMask)));
          // ⚠ A SPHERE NAMES NO DOMINANT AXIS — see the CPU mirror's note.
          axW.addAssign(boxW.mul(select(isSphere, float(0), float(1))));
          pal.assign(pal.min(palIdx));
        });
      });
    });

    // The voxel's dominant axis: bits 6-7, `0` = not known (`FACE_AX_NONE`).
    const axAny = axW.x.add(axW.y).add(axW.z).greaterThan(0).toVar();
    const axCode = select(axAny, select(
      axW.x.greaterThanEqual(axW.y).and(axW.x.greaterThanEqual(axW.z)), uint(1),
      select(axW.y.greaterThanEqual(axW.z), uint(2), uint(3)),
    ), uint(0)).toVar();

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
      const stored = select(faceBitsEnabled.greaterThan(0.5),
        bitOr(faceMask, shiftLeft(axCode, uint(FACE_AX_SHIFT))), uint(0)).toVar();
      atomicOr(atomics.element(levelBase.add(uint(FACE_OFF)).add(byteWord)), shiftLeft(stored, byteShift));
      // pal byte: clear then set. The scroll leaves 0xFF in every byte, so the
      // AND is what makes a re-fill without a scroll land the right value, and
      // the OR is what makes concurrent neighbours in the same word survive.
      atomicAnd(
        atomics.element(levelBase.add(uint(PAL_OFF)).add(byteWord)),
        bitNot(shiftLeft(uint(255), byteShift)),
      );
      atomicOr(atomics.element(levelBase.add(uint(PAL_OFF)).add(byteWord)), shiftLeft(pal, byteShift));
      // ⭐ §AG — EVERY ANALYTIC VOXEL IS CLASS 3, AND THAT IS THE POINT OF THIS
      // FILE. Its scene is SOLIDS — a 5 cm wall slab, a 2 m box, a 1 m sphere —
      // and a solid is exactly what the opaque class means. It keeps the §V.1
      // thin-wall gate (0 leaks of 10 000) measuring the ENTRY-FACE BIT and
      // nothing else: if the analytic wall could be partial, a leak in
      // `probe:gi2-trace` would no longer distinguish a broken face rule from a
      // coverage estimate that under-counted, and the control arm's "withhold
      // the bits and the identical rays pour through" would compare two things
      // at once.
      //
      // One `atomicOr` and no clear beside it: OR-ing 3 into a 2-bit lane lands
      // 3 whatever was there, so a re-fill without a scroll needs no AND (which
      // `pal`, whose merge is not idempotent, does).
      atomicOr(
        atomics.element(levelBase.add(uint(COV_OFF)).add(shiftRight(vi, uint(4)))),
        shiftLeft(uint(COV_OPAQUE), bitAnd(vi, uint(15)).mul(uint(2))),
      );

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
    /**
     * ⭐ THE ROTATED ARM IS A UNIFORM AND A BUFFER UPDATE, NOT A SECOND PAGE.
     * Both switch the WORLD; the kernel, the trace, the cache and the gather
     * are the same objects and the same compiled pipelines across every arm, so
     * an arm-to-arm difference cannot be a recompile, a different tier or a
     * warmed cache. The caller must clear and re-fill (`clearStaticPass` then
     * `pass`) after either — the face byte is written with `atomicOr` and would
     * otherwise carry the previous arm's axis bits.
     */
    setRotation(R) {
      rotNow = R;
      for (let k = 0; k < 3; k++) rotU[k].value.set(R[k][0], R[k][1], R[k][2]);
    },
    setScene(next) {
      sceneNow = next;
      primArr.set(packPrims(next));
      prims.value.needsUpdate = true;
    },
    get scene() { return sceneNow; },
    get rotation() { return rotNow; },
    brick: BRICK,
  };
}
