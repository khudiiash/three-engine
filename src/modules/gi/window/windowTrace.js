// GI2 — THE TWO-LEVEL BIT-DDA (plan §4.2, audits §K.4, Stage 2.4)
//
// `traceWindow(o, d, tMax, n)` — brick DDA on `brickMask` (16 bricks per axis,
// an empty brick is one step), voxel DDA on `occ` inside occupied bricks,
// ENTRY-FACE bit test on `face`, hand-off to the next coarser level when the
// ray leaves the current window, dynamic layer OR'd at L0/L1. ONE storage
// buffer, no workgroup memory, no scene numbers.
//
// ══ WHAT THE FACE BITS MEAN, AND WHY §K'S SENTENCE HAD TO BE REWRITTEN ═══════
//
// K.4 says: "on an occupied voxel test the ENTRY FACE bit … a 5 cm wall sets
// exactly the faces it crosses, so it blocks face-stepping paths and never the
// ones it does not cross". Read literally — bit f = "a triangle intersects the
// voxel's face-f square" — that rule LEAKS THROUGH THE VERY WALL IT CLAIMS TO
// BLOCK. A 5 cm wall perpendicular to X, lying inside one 0.25 m voxel,
// intersects the voxel's ±Y and ±Z faces (its cross-section spans them) and
// NEITHER X face. A ray travelling +X enters through the −X face, finds that
// bit clear, and walks straight through the wall. The bits would block exactly
// the rays that run PARALLEL to the wall and pass exactly the ones it stops.
//
// The rule that works, and the one implemented here:
//
//     bit(±a) is set  ⟺  the surface inside this voxel is NOT PARALLEL to
//                        axis a — i.e. its normal has a component along a
//                        (equivalently: its projection along a has area).
//
// A ray can only be stopped by a surface it actually crosses, and an
// axis-aligned DDA step along `a` crosses a surface only if that surface has an
// `a` component. So:
//   · the 5 cm wall ⊥ X sets ±X and blocks every X-stepping ray — including
//     every diagonal ray, because a ray that crosses the wall's PLANE must make
//     an X step to do it, and that step enters an occupied wall voxel through
//     an X face. That is the no-leak theorem, and it needs the voxelization to
//     be 6-separating along X only, which conservative triangle-voxel overlap
//     gives for free;
//   · a floor ⊥ Y does NOT block a ray running horizontally through the floor's
//     own voxel — correct, that ray passes above or below a 5 cm slab inside a
//     25 cm cell, and blocking it is exactly the "thickened geometry" this bit
//     exists to remove.
//
// Both bits of an axis pair are always set together: occlusion along a line is
// reciprocal, and a rule that sets only the near face leaks for rays arriving
// from the other side. The 6 bits are kept (rather than 3) because K.2's byte
// is already spent, because the trace reads one bit either way, and because a
// later one-sided/foliage rule needs the direction back.
//
// ══ THE THEOREM HAS A PRECONDITION: ONE AXIS PER STEP ════════════════════════
//
// The no-leak argument above says "the ray must make an X step to cross the
// wall's plane". A DDA that advances `t` to the next crossing PLUS AN EPSILON
// and re-derives the cell from the position breaks exactly that: whenever the
// ray passes within ε of a cell EDGE, one advance crosses two planes and the
// ray arrives in the diagonal neighbour having recorded only one axis. This was
// measured, not theorised — 2 rays in 10 000 entered the floor slab through an
// X face, which the floor rightly does not block, and walked out underneath it.
// ε was 1e-3 of a cell; the leak rate was 2e-4. **A per-step epsilon is a leak
// rate, not a rounding detail.**
//
// So the DDA below is Amanatides–Woo on INTEGER cell coordinates: crossing
// times are recomputed from the ray origin (no accumulation drift), exactly one
// axis advances per iteration, and there is no epsilon anywhere. The only
// position-derived quantity left is the cell a ray enters an occupied brick at,
// and it is CLAMPED into that brick — the entry point lies on the brick face
// where `floor` may legitimately land either side, and both answers clamp to
// the same cell.
//
// ══ RETURN SHAPE ════════════════════════════════════════════════════════════
//
// A laid-out WGSL function cannot return a struct (occupancyField's traceBody
// learned this), so the shared fn returns `vec4(hit, t, packed, steps)` and the
// JS wrapper unpacks. `packed = faceId | level << 3 | voxelIdx << 6` reaches
// 16777213 at its maximum — exactly one below 2^24, so every value round-trips
// through f32 EXACTLY. That is a checked property, not a lucky fit: faceId is
// 3 bits, level 3, and a 64³ voxel index 18.
import {
  Break, If, Loop, bitAnd, bitOr, exp2, float, int, select, shiftLeft, shiftRight, uint, vec3, vec4,
} from "three/tsl";
import { sharedFn } from "../giFn.js";
import { BMASK_OFF, BRICK, BRICKS, FACE_OFF, LEVEL_WORDS, N, OCC_OFF } from "./windowStore.js";

/** Face bit order: 0 = +X, 1 = −X, 2 = +Y, 3 = −Y, 4 = +Z, 5 = −Z. */
export const FACE_BIT = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 };

/**
 * The bit a ray stepping along `axis` in direction `sign` tests when it ENTERS
 * a voxel: moving +X you come in through the −X face. Exported because the CPU
 * mirror in the unit test must agree with the kernel bit-for-bit.
 */
export const entryFaceBit = (axis, positive) => axis * 2 + (positive ? 1 : 0);

/**
 * Builds the trace for one window.
 *
 * `steps` bounds the BRICK loop; the voxel loop inside an occupied brick is
 * bounded by the brick itself (a straight line crosses at most 3·4+1 cells of a
 * 4³ brick), so no ray can run away.
 *
 * @param {object} win  from `createGiWindow`
 * @param {object} [opts]
 * @param {number}  [opts.steps]    per-ray BRICK step budget (default: the tier's)
 * @param {boolean} [opts.dynamic]  OR the K.5 dynamic layer at L0/L1
 * @returns {{ traceWindow: Function, steps: number, dynamic: boolean }}
 */
export function createWindowTrace(win, { steps = win.spec.traceSteps, dynamic = win.dynLevels > 0 } = {}) {
  const { levels, dynLevels, voxel0, buffer, originsU, originAt } = win;
  const useDynamic = dynamic && dynLevels > 0;
  const VOXEL_STEPS = BRICK * 3 + 1;

  const traceFn = sharedFn({
    name: "gi2TraceWindow",
    type: "vec4",
    inputs: [
      { name: "ro", type: "vec3" },
      { name: "rd", type: "vec3" },
      { name: "rn", type: "vec3" },
      { name: "tMax", type: "float" },
    ],
    body: (ro, rd, rn, tMax) => {
      // K.4's bias: screen-probe origins sit ON surfaces, so push half a
      // LEVEL-0 cell along the geometric normal. Derived from v0, never from
      // probe spacing — the quantity that put the origin inside its own
      // surface's voxel is the voxel (SRC's R2 rule, and it survives here).
      const o = vec3(ro).add(vec3(rn).mul(float(voxel0 * 0.5))).toVar();
      const d = vec3(rd).toVar();
      // Signed floor on the reciprocal: an axis-parallel ray must produce a
      // huge, positive-or-negative crossing distance on its degenerate axis
      // rather than an inf/NaN that poisons the per-axis min.
      const safe = (c) => select(c.abs().lessThan(1e-9), select(c.lessThan(0), float(-1e-9), float(1e-9)), c);
      const inv = vec3(
        float(1).div(safe(d.x)), float(1).div(safe(d.y)), float(1).div(safe(d.z)),
      ).toVar();
      // Which side of a cell the ray leaves through, as 0/1 per axis.
      const stepPos = vec3(
        select(d.x.greaterThanEqual(0), float(1), float(0)),
        select(d.y.greaterThanEqual(0), float(1), float(0)),
        select(d.z.greaterThanEqual(0), float(1), float(0)),
      ).toVar();
      // Entry-face bit per axis, hoisted: crossing +a enters through the −a
      // face, which is bit 2a+1.
      const entryBits = vec3(
        stepPos.x, float(2).add(stepPos.y), float(4).add(stepPos.z),
      ).toVar();
      // ±1 per axis, and the delta vector for a step along a chosen axis. A
      // vec3 cannot be indexed by a runtime axis in WGSL, so the step is built
      // by selects — three compares, no scratch memory, no branch.
      const sgn = stepPos.mul(2).sub(1).toVar();
      const stepOf = (axis) => vec3(
        select(axis.equal(0), sgn.x, float(0)),
        select(axis.equal(1), sgn.y, float(0)),
        select(axis.equal(2), sgn.z, float(0)),
      );

      // ── the finest level whose window holds the origin ────────────────────
      // Unrolled over a TIER CONSTANT, descending so the finest wins.
      const level = int(levels - 1).toVar();
      for (let l = levels - 1; l >= 0; l--) {
        const rel = o.div(float(voxel0 * Math.pow(2, l))).floor().sub(vec3(originsU[l]));
        const inside = rel.x.greaterThanEqual(0).and(rel.y.greaterThanEqual(0)).and(rel.z.greaterThanEqual(0))
          .and(rel.x.lessThan(N)).and(rel.y.lessThan(N)).and(rel.z.lessThan(N));
        level.assign(select(inside, int(l), level));
      }

      const t = float(0).toVar();
      const hit = float(0).toVar();
      const hitT = float(-1).toVar();
      const packed = float(0).toVar();
      const used = float(0).toVar();
      // The axis last crossed decides the entry face. The ray's first cell has
      // no crossing yet, so it is seeded with the ray's DOMINANT axis — the
      // face it would most likely have come through, and the one that fails
      // closed most often for a ray born inside geometry.
      const ad = d.abs().toVar();
      const lastAxis = select(
        ad.x.greaterThanEqual(ad.y).and(ad.x.greaterThanEqual(ad.z)), float(0),
        select(ad.y.greaterThanEqual(ad.z), float(1), float(2)),
      ).toVar();

      // The brick the ray starts in, at the level it starts on.
      const bcell = o.div(float(voxel0 * BRICK).mul(exp2(level.toFloat()))).floor().toVar();

      Loop({ start: 0, end: steps, name: "gi2Brick" }, () => {
        used.addAssign(1);
        If(t.greaterThanEqual(tMax), () => { Break(); });

        const vl = float(voxel0).mul(exp2(level.toFloat())).toVar();
        const bl = vl.mul(BRICK).toVar();
        // Window test at BRICK granularity: the origin is brick-aligned, so a
        // brick is wholly in or wholly out — one compare instead of eight.
        const rel = bcell.mul(BRICK).sub(originAt(level)).toVar();
        const outside = rel.x.lessThan(0).or(rel.y.lessThan(0)).or(rel.z.lessThan(0))
          .or(rel.x.greaterThanEqual(N)).or(rel.y.greaterThanEqual(N)).or(rel.z.greaterThanEqual(N));

        If(outside, () => {
          // LEVEL HAND-OFF. `t` is carried; the coarser window is centred on
          // the same camera so it almost always contains this point. Never
          // downward: once handed off the ray stays coarse (Brixelizer's rule),
          // which is what bounds the hand-off count at `levels`.
          level.assign(level.add(int(1)));
          If(level.greaterThanEqual(int(levels)), () => { Break(); });
          bcell.assign(o.add(d.mul(t)).div(float(voxel0 * BRICK).mul(exp2(level.toFloat()))).floor());
        }).Else(() => {
          // ── when this brick ends ─────────────────────────────────────────
          // Absolute crossing times, recomputed from the RAY ORIGIN rather
          // than accumulated. Both forms are exact in theory; this one cannot
          // drift over a long ray, and it costs three multiply-adds.
          const tb = vec3(
            bcell.x.add(stepPos.x).mul(bl).sub(o.x).mul(inv.x),
            bcell.y.add(stepPos.y).mul(bl).sub(o.y).mul(inv.y),
            bcell.z.add(stepPos.z).mul(bl).sub(o.z).mul(inv.z),
          ).toVar();
          const tB = tb.x.min(tb.y).min(tb.z).toVar();
          const axisB = select(tB.equal(tb.x), float(0), select(tB.equal(tb.y), float(1), float(2))).toVar();

          const bx = bitAnd(bcell.x.toInt(), int(BRICKS - 1)).toUint().toVar();
          const by = bitAnd(bcell.y.toInt(), int(BRICKS - 1)).toUint().toVar();
          const bz = bitAnd(bcell.z.toInt(), int(BRICKS - 1)).toUint().toVar();
          const b = bitOr(bitOr(bx, shiftLeft(by, uint(4))), shiftLeft(bz, uint(8))).toVar();

          const slotBase = level.toUint().mul(uint(LEVEL_WORDS)).toVar();
          // The dynamic mirror of this level. The INDEX is clamped in range and
          // the VALUE is gated by a select — never an `If()` around a buffer
          // read, which is the idiom that rendered the BVH mirror pass black.
          const dynBase = useDynamic
            ? uint(levels).add(level.min(int(dynLevels - 1)).toUint()).mul(uint(LEVEL_WORDS)).toVar()
            : null;
          const useDyn = useDynamic ? level.lessThan(int(dynLevels)) : null;

          const bmWord = shiftRight(b, uint(5)).toVar();
          const bmBit = shiftLeft(uint(1), bitAnd(b, uint(31))).toVar();
          const bmStatic = bitAnd(buffer.element(slotBase.add(uint(BMASK_OFF)).add(bmWord)), bmBit).toVar();
          const bmDyn = useDynamic
            ? select(useDyn, bitAnd(buffer.element(dynBase.add(uint(BMASK_OFF)).add(bmWord)), bmBit), uint(0)).toVar()
            : uint(0);

          // ── inside an occupied brick: the voxel DDA ──────────────────────
          If(bitOr(bmStatic, bmDyn).notEqual(uint(0)), () => {
            const lo = bcell.mul(BRICK).toVar();
            const vcell = o.add(d.mul(t)).div(vl).floor().clamp(lo, lo.add(BRICK - 1)).toVar();
            const tv0 = t.toVar(); // when the ray entered `vcell`
            const iAxis = lastAxis.toVar();

            Loop({ start: 0, end: VOXEL_STEPS, name: "gi2Voxel" }, () => {
              used.addAssign(1);
              const cx = bitAnd(vcell.x.toInt(), int(N - 1)).toUint().toVar();
              const cy = bitAnd(vcell.y.toInt(), int(N - 1)).toUint().toVar();
              const cz = bitAnd(vcell.z.toInt(), int(N - 1)).toUint().toVar();
              const vi = bitOr(bitOr(cx, shiftLeft(cy, uint(6))), shiftLeft(cz, uint(12))).toVar();
              const occBit = shiftLeft(uint(1), bitAnd(vi, uint(31))).toVar();
              const occWord = shiftRight(vi, uint(5)).toVar();
              const occStatic = bitAnd(buffer.element(slotBase.add(uint(OCC_OFF)).add(occWord)), occBit).toVar();
              const occDyn = useDynamic
                ? select(useDyn, bitAnd(buffer.element(dynBase.add(uint(OCC_OFF)).add(occWord)), occBit), uint(0)).toVar()
                : uint(0);

              If(bitOr(occStatic, occDyn).notEqual(uint(0)), () => {
                const byteWord = shiftRight(vi, uint(2)).toVar();
                const byteShift = bitAnd(vi, uint(3)).mul(uint(8)).toVar();
                const fStatic = bitAnd(
                  shiftRight(buffer.element(slotBase.add(uint(FACE_OFF)).add(byteWord)), byteShift), uint(255),
                ).toVar();
                const fDyn = useDynamic
                  ? select(useDyn, bitAnd(
                      shiftRight(buffer.element(dynBase.add(uint(FACE_OFF)).add(byteWord)), byteShift), uint(255),
                    ), uint(0)).toVar()
                  : uint(0);
                const eFace = select(iAxis.equal(0), entryBits.x,
                  select(iAxis.equal(1), entryBits.y, entryBits.z)).toVar();
                If(bitAnd(bitOr(fStatic, fDyn), shiftLeft(uint(1), eFace.toUint())).notEqual(uint(0)), () => {
                  hit.assign(1);
                  hitT.assign(tv0);
                  packed.assign(eFace.add(level.toFloat().mul(8)).add(vi.toFloat().mul(64)));
                  Break();
                });
              });

              const tv = vec3(
                vcell.x.add(stepPos.x).mul(vl).sub(o.x).mul(inv.x),
                vcell.y.add(stepPos.y).mul(vl).sub(o.y).mul(inv.y),
                vcell.z.add(stepPos.z).mul(vl).sub(o.z).mul(inv.z),
              ).toVar();
              const tV = tv.x.min(tv.y).min(tv.z).toVar();
              If(tV.greaterThanEqual(tB), () => { Break(); }); // out of this brick
              const axisV = select(tV.equal(tv.x), float(0), select(tV.equal(tv.y), float(1), float(2))).toVar();
              vcell.addAssign(stepOf(axisV));
              iAxis.assign(axisV);
              tv0.assign(tV);
            });
          });

          If(hit.greaterThan(0.5), () => { Break(); });
          // Step to the next brick. `max` guards the one case where a level
          // hand-off re-derives a brick the ray has already passed: the brick
          // coordinate still advances, so the loop cannot stall.
          bcell.addAssign(stepOf(axisB));
          lastAxis.assign(axisB);
          t.assign(t.max(tB));
        });
      });

      return vec4(hit, hitT, packed, used);
    },
  });

  /**
   * @param {Node} origin  world-space ray origin (ON the surface — the bias is
   *   applied here, not by the caller)
   * @param {Node} dir     UNIT direction; `t` is then metres
   * @param {Node|number} tMax
   * @param {Node} [normal]  geometric normal for the origin bias; omit for none
   */
  const traceWindow = (origin, dir, tMax, normal = null) => {
    const r = traceFn(
      vec3(origin), vec3(dir), normal == null ? vec3(0, 0, 0) : vec3(normal), float(tMax),
    ).toVar();
    const zi = r.z.toUint().toVar();
    return {
      hit: r.x,
      t: r.y,
      faceId: bitAnd(zi, uint(7)),
      level: bitAnd(shiftRight(zi, uint(3)), uint(7)),
      voxelIdx: shiftRight(zi, uint(6)),
      steps: r.w,
      raw: r,
    };
  };

  return { traceWindow, steps, dynamic: useDynamic };
}

/** Unpack the vec4 a readback holds, on the CPU. Mirrors the wrapper exactly. */
export function unpackTrace(x, y, z, w) {
  const zi = z >>> 0;
  return {
    hit: x > 0.5,
    t: y,
    faceId: zi & 7,
    level: (zi >>> 3) & 7,
    voxelIdx: zi >>> 6,
    steps: w,
  };
}
